"""Entry point: python -m hotscan [--date YYYY-MM-DD] [--report]"""

import argparse
import sys
from pathlib import Path

# allow running as `python -m hotscan` from scripts/ or project root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hotscan import scanner, storage  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(prog="hotscan")
    ap.add_argument("--date", help="watchlist date YYYY-MM-DD")
    ap.add_argument("--report", action="store_true", help="print event summary")
    args = ap.parse_args()

    if args.report:
        storage.print_report()
        return 0

    scanner.run(args.date)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
