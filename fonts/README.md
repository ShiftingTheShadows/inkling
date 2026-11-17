# Fonts

## determination-mono.ttf

**Determination Mono Web** by Haley Wakamatsu (JapanYoshi).

- Source: https://www.fontspace.com/determination-mono-web-font-f23209
- License: Creative Commons **BY-NC-ND** (Attribution, Non-Commercial, No Derivatives)

Shipped as the original unmodified TTF rather than converted to WOFF2. The
No Derivatives term makes a format conversion legally ambiguous, and a 39 KB
TTF is small enough that the WOFF2 saving is not worth the question.

**Non-Commercial applies.** Inkling is free and personal, which this covers.
If the app ever becomes commercial, this font must be replaced. The textbox
pagination depends only on the font being monospace, so any monospace pixel
font with an appropriate licence can be swapped in by changing the
`@font-face` src and `--tbx-font` in `index.html`.

Users can also install their own font at runtime (C21): Settings → Appearance →
Textbox Font accepts TTF/OTF/WOFF/WOFF2 up to 2 MB, validated by file signature
and stored in IndexedDB as a device-local asset. It is deliberately not part of
the sync payload or exported backups, so another device needs its own upload.
Resetting there returns to the bundled font below without touching this file.

Attribution is surfaced in the app under Settings.
