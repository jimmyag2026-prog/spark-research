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
