---
name: dry-experiment
description: "干实验（in silico）闭环：从一个假设出发设计仿真算例 → 提交到仿真平台 → 回收产出进 artifact → 产出 observation → 迭代或下结论。全程状态持久化，编排进程被杀也能续跑。用于「这个想法能不能先在计算机上验一遍」「跑一个 MD / ODE 算例并把结果留成证据」。"
category: experiment
domain: B
allowed-tools: [Bash, Read, Write]
---

# Dry experiment（干实验闭环）

## 何时用这个技能

- 用户有一个**可计算的**假设，想先在计算机上验一遍再谈湿实验
- 需要跑分子动力学 / 数值积分类算例，并把结果留成可审计的证据
- 已经跑过一轮，要改参数再跑一轮并保留两轮的对照关系

**不适用**：需要动物理设备的湿实验 → `wet-protocol`；只想查文献 → `literature-search`；
想知道某个蛋白有没有可用结构 → `protein-analysis`（那是本技能的**前置**）。

## 铁律（先读这段）

1. **先有假设，再有算例**。`--hypothesis` 不是可选的装饰：一个说不出「预期看到什么」的算例，
   跑出任何数字都能被解释成成功。设计阶段写不出来，就是还没想清楚。
2. **检索不到 ≠ 不存在，跑不出来 ≠ 不成立**。仿真失败先分清是「算例本身错了」还是
   「任务随进程一起没了」——状态机把这两件事分开了（`failed` + `recoverable`），别混着报。
3. **结果要能对照**。pyref 有解析解，OpenMM 有能量守恒/温度这类物理判据。
   「跑完没报错」不是结论；报告里必须有一个**可判定**的对照量。
4. **改参数 = 新实验**。不要在同一条 record 上反复重跑覆盖结果。
   `exp` 的 `iterate` 会新建一条 record 并用 `supersedes` 边连回旧的——两轮都留在证据图里。
5. **状态在磁盘上，不在你脑子里**。任何时候都可以 `exp status <id>` 问当前状态；
   进程死了就 `exp run <id> --resume`。不要凭记忆推断「刚才跑到哪了」。

## 用法

```bash
spark-research exp platforms                       # 先看哪个仿真平台可用
spark-research exp new "水盒子平衡" --platform openmm \
    --param steps=500 --param boxSizeNm=2.0 \
    --hypothesis "300K 下 1ps 平衡后势能稳定在 -1.4e4 kJ/mol 量级"
spark-research exp run <id> --note "首轮基线"       # dry_run → collect → analyze
spark-research exp run <id> --resume                # 进程被杀之后接上
spark-research exp status <id>                      # 看正文 + 当前 run 状态
spark-research exp list --state failed              # 挑出要重试的
```

退出码 1 = 仿真失败或参数非法。**不要**把它当成「跑完了」。

## 状态机

```
design ──► dry_run ──► collect ──► analyze ──► concluded
             │                                └► iterated ──► （新实验，supersedes 旧的）
             └► failed ──► dry_run（retry）
```

- 表外的转移**一律拒绝**，不做「顺手纠正」。状态机悄悄自愈等于没有状态机。
- `concluded` / `iterated` 是终态，之后什么都不能做。
- 每次转移都在 `metadata.history` 与 `metadata.timestamps` 留时间戳。

## 断点续跑：三种情形

`exp run <id> --resume` 会 poll 仿真任务，按结果分三条路走：

| 情形 | 判据 | 动作 |
|------|------|------|
| 任务仍在跑 | 无 `done.json`，pid 还活着 | 保持 `dry_run`，继续等 |
| 任务已完成 | 有 `done.json`（status=completed） | 直接进 `collect` |
| 任务已丢失 | 无 `done.json`，pid 已消失 | 标 `failed` 且 `recoverable=true`，可 `retry` |

判据的顺序是**先看结果文件再看 pid**：任务写完结果才退出，所以只要结果在，
无论进程是死是活都以结果为准（PID 复用最坏只会让一个已死的任务多「运行中」一会儿，
不会把失败报成成功）。

## 两个仿真平台

| 平台 | 任务种类 | 说明 | 依赖 |
|------|---------|------|------|
| `pyref` | `damped-oscillator` | 阻尼谐振子 RK4 积分，**有解析解可对照** | 无（纯标准库） |
| `openmm` | `water-box-md` | 显式溶剂水盒子，能量最小化 + 短时 NVT 平衡 | `uv pip install openmm` |

`pyref` 不是玩具占位：它是契约的第二实现，也是 CI 里永远跑得通的那一个。
需要「先把闭环走通再谈物理」的时候用它。

## 证据图

```
artifact record  --derives_from--> experiment      （每个产出文件一条）
observation      --derives_from--> experiment
observation      --derives_from--> artifact record （每个产出各一条）
conclusion       --derives_from--> observation / experiment
新 experiment    --supersedes-->   旧 experiment   （iterate）
```

- experiment record 的 `evidence` 是 `inferred`（设计是推出来的）
- observation 的 `evidence` 是 `computed`（结果是算出来的，不是看出来的）
- 结论卡一律 `review: "pending"` —— 干实验不给自己发通过证（review 门槛见域 E2）

## 反模式

- ❌ 不写假设就 `exp new`，跑完再回头解释数字
- ❌ 仿真失败了就改小 steps 直到「跑通」，然后当成结果
- ❌ 在同一条实验上反复重跑覆盖上一轮（要对照就 `iterate`）
- ❌ `iterate` 时传和上一轮完全相同的参数（工具会拒——那是重跑不是迭代）
- ❌ 进程被杀之后重新 `exp new` 建一条新实验，把跑了一半的那条丢掉不管
- ❌ 把 `analyze` 当成结论：observation 是「看到了什么」，conclusion 是「因此认为什么」
- ❌ 拿 `maxAbsErrorVsAnalytic` 之外的「感觉对」当数值正确性判据
- ❌ OpenMM 只跑几百步就宣称「已平衡」——1 ps 远不足以让水盒子达到目标温度

## 验证方式（AD-5）

- 契约测试：`tests/unit/simulation_contract.test.ts` —— **同一组 13 个用例参数化跑在
  `pyref` 与 `openmm` 两个实现上**（prepare 确定性 / submit 非阻塞 / 跨实例重连 /
  运行中拒绝 collect / cancel / 真实失败路径）
- 状态机单测：`tests/unit/experiment.test.ts` —— 合法转移全覆盖 + 非法转移逐条拒绝
  + 断点恢复三情形（任务仍在跑 / 已完成 / 已丢失）
- e2e：`tests/unit/experiment_e2e.test.ts` —— 另起一个 bun 进程当编排进程，
  提交仿真后**真实 SIGKILL** 掉它，重启后接回同一个 run 续跑到 conclude
- Python 侧：`tests/sim/oscillator.test.py` —— 与解析解对照、能量守恒、发散保护、
  `done.json` 原子写与失败信封
