/**
 * Deep DOCX metadata extraction
 *
 * A genuine DOCX file is an Office Open XML ZIP. We open it with adm-zip and
 * parse the internal XML parts to extract forensic signals:
 *
 *  • docProps/core.xml  — author, created, modified, revision count
 *  • docProps/app.xml   — total edit time, word count, application used
 *  • word/document.xml  — tracked changes, font diversity, comment markers
 *  • word/styles.xml    — style origins (copied styles indicate paste from web)
 *  • word/settings.xml  — revision tracking enabled/disabled
 *
 * Suspicious patterns generate human-readable flags that are included in the report.
 */

import AdmZip from "adm-zip";

export interface DocxMeta {
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

export interface SuspicionFlag {
  code: string;
  severity: "INFO" | "WARN" | "HIGH";
  message: string;
}

function xmlText(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : undefined;
}

function xmlAttr(xml: string, tag: string, attr: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*${attr}="([^"]+)"`));
  return m?.[1];
}

export function extractDocxMeta(buffer: Buffer): DocxMeta {
  const meta: DocxMeta = {
    hasTrackedChanges: false,
    trackedChangeCount: 0,
    hasComments: false,
    fontFamilyCount: 0,
    fontFamilies: [],
    styleCount: 0,
    suspicionFlags: [],
  };

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return meta;
  }

  const entries = new Map(zip.getEntries().map((e) => [e.entryName, e]));

  const getText = (path: string): string | null => {
    const e = entries.get(path);
    return e ? e.getData().toString("utf-8") : null;
  };

  // ── core.xml ──────────────────────────────────────────────────────────────

  const coreXml = getText("docProps/core.xml");
  if (coreXml) {
    meta.author = xmlText(coreXml, "dc:creator");
    meta.lastModifiedBy = xmlText(coreXml, "cp:lastModifiedBy");
    meta.createdAt = xmlText(coreXml, "dcterms:created");
    meta.modifiedAt = xmlText(coreXml, "dcterms:modified");
    const rev = xmlText(coreXml, "cp:revision");
    if (rev) meta.revisionCount = parseInt(rev, 10);
  }

  // ── app.xml ───────────────────────────────────────────────────────────────

  const appXml = getText("docProps/app.xml");
  if (appXml) {
    const editTime = xmlText(appXml, "TotalTime");
    if (editTime) meta.totalEditMinutes = parseInt(editTime, 10);
    const wc = xmlText(appXml, "Words");
    if (wc) meta.appWordCount = parseInt(wc, 10);
    meta.applicationName = xmlText(appXml, "Application");
  }

  // ── document.xml ──────────────────────────────────────────────────────────

  const docXml = getText("word/document.xml");
  if (docXml) {
    // Tracked insertions / deletions
    const insertions = (docXml.match(/<w:ins\s/g) ?? []).length;
    const deletions = (docXml.match(/<w:del\s/g) ?? []).length;
    meta.trackedChangeCount = insertions + deletions;
    meta.hasTrackedChanges = meta.trackedChangeCount > 0;

    // Comments
    meta.hasComments = /<w:commentRangeStart/.test(docXml);

    // Font diversity — collect all rFonts references
    const fontSet = new Set<string>();
    for (const m of docXml.matchAll(/w:ascii="([^"]+)"/g)) fontSet.add(m[1]);
    for (const m of docXml.matchAll(/w:hAnsi="([^"]+)"/g)) fontSet.add(m[1]);
    meta.fontFamilies = [...fontSet];
    meta.fontFamilyCount = fontSet.size;
  }

  // ── styles.xml ────────────────────────────────────────────────────────────

  const stylesXml = getText("word/styles.xml");
  if (stylesXml) {
    meta.styleCount = (stylesXml.match(/<w:style\s/g) ?? []).length;
  }

  // ── Suspicion flags ───────────────────────────────────────────────────────

  const wc = meta.appWordCount ?? 0;

  if (
    meta.totalEditMinutes !== undefined &&
    wc > 300 &&
    meta.totalEditMinutes < 3
  ) {
    meta.suspicionFlags.push({
      code: "FAST_CREATION",
      severity: "HIGH",
      message: `Document has ${wc} words but total edit time is only ${meta.totalEditMinutes} minute(s). Likely copy-pasted rather than typed.`,
    });
  }

  if (
    meta.revisionCount !== undefined &&
    meta.revisionCount <= 2 &&
    wc > 500
  ) {
    meta.suspicionFlags.push({
      code: "LOW_REVISIONS",
      severity: "WARN",
      message: `Only ${meta.revisionCount} revision(s) for a ${wc}-word document. Documents written organically typically have many more revisions.`,
    });
  }

  if (meta.fontFamilyCount > 6) {
    meta.suspicionFlags.push({
      code: "FONT_DIVERSITY",
      severity: "WARN",
      message: `${meta.fontFamilyCount} distinct font families detected: ${meta.fontFamilies.slice(0, 6).join(", ")}. Multiple fonts suggest text was pasted from different sources.`,
    });
  }

  if (meta.author && meta.lastModifiedBy && meta.author !== meta.lastModifiedBy) {
    meta.suspicionFlags.push({
      code: "MULTIPLE_AUTHORS",
      severity: "WARN",
      message: `Created by "${meta.author}" but last modified by "${meta.lastModifiedBy}". Multiple authors on a submission warrant review.`,
    });
  }

  if (meta.applicationName && /google|libreoffice|openoffice/i.test(meta.applicationName)) {
    meta.suspicionFlags.push({
      code: "APP_MISMATCH",
      severity: "INFO",
      message: `Document created with "${meta.applicationName}". Different from the expected institutional word processor.`,
    });
  }

  if (meta.hasTrackedChanges && meta.trackedChangeCount > 20) {
    meta.suspicionFlags.push({
      code: "TRACKED_CHANGES",
      severity: "INFO",
      message: `${meta.trackedChangeCount} tracked changes found. Review the accept/reject history.`,
    });
  }

  if (meta.styleCount > 50) {
    meta.suspicionFlags.push({
      code: "STYLE_COUNT",
      severity: "INFO",
      message: `${meta.styleCount} styles in document — higher than typical. May indicate content assembled from multiple documents.`,
    });
  }

  return meta;
}
