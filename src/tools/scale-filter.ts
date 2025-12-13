import { Events } from '../events';
import { Scene } from '../scene';
import { ElementType } from '../element';
import { State } from '../splat-state';

export class ScaleFilterTool {
    private events: Events;
    private scene: Scene;

    // Baseline snapshot so slider changes are reversible (no cumulative deletion)
    private baselineState: Uint8Array | null = null;

    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;
    }

    /**
     * Apply scale filter in log-scale domain.
     * minScale/maxScale should match scale_0/1/2 range (typically negative values).
     */
    apply(minScale: number, maxScale: number) {
        const splats = this.scene.getElementsByType(ElementType.splat);
        if (!splats || splats.length === 0) {
            console.warn('[ScaleFilter] No splat found.');
            return;
        }

        const splat: any = splats[0];
        const sd: any = splat.splatData;
        if (!sd || typeof sd.getProp !== 'function') {
            console.error('[ScaleFilter] splat.splatData.getProp not available.');
            return;
        }

        // In many Supersplat/PlayCanvas pipelines, scales are stored as log(scale)
        const s0: Float32Array | undefined =
            sd.getProp('scale_0') ?? sd.getProp('scale0') ?? sd.getProp('sx');
        const s1: Float32Array | undefined =
            sd.getProp('scale_1') ?? sd.getProp('scale1') ?? sd.getProp('sy');
        const s2: Float32Array | undefined =
            sd.getProp('scale_2') ?? sd.getProp('scale2') ?? sd.getProp('sz');

        if (!s0 || !s1 || !s2) {
            console.error('[ScaleFilter] Missing scale props (scale_0/1/2). Available keys:', Object.keys(sd));
            return;
        }

        // State prop may not exist initially; create it if needed
        let state: Uint8Array | undefined = sd.getProp('state');
        if (!state) {
            const n = sd.numSplats ?? splat.numSplats ?? s0.length;
            state = new Uint8Array(n);

            if (typeof sd.addProp === 'function') {
                sd.addProp('state', state);
            } else {
                // Fallback: store on object (less ideal, but prevents crash)
                sd.state = state;
            }

            console.log('[ScaleFilter] Created state prop.');
        }

        const n = sd.numSplats ?? state.length;

        // Capture baseline once (baseline = "current state before scale filter")
        if (!this.baselineState) {
            this.baselineState = new Uint8Array(state); // copy
        }

        // Restore baseline every time (makes slider reversible)
        state.set(this.baselineState);

        // Apply filter
        for (let i = 0; i < n; i++) {
            const sLog = Math.max(s0[i], s1[i], s2[i]);

            if (sLog < minScale || sLog > maxScale) {
                state[i] |= State.deleted;
            }
        }

        // Push to renderer / GPU
        if (typeof splat.updateState === 'function') {
            splat.updateState(State.deleted);
        } else if (typeof splat.rebuildMaterial === 'function') {
            splat.rebuildMaterial();
        } else {
            console.warn('[ScaleFilter] No updateState()/rebuildMaterial() found. Filter may not visually update.');
        }
    }

    /**
     * Reset baseline so next apply() captures a fresh snapshot.
     * Call this when you want "current state" to become the new baseline.
     */
    resetBaseline() {
        this.baselineState = null;
        console.log('[ScaleFilter] Baseline reset.');
    }
}
