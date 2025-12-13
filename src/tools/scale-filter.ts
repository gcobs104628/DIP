import { Events } from '../events';
import { Scene } from '../scene';
import { ElementType } from '../element';
import { State } from '../splat-state';

export class ScaleFilterTool {
    private events: Events;
    private scene: Scene;

    // Baseline snapshot so live updates are reversible
    private baselineState: Uint8Array | null = null;

    // Current filter params
    private minScale = -12;
    private maxScale = 2;
    private opacityThreshold = 0; // 0 means "no opacity filter"

    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;
    }

    /** Called by main.ts on filter.scale */
    applyScale(minScale: number, maxScale: number) {
        this.minScale = minScale;
        this.maxScale = maxScale;
        this.applyAll();
    }

    /** Called by main.ts on filter.opacity */
    applyOpacity(threshold: number) {
        this.opacityThreshold = threshold;
        this.applyAll();
    }

    /** Optional: reset baseline so next apply captures a fresh snapshot */
    resetBaseline() {
        this.baselineState = null;
        // console.log('[Filters] Baseline reset.');
    }

    private applyAll() {
        const splats = this.scene.getElementsByType(ElementType.splat);
        if (!splats || splats.length === 0) return;

        const splat: any = splats[0];
        const sd: any = splat.splatData;
        if (!sd || typeof sd.getProp !== 'function') {
            console.error('[Filters] splat.splatData.getProp not available.');
            return;
        }

        // ---- Scale props (log-scale domain) ----
        const s0: Float32Array | undefined =
            sd.getProp('scale_0') ?? sd.getProp('scale0') ?? sd.getProp('sx');
        const s1: Float32Array | undefined =
            sd.getProp('scale_1') ?? sd.getProp('scale1') ?? sd.getProp('sy');
        const s2: Float32Array | undefined =
            sd.getProp('scale_2') ?? sd.getProp('scale2') ?? sd.getProp('sz');

        if (!s0 || !s1 || !s2) {
            console.error('[Filters] Missing scale props (scale_0/1/2).');
            return;
        }

        // ---- Opacity prop (could be linear [0,1] or logit) ----
        const op: Float32Array | undefined =
            sd.getProp('opacity') ??
            sd.getProp('alpha') ??
            sd.getProp('opac') ??
            sd.getProp('opacity_0');

        // ---- State (create if not present) ----
        let state: Uint8Array | undefined = sd.getProp('state');
        if (!state) {
            const n = sd.numSplats ?? splat.numSplats ?? s0.length;
            state = new Uint8Array(n);
            if (typeof sd.addProp === 'function') sd.addProp('state', state);
            else sd.state = state;
        }

        const n = sd.numSplats ?? state.length;

        // Capture baseline once
        if (!this.baselineState) {
            this.baselineState = new Uint8Array(state);
        }

        // Restore baseline every time (reversible)
        state.set(this.baselineState);

        // Heuristic: detect opacity domain
        // If opacity values are not in [0,1], treat as logit and convert via sigmoid.
        let opacityIsLogit = false;
        if (op && op.length > 0) {
            const v = op[0];
            opacityIsLogit = (v < 0 || v > 1);
        }

        const minS = this.minScale;
        const maxS = this.maxScale;
        const thr = this.opacityThreshold;

        for (let i = 0; i < n; i++) {
            // Scale filter (log domain)
            const sLog = Math.max(s0[i], s1[i], s2[i]);
            let del = (sLog < minS || sLog > maxS);

            // Opacity filter (optional)
            if (!del && thr > 0 && op) {
                const raw = op[i];
                const a = opacityIsLogit ? (1 / (1 + Math.exp(-raw))) : raw;
                if (a < thr) del = true;
            }

            if (del) state[i] |= State.deleted;
        }

        if (typeof splat.updateState === 'function') {
            splat.updateState(State.deleted);
        } else if (typeof splat.rebuildMaterial === 'function') {
            splat.rebuildMaterial();
        }
    }
}
