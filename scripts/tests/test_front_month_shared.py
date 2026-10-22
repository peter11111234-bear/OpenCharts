"""Shared front-month cases: jev-shadow.py must match the web frontMonth.ts rules.

The case file is the single source of truth for all three implementations
(web vitest, pytest, PowerShell -SelfTest).
"""
import importlib.util
import json
from datetime import datetime
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parent.parent
_SPEC = importlib.util.spec_from_file_location("jev_shadow_fm_shared", _SCRIPTS / "jev-shadow.py")
js = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(js)

CASES = json.loads((_SCRIPTS / "front_month_cases.json").read_text(encoding="utf-8"))


def _now(case):
    return datetime.fromisoformat(case["now_taipei"]).replace(tzinfo=js.TAIPEI)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_pick_front_month_matches_shared_cases(case):
    pick = js.pick_front_month(case["info"], case["rule_code"], _now(case))
    assert pick["code"] == case["expect_code"]
    assert pick["source"] == case["expect_source"]
    assert bool(pick["warning"]) is bool(case["expect_warning"])


def test_fetch_r1_info_returns_none_when_unreachable(monkeypatch):
    def boom(*_args, **_kwargs):
        raise OSError("connection refused")

    monkeypatch.setattr(js.urllib.request, "urlopen", boom)
    assert js.fetch_r1_info("TXF") is None


def test_fetch_r1_info_reads_target_code_and_last_trading_date(monkeypatch):
    payload = json.dumps({"code": "TXFR1", "target_code": "TXFK6",
                          "last_trading_date": "2026-11-18", "tick": 1}).encode()

    class FakeRes:
        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

        def read(self):
            return payload

    seen = {}

    def fake_urlopen(url, timeout=None):
        seen["url"] = url
        seen["timeout"] = timeout
        return FakeRes()

    monkeypatch.setattr(js.urllib.request, "urlopen", fake_urlopen)
    assert js.fetch_r1_info("TXF") == {"target_code": "TXFK6", "last_trading_date": "2026-11-18"}
    assert seen["url"].endswith("/api/v1/data/contracts/TXFR1/info")
    assert seen["timeout"] == 5
