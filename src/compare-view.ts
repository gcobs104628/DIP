import { Entity, Vec4, ASPECT_MANUAL, Texture, Layer } from 'playcanvas';
import { Events } from './events';
import { Scene } from './scene';
import { Splat } from './splat';
import { ElementType } from './element';
import { State } from './splat-state';

type CameraComp = any;

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

    // CPU snapshot of left state (needed for diff)
    private leftStateSnapshot: Uint8Array | null = null;

    // Diff overlay
    private diffEnabled = false;

    private leftDiffLayerId: number | null = null;
    private rightDiffLayerId: number | null = null;

    private leftDiffEntity: Entity | null = null;
    private rightDiffEntity: Entity | null = null;

    private leftDiffStateTexture: Texture | null = null;
    private rightDiffStateTexture: Texture | null = null;

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

        // NEW: refresh left snapshot to current right state
        this.events.on('compareView.refreshSnapshot', () => this.refreshSnapshot());

        // Diff overlay controls (only meaningful when compareView.enabled === true)
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
    private refreshSnapshot() {
        if (!this.enabled) return;

        const splat = this.scene.getElementsByType(ElementType.splat)[0] as Splat;
        if (!splat) return;
        if (!this.clonedSplatEntity || !this.clonedStateTexture) return;

        // Read current state from the live (right) splat
        const sd: any = splat.splatData;
        const currentState = (sd.getProp ? sd.getProp('state') : sd.state) as Uint8Array;
        if (!currentState) return;

        // Deep copy + overwrite left snapshot texture
        const snap = new Uint8Array(currentState);
        this.leftStateSnapshot = snap;

        const dst = this.clonedStateTexture.lock();
        dst.set(snap);
        this.clonedStateTexture.unlock();

        // Also freeze the current visual params into the left material at refresh time
        const clonedInstance = (this.clonedSplatEntity as any)?.gsplat?.instance;
        const mat =
            clonedInstance?.material ??
            clonedInstance?.meshInstance?.material ??
            null;

        if (mat) {
            this.applyParamsToMaterial(mat, splat);
            if (mat.update) mat.update();
        }

        // Optional: let UI know snapshot was refreshed
        this.events.fire('compareView.snapshotRefreshed');

        // If diff overlay is on, rebuild using updated snapshot
        if (this.diffEnabled) {
            this.rebuildDiffOverlay();
        }
    }

    private ensureLeftLayer() {
        if (this.leftLayerId !== null) return;

        const app = this.getApp();
        if (!app?.scene?.layers) {
            console.warn('[CompareView] Cannot access app.scene.layers');
            return;
        }

        const layers = app.scene.layers;
        let leftLayer = layers.getLayerByName?.('CompareLeft') as Layer | null;

        if (!leftLayer) {
            leftLayer = new Layer({ name: 'CompareLeft' });

            // <<< REPLACE INSERT LOGIC WITH THIS >>>
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
        const comp = app?.scene?.layers;
        if (!comp) return;

        // Get target layer object
        const target =
            (comp.getLayerById ? comp.getLayerById(layerId) : null) ??
            (comp.getLayerByName ? comp.getLayerByName('CompareLeft') : null);

        const layerList: any[] = comp.layerList ?? [];

        const move = (mi: any) => {
            if (!mi) return;

            // Remove from all existing layers (critical)
            for (const L of layerList) {
                L?.removeMeshInstances?.([mi]);
            }

            // Add to target layer
            target?.addMeshInstances?.([mi]);

            // Keep id consistent (not sufficient alone, but good to set)
            mi.layer = layerId;
        };

        (entity as any).forEach?.((node: any) => {
            // GSplat meshInstance
            const gsMi = node?.gsplat?.instance?.meshInstance;
            if (gsMi) move(gsMi);

            // Generic render meshInstances
            const mis = node?.render?.meshInstances;
            if (mis?.length) {
                for (const mi of mis) move(mi);
            }
        });
    }


    private snapshotTexture(original: Texture, nameSuffix: string): { tex: Texture; data: any } {
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

        return { tex, data: copy };
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

    private setEnabled(v: boolean) {
        const next = !!v;
        if (next === this.enabled) return;

        const splat = this.getFirstSplat();
        if (!splat) {
            this.enabled = false;
            this.events.fire('compareView.enabledChanged', this.enabled);
            return;
        }

        // Enable
        if (next) {
            this.enabled = true;

            // backup main camera state once
            const mainCam = this.getMainCamComp();
            if (!mainCam) {
                console.warn('[CompareView] main camera component missing');
                this.enabled = false;
                this.events.fire('compareView.enabledChanged', this.enabled);
                return;
            }

            if (!this.mainCamBackup) {
                this.mainCamBackup = {
                    rect: mainCam.rect ? mainCam.rect.clone() : new Vec4(0, 0, 1, 1),
                    scissorRect: mainCam.scissorRect ? mainCam.scissorRect.clone() : new Vec4(0, 0, 1, 1),
                    clearColorBuffer: !!mainCam.clearColorBuffer,
                    aspectRatioMode: mainCam.aspectRatioMode,
                    aspectRatio: mainCam.aspectRatio,
                    layers: (mainCam.layers ? [...mainCam.layers] : [])
                };
            }

            // create/ensure layer for left snapshot
            this.ensureLeftLayer();
            if (this.leftLayerId === null) {
                console.warn('[CompareView] failed to create CompareLeft layer');
                this.enabled = false;
                this.events.fire('compareView.enabledChanged', this.enabled);
                return;
            }

            // snapshot textures (both state + transform)
            try {
                const stateSnap = this.snapshotTexture(splat.stateTexture, 'compare_left_state');
                const xformSnap = this.snapshotTexture(splat.transformTexture, 'compare_left_xform');
                this.clonedStateTexture = stateSnap.tex;
                this.clonedTransformTexture = xformSnap.tex;

                // ALSO snapshot CPU state array for diff overlay
                const sd: any = splat.splatData;
                const currentState = (sd.getProp ? sd.getProp('state') : sd.state) as Uint8Array;
                this.leftStateSnapshot = currentState ? new Uint8Array(currentState) : null;
            } catch (e) {
                console.error('[CompareView] texture snapshot failed', e);
                this.enabled = false;
                this.events.fire('compareView.enabledChanged', this.enabled);
                return;
            }

            // clone entity
            const app = this.getApp();
            this.clonedSplatEntity = splat.entity.clone();
            app.root.addChild(this.clonedSplatEntity);

            // move cloned entity into CompareLeft layer so only left camera can see it
            this.setEntityLayerRecursive(this.clonedSplatEntity, this.leftLayerId);

            // isolate material & bind cloned textures
            const clonedInstance = (this.clonedSplatEntity as any)?.gsplat?.instance;
            const srcInstance = (splat.entity as any)?.gsplat?.instance;

            if (clonedInstance && srcInstance?.material) {
                const clonedMat = srcInstance.material.clone();

                clonedMat.setParameter('splatState', this.clonedStateTexture);
                clonedMat.setParameter('splatTransform', this.clonedTransformTexture);

                // freeze current filter params into left snapshot
                this.applyParamsToMaterial(clonedMat, splat);
                clonedMat.update();

                // IMPORTANT: bind to meshInstance actually rendered
                clonedInstance.material = clonedMat;
                if (clonedInstance.meshInstance) {
                    clonedInstance.meshInstance.material = clonedMat;
                }
            } else {
                console.warn('[CompareView] gsplat instance/material missing on clone or source');
            }

            // ensure left camera exists and set camera layers isolation
            this.ensureLeftCamera();

            // remove CompareLeft from main camera layers (prevent right side from rendering clone)
            const mainCamComp = this.getMainCamComp();
            if (mainCamComp) {
                const origLayers = this.mainCamBackup?.layers ?? (mainCamComp.layers ? [...mainCamComp.layers] : []);
                mainCamComp.layers = origLayers.filter((id: number) => id !== this.leftLayerId);
            }

            this.applyLayout();
            this.events.fire('compareView.enabledChanged', this.enabled);
            return;
        }

        // Disable
        // turn off diff overlay first
        if (this.diffEnabled) {
            this.setDiffEnabled(false);
        }

        this.enabled = false;

        // restore main camera state
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

        // Destroy left camera entity to avoid stale camera/layer state on next enable
        if (this.leftCamEntity) {
            this.leftCamEntity.destroy();
            this.leftCamEntity = null;
        }

        // Remove CompareLeft layer from composition and reset cached id
        const app = this.getApp();
        const layers = app?.scene?.layers;
        const leftLayer = layers?.getLayerByName?.('CompareLeft');
        if (leftLayer) {
            // Different PlayCanvas versions have different APIs; try all safely.
            layers.removeOpaque?.(leftLayer);
            layers.removeTransparent?.(leftLayer);
            layers.remove?.(leftLayer);
        }
        this.leftLayerId = null;


        // destroy cloned entity + textures
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
            // same priority is OK because rects do not overlap
            priority: mainCamComp.priority,
            // render ONLY left snapshot layer
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

        // scissored split
        const leftRect = new Vec4(0, 0, this.split, 1);
        const rightRect = new Vec4(this.split, 0, 1 - this.split, 1);

        leftCam.rect = leftRect;
        leftCam.scissorRect = leftRect;
        leftCam.clearColorBuffer = true;

        mainCam.rect = rightRect;
        mainCam.scissorRect = rightRect;
        mainCam.clearColorBuffer = true;

        // manual aspect ratios (avoid distortion)
        const gd = (this.scene as any).graphicsDevice;
        if (gd) {
            mainCam.aspectRatioMode = ASPECT_MANUAL;
            mainCam.aspectRatio = (gd.width * (1 - this.split)) / gd.height;

            leftCam.aspectRatioMode = ASPECT_MANUAL;
            leftCam.aspectRatio = (gd.width * this.split) / gd.height;
        }
    }


    // -----------------------
    // Diff overlay (deleted XOR)
    // -----------------------

    private ensureDiffLayers() {
        const app = this.getApp();
        if (!app?.scene?.layers) return;

        const layers = app.scene.layers;

        const ensure = (name: string) => {
            let L = layers.getLayerByName?.(name) as Layer | null;
            if (!L) {
                L = new Layer({ name });
                // Put diff layers at the end so they render on top
                const idx = (layers.layerList?.length ?? 0);
                if (layers.insertOpaque && layers.insertTransparent) {
                    layers.insertOpaque(L, idx);
                    layers.insertTransparent(L, idx);
                } else if (layers.insert) {
                    layers.insert(L, idx);
                }
            }
            return L;
        };

        // Only need the right-side overlay layer. Left side should never be tinted.
        if (this.rightDiffLayerId === null) {
            const L = ensure('CompareRightDiff');
            this.rightDiffLayerId = L ? L.id : null;
        }
    }

    private attachDiffLayersToCameras() {
        this.ensureDiffLayers();
        if (this.rightDiffLayerId === null) return;

        const mainCam = this.getMainCamComp();
        if (mainCam) {
            const layers = mainCam.layers ? [...mainCam.layers] : [];
            if (!layers.includes(this.rightDiffLayerId)) layers.push(this.rightDiffLayerId);
            mainCam.layers = layers;
        }

        // Left camera must remain clean (no diff overlay layer).
        if (this.leftCamEntity) {
            const leftCam = (this.leftCamEntity as any).camera;
            if (leftCam && this.leftLayerId !== null) {
                leftCam.layers = [this.leftLayerId];
            }
        }
    }

    private detachDiffLayersFromCameras() {
        const mainCam = this.getMainCamComp();
        if (mainCam && this.rightDiffLayerId !== null) {
            const layers = mainCam.layers ? [...mainCam.layers] : [];
            mainCam.layers = layers.filter((id: number) => id !== this.rightDiffLayerId);
        }

        if (this.leftCamEntity) {
            const leftCam = (this.leftCamEntity as any).camera;
            if (leftCam && this.leftLayerId !== null) {
                leftCam.layers = [this.leftLayerId];
            }
        }
    }

    private setDiffEnabled(v: boolean) {
        const next = !!v;

        // If compare is not enabled, force diff off
        if (!this.enabled) {
            if (this.diffEnabled) {
                this.destroyDiffOverlay();
                this.detachDiffLayersFromCameras();
            }
            this.diffEnabled = false;
            this.events.fire('compareView.diffEnabledChanged', this.diffEnabled);
            return;
        }

        if (next === this.diffEnabled) return;
        this.diffEnabled = next;

        if (this.diffEnabled) {
            this.ensureLeftCamera(); // ensure left camera exists so we can add left diff layer
            this.attachDiffLayersToCameras();
            this.rebuildDiffOverlay();
        } else {
            this.destroyDiffOverlay();
            this.detachDiffLayersFromCameras();
        }

        this.events.fire('compareView.diffEnabledChanged', this.diffEnabled);
    }

    private rebuildDiffOverlay() {
        const splat = this.getFirstSplat();
        if (!splat) return;

        // Diff only makes sense when compare is enabled
        if (!this.enabled || !this.diffEnabled) return;

        // Always rebuild from scratch (avoid stale overlays after undo/redo)
        this.destroyDiffOverlay();

        // Need both arrays to compare
        const sd: any = splat.splatData;
        const rightState = (sd.getProp ? sd.getProp('state') : sd.state) as Uint8Array;
        const leftState = this.leftStateSnapshot;

        if (!rightState || !leftState || rightState.length !== leftState.length) {
            console.warn('[CompareView] Diff: missing or mismatched state arrays.');
            this.events.fire('compareView.diffCountChanged', 0);
            return;
        }

        // Find indices where deleted-bit differs (this is what actually changes visibility)
        const diffIdx: number[] = [];
        for (let i = 0; i < rightState.length; i++) {
            const rDel = (rightState[i] & State.deleted) !== 0;
            const lDel = (leftState[i] & State.deleted) !== 0;
            if (rDel !== lDel) diffIdx.push(i);
        }

        this.events.fire('compareView.diffCountChanged', diffIdx.length);

        // Nothing to show
        if (diffIdx.length === 0) return;

        // Ensure right diff layer exists and is attached to the main camera
        this.attachDiffLayersToCameras();
        if (this.rightDiffLayerId === null) return;

        // Overlay state: ONLY mark diff indices as selected; everything else stays 0.
        // (We do NOT want to inherit any selection/lock flags from the live state.)
        const overlayState = new Uint8Array(rightState.length);
        for (let k = 0; k < diffIdx.length; k++) {
            overlayState[diffIdx[k]] = State.selected;
        }

        // Mapping: render ONLY diff indices.
        const mapping = new Uint32Array(diffIdx.length);
        for (let k = 0; k < diffIdx.length; k++) mapping[k] = diffIdx[k];

        // Create overlay texture
        this.rightDiffStateTexture = this.makeTextureFromBytes(
            splat.stateTexture,
            'compare_diff_right_state',
            overlayState
        );

        // Create overlay entity on RIGHT ONLY
        this.rightDiffEntity = this.createDiffOverlayEntity(
            splat.entity,
            this.rightDiffLayerId,
            this.rightDiffStateTexture,
            splat.transformTexture,
            mapping
        );

        console.log(`[CompareView] Diff overlay (RIGHT only): ${diffIdx.length} splats.`);
    }

    private destroyDiffOverlay() {
        if (this.rightDiffEntity) {
            this.rightDiffEntity.destroy();
            this.rightDiffEntity = null;
        }
        if (this.rightDiffStateTexture) {
            this.rightDiffStateTexture.destroy();
            this.rightDiffStateTexture = null;
        }

        // Defensive cleanup of legacy left-side fields (should never be used now)
        if (this.leftDiffEntity) {
            this.leftDiffEntity.destroy();
            this.leftDiffEntity = null;
        }
        if (this.leftDiffStateTexture) {
            this.leftDiffStateTexture.destroy();
            this.leftDiffStateTexture = null;
        }
    }

    private makeTextureFromBytes(template: Texture, nameSuffix: string, bytes: Uint8Array): Texture {
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

        const dst = tex.lock();
        dst.set(bytes);
        tex.unlock();
        return tex;
    }

    private createDiffOverlayEntity(
        baseEntity: Entity,
        layerId: number,
        stateTex: Texture,
        transformTex: Texture,
        mapping: Uint32Array
    ): Entity {
        const app = this.getApp();
        const e = baseEntity.clone();
        app.root.addChild(e);

        // move into desired layer (critical for left/right separation)
        this.setEntityLayerRecursive(e, layerId);

        const inst = (e as any)?.gsplat?.instance;
        const srcInst = (baseEntity as any)?.gsplat?.instance;

        if (inst && srcInst?.material) {
            const mat = srcInst.material.clone();

            // bind overlay textures
            mat.setParameter('splatState', stateTex);
            mat.setParameter('splatTransform', transformTex);

            // force highlight red
            mat.setParameter('selectedClr', [1, 0, 0, 1]);
            // make unselected fully transparent to avoid accidental tinting
            mat.setParameter('unselectedClr', [0, 0, 0, 0]);
            mat.setParameter('lockedClr', [1, 0, 0, 1]);

            // no rings
            mat.setParameter('mode', 0);
            mat.setParameter('ringSize', 0);

            if (mat.update) mat.update();

            inst.material = mat;
            if (inst.meshInstance) inst.meshInstance.material = mat;


            // <-- 在這裡加
            inst.sorter?.setMapping?.(mapping);

        } else {
            console.warn('[CompareView] Diff overlay: gsplat instance/material missing');
        }

        return e;
    }
}
