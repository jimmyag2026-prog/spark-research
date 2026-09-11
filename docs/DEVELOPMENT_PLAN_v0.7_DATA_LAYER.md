# v0.7 主方向设计稿 · 数据层演进（原始层 append-only · lakehouse · 可控回流）

> 状态：**v0.7 方案配套设计（定稿 v1）**，与 `DEVELOPMENT_PLAN_v0.7.md` 同一 PR 入库。2026-09-11 用户拍板：数据层为 v0.7 主方向 A。
> 波次、lane 足迹、门禁与验收的总表在 `DEVELOPMENT_PLAN_v0.7.md`；本文只讲数据层本身。
> 基线：`main` @ v0.6.0（`dd11bf3`）。所有文件路径与行号已在该基线上复核（2026-09-11）。
> 输入：用户本地调研《数据采集系统重设计》（热窗+归档、QC 一等公民）·
> 《数据交易市场：AWS/Snowflake/Databricks 对比》（不复制、开放协议、按查询计费）·
> 《中国 AI 数据出境与蒸馏监管》（来源可追溯、上游数据边界）。

---

## 〇、一句话与锁定决策

**把「证据图」从真源降级为派生层，在它下面补一层只追加不改的原始层；导出格式与来源分级从第一天定死，回流通道不做。**

已锁定（用户，2026-09-11）：
- 数据层是 v0.7 主方向；3D 结构查看器不做
- 本地化优先：不引入云依赖，S3 只是可选归档目标
- 接口留给社区：存储层要有和 `SimulationPlatform` / `WetLabBackend` / `ComputeAdapter` 同款的契约
- 回流/售卖：v0.7 只做**字段与判定**，不做通道
- **raw 层默认开、只在本地**（问题 1）
- **LLM 原文默认永久保留**，不做 N 天后降 hash（问题 2）；`data archive` 只压缩不删
- **JSONL + DuckDB 直查是 v0.7 的全部**，Parquet 顺延（问题 3）——§6.1 的 `--format parquet` 从 v0.7 范围移除，只留 JSONL；DuckDB 示例查询进文档
- **共享/导出单位 = 项目；增量 = 时间窗 delta，manifest 链式引用上一份**（问题 4，分析见 §7.5）；不支持按 record 类型切片
- **售卖环节不开发**；接口按国际通用方案预留：manifest 命名对齐 Delta Sharing 的 share/schema/table 三级、license 用 SPDX 表达式（自定义走 `LicenseRef-`）、数据集描述取 DCAT 核心字段（问题 5，见 §7.6）
- **`raw/kernel` 只存引用 + 内容 hash，不做镜像**（问题 6，用户未定、主会话裁定，理由见 §4.1 注）

## 一、目标与非目标

| 目标 | v0.7 做到什么 |
|---|---|
| 自动记录所有数据 | 每次 connector 调用、每次 LLM 调用、每个 kernel cell、每次设备读数都有一条原始记录，**不需要任何模块记得去写** |
| append-only 原始数据 | 原始层只有 `append`；证据图的每次改写都留 journal 行；删除是 tombstone |
| lakehouse 结合 | 稳定的导出目录约定 + manifest；本地 DuckDB 可直查；Parquet 可选 |
| 本地化优先 | 所有新文件仍在 `~/.spark-research/projects/<slug>/` 下 |
| 社区可调整 | `RawSink` / `RecordJournal` 两个接口，默认实现 jsonl + SQLite |
| 可控回流 | 每条数据带 `provenanceClass` + `license`；`shareable()` 判定函数 + 门禁；上游镜像永不出 |

**非目标（v0.7 明确不做）**：Delta/Iceberg 依赖 · 云端存储默认开启 · 回流的传输通道与计费 · 把 SQLite 换掉（它仍是热层）· 多用户权限（V10）。

## 二、现状诊断（按代码，不按印象）

### 2.1 现有记录面

| 层 | 位置 | 内容 | 可变性 |
|---|---|---|---|
| 证据图 | `projects/<slug>/records.db`（`project/records.ts`） | 9 类 record · 4 证据标签 · 5 边 · `rev` CAS | **可改**：`update()` 可覆写 `content`/`metadata`，旧值不留 |
| 产物与 cell 执行 | `artifacts/artifacts.db`（`artifacts/store.ts`） | 版本 · 依赖 · `execution_records`（source/stdout/stderr/资源） | 近似 append |
| agent 帧记账 | record type `agent_run`（`agents/ledger.ts`） | model/provider/**systemHash/promptHash**/usage/integrityHash | append；**只有 hash 没有原文** |
| LLM 花费台账 | `projects/<slug>/usage.jsonl`（`usage/ledger.ts:23`） | ts/command/provider/model/tokens/costUsd | append |
| connector 调用台账 | `<dataDir>/api_calls.jsonl`（`usage/api_ledger.ts:23`） | ts/connector/host/status/latencyMs | append；**无请求参数、无响应体** |
| 外部 MCP 调用 | `<ext>/.mcp_calls.jsonl`（`extensions/mcp_client.ts:186`） | 调用记录 | append |
| 文献库 | `library.db`（`literature/library.ts`） | 归一化后的论文 | `update()` 限 tags/readingStatus/notes/pdf*；`remove()` 硬删（V30：零生产调用方） |

### 2.2 「append-only 原始数据」在三处不成立

1. **connector 原始响应被丢弃**——`connectors/base.ts:188` `const raw = await response.text()` 之后立刻 `JSON.parse`，raw 不落盘。归一化逻辑一旦改（例如作者名解析 V38），旧结果无法重算。
2. **LLM 原文不落盘**——`LLMRouter.call()`（`llm/router.ts:163`）与 `usageTrackingLlm()`（`usage/ledger.ts:155`）两层都只记 usage；`agent_run` 记 `promptHash`。R1/R2 跑过的真实课题，今天只剩派生结果（精读卡、结论卡），**prompt 与模型原始输出已经不可追溯**。
3. **证据图可覆写**——`RecordStore.update()`（`records.ts:345`）直接 `UPDATE records SET content=…`。9 处生产调用方：

| 调用方 | 改什么 | 性质 |
|---|---|---|
| `experiment/loop.ts:705/755/802` | 实验状态 + 渲染正文 | 状态机 |
| `lab/wet_loop.ts:826/872` | 湿实验状态 + 审批（CAS） | 状态机（D-9 完整性核验依赖它） |
| `ideation/store.ts:114` · `conclusion/store.ts:100` | 卡片状态 | 状态机 |
| `compute/broker.ts:289` | 算力 observation 回填 | 回填 |
| `literature/reading.ts:466` | `retracted` 标记 | 已经是 tombstone 形状 |

**结论**：不能简单「禁掉 update()」——状态机语义（含 D-9 完整性核验、CAS 原子声明执行权）都建在它上面。正确做法是**在它下面加 journal**：可变投影 + 不可变日志。

### 2.3 现有质量/来源标记散在各处

`deterministic`（V49）· `basis: abstract|fulltext`（V66）· `simulated`（G4）· bioRxiv `caveat`（V54）· `usageUnavailable`——全在各自 `metadata` 里，没有统一列，导出与回流时无法机器过滤。

### 2.4 单二进制约束（影响格式选型）

`bun build --compile` 不带原生扩展；仓库 `package.json` 无 duckdb/parquet/arrow 依赖。**Parquet 写出不能靠 npm 原生包**，只能：① JSONL 为稳定契约；② Parquet 经外部 `duckdb` CLI 子进程（与 `.venv` python 同款「探测→spawn」形状），缺则如实报不可用（AD-12）。

## 三、目标架构：四层

```
L3  回流控制     provenanceClass · license · shareable() · 共享清单审批（AD-6 同款）
L2  导出/湖仓    data export → <slug>/export/<ts>/{manifest.json, records/, raw/, artifacts/}
                 JSONL 稳定契约；Parquet 可选（外部 duckdb）；DuckDB 直查
L1  证据图       records.db（可变投影，供状态机/报告/完成判定）
                 + records_journal（append-only：每次 create/update/tombstone 一行）
L0  原始层       <slug>/raw/{connector,llm,kernel,device}/<date>.jsonl（+ blobs/）
                 只 append；行内 prevHash 链；凭据永不进入
```

**不变量**（写进 AD）：
- **AD-15**：L0 只追加；L1 可由 L0 + journal 重建（v0.7 做到「导出→重导入逐条相等」，不做全量重放）
- **AD-16**：`provenanceClass = upstream` 的数据永不进入任何共享/导出-for-sharing 集合

### 3.1 目录布局（新增部分加粗）

```
projects/<slug>/
├── project.json              schemaVersion 1 → 2
├── records.db                + 表 records_journal · + 列 quality · + 列 provenance_class · + 列 license
├── library.db
├── artifacts/artifacts.db
├── papers/  experiments/
├── usage.jsonl
├── **raw/**
│   ├── connector/<name>/<YYYY-MM-DD>.jsonl
│   ├── llm/<YYYY-MM-DD>.jsonl
│   ├── kernel/<YYYY-MM-DD>.jsonl        （execution_records 的镜像，便于统一导出；可选）
│   ├── device/<YYYY-MM-DD>.jsonl
│   └── blobs/<sha256[:2]>/<sha256>      （超过阈值的响应体/PDF 文本，行内只留引用）
└── **export/**<ISO-ts>/                 data export 产物（可删，可重建）
```

`ProjectPaths`（`project/manager.ts:89`）加 `rawDir`、`exportDir`。

## 四、L0 原始层

### 4.1 行 schema（所有 kind 共用外壳）

```ts
interface RawEntry {
  v: 1;                       // 行格式版本
  id: string;                 // ulid
  ts: string;                 // ISO8601
  kind: "connector" | "llm" | "kernel" | "device";
  project: string;
  sessionId: string | null;
  command: string | null;     // 触发它的 CLI 命令 / MCP 工具 / HTTP 路由
  provenanceClass: "upstream" | "derived" | "user_authored" | "model_generated";
  license: string | null;     // SPDX 或来源 ToS 标识（见 §7.2 映射表）
  prevHash: string | null;    // 同文件上一行的 hash（链）
  hash: string;               // sha256(canonical(除 hash 外全部字段))
  payload: ConnectorPayload | LlmPayload | KernelPayload | DevicePayload;
}
```

| kind | payload |
|---|---|
| connector | `{ connector, tool, host, params(脱敏), status, latencyMs, responseRef: {inline: string} \| {blob: sha256, bytes}, contentType }` |
| llm | `{ provider, model, wireModel, messages(原文), options(不含 key), response(原文 content + finish_reason + usage), ok, failureKind }` |
| kernel | `{ executionRecordId, contentHash }`（指向 artifacts.db，不重复存 stdout；`contentHash` = 该 execution_record 行 canonical 后 sha256，让 raw 链覆盖到 kernel 输出。**裁定不做镜像**：stdout 可能很大且已在 artifacts.db 里是 append 形状，L2 导出时它自成一张表；镜像只换来「一个目录看全」，代价是体积翻倍与两份副本可能不一致——V46 形状） |
| device | `{ experimentId, backend, stepId, reading }` |

**脱敏硬规则（AD-2 延伸）**：请求头一律不记；`params` 里名为 `key/token/apiKey/authorization` 的字段替换为 `"<redacted>"`；LLM options 剥离 env/key。门禁：`tests/unit/raw_redaction.test.ts` 用带 key 的 stub 调用断言 raw 文件里 grep 不到。

### 4.2 埋点（各一处，全体覆盖——V46「两份手写副本」教训）

| 数据 | 埋点位置 | 备注 |
|---|---|---|
| connector | `connectors/base.ts:188` raw 到手之后、`JSON.parse` 之前 | 与现有 `recordApiCall`（:210）同一 finally 块；失败响应也记 |
| LLM | `usage/ledger.ts` `usageTrackingLlm().call()` 真调用返回处 | 已是所有花钱路径的必经点（v0.6 G-3 预算闸在这里）；**直接 `new LLMRouter().call()` 的调用方要清扫**（同 V40 形状：门禁 = router 加 `rawSink` 必填或显式 `null` 并写理由） |
| kernel | `artifacts/store.ts` 写 `execution_records` 处 | 只写引用行 |
| device | `lab/wet_loop.ts:662` `read_result` 收集处 | 每个 reading 一行 |

### 4.3 体积控制（来自 data_collection_redesign §8.3）

- 响应体 > 64 KB 落 `blobs/`，行内留 `{blob, bytes}`；同 hash 去重（同一篇论文被查 5 次只存一份）
- LLM 原文默认全存（研究过程数据是最有回流价值的部分）；`config set rawLlm off` 可关，关了 `agent_run` 仍有 hash
- 滚动归档：`data archive --before <date>` 把 raw 日文件 gzip 到 `raw/archive/`，**不删**；S3 上传是用户自己的事（提供 `--to <dir>`，不内置云 SDK）
- 估算：R1 两课题 $0.055 花费对应约 60 万 token ≈ 2.4 MB 原文；connector 响应按 R1 调用量约 20 MB/课题。**一个中等课题 < 50 MB**，先不做压缩

### 4.4 接口（社区替换点）

```ts
export interface RawSink {
  readonly id: string;
  append(entry: Omit<RawEntry, "prevHash" | "hash">): Promise<RawEntry>;
  verify(kind: RawEntry["kind"], date: string): Promise<{ ok: boolean; brokenAt?: string }>;
  iterate(filter: { kind?: RawEntry["kind"]; since?: string; until?: string }): AsyncIterable<RawEntry>;
}
```
默认实现 `JsonlRawSink`；测试用 `MemoryRawSink`。注册方式照 `SimulationRegistry`：`config set rawSink <id>`，外部实现走 `ext` 机制（AD-11：过契约测试才算装好——契约测试 = append 后 iterate 逐字节一致 + 链校验）。

## 五、L1 证据图：journal + 统一列

### 5.1 `records_journal`（append-only）

```sql
CREATE TABLE records_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  op TEXT NOT NULL,            -- create | update | tombstone | link
  rev_before INTEGER, rev_after INTEGER,
  actor TEXT, actor_source TEXT,
  patch TEXT NOT NULL,         -- JSON：update 时为 {title?,content?,metadata?} 的 diff；create 时为全量
  prev_hash TEXT, hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```
- `RecordStore.create/update/link` 内部各加一行 journal 写入，**同一事务**；9 处调用方一行不改
- `RecordStore.history(id)` 新增只读接口；HTTP `GET /api/records/:id/history`；CLI `report records --history <id>`
- **V24 顺手关**：完整性核验失败时，`records repair <id> --to-seq <n>` 从 journal 重建投影（需 `--actor`，落一条 journal `op=repair`）
- **V30 顺手关**：`LibraryStore.remove()` 改 tombstone（`removedAt`），`retractOrphanRecords()` 接上成生产调用方

### 5.2 统一列

| 列 | 取值 | 由谁写 | 替代的散落 metadata |
|---|---|---|---|
| `quality` | JSON 数组，如 `["deterministic:false","basis:abstract","simulated","caveat:biorxiv-not-search"]` | 各写入方（保留 metadata 原样，多写一列） | V49/V66/G4/V54 |
| `provenance_class` | 四值 | 按 §7.2 映射表由写入方声明；`RecordStore.create()` 缺省拒绝（不给默认值——V40 教训） | 无 |
| `license` | 字符串/null | 同上 | 无 |

`PROJECT_SCHEMA_VERSION` 1 → 2（`project/manager.ts:11`）；`initSchema()` 走 D-9 同款「老库 ALTER 补列」路径，旧记录 `provenance_class` 回填规则：`origin.kind=connector → upstream`，`agent_run/reading/conclusion(model) → model_generated`，`manual/import → user_authored`，其余 `derived`；回填结果落一条 journal `op=backfill`。

## 六、L2 导出与湖仓

### 6.1 `spark-research data export`

```
data export [--since <ts>] [--until <ts>] [--for-sharing] [--out <dir>]      # 只有 JSONL
```
产物：
```
export/<ts>/
├── manifest.json     { schemaVersion, project, range, counts{records,raw,artifacts}, licenses{...:count},
│                       provenanceClasses{...:count}, rootHash, generator:{version, commit}, forSharing: bool }
├── records/type=<type>/date=<YYYY-MM-DD>/part-0.jsonl
├── records_journal/date=.../part-0.jsonl
├── raw/kind=<kind>/date=.../part-0.jsonl   （+ blobs/ 按引用复制）
└── artifacts/...（execution_records + 版本表）
```
- Hive 风格分区，DuckDB 一句 `read_json_auto('export/*/records/**/*.jsonl')` 直查；文档给 3 条示例查询
- ~~`--format parquet`~~ **v0.7 不做**（用户 2026-09-11：JSONL + DuckDB 够用）。目录约定与分区列已按 Parquet 友好设计，将来加 `--format parquet` 只是探测外部 `duckdb` CLI 后一条 `COPY … (FORMAT PARQUET)`，不动数据模型
- `--for-sharing`：应用 §7.3 的 `shareable()`，**upstream 一律排除**，manifest 标 `forSharing:true` 并列出被排除的计数
- `data import <export-dir>`：只做「重建到空项目」，用于验收对账（§9）

### 6.2 接口（社区替换点）

```ts
export interface RecordJournal {
  append(entry: JournalEntry): void;           // 与 records 同事务
  history(recordId: string): JournalEntry[];
  iterate(since?: number): Iterable<JournalEntry>;
}
export interface ExportTarget {
  readonly id: string;                          // "local-dir" | "s3" | ...
  write(rel: string, bytes: Uint8Array): Promise<void>;
  finalize(manifest: Manifest): Promise<string>; // 返回可定位的 URI
}
```
v0.7 只交付 `local-dir`。S3/Iceberg 由社区或后续版本实现；契约测试随脚手架 `new export-target` 生成（复用 P15 机制）。

## 七、L3 回流控制（字段与判定，不做通道）

### 7.1 分类定义

| provenanceClass | 含义 | 例 |
|---|---|---|
| `upstream` | 从外部数据源镜像来的内容 | connector 响应、下载的 PDF、AMiner/CNKI 结果 |
| `derived` | 由 upstream 经确定性处理得到 | 归一化论文元数据、仿真产出、安全门结论、统计 |
| `user_authored` | 用户自己写的 | project desc、idea 原文、协议原文、审批 note |
| `model_generated` | LLM 产出 | 精读卡、结论草稿、判定器输出、agent_run |

### 7.2 来源 → class/license 映射表（真源放 `backend/src/provenance/policy.ts`，门禁核它与 connector 注册表一致——V34 教训）

| 来源 | class | license 字段 |
|---|---|---|
| aminer / cnki / wanfang（凭据源） | upstream | `proprietary:<connector>`——**永不导出 for-sharing，且 raw 响应体默认不存 inline 只存 hash**（ToS 风险） |
| 公共 API（openalex/crossref/europepmc/pubmed/arxiv/…） | upstream | 各源声明（CC0 / CC-BY / 非商业），`metadata.license` 缺则 `unknown` |
| 仿真/湿实验产出 | derived | `user-owned` |
| LLM 输出 | model_generated | `user-owned`（provider ToS 另注 `providerTerms:<provider>`） |
| 用户输入 | user_authored | `user-owned` |

### 7.3 `shareable(entry) → { ok: boolean; reason }`

规则只有三条，写死、可测：① `upstream` → false；② `license` 为 `unknown` 或含 `proprietary:` → false；③ 其余 → true。**不做「部分共享」「脱敏后共享」**——那是通道期的事。

### 7.4 共享动作的审批形状（v0.7 只定形状，不接通道）

复用湿实验审批：`data share-manifest <export-dir>` 生成待批清单 → `data approve <manifest-hash> --actor` 落 `decision` record（metadata 带 `manifestHash`、被排除计数、`actorSource`）。AD-6：谁批的、批的哪一版。AD-14：子代理不能批。

### 7.5 共享单位裁定（问题 4）

三个候选逐一看**买方要什么**与**边会不会断**：

| 单位 | 买方拿到的 | 图闭包 | 同意/审批粒度 | 结论 |
|---|---|---|---|---|
| 按 record 类型 | 一堆同类节点（如全部精读卡） | **断**：`derives_from`/`supports` 边的另一端不在集合里，轨迹价值归零 | 无法解释「同意了什么」 | 不支持 |
| 按时间窗 | 一段时间内的节点 | 断（跨窗的边） | 可解释，但一个课题会被切碎 | 只作**增量**，不作首份 |
| **按项目** | 一个课题从 idea 到结论的完整轨迹 | **闭**：项目是图的天然边界（AD-1 project-centric） | 一次审批 = 一个课题，`desc` 就是同意书的标题 | **首份导出单位** |

裁定：**manifest 以项目为单位；同一项目后续用 `--since` 出 delta，manifest 带 `prevManifestHash` 成链**；`data import` 按链顺序重放。`--for-sharing` 下先做类过滤再算图闭包：被排除节点（upstream）在导出里以 **stub**（只有 id/type/hash/provenanceClass，无内容）保留，边不断——买方能看到「这里引用了一篇上游论文」但拿不到镜像内容。

### 7.6 售卖接口预留（问题 5：不开发，只对齐国际通用形状）

| 层面 | 对齐对象 | 在 v0.7 里的体现 |
|---|---|---|
| 交付协议 | **Delta Sharing**（开放 REST：share → schema → table，recipient profile + bearer，`/shares/{share}/schemas/{schema}/tables/{table}/query`；Databricks 主推、pandas/Spark 可读） | manifest 的顶层命名照它：`share = <project-slug>`、`schema = records \| records_journal \| raw \| artifacts`、`table = <type 或 kind>`。将来的只读端点直接映射这三级，不改导出格式 |
| 数据集描述 | **DCAT**（W3C）核心字段：title / description / issued / modified / license / publisher / distribution | manifest 加同名字段（`dcat:` 前缀），`title`/`description` 取 project.json |
| 许可标识 | **SPDX** license expression；自定义许可走 `LicenseRef-<id>` | `license` 列即 SPDX 表达式：公共源用其声明（`CC0-1.0` / `CC-BY-4.0` / `LicenseRef-noncommercial`）；凭据源 `LicenseRef-proprietary-<connector>`；用户/模型产出 `LicenseRef-spark-user-owned`（占位，售卖时再定真实许可） |
| 计费口径 | 市场主流「按查询/事件」而非按 GB | 只读端点将来复用 `api_calls.jsonl` 形状反向记账；v0.7 不做 |
| 版本/修订 | AWS Data Exchange 的 data set → revision → asset | manifest 链（§7.5）即 revision 序列 |

**v0.7 交付的只有 manifest 形状与 license 枚举**；没有端点、没有 recipient、没有计费。


### 7.7 监管对照（只记事实，不做法律结论）

- 训练数据合法性说明需要来源可追溯 → `origin` + `provenanceClass` + `license` 三列即为说明材料
- 上游镜像（尤其带凭据协议的中文源）不能作为售卖标的 → AD-16
- 个人信息基本不涉及；科研数据是否落「重要数据」不在产品层判断，manifest 只提供计数与分类供人判断

## 八、门禁与验收（AD-12 风格，每条可红）

| # | 门禁 | 阴性对照 |
|---|---|---|
| G1 | **raw 覆盖率**：用 stub http/llm 跑全套 CLI e2e，断言 `raw/connector` 行数 == `api_calls.jsonl` 行数、`raw/llm` 行数 == `usage.jsonl` 行数 | 删掉 base.ts 埋点 → 红 |
| G2 | **脱敏**：带假 key 的 stub 调用后 grep raw 目录 | 去掉 redact → 红 |
| G3 | **链校验**：篡改 raw 任一行 → `verify()` 报 brokenAt | — |
| G4 | **journal 对账**：随机 create/update 序列后，重放 journal 得到的 records 与投影逐字段相等 | 任一 update 跳过 journal → 红 |
| G5 | **导出往返**：`export` → 空项目 `import` → records/边/journal 逐条相等，manifest rootHash 一致 | — |
| G6 | **AD-16**：`--for-sharing` 产物 grep 不到任何 `provenanceClass:"upstream"`；aminer 响应体 inline 不出现 | 改 shareable() 放行 upstream → 红 |
| G7 | **配置项有读者**（V40 门禁扩展）：`rawSink`/`rawLlm` 两个新 config 键必须在 config_reader_parity 里有消费方 | — |
| G8 | **叙事一致**：README/llms.txt 里对「原始数据」「可导出」「可共享」的每句声称对应 G1–G6 之一 | — |
| 验收 | 零上下文外部验收任务书加两步：跑完一课题后 `data export --for-sharing`，人工核 manifest 计数与排除理由；`data import` 到新项目后 `report export` 与原报告 diff 为空 | — |

## 九、与既有 BACKLOG 的交汇

| 条目 | 处理 |
|---|---|
| V24 完整性错误无恢复路径 | §5.1 `records repair` 关 |
| V30 删论文不可达 | §5.1 tombstone 关 |
| V49 deterministic 口径 | 不裁定口径，但进 `quality` 列，导出时可见 |
| V54 / V66 | 进 `quality` 列 |
| V63 rateLimitWaitMs | raw connector 行顺手带真实值（改 `ratelimit.ts` 返回形状） |
| V57 花钱路径验收 | 验收任务书加 export 两步（§八） |
| V76 staged connector | 新 connector 接入模板必须声明 license（§7.2 表是接入前置） |
| DESIGN.md §5.2 / AD 表 | 新增 AD-15、AD-16；§5.2 加「四层」图 |

## 十、波次与 lane（v0.7 内的位置由整合时定）

| 波次 | 内容 | 足迹（所有权） | 风险 |
|---|---|---|---|
| **W7-D0**（可夹带在 v0.7 首波） | L0 埋点 ×4 + `RawSink` 默认实现 + 脱敏 + 链 + G1/G2/G3；L3 三列与 §7.2 映射表 + 回填迁移 + G6/G7 | `connectors/base.ts` · `usage/ledger.ts` · `artifacts/store.ts`(一行) · `lab/wet_loop.ts`(一行) · **新目录 `backend/src/raw/`、`backend/src/provenance/`** · `project/{manager,records,models}.ts`(加列/加路径) | 低——全是加法；唯一语义变更是 `create()` 缺 provenanceClass 拒绝（清扫 10 个写入模块，门禁 G1 兜底） |
| **W7-D1** | `records_journal` + `history` + `repair` + tombstone + G4；V24/V30 关 | `project/records.ts` · `literature/library.ts` · `report/cli.ts` · `server/routes/records.ts` | 中——碰 update() 内部但不碰调用方；D-9 完整性核验回归必跑（`tests/unit/lab_*`） |
| **W7-D2** | `data export/import` + manifest + DuckDB 文档 + Parquet 探测 + G5/G8 + 验收任务书两步 | 新 `backend/src/data/` · `index.ts`(一条 case) · README/llms.txt/INSTALL | 中——二进制冒烟要加 export 路径（V27 家族） |
| 后续版本 | S3 `ExportTarget`、归档压缩、回流通道与计费、Delta Sharing 风格只读端点 | — | — |

三波都要：六套件 + 二进制冒烟 + 消费方清扫（纪律 13）+ 单一合并权（纪律 14）。

## 十一、风险

| 风险 | 缓解 |
|---|---|
| 磁盘增长（LLM 原文 + 响应体） | §4.3 阈值落 blob + 去重；`data archive`；估算一课题 < 50 MB，先不做压缩，R3 后用真实数据定 |
| 同步写 jsonl 拖慢热路径 | 单行 append 走 `appendFileSync`，R1 实测 connector 单次 200–900 ms，写盘 < 1 ms 可忽略；LLM 同理 |
| 用户隐私（desc/notes 进 raw） | raw 与 records 同目录同权限（0700），不增加暴露面；`--for-sharing` 不自动放行 user_authored 的敏感项——v0.7 先全放行，字段留着，售卖阶段再定敏感项规则 |
| `create()` 拒绝缺 provenanceClass 会让外部扩展的旧写入方红 | 扩展契约测试更新 + 一个版本的 deprecation warning 而不是直接拒（与 V21 废弃周期口径一致） |
| （原）Parquet 在二进制里不可用 | v0.7 不做 Parquet，风险消失；JSONL 永远可用 |
| 凭据源 raw 响应体存了 ToS 不允许的内容 | §7.2：凭据源默认只存 hash 不存 inline；`config set rawUpstreamInline on` 才存，且永不进 for-sharing |

## 十二、开放问题 —— 已于 2026-09-11 全部落定（答案见 §〇）

| # | 问题 | 结论 | 谁定 |
|---|---|---|---|
| 1 | raw 默认开/关 | 默认开、只在本地 | 用户 |
| 2 | LLM 原文保留期 | 永久 | 用户 |
| 3 | Parquet | 不做，JSONL + DuckDB | 用户 |
| 4 | 共享单位 | 项目为单位，时间窗只作增量，链式 manifest；类型切片不支持 | 主会话分析（§7.5），用户授权 |
| 5 | 售卖许可文本 | 售卖不开发；接口对齐 Delta Sharing / DCAT / SPDX | 用户（方向）+ 主会话（对齐对象） |
| 6 | raw/kernel 镜像还是引用 | 引用 + contentHash | 用户未定，主会话裁定（§4.1 注） |

**仍开放（入库整理时再问）**：`LicenseRef-spark-user-owned` 的真实许可文本——不影响 v0.7 实现。

---

## 附 · 不做什么、为什么（免得下次再论）

- **不做事件溯源全量重放**：状态机（湿实验 D-9、CAS）建在可变投影上，重放要重写 9 处调用方，收益配不上；journal 已满足审计与恢复
- **不换 SQLite**：热层查询模式（图遍历、CAS）SQLite 足够；lakehouse 是导出层的事
- **不内置 S3 SDK**：本地化优先；导出到目录后用户自己 `aws s3 sync`
- **不做脱敏共享**：那是通道期的产品决策，v0.7 只保证「能判定、能排除、能审计」
