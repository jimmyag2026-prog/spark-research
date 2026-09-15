# R6 基线 · 2026-09-15T11:04:12.685Z

server 0.9.0-alpha.3 · 消息「用三句话说明什么是蛋白质的二级结构。」· 每项目 5 轮 · 网络前提 中位 0.17s 最大 1.30s（达标）

| 项目 | 墙钟 P50 | 墙钟 P90 | 调用/轮 中位 | 调用/轮 最大 | 失败轮 | errorKind 分布 |
|---|---:|---:|---:|---:|---:|---|
| t1-protein-r3 | 51.1s | 133.6s | 4 | 4 | 0/5 | — |
| t2-sc-r3 | 28.6s | 34.8s | 3 | 3 | 0/5 | — |
| t3-bci-r3 | 33.3s | 42.5s | 4 | 4 | 0/5 | — |
| t4-pero-r3 | 40.8s | 50.4s | 3 | 4 | 0/5 | — |

## 与 R6 基线并排（主会话）

| 项目 | R6 P50 / P90 | A8 P50 / P90 | 变化 |
|---|---|---|---|
| t1-protein-r3 | 97.3s / 213.2s | 51.1s / 133.6s | ↓ |
| t2-sc-r3 | 101.4s / 287.2s（1 轮被 255s 掐断） | 28.6s / 34.8s | ↓ |
| t3-bci-r3 | 26.9s / 69.9s | 33.3s / 42.5s | P50 ↑ P90 ↓ |
| t4-pero-r3 | 31.5s / 35.2s | 40.8s / 50.4s | ↑ |

**如实交代**：两次测的是**同一条代码路径**（alpha.2 → alpha.3 没有动 chat 的调用结构），P90 三降一升是上游（OpenRouter / glm-5.3-flash）当时的生成速度波动，
**不是本版的功劳**。DONE 第 2 条按「机制解释」分支满足（见 `R6-baseline.md` §机制解释），不按「P90 下降」分支。
每轮调用数仍是 3–4 次，与机制解释一致；20 轮零失败、零闸拒（`A8-baseline.md.rounds.jsonl`）。

## 原始 usage.jsonl 新增行（可复核）

### t1-protein-r3 · 第 1 轮（HTTP 200，51.1s，新增 4 行）
```json
{"ts":"2026-09-15T10:50:12.752Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":831,"costUsd":0.0002772772}
{"ts":"2026-09-15T10:50:27.611Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":619,"outputTokens":1008,"costUsd":0.00031487329999999996}
{"ts":"2026-09-15T10:50:41.241Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":640,"outputTokens":886,"costUsd":0.0002843508}
{"ts":"2026-09-15T10:50:53.529Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1098,"outputTokens":985,"costUsd":0.0003466948}
```

### t1-protein-r3 · 第 2 轮（HTTP 200，41.5s，新增 4 行）
```json
{"ts":"2026-09-15T10:50:59.030Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":286,"costUsd":0.0001335062}
{"ts":"2026-09-15T10:51:11.726Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":591,"outputTokens":820,"costUsd":0.0002630641}
{"ts":"2026-09-15T10:51:28.164Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":638,"outputTokens":1237,"costUsd":0.00037678639999999997}
{"ts":"2026-09-15T10:51:34.998Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":712,"outputTokens":485,"costUsd":0.0001842622}
```

### t1-protein-r3 · 第 3 轮（HTTP 200，41.2s，新增 4 行）
```json
{"ts":"2026-09-15T10:51:44.115Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":516,"costUsd":0.0001941802}
{"ts":"2026-09-15T10:51:55.399Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":627,"outputTokens":712,"costUsd":0.00023742129999999997}
{"ts":"2026-09-15T10:52:07.272Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":637,"outputTokens":948,"costUsd":0.00030046909999999997}
{"ts":"2026-09-15T10:52:16.224Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":765,"outputTokens":278,"costUsd":0.0001338479}
```

### t1-protein-r3 · 第 4 轮（HTTP 200，133.6s，新增 3 行）
```json
{"ts":"2026-09-15T10:52:22.303Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":263,"costUsd":0.00012743879999999998}
{"ts":"2026-09-15T10:54:04.626Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":630,"outputTokens":3859,"costUsd":0.0010678372}
{"ts":"2026-09-15T10:54:29.842Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":527,"outputTokens":1785,"costUsd":0.0005125686999999999}
```

### t1-protein-r3 · 第 5 轮（HTTP 200，117.8s，新增 4 行）
```json
{"ts":"2026-09-15T10:54:36.811Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":448,"costUsd":0.0001762418}
{"ts":"2026-09-15T10:55:05.692Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":621,"outputTokens":2260,"costUsd":0.0006453090999999999}
{"ts":"2026-09-15T10:55:26.816Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":654,"outputTokens":1464,"costUsd":0.00043793459999999995}
{"ts":"2026-09-15T10:56:27.675Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":782,"outputTokens":5386,"costUsd":0.0014826829999999998}
```

### t2-sc-r3 · 第 1 轮（HTTP 200，10.8s，新增 3 行）
```json
{"ts":"2026-09-15T10:56:31.735Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":160,"costUsd":0.0001002674}
{"ts":"2026-09-15T10:56:34.673Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":580,"outputTokens":76,"costUsd":0.00006592680000000001}
{"ts":"2026-09-15T10:56:38.461Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":463,"outputTokens":110,"costUsd":0.0000656413}
```

### t2-sc-r3 · 第 2 轮（HTTP 200，34.8s，新增 3 行）
```json
{"ts":"2026-09-15T10:56:44.018Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":296,"costUsd":0.0001361442}
{"ts":"2026-09-15T10:57:03.315Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":640,"outputTokens":1525,"costUsd":0.000452919}
{"ts":"2026-09-15T10:57:13.298Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":577,"outputTokens":242,"costUsd":0.00010948030000000001}
```

### t2-sc-r3 · 第 3 轮（HTTP 200，30.7s，新增 3 行）
```json
{"ts":"2026-09-15T10:57:17.851Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":236,"costUsd":0.00012031619999999999}
{"ts":"2026-09-15T10:57:34.958Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":652,"outputTokens":1131,"costUsd":0.00034993100000000005}
{"ts":"2026-09-15T10:57:44.009Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":555,"outputTokens":520,"costUsd":0.00018107649999999997}
```

### t2-sc-r3 · 第 4 轮（HTTP 200，17.1s，新增 3 行）
```json
{"ts":"2026-09-15T10:57:48.054Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":199,"costUsd":0.0001105556}
{"ts":"2026-09-15T10:57:54.191Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":590,"outputTokens":342,"costUsd":0.0001368886}
{"ts":"2026-09-15T10:58:01.084Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":506,"outputTokens":482,"costUsd":0.00016717620000000001}
```

### t2-sc-r3 · 第 5 轮（HTTP 200，28.6s，新增 3 行）
```json
{"ts":"2026-09-15T10:58:06.268Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":301,"costUsd":0.00013746319999999998}
{"ts":"2026-09-15T10:58:20.680Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":665,"outputTokens":1020,"costUsd":0.0003216775}
{"ts":"2026-09-15T10:58:29.709Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":615,"outputTokens":624,"costUsd":0.00021325769999999998}
```

### t3-bci-r3 · 第 1 轮（HTTP 200，16.7s，新增 3 行）
```json
{"ts":"2026-09-15T10:58:33.210Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":137,"costUsd":0.0000942}
{"ts":"2026-09-15T10:58:39.465Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":586,"outputTokens":382,"costUsd":0.0001471242}
{"ts":"2026-09-15T10:58:46.375Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":515,"outputTokens":434,"costUsd":0.0001552257}
```

### t3-bci-r3 · 第 2 轮（HTTP 200，33.3s，新增 4 行）
```json
{"ts":"2026-09-15T10:58:52.181Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":398,"costUsd":0.0001630518}
{"ts":"2026-09-15T10:59:05.755Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":614,"outputTokens":892,"costUsd":0.000283877}
{"ts":"2026-09-15T10:59:14.274Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":623,"outputTokens":488,"costUsd":0.00017801369999999997}
{"ts":"2026-09-15T10:59:19.724Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":837,"outputTokens":444,"costUsd":0.0001833339}
```

### t3-bci-r3 · 第 3 轮（HTTP 200，42.5s，新增 4 行）
```json
{"ts":"2026-09-15T10:59:26.013Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":389,"costUsd":0.0001606776}
{"ts":"2026-09-15T10:59:45.573Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":588,"outputTokens":1211,"costUsd":0.0003659726}
{"ts":"2026-09-15T10:59:52.690Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":620,"outputTokens":444,"costUsd":0.0001661692}
{"ts":"2026-09-15T11:00:02.220Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":762,"outputTokens":621,"costUsd":0.00022409399999999999}
```

### t3-bci-r3 · 第 4 轮（HTTP 200，42.5s，新增 4 行）
```json
{"ts":"2026-09-15T11:00:08.310Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":369,"costUsd":0.0001554016}
{"ts":"2026-09-15T11:00:28.597Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":624,"outputTokens":1310,"costUsd":0.00039493639999999995}
{"ts":"2026-09-15T11:00:34.097Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":633,"outputTokens":208,"costUsd":0.0001049407}
{"ts":"2026-09-15T11:00:44.759Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":843,"outputTokens":735,"costUsd":0.00026057429999999996}
```

### t3-bci-r3 · 第 5 轮（HTTP 200，19.7s，新增 3 行）
```json
{"ts":"2026-09-15T11:00:51.847Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":548,"costUsd":0.0002026218}
{"ts":"2026-09-15T11:01:00.766Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":651,"outputTokens":417,"costUsd":0.00016149869999999999}
{"ts":"2026-09-15T11:01:04.457Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":715,"outputTokens":144,"costUsd":0.00009454370000000001}
```

### t4-pero-r3 · 第 1 轮（HTTP 200，50.4s，新增 4 行）
```json
{"ts":"2026-09-15T11:01:15.086Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":588,"costUsd":0.0002131738}
{"ts":"2026-09-15T11:01:36.204Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":623,"outputTokens":598,"costUsd":0.00020703169999999998}
{"ts":"2026-09-15T11:01:45.362Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":605,"outputTokens":331,"costUsd":0.00013517329999999998}
{"ts":"2026-09-15T11:01:54.883Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":791,"outputTokens":204,"costUsd":0.00011638330000000001}
```

### t4-pero-r3 · 第 2 轮（HTTP 200，45.3s，新增 3 行）
```json
{"ts":"2026-09-15T11:02:02.402Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":501,"costUsd":0.0001902232}
{"ts":"2026-09-15T11:02:10.756Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":611,"outputTokens":474,"costUsd":0.00017337129999999998}
{"ts":"2026-09-15T11:02:40.163Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":710,"outputTokens":2472,"costUsd":0.0007082745999999999}
```

### t4-pero-r3 · 第 3 轮（HTTP 200，40.8s，新增 3 行）
```json
{"ts":"2026-09-15T11:02:46.848Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":321,"costUsd":0.0001427392}
{"ts":"2026-09-15T11:02:56.684Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":614,"outputTokens":562,"costUsd":0.000196823}
{"ts":"2026-09-15T11:03:21.015Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":556,"outputTokens":1928,"costUsd":0.000552586}
```

### t4-pero-r3 · 第 4 轮（HTTP 200，26.1s，新增 3 行）
```json
{"ts":"2026-09-15T11:03:24.845Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":147,"costUsd":0.000096838}
{"ts":"2026-09-15T11:03:40.598Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":577,"outputTokens":1055,"costUsd":0.0003239497}
{"ts":"2026-09-15T11:03:47.167Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":516,"outputTokens":443,"costUsd":0.00015767899999999998}
```

### t4-pero-r3 · 第 5 轮（HTTP 200，25.5s，新增 3 行）
```json
{"ts":"2026-09-15T11:03:52.603Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":734,"outputTokens":294,"costUsd":0.00013561659999999998}
{"ts":"2026-09-15T11:04:04.434Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":617,"outputTokens":348,"costUsd":0.00014060709999999998}
{"ts":"2026-09-15T11:04:12.666Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":589,"outputTokens":524,"costUsd":0.0001848211}
```
