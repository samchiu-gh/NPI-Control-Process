# 產品導入計劃 · 部署說明

這個資料夾裡的檔案可以直接放到 GitHub Pages 上跑，不需要 npm、不需要建置流程。
資料存在 Firebase Firestore，登入用 Firebase Authentication，只有你手動建立的帳號能登入。

檔案說明：
- `index.html` — 網頁進入點，載入 Tailwind CSS 跟 app.js
- `app.js` — 整個系統的程式邏輯（已經轉譯成瀏覽器可以直接執行的格式，不用再處理）
- `app_source.jsx` — 給我（或你自己）之後要修改功能時看的原始碼，**不是**部署會用到的檔案，但建議留著方便日後修改
- `firestore.rules` — Firestore 安全規則，要貼到 Firebase 後台

---

## 步驟一：建立 Firebase 專案

1. 前往 https://console.firebase.google.com ，用你的 Google 帳號登入
2. 點「新增專案」，名稱隨意（例如 `product-launch-tracker`），一路下一步建立完成

## 步驟二：開啟 Authentication（登入功能）

1. 左側選單點「Authentication」→「開始使用」
2. 登入方式選「電子郵件/密碼」，啟用它
3. 切到「Users」分頁，點「新增使用者」，手動輸入**你自己**要用的 email 跟密碼
   （這一步很重要：不要開放任何註冊功能，帳號只能在這裡手動建立）

## 步驟三：開啟 Firestore（資料庫）

1. 左側選單點「Firestore Database」→「建立資料庫」
2. 位置選離你近的（例如 asia-east1），模式先選「正式版模式」（production mode）
3. 建立完成後，點上方「規則」（Rules）分頁，把這個資料夾裡 `firestore.rules` 的內容整份貼上覆蓋，點「發布」

## 步驟四：取得 Firebase 設定值，貼進程式碼

1. 左側選單點「專案設定」（齒輪圖示）→ 往下捲到「你的應用程式」
2. 點網頁圖示 `</>`，應用程式暱稱隨意取，**不用**勾選 Firebase Hosting，點註冊
3. 會看到一段 `firebaseConfig = {...}` 的程式碼，把裡面 6 組值複製起來
4. 打開 `app.js`，找到最上面 `const firebaseConfig = {` 那一段（約在第 10 行左右），
   把 `YOUR_API_KEY`、`YOUR_PROJECT_ID` 等預留字串換成剛剛複製的實際值

## 步驟五：放到 GitHub Pages

1. 在 GitHub 開一個新的 repository（建議設為 Private）
2. 把這個資料夾裡的 `index.html`、`app.js`（改好 firebaseConfig 之後的版本）上傳到 repo 最上層
   （`app_source.jsx` 跟 `firestore.rules` 可以一起放，不影響網站運作，純粹留存）
3. 到 repo 的 Settings → Pages，Source 選「Deploy from a branch」，branch 選 `main`、資料夾選 `/ (root)`，儲存
4. 等 1-2 分鐘，GitHub 會給你一個網址（格式類似 `https://你的帳號.github.io/repo名稱/`），打開它

## 之後怎麼更新功能

以後想改功能，把需求告訴我，我會直接改 `app_source.jsx` 並重新產生新的 `app.js` 給你，
你只要把新的 `app.js` 上傳覆蓋到 GitHub repo 裡，GitHub Pages 會自動重新部署，通常幾十秒內生效。

---

## 已知限制（先讓你知道，不是之後才發現）

- **沒有帳號自助註冊、沒有忘記密碼流程**：要新增帳號或重設密碼，都要回 Firebase 後台手動做，這是為了避免任何形式的公開入口。
- **照片大小上限 150KB**：因為目前的儲存方式是把「所有產品」存成同一份 Firestore 文件，
  文件大小上限 1MB，多張大圖加總容易超過，所以把單張照片上限壓低。如果之後照片常常不夠用，
  要跟我說，需要把資料結構改成「一個產品一份文件」才能真正解除這個限制。
- **沒有操作紀錄／版本回溯**：資料被覆寫後沒有還原機制，跟你在 Claude 裡用的雛型一樣，這點沒有變。
