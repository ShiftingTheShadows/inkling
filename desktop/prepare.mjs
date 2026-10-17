// Assembles desktop/web/: the production web build + the api/ functions +
// everything vendored locally (React, fonts) so the app works fully offline.
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const app = path.join(here, 'web');
const mod = p => path.join(here, 'node_modules', p);

console.log('building web app…');
if (!existsSync(path.join(repo, 'node_modules', 'esbuild'))) execSync('npm install --no-audit --no-fund', { cwd: repo, stdio: 'inherit' });
execSync('node build.mjs', { cwd: repo, stdio: 'inherit' });

rmSync(app, { recursive: true, force: true });
mkdirSync(path.join(app, 'vendor'), { recursive: true });
cpSync(path.join(repo, 'dist'), app, { recursive: true });
cpSync(path.join(repo, 'api'), path.join(app, 'api'), { recursive: true });
writeFileSync(path.join(app, 'package.json'), '{ "type": "module" }\n'); // api/*.js are ESM

// React, locally
cpSync(mod('react/umd/react.production.min.js'), path.join(app, 'vendor/react.production.min.js'));
cpSync(mod('react-dom/umd/react-dom.production.min.js'), path.join(app, 'vendor/react-dom.production.min.js'));

// JetBrains Mono, locally (replaces the Google Fonts <link>)
const fontDir = path.join(app, 'vendor/fonts');
mkdirSync(fontDir, { recursive: true });
const faces = [[300, 'normal'], [400, 'normal'], [500, 'normal'], [600, 'normal'], [700, 'normal'], [400, 'italic']];
let css = '';
for (const [w, style] of faces) {
  const f = `jetbrains-mono-latin-${w}-${style}.woff2`;
  cpSync(mod(`@fontsource/jetbrains-mono/files/${f}`), path.join(fontDir, f));
  css += `@font-face{font-family:'JetBrains Mono';font-style:${style};font-weight:${w};font-display:swap;src:url(fonts/${f}) format('woff2');}\n`;
}
writeFileSync(path.join(app, 'vendor/fonts.css'), css);

let html = readFileSync(path.join(app, 'index.html'), 'utf8');
const swap = (re, to, label) => { if (!re.test(html)) throw new Error(`index.html: ${label} not found — update prepare.mjs`); html = html.replace(re, to); };
swap(/<script src="https:\/\/unpkg\.com\/react@[^>]*><\/script>/, '<script src="vendor/react.production.min.js"></script>', 'react script');
swap(/<script src="https:\/\/unpkg\.com\/react-dom@[^>]*><\/script>/, '<script src="vendor/react-dom.production.min.js"></script>', 'react-dom script');
swap(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*/, '', 'fonts preconnect');
swap(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, '<link href="vendor/fonts.css" rel="stylesheet">', 'fonts link');
writeFileSync(path.join(app, 'index.html'), html);
console.log('desktop/web ready');
