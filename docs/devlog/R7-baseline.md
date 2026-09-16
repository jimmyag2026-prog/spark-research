# R7 基线复测 · v0.10.0-alpha.1 · 2026-09-16T00:13:07.345Z

> 口径与 R6 完全一致（`scripts/measure-chat.ts`，消息文本冻结，每项目 5 轮，P50 = 5 轮中第 3 小）。
> 项目换成本轮新建的 `t*-r7`（台账起始 0 行）。**脚本标题里写死的是「R6 基线」，本文件首行已按实改为 R7**——
> 脚本本身没改（验收不改被验收物，V58），登记为 U63。

## 网络前提（R7 自测，硬前置）

```
$ for i in 1 2 3 4 5; do curl -s -o /dev/null -m 20 -w "%{time_connect}\n" https://openrouter.ai; done
1.275248
0.185896
0.186790
0.185972
0.184291
```

中位 0.186s · 最大 1.275s → **达标**（中位 < 1s 且最大 < 3s）。
measure-chat 自己在正式跑那一次又探了一遍：`0.17 / 0.17 / 0.18 / 0.18 / 0.18s → 中位 0.18s 最大 0.18s → 达标`。

## ① 一句话 chat（与 R6 并排）

server 0.10.0-alpha.1 · 消息「用三句话说明什么是蛋白质的二级结构。」· 每项目 5 轮 · 网络前提 中位 0.18s 最大 0.18s（达标）

| 项目 | 墙钟 P50 | 墙钟 P90 | 调用/轮 中位 | 调用/轮 最大 | 失败轮 | errorKind 分布 |
|---|---:|---:|---:|---:|---:|---|
| t1-protein-r7 | 38.0s | 69.2s | 3 | 3 | 0/5 | — |
| t2-sc-r7 | 34.1s | 41.9s | 3 | 3 | 0/5 | — |
| t3-bci-r7 | 30.9s | 57.4s | 3 | 3 | 0/5 | — |
| t4-pero-r7 | 36.0s | 105.7s | 3 | 3 | 0/5 | — |

## 原始 usage.jsonl 新增行（可复核）

### t1-protein-r7 · 第 1 轮（HTTP 200，26.7s，新增 3 行）
```json
{"ts":"2026-09-15T23:59:28.082Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":600,"costUsd":0.0002573923}
{"ts":"2026-09-15T23:59:30.277Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":163,"costUsd":0.00046244000000000005}
{"ts":"2026-09-15T23:59:37.493Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":564,"outputTokens":462,"costUsd":0.000166488}
```

### t1-protein-r7 · 第 2 轮（HTTP 200，69.2s，新增 3 行）
```json
{"ts":"2026-09-15T23:59:57.460Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":600,"costUsd":0.0002573923}
{"ts":"2026-09-15T23:59:58.842Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":205,"costUsd":0.0005178800000000001}
{"ts":"2026-09-16T00:00:46.659Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":553,"outputTokens":247,"costUsd":0.0001089009}
```

### t1-protein-r7 · 第 3 轮（HTTP 200，30.3s，新增 3 行）
```json
{"ts":"2026-09-16T00:01:09.399Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":600,"costUsd":0.0002573923}
{"ts":"2026-09-16T00:01:11.113Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":219,"costUsd":0.00053636}
{"ts":"2026-09-16T00:01:16.949Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":563,"outputTokens":376,"costUsd":0.0001437221}
```

### t1-protein-r7 · 第 4 轮（HTTP 200，47.3s，新增 3 行）
```json
{"ts":"2026-09-16T00:01:46.682Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":600,"costUsd":0.0002573923}
{"ts":"2026-09-16T00:01:47.950Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":149,"costUsd":0.00044395999999999997}
{"ts":"2026-09-16T00:02:04.269Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":554,"outputTokens":383,"costUsd":0.00014485679999999999}
```

### t1-protein-r7 · 第 5 轮（HTTP 200，38.0s，新增 3 行）
```json
{"ts":"2026-09-16T00:02:19.354Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":195,"costUsd":0.0001505533}
{"ts":"2026-09-16T00:02:21.699Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":587,"outputTokens":222,"costUsd":0.00055132}
{"ts":"2026-09-16T00:02:42.226Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":651,"outputTokens":927,"costUsd":0.0002960367}
```

### t2-sc-r7 · 第 1 轮（HTTP 200，22.9s，新增 3 行）
```json
{"ts":"2026-09-16T00:02:53.281Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1252,"outputTokens":128,"costUsd":0.0001327996}
{"ts":"2026-09-16T00:02:57.091Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":614,"outputTokens":602,"costUsd":0.0010647999999999999}
{"ts":"2026-09-16T00:03:05.091Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":735,"outputTokens":700,"costUsd":0.00024279849999999997}
```

### t2-sc-r7 · 第 2 轮（HTTP 200，41.9s，新增 3 行）
```json
{"ts":"2026-09-16T00:03:32.602Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1252,"outputTokens":600,"costUsd":0.00025731319999999997}
{"ts":"2026-09-16T00:03:33.761Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":156,"costUsd":0.0004532}
{"ts":"2026-09-16T00:03:46.997Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":554,"outputTokens":1178,"costUsd":0.0003545778}
```

### t2-sc-r7 · 第 3 轮（HTTP 200，34.1s，新增 3 行）
```json
{"ts":"2026-09-16T00:03:57.188Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1252,"outputTokens":119,"costUsd":0.0001304254}
{"ts":"2026-09-16T00:04:01.660Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":618,"outputTokens":585,"costUsd":0.00104412}
{"ts":"2026-09-16T00:04:21.091Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":887,"outputTokens":961,"costUsd":0.00032367349999999997}
```

### t2-sc-r7 · 第 4 轮（HTTP 200，32.0s，新增 3 行）
```json
{"ts":"2026-09-16T00:04:37.691Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1251,"outputTokens":600,"costUsd":0.0002572341}
{"ts":"2026-09-16T00:04:39.090Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":211,"costUsd":0.0005258000000000001}
{"ts":"2026-09-16T00:04:53.053Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":547,"outputTokens":1200,"costUsd":0.0003598277}
```

### t2-sc-r7 · 第 5 轮（HTTP 200，37.3s，新增 3 行）
```json
{"ts":"2026-09-16T00:05:15.967Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1251,"outputTokens":600,"costUsd":0.0002572341}
{"ts":"2026-09-16T00:05:17.087Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":162,"costUsd":0.00046112000000000003}
{"ts":"2026-09-16T00:05:30.396Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":533,"outputTokens":1200,"costUsd":0.0003587203}
```

### t3-bci-r7 · 第 1 轮（HTTP 200，29.2s，新增 3 行）
```json
{"ts":"2026-09-16T00:05:43.638Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":600,"costUsd":0.0002573923}
{"ts":"2026-09-16T00:05:44.841Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":132,"costUsd":0.00042152}
{"ts":"2026-09-16T00:05:59.603Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":558,"outputTokens":1129,"costUsd":0.000341968}
```

### t3-bci-r7 · 第 2 轮（HTTP 200，30.9s，新增 3 行）
```json
{"ts":"2026-09-16T00:06:15.500Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":600,"costUsd":0.0002573923}
{"ts":"2026-09-16T00:06:16.913Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":153,"costUsd":0.00044924000000000006}
{"ts":"2026-09-16T00:06:30.542Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":552,"outputTokens":1200,"costUsd":0.00036022319999999997}
```

### t3-bci-r7 · 第 3 轮（HTTP 200，24.7s，新增 3 行）
```json
{"ts":"2026-09-16T00:06:45.765Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":600,"costUsd":0.0002573923}
{"ts":"2026-09-16T00:06:46.634Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":85,"costUsd":0.00035948}
{"ts":"2026-09-16T00:06:55.217Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":527,"outputTokens":669,"costUsd":0.0002181679}
```

### t3-bci-r7 · 第 4 轮（HTTP 200，48.2s，新增 3 行）
```json
{"ts":"2026-09-16T00:07:26.927Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":600,"costUsd":0.0002573923}
{"ts":"2026-09-16T00:07:28.400Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":226,"costUsd":0.0005456}
{"ts":"2026-09-16T00:07:43.487Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":564,"outputTokens":1200,"costUsd":0.00036117239999999996}
```

### t3-bci-r7 · 第 5 轮（HTTP 200，57.4s，新增 3 行）
```json
{"ts":"2026-09-16T00:08:06.696Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1252,"outputTokens":600,"costUsd":0.00025731319999999997}
{"ts":"2026-09-16T00:08:08.267Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":178,"costUsd":0.00048224}
{"ts":"2026-09-16T00:08:40.895Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":547,"outputTokens":1200,"costUsd":0.0003598277}
```

### t4-pero-r7 · 第 1 轮（HTTP 200，31.6s，新增 3 行）
```json
{"ts":"2026-09-16T00:08:58.045Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":600,"costUsd":0.0002573923}
{"ts":"2026-09-16T00:08:59.228Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":126,"costUsd":0.0004136}
{"ts":"2026-09-16T00:09:12.525Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":554,"outputTokens":1200,"costUsd":0.0003603814}
```

### t4-pero-r7 · 第 2 轮（HTTP 200，33.8s，新增 3 行）
```json
{"ts":"2026-09-16T00:09:31.717Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":600,"costUsd":0.0002573923}
{"ts":"2026-09-16T00:09:33.082Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":172,"costUsd":0.00047432}
{"ts":"2026-09-16T00:09:46.307Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":558,"outputTokens":1200,"costUsd":0.00036069779999999994}
```

### t4-pero-r7 · 第 3 轮（HTTP 200，36.0s，新增 3 行）
```json
{"ts":"2026-09-16T00:10:06.641Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":600,"costUsd":0.0002573923}
{"ts":"2026-09-16T00:10:08.291Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":192,"costUsd":0.0005007200000000001}
{"ts":"2026-09-16T00:10:22.352Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":558,"outputTokens":250,"costUsd":0.00011008779999999999}
```

### t4-pero-r7 · 第 4 轮（HTTP 200，59.3s，新增 3 行）
```json
{"ts":"2026-09-16T00:10:40.361Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1253,"outputTokens":600,"costUsd":0.0002573923}
{"ts":"2026-09-16T00:10:41.336Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":31,"costUsd":0.0002882}
{"ts":"2026-09-16T00:11:21.606Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":495,"outputTokens":1200,"costUsd":0.0003557145}
```

### t4-pero-r7 · 第 5 轮（HTTP 200，105.7s，新增 3 行）
```json
{"ts":"2026-09-16T00:11:34.390Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1252,"outputTokens":600,"costUsd":0.00025731319999999997}
{"ts":"2026-09-16T00:11:36.161Z","command":"chat","provider":"deepseek","model":"deepseek-v4-flash","ok":true,"inputTokens":562,"outputTokens":243,"costUsd":0.00056804}
{"ts":"2026-09-16T00:13:07.299Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":565,"outputTokens":292,"costUsd":0.00012172109999999999}
```

---

## ① 的判定与对照

| 口径 | R6（v0.9.0-alpha.2） | **R7（v0.10.0-alpha.1）** | 变化 |
|---|---:|---:|---|
| t1-protein P50 | 97.3s | **38.0s** | −61% |
| t2-sc P50 | 101.4s | **34.1s** | −66% |
| t3-bci P50 | 26.9s | **30.9s** | +15%（变慢） |
| t4-pero P50 | 31.5s | **36.0s** | +14%（变慢） |
| 全部 20 轮合并 P50 / P90 | — | **35.1s / 59.3s**（min 22.9s · max 105.7s） | — |
| 调用/轮 | 中位 3 · 最大 5 | **中位 3 · 最大 3**（20/20 轮都是 3） | 方差消失 |
| 每轮输出 token | 机制解释那轮 8590（4 调用） | **中位 1748 · 均值 1601 · 最大 2026** | **−80%** |
| 失败轮 | 1/20（U13 idleTimeout） | **0/20** | — |
| 本节实花 | — | **$0.0208** | — |

**DONE「一句话 chat P50 ≤ 20s」= ❌。** 20 轮里**一轮都没有** ≤20s（最快 22.9s），四个项目的 P50 全在 30–38s。

判定理由与机制（不是猜，是台账里读出来的）：

1. **α-3 的 maxTokens 真的生效了**：20 轮逐轮的三次调用输出 token（台账原文在上面）——
   第 1 次（plan）**17/20 轮恰好 600**（`STAGE_MAX_TOKENS.plan`），另 3 轮 119/128/195（自然收尾）；
   第 3 次（summarize）**8/20 轮恰好 1200**（`.summarize`），其余 247–1178。
   「恰好等于上限」这个形状只有被截才会出现。每轮输出 token 从 R6 机制解释那轮的 8590（4 调用）
   降到**中位 1748 / 均值 1601**（3 调用）→ **−81%**，远超 α-3 自己「≥40%」的判据。
2. **但编排结构没变**：仍然是 plan → execute → summarize 三次调用，**一句话问题照样进完整编排**。
   `grep -rn "直答\|directAnswer\|direct_answer\|classif" backend/src/agents/*.ts` → **零命中**。
   `grep -rn "S1" docs/DEVELOPMENT_PLAN_v0.10.md docs/devlog/W10-*.md docs/taskbooks/v0.10/*.md` 只命中方案 §〇.6 一行，
   §三 的五条 lane（α-1…α-5 / β / γ / δ / ε）**没有任何一条认领 S1**，而 §六 DONE 第一条写的是「P50 ≤ 20s（**S1**+S2）」。
   → 这一条 DONE 的一半根本没进本版的施工范围。登记 **U59（P0，对 DONE 第 1 条）**。
3. 20 轮里出现了第二个 provider：每轮第 2 次调用是 `deepseek / deepseek-v4-flash`（562 输入 token，
   100–250 输出 token，1–2s）——这是 execute 段的便宜调用，不是回归。
4. **t3 / t4 变慢 14–15%** 值得单独说：R6 里它们本来就是快项目（26.9 / 31.5s）。
   R6 的 t3/t4 每轮 summarize 输出是 248–940 token；R7 的 t3 五轮是 1129 / **1200** / 669 / **1200** / **1200**，
   t4 五轮是 **1200** / **1200** / 250 / **1200** / 292——**8/10 轮顶到上限**，而 R6 同两个项目一轮都没到过 1000。
   也就是说上限对慢项目（t1/t2）是刹车，对本来就快的项目**反而把输出拉长了**：
   maxTokens 是上限不是目标，提示词与上限之间没有「够了就停」的约束。登记 **U60（P1）**。

---

## ② 文献流程 · quick 档

```
$ bun scripts/measure-chat.ts --pipeline pipe-quick-r7 --depth quick --budget 0.3
  · 检索「repetitive strain injury office workers prevention」
  · 预筛 6 篇候选
  · 预筛：6 篇 → 留 5 篇（阈值 2 分，上限 8）
  · 综述（quick 档，5 条摘要一次成稿）
# 文献流程基线 · 2026-09-16T00:14:38.002Z

server 无关（进程内）· quick 档 · 1 查询 · limit 6 · maxRead 3 · ok=true

| 阶段 | 耗时 |
|---|---:|
| search | 8.0s |
| prescreen | 28.5s |
| download | 0.0s |
| read（0 卡）| 0.0s |
| review | 25.3s |
| **total** | **61.9s** |

PDF 0/0 · 失败/缺口 2
- 源 openalex（「repetitive strain injury office workers prevention」）失败：Connector "openalex" tool "search" failed: HTTP 429
- 源 biorxiv（「repetitive strain injury office workers prevention」）失败：timeout: biorxiv 在 8000ms 内未返回（已按 timeout 记，其它源照常返回）
```

**判定：61.9s ≤ 90s → ✅。** 与 W10-0 的 181.5s（当时只有 deep 形态）比 −66%。
quick 档确实「不下载、不精读、一次调用出综述」：download 0.0s、read 0 卡。
**代价要说清楚**：quick 档的产物里**没有精读卡、没有 PDF**，综述只基于 5 条摘要——
W10-1 收口裁定②已把「chat 的 literature-review 默认 quick」写进 CHANGELOG，这里是它的实测形状。

新出现的一段是 **prescreen 28.5s**（α-1 的批量预筛，6 篇 → 留 5 篇）——它占 quick 档总时长的 46%，
比综述本身（25.3s）还长。**为 6 篇候选做的预筛比直接综述还贵**，登记 **U61（P2）**。

## ③ 文献流程 · deep 档

```
$ bun scripts/measure-chat.ts --pipeline pipe-deep-r7 --depth deep --budget 0.3
  · 检索「repetitive strain injury office workers prevention」
  · 预筛 6 篇候选
  · 预筛：6 篇 → 留 5 篇（阈值 2 分，上限 8）
  · 下载 PDF：Health behavior change among office workers: An exploratory
  · 下载 PDF：Shape-Changing Break Reminders for People with Repetitive St
  · 下载 PDF：Computer Use and Compressive Neuropathies of the Upper Limbs
  · 精读 2 篇（跳过 1 篇零摘要且无全文）
  · 综述（2 张精读卡）
# 文献流程基线 · 2026-09-16T00:17:46.565Z

server 无关（进程内）· deep 档 · 1 查询 · limit 6 · maxRead 3 · ok=true

| 阶段 | 耗时 |
|---|---:|
| search | 8.0s |
| prescreen | 39.5s |
| download | 2.7s |
| read（2 卡）| 69.4s |
| review | 57.9s |
| **total** | **177.6s** |

PDF 1/3 · 失败/缺口 3
- 源 openalex（…）失败：HTTP 429
- 源 biorxiv（…）失败：timeout 8000ms
- 跳过精读（库内无摘要、也没拿到 PDF，只凭标题生成的卡不可信）：Shape-Changing Break Reminders for People with Repetitive St
```

**判定：177.6s vs 判据 180s → 数字上过线 3 秒，但判据要的是「8 篇」，本次只精读了 2 篇 → 记 ❌（未被证明）。**

理由必须写清楚，不许含糊：
- `scripts/measure-chat.ts` 的 `--pipeline` 分支把 `limit 6 / maxRead 3` **写死**（脚本第 50 行），
  `--depth` 是本版唯一新增的开关。所以这个复测口径下**拿不到「8 篇 deep」的数**——
  DONE 第 1 条后半与 α-2 的「8 篇 deep 精读 ≤ 150s」在这条工具链上**不可判定**。登记 **U62（P1，方法/工具）**。
- 用本次的单位成本外推（**只作参考，不作判定**）：read 69.4s / 2 卡 ≈ 34.7s/卡，`readConcurrency` 默认 3 →
  8 卡约 3 批 ≈ 104s；加 search 8.0 + prescreen 39.5 + download 2.7 + review（8 卡的综述必然比 2 卡长）
  ≈ **190s 以上**，大概率超 180s。这是外推不是实测。
- 与 W10-0 的 181.5s（3 卡、无 prescreen 段）并排：total 177.6s 几乎持平，
  但内部结构变了——read 从 85.7s（3 卡）降到 69.4s（2 卡），多出来一段 prescreen 39.5s。

## ④ 同一批 8 篇 OA 论文 PDF ≥ 5（DONE 第 3 条 / α-4 / U51）

项目 `oa-r7`，检索式与 W10-0 基线同一条，`lit search … --limit 20 --add` 入库 20 篇，
`lit list --json` 里 **20/20 篇 `isOpenAccess: true`**，取前 8 篇逐篇 `lit pdf`：

```
b0cb01c7 ⚠️ not_a_pdf : https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/alz.13016
a6886516 ⚠️ not_a_pdf : http://bjanaesthesia.org/article/S0007091219302272/pdf
5d816140 ⚠️ http_403  : https://academic.oup.com/eurheartj/article-pdf/37/29/2315/23748850/ehw106.pdf
fc8adce3 ⚠️ http_403  : https://www.mdpi.com/1660-4601/19/7/3879/pdf?version=1648185857
3fc3cb4c ⚠️ not_a_pdf : https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/aisy.202100099
8170f4e3 ⚠️ http_403  : https://pure.amsterdamumc.nl/files/159878493/2016-european-guidelines-…pdf
3d5feadf ⚠️ http_403  : https://www.sciencedirect.com/science/article/pii/S0003687019301279/pdf
5cb8786d ✅ 已下载     : papers/odebiyi2023-musculoskeletal-5cb8786d.pdf
                        来源 landing_meta · 4391428 字节 · sha256:d3c8e923…
```

**判定：1/8 → ❌**（判据 ≥5/8）。U51 那次是 2/8，本次 1/8，**没有改善**。

根因不是「没做第二跳」，而是**第二跳问到的是同一条已经失败的链接**。手工对着三个失败 DOI 敲 Unpaywall：

```
$ curl -s "https://api.unpaywall.org/v2/10.1002/alz.13016?email=<已配置的联系邮箱>"
  is_oa True | best pdf: https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/alz.13016
$ …/10.1093/eurheartj/ehw106   → is_oa True | best pdf: https://academic.oup.com/eurheartj/article-pdf/…/ehw106.pdf
$ …/10.3390/ijerph19073879     → is_oa True | best pdf: https://www.mdpi.com/1660-4601/19/7/3879/pdf?version=1648185857
```

三条 **逐字节等于**上面已经 403 / not_a_pdf 的那条直链。也就是说 α-4 的 Unpaywall 兜底
对 Wiley / OUP / MDPI / Elsevier 这几家**结构上不可能有增量**：OpenAlex 的 `best_oa_location`
本来就是从 Unpaywall 同源数据来的。真正挡路的是出版商的反爬（403）与登录/落地页（not_a_pdf）。
唯一成功的那篇走的是 **`landing_meta`**（α-4 的第一跳，IntechOpen 落地页里解析出真直链）——
**第一跳是有效的，第二跳是空转。** 登记 **U64（P0，对 DONE 第 3 条）**。

一处正面观察：`lit pdf` 的失败原因分得很细（`not_a_pdf` / `http_403` / `no_oa_link`），
并写进库内 `pdf_reason` 且「不会重复重试」——这条比 U51 时清楚得多。
但 **CLI 不打印 attempts 明细**，α-4 的「两跳到底发生了没有」在命令行上看不见（我是靠读源码 + 手敲 Unpaywall 才判出来的），
登记 **U65（P2，可观测性）**。

## ⑤ 本节合计花费

| 项 | 实花 |
|---|---:|
| ① 一句话 chat 20 轮（4 个 `t*-r7` 台账合计 60 行） | $0.0208 |
| ② quick 档（`pipe-quick-r7` 台账 2 行：预筛 1 + 综述 1） | $0.0154 |
| ③ deep 档（`pipe-deep-r7` 台账 4 行：预筛 1 + 精读 2 + 综述 1） | $0.0367 |
| ④ OA PDF（纯 HTTP，`oa-r7` 无台账文件） | $0 |
| **小计** | **$0.0729** |
