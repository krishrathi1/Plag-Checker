import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type JobStatus = "queued" | "processing" | "complete" | "failed";
type Role = "super_admin" | "org_admin" | "instructor" | "student";
type RiskBand = "LOW" | "MODERATE" | "HIGH";

interface SourceMatch {
  title: string;
  url: string;
  match_percentage: number;
  access_date: string;
}

interface SentenceReport {
  text: string;
  similarity_score: number;
  ai_probability: number;
  confidence_interval: [number, number];
  sources: SourceMatch[];
  is_citation: boolean;
  detection_method?: "exact" | "semantic" | "shingle" | "none";
}

interface ParagraphReport {
  text: string;
  sentence_count: number;
  avg_similarity: number;
  avg_ai_probability: number;
  risk_band: RiskBand;
}

interface ObfuscationFlag {
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  detail: string;
}

interface SuspicionFlag {
  code: string;
  severity: "INFO" | "WARN" | "HIGH";
  message: string;
}

interface DocxMeta {
  author?: string;
  lastModifiedBy?: string;
  createdAt?: string;
  modifiedAt?: string;
  revisionCount?: number;
  totalEditMinutes?: number;
  appWordCount?: number;
  applicationName?: string;
  hasTrackedChanges: boolean;
  trackedChangeCount: number;
  hasComments: boolean;
  fontFamilyCount: number;
  fontFamilies: string[];
  styleCount: number;
  suspicionFlags: SuspicionFlag[];
}

interface ForensicSummary {
  obfuscation_flags: ObfuscationFlag[];
  docx_meta?: DocxMeta;
  high_similarity_sentence_count: number;
  high_ai_sentence_count: number;
  plain_language_summary?: string;
  improvement_tips?: string[];
  citation_excluded_count: number;
  detection_method_breakdown: { exact: number; semantic: number; shingle: number; embedding?: number };
  overall_risk_explanation: string;
}

interface Report {
  job_id: string;
  similarity_score: number;
  ai_probability: number;
  risk_band: RiskBand;
  sentences: SentenceReport[];
  paragraphs: ParagraphReport[];
  sources: SourceMatch[];
  forensic: ForensicSummary;
  scan_version: number;
  parent_job_id?: string;
  metadata: {
    file_name: string;
    word_count: number;
    language: string;
    processing_time_ms: number;
    citations_excluded: number;
    is_code_file: boolean;
    model_versions_used: { plagiarism: string; ai_detection: string };
  };
}

interface OrgStats {
  org_id: string;
  total_submissions: number;
  queued: number;
  processing: number;
  complete: number;
  failed: number;
  avg_similarity_score: number;
  avg_ai_probability: number;
}

interface HistoryEntry {
  job_id: string;
  scan_version: number;
  status: JobStatus;
  created_at: string;
  similarity_score?: number;
  ai_probability?: number;
  risk_band?: RiskBand;
}

interface OrgConfig {
  id: string;
  name: string;
  student_source_reveal: boolean;
  allowed_file_types: string[];
  student_self_check_quota: number;
}

// â”€â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8080";

const RISK_COLOR: Record<RiskBand, string> = {
  LOW: "#22c55e",
  MODERATE: "#f59e0b",
  HIGH: "#ef4444",
};

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}

function sentenceClass(s: SentenceReport): string {
  if (s.is_citation) return "sent-citation";
  const highPlag = s.similarity_score >= 0.3;
  const highAI = s.ai_probability >= 0.6;
  if (highPlag && highAI) return "sent-both";
  if (highPlag) return "sent-plagiarism";
  if (highAI) return "sent-ai";
  return "sent-clean";
}

// â”€â”€â”€ API Client â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function makeHeaders(apiKey: string | null): Record<string, string> {
  const h: Record<string, string> = {};
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}

async function apiGet<T>(path: string, apiKey: string | null): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: makeHeaders(apiKey) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// â”€â”€â”€ Components â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ScoreGauge({ value, label, color }: { value: number; label: string; color: string }) {
  const deg = Math.round(value * 180);
  return (
    <div className="gauge-wrap">
      <svg viewBox="0 0 100 55" className="gauge-svg">
        <path d="M10,50 A40,40 0 0,1 90,50" fill="none" stroke="#e2e8f0" strokeWidth="10" strokeLinecap="round" />
        <path
          d="M10,50 A40,40 0 0,1 90,50"
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${(deg / 180) * 125.6} 125.6`}
        />
        <text x="50" y="48" textAnchor="middle" fontSize="14" fontWeight="bold" fill={color}>
          {pct(value)}
        </text>
      </svg>
      <span className="gauge-label">{label}</span>
    </div>
  );
}

function RiskPill({ band }: { band: RiskBand }) {
  return (
    <span className="risk-pill" style={{ background: RISK_COLOR[band] }}>
      {band}
    </span>
  );
}

// â”€â”€â”€ Forensic Panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SEV_COLOR: Record<string, string> = {
  HIGH: "#ef4444", WARN: "#f59e0b", MEDIUM: "#f59e0b", INFO: "#6366f1", LOW: "#94a3b8",
};

function ForensicPanel({ forensic }: { forensic: ForensicSummary }) {
  const {
    obfuscation_flags,
    docx_meta,
    detection_method_breakdown,
    overall_risk_explanation,
    plain_language_summary,
    improvement_tips,
  } = forensic;
  const total = Object.values(detection_method_breakdown).reduce((a, b) => a + b, 0);

  return (
    <section className="card forensic-card">
      <h3>Forensic Analysis</h3>

      {/* Risk explanation */}
      <div className="forensic-explanation">{overall_risk_explanation}</div>
      {(plain_language_summary || (improvement_tips?.length ?? 0) > 0) && (
        <div className="forensic-coaching">
          {plain_language_summary && (
            <p className="forensic-coaching-summary">{plain_language_summary}</p>
          )}
          {(improvement_tips?.length ?? 0) > 0 && (
            <ul className="forensic-coaching-list">
              {improvement_tips?.map((tip, i) => (
                <li key={i}>{tip}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="forensic-grid">
        {/* Detection method breakdown */}
        <div className="forensic-block">
          <p className="forensic-block-title">Detection Methods Used</p>
          {total === 0 ? <p className="muted">No corpus matches found.</p> : (
            <div className="method-bars">
              {(["exact","semantic","shingle","embedding"] as const).map((m) => {
                const count = detection_method_breakdown[m] || 0;
                return (
                  <div key={m} className="method-bar-row">
                    <span className="method-label">{m}</span>
                    <div className="method-track">
                      <div className="method-fill" style={{ width: total ? `${(count/total)*100}%` : "0%", background: m === "exact" ? "#ef4444" : m === "semantic" ? "#6366f1" : m === "embedding" ? "#22c55e" : "#f59e0b" }} />
                    </div>
                    <span className="method-count">{count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Sentence counts */}
        <div className="forensic-block">
          <p className="forensic-block-title">Sentence Risk Summary</p>
          <div className="forensic-stat-grid">
            <div className="forensic-stat"><span>High Similarity</span><strong style={{color:"#ef4444"}}>{forensic.high_similarity_sentence_count}</strong></div>
            <div className="forensic-stat"><span>High AI Prob</span><strong style={{color:"#f59e0b"}}>{forensic.high_ai_sentence_count}</strong></div>
            <div className="forensic-stat"><span>Citations Excl.</span><strong style={{color:"#22c55e"}}>{forensic.citation_excluded_count}</strong></div>
          </div>
        </div>
      </div>

      {/* Obfuscation flags */}
      {obfuscation_flags.length > 0 && (
        <div className="obf-section">
          <p className="forensic-block-title">Obfuscation Detected</p>
          {obfuscation_flags.map((f, i) => (
            <div key={i} className="flag-row" style={{ borderLeftColor: SEV_COLOR[f.severity] }}>
              <span className="flag-sev" style={{ color: SEV_COLOR[f.severity] }}>{f.severity}</span>
              <span className="flag-detail">{f.detail}</span>
            </div>
          ))}
        </div>
      )}

      {/* DOCX metadata */}
      {docx_meta && (
        <div className="docx-meta-section">
          <p className="forensic-block-title">Document Metadata (DOCX)</p>
          <div className="docx-meta-grid">
            {docx_meta.author && <div className="docx-row"><span>Author</span><strong>{docx_meta.author}</strong></div>}
            {docx_meta.lastModifiedBy && docx_meta.lastModifiedBy !== docx_meta.author && (
              <div className="docx-row"><span>Last Modified By</span><strong style={{color:"#f59e0b"}}>{docx_meta.lastModifiedBy}</strong></div>
            )}
            {docx_meta.createdAt && <div className="docx-row"><span>Created</span><strong>{new Date(docx_meta.createdAt).toLocaleString()}</strong></div>}
            {docx_meta.modifiedAt && <div className="docx-row"><span>Modified</span><strong>{new Date(docx_meta.modifiedAt).toLocaleString()}</strong></div>}
            {docx_meta.revisionCount !== undefined && <div className="docx-row"><span>Revisions</span><strong style={docx_meta.revisionCount <= 2 ? {color:"#f59e0b"} : {}}>{docx_meta.revisionCount}</strong></div>}
            {docx_meta.totalEditMinutes !== undefined && <div className="docx-row"><span>Edit Time</span><strong style={docx_meta.totalEditMinutes < 3 ? {color:"#ef4444"} : {}}>{docx_meta.totalEditMinutes} min</strong></div>}
            {docx_meta.appWordCount !== undefined && <div className="docx-row"><span>Reported Words</span><strong>{docx_meta.appWordCount}</strong></div>}
            {docx_meta.applicationName && <div className="docx-row"><span>Application</span><strong>{docx_meta.applicationName}</strong></div>}
            <div className="docx-row"><span>Tracked Changes</span><strong style={docx_meta.hasTrackedChanges ? {color:"#f59e0b"} : {}}>{docx_meta.hasTrackedChanges ? `Yes (${docx_meta.trackedChangeCount})` : "No"}</strong></div>
            <div className="docx-row"><span>Comments</span><strong>{docx_meta.hasComments ? "Yes" : "No"}</strong></div>
            <div className="docx-row"><span>Font Families</span><strong style={docx_meta.fontFamilyCount > 6 ? {color:"#f59e0b"} : {}}>{docx_meta.fontFamilyCount}{docx_meta.fontFamilies.length ? `: ${docx_meta.fontFamilies.slice(0,4).join(", ")}` : ""}</strong></div>
          </div>
          {docx_meta.suspicionFlags.length > 0 && (
            <div className="suspicion-flags">
              {docx_meta.suspicionFlags.map((f, i) => (
                <div key={i} className="flag-row" style={{ borderLeftColor: SEV_COLOR[f.severity] }}>
                  <span className="flag-sev" style={{ color: SEV_COLOR[f.severity] }}>{f.severity}</span>
                  <span className="flag-detail">{f.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// â”€â”€â”€ Paragraph Heatmap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ParagraphHeatmap({ paragraphs }: { paragraphs: ParagraphReport[] }) {
  if (!paragraphs.length) return null;
  return (
    <section className="card para-card">
      <h3>Paragraph-Level Heatmap</h3>
      <p className="muted" style={{marginBottom:"12px", fontSize:"0.78rem"}}>Each block = one paragraph. Colour = dominant risk signal.</p>
      <div className="para-grid">
        {paragraphs.map((p, i) => {
          const dominant = p.avg_similarity > p.avg_ai_probability ? "plag" : "ai";
          const intensity = Math.max(p.avg_similarity, p.avg_ai_probability);
          return (
            <div
              key={i}
              className={`para-block para-block-${dominant}`}
              style={{ opacity: 0.3 + intensity * 0.7 }}
              title={`P${i+1}: Similarity ${pct(p.avg_similarity)} | AI ${pct(p.avg_ai_probability)} | ${p.sentence_count} sentences`}
            >
              <span className="para-num">P{i + 1}</span>
              <span className="para-scores">{pct(p.avg_similarity)} / {pct(p.avg_ai_probability)}</span>
            </div>
          );
        })}
      </div>
      <div className="para-legend">
        <span><span className="para-dot plag-dot"/>Plagiarism dominant</span>
        <span><span className="para-dot ai-dot"/>AI dominant</span>
        <span style={{color:"var(--muted)"}}>Opacity = intensity</span>
      </div>
    </section>
  );
}

function SentenceLegend() {
  return (
    <div className="legend">
      <span className="legend-dot sent-plagiarism-dot" />Plagiarism
      <span className="legend-dot sent-ai-dot" />AI-generated
      <span className="legend-dot sent-both-dot" />Both
      <span className="legend-dot sent-citation-dot" />Citation (excluded)
    </div>
  );
}

function SentenceHighlighter({ sentences }: { sentences: SentenceReport[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [humanizedText, setHumanizedText] = useState<string | null>(null);
  const [humanizing, setHumanizing] = useState(false);
  const [humanizeError, setHumanizeError] = useState<string | null>(null);

  const handleSpanClick = (i: number) => {
    if (active === i) {
      setActive(null);
      setHumanizedText(null);
      setHumanizeError(null);
      return;
    }
    setActive(i);
    setHumanizedText(null);
    setHumanizeError(null);
  };

  const handleHumanize = async (text: string) => {
    setHumanizing(true);
    setHumanizeError(null);
    setHumanizedText(null);
    try {
      const res = await fetch(`${API_BASE}/v1/writing-assist/humanize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const payload = (await res.json()) as { rewritten?: string; error?: string };
      if (!res.ok || !payload.rewritten) {
        setHumanizeError(payload.error ?? "Unable to humanize this sentence right now.");
        return;
      }
      setHumanizedText(payload.rewritten);
    } catch {
      setHumanizeError("Unable to humanize this sentence right now.");
    } finally {
      setHumanizing(false);
    }
  };

  return (
    <div className="highlight-prose">
      {sentences.map((s, i) => (
        <span
          key={i}
          className={`sent-span ${sentenceClass(s)}`}
          onClick={() => handleSpanClick(i)}
          title={`Similarity: ${pct(s.similarity_score)} | AI: ${pct(s.ai_probability)}`}
        >
          {s.text}{" "}
          {active === i && (
            <span className="sent-popup" onClick={(e) => e.stopPropagation()}>
              <strong>Similarity:</strong> {pct(s.similarity_score)}<br />
              <strong>AI:</strong> {pct(s.ai_probability)}<br />
              <strong>Confidence:</strong> {pct(s.confidence_interval[0])}–{pct(s.confidence_interval[1])}<br />
              {s.is_citation && <em>Excluded as citation</em>}
              {s.sources.slice(0, 2).map((src) => (
                <span key={src.url} className="sent-src">
                  SRC <a href={src.url} target="_blank" rel="noreferrer">{src.title}</a> ({src.match_percentage.toFixed(1)}%)
                </span>
              ))}
              {!s.is_citation && (
                <div className="sent-humanize-box">
                  <button
                    className="sent-humanize-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleHumanize(s.text);
                    }}
                    disabled={humanizing}
                  >
                    {humanizing ? "Humanizing..." : "Humanize Tone"}
                  </button>
                  {humanizeError && <p className="sent-humanize-error">{humanizeError}</p>}
                  {humanizedText && (
                    <div className="sent-humanized-result">
                      <strong>Humanized:</strong>
                      <p>{humanizedText}</p>
                    </div>
                  )}
                </div>
              )}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
function SideBySideView({ sentences, sources }: { sentences: SentenceReport[]; sources: SourceMatch[] }) {
  const topSource = sources[0];
  return (
    <div className="side-by-side">
      <div className="sbs-col">
        <h4>Submitted Document</h4>
        <div className="sbs-scroll">
          {sentences.map((s, i) => (
            <p key={i} className={`sbs-para ${sentenceClass(s)}`}>
              {s.text}
            </p>
          ))}
        </div>
      </div>
      <div className="sbs-col">
        <h4>
          Top Match:{" "}
          {topSource ? (
            <a href={topSource.url} target="_blank" rel="noreferrer">
              {topSource.title}
            </a>
          ) : (
            "No sources found"
          )}
        </h4>
        <div className="sbs-scroll">
          {topSource ? (
            <div className="sbs-sources">
              {sources.slice(0, 8).map((src) => (
                <div key={src.url} className="source-card">
                  <div className="source-card-title">
                    <a href={src.url} target="_blank" rel="noreferrer">{src.title}</a>
                  </div>
                  <div className="source-card-meta">
                    Match: <strong>{src.match_percentage.toFixed(2)}%</strong>
                    &nbsp;Â·&nbsp;Accessed: {src.access_date}
                  </div>
                  <div className="source-card-url">{src.url}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No matching sources found in corpus.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyStatePanel({
  stats,
  orgConfig,
}: {
  stats: OrgStats | null;
  orgConfig: OrgConfig | null;
}) {
  return (
    <section className="card empty-state-card">
      <h3>Dashboard Overview</h3>
      <p className="muted">
        Upload a document to generate a full integrity report with source matching, AI probability,
        sentence highlights, and writing guidance.
      </p>
      <div className="empty-state-grid">
        <div className="empty-kpi">
          <span className="empty-kpi-label">Total Submissions</span>
          <strong>{stats?.total_submissions ?? 0}</strong>
        </div>
        <div className="empty-kpi">
          <span className="empty-kpi-label">Completed</span>
          <strong>{stats?.complete ?? 0}</strong>
        </div>
        <div className="empty-kpi">
          <span className="empty-kpi-label">Avg Similarity</span>
          <strong>{stats ? pct(stats.avg_similarity_score) : "0.0%"}</strong>
        </div>
        <div className="empty-kpi">
          <span className="empty-kpi-label">Avg AI Probability</span>
          <strong>{stats ? pct(stats.avg_ai_probability) : "0.0%"}</strong>
        </div>
      </div>
      {orgConfig && (
        <div className="empty-notes">
          <span>Allowed file types: {orgConfig.allowed_file_types.join(", ")}</span>
          <span>Student quota: {orgConfig.student_self_check_quota}</span>
        </div>
      )}
    </section>
  );
}

// â”€â”€â”€ Main App â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default function App() {
  // Auth
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [orgId, setOrgId] = useState("default-org");
  const [viewRole, setViewRole] = useState<Role>("instructor");
  const [authError, setAuthError] = useState("");

  // Submission
  const [file, setFile] = useState<File | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [submitterEmail, setSubmitterEmail] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  // Report
  const [report, setReport] = useState<Report | null>(null);
  const [reportView, setReportView] = useState<"highlight" | "sidebyside" | "table">("highlight");

  // Org
  const [stats, setStats] = useState<OrgStats | null>(null);
  const [orgConfig, setOrgConfig] = useState<OrgConfig | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Drag-and-drop
  const dropRef = useRef<HTMLLabelElement>(null);
  const [dragging, setDragging] = useState(false);

  const effectiveKey = apiKey; // null = dev mode (no auth required)

  // â”€â”€ Polling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  useEffect(() => {
    if (!jobId || !status || status === "complete" || status === "failed") return;
    const timer = setInterval(async () => {
      try {
        const payload = await apiGet<{ status: JobStatus; error?: string }>(
          `/v1/submissions/${jobId}`,
          effectiveKey,
        );
        setStatus(payload.status);
        if (payload.status === "complete") {
          const r = await apiGet<Report>(`/v1/submissions/${jobId}/report`, effectiveKey);
          setReport(r);
          fetchHistory(jobId);
        }
        if (payload.status === "failed") {
          setMessage(`Processing failed: ${payload.error ?? "unknown error"}`);
        }
      } catch (e) {
        setMessage((e as Error).message);
      }
    }, 1300);
    return () => clearInterval(timer);
  }, [jobId, status, effectiveKey]);

  // â”€â”€ Fetches â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const fetchStats = useCallback(async () => {
    try {
      const s = await apiGet<OrgStats>(`/v1/organisations/${orgId}/stats`, effectiveKey);
      setStats(s);
    } catch (e) {
      setMessage((e as Error).message);
    }
  }, [orgId, effectiveKey]);

  const fetchOrgConfig = useCallback(async () => {
    try {
      const cfg = await apiGet<OrgConfig>(`/v1/organisations/${orgId}/config`, effectiveKey);
      setOrgConfig(cfg);
    } catch { /* org may not exist yet */ }
  }, [orgId, effectiveKey]);

  const fetchHistory = useCallback(async (jid: string) => {
    try {
      const h = await apiGet<HistoryEntry[]>(`/v1/submissions/${jid}/history`, effectiveKey);
      setHistory(h);
    } catch { /* ignore */ }
  }, [effectiveKey]);

  // â”€â”€ Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function handleConnect() {
    setAuthError("");
    try {
      await apiGet("/v1/health", apiKeyInput || null);
      setApiKey(apiKeyInput || null);
      setOrgId(orgId);
      await fetchStats();
      await fetchOrgConfig();
    } catch (e) {
      setAuthError((e as Error).message);
    }
  }

  // â”€â”€ Submission â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function submitFile(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { setMessage("Please choose a document first."); return; }

    setLoading(true);
    setMessage("");
    setReport(null);
    setJobId(null);
    setHistory([]);

    const form = new FormData();
    form.append("file", file);
    form.append("org_id", orgId);
    if (webhookUrl) form.append("webhook_url", webhookUrl);
    if (submitterEmail) form.append("submitter_email", submitterEmail);

    try {
      const res = await fetch(`${API_BASE}/v1/submissions`, {
        method: "POST",
        headers: makeHeaders(effectiveKey),
        body: form,
      });
      const payload = await res.json() as { job_id?: string; status?: string; error?: string };
      if (!res.ok) { setMessage(payload.error ?? "Upload failed."); return; }
      setJobId(payload.job_id ?? null);
      setStatus((payload.status as JobStatus) ?? null);
      setMessage(`Queued. Job ID: ${payload.job_id}`);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // â”€â”€ Drag-and-drop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function onDrop(ev: React.DragEvent) {
    ev.preventDefault();
    setDragging(false);
    const f = ev.dataTransfer.files[0];
    if (f) setFile(f);
  }

  // â”€â”€ Derived â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const riskColor = useMemo(
    () => (report ? RISK_COLOR[report.risk_band] : "transparent"),
    [report],
  );

  const statusTone: Record<JobStatus, "neutral" | "warn" | "success" | "danger"> = {
    queued: "neutral",
    processing: "warn",
    complete: "success",
    failed: "danger",
  };

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  return (
    <div className="app-root">
      {/* â”€â”€ Sidebar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-icon">VC</span>
          <span className="brand-name">VeriCheck<em>AI</em></span>
        </div>

        <div className="sidebar-section">
          <p className="sidebar-label">Organisation</p>
          <input
            className="sidebar-input"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            placeholder="org-id"
          />
        </div>

        <div className="sidebar-section">
          <p className="sidebar-label">API Key (optional in dev)</p>
          <input
            className="sidebar-input"
            type="password"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder="vk_..."
          />
          {authError && <p className="sidebar-error">{authError}</p>}
          <button className="sidebar-btn" onClick={handleConnect}>
            {apiKey !== undefined ? "Reconnect" : "Connect"}
          </button>
        </div>

        <div className="sidebar-section">
          <p className="sidebar-label">View as</p>
          <select
            className="sidebar-input"
            value={viewRole}
            onChange={(e) => setViewRole(e.target.value as Role)}
          >
            <option value="instructor">Instructor</option>
            <option value="student">Student</option>
            <option value="org_admin">Org Admin</option>
          </select>
        </div>

        {stats && (
          <div className="sidebar-stats">
            <p className="sidebar-label">Org Stats</p>
            <div className="mini-stat"><span>Total</span><strong>{stats.total_submissions}</strong></div>
            <div className="mini-stat"><span>Complete</span><strong>{stats.complete}</strong></div>
            <div className="mini-stat"><span>Avg Similarity</span><strong>{pct(stats.avg_similarity_score)}</strong></div>
            <div className="mini-stat"><span>Avg AI</span><strong>{pct(stats.avg_ai_probability)}</strong></div>
          </div>
        )}

        {orgConfig && (
          <div className="sidebar-config">
            <p className="sidebar-label">Org Config</p>
            <div className="mini-stat"><span>Student reveal</span><strong>{orgConfig.student_source_reveal ? "Yes" : "No"}</strong></div>
            <div className="mini-stat"><span>Student quota</span><strong>{orgConfig.student_self_check_quota}</strong></div>
            <div className="mini-stat"><span>Allowed types</span><strong>{orgConfig.allowed_file_types.join(", ")}</strong></div>
          </div>
        )}

        <div className="sidebar-actions">
          <button className="sidebar-btn-sec" onClick={fetchStats}>Refresh Stats</button>
          <button className="sidebar-btn-sec" onClick={fetchOrgConfig}>Reload Config</button>
          {jobId && (
            <a
              className="sidebar-btn-sec"
              href={`${API_BASE}/v1/submissions/${jobId}/report/pdf`}
              target="_blank"
              rel="noreferrer"
            >
              Download PDF
            </a>
          )}
        </div>
      </aside>

      {/* â”€â”€ Main area â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <main className="main-area">
        {/* Upload card */}
        <section className="card upload-card">
          <h2>Submit Document</h2>
          <form onSubmit={submitFile}>
            <label
              ref={dropRef}
              className={`drop-zone ${dragging ? "drop-zone-active" : ""} ${file ? "drop-zone-filled" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              {file ? (
                <>
                    <span className="drop-icon">FILE</span>
                  <span className="drop-filename">{file.name}</span>
                  <span className="drop-hint">Click or drop to replace</span>
                </>
              ) : (
                <>
                  <span className="drop-icon">UPLOAD</span>
                  <span className="drop-hint">Drop a file here or click to browse</span>
                  <span className="drop-types">PDF | DOCX | PPTX | TXT | TEX | MD | code files</span>
                </>
              )}
              <input
                type="file"
                className="drop-input"
                accept=".pdf,.docx,.pptx,.txt,.md,.tex,.csv,.js,.ts,.py,.java,.c,.cpp,.go,.rs"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>

            <div className="form-row">
              <label className="form-field">
                Webhook URL (optional)
                <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://..." />
              </label>
              <label className="form-field">
                Email notification (optional)
                <input type="email" value={submitterEmail} onChange={(e) => setSubmitterEmail(e.target.value)} placeholder="you@example.com" />
              </label>
            </div>

            <button className="btn-primary" type="submit" disabled={loading || !file}>
              {loading ? "Submitting..." : "Submit for Scan"}
            </button>
          </form>

          {message && <p className="info-msg">{message}</p>}
          {status && (
            <div className="status-bar">
              <span className={`status-badge status-${statusTone[status]}`}>{status.toUpperCase()}</span>
              {status === "processing" && <span className="spinner" />}
            </div>
          )}
        </section>

        {!report && <EmptyStatePanel stats={stats} orgConfig={orgConfig} />}

        {/* Report */}
        {report && (
          <>
            {/* Summary scores */}
            <section className="card score-card" style={{ borderTop: `4px solid ${riskColor}` }}>
              <div className="score-header">
                <h2>
                  {report.metadata.file_name}
                  <RiskPill band={report.risk_band} />
                  {report.scan_version > 1 && (
                    <span className="version-badge">v{report.scan_version}</span>
                  )}
                </h2>
                <div className="score-meta">
                  {report.metadata.word_count.toLocaleString()} words |{" "}
                  lang: <strong>{report.metadata.language}</strong> |{" "}
                  processed in <strong>{report.metadata.processing_time_ms}ms</strong> |{" "}
                  {report.metadata.citations_excluded > 0 && (
                    <span>{report.metadata.citations_excluded} citation(s) excluded | </span>
                  )}
                  {report.metadata.is_code_file && <span className="code-badge">CODE FILE</span>}
                </div>
              </div>

              <div className="gauges">
                <ScoreGauge value={report.similarity_score} label="Similarity" color="#6366f1" />
                <ScoreGauge value={report.ai_probability} label="AI Probability" color="#f59e0b" />
                <div className="risk-gauge">
                  <div className="risk-band-display" style={{ color: riskColor }}>
                    {report.risk_band}
                  </div>
                  <span className="gauge-label">Risk Band</span>
                </div>
              </div>

              <div className="model-tags">
                <span className="model-tag">Plagiarism: {report.metadata.model_versions_used.plagiarism}</span>
                <span className="model-tag">AI: {report.metadata.model_versions_used.ai_detection}</span>
              </div>
            </section>

            {/* Forensic Analysis */}
            <ForensicPanel forensic={report.forensic} />

            {/* Paragraph Heatmap */}
            <ParagraphHeatmap paragraphs={report.paragraphs} />

            {/* Scan history */}
            {history.length > 1 && (
              <section className="card history-card">
                <h3>Scan History</h3>
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>Version</th><th>Date</th><th>Similarity</th><th>AI Prob</th><th>Risk</th><th>Job ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.job_id} className={h.job_id === report.job_id ? "history-active" : ""}>
                        <td>v{h.scan_version}</td>
                        <td>{new Date(h.created_at).toLocaleDateString()}</td>
                        <td>{h.similarity_score != null ? pct(h.similarity_score) : "-"}</td>
                        <td>{h.ai_probability != null ? pct(h.ai_probability) : "-"}</td>
                        <td>
                          {h.risk_band ? (
                            <span style={{ color: RISK_COLOR[h.risk_band] }}>{h.risk_band}</span>
                          ) : "-"}
                        </td>
                        <td><code>{h.job_id.slice(0, 8)}...</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {/* Report view toggle */}
            <section className="card analysis-card">
              <div className="view-toggle">
                <button
                  className={reportView === "highlight" ? "toggle-btn active" : "toggle-btn"}
                  onClick={() => setReportView("highlight")}
                >Highlight View</button>
                <button
                  className={reportView === "sidebyside" ? "toggle-btn active" : "toggle-btn"}
                  onClick={() => setReportView("sidebyside")}
                >Side-by-Side</button>
                <button
                  className={reportView === "table" ? "toggle-btn active" : "toggle-btn"}
                  onClick={() => setReportView("table")}
                >Table View</button>
              </div>

              <SentenceLegend />

              {reportView === "highlight" && (
                <SentenceHighlighter sentences={report.sentences} />
              )}

              {reportView === "sidebyside" && (
                <SideBySideView sentences={report.sentences} sources={report.sources} />
              )}

              {reportView === "table" && (
                <div className="table-wrap">
                  <table className="sentence-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Sentence</th>
                        <th>Similarity</th>
                        <th>AI Prob</th>
                        <th>CI</th>
                        <th>Method</th>
                        <th>Citation</th>
                        {viewRole !== "student" && <th>Top Source</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {report.sentences.slice(0, 100).map((s, i) => (
                        <tr key={i} className={sentenceClass(s)}>
                          <td>{i + 1}</td>
                          <td className="cell-text">{s.text}</td>
                          <td>{pct(s.similarity_score)}</td>
                          <td>{pct(s.ai_probability)}</td>
                          <td>
                            {pct(s.confidence_interval[0])}-{pct(s.confidence_interval[1])}
                          </td>
                          <td>
                            {s.detection_method && s.detection_method !== "none" ? (
                              <span className={`method-chip method-chip-${s.detection_method}`}>
                                {s.detection_method}
                              </span>
                            ) : "-"}
                          </td>
                          <td>{s.is_citation ? "Yes" : ""}</td>
                          {viewRole !== "student" && (
                            <td>
                              {s.sources[0] ? (
                                <a href={s.sources[0].url} target="_blank" rel="noreferrer">
                                  {s.sources[0].title}
                                </a>
                              ) : "-"}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Sources list â€” only for non-student or if reveal enabled */}
            {(viewRole !== "student" || orgConfig?.student_source_reveal) && report.sources.length > 0 && (
              <section className="card sources-card">
                <h3>Source Attribution ({report.sources.length})</h3>
                <div className="sources-grid">
                  {report.sources.map((src) => (
                    <div key={src.url} className="source-card">
                      <div className="source-card-title">
                        <a href={src.url} target="_blank" rel="noreferrer">{src.title}</a>
                      </div>
                      <div className="source-bar">
                        <div
                          className="source-bar-fill"
                          style={{ width: `${src.match_percentage}%` }}
                        />
                      </div>
                      <div className="source-card-meta">
                        {src.match_percentage.toFixed(2)}% match | {src.access_date}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

