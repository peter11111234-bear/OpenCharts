#!/usr/bin/env node
/**
 * quiet-gate.mjs — T3／T4 安靜機前置檢查（**唯讀**：不啟動、不重啟、不停止任何服務）
 *
 * 用途：R5 的 T3／T4 量測要求「連續 3 次 CPU 負載 < 25%（門檻）」。本腳本取樣 CPU
 * busy% 並統計干擾來源（node／python 程序數、行情與 Vite 服務埠），最後給 PASS/NOISY
 * 判定與可直接複製的 T3／T4 量測指令。
 *
 * 用法：
 *   cd /c/Users/bear9/OpenCharts && node scripts/perf/quiet-gate.mjs
 *   （可用 npx tsx 亦可；本檔不 import 引擎，純 os/child_process）
 *   --samples N   取樣次數（預設 3，規格要求「連續 3 次」）
 *   --seconds S   每次取樣秒數（預設 5）
 *   --threshold T 門檻 %（預設 25）
 */
import { execSync } from 'node:child_process';
import os from 'node:os';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const SAMPLES = flag('samples', 3);
const SECONDS = flag('seconds', 5);
const THRESHOLD = flag('threshold', 25);

/** CPU busy% = 100 - idle/total，用兩次 os.cpus() tick 快照的差值（Windows 亦適用）。 */
const cpuBusy = (ms) => new Promise((resolve) => {
  const snap = () => os.cpus().map((c) => ({ ...c.times }));
  const a = snap();
  setTimeout(() => {
    const b = snap();
    let idle = 0, total = 0;
    for (let i = 0; i < b.length; i++) {
      for (const k of Object.keys(b[i])) { const d = b[i][k] - a[i][k]; total += d; if (k === 'idle') idle += d; }
    }
    resolve(total === 0 ? 0 : 100 * (1 - idle / total));
  }, ms);
});

const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const countProcs = (image) => {
  const out = sh(`tasklist /FI "IMAGENAME eq ${image}" /FO CSV /NH`);
  return out.split(/\r?\n/).filter((l) => l.trim().startsWith('"')).length;
};
const portUp = (port) => /LISTENING/.test(sh(`netstat -ano | findstr LISTENING | findstr :${port}`));

const main = async () => {
  console.log(`quiet-gate: samples=${SAMPLES} x ${SECONDS}s, threshold=${THRESHOLD}%  (CPU cores=${os.cpus().length})\n`);
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    process.stdout.write(`  sample ${i + 1}/${SAMPLES} measuring ${SECONDS}s ... `);
    const v = await cpuBusy(SECONDS * 1000);
    samples.push(v);
    console.log(`${v.toFixed(1)}%  ${v < THRESHOLD ? 'ok' : 'OVER'}`);
  }
  const median = [...samples].sort((x, y) => x - y)[Math.floor(samples.length / 2)];
  const max = Math.max(...samples);

  const procs = { node: countProcs('node.exe'), python: countProcs('python.exe'), pwsh: countProcs('powershell.exe') };
  const ports = { 8080: portUp(8080), 5173: portUp(5173), 8787: portUp(8787) };

  console.log(`\nCPU: samples=[${samples.map((v) => v.toFixed(1)).join(', ')}]%  median=${median.toFixed(1)}%  max=${max.toFixed(1)}%`);
  console.log(`processes: node=${procs.node} python=${procs.python} powershell=${procs.pwsh}`);
  console.log(`services  : shioaji:8080=${ports[8080] ? 'UP' : 'down'}  vite:5173=${ports[5173] ? 'UP' : 'down'}  jev:8787=${ports[8787] ? 'UP' : 'down'}`);

  const pass = samples.every((v) => v < THRESHOLD);
  console.log(`\nVERDICT: ${pass ? 'PASS（連續 ' + SAMPLES + ' 次皆 < ' + THRESHOLD + '%）' : 'NOISY（有取樣 >= ' + THRESHOLD + '%）'}`);
  if (!pass) {
    console.log('  干擾來源排序＝CPU 取樣 > ' + THRESHOLD + '%；先看上面的程序數與服務埠：');
    console.log('  - node 程序多（>5）⇒ 多半是探針／代理殘留；請人工確認後再關（本腳本不會動任何程序）');
    console.log('  - shioaji:8080 / vite:5173 UP ⇒ 行情與前端在跑（量測期間屬預期噪音；是否停用請你決定）');
    console.log('  - 若 over 仍想量，請在報告標 NOISY，不要宣稱效能結論（R5 規則）');
  }
  console.log(`
===== 閘門通過後的量測指令（不動任何服務）=====
T3（4 支腳本 500 根 repeat 5；記 median/min-max/NOISY 與當時程序數）:
  cd /c/Users/bear9/OpenCharts && npx tsx scripts/perf/pine-bench.mjs \\
    --script scratch/perf/app-scripts/script-a1dcdea6-95114.pine \\
    --script src/pine/TRIS390.pine \\
    --script "C:/Users/bear9/high452/MACDV7.04/MACD701_v72.pine" \\
    --script final.pine --bars 500 --repeat 5

T4（A6 增量 tick 預算：每 tick 中位 ms 與 cold/inc 倍率）:
  cd /c/Users/bear9/OpenCharts && npx tsx scratch/perf/s1-inc-probe.mjs --script src/pine/TRIS390.pine --bars 500 --ticks 5
  （K55 以同一探針換 --script；門檻：每 tick 中位 <= 100 ms 且 增量 <= cold / 10）

判定門檻（docs/2026-10-15-r5-fix-plan.md）: K55 >= 50% / TRIS390 >= 40% / MACD701_v72 >= 30%
  ＋ 硬條件：四支 digest 逐字相同、golden 0 差異、A4 <= 2.2
（A4 = app 與 direct 兩路徑的 setAt/evalNodeCounts 比值）
`);
  process.exitCode = pass ? 0 : 1;
};

await main();
