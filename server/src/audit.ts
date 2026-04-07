/**
 * Audit logging helpers (FR-043).
 * Thin wrappers around store.appendAudit for typed event creation.
 */

import { Request } from "express";
import { appendAudit } from "./store";
import { AuditEvent } from "./types";

type EventPayload = Omit<AuditEvent, "id" | "created_at">;

function ip(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown"
  );
}

export function auditSubmissionCreate(req: Request, jobId: string): void {
  const e: EventPayload = {
    event_type: "submission.create",
    job_id: jobId,
    org_id: req.auth.org_id,
    api_key_id: req.auth.api_key_id ?? undefined,
    role: req.auth.role,
    ip: ip(req),
  };
  appendAudit(e);
}

export function auditReportAccess(req: Request, jobId: string): void {
  appendAudit({
    event_type: "report.access",
    job_id: jobId,
    org_id: req.auth.org_id,
    api_key_id: req.auth.api_key_id ?? undefined,
    role: req.auth.role,
    ip: ip(req),
  });
}

export function auditSubmissionDelete(req: Request, jobId: string): void {
  appendAudit({
    event_type: "submission.delete",
    job_id: jobId,
    org_id: req.auth.org_id,
    api_key_id: req.auth.api_key_id ?? undefined,
    role: req.auth.role,
    ip: ip(req),
  });
}

export function auditCorpusUpload(req: Request, count: number): void {
  appendAudit({
    event_type: "corpus.upload",
    org_id: req.auth.org_id,
    api_key_id: req.auth.api_key_id ?? undefined,
    role: req.auth.role,
    ip: ip(req),
    details: { doc_count: count },
  });
}

export function auditKeyCreate(req: Request, keyId: string, label: string): void {
  appendAudit({
    event_type: "key.create",
    org_id: req.auth.org_id,
    api_key_id: req.auth.api_key_id ?? undefined,
    role: req.auth.role,
    ip: ip(req),
    details: { new_key_id: keyId, label },
  });
}

export function auditKeyRevoke(req: Request, keyId: string): void {
  appendAudit({
    event_type: "key.revoke",
    org_id: req.auth.org_id,
    api_key_id: req.auth.api_key_id ?? undefined,
    role: req.auth.role,
    ip: ip(req),
    details: { revoked_key_id: keyId },
  });
}

export function auditOrgCreate(req: Request, orgId: string): void {
  appendAudit({
    event_type: "org.create",
    org_id: orgId,
    api_key_id: req.auth.api_key_id ?? undefined,
    role: req.auth.role,
    ip: ip(req),
  });
}

export function auditOrgUpdate(req: Request, orgId: string): void {
  appendAudit({
    event_type: "org.update",
    org_id: orgId,
    api_key_id: req.auth.api_key_id ?? undefined,
    role: req.auth.role,
    ip: ip(req),
  });
}

export function auditBulkSubmit(req: Request, count: number): void {
  appendAudit({
    event_type: "bulk.submit",
    org_id: req.auth.org_id,
    api_key_id: req.auth.api_key_id ?? undefined,
    role: req.auth.role,
    ip: ip(req),
    details: { accepted: count },
  });
}
