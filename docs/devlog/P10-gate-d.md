# P10 · 闸门 D 收口（v0.3.0）

> 2026-09-09 ~ 09-10 · 四条 lane 并行 + 主会话串行收口
> lane 各自的详细记录见 `P10-a.md` / `P10-b.md` / `P10-c.md` / `P10-d.md`，本文只记**收口与教训**。

## 1. 做法：四条 lane 并行，主会话审 + integration 分支收

按 `DEVELOPMENT_PLAN_v0.3.md` §6.3 执行：一 lane 一 worktree、文件所有权互斥、
高冲突文件（CHANGELOG / BACKLOG / README）禁止 lane 触碰、lane → integration → 一个 PR 进 main。

| lane | 范围 | 结果 |
|---|---|---|
| D-a 连接器 | D-1 P0 竞态 | 显式 handlers 表；**魔法分发契约一并废除** |
| D-b 运行时管道 | D-2 超时 / D-3 stderr / D-5 dispose / D-4 战术版 | 四层超时 + kernel 死锁 + 4 处 `res.ok` |
| D-c 安全面 | D-6 config 0600 / D-7 Origin+Content-Type | 两道闸，攻击链在真实 approve 端点上验过 |
| D-d 湿域状态机 | D-8 安全门收敛 / D-9 CAS / D-10 一次性 approval | 三项全完成，附 record 完整性哈希 |

主会话收口：D-11 文档漂移、D-12 叙事一致性门禁、超时配置进注册表、
`test:py` / `test:lab` 修复、6 条 BACKLOG 登记、跨 lane 语义冲突修复。

## 2. 三条 lane 自发做了同一件事：阴性对照

D-a 把 `connectors/` 回退到修复前 → 并发测试稳定 `3 pass / 2 fail`；
D-b 回退 D-5 → 并发测试挂死，回退 D-3 → 灌流测试死锁。
主会话给 D-12 门禁也做了同样的事：把 `approvalGate.to` 改回 `"wet_run"` → 红；
把 `swarm.ts` 从白名单撤掉 → 红。

**新增的测试如果没被验证过会红，它就是装饰。** 这条应该进工程纪律。

## 3. 教训一：文件不冲突 ≠ 语义不冲突（已被工程纪律第 11 条覆盖）

lane D-d 把 `wet_run` 拆成 `approved` / `executing` 之后，`server/routes/lab.ts` 里
手写的 `approvalGate` 仍然自称 `to: "wet_run"`。四条 lane 各自全绿，合起来红。

**更值得记的是：这不只是测试要跟着改。** `/api/lab/machine` 是 AD-6 的机器可读表达，
UI 与外部 agent 都读它画状态机——它谎报了门的位置，而且**是靠合并撞出来才发现的，
不是靠门禁**。所以 D-12 的第三条断言就是从这里长出来的：
自描述端点的门必须能从 `WET_LEGAL_TRANSITIONS` **推导**出来，不许手写。

## 4. 教训二：并行的破口在跨会话，不在 lane 之间

lane 纪律执行得很好，四条都守住了「不 push / 不 PR / 不 merge」。
但同期另一个会话在做 v0.2.1，直接把 P10 的 lane 分支合进了 main——
而这些 lane 是从 v0.2.1 之前的 `19a3586` 拉出来的，于是 **v0.2.1 的三个修复被静默绕过**：
tag 声称的修复在 main 上根本不存在、版本号回退、回归测试文件消失。
不冲突、不告警，靠截图时偶然瞥见 `/api/health` 报 0.2.0 才发现（工程纪律第 10 条即由此而来）。

**方案 §6.3 防的是 lane 之间的冲突，没防跨会话。** 下一阶段（v0.4 P11）开工前需要补一条：
同一仓库同时只允许一个会话拥有合并权，或者 integration 分支必须先 rebase 到 origin/main
并显式核对 tag 仍是祖先。

## 5. 教训三：孤儿检测第一次跑就抓到评审没发现的东西

D-12 的孤儿模块检测在 100 个 `.ts` 里报了 4 个，误报率为零：
`index.ts`（CLI 入口，合法）、`http/fixture.ts`（fixture 层只被测试用，是 P2 的设计）、
`swarm.ts`（已知缺口）——以及 **`proteins/analysis.ts`**。

最后一个是意外收获：`protein-analysis` 被 DESIGN §5.3 列为 10 个技能之一、
SKILL.md 写着「代码入口：`ProteinAnalysis.analyze(query)`」、有 12 个 e2e 用例，
**但没有任何生产入口**——无 CLI 命令、无 HTTP 路由、无 MCP 工具、不在 capabilities 里。
用户与外部 agent 都调不到它。AD-5「每个技能必须有 e2e 才算完成」在这里被**纸面满足**了：
有 e2e，但没有人能用。已登记 BACKLOG V22。

这说明 AD-5 的判据不够：**「有 e2e」应该收紧为「有 e2e **且** 有可达的生产入口」。**

## 6. 安全门：只收敛了声明，没补全实现

D-8 按授权走的是「最小实现 + 强制告警」，所以必须如实说清楚：

- `volume_capacity` —— 自然语言主管线上全程可信
- `chemical_compatibility` —— 词表扩到中英文 + 常见分子式，**仍是有限词表**
- `concentration_limit` / `biosafety` —— **在主管线上恒空转**，编译器从不产生它们要的字段

补位的是 `unconsumedWarnings`（用户写了但没有任何规则消费 → 显式告警，审批面必须显示）。
README 与 DESIGN 已按此口径改写。**对接物理 Opentrons 的硬前置仍未满足**（BACKLOG V6 / V25）。

## 7. 数字

| | 基线（v0.2.0） | v0.3.0 |
|---|---|---|
| `tests/unit/` | 824 pass / 0 fail | **904 pass / 0 fail / 0 skip** |
| `tests/concurrency/` | — | 8 |
| `tests/timeout/` | — | 4 |
| pytest | 48 | 48 |
| `bun run test:lab` | **0（空转）** | 26 |
