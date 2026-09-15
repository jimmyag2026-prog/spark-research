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

---

## γ-2 · 可注册的脱敏集合（AD-18 ④ 的地基）

`redactSecrets`（`backend/src/llm/types.ts`）原来只有形状匹配：`sk-` 开头的、`Bearer xxx`、
`api_key: xxx`。问题是**很多源的 key 就是一串普通十六进制**——它不长得像凭据，形状匹配
一个字都挡不住。凭据一旦能经 HTTP 写进来（方案「乙」），这个缺口就从「理论上」
变成「用户刚填的那个值随时可能出现在下一条上游错误消息里」。

加的是 `registerSecret()` / `registerSecrets()` / `registeredSecretCount()` /
`clearRegisteredSecrets()`，与 `redactSecrets` 开头的字面量替换（长的先替，
避免短值是长值子串时在已替换出的 `[redacted]` 里留半截原文）。只在进程内存里，
永不落盘、永不序列化。`registeredSecretCount()` 刻意只回条数不回值——
一个为了「方便调试」而回值的函数，本身就是下一个泄漏口。

**测试选值**：`settings_credentials.test.ts` 用 `9f4c2a7e51b83d06c7e2a4f8b1d093ae`
这种**不像凭据**的值。拿 `sk-xxx` 来测等于给自己放水——形状匹配本来就挡得住它，
测了也证明不了「登记」这条约束有没有生效。测试里先断言「没登记之前原样透出」，
再断言「登记之后被打掉」，两条一起才说明是登记起的作用。

## γ-3 · 凭据路由（AD-18 六条）

`tests/unit/settings_credentials.test.ts`：**14 pass / 0 fail**。

① 有一条配对的对照断言：一条断言「响应里没有值」，另一条断言「盘上真有值」——
两条一起才说明是 write-only 而不是 write-nothing（只测前者的话，一个什么都不写的
实现也能通过）。

### 阴性对照（全部真跑）

**② loopback 检查改成读 `originAllowlist`**（这条是 AD-18 的牙齿，终端输出原文）：

```
=== 阴性对照②：loopback 检查改成读 originAllowlist ===
bun test v1.3.14 (0d9b296a)

tests/unit/settings_credentials.test.ts:
120 |         method: "PUT",
121 |         headers: { "content-type": "application/json", origin: "http://203.0.113.7:4321" },
122 |         body: JSON.stringify({ fields: { api_key: SECRET } }),
123 |       }),
124 |     );
125 |     expect(res.status).toBe(403);
                             ^
error: expect(received).toBe(expected)

Expected: 403
Received: 200

      at <anonymous> (.../tests/unit/settings_credentials.test.ts:125:24)
(fail) AD-18 ② loopback 硬限，且不受 originAllowlist 影响 > originAllowlist 里写上那个地址，仍然 403

 13 pass
 1 fail
```

改法：`credentials.ts` 的 PUT 里把
`if (!isLoopbackRequest(addr))` 换成
`if (!isLoopbackRequest(addr) && !originAllowlist.includes(addr))`。
注意**只有第二条**（配了白名单那条）红——第一条（没配白名单）仍绿，
正说明这条对照抓的确实是「白名单能不能放开凭据路径」这一件事，不是把整组打红。

**① `toItem()` 把 `value` 改成返 `ctx.credentials().get(id)` 的 JSON**：

```
(fail) AD-18 ① write-only：值永不回到响应里 > PUT 之后 GET 只见字段名，两条响应体里都没有值
 13 pass
 1 fail
```

**④ 注释掉 `registerSecrets(fields)`**：

```
(fail) AD-18 ④ 写入即登记进 redactSecrets > 写后把值塞进一条假 LLM 错误消息 → 经 redactSecrets 后不可见
(fail) AD-18 ④ 写入即登记进 redactSecrets > provider 类凭据同样登记
 12 pass
 2 fail
```

三条对照跑完一律 `cp` 还原，`git diff --stat` 复核过没有残留。

### 一个避免重演的细节

`catalog.ts` 里 connector 的字段名**一个字面量都不写**，全部从真正读它的那段代码
re-export 的常量来（`AMINER_CREDENTIAL_KEY` / `MODAL_REQUIRED_CREDENTIAL_KEYS`）。
`compute/cli.ts` 的注释记着一次真实事故：设计文档写 `token_id`/`token_secret`、
adapter 读 `tokenId`/`tokenSecret`，用户照提示填完永远报「未配置」。
凭据面板要是手写第二份字段名清单，就是在重演它。

---

## γ-4 / γ-5 · 十个面板

一个跨面板统一的 `SettingsItem`，面板专属数据一律进 `extra`——这样「只增字段不改名」
这条对 ε 的承诺在实现阶段不会被逼破。`summary` / `effect` 直接用 `CONFIG_SETTINGS`
里的原文，不另写一份给 UI 看的说明（U6 证据段点名过这件事）。

`meta.level` 如实分级：`full` ×4（general / models / scientific-tools / credentials）·
`reduced` ×4（local / extensions / compute / storage）· `readonly` ×1（permissions）。
减配的地方在 `meta.notes` 里写明少了什么，不假装全功能（AD-12）。

**砍了什么**：通用审批令牌（`server/approval_token.ts`）按 §七 砍尾顺序砍掉，
extensions 退回「只读 + 无 trust 的 add-mcp」，trust / grant / revoke 维持 CLI。
理由不只是时间：启动任意 command 等价于本地任意命令执行，一个能从网页点出来的
「信任并连接」按钮就是把这件事的门槛降到一次点击。面板 `level` 标 `reduced` 并在
notes 里说清去哪做，比做一个半截的授权入口诚实。

**`?probe=1` 的两处真探**：`local` 面板真去 `GET <baseUrl>/v1/models`（3s 超时），
`scientific-tools` 真 spawn 子进程问本地平台。失败一律归一成一句话，
**不把上游响应体透出来**——那里面可能带 key 片段。

## γ-6 · V130 / includeArchived / auth --connector

- **V130**：`/api/usage` 不带 `?project` 时汇总全部项目（**含归档**——钱已经花掉了，
  归档不会退回来），响应加 `scope` 与 `projects[]`。聚合仍只用 `UsageStore.totals()`
  这一套算法，HTTP 层只是把每个项目的结果加起来（V37：两处算同一数字）。
- **`includeArchived`**：既有的 `?all=1` 保留为同义词。改名是 breaking change，
  而这里要的只是一个语义更清楚的名字，不值得打断 SDK 与既有测试。
- **`auth --connector`**：与 HTTP 写入路径**共用同一个 `CredentialStore`**，
  两条路径都登记 `redactSecrets`。测试里有两条互相看得见的对照（CLI 写 → 面板读到、
  面板写 → CLI 的 store 读到）——两份存储各写各的，迟早出现「网页说配了、CLI 说没配」。

## 真实核验（不是只跑单测）

临时把挂载行加进 `app.ts`（跑完即 `cp` 还原，`git status` 复核过），起一个真的 server：

- `contract --json` 的路由数 **78 → 103**，25 条全部在册、`group=settings`。
  U6 证据段的原话是「78 条 HTTP 路由里，没有一条能写配置」——这就是那 25 条。
- `config` 段里出现 `searchSources`。
- `PUT /api/settings/credentials/aminer` 走**真 loopback**（生产的 `getConnInfo` 路径，
  不是测试注入的 resolver）→ 200，响应里 `value: null`、`fieldsSet: ["api_key"]`、
  `fileMode: "600"`；`ls -l` 是 `-rw-------`；值在盘上但 **server 日志里 grep 不到**。
- `PUT /api/settings/models/default {"model":"no-such-model"}` → 422 且 `nextStep`
  列出了可选模型名。
- `/api/usage` → `scope: "global"`；`/api/projects?includeArchived=1` → 200。

## 环境坑（不是代码问题，但会让人误判）

本 session 的 shell 里设了 `http_proxy` / `https_proxy` / `all_proxy`，**Bun 的 fetch
连 127.0.0.1 也走代理**，于是任何起真 server 再 fetch 的测试统统拿到 503。
最小复现：`Bun.serve` + `fetch("http://127.0.0.1:<port>/")` → 503。

在**基线 f921bf0** 上跑 `tests/unit/ui_cli_parity.test.ts` 同样是 `0 pass / 9 fail`，
与本分支一模一样——所以这不是本 lane 的回归。解法是跑测试时带
`no_proxy=127.0.0.1,localhost,::1`，带上之后同一个文件全绿。
本报告里的六套件数字全部是带 `no_proxy` 跑出来的。
