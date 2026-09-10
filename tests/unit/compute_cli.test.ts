import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPUTE_HELP,
  MODAL_CREDENTIAL_ID,
  computeTargetViews,
  defaultComputeAdapters,
  runComputeCommand,
  type ComputeCliDeps,
} from "../../backend/src/compute/cli";
import { LocalComputeAdapter } from "../../backend/src/compute/adapters/local";
import type { CredentialProvider } from "../../backend/src/connectors/base";
import { ProjectManager } from "../../backend/src/project/manager";

// CB-5 接线 · `spark-research compute ...` 的 CLI 单测。
//
// 这份文件验的是**接线**，不是算力语义本身（三轴状态机、一次性消费、上传重验都在
// W5-1 α 的 compute_*.test.ts 里）。所以这里只回答三个问题：
//   ① 十个子命令是不是真的打通到 broker（不是挂了名字调不到代码的假入口）；
//   ② TTY 门在不在（piping 必拒），旁路是不是必须显式且留痕；
//   ③ 有没有哪条路径能**不经审批**把任务派发出去——答案必须是没有。
//
// adapter 用真实的 LocalComputeAdapter：CI 零凭据就能走完整审批链（设计 §0.2）。

const OK = ["/usr/bin/tee", "out.txt"];

interface CliFixture {
  root: string;
  workspace: string;
  manager: ProjectManager;
  run(args: string[]): Promise<number>;
  out: string[];
  err: string[];
  text(): string;
  errText(): string;
  json<T = Record<string, unknown>>(): T;
  reset(): void;
}

// 默认「真人坐在真实终端前敲了 yes」——绝大多数用例验的是命令语义，不是门本身；
// 门本身的正/负路径在下面单独的 describe 里显式覆盖这两个默认值。
function cli(
  overrides: Partial<Pick<ComputeCliDeps, "approvalIsInteractiveTty" | "approvalConfirm" | "credentials" | "env">> = {},
): CliFixture {
  const root = mkdtempSync(join(tmpdir(), "compute-cli-"));
  const manager = new ProjectManager(join(root, "data"));
  manager.create("compute-proj").close();
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "input.txt"), "hello compute\n");

  const out: string[] = [];
  const err: string[] = [];
  const run = (args: string[]) =>
    runComputeCommand(args, {
      manager,
      root: join(root, "data"),
      actor: "测试员",
      cwd: workspace,
      adapters: { local: new LocalComputeAdapter({ pollIntervalMs: 20 }) },
      credentials: overrides.credentials ?? { has: () => false, get: () => null },
      env: overrides.env ?? {},
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      approvalIsInteractiveTty: overrides.approvalIsInteractiveTty ?? (() => true),
      approvalConfirm: overrides.approvalConfirm ?? (async () => "yes"),
    });

  return {
    root,
    workspace,
    manager,
    run,
    out,
    err,
    text: () => out.join("\n"),
    errText: () => err.join("\n"),
    json: <T,>() => JSON.parse(out.join("\n")) as T,
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

interface JobPayload {
  job: {
    jobId: string;
    lifecycle: { execution: string; delivery: string; resource: string; recoverable: boolean };
    approval: { actor: string; planDigest: string; note: string | null } | null;
    consumedApproval: { decisionRecordId: string } | null;
    exitCode: number | null;
    jobDir: string;
    plan: { digest: string; approvalRequired: boolean; warning: string; uploads: Array<{ path: string }> };
  };
  decisionId?: string;
  next?: string;
  skippedUploads?: Array<{ path: string; reason: string }>;
}

/** plan 一条**需要审批**的任务（network=unrestricted → L-3 派生 approvalRequired=true）。 */
async function planned(c: CliFixture, extra: string[] = []): Promise<JobPayload> {
  expect(
    await c.run([
      "plan",
      "--purpose",
      "CLI 接线测试",
      "--upload",
      "input.txt",
      "--output",
      "out.txt",
      "--network",
      "unrestricted",
      "--json",
      ...extra,
      "--",
      ...OK,
    ]),
  ).toBe(0);
  const payload = c.json<JobPayload>();
  c.reset();
  return payload;
}

describe("compute CLI · plan", () => {
  test("plan 零副作用地停在 awaiting_approval，并把「谁的账户、上界多少、传哪些文件」摆在明面上", async () => {
    const c = cli();
    const { job, next } = await planned(c);
    expect(job.lifecycle.execution).toBe("awaiting_approval");
    expect(job.plan.approvalRequired).toBe(true);
    expect(job.approval).toBeNull();
    expect(job.plan.warning).not.toBe("");
    // 上传清单是**逐个文件**的：会离开这台机器的就是这些。
    expect(job.plan.uploads.map((u) => u.path)).toEqual(["input.txt"]);
    // 下一步必须写清楚要人做什么，而不是让调用方自己发明。
    expect(next).toContain("compute approve");
    expect(next).toContain(job.jobId);
  });

  test("command 必须写在裸 `--` 之后；不给 purpose 或不给命令 → 用法提示 + 退出码 1", async () => {
    const c = cli();
    expect(await c.run(["plan", "--purpose", "缺命令", "--json"])).toBe(1);
    expect(c.errText()).toContain("--");
    c.reset();
    expect(await c.run(["plan", "--json", "--", ...OK])).toBe(1);
  });

  test("shell 字符串形态的 command 被 validatePlan 拒（被审批的东西不该再经过一次 shell 展开）", async () => {
    const c = cli();
    expect(
      await c.run(["plan", "--purpose", "试图塞 shell", "--json", "--", "/bin/sh", "-c", "echo hi && rm -rf /"]),
    ).toBe(1);
    expect(c.errText()).toContain("shell 展开");
  });

  test("--env 里出现密钥样 key → 拒（密钥只能走 --secret 符号名）", async () => {
    const c = cli();
    expect(
      await c.run(["plan", "--purpose", "塞密钥", "--env", "HF_API_KEY=sk-real", "--json", "--", ...OK]),
    ).toBe(1);
    expect(c.errText()).toContain("secretRefs");
    // 最要紧的一条：密钥值不许出现在任何输出里。
    expect(c.errText()).not.toContain("sk-real");
  });

  test("上传命中 deny-list → fail-closed（不是静默跳过）", async () => {
    const c = cli();
    writeFileSync(join(c.workspace, ".env"), "SECRET=1\n");
    expect(
      await c.run(["plan", "--purpose", "传密钥文件", "--upload", ".env", "--json", "--", ...OK]),
    ).toBe(1);
    expect(c.errText()).toContain("密钥模式");
  });

  test("不需要审批的 plan（不计费 + network=none + 无密钥）停在 planned，L-3 说了算不是调用方说了算", async () => {
    const c = cli();
    expect(await c.run(["plan", "--purpose", "本地纯算", "--json", "--", "/bin/echo", "hi"])).toBe(0);
    const { job } = c.json<JobPayload>();
    expect(job.plan.approvalRequired).toBe(false);
    expect(job.lifecycle.execution).toBe("planned");
  });
});

describe("compute CLI · 审批链（approve / reject / run）", () => {
  test("approve → run：落 decision record，approval 被一次性消费，任务跑到 succeeded", async () => {
    const c = cli();
    const { job } = await planned(c);

    expect(await c.run(["approve", job.jobId, "--note", "我看过命令了", "--json"])).toBe(0);
    const approved = c.json<JobPayload>();
    expect(approved.decisionId).toBeTruthy();
    expect(approved.job.lifecycle.execution).toBe("approved");
    expect(approved.job.approval!.actor).toBe("测试员");
    expect(approved.job.approval!.planDigest).toBe(job.plan.digest);
    c.reset();

    expect(await c.run(["run", job.jobId, "--json"])).toBe(0);
    const ran = c.json<JobPayload>();
    expect(ran.job.lifecycle.execution).toBe("succeeded");
    expect(ran.job.exitCode).toBe(0);
    // 一次性消费：approval 已经不在了，consumedApproval 留档。
    expect(ran.job.approval).toBeNull();
    expect(ran.job.consumedApproval).not.toBeNull();
  }, 30_000);

  test("**未经审批不能 run**：直接 run 一个 awaiting_approval 的任务 → 拒，且没有任何后门可绕", async () => {
    const c = cli();
    const { job } = await planned(c);
    expect(await c.run(["run", job.jobId, "--json"])).toBe(1);
    expect(c.errText()).toContain("未经 approve 不能派发");
    // 状态没被推进，也没有任何 adapterHandle——「拒绝」是真的什么都没做。
    c.reset();
    expect(await c.run(["status", job.jobId, "--json"])).toBe(0);
    const after = c.json<JobPayload>();
    expect(after.job.lifecycle.execution).toBe("awaiting_approval");
  });

  test("approve --run：批准与派发在一条命令里，approval 仍然只被消费一次", async () => {
    const c = cli();
    const { job } = await planned(c);
    expect(await c.run(["approve", job.jobId, "--run", "--json"])).toBe(0);
    const done = c.json<JobPayload>();
    expect(done.job.lifecycle.execution).toBe("succeeded");
    expect(done.job.approval).toBeNull();
    expect(done.job.consumedApproval).not.toBeNull();
    c.reset();
    // 再 run 一次：approval 已经被消费，必须重新审批才能重派。
    expect(await c.run(["run", job.jobId, "--json"])).toBe(1);
  }, 30_000);

  test("reject 必须给理由，落 decision record，任务进 rejected", async () => {
    const c = cli();
    const { job } = await planned(c);
    expect(await c.run(["reject", job.jobId, "--json"])).toBe(1);
    c.reset();
    expect(await c.run(["reject", job.jobId, "--reason", "命令里有我不认识的参数", "--json"])).toBe(0);
    const rejected = c.json<JobPayload>();
    expect(rejected.job.lifecycle.execution).toBe("rejected");
    expect(rejected.decisionId).toBeTruthy();
  });
});

describe("compute CLI · V19 终端门（piping 必拒）", () => {
  const TOKEN_ENV = "SPARK_RESEARCH_COMPUTE_CI_BYPASS_TOKEN";

  test("非交互环境 + 未配置旁路 token → approve 拒绝，且**不落任何 decision record**", async () => {
    const c = cli({ approvalIsInteractiveTty: () => false });
    const { job } = await planned(c);
    expect(await c.run(["approve", job.jobId, "--json"])).toBe(1);
    expect(c.errText()).toContain(TOKEN_ENV);
    c.reset();

    // 门在落 record 之前：被拒的这一次不该留下任何审批痕迹。
    expect(await c.run(["status", job.jobId, "--json"])).toBe(0);
    const after = c.json<JobPayload>();
    expect(after.job.lifecycle.execution).toBe("awaiting_approval");
    expect(after.job.approval).toBeNull();
    const project = c.manager.open("compute-proj");
    expect(project.records().list({ type: "decision" })).toHaveLength(0);
    project.close();
  });

  test("piping 一个 'yes' 进来也没用：非 TTY 就是非 TTY", async () => {
    const c = cli({ approvalIsInteractiveTty: () => false, approvalConfirm: async () => "yes" });
    const { job } = await planned(c);
    expect(await c.run(["approve", job.jobId, "--json"])).toBe(1);
    expect(c.errText()).toContain("[V19]");
  });

  test("交互终端里没敲 'yes' → 取消", async () => {
    const c = cli({ approvalConfirm: async () => "no" });
    const { job } = await planned(c);
    expect(await c.run(["approve", job.jobId, "--json"])).toBe(1);
    expect(c.errText()).toContain("没有收到 'yes'");
  });

  test("CI 旁路三样齐全 → 放行，且旁路事实写进 decision record（留痕，不是静默通过）", async () => {
    const c = cli({
      approvalIsInteractiveTty: () => false,
      env: { [TOKEN_ENV]: "correct-token" },
    });
    const { job } = await planned(c);
    expect(
      await c.run([
        "approve",
        job.jobId,
        "--ci-bypass-token",
        "correct-token",
        "--ci-bypass-reason",
        "CI 集成测试需要跑通算力闭环",
        "--json",
      ]),
    ).toBe(0);
    const approved = c.json<JobPayload>();
    expect(approved.job.approval!.note).toContain("CI 旁路");
    expect(approved.job.approval!.note).toContain("CI 集成测试需要跑通算力闭环");

    // 留痕要落到磁盘上的 decision record 里，不是只打印一行。
    const project = c.manager.open("compute-proj");
    const decisions = project.records().list({ type: "decision" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.content).toContain("CI 旁路");
    project.close();
  });

  test("湿实验的 CI token 旁路不了算力门（两把钥匙互不通用）", async () => {
    const c = cli({
      approvalIsInteractiveTty: () => false,
      env: { SPARK_LAB_CI_BYPASS_TOKEN: "lab-token" },
    });
    const { job } = await planned(c);
    expect(
      await c.run([
        "approve",
        job.jobId,
        "--ci-bypass-token",
        "lab-token",
        "--ci-bypass-reason",
        "我有 lab 的 token",
        "--json",
      ]),
    ).toBe(1);
    expect(c.errText()).toContain(TOKEN_ENV);
  });
});

describe("compute CLI · status / list / collect / cancel / release", () => {
  test("status 打印三段审批（approval / consumedApproval / supersededApproval）", async () => {
    const c = cli();
    const { job } = await planned(c);
    expect(await c.run(["status", job.jobId])).toBe(0);
    expect(c.text()).toContain(job.jobId);
    expect(c.text()).toContain("awaiting_approval");
    expect(c.text()).toContain("等待人工审批");
    c.reset();

    // 批准之后：未消费的 approval 那一段出现。
    expect(await c.run(["approve", job.jobId])).toBe(0);
    expect(c.text()).toContain("测试员");
    expect(c.text()).toContain("未消费");
    c.reset();

    // 派发之后：approval 那一段消失，consumedApproval 那一段出现。
    expect(await c.run(["run", job.jobId])).toBe(0);
    c.reset();
    expect(await c.run(["status", job.jobId])).toBe(0);
    expect(c.text()).toContain("已消费的审批");
    expect(c.text()).not.toContain("未消费");
  });

  test("list 可按 execution 状态过滤；未知状态 → 用法错误", async () => {
    const c = cli();
    await planned(c);
    await planned(c);
    expect(await c.run(["list", "--json"])).toBe(0);
    expect(c.json<{ jobs: unknown[] }>().jobs).toHaveLength(2);
    c.reset();
    expect(await c.run(["list", "--state", "succeeded", "--json"])).toBe(0);
    expect(c.json<{ jobs: unknown[] }>().jobs).toHaveLength(0);
    c.reset();
    expect(await c.run(["list", "--state", "不存在的状态"])).toBe(1);
  });

  test("collect 把产物落到 <job>/harvest/，delivery 推进到 complete", async () => {
    const c = cli();
    const { job } = await planned(c);
    expect(await c.run(["approve", job.jobId, "--run", "--json"])).toBe(0);
    const ran = c.json<JobPayload>();
    // 执行终态之后 delivery 仍是 none：收割是**另一步**（L-5），不是 run 的副作用。
    expect(ran.job.lifecycle.execution).toBe("succeeded");
    expect(ran.job.lifecycle.delivery).toBe("none");
    expect(ran.next).toContain("compute collect");
    c.reset();

    expect(await c.run(["collect", job.jobId, "--json"])).toBe(0);
    const collected = c.json<JobPayload & { harvest: { files: Array<{ path: string }> } }>();
    expect(collected.harvest.files.map((f) => f.path)).toContain("out.txt");
    expect(collected.job.lifecycle.delivery).toBe("complete");
    expect(existsSync(join(collected.job.jobDir, "harvest", "out.txt"))).toBe(true);
    // 上传的那份也确实进了 job 的 workspace（只有 plan.uploads 里的文件才会进去）。
    expect(readFileSync(join(collected.job.jobDir, "workspace", "input.txt"), "utf8")).toContain("hello compute");
  }, 30_000);

  test("release 在产物只剩远端那一份时被拒（L-4），collect 之后才放行", async () => {
    const c = cli();
    const { job } = await planned(c);
    expect(await c.run(["approve", job.jobId, "--run", "--json"])).toBe(0);
    c.reset();

    // 还没收割：recoverable=true，close 必须抛（不许关掉持有唯一副本的资源）。
    expect(await c.run(["release", job.jobId, "--json"])).toBe(1);
    c.reset();

    expect(await c.run(["collect", job.jobId, "--json"])).toBe(0);
    c.reset();
    expect(await c.run(["release", job.jobId, "--json"])).toBe(0);
    expect(c.json<JobPayload>().job.lifecycle.resource).toBe("closed");
  }, 30_000);

  test("release --discard：放弃产物是一次显式的人的决定，不是资源清理的副作用", async () => {
    const c = cli();
    const { job } = await planned(c);
    expect(await c.run(["approve", job.jobId, "--run", "--json"])).toBe(0);
    c.reset();
    expect(await c.run(["release", job.jobId, "--discard", "这次跑错了参数，产物不要了", "--json"])).toBe(0);
    const released = c.json<JobPayload>();
    expect(released.job.lifecycle.delivery).toBe("rejected");
    expect(released.job.lifecycle.resource).toBe("closed");
  }, 30_000);

  test("cancel 一个还没跑的任务 → cancelled 终态", async () => {
    const c = cli();
    const { job } = await planned(c);
    expect(await c.run(["cancel", job.jobId, "--json"])).toBe(0);
    expect(c.json<JobPayload>().job.lifecycle.execution).toBe("cancelled");
  });

  test("查不到的 jobId → 明确报错，退出码 1（不是静默返回空）", async () => {
    const c = cli();
    expect(await c.run(["status", "cj-不存在"])).toBe(1);
    expect(c.errText()).toContain("没有这个算力任务");
  });
});

describe("compute CLI · targets 与「未配置」口径", () => {
  test("没配 Modal 凭据时报「未配置」——不是「不可用」也不是「可用」，并给出配置指引", async () => {
    const c = cli();
    expect(await c.run(["targets", "--json"])).toBe(0);
    const { targets } = c.json<{ targets: Array<Record<string, unknown>> }>();
    const modal = targets.find((t) => t.kind === "modal")!;
    expect(modal.availability).toBe("needs_credential");
    expect(modal.credentialConfigured).toBe(false);
    expect(String(modal.setupHint)).toContain("credentials.json");
    // local 是默认，且真的可用（CI 零凭据能走完整审批链靠的就是它）。
    const local = targets.find((t) => t.kind === "local")!;
    expect(local.availability).toBe("available");
    expect(local.isDefault).toBe(true);
    // ssh 只有槽位。
    expect(targets.find((t) => t.kind === "ssh")!.availability).toBe("placeholder");
  });

  test("配了凭据但注册表里没有 adapter → 仍然**不许**报 available（AD-12）", () => {
    const withToken: CredentialProvider = {
      has: (id) => id === MODAL_CREDENTIAL_ID,
      get: () => ({ token_id: "x", token_secret: "y" }),
    };
    const views = computeTargetViews({ adapters: defaultComputeAdapters(), credentials: withToken });
    const modal = views.find((t) => t.kind === "modal")!;
    expect(modal.credentialConfigured).toBe(true);
    expect(modal.availability).not.toBe("available");
    expect(modal.reason).toContain("没有装载 Modal adapter");
  });

  test("默认注册表只有 local——modal adapter 是 W5-2 α 的交付，这里如实反映", () => {
    expect(Object.keys(defaultComputeAdapters())).toEqual(["local"]);
  });

  test("plan --target modal 在没有 adapter 时明确失败（不假装排到队里了）", async () => {
    const c = cli();
    expect(
      await c.run(["plan", "--purpose", "试试 modal", "--target", "modal", "--json", "--", ...OK]),
    ).toBe(1);
    expect(c.errText()).toContain("modal");
  });
});

describe("compute CLI · 用法", () => {
  test("help 打印帮助；未知子命令 → 帮助 + 退出码 1", async () => {
    const c = cli();
    expect(await c.run(["help"])).toBe(0);
    expect(c.text()).toBe(COMPUTE_HELP);
    c.reset();
    expect(await c.run(["不存在的子命令"])).toBe(1);
    expect(c.errText()).toContain("未知的 compute 子命令");
  });

  test("十个子命令都在帮助里有一行（自描述面不许漏报）", () => {
    for (const sub of [
      "plan",
      "approve",
      "reject",
      "run",
      "status",
      "list",
      "collect",
      "cancel",
      "release",
      "targets",
    ]) {
      expect(COMPUTE_HELP, `帮助里没有 ${sub}`).toContain(`compute ${sub}`);
    }
  });
});
