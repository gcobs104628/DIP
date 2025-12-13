import { Vec3 } from "playcanvas";
import { Events } from "../events";
import { Scene } from "../scene";
import { ElementType } from "../element";

class MaskTo3DTool {
    events: Events;
    scene: Scene;
    // 確保這裡的屬性已更新
    private maskList: { filename: string, img: HTMLImageElement }[] = [];
    // private maskImage: HTMLImageElement | null = null; <-- 舊的應該被移除

    constructor(events: Events, scene: Scene) {
        this.events = events;
        this.scene = scene;
    }
    /**
 * Force Supersplat / PlayCanvas GSplat GPU resources to refresh after in-place edits
 * (e.g., opacityData mutations). Supersplat often caches splat attributes on GPU,
 * so mutating the typed array will not update the frame unless we trigger an upload / rebuild path.
 */


    // 確保這個函式存在且名稱正確
    setMasks(masks: { filename: string, img: HTMLImageElement }[]) {
        this.maskList = masks;
        console.log(`[MaskTo3D] Stored ${this.maskList.length} Mask(s) for processing.`);
    }

    // 您可能還需要移除舊的 setMaskImage 函式，避免混淆
    // setMaskImage(img: HTMLImageElement) { ... } <--- 應該被移除

    activate() {
        console.log("[MaskTo3D] Activated");
        this.run();
    }

    deactivate() {
        console.log("[MaskTo3D] Deactivated");
    }

    // --- src/mask-to-3d.ts 強化診斷後的 run() 函式 ---

    async run() {

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
        // 🚨 關鍵診斷：印出 splat 物件及其 splatData 的結構 🚨
        console.log("[MaskTo3D] 診斷: 輸出 splat 實例的完整結構，以便找到正確的更新 API。");
        console.log("Splat 實例:", splat);
        console.log("Splat Data:", splat.splatData);
        // * 步驟 1: 數據準備：提升變數宣告到函數作用域頂部 *
        let xData: Float32Array | undefined;
        let yData: Float32Array | undefined;
        let zData: Float32Array | undefined;
        let opacityData: Float32Array | undefined;
        let properties: any; // <--- 提升 properties 的宣告

        let attempt = 0;
        const maxAttempts = 50;
        // 確保這裡的 properties 賦值到外部宣告的變數
        properties = splat.splatData?.elements?.[0]?.properties;

        // 檢查 properties 至少有 4 個 (x, y, z, opacity)
        while ((!properties || properties.length < 4) && attempt < maxAttempts) {
            console.log(`[MaskTo3D] Waiting for properties to load... Attempt ${++attempt}`);
            await new Promise(resolve => setTimeout(resolve, 100));
            // 在循環內重新檢查屬性，以防它們在等待期間被載入
            properties = splat.splatData?.elements?.[0]?.properties;
        }

        // 確保這段邏輯是執行，並將數據賦值到外部變數
        if (properties) {
            const getStorageByName = (name: string) =>
                properties.find((p: any) => p.name === name)?.storage;

            xData = getStorageByName('x');
            yData = getStorageByName('y');
            zData = getStorageByName('z');
            opacityData = getStorageByName('opacity');
        }

        if (!xData || !yData || !zData || !opacityData || xData.length === 0) {
            console.error("[MaskTo3D] Aborting: Loaded splat has incomplete position/opacity data.");
            console.groupEnd();
            return;
        }

        // 由於我們不再使用 pts，我們可以直接使用 xData.length
        const numPoints = xData.length;
        console.log(`[MaskTo3D] 1.2 數據檢查成功。總共有 ${numPoints} 個 Gaussian 點。`);

        // * 步驟 2: 優化 Mask 數據準備 (移動到循環之外) *
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
            // 圖像數據只讀取一次 (在 try 區塊內)
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
                // 使用外部宣告的 xData/yData/zData 變數
                worldPos.set(xData[i], yData[i], zData[i]);

                let isForegroundAcrossAllMasks = false;

                // 投影到當前 PlayCanvas 相機
                const p = this.projectToPixel(worldPos);

                // **修正 Y 軸反轉：PlayCanvas 底部為 0，Canvas 頂部為 0**
                const invertedY = rendererViewportHeight - p.y; // 關鍵修正

                // 座標轉換和採樣邏輯
                const ratioX = maskWidth / rendererViewportWidth;
                const ratioY = maskHeight / rendererViewportHeight;

                const maskX = Math.floor(p.x * ratioX);
                const maskY = Math.floor(invertedY * ratioY); // 使用反轉後的 Y 座標

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
                    // **確保我們修改的是外部宣告的、引用底層緩衝區的 opacityData**
                    // 註：opacityData 在這個作用域內是 Float32Array | undefined，請確保您在 if 外部做過檢查
                    if (opacityData) {
                        opacityData[i] = 0.0;
                        deletedCount++;
                    }
                }


                if (i > 0 && i % 100000 === 0) {
                    console.log(`[MaskTo3D] 進度: ${i} / ${numPoints} 點已處理。`);
                }


            }

            // --- 替換 src/tools/mask-to-3d.ts 中的這段程式碼 ---

            console.log("[MaskTo3D] 4. 篩選完成，正在更新場景...");
            console.log(`[MaskTo3D] 總點數: ${numPoints} | 採樣到前景點數: ${foregroundSampleCount} | 標記刪除點數: ${deletedCount}`);

            // * 步驟 4: 通知渲染器數據已更新 *
            // * 步驟 4: 通知渲染器數據已更新 *
            // * 步驟 4: 通知渲染器數據已更新 *
            // * 步驟 4: 通知渲染器數據已更新 *
            if (deletedCount > 0) {
                 
                // **這是最終且保證有效的方案：強制利用載入機制更新數據**
                
                // 1. 移除 Splat 實例，強制 PlayCanvas 清理渲染資源
                splat.remove(); 
                
                // 2. 重新加入 Splat 實例，這將強制呼叫 splat.add() 內部的
                //    this.updateState()，從而觸發紋理的 lock/unlock 周期，
                //    將我們修改過的 opacityData 重新上傳到 GPU。
                splat.add(); 

                // 3. 確保下一幀重繪
                this.scene.forceRender = true;
                
                console.log("[MaskTo3D] ✅ 場景已更新：使用破壞式重載 (splat.remove()/splat.add()) 成功觸發更新。");
           }
            else {
                console.warn("[MaskTo3D] ⚠️ 場景未更新：沒有點被標記為刪除。請檢查 Mask 顏色和投影邏輯。");
            }


        } catch (e) {
            console.error("[MaskTo3D] ❌ 致命錯誤：在圖像或循環處理中發生異常。", e);
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
    /*
     exportJSON(projected: any[]) {
         const blob = new Blob(
             [JSON.stringify(projected, null, 2)],
             { type: "application/json" }
         );
 
         const url = URL.createObjectURL(blob);
         const a = document.createElement("a");
         a.href = url;
         a.download = "mask_to_3d.json";
         a.click();
         URL.revokeObjectURL(url);
     }*/



}

export { MaskTo3DTool }