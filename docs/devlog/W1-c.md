# W1-c · X-b 声明式 connector manifest（v0.4 P15）

lane：`W1-c`（波次 W1，第 3 条）· 模型：Opus 5 · 分支：`feat/W1-c` · 目标分支：`feat/P15-integration`（不推送、不开 PR）

## 交付了什么

- `backend/src/connectors/manifest.ts`（新建）：manifest schema 类型 + 编译期校验
  （`validateManifest`）+ SSRF 出站 URL 白名单（`assertOutboundUrlAllowed`）+ 受限响应映射
  DSL（`evaluateRestrictedPath` / `assertRestrictedPathSyntax`）+ 编译器
  （`compileManifest` / `loadManifestFromJson`），把 `ConnectorManifest` 编译成一个
  `HttpConnector` 实例（`ManifestConnector` 子类，**复用 base.ts 的既有基类，没有新造
  连接器体系**）。
- `tests/unit/connector_manifest.test.ts`（新建）：49 个测试，覆盖 schema 校验、SSRF 白名单、
  受限 DSL、三条表达力硬约束的验收用例、并发不变式复现。
- `tests/fixtures/manifests/**`（新建）：
  - `example.manifest.json` —— GET+path / GET+query / POST+body / defaults / mapTo 的通用正向示例
  - `biorxiv.manifest.json` —— 硬约束 #1（枚举参数）验收用例
  - `opentargets.manifest.json` —— 硬约束 #3（多实体拆分）验收用例
  - `bindingdb-boundary.manifest.json` —— 硬约束 #2（响应体分支边界）的可运行文档
  - `ssrf-blocked/file-url.manifest.json`、`ssrf-blocked/internal-ip.manifest.json` —— SSRF 阴性对照素材
- `tests/unit/narrative_parity.test.ts`：只加了一条 `ALLOWED_ORPHANS` 登记（见下方「孤儿门禁」节），未动断言逻辑。
- 本文件。

## Schema 形状

```ts
interface ConnectorManifest {
  id: string;                 // connector 注册名
  baseUrl: string;            // 编译期过 SSRF 白名单
  description: string;
  tools: ManifestTool[];
  metadata?: { domain: string; apiKeyRequired: boolean; caveat?: string };
}

interface ManifestTool {
  name: string;
  description: string;
  endpoint: string;                          // 相对路径或绝对 URL（绝对 URL 也过 SSRF 白名单）
  method?: "GET" | "POST";
  responseType?: "json" | "text";
  params?: Record<string, ManifestParamSpec>; // 声明式参数校验/改名
  defaults?: Record<string, string|number|boolean>; // 恒定附加参数
  normalize?: Record<string, string>;         // 输出字段名 → 受限路径字符串
}

interface ManifestParamSpec {
  type: "string" | "number" | "boolean" | "enum";
  default?: string | number | boolean;
  required?: boolean;
  enum?: string[];       // type === "enum" 时必填且非空
  mapTo?: string;        // 发给上游时用的 key 名（入参改名，如 query → term）
}
```

编译流程：`compileManifest(manifest, options)` → `validateManifest` 全量校验（含 SSRF、
enum 声明完整性、DSL 语法）→ `new ManifestConnector(manifest, options)`。`ManifestConnector`
构造期把每个 `tools[]` 条目编译成 `HttpConnectorConfig.tools` 里的一条 `HttpTool`（喂给
base.ts 原有的 URL 拼装/请求逻辑），并对每个 tool 调用 `this.handle(tool.name, fn)` 注册
一条 handler——**这一步就是方案 §4.5 要求"显式利用 D-1 红利"的落地**：`handle()` 写入的是
base.ts 那张构造期一次性写入、运行期只读的表，本文件的编译器没有引入任何新的跨调用共享
可变状态（`fn` 闭包只捕获不可变的 `tool` 声明对象 + 每次调用各自的局部变量）。

## 映射 DSL 的边界

**能表达**：
- 参数级：类型校验（string/number/boolean）、枚举校验（硬约束 #1）、必填/默认值、
  改名（`mapTo`）、恒定附加参数（`defaults`）。
- 响应级：从固定形状的 JSON 里按路径取一个字段，路径语法是 `标识符(.标识符|[数字])*` 的
  受限子集（`a.b[0].c` 这类），支持嵌套对象与数组下标。

**表达不了、且刻意不做**：
- **响应体分支**（硬约束 #2）：`normalize` 的值类型就是一个路径字符串，语法上没有
  if/else、没有"按响应内容切换取法"的能力。BindingDB 无匹配返回 200 + 空 body，manifest
  只会按声明路径取值，取不到就是 `undefined`——不会、也不该猜"这是空结果还是上游错误"。
  `tests/fixtures/manifests/bindingdb-boundary.manifest.json` + 配套两个测试把这条边界
  写成了可运行的文档：一个展示空 body 直接导致 JSON 解析失败（异常），另一个展示 `{}`
  响应下 normalize 静默给出 `undefined`——**两种情况长得一模一样，manifest 结构上无法区分**。
- **通配符 / 递归下降 / 过滤表达式 / 函数调用**：`assertRestrictedPathSyntax` 在编译期
  直接拒绝 `a.*.b`、`a..b`、`a[?(@.x>1)]`、`fn(a)` 这类写法。
- **一次 fetch 查多实体**（硬约束 #3）：结构上是硬约束 #2 的另一种表现——如果 OpenTargets
  用一个 `entityType` 枚举参数把 target/disease/drug 揉进一个 tool，编译期的枚举校验能过，
  但三类实体响应形状不同，`normalize` 是"一个 tool 对应一份固定映射"，没有"按参数值切换
  映射表"的语法。所以进 manifest 必须拆成 `getTarget` / `getDisease` / `getDrug` 三个
  独立 tool 声明，各自固定 endpoint + normalize（见 `opentargets.manifest.json`）。

**什么时候该换 TS 扩展**：凡是需要"读响应内容再决定怎么解释"的场景（200 vs 200+空体、
字段存在与否切换取法、跨响应关联、重试/分页游标之类的控制流）——manifest 表达不了就该
写 TS 扩展，这是**特性不是缺陷**：DSL 一旦长出 if/else 就是在重新发明一门脚本语言，
是本 lane 明确要避免的方向（方案原话）。三种装载强度并存正是为此。

## SSRF 防护规则

`assertOutboundUrlAllowed(url)`：
- 协议白名单：只允许 `http:` / `https:`（拒 `file:` / `ftp:` / `data:` / `javascript:` 等）。
- 主机名黑名单（字面量匹配，不做 DNS 解析）：
  - `localhost` / `*.localhost` / `*.local` / `*.internal`
  - IPv4：`127.0.0.0/8`（loopback）、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`（私网）、
    `169.254.0.0/16`（link-local，含云 metadata `169.254.169.254`）、`0.0.0.0/8`、
    `100.64.0.0/10`（CGNAT）
  - IPv6：`::1`、`::`（loopback/unspecified）、`fc00::/7`（unique local）、`fe80::/10`
    （link-local）、以及 IPv4-mapped IPv6 的两种规范化形式（点分十进制 `::ffff:127.0.0.1`
    与 WHATWG URL 解析器实际产出的十六进制分组形式 `::ffff:7f00:1`）

校验时机是**编译期**，对 `manifest.baseUrl` 以及任何以 `http` 开头的绝对 `tool.endpoint`
逐一校验。为什么编译期校验就足够（不需要每次调用都重新解析 URL）：base.ts 的
`requestRaw()` 对 `{param}` 路径占位符用 `encodeURIComponent` 替换、对查询参数用
`URLSearchParams.set()`——两条路径结构上都不可能让调用方传入的参数值把 scheme/host 改掉，
所以"baseUrl 干净 + 写死的绝对 endpoint 干净"就堵死了整条 SSRF 口子。

**已知限制**（如实记录）：这是字面量校验，不做 DNS 解析，挡不住"域名当时解析到公网 IP、
请求发出后才被 DNS rebinding 改指向内网"这类运行时攻击。要堵这个口子需要在实际发请求那层
（`backend/src/http/client.ts` 的 `NativeHttp`）做连接前 IP 复核，那个文件不在本 lane
的文件所有权范围内，留给后续（`ext verify` 或该文件的所有者判断是否值得做）。

## 三条表达力硬约束怎么满足的

| 约束 | 落地 | 验收位置 |
|---|---|---|
| #1 枚举校验 | `ManifestParamSpec.type === "enum"`，编译期要求非空 `enum[]`，调用期校验实际值 | `biorxiv.manifest.json` + `硬约束 #1` describe block |
| #2 响应体分支不追求覆盖 | `normalize` 语法收窄成无分支的路径字符串；文档+测试显式标注边界，不假装能覆盖 | `bindingdb-boundary.manifest.json` + `硬约束 #2` describe block |
| #3 多实体拆分 | 编译器不提供"一个 tool 多形状响应"的机制；OpenTargets 拆成 3 个独立 tool 声明 | `opentargets.manifest.json` + `硬约束 #3` describe block |

## 并发不变式

`ManifestConnector` 的并发安全性**不是本文件重新证明的**，是 base.ts D-1 契约的直接推论：
编译器往 `handlers` 表里写入的每个 handler 闭包只捕获不可变的 tool 声明 + 每次调用各自的
局部变量，不引入新的跨调用共享可变状态。`tests/unit/connector_manifest.test.ts` 最后一个
describe block（"manifest connector 并发不变式复现"）用与 `tests/concurrency/
connector_race.test.ts` 相同的手法（echo http + 串行/并行逐位比对）独立复现了这条断言，
**没有修改 connector_race.test.ts 本身**（该文件在本 lane 是只读参考）。

## 六套件数字

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 干净（两个 tsconfig 都过） |
| `bun test tests/unit/` | **1067 pass / 0 fail / 0 skip**（基线 1018 + 本 lane 新增 49，回归为零） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail |
| `bun run test:e2e`（`SPARK_E2E_PORT=4413`） | **13/13** |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |

## 阴性对照（实跑记录）

### ① SSRF：manifest 塞 `file://` / 内网地址 → 编译期被拒

测试套件（`describe("SSRF 出站 URL 白名单（阴性对照①）")`，24 个用例，覆盖
file:// / ftp:// / 全部私网段 / link-local / CGNAT / IPv6 三种形式 / localhost 变体 /
两个真实公网 URL 作为反向对照）：

```
$ bun test tests/unit/connector_manifest.test.ts -t "SSRF"
bun test v1.3.14 (0d9b296a)

 24 pass
 25 filtered out
 0 fail
 26 expect() calls
Ran 24 tests across 1 file. [29.00ms]
```

额外用一段独立脚本（不经测试框架，直接调用编译器）复现同样的结论：

```
$ bun -e '... compileManifest(evilFile/evilInternal/evilPrivate) ...'
[阴性对照①通过] file:// → 被拒绝: ManifestError: manifest 出站 URL 协议不在白名单（只允许 http/https）：协议是 "file:"，URL 是 "file:///etc/passwd"
[阴性对照①通过] 169.254.169.254 (cloud metadata) → 被拒绝: ManifestError: manifest 出站 URL 指向内网/保留地址段，已拒绝（SSRF 防护）：主机名是 "169.254.169.254"，URL 是 "http://169.254.169.254/latest/meta-data/"
[阴性对照①通过] 192.168.1.1 (私网) → 被拒绝: ManifestError: manifest 出站 URL 指向内网/保留地址段，已拒绝（SSRF 防护）：主机名是 "192.168.1.1"，URL 是 "http://192.168.1.1/admin"
```

### ② enum 参数给非法值 → 被拒，且从未发出任何 HTTP 请求

测试套件：

```
$ bun test tests/unit/connector_manifest.test.ts -t "枚举"
bun test v1.3.14 (0d9b296a)

 3 pass
 46 filtered out
 0 fail
 5 expect() calls
Ran 3 tests across 1 file. [20.00ms]
```

独立脚本（构造一个带 SQL-注入风格 payload 的枚举脏值，并在 StubHttp handler 里放一个
"如果真的走到这里就 throw"的哨兵，验证请求确实从未发出）：

```
$ bun -e '... connector.call("getDetails", { server: "eviladmin; DROP TABLE users;--", doi: "10.1101/x" }) ...'
[阴性对照②通过] 非法枚举值被拒绝: ManifestError: connector "biorxiv-manifest-demo" tool "getDetails"：参数 "server" 不在枚举取值内（只允许 biorxiv|medrxiv），收到 "eviladmin; DROP TABLE users;--"
[阴性对照②通过] 是否发出了任何 HTTP 请求: false
```

### ③ 并发不变式：把编译出的 handler 改成共享可变状态 → 并发测试红

临时（验证完立即回退，未进正式提交）在 `ManifestConnector.invoke()` 里引入一个跨调用
共享的实例字段 `raceState`，在 `await Promise.resolve()`（模拟真实网络 await 前的一次
事件循环让出）前后分别"写"和"读"这个共享字段，精确复现旧版 `__handlingTool` 那类竞态的
形状（写在 await 之前，读在 await 之后，读到的可能是别的并发调用覆盖过的值）：

```ts
private raceState: { toolName: string; mapped: Record<string, unknown> } | null = null;

private async invoke(tool, callerParams) {
  const mapped = { ...(tool.defaults ?? {}), ...callerParams };
  this.raceState = { toolName: tool.name, mapped };
  await Promise.resolve();                          // 让出一次事件循环
  const raced = this.raceState!;                     // 读共享字段：可能已被覆盖
  tool = this.toolSpecs.get(raced.toolName)!;
  Object.assign(mapped, raced.mapped);
  // ...后续逻辑不变
}
```

重跑并发测试，立刻红（且红得非常干脆——140 个并发 job 里，job#0 本该发出
`example.search` 的 GET 请求，实际发出的却是 job#139 的 `createThing` POST 请求体，
证明共享字段在多个并发调用的同步前缀之间被反复覆盖）：

```
$ bun test tests/unit/connector_manifest.test.ts -t "并发"
bun test v1.3.14 (0d9b296a)

tests/unit/connector_manifest.test.ts:
455 |       expect(parallel[i]).toEqual(serial[i]);
error: expect(received).toEqual(expected)

  {
-   "body": null,
+   "body": "{"format":"json","query":"alpha-0","limit":1,"kind":"a"}",
    "headers": {
      "Accept": "application/json",
+     "Content-Type": "application/json",
    },
-   "method": "GET",
-   "url": "https://api.example.org/v1/search?format=json&q=alpha-0&limit=1",
+   "method": "POST",
+   "url": "https://api.example.org/v1/things",
  }
(fail) manifest connector 并发不变式复现（同 connector_race.test.ts 断言写法） > 单实例 140 并发混合工具调用，结果与串行逐个调用逐位一致 [554.60ms]

(fail) manifest connector 并发不变式复现（同 connector_race.test.ts 断言写法） > 并发下 example.search 的 query→q mapTo / defaults.format 映射未被跳过 [8.48ms]
(fail) manifest connector 并发不变式复现（同 connector_race.test.ts 断言写法） > 并发下 biorxiv.getDetails 的 server 路径占位符替换未被跳过/串味 [8.40ms]

 0 pass
 46 filtered out
 3 fail
```

随后用备份文件（`cp` 而不是 git，避免误碰工作区其它未提交内容）整体回退这处临时改动，
`diff` 确认与原文件字节级一致，重跑 typecheck + 全部 49 个 manifest 单测 + 全量
`tests/unit/` 恢复绿：

```
$ cp /tmp/manifest.ts.orig_backup backend/src/connectors/manifest.ts
$ diff -q /tmp/manifest.ts.orig_backup backend/src/connectors/manifest.ts && echo "REVERTED OK"
REVERTED OK

$ bun run typecheck
$ tsc --noEmit && tsc --noEmit -p frontend/workspace/tsconfig.json
(干净)

$ bun test tests/unit/connector_manifest.test.ts
 49 pass
 0 fail
```

## 孤儿门禁

`backend/src/connectors/manifest.ts` 在本分支上没有生产调用方（只有
`tests/unit/connector_manifest.test.ts` 引用它）——它的消费方是 **W2-c 的扩展装载器**
（方案 §5·补.1 依赖图：`X-b 声明式 connector manifest → W2-c X-a 扩展装载 + ext verify`
虽标注"零跨依赖，随时可开"，但实际接线权在 W2-c）。已按 §5.3·补 的模板在
`tests/unit/narrative_parity.test.ts` 的 `ALLOWED_ORPHANS` 加了一条"等接线"登记，
**只加了这一条，没有改动任何断言逻辑**。

## 交接说明

### 给 W2-c（扩展装载器）

- 唯一入口是 `backend/src/connectors/manifest.ts` 导出的 `compileManifest(manifest,
  options?)` 与 `loadManifestFromJson(json, options?)`——两者都返回一个普通
  `HttpConnector` 实例（准确说是其子类 `ManifestConnector`，但对外只暴露基类接口），
  可以直接喂给 `ConnectorRegistry`（参考 `registry.ts` 已有的 `registerCustom(name,
  config)`，用法形状一致：拿到 connector 后 `registry.connectors.set(name, connector)`
  或走一个新的 `registerManifest` 方法——`registry.ts` 不在本 lane 名下，接线细节由
  W2-c 决定）。
- **接线后请删除** `tests/unit/narrative_parity.test.ts` 里 `manifest.ts` 那条
  `ALLOWED_ORPHANS` 登记——门禁的对称检查会在你忘记删的时候变红提醒你。
- 三种装载强度的边界判断（"这个源该用 manifest 还是该写 TS 扩展"）已经写成了本文件上面
  「映射 DSL 的边界」一节 + `manifest.ts` 文件头部的大段注释 + 三个对应的 fixture/测试，
  `ext verify` 的契约化验收可以直接引用这几条判据，不需要重新调研。
- `ManifestError` 是所有 schema/SSRF/DSL/运行期参数校验失败的统一错误类型，`ext verify`
  如果要做"manifest 加载失败要不要算契约违反"的判定，认这一个类型就够了。

### 给 W3-d（arXiv/PubMed 走 manifest）

- `tests/fixtures/manifests/biorxiv.manifest.json` 与
  `tests/fixtures/manifests/example.manifest.json` 是两个可以直接照抄结构的参考：
  path 参数 + query 参数 + enum 校验 + POST body 的写法都在这两个文件里有实例。
- **务必先看一眼现有的 `backend/src/connectors/literature.ts`**：arXiv 现在的
  `search()` 有一个不算复杂但确实是"改名 + 拼前缀"的映射（`query` → `search_query`
  且要拼 `all:` 前缀，见 `arXivConnector.search()`），这个**不能**用当前的
  `ManifestParamSpec`（只有直接改名 `mapTo`，没有"改名 + 拼字符串前缀"的能力）表达——
  要么在 manifest schema 里加一个受限的"字符串模板"能力（如 `template: "all:{value}"`，
  同样要收窄语法、不能变成任意字符串拼接/函数），要么 arXiv 的 `search` 工具继续留在 TS
  扩展、其余工具（如 `getPaper`）走 manifest。判断哪种更合适是 W3-d 的范围，这里只标出
  这个具体的表达力缺口，免得到时候重新发现一遍。
- PubMed 的 `query` → `term` 改名是纯改名（无前缀拼接），`mapTo` 直接够用。
- arXiv/PubMed 都是免 key（`apiKeyRequired: false`），两个 manifest 的 `metadata.caveat`
  建议照抄 `backend/src/connectors/literature.ts` 里已有的 caveat 文案（如果有的话），
  保持 `capabilities --json` 输出的措辞一致——这属于纪律 13 的消费方清扫范围，但
  `capabilities/` 不在本 lane 名下，未做验证，请 W3-d 落地时自查。

## 已知未完成 / 诚实报告

- SSRF 白名单是字面量校验，不防 DNS rebinding（见上文「已知限制」）——如实记录，未实现，
  留给后续判断是否值得做（涉及 `backend/src/http/client.ts`，不在本 lane 文件所有权内）。
- 映射 DSL 没有"字符串模板/前缀拼接"能力，arXiv 的 `search_query=all:{value}` 这类场景
  表达不了（见上方"给 W3-d"一节）——这是刻意的（避免 DSL 长出字符串处理函数），但如实
  记录为一个已知的表达力缺口，不是遗漏。
- 没有对 manifest 做"重复 baseUrl 但不同 id"之类的跨 manifest 一致性检查（如果后续 W2-c
  要批量加载一个目录下的多个 manifest 文件，可能需要在装载器层面做去重/冲突检测——这属于
  装载器的职责，不是编译器的，本 lane 没有做，也不该做）。
