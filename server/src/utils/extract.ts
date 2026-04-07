/**
 * Text extraction for formats not handled by the base queue worker:
 *  - PPTX  (PowerPoint Open XML)
 *  - LaTeX (.tex)
 *
 * PPTX is an Office Open XML ZIP. We unzip it and extract text nodes from
 * the slide XML files without any heavy dependency.
 */

import AdmZip from "adm-zip";

// ─── PPTX ─────────────────────────────────────────────────────────────────────

function xmlTextContent(xml: string): string {
  // Grab every <a:t>...</a:t> text run (DrawingML namespace)
  const texts: string[] = [];
  const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const decoded = m[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();
    if (decoded) texts.push(decoded);
  }
  return texts.join(" ");
}

export function extractPptxText(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  // Find slide XML files and sort them numerically
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const numA = parseInt(a.entryName.replace(/\D/g, ""), 10);
      const numB = parseInt(b.entryName.replace(/\D/g, ""), 10);
      return numA - numB;
    });

  return slideEntries
    .map((entry) => xmlTextContent(entry.getData().toString("utf-8")))
    .filter(Boolean)
    .join("\n\n");
}

// ─── LaTeX ────────────────────────────────────────────────────────────────────

export function extractLatexText(source: string): string {
  return (
    source
      // Remove comments
      .replace(/%.*$/gm, "")
      // Remove common environments that are not prose
      .replace(/\\begin\{(?:equation|align|figure|table|lstlisting|verbatim|tabular)[^}]*\}[\s\S]*?\\end\{[^}]+\}/g, " ")
      // Remove math modes
      .replace(/\$\$[\s\S]*?\$\$/g, " ")
      .replace(/\$[^$\n]*?\$/g, " ")
      .replace(/\\[[(][\s\S]*?\\[\])]/g, " ")
      // Remove command + brace groups for known structural commands
      .replace(/\\(?:label|ref|cite|bibitem|bibliography|usepackage|documentclass|setlength|setcounter|newcommand|renewcommand|def|let)\s*(?:\[[^\]]*\])?\{[^}]*\}/g, " ")
      // Remove remaining \command{arg} — keep arg text
      .replace(/\\[a-zA-Z]+\*?\s*(?:\[[^\]]*\])?\{([^}]*)\}/g, " $1 ")
      // Remove standalone commands
      .replace(/\\[a-zA-Z]+\*?\s*/g, " ")
      // Remove leftover braces
      .replace(/[{}]/g, " ")
      // Normalise whitespace
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// ─── Code languages ───────────────────────────────────────────────────────────

export const CODE_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "cs", "go",
  "rs", "rb", "php", "swift", "kt", "scala", "sh", "bash", "r",
  "m", "lua", "pl", "sql",
]);

export function isCodeFile(fileName: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return CODE_EXTENSIONS.has(ext);
}
