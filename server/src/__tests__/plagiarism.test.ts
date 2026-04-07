import { buildCorpusIndex, scoreSentenceSimilarity } from "../engine/plagiarism";
import { CorpusDoc } from "../types";

jest.mock("../utils/embedding", () => ({
  cosineSimilarity: () => 0,
  getEmbedding: async () => [],
}));

function makeDoc(id: string, content: string): CorpusDoc {
  return {
    id,
    org_id: "default-org",
    title: `Doc ${id}`,
    url: `https://example.com/${id}`,
    content,
    created_at: new Date().toISOString(),
  };
}

describe("plagiarism engine", () => {
  test("finds a strong exact/near-exact match with candidate pruning enabled", async () => {
    const docs: CorpusDoc[] = [];
    for (let i = 0; i < 250; i++) {
      docs.push(makeDoc(`noise-${i}`, `filler content block number ${i} unrelated academic material`));
    }
    docs.push(
      makeDoc(
        "target",
        "Neural networks require large datasets for training and careful regularization to avoid overfitting in practical deployments.",
      ),
    );

    const index = await buildCorpusIndex(docs);
    const result = await scoreSentenceSimilarity(
      "Neural networks require large datasets for training and careful regularization to avoid overfitting in practical deployments.",
      index,
    );

    expect(result.score).toBeGreaterThan(0.7);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0].title).toContain("target");
  });
});
