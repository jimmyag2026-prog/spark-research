import { relative } from "node:path";

// 脚手架模板（P9 交付物 2）。
//
// 一条纪律贯穿全部模板：**生成的东西必须当场能跑**。
// 每个模板都带一个可执行的测试桩，而不是 `// TODO: 写测试`——
// 一个跑不起来的模板等于让使用者从调试别人的骨架开始，比没有模板更糟。
//
// import 路径用 `relative()` 现算：模板既可能被生成到仓库内的标准位置
// （得到 `../connectors/base` 这样的短路径），也可能被生成到别处
// （CI 的脚手架测试就是这么用的），两种情况都要解析得到。

export interface TemplateContext {
  // 资源名（kebab-case）
  name: string;
  // 驼峰类名前缀
  className: string;
  // 目标文件所在目录（绝对路径）
  targetDir: string;
  // 测试文件所在目录（绝对路径）
  testDir: string;
  // 仓库根（绝对路径）
  repoRoot: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

// 从 `from` 目录 import 仓库内 `to`（相对仓库根的路径），保证以 ./ 或 ../ 开头。
export function importPath(from: string, toRelativeToRepo: string, repoRoot: string): string {
  const target = `${repoRoot}/${toRelativeToRepo}`;
  const rel = relative(from, target);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

export function toClassName(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

// ── Skill ────────────────────────────────────────────────────────────────────

export function skillTemplate(ctx: TemplateContext): GeneratedFile[] {
  const testRel = relative(ctx.repoRoot, `${ctx.testDir}/skill_${ctx.name.replace(/-/g, "_")}.test.ts`);
  const frontmatterRel = importPath(ctx.testDir, "backend/src/skills/frontmatter", ctx.repoRoot);
  return [
    {
      path: `${ctx.targetDir}/SKILL.md`,
      content: `---
name: ${ctx.name}
description: "一句话说清这个技能**做什么**，再说清**什么情况下该用它**。写具体：agent 只读这一段就要能判断要不要加载，含糊的描述会让它在不该用的时候用。"
category: literature
domain: A
triggers: [用户会怎么开口, 另一种说法, 第三种说法]
connectors: []
validation: [${testRel}]
allowed-tools: [Bash, Read, Write]
---

# ${ctx.name}

## 何时用这个技能

- （列出具体场景，不是能力描述）

**不适用**：（写清边界——说清什么时候**不**该用，比说清用法更能防止越界）

## 能力边界（先读这段，别做超出的承诺）

| 依赖 | 是否需要凭据 | 已知限制 |
|------|------------|---------|
| （connector / 平台 / 后端） | 否 | （实测发现的坑写在这里） |

## 工作流

### 1. （第一步）

\`\`\`bash
spark-research <command> ...
\`\`\`

### 2. （第二步）

## 反模式

- ❌ （最容易犯的错）
- ❌ 把失败的源静默吞掉后声称「已全面检索」
- ❌ 凭记忆补全缺失字段——缺就标「未知」

## 验证方式（AD-5：技能必须有配套验证）

- 单测：\`${testRel}\`
`,
    },
    {
      path: `${ctx.testDir}/skill_${ctx.name.replace(/-/g, "_")}.test.ts`,
      content: `import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFrontmatter } from "${frontmatterRel}";

// ${ctx.name} 技能的配套验证（AD-5）。
//
// 先跑通这一条（frontmatter 合规），再把技能真正的行为验证加进来——
// 「技能文档写了什么」与「文档说的能力真的存在」是两件事，后者才是 AD-5 要的。

const SKILL_PATH = join(import.meta.dir, "${relative(ctx.testDir, ctx.targetDir)}", "SKILL.md");

describe("${ctx.name} · SKILL.md", () => {
  test("frontmatter 合规", () => {
    const fm = parseSkillFrontmatter(readFileSync(SKILL_PATH, "utf8"), { path: SKILL_PATH });
    expect(fm.name).toBe("${ctx.name}");
    expect(fm.triggers.length).toBeGreaterThan(0);
  });

  test("文档写了反模式小节（说清边界比说清用法更重要）", () => {
    expect(readFileSync(SKILL_PATH, "utf8")).toContain("## 反模式");
  });

  // TODO: 把这个技能声称的能力逐条验起来。
  // 例：技能说「检索失败时会明确报告 failed 而不是静默吞掉」——那就写一个
  //     注入失败源的用例，断言结果里 outcome === "failed"。
});
`,
    },
  ];
}

// ── Connector ────────────────────────────────────────────────────────────────

export function connectorTemplate(ctx: TemplateContext, options: { withCredentials: boolean }): GeneratedFile[] {
  const baseRel = importPath(ctx.targetDir, "backend/src/connectors/base", ctx.repoRoot);
  const politenessRel = importPath(ctx.targetDir, "backend/src/connectors/politeness", ctx.repoRoot);
  const connectorRel = importPath(ctx.testDir, relative(ctx.repoRoot, ctx.targetDir) + `/${ctx.name}`, ctx.repoRoot);
  const credentialsRel = importPath(ctx.testDir, "backend/src/daemon/credentials", ctx.repoRoot);
  // 带凭据的 connector 在没有凭据时会走降级路径（不发请求），所以通用用例要先配上 key。
  const credentialArg = options.withCredentials ? "\n      credentials: withKey()," : "";

  const credentialBits = options.withCredentials
    ? `
  // 凭据分层（AD-2）：connector **只声明自己需要什么**，值本体由 daemon 内的
  // CredentialStore 提供。这里能拿到值，是因为 connector 本来就跑在 daemon 进程里；
  // kernel / 沙箱子进程永远拿不到——它们只能请 daemon 代为访问。
  private credential(): string | null {
    const values = this.options.credentials?.get("${ctx.name}") ?? null;
    return values?.api_key ?? null;
  }

  protected headersFor(): Record<string, string> {
    const key = this.credential();
    return {
      ...politeHeaders({ userAgent: this.options.userAgent }),
      // 没配凭据时**不要**塞一个空 Authorization 头：那会让 401 变成一个更难查的 400。
      ...(key ? { Authorization: \`Bearer \${key}\` } : {}),
    };
  }

  // 未配置凭据时的统一降级：明确回「未配置」，不是抛错。
  // 统一检索据此把这个源标成 skipped 而不是 failed——**未配置不是失败**。
  //
  // 用构造函数里 \`this.handle("search", ...)\` 显式把这个方法注册成 "search" 工具的
  // handler，而不是靠方法名与 tool 名相同被基类自动发现——「同名方法即 handler」的
  // 魔法分发在 v0.3 已经移除：并发调用下它会让参数映射 / 凭据检查被静默跳过（P10-a
  // 修的 P0 缺陷）。落到通用 URL 拼装路径时调 \`this.requestRaw(...)\`——**不要**再经
  // 基类 \`call()\` 转一趟：对 "search" 那会重新命中刚注册的这个 handler，自己调自己，
  // 死循环。
  private async searchImpl(params: Record<string, unknown>): Promise<unknown> {
    if (!this.credential()) {
      return { configured: false, source: "${ctx.name}", results: [], note: "未配置凭据：spark-research 里为 ${ctx.name} 配置 api_key 后可用" };
    }
    return this.requestRaw("search", params);
  }
`
    : `
  protected headersFor(): Record<string, string> {
    // 礼貌头：免 key 的公共 API 靠它认出你是谁。别硬编码个人邮箱——
    // 走配置（spark-research config set contactEmail you@lab.edu）。
    return politeHeaders({ userAgent: this.options.userAgent, contactEmail: this.options.contactEmail });
  }
`;

  const constructorHandlerRegistration = options.withCredentials
    ? `\n    this.handle("search", (p) => this.searchImpl(p));`
    : "";

  return [
    {
      path: `${ctx.targetDir}/${ctx.name}.ts`,
      content: `import { HttpConnector, type ConnectorOptions, type HttpConnectorConfig } from "${baseRel}";
import { politeHeaders } from "${politenessRel}";

// ${ctx.name} connector。
//
// 契约只有三件事：
//   1. 一份 HttpConnectorConfig（baseUrl + tools + metadata）
//   2. 可选的 headersFor / queryFor 覆写（礼貌头、鉴权头、mailto）
//   3. 需要自定义解析时：在构造函数里 \`this.handle(toolName, fn)\` 显式注册 handler，
//      handler 内部落到通用路径时调 \`this.requestRaw(toolName, params)\`——**不要**再
//      经基类 \`call()\` 转一趟，对同一个 toolName 那会重新命中刚注册的 handler，
//      自己调自己，死循环。也**不要**靠「方法名与 tool 名相同」让基类自动发现——这套
//      魔法反射分发在 v0.3 已经移除，并发调用下它会让参数映射 / 凭据检查被静默跳过。
// 除此之外什么都不用做——HTTP 调用、路径参数替换、错误处理都在基类里。

export const ${ctx.name.replace(/-/g, "")}Config: HttpConnectorConfig = {
  baseUrl: "https://api.example.org/v1",
  description: "（一句话说清这个源覆盖什么、有什么不覆盖）",
  tools: [
    {
      name: "search",
      description: "检索。参数示例：{ q: 'crispr off-target', limit: 10 }",
      endpoint: "/search",
    },
    {
      name: "getRecord",
      // 路径参数用 {name} 占位，基类会用同名入参替换并 URL-encode。
      description: "按 id 取单条。参数示例：{ id: 'ABC123' }",
      endpoint: "/records/{id}",
    },
  ],
  metadata: {
    domain: "api.example.org",
    apiKeyRequired: ${options.withCredentials},
    status: "available",
    // 实测发现的坑写这里：它会原样出现在 \`spark-research capabilities\` 里，
    // 让使用者在选源之前就知道会撞什么墙。
    // caveat: "匿名调用限流严格，高频会 429",
  },
};

export class ${ctx.className}Connector extends HttpConnector {
  constructor(options: ConnectorOptions = {}) {
    super("${ctx.name}", ${ctx.name.replace(/-/g, "")}Config, options);${constructorHandlerRegistration}
  }
${credentialBits}}
`,
    },
    {
      path: `${ctx.testDir}/connector_${ctx.name.replace(/-/g, "_")}.test.ts`,
      content: `import { describe, expect, test } from "bun:test";
import { ${ctx.className}Connector } from "${connectorRel}";
${options.withCredentials ? `import { CredentialStore } from "${credentialsRel}";\nimport { mkdtempSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\n` : ""}
// ${ctx.name} connector 的契约测试。
//
// 纪律：**不打真实网络**。注入一个假的 HttpClient，断言「发出去的请求长什么样」
// 与「响应被怎么解析」。真实验证只在本地跑一次并录制成 fixture（见 tests/fixtures/）。

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function fakeHttp(payload: unknown, captured: Captured[]) {
  return {
    request: async (url: string, init?: { headers?: Record<string, string> }) => {
      captured.push({ url, headers: init?.headers ?? {} });
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    },
  };
}

${
  options.withCredentials
    ? `// 带凭据的 connector 在**没有**凭据时会走降级路径（不发请求），
// 所以除了那条专门验降级的用例，其余用例都要先把凭据配上。
function withKey() {
  const root = mkdtempSync(join(tmpdir(), "scaffold-cred-"));
  const store = new CredentialStore({ root });
  store.set("${ctx.name}", { api_key: "sk-test-secret" });
  return store;
}
`
    : ""
}
describe("${ctx.name} connector", () => {
  test("工具清单与 endpoint 形态", () => {
    const connector = new ${ctx.className}Connector();
    const tools = connector.listTools();
    expect(tools.map((t) => t.name)).toContain("search");
    // 每个工具都要有描述——没描述的工具在 capabilities 里就是一个谜。
    expect(tools.every((t) => t.description.length > 0)).toBe(true);
  });

  test("查询参数进 URL，礼貌头进 headers", async () => {
    const captured: Captured[] = [];
    const connector = new ${ctx.className}Connector({
      http: fakeHttp({ results: [] }, captured) as never,${credentialArg}
    });
    await connector.call("search", { q: "crispr", limit: 5 });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toContain("q=crispr");
    expect(captured[0]!.url).toContain("limit=5");
    expect(captured[0]!.headers["User-Agent"]).toContain("spark-research");
  });

  test("路径参数被替换而不是拼成查询串", async () => {
    const captured: Captured[] = [];
    const connector = new ${ctx.className}Connector({
      http: fakeHttp({ id: "ABC123" }, captured) as never,${credentialArg}
    });
    await connector.call("getRecord", { id: "ABC123" });
    expect(captured[0]!.url).toContain("/records/ABC123");
    expect(captured[0]!.url).not.toContain("id=ABC123");
  });

  test("未知工具名报错并列出可用工具", async () => {
    const connector = new ${ctx.className}Connector();
    await expect(connector.call("nosuch", {})).rejects.toThrow(/Available/);
  });
${
  options.withCredentials
    ? `
  test("未配置凭据 → 明确回「未配置」而不是抛错（统一检索据此标 skipped）", async () => {
    const connector = new ${ctx.className}Connector();
    const result = (await connector.call("search", { q: "x" })) as { configured: boolean };
    expect(result.configured).toBe(false);
  });

  test("配置凭据后带上鉴权头，且凭据值不出现在任何错误消息里（AD-2）", async () => {
    const store = withKey();
    const captured: Captured[] = [];
    const connector = new ${ctx.className}Connector({
      http: fakeHttp({ results: [] }, captured) as never,
      credentials: store,
    });
    await connector.call("search", { q: "x" });
    expect(captured[0]!.headers.Authorization).toBe("Bearer sk-test-secret");

    // 失败路径不许回显请求头或响应体（里面可能有凭据）。
    const failing = new ${ctx.className}Connector({
      credentials: store,
      http: {
        request: async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "sk-test-secret leaked" }),
      } as never,
    });
    await expect(failing.call("getRecord", { id: "x" })).rejects.toThrow(/HTTP 401/);
    await failing.call("getRecord", { id: "x" }).catch((error: Error) => {
      expect(error.message).not.toContain("sk-test-secret");
    });
  });
`
    : ""
}});
`,
    },
  ];
}

// ── SimulationPlatform ───────────────────────────────────────────────────────

export function platformTemplate(ctx: TemplateContext): GeneratedFile[] {
  const platformRel = importPath(ctx.targetDir, "backend/src/simulation/platform", ctx.repoRoot);
  const contractRel = importPath(ctx.testDir, "tests/helpers/simulation_contract", ctx.repoRoot);
  const implRel = importPath(ctx.testDir, relative(ctx.repoRoot, ctx.targetDir) + "/index", ctx.repoRoot);

  return [
    {
      path: `${ctx.targetDir}/index.ts`,
      content: `import { join } from "node:path";
import {
  SubprocessSimulationPlatform,
  numberParam,
  type NormalizedSpec,
  type SubprocessPlatformOptions,
} from "${platformRel}";

// ${ctx.name} 仿真平台（AD-4：仿真是长任务生命周期，与 connector 的幂等读取是两种契约）。
//
// 继承 SubprocessSimulationPlatform 就只剩三个抽象方法要实现：
//   normalize()     参数归一化 + 预期产出清单（非法参数当场抛 SimulationSpecError）
//   entryPointFor() runner 脚本路径
//   probeCode()     可用性探测（一段跑得通就算可用的 python）
// prepare/submit/poll/collect/cancel 的生命周期、磁盘状态真源、断点续跑
// 都在基类里，**不要**在子类里重新发明。
//
// 三条来自 P5 实测的硬要求：
//   1. submit 不阻塞（基类保证）——编排进程被杀，任务还得活着。
//   2. runner 自己写 done.json，且**写完结果才退出**；poll 先看 done.json 再看 pid。
//   3. deterministic 位要诚实：同一 spec 逐位可复现才是 true。
//      填错会让下游结论用「逐位对账」的措辞去描述一个不可复现的结果。

export const ${ctx.name.replace(/-/g, "")}Kinds = ["demo-run"] as const;

export class ${ctx.className}Platform extends SubprocessSimulationPlatform {
  readonly id = "${ctx.name}";
  readonly deterministic = true;
  readonly description = "（一句话说清这个平台算什么、依赖什么）";
  readonly kinds = ${ctx.name.replace(/-/g, "")}Kinds;

  constructor(options: SubprocessPlatformOptions) {
    super(options);
  }

  protected entryPointFor(): string {
    return join(import.meta.dir, "runner.py");
  }

  protected probeCode(): string {
    // 探测要**便宜且真实**：import 一下真正会用到的依赖，别只 print 一句 ok。
    return "import sys, json; print(json.dumps({'python': sys.version.split()[0]}))";
  }

  protected normalize(_kind: string, params: Record<string, unknown>): NormalizedSpec {
    // 归一化的意义：同一个 spec 的 specHash 不受书写顺序与缺省值影响。
    // 参数非法时当场抛（numberParam 会抛 SimulationSpecError）——
    // 宁可在 design 阶段被拒，也不要让 runner 收到 NaN 跑三小时。
    const steps = numberParam(params, "steps", 100, { min: 1, max: 1_000_000, integer: true });
    const scale = numberParam(params, "scale", 1.0, { min: 1e-9 });

    // 警告 ≠ 拒绝。参数合法但大概率跑不通的组合要**提前说**，
    // 而不是等算例跑挂了再让人从 stderr 里猜（契约测试会检查这条）。
    const warnings: string[] = [];
    if (scale > 10) {
      warnings.push(\`scale=\${scale} 会让递推快速发散（value ← value*scale+1），算例可能以 failed 结束\`);
    }
    return {
      params: { steps, scale, stallSeconds: numberParam(params, "stallSeconds", 0, { min: 0, max: 600 }) },
      expectedOutputs: ["series.csv", "final_state.json"],
      warnings,
    };
  }
}
`,
    },
    {
      path: `${ctx.targetDir}/runner.py`,
      content: `#!/usr/bin/env python3
"""${ctx.name} runner。

契约（与 openmm / pyref 的 runner 完全一致）：
  入参   --params <params.json> --outdir <run 目录>
  产出   写到 outdir：声明过的产出文件 + done.json
  纪律   **写完全部结果再写 done.json**，且 done.json 是最后一个动作。
         poll 先看 done.json 再看 pid：结果在就以结果为准，
         所以 done.json 一旦出现就必须意味着「结果已经完整落盘」。
         失败也要写 done.json（status=failed + error），否则编排侧只能猜。
"""

import argparse
import json
import math
import os
import time
from pathlib import Path


def wall_seconds(started: float) -> float:
    """墙钟耗时。**下限 1 µs**：秒级以下的算例四舍五入成 0.0 会让
    「跑过」与「没跑」在下游看起来一样，契约测试也会因此变成 flaky。"""
    return round(max(time.time() - started, 1e-6), 6)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--params", required=True)
    parser.add_argument("--outdir", required=True)
    args = parser.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    params = json.loads(Path(args.params).read_text())
    started = time.time()
    started_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started))

    try:
        steps = int(params["steps"])
        scale = float(params["scale"])
        # 契约测试需要一条「参数合法但算例会跑很久」的路径来验 cancel/超时。
        stall = float(params.get("stallSeconds", 0) or 0)
        if stall > 0:
            time.sleep(stall)

        # 往 stdout 写进展：编排进程被杀之后，stdout.log 是唯一能回答
        # 「任务当时跑到哪了」的东西（基类把 stdout 直接落文件而不是 pipe）。
        print(f"[${ctx.name}] start steps={steps} scale={scale}", flush=True)

        rows = ["step,value"]
        value = 1.0
        for i in range(steps):
            value = value * scale + 1.0
            # 真实的失败模式：递推发散成 inf/nan。契约测试要的 failingSpec 就是这条路径
            # ——参数本身合法，是算例自己跑挂的。人为的 error 开关验不出真实的失败处理。
            if not math.isfinite(value):
                raise ValueError(f"数值发散：第 {i} 步 value 变成 {value}，检查 scale={scale}")
            rows.append(f"{i},{value:.6f}")
        (outdir / "series.csv").write_text("\\n".join(rows) + "\\n")
        (outdir / "final_state.json").write_text(json.dumps({"steps": steps, "final": value}, indent=2) + "\\n")
        print(f"[${ctx.name}] done final={value:.6f}", flush=True)

        done = {
            "status": "completed",
            "startedAt": started_iso,
            "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "wallSeconds": wall_seconds(started),
            "summary": {"steps": steps, "final": round(value, 6)},
            "files": [
                {"filename": "series.csv", "role": "data"},
                {"filename": "final_state.json", "role": "state"},
            ],
        }
    except Exception as exc:  # noqa: BLE001 —— 失败也必须留下终态
        print(f"[${ctx.name}] failed: {exc}", flush=True)
        done = {
            "status": "failed",
            "error": f"{type(exc).__name__}: {exc}",
            "startedAt": started_iso,
            "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "wallSeconds": wall_seconds(started),
        }

    # 原子写：先写临时文件再 rename，避免 poll 读到半个 JSON。
    tmp = outdir / "done.json.tmp"
    tmp.write_text(json.dumps(done, indent=2) + "\\n")
    os.replace(tmp, outdir / "done.json")
    return 0 if done["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
`,
    },
    {
      path: `${ctx.testDir}/platform_${ctx.name.replace(/-/g, "_")}.test.ts`,
      content: `import { ${ctx.className}Platform } from "${implRel}";
import { describeSimulationContract } from "${contractRel}";

// ${ctx.name} 的验收 = **直接复用 P5 的契约测试套件**（DEVELOPMENT_PLAN P9 明确要求）。
// 新平台不需要自己发明一套测试：把 case 填对，openmm/pyref 过的那些
// （幂等 prepare、非阻塞 submit、poll 状态机、collect 校验产出、cancel、
// 参数非法当场拒、算例失败与进程丢失可分辨）就全都会跑在你的实现上。
//
// 填 case 时最容易错的两处：
//   failingSpec —— 要一条**参数合法但算例真的会失败**的路径（数值发散、约束冲突），
//                  不是人为的 error 开关。假的失败开关验不出真实的失败处理。
//   slowSpec    —— 要跑得足够久，让 cancel 有机会打断它。

describeSimulationContract({
  name: "${ctx.name}",
  make: (root: string) => new ${ctx.className}Platform({ root }),
  okSpec: { platform: "${ctx.name}", kind: "demo-run", params: { steps: 50 } },
  // 显式写出默认值 + 换书写顺序：归一化后必须与 okSpec 得到同一个 specHash。
  equivalentSpec: { platform: "${ctx.name}", kind: "demo-run", params: { scale: 1, steps: 50, stallSeconds: 0 } },
  differentSpec: { platform: "${ctx.name}", kind: "demo-run", params: { steps: 80 } },
  slowSpec: { platform: "${ctx.name}", kind: "demo-run", params: { steps: 10, stallSeconds: 8 } },
  failingSpec: { platform: "${ctx.name}", kind: "demo-run", params: { steps: 5, scale: 1e300 } },
  invalidSpec: { platform: "${ctx.name}", kind: "demo-run", params: { steps: -1 } },
  expectedOutputs: ["series.csv", "final_state.json"],
  summaryKeys: ["steps", "final"],
  runTimeoutMs: 60_000,
});
`,
    },
  ];
}
