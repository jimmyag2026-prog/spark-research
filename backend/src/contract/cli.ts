import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildContract, renderContractJson } from "./index";
import { CONTRACT_HELP } from "./help";
export { CONTRACT_HELP } from "./help";

export interface ContractCliDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  root?: string;
}

export async function runContractCommand(args: string[], deps: ContractCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  if (args.includes("--help") || args.includes("-h")) {
    out(CONTRACT_HELP);
    return 0;
  }
  const writeIdx = args.indexOf("--write");
  const writeTo = writeIdx >= 0 ? args[writeIdx + 1] : undefined;
  if (writeIdx >= 0 && (!writeTo || writeTo.startsWith("--"))) {
    err("❌ --write 需要一个文件路径。例如：spark-research contract --write dist/contract.json");
    return 1;
  }
  const contract = buildContract({ serverDeps: deps.root ? { root: deps.root } : {} });
  const json = renderContractJson(contract);
  if (writeTo) {
    mkdirSync(dirname(writeTo), { recursive: true });
    writeFileSync(writeTo, json);
    out(`✅ 契约已写入 ${writeTo}（v${contract.version} · contractVersion ${contract.contractVersion}）`);
    return 0;
  }
  if (args.includes("--json")) {
    out(json.trimEnd());
    return 0;
  }
  out(`Spark Research v${contract.version} 运行时契约（contractVersion ${contract.contractVersion}）`);
  out(`  CLI 命令 ${contract.cli.commands.length}（用法行 ${contract.cli.commands.reduce((n, c) => n + c.usages.length, 0)}）`);
  out(`  HTTP 路由 ${contract.http.routes.length} · 响应 schema ${Object.keys(contract.http.schemas).length}`);
  out(`  MCP 工具 ${contract.mcp.tools.length}`);
  out(`  配置项 ${contract.config.settings.length}（其中凭据 ${contract.config.settings.filter((s) => s.secret).length}，不含值）`);
  out(`  导出 manifest schema v${contract.data.manifestSchemaVersion}`);
  out("  --json 看全文；--write <文件> 落盘。SDK 由它生成。");
  return 0;
}
