# Spark Research · 人类用户指南（v0.6）

> 开源科研工作台：文献 → 思路 → 实验 → 记录 → 创新性核验 → 结论评审 → 报告。
> 本文写给**动手用它做研究的人**。给 AI agent 的对应文档见 `readme_for_agent.md`；
> 完整命令参考见 `llms.txt`；本文所有能力声明都经过 v0.6 的三轮真实课题实测。

## 1. 三种安装方式

| 方式 | 命令 | 前置 | 适合 |
|---|---|---|---|
| **单二进制**（推荐） | 从 GitHub Release 下载对应平台的可执行文件 | 无 | 只想用，不想装环境 |
| 源码 | `git clone` → `bun install` → `bun backend/src/index.ts` | [Bun](https://bun.sh) ≥1.2 | 要改代码/装科学依赖 |
| npm | `npx spark-research`（**尚未发布到 npm**，字段已备齐） | Bun | 等维护者发布后可用 |

装完先体检：

```bash
spark-research doctor        # 缺什么、怎么补，输出里直接给命令
```

## 2. 两把钥匙（按需配置）

- **LLM key（必须，精读/综述/思路要用）**：`spark-research auth`，推荐 OpenRouter。
  v0.6 默认模型是 `z-ai/glm-5.3-flash`（便宜且实测判定质量好——一个完整课题
  约 $0.03–0.07）。换模型：`spark-research config set defaultModel <模型名>`。
- **AMiner key（可选，中文文献检索要用）**：`spark-research lit sources` 查看配置方法。

密钥只落本机 `~/.spark-research/`（0600 权限），永不出现在任何输出里。

## 3. 十分钟上手：一个完整课题

```bash
spark-research project new my-topic --desc "研究背景一句话"
spark-research lit search "your query" --add --project my-topic     # 检索并入库
spark-research lit pdf --all --project my-topic                     # 拉开放获取 PDF
spark-research lit read --all --project my-topic --budget-usd 2     # 精读（有 PDF 的读全文）
spark-research lit review --project my-topic --budget-usd 2         # 综述 + 引用逐条核验
spark-research idea new -m "我的想法" --project my-topic --budget-usd 2
spark-research idea check <卡片id> --project my-topic --budget-usd 2 # 创新性核验
spark-research report export --project my-topic                     # 导出报告
spark-research usage --project my-topic                             # 这个课题花了多少钱
```

**Web 工作台**：`spark-research server` 然后开 http://127.0.0.1:4321 ——
项目、会话、证据图、长任务进度、算力状态、用量归因都在里面（v0.6 新增四个面板）。

## 4. v0.6 你最该知道的五件事

1. **精读是真读全文**。有 PDF 的论文会抽全文喂给模型（每张卡标注「基于全文/仅摘要」，
   综述因此写得出具体数字与方法对比）。需要 `.venv` 里装 pypdf；没装会优雅降级回摘要。
2. **花钱有闸有账**。`--budget-usd N` 让项目累计花费到 $N 即停（已完成的产出保留）；
   `usage` 命令按命令/模型归因，成本算不清的调用会明说「总数报不出」，绝不装免费。
3. **多开终端要带 `--project`**。当前项目指针是全局的，并发会话会互相切换；
   带上 `--project <slug>` 就完全隔离（v0.6 全部命令已支持，三轮并发实测零污染）。
4. **中文检索可用但有讲究**：概念之间**用空格分隔**（如「钙钛矿 稳定性」）。
   查不到时系统会自动拆词检索并在结果里标注；连写的复合词（如「运动意图解码」）
   目前仍查不到——这是已知限制。
5. **长任务断了能接**。`lit read --all` 这类长活有任务句柄，断开后
   `lit tasks --project <slug>` 查进度；重跑默认跳过已完成的部分，不重复花钱。

## 5. 诚实的限制清单（v0.6 实测边界）

- **检索排序偏弱**：高被引但偏题的论文会压过领域奠基性论文（英文基准召回
  约 3/8–5/8）。重要文献建议用 DOI 直接 `lit add` 补齐——按 id 添加是精确的。
- **综述只写库内文献**：引用核验保证零伪造（三轮 200+ 条引用 0 例硬错误），
  但**不保证覆盖全面**——库里没有的它不会写。综述规模目前实测到 34 篇/1.2 万字。
- **中文全文获取率低**（开放 PDF 少），中文综述深度以摘要级为主。
- **远端算力（Modal）只有契约没有真实链路**；湿实验只到模拟器 + 人工审批，不接真设备。
- bioRxiv 的「search」不是真检索（官方无检索端点，是最近 N 篇+打分模拟，查不到≠不存在）。
- 项目 `--desc` 的文字会渗入 LLM 输出的措辞（修复中，介意就写得中性些）。

## 6. 花费参考（v0.6 三轮实测）

一个课题（10–34 篇文献全流程）：**$0.03–0.07**。$2 预算闸从未被真实课题触发过，
它防的是失控循环，不是正常使用。

## 7. 出问题了

- 任何报错都会给「下一步」建议——照着做通常就好了
- `spark-research doctor --json` 是给人和脚本都能读的完整体检
- 已知问题与去向：`docs/BACKLOG.md`（每条都有登记与处置状态）
