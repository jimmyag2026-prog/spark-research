# 闸门 I · 「声明即须有读者」— 主会话串行，四条各一 PR，合完打 `v0.9.0-alpha.1`

> 不是 lane，是主会话自己做。先跑门禁再修 bug：**目的是把这一类的全体人口找出来**，不是修 U10 一个。
> 已知三处同族：`defaultProvider`（V40，配置项）· `retryable`/`maxRetries`（V137，行为开关字段）· `chat()` 的 `model`（U10，函数参数）。
> 现有 `tests/unit/config_reader_parity.test.ts` 只覆盖第一种形状，且自注「key → helper 的绑定是否正确核不了（那要解析函数体）」。闸门 I 就是去解析函数体。

## I-1 · 门禁本体（两个新测试文件）

### `tests/unit/gate_i_param_readers.test.ts` —— 形状 ②：对象参数属性必须在函数体内被引用（U10 形状）

- 用 TypeScript 编译器 API（`typescript` 已是 devDependency，`tsc` 在用）：`ts.createProgram` 覆盖 `backend/src/**/*.ts`。
- 扫描对象：**导出的**函数 / 类的公开方法，且至少一个参数的类型是**内联对象类型字面量**或**本文件内定义的 `type`/`interface`**（跨文件类型先不做，如实写进注释里的能力边界）。
- 对该参数类型的每个属性 `p`：在函数体 AST 里找 `<param>.p`、解构 `{ p }`、`<param>["p"]` 三种读取形态；一处都没有 → 记为「无读者」。
- 输出：无读者清单 `[{file, fn, param, prop}]`；**默认全部视为失败**，除非在同文件顶部的 `GATE_I_ALLOWLIST` 里登记 `{file, fn, prop, reason}`——`reason` 非空字符串，否则不算登记。
- **测试注释里写清能力边界**（照 `config_reader_parity` 的做法）：能抓「声明了没读」，抓不了「读了但没起作用」（那是 β-1 门禁的活）；跨文件类型引用暂不覆盖，登记为 I-3 的一条待办。

### `tests/unit/gate_i_switch_readers.test.ts` —— 形状 ③：行为开关字段必须有读取点（V137 形状）

- 文本级：登记表 `SWITCH_FIELDS = [{ type: "LlmError", field: "retryable" }, { type: "CallOptions", field: "maxRetries" }, ...]`——**先把 `backend/src/llm/types.ts` 里所有 boolean / number 可选字段全部列进去**，再逐个核。
- 读取点判据：`backend/src` 里出现 `\.<field>\b` 且**后面不是** `:` 或 `=`（排除对象字面量写入和赋值），且不在 `types.ts` 本文件。零命中 → 红。
- 能力边界写进注释：只认 `.field` 读法，解构读法会漏（如 `const { retryable } = err`）——所以**再补一条**：`{\s*[^}]*\bfield\b[^}]*}\s*=` 也算读。两条都零命中才红。
- **闸门 H 合入后 `retryable` / `maxRetries` 应当已有读者**（V137 在 `router.ts` 加了重试循环）。**这条门禁在 alpha.1 上必须绿，在 v0.8.0 tag 上必须红**——这就是它的阴性对照，不用人造。把在 `v0.8.0` 检出上跑红的终端输出贴进 devlog。

## I-2 · 阴性对照（三条，真跑，终端输出进 `docs/devlog/GATE_I.md`）

| 形状 | 改法 | 期望 |
|---|---|---|
| ② 参数 | 在任一导出函数加一个对象参数属性 `probeUnused?: string`，函数体不读它 | `gate_i_param_readers` 红，且报出 `{fn, prop: "probeUnused"}` |
| ③ 开关 | 在 `LlmError` 加 `probeFlag?: boolean`，登记进 `SWITCH_FIELDS`，不加读者 | `gate_i_switch_readers` 红 |
| ③ 历史 | `git worktree add /tmp/.. v0.8.0` 上跑 `gate_i_switch_readers` | 红（`retryable` / `maxRetries` 零读者） |

改完**必须恢复**，且恢复后两条门禁绿。

## I-3 · 全量盘点 → BACKLOG

- 门禁首次跑出的「无读者」全清单，**逐条**进 `docs/BACKLOG.md`，从 **V142** 起编号（登记前先 `git grep -ohE '\bV[0-9]{1,3}\b' $(git for-each-ref --format='%(refname)' refs/remotes) -- docs/BACKLOG.md | sort -n | tail -1` 再确认一次最大号）。
- 每条三选一去向：**修**（写明归哪条 lane，并追加进对应 `LANE_*.md` 的「追加」段）/ **删声明**（本 PR 直接删）/ **保留**（进 allowlist，reason 写清为什么故意留空，例如「预留给 v0.10 的 X」）。
- **U10（`chat()` 的 `model`）必然在名单里**——去向 = 修，归 β-1。不要在闸门 I 里顺手修它：β 的门禁（无 key provider 必失败）才是它的验收，闸门 I 只负责「看见」。
- 盘点摘要（总数 / 修 / 删 / 保留各几条）写进 devlog 和 CHANGELOG 的 alpha.1 段。

## I-4 · AD-17 入 `docs/DESIGN.md`

> **AD-17 声明即须有读者。** AD-12 保证「声称的能力存在」；AD-17 保证「声称的能力接线了」。
> 可写入的配置项、公开函数的对象参数属性、类型上的行为开关字段，三者都必须有生产读取点，
> 否则门禁红；故意留空的必须进 allowlist 并带原因。形状来源：V40 / V137 / U10。

## 足迹

- 允许：`tests/unit/gate_i_param_readers.test.ts`（新）· `tests/unit/gate_i_switch_readers.test.ts`（新）· `docs/DESIGN.md`（只加 AD-17）· `docs/BACKLOG.md`（只加盘点条目）· `docs/devlog/GATE_I.md`（新）· `docs/taskbooks/v0.9/LANE_*.md` 的「追加」段 · `CHANGELOG.md` alpha.1 段 · 被判「删声明」的那些文件（只删，不改逻辑）
- 禁止：修任何「无读者」实例的逻辑（那是 lane 的活）

## 退出标准

两条门禁绿 · 三条阴性对照红（含 v0.8.0 上的历史对照）· 盘点名单入 BACKLOG 且每条有去向 · AD-17 入库 · tag `v0.9.0-alpha.1`。
