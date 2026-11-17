// C21: font file validation and the monospace check used by the upload control.
import { loadSlice, makeRunner } from './harness.js';

const {
  detectFontFormat, validateTextboxFont, isMonospaceMetrics, textboxFontMaxBytes,
} = loadSlice('/* FONT-VALIDATE-START */', '/* FONT-VALIDATE-END */');
const TEXTBOX_FONT_MAX_BYTES = textboxFontMaxBytes();
const { eq, ok, done } = makeRunner();

const bytesOf = (...parts) => {
  const out = new Uint8Array(parts.length);
  parts.forEach((v, i) => { out[i] = v; });
  return out;
};
const TTF = bytesOf(0x00, 0x01, 0x00, 0x00, 0x00, 0x10);
const OTTO = bytesOf(0x4F, 0x54, 0x54, 0x4F, 0x00, 0x01);
const WOFF = bytesOf(0x77, 0x4F, 0x46, 0x46, 0x00, 0x01);
const WOFF2 = bytesOf(0x77, 0x4F, 0x46, 0x32, 0x00, 0x01);
const TEXT = bytesOf(0x3C, 0x68, 0x74, 0x6D, 0x6C, 0x3E);
const pad = (head, total) => {
  const out = new Uint8Array(total);
  out.set(head, 0);
  return out;
};

// ── signature detection ────────────────────────────────────────
{
  eq('TrueType signature', detectFontFormat(TTF), 'ttf');
  eq('OpenType/CFF signature', detectFontFormat(OTTO), 'otf');
  eq('WOFF signature', detectFontFormat(WOFF), 'woff');
  eq('WOFF2 signature', detectFontFormat(WOFF2), 'woff2');
  eq('Apple "true" tag', detectFontFormat(bytesOf(0x74, 0x72, 0x75, 0x65)), 'ttf');
  eq('HTML is not a font', detectFontFormat(TEXT), null);
  eq('empty input has no format', detectFontFormat(new Uint8Array(0)), null);
  eq('missing input has no format', detectFontFormat(undefined), null);
  eq('a short signature is rejected', detectFontFormat(bytesOf(0x77, 0x4F, 0x46)), null);
}

// ── validation ─────────────────────────────────────────────────
{
  const good = validateTextboxFont({ name: 'pixel.ttf', bytes: TTF });
  eq('a valid TTF passes', good.ok, true);
  eq('the format is reported', good.format, 'ttf');
  eq('the MIME is reported', good.mime, 'font/ttf');
  eq('the size is reported from the bytes', good.size, TTF.length);

  eq('an empty file is refused', validateTextboxFont({ name: 'empty.ttf', bytes: new Uint8Array(0) }).ok, false);
  ok('the empty error names the file', /empty/.test(validateTextboxFont({ name: 'empty.ttf', bytes: new Uint8Array(0) }).error));
  eq('non-font data is refused', validateTextboxFont({ name: 'notes.txt', bytes: TEXT }).ok, false);
  ok('the format error lists the accepted types', /TTF, OTF, WOFF or WOFF2/.test(validateTextboxFont({ name: 'notes.txt', bytes: TEXT }).error));

  const extMismatch = validateTextboxFont({ name: 'thing.woff2', bytes: TTF });
  eq('a renamed file is refused', extMismatch.ok, false);
  ok('the rename error explains the mismatch', /TTF data but is named \.woff2/.test(extMismatch.error));

  const atLimit = pad(WOFF, TEXTBOX_FONT_MAX_BYTES);
  eq('exactly 2 MB is allowed', validateTextboxFont({ name: 'big.woff', bytes: atLimit }).ok, true);
  const overLimit = pad(WOFF, TEXTBOX_FONT_MAX_BYTES + 1);
  eq('one byte over the limit is refused', validateTextboxFont({ name: 'big.woff', bytes: overLimit }).ok, false);
  ok('the size error mentions the cap', /2 MB or smaller/.test(validateTextboxFont({ name: 'big.woff', bytes: overLimit }).error));
  eq('an explicit size is honoured', validateTextboxFont({ name: 'x.ttf', bytes: TTF, size: 9 * 1024 * 1024 }).ok, false);
  eq('an unknown extension is fine when the signature is valid', validateTextboxFont({ name: 'font', bytes: WOFF2 }).ok, true);
  eq('the default cap is two megabytes', TEXTBOX_FONT_MAX_BYTES, 2097152);
}

// ── monospace warning ──────────────────────────────────────────
{
  ok('equal widths are monospace', isMonospaceMetrics({ i: 9.6, W: 9.6 }));
  ok('a hair of antialiasing is tolerated', isMonospaceMetrics({ i: 9.6, W: 9.9 }));
  eq('a proportional font is flagged', isMonospaceMetrics({ i: 4.4, W: 13.2 }), false);
  eq('missing metrics are flagged', isMonospaceMetrics({ i: NaN, W: 10 }), false);
  eq('empty metrics are flagged', isMonospaceMetrics(), false);
  eq('the tolerance can be tightened', isMonospaceMetrics({ i: 9.6, W: 9.9, tolerance: 0.1 }), false);
}

done();
