import { statSync } from "node:fs";
import { CONFIG_SETTINGS, resolveSetting, type ConfigOptions } from "../../../config";
import { MODAL_CONNECTOR_ID, MODAL_REQUIRED_CREDENTIAL_KEYS } from "../../../compute/adapters/modal";
import { AMINER_CREDENTIAL_KEY } from "../../../connectors/aminer";
import type { ServerContext } from "../../context";

// 凭据目录：**一个面板统一两类凭据**（LANE_gamma.md credentials 行）。
//
//   · connector 类：落 `credentials.json` 的 `connectors.<id>`，字段名由 connector 自己定
//     （aminer/semanticscholar 是 `api_key`，modal 是 `tokenId`/`tokenSecret`）；
//   · provider 类：LLM 的各家 API key，落 `config.json`（`CONFIG_SETTINGS` 里 secret: true 的项）。
//
// 两类的**存储**不同（这是既有事实，AD-18 没有改存储格式），但对用户是同一件事：
// 「这个东西要不要 key、配没配」。所以对外是一个面板、一种形状。

export type CredentialCategory = "connector" | "provider";

export interface CredentialSpec {
  id: string;
  label: string;
  category: CredentialCategory;
  /** 需要哪些字段名。永远只有名字。 */
  fields: string[];
  summary: string;
  /** 没配时该干什么。 */
  nextStep: string;
}

// connector 的字段名不是猜的：每个都从真正读它的那段代码 re-export 的常量来。
// `compute/cli.ts` 的注释记着一次真实事故——设计文档写 `token_id`/`token_secret`、
// adapter 读 `tokenId`/`tokenSecret`，用户照提示填完永远报「未配置」。
// 手写第二份字段名清单就是在重演它，所以这里一个字面量都不写。
const CONNECTOR_FIELDS: Record<string, readonly string[]> = {
  [MODAL_CONNECTOR_ID]: MODAL_REQUIRED_CREDENTIAL_KEYS,
};

const DEFAULT_CONNECTOR_FIELDS = [AMINER_CREDENTIAL_KEY];

export function connectorFields(id: string): string[] {
  return [...(CONNECTOR_FIELDS[id] ?? DEFAULT_CONNECTOR_FIELDS)];
}

/** provider 类凭据 = `CONFIG_SETTINGS` 里 `secret: true` 的项，一项一个字段。 */
export const PROVIDER_FIELD = "value";

export function providerSpecs(): CredentialSpec[] {
  return CONFIG_SETTINGS.filter((s) => s.secret).map((s) => ({
    id: s.key,
    label: s.key,
    category: "provider" as const,
    fields: [PROVIDER_FIELD],
    summary: s.summary,
    nextStep: `在本面板直填，或设环境变量 ${s.envVar ?? s.key}`,
  }));
}

export function connectorSpecs(ctx: ServerContext): CredentialSpec[] {
  return ctx.connectors
    .listAll()
    .filter((c) => c.metadata?.apiKeyRequired === true)
    .map((c) => ({
      id: c.name,
      label: c.name,
      category: "connector" as const,
      fields: connectorFields(c.name),
      summary: c.description,
      nextStep: `在本面板直填，或在终端执行 \`spark-research auth --connector ${c.name}\``,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 算力的 Modal 凭据不在 connector 注册表里（它是 compute adapter，不是 HTTP connector），
 * 但它确实落在同一份 `credentials.json` 里、也确实需要用户去配——不列出来，用户在
 * 「算力」面板看到「需要凭据」之后就找不到填的地方了。
 */
export function computeSpecs(): CredentialSpec[] {
  return [
    {
      id: MODAL_CONNECTOR_ID,
      label: "Modal（远端算力）",
      category: "connector",
      fields: connectorFields(MODAL_CONNECTOR_ID),
      summary: "Modal 账户 token；配了之后 computeTarget 才能真的改成 modal",
      nextStep: `在本面板直填，或在终端执行 \`spark-research auth --connector ${MODAL_CONNECTOR_ID}\``,
    },
  ];
}

export function allCredentialSpecs(ctx: ServerContext): CredentialSpec[] {
  const seen = new Set<string>();
  const out: CredentialSpec[] = [];
  for (const spec of [...connectorSpecs(ctx), ...computeSpecs(), ...providerSpecs()]) {
    if (seen.has(spec.id)) continue;
    seen.add(spec.id);
    out.push(spec);
  }
  return out;
}

export function findCredentialSpec(ctx: ServerContext, id: string): CredentialSpec | undefined {
  return allCredentialSpecs(ctx).find((s) => s.id === id);
}

/** provider 凭据配没配：走 `resolveSetting`，它同时看 env 与 config.json。 */
export function providerConfigured(id: string, options: ConfigOptions = {}): boolean {
  try {
    return resolveSetting(id, options).configured;
  } catch {
    return false;
  }
}

/** AD-18 ⑤：写后校验文件权限。返回八进制字符串，文件不存在返回 "-"。 */
export function fileMode(path: string): string {
  try {
    return (statSync(path).mode & 0o777).toString(8).padStart(3, "0");
  } catch {
    return "-";
  }
}
