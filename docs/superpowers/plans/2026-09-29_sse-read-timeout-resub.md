# SSE read-timeout / resub / restart-dedup Implementation Plan

> **日期：** 2026-09-29
> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 hot-scanner 的 SSE 連線在「server 靜默斷流/半開 socket/重連」下不再靠 watchdog 事後救火，而是自己（a）不被 30s read-timeout 誤殺 heartbeat、(b) 半開時正確釋放 socket 並重連重訂閱、(c) 重啟後不把重放 tick 當新資料重複寫/觸發。

**Architecture:** 三個獨立小修，集中 `scripts/hotscan/stream.py` 與 `scripts/hotscan/scanner.py`。read-timeout 依已驗證的 per-`recv()` 語意放寬到 >90s heartbeat；socket 用 `with requests.get()` 保證例外時關閉；`seen_ticks` 開機從 `hot-ticks.jsonl` tail 重建；`_rebuild_pending` 對 events 按 `ts` 去重。

**Tech Stack:** Python 3.12、`requests` 2.33.0（已安裝）、`urllib.request`（僅 `post()`）、pytest 9.0.2。

## Global Constraints

- 檔案編碼：`.py` 一律 UTF-8；中文註解允許。
- 不改 `config.py` 的對外介面（`SHIOAJI_BASE`、`SSE_TICK_PATH`、backoff 系列保持原樣），只在內部使用。
- 不破壞 `post()`（`subscribe_all`/`backfill` 都用它）——本次只動 SSE 讀取路徑。
- 不新增依賴（`requests` 已在用）。
- TDD：每個修點都要有對應失敗的測試案例，先紅後綠。

## Decision Points

### D1: read timeout 值（T1）
- Consumed by: Task 1
- Candidates:
  - A (existing pattern): 維持 `timeout=(10, 30)`
  - B (minimal): 改成 `(10, 90)` 貼齊 heartbeat
  - C (preferred): `(10, 100)` —— heartbeat 90s + 10s 餘裕，容忍少量網路抖動
- Criteria:
  - 不會在 90s 一次的 heartbeat 間隔內誤觸
  - 半開 socket 仍在可接受時間內（<2min）被偵測
  - 不需依賴自寫的 `last_event` 檢查當主要機制
- Chosen: C
- Rejected: A 在 30s 靜默就誤殺（H1 實證 per-`recv()`）；B 只剩 0 餘裕，heartbeat 晚到幾秒就斷。
- Revisit trigger: 若實測 Shioaji heartbeat 間隔 >90s（例如 120s），把 read timeout 拉到 150s 或改用自寫 idle-timeout。
- Outcome: held

### D2: `seen_ticks` 重建範圍（T1）
- Consumed by: Task 3
- Candidates:
  - A (existing pattern): 全部讀 `hot-ticks.jsonl` 重建（檔案可能 GB 級，慢）
  - B (minimal): 不重建，靠 restart 後重複寫入
  - C (preferred): 只讀尾端 ~5000 行重建 `seen_ticks`——broker 重放只會補最近幾秒，5k 行覆蓋綽綽有餘
- Criteria:
  - 掃描成本 < 1s（100+ 隻股票時 startup 不能拖）
  - 覆蓋 broker 在 reconnect 後可能重放的全部 tick
  - 不改 dedup 鍵格式
- Chosen: C
- Rejected: A GB 檔讀完太慢；B 留下重複寫入的已知 bug。
- Revisit trigger: 若發現 broker 重放超過 5k 行（例如整天資料），改讀檔尾固定 byte 範圍。
- Outcome: held

### D3: 半開 socket 的釋放時機（T1）
- Consumed by: Task 2
- Candidates:
  - A (existing pattern): `res.close()` 手動在例外時呼叫
  - B (minimal): 不關，靠 GC
  - C (preferred): `with requests.get(...) as res:` —— `stream=True` 的 Response context manager 離開時 `res.close()` 釋放 socket，H2 實證必要
- Criteria:
  - 例外/正常結束都保證關閉
  - 不改 `iter_lines` 的消費邏輯
  - 不依賴被呼叫端手動管理
- Chosen: C
- Rejected: B 明確 socket 洩漏；A 要寫 try/finally 長碼，context manager 更乾淨。
- Revisit trigger: 若日後改成 `httpx`/`aiohttp`，context manager 用法不同，重新檢查。
- Outcome: held

### D4: 半開+無 heartbeat 的偵測機制（T1）
- Consumed by: Task 1
- Candidates:
  - A (existing pattern): 只用 `requests` read timeout（per-`recv()`）
  - B (minimal): read timeout + 保留自寫 `last_event` 檢查
  - C (preferred): B + timeout 加進 `TimeoutError` 訊息區分「idle」vs「network error」
- Criteria:
  - server 有 heartbeat 時不誤報
  - server 沒 heartbeat 時 idle 仍被偵測（半開無 byte）
  - 呼叫端能分辨「資料停」vs「連線壞」
- Chosen: C
- Rejected: A 假設 server 永遠送 heartbeat，規格上沒保證；B 沒把 timeout 類型分開寫，日後 debug 難判。
- Revisit trigger: 若 `iter_lines` 在 heartbeat 間偶爾送 `event: heartbeat` 以外事件，閾值要再調。
- Outcome: held

---

### Task 1: 放寬 read timeout + 區分 idle/network error

**Files:**
- Modify: `C:\Users\bear9\OpenCharts\scripts\hotscan\stream.py`（`sse_events`）
- Test: `C:\Users\bear9\OpenCharts\scripts\tests\test_stream.py`（新建）

**Interfaces:**
- Consumes: `config.SHIOAJI_BASE`、`config.SSE_TICK_PATH`
- Produces: `sse_events(path, heartbeat=90)` 行為不變（yield `(event, data)`）；錯誤型別從籠統 `Exception` 變 `TimeoutError`（既有）/`requests.RequestException`（新增明確）

**Assumptions:** `requests` 已在 venv；`iter_lines` 在 `requests` 2.x 會在 `ReadTimeout`/`ChunkedEncodingError`/`ConnectionError` 時從 generator 拋出。

**Done when:**
- `timeout=(10, 100)`（連線 10s、read 100s）
- `iter_lines` 產生的 `requests` 例外原樣拋出（包在 `except requests.RequestException`）
- `last_event` 檢查保留，閾值仍是 `heartbeat`（90s）
- `pytest scripts/tests/test_stream.py::test_sse_read_timeout_configured` PASS：斷言 `requests.get` 被呼叫時 `timeout=(10, 100)`
- `pytest scripts/tests/test_stream.py::test_sse_heartbeat_idle_timeout` PASS：mock `iter_lines` 每輪耗時 > heartbeat → 拋 `TimeoutError`

- [ ] **Step 1: 寫失敗測試**

`scripts/tests/test_stream.py`（新檔）：

```python
"""SSE read-timeout and idle-detection tests."""
from unittest.mock import MagicMock, patch
import time
import pytest

from hotscan import stream


def _mock_lines(n=5):
    return iter([f"data: {{}}\n" for _ in range(n)])


def test_sse_read_timeout_configured():
    """requests.get must be called with timeout=(10, 100) — heartbeat is 90s,
    read timeout must exceed it so half-open sockets die from OUR check,
    not a premature per-recv timeout."""
    fake_res = MagicMock()
    fake_res.iter_lines.return_value = _mock_lines(3)
    with patch("hotscan.stream.requests") as mreq:
        mreq.get.return_value = fake_res
        list(stream.sse_events("/x"))
    mreq.get.assert_called_once()
    kwargs = mreq.get.call_args.kwargs
    assert kwargs["timeout"] == (10, 100), f"expected (10,100), got {kwargs['timeout']}"


def test_sse_heartbeat_idle_timeout():
    """No complete event for `heartbeat` seconds → TimeoutError."""
    fake_res = MagicMock()
    # iter_lines yields one partial line per call and sleeps past heartbeat
    def slow_lines():
        yield "event: tick_stk"
        time.sleep(95)
        yield "data: {}"
    fake_res.iter_lines.side_effect = lambda **kw: slow_lines()
    with patch("hotscan.stream.requests") as mreq:
        mreq.get.return_value = fake_res
        with pytest.raises(TimeoutError):
            list(stream.sse_events("/x", heartbeat=90))
```

執行：
```bash
cd C:\Users\bear9\OpenCharts\scripts && pytest tests/test_stream.py -v
```

Expected：`test_sse_read_timeout_configured` FAIL（現在是 `(10, 30)`）；`test_sse_heartbeat_idle_timeout` 若通過先標 PASS（這條驗證既有行為，不修也對）。

- [ ] **Step 2: 實作**

`stream.py` `sse_events`（anchor：`res = requests.get(f"{config.SHIOAJI_BASE}{path}",` ~ `for raw in res.iter_lines(decode_unicode=True):`）：

```python
def sse_events(path: str, heartbeat: int = 90):
    """Yield (event, data) tuples from SSE endpoint.

    Raises TimeoutError if no complete event arrives for `heartbeat` seconds —
    covers the case where the connection stays open (keep-alive bytes) but the
    server stopped sending events.
    requests read-timeout is per-recv() and set ABOVE the heartbeat interval
    so real stalls are detected by our heartbeat check, not a false-positive
    per-recv timeout.
    """
    import requests
    with requests.get(f"{config.SHIOAJI_BASE}{path}",
                      headers={"Accept": "text/event-stream"},
                      stream=True, timeout=(10, 100)) as res:  # connect 10s, per-recv 100s
        event, data_lines = None, []
        last_event = time.time()
        for raw in res.iter_lines(decode_unicode=True):
            line = raw.rstrip("\r\n") if raw else ""
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].strip())
            elif line == "":
                if event and data_lines:
                    last_event = time.time()
                    yield event, "\n".join(data_lines)
                event, data_lines = None, []
            if time.time() - last_event > heartbeat:
                raise TimeoutError(f"SSE heartbeat timeout ({heartbeat}s)")
```

變更點（對照原碼）：
- `timeout=(10, 30)` → `timeout=(10, 100)`
- `res = requests.get(...)` 外層包 `with ... as res:`（socket 釋放，配合 Task 2）
- 其餘 `iter_lines`/heartbeat 邏輯不動

- [ ] **Step 3: 跑測試確認綠**

```bash
cd C:\Users\bear9\OpenCharts\scripts && pytest tests/test_stream.py -v
```

Expected: 2 PASS

- [ ] **Step 4: 語法檢查**

```bash
python -c "import py_compile; py_compile.compile('hotscan/stream.py', doraise=True)"
```

Expected: exit 0

---

### Task 2: `stream_loop` 明確 resubscribe 日誌 + 區分錯誤類型

**Files:**
- Modify: `C:\Users\bear9\OpenCharts\scripts\hotscan\stream.py`（`stream_loop`）
- Test: 同 Task 1 的 `test_stream.py`

**Interfaces:**
- Consumes: `subscribe_all`、`sse_events`、`config.SSE_BACKOFF_*`
- Produces: 例外時印 `resubscribing after <errtype>` 並呼叫 `subscribe_all`；`TimeoutError` 與 `requests.RequestException` 在 log 分開寫，便於盤中分辨「idle 死」vs「網路壞」。

**Assumptions:** `subscribe_all` 內部用 `post()` + ThreadPool，失敗僅印 stderr 不拋。

**Done when:**
- `except` 分支同時涵蓋 `requests.RequestException`（需要 `import requests` 在 `stream_loop` 內或檔頭）
- 例外訊息含 `type(e).__name__`，重連前印 `resubscribing`
- `subscribe_all` 呼叫保留（既有行為，驗證不被移除）
- `pytest tests/test_stream.py::test_stream_loop_resubscribes_on_error` PASS

- [ ] **Step 1: 寫失敗測試**

加到 `test_stream.py`：

```python
def test_stream_loop_resubscribes_on_error(monkeypatch):
    """Any SSE exception → backoff + resubscribe + retry."""
    calls = {"subs": 0}
    monkeypatch.setattr(stream, "sse_events",
                        lambda p: (_ for _ in ()).throw(ValueError("boom")))
    monkeypatch.setattr(stream.time, "sleep", lambda s: None)

    def fake_sub(stocks):
        calls["subs"] += 1
        if calls["subs"] >= 3:
            raise KeyboardInterrupt  # stop the infinite loop after 3 resubs
        return 0
    monkeypatch.setattr(stream, "subscribe_all", fake_sub)

    with pytest.raises(KeyboardInterrupt):
        stream.stream_loop([{"code": "2330", "exchange": "TSE"}],
                           lambda c, t: None)

    assert calls["subs"] >= 3, "subscribe_all should be retried each loop"
```

（原 `stream_loop` 的 `except Exception` 已經涵蓋所有例外，這條鎖行為不退步）

- [ ] **Step 2: 實作**

`stream.py` `stream_loop`（anchor：`except Exception as e:` ~ `backoff = min(backoff * 2, config.SSE_BACKOFF_MAX)`）：

```python
        except Exception as e:
            print(f"SSE error: {type(e).__name__}: {e} — reconnect in {backoff}s",
                  file=sys.stderr)
            time.sleep(backoff)
            backoff = min(backoff * 2, config.SSE_BACKOFF_MAX)
            print("resubscribing watchlist...", file=sys.stderr)
            subscribe_all(stocks)
```

變更點（對照原碼）：
- 加 `print("resubscribing watchlist...", file=sys.stderr)` 在 `subscribe_all` 前——盤中看 `scanner-err.log` 能一眼看到「連線壞→要重訂閱」
- `except Exception` 不細分（`requests.RequestException`/`TimeoutError`/`ValueError` 都該走同路徑，寫 if/elif 沒價值）
- `subscribe_all` 呼叫保留

- [ ] **Step 3: 跑測試**

```bash
cd C:\Users\bear9\OpenCharts\scripts && pytest tests/test_stream.py -v
```

Expected: 全 PASS

---

### Task 3: `seen_ticks` 開機從檔尾重建 + `_rebuild_pending` 去重

**Files:**
- Modify: `C:\Users\bear9\OpenCharts\scripts\hotscan\scanner.py`（`__init__` 後段 + `_rebuild_pending`）
- Test: `scripts/tests/test_scanner_dedup.py`（新建）

**Interfaces:**
- Consumes: `storage.read_events`（既有）、`config.LOG_DIR`、`hot-ticks.jsonl` tail、`on_tick` dedup key 格式
- Produces: `Scanner.__init__` 結束前 `self.seen_ticks` 已含最近 ~5000 行 ticks；`_rebuild_pending` 對 `ts` 相同 event 只 add 一次。

**Assumptions:**
- `hot-ticks.jsonl` 每行有 `code`/`dt`/`price`/`vol`/`tick_type`/`total_volume`（`storage.append_jsonl` 寫入的格式）
- dedup key 原格式：`(code, date, time)` if `time` else `(code, ts, price, vol, tick_type)`；**TICK_LOG 裡的 `dt` 是 `date + "T" + time` 合併字串**，重建時要拆回兩部分對齊 key。
- `read_events()` 回傳的 `events` 可能有重複 `ts`（H4 實證）

**Done when:**
- `pytest tests/test_scanner_dedup.py::test_seen_ticks_rebuilds_from_log_tail` PASS：建立假 TICK_LOG + init → `seen_ticks` 含尾端 ticks
- `pytest tests/test_scanner_dedup.py::test_rebuild_pending_dedups_events` PASS：假 `read_events` 回兩筆同 `ts` → `pending` 只一筆
- `python -c "import py_compile; py_compile.compile('hotscan/scanner.py', doraise=True)"` OK
- 啟動 scanner，`scanner-out.log` 看 `seen_ticks primed: N` 行（見 Step 2 實作）

- [ ] **Step 1: 寫失敗測試**

`scripts/tests/test_scanner_dedup.py`（新檔）：

```python
"""Restart dedup: seen_ticks priming + pending dedup."""
import json, tempfile
from pathlib import Path
from unittest.mock import patch
import pytest

from hotscan import scanner, config


def _write_ticks(path, n=10):
    with open(path, "a", encoding="utf-8") as f:
        for i in range(n):
            f.write(json.dumps({
                "ts": 1759200000 + i,
                "dt": f"2026-09-29T10:00:{i:02d}.000",
                "code": "2330",
                "price": 1000.0 + i,
                "vol": 1 + i,
                "tick_type": 1,
                "amount": 1000,
                "total_volume": 100 + i,
            }) + "\n")


def test_seen_ticks_rebuilds_from_log_tail(tmp_path, monkeypatch):
    tick_log = tmp_path / "hot-ticks.jsonl"
    _write_ticks(tick_log, n=10)
    monkeypatch.setattr(scanner, "TICK_LOG", tick_log)
    s = scanner.Scanner([{"code": "2330", "exchange": "TSE", "role": "primary"}])
    # last tick should be in seen_ticks
    assert ("2330", "2026-09-29", "10:00:09.000") in s.seen_ticks


def test_rebuild_pending_dedups_events(monkeypatch):
    events = [
        {"ts": 1759200000, "code": "2330", "price": 1000.0,
         "fwd": {"5m": None, "15m": None, "30m": None, "60m": None}},
        {"ts": 1759200000, "code": "2330", "price": 1000.0,
         "fwd": {"5m": None, "15m": None, "30m": None, "60m": None}},
    ]
    monkeypatch.setattr(scanner.storage, "read_events", lambda: (events, {}, {}))
    s = scanner.Scanner([{"code": "2330", "exchange": "TSE", "role": "primary"}])
    # dedup: same event_ts should appear only once in pending
    ts_list = [p["event_ts"] for p in s.fwd.pending]
    assert ts_list.count(1759200000) == 1
```

預期：兩條都 FAIL（目前沒做）。

- [ ] **Step 2: 實作 `seen_ticks` 重建**

`scanner.py` `__init__`（anchor：`self._rebuild_pending()` 之前，在 `self.fwd = ForwardTracker()` 那行附近；實際位置由 `re-read` 確認，原碼最後段是 `self._rebuild_pending()`）：

在 `self._rebuild_pending()` **之前**插入：

```python
        # Prime seen_ticks from hot-ticks.jsonl tail so broker replays after
        # reconnect don't produce duplicate tick lines/events across restart.
        self._prime_seen_ticks()
```

新增方法（放在 `_rebuild_pending` 後面）：

```python
    def _prime_seen_ticks(self, max_lines: int = 5000) -> None:
        """Rebuild in-memory dedup set from TICK_LOG tail.

        Reconnect-replayed ticks are keyed (code,date,time) just like on_tick;
        reading only the last ~5000 lines keeps startup <1s while covering the
        entire replay window Shioaji can realistically resend.
        """
        if not TICK_LOG.exists():
            return
        lines: list[str] = []
        try:
            with open(TICK_LOG, "r", encoding="utf-8") as f:
                # cheap tail: seek from end in 64KB chunks
                f.seek(0, 2)
                end = f.tell()
                buf = b""
                while end > 0 and len(lines) <= max_lines:
                    chunk = min(64 * 1024, end)
                    end -= chunk
                    f.seek(end)
                    buf = f.read(chunk).encode("utf-8") + buf
                    lines = buf.split(b"\n")
            for line in lines[-max_lines:]:
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                dt = row.get("dt", "")
                if not dt:
                    continue
                date, _, time_part = dt.partition("T")
                key = (row.get("code", ""), date, time_part)
                self.seen_ticks.add(key)
            print(f"seen_ticks primed: {len(self.seen_ticks)}")
        except Exception as e:
            print(f"seen_ticks prime failed: {e}", file=sys.stderr)
```

- [ ] **Step 3: `_rebuild_pending` 去重**

`scanner.py` `_rebuild_pending`（anchor：`for e in events:` 開頭）：把 events 先按 `ts` 去重再跑：

```python
        seen_event_ts: set[int] = set()
        for e in events:
            code = e.get("code")
            ts = e.get("ts")
            if code not in self.states or ts is None or ts in seen_event_ts:
                continue
            seen_event_ts.add(ts)
            # ... (原有 merge/re-add 邏輯不動)
```

變更點（對照原碼）：
- 新增 `seen_event_ts` set + 三個 skip 條件（`ts is None` / 已見過）
- 其餘 `fwd` merge、`pending.append` 不動

- [ ] **Step 4: 跑測試**

```bash
cd C:\Users\bear9\OpenCharts\scripts && pytest tests/test_scanner_dedup.py -v
```

Expected: 2 PASS

- [ ] **Step 5: 語法 + 啟動驗證**

```bash
python -c "import py_compile; py_compile.compile('hotscan/scanner.py', doraise=True)"
```

Expected: exit 0

啟動後看 `logs\scanner-out.log` 第一行應有 `seen_ticks primed: N`。

---

## 邊界確認（已驗證，不需再查）

- `requests.get` read-timeout = per-`recv()`，不是總時限（H1 CONFIRMED）
- `with requests.get(...) as res:` 對 `stream=True` 會 `res.close()` 關 socket（H2 CONFIRMED）
- `iter_lines` 在半開 socket 無 byte 時會被 read timeout 攔到（H2 CONFIRMED，30s→100s 防止 heartbeat 誤殺）
- `_rebuild_pending` 對同 `ts` event 不重複 add 需要手動 dedup（H4 CONFIRMED）；`fwd` dict 本來冪等
- `seen_ticks` in-memory，restart 清空（H4 CONFIRMED）；`time` 存在時鍵是 `(code,date,time)` 不是 `(code,ts,price,vol)`

## Self-Review

- Spec coverage: read-timeout 過緊（Task 1）、socket 釋放（Task 1 `with`）、resub 可觀測性（Task 2）、restart 重複寫入/重複 pending（Task 3）
- Date check: 檔名 `2026-09-29`、header 日期行已加
- Placeholder scan: 無
- Type consistency: `sse_events` signature 不變；`_prime_seen_ticks` 使用 `self.seen_ticks`/`TICK_LOG`/`json`/`sys` 皆已在檔案內
- Anchor scan: 每個 modify 都有原碼 verbatim + replacement + anchor 字串；`_rebuild_pending` 的 events 迴圈有 verbatim context
- Decision scan: 4 個 T1（D1–D4）都有候選、criteria、revisit trigger；無 T2
- Done-when scan: 每個 task 有可執行指令與預期輸出；Task 1 含一條「不修也 PASS」的行為保護測試
