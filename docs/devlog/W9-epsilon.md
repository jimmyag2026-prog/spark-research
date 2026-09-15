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
