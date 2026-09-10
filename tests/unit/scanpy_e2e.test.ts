import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ScanpyPlatform } from "../../backend/src/simulation/scanpy";
import type { SimulationOutputs, SimulationSpec } from "../../backend/src/simulation/models";

// W5-3 β · scanpy 的科学判据 e2e（§1.4.3 checklist 第 5 条）。
//
// **断言的是科学判据，不是「跑完没报错」。** 数据集是离线造的（tests/fixtures/scanpy/generate.py），
// 三种细胞类型各带 5 个专属 marker 基因；一条真正跑通的单细胞流水线必须把它们分开，
// 并且让每一组 marker 落在**各自那一个** cluster 的 top 表里。
// 「跑完没报错」是这条断言的必要条件，远不是充分条件。

const FIXTURES = resolve(import.meta.dir, "../fixtures/scanpy");
const COUNTS = join(FIXTURES, "counts.csv");

const OK_SPEC: SimulationSpec = {
  platform: "scanpy",
  kind: "sc-cluster",
  params: { countsPath: COUNTS, nTopGenes: 60, nPcs: 15, resolution: 0.5, minGenesPerCell: 10 },
};

const probe = await new ScanpyPlatform({ root: mkdtempSync(join(tmpdir(), "scanpy-e2e-probe-")) }).available();
if (!probe.ok) console.warn(`[W5-3 β e2e] scanpy 整套 skip：${probe.reason}`);
const suite = probe.ok ? describe : describe.skip;

async function runToCompletion(platform: ScanpyPlatform, spec: SimulationSpec): Promise<SimulationOutputs> {
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

// sim_runtime.write_csv 走 csv 模块的默认 dialect，行尾是 CRLF（pyref 的 trajectory.csv
// 也一样）——不剥掉 \r，最后一列的列名和值都会带上它，查出来永远是 undefined。
function readCsv(path: string): Array<Record<string, string>> {
  const [header, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const columns = header!.replace(/\r$/, "").split(",");
  return lines.map((line) => {
    const cells = line.replace(/\r$/, "").split(",");
    return Object.fromEntries(columns.map((name, index) => [name, cells[index] ?? ""]));
  });
}

suite("scanpy e2e · 科学判据", () => {
  const platform = new ScanpyPlatform({ root: mkdtempSync(join(tmpdir(), "scanpy-e2e-")) });
  let outputs: SimulationOutputs;

  test(
    "跑通一轮：三个 cluster，每组 marker 基因各自落在一个 cluster 的 top 表里",
    async () => {
      outputs = await runToCompletion(platform, OK_SPEC);
      expect(outputs.summary.clusters).toBe(3);
      expect(outputs.summary.cells).toBe(240);

      const markers = readCsv(outputs.files.find((f) => f.filename === "markers.csv")!.path);
      const topByCluster = new Map<string, string[]>();
      for (const row of markers) {
        if (Number(row.rank) > 5) continue;
        topByCluster.set(row.cluster!, [...(topByCluster.get(row.cluster!) ?? []), row.gene!]);
      }
      expect(topByCluster.size).toBe(3);

      // 每一组 marker 必须整组落在**同一个** cluster 的 top-5 里，且三组落在三个不同的 cluster。
      const owner = new Map<string, string>();
      for (const prefix of ["MARKA", "MARKB", "MARKG"]) {
        const hit = [...topByCluster.entries()].filter(
          ([, genes]) => genes.filter((g) => g.startsWith(prefix)).length === 5,
        );
        expect(hit.length, `${prefix}* 五个 marker 没有整组落在某一个 cluster 的 top-5 里`).toBe(1);
        owner.set(prefix, hit[0]![0]);
      }
      expect(new Set(owner.values()).size, "三组 marker 落进了同一个 cluster——聚类没把细胞分开").toBe(3);
    },
    240_000,
  );

  test("cluster 与真实细胞类型一一对应（纯度 ≥ 95%）", () => {
    const truth = new Map(
      readCsv(join(FIXTURES, "cell_labels.csv")).map((row) => [row.cell!, row.cell_type!]),
    );
    const assignment = readCsv(outputs.files.find((f) => f.filename === "clusters.csv")!.path);
    const counts = new Map<string, Map<string, number>>();
    for (const row of assignment) {
      const byType = counts.get(row.cluster!) ?? new Map<string, number>();
      const type = truth.get(row.cell!)!;
      byType.set(type, (byType.get(type) ?? 0) + 1);
      counts.set(row.cluster!, byType);
    }
    let correct = 0;
    for (const byType of counts.values()) correct += Math.max(...byType.values());
    expect(correct / assignment.length).toBeGreaterThanOrEqual(0.95);
  });

  test("产出自洽：每个细胞在 clusters.csv 与 embedding.csv 里的簇号一致", () => {
    const clusters = readCsv(outputs.files.find((f) => f.filename === "clusters.csv")!.path);
    const embedding = readCsv(outputs.files.find((f) => f.filename === "embedding.csv")!.path);
    expect(embedding.length).toBe(clusters.length);
    const byCell = new Map(clusters.map((row) => [row.cell!, row.cluster!]));
    for (const row of embedding) expect(row.cluster).toBe(byCell.get(row.cell!)!);
  });
});

// ── deterministic 位是被**实测**的，不是声明的 ────────────────────────────────
//
// `SimulationPlatform.deterministic`（models.ts:99-105）是确定性层的输入：下游据它决定
// 「重算对账」还是「区间对账」。标错方向要命——把非确定性的报成确定性，等于让一个
// 复现不出来的结论绕过重算这道约束。所以这里不信声明，直接跑两遍比字节。
suite("scanpy · deterministic 声称与实测一致", () => {
  test(
    "同一 spec 跑两遍，产出逐字节一致 ⇔ deterministic 为真",
    async () => {
      const platform = new ScanpyPlatform({ root: mkdtempSync(join(tmpdir(), "scanpy-det-")) });
      const first = await runToCompletion(platform, OK_SPEC);
      const second = await runToCompletion(platform, OK_SPEC);
      expect(second.files.map((f) => f.filename).sort()).toEqual(first.files.map((f) => f.filename).sort());

      const identical = first.files.every((file) => {
        const other = second.files.find((f) => f.filename === file.filename)!;
        return readFileSync(file.path, "utf8") === readFileSync(other.path, "utf8");
      });
      const differing = first.files
        .filter((file) => {
          const other = second.files.find((f) => f.filename === file.filename)!;
          return readFileSync(file.path, "utf8") !== readFileSync(other.path, "utf8");
        })
        .map((f) => f.filename);

      expect(
        identical,
        identical
          ? "两次产出一致，但平台声称 deterministic=false"
          : `平台声称 deterministic=${platform.deterministic}，但两次跑出的 ${differing.join(", ")} 不一致——` +
              `随机性没有被钉住（PCA solver / leiden 的 random_state / n_jobs 三处最常出事）`,
      ).toBe(platform.deterministic);
    },
    300_000,
  );
});
