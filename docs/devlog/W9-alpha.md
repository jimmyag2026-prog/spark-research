# lane α devlog · 交互链路的速度与稳定性（W9-1）

分支 `feat/W9-alpha`，基线 `integration/v0.9-base`（f921bf0）。本文件边做边写，
供中断后接手。**本 lane 经历两次代理中断**（Anthropic API 连接被拒），第三个代理接手续做。

---

## α-0 · 接手前的状态复核（第三个代理）

上一个代理留下 `5f0ebcd wip(lane alpha)`，commit message 自述「未经任何验证」。
先实跑再决定沿用还是重做，结论是**沿用**——落盘的代码质量可用，只有三处小伤：

| 症状 | 实跑输出 | 根因 | 处置 |
|---|---|---|---|
| `llm_watchdog.test.ts` 1 fail | `expect(...).not.toContain("总时长超时")` 收到静默超时文案 | `idleTimeoutMessage()` 措辞里写了「这不是总时长超时」，把另一条标签**字面**带了进去；测试按标签判型于是两条都匹配 | 改措辞，两条 message 各自只含自己的标签 |
| `provider_error.test.ts` 1 fail | `TypeError: Header 'retry-after' has invalid value: '不是数字也不是日期'` | 测试 bug，不是源码 bug：`Headers` 只接受 ISO-8859-1，中文在**构造**时就抛，测的已不是 `parseRetryAfterMs` | 换成 ASCII 垃圾串 `neither-number-nor-date`，断言意图（不可解析 → undefined）不变 |
| `typecheck` 3 errors | `anthropic.ts:514 Property 'type' does not exist on type 'never'` | `streamError` 只在 `processLine` 闭包里赋值，TS 的 CFA 看不见，出循环后窄化成 `never`。基线代码原本用 `as` 断言绕过，上一个代理改写时把断言丢了 | 沿用基线的断言，但提到一处 `const framed`，读取点不再各自断言 |

**关于「const 加类型标注能不能代替断言」**：不能，先试过。`const framed: T | null = streamError;`
的声明类型虽是 `T | null`，CFA 仍按初始值的 `never` 窄化该 const，三条报错原样复现。
换回 `as` 才绿。这条记下来，免得下一个人再试一遍。

修复后：`bun test tests/unit/llm_watchdog.test.ts tests/unit/provider_error.test.ts` → **30 pass / 0 fail**；
`bun run typecheck` → 无输出（绿）。

