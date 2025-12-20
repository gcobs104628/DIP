import { Color, createGraphicsDevice } from 'playcanvas';

import { registerCameraPosesEvents } from './camera-poses';
import { registerDocEvents } from './doc';
import { EditHistory } from './edit-history';
import { registerEditorEvents } from './editor';
import { Events } from './events';
import { initFileHandler } from './file-handler';
import { registerIframeApi } from './iframe-api';
import { registerPlySequenceEvents } from './ply-sequence';
import { registerPublishEvents } from './publish';
import { registerRenderEvents } from './render';
import { Scene } from './scene';
import { getSceneConfig } from './scene-config';
import { registerSelectionEvents } from './selection';
import { Shortcuts } from './shortcuts';
import { registerTimelineEvents } from './timeline';
import { BoxSelection } from './tools/box-selection';
import { BrushSelection } from './tools/brush-selection';
import { EyedropperSelection } from './tools/eyedropper-selection';
import { FloodSelection } from './tools/flood-selection';
import { LassoSelection } from './tools/lasso-selection';
import { MeasureTool } from './tools/measure-tool';
import { MoveTool } from './tools/move-tool';
import { PolygonSelection } from './tools/polygon-selection';
import { RectSelection } from './tools/rect-selection';
import { RotateTool } from './tools/rotate-tool';
import { ScaleTool } from './tools/scale-tool';
import { SphereSelection } from './tools/sphere-selection';
import { ToolManager } from './tools/tool-manager';
import { registerTransformHandlerEvents } from './transform-handler';
import { EditorUI } from './ui/editor';
import { localizeInit } from './ui/localization';
import { MaskTo3DTool } from './tools/mask-to-3d'; // 新增的 MaskTo3DTool
import { ScaleFilterTool } from './tools/scale-filter'; // 路徑依你放的位置調整
import { KnnOutlierFilterTool } from './tools/knn-outlier-filter';
import { CompareView } from './compare-view';




declare global {
    interface LaunchParams {
        readonly files: FileSystemFileHandle[];
    }

    interface Window {
        launchQueue: {
            setConsumer: (callback: (launchParams: LaunchParams) => void) => void;
        };
        scene: Scene;
    }
}

const getURLArgs = () => {
    // extract settings from command line in non-prod builds only
    const config = {};

    const apply = (key: string, value: string) => {
        let obj: any = config;
        key.split('.').forEach((k, i, a) => {
            if (i === a.length - 1) {
                obj[k] = value;
            } else {
                if (!obj.hasOwnProperty(k)) {
                    obj[k] = {};
                }
                obj = obj[k];
            }
        });
    };

    const params = new URLSearchParams(window.location.search.slice(1));
    params.forEach((value: string, key: string) => {
        apply(key, value);
    });

    return config;
};

const initShortcuts = (events: Events) => {
    const shortcuts = new Shortcuts(events);

    shortcuts.register(['Delete', 'Backspace'], { event: 'select.delete' });
    shortcuts.register(['Escape'], { event: 'tool.deactivate' });
    shortcuts.register(['Tab'], { event: 'selection.next' });
    shortcuts.register(['1'], { event: 'tool.move', sticky: true });
    shortcuts.register(['2'], { event: 'tool.rotate', sticky: true });
    shortcuts.register(['3'], { event: 'tool.scale', sticky: true });
    shortcuts.register(['G', 'g'], { event: 'grid.toggleVisible' });
    shortcuts.register(['C', 'c'], { event: 'tool.toggleCoordSpace' });
    shortcuts.register(['F', 'f'], { event: 'camera.focus' });
    shortcuts.register(['R', 'r'], { event: 'tool.rectSelection', sticky: true });
    shortcuts.register(['P', 'p'], { event: 'tool.polygonSelection', sticky: true });
    shortcuts.register(['L', 'l'], { event: 'tool.lassoSelection', sticky: true });
    shortcuts.register(['B', 'b'], { event: 'tool.brushSelection', sticky: true });
    shortcuts.register(['O', 'o'], { event: 'tool.floodSelection', sticky: true });
    shortcuts.register(['E', 'e'], { event: 'tool.eyedropperSelection', sticky: true });
    shortcuts.register(['A', 'a'], { event: 'select.all', ctrl: true });
    shortcuts.register(['A', 'a'], { event: 'select.none', shift: true });
    shortcuts.register(['I', 'i'], { event: 'select.invert', ctrl: true });
    shortcuts.register(['H', 'h'], { event: 'select.hide' });
    shortcuts.register(['U', 'u'], { event: 'select.unhide' });
    shortcuts.register(['['], { event: 'tool.brushSelection.smaller' });
    shortcuts.register([']'], { event: 'tool.brushSelection.bigger' });
    shortcuts.register(['Z', 'z'], { event: 'edit.undo', ctrl: true, capture: true });
    shortcuts.register(['Z', 'z'], { event: 'edit.redo', ctrl: true, shift: true, capture: true });
    shortcuts.register(['M', 'm'], { event: 'camera.toggleMode' });
    shortcuts.register(['D', 'd'], { event: 'dataPanel.toggle' });
    shortcuts.register([' '], { event: 'camera.toggleOverlay' });

    return shortcuts;
};

const main = async () => {
    // root events object
    const events = new Events();

    // url
    const url = new URL(window.location.href);

    // edit history
    const editHistory = new EditHistory(events);

    // init localization
    await localizeInit();

    // editor ui
    const editorUI = new EditorUI(events);

    // create the graphics device
    const graphicsDevice = await createGraphicsDevice(editorUI.canvas, {
        deviceTypes: ['webgl2'],
        antialias: false,
        depth: false,
        stencil: false,
        xrCompatible: false,
        powerPreference: 'high-performance'
    });

    const overrides = [
        getURLArgs()
    ];

    // resolve scene config
    const sceneConfig = getSceneConfig(overrides);

    // construct the manager
    const scene = new Scene(
        events,
        sceneConfig,
        editorUI.canvas,
        graphicsDevice
    );

    const mainCamEntity =
        (scene as any).cameraEntity ??
        (scene as any).camera?.entity ??
        (scene as any).app?.root?.findByName('Camera') ??
        (scene as any).app?.root?.findByName('camera');

    if (!mainCamEntity) {
        console.warn('[CompareView] Cannot find main camera entity on scene.');
    } else {
        // ✅ 第三個參數要傳 mainCamEntity
        const compareView = new CompareView(events, scene, mainCamEntity);

        // ✅ UI 端 fire 'compareView.toggleEnabled' / 'compareView.setEnabled' 就會進來

    }



    // colors
    const bgClr = new Color();
    const selectedClr = new Color();
    const unselectedClr = new Color();
    const lockedClr = new Color();

    const setClr = (target: Color, value: Color, event: string) => {
        if (!target.equals(value)) {
            target.copy(value);
            events.fire(event, target);
        }
    };

    const setBgClr = (clr: Color) => {
        setClr(bgClr, clr, 'bgClr');
    };
    const setSelectedClr = (clr: Color) => {
        setClr(selectedClr, clr, 'selectedClr');
    };
    const setUnselectedClr = (clr: Color) => {
        setClr(unselectedClr, clr, 'unselectedClr');
    };
    const setLockedClr = (clr: Color) => {
        setClr(lockedClr, clr, 'lockedClr');
    };

    events.on('setBgClr', (clr: Color) => {
        setBgClr(clr);
    });
    events.on('setSelectedClr', (clr: Color) => {
        setSelectedClr(clr);
    });
    events.on('setUnselectedClr', (clr: Color) => {
        setUnselectedClr(clr);
    });
    events.on('setLockedClr', (clr: Color) => {
        setLockedClr(clr);
    });

    events.function('bgClr', () => {
        return bgClr;
    });
    events.function('selectedClr', () => {
        return selectedClr;
    });
    events.function('unselectedClr', () => {
        return unselectedClr;
    });
    events.function('lockedClr', () => {
        return lockedClr;
    });

    events.on('bgClr', (clr: Color) => {
        // 原本錯誤：
        // const cnv = (v: number) => ${Math.max(0, Math.min(255, (v * 255))).toFixed(0)};

        // 修正為：確保它回傳一個字串
        const cnv = (v: number) =>
            Math.max(0, Math.min(255, (v * 255))).toFixed(0);
        // 原本錯誤：
        // document.body.style.backgroundColor = rgba(${cnv(clr.r)},${cnv(clr.g)},${cnv(clr.b)},1);

        // 修正為：使用反引號 (`) 來構造 CSS 顏色字串
        document.body.style.backgroundColor = `rgba(${cnv(clr.r)},${cnv(clr.g)},${cnv(clr.b)},1)`;
    });
    events.on('selectedClr', (clr: Color) => {
        scene.forceRender = true;
    });
    events.on('unselectedClr', (clr: Color) => {
        scene.forceRender = true;
    });
    events.on('lockedClr', (clr: Color) => {
        scene.forceRender = true;
    });

    // initialize colors from application config
    const toColor = (value: { r: number, g: number, b: number, a: number }) => {
        return new Color(value.r, value.g, value.b, value.a);
    };
    setBgClr(toColor(sceneConfig.bgClr));
    setSelectedClr(toColor(sceneConfig.selectedClr));
    setUnselectedClr(toColor(sceneConfig.unselectedClr));
    setLockedClr(toColor(sceneConfig.lockedClr));

    // create the mask selection canvas
    const maskCanvas = document.createElement('canvas');
    const maskContext = maskCanvas.getContext('2d');
    maskCanvas.setAttribute('id', 'mask-canvas');
    maskContext.globalCompositeOperation = 'copy';

    const mask = {
        canvas: maskCanvas,
        context: maskContext
    };

    // tool manager
    const toolManager = new ToolManager(events);
    toolManager.register('rectSelection', new RectSelection(events, editorUI.toolsContainer.dom));
    toolManager.register('brushSelection', new BrushSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('floodSelection', new FloodSelection(events, editorUI.toolsContainer.dom, mask, editorUI.canvasContainer));
    toolManager.register('polygonSelection', new PolygonSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('lassoSelection', new LassoSelection(events, editorUI.toolsContainer.dom, mask));
    toolManager.register('sphereSelection', new SphereSelection(events, scene, editorUI.canvasContainer));
    toolManager.register('boxSelection', new BoxSelection(events, scene, editorUI.canvasContainer));
    toolManager.register('eyedropperSelection', new EyedropperSelection(events, editorUI.toolsContainer.dom, editorUI.canvasContainer));
    toolManager.register('move', new MoveTool(events, scene));
    toolManager.register('rotate', new RotateTool(events, scene));
    toolManager.register('scale', new ScaleTool(events, scene));
    toolManager.register('measure', new MeasureTool(events, scene, editorUI.toolsContainer.dom, editorUI.canvasContainer));
    // 註冊 MaskTo3DTool
    // 實例化 MaskTo3DTool
    const maskTo3DTool = new MaskTo3DTool(events, scene);
    const scaleFilterTool = new ScaleFilterTool(events, scene);

    // 監聽 Mask 導入事件，現在它傳遞的是一個 Mask 陣列 (來自 right-toolbar.ts 的修改)
    events.on('mask.import', (masks: { filename: string, img: HTMLImageElement }[]) => {
        console.log(`[main.ts] Received 'mask.import' event. Storing ${masks.length} images.`);
        // ** 使用新的 setMasks 函式 **
        maskTo3DTool.setMasks(masks);


    });

    // 監聽 Mask-to-3D 執行事件 (這個應該已經存在且正確)
    events.on('tool.maskTo3D', () => {
        if (typeof maskTo3DTool.activate === 'function') {
            maskTo3DTool.activate(); 
        } else {
            console.error("[main.ts] 錯誤：maskTo3DTool 缺少 activate 方法");
        }
    });


    // 監聽右側滑桿事件（right-toolbar.ts fire 的那個）
    events.on('filter.scale', ({ minScale, maxScale }: { minScale: number; maxScale: number }) => {
        scaleFilterTool.applyScale(minScale, maxScale);
    });
    events.on('filter.opacity', ({ threshold }: { threshold: number }) => {
        scaleFilterTool.applyOpacity(threshold);
    });
    // --- NEW: group slider drags into a single undo ---
    events.on('filter.scale.begin', () => scaleFilterTool.begin('scale'));
    events.on('filter.scale.preview', ({ minScale, maxScale }: { minScale: number; maxScale: number }) => {
        scaleFilterTool.previewScale(minScale, maxScale);
    });
    events.on('filter.scale.commit', () => scaleFilterTool.commit('scale'));

    events.on('filter.opacity.begin', () => scaleFilterTool.begin('opacity'));
    events.on('filter.opacity.preview', ({ threshold }: { threshold: number }) => {
        scaleFilterTool.previewOpacity(threshold);
    });
    events.on('filter.opacity.commit', () => scaleFilterTool.commit('opacity'));

    const knnOutlierTool = new KnnOutlierFilterTool(events, scene);

    events.on('filter.knnOutlier', ({ k, threshold }: { k: number; threshold: number }) => {
        void knnOutlierTool.apply(k, threshold);
    });

    events.on('filter.knnOutlier.reset', () => {
        knnOutlierTool.reset();
    });

    editorUI.toolsContainer.dom.appendChild(maskCanvas);
    // * 新增：監聽 'mask.import' 事件並儲存 Mask 資料到 Tool 中 *
    // --- 新增：處理 Camera JSON 匯入的事件監聽 ---
    events.on('cameraPoses.import', (poses: any[]) => {
        maskTo3DTool.setCameraPoses(poses);
        console.log("[main.ts] 相機參數已成功傳遞至 MaskTo3D 工具");
    });

    // * 結束新增 *
    window.scene = scene;

    registerEditorEvents(events, editHistory, scene);
    registerSelectionEvents(events, scene);
    registerTimelineEvents(events);
    registerCameraPosesEvents(events);
    registerTransformHandlerEvents(events);
    registerPlySequenceEvents(events);
    registerPublishEvents(events);
    registerDocEvents(scene, events);
    registerRenderEvents(scene, events);
    registerIframeApi(events);
    initShortcuts(events);
    initFileHandler(scene, events, editorUI.appContainer.dom);

    // load async models
    scene.start();

    // handle load params
    const loadList = url.searchParams.getAll('load');
    for (const value of loadList) {
        const decoded = decodeURIComponent(value);
        await events.invoke('import', [{
            filename: decoded.split('/').pop(),
            url: decoded
        }]);
    }

    // handle OS-based file association in PWA mode
    if ('launchQueue' in window) {
        window.launchQueue.setConsumer(async (launchParams: LaunchParams) => {
            for (const file of launchParams.files) {
                await events.invoke('import', [{
                    filename: file.name,
                    contents: await file.getFile()
                }]);
            }
        });
    }
};

export { main };