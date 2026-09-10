// W2-c · ExtensionContext：TS 扩展（skill/platform/backend/rule）拿到凭据 / ToolBus
// 的**唯一**合法通道。恶意矩阵①②的落点——"声明了 A 却调 B"与"未 grant 却取凭据"
// 都在这里结构性地拒绝，不依赖扩展代码自觉。
//
// 授权判定是**交集**：manifest.requires 声明过 **且** ExtensionGrantStore 里被
// `ext grant` 批准过，两个条件都满足才放行。少一个都拒——manifest 声明了但没 grant
// 是"用户还没批准"，grant 了但 manifest 没声明是"根本不该出现的授权配置错误"
// （grant 命令本身会拒绝这种输入，见 cli.ts），双重保险。

import type { ExtensionManifest } from "./types";
import type { ExtensionGrant } from "./grants";
import { ExtensionGrantError } from "./grants";

export interface CredentialAccessor {
  has(connectorId: string): boolean;
  get(connectorId: string): Record<string, string> | null;
}

export interface ToolCaller {
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface ExtensionContext {
  readonly extensionName: string;
  credentials: CredentialAccessor;
  tools: ToolCaller;
}

export interface ExtensionContextDeps {
  // 真实凭据源；缺省时任何访问都会因为"没有接入凭据源"而拒绝（安全默认：拿不到就是拿不到）。
  credentials?: CredentialAccessor;
  // 真实 ToolBus（或等价的调用器）；缺省同理。
  tools?: ToolCaller;
}

export function buildExtensionContext(
  manifest: ExtensionManifest,
  grant: ExtensionGrant,
  deps: ExtensionContextDeps = {},
): ExtensionContext {
  const declaredCredentials = new Set(manifest.requires?.credentials ?? []);
  const declaredTools = new Set(manifest.requires?.tools ?? []);
  const grantedCredentials = new Set(grant.credentials);
  const grantedTools = new Set(grant.tools);

  const allowedCredentials = new Set([...declaredCredentials].filter((id) => grantedCredentials.has(id)));
  const allowedTools = new Set([...declaredTools].filter((name) => grantedTools.has(name)));

  return {
    extensionName: manifest.name,
    credentials: {
      has(connectorId: string): boolean {
        if (!allowedCredentials.has(connectorId)) return false;
        return deps.credentials?.has(connectorId) ?? false;
      },
      get(connectorId: string): Record<string, string> | null {
        if (!allowedCredentials.has(connectorId)) {
          const declared = declaredCredentials.has(connectorId);
          throw new ExtensionGrantError(
            `扩展 "${manifest.name}" 试图访问凭据 "${connectorId}"，但${
              declared ? "尚未被 `ext grant` 授权" : "manifest.requires.credentials 里没有声明这个 id"
            }——拒绝（AD-2：凭据默认拿不到，声明 + 授权缺一不可）。`,
          );
        }
        if (!deps.credentials) {
          throw new ExtensionGrantError(`扩展 "${manifest.name}"：当前装载上下文没有接入真实凭据源，无法访问 "${connectorId}"`);
        }
        return deps.credentials.get(connectorId);
      },
    },
    tools: {
      async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
        if (!allowedTools.has(name)) {
          const declared = declaredTools.has(name);
          throw new ExtensionGrantError(
            `扩展 "${manifest.name}" 试图调用工具 "${name}"，但${
              declared ? "尚未被 `ext grant` 授权" : "manifest.requires.tools 里没有声明这个工具名"
            }——拒绝。`,
          );
        }
        if (!deps.tools) {
          throw new ExtensionGrantError(`扩展 "${manifest.name}"：当前装载上下文没有接入 ToolBus，无法调用 "${name}"`);
        }
        return deps.tools.call(name, args);
      },
    },
  };
}
