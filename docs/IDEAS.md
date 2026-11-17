# Inkling — improvement backlog

A catalogue of follow-ups brainstormed against the current code, then ranked at the
bottom from most to least necessary. Items are numbered so the ranking can refer to
them without restating them.

Effort tags: **S** ≈ under an hour, **M** ≈ an afternoon, **L** ≈ a day or more.

> **Status:** D24, D27, A3, F35, D25, A4, A1, A2, A5, A6, A7, B9, B10, B11, B12,
> A8, B13, B14, B15, B16, B17, B18, C19, C20, C21, C22, C23, D26, D28, D29, D30, E31, E32, E33, E34,
> F36, F37, F38, F39, F40 and F44 are implemented — see
> [plans/2026-11-17-data-safety-three.md](superpowers/plans/2026-11-17-data-safety-three.md).
> D29's three product decisions were answered before it was built; the chosen paths are
> recorded in its entry, so they are not open questions.

---

## A. Providers & keys

`settings.provider` is `claude | openrouter | local | custom`; everything non-Claude
funnels through one OpenAI-compatible branch using a single shared
`localEndpoint` / `localApiKey` / `localModel` (`src/hmm-modals.jsx`, `callAI` in
`src/hmm-utils.jsx`).

- **A1 — done.** **Per-provider profiles, not one global trio.** Switching OpenRouter → Ollama
  → back currently makes you retype URL, key and model each time, and `provider` +
  endpoint *do* sync across devices, so a phone ends up pointed at `localhost:11434`.
  Store `providers[<id>] = { endpoint, key, model, extra }` with an active pointer. *(M)*
- **A2 — done.** **Preset picker instead of "custom".** Same code path, pre-filled base URLs +
  key hints + model lists: OpenAI, Google Gemini (OpenAI-compat endpoint), Groq,
  DeepSeek, Mistral, xAI, Together, Cerebras, Fireworks, LM Studio, llama.cpp, vLLM,
  plus "other". *(S)*
- **A3 — done.** **"Test connection" button** in Settings — a 1-token request reporting auth
  error vs bad model vs unreachable endpoint. Today the only way to learn a key is wrong
  is to send a message and get `*Provider error…*` saved into the transcript as a fake
  assistant message. *(S)*
- **A4 — done.** **Kill the dead config.** `openrouterKey` / `openrouterModel` exist in the
  settings defaults but the UI writes `localApiKey` / `localModel` for OpenRouter. *(S)*
- **A5 — done.** **Live model lists.** `OPENROUTER_MODELS` is 11 hardcoded slugs "verified
  2026-10" that will rot; OpenRouter's `/api/v1/models` is public. Ollama's `/api/tags`
  is already consumed. Show context length and rough price per model. *(S/M)*
- **A6 — done.** **Provider feature parity.** The request body is `model, messages, temperature,
  max_tokens, top_p, stream`. Missing the things roleplay wants: **stop sequences**
  (`\n{{user}}:`), presence/frequency penalty, `top_k`, seed, and **Anthropic prompt
  caching** (`cache_control` on system prompt + lorebook) — a real cost and latency win
  on long contexts. *(M)*
- **A7 — done.** **Per-task model override.** Assists, summarizer and character generation all
  use the chat model; a cheap "utility model" (Haiku / a local model) saves money. *(S)*
- **A8 — done.** **Usage honesty.** The `~tkns` meter reads the provider-reported input+output
  of the latest reply (Anthropic's cache-read/creation tokens included) and shows no `~` when
  the number is exact; endpoints that report nothing still fall back to a 4-chars-per-token
  estimate. The denominator is the model's real window — Settings → Context window, then the
  cached live OpenRouter catalogue, then known model families, then 16k — so the meter and
  auto-summarize fire at the same real percentage. *(S)*

## B. Chat & composer QOL

- **B9 — done.** **Per-chat persona.** Active persona is global (`src/hmm-app.jsx`); playing two
  characters means switching manually. Remember a persona per character with a "global"
  default. *(S)*
- **B10 — done.** **Auto-summarize at a threshold.** `summarizeContext` is manual (min 8
  messages); trigger at ~75% of context and show a collapsible "earlier context
  summarized" marker. *(M)*
- **B11 — done.** **Retry / error handling.** No backoff on 429/5xx, no timeout when a provider
  stalls, and errors become chat content. Keep the bubble as an error state with
  **Retry** and **Switch provider**. *(S/M)*
- **B12 — done.** **Message search upgrade.** Ctrl+F filters the current chat only; add match
  count, prev/next jump, and palette-wide full-text search across chats and lorebook
  entries. *(M)*
- **B13 — done.** **Swipe on user messages** too, and **edit-in-place** without resending
  (currently edit resends and truncates). *(M)*
- **B14 — done.** **Continue without a user turn** for solo characters — a CONTINUE action
  in the composer streams the next assistant beat with a "continue the scene" instruction and
  no invented user message, through the normal abort/error/retry path. *(S)*
- **B15 — done.** **Multi-member group turns** — a per-group DIRECTOR toggle hands speaker
  choice to the cheap utility model (which sees the last ten lines and is told who just spoke);
  an unusable answer, an unavailable model or a single-member group falls back to the normal
  mention-then-rotation rule, so a turn can never stall. A REPLIES PER TURN setting of 1–3 makes
  that many members answer in sequence, each seeing the replies before it. Both live on the group
  record (so they sync) and are editable from the chat menu and the group editor; manual SPEAK
  buttons remain single replies. *(M)*
- **B16 — done.** **Clipboard paste + drag-drop images** into the composer (file picker only
  today), multiple images per message, `capture` on the mobile input for camera. *(S)*
- **B17 — done.** **Timestamps / separators toggle.** A Settings → Appearance checkbox
  (`showTimestamps`, on by default and synced) hides every message time while keeping the
  transcript readable. *(S)*
- **B18 — done.** **Chat export** — the chat menu exports this one log as Markdown, JSON
  (`inkling-chat-v1`) or a self-contained HTML page, all from one shared row model that names
  speakers and notes attached images. *(S)*

## C. Textbox / Undertale mode

- **C19 — done.** **Present mode.** The component's own comment says it's built so "the later
  fullscreen present mode can reuse it unchanged"; that mode doesn't exist yet.
  Fullscreen, hidden chrome, bigger box, click/space to advance. *(M)*
- **C20 — done.** **Click-to-advance and number keys 1–8 for choices** — clicking the box only
  skips typing; advancing pages needs the ▼ button. *(S)*
- **C21 — done.** **User font upload** — Settings → Appearance → Textbox Font accepts TTF, OTF,
  WOFF or WOFF2 up to 2 MB, identified by file signature rather than extension (a renamed HTML
  file is refused with the reason), applied immediately via an injected `@font-face` and
  `--tbx-font`, restored before first render on reload, and resettable to the bundled
  Determination Mono. The file is stored in IndexedDB as a device-local asset and is deliberately
  absent from the sync payload and exported backups, so another device re-uploads its own; a
  proportional font warns (measured `i` vs `W`) instead of blocking, because the textbox only
  needs monospace for alignment. *(S)*
- **C22 — done.** **Per-character blip volume / on-off.** The character editor's Textbox tab
  gains a BLIP SOUND choice — follow the global Settings switch, always on, or muted — and a
  BLIP VOLUME slider from 0–100% (0% is a mute), both stored on the character record so they
  sync and appear in backups. The typing path resolves them once per character
  (`blipForCharacter`), scales the synthesized blip's gain, and leaves the existing global
  switch as the default, so a character with no override sounds exactly as before. *(S)*
- **C23 — done.** **Auto-advance pages.** A Settings → Appearance checkbox
  (`textboxAutoAdvance`, off by default) makes the newest textbox turn its own pages: it types,
  waits two seconds, then shows the next page, repeating until the last one. Historical replies
  stay still, a streaming reply waits until the stream ends, and any manual page turn (clicking
  the box, ▼ or ◀ BACK) stops auto-advance for that message so the reader keeps control. *(S)*

## D. Data safety & sync

- **D24 — done.** **Surface write failures.** `__idbPut` failure is only a `console.warn`; a
  quota error silently loses data. Toast plus a "storage full, export now" banner. *(S)*
- **D25 — done.** **Headless auto-backup** — automatic local snapshot before destructive ops
  (delete character, clear chat, import backup), plus a rolling restore point. *(M)*
- **D26 — done.** **Trash bin** — deleting a character (with its chat and history) or clearing
  a chat parks a copy in `hmm_trash` for 30 days; Settings → Storage lists each entry with
  RESTORE and EMPTY TRASH, and expired entries are purged on launch. *(M)*
- **D27 — done.** **Merge, don't replace.** `restorePayload` overwrites the characters array
  wholesale, so pulling or importing a backup discards local-only characters. Offer
  merge-by-id (replace / keep both / skip). *(M)*
- **D28 — done.** **Revision CAS on the browser path.** The server supports `expectedRevision`
  (built for MCP) but the browser omits it and keeps last-write-wins, and a pull triggers
  a full `location.reload()`. Send the revision and prompt "remote changed — keep mine /
  take theirs". *(M)*
- **D29 — done.** **End-to-end encrypt the sync blob** — the Railway backup is stored server-side
  as an AES-GCM envelope (PBKDF2-SHA256, per-key salt, fresh IV) keyed by a separate passphrase
  the server never sees, unlocked once per device and optionally remembered. Enabling encrypts
  and replaces the plaintext revision; a locked device refuses to push plaintext and an
  unencrypted client refuses to overwrite an encrypted backup (checked via the `encrypted` meta
  flag); MCP refuses ciphertext instead of writing through it; changing the passphrase
  re-encrypts and uploads before committing the new key, and a forgotten passphrase is
  unrecoverable. Gist sync is unchanged and the UI says so. *(M/L)*
  - **Decisions (answered, implemented):** a separate passphrase unlocked once per device with
    optional remember; enabling encrypts and replaces the stored plaintext immediately; changing
    the passphrase re-encrypts and uploads first, with no recovery path.
  - **Operational note:** the `/api/sync/meta` `encrypted` flag only takes effect once the
    `server/` service is redeployed. Until then pulls still detect and decrypt encrypted blobs,
    but the pre-push guard cannot see that a backup is encrypted.
- **D30 — done.** **Server hardening** — rate-limit `/api/sync` and `/api/sync/meta` (token
  guessing is unthrottled, minimum length 8), tighten CORS, add a purge path. *(S)*

## E. MCP

- **E31 — done.** **`inkling_search_messages`** — full-text across every chat; the most obviously
  missing tool for "what did we say about X".
- **E32 — done.** **`inkling_export_character`** — an MCP tool returning a `chara_card_v2`
  object (avatar data excluded) so a character can move between installs without a browser
  round-trip.
- **E33 — done.** **Smaller MCP edits and reads.** `inkling_update_message` and
  `inkling_delete_message` change or remove one message by id or 0-based index without touching
  the rest of the chat (delete requires `confirm:true`); `inkling_list_folders` returns a real
  nested tree with each folder's characters, subtree totals and the unfiled characters;
  `inkling_get_character` takes `fields` (camelCase or snake_case) and returns only those values
  plus id and name, refusing an unknown name with the valid list. *(M)*
- **E34 — done.** **Read-only mode** — an env flag exposing only read tools.

## F. Smaller fixes noticed while reading

- **F35 — done.** Status bar shows `settings.model` even when the provider is OpenRouter/local —
  misleading. *(S)*
- **F36 — done.** **Sidebar without chat reads.** A one-line chat summary (count, cleaned
  preview, last speaker and timestamp) is written to `hmm_chat_meta` whenever a chat is saved,
  and the character list builds its rows from that single map instead of calling `S.chat(id)`
  per row. Opening or re-rendering the sidebar therefore costs one metadata read no matter how
  many characters or messages exist; message bodies are read only when a chat opens. The map is
  derived state, excluded from the sync payload, backfilled on the next boot for existing
  chats, and dropped when a character is deleted. *(S)*
- **F37 — done.** **Alphabetical sidebar sort.** The sidebar's order row adds **A→Z**, sorting
  case-insensitively by character name (equal names keep their existing order). The choice is
  stored as `settings.sidebarSort` alongside ALL, ★ FAV and RECENT, so it is still selected
  after a reload and travels with synced settings; search, tag filters, favourites and the F36
  metadata-based rows are all applied unchanged around it. *(S)*
- **F38 — done.** No linter; `test/hooks-check.mjs` exists specifically to catch what
  `eslint-plugin-react-hooks` would find statically. *(S/M)*
- **F39 — done.** CI only builds the desktop app — no workflow for `npm test` + `npm run build`.
  *(S)*
- **F40 — done.** **Page reading, keyless search and DNS-rebinding hardening.**
  `api/search.js` still reads plain HTML directly, but a `text/html` page that yields less than
  400 characters of prose (an empty SPA shell) is re-read through `r.jina.ai`, which renders
  JavaScript; a reader refusal (its anonymous tier can answer with a JSON error) falls back to
  the direct text and never leaks that JSON as page content. The reply now says which path was
  used (`reader: 'html' | 'jina'`). Keyless search tries DuckDuckGo's HTML endpoint and, when it
  blocks or returns nothing, falls back to Jina's keyless reader search (`s.jina.ai`), parsing
  its links into results — no API key involved in either step. Outbound page reads resolve the
  hostname over DNS-over-HTTPS and refuse any answer in loopback, private, link-local, CGNAT,
  benchmarking or multicast space (v4 and v6), re-check every redirect hop, and fail closed when
  the address cannot be verified, so a hostname that looks public but resolves to
  `127.0.0.1` or `169.254.169.254` is never fetched. The remote MCP server (`mcp/http.js`)
  additionally answers only loopback or operator-listed hosts and refuses a foreign browser
  `Origin`, which blocks DNS rebinding against the local connector while leaving the MCP client,
  curl and local/preview development unaffected. *(M)*
- **F41.** Image upload is hardwired to freeimage.host + a user key; make the endpoint
  configurable (imgbb, S3/R2, self-hosted). *(M)*
- **F42.** Boot hydrates **every** IDB key into memory (all chats, histories, base64
  avatars). Lazy-load chats per character; store avatars as Blobs once libraries grow. *(M)*
- **F43.** `build.mjs` comments still say "what Netlify publishes" while deploy is
  Vercel. *(S)*
- **F44 — done.** **Modal dialog semantics** — every modal is `role="dialog"` + `aria-modal`,
  labelled from its title, moves focus inside, traps Tab and restores focus on close; icon-only
  buttons take `aria-label` from their tooltip. *(M)*

---

## Priority order — what's left, most to least necessary

Everything marked done above is shipped; this list is only the open items, in the order they
should be tackled.

1. **F41** — configurable image host.
2. **F42** — lazy IDB loading; matters only once libraries get big.
3. **F43** — stale "Netlify" comment in `build.mjs`.
