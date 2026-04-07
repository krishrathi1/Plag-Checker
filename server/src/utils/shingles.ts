/**
 * Character-level Shingling
 *
 * Operates on raw character sequences rather than word tokens.
 * This catches plagiarism even after heavy word substitution / thesaurus attacks,
 * because the underlying character patterns still match.
 *
 * k=5 char shingles catch sentence-level copies.
 * k=8 char shingles catch paragraph-level copies more precisely.
 */

/** Normalise text before shingling: lowercase, collapse whitespace, strip punctuation */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build a set of all k-character substrings */
export function charShingles(text: string, k = 5): Set<string> {
  const s = normalise(text);
  const set = new Set<string>();
  if (s.length < k) return set;
  for (let i = 0; i <= s.length - k; i++) {
    set.add(s.slice(i, i + k));
  }
  return set;
}

/**
 * Containment similarity: |A ∩ B| / |A|
 * How much of query A is contained in source B.
 */
export function shingleContainment(queryText: string, sourceText: string, k = 5): number {
  const qa = charShingles(queryText, k);
  const sb = charShingles(sourceText, k);
  if (!qa.size) return 0;
  let shared = 0;
  for (const s of qa) if (sb.has(s)) shared++;
  return shared / qa.size;
}

/**
 * Jaccard on shingle sets — symmetric similarity.
 */
export function shingleJaccard(a: string, b: string, k = 5): number {
  const sa = charShingles(a, k);
  const sb = charShingles(b, k);
  if (!sa.size && !sb.size) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Multi-resolution similarity: average of k=4, k=6, k=9 containment scores.
 * k=4 catches very close paraphrases; k=9 catches direct copies.
 */
export function multiResShingleSimilarity(queryText: string, sourceText: string): number {
  const s4 = shingleContainment(queryText, sourceText, 4);
  const s6 = shingleContainment(queryText, sourceText, 6);
  const s9 = shingleContainment(queryText, sourceText, 9);
  return s4 * 0.25 + s6 * 0.45 + s9 * 0.30;
}
