# W9 lane β · 模型控制面（U10 / U9 / U5 / V16）

worktree `~/Desktop/AI4S/spark-research-beta`，分支 `feat/W9-beta`，基线 `integration/v0.9-base`（f921bf0）。

顺序按任务书：**β-3 前置盘点 → β-3 派生清单与抛错 → β-1 `chat()` 真读 model → β-2 `chat` 旗标**。

---

## β-3 前置 · 在用模型名盘点（`scripts/inventory-model-names.ts`）

为什么先做：β-3 要把 `providerForModel()` 结尾的 `return "kimi"` 改成抛错。改完之后
**正在用、但没显式登记的模型名会当场失败**（U5 的「风险」段原话）。所以先盘点。

扫描面：`~/.spark-research/config.json` 的 `defaultModel` / `subAgentModel_*` / `embeddingModel`，
加 `~/.spark-research/projects/*/usage.jsonl` 里出现过的全部 `model` 值（带出现次数与台账里
实际记下的 provider）。只读，绝不碰 credentials.json，不打印任何 `*_API_KEY`。

实跑结果（2026-09-15，真实数据目录）：

```
$ bun scripts/inventory-model-names.ts
数据目录：/Users/jimmyclaw/.spark-research · 模型名 2 个
```

| 模型名 | 调用次数 | 出现在 | 现行路由 | 判据 | 单价表 |
|---|---|---|---|---|---|
| `z-ai/glm-5.3-flash` | 2137 | `config:defaultModel` + 29 个项目的 usage.jsonl | openrouter（台账记 openrouter） | 显式登记 | 有 |
| `moonshotai/kimi-k2.6` | 108 | `usage:r5-t3`、`usage:r5-t3-copy` | openrouter（台账记 openrouter） | 显式登记 | 有 |

**β-3 影响面：无。** 在用的两个模型名都显式登记且都在单价表里，改抛错不会打断任何正在用的模型。
`subAgentModel_*` / `embeddingModel` 在 config.json 里一项都没配（全部走默认），所以也没有
隐藏的第三个在用名字。

**顺带坐实了 U10。** 盘点是按 `usage.jsonl` 里真实落下的 `model` 字段聚合的：U10 现场跑过
`deepseek-v4-flash` 与 `qwen-max` 两轮，但全库 2245 条调用记录里这两个名字**一条都没有**，
`usage:speed-probe` 那一项只挂在 `z-ai/glm-5.3-flash` 名下。这与 U10 证据一（台账里一条
deepseek 记录都没有）是同一个事实的两次独立观测——模型覆盖从未生效。
