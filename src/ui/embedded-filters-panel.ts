import { Container, Label, SliderInput } from '@playcanvas/pcui';
import { Events } from '../events';
import { Tooltips } from './tooltips';

class MyFancySliderInput extends SliderInput {
    _onSlideStart(pageX: number) {
        // @ts-ignore
        super._onSlideStart(pageX);
        this.emit('slide:start');
    }

    _onSlideEnd(pageX: number) {
        // @ts-ignore
        super._onSlideEnd(pageX);
        this.emit('slide:end');
    }
}

class EmbeddedFiltersPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args: any = {}) {
        args = {
            ...args,
            id: 'embedded-filters-panel',
            class: 'panel',
            hidden: true
        };
        super(args);

        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        (this.dom as HTMLElement).style.position = 'absolute';
        (this.dom as HTMLElement).style.right = '56px';
        (this.dom as HTMLElement).style.top = '120px';

        const header = new Container({ class: 'panel-header' });

        const icon = new Label({
            class: 'panel-header-icon',
            text: '\uE19E'
        });

        const label = new Label({
            class: 'panel-header-label',
            text: 'Embedded Filters'
        });

        header.append(icon);
        header.append(label);

        // UI suppress flag to avoid feedback loops when Undo/Redo updates sliders
        let suppress = false;
        let scaleSliding = false;
        let opacitySliding = false;

        // ------- Scale (min/max) -------
        const scaleMinRow = new Container({ class: 'color-panel-row' });
        const scaleMinLabel = new Label({ class: 'color-panel-row-label', text: 'Min Scale' });
        const scaleMinSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: -12,
            max: 2,
            step: 0.01,
            value: -12
        });
        scaleMinRow.append(scaleMinLabel);
        scaleMinRow.append(scaleMinSlider);

        const scaleMaxRow = new Container({ class: 'color-panel-row' });
        const scaleMaxLabel = new Label({ class: 'color-panel-row-label', text: 'Max Scale' });
        const scaleMaxSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: -12,
            max: 2,
            step: 0.01,
            value: 2
        });
        scaleMaxRow.append(scaleMaxLabel);
        scaleMaxRow.append(scaleMaxSlider);

        const emitScale = () => {
            if (suppress) return;

            let minScale = scaleMinSlider.value;
            let maxScale = scaleMaxSlider.value;

            if (minScale > maxScale) {
                suppress = true;
                scaleMaxSlider.value = minScale;
                suppress = false;
                maxScale = minScale;
            }

            if (scaleSliding) {
                events.fire('filter.scale.preview', { minScale, maxScale });
            } else {
                // non-drag change (e.g., click or keyboard) -> commit immediately (1 undo)
                events.fire('filter.scale', { minScale, maxScale });
            }
        };


        scaleMinSlider.on('change', emitScale);
        scaleMaxSlider.on('change', emitScale);
        // NEW: group one drag into a single undo
        const onScaleStart = () => {
            if (suppress) return;
            scaleSliding = true;
            events.fire('filter.scale.begin');
        };

        const onScaleEnd = () => {
            if (suppress) return;
            scaleSliding = false;
            events.fire('filter.scale.commit');
        };

        // Hook start/end on both sliders
        (scaleMinSlider as any).on('slide:start', onScaleStart);
        (scaleMaxSlider as any).on('slide:start', onScaleStart);
        (scaleMinSlider as any).on('slide:end', onScaleEnd);
        (scaleMaxSlider as any).on('slide:end', onScaleEnd);

        // ------- Opacity Threshold -------
        const opacityRow = new Container({ class: 'color-panel-row' });
        const opacityLabel = new Label({ class: 'color-panel-row-label', text: 'Opacity Threshold' });

        const opacitySlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 0,
            max: 1,
            step: 0.01,
            value: 0
        });

        opacityRow.append(opacityLabel);
        opacityRow.append(opacitySlider);

        const emitOpacity = () => {
            if (suppress) return;
            const threshold = opacitySlider.value;
        
            if (opacitySliding) {
                events.fire('filter.opacity.preview', { threshold });
            } else {
                events.fire('filter.opacity', { threshold });
            }
        };
        

        opacitySlider.on('change', emitOpacity);
        const onOpacityStart = () => {
            if (suppress) return;
            opacitySliding = true;
            events.fire('filter.opacity.begin');
        };
        
        const onOpacityEnd = () => {
            if (suppress) return;
            opacitySliding = false;
            events.fire('filter.opacity.commit');
        };
        
        (opacitySlider as any).on('slide:start', onOpacityStart);
        (opacitySlider as any).on('slide:end', onOpacityEnd);
        
        // ------- Outliers (KNN / Distance) -------
        const knnKRow = new Container({ class: 'color-panel-row' });
        const knnKLabel = new Label({ class: 'color-panel-row-label', text: 'KNN k' });
        const knnKSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 1,
            max: 64,
            step: 1,
            value: 8
        });
        knnKRow.append(knnKLabel);
        knnKRow.append(knnKSlider);

        const knnTRow = new Container({ class: 'color-panel-row' });
        const knnTLabel = new Label({ class: 'color-panel-row-label', text: 'Outlier Radius' });
        const knnTSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 0,
            max: 1,
            step: 0.001,
            value: 0.05
        });
        knnTRow.append(knnTLabel);
        knnTRow.append(knnTSlider);

        const runKnn = new Label({
            class: 'panel-header-button',
            text: 'Run'
        });
        tooltips.register(runKnn, 'Run KNN outlier filter', 'bottom');

        runKnn.on('click', () => {
            const k = Math.round(knnKSlider.value);
            const threshold = knnTSlider.value;
            events.fire('filter.knnOutlier', { k, threshold });
        });

        // ------- Control row (reset) -------
        const controlRow = new Container({ class: 'color-panel-control-row' });

        const reset = new Label({
            class: 'panel-header-button',
            text: '\uE304'
        });

        controlRow.append(new Label({ class: 'panel-header-spacer' }));
        controlRow.append(reset);
        controlRow.append(runKnn);
        controlRow.append(new Label({ class: 'panel-header-spacer' }));

        reset.on('click', () => {
            suppress = true;
            scaleMinSlider.value = -12;
            scaleMaxSlider.value = 2;
            opacitySlider.value = 0;
            knnKSlider.value = 8;
            knnTSlider.value = 0.05;
            suppress = false;

            events.fire('filter.knnOutlier.reset');
            events.fire('filter.scale', { minScale: -12, maxScale: 2 });
            events.fire('filter.opacity', { threshold: 0 });
        });

        tooltips.register(reset, 'Reset filters', 'bottom');

        // mount
        this.append(header);
        this.append(scaleMinRow);
        this.append(scaleMaxRow);
        this.append(opacityRow);
        this.append(knnKRow);
        this.append(knnTRow);
        this.append(new Label({ class: 'panel-header-spacer' }));
        this.append(controlRow);

        // ------- UI sync from Undo/Redo -------
        events.on('filter.scale.uiSet', (p: { minScale: number; maxScale: number; threshold: number }) => {
            suppress = true;
            scaleMinSlider.value = p.minScale;
            scaleMaxSlider.value = p.maxScale;
            opacitySlider.value = p.threshold;
            suppress = false;
        });

        events.on('filter.knnOutlier.uiSet', (p: { k: number; threshold: number }) => {
            suppress = true;
            knnKSlider.value = p.k;
            knnTSlider.value = p.threshold;
            suppress = false;
        });

        // ------- visibility -------
        const setVisible = (visible: boolean) => {
            if (visible === this.hidden) {
                this.hidden = !visible;
                events.fire('filtersPanel.visible', visible);
            }
        };

        events.function('filtersPanel.visible', () => !this.hidden);

        events.on('filtersPanel.setVisible', (visible: boolean) => setVisible(visible));
        events.on('filtersPanel.toggleVisible', () => setVisible(this.hidden));

        events.on('viewPanel.visible', (visible: boolean) => {
            if (visible) setVisible(false);
        });
        events.on('colorPanel.visible', (visible: boolean) => {
            if (visible) setVisible(false);
        });
    }
}

export { EmbeddedFiltersPanel };
