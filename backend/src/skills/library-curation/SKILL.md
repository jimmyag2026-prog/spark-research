---
name: library-curation
description: "维护项目文献库（library.db）：按标识符或检索结果入库并自动去重合并，打标签、维护阅读状态与笔记，抓取库内互引边（OpenAlex referenced_works），导出 BibTeX / CSL-JSON。每篇入库论文自动在证据图中创建 type=paper 的 record 锚点。"
category: literature
domain: A
triggers: [把这篇加进文献库, 整理文献库, 导出 BibTeX, 标记已读, 给这批论文打标签]
connectors: [openalex, crossref, europepmc, semanticscholar]
validation: [tests/unit/literature.test.ts, tests/unit/literature_e2e.test.ts]
allowed-tools: [Bash, Read, Write]
---

# 项目文献库维护

## 心智模型

文献库是**项目级**的（`~/.spark-research/projects/<slug>/library.db`），不是会话级的。
一个课题横跨数月，文献库跨会话积累——这是 Spark Research 相对 session-centric 工具的核心差异（DESIGN §3.1）。

每篇入库论文有两个身份：
1. `library.db` 里的 `papers` 行：完整元数据 + 标签 + 阅读状态 + 笔记 + PDF 路径
2. `records.db` 里的一条 `type: paper` record：证据图上的锚点，`evidence: sourced`

**入库时自动建立两者关联**（`papers.record_id`）。后续综述的每条引用、结论卡的每条证据，都必须能回链到这个 record——这就是 P3 引用核验的地基。

## 入库

```bash
# 按标识符（DOI / arXiv id / PMID），跨源取元数据后合并入库
spark-research lit add 10.1038/s41586-021-03819-2 --tag alphafold,methods

# 检索后批量入库
spark-research lit search "protein structure prediction" --limit 20 --add --tag background
```

### 去重语义（入库前必读）

| 情况 | 行为 |
|------|------|
| DOI 与库内某篇相同 | **合并**字段，不新建行 |
| 两篇都有 DOI 且不同 | 一定是两篇，即使标题一模一样也**不合并** |
| 无 DOI，归一化标题相同 | 合并 |
| 无 DOI，标题 Jaccard 相似度 ≥ 0.9 且年份/第一作者不冲突 | 合并 |

字段冲突时按源可信度取值：CrossRef > OpenAlex > Europe PMC > Semantic Scholar > AMiner。
摘要取更长的一方；OA PDF 直链谁有算谁的（OA 链接稀缺，不按优先级挑）。

**合并是幂等的**：同一篇反复入库只会更新字段，不会产生重复行。放心重跑。

## 组织

```bash
spark-research lit list                       # 全部
spark-research lit list --tag methods         # 按标签
spark-research lit list --status unread       # 按阅读状态
spark-research lit list --q folding           # 标题/摘要子串
spark-research lit list --json                # 结构化输出，给程序消费
```

阅读状态：`unread` → `skimmed` / `reading` → `read`。
标签建议按**在本课题中的角色**打，而不是按学科：`background` / `methods` / `baseline` / `contradicts-h1`。
学科分类各大数据库已经做了，重复劳动没有价值；「这篇在我的课题里扮演什么角色」才是文献库的增量。

## 引文边

库内互引边来自 OpenAlex 的 `referenced_works`，入库时随元数据一起存进 `references_raw`。

```ts
library.rebuildCitations();   // 重算全库互引边；每次批量入库后跑一次
```

重要性质：**边只在库内两端都存在时才建立**。新入库一篇论文可能让之前存下的引用关系突然可解析，所以 `rebuildCitations()` 要在入库后跑，而不是只在初始化时跑。CLI 的 `lit add` / `lit search --add` 已经自动调用。

两端 record 都存在时，会同步在证据图上补一条 `cites` 边——文献的引用结构因此进入同一张证据图。

## 导出

```bash
spark-research lit export --format bibtex --out refs.bib
spark-research lit export --format csl --out refs.json
spark-research lit export --format bibtex --tag methods    # 按标签子集导出
```

**BibTeX key 规则**：`第一作者姓 + 年份 + 标题首词`（全小写去非字母数字），如 `jumper2021highly`。
冲突时追加后缀：第一条无后缀，之后依次 `a` / `b` / `c`…
标题首词跳过冠词与介词（a/an/the/on/of/in/for/and）和纯数字。

key 规则是**确定性**的：同一个库导出两次得到同样的 key。引用可以放心写进论文草稿。

## 反模式

- ❌ 手工往 `library.db` 里 INSERT——绕过去重与 record 联动，证据图会断链
- ❌ 检索到的东西无差别全量 `--add`——文献库是精选集，不是检索日志
- ❌ 把笔记写在外部文件里——笔记进 `notes` 字段，才能跟着 record 进证据图和最终报告
- ❌ 靠记忆填 BibTeX 条目——只从库导出，导出不出来说明没入库，那就先入库

## 验证方式

- 单测：`tests/unit/literature.test.ts` 的 CRUD、去重、引文边、record 联动、BibTeX/CSL 格式用例
- e2e 回放：`tests/unit/literature_e2e.test.ts` 跑 检索 → 去重 → 入库 → 引文边 → 导出 全链路
