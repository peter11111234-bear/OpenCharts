// ── Monaco-backed Pine editor surface ────────────────────────────────────────
// TradingView's own Pine Editor is Monaco (`monaco-editor pine-editor-monaco`
// in the /chart DOM). This module mirrors that stack: same editor core, a
// `pine` Monarch tokenizer, namespace-aware completions (fed from the real
// builtin registry so suggestions stay in sync with the interpreter), and
// squiggly diagnostics from the shared lexer/parser.
//
// LAZY BOUNDARY: callers load this module via `await import('./pineMonaco.ts')`
// only when the Pine action opens, so the main bundle doesn't pay monaco's
// ~3MB on startup. Everything INSIDE this file is a static import — builtins
// and parser are already in the graph via the pine engine, and dynamic
// importing monaco from here would only defer it past the editor mount.
//
// No text-based/JS-specific monaco features are imported — only the editor
// core — so Vite doesn't pull JSON/CSS/TS workers. `editor.worker` is the only
// web worker spawned.
// `?worker` + `new URL(pkg/..., import.meta.url)` both break against monaco's
// exports map: the worker entry resolves but rollup emits it as a relative
// path. The prebuilt self-contained worker lives at public/monaco/editor.worker.js
// and we point MonacoEnvironment.getWorkerUrl at it — same file dev + prod.
import type * as monacoApi from 'monaco-editor';
import { parse } from './parser.ts';
import { BUILTINS, CONSTANTS } from './builtins/index.ts';

declare global {
  // monaco-editor ships this global; vite's bundler types don't declare it on
  // `self` so we widen the Window interface once here.
  interface Window { MonacoEnvironment?: monacoApi.Environment }
}

type Monaco = typeof monacoApi;

let monacoPromise: Promise<Monaco> | null = null;

function loadMonaco(): Promise<Monaco> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      // MonacoEnvironment must be set BEFORE the first editor.create(). We
      // serve the self-contained worker from public/ so the URL is identical
      // in dev and production builds.
      self.MonacoEnvironment = { getWorkerUrl: () => '/monaco/editor.worker.js' };
      const m = await import('monaco-editor');
      registerPineLanguage(m);
      return m;
    })();
    // A rejected import must not be cached forever — transient load failures
    // (network blip on a fresh chunk) would otherwise kill the editor for the
    // whole session.
    monacoPromise.catch(() => { monacoPromise = null; });
  }
  return monacoPromise;
}

// ── Language definition ──────────────────────────────────────────────────────
const KEYWORDS: readonly string[] = [
  'if', 'else', 'for', 'in', 'to', 'while', 'switch', 'break', 'continue',
  'return', 'var', 'varip', 'import', 'export', 'method', 'type', 'and', 'or',
  'not', 'true', 'false', 'na', 'const',
];
const TYPE_NAMES: readonly string[] = [
  'int', 'float', 'bool', 'string', 'color', 'line', 'label', 'box', 'table',
  'polyline', 'linefill', 'series', 'simple', 'input', 'const',
];
// Builtin namespace heads — derived from the registry (BUILTINS + CONSTANTS)
// so it can't drift from the engine's real surface. `ident` followed by `.`
// is colored via the `ns` tokenizer state, so the member lands as `type` too.
const NAMESPACE_HEADS: Record<string, true> = Object.fromEntries(
  [...new Set([...BUILTINS.keys(), ...CONSTANTS.keys()].map((k) => k.split('.')[0]!))]
    .map((head) => [head, true] as const),
);

const DECL_SNIPPETS: ReadonlyArray<{ label: string; insert: string }> = [
  { label: 'indicator', insert: 'indicator("${1:My script}"${2:, overlay=true})' },
  { label: 'strategy', insert: 'strategy("${1:My strategy}"${2:, overlay=true})' },
];

let registered = false;

function registerPineLanguage(monaco: Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: 'pine' });

  const monarch: monacoApi.languages.IMonarchLanguage = {
    defaultToken: '',
    keywords: [...KEYWORDS],
    typeKeywords: [...TYPE_NAMES],
    tokenizer: {
      root: [
        [/\/\/@.*$/, 'annotation'],                       // //@version=6
        [/\/\/.*$/, 'comment'],
        [/"([^"\\]|\\.)*$/, 'string.invalid'],            // unterminated
        [/"/, { token: 'string.quote', next: '@string' }],
        [/0[xX][0-9a-fA-F]+\b/, 'number.hex'],
        [/\d+(\.\d+)?([eE][+-]?\d+)?\b/, 'number'],
        // `ident` immediately before `.` → namespace head, push `ns` state so
        // the member after the dot colors as builtin/type too.
        [/[a-zA-Z_]\w*(?=\.)/, 'type', '@ns'],
        [/[a-zA-Z_]\w*/, {
          cases: {
            '@keywords': 'keyword',
            '@typeKeywords': 'type',
            '@default': 'identifier',
          },
        }],
        [/[()[\]{}]/, '@brackets'],
        [/;|,/, 'delimiter'],
        [/[=<>!&|+\-*/%^?:]+/, 'operator'],
      ],
      ns: [
        [/\.[a-zA-Z_]\w*/, 'type', '@pop'],               // ta.sma — member colored as builtin/type
        [/./, 'type', '@pop'],
      ],
      string: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, { token: 'string.quote', next: '@pop' }],
      ],
    },
  };
  monaco.languages.setMonarchTokensProvider('pine', monarch);

  // Dark theme tuned to TradingView's editor palette (their Pine editor runs
  // Monaco's vs-dark family with TV-blue keywords/builtins).
  monaco.editor.defineTheme('pine-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'd5d8e0' },
      { token: 'keyword', foreground: '89b4fa' },          // TV blue
      { token: 'type', foreground: '4fc1ff' },             // builtins / namespaces
      { token: 'identifier', foreground: 'd5d8e0' },
      { token: 'number', foreground: 'f5c97b' },
      { token: 'number.hex', foreground: 'f5c97b' },
      { token: 'string', foreground: '7fd4c1' },
      { token: 'string.escape', foreground: 'f5c97b' },
      { token: 'comment', foreground: '565a68', fontStyle: 'italic' },
      { token: 'annotation', foreground: '787b86', fontStyle: 'italic' },
      { token: 'operator', foreground: 'b2b5be' },
      { token: 'delimiter', foreground: 'b2b5be' },
    ],
    colors: {
      'editor.background': '#161a24',
      'editor.foreground': '#d5d8e0',
      'editor.lineHighlightBackground': '#1e222d',
      'editorLineNumber.foreground': '#565a68',
      'editorLineNumber.activeForeground': '#d5d8e0',
      'editorIndentGuide.background1': '#2a2e39',
      'editorCursor.foreground': '#d5d8e0',
      'editor.selectionBackground': '#2962ff55',
      'editorWidget.background': '#1e222d',
      'editorWidget.border': '#363c4e',
      'editorSuggestWidget.background': '#1e222d',
      'editorSuggestWidget.border': '#363c4e',
      'editorMarkerNavigationError.background': '#ef5350',
      'editorMarkerNavigationWarning.background': '#f0b90b',
    },
  });

  monaco.languages.setLanguageConfiguration('pine', {
    comments: { lineComment: '//' },
    brackets: [['(', ')'], ['[', ']'], ['{', '}']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '{', close: '}' },
      { open: '"', close: '"', notIn: ['string'] },
    ],
    // Pine is indentation-significant: preserve the user's indent on Enter,
    // never auto-outdent — a generic bracket rule would fight the grammar.
    onEnterRules: [],
    indentationRules: { increaseIndentPattern: /^\s*$/, decreaseIndentPattern: /^\s*$/ },
  });
}

// ── Completion provider: registered ONCE for the 'pine' language — it holds no
// per-editor state (model/position come in as args), so a global provider covers
// every editor. Re-registering per mount leaked one provider per editor open.
let completionDisposable: monacoApi.IDisposable | null = null;
function attachCompletions(monaco: Monaco): void {
  if (completionDisposable) return;
  completionDisposable = monaco.languages.registerCompletionItemProvider('pine', {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const linePrefix = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, word.startColumn));
      const nsMatch = /([a-zA-Z_]\w*)\.$/.exec(linePrefix);

      const items: monacoApi.languages.CompletionItem[] = [];
      const seen: Record<string, true> = {};
      const push = (label: string, kind: monacoApi.languages.CompletionItemKind, insertText: string, snippet = false) => {
        if (seen[label]) return;
        seen[label] = true;
        const item: monacoApi.languages.CompletionItem = { label, kind, insertText, range };
        if (snippet) item.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
        items.push(item);
      };

      if (nsMatch) {
        const ns = nsMatch[1]!;
        for (const name of BUILTINS.keys()) {
          const i = name.indexOf('.');
          if (i < 0 || name.slice(0, i) !== ns) continue;
          const member = name.slice(i + 1);
          if (member) push(member, monaco.languages.CompletionItemKind.Function, member);
        }
        for (const name of CONSTANTS.keys()) {
          const i = name.indexOf('.');
          if (i < 0 || name.slice(0, i) !== ns) continue;
          const member = name.slice(i + 1);
          if (member) push(member, monaco.languages.CompletionItemKind.Constant, member);
        }
        return { suggestions: items };
      }

      for (const s of DECL_SNIPPETS) {
        push(s.label, monaco.languages.CompletionItemKind.Snippet, s.insert, true);
      }
      for (const kw of KEYWORDS) push(kw, monaco.languages.CompletionItemKind.Keyword, kw);
      for (const name of BUILTINS.keys()) {
        if (!name.includes('.')) push(name, monaco.languages.CompletionItemKind.Function, name);
      }
      for (const ns of Object.keys(NAMESPACE_HEADS)) {
        push(ns, monaco.languages.CompletionItemKind.Module, ns);
      }
      for (const name of CONSTANTS.keys()) {
        if (!name.includes('.')) push(name, monaco.languages.CompletionItemKind.Constant, name);
      }
      return { suggestions: items };
    },
  });
}

// ── Lint: lex+parse → Monaco markers ─────────────────────────────────────────
export interface PineLintError { line: number; col: number; message: string }

// parse() throws the first LexError/ParseError; both store `{line, col}` on
// `.loc`. We return the first error only — Monaco renders one squiggly either
// way and the parser stops at the first failure anyway.
export function lintPineSource(src: string): PineLintError | null {
  try {
    parse(src);
    return null;
  } catch (e) {
    // LexError/ParseError both carry `.loc`; structural check keeps this safe
    // for unexpected throws (interpreter bugs, OOM, etc.).
    const loc = e !== null && typeof e === 'object' && 'loc' in e
      ? (e as { loc: { line: number; col: number } }).loc
      : undefined;
    const raw = e instanceof Error ? e.message : String(e);
    const message = raw.replace(/^\d+:\d+:\s*/, '');
    if (loc && loc.line > 0) {
      return { line: loc.line, col: Math.max(1, loc.col), message };
    }
    return { line: 1, col: 1, message };
  }
}

/** Parse `LINE:COL: msg` error text (what runIndicator returns) into a lint
 *  location, or null when it carries no position. */
export function parseErrorLocation(err: string): PineLintError | null {
  const m = /^(\d+):(\d+):\s*(.+)$/s.exec(err.trim());
  if (!m) return null;
  return { line: parseInt(m[1]!, 10), col: parseInt(m[2]!, 10), message: m[3]! };
}

// ── Public adapter ───────────────────────────────────────────────────────────
export interface PineEditorHandle {
  /** Current buffer contents. */
  getValue(): string;
  /** Replace the buffer (whole-script loads; undo stack keeps a single entry). */
  setValue(v: string): void;
  focus(): void;
  /** Move cursor to line/col (1-based) and reveal it. */
  setPosition(line: number, col: number): void;
  /** Cursor position changed — used by the statusbar `Line X, Col Y`. */
  onCursor(cb: (line: number, col: number) => void): void;
  /** Buffer text changed — used for dirty tracking + live lint. */
  onChange(cb: () => void): void;
  /** Keybindings that must work when the editor owns focus (Ctrl+S etc.). */
  addKeybinding(key: number, run: () => void): void;
  /** Underline a source position in the editor (runtime error from a run). */
  markError(err: PineLintError | null): void;
  dispose(): void;
  /** Monaco keycodes — `monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS`. */
  readonly monaco: Monaco;
  readonly editor: monacoApi.editor.IStandaloneCodeEditor;
}

export interface MountOptions {
  initialValue?: string;
  automaticLayout?: boolean;
}

/**
 * Mount a Monaco editor for Pine in `host`. Async because monaco + language
 * registration load lazily — callers that need a textarea fallback can race
 * this against a timeout.
 */
export async function mountPineEditor(host: HTMLElement, opts: MountOptions = {}): Promise<PineEditorHandle> {
  const monaco = await loadMonaco();
  attachCompletions(monaco);

  const editor = monaco.editor.create(host, {
    value: opts.initialValue ?? '',
    language: 'pine',
    theme: 'pine-dark',
    automaticLayout: opts.automaticLayout ?? true,
    fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderWhitespace: 'none',
    tabSize: 4,
    insertSpaces: true,
    wordWrap: 'off',
    // Pine has no bracket auto-indent; keep cursor indent on Enter.
    autoIndent: 'keep',
    folding: false,
    glyphMargin: false,
    lineDecorationsWidth: 6,
    fixedOverflowWidgets: true,
  });
  // Same DOM class TradingView uses — keeps any shared styling/testing hooks.
  host.classList.add('pine-editor-monaco');

  const cursorCbs: Array<(l: number, c: number) => void> = [];
  const changeCbs: Array<() => void> = [];
  const disposables: Array<{ dispose(): void }> = [];
  disposables.push(
    editor.onDidChangeCursorPosition((e) => { for (const cb of cursorCbs) cb(e.position.lineNumber, e.position.column); }),
    editor.onDidChangeModelContent(() => { for (const cb of changeCbs) cb(); }),
  );

  return {
    monaco,
    editor,
    getValue: () => editor.getValue(),
    setValue: (v) => editor.setValue(v),
    focus: () => editor.focus(),
    setPosition: (line, col) => {
      const pos = { lineNumber: Math.max(1, line), column: Math.max(1, col) };
      editor.setPosition(pos);
      editor.revealPositionInCenterIfOutsideViewport(pos);
    },
    onCursor: (cb) => { cursorCbs.push(cb); },
    onChange: (cb) => { changeCbs.push(cb); },
    addKeybinding: (key, run) => {
      // addCommand returns a string id (or null on conflict), not a disposable —
      // editor.dispose() tears the command table down with the editor anyway.
      editor.addCommand(key, run);
    },
    markError: (err) => {
      const model = editor.getModel();
      if (!model) return;
      if (!err) { monaco.editor.setModelMarkers(model, 'pine', []); return; }
      const line = Math.min(Math.max(1, err.line), model.getLineCount());
      const lineLen = model.getLineLength(line);
      const col = Math.min(Math.max(1, err.col), lineLen + 1);
      monaco.editor.setModelMarkers(model, 'pine', [{
        severity: monaco.MarkerSeverity.Error,
        message: err.message,
        startLineNumber: line,
        startColumn: col,
        endLineNumber: line,
        endColumn: Math.min(col + 1, lineLen + 1),
      }]);
    },
    dispose: () => {
      for (const d of disposables) d.dispose();
      const model = editor.getModel();
      editor.dispose();
      if (model) monaco.editor.setModelMarkers(model, 'pine', []);
    },
  };
}
