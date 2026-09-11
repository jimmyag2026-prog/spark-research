# W8-2 · runtime contract（`spark-research contract --json`）

**日期** 2026-09-12 · **分支** `feat/W8-2-contract` · **执行** 主会话（与 W8-1 六 lane 并行）

## 口径
SDK 是 HTTP/MCP 的薄投影（AD-7）；contract 是 `capabilities --json` 的可版本化子集。**全部从真源派生，不手写第二份**：

| 段 | 真源 | 派生方式 |
|---|---|---|
| CLI 命令/子命令/旗标 | `index.ts` 主 switch + 各模块导出的 `*_HELP` | `contract/cli_registry.ts` 登记 case 组 → `extractUsage()` 从 HELP 文本提取用法行（子命令、`<位置参数>`、`--旗标`，含缩进旗标说明行；`lit` 合并子命令级 HELP） |
| HTTP 路由 | 真实 `createApp().routes`（Hono 路由表，含 `route()` 挂载子路由） | 过滤 ALL 中间件、去重、排序；`group` = `/api/<组>` |
| HTTP/导出 manifest schema | `server/types.ts` · `data/manifest.ts` 的 TS 接口 | **构建期** `scripts/gen-contract-schemas.ts`（TS checker → JSON Schema 子集：对象/可选/联合→enum·anyOf/数组/索引签名/字面量/`$ref`）写 `contract/schemas.generated.json`，运行期静态 import（不把 typescript 打进二进制） |
| MCP 工具 | `MCP_TOOLS` | name/description/inputSchema/longRunning |
| 配置项 | `CONFIG_SETTINGS` | spec 不带值；`secret` 项 defaultValue 置 null |

输出确定性：无时间戳、所有列表排序，两次生成逐字节相等（SDK 生成器依赖）。

## 改动
- 新增 `backend/src/contract/{index,cli,cli_registry,help}.ts`、`schemas.generated.json`；`scripts/gen-contract-schemas.ts`。
- `index.ts`：`case "contract"` + 主 HELP 一行。`cli/usage.ts` / `extensions/cli.ts` 的 `HELP` 常量导出为 `USAGE_HELP` / `EXT_HELP`（注册表引用）。
- `.github/workflows/release.yml`：build 后 `./dist/spark-research contract --write dist/contract.json` 并挂到 Release assets。
- 测试文件名 `tests/unit/runtime_contract.test.ts`——仓库已有 `contract.test.ts`（扩展契约验收，W5-2），我第一版误覆盖了它、单测从 2296 掉到 2283 才发现；已 `git checkout` 还原。

## 门禁（`tests/unit/runtime_contract.test.ts` 12 条）
1. 注册表命令∪别名 == index.ts 主 switch case 集合（逐项相等）
2. 无独立 HELP 的命令：登记的 usage 行逐字出现在 index.ts
3. `extractUsage` 确定性提取 + 幂等
4. 带 HELP 的命令至少一条用法行；`lit review` 的 `--budget-usd/--allow-unpriced`（只在子命令 HELP）被合并
5. MCP 名/inputSchema/longRunning 与 `MCP_TOOLS` 逐项相等
6. **MCP 是 HTTP 的投影**：每个工具 `request(dummyArgs)` 的 method+path 命中契约路由（`:param` 通配）
7. HTTP 路由 ≥70、无重复、已排序、含 health 与八个组
8. 配置键集合 == CONFIG_SETTINGS；secret 无值；全文无 `sk-` 形状
9. manifest schema：`schemaVersion.const == MANIFEST_SCHEMA_VERSION`，13 个必填齐全
10. `schemas.generated.json` 重新生成逐字节相等（llms.txt 同款幂等）
11. 两次 `buildContract` 逐字节相等
12. CLI：`--json` 可解析、`--write` 落盘（建目录）、无参打计数、`--write` 缺路径 → 1

## 阴性对照（实跑）
| 改法 | 结果 |
|---|---|
| index.ts `case "doctor"` 改名 | 第 1 条红（10 pass / 2 fail） |
| MCP `research_capabilities` 的 path 改成 `/api/capabilities-nope` | 第 6 条红（11/1） |
| `server/types.ts` 追加一个接口不重跑生成器 | 第 10 条红（10/2） |
| 还原 | 12/12 |
注：仅改 MCP 工具名不会红（契约本就从 MCP_TOOLS 派生，是同源）——对撞的意义在 6（跨源），如实记。

## 六套件（contract worktree，退出码口径）
typecheck 0 · unit 见 PR（≥ 2296+12）· concurrency+timeout 35/0 · e2e 20 rc=0 · py rc=0 · lab rc=0 · 二进制冒烟 rc=0；**编译后的二进制 `contract --json` 可用**（routes 78 · tools 30 · definitions 27）。

## 未做 / 留给 SDK lane
- 请求体 schema：Hono 路由手写 `body` 解析，没有运行期校验器可派生；契约只带响应/记录类型（`server/types.ts`）与 MCP inputSchema（每个工具的 request 已经是「路由 + body 形状」的真源，SDK 生成器优先从 MCP 工具反推请求形状）。
- `init`/`demo`/`version`/`welcome` 主 HELP 无用法行，契约里 usages 为空（如实）。
