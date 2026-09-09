# P6 · 湿实验模拟器 + approve gate（devlog）

> 分支：`feat/p6-wet-lab` · 日期：2026-09-09
> 范围依据：[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md)「P6 湿实验模拟器」；设计依据：[DESIGN.md](../DESIGN.md) 域 B2、域 B3（AD-6）、域 C1

## 一、做了什么

### 1. Opentrons 协议编译器（`backend/src/lab/opentrons_protocol.ts`）

现有 `Protocol`（自然语言编译产物）→ **Opentrons Python Protocol API v2 脚本**。
三条编译纪律，每一条都有对应的单测：

| # | 纪律 | 为什么 |
|---|------|--------|
| 1 | **不猜硬件**。Opentrons 上没有的（离心、340 nm 酶标、<37 °C 孵育、离机配液）编译成 `[spark-note]` 并标 `execution: "manual"` | 把离心编译成一个 `delay` 会让 run log 看起来「跑通了」。那是最糟的一种假成功 |
| 2 | **每一步都有锚点**。每个步骤前注入 `protocol.comment("[spark-step] <id> <action>")` | run log 的结构化解析靠锚点把每条命令绑回编译产物里的某一步。opentrons 换版本改了文案，锚定关系也不会断 |
| 3 | **源码不含时间戳**。`protocolHash = sha256(源码)` | approve gate 批的就是这个 hash。带时间戳的话每次编译都换 hash，approve 永远失效 |

deck 按需加载：有孵育/震荡才装 Heater-Shaker（板放模块上），有四档波长读数才装吸光度读板模块。
不摆用不到的模块——deck 上多一件东西就多一处真机上会碰撞的可能。

**机型选 Flex 不是偏好，是被迫且更好**：opentrons 9.x 已移除 OT-2 支持
（`simulate()` 对 OT-2 协议直接 `RuntimeError`，实测见 §二）；而且 OT-2 没有吸光度读板模块，
「600 nm 读 OD」在 Flex 上才有真模块可用，不必退化成注释。既有的 `OPENTRONS_LIQUID_HANDLER`
（id `opentrons-ot2`）留在 mock 设备层，一行没动。

### 2. 自然语言编译器的两处扩充（`backend/src/lab/protocol.ts`）

协议 B（梯度稀释）在 v0.1 的规则集里根本编译不出来，补了两件事：

- **`serialDilute` 动作规则**（关键词 `梯度稀释 / 连续稀释 / 倍比稀释 / 系列稀释 / serial dilution`）。
  刻意**不收「稀释」单字**——「配制稀释液」说的是配液不是做梯度。
- **「参数续句」合并**。「每步转移 100 µL 并混匀 3 次」里的「转移」会命中 `addSample`，
  凭空多出一步移液；而这句话说的其实是上一步的参数。现在带 `每步/每级/每次/每个梯度/每孔`
  的从句、以及不含任何动作词但带参数的从句，都合并进上一步。
  这比「不认识就跳过」好：跳过会把用户写的参数**静默丢掉**，用户写了却没生效。

既有 6 条规则一条没改，`tests/unit/lab.test.ts` 的 15 个用例全绿。

### 3. 执行后端（`backend/src/lab/opentrons_backend.py` + `wet_backend.ts`）

| 后端 | 角色 | 依赖 |
|------|------|------|
| `opentrons_simulate` | **默认**。跑 `opentrons.simulate.simulate()`，真实解析并执行协议脚本 | opentrons |
| `mock_devices` | 单测后端。从编译产物合成等价形状的 run log | 无 |

保留 mock 的理由与 P5 保留 pyref 同源：单测需要一个在任何环境都跑得通的实现。
但**默认必须是真模拟器**——mock 验的是管线通不通，验不了协议合不合法：
一个 opentrons 拒绝解析的脚本在 mock 上一样会「跑成功」，那是最危险的假绿。

Python 侧沿用 P5 `sim_runtime.py` 的纪律：产出落 `--outdir`，`done.json` 用
「临时文件 + `os.replace`」原子写，**任何异常都转成 `status=failed` 的 done.json**，
绝不留「既没 done.json 又退出」的运行。

**run log 结构化**是这一层最需要小心的地方。`opentrons.simulate` 返回的条目是
`{"level", "payload", "logs"}`，payload 的键随命令而变，官方文档明确说
`payload["text"]` 只是人读串、不保证格式稳定。所以做了两件事：

1. `classify()` 用 (payload 键 + text 前缀) 做确定性分类，产出**我们自己的**类型名
   （`aspirate / dispense / mix / delay / set_temperature / move_labware / …`）；
2. 更重要的是 §1 的 `[spark-step]` 锚点——分类挂了最多是某条命令归错类，
   **步骤归属不会错**。

还有一个容易写错的细节：`transfer()` 和 `mix()` 会把 aspirate/dispense 展开成子命令。
结构化时按 depth 维护一个父命令栈，`summarize()` 统计「转移了多少液体」时
**排除父命令是 `mix` 的 dispense**——混匀是在同一个孔里来回吹打，算进去会把数字吹成好几倍。
不能简单用 `depth == 0` 过滤：`transfer()` 里真正的 dispense 在 depth 1。

### 4. 安全门拆成四条独立规则（`backend/src/lab/safety.ts`）

v0.1 是 `LabSafetyGate.checkProtocol()` 里的三段 if。P6 拆成一组
**零 IO、可单独调用的纯函数**（`SafetyRule { id, check, description, evaluate }`）：

| 规则 id | 显示名 | 拦什么 |
|---------|--------|--------|
| `chemical_compatibility` | chemical compatibility | 强酸 × 次氯酸盐、强酸 × 强碱 |
| `concentration_limit` | concentration limit | 受管制试剂超上限 |
| `biosafety` | biosafety | 超过 BSL-2 |
| **`volume_capacity`**（新增） | volume capacity | 单孔累计超 360 µL、单次转移超出移液器量程 |

拆的理由是**可测性**：混在一个方法里，测「超浓度被拦」时其实同时依赖了另外两条没误报。
新增的 `volume_capacity` 顺带证明了「安全门必须吃编译产物」——
一句「加 200 µL」出现两次，在自然语言层面每一次都合法，
只有排完 deck 把同一孔累加起来才知道 360 µL 的孔会溢。溢孔在真机上就是把样品洒到 deck 上。
没有编译产物时它**不静默放行**：退回单次核对，并在 detail 里写明「单孔累计体积待编译后复核」。

`LabSafetyGate` 保留为门面（三张静态表与 `checkProtocol` 调用面不变），v0.1 的调用方零改动。

### 5. 湿实验状态机 + approve gate（`wet_models.ts` / `wet_loop.ts`）

```
design ─► compile ─► safety_check ─► awaiting_approval ─► wet_run ─► collect ─► analyze ─► concluded
             ▲          │                  │                │                          └► iterated
             │          └► failed          └► rejected      └► failed
             └───────────── 重新编译（清掉 approve / reject / 安全门结论）
```

11 个状态、**18 条合法转移**，表外一律拒绝。

**AD-6 的落点在转移表本身**：`wet_run` 的唯一入边是 `awaiting_approval → wet_run`，
而这条边只有 `approve()` 会走。有一条单测直接断言这件事：

```ts
const doors = WET_EXPERIMENT_STATES.filter((s) => WET_LEGAL_TRANSITIONS[s].includes("wet_run"));
expect(doors).toEqual(["awaiting_approval"]);
```

`safetyCheck()` 通过时连做**两条**转移（`compile → safety_check` 和
`safety_check → awaiting_approval`），都留在 history 里——「门过了」与「停下来等人」
在证据图上必须分得开。安全门不过则走 `compile → failed` 并抛 `LabSafetyError`，
**不进** `awaiting_approval`。

approve / reject 各落一条 `decision` record（`evidence=inferred`，`derives_from` 边连实验），
metadata 记 **谁 / 何时 / 批的是哪个 protocolHash**，正文里列出批的那一版步骤表与当时的安全门结论。
「批过了」和「批的是这一版」是两件事。

**协议 hash 变了要重新走一遍**，两道门：
1. 进入 `compile` **一律清掉** approve/reject 与安全门结论（重新编译意味着方案在改）；
2. `execute()` 在执行前把审批的 hash 与当前编译产物的 hash **再对一次**。

第 2 道看起来与第 1 道冗余（compile 会清 approval），但它防的是状态机之外的路径——
有人直接改了 record、或者两个进程并发编译。单测里就是这么打的：直接
`records.update(id, {metadata: {naturalLanguage: 另一份协议}})`，
状态仍是 `wet_run`、审批还在，`execute()` 照样拒绝并把实验标 `failed`。
物理世界的操作值得一道冗余的锁。

### 6. 干湿闭环接通

`WetLabLoop.deriveFromDry(dryLoop, dryRef, …)`，两条路径语义不同、边也不同：

| 干实验状态 | 语义 | 边 | 干线去向 |
|-----------|------|-----|---------|
| `analyze` | 干线到此为止，湿线接棒 | 湿 `--supersedes-->` 干（+ `derives_from`） | 转终态 `iterated` |
| `concluded` | 结论成立，拿去湿实验验证 | 湿 `--derives_from-->` 干 | 保持 `concluded` |

还没跑出观察的干实验（`design`/`dry_run`/…）拒绝派生——「还没跑出观察就谈湿实验验证，验证的是什么？」

为此给 P5 的 `ExperimentLoop` 加了一个 `markIterated()`：把 analyze 中的干实验直接推到终态，
**不**新建干实验（接棒的是另一张状态机上的湿实验，`iterate()` 建不出来）。

### 7. 顺手修的一个跨阶段隐患

同一个项目里现在会同时有干实验与湿实验（都是 `type=experiment` 的 record，两套 metadata）。
P5 的 `ExperimentLoop.list()/get()` 不认 mode，会把湿实验也读进来，
而 `toView()` 遇到 `awaiting_approval` 这种不认识的状态会**悄悄降级成 `design`**——
读出来是一条不存在的假实验。已加 `mode !== "wet"` 过滤，并有单测钉住。

### 8. 技能与 CLI

- `backend/src/skills/wet-protocol/SKILL.md`：5 条铁律 + 状态机 + 安全门四规则表 +
  动作→编译目标映射表 + 8 条反模式（「用 mock 后端跑通就说协议验证过了」）
- `spark-research lab compile | approve | reject | simulate | status | backends`。
  `compile` 一步走到 `awaiting_approval` 并**只**给出 approve 的下一步提示，
  绝不提示 `simulate`——CLI 层也不给「直接执行」的路子。退出码 1 = 安全门拦截 /
  未经 approve 就执行 / 模拟器拒绝协议。

## 二、Opentrons 安装与模拟器实况

**装上了，纯 pip 路径，没有降级方案的必要。**

```
$ VIRTUAL_ENV=.venv uv pip install opentrons
 + opentrons==9.1.2
 + opentrons-shared-data==9.1.2
 + pydantic==2.13.5  pyro5==5.17  jsonschema==4.17.3  pyserial  pyusb  anyio …
 - numpy==2.5.3
 + numpy==1.26.4          ← 唯一一处降级（opentrons-shared-data 的约束）
$ .venv/bin/python -c "import opentrons, openmm; print(opentrons.__version__, openmm.version.version)"
9.1.2 8.6.0.dev-c6173db
$ ls .venv/bin | grep opentrons
opentrons_execute
opentrons_simulate
```

- numpy 从 2.5.3 降到 1.26.4 是唯一副作用。**实测 openmm 8.6 在 numpy 1.26.4 下照常工作**：
  P5 的 26 个契约测试（含 openmm 侧 13 个）全绿，没有 skip。
- 只动仓库根的 `.venv`，系统 python 一行没碰。`pyproject.toml` 已登记 `opentrons >= 9.0` 并注明 numpy 约束。

### 踩到的两个坑（都是实测得出）

**坑 1：opentrons 9.x 拒绝 OT-2 协议。**

```
RuntimeError: This protocol is designed for an OT-2 robot. To utilize this protocol,
please download the most recent version of the Opentrons-OT2 app …
```

一个标准的 `metadata = {"apiLevel": "2.16"}` + `load_instrument("p300_single_gen2", …)` 协议
直接被拒。降级到 opentrons 8.x 能恢复 OT-2 支持，但**没这么做**：Flex 侧有吸光度读板模块，
协议 A 的「600 nm 读 OD」能用真模块而不是注释，信息量更大。这属于与任务书的一处偏差，见 §七。

**坑 2：吸光度读板模块的开合盖次序。**

```
CommandPreconditionViolated: Cannot move corning_96_wellplate_360ul_flat
onto the Absorbance Reader Module when its lid is closed.
```

正确次序是 **关盖 → initialize → 开盖 → 搬板进去 → 关盖 → read → 开盖 → 搬板出来**。
`initialize()` 要求关盖，`move_labware` 要求开盖。编译器把这个次序写死了，
并有一条单测断言 `close_lid → initialize → move_labware` 的先后关系——
这类「必须按顺序」的约束一旦回归，报错信息离根因很远。

### 性能

单个协议模拟 **0.03 s**（纯 `simulate()` 调用），算上起 python 子进程与 import opentrons
约 **0.8–1.1 s**。整个 P6 e2e 套件 4 个用例 **4.4 s**。这比 P5 的 OpenMM（2 s/次）还快，
e2e 规模上完全不用克制。

## 三、两类协议的 run log（本机真实执行，2026-09-09）

### 协议 A · 移液 + 孵育 + 读数

输入（自然语言）：`取样品50µL加入96孔板，37°C孵育1小时，600nm读取OD`
→ 3 步 · `protocolHash 81ada198c45769e1` · 19 条 run log · 0.89 s

```
Latching labware on Heater-Shaker
[spark-note] reservoir A1 = sample
[spark-step] step-1 addSample
Transferring [50.0] from A1 of NEST 12 Well Reservoir 15 mL on slot D2
            to A1 of Corning 96 Well Plate 360 µL Flat on Heater-Shaker Module GEN1 on slot D1
	Picking up tip from A1 of Opentrons Flex 96 Tip Rack 200 µL on slot C1
	Aspirating 50.0 uL from A1 of NEST 12 Well Reservoir 15 mL on slot D2 at 716.0 uL/sec
	Dispensing 50.0 uL into A1 of Corning 96 Well Plate 360 µL Flat on Heater-Shaker … at 716.0 uL/sec
	Dropping tip into Trash Bin on slot A3
[spark-step] step-2 incubate
Setting Target Temperature of Heater-Shaker to 37 °C
Waiting for Heater-Shaker to reach target temperature
Delaying for 60 minutes and 0.0 seconds. step-2 incubate 37C
Deactivating Heater
[spark-step] step-3 read
Unlatching labware on Heater-Shaker
Moving corning_96_wellplate_360ul_flat to AbsorbanceReaderContext … with gripper
Moving corning_96_wellplate_360ul_flat to HeaterShakerContext … with gripper
Latching labware on Heater-Shaker
[spark-read] {"stepId": "step-3", "wavelength": 600, "wells": {"600": {"wells": 96, "min": 0.0, "max": 0.0}}}
```

摘要：`protocolSteps 3 · dispensedUl 50 · delaySeconds 3600 · maxTemperatureC 37 · readings 1 · moveLabware 2`

e2e 断言的是**步骤序列**而不是「跑完了」：
`step-1 = [transfer, pick_up_tip, aspirate, dispense, drop_tip]`、
`step-2 = [set_temperature, wait_temperature, delay, deactivate]`、
`step-3` 含 2 次 `move_labware` 且以 `read_result` 收尾。

**诚实记一条**：读板模块在模拟器里给的是 96 个孔的读数，值全是 `0.0`
（模拟硬件没有真实光信号）。断言的是「96 个孔、波长 600、结构完整」，
**不**断言数值——把模拟器的 0.0 当成生物学读数是这个技能里最该防的一件事。
`renderWetObservation` 因此在 observation 正文第一行就写「协议引擎真实执行，硬件为模拟」。

### 协议 B · 梯度稀释

输入：`配制5000uL稀释液，对样品做6个梯度的连续稀释，每步转移100uL并混匀3次`
→ 2 步 · `protocolHash a11b33c8e279ee1e` · 79 条 run log · 0.79 s

```
[spark-note] reservoir A1 = reagent / A2 = stock / A3 = diluent
[spark-step] step-1 prepareReagent
[spark-note] step-1 装载 reagent 5000 µL → reservoir A1        ← 离机配液，一滴液体都没动
[spark-step] step-2 serialDilute
Transferring 100.0 from A3(diluent) … to A2 / A3 / A4 / A5 / A6      （分装稀释液，1 个 tip）
Transferring 200.0 from A2(stock)   … to A1                           （原液，1 个 tip）
Picking up tip → Aspirating 100.0 from A1 → Dispensing 100.0 into A2
    → Mixing 3 times with a volume of 80.0 ul → Dropping tip          （A1→A2）
… 同样的五联动作重复到 A5→A6                                          （每级一个新 tip）
```

摘要：`protocolSteps 2 · tipPickups 7 · mixes 5 · dispensedUl 1200 · readings 0 · moveLabware 0`

体积记账对得上：500（稀释液 5 孔）+ 200（原液）+ 5×100（级间）= **1200 µL**，
混匀的来回吹打（5 × 3 × 80 = 1200 µL）**没有**被计入。

孔体积最终是 `A1..A5 = 100 µL、A6 = 200 µL` —— 全部在 360 µL 容量内。
第 1 孔刻意进 `稀释液 + 每级转移量 = 200 µL`，转走一份后仍留 100 µL，与其余孔齐平；
否则 A1 会被抽空，曲线的第一点就没了。

**每一级换新 tip** 是编译器写死的：连续稀释里复用 tip 会把上一级的浓度带下去，整条曲线作废。
e2e 断言 `pick_up_tip` 与 `drop_tip` 各 7 次、`mix` 5 次且每次 `repetitions=3, volume=80`。

### 负样本 · 模拟器拒绝非法协议

把 `corning_96_wellplate_360ul_flat` 换成 `totally_not_a_labware`（**真实**失败模式，
不是人为的错误开关）→ `status: "failed"`、`entries: []`、`done.json` 带 error 与 traceback。
不假装成功，也不留空信封。

## 四、safety gate 对抗矩阵

`tests/unit/lab_safety.test.ts`，**每条规则单独打**（混在一起测，通不过的可能是别的规则）。

| 规则 | 对抗样例 | 期望 | 结果 |
|------|---------|------|------|
| chemical_compatibility | 盐酸 + 次氯酸钠 | 拦截，detail 指名两样 | ✅ |
| chemical_compatibility | 盐酸 + 氢氧化钠 | 拦截 | ✅ |
| chemical_compatibility | 乙醇 + 盐酸（表外组合） | **放行**（不做无差别拦截） | ✅ |
| concentration_limit | 次氯酸钠 500（上限 100） | 拦截，报出实际值 | ✅ |
| concentration_limit | 乙醇 95（恰好等于上限） | **放行**（边界不误杀） | ✅ |
| concentration_limit | buffer 9999（表外试剂） | **放行**（不凭空造标准） | ✅ |
| biosafety | 步骤标 BSL-3 | 拦截，指名步骤 | ✅ |
| biosafety | 步骤标 BSL-2 | **放行** | ✅ |
| volume_capacity | 单次 500 µL → 360 µL 的孔 | 拦截 | ✅ |
| volume_capacity | 200 + 200 µL **累计**溢孔（单看都合法） | 拦截 | ✅ |
| volume_capacity | 单次 2 µL（低于移液器最小量程） | 拦截 | ✅ |
| volume_capacity | 无编译产物时 | 退回单次核对 + detail 说明查了什么 | ✅ |
| volume_capacity | 协议 B 整排梯度 | **放行**（都在容量内） | ✅ |
| 规则隔离 | 浓度爆表的单一试剂 | 兼容性规则放行、浓度规则拦截 | ✅ |
| 纯函数性 | 同一输入调两次 | 结果逐字相同 | ✅ |

**「缺 approve 直接执行」是状态机层的拦截，不是安全门规则**（安全门管协议内容，
状态机管流程），对抗样例在 `wet_loop.test.ts` / `lab_cli.test.ts`：

| 对抗 | 层 | 结果 |
|------|-----|------|
| `design` / `compile` / `safety_check` / `awaiting_approval` 状态下直接 `execute()` | API | `ApprovalRequiredError` ✅ |
| `rejected` 状态下 `execute()` | API | `ApprovalRequiredError` ✅ |
| CLI `lab simulate <id>` 未 approve | CLI | 退出码 1 + 「未经 approve 不能执行」+ 合法路径 ✅ |
| approve 后重新编译再 `execute()` | API | approval 已清，拒绝 ✅ |
| **绕过状态机**直接改 record 的协议原文后 `execute()` | API | hash 复核拦截 → 标 `failed` ✅ |
| 重复 approve / 未编译就 approve / approve 不记名 | API | 分别 `WetStateError` / `WetStateError` / `ApprovalRequiredError` ✅ |
| reject 不给理由 | API | `ApprovalRequiredError` ✅ |
| 已执行过的实验就地重编译 | API | `WetStateError` ✅ |

## 五、测试结果

```
$ bun run typecheck
（无输出，clean）

$ bun test tests/unit/
 557 pass
 0 fail
 2548 expect() calls
Ran 557 tests across 33 files. [29.93s]

$ .venv/bin/python -m pytest tests/ -q
48 passed in 3.50s
```

- 基线 **456 个一个没动、全绿**（含 P5 的 26 个契约测试，openmm 侧在 numpy 1.26.4 下无 skip）；
  新增 **101** 个：

| 文件 | 数量 | 覆盖 |
|------|------|------|
| `tests/unit/lab_compile.test.ts` | 25 | 自然语言新规则、脚本骨架、hash 确定性、deck 按需加载、体积记账、拒绝路径 |
| `tests/unit/lab_safety.test.ts` | 20 | 四条规则各自的对抗 + 阴性样例、规则隔离、纯函数性、门面兼容 |
| `tests/unit/wet_loop.test.ts` | 34 | 转移表穷举（18 合法 + 103 非法）、approve gate 全路径、hash 失效两种、干湿闭环三情形、换进程接回 |
| `tests/unit/lab_cli.test.ts` | 18 | 六个子命令、`--json`、安全门拦截退出码、approve/reject 路径 |
| `tests/unit/wet_e2e.test.ts` | 4 | **真** `opentrons.simulate`：协议 A / 协议 B / 非法协议负样本 / 全链路 e2e |

Python 侧 `tests/lab/opentrons_backend.test.py` 新增 **20** 个（`classify` 逐类型、
未知文案落 `comment` 不瞎猜、步骤锚定不倒填、父子命令追踪、混匀不计入转移量、
真模拟器执行、失败信封、`--probe`、参数校验）。既有 `protocol_agent.test.py` 的 28 个未动。

**连跑 3 次 `bun test tests/unit/` 全绿，无 flake**（557 / 557 / 557，29.9s / 29.4s / 29.7s）。

## 六、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | 编译目标是 **Flex** 不是 OT-2 | opentrons 9.x 已移除 OT-2 支持（实测 `RuntimeError`）；且 Flex 有吸光度读板模块，600 nm 读 OD 能用真模块。降级到 8.x 换 OT-2 支持是可行的备选，但换来的是更少的硬件能力 |
| D2 | 湿实验用**另一张状态机**，不扩 P5 的表 | 两条链的状态集不同；而且 P5 的转移表被一组穷举测试（`length² - 7`）锁死，加状态会把那组测试的语义悄悄改掉。共用的是 record 存储、边语义、`RecordStore.update()` 窄口——那些才是该复用的 |
| D3 | `approve()` 直接把状态推进 `wet_run`，不另设 `approved` 中间态 | DEVELOPMENT_PLAN 给的链路就是 `awaiting_approval → wet_run`。`wet_run` 的语义是「已批准，可执行/执行中」，用 `runId` 是否为空区分。加中间态是更啰嗦的同义写法 |
| D4 | 进入 `compile` **一律**清 approve，而不是只在 hash 变了时清 | 重新编译意味着方案在改。「hash 恰好没变所以旧批准还算数」是一条只在测试里成立的路径，真实场景里它只会让人误以为批准还有效 |
| D5 | `execute()` 再对一次 hash（与 D4 冗余） | D4 守的是状态机内的路径。冗余这一道守的是状态机外——直接改 record、并发编译。物理世界的操作值得一道冗余的锁 |
| D6 | 湿实验执行是 **await 子进程**，不做 P5 那套 detach + poll | 实测单协议 30–60 ms。为秒级任务上一整套跨进程生命周期是过度设计。磁盘仍是真源（`protocol.py`/`runlog.json`/`done.json` 原子写），换进程照样能接回状态 |
| D7 | Opentrons 没有的硬件编译成 `[spark-note]` + `execution: "manual"` | 编译成 `delay` 会让 run log 看起来跑通了。`manual` 这个字段让「模拟器执行过」与「人要自己做」在数据层面就分得开 |
| D8 | `prepareReagent` 编译成**离机配液装载**，不是往板孔里打液 | Flex 不会自己配缓冲液。而且「配 50 mL 培养基」按原语义会往 360 µL 的孔里倒 50 mL，触发一条本不该存在的安全告警 |
| D9 | run log 锚点用**注入的 comment**，不靠解析 opentrons 文案 | 官方文档明说 `payload["text"]` 格式不保证稳定。文案分类挂了最多归错类，步骤归属不会错 |
| D10 | 湿实验 observation 的 evidence 是 `observed`，不是 `computed` | run log 记的是设备做了什么，是观察不是计算。模拟器执行同样算 observed，但正文与 metadata 里明写「硬件为模拟」——数据来源要能被读图的人分辨 |
| D11 | 安全门拆规则时**保持三个显示名不变** | v0.1 起 `"chemical compatibility"` 等字符串就是外部断言的对照物。拆内部结构不该顺手改调用面 |
| D12 | 「参数续句」合并而不是跳过 | 不认识就跳过会把用户写的参数静默丢掉——用户写了却没生效，比多一步更难发现 |

## 七、与设计的偏差

1. **机型是 Flex 不是 OT-2**（DESIGN B2 与任务书都只说「Opentrons 官方模拟器」，
   没指定机型；但仓库里既有的设备 id 是 `opentrons-ot2`）。理由见 D1，已写进 DESIGN B2 落地口径。
   mock 设备层的 `opentrons-ot2` 原样保留，未改。
2. **状态集从任务书的 8 个扩到 11 个**：任务书写 `design → compile → safety_check →
   awaiting_approval → wet_run → collect → analyze → conclude`。实际补了 `rejected`（任务书
   自己要求的拒绝路径）、`failed`（安全门拦截与执行失败的落点）、`iterated`（与 P5 对齐的
   iterate 终态）。链路本身与任务书**逐字一致**，只是补了分支。
3. **`ProtocolCompiler` 加了一条动作规则 + 一处续句合并**（跨模块改动）：
   协议 B 在 v0.1 的规则集里编译不出来。既有 6 条规则与 12 个既有用例零改动。
4. **`prepareReagent` 的 Opentrons 编译语义变了**（见 D8）。只影响 P6 新增的
   Opentrons 编译路径；mock 设备层的 `prepareReagent` 行为一行没动。
5. **给 P5 的 `ExperimentLoop` 加了 `markIterated()` 与 mode 过滤**（跨阶段改动）：
   前者是干湿接棒必需的（接棒的是另一张状态机上的记录，`iterate()` 建不出来）；
   后者修的是一个 P6 引入才会触发的静默故障（见 §一.7）。两处都是只增不改，P5 的 90 个测试全绿。
6. **CLI 多了一个 `backends` 子命令**：任务书列的是 `compile|simulate|approve|reject|status`。
   加 `backends` 与 P5 加 `exp platforms` 同一理由——模拟器可用性是环境相关的，
   用户第一件想知道的事就是「我这台机器能不能跑」。
7. **`--from-dry` 挂在 `compile` 下而不是单独的子命令**：干湿接通是「新建一条湿实验」的一个
   变体，不值得占一个子命令。

## 八、给主会话的审查重点

1. **D3（approve 直接进 `wet_run`）与 D4（compile 一律清 approve）是一对绑定的选择，请一起看。**
   现在 `wet_run` 同时表示「已批准待执行」和「执行中」，靠 `runId` 是否为空区分；
   而「approve 之后改协议」的路径是 `wet_run → compile`（只在 `runId` 为空时允许）。
   这条边是整张表里唯一一条「往回走且带守卫」的转移，也是我最不确定的一处。
   备选是加一个 `approved` 中间态，让 `wet_run` 纯粹表示「正在执行」，代价是多一个状态、
   而且与任务书写的链路不再逐字对应。**要不要现在改，请定个口径**——
   P7 的实验面板要画这张状态机，晚了就要改 UI。

2. **模拟器读数全是 0.0 这件事，下游还没有消化。**
   吸光度读板模块在模拟器里返回 96 个孔的 `0.0`。现在的处理是：observation 正文第一行写
   「硬件为模拟」、metadata 带 `simulated: true`，e2e 只断言结构不断言数值。
   但 P8 的报告导出与域 E1 的「数据-结论一致性」检查器都会读到这些 0.0。
   这与 P5 主会话裁决 3（`deterministic` 能力位）是**同一类问题**：产物需要携带一个位
   让下游知道「这个数字能不能当真」。建议在 observation metadata 里把 `simulated`
   升格为与 `deterministic` 并列的一等能力位，并在 P8 报告里强制渲染。**建议在 P8 之前定下来。**

3. **`decision` record 的 actor 目前可以来自 `$USER`（CLI 层默认值）。**
   `approve()` 在 API 层强制非空，但 CLI 在没给 `--actor` 时回落到
   `SPARK_ACTOR > USER > "unknown"`。这是诚实的（就是这个人在这台机器上敲的命令），
   但**审计上「显式署名」与「取自环境」是两回事**，现在 record 里分不出来。
   最小修法是在 decision metadata 里加一个 `actorSource: "explicit" | "env"`。
   我没擅自加——它会改 decision record 的 schema，而 P7/P8 都要读这张表。

## 九、留给后续阶段的钩子

- `WetLabBackend` 是通用契约：接真实设备（v0.3+ 的物理 Opentrons / 其他厂商）只需实现
  `id / description / available / execute` 三个方法加进 `wetBackend()` 的 switch，
  状态机与 approve gate 一行不用改。真机后端的 `execute()` 语义是「批准之后真的动手」——
  approve gate 的价值到那时才完全兑现。
- `SafetyRule` 是纯函数数组，加规则只需往 `SAFETY_RULES` 里推一条（比如
  「同一 tip 跨试剂复用」「加热时未关舱盖」），对抗矩阵按同一模板补一行即可。
- `structure_runlog()` 的父命令追踪对任何「复合命令展开成子命令」的后端都适用，
  不只是 opentrons。
- P7 实验面板要画的状态机与 approve 按钮：`WET_LEGAL_TRANSITIONS` 就是图的邻接表，
  `WetExperimentView` 已经是可直接投影的形状（`viewJson()` 剥掉 record 本体即为 API 响应）。
- **backlog 建议**：
  1. `simulated` 升格为一等能力位（见审查重点 2）
  2. `decision.actorSource`（见审查重点 3）
  3. 多通道移液（`flex_8channel_1000`）——现在 96 孔整板操作要逐孔发命令，
    真实通量协议会让 run log 膨胀到几千条
  4. `opentrons analyze --json-output` 的结构化命令流：比 `simulate()` 的 runlog 更结构化
    （有 `commandType` 与 `params`），但需要走 CLI 子进程且输出体积大得多。
    等到「run log 要进 Reviewer 做数据-结论一致性检查」时再评估
  5. 协议 B 的稀释倍数目前只从句子里抠 `factor` 但没用于体积计算——
    真正的倍比稀释要按 factor 算稀释液与原液的比例，现在是等体积 1:2。
    要支持任意倍数得让 `serialDilute` 的体积参数联动
