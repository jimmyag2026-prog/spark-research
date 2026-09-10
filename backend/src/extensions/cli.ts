// W2-c · `spark-research ext <subcommand>`。
//
// backend/src/index.ts 只加了一个 `case "ext":` 把 argv 转交给这里（见任务书文件
// 所有权：index.ts 不许动除此之外的任何东西）。子命令的解析、输出格式、退出码
// 全部收在本文件。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { extensionsRoot } from "./paths";
import { verifyExtension, formatVerifyResult } from "./verify";
import { writeVerifyCache, subjectPathFor } from "./verify_cache";
import { sha256File } from "./fingerprint";
import { loadExtension } from "./loader";
import { ExtensionGrantStore } from "./grants";
import { loadExtensionManifest, ExtensionManifestError } from "./types";

const HELP = `spark-research ext —— 扩展装载 + 契约验收（v0.4 P17）

用法:
  spark-research ext list                          列出 ~/.spark-research/extensions/ 下的扩展
  spark-research ext verify <path>                  跑契约验收（AD-11：能装上不算装好）
  spark-research ext load <path> [--trust]          装载一个扩展（TS 扩展需要 --trust）
  spark-research ext grant <name> --credential <id> 授权扩展访问某个 connector 的凭据
  spark-research ext grant <name> --tool <name>     授权扩展调用某个 ToolBus 工具
  spark-research ext revoke <name> --credential <id>
  spark-research ext revoke <name> --tool <name>

<path> 可以是绝对/相对路径，也可以是 ~/.spark-research/extensions/ 下的扩展名。
`;

function resolveExtensionPath(pathArg: string): string {
  if (existsSync(pathArg) && statSync(pathArg).isDirectory()) return pathArg;
  const byName = join(extensionsRoot(), pathArg);
  if (existsSync(byName)) return byName;
  return pathArg; // 让下游报"找不到"，错误消息更明确
}

function listInstalled(): Array<{ name: string; kind: string; ok: boolean | null; reason: string | null }> {
  const root = extensionsRoot();
  if (!existsSync(root)) return [];
  const out: Array<{ name: string; kind: string; ok: boolean | null; reason: string | null }> = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, "extension.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = loadExtensionManifest(readFileSync(manifestPath, "utf8"));
      out.push({ name: manifest.name, kind: manifest.kind, ok: null, reason: null });
    } catch (error) {
      const reason = error instanceof ExtensionManifestError ? error.message : String(error);
      out.push({ name: entry, kind: "(未知)", ok: false, reason });
    }
  }
  return out;
}

export async function runExtCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;

  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      console.log(HELP);
      return 0;
    }

    case "list": {
      const extensions = listInstalled();
      if (extensions.length === 0) {
        console.log(`${extensionsRoot()} 下没有已安装的扩展。`);
        return 0;
      }
      for (const ext of extensions) {
        console.log(ext.ok === false ? `✗ ${ext.name}（manifest 校验失败：${ext.reason}）` : `  ${ext.name}  kind=${ext.kind}`);
      }
      return 0;
    }

    case "verify": {
      const pathArg = rest[0];
      if (!pathArg) {
        console.log("用法: spark-research ext verify <path>");
        return 1;
      }
      const dir = resolveExtensionPath(pathArg);
      const result = await verifyExtension(dir);
      console.log(formatVerifyResult(result));

      // 把结论落进缓存——装载时（loader.ts 的 verifyStalenessWarning）靠它判断
      // "有没有验过 / 验过的还是不是当前内容"。缓存只在 manifest 能解析、能定位
      // 到校验对象时才写；manifest 本身就坏的情况没有校验对象可指纹，不写缓存。
      try {
        const manifestPath = join(dir, "extension.json");
        if (existsSync(manifestPath)) {
          const manifest = loadExtensionManifest(readFileSync(manifestPath, "utf8"));
          const subjectPath = subjectPathFor(dir, manifest);
          if (existsSync(subjectPath)) {
            writeVerifyCache(dir, { ok: result.ok, at: new Date().toISOString(), subjectSha256: sha256File(subjectPath) });
          }
        }
      } catch {
        /* 缓存写入失败不影响 verify 本身的退出码 */
      }

      return result.ok ? 0 : 1;
    }

    case "load": {
      const pathArg = rest.find((a) => !a.startsWith("--"));
      const trust = rest.includes("--trust");
      if (!pathArg) {
        console.log("用法: spark-research ext load <path> [--trust]");
        return 1;
      }
      const dir = resolveExtensionPath(pathArg);
      const loaded = await loadExtension(dir, { trust });
      for (const w of loaded.warnings) console.log(w);
      if (loaded.status === "failed") {
        console.log(`✗ 装载失败：${loaded.reason}`);
        return 1;
      }
      console.log(`✓ 已装载扩展 "${loaded.name}"（kind=${loaded.kind}）`);
      console.log(
        "注意：本命令只做结构性装载与展示，不接入真实的 daemon/CredentialStore/ToolBus/capabilities——" +
          "那部分接线由持有对应文件的其它 lane 完成（见 docs/devlog/W2-c.md「给主会话的接线说明」）。",
      );
      return 0;
    }

    case "grant":
    case "revoke": {
      const name = rest[0];
      const credIdx = rest.indexOf("--credential");
      const toolIdx = rest.indexOf("--tool");
      if (!name || (credIdx === -1 && toolIdx === -1)) {
        console.log(`用法: spark-research ext ${sub} <name> --credential <id> | --tool <name>`);
        return 1;
      }
      const store = new ExtensionGrantStore();
      if (credIdx !== -1) {
        const id = rest[credIdx + 1];
        if (!id) {
          console.log("--credential 需要一个参数");
          return 1;
        }
        const entry = sub === "grant" ? store.grantCredential(name, id) : store.revokeCredential(name, id);
        console.log(`${sub === "grant" ? "已授权" : "已撤销"} "${name}" 访问凭据 "${id}"。当前凭据授权：${entry.credentials.join(", ") || "(无)"}`);
      }
      if (toolIdx !== -1) {
        const toolName = rest[toolIdx + 1];
        if (!toolName) {
          console.log("--tool 需要一个参数");
          return 1;
        }
        const entry = sub === "grant" ? store.grantTool(name, toolName) : store.revokeTool(name, toolName);
        console.log(`${sub === "grant" ? "已授权" : "已撤销"} "${name}" 调用工具 "${toolName}"。当前工具授权：${entry.tools.join(", ") || "(无)"}`);
      }
      console.log(
        "提醒：manifest 里 requires.credentials/requires.tools 没有声明过的 id/工具名，即使在这里授权了，" +
          "ExtensionContext 仍然会拒绝（声明 + 授权必须同时满足，见 context.ts）。",
      );
      return 0;
    }

    default:
      console.log(HELP);
      return 1;
  }
}
