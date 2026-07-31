import fs from 'node:fs';

const SRC = new URL('../src/hmm-utils.jsx', import.meta.url);

export function loadTextboxModule() {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf('/* TEXTBOX-EXPORTS-START */');
  const end = src.indexOf('/* TEXTBOX-EXPORTS-END */');
  if (start < 0 || end < 0) throw new Error('TEXTBOX-EXPORTS markers not found in hmm-utils.jsx');
  const body = src.slice(start, end);

  const names = [...body.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  if (!names.length) throw new Error('no functions found between TEXTBOX-EXPORTS markers');

  return new Function(`${body}\nreturn { ${names.join(', ')} };`)();
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
