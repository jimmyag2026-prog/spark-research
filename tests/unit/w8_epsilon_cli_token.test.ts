import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consume } from "../../backend/src/lab/approval_token";
import { runLabCommand } from "../../backend/src/lab/cli";
import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import { ProjectManager } from "../../backend/src/project/manager";
import { SAFETY_COVERAGE_STATEMENT } from "../../backend/src/lab/safety";

// W8-1 ε：
//   V95 · `spark-research lab token <id>`（TTY 门与 `lab approve` 同一套）
//   V59① · `lab compile` 那一屏打印覆盖范围声明（与 `lab status` 同一段常量）

const PROTOCOL_A = "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD";

function cli(overrides: {
  approvalIsInteractiveTty?: () => boolean;
  approvalConfirm?: (p: string) => Promise<string | null>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "lab-cli-token-"));
  const manager = new ProjectManager(root);
  manager.create("lab-proj");
  const out: string[] = [];
  const err: string[] = [];
  const run = (args: string[], env: Record<string, string | undefined> = process.env) =>
    runLabCommand(args, {
      manager,
      backend: new MockDeviceBackend(),
      actor: "测试员",
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      approvalIsInteractiveTty: overrides.approvalIsInteractiveTty ?? (() => true),
      approvalConfirm: overrides.approvalConfirm ?? (async () => "yes"),
    });
  return {
    manager,
    run,
    out,
    err,
    text: () => out.join("\n"),
    errText: () => err.join("\n"),
  };
}

async function compileOne(c: ReturnType<typeof cli>): Promise<string> {
  expect(await c.run(["compile", PROTOCOL_A, "--title", "OD 测定", "--json"])).toBe(0);
  const parsed = JSON.parse(c.text()) as { id: string };
  return parsed.id;
}

describe("V95 · spark-research lab token <id>", () => {
  test("交互终端确认 → 签发一枚令牌，打印一次；这枚令牌能被真正的 HTTP consume() 消费", async () => {
    const c = cli(); // 默认：模拟真实交互终端 + 'yes'
    const id = await compileOne(c);
    c.out.length = 0;
    expect(await c.run(["token", id])).toBe(0);
    expect(c.text()).toContain("一次性审批令牌");
    const tokenLine = c.out.find((l) => /^\s*[0-9a-f]{64}\s*$/.test(l));
    expect(tokenLine).toBeDefined();
    const token = tokenLine!.trim();

    // 真正能被 consume() 兑现——不是只打印了一个看起来像令牌的字符串。
    const project = c.manager.open("lab-proj");
    try {
      expect(() => consume(project.paths.root, id, token)).not.toThrow();
    } finally {
      project.close();
    }
  });

  test("--json 输出令牌与到期时间，字段完整", async () => {
    const c = cli();
    const id = await compileOne(c);
    c.out.length = 0;
    expect(await c.run(["token", id, "--json"])).toBe(0);
    const parsed = JSON.parse(c.text()) as {
      experimentId: string;
      token: string;
      issuedAt: string;
      expiresAt: string;
    };
    expect(parsed.experimentId).toBe(id);
    expect(parsed.token).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(parsed.expiresAt) - Date.parse(parsed.issuedAt)).toBe(10 * 60 * 1000);
  });

  test("非交互终端、未配置 SPARK_LAB_CI_BYPASS_TOKEN：token 命令默认拒绝（TTY 门与 lab approve 同一套）", async () => {
    const c = cli({ approvalIsInteractiveTty: () => false });
    const id = await compileOne(c);
    c.out.length = 0;
    c.err.length = 0;
    expect(await c.run(["token", id])).toBe(1);
    expect(c.errText()).toContain("SPARK_LAB_CI_BYPASS_TOKEN");
    // 门没过就不应该有任何令牌产出（也不该有半点令牌文本打印出来）。
    expect(c.text()).not.toMatch(/[0-9a-f]{64}/);
  });

  test("非交互终端、未配置 SPARK_LAB_CI_BYPASS_TOKEN 时先确认默认拒绝", async () => {
    delete process.env.SPARK_LAB_CI_BYPASS_TOKEN;
    const c = cli({ approvalIsInteractiveTty: () => false });
    const id = await compileOne(c);
    c.out.length = 0;
    c.err.length = 0;
    expect(await c.run(["token", id])).toBe(1);
    expect(c.errText()).toContain("SPARK_LAB_CI_BYPASS_TOKEN");
  });

  test("非交互终端 + 正确的 ci-bypass-token/reason → 放行，签发令牌（与 lab_cli.test.ts 的 V19 场景同一套判据）", async () => {
    process.env.SPARK_LAB_CI_BYPASS_TOKEN = "correct-token";
    try {
      const c = cli({ approvalIsInteractiveTty: () => false });
      const id = await compileOne(c);
      c.out.length = 0;
      expect(
        await c.run(["token", id, "--ci-bypass-token", "correct-token", "--ci-bypass-reason", "CI 测试要跑通闭环"]),
      ).toBe(0);
      expect(c.text()).toContain("一次性审批令牌");
    } finally {
      delete process.env.SPARK_LAB_CI_BYPASS_TOKEN;
    }
  });

  test("不存在的实验 → 非 0 退出码（不会先于存在性检查签出令牌）", async () => {
    const c = cli();
    expect(await c.run(["token", "does-not-exist"])).toBe(1);
    expect(c.text()).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("V59① · lab compile 打印安全门覆盖范围声明（与 lab status 同一段常量）", () => {
  test("compile 非 JSON 输出包含覆盖范围声明关键内容", async () => {
    const c = cli();
    await c.run(["compile", PROTOCOL_A, "--title", "OD 测定"]);
    const text = c.text();
    expect(text).toContain("安全门覆盖范围声明");
    // 与 SAFETY_COVERAGE_STATEMENT 内容同源——至少每一行的关键短语都出现在输出里。
    expect(text).toContain("chemical_compatibility");
    expect(text).toContain("本规则不看孔位");
    expect(text).toContain("concentration_limit");
    expect(text).toContain("biosafety");
    expect(text).toContain("PN 实验室");
    expect(text).toContain("中英双语都能编");
  });

  test("compile --json 输出不混入覆盖范围声明（JSON 必须是合法 JSON，不是 JSON+文本混排）", async () => {
    const c = cli();
    expect(await c.run(["compile", PROTOCOL_A, "--title", "OD 测定", "--json"])).toBe(0);
    // 能被 JSON.parse 干净解析，说明 JSON 分支没有夹带非 JSON 输出。
    expect(() => JSON.parse(c.text())).not.toThrow();
  });

  test("常量本身没有声称 V55 之前就有的能力：覆盖了 V55（中英双语）与 V59②（P-level）两处更新", () => {
    expect(SAFETY_COVERAGE_STATEMENT).toContain("中英双语都能编");
    expect(SAFETY_COVERAGE_STATEMENT).toContain("PN 实验室");
    expect(SAFETY_COVERAGE_STATEMENT).not.toContain("英文协议编译不出步骤");
  });
});
