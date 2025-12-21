import { Entity, Vec4, ASPECT_MANUAL, Texture, Layer } from 'playcanvas';
import { Events } from './events';
import { Scene } from './scene';
import { Splat } from './splat';
import { ElementType } from './element';
import { State } from './splat-state';

type CameraComp = any;

// CompareView with RIGHT-ONLY diff overlay.
// - Left: always a frozen snapshot.
// - Right: live.
// - Diff: only overlays on the RIGHT side.
//   * Removed-from-right (visible in left, deleted in right): RED overlay.
//   * Added-to-right   (deleted in left, visible in right): GREEN overlay.
//
// This version fixes the "everything becomes red" issue by:
// 1) Comparing VISIBILITY sets (deleted flag) rather than painting both sides.
// 2) Zero-initializing the entire diff state texture buffer (handles padded textures).
// 3) Restricting rendering via sorter.setMapping() to only diff indices.

export class CompareView {
    private events: Events;
    private scene: Scene;

    private enabled = false;
    private split = 0.5;

    private mainCamEntity: Entity;
    private leftCamEntity: Entity | null = null;

    private clonedSplatEntity: Entity | null = null;
    private clonedStateTexture: Texture | null = null;
    private clonedTransformTexture: Texture | null = null;

    private leftLayerId: number | null = null;

    // CPU snapshot of left state (baseline for diff)
    private leftStateSnapshot: Uint8Array | null = null;

    // Diff overlay
    private diffEnabled = false;
    private rightDiffLayerId: number | null = null;

    private rightRemovedEntity: Entity | null = null;
    private rightAddedEntity: Entity | null = null;
    private rightRemovedStateTex: Texture | null = null;
    private rightAddedStateTex: Texture | null = null;
    // Keep last mappings to avoid destroy/recreate cycles that can destabilize the gsplat sorter worker
    private rightRemovedMapping: Uint32Array | null = null;
    private rightAddedMapping: Uint32Array | null = null;
    private otherCamLayersBackup = new Map<Entity, number[]>();
    private otherCamMaskBackup = new Map<Entity, number>();
    private readonly MASK_MAIN = 1;
    private readonly MASK_LEFT = 2;

    // Safety switch: in some gsplat builds, sorter.setMapping can terminate the worker for certain
    // mappings, and the next frame will crash in GSplatSorter.setCamera (worker.postMessage).
    // Turn this ON to guarantee stability; you will pay extra sorting cost for the overlay.
    private disableDiffSorterMapping = true;

    // Point count for the current diff session (used for mapping validation).
    private diffPointCount = 0;

    /**
     * Best-effort debug helper: identify whether a GSplat sorter still has a live worker.
     * This is intentionally conservative (only presence/absence) to avoid console spam.
     */
    private logSorter(tag: string, ent: Entity | null) {
        if (!ent) {
            console.log(`[CompareView] sorter/${tag}: <null entity>`);
            return;
        }
        const inst = (ent as any)?.gsplat?.instance;
        const sorter = inst?.sorter;
        const w = (sorter as any)?.worker ?? (sorter as any)?._worker ?? (sorter as any)?.sortWorker ?? null;
        const compEnabled = (ent as any)?.gsplat?.enabled;
        console.log(
            `[CompareView] sorter/${tag}: entityEnabled=${ent.enabled} gsplatEnabled=${compEnabled} hasSorter=${!!sorter} hasWorker=${!!w}`
        );
    }

    private getAllCameraComps(): any[] {
        const app = this.getApp();
        return app?.root?.findComponents ? (app.root.findComponents('camera') as any[]) : [];
    }

    private mainCamBackup: null | {
        rect: Vec4;
        scissorRect: Vec4;
        clearColorBuffer: boolean;
        aspectRatioMode: any;
        aspectRatio: number;
        layers: number[];
    } = null;

    constructor(events: Events, scene: Scene, mainCamEntity: Entity) {
        this.events = events;
        this.scene = scene;
        this.mainCamEntity = mainCamEntity;

        this.events.function('compareView.enabled', () => this.enabled);
        this.events.function('compareView.split', () => this.split);
        this.events.function('compareView.diffEnabled', () => this.diffEnabled);

        this.events.on('compareView.setEnabled', (v: boolean) => this.setEnabled(v));
        this.events.on('compareView.toggleEnabled', () => this.setEnabled(!this.enabled));

        this.events.on('compareView.setSplit', (v: number) => {
            this.split = Math.max(0.1, Math.min(0.9, v));
            this.applyLayout();
            this.events.fire('compareView.splitChanged', this.split);
        });

        // Refresh snapshot baseline to current right state
        this.events.on('compareView.refreshSnapshot', () => this.refreshSnapshot());

        // Diff overlay controls
        this.events.on('compareView.setDiffEnabled', (v: boolean) => this.setDiffEnabled(v));
        this.events.on('compareView.toggleDiff', () => this.setDiffEnabled(!this.diffEnabled));
        this.events.on('compareView.refreshDiff', () => {
            if (!this.enabled || !this.diffEnabled) return;
            this.rebuildDiffOverlay();
        });

        // Auto-refresh diff overlay on any edit (filter apply / undo / redo)
        this.events.on('edit.apply', () => {
            if (!this.enabled || !this.diffEnabled) return;
            this.rebuildDiffOverlay();
        });

        this.events.on('prerender', () => {
            if (!this.enabled) return;
            this.ensureLeftCamera();
            this.syncLeftCameraTransform();
            this.applyLayout();
        });
    }

    private getApp(): any {
        return (this.scene as any).app;
    }

    private getMainCamComp(): CameraComp | null {
        return (this.mainCamEntity as any)?.camera ?? null;
    }

    private getFirstSplat(): Splat | null {
        const arr = this.scene.getElementsByType(ElementType.splat) as any[];
        return (arr && arr.length > 0 ? (arr[0] as Splat) : null);
    }

    private applyParamsToMaterial(material: any, source: any) {
        const offset = -source.blackPoint + source.brightness;
        const scale = 1 / (source.whitePoint - source.blackPoint);

        material.setParameter('clrOffset', [offset, offset, offset]);
        material.setParameter('clrScale', [
            scale * source.tintClr.r * (1 + source.temperature),
            scale * source.tintClr.g,
            scale * source.tintClr.b * (1 - source.temperature),
            source.transparency
        ]);
        material.setParameter('saturation', source.saturation);
    }
    private isolateOtherCameraMasks() {
        const app = this.scene.app as any;
        if (!app?.root?.findComponents) return;

        const cams = app.root.findComponents('camera') as any[];

        // Keep everything except the two compare bits (1 and 2)
        const exclude = (0xFFFFFFFF ^ (this.MASK_MAIN | this.MASK_LEFT)) >>> 0;

        for (const cam of cams) {
            const ent = cam.entity as Entity;

            // Do not touch the two cameras that are responsible for rendering splats
            if (ent === this.mainCamEntity) continue;
            if (this.leftCamEntity && ent === this.leftCamEntity) continue;

            const oldMask = ((cam as any).mask ?? 0xFFFFFFFF) >>> 0;
            if (!this.otherCamMaskBackup.has(ent)) this.otherCamMaskBackup.set(ent, oldMask);

            // Remove compare bits so this camera won't draw either splat
            (cam as any).mask = (oldMask & exclude) >>> 0;
        }
    }

    private restoreOtherCameraMasks() {
        const app = this.scene.app as any;
        if (!app?.root?.findComponents) return;

        const cams = app.root.findComponents('camera') as any[];
        for (const cam of cams) {
            const ent = cam.entity as Entity;
            const old = this.otherCamMaskBackup.get(ent);
            if (old !== undefined) (cam as any).mask = old;
        }
        this.otherCamMaskBackup.clear();
    }

    private isolateCompareLayersAcrossAllCameras() {
        // Need left layer id to be valid
        if (this.leftLayerId === null) return;

        const cams = this.getAllCameraComps();
        for (const cam of cams) {
            const ent = cam.entity as Entity;

            // Backup once for non-main cams (main cam already has its own backup in your code)
            if (ent !== this.mainCamEntity && !this.otherCamLayersBackup.has(ent)) {
                this.otherCamLayersBackup.set(ent, cam.layers ? [...cam.layers] : []);
            }

            // MAIN camera: must NOT see CompareLeft; may see RightDiff if enabled
            if (ent === this.mainCamEntity) {
                let layers = cam.layers ? [...cam.layers] : [];
                layers = layers.filter((id: number) => id !== this.leftLayerId);

                if (this.diffEnabled && this.rightDiffLayerId !== null && !layers.includes(this.rightDiffLayerId)) {
                    layers.push(this.rightDiffLayerId);
                }
                if (!this.diffEnabled && this.rightDiffLayerId !== null) {
                    layers = layers.filter((id: number) => id !== this.rightDiffLayerId);
                }

                cam.layers = layers;
                continue;
            }

            // LEFT camera: should ONLY see CompareLeft
            if (this.leftCamEntity && ent === this.leftCamEntity) {
                cam.layers = [this.leftLayerId];
                continue;
            }

            // Other cameras (grid/background/etc): must not render compare layers
            let layers = cam.layers ? [...cam.layers] : [];
            layers = layers.filter((id: number) => id !== this.leftLayerId);
            if (this.rightDiffLayerId !== null) layers = layers.filter((id: number) => id !== this.rightDiffLayerId);
            cam.layers = layers;
        }
    }

    private restoreOtherCameraLayers() {
        const cams = this.getAllCameraComps();
        for (const cam of cams) {
            const ent = cam.entity as Entity;
            const backup = this.otherCamLayersBackup.get(ent);
            if (backup) cam.layers = [...backup];
        }
        this.otherCamLayersBackup.clear();
    }

    private snapshotTexture(original: Texture, nameSuffix: string): Texture {
        const src = original.lock();
        const copy = (src as any).slice ? (src as any).slice() : new (src.constructor as any)(src);
        original.unlock();

        const tex = new Texture(original.device, {
            name: `${(original as any).name ?? 'tex'}_${nameSuffix}`,
            width: original.width,
            height: original.height,
            format: (original as any).format,
            mipmaps: (original as any).mipmaps,
            minFilter: (original as any).minFilter,
            magFilter: (original as any).magFilter,
            addressU: (original as any).addressU,
            addressV: (original as any).addressV
        });

        const dst = tex.lock();
        dst.set(copy);
        tex.unlock();

        return tex;
    }

    private ensureLeftLayer() {
        if (this.leftLayerId !== null) return;

        const app = this.getApp();
        if (!app?.scene?.layers) return;

        const layers = app.scene.layers;
        let leftLayer = layers.getLayerByName?.('CompareLeft') as Layer | null;
        if (!leftLayer) {
            leftLayer = new Layer({ name: 'CompareLeft' });
            if (layers.insertOpaque && layers.insertTransparent) {
                layers.insertOpaque(leftLayer, 0);
                layers.insertTransparent(leftLayer, 0);
            } else {
                layers.insert(leftLayer, 0);
            }
        }
        this.leftLayerId = leftLayer.id;
    }

    private setEntityLayerRecursive(entity: Entity, layerId: number) {
        const app = this.getApp();
        const layers = app?.scene?.layers;
        if (!layers) return;

        const target = layers.getLayerById ? layers.getLayerById(layerId) : null;
        const layerList: any[] = layers.layerList ?? [];

        const move = (mi: any) => {
            if (!mi || !target) return;

            // remove from every existing layer list
            for (const L of layerList) {
                L?.removeMeshInstances?.([mi]);
            }
            // add to target layer
            target.addMeshInstances?.([mi]);
            mi.layer = layerId;
        };

        const visit = (node: any) => {
            if (!node) return;

            // gsplat meshInstance(s)
            const inst = node?.gsplat?.instance;
            if (inst) {
                if (inst.meshInstance) move(inst.meshInstance);
                if (Array.isArray(inst.meshInstances)) {
                    for (const mi of inst.meshInstances) move(mi);
                }
            }

            // normal render meshInstances
            const mis = node?.render?.meshInstances;
            if (mis?.length) {
                for (const mi of mis) move(mi);
            }

            // recurse children
            const children = node.children ?? [];
            for (const c of children) visit(c);
        };

        visit(entity);
    }


    private refreshSnapshot() {
        if (!this.enabled) return;
        const splat = this.getFirstSplat();
        if (!splat) return;
        if (!this.clonedSplatEntity || !this.clonedStateTexture) return;

        const sd: any = splat.splatData;
        const currentState = (sd.getProp ? sd.getProp('state') : sd.state) as Uint8Array;
        if (!currentState) return;

        // Deep copy baseline
        const snap = new Uint8Array(currentState);
        this.leftStateSnapshot = snap;

        // Upload into left frozen state texture (must cover full buffer)
        const dst = this.clonedStateTexture.lock();
        dst.fill(0);
        dst.set(snap);
        this.clonedStateTexture.unlock();

        // Freeze current visual params into the left material
        const clonedInstance = (this.clonedSplatEntity as any)?.gsplat?.instance;
        const mat = clonedInstance?.material ?? clonedInstance?.meshInstance?.material ?? null;
        if (mat) {
            this.applyParamsToMaterial(mat, splat);
            if (mat.update) mat.update();
        }

        this.events.fire('compareView.snapshotRefreshed');

        if (this.diffEnabled) this.rebuildDiffOverlay();
    }

    private setEnabled(v: boolean) {
        const next = !!v;
        if (next === this.enabled) return;
        if (!next) this.restoreOtherCameraMasks();

        const splat = this.getFirstSplat();
        if (!splat) {
            this.enabled = false;
            this.events.fire('compareView.enabledChanged', this.enabled);
            return;
        }

        // Enable
        if (next) {
            this.enabled = true;

            const mainCam = this.getMainCamComp();
            if (!mainCam) {
                this.enabled = false;
                this.events.fire('compareView.enabledChanged', this.enabled);
                return;
            }

            this.mainCamBackup = {
                rect: mainCam.rect ? mainCam.rect.clone() : new Vec4(0, 0, 1, 1),
                scissorRect: mainCam.scissorRect ? mainCam.scissorRect.clone() : new Vec4(0, 0, 1, 1),
                clearColorBuffer: !!mainCam.clearColorBuffer,
                aspectRatioMode: mainCam.aspectRatioMode,
                aspectRatio: mainCam.aspectRatio,
                layers: (mainCam.layers ? [...mainCam.layers] : [])
            };

            this.ensureLeftLayer();
            if (this.leftLayerId === null) {
                this.enabled = false;
                this.events.fire('compareView.enabledChanged', this.enabled);
                return;
            }

            // Snapshot state + transform textures for left view
            this.clonedStateTexture = this.snapshotTexture(splat.stateTexture, 'compare_left_state');
            this.clonedTransformTexture = this.snapshotTexture(splat.transformTexture, 'compare_left_xform');

            // Snapshot CPU state as baseline for diff
            const sd: any = splat.splatData;
            const currentState = (sd.getProp ? sd.getProp('state') : sd.state) as Uint8Array;
            this.leftStateSnapshot = currentState ? new Uint8Array(currentState) : null;

            // Clone entity for left view
            const app = this.getApp();
            this.clonedSplatEntity = splat.entity.clone();
            app.root.addChild(this.clonedSplatEntity);
            this.setEntityLayerRecursive(this.clonedSplatEntity, this.leftLayerId);

            // Clone material and bind frozen textures
            const clonedInstance = (this.clonedSplatEntity as any)?.gsplat?.instance;
            const srcInstance = (splat.entity as any)?.gsplat?.instance;
            if (clonedInstance && srcInstance?.material) {
                const clonedMat = srcInstance.material.clone();
                clonedMat.setParameter('splatState', this.clonedStateTexture);
                clonedMat.setParameter('splatTransform', this.clonedTransformTexture);
                this.applyParamsToMaterial(clonedMat, splat);
                if (clonedMat.update) clonedMat.update();
                clonedInstance.material = clonedMat;
                if (clonedInstance.meshInstance) clonedInstance.meshInstance.material = clonedMat;
            }

            this.ensureLeftCamera();
            this.isolateOtherCameraMasks();

            // Remove CompareLeft layer from main camera
            const origLayers = this.mainCamBackup.layers;
            mainCam.layers = origLayers.filter((id: number) => id !== this.leftLayerId);

            this.applyLayout();
            this.isolateCompareLayersAcrossAllCameras();
            this.events.fire('compareView.enabledChanged', this.enabled);
            return;
        }

        // Disable
        if (this.diffEnabled) this.setDiffEnabled(false);

        this.restoreOtherCameraLayers();
        this.enabled = false;

        // Restore main camera
        const mainCam = this.getMainCamComp();
        if (mainCam && this.mainCamBackup) {
            mainCam.rect = this.mainCamBackup.rect.clone();
            mainCam.scissorRect = this.mainCamBackup.scissorRect.clone();
            mainCam.clearColorBuffer = this.mainCamBackup.clearColorBuffer;
            mainCam.aspectRatioMode = this.mainCamBackup.aspectRatioMode;
            mainCam.aspectRatio = this.mainCamBackup.aspectRatio;
            mainCam.layers = [...this.mainCamBackup.layers];
        }
        this.mainCamBackup = null;

        if (this.leftCamEntity) {
            this.leftCamEntity.destroy();
            this.leftCamEntity = null;
        }

        const app = this.getApp();
        const layers = app?.scene?.layers;
        const leftLayer = layers?.getLayerByName?.('CompareLeft');
        if (leftLayer) {
            layers.removeOpaque?.(leftLayer);
            layers.removeTransparent?.(leftLayer);
            layers.remove?.(leftLayer);
        }
        this.leftLayerId = null;

        if (this.clonedSplatEntity) {
            this.clonedSplatEntity.destroy();
            this.clonedSplatEntity = null;
        }
        if (this.clonedStateTexture) {
            this.clonedStateTexture.destroy();
            this.clonedStateTexture = null;
        }
        if (this.clonedTransformTexture) {
            this.clonedTransformTexture.destroy();
            this.clonedTransformTexture = null;
        }

        this.leftStateSnapshot = null;
        this.events.fire('compareView.enabledChanged', this.enabled);

    }

    private ensureLeftCamera() {
        if (this.leftCamEntity) return;
        this.ensureLeftLayer();
        if (this.leftLayerId === null) return;

        const mainCamComp = this.getMainCamComp();
        if (!mainCamComp) return;

        const e = new Entity('compare-left-camera');
        e.addComponent('camera', {
            fov: mainCamComp.fov,
            nearClip: mainCamComp.nearClip,
            farClip: mainCamComp.farClip,
            clearColor: mainCamComp.clearColor,
            priority: mainCamComp.priority,
            layers: [this.leftLayerId]
        });

        const parent = this.mainCamEntity.parent;
        if (parent) parent.addChild(e);
        this.leftCamEntity = e;
    }

    private syncLeftCameraTransform() {
        if (!this.leftCamEntity) return;
        this.leftCamEntity.setPosition(this.mainCamEntity.getPosition());
        this.leftCamEntity.setRotation(this.mainCamEntity.getRotation());
    }

    private applyLayout() {
        const mainCam = this.getMainCamComp();
        const leftCam = this.leftCamEntity ? (this.leftCamEntity as any).camera : null;
        if (!mainCam || !leftCam) return;
        if (!this.enabled) return;

        leftCam.enabled = true;

        const leftRect = new Vec4(0, 0, this.split, 1);
        const rightRect = new Vec4(this.split, 0, 1 - this.split, 1);

        leftCam.rect = leftRect;
        leftCam.scissorRect = leftRect;
        leftCam.clearColorBuffer = true;

        mainCam.rect = rightRect;
        mainCam.scissorRect = rightRect;
        mainCam.clearColorBuffer = true;

        const gd = (this.scene as any).graphicsDevice;
        if (gd) {
            mainCam.aspectRatioMode = ASPECT_MANUAL;
            mainCam.aspectRatio = (gd.width * (1 - this.split)) / gd.height;
            leftCam.aspectRatioMode = ASPECT_MANUAL;
            leftCam.aspectRatio = (gd.width * this.split) / gd.height;
        }
    }

    // -----------------------
    // Diff overlay (RIGHT only)
    // -----------------------

    private ensureRightDiffLayer() {
        if (this.rightDiffLayerId !== null) return;

        const app = this.getApp();
        if (!app?.scene?.layers) return;
        const layers = app.scene.layers;

        let L = layers.getLayerByName?.('CompareRightDiff') as Layer | null;
        if (!L) {
            L = new Layer({ name: 'CompareRightDiff' });
            const idx = (layers.layerList?.length ?? 0);
            if (layers.insertOpaque && layers.insertTransparent) {
                layers.insertOpaque(L, idx);
                layers.insertTransparent(L, idx);
            } else {
                layers.insert(L, idx);
            }
        }
        this.rightDiffLayerId = L.id;
    }

    private attachRightDiffLayerToMainCamera() {
        this.ensureRightDiffLayer();
        if (this.rightDiffLayerId === null) return;

        if (this.disableDiffSorterMapping) {
            console.log('[CompareView] Diff: sorter mapping is DISABLED (stability mode).');
        }

        const mainCam = this.getMainCamComp();
        if (!mainCam) return;
        const layers = mainCam.layers ? [...mainCam.layers] : [];
        if (!layers.includes(this.rightDiffLayerId)) layers.push(this.rightDiffLayerId);
        mainCam.layers = layers;

        // Left camera must stay clean
        if (this.leftCamEntity && this.leftLayerId !== null) {
            (this.leftCamEntity as any).camera.layers = [this.leftLayerId];
        }
        this.isolateCompareLayersAcrossAllCameras();

    }

    private detachRightDiffLayerFromMainCamera() {
        const mainCam = this.getMainCamComp();
        if (mainCam && this.rightDiffLayerId !== null) {
            const layers = mainCam.layers ? [...mainCam.layers] : [];
            mainCam.layers = layers.filter((id: number) => id !== this.rightDiffLayerId);
        }
        if (this.leftCamEntity && this.leftLayerId !== null) {
            (this.leftCamEntity as any).camera.layers = [this.leftLayerId];
        }
        this.isolateCompareLayersAcrossAllCameras();

    }

    private setDiffEnabled(v: boolean) {
        const next = !!v;

        if (!this.enabled) {
            if (this.diffEnabled) {
                this.hideDiffOverlay();
                this.detachRightDiffLayerFromMainCamera();
            }
            this.diffEnabled = false;
            this.events.fire('compareView.diffEnabledChanged', this.diffEnabled);
            return;
        }

        if (next === this.diffEnabled) return;
        this.diffEnabled = next;

        if (this.diffEnabled) {
            this.attachRightDiffLayerToMainCamera();

            // Make overlays renderable again (do NOT toggle gsplat enabled; some builds tear down the sorter worker).
            this.setOverlayRenderable(this.rightRemovedEntity, true);
            this.setOverlayRenderable(this.rightAddedEntity, true);

            this.rebuildDiffOverlay();
        } else {
            // IMPORTANT: do not destroy overlay entities/textures.
            // In some gsplat builds, destroying a gsplat clone can leave the renderer with a stale
            // GSplatInstance reference for a frame (or tear down an internal worker), which then
            // crashes in GSplatSorter.setCamera(worker.postMessage).
            this.hideDiffOverlay();
            this.detachRightDiffLayerFromMainCamera();
        }

        this.events.fire('compareView.diffEnabledChanged', this.diffEnabled);
    }
    private rebuildDiffOverlay() {
        // IMPORTANT: do NOT destroy/recreate overlay entities on every rebuild.
        // In some gsplat builds, destroying a clone can tear down a shared sorter worker, and the next
        // frame the remaining instances will crash in GSplatSorter.setCamera(worker.postMessage).
        // We create overlays once, then update their state textures + mappings in-place.

        if (!this.enabled || !this.diffEnabled) return;

        const splat = this.scene.getElementsByType(ElementType.splat)[0] as any;
        if (!splat) return;

        // Baseline must exist (left snapshot)
        const leftState = this.leftStateSnapshot;
        const sd: any = splat.splatData;
        const rightState = (sd.getProp ? sd.getProp('state') : sd.state) as Uint8Array;

        if (!leftState || !rightState || leftState.length !== rightState.length) {
            console.warn('[CompareView] Diff: missing/mismatched leftStateSnapshot vs rightState');
            return;
        }

        // Track point count for validator / safety checks.
        this.diffPointCount = rightState.length;

        this.ensureRightDiffLayer();
        if (this.rightDiffLayerId === null) return;

        const originalStateTex = (splat as any).stateTexture as Texture;
        const transformTex = (splat as any).transformTexture as Texture;

        // Ensure overlay entities exist (created once)
        this.ensureDiffOverlayEntities(splat.entity, originalStateTex, transformTex, rightState.length);

        const removed: number[] = [];
        const added: number[] = [];

        // Compare "visibility" (deleted bit)
        for (let i = 0; i < rightState.length; i++) {
            const lVis = (leftState[i] & State.deleted) === 0;
            const rVis = (rightState[i] & State.deleted) === 0;
            if (lVis && !rVis) removed.push(i);       // left visible, right deleted  => RED
            else if (!lVis && rVis) added.push(i);    // left deleted, right visible => GREEN
        }

        console.log(`[CompareView] Diff (RIGHT): removed=${removed.length} added=${added.length} (num=${rightState.length})`);

        const removedToShow = this.sampleDiffIndicesForDisplay(splat, removed);
        const addedToShow = this.sampleDiffIndicesForDisplay(splat, added);

        // Nothing to show: hide both overlays (keep them alive).
        if (removedToShow.length === 0 && addedToShow.length === 0) {
            this.setOverlayAlpha(this.rightRemovedEntity, 0);
            this.setOverlayAlpha(this.rightAddedEntity, 0);
            return;
        }

        // Use a non-empty reference mapping to keep both sorters stable.
        const refList = removedToShow.length > 0 ? removedToShow : addedToShow;
        const refMapping = this.normalizeMapping(refList, rightState.length);

        // If one side is empty, reuse refMapping but keep it invisible.
        const removedHas = removedToShow.length > 0;
        const addedHas = addedToShow.length > 0;

        const removedMapping = removedHas ? this.normalizeMapping(removedToShow, rightState.length) : refMapping;
        const addedMapping = addedHas ? this.normalizeMapping(addedToShow, rightState.length) : refMapping;

        // Update textures in-place (no destroy/create)
        if (this.rightRemovedStateTex) {
            this.updateSparseStateTextureInPlace(this.rightRemovedStateTex, removedMapping, State.deleted);
        }
        if (this.rightAddedStateTex) {
            this.updateSparseStateTextureInPlace(this.rightAddedStateTex, addedMapping, State.deleted);
        }

        // Update materials and mappings
        this.rightRemovedMapping = removedMapping;
        this.rightAddedMapping = addedMapping;

        this.updateOverlay(this.rightRemovedEntity, this.rightRemovedStateTex, transformTex, removedMapping, [1, 0, 0, removedHas ? 0.55 : 0]);
        this.updateOverlay(this.rightAddedEntity, this.rightAddedStateTex, transformTex, addedMapping, [0, 1, 0, addedHas ? 0.55 : 0]);
    }


    private sampleDiffIndicesForDisplay(splat: any, indices: number[]) {
        // Use sorter centers (local space) to classify "floating" vs "ground-ish"
        const centers: Float32Array | undefined = splat.entity?.gsplat?.instance?.sorter?.centers;
        if (!centers) {
            // Fallback: if no centers, just cap to avoid flooding the view
            const MAX_TOTAL = 80000;
            return indices.length <= MAX_TOTAL ? indices : indices.slice(0, MAX_TOTAL);
        }

        // Tunables:
        // IMPORTANT: keep the final mapping monotonically increasing.
        // Some gsplat sorter implementations assume the mapping is sorted; if it is not, the worker
        // can terminate and the next frame will crash in GSplatSorter.setCamera(worker.postMessage).
        const Y_THRESHOLD = 0.25;
        const MAX_TOTAL = 50000;   // be conservative; large mappings are a common instability trigger
        const FLOAT_CAP = 25000;
        const GROUND_CAP = 25000;

        // Deterministic, order-preserving downsample.
        const downsampleOrdered = (arr: number[], cap: number): number[] => {
            if (arr.length <= cap) return arr;
            const out = new Array<number>(cap);
            const step = arr.length / cap;
            for (let i = 0; i < cap; i++) out[i] = arr[Math.floor(i * step)];
            return out;
        };

        const floating: number[] = [];
        const ground: number[] = [];

        for (let i = 0; i < indices.length; i++) {
            const id = indices[i];
            const y = centers[id * 3 + 1];
            if (y > Y_THRESHOLD) floating.push(id);
            else ground.push(id);
        }

        // Sample both buckets (order-preserving).
        const floatingSel = downsampleOrdered(floating, FLOAT_CAP);
        const remain = Math.max(0, MAX_TOTAL - floatingSel.length);
        const groundSel = downsampleOrdered(ground, Math.min(GROUND_CAP, remain));

        // Combine and sort to guarantee a monotonic mapping (critical for sorter stability).
        const out = floatingSel.concat(groundSel);
        out.sort((a, b) => a - b);
        return out;
    }

    private validateMapping(tag: string, mapping: Uint32Array, pointCount: number) {
        // Lightweight sanity checks to diagnose sorter crashes.
        let bad = 0;
        let prev = -1;
        let max = 0;
        for (let i = 0; i < mapping.length; i++) {
            const v = mapping[i] >>> 0;
            if (pointCount > 0 && v >= pointCount) bad++;
            if (prev !== -1 && v < prev) bad++;
            prev = v;
            if (v > max) max = v;
        }
        const head = Array.from(mapping.slice(0, Math.min(5, mapping.length)));
        const tail = Array.from(mapping.slice(Math.max(0, mapping.length - 5)));
        console.log(`[CompareView] mapping/${tag}: len=${mapping.length} max=${max} bad=${bad} head=${head} tail=${tail}`);
    }

    private destroyDiffOverlay() {
        // DEPRECATED: kept for compatibility with older code paths.
        // This method used to destroy entities/textures, but that can crash certain gsplat builds
        // on the next frame. Prefer hideDiffOverlay().
        this.hideDiffOverlay();
    }

    private setOverlayRenderable(ent: Entity | null, visible: boolean) {
        if (!ent) return;
        const inst = (ent as any)?.gsplat?.instance;
        if (inst) {
            if (inst.meshInstance) inst.meshInstance.visible = visible;
            if (Array.isArray(inst.meshInstances)) {
                for (const mi of inst.meshInstances) if (mi) mi.visible = visible;
            }
        }
        const mis = (ent as any)?.render?.meshInstances;
        if (Array.isArray(mis)) {
            for (const mi of mis) if (mi) mi.visible = visible;
        }
    }

    private hideDiffOverlay() {
        // Do not destroy, and do NOT disable gsplat component.
        // Some builds tear down the sorter worker when a gsplat component is disabled/destroyed,
        // and re-enabling does not recreate the worker, leading to worker=null crashes in setCamera.
        this.setOverlayAlpha(this.rightRemovedEntity, 0);
        this.setOverlayAlpha(this.rightAddedEntity, 0);
        this.setOverlayRenderable(this.rightRemovedEntity, false);
        this.setOverlayRenderable(this.rightAddedEntity, false);

        // Optional: reset mappings (textures can remain allocated).
        this.rightRemovedMapping = null;
        this.rightAddedMapping = null;

        // Diagnostics
        this.logSorter('main', this.getFirstSplat()?.entity ?? null);
        this.logSorter('removed', this.rightRemovedEntity);
        this.logSorter('added', this.rightAddedEntity);
    }

    private ensureDiffOverlayEntities(
        baseEntity: Entity,
        templateStateTex: Texture,
        transformTex: Texture,
        pointCount: number
    ) {
        // Must have a valid layer
        if (this.rightDiffLayerId === null) return;

        // Create a small, non-degenerate default mapping.
        const a = 0;
        const b = Math.min(1, Math.max(0, pointCount - 1));
        const c = Math.min(2, Math.max(0, pointCount - 1));
        const seed = b !== a ? [a, b] : (c !== a ? [a, c] : [a, a]);
        const seedMapping = new Uint32Array(seed);

        if (!this.rightRemovedStateTex) {
            this.rightRemovedStateTex = this.makeSparseStateTexture(
                templateStateTex,
                'compare_right_removed_init',
                seedMapping,
                State.deleted
            );
        }
        if (!this.rightAddedStateTex) {
            this.rightAddedStateTex = this.makeSparseStateTexture(
                templateStateTex,
                'compare_right_added_init',
                seedMapping,
                State.deleted
            );
        }

        if (!this.rightRemovedEntity) {
            this.rightRemovedEntity = this.createDiffOverlayEntity(
                baseEntity,
                this.rightDiffLayerId,
                this.rightRemovedStateTex,
                transformTex,
                seedMapping,
                [1, 0, 0, 0],
                true
            );
        }
        if (!this.rightAddedEntity) {
            this.rightAddedEntity = this.createDiffOverlayEntity(
                baseEntity,
                this.rightDiffLayerId,
                this.rightAddedStateTex,
                transformTex,
                seedMapping,
                [0, 1, 0, 0],
                true
            );
        }

        // Ensure initial alphas are 0 (invisible) but entities are alive.
        this.setOverlayAlpha(this.rightRemovedEntity, 0);
        this.setOverlayAlpha(this.rightAddedEntity, 0);
    }

    private normalizeMapping(indices: number[], pointCount: number): Uint32Array {
        if (!indices || indices.length === 0) {
            const b = Math.min(1, Math.max(0, pointCount - 1));
            const c = Math.min(2, Math.max(0, pointCount - 1));
            return new Uint32Array(b !== 0 ? [0, b] : (c !== 0 ? [0, c] : [0, 0]));
        }
        if (indices.length === 1) {
            const a = indices[0] >>> 0;
            const b = a !== 0 ? 0 : Math.min(1, Math.max(0, pointCount - 1));
            return new Uint32Array([a, b]);
        }
        // Ensure monotonic + in-range to avoid sorter worker termination.
        const arr = indices
            .filter((v) => v >= 0 && v < pointCount)
            .slice();
        arr.sort((a, b) => a - b);
        return new Uint32Array(arr);
    }

    private updateSparseStateTextureInPlace(tex: Texture, mapping: Uint32Array, defaultValue: number) {
        const dst = tex.lock() as Uint8Array;
        dst.fill(defaultValue);
        for (let k = 0; k < mapping.length; k++) {
            const idx = mapping[k];
            if (idx < dst.length) dst[idx] = State.selected;
        }
        tex.unlock();
    }

    private setOverlayAlpha(ent: Entity | null, alpha: number) {
        if (!ent) return;
        const inst = (ent as any)?.gsplat?.instance;
        const mat = inst?.material ?? inst?.meshInstance?.material ?? null;
        if (!mat) return;

        const isRemoved = ent === this.rightRemovedEntity;
        const rgb: [number, number, number] = isRemoved ? [1, 0, 0] : [0, 1, 0];
        mat.setParameter('selectedClr', [rgb[0], rgb[1], rgb[2], alpha]);
        mat.setParameter('lockedClr', [rgb[0], rgb[1], rgb[2], alpha]);
        if (mat.update) mat.update();
    }

    private updateOverlay(
        ent: Entity | null,
        stateTex: Texture | null,
        transformTex: Texture,
        mapping: Uint32Array,
        rgba: [number, number, number, number]
    ) {
        if (!ent || !stateTex) return;
        const inst = (ent as any)?.gsplat?.instance;
        const mat = inst?.material ?? inst?.meshInstance?.material ?? null;
        if (!mat) return;

        mat.setParameter('splatState', stateTex);
        mat.setParameter('splatTransform', transformTex);
        mat.setParameter('selectedClr', rgba);
        mat.setParameter('lockedClr', rgba);
        mat.setParameter('unselectedClr', [0, 0, 0, 0]);
        if (mat.update) mat.update();

        // Critical: in your repro, crashes occur only when "added" exists.
        // That scenario produces huge diff sets and, historically, shuffled / non-monotonic mappings.
        // Some gsplat sorter builds assume the mapping is sorted; violating that can kill the worker.
        if (mapping.length > 0 && inst?.sorter?.setMapping && !this.disableDiffSorterMapping) {
            this.validateMapping(ent.name ?? 'overlay', mapping, this.diffPointCount || 0);
            try {
                inst.sorter.setMapping(mapping);
            } catch (e) {
                console.warn('[CompareView] sorter.setMapping threw; disabling diff mapping for stability.', e);
                this.disableDiffSorterMapping = true;
            }
        }
    }



    // Create a state texture where EVERYTHING is marked as deleted.
    // Used for dummy overlays to keep gsplat instances stable while rendering nothing.
    private makeAllDeletedStateTexture(
        template: Texture,
        nameSuffix: string
    ): Texture {
        const tex = new Texture(template.device, {
            name: `${(template as any).name ?? 'tex'}_${nameSuffix}`,
            width: template.width,
            height: template.height,
            format: (template as any).format,
            mipmaps: (template as any).mipmaps,
            minFilter: (template as any).minFilter,
            magFilter: (template as any).magFilter,
            addressU: (template as any).addressU,
            addressV: (template as any).addressV
        });

        const dst = tex.lock() as Uint8Array;
        dst.fill(State.deleted);
        tex.unlock();
        return tex;
    }

    // Create a state texture where ONLY indices in mapping are marked as selected.
    // Important: fill the entire buffer first (handles padded textures).
    private makeSparseStateTexture(
        template: Texture,
        nameSuffix: string,
        mapping: Uint32Array,
        defaultValue: number
    ): Texture {
        const tex = new Texture(template.device, {
            name: `${(template as any).name ?? 'tex'}_${nameSuffix}`,
            width: template.width,
            height: template.height,
            format: (template as any).format,
            mipmaps: (template as any).mipmaps,
            minFilter: (template as any).minFilter,
            magFilter: (template as any).magFilter,
            addressU: (template as any).addressU,
            addressV: (template as any).addressV
        });

        const dst = tex.lock() as Uint8Array;
        dst.fill(defaultValue);
        for (let k = 0; k < mapping.length; k++) {
            const idx = mapping[k];
            if (idx < dst.length) dst[idx] = State.selected;
        }
        tex.unlock();
        return tex;
    }

    private createDiffOverlayEntity(
        baseEntity: Entity,
        layerId: number,
        stateTex: Texture,
        transformTex: Texture,
        mapping: Uint32Array,
        rgba: [number, number, number, number],
        rings: boolean
    ): Entity {
        const app = this.getApp();
        const e = baseEntity.clone();
        app.root.addChild(e);

        this.setEntityLayerRecursive(e, layerId);

        const inst = (e as any)?.gsplat?.instance;
        const srcInst = (baseEntity as any)?.gsplat?.instance;
        if (inst && srcInst?.material) {
            const mat = srcInst.material.clone();
            mat.setParameter('splatState', stateTex);
            mat.setParameter('splatTransform', transformTex);

            mat.setParameter('selectedClr', rgba);
            mat.setParameter('unselectedClr', [0, 0, 0, 0]);
            mat.setParameter('lockedClr', rgba);

            // Visual style
            if (rings) {
                mat.setParameter('mode', 1);     // rings
                mat.setParameter('ringSize', 0.06);
            } else {
                mat.setParameter('mode', 0);
                mat.setParameter('ringSize', 0);
            }

            // Avoid occlusion; best-effort (material type dependent)
            if ('depthTest' in mat) (mat as any).depthTest = false;
            if ('depthWrite' in mat) (mat as any).depthWrite = false;
            if (mat.update) mat.update();

            inst.material = mat;
            if (inst.meshInstance) inst.meshInstance.material = mat;

            // Do NOT apply mapping here by default. Some gsplat builds will terminate the sorter
            // worker if setMapping receives a "surprising" mapping (and the next frame will crash
            // in GSplatSorter.setCamera).
            if (mapping.length > 0 && inst?.sorter?.setMapping && !this.disableDiffSorterMapping) {
                this.validateMapping(e.name ?? 'overlay_init', mapping, this.diffPointCount || 0);
                try {
                    inst.sorter.setMapping(mapping);
                } catch (err) {
                    console.warn('[CompareView] sorter.setMapping threw during overlay init; disabling diff mapping.', err);
                    this.disableDiffSorterMapping = true;
                }
            }
        }

        return e;
    }
}
