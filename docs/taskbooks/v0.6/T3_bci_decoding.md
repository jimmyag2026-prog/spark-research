# T3 · 脑机接口信号解码（中文）

> B2 轮次任务书 · 语言：中文 · 预算：$2（LLM 实花，`maxCostUsd` 强制）
> 覆盖面：**AMiner 中文主路径** · V8 中文召回基线测量 · 中英混合文献处理
> ⚠️ 排期约束：AMiner key 2026-10-07 到期，本课题轮次必须在此之前执行

## 研究问题（一句话）

侵入式与非侵入式脑机接口的神经信号解码方法（运动意图/语音解码）近三年进展与临床转化瓶颈是什么？

## 检索式

- AMiner 中文：`脑机接口 信号解码`、`运动意图解码 神经信号`、`脑机接口 语音解码`
- 对照组（英文源，用于中文召回对比）：`brain-computer interface neural decoding`
- 主源：`--sources aminer`；对照检索走默认 6 源

## 预列核心文献（召回率判据基准）

> ⚠️ 状态：**已冻结（2026-09-11）**——8 篇（中文 3 篇 AMiner + 英文 5 篇 OpenAlex），
> 覆盖侵入式/非侵入式脑机接口、运动/语音解码、神经信号处理的近期进展。

| # | 标题 | 年份 | 来源 | 入选理由 |
|---|---|---|---|---|
| 1 | Adaptive Temporal Alignment-Based Motion Intention Recognition for Robotic Arm Control | 2025 | 68fa8ac6163c01c850043178 | AMiner 中文；2025 最新；运动意图识别动态对齐方法 |
| 2 | Motor Intention Recognition of Upper Extremity Active Rehabilitation Training Based on Transfer Learning | 2023 | 6422c69d90e50fcafd329299 | AMiner 中文；上肢康复运动意图解码；迁移学习实践 |
| 3 | Research Progress on the Coding and Decoding of Scalp Electroencephalogram Signals | 2023 | 64626435d68f896efa560f8e | AMiner 中文；综述性；EEG 信号编解码基础进展总结 |
| 4 | A high-performance speech neuroprosthesis | 2023 | 10.1038/s41586-023-06377-x | Nature；576 引用；语音解码神经假肢实现；侵入式 BCI 临床应用里程碑 |
| 5 | A high-performance neuroprosthesis for speech decoding and avatar control | 2023 | 10.1038/s41586-023-06443-4 | Nature；525 引用；拓展语音解码至虚拟形象控制；多模态综合应用 |
| 6 | Semantic reconstruction of continuous language from non-invasive brain recording | 2023 | 10.1038/s41593-023-01304-9 | Nature Neuro.；394 引用；非侵入式 fMRI 语言语义重建；对比验证意义 |
| 7 | A Generalist Intracortical Motor Decoder | 2025 | 67a5d8d8ae8580e7ff6dfac6 | AMiner 英文；2025 最新；泛化型皮层电极运动解码器 |
| 8 | TRACE: Transformer for Regularized and Accurate Cortical ECoG Motor Decoding | 2026 | 6aa1e9d40a96f8c83ce84878 | AMiner 英文；2026 前沿；Transformer 架构在皮层脑电运动解码中应用 |

## 执行脚本

按 §4 九步协议。**附加观测**：步骤 1 分别记录 AMiner 中文检索与英文对照检索的
命中数与召回率（V8 基线数字）；`usage api` 单独记录 AMiner 的调用数与结果码（G-4 延续）。

## 成功判据

T1 的 5 条通用判据 + 第 6 条：V8 中文召回基线数字产出（哪怕很差——目的是拿到数字，
不是这一轮修好它）+ AMiner 调用台账完整（429/401 如实记录）。
