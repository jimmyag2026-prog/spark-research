# 使用日志

> **这份文档记什么**：真实使用 Spark Research 时撞到的问题、摩擦和疑问。
> 原始现场记录，不做分类、不做判断，**先记下来再说**。
>
> **和 `docs/BACKLOG.md` 的关系**：BACKLOG 是**已归口**的登记处，每条都有 V 号和明确去向。
> 本文是它的**上游**——使用中的发现先落这里，确认成立后再转入 BACKLOG 拿 V 号。
> 两边不重复登记：一条转走后，本文那条标「→ V1xx」并保留原始现场描述。
>
> **编号**：本文用 `U` 前缀（Usage），避免与 BACKLOG 的 V 号抢号。
> 截至 2026-09-14，全仓（含 `fix/v0.8.1-gate-h` 分支）已用到 **V141**，下一个可用 V 号是 **V142**。
>
> **怎么加一条**：照着下面的模板往「待处理」表格里加一行，再在下方补一节细节。
> 现场证据（时间戳、命令、日志片段、截图路径）比描述重要——**没有证据的条目会在复核时被打回**。

---

## 待处理

| 编号 | 日期 | 一句话 | 严重度 | 证据 | 去向 |
|---|---|---|---|---|---|
| U1 | 2026-09-14 | 首次 chat 调用失败，但没有留下任何可诊断的痕迹 | 中 | usage.jsonl + 空的 server.log | 待转 V |
| U2 | 2026-09-14 | 孤儿 server 存活两天无人发现，其工作树已被删除 | 中 | ps / lsof | 待转 V |
| U3 | 2026-09-14 | 打开网页工作台时，当前项目指针停在验收测试项目 | 中 | /api/projects/current | 待转 V |
| U4 | 2026-09-14 | 聊天等待期的进度文案只有一句、只发一次，长回复时像卡死 | 低 | session.ts:95 + usage.jsonl | 待转 V |
| U5 | 2026-09-14 | 单价表里模型键有两种形态，切模型时不知道该填哪种 | 待核实 | registry.ts | 待核实 |
| U6 | 2026-09-14 | 网页端没有设置入口：模型、检索源、connector 凭据全都改不了 | **高** | 78 条路由 0 条可写配置 | 待转 V |

## 已转入 BACKLOG

（空）

## 已确认不是问题

（空）

---

## U1 · 首次 chat 调用失败，没有留下可诊断痕迹

**现场**：2026-09-14 在 `spark` 项目用网页端聊天，第一条消息失败。

**证据**：`~/.spark-research/projects/spark/usage.jsonl` 第一行

```json
{
  "ts": "2026-09-14T08:21:34.014Z",
  "command": "chat",
  "provider": "openrouter",
  "model": "z-ai/glm-5.3-flash",
  "ok": false,
  "inputTokens": 0,
  "outputTokens": 0,
  "costUsd": null
}
```

同一时刻 `logs/server.log` 里**没有任何输出**——整个文件只有四行启动日志。

**问题**：台账记了「失败了」，但没记**失败在哪一类**。`LlmErrorKind` 这个类型本身是存在的
（`auth` / `rate_limit` / `timeout` / `parse` / `upstream` / `unsupported` / `budget`，见
`backend/src/llm/types.ts`），失败时却没有落进 usage 记录。

结果是：事后完全无法判断这次失败该怪谁——是 key 的问题、上游限流、超时，还是解析失败。
紧接着的第二次调用成功了，所以也没法复现。

**期望**：usage 记录在 `ok: false` 时带上 `errorKind`，最好再带一句 `errorMessage` 摘要。
这条链路是产品卖点，失败却是黑箱。

**关联**：v0.5 登记过「LLM 失败无内容可用」（AD-13）。这条是它的观测面版本——
不是「失败后没内容」，是「失败后没证据」。

---

## U2 · 孤儿 server 存活两天，工作树已删除仍在监听

**现场**：4321 端口上有一个 `v0.8.0-alpha.3` 的 server 在监听，从 2026-09-12 11:46 一直活到
09-14，两天没人发现。它是 A7 验收时起的，验收结束后没人关。

**证据**：

```
$ lsof -nP -iTCP:4321 -sTCP:LISTEN
spark-res 79165 jimmyclaw ... TCP 127.0.0.1:4321 (LISTEN)

$ ps -o args=,ppid=,lstart= -p 79165
./dist/spark-research server 4321    1    Sat Sep 12 11:46:45 2026

$ lsof -a -p 79165 -d cwd
n/Users/jimmyclaw/Desktop/AI4S/spark-research-a7      ← 这个目录已经不存在了
```

父进程是 launchd（1），说明起它的终端早就关了，进程被系统收养。
它的二进制所在工作树 `spark-research-a7` 已经被删除，进程靠已打开的 inode 继续跑。

**三个后果**：

1. **版本困惑**。浏览器打开 4321 看到的是 alpha.3 的工作台，但 `package.json`、
   CLI、文档全都是 0.8.0。界面上没有任何地方提示「你连的是个旧构建」。
2. **数据目录是共用的**。这个旧 server 和新 CLI 指向同一个 `~/.spark-research`，
   两边都能写。旧构建有没有已修复的写入 bug，无从保证。
3. **没有任何机制会告诉你**。`doctor` 不查端口，`capabilities` 不查运行中的实例。

**期望**：至少两件之一。`doctor` 增加一项「本机是否已有 spark-research server 在监听，
版本是多少，和当前 checkout 是否一致」；或者 server 启动时把 pid 和版本写进
`~/.spark-research/server.pid`，让后续命令能发现它。

---

## U3 · 网页工作台打开时，指针停在验收测试项目

**现场**：新起 server 后用浏览器打开工作台，顶栏显示的项目是 `r5-t2`，
里面有 32 条 record、10 篇文献、2 条思路。那是 R5 验收批量跑出来的测试项目。

**证据**：

```
$ curl -s http://127.0.0.1:4321/api/projects/current
{"project":{"slug":"r5-t2","name":"r5-t2", ...
 "counts":{"records":32,"papers":10,"ideas":2,"dryExperiments":2,"wetExperiments":0}...
```

`project list` 里 30 个项目中有 20 多个是 `r4-*` / `r5-*` / `a5-*` / `*-copy` 这类
验收产物，真实课题混在里面很难挑。

**问题**：当前项目指针是全局可变状态，上一次会话留在哪就是哪。
一个刚打开网页端的人，第一次检索和精读会**默认写进测试项目**，而界面上没有任何
「这是个测试项目」的标记。等发现时证据图已经脏了。

**期望**：两个方向，任选。项目列表支持归档或打标（验收产物折叠起来）；
或者工作台在指针指向一个「长期没动过的项目」时给一条轻提示。

**注意**：不建议改成「每次打开都不选项目」——那会破坏 CLI 侧已有的指针语义。

---

## U4 · 聊天等待期没有阶段提示，长回复时像卡死

**现场**：网页端聊天，发出消息后要等相当久才见到完整回复。

**证据**：`spark` 项目 2026-09-14 当天六次调用的输出长度

| 时刻 UTC | 输入 token | 输出 token | 结果 |
|---|---:|---:|---|
| 08:21:34 | 0 | 0 | 失败（见 U1） |
| 08:22:06 | 537 | 1464 | 成功 |
| 08:22:19 | 383 | 978 | 成功 |
| 08:23:04 | 705 | 568 | 成功 |
| 08:23:29 | 594 | 1780 | 成功 |
| 08:23:47 | 499 | 549 | 成功 |

**问题**：一条消息走的是 plan → execute → review 三段管线，输出经常上千 token。
链路本身是通的：后端在开跑前发一个 `progress` 事件，前端在还没收到任何增量时
拿它当占位文案（`center.tsx` 的 `onProgress`，逻辑正确，不会覆盖正在流入的正文）。

真正的问题是**那条 progress 只有一句固定文案、只发一次**：

```ts
// backend/src/server/routes/session.ts:95
sender.send("progress", { message: mode === "coexplore" ? "共探中" : "规划与执行中" });
```

于是不管 plan 跑了三秒还是三十秒，界面上永远是「规划与执行中」五个字，不动。
既不区分现在是 plan、execute 还是 review，也没有任何推进感。
回复越好、等待越长，而等待期内信息量恒定为零。

这不是性能问题，是预期管理问题。

**期望**：让 orchestrator 在跨阶段时各发一次 progress（「规划中」→「执行中」→「复核中」），
文案跟着阶段走。传输层和消费端都是现成的，只差生产端多发几次。

**已核实**：`onProgress` 两端都有实现，**不是**「建好了但没有生产调用方」那个形态。
最初的怀疑方向是错的，这里如实留痕。

---

## U5 · 单价表里模型键有两种形态（待核实）

**现场**：想换个更快的模型，查 `backend/src/llm/providers/registry.ts` 的单价表，
发现键名有两种写法：

```
gpt-4o            deepseek-v4-flash    kimi-k3         qwen-max      ← 裸模型名
moonshotai/kimi-k2.6                   z-ai/glm-5.3-flash            ← 带 provider 前缀
claude-opus-5     claude-sonnet-5      claude-haiku-4-5-20251001     ← 裸模型名
```

当前 `config.json` 里的 `defaultModel` 是 `z-ai/glm-5.3-flash`（带前缀那种）。

**待核实的问题**：`config set defaultModel` 时该填哪种形态？裸名和带前缀名分别怎么
推断 provider？填错了会明确报错，还是静默落到某个默认 provider？

**为什么标「待核实」**：这可能是正常设计——带前缀的是 OpenRouter 上的模型（provider
路由需要前缀），裸名是直连各家 API 的。如果是这样，那只是文档没讲清楚，不是缺陷。
**核实之前不要当 bug 登记。**

**怎么核实**：读 `LLMRouter` 的 provider 推断逻辑，再拿一个错误形态实际试一次，
看它是拒绝还是静默降级。

---

## U6 · 网页端没有设置入口，什么配置都改不了

**现场**：在网页工作台想换个更快的模型、想调整默认检索源、想给
Semantic Scholar 配个 key，**找遍四栏没有任何设置按钮**。
最后只能回终端敲 `spark-research config set` 和 `spark-research auth`。

**证据一 · 78 条 HTTP 路由里，没有一条能写配置**

```
$ spark-research contract --json | <按前缀统计>
HTTP 路由总数: 78
  /api/artifacts 4 · /api/capabilities 1 · /api/chat 1 · /api/chem 1
  /api/compute 8 · /api/conclusions 4 · /api/connectors 1 · /api/experiments 7
  /api/health 1 · /api/ideas 4 · /api/lab 11 · /api/lineage 1 · /api/lit 11
  /api/projects 6 · /api/proteins 1 · /api/records 5 · /api/report 1
  /api/session 4 · /api/tasks 3 · /api/usage 2
```

涉及配置、凭据、数据源的只有三条，**全是 GET**：

```
GET  /api/capabilities
GET  /api/connectors
GET  /api/lit/sources
```

`backend/src/server/routes/` 下 13 个路由模块，没有 `config.ts`、没有 `auth.ts`、
没有 `credentials.ts`。

**证据二 · 前端知道凭据状态，只是没法写**

```ts
// frontend/workspace/src/lib/api.ts:207
apiKeyRequired: boolean;
credentialConfigured: boolean | null;
```

这是最刺眼的地方：界面**能告诉你**某个源需要 key、以及配没配，
**却不给你任何地方把 key 填进去**。诊断做完了，动作缺失。

全前端搜「设置 / setting / config / 凭据」只命中上面这两行类型声明，没有任何 UI。

**证据三 · 配置项一共 32 个，网页端一个也够不着**

`spark-research config list` 列出 32 个键，包括 `defaultModel`、`contactEmail`、
`httpTimeoutMs`、`llmTimeoutMs`、`wetBackend`、`simulationPlatform`、
`computeTarget`、`embeddingModel`、五个 `subAgentModel_*` 等等。

**这条要拆成两半看，不要一起处置**

| | 内容 | 判断 |
|---|---|---|
| **A 非密配置** | `defaultModel`、检索源、各类超时、`contactEmail`、`computeTarget`… | **没有理由不能在网页端改。**这些不是秘密，写进 `config.json` 而已。缺的就是一个设置面板加一组 PUT 路由。 |
| **B 凭据** | 各家 LLM API key、connector 的 key | **需要先做设计裁定，别默认照做。**AD-2 定的是「凭据只在 daemon 进程」，`auth` 命令 V115 起连回显都掐了。让 key 经 HTTP body 进来，和这条架构决策正面冲突。 |

B 这半边如果要做，至少得回答：key 走 HTTP 进来时怎么不落日志、不落 raw、
不进 usage？server 现在绑 127.0.0.1，但 `originAllowlist` 是可配的，
放开之后这条路径就暴露了。

**期望**

先做 A：一个「设置」面板 + 一组配置写路由，把 32 个键里非密的那些暴露出来。
光是能在网页端换模型，就解决了现在「用着用着得开终端」的断裂感。

B 单独立项讨论。**在裁定之前，网页端应该明确告诉用户「凭据请在终端用
`spark-research auth` 配置」，而不是像现在这样只显示一个「未配置」然后不说下一步。**
——后者违反了这个项目自己的约定：失败消息都要带可执行的下一步。

**关联**：v0.6 的 agent 指南里写过「审批类动作不暴露为 MCP 工具，这是设计不是缺陷」，
并且明确了正确做法是把待办呈现给人类。凭据这件事应该照同一个模式处理：
不提供写入口可以，但要把「去哪做」说清楚。

---

## 模板

往上面加新条目时照抄这一段：

```markdown
## U<n> · <一句话标题>

**现场**：什么时候、在哪个界面/命令、做什么的时候撞到的。

**证据**：

<命令输出 / 日志片段 / 文件内容，原样粘贴，不要转述>

**问题**：这件事为什么不对。

**期望**：你希望它怎么样。没想好就写「没想好」，比编一个方案强。

**待核实**（可选）：如果你不确定这是不是缺陷，写清楚要核实什么、怎么核实。
```
