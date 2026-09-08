---
name: literature-search
description: "跨源文献检索：并发查询 OpenAlex / CrossRef / Europe PMC / Semantic Scholar（以及已配置凭据时的 AMiner），归一化为统一 Paper 模型，按 DOI 与标题模糊匹配去重合并，返回带来源标注的候选清单。用于背景调研、找相关工作、为综述或创新性核验准备候选池。"
category: literature
domain: A
allowed-tools: [Bash, Read, Write]
---

# 跨源文献检索

## 何时用这个技能

- 用户提出一个研究问题，需要摸清已有工作
- 需要为综述（literature-review）或创新性核验（novelty-check）准备候选论文池
- 需要交叉验证某篇论文的元数据（同一篇被多个源命中 = 元数据更可信）

**不适用**：用户已经给出确定的 DOI/arXiv id 只想入库 —— 那是 `library-curation` 的 `lit add`。

## 能力边界（先读这段，别做超出的承诺）

| 源 | 覆盖 | 是否需要凭据 | 已知限制 |
|----|------|------------|---------|
| OpenAlex | 全学科，含引文图（referenced_works） | 否 | 摘要是倒排索引，还原后偶有词序问题 |
| CrossRef | 所有注册 DOI 的正式发表物 | 否 | 不收预印本；摘要覆盖率低 |
| Europe PMC | 生命科学 + 部分预印本 | 否 | 非生物医学领域覆盖差 |
| Semantic Scholar | 全学科 + OA PDF 链接 | 否 | 无 key 时共享公共限流额度，高频会 429 |
| AMiner | 中文文献与中国学者覆盖强 | **是**（`aminer` / `api_key`） | 未配置时自动跳过，不报错 |

**凭据纪律（AD-2）**：凭据只在 daemon 进程内读取。你永远看不到、也不需要看到 key 本身。AMiner 未配置时统一检索会把它标成 `skipped`，其余源照常返回——**不要因此声称检索失败**。

## 工作流

### 1. 把研究问题拆成检索式

不要把用户的整句话直接扔进检索。先拆：
- 核心概念（2-4 个）→ 每个概念一次检索，而不是拼成长句
- 同义词/术语变体（如 "protein structure prediction" / "protein folding"）分别跑
- 需要限定年份或领域时，在结果侧过滤，而不是塞进 query 字符串

### 2. 执行检索

```bash
spark-research lit search "AlphaFold protein structure prediction" --limit 20
# 指定源（逗号分隔）
spark-research lit search "<query>" --sources openalex,crossref,europepmc,semanticscholar
# 检索并直接入库
spark-research lit search "<query>" --limit 20 --add --tag background
```

程序化调用（在 agent 的执行环境里）：

```ts
import { LiteratureSearcher } from "backend/src/literature/search";
const result = await new LiteratureSearcher().search(query, { perSource: 20, limit: 30 });
// result.papers      去重合并后的 Paper[]
// result.sources     每个源的 ok / failed / skipped + 计数 + 错误摘要
// result.mergedCount 合并掉了多少条
```

### 3. 读懂 `sources` 状态（这一步不能跳）

汇报检索结果前，先看每个源的 outcome：

- `ok` —— 正常返回
- `skipped` —— 未配置凭据，或该 id 形态该源不认。**不是失败**
- `failed` —— 真失败（HTTP 429/5xx、网络错误）。必须在给用户的回答里如实说明「某源本次未返回，结果可能不完整」

**禁止**：把 `failed` 的源静默吞掉后声称「已全面检索」。覆盖面不全就说不全。

### 4. 判读去重结果

- `sources` 字段有多个源 = 跨源交叉验证过，元数据可信度更高，排序上自动靠前
- 只有单源命中的条目，引用前最好用 `lit add <doi>` 再取一次确认
- `mergedCount` 异常高（> 输入的 50%）通常说明检索式太宽泛，收窄再来

### 5. 交付

给用户的候选清单必须包含：标题、第一作者、年份、venue、DOI、命中源。
**每条都要能回链到真实来源**——没有 DOI 也没有 URL 的条目不要放进清单。

## 反模式

- ❌ 凭记忆补全检索结果里缺失的字段（年份、venue）——缺就标「未知」
- ❌ 把某源的失败包装成「该领域没有相关工作」
- ❌ 一次检索几百条然后全量入库——先人审，`--add` 是有意的显式动作
- ❌ 对同一 query 反复重试失败的源（尤其 Semantic Scholar 429）——换源，别轰炸

## 验证方式（AD-5：技能必须有配套验证）

- 单测：`tests/unit/literature.test.ts` 的归一化与去重用例
- e2e 回放：`tests/unit/literature_e2e.test.ts`，全链路走 `tests/fixtures/literature/` 的录制响应
- 真实网络：本地 `FIXTURE_MODE=record bun test tests/integration/literature_record.test.ts`
