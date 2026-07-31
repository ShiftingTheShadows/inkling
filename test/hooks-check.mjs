// Guards a dev/prod divergence that browser tests structurally cannot catch.
//
// In development, index.html loads src/*.jsx through Babel standalone. In
// production, build.mjs wraps each file in its own IIFE. A file that USES a
// React hook without destructuring it off `React` still works in dev — the
// binding leaks in from another file — but throws "X is not defined" the
// moment esbuild isolates it. That is exactly how `useCallback` reached
// production broken in hmm-chat.jsx.
//
// This check reads each source file and asserts that every hook it references
// is also destructured at the top of that same file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const HOOKS = [
  'useState', 'useEffect', 'useLayoutEffect', 'useRef', 'useMemo',
  'useCallback', 'useContext', 'useReducer', 'useImperativeHandle',
  'useTransition', 'useDeferredValue', 'useId', 'useSyncExternalStore',
];

let pass = 0, fail = 0;

for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.jsx'))) {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8');

  // What this file pulls off React, e.g. `const { useState, useRef } = React;`
  const declared = new Set();
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*React\s*;/g)) {
    m[1].split(',').forEach(n => { const t = n.trim(); if (t) declared.add(t); });
  }

  const missing = HOOKS.filter(h =>
    new RegExp(`(?<![.\\w])${h}\\s*\\(`).test(src) && !declared.has(h));

  if (missing.length) {
    fail++;
    console.log(`FAIL ${file}: uses ${missing.join(', ')} without destructuring from React`);
    console.log(`     add to the top: const { ${[...declared, ...missing].join(', ')} } = React;`);
  } else {
    pass++;
    console.log(`ok   ${file}${declared.size ? ` (${[...declared].join(', ')})` : ' (no hooks)'}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
