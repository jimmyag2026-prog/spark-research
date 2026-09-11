# alpha.5 收口（主会话）

> `v0.7.0-alpha.4` → `v0.7.0-alpha.5`。三条 lane：B-2（#76）· B-4（#73）· C-1（#74），主会话逐条独立复跑 + 阴性对照后合入。

## 收口做的事

| 项 | 内容 |
|---|---|
| V71 接线 | `lit review` 在落 citation-integrity 计数 record 之后调 `project.findings().reviewTarget()`，fingerprint 复用 `reviewer/agent.ts` 的 `computeFingerprint`（导出）。测试 `w7a5_v71_wiring.test.ts`：judge 不可用的 soft finding 登记、两次运行 fingerprint 一致。阴性对照：`if (false)` 掉 reviewTarget → 红 |
| B-2 深池与 fixture | `LiteratureSearcher` 加 `deepPool` 选项，fixture 场景注入 10（cassette 按 10 录制）；CLI blended 档不再把 `--limit` 当每源数，`--per-source` 覆盖 |
| 文档 | CHANGELOG alpha.5 · BACKLOG V64/V65/V67/V71/V72 归账 · README「并发使用与会话绑定」· 方案 §七·补 编号更正 |

## 过程中的两件事（如实）

1. **B-2 lane 被 Claude 额度中断**：未提交改动由主会话落 wip commit（信息标「未经任何验证」）推远端，用户恢复额度后 SendMessage 复活同一 agent 续做；终态分支已把 wip 改写成正式 commit。中间成果零丢失。
2. **B-2 交付时 6 处单测 + e2e 18 条红**：深池让按 10/源录制的 cassette miss。lane 如实报告并给了修法；收口没有重录 cassette，而是让测试场景注入录制条件（deepPool=10）——生产默认不变、测试如实。

## 六套件（收口分支）

typecheck 0 · unit 2265 + 1（V71 接线）· e2e 20 · concurrency+timeout 28 · py 73 · lab 26 · 二进制冒烟 exit 0（0.7.0-alpha.5）。
