import fs from 'node:fs';

const SRC = new URL('../src/hmm-utils.jsx', import.meta.url);

// Slice a marked region out of hmm-utils.jsx and evaluate it under Node. Each
// region must stay free of React and DOM access. Returns every function it
// declares (async included).
export function loadSlice(startMarker, endMarker) {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start < 0 || end < 0) throw new Error(`markers not found in hmm-utils.jsx: ${startMarker} / ${endMarker}`);
  const body = src.slice(start + startMarker.length, end);

  const names = [...body.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  if (!names.length) throw new Error(`no functions found between ${startMarker} and ${endMarker}`);

  return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
}

export function loadTextboxModule() {
  return loadSlice('/* TEXTBOX-EXPORTS-START */', '/* TEXTBOX-EXPORTS-END */');
}

export function makeRunner() {
  let pass = 0, fail = 0;
  const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`ok   ${name}`); }
    else { fail++; console.log(`FAIL ${name}\n     expected: ${e}\n     actual:   ${a}`); }
  };
  const ok = (name, cond, extra) => {
    if (cond) { pass++; console.log(`ok   ${name}`); }
    else { fail++; console.log(`FAIL ${name}${extra ? '\n     ' + JSON.stringify(extra) : ''}`); }
  };
  const done = () => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  };
  return { eq, ok, done };
}
