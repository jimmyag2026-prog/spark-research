# lane δ · 运维与卫生

| 项 | 做什么 | DONE / 门禁 |
|---|---|---|
| δ-1 V157 验收产物归档 | `spark-research project archive --pattern "<glob>"` 批量；当前指针落在已归档项目时自动跳到最近活动的未归档项目；`docs/taskbooks/v0.9/*` 与 v0.10 任务书加「跑完归档」一步 | 单测；本机实测把 `t*-r*`、`r6-*`、`a8-*`、`speed-probe`、`r4-*`、`binary-probe`、`v27probe` 归档后工作台默认打开的不是验收项目 |
| δ-2 V160 + V162 doctor | 探 4321 + 配置的 `serverPort` + `--port` 列表；「前端未构建」改问实例的 `/api/health`（加 `frontendBuilt` 字段，`server/app.ts` 是收口专属→收口 diff） | `doctor` 起两个实例都报出 |
| δ-3 V163 / V169 / V170 | `config list` 长值加 `…`；`data import` 文案改「目标项目须不存在」；T5 任务书第 13 步端点改 `/api/settings/general/*` | 三条各一测 |
| δ-4 V156 ①② | 同步 `/api/session/chat` 超过 `chatSyncMaxMs`（默认 200s）时改回 202 + `taskId`（复用任务路由）；`readme_for_human.md` 与 SDK 示例改推 `/stream` | 单测（假 LLM 延时 > 阈值 → 202）；`routes/session.ts` 收口专属 → 收口 diff |
| δ-5 V167 核实 | pty 包装下 `lab approve` 全流程实测（`script -q /dev/null …`），把结果写进 `docs/devlog/W10-delta.md` 并改 `lab` 文档措辞（TTY 检测不是安全边界，那句 `yes` + token 才是） | 有实测输出原文 |
