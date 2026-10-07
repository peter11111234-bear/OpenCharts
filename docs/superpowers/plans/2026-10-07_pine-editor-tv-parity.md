# Pine Editor TV Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**日期：** 2026-10-07

**Goal:** /vela 的 Pine 編輯器功能邏輯 100% 對齊 TradingView Pine Editor —— 檔案模型（我的腳本庫、命名/副本/版本歷史/最近使用/開啟）、legend ⋯→源碼通路、editor chrome（Add to chart/Save/refresh/⋯/statusbar），分期交付。

**Architecture:** 新增 `src/pine/lib/`（script library，localStorage 持久化 + 事件發布），重寫 `velaPineEditor.ts` 的 modal 為 TV 版 chrome（檔名▾檔案選單、Add to chart、Save、statusbar），用 `registerLegendCallout` 做指標列 ⋯ 選單。`src/pine/*.pine` manifest 繼續是「內建唯讀腳本」；使用者存的腳本進 `pine-lib` store，兩者都併入 Indicators manifest。

**Tech Stack:** TypeScript, Vela workspace plugin API (`registerStatePersistence`, `registerLegendCallout`, `registerWidgetAction`, `IndicatorLoader`), localStorage, vitest.

**Spec:** `docs/TV_PINE_EDITOR_RECON.md`（偵察記錄：選單項目、行為、截圖編號）

**Spec invariant:** 使用者存的腳本是 localStorage 的一等物件，任何 session/refresh 都能從 Open dialog 或 Recently used 叫回來——不依賴「剛好跑在哪個 cell」。

## Executor Rules

Stop ONLY on hard blockers: missing dependency, tool refuses to run, same verify failing after 2+ distinct fix attempts. Single red test = normal TDD loop, not a blocker.

**Plan-specific Nevers:**
- NEVER 把使用者腳本只存進 `charts[i].ext`（那是 per-cell 快照，不是檔案庫）；library 才是正本，cell ext 只是「這格當前在跑什麼」的還原標記
- NEVER 用 emoji 代替 TV 的圖示語意（⋯ 用 vela icon registry 的 `kebab`/`ellipsis` 或註冊自訂 icon）
- NEVER 讓 Open dialog 依賴 React 元件——Vela editor 是純 DOM overlay，照抄現有 `velaPineEditor.ts` 的 createElement 風格
- NEVER 在 src/pine/*.pine 檔案裡存使用者狀態——manifest 是 build-time 唯讀

## Global Constraints

- localStorage key 前綴統一 `opencharts.pine.*`（library、editor state）；舊 `pine-hist:*` 遷移進 library 後保留唯讀別名一次，不刪（使用者可能中途有舊資料）
- 所有 UI 文字用 TV 的英文 label（Save script / Make a copy / Rename / Version history / Create new / Recently used / Open script / Add to chart / Publish script placeholder disabled）——不翻中文，跟 TV 像素級對齊
- 所有 modal/dropdown 掛 `document.body`，cell destroy 時不連動死

## Decision Points

### D1: 編輯器呈現層 — modal overlay 還是 dock panel (T1)

- Consumed by: Task 2, 3, 4, 5
- Candidates:
  - A (existing pattern): 保持現行 `vela-pine-overlay` centered modal（`velaPineEditor.ts` 已在用）
  - B (TV-faithful): 右側 dock panel（TV 的行為，但需要 Vela side-panel API + 版面擠壓）
  - C (minimal): 底部 drawer
- Criteria:
  - 開啟時圖表仍完整可見（TV 右 dock 會擠圖，modal 不會）
  - 不需動 Vela workspace 版面管理 API
  - 一個 cell destroy 不能把編輯器一起殺
- Chosen: A — modal 保持，但 chrome 內容 100% 對齊 TV。B 的版面管理超過本期範圍，且 TV 也有「Move script to bottom」可切 dock/overlay 兩態，本期先做到 overlay 形態。
- Rejected: B（超出本期 API 範圍）；C（沒有 TV 對應物）
- Revisit trigger: 使用者要「一邊看圖一邊改 script」且 modal 遮住 pane 時
- Outcome:

### D2: 我的腳本存放處 (T2 — schema + migration)

- Consumed by: Task 1, 3, 5
- Candidates:
  - A (existing pattern): 沿用 `pine-hist:{title}` 加 metadata 欄位
  - B (minimal): 每次編輯只存到 `charts[i].ext`（Vela persist）
  - C (preferred): 新 store `opencharts.pine.lib` —— `{version:1, scripts:[{id,name,source,createdAt,updatedAt,versions:[{t,src}]}]}` + `opencharts.pine.recent`（id list）
- Criteria:
  - 腳本是獨立 entity，不綁 cell
  - 版本歷史跟腳本一起走（不是全域 key）
  - 遷移 `pine-hist:*` 能跑一次完成且不覆蓋已有 id
- Chosen: C
- Rejected: A（keyed by title，改名字就孤兒化）；B（cell ext 是圖上狀態，不是檔案庫）
- Revisit trigger: 要跨裝置同步時（→ server storage adapter）
- Outcome:

### D3: ⋯ 選單的實作管道 (T1)

- Consumed by: Task 5
- Candidates:
  - A (existing pattern): `registerLegendAction` 加一個 `more` icon，點了自己畫 dropdown
  - B (minimal): 不加 ⋯，直接把「源碼」放成常駐圖示
  - C (preferred): `registerLegendCallout` — descriptor 的 `callout()` 回傳 spec + content（buttons list），Vela 內建就是開一個小 panel
- Criteria:
  - 選單能列多個項目（不只是單一 action）
  - 不手寫定位/關閉邏輯（Vela callout 已處理）
  - 對齊 TV 的「⋯ 開一個選單」語意
- Chosen: C — `registerLegendCallout` 就是為「legend 上的小氣泡 → 開 panel」設計的，content.items 直接塞按鈕
- Rejected: A（要自己管 dropdown 生命週期）；B（不是 TV 的交互）
- Revisit trigger: 發現 callout 只能純文字不能放按鈕時（回看 `LegendCalloutItem` 確認 `{type:'button', label, run}` 存在）
- Outcome:

## Review Ledger

（執行時填入）

---

## Task 1: Pine Script Library store + migration

**Blocked by:** None

**Files:**
- Create: `src/pine/lib/pineLib.ts`
- Test: `src/pine/lib/pineLib.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PineScriptEntry {
    id: string;                    // nanoid-ish: 'scr_' + base36 timestamp + rand
    name: string;                  // 檔名（TV 的 script title）
    source: string;
    createdAt: number;
    updatedAt: number;
    versions: { t: number; src: string }[];  // newest last, cap 50
  }
  export function pineLibList(): PineScriptEntry[];                 // sorted by updatedAt desc
  export function pineLibGet(id: string): PineScriptEntry | undefined;
  export function pineLibCreate(name: string, source: string): PineScriptEntry;
  export function pineLibSave(id: string, source: string): PineScriptEntry;   // pushes a version
  export function pineLibRename(id: string, name: string): PineScriptEntry;
  export function pineLibDuplicate(id: string): PineScriptEntry;              // "Copy of X" 
  export function pineLibRemove(id: string): void;
  export function pineLibRecentPush(id: string): void;             // MRU cap 8
  export function pineLibRecent(): string[];                        // ids, newest first
  export function pineLibMigrateLegacyHist(): number;              // returns migrated count; idempotent
  export function pineLibSubscribe(fn: () => void): () => void;     // change events for UI refresh
  ```
- Consumes: nothing from prior tasks

**Assumptions:** localStorage available; idempotent migration keyed by title+src hash so re-run doesn't duplicate.

**Done when:**
- `pnpm vitest run src/pine/lib/pineLib.test.ts` → all pass
- create → list contains entry; save → versions grows; rename → name updated; duplicate → new id with "Copy of "
- `pineLibMigrateLegacyHist` 第二次跑回 0
- remove → list shrinks and recent ids pruned

- [ ] **Step 1: failing test file**

```ts
// src/pine/lib/pineLib.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  pineLibList, pineLibCreate, pineLibGet, pineLibSave, pineLibRename,
  pineLibDuplicate, pineLibRemove, pineLibRecentPush, pineLibRecent,
  pineLibMigrateLegacyHist,
} from './pineLib';

beforeEach(() => localStorage.clear());

describe('pineLib CRUD', () => {
  it('create → list has it; save pushes a version', () => {
    const a = pineLibCreate('MACD V7', '//@version=6\nindicator("MACD V7")');
    expect(pineLibList()[0]!.id).toBe(a.id);
    const b = pineLibSave(a.id, '//@version=6\nindicator("MACD V7") // v2');
    expect(b.versions.length).toBe(2);
    expect(pineLibGet(a.id)!.source).toContain('v2');
  });
  it('rename + duplicate + remove', () => {
    const a = pineLibCreate('A', 'x');
    pineLibRename(a.id, 'B');
    expect(pineLibGet(a.id)!.name).toBe('B');
    const c = pineLibDuplicate(a.id);
    expect(c.name).toBe('Copy of B');
    expect(c.id).not.toBe(a.id);
    pineLibRemove(a.id);
    expect(pineLibGet(a.id)).toBeUndefined();
  });
  it('recent is MRU, cap 8, dedupes', () => {
    for (let i = 0; i < 10; i++) pineLibRecentPush(pineLibCreate('s' + i, 'x').id);
    const r = pineLibRecent();
    expect(r.length).toBe(8);
    expect(r[0]).toContain('scr_');
    pineLibRecentPush(r[3]!);
    expect(pineLibRecent()[0]).toBe(r[3]);
  });
  it('migrate legacy pine-hist:* once', () => {
    localStorage.setItem('pine-hist:macdv7', JSON.stringify([{ t: 1, src: 'A' }, { t: 2, src: 'B' }]));
    const n = pineLibMigrateLegacyHist();
    expect(n).toBe(1);
    expect(pineLibList()[0]!.versions.length).toBe(2);
    expect(pineLibMigrateLegacyHist()).toBe(0); // idempotent
  });
});
```

- [ ] **Step 2: run test → RED**

Run: `pnpm vitest run src/pine/lib/pineLib.test.ts` → fails (module missing)

- [ ] **Step 3: implement `pineLib.ts`**

Core shape — single storage doc + recent index + pub/sub:

```ts
// src/pine/lib/pineLib.ts
type Doc = { version: 1; scripts: PineScriptEntry[] };
const LIB_KEY = 'opencharts.pine.lib';
const RECENT_KEY = 'opencharts.pine.recent';
const LEGACY_PREFIX = 'pine-hist:';
const VERSION_CAP = 50;
const RECENT_CAP = 8;

const subs = new Set<() => void>();
function emit() { for (const f of subs) f(); }
export function pineLibSubscribe(fn: () => void) { subs.add(fn); return () => subs.delete(fn); }

function readDoc(): Doc {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    if (!raw) return { version: 1, scripts: [] };
    const d = JSON.parse(raw);
    if (d?.version !== 1 || !Array.isArray(d.scripts)) return { version: 1, scripts: [] };
    return d;
  } catch { return { version: 1, scripts: [] }; }
}
function writeDoc(d: Doc) {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(d)); } catch { /* quota */ }
  emit();
}

function uid() {
  return 'scr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

export function pineLibList(): PineScriptEntry[] {
  return [...readDoc().scripts].sort((a, b) => b.updatedAt - a.updatedAt);
}
export function pineLibGet(id: string) {
  return readDoc().scripts.find(s => s.id === id);
}
export function pineLibCreate(name: string, source: string): PineScriptEntry {
  const now = Date.now();
  const entry: PineScriptEntry = {
    id: uid(), name: name.trim() || 'Untitled script', source,
    createdAt: now, updatedAt: now,
    versions: [{ t: now, src: source }],
  };
  const d = readDoc();
  d.scripts.push(entry);
  writeDoc(d);
  pineLibRecentPush(entry.id);
  return entry;
}
export function pineLibSave(id: string, source: string): PineScriptEntry {
  const d = readDoc();
  const e = d.scripts.find(s => s.id === id);
  if (!e) throw new Error(`script not found: ${id}`);
  if (e.source === source) return e;                  // no-op save
  e.source = source;
  e.updatedAt = Date.now();
  e.versions.push({ t: e.updatedAt, src: source });
  while (e.versions.length > VERSION_CAP) e.versions.shift();
  writeDoc(d);
  pineLibRecentPush(id);
  return e;
}
export function pineLibRename(id: string, name: string): PineScriptEntry {
  const d = readDoc();
  const e = d.scripts.find(s => s.id === id);
  if (!e) throw new Error(`script not found: ${id}`);
  e.name = name.trim() || e.name;
  e.updatedAt = Date.now();
  writeDoc(d);
  return e;
}
export function pineLibDuplicate(id: string): PineScriptEntry {
  const src = pineLibGet(id);
  if (!src) throw new Error(`script not found: ${id}`);
  return pineLibCreate(`Copy of ${src.name}`, src.source);
}
export function pineLibRemove(id: string): void {
  const d = readDoc();
  d.scripts = d.scripts.filter(s => s.id !== id);
  writeDoc(d);
  // prune recent
  const r = pineLibRecent().filter(x => x !== id);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(r)); } catch {}
}
export function pineLibRecentPush(id: string): void {
  const cur = pineLibRecent().filter(x => x !== id);
  cur.unshift(id);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, RECENT_CAP))); } catch {}
}
export function pineLibRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

// ── legacy pine-hist:{title} → library ──
export function pineLibMigrateLegacyHist(): number {
  const doc = readDoc();
  const legacyKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(LEGACY_PREFIX)) legacyKeys.push(k);
  }
  let added = 0;
  for (const k of legacyKeys) {
    let entries: { t: number; src: string }[];
    try { entries = JSON.parse(localStorage.getItem(k) || '[]'); } catch { continue; }
    if (!Array.isArray(entries) || entries.length === 0) continue;
    // skip if a script already has an identical latest src (idempotent)
    const lastSrc = entries[entries.length - 1]!.src;
    if (doc.scripts.some(s => s.source === lastSrc)) continue;
    const name = decodeURIComponent(k.slice(LEGACY_PREFIX.length)) || 'Imported script';
    const now = Date.now();
    doc.scripts.push({
      id: uid(),
      name,
      source: lastSrc,
      createdAt: entries[0]!.t,
      updatedAt: entries[entries.length - 1]!.t,
      versions: entries.slice(-VERSION_CAP),
    });
    added++;
  }
  if (added) writeDoc(doc);
  return added;
}
```

- [ ] **Step 4: run test → GREEN**

Run: `pnpm vitest run src/pine/lib/pineLib.test.ts` → 4/4 pass

- [ ] **Step 5: commit**

```bash
git add src/pine/lib/pineLib.ts src/pine/lib/pineLib.test.ts
git commit -m "feat(pine): script library store with versions, MRU, legacy pine-hist migration"
```

---

## Task 2: Editor modal chrome — TV header + statusbar

**Blocked by:** Task 1

**Files:**
- Modify: `src/pages/velaPineEditor.ts`（整個 `openEditor` 重寫為 TV 版 chrome；保留 `registerLegendAction`/`registerWidgetAction`/`registerStatePersistence` 區塊）
- Modify: `src/pages/velaPineEditor.ts` 頂部 `PINE_CSS`（新增 TV 版 toolbar/statusbar 樣式）

**Interfaces:**
- Consumes: Task 1 的所有 `pineLib*` 函式
- Produces:
  ```ts
  // 內部（不 export）：editor 狀態
  type EditorState = {
    currentId: string | null;        // library id; null = Untitled
    dirty: boolean;
    handleId?: string;               // editing an on-chart indicator (existing editingId flow)
  };
  // 給 Task 3 的 Open dialog 用：
  export function openPineEditorWithScript(ctx: WidgetContext, scriptId: string): void;
  ```

**Assumptions:** modal 照舊掛 document.body；沿用既有 `vela-pine-*` CSS class 命名慣例。

**Done when:**
- 點 Pine 鈕開 modal → header 顯示 `[Pine Editor] [Untitled script ▾] [Add to chart] [Save] [⋯] [—] [✕]`，statusbar 顯示 `Line 1, Col 1` + `Pine Script v6`
- textarea 打字 → 檔名右邊出現 `●`（dirty dot）；Ctrl+S 或 Save → Untitled 變成命名對話框、存檔後 `●` 消失、檔名更新
- ▾ 展開 → 選單依序列出 `Save script (Ctrl+S) / Make a copy… / Rename… / Version history… / ─ / Create new ▸ / ─ / Recently used（library MRU ≤4）/ ─ / Open script… (Ctrl+O)`
- `Make a copy` → library 多一筆 `Copy of X`；`Rename` → 改 library name；`Create new` → 目前只有 `Indicator` `Strategy` 兩個模板（TV 有 Library 等我們不支援，只給有的）
- `Version history` → 列出該腳本的 `versions[]`（最新的在上面），點一版載回 textarea 並標 dirty
- `Open script` → Task 3 的 dialog（本期先接一個簡易 confirm-list：點名字載入；Task 3 才做完整搜尋 UI）
- Escape/overlay click 在 dirty 時要 confirm「未儲存變更將遺失」
- `pnpm vitest run` 不破既有測試；手動 smoke：開 /vela → Pine → 建一支腳本 → Save → 關再開 → Recently used 有它

- [ ] **Step 1: 重寫 `openEditor` 骨架**

```ts
// velaPineEditor.ts — replace the whole openEditor() body.
// Anchor: `function openEditor(ctx: WidgetContext, initialSrc = "", editingId?: string): void {`

import {
  pineLibCreate, pineLibGet, pineLibSave, pineLibRename, pineLibDuplicate,
  pineLibRecent, pineLibSubscribe, pineLibMigrateLegacyHist,
} from '../pine/lib/pineLib.ts';

type EditorState = { currentId: string | null; dirty: boolean; handleId?: string };
let editorState: EditorState = { currentId: null, dirty: false };

export function openPineEditorWithScript(ctx: WidgetContext, scriptId: string): void {
  const s = pineLibGet(scriptId);
  if (!s) return;
  editorState.currentId = s.id;
  openEditor(ctx, s.source);
}
```

（`openEditor` 本體保持，但內部把所有「hist*」改讀 `pineLib*`；檔名按鈕 = `editorState.currentId ? pineLibGet(currentId).name : 'Untitled script'`。dirty 追蹤用 `area.addEventListener('input', …)`。）

- [ ] **Step 2: header DOM（TV 順序）**

```ts
// 在 dialog 頂部組一列 .vela-pine-headbar
const headbar = doc.createElement('div');
headbar.className = 'vela-pine-headbar';
// [Pine Editor] [⟨name⟩ ▾] [Add to chart] [⭮] [Save] [⋯] [—] [✕]
const nameBtn = doc.createElement('button');
nameBtn.className = 'vela-pine-namebtn';
const nameLabel = doc.createElement('span');
nameLabel.className = 'vela-pine-namelabel';
const nameCaret = doc.createElement('span');
nameCaret.textContent = '▾';
const dirtyDot = doc.createElement('span');
dirtyDot.className = 'vela-pine-dirty';
dirtyDot.textContent = '●';
dirtyDot.style.visibility = 'hidden';
nameBtn.append(nameLabel, dirtyDot, nameCaret);
// Add to chart = 舊的 runBtn 改名
// Save = 新：saveScript()
// ⋯ = new window/tab placeholder → disabled，title 'coming in phase 3'
// — = collapse → closeModal 但留一份 draft 到 sessionStorage key 'opencharts.pine.draft'
// ✕ = closeModal
```

- [ ] **Step 3: name dropdown（TV 順序）**

```ts
function buildNameMenu(): HTMLElement {
  const menu = doc.createElement('div');
  menu.className = 'vela-pine-menu';
  const item = (label: string, shortcut: string | null, onClick: () => void) => {
    const row = doc.createElement('button');
    row.className = 'vela-pine-menuitem';
    const l = doc.createElement('span'); l.textContent = label;
    const s = doc.createElement('span'); s.className = 'vela-pine-menukey'; s.textContent = shortcut ?? '';
    row.append(l, s);
    row.addEventListener('click', () => { closeNameMenu(); onClick(); });
    return row;
  };
  const sep = () => { const d = doc.createElement('div'); d.className = 'vela-pine-menusep'; return d; };
  const header = (t: string) => { const d = doc.createElement('div'); d.className = 'vela-pine-menuhead'; d.textContent = t; return d; };

  menu.append(
    item('Save script', 'Ctrl + S', saveScript),
    item('Make a copy…', null, makeCopy),
    item('Rename…', null, renameScript),
    item('Version history…', null, openVersionHistory),
    item('Move script to bottom', null, () => {/* phase-3 stub: no-op or modal dock toggle */}),
    sep(),
    item('Create new ▸', null, openCreateNew),       // submenu: Indicator / Strategy
    sep(),
    header('Recently used'),
  );
  for (const id of pineLibRecent().slice(0, 4)) {
    const s = pineLibGet(id);
    if (s) menu.append(item(s.name, null, () => openScriptInEditor(s)));
  }
  menu.append(sep(), item('Open script…', 'Ctrl + O', openScriptsDialog));
  return menu;
}
```

- [ ] **Step 4: Save / Save As / Rename / Duplicate 動作**

```ts
function saveScript() {
  const src = area.value;
  if (!editorState.currentId) {
    const name = prompt('Script name', scriptTitle(src, 'Untitled script')) ?? '';
    if (!name.trim()) return;
    const s = pineLibCreate(name.trim(), src);
    editorState.currentId = s.id;
  } else {
    pineLibSave(editorState.currentId, src);
  }
  editorState.dirty = false;
  refreshName();
}
function makeCopy() {
  if (!editorState.currentId) { status('先 Save 才能複製'); return; }
  pineLibSave(editorState.currentId, area.value); // capture current edits first
  const c = pineLibDuplicate(editorState.currentId);
  editorState.currentId = c.id;
  area.value = c.source;
  refreshName();
}
function renameScript() {
  if (!editorState.currentId) return;
  const cur = pineLibGet(editorState.currentId)!;
  const name = prompt('Rename script', cur.name);
  if (name?.trim()) { pineLibRename(editorState.currentId, name.trim()); refreshName(); }
}
```

- [ ] **Step 5: Version history dialog**

```ts
function openVersionHistory() {
  if (!editorState.currentId) { status('尚未儲存，沒有版本'); return; }
  const s = pineLibGet(editorState.currentId)!;
  // modal-on-modal: 簡易清單（新版在上），點一版 → area.value = v.src; dirty=true
  // UI 只到「列出 + 載回」；diff 顯示不在本期
}
```

- [ ] **Step 6: statusbar**

```ts
const statusbar = doc.createElement('div');
statusbar.className = 'vela-pine-statusbar';
const cursorPos = doc.createElement('button');   // "Line 1, Col 1"
const verLabel = doc.createElement('a');
verLabel.textContent = 'Pine Script v6';
verLabel.href = 'https://www.tradingview.com/pine-script-reference/v6/';
verLabel.target = '_blank';
// cursorPos 每 200ms 從 textarea.selectionStart 算 line/col 更新
```

- [ ] **Step 7: CSS（加到 `PINE_CSS`）**

```css
.vela-pine-headbar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid #222}
.vela-pine-namebtn{display:flex;align-items:center;gap:6px;background:none;border:0;color:#ddd;padding:4px 8px;font-size:13px;cursor:pointer;border-radius:4px}
.vela-pine-namebtn:hover{background:#1c1f26}
.vela-pine-dirty{color:#f0b90b;font-size:10px}
.vela-pine-menu{position:fixed;background:#1e222d;border:1px solid #363c4e;border-radius:6px;padding:4px 0;min-width:240px;z-index:10000;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.vela-pine-menuitem{display:flex;justify-content:space-between;width:100%;background:none;border:0;color:#ccc;padding:6px 14px;font-size:13px;cursor:pointer;text-align:left}
.vela-pine-menuitem:hover{background:#2a2e39}
.vela-pine-menukey{color:#787b86;font-size:11px}
.vela-pine-menusep{height:1px;background:#363c4e;margin:4px 0}
.vela-pine-menuhead{color:#787b86;font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:6px 14px 2px}
.vela-pine-statusbar{display:flex;justify-content:space-between;align-items:center;padding:4px 10px;border-top:1px solid #222;color:#787b86;font-size:11px}
```

- [ ] **Step 8: 手動 smoke + commit**

```bash
# /vela → Pine 鈕 → 建腳本 → 打「indicator("test")」→ Ctrl+S 命名 → 關 → 再開 → Recently used 有
git add src/pages/velaPineEditor.ts
git commit -m "feat(pine): TV-parity editor chrome — file menu, save/copy/rename, version history, statusbar"
```

---

## Task 3: Open script dialog（Ctrl+O）

**Blocked by:** Task 2

**Files:**
- Create: `src/pages/velaPineScriptsDialog.ts`（獨立檔，openEditor 呼叫它）

**Interfaces:**
- Consumes: `pineLibList`, `pineLibGet`, `openPineEditorWithScript`（Task 2 export）
- Produces: `export function openScriptsDialog(ctx: WidgetContext, onPick: (id: string) => void): void`

**Done when:**
- Ctrl+O 或檔名▾→Open script 開 dialog：搜尋列（篩 name）、清單（name、updatedAt、versions count）、點 row 載入
- 每列有 ★ 收藏（存 `opencharts.pine.fav`，先簡單存 id set）＋ ⋯（Rename/Duplicate/Delete）
- Escape/點外關閉
- 空庫時顯示「還沒有腳本 — 按 Create new 開始」

- [ ] **Step 1: dialog DOM**

```ts
// velaPineScriptsDialog.ts — modal overlay（同 editor 的 pattern）
// layout: [search input] / [list rows] / footer [Close]
// row: [name] [mtime] [★] [⋯ menu: Rename | Make a copy | Delete]
```

- [ ] **Step 2: wire into editor's name menu + Ctrl+O**

```ts
// velaPineEditor.ts — in buildNameMenu(), Open script 項目改呼叫：
import { openScriptsDialog } from './velaPineScriptsDialog';
item('Open script…', 'Ctrl + O', () => openScriptsDialog(ctx, (id) => {
  const s = pineLibGet(id);
  if (s) { editorState.currentId = s.id; area.value = s.source; editorState.dirty = false; refreshName(); }
}))
```

- [ ] **Step 3: smoke + commit**

```bash
git add src/pages/velaPineScriptsDialog.ts src/pages/velaPineEditor.ts
git commit -m "feat(pine): scripts browser dialog with search, favorites, row actions"
```

---

## Task 4: Indicators manifest 併入我的腳本

**Blocked by:** Task 1

**Files:**
- Modify: `src/pineScripts.ts`（加 `loadUserScriptsIntoManifest()`）
- Modify: `src/pages/VelaPage.tsx`（VelaWorkspace ctor `indicators` 從靜態 manifest 改成 async loader 合併使用者庫）

**Interfaces:**
- Produces: `export async function combinedManifest(): Promise<IndicatorManifest>` — `src/pine/*.pine`（內建唯讀）+ `pineLibList()`（使用者）

**Done when:**
- `combinedManifest()` 回傳 `[...src/pine entries, ...lib entries]`，使用者腳本 category = 'My scripts'
- Indicators picker 的 My scripts 分類能看到存的腳本，點名載入

- [ ] **Step 1: manifest merge**

```ts
// pineScripts.ts — append:
import { pineLibList } from './pine/lib/pineLib.ts';
export function combinedManifestEntries(): PineManifestEntry[] {
  const mine = pineLibList().map(s => ({
    name: s.name, script: s.source, language: 'pine' as const, category: 'My scripts',
  }));
  return [...loadPineManifest(), ...mine];
}
```

- [ ] **Step 2: VelaPage 接 loader**

```ts
// VelaPage.tsx — ctor options:
indicators: async () => combinedManifestEntries(),
```

- [ ] **Step 3: smoke + commit**

```bash
git add src/pineScripts.ts src/pages/VelaPage.tsx
git commit -m "feat(pine): merge user script library into indicators manifest"
```

---

## Task 5: Legend ⋯ → 源碼（TV 的通路）

**Blocked by:** Task 2（需要 `openPineEditorWithScript`）

**Files:**
- Modify: `src/pages/velaPineEditor.ts` — 把既有 `registerLegendAction({id:'edit-in-pine'})` 換成 `registerLegendCallout`，callout 開 panel 裡放按鈕清單

**Interfaces:**
- Consumes: `openPineEditorWithScript`；`registerLegendCallout`（Vela API，已驗證存在）
- Produces: none new

**Done when:**
- 任何圖上 Pine 指標的 legend 列出現 ⋯ 氣泡 → 點開 panel 顯示 `Edit source code`、`Make a copy`、`Move to pane`（沿用既有 move）、`Remove`
- `Edit source code` → 開 editor 載入該指標的 source（若其 `name` 在 library 有 match → `currentId` 設為該筆；否則 Untitled + source 貼入）
- 既有 edit/move 圖示保留（TV 也有並存的 eye/gear/⋯）

- [ ] **Step 1: 換成 callout**

```ts
// velaPineEditor.ts — replace the registerLegendAction('edit-in-pine') block:
registerLegendCallout({
  id: 'pine-more',
  order: 90,
  callout: (ind) => ind.source ? {
    icon: 'ellipsis',                  // registerIcon('ellipsis', …) if missing
    title: 'More',
    content: {
      title: ind.title,
      items: [
        { type: 'button', label: 'Edit source code', primary: true, run: (c, i) => {
            const h = c.chart.indicators().find(x => x.id === i.id);
            const match = pineLibList().find(s => s.source === h?.source);
            if (match) openPineEditorWithScript(c, match.id);
            else { editorState.currentId = null; openEditor(c, h?.source ?? '', i.id); }
          } },
        { type: 'button', label: 'Move to pane', run: (c, i) => { /* existing move logic */ } },
        { type: 'button', label: 'Remove', run: (c, i) => { c.chart.indicators().find(x => x.id === i.id)?.remove?.(); } },
      ],
    },
  } : null,
});
```

- [ ] **Step 2: icon 檢查 + commit**

```bash
# 如果 'ellipsis' 不在 icon registry，先 registerIcon({id:'ellipsis', markup:'<svg…>…'})
git add src/pages/velaPineEditor.ts
git commit -m "feat(pine): legend ⋯ callout → Edit source code / Move to pane / Remove"
```

---

## 後續階段（本期不做，記錄在 recon）

- **Phase 2**：Indicators dialog 改版成分類 rail（Favorites/My scripts/Built-In 分頁 + 搜尋列 + 作者/讚表格）— 對齊 TV Indicators dialog
- **Phase 3**：⋯ 選單（Editor settings / Command Palette / Pine logs / Profiler / New window）＋ Publish（站外，可能永遠 N/A）＋ Move script to bottom（真 dock）
- **Phase 4**：Editor settings（字體/縮排/自動儲存）、import/export `.pine`、script diff viewer

---

## Task 6: Legend ⋯ — 完整 TV 指標右鍵選單（使用者截圖對齊）

**Blocked by:** Task 5（callout 已通；把 3 項目換成完整 15 項 TV 選單）

**TV 實機選單（使用者截圖 2026-10-07，指標 `FVG高量V1.42 + VWAP` 的 ⋯/右鍵）：**

```
為 FVG高量V1.42 + VWAP 新增快訊…        Alt + A
在 FVG高量V1.42 + VWAP 上增加指標/策略…
將此指標增加到整個版面
☆ 將此指標新增至收藏夾
─────────────────
視覺順序 ▸                  (submenu)
時間週期的可見性 ▸          (submenu)
移動到 ▸                    (submenu)
固定至刻度(當前在Z) ▸       (submenu)
─────────────────
原始碼…
─────────────────
複製                       Ctrl + C
隱藏
移除                       Del
─────────────────
物件樹
─────────────────
設定…
```

**檔案：**
- Modify: `src/pages/velaPineEditor.ts` — `registerLegendCallout` 的 `content.items`
- Modify: `src/pine/lib/pineLib.ts` — 加 `pineLibCopySource(id)` helper（clipboard write）

**限制：`LegendCalloutContent.items` 是 flat list（`{type:'button'|'text'}`），不支援 nested submenu。** ▸ 項先折成次級 panel：點「視覺順序 ▸」開另一個 callout（同一個 descriptor，用一個 `submenuState` 變數換 items）。

**Done when:**
- ⋯ 點開 panel 依序列出全部 15 項（含分隔線用 `{type:'text', text:'───'}` 或 items 陣列分段）
- 原始碼… → 開 editor 載入該指標 source（Pine script 可編輯，native 唯讀）
- 複製 → `navigator.clipboard.writeText(ind.source)` → toast「已複製」
- 隱藏 → `handle.setVisible(false)`；移除 → `handle.remove()`
- 設定… → `ctx.chart.indicators().find(id).openSettings?.()`（Vela 有 `openIndicatorSettings` renderer hook，callout ctx 應有 `openIndicatorSettings` 或走 inputsUI）
- 快訊/收藏夾/物件樹/固定至刻度/時間週期/增加指標 —— 先列項目 disabled，tooltip 標「phase 3」；**不可省略列出**（TV 選單的完整形狀）
- 快訊：TV 需要 alerting engine，我們沒有 → disabled + tooltip
- 收藏夾：接 `opencharts.pine.fav`（script dialog 已用同一 key）；點了 toggle → 文字變 ★/☆
- 物件樹：Vela 有 `registerSidePanel`？開一個 object-tree side panel 列出該指標的 drawings/series —— 先 stub
- 設定… → 指標 inputs dialog（Vela 內建 `openIndicatorSettings(indicatorId)`，callout ctx 應能 reach）
- 複製 = `navigator.clipboard.writeText(source)`，TV 的 Ctrl+C 在 callout 關閉後無作用域 → 照 TV 只給選單項

- [ ] **Step 1: 改 `callout.items` 為完整 15 項**

```ts
// velaPineEditor.ts — replace the content.items array.
// For natives (ind.source === undefined): 原始碼/複製/設定 disabled, text says so.
items: [
  { type: 'button', label: `為 ${ind.title} 新增快訊…`, run: () => {}, /* disabled: no alert engine */ },
  { type: 'button', label: `在 ${ind.title} 上增加指標/策略…`, run: () => {/* open Add dialog filtered */} },
  { type: 'button', label: '將此指標增加到整個版面', run: (c) => {/* duplicate handle to all cells */} },
  { type: 'button', label: isFav(ind.id) ? '★ 從收藏夾移除' : '☆ 將此指標新增至收藏夾', run: () => toggleFav(ind.id) },
  { type: 'text', text: '───' },
  { type: 'button', label: '視覺順序 ▸', run: (c) => openSubMenu('visual', c, ind) },      // phase 3 stub
  { type: 'button', label: '時間週期的可見性 ▸', run: () => {}, /* disabled */ },
  { type: 'button', label: '移動到 ▸', run: (c) => openSubMenu('pane', c, ind) },
  { type: 'button', label: '固定至刻度 ▸', run: () => {}, /* disabled */ },
  { type: 'text', text: '───' },
  { type: 'button', label: '原始碼…', primary: true, run: (c, i) => {/* existing edit flow */} },
  { type: 'text', text: '───' },
  { type: 'button', label: '複製', run: (c, i) => void navigator.clipboard?.writeText(i.source ?? '') },
  { type: 'button', label: '隱藏', run: (c, i) => { c.chart.indicators().find(x => x.id === i.id)?.setVisible?.(false); } },
  { type: 'button', label: '移除', run: (c, i) => { c.chart.indicators().find(x => x.id === i.id)?.remove?.(); } },
  { type: 'text', text: '───' },
  { type: 'button', label: '物件樹', run: () => {/* phase 3: object-tree side panel */} },
  { type: 'text', text: '───' },
  { type: 'button', label: '設定…', run: (c, i) => { c.chart.openIndicatorSettings?.(i.id); } },
]
```

- [ ] **Step 2: smoke**

```bash
# legend ⋯ 點開 → 15 項全列出；原始碼 → editor 開；複製 → clipboard 有 source；移除 → 指標消失
git add src/pages/velaPineEditor.ts
git commit -m "feat(pine): full TV legend context menu (15 items) in ⋯ callout"
```
