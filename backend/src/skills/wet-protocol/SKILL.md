---
name: wet-protocol
description: "湿实验协议：自然语言协议 → 编译成 Opentrons Python Protocol API v2 脚本 → 安全门 → **人工 approve** → 官方模拟器执行 → run log 入证据图。用于「把一个实验方案变成可执行、可审计、可复现的协议」「先在模拟器上验一遍再上真机」。物理世界的操作永远不自动化审批。"
category: experiment
domain: B
allowed-tools: [Bash, Read, Write]
---

# Wet protocol（湿实验协议编译与执行）

## 何时用这个技能

- 用户有一个**要动液体/设备**的实验方案，想把它变成可执行的协议并先验一遍
- 需要把一次湿实验的每一步（谁批的、批的是哪一版、机器做了什么）留成可审计的记录
- 干实验（`dry-experiment`）跑出观察之后，要接一条湿实验去验证

**不适用**：纯计算的假设 → `dry-experiment`；只想查文献 → `literature-search`。

## 铁律（先读这段）

1. **安全门通过 ≠ 可以执行。** 安全门是**必要非充分**条件。它全过之后实验会停在
   `awaiting_approval`，等一个具名的人按 approve（AD-6）。不要替用户按这个按钮，
   也不要把「安全门都过了」说成「可以跑了」。
2. **approve 批的是某一版协议，不是这条实验。** 每条 approve 落一条 decision record，
   记的是**协议 hash**。协议改了 hash 就变，先前的批准立刻作废，必须重新
   `compile → safety_check → approve`。这不是繁文缛节：批的人看的是当时那份步骤表。
3. **Opentrons 上没有的硬件不假装有。** 离心、340 nm 酶标、离机配液都编译成
   `[spark-note]` 注释并标 `execution: manual`。把离心编译成一个 delay 会让 run log
   看起来「跑通了」——那是最糟的一种假成功。
4. **模拟成功 ≠ 实验会成功。** 模拟器验证的是**协议在协议引擎里合不合法**
   （labware 存不存在、次序对不对、体积够不够），不验证生物学。
   observation 正文里写明「硬件为模拟」，报告里也不许省掉这句。
5. **run log 是证据，不是日志。** 每条命令都锚定回编译产物里的某一步
   （`[spark-step]` 标记），run log 与执行的脚本一起进 artifact。
   「我记得跑过」不算数，`lab status <id>` 说了算。

## 用法

```bash
spark-research lab backends                              # 先看模拟器可用不可用
spark-research lab compile "取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD" \
    --title "OD600 测定" --hypothesis "孵育后 OD600 上升"
    # → 建实验 → 编译 → 安全门 → **停在 awaiting_approval**

spark-research lab status <id>                           # 看编译后的步骤表与安全门结论
spark-research lab approve <id> --actor 张三 --note "试剂与体积已复核"
spark-research lab reject  <id> --reason "样品量不足，先补样"
spark-research lab simulate <id> --note "首轮基线"        # 执行 → 回收 → observation
spark-research lab compile --experiment <id> --protocol "<改过的协议>"   # 重编译（作废 approve）
```

退出码 1 = 安全门拦截 / 未经 approve 就执行 / 模拟器拒绝协议。**都不要当成「跑完了」**。

## 状态机

```
design ─► compile ─► safety_check ─► awaiting_approval ─► wet_run ─► collect ─► analyze ─► concluded
             ▲            │                  │               │                        └► iterated
             │            └► failed          └► rejected     └► failed
             └────────────── 重新编译（清掉已有的 approve / reject / 安全门结论）
```

- **唯一进入 `wet_run` 的门是 `approve()`**。转移表层面就只有这一条边。
- 安全门不过 → `failed` 并抛 `LabSafetyError`，**不会**进 `awaiting_approval`。
- 已经执行过的实验不能就地重编译（`runId` 非空即拒绝）——改协议请 `iterate` 另起一条。
- 表外的转移一律拒绝，不做「顺手纠正」。

## 安全门：四条独立规则

| 规则 id | 检查 | 拦什么 |
|---------|------|--------|
| `chemical_compatibility` | 试剂兼容性 | 强酸 × 次氯酸盐、强酸 × 强碱 |
| `concentration_limit` | 浓度上限 | 受管制试剂超过 `MAX_CONCENTRATION` |
| `biosafety` | 生物安全等级 | 超过 BSL-2 |
| `volume_capacity` | 体积 / 孔板容量 | 单孔累计超 360 µL、单次转移超出移液器量程 |

每条都是**零 IO 的纯函数**，可以单独打对抗样例。`volume_capacity` 需要**编译产物**
才查得出「累计溢孔」——一句「加 200 µL」两次在自然语言层面都合法，
只有排完 deck 累加起来才知道会溢。没有编译产物时它退回单次核对，并在 detail 里
明说「单孔累计体积待编译后复核」，**不静默放行**。

## 编译目标

Opentrons **Flex** / Python Protocol API v2（`apiLevel 2.21`）。
选 Flex 不是偏好：opentrons 9.x 已移除 OT-2 支持，而且 OT-2 没有吸光度读板模块——
「600 nm 读 OD」在 Flex 上才有真模块可用，不必退化成注释。

| 协议动作 | 编译成 | execution |
|---------|-------|-----------|
| `addSample` | `pipette.transfer(...)` reservoir → 板孔 | deck |
| `serialDilute` | 分装稀释液 + 逐级转移 + 每级换 tip 混匀 | deck |
| `incubate`（≥37 °C） | Heater-Shaker 控温 + `protocol.delay` | module |
| `shake` | Heater-Shaker 转速 + 计时 | module |
| `read`（450/562/600/650 nm） | 吸光度读板模块（搬板进出 + 真读数） | module |
| `prepareReagent` | 离机配液 → 装载 reservoir 的说明 | **manual** |
| `centrifuge` / 其他波长读数 / <37 °C 孵育 | `[spark-note]` 离机人工步骤 | **manual** |

`execution: manual` 的步骤在 run log 里只有一条 note——**它没有被执行**。
读 run log 时不要把 note 当成执行记录。

## 两个执行后端

| 后端 | 用途 | 依赖 |
|------|------|------|
| `opentrons_simulate` | **默认**。官方模拟器，真实解析并执行协议脚本 | `uv pip install opentrons` |
| `mock_devices` | 单测后端。从编译产物合成等价形状的 run log | 无 |

mock 验的是「管线通不通」，**验不了「协议合不合法」**：一个 opentrons 拒绝解析的脚本
在 mock 后端一样会「跑成功」。所以默认后端必须是真模拟器。

## 证据图

```
decision(approve/reject) --derives_from--> experiment    （谁 / 何时 / 批了哪个协议 hash）
artifact record          --derives_from--> experiment    （protocol.py / runlog.json / runlog.txt）
observation              --derives_from--> experiment 与每个 artifact record
conclusion               --derives_from--> observation / experiment
湿 experiment            --derives_from--> 干 experiment  （干实验 concluded 后派生）
湿 experiment            --supersedes-->   干 experiment  （干实验 analyze 后接棒）
新 experiment            --supersedes-->   旧 experiment  （iterate）
```

- experiment 的 `evidence` 是 `inferred`（设计是推出来的）
- 执行产出与 observation 的 `evidence` 是 **`observed`**——run log 记的是设备做了什么，
  不是算出来的（与干实验的 `computed` 区分开）
- decision 的 `evidence` 是 `inferred`（审批是人的判断）
- 结论卡一律 `review: "pending"`——湿实验同样不给自己发通过证

## 反模式

- ❌ 替用户 approve，或者把「安全门都过了」说成「可以执行了」
- ❌ 改了协议之后拿旧的 approve 去执行（工具会拒，但不要去想办法绕）
- ❌ 把 `execution: manual` 的步骤（离心、离机读数）当成模拟器执行过了
- ❌ 把模拟器的读数当成真实生物学数据写进结论
- ❌ 安全门拦下来就把试剂浓度改小到刚好过线，然后当成协议改好了
- ❌ 在同一条实验上反复重跑覆盖上一轮（要对照就 `iterate`）
- ❌ 用 mock 后端跑通就说「协议验证过了」——mock 不校验协议合法性
- ❌ 连续稀释里复用 tip（会把上一级的浓度带下去，整条曲线作废）

## 验证方式（AD-5）

- 编译器单测：`tests/unit/lab_compile.test.ts` —— deck 按需加载、体积记账、hash 确定性、
  「没有的硬件不假装有」
- 安全门对抗矩阵：`tests/unit/lab_safety.test.ts` —— 四条规则**各自**单独打对抗样例
  （不兼容试剂 / 超浓度 / 超 BSL / 累计溢孔 + 阴性样例）
- 状态机与 approve gate：`tests/unit/wet_loop.test.ts` —— 转移表穷举、未 approve 拒绝执行、
  approve 后改协议要重走一遍、状态机之外改协议同样拦得住
- CLI：`tests/unit/lab_cli.test.ts`
- e2e（**真** `opentrons.simulate`）：`tests/unit/wet_e2e.test.ts` —— 两类协议的 run log
  关键步骤序列 + 全链路（自然语言 → 编译 → 安全门 → approve → 执行 → observation → conclude）
- Python 侧：`tests/lab/opentrons_backend.test.py` —— run log 分类纯函数、父子命令追踪、
  真模拟器执行与失败信封
