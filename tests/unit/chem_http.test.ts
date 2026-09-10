import { describe, expect, test } from "bun:test";
import { makeServer } from "../helpers/server_scenario";

// C5-②（v0.5 W5-1-c）：`POST /api/chem/depict` 的 HTTP 单测（depict.ts 的 HTTP 投影）。
// 风格与 server_proteins.test.ts 一致：零 fixture（chem 不是网络 connector，本地
// rdkit 子进程真跑，秒级）。

interface DepictResponse {
  project: string;
  result: {
    svg: string;
    canonicalSmiles: string;
    formula: string;
    molWeight: number;
    rdkitVersion: string;
    artifactId: string;
    recordId: string;
  };
}

describe("HTTP · chem/depict", () => {
  test("POST /api/chem/depict 返回 SVG + 落 artifact/record", async () => {
    const fx = makeServer({ slug: "chem-http" });
    try {
      const res = await fx.post<DepictResponse>("/api/chem/depict", { smiles: "CCO", name: "ethanol" });
      expect(res.status).toBe(200);
      expect(res.body.result.svg.startsWith("<svg")).toBe(true);
      expect(res.body.result.canonicalSmiles).toBe("CCO");
      expect(res.body.result.formula).toBe("C2H6O");
      expect(res.body.result.artifactId).toBeTruthy();
      expect(res.body.result.recordId).toBeTruthy();

      const artifactRes = await fx.get<{ artifact: { contentType: string; filename: string } }>(
        `/api/artifacts/version/${res.body.result.artifactId}`,
      );
      expect(artifactRes.status).toBe(200);
      expect(artifactRes.body.artifact.contentType).toBe("image/svg+xml");
      expect(artifactRes.body.artifact.filename).toBe("ethanol.svg");
    } finally {
      await fx.stop();
    }
  });

  test("缺 smiles → 400（不是 500）", async () => {
    const fx = makeServer({ slug: "chem-http" });
    try {
      const res = await fx.post<{ error: string }>("/api/chem/depict", {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("smiles");
    } finally {
      await fx.stop();
    }
  });

  test("非法 SMILES → 422（调用方的错，不是服务端故障），且不落 artifact", async () => {
    const fx = makeServer({ slug: "chem-http" });
    try {
      const before = await fx.get<{ artifacts: unknown[] }>("/api/artifacts");
      const res = await fx.post<{ error: string; detail: { kind: string } }>("/api/chem/depict", {
        smiles: "not a smiles(((",
      });
      expect(res.status).toBe(422);
      expect(res.body.detail.kind).toBe("invalid_smiles");

      const after = await fx.get<{ artifacts: unknown[] }>("/api/artifacts");
      expect(after.body.artifacts.length).toBe(before.body.artifacts.length);
    } finally {
      await fx.stop();
    }
  });
});
