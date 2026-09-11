# Spark Research · Agent 集成指南（v0.6）

> 写给**把 spark-research 当工具用的 AI agent**（及其开发者）。
> 机器可读的完整命令/工具参考是 `llms.txt`（简版）与 `llms-full.txt`（全量）——
> 本文只讲 llms.txt 不会告诉你的事：集成面选型、纪律、以及零上下文实测中
> agent 真实踩过的坑。本文断言全部来自 v0.6 的六次零上下文 agent 实测。

## 1. 三个集成面，怎么选

| 面 | 入口 | 适合 |
|---|---|---|
| **MCP server**（推荐） | `spark-research mcp`，30 个工具 | 有 MCP runtime 的 agent；工具描述即契约 |
| CLI + `--json` | 所有查询类子命令都有 `--json` | 沙盒里只有 shell 的 agent |
| HTTP | `spark-research server`，66 端点 | 常驻服务/多客户端 |

能力自描述：`spark-research capabilities --json`——技能/连接器/平台的可用性是
**机器可核的真实探测**，不是宣传（有门禁保证声称与实现一致）。

## 2. 五条纪律（违反的后果都被实测过）

1. **每条涉及项目数据的命令都带 `--project <slug>`。**
   全局项目指针是共享可变状态；两个并发 agent 不带它时曾互相污染对方项目
   （双向实锤）。v0.6 起全部命令支持显式覆盖，带上即完全隔离。
2. **每条会调 LLM 的命令都带 `--budget-usd <N>`。**
   预算闸按项目累计已知花费判停，拒绝时零花费、已完成产出保留。
   用 `usage --project <slug> --json` 对账；`unknownCostCalls > 0` 时总额不可确报。
3. **长任务用轮询，不要等通知。**
   `lit read --all` / `lit review` / `idea check` 返回任务句柄后在前台跑；
   如果你把它们放后台，**没有任何机制会通知你**——用
   `lit tasks --project <slug>` 每 30–60 秒轮询到终态。
   （六次实测里每个 agent 都在这里停过一次，这是最常见的集成错误。）
4. **`lit add` 只吃标识符**（DOI / arXiv id / PMID / OpenAlex id）。
   认不出形态或无源可解析（如 AMiner 内部 24 位 hex id）会**前置拒绝、零查询**——
   这是防「宽容解析成无关论文还报成功」的门。标题/关键词走 `lit search`。
5. **审批类动作你调不到，这是设计不是缺陷。**
   `lab approve` / `compute approve|run|release` 不暴露为 MCP 工具、无 HTTP 路由，
   CLI 层要求真实 TTY——湿实验与计费动作必须真人批准（AD-9/AD-14）。
   你的正确动作是把待审批项呈现给人类，而不是找绕过的路。

## 3. 输出契约要点

- 检索结果的 `sources[].note` 会说明「结果是怎么来的」——例如中文查询 0 命中时
  自动拆词合并会在此标注。**不要把拆词合并的结果当原查询命中来汇报召回。**
- 每张精读卡的 record metadata 带 `basis: "fulltext"|"abstract"`（及降级原因）——
  引用精读结论时应向用户传递这个置信差异。
- 失败消息统一带「下一步」指引，可直接执行；`skipped`（缺凭据/形态不符）与
  `failed`（网络/上游）语义不同，处理动作不同。
- 引用核验有 hard finding 时 `lit review` 退出码为 1——**草稿不可交付**，
  不要把它当成功结果透传。
- 证据图查询：`report records --json` / `report show <id> --json`（含入边出边）。

## 4. 已知边界（对外声称时请如实转述）

- 检索排序会让奠基性论文沉底（英文基准召回 3/8–5/8）；重要文献用 DOI 直加补齐。
- 中文查询概念间需空格；连写复合词无法命中（无分词器）。
- bioRxiv 的 search 是「最近 N 篇 + 客户端打分」模拟，查不到 ≠ 不存在。
- Modal 远端算力只有契约；湿实验止步模拟器。
- 同项目内不要并发跑两个写操作（如同时 `idea new` 与 `idea check`）——
  SQLite 会报 `database is locked`，串行重试即可。

## 5. 最小可行调用序列（经实测的黄金路径）

```
project new <slug> → lit search "<q>" --add --project <slug>
→ lit pdf --all → lit read --all --budget-usd 2（前台，或后台+lit tasks 轮询）
→ lit review --budget-usd 2（退出码 0 才算综述可用）
→ idea new -m "<想法>" --budget-usd 2 → idea check <id> --budget-usd 2
→ report export → usage --json（对账收尾）
```

一次零上下文 agent 走完全程的实测成本：$0.03–0.07（glm-5.3-flash）。
