import { Entity, Vec4, ASPECT_MANUAL, Texture, Layer } from 'playcanvas';
import { Events } from './events';
import { Scene } from './scene';
import { Splat } from './splat';
import { ElementType } from './element';

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

        // expose getters for UI
        this.events.function('compareView.enabled', () => this.enabled);
        this.events.function('compareView.split', () => this.split);

        // UI control events
        this.events.on('compareView.toggleEnabled', () => this.setEnabled(!this.enabled));
        this.events.on('compareView.setEnabled', (v: any) => this.setEnabled(!!v));
        this.events.on('compareView.setSplit', (v: any) => {
            const nv = Math.max(0.05, Math.min(0.95, Number(v)));
            this.split = isFinite(nv) ? nv : 0.5;
            if (this.enabled) this.applyLayout();
            this.events.fire('compareView.splitChanged', this.split);
        });

        // render hook
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
}
