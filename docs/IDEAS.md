# Inkling — improvement backlog

A catalogue of follow-ups brainstormed against the current code, then ranked at the
bottom from most to least necessary. Items are numbered so the ranking can refer to
them without restating them.

Effort tags: **S** ≈ under an hour, **M** ≈ an afternoon, **L** ≈ a day or more.

> **Status:** D24, D27, A3, F35, D25 and A4 are implemented — see
> [plans/2026-11-17-data-safety-three.md](superpowers/plans/2026-11-17-data-safety-three.md).

---

## A. Providers & keys

`settings.provider` is `claude | openrouter | local | custom`; everything non-Claude
funnels through one OpenAI-compatible branch using a single shared
`localEndpoint` / `localApiKey` / `localModel` (`src/hmm-modals.jsx`, `callAI` in
`src/hmm-utils.jsx`).

- **A1.** **Per-provider profiles, not one global trio.** Switching OpenRouter → Ollama
  → back currently makes you retype URL, key and model each time, and `provider` +
  endpoint *do* sync across devices, so a phone ends up pointed at `localhost:11434`.
  Store `providers[<id>] = { endpoint, key, model, extra }` with an active pointer. *(M)*
- **A2.** **Preset picker instead of "custom".** Same code path, pre-filled base URLs +
  key hints + model lists: OpenAI, Google Gemini (OpenAI-compat endpoint), Groq,
  DeepSeek, Mistral, xAI, Together, Cerebras, Fireworks, LM Studio, llama.cpp, vLLM,
  plus "other". *(S)*
- **A3 — done.** **"Test connection" button** in Settings — a 1-token request reporting auth
  error vs bad model vs unreachable endpoint. Today the only way to learn a key is wrong
  is to send a message and get `*Provider error…*` saved into the transcript as a fake
  assistant message. *(S)*
- **A4 — done.** **Kill the dead config.** `openrouterKey` / `openrouterModel` exist in the
  settings defaults but the UI writes `localApiKey` / `localModel` for OpenRouter. *(S)*
- **A5.** **Live model lists.** `OPENROUTER_MODELS` is 11 hardcoded slugs "verified
  2026-10" that will rot; OpenRouter's `/api/v1/models` is public. Ollama's `/api/tags`
  is already consumed. Show context length and rough price per model. *(S/M)*
- **A6.** **Provider feature parity.** The request body is `model, messages, temperature,
  max_tokens, top_p, stream`. Missing the things roleplay wants: **stop sequences**
  (`\n{{user}}:`), presence/frequency penalty, `top_k`, seed, and **Anthropic prompt
  caching** (`cache_control` on system prompt + lorebook) — a real cost and latency win
  on long contexts. *(M)*
- **A7.** **Per-task model override.** Assists, summarizer and character generation all
  use the chat model; a cheap "utility model" (Haiku / a local model) saves money. *(S)*
- **A8.** **Usage honesty.** The `~tkns` meter divides by a hardcoded 16000; parse
  `usage` from responses and use the model's real context length. *(S)*

## B. Chat & composer QOL

- **B9.** **Per-chat persona.** Active persona is global (`src/hmm-app.jsx`); playing two
  characters means switching manually. Remember a persona per character with a "global"
  default. *(S)*
- **B10.** **Auto-summarize at a threshold.** `summarizeContext` is manual (min 8
  messages); trigger at ~75% of context and show a collapsible "earlier context
  summarized" marker. *(M)*
- **B11.** **Retry / error handling.** No backoff on 429/5xx, no timeout when a provider
  stalls, and errors become chat content. Keep the bubble as an error state with
  **Retry** and **Switch provider**. *(S/M)*
- **B12.** **Message search upgrade.** Ctrl+F filters the current chat only; add match
  count, prev/next jump, and palette-wide full-text search across chats and lorebook
  entries. *(M)*
- **B13.** **Swipe on user messages** too, and **edit-in-place** without resending
  (currently edit resends and truncates). *(M)*
- **B14.** **Continue without a user turn** for solo characters — group chats have
  "SPEAK ▸" per member; solo chats have no "keep going" nudge. *(S)*
- **B15.** **Multi-member group turns** — a "director" toggle where a cheap model picks
  the next speaker, or 2–3 characters reply in sequence. *(M)*
- **B16.** **Clipboard paste + drag-drop images** into the composer (file picker only
  today), multiple images per message, `capture` on the mobile input for camera. *(S)*
- **B17.** **Timestamps / separators toggle.** `showTokens` exists; timestamp display is
  unconditional. *(S)*
- **B18.** **Chat export** — per-chat Markdown/JSON/HTML. Full backup and character cards
  exist, but not "give me this one log". *(S)*

## C. Textbox / Undertale mode

- **C19.** **Present mode.** The component's own comment says it's built so "the later
  fullscreen present mode can reuse it unchanged"; that mode doesn't exist yet.
  Fullscreen, hidden chrome, bigger box, click/space to advance. *(M)*
- **C20.** **Click-to-advance and number keys 1–8 for choices** — clicking the box only
  skips typing; advancing pages needs the ▼ button. *(S)*
- **C21.** **User font upload** — escape hatch for the NC-ND `determination-mono.ttf`
  licence note in `fonts/README.md`; the wrapping math only needs monospace. *(S)*
- **C22.** **Blip volume / on-off per character** — `textboxSound` is global, `blipPitch`
  is already per character. *(S)*
- **C23.** **Auto-advance option** (type, pause ~2s, next page) for long messages. *(S)*

## D. Data safety & sync

- **D24 — done.** **Surface write failures.** `__idbPut` failure is only a `console.warn`; a
  quota error silently loses data. Toast plus a "storage full, export now" banner. *(S)*
- **D25 — done.** **Headless auto-backup** — automatic local snapshot before destructive ops
  (delete character, clear chat, import backup), plus a rolling restore point. *(M)*
- **D26.** **Trash bin** — soft-delete characters/chats for N days. *(M)*
- **D27 — done.** **Merge, don't replace.** `restorePayload` overwrites the characters array
  wholesale, so pulling or importing a backup discards local-only characters. Offer
  merge-by-id (replace / keep both / skip). *(M)*
- **D28.** **Revision CAS on the browser path.** The server supports `expectedRevision`
  (built for MCP) but the browser omits it and keeps last-write-wins, and a pull triggers
  a full `location.reload()`. Send the revision and prompt "remote changed — keep mine /
  take theirs". *(M)*
- **D29.** **End-to-end encrypt the sync blob** — WebCrypto AES-GCM keyed off the sync
  token; the backup host stays a dumb blob store. *(M/L)*
- **D30.** **Server hardening** — rate-limit `/api/sync` and `/api/sync/meta` (token
  guessing is unthrottled, minimum length 8), tighten CORS, add a purge path. *(S)*

## E. MCP

- **E31.** **`inkling_search_messages`** — full-text across every chat; the most obviously
  missing tool for "what did we say about X".
- **E32.** **`inkling_export_character`** — return a `chara_card_v2` JSON blob so a
  character can move between installs without a browser round-trip.
- **E33.** **Message-level edit/delete, folder tree, `fields` selection on
  `get_character`** — keeps big payloads out of context.
- **E34.** **Read-only mode** — an env flag exposing only read tools.

## F. Smaller fixes noticed while reading

- **F35 — done.** Status bar shows `settings.model` even when the provider is OpenRouter/local —
  misleading. *(S)*
- **F36.** Sidebar `CharCard` reads `S.chat(id)` for every row on every render. *(S)*
- **F37.** Sidebar has no alphabetical sort (insertion order unless "recent"). *(S)*
- **F38.** No linter; `test/hooks-check.mjs` exists specifically to catch what
  `eslint-plugin-react-hooks` would find statically. *(S/M)*
- **F39.** CI only builds the desktop app — no workflow for `npm test` + `npm run build`.
  *(S)*
- **F40.** `api/search.js` strips HTML with regexes and cannot handle JS-rendered pages;
  a reader fallback (e.g. Jina `r.jina.ai`, or SearXNG for keyless search) beats
  DuckDuckGo scraping. `safeUrl` blocks by hostname only — DNS rebinding uncovered. *(M)*
- **F41.** Image upload is hardwired to freeimage.host + a user key; make the endpoint
  configurable (imgbb, S3/R2, self-hosted). *(M)*
- **F42.** Boot hydrates **every** IDB key into memory (all chats, histories, base64
  avatars). Lazy-load chats per character; store avatars as Blobs once libraries grow. *(M)*
- **F43.** `build.mjs` comments still say "what Netlify publishes" while deploy is
  Vercel. *(S)*
- **F44.** Modals are `div`s with no `role="dialog"`, focus trap or focus restore; icon
  buttons rely on `title` for accessible names. *(M)*

---

## Priority order — most to least necessary

1. **D24** — silent data loss is the only failure mode with no recovery path.
2. **D27** — a backup pull or import can quietly delete local characters.
3. **A3** — Test connection. Removes the most common "why doesn't it work" hour.
4. **A1** — per-provider profiles; the current shared triple fights every provider switch.
5. **A2** — preset picker; same code, turns "custom" into two clicks.
6. **B11** — retry/backoff/timeout and error bubbles instead of fake replies in the chat.
7. **F35** — wrong model in the status bar; one line, constant low-grade confusion.
8. **D25** — auto-snapshot before destructive ops; `confirm()` is the only guard today.
9. **A4** — delete the unused `openrouterKey` / `openrouterModel` trap.
10. **B9** — per-chat persona; removes manual switching in the app's core loop.
11. **F38** — a linter would catch the dev/prod hook class of bug before it ships.
12. **F39** — CI for `npm test` + build; the desktop workflow is the only automation.
13. **A6** — stop sequences, penalties and prompt caching: better prose and lower bills.
14. **A5** — live model lists so the OpenRouter picker stops rotting.
15. **D28** — revision CAS in the browser closes the last clobber case and the jarring reload.
16. **B10** — auto-summarize keeps long chats from silently truncating.
17. **E31** — message search over MCP; the one tool an agent actually needs here.
18. **C19** — present mode: designed for, not built, and the most visible "wow".
19. **B12** — real message search with match navigation and cross-chat scope.
20. **B16** — paste/drag images; the everyday attachment path.
21. **C20** — click-to-advance and number-key choices in the textbox.
22. **B13** — swipe user messages and edit-in-place without resending.
23. **A7** — utility model for assists/summaries/character generation.
24. **D29** — E2E encryption; the right answer for a roleplay backup host seeing plaintext.
25. **B18** — per-chat export for sharing or archiving a single log.
26. **B14** — solo "continue" without typing a user turn.
27. **F44** — modal dialog semantics and focus handling.
28. **D26** — trash bin for characters and chats.
29. **B17** — timestamp toggle for people who want a cleaner transcript.
30. **E32** — export a character card over MCP.
31. **D30** — rate limiting and CORS tightening on the sync server.
32. **A8** — real usage numbers instead of `length / 4` against a fixed 16k.
33. **B15** — director mode / multi-reply group turns.
34. **E33** — message edit/delete and field selection for lighter MCP payloads.
35. **C21** — user font upload, also resolving the NC-ND font constraint.
36. **F40** — better page reading and keyless search; DNS-rebinding hardening.
37. **F36** — stop reading every chat in the sidebar render.
38. **F37** — alphabetical sort option in the sidebar.
39. **F41** — configurable image host.
40. **C22** — per-character blip volume/toggle.
41. **C23** — auto-advance pages for long messages.
42. **F42** — lazy IDB loading; matters only once libraries get big.
43. **E34** — MCP read-only mode.
44. **F43** — stale "Netlify" comment in `build.mjs`.
