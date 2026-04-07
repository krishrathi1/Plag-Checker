import path from "path";
import request from "supertest";

jest.mock("../utils/embedding", () => ({
  cosineSimilarity: () => 0,
  getEmbedding: async () => [],
}));

import { app } from "../index";

describe("api integration", () => {
  test("GET /v1/health returns healthy payload", async () => {
    const res = await request(app).get("/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("vericheck-ai");
  });

  test("POST /v1/submissions accepts a txt upload", async () => {
    const fixturePath = path.join(__dirname, "fixtures", "sample.txt");
    const res = await request(app).post("/v1/submissions").attach("file", fixturePath);
    expect(res.status).toBe(202);
    expect(typeof res.body.job_id).toBe("string");
    expect(res.body.status).toBe("queued");
  });
});
