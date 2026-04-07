import { clamp } from "../utils/text";

export interface ExternalAIScore {
  probability: number;
  label: string;
}

export async function scoreExternalAIDetector(text: string): Promise<ExternalAIScore | null> {
  const url = process.env.AI_DETECTOR_URL;
  if (!url) return null;

  try {
    const isGptZero = url.toLowerCase().includes("gptzero");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (process.env.AI_DETECTOR_API_KEY) {
      if (isGptZero) {
        headers["x-api-key"] = process.env.AI_DETECTOR_API_KEY;
      } else {
        headers["Authorization"] = `Bearer ${process.env.AI_DETECTOR_API_KEY}`;
      }
    }

    const payload = isGptZero
      ? { document: text.slice(0, Number(process.env.AI_DETECTOR_MAX_CHARS ?? 16000)) }
      : { text: text.slice(0, Number(process.env.AI_DETECTOR_MAX_CHARS ?? 16000)) };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(process.env.AI_DETECTOR_TIMEOUT_MS ?? 10000)),
    });
    
    if (!res.ok) return null;
    const bodyP = (await res.json()) as any;
    
    let raw: number | undefined;
    let label = "external-ai-detector";
    
    if (isGptZero) {
      raw = bodyP.documents?.[0]?.completely_generated_prob;
      label = "gptzero";
    } else {
      raw = bodyP.probability ?? bodyP.score;
      label = bodyP.label ?? "binoculars";
    }
    
    if (typeof raw !== "number" || Number.isNaN(raw)) return null;
    return {
      probability: Number(clamp(raw).toFixed(4)),
      label,
    };
  } catch {
    return null;
  }
}
