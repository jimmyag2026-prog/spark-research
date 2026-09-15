# lane γ · 文献质量与配置面

| 项 | 做什么 | DONE / 门禁 |
|---|---|---|
| γ-1 V173 凭据 ↔ 检索源关联 | 检索源面板每行显示：是否勾选、有无凭据、「本次会不会真查」三态；凭据写入成功后若该源不在 `searchSources`，响应带 `nextStep: "去检索源面板勾选 <id>"`；`lit sources` 同样显示三态 | 单测 + e2e（ε 配合渲染，你出 API 与字段） |
| γ-2 V161 + U58 中文查询处理 | `LiteratureSearcher` 前加一层 `prepareQuery`：含 CJK 时做主题词抽取 + 英译（一次 ≤200 token 的 LLM 调用，或词典兜底），中英双查后合并；OpenAlex 加 `language` 过滤开关（`searchLanguage` 配置项）；AMiner 零摘要结果标 `abstract: null` 且精读跳过 | 实测「重复性劳损 预防 办公人群」top-6 至少 4 条相关（现在 0/6）；T3 课题复跑 ≥ 2/8 |
| γ-3 V175 上游 200-带错形状 | 逐源核 openalex / crossref / europepmc / pubmed / arxiv / s2 / aminer 的错误响应形状，`connectors/base.ts` 的 `upstreamErrorOf` 改成按 connector 的显式表 | 每源一条门禁（真实错误响应片段做夹具） |
| γ-4 V172 后半盘点 | 产出 `docs/taskbooks/v0.10/SKILL_EXEC_INVENTORY.md`：13 个技能 × {执行入口（有/无程序化实现）、所需 grants、走乙直调还是甲子代理、预计工作量}；然后按表**再接 3 个**：`paper-download`（乙，`PdfDownloader`）、`research-report`（乙，报告导出）、`novelty-check`（乙，现有 novelty 管线） | 盘点表入库；3 个技能在 chat 的 `case "skill"` 真执行（`orchestrator.ts` 是收口专属——把分发表做成 `agents/skill_runners.ts` 的注册表，收口只需一行接线） |
