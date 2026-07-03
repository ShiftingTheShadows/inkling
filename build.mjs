// Deploy-time build: transpile the JSX once with esbuild instead of shipping
// Babel standalone and compiling ~250KB of JSX in the browser on every load.
// Dev workflow is unchanged — index.html at the repo root still uses
// type="text/babel" and works opened directly; this script writes the
// production version to dist/ (what Netlify publishes).
import { transformSync } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

const files = ['hmm-utils.jsx', 'hmm-sidebar.jsx', 'hmm-chat.jsx', 'hmm-modals.jsx', 'hmm-app.jsx'];

mkdirSync('dist', { recursive: true });

for (const f of files) {
  const { code } = transformSync(readFileSync(f, 'utf8'), {
    loader: 'jsx',
    target: 'es2020',
    minify: true,
    // Babel standalone evaluates each text/babel script in its own scope; plain
    // classic scripts share the global scope, so the per-file `const {...} = window`
    // headers collide without an IIFE wrapper.
    format: 'iife',
  });
  writeFileSync(`dist/${f.replace(/\.jsx$/, '.js')}`, code);
  console.log(`built dist/${f.replace(/\.jsx$/, '.js')}`);
}

let html = readFileSync('index.html', 'utf8');
const before = html.length;
html = html.replace(/<script src="https:\/\/unpkg\.com\/@babel\/standalone[^>]*><\/script>\s*/, '');
html = html.replace(/<script type="text\/babel" src="(hmm-[a-z]+)\.jsx"><\/script>/g, '<script src="$1.js"></script>');
if (html.includes('text/babel') || html.includes('@babel/standalone')) {
  throw new Error('index.html rewrite incomplete — babel references remain');
}
writeFileSync('dist/index.html', html);
console.log(`built dist/index.html (${before} -> ${html.length} bytes)`);
