# T5 · 配置与运维（零上下文验收课题，与 T1–T4 并列）

> v0.9 新增的第五份验收任务书 · 语言：中文 · 预算：**$0.50**（LLM 实花，`--budget-usd` 强制；本课题的 LLM 调用只为验证配置生效，不做研究）
> 覆盖面：**普通用户真会做的运维动作**——换模型、改检索源、配凭据、重启服务、核对台账。
> 为什么有这一份：v0.6–v0.8 六轮验收全是研究课题，从没走过配置路径；`docs/USAGE_LOG.md` 十条里 **U1 U2 U3 U5 U9 U10 六条**只有在做这些动作时才会暴露（P1）。
> 状态：**冻结（2026-09-15，v0.9.0-alpha.2 收口后）**。冻结后只许改错别字，不许改步骤与判据（改了等于验收对象变了，V58）。执行者**不得**是 W9-1 任一 lane 的开发者。

## 前置：网络前提（不达标不跑，如实记录）

```bash
for i in 1 2 3 4 5; do curl -s -o /dev/null -m 20 -w "%{time_connect}\n" https://openrouter.ai; done
```

五次 `time_connect` **中位数 < 1s 且最大 < 3s** 才算达标。不达标：记录五个数字，本课题标「网络不达标，未执行」，**不要在坏网络上出结论**——上一次在 15 秒建连的网络上量出的「换模型快 2.7 倍」是假的（USAGE_LOG U10）。

## 操作清单（按序执行，每步记录：命令 / 输出原文 / 耗时 / 你的判断）

| # | 动作 | 期望 | 对应 |
|---|---|---|---|
| 1 | `spark-research doctor` | 「运行实例」一档存在；若有旧 server 在跑，报版本与是否孤儿 | U2 |
| 2 | 起 server，浏览器打开工作台 | 顶栏有 server 版本徽标；当前项目**不是**验收产物（若是，记下来——说明归档折叠没生效） | U3 · γ-4 |
| 3 | 左栏「设置」（或数字键 `6`） | 能看到全部非密配置项，说明文字与 `spark-research config list` 逐字一致；general 面板里凭据类项**无输入框**（值不在这条路上）；凭据在单独的「凭据」面板（第 18 步） | U6·A |
| 4 | 设置里把 `defaultModel` 改成**另一个已登记模型**（从设置页的候选里挑；记下改前改后） | 保存成功，刷新仍是新值 | γ-1/γ-3 |
| 5 | 新建项目 `t5-<日期>`，发一条 chat：「用一句话说明什么是酶。」 | 有回复；界面在等待期显示**带计数的分段进度**（如 execute 1/2），不是一句不动的文案 | α-3 · U4 |
| 6 | `spark-research usage --project t5-<日期> --json` | `model` 字段 == 第 4 步改后的模型；`provider` 与之匹配；**不是**改前的默认值 | **U10 · β-1** |
| 7 | 设置里把 `defaultModel` 改成一个**乱写的名字**（如 `foo-9000`） | 拒绝写入，错误消息列出已登记模型并给下一步；config.json 未改 | U5 · β-3 |
| 8 | 终端 `spark-research chat --help` | **立即**打印用法，退出码 0；`usage` 台账**不增加**任何记录 | **U9 · β-2** |
| 9 | 终端 `spark-research chat --model <另一模型> --budget-usd 0.05 --project t5-<日期> 说一句话` | 有回复；台账新记录的 `model` == 指定值 | U9 |
| 10 | **人为断网**（关 Wi-Fi），网页端发一条 chat | 界面在合理时间内（< 30s）报错，不是转圈两分钟；`usage --json` 里这条 `ok:false` 带 `errorKind`（期望 `upstream` 或 `timeout`）与脱敏后的摘要 | **U1 · α-1/α-4** |
| 11 | 恢复网络，再发一条 | 成功；观察是否有自动重试痕迹（server 日志） | V137 |
| 12 | 设置里把 `llmTimeoutMs` 改成 `500` | 拒绝（< 1000）；改成 `abc` 拒绝；改成 `30000` 成功 | γ-3 |
| 13 | 终端 `spark-research config set OPENROUTER_API_KEY xxx` 与 HTTP `PUT /api/settings/general/OPENROUTER_API_KEY` | CLI 走 `auth` 流程（不回显）；HTTP **403** 且消息指向终端 | AD-2 · U6·B 指引 |
| 14 | 用旧二进制（若有）或另一端口再起一个 server，然后 `doctor` | 报两个实例、版本是否一致 | U2 |
| 15 | 关掉所有 server，`doctor` | 报「无运行实例」 | U2 |
| 16 | `spark-research project archive t5-<日期>`，刷新工作台 | 下拉框默认不见它，「显示已归档」能切出来 | U3 |
| 17 | `bun run test:integration`（在源码 checkout 里） | **要么真跑要么显式报「本轮未验证」**；不得出现静默 `0 pass / N skip / 0 fail` | U7 · δ-1 |
| 18 | 设置 ▸ 凭据：给 `semanticscholar` 填一个**假 key**（如 `T5-FAKE-KEY-<日期>`）保存 | 该行显示「已设字段：api_key」；**值不再出现在页面任何位置**；`spark-research lit sources` 显示已配置；`ls -l ~/.spark-research/credentials.json` 权限 `-rw-------` | **乙 · AD-18 · γ/ε** |
| 19 | 第 18 步之后：`grep -r "T5-FAKE-KEY" ~/.spark-research/ <server 日志> ` 并在浏览器 DevTools 里搜所有 XHR 响应体 | **只在 `credentials.json` 里命中一处**；日志、raw、record、usage、任何 HTTP 响应体里零命中 | AD-18 write-only |
| 20 | 用另一台机器或 `curl --interface <非 loopback 地址>` 对 `PUT /api/settings/credentials/semanticscholar` 发同样请求；再把该来源加进 `originAllowlist` 重发 | 两次都 **403**，消息指向终端 | AD-18 loopback 硬限 |
| 21 | 设置 ▸ 凭据：删除第 18 步的 key | 有确认文案「只删本机保存的值」；删后 `lit sources` 显示未配置；文件里该值消失 | γ |
| 22 | 依次打开设置里的每个面板，对照 `spark-research capabilities --json` / `config list` / `compute targets` / `ext list` | 每个面板的每一行都能在对应命令输出里找到同一个值；**没有** `sandbox` 面板；compute 面板**没有**派发/审批按钮 | ε 面板清单 · AD-12 |

## 成功判据

1. 第 6、8、10 三步**必须全过**——它们分别是 U10、U9、U1 的直接复现，任一不过即 P0。
   第 **18、19、20** 三步同样 P0——它们是「乙」（凭据经 HTTP 写入，AD-18）的三条牙齿：能写、永不泄露、非 loopback 必拒。**第 19 步若在任何地方多命中一处，整个凭据面板视为不可发布。**
2. 其余每步：过 / 不过 / 不适用，三选一，**不适用要写原因**。
3. 全程 LLM 实花 ≤ $0.50（第 5、9、10、11 四步会花钱）。

## 记录要求

- 每步的命令与输出**原文粘贴**，不转述；截图放 `spark-research-v0.9-plan/R6/T5/`（若目录不存在则建）。
- 发现的新问题按 `docs/USAGE_LOG.md` 模板写 U 条目（从 **U11** 起），证据先于判断；不确定的标「待核实」。
- **不要修任何东西**。你是验收者。
- 最后一段：「如果我是第一次用这个工具的人，卡住我的第一件事是什么」——一句话。

## 收尾（δ-1 / V157，v0.10 补）

- **跑完把本次验收产出的项目全部归档**，一条命令：
  `spark-research project archive --pattern "<本次的 slug 前缀>-*"`（先 `--dry-run` 看命中谁）。
  归档是可逆的（`project unarchive <slug>`），**不删任何数据**；不归档的后果是下一个人打开
  工作台，默认停在你的探针项目上（R6 U14 的现场：默认打开 `speed-probe`）。
- 当前项目指针正好落在被归档的项目上时，CLI 会自动把它切到**最近活动的未归档项目**并把这件事
  打印出来——看到那句话就核一眼切过去的是不是你想要的那个。
