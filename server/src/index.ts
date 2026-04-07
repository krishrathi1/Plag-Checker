import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import PDFDocument from "pdfkit";
import path from "path";
import { randomUUID } from "crypto";
import fs from "fs";
import { z } from "zod";
import {
  addCorpusDocs,
  appendAudit,
  createApiKey,
  createJob,
  createOrg,
  deleteJob,
  getAuditLog,
  getCorpusForOrg,
  getJob,
  getJobHistory,
  getOrg,
  listApiKeys,
  listJobsByOrg,
  listOrgs,
  revokeApiKey,
  updateJob,
  updateOrg,
} from "./store";
import { startQueueWorker } from "./queue";
import { authMiddleware, requireRole } from "./auth";
import {
  auditBulkSubmit,
  auditCorpusUpload,
  auditKeyCreate,
  auditKeyRevoke,
  auditOrgCreate,
  auditOrgUpdate,
  auditReportAccess,
  auditSubmissionCreate,
  auditSubmissionDelete,
} from "./audit";
import { CorpusDoc, SubmissionJob } from "./types";

export const app = express();
const port = Number(process.env.PORT ?? 8080);
const uploadDir = path.join(process.cwd(), "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

function sanitizeFilename(name: string): string {
  const base = path.basename(name);
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normaliseDetectedExtension(magicExt: string, originalExt: string): string {
  if (magicExt === "zip" && (originalExt === "docx" || originalExt === "pptx")) {
    return originalExt;
  }
  if (magicExt === "plain") return "txt";
  return magicExt;
}

function detectMagicExtension(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(16);
    fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);

    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      return "pdf";
    }
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
      return "zip";
    }
    const isTextLike = [...buffer].every((b) => b === 0 || b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126));
    if (isTextLike) return "plain";
    return null;
  } catch {
    return null;
  }
}

// â”€â”€â”€ Middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS origin not allowed"));
    },
  }),
);
app.use(express.json({ limit: "20mb" }));

// Global rate limit: 300 req/min per IP
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down." },
  }),
);

// Strict rate limit on submission endpoints: 60 uploads/min per IP
const uploadLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: { error: "Upload rate limit exceeded." },
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const safe = sanitizeFilename(file.originalname);
      cb(null, `${Date.now()}-${randomUUID()}-${safe}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const identityBuckets = new Map<string, { count: number; resetAt: number }>();
function identityRateLimit(maxPerMinute: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const key = req.auth?.api_key_id
      ? `${req.auth.org_id}:${req.auth.api_key_id}`
      : `${req.auth?.org_id ?? "anon"}:${req.ip}`;
    const now = Date.now();
    const entry = identityBuckets.get(key);
    if (!entry || now > entry.resetAt) {
      identityBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    if (entry.count >= maxPerMinute) {
      res.status(429).json({ error: "Per-organisation rate limit exceeded." });
      return;
    }
    entry.count += 1;
    next();
  };
}

// Apply auth to all routes except /v1/health and /v1/auth/keys (bootstrap)
app.use((req, res, next) => {
  if (req.path === "/v1/health" || (req.path === "/v1/auth/keys" && req.method === "POST")) {
    return next();
  }
  return authMiddleware(req, res, next);
});

app.use(identityRateLimit(Number(process.env.ORG_RATE_LIMIT_PER_MINUTE ?? 180)));

// â”€â”€â”€ Health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get("/v1/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), service: "vericheck-ai" });
});

// â”€â”€â”€ Auth / API Keys â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const createKeySchema = z.object({
  org_id: z.string().min(1),
  role: z.enum(["super_admin", "org_admin", "instructor", "student"]),
  label: z.string().min(1).max(80),
  // Master key for bootstrap (optional; set MASTER_KEY env var)
  master_key: z.string().optional(),
});

app.post("/v1/auth/keys", (req, res) => {
  const parsed = createKeySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { org_id, role, label, master_key } = parsed.data;

  // Only allow creating super_admin/org_admin keys if a valid master key is supplied
  const MASTER = process.env.MASTER_KEY;
  if ((role === "super_admin" || role === "org_admin") && MASTER && master_key !== MASTER) {
    return res.status(403).json({ error: "master_key required to create admin keys." });
  }

  // Ensure org exists (auto-create if not)
  if (!getOrg(org_id)) createOrg(org_id, org_id);

  const { key, rawKey } = createApiKey(org_id, role, label);
  return res.status(201).json({
    id: key.id,
    key: rawKey, // shown ONCE
    prefix: key.key_prefix,
    org_id: key.org_id,
    role: key.role,
    label: key.label,
    created_at: key.created_at,
  });
});

app.get("/v1/auth/keys", requireRole("super_admin", "org_admin"), (req, res) => {
  res.json(listApiKeys(req.auth.org_id));
});

app.delete("/v1/auth/keys/:id", requireRole("super_admin", "org_admin"), (req, res) => {
  const keyId = String(req.params.id);
  const ok = revokeApiKey(keyId, req.auth.org_id);
  if (!ok) return res.status(404).json({ error: "Key not found." });
  auditKeyRevoke(req, keyId);
  return res.status(204).send();
});

// â”€â”€â”€ Organisations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post("/v1/orgs", requireRole("super_admin"), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const org = createOrg(String(name));
  auditOrgCreate(req, org.id);
  return res.status(201).json(org);
});

app.get("/v1/orgs", requireRole("super_admin"), (_req, res) => {
  res.json(listOrgs());
});

app.get("/v1/organisations/:orgId/config", (req, res) => {
  const org = getOrg(req.params.orgId);
  if (!org) return res.status(404).json({ error: "org not found" });
  return res.json(org);
});

app.put(
  "/v1/organisations/:orgId/config",
  requireRole("super_admin", "org_admin"),
  (req, res) => {
    const { student_source_reveal, allowed_file_types, student_self_check_quota, name } = req.body;
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = String(name);
    if (student_source_reveal !== undefined) patch.student_source_reveal = Boolean(student_source_reveal);
    if (allowed_file_types !== undefined && Array.isArray(allowed_file_types))
      patch.allowed_file_types = allowed_file_types;
    if (student_self_check_quota !== undefined)
      patch.student_self_check_quota = Number(student_self_check_quota);

    const updated = updateOrg(String(req.params.orgId), patch);
    if (!updated) return res.status(404).json({ error: "org not found" });
    auditOrgUpdate(req, String(req.params.orgId));
    return res.json(updated);
  },
);

// â”€â”€â”€ LTI 1.3 Integration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get("/v1/lti/login", (req, res) => {
  const { iss, login_hint, target_link_uri, lti_message_hint, client_id, lti_deployment_id } = req.query;
  if (!iss || !login_hint || !target_link_uri) {
    return res.status(400).send("Missing required LTI 1.3 OIDC parameters");
  }
  const state = randomUUID();
  const nonce = randomUUID();
  // Note: in a production setting you should persist the state/nonce to validate the callback.
  const redirectUri = encodeURIComponent(`${req.protocol}://${req.get("host")}/v1/lti/launch`);
  const authUrl = `${iss}/authorize?response_type=id_token&response_mode=form_post&client_id=${client_id}&redirect_uri=${redirectUri}&login_hint=${login_hint}&state=${state}&nonce=${nonce}&prompt=none`;
  res.redirect(authUrl);
});

app.post("/v1/lti/launch", express.urlencoded({ extended: true }), (req, res) => {
  const { id_token, state } = req.body;
  if (!id_token) return res.status(400).send("Missing id_token from LMS");
  
  // Here we would verify the id_token signature via the LMS's JWKS endpoint
  // and check the state to prevent CSRF.
  
  console.log(`[LTI] Launch received for state: ${state}`);
  // Redirect to the frontend application within the iframe
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  res.redirect(`${frontendUrl}/?ltilaunch=success`);
});

app.get("/v1/lti/jwks", (req, res) => {
  res.json({ keys: [] }); // Stub for public keys if deep-linking or grade passback is needed
});

// â”€â”€â”€ Writing Assist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const humanizeSchema = z.object({
  text: z.string().min(5).max(4000),
});

function humanizeForReadability(input: string): string {
  let text = input.trim();
  text = text
    .replace(/\b(Furthermore|Moreover|Additionally)\b/gi, "Also")
    .replace(/\b(Therefore|Thus|Hence)\b/gi, "So")
    .replace(/\b(utilize|utilizing)\b/gi, "use")
    .replace(/\b(in order to)\b/gi, "to")
    .replace(/\b(it is important to note that)\b/gi, "Note that")
    .replace(/\s{2,}/g, " ");

  // Break very long sentences for readability.
  if (text.length > 220) {
    text = text.replace(/,\s+(which|that|because|while|although)\s+/gi, ". $1 ");
  }

  // Keep first character uppercase.
  if (text.length > 1) {
    text = text[0].toUpperCase() + text.slice(1);
  }
  return text;
}

app.post("/v1/writing-assist/humanize", (req, res) => {
  const parsed = humanizeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const output = humanizeForReadability(parsed.data.text);
  return res.json({
    original: parsed.data.text,
    rewritten: output,
    mode: "readability",
  });
});

// â”€â”€â”€ Submissions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post("/v1/submissions", uploadLimiter, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required" });

  const orgId = req.auth.org_id;
  const orgConfig = getOrg(orgId);

  // Check allowed file types for org
  const ext = req.file.originalname.split(".").pop()?.toLowerCase() ?? "";
  if (orgConfig && !orgConfig.allowed_file_types.includes(ext)) {
    return res.status(415).json({ error: `File type .${ext} not allowed for this organisation.` });
  }
  // Magic-byte validation (best effort)
  const detected = detectMagicExtension(req.file.path);
  if (detected) {
    const extFromMagic = normaliseDetectedExtension(detected, ext);
    if (orgConfig && !orgConfig.allowed_file_types.includes(extFromMagic)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      return res.status(415).json({ error: `File content type .${extFromMagic} not allowed.` });
    }
  }

  // Student quota check
  if (req.auth.role === "student" && orgConfig) {
    const studentJobs = listJobsByOrg(orgId).filter(
      (j) => j.submitted_by === req.auth.api_key_id,
    );
    if (studentJobs.length >= orgConfig.student_self_check_quota) {
      return res.status(429).json({
        error: `Student self-check quota of ${orgConfig.student_self_check_quota} exceeded.`,
      });
    }
  }

  const jobId = randomUUID();
  const now = new Date().toISOString();
  const job: SubmissionJob = {
    job_id: jobId,
    org_id: orgId,
    created_at: now,
    updated_at: now,
    file_name: req.file.originalname,
    file_path: req.file.path,
    status: "queued",
    webhook_url: req.body.webhook_url ? String(req.body.webhook_url) : undefined,
    submitter_email: req.body.submitter_email ? String(req.body.submitter_email) : undefined,
    submitted_by: req.auth.api_key_id ?? undefined,
    role: req.auth.role,
  };

  createJob(job);
  auditSubmissionCreate(req, jobId);

  return res.status(202).json({
    job_id: jobId,
    status: "queued",
    message: "Submission accepted and queued for analysis.",
  });
});

app.get("/v1/submissions", (req, res) => {
  const jobs = listJobsByOrg(req.auth.org_id).map((j) => ({
    job_id: j.job_id,
    status: j.status,
    file_name: j.file_name,
    created_at: j.created_at,
    updated_at: j.updated_at,
    scan_version: j.scan_version ?? 1,
    risk_band: j.report?.risk_band,
  }));
  res.json(jobs);
});

app.get("/v1/submissions/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job || job.org_id !== req.auth.org_id) return res.status(404).json({ error: "job not found" });
  return res.json({
    job_id: job.job_id,
    status: job.status,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
    scan_version: job.scan_version ?? 1,
    parent_job_id: job.parent_job_id,
  });
});

app.get("/v1/submissions/:jobId/history", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job || job.org_id !== req.auth.org_id) return res.status(404).json({ error: "job not found" });
  const history = getJobHistory(req.params.jobId).map((j) => ({
    job_id: j.job_id,
    scan_version: j.scan_version ?? 1,
    status: j.status,
    created_at: j.created_at,
    similarity_score: j.report?.similarity_score,
    ai_probability: j.report?.ai_probability,
    risk_band: j.report?.risk_band,
  }));
  return res.json(history);
});

app.get("/v1/submissions/:jobId/report", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job || job.org_id !== req.auth.org_id) return res.status(404).json({ error: "job not found" });
  if (job.status !== "complete" || !job.report) return res.status(409).json({ error: "report not ready" });

  auditReportAccess(req, req.params.jobId);
  return res.json(job.report);
});

app.get("/v1/submissions/:jobId/report/pdf", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job || job.org_id !== req.auth.org_id) return res.status(404).json({ error: "job not found" });
  if (job.status !== "complete" || !job.report) return res.status(409).json({ error: "report not ready" });

  auditReportAccess(req, req.params.jobId);

  const doc = new PDFDocument({ margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=report-${job.job_id}.pdf`);
  doc.pipe(res);

  doc.fontSize(20).text("VeriCheck AI â€” Integrity Report", { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(11).fillColor("#555").text(`Generated: ${new Date().toUTCString()}`);
  doc.moveDown();

  doc.fontSize(13).fillColor("#000").text("Summary");
  doc.fontSize(11)
    .text(`Job ID         : ${job.report.job_id}`)
    .text(`File           : ${job.report.metadata.file_name}`)
    .text(`Scan Version   : ${job.report.scan_version ?? 1}`)
    .text(`Word Count     : ${job.report.metadata.word_count}`)
    .text(`Language       : ${job.report.metadata.language}`)
    .text(`Processing     : ${job.report.metadata.processing_time_ms} ms`)
    .text(`Citations Excl.: ${job.report.metadata.citations_excluded}`);

  doc.moveDown();
  doc.fontSize(13).text("Scores");
  const sim = (job.report.similarity_score * 100).toFixed(2);
  const ai = (job.report.ai_probability * 100).toFixed(2);
  doc.fontSize(11)
    .text(`Similarity Score : ${sim}%`)
    .text(`AI Probability   : ${ai}%`)
    .text(`Risk Band        : ${job.report.risk_band}`);

  doc.moveDown();
  doc.fontSize(13).text("Top Source Matches");
  job.report.sources.slice(0, 15).forEach((src, i) => {
    doc.fontSize(10).text(
      `${i + 1}. ${src.title} | ${src.match_percentage.toFixed(2)}% | ${src.url}`,
      { lineGap: 2 },
    );
  });

  doc.moveDown();
  doc.fontSize(13).text("Sentence Analysis (first 50 sentences)");
  job.report.sentences.slice(0, 50).forEach((s, i) => {
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor(s.is_citation ? "#888" : "#000")
      .text(`[${i + 1}] ${s.text.slice(0, 200)}`, { lineGap: 1 });
    doc.fontSize(8).fillColor("#444")
      .text(
        `   Similarity: ${(s.similarity_score * 100).toFixed(1)}%  |  AI: ${(s.ai_probability * 100).toFixed(1)}%  |  Citation: ${s.is_citation}`,
      );
  });

  doc.end();
});

// â”€â”€â”€ Bulk submissions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post("/v1/submissions/bulk", uploadLimiter, upload.single("manifest"), (req, res) => {
  const orgId = req.auth.org_id;
  const accepted: string[] = [];

  const enqueue = (filename: string, text: string) => {
    const tempPath = path.join(uploadDir, `${Date.now()}-${randomUUID()}-${filename}.txt`);
    fs.writeFileSync(tempPath, text, "utf-8");
    const id = randomUUID();
    const now = new Date().toISOString();
    createJob({
      job_id: id,
      org_id: orgId,
      created_at: now,
      updated_at: now,
      file_name: filename,
      file_path: tempPath,
      status: "queued",
      role: req.auth.role,
      submitted_by: req.auth.api_key_id ?? undefined,
    });
    accepted.push(id);
  };

  if (Array.isArray(req.body.documents)) {
    for (const row of req.body.documents.slice(0, 10000)) {
      if (!row?.text || !row?.filename) continue;
      enqueue(String(row.filename), String(row.text));
    }
  } else if (req.file) {
    const csv = fs.readFileSync(req.file.path, "utf-8");
    const lines = csv.split(/\r?\n/).filter(Boolean).slice(1, 10001);
    for (const line of lines) {
      const [filename, ...rest] = line.split(",");
      const text = rest.join(",");
      if (!filename || !text) continue;
      enqueue(filename.trim(), text.trim());
    }
  } else {
    return res.status(400).json({ error: "Provide documents[] JSON or manifest CSV file." });
  }

  auditBulkSubmit(req, accepted.length);
  return res.status(202).json({ accepted_count: accepted.length, job_ids: accepted });
});

// â”€â”€â”€ Organisation stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get("/v1/organisations/:orgId/stats", (req, res) => {
  if (req.params.orgId !== req.auth.org_id && req.auth.role !== "super_admin") {
    return res.status(403).json({ error: "Cannot access another org's stats." });
  }
  const jobs = listJobsByOrg(req.params.orgId);
  const complete = jobs.filter((j) => j.status === "complete" && j.report);

  const avg = (fn: (j: SubmissionJob) => number) =>
    complete.length === 0
      ? 0
      : Number((complete.reduce((s, j) => s + fn(j), 0) / complete.length).toFixed(4));

  return res.json({
    org_id: req.params.orgId,
    total_submissions: jobs.length,
    queued: jobs.filter((j) => j.status === "queued").length,
    processing: jobs.filter((j) => j.status === "processing").length,
    complete: complete.length,
    failed: jobs.filter((j) => j.status === "failed").length,
    avg_similarity_score: avg((j) => j.report?.similarity_score ?? 0),
    avg_ai_probability: avg((j) => j.report?.ai_probability ?? 0),
  });
});

// â”€â”€â”€ Corpus â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const corpusSchema = z.object({
  org_id: z.string().min(1),
  documents: z.array(
    z.object({
      title: z.string().min(1),
      url: z.string().url(),
      content: z.string().min(1),
    }),
  ),
});

app.post("/v1/corpus", requireRole("super_admin", "org_admin", "instructor"), (req, res) => {
  const parsed = corpusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const docs: CorpusDoc[] = parsed.data.documents.map((d) => ({
    ...d,
    id: randomUUID(),
    org_id: parsed.data.org_id,
    created_at: new Date().toISOString(),
  }));

  addCorpusDocs(docs);
  auditCorpusUpload(req, docs.length);
  return res.status(201).json({ added: docs.length });
});

app.get("/v1/corpus", requireRole("super_admin", "org_admin", "instructor"), (req, res) => {
  const corpus = getCorpusForOrg(req.auth.org_id).map(({ content: _c, ...rest }) => rest);
  return res.json(corpus);
});

// â”€â”€â”€ Submission delete â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.delete("/v1/submissions/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job || job.org_id !== req.auth.org_id) return res.status(404).json({ error: "job not found" });

  auditSubmissionDelete(req, req.params.jobId);
  deleteJob(req.params.jobId);
  try { fs.unlinkSync(job.file_path); } catch { /* already gone */ }

  return res.status(204).send();
});

// â”€â”€â”€ Audit log â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get(
  "/v1/organisations/:orgId/audit",
  requireRole("super_admin", "org_admin"),
  (req, res) => {
    if (req.params.orgId !== req.auth.org_id && req.auth.role !== "super_admin") {
      return res.status(403).json({ error: "Cannot access another org's audit log." });
    }
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    return res.json(getAuditLog(String(req.params.orgId), limit));
  },
);

// â”€â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

if (require.main === module) {
  startQueueWorker();
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`VeriCheck AI API running on http://localhost:${port}`);
    console.log(`Auth: REQUIRE_AUTH=${process.env.REQUIRE_AUTH ?? "false"}`);
  });
}
