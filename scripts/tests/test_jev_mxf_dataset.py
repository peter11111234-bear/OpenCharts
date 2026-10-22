import importlib.util
import json
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "jev_shadow_mxf", Path(__file__).resolve().parent.parent / "jev-shadow.py")
js = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(js)


def test_mxf_goes_to_its_own_file_and_txf_keeps_the_old_one():
    assert js.log_for("MXFK6") == js.LOG_MXF
    assert js.log_for("MXFL6") == js.LOG_MXF
    assert js.log_for("TXFK6") == js.LOG
    assert js.LOG_MXF.name == "jev-shadow-mxf.jsonl"
    assert js.LOG.name == "jev-shadow.jsonl"


def test_logged_bar_times_does_not_cross_symbols(tmp_path):
    txf, mxf = tmp_path / "txf.jsonl", tmp_path / "mxf.jsonl"
    js.append_log({"bar_time": 1000, "symbol": "TXFK6", "answers": {"a": 1}}, txf)
    js.append_log({"bar_time": 1000, "symbol": "MXFK6", "answers": {"a": 1}}, mxf)
    js.append_log({"bar_time": 1300, "symbol": "MXFK6", "answers": None}, mxf)   # failed: stays pending
    assert js.logged_bar_times(txf) == {1000}
    assert js.logged_bar_times(mxf) == {1000}
    # a TXF-only bar must not make MXF skip it
    js.append_log({"bar_time": 1600, "symbol": "TXFK6", "answers": {"a": 1}}, txf)
    assert 1600 not in js.logged_bar_times(mxf)


def test_default_still_reads_the_txf_dataset(tmp_path, monkeypatch):
    f = tmp_path / "default.jsonl"
    f.write_text(json.dumps({"bar_time": 7, "answers": {"x": 1}}) + "\n", encoding="utf-8")
    monkeypatch.setattr(js, "LOG", f)
    assert js.logged_bar_times(f) == {7}


def test_front_month_rolls_within_mxf():
    assert js.contract_for("MXFK6")["code"] == "MXFK6"
    assert js.contract_for("MXFL6") == {"security_type": "FUT", "exchange": "TAIFEX", "code": "MXFL6"}
