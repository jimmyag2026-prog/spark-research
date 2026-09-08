# P2 · 文献域：检索与文献库（devlog）

> 分支：`feat/p2-literature` · 日期：2026-09-09
> 范围依据：[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md)「P2 文献域 · 检索与文献库」；设计依据：[DESIGN.md](../DESIGN.md) 域 A1/A2、§2.3（AD-2）、§5.3 技能表

## 一、做了什么

### 1. 可注入 HTTP 层 + fixture 回放机制（本阶段的地基）

这是 P2 真正的基建产出，其余交付物都挂在它上面。

- `backend/src/http/client.ts`：`HttpClient` 契约 + `HttpResponse`（text/json/bytes 三种消费方式）。
  - `NativeHttp` 包全局 fetch；`BufferedResponse` 先把 body 读进内存再包装——因为 fetch 的 body 只能消费一次，而录制需要「既落盘又返回给调用方」。
  - `StubHttp` 给单测构造确定性响应，不碰文件系统。
- `backend/src/http/fixture.ts`：`FixtureHttp`，三模式 `replay`（默认，CI）/ `record` / `live`，由 `FIXTURE_MODE` 环境变量切换。
  - 匹配 key = `sha256(METHOD + 规范化URL + body哈希)`。规范化会**剔除凭据类与易变查询参数**（`mailto/api_key/token/key/...`）并排序，所以换台机器、换个联系邮箱，fixture 依然命中。
  - cassette 落在 `tests/fixtures/literature/<name>.json`，entries 按 key 排序，diff 稳定。
- `backend/src/connectors/base.ts`：`MCPConnector` 增加可注入的 `http`，并新增 `headersFor()` / `queryFor()` 两个钩子给子类加礼貌头与鉴权头。**11 个存量 connector 的构造签名统一加了可选 `options`，行为零变化**（125 个基线测试一个没动）。

**安全不变量（这是设计而非约定）**：FixtureHttp **从不持久化请求头**，POST body 只存哈希不存原文。
所以 `Authorization` 这类东西在结构上就不可能进 fixture——不依赖录制者记得脱敏。
`tests/unit/literature.test.ts` 里有两条断言专门守这件事（录一个带 `Authorization` 的请求 → 断言落盘文件既不含 token 也不含 `Authorization` 字样）。

### 2. 免 key 文献 connector ×4

`backend/src/connectors/literature.ts` 新增，每个都有 `search` + `getPaper`（fetch-by-id）：

| connector | search | fetch-by-id | 备注 |
|-----------|--------|-------------|------|
| OpenAlex | `/works?search=&per-page=&select=` | `/works/{id}` | 额外给了 `getReferences`；id 支持 `W...` / `doi:...` / DOI URL |
| CrossRef | `/works?query=&rows=` | `/works/{doi}` | mailto 进 polite pool |
| Europe PMC | `/search?query=&resultType=core` | 同端点 + 字段限定检索式 | 无独立 by-id 端点，按 id 形态构造 `DOI:"..."` / `PMCID:...` / `EXT_ID:... AND SRC:MED` |
| Semantic Scholar | `/paper/search?fields=` | `/paper/{id}?fields=` | id 自动加前缀 `DOI:` / `arXiv:` |

`backend/src/connectors/politeness.ts`：礼貌头集中管理。**默认值是占位符** `spark-research@example.invalid`，
真实邮箱由用户经 `SPARK_RESEARCH_CONTACT_EMAIL` 提供，代码里没有任何个人信息。

### 3. AMiner connector（带凭据，AD-2）

`backend/src/connectors/aminer.ts`。凭据契约与主会话对齐：CredentialStore 的 connector id `aminer`、字段名 `api_key`，值直接放进 `Authorization` header。

- `search` → `GET /paper/search?title=&page=&size=`
- `getPaper` → `POST /paper/info`，body `{ ids: [...] }`（官方上限 100）

**无 key 优雅降级**：`isConfigured()` 为假时直接返回结构化的 `credentialMissingResult()`——
`{ ok:false, reason:"credentials_missing", requiredKeys:["api_key"], howToConfigure:[...], results:[] }`，
不抛异常，不发请求。凭据文件损坏导致读取抛错时也按「未配置」处理，**底层错误消息不外抛**（避免把文件路径/内容带出来）。
token 在本文件里只出现在 `headersFor()` 构造的 header 对象上，不写进任何返回值；
connector 基类的错误消息只带 HTTP 状态码，不回显响应体或请求头。

### 4. 跨源统一检索

`backend/src/literature/`：

- `models.ts`：统一 `Paper` 模型（title/authors/year/venue/doi/ids-per-source/abstract/url/pdfUrl/citedByCount/isOpenAccess/sources/references）+ `normalizeDoi` / `titleKey` / `titleSimilarity`（token 集合 Jaccard）。
- `normalize.ts`：五个源的映射器 + 各家「检索响应 → 论文数组」的包装层提取器。全程防御式读取——**一个源的字段改型不该让整次跨源检索炸掉**。含 OpenAlex 倒排索引摘要还原。
- `dedupe.ts`：判定顺序 = ①DOI 相同即合并 ②两边都有 DOI 且不同则**绝不合并**（DOI 是权威判据）③无 DOI 时归一化标题相同、或 Jaccard ≥ 0.9 且年份差 ≤1、第一作者姓不冲突。合并时按源可信度（CrossRef > OpenAlex > EuropePMC > S2 > AMiner）取字段，摘要取更长者，OA 直链谁有算谁的。排序 = 命中源数 → 被引 → 年份 → 标题，**确定性**。
- `search.ts`：`LiteratureSearcher`，`Promise.all` 并发 + 每源独立 settle。返回 `sourceStatus[]`，outcome 三态 `ok / failed / skipped`（无 key 的 AMiner 是 skipped 不是 failed）。

### 5. Project Library

`library.db`（用 P1 预留的 `Project.paths.libraryDb`，schema 建法照 records.db）：

- `papers` 表：归一化元数据 + `tags` / `reading_status` / `notes` / `pdf_path` / `pdf_status` / `pdf_reason` / `checksum` / `record_id` / `references_raw`。DOI 上有 partial unique index（`WHERE doi IS NOT NULL`）。
- `citations` 边表：库内互引，两端外键到 papers，`ON DELETE CASCADE`。
- **入库自动建 record**：每篇论文在 `records.db` 里有一条 `type: paper`、`evidence: sourced`、`origin.kind: connector` 的锚点，`papers.record_id` 互链（AD-3）。这是 P3 引用核验的地基。
- `rebuildCitations()`：用各篇的 `references_raw`（OpenAlex `referenced_works`）重算库内互引边，两端 record 都在时**同步在证据图上补一条 `cites` 边**。幂等。

### 6. PDF 下载管线

`backend/src/literature/pdf.ts`。候选直链按成功率排序：arXiv（由 id 拼 `/pdf/`）→ Europe PMC（由 PMCID 拼）→ 归一化时带下来的直链（OpenAlex `best_oa_location` / S2 `openAccessPdf` / EuropePMC `fullTextUrlList`）。

纪律落地：**每个候选只试一次**，403/404 记原因换下一个，全部失败即收手写回 `pdf_status=unavailable` + `pdf_reason`，下次不再重试。`isPdf()` 优先看 magic bytes 而不是 content-type（不少源返回 `application/octet-stream`）。批量下载串行，不并发打同一服务器。

### 7. BibTeX + CSL-JSON 导出

`backend/src/literature/export.ts`。key = 第一作者姓 + 年份 + 标题首词（跳过冠词介词与纯数字），冲突时第一条无后缀、之后依次 `a`/`b`/`c`…（26 进位）。确定性：同一个库导出两次得到同样的 key。

### 8. 技能 ×3 + 目录规范

`backend/src/skills/`，每技能一个目录 + `SKILL.md`（YAML frontmatter：name/description/category/domain/allowed-tools），格式参照 OpenScience 的 instruction bundle。落地 `literature-search` / `paper-download` / `library-curation`，另有 `README.md` 说明目录结构与 AD-5 纪律。

三个技能文档都写了**反模式小节**——说清边界比说清用法更能防止 agent 越界（例如「把某源的失败包装成『该领域没有相关工作』」「下载失败后凭摘要编造全文」）。

### 9. CLI

`spark-research lit search|add|list|pdf|export|sources`，挂在现有 CLI 下，走当前项目。风格与 `project/cli.ts` 一致（返回退出码 + 输出走注入的 out/err，可直接单测）。

## 二、真实网络验证（`FIXTURE_MODE=record`，2026-09-09 本地实跑）

逐源结果：

| 源 | search | fetch-by-id | 结论 |
|----|--------|-------------|------|
| OpenAlex | ✅ 10 条 / 3.2s | ✅ 1 条 | 完全可用 |
| CrossRef | ✅ 10 条 / 1.7s | ✅ 1 条 | 完全可用 |
| Europe PMC | ✅ 10 条 / 1.6s | ✅ 1 条 | 完全可用 |
| Semantic Scholar | ❌ **HTTP 429** | ❌ HTTP 429 | 未鉴权请求被限流，见下 |
| AMiner | ✅ **HTTP 200，业务 code=200，3 条** | 未跑 | 连通性验证通过 |

PDF 真实下载：

| 样本 | 结果 |
|------|------|
| arXiv `1706.03762`（Attention Is All You Need） | ✅ 2,215,244 字节，sha256 `bdfaa68d…8df697` |
| Europe PMC `PMC13311257`（OA 子集内） | ✅ 4,273,105 字节，sha256 `5f9c2cd6…82979b` |

### 验证过程中发现并修掉的三个真问题

**(a) Europe PMC 的 PDF 端点是错的**（我原本按文档直觉写的）。
`https://www.ebi.ac.uk/europepmc/webservices/rest/<PMCID>/fullTextPdf` 实测**恒返回 404**。
实际可用形式是 `https://europepmc.org/articles/<PMCID>?pdf=render`（实测 200，`application/pdf`，4.2 MB）。
已同时修 `pdf.ts` 的候选推导与 `normalize.ts` 的后备直链，并在代码里留注释警告「不要改回去」。

附带发现：`PMC8371605`（AlphaFold 那篇 Nature）**不在 Europe PMC 的 OA 子集里**，两种 URL 都拿不到 PDF。
e2e 样本因此换成 `PMC13311257`（`isOpenAccess=Y` 且 `inEPMC=Y`）。这条也写进了 scenario 文件的注释。

**(b) FixtureHttp 会产出「坏 fixture」**。
第一版对超长文本响应体做截断，结果 OpenAlex 20 条结果的响应超过 512 KiB 上限，被截断成**不可解析的 JSON**——
录制时一切正常，回放时才会炸。改成：文本响应体**绝不截断**，超限直接在录制时报错并提示收窄请求。
把一个隐性故障换成了显性故障。

顺带做了正确的修法：给 OpenAlex 加 `select` 参数只取归一化用得到的 13 个字段，
响应体缩小一个数量级（同样 20 条从 >512 KiB 降到 ~440 KiB 含全部 4 个 cassette），对 API 也更礼貌。

**(c) CLI 把「去重」和「截断」混为一谈**。
真实跑 `lit search --limit 5` 时输出「15 条原始结果 → 去重合并 5 条」，
但那 5 条其实是 `--limit` 截断的结果，`mergedCount` 是 0。这种文案会让 agent 和用户都误判去重效果。
改成分开报三个数：原始条数 / 合并掉的条数 / 截断后展示条数。

### 两条如实记录、未修的现象

**Semantic Scholar 未鉴权恒 429。** 连续 4 次录制、外加 3 次手工 curl 重试（间隔 3s），全部 429。
这不是偶发限流，而是 S2 现在对匿名请求的常态。**没有伪造 fixture**——429 响应被原样录进 cassette，
e2e 回放因此实际跑的是「一个源失败、其余源照常返回」的降级路径，反而变成了有价值的对抗用例。
`literature-search` 技能文档已写明这一点。**结论：S2 实际上已需要 API key**，建议 P3 把它加进凭据体系（见第五节）。

**三个源在 top-N 上 DOI 零重合。** 对 "AlphaFold protein structure prediction" 这个 query，
OpenAlex / CrossRef / Europe PMC 各取 20 条，两两交集**为空集**（已用脚本逐一比对 DOI 集合确认，不是去重 bug）。
原因是三家的相关性排序取向完全不同：OpenAlex 偏高被引经典、CrossRef 相关性排序偏弱（返回了 protocols.io 和 SSRN 预印本）、Europe PMC 偏最近。
**实践含义**：跨源检索的价值主要在**召回覆盖面**而不是交叉验证——想靠多源互证元数据，得走 `fetchById`（同一 DOI 三源都返回，合并后字段最全，e2e 里断言了这条）。
`--limit` 因此不宜设太小。

## 三、测试结果

```
$ bun run typecheck
（无输出，clean）

$ bun test tests/unit/
 200 pass
 0 fail
 847 expect() calls
Ran 200 tests across 14 files. [497.00ms]
```

- 基线 **125 个一个没动、全绿**；新增 **75** 个：
  - `tests/unit/literature.test.ts` **68 个**：归一化字段映射（5 源 × 真实响应形态 + 字段缺失/类型异常不抛错）、DOI/标题去重（含「DOI 不同不合并」「Part I/II 不误合」「完全不同不误合」「排序确定性」）、BibTeX/CSL（key 规则、冲突后缀、转义、@misc 判定、姓名拆分、空库）、Library CRUD + 引文边 + record 联动 + 持久化往返、PDF 管线（候选推导、成功落盘、403 不重试、404 回落、HTML 落地页、无直链零请求）、AMiner 五种降级/构造场景、四个 connector 的请求构造、礼貌头占位符、FixtureHttp 安全性（请求头不落盘 / POST body 只存哈希 / 二进制只留截断样本 / key 剔除凭据参数 / 坏 cassette 报错）。
  - `tests/unit/literature_e2e.test.ts` **7 个**：跨源检索回放（含 S2 429 降级）、fetchById 三源合并、**全链路**（检索 → 入库 → 幂等 → record 联动 → 引文边 → BibTeX/CSL 导出）、PDF 双源回放、CLI 全流程、CLI 错误路径、AMiner 真实响应形态归一化 + fixture 无凭据断言。
- `tests/integration/literature_record.test.ts` 4 个（真实网络，`describe.skipIf` 默认跳过，**不在 `bun test tests/unit` 范围内**，不影响基线）。
- CLI 冒烟（手工，`SPARK_RESEARCH_DATA_DIR` 指向临时目录）：`lit sources/list/export/help` 输出符合预期；
  **真实网络全流程也手工跑通**：`lit search --add`（15→5，引文边 5 条）→ `lit list` → `lit export --format bibtex`（key `jumper2021highly` 正确）。

### fixture 清单

| cassette | 条目 | 大小 | 内容 |
|----------|------|------|------|
| `search-alphafold.json` | 4 | 440 KB | 四源 search（S2 是真实的 429） |
| `fetch-by-id.json` | 4 | 98 KB | 四源 by-DOI 取单篇 |
| `pdf-download.json` | 2 | 6.8 KB | arXiv + Europe PMC 的 PDF 响应（**只留 2 KiB 截断样本 + 长度 + sha256**） |
| `aminer-search.json` | 1 | 1.6 KB | AMiner 真实 search 响应 |

`tests/helpers/literature_scenario.ts` 是录制与回放共用的参数单一真源——任何常量改动都必须重新录制。

### 凭据纪律核验

- 全量 `grep` 密钥模式：命中的 4 处全部在 `tests/unit/literature.test.ts`，是**故意构造的假值**（`fake-aminer-token` / `sk-super-secret-token-value-1234567890` / `super-secret-token-abc`），用来断言这些值**不会**出现在输出里。
- fixture 高熵串逐一溯源：全部是 sha256 摘要与 PDF base64 样本，无凭据。
- fixture 中 `Authorization` / `Bearer` 出现次数：**0**（结构性保证）。
- 个人信息（邮箱/用户名）扫描：**0** 命中。
- `.gitignore` 增补 `papers/` 与 `*.pdf`；staged 文件中 PDF 数：0。

## 四、关键实现决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | http 层做成可注入的 `HttpClient` 而不是 monkey-patch 全局 fetch | 全局 patch 会让并行测试互相污染；注入还顺便让 `StubHttp` 单测不碰文件系统。代价是 11 个 connector 构造签名各加一个可选参数（行为零变化） |
| D2 | fixture **不存请求头**，POST body 只存哈希 | 把「录制前记得脱敏」这种人肉纪律换成结构性保证。凭据在结构上无法进 fixture，不依赖录制者的自觉 |
| D3 | 文本响应体超限**报错**而不是截断 | 截断的 JSON 是坏 fixture：录制时不报错、回放时才炸。显性故障优于隐性故障 |
| D4 | 两边都有 DOI 且不同 → 绝不合并，哪怕标题一模一样 | DOI 是权威身份。宁可漏合（用户能手工合）也不能误合（误合会污染证据图，且难以发现） |
| D5 | 标题模糊匹配加「年份 + 第一作者姓」双闸 | 只看标题相似度会把 "Part I" / "Part II"、会议版/期刊版误合。阈值 0.9 + 双闸在真实数据上没有误合 |
| D6 | AMiner 无 key 返回结构化降级体而不是抛异常 | 退出标准明确要求；也让统一检索能把它标成 `skipped` 而不是 `failed`——语义不同，给用户的话也不同 |
| D7 | `references_raw` 存原始 OpenAlex id，引文边靠 `rebuildCitations()` 重算 | 引用关系依赖「两端都在库内」，而入库是增量的。存原始 id + 每次入库后重算，新论文才能把旧论文的悬空引用接上 |
| D8 | Library 的 `add()` 做合并而不是报重复 | 入库是高频且常重跑的动作（同一 query 换个 limit 再跑一次）。幂等合并比报错友好，也避免用户手工去重 |
| D9 | `citedByCount` 遇到 AMiner 的 `n_citation_bucket`（"5000+"）留 null | 区间字符串硬转成数字等于凭空造精度。宁可缺字段也不造假数据 |
| D10 | PDF 候选优先「由标识符推导」而非源返回的链接字段 | arXiv/EuropePMC 的直链形式稳定，而各源返回的 `pdf_url` 质量参差（常指向落地页）。实测中前者 100% 命中 |

## 五、与设计的偏差

1. **AMiner 只接了 2 个 API，不是 29 个**——这与 DEVELOPMENT_PLAN 的 P2 范围（「29 API 中先接 search/paper-detail 两个核心」）一致，但与 DESIGN §A1 的「29 个 API 已在调研中验证可用」读起来有落差，故在此明确：本阶段只接 `paper/search` 与 `paper/info`。
2. **Semantic Scholar 实际已非「免 key」**。DESIGN §A1 把它列入「全部免 key」的清单，实测未鉴权恒 429。代码与 connector description 已改为「免 key；无 key 时共享公共限流额度」，但**建议主会话决定是否把 S2 加进凭据体系**（`s2` / `api_key`，走与 AMiner 相同的 `CredentialProvider` 通路，改动量很小）。DESIGN.md 是否同步更新，听主会话的。
3. **`arxiv` / `pubmed` 未接入统一检索**。这两个存量 connector 返回 XML/Atom 而非 JSON，归一化需要 XML 解析器。`normalize.ts` 里给它们留了返回空数组的占位（保持类型完备），默认检索源是四个 JSON 源。**P3 或 backlog 处理**。
4. **CNKI / 万方保持占位**，与 DESIGN §六「风险与缓解」一致，未做改动。
5. **`getReferences` 是计划外多出来的工具**。OpenAlex 单独提供一个只取 `id,referenced_works` 的轻量调用对 P3 的引文分析有用，顺手加了；不影响既有契约。
6. **e2e 的 PDF 回放校验的是截断样本的 checksum**，不是原始文件的。fixture 只留 2 KiB 样本（PDF 本体不入库是硬要求），所以回放时 checksum 必然与真实文件不同。测试断言的是「magic bytes 正确 + checksum 格式正确 + 库内状态回写正确」，真实文件的 checksum 记在本 devlog 第二节。

## 六、留给后续阶段的钩子

- `LibraryStore` + `papers.record_id` 已把文献接进证据图，P3 的 `citation-integrity` 检查器可以直接查「草稿引用的 DOI 是否存在于 `library.db` 且对应 record 是否在图上」。
- `LiteratureSearcher.search()` 的 `sourceStatus` 三态是 P4 novelty check 的密集检索直接可用的返回结构（「哪些源没覆盖到」直接影响新颖性结论的可信度）。
- `FixtureHttp` 与 `tests/helpers/*_scenario.ts` 的模式可以原样复制给 P5/P6 的外部依赖（仿真平台、Opentrons）。
- `CredentialProvider` 结构化接口已就位，接第二个带凭据的源（S2 / CNKI）不需要动 connector 基类。
- `backend/src/skills/` 的目录规范与 README 已定，P3 起新增技能照抄结构即可。

## 七、主会话审查建议重点

1. **AD-2 的落地是否够严**：`AMinerConnector` 直接持有 `CredentialProvider` 并在 `headersFor()` 里取值。这仍然全在 daemon/CLI 进程内，但 connector 层现在能碰到凭据本体了——如果希望更严（凭据永不出 `CredentialStore`，改为由 store 代签请求），需要在 P3 前决定，越晚改代价越大。
2. **去重阈值 0.9 与「DOI 不同绝不合并」的取舍**：当前策略明确偏向「宁可漏合」。真实数据上零误合，但也意味着同一篇的预印本版与正式版（DOI 不同）会是两条记录。这是有意的（它们确实是两个可引用对象），但请确认符合预期。
3. **Semantic Scholar 是否升级为带凭据的源**（见偏差 2）。这会影响 DESIGN §A1 的「全部免 key」表述与 P3 的检索覆盖面假设。
