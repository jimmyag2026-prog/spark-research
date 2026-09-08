# P1 · Project 基座（devlog 草稿）

> 分支：`feat/p1-project-foundation` · 日期：2026-09-09
> 范围依据：[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md) 「P1 Project 基座」；设计依据：[DESIGN.md](../DESIGN.md) §5（AD-1/AD-2/AD-3）+ 域 C1

## 一、做了什么

### 1. `backend/src/project/` —— Project 管理器
- `models.ts`：Project 元数据 + Research Record 的类型定义（7 种 record 类型、5 种边、4 种证据标签、5 种 origin kind）。
- `slug.ts`：slug 规则单独成模块（`^[a-z0-9][a-z0-9._-]{0,63}$`）。slug 直接参与路径拼接，`../` 之类一律拒绝；`slugify()` 负责把自由字符串归一化。独立成模块是为了让 `artifacts/store.ts` 复用而不与 `project/manager.ts` 形成循环依赖。
- `manager.ts`：`ProjectManager`（create / open / openOrCreate / list / archive / unarchive）+ `Project` 句柄（惰性打开 records/artifacts 存储，`close()` 释放句柄）。目录布局：
  ```
  <root>/state.json                       当前项目 + session→project 归属
  <root>/projects/<slug>/project.json     元数据（schemaVersion/slug/name/description/status/时间戳）
                        records.db        Research Record（本阶段落地）
                        library.db        文献库（P2 落地，仅预留路径）
                        artifacts/        artifact 本体 + artifacts.db
                        papers/ experiments/
  ```
  root 通过构造参数注入，默认 `SPARK_RESEARCH_DATA_DIR ?? ~/.spark-research`（沿用 `server/app.ts` 已有的环境变量，不新造名字）。测试全部走 `mkdtempSync`，零 homedir 写入。
- `cli.ts`：`runProjectCommand(args, deps)` 返回退出码，输出经注入的 `out/err`，可直接单测；`index.ts` 只做一层转发。

### 2. `records.db` schema + RecordStore
- `schema.sql`：`records`（type/title/content/evidence/origin_kind/origin_ref/origin_connector/session_id/artifact_id/metadata/created_at）+ `record_edges`（source/target/type，主键三元组，FK ON DELETE CASCADE）。
- `records.ts`：`RecordStore.create/get/list/count/link/edgesOf/listEdges/graph/createFromArtifact/close`。
  - 写入校验：未知 record 类型、未知证据标签、未知 origin kind、未知边类型、自环、悬空端点全部抛 `RecordValidationError`。
  - `type === "artifact"` 强制要求 `artifactId`（AD-3 不允许断链）。
  - `graph(rootId, depth)` 从任意 record 双向 BFS 展开，返回可直接渲染的 nodes/edges（P7 时间线与 P8 报告导出的地基）。

### 3. 凭据服务（AD-2）
- `backend/src/daemon/credentials.ts`：`CredentialStore` 读写 `<root>/credentials.json`，按 connector id 存取。
  - 写入：目录 0700、文件 0600；`writeFileSync` 的 `mode` 只在创建时生效，故额外显式 `chmodSync`。
  - 读取：`checkPermissions()` 校验，权限宽于 0600 时告警（告警文案只含路径与权限位，不含任何值），但不阻断读取——不把用户锁在门外。
  - 泄露面收敛：`describe()/list()/toJSON()` 只给 connector id、字段名、时间戳；JSON 解析失败的错误消息不带文件内容。
- daemon 接线：`SparkResearchDaemon.credentials` 是唯一持凭据的入口；`dispatch("credentials")` 改为返回 `credentialStatus()`——`{ok, connector, configured, keys, note}`，**没有值**。原来路由到 `llm.credentials()` 的 mock 实现已删除。

### 4. CLI 与 session 归属
- `spark-research project new <slug> [--name] [--desc] | list [--all] | open <slug> | archive <slug>`。
- `ProjectManager.projectForSession(sessionId)`：已绑定且项目仍在 → 用绑定；否则落到默认项目（当前项目，没有就是 `default`，按需创建）并写回绑定。
- `OrchestratorAgent` 新增可选 `projects` 依赖：`processRequest` 开头解析归属并记录到执行日志，结果新增 `projectSlug` 字段；未注入 ProjectManager 时 `projectSlug` 为 `null`，行为与 P0 完全一致。
- 附带收益：orchestrator 未显式注入 artifact store 时，review 环节退到「session 所属 project 的 artifact 存储」。

### 5. artifact 的 `project` 字段接真实 project 引用
- `artifacts` 表新增 `project_slug` 列；`ArtifactStore` 新增 `ArtifactStoreOptions{projectSlug, projects}`、`listByProjectSlug()`、`close()`。
- 老库迁移：`initSchema()` 后跑 `migrate()`——`PRAGMA table_info` 查列，缺则 `ALTER TABLE` 补列并逐行回填（有解析器问解析器，否则 `slugify`，都不行留 `null`），最后建索引。索引不能写进 `schema.sql`，因为老库要先补列才能建索引。
- 兼容性：`project` 自由字符串列原样保留，`save()` 的第 5 个参数变成可选（默认取绑定的 slug），旧调用点一行没改。

## 二、关键实现决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | `credentials` daemon 方法只回元数据，不回值 | 现有 permit set 里 `python_kernel` 是**有** `credentials` permit 的。若该方法回值，等于给沙箱开了口子，直接违反 AD-2。改成「permit 控制能否问、方法本身决定回什么」双保险：无 permit 连元数据都拿不到，有 permit 也只拿到 `configured/keys` |
| D2 | slug 规则独立成 `slug.ts` | `artifacts/store.ts` 需要 `slugify` 做迁移回填，而 `project/manager.ts` 依赖 `ArtifactStore`；不拆就是循环依赖 |
| D3 | `ArtifactStore` 用结构化接口 `ProjectRefResolver` 而不是 import `ProjectManager` | 同上，保持 artifacts 层对 project 层零依赖，也方便测试注入假解析器 |
| D4 | 新增 `project_slug` 列而不是原地改 `project` 列语义 | 原地改会让旧数据的自由字符串变成假的「引用」；分列后旧值可查、新引用可信，迁移可回滚 |
| D5 | session→project 归属放根目录 `state.json`，不放 project 内 | 查询方向是「给 sessionId 找 project」，放项目内要扫全部项目 |
| D6 | Record 只增不删（无 delete API） | ELN 语义：研究记录是审计证据，作废用 `supersedes` 边表达而不是物理删除 |
| D7 | 权限过宽只告警不抛错 | 抛错会让用户在一次 `chmod` 失误后完全用不了工具；告警 + 明确修复指令（`chmod 600`）更合适 |
| D8 | `ProjectManager` 不由 daemon 默认构造 | 构造即 `mkdirSync`；默认构造会让每个单测都在 homedir 建目录。改为显式注入，daemon 的 `projects` 是可选字段 |

## 三、测试结果

```
$ bun run typecheck
（无输出，clean）

$ bun test tests/unit/
 125 pass
 0 fail
 449 expect() calls
Ran 125 tests across 12 files. [290.00ms]
```

- 基线 84 个测试一个没动、全绿；新增 **41** 个：
  - `tests/unit/project.test.ts` 30 个：ProjectManager 生命周期（含非法 slug/路径穿越、重复创建、归档往返）、session 归属（显式绑定 / 未绑定落默认 / 绑定项目被删的降级 / orchestrator 三例）、RecordStore（7 类型 × 5 边 × 过滤 × 图展开 × 校验拒绝 × 幂等建边）、record↔artifact 互链、artifact project 引用（含**老库迁移**：手工建一个无 `project_slug` 列的库 → 打开 → 断言旧行可读且回填正确 → 断言迁移后仍可写）、CLI 全流程与错误路径。
  - `tests/unit/credentials.test.ts` 11 个：0600 权限断言、按 connector 存取、元数据不含值、权限过宽告警（且告警文案不含值）、删除、持久化、**permit 拦截**（control_repl 无 `credentials` permit → `PermissionDeniedError`）、有 permit 的 python kernel 也只拿到元数据、执行日志不落值、daemon 内部仍可取值。
- e2e 持久化往返（`project.test.ts` 最后一个 describe）：CLI 建项目 → 绑定 session → 写 1 个 artifact + 5 条 record + 4 条边 → `close()` 模拟进程退出 → 新 `ProjectManager` 重开 → 断言 session 绑定、record 计数、边计数、证据子图节点集合、artifact 内容与 `projectSlug`、跨表引用全部完整。
- CLI 冒烟（手工，`SPARK_RESEARCH_DATA_DIR` 指向临时目录）：`project new/list/open/archive` 输出与目录布局均符合预期。
- 凭据纪律：新增文件跑过密钥 grep，测试里所有凭据值都是 `fake-*` 假值。

## 四、与设计的偏差

1. **AD-2 的落地口径细化**（已同步进 DESIGN.md 表格）：设计只说「kernel 拿不到凭据本体」，但现有 permit set 给了 `python_kernel` 一个 `credentials` permit。本阶段把该方法的返回体限定为元数据，permit 保留原样——没动 permit 集合是为了不影响 P0 已有的权限矩阵测试；如果主会话认为 `credentials` 根本不该出现在 kernel permit 里，可以在 P2 一并收掉（届时要改 `PERMIT_SETS` 与 `daemon.test.ts` 的两条断言）。
2. **存储布局补两个未在设计树里出现的文件**（已同步进 DESIGN.md §5.1）：根目录 `state.json`（当前项目 + session 归属）、`artifacts/artifacts.db`（artifact 元数据库，设计树只画到 `artifacts/`）。
3. **`library.db` 本阶段只预留路径不建库**：P2 文献域才有 schema，提前建空库没有意义。
4. **artifact 的 `project` 字段没有硬切成引用**，而是「保留旧列 + 新增 `project_slug` 引用列」。设计原文是「从自由字符串变为真实 project 引用」，硬切会破坏向后兼容，故按 D4 分列实现。

## 五、留给后续阶段的钩子

- `RecordStore.graph()` 已经能吐 nodes/edges，P7 时间线与 P8 报告导出可直接消费。
- `Project.paths.libraryDb` 已就位，P2 建 `library.db` 时不用再动目录布局。
- `CredentialStore.get()` 是 P2 AMiner connector 的取值入口；connector 侧要保证「无 key 时优雅降级」而不是抛错。
- `ArtifactStore` 的 `projects` 解析器接口留给 server 层：`server/app.ts` 目前仍用全局 `~/.spark-research/artifacts.db`，P7 前应切到按 project 打开。
