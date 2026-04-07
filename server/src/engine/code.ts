/**
 * Code Plagiarism Engine — AST-level structural comparison (FR-014).
 *
 * Strategy:
 *  1. Normalise: strip comments, collapse whitespace, lowercase identifiers,
 *     replace string/number literals with placeholders.
 *  2. Tokenise into language-aware tokens (keywords + structural symbols).
 *  3. Apply winnowing fingerprinting on the token stream.
 *  4. Return similarity score and matched source attribution.
 *
 * Supported languages: all CODE_EXTENSIONS from extract.ts
 */

import { CorpusDoc, SourceMatch } from "../types";
import { winnowingSimilarity } from "../utils/winnowing";

// ─── Normalisation ────────────────────────────────────────────────────────────

function stripLineComments(code: string): string {
  return code.replace(/\/\/[^\n]*/g, " ").replace(/#[^\n]*/g, " ");
}

function stripBlockComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ");
}

function stripDocstrings(code: string): string {
  // Python triple-quoted strings used as docstrings
  return code.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, " ");
}

function replaceLiterals(code: string): string {
  return code
    .replace(/"(?:[^"\\]|\\.)*"/g, '"STR"')
    .replace(/'(?:[^'\\]|\\.)*'/g, "'STR'")
    .replace(/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, "NUM");
}

/**
 * Normalise identifier names to a placeholder so renamed-variable plagiarism
 * is still detected. We keep language keywords and structural tokens.
 */
const KEYWORDS = new Set([
  // JS/TS
  "function","const","let","var","return","if","else","for","while","do",
  "switch","case","break","continue","new","this","class","extends","import",
  "export","default","async","await","try","catch","finally","throw","typeof",
  "instanceof","in","of","void","null","undefined","true","false","=>","...","?.",
  // Python
  "def","lambda","with","as","pass","yield","from","global","nonlocal","assert",
  "del","raise","except","elif","not","and","or","is","None","True","False",
  // Java/C#/Go/Rust common
  "public","private","protected","static","void","int","string","bool","float",
  "double","long","short","byte","char","interface","enum","struct","type",
  "package","namespace","using","include","fn","mut","let","impl","trait","mod",
  "func","go","defer","chan","map","select","range","make","append",
]);

function normaliseIdentifiers(tokens: string[]): string[] {
  return tokens.map((t) => (KEYWORDS.has(t) || /^[{}\[\]();,.:=<>!+\-*/%&|^~?]/.test(t) ? t : "ID"));
}

function codeTokenise(code: string): string[] {
  // Split on whitespace and keep structural tokens
  return code
    .split(/[\s\n\r\t]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function normaliseCode(code: string): string[] {
  let s = code;
  s = stripBlockComments(s);
  s = stripDocstrings(s);
  s = stripLineComments(s);
  s = replaceLiterals(s);
  const tokens = codeTokenise(s);
  return normaliseIdentifiers(tokens);
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

export interface CodeSimilarityResult {
  score: number;
  sources: SourceMatch[];
}

export function scoreCodeSimilarity(
  codeText: string,
  corpus: CorpusDoc[],
): CodeSimilarityResult {
  const queryTokens = normaliseCode(codeText);
  if (queryTokens.length < 10 || !corpus.length) {
    return { score: 0, sources: [] };
  }

  const ranked = corpus
    .map((doc) => {
      const srcTokens = normaliseCode(doc.content);
      const score = winnowingSimilarity(queryTokens, srcTokens);
      return { doc, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .filter((item) => item.score >= 0.1);

  const topScore = ranked[0]?.score ?? 0;

  const sources: SourceMatch[] = ranked.map((item) => ({
    title: item.doc.title,
    url: item.doc.url,
    match_percentage: Number((item.score * 100).toFixed(2)),
    access_date: new Date().toISOString().slice(0, 10),
  }));

  return { score: topScore, sources };
}
