"""Byte-compare every code block in the plan against the repo file it names.

Walks the plan's '- [ ] **Step N: ... **' headings, takes the fenced code
block that follows each, and compares it byte-for-byte with the target file
named in the heading.
"""
import re
import sys

PLAN = "docs/superpowers/plans/2026-10-21-vela-mcp-server.md"
lines = open(PLAN, encoding="utf-8").read().split("\n")

# (heading regex, target file) in plan order.
TARGETS = [
    (r"\*\*Step 1: Write the test file exactly\*\*, `src/services/__tests__/velaMcpProtocol\.test\.ts`",
     "src/services/__tests__/velaMcpProtocol.test.ts"),
    (r"\*\*Step 3: Write `src/services/vela-mcp/mcpTools\.ts` exactly\*\*",
     "src/services/vela-mcp/mcpTools.ts"),
    (r"\*\*Step 4: Write `src/services/vela-mcp/protocol\.ts` exactly\*\*",
     "src/services/vela-mcp/protocol.ts"),
    (r"\*\*Step 1: Write the test file exactly\*\*, `src/services/__tests__/velaMcpBarsGate\.test\.ts`",
     "src/services/__tests__/velaMcpBarsGate.test.ts"),
    (r"\*\*Step 3: Write `src/services/vela-mcp/barsGate\.ts` exactly\*\*",
     "src/services/vela-mcp/barsGate.ts"),
    (r"\*\*Step 1: Write the test file exactly\*\*, `src/services/__tests__/velaMcpHandlers\.test\.ts`",
     "src/services/__tests__/velaMcpHandlers.test.ts"),
    (r"\*\*Step 3: Write `src/services/vela-mcp/handlers\.ts` exactly\*\*",
     "src/services/vela-mcp/handlers.ts"),
    (r"\*\*Step 1: Write the test file exactly\*\*, `src/services/__tests__/velaMcpBridge\.test\.ts`",
     "src/services/__tests__/velaMcpBridge.test.ts"),
    (r"\*\*Step 3: Write `src/services/vela-mcp/bridge\.ts` exactly\*\*",
     "src/services/vela-mcp/bridge.ts"),
    (r"\*\*Step 1: Create `src/pages/velaMcpClient\.ts` exactly\*\*",
     "src/pages/velaMcpClient.ts"),
]

results = []
for pattern, target in TARGETS:
    m = next((i for i, l in enumerate(lines) if re.search(pattern, l)), None)
    if m is None:
        results.append((target, "MISSING HEADING", ""))
        continue
    fence = next((i for i in range(m, len(lines)) if lines[i].startswith("````")), None)
    if fence is None:
        results.append((target, "NO FENCE", ""))
        continue
    end = next(i for i in range(fence + 1, len(lines)) if lines[i].startswith("````"))
    expected = ("\n".join(lines[fence + 1 : end]) + "\n").encode("utf-8")

    try:
        actual = open(target, "rb").read()
    except FileNotFoundError:
        results.append((target, "FILE MISSING", f"expected {len(expected)} bytes"))
        continue

    if actual == expected:
        results.append((target, "IDENTICAL", f"{len(actual)} bytes"))
    else:
        detail = ""
        for i, (a, b) in enumerate(zip(expected, actual)):
            if a != b:
                detail = f"first diff at byte {i}: plan {a!r} repo {b!r}"
                break
        if not detail:
            detail = f"length differs: plan {len(expected)} repo {len(actual)}"
        results.append((target, "DIFFERENT", detail))

ok = True
for target, status, detail in results:
    if status != "IDENTICAL":
        ok = False
    print(f"{status:10}  {target}  {detail}")

print()
print(f"{sum(1 for _, s, _ in results if s == 'IDENTICAL')}/{len(results)} IDENTICAL")
sys.exit(0 if ok else 1)
