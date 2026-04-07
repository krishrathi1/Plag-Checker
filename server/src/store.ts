import { randomUUID } from "crypto";
import { db } from "./db";
import { ApiKey, AuditEvent, CorpusDoc, OrgConfig, Role, SubmissionJob } from "./types";
import { createHash } from "crypto";

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export function createJob(job: SubmissionJob): SubmissionJob {
  const finalJob = {
    retry_count: 0,
    max_retries: 3,
    ...job,
  };
  db.prepare('INSERT INTO jobs (job_id, org_id, parent_job_id, status, json) VALUES (?, ?, ?, ?, ?)').run(
    finalJob.job_id,
    finalJob.org_id,
    finalJob.parent_job_id || null,
    finalJob.status,
    JSON.stringify(finalJob)
  );
  return finalJob;
}

export function updateJob(jobId: string, patch: Partial<SubmissionJob>): SubmissionJob | undefined {
  const row = db.prepare('SELECT json FROM jobs WHERE job_id = ?').get(jobId) as { json: string } | undefined;
  if (!row) return undefined;
  const existing = JSON.parse(row.json) as SubmissionJob;
  const updated: SubmissionJob = { ...existing, ...patch, updated_at: new Date().toISOString() };
  
  db.prepare('UPDATE jobs SET status = ?, json = ? WHERE job_id = ?').run(
    updated.status,
    JSON.stringify(updated),
    jobId
  );
  return updated;
}

export function getJob(jobId: string): SubmissionJob | undefined {
  const row = db.prepare('SELECT json FROM jobs WHERE job_id = ?').get(jobId) as { json: string } | undefined;
  return row ? JSON.parse(row.json) : undefined;
}

export function deleteJob(jobId: string): boolean {
  const info = db.prepare('DELETE FROM jobs WHERE job_id = ?').run(jobId);
  return info.changes > 0;
}

export function listJobsByOrg(orgId: string): SubmissionJob[] {
  const rows = db.prepare('SELECT json FROM jobs WHERE org_id = ?').all(orgId) as { json: string }[];
  return rows.map(r => JSON.parse(r.json));
}

export function listQueuedJobs(): SubmissionJob[] {
  const now = Date.now();
  const rows = db.prepare('SELECT json FROM jobs WHERE status = ?').all("queued") as { json: string }[];
  return rows.map(r => JSON.parse(r.json)).filter(j => {
    if (!j.next_retry_at) return true;
    return new Date(j.next_retry_at).getTime() <= now;
  });
}

export function getJobHistory(jobId: string): SubmissionJob[] {
  const root = getJob(jobId);
  if (!root) return [];

  const chain: SubmissionJob[] = [root];
  // Walk parent chain backward
  let current = root;
  while (current.parent_job_id) {
    const parent = getJob(current.parent_job_id);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }
  
  // Walk forward
  let childId = jobId;
  for (;;) {
    const row = db.prepare('SELECT json FROM jobs WHERE parent_job_id = ? AND job_id != ?').get(childId, jobId) as { json: string } | undefined;
    if (!row) break;
    const child = JSON.parse(row.json) as SubmissionJob;
    chain.push(child);
    childId = child.job_id;
  }
  return chain;
}

// ─── Corpus ───────────────────────────────────────────────────────────────────

export function addCorpusDocs(docs: CorpusDoc[]): CorpusDoc[] {
  const insert = db.prepare('INSERT INTO corpus (id, org_id, json) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const doc of docs) {
      insert.run(doc.id, doc.org_id, JSON.stringify(doc));
    }
  })();
  return docs;
}

export function getCorpusForOrg(orgId: string): CorpusDoc[] {
  const rows = db.prepare('SELECT json FROM corpus WHERE org_id = ? OR org_id = ?').all(orgId, "global") as { json: string }[];
  return rows.map(r => JSON.parse(r.json));
}

// ─── API Keys ─────────────────────────────────────────────────────────────────

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function createApiKey(orgId: string, role: Role, label: string): { key: ApiKey; rawKey: string } {
  const raw = `vk_${randomUUID().replace(/-/g, "")}`;
  const key: ApiKey = {
    id: randomUUID(),
    key_hash: hashKey(raw),
    key_prefix: raw.slice(0, 12),
    org_id: orgId,
    role,
    label,
    created_at: new Date().toISOString(),
    active: true,
  };
  db.prepare('INSERT INTO api_keys (id, key_hash, org_id, active, json) VALUES (?, ?, ?, ?, ?)').run(
    key.id, key.key_hash, key.org_id, 1, JSON.stringify(key)
  );
  return { key, rawKey: raw };
}

export function resolveApiKey(raw: string): ApiKey | undefined {
  const hash = hashKey(raw);
  const row = db.prepare('SELECT id, json FROM api_keys WHERE key_hash = ? AND active = 1').get(hash) as { id: string, json: string } | undefined;
  if (!row) return undefined;
  const key = JSON.parse(row.json) as ApiKey;
  key.last_used_at = new Date().toISOString();
  db.prepare('UPDATE api_keys SET json = ? WHERE id = ?').run(JSON.stringify(key), row.id);
  return key;
}

export function listApiKeys(orgId: string): Omit<ApiKey, "key_hash">[] {
  const rows = db.prepare('SELECT json FROM api_keys WHERE org_id = ?').all(orgId) as { json: string }[];
  return rows.map(r => {
    const { key_hash: _kh, ...rest } = JSON.parse(r.json);
    return rest;
  });
}

export function revokeApiKey(id: string, orgId: string): boolean {
  const row = db.prepare('SELECT json FROM api_keys WHERE id = ? AND org_id = ?').get(id, orgId) as { json: string } | undefined;
  if (!row) return false;
  const key = JSON.parse(row.json) as ApiKey;
  key.active = false;
  db.prepare('UPDATE api_keys SET active = 0, json = ? WHERE id = ?').run(JSON.stringify(key), id);
  return true;
}

// ─── Organisations ────────────────────────────────────────────────────────────

export function createOrg(name: string, id?: string): OrgConfig {
  const org: OrgConfig = {
    id: id ?? randomUUID(),
    name,
    student_source_reveal: false,
    allowed_file_types: ["pdf", "docx", "txt", "md", "csv", "tex", "pptx"],
    student_self_check_quota: 5,
    created_at: new Date().toISOString(),
  };
  db.prepare('INSERT INTO orgs (id, json) VALUES (?, ?)').run(org.id, JSON.stringify(org));
  return org;
}

export function getOrg(id: string): OrgConfig | undefined {
  const row = db.prepare('SELECT json FROM orgs WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? JSON.parse(row.json) : undefined;
}

export function updateOrg(id: string, patch: Partial<OrgConfig>): OrgConfig | undefined {
  const row = db.prepare('SELECT json FROM orgs WHERE id = ?').get(id) as { json: string } | undefined;
  if (!row) return undefined;
  const org = JSON.parse(row.json) as OrgConfig;
  Object.assign(org, patch);
  db.prepare('UPDATE orgs SET json = ? WHERE id = ?').run(JSON.stringify(org), id);
  return org;
}

export function listOrgs(): OrgConfig[] {
  const rows = db.prepare('SELECT json FROM orgs').all() as { json: string }[];
  return rows.map(r => JSON.parse(r.json));
}

// ─── Audit log ────────────────────────────────────────────────────────────────

export function appendAudit(event: Omit<AuditEvent, "id" | "created_at">): void {
  const e: AuditEvent = { ...event, id: randomUUID(), created_at: new Date().toISOString() };
  db.prepare('INSERT INTO audit_log (id, org_id, json) VALUES (?, ?, ?)').run(e.id, e.org_id, JSON.stringify(e));
  
  db.exec("DELETE FROM audit_log WHERE rowid NOT IN (SELECT rowid FROM audit_log ORDER BY rowid DESC LIMIT 10000)");
}

export function getAuditLog(orgId: string, limit = 500): AuditEvent[] {
  const rows = db.prepare('SELECT json FROM audit_log WHERE org_id = ? ORDER BY rowid DESC LIMIT ?').all(orgId, limit) as { json: string }[];
  return rows.map(r => JSON.parse(r.json));
}
