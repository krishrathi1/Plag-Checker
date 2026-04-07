import { CorpusDoc } from "./types";

export const seedCorpus: CorpusDoc[] = [
  {
    id: "seed-1",
    org_id: "global",
    title: "Academic Integrity Handbook",
    url: "https://example.org/academic-integrity",
    created_at: new Date().toISOString(),
    content:
      "Academic integrity is the commitment to honesty, trust, fairness, respect, and responsibility in scholarly work. Plagiarism includes copying exact phrases, close paraphrases, and unattributed ideas from external sources.",
  },
  {
    id: "seed-2",
    org_id: "global",
    title: "Responsible AI in Education",
    url: "https://example.org/responsible-ai-education",
    created_at: new Date().toISOString(),
    content:
      "Large language models can support learning, but institutions should enforce transparent disclosure and source attribution. AI-generated text often shows low entropy and regular sentence cadence.",
  },
  {
    id: "seed-3",
    org_id: "global",
    title: "Research Writing Standards",
    url: "https://example.org/research-writing-standards",
    created_at: new Date().toISOString(),
    content:
      "Strong research writing cites prior work, compares evidence, and communicates uncertainty precisely. Proper citation style can follow APA, MLA, Chicago, or IEEE formats depending on discipline.",
  },
];
