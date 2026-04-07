import { clamp, mean, tokenize, variance } from "../utils/text";

type Strictness = "relaxed" | "balanced" | "strict" | "extreme";
const STRICTNESS = (process.env.AI_STRICTNESS ?? "balanced").toLowerCase() as Strictness;

const COMMON_WORD_PROBS: Record<string, number> = {
  the: 0.053, of: 0.029, and: 0.025, to: 0.024, in: 0.020, a: 0.019, is: 0.011, that: 0.010,
  for: 0.009, with: 0.008, as: 0.007, on: 0.007, by: 0.006, this: 0.006, are: 0.006, be: 0.006,
  from: 0.005, it: 0.005, an: 0.004, at: 0.004, or: 0.004, which: 0.003, can: 0.003, has: 0.003,
  was: 0.003, will: 0.003, also: 0.0025, not: 0.0025, have: 0.0024, their: 0.0023, more: 0.0022,
};

const COMMON_BIGRAM_PROBS: Record<string, number> = {
  "of the": 0.030, "in the": 0.025, "to the": 0.020, "for the": 0.016, "on the": 0.015,
  "and the": 0.014, "is a": 0.012, "is the": 0.012, "as a": 0.011, "with the": 0.011,
  "it is": 0.010, "there is": 0.009, "in this": 0.009, "this is": 0.009, "can be": 0.009,
  "we can": 0.008, "we use": 0.008, "this paper": 0.008, "this study": 0.007, "this project": 0.007,
};

const CONNECTOR_TERMS = [
  "furthermore",
  "moreover",
  "additionally",
  "therefore",
  "consequently",
  "in conclusion",
  "in summary",
  "as a result",
  "in other words",
];

const TEMPLATE_TERMS = [
  "the main objective",
  "the overall workflow",
  "this methodology",
  "it is important to note",
  "it should be noted",
  "the proposed system",
  "plays a crucial role",
  "this project aims",
];

export interface AIDocumentScore {
  probability: number;
  band: "LIKELY_HUMAN" | "UNCERTAIN" | "LIKELY_AI";
  reasons: string[];
  signals: Record<string, number>;
}

function strictMultiplier(): number {
  if (STRICTNESS === "relaxed") return 0.88;
  if (STRICTNESS === "balanced") return 1.0;
  if (STRICTNESS === "strict") return 1.15;
  return 1.3;
}

function phraseDensity(text: string, phrases: string[]): number {
  const lower = text.toLowerCase();
  const hits = phrases.reduce((sum, phrase) => sum + (lower.includes(phrase) ? 1 : 0), 0);
  return hits / Math.max(1, phrases.length);
}

function punctuationDensity(text: string): number {
  return (text.match(/[,:;!?()\-]/g) ?? []).length / Math.max(1, text.length);
}

function lexicalDiversity(tokens: string[]): number {
  if (!tokens.length) return 1;
  return new Set(tokens).size / tokens.length;
}

function repetitiveTrigramRatio(tokens: string[]): number {
  if (tokens.length < 6) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < tokens.length - 2; i++) {
    const tri = `${tokens[i]}\u0000${tokens[i + 1]}\u0000${tokens[i + 2]}`;
    counts.set(tri, (counts.get(tri) ?? 0) + 1);
  }
  const repeated = [...counts.values()].filter((v) => v > 1).length;
  return repeated / Math.max(1, counts.size);
}

function tokenSurprisal(tokens: string[]): number {
  if (!tokens.length) return 0;
  const eps = 1e-6;
  const values: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const uni = COMMON_WORD_PROBS[tokens[i]] ?? eps;
    const biKey = i > 0 ? `${tokens[i - 1]} ${tokens[i]}` : "";
    const bi = biKey ? (COMMON_BIGRAM_PROBS[biKey] ?? 0) : 0;
    const p = Math.max(eps, uni * 0.7 + bi * 0.3);
    values.push(-Math.log(p));
  }
  return mean(values);
}

function sentencePerplexity(sentence: string): number {
  const tokens = tokenize(sentence);
  if (!tokens.length) return 999;
  const avgSurprisal = tokenSurprisal(tokens);
  return Math.exp(avgSurprisal);
}

function perplexitySignal(meanPerplexity: number): number {
  // Lower perplexity => more AI-like.
  return clamp((80 - meanPerplexity) / 60);
}

function burstinessSignal(perSentencePpl: number[]): number {
  if (perSentencePpl.length < 2) return 0.5;
  const pplVar = variance(perSentencePpl);
  // Low variance => more AI-like.
  return clamp((1200 - pplVar) / 1200);
}

function entropySignal(text: string): number {
  const chars = text.toLowerCase().replace(/[^a-z]/g, "");
  if (chars.length < 20) return 0.5;
  const freq = new Map<string, number>();
  for (const ch of chars) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / chars.length;
    h -= p * Math.log2(p);
  }
  // Lower entropy => more AI-like.
  return clamp((4.5 - h) / 2.5);
}

function sentenceStartDiversity(sentences: string[]): number {
  const starts = sentences
    .map((s) => s.trim().toLowerCase().split(/\s+/).slice(0, 2).join(" "))
    .filter(Boolean);
  if (!starts.length) return 1;
  return new Set(starts).size / starts.length;
}

function reasonEngine(signals: Record<string, number>): string[] {
  const entries = Object.entries(signals).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const reasons: string[] = [];
  for (const [k, v] of entries) {
    if (v < 0.55) continue;
    if (k === "perplexity") reasons.push("Low perplexity indicates highly predictable token choices.");
    if (k === "burstiness") reasons.push("Low sentence-level perplexity variance suggests uniform generation rhythm.");
    if (k === "trigram_repeat") reasons.push("Repeated trigram patterns indicate autoregressive reuse.");
    if (k === "lexical_uniformity") reasons.push("Lexical distribution appears overly uniform.");
    if (k === "entropy") reasons.push("Character entropy is lower than expected for natural human variability.");
    if (k === "template_density") reasons.push("Template-style instructional phrasing appears frequently.");
    if (k === "connector_density") reasons.push("Connector-heavy transitions suggest formulaic generated style.");
    if (k === "structure_uniformity") reasons.push("Sentence opening patterns are unusually repetitive.");
  }
  if (!reasons.length) reasons.push("No dominant AI signal exceeded explanation threshold.");
  return reasons;
}

function calibrate(raw: number): number {
  // Isotonic-like monotonic piecewise map.
  const points: Array<[number, number]> =
    STRICTNESS === "extreme"
      ? [[0, 0], [0.2, 0.12], [0.4, 0.35], [0.6, 0.65], [0.8, 0.88], [1, 1]]
      : [[0, 0], [0.2, 0.08], [0.4, 0.22], [0.6, 0.46], [0.8, 0.73], [1, 1]];

  const x = clamp(raw);
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    if (x >= x1 && x <= x2) {
      const t = (x - x1) / Math.max(1e-9, x2 - x1);
      return y1 + t * (y2 - y1);
    }
  }
  return points[points.length - 1][1];
}

export function scoreSentenceAI(sentence: string): { probability: number; confidence: [number, number] } {
  const tokens = tokenize(sentence);
  if (tokens.length < 4) return { probability: 0.4, confidence: [0.2, 0.6] };

  const ppl = sentencePerplexity(sentence);
  const perplexity = perplexitySignal(ppl);
  const trigramRepeat = repetitiveTrigramRatio(tokens);
  const lexicalUniformity = clamp(1 - lexicalDiversity(tokens));
  const entropy = entropySignal(sentence);
  const connectorDensity = phraseDensity(sentence, CONNECTOR_TERMS);
  const templateDensity = phraseDensity(sentence, TEMPLATE_TERMS);
  const punct = clamp(1 - punctuationDensity(sentence) / 0.05);

  const raw =
    0.28 * perplexity +
    0.14 * trigramRepeat +
    0.12 * lexicalUniformity +
    0.11 * entropy +
    0.10 * connectorDensity +
    0.10 * templateDensity +
    0.15 * punct;

  const p = calibrate(clamp(raw * strictMultiplier()));
  const spread = clamp(0.20 - tokens.length * 0.003, 0.06, 0.20);
  return {
    probability: Number(p.toFixed(4)),
    confidence: [Number(clamp(p - spread).toFixed(4)), Number(clamp(p + spread).toFixed(4))],
  };
}

export function scoreDocumentAI(sentences: string[], sentenceScores: number[]): AIDocumentScore {
  if (!sentences.length) {
    return {
      probability: 0,
      band: "LIKELY_HUMAN",
      reasons: ["No analyzable sentence content found."],
      signals: {},
    };
  }

  const text = sentences.join(" ");
  const tokens = tokenize(text);
  const sentencePpl = sentences.map((s) => sentencePerplexity(s)).filter((v) => Number.isFinite(v));
  const meanPpl = sentencePpl.length ? mean(sentencePpl) : 999;

  const signals: Record<string, number> = {
    perplexity: perplexitySignal(meanPpl),
    burstiness: burstinessSignal(sentencePpl),
    trigram_repeat: repetitiveTrigramRatio(tokens),
    lexical_uniformity: clamp(1 - lexicalDiversity(tokens)),
    entropy: entropySignal(text),
    connector_density: phraseDensity(text, CONNECTOR_TERMS),
    template_density: phraseDensity(text, TEMPLATE_TERMS),
    structure_uniformity: clamp(1 - sentenceStartDiversity(sentences)),
  };

  // Weighted fusion layer (normalized 0..1 signals).
  const raw =
    0.25 * signals.perplexity +
    0.15 * signals.burstiness +
    0.10 * signals.trigram_repeat +
    0.10 * signals.lexical_uniformity +
    0.10 * signals.entropy +
    0.30 * (0.35 * signals.connector_density + 0.35 * signals.template_density + 0.30 * signals.structure_uniformity);

  let probability = calibrate(clamp(raw * strictMultiplier()));

  // Safety cap: avoid accidental hard-100 unless overwhelming evidence.
  const overwhelming =
    signals.perplexity > 0.75 &&
    signals.burstiness > 0.75 &&
    signals.trigram_repeat > 0.55 &&
    signals.template_density > 0.40;
  if (!overwhelming) probability = Math.min(probability, 0.94);

  probability = Number(probability.toFixed(4));

  const band: AIDocumentScore["band"] =
    probability < 0.40 ? "LIKELY_HUMAN" : probability < 0.70 ? "UNCERTAIN" : "LIKELY_AI";

  return {
    probability,
    band,
    reasons: reasonEngine(signals),
    signals,
  };
}

export function getAiEngineLabel(): string {
  return `perplexity-burstiness-fusion-v9-${STRICTNESS}`;
}
