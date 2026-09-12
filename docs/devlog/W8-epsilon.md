# W8-1 · lane ε（湿实验软件半边）devlog

范围：V95（approve/simulate 的 HTTP 审批不再是旁路）· V55（湿实验自然语言解析双语化）·
V59 软件四条（安全门覆盖范围声明 / biosafety P-level 识别 / chemical_compatibility 孔位说明 /
四条消息统一）。**不接任何真实设备**——全程 `MockDeviceBackend`，一行 Opentrons SDK 或真实设备
连接代码都没有。

## 一、V95 · HTTP 审批不再是旁路

### 设计落地

- 新文件 `backend/src/lab/approval_token.ts`：`issue(projectRoot, experimentId)` 生成 32
  字节随机令牌，落 `projects/<slug>/lab/approval_tokens.json`（0600，`{experimentId,
  tokenHash(sha256), issuedAt, expiresAt(+10min), used, usedAt?}`，**不存原始令牌**）；
  `consume(projectRoot, experimentId, token)` 校验 hash（`crypto.timingSafeEqual`）/
  experimentId 绑定/未过期/未用 → 标 used（单次）。读-改-写全程持一把同目录锁文件
  （`.lock`，`wx` 独占创建 + 过期回收，判据与 `project/manager.ts` 的 state.json 锁同一套
  思路，但**没有 import 那份实现**——它是私有方法，且这个文件被 Playwright（Node，非
  Bun）测试进程直接 import，只依赖 `node:fs`/`node:crypto`/`node:path`，不牵连
  `server/*` 那条只有 Bun 运行时才装得全的依赖链（`workbench.spec.ts` 底部注释记录过这个坑）。
- CLI `spark-research lab token <experiment-id>`：TTY 门直接调用
  `requireApprovalGate(LAB_APPROVAL_GATE, ref, "approve", deps, flags)`——与 `lab approve`
  **同一次调用同一套判据**，不是照抄一份。用 `"approve"` 这个 action 字面量是刻意的：
  gate.ts 的类型签名只接受 `"approve" | "reject"`，而 gate.ts 不在本 lane 足迹内，不能改；
  签一枚能用来批准执行的令牌，在「必须是人」这件事上与 approve 本身等价，复用同一判据
  是设计意图，不是文案凑巧。`index.ts` 完全不需要改——`case "lab"` 早就是把
  `process.argv.slice(3)` 原样转给 `runLabCommand`，子命令名在 cli.ts 内部分派，新增
  `token` 子命令零接线成本（已用 `bun backend/src/index.ts lab token <id> --ci-bypass-token
  ... --ci-bypass-reason ...` 实跑验证过，见下面「给收口的说明」）。
- HTTP：`POST /experiments/:id/approve` 与 `/simulate` 都要求 body.approvalToken（或
  `X-Spark-Approval-Token` 头）+ actor。**关键实现细节**：`/simulate` 走 `taskResponse`
  的异步任务出口（不带 `await:true` 立刻 202），如果把令牌校验放进 `run()` 内部，403 会
  被 202 盖住——所以校验+消费必须在调用 `taskResponse()` **之前**、同步完成（用
  `ctx.withProject` 单开一次作用域做校验，随后 `run()` 内部按原有方式再开一次自己的作用
  域，执行路径本身一行没动）。

### 阴性对照（真跑）

| 改法 | 结果 |
|---|---|
| `server/routes/lab.ts` 的 approve/simulate 分支里注释掉 `consumeApprovalTokenOrThrow(...)` 调用 | `bun test tests/unit/server_lab.test.ts`：25 → **21 pass / 4 fail**（"令牌错误/跨实验借用/只能用一次/跨端点单次消费" 四条全部从 403 变成 200，红得精确对上被删掉的那一行）；恢复后重跑 25/25 绿。 |
| `approval_token.ts` 的 `consume()` 手工把磁盘上刚消费过的记录改回 `used:false` | `tests/unit/w8_epsilon_approval_token.test.ts` 里专门有一条「阴性对照」用例：正常路径先确认 `used` 被写回 `true`，再人为抹掉验证「同一枚令牌又能被消费一次」——证明单次消费的保证来自 `used` 字段的持久化，不是巧合（真跑绿，见该文件最后一条测试）。 |

浏览器端（Playwright，真实用户交互路径）：`tests/e2e/workbench.spec.ts` 新增 ⑧b——
approve 用掉一枚令牌后，拿**同一枚**去点「执行」，断言 403 且 `.toast[data-kind='error']`
里显示的就是后端原样返回的消息（含「已被使用过」与「spark-research lab token」），状态
原地停在 `approved`。21 条 e2e 全绿（跑过一次，见下面「六套件数字」）。

## 二、V55 · 湿实验自然语言解析双语化

问题（BACKLOG 原文）：试剂词表（`REAGENT_PATTERNS`）早就是中英双语的，但 `ACTION_RULES`
的动词关键词、`CONTINUATION_MARKERS`、signal 正则全是纯中文——纯英文协议一步都编不出来，
不是拦截，是**静默产出零步骤协议**。

补法：六条 `ACTION_RULES` 各补对应英文动词（`add/transfer/dispense`、
`prepare/formulate`、`incubate`、`shake/vortex`、`centrifuge`、`read/measure/detect`）；
`extractDurationSec` 补 `hours?/minutes?/seconds?/overnight` 完整词形（原来
`h(?![a-z])` 的负向先行断言连"hour"本身都进不去）；`CONTINUATION_MARKERS`/
`CONCENTRATION_SIGNAL`/`REAGENT_MENTION_SIGNAL`/`GENERIC_LIQUIDS` 各补英文对应词；
动作关键词匹配与未识别试剂原文抠取都改成大小写不敏感（句首大写 "Add ..." 不再因为词表
存的是小写 "add" 而匹配不上）。**没有**造一本英文实验动词词典——只补 README 示例协议
直译后会用到的最常见写法，词表外的动作仍然静默丢弃（与既有「宁可漏、不瞎报」纪律一致，
未消费信号扫描原样覆盖）。

### 阴性对照（真跑）

把 `addSample` 规则的关键词从 `["加","加入","添加","转移","add","transfer","dispense"]`
改回 `["加","加入","添加","转移"]`（去掉英文动词），`bun test
tests/unit/w8_epsilon_protocol.test.ts`：9 → **4 pass / 5 fail**——README 协议英文版
只编出 2 步（缺 addSample 那一步）、试剂冲突协议编出 0 步、大小写不敏感测试编出 0 步、
两条 P-level 测试直接因为 `protocol.steps[0]` 是 `undefined` 而抛异常。精确复现了 V55
描述的原始 bug 形状。恢复后重跑 9/9 绿。

## 三、V59 软件四条

① **`lab compile` 打印覆盖范围声明**：把原来只存在于 `wet_models.ts`
`renderWetExperiment()`（`lab status` 用）里的那段文案抽成 `safety.ts` 导出的
`SAFETY_COVERAGE_STATEMENT` 常量，`cli.ts` 的 `compile` 非 JSON 分支打印它。**没有做完
的部分**：`wet_models.ts` 改成引用同一个常量、以及它里面那句已经过期的「英文协议编译
不出步骤」需要一并修正——这两处都在 `wet_models.ts`，不在本 lane 足迹内，diff 见报告
「需要收口的 diff」一节，本文件已经先把「唯一真源」立好（`SAFETY_COVERAGE_STATEMENT`
的内容已经是 V55 之后的真实口径，不是旧文案的复制）。

② **biosafety 识别 P-level 口语写法**：`extractBiosafetyLevel`/`BIOSAFETY_SIGNAL` 加一条
`\bP([1-4])\b(?:\s*(?:实验室|lab(?:oratory)?s?))?` 分支——`P3 实验室`、裸 `P2`、`P3 lab`
都映射到与 `BSL-3`/`BSL-2` 相同的数字等级。**没有新增或修改任何阈值**：
`MAX_BIOSAFETY_LEVEL` 原样是 2，`biosafetyRule` 的 evaluate() 一行没动，只是
`extractBiosafetyLevel` 多认一种同义写法。测试见 `w8_epsilon_protocol.test.ts`
「V59② · biosafety 识别 P-level 口语写法」一节，含一条显式断言「识别结果不新增/不改
阈值」。

③ **chemical_compatibility 消息明说「本规则不看孔位」**：加进 `description`（始终可见，
不是只在拦截时才说）与拦截 `detail`（V59④ 一起改的格式）。

④ **四条消息统一（限值 + 单位 + 下一步）**：
   - `concentration_limit` 的 over-limit 分支从 `over-limit reagents: 乙醇 (200)`
     （英文残句）改成中文完整句，带上限值/单位/下一步；
   - `volume_capacity` 的四类 violation（累计溢孔/负体积/超量程/低于最小量程/无编译产物
     兜底）各补一句「下一步」；
   - `chemical_compatibility` 见③。
   数值/限值/单位本身**一个没变**——`MAX_CONCENTRATION`、`PLATE_WELL_CAPACITY_UL`、
   `PIPETTE_MAX_VOLUME_UL`、`PIPETTE_MIN_VOLUME_UL`、`CHEMICAL_COMPATIBILITY` 全部原样。

### 阴性对照（真跑）

把 `chemicalCompatibilityRule` 的 `detail` 分支改回旧版 `incompatible reagents: ${...}`
（英文残句，无「下一步」），`bun test tests/unit/lab_safety.test.ts
tests/unit/w8_epsilon_protocol.test.ts tests/unit/w8_epsilon_cli_token.test.ts`：
45 → **44 pass / 1 fail**（`w8_epsilon_protocol.test.ts` 里断言 `enCheck.detail` 包含
「下一步」的那条精确变红）。恢复后重跑 45/45 绿。

## 四、给收口的说明（本 lane 足迹外，未自行修改）

以下改动确认需要、且已经在自己的足迹内验证过设计是对的，但涉及的文件不在 W8-epsilon
任务书「允许」列出的范围内，没有去动——diff 原文如下，供收口合入。

### 1. `backend/src/lab/wet_models.ts`（`renderWetExperiment()`）

现状：这个文件里硬编码了一份与 `safety.ts` 新增的 `SAFETY_COVERAGE_STATEMENT` **内容
重复**的覆盖范围声明字符串，且其中一句「自然语言步骤解析目前只吃中文：英文协议编译
不出步骤」在 V55 落地后已经是假话。

```diff
--- a/backend/src/lab/wet_models.ts
+++ b/backend/src/lab/wet_models.ts
@@
+import { SAFETY_COVERAGE_STATEMENT } from "./safety";
@@
-    lines.push(
-      "> 覆盖范围口径（**每次改安全门都要同步这段**——它出现在审批决策点上）：\n" +
-        "> · `volume_capacity`：唯一全程接编译产物核对的规则，累计溢孔与移液器量程都查。\n" +
-        "> · `chemical_compatibility`：认识一个**有限**的试剂词表（中文常见名 + 英文名/分子式）。" +
-        "**词表之外的试剂它完全看不见**，不是「相容」。\n" +
-        "> · `concentration_limit`：只在**同句恰好点名一种试剂**时才拿得到浓度（跨句写法拿不到，会落未消费告警）。" +
-        "解析到了但**限值表里没有该试剂**时**不放行**，理由写「没有规则可查」——" +
-        "「查不到规则」不等于「检查通过」。另外百分比 > 100 一律拦（物理上不存在）。\n" +
-        "> · `biosafety`：能挂到「这句话最终归属的那个步骤」；一句独立的生物安全描述、" +
-        "前面没有步骤可挂时，只报未消费。\n" +
-        "> · **自然语言步骤解析目前只吃中文**：英文协议编译不出步骤（会直接报错，不会静默产出空协议）。\n" +
-        "> 漏看了什么，看上面「未被安全门消费的信号」。",
-    );
+    lines.push(`> ${SAFETY_COVERAGE_STATEMENT.replace(/\n/g, "\n> ")}`);
```

### 2. `README.md`（第 30–36 行左右，安全门覆盖范围那段 blockquote）

现状：与上面同一件事——「自然语言步骤解析目前只吃中文」在 V55 之后是过期信息。

```diff
--- a/README.md
+++ b/README.md
@@
-> ⚠️ **自然语言步骤解析目前只吃中文**（发布前外部验收发现）：英文协议
-> （`Transfer 50uL of sample into well A1...`）编译不出任何步骤，会直接报错
-> 「协议没有任何步骤」——不会静默产出空协议，但也确实用不了。
-> 试剂词表是双语的，可上游解析器不是，所以词表永远拿不到英文输入。
+> ✅ **自然语言步骤解析中英双语都能编**（V55 修复，W8-1 ε）：动词/单位/数量/温度/
+> 时长的解析都补了英文对应写法，且大小写不敏感、中英混排也能编；试剂词表本就是
+> 双语的。仍然不是完整的英文语法解析器——只覆盖常见写法，词表/语法之外的表达
+> 依旧走「未消费信号」兜底，不假装全懂。
```

以上两处内容一致、互相印证，收口时建议一起合。`SAFETY_COVERAGE_STATEMENT`
（`backend/src/lab/safety.ts`）已经是这次改完之后的真实口径，可以直接作为两处
的唯一真源。

## 五、如实交代

- **没有新建独立的 Playwright e2e spec 文件**：原计划为 V95 的 HTTP 令牌门单独起一个
  自包含的 e2e spec（避免依赖共享 fixture server 的隐藏工作区路径），后来发现
  `GET /api/projects/current` 本来就会把 `paths.root` 吐出来（`server/routes/projects.ts`
  的既有能力），直接用它 + 直接 `import { issue }` 就能在共享的 `workbench.spec.ts`
  里拿到真实、绑定正确 experimentId 的令牌，不需要另起一台服务器，于是改成在
  `workbench.spec.ts` 里新增 ⑧b 一条用例，删掉了另起服务器的方案。这是比原计划更简单、
  覆盖同样场景的做法，记在这里说明为什么最终交付里没有独立的新 e2e 文件。
- **`lab token` 的 TTY 门用 `action: "approve"` 字面量复用 `requireApprovalGate`**：
  这意味着非交互环境下签令牌与批准共用同一个环境变量 `SPARK_LAB_CI_BYPASS_TOKEN`（不是
  另开一个）。设计上认为这是合理的（签发一枚能直接兑现批准的令牌，权限重量与批准本身
  相当），但这是本 lane 在任务书「TTY 门与 lab approve 同一套」这句话基础上做的一个
  具体解读，不是任务书逐字写出的实现细节，如实标注。
- **令牌文件的锁**：并发 20 次 consume 的正确性在单进程/单事件循环里，即使没有锁文件也
  天然成立（`consume()` 全程同步、无 await，两次调用不可能交叉执行）。锁文件是为
  「文件锁或原子写防并发双用」这条硬性要求准备的纵深防御（真正的跨进程场景：CLI 进程
  与 HTTP server 进程同时读写同一份 `approval_tokens.json`），`tests/concurrency/
  lab_token_once.test.ts` 测的是同进程内的并发，无法单独证明跨进程锁本身生效——
  这一点没有能力在这次交付里用跨进程测试验证，如实说明。
- **P-level 识别的误判风险**：`\bP[1-4]\b` 允许裸数字（无「实验室/lab」后缀）匹配，
  理论上会误伤一些巧合含有 "P2"/"P3" 等 token 的协议文本（比如某个样品编号恰好叫
  "P2"）。这是任务书明确要求的写法（"裸 P2"），按字面做了，风险如实标注在
  protocol.ts 的注释里。
