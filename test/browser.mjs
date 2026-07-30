// test/browser.mjs — Browser end-to-end coverage for the Undertale-style
// textbox rendering feature. Everything else in this feature is unit-tested;
// this is the only test that proves it actually works in a real browser.
//
// Playwright isn't a dependency of this repo — it's borrowed from a sibling
// scratch project. Run with `npm run test:browser`; it starts its own static
// server on PORT and tears it down when done, so no separate server needed.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire('file:///C:/Users/shand/_logo_scratch/')('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const PORT = 8899;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const check = (n, c, x) => {
  if (c) { pass++; console.log(`ok   ${n}`); }
  else { fail++; console.log(`FAIL ${n}${x !== undefined ? '\n     ' + JSON.stringify(x) : ''}`); }
};

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = async () => {
      try { await fetch(url); resolve(); }
      catch (e) {
        if (Date.now() > deadline) reject(e);
        else setTimeout(tryOnce, 150);
      }
    };
    tryOnce();
  });
}

const server = spawn('python', ['-m', 'http.server', String(PORT)], {
  cwd: repoRoot,
  stdio: 'ignore',
});

let browser;
try {
  await waitForServer(`${BASE}/index.html`, 15000);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  // The brief's `window.__audioCtxCreated` flag doesn't exist anywhere in the
  // app — asserting against it would always read undefined and pass
  // vacuously. Instead stub AudioContext before any app code runs (persists
  // across the reloads below, since addInitScript re-applies on navigation)
  // and count real constructions.
  await page.addInitScript(() => {
    window.__audioCtorCalls = 0;
    class FakeAudioContext { constructor() { window.__audioCtorCalls++; } }
    window.AudioContext = FakeAudioContext;
    window.webkitAudioContext = FakeAudioContext;
  });

  await page.goto(`${BASE}/index.html`);
  await page.waitForFunction(() => window.S && window.InklingStorageReady, null, { timeout: 20000 });

  const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

  // The brief's 20-number sample ("One two three ... twenty.") wraps to a
  // single page at 46 cols x 3 rows — verified directly against
  // parseTextbox() — so it can't exercise pagination at all. 30 short
  // "wordN" tokens wraps to exactly 2 pages (6 lines), confirmed the same
  // way, which is what pagination coverage actually needs.
  const words = Array.from({ length: 30 }, (_, i) => `word${i + 1}`).join(' ');
  const tbMessage = `${words}.\n:::choices\nAsk\nLeave\n:::`;

  await page.evaluate(({ px, tbMessage }) => {
    window.S.saveChars([
      {
        id: 'tb', name: 'Boxy', firstMessage: 'hi', textboxStyle: 'deltarune',
        expressions: { Neutral: px, Grin: px }, defaultExpression: 'Neutral',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      {
        id: 'plain', name: 'Plain', firstMessage: 'hi', textboxStyle: 'none',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
    ]);
    window.S.saveChat('tb', [{ id: 'm1', role: 'assistant', ts: Date.now(), content: tbMessage }]);
    window.S.saveChat('plain', [{ id: 'm2', role: 'assistant', ts: Date.now(), content: 'Plain markdown reply, no textbox here.' }]);
    localStorage.setItem('hmm_current', 'tb');
  }, { px: PX, tbMessage });

  // IndexedDB writes are async — a fast reload can lose them.
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForSelector('.tbx', { timeout: 20000 });

  check('box renders', await page.locator('.tbx').count() === 1);
  check('portrait renders for deltarune', await page.locator('.tbx-portrait').count() === 1);

  const partial = (await page.locator('.tbx-text').innerText()).length;
  await page.waitForTimeout(600);
  const later = (await page.locator('.tbx-text').innerText()).length;
  check('typewriter progresses over time', later > partial, { partial, later });

  await page.locator('.tbx').click();
  const skipped = (await page.locator('.tbx-text').innerText()).length;
  check('click skips typing to the full page', skipped > later, { later, skipped });

  check('pagination counter starts at 1/2', await page.locator('.tbx-counter').innerText() === '1/2');
  check('choices are hidden before the last page', await page.locator('.tbx-choices').count() === 0);

  await page.locator('.tbx-next').click();
  check('next advances the counter to 2/2', await page.locator('.tbx-counter').innerText() === '2/2');

  await page.locator('.tbx-nav', { hasText: 'BACK' }).click();
  check('back returns the counter to 1/2', await page.locator('.tbx-counter').innerText() === '1/2');

  // Going back re-triggers the typewriter on page 1 (a page change always
  // restarts typing) — .tbx-next only renders once the current page is
  // fully typed, so skip again before advancing.
  await page.locator('.tbx').click();
  await page.locator('.tbx-next').click();
  check('re-advances to the last page (2/2)', await page.locator('.tbx-counter').innerText() === '2/2');

  await page.locator('.tbx').click(); // finish typing the last page
  await page.waitForSelector('.tbx-choices', { timeout: 5000 });
  check('choices render once the last page finishes typing', await page.locator('.tbx-choice').count() === 2);

  const userMsgsBefore = await page.locator('.msg.user').count();
  await page.locator('.tbx-choice', { hasText: 'Ask' }).click();
  await page.waitForFunction(
    n => document.querySelectorAll('.msg.user').length > n,
    userMsgsBefore,
    { timeout: 5000 }
  );
  const lastUserText = (await page.locator('.msg.user .msg-content').last().innerText()).trim();
  check('clicking a choice sends its text as the user message', lastUserText === 'Ask', { lastUserText });

  // textboxStyle: 'none' must fall back to the ordinary markdown path —
  // this guards every character that predates the feature.
  await page.evaluate(() => localStorage.setItem('hmm_current', 'plain'));
  await page.reload();
  await page.waitForSelector('.msg-content', { timeout: 20000 });
  check('textboxStyle "none" renders zero textboxes', await page.locator('.tbx').count() === 0);
  const plainText = await page.locator('.msg.assistant .msg-content').first().innerText();
  check('textboxStyle "none" still renders the markdown message body',
    plainText.includes('Plain markdown reply'), { plainText });

  const audioCalls = await page.evaluate(() => window.__audioCtorCalls);
  check('no AudioContext constructed (sound off by default)', audioCalls === 0, { audioCalls });

  check('no uncaught page errors', errs.length === 0, errs);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('Test run crashed:', e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}
