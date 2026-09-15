# R6 基线 · 2026-09-15T08:23:41.919Z

server 0.9.0-alpha.2 · 消息「用三句话说明什么是蛋白质的二级结构。」· 每项目 5 轮 · 网络前提 中位 0.20s 最大 0.43s（达标）

| 项目 | 墙钟 P50 | 墙钟 P90 | 调用/轮 中位 | 调用/轮 最大 | 失败轮 | errorKind 分布 |
|---|---:|---:|---:|---:|---:|---|
| t1-protein-r3 | 97.3s | 213.2s | 3 | 4 | 0/5 | — |
| t2-sc-r3 | 101.4s | 287.2s | 3 | 5 | 0/5 | — |
| t3-bci-r3 | 26.9s | 69.9s | 3 | 4 | 0/5 | — |
| t4-pero-r3 | 31.5s | 35.2s | 3 | 4 | 0/5 | — |

## 说明（主会话）

- 本表是**第四次**跑才成立的：前三次分别因 ①脚本给 `/api/session/chat?project=` 传项目而该路由不读它（U11，20 轮全记进 speed-probe）、②`budgetUsd` 是项目累计上限而非单次额度（U12，20 轮全被预算闸以 HTTP 200 拒绝）、③进程被系统低内存杀掉（墙钟丢失）而作废。已花的钱约 $0.08，都在各项目 `usage.jsonl` 里。
- **t2-sc-r3 第 1 轮 HTTP 0 / 287.2s / 新增 1 行**：不是上游失败，是 server 的 `Bun.serve idleTimeout = 255s`（`server/server.ts`，A5 时定的上限）把连接掐了；编排在服务端继续跑完，剩下的调用落到了下一轮的计数里（第 2 轮 5 次 = 自己 3 次 + 上一轮漏的 2 次）。**任何一轮 chat 超过 255s 客户端必然拿不到结果**——登记为 U13。该轮按「失败」口径计入 P90。
- 一句话 chat 的结构性开销：每轮 3 次模型调用（plan / execute / summarize），每次输出约 2000 token；t1/t2 更慢是因为 plan 出了连接器任务（UniProt/PDB 等真实网络 I/O）且 review 回合更多。**这就是 v0.9 DONE 第 2 条要压的数。**
- 逐轮原始记录：`R6-baseline.md.rounds.jsonl`（每轮一行，含 ts / wallMs / calls / http）。

## 原始 usage.jsonl 新增行（可复核）

### t1-protein-r3 · 第 1 轮（HTTP 200，97.3s，新增 3 行）
```json
{"ts":"2026-09-15T07:58:03.088Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":665,"costUsd":0.0002334864}
{"ts":"2026-09-15T07:58:35.825Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":705,"outputTokens":2232,"costUsd":0.0006445671}
{"ts":"2026-09-15T07:59:29.641Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":615,"outputTokens":2417,"costUsd":0.0006862511}
```

### t1-protein-r3 · 第 2 轮（HTTP 200，173.1s，新增 4 行）
```json
{"ts":"2026-09-15T07:59:49.995Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":1427,"costUsd":0.00043450199999999997}
{"ts":"2026-09-15T08:00:59.993Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":644,"outputTokens":5554,"costUsd":0.0015160856}
{"ts":"2026-09-15T08:01:53.102Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":631,"outputTokens":2163,"costUsd":0.0006205115}
{"ts":"2026-09-15T08:02:22.771Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":768,"outputTokens":1561,"costUsd":0.0004725406}
```

### t1-protein-r3 · 第 3 轮（HTTP 200，69.9s，新增 3 行）
```json
{"ts":"2026-09-15T08:02:40.024Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":1355,"costUsd":0.00041550839999999995}
{"ts":"2026-09-15T08:02:48.239Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":628,"outputTokens":207,"costUsd":0.00010428139999999999}
{"ts":"2026-09-15T08:03:32.668Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":666,"outputTokens":3532,"costUsd":0.0009844221999999998}
```

### t1-protein-r3 · 第 4 轮（HTTP 200，59.3s，新增 3 行）
```json
{"ts":"2026-09-15T08:03:38.747Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":354,"costUsd":0.0001514446}
{"ts":"2026-09-15T08:03:58.764Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":547,"outputTokens":1274,"costUsd":0.0003793489}
{"ts":"2026-09-15T08:04:31.931Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":489,"outputTokens":1400,"costUsd":0.00040799989999999996}
```

### t1-protein-r3 · 第 5 轮（HTTP 200，213.2s，新增 4 行）
```json
{"ts":"2026-09-15T08:04:53.877Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":1867,"costUsd":0.000550574}
{"ts":"2026-09-15T08:06:10.939Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":658,"outputTokens":6757,"costUsd":0.0018345444}
{"ts":"2026-09-15T08:06:55.677Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":633,"outputTokens":4466,"costUsd":0.0012282011}
{"ts":"2026-09-15T08:08:05.089Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":878,"outputTokens":4524,"costUsd":0.001262881}
```

### t2-sc-r3 · 第 1 轮（HTTP 0，287.2s，新增 1 行）
```json
{"ts":"2026-09-15T08:08:24.575Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":1758,"costUsd":0.0005218198}
```

### t2-sc-r3 · 第 2 轮（HTTP 200，56.6s，新增 5 行）
```json
{"ts":"2026-09-15T08:12:58.671Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":693,"outputTokens":12781,"costUsd":0.0034264441}
{"ts":"2026-09-15T08:13:10.286Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":684,"outputTokens":341,"costUsd":0.0001440602}
{"ts":"2026-09-15T08:13:14.423Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":1748,"costUsd":0.0005191818}
{"ts":"2026-09-15T08:13:20.305Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":646,"outputTokens":180,"costUsd":0.0000985826}
{"ts":"2026-09-15T08:13:48.862Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":737,"outputTokens":2242,"costUsd":0.0006497363}
```

### t2-sc-r3 · 第 3 轮（HTTP 200，67.7s，新增 3 行）
```json
{"ts":"2026-09-15T08:14:04.100Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":1194,"costUsd":0.00037303659999999997}
{"ts":"2026-09-15T08:14:28.271Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":664,"outputTokens":1946,"costUsd":0.0005658772}
{"ts":"2026-09-15T08:14:56.535Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":614,"outputTokens":2133,"costUsd":0.0006112528}
```

### t2-sc-r3 · 第 4 轮（HTTP 200，103.7s，新增 3 行）
```json
{"ts":"2026-09-15T08:15:21.138Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":1603,"costUsd":0.00048093079999999997}
{"ts":"2026-09-15T08:15:34.403Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":617,"outputTokens":719,"costUsd":0.00023847689999999998}
{"ts":"2026-09-15T08:16:40.209Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":670,"outputTokens":5063,"costUsd":0.0013886163999999998}
```

### t2-sc-r3 · 第 5 轮（HTTP 200，101.4s，新增 4 行）
```json
{"ts":"2026-09-15T08:17:11.348Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":2692,"costUsd":0.000768209}
{"ts":"2026-09-15T08:17:51.063Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":593,"outputTokens":2106,"costUsd":0.0006024690999999999}
{"ts":"2026-09-15T08:18:01.909Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":627,"outputTokens":659,"costUsd":0.00022343989999999995}
{"ts":"2026-09-15T08:18:21.626Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":812,"outputTokens":1294,"costUsd":0.0004055864}
```

### t3-bci-r3 · 第 1 轮（HTTP 200，25.6s，新增 3 行）
```json
{"ts":"2026-09-15T08:18:28.384Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":317,"costUsd":0.000141684}
{"ts":"2026-09-15T08:18:39.783Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":644,"outputTokens":677,"costUsd":0.00022953299999999997}
{"ts":"2026-09-15T08:18:47.209Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":544,"outputTokens":413,"costUsd":0.0001519798}
```

### t3-bci-r3 · 第 2 轮（HTTP 200，69.9s，新增 4 行）
```json
{"ts":"2026-09-15T08:18:54.053Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":394,"costUsd":0.0001619966}
{"ts":"2026-09-15T08:19:09.493Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":616,"outputTokens":905,"costUsd":0.00028746459999999996}
{"ts":"2026-09-15T08:19:24.841Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":631,"outputTokens":237,"costUsd":0.0001124327}
{"ts":"2026-09-15T08:19:59.078Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1018,"outputTokens":546,"costUsd":0.00022455860000000002}
```

### t3-bci-r3 · 第 3 轮（HTTP 200，21.1s，新增 3 行）
```json
{"ts":"2026-09-15T08:20:05.813Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":293,"costUsd":0.0001353528}
{"ts":"2026-09-15T08:20:11.767Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":589,"outputTokens":148,"costUsd":0.0000856323}
{"ts":"2026-09-15T08:20:20.199Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":519,"outputTokens":428,"costUsd":0.0001539593}
```

### t3-bci-r3 · 第 4 轮（HTTP 200，26.9s，新增 3 行）
```json
{"ts":"2026-09-15T08:20:25.760Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":284,"costUsd":0.0001329786}
{"ts":"2026-09-15T08:20:32.109Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":594,"outputTokens":280,"costUsd":0.0001208494}
{"ts":"2026-09-15T08:20:47.115Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":530,"outputTokens":248,"costUsd":0.0001073454}
```

### t3-bci-r3 · 第 5 轮（HTTP 200，29.3s，新增 3 行）
```json
{"ts":"2026-09-15T08:20:52.569Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":283,"costUsd":0.0001327148}
{"ts":"2026-09-15T08:21:07.374Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":670,"outputTokens":940,"costUsd":0.00030096899999999994}
{"ts":"2026-09-15T08:21:16.470Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":568,"outputTokens":527,"costUsd":0.0001839514}
```

### t4-pero-r3 · 第 1 轮（HTTP 200，35.2s，新增 3 行）
```json
{"ts":"2026-09-15T08:21:22.382Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":328,"costUsd":0.0001445858}
{"ts":"2026-09-15T08:21:38.789Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":631,"outputTokens":974,"costUsd":0.0003068533}
{"ts":"2026-09-15T08:21:51.718Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":624,"outputTokens":775,"costUsd":0.00025380339999999996}
```

### t4-pero-r3 · 第 2 轮（HTTP 200，31.5s，新增 4 行）
```json
{"ts":"2026-09-15T08:22:00.320Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":427,"costUsd":0.000170702}
{"ts":"2026-09-15T08:22:10.721Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":634,"outputTokens":626,"costUsd":0.00021528820000000002}
{"ts":"2026-09-15T08:22:17.483Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":662,"outputTokens":341,"costUsd":0.00014232}
{"ts":"2026-09-15T08:22:23.192Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":763,"outputTokens":377,"costUsd":0.0001598059}
```

### t4-pero-r3 · 第 3 轮（HTTP 200，17.5s，新增 3 行）
```json
{"ts":"2026-09-15T08:22:28.411Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":217,"costUsd":0.00011530399999999999}
{"ts":"2026-09-15T08:22:35.669Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":593,"outputTokens":346,"costUsd":0.0001381811}
{"ts":"2026-09-15T08:22:40.713Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":530,"outputTokens":338,"costUsd":0.00013108739999999997}
```

### t4-pero-r3 · 第 4 轮（HTTP 200，26.9s，新增 3 行）
```json
{"ts":"2026-09-15T08:22:46.658Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":304,"costUsd":0.0001382546}
{"ts":"2026-09-15T08:23:00.725Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":674,"outputTokens":761,"costUsd":0.00025406519999999995}
{"ts":"2026-09-15T08:23:07.652Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":519,"outputTokens":376,"costUsd":0.0001402417}
```

### t4-pero-r3 · 第 5 轮（HTTP 200，34.2s，新增 3 行）
```json
{"ts":"2026-09-15T08:23:14.922Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":488,"costUsd":0.0001867938}
{"ts":"2026-09-15T08:23:32.926Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":624,"outputTokens":1118,"costUsd":0.0003442868}
{"ts":"2026-09-15T08:23:41.906Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":466,"outputTokens":430,"costUsd":0.0001502946}
```

## 机制解释（v0.9.0 DONE 第 2 条「或给出机制解释并附实测数字」）

alpha.3 上用 `/api/session/stream` 的 α-3 进度事件给一轮 chat 打点（项目 `r6-probe`，消息同基线，2026-09-15 10:01Z，网络前提达标）：

| 阶段 | 起止 | 耗时 | 模型调用 | 输出 token |
|---|---|---|---|---|
| plan | +0.0 → +17.4s | 17.4s | 1 | 1586（一个「三句话」问题被拆成 **4 个任务**，含 PDB 连接器查询） |
| execute 1/4（analysis） | +17.4 → +41.9s | 24.5s | 1 | 1486 |
| execute 2–3/4（skill / connector） | +41.9s | ~0s | 0 | — |
| execute 4/4（analysis） | +41.9 → +81.3s | 39.4s | 1 | 2999 |
| summarize | +81.3 → +109.6s | 28.3s | 1 | 2519 |
| review | +109.6s | ~0s | 0 | 规则层 |
| **合计** | | **109.6s** | **4** | **8590 → 用户看到 1157 字** |

结论：墙钟几乎全部是**输出 token 的生成时间**（glm-5.3-flash 实测约 100 tok/s；4 次调用共 8590 输出 token ≈ 86s，占 78%），
不是网络、不是排队、不是 review。三个结构性原因：
① chat 模式对任何问题都走完整的 plan → execute → summarize 编排，一句话问题也拆 4 个任务；
② 每个阶段的提示词都在诱导长输出（plan 输出完整 research_contract，execute 的 analysis 任务写整段分析，summarize 再把它们重写一遍）；
③ 各阶段没有 `maxTokens` 上限（`gate_i_switch_readers` 盘点过：`maxTokens` 有读者但 chat 路径没设值）。

**本版没有压这个数**（v0.9 的目标是让它可量、可归因、可控——U1/U4/U10/U12/U13 都在这条链上）。
压它的杠杆已登记：V156（255s 天花板）之外，下一版立项「chat 直答路径」：简单问题不进编排（一次调用直答 + 规则 review），
复杂问题才 plan；各阶段设 `maxTokens`；plan 输出改紧凑 JSON。预期一句话问题从 ~110s 降到 ~15s（一次调用、~1000 输出 token）。
