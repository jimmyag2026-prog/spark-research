# P11 · 接口先行（LLM Runtime v2 的类型面）

> 主会话执行（方案 §5.1 指定 Opus）。三条 lane（R-a/R-b/R-c）全部依赖本次产出，
> 所以它必须先单独合入 integration。

## 交付

| 文件 | 作用 |
|---|---|
| `llm/types.ts` | ChatMessage（含 `tool` 角色）· ToolSpec / ToolCall · Usage · LlmError · **LlmResponse（可辨识联合）** · ProviderCapabilities · CallOptions · 三个构造器 |
| `llm/providers/types.ts` | `ProviderAdapter` 契约 + `failure()` 唯一失败构造入口 |
| `llm/providers/openai_compat.ts` | 把原先逐行重复的 `callKimi` / `callOpenRouter` 合成一份（**R-a 在此基础上补 tool calling / 流式 / JSON 模式 / 本地端点**） |
| `llm/router.ts` | 门面：模型 → adapter；**向后兼容** `call(messages, model)`；新增 `capabilitiesFor()` 与 `implementedProviders()` |

## 三个设计决定

### 1. AD-13 做成可辨识联合，而不是靠约定

方案原文只说「`ok=false ⇒ content=""`」。实现时发现那不够——**假实现照样能构造出
「失败但没说为什么」的响应**，诊断信息凭空消失（`reading.test.ts` 就撞上了：
错误消息退化成「模型调用失败: 未知原因」）。

所以改成：

```ts
export type LlmResponse =
  | (Base & { ok: true;  content: string; error?: undefined })
  | (Base & { ok: false; content: "";     error: LlmError });
```

`content` 在失败分支是**字面量 `""`**，`error` 必填。于是两件事在编译期不可能：
构造「失败但带内容」（内容会被误当产出）、构造「失败但没说原因」。

**阴性对照（已实跑）**：写一个探针文件同时构造这两种坏形态 → 两处都是 `TS2322`。
改回联合之前它们都能编译通过。

### 2. 方案里的 AD-13 有一个我没想到的副作用，差点静默改坏五处

五个域消费方（citation_judge / novelty / review / reading / coexplore）**早就正确检查了
`res.ok`**，但它们把 `content` **当错误信息用**：

```ts
if (!response.ok) { lastErrors = [`模型调用失败: ${response.content}`]; }
```

照方案直接把 content 清空，这五处的诊断会变成「模型调用失败: 」后面一片空白——
测试全绿，但排障信息没了。**意图对，机制漏了消费方**。
已一并迁移到 `response.error?.message`（本 lane 因此扩了这五个文件的所有权，
它们不属于 P11 任何其它 lane）。

### 3. capabilities 现在如实报 false，不许提前写 true

`OpenAiCompatAdapter.capabilities()` 返回 `{toolCalling: false, jsonMode: false, streaming: false}`
——因为**这一阶段确实没实现**。R-a 补齐后再逐项翻 true。

理由是 AD-12：capabilities 是给外部 agent **选模型之前** introspect 用的，不是许愿池。
配套的是：`options.tools` 非空时 adapter **显式返回 `kind: "unsupported"` 的失败**，
而不是静默忽略 tools——静默忽略会让模型「看不见工具」却照常回话，是最难查的那种失败。

另外把 `SUPPORTED_PROVIDERS`（模型名字典）与 `ADAPTERS`（真能发请求的清单）**显式分开**。
v0.3.1 的实测缺口正是两者被混为一谈：声明 6 个、实现 2 个，其余静默落到 OpenRouter。

## 顺带清理

`LlmResponse.mock` 字段**零消费方**（v0.1 移除 mock 模式后的残留），v2 去掉。

## 测试口径变化（3 处，都变强了）

原先断言「错误文案出现在 `content` 里」的三个用例，改为断言机器可读的 `error.kind`
（`timeout` / `upstream` / `auth`）+ `content === ""`。
**调用方区分失败类型不再需要读文案**——这本来就是 D-2 那条「能分辨超时 vs 上游报错」的正确形态。

## 验证

typecheck 干净 · `tests/unit/` **905 pass / 0 fail / 0 skip** ·
`tests/concurrency/` + `tests/timeout/` 12 pass · pytest 48 · `test:lab` 26 · **e2e 12/12**。

## 给 R-a / R-b / R-c 的交接

- **R-a** 拿 `openai_compat.ts`：补 tool calling（`tools` / `tool_choice` / `tool_calls` 解析）、
  流式（`onDelta`）、`response_format`、本地端点（ollama / vLLM / 任意 baseUrl），
  并把 `capabilities()` 里对应位翻成 true。**翻 true 必须伴随实现与测试**。
- **R-b** 新建 `anthropic.ts` 实现同一个 `ProviderAdapter`：注意 `tool_use` / `tool_result`
  的形状与 OpenAI 不同，别硬套 openai_compat。
- **R-c** 拿 `budget.ts` / `providers/registry.ts`：单价表 → `Usage.costUsd`
  （拿不到单价保持 `null` + `usageUnavailable`，**不许填 0**），并把
  `capabilitiesFor()` 接进 `capabilities --json`。
