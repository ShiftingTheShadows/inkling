# Undertale / Deltarune textbox mode

**Status:** approved, not yet implemented
**Date:** 2026-07-30

## Problem

Characters all speak in the same plain chat log. For roleplay bots styled after Undertale or Deltarune, the dialogue box *is* the presentation - the black box, the white border, the pixel font, the per-character blip, the choice cursor. Inkling can render that, and the AI can drive it live rather than it being pre-scripted.

## What this is

A per-character **display skin**. The model writes normally; Inkling renders its replies as UT/DR textboxes with a typewriter effect, page-by-page advance, and clickable choices the model offers.

Nothing about the conversation becomes pre-scripted. The only authored content stays what it already is: greetings (`firstMessage` + `alternateGreetings`), which the app already exposes as swipeable branches.

Portraits are **in** v1. They were originally cut on the assumption that sprite sets would be heavy, but a real reference set (64 Kris expressions, uniform 60x60) totals 41 KB - 56 KB base64 - which is less than a single cropped avatar. With portraits in, `deltarune` is genuinely distinct from `undertale` rather than differing only by border colour.

## What this is not (v1)

- **Present mode.** The fullscreen VN view is a later feature. It reuses this box renderer unchanged, which is why the renderer is a standalone module.
- **Per-character gag fonts** (Papyrus in Papyrus, etc).
- **Authored dialogue trees.** Explicitly rejected during design - the AI generates every turn.
- **Animated / talking sprites.** Static image per expression only.

## Architecture

New module `src/hmm-textbox.jsx`, loaded as a window global like the rest. The box renderer is self-contained: it takes a parsed message and renders a box. It knows nothing about chat, sending, or storage, so present mode can reuse it whole instead of forking it.

```
hmm-utils.jsx    parseTextbox(text, style) -> { pages[], choices[], expressions[] }
hmm-textbox.jsx  <Textbox> - box chrome, typewriter, paging, choice list
hmm-chat.jsx     selects <Textbox> vs the normal renderer; handles choice -> send
```

Pipeline, so the split of responsibility is unambiguous:

1. `parseTextbox` strips the `:::choices` fence and `\E` tags off the raw reply, returning the remaining prose plus `choices[]` and `expressions[]`.
2. That prose is word-wrapped and split into `pages[]` - plain strings, not HTML.
3. `<Textbox>` renders one page at a time, passing each through the existing inline-mark pass (`**bold**`, `*action*`, `__underline__`) so emphasis still works inside a box. Block constructs - headings, lists, quotes, alignment fences - are **not** supported inside a textbox; they render as literal text, since the games have no equivalent and a `<ul>` would break the fixed 3-line layout.

`renderMarkdown` itself is untouched. `parseTextbox` runs before it and only on characters with a textbox style, so the default rendering path carries no new risk.

`hmm-chat.jsx` is already ~1400 lines. This stays out of it; the only change there is the branch that picks a renderer and the handler that sends a chosen option.

Load order in `index.html` and `build.mjs`: `hmm-textbox.jsx` after `hmm-utils.jsx`, before `hmm-chat.jsx`.

## Data model

Per character (all optional, absent means off - existing characters are unaffected):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `textboxStyle` | `'none' \| 'undertale' \| 'deltarune'` | `'none'` | Which skin, or off |
| `blipPitch` | number (Hz) | derived | Voice pitch for the typing blip |
| `expressions` | `{ [name: string]: dataUri }` | `{}` | Portrait sprite per expression |
| `defaultExpression` | string | first key | Shown when no tag has been seen yet |

`blipPitch` defaults to a value derived from the existing `nameHash(name)` helper in `hmm-utils.jsx`, mapped into roughly 200-800 Hz so every character gets a distinct but non-grating voice with zero authoring. An explicit value overrides it.

Global settings:

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `textboxSound` | boolean | `false` | Typing blips on/off |
| `textboxSpeed` | number (cps) | `30` | Typewriter speed |

Sound defaults **off** - unexpected audio in a chat app is jarring.

Messages gain an optional `expressions[]` array: parsed from the reply, stored, unrendered in v1.

## Syntax

### Choices

```
:::choices
Ask about the locket
Say nothing
Leave
:::
```

A fence, matching the `:::left|center|right|justify` alignment blocks already in `renderMarkdown`.

**Why not `* option`:** `*` already means three things in this codebase - a markdown bullet (`- a` / `* a` produce `<ul>`), rp-action italics (`*smiles*`), and UT's own convention of prefixing ordinary dialogue lines with `*`. A fourth meaning would be ambiguous with all three and could be triggered by accident in normal prose. The fence cannot collide, and it reuses the existing block walker.

Parsing rules:

- Recognised only when `textboxStyle !== 'none'`.
- Only the **last** `:::choices` block in a message is used; earlier ones render as literal text.
- Blank lines inside the block are ignored. Each non-blank line is one option.
- Empty block (no options) is dropped entirely.
- More than 8 options: the first 8 are kept and the rest ignored, to avoid an unusable box.
- Inline marks (`**bold**` etc) are stripped from option text - options are plain strings.

### Expression tags

Inline `\E[Name]` tags, e.g. `\E[Anxious Side Eye]`. Bracketed because real sprite names contain spaces and parentheses - the reference set has `Grin (No Eyes)`, `Nervous Smile w- Eyebrow` and similar. Readable names also prompt the model far better than opaque codes like `\E1`.

Parsing rules:

- Matched case-insensitively against the character's `expressions` keys, ignoring surrounding whitespace.
- Recorded in the message's `expressions[]` with the character offset where each tag appeared, so the portrait can change **mid-page** as the typewriter passes that offset.
- Always **stripped from the rendered output**, whether or not they resolve, so a tag never prints as raw junk.
- An unknown name leaves the current portrait unchanged rather than blanking it.
- Offsets are recorded against the stripped text, so they stay correct as the typewriter advances.

### System prompt

When `textboxStyle !== 'none'`, `buildSystemPrompt` appends a short instruction explaining the choices fence and expression tags, and asking for 2-4 options when a choice makes sense.

When the character has `expressions`, the available names are listed so the model can only pick real ones. Kept terse - this is injected on every turn, and a 64-name list is not free. Names are sent comma-separated with no commentary.

## Rendering

### Pagination

The pixel font is monospace, so characters-per-line is deterministic and wrapping is pure arithmetic - no DOM measurement, no layout thrash, and the same result on every device.

- Greedy word-wrap to N characters per line. N is computed from the box's rendered width in `ch` units and recalculated on resize, clamped to a maximum (~46ch, close to the games' own line length) so the box does not stretch absurdly wide on a desktop monitor.
- 3 lines per page, matching both games.
- A word longer than N hard-breaks rather than overflowing.
- Blank lines in the source start a new page rather than consuming a text line. This keeps the paragraph-spacing behaviour added earlier from silently eating vertical space inside a fixed-height box.

### Typewriter

Characters reveal on an interval at `textboxSpeed` cps. While a reply is still streaming, the typewriter follows the incoming text rather than waiting for the full message.

Clicking the box skips to the end of the current page. `reduceMotion` (and the OS `prefers-reduced-motion` media query, both already honoured in this codebase) renders instantly with no animation and no sound.

### Portraits

`deltarune` style renders the portrait inside the box on the left, text offset to its right. `undertale` style renders no portrait even when the character has sprites, matching the games - UT shows portraits only in battle.

- Sprites render at their natural size with `image-rendering: pixelated`, scaled by an integer factor only. Non-integer scaling destroys pixel art.
- The portrait column is a fixed width, so text wrapping does not shift when the expression changes. This also means the pagination maths stays independent of which sprite is showing.
- The portrait changes mid-page as the typewriter passes each tag's offset.
- Character with `textboxStyle: 'deltarune'` but no `expressions`: renders the box with no portrait column, laid out as the UT box. This is the common case for most characters and must not look broken.

### Controls

- `▼` advances to the next page; a page counter (`1/3`) shows when there is more than one page.
- Back re-reads the previous page.
- Box paging is **independent** of the existing `msg.branches` / `currentBranch` swipe nav used for alternate greetings. Different controls, no interaction between them.

### Choices

Rendered in a second box below the dialogue box, with a `♥` cursor marking the hovered/selected row. Clicking an option sends that text as your next user message through the normal send path.

Choices only appear once the final page has finished typing, matching how the games gate a choice behind the dialogue.

## Expression authoring

A new tab in the character editor, alongside the existing basic/advanced tabs.

- **Bulk import:** select or drop many PNGs at once. The expression name derives from the filename with the extension and any trailing `[123456]` id stripped, so `Anxious Side Eye [323643].png` becomes `Anxious Side Eye`. This is the primary path - a 64-sprite set is unusable one file at a time.
- Grid of thumbnails with the name under each; rename, delete, and set-as-default per sprite.
- Sprites are stored as data URIs on the character, exactly like `avatar`, so they ride the existing sync and character-card export with no new plumbing.
- Import is capped (200 sprites, 256 KB each) with a clear error rather than silently bloating the sync blob.
- Non-image files in a dropped folder are skipped silently.

Sprites live in the character's synced data, **not** in the repo. That is both the right architecture - every character needs its own set - and it avoids committing third-party game assets to a public repository. The same reasoning applies to the audio, which is synthesized rather than sampled.

## Audio

WebAudio square-wave oscillator, one short blip per revealed character, pitched by `blipPitch`. Spaces and punctuation are skipped, as in the source games.

Synthesized rather than sampled deliberately: no bundled audio files, nothing copyrighted in a public repo, works offline in the PWA, and per-character pitch is closer to what the games actually do (Sans low, Papyrus high, Toriel soft) than one shared sample would be.

The audio call sits behind a single function, so real sample files can replace it later without touching the renderer.

## Font

Determination Mono, self-hosted as woff2 with `@font-face`, falling back to `JetBrains Mono` then `monospace`. Self-hosting is required for the PWA's offline cache; the repo has no `@font-face` today, so this is the first.

**License flag:** most distributors list Determination as personal-use only, with commercial use requiring contact with the designer. Inkling is free and personal, so this is very likely fine, but it is unresolved rather than confirmed. If it ever needs to be commercial-safe, the fallback is an openly-licensed pixel monospace with similar metrics - the pagination maths depends only on the font being monospace, not on which font it is.

## Degradation

| Situation | Behaviour |
|---|---|
| Model ignores the fence | Plain prose in a box, no choices. Nothing breaks. |
| `textboxStyle: 'none'` | Existing rendering path, completely untouched. |
| Malformed / unclosed fence | Treated as literal text, same as the alignment fences. |
| Font fails to load | Falls back to JetBrains Mono; monospace holds so pagination still works. |
| Sound blocked before user interaction | Silently skipped - browsers require a gesture before audio. |
| Empty message | Renders an empty box rather than throwing. |
| Expression tag names an unknown sprite | Tag stripped, current portrait kept. |
| `deltarune` style, no sprites imported | Box renders portrait-less, laid out as the UT box. |
| Sprite fails to decode | That slot renders empty; the rest of the box is unaffected. |

## Testing

**Unit** (extends the existing `renderMarkdown` harness pattern - slice the function out of the bundle, run under Node):

- Word-wrap and pagination, including the hard-break case and blank-line page breaks
- Choice parsing: last-block-wins, empty block dropped, 8-option cap, marks stripped
- Expression tags stripped from output and recorded with offsets; offsets correct against the *stripped* text, including several tags in one page
- Unknown expression name leaves the tag stripped but the portrait unchanged
- Bracketed names with spaces and parentheses resolve case-insensitively
- Filename to expression-name derivation, including the `[323643]` id suffix
- Interaction with the existing blank-line spacing behaviour
- `textboxStyle: 'none'` produces byte-identical output to today

**Browser** (Playwright, same harness as the earlier formatting work - serve the repo root, seed via `window.S`):

- Typewriter reveals progressively, then completes
- Click-to-skip jumps to the full page
- Paging forward and back, counter correct
- Choice click sends the option as a user message
- `reduceMotion` renders instantly
- Sound off by default; no AudioContext created unless enabled
- Portrait swaps mid-page as the typewriter passes a tag offset
- Bulk import of the 64-sprite reference set: names derived correctly, character still saves and syncs
- `deltarune` with no sprites renders portrait-less without layout breakage

## Open questions

None. All design decisions are settled above.
