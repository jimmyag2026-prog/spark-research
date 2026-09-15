# devlog · lane γ（设置面后端 API + 凭据写入「乙」）

worktree `~/Desktop/AI4S/spark-research-gamma` · 分支 `feat/W9-gamma` · 基线 `integration/v0.9-base`（f921bf0）

边做边写。每完成一个文件级小步就 commit。

---

## γ-0 · 契约骨架（对 ε 的承诺）

十个面板 = 十个文件 + `types.ts`（形状真源）+ `shared.ts`（loopback 闸与统一出口）+ `index.ts`（挂载）。
25 条路由，`tests/unit/settings_routes.test.ts` 逐条钉住。

统一形状定下来的三件事：

- GET → `{ panel, items[], meta }`；写 → `{ panel, item, meta }`；错误 → `{ error, nextStep }` 且 `nextStep` 非空。
- `SettingsItem` 是**跨面板统一**的一种形状（`key/label/kind/value/source/configured/allowed/editable/summary/effect/nextStep/fields/fieldsSet/extra`）。
  面板专属数据一律进 `extra`，这样「只增字段不改名」这条承诺在实现阶段不会被逼破。
- `meta.level` 是 `full | reduced | readonly` 的如实分级，减配的地方在 `meta.notes` 里写明少了什么（AD-12：
  不许在描述里声称没做到的能力）。extensions 与 compute 都是 `reduced`，permissions 是 `readonly`——
  授权/派发动作刻意不走 HTTP（AD-6）。

**为什么 `contract --json` 这一步没有在骨架 commit 里兑现**：路由要进 `contract.http.routes` 必须先被
`createApp()` 挂上，而 `backend/src/server/app.ts` 是枢纽文件、归收口（足迹表）。骨架 commit 里
25 条路由的形状由 `settings_routes.test.ts` 钉住（它自己 `app.route()` 挂一遍再读 `app.routes`），
挂载的那一行 diff 写进报告的「收口 diff」段。ε 读 `types.ts` 与各面板文件即可，不依赖 contract 产物。

### loopback 闸的判定（AD-18 ②）

远端地址只从传输层取（`hono/bun` 的 `getConnInfo`），**不读任何 header**——
`X-Forwarded-For` / `Host` 是请求方自己写的，拿它当远端地址等于把门禁交给攻击者填。

地址解析不出来（`null`）时放行，理由与 `app.ts` 顶部「缺 Origin 恒放行」同一条：
进程内 `app.fetch()`（CLI / MCP / 单测）等价于本机 shell 里跑的东西，挡它们换不来任何真实安全收益；
真实的远端请求一定带传输层地址，拿不掉。测试用 `remoteAddress` 注入伪造地址来走阴性对照。
