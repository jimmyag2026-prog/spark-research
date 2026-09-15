# lane α · 速度工程

对应方案 §三 α。基线：`docs/devlog/W10-0-baseline.md`。目标：文献流程 quick 档 ≤ 90s、deep 档（8 篇）≤ 3 min；一句话 chat 输出 token 总量 −40%。

| 项 | 做什么 | DONE / 门禁 |
|---|---|---|
| α-1 S9 两档综述 + 批量预筛 | `literature_pipeline.ts` 加 `depth: "quick" \| "deep"`（默认 quick）。quick：全部候选摘要**一次**调用出综述（引用只许库内 key，走既有 `citationIntegrity`）；deep：现有逐篇卡路径。两档之前先一次便宜调用给候选打相关性分（0–3）并留 top-K（默认 8），无关的不进综述、不建卡 | 门禁：quick 档 LLM 调用数 ≤ 2；预筛用真实会话样本（`workspaces/web_1789480157513/t1-lit-review-rsi.json` 里那批含心血管指南的候选）验证无关项被剔除。阴性对照：预筛关掉 → 无关项进综述 → 红 |
| α-2 S3 精读并行 | `ReadingCardGenerator.generateMany` 加 `concurrency`（W10-0 实测 3 路 0 次 429 → 默认 **3**；写进 `config` 为 `readConcurrency`） | deep 档 8 篇 ≤ 150s；`usageTrackingLlm` 在飞预留下预算闸不被并发打穿（A7 口径：10 并发 × 小预算，实际花费 ≤ 上限 ×1.2） |
| α-3 S2 各阶段 maxTokens | plan ≤ 600（**紧凑 JSON**；解析失败重试一次更小提示，**不退默认计划**，那是 U29 的教训）、analysis ≤ 900、summarize ≤ 1200、卡 ≤ 700、综述 ≤ 2500。plan/summarize 在 orchestrator（收口专属）→ 写成收口 diff；卡/综述在 reading/review（自己改） | 基线对比输出 token −40%；plan 截断重试路径有门禁 |
| α-4 S10 全文命中率 | `pdf.ts`：响应是 HTML 时找 `citation_pdf_url` / `<link rel="alternate" type="application/pdf">` 再取一跳；`pdfUrl` 全部失败后按 DOI 查 Unpaywall（`https://api.unpaywall.org/v2/<doi>?email=<contactEmail>`，免 key）；OpenAlex OA 标记在结果里标 `oaSource: "openalex(optimistic)"` | 同一批 8 篇（`t1-lit-review-rsi.json` 的 downloads）≥ 5 篇；技能文档 `paper-download/SKILL.md`「目前不做的两跳」段删掉并改写 |
| α-5 按 host 令牌桶 | `http/ratelimit.ts` 给 `export.arxiv.org` / `arxiv.org` 一桶：≥3s 间隔；收到 429 且带 `Retry-After` 时按它等（上限 60s）；PDF 直链与检索共用 | **W10-0 实测本机 IP 仍被 arXiv 封（1 req/3s ×10 → 0 次 200）**，DONE 改为「不浪费一次请求」：冷却期内 0 请求、`Retry-After` 被尊重（单测用假 429+Retry-After 头）、PDF 与检索共桶；能否 200 不算判据 |

提示：quick 档的综述提示词可复用 `review.ts` 的 `buildReviewPrompt`，把「卡」换成「摘要条目」。不要新起一套引用语法。
