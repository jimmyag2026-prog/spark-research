# W2-c · X-a 扩展装载 + `ext verify`（v0.4 P17，AD-11 的落点）

lane：`W2-c`（波次 W2，第 3 条）· 模型：Opus 5 · 分支：`feat/W2-c`

## 交付了什么

- `backend/src/extensions/types.ts`（新建）：`ExtensionManifest`（`extension.json`）
  schema + `validateExtensionManifest`/`loadExtensionManifest`。
- `backend/src/extensions/paths.ts`（新建）：扩展相关路径解析，复用
  `config/index.ts` 的 `dataDir()` 同一口径（env `SPARK_RESEARCH_DATA_DIR` >
  `~/.spark-research`），不另起一套。
- `backend/src/extensions/fingerprint.ts`（新建）：TS 扩展（强度②）的
  sha256 信任指纹，TOFU（trust-on-first-use）模型。
- `backend/src/extensions/grants.ts`（新建）：凭据 / ToolBus 工具的授权账本
  （`ExtensionGrantStore`），落盘 `extensions/.grants.json`。
- `backend/src/extensions/context.ts`（新建）：`buildExtensionContext()`——
  恶意矩阵①②的结构性拒绝点。
- `backend/src/extensions/connector_verify.ts` / `platform_verify.ts` /
  `rule_verify.ts` / `skill_verify.ts`（新建）：四类扩展各自的 `ext verify` 逻辑。
- `backend/src/extensions/verify.ts`（新建）：按 kind 分发 verify，
  `formatVerifyResult()` 供 CLI 打印。
- `backend/src/extensions/verify_cache.ts`（新建）：`ext verify` 结论缓存，
  恶意矩阵⑤（未过 verify 装载时警告）的落点。
- `backend/src/extensions/loader.ts`（新建）：`loadExtension()`——装载器主体，
  三种强度 + 恶意矩阵①②③④⑤全部在这里或它直接调用的模块里落地。
- `backend/src/extensions/capabilities.ts`（新建）：`listExtensionCapabilities()`，
  导出给主会话接线用，本 lane 不碰 `backend/src/capabilities/**`。
- `backend/src/extensions/cli.ts`（新建）：`runExtCommand()`——`ext list / verify /
  load / grant / revoke` 五个子命令。
- `backend/src/index.ts`：只加了一个 `case "ext":`（转交 `runExtCommand`）+
  `HELP` 里补一行 `ext` 的说明。没有动任何其它命令的逻辑。
- `tests/unit/extensions.test.ts`（新建）：44 个测试，覆盖 schema / 装载三强度 /
  信任指纹 TOFU / 授权账本 / 恶意矩阵①-⑤ / 阴性对照①② / 四类 `ext verify` /
  capabilities / CLI。
- `tests/fixtures/extensions/**`（新建）：`good-connector` / `malicious-ssrf-connector`
  / `good-rule` / `malicious-io-rule` / `throwing-extension` / `good-skill`
  （含 `tests/hello.test.ts`）/ `good-platform`（含 `runner.py` + `contract.json`）/
  `good-backend`。
- `tests/unit/narrative_parity.test.ts`：删除了 `backend/src/connectors/manifest.ts`
  的 `ALLOWED_ORPHANS` 登记（本 lane 已经真实调用它，接线完成，按对称检查删除），
  新增 `backend/src/extensions/capabilities.ts` 的一条"等接线"登记（见下方"给主会话
  的接线说明"）。
- `docs/EXTENDING.md`：新增 §8「扩展装载」+ §9「`ext verify`」两节，原 §8「提交前
  自查」改号为 §10（内容不变）。
- `llms-full.txt`（机械重新生成，未手改任何生成脚本）：改了 `docs/EXTENDING.md`
  之后 `bun test tests/unit/llms_txt.test.ts` 的幂等门会红（"生成物与仓库里已
  提交的文件一致"），按该测试给出的指令跑了一遍 `bun scripts/gen-llms-txt.ts`——
  `scripts/gen-llms-txt.ts` 本身不在本 lane 名下，**没有改动这个脚本**，只是
  运行它产出的确定性重新生成结果；`llms.txt`（索引，不含 EXTENDING 正文）无变化。
- 本文件。

## 装载器架构

```
extension.json（manifest：kind/name/version/entry/requires）
        │
        ├─ kind="connector" ──→ connector.json ──→ loadManifestFromJson()（W1-c，只读复用）
        │                                          → HttpConnector 实例，不执行任意代码
        │
        └─ kind∈{skill,platform,backend,rule} ──→ index.ts
                     │
                     ├─ checkTrust()（TOFU：没记录/内容变了 + 无 --trust → 拒绝）
                     ├─ ExtensionGrantStore.get(name) → buildExtensionContext(manifest, grant, deps)
                     └─ await import(entryPath)（try/catch 兜底——恶意矩阵④）
```

`loadExtension()` 的返回值是一个纯数据结构（`LoadedExtension`：`status` /
`reason` / `warnings` / 可选的 `connector` / `context` / `module`），**不**自己
决定"装载完了要不要调用某个注册函数"——`module` 导出什么、怎么把 `context` 递给
它，是调用方（daemon/orchestrator）的职责，这些文件不在本 lane 名下（见下方
「已知未完成」）。

## `ext verify` 四类扩展各自跑什么

| kind | 跑什么 | 复用的既有投资 |
|---|---|---|
| `connector` | 100 并发参数映射一致性（echo http + 串行/并行逐位比对）+ 凭据不进出站请求 + 错误消息不回显响应体 | `tests/concurrency/connector_race.test.ts` 的手法（不是 import 那个文件本身——它对三个内置 connector 写死，不能直接跑在任意第三方 manifest 上；复用的是**手法**）+ W1-c 的 `assertOutboundUrlAllowed`/`validateManifest`（`loadManifestFromJson` 直接调用，装载路径真的会走到） |
| `platform` | 生成临时 `*.test.ts`，原样 `import { describeSimulationContract }` + 扩展的 `contract.json` 提供 spec 算例，spawn 一次 `bun test` 跑完整 13 条断言，解析退出码 | `tests/helpers/simulation_contract.ts`（一个字没重写） |
| `rule` | 静态扫描源码（`node:fs`/`fetch`/`Math.random()`/`Date.now()` 等疑似 IO/非确定性 token）+ 用扩展声明的 `VERIFY_SAMPLE_INPUT` 求值两次比对 | —— |
| `skill` | `SKILL.md` frontmatter 用 `backend/src/skills/frontmatter.ts` 的 `parseSkillFrontmatter`（P9 真源）校验 + `validation[]` 里每个 `*.test.ts` 实际 `bun test` 跑一遍 | P9 的 frontmatter 校验器 |
| `backend`（WetLabBackend） | **已知限制**：只做结构检查（能 `import`、导出 `{id, description, available(), execute()}`）。任务书的 verify 表格本身没列这一档，且真实契约测试（`wet_loop`/`wet_e2e`）依赖 `backend/src/lab/**`（不在本 lane 名下）与真实 `opentrons.simulate`，如实标注未覆盖，不假装 | —— |

## 安全边界的准确表述

**挡得住的：**
- 声明式 connector（强度①）不执行任意代码——`connector.json` 是数据，装载路径
  必经 W1-c 的 SSRF 白名单（协议/内网地址字面量拒绝）与 schema/DSL 校验。
- TS 扩展（强度②）首次装载（或内容变化后）必须显式 `--trust` 并看到 sha256 指纹
  才能执行——挡的是"没确认就被动执行"，不是"确认后代码不能作恶"。
- `ExtensionContext`（`context.ts`）结构性拒绝"manifest 未声明"或"声明了但未
  `ext grant`"的凭据/工具访问——**遵守约定**的扩展代码（通过 context 拿访问权）
  必然受此约束。
- 扩展在装载期（`await import()`）抛出的任何异常都被 `loader.ts` 的 try/catch
  兜住，返回 `status:"failed"`，不会向上传播砸穿调用方/主进程。
- 未过 `ext verify`（或验证结论已过期/未通过）的扩展装载时会打印显式 `⚠️` 警告
  （不阻断——理由见下方"不是沙箱"）。

**挡不住的（如实记录，不重蹈评审 S-3"沙箱一行逃逸"）：**
- **`--trust` 不是沙箱**。信任后的 TS 扩展与仓库代码同 UID、同权限，能做任何
  Node/Bun 进程能做的事——读写任意文件、发任意网络请求、`child_process.spawn`
  任意命令。`--trust` 挡的仅仅是"未经确认就被动执行"这一件事。
- **`ExtensionContext` 挡不住绕过 context 的访问**。它只约束"通过 context 这个
  通道"拿凭据/调工具的路径；TS 扩展如果自己 `import CredentialStore` 或直接
  `fetch()`，这条防线完全无效——因为它和仓库代码本来就是同一个进程、同一个权限。
- **`rule` verify 的静态扫描是黑名单式的**，挡得住"没注意到/没打算隐藏"的 IO，
  挡不住 `globalThis["fe"+"tch"]` 这类故意拼接字符串绕过正则匹配的恶意代码。
- **声明式 connector 的 SSRF 白名单是字面量校验，不防 DNS rebinding**（继承自
  W1-c 的已知限制：域名当时解析到公网 IP、请求发出后才被改指向内网，这条校验
  挡不住；修复需要在 `backend/src/http/client.ts` 的 `NativeHttp` 做连接前 IP
  复核，那个文件不在任何一条 lane 的所有权范围内出现过）。
- **`ext verify` 本身不是沙箱**。跑 `platform`/`rule`/`skill` 的 verify 需要
  执行扩展代码（契约测试的本质要求），它验证"行为符不符合契约"，不提供执行隔离——
  一个 verify 通过的 rule 扩展，如果它选择在 verify 的求值窗口之外的某个分支里
  干别的事，verify 测不出来。

## 恶意扩展矩阵：五条结果

| # | 场景 | 结果 | 落点 |
|---|---|---|---|
| ① | manifest 声明 A 却调 B 工具 | **拒**（`ExtensionGrantError`） | `context.ts` `buildExtensionContext().tools.call()`；测试：`tests/unit/extensions.test.ts` "恶意矩阵 ① + ②" |
| ② | 未 grant 却取凭据 | **拒**（`ExtensionGrantError`） | 同上 `.credentials.get()` |
| ③ | 声明式 connector 塞内网地址（用云 metadata `169.254.169.254` 而不是 `file://`，覆盖 W1-c 已验证过的协议维度之外的主机名维度） | **拒**，且验证了 `loadExtension()` 装载路径本身会走到（不是只测 `verifyExtension`） | `malicious-ssrf-connector` fixture；`loadManifestFromJson` 内部 `assertOutboundUrlAllowed` |
| ④ | 扩展在模块顶层直接 `throw` | 主进程存活，`loadExtension()` 返回 `status:"failed"` | `throwing-extension` fixture；`loader.ts` 的 try/catch；另有一条测试验证 `listExtensionCapabilities()` 对一个 manifest 损坏（非法 JSON）的扩展同样不中断整份清单 |
| ⑤ | 装载一个从未 `ext verify` 过 / 验证已过期 / 上次未通过的扩展 | **仍然装载**，但打印显式 `⚠️` 警告（verify 是提醒不是硬闸——理由见上方"不是沙箱"） | `verify_cache.ts` 的指纹比对；`loader.ts` 的 `verifyStalenessWarning()` |

## 两次阴性对照（实跑记录）

### ① 让 verify 对一个明知违反并发不变式的 connector 放行 → 测试红

`manifest.ts`（W1-c）与 `connector.ts`/`base.ts` 都不在本 lane 名下，且它们的
并发安全性是结构性保证的（构造期一次性写入、运行期只读的 handler 表）——没有
合法办法在不改这两个文件的前提下让**真实的** `ManifestConnector` 产生竞态。
做法与 W1-c devlog 记录的手法一致：在测试文件里独立写一个 `BrokenConnector`
（继承 `HttpConnector`，一个字节没碰 `base.ts`/`manifest.ts`），用一个跨调用
共享的可变字段 `raceState` 精确复现旧版 `__handlingTool` 那类竞态的形状（写在
`await` 之前，读在 `await` 之后），再喂给 `compareSerialParallel()`——这正是
`ext verify` 真实用来判定"并发结果与串行结果是否一致"的那段比对逻辑本身
（从 `connector_verify.ts` 里拆出来导出，不是另写一份简化版）。

实跑输出：

```
[阴性对照①] compareSerialParallel 对已知有竞态的 connector 的判定：ok=false
job#0（tool="search"）并发结果与串行结果不一致：
  serial:   {"url":"https://api.example.org/v1/search?q=term-0","method":"GET"}
  parallel: {"url":"https://api.example.org/v1/records/id-39","method":"GET"}
这正是 P10-a 修复的那类竞态的形状——并发调用同一个 connector 实例时结果发生了串味。
```

`job#0` 本该发出 `search` 请求，实际却拿到了 `job#39`（`getById` 的最后一个）
的 URL——与并发批次里最后一个同步执行完的 job 的状态窗口重叠，形状与 W1-c devlog
记录的复现完全一致。`compareSerialParallel` 正确判红。

### ② 去掉 `--trust` 确认 → 测试红

```
[阴性对照②] 不带 --trust 装载 good-rule：status=failed, reason=扩展 "good-rule"（kind 需要代码执行）尚未信任，拒绝装载。
入口文件指纹：sha256:d689f43e4b6e5bca22d6ff503c41e915300dd8ed1a6a54f4ec94b1b03faaf606
确认这段代码可信后，重新执行并加上 --trust。
```

配套的正向对照（同一个扩展、同一次全新的临时数据目录，这次带 `--trust`）确认
装载成功、拿到 `module`——证明失败不是因为 `pathOptions`/fixture 本身有问题，
确实是 `--trust` 这一个条件在起作用。

## 给主会话的 capabilities 接线说明

`backend/src/capabilities/**` 不在本 lane 的文件所有权范围内（任务书原话："多个
lane 争用，收口统一接线"），所以下面这些改动**没有**在本分支上做，写清楚让主会话
接线：

1. `backend/src/capabilities/index.ts` 的 `CapabilityManifest` 加一个字段：
   ```ts
   extensions: ExtensionCapability[];
   ```
   类型从 `backend/src/extensions/capabilities.ts` import：
   ```ts
   import { listExtensionCapabilities, type ExtensionCapability } from "../extensions/capabilities";
   ```
2. `buildCapabilities()` 里加一行：
   ```ts
   const extensions = await listExtensionCapabilities({ root: options.root });
   ```
   并在最终返回对象里加 `extensions`。**不需要 `probe` 分支**——
   `listExtensionCapabilities()` 本来就不执行任何扩展代码（只读 manifest + 授权
   记录 + verify 缓存），零 IO 成本与其它"静态可用性"字段一致，不需要 opt-in。
3. `backend/src/capabilities/cli.ts` 的人类可读表格渲染器加一段展示
   `extensions[]`（`status` 为 `available`/`needs_grant`/`unverified`/
   `stale_verify`/`failed` 五档，`reason` 字段直接可打印）。
4. 接上之后，**删除** `tests/unit/narrative_parity.test.ts` 里
   `backend/src/extensions/capabilities.ts` 的 `ALLOWED_ORPHANS` 登记——门禁的
   对称检查会在忘记删的时候变红提醒（同 W1-c 交接 `manifest.ts` 时用的那套纪律，
   本 lane 已经在这一轮里实际执行了一次：删除了 `manifest.ts` 的登记，因为
   `loader.ts`/`connector_verify.ts` 现在是它的真实生产调用方）。

**装载器到子代理 tool loop 的接线**（`backend/src/agents/**` 不在本 lane 名下，
同样留给持有该文件的 lane）：`loadExtension()` 返回的 `context.tools.call()` /
`context.credentials.get()` 是给"某个具体的调用方"用的——具体是谁在什么时候把
这个 `context` 递给已装载的扩展模块（例如调用它导出的某个 `register(ctx)` 函数），
是 daemon/orchestrator 层的职责。本 lane 只保证：**如果**调用方这样做了，
`context` 会结构性地按 manifest 声明 + `ext grant` 授权收窄访问面（恶意矩阵①②
已验证）；本 lane **不会**、也不能替调用方决定"什么时候该调用扩展的哪个入口"。

## 六套件数字

| 套件 | 结果 |
|---|---|
| `bun run typecheck` | 干净（两个 tsconfig 都过） |
| `bun test tests/unit/` | **1164 pass / 0 fail / 0 skip**（基线 1120 + 本 lane 新增 44，回归为零） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail |
| `bun run test:e2e`（`SPARK_E2E_PORT=4423`） | **13/13** |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |

## 已知未完成 / 诚实报告

- **`backend` kind（WetLabBackend）的 `ext verify` 只做结构检查**，没有覆盖
  `wet_loop`/`wet_e2e` 那个级别的真实契约测试——任务书的 verify 表格本身没列
  这一档，`backend/src/lab/**` 也不在本 lane 名下，如实标注为已知限制，不是遗漏。
- **信任指纹只覆盖 entry 单文件**，不覆盖扩展目录下的其它文件（如 `index.ts`
  `import` 的同目录辅助模块）。多文件 TS 扩展如果只改了被 `import` 的辅助文件、
  没改 `index.ts` 本身，指纹不会变化，`--trust` 不会被要求重新确认——这是一个
  真实的覆盖面缺口，如实记录，留给后续判断是否值得做全目录哈希。
- **`ExtensionContext` 的 grants 只是"声明 + 授权"两层结构性约束**，前面「安全
  边界」一节已经说清楚它挡不住"扩展代码根本不走 context 这条路"的情况——这不是
  实现疏漏，是"同 UID 代码执行"这个前提下能做到的边界，装载器/verify 都不该
  在文档里暗示自己是沙箱。
- **`platform` verify 依赖仓库源码树**（`tests/helpers/simulation_contract.ts`
  的绝对路径），只在从 git checkout 跑时可用；`bun build --compile` 编译产物
  里没有 `tests/` 目录，这条 verify 会明确报错（"找不到 P5 契约测试套件"），
  不是静默通过——已在 `platform_verify.ts` 头部注释与代码里显式处理，未做进一步
  的"把契约测试套件也打进二进制"之类的工作，超出本 lane 范围。
- **授权账本（`.grants.json`）与信任指纹（`.trust.json`）目前没有 CLI 层面的
  "列出所有授权"命令**（`ext grant`/`ext revoke` 的输出里只回显单个扩展当前的
  授权状态）——可用性上的小缺口，如实记录。
- 声明式 connector（强度①）目前**不支持把凭据编进请求**（DSL 里没有
  headers/auth 表达能力，继承自 W1-c 的设计边界），所以"凭据不落盘"这条
  `ext verify` 检查对当前实现而言更准确的定位是"回归防线"（防将来给 DSL 加
  认证能力时不小心泄漏），而不是"验证了一个真实存在的凭据使用路径"——已在
  `connector_verify.ts` 的注释里如实说明。
