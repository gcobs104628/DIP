import { Events } from '../events';
import { Scene } from '../scene';
import { ElementType } from '../element';
import { State } from '../splat-state';

type AnyEditOp = any;

type ScaleParams = { minScale: number; maxScale: number; threshold: number };
type Pending = {
    kind: 'scale' | 'opacity';
    beforeState: Uint8Array;
    beforeParams: ScaleParams;
};

export class ScaleFilterTool {
    private events: Events;
    private scene: Scene;

    private baselineState: Uint8Array | null = null;

    private minScale = -12;
    private maxScale = 2;
    private opacityThreshold = 0;

    private pending: Pending | null = null;

    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;
    }

    // Existing API (single-shot, one undo per call)
    applyScale(minScale: number, maxScale: number) {
        const beforeParams = this.getParams();
        this.minScale = minScale;
        this.maxScale = maxScale;
        const afterParams = this.getParams();
        this.applyAllWithUndo(beforeParams, afterParams);
    }

    applyOpacity(threshold: number) {
        const beforeParams = this.getParams();
        this.opacityThreshold = threshold;
        const afterParams = this.getParams();
        this.applyAllWithUndo(beforeParams, afterParams);
    }

    // NEW: drag grouping
    begin(kind: 'scale' | 'opacity') {
        const ctx = this.getSplatAndState();
        if (!ctx) return;

        // If a previous drag didn't commit properly, auto-commit it
        if (this.pending) {
            this.commit(this.pending.kind);
        }

        const { state } = ctx;
        this.pending = {
            kind,
            beforeState: new Uint8Array(state),
            beforeParams: this.getParams()
        };
    }

    previewScale(minScale: number, maxScale: number) {
        this.minScale = minScale;
        this.maxScale = maxScale;
        this.applyPreviewOnly();
    }

    previewOpacity(threshold: number) {
        this.opacityThreshold = threshold;
        this.applyPreviewOnly();
    }

    commit(kind: 'scale' | 'opacity') {
        const ctx = this.getSplatAndState();
        if (!ctx) return;

        // If no pending, treat commit as a normal single-shot (still 1 undo)
        if (!this.pending || this.pending.kind !== kind) {
            const beforeParams = this.getParams();
            // state already previewed, but we want deterministic behavior:
            // capture before as current and push a no-op? Better: do normal apply once.
            const beforeState = new Uint8Array(ctx.state);
            this.applyPreviewOnly(); // ensure state matches current params
            const afterState = new Uint8Array(ctx.state);
            const afterParams = this.getParams();
            this.pushUndoOp(ctx.splat, ctx.state, beforeState, afterState, beforeParams, afterParams);
            return;
        }

        // Ensure final state matches current params
        this.applyPreviewOnly();

        const afterState = new Uint8Array(ctx.state);
        const afterParams = this.getParams();

        this.pushUndoOp(ctx.splat, ctx.state, this.pending.beforeState, afterState, this.pending.beforeParams, afterParams);

        this.pending = null;
    }

    resetBaseline() {
        this.baselineState = null;
    }

    private getParams(): ScaleParams {
        return { minScale: this.minScale, maxScale: this.maxScale, threshold: this.opacityThreshold };
    }

    private getSplatAndState(): { splat: any; sd: any; state: Uint8Array; n: number } | null {
        const splats = this.scene.getElementsByType(ElementType.splat);
        if (!splats || splats.length === 0) return null;

        const splat: any = splats[0];
        const sd: any = splat.splatData;
        if (!sd || typeof sd.getProp !== 'function') return null;

        let state: Uint8Array | undefined = sd.getProp('state');
        if (!state) {
            const n0 = sd.numSplats ?? splat.numSplats ?? 0;
            state = new Uint8Array(n0);
            if (typeof sd.addProp === 'function') sd.addProp('state', state);
            else sd.state = state;
        }

        const n = sd.numSplats ?? state.length;
        return { splat, sd, state, n };
    }

    private applyBytesAndRefresh(splat: any, state: Uint8Array, bytes: Uint8Array) {
        state.set(bytes);
        if (typeof splat.updateState === 'function') splat.updateState(State.deleted);
        else if (typeof splat.rebuildMaterial === 'function') splat.rebuildMaterial();
    }

    private setParamsAndNotifyUI(p: ScaleParams) {
        this.minScale = p.minScale;
        this.maxScale = p.maxScale;
        this.opacityThreshold = p.threshold;

        // UI-only: slider should update without re-firing filter events
        this.events.fire('filter.scale.uiSet', p);
    }

    private pushUndoOp(
        splat: any,
        state: Uint8Array,
        beforeState: Uint8Array,
        afterState: Uint8Array,
        beforeParams: ScaleParams,
        afterParams: ScaleParams
    ) {
        const op: AnyEditOp = {
            label: `Scale(min=${afterParams.minScale.toFixed(2)}, max=${afterParams.maxScale.toFixed(2)}, thr=${afterParams.threshold.toFixed(2)})`,
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

        // suppressOp=true because we already applied "afterState" by the time we push
        this.events.fire('edit.add', op, true);
    }

    // Preview only: apply current params, but DO NOT push undo
    private applyPreviewOnly() {
        const ctx = this.getSplatAndState();
        if (!ctx) return;

        const { splat, sd, state, n } = ctx;

        // Baseline snapshot captured once; preview is non-cumulative
        if (!this.baselineState) this.baselineState = new Uint8Array(state);
        state.set(this.baselineState);

        const s0: Float32Array | undefined = sd.getProp('scale_0') ?? sd.getProp('scale0') ?? sd.getProp('sx');
        const s1: Float32Array | undefined = sd.getProp('scale_1') ?? sd.getProp('scale1') ?? sd.getProp('sy');
        const s2: Float32Array | undefined = sd.getProp('scale_2') ?? sd.getProp('scale2') ?? sd.getProp('sz');
        if (!s0 || !s1 || !s2) return;

        const opArr: Float32Array | undefined =
            sd.getProp('opacity') ?? sd.getProp('alpha') ?? sd.getProp('opac') ?? sd.getProp('opacity_0');

        let opacityIsLogit = false;
        if (opArr && opArr.length > 0) {
            const v = opArr[0];
            opacityIsLogit = v < 0 || v > 1;
        }

        const minS = this.minScale;
        const maxS = this.maxScale;
        const thr = this.opacityThreshold;

        for (let i = 0; i < n; i++) {
            const sLog = Math.max(s0[i], s1[i], s2[i]);
            let del = sLog < minS || sLog > maxS;

            if (!del && thr > 0 && opArr) {
                const raw = opArr[i];
                const a = opacityIsLogit ? 1 / (1 + Math.exp(-raw)) : raw;
                if (a < thr) del = true;
            }

            if (del) state[i] |= State.deleted;
        }

        if (typeof splat.updateState === 'function') splat.updateState(State.deleted);
        else if (typeof splat.rebuildMaterial === 'function') splat.rebuildMaterial();
    }

    // Single-shot path used by applyScale/applyOpacity
    private applyAllWithUndo(beforeParams: ScaleParams, afterParams: ScaleParams) {
        const ctx = this.getSplatAndState();
        if (!ctx) return;

        const beforeState = new Uint8Array(ctx.state);
        this.applyPreviewOnly();
        const afterState = new Uint8Array(ctx.state);

        this.pushUndoOp(ctx.splat, ctx.state, beforeState, afterState, beforeParams, afterParams);
    }
}
