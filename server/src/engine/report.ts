/**
 * Report Generation Engine — v3
 *
 * Orchestrates all detection subsystems:
 *  1. Obfuscation normalisation (before all analysis)
 *  2. Citation exclusion
 *  3. Corpus indexing (TF-IDF + Winnowing + shingles)
 *  4. Per-sentence plagiarism (3-pass multi-method)
 *  5. Per-sentence AI detection (12-signal ensemble)
 *  6. Paragraph-level aggregation
 *  7. Forensic metadata (DOCX meta, obfuscation flags, risk explanation)
 *  8. Role-based source masking
 */

import { getAiEngineLabel, scoreDocumentAI, scoreSentenceAI } from "./ai";
import { scoreCodeSimilarity } from "./code";
import {
  buildCorpusIndex,
  scoreDocumentSimilarity,
  scoreSentenceSimilarity,
} from "./plagiarism";
import {
  CorpusDoc,
  ForensicSummary,
  OrgConfig,
  ParagraphReport,
  Report,
  Role,
  SourceMatch,
} from "../types";
import { DocxMeta } from "../utils/docx-meta";
import { ObfuscationFlag, normaliseAndDetect } from "../utils/obfuscation";
import { filterCitations } from "../utils/citations";
import { isCodeFile } from "../utils/extract";
import { mean, splitSentences, tokenize } from "../utils/text";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inferLanguage(text: string): string {
  const nonAscii = (text.match(/[^\x00-\x7F]/g) ?? []).length;
  if (nonAscii / Math.max(1, text.length) > 0.15) return "multilingual";
  if (/\b(der|die|das|und|ist|ein|nicht)\b/i.test(text)) return "de";
  if (/\b(le|la|les|et|est|une|des)\b/i.test(text)) return "fr";
  if (/\b(el|la|los|las|y|es|un|una)\b/i.test(text)) return "es";
  return "en";
}

function getRiskBand(similarity: number, aiProbability: number): "LOW" | "MODERATE" | "HIGH" {
  if (similarity >= 0.35 || aiProbability >= 0.50) return "HIGH";
  if (similarity >= 0.15 || aiProbability >= 0.22) return "MODERATE";
  return "LOW";
}

function buildRiskExplanation(
  similarity: number,
  aiProbability: number,
  obfFlags: ObfuscationFlag[],
  docxMeta: DocxMeta | undefined,
  highSimCount: number,
  highAICount: number,
  totalSentences: number,
): string {
  const parts: string[] = [];

  if (similarity >= 0.40) {
    parts.push(
      `Plagiarism similarity is ${(similarity * 100).toFixed(1)}% — above the HIGH threshold of 40%. ${highSimCount} of ${totalSentences} sentences match external sources.`,
    );
  } else if (similarity >= 0.18) {
    parts.push(
      `Plagiarism similarity is ${(similarity * 100).toFixed(1)}% — MODERATE risk. ${highSimCount} sentences exceed the per-sentence threshold.`,
    );
  } else {
    parts.push(`Plagiarism similarity is ${(similarity * 100).toFixed(1)}% — within acceptable range.`);
  }

  if (aiProbability >= 0.50) {
    parts.push(
      `AI generation probability is ${(aiProbability * 100).toFixed(1)}% — HIGH. ${highAICount} sentences show strong AI authorship signals (connector overuse, passive voice, hedging, repetitive patterns).`,
    );
  } else if (aiProbability >= 0.22) {
    parts.push(
      `AI generation probability is ${(aiProbability * 100).toFixed(1)}% — MODERATE. Some AI-generated passages detected.`,
    );
  } else {
    parts.push(`AI generation probability is ${(aiProbability * 100).toFixed(1)}% — within human range.`);
  }

  if (obfFlags.length > 0) {
    const highObf = obfFlags.filter((f) => f.severity === "HIGH");
    if (highObf.length) {
      parts.push(
        `⚠ HIGH-severity obfuscation detected: ${highObf.map((f) => f.type).join(", ")}. Text may have been deliberately manipulated to evade detection.`,
      );
    }
  }

  if (docxMeta) {
    const critFlags = docxMeta.suspicionFlags.filter((f) => f.severity === "HIGH");
    if (critFlags.length) {
      parts.push(`Document forensics: ${critFlags.map((f) => f.message).join(" ")}`);
    }
  }

  return parts.join(" ");
}

function buildPlainLanguageSummary(
  similarity: number,
  aiProbability: number,
  highSimCount: number,
  highAICount: number,
  totalSentences: number,
): string {
  return [
    `We checked ${totalSentences} sentences.`,
    `${highSimCount} sentences had strong source overlap.`,
    `${highAICount} sentences looked highly machine-like.`,
    `Overall similarity is ${(similarity * 100).toFixed(1)}% and AI likelihood is ${(aiProbability * 100).toFixed(1)}%.`,
  ].join(" ");
}

function buildImprovementTips(
  similarity: number,
  aiProbability: number,
  excludedCount: number,
  obfuscationFlags: ObfuscationFlag[],
): string[] {
  const tips: string[] = [];
  if (similarity >= 0.2) {
    tips.push("Rewrite matched passages in your own words and add clear citations for borrowed ideas.");
  }
  if (aiProbability >= 0.5) {
    tips.push("Add your own examples, personal reasoning, and topic-specific details to make authorship clearer.");
    tips.push("Vary sentence length and structure naturally instead of repeating template transitions.");
  }
  if (excludedCount === 0) {
    tips.push("Include proper in-text citations and a reference list where external claims are used.");
  }
  if (obfuscationFlags.length > 0) {
    tips.push("Remove hidden characters or unusual symbols before submission and keep formatting clean.");
  }
  if (!tips.length) {
    tips.push("Good result. Do a final proofreading pass for clarity, citations, and originality.");
  }
  return tips;
}

// ─── Paragraph segmentation ───────────────────────────────────────────────────

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 40);
}

// ─── Role-based source masking ────────────────────────────────────────────────

function maybeMaskSources(
  sources: SourceMatch[],
  role?: Role,
  orgConfig?: OrgConfig,
): SourceMatch[] {
  if (!role || role !== "student") return sources;
  if (orgConfig?.student_source_reveal) return sources;
  return sources.map((s) => ({ ...s, title: "[Source hidden]", url: "#" }));
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export interface ReportOptions {
  jobId: string;
  fileName: string;
  text: string;
  corpus: CorpusDoc[];
  processingMs: number;
  role?: Role;
  orgConfig?: OrgConfig;
  scanVersion?: number;
  parentJobId?: string;
  docxMeta?: DocxMeta;
  externalAiProbability?: number;
  externalAiLabel?: string;
}

function fuseDocumentAi(heuristicProbability: number, externalAiProbability?: number): number {
  if (externalAiProbability == null) return heuristicProbability;
  const blended = 0.35 * heuristicProbability + 0.65 * externalAiProbability;
  return Number(Math.max(0, Math.min(1, blended)).toFixed(4));
}

export async function generateReport(input: ReportOptions): Promise<Report> {
  const isCode = isCodeFile(input.fileName);

  // ── Step 1: Obfuscation normalisation ──────────────────────────────────────
  const { normalised, flags: obfuscationFlags } = normaliseAndDetect(input.text);
  const textToScan = normalised;

  // ── Code path ──────────────────────────────────────────────────────────────
  if (isCode) {
    const codeResult = scoreCodeSimilarity(textToScan, input.corpus);
    const aiResult = scoreSentenceAI(textToScan.slice(0, 2000));
    const riskBand = getRiskBand(codeResult.score, aiResult.probability);

    const forensic: ForensicSummary = {
      obfuscation_flags: obfuscationFlags,
      docx_meta: input.docxMeta,
      high_similarity_sentence_count: codeResult.score >= 0.4 ? 1 : 0,
      high_ai_sentence_count: aiResult.probability >= 0.7 ? 1 : 0,
      plain_language_summary: buildPlainLanguageSummary(
        codeResult.score,
        aiResult.probability,
        codeResult.score >= 0.4 ? 1 : 0,
        aiResult.probability >= 0.7 ? 1 : 0,
        1,
      ),
      improvement_tips: buildImprovementTips(codeResult.score, aiResult.probability, 0, obfuscationFlags),
      citation_excluded_count: 0,
      detection_method_breakdown: { exact: 0, semantic: 0, shingle: 0, embedding: 0 },
      overall_risk_explanation: buildRiskExplanation(
        codeResult.score, aiResult.probability, obfuscationFlags, input.docxMeta, 0, 0, 1,
      ),
    };

    return {
      job_id: input.jobId,
      similarity_score: Number(codeResult.score.toFixed(4)),
      ai_probability: aiResult.probability,
      risk_band: riskBand,
      sentences: [{
        text: "(code file — shown as single block)",
        similarity_score: Number(codeResult.score.toFixed(4)),
        ai_probability: aiResult.probability,
        confidence_interval: aiResult.confidence,
        sources: maybeMaskSources(codeResult.sources, input.role, input.orgConfig),
        is_citation: false,
        detection_method: "exact",
      }],
      paragraphs: [],
      sources: maybeMaskSources(codeResult.sources, input.role, input.orgConfig),
      forensic,
      metadata: {
        file_name: input.fileName,
        word_count: tokenize(textToScan).length,
        language: "code",
        processing_time_ms: input.processingMs,
        model_versions_used: { plagiarism: "winnowing-ast-v2", ai_detection: "ensemble-v3" },
        citations_excluded: 0,
        is_code_file: true,
      },
      scan_version: input.scanVersion ?? 1,
      parent_job_id: input.parentJobId,
    };
  }

  // ── Prose path ─────────────────────────────────────────────────────────────

  // Step 2: Build corpus index (TF-IDF + Winnowing + shingle + embedding ready)
  const corpusIndex = await buildCorpusIndex(input.corpus);

  // Step 3: Sentence segmentation + citation detection
  const rawSentences = splitSentences(textToScan).slice(0, 4000);
  const { citationFlags, excludedCount } = filterCitations(rawSentences);

  // Step 4: Score each sentence
  const methodCounts = { exact: 0, semantic: 0, shingle: 0, embedding: 0 };

  const sentenceRows = await Promise.all(rawSentences.map(async (sentence, idx) => {
    const isCitation = citationFlags[idx];

    const plagiarism = isCitation
      ? { score: 0, sources: [] as SourceMatch[], method: "none" as const }
      : await scoreSentenceSimilarity(sentence, corpusIndex);

    const ai = scoreSentenceAI(sentence);

    if (!isCitation && plagiarism.method !== "none") {
      methodCounts[plagiarism.method as keyof typeof methodCounts]++;
    }

    return {
      text: sentence,
      similarity_score: isCitation ? 0 : Number(plagiarism.score.toFixed(4)),
      ai_probability: ai.probability,
      confidence_interval: ai.confidence,
      sources: maybeMaskSources(plagiarism.sources, input.role, input.orgConfig),
      is_citation: isCitation,
      detection_method: plagiarism.method,
    };
  }));

  // Step 5: Aggregate scores
  const scorable = sentenceRows.filter((r) => !r.is_citation);
  const similarityScore = scoreDocumentSimilarity(
    scorable.map((r) => r.text),
    scorable.map((r) => r.similarity_score),
  );
  const aiDoc = scoreDocumentAI(
    rawSentences,
    sentenceRows.map((r) => r.ai_probability),
  );
  const aiProbability = fuseDocumentAi(aiDoc.probability, input.externalAiProbability);

  // Step 6: Deduplicated top sources
  const dedup = new Map<string, SourceMatch>();
  for (const row of sentenceRows) {
    for (const src of row.sources) {
      const existing = dedup.get(src.url);
      if (!existing || existing.match_percentage < src.match_percentage) {
        dedup.set(src.url, src);
      }
    }
  }
  const allSources = [...dedup.values()].sort((a, b) => b.match_percentage - a.match_percentage);

  // Step 7: Paragraph-level aggregation
  const paragraphTexts = splitParagraphs(textToScan);
  const paragraphs: ParagraphReport[] = paragraphTexts.map((pText) => {
    const pSentences = splitSentences(pText);
    const pRows = pSentences
      .map((s) => sentenceRows.find((r) => r.text === s))
      .filter(Boolean) as (typeof sentenceRows)[number][];

    const avgSim = pRows.length
      ? mean(pRows.map((r) => r.similarity_score))
      : 0;
    const avgAI = pRows.length
      ? mean(pRows.map((r) => r.ai_probability))
      : 0;

    return {
      text: pText.slice(0, 200),
      sentence_count: pSentences.length,
      avg_similarity: Number(avgSim.toFixed(4)),
      avg_ai_probability: Number(avgAI.toFixed(4)),
      risk_band: getRiskBand(avgSim, avgAI),
    };
  });

  // Step 8: Forensic summary
  const highSimCount = sentenceRows.filter((r) => !r.is_citation && r.similarity_score >= 0.30).length;
  const highAICount = sentenceRows.filter((r) => r.ai_probability >= 0.65).length;

  const forensic: ForensicSummary = {
    obfuscation_flags: obfuscationFlags,
    docx_meta: input.docxMeta,
    high_similarity_sentence_count: highSimCount,
    high_ai_sentence_count: highAICount,
    plain_language_summary: buildPlainLanguageSummary(
      similarityScore,
      aiProbability,
      highSimCount,
      highAICount,
      rawSentences.length,
    ),
    improvement_tips: buildImprovementTips(
      similarityScore,
      aiProbability,
      excludedCount,
      obfuscationFlags,
    ),
    ai_band: aiDoc.band,
    ai_reasons: aiDoc.reasons,
    ai_signal_breakdown: aiDoc.signals,
    citation_excluded_count: excludedCount,
    detection_method_breakdown: methodCounts,
    overall_risk_explanation: buildRiskExplanation(
      similarityScore,
      aiProbability,
      obfuscationFlags,
      input.docxMeta,
      highSimCount,
      highAICount,
      rawSentences.length,
    ),
  };

  return {
    job_id: input.jobId,
    similarity_score: similarityScore,
    ai_probability: aiProbability,
    risk_band: getRiskBand(similarityScore, aiProbability),
    sentences: sentenceRows,
    paragraphs,
    sources: allSources,
    forensic,
    metadata: {
      file_name: input.fileName,
      word_count: tokenize(textToScan).length,
      language: inferLanguage(textToScan),
      processing_time_ms: input.processingMs,
      model_versions_used: {
        plagiarism: "winnowing+tfidf+shingle+minilm-v9",
        ai_detection: getAiEngineLabel(),
      },
      citations_excluded: excludedCount,
      is_code_file: false,
    },
    scan_version: input.scanVersion ?? 1,
    parent_job_id: input.parentJobId,
  };
}
