// W2-c · `spark-research ext verify <path>` 的分发器（AD-11 的落点）。
//
// AD-11：扩展"能装上"不算装好，"过得了契约测试"才算。这个文件把四种扩展类型
// 各自的验收逻辑（connector_verify / platform_verify / rule_verify / skill_verify）
// 收口成一个统一入口，供 CLI 与装载器共用（装载时也会跑一遍 verify 来决定要不要
// 打印警告——见 loader.ts）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadExtensionManifest, ExtensionManifestError, type ExtensionKind } from "./types";
import { verifyConnectorExtension, type VerifyCheck } from "./connector_verify";
import { verifyPlatformExtension } from "./platform_verify";
import { verifyRuleExtension } from "./rule_verify";
import { verifySkillExtension } from "./skill_verify";
import { verifyMcpClientExtension } from "./mcp_client_verify";

export type { VerifyCheck } from "./connector_verify";

export interface ExtensionVerifyResult {
  ok: boolean;
  name: string | null;
  kind: ExtensionKind | null;
  checks: VerifyCheck[];
}

function fail(name: string | null, kind: ExtensionKind | null, checkName: string, detail: string): ExtensionVerifyResult {
  return { ok: false, name, kind, checks: [{ name: checkName, ok: false, detail }] };
}

export async function verifyExtension(extensionDir: string): Promise<ExtensionVerifyResult> {
  const manifestPath = join(extensionDir, "extension.json");
  if (!existsSync(manifestPath)) {
    return fail(null, null, "extension.json 存在", `找不到 ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = loadExtensionManifest(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const detail = error instanceof ExtensionManifestError ? error.message : String(error);
    return fail(null, null, "extension.json 校验", detail);
  }

  switch (manifest.kind) {
    case "connector": {
      const result = await verifyConnectorExtension(extensionDir);
      return { ok: result.ok, name: manifest.name, kind: manifest.kind, checks: result.checks };
    }
    case "platform": {
      const entryPath = join(extensionDir, manifest.entry ?? "index.ts");
      const result = await verifyPlatformExtension(extensionDir, entryPath, manifest.name);
      return { ok: result.ok, name: manifest.name, kind: manifest.kind, checks: result.checks };
    }
    case "rule": {
      const entryPath = join(extensionDir, manifest.entry ?? "index.ts");
      if (!existsSync(entryPath)) {
        return fail(manifest.name, manifest.kind, "入口文件存在", `找不到 ${entryPath}`);
      }
      const result = await verifyRuleExtension(entryPath);
      return { ok: result.ok, name: manifest.name, kind: manifest.kind, checks: result.checks };
    }
    case "skill": {
      const result = await verifySkillExtension(extensionDir);
      return { ok: result.ok, name: manifest.name, kind: manifest.kind, checks: result.checks };
    }
    case "mcp_client": {
      const result = await verifyMcpClientExtension(extensionDir, manifest);
      return { ok: result.ok, name: manifest.name, kind: manifest.kind, checks: result.checks };
    }
    case "backend": {
      // 任务书的 ext verify 表格只列了 connector/platform/rule/skill 四类——"backend"
      // （WetLabBackend）不在其中，且它的真实契约测试（wet_loop/wet_e2e）依赖
      // backend/src/lab/** 与真实 opentrons.simulate，那个文件树不在本 lane 名下。
      // 如实做法：只做"能装上"这一档的结构检查（entry 存在、能 import、导出形状
      // 像 WetLabBackend），**不假装**覆盖了 P5/AD-4 同等级别的契约验收——
      // 这条边界写进了 docs/devlog/W2-c.md 与 docs/EXTENDING.md，不是静默留白。
      const entryPath = join(extensionDir, manifest.entry ?? "index.ts");
      if (!existsSync(entryPath)) {
        return fail(manifest.name, manifest.kind, "入口文件存在", `找不到 ${entryPath}`);
      }
      try {
        const mod = (await import(entryPath)) as Record<string, unknown>;
        const backend = mod.backend as
          | { id?: unknown; description?: unknown; available?: unknown; execute?: unknown }
          | undefined;
        const shapeOk =
          !!backend &&
          typeof backend.id === "string" &&
          typeof backend.description === "string" &&
          typeof backend.available === "function" &&
          typeof backend.execute === "function";
        return {
          ok: shapeOk,
          name: manifest.name,
          kind: manifest.kind,
          checks: [
            { name: "入口文件存在", ok: true },
            {
              name: "结构检查（未覆盖 WetLabBackend 完整契约测试——已知限制，见 devlog）",
              ok: shapeOk,
              detail: shapeOk ? undefined : `期望具名导出 backend: { id, description, available(), execute() }，实际导出：${Object.keys(mod).join(", ")}`,
            },
          ],
        };
      } catch (error) {
        return fail(manifest.name, manifest.kind, "模块可加载", `import 抛错：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    default:
      return fail(manifest.name, manifest.kind, "kind 分发", `未知 kind："${manifest.kind}"`);
  }
}

export function formatVerifyResult(result: ExtensionVerifyResult): string {
  const lines: string[] = [];
  lines.push(`扩展：${result.name ?? "(未知)"}（kind=${result.kind ?? "(未知)"}）`);
  lines.push(result.ok ? "ext verify: PASS" : "ext verify: FAIL");
  for (const check of result.checks) {
    lines.push(`  [${check.ok ? "PASS" : "FAIL"}] ${check.name}`);
    if (check.detail) {
      for (const line of check.detail.split("\n")) lines.push(`      ${line}`);
    }
  }
  return lines.join("\n");
}
