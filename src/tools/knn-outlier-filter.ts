import { Events } from '../events';
import { Scene } from '../scene';
import { ElementType } from '../element';
import { State } from '../splat-state';

export class KnnOutlierFilterTool {
    private events: Events;
    private scene: Scene;

    // baseline snapshot so repeated runs are NOT cumulative (same pattern as scale-filter.ts)
    private baselineState: Uint8Array | null = null;

    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;
    }

    reset() {
        const splats = this.scene.getElementsByType(ElementType.splat);
        if (!splats || splats.length === 0) return;

        const splat: any = splats[0];
        const sd: any = splat.splatData;

        const state: Uint8Array | undefined =
            (sd?.getProp?.('state') as Uint8Array) ??
            (sd?.state as Uint8Array) ??
            (splat?.splatData?.elements?.[0]?.properties?.find((p: any) => p.name === 'state')?.storage as Uint8Array);

        if (!state) return;

        if (this.baselineState) {
            state.set(this.baselineState);
            if (typeof splat.updateState === 'function') splat.updateState(State.deleted);
            else if (typeof splat.rebuildMaterial === 'function') splat.rebuildMaterial();
        }

        this.baselineState = null;
        console.log('[KNNOutlier] Reset done (restored baseline + cleared baseline).');
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

        const splats = this.scene.getElementsByType(ElementType.splat);
        if (!splats || splats.length === 0) {
            console.warn('[KNNOutlier] No splat found.');
            return;
        }

        const splat: any = splats[0];
        const sd: any = splat.splatData;

        // ---- get x/y/z/state (robust, supports both getProp() and elements[0].properties) ----
        const getStorageByName = (name: string) =>
            splat?.splatData?.elements?.[0]?.properties?.find((p: any) => p.name === name)?.storage;

        const x: Float32Array | undefined = (sd?.getProp?.('x') as Float32Array) ?? getStorageByName('x');
        const y: Float32Array | undefined = (sd?.getProp?.('y') as Float32Array) ?? getStorageByName('y');
        const z: Float32Array | undefined = (sd?.getProp?.('z') as Float32Array) ?? getStorageByName('z');

        let state: Uint8Array | undefined =
            (sd?.getProp?.('state') as Uint8Array) ??
            (sd?.state as Uint8Array) ??
            (getStorageByName('state') as Uint8Array);

        if (!x || !y || !z || x.length === 0) {
            console.error('[KNNOutlier] Missing x/y/z arrays.');
            return;
        }

        // state may not exist; create it like scale-filter.ts does
        if (!state) {
            const n = sd?.numSplats ?? splat?.numSplats ?? x.length;
            state = new Uint8Array(n);
            if (typeof sd?.addProp === 'function') sd.addProp('state', state);
            else sd.state = state;
            console.log('[KNNOutlier] Created state prop.');
        }

        const n = sd?.numSplats ?? state.length;

        // ---- baseline snapshot & restore (prevents “press multiple times -> fewer and fewer”) ----
        if (!this.baselineState) this.baselineState = new Uint8Array(state);
        state.set(this.baselineState);

        const thr2 = threshold * threshold;
        const inv = 1.0 / threshold;

        // ---- build spatial hash: cellSize = threshold ----
        // key = "cx,cy,cz" -> indices in that cell
        const cells = new Map<string, number[]>();

        const isActive = (i: number) => (state![i] & State.deleted) === 0;

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

        let activeBefore = 0;
        let minCnt = 1e9;
        let maxCnt = 0;
        let sumCnt = 0;
        let samples = 0;

        // ---- query neighbors in 27 adjacent cells ----
        for (let i = 0; i < n; i++) {
            if (!isActive(i)) continue;

            activeBefore++;

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
            minCnt = Math.min(minCnt, cnt);
            maxCnt = Math.max(maxCnt, cnt);
            sumCnt += cnt;
            samples++;
            if (cnt < k) {
                state[i] |= State.deleted;
                deleted++;
            }

            // yield occasionally so UI won't freeze completely
            if ((i & 16383) === 0) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise(requestAnimationFrame);
            }
        }
        let deletedTotal = 0;
        for (let i = 0; i < n; i++) {
            if ((state[i] & State.deleted) !== 0) deletedTotal++;
        }
        const activeAfter = n - deletedTotal;

        console.log(
            `[KNNOutlier] k=${k}, r=${threshold} | activeBefore=${activeBefore} ` +
            `| deletedThisRun=${deleted} | deletedTotal=${deletedTotal} | activeAfter=${activeAfter} ` +
            `| neighborCnt(min/avg/max)=${minCnt}/${(sumCnt / Math.max(samples, 1)).toFixed(2)}/${maxCnt}`
        );

        if (typeof splat.updateState === 'function') splat.updateState(State.deleted);
        else if (typeof splat.rebuildMaterial === 'function') splat.rebuildMaterial();

        console.log(`[KNNOutlier] Done. k=${k}, threshold=${threshold}, deleted=${deleted}`);
    }
}
