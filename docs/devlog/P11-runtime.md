# P11 · LLM Runtime v2 + 可达性闸门（收口记录）

> v0.4 第一阶段。四条 lane：接口先行（主会话）· R-a OpenAI 兼容基座 · R-b Anthropic 原生 · R-c 预算与能力位 · R-d 可达性闸门。
> lane 各自的详细记录见 `P11-iface.md` / `P11-a.md` / `P11-b.md` / `P11-c.md` / `P11-d.md`；本文只记**收口与教训**。

## 1. 这一阶段解决的真实缺口

v0.3.1 实测：`SUPPORTED_PROVIDERS` 声明 6 个 provider，**只有 kimi / openrouter 两个能真发请求**，
其余静默落到 OpenRouter 或失败。而「模型中立」恰恰是 OpenScience 最被引用的卖点，
也是 v0.4 主线 A（真子代理）的前提——没有 tool calling，ToolBus 无从谈起。

同时 D-12 门禁在 v0.3 末尾抓到：`capabilities --json` **主动广播了一个无法调用的技能**
（`protein-analysis` 带完整描述与 triggers，却无 CLI / HTTP / MCP 入口）。
声称与实现分家，在这一阶段一并收口。

## 2. 三个设计决定

### 2.1 AD-13 做成可辨识联合，不是靠约定

方案原文只说「`ok=false ⇒ content=""`」。实现时发现不够——假实现照样能构造
「失败但没说为什么」的响应（`reading.test.ts` 真撞上了，错误退化成「模型调用失败: 未知原因」）。
改成失败分支 `content` 是**字面量 `""`**、`error` **必填**：

```ts
export type LlmResponse =
  | (Base & { ok: true;  content: string; error?: undefined })
  | (Base & { ok: false; content: "";     error: LlmError });
```

**阴性对照实跑**：探针同时构造「失败带内容」与「失败无原因」→ 两处都是 `TS2322`。

### 2.2 方案的一个副作用，差点静默改坏五处诊断

五个域消费方（citation_judge / novelty / review / reading / coexplore）**早就正确检查了
`res.ok`**，但它们把 `content` **当错误信息用**。照方案直接清空 content，
这五处排障信息会变成一片空白——**测试全绿，诊断没了**。已一并迁到 `error?.message`。

教训：**改一个被广泛消费的返回形状时，"谁在读这个字段、读它干什么" 要先查一遍**，
类型检查只能告诉你"字段没了"，不会告诉你"语义没了"。

### 2.3 声称与实现必须同步翻位

`capabilities()` 在接口先行阶段如实报 `{toolCalling:false, jsonMode:false, streaming:false}`
——因为那一阶段确实没实现。每翻一位为 true 必须伴随实现与测试。
配套地，`options.tools` 非空而 provider 不支持时，adapter **显式返回 `kind:"unsupported"` 的失败**，
不静默忽略——静默忽略会让模型「看不见工具」却照常回话，是最难查的那类失败。

同时把 `SUPPORTED_PROVIDERS`（模型名字典）与 `ADAPTERS`（真能发请求的清单）**显式分开**：
v0.3.1 的缺口根因就是两者被混为一谈。

## 3. 流程教训：门禁与所有权划分的冲突

`router.ts` 是 R-b 与 R-c 都可能要动的文件，主会话**刻意把它从两条 lane 的所有权里摘出来**，
由收口时统一接线（P10 那次 `routes/lab.ts` 的教训）。

副作用：R-b 交付的 `anthropic.ts` 在自己分支上没有生产调用方 → **踩中 D-12 的孤儿模块门禁**。

**门禁是对的，扣接线也是对的，冲突在于两者没协调**——这是主会话的规划失误。
处置方案与后续通用做法已写进 `DEVELOPMENT_PLAN_v0.4.md` §5.3·补：
lane 自己登记 `ALLOWED_ORPHANS` 并写清「等谁接线」，主会话接线时删掉；
门禁的「多余登记必须删除」对称检查**双向钉死**——接了不删会红，忘接也会红。

> 意外正收益：门禁从此**同时是一张接线清单**。AD-12 推到极致，
> 连「模块建好了但没接上」这种半成品状态也被自动追踪了。

## 4. 一次外部中断

R-b / R-c 曾被账户月度额度上限（HTTP 429）同时掐断。R-b 已写出的 1034 行由主会话
以 `wip` commit 保住并**显式标注「未经任何验证、不可直接合并」**；R-c 中断得早，无残留。
额度恢复后两条 lane **从各自 transcript 恢复**（而非重启），省掉一次冷启动。

处理纪律：**中断产出一律标 wip 并写明未验证**，绝不让半成品混进看起来正常的提交历史。

## 5. 环境修正（P10 遗留）

P10 时 lane worktree 缺 `.venv`，导致 17 个 OpenMM 契约用例**静默 skip**、lane 报绿但没跑。
P11 起 lane 建好后软链主仓 `.venv`（`uv sync` 在本机构建 openmm 失败——它不是纯 pip 包）。
实测：lane worktree 现在也是 **0 skip**。

> 附带清掉一个自己制造的垃圾：那次失败的 `uv sync` 留下 8 行空壳 `uv.lock`
> （只有根包、零解析依赖），差点跟着提交。留着比不留更糟——将来 `uv sync --frozen`
> 会照着它什么都不装，而且失败得很安静。已删除并加进 `.gitignore`。
