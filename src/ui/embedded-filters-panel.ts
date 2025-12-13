import { Container, Label, SliderInput } from '@playcanvas/pcui';
import { Events } from '../events';
import { Tooltips } from './tooltips';

// pcui SliderInput 沒有 slide start/end，但我們這裡其實只用 change 也行。
// 先保留跟 color-panel.ts 一樣的寫法，未來你要做 undo/redo grouping 會比較方便。
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

        // stop pointer events bubbling (跟 ColorPanel 一樣，避免你在拖拉時相機也被拖到)
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // 如果你的 CSS 沒有針對 #embedded-filters-panel 定位，
        // 這裡先用 inline style 讓它出現在右側工具列旁（你覺得不對再調）
        (this.dom as HTMLElement).style.position = 'absolute';
        (this.dom as HTMLElement).style.right = '56px';
        (this.dom as HTMLElement).style.top = '120px';

        // header
        const header = new Container({ class: 'panel-header' });

        const icon = new Label({
            class: 'panel-header-icon',
            // 這個字元只是佔位，想換成更像「濾鏡」的 icon 之後再換
            text: '\uE19E'
        });

        const label = new Label({
            class: 'panel-header-label',
            text: 'Embedded Filters'
        });

        header.append(icon);
        header.append(label);

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
            let minScale = scaleMinSlider.value;
            let maxScale = scaleMaxSlider.value;

            if (minScale > maxScale) {
                maxScale = minScale;
                scaleMaxSlider.value = maxScale;
            }

            events.fire('filter.scale', { minScale, maxScale });
        };

        scaleMinSlider.on('change', emitScale);
        scaleMaxSlider.on('change', emitScale);

        // ------- Opacity Threshold -------
        const opacityRow = new Container({ class: 'color-panel-row' });
        const opacityLabel = new Label({ class: 'color-panel-row-label', text: 'Opacity Threshold' });

        // 這裡先用 0~1。若你實際的 opacity 是別的範圍（例如 log 或 0~255），再改 slider 範圍即可。
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
            const threshold = opacitySlider.value;
            events.fire('filter.opacity', { threshold });
        };

        opacitySlider.on('change', emitOpacity);
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

        // Run button (button-run, not live)
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
            text: '\uE304' // 跟 ColorPanel 一樣的 reset icon
        });

        controlRow.append(new Label({ class: 'panel-header-spacer' }));
        controlRow.append(reset);

        controlRow.append(runKnn);

        controlRow.append(new Label({ class: 'panel-header-spacer' }));

        reset.on('click', () => {
            scaleMinSlider.value = -12;
            scaleMaxSlider.value = 2;
            opacitySlider.value = 0;
            knnKSlider.value = 8;
            knnTSlider.value = 0.05;
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

        // ------- visibility (照 ColorPanel 寫法) -------
        const setVisible = (visible: boolean) => {
            if (visible === this.hidden) {
                this.hidden = !visible;
                events.fire('filtersPanel.visible', visible);
            }
        };

        events.function('filtersPanel.visible', () => !this.hidden);

        events.on('filtersPanel.setVisible', (visible: boolean) => setVisible(visible));
        events.on('filtersPanel.toggleVisible', () => setVisible(this.hidden));

        // 互斥：打開 view 或 colors，就把 filters 關掉
        events.on('viewPanel.visible', (visible: boolean) => {
            if (visible) setVisible(false);
        });
        events.on('colorPanel.visible', (visible: boolean) => {
            if (visible) setVisible(false);
        });
    }
}

export { EmbeddedFiltersPanel };
