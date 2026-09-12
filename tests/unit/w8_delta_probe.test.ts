import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoctorReport } from "../../backend/src/doctor/index.ts";
import { CobraPyPlatform } from "../../backend/src/simulation/cobrapy/index.ts";
import { SimulationSpecError } from "../../backend/src/simulation/models.ts";
import { datasetParam, probeCodeFor } from "../../backend/src/simulation/probe.ts";
import { PyDESeq2Platform } from "../../backend/src/simulation/pydeseq2/index.ts";
import { SimulationRegistry } from "../../backend/src/simulation/registry.ts";
import { ScanpyPlatform } from "../../backend/src/simulation/scanpy/index.ts";

// V51（W8-δ · lanes/W8-delta.md）：`probeCodeFor`/`datasetParam` 搬到
// `simulation/probe.ts` 顶层，scanpy/pydeseq2/cobrapy 三个平台的 import 行改指那里
// （openmm 仍是内联探测字符串——收口实测：其 runner.py 没有 probe() 入口，直接换 probeCodeFor 会让 openmm 探测恒失败（P5 契约测试整套 skip），留 V51 残余：openmm/index.ts
// 除 import 行外的其余内容不在本 lane 文件所有权内，probeCode() 方法体的替换以
// ≤10 行 diff 交收口合入，不在这里直接改）。
//
// 与 doctor 的一致性：doctor 的 science 档探测**没有**另写一份 openmm 探测逻辑，
// 它直接调用 `SimulationRegistry.get("openmm").available()`——与外部直接构造同一个
// registry 调用完全是同一条代码路径，下面第二组测试用真实失败输出核验这一点
// （不是读源码猜的，是真的跑了两遍、比对失败原因字符串）。

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("V51 · probe 归位——三平台探测代码由同一函数生成", () => {
  test("scanpy / pydeseq2 / cobrapy 的 probeCode() 都是 probeCodeFor() 的直接产物", () => {
    const root = tmpRoot("spark-w8-delta-probe-");
    const scanpy = new ScanpyPlatform({ root: join(root, "scanpy") });
    const pydeseq2 = new PyDESeq2Platform({ root: join(root, "pydeseq2") });
    const cobrapy = new CobraPyPlatform({ root: join(root, "cobrapy") });

    // probeCode()/entryPointFor() 是 protected：用下标访问，这是测试代码惯用的手段，
    // 不代表产品要开放这个方法——只是要拿到字符串做比较，不需要真的 spawn 子进程。
    const scanpyEntry = (scanpy as any).entryPointFor("sc-cluster");
    const pydeseq2Entry = (pydeseq2 as any).entryPointFor("bulk-de");
    const cobrapyEntry = (cobrapy as any).entryPointFor("fba");

    expect((scanpy as any).probeCode()).toBe(
      probeCodeFor(scanpyEntry, "scanpy", "uv pip install scanpy leidenalg igraph（进仓库 .venv，不要动系统 python）"),
    );
    expect((pydeseq2 as any).probeCode()).toBe(
      probeCodeFor(pydeseq2Entry, "pydeseq2", "uv pip install pydeseq2（进仓库 .venv，不要动系统 python）"),
    );
    expect((cobrapy as any).probeCode()).toBe(
      probeCodeFor(cobrapyEntry, "cobrapy", "uv pip install cobra（进仓库 .venv，不要动系统 python）"),
    );

    // 三份不是「恰好长得像」，是同一个生成器（probeCodeFor）在三种输入下的产物——
    // 上面三条 `.toBe()` 已经逐字符核验过；这里再确认「行数相同、控制流结构相同」
    // （import/try/spec_from_file_location/exec_module/probe()/except/raise 七个
    // 关键锚点都在同一行号），排除三条恰好长度相同但内部顺序不同的巧合。
    const skeleton = (code: string) =>
      code
        .split("\n")
        .map((line) => line.trimStart().split(/[\s"'(]/)[0]); // 每行只取开头的关键字/token
    expect(skeleton((scanpy as any).probeCode())).toEqual(skeleton((pydeseq2 as any).probeCode()));
    expect(skeleton((pydeseq2 as any).probeCode())).toEqual(skeleton((cobrapy as any).probeCode()));
  });

  test("datasetParam 搬家后行为不变：必填 / 扩展名 / 文件存在性三条校验都还在", () => {
    const dir = tmpRoot("spark-w8-delta-dataset-");
    const csv = join(dir, "counts.csv");
    writeFileSync(csv, "a,b\n1,2\n");

    expect(() => datasetParam({}, "countsPath", [".csv"])).toThrow(SimulationSpecError);
    expect(() => datasetParam({ countsPath: csv }, "countsPath", [".xlsx"])).toThrow(SimulationSpecError);
    expect(() => datasetParam({ countsPath: join(dir, "missing.csv") }, "countsPath", [".csv"])).toThrow(
      SimulationSpecError,
    );
    expect(datasetParam({ countsPath: csv }, "countsPath", [".csv"])).toBe(csv);
  });
});

describe("V51 · doctor 探测与平台探测字符串相等", () => {
  // 与 doctor.test.ts 同一个选择：系统自带 python3 没装 openmm，是天然的「缺依赖」
  // 环境，两条路径跑出来的失败原因字符串如果不一样，说明其中一条在悄悄执行不同的
  // 探测逻辑——这正是 V51 要根治的「探测代码与真提交代码不同源」的 doctor 版本。
  const SYSTEM_PYTHON = "/usr/bin/python3";

  test("doctor science 档的失败原因 与 直接构造 SimulationRegistry.get('openmm').available() 的失败原因逐字相同", async () => {
    if (!existsSync(SYSTEM_PYTHON)) {
      // 极少数环境没有系统 python3（比如某些容器基础镜像）：这条环境假设不成立时
      // 明确跳过而不是伪造一个绿——见 _COMMON.md「没跑的不许写已验证」。
      console.warn("跳过：本机没有 /usr/bin/python3，无法做天然缺依赖环境的对照");
      return;
    }
    const root = tmpRoot("spark-w8-delta-doctor-probe-");

    const direct = await new SimulationRegistry({ root, python: SYSTEM_PYTHON }).get("openmm").available();
    expect(direct.ok).toBe(false); // 系统 python3 没装 openmm，前提要成立，否则下面的比较没有意义

    const report = await buildDoctorReport({
      root: tmpRoot("spark-w8-delta-doctor-cfg-"),
      env: {},
      python: SYSTEM_PYTHON,
      simulationRoot: root, // 与 direct 用同一个 simulationRoot，确保 entryPoint 路径也一致
      probeLab: async () => ({ ok: true, reason: null }), // 与本测试无关的两档注入假实现，保持测试聚焦
      probeSegmenter: async () => ({ ok: true, reason: null }),
      frontendDir: tmpRoot("spark-w8-delta-doctor-fe-"),
    });
    const science = report.tiers.find((t) => t.id === "science")!;
    expect(science.available).toBe(false);
    // doctor 的 reason 经过 describeTierReason() 包装，但那只在命中 V27 的
    // `/$bunfs/` 打包限制时才会改写文案；系统 python3 缺依赖走的是普通探测失败路径，
    // 包装前后文本不变，所以这里可以直接逐字比较。
    expect(direct.reason).not.toBeNull();
    expect(science.reason).toBe(direct.reason);
  });
});
