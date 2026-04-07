/**
 * TF-IDF Cosine Similarity
 *
 * Much stronger than Jaccard for paraphrase detection because it weights
 * rare/distinctive terms higher and ignores stop-word noise.
 *
 * Usage in plagiarism engine:
 *  1. At report start, build an IDF table from the entire corpus.
 *  2. For each query sentence, compute its TF-IDF vector.
 *  3. Cosine-similarity against each pre-computed corpus sentence vector.
 */

// ─── Stop words (English) ─────────────────────────────────────────────────────

const STOP = new Set([
  "a","an","the","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","shall","can",
  "to","of","in","for","on","with","at","by","from","as","into","through",
  "during","before","after","above","below","between","each","few","more",
  "most","other","some","such","no","nor","not","only","own","same","so",
  "than","too","very","just","but","and","or","if","then","that","this","these",
  "those","it","its","i","you","he","she","we","they","what","which","who",
  "also","about","there","up","out","when","how","all","both","their","they",
]);

function isStop(token: string): boolean {
  return STOP.has(token.toLowerCase());
}

// ─── IDF table ────────────────────────────────────────────────────────────────

export type IdfTable = Map<string, number>;

/**
 * Build an IDF table from a list of pre-tokenised documents.
 * Uses smoothed IDF: log((N+1)/(df+1)) + 1
 */
export function buildIDF(tokenisedDocs: string[][]): IdfTable {
  const N = tokenisedDocs.length;
  const df = new Map<string, number>();
  for (const doc of tokenisedDocs) {
    for (const term of new Set(doc)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const idf: IdfTable = new Map();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((N + 1) / (freq + 1)) + 1);
  }
  return idf;
}

// ─── TF-IDF vector ────────────────────────────────────────────────────────────

export type TFIDFVector = Map<string, number>;

export function buildVector(tokens: string[], idf: IdfTable): TFIDFVector {
  const content = tokens.filter((t) => !isStop(t));
  if (!content.length) return new Map();

  const tf = new Map<string, number>();
  for (const t of content) tf.set(t, (tf.get(t) ?? 0) + 1);

  const vec: TFIDFVector = new Map();
  for (const [term, count] of tf) {
    const tfScore = count / content.length;
    const idfScore = idf.get(term) ?? Math.log((1 + 1) / (0 + 1)) + 1; // unseen term
    vec.set(term, tfScore * idfScore);
  }
  return vec;
}

// ─── Cosine similarity ────────────────────────────────────────────────────────

export function cosine(a: TFIDFVector, b: TFIDFVector): number {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  let normA = 0;
  for (const [term, val] of a) {
    dot += val * (b.get(term) ?? 0);
    normA += val * val;
  }
  let normB = 0;
  for (const val of b.values()) normB += val * val;
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Convenience: score one sentence against a list of pre-built vectors ──────

export function bestCosineMatch(
  queryVec: TFIDFVector,
  candidates: { vec: TFIDFVector; idx: number }[],
): { score: number; idx: number } {
  let best = { score: 0, idx: -1 };
  for (const c of candidates) {
    const s = cosine(queryVec, c.vec);
    if (s > best.score) best = { score: s, idx: c.idx };
  }
  return best;
}
