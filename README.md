# poi-plugin-chinjufu-mcp

一個 [poi](https://github.com/poooi/poi) 插件，把 poi 當下的 KanColle 遊戲狀態
以唯讀工具的形式開放給 MCP 客戶端（Claude Code，或任何說 MCP 的 agent）。
不必去撈 poi 的快取檔，也沒有過期問題：每一次呼叫讀的都是遊戲正在跑的那個
redux store。

## 核心概念

這個插件的目的是**把 poi 以及其他插件的 state 開放給 agent 查詢**，
並且**整合一部分並非 state、但同樣實用的資料**。

所以可讀的東西分成三類，界線值得先弄清楚：


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
把任務線圖和你的進度接起來、或從編成回推任務是否達成，都是 agent 的工作。

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


有兩個套件各出現兩次，因為它們是**用兩種不同機制**被依賴的。原因就是上面
核心概念講的那件事：這兩個插件最有價值的資料根本不進 redux，所以 state 讀一半、
磁碟讀另一半。

後者的耦合度明顯較高。讀 state 只依賴 poi 的 `extendReducer` 慣例，讀磁碟則
依賴對方**私有的檔案配置**：

```
<APPDATA>/plugins/node_modules/poi-plugin-quest-line/assets/quests.json
<APPDATA>/battle-detail/<id>.json.gz
```

對方改版搬動檔案，這兩條就會失效。目前的處理是**安靜降級**——載不到就當作沒有，
絕不讓插件啟動失敗或讓工具呼叫爆掉——但它不會主動告訴你「這條以前是通的，
現在壞了」。這是已知的取捨。

### 非 poi 的依賴


| 類型              | 內容                                                 |
| --------------- | -------------------------------------------------- |
| runtime         | `@modelcontextprotocol/sdk`、`zod`                  |
| dev             | `@types/node`、`tsx`、`typescript`                   |
| 由 poi 在執行期提供    | `react` —— 刻意**不**安裝，見 `src/poi-modules.d.ts`      |
| poi 的 window 全域 | `getStore`、`isMain`、`config`、`APPDATA_PATH`、`i18n` |


## 為什麼

poi 本來就把完整的遊戲狀態（艦娘、艦隊、資源、主資料……）放在記憶體裡，
而且是從遊戲 API 收到的當下就更新。這個插件在那個 store 前面架了一台 MCP
伺服器，讓 agent 直接查詢，不用去刮 poi 的磁碟快取，也不用從原始 `kcsapi`
封包重新推導狀態。

設計上是唯讀的：不 dispatch 任何 action、不操作遊戲 webview、不寫回任何東西。

## 安裝

把這個 repo 用 symlink 掛進 poi 的插件目錄（沒有發佈到 npm）：

```sh
ln -s /path/to/poi-plugin-chinjufu-mcp \
  "$HOME/Library/Application Support/poi/plugins/node_modules/poi-plugin-chinjufu-mcp"
```

然後在 poi 裡重載插件（或重啟 poi）。本專案以原始 TypeScript 發佈、沒有建置
步驟——poi 會在 `require()` 時即時轉譯 `.ts`，所以改完程式碼，下次重載插件就
生效。

伺服器只在 poi 的**主視窗**啟動，而且要等 poi 給出可用的 `getStore()` 之後。
狀態（listening／stopped／error、端點網址、請求計數）會顯示在 poi 的插件面板。

## 連接 agent

插件開始監聽後（預設 `http://127.0.0.1:12450/mcp`）：

```sh
claude mcp add poi --transport http http://127.0.0.1:12450/mcp
```

實際綁定的連接埠也會寫到 `~/.poi-chinjufu-mcp/port`，方便需要以程式探索的情境。

## 工具

### `poi_get`

以點分路徑讀取 redux store，例如 `info.ships`、`info.fleets`、`info.basic`、
`info.resources`。

**可讀的根**：`info`、`const`、`fcd`、`wctf`、`battle`、`sortie`、`timers`、
`misc`。

#### 集合查詢

集合（陣列，或以 id 為鍵的物件）支援：

- `**where**` — 篩選運算式：`<欄位> <運算子> <值|欄位>`，可用 `and`／`or`／`not`
與括號組合。運算子：`= == != < <= > >= in contains exists`。`contains` 是陣列
成員判斷，若兩邊都是字串則為子字串比對。欄位可為巢狀或帶索引（`api_exp[0]`）；
若某一列本身是陣列，則以位置定址（`[0]`、`[1]`）。

  範例：`"api_nowhp < api_maxhp"`、`"api_lv >= 99 and api_locked = 1"`、
  `"api_ship_id in [487, 213]"`、`"api_sally_area exists"`、
  `"[2] contains \"Boss\""`。
- `**select**` — 要投影的欄位路徑，例如 `["api_ship_id", "api_nowhp"]`。
`[]` 會**映射整個陣列**而不是索引它，所以 `"api_ship[].api_lv"` 會每艘艦各給
一個等級。它是投影而非路徑，因此在 `path` 裡會被拒絕。
- `**limit**` — 最多回傳幾筆（預設 200）。

單一記錄只支援 `select`。`maxBytes` 限制序列化後的回應大小（預設 65536，
硬上限 262144）；集合會被截斷到塞得下，單一過大的記錄則直接回報錯誤。

#### 插件狀態（`ext`）

允許清單內的插件狀態可以一次讀一個，例如 Logbook 的出擊紀錄在
`ext.poi-plugin-akashic-records._.attack.data`（那個 `_` 是 poi 自己包在每個
插件 reducer 外面的一層）。`ext` 整包不可讀。

插件是以**完整的 poi 套件名**比對，所以分支版本算另一筆——Logbook EX 分支是
`ext.poi-plugin-akashic-records-ex`。

某些插件只開放**部分**子路徑，詳見下面的戰鬥索引。

#### `questline`：任務線圖

`questline` 並不是 poi 的分支，而是 **poi-plugin-quest-line** 隨套件附帶的
靜態任務圖的唯讀疊加層。`questline.quests` 把每個任務 id 對應到它的目錄條目，
包含 `prereqIds` 與 `unlocks`（也就是圖的邊），以及 `wikiId`、`name`、
`category`、`period` 和獎勵欄位。

它被掛成一個根，好讓同一套 `where`／`select` 機制直接讀；該插件沒安裝時這個根
就不存在。它是「遊戲裡存在哪些任務」的凍結目錄，**完全不反映你的進度**——要把
它和即時狀態接起來是 agent 的工作，不是這個插件的。

> **字形陷阱：同一個字有三種寫法。** 這份目錄的文字欄位是**簡體中文**，
> 而同一個概念在這個專案裡三種字形都會出現，很容易寫錯：
>
>
> | 字形  | 寫法   | 碼位     | 出現在                                               |
> | --- | ---- | ------ | ------------------------------------------------- |
> | 簡體  | `出击` | U+51FB | `questline.quests` 的 `category`／`name`／`desc`     |
> | 繁體  | `出擊` | U+64CA | `ext.poi-plugin-battle-detail._.indexes` 的 `desc` |
> | 日文  | `出撃` | U+6483 | 遊戲原文；`questline.quests` 的 `nameJa` 欄位             |
>
>
> 最清楚的例證是任務 201 —— **同一筆記錄的兩個欄位**寫著同一個字：
> `name` 是「击破敌舰队」，`nameJa` 是「敵艦隊を撃破せよ！」。
> 全表 119 筆 `name` 含簡體 `击`、132 筆 `nameJa` 含日文 `撃`，
> 而含繁體 `擊` 的 `name` 是 **0 筆**。
>
> 所以查任務要用簡體：`category = "出击"` 才命中，寫成繁體 `"出擊"` 會回傳
> **0 筆**（已實測），而且不會報錯。查戰鬥索引則相反，那裡是繁體。
>
> 另外 `where` 裡的中文**必須加引號**——裸字會被當成欄位名，
> `category = 出击` 是語法錯誤而不是比對不到。

走訪這張圖用 `prereqIds contains <id>` 和 `unlocks contains <id>`；沒有前置
條件的 49 個任務是 `depth = 0`。

要注意 `prereqIds = []` **不會報錯，而是比對不到任何一列**：`=` 比的是純量，
右邊放陣列字面值只會靜默地沒有結果。

#### 可接取的任務

遊戲提供給你的任務清單，只存在於一個地方：`info.quests` 只有你**已接取**的
任務，從來不含只是「開放可接」的那些。

`ext.poi-plugin-quest-line._.questList` 把 `api_no` 對應到遊戲回傳的任務本體，
其中 `api_state` 為 1 = 可接未接、2 = 進行中、3 = 已達成待領獎。

它是由你在遊戲中實際打開過的任務頁面累積而成，所以**有多完整取決於你翻過多少
頁**，不是一份權威清單。

#### 戰鬥紀錄

戰鬥歷史分成兩半。

`ext.poi-plugin-battle-detail._.indexes` 是每場戰鬥一列——`id`、`time_`、
`map`、`route`、`rank`——這是「何時打了哪一場」的依據。

只有這個子路徑可讀。它的兄弟 `sortieIndexes` 是 Immutable.js 的 `List`，
自身的可列舉屬性是內部結構而不是資料；而且它本來就是衍生的——同一批戰鬥依
出擊分組而已，可以用 `indexes` 加上 `fcd.map` 的航路圖重新算出來。

另一半是戰鬥記錄本身，用 `poi_battle` 依 id 讀取。

### `poi_battle`

讀取 **poi-plugin-battle-detail** 存下來的完整戰鬥記錄，依上面索引裡的 `id`
指定。

一筆記錄包含索引給不了的東西：`fleet.main` 與 `fleet.escort`，每艘艦帶
`api_ship_id`、`api_lv`、`api_kyouka`（改修值）與 `poi_slot` 裝備，再加上原始
戰鬥封包與結果。艦種與裝備 id 用 `poi_lookup` 轉成名稱。

一筆完整記錄約 22 KB，其中絕大部分是裝備，所以 `select` 就是「一次回應三場」
和「一次三十場」的差別。`[]` 會映射陣列而非索引它——正是它讓「跨整支艦隊的
投影」得以表達：

```
select: ["fleet.main[].api_ship_id", "fleet.main[].poi_slot[].api_name"]
```

單次最多 50 個 id。讀不到的 id 會被略過並在 `hint` 裡指名，而不是讓整批失敗。

典型用法是先用索引框出時段，再把 id 丟進來查編成——這樣才能從紀錄回推某個
出擊任務到底有沒有達成：

```
poi_get   path="ext.poi-plugin-battle-detail._.indexes" where="map = \"2-4\" and time_ >= 1789230000000"
poi_battle ids=[...] select=["fleet.main[].api_ship_id"]
```

### `poi_lookup`

把主資料的 id 解析成記錄——`api_ship_id` 變艦名、`api_slotitem_id` 變裝備名等。

`kind` 指定資料表（`ships`、`equips`、`shipTypes`、`equipTypes`、`maps`、
`mapareas`、`missions`、`useitems`、`shipUpgrades`、`shipgraph`、`graphs`、
`exslotEquips`、`exslotEquipShips`）；`ids` 為必填，單次最多 200 個——這些表很大
（光 `const.$ships` 就約 1.6 MB），所以永遠不會整包倒出來。

### `poi_describe`

在查詢之前先了解某個路徑上有什麼：種類、元素數量、鍵、以及取樣元素的欄位名。
不帶 path 呼叫則列出所有可讀的根。

---

這個插件本身不做名稱解析，也不產生衍生欄位——回傳的都是原始 `kcsapi` 資料；
把 id 接成名稱是 `poi_lookup` 的事，而詮釋結果是 agent 的事。

## 開發

```sh
npm test           # node:test，跑 test/*.test.ts
npm run typecheck  # tsc --noEmit
```

`scripts/live-check.ts` 會對真正在跑的 poi 實例執行這些工具，而不是測試替身：

```sh
node --import tsx scripts/live-check.ts
```

原始碼結構、以及在 poi renderer 裡執行時那些不直觀的限制，見 `CLAUDE.md`；
完整的設計說明見
`docs/superpowers/specs/2026-08-09-poi-plugin-chinjufu-mcp-design.md`。

## 翻譯

插件的 UI 字串（標題、描述、狀態面板）透過 poi 自己的 i18n 機制翻譯，
見 `i18n/*.json`。已包含繁體中文（`zh-TW`）；其他 poi 語系（`en-US`、`ja-JP`、
`zh-CN`、`ko-KR`）在翻譯補上之前，會回退到英文原文。

## 授權

MIT