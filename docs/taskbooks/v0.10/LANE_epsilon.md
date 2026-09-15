# lane ε · 前端

只动 `frontend/**`。事件形状以 β 的 `server/types.ts` 为准（β 先出类型，你按类型渲染；β 未落地前用与类型一致的假件）。

| 项 | 做什么 | DONE / 门禁 |
|---|---|---|
| ε-1 三段式进度 | 把 `center.tsx` 里的 spinner 换成：**阶段条**（plan → search → download → read → review → summarize，当前高亮，每段显示耗时）+ **实时日志**（`progress` / `partial` 逐行追加，可折叠，`partial.papers` 的条目可点开到文献库）+ **正文区**（`delta` 按 `target` 分区流式渲染 markdown，revision 变化时清空重画）；「停止」按钮关 SSE | e2e：检索完成 ≤ 10s 出现论文标题；每张卡多一行；综述逐字出现；停止后不再有新事件 |
| ε-2 V158 / V159 / V166 | 执行段计数（`taskStarted` 若 β 提供则用，否则沿用 U49 的 `taskNote`）；设置项 422 行内显示 `message + nextStep`；BudgetInput 加说明「本项目累计已知花费上限」 | e2e 各一条 |
| ε-3 V168 令牌计数 | 权限面板计数从 token 文件实时读（γ 若改了 API 以其为准） | e2e |
| ε-4 文献列表二期 | 「关键词」列优先显示精读卡抽出的关键词（卡里 `keyFindings` 首句或新增 `keywords` 字段，与 γ 协调），无卡时退回 tags；PDF 未下载时行内「下载」按钮（调 `POST /papers/:id/pdf`） | e2e |

`NOTICE` 已含 OpenScience 结构参考的声明；新组件仍只抄模式不抄代码。
