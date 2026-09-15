# W10 lane γ · 文献质量与配置面

分支 `feat/W10-gamma`（基于 `integration/v0.10-base`）· worktree `~/Desktop/AI4S/spark-research-gamma`
时间盒 3 小时 · 2026-09-16

执行顺序按任务书：γ-4 盘点表 → γ-2 → γ-1 → γ-3 → 按盘点表再接 3 个技能。

---

## 与 lane α 的交叉点（先说这个）

两边都在改 `literature/search.ts` 与 `agents/literature_pipeline.ts`。γ 动过的函数，逐个列清：

| 文件 | γ 改的函数/位置 | 改了什么 | α 可能也在动 |
|---|---|---|---|
| `literature/search.ts` | `LiteratureSearcher.search()` 的 `Promise.all` 那一行 | 从 `sources.map(s => searchOne(s, query, perSource))` 改成 `sources.flatMap(s => prepared.queries.map(q => searchOne(s, q, perSource)))`。**并发形态本身没动**（仍是一个 `Promise.all`），只是任务数从 `|sources|` 变成 `|sources| × |queries|` | **是**（α-2 精读并行、α-1 预筛）——合的时候按「α 决定怎么并发，γ 决定并发几个任务」拼 |
| `literature/search.ts` | `LiteratureSearcher.search()` 返回值 | 新增 `prepared` 字段（可选）；`applyRank` 之后、`limit` 截断之前插了一次 `applyRelevanceFloor` | 可能（α-1 预筛也会插在这一段）。两者语义不冲突：γ 的是**字面**地板，α 的是**语义**预筛；顺序上 γ 的先跑更省 token |
| `literature/search.ts` | `LiteratureSearcher` 构造函数 | 新增 `options.translate` | 否 |
| `literature/search.ts` | `searchOne()` 里两处 `registry.call(source, "search", ...)` | 追加 `...extra`（`searchLanguageParams`） | 否 |
| `literature/search.ts` | 新增顶层函数 `mergeStatusesBySource` / `searchLanguageParams` | 新增，无冲突 | 否 |
| `agents/literature_pipeline.ts` | 生产 searcher 的构造 | 加 `translate: llmQueryTranslator(deps.llm, deps.model)` | 可能（α 改 `cooldownOn429` 同一个对象字面量） |
| `agents/literature_pipeline.ts` | ④ 精读段 `generateMany` 之前 | 加 `readable` 过滤（零摘要且无 PDF 不精读），`cards` 的 filter 从 `targets` 改成 `readable` | **是**（α-2 精读并行改的就是 `generateMany`）。γ 改的是**喂给它的清单**，α 改的是**它怎么跑**，函数体不重叠 |

γ **没有**碰：并发数、`maxTokens`、语义预筛、S10 全文命中率。

---

## γ-4 · 技能执行入口盘点表

产出：`docs/taskbooks/v0.10/SKILL_EXEC_INVENTORY.md`（13 行，逐个读 `backend/src/skills/*/SKILL.md`
的 frontmatter 加背后真实存在的程序化实现）。

结论：乙型（确定性管线已存在）6 个、甲型（需子 agent 多轮/状态机）5 个、
`wet-protocol` 本版明确不接（它的安全闸是**人类签名的审批 token**，接进 chat 的自动执行路径
等于开一条绕过审批的口子）。本轮接乙型里最现成的 3 个。

---

## γ-2 · 中文查询处理（V161 + U58）

### 实测前后对比（原文）

命令（任务书口径，两次完全一致）：

```
bun backend/src/index.ts lit search "重复性劳损 预防 办公人群" \
  --sources aminer,openalex,europepmc --limit 6 --project spark0915
```

**改之前**（本 worktree 基线复现，与 U58 记录一致）：

```
检索 "重复性劳损 预防 办公人群"：75 条原始结果 → 去重合并掉 1 条 → 剩 74 条（--limit 截断后展示 6 条）
 1. [Guideline for the prevention and treatment of hepatitis C (2022 version)].
 2. 中华人民共和国   （IMF Staff Country Reports）
 3. ChiMed-GPT: A Chinese Medical Large Language Model ...
 4. 白塞病的中西医治疗研究进展
 5. 新质生产力赋能体育科技创新的内在逻辑与实践路径研究
 6. Pathways to Water Sector Decarbonization, Carbon Capture and Utilization
```

**0/6 相关。**

**只加英译（中间态，如实记录：没达标）**：

```
中文查询：已抽取主题词并英译为「repetitive strain injury prevention office workers」，中英双查后合并
 1. 2023 Alzheimer's disease facts and figures                （被引 3226）
 2. [Guideline for the prevention and treatment of hepatitis C (2022 version)].
 3. Chronic pain: a review of its epidemiology ...             （被引 1747）
 4. 2016 European Guidelines on cardiovascular disease prevention in clinical practice （被引 6550）
 5. Telework and Worker Health and Well-Being: A Review ...    （被引 308）
 6. Trends in Workplace Wearable Technologies and Connected-Worker Solutions ...
```

约 2/6。**译文是对的，病灶在别处**：中英双查把池子从 75 撑到 165，而 blended 档按
「命中源数 × 被引 × 年份」排，**没有任何相关性信号**——被 `prevention` 一个通用词捞上来的
6550 被引心血管指南，稳稳压过真正对题但被引三位数的论文。

**加上译后相关性地板之后**：

```
检索 "重复性劳损 预防 办公人群"：165 条原始结果 → 去重合并掉 1 条 → 剩 164 条（--limit 截断后展示 6 条）
中文查询：已抽取主题词并英译为「repetitive strain injury prevention office workers」，中英双查后合并；
相关性地板：译文 6 个主题词里至少命中 2 个才留下，滤掉 125 条（中英双查把池子撑大，blended 排序本身没有相关性信号）

 1. Telework and Worker Health and Well-Being: A Review and Recommendations for Research and Practice (2022)
 2. Low back pain and its relationship with sitting behaviour among sedentary office workers (2019, Applied Ergonomics)
 3. Musculoskeletal Disorders, Workplace Ergonomics and Injury Prevention (2023)
 4. Ergonomic interventions for preventing work-related musculoskeletal disorders of the upper limb and neck among office workers (2018, Cochrane)
 5. Effects of stretching exercise training and ergonomic modifications on musculoskeletal discomforts of office workers: RCT (2017)
 6. Effectiveness of workplace interventions in the prevention of upper extremity musculoskeletal disorders and symptoms (2015)
```

**6/6 相关**（目标 ≥4/6）。第 4 条还是 Cochrane 系统综述，正是这个问题该拿到的头号证据。

### 落地内容

1. 新文件 `literature/prepare_query.ts`：`prepareQuery` + LLM 英译器（一次 ≤200 token）
   + 词典兜底 + 译文清洗 + 译后相关性地板。
2. `searchLanguage` 配置项（`config/index.ts`）：OpenAlex `filter=language:<两字母码>`。
   **只对 OpenAlex 生效**——三个中文可用源里只有它真有这个过滤维度，给别的源编一个
   等价物只会让「已按语言过滤」这句话在那些源上是假的。
3. 零摘要不精读（`literature_pipeline.ts`）：`abstract === null` 且没拿到 PDF 的论文跳过精读。
   只凭标题生成的卡一旦入库就带 record 身份、会被综述引用——比少一张卡糟得多。

### 拿不准 / 没做的

- **T3 课题复跑（≥2/8）没跑**。时间盒内优先保了 U58 这条有精确现场的。
- 词典兜底**不是中英词典**，只收了本项目真实用过的主题词（U58 现场 + 四份验收任务书 + 高频研究词）。
  覆盖不到的词如实标 `untranslated`，不做静默半译。
- 相关性地板是**字面**判据（词干 + ≤3 字母后缀）。语义级预筛归 α-1；两者叠加时
  γ 的先跑更省 token，但**没有实测过叠加效果**。

---

## γ-1 · 凭据 ↔ 检索源三态（V173 / U43）

新文件 `literature/source_state.ts`：「勾没勾」×「有没有凭据」= 「本次会不会真查」。
这个合取此前**没有任何地方算过**，所以 U43 的两条输出各说各的，合起来那件事谁都看不见。

三个出口共用这一份（文案与下一步都只有一份）：

| 出口 | 变化 |
|---|---|
| `GET /api/settings/scientific-tools` | `searchSources.extra.options[]` 每条补 `selected` / `participation` / `participationLabel` / `participationNextStep`（前端渲染归 ε） |
| `PUT /api/settings/credentials/:id` | 写入成功后若该源是检索源且不在 `searchSources` → `item.nextStep = "去检索源面板勾选 <id>（或 config set searchSources ...）"`。非检索源（LLM provider）不套用 |
| `lit sources` | 每行多一行三态 + 下一步 |

实跑（`bun backend/src/index.ts lit sources`）：

```
  semanticscholar  凭据未配置   Semantic Scholar 学术图谱（需 API Key；凭据只在 daemon 内取用）
                   ⏭️  已勾选，但缺凭据 → 本次会被跳过
                   下一步: 在「凭据」面板直填，或在终端执行 `spark-research auth --connector semanticscholar`
  cnki             凭据未配置   中国知网（CNKI）文献数据库
                   ⏭️  未勾选 → 本次不查
```

---

## γ-3 · 上游 200-带错形状（V175）

逐源实探（2026-09-16，真实请求）。**原文**：

```
$ curl 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term='
HTTP 200
{"header":{"type":"esearch","version":"0.3"},"esearchresult":{"ERROR":"Empty term and query_key - nothing todo"}}

$ curl 'https://api.openalex.org/works?filter=nonsense_field:zz&mailto=...'
HTTP 400
{"error":"Invalid query parameters error.","message":"nonsense_field is not a valid field. Valid fields are ..."}

$ curl 'https://api.crossref.org/works?query=cancer&rows=notanumber'
HTTP 400
{"status":"failed","message-type":"validation-failure","message":[{"type":"integer-not-valid","value":"notanumber","message":"Integer specified as notanumber but must be a positive integer less than or equal to 1000. "}]}

$ curl 'https://api.semanticscholar.org/graph/v1/paper/search?query=&fields=title'
HTTP 429
{"message": "Too Many Requests. Please wait and try again or apply for a key for higher rate limits. https://www.semanticscholar.org/product/api#api-key-form", "code": "429"}

$ curl 'https://datacenter.aminer.cn/gateway/open_platform/api/paper/search?query=test'   # 不带凭据
HTTP 500
{"code":40308,"success":false,"msg":"Get Authorization Error","data":null,"log_id":"3JNHNRFf2tzPL59i0e3dMEzoFkg"}

$ curl 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=AUTH%3A&format=json'
HTTP 200   ← 语法怪也照回合法结果；U40 记录的错误形状是 {"version":"6.9"}（无 hitCount/resultList）

$ curl 'http://export.arxiv.org/api/query?id_list=9999.99999'
HTTP 000   ← 本机 IP 仍被 arXiv 封（与 W10-0 基线同一现象），**未能实探**
```

最要命的两条：**crossref 与 semanticscholar 的错误体里都有 `message` 这个键，
而 `message` 正在 `SEARCH_RESULT_KEYS` 里**——和 U45 里 `esearchresult` 被当成合法空结果
放行是**同一个形状**，只是换了个源。aminer 是我们唯一持凭据的源，它的错误键
（`code`/`success`/`msg`）与通用三键一个都不重合。

`upstreamErrorOf(connector, payload)` 改成按 connector 的显式表，每源一条规则；
表里没有的源退回通用三键（= v0.9.1 行为，不给没实探过的源凭空加判据）。
arXiv 是 Atom **字符串**，判据单列在「非对象响应」分支之前——既有那条判据逐字未改
（`searchPayloadProblem("arxiv", "<xml/>")` 仍返回「非对象」，ux_window 的钉子不动）。

**如实交代**：arXiv 那条是按 API 手册的错误信封写的，**没有当场抓到的真实响应**。
代码注释与门禁名里都标了。

---

## γ-4 后半 · 再接 3 个技能

新文件 `agents/skill_runners.ts`：`SKILL_RUNNERS` 注册表 + `runSkill(name, ctx, params)`。
表里没有的技能返回 `handled: false`，编排层照旧退回「加载说明书」——**没接的 10 个技能
行为逐字节不变**。

- `paper-download` → `PdfDownloader`。给了 `paperIds` 就下这几篇；没给就下库里还没有 PDF 的前 8 篇。
- `research-report` → `reportFor` + `buildReport`（零 LLM 调用），落 artifact 回一个可回链 id。
- `novelty-check` → `NoveltyChecker`。**前置是一张真 Idea 卡**；思路库为空时拒绝执行并说清
  「检索不到 ≠ 新颖」，不许编一张卡去查。

### 收口 diff（`agents/orchestrator.ts`，收口专属，7 行）

在 `case "skill"` 里，`if (litMode && project) { ... }` 那一整块**之后**、
`this.record(sessionId, "skill", name, "context loaded")` **之前**插入：

```ts
          // V172 后半（γ-4）：注册表里的技能真执行；表里没有的照旧只加载上下文。
          const skillProject = project ?? this.projectForSession(sessionId);
          if (skillProject) {
            const ran = await runSkill(name, {
              llm: this.llmFor(sessionId),
              model: this.sessionModel.get(sessionId) ?? configuredSubAgentModel("literature", configuredModel(LLMRouter.DEFAULT_MODEL)),
              project: skillProject,
              sessionId,
              note: (m) => { this.record(sessionId, "skill", name, m); progress?.taskNote(m); },
            }, (task.params ?? {}) as Record<string, unknown>);
            if (ran.handled) {
              return { taskId: task.id, kind: task.kind, ok: ran.ok ?? false, output: ran.digest ?? "", ...(ran.artifacts?.length ? { artifacts: ran.artifacts } : {}) };
            }
          }
```

外加一行 import：`import { runSkill } from "./skill_runners";`

注意 `const project = litMode ? this.projectForSession(sessionId) : null;` 这一行现在
只对文献技能求值，所以上面重新取了一次 `skillProject`。收口时也可以直接把那行的
`litMode ?` 条件去掉，两种都行——**去条件那种更干净，但会让 `projectForSession` 对
所有技能都求值一次**，请收口的人自己定。

配套门禁：`tests/unit/w10_gamma_skill_runners.test.ts`（8 条），其中
「表里没有的技能 handled=false」那条钉的就是「接一个技能不许把别的弄坏」。

---

## 门禁与阴性对照

| 文件 | 条数 |
|---|---:|
| `tests/unit/w10_gamma_query.test.ts`（γ-2） | 25 |
| `tests/unit/w10_gamma_sources.test.ts`（γ-1） | 12 |
| `tests/unit/w10_gamma_upstream_errors.test.ts`（γ-3） | 8 |
| `tests/unit/w10_gamma_skill_runners.test.ts`（γ-4） | 8 |
| **合计** | **53** |

阴性对照（每条先 commit 再做，`git checkout` 复原）：

| # | 改成什么 | 结果 |
|---|---|---|
| ① | `prepareQuery` 不读 `options.translate`（处理层写了但没接线） | 2 红：「中英双查」+「同一个源被查两次」 |
| ② | `search.ts` 不调 `applyRelevanceFloor` | 1 红：「地板在 limit 截断之前生效」 |
| ③ | 零摘要照读（`readable` 恒真） | 1 红：「被跳过的标题一次都没进过 prompt」 |
| ④ | `searchLanguageParams` 恒不读配置 | 1 红：「配了 zh 时带上 filter=language:zh」 |
| ⑤ | 面板不算三态（`selected` 恒 false、不铺 `...state`） | 2 红：面板两条接线断言 |
| ⑥ | 凭据写入不给 `nextStep` | 1 红：「写 aminer 的 key → 去检索源面板勾选」 |
| ⑦ | `upstreamErrorOf` 退回 U45 的通用三键（显式表作废） | 4 红：openalex / crossref / semanticscholar / aminer |
| ⑧ | arXiv 字符串判据不接线（`arxiv` 恒 null） | 1 红：「arxiv · Atom 错误信封」 |

### 自己踩的坑（写下来，比结论有用）

⑦⑧ 第一次做的时候，两条都以 `git checkout -- backend/src/connectors/base.ts` 收尾，
而**那时 γ-3 的源码改动还没 commit**——于是被一并还原。紧接着那个叫「γ-3」的 commit 里
只有测试文件，没有实现。

为什么没当场发现：还原发生在 `bun test` 之后，那一刻是绿的；`git status` 只剩一行
`?? tests/...`（源码不再是 modified），我把它读成「干净」，其实那正是改动没了的信号。
最后是 `npx tsc --noEmit` 报 `upstreamErrorOf 未导出` 才抓出来。

这正是 `_COMMON` §纪律 2「**先 commit 再做阴性对照**」要防的事，本地窗口踩过一次，
这里又踩了一次。补充一条可操作的：**阴性对照复原之后，跑一次 `tsc --noEmit` 再跑测试**——
`bun test` 剥掉类型，认不出「函数没了」这种形状；上面 ⑦⑧ 已按这条重做，结果如表。

回归（一次只跑一个套件）：`v172_literature_pipeline` 10✅ · `literature` 84✅ ·
`config` + `config_search_sources` 50✅ · `settings_credentials` 19✅ ·
`literature_cli_usability` 20✅ · `server_literature` 18✅ · `ux_window` 29✅。

## 没做完的

- T3 课题复跑（≥2/8）未做。
- 相关性地板与 α-1 语义预筛的叠加效果未实测。
- arXiv 的 200-带错形状未能实探（IP 被封）。
- `searchLanguage` 只在单测里验过，**没有在真实 OpenAlex 请求上跑过 `filter=language:zh`**。
- γ-3 的实现有过一次「被自己的阴性对照冲掉」的事故（见上），已修并复跑；
  但这说明本 lane 的 commit 粒度还不够细——源码与门禁应当同一个 commit 落，
  而不是「写源码 → 写门禁 → 做对照 → 一起 commit」。
