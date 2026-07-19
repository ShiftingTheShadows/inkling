# Inkling

A self-hosted, single-page AI roleplay chat client — characters, group chats, personas,
lorebooks, and a bunch of quality-of-life stuff — that runs entirely in your browser.
Everything lives in IndexedDB on your device; nothing is stored on a server unless you
explicitly set up sync.

There's no product pitch here — this is a personal project, built and iterated on for
one person's own use, made public because there was no reason not to. If you found it,
poke around, fork it, steal whatever's useful. No support is promised.

## Features

- **Characters & group chats** — SillyTavern-compatible character cards (JSON and PNG
  card import/export), alternate greetings, example dialogues, per-character avatars.
- **Personas** — switch who *you* are mid-conversation.
- **Lorebook / Scripts** — keyword-triggered world info injected into context, with
  probability, depth, and grouping controls.
- **AI Assist** — write-for-me, enhance draft, continue, and impersonate, powered by
  the same model you're chatting with.
- **Multiple providers** — the built-in Claude proxy (`api/anthropic.js`), OpenRouter,
  or any local/self-hosted OpenAI-compatible endpoint (Ollama, LM Studio, etc).
- **Theming** — a dozen built-in themes, plus a custom background image (animated GIFs
  supported) and raw CSS injection for anything the built-in themes don't cover.
- **Sync** — back up and restore everything (characters, chats, personas, lorebook,
  settings) via a private GitHub Gist, or your own Railway-hosted sync server. See
  [`server/README.md`](server/README.md) for the Railway option.
- **PWA** — installable, works offline for anything already loaded.
- **In-app changelog** — pops up after an update so you don't have to go digging
  through commit history to remember what changed.

## Architecture

There's no framework build step for development — `index.html` loads React and Babel
Standalone from a CDN and transpiles the `src/*.jsx` files live in the browser, so you
can just open `index.html` and start editing.

```
index.html          — page shell + all CSS (themes, layout, components)
src/hmm-utils.jsx    — storage (IndexedDB), AI calls, macros, sync, card import/export
src/hmm-app.jsx      — root app: routing between chat/settings/modals, theme application
src/hmm-sidebar.jsx  — character list sidebar
src/hmm-chat.jsx     — chat view: messages, streaming, composer, group chat logic
src/hmm-modals.jsx   — every modal (settings, character editor, import, sync, lorebook…)
api/anthropic.js     — Vercel edge function: thin streaming proxy to api.anthropic.com
server/              — optional standalone sync server (Express + Postgres) for Railway
build.mjs            — production build: esbuild-transpiles src/*.jsx into dist/, strips Babel
```

For production, `npm run build` runs esbuild once at deploy time instead of shipping
Babel and re-transpiling ~250KB of JSX in every visitor's browser. The dev workflow
(opening `index.html` directly) is unaffected.

## Running it

```
npm install
npm run build   # writes dist/ — what actually gets deployed
```

Or just open `index.html` directly in a browser for local dev (no build step needed).

Deployed on [Vercel](https://vercel.com) — `vercel.json` points the build command at
`npm run build` and serves `dist/`. `api/anthropic.js` runs as a Vercel Edge Function.

## Data & privacy

Characters, chats, and settings are stored client-side in IndexedDB — nothing leaves
your device unless you configure a sync provider (Gist or Railway) or generate content
through your chosen AI provider. API keys and any custom jailbreak/system prompt are
explicitly excluded from both sync payloads and are never bundled into the exported
backup JSON's public fields — they stay local only.

## Credits

- Built with [React](https://react.dev) and [esbuild](https://esbuild.github.io).
- Character card format compatible with [SillyTavern](https://github.com/SillyTavern/SillyTavern)'s `chara_card_v2` spec.
- Image hosting for greeting images via [Catbox](https://catbox.moe).
- AI generation via [Anthropic's Claude API](https://www.anthropic.com), [OpenRouter](https://openrouter.ai), or any OpenAI-compatible endpoint you point it at.
- Hosted on [Vercel](https://vercel.com); optional sync backend on [Railway](https://railway.app).

Not affiliated with, endorsed by, or sponsored by Anthropic, SillyTavern, Catbox,
Vercel, or Railway — just a hobby project that uses their public APIs/services.

## License

[MIT](LICENSE) — do whatever you want with it, no warranty, no liability. See
[`LICENSE`](LICENSE) for the legal text nobody's going to enforce.
