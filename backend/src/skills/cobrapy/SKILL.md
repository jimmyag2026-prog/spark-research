---
name: cobrapy
description: "基因组尺度代谢模型的通量平衡分析：以 dry-experiment 的仿真平台形态接入 cobrapy（FBA / pFBA / FVA，支持基因敲除与有氧-厌氧切换）。给定 SBML/JSON 模型，输出最大生长率与全反应通量分布，走 exp 状态机。用于「敲掉这个基因还能不能长」「厌氧条件下代谢会怎么变」。"
category: experiment
domain: B
triggers: [敲掉这个基因还能不能长, 跑一下 FBA, 厌氧条件下代谢会怎么变, 代谢通量分析]
connectors: []
platforms: [cobrapy]
validation: [tests/unit/cobrapy_contract.test.ts, tests/unit/cobrapy_e2e.test.ts, tests/sim/cobrapy_runner.test.py]
allowed-tools: [Bash, Read, Write]
---

# cobrapy（代谢通量平衡分析）

## 何时用这个技能

- 有一个基因组尺度代谢模型（SBML / JSON），想算在给定培养基下的最大生长率
- 想知道敲掉某个基因之后菌还能不能长、长多慢（单基因/多基因敲除）
- 想比较有氧与厌氧条件下的通量重分布
- 想知道某条反应的通量在最优解附近能有多大活动范围（FVA）

**不适用**：动力学模型（需要酶动力学参数与时间演化）→ 本平台是稳态假设，给不了时间曲线；
表达差异 → `pydeseq2`；单细胞 → `scanpy`。

## 铁律（先读这段——本技能是 `dry-experiment` 的一个仿真平台形态）

1. **入口是 `spark-research exp new --platform cobrapy`。** 理由同 `scanpy` / `pydeseq2`。
2. **FBA 是稳态最优化，不是模拟。** 它回答的是「在这些约束下**能**长多快」，
   不是「实际上长多快」。报告里把它写成预测上界，不要写成实验值。
3. **最优解常常不唯一（alternate optima）。** 目标值唯一，通量向量往往不唯一。
   本平台默认再跑一次 **pFBA**（在保住最优目标值的前提下最小化总通量）把解收敛到
   「最省酶」的那一个；**要对某条具体反应的通量下结论，请开 `fluxVariability` 看区间**，
   别拿单点通量当定论。
4. **培养基是假设的一部分。** `medium=anaerobic` 改的是 `EX_o2_e` 的下界；
   模型自带的交换反应边界决定了碳源与摄取速率上限。同一个模型换培养基能差好几倍生长率——
   summary 里的 `medium` 必须进报告。
5. **敲除的 id 写错必须报错，不许静默跳过。** 静默忽略一个敲不掉的基因，
   等于报告一个「敲除后照常生长」的假结论。runner 会当场失败并把 id 打出来。
6. **`deterministic: true` 是被测出来的**（LP 求解在同一模型/求解器/边界下走到同一个顶点，
   加上 pFBA 收敛）。`tests/unit/cobrapy_e2e.test.ts` 每次跑两遍比字节。
   **换求解器或换 cobra 版本，这个声称就要重测**。

## 用法

```bash
spark-research exp platforms
spark-research exp new "eno 敲除对生长的影响" --platform cobrapy \
    --param modelPath=/abs/path/e_coli_core.xml \
    --param knockouts=b2779 \
    --hypothesis "敲掉烯醇化酶后有氧生长率归零（糖酵解断了）"
spark-research exp run <id>
spark-research exp iterate <id> --param medium=anaerobic     # 换培养基对照
```

## 任务种类 `fba`

| 参数 | 默认 | 说明 |
|------|------|------|
| `modelPath` | 必填 | `.xml` / `.xml.gz` / `.sbml` / `.json` / `.yml` 代谢模型 |
| `objective` | 空 = 模型自带目标（一般是生物量反应） | 覆盖目标函数的反应 id；写错会失败（prepare 不读模型，只能给警告） |
| `medium` | `model-default` | 还可选 `aerobic` / `anaerobic`；后两者改 `EX_o2_e` 的下界 |
| `knockouts` | 空 | 逗号分隔的基因 id；会去重 + 排序（`a,b` 与 `b,a,a` 是同一个算例） |
| `parsimonious` | true | 目标值 > 0 时再跑一次 pFBA，把 alternate optima 收敛到最小总通量解 |
| `fluxVariability` / `fvaFraction` | false / 0.9 | 开 FVA 时 `fluxes.csv` 多两列区间上下界 |

产出：`fluxes.csv`（反应 → 通量 + 边界[+ FVA 区间]）· `solution.json`（目标值 / 状态 /
培养基 / 敲除 / 总通量 / 活跃反应数）。

**本平台目前的边界**：单目标 FBA/pFBA/FVA。**没有** OptKnock 类菌株设计、
没有动力学/时序模拟、没有通量采样（flux sampling）、不做多组学数据整合。

## 证据图

```
artifact record（fluxes.csv / solution.json）  --derives_from--> experiment
observation（目标值、状态、培养基、敲除清单）    --derives_from--> experiment 与 artifact
conclusion                                      --derives_from--> observation
```

- experiment 的 `evidence` 是 `inferred`，observation 是 `computed`
- 结论卡一律 `review: "pending"`

## 反模式

- ❌ 把 FBA 的最大生长率当成实测生长率写进结论
- ❌ 拿单点通量对某条反应下定论，不看 FVA 区间
- ❌ 不说培养基就报生长率（有氧/厌氧差 4 倍以上）
- ❌ 敲除一堆基因发现「生长没变」，却没核实那些 id 真的在模型里
- ❌ LP 状态不是 `optimal` 时还去解读通量表（本平台会直接失败，别绕过它）
- ❌ 换了求解器还沿用旧的 `deterministic` 声称

## 验证方式（AD-5）

- 契约测试：`tests/unit/cobrapy_contract.test.ts` —— 复用
  `tests/helpers/simulation_contract.ts` 的参数化契约用例，外加「探测与真跑同一条路径」、
  「依赖缺失报安装命令」、以及「探测必须查出 LP 求解器」（`import cobra` 成功 ≠ 能解 LP）
- e2e：`tests/unit/cobrapy_e2e.test.ts` —— 用 e_coli_core 教科书模型断言四个**公开定值**：
  有氧 0.873922 h⁻¹、厌氧 0.211663 h⁻¹、敲掉 eno（b2779）生长归零、
  敲掉 nuoA（b2280）掉到厌氧那个值（呼吸链没了只能发酵——两条独立路径给出同一个数），
  以及 deterministic 位与两次跑出来的字节一致性相符
- Python 侧：`tests/sim/cobrapy_runner.test.py` —— 模型加载、培养基切换真的改到了边界、
  未知目标/未知敲除基因的失败信封
