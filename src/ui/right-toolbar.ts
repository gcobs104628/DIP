import { Button, Container, Element } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from './localization';
import cameraFrameSelectionSvg from './svg/camera-frame-selection.svg';
import cameraResetSvg from './svg/camera-reset.svg';
import centersSvg from './svg/centers.svg';
import colorPanelSvg from './svg/color-panel.svg';
import ringsSvg from './svg/rings.svg';
import showHideSplatsSvg from './svg/show-hide-splats.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class RightToolbar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'right-toolbar'
        };

        super(args);

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const ringsModeToggle = new Button({
            id: 'right-toolbar-mode-toggle',
            class: 'right-toolbar-toggle'
        });

        const showHideSplats = new Button({
            id: 'right-toolbar-show-hide',
            class: ['right-toolbar-toggle', 'active']
        });

        const cameraFrameSelection = new Button({
            id: 'right-toolbar-frame-selection',
            class: 'right-toolbar-button'
        });

        const cameraReset = new Button({
            id: 'right-toolbar-camera-origin',
            class: 'right-toolbar-button'
        });

        const colorPanel = new Button({
            id: 'right-toolbar-color-panel',
            class: 'right-toolbar-toggle'
        });

        const options = new Button({
            id: 'right-toolbar-options',
            class: 'right-toolbar-toggle',
            icon: 'E283'
        });

        const centersDom = createSvg(centersSvg);
        const ringsDom = createSvg(ringsSvg);
        ringsDom.style.display = 'none';

        ringsModeToggle.dom.appendChild(centersDom);
        ringsModeToggle.dom.appendChild(ringsDom);
        showHideSplats.dom.appendChild(createSvg(showHideSplatsSvg));
        cameraFrameSelection.dom.appendChild(createSvg(cameraFrameSelectionSvg));
        cameraReset.dom.appendChild(createSvg(cameraResetSvg));
        colorPanel.dom.appendChild(createSvg(colorPanelSvg));

        this.append(ringsModeToggle);
        this.append(showHideSplats);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(cameraFrameSelection);
        this.append(cameraReset);

        /*
        --------------------------------------------------------
        新增：Import Mask 按鈕
        --------------------------------------------------------
        */
        const importMaskBtn = new Button({
            id: 'right-toolbar-import-mask',
            class: 'right-toolbar-button'
        });
        importMaskBtn.dom.appendChild(createSvg(showHideSplatsSvg)); // 請確保這裡使用的 SVG 變數是有效的
        this.append(importMaskBtn); // * 關鍵點 A: 確保按鈕被附加到工具列 *
        tooltips.register(importMaskBtn, "Import Mask (PNG)", "left");

        importMaskBtn.on('click', () => {
            console.log("[UI-DEBUG] 1. Import Mask clicked: Starting process.");

            // 檢查點 C: 檔案對話框建立
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/png";
            input.multiple = true; // <--- 關鍵：允許選擇多個檔案
            console.log("[UI-DEBUG] 2. Input element created.");

            input.onchange = async () => {
                const files = Array.from(input.files || []); // 獲取所有選擇的檔案
                if (files.length === 0) {
                    console.log("[UI] Import Mask: No file selected.");
                    return;
                }

                console.log(`[UI] Import Mask: ${files.length} file(s) selected. Processing...`);

                const loadedMasks = [];

                for (const file of files) {
                    // 這裡的邏輯與單一檔案相同，但我們要將結果收集起來
                    const img = new Image();
                    img.src = URL.createObjectURL(file);

                    try {
                        await img.decode();
                        loadedMasks.push({
                            filename: file.name,
                            img: img
                        });
                        // 🌟 新增延遲以緩解瀏覽器資源壓力
                        await new Promise(resolve => setTimeout(resolve, 50)); // 延遲 50ms
                        // ...
                    } catch (e) {
                        console.error(`[UI] Mask Data: Failed to decode image ${file.name}.`, e);
                    } finally {
                        URL.revokeObjectURL(img.src);
                    }
                }

                if (loadedMasks.length > 0) {
                    events.fire("mask.import", loadedMasks); // <--- 核心：發射所有載入的 Mask
                    console.log(`[UI] Mask Data: Fired 'mask.import' event with ${loadedMasks.length} masks.`);
                }
            };

            // 檢查點 D: 檔案對話框彈出
            input.click();
            console.log("[UI-DEBUG] 3. Attempted to trigger file dialog.");
        });

        /*
        --------------------------------------------------------
        新增：Mask → 3D 按鈕 (已新增詳細 console log)
        --------------------------------------------------------
        */
        const maskTo3DButton = new Button({
            id: 'right-toolbar-mask-to-3d',
            class: 'right-toolbar-button'
        });
        maskTo3DButton.dom.appendChild(createSvg(ringsSvg));
        this.append(maskTo3DButton);

        tooltips.register(maskTo3DButton, "Mask → 3D Projection", "left");
        maskTo3DButton.on('click', () => {
            console.log("[UI] Mask-to-3D Clicked: Firing 'tool.maskTo3D' event.");
            events.fire("tool.maskTo3D");
        });
        // ------------------------------
        // Scale Filter UI (live update)
        // ------------------------------
        this.append(new Element({ class: 'right-toolbar-separator' }));

        const embeddedFilters = new Button({
            id: 'right-toolbar-embedded-filters',
            class: 'right-toolbar-toggle'
        });
        
        // 沒有現成 svg 的話，先用文字頂著（你之後再換成 svg）
        embeddedFilters.dom.textContent = 'Fx';
        
        this.append(embeddedFilters);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        
        tooltips.register(embeddedFilters, 'Embedded Filters', 'left');
        
        embeddedFilters.on('click', () => {
            // 開關 panel
            events.fire('filtersPanel.toggleVisible');
        
            // 可選：打開 filters 時把 colors/view 關掉（不想互斥就刪掉）
            events.fire('colorPanel.setVisible', false);
            events.fire('viewPanel.setVisible', false);
        });
        
        events.on('filtersPanel.visible', (visible: boolean) => {
            embeddedFilters.class[visible ? 'add' : 'remove']('active');
        });
        
        this.append(new Element({ class: 'right-toolbar-separator' }));

        this.append(colorPanel);
        this.append(new Element({ class: 'right-toolbar-separator' }));
        this.append(options);

        tooltips.register(ringsModeToggle, localize('tooltip.right-toolbar.splat-mode'), 'left');
        tooltips.register(showHideSplats, localize('tooltip.right-toolbar.show-hide'), 'left');
        tooltips.register(cameraFrameSelection, localize('tooltip.right-toolbar.frame-selection'), 'left');
        tooltips.register(cameraReset, localize('tooltip.right-toolbar.reset-camera'), 'left');
        tooltips.register(colorPanel, localize('tooltip.right-toolbar.colors'), 'left');
        tooltips.register(options, localize('tooltip.right-toolbar.view-options'), 'left');

        ringsModeToggle.on('click', () => {
            events.fire('camera.toggleMode');
            events.fire('camera.setOverlay', true);
        });
        showHideSplats.on('click', () => events.fire('camera.toggleOverlay'));
        cameraFrameSelection.on('click', () => events.fire('camera.focus'));
        cameraReset.on('click', () => events.fire('camera.reset'));
        colorPanel.on('click', () => events.fire('colorPanel.toggleVisible'));
        options.on('click', () => events.fire('viewPanel.toggleVisible'));

        events.on('camera.mode', (mode: string) => {
            ringsModeToggle.class[mode === 'rings' ? 'add' : 'remove']('active');
            centersDom.style.display = mode === 'rings' ? 'none' : 'block';
            ringsDom.style.display = mode === 'rings' ? 'block' : 'none';
        });

        events.on('camera.overlay', (value: boolean) => {
            showHideSplats.class[value ? 'add' : 'remove']('active');
        });

        events.on('colorPanel.visible', (visible: boolean) => {
            colorPanel.class[visible ? 'add' : 'remove']('active');
        });

        events.on('viewPanel.visible', (visible: boolean) => {
            options.class[visible ? 'add' : 'remove']('active');
        });
    }
}

export { RightToolbar };