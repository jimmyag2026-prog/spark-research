---
name: protein-analysis
description: "蛋白结构调研链路：UniProt 查询确定身份 → RCSB PDB 取实验结构元数据（方法/分辨率/发布年份）→ AlphaFold 取预测模型与 pLDDT 置信度 → 给出「拿哪个结构去做下游计算」的判断。用于「这个蛋白长什么样」「有没有可用的结构」「AlphaFold 模型信得过吗」。"
category: experiment
domain: B
triggers: [这个蛋白长什么样, 有没有可用的结构, AlphaFold 模型信得过吗, 查一下这个 UniProt]
connectors: [uniprot, pdb, alphafold]
validation: [tests/unit/protein_e2e.test.ts, tests/integration/protein_record.test.ts]
allowed-tools: [Bash, Read, Write]
---

# Protein analysis（蛋白结构调研）

## 何时用这个技能

- 用户问某个蛋白「有没有实验结构」「分辨率够不够」「AlphaFold 模型能不能用」
- 准备跑 MD / 对接 / 设计之前，要先确定用哪个构象作为起点
- 想快速拿到一个蛋白的身份卡（accession / 基因 / 物种 / 长度 / 功能注释）

**不适用**：要跑仿真 → `dry-experiment`（本技能是它的前置）；找论文 → `literature-search`。

## 铁律（先读这段）

1. **先确定身份，再谈结构**。自然语言蛋白名极易撞车（同名基因、跨物种同源）。
   链路第一步是把查询收敛到**唯一一个 UniProt accession**，后两步全部以它为准。
   拿不到唯一条目就停下问清楚，不要猜一个继续。
2. **pLDDT 不是分辨率**。它是模型对自己的置信度，不是与实验的一致性。
   `< 70` 的区域不该当结构用；`> 90` 也只说明局部折叠可信，不保证相对取向对。
3. **有好的实验结构就别用预测模型**。分辨率 ≤ 2.5 Å 的晶体结构在，AlphaFold 没有增量。
   反过来，实验结构分辨率差时，两者不一致的区域要**单独标出来**，不许挑一个顺眼的用。
4. **取不到东西是结论，不是故障**。「没有实验结构」和「AlphaFold 未收录」都是有信息量的答案，
   链路不会因为某一段拿不到就整体失败——但也不会把空结果粉饰成「结构可用」。

## 用法

链路是三个 connector 的组合（都不带凭据，全部公开 API）：

```
uniprot.search    → accession / entryName / 基因 / 物种 / 长度 / FUNCTION 注释
pdb.searchByUniProt → 该 accession 的实验结构清单（服务端按 rows 截断）
pdb.getStructure  → 逐条元数据：方法 / 分辨率 / 标题 / 发布日期
alphafold.getModel → 模型 URL（pdb/cif）、PAE 图、全局 pLDDT、残基置信分布
```

代码入口：`backend/src/proteins/analysis.ts` 的 `ProteinAnalysis.analyze(query)`。
`persist` 默认开：结果会落一条 `observation` record（`evidence=sourced`）。

## 为什么不走 UniProt 的 PDB 交叉引用

UniProt 条目里带 `xref_pdb`，一次就能拿到全部 PDB id——听起来更省事。但热门蛋白
（人血红蛋白 β 链有 **350** 条结构）会让响应体膨胀到几百 KB，既慢又会把 fixture 撑爆。
RCSB 搜索能用 `rows` 在**服务端**截断，`total_count` 仍如实返回。
所以：**总数照实报，明细只取前 N 条**。

## 结果怎么读

| 情形 | 报告给出的判断 |
|------|--------------|
| 有 ≤ 2.5 Å 实验结构 | 优先用该实验结构，点名 PDB id |
| 实验结构分辨率偏低 | 要求与高 pLDDT 模型交叉验证，不一致区域单独标注 |
| 无实验结构，pLDDT ≥ 90 | 预测模型可作为 MD 起始构象 |
| 无实验结构，pLDDT 低 | **明说这一步该停下**，不硬跑一个不可信的构象 |

最后一行是这条链路存在的意义：它要能说出「现在还不该往下走」。

## 反模式

- ❌ 拿蛋白俗名当查询，随手取搜索结果第一条就往下走（先加 `organism_id` 和 `reviewed:true`）
- ❌ 把 pLDDT 当成「分辨率 Å」来比较
- ❌ 报告里只列 AlphaFold 链接，不说实验结构有没有
- ❌ 实验结构和预测模型冲突时挑一个支持自己假设的
- ❌ 把 `total_count` 里的几百条当成「都可用」——绝大多数是同一蛋白的突变体/配体复合物
- ❌ AlphaFold 返回 400 就当成「这个蛋白很特别」（那多半是 accession 写错了）

## 验证方式（AD-5）

- e2e 回放：`tests/unit/protein_e2e.test.ts`（12 个用例，零网络）
  - ① UniProt：`hemoglobin subunit beta AND organism_id:9606 AND reviewed:true` → `P68871` / `HBB_HUMAN` / 147 aa
  - ② PDB：`total_count=350`，取前 3 条（`1A00` / `1A01` / `1A0U`），最佳分辨率 **1.8 Å**
  - ③ AlphaFold：`AF-P68871-F1`，pLDDT **97.19**
  - 报告结论段：1.8 Å 实验结构在 → 建议 `1A01`，不用预测模型
  - 负样本：`ZZZ999` → HTTP 400 → `available:false` + note，链路不崩
- 真实网络录制：`tests/integration/protein_record.test.ts`
  （`FIXTURE_MODE=record bun test tests/integration/protein_record.test.ts`），
  fixture 落 `tests/fixtures/proteins/protein-analysis.json`，**请求头永不落盘**
