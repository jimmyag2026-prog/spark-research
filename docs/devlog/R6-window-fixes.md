# R6 修复窗口 · U11 U12 U15 U21 U22 U23（+U20 半）

**日期** 2026-09-15 晚 · **分支** `fix/R6-window` · 执行：主会话。R6 由零上下文子代理在 `r6/report` 分支跑（`R6.md`），基线由主会话跑（`R6-baseline.md`）。

## 先复现，再动手

| 条目 | 复现方法 | 结果 |
|---|---|---|
| U15（T5 第 6 步 P0） | 起 alpha.2 server；`PUT /api/settings/general/defaultModel` 写 `moonshotai/kimi-k2.6` → 200；再 GET | 文件已是 kimi，server 仍回 `z-ai/glm-5.3-flash`、`source: env`、nextStep 让人 unset `SPARK_RESEARCH_MODEL`——**成立**。根因 `applyConfigEnvDefaults` 把 config.json 灌进 `process.env`，`resolveSetting` 见 env 就当用户设的 |
| U23（P0/安全） | 读 `config/cli.ts` `set` 分支 | 无 `spec.secret` 判断，写盘后只是「不回显」——**成立**（HTTP 侧 `validateSetting` 早已 403，CLI 侧没接） |
| U12 49.8s 待核实 | 读 `orchestrator.plan()`：`!res.ok` 一律退 `defaultPlan()`；对照实验：零花费新项目 + budget 1.0 → 72.8s / 3 行台账 | 49.8s = 默认计划的连接器任务（零 LLM）——**成立** |
| U22 / U21 / U11 | 代码直读 | 成立 |

## 改动

| 条目 | 改动 | 门禁 | 阴性对照（实跑） |
|---|---|---|---|
| **U15** | `config/index.ts`：`bridgedEnvVars` 记录桥接键；`resolveSetting` 对桥接键不看 env；`saveConfig` 落盘后 `refreshBridgedEnv` | `r6_window` U15 ×2 | 去掉 `!bridged` 判断 → **1 红** |
| **U23** | `config/cli.ts set`：`spec.secret` → exit 1 + 指向 `auth`；其余校验统一走 `validateSetting` | U23 ×2 | `if (spec.secret)` 改 `if (false)` → **1 红**（第一版断言只查「凭据」二字，被 `validateSetting` 的 403 兜底顶过去、没红——改为断言 CLI 专属措辞「shell 历史」后才红，记在这里） |
| **U22** | `SettingSpec.min`，`llmTimeoutMs.min=1000`，`validateSetting` 校验 | U22 ×1 | — |
| **U12** | `OrchestrationResult.failure` / `ChatResponse.failure`；`summarize` 返回 `{text, failure}`；plan 被闸拒抛 `BudgetGateError` 整轮即止；`review.approved=false`；`ledger.ts` 三处闸拒 `recordGate` 落行 | U12 ②③ ×3 | 删掉 `throw new BudgetGateError` → **1 红**（响应里没有「未执行任何任务」，说明又跑了默认计划） |
| **U21** | `index.ts chatOnce`：`failure` → `exitCode=1` | 与 U12 同一条 HTTP 门禁间接覆盖；CLI 退出码未单测（`chatOnce` 起真 daemon） | — |
| **U11** | `routes/session.ts` `bindRequestedProject`（query 或 body），两条路由 | U11 ×1 | — |
| U20 | `chat_args.ts` 帮助文案 | — | — |

既有测试改口径两处：`config.test.ts` 枚举错误措辞（统一到 `validateSetting`）；`g3_budget_gate.test.ts`「拒绝不入台账」→「拒绝也落行，known 不变」。

## 复跑
见 PR 评论（全套件）。
