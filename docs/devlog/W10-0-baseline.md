# 文献流程基线 · 2026-09-15T17:10:12.877Z

server 无关（进程内）· 1 查询 · limit 6 · maxRead 3 · ok=true

| 阶段 | 耗时 |
|---|---:|
| search | 8.0s |
| download | 2.3s |
| read（3 卡）| 85.7s |
| review | 85.5s |
| **total** | **181.5s** |

PDF 0/3 · 失败/缺口 2
- 源 arxiv（「repetitive strain injury office workers prevention」）失败：Connector "arxiv" tool "search" failed: HTTP 429
- 源 biorxiv（「repetitive strain injury office workers prevention」）失败：timeout: biorxiv 在 8000ms 内未返回（已按 timeout 记，其它源照常返回）


## 并发安全实测（3 路 × 20 次，maxTokens 5）

| provider / 模型 | ok | 429 | 其它失败 | 单次 P50 / P90 | 总耗时 |
|---|---:|---:|---:|---|---:|
| deepseek-v4-flash | 20 | 0 | 0 | 766 / 1466 ms | 6.3s |
| openrouter · z-ai/glm-5.3-flash | 20 | 0 | 0 | 1963 / 2758 ms | 15.0s |

**决定**：S3 精读并行 `readConcurrency` 默认 **3**。

## arXiv 冷却后复测（距上次 429 约 2 小时，1 req/3s × 10，礼貌 UA）

```
000 429 000 429 000 000 429 429 000 429   → 200=0 · 429=5 · 连接失败=5
```

**决定**：本机 IP 仍在 arXiv 惩罚名单，恢复与否不由我们决定。α-5 的 DONE 由「≥8 次 200」改为「**不浪费一次请求**」：尊重 `Retry-After`（上限 60s）、冷却期内一次都不发、PDF 直链与检索共用一桶；能否拿到 200 另计。

## 基线解读

检索 8.0s（S4 已生效：arXiv 429 即时、biorxiv 8s 超时不再拖住整条查询）；**read + review = 171s，占 94%**——S9（quick 档一次调用）与 S3（并行 3）直接打这里。PDF 0/3 → S10。
