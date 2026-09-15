# v0.10 · 各 lane 共同纪律（先读这份，再读自己的 LANE_*.md）

真源：`docs/DEVELOPMENT_PLAN_v0.10.md`（定稿 v1）。基线：`docs/devlog/W10-0-baseline.md`（文献流程各阶段耗时）、`R6-baseline.md`（一句话 chat）。

## 环境
- 工作目录：`~/Desktop/AI4S/spark-research-<lane>`（git worktree，分支 `feat/W10-<lane>`，基于 `integration/v0.10-base`）。**不要 cd 到别的仓库目录，不要碰 git stash。**
- 每个 Bash 开头：`unset http_proxy https_proxy all_proxy; export no_proxy="127.0.0.1,localhost,::1"`。
- `node_modules` 与 `.venv` 是指向主检出的软链，不要 `bun install`。
- 这台机器内存紧：**一次只跑一个套件**；不要并行开多个 bun test；跑完整套件前先跑自己的门禁文件。

## 足迹（越界 = 交收口，不许自己动）
| 文件 | 归属 |
|---|---|
| `backend/src/agents/orchestrator.ts` · `server/app.ts` · `server/routes/session.ts` · `index.ts` · `llm/router.ts` | **收口专属**。lane 需要改这些文件时，把 ≤10 行的 diff 写进 devlog「收口 diff」段，附一条门禁 |
| `backend/src/agents/literature_pipeline.ts` · `literature/**` · `connectors/**` · `http/**` · `llm/budget.ts` | α（速度）、γ（质量）共用：**α 只改速度相关（并行、maxTokens、预筛、S10）；γ 只改中文/凭据/错误形状**；同一函数两边都要动的，先在各自 devlog 写清，收口合 |
| `backend/src/agents/progress.ts` · `server/sse.ts` · `server/types.ts`（事件类型）· `contract/**` | β |
| `routes/settings/**` · `config/**` · `daemon/credentials.ts` | γ |
| `doctor/**` · `project/**` · `cli/**` · `docs/taskbooks/**` · `scripts/**` | δ |
| `frontend/**` | ε |
| `tests/unit/<自己的门禁文件>` · `docs/devlog/W10-<lane>.md` | 各自 |

## 纪律（v0.9 + 本地窗口的教训）
1. **每一小步 commit + push**（`git push -u origin feat/W10-<lane>`），push 后 `git ls-remote origin feat/W10-<lane>` 核对。
2. **先 commit 再做阴性对照**——`git checkout` 会冲掉未提交改动（本地窗口真踩过）。
3. 每条改动配门禁 + 至少一条阴性对照实跑变红；**门禁要钉「接线」而不只钉「内容」**（U40/U47 的教训：判据存在但没被读到，测试照样绿）。
4. 报告里的数字只信复跑：devlog 里贴命令与输出原文，不写「预计」。
5. 凭据永不入 repo/日志/提示词；commit 前 `grep -nE "sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}"` 新增文件。
6. 结束时 SubagentHandback：改了什么文件、门禁条数、阴性对照结果、**收口 diff**（枢纽文件要改的行）、如实交代（没做完的、拿不准的）。
