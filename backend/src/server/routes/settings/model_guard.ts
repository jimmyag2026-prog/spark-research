import { SettingValidationError } from "../../../config";
import { PROVIDER_MODELS } from "../../../llm/router";
import { PRICING, PROVIDER_API_KEY_ENV, priceFor } from "../../../llm/providers/registry";

// 模型名的写入前校验（U5 第三点 / U6 修改方向 A 的「校验」条）。
//
// **这是一个临时收口点**：任务书要求写入经 lane β 导出的 `assertKnownModel`
// （β-3 从单价表派生 `MODELS_BY_PROVIDER`）。β 尚未落地，按名字 import 会让
// `bun run typecheck` 直接红——所以这里按同一语义先实现一份，**收口时替换成
// β 的 `assertKnownModel` 并删掉本文件的 `assertKnownModel`**（其余导出仍有用）。
// 判据取的是 `PROVIDER_MODELS`（router 真正认的注册表），不是单价表——
// 「已登记」的意思是 router 调得动它，而不是「我们知道它多少钱」。

export function modelsByProvider(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
    out[provider] = [...models];
  }
  return out;
}

export function knownModels(): string[] {
  return Object.values(PROVIDER_MODELS).flatMap((models) => [...models]).sort();
}

/** 模型名 → provider。认不出返回 null（本地端点 `local/...` 不在注册表里，同样返回 null）。 */
export function providerOf(model: string): string | null {
  for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
    if ((models as readonly string[]).includes(model)) return provider;
  }
  return null;
}

export function apiKeyEnvFor(provider: string): string | null {
  return PROVIDER_API_KEY_ENV[provider] ?? null;
}

/** 这个模型有没有内置单价（没有 ≠ 不能用，只是 costUsd 会是 null）。 */
export function hasPricing(model: string): boolean {
  const provider = providerOf(model);
  if (!provider) return false;
  if (!PRICING[provider]?.[model]) return false;
  return priceFor(provider, model) !== null;
}

/**
 * 未登记的模型名写不进配置。
 *
 * 为什么要在**写入时**拦：U5 的第三点——不拦的话，用户在网页端填一个拼错的模型名，
 * 配置写进去、一切正常，直到下一次真的要调模型时才在一个完全无关的地方炸。
 * 本地端点（`local/<model>` / `local:<model>`）是显式 opt-in 的路径，按前缀放行。
 */
export function assertKnownModel(model: string): void {
  const name = model.trim();
  if (name === "") {
    throw new SettingValidationError("模型名不能为空", "从 GET /api/settings/models 的 allowed 里挑一个");
  }
  if (name.startsWith("local/") || name.startsWith("local:")) {
    return; // 本地端点的模型名由那台服务器自己定，注册表管不着，也不该管。
  }
  if (providerOf(name) === null) {
    const known = knownModels();
    throw new SettingValidationError(
      `模型 '${name}' 没有登记过`,
      `从这些里挑一个：${known.slice(0, 8).join(" / ")}${known.length > 8 ? " …" : ""}` +
        `（完整清单见 GET /api/settings/models）；本地端点请用 local/<模型名>`,
    );
  }
}
