import { describe, expect, test } from "bun:test";
import { makeServer } from "../helpers/server_scenario";
import { PROTEIN_ACCESSION, PROTEIN_QUERY, proteinRegistry } from "../helpers/protein_scenario";
import type { ConnectorRegistry } from "../../backend/src/connectors/registry";

// R-d-2（v0.4 P11 lane R-d）：`POST /api/proteins/analyze` 的 HTTP 单测（P5 分析链路的
// HTTP 投影）。风格与 server_experiments.test.ts / server_lab.test.ts 一致：fixture 回放
// connectors，零真实网络。

interface AnalyzeResponse {
  project: string;
  result: {
    query: string;
    identity: { accession: string; entryName: string };
    experimentalStructureCount: number;
    structures: Array<{ pdbId: string }>;
    alphafold: { available: boolean; meanPlddt: number | null };
    recordId: string | null;
  };
}

describe("HTTP · proteins/analyze", () => {
  test("POST /api/proteins/analyze 返回身份 + 结构 + AlphaFold，并落 observation record", async () => {
    const fx = makeServer({ connectors: proteinRegistry("replay") });
    try {
      const res = await fx.post<AnalyzeResponse>("/api/proteins/analyze", { query: PROTEIN_QUERY });
      expect(res.status).toBe(200);
      expect(res.body.result.identity.accession).toBe(PROTEIN_ACCESSION);
      expect(res.body.result.experimentalStructureCount).toBe(350);
      expect(res.body.result.alphafold.available).toBe(true);
      expect(res.body.result.recordId).toBeTruthy();
    } finally {
      await fx.stop();
    }
  });

  test("{persist: false} 不落 record（recordId 为 null）", async () => {
    const fx = makeServer({ connectors: proteinRegistry("replay") });
    try {
      const res = await fx.post<AnalyzeResponse>("/api/proteins/analyze", {
        query: PROTEIN_QUERY,
        persist: false,
      });
      expect(res.status).toBe(200);
      expect(res.body.result.recordId).toBeNull();
    } finally {
      await fx.stop();
    }
  });

  test("缺 query → 400（不是 500）", async () => {
    const fx = makeServer({ connectors: proteinRegistry("replay") });
    try {
      const res = await fx.post<{ error: string }>("/api/proteins/analyze", {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("query");
    } finally {
      await fx.stop();
    }
  });

  test("UniProt 没有唯一匹配 → 422（调用方的错，不是服务端故障）", async () => {
    const emptyRegistry = { call: async () => ({ results: [] }) } as unknown as ConnectorRegistry;
    const fx = makeServer({ connectors: emptyRegistry });
    try {
      const res = await fx.post<{ error: string }>("/api/proteins/analyze", { query: "matches nothing" });
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("没有匹配");
    } finally {
      await fx.stop();
    }
  });
});
