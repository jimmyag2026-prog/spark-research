#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SETTINGS } from "../backend/src/config";
import { BUILTIN_CONNECTORS } from "../backend/src/connectors/registry";
import { SAFETY_RULES } from "../backend/src/lab/safety";
import { WET_BACKEND_IDS, DEFAULT_WET_BACKEND } from "../backend/src/lab/wet_backend";
import { SIMULATION_PLATFORM_IDS, DEFAULT_SIMULATION_PLATFORM } from "../backend/src/simulation/registry";
import { CONCLUSION_RULES } from "../backend/src/reviewer/conclusion_rules";
import { RATING_VIOLATION_CODES } from "../backend/src/ideation/novelty";
import { EDGE_TYPES, EVIDENCE_LABELS, RECORD_TYPES } from "../backend/src/project/models";
import { MCP_TOOLS, MCP_WITHHELD } from "../backend/src/mcp/tools";
import { loadSkills } from "../backend/src/skills/frontmatter";
import { PACKAGE_VERSION } from "../backend/src/version";

// llms.txt / llms-full.txt 生成器（P9 交付物 4）。
//
// 目的：让一个**没有本仓库上下文**的外部 LLM 一次读完就能上手——
// llms.txt 是索引（几十行，回答「这是什么、有哪些能力、去哪找细节」），
// llms-full.txt 是全量（把全部设计文档与技能手册摊平成纯文本）。
//
// **幂等是硬要求**：不含时间戳、不含绝对路径、不读用户凭据状态、顺序确定。
// 文档改了就重新生成，`git diff` 只会显示文档那部分的变化。
// 一致性由 tests/unit/llms_txt.test.ts 守：它重新生成一遍与仓库里的文件逐字节比对，
// 改了文档忘了重新生成 → CI 红。
//
// 用法：bun scripts/gen-llms-txt.ts [--check]
//   --check  只比对不写盘（CI 用），不一致时退出码 1

const REPO_ROOT = join(import.meta.dir, "..");

const DOC_INDEX: Array<{ path: string; title: string; note: string }> = [
  { path: "README.md", title: "README", note: "安装、快速上手、CLI 一览" },
  { path: "docs/DESIGN.md", title: "产品设计", note: "定位、五大功能域、系统架构、8 条架构决策（AD-1..AD-8）——设计真源" },
  { path: "docs/EXTENDING.md", title: "扩展指南", note: "六个扩展点各一节：契约 + 最小可运行示例 + 怎么测 + 放哪里" },
  { path: "docs/DEVELOPMENT_PLAN.md", title: "开发与验证计划", note: "阶段划分 P0-P9、每阶段的验证与退出标准、工程纪律 9 条" },
  { path: "docs/REVIEW_BRIEF.md", title: "外部评审简报", note: "15 分钟进入状态：架构、方法、已知缺陷、最想被挑战的问题" },
  { path: "docs/BACKLOG.md", title: "Backlog", note: "未决事项唯一登记处（v0.3 候选 / 等外部输入）" },
  { path: "CHANGELOG.md", title: "CHANGELOG", note: "版本变更" },
];

const CLI_COMMANDS: Array<[string, string]> = [
  ["project new|list|open|archive", "项目管理。文献库/思路库/实验/结论都挂在项目下"],
  ["lit search|add|list|pdf|read|review|export|sources", "文献域：跨源检索、入库、PDF、精读卡、综述、导出"],
  ["idea new|list|check", "思路库：Co-explore 产出 Idea 卡 + novelty check"],
  ["exp new|run|status|list|platforms", "干实验闭环：设计 → 提交 → 回收 → 分析（断点可续跑）"],
  ["protein <query> [--json] [--no-persist]", "蛋白结构调研：UniProt 身份 → RCSB PDB 实验结构 → AlphaFold 预测模型"],
  ["lab compile|approve|reject|simulate|status|backends", "湿实验：编译 → 安全门 → **人工批准** → 模拟器执行"],
  ["conclusion list|show|review", "结论卡评审。只有 approved 进报告结论区"],
  ["report export|stats", "证据图 → 带证据链接的 Markdown 报告"],
  ["capabilities [--json] [--probe]", "能力自描述：从真实注册表生成的清单"],
  ["config list|get|set|unset|path", "用户配置（env > config.json > 默认值）"],
  ["new skill|connector|platform <name>", "脚手架：生成带测试桩的扩展点模板"],
  ["mcp", "以 MCP server 模式运行（stdio），供外部 agent 接入"],
  ["server [port]", "启动 HTTP API + Web 工作台（默认 4321）"],
];

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8").replace(/\s+$/, "");
}

// 用同一份技能索引，按名字排序保证顺序确定。
function skills() {
  return loadSkills().sort((a, b) => a.name.localeCompare(b.name));
}

function connectorLines(): string[] {
  const lines: string[] = [];
  for (const domain of Object.keys(BUILTIN_CONNECTORS).sort()) {
    const names = BUILTIN_CONNECTORS[domain]!.map((d) => d.name);
    lines.push(`- **${domain}**：${names.join(" / ")}`);
  }
  return lines;
}

export function buildLlmsTxt(): string {
  const lines: string[] = [];
  lines.push("# Spark Research");
  lines.push("");
  lines.push(
    "> 面向科研人群的开源科研工作台（v" +
      PACKAGE_VERSION +
      "，Apache-2.0）。用自然语言驱动一个可审计的研究代理，完成「文献调研 → 思路共探 → 创新性核验 → 实验（干/湿）→ 全流程记录 → 结论评审 → 报告」的完整循环。本地优先、模型无关、每一步都留下可溯源的证据链。",
  );
  lines.push("");
  lines.push(
    "核心主张：**你的研究项目是一等公民，每一步思考和实验都留下可审计的证据链。** 与同类工具的三个差异：project-centric（不是 session-centric）、全流程 Research Record（思路/决策/观察/结论都进同一张证据图）、干湿实验闭环。",
  );
  lines.push("");

  lines.push("## 文档");
  lines.push("");
  for (const doc of DOC_INDEX) {
    lines.push(`- [${doc.title}](${doc.path})：${doc.note}`);
  }
  lines.push("- [llms-full.txt](llms-full.txt)：上述文档 + 全部技能手册的全量纯文本");
  lines.push("");

  lines.push("## CLI");
  lines.push("");
  lines.push("```");
  for (const [cmd, note] of CLI_COMMANDS) {
    lines.push(`spark-research ${cmd}`);
    lines.push(`    ${note}`);
  }
  lines.push("```");
  lines.push("");

  lines.push("## 作为 MCP 工具箱接入");
  lines.push("");
  lines.push("```bash");
  lines.push("spark-research mcp    # stdio 传输");
  lines.push("```");
  lines.push("");
  lines.push(`暴露 ${MCP_TOOLS.length} 个工具。接入后第一步调 \`research_capabilities\` introspect 整个工作台。`);
  lines.push("");
  for (const tool of MCP_TOOLS) {
    lines.push(`- \`${tool.name}\`${tool.longRunning ? "（长任务，同步等待）" : ""}：${firstLine(tool.description)}`);
  }
  lines.push("");
  lines.push("**刻意不暴露的动作**（设计声明，不是未实现清单）：");
  lines.push("");
  for (const w of MCP_WITHHELD) {
    lines.push(`- \`${w.name}\`：${w.reason} 人来做：\`${w.humanAction}\``);
  }
  lines.push("");

  lines.push("## 能力面");
  lines.push("");
  lines.push(`### 数据源 Connector（${Object.values(BUILTIN_CONNECTORS).flat().length}）`);
  lines.push("");
  lines.push(...connectorLines());
  lines.push("");
  lines.push(
    "可用性四档：available / needs_credential（要 key 但没配，检索时被 **skip** 而不是失败）/ placeholder（占位实现，调用会失败）/ unavailable。跑 `spark-research capabilities --json` 看当前机器的实际状态。",
  );
  lines.push("");
  lines.push(`### 干实验平台（${SIMULATION_PLATFORM_IDS.length}，默认 ${DEFAULT_SIMULATION_PLATFORM}）`);
  lines.push("");
  lines.push(`- ${SIMULATION_PLATFORM_IDS.join(" / ")}`);
  lines.push("");
  lines.push(`### 湿实验后端（${WET_BACKEND_IDS.length}，默认 ${DEFAULT_WET_BACKEND}）`);
  lines.push("");
  lines.push(`- ${WET_BACKEND_IDS.join(" / ")}`);
  lines.push("");
  lines.push(`### 技能（${skills().length}）`);
  lines.push("");
  for (const skill of skills()) {
    lines.push(`- **${skill.name}**（域 ${skill.frontmatter.domain}）：${skill.frontmatter.triggers.join(" / ")}`);
  }
  lines.push("");
  lines.push("### 规则");
  lines.push("");
  lines.push(`- 湿实验安全门（拦截）：${SAFETY_RULES.map((r) => r.id).join(" / ")}`);
  lines.push("- 引用真实性：citation-integrity（库外 key = hard veto）");
  lines.push(`- 结论卡评审：${CONCLUSION_RULES.join(" / ")}（任一 hard → vetoed）`);
  lines.push(`- novelty 评级校验（确定性覆盖模型评级）：${RATING_VIOLATION_CODES.join(" / ")}`);
  lines.push("");

  lines.push("## 证据图");
  lines.push("");
  lines.push(`- record 类型：${RECORD_TYPES.join(" / ")}`);
  lines.push(`- 边类型：${EDGE_TYPES.join(" / ")}`);
  lines.push(`- 证据标签：${EVIDENCE_LABELS.join(" / ")}`);
  lines.push(
    "- 边方向按语义读：`paper --supports--> idea`（查一条 idea 的支撑文献看它的 incoming 边）；`cites` 是新产物 → 被引论文；`derives_from` 是产物 → 来源。",
  );
  lines.push("");

  lines.push("## 配置");
  lines.push("");
  lines.push("优先级：环境变量 > `~/.spark-research/config.json` > 默认值。");
  lines.push("");
  for (const spec of CONFIG_SETTINGS) {
    const def = spec.secret ? "（凭据）" : spec.defaultValue === null ? "—" : String(spec.defaultValue);
    lines.push(`- \`${spec.key}\`（默认 ${def}${spec.envVar ? `，env \`${spec.envVar}\`` : ""}）：${spec.summary}`);
  }
  lines.push("");

  lines.push("## 用这个工作台时必须知道的几条");
  lines.push("");
  lines.push(
    "1. **湿实验执行前的人工批准是硬门**（AD-6）。安全门通过 ≠ 可以执行；approve / reject / simulate 不对外部 agent 开放。",
  );
  lines.push(
    "2. **引用必须能回链到项目文献库内的真实论文**。库外 key 会被 citation-integrity 判为伪造引用并 veto；写引用只能用 `lit list` 给出的 bibtexKey。",
  );
  lines.push(
    "3. **检索不到 ≠ 新颖**。novelty check 在一条候选都没检到时给出「结论不可用」，不会因此评 novel。",
  );
  lines.push(
    "4. **失败的数据源不许被静默吞掉**。检索结果里每个源有 ok / skipped（未配凭据，不是失败）/ failed 三档；有 failed 就要如实说明覆盖面不全。",
  );
  lines.push(
    "5. **只有 review approved 的结论卡才进报告结论区**，pending 与 vetoed 进「待验证」区并列出阻塞它的 hard finding。报告不替评审人按通过键。",
  );
  lines.push(
    "6. **模拟不是真实数据**。Opentrons 模拟器的读数是 0.0；引用 `simulated=true` 的 observation 却不标注，结论会被 capability-labeling 判 hard。",
  );
  lines.push("");
  return lines.join("\n") + "\n";
}

function firstLine(description: string): string {
  const line = description.split("\n")[0] ?? "";
  return line.replace(/^【何时调】/, "").trim();
}

export function buildLlmsFullTxt(): string {
  const parts: string[] = [];
  parts.push(buildLlmsTxt().trimEnd());
  parts.push("");
  parts.push("=".repeat(78));
  parts.push("# 全量文档");
  parts.push("=".repeat(78));

  for (const doc of DOC_INDEX) {
    parts.push("");
    parts.push("-".repeat(78));
    parts.push(`## 文件：${doc.path}`);
    parts.push("-".repeat(78));
    parts.push("");
    parts.push(read(doc.path));
  }

  parts.push("");
  parts.push("=".repeat(78));
  parts.push("# 技能手册（agent 的操作手册，按需加载）");
  parts.push("=".repeat(78));
  for (const skill of skills()) {
    parts.push("");
    parts.push("-".repeat(78));
    parts.push(`## 技能：${skill.name}（backend/src/skills/${skill.name}/SKILL.md）`);
    parts.push("-".repeat(78));
    parts.push("");
    parts.push(read(`backend/src/skills/${skill.name}/SKILL.md`));
  }

  parts.push("");
  parts.push("=".repeat(78));
  parts.push("# MCP 工具全量描述");
  parts.push("=".repeat(78));
  for (const tool of MCP_TOOLS) {
    parts.push("");
    parts.push(`## ${tool.name}${tool.longRunning ? "（长任务）" : ""}`);
    parts.push("");
    parts.push(tool.description);
    parts.push("");
    parts.push("参数 schema：");
    parts.push("```json");
    parts.push(JSON.stringify(tool.inputSchema, null, 2));
    parts.push("```");
  }
  parts.push("");
  return parts.join("\n");
}

export const OUTPUTS: Array<{ file: string; build: () => string }> = [
  { file: "llms.txt", build: buildLlmsTxt },
  { file: "llms-full.txt", build: buildLlmsFullTxt },
];

function main(): number {
  const check = process.argv.includes("--check");
  let dirty = 0;
  for (const { file, build } of OUTPUTS) {
    const next = build();
    const path = join(REPO_ROOT, file);
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = "";
    }
    if (current === next) {
      console.log(`= ${file}（无变化，${next.length} 字符）`);
      continue;
    }
    dirty++;
    if (check) {
      console.error(`✗ ${file} 与当前文档不一致——请跑 \`bun scripts/gen-llms-txt.ts\` 后提交`);
      continue;
    }
    writeFileSync(path, next);
    console.log(`✓ ${file}（已写入，${next.length} 字符）`);
  }
  if (check && dirty > 0) return 1;
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
