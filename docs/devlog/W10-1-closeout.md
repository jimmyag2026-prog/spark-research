# W10-1 收口 · v0.10.0-alpha.1（2026-09-16）

主会话把五条 lane（α 速度 / β 流式 / γ 文献质量与配置面 / δ 运维 / ε 前端）合到 `integration/v0.10-w1`（从 main@41aa262 起，先 cherry-pick W10-0 三个提交，再逐 lane `git rebase --onto`）。本文只记**收口层**做的事与裁定；各 lane 的门禁与阴性对照原文在各自 `W10-<lane>.md`。

## 一、每条 lane 都独立复跑过（不信自报数字）

| lane | 分支@SHA（rebase 前） | 我的复跑 | 我的阴性对照 |
|---|---|---|---|
| β | `feat/W10-beta`@1e80b49 | 20 绿 | （收口门禁里做，见 §三） |
| γ | `feat/W10-gamma`@9fb808f | 53 绿 | skill_runners 表里改名 paper-download → 3 红 |
| α | `feat/W10-alpha`@cc04236 | 30 绿 | `openai_compat.ts` 不发 `max_tokens` → 1 红 |
| δ | `feat/W10-delta`@f51919d | 31 绿 | `chatSyncMaxMs` 读者断开 → 1 红 |
| ε | `feat/W10-epsilon`@01f82ab | e2e 10 绿 | `streamChat` 不传 signal → 1 红 |

## 二、合并冲突与裁定

1. **`literature_pipeline.ts`（β × γ × α 三方）**：γ 的「零摘要且无 PDF 不精读」`readable` 过滤 + β 的 `generateMany({ onProgress → partial card, onDelta })` + α 的 `concurrency` 合成一处；`reading.ts` / `review.ts` 的调用点统一成 options 形式（`onDelta` 只在要流式时给；首次尝试带 `STAGE_MAX_TOKENS`，重试不带）。
2. **α 把 pipeline 默认 `depth` 改成 quick**：β/γ 的门禁假定 deep 路径 → 在它们的 review 调用里显式 `depth:"deep"`（与 α 改 v172 测试同一手法，不是放宽判据）。**chat 的 literature-review 默认 quick 档**（一次调用出综述，不建卡）；deep 由 params.depth 指定——这是速度与产物深度的取舍，写进 CHANGELOG。
3. **α 的夹具论文 `abstract:null` 撞上 γ-2 规则** → 夹具给占位摘要。γ 的规则是产品裁定（U58 ③），不为测试让路。
4. **γ 的中文处理层（英译双查 + 相关性地板）改为「给了 `translate` 才启用」**：裸 `new LiteratureSearcher(registry)` 保持 v0.6 单查行为——否则 V65 拆词/分词五条老门禁（钉调用次数）全红。生产入口（pipeline / CLI）都给 translate，行为不变。
5. **`searchLanguage` 读者证据**补进 `config_reader_parity`（γ 漏登，全量 unit 才抓到）。
6. **α-3 根治落在 router**：`providers/registry.ts` 新增 `REASONING_MODELS`（kimi-k2.6 / kimi-k3 / deepseek-reasoner / deepseek-v4-pro，按去前缀模型名匹配）与 `isReasoningModel()`；`router.call()` 对名单内模型剥掉 `maxTokens`。α 在 reading/review/prescreen 里的「空输出重试一次不带上限」保留作兜底。α 改 `providers/openai_compat.ts` 消费 `maxTokens` 的足迹判断：**认可**（不接这一行 α-3 空转）。
7. **`readConcurrency` 进 `CONFIG_SETTINGS`**（α 交代第 3 条）：读者 = pipeline 兜底、`lit read`（不带预算时）、批量精读 HTTP 路由；e2e 服务器固定 `SPARK_RESEARCH_READ_CONCURRENCY=1`（⑰ V88 钉的是面板中间态，3 路并行下三张假卡同刻完成看不到 1/3、2/3）。
8. **SDK 生成器**：类型别名（`X = A | B`）是运行时表达式，字母序靠后的 TypedDict 会 NameError（β 的 `PartialPayload` 触发）→ 别名一律排在全部 TypedDict 之后。
9. **quick 档综述也流式**（β-3 × α-1 的缝）：`generateQuick` 同样接 `onDelta`。
10. **server 注入的 `searcher` 透给 chat 的文献流程**（`context.ts`），否则 SSE 层的 partial 门禁没法用假件驱动。

## 三、枢纽接线（收口专属文件）与门禁

`tests/unit/w10_closeout.test.ts` 9 条，全部钉接线：
- router：思考型模型请求体无 `max_tokens`、非思考型有（对照：去掉剥离 → 红）。
- orchestrator：plan 调用 `maxTokens = STAGE_MAX_TOKENS.plan`、summarize `= .summarize`；`chat(onPartial)` 收到 papers / search_source；`chat(signal)` 透到每次调用且结束后不粘连（对照：`llmFor` 不带 signal → 红）；`case "skill"` 走 `runSkill`（paper-download 真执行、表外技能仍只加载上下文）。
- session.ts：`/stream` 里有 `partial` 事件且仍 start 开头 done 结尾（对照：不转发 onPartial → 红）；`POST /chat` 超时改 202（δ 的 `w10_delta_chat_sync` + 删除 `narrative_parity` 里的 chat_sync 孤儿豁免）。
- app.ts：`/api/health` 带 `frontendBuilt`。
- config：`configuredReadConcurrency` env 覆盖 / 非法回退。

## 四、套件（一次一个，全部在合入五 lane 之后的最终态跑）

```
unit                 2842 pass / 0 fail
concurrency+timeout    37 pass
integration(skip 检查)  8 pass
sdk (pytest)           69 passed
lab (pytest)           26 passed
e2e (playwright)       60 passed
tsc --noEmit（后端 / 前端 / e2e）无输出
```

## 五、交 R7 / 留 BACKLOG（各 lane 如实交代的汇总）

- α：输出 token −40% 无可信数字（根治后 R7 用 `measure-chat --pipeline --depth deep` 复测）；S10「同一批 8 篇 ≥ 5 篇」只有注入式门禁；arXiv 200-带错未实探（本机 IP 仍被封）。
- γ：T3 复跑 ≥ 2/8 没做；`searchLanguage` 只单测过；相关性地板是字面判据，与 α-1 语义预筛叠加效果未测。
- β：cancel 端到端要 R7 在真 server 上验（DONE「断开 SSE 后 5s 内台账不再新增行」）；`partial.card.relevance` 仍 null（α-1 的分数还没接到 card 事件）。
- ε：`ProgressEvent` 缺结构化 `phase`（阶段条靠 taskNote 中文文案认关键词）；`partial.card` 无 `recordId`；权限面板 4s 轮询。
- δ：归档后指针可能跳到另一个验收项目（`acceptance-compute`）——「工作台默认不打开验收项目」只有把验收产物归档干净才成立。
- 收口自己踩的：w1 worktree 的 `node_modules` 软链被 `git add -A` 提交过一次（已 `git rm --cached`，但历史里那几个提交会让 lane worktree 的 rebase 撞「untracked node_modules」——挪开软链再 rebase）。
