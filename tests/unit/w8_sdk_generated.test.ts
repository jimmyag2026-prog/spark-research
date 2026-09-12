import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getContract, renderGeneratedPy, renderTypesPy } from "../../scripts/gen-sdk-python";

// W8-2 SDK lane · 幂等门禁（同 tests/unit/llms_txt.test.ts 的形状）。
//
// `sdk/python/spark_research/_generated.py` / `_types.py` 是从
// `spark-research contract --json` 生成的，不手写。这组测试钉住两件事：
//   1. 重新生成两次逐字节相同（没有时间戳/遍历序抖动）。
//   2. 生成物与仓库里已提交的文件一致（契约变了却忘了 `bun run gen:sdk` → 这里红）。
//   3. 契约的 HTTP 路由数 == 生成的方法数（一条路由一个方法，不多不少）。
//
// 阴性对照（真跑，见 docs/devlog/W8-sdk.md）：手改过一次已提交的 `_generated.py`
// （删掉一个方法）单独验证过这里会红；跑完 `bun run gen:sdk` 复原后回到绿。

const REPO_ROOT = join(import.meta.dir, "../..");

describe("W8-2 SDK · 生成器幂等 + 路由数对撞", () => {
  test("同一份契约连续渲染两次逐字节相同", () => {
    const contract = getContract();
    expect(renderGeneratedPy(contract)).toBe(renderGeneratedPy(contract));
    expect(renderTypesPy(contract)).toBe(renderTypesPy(contract));
  });

  test("生成物与仓库里已提交的文件一致（契约变了要重新生成）", () => {
    const contract = getContract();
    const generated = renderGeneratedPy(contract);
    const types = renderTypesPy(contract);

    const committedGenerated = readFileSync(join(REPO_ROOT, "sdk/python/spark_research/_generated.py"), "utf8");
    const committedTypes = readFileSync(join(REPO_ROOT, "sdk/python/spark_research/_types.py"), "utf8");

    expect(generated, "sdk/python/spark_research/_generated.py 与契约不一致——跑 `bun run gen:sdk`").toBe(
      committedGenerated,
    );
    expect(types, "sdk/python/spark_research/_types.py 与契约不一致——跑 `bun run gen:sdk`").toBe(committedTypes);
  });

  test("契约 HTTP 路由数 == 生成方法数", () => {
    const contract = getContract();
    const generated = renderGeneratedPy(contract);
    // GeneratedClient 里除 `request` 外的每个 `def xxx(` 都是一条路由投影出来的方法。
    const methodCount = [...generated.matchAll(/^    def (\w+)\(/gm)].filter((m) => m[1] !== "request").length;
    expect(methodCount).toBe(contract.http.routes.length);
    expect(contract.http.routes.length).toBeGreaterThanOrEqual(70); // 同 runtime_contract.test.ts 的下限口径
  });

  test("不含绝对路径（换台机器生成结果必须相同）", () => {
    const contract = getContract();
    expect(renderGeneratedPy(contract)).not.toContain("/Users/");
    expect(renderGeneratedPy(contract)).not.toContain(REPO_ROOT);
    expect(renderTypesPy(contract)).not.toContain("/Users/");
  });
});
