// W4-d · `ext verify` 对 kind="mcp_client" 的契约化验收（AD-11 在装载强度③上的落点）。
//
// 与 connector/platform/rule/skill 四类不同的地方：这一类的"契约测试"天然需要真的
// 启动一次外部进程（listTools() 本身就是跟它握手才能问出来的信息）——这与
// platform/skill verify"跑一遍真实契约测试需要执行扩展代码"是同一类必然性，
// 不是本文件的疏漏。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerifyCheck } from "./connector_verify";
import { loadMcpClientConfig, McpClientConfigError, connectExternalMcp, readMcpCallRecords } from "./mcp_client";
import { ExtensionGrantStore } from "./grants";
import type { ExtensionManifest } from "./types";

export interface McpClientVerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}

export async function verifyMcpClientExtension(extensionDir: string, manifest: ExtensionManifest): Promise<McpClientVerifyResult> {
  const checks: VerifyCheck[] = [];
  const mcpJsonPath = join(extensionDir, "mcp.json");
  if (!existsSync(mcpJsonPath)) {
    return { ok: false, checks: [{ name: "mcp.json 存在", ok: false, detail: `找不到 ${mcpJsonPath}` }] };
  }

  let config;
  try {
    config = loadMcpClientConfig(readFileSync(mcpJsonPath, "utf8"));
    checks.push({ name: "mcp.json 校验", ok: true });
  } catch (error) {
    checks.push({ name: "mcp.json 校验", ok: false, detail: error instanceof McpClientConfigError ? error.message : String(error) });
    return { ok: false, checks };
  }

  // 注意：这里**没有**接入真实的 CredentialStore（`ext verify` 是独立 CLI 调用，
  // 不经过 daemon）。如果 manifest 声明了 requires.credentials，resolveMcpChildEnv
  // 会因为"没有 deps.credentials"而把对应变量当作"未授权"处理——子进程拿不到
  // 任何凭据。这是已知限制（如实记录在 devlog），不是"验证通过"暗示凭据链路
  // 被覆盖了。
  const grantStore = new ExtensionGrantStore();
  const grant = grantStore.get(manifest.name);

  const connectResult = await connectExternalMcp({ manifest, config, grant });
  if (!connectResult.ok || !connectResult.session) {
    checks.push({ name: "连接 + 发现工具", ok: false, detail: connectResult.reason ?? "未知原因" });
    return { ok: false, checks };
  }

  const session = connectResult.session;
  const toolsOk = session.tools.length > 0 && session.tools.every((t) => typeof t.name === "string" && t.name.length > 0);
  checks.push({
    name: "连接 + 发现工具",
    ok: toolsOk,
    detail: toolsOk ? undefined : "listTools() 返回了零个工具，或工具名非法（外部 server 不符合最基本的 MCP 契约）",
  });

  if (config.verifySample) {
    const before = readMcpCallRecords(manifest.name).length;
    const outcome = await session.call(config.verifySample.tool, config.verifySample.args ?? {});
    const after = readMcpCallRecords(manifest.name).length;
    checks.push({
      name: `verifySample 往返调用（${config.verifySample.tool}）`,
      ok: outcome.ok,
      detail: outcome.ok ? undefined : JSON.stringify(outcome.payload),
    });
    checks.push({
      name: "执行记录确实落盘（相对 OpenScience 的差异化点）",
      ok: after > before,
      detail: after > before ? undefined : `调用前后 .mcp_calls.jsonl 记录数没有增加（${before} → ${after}）`,
    });
  } else {
    checks.push({
      name: "verifySample 往返调用（mcp.json 未声明 verifySample，跳过——不计入失败）",
      ok: true,
    });
  }

  await session.close();
  return { ok: checks.every((c) => c.ok), checks };
}
