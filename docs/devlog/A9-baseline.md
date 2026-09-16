# chat 基线（0.10.0-alpha.2）· 2026-09-16T02:00:34.544Z

server 0.10.0-alpha.2 · 消息「用三句话说明什么是蛋白质的二级结构。」· 每项目 5 轮 · 网络前提 中位 0.21s 最大 2.70s（达标）

| 项目 | 墙钟 P50 | 墙钟 P90 | 调用/轮 中位 | 调用/轮 最大 | 失败轮 | errorKind 分布 |
|---|---:|---:|---:|---:|---:|---|
| t1-protein-a9 | 6.1s | 11.3s | 1 | 1 | 0/5 | — |
| t2-sc-a9 | 4.2s | 9.8s | 1 | 1 | 0/5 | — |
| t3-bci-a9 | 4.4s | 20.8s | 1 | 1 | 0/5 | — |
| t4-pero-a9 | 4.5s | 12.0s | 1 | 1 | 0/5 | — |

## 原始 usage.jsonl 新增行（可复核）

### t1-protein-a9 · 第 1 轮（HTTP 200，9.2s，新增 1 行）
```json
{"ts":"2026-09-16T01:58:33.813Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1318,"outputTokens":88,"costUsd":0.0001274682}
```

### t1-protein-a9 · 第 2 轮（HTTP 200，6.1s，新增 1 行）
```json
{"ts":"2026-09-16T01:58:39.932Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1318,"outputTokens":120,"costUsd":0.00013590979999999998}
```

### t1-protein-a9 · 第 3 轮（HTTP 200，11.3s，新增 1 行）
```json
{"ts":"2026-09-16T01:58:51.272Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1318,"outputTokens":76,"costUsd":0.0001243026}
```

### t1-protein-a9 · 第 4 轮（HTTP 200，3.4s，新增 1 行）
```json
{"ts":"2026-09-16T01:58:54.692Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1317,"outputTokens":82,"costUsd":0.0001258063}
```

### t1-protein-a9 · 第 5 轮（HTTP 200，3.5s，新增 1 行）
```json
{"ts":"2026-09-16T01:58:58.229Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1318,"outputTokens":102,"costUsd":0.0001311614}
```

### t2-sc-a9 · 第 1 轮（HTTP 200，4.2s，新增 1 行）
```json
{"ts":"2026-09-16T01:59:02.402Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1317,"outputTokens":101,"costUsd":0.0001308185}
```

### t2-sc-a9 · 第 2 轮（HTTP 200，9.8s，新增 1 行）
```json
{"ts":"2026-09-16T01:59:12.205Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1316,"outputTokens":110,"costUsd":0.0001331136}
```

### t2-sc-a9 · 第 3 轮（HTTP 200，3.5s，新增 1 行）
```json
{"ts":"2026-09-16T01:59:15.716Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1317,"outputTokens":104,"costUsd":0.00013160990000000002}
```

### t2-sc-a9 · 第 4 轮（HTTP 200，2.7s，新增 1 行）
```json
{"ts":"2026-09-16T01:59:18.457Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1317,"outputTokens":73,"costUsd":0.00012343210000000001}
```

### t2-sc-a9 · 第 5 轮（HTTP 200，5.0s，新增 1 行）
```json
{"ts":"2026-09-16T01:59:23.494Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1317,"outputTokens":99,"costUsd":0.0001302909}
```

### t3-bci-a9 · 第 1 轮（HTTP 200，9.5s，新增 1 行）
```json
{"ts":"2026-09-16T01:59:33.012Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1318,"outputTokens":132,"costUsd":0.00013907539999999998}
```

### t3-bci-a9 · 第 2 轮（HTTP 200，4.4s，新增 1 行）
```json
{"ts":"2026-09-16T01:59:37.399Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1317,"outputTokens":99,"costUsd":0.0001302909}
```

### t3-bci-a9 · 第 3 轮（HTTP 200，20.8s，新增 1 行）
```json
{"ts":"2026-09-16T01:59:58.208Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1318,"outputTokens":93,"costUsd":0.00012878719999999999}
```

### t3-bci-a9 · 第 4 轮（HTTP 200，3.3s，新增 1 行）
```json
{"ts":"2026-09-16T02:00:01.473Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1318,"outputTokens":95,"costUsd":0.0001293148}
```

### t3-bci-a9 · 第 5 轮（HTTP 200，3.9s，新增 1 行）
```json
{"ts":"2026-09-16T02:00:05.387Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1316,"outputTokens":73,"costUsd":0.000123353}
```

### t4-pero-a9 · 第 1 轮（HTTP 200，4.5s，新增 1 行）
```json
{"ts":"2026-09-16T02:00:09.891Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1317,"outputTokens":92,"costUsd":0.0001284443}
```

### t4-pero-a9 · 第 2 轮（HTTP 200，12.0s，新增 1 行）
```json
{"ts":"2026-09-16T02:00:21.861Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1317,"outputTokens":163,"costUsd":0.0001471741}
```

### t4-pero-a9 · 第 3 轮（HTTP 200，4.7s，新增 1 行）
```json
{"ts":"2026-09-16T02:00:26.557Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1317,"outputTokens":113,"costUsd":0.0001339841}
```

### t4-pero-a9 · 第 4 轮（HTTP 200，4.1s，新增 1 行）
```json
{"ts":"2026-09-16T02:00:30.655Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1318,"outputTokens":107,"costUsd":0.0001324804}
```

### t4-pero-a9 · 第 5 轮（HTTP 200，3.9s，新增 1 行）
```json
{"ts":"2026-09-16T02:00:34.522Z","command":"chat","provider":"openrouter","model":"z-ai/glm-5.3-flash","ok":true,"inputTokens":1318,"outputTokens":103,"costUsd":0.0001314252}
```
