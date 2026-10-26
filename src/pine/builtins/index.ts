// ── Builtin aggregator ──────────────────────────────────────────────────────
// Importing this module registers every builtin + namespace constant via
// each module's import-time `registerBuiltin`/`registerConstant` calls.
// The interpreter (and tests) should import BUILTINS/getConstant from here.
// Builtins agents: append `import './<your-module>'` to the list below.

export { BUILTINS, CONSTANTS, getConstant, hasConstant, registerBuiltin, registerConstant, registerLazyConstant } from './registry';

import './math';
import './str';
import './array';
import './map';
import './matrix';
import './color';
import './request';
import './datasource';
import './plot';
import './input';
import './ta';
import './draw';
import './core';
import './time';
import './session';
import './log';
import './strategy';
import './strategyEquity';
import './util';
// The ScalarSpec declaration table (builtins/scalarDeclPatch.ts) resolves its
// entries against BUILTINS, so it MUST be imported after every module that
// registers a builtin — keep this line last. Appending a new `import` above it
// is correct; appending below it silently drops that module's declarations
// (asserted by __tests__/scalar_spec_integrity.test.ts).
import './scalarDeclPatch';
