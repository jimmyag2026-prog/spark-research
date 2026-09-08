# Devlog P0 · 设计定稿（2026-09-09）

## 做了什么

- 产出 [DESIGN.md](../DESIGN.md)：v0.2 产品设计（定位、五大功能域、系统架构、7 条架构决策、风险、发布判据）
- 产出 [DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md)：P1-P8 阶段计划，每阶段带范围/验证/退出标准

## 设计输入（三个来源）

1. **OpenScience 源码级分析**（本地 clone + 2026-09-07 的框架对比报告、文献检索机制逆向）：吸收单 agent + 任务型子代理、双层 prompt、connector 契约、技能本地优先、provenance；不吸收技能铺量与 Modal 绑定
2. **AMiner 集成调研**（2026-09-07 实测）：OpenScience 沙箱三层隔离挡自定义凭据的教训 → 转化为 AD-2 凭据分层原生设计
3. **v0.1 现有资产**：daemon/permits、stateful kernel、artifact+lineage、reviewer veto、11 connectors、lab compiler+safety gate、84 测试 —— 全部作为地基复用

## 关键决策记录

- AD-1 Project-centric（差异化核心，区别于两个参照系的 session-centric）
- AD-2 凭据只在 daemon 进程
- AD-3 Record 与 Artifact 同图不同表
- AD-4 Simulation adapter 独立于 connector（生命周期契约不同）
- AD-5 技能少而深（10 个首批，每个带 e2e）
- AD-6 湿实验强制人工 approve gate
- AD-7 前端 vanilla 保持到 P7，API 先行

## 与用户需求的映射核对

| 用户需求 | 设计落点 |
|---------|---------|
| 研究背景调研/相关文献检索 | 域 A1 + P2 |
| 文献下载与个人科研项目数据库 | 域 A2（Project Library）+ P2 |
| 文献综述 | 域 A3 + P3 |
| 研究思路 co-explore 与调研反馈 | 域 A4 + P4 |
| 干湿实验 connector 到仿真平台 | 域 B1（SimulationPlatform 接口）+ P5 |
| 干湿实验闭环 | 域 B3 + P5/P6 |
| 全流程数据记录（思路/实验/思考） | 域 C（Research Record 7 类型）+ P1 起贯穿 |
| 创新性验证和梳理 | 域 D + P4 |
| 结论分析与 review | 域 E + P3/P8 |

## 遗留待商议

- CNKI/万方 API 渠道（无公开 API，暂保占位，AMiner 作为中文文献主路径）
- P5 第二个 simulation adapter 选型（GROMACS vs 纯 Python 参考实现），到 P5 时按本机环境定
- 物理湿实验设备（真实 Opentrons）排 v0.3+
