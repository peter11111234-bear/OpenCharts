// Flag-path probe: prints compile() invocations for one run so the
// interpreted-vs-compiled A/B is observable without a profiler.
import { pathToFileURL } from 'url';
const repo = 'C:/Users/bear9/OpenCharts';
const I = await import(pathToFileURL(repo + '/src/pine/interpreter.ts'));
const { parse } = await import(pathToFileURL(repo + '/src/pine/parser.ts'));
await import(pathToFileURL(repo + '/src/pine/builtins/index.ts'));
const bars = [
  { openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  { openTime: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
];
const before = I.__compileCalls;
await I.runScript(parse('indicator("t")\nplot(close)'), bars, {});
console.log('PINE_INTERP=' + (process.env.PINE_INTERP || ''), 'compileCalls+', I.__compileCalls - before);
