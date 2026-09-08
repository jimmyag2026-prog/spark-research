import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AMinerConnector } from "../../backend/src/connectors/aminer";
import { CredentialStore } from "../../backend/src/daemon/credentials";
import { fixtureModeFromEnv } from "../../backend/src/http/fixture";
import { LibraryStore, paperFrom } from "../../backend/src/literature/library";
import { PdfDownloader } from "../../backend/src/literature/pdf";
import { ProjectManager } from "../../backend/src/project/manager";
import {
  ADD_DOI,
  ARXIV_SAMPLE,
  CASSETTES,
  EUROPEPMC_SAMPLE,
  PER_SOURCE,
  SEARCH_QUERY,
  SEARCH_SOURCES,
  fixtureHttp,
  searcherWith,
} from "../helpers/literature_scenario";

// 真实网络验证 + fixture 录制（DEVELOPMENT_PLAN 三、「e2e 真实：本地验证 + 录制 fixture」）。
//
//   本地录制：FIXTURE_MODE=record bun test tests/integration/literature_record.test.ts
//   平时（含 CI）：默认 replay 模式 → 整个套件跳过（回放版在 tests/unit/literature_e2e.test.ts）
//
// 这个文件**不在** `bun test tests/unit` 的范围内，不影响单测基线。

const MODE = fixtureModeFromEnv();
const RECORDING = MODE === "record" || MODE === "live";

describe.skipIf(!RECORDING)("真实网络 · 录制 fixture", () => {
  test(
    "跨源检索四个免 key 源",
    async () => {
      const result = await searcherWith(CASSETTES.search, MODE).search(SEARCH_QUERY, {
        sources: SEARCH_SOURCES,
        perSource: PER_SOURCE,
      });
      console.log(`\n[record] 检索 "${SEARCH_QUERY}"`);
      for (const status of result.sources) {
        console.log(
          `  ${status.source.padEnd(16)} ${status.outcome.padEnd(8)} ${status.count} 条 ` +
            `${status.elapsedMs}ms ${status.error ?? status.note ?? ""}`,
        );
      }
      console.log(`  合并后 ${result.papers.length} 条（原始 ${result.totalBeforeDedupe}，合并掉 ${result.mergedCount}）`);
      // 至少要有一个源真的返回了东西，否则录出来的 fixture 没有意义。
      expect(result.sources.some((s) => s.outcome === "ok" && s.count > 0)).toBe(true);
    },
    120_000,
  );

  test(
    "按 DOI 取单篇",
    async () => {
      const result = await searcherWith(CASSETTES.fetchById, MODE).fetchById(ADD_DOI, {
        sources: SEARCH_SOURCES,
      });
      console.log(`\n[record] fetchById ${ADD_DOI}`);
      for (const status of result.sources) {
        console.log(`  ${status.source.padEnd(16)} ${status.outcome.padEnd(8)} ${status.count} 条 ${status.error ?? status.note ?? ""}`);
      }
      expect(result.papers.length).toBeGreaterThan(0);
    },
    120_000,
  );

  test(
    "真实下载两篇 OA PDF（arXiv + Europe PMC）",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "spark-record-"));
      try {
        const project = new ProjectManager(tmp).create("record", {});
        const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
        const arxiv = library.add(
          paperFrom({
            title: ARXIV_SAMPLE.title,
            authors: [{ name: ARXIV_SAMPLE.author }],
            year: ARXIV_SAMPLE.year,
            ids: { arxiv: ARXIV_SAMPLE.arxivId },
          }),
        ).paper;
        const pmc = library.add(
          paperFrom({
            title: EUROPEPMC_SAMPLE.title,
            authors: [{ name: EUROPEPMC_SAMPLE.author }],
            year: EUROPEPMC_SAMPLE.year,
            ids: { pmcid: EUROPEPMC_SAMPLE.pmcid },
            isOpenAccess: true,
          }),
        ).paper;

        const downloader = new PdfDownloader({
          http: fixtureHttp(CASSETTES.pdf, MODE),
          papersDir: project.paths.papersDir,
          library,
        });
        const results = await downloader.downloadMany([arxiv.id, pmc.id]);
        console.log("\n[record] PDF 下载");
        for (const r of results) {
          console.log(
            `  ${r.ok ? "✅" : "❌"} ${r.ok ? `${r.origin} ${r.bytes} 字节 ${r.checksum}` : `${r.reason}: ${r.message}`}`,
          );
          for (const attempt of r.attempts) console.log(`      试 ${attempt.url} → ${attempt.status} ${attempt.outcome}`);
        }
        library.close();
        project.close();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    180_000,
  );

  // AMiner 连通性验证。凭据由 CredentialStore 从本机 ~/.spark-research/credentials.json 读取，
  // 全程不打印、不落盘：FixtureHttp 结构上不持久化任何请求头（见 tests/unit/literature.test.ts 的断言）。
  test(
    "AMiner 连通性（有 key 时打真实请求，无 key 时验证降级）",
    async () => {
      const credentials = new CredentialStore();
      const connector = new AMinerConnector({
        credentials,
        http: fixtureHttp(CASSETTES.aminer, MODE),
      });
      if (!connector.isConfigured()) {
        console.log("\n[record] AMiner: 未配置凭据 → 验证降级路径");
        const result = await connector.search({ query: SEARCH_QUERY });
        expect((result as { reason?: string }).reason).toBe("credentials_missing");
        return;
      }
      console.log("\n[record] AMiner: 凭据已配置，发起真实请求");
      try {
        const payload = await connector.search({ query: "AlphaFold", size: 3 });
        const code = (payload as { code?: unknown })?.code;
        console.log(`  ✅ HTTP 200 · 业务 code=${JSON.stringify(code)}`);
        // 只打印结构轮廓，不打印内容，也不打印任何请求头。
        console.log(`  顶层字段: ${Object.keys(payload as object).join(", ")}`);
        expect(payload).toBeDefined();
      } catch (error) {
        // 失败也要如实记录状态码（错误消息由 connector 构造，只含 HTTP 码）。
        console.log(`  ❌ ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
    120_000,
  );
});
