// W2-c · 扩展授权账本（凭据访问 + ToolBus 工具调用）。
//
// 安全边界（AD-2 的扩展）：manifest 里的 `requires.credentials` / `requires.tools`
// 只是**申报**——扩展代码不会因为申报了就自动拿到访问权。用户必须显式
// `spark-research ext grant <name> --credential <id>` / `--tool <name>` 之后，
// 装载器构造的 ExtensionContext 才会放行**申报过且被授权**的那个交集；两边缺一个
// 都拒绝（见 context.ts）。授权记录落盘在 `extensions/.grants.json`（数据目录下，
// 不是仓库），与凭据文件同级但**不含任何凭据值本体**——这里只存"允许访问哪个 id"，
// 值本体的存取仍然只经过 CredentialStore（AD-2 原有边界不变）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { grantsFilePath, type ExtensionPathOptions } from "./paths";

export interface ExtensionGrant {
  credentials: string[];
  tools: string[];
}

type GrantsFile = Record<string, ExtensionGrant>;

function emptyGrant(): ExtensionGrant {
  return { credentials: [], tools: [] };
}

export class ExtensionGrantStore {
  private readonly path: string;

  constructor(options: ExtensionPathOptions = {}) {
    this.path = grantsFilePath(options);
  }

  private read(): GrantsFile {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as GrantsFile;
    } catch {
      return {};
    }
  }

  private write(file: GrantsFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  }

  get(name: string): ExtensionGrant {
    return this.read()[name] ?? emptyGrant();
  }

  grantCredential(name: string, connectorId: string): ExtensionGrant {
    const file = this.read();
    const entry = file[name] ?? emptyGrant();
    if (!entry.credentials.includes(connectorId)) entry.credentials.push(connectorId);
    file[name] = entry;
    this.write(file);
    return entry;
  }

  grantTool(name: string, toolName: string): ExtensionGrant {
    const file = this.read();
    const entry = file[name] ?? emptyGrant();
    if (!entry.tools.includes(toolName)) entry.tools.push(toolName);
    file[name] = entry;
    this.write(file);
    return entry;
  }

  revokeCredential(name: string, connectorId: string): ExtensionGrant {
    const file = this.read();
    const entry = file[name] ?? emptyGrant();
    entry.credentials = entry.credentials.filter((c) => c !== connectorId);
    file[name] = entry;
    this.write(file);
    return entry;
  }

  revokeTool(name: string, toolName: string): ExtensionGrant {
    const file = this.read();
    const entry = file[name] ?? emptyGrant();
    entry.tools = entry.tools.filter((t) => t !== toolName);
    file[name] = entry;
    this.write(file);
    return entry;
  }
}

export class ExtensionGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionGrantError";
  }
}
