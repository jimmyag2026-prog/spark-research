# W9-ε · 前端设置面（对标 OpenScience 12 面板）

worktree `~/Desktop/AI4S/spark-research-epsilon` · 分支 `feat/W9-epsilon` · 基线 `integration/v0.9-base`（f921bf0）

关闭 **U6·A**（网页端没有设置入口）· **U3 前端半边**（归档折叠）· **U2 徽标**（顶栏 server 版本）。

---

## NOTICE 草稿（收口合进仓库根 `NOTICE`）

本 lane 从上游只读克隆 `~/Desktop/AI4S/spark-research-v0.5-plan/upstream/openscience/` 复制了**结构**
（不是代码）：`frontend/workspace/src/components/settings/registry.ts` 的面板注册表形状
（`SETTINGS_PANELS = [{ id, title, section, component: lazy(...) }]` + 四组 `SettingsSection`），
以及 `frontend/workspace/src/components/dialog-settings.tsx` 的壳结构（左导航按 section 分组 +
面板懒加载 + 标题栏）。组件实现一律重写：上游依赖 Tailwind / i18n / `@synsci/ui` / `@kobalte/core`，
Spark 前端只有 `solid-js`，这些依赖一个都没引。

拟合进 `NOTICE` 的段落：

```
This product includes structural patterns derived from OpenScience
(https://github.com/synthetic-sciences/openscience), Copyright 2026
Synthetic Sciences, licensed under the Apache License, Version 2.0.

Specifically: the settings panel registry shape and the settings shell
layout in frontend/workspace/src/components/settings/ were modelled on
OpenScience's frontend/workspace/src/components/settings/registry.ts and
frontend/workspace/src/components/dialog-settings.tsx. No OpenScience
source code is included; the implementations are original.
```

---

## 日志

### 步骤 1 · 壳与注册表（γ 契约未到，面板走 fixture）

lane 启动时 `git log feat/W9-gamma --oneline` 的 HEAD 仍是 f921bf0——γ 一个 commit 都还没有，
路由骨架不存在。按任务书先做壳 + 注册表 + `general`，客户端类型按
`docs/taskbooks/v0.9/LANE_gamma.md` 文末的契约冻结段手写（`{ panel, items[], meta }` 信封、
写路由返回整条记录、错误体 `{ error, nextStep }`）。

三处一开始就定死、不等契约的决定：

1. **`sandbox` 面板缺席，不是 disabled**。上游 12 个面板里它是第 10 个；我们没有底子
   （V42：local network 声明不强制），放一个「未实现」的占位等于在 UI 里声称一个不存在的
   能力，违反 AD-12。注册表里**根本没有这一项**，`SETTINGS_PANEL_IDS` 也没有。
2. **面板不写第二份说明**。每个设置项的 `summary` / `effect` 一律来自 `GET /api/settings/*`
   的响应体（后端从 `CONFIG_SETTINGS` 投影）。前端源码里出现任何一条 key 的说明原文都会被
   `tests/unit/settings_registry.test.ts ③` 在 grep 级抓住。
3. **凭据面板连回显的材料都拿不到**。契约里 GET 只给 `fieldsSet: string[]`，没有任何返值字段。
   这不是靠自觉——`lib/settings_api.ts` 的 `CredentialItem` 里没有值这个概念。

`lib/api.ts` 的 `request()` 顺手加了一件事：错误体里的 `nextStep` 拼进 message。U6 点名批过
「只显示状态不说去哪做」，设置面的 403（凭据键走错路由）如果只剩「403」就正好复刻那个毛病。

### 步骤 2 · 壳 + `general` 面板 + 注册表门禁

壳：`components/settings/shell.tsx`。弹窗语义（焦点陷阱 / Esc / 点背景关闭）**复用
`components/ui.tsx` 的 `Modal`**，只给它加了 `wide` 与 `bodyClass` 两个参数——设置面没有
理由把这三件事再实现一遍。左导航按四组 section 排，搜索框过滤面板名与面板内设置项。

入口三处：左栏「运维」加「设置」、数字键 `6`、`Esc` 关。设置面**不进 `CenterView`**——
它是覆盖层，要能从任何视图上打开、关掉之后回到原处。

**搜索索引的真实覆盖范围（如实交代）**：索引是面板自己在拿到 API 数据后登记的
（`SettingsPanelProps.register`），所以只覆盖本次打开过的面板。`general` 是默认面板、
壳一开就挂，那 32 个配置键永远可搜——U6 的主诉正是这 32 个键。没建索引的面板在有搜索词时
**不隐藏**，降一档显示并在导航项上标 `?`：搜不到不等于里面没有，藏掉就是做一个兑现不了的
承诺。彻底解法要后端一条总索引路由，已写进「给 γ 的契约请求」。

`② 面板可懒加载` 这条只做到一半，原因写在测试注释里：Solid 的 JSX 是
`vite-plugin-solid` 在编译期整个消掉的，`solid-js/jsx-dev-runtime` 指向 `dist/solid.js`
而那里没有 `jsxDEV` 导出，bun test 里 `import("./General.tsx")` 必然
`SyntaxError: Export named 'jsxDEV' not found`（在文件头加 `@jsxImportSource solid-js`
pragma 试过，改得了解析目标改不了「那个模块没有这个导出」）。于是静态半在单测里做
（`lazy()` 产出组件函数 + import 路径在磁盘上真有文件 + 文件真有 `export default`，
路径从 registry.ts 源码读出来而不是手抄），**运行半交给 e2e**（每个面板一条用例，
真浏览器点开）。`bun run build:web` 的产物里有独立的 `assets/General-*.js` chunk，
懒加载在构建层面是成立的。

#### 阴性对照（真跑，输出见下）

| 改法 | 结果 |
|---|---|
| 注册一个 `section: "misc"` 的面板 | ① 红 |
| 在 `General.tsx` 里硬编码 `contactEmail` 的 `summary` 原文 | ③ 红，指名 `General.tsx 抄了 contactEmail 的说明原文` |
| 注册一个 `sandbox` 面板 | ④ 红 |

```
################ 阴性对照 A：注册一个 section:"misc" 的面板 ################
error: expect(received).toBe(expected)
Received: false
(fail) 设置面板注册表 > ① 面板 id 唯一，section ∈ 四组，且与 SETTINGS_PANEL_IDS 一一对应
 4 pass
 1 fail
################ 阴性对照 B：在 General 面板里硬编码一条 key 的说明原文 ################
借用的说明原文： 文献 API 礼貌头里的联系邮箱（OpenAlex/CrossRef 的 polite pool）
+   "General.tsx 抄了 contactEmail 的说明原文",
(fail) 设置面板注册表 > ③ 面板源码里不得出现任何 CONFIG_SETTINGS 说明的原文（说明只有一份，来自 API）
 4 pass
 1 fail
################ 阴性对照 C：注册一个 sandbox 面板 ################
(fail) 设置面板注册表 > ④ 没有 sandbox 面板，也没有 sandbox 占位文件
 4 pass
 1 fail
################ 复原后 ################
 5 pass
 0 fail
```

**注册表随交付长出来**：一个面板的实现文件真的存在、真的接了后端之后，它的 id 才进
`SETTINGS_PANEL_IDS`。先把 12 个 id 写全、文件慢慢补，中间态就是一批点开是空的面板
——那是「放占位」的另一种写法。

### 步骤 3 · γ 契约到了，按它重做客户端 + 十一个面板一次性长齐

`feat/W9-gamma` 的 `d2fa8d4`（骨架 + 响应 schema，返回 fixture）出现后，读
`git show feat/W9-gamma:backend/src/server/routes/settings/types.ts` 与十个路由文件，
按真契约重写了 `lib/settings_api.ts`。

**契约比我按任务书猜的形状好得多**：γ 把所有面板的条目统一成一个 `SettingsItem`
（`{ key, label, kind, value, editable, summary, nextStep, fields, fieldsSet, extra }`），
`meta` 统一成 `{ level, summary, notes }`。于是十一个面板的共同部分只写一遍
（`panel_kit.tsx`：取数 → 登记搜索索引 → 按 query 过滤 → 按 `kind` 渲染控件 → 写回刷新），
各面板只剩自己那点特殊长相。我按猜测写的那版一面板一套类型全部作废，删掉重来。

三处因为读了真契约而改掉的决定：

1. **能力分级不再存在前端**。我原先在注册表里给每个面板写了 `parity: "same" | "reduced"`
   加一段 `gap` 文案——那是第二份真源。γ 的 `meta.level`（`full` / `reduced` / `readonly`）
   与 `meta.notes` 是后端如实标注的，面板抬头直接渲染它。注册表里的 `parity` / `gap` 全部
   删掉，并加了门禁 ③b：`registry.ts` 里出现 `parity` / `gap:` / `level:` 就红。
2. **不可写的条目不给控件**。契约里每条都有 `editable`，不可写时 `nextStep` 必非空。
   引擎据此在 `editable === false` 时渲染「去哪做」而不是一个点下去必然 403 的输入框。
   凭据面板、权限面板、算力面板的只读部分全走这一条，不用各写一遍。
3. **`registry.ts` 拆成 `registry_table.ts` + 绑定**。单测 import 注册表时，
   `lazy(() => import("./General"))` 会把 `.tsx` 拽进 program，而仓库根 tsconfig
   （`include: tests/**/*.ts`）没开 `jsx` → `TS6142`。真源清单拆成只有数据的
   `registry_table.ts`，绑定留在 `registry.ts`；两边一致性由门禁 ② **正反两向**核对
   （清单里每个 id 都有绑定 + 绑定表里不许有清单外的 id），绑定关系从源码读出来，
   不是测试里手抄的第二份映射。

面板与后端路由的对应（前端 12 个 ↔ 后端 10 条 GET）：

| 前端面板 | 后端 | 说明 |
|---|---|---|
| general | `GET/PUT/DELETE /general` | 32 键投影 |
| models | `GET /models` · `PUT /models/default` · `PUT /models/subagent/:kind` | 按条目分流两条写路径 |
| local-models | `GET/PUT /local` | 探测结果来自 `extra.probe` |
| credentials | `GET/PUT/DELETE /credentials/:id` | 见下 |
| sources | `GET /scientific-tools` 的 `searchSources` 条 + `PUT /sources` | 上游没有这一块 |
| scientific-tools | `GET /scientific-tools[?probe=1]` | 过滤掉 `searchSources`，免得同一设置两处控件 |
| connectors | `GET /extensions` 的 `category ∈ {mcp, connector}` + `POST/DELETE` | |
| skills | `GET /extensions` 的 `category === "skill"` | 只读 |
| compute | `GET /compute` · `PUT /compute/target` | 只有改默认执行地一个写动作 |
| network | `GET/PUT /network` | general 的投影 |
| storage | `GET/PUT /storage` · `POST /storage/export` | |
| permissions | `GET /permissions` | 只读，不传 `write` |

**凭据面板「值永不回显」的三道**（一道靠契约、一道靠代码、一道靠测试）：
① 契约层面 `SettingsItem.value` 在 `kind === "secret"` 时恒为 null，GET 只给 `fieldsSet`
——前端连回显的材料都拿不到；② 保存**无论成败**都立刻清空本地草稿，不把刚填的值留在
内存里等某次重渲染画回输入框；③ e2e 用 `page.on("response")` 盯住所有响应体。

### 步骤 4 · e2e（㉑–㉝，只追加，既有 ①–⑳ 一条没动）

13 个编号、49 条用例（㉛ 是一个面板一条，展开成 12 条）。

**这批用例跑在哪个后端上，如实说清楚。** γ 的设置路由挂载进 `server/app.ts` 的那一行是
枢纽文件、归收口，所以在 ε 的分支上 `/api/settings/**` 还是 404。`installSettingsBackend()`
装的是一个**回退**拦截器：每个请求先真的发给 server（`route.fetch()`），**只有 404 时**
才由 spec 里的内存假件应答。三个后果：

1. 今天验的是**前端**（发对请求、渲染对响应、写完刷新、值不回显），后端那一半由 γ 自己的
   `tests/unit/settings_*.test.ts` 验。
2. 收口把那一行合进去之后，同一批断言**自动**改为打真路由，假件变成死代码——它是会自己
   退役的脚手架，不是一个需要记得回来删的 TODO。
3. 凭据那条「任何 XHR 响应体都不含填入的值」在假件下只证明了假件不回显，牙齿在收口后才
   完整；**但同一条用例里的「页面任何位置不出现该值」是真的**——那一半盯的正是前端有没有
   把值画回界面，也正是阴性对照要拆的地方。

假件是**有状态**的（PUT 真的改它），所以「改了刷新仍在」这件事在前端侧是真的被验的。

#### 环境坑（不是代码问题，但会让人以为是）

这台机器的 agent 环境设了 `http_proxy` / `https_proxy` / `all_proxy=socks5://127.0.0.1:11080`。
Playwright 的 webServer 就绪探测与 `bun test` 里的 `fetch("http://127.0.0.1:…")` 都会被
路由进代理，拿到 **503**：

```
$ curl -s -m 5 -w "status=%{http_code}" http://127.0.0.1:4521/api/health
status=503                                   ← 空响应体
$ curl -s -m 5 --noproxy '*' -w "\nstatus=%{http_code}" http://127.0.0.1:4522/api/health
{"status":"ok","service":"spark-research","version":"0.8.0"}
status=200
```

表现是 `Error: Timed out waiting 120000ms from config.webServer`（server 明明打印了
listening），以及 `bun test tests/unit` 里 **164 条红**（全是 `body.version` 之类的
`null is not an object`）。跑法：

```
env -u http_proxy -u https_proxy -u all_proxy NO_PROXY='127.0.0.1,localhost' \
  no_proxy='127.0.0.1,localhost' bun run test:e2e
```

同一份代码，带代理 2325 pass / 164 fail，不带代理 **2489 pass / 0 fail**。这条值得进
收口的环境备注：谁在这台机器上复跑，不设 `no_proxy` 会看到一片假红。

#### 三个写测试时踩到的真实缺陷（都改了测试，不是改代码去迁就测试）

1. `.badge-ok` 在凭据行里有两个（行级「已配置」、字段级「已设」），`toContainText` 撞上
   strict mode。改成按文本 `/^已设$/` 过滤，而不是 `first()`——后者会随渲染顺序漂移。
2. `page.evaluate` 的回调在浏览器里跑，拿不到模块作用域的 `PROJECT` 常量
   （`ReferenceError: PROJECT is not defined`）。两个 slug 都显式传进去。
3. `POST /api/projects/:slug/archive` **没有请求体也要 `Content-Type: application/json`**
   （`server/app.ts` 的既有写请求闸）。少这个头拿到的是 400，而下拉框里看不出任何差别
   ——用例会「通过归档失败」来变红，排查方向完全错。这条坑值得记：**写请求没有 body 时
   最容易忘这个头**。

#### 阴性对照（真跑，输出见下）

| # | 改法 | 结果 |
|---|---|---|
| A | 注册一个 `section: "misc"` 的面板 | 单测 ① 红 |
| B | 在 `General.tsx` 里硬编码 `contactEmail` 的 `summary` 原文 | 单测 ③ 红 |
| C | 注册一个 `sandbox` 面板 | 单测 ④ 红 |
| D | **凭据面板把保存的值回显到行里** | e2e ㉔ 红（页面文本断言） |
| E | **让后端把值回显进响应体** | e2e ㉔ 红（`page.on("response")` 断言） |

D 第一次写错了：只是「保存后不清草稿」，结果**测试照样绿**——因为 `refetch` 让
`<For>` 重建了 CredentialRow，组件级的 `draft` 信号跟着重置，值自己没了。这说明第一版
对照根本没复现出泄漏。改成把值记进模块作用域的 `LEAKED_VALUES` 并渲染进行内（一个天真
实现真正会有的样子），才红。**记一笔**：阴性对照本身也会假绿，「改了之后测试还是绿」的
第一反应应该是「我的对照是不是没生效」，而不是「门禁没牙」。

D 的输出（页面 HTML 里出现了那个值）：

```
1) ㉔ 凭据面板：填入的假 key 不出现在页面任何位置，也不出现在任何响应体里
   Error: expect(received).not.toContain(expected) // indexOf
   Expected substring: not "sk-e2e-epsilon-NEVER-ECHO-3f9a71c2d4b6"
   Received string: "<!DOCTYPE html>… <span class=\"badge badge-ok\">已设</span>
     <span data-testid=\"leaked-echo\">sk-e2e-epsilon-NEVER-ECHO-3f9a71c2d4b6</span> …"
     at tests/e2e/workbench.spec.ts:1403:24   (expect(pageHtml).not.toContain(FAKE_KEY))
   1 failed
```

E 的输出（三个响应体里带上了那个值）：

```
✘ 1 ㉔ 凭据面板：填入的假 key 不出现在页面任何位置，也不出现在任何响应体里 (803ms)
  Error: expect(received).toEqual(expected) // deep equality
  - Expected  - 1
  + Received  + 3
  > 1414 |   expect(leaks).toEqual([]);
      at tests/e2e/workbench.spec.ts:1414:17
  1 failed
```

复原后全绿：`49 passed (30.7s)`。
