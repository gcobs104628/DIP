import { Events } from '../events';
import { Scene } from '../scene';
import { ElementType } from '../element';
import { State } from '../splat-state';

type AnyEditOp = any;

type KnnParams = { k: number; threshold: number };

export class KnnOutlierFilterTool {
    private events: Events;
    private scene: Scene;

    private baselineState: Uint8Array | null = null;
    private lastParams: KnnParams | null = null;

    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;
    }

    private getSplatSdStateXYZ(): {
        splat: any;
        sd: any;
        state: Uint8Array;
        x: Float32Array;
        y: Float32Array;
        z: Float32Array;
        n: number;
    } | null {
        const splats = this.scene.getElementsByType(ElementType.splat);
        if (!splats || splats.length === 0) return null;

        const splat: any = splats[0];
        const sd: any = splat.splatData;

        const getStorageByName = (name: string) =>
            splat?.splatData?.elements?.[0]?.properties?.find((p: any) => p.name === name)?.storage;

        const x: Float32Array | undefined = (sd?.getProp?.('x') as Float32Array) ?? getStorageByName('x');
        const y: Float32Array | undefined = (sd?.getProp?.('y') as Float32Array) ?? getStorageByName('y');
        const z: Float32Array | undefined = (sd?.getProp?.('z') as Float32Array) ?? getStorageByName('z');

        if (!x || !y || !z || x.length === 0) {
            console.error('[KNNOutlier] Missing x/y/z arrays.');
            return null;
        }

        let state: Uint8Array | undefined =
            (sd?.getProp?.('state') as Uint8Array) ?? (sd?.state as Uint8Array) ?? (getStorageByName('state') as Uint8Array);

        if (!state) {
            const n0 = sd?.numSplats ?? splat?.numSplats ?? x.length;
            state = new Uint8Array(n0);
            if (typeof sd?.addProp === 'function') sd.addProp('state', state);
            else sd.state = state;
            console.log('[KNNOutlier] Created state prop.');
        }

        const n = sd?.numSplats ?? state.length;
        return { splat, sd, state, x, y, z, n };
    }

    private applyBytesAndRefresh(splat: any, state: Uint8Array, bytes: Uint8Array) {
        state.set(bytes);
        if (typeof splat.updateState === 'function') splat.updateState(State.deleted);
        else if (typeof splat.rebuildMaterial === 'function') splat.rebuildMaterial();
    }

    private setParamsAndNotifyUI(p: KnnParams) {
        this.lastParams = p;
        // UI-only event: update sliders without re-running the filter
        this.events.fire('filter.knnOutlier.uiSet', p);
    }

    private pushUndoOp(
        label: string,
        splat: any,
        state: Uint8Array,
        beforeState: Uint8Array,
        afterState: Uint8Array,
        beforeParams: KnnParams,
        afterParams: KnnParams
    ) {
        const op: AnyEditOp = {
            label,
            do: () => {
                this.setParamsAndNotifyUI(afterParams);
                this.applyBytesAndRefresh(splat, state, afterState);
            },
            undo: () => {
                this.setParamsAndNotifyUI(beforeParams);
                this.applyBytesAndRefresh(splat, state, beforeState);
            },
            destroy: () => {}
        };

        this.events.fire('edit.add', op, true);
    }

    reset() {
        const ctx = this.getSplatSdStateXYZ();
        if (!ctx) return;

        const { splat, state } = ctx;

        if (!this.baselineState) return;

        const beforeState = new Uint8Array(state);

        state.set(this.baselineState);

        if (typeof splat.updateState === 'function') splat.updateState(State.deleted);
        else if (typeof splat.rebuildMaterial === 'function') splat.rebuildMaterial();

        const afterState = new Uint8Array(state);

        // Keep lastParams unchanged; reset is a state operation
        const p = this.lastParams ?? { k: 8, threshold: 0.05 };
        this.pushUndoOp('KNNOutlier.reset', splat, state, beforeState, afterState, p, p);

        // Clear baseline so next apply captures a fresh baseline again
        this.baselineState = null;
        console.log('[KNNOutlier] Reset done.');
    }

    async apply(k: number, threshold: number) {
        if (!Number.isFinite(k) || k < 1) {
            console.warn('[KNNOutlier] invalid k:', k);
            return;
        }
        if (!Number.isFinite(threshold) || threshold <= 0) {
            console.warn('[KNNOutlier] invalid threshold:', threshold);
            return;
        }

        const ctx = this.getSplatSdStateXYZ();
        if (!ctx) return;

        const { splat, state, x, y, z, n } = ctx;

        const beforeParams: KnnParams = this.lastParams ?? { k, threshold };
        const afterParams: KnnParams = { k, threshold };
        this.lastParams = afterParams;

        const beforeState = new Uint8Array(state);

        if (!this.baselineState) this.baselineState = new Uint8Array(state);
        state.set(this.baselineState);

        const thr2 = threshold * threshold;
        const inv = 1.0 / threshold;

        const cells = new Map<string, number[]>();
        const isActive = (i: number) => (state[i] & State.deleted) === 0;

        for (let i = 0; i < n; i++) {
            if (!isActive(i)) continue;
            const cx = Math.floor(x[i] * inv);
            const cy = Math.floor(y[i] * inv);
            const cz = Math.floor(z[i] * inv);
            const key = `${cx},${cy},${cz}`;
            let arr = cells.get(key);
            if (!arr) {
                arr = [];
                cells.set(key, arr);
            }
            arr.push(i);
        }

        let deleted = 0;

        for (let i = 0; i < n; i++) {
            if (!isActive(i)) continue;

            const cx = Math.floor(x[i] * inv);
            const cy = Math.floor(y[i] * inv);
            const cz = Math.floor(z[i] * inv);

            let cnt = 0;

            for (let dz = -1; dz <= 1 && cnt < k; dz++) {
                for (let dy = -1; dy <= 1 && cnt < k; dy++) {
                    for (let dx = -1; dx <= 1 && cnt < k; dx++) {
                        const key = `${cx + dx},${cy + dy},${cz + dz}`;
                        const arr = cells.get(key);
                        if (!arr) continue;

                        for (let t = 0; t < arr.length; t++) {
                            const j = arr[t];
                            if (j === i) continue;

                            const dxp = x[i] - x[j];
                            const dyp = y[i] - y[j];
                            const dzp = z[i] - z[j];
                            const d2 = dxp * dxp + dyp * dyp + dzp * dzp;

                            if (d2 <= thr2) {
                                cnt++;
                                if (cnt >= k) break;
                            }
                        }
                    }
                }
            }

            if (cnt < k) {
                state[i] |= State.deleted;
                deleted++;
            }

            if ((i & 16383) === 0) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise(requestAnimationFrame);
            }
        }

        if (typeof splat.updateState === 'function') splat.updateState(State.deleted);
        else if (typeof splat.rebuildMaterial === 'function') splat.rebuildMaterial();

        const afterState = new Uint8Array(state);

        this.pushUndoOp(`KNNOutlier(k=${k}, r=${threshold})`, splat, state, beforeState, afterState, beforeParams, afterParams);

        console.log(`[KNNOutlier] Done. k=${k}, threshold=${threshold}, deleted=${deleted}`);
    }
}
