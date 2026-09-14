# W9-1 lane 共同纪律（每条 lane 任务书都引用本文，逐条硬约束）

- **仓库**：`github.com/jimmyag2026-prog/spark-research`。你的 worktree 与分支在任务书首行；**每条命令都显式 `cd` 进你的 worktree**，不要依赖当前目录。方案真源：`docs/DEVELOPMENT_PLAN_v0.9.md`（§三你那条 lane 的行、§六足迹表、§七砍尾顺序）；工程纪律 `docs/DEVELOPMENT_PLAN.md`；BACKLOG 条目原文 `docs/BACKLOG.md`；**使用现场原文 `docs/USAGE_LOG.md`**（U 编号的证据段是你的需求来源，先读它再读任务书）。
- **基线**：`v0.9.0-alpha.1`（闸门 I 已合入）。从它切分支：`git worktree add ~/Desktop/AI4S/spark-research-<lane> -b feat/W9-<lane> v0.9.0-alpha.1`。
- **足迹（一文件一主）**：只改任务书「允许」列出的文件；「禁止」列出的文件**一行都不碰**。需要它们改动时，把 ≤10 行的 diff 原文写进报告的「收口 diff」段，收口合入。**枢纽文件一律归收口**：`backend/src/index.ts` · `backend/src/llm/router.ts` · `backend/src/agents/orchestrator.ts` · `backend/src/server/app.ts` · `backend/src/server/routes/session.ts`，以及 `CHANGELOG.md` · `docs/BACKLOG.md` · `README.md` · `llms*.txt` · `docs/DESIGN.md` · `docs/DEVELOPMENT_PLAN*.md`。
- **「等接线」登记**：你新建但无权接线的模块，往 `tests/unit/narrative_parity.test.ts` 的 `ALLOWED_ORPHANS` 登记并写清「等收口接 X」；收口接上后按对称检查删除。接了不删会红，忘接也会红。
- **测试只增不减**：改动完成后在你的 worktree 实跑并把数字写进报告：`bun run typecheck` · `bun test tests/unit` · `bun run test:concurrency` · `bun run test:timeout` · `bun run test:lab`（**看 skip 数，不能是 0 passed 或大量 skipped**）· **跨层改动（碰了前端/HTTP/CLI 输出）必须再跑 `bun run test:e2e`**。任何一套红就不能报完成——修好或如实写「红在哪、为什么」。
- **阴性对照必做**：每条新门禁/新断言至少一条「把修复拆掉→测试必须红」的对照，**真跑**，把改法与红/绿结果写进 `docs/devlog/W9-<lane>.md`（新文件，属于你）。没跑的不许写「已验证」。
- **闸门 I 门禁必须绿**：`tests/unit/gate_i_*.test.ts`。你新增的可选参数 / 行为开关字段 / 配置项都必须有读者；确实要留空的，进 allowlist 并带原因字符串。
- **AD-12**：`tests/unit/narrative_parity.test.ts` 必须绿；不许在描述/帮助文案里声称没做到的能力。
- **并行噪音**：多 lane 并行时 spawn python 子进程的 probe 单测可能超时。**报数前把超时用例单独重跑一次**，单独跑绿就写「并行超时、单独重跑 N/N 绿」，别当自己的回归也别藏。
- **凭据永不入 repo/日志/报告**；commit 前对新增文件跑 `grep -nE "sk-[A-Za-z0-9]{20,}|api[_-]?key *[:=] *['\"][A-Za-z0-9]{16,}|Bearer [A-Za-z0-9._-]{15,}"`。α-4 落错误摘要时**先脱敏**——上游错误体可能带 key 片段。
- **Git**：只在你的 lane 分支 commit；**不合 main、不开 PR、不打 tag**；做完 `git push -u origin <你的分支>` 并 `git ls-remote origin refs/heads/<你的分支>` 核对远端 ref，**不核对不许报完成**。网络/额度中断先落 wip commit 并在信息里标「未经任何验证」。commit message 末尾固定两行：
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01B5LKEur3EUffn3q7XTPNGW`
- **报告**（最终回复）按这个顺序：① 改了哪些文件（相对路径）② 新增/修改的测试与门禁 ③ 六套件数字（每套一行）④ 阴性对照表（改法→结果）⑤ **收口 diff**（禁止文件的 ≤10 行改动原文）⑥ **如实交代**：没做到的、拿不准的、与任务书的偏差 ⑦ 远端 ref 的 sha。**不要美化数字；收口会独立复跑，对不上比红更糟。**
