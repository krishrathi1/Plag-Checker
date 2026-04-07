/**
 * Plagiarism Detection Engine — v3 (multi-pass, 3 methods)
 *
 * Pass 1 — Winnowing fingerprint containment  (exact / near-exact copies)
 * Pass 2 — TF-IDF cosine similarity           (paraphrase detection)
 * Pass 3 — Character-level shingles (multi-res) (fragment / thesaurus attacks)
 *
 * Final sentence score = max of all three passes (take the strongest signal).
 * Document score = weighted by sentence token length.
 *
 * Corpus is indexed once per document for performance:
 *  - IDF table built from all corpus docs
 *  - Each corpus sentence pre-tokenised + TF-IDF vectorised
 *  - Each corpus sentence char-shingled at k=5,6,9
 */

import { CorpusDoc, SourceMatch } from "../types";
import { clamp, splitSentences, tokenize } from "../utils/text";
import { stripInlineCitations } from "../utils/citations";
import { winnowingSimilarity } from "../utils/winnowing";
import { buildIDF, buildVector, cosine, IdfTable, TFIDFVector } from "../utils/tfidf";
import { multiResShingleSimilarity } from "../utils/shingles";
import { getEmbedding, cosineSimilarity as vectorCosine } from "../utils/embedding";

export interface SentenceSimilarity {
  score: number;
  sources: SourceMatch[];
  method: "exact" | "semantic" | "shingle" | "embedding" | "none";
}

const GOD_MODE = (process.env.PLAGIARISM_GOD_MODE ?? "false").toLowerCase() === "true";

// ─── Corpus index built once per scan ────────────────────────────────────────

interface CorpusEntry {
  doc: CorpusDoc;
  sentences: string[];
  sentenceTokens: string[][];
  sentenceVecs: TFIDFVector[];
  sentenceEmbeddings: number[][];
  fullTokens: string[];
}

export interface CorpusIndex {
  entries: CorpusEntry[];
  idf: IdfTable;
  tokenToEntryIndices: Map<string, number[]>;
}

const MAX_DOC_CANDIDATES = Number(process.env.PLAGIARISM_MAX_DOC_CANDIDATES ?? 120);

export async function buildCorpusIndex(corpus: CorpusDoc[]): Promise<CorpusIndex> {
  const allSentenceTokens: string[][] = [];
  const tokenBuckets = new Map<string, Set<number>>();
  const entries: CorpusEntry[] = [];
  
  for (const doc of corpus) {
    const sentences = splitSentences(doc.content);
    const sentenceTokens = sentences.map(tokenize);
    sentenceTokens.forEach((t) => allSentenceTokens.push(t));
    entries.push({ doc, sentences, sentenceTokens, sentenceVecs: [], sentenceEmbeddings: [], fullTokens: tokenize(doc.content) });
  }

  const idf = buildIDF(allSentenceTokens);

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    entry.sentenceVecs = entry.sentenceTokens.map((t) => buildVector(t, idf));
    entry.sentenceEmbeddings = await Promise.all(entry.sentences.map(s => getEmbedding(s)));
    
    const unique = new Set(entry.fullTokens);
    for (const token of unique) {
      const set = tokenBuckets.get(token) ?? new Set<number>();
      set.add(entryIndex);
      tokenBuckets.set(token, set);
    }
  }

  const tokenToEntryIndices = new Map<string, number[]>();
  for (const [token, set] of tokenBuckets.entries()) {
    tokenToEntryIndices.set(token, [...set]);
  }

  return { entries, idf, tokenToEntryIndices };
}

// ─── Single-sentence scoring ──────────────────────────────────────────────────

export async function scoreSentenceSimilarity(
  sentence: string,
  index: CorpusIndex,
): Promise<SentenceSimilarity> {
  const cleaned = stripInlineCitations(sentence);
  const queryTokens = tokenize(cleaned);

  if (queryTokens.length < 3 || !index.entries.length) {
    return { score: 0, sources: [], method: "none" };
  }

  const useWinnowing = queryTokens.length >= 6;
  const queryVec = buildVector(queryTokens, index.idf);
  const uniqueQueryTokens = new Set(queryTokens);
  const queryEmbedding = await getEmbedding(cleaned);

  const candidateScore = new Map<number, number>();
  for (const token of uniqueQueryTokens) {
    const bucket = index.tokenToEntryIndices.get(token);
    if (!bucket) continue;
    for (const idx of bucket) {
      candidateScore.set(idx, (candidateScore.get(idx) ?? 0) + 1);
    }
  }

  const candidateDocIndices =
    candidateScore.size === 0
      ? index.entries.map((_, i) => i)
      : [...candidateScore.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_DOC_CANDIDATES)
          .map(([idx]) => idx);

  const sourceScores: { doc: CorpusDoc; score: number; method: SentenceSimilarity["method"] }[] = [];

  for (const entryIndex of candidateDocIndices) {
    const entry = index.entries[entryIndex];
    let bestScore = 0;
    let bestMethod: SentenceSimilarity["method"] = "none";

    for (let i = 0; i < entry.sentences.length; i++) {
      const srcSentence = entry.sentences[i];
      const srcTokens = entry.sentenceTokens[i];
      const srcVec = entry.sentenceVecs[i];
      const srcEmb = entry.sentenceEmbeddings[i];

      // Pass 1: Winnowing
      let w = 0;
      if (useWinnowing) {
        w = winnowingSimilarity(queryTokens, srcTokens);
      }

      // Pass 2: TF-IDF cosine
      const cos = cosine(queryVec, srcVec);

      // Pass 3: Character shingles
      const shing = multiResShingleSimilarity(cleaned, srcSentence);
      
      // Pass 4: Embedding cosine
      const embCos = vectorCosine(queryEmbedding, srcEmb);

      const localBest = Math.max(w, cos, shing, embCos);
      let localMethod: SentenceSimilarity["method"] = "none";
      if (localBest === w && w > 0) localMethod = "exact";
      else if (localBest === embCos && embCos > 0) localMethod = "embedding";
      else if (localBest === cos && cos > 0) localMethod = "semantic";
      else if (shing > 0) localMethod = "shingle";

      if (localBest > bestScore) {
        bestScore = localBest;
        bestMethod = localMethod;
      }
    }

    if (bestScore > 0.12) {
      sourceScores.push({ doc: entry.doc, score: bestScore, method: bestMethod });
    }
  }

  sourceScores.sort((a, b) => b.score - a.score);
  const top = sourceScores.slice(0, 5);

  const topScore = top[0]?.score ?? 0;
  const topMethod = top[0]?.method ?? "none";

  const sources: SourceMatch[] = top.map((s) => ({
    title: s.doc.title,
    url: s.doc.url,
    match_percentage: Number((s.score * 100).toFixed(2)),
    access_date: new Date().toISOString().slice(0, 10),
  }));

  return { score: topScore, sources, method: topMethod };
}

// ─── Document aggregate ───────────────────────────────────────────────────────

export function scoreDocumentSimilarity(
  sentences: string[],
  sentenceScores: number[],
): number {
  if (!sentences.length) return 0;
  const tokenLengths = sentences.map((s) => tokenize(s).length);
  const totalTokens = tokenLengths.reduce((a, b) => a + b, 0);
  if (!totalTokens) return 0;
  const weightedSum = sentenceScores.reduce((sum, score, i) => sum + score * tokenLengths[i], 0);
  const weightedMean = weightedSum / totalTokens;

  // Match coverage: how much of the document has meaningful overlap.
  const matchedTokens = sentenceScores.reduce((sum, score, i) => {
    if (score < 0.2) return sum;
    return sum + tokenLengths[i];
  }, 0);
  const coverage = matchedTokens / totalTokens;

  const mediumMatchedTokens = sentenceScores.reduce((sum, score, i) => {
    if (score < 0.12) return sum;
    return sum + tokenLengths[i];
  }, 0);
  const mediumCoverage = mediumMatchedTokens / totalTokens;

  // Focus on strongest overlaps (closer to institutional plagiarism report behaviour).
  const sorted = [...sentenceScores].sort((a, b) => b - a);
  const topK = Math.max(1, Math.ceil(sorted.length * 0.25));
  const topMean = sorted.slice(0, topK).reduce((s, v) => s + v, 0) / topK;
  const upperTailK = Math.max(1, Math.ceil(sorted.length * 0.5));
  const upperTailMean = sorted.slice(0, upperTailK).reduce((s, v) => s + v, 0) / upperTailK;

  let boosted = Math.min(
    1,
    weightedMean * 0.35 + coverage * 0.25 + topMean * 0.25 + upperTailMean * 0.15,
  );

  if (GOD_MODE) {
    // Aggressive nonlinear escalation: if broad document coverage exists, score should rise quickly.
    const nonlinearCoverage = Math.sqrt(clamp(mediumCoverage, 0, 1));
    const nonlinearTop = Math.pow(clamp(topMean, 0, 1), 0.70);

    boosted = Math.min(
      1,
      boosted * 0.45 + nonlinearCoverage * 0.35 + nonlinearTop * 0.20,
    );

    const highCount = sentenceScores.filter((s) => s >= 0.30).length;
    const ratioHigh = highCount / Math.max(1, sentenceScores.length);
    if (ratioHigh >= 0.45 && mediumCoverage >= 0.70) boosted += 0.18;
    if (ratioHigh >= 0.60 && mediumCoverage >= 0.80) boosted += 0.20;
    if (topMean >= 0.45 && mediumCoverage >= 0.85) boosted += 0.14;
    if (mediumCoverage >= 0.90) boosted += 0.14;

    // Coverage-dominant hard floor only for very strongly-evidenced cases.
    const strictFloor = clamp(mediumCoverage * 0.95 + topMean * 0.35);
    if (mediumCoverage >= 0.75 && topMean >= 0.35) {
      boosted = Math.max(boosted, strictFloor);
    }

    if (mediumCoverage >= 0.75) boosted += 0.10;
    if (mediumCoverage >= 0.85) boosted += 0.08;
    if (mediumCoverage >= 0.92) boosted += 0.06;

    // Clamp final
    boosted = Math.min(1, boosted);
  }

  // Saturation guard: prevent 100% unless evidence is truly overwhelming.
  const highCount2 = sentenceScores.filter((s) => s >= 0.35).length;
  const ratioHigh2 = highCount2 / Math.max(1, sentenceScores.length);
  const overwhelming = mediumCoverage >= 0.92 && topMean >= 0.55 && ratioHigh2 >= 0.65;
  if (!overwhelming) {
    boosted = Math.min(boosted, 0.94);
  }

  return Number(boosted.toFixed(4));
}