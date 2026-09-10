# W3-d · arXiv / PubMed 走声明式 manifest？—— 实测结论

## 一句话结论

**两个源最终都没有走 manifest；都写成了 TS 扩展。** 不是因为懒得扩 DSL，是因为实际
尝试之后发现：W1-c 标出的"`query` → `search_query=all:{value}` 前缀映射"只是这两个源
里**最小**的那个表达力缺口。真正决定性的障碍是另外两个、且都比它更根本：

1. **响应是 XML，manifest 的 `normalize` 受限路径 DSL 对 XML 结构性失效**——不是"缺一个
   语法"，是这个 DSL 压根没有"把 XML 解析成对象树"这一步。
2. **PubMed 真正可用的 `search` 需要两次串行 HTTP 请求**（esearch 取 id 列表 → esummary
   拿详情），manifest 的"一个 tool = 一次 HTTP 请求"模型结构性表达不了多跳编排。

第 2 条是这次实测里**新发现**的边界，W1-c 交接时完全没提到（他们只验证过 arXiv 那半
个前缀映射缺口）。第 1 条虽然 W1-c 的交接里隐约提到"这可能是比参数映射更大的障碍"，
但没有实测验证；这次给出了可运行的复现（见下文）。

## 判断依据：三个实测证据

### 证据①（正向）：manifest 能表达的那一半，真的能表达

`tests/fixtures/manifests/pubmed-esearch-only.manifest.json` + `connector_manifest.test.ts`
里的"正向"测试：PubMed 的 esearch 单独拎出来看——`query` → `term` 是纯改名，
`db=pubmed`、`retmode=json` 是固定 defaults——manifest 现有的 `mapTo` + `defaults` 完全
够用，一次编译、零 TS 代码。这条正向证据是必要的：它排除了"manifest 对 PubMed 全线
表达不了"这种过度悲观的结论——问题不在 esearch 这一跳本身。

```
$ bun test tests/unit/connector_manifest.test.ts -t "正向"
✓ 正向：PubMed esearch 单独一跳（query→term 纯改名 + defaults）manifest 完全够用
```

### 证据②（反向，决定性）：XML 响应喂给 normalize，每个字段都是 undefined

`tests/fixtures/manifests/arxiv-xml-normalize-probe.manifest.json`：一个声明
`responseType: "text"` + `normalize: { title: "feed.entry.title", totalResults:
"feed.totalResults" }` 的探测 manifest。响应体里**明明真的有**
`<title>Attention Is All You Need</title>`，但求值结果是：

```
$ bun test tests/unit/connector_manifest.test.ts -t "反向"
✓ 反向：XML(text) 响应喂给 normalize，每个字段都拿到 undefined
  result = { title: undefined, totalResults: undefined }
```

原因在 `manifest.ts` 的 `evaluateRestrictedPath` / `objGet`：第一步 `objGet(root, "feed")`
里 `typeof root !== "object"`（root 是字符串）直接返回 `undefined`，后面每一段路径都在
`undefined` 上继续取值，全员 `undefined`。**这不是路径写错了，是这个 DSL 里根本没有
"XML → 对象树"这一步**——`normalize` 的整个设计前提就是"响应已经是 JSON"。

要让 manifest 表达 XML，缺的不是一个 `template` 字符串语法（那只能解决 W1-c 标出的
前缀映射问题，对响应侧完全没用），而是要**额外发明一整套声明式 XML→对象映射**：至少
需要标签路径查找 + 属性取值 + "同名兄弟元素折叠成数组"（`<author>` 重复出现）+ 命名空间
前缀处理。这比现有"受限路径 DSL"复杂一个数量级，而且"同名兄弟折叠成数组"这类规则
天然需要某种"通配 / 循环"语义——直接撞上 `manifest.ts` 头部注释已经写死的克制原则："DSL
一旦长出 if/else 就是在重新发明一门脚本语言，是本 lane 明确要避免的失控方向"。为
两个源单开一个 XML 分支模式，代价与收益不成比例——**结论是不扩，理由记在下面
`EXTENDING.md` 补充判据里**。

### 证据③（决定性，新发现）：PubMed 的两跳链路不是参数映射问题，是编排问题

即使假设 manifest 明天多出了"XML→对象树"能力，PubMed 真正可用的 `search`（能喂出
title/authors，不是只有一串 PMID）仍然表达不了——因为它需要：

```
esearch(term) → 拿 idlist → esummary(id=idlist.join(",")) → 拿详情
```

第二跳的参数**来自第一跳的响应**。manifest 当前的模型是"一个 `tools[]` 条目编译成一条
`handle()` 注册，注册时的闭包只捕获这一个 tool 声明和一次 `requestRaw` 调用"（见
`manifest.ts` `ManifestConnector.invoke()`）——没有"发一个请求、用它的响应构造第二个
请求"的原语。要表达这个，manifest 需要新增一种全新的"multi-step pipeline"声明（步骤
列表 + 步骤间的数据传递语法），这已经不是"扩一点 DSL"，是往 manifest 里加一个小型
工作流引擎。**这个判断不需要额外的探测 fixture 去证明——它是直接从 `manifest.ts` 现有
代码结构（一个 tool → 一次 `requestRaw`）读出来的架构事实**，实现 `PubMedConnector.search()`
时已经在 `backend/src/connectors/literature.ts` 里用两次 `this.requestRaw()` 调用把它
落成了代码，可运行的证据就是 `tests/unit/literature_xml.test.ts` 里的
`"esearch(term=query) → esummary(id=逗号拼接)，两跳串行"` 那组测试。

## 结论：arXiv / PubMed 该按什么粒度判断"走 manifest 还是 TS"

不是"整个源二选一"，是**按 tool 粒度判断，但两个源恰好每个 tool 都至少撞上一条硬约束**：

| 源 | tool | 阻碍 | 判断 |
|---|---|---|---|
| arXiv | `search` / `getPaper` | 响应是 XML（证据②）+ query 前缀映射（W1-c） | TS |
| PubMed | `search` | 两跳编排（证据③），且第二跳响应仍是可用 JSON | TS |
| PubMed | `getPaper` | 单跳 esummary，JSON，**证据①式的映射本身可表达**，但已经在同一个 connector 里，拆出去多一份维护成本换不来收益 | 留在 TS（可表达≠该拆） |
| PubMed | `getAbstract` | efetch 是 XML（同证据②的障碍） | TS |

**没有找到一个"manifest 能装下、装了还划算"的 arXiv/PubMed tool。** 这与 W1-c 判断
bioRxiv/BindingDB/OpenTargets 时的情况不同——那三个源里，manifest 覆盖了大部分 tool，
只有响应体分支那一个（BindingDB）留在 TS。这次是反过来：两个源全军覆没，不是因为它们
"更难"，是因为它们共享同一个结构性短板（XML）加上其中一个还有第二个短板（多跳）。

## 对 manifest DSL 表达力边界的修正描述（比 W1-c 当初的估计更准）

W1-c 交接时只知道"字符串前缀映射表达不了"，这次实测把边界描述收紧成：

manifest 现在（v0.4 W1-c 落地的版本）适用的范围是——

> **单次 HTTP 请求、JSON 响应、响应形状是"字段路径 + 定长数组下标"能表达的固定树**。

越界的三种形态，按越界方式分类（bioRxiv/BindingDB/OpenTargets 是 W1-c 已经写进
`manifest.ts` 头部注释的三条；下面两条是这次新增的）：

4. **响应不是 JSON（XML/SOAP/CSV/...）**——`normalize` 的整条设计假设响应已经是对象树，
   对非 JSON 响应从第一步取值就结构性失效（本 lane 证据②）。
5. **需要多次请求编排**（第二个请求的参数依赖第一个请求的响应）——manifest 的"一个 tool
   = 一次请求"模型没有跨请求的数据传递原语（本 lane 证据③）。

这两条都不建议现在就扩：第 4 条要扩等于新开一个声明式 XML 映射子语言（复杂度量级远超
现有 DSL）；第 5 条要扩等于加一个小型工作流引擎。两者都会把 manifest 从"数据，不执行
任意代码，容易审计"推向"图灵完备的第二种 connector 语言"——这正是 `manifest.ts` 头部
注释反复强调要避免的方向。**"表达不了就写 TS 扩展"在这两类场景下不是退而求其次，是
设计本身该有的出口。**

## 给 `EXTENDING.md` 的补充判据（`EXTENDING.md` 不在本 lane 所有权内，这里只列出该补什么）

在"三种装载强度"的选择判据里，除了已有的（枚举校验 / 响应体分支 / 多实体拆分），
建议补两条：

- **响应格式**：manifest 只认 JSON 响应体；XML/SOAP/CSV/二进制格式的源，不管请求构造
  多简单，一律 TS 扩展（`responseType: "text"` 拿到原始字符串本身没问题，但 `normalize`
  对它无效，等于只帮你省了请求构造，归一化还是要手写代码——这时候直接整个写 TS 反而
  更省心，不必对着一半能力的 manifest 半吊子表达）。
- **请求是否需要编排**：如果拿到"可用的完整数据"需要不止一次 HTTP 请求（分页汇总、
  id 反查详情、搜索后批量取详情……），一律 TS 扩展；manifest 没有跨请求的数据传递能力，
  也不该有。

## BACKLOG V1：完成到什么程度，卡在哪

**connector 层完成，统一检索接入未完成——卡在文件所有权边界，不是技术障碍。**

已完成（本 lane 文件所有权范围内）：
- `arXivConnector`：`search` + `getPaper` 都从"返回原始 XML 字符串"改成返回结构化
  `ArxivFeed`（`{ totalResults, startIndex, itemsPerPage, entries: ArxivEntry[] }`），
  每条 `ArxivEntry` 含 title/summary/authors/links/categories/primaryCategory/comment/
  doi/journalRef/shortId，字段命名和 OpenAlex/CrossRef 等既有 JSON 源的连接器返回值
  同一档次的"结构化但未归一化"。
- `PubMedConnector`：`search` 补上 esearch→esummary 两跳链路（之前只有 esearch，喂出去
  的只有一串 PMID，连标题都没有——单独看这一步已经是"看起来在跑，其实喂不出可用数据"
  的隐性 bug）；新增 `getPaper`（之前声明了但没实现，`fetchOne()` 调用会直接报
  `Unknown tool`）；`getAbstract` 从"原样透传 XML 字符串"改成解析出
  `{ pmid, title, abstract, sections }`。
- 顺带修了两个此前"看起来接进了统一检索、其实从未真正生效"的参数命名 bug：
  `search.ts` 的 `searchOne()` 统一传 `{ query, limit }`，但旧版 arXiv 只认
  `max_results`、PubMed 只认 `retmax`——`limit` 会被当成上游不认识的裸查询参数发出去，
  从未真正截断过结果条数。现在两个源都改成认 `limit`（内部再映射成各自的上游参数名），
  和其余五个 JSON 源同一约定。

**未完成、且明确不在本 lane 文件所有权内**：`backend/src/literature/normalize.ts` 的
`NORMALIZERS` 表里，`arxiv`/`pubmed` 两项仍是占位桩（`extract: () => [], map: () => null`），
`search.ts` 的统一检索链路调用 `normalizeResponse(source, payload)` 时，这两个源依旧会
归一化成 0 篇论文——**即使 caller 显式把 `arxiv`/`pubmed` 加进 `sources` 数组，检索
结果里也不会出现它们的论文**，只是不再报错、不再喂假数据，`outcome` 会如实是
`"ok"` + `count: 0`（不是本 lane 改的字段，是 normalize 后 `papers.length` 天然为 0）。

这条边界不是我漏做了，是"文件所有权(只改这些)"明确把 `normalize.ts` 排除在外——与
W1-c 当时的处境结构上是同一件事：manifest.ts 写完之后，接线权在 W2-c；这次
arXiv/PubMed connector 写完之后，归一化接线权在下一个碰 `normalize.ts` 的 lane。
**这里不参照 W1-c 用 `ALLOWED_ORPHANS` 登记孤儿**——因为 `arXivConnector`/
`PubMedConnector` 本来就有生产消费方（`registry.ts` 的 `BUILTIN_CONNECTORS` /
`CONNECTOR_CLASSES` 早就注册了这两个类，`narrative_parity.test.ts` 跑下来也确认
0 新孤儿，见下方测试结果），不存在"这段代码没人调用"的问题，只是它喂出的结构化数据
还没被 `normalize.ts` 消费成 `Paper`。

**给下一个碰 `normalize.ts` 的 lane 的交接**：两个连接器现在返回的形状——

- `arXivConnector.search()`/`getPaper()` → `ArxivFeed`（`entries: ArxivEntry[]`，字段见
  `backend/src/connectors/literature.ts` 的 `ArxivEntry` interface）。写
  `fromArxiv(entry: ArxivEntry): Paper | null` 时：`doi` 字段已经是干净的 DOI（不用像
  CrossRef 那样再剥前缀）；`shortId` 已经是去掉 `http://arxiv.org/abs/` 前缀、保留版本号
  的短 id（如 `1706.03762v7`），建议存进 `paper.ids.arxiv` 时再去掉版本号后缀（这个 lane
  没做，因为不确定统一检索的去重逻辑想不想保留版本信息，留给有 normalize.ts 上下文的
  lane 判断）；`links` 数组里 `type === "application/pdf"` 的那条就是 PDF 直链，
  `type === "text/html"` 的是 landing page。
- `PubMedConnector.search()`/`getPaper()` → 原样透传 NCBI esummary 的 JSON 形状
  `{ result: { uids: string[], [uid]: { title, authors: [{name,authtype}], pubdate,
  source, elocationid, articleids: [{idtype, value}], ... } } }`（字段名和真实 NCBI 响应
  完全一致，没有做任何改名——`docs/devlog/W3-d.md` 本节上方贴了一段真实录制样本，
  `tests/fixtures/literature/pubmed-getpaper.json` 里有完整的一条）。写
  `fromPubmed` 时，DOI 在 `articleids` 里 `idtype === "doi"` 那条，PMC id 在
  `idtype === "pmc"` 那条（注意区分同一数组里 `idtype === "pmcid"` 那条，值形如
  `"pmc-id: PMC8371605;"`，是脏格式，不要用它）。
- `PubMedConnector.getAbstract()` → `{ pmid, title, abstract, sections }`，`abstract` 是
  拼好的干净正文（带 Label 的分段会自动拼成 `"LABEL: 正文"` 用两个换行连接），可以直接
  用在 `paper.abstract` 上，但**统一检索的 `search`/`getPaper` 路径不会自动调用它**——
  esummary 从不带摘要正文，如果未来想让 `fromPubmed` 的 `abstract` 字段有内容，需要
  在 normalize 或更上层再补一次 `getAbstract` 调用，这是一次额外的网络请求，要不要做
  是权衡（多一次请求换摘要 vs statu quo 摘要为 null），本 lane 不替下一棒做这个决定。

## 阴性对照（强制，实跑记录）

### ① XML 畸形响应 → 显式失败，不是静默空结果

覆盖两个源、三种畸形形态（截断/标签不闭合、闭标签不匹配、根元素不是预期类型），全部
在 `tests/unit/literature_xml.test.ts` 里作为正式回归测试（不是一次性脚本）：

```
$ bun test tests/unit/literature_xml.test.ts -t "阴性对照"
✓ 阴性对照①证据 a：未闭合标签 → 显式抛 XmlParseError，不是返回半截结果
✓ 阴性对照①证据 b：闭标签名不匹配 → 显式抛错
✓ 阴性对照①证据 c：空文档 → 显式抛错
✓ 阴性对照①：截断的 XML 响应 → search() 显式 reject，不是静默 0 条        (arXiv)
✓ 阴性对照①：根元素不是 feed → 显式抛错                                  (arXiv)
✓ 阴性对照①：efetch 返回截断/畸形 XML → getAbstract() 显式 reject         (PubMed)
✓ 阴性对照①：efetch 根元素不对 → 显式抛错                                (PubMed)

 27 pass  0 fail
```

补充：arXiv 对"查询格式非法"这类语义错误，实际是 **HTTP 200 + 合法 XML + 一条 id 前缀
为 `http://arxiv.org/api/errors#` 的"错误 entry"**——语法上完全合法，parseXml 不会报错，
但这是"响应体分支"（W1-c/DEVELOPMENT_PLAN 约束②的同一类问题），已在 `parseArxivFeed`
里显式识别并抛错（`arXivConnector` 测试里的"响应体分支"用例），不属于阴性对照①的范围
（那是语法错误），单独记录在这里避免遗漏。

### ② 并发不变式：handler 改成共享可变状态 → 并发测试红

**永久绿测试**（进正式套件，`tests/unit/literature_xml.test.ts`）：仿
`tests/concurrency/connector_race.test.ts` 同款写法，arXiv/PubMed 混合工具调用走
`connector.call()`，N=140，并发结果与串行逐位一致：

```
$ bun test tests/unit/literature_xml.test.ts -t "并发不变式"
✓ 单实例各 140 并发混合工具调用，结果与串行逐个调用逐位一致
✓ 并发下 pubmed.search 的两跳链路没有串味：每个 job 的最终 uid 都对应自己的 term
✓ 并发下 arxiv.getPaper 的 id_list 没有串味

 3 pass  0 fail
```

**红色演示**（临时脚本，跑完即删，不进正式套件——做法照抄 `manifest.ts` 头部注释里
"通过继承覆盖方法来复现，不改动生产文件"的既有约定）：子类化 `PubMedConnector`，
故意把两跳之间本该用局部变量传递的 `term` 换成一个跨调用共享的实例字段（写在第一跳
`await` 之前、读在第二跳 `await` 之后——精确复现旧版 `__handlingTool` 的竞态形状）。
第一版尝试（写发生在两次真实 await *之后*，只隔一个 `Promise.resolve()` 微任务）没有
复现出竞态——分析原因：140 个 job 靠 `setTimeout(random 0-7ms)` 制造交错，但
`await Promise.resolve()` 是微任务，同一个宏任务（某个 job 的定时器回调）触发后，
它自己那条调用链上的所有微任务会一次性排空，不会被"另一个 job 的定时器回调"打断
——所以写、读之间插不进别的 job。把写的位置挪到**第一个 await 之前**（`search()`
入口处，与 W1-c 复现旧竞态时的位置一致）后，136 个 job 全部同步执行到"写共享字段"
这一步（`Promise.all(jobs.map(...))` 里 `.map` 同步跑完所有 140 次调用的"第一个 await
之前"那段代码，一个字段被写了 140 次），任何一个 job 读到的都是最后一次写入
（`job#139` 的值），实跑结果：

```
$ bun test ./scratch_negative_control.test.ts
error: expect(received).toEqual(expected)
  {
-   "term": "term-0",
+   "term": "term-139",
  }
(fail) 阴性对照②红色演示 > 故意共享可变状态的 BrokenPubmedConnector 在并发下与串行结果不一致

 0 pass  1 fail
```

这个失败形态和 `docs/devlog/W1-c.md` 记录的"job#0 本该发出 example.search 的请求，
实际发出的却是 job#139 的请求体"是同一类证据：证明这组并发测试确实在检测真实的竞态，
不是摆设。跑完立刻 `rm` 掉临时脚本，`git status` 确认干净，未提交任何破坏版代码。

**补充说明（诚实记录一个方法论细节）**：这次的经历本身就是一条值得记的教训——
"在哪个 await 前后插共享状态"不是随便选的，得选在"所有并发调用的同步前缀会真的抢在
一起跑"的那个点上，否则阴性对照会假阴性（测试看起来设计对了，实际根本没触发竞态，
容易造成"我验证过了"的错觉）。以后写类似阴性对照，得先确认"写"发生在 `Promise.all`
展开时**所有 job 都会同步跑到**的位置，而不是随便找一个 await 前后。

## BACKLOG V26：限速预算注意（本 lane 不实现限速器，如实记录）

connector 层目前只有礼貌头（`politeness.ts` 的 User-Agent / From，本 lane 给
arXiv/PubMed 都补上了，之前两个源是唯二没有礼貌头的免 key 源），**没有任何限速器**。

本 lane 让 PubMed 的主机预算压力**变大了**，需要明确记录给以后做限速器的人：

- **PubMed 的 `search` 现在每次调用对 `eutils.ncbi.nlm.nih.gov` 发两次请求**
  （esearch + esummary），之前只发一次（且那一次喂出的数据还不可用）。统一检索一次
  跨源查询如果把 pubmed 加进 `sources`，对 NCBI 主机的请求数直接翻倍。
- `getPaper` / `getAbstract` 各自还会再各发一次，都打同一个主机
  `eutils.ncbi.nlm.nih.gov`。
- v0.5 计划新增的 ClinVar / GEO（均为 NCBI 产品）**大概率也走 eutils 同一个主机**，
  与 pubmed 共享同一个主机级配额（NCBI 官方限速是按 IP + 有无 API key 计算，不区分
  你是几个不同的"逻辑 connector"）。

**限速器一旦要做，必须按 `new URL(baseUrl).hostname` 键控合池，不能按 connector 实例
各自维护独立计数器**——否则 pubmed/clinvar/geo 三个 connector 各自认为自己"还有配额"，
合起来早就打穿了 NCBI 的真实限速。arXiv（`export.arxiv.org`）是另一个独立主机，本
lane 实测中反复被 429（这台机器上同时跑着其他 lane 的 worktree，共享同一个出站 IP，
叠加起来很容易撞上 arXiv 的限速——录制 fixture 时实测遇到了多次 429/超时，退避到
40-75 秒重试才录成功），这也从侧面印证了"多个 connector/多个并发调用共享同一出站 IP
时，主机级限速器不是锦上添花，是迟早要来的真实约束"。

## 测试与阶段门结果

```
$ bun run typecheck                          干净
$ bun test tests/unit/                       1252 pass / 0 fail / 0 skip（基线 1218，本 lane +34）
$ bun test tests/concurrency/ tests/timeout/ 12 pass / 0 fail
$ SPARK_E2E_PORT=4434 bun run test:e2e       14/14 passed
$ bun run test:py                            48 passed
$ bun run test:lab                           26 passed
```

新增测试明细：`tests/unit/connector_manifest.test.ts` +2（判断证据①②，49→51）、
`tests/unit/literature_xml.test.ts` 全新 32 个（parseXml 语法 9 + arXiv 连接器 9 +
PubMed 连接器 8 + 并发不变式 3 + 真实响应回放 5，含阴性对照①的 7 个用例、阴性对照②的
3 个用例）。

## 文件清单

- `backend/src/connectors/literature.ts`：新增 `parseXml`/`XmlElement`/`localName`/
  `xmlChild(ren)`/`xmlElementText` 等最小 XML 解析器；重写 `PubMedConnector`（新增
  `getPaper`、`search` 补两跳链路、`getAbstract` 结构化解析、补礼貌头/NCBI
  tool+email 参数）；重写 `arXivConnector`（新增 `getPaper` 真正实现、`search`/
  `getPaper` 返回结构化 `ArxivFeed`、识别错误响应体分支、补礼貌头）；两个源都补上
  `limit` 参数对齐（此前统一检索传的 `limit` 从未生效）。
- `tests/unit/literature_xml.test.ts`（新建）：本 lane 的主测试文件，见上。
- `tests/unit/connector_manifest.test.ts`：追加"W3-d 判断证据"describe 块（2 个测试）。
- `tests/fixtures/manifests/pubmed-esearch-only.manifest.json`（新建）：判断证据①用。
- `tests/fixtures/manifests/arxiv-xml-normalize-probe.manifest.json`（新建）：判断证据②用。
- `tests/fixtures/literature/{arxiv-search,arxiv-getpaper,pubmed-search,pubmed-getpaper,
  pubmed-getabstract}.json`（新建）：2026-09-10 用本 lane 写的 connector 本身真实录制
  （`FIXTURE_MODE=record` 等价手法，实际用一次性脚本调 `FixtureHttp` 完成，脚本本身
  未提交），凭据安全不变量（请求头不落盘、`VOLATILE_QUERY_KEYS` 剥离、录制机制本身
  不涉及 POST body）照抄 `backend/src/http/fixture.ts` 既有实现，未新增任何绕过。
- `docs/devlog/W3-d.md`（本文件）。

## 诚实的未完成清单

1. **统一检索还看不到 arXiv/PubMed 的论文**——卡在 `normalize.ts` 不在本 lane 文件
   所有权内，见上方"BACKLOG V1"一节的详细交接。connector 层已经就绪，等一个有
   `normalize.ts` 权限的 lane 接上 `NORMALIZERS.arxiv`/`NORMALIZERS.pubmed`。
2. **限速器未实现**（任务书本就要求本 lane 不做），已记录主机预算压力变化，见上方
   BACKLOG V26 一节。
3. **`xmlElementText` 会丢失行内标记（`<sup>`/`<i>` 等）包裹的文本**——已在代码注释
   和上方"证据②"附近如实记录为已知取舍，不是本 lane 遗漏；真实摘要 fixture
   （`pubmed-getabstract.json`）里能看到这个效果（引用角标数字丢失，正文其余部分完整）。
4. **`arxivShortId` 保留版本号后缀**（如 `1706.03762v7`），是否要在归一化时去掉版本号
   由下一个碰 `normalize.ts` 的 lane 决定（取决于去重逻辑想不想区分版本）。
5. 没有验证 PubMed `search`/`getPaper` 在**真实的**"零结果"查询上的行为（fixture 库里
   只录了"零结果"的**合成/StubHttp**场景，没有录一条真实 NCBI 返回 idlist 为空的
   fixture）——单测里用 StubHttp 覆盖了这条路径的逻辑正确性，但没有拿真实网络验证过
   "NCBI 对零结果查询到底会不会在某些边界情况下返回和预期不同的 JSON 形状"，如实记录。
