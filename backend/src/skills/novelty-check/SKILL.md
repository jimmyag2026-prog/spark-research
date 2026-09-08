---
name: novelty-check
description: "创新性核验：从 Idea 卡抽出可检验的创新点 claim → 每条 claim 多路检索真实文献 → 逐条给出最接近的已有工作 + 相同点 + 不同点 + 评级（novel/incremental/existing）→ 引用核验 → 回写思路库状态。用于「这个想法有没有人做过 / 我们相对已有工作新在哪」。"
category: ideation
domain: D
allowed-tools: [Bash, Read, Write]
---

# Novelty check（创新性核验）

## 何时用这个技能

- 用户问「这个想法有没有人做过」「我们和已有工作差在哪」
- 立项前要判断一个方向值不值得投入
- 论文 related work 章节要先摸清最近邻

**不适用**：还没有成形的 idea → 先 `idea-coexplore` 出卡；只想找论文 → `literature-search`。

## 铁律（先读这段）

1. **检索不到 ≠ 新颖**。这是这条管线要防的头号失效模式。检索为空时结论是「没查出来」，
   不是「novel」——管线会把该 claim 标成结论不可用，并且**不推进** idea 的 novelty 状态。
2. **任何评级都要点名最近邻**。哪怕你认为它全新，也必须说清「最接近的是什么、差在哪」。
   「没有相关工作」不是结论，是没做功课。
3. **只能引用本次检索真的返回的工作**。不许引用你记得的经典论文——它没出现在这次检索里，
   就不是这次检索的证据。生成器会拒，`citation-integrity` 还会再验一遍。
4. **评级不是你说了算**。有一层确定性代码会拿检索结果的可计算特征校正你的评级（见下）。
   与其被校正，不如一开始就按证据说话。

## 用法

```bash
spark-research idea list                     # 找到 idea 的 record id
spark-research idea check <record-id>        # 跑核验
spark-research idea check <record-id> --sources openalex,crossref --per-source 5 --out novelty.md
```

退出码 1 = 报告有 hard finding（伪造引用），或本次未得出可用结论。两种都不该当成「通过」。

## 管线六步

| 步 | 做什么 | 谁说了算 |
|----|--------|---------|
| ① claim 提取 | idea 卡 → 1-5 条**可被一篇论文证伪**的陈述，每条配 2-3 个英文检索式 | 模型（过 schema 校验） |
| ② 密集检索 | 每条检索式走 P2 统一检索（多源并发 + 去重合并） | 真实 API |
| ③ 相似度 | claim/检索式 与 候选标题+摘要 的内容词覆盖率 | **确定性代码** |
| ④ 对比 | 逐 claim：最近邻 + 相同点 + 不同点 + 评级 | 模型（key 必须来自候选清单） |
| ⑤ 评级校验 | 用 ③ 的数字约束 ④ 的结论 | **确定性代码** |
| ⑥ 引用核验 | 报告里每个 `[@key]` 必须在「库内 ∪ 本次候选」中 | P3 `citation-integrity` |

## 评级校验层（这层是重点）

| 规则 | 触发条件 | 后果 |
|------|---------|------|
| `no_candidates` | 检索一条候选都没返回 | 结论不可用，状态不推进 |
| `rating_without_nearest` | 有候选却一条最近邻都不列 | 结论不可用 |
| `unknown_work` | 引用了候选清单之外的 key | 结论不可用 |
| `existing_without_high_affinity` | 评 `existing` 却没引到高相似候选 | **降级**为 `incremental` |
| `novel_despite_high_affinity` | 明明检索到高相似候选却评 `novel` | **升级**为 `existing` |

「高相似」= 候选的标题+摘要覆盖了 claim（或它某条检索式）**3/4 以上**的内容词。
这是词面覆盖率，不是语义相似度：它会把用词高度重合的邻近工作算得偏高，所以只拿它做
**约束**（不许在有高相似候选时说 novel），不拿它直接下结论。

报告里模型给的评级与校正后的评级**都会列出来**——谁改了谁看得见。

## 回写思路库

```
所有 claim 结论都可用 → 取最保守的一条：
  任一 existing      → checked-overlap
  否则任一 incremental → checked-incremental
  全部 novel          → checked-novel
任一 claim 结论不可用 → 维持 unchecked（但报告指针照样写回，「查过没查出来」≠「没查过」）
```

证据图：

```
novelty 报告 --derives_from--> idea
novelty 报告 --cites--> 命中库内论文的 paper record
```

## 反模式

- ❌ 检索空了就写「未见相关工作，属于原创」——这是本管线存在的理由
- ❌ 为了显得新颖，故意挑冷门检索式（检索式覆盖面 = 结论的边界，要在报告里说清）
- ❌ 三条检索式写成同一句话的三种说法（等于只检索了一次）
- ❌ 相同点写「都用了深度学习」这种不产生信息的话
- ❌ 引用一篇没检索到但你确信相关的论文来「补强」报告
- ❌ 只跑一次就当定论：库和检索式变了，结论就该重跑（状态字段会告诉你上次查于何时）
- ❌ 把 `checked-novel` 当成「可以去写论文了」——它只说明这几条检索式没查到

## 验证方式（AD-5）

- 单测：`tests/unit/novelty.test.ts`——相似度、claim/报告 schema、**评级校验层五条规则逐条**、
  管线（回写、cites 边、检索空、schema 失败不落库、dry-run）
- e2e 双向对照：`tests/unit/novelty_e2e.test.ts`（fixture 回放真实检索结果）
  - (a) 已发表工作的核心 idea（自注意力替代循环做序列转导）→ 评 `existing` 且最近邻命中
    *Attention Is All You Need* 原文
  - (b) 刻意杜撰的组合 idea → 评 `novel`，但必须给出最近邻；空手评 novel 会被判结论不可用
  - 反向：模型硬说 novel/existing 时，校验层按检索证据升/降级
- 真实网络录制：`tests/integration/novelty_record.test.ts`（`FIXTURE_MODE=record`）
