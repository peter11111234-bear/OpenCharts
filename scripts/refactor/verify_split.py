"""Acceptance check for split_interpreter.py (phase 1).

Proves the split moved code without changing it:
  1. Every line of interpreter.ts at the base commit appears exactly once
     across interpreter.ts + astUtil.ts + scriptDecl.ts, in the same order
     within each file — ignoring only the `export ` prefixes and import /
     re-export lines the split is allowed to add or drop.
  2. Nothing else in src/pine changed relative to the base commit.

Usage (repo root):  python -I scripts/refactor/verify_split.py
"""
import pathlib
import subprocess
import sys

BASE = "ec232c7"
PINE = pathlib.Path("src/pine")
NEW = ["astUtil.ts", "scriptDecl.ts"]
ALLOWED_ADDED = {
    "import { isNum, numVal, stmtMayExitTop, walkNodes } from './astUtil';",
    "import { collectInputs, declOverlay, declProps, declShortTitle, declTitle } from './scriptDecl';",
    "export { astChildren } from './astUtil';",
    "export { collectInputs } from './scriptDecl';",
}
ALLOWED_DROPPED = {"  type InputSchemaLite,"}
EXPORTED = {"isNum", "numVal", "stmtMayExitTop", "walkNodes",
            "declTitle", "declShortTitle", "declOverlay", "declProps"}


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True,
                          text=True, encoding="utf-8").stdout


def lines(path: pathlib.Path) -> list[str]:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").split("\n")


def strip_header(body: list[str]) -> list[str]:
    # New modules start with comment + import header, then a blank line.
    for i, ln in enumerate(body):
        if ln == "" and i > 0 and body[i - 1].startswith("import "):
            return body[i + 1:]
    sys.exit("verify: could not find end of module header")


def unexport(ln: str) -> str:
    for name in EXPORTED:
        if ln.startswith(f"export function {name}("):
            return ln[len("export "):]
    return ln


def main() -> None:
    fails = []
    base = git("show", f"{BASE}:src/pine/interpreter.ts").replace("\r\n", "\n").split("\n")

    now_interp = [ln for ln in lines(PINE / "interpreter.ts") if ln not in ALLOWED_ADDED]
    moved = {f: [unexport(ln) for ln in strip_header(lines(PINE / f))] for f in NEW}

    # 1a. interpreter.ts must be base minus moved lines, order preserved.
    pool = [ln for ln in base if ln not in ALLOWED_DROPPED]
    it = iter(pool)
    for ln in now_interp:
        for b in it:
            if b == ln:
                break
        else:
            fails.append(f"interpreter.ts line not found in base order: {ln!r}")
            break

    # 1b. each moved file must be a contiguous-or-ordered subsequence of base.
    for f, body in moved.items():
        it = iter(base)
        for ln in body:
            if ln == "":
                continue
            for b in it:
                if b == ln:
                    break
            else:
                fails.append(f"{f}: line not in base order: {ln!r}")
                break

    # 1c. line accounting: nothing lost, nothing duplicated (non-blank lines).
    def count(xs: list[str]) -> dict[str, int]:
        c: dict[str, int] = {}
        for x in xs:
            if x.strip():
                c[x] = c.get(x, 0) + 1
        return c
    want = count(pool)
    got = count(now_interp + moved["astUtil.ts"] + moved["scriptDecl.ts"])
    for k in set(want) | set(got):
        if want.get(k, 0) != got.get(k, 0):
            fails.append(f"line count differs ({want.get(k, 0)} -> {got.get(k, 0)}): {k[:100]!r}")

    # 2. no other file under src/pine changed.
    changed = [p for p in git("diff", "--name-only", BASE, "--", "src/pine").split()
               if p != "src/pine/interpreter.ts"]
    untracked = [p for p in git("ls-files", "--others", "--exclude-standard", "src/pine").split()
                 if p not in {f"src/pine/{f}" for f in NEW} and "graphify-out" not in p]
    if changed or untracked:
        fails.append(f"unexpected src/pine changes: {changed + untracked}")

    if fails:
        print("VERIFY FAILED")
        for f in fails[:30]:
            print("  -", f)
        sys.exit(1)
    print("VERIFY OK: moved verbatim, no lines lost or duplicated, no other src/pine changes")


if __name__ == "__main__":
    main()
