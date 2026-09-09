import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAB_HELP, runLabCommand } from "../../backend/src/lab/cli";
import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import { ProjectManager } from "../../backend/src/project/manager";

// P6 CLI 单测。执行后端注入 mock：CLI 层要验的是**命令语义与 approve gate**，
// 不是 opentrons 装没装（那是 wet_e2e）。

const PROTOCOL_A = "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD";
const PROTOCOL_B = "配制5000uL稀释液，对样品做6个梯度的连续稀释，每步转移100uL并混匀3次";
const UNSAFE = "加入10uL盐酸，加入10uL次氯酸钠";

function cli() {
  const root = mkdtempSync(join(tmpdir(), "lab-cli-"));
  const manager = new ProjectManager(root);
  manager.create("lab-proj");
  const out: string[] = [];
  const err: string[] = [];
  const run = (args: string[]) =>
    runLabCommand(args, {
      manager,
      backend: new MockDeviceBackend(),
      actor: "测试员",
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
  return {
    manager,
    run,
    out,
    err,
    text: () => out.join("\n"),
    errText: () => err.join("\n"),
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

// 编译一条实验并返回它的 id（8 位前缀）。
async function compiled(c: ReturnType<typeof cli>, protocol = PROTOCOL_A) {
  expect(await c.run(["compile", protocol, "--title", "CLI 协议", "--json"])).toBe(0);
  const view = JSON.parse(c.text());
  c.reset();
  return { id: String(view.id).slice(0, 8), view };
}

describe("lab CLI · compile", () => {
  test("compile 一步走到 awaiting_approval，并明确提示需要人工确认", async () => {
    const c = cli();
    expect(await c.run(["compile", PROTOCOL_A, "--title", "OD 测定"])).toBe(0);
    expect(c.text()).toContain("✅ 编译完成");
    expect(c.text()).toContain("awaiting_approval");
    expect(c.text()).toContain("安全门 ✅ chemical compatibility");
    expect(c.text()).toContain("安全门 ✅ volume capacity");
    // 这一行是 AD-6 在 CLI 层的表达：不给出「直接执行」的路子。
    expect(c.text()).toContain("安全门通过 ≠ 可以执行");
    expect(c.text()).toContain("lab approve");
    expect(c.text()).not.toContain("lab simulate");
  });

  test("compile --json 给结构化视图 + 安全门报告", async () => {
    const c = cli();
    expect(await c.run(["compile", PROTOCOL_B, "--json"])).toBe(0);
    const payload = JSON.parse(c.text());
    expect(payload.state).toBe("awaiting_approval");
    expect(payload.protocolHash).toHaveLength(16);
    expect(payload.robotType).toBe("Flex");
    expect(payload.safetyReport.passed).toBe(true);
    expect(payload.record).toBeUndefined();
  });

  test("compile 缺协议原文 → 退出码 1 + 用法", async () => {
    const c = cli();
    expect(await c.run(["compile"])).toBe(1);
    expect(c.errText()).toContain("用法");
  });

  test("安全门拦截 → 退出码 1，逐条列出被拦的规则", async () => {
    const c = cli();
    expect(await c.run(["compile", UNSAFE, "--title", "危险"])).toBe(1);
    expect(c.errText()).toContain("🚫 安全门拦截");
    expect(c.errText()).toContain("chemical compatibility");
    expect(c.text()).not.toContain("lab approve");
  });

  test("编译警告（离机步骤）会打出来", async () => {
    const c = cli();
    expect(await c.run(["compile", "加入50uL样品，12000g离心5分钟", "--title", "离心"])).toBe(0);
    expect(c.text()).toContain("⚠️");
    expect(c.text()).toContain("离心");
  });

  test("compile --experiment 重新编译并作废先前的 approve", async () => {
    const c = cli();
    const { id } = await compiled(c);
    expect(await c.run(["approve", id])).toBe(0);
    c.reset();
    expect(await c.run(["compile", "--experiment", id, "--protocol", PROTOCOL_B, "--json"])).toBe(0);
    const payload = JSON.parse(c.text());
    expect(payload.state).toBe("awaiting_approval"); // 重编译后又跑了一次安全门
    expect(payload.approval).toBeNull();
  });
});

describe("lab CLI · approve gate（AD-6）", () => {
  test("未 approve 就 simulate → 退出码 1 且明说要先 approve", async () => {
    const c = cli();
    const { id } = await compiled(c);
    expect(await c.run(["simulate", id])).toBe(1);
    expect(c.errText()).toContain("🚫");
    expect(c.errText()).toContain("未经 approve 不能执行");
    expect(c.errText()).toContain("compile → safety_check → approve → execute");
  });

  test("actorSource 记进 decision record：显式署名 vs 取自环境可区分", async () => {
    const c = cli();
    const { id } = await compiled(c);
    // deps.actor 注入 = 显式署名
    expect(await c.run(["approve", id, "--json"])).toBe(0);
    const decisionId = JSON.parse(c.text()).decisionId as string;
    const project = c.manager.open("lab-proj");
    const decision = project.records().get(decisionId)!;
    expect(decision.metadata.actor).toBe("测试员");
    expect(decision.metadata.actorSource).toBe("explicit");
  });

  test("approve → simulate 才能跑通，并给出 observation", async () => {
    const c = cli();
    const { id } = await compiled(c);
    expect(await c.run(["approve", id, "--note", "已复核"])).toBe(0);
    expect(c.text()).toContain("✅ 已批准");
    expect(c.text()).toContain("测试员");
    expect(c.text()).toContain("lab simulate");
    c.reset();

    expect(await c.run(["simulate", id, "--note", "首轮"])).toBe(0);
    expect(c.text()).toContain("analyze");
    expect(c.text()).toContain("run log 摘要");
    expect(c.text()).toContain("evidence=observed");
  });

  test("simulate --conclude 直接落结论卡（review 仍是 pending）", async () => {
    const c = cli();
    const { id } = await compiled(c);
    await c.run(["approve", id]);
    c.reset();
    expect(await c.run(["simulate", id, "--conclude", "协议可跑通", "--json"])).toBe(0);
    const view = JSON.parse(c.text());
    expect(view.state).toBe("concluded");
    expect(view.conclusionId).toBeTruthy();
  });

  test("approve 一条还没编译的实验 → 退出码 1", async () => {
    const c = cli();
    expect(await c.run(["approve", "deadbeef"])).toBe(1);
    expect(c.errText()).toContain("❌");
  });

  test("reject 必须给理由；给了就落 rejected", async () => {
    const c = cli();
    const { id } = await compiled(c);
    expect(await c.run(["reject", id])).toBe(1);
    expect(c.errText()).toContain("--reason");
    c.reset();
    expect(await c.run(["reject", id, "--reason", "样品量不足"])).toBe(0);
    expect(c.text()).toContain("❌ 已拒绝");
    expect(c.text()).toContain("样品量不足");
    c.reset();
    // 被拒之后照样不能执行
    expect(await c.run(["simulate", id])).toBe(1);
  });

  test("--actor 覆盖默认署名", async () => {
    const c = cli();
    const { id } = await compiled(c);
    expect(await c.run(["approve", id, "--actor", "李四", "--json"])).toBe(0);
    expect(JSON.parse(c.text()).approval.actor).toBe("李四");
  });
});

describe("lab CLI · status / backends / help", () => {
  test("status 不给 id 就列出全部湿实验", async () => {
    const c = cli();
    await compiled(c, PROTOCOL_A);
    await compiled(c, PROTOCOL_B);
    expect(await c.run(["status"])).toBe(0);
    expect(c.text()).toContain("湿实验：2 条");
  });

  test("空项目的 status 给出下一步", async () => {
    const c = cli();
    expect(await c.run(["status"])).toBe(0);
    expect(c.text()).toContain("还没有湿实验");
    expect(c.text()).toContain("lab compile");
  });

  test("status <id> 打 record 正文（含安全门与审批）", async () => {
    const c = cli();
    const { id } = await compiled(c);
    await c.run(["approve", id]);
    c.reset();
    expect(await c.run(["status", id])).toBe(0);
    expect(c.text()).toContain("# 湿实验");
    expect(c.text()).toContain("## 安全门");
    expect(c.text()).toContain("## 审批");
    expect(c.text()).toContain("protocolHash");
  });

  test("status --state 过滤；未知状态报错", async () => {
    const c = cli();
    await compiled(c);
    expect(await c.run(["status", "--state", "awaiting_approval"])).toBe(0);
    expect(c.text()).toContain("湿实验：1 条");
    c.reset();
    expect(await c.run(["status", "--state", "dry_run"])).toBe(1);
    expect(c.errText()).toContain("未知状态");
  });

  test("backends 列出两个后端并标出默认", async () => {
    const c = cli();
    const code = await c.run(["backends", "--json"]);
    const entries = JSON.parse(c.text()) as Array<{ id: string; ok: boolean }>;
    expect(entries.map((e) => e.id)).toEqual(["opentrons_simulate", "mock_devices"]);
    expect(entries.find((e) => e.id === "mock_devices")?.ok).toBe(true);
    expect(code).toBe(0);
  }, 30_000);

  test("help / 未知子命令", async () => {
    const c = cli();
    expect(await c.run(["help"])).toBe(0);
    expect(c.text()).toContain(LAB_HELP.split("\n")[0]);
    c.reset();
    expect(await c.run([])).toBe(1);
    c.reset();
    expect(await c.run(["frobnicate"])).toBe(1);
    expect(c.errText()).toContain("未知的 lab 子命令");
  });
});
