import { buildCorpusIndex, scoreSentenceSimilarity } from "../engine/plagiarism";
import { CorpusDoc } from "../types";

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
  test("finds a strong exact/near-exact match with candidate pruning enabled", () => {
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

    const index = buildCorpusIndex(docs);
    const result = scoreSentenceSimilarity(
      "Neural networks require large datasets for training and careful regularization to avoid overfitting in practical deployments.",
      index,
    );

    expect(result.score).toBeGreaterThan(0.7);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0].title).toContain("target");
  });
});
