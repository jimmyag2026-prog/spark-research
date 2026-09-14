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


## I-1 形状 ② · `tests/unit/gate_i_param_readers.test.ts`（TS 编译器 API）

两次收紧，各由 main 上的真实案例驱动（都记在测试头注释里）：
1. `this.m(param)` 同类转发不再一律视为全读——第一版把 `chat()` 里 `this.coexplore(req)` 当成全读，U10 被吞掉。改为并入 m 对首参的读取集合（一跳可追，深度 ≤ 3）。
2. 还是抓不到：`coexplore` 确实读 `req.model`，但那次转发在 `if (req.mode === "coexplore")` 分支里。改为**按位置分桶**：无条件转发并入可靠读，条件位置（if / ?: / case / && || ?? 右侧）只算「分支内读」；本函数自己已读 ≥3 个属性却只在分支转发里读到某属性 → 单独断言「主路径必须读」。

**main@644cccd 真跑**：Tier A = `lab/wet_loop.ts::WetLabLoop.execute::options.note`（新发现）；Tier B = `agents/orchestrator.ts::OrchestratorAgent.chat::req.model`（U10，历史阴性对照）。

已知盲区（如实）：非同类整体转发（`foo(param)` / `{...param}` / `return param`）视为全读，两跳丢弃抓不到；跨文件具名 type 的参数不在扫描面。

## I-2 · 三条阴性对照（真跑，2026-09-14）

| 形状 | 改法 | 输出（原文） | 复原 |
|---|---|---|---|
| ② 人造 | `chat()` 参数类型加 `probeUnused?: string`，函数体不读 | 见下 | `git checkout -- orchestrator.ts`，0 处残留 |
| ③ 人造 | `LlmError` 加 `probeFlag?: boolean`，无读者 | 见下 | `git checkout -- types.ts`，0 处残留 |
| ③ 历史 | main@644cccd 原样 | 上文 I-1 形状 ③ 段 | — |

②：
```
agents/orchestrator.ts::OrchestratorAgent.chat::req.probeUnused
+   "agents/orchestrator.ts::OrchestratorAgent.chat::req.probeUnused",
(fail) 闸门 I · 形状 ② · 对象参数属性必须在函数体内被引用（AD-17） > 每个内联对象参数的属性都在函数体内被读（或进 GATE_I_ALLOWLIST 并带理由） [0.28ms]
(fail) 闸门 I · 形状 ② · 对象参数属性必须在函数体内被引用（AD-17） > 主路径必须读：本函数自己在干活，某属性却只在条件分支的同类转发里被读（U10 形状） [0.12ms]
 2 pass
 2 fail
```
③：
```
probeFlag
+   "probeFlag",
(fail) 闸门 I · 形状 ③ · llm/types.ts 的行为开关字段必须有读者（AD-17） > 每个开关字段在 backend/src 里至少有一个真实读者（转发与注释不算） [407.80ms]
 3 pass
 1 fail
```
复原后两文件合跑：5 pass / 3 fail —— 三条红全部是历史对照（③ 四字段、② Tier A、② Tier B），无 probe 字样。

## I-3 盘点（草案；BACKLOG 编号待 #110 合入后确认远端最大 V 号再落）

| 发现 | 去向 | 拟登记 |
|---|---|---|
| `maxRetries` 零读者 | **修**：闸门 H（PR #109，V137）合入即转绿；不登记新号 | — |
| `toolCalling` / `streaming` / `usageReported`（`ProviderCapabilities`，`router.ts:123` 构造、无人消费） | **保留并接线**：lane α 的看门狗只对 `streaming` 生效、α-4 用 `usageReported` 区分「上游没返 usage」；`toolCalling` 应在子代理 tool loop 提供工具前核一次——归收口。alpha.2 前从 ALLOWLIST 移除 | V143 |
| `WetLabLoop.execute::options.note` 声明了从未读 | **修**：把 note 落进 execute 产生的 observation record（lane δ 小项） | V144 |
| `chat::req.model` 只在 coexplore 分支读（U10） | **修**：lane β-1。转入 BACKLOG 时 U10 → 拿 V 号 | V145（= U10） |
| 跨文件具名 type 参数不在扫描面 | 登记为门禁能力边界待办 | V146 |

**alpha.1 的绿法**：上述条目在 ALLOWLIST 里逐条登记（reason 写「V14x：<lane> 修，alpha.2 前移除」），门禁绿；lane 合入时按对称检查删除登记——接了不删会红。

## 待办（本文随进度更新）
- [x] I-1 形状 ② `gate_i_param_readers.test.ts`（TS 编译器 API）
- [x] I-2 三条阴性对照（②人造、③人造、③历史）
- [ ] I-3 盘点入 BACKLOG（V143 起，先复核远端最大 V 号）
- [ ] I-4 AD-17 入 `docs/DESIGN.md`
