import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hotscan import stream  # noqa: E402
from hotscan.scanner import TAIPEI  # noqa: E402


def _at(hh, mm):
    return datetime(2026, 10, 22, hh, mm, tzinfo=TAIPEI)


@pytest.mark.parametrize("hh,mm,expected", [
    (8, 29, False), (8, 30, True), (13, 39, True), (13, 40, False), (20, 0, False),
])
def test_in_session_day_window(monkeypatch, hh, mm, expected):
    monkeypatch.setenv("HOTSCAN_FAKE_TRADING_DAY", "1")
    assert stream.in_session(_at(hh, mm)) is expected


def test_in_session_false_on_closed_day(monkeypatch):
    monkeypatch.setenv("HOTSCAN_FAKE_TRADING_DAY", "0")
    assert stream.in_session(_at(10, 0)) is False


class _Idle(BaseException):  # 不被 stream_loop 的 except Exception 吞掉
    pass


def test_session_end_goes_idle_without_resubscribing(monkeypatch):
    """收盤後 SSE 逾時 → 不可再重訂閱 100 檔（會拖慢 :8080），要直接進待機。"""
    state = {"in": True}
    subs = []

    def fake_sse(path):
        state["in"] = False  # 連線期間日盤結束
        raise TimeoutError("no ticks")
        yield  # pragma: no cover

    def fake_sleep(sec):
        if not state["in"]:
            raise _Idle  # 進入待機輪詢 = 測試成功點
    monkeypatch.setattr(stream, "in_session", lambda now=None: state["in"])
    monkeypatch.setattr(stream, "sse_events", fake_sse)
    monkeypatch.setattr(stream, "subscribe_all", lambda stocks: subs.append(1) or 0)
    monkeypatch.setattr(stream.time, "sleep", fake_sleep)

    with pytest.raises(_Idle):
        stream.stream_loop([{"code": "2330", "exchange": "TSE"}], lambda c, t: None)
    assert subs == []


def test_wakes_and_resubscribes_when_session_opens(monkeypatch):
    state = {"in": False}
    subs = []

    def fake_sleep(sec):
        state["in"] = True  # 待機一輪後開盤

    def fake_sse(path):
        raise _Idle  # 重新連線 = 測試結束點
        yield  # pragma: no cover
    monkeypatch.setattr(stream, "in_session", lambda now=None: state["in"])
    monkeypatch.setattr(stream, "sse_events", fake_sse)
    monkeypatch.setattr(stream, "subscribe_all", lambda stocks: subs.append(1) or 0)
    monkeypatch.setattr(stream.time, "sleep", fake_sleep)

    with pytest.raises(_Idle):
        stream.stream_loop([{"code": "2330", "exchange": "TSE"}], lambda c, t: None)
    assert subs == [1]
