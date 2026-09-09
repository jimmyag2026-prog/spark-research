import { describe, expect, test } from "bun:test";
import { MCP_TOOLS } from "../../backend/src/mcp/tools";

// v0.2.1：零上下文外部验收（一个对本仓库一无所知、且被禁止读源码的 agent
// 只靠 MCP + llms.txt 跑完整链路）暴露的三个摩擦点，逐条钉住。
// 验收报告见 docs/devlog/P9-extensibility.md 的「外部验收」一节。

function tool(name: string) {
  const t = MCP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`工具 ${name} 不存在`);
  return t;
}

describe("摩擦点 1 · 长任务句柄的跨连接语义必须说清楚", () => {
  // 原描述说「任务仍在后台跑」，但 TaskRegistry 是纯内存 Map：
  // 连接一断句柄就没了。对 exp_run 磁盘上还有状态可 resume，
  // 对文献类长任务则是真没了。承诺与实现不符，属误导。
  test("task_status 讲清句柄只在本连接有效", () => {
    const d = tool("task_status").description;
    expect(d).toContain("进程内存里");
    expect(d).toContain("连接");
  });

  test("task_status 区分「干实验可 resume」与「文献类任务会丢」", () => {
    const d = tool("task_status").description;
    expect(d).toContain("resume");
    expect(d).toContain("没有磁盘 checkpoint");
  });

  test("exp_run 不再笼统承诺「仍在后台跑」，而是指明 resume 路径", () => {
    const d = tool("exp_run").description;
    expect(d).toContain("状态真源在磁盘上");
    expect(d).toContain("resume");
  });

  test("两处都给出调大超时的具体做法（可自愈，不是只报问题）", () => {
    for (const name of ["exp_run", "task_status"]) {
      expect(tool(name).description).toContain("SPARK_RESEARCH_MCP_TIMEOUT_MS");
    }
  });
});

describe("摩擦点 2 · 批量精读默认跳过已读", () => {
  test("lit_read_cards 暴露 redoRead 参数", () => {
    const props = (tool("lit_read_cards").inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.redoRead).toBeDefined();
  });

  test("描述里写明默认跳过已读，避免重试重烧模型调用", () => {
    const d = tool("lit_read_cards").description;
    expect(d).toContain("跳过");
    expect(d).toContain("redoRead");
  });
});

describe("摩擦点 3 · ideaId 命名在两个工具间一致", () => {
  // idea_novelty_check 要的参数叫 ideaId，但 idea_coexplore 的返回体里
  // 只有 stored.recordId——外部 agent 得往下挖才找得到。
  test("idea_coexplore 的描述点名返回体里有 ideaId", () => {
    expect(tool("idea_coexplore").description).toContain("ideaId");
  });

  test("idea_novelty_check 要的就是这个 ideaId", () => {
    const props = (tool("idea_novelty_check").inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.ideaId).toBeDefined();
  });
});

describe("回归护栏 · 修描述不能碰坏 AD-9 的边界", () => {
  test("五个危险动作仍然一个都没被暴露", () => {
    const names = new Set(MCP_TOOLS.map((t) => t.name));
    for (const withheld of [
      "lab_approve",
      "lab_reject",
      "lab_simulate",
      "conclusion_review",
      "project_archive",
    ]) {
      expect(names.has(withheld)).toBe(false);
    }
  });
});
