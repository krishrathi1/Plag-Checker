/**
 * Winnowing fingerprinting algorithm for near-duplicate detection.
 * Reference: Schleimer, Wilkerson & Aiken (SIGMOD 2003).
 *
 * Steps:
 *  1. Build k-grams (overlapping token subsequences of length k).
 *  2. Hash each k-gram with a fast polynomial hash.
 *  3. Slide a window of width w; record the minimum hash in each window.
 *  4. Two documents share a fingerprint if their minimum-hash sets intersect.
 */

const K = 5; // k-gram length
const W = 4; // window width

function polyHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0; // unsigned 32-bit
}

function buildKgrams(tokens: string[], k: number): string[] {
  const result: string[] = [];
  for (let i = 0; i <= tokens.length - k; i++) {
    result.push(tokens.slice(i, i + k).join("\x00"));
  }
  return result;
}

export function winnowFingerprints(tokens: string[], k = K, w = W): Set<number> {
  const grams = buildKgrams(tokens, k);
  const hashes = grams.map(polyHash);
  const prints = new Set<number>();

  if (hashes.length < w) {
    // document too short — fall back to all hashes
    hashes.forEach((h) => prints.add(h));
    return prints;
  }

  for (let i = 0; i <= hashes.length - w; i++) {
    let minVal = hashes[i];
    for (let j = i + 1; j < i + w; j++) {
      if (hashes[j] < minVal) minVal = hashes[j];
    }
    prints.add(minVal);
  }
  return prints;
}

/**
 * Containment similarity: how much of A is contained in B.
 * Better than Jaccard for plagiarism (subset detection).
 */
export function winnowingSimilarity(tokensA: string[], tokensB: string[]): number {
  const fpA = winnowFingerprints(tokensA);
  const fpB = winnowFingerprints(tokensB);
  if (!fpA.size) return 0;
  let shared = 0;
  for (const h of fpA) {
    if (fpB.has(h)) shared++;
  }
  // containment: |A ∩ B| / |A|
  return shared / fpA.size;
}

/**
 * Symmetric Jaccard on fingerprint sets (used for document-level aggregate).
 */
export function winnowingJaccard(tokensA: string[], tokensB: string[]): number {
  const fpA = winnowFingerprints(tokensA);
  const fpB = winnowFingerprints(tokensB);
  if (!fpA.size && !fpB.size) return 0;
  let inter = 0;
  for (const h of fpA) {
    if (fpB.has(h)) inter++;
  }
  const union = fpA.size + fpB.size - inter;
  return union === 0 ? 0 : inter / union;
}
