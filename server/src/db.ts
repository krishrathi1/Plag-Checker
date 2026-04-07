import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { CorpusDoc, SubmissionJob, ApiKey, OrgConfig, AuditEvent } from './types';
import { seedCorpus } from './corpus';

const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, "sqlite.db");
const OLD_DB_FILE = path.join(DATA_DIR, "db.json");

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    org_id TEXT,
    parent_job_id TEXT,
    status TEXT,
    json TEXT
  );
  CREATE TABLE IF NOT EXISTS corpus (
    id TEXT PRIMARY KEY,
    org_id TEXT,
    json TEXT
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT,
    org_id TEXT,
    active INTEGER,
    json TEXT
  );
  CREATE TABLE IF NOT EXISTS orgs (
    id TEXT PRIMARY KEY,
    json TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    org_id TEXT,
    json TEXT
  );
`);

// Migration from db.json if exists
if (fs.existsSync(OLD_DB_FILE)) {
  try {
    const raw = fs.readFileSync(OLD_DB_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    
    db.transaction(() => {
      if (parsed.jobs) {
        const stmt = db.prepare('INSERT OR IGNORE INTO jobs (job_id, org_id, parent_job_id, status, json) VALUES (?, ?, ?, ?, ?)');
        for (const job of Object.values(parsed.jobs)) {
          const j = job as SubmissionJob;
          stmt.run(j.job_id, j.org_id, j.parent_job_id || null, j.status, JSON.stringify(j));
        }
      }
      
      const corpusArray = parsed.corpus || seedCorpus;
      if (corpusArray) {
        const stmt = db.prepare('INSERT OR IGNORE INTO corpus (id, org_id, json) VALUES (?, ?, ?)');
        for (const doc of corpusArray) {
          const d = doc as CorpusDoc;
          stmt.run(d.id, d.org_id, JSON.stringify(d));
        }
      }
      
      if (parsed.api_keys) {
        const stmt = db.prepare('INSERT OR IGNORE INTO api_keys (id, key_hash, org_id, active, json) VALUES (?, ?, ?, ?, ?)');
        for (const key of parsed.api_keys) {
          const k = key as ApiKey;
          stmt.run(k.id, k.key_hash, k.org_id, k.active ? 1 : 0, JSON.stringify(k));
        }
      }
      
      if (parsed.orgs) {
        const stmt = db.prepare('INSERT OR IGNORE INTO orgs (id, json) VALUES (?, ?)');
        for (const org of Object.values(parsed.orgs)) {
          const o = org as OrgConfig;
          stmt.run(o.id, JSON.stringify(o));
        }
      }
      
      if (parsed.audit_log) {
        const stmt = db.prepare('INSERT OR IGNORE INTO audit_log (id, org_id, json) VALUES (?, ?, ?)');
        for (const log of parsed.audit_log) {
          const l = log as AuditEvent;
          stmt.run(l.id, l.org_id, JSON.stringify(l));
        }
      }
    })();

    fs.renameSync(OLD_DB_FILE, OLD_DB_FILE + ".bak");
  } catch (err) {
    console.error("Migration failed:", err);
  }
} else {
  const count = db.prepare('SELECT count(*) as c FROM orgs').get() as {c: number};
  if (count.c === 0) {
    db.prepare('INSERT INTO orgs (id, json) VALUES (?, ?)').run(
      "default-org",
      JSON.stringify({
        id: "default-org",
        name: "Default Organisation",
        student_source_reveal: false,
        allowed_file_types: ["pdf", "docx", "txt", "md", "csv", "tex", "pptx"],
        student_self_check_quota: 5,
        created_at: new Date().toISOString(),
      })
    );
    const corpusStmt = db.prepare('INSERT INTO corpus (id, org_id, json) VALUES (?, ?, ?)');
    for (const d of seedCorpus) {
      corpusStmt.run(d.id, d.org_id, JSON.stringify(d));
    }
  }
}