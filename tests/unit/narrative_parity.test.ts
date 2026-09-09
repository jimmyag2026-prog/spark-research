import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import { MCP_TOOLS } from "../../backend/src/mcp/tools";
import { WET_LEGAL_TRANSITIONS, WET_EXPERIMENT_STATES } from "../../backend/src/lab/wet_models";
import { EXPERIMENT_STATES } from "../../backend/src/experiment/models";

// AD-12「对外声称的每一项能力必须机器可核」的门禁实现（D-12）。
//
// 为什么需要它：外部评审最大的一条发现是「叙事超前于实现」——README 宣传 100 并发
// swarm，而 swarm.ts 在生产代码里零调用方；架构图写着 18 个 connector，实际 17 个。
// 这类漂移的共同点是**不报错**：代码能编译、测试全绿、只有人去读才发现对不上。
// 靠人自觉不可持续，所以做成门禁。
//
// 这个文件只做一件事：把「文档/自描述端点说的」与「代码里真有的」对撞，
// 对不上就红。它不检查代码好坏，只检查**声称与事实是否一致**。

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SRC = join(REPO_ROOT, "backend/src");

function walkSource(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__pycache__" || entry === "node_modules") continue;
      walkSource(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__pycache__") continue;
      walkTs(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// 生产代码内部的 import 图。只看 backend/src 内部的相对 import——
// 被测试 import 不算「有生产调用方」，那正是 swarm.ts 当初蒙混过关的方式。
function productionImportTargets(): Set<string> {
  const targets = new Set<string>();
  for (const file of walkTs(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const base = normalize(join(dirname(file), match[1]!));
      for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
        try {
          if (statSync(candidate).isFile()) targets.add(candidate);
        } catch {
          /* 解析不到就跳过：可能是 .json 或类型-only 路径 */
        }
      }
    }
  }
  return targets;
}

// 在册的「合法无引用者」——每一条都必须写清**为什么**。
// 这张表只许缩短、不许悄悄变长：新增一条就等于新增一处「叙事与实现的缺口」，
// 应该先问「这东西还该不该留」，而不是先把它加进白名单。
const ALLOWED_ORPHANS: Record<string, string> = {
  "backend/src/index.ts": "CLI 入口点，由 package.json 的 bin 直接执行，天然无仓库内引用者",
  "backend/src/http/fixture.ts":
    "fixture 回放层，刻意只被测试使用（生产走 NativeHttp）——这是 P2 的设计，不是缺口",
  "backend/src/agents/swarm.ts":
    "**已知缺口**：v0.1 遗留，生产代码零调用方、dependsOn 未实现、decompose 是三条正则。" +
    "README 的「100 并发 swarm」宣传语即出自此处。方案 v0.3 P12 决定删除（BACKLOG V7）",
  "backend/src/proteins/analysis.ts":
    "**已知缺口**：protein-analysis 技能有 e2e、有 SKILL.md（写着代码入口是 ProteinAnalysis.analyze），" +
    "但没有任何生产入口——无 CLI 命令、无 HTTP 路由、无 MCP 工具、不在 capabilities 里。" +
    "也就是说用户与外部 agent 都调不到它。见 BACKLOG V22",
};

describe("叙事一致性门禁（AD-12）", () => {
  test("孤儿模块：生产代码零引用者的文件必须在册，且在册理由不许为空", () => {
    const imported = productionImportTargets();
    const orphans = walkTs(SRC)
      .filter((f) => !imported.has(f))
      .map((f) => relative(REPO_ROOT, f))
      .sort();

    const unregistered = orphans.filter((f) => !(f in ALLOWED_ORPHANS));
    expect(
      unregistered,
      `发现未登记的孤儿模块（生产代码里没有任何调用方）。\n` +
        `要么它已经死了该删，要么它本该被接上却没接——两种都是「叙事与实现的缺口」。\n` +
        `确认是合法例外后，在 ALLOWED_ORPHANS 里补一条并写清理由：\n  ${unregistered.join("\n  ")}`,
    ).toEqual([]);

    // 反向：在册的条目若已不再是孤儿（被接上了或被删了），要求把它从表里移除，
    // 免得白名单变成一张只增不减、越来越没人看的死表。
    const stale = Object.keys(ALLOWED_ORPHANS).filter((f) => !orphans.includes(f));
    expect(stale, `这些条目已不再是孤儿，请从 ALLOWED_ORPHANS 移除：\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  test("connector 数：capabilities/文档声称 = registry 实际注册", () => {
    const actual = new ConnectorRegistry({}).registerBuiltins().listAll();
    // 数字本身不写死在这里——写死就等于把漂移搬了个家。
    // 断言的是「同一个真源被所有消费方一致地读到」。
    expect(actual.length).toBeGreaterThan(0);
    const names = new Set(actual.map((c) => c.name));
    expect(names.size).toBe(actual.length); // 无重名
    for (const c of actual) {
      expect(c.domain, `connector ${c.name} 没有归入任何域（domainOf 返回 custom）`).not.toBe("custom");
    }
  });

  test("技能数：docs/EXTENDING.md 声称的数量 = skills/ 下 SKILL.md 实际数量", () => {
    const skillsDir = join(SRC, "skills");
    const actual = readdirSync(skillsDir).filter((d) => {
      try {
        return statSync(join(skillsDir, d, "SKILL.md")).isFile();
      } catch {
        return false;
      }
    });
    const doc = readFileSync(join(REPO_ROOT, "docs/EXTENDING.md"), "utf8");
    const claims = [...doc.matchAll(/(\d+)\s*个技能/g)].map((m) => Number(m[1]));
    expect(claims.length, "docs/EXTENDING.md 里找不到「N 个技能」的声称——是不是措辞改了？").toBeGreaterThan(0);
    for (const claimed of claims) {
      expect(claimed, `docs/EXTENDING.md 声称 ${claimed} 个技能，实际 ${actual.length} 个`).toBe(actual.length);
    }
  });

  test("MCP 工具：每个工具名唯一，且 withheld 清单与暴露清单不重叠", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size, "MCP 工具有重名").toBe(names.length);
  });

  // 今天真实发生过的漂移：lane D-d 把 wet_run 拆成 approved/executing 之后，
  // /api/lab/machine 里手写的 approvalGate 仍然自称 to: "wet_run"——
  // AD-6 的机器可读表达对外撒谎，而所有测试都是绿的。
  test("/api/lab/machine 的两道门必须能从转移表推导出来，不得手写漂移", async () => {
    const { createApp } = await import("../../backend/src/server/app");
    const app = createApp({});
    const res = await app.fetch(new Request("http://spark.local/api/lab/machine"));
    const body = (await res.json()) as {
      states: string[];
      approvalGate: { from: string; to: string };
      executionGate: { from: string; to: string };
    };

    expect(body.states).toEqual([...WET_EXPERIMENT_STATES]);

    const inboundOf = (state: string) =>
      Object.entries(WET_LEGAL_TRANSITIONS)
        .filter(([, tos]) => (tos as readonly string[]).includes(state))
        .map(([from]) => from);

    // 审批门与执行门的共同不变式：目标状态**只有一条入边**，
    // 且端点自报的 from/to 必须与转移表算出来的那条边一致。
    for (const [label, gate] of [
      ["approvalGate", body.approvalGate],
      ["executionGate", body.executionGate],
    ] as const) {
      const inbound = inboundOf(gate.to);
      expect(inbound, `${label}.to='${gate.to}' 的入边不唯一：${inbound.join(",")}——门就不成其为门了`).toHaveLength(1);
      expect(inbound[0], `${label} 自报 from='${gate.from}'，但转移表说是 '${inbound[0]}'`).toBe(gate.from);
    }
  });

  // v0.3.0 发布后立刻暴露的缺口：后端 D-10 把 wet_run 拆成 approved/executing，
  // 前端 bottom.tsx 的执行按钮仍然按 `state !== "wet_run"` 判禁用 → **按钮永远是灰的**，
  // Web 工作台里可以批准却永远执行不了，湿实验闭环在 UI 上断掉。
  //
  // 为什么全绿：那是字符串比较不是枚举，tsc 管不着；后端测试不碰前端；
  // 而 D-12 原本只查后端自描述端点，没查**前端消费方**。
  // 这条断言补的就是这一段：状态词汇表是后端的真源，前端不许出现它之外的状态名。
  test("前端引用的实验状态必须真实存在于后端状态机（退役状态不许残留）", () => {
    const known = new Set<string>([...WET_EXPERIMENT_STATES, ...EXPERIMENT_STATES]);

    // 已退役的状态名：出现在任何源码里都算 bug（文档/CHANGELOG 讲历史不算，故只扫 src）。
    const RETIRED_STATES = ["wet_run"];
    const roots = [join(REPO_ROOT, "frontend/workspace/src"), SRC];
    for (const root of roots) {
      for (const file of walkSource(root)) {
        const text = readFileSync(file, "utf8");
        for (const retired of RETIRED_STATES) {
          expect(
            text.includes(`"${retired}"`),
            `${relative(REPO_ROOT, file)} 仍引用已退役的状态 "${retired}"——` +
              `后端状态机里已经没有它了，这种字符串比较 tsc 抓不到`,
          ).toBe(false);
        }
      }
    }

    // 前端 badge 色表的键里，凡是「看起来像实验状态」的都必须在真源里。
    // 判据：出现在后端两套状态机并集里的键放行；其余键是 evidence 标签 / novelty 状态，
    // 用显式白名单排除，避免这条断言变成一张什么都放行的空壳。
    const NON_STATE_TONES = new Set([
      "observed", "computed", "sourced", "inferred",
      "checked-overlap", "checked-novel", "checked-incremental", "unchecked",
    ]);
    const ui = readFileSync(join(REPO_ROOT, "frontend/workspace/src/components/ui.tsx"), "utf8");
    const block = ui.slice(ui.indexOf("const BADGE_TONE"), ui.indexOf("};", ui.indexOf("const BADGE_TONE")));
    const keys = [...block.matchAll(/^\s*"?([A-Za-z_][\w-]*)"?\s*:/gm)].map((m) => m[1]!);
    expect(keys.length, "没解析出 BADGE_TONE 的键——是不是结构改了？").toBeGreaterThan(5);
    const bogus = keys.filter((k) => !known.has(k) && !NON_STATE_TONES.has(k));
    expect(
      bogus,
      `BADGE_TONE 里这些键既不是后端状态、也不在非状态白名单里：${bogus.join(", ")}`,
    ).toEqual([]);
  });
});
