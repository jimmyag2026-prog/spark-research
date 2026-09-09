# P5 · 干实验闭环（devlog）

> 分支：`feat/p5-dry-experiment` · 日期：2026-09-09
> 范围依据：[DEVELOPMENT_PLAN.md](../DEVELOPMENT_PLAN.md)「P5 干实验闭环」；设计依据：[DESIGN.md](../DESIGN.md) 域 B1（AD-4）、域 B3、域 C1

## 一、做了什么

### 1. `SimulationPlatform` 契约（`backend/src/simulation/`）

AD-4 的落点：**仿真不是 connector**。connector 是幂等的一问一答，仿真是长任务生命周期。
接口四个动作 `prepare / submit / poll / collect`（外加 `available / cancel / listRuns`），
配四条写进注释、由契约测试逐条守的不变量：

| # | 不变量 | 为什么 |
|---|--------|--------|
| 1 | `prepare` 确定性：同一 spec → 同一 `specHash` + 同一份归一化参数 | 「这次实验能不能重放」的判据 |
| 2 | `submit` 非阻塞：立刻返回 runId，任务在别的进程里跑 | 阻塞的 submit 会把整个会话堵死 |
| 3 | `poll` 只读且**跨进程可用** | 这是 P5 退出标准（kill 后续跑）的全部技术前提 |
| 4 | `collect` 只在 completed 时给结果 | running/failed 给半成品比不给更糟 |

**状态真源在磁盘，不在内存。** 这是本阶段最关键的一个决定（D1）。每个 run 一个目录：

```
experiments/<platform>/runs/<runId>/
    run.json     编排侧写的状态（pid / 归一化参数 / 时间戳 / 预期产出）
    params.json  runner 的输入
    done.json    runner 写的结果信封，**存在即表示任务已终结**
    stdout.log / stderr.log   直接落文件，不走 pipe
    <产出文件…>
experiments/<platform>/prepared/<specHash>/params.json
```

`poll` 的判定顺序是**先看 done.json 再看 pid**：任务写完结果才退出，所以只要结果在，
无论 pid 是死是活（僵尸进程 / PID 复用）都以结果为准。PID 复用最坏只会让一个已死的任务
多「running」一会儿，**不会把失败报成成功**——这是刻意选的错误方向。

`done.json` 用「临时文件 + `os.replace`」原子落盘。半写的结果文件比没有结果更糟：
编排层会把它当成一份可信的终态。`RunStore.done()` 另外做了一层防御——解析失败或
`status` 不是那两个值，一律当成「还没完成」。

stdout/stderr 落文件而不是 pipe：编排进程被 kill 之后 pipe 就没人读了，落文件才能在
重启后还看得到任务说过什么。

### 2. 参考实现 ×2

| adapter | 任务 | 依赖 | 角色 |
|---------|------|------|------|
| `openmm` | `water-box-md`：显式溶剂水盒子 → 能量最小化 → 短时 NVT 平衡 | `openmm>=8.1` | 真实科学负载 |
| `pyref` | `damped-oscillator`：阻尼谐振子 RK4 定步长积分 | **无**（纯标准库） | 契约的第二实现 + CI 里永远跑得通的那一个 |

**pyref 不是玩具占位。** 选阻尼谐振子是因为它同时满足三件事：零依赖、确定性、
**有解析解可对照**。第三点是刻意的——一个只会「跑完不报错」的参考实现，
验证不了契约测试之外的任何东西。它的 summary 里带 `maxAbsErrorVsAnalytic`，
实测 `dt=0.001` 下误差 < 1e-9，「算对了没有」是可判定的。

两个 runner 共用 `sim_runtime.py`（`RunContext`：argparse → 产出声明 → 进度 → 原子终态），
且都用 `with` 上下文管理：未捕获异常一律转成 `status=failed` 的 done.json，
**绝不留「既没 done.json 又退出」的运行**。

### 3. 闭环状态机（`backend/src/experiment/`）

```
design ──► dry_run ──► collect ──► analyze ──► concluded
             │                            └──► iterated ──► （新 experiment，supersedes 旧的）
             └► failed ──► dry_run（retry）
```

7 个状态、**7 条合法转移**，表外一律拒绝。`iterate` / `conclude` 实现为终态而不是动作名：
iterate 的语义就是「这条实验到此为止，另起一条」。

三条不变量：
1. **状态只在 experiment record 里**，走 P4 定的 `RecordStore.update()` 窄口回写。
   内存里不留任何权威状态——否则「进程 kill 后续跑」无从谈起。
2. **仿真任务状态只在磁盘上**（上面的 RunStore）。所以 `resume()` 能在一个全新的进程里接回来。
3. **非法转移一律拒绝，不做「顺手纠正」**。状态机悄悄自愈等于没有状态机。

`resume()` 区分三种断点情形，这是 P5 验证要求逐条覆盖的：

| 情形 | 判据 | 动作 | `recoverable` |
|------|------|------|--------------|
| 任务仍在跑 | 无 done.json，pid 活着 | 保持 `dry_run`，接着等 | — |
| 任务已完成 | 有 done.json（completed） | 直接进 `collect` | — |
| 任务已丢失 | 无 done.json，pid 没了 | 标 `failed` | **true** |

`recoverable` 这个字段是「随进程一起被杀」与「算例本身跑挂」的分界线——
前者重跑就好，后者要改参数。混着报等于让用户在错误的方向上排查。

另外两个变体也覆盖了：`dry_run` 但 `runId` 为空（提交过程中断）、run 目录整个不见了。

### 4. Kernel/artifact 集成

`collect()` 把每个产出文件送进 artifact store（带 lineage message），再建 artifact record 并连
`derives_from` 边回实验。`producingCellId` 约定为 `${experimentId}:${attempt}`，
于是 `artifacts.listBySession(experimentId)` 能一次取回这条实验的全部产出。

`analyze()` 产出 observation record：`evidence=computed`（结果是**算**出来的，
既不是看出来的也不是推出来的），正文由代码渲染的摘要表，`derives_from` 边连实验 + 每个产出。

### 5. 技能 ×2 与 CLI

- `backend/src/skills/dry-experiment/SKILL.md`：5 条铁律 + 状态机 + 断点续跑判据表 + 8 条反模式
  （「仿真失败了就改小 steps 直到跑通，然后当成结果」）
- `backend/src/skills/protein-analysis/SKILL.md`：4 条铁律 + 结果判读表（含「现在还不该往下走」）
  + 6 条反模式（「把 pLDDT 当成分辨率 Å 来比较」）
- `spark-research exp new|run|status|list|platforms`，`run --resume` 只接不重提。
  退出码 1 = 仿真失败或参数非法。

### 6. protein-analysis 链路（`backend/src/proteins/analysis.ts`）

`uniprot.search` → `pdb.searchByUniProt` + `pdb.getStructure` → `alphafold.getModel`，
报告正文由代码渲染。给 `PDBConnector` 加了 `searchByUniProt` 工具——刻意**不走** UniProt
条目自带的 PDB 交叉引用：人血红蛋白 β 链有 350 条结构，一次拉回来既慢又会把 fixture 撑爆；
RCSB 搜索能用 `rows` 在**服务端**截断，`total_count` 仍如实返回。

「没有实验结构」「AlphaFold 取不到模型」都当成**结论**而不是故障——链路不因某一段拿不到就整体失败，
但也不会把空结果粉饰成「结构可用」。

## 二、OpenMM 环境实况

**装上了，而且是纯 pip 路径。** 这与设计文档写的「pip 可装」一致，但值得记下过程，
因为 OpenMM 历史上是 conda-only。

```
$ uv venv --python 3.12 .venv          # 仓库根本来没有 .venv，本阶段新建
Using CPython 3.12.12
$ VIRTUAL_ENV=.venv uv pip install openmm
 + numpy==2.5.3
 + openmm==8.6.0            # macOS arm64 wheel，12.3 MiB，3.4s 装完
$ .venv/bin/python -c "import openmm; ..."
openmm 8.6.0.dev-c6173db
platforms: ['Reference', 'CPU', 'OpenCL']
```

- 系统 python 是 3.9.6，**一行没动**。全部依赖进仓库根的 `.venv`（`.gitignore` 已忽略）。
- `pyproject.toml` 登记了 `openmm >= 8.1` 与 `pytest >= 8.0`。
- 本机有 OpenCL 平台但没有 CUDA；默认用 `CPU`（多线程），秒级完成，不需要 GPU。

### 真实运行结果（走完整闭环，2026-09-09 本机实跑）

`design → dry_run → collect → analyze → conclude`，2.0 秒墙钟：

```
atoms 774 · waterMolecules 258 · box 2.0 nm · tip3pfb · CPU · openmm 8.6.0
steps 500 × 2 fs = 1.0 ps

E_initial      =    -10.91 kJ/mol      （addSolvent 刚摆完水，几乎没有相互作用能）
E_minimized    = -14291.17 kJ/mol      （最小化下降 14280 kJ/mol）
E_final(pot)   = -13028 kJ/mol
E_final(kin)   =   1623 kJ/mol
T_mean(后半程) =    242.8 K            （目标 300 K）
产出：energy.csv (1.0 KB, 11 采样点) + final_state.xml (124.7 KB)
```

能量轨迹（`energy.csv` 真实内容节选）：

| step | t (ps) | 势能 | 动能 | 温度 (K) |
|------|--------|------|------|---------|
| 0 | 0.0 | -14291.2 | 1916.6 | 298.4 |
| 100 | 0.2 | -13280.0 | 1158.2 | 180.3 |
| 250 | 0.5 | -13157.7 | 1472.0 | 229.2 |
| 500 | 1.0 | -13027.8 | 1622.9 | 252.7 |

**诚实记一条：1 ps 远不足以让水盒子达到 300 K。** 温度从初始赋速的 298 K 掉到 180 K
（最小化后的构型势能被释放成动能又被 Langevin 恒温器带走），再单调爬回 252 K，
趋势对但没到平台。这是「最小任务」的固有代价，不是 bug。要看真正的平衡态得跑 ≥ 100 ps，
那就不是秒级测试了。技能文档里明确写了反模式：「OpenMM 只跑几百步就宣称已平衡」。

### OpenMM 的可复现性边界（实测发现，重要）

同一个 `specHash` **不保证**同一个结果。实测三次完全相同的输入：

```
E0=-10.905465  E_min=-14614.4638
E0=-10.905465  E_min=-14510.5391
E0=-10.905465  E_min=-14587.9703
```

初始态逐位相同（`Modeller.addSolvent` 的水分子摆放是确定的，验证过首原子坐标三次一致），
但 `minimizeEnergy()` 的结果差了上百 kJ/mol。原因是 CPU 平台多线程求和的浮点归约顺序不固定，
L-BFGS 在不同的点终止。

这个发现直接影响契约测试的写法：**断言 summary 的键存在与量级，不断言精确数值**。
`specHash` 的语义因此要收窄为「同一份输入」而不是「同一个结果」——已在 DESIGN B1 落地口径里写明。
pyref 侧没有这个问题（单线程纯 Python，逐位可复现，所以它能断言 `maxAbsErrorVsAnalytic < 1e-9`）。

## 三、契约测试矩阵

`tests/helpers/simulation_contract.ts` 定义 13 个用例，`tests/unit/simulation_contract.test.ts`
把它**参数化跑在两个实现上**。同一组断言，逐字节相同。

| # | 用例 | pyref | openmm |
|---|------|-------|--------|
| 1 | id / description / kinds 都不为空 | ✅ | ✅ |
| 2 | `available()` 报可用且带可诊断 detail | ✅ | ✅ |
| 3 | prepare 确定性：等价 spec → 同 specHash + 同归一化参数 + 落盘 params.json | ✅ | ✅ |
| 4 | prepare 区分不同算例：参数不同 → specHash 不同 | ✅ | ✅ |
| 5 | prepare 拒绝未知任务种类 | ✅ | ✅ |
| 6 | prepare 拒绝非法参数（不把 NaN 递给 runner） | ✅ | ✅ |
| 7 | prepare 拒绝平台不匹配的 spec | ✅ | ✅ |
| 8 | submit 非阻塞 → poll 到 completed → collect 给产出 + 标量摘要 + 日志 | ✅ | ✅ |
| 9 | **跨实例重连**：换平台实例仍能 poll + collect 同一个 run | ✅ | ✅ |
| 10 | poll / collect / cancel 未知 runId 抛 `UnknownRunError` | ✅ | ✅ |
| 11 | 运行中 collect 抛错（不给半成品） | ✅ | ✅ |
| 12 | cancel → failed 且 recoverable，终态幂等，collect 仍拒绝 | ✅ | ✅ |
| 13 | 算例自身失败 → poll 落 failed 带错误信息，collect 拒绝 | ✅ | ✅ |

**26 pass / 0 fail，3.6 秒。** OpenMM 侧没有 skip 任何一条。

第 13 条的失败样本刻意选了**真实失败模式**，不是人为的错误开关：

- pyref：`dt=5`（远大于固有周期）→ RK4 指数发散，runner 检测到 `|x| > 1e6` 报 `ArithmeticError`
- openmm：`boxSizeNm=1.2, cutoffNm=0.9` → 截断半径超过半盒长，OpenMM 自己拒绝创建 PME 体系

两者在 `prepare` 阶段都会给出**警告但不拒绝**——这正是契约需要的「参数合法、算例会挂」路径。

`skip` 机制：`available()` 不 ok 时整套 `describe.skip` 并 `console.warn` 打印原因。
本机两边都可用，所以矩阵是满的。

## 四、kill 恢复的覆盖方式

三个层次，从「注入」到「真杀」逐级加真：

### 层一 · 单测里的真实子进程 kill（`tests/unit/experiment.test.ts`）

用 `restart()` 辅助（关闭全部存储句柄 → 新 `ProjectManager` 重开）模拟进程重启，
三种情形逐条覆盖：

- **仍在跑**：起一个 `stallSeconds=2` 的任务 → 重启 → `resume()` 得 `still_running`
  → 续跑到 analyze，**`attempts` 仍是 1**（恢复不是重跑）→ conclude
- **已完成**：等 done.json 落盘 → 重启 → `resume()` 得 `ready_to_collect` → collect 出 2 个产出
- **已丢失**：`process.kill(pid, SIGKILL)` 真杀仿真子进程 → 确认 pid 死透 → 重启 →
  `resume()` 得 `marked_failed` + `recoverable=true` → `retry()` 换新 runId、`attempts=2`

变体：`dry_run` 缺 runId、run 目录整个不见、半写的 done.json（不许被骗成完成）、
`run()` 超时后状态不丢（稍后能续上）。

### 层二 · e2e 里的真实 SIGKILL（`tests/unit/experiment_e2e.test.ts`）

这才是退出标准要的那条。`tests/helpers/experiment_driver.ts` 是一个**独立的 bun 进程**，
扮演编排进程：建实验 → 提交仿真 → 把 id 打到 stdout → 然后挂着等死。e2e 读到握手就下刀：

```
proc.kill("SIGKILL")   // 编排进程：SIGKILL 跑不了任何清理逻辑
await proc.exited      // 确认它真的没了
expect(isProcessAlive(handshake.simPid)).toBe(true)   // 仿真子进程被 init 收养，还活着
```

然后用**全新进程状态**（新 ProjectManager / 新 ExperimentLoop / 新平台实例，只共享磁盘）
`resume()` → `still_running`，且 `runStatus.pid` 与握手拿到的 pid 一致 → 续跑到 conclude。
断言 `runId` 与 `attempts` 都没变：接的是同一个 run。

第二例把编排进程与仿真进程**一起**杀（机器断电的形态）→ `marked_failed` + `recoverable`
→ `retry()` 起新 run → 另起一条不 stall 的实验把闭环走完，证明 failed 之后项目仍然可用；
失败的那条实验留在图里不删（ELN 语义）。

为什么坚持真杀而不是状态注入：恢复路径里有一段是 **pid 探活**。用假对象打桩会正好绕过它，
而那恰恰是最容易写错的一段（僵尸进程、PID 复用、孤儿进程被谁收养）。

### 层三 · e2e 的数据完整性断言

kill 之后续跑出来的东西必须**真的能用**：

- 2 个产出进 artifact store，`storagePath` 文件存在，`listBySession(experimentId)` 取得回
- `trajectory.csv` 表头正确、行数 = `steps/sampleInterval + 2`、首行 step=0
- observation `evidence=computed`，`maxAbsErrorVsAnalytic < 1e-6`
- 从 conclusion 出发 `graph(depth=3)` 的节点集合恰好是
  `[artifact, artifact, conclusion, experiment, observation]`，边全是 `derives_from`
- 实验正文里 kill 前后的状态轨迹是**连续的一条**（`design → dry_run` 与 `dry_run → collect` 都在）

## 五、测试结果

```
$ bun run typecheck
（无输出，clean）

$ bun test tests/unit/
 456 pass
 0 fail
 1997 expect() calls
Ran 456 tests across 28 files. [23.60s]

$ .venv/bin/python -m pytest tests/ -q
28 passed in 0.08s
```

- 基线 **366 个一个没动、全绿**；新增 **90** 个：

| 文件 | 数量 | 覆盖 |
|------|------|------|
| `tests/unit/simulation_contract.test.ts` | 26 | 13 用例 × 2 实现（上一节矩阵） |
| `tests/unit/experiment.test.ts` | 32 | 转移表穷举（7 合法 + 42 非法）、design 校验、行为层非法转移、全链路证据图、iterate/conclude、**断点恢复三情形 + 三变体**、状态只在 record 里 |
| `tests/unit/experiment_cli.test.ts` | 18 | `new/run/status/list/platforms` 全子命令、`--json`、`--resume`、`--conclude`、失败退出码、参数错误路径 |
| `tests/unit/experiment_e2e.test.ts` | 2 | 真实 SIGKILL 恢复（任务活着 / 任务一起没了） |
| `tests/unit/protein_e2e.test.ts` | 12 | 三段链路逐段、全链路 analyze + 证据图、报告渲染四种判读分支、负样本 |

Python 侧 `tests/sim/oscillator.test.py` 新增 **22** 个（三种阻尼区间与解析解对照、
无阻尼能量守恒、发散保护、非法参数、`RunContext` 的 done.json 原子写 / 异常转 failed /
忘记报告也转 failed、runner 端到端与失败信封）。

**连跑 3 次 `bun test tests/unit/` 全绿，无 flake**（456 / 456 / 456，23.6s / 24.1s / 23.5s）。

### 顺手修的一个静默故障

`pytest tests/` 之前**收集到 0 个用例**。本仓测试文件叫 `<模块>.test.py`，
不匹配 pytest 默认的 `test_*.py` / `*_test.py`——只有显式写文件名才跑得到。
也就是说 P0-P4 期间 Python 侧实际上没有测试门槛。`pyproject.toml` 补 `python_files` 后
28 个（6 个既有 lab + 22 个新增）全跑。另加 `package.json` 的 `test:py` 脚本。

### 真实网络录制（`FIXTURE_MODE=record`，2026-09-09 本机实跑）

`tests/integration/protein_record.test.ts` → `tests/fixtures/proteins/protein-analysis.json`（62 KB，无凭据）：

| 段 | 请求 | 结果 |
|----|------|------|
| ① UniProt | `hemoglobin subunit beta AND organism_id:9606 AND reviewed:true` | `P68871` / `HBB_HUMAN` / *Hemoglobin subunit beta* / 人 / 147 aa / Swiss-Prot |
| ② RCSB 搜索 | 按 accession，`rows=3` | `total_count=350`，返回 `1A00` / `1A01` / `1A0U` |
| ② RCSB 元数据 | 逐条 `core/entry/{id}` | 全部 X-RAY，2.0 / **1.8** / 2.14 Å |
| ③ AlphaFold | `prediction/P68871` | `AF-P68871-F1` v6，pLDDT **97.19**，97.3% 残基极高置信 |
| 负样本 | `prediction/ZZZ999` | HTTP 400 → `available:false` + note，链路不崩 |

关于负样本：本来想找一个「AlphaFold 未收录」的真实 accession，实测发现 **AlphaFold DB 对任何
格式合法的 accession 都返回 200**（`P00000` 也有模型，pLDDT 57.81）。所以「取不到模型」这条
路径只能用格式非法的标识符触发。这一条写进了场景 helper 的注释，免得后人重走一遍。

## 六、关键决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | 运行状态的真源是**磁盘**（run.json / done.json），内存句柄只作补充 | P5 退出标准就是「进程 kill 后能续跑」。只要 poll 依赖内存句柄，重启必然断链。内存句柄只用来补一件磁盘看不出的事：本进程 submit 的子进程已退出却没写 done.json（僵尸进程 pid 仍在） |
| D2 | 不复用 `compute/providers.ts` 的 `ComputeProvider`，另起 `SimulationPlatform` | 那套 `wait()` 是阻塞语义、状态全在内存 Map 里，跨进程接不上；而且它的三个 provider 目前全是模拟后端。硬套等于把新契约的核心性质（跨进程 poll）阉掉。`ComputeProvider` 原样保留，两者语义不同不该合并 |
| D3 | `iterate` / `conclude` 是**终态**，不是动作名 | DESIGN 写的是 `analyze → iterate \| conclude`。iterate 的实质是「这条实验结束，另起一条」——新实验必须是新 record（否则参数对照关系就没了），旧的进 `iterated` 终态，`supersedes` 边连起来 |
| D4 | `poll` **先看 done.json 再看 pid** | 任务写完结果才退出。反过来先看 pid 的话，PID 复用会把已死任务报成 running，僵尸进程也一样。现在的顺序让 PID 复用最坏只造成「多 running 一会儿」，不会把失败报成成功 |
| D5 | `failed` 带 `recoverable` 标志 | 「随进程一起被杀」与「算例本身跑挂」是两回事：前者重跑就好，后者要改参数。混着报等于让用户在错误方向排查 |
| D6 | 第二实现选 pyref（阻尼谐振子）而不是 GROMACS | 契约测试需要一个在**任何**环境都跑得通的实现，否则 CI 里 openmm 一缺就整套 skip，等于没有契约测试。而且它有解析解——能验「算对了没有」，不只是「跑完了没有」 |
| D7 | 失败样本用**真实失败模式**（RK4 发散 / PME 截断超半盒长），不加错误开关 | 人为的 `forceFailure: true` 只能证明「错误开关能用」。真实失败模式顺带验证了 runner 的异常转 failed 路径，也是用户真会撞的那两条 |
| D8 | 实验正文由**代码**渲染（同 P4 novelty 报告） | 状态、参数、摘要、状态轨迹都是确定的。让模型写正文等于把这些也交出去 |
| D9 | `iterate` 参数与上轮完全相同时**拒绝** | 那是重跑不是迭代。放行的话证据图里会出现两条一模一样、靠 `supersedes` 连着的实验，读图的人无从判断差异在哪 |
| D10 | 结论卡 `review` 一律 `pending` | 干实验不给自己发通过证。完整 review 门槛是域 E2/P8 |
| D11 | `stallSeconds` 参数明确标注「仅供生命周期测试」 | 需要一个能让任务可控地跑久的旋钮，才能在它「还在跑」的时候杀掉编排进程。与其偷偷加，不如在参数表和注释里写明用途 |

## 七、与设计的偏差

1. **状态集从 5 个扩到 7 个**：DESIGN B3 写的是 `design → dry_run → collect → analyze → iterate|conclude`。
   实现为 7 个状态（补 `failed` 与两个终态 `concluded`/`iterated`）。没有 `failed` 就无法表达
   「任务丢了、可重试」这个 P5 明确要求覆盖的情形。已同步进 DESIGN B3 落地口径。
2. **第二实现是 pyref 不是 GROMACS**：DESIGN 原文已留了「或退一档用 Python 内置仿真脚本」的口子，
   本阶段走了这条。理由见 D6，已把选择理由写进 DESIGN。
3. **两个 adapter 都走子进程，没有用 stateful Python kernel**：DESIGN B1 第一行写「执行引擎：
   现有 stateful Python kernel」。实际没用——MD 任务会把 kernel 长时间占死，更关键的是
   kernel 的生命周期绑在 daemon 进程上，「kill 后任务还在跑」做不到。kernel 仍是交互式分析的
   执行引擎，仿真走子进程。已同步进 DESIGN。
4. **`specHash` 的语义收窄**：它标识「同一份输入」，不保证「同一个结果」。OpenMM 的 CPU 平台
   多线程浮点归约让最小化结果不可逐位复现（见 §二实测）。pyref 侧则是逐位可复现的。
   已写进 DESIGN B1 落地口径。
5. **`compute/providers.ts` 未收编**：任务书说「评估复用或收编」。评估结论是不收编（D2），
   原模块一行没动，零影响。
6. **多加了一个 `exp platforms` 子命令**：任务书列的是 `new|run|status|list`。加 platforms 是因为
   OpenMM 可用性是环境相关的，用户第一件想知道的事就是「我这台机器能跑哪个」，
   没有这个命令只能靠 `exp new` 失败时的报错倒推。
7. **`PDBConnector` 加了 `searchByUniProt` 工具**（跨模块改动）：只增不改，现有调用方零影响。
   理由见 §一.6。
8. **顺手修了 pytest 的收集模式**（跨阶段改动）：见 §五。这是一个静默故障——不修的话本阶段
   新增的 22 个 Python 测试同样跑不到，等于白写。

## 八、给主会话的审查重点

1. **`poll` 依赖 pid 探活这件事本身（D1/D4）。** 这是整个恢复机制里唯一一处「不完全可靠」的判据：
   PID 复用理论上能让一个已死的任务被认成活着。我用「先看 done.json 再看 pid」把错误方向压到了
   安全的一侧（最坏是多 running 一会儿，不会把失败报成成功），但它仍然是个概率性判据。
   更硬的做法是在 run.json 里记进程启动时间（`ps -o lstart`）做二次校验，代价是引入平台相关的
   `ps` 调用与解析。**要不要现在就上，请定个口径。** 我倾向留 backlog——真正的兜底是 done.json，
   而且 P6 接 Opentrons 模拟器时会再撞一次同类问题，届时一起解更划算。

2. **`compute/providers.ts` 不收编（D2）是我做的一个范围判断。** 现在仓库里并存两套「提交任务
   然后等结果」的抽象：`ComputeProvider`（阻塞 wait、内存状态、三个 provider 全是模拟后端）
   与 `SimulationPlatform`（非阻塞、磁盘状态、两个真实实现）。我认为语义不同不该合并，
   但代价是概念冗余，而且 `ComputeProvider` 那套目前没有任何真实后端、也没有调用方在用。
   **备选是把 `compute/` 标记为 deprecated 或直接删掉**（它的三个 provider 只在
   `compute.test.ts` 里被测，没有生产调用点）。删不删涉及 v0.1 资产盘点表，我不擅自动。

3. **OpenMM 的不可复现性（§二末尾）对下游的影响没有被消化。** 目前只是「契约测试不断言精确数值」
   加一条 DESIGN 注释。但 P8 的报告导出、以及 Reviewer 的「数据-结论一致性」检查器（域 E1）
   都隐含假设「同样的实验能重放出同样的数字」。对 OpenMM 这不成立。
   要么给 adapter 加一个 `deterministic: boolean` 能力位让下游按需处理，要么在 observation
   metadata 里记录「本结果不可逐位复现」。**这条建议在 P8 之前定下来**，晚了就要改数据格式。

## 九、留给后续阶段的钩子

- `SubprocessSimulationPlatform` 是通用骨架：接第三个 adapter（LAMMPS/VASP）只需实现
  `normalize` / `entryPointFor` / `probeCode` 三个方法，加进 `registry.ts` 即可自动获得
  契约测试（把 case 加进 `simulation_contract.test.ts` 的矩阵）。
- `ExperimentLoop` 的状态机在 `dry_run` 与 `collect` 之间留着 P6 的插入点：
  DESIGN B3 完整形态是 `dry_run → (approve gate) → wet_run → collect`。
  加两个状态 + 三条转移即可，`resume()` 的三情形判据对 Opentrons 模拟器同样适用。
- `RunStore` / `isProcessAlive` 与仿真无耦合，P6 的湿实验执行如果也是子进程，可直接复用。
- `ProteinAnalysis.analyze()` 产出的 observation record 带 `pdbIds` 与 `bestResolutionAngstrom`，
  P8 报告导出可以直接读；它也是 `dry-experiment` 的天然前置（选哪个构象去跑 MD）。
- **backlog 建议**：
  1. pid 探活加进程启动时间二次校验（见审查重点 1）
  2. `compute/providers.ts` 的去留（见审查重点 2）
  3. adapter 的 `deterministic` 能力位（见审查重点 3）
  4. OpenMM 长时任务的进度上报：`progress.json` 机制已就位，但 500 步的算例看不出价值，
     要等真实的 100 ps 量级任务才有意义
  5. `energy.csv` 之外的产出格式（DCD 轨迹）——现在 `final_state.xml` 有 125 KB，
     真实长任务的轨迹文件会是几百 MB，artifact store 直接 copy 到 `artifacts/` 的策略要重新评估
