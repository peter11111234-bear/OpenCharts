# R10 安全審查報告（draw.ts / ta.ts / pinetsStatefulB.ts）

- 日期：2026-10-11
- 範圍：`14e5691..a37d9f8`（R10 共 10 個 commit），只審三個變更檔：
  - `src/pine/builtins/draw.ts`（+124）
  - `src/pine/builtins/ta.ts`（+16）
  - `src/pine/pinetsStatefulB.ts`（+113）
- 方法：diff 全讀 + 下游消費端追蹤（engine/vela 渲染層）+ **probe 實測**（非只讀碼推論）。
- 結論：**無高/中危。3 個 Low 級資源/驗證缺口（L1–L3），其餘審查角度乾淨。**

## 背景與需求（為什麼做這次審查）

R10 交付 5 類改動，都接觸不可信輸入（使用者 Pine script，可從社群匯入）：

1. 10 個 drawing accessor（`table.set_*`、`cell_set_*`、`chart.point` setter、`force_overlay` 等）
2. `text_font_family` / `text_formatting` 新字串 prop（原本「無下游消費者」，後於 `1537afc` 接上 vela font model）
3. `ta.kcw` 改為 canonical scalar width（與 `ta.kc`/`ta.kcw` tuple 解耦）
4. `ta.pivot_point_levels` 移植（第 22 個 statefulB method，引入 stateKey）
5. `table.new` columns/rows clamp（review 自加的防護）+ cell 負值防護

威脅模型：Pine script 在 per-session Web Worker（B4）執行，script 作者 ≠ 執行者。攻擊目標：worker 記憶體耗竭（session DoS）、跨 callsite 狀態污染（指標值錯亂）、字串流向 DOM（XSS）、型別洗牌（UDT spoofing）。

## 審查角度與結論

| # | 角度 | 結論 |
|---|---|---|
| 1 | 資源耗竭 / 無限 allocation | ❌ L1、L2（見下） |
| 2 | 型別混淆 / UDT spoofing | ✅ 已修（`pointXY`、`chart.point.copy` 檢查 `typeName === 'chart.point'`） |
| 3 | 字串注入 → DOM（XSS） | ✅ 追到 sink，全走 `textContent` / canvas `fillText`，無 `innerHTML` |
| 4 | NaN / coercion 穿過防護 | ⚠️ L3（穿透但下游 `propNum` 兜住，無實害） |
| 5 | 狀態隔離 / stateKey 注入 | ✅ allow-list 先驗後用（`pinetsStatefulB.ts:1707→1719`） |

---

## L1（Low）：`table.cell` / `cell_set_*` 無上界 → cells Map 無限增長

**位置**：`src/pine/builtins/draw.ts:503`（`table.cell`）、`draw.ts:566`（`cellSetter`）

```ts
// draw.ts:503
if (col < 0 || row < 0) return { kind: 'void' }; // no negative-cell dead entries
// draw.ts:566
if (col < 0 || row < 0) return { kind: 'void' }; // out-of-grid write: no dead cell
```

只擋負值，**不比對表格實際 grid**（`table.new` 的 columns/rows）。R10 review 加了負值防護，但缺上界。

**實測證據**（probe，10 bars，`var t = table.new(2,2)` + `for i = 0 to 199999` 寫唯一座標）：

```
cells Map size (var table, 10 bars x 200k loop): 100000
```

100,000 個死 entry 遺留在 worker 記憶體。

**爆炸半徑（已確認有界，故 Low 不是 Medium）**：
- `engine.ts:725` 建 model 時丟棄 out-of-grid cell（`col >= cols → continue`），死 entry 不進 model、不渲染、不 crash。
- 50 tables 配額（draw sink）只限 table 數，**不限每 table 的 cell 數**。
- TV 靠 grid 隱式限制 cell 數；本 port 沒有。
- 對齊既有風險類別：Pine `while(true)` 已知可 wedge worker（`PROGRESS.md` 記載為 accepted），本項同類、同爆炸半徑（self-DoS of own worker），但寫法是**有限迴圈**，不觸發任何既有停機偵測。

---

## L2（Low）：`table.merge_cells` 無限 push

**位置**：`src/pine/builtins/draw.ts:522-533`

**實測證據**（10 bars × 10,000 次呼叫）：

```
merges array length: 100000
```

無 guard、無去重。與 L1 同類別、同爆炸半徑。

---

## L3（Info/Low）：NaN 座標穿過 R10 的 clamp 與負值防護（下游有兜，無實害）

**位置**：
- `draw.ts:480-481`：`Math.max(0, Math.min(100, Math.trunc(numArg(...))))`
- `draw.ts:503` / `:566`：`col < 0 || row < 0`

**破壞方式**：`Math.trunc(NaN) = NaN`，且 `NaN < 0 === false`。

**實測證據 1**——clamp 失效，NaN 存進 props：

```
test: table.new(position.top_left, columns=math.sqrt(-1), rows=2)
stored columns = NaN number   (typeof number)
```

`Math.max(0, Math.min(100, Math.trunc(NaN)))` → NaN。「engine eagerly allocates columns×rows」的防護宣稱對 NaN 失效。

**實測證據 2**——cell 寫出 `"NaN,0"` 死 key：

```
test: table.cell(t, math.sqrt(-1), 0, "x")
cells keys: [ 'NaN,0' ]
```

**為何仍是 Low：雙層下游兜住**：
- `engine.ts:138-140` `propNum()` 用 `Number.isFinite` 過濾 → model 端拿 undefined → 退回預設。實測 model 輸出：

```
NaN-cols tables = [{"c":1,"r":2}]     // columns NaN → model 得 1
NaN-rows tables = [{"c":2,"r":1}]     // rows NaN → model 得 1
control tables  = [{"c":2,"r":2,"c00":"x"}]
```

- `engine.ts:725` `Number.isFinite`/範圍檢查讓 `"NaN,0"` 進不了 model。
- 結果：無 crash、無越界 allocation，只有 props 層的規格漂移與死 Map entry（歸入 L1 的死 entry 類別）。

---

## 已修復 / 乾淨角度（附證據）

### ✅ 型別洗牌（角度 2）
- `draw.ts:631` `pointXY`：`p.v.typeName !== 'chart.point' → return undefined`（diff 新增）。
- `chart.point.copy` 同樣檢查 `typeName === 'chart.point'`。
- 殘留小項（非安全）：`draw.ts:220` 生成的 `set_*` 接受 `bound.get('id')` fallback，`label.set_text(<line obj>)` 會把 text prop 寫進 line 的 props。跨 drawing 種類 prop 污染，engine 讀 kind-specific props 時忽略，record 型別不 crash。自傷性質，不修也可。

### ✅ 字串注入（角度 3）— 每條 sink 都查了
- **tooltip**：`node_modules/@luxalgo/vela/dist/vela.global.js` `attachChromeTooltip` → `tip.textContent = text`（已 grep 確認）。走 `setAttribute('aria-label')`，非 `innerHTML`。
- **label/box/cell 文字**：vela 渲染走 canvas `fillText`（全域 40 處），無 DOM 解析。
- **runtime error 反射**：`pinetsStatefulB.ts:1709` 的 `` `Invalid argument '${type}'` `` — `type` 已過 `PIVOT_TYPES.includes()` allow-list，不在清單內直接 throw，插值內容為固定字串。
- **`src/pine/` 全目錄 `innerHTML` 出現次數 = 0**（已逐檔 grep）。

### ✅ 狀態隔離（角度 5）
`pinetsStatefulB.ts`：
```ts
1707:  if (!PIVOT_TYPES.includes(type)) { throw ... }   // 先驗
1719:  const stateKey = `${_callId || 'pivot_point_levels'}_${type}_${developing}`;  // 後用
```
- `type` 是 allow-list（`:1667`）過後的白名單值，無 key 注入。
- `type` + `developing` 進 key 修掉了 upstream 只 key `_callId` 的 type-switch 共享 bug。
- `_callId` 來自 transpiler 追加參數（`:1701`，`typeof rest[rest.length-1] === 'string' ? rest.pop()`）— script 理論上可傳額外字串參數 spoof callId，但：同一 script 內、同信任域、`taState` 是 per-run，跨 callsite 碰撞只會造成**自己 script 的指標值錯亂**，無安全邊界跨越。可記 correctness note，非安全 finding。

### ✅ `ta.kcw` 零分母（角度 4）
`ta.ts:1282`：`fl(base === 0 ? 0 : (2 * r * mult) / base)` — 已 guard；NaN/負 base 僅產生 NaN/Inf 浮點值，`precision`/`toValue` 過濾鏈可容。

### ✅ constructor / accessor parity
- `line.new` `force_overlay` 為 ctor-only（上游無 `set_force_overlay`），diff 註釋與 TV 對齊正確。
- enum set 新增 `format_bold/italic/none`、`font.family_*` 與 TV 文檔一致。

---

## 修復建議（給 SWE2）

單一修法涵蓋 L1+L2+L3，在 `table.cell`（`draw.ts:503`）、`cellSetter`（`draw.ts:566`）、`merge_cells`（`draw.ts:522`）三個入口加同一個 guard：

```ts
const cols = Math.max(0, Math.min(100, Math.trunc(numArg?  ... )));
// 或直接讀表格 props（table.new 已存 clamp 後的 columns/rows）：
const cols = obj.props.columns, rows = obj.props.rows;
if (!Number.isInteger(col) || !Number.isInteger(row) ||
    col < 0 || row < 0 || col >= cols || row >= rows) return { kind: 'void' };
```

- `Number.isInteger` 同時封掉 L3（NaN、非整數）。
- `col >= cols || row >= rows` 封掉 L1（out-of-grid 不再建死 entry）。
- `merge_cells` 同理校驗四個座標。
- `table.new` 的 NaN clamp（`draw.ts:480-481`）若要 spec-級乾淨，改 `Number.isFinite` 判斷後退回預設：

```ts
const clampDim = (v: number) => Number.isFinite(v) ? Math.max(0, Math.min(100, Math.trunc(v))) : 1;
```

注意：加了上界後，**原本「隱式容忍 out-of-grid 寫入」的既有 test 可能會紅**（`draw.ts:503` 註釋顯示 R10 曾刻意保留 out-of-grid 只是不建死 entry）。修復時先跑：

```
npx vitest run src/pine/__tests__/          # 全套
```

有 golden 依賴 out-of-grid 行為的，改動前先確認上游 TV 對越界 cell 的行為（TV 應該也是靜默丟棄）。

## 驗證重現方式（SWE2 查證用）

Probe 已刪（throwaway）。重現方法：

1. **前置**：工作樹有未提交的 JIT WIP（`src/pine/jit.ts`、`interpreter.ts` +403 行），其 `jitMatArg is not defined` ReferenceError 會污染測試。**一律加 `PINE_JIT=0` 環境變數跑**（`interpreter.ts:1946` 閘），或在乾淨 HEAD worktree 跑。
2. 建 `src/pine/__tests__/tmp_probe.test.ts`，內容模式：

```ts
import { describe, it } from 'vitest';
import { parse } from '../parser';
import { runScript } from '../interpreter';
import { PineInterpreterEngine, buildModel } from '../engine';
import '../builtins/index';
import '../mtf';

// L1/L2: runScript 後取 drawing 的 props.cells.size / props.merges.length
const r = await runScript(parse(`
indicator("t")
var t = table.new(position.top_left, 2, 2)
for i = 0 to 199999
    table.cell(t, i, 0, "x")
`), bars, { symbol: 'X', timeframe: '1' });
const d = r.drawings.find(x => x.kind === 'table') as any;
console.log('cells:', d?.props?.cells?.size);   // 期望(現狀) 100000

// L3: columns=math.sqrt(-1) → d.props.columns === NaN
//     table.cell(t, math.sqrt(-1), 0, "x") → cells keys 含 'NaN,0'
// model 端: buildModel 後 tables[0].columns === 1（propNum 兜住）
```

3. `buildModel` 需要完整 `ExecutionRequest`（`prepared` / `market` / `bars` / `inputs` / `mode`），照 `src/pine/__tests__/engine.test.ts:18-32` 的 `mkReq`。缺 `prepared.meta` 會報 `Cannot read properties of undefined (reading 'meta')` — 那是 request 缺欄位，**不是 NaN 造成的**（control 已對照確認）。

## 殘留風險

- **未審**：本次未跑全套 vitest（純審查不改碼）；修復後 SWE2 應跑全套。
- **未審**：未提交 JIT WIP（`jit.ts`）本身的安全面，不在 R10 範圍；其 `jitMatArg` ReferenceError 為獨立 bug。
- **`_callId` spoof**（見角度 5）：correctness note 級，未列 finding。
- vela `sanitizeHtml` / `node.innerHTML = value`（`children` 屬性）存在於 vela 庫內，但餵的是 vela 自身 config，非 Pine 字串；若未來接線需重查此 sink。
