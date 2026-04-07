import type { DocxMeta } from "./utils/docx-meta";
import type { ObfuscationFlag } from "./utils/obfuscation";

export type JobStatus = "queued" | "processing" | "complete" | "failed";
export type Role = "super_admin" | "org_admin" | "instructor" | "student";

export interface SourceMatch {
  title: string;
  url: string;
  match_percentage: number;
  access_date: string;
}

export interface SentenceReport {
  text: string;
  similarity_score: number;
  ai_probability: number;
  confidence_interval: [number, number];
  sources: SourceMatch[];
  is_citation: boolean;
  detection_method?: "exact" | "semantic" | "shingle" | "embedding" | "none";
}

export interface ParagraphReport {
  text: string;
  sentence_count: number;
  avg_similarity: number;
  avg_ai_probability: number;
  risk_band: "LOW" | "MODERATE" | "HIGH";
}

export interface ForensicSummary {
  obfuscation_flags: ObfuscationFlag[];
  docx_meta?: DocxMeta;
  high_similarity_sentence_count: number;
  high_ai_sentence_count: number;
  plain_language_summary?: string;
  improvement_tips?: string[];
  ai_band?: "LIKELY_HUMAN" | "UNCERTAIN" | "LIKELY_AI";
  ai_reasons?: string[];
  ai_signal_breakdown?: Record<string, number>;
  citation_excluded_count: number;
  detection_method_breakdown: {
    exact: number;
    semantic: number;
    shingle: number;
    embedding?: number;
  };
  overall_risk_explanation: string;
}

export interface Report {
  job_id: string;
  similarity_score: number;
  ai_probability: number;
  risk_band: "LOW" | "MODERATE" | "HIGH";
  sentences: SentenceReport[];
  paragraphs: ParagraphReport[];
  sources: SourceMatch[];
  forensic: ForensicSummary;
  metadata: {
    file_name: string;
    word_count: number;
    language: string;
    processing_time_ms: number;
    model_versions_used: {
      plagiarism: string;
      ai_detection: string;
    };
    citations_excluded: number;
    is_code_file: boolean;
  };
  scan_version: number;
  parent_job_id?: string;
}

export interface SubmissionJob {
  job_id: string;
  org_id: string;
  created_at: string;
  updated_at: string;
  file_name: string;
  file_path: string;
  status: JobStatus;
  error?: string;
  webhook_url?: string;
  submitter_email?: string;
  submitted_by?: string;
  role?: Role;
  retry_count?: number;
  max_retries?: number;
  next_retry_at?: string;
  report?: Report;
  scan_version?: number;
  parent_job_id?: string;
}

export interface CorpusDoc {
  id: string;
  org_id: string;
  title: string;
  url: string;
  content: string;
  created_at: string;
}

export interface ApiKey {
  id: string;
  key_hash: string;
  key_prefix: string;
  org_id: string;
  role: Role;
  label: string;
  created_at: string;
  last_used_at?: string;
  active: boolean;
}

export interface OrgConfig {
  id: string;
  name: string;
  student_source_reveal: boolean;
  allowed_file_types: string[];
  student_self_check_quota: number;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  event_type:
    | "submission.create"
    | "submission.delete"
    | "report.access"
    | "corpus.upload"
    | "key.create"
    | "key.revoke"
    | "org.create"
    | "org.update"
    | "bulk.submit";
  job_id?: string;
  org_id: string;
  api_key_id?: string;
  role?: Role;
  ip?: string;
  created_at: string;
  details?: Record<string, unknown>;
}

export type { DocxMeta, ObfuscationFlag };
