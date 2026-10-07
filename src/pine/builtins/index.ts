// ── Builtin aggregator ──────────────────────────────────────────────────────
// Importing this module registers every builtin + namespace constant via
// each module's import-time `registerBuiltin`/`registerConstant` calls.
// The interpreter (and tests) should import BUILTINS/getConstant from here.
// Builtins agents: append `import './<your-module>'` to the list below.

export { BUILTINS, CONSTANTS, getConstant, hasConstant, registerBuiltin, registerConstant, registerLazyConstant } from './registry';

import './math';
import './str';
import './array';
import './color';
import './request';
import './plot';
import './input';
import './ta';
import './draw';
import './core';
import './time';
import './strategy';
import './util';
