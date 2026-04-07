/**
 * Obfuscation detection and normalisation.
 *
 * Detects and neutralises common tricks used to fool plagiarism detectors:
 *  1. Homoglyphs — look-alike Unicode characters substituted for ASCII
 *     (e.g. Cyrillic 'а' → ASCII 'a', Greek 'ο' → ASCII 'o')
 *  2. Zero-width characters injected to break word fingerprints
 *  3. Invisible / non-breaking spaces replacing regular spaces
 *  4. Right-to-left override characters that scramble display
 *  5. Ligature abuse (ﬁ, ﬂ → fi, fl)
 *  6. Full-width ASCII (Ａ → A)
 *
 * All detection happens BEFORE scoring so obfuscated text is caught.
 */

// ─── Homoglyph table ──────────────────────────────────────────────────────────
// Maps confusable Unicode codepoints to their ASCII equivalents.
// Source: Unicode Consortium confusables.txt (trimmed to common academic attacks)

const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic look-alikes
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c",
  "\u0445": "x", "\u0443": "y", "\u0456": "i", "\u0410": "A", "\u0412": "B",
  "\u0415": "E", "\u041a": "K", "\u041c": "M", "\u041d": "H", "\u041e": "O",
  "\u0420": "P", "\u0421": "C", "\u0422": "T", "\u0425": "X", "\u042a": "b",
  // Greek look-alikes
  "\u03b1": "a", "\u03b2": "b", "\u03b5": "e", "\u03b7": "n", "\u03b9": "i",
  "\u03bd": "v", "\u03bf": "o", "\u03c1": "p", "\u03c5": "u", "\u03c7": "x",
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0397": "H", "\u0399": "I",
  "\u039a": "K", "\u039c": "M", "\u039d": "N", "\u039f": "O", "\u03a1": "P",
  "\u03a4": "T", "\u03a7": "X", "\u03a5": "Y",
  // Latin extended look-alikes
  "\u0131": "i", "\u0237": "j", "\u0261": "g", "\u1d00": "a", "\u1d07": "e",
  "\u0277": "o", "\u028f": "y",
  // Full-width ASCII (U+FF01–U+FF5E)
  ...Object.fromEntries(
    Array.from({ length: 94 }, (_, i) => [
      String.fromCodePoint(0xff01 + i),
      String.fromCodePoint(0x21 + i),
    ]),
  ),
  // Ligatures
  "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl",
  "\u00e6": "ae", "\u0153": "oe",
  // Dotless i / dotted I
  "\u0130": "I",
};

// ─── Zero-width / invisible characters ───────────────────────────────────────

const INVISIBLE_PATTERN =
  /[\u200b\u200c\u200d\u200e\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]/g;

// ─── Non-breaking / unusual whitespace ───────────────────────────────────────

const UNUSUAL_SPACE_PATTERN =
  /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Normalise text by replacing obfuscation characters with their canonical forms.
 * Returns { normalised, flags } where flags lists the types of obfuscation found.
 */
export function normaliseAndDetect(text: string): {
  normalised: string;
  flags: ObfuscationFlag[];
} {
  const flags: ObfuscationFlag[] = [];

  // 1. Detect invisible characters
  if (INVISIBLE_PATTERN.test(text)) {
    flags.push({ type: "invisible_chars", severity: "HIGH", detail: "Zero-width / invisible Unicode characters detected" });
  }
  INVISIBLE_PATTERN.lastIndex = 0;

  // 2. Detect unusual whitespace
  if (UNUSUAL_SPACE_PATTERN.test(text)) {
    flags.push({ type: "unusual_whitespace", severity: "MEDIUM", detail: "Non-breaking or unusual whitespace characters detected" });
  }
  UNUSUAL_SPACE_PATTERN.lastIndex = 0;

  // 3. Detect homoglyphs
  const homoglyphCount = countHomoglyphs(text);
  if (homoglyphCount > 0) {
    flags.push({
      type: "homoglyphs",
      severity: homoglyphCount > 5 ? "HIGH" : "MEDIUM",
      detail: `${homoglyphCount} homoglyph substitution(s) detected (Unicode look-alike characters)`,
    });
  }

  // 4. Detect full-width ASCII
  if (/[\uff01-\uff5e]/.test(text)) {
    flags.push({ type: "fullwidth_ascii", severity: "MEDIUM", detail: "Full-width ASCII characters detected" });
  }

  // 5. Apply all normalisation
  let normalised = text;
  normalised = normalised.replace(INVISIBLE_PATTERN, "");
  normalised = normalised.replace(UNUSUAL_SPACE_PATTERN, " ");
  normalised = applyHomoglyphs(normalised);

  return { normalised, flags };
}

function applyHomoglyphs(text: string): string {
  return [...text]
    .map((ch) => HOMOGLYPH_MAP[ch] ?? ch)
    .join("");
}

function countHomoglyphs(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (HOMOGLYPH_MAP[ch] && HOMOGLYPH_MAP[ch] !== ch) count++;
  }
  return count;
}

export interface ObfuscationFlag {
  type: "homoglyphs" | "invisible_chars" | "unusual_whitespace" | "fullwidth_ascii";
  severity: "LOW" | "MEDIUM" | "HIGH";
  detail: string;
}
