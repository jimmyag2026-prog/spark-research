# 使用日志

> **这份文档记什么**：真实使用 Spark Research 时撞到的问题、摩擦和疑问。
> 原始现场记录 + 修改方向，**只记录不动手**——改与不改、先改哪条，由人决定。
>
> **和 `docs/BACKLOG.md` 的关系**：BACKLOG 是**已归口**的登记处，每条都有 V 号和明确去向。
> 本文是它的**上游**——使用中的发现先落这里，确认成立后再转入 BACKLOG 拿 V 号。
> 两边不重复登记：一条转走后，本文那条标「→ V1xx」并保留原始现场描述。
>
> **编号**：产品问题用 `U` 前缀（Usage），方法问题用 `P` 前缀（Process，见文末「方法缺陷」一节），
> 都避免与 BACKLOG 的 V 号抢号。
> 截至 2026-09-14，全仓（含 `fix/v0.8.1-gate-h` 分支）已用到 **V141**，下一个可用 V 号是 **V142**。
>
> **证据规矩**：现场证据（时间戳、命令输出、源码行号）比描述重要。
> **没有证据的条目会在复核时被打回**；不确定的标「待核实」，核实完再改写，
> 并把最初错误的猜测留在条目里——本文已经有两处这样的留痕（U4、U5）。
>
> 最后更新：2026-09-16（v0.9.1 本地使用窗口：新增 U44 U45 U46；U38 U39 U40 U44 U45 U46 已修并带门禁，U41 U42 U43 → V171–V173，残余 → V174 V175 V176）；2026-09-14

---

## 总表

| 编号 | 一句话 | 严重度 | 类型 | 状态 |
|---|---|---|---|---|
| [U1](#u1) | 首次 chat 调用失败，台账不记错误类型，日志无输出 → 失败即黑箱 | 中 | 可观测性 | ✅ alpha.2（α-4 台账 `errorKind` + 失败日志） |
| [U2](#u2) | alpha.3 孤儿 server 存活两天，工作树已删除，`doctor` 查不到 | 中 | 运维 | ✅ alpha.2（δ-2 `doctor` 探端口；ε 顶栏版本徽标） |
| [U3](#u3) | 网页端打开时指针停在验收测试项目，易误写进测试数据 | 中 | 体验 | ◐ alpha.2 前端半边（ε：归档项目折叠）；后端默认指针待 W9-2 |
| [U4](#u4) | 聊天进度文案只有一句、只发一次，长回复时界面无推进感 | 低 | 体验 | ✅ alpha.2（α-3 各阶段 `progress` 事件） |
| [U5](#u5) | 模型路由有无条件静默兜底 `return "kimi"`，两份模型清单不同步 | **高** | 正确性 | ✅ alpha.2（β-3 单价表即模型清单，`assertKnownModel` 三处共用；收口 V154 删隐式兜底） |
| [U6](#u6) | 网页端没有设置入口，32 个配置项一个也够不着 | **高** | 功能缺失 | ✅ alpha.2（γ 设置面 API + ε 前端 12 面板，AD-18） |
| [U7](#u7) | 集成套件默认整体跳过，「8 skip」读起来像通过 | 中 | 测试门禁 | ✅ alpha.2（δ-1 集成套件默认真跑，skip>0 即红） |
| [U8](#u8) | server 启动日志打两遍，两处手写副本 | 低 | 整洁 | ✅ alpha.2（δ-4） |
| [U9](#u9) | CLI `chat` 没有任何参数：无预算闸、无 `--model`、`--help` 会被当消息发出去 | **高** | 正确性 | ✅ alpha.2（β-2 `chat --model/--budget-usd/--project/--help`） |
| [U10](#u10) | `model` 覆盖声明了但从不读取，换模型静默无效、记账记成默认模型 | **高** | 正确性 | ✅ alpha.2（β-1 + 收口：`sessionModel` 进 `llmFor`；V145） |
| [U11](#u11) | `/api/session/chat` 不读 `?project=`，会话按「当前项目」指针入账 → 脚本 20 轮全记进 speed-probe | 中 | 契约一致性 | ✅ alpha.3（`/api/session/chat|stream` 认 `?project=`/body.project，不存在 404） |
| [U12](#u12) | 预算闸拒绝返回 HTTP 200 + `review.approved: true`，台账无痕；且拒绝前仍耗时 49.8s | **高** | 正确性 | ✅ alpha.3（`failure:{kind,message}` 结构化字段 + review 不 approved + 闸拒落台账 errorKind:budget + plan 被拒即止不跑默认计划；预算语义文案改 CLI 半边，前端 → V166） |
| [U13](#u13) | 单轮 chat 超过 255s 时 server `idleTimeout` 掐断连接，编排在后台继续、结果无人接收 | **高** | 正确性 | → V156（设计裁定：202+任务句柄 / 推到 stream / 断连即取消） |
| [U14](devlog/R6.md#u14) | 验收/探针项目从没归档，工作台默认打开的就是一次性产物（正文在 R6.md） | 中 | 数据卫生 | → V157 |
| [U15](devlog/R6.md#u15) | 启动时 config.json 灌进 `process.env`，运行中 server 永远用旧值、`source` 误标 env（T5 第 6 步 P0，U10 同构） | **高** | 正确性 | ✅ alpha.3（桥接键按文件实时读，落盘即刷新 env） |
| [U16](devlog/R6.md#u16) | `doctor`「前端未构建」判的是 cwd 不是运行实例 | 低 | 运维 | → V162 |
| [U17](devlog/R6.md#u17) | `config list` 截断长值不加省略号 | 低 | 体验 | → V163 |
| [U18](devlog/R6.md#u18) | chat 执行段无计数进度，约 15s 空白 | 中 | 体验 | → V158 |
| [U19](devlog/R6.md#u19) | 设置项被 422 拒时界面不显示错误 | 中 | 体验 | → V159 |
| [U20](devlog/R6.md#u20) | `--budget-usd` 帮助说「本次会话」，实为「本项目累计」 | 中 | 文档 | ◐ alpha.3 CLI 文案已改；前端 BudgetInput → V166 |
| [U21](devlog/R6.md#u21) | chat 全失败/被闸拒时 CLI 退出码仍 0 | 中 | 正确性 | ✅ alpha.3（`failure` 存在 → exit 1） |
| [U22](devlog/R6.md#u22) | `llmTimeoutMs` 无下限，500 被接受 | 中 | 正确性 | ✅ alpha.3（spec.min=1000，两条写路径共用 validateSetting） |
| [U23](devlog/R6.md#u23) | `config set <PROVIDER>_API_KEY <值>` 明文收凭据进 shell 历史 | **高** | 安全 | ✅ alpha.3（CLI 拒收并指向 `auth`） |
| [U24](devlog/R6.md#u24) | `doctor` 只探写死的 4321 | 中 | 运维 | → V160 |
| [U25](devlog/R6.md#u25) | server 无请求级日志，凭据「日志零命中」证明力弱 | 低 | 可观测性 | → V164 |
| [U26](devlog/R6.md#u26) | AMiner 中文主题词检索基本无效 + 结果零摘要 | 中 | 检索 | → V161 |
| [U27](devlog/R6.md#u27) | arxiv 持续 429 / biorxiv 空响应污染召回基线 | 低 | 检索 | → V165 |
| [U28](devlog/A8.md#u28) | `originAllowlist` 里的远端 Origin 能写入/删除凭据（A8 BLOCKER-1；AD-18 ② 字面不覆盖 Origin） | **高** | 安全 | ✅ v0.9.0（凭据写路径 Origin 单独卡回环，不看 allowlist） |
| [U29](devlog/A8.md#u29) | 上游网络失败不冒泡到 SSE，界面无限等待；非流式挂到 255s（A8 HIGH-1） | **高** | 正确性 | ✅ v0.9.0（plan 调用失败即止，`failure.kind=llm`，14s 内返回） |
| [U30](devlog/A8.md#u30) | lab 审批令牌按全 UUID 绑定，UI/CLI 只印短 id，照文档操作必撞「令牌无效」（A8 HIGH-2） | 中 | 体验/正确性 | ✅ v0.9.0（接受 ≥8 位唯一前缀） |
| [U31](devlog/A8.md#u31) | V19 的 TTY 门可被 pty 包装器满足（安全含义待核实） | 低 | 安全 | → V167 |
| [U32](devlog/A8.md#u32) | 凭据面板「删除」按钮空操作（A8 HIGH-3） | — | — | ❌ **复核不成立**（Playwright 真实路径：弹窗在最上层、DELETE 发出、行更新；验收探针等的是原生 confirm）见 A8-window-fixes.md |
| [U33](devlog/A8.md#u33) | `doctor` 只探 4321（= U24） | 中 | 运维 | → V160 |
| [U34](devlog/A8.md#u34) | 权限面板「有效审批令牌」计数不随签发/消费变化 | 低 | 体验 | → V168 |
| [U35](devlog/A8.md#u35) | `data import` 文案说「空项目」，实际要求「项目不存在」 | 低 | 文案 | → V169 |
| [U36](devlog/A8.md#u36) | 工作台默认视图躺着约 40 个历史验收产物（= U14） | 低 | 数据卫生 | → V157 |
| [U37](devlog/A8.md#u37) | T5 第 13 步引用的 `/api/config/*` 端点已不存在（文档漂移） | 低 | 文档 | → V170（T5 已冻结，下版修） |
| [U38](#u38) | `connector` 任务失败被记成 `ok: true`——三次连接器失败（超时/429/空壳）在执行摘要里全是「ok」 | **高** | 正确性 | ✅ 本地已修（`connectorFailureOf` 解包信封；`ok:false` → 任务 failed） |
| [U39](#u39) | `subagent` 任务的 type 不校验：模型写 `"Review"`（大写）→ `TypeError: undefined is not an object` 冒给用户 | **高** | 正确性 | ✅ 本地已修（`normalizeSubAgentType` 运行期校验 + `buildSubAgentSpec` 入口拦；并删掉 `SUB_AGENT_TYPES` 副本） |
| [U40](#u40) | Europe PMC 查询语法不合法时返回 `{"version":"6.9"}` 空壳、HTTP 200，平台层当成功 | 中 | 正确性 | ✅ 本地已修（`searchPayloadProblem` 在编排层、只对 search：无计数也无结果容器 → 任务 failed 并给下一步） |
| [U41](#u41) | chat 的多步计划里 `code` 任务读 `/workspace/artifacts/tN_*.json`，但 `connector` 任务产出从不落盘 → 计划必然断链 | **高** | 设计 | ✅ 本地已修（V171 路线①：connector 产出落盘 `<workspace>/<sessionId>/<taskId>.json`，plan 提示词写明绝对路径，code 任务不再 glob cwd） |
| [U42](#u42) | chat 模式绕开成熟的 `lit search` 管线，让模型手搓 connector 调用 —— 同一需求 CLI 一条命令 26s 出 5 篇带 OA PDF | **高** | 设计 | → V172（plan 增加 `literature` 任务类型，别让模型手搓 connector） |
| [U43](#u43) | AMiner 凭据配了却从不参与检索——它不在 `searchSources` 里；而勾在里面的 `semanticscholar` 反而没凭据 | 中 | 配置 | → V173 |
| [U44](#u44) | `lit_search` 工具返回整份 JSON 进对话历史：一次子代理调用 **129,865 输入 token / $0.058**，是同轮其它调用的 40 倍 | **高** | 成本/性能 | ✅ 本地已修（`sub_agent.ts` `toolResultContent` 认识检索结果形状就瘦身，其余按 8 KB 截断并明说被截断）；残余 → V174（`lit_search` 自己的 `present()`、台账超阈值打标） |
| [U45](#u45) | PubMed 只认 `query`，模型按 NCBI 官方文档写的 `term` 被空串静默覆盖 → 200 + `esearchresult.ERROR`，两次检索空转 | **高** | 正确性 | ✅ 本地已修（`term`/`query` 两个名字都认、`query` 优先；空检索词当场失败不发上游；`searchPayloadProblem` 新增 `upstreamErrorOf` 并排在结果容器判据之前）；残余 → V175 |
| [U46](#u46) | `status: "placeholder"` 的连接器（cnki / wanfang）仍真发网络请求，把 TLS 证书错与 404 丢给 agent | 中 | 体验 | ✅ 本地已修（`HttpConnector.call()` 开头判 placeholder → 抛「占位实现 + caveat 原文 + 下一步」，一次 HTTP 都不发）；残余 → V176 |
| [U48](#u48) | summarize 只看每步输出前 200 字符——连接器成功了，模型只见到 `meta.count`，如实汇报「只留下命中计数」 | **高** | 正确性 | ✅ 本地已修（形状摘要：条数 + 前 5 条标题 + 落盘路径；其余截 600） |
| [U49](#u49) | 文献流程精读 8 篇期间界面无任何进度（阶段只进执行日志，没推 SSE），用户以为卡死 | 中 | 体验 | ✅ 本地已修（`progress.taskNote`，每阶段推「执行中 i/n：检索/下载/精读/综述」） |
| [U50](#u50) | 精读卡/综述没读 `subAgentModel_literature`，跟着聊天选择器的模型走（选了 kimi 就 8 篇全 kimi，每篇 ~50s） | 中 | 配置 | ✅ 本地已修（顺序：会话覆盖 > `subAgentModel_literature` > 默认） |
| [U51](#u51) | OA 全文命中率低（8 篇标 OA 只拿到 2）：`pdfUrl` 常是落地页而下载器不再解析一跳；`pdfUrl` 失败后没有按 DOI 的 Unpaywall 兜底 | 中 | 功能缺口 | → v0.10 S9 一起做（技能文档已如实写明目前不做） |
| [U52](#u52) | 右侧打开一条记录/文献后没有关闭按钮回总览（只能回时间线再点一次同一条） | 中 | 体验 | ✅ 本地已修（详情头部「← 返回总览」） |
| [U53](#u53) | 生成的产物（综述草稿）只以纯文字 id 出现在回复里，聊天框没有可点链接 | 中 | 体验 | ✅ 本地已修（结果带 `artifacts[]`，聊天框渲染成按钮切到产物视图；`ChatResponse.artifacts` 此前是无人填写的 `unknown[]`） |

### 方法缺陷

| 编号 | 一句话 | 状态 |
|---|---|---|
| [P1](#p1) | 三道防线（OpenScience 对比 / AD-12 门禁 / 零上下文验收）的盲区恰好重合，十条里八条都漏了 | 待讨论 |

### 修改方向速览

| 编号 | 方向 | 改动量 | 需要先拍板吗 |
|---|---|---|---|
| U5 | 兜底改为显式拒绝；两份清单合一或加对撞门禁 | 小 | 否 |
| U1 | usage 记录补 `errorKind` + 错误摘要 | 小 | 否 |
| U8 | 删掉其中一处 `console.log` | 极小 | 否 |
| U4 | orchestrator 跨阶段各发一次 progress | 小 | 否 |
| U7 | 跳过时把「本轮未验证」打成显式提示，或 CI 强制 record 模式 | 小 | 否 |
| U3 | 项目支持归档/打标，或对久未动的项目给轻提示 | 中 | 是（交互取舍） |
| U6·A | 非密配置的设置面板 + 一组写路由 | 中 | 否 |
| U6·B | 凭据能否走 HTTP 写入 | 大 | **是（与 AD-2 冲突）** |
| U2 | `doctor` 增加运行实例探测，或 server 落 pid 文件 | 中 | 是（选哪种方案） |
| U10 | `chat()` 真的把 `req.model` 用起来；加一条「换模型真换了」的门禁 | 小 | 否 |
| U9 | `chat` 补 `--model` / `--budget-usd` / `--project`；`--help` 先于消息解析 | 小 | 否 |

---

<a id="u5"></a>
## U5 · 模型路由有无条件静默兜底，两份模型清单不同步

> **本条原为「待核实」，核实后成立且比初判严重，已升为高。**
> 最初的怀疑是「文档没讲清楚该填哪种模型名形态」，核实后发现真正的问题在路由兜底。

**现场**：想把 `defaultModel` 从 `z-ai/glm-5.3-flash` 换成更快的模型，
查单价表发现键名有两种形态（裸名 `deepseek-v4-flash` 与带前缀 `z-ai/glm-5.3-flash`），
不确定该填哪种、填错会怎样。

**证据一 · 兜底是无条件的**

```ts
// backend/src/llm/router.ts:126
export function providerForModel(model: string): Provider {
  for (const provider of SUPPORTED_PROVIDERS) {
    if (PROVIDER_MODELS[provider].includes(model)) return provider;
  }
  const low = model.toLowerCase();
  if (low.includes("kimi") || low.includes("moonshot")) return "kimi";
  if (low.includes("gpt")  || low.includes("o4"))      return "openai";
  if (low.includes("claude"))                          return "anthropic";
  if (low.includes("deepseek"))                        return "deepseek";
  if (low.includes("qwen"))                            return "qwen";
  return "kimi";          // ← 认不出的一律当 kimi
}
```

**任何认不出的模型名都会被静默当成 Kimi**，用 Moonshot 的 baseUrl 发请求。
不报错、不警告。

**证据二 · 代码注释自己承认了后果**

```ts
// backend/src/llm/router.ts:20-23
// z-ai/glm-5.3-flash：v0.6 B2 轮次指定模型。必须显式登记——providerForModel 的
// 关键词兜底认不出 "z-ai/glm"（不含 kimi/gpt/claude/deepseek/qwen 任何一个词），
// 不登记会静默落到 kimi adapter 用错误的 baseUrl 调用。
```

也就是说：这个陷阱是**已知的**，处理方式是「记得去登记」，而不是「让它没法出错」。
下一个新模型如果有人忘了登记，同样的事会再发生一次。

**证据三 · 同一件事存在两份手写清单**

| 位置 | 结构 | 作用 |
|---|---|---|
| `backend/src/llm/router.ts` 的 `PROVIDER_MODELS` | provider → 模型名数组 | 决定请求发给谁 |
| `backend/src/llm/providers/registry.ts` 的单价表 | provider → 模型名 → 单价 | 决定怎么计费、预算闸怎么判 |

两边都编码了「这个模型属于哪家」这个**同一个事实**，各写一份，没有任何门禁对撞。

实测差集（单价表里有、`PROVIDER_MODELS` 里没有）：

```
deepseek-v4-flash · deepseek-v4-pro · kimi-k2.6 · kimi-k3
```

这四个目前靠关键词兜底侥幸落对了 provider。但它们没被显式登记这件事本身，
说明两份清单已经漂移了。

**证据四 · 一个具体的坑**

`moonshotai/kimi-k2.6` 登记在 `openrouter` 名下，而裸名 `kimi-k2.6` 会被关键词
兜底判给 `kimi`。**两个几乎同名的字符串走两条完全不同的路由和两套单价。**
用户凭直觉填哪个都不奇怪，填错了不会有任何提示。

**问题**

1. 静默降级。这个项目自己的纪律是「自动化降级必须 log」，这里连 log 都没有。
2. 同一事实两份手写副本。CHANGELOG 记载这个形态在一个版本里出现过四次，这是第五次。
3. 失败模式最糟糕的一种：不是报错，是**用错误的 baseUrl 发出请求**，
   最后表现为一个看不懂的上游错误，而真因在三层之外。

**修改方向**

- **立刻可做**：把 `return "kimi"` 改成抛错，错误消息里列出已登记的模型名并指向
  `config set defaultModel`。宁可拒绝，不要猜。关键词兜底那几行也应该至少 log 一行
  「模型 X 未显式登记，按关键词判给 Y」。
- **根治**：让单价表成为唯一真源。它本来就是 provider → model → price 的嵌套结构，
  已经携带了 provider 归属，`PROVIDER_MODELS` 可以从它派生而不是另写一份。
  做不到合并的话，加一条对撞门禁：两份清单的模型集合必须相等，不等就测试失败。
- **顺带**：`config set defaultModel` 应该在写入时就校验模型名，而不是等到真正调用时才炸。

**影响面**：`llm/router.ts`、`llm/providers/registry.ts`，加一条单测。不动任何调用方。

**风险**：改成抛错后，如果有人正在用某个未登记但恰好能跑的模型，会当场失败。
所以这条要配一次全量模型名盘点，把在用的都补登记。

---

<a id="u6"></a>
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

`backend/src/server/routes/` 下 13 个模块，没有 `config.ts`、没有 `auth.ts`、
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

**这条要拆成两半，不要一起处置**

| | 内容 | 判断 |
|---|---|---|
| **A 非密配置** | `defaultModel`、检索源、各类超时、`contactEmail`、`computeTarget`… | **没有理由不能在网页端改。**这些不是秘密，写进 `config.json` 而已。 |
| **B 凭据** | 各家 LLM API key、connector 的 key | **需要先做设计裁定，别默认照做。** |

**修改方向 · A（不需要拍板）**

加一个「设置」面板 + 一组配置写路由，把 32 个键里非密的那些暴露出来。

- 路由：`GET /api/config`（现有 `config list` 的投影）、`PUT /api/config/:key`。
  契约是机械生成的，加完路由 `contract --json` 和 Python SDK 会自动跟上。
- 前端：左栏「运维」下加一项「设置」，中栏出一个表单视图。
  每个键的说明文字 `config list` 里已经有了，直接用，不要另写一份。
- 校验：写入时就校验（模型名是否已登记、超时是否为正整数），
  不要等到运行时才炸——这条和 U5 的第三点是同一件事。

光是能在网页端换模型，就解决了现在「用着用着得开终端」的断裂感。

**修改方向 · B（必须先拍板）**

凭据能不能走 HTTP 写入，与 AD-2「凭据只在 daemon 进程」正面冲突。
`auth` 命令从 V115 起连回显都掐掉了，让 key 经 HTTP body 进来是反方向的。

要做的话至少先回答三个问题：

1. key 走 HTTP 进来时，怎么保证不落 server 日志、不落 raw、不进 usage、不进 record？
2. server 现在绑 127.0.0.1，但 `originAllowlist` 是可配的。放开之后这条路径就暴露了，
   要不要硬编码成「凭据路由永不接受非 loopback 来源」？
3. 要不要照 `lab token` 的先例，凭据写入也要一枚终端签发的一次性令牌？

**裁定之前就该做的一件小事**：网页端在显示某个源「未配置」时，
应该同时给出「去终端跑 `spark-research auth`」这条下一步。
现在只显示状态不说去哪做，**违反了这个项目自己的约定——失败消息都要带可执行的下一步**。

**关联**：agent 指南里写过「审批类动作不暴露为 MCP 工具，这是设计不是缺陷」，
并明确正确做法是把待办呈现给人类。凭据应该照同一个模式处理：
不提供写入口可以，但要把「去哪做」说清楚。

---

<a id="u1"></a>
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

结果是：事后完全无法判断这次失败该怪谁。紧接着的第二次调用成功了，所以也没法复现。

**修改方向**

- `UsageStore.append` 的记录结构增加 `errorKind`（用现成的 `LlmErrorKind`）和
  `errorMessage`（截断的摘要，注意脱敏——错误体里可能带 key 片段）。
- server 侧对 `ok: false` 的 LLM 调用打一行结构化日志，至少含 provider、model、errorKind。
  现在是完全静默的。
- `usage --json` 的输出把 errorKind 分布也统计出来，和 `unknownCostCalls` 并列。

**影响面**：`llm/` 的记账路径 + usage 的读侧。契约里 `/api/usage` 的响应形状会变，
SDK 需要重新生成。

**关联**：AD-13「LLM 失败无内容可用」。这条是它的观测面版本——
不是「失败后没内容」，是「失败后没证据」。

---

<a id="u2"></a>
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

$ curl -s localhost:4321/api/health
{"status":"ok","service":"spark-research","version":"0.8.0-alpha.3"}
```

父进程是 launchd（1），说明起它的终端早就关了，进程被系统收养。
它的二进制所在工作树 `spark-research-a7` 已经被删除，进程靠已打开的 inode 继续跑。

**三个后果**

1. **版本困惑**。浏览器打开 4321 看到的是 alpha.3 的工作台，但 `package.json`、
   CLI、文档全是 0.8.0。界面上没有任何地方提示「你连的是个旧构建」。
2. **数据目录是共用的**。这个旧 server 和新 CLI 指向同一个 `~/.spark-research`，
   两边都能写。旧构建有没有已修复的写入 bug，无从保证。
3. **没有任何机制会告诉你**。`doctor` 不查端口，`capabilities` 不查运行中的实例。

**修改方向**（两种方案，选一种，需要拍板）

- **方案甲 · doctor 探测**：`doctor` 增加一档「运行实例」，
  探本机常用端口上有没有 spark-research 在监听、版本是多少、和当前 checkout 是否一致，
  不一致就给出「先停掉旧实例」的下一步。优点是零新状态；缺点是只能探已知端口。
- **方案乙 · pid 文件**：server 启动时把 `{pid, version, port, cwd, startedAt}` 写进
  `~/.spark-research/server.json`，退出时清掉。`doctor` 和其他命令读它。
  优点是能发现任意端口；缺点是引入需要维护的状态，异常退出会留下陈旧文件
  （要靠 `kill -0` 校验 pid 是否还活着）。

**顺带**：工作台顶栏应该显示 server 版本。现在只有 `/api/health` 里有，
界面上看不到，这是「版本困惑」能持续两天的直接原因。

---

<a id="u3"></a>
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

**修改方向**（需要拍板，是交互取舍）

- **最小改动**：项目支持 `archived` 状态（`project archive` 命令已经存在了，
  先确认它有没有真的落状态、网页端读不读），下拉框默认折叠已归档的。
  把 20 多个验收产物一次性归档，问题当场消失一大半。
- **加一层保险**：工作台在指针指向一个「超过 N 天没有新 record」的项目时，
  顶栏给一条轻提示加一个「新建项目」快捷入口。不阻断，只提醒。
- **不建议**：改成「每次打开都不选项目」。那会破坏 CLI 侧已有的指针语义，
  而且 CLI 和网页共用同一个指针，改一边会让另一边行为变怪。

---

<a id="u4"></a>
## U4 · 聊天等待期的进度文案只有一句、只发一次

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

**问题**：链路本身是通的——后端在开跑前发一个 `progress` 事件，前端在还没收到任何
增量时拿它当占位文案（`center.tsx` 的 `onProgress`，逻辑正确，不会覆盖正在流入的正文）。

真正的问题是**那条 progress 只有一句固定文案、只发一次**：

```ts
// backend/src/server/routes/session.ts:95
sender.send("progress", { message: mode === "coexplore" ? "共探中" : "规划与执行中" });
```

于是不管 plan 跑了三秒还是三十秒，界面上永远是「规划与执行中」五个字，不动。
既不区分现在是 plan、execute 还是 review，也没有任何推进感。
回复越好、等待越长，而等待期内信息量恒定为零。

这不是性能问题，是预期管理问题。

**修改方向**

让 orchestrator 在跨阶段时各发一次 progress（「规划中」→「执行中」→「复核中」），
文案跟着阶段走。传输层（SSE）和消费端（`onProgress`）都是现成的，
只差生产端在管线里多发几次。

**影响面**：`agents/orchestrator.ts` 加几个回调点，`routes/session.ts` 把回调接到
`sender.send("progress", ...)`。前端一行不用改。

**已核实**：`onProgress` 两端都有实现，**不是**「建好了但没有生产调用方」那个形态。
最初的怀疑方向是错的，这里如实留痕。

---

<a id="u7"></a>
## U7 · 集成套件默认整体跳过，「8 skip」读起来像通过

**现场**：跑全量测试想确认环境没问题，`bun run test:integration` 的输出是：

```
 0 pass
 8 skip
 0 fail
Ran 8 tests across 3 files. [27.00ms]
```

零失败，绿的。但实际上**这三条链路这一轮一次都没被验证**。

**证据**：三个文件都在顶层无条件跳过

```ts
// tests/integration/literature_record.test.ts:33
describe.skipIf(!RECORDING)("真实网络 · 录制 fixture", () => { ... });
// novelty_record.test.ts:22 与 protein_record.test.ts:22 同构

// 开关来自环境变量，默认 replay
const MODE = fixtureModeFromEnv();          // backend/src/http/fixture.ts:74
const RECORDING = MODE === "record" || MODE === "live";
```

要真跑必须显式开：

```bash
FIXTURE_MODE=record bun run test:integration   # 打真实网络并重录 fixture
FIXTURE_MODE=live   bun run test:integration   # 打真实网络但不覆盖 fixture
```

**问题**：这是个「静默的门禁空转」。`27ms` 跑完 8 个用例这件事本身就说明什么都没做，
但输出里的 `0 fail` 会让人以为过了。CI 里也一样——如果哪天有人把它接进 CI
而不设 `FIXTURE_MODE`，会得到一条永远绿的流水线。

这个形态在本项目有先例：pytest 曾因文件名不匹配**静默收集到零个用例**，
等于整个 Python 侧没有门槛，后来靠 `pyproject.toml` 的 `python_files` 补上。
这条是同一个形态换了个位置。

**修改方向**

- **最小**：跳过时打一行显著提示，例如
  `⚠️ 集成套件已整体跳过（FIXTURE_MODE=replay）——这三条链路本轮未验证`。
  让「跳过」和「通过」在输出上长得不一样。
- **更好**：把 replay 模式下**真的能跑**的那部分跑起来。现在是整个 describe 跳掉，
  但 fixture 已经录好了，回放本身不需要网络——值得确认一下为什么连回放都跳。
  如果回放能跑，默认就该跑，只有重录才需要开关。
- **CI**：定期（比如每周一次）跑一轮 `FIXTURE_MODE=live`，把上游接口漂移暴露出来。
  fixture 回放永远绿，恰恰意味着它发现不了上游变更。

---

<a id="u8"></a>
## U8 · server 启动日志打两遍

**现场**：新起 server 后看日志，四行里有两组重复：

```
Spark Research server listening at http://127.0.0.1:4321
Press Ctrl+C to stop
Spark Research server listening at http://127.0.0.1:4321
Press Ctrl+C to stop
```

一度怀疑起了两个进程，查了确认只有一个（`pgrep -f "index.ts server" | wc -l` = 1）。

**证据**：两处各写了一份

```
backend/src/index.ts:686       console.log(`Spark Research server listening at http://127.0.0.1:${server.port}`);
backend/src/index.ts:687       console.log("Press Ctrl+C to stop");
backend/src/server/server.ts:26  console.log(`Spark Research server listening at ${url}`);
backend/src/server/server.ts:27  console.log("Press Ctrl+C to stop");
```

**问题**：本身无害，但它会让人误判「是不是起重了」——我就误判了一次，
多花了一条命令去确认。而且这又是一次「同一件事两份手写副本」。

注意两处的 URL 还不是同一个来源：`index.ts` 硬编码了 `http://127.0.0.1:`，
`server.ts` 用的是 `url` 变量。将来要支持绑别的地址时，前者会打印出错误的地址。

**修改方向**：删掉 `index.ts` 里那两行，留 `server.ts` 的（它拿的是真实 url）。
一分钟的改动。

---

<a id="u10"></a>
## U10 · `model` 覆盖声明了但从不读取，换模型是静默空操作

> **这条是在排查「chat 为什么慢」时撞出来的，顺带作废了我自己的一次测量。**

**现场**：想对比 `z-ai/glm-5.3-flash` 与 `deepseek-v4-flash` 的速度，
用 HTTP 接口传 `body.model` 切模型跑同一个问题。两轮墙钟差了近三倍
（162.8s vs 43.9s），一度以为换模型有效。

**证据一 · 用量记录出卖了它**

两轮跑完，`speed-probe` 项目的台账里**一条 deepseek 记录都没有**：

```
$ spark-research usage --project speed-probe
  LLM 调用 9 次 · 输入 4225 tokens · 输出 8740 tokens
  按模型:
    z-ai/glm-5.3-flash: 9 次 · $0.0026 · 2 次未知
```

逐条看，deepseek 那轮产生的三条记录是：

```json
{"provider": "openrouter", "model": "z-ai/glm-5.3-flash", "ok": true, ...}
```

**证据二 · 决定性实验**

指定 `qwen-max`——`QWEN_API_KEY` **未配置**。如果模型覆盖真的生效，
这次调用必然因为拿不到 key 而失败。实际结果是**正常回答**：

```
$ curl -X POST .../api/session/chat -d '{"model":"qwen-max", ...}'
[session probe-qwen]
## 结果摘要
**最终答复**：> 今天天气很好，适合出门散步。
```

落的记录仍是 `provider=openrouter model=z-ai/glm-5.3-flash`。

**证据三 · 根因在签名与实现之间**

HTTP 路由读了，也传下去了：

```ts
// backend/src/server/routes/session.ts:37
result = await ctx.agent.chat({
  sessionId, message,
  model: optionalString(body, "model"),      // ← 读到了，传下去了
  mode, budgetUsd: ..., allowUnpriced: ...,
});
```

`chat()` 的签名也声明了：

```ts
// backend/src/agents/orchestrator.ts:1053
async chat(req: {
  sessionId: string;
  message: string;
  model?: string;          // ← 声明了
  ...
}) {
  if (req.budgetUsd !== undefined || req.allowUnpriced !== undefined) {
    this.sessionBudget.set(req.sessionId, { budgetUsd: ..., allowUnpriced: ... });
  }
  ...                      // ← req.model 之后再也没出现过
}
```

**`req.model` 被声明、被传入，然后从头到尾没有任何一处读它。**
`budgetUsd` 和 `allowUnpriced` 在紧邻的几行里都被存进了 `sessionBudget`，唯独 `model` 没有。

**后果**

1. **换模型是静默空操作**。传什么都用 `config.json` 里的 `defaultModel`，不报错不告警。
2. **没有任何办法只为一次对话换模型**。CLI 的 `chat` 也没有 `--model`（见 U9），
   于是唯一能换模型的途径是改全局配置。
3. **把我的测量作废了**。162.8s 与 43.9s 的差距**不是模型差异**，两轮跑的都是 glm。
   真实差异来自网络抖动，以及第一轮里两次失败调用（其中一次等了 75 秒才放弃）。
   **如果不是记账里的 `provider` 字段露了馅，这个错误结论就发出去了。**

**这正是本仓反复出现的那个形态**：参数建好了、接口签名有了、调用方也传了，
**就是没有生产读取方**。CHANGELOG 记载过 `defaultProvider` 只写不读（V40），
说它「藏在配置项里，孤儿门禁抓不到」。这次是藏在函数签名里，同样抓不到。

**修改方向**

- `chat()` 真的把 `req.model` 用起来——按 `budgetUsd` 的同一套路存进会话状态，
  让本次会话的所有模型调用都走它。
- 加一条门禁，形式要能抓住这一类而不只是这一个：
  **传一个已登记但当前 provider 无 key 的模型，断言调用失败**。
  这条断言只有在覆盖真的生效时才通过，静默忽略必然被抓。
- usage 记录的 `model` / `provider` 必须来自**实际发出请求的那次调用**，
  而不是配置默认值。现在这两个字段会撒谎。
- 顺带核一遍 `/api/session/stream`：它单独读了 `const model = optionalString(body, "model")`，
  是不是也一样丢掉了，没验。**本条只对 `/chat` 路径有实证。**

**影响面**：`agents/orchestrator.ts` 的 `chat()` 与其下游取模型的地方；usage 记账的取值来源。

**风险**：修好之后，之前「传了 model 但其实没生效」的调用会开始真的换模型。
如果有脚本依赖了这个错误行为（传了某个模型但实际跑 glm），行为会变。
考虑到这个覆盖从来就没生效过，依赖它的可能性极低。

---

<a id="u9"></a>
## U9 · CLI `chat` 没有任何参数，`--help` 会被当成消息发给模型

**现场**：想给 `chat` 加个 `--model` 试别的模型，先跑 `spark-research chat --help` 看用法。
命令**挂了两分多钟没有任何输出**，被迫 kill 掉。

**证据 · 整条命令只做一件事**

```ts
// backend/src/index.ts:489
case "chat": {
  const msg = process.argv.slice(3).join(" ");   // ← 整个 argv 拼成消息
  if (!msg) {
    console.log("用法: spark-research chat <消息>");
    process.exitCode = 1;
    break;
  }
  chatOnce(msg);
  break;
}
```

`--help` 非空，于是它成了消息本身，被原样发给模型。那两分钟是真的在等模型回答
「--help」这个问题。**只有一个字都不传时才会打印用法。**

**证据 · `chatOnce` 不带预算、不带项目、不带模型**

```ts
// backend/src/index.ts:427
async function chatOnce(message: string) {
  ...
  const result = await orch.chat({ sessionId, message });   // ← 只有这两个
```

对比同一个 `chat()` 接受的参数：`model`、`budgetUsd`、`allowUnpriced`、`mode`、`onDelta`
一个都没传。

**后果**

1. **CLI 的 chat 完全没有预算闸。**agent 指南里写的是「每条会调 LLM 的命令都带
   `--budget-usd`」，`chat` 是个例外，而且是无声的例外——没有地方说明它不支持。
   一轮 chat 实测会发出 4 到 6 次模型调用（见 U10 的台账），没有任何上限。
2. **`--help` 是一次要花钱的模型调用。**误打一次就是几分钱加两分钟。
   CHANGELOG 里 V128 记的是「`--help` 无副作用」，那条修复显然没覆盖到 `chat`。
3. **`chat` 也不接 `--project`。**会话绑哪个项目取决于全局指针，
   与 agent 指南「每条涉及项目数据的命令都带 `--project`」相冲突。

**修改方向**

- 在拼消息之前先解析旗标：`--help` / `-h` 打印用法即退出，
  `--model` / `--budget-usd` / `--allow-unpriced` / `--project` 透传给 `orch.chat()`。
- 更根本的一条：**旗标解析应该统一，不要每个子命令各写一套。**
  `lit` / `idea` / `exp` 都有完整旗标，唯独 `chat` 是裸 `argv.join(" ")`。
  这又是一处「同一件事多份手写副本」。
- 门禁：给每个会调 LLM 的子命令加一条「`--help` 不产生任何模型调用」的断言。
  V128 修过一次同名问题却漏了 `chat`，说明靠人记是不够的。

**影响面**：`backend/src/index.ts` 的 `chat` 分支与 `chatOnce`。不动 orchestrator。

---

---

# 方法缺陷

> 上面的 U 系列是**产品**的问题。这一段记**发现问题的方法**本身的问题——
> 为什么这些东西没有被更早发现。用 `P` 前缀（Process），和 U、V 都不冲突。

<a id="u11"></a>
## U11 · `/api/session/chat` 不读 `?project=`，会话按「当前项目」指针入账

**现场**：2026-09-15 跑 R6 基线脚本（`scripts/measure-chat.ts`，v0.9.0-alpha.2 server @4321）。脚本按仓库其它域路由的惯例
（`/api/lit`、`/api/usage` 等都认 `?project=<slug>`）给 `POST /api/session/chat?project=t1-protein-r3` 发消息，
跑前后比对该项目 `usage.jsonl` 行数差。

**证据**：

```
t1-protein-r3 r1: HTTP 200 墙钟 54.4s 调用 0 失败 0
$ ls -t ~/.spark-research/projects/*/usage.jsonl | head -1
/Users/jimmyclaw/.spark-research/projects/speed-probe/usage.jsonl      ← 那 54 秒的三次模型调用记在这里
$ grep -n "project" backend/src/server/routes/session.ts | head
61:      projectSlug: ctx.agent.projectForSession(sessionId)?.slug ?? null,   ← 只按 sessionId 反查，query 一个字不读
```

`projectForSession()` 对未绑定的 sessionId 落到 `state.json` 的 `currentProject`——当时正是 U3 里那个「指针停在测试项目」的 `speed-probe`。

**问题**：同一套 HTTP 面上，其它域路由认 `?project=`，聊天路由静默忽略它。写脚本/SDK 的人按惯例传了参数、
拿到 200、台账落进另一个项目，没有任何一处报错。这是 U10 的形状（声明了/传了、静默丢弃），只是这次丢的是路径参数。
网页端不受影响（它先 `POST /api/projects/current` 再聊天），所以六轮验收没撞到。

**修改方向**：二选一，须裁定——① `/api/session/chat` 与 `/stream` 认 `?project=`（或 body `project`），首次出现的 sessionId 据此 `bindSession`；
② 明确不认，但收到未知 query 参数时 400 并指向 `POST /api/projects/current`。倾向 ①（与其它域路由一致，`chat --project` CLI 已经是这个语义）。
`gate_i_param_readers` 管的是函数参数，管不到 HTTP query——门禁能力边界（V146 同族），一并登记。
基线脚本已改走 `POST /api/projects/current`，跑完改回原指针。

<a id="u12"></a>
## U12 · 预算闸拒绝返回 HTTP 200 + `review.approved: true`，台账无痕；拒绝前仍耗时 49.8s

**现场**：同上。脚本把 `--budget 0.30` 均摊成每轮 `budgetUsd: 0.015` 传给 `/api/session/chat`。

**证据**：

```
t1-protein-r3 r3: HTTP 200 墙钟 0.0s 调用 0 失败 0        ← 20 轮全部如此
$ curl -w "%{http_code} %{time_total}s" -X POST .../api/session/chat -d '{"sessionId":"r6-manual-2",…,"budgetUsd":0.015}'
200 49.837487s
{"sessionId":"r6-manual-2","mode":"chat","projectSlug":"speed-probe","response":"[session r6-manual-2]\n[orchestrator] 本次调用被预算闸拒绝，未生成结果摘要。预算闸：本项目已知花费 $0.0148 + 在飞预留 $0.0000 + 本次估价 $0.0011 将超过上限 $0.01（已知下界口径…）。这次调用没有发出、没有新花费…","review":{"approved":true,"findings":[]}}
$ tail -1 ~/.spark-research/projects/speed-probe/usage.jsonl     ← 时间戳仍是上一次成功调用的，本次零新增行
```

对照：新建零花费项目 `r6-probe`、`budgetUsd: 1.0` 同一句话 → 200 / 72.8s / 台账 3 行（plan、execute、summarize 各一次，
每次 ~2000 输出 token）。

**问题**：三件事叠在一起。
① `budgetUsd` 的语义是**项目累计已知花费的上限**，不是「本次可花多少」——文档与 UI 的 `BudgetInput` 都没说清，调用方按「本次额度」传就必然被拒；
② 被拒是 **HTTP 200**，`response` 里是一段人话，`review.approved` 还是 `true`——程序化调用方（脚本、SDK、MCP）没有任何结构化字段能分辨「拒绝」与「成功」，脚本把 20 次拒绝当成了 20 次「0 调用的成功」；
③ 台账零新增：被拒的调用不落 `ok:false` 行，`usage` 里查不到「这个项目今天被预算闸拒了 20 次」。V79③ 只覆盖了任务面板的闸消息，没覆盖 chat 路由。

**修改方向**：② 最紧要——被拒时响应加结构化字段（如 `gate: {kind:"budget", limitUsd, knownUsd, estimateUsd}`，或直接 402/422 + `ApiErrorBody`，与 V107 错误 envelope 统一时一起定）；`review` 不该在没有产出时标 `approved`。
③ 台账落一行 `ok:false, errorKind:"budget"`（α-4 的 errorKind 枚举加一个值），让 `byErrorKind` 能看见闸。
① 文档 + `BudgetInput` 文案改为「本项目累计上限」，或改语义为「本次增量上限」——改语义影响 CLI `--budget-usd`（V119），须裁定。

**已核实（修复窗口，只读代码 + 对照实验）**：49.8s 不是模型在跑——plan 调用被闸拒后 `plan()` 退到 `defaultPlan()`，默认计划里的连接器任务（UniProt/PDB/AlphaFold 查询）真跑了 ~49s 网络 I/O（零 LLM），然后 summarize 再被拒一次。被拒的 plan 与 summarize 都不落台账。alpha.3：plan 被闸拒即抛 `BudgetGateError`，整轮到此为止，不再跑默认计划。

<a id="u13"></a>
## U13 · 单轮 chat 超过 255s 时 server `idleTimeout` 掐断连接，编排在后台继续、结果无人接收

**现场**：R6 基线，t2-sc-r3 第 1 轮。

**证据**：

```
{"project":"t2-sc-r3","round":1,"wallMs":287193.37,"calls":1,"http":0}     ← fetch 抛错，HTTP 0
{"project":"t2-sc-r3","round":2,"wallMs":56600,"calls":5,"http":200}       ← 下一轮多出 2 次调用 = 上一轮漏的
backend/src/server/server.ts: export const SERVER_IDLE_TIMEOUT_S = 255;     // Bun 上限
```

**问题**：A5 把 `idleTimeout` 拉到 Bun 的上限 255s 是对的，但 chat 的同步路由在这个上限之上没有任何兜底：超过它，
客户端收到的是连接重置（不是错误消息），服务端不知道没人在听，继续把 plan/execute/summarize 跑完、把钱花完。
基线里 20 轮有 3 轮墙钟 >170s，逼近这个天花板；网络稍差就会撞上。

**修改方向**：① 同步 `/api/session/chat` 超过阈值（如 200s）时改回 202 + 任务句柄（任务路由已有这套）；或 ② 把 UI 与脚本一律推到 `/stream`（SSE 有心跳，不受 idleTimeout 影响——需核实 Bun 对 SSE 的 idle 判定是否按帧刷新）；③ 无论哪条，server 端在客户端断开时应取消编排（`AbortSignal` 透传到 LLM 调用），别把钱花在没人要的结果上。

<a id="u38"></a>
## U38 · `connector` 任务失败被记成 `ok: true`

**现场**：2026-09-15 11:31，网页端 chat 问「帮我下载关于 mRNA 最新的研究综述论文，和 AI 主题相关的更好」（项目 `spark`，session `web_1789471590880`）。

**证据**（summarize 收到的执行摘要原文，取自 `raw/llm/2026-09-15.jsonl`）：

```
- [connector] t2: ok — {"ok":false,"server":"pubmed","tool":"search","error":"HTTP request timed out after 30000ms: ..."}
- [connector] t3: ok — {"ok":false,"server":"arxiv","tool":"search","error":"Connector \"arxiv\" tool \"search\" failed: HTTP 429"}
- [connector] t5: ok — {"ok":true,"server":"europepmc","tool":"search","result":{"version":"6.9"}}
```

`backend/src/agents/orchestrator.ts:879`：

```ts
const res = await this.daemon.dispatch("mcp_call", {...});
this.record(sessionId, "connector", "call", JSON.stringify(res).slice(0, 200));
return { taskId: task.id, kind: task.kind, ok: true, output: JSON.stringify(res) };   // ← 无条件 true
```

**问题**：`mcp_call` 对连接器失败**不抛异常**，而是返回 `{ok:false, error}` 信封。编排层只有 `catch` 分支才置 `ok:false`，于是**每一次连接器失败都是一次「成功的任务」**。这次是模型自己去读 JSON 正文才发现不对；换一个不那么谨慎的模型，摘要就会写成「已检索 PubMed」。下游全部受影响：`ExecutionOutcome.ok` 是证据图、review 层、`repairing` 判定的输入。

**修改方向**：`executeTask` 的 connector 分支解包信封——`res.ok === false` → `ok:false` 且 `output` 带 `error`。同族检查：其它 `dispatch` 调用点（code / lab / compute）是不是也把信封当成功。门禁：一条「连接器返回 ok:false → ExecutionOutcome.ok 必须 false」的单测，阴性对照恢复 `ok: true` 即红。

<a id="u39"></a>
## U39 · `subagent` 任务的 type 不校验，TypeError 冒给用户

**证据**：

```
- [subagent] t7: failed — undefined is not an object (evaluating 'defaults.grants')
```

模型规划的是 `params: {"subagent": "Review"}`（大写 R）。`orchestrator.ts:887`：

```ts
const type = (task.params?.subagent ?? "execute") as SubAgentType;   // ← 只是类型断言，没有运行时校验
```

`sub_agent.ts:262` `const defaults = SUB_AGENT_DEFAULTS[type];` → `undefined` → `defaults.grants` 崩。实测：

```
subagent 'Review' → TypeError: undefined is not an object (evaluating 'defaults.grants')
subagent 'review' → review
```

**问题**：`SubAgentType` 是编译期联合类型，模型给的是运行期字符串——`as` 断言把校验的责任凭空抹掉了。这是 AD-17「声明即须有读者」的近亲：**声明的类型不等于运行时的约束**。用户看到的是一句 JS 内部错误，没有下一步。

**修改方向**：`buildSubAgentSpec` 入口校验 type ∈ `SUB_AGENT_TYPES`，不认识就抛带下一步的错误（列出可用类型）；`executeTask` 先做大小写归一（`"Review"` → `"review"`）再校验，认不出就让这个任务 `ok:false` 并说明，而不是崩。顺带：`normalizeTask()`（parsePlan 里）就该把 kind/params 的枚举值一起校验掉——计划是模型写的，**计划本身就是不可信输入**。

<a id="u40"></a>
## U40 · Europe PMC 查询语法不合法 → `{"version":"6.9"}` 空壳 + HTTP 200 + `ok: true`

**证据**（模型原样 args 复现，`ConnectorRegistry.registerBuiltins()` 直调）：

```
EPMC 模型原样（query 含 "(SRC:MED OR SRC:PPR)"，sort="DATE_PUBLICATION desc"） → {"version":"6.9"}
EPMC 去掉 sort                                                                  → {"version":"6.9"}
query+limit / query+pageSize / query+format+pageSize / query+OPEN_ACCESS        → 均返回 hitCount 41514 / 35814 与结果
```

**问题**：EPMC 对这条查询返回的是一个**只有 `version` 的空壳**（既没有 `hitCount` 也没有 `errCode`），HTTP 200。连接器与编排层都没有「一次检索至少要有 hitCount 或结果数组」这条判据，于是「查询写错了」和「查到 0 篇」和「查成功了」三件事在平台里长得一模一样。

**修改方向**：literature 连接器的 `search` 统一加一条出口断言——响应里既无结果数组也无计数字段 → 视为失败并回一条带下一步的错误（「查询语法可能不合法，检查 EPMC 语法」）。这条判据对 pubmed/openalex/crossref 同样适用，写在 `base.ts` 一处。

<a id="u41"></a>
## U41 · chat 多步计划里 `code` 任务读 `/workspace/artifacts/tN_*.json`，而 `connector` 产出从不落盘

**证据**：模型的 t4 代码原文 `open('/workspace/artifacts/t2_pubmed.json')`；t2 的产出只以字符串形式回到 `ExecutionOutcome.output`，交给 summarize，**从不写盘**。session workspace `~/.spark-research/workspaces/web_1789471590880/` 实测是空目录。t4、t6 因此 `failed`，空输出。

**问题**：编排器让模型规划「多步骤、后一步读前一步产物」的计划，却没有给步骤间任何落盘约定。模型（任何模型）都会按常识假设产物在 workspace 里。**这不是模型的错，是契约缺口**：要么给约定，要么别让它规划这种计划。

**修改方向**：二选一须裁定——① 每个任务的产出按 `<workspace>/<taskId>.json` 落盘，并把路径写进给模型的任务描述里（`code` 任务的 prompt 里明确「上一步的产物在这些路径」）；② plan 的提示词明说「步骤之间不共享文件系统，需要串联就写成一个任务」。倾向 ①——② 等于放弃多步计划。

<a id="u42"></a>
## U42 · chat 绕开成熟的 `lit search` 管线，让模型手搓 connector 调用

**现场**：同一需求，两条路径的实测对照。

chat 路径（7 步计划，2 次 LLM 调用，约 46s）：0 篇论文、0 个 PDF、1 次崩溃。

CLI 路径（`lit search`，零 LLM 调用，约 26s）：

```
$ bun backend/src/index.ts lit search "mRNA vaccine machine learning review" --project spark --limit 5
  ✅ pubmed: 30 条（深池 30/源）
  ❌ biorxiv: 上游返回空响应（HTTP 200、0 字节）
 1. Therapeutic cancer vaccines: advancements, challenges and prospects … doi:10.1038/s41392-023-01674-3 · 有 OA PDF
 4. Algorithm for optimized mRNA design improves stability and immunogenicity … doi:10.1038/s41586-023-06127-z · 有 OA PDF
 …（5 篇，均有 OA PDF）
```

**问题**：`lit search` 是被六轮验收打磨过的管线——多源并行、按 DOI/标题去重、blended 排序、OA 判定、失败源如实标注、入库、可接 PDF 下载与 SHA256 血缘。chat 模式的 plan 提示词却只告诉模型有 `connector` 这种原始任务类型（`params.server/tool/args`），**没有告诉它平台已经有一条文献检索管线**。于是模型每次都从零手搓 esearch 参数、手写去重代码、手写 PDF 下载代码——把一条测过的路重新发明一遍，还发明错了。

**修改方向**：给 plan 增加一种任务类型（如 `kind: "literature"`，params 只有 `query/limit/sources`），直接调 `LiteratureSearcher`；并在 plan 提示词里把它排在 `connector` 之前，`connector` 的描述改成「只在没有现成管线时用的低层出口」。同族问题值得盘一遍：**还有哪些成熟 CLI 能力没有出现在 plan 的任务类型表里**（精读、综述、novelty check、data export…）——这正是 P1「对比看能力不看接线」的形状，只是这次缺口在「模型知不知道我们有什么」。


<a id="u43"></a>
## U43 · AMiner 凭据配了却从不参与检索；勾了的 semanticscholar 反而没凭据

**现场**：2026-09-15 晚，用户问「请求查找论文时，现在会使用到 AMiner 么」。

**证据**：

```
$ spark-research config get searchSources
  当前值: openalex,crossref,europepmc,semanticscholar,arxiv,pubmed,biorxiv      ← 没有 aminer

$ spark-research lit sources
  semanticscholar  凭据未配置   ⚠️ 匿名调用持续 429……未配置时统一检索把它标为 skipped
  aminer           凭据已配置   ⚠️ 未配置时统一检索把它标为 skipped，其余源照常返回
```

也就是说：**配了凭据的源不在检索清单里，在检索清单里的源没有凭据。** 两件事各自都「没报错」。

显式指定时 AMiner 确实能用，但结果与查询主题基本无关（U26 / V161 的复现）：

```
$ spark-research lit search "mRNA vaccine artificial intelligence" --sources aminer --limit 3
  ✅ aminer: 9 条（原查询 0 命中（AMiner 按词序列匹配）；已按 4 词拆分查询、按命中词数合并；只取 ≥2 词同时命中）
 1. Artificial Intelligence and Games …
 2. Artificial Intelligence in Services …
 3. Explainable Artificial Intelligence (XAI) …        ← 没有一篇与 mRNA 有关
```

**问题**：两层。① **配置面没有把「凭据」与「检索源勾选」这两件事关联起来**——用户配了一个源的 key，合理预期是「以后会用它」，实际要再去另一个面板勾上；反过来，勾了但没 key 的源每次都被 skip，用户也看不出来。② 设置面板的检索源列表没有显示「这个源有没有凭据、这次会不会真被查」。

**修改方向**：① 检索源面板每行显示凭据状态与「本次会不会参与」（已勾 + 有凭据 = 参与；已勾 + 缺凭据 = 跳过并给 `auth --connector <id>`；未勾 + 有凭据 = 提示「已配置但未启用，要不要勾上」）。② 凭据写入成功后，如果该源不在 `searchSources` 里，回一句可执行的下一步。③ AMiner 本身的检索质量问题归 V161，本条只管「会不会被用到」。


<a id="u44"></a>
## U44 · `lit_search` 的工具返回不摘要，整份 JSON 进对话历史 → 单次调用 13 万输入 token

**现场**：2026-09-15 20:32 +0800（台账原文 UTC `2026-09-15T12:32:11.706Z`；本文档其余处出现的「2026-09-16」是笔误，以台账为准）用户自测（项目 `spark0915`，课题「中美 RSI 领域 2020–2025 进展对比」）。监控报出一次 `COST` 事件。

**证据**：台账那一行——

```json
{"ts":"2026-09-15T12:32:11.706Z","command":"chat:subagent","provider":"deepseek",
 "model":"deepseek-v4-flash","ok":true,
 "inputTokens":129865,"outputTokens":783,"costUsd":0.05817416}
```

单价没问题（0.44 USD/M 输入 × 129865 ≈ $0.057，表是对的）。问题在输入量。raw 层那次调用的 prompt 落成了 blob（428,696 字节），拆开看 9 条消息：

```
[system   ]     2397 字符   Explore Sub-Agent 提示词
[user     ]      216 字符   任务描述
[assistant]      137 字符   模型的开场白
[tool     ]       71 字符   library 查询（空库）
[tool     ]      101 字符   records 查询（空）
[tool     ]       65 字符   {"ok":false,...,"error":"工具 'lit_search' 调用超时（>30000ms）"}
[tool     ]    81707 字符   lit_search 返回（wearable sensor …）
[tool     ]   105448 字符   lit_search 返回（tele-rehabilitation …）
[tool     ]   197383 字符   lit_search 返回（clinical practice guideline …）
                 ─────
                387525 字符（≈ 384 KB），其中 384,538 字符是三次检索的原始 JSON
```

**问题**：`lit_search` 在子代理 tool loop 里把**完整检索结果 JSON**（7 个源 × 每源 30 条，每条含全部字段）原样塞回对话历史。三次检索就把上下文顶到 13 万 token。两层后果：
① **成本**——这一次 $0.058，是同轮其它调用（$0.0014 上下）的 40 倍；子代理多搜几轮就是几毛钱一次对话。
② **复利**——tool loop 每轮都重发整段历史，第四次检索会把前三次再付一遍。
③ 顺带暴露：同一轮里有一次 `lit_search` **30 秒超时**（MCP 工具超时），而超时那条只回了 65 字符，说明成功路径与失败路径的返回体量差了三个数量级，没有任何一层对此设限。

`McpToolRunner` 其实**已经有** `tool.present(result, args)` 这个表现层钩子（`mcp/server.ts:150`），只是 `lit_search` 没用它。

**修改方向**：① 给 `lit_search` 写 `present()`：只回「每源 outcome + 命中数 + 前 N 条的标题/DOI/年份/OA 标记」，完整结果留在 artifact 里并把 artifact id 告诉模型（要细节就去取）。② 给工具返回定一条**通用上限**（如 8 KB），超了自动截断并注明「已截断，完整结果见 artifact <id>」——这条要放在 tool loop 的统一出口，不是每个工具各写一份。③ 台账加一条可观测：单次调用输入 token 超阈值时在 `usage --json` 里打标，便于事后归因（本次是靠监控脚本的 COST 分支才看见的）。

**已修（v0.9.1 本地窗口，`c099342` + `6979f1f`）**：修的是上面的 ②——`sub_agent.ts` 的 `toolResultContent()` 在工具返回进消息历史之前先瘦身：认得出「检索结果」形状（`{query, sources[], papers[]}`）的按字段瘦身（保留每源 outcome/计数与前 10 篇的 title/year/venue/doi/isOpenAccess/citedByCount/sources，摘要截到 200 字，砍掉 authors/ids/url/pdfUrl/references，并在 `_compacted.droppedFields`/`note` 里写明砍了什么、怎么取回完整字段）；认不出形状的按 `TOOL_RESULT_MAX_CHARS = 8000` 截断，并在 `_truncated`/`_note` 里**明说被截断**——静默截断会让模型以为自己看到了全部，比截断本身更危险。门禁 `ux_window` U44 ×3。

**残余** → **V174**：① `lit_search` 自己的 `present()` 钩子仍未写（现在是在 tool loop 统一出口瘦身，不是在工具侧）；③ 台账「单次输入 token 超阈值打标」未做。另：本次瘦身**只认得检索结果这一种形状**，其余工具一律走通用截断。


<a id="u45"></a>
## U45 · PubMed 只认 `query`，模型按 NCBI 官方文档写的 `term` 被静默覆盖成空串

**现场**：2026-09-16，网页端 chat 问「rsi 领域最近中国和美国有怎样的进展」（项目 `spark0915`，session `web_1789475371793`）。计划里 t2、t3 两次 PubMed 检索全部空转，模型拿不到任何一条结果。

**证据**（执行摘要原文）：

```
{"ok":true,...,"result":{"esearchresult":{"ERROR":"Empty term and query_key - nothing todo"}}}
```

修前 `backend/src/connectors/literature.ts` `PubMedConnector.search`：

```ts
const term = typeof params.query === "string" ? params.query : "";   // 只认 query
const rest = { ...params };                                          // rest 里还留着调用方的 term
await this.requestRaw("search", { ...rest, term, db: "pubmed", ... });  // 空串覆盖掉它
```

对照：同一个文件里 arXiv 的写法有守卫 `!("search_query" in params)`（`literature.ts:518`），**只有 PubMed 漏了**。

实测（经 `daemon.dispatch("mcp_call")` 同一条路）：

```
修前  {term}  → ERROR=Empty term and query_key - nothing todo
修前  {query} → 2 条
修后  {term}  → 2 条
修后  {query} → 2 条
```

**问题**：两层。

① **参数名**：NCBI 自己的参数名就是 `term`，平台的统一名是 `query`。模型用的是官方文档上的名字，怪不到它头上。更糟的是调用方明明写了 `term`，它先被 `...rest` 带进去、又被算出来的空串覆盖——不是「不认识」，是**认识了还被抹掉**。

② **判据**：上游用 HTTP 200 回业务错误（NCBI 是 `esearchresult.ERROR`）。U40 那条原判据只看「`esearchresult` 这个键在不在」，而 `esearchresult` 正好在 `SEARCH_RESULT_KEYS` 里——一个错误信封因此被当成合法空结果放行。

**已修（v0.9.1 本地窗口，`d1f8a23`）**：① `term` 与 `query` 两个名字都认，`query` 优先（平台口径），`rest` 里两个都删掉；② 检索词为空当场抛带下一步的错误，**不向上游发空检索词**；③ `base.ts` 新增 `upstreamErrorOf()`（认 NCBI `esearchresult.ERROR` 与 REST 源的 `errCode`/`errMsg`/`error`），在 `searchPayloadProblem()` 里**排在「有没有结果容器」之前**。门禁 `ux_window` U45 ×4。

**残余** → **V175**：`upstreamErrorOf` 的错误码清单只覆盖 NCBI 一家加通用三个键（`errCode`/`errMsg`/`error`），其余源的「200 带错」形状没有盘过。

<a id="u46"></a>
## U46 · `status: "placeholder"` 的连接器仍会真发网络请求，把上游噪声丢给 agent

**现场**：同一 session（`web_1789475371793`）的 t4、t5。

**证据**：

```
t4  cnki    → ERR_TLS_CERT_ALTNAME_INVALID（https://kns.cnki.net/kns8s/brief/grid）
t5  wanfang → HTTP 404
```

而这两个连接器在 `backend/src/connectors/china.ts` 里**自己就标着**：

```ts
status: "placeholder",
caveat: "占位实现：无公开 API 渠道，调用会失败。中文文献主路径请用 aminer",          // cnki
caveat: "占位实现：官方 Web API 需企业授权，调用会失败。中文文献主路径请用 aminer",   // wanfang
```

**问题**：`HttpConnector.call()` 从不读 `metadata.status`，照发请求。平台明明知道这条路不通，却让计划白花两个步骤，再把 TLS 证书错、404 这类上游噪声原样丢给模型——模型还得自己猜是网络问题还是参数写错了。声明写了没有读者，是 AD-17 的又一例。

**已修（v0.9.1 本地窗口，`c099342`）**：`base.ts` 的 `call()` 开头判 `metadata.status === "placeholder"` → 抛「占位实现 + caveat 原文 + 下一步（换用已可用的源，`spark-research lit sources` 看哪些免 key / 已配凭据）」，**一次 HTTP 都不发**。门禁 `ux_window` U46 ×2（含一条非 placeholder 源不受影响的回归防护）。

**残余** → **V176**：CNKI / 万方的真实可用渠道（官方 API 或机构订阅）仍未接通——这是老 D3，本条只把「调用即失败」变得诚实。**注意**：将来真接通了渠道，记得同时把 `status` 从 `placeholder` 改掉，否则新渠道会被这道闸挡在门外。

<a id="u48"></a>
## U48 · summarize 只看每步输出的前 200 字符

**现场**：2026-09-15 用户自测第三次（session `web_1789477865031`，「RSI 中美进展」）。U47 生效后 OpenAlex / Crossref / EuropePMC 四次检索**真的成功了**，模型却汇报「只留下了命中计数（条目级数据未进入可读记录）」。

**证据**：summarize 收到的执行摘要，每行都是 223 字符：

```
- [connector] t5: ok — {"ok":true,"server":"openalex","tool":"search","result":{"meta":{"count":56768,"db_response_time_ms":216,"page":1,"per_page":25,"groups_count":null
```

`orchestrator.ts`（修前）：`e.output.slice(0, 200)`。一份 OpenAlex 结果的前 200 字符恰好只够到 `meta`，`results[]` 在后面。模型说的是实话。

同一会话的 t10 聚合代码 `glob('**/*.json', recursive=True)` 扫到 **496 个文件、0 条记录**——内核 cwd 是 server 的检出目录（仓库），连接器产出从未落盘（U41）。t12 于是把 `rsi_cn_us_report.md` 写进了仓库工作区（已移出留存）。

**问题**：编排器让模型「基于执行记录汇总」，却只给它看每条记录的开头。对 analysis/code 输出 200 字符勉强够，对 connector 的 JSON 等于什么都没给。

**修改方向（已做）**：connector 成功结果按形状摘要（openalex `results[]` / crossref `message.items[]` / europepmc `resultList.result[]` / pubmed esummary map → 条数 + 前 5 条标题）并附落盘路径；其余输出截 600。与 V171 路线①同一提交。


<a id="u49"></a>
## U49 · 文献流程跑精读时界面没有进度

**现场**：2026-09-15 21:49 用户在 chat 问 RSI 中美进展，V172 流程跑到精读阶段（`moonshotai/kimi-k2.6` 每篇约 50s，默认最多 8 篇），用户问「现在我的任务在跑着吗？为什么这么慢还没有给我回复」。

**证据**：台账 21:54:49 / 21:55:37 / 21:56:30 / 21:57:27 每隔约 50s 一次调用（精读卡）；`literature_pipeline.ts` 的 `note()` 只调 `this.record(...)`（执行日志），`createProgressEmitter` 没有「任务内阶段」的方法，SSE 上从「执行中 1/N」到任务结束之间零事件。

**修改方向（已做）**：`ProgressEmitter.taskNote(message)`——计数不变、只换文案；skill 分支的 `note` 同时进执行日志与 progress。

<a id="u50"></a>
## U50 · 精读/综述的模型跟着聊天选择器走，没读 `subAgentModel_literature`

**现场**：同上。用户问「通篇精读卡为什么要用 moonshotai/kimi-k2.6？在哪设置的？」

**证据**：`config get defaultModel` = `z-ai/glm-5.3-flash`、`subAgentModel_literature` = `deepseek-v4-flash`，本会话精读却全是 kimi——来自网页端聊天框旁的模型选择器（请求 `model` 字段 → `sessionModel`），而 `runLiteraturePipeline` 未给 `ReadingCardGenerator` / `ReviewDraftGenerator` 传 `model`，全部走 `llmFor(sessionId)` 的会话覆盖。配置里专门给文献子代理留的模型项从未被这条路读到（AD-17 形状）。

**修改方向（已做）**：pipeline 接受 `model`；编排层按「会话覆盖 > `subAgentModel_literature` > 默认模型」选。选择器仍能整体覆盖——用户明确选了就尊重。


<a id="u51"></a>
## U51 · OA 全文命中率低：落地页不再解析一跳，`pdfUrl` 失败后无 DOI 兜底

**现场**：2026-09-15 用户问「这次任务下载了多少 pdf 全文」「是没有找到 doi 或 oa 链接就开始下载了吗」。

**证据**（`workspaces/web_1789480157513/t1-lit-review-rsi.json` 的 `downloads`，与 `library.db` 对照）：8 篇全部 `is_open_access=1`、全部有 DOI 与 `pdf_url`；成功 2；`not_a_pdf` 3（handle.net / journals.aom.org / iopscience 的文章页）；`http_403` 2（BMJ、ScienceDirect）；`network_error` 1（arxiv.org/pdf，限流）。精读卡 8 张中仅 2 张基于全文。

**问题**：下载器只吃三类候选（arXiv id、PMCID、`pdfUrl`），拿到 HTML 就判 `not_a_pdf` 放弃；而 `not_a_pdf` 的三篇至少两篇真有 OA 全文，只是链接停在落地页。精读档的价值完全取决于全文命中率。

**修改方向**：① 落地页解析一跳：响应是 HTML 时找 `citation_pdf_url` / `<link rel="alternate" type="application/pdf">`；② `pdfUrl` 失败后按 DOI 查 Unpaywall（免 key，需 email）取 `best_oa_location`；③ OA 标记来自 OpenAlex 时在结果里标「乐观」。技能文档 `paper-download/SKILL.md` 已补「下载前必须满足什么」「真实批次命中率」「目前不做的两跳」三节。


<a id="u52"></a>
## U52 · 右侧详情打开后没有路回总览

**现场**：2026-09-15 用户原话「选择一篇文献打开后，就没办法关掉回到总览界面」。

**证据**：`right.tsx` 时间线条目 `onClick={() => ws.selectRecord(ws.selectedRecord() === record.id ? null : record.id)}`（再点同一条才取消），`RecordDetail` 头部没有任何关闭控件；列表滚走后详情区就成了单行道。

**修改方向（已做）**：`RecordDetail` 头部加 `← 返回总览`（`ws.selectRecord(null)`），`data-testid="record-detail-close"`。

<a id="u53"></a>
## U53 · 产物链接不在聊天框里

**现场**：同上，「生成的结果的链接也要放到 chat 对话框里有显示」。

**证据**：`result` 事件只有 `response` 文本；`server/types.ts` 的 `ChatResponse.artifacts?: unknown[]` 声明了但**没有任何代码填它**（AD-17 形状）；文献流程的综述 `artifactId` 只在 digest 里当纯文字。

**修改方向（已做）**：`ExecutionOutcome.artifacts[]` → `OrchestrationResult.artifacts[]` → `chat()` → SSE `result.artifacts[]`；前端消息渲染成「📄 综述草稿」按钮，点了切到产物视图。类型收成 `Array<{id,label}>` 并重生成契约。


<a id="p1"></a>
## P1 · 三道防线的盲区恰好在同一处重合

**问题**：上面十条里，有八条是三道现有防线（OpenScience 对比、AD-12 能力门禁、
零上下文验收）**都没有抓到**的。不是哪一道失职，是三道的盲区叠在了一起。

### 证据一 · 对比是在能力层做的，没有界面这个维度

`~/Desktop/AI4S/science_agent/ClaudeScience_vs_OpenScience_架构与功能对比.md`，
全文 150 行，九节：基本盘 / 能力格局 / Agent 调度 / 审查体系 / 运行时隔离 /
模型接入 / 工具链坑 / 选型建议 / 未验证待办。

搜「UI / 界面 / 工作台 / 设置 / 配置面 / 前端」——**零命中**。

所以 U6「网页端没有设置入口」那次对比根本没有机会发现：它的视野里没有这个维度。

### 证据二 · 对比能问「有没有」，不能问「通不通」

第六节关于 OpenScience 只写了一句：

> OpenScience 模型中立，任意 provider 可换。

这一句后来成了 Spark Research 的目标，写进 P11。v0.4 实装「provider 2→6 + 本地端点」，
**勾打上了**。

而 U5 和 U10 说的是这个勾不算数：路由结尾有个无条件 `return "kimi"` 把认不出的模型
静默当 Kimi；`chat()` 的 `model` 参数声明了、传进来了、**函数体里从没读过**。

按「有没有这个能力」的标准，Spark Research 现在有 6 个 provider、有模型覆盖参数，
**完全达标**。对比这个方法，结构上就问不出第二个问题。

### 证据三 · 六轮验收一次都没走过配置路径

```
$ grep -rilE "config set|换模型|切换模型|--model|defaultModel" docs/taskbooks/
（零命中）
```

四份任务书全是研究课题：蛋白结构预测、单细胞聚类、脑机接口解码、钙钛矿稳定性。
验收执行者被要求做研究，不会中途去改配置。

而 U10 只有在「试着换个模型」的时候才暴露。**没人试过，所以没人发现。**

### 十条对三道防线的可见性

| 可见性 | 条目 | 原因 |
|---|---|---|
| 对比能发现 | U6 · U9 | 真的是功能面缺失，只要对比时看了那个维度 |
| 对比看不见 | U5 · U10 · U1 · U4 · U7 | **东西都在，只是没接上线**。类型定义在、参数签名在、事件在、套件在 |
| 对比无从谈起 | U2 · U3 · U8 | 不是功能，是系统运行两天之后才长出来的东西 |

U1 最典型：`LlmErrorKind` 七个取值定义得一应俱全，任何静态检查都会说这块做完了。
它只是**没被写进台账**。

### 根因

三道防线各有盲区，而这些问题恰好落在三个盲区的交集里：

- **对比**：看能力，不看接线。
- **AD-12 能力门禁**：核的是「在不在注册表」，核不了「函数体里读没读」。
  这与 V34「能力做好了、默认值没跟上」是同一个形状，只是深了一层——
  V34 是注册表与默认集不一致，U10 是签名与实现不一致。
- **零上下文验收**：能看接线，这一类它抓到过好几次（V34、`lit add 9999` 导入无关论文、
  编译器把硫酸写成盐酸）。但它只走研究路径，**不走配置路径**。

CHANGELOG 里「建好了但没有生产调用方」这个形态被记过至少四次
（`defaultProvider` 只写不读 · 外部 MCP 整条流程不存在 · `broker.recover()` ·
`runResearchLoop()`）。**项目已经诊断出这个病，也建了药，药只是够不着这个位置。**

### 修改方向

**再加一轮对比是没用的**——对比抓不到这一类。要堵的话加两样：

1. **验收任务书增加一份「配置与运维」课题**，与四份研究课题并列。
   内容就是普通用户真会做的事：换模型、改检索源、配一个 connector 凭据、
   重启服务、跑一轮然后核对用量台账对不对得上。
   本次十条里至少 U1 U2 U3 U5 U9 U10 六条会被这一份课题撞出来。

2. **门禁写成能抓整类的形式，而不是抓这一个。**
   U10 的建议写法是：**传一个已登记但当前 provider 无 key 的模型，断言调用必须失败。**
   这条断言只有在覆盖真正生效时才通过，静默忽略必然被抓。
   同一个套路可以复制到任何「参数声明了就要能生效」的地方——
   这才是对 AD-12 的正确补强：从「声称的能力存在吗」推进到「声称的能力接线了吗」。

**不建议**：为此再引入一份对比文档或再做一次上游源码走读。
病根不在信息不足，在检验方式与缺陷形态不匹配。

---

## 模板

往上面加新条目时照抄这一段：

```markdown
<a id="u<n>"></a>
## U<n> · <一句话标题>

**现场**：什么时候、在哪个界面/命令、做什么的时候撞到的。

**证据**：

<命令输出 / 日志片段 / 源码行号，原样粘贴，不要转述>

**问题**：这件事为什么不对。

**修改方向**：改哪里、影响面多大、有没有风险。
没想好就写「没想好」，比编一个方案强。
需要先做设计裁定的，明确标出来并列出待回答的问题。

**待核实**（可选）：不确定是不是缺陷时，写清楚要核实什么、怎么核实。
核实完改写本条，并把最初的错误猜测留痕。
```
