---
name: paper-download
description: "下载库内论文的开放获取（OA）PDF：解析 arXiv /pdf/ 直链、Europe PMC fullTextPdf、OpenAlex best_oa_location 三类候选，落盘到项目 papers/ 目录并记录 sha256 checksum。拿不到时明确标注不可得原因（403 / 无 OA / 非 PDF）并写回库，不重试轰炸。"
category: literature
domain: A
triggers: [下载这篇论文, 把 PDF 拿到本地, 库里哪些论文有全文, 补全文献库的 PDF]
connectors: [openalex, europepmc, arxiv]
validation: [tests/unit/literature.test.ts, tests/unit/literature_e2e.test.ts]
allowed-tools: [Bash, Read]
---

# OA 论文 PDF 下载

## 何时用这个技能

- 论文已经在项目文献库里（先跑 `library-curation`），需要全文做精读卡或方法复现
- 需要给用户一份可离线阅读的本地文献集

**前置**：论文必须已入库。下载管线以库内 `paper-id` 为输入，落盘后把 `pdf_path` / `checksum` 写回同一条记录。

## 核心纪律：拿不到就说拿不到

这条比「下到」更重要。

- **每个候选直链只试一次**。403/404 记原因、换下一个候选，全部失败即收手。**不做退避重试**——OA 服务器是公共资源，轰炸它会让整个项目被封 IP。
- **只下 OA 直链**。不绕付费墙、不伪造 referer、不走镜像站。
- 失败原因写回库内 `pdf_status = unavailable` + `pdf_reason`，**下次不再重试**。要重试必须是用户显式要求。
- bioRxiv / 出版商站点返回 403 是**预期行为**，不是 bug。如实报告「该源拒绝程序化下载，需人工获取」。

## 候选直链的推导顺序

| 顺序 | 来源 | 推导方式 | 成功率 |
|-----|------|---------|-------|
| 1 | arXiv | 由 `ids.arxiv` 拼 `https://arxiv.org/pdf/<id>` | 高 |
| 2 | Europe PMC | 由 `ids.pmcid` 拼 `.../europepmc/webservices/rest/<PMCID>/fullTextPdf` | 高（限 OA 子集） |
| 3 | 归一化直链 | OpenAlex `best_oa_location.pdf_url` / S2 `openAccessPdf.url` / EuropePMC `fullTextUrlList` | 中 |

前两条是**由标识符推导**的，不依赖源 API 返回的链接字段，所以最稳。

## 用法

```bash
# 单篇（paper-id 支持前 8 位前缀，就是 lit list 里显示的那个）
spark-research lit pdf 3f2a91b4

# 先看哪些还没下
spark-research lit list --json | jq '.[] | select(.pdfStatus == "absent") | {id, title}'
```

程序化：

```ts
import { PdfDownloader } from "backend/src/literature/pdf";
const downloader = new PdfDownloader({ papersDir: project.paths.papersDir, library });
const result = await downloader.downloadMany(ids);   // 串行，不并发打同一服务器
```

## 读懂返回结果

```
{ ok: true,  path, checksum: "sha256:…", bytes, url, origin, attempts }
{ ok: false, reason, message, attempts }
```

`reason` 的取值与该说的话：

| reason | 含义 | 对用户怎么说 |
|--------|------|------------|
| `no_oa_link` | 三类候选一条都推不出来 | 「这篇没有可用的开放获取版本」 |
| `http_403` | 服务器拒绝程序化下载 | 「该出版商拒绝自动下载，需你手动获取」 |
| `http_404` | 直链失效 | 「OA 链接已失效，元数据可能过期」 |
| `not_a_pdf` | 返回的是落地页/登录页 | 「拿到的是网页而非 PDF，多半需要订阅」 |
| `network_error` | 网络层失败 | 「网络请求失败，可稍后重试」——这是**唯一**可以建议重试的 |

`attempts` 里逐条记了试过哪些 URL、各自什么状态。排障时先看它。

## 校验

下载成功后 checksum 是 `sha256:<hex>`，记录在库内 `checksum` 字段。
它的用途：(1) 精读卡引用某个 PDF 时锚定具体文件版本；(2) 检测文件被替换/损坏。
**不要**把 checksum 当作论文身份标识——同一篇论文不同来源的 PDF checksum 不同。

## 反模式

- ❌ 循环重试同一个 403 直到「成功」
- ❌ 下载失败后凭摘要编造全文内容——没有全文就只用摘要，并标注证据类型为 `sourced`（摘要级）
- ❌ 把 PDF 提交进 git（`papers/` 已在 .gitignore 里）
- ❌ 并发下载几十篇——串行，慢一点没关系

## 验证方式

- 单测：`tests/unit/literature.test.ts` 的候选推导与失败降级用例（403 / 非 PDF / 无链接）
- 真实网络：本地 record 模式实下 arXiv 与 Europe PMC 各一篇，fixture 只留截断样本（PDF 本体不入库）
