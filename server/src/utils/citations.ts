/**
 * Citation detection and exclusion.
 * Identifies properly cited passages so they are excluded from the
 * plagiarism similarity score per FR-012.
 *
 * Covers: APA, MLA, Chicago (author-date + footnote), IEEE bracket style, DOIs.
 */

// ─── Inline citation patterns ────────────────────────────────────────────────

// APA: (Author, 2021) or (Author & Author, 2021) or (Author et al., 2021, p. 42)
const APA_INLINE = /\(([A-Z][a-zA-Zà-öø-ÿÀ-ÖØ-ß\-]+(?:\s+(?:&|and|et al\.?)\s+[A-Z][a-zA-Zà-öø-ÿÀ-ÖØ-ß\-]+)?),\s*\d{4}(?:,\s*pp?\.\s*[\d–\-]+)?\)/g;

// MLA: (Author 42) or (Author and Author 42) or (Author et al. 42)
const MLA_INLINE = /\(([A-Z][a-zA-Z\-]+(?:\s+(?:and|et al\.?)\s+[A-Z][a-zA-Z\-]+)?)\s+\d+\)/g;

// IEEE: [1] or [1, 2] or [1–3]
const IEEE_INLINE = /\[\d+(?:[,–\-]\s*\d+)*\]/g;

// Chicago footnote markers: superscript-like numbers (¹ or standalone digit after punct)
const CHICAGO_NOTE = /(?<=\S)\d{1,3}(?=[\s,.]|$)/g;

// ─── Reference-list sentence patterns ────────────────────────────────────────

// Lines that look like bibliography entries (start with Author, Year or [N])
const REF_LIST_LINE =
  /^(?:\[\d+\]|\d+\.|[A-Z][a-zA-Z\-]+,\s+[A-Z]\.?)\s+.{20,}/;

// DOI anywhere in sentence
const DOI_PATTERN = /\b(?:doi|DOI):\s*10\.\d{4,}\/\S+/;

// URL reference
const URL_PATTERN = /https?:\/\/\S+/;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if a sentence is primarily a citation/reference and should be
 * excluded from the similarity score.
 */
export function isCitationSentence(sentence: string): boolean {
  const s = sentence.trim();
  if (!s) return false;

  // Full reference-list entries
  if (REF_LIST_LINE.test(s)) return true;

  // Contains a DOI → bibliographic reference
  if (DOI_PATTERN.test(s)) return true;

  // Short sentences that are purely inline citations
  if (s.length < 60) {
    if (IEEE_INLINE.test(s) || APA_INLINE.test(s) || MLA_INLINE.test(s)) return true;
    // reset lastIndex on global regexes
    IEEE_INLINE.lastIndex = 0;
    APA_INLINE.lastIndex = 0;
    MLA_INLINE.lastIndex = 0;
  }

  return false;
}

/**
 * Strips inline citation markers from a sentence before plagiarism scoring,
 * so the remaining prose is compared fairly.
 */
export function stripInlineCitations(sentence: string): string {
  return sentence
    .replace(APA_INLINE, "")
    .replace(MLA_INLINE, "")
    .replace(IEEE_INLINE, "")
    .replace(DOI_PATTERN, "")
    .replace(URL_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Given an array of sentences, returns the count excluded as citations and
 * the filtered array for scoring.
 */
export function filterCitations(sentences: string[]): {
  filtered: string[];
  excludedCount: number;
  citationFlags: boolean[];
} {
  const citationFlags = sentences.map(isCitationSentence);
  const filtered = sentences.filter((_, i) => !citationFlags[i]);
  return {
    filtered,
    excludedCount: citationFlags.filter(Boolean).length,
    citationFlags,
  };
}
