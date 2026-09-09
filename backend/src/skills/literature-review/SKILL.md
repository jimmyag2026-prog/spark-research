---
name: literature-review
description: "综述全链路：检索 → 入库 → 逐篇精读卡 → 综述草稿 → 引用真伪核验。每条引用都必须能回链到项目文献库内的真实论文；伪造引用与库外引用会被 citation-integrity 检查器 veto。用于写文献综述、相关工作章节、背景调研报告。"
category: literature
domain: A
triggers: [写一篇综述, 相关工作章节, 把这些论文串成一段叙述, 帮我核对引用是不是真的]
connectors: [openalex, crossref, europepmc, semanticscholar]
validation: [tests/unit/reading.test.ts, tests/unit/review.test.ts, tests/unit/review_e2e.test.ts, tests/unit/citation_integrity.test.ts, tests/unit/citation_adversarial.test.ts]
allowed-tools: [Bash, Read, Write]
---

# 文献综述与引用核验

## 何时用这个技能

- 用户要一份某个方向的文献综述 / 相关工作章节 / 背景调研报告
- 用户已经有一批文献想让你「读完并组织起来」
- 需要对一份已有草稿做引用核验（草稿是谁写的都行——你写的、用户写的、别的 agent 写的）

**不适用**：只是找几篇论文 → `literature-search`；只是把某篇 PDF 拿下来 → `paper-download`；
判断一个 idea 新不新 → `novelty-check`（P4，复用本技能的核验器）。

## 铁律（先读这段）

1. **引用只能指向项目文献库里的论文**。库里没有的文献，无论你多确定它存在、多适合放在这里，都不能引。
   要引它 → 先 `lit search` / `lit add` 入库 → 再重新生成。
2. **不要凭记忆写文献的结论**。综述里对某篇文献的每一句陈述，都必须能在它的精读卡里找到依据。
3. **hard finding 出现即停**。`citation-integrity` 报 hard 说明草稿里有读者无法核对的引用，
   这时候不要「改改措辞再交」——把假引用删掉或把文献真正入库，然后重跑。
4. **soft finding 不要无视**。soft 是「可能有问题」，需要你逐条看过并说明处理方式，
   而不是因为不否决就当没看见。

## 全链路

### 1. 检索与入库（用 literature-search / library-curation）

```bash
spark-research lit search "<研究问题的核心概念>" --limit 20 --add --tag background
spark-research lit list                      # 确认入库结果与 id
```

综述的覆盖面 = 库的覆盖面。库里只有 3 篇就别写「本领域的全面综述」，
说清楚「基于项目库内 N 篇文献」——这是诚实，不是免责声明。

### 2. 逐篇精读卡

```bash
spark-research lit read <paper-id>           # 单篇
spark-research lit read --all --tag background   # 批量（按标签）
```

每张卡片是结构化的五段：研究问题 / 方法 / 核心结论 / 局限 / 与本项目的关系，
落成一条 `observation` record（`evidence=sourced`），并用 `cites` 边连到该论文的 `paper` record。

**卡片是后续所有环节的对照基准**：综述里说这篇文献「说了什么」，核验器就拿卡片来对。
所以卡片本身不能糊弄——摘要没提到的数字、baseline 名称一律写「摘要未提及」，
生成器对不合 schema 的模型输出会重试一次，仍不合格就报错而不是产出半成品。

程序化调用：

```ts
import { ReadingCardGenerator, listReadingCards } from "backend/src/literature/reading";
const gen = new ReadingCardGenerator({ llm, library, records, projectContext });
const { cards, failures } = await gen.generateMany(paperIds);   // 逐篇独立结算
```

`failures` 必须如实汇报给用户，不能被「成功 N 张」盖过去。

### 3. 综述草稿

```bash
spark-research lit review --topic "<综述主题>" --out review.md
```

- 引用写作 `[@bibtexKey]`，key 来自库内论文（与 `lit export --format bibtex` 的 key 完全一致，读者可直接对照 .bib）
- 草稿落成 artifact + `artifact` record（`evidence=inferred`），
  并连 `derives_from` 边到每张精读卡、`cites` 边到每篇被引论文——证据链从综述一路回溯到原文
- 生成器自带白名单校验：出现库外 key 会带着越界清单重试一次，仍越界就**报错且不落 artifact**

### 4. 引用核验（citation-integrity）

`lit review` 会自动跑；也可以对任何草稿单独跑：

```ts
import { citationIntegrity } from "backend/src/reviewer/rules";
const result = await citationIntegrity({ draft, knownKeys, baselines, judge });
```

三类检查与分级：

| 情况 | 严重度 | 含义与处理 |
|------|--------|-----------|
| key 不在库内（编造的 key、或库外真文献） | **hard → veto** | 读者无法核对。入库或删引用，不要改措辞绕过 |
| key 在库但陈述与精读卡冲突 | soft（inferred） | LLM 辅助判定，可能误报；逐条看，确认后改写或保留并说明 |
| 强断言句无引用支撑（证明/首次/显著优于…） | soft | 要么补引用，要么把话说软 |

**判定器失效会产生一条显式的 soft finding**（`citation_judge_unavailable`）：
没跑成的检查会明说没跑，不会伪装成「全部通过」。看到它就知道第二类检查这次是缺失的。

## 反模式

- ❌ 把「我知道这篇论文存在」当成可以引用的理由——库内没有就是不能引
- ❌ hard finding 出现后换个 key 硬凑一个库内文献来「消掉」告警（这是把伪造引用变成错误引用，更糟）
- ❌ 用综述草稿的措辞去迁就检查器，而不是修事实
- ❌ 对没有精读卡的论文直接写进综述（没有对照基准 = 第二类检查对它完全失效，核验形同虚设）
- ❌ 因为 soft 不否决就跳过不看
- ❌ 声称「已全面综述该领域」——你综述的是**项目文献库**，说清库的边界

## 验证方式（AD-5）

- 单测：`tests/unit/reading.test.ts`（精读卡 schema 与重试）、`tests/unit/review.test.ts`（草稿生成与 CLI）、
  `tests/unit/citation_integrity.test.ts`（检查器与 Reviewer 接入）
- 对抗测试：`tests/unit/citation_adversarial.test.ts`——3 种伪造模式 × 3 变体检出率 100% + 4 条阴性对照
- e2e 回放：`tests/unit/review_e2e.test.ts`——P2 fixture 的 10 篇文献走完整链路，再注入伪造引用验证 veto
