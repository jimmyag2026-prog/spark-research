# 文献流程基线 · 2026-09-15T18:03:11.523Z

server 无关（进程内）· 1 查询 · limit 6 · maxRead 3 · ok=true

| 阶段 | 耗时 |
|---|---:|
| search | 8.0s |
| download | 0.0s |
| read（0 卡）| 0.0s |
| review | 33.9s |
| **total** | **66.3s** |

PDF 0/0 · 失败/缺口 2
- 源 biorxiv（「repetitive strain injury office workers prevention」）失败：timeout: biorxiv 在 8000ms 内未返回（已按 timeout 记，其它源照常返回）
- 源 aminer（「repetitive strain injury office workers prevention」）失败：timeout: aminer 在 8000ms 内未返回（已按 timeout 记，其它源照常返回）

## deep 档复测 · 2026-09-16（scratchpad 脚本，参数同 --pipeline，仅 depth="deep"）

进程内 · r6-probe · 1 查询 · limit 6 · maxRead 3 · depth=deep · ok=true · LLM 调用 7

| 阶段 | 耗时 |
|---|---:|
| search | 8.0s |
| prescreen | 47.4s |
| download | 3.0s |
| read（2 卡）| 44.7s |
| review | 33.1s |
| **total** | **136.2s** |

预筛：6 篇 → 留 2 篇（阈值 2 分，上限 8）· PDF 0/2 · 失败/缺口 2（biorxiv / aminer 8s 超时）

注：LLM 调用 7 次 ≫ 顺利路径的 4 次，多出来的是「推理模型空输出 → 不带上限重试一次」
（见 W10-alpha.md 的现场事故段）。prescreen 的 47.4s 大半是这个来回。根治前这个 deep
数字不干净。

