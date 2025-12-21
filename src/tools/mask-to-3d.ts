import { Vec3, Mat4, Quat } from "playcanvas";
import { Events } from "../events";
import { Scene } from "../scene";
import { ElementType } from "../element";
import { State } from "../splat-state";

interface CameraPose {
    file_path: string;
    rotation: [number, number, number, number];
    translation: [number, number, number];
    intrinsics: { width: number, height: number, params: number[] };
}

class MaskTo3DTool {
    events: Events;
    scene: Scene;
    private maskList: { filename: string, data: Uint8ClampedArray, width: number, height: number }[] = [];
    private cameraPoses: CameraPose[] = [];

    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;
    }

    setMasks(masks: { filename: string, img: HTMLImageElement }[]) {
        this.maskList = masks.map(m => {
            const canvas = document.createElement('canvas');
            canvas.width = m.img.width;
            canvas.height = m.img.height;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(m.img, 0, 0);
            return {
                filename: m.filename, width: m.img.width, height: m.img.height,
                data: ctx.getImageData(0, 0, m.img.width, m.img.height).data
            };
        });
    }

    setCameraPoses(poses: CameraPose[]) {
        this.cameraPoses = poses;
    }

    activate() { this.run(); }

    private project(worldPos: Vec3, pose: CameraPose) {
        const q = new Quat(pose.rotation[1], pose.rotation[2], pose.rotation[3], pose.rotation[0]);
        const rotMat = new Mat4().setTRS(Vec3.ZERO, q, Vec3.ONE);
        const t = new Vec3(pose.translation[0], pose.translation[1], pose.translation[2]);
        const posCam = rotMat.transformPoint(worldPos);
        posCam.add(t);

        if (posCam.z <= 0) return null;

        const [fx, fy, cx, cy] = pose.intrinsics.params;
        return {
            u: Math.floor((fx * posCam.x) / posCam.z + cx),
            v: Math.floor((fy * posCam.y) / posCam.z + cy)
        };
    }

    async run() {
        const splats = this.scene.getElementsByType(ElementType.splat);
        if (!splats.length || !this.maskList.length || !this.cameraPoses.length) return;

        const splat: any = splats[0];

        const sd: any = splat.splatData;

        const getStorageByName = (name: string) =>
            sd?.elements?.[0]?.properties?.find((p: any) => p.name === name)?.storage;

        const x: Float32Array | undefined = (sd?.getProp?.('x') as Float32Array) ?? (getStorageByName('x') as Float32Array);
        const y: Float32Array | undefined = (sd?.getProp?.('y') as Float32Array) ?? (getStorageByName('y') as Float32Array);
        const z: Float32Array | undefined = (sd?.getProp?.('z') as Float32Array) ?? (getStorageByName('z') as Float32Array);

        if (!x || !y || !z || x.length === 0) {
            console.error('[MaskTo3D] Missing x/y/z arrays.');
            return;
        }

        let state: Uint8Array | undefined =
            (sd?.getProp?.('state') as Uint8Array) ??
            (sd?.state as Uint8Array) ??
            (getStorageByName('state') as Uint8Array);

        if (!state) {
            const n0 = sd?.numSplats ?? splat?.numSplats ?? x.length;
            state = new Uint8Array(n0);

            // Attach to sd in the "standard" way used by other filters
            if (typeof sd?.addProp === 'function') sd.addProp('state', state);
            else sd.state = state;

            // Also attach to properties, so code paths that read from properties still share the same buffer
            const props = sd?.elements?.[0]?.properties;
            if (Array.isArray(props) && !props.some((p: any) => p?.name === 'state')) {
                props.push({ name: 'state', storage: state });
            }

            console.log('[MaskTo3D] Created state prop.');
        }



        let deletedCount = 0;
        const worldPos = new Vec3();

        // --- 參數調整區 ---
        // 如果地板還是被砍，請調大此數值（例如 1.5）；如果雜訊太多，調小。
        const FLOOR_PROTECTION_Y = -1.2;
        // ----------------

        const cameraToMaskMap = this.cameraPoses.map(pose => {
            const coreName = pose.file_path.split('/').pop()?.split('.')[0];
            const mask = this.maskList.find(m => m.filename.includes(coreName || ""));
            return { pose, mask };
        });

        console.log(`[MaskTo3D] 開始執行。保護高度 Y > ${FLOOR_PROTECTION_Y}`);

        for (let i = 0; i < x.length; i++) {
            worldPos.set(x[i], y[i], z[i]);

            // 1. 地板保護：如果點的位置非常低，直接跳過不刪除
            // 注意：COLMAP 座標中 Y 有可能向下，如果發現無效，請試著改為 y[i] < FLOOR_PROTECTION_Y
            if (y[i] < FLOOR_PROTECTION_Y) {
                continue;
            }

            let isVisibleAsForeground = false;
            let backgroundVotes = 0;
            let totalVisits = 0;

            for (const { pose, mask } of cameraToMaskMap) {
                const proj = this.project(worldPos, pose);

                if (proj && mask && proj.u >= 0 && proj.u < mask.width && proj.v >= 0 && proj.v < mask.height) {
                    totalVisits++;
                    const idx = (proj.v * mask.width + proj.u) * 4;

                    if (mask.data[idx] > 128) {
                        isVisibleAsForeground = true;
                        break; // 只要有一張是前景，就絕對保住
                    } else {
                        backgroundVotes++;
                    }
                }
            }

            // 2. 激進去噪邏輯：
            // 如果這個點「從未」在任何視角被判定為前景
            // 且 (它在至少 1 個視角被判定為背景 OR 它根本沒被任何相機看到)
            if (!isVisibleAsForeground) {
                if (backgroundVotes >= 1 || totalVisits === 0) {
                    state[i] |= State.deleted;
                    deletedCount++;
                }
            }
        }

        splat.updateState(State.deleted);
        console.log(`[MaskTo3D] 完畢。刪除: ${deletedCount} 點。`);
    }
}
export { MaskTo3DTool };