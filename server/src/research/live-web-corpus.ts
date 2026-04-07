import { createHash, randomUUID } from "crypto";
import { CorpusDoc } from "../types";
import { splitSentences, tokenize } from "../utils/text";

interface OpenAlexWork {
  id?: string;
  title?: string;
  doi?: string;
  abstract_inverted_index?: Record<string, number[]>;
}

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  abstract?: string;
}

interface WikiSearchItem {
  title: string;
}

interface LiveCacheEntry {
  expiresAt: number;
  docs: CorpusDoc[];
}

const queryCache = new Map<string, LiveCacheEntry>();
const LIVE_CACHE_TTL_MS = Number(process.env.LIVE_WEB_CACHE_TTL_MS ?? 86_400_000);

function hashSentence(sentence: string): string {
  return createHash("sha1").update(sentence).digest("hex").slice(0, 8);
}

function pickQueries(text: string, max = 5): string[] {
  const candidates = splitSentences(text)
    .map((s) => s.trim())
    .filter((s) => s.length >= 70 && s.length <= 260)
    .filter((s) => tokenize(s).length >= 12);

  const ranked = candidates
    .map((sentence) => {
      const tokens = tokenize(sentence);
      const uniqueRatio = new Set(tokens).size / Math.max(1, tokens.length);
      const digitPenalty = (sentence.match(/\d/g) ?? []).length / Math.max(1, sentence.length);
      const score = uniqueRatio - digitPenalty;
      return { sentence, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, max);

  return ranked.map((r) => r.sentence);
}

function rebuildOpenAlexAbstract(idx?: Record<string, number[]>): string {
  if (!idx) return "";
  let maxPos = 0;
  for (const positions of Object.values(idx)) {
    for (const p of positions) maxPos = Math.max(maxPos, p);
  }
  const arr = new Array<string>(maxPos + 1).fill("");
  for (const [word, positions] of Object.entries(idx)) {
    for (const p of positions) arr[p] = word;
  }
  return arr.join(" ").trim();
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function safeJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "VeriCheck-AI/3.1 (research-source-expansion)",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

async function fetchFromOpenAlex(query: string, orgId: string): Promise<CorpusDoc[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=3`;
  const data = (await safeJson(url)) as { results?: OpenAlexWork[] } | null;
  const results = data?.results ?? [];
  return results
    .map((work) => {
      const abstract = rebuildOpenAlexAbstract(work.abstract_inverted_index);
      const title = work.title?.trim() || "OpenAlex result";
      const content = `${title}. ${abstract}`.trim();
      if (!content || content.length < 80) return null;
      return {
        id: randomUUID(),
        org_id: orgId,
        title,
        url: work.doi ? `https://doi.org/${work.doi}` : work.id ?? "https://openalex.org",
        content,
        created_at: new Date().toISOString(),
      } satisfies CorpusDoc;
    })
    .filter(Boolean) as CorpusDoc[];
}

async function fetchFromCrossref(query: string, orgId: string): Promise<CorpusDoc[]> {
  const url = `https://api.crossref.org/works?rows=3&query.bibliographic=${encodeURIComponent(query)}`;
  const data = (await safeJson(url)) as { message?: { items?: CrossrefItem[] } } | null;
  const items = data?.message?.items ?? [];
  return items
    .map((item) => {
      const title = item.title?.[0]?.trim() || "Crossref result";
      const abstract = stripTags(item.abstract ?? "");
      const content = `${title}. ${abstract}`.trim();
      if (!content || content.length < 80) return null;
      return {
        id: randomUUID(),
        org_id: orgId,
        title,
        url: item.DOI ? `https://doi.org/${item.DOI}` : "https://api.crossref.org",
        content,
        created_at: new Date().toISOString(),
      } satisfies CorpusDoc;
    })
    .filter(Boolean) as CorpusDoc[];
}

async function fetchFromWikipedia(query: string, orgId: string): Promise<CorpusDoc[]> {
  const searchUrl =
    `https://en.wikipedia.org/w/api.php?action=query&list=search&utf8=1&format=json&srlimit=2&srsearch=${encodeURIComponent(query)}`;
  const data = (await safeJson(searchUrl)) as { query?: { search?: WikiSearchItem[] } } | null;
  const items = data?.query?.search ?? [];
  const docs: CorpusDoc[] = [];
  for (const item of items) {
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(item.title)}`;
    const summary = (await safeJson(summaryUrl)) as { extract?: string; content_urls?: { desktop?: { page?: string } } } | null;
    const extract = summary?.extract?.trim() ?? "";
    if (extract.length < 80) continue;
    docs.push({
      id: randomUUID(),
      org_id: orgId,
      title: item.title,
      url: summary?.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title)}`,
      content: `${item.title}. ${extract}`,
      created_at: new Date().toISOString(),
    });
  }
  return docs;
}

export async function buildLiveWebCorpus(text: string, orgId: string): Promise<CorpusDoc[]> {
  if ((process.env.ENABLE_LIVE_WEB_CORPUS ?? "false").toLowerCase() === "false") return [];

  const queries = pickQueries(text, Number(process.env.LIVE_WEB_QUERY_COUNT ?? 4));
  if (!queries.length) return [];

  const collected: CorpusDoc[] = [];
  const now = Date.now();
  for (const sentence of queries) {
    const query = sentence.slice(0, 180).trim();
    const cacheKey = createHash("sha1").update(query.toLowerCase()).digest("hex");
    const cached = queryCache.get(cacheKey);
    let docs: CorpusDoc[];
    if (cached && cached.expiresAt > now) {
      docs = cached.docs;
    } else {
      const [oa, cr, wk] = await Promise.all([
        fetchFromOpenAlex(query, orgId),
        fetchFromCrossref(query, orgId),
        fetchFromWikipedia(query, orgId),
      ]);
      docs = [...oa, ...cr, ...wk];
      queryCache.set(cacheKey, { docs, expiresAt: now + LIVE_CACHE_TTL_MS });
    }
    for (const doc of docs) {
      collected.push({ ...doc, id: `${doc.id}-${cacheKey}` });
    }
  }

  const dedup = new Map<string, CorpusDoc>();
  for (const doc of collected) {
    const key = `${doc.title.toLowerCase()}|${doc.url.toLowerCase()}`;
    if (!dedup.has(key)) dedup.set(key, doc);
  }
  return [...dedup.values()].slice(0, Number(process.env.LIVE_WEB_DOC_LIMIT ?? 40));
}