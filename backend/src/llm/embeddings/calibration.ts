// C4 · 语义相似度的**标定阈值登记表**（v0.5 §1.2.3 / §2.8）。
//
// ── 结论先行：这张表现在是空的，而且是**标定之后**决定让它空着的 ───────────────
//
// 本 lane 在 30 条 claim × 59 篇真实论文上把语义口径与现行词面口径**放在同一份样本、
// 同一个取法下**量过一遍。结果是：**语义并没有比词面更准**（详见下面的数字与
// `tests/unit/novelty_calibration.test.ts`）。既然没更准，就不能把它登记成评级判据——
// 那等于打着「升级」的旗号换上一个更差的判官。所以：
//
//   - 表空 ⇒ `semanticHighAffinity()` 恒返回 null ⇒ novelty **强制走词面**（K-4）；
//   - 语义相似度照算，进报告的「语义」参考列与 record metadata，但**不参与评级约束**；
//   - 确定性层（AD-8）一条规则没少，只是它比较的仍然是词面那个数。
//
// 这不是「没做完」，是标定的结论。要推翻它，去补样本、换模型、重跑标定测试，
// 而不是直接往下面这张表里塞一个数。
//
// ── 为什么不能沿用 HIGH_AFFINITY = 0.75 ─────────────────────────────────────
//
// 那个数是**词面内容词覆盖率**的门槛，语义余弦是完全不同的量纲。实测：bge-m3 上
// 最高的正样本才 0.746，一条都够不着 0.75——套过去的话确定性层的 R5
// （存在高相似候选却评 novel → 升级 existing）从此永不触发。
// 这就是「阈值不重标 ⇒ 要么全判 novel、要么全判 not novel」的具体形态。
//
// ── 标定方法（数据见 tests/fixtures/novelty/calibration.json） ────────────────
//
// 标定的是**管线真正使用的那个量**，不是一个更好看但没人用的统计量：
//   semanticAffinity(claim, paper)
//     = max over [claim.statement, ...claim.queries] of cosine(embed(text), embed(paperEmbedText(paper)))
// 与 `affinity.ts` 的 `claimAffinity()` 取 max 的理由同源（中文陈述对英文论文的余弦天然偏低，
// 取平均会把命中的英文检索式抹平），也与 `novelty.ts` 的 `applySemanticAffinity()` 逐字同构。
//
// 样本：17 条对真实论文的**改述** claim（正样本 = 原文，负样本 = 同领域邻近工作）
//     + 13 条**杜撰组合** claim（负样本 = 全语料 59 篇里最近的一篇）
//     ——含 P4 标定表原有的 2 条，原样保留作历史对照。
//
// ── 实测（bge-m3，2026-09-10，本机 Ollama 录制回放） ─────────────────────────
//
//                        语义（bge-m3）        词面（内容词覆盖率）
//   正样本区间            0.579 … 0.746        0.714 … 1.000
//   最高负样本            0.660                0.857
//   最优阈值区间/错分     [0.64, 0.66] → 3/47  [0.67, 0.71] → 1/47
//   生产阈值上的错分      —                    0.75 → 2/47（假阴 1 / 假阳 1）
//   零假阳性的最低阈值    0.665（此时假阴 4）  0.86（此时假阴 4）
//
// **两侧分布都是重叠的**——规划文档 §1.2.3 设想的「阈值落在最高负样本与最低正样本之间、
// 两侧余量各 ≥ 0.05」在这份样本上对两种口径**都无解**。P4 那次 0.75 是在 2 条样本上标的，
// 样本一多就露馅了：它自己的最优区间 [0.67, 0.71] 甚至不包含 0.75。
//
// 逐条比下来，语义在这份样本上**没有一个维度稳定胜出**：最优错分 3 vs 1，
// 生产阈值上 3 vs 2，零假阳性点上的假阴数打平（4 vs 4）。n=47 且词面分数高度量化，
// 这点差距本身也在噪声量级内——所以正确的结论不是「语义略差」，而是
// **「没有证据表明语义更好」**，那就不该换。
//
// 语义唯一确实修掉的一类错：词面把**用词高度重合的邻近工作**判成「就是这件事」
// （h01 的负样本词面 0.857 ≥ 0.75，假阳性；语义只给 0.615）——正是 `novelty.ts` 里
// 早就预警过的那个失效模式。但语义自己也有对称的一类错（见下面「语料分布的教训」）。
//
// ── 语料分布的教训（比阈值本身更值得记） ────────────────────────────────────
//
// 第一版标定语料只收了**有摘要**的 40 篇，把 19 篇没摘要的排除了。阈值因此标在
// 0.645，测试全绿。然后 e2e 当场打脸：真实管线检索回来的候选里**就是有没摘要的条目**，
// 它们的嵌入文本退化成只有标题——而裸标题是一句没有背景稀释的高密度主题陈述，
// 分数系统性偏高。一篇只有标题的 "Understanding Protein Dynamics Using Conformational
// Ensembles" 对杜撰 claim 打到 0.660，直接把 0.645 顶穿，杜撰组合被误升级成 existing。
//
// **用一个比生产更干净的语料标定出来的阈值，在生产上必然偏**——而且偏的方向不可预测。
// 修法是把语料改成与生产同分布（现在 59 篇里有 19 篇没摘要），不是去调阈值。
// 改完之后语义的最高负样本从 0.629 涨到 0.660，最优错分从 2 掉到 3——
// 也就是说，**第一版那个「语义更好」的结论完全是语料偏差造出来的**。

export interface SemanticThreshold {
  high: number;
  calibratedOn: string;
  sampleSize: number;
  source: string;
}

/**
 * **只登记「标定过、且确实比现行口径更可信」的模型。**
 *
 * 现在是空的，理由见文件顶部：bge-m3 标过了，没有证据表明它比词面更准，所以不登记。
 * 空表 ⇒ 所有模型 `semanticHighAffinity()` 返回 null ⇒ novelty 强制词面（K-4）。
 *
 * 要新增一条（缺一不可）：
 *   ① 用 `FIXTURE_MODE=record` 对着真实端点录 `tests/fixtures/embeddings/<cassette>.json`；
 *   ② 跑 `tests/unit/novelty_calibration.test.ts`——它会算出该模型的正/负样本分布，
 *      并要求候选阈值**零假阳性**且落在最优区间内不贴边；
 *   ③ 还要**赢过词面口径**（同一份样本、同一个取法）——赢不了就别登记；
 *   ④ 把阈值、标定日期、样本数填进这张表。样本数与 calibration.json 条数对不上会当场变红。
 */
export const SEMANTIC_THRESHOLDS: Readonly<Record<string, SemanticThreshold>> = {};

/**
 * 未登记 = null → novelty 强制词面。
 *
 * `thresholds` 是给测试用的注入位：生产路径永远用默认的 `SEMANTIC_THRESHOLDS`，
 * 而语义约束这条分支本身必须被完整测到（否则它就成了「配置一开就没人验证过」的死角）。
 */
export function semanticHighAffinity(
  modelId: string | null,
  thresholds: Readonly<Record<string, SemanticThreshold>> = SEMANTIC_THRESHOLDS,
): number | null {
  if (modelId === null) return null;
  return thresholds[modelId]?.high ?? null;
}

export function isCalibrated(
  modelId: string | null,
  thresholds: Readonly<Record<string, SemanticThreshold>> = SEMANTIC_THRESHOLDS,
): boolean {
  return semanticHighAffinity(modelId, thresholds) !== null;
}

/**
 * modelId → embedding fixture 的 cassette 名。
 * `local/bge-m3` 里的 `/` 不能进文件名，统一换成 `-`（同时把其它非法字符一并收敛）。
 */
export function embeddingCassette(modelId: string): string {
  return modelId.replace(/[^A-Za-z0-9._-]+/g, "-");
}
