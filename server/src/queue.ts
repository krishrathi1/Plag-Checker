/**
 * Async job queue worker — v3
 *
 * Additions:
 *  - DOCX metadata extraction fed into report
 *  - Obfuscation normalisation happens inside report engine
 *  - Webhook + email notifications
 *  - Report versioning
 */

import fs from "fs/promises";
import { createHmac } from "crypto";
import mammoth from "mammoth";
import nodemailer from "nodemailer";
import pdfParse from "pdf-parse";
import { generateReport } from "./engine/report";
import { CorpusDoc, SubmissionJob } from "./types";
import {
  getCorpusForOrg,
  getJob,
  getOrg,
  listJobsByOrg,
  listQueuedJobs,
  updateJob,
} from "./store";
import { extractDocxMeta } from "./utils/docx-meta";
import { extractLatexText, extractPptxText } from "./utils/extract";
import { buildLiveWebCorpus } from "./research/live-web-corpus";
import { scoreExternalAIDetector } from "./research/ai-provider";

// ─── Document text extraction ─────────────────────────────────────────────────

async function readDocumentText(
  filePath: string,
  fileName: string,
): Promise<{ text: string; rawBuffer?: Buffer }> {
  const buffer = await fs.readFile(filePath);
  const ext = fileName.toLowerCase().split(".").pop() ?? "";

  if (ext === "txt" || ext === "md" || ext === "csv") {
    return { text: buffer.toString("utf-8") };
  }
  if (ext === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, rawBuffer: buffer };
  }
  if (ext === "pdf") {
    const result = await pdfParse(buffer);
    return { text: result.text };
  }
  if (ext === "pptx") {
    return { text: extractPptxText(buffer) };
  }
  if (ext === "tex") {
    return { text: extractLatexText(buffer.toString("utf-8")) };
  }
  return { text: buffer.toString("utf-8") };
}

// ─── Webhook firing ───────────────────────────────────────────────────────────

async function fireWebhook(url: string, payload: unknown): Promise<void> {
  const secret = process.env.WEBHOOK_SIGNING_SECRET;
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();
  const signature = secret
    ? createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
    : null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "VeriCheck-AI/3.0",
          ...(signature
            ? {
                "X-VeriCheck-Timestamp": timestamp,
                "X-VeriCheck-Signature": signature,
              }
            : {}),
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return;
    } catch { /* non-fatal */ }
  }
}

// ─── Email notification ───────────────────────────────────────────────────────

let _transport: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransport() {
  if (_transport) return _transport;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST) return null;
  _transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT ?? 587),
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS ?? "" } : undefined,
  });
  return _transport;
}

async function sendCompletionEmail(email: string, job: ReturnType<typeof getJob>): Promise<void> {
  const transport = getTransport();
  if (!transport || !job?.report) return;
  const r = job.report;
  const flags = r.forensic.obfuscation_flags.length
    ? `\nObfuscation Flags : ${r.forensic.obfuscation_flags.map((f) => f.type).join(", ")}`
    : "";
  const docxWarn = r.forensic.docx_meta?.suspicionFlags.length
    ? `\nDocument Forensics: ${r.forensic.docx_meta.suspicionFlags.map((f) => f.message).join("; ")}`
    : "";
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? "noreply@vericheck.ai",
      to: email,
      subject: `VeriCheck AI — Scan complete: ${job.file_name}`,
      text: [
        `Your document "${job.file_name}" has been scanned.`,
        ``,
        `Similarity Score : ${(r.similarity_score * 100).toFixed(2)}%`,
        `AI Probability   : ${(r.ai_probability * 100).toFixed(2)}%`,
        `Risk Band        : ${r.risk_band}`,
        `Word Count       : ${r.metadata.word_count}`,
        `Scan Version     : ${r.scan_version}`,
        flags,
        docxWarn,
        ``,
        r.forensic.overall_risk_explanation,
        ``,
        `Job ID: ${job.job_id}`,
      ]
        .filter((l) => l !== undefined)
        .join("\n"),
    });
  } catch { /* non-fatal */ }
}

function buildCrossSubmissionCorpus(
  jobs: SubmissionJob[],
  currentJobId: string,
  orgId: string,
): CorpusDoc[] {
  const maxDocs = Number(process.env.CROSS_SUBMISSION_DOC_LIMIT ?? 250);
  const completed = jobs
    .filter((j) => j.status === "complete" && j.job_id !== currentJobId && j.report)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, maxDocs);

  return completed.map((job) => {
    const sentenceText = (job.report?.sentences ?? [])
      .filter((s) => !s.is_citation)
      .map((s) => s.text)
      .join(" ");
    return {
      id: `submission-${job.job_id}`,
      org_id: orgId,
      title: `Institution submission: ${job.file_name}`,
      url: `submission://${job.job_id}`,
      content: sentenceText || job.file_name,
      created_at: job.created_at,
    } satisfies CorpusDoc;
  });
}

// ─── Worker ───────────────────────────────────────────────────────────────────

async function processOneQueuedJob(): Promise<void> {
  const next = listQueuedJobs()[0];
  if (!next) return;

  updateJob(next.job_id, { status: "processing" });
  const startedAt = Date.now();

  try {
    const { text, rawBuffer } = await readDocumentText(next.file_path, next.file_name);
    const trimmedText = text.trim();
    if (!trimmedText) {
      throw new Error("Unable to extract text from the uploaded document.");
    }

    const words = trimmedText.split(/\s+/).length;
    if (words > 50000) {
      throw new Error("Document exceeds 50,000 word limit.");
    }

    // Extract DOCX metadata if applicable
    const ext = next.file_name.toLowerCase().split(".").pop() ?? "";
    const docxMeta = ext === "docx" && rawBuffer ? extractDocxMeta(rawBuffer) : undefined;

    // Determine scan version
    const orgJobs = listJobsByOrg(next.org_id);
    const siblings = orgJobs.filter(
      (j) =>
        j.job_id !== next.job_id &&
        j.file_name === next.file_name &&
        j.status === "complete",
    );
    const parentJob = siblings.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const scanVersion = parentJob ? (parentJob.scan_version ?? 1) + 1 : 1;

    const orgConfig = getOrg(next.org_id);
    const localCorpus = getCorpusForOrg(next.org_id);
    const crossSubmissionCorpus = buildCrossSubmissionCorpus(orgJobs, next.job_id, next.org_id);
    const liveCorpus = await buildLiveWebCorpus(trimmedText, next.org_id);
    const mergedCorpus = [...localCorpus, ...crossSubmissionCorpus, ...liveCorpus];

    // External AI detector (optional — set AI_DETECTOR_URL to enable)
    const externalAI = await scoreExternalAIDetector(trimmedText);

    const report = await generateReport({
      jobId: next.job_id,
      fileName: next.file_name,
      text: trimmedText,
      corpus: mergedCorpus,
      processingMs: Date.now() - startedAt,
      role: next.role,
      orgConfig,
      scanVersion,
      parentJobId: parentJob?.job_id,
      docxMeta,
      externalAiProbability: externalAI?.probability,
    });

    const updated = updateJob(next.job_id, {
      status: "complete",
      report,
      scan_version: scanVersion,
      parent_job_id: parentJob?.job_id,
    });

    if (next.webhook_url && updated) {
      void fireWebhook(next.webhook_url, {
        event: "scan.complete",
        job_id: next.job_id,
        status: "complete",
        similarity_score: report.similarity_score,
        ai_probability: report.ai_probability,
        risk_band: report.risk_band,
        obfuscation_detected: report.forensic.obfuscation_flags.length > 0,
        docx_suspicion_flags: report.forensic.docx_meta?.suspicionFlags.length ?? 0,
      });
    }

    if (next.submitter_email && updated) {
      void sendCompletionEmail(next.submitter_email, updated);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown processing error";
    updateJob(next.job_id, { status: "failed", error: errMsg });
    if (next.webhook_url) {
      void fireWebhook(next.webhook_url, {
        event: "scan.failed",
        job_id: next.job_id,
        status: "failed",
        error: errMsg,
      });
    }
  }
}

export function startQueueWorker(): void {
  setInterval(() => {
    void processOneQueuedJob();
  }, 800);
}