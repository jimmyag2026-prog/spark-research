# 闸门 I · 「声明即须有读者」devlog（v0.9）

> 主会话串行。基点 main@644cccd（v0.8.0）。任务书 `docs/taskbooks/v0.9/GATE_I.md`。

## I-1 形状 ③ · `tests/unit/gate_i_switch_readers.test.ts`

### 历史阴性对照（真跑，2026-09-14，main@644cccd，闸门 H 未合入）

**预期红**：V137 的 `maxRetries` 在 v0.8.0 上零读者。实际输出：

```
  maxRetries
  streaming
  toolCalling
  usageReported
(fail) 闸门 I · 形状 ③ · llm/types.ts 的行为开关字段必须有读者（AD-17） > 每个开关字段在 backend/src 里至少有一个真实读者（转发与注释不算） [397.75ms]
 3 pass
 1 fail
Ran 4 tests across 1 file. [417.00ms]
```

红名单四个字段，逐条判定：

| 字段 | 判定 | 去向 |
|---|---|---|
| `maxRetries` | V137 形状本尊：声明、赋值、无读者 | 闸门 H（PR #109）合入后转绿——**这就是本门禁的历史对照** |
| `toolCalling` · `streaming` · `usageReported` | `ProviderCapabilities` 的三个字段，`router.ts:123` 构造、**无人消费**。**首次运行即抓到的三个新同族** | 进 I-3 盘点，登记 V143–V145（待远端最大 V 号复核） |

### 两处如实记

- **`retryable` 不在红名单**：`anthropic.ts` 里 `const { kind, retryable } = classifyHttpError(...)` 是解构 classify 的返回值，
  不是读 `LlmError.retryable`。文本级判据无法区分同名字段的归属，把它算成了读者。
  这是本门禁写明的能力边界（宁可漏报不误报）；V137 的历史对照由 `maxRetries` 承担。
- **第一版规则误杀了 `maxTokens`**：「所有转发都不算读」把 `max_tokens: opts.maxTokens`（送进请求体、provider 会消费）
  也排除了。收紧为「**同名转发**才不算读」（`retryable: x.retryable` 是把同一字段抄进同形对象；
  `max_tokens: x.maxTokens` 是异名映射，算读）。判据自检测试里三种情形各一条。

### 本地 CI 模拟顺带结论（v142 worktree，无 .venv）

单元套件 14 fail，全部是 chem/depict 家族（含 V122 三条——它们用 `/api/chem/depict` 当写路由探针，
无 rdkit 时 422，断言在下游失败）。CI 会 `pip install rdkit`，PR #109 的 CI 日志里 chem CLI 用例是 pass 的，
所以这 14 条是本地环境产物，不是 #110 的红因。#110 的真因等失败日志。

## 待办（本文随进度更新）
- [ ] I-1 形状 ② `gate_i_param_readers.test.ts`（TS 编译器 API）
- [ ] I-2 三条阴性对照（②人造、③人造、③历史=上文）
- [ ] I-3 盘点入 BACKLOG（V143 起，先复核远端最大 V 号）
- [ ] I-4 AD-17 入 `docs/DESIGN.md`
