# poi-plugin-nanodesu-mcp

一個 [poi](https://github.com/poooi/poi) 插件，把 poi 當下的 KanColle 遊戲狀態
以唯讀工具的形式開放給 MCP 客戶端（Claude Code，或任何說 MCP 的 agent）。
不必去撈 poi 的快取檔，也沒有過期問題：每一次呼叫讀的都是遊戲正在跑的那個
redux store。

## 功能特色

裝上之後，agent 可以回答這類問題：

- **艦隊現況**——誰大破、誰快升級、哪些艦娘鎖了、資源和入渠時間還剩多少。
- **任務**——目前接了什麼、哪些已達成待領獎；再配上完整的任務線圖，
  可以往前推「這條任務線卡在哪一關」。
- **戰鬥歷史**——什麼時候打了哪張圖、走哪條航路、拿什麼評價；
  再往下拉出單場的完整編成、裝備、改修值。
- **圖鑑查詢**——把遊戲回傳的 id 翻成艦名、裝備名、海域名。

全部唯讀：不 dispatch 任何 action、不操作遊戲 webview、不寫回任何東西。

## 核心概念

這個插件的目的是**把 poi 以及其他插件的 state 開放給 agent 查詢**，
並且**整合一部分並非 state、但同樣實用的資料**。

所以可讀的東西分成三類：

| 類別            | 例子                                                                               | 來源                  |
| ------------- | -------------------------------------------------------------------------------- | ------------------- |
| poi 自己的 state | `info.ships`、`info.quests`、`fcd.map`                                             | redux store         |
| 其他插件的 state   | `ext.poi-plugin-quest-line._.questList`、`ext.poi-plugin-battle-detail._.indexes` | redux store（允許清單控管） |
| 非 state 的實用資料 | `questline.quests`（任務線圖）、`poi_battle`（單場戰鬥記錄）                                    | 插件隨附的靜態資產、或寫在磁碟上的記錄 |

第三類是刻意納入的：有些資料對 agent 極有價值，卻從來不進 redux——任務線圖
是插件 `require()` 進模組區域變數的靜態資產，戰鬥記錄則是一場一個 gz 檔寫在
磁碟上。單靠讀 store 永遠拿不到它們，所以這個插件把它們一併整合進來，
用同一套查詢介面提供。

整合僅止於「讓它可查」。這個插件不做推論、不產生衍生欄位、不做名稱解析——
回傳的都是原始 `kcsapi` 資料；把任務線圖和你的進度接起來、或從編成回推任務
是否達成，都是 agent 的工作。

## 提供的工具

### `poi_get`

以點分路徑讀取 store，例如 `info.ships`、`info.fleets`、`info.resources`。
可讀的根是 `info`、`const`、`fcd`、`wctf`、`battle`、`sortie`、`timers`、
`misc`，加上下面兩個：

- **`ext.<套件名>._`**——允許清單內的其他插件 state，一次讀一個（`ext` 整包
  不可讀）。那層 `_` 是 poi 自己包在每個插件 reducer 外面的。
- **`questline.quests`**——poi-plugin-quest-line 隨套件附帶的靜態任務線圖，
  每個任務 id 對應到它的目錄條目，含 `prereqIds`／`unlocks`（圖的邊）與
  名稱、分類、獎勵欄位。它是「遊戲裡存在哪些任務」的凍結目錄，
  **完全不反映你的進度**。

集合（陣列，或以 id 為鍵的物件）支援 `where` 篩選、`select` 投影與 `limit`；
回應大小有上限，超過就截斷。完整的運算式語法寫在工具本身的說明裡，
agent 呼叫時讀得到。

### `poi_battle`

依戰鬥 id 讀取 **poi-plugin-battle-detail** 存下的完整記錄：`fleet.main`／
`fleet.escort` 每艘艦的 `api_ship_id`、`api_lv`、改修值與裝備，加上原始戰鬥
封包與結果。id 來自 `ext.poi-plugin-battle-detail._.indexes`，單次最多 50 個。

典型用法是先用索引框出時段，再把 id 丟進來查編成：

```
poi_get    path="ext.poi-plugin-battle-detail._.indexes" where="map = \"2-4\""
poi_battle ids=[...] select=["fleet.main[].api_ship_id"]
```

### `poi_lookup`

把主資料的 id 解析成記錄——`api_ship_id` 變艦名、`api_slotitem_id` 變裝備名等。
涵蓋艦娘、裝備、艦種、海域、遠征、改修等資料表；單次最多 200 個 id
（這些表很大，光 `const.$ships` 就約 1.6 MB，所以永遠不整包倒出來）。

### `poi_describe`

在查詢之前先了解某個路徑上有什麼：種類、元素數量、鍵、以及取樣元素的欄位名。
不帶 path 呼叫則列出所有可讀的根。

少數幾條路徑的資料是**位置式陣列**，欄位名不在資料裡——`info.resources` 是八個
裸數字，航海日誌 EX 的每一列也是。這些路徑上 `poi_describe` 會回傳已查證的欄位
名（而不是 `["0","1",...]`），`poi_get` 則把同一份對照放進 `hint`，因為最需要它
的正是沒先呼叫 `poi_describe` 的人。另有兩條路徑帶警語：`info.repairs` 的
`api_ship_id` 是 roster id（不是 master id），而 `info.resources` 的位置與
`poi_lookup(kind="useitems")` 的 id 空間無關。

欄位名是對**別人的**資料配置所做的宣告，所以每一張表都在原始碼裡註明出處
（`src/fields.ts`），而且只在實際形狀與表上的欄位數吻合時才輸出；對不上就改回
報「配置已變動」。寧可說「我不知道」，也不要把名字貼錯欄位——後者看起來完全
正常。

**時區**：store 裡混著三種時鐘，而且字串都不帶標記——遊戲自己的 `api_*_time_str`
是 **JST（UTC+9）**，某些插件（如 battle-detail 的 `time`）用**主機時區**格式化，
`timeRange` 的 `from`／`to` 則是 **UTC**。所以要比較、要排序，一律用 epoch 數值
（`api_*_time`、`time_`、`min`／`max`），不要用字串。遊戲的每日邊界（例如任務
05:00 重置）同樣在 JST 上。相關路徑讀取時會附警語。

對於每列帶時間戳的日誌（航海日誌 EX 各表、`ext.poi-plugin-battle-detail._.indexes`），
`poi_describe` 還會回傳 **`timeRange`**——該分支實際涵蓋的最舊與最新時刻，同時給
原始毫秒值（可直接拿去 `where` 比較）與 ISO 字串。這是**資料視界**：`where` 篩不到
東西，在範圍內代表「沒發生」，在範圍外只代表「日誌沒回溯到那麼早」，兩者必須分得
開。範圍是**掃過每一列**算出來的，不靠列的排序——實測航海日誌 EX 是新到舊，但那
是對某張表的觀察，不是插件的保證。

## 安裝

把這個 repo 用 symlink 掛進 poi 的插件目錄（沒有發佈到 npm）：

```sh
ln -s /path/to/poi-plugin-nanodesu-mcp \
  "$HOME/Library/Application Support/poi/plugins/node_modules/poi-plugin-nanodesu-mcp"
```

然後在 poi 裡重載插件（或重啟 poi）。本專案以原始 TypeScript 發佈、沒有建置
步驟——poi 會在 `require()` 時即時轉譯 `.ts`。

伺服器只在 poi 的**主視窗**啟動。狀態（listening／stopped／error、端點網址、
請求計數）會顯示在 poi 的插件面板。開始監聽後（預設
`http://127.0.0.1:12450/mcp`）接上 agent：

```sh
claude mcp add poi --transport http http://127.0.0.1:12450/mcp
```

實際綁定的連接埠也會寫到 `~/.poi-nanodesu-mcp/port`，方便需要以程式探索的情境。

插件的 UI 字串透過 poi 自己的 i18n 機制翻譯（見 `i18n/*.json`），已包含繁體
中文；其他語系會回退到英文原文。

## 插件依賴

除了 poi 本身，這個插件會讀取其他幾個 poi 插件的資料。**全部都是選用的**：
沒安裝不會出錯，只是該分支不會出現在 `poi_describe` 的根列表，而直接去讀會
得到一則指名該套件的「未安裝」訊息。

| poi 套件                                                                                    | 提供的資料                                       | 取得機制                               | 對外路徑                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------- | ---------------------------------------- |
| [poi-plugin-quest-line](https://github.com/cnxin/poi-plugin-quest-line)                   | 累積的任務清單（含 `api_state`）與跨會話的 seen／cleared id | redux ext state（整包）                | `ext.poi-plugin-quest-line._`            |
| [poi-plugin-quest-line](https://github.com/cnxin/poi-plugin-quest-line)                   | 靜態任務線圖（任務目錄與前置關係）                           | **磁碟**上的隨附資產                       | `questline.quests`                       |
| [poi-plugin-battle-detail](https://github.com/poooi/plugin-battle-detail)                 | 戰鬥索引（`id`／`map`／`route`／`rank`）             | redux ext state（**僅 `_.indexes`**） | `ext.poi-plugin-battle-detail._.indexes` |
| [poi-plugin-battle-detail](https://github.com/poooi/plugin-battle-detail)                 | 單場戰鬥完整記錄（編成、裝備、封包）                          | **磁碟**上的 gz 檔，依 id 讀               | `poi_battle` 工具                          |
| [poi-plugin-akashic-records](https://github.com/poooi/plugin-akashic-records)             | 出擊／遠征／建造／解體日誌                               | redux ext state（整包）                | `ext.poi-plugin-akashic-records._`       |
| [poi-plugin-akashic-records-ex](https://github.com/momocow/poi-plugin-akashic-records-ex) | 同上，另加 quest 日誌                              | redux ext state（整包）                | `ext.poi-plugin-akashic-records-ex._`    |
| [poi-plugin-senka-calc](https://github.com/ruiii/plugin-Hairstrength)                     | 戰果歷史：排行門檻（5／20／100／501）、自己的戰果與名次、經驗值、EO 與任務進度  | redux ext state（整包）                | `ext.poi-plugin-senka-calc._`            |

有兩個套件各出現兩次，因為它們是**用兩種不同機制**被依賴的：最有價值的資料
根本不進 redux，所以 state 讀一半、磁碟讀另一半。

讀磁碟這半的耦合度明顯較高，它依賴對方**私有的檔案配置**：

```
<APPDATA>/plugins/node_modules/poi-plugin-quest-line/assets/quests.json
<APPDATA>/battle-detail/<id>.json.gz
```

對方改版搬動檔案，這兩條就會失效。目前的處理是**安靜降級**——載不到就當作沒有，
絕不讓插件啟動失敗或讓工具呼叫爆掉——但它不會主動告訴你「這條以前是通的，
現在壞了」。這是已知的取捨。

## 開發

```sh
npm test           # node:test，跑 test/*.test.ts
npm run typecheck  # tsc --noEmit
```

`scripts/live-check.ts` 會對真正在跑的 poi 實例執行這些工具，而不是測試替身。
原始碼結構與在 poi renderer 裡執行時那些不直觀的限制，見 `CLAUDE.md`；
完整設計說明見
`docs/superpowers/specs/2026-08-09-poi-plugin-chinjufu-mcp-design.md`。

## 授權

MIT
