// compare-view.ts
import { Entity, Vec4, ASPECT_MANUAL } from 'playcanvas';
import { Events } from './events';
import { Scene } from './scene';


export class CompareView {
    private events: Events;
    private scene: Scene;

    private enabled = false;
    private split = 0.5; // 0~1

    private mainCamEntity: Entity;
    private leftCamEntity: Entity | null = null;
    private mainClearColorBuffer: boolean | null = null;
    private mainAspectMode: number | null = null;
    private mainAspect: number | null = null;


    constructor(events: Events, scene: Scene, mainCamEntity: Entity) {
        this.events = events;
        this.scene = scene;
        this.mainCamEntity = mainCamEntity;

        // API
        this.events.function('compareView.enabled', () => this.enabled);
        this.events.function('compareView.split', () => this.split);

        // Controls
        this.events.on('compareView.setEnabled', (v: boolean) => {
            this.enabled = !!v;
            this.applyLayout();
            this.events.fire('compareView.enabledChanged', this.enabled);
        });

        this.events.on('compareView.toggleEnabled', () => {
            this.enabled = !this.enabled;
            this.applyLayout();
            this.events.fire('compareView.enabledChanged', this.enabled);
        });

        this.events.on('compareView.setSplit', (v: number) => {
            // clamp to avoid degenerate viewport
            this.split = Math.max(0.1, Math.min(0.9, v));
            this.applyLayout();
            this.events.fire('compareView.splitChanged', this.split);
        });

        // Every frame before rendering: keep cameras synced and rects correct
        this.events.on('prerender', () => {
            if (!this.enabled) return;
            this.ensureLeftCamera();
            this.syncLeftCameraTransform();
            this.applyLayout();
        });
    }

    private ensureLeftCamera() {
        if (this.leftCamEntity) return;

        const mainCam = (this.mainCamEntity as any).camera;
        if (!mainCam) {
            console.warn('[CompareView] mainCamEntity has no camera component.');
            return;
        }

        const e = new Entity('compare-left-camera');

        // Clone camera settings (keep it minimal; add more fields if you need)
        e.addComponent('camera', {
            fov: mainCam.fov,
            nearClip: mainCam.nearClip,
            farClip: mainCam.farClip,
            clearColor: mainCam.clearColor,
            clearColorBuffer: mainCam.clearColorBuffer,
            clearDepthBuffer: mainCam.clearDepthBuffer,
            clearStencilBuffer: mainCam.clearStencilBuffer,
            priority: (mainCam.priority ?? 0) - 1,
            layers: mainCam.layers   // ✅ 加這行
        });

        // Put it next to main camera in hierarchy so it shares same scene
        const parent = this.mainCamEntity.parent;
        if (parent) parent.addChild(e);

        this.leftCamEntity = e;
    }

    private syncLeftCameraTransform() {
        if (!this.leftCamEntity) return;

        this.leftCamEntity.setPosition(this.mainCamEntity.getPosition());
        this.leftCamEntity.setRotation(this.mainCamEntity.getRotation());

        // ✅ 同步 camera settings（至少 layers）
        const mainCam = (this.mainCamEntity as any).camera;
        const leftCam = (this.leftCamEntity as any).camera;
        if (mainCam && leftCam) {
            leftCam.layers = mainCam.layers;
        }
    }


    public setEnabled(v: boolean) {
        const next = !!v;
        if (next === this.enabled) return;

        this.enabled = next;
        this.applyLayout(); // ✅ 立刻套用，不要只靠 prerender
        this.events.fire('compareView.enabled', this.enabled);
    }

    public toggleEnabled() {
        this.setEnabled(!this.enabled);
    }


    private applyLayout() {
        const mainCam = (this.mainCamEntity as any).camera;
        if (!mainCam) return;
    
        // ----- Disabled: restore to full screen -----
        if (!this.enabled) {
            mainCam.rect = new Vec4(0, 0, 1, 1);
            mainCam.scissorRect = new Vec4(0, 0, 1, 1);
    
            // Restore main camera clear/aspect
            if (this.mainClearColorBuffer !== null) {
                mainCam.clearColorBuffer = this.mainClearColorBuffer;
                this.mainClearColorBuffer = null;
            }
            if (this.mainAspectMode !== null) {
                mainCam.aspectRatioMode = this.mainAspectMode;
                this.mainAspectMode = null;
            }
            if (this.mainAspect !== null) {
                mainCam.aspectRatio = this.mainAspect;
                this.mainAspect = null;
            }
    
            // Disable left camera
            if (this.leftCamEntity) {
                const leftCam = (this.leftCamEntity as any).camera;
                if (leftCam) leftCam.enabled = false;
            }
            return;
        }
    
        // ----- Enabled: split screen -----
        this.ensureLeftCamera();
        if (!this.leftCamEntity) return;
    
        const leftCam = (this.leftCamEntity as any).camera;
        if (!leftCam) return;
    
        leftCam.enabled = true;
    
        // Viewports (Left = [0, split), Right = [split, 1))
        leftCam.rect = new Vec4(0, 0, this.split, 1);
        leftCam.scissorRect = new Vec4(0, 0, this.split, 1);
    
        mainCam.rect = new Vec4(this.split, 0, 1 - this.split, 1);
        mainCam.scissorRect = new Vec4(this.split, 0, 1 - this.split, 1);
    
        // Aspect ratio fix: each half uses its own aspect
        const gd = (this.scene as any).graphicsDevice ?? (this.scene as any).app?.graphicsDevice;
        if (gd) {
            const leftW = gd.width * this.split;
            const rightW = gd.width * (1 - this.split);
            const h = gd.height;
    
            const leftAspect = leftW / h;
            const rightAspect = rightW / h;
    
            if (this.mainAspectMode === null) this.mainAspectMode = mainCam.aspectRatioMode;
            if (this.mainAspect === null) this.mainAspect = mainCam.aspectRatio;
    
            mainCam.aspectRatioMode = ASPECT_MANUAL;
            mainCam.aspectRatio = rightAspect;
    
            leftCam.aspectRatioMode = ASPECT_MANUAL;
            leftCam.aspectRatio = leftAspect;
        }
    
        // Clear strategy (IMPORTANT):
        // - Let the first camera (leftCam) clear color to avoid ghosting.
        // - Let the second camera (mainCam) NOT clear color, otherwise it may wipe the other half.
        // - But mainCam SHOULD clear depth so its half renders correctly.
        if (this.mainClearColorBuffer === null) this.mainClearColorBuffer = mainCam.clearColorBuffer;
    
        // Left camera clears normally (prevents blur / trails)
        leftCam.clearColorBuffer = true;
        leftCam.clearDepthBuffer = true;
    
        // Main camera: do not clear color, but clear depth
        mainCam.clearColorBuffer = false;
        mainCam.clearDepthBuffer = true;
    }
    

}
