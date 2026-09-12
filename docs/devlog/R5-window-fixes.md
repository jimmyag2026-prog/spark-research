# R5 修复窗口（并行于 R5 复跑）· V104 V115 V116 V119

**日期** 2026-09-12 · **分支** `fix/R5-window-V104-V115-V116-V119` · 执行：主会话（R5 子代理在 detached@alpha.2 的独立 worktree 跑，本分支改动不影响它）

| 条目 | 改动 | 门禁 | 阴性对照（实跑） |
|---|---|---|---|
| **V104** HTTP 综述不落 citation-integrity record | `routes/literature.ts` `POST /review`：与 CLI 同一 `records.create({kind: CITATION_INTEGRITY_REVIEW_KIND…})`（内联，narrative_parity 结构核实友好）；响应加 `citationReviewRecordId`、`citationGap` | `server_literature`「综述…不 veto」加断言：record 存在且 metadata.kind 对 | 响应里 id 置空 → 17/1 红 |
| **V115** auth 录入回显 | `cli/hidden_input.ts` `readHidden()`：TTY 切 raw 逐字读不回显（退格/Ctrl+C），非 TTY 按行；`index.ts auth()` 换用 | `v115_hidden_input` 3 条 | 让 readHidden 回显 → 2/1 红 |
| **V116** CI bypass token | `approval/gate.ts` `constantTimeEqual`（sha256 + timingSafeEqual）；`--ci-bypass-token-env <VAR>` 从环境变量取 token；lab/compute HELP 同步 | `v116_bypass_token` 5 条；既有 `approval_gate` 全绿 | 去掉 env 分支 → 3/2 红 |
| **V119** 聊天式 co-explore 无预算入口 | `orchestrator.chat({budgetUsd, allowUnpriced})` 按会话记预算 → `llmFor` 传给 usageTrackingLlm；`/api/session/chat` 与 `/stream` 透传；`api.ts streamChat` + 聊天框 `BudgetInput`；闸拒绝时 orchestrator 把闸消息（含下一步）原样回给用户，不再说"检查 API key" | `v119_chat_budget` 2 条（budget 极小 → fake llm 0 次调用 + 回复含"预算闸"；不带 → 照常调用） | `/chat` 路由去掉透传 → 1/1 红 |

## 复跑（退出码口径）
typecheck 0 · unit 2430/0（2420+10）· concurrency+timeout 37/0 · e2e 见 PR。
