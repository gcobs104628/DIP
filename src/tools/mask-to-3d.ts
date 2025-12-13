import { Vec3, Mat4 } from "playcanvas"; // 👈 新增 Mat4 導入
import { Events } from "../events";
import { Scene } from "../scene";
import { ElementType } from "../element";
import { State } from "../splat-state"; // 👈 導入 State

class MaskTo3DTool {
    events: Events;
    scene: Scene;
    private maskList: { filename: string, img: HTMLImageElement }[] = [];
    private hasMask = false;
    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;
    }

    setMasks(masks: { filename: string; img: HTMLImageElement }[]) {
        this.maskList = masks;
        this.hasMask = masks.length > 0;
        console.log(`[MaskTo3D] Stored ${this.maskList.length} Mask(s) for processing.`);
    }

    activate() {
        console.log("[MaskTo3D] Activated");
        this.run();
    }

    deactivate() {
        console.log("[MaskTo3D] Deactivated");
    }

    async run() {
        if (!this.hasMask || this.maskList.length === 0) {
            console.log("[MaskTo3D] No mask, skip apply.");
            return;
        }

        console.group("[MaskTo3D] Apply mask");
        console.groupCollapsed("[MaskTo3D] 🚀 核心處理開始 (點擊展開看詳細步驟)");
        console.log("[MaskTo3D] 1. 檢查場景與 Mask 數據...");

        const splats = this.scene.getElementsByType(ElementType.splat);


        if (!splats || splats.length === 0) {
            console.error("[MaskTo3D] ❌ 步驟 1 失敗: 場景中沒有載入 Splat (.ply) 數據。");
            console.groupEnd();
            alert("No splat loaded (no .ply in scene)");
            return;
        }

        if (this.maskList.length === 0) {
            console.error("[MaskTo3D] ❌ 步驟 1 失敗: 沒有載入任何 Mask 圖片。");
            console.groupEnd();
            alert("No masks loaded.");
            return;
        }

        const splat: any = splats[0];
        // 修正 1A: 獲取 Splat 實體的世界變換矩陣，用於座標轉換
        const worldMatrix = splat.entity.getWorldTransform();

        let xData: Float32Array | undefined;
        let yData: Float32Array | undefined;
        let zData: Float32Array | undefined;
        let stateData: Uint8Array | undefined; // 處理 State 數據
        let properties: any;

        let attempt = 0;
        const maxAttempts = 50;
        properties = splat.splatData?.elements?.[0]?.properties;

        while ((!properties || properties.length < 4) && attempt < maxAttempts) {
            console.log(`[MaskTo3D] Waiting for properties to load... Attempt ${++attempt}`);
            await new Promise(resolve => setTimeout(resolve, 100));
            properties = splat.splatData?.elements?.[0]?.properties;
        }

        if (properties) {
            const getStorageByName = (name: string) =>
                properties.find((p: any) => p.name === name)?.storage;

            xData = getStorageByName('x');
            yData = getStorageByName('y');
            zData = getStorageByName('z');
            stateData = getStorageByName('state') as Uint8Array; // 獲取 State 數據
        }

        if (!xData || !yData || !zData || !stateData || xData.length === 0) {
            console.error("[MaskTo3D] Aborting: Loaded splat has incomplete position/state data.");
            console.groupEnd();
            return;
        }

        const numPoints = xData.length;
        console.log(`[MaskTo3D] 1.2 數據檢查成功。總共有 ${numPoints} 個 Gaussian 點。`);

        // ----------------------------------------------------
        // 修正 2: 重置所有 Splat 的 deleted 狀態 (解決重複運行問題)
        console.log("[MaskTo3D] 1.3 重置所有 Splat 的刪除標記...");
        let resetCount = 0;
        // 位元反轉：~State.deleted (4) 用於清除標記
        const NOT_DELETED = ~State.deleted;

        for (let i = 0; i < numPoints; i++) {
            const oldState = stateData[i];
            // 使用位元 AND 運算清除 State.deleted 標記
            stateData[i] = oldState & NOT_DELETED;

            if ((oldState & State.deleted) !== 0 && (stateData[i] & State.deleted) === 0) {
                resetCount++;
            }
        }

        if (resetCount > 0) {
            // 如果有任何狀態被重置，則需要先更新一次畫面
            splat.updateState(State.deleted);
            console.log(`[MaskTo3D] 已重置 ${resetCount} 個 Splat 的刪除標記。`);
        }
        // ----------------------------------------------------

        // * 步驟 2: 優化 Mask 數據準備 *
        const maskEntry = this.maskList[0];
        const maskImage = maskEntry.img;

        const maskWidth = maskImage.width;
        const maskHeight = maskImage.height;

        console.log(`[MaskTo3D] 2. 準備 Mask 數據。使用的 Mask 尺寸: ${maskWidth} x ${maskHeight}`);

        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = maskWidth;
        maskCanvas.height = maskHeight;
        const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

        if (!maskCtx) {
            console.error("[MaskTo3D] ❌ 步驟 2 失敗: 無法獲取 Mask Canvas 2D 上下文。");
            console.groupEnd();
            return;
        }
        maskCtx.drawImage(maskImage, 0, 0);

        try {
            const maskData = maskCtx.getImageData(0, 0, maskWidth, maskHeight).data;

            const rendererViewportWidth = this.scene.app.graphicsDevice.width;
            const rendererViewportHeight = this.scene.app.graphicsDevice.height;

            console.log(`[MaskTo3D] 2.1 渲染視窗尺寸: ${rendererViewportWidth} x ${rendererViewportHeight}`);

            let deletedCount = 0;
            let foregroundSampleCount = 0;
            const worldPos = new Vec3();

            console.log("[MaskTo3D] 3. 開始對每個 Gaussian 點進行投影和篩選...");

            // * 步驟 3: 執行核心循環 *
            for (let i = 0; i < numPoints; i++) {

                // 1. 設定局部座標
                worldPos.set(xData[i], yData[i], zData[i]);

                // 修正 1B: 將局部座標轉換為世界座標，解決旋轉和移動問題
                worldMatrix.transformPoint(worldPos, worldPos);

                let isForegroundAcrossAllMasks = false;

                // 投影到當前 PlayCanvas 相機
                const p = this.projectToPixel(worldPos);

                // 修正 Y 軸反轉
                const invertedY = rendererViewportHeight - p.y;

                // 座標轉換和採樣邏輯
                const ratioX = maskWidth / rendererViewportWidth;
                const ratioY = maskHeight / rendererViewportHeight;

                const maskX = Math.floor(p.x * ratioX);
                const maskY = Math.floor(invertedY * ratioY);

                const isVisible = p.depth > 0 && p.x >= 0 && p.x <= rendererViewportWidth && p.y >= 0 && p.y <= rendererViewportHeight;

                if (isVisible && maskX >= 0 && maskX < maskWidth && maskY >= 0 && maskY < maskHeight) {
                    const dataIndex = (maskY * maskWidth + maskX) * 4;
                    const redValue = maskData[dataIndex];

                    if (redValue > 128) {
                        isForegroundAcrossAllMasks = true;
                        foregroundSampleCount++;
                    }
                }

                const shouldDelete = !isForegroundAcrossAllMasks;
                if (shouldDelete) {
                    // 修正 3: 不改 Opacity，改為加上 State.deleted 標記
                    if (stateData) {
                        // 使用位元 OR 運算符 '|' 加上 State.deleted 的值 (4)
                        stateData[i] = stateData[i] | State.deleted;
                        deletedCount++;
                    }
                }

                if (i > 0 && i % 100000 === 0) {
                    console.log(`[MaskTo3D] 進度: ${i} / ${numPoints} 點已處理。`);
                }
            }

            console.log("[MaskTo3D] 4. 篩選完成，正在更新場景...");
            console.log(`[MaskTo3D] 總點數: ${numPoints} | 採樣到前景點數: ${foregroundSampleCount} | 標記刪除點數: ${deletedCount}`);

            // * 步驟 4: 通知渲染器數據已更新 *
            if (deletedCount > 0) {
                // 修正 3: 呼叫 SuperSplat 內建的 State 更新 API
                splat.updateState(State.deleted);

                console.log("[MaskTo3D] ✅ 場景已更新：通過修改 State 屬性成功刪除點。");
            }
            else {
                console.warn("[MaskTo3D] ⚠️ 場景未更新：沒有點被標記為刪除。請檢查 Mask 顏色和投影邏輯。");
            }


        } catch (e) {
            console.error("[MaskTo3D] ❌ 致命錯誤：在圖像或循環處理中發生異常。", e);
        } finally {
            this.maskList = [];
            this.hasMask = false;
            console.log("[MaskTo3D] Mask cleared");
        }

        console.groupEnd();
    }

    // 投影函數維持不變
    projectToPixel(worldPos: Vec3) {
        const cam = this.scene.camera.entity.camera;
        const screen = cam.worldToScreen(worldPos, new Vec3());

        return {
            x: screen.x ?? 0,
            y: screen.y ?? 0,
            depth: screen.z ?? 0
        };
    }
    // ... (其他非 run 的函式，如果它們不存在，這個替換塊中也不包含它們)
}

export { MaskTo3DTool }