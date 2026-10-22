import importlib.util
from datetime import datetime, timedelta
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "fop_tick_recorder", Path(__file__).resolve().parent.parent / "fop-tick-recorder.py")
rec = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rec)


def _tick(code):
    return {"code": code, "date": "2026-10-22", "time": "21:00:01.5", "close": "46000", "volume": 1}


def test_records_only_micro_taiex(monkeypatch):
    monkeypatch.setattr(rec, "bars", {})
    monkeypatch.setattr(rec, "dirty", set())
    assert rec.add_tick(_tick("TMFK6")) is True
    assert rec.add_tick(_tick("TMFL6")) is True   # 換月後照樣錄
    assert rec.add_tick(_tick("MXFK6")) is False  # 小台不錄（/vela 只看微台）
    assert set(rec.bars) == {"TMFK6", "TMFL6"}


def test_prune_deletes_tick_logs_older_than_keep_days(tmp_path, monkeypatch):
    monkeypatch.setattr(rec, "LOG_DIR", tmp_path)
    today = datetime.now(rec.TAIPEI).date()
    names = [f"fop-ticks-{today - timedelta(days=d):%Y%m%d}.jsonl" for d in range(rec.KEEP_DAYS + 3)]
    for n in names:
        (tmp_path / n).write_text("")
    (tmp_path / "other.log").write_text("")
    rec.prune_logs()
    kept = sorted(p.name for p in tmp_path.iterdir())
    assert kept == sorted(names[:rec.KEEP_DAYS + 1] + ["other.log"])
