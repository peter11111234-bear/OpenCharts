"""Mechanical split of src/pine/interpreter.ts — phase 1.

Moves pure helpers VERBATIM into two new modules; the only edits to moved
text are an `export ` prefix on named top-level functions. Nothing is retyped.

  src/pine/astUtil.ts    isNum, numVal, astChildren, stmtMayExitTop, walkNodes
  src/pine/scriptDecl.ts declArgValue..staticLit, collectInputs

Usage (repo root):  python -I scripts/refactor/split_interpreter.py
Refuses to run unless interpreter.ts matches the pinned base hash.
"""
import hashlib
import pathlib
import sys

ROOT = pathlib.Path.cwd()
SRC = ROOT / "src/pine/interpreter.ts"
BASE_SHA256 = "5627bf5b708a55bbbace983e8f535c826ef3aebbf462d889d00b28b2c19bc7ab"  # ec232c7

# (target, start line text, end line text) — start inclusive, end exclusive,
# both matched as exact whole lines and required to be unique.
BLOCKS = [
    ("astUtil", "function isNum(v: Value): v is { kind: 'int' | 'float'; v: number } {",
     "/** Builtins may hand back `{kind:'series'}`; interpreter ops read the current bar. */"),
    ("astUtil", "/** Child nodes of an AST node (skips scalars like loc/type/name). Shared",
     " * The BarSeries backing a declaration. `persistent` slots (var decls —"),
    ("scriptDecl", "// ── script declaration (indicator/strategy) ───────────────────────────────────",
     "/** Generic recursive AST walker (Arg / case / elseIf wrappers handled)."),
    ("astUtil", "/** Generic recursive AST walker (Arg / case / elseIf wrappers handled).",
     "// ── interpreter-owned constants ───────────────────────────────────────────────"),
]

# Top-level functions that become exported in their new home.
EXPORT = {
    "astUtil": ["isNum", "numVal", "stmtMayExitTop", "walkNodes"],
    "scriptDecl": ["declTitle", "declShortTitle", "declOverlay", "declProps"],
}

HEADER = {
    "astUtil": """// AST + numeric-value helpers shared by interpreter.ts, scriptDecl.ts and
// mtf.ts. Pure: no interpreter state. Moved verbatim from interpreter.ts
// (2026-10-22 split, phase 1).

import type { Node, Value } from './contracts';

""",
    "scriptDecl": """// Static scans of a parsed script: indicator()/strategy() declaration args
// and the prepare-time input.* schema. Pure: no interpreter state. Moved
// verbatim from interpreter.ts (2026-10-22 split, phase 1).

import { NA, VFALSE, VTRUE, type Arg, type IndicatorDecl, type InputSchemaLite, type Node, type StrategyDecl, type Value } from './contracts';
import { getConstant } from './builtins/registry';
import { isNum, numVal, walkNodes } from './astUtil';

""",
}

IMPORT_ANCHOR = "import { jitCompile, jitCompileUdf } from './jit';"
# Only the moved code used this type; tsc (noUnusedLocals) rejects the leftover.
IMPORT_DROP = "  type InputSchemaLite,"
IMPORT_ADD = [
    "import { isNum, numVal, stmtMayExitTop, walkNodes } from './astUtil';",
    "import { collectInputs, declOverlay, declProps, declShortTitle, declTitle } from './scriptDecl';",
]
REEXPORT_ANCHOR = "export { PineRuntimeError } from './errors';"
REEXPORT_ADD = [
    "export { astChildren } from './astUtil';",
    "export { collectInputs } from './scriptDecl';",
]


def die(msg: str) -> None:
    sys.exit(f"split_interpreter: {msg}")


def find_unique(lines: list[str], text: str) -> int:
    hits = [i for i, ln in enumerate(lines) if ln == text]
    if len(hits) != 1:
        die(f"anchor matched {len(hits)} times (need 1): {text!r}")
    return hits[0]


def span(lines: list[str], start: str, end: str) -> tuple[int, int]:
    a, b = find_unique(lines, start), find_unique(lines, end)
    # An end anchor on a doc comment's first text line leaves the comment's
    # `/**` opener with the next (unmoved) declaration.
    if lines[b - 1] == "/**":
        b -= 1
    if b <= a:
        die(f"end anchor before start for {start!r}")
    return a, b


def main() -> None:
    raw = SRC.read_bytes()
    # Hash with LF endings so a CRLF checkout of the same commit still matches.
    if hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest() != BASE_SHA256:
        die("interpreter.ts is not the pinned base (ec232c7) — someone changed it; stop and report")
    for name in HEADER:
        if (SRC.parent / f"{name}.ts").exists():
            die(f"src/pine/{name}.ts already exists")
    text = raw.decode("utf-8")
    eol = "\r\n" if "\r\n" in text else "\n"
    lines = text.split(eol)

    spans = []
    for target, start, end in BLOCKS:
        a, b = span(lines, start, end)
        spans.append((a, b, target))
    spans.sort()
    for (a1, b1, _), (a2, _b2, _t) in zip(spans, spans[1:]):
        if a2 < b1:
            die("blocks overlap")

    moved: dict[str, list[str]] = {k: [] for k in HEADER}
    # Emit in BLOCKS order so each module reads top-down like the original.
    for target, start, end in BLOCKS:
        a, b = span(lines, start, end)
        moved[target].extend(lines[a:b])
    keep = [ln for i, ln in enumerate(lines) if not any(a <= i < b for a, b, _ in spans)]

    for target, names in EXPORT.items():
        body = moved[target]
        for name in names:
            idx = [i for i, ln in enumerate(body) if ln.startswith(f"function {name}(")]
            if len(idx) != 1:
                die(f"{target}: expected one `function {name}(`, found {len(idx)}")
            body[idx[0]] = "export " + body[idx[0]]

    del keep[find_unique(keep, IMPORT_DROP)]
    i = find_unique(keep, IMPORT_ANCHOR)
    keep[i + 1:i + 1] = IMPORT_ADD
    i = find_unique(keep, REEXPORT_ANCHOR)
    keep[i + 1:i + 1] = REEXPORT_ADD

    for target, body in moved.items():
        while body and body[-1] == "":
            body.pop()
        out = HEADER[target].replace("\n", eol) + eol.join(body) + eol
        (SRC.parent / f"{target}.ts").write_bytes(out.encode("utf-8"))
    SRC.write_bytes(eol.join(keep).encode("utf-8"))
    for target, body in moved.items():
        print(f"src/pine/{target}.ts: {len(body)} lines moved")
    print(f"src/pine/interpreter.ts: {len(lines)} -> {len(keep)} lines")


if __name__ == "__main__":
    main()
