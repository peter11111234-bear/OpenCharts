// Throwaway extractor: pulls the Pine v6 standard-library metadata out of the
// official reference bundle (static.tradingview.com/static/bundles/42609.*.js)
// and writes docs/tv-pine-stdlib.json with provenance.
//
// Usage:  node scratch/_extract_tv_stdlib.mjs <bundle.js> <out.json> [sourceUrl]
//
// The bundle is minified JS; entries look like
//   {name:"log.info",desc:[…],args:[{name:"message",…,allowedTypeIDs:[…],
//    displayType:"series string"}],syntax:["log.info(message) → void"],
//    returnedTypes:["void"]}
// Localised text is replaced by numeric string ids (a.t(null,void 0,n(123))),
// which stay unresolved here on purpose: this file records the *surface*
// (names, arity, argument names, accepted types, returns), not the prose.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [, , inPath, outPathArg, sourceUrlArg] = process.argv;
if (!inPath || !outPathArg) {
  console.error('usage: node _extract_tv_stdlib.mjs <bundle.js|--auto> <out.json> [sourceUrl]');
  console.error('       --auto re-discovers the bundle from the live reference page');
  process.exit(2);
}
const outPath = outPathArg;

const REFERENCE_PAGE = 'https://www.tradingview.com/pine-script-reference/v6/';
const MARKER = '{name:"log.info"';

/** The reference manual ships as one hashed chunk that the SPA loads lazily, so
 *  it is NOT among the script tags in the page HTML. The webpack runtime chunk
 *  carries the full chunk-id → hash map; --auto rebuilds every chunk URL and
 *  probes them in parallel batches, keeping the first one that carries the
 *  manual entries. (The CDN exposes no Content-Length/Range totals, so the
 *  chunks cannot be ordered by size first.) */
async function discoverBundle() {
  const page = await (await fetch(REFERENCE_PAGE)).text();
  const pageUrls = [...new Set(page.match(/https:\/\/static\.tradingview\.com\/static\/bundles\/[^"']+\.js/g) ?? [])];
  const runtimeUrl = pageUrls.find((u) => /\/runtime\.[0-9a-f]+\.js$/.test(u));
  if (!runtimeUrl) throw new Error('no webpack runtime chunk on the reference page');
  const runtime = await (await fetch(runtimeUrl)).text();
  const ids = [...runtime.matchAll(/(\d{4,6}):"([0-9a-f]{20})"/g)];
  if (ids.length === 0) throw new Error('no chunk map in the runtime chunk');
  const urls = ids.map((m) => `https://static.tradingview.com/static/bundles/${m[1]}.${m[2]}.js`);
  console.log(`chunk map: ${urls.length} chunks — probing for the manual`);
  for (let i = 0; i < urls.length; i += 16) {
    const batch = urls.slice(i, i + 16);
    const bodies = await Promise.all(batch.map(async (u) => {
      try {
        return { u, body: await (await fetch(u)).text() };
      } catch {
        return null;
      }
    }));
    for (const b of bodies) {
      if (b !== null && b.body.includes(MARKER)) {
        console.log(`found ${b.u} (${b.body.length} bytes)`);
        return { text: b.body, url: b.u };
      }
    }
  }
  throw new Error('no chunk carries the manual entries');
}

let src;
let sourceUrl = sourceUrlArg ?? '';
if (inPath === '--auto') {
  const found = await discoverBundle();
  src = found.text;
  sourceUrl = found.url;
} else {
  src = readFileSync(inPath, 'utf8');
  sourceUrl ||= 'https://static.tradingview.com/static/bundles/42609.fa300c285969f3bef9d0.js';
}

/** Index just past the string starting at `i` (src[i] is the quote). */
function skipString(s, i) {
  const q = s[i];
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === q) return i + 1;
    i++;
  }
  return i;
}

/** Index of the `]`/`}` matching the opener at `i`, ignoring string contents. */
function matchBracket(s, i) {
  const open = s[i];
  const close = open === '{' ? '}' : open === '[' ? ']' : open === '(' ? ')' : null;
  if (!close) return -1;
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(s, i); continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/** Quoted strings inside a bracketed literal. */
const quoted = (s) => (s.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map((x) => JSON.parse(x));

const entries = [];
const re = /\{\s*name:"([A-Za-z_][A-Za-z0-9_.]*)"\s*,/g;
for (let m; (m = re.exec(src)); ) {
  const end = matchBracket(src, m.index);
  if (end < 0) continue;
  const seg = src.slice(m.index, end + 1);

  const argsStart = seg.indexOf('args:[');
  const args = [];
  if (argsStart >= 0) {
    const argsEnd = matchBracket(seg, argsStart + 5);
    const argsSeg = argsEnd > 0 ? seg.slice(argsStart + 5, argsEnd + 1) : '';
    for (const am of argsSeg.matchAll(/\{\s*name:"([^"]+)"/g)) {
      const aEnd = matchBracket(argsSeg, am.index);
      const aSeg = aEnd > 0 ? argsSeg.slice(am.index, aEnd + 1) : '';
      const types = /allowedTypeIDs:\[([^\]]*)\]/.exec(aSeg);
      const display = /displayType:"([^"]*)"/.exec(aSeg);
      args.push({
        name: am[1],
        types: types ? quoted(`[${types[1]}]`) : [],
        display: display ? display[1] : null,
        required: /required:!0/.test(aSeg),
      });
    }
  }

  const syntax = /syntax:\[([^\]]*)\]/.exec(seg);
  const returned = /returnedTypes:\[([^\]]*)\]/.exec(seg);
  const orig = /originalName:"([^"]+)"/.exec(seg);
  const thisType = /thisType:\[([^\]]*)\]/.exec(seg);
  entries.push({
    name: m[1],
    // Method overloads carry the qualified name in `originalName` (e.g. the
    // entry named `abs` with syntax `array.abs(id)` has originalName
    // `array.abs`); `qualified` is the name to look up.
    qualified: orig ? orig[1] : m[1],
    thisType: thisType ? quoted(`[${thisType[1]}]`) : [],
    syntax: syntax ? quoted(`[${syntax[1]}]`) : [],
    returns: returned ? quoted(`[${returned[1]}]`) : [],
    args,
  });
  re.lastIndex = end;
}

const out = {
  source: {
    page: 'https://www.tradingview.com/pine-script-reference/v6/',
    bundle: sourceUrl,
    sha256: createHash('sha256').update(src).digest('hex'),
    extracted: new Date().toISOString().slice(0, 10),
  },
  note: 'Pine v6 standard-library surface (names, arity, argument names, accepted types, returns) as shipped in the official reference bundle. Prose is localised and deliberately not included.',
  count: entries.length,
  uniqueNames: [...new Set(entries.map((e) => e.qualified))].length,
  functions: entries,
};
writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`entries=${out.count} unique=${out.uniqueNames} sha256=${out.source.sha256.slice(0, 16)}… -> ${outPath}`);
