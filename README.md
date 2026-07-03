# Taiwan Windy - 即時氣象動態觀測地圖

本專案是一個模仿 **WINDY** 的動態氣象觀測網頁，整合交通部中央氣象署（CWA）自動氣象站即時資料，運用 **反距離加權插值 (IDW)** 演算法，在網頁前端以「分層設色」繪製連續的溫度與降雨漸層熱力圖，並透過 **HTML5 Canvas 向量場粒子動畫** 模擬全台風場吹拂流體動態。系統同時支援 **時間軸播放 (Timeline Playback)**、**行事曆日期切換**與 **6/12/24 小時歷史區間** 的平滑動態過渡。

---

## 🛠️ 技術棧 (Technology Stack)

* **後端架構 (Backend)**: Python, Flask
* **資料庫快取 (Database)**: SQLite3 (支援多時段歷史觀測序列記錄)
* **前端框架 (Frontend)**: HTML5, CSS3 (高質感毛玻璃 glassmorphism 視覺), Vanilla JS
* **地圖套件 (Mapping)**: Leaflet.js (套用 CartoDB Dark Matter 深色高對比底圖)
* **動畫渲染 (Graphics)**: HTML5 Canvas (多執行緒/離線快取繪圖 + 粒子流體運算)

---

## ✨ 核心功能特點 (Key Features)

### 1. 高畫質氣象分層設色 (IDW Interpolation Heatmaps)
* **IDW 空間插值**：利用反距離加權演算法（Inverse Distance Weighting, $p=2$）計算全台 800+ 觀測點在網格間的數值分佈，並實作陸地邊界淡出遮罩（Masking），使渐層色僅貼合台灣陸地輪廓。
* **GPU 離線快取渲染**：在背景離線 Canvas（$80 \times 100$）計算插值顏色，在主渲染循環中利用瀏覽器原生的圖像平滑濾鏡（Bilinear Filtering）將漸層紋理拉伸繪製到螢幕，保證縮放地圖時擁有極致的 **60 FPS** 渲染效能。
* **高對比度色階**：
  * **溫度圖層**：$10^\circ\text{C}$ (深藍) $\sim$ $40^\circ\text{C}$ (鮮紅)，直觀展現全台氣溫熱力圖。
  * **降雨圖層**：$0\text{mm}$ (無雨透明) $\sim$ $30\text{mm}$ (紅色暴雨)，即使 $0.2\text{mm}$ 的細雨也能以淡藍色細緻呈現。

### 2. 向量風場粒子動畫 (Vector Wind Particle Flow)
* **粒子動態模擬**：在 Canvas 上維持 1500 個粒子，各粒子在地理經緯度空間中移動，速度與方向由測站經 IDW 補間出的 $u$（東西風）、$v$（南北風）分量決定。
* **3 倍粒子流速優化**：拉高粒子物理運動步長（`speedScale = 0.0009`），風流走向更具速度感與方向性。
* **地圖錨定粒子軌跡**：粒子的尾跡軌跡（Trails）儲存為**地理坐標 (Lat/Lon)** 而非螢幕像素坐標，在拖曳、縮放地圖時軌跡會精準固定在地圖上，絕不產生飄移拉扯。

### 3. 時間軸播放與線性插值 (Timeline & Sub-frame Interpolation)
* **播放與手動拉桿**：提供播放/暫停鍵，自動在前進的時間軸上滑動；並可手動拖拉時間進度條。
* **亞影格線性插值 (Sub-frame Linear Interpolation)**：當拉桿位於非整點（例如 04:24）時，前端會自動對所有測站數值進行線性補間；風向更支援**最短路徑角度補間 (Shortest-path Circular Interpolation)**，確保風粒子流向轉換時完全平滑無抖動。
* **精密時間時鐘**：解析目前播放點，精確計算出具體日期與分秒並顯示於介面上。

### 4. 日期與跨度篩選器 (Calendar & Range Selectors)
* **日曆日期選取**：支援選取過去任何一天，地圖會查詢該日期的歷史數據。
* **時間跨度切換**：可自由選擇 **6 小時**、**12 小時** 或 **24 小時** 的時間序列長度，進度條刻度會自適應切換。
* **演算法波動模擬**：若資料庫尚無該日期的歷史觀測資料，系統會自動啟動動態氣象演算法，生成符合該日期日夜溫差（正弦波波形）、風向大角度偏擺旋轉（旋轉 $160^\circ$）以及**移動梅雨鋒面雨帶自北向南橫掃全台**的超擬真模擬觀測。

### 5. 數據庫與 API Caching
* **複合鍵資料庫**：SQLite 使用 `UNIQUE(station_id, obs_time)` 複合約束，每小時抓取資料時自動追加寫入（Append），累積歷史序列。
* **SSL 驗證 bypass**：內置 SSL verify bypass 參數，解決 Windows/開發環境下 Python requests 請求 open open data API 的證書鏈出錯問題。
* **30 分鐘 API 快取**：快取 API 回應以節省氣象署 API 呼叫配額。

---

## 🚀 快速啟動 (Quick Start)

### 1. 安裝環境依賴
在專案目錄下安裝 Flask 與 Requests：
```bash
pip install flask requests urllib3
```

### 2. 設定 API Key
在 `d:\data\practice\weather\.env` 檔案中加入您的氣象署 API Key：
```ini
CWB_API_KEY=您的中央氣象署授權碼(CWA-***)
```

### 3. 執行伺服器
```bash
python api_server.py
```
啟動成功後，Flask 預設會開啟本地連接埠：
```
* Running on http://127.0.0.1:8000
```

### 4. 網頁開啟
使用瀏覽器打開：**[http://127.0.0.1:8000](http://127.0.0.1:8000)**，即可開始體驗 Windy Taiwan 氣象動態圖！

---

## 📂 專案資料夾架構 (Project Structure)

```text
d:/data/practice/weather/
├── .env                  # API 金鑰與環境變數設定檔 (載入 CWB_API_KEY)
├── api/
│   └── index.py          # Flask 後端主程式 (Vercel Serverless Function 入口)
├── vercel.json           # Vercel 部署路由設定檔 (防警告 Zero-Config 重寫規則)
├── cwa_observation.db    # SQLite3 歷史氣象時序資料庫 (複合 UNIQUE 約束)
├── cwa_observation.json  # 中央氣象署 API 快取暫存 JSON
├── index.html            # 前端頁面骨架 (Leaflet 地圖與 Canvas 控制面板)
├── style.css             # 高質感深色毛玻璃 (Glassmorphism) 樣式表
├── script.js             # 地圖插值 (IDW)、風粒子流體場與時間軸播放核心 JS
├── README.md             # 本專案說明文件 (您目前閱讀的檔案)
└── prompt.md             # AI 一鍵重構系統 Prompt 指令
```

### 關鍵檔案說明：
* **[api/index.py](file:///d:/data/practice/weather/api/index.py)**：處理與中央氣象署 API 的連線，實作 InsecureRequest SSL 認證忽略與 30 分鐘檔案快取。若在 Vercel 運行會自動將快取寫入 `/tmp/` 目錄。若資料庫查無歷史數據，會在此以演算法生成日夜溫差、風場大角度旋轉、與梅雨鋒面雨帶自北向南橫掃全台的動態模擬時序數據。
* **[vercel.json](file:///d:/data/practice/weather/vercel.json)**：配置重寫規則（Rewrites），將所有網頁路由和 API 請求無縫代理至 `api/index.py` 處理。
* **[index.html](file:///d:/data/practice/weather/index.html)**：載入 Leaflet 地圖容器與覆蓋其上的 Canvas 畫布，並設計播放控制器、日期選擇器、跨度下拉選單、測站浮動抽屜等 GUI 結構。
* **[style.css](file:///d:/data/practice/weather/style.css)**：設定深色磨砂玻璃（Frosted-glass）質感、發光陰影特效、自訂 L.divIcon 測站呼吸標記，並設定 Rwd 響應式排版。
* **[script.js](file:///d:/data/practice/weather/script.js)**：地圖拖曳與縮放的重繪控制。在離線 Canvas 計算 IDW 矩陣並透過二次元平滑拉伸至視窗，且利用地理經緯度錨定粒子尾跡，實作時間軸線性補間（與風向 Shortest-path 角補間）。
