import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PyDESeq2Platform } from "../../backend/src/simulation/pydeseq2";
import type { SimulationOutputs, SimulationSpec } from "../../backend/src/simulation/models";

// W5-3 β · pydeseq2 的科学判据 e2e（§1.4.3 checklist 第 5 条）。
//
// 数据集是离线造的（tests/fixtures/pydeseq2/generate.py）：300 个基因里 15 个被人为
// 上调 5 倍（UP*）、15 个下调 5 倍（DOWN*），其余 270 个是噪声。
// **判据是「已知差异基因的方向对不对」**，外加一条对称的：噪声基因不许被大批判成显著
//（只测灵敏度不测特异性的差异分析，把阈值放宽就能「全中」）。

const FIXTURES = resolve(import.meta.dir, "../fixtures/pydeseq2");
const COUNTS = join(FIXTURES, "counts.csv");
const METADATA = join(FIXTURES, "metadata.csv");

const OK_SPEC: SimulationSpec = {
  platform: "pydeseq2",
  kind: "bulk-de",
  params: {
    countsPath: COUNTS,
    metadataPath: METADATA,
    designFactor: "condition",
    testLevel: "treated",
    referenceLevel: "control",
  },
};

const probe = await new PyDESeq2Platform({
  root: mkdtempSync(join(tmpdir(), "pydeseq2-e2e-probe-")),
}).available();
if (!probe.ok) console.warn(`[W5-3 β e2e] pydeseq2 整套 skip：${probe.reason}`);
const suite = probe.ok ? describe : describe.skip;

async function runToCompletion(platform: PyDESeq2Platform, spec: SimulationSpec): Promise<SimulationOutputs> {
  const runId = await platform.submit(await platform.prepare(spec));
  const deadline = Date.now() + 180_000;
  for (;;) {
    const status = await platform.poll(runId);
    if (status.state === "completed") break;
    if (status.state === "failed") throw new Error(`run 失败：${status.message}`);
    if (Date.now() > deadline) throw new Error("等待超时");
    await Bun.sleep(200);
  }
  return platform.collect(runId);
}

// 行尾是 CRLF（csv 模块的默认 dialect），不剥掉 \r 最后一列永远查不到。
function readCsv(path: string): Array<Record<string, string>> {
  const [header, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const columns = header!.replace(/\r$/, "").split(",");
  return lines.map((line) => {
    const cells = line.replace(/\r$/, "").split(",");
    return Object.fromEntries(columns.map((name, index) => [name, cells[index] ?? ""]));
  });
}

suite("pydeseq2 e2e · 科学判据", () => {
  const platform = new PyDESeq2Platform({ root: mkdtempSync(join(tmpdir(), "pydeseq2-e2e-")) });
  let outputs: SimulationOutputs;
  let results: Array<Record<string, string>>;

  test(
    "跑通一轮：15 个 spike-in 上调基因全部显著且方向为正",
    async () => {
      outputs = await runToCompletion(platform, OK_SPEC);
      results = readCsv(outputs.files.find((f) => f.filename === "results.csv")!.path);
      expect(results.length).toBe(300);
      expect(outputs.summary.samples).toBe(12);
      expect(outputs.summary.contrast).toBe("condition: treated vs control");

      const up = results.filter((row) => row.gene!.startsWith("UP"));
      expect(up.length).toBe(15);
      for (const row of up) {
        expect(Number(row.padj), `${row.gene} 的 padj`).toBeLessThan(0.05);
        // 造数据时上调 5 倍 → log2FC 应当在 log2(5)=2.32 附近；给一档余量防过拟合断言。
        expect(Number(row.log2FoldChange), `${row.gene} 的 log2FC`).toBeGreaterThan(1);
      }
    },
    240_000,
  );

  test("15 个 spike-in 下调基因全部显著且方向为负", () => {
    const down = results.filter((row) => row.gene!.startsWith("DOWN"));
    expect(down.length).toBe(15);
    for (const row of down) {
      expect(Number(row.padj), `${row.gene} 的 padj`).toBeLessThan(0.05);
      expect(Number(row.log2FoldChange), `${row.gene} 的 log2FC`).toBeLessThan(-1);
    }
  });

  test("噪声基因不许被大批判成显著（特异性，不只是灵敏度）", () => {
    const noise = results.filter((row) => row.gene!.startsWith("NOISE"));
    expect(noise.length).toBe(270);
    const falsePositives = noise.filter((row) => row.padj !== "" && Number(row.padj) < 0.05);
    expect(falsePositives.length / noise.length).toBeLessThan(0.05);
  });

  test("size factor：每个样本一条，且都是正数（否则归一化是错的）", () => {
    const factors = readCsv(outputs.files.find((f) => f.filename === "size_factors.csv")!.path);
    expect(factors.length).toBe(12);
    expect(new Set(factors.map((row) => row.condition)).size).toBe(2);
    for (const row of factors) expect(Number(row.sizeFactor)).toBeGreaterThan(0);
  });
});

// deterministic 位是实测出来的，不是声明的——理由见 scanpy_e2e.test.ts 同名 describe。
suite("pydeseq2 · deterministic 声称与实测一致", () => {
  test(
    "同一 spec 跑两遍，产出逐字节一致 ⇔ deterministic 为真",
    async () => {
      const platform = new PyDESeq2Platform({ root: mkdtempSync(join(tmpdir(), "pydeseq2-det-")) });
      const first = await runToCompletion(platform, OK_SPEC);
      const second = await runToCompletion(platform, OK_SPEC);
      const differing = first.files
        .filter((file) => {
          const other = second.files.find((f) => f.filename === file.filename)!;
          return readFileSync(file.path, "utf8") !== readFileSync(other.path, "utf8");
        })
        .map((f) => f.filename);
      expect(
        differing.length === 0,
        differing.length === 0
          ? "两次产出一致，但平台声称 deterministic=false"
          : `平台声称 deterministic=${platform.deterministic}，但两次跑出的 ${differing.join(", ")} 不一致` +
              `（DefaultInference 的 n_cpus 是最常见的那处随机性来源）`,
      ).toBe(platform.deterministic);
    },
    300_000,
  );
});
