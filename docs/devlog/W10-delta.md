# W10 · lane δ（运维与卫生）

分支 `feat/W10-delta`，基于 `integration/v0.10-base` = ff077ea。
任务书 `docs/taskbooks/v0.10/LANE_delta.md`（δ-1..δ-5）。

> **push 状态**：过程中每一小步的 push 都被 reset
> （`fatal: unable to access 'https://github.com/…': Recv failure: Connection reset by peer`，
> 各重试 3 次均失败），于是先继续干活。收尾时再试**成功**：
> `git ls-remote origin feat/W10-delta` → `77d26f8241408bfad4787c283bf22816f89df202`。

---

## δ-1 · V157 验收产物归档

改：`backend/src/project/slug.ts`（`globToRegExp` / `slugMatchesGlob`）、
`backend/src/project/manager.ts`（`archiveMatching` / `matchActive` / `lastActivityAt` /
`mostRecentActiveSlug`，以及 `setStatus` 归档当前项目时的指针跳转）、
`backend/src/project/cli.ts`（`archive --pattern <glob> [--dry-run]`）。

两个判断上的取舍，都往「宁可漏不可多」那边靠：

- **glob 整串匹配，只认 `*` 与 `?`**。`--pattern r6` 匹不上 `r6-probe`；要匹前缀得显式写 `r6-*`。
  这个命令批量改状态，多一种语法就多一种「以为匹上了其实没匹上」。
- **「最近活动」不取 `meta.updatedAt`**——那个字段只在建项目/改状态时动，一个写了两百条 record
  的项目它也不变，拿它排序等于按创建顺序排。取 `records.db` 的 mtime 与 `updatedAt` 里更晚的那个。

指针跳转这条是 V157 的实质：老行为是归档当前项目就把 `currentProject` 置 `null`，
看着安全，实际后果是下一次 `defaultProject()` 会**按需新建**一个空白 `default`——
「归档掉探针项目」这个动作会静默把用户扔进一个空项目。现在改成跳到最近活动的未归档项目，
一个都不剩时才落回 `null`（那时建 `default` 是对的）。

### 本机实测（不删任何数据，归档可逆）

归档前 `~/.spark-research/projects` 46 个，`currentProject = spark0915`。

```
$ bun backend/src/index.ts project archive --pattern 't*-r*' --dry-run
将归档 13 个项目（--dry-run，未改动任何状态）：
  t1-protein-r1
  t3-bci-r1v2
  ...（13 条）
```

依次跑 `t*-r*` `r6-*` `a8-*` `speed-probe` `r4-*` `binary-probe` `v27probe`，
再补 `r5-*` `a5-*` `acceptance-*`。结果：

```
$ bun backend/src/index.ts project list
  protein-structure-confidence  蛋白质结构预测中的置信度评估  创建于 2026-09-09T14:27:20.157Z
  test-time-scaling  Test-Time Compute Scaling for LLM Reasoning  创建于 2026-09-10T08:17:49.790Z
  spark  spark  创建于 2026-09-14T08:19:56.918Z
  default  默认项目  创建于 2026-09-15T08:50:22.407Z
* spark0915  spark0915  创建于 2026-09-15T12:29:40.060Z

$ bun backend/src/index.ts project list --all | grep -c "已归档"
41
```

46 → 未归档 5 个，41 个归档，**零删除**。

指针跳转本身在真实工作区上触发不了（`currentProject` 本来就是 `spark0915`，不在归档集里）。
于是在 scratchpad 里**复刻**了一份工作区（46 份 `project.json` 原样、`records.db` 的 mtime
原样、`currentProject` 置成 R6 现场的 `speed-probe`），跑同一串命令：

```
$ SPARK_RESEARCH_DATA_DIR=<复刻> bun backend/src/index.ts project archive --pattern 'speed-probe'
✅ 已归档 1 个项目：
  speed-probe

当前项目 'speed-probe' 被归档 → 已自动切到最近活动的未归档项目 'acceptance-compute'
```

**这里有个如实要说的发现**：跳过去的 `acceptance-compute` 本身也是个验收项目。
「归档后工作台默认打开的不是验收项目」这条判据，只有**把验收产物归档干净**才成立，
自动跳转本身保证不了它——它只保证「跳到一个还活着的项目」。补跑 `r5-*` `a5-*`
`acceptance-*` `t5-*` 之后：

```
当前项目 'acceptance-compute' 被归档 → 已自动切到最近活动的未归档项目 'spark0915'
$ ... project list
* spark0915  spark0915  创建于 2026-09-15T12:29:40.060Z
```

判据达成（`spark0915` 是真实课题，不是验收产物）。任务书里的「跑完归档」一步就是冲这个来的。

### 任务书

`docs/taskbooks/v0.9/R6_A8.md` 与 `docs/taskbooks/v0.9/T5_config_ops.md` 各加一段「收尾：跑完归档」。

### 门禁 `tests/unit/w10_delta_project_archive.test.ts`（8 条）

```
$ bun test tests/unit/w10_delta_project_archive.test.ts
 8 pass
 0 fail
 22 expect() calls
```

**阴性对照①**（先 commit 后做）：把 `setStatus` 的指针跳转退回老行为（置 `null`）。

```
Expected: "recent-work"
Received: null
(fail) δ-1 指针跳转 > 归档当前项目 → 指针跳到最近活动的未归档项目，而不是置 null
Expected: "work"
Received: null
(fail) δ-1 指针跳转 > 单个 slug 的 archive 走同一条跳转路径
 6 pass
 2 fail
```

---

## δ-2 · V160 + V162 doctor

改：`backend/src/server/health.ts`（**新文件**）、`backend/src/doctor/running_instance.ts`、
`backend/src/doctor/cli.ts`、`backend/src/doctor/index.ts`。

- **V160**：`probePorts` 现在合并三个来源——默认 4321 + config 的 `serverPort` + 命令行
  `--port`（可重复，`--port=4399` 也认）。端口非法直接报错，**不静默忽略**：用户敲了
  `--port abc` 却拿到一份「没有实例」的报告，是诊断工具最坏的失败形状。
- **V162**：`/api/health` 加 `frontendBuilt`，doctor 按**实例**报前端产物；实例没报这个字段
  （v0.10 之前的构建）时说「不知道」，不说「没构建」。doctor 自己 cwd 那一段标题改成
  「▎前端（当前 checkout）」，并在「当前 checkout 没构建但某个实例有」时明说这是两件事——
  V162 的病根就是把这两个问题当成了一个。
- `frontendBuilt` 的判定只有一份（`server/health.ts` 的 `frontendBuiltAt`），`/api/health`
  与 doctor 共用，不各判一次。

### 收口 diff（`backend/src/server/app.ts`，收口专属 → 本 lane 未提交）

**已在本机临时打上验证过，验证完 `git checkout --` 还原；本 lane 的提交里不含它。**

```diff
--- a/backend/src/server/app.ts
+++ b/backend/src/server/app.ts
@@ -27,6 +27,7 @@ import { settingsRoutes } from "./routes/settings";
 import { registerExistingSecrets } from "./routes/settings/credentials";
 import type { ArtifactListResponse, ChatRequest, ChatResponse, LineageResponse } from "./types";
 import { PACKAGE_VERSION } from "../version";
+import { healthPayload } from "./health";
 
 export type { ServerDeps } from "./context";
 
@@ -222,7 +223,8 @@ export function createApp(deps: ServerDeps = {}): Hono {
 
   // 版本号单一真源是 package.json。此前这里硬编码 "0.2.0"，而 package.json 还写着 0.1.0——
   // 两处不一致时没有任何东西会报警，只会让「你跑的是哪个版本」这个问题变得不可回答。
-  app.get("/api/health", (c) => c.json({ status: "ok", service: "spark-research", version: PACKAGE_VERSION }));
+  // δ-2（V162）：载荷含 frontendBuilt，判定住在 server/health.ts（doctor 复用同一函数）。
+  app.get("/api/health", (c) => c.json(healthPayload(frontendDir)));
 
   app.get("/api/connectors", (c) => c.json({ connectors: ctx.connectors.listAll() }));
```

`3 insertions, 1 deletion`（其中一行是注释）。`PACKAGE_VERSION` 在该文件仍被别处使用，import 不动。

### 本机实测

4321 上是用户自己的实例（pid 81821，从主检出 `spark-research-u57` 跑的 v0.9.1）——
**全程没有碰它**。第二个实例由本 lane 在 4399 上起，数据目录指向 scratchpad，结束时自己关掉。

不给 `--port`（复现 V160 现场）：

```
▎运行实例（探端口 4321）
  ✅:4321    版本一致（v0.9.1）
      pid 81821 · 启动于 Wed Sep 16 00:07:43 2026
      bun backend/src/index.ts server 4321
      cwd /Users/jimmyclaw/Desktop/AI4S/spark-research-u57
      前端产物：这个实例没报（v0.10 之前的构建不带 frontendBuilt 字段）——只能自己打开 :4321 看
```

给 `--port 4399`（**两个实例都报出来** = δ-2 的 DONE 判据）：

```
$ bun backend/src/index.ts doctor --port 4399
▎运行实例（探端口 4321 / 4399）
  ✅:4321    版本一致（v0.9.1）
      pid 81821 · 启动于 Wed Sep 16 00:07:43 2026
      bun backend/src/index.ts server 4321
      cwd /Users/jimmyclaw/Desktop/AI4S/spark-research-u57
      前端产物：这个实例没报（v0.10 之前的构建不带 frontendBuilt 字段）——只能自己打开 :4321 看
  ✅:4399    版本一致（v0.9.1）
      pid 92891 · 启动于 Wed Sep 16 02:05:42 2026
      bun backend/src/index.ts server 4399
      cwd /Users/jimmyclaw/Desktop/AI4S/spark-research-delta
      前端产物：这个实例没报（v0.10 之前的构建不带 frontendBuilt 字段）——只能自己打开 :4399 看
```

把上面那份收口 diff 临时打上、重起 4399 的实例之后（**这就是收口之后的样子**）：

```
$ curl -s http://127.0.0.1:4399/api/health
{"status":"ok","service":"spark-research","version":"0.9.1","frontendBuilt":false}

$ bun backend/src/index.ts doctor --port 4399
▎运行实例（探端口 4321 / 4399）
  ✅:4321    版本一致（v0.9.1）
      ...
      前端产物：这个实例没报（v0.10 之前的构建不带 frontendBuilt 字段）——只能自己打开 :4321 看
  ✅:4399    版本一致（v0.9.1）
      pid 93004 · 启动于 Wed Sep 16 02:06:23 2026
      bun backend/src/index.ts server 4399
      cwd /Users/jimmyclaw/Desktop/AI4S/spark-research-delta
      ❌ 前端产物：这个实例没有（浏览器打开 :4399 只会看到构建指引页）
         修复：到这个实例的 checkout 里 bun run build:web，然后重起它

▎前端（当前 checkout）
  ❌ 未构建  /Users/jimmyclaw/Desktop/AI4S/spark-research-delta/frontend/workspace/dist
      修复：bun run build:web
```

4321 那条正好演示了 `null`（旧构建不报）与 4399 的 `false`（新构建真没有）**分得开**。
验证完毕后 `kill 93004` + `git checkout -- backend/src/server/app.ts`；4321 的 81821 原样在跑。

### 门禁 `tests/unit/w10_delta_doctor.test.ts`（7 条）

```
$ bun test tests/unit/w10_delta_doctor.test.ts
 7 pass
 0 fail
 27 expect() calls
```

**阴性对照④**：`probePorts` 丢掉 `cliPorts`（= `--port` 说了也白说，V160 现场）。

```
Expected to contain: "▎运行实例（探端口 4321 / 4399）"
Received: "... ▎运行实例（探端口 4321）..."
(fail) δ-2 V160 > 接线：CLI 的 --port 真的传到了探测清单里（两个实例都报出来）
 5 pass
 2 fail
```

---

## δ-3 · V163 / V169 / V170

- **V163** `backend/src/config/cli.ts`：抽出 `width()` / `ellipsize()`，`config list` 的长值
  截断改成「看得出被截断」。原来是裸 `slice(0, 32)`，一个 60 字符的 `originAllowlist` 被砍成
  32 字符照样打印成一个**看起来完整**的值——诊断输出撒的谎比不输出更贵。
- **V169** `backend/src/data/import.ts`：文案改「目标项目须不存在（由 import 自己创建）」，
  并把这条判据**前移到 sha256 校验之前**（调用方自己能立刻改的事，不该等把整个导出目录
  校验一遍之后才说）。顺带回答任务书那句「核一下空项目是不是本该允许」：**不该**——
  import 原样插入 journal（seq 与 hash 不重算），一个已经 `create` 过的项目其 `records.db`
  已有 backfill 痕迹，链的起点对不上，「空」在这里不是一个可核验的状态。
- **V170** `docs/taskbooks/v0.9/T5_config_ops.md` 第 13 步：`/api/config/*` → `/api/settings/general/*`
  （核实过 `PUT /api/settings/general/:key` 真的注册在 app 上）。

> **足迹如实交代**：`backend/src/config/**` 在 `_COMMON.md` 的表里归 γ。δ-3 的 V163 明文要求改
> `config list`，δ-4 又要在配置注册表里加 `chatSyncMaxMs`，两处都动了 `config/`。改动是**加法**
> （新增 `width`/`ellipsize` 两个函数、新增一条配置项 + 一个 `configuredChatSyncMaxMs`），
> 只改写了 `config list` 的一行渲染，与 γ 的中文/凭据/错误形状不重叠。收口时若有冲突，以 γ 为准。

### 门禁 `tests/unit/w10_delta_ops_text.test.ts`（4 条）

其中一条把 V170 那类漂移**长期**兜住：`docs/taskbooks/**` 里出现的每个 `/api/` 路径，
都必须能在 `createApp()` 的路由表里找到匹配的模式。

```
$ bun test tests/unit/w10_delta_ops_text.test.ts
 4 pass
 0 fail
 12 expect() calls
```

**阴性对照②**：把 T5 第 13 步端点改回 `/api/config/*`（V170 现场）。

```
+ [
+   "docs/taskbooks/v0.9/T5_config_ops.md: /api/config/OPENROUTER_API_KEY",
+ ]
(fail) δ-3 V170 · 任务书里的 /api/ 路径必须存在 > docs/taskbooks/** 里出现的 /api/ 路径都注册在 app 上
 3 pass
 1 fail
```

**阴性对照③**：`config list` 渲染行退回裸 `slice(0, 32)`（V163 现场）。

```
Expected to contain: "…"
Received: "originAllowlist       http://a.example.com,http://b.ex  config    HTTP 服务器额外信任的 Origin 主机名..."
(fail) δ-3 V163 > 接线：config list 真实输出里，被截断的值带 …
 3 pass
 1 fail
```

---

## δ-4 · V156 ①②

改：`backend/src/server/chat_sync.ts`（**新文件**）、`backend/src/config/index.ts`
（注册 `chatSyncMaxMs`，默认 200_000 + `configuredChatSyncMaxMs`）、
`readme_for_human.md`（新增 §6.5）、`sdk/python/README.md`（顶部提示）。

口径：chat **一律先进 TaskRegistry**（跟其它长任务同一条路），然后同步等 `chatSyncMaxMs`。
等到了 → 照旧 200 + 完整结果，调用方一个字都不用改；等不到 → **202 + `taskId`**，
任务在后台继续跑，句柄接得回结果。默认 200s 刻意低于 Bun.serve 的 255s 上限（留 55s 余量）——
调到 255s 以上等于关掉这条兜底，这句话写进了配置项的 `effect` 里。

两个刻意的决定：

- **没做方向③（断连即取消）**。它要的是客户端断开信号透传进 orchestrator，那是收口专属文件的口子，
  不在本 lane。这里只保证「已经在跑的东西有人接得住」，不替用户决定该不该停。
- **任务体的原始异常照旧抛给调用方**，不被任务注册表吞成 `failed` 了事——否则路由层
  `CoExploreError → 422` 的映射会被静默降级成 500。

### 收口 diff（`backend/src/server/routes/session.ts`，收口专属 → 本 lane 未提交）

**已在本机临时打上跑通过，跑完 `git checkout --` 还原；本 lane 的提交里不含它。**
`7 insertions, 2 deletions`。

```diff
--- a/backend/src/server/routes/session.ts
+++ b/backend/src/server/routes/session.ts
@@ -4,6 +4,7 @@ import { CoExploreError } from "../../ideation/coexplore";
 import { HttpError, type ServerContext } from "../context";
 import { ProjectError } from "../../project/manager";
 import { sseResponse } from "../sse";
+import { chatAcceptedBody, chatSyncMaxMs, runChatWithSyncDeadline } from "../chat_sync";
 import type { TaskEvent } from "../tasks";
 import { jsonBody, optionalBool, optionalNumber, optionalString, queryNumber, queryString, requireString } from "./shared";
 
@@ -59,8 +60,10 @@ export function sessionRoutes(ctx: ServerContext): Hono {
     bindRequestedProject(ctx, c, body, sessionId);
     const mode = parseMode(optionalString(body, "mode"));
     let result: Awaited<ReturnType<typeof ctx.agent.chat>>;
+    // δ-4（V156 ①）：同步路由等过 Bun.serve 的 255s 就被掐断、结果蒸发。改走任务句柄兜底。
+    const maxMs = chatSyncMaxMs({ root: ctx.deps.root });
     try {
-      result = await ctx.agent.chat({
+      const outcome = await runChatWithSyncDeadline({ tasks: ctx.tasks, maxMs, run: () => ctx.agent.chat({
         sessionId,
         message,
         model: optionalString(body, "model"),
@@ -68,7 +71,9 @@ export function sessionRoutes(ctx: ServerContext): Hono {
         // V119：UI 预算入口透传（只做类型校验，闸在 usageTrackingLlm）。
         budgetUsd: optionalNumber(body, "budgetUsd"),
         allowUnpriced: optionalBool(body, "allowUnpriced"),
-      });
+      }) });
+      if (outcome.kind === "accepted") return c.json(chatAcceptedBody({ sessionId, mode: mode ?? "chat", task: outcome.task, maxMs }), 202);
+      result = outcome.result;
     } catch (error) {
       // 模型两次都产不出合契约的 Idea 卡：服务端没坏，是这次生成不可用 → 422 而不是 500。
       if (error instanceof CoExploreError) throw new HttpError(422, error.message);
```

临时打上后，用真的 `createApp()` + 假 agent（一个 400ms 才 resolve 的 chat）与
`config.json` 里 `chatSyncMaxMs: 50` 实跑：

```
慢于阈值 → HTTP 202
body keys: sessionId,mode,taskId,task,hint | taskId: dc2fe3f3-d33c-4907-a202-70983c531560
hint: 这次 chat 超过了同步等待上限 50ms（config: chatSyncMaxMs），已改走任务句柄——任务仍在后台跑，
      用 GET /api/tasks/dc2fe3f3-…/ 轮询或 GET /api/tasks/dc2fe3f3-…/stream 订阅。
      想要全程可见（阶段进度 + 正文流式），下次直接用 POST /api/session/stream。
快于阈值 → HTTP 200 {"sessionId":"s2","mode":"chat","projectSlug":null,"summary":"快答案"}
```

### 门禁 `tests/unit/w10_delta_chat_sync.test.ts`（7 条）

用**真的 `TaskRegistry`**（不是假件）跑——要钉的正是「超时那一路任务真的还在注册表里继续跑、
句柄查得到最终结果」，假一个 registry 就把这条最关键的性质假掉了。

```
$ bun test tests/unit/w10_delta_chat_sync.test.ts
 7 pass
 0 fail
 18 expect() calls
```

**阴性对照⑤**：超时那一路退回「直接 await，一直等下去」（V156 现场）。

```
Expected: "accepted"
Received: "result"
(fail) δ-4 V156 · 同步 chat 超阈值改 202 > 慢于阈值 → accepted + taskId，且任务在后台继续跑到有结果
 6 pass
 1 fail
```

**阴性对照⑥**：`chatSyncMaxMs` 注册了但没人读（退回硬编码默认）。

```
Expected: 1234
Received: 200000
(fail) δ-4 V156 · chatSyncMaxMs > 接线：config.json 里的 chatSyncMaxMs 真的被读到
 6 pass
 1 fail
```

---

## δ-5 · V167 核实：TTY 门在 pty 包装下能被满足

**结论：V167 成立。TTY 检测不是安全边界。**（代码行为不改，改的是措辞。）

实测在 scratchpad 的独立数据目录里做（`SPARK_RESEARCH_DATA_DIR=…/labws`），
用 `mock_devices` 后端编了一个真的湿实验，全程不花钱、不碰用户数据。

### ① 对照：不加 pty（管道），TTY 门拒绝

```
$ echo yes | bun backend/src/index.ts lab approve 484130be --actor "delta-lane"
🚫 [V19] 当前不是交互终端（process.stdin/stdout 不是 TTY），且未配置环境变量
SPARK_LAB_CI_BYPASS_TOKEN——拒绝批准。这是 AD-9 的技术防线：非交互环境（脚本/CI/Bash 工具子进程）
默认拿不到审批权限，不存在"跑一条命令就能批准"的路子。真人请在一个真实终端里重跑本命令；
CI/自动化场景需要运维显式配置 SPARK_LAB_CI_BYPASS_TOKEN，并在命令行显式传
--ci-bypass-token 与 --ci-bypass-reason。
```

### ② pty 包装（`script -q /dev/null`）+ 把 `yes` 喂进去 → **全流程批准成功**

第一次直接 `printf 'yes\n' | script …` 只看到提示、没批准成功（管道的 EOF 抢在 readline
挂上之前）。把喂入延后一点就通了——这一点值得记下来：**「试了一下没成功」不等于「挡住了」**。

```
$ { sleep 2; printf 'yes\n'; sleep 3; } | script -q /dev/null \
    bun backend/src/index.ts lab approve 484130be --actor "delta-lane"
[V19] 即将批准实验 484130be——这是 AD-6 要求的人工判断，输入 'yes' 确认：yes
✅ 已批准（decision record f4d1e34c）
[484130be] V167 核实
    approved · mock_devices · 第 1 轮 · 执行 0 次 · hash af31f72825c8118a
    ✅ delta-lane @ 2026-09-15T18:14:33.427Z 批准 af31f72825c8118a
    ⚠️  step-1：词表外，安全规则未覆盖（原文：把 A1 孔的  到 B1 孔）
下一步：spark-research lab simulate 484130be

$ bun backend/src/index.ts lab status 484130be
- 状态：**approved**
```

状态真的迁到了 `approved`，decision record 真的落了，`actor` 是一个**现编的名字**。
`script(1)` 是 macOS/Linux 自带的，不需要装任何东西。

### ③ pty 包装但喂的不是 `yes` → 取消

```
$ { sleep 2; printf 'no\n'; sleep 2; } | script -q /dev/null \
    bun backend/src/index.ts lab approve 6de94c98 --actor "delta-lane"
[V19] 即将批准实验 6de94c98——这是 AD-6 要求的人工判断，输入 'yes' 确认：no
🚫 [V19] 终端交互没有收到 'yes'（收到 "no"）——批准已取消。批准/拒绝必须来自一次真实的交互确认，
不接受静默通过。
$ bun backend/src/index.ts lab status 6de94c98 | grep 状态
- 状态：**awaiting_approval**
```

### 据此改了措辞（代码行为不动）

`backend/src/approval/gate.ts` 顶部原来写着「『伪造一次交互』本身就先过不了这一步判定」——
**删掉**，换成 V167 的实测结论与「那这道门还剩什么」：

- 剩下的真正的门是 ① 那句**字面 `yes`**（保证批准是显式、不可与别的输入混淆的动作，
  挡误触与顺手回车，不挡有意的自动化）；② 非交互分支的 **token + reason**（保证旁路**留痕**，
  挡的同样不是「能不能」，而是「能不能不留痕地」）。
- 审批的真实边界在别处：decision record 的 actor/hash 让事后追责成立（V10 的「谁自称就是谁」
  仍未解），以及 `MCP_WITHHELD` 把这两个动作挡在子代理的默认路径之外。
- **在这些之上声称「审批无法被自动化」不成立，不要写、也不要暗示。**

同步改了 `backend/src/lab/cli.ts` 的 `LAB_HELP`（`approve` 与 `token` 两处）与
`readme_for_agent.md` 第 37 行那句「CLI 层要求真实 TTY」。

### 门禁 `tests/unit/w10_delta_approval_wording.test.ts`（5 条）

措辞与行为各钉一半：措辞侧断言那句被证伪的话不再出现、新口径出现；行为侧断言
`isTTY=true` 分支的真正判据是**那句字面 `yes`**（`no` / 空 / `y` / `null` 全拒），
非交互分支未变。

```
$ bun test tests/unit/w10_delta_approval_wording.test.ts
 5 pass
 0 fail
 14 expect() calls
```

---

## 合计

| 项 | 门禁文件 | 条数 | 阴性对照 |
|---|---|---|---|
| δ-1 | `w10_delta_project_archive.test.ts` | 8 | ①指针跳转退回置 null → 2 red |
| δ-2 | `w10_delta_doctor.test.ts` | 7 | ④`probePorts` 丢 cliPorts → 2 red |
| δ-3 | `w10_delta_ops_text.test.ts` | 4 | ②端点改回 `/api/config/*` → 1 red；③退回裸 slice → 1 red |
| δ-4 | `w10_delta_chat_sync.test.ts` | 7 | ⑤超时不走句柄 → 1 red；⑥config 不接线 → 1 red |
| δ-5 | `w10_delta_approval_wording.test.ts` | 5 | （行为未改；措辞侧断言被证伪的那句话不再出现） |
| | **合计** | **31** | **6 组，全部实跑变红** |

---

## 全套（只跑一次，纪律要求）

第一次跑出 3 条红，全是本 lane 引起的，逐条修在 `67ce088`：

| 红 | 原因 | 处置 |
|---|---|---|
| `config_reader_parity` | 新增 `chatSyncMaxMs` 没登记读者 | 登记 `configuredChatSyncMaxMs` |
| `narrative_parity` 孤儿模块 | `chat_sync.ts` 在本分支上零生产调用方（接线那一行在收口专属的 `session.ts` 里） | 按「等接线」登记，写明**收口打上 diff 后必须删除本条**；`health.ts` 不登记——`doctor/index.ts` 已 import 它，它不是孤儿（登记反而被反向检查咬住） |
| `llms.txt` 幂等 | 新增配置项要重新生成 | `bun scripts/gen-llms-txt.ts` |

修完复跑：

```
$ bun test tests/unit
 2728 pass
 0 fail
 14453 expect() calls
Ran 2728 tests across 221 files. [158.17s]
```

## 收口清单（两条，都在收口专属文件里）

1. `backend/src/server/app.ts` — `/api/health` 加 `frontendBuilt`（diff 见上，3+/1-）。
   打上之后 δ-2 才真正闭合；`doctor` 这一侧已经全接好了，实例不报就显示「不知道」，不会坏。
2. `backend/src/server/routes/session.ts` — `POST /chat` 走 `runChatWithSyncDeadline()`（diff 见上，7+/2-）。
   打上之后**要删掉** `tests/unit/narrative_parity.test.ts` 里 `backend/src/server/chat_sync.ts`
   那条 `ALLOWED_ORPHANS` 登记（那条测试有反向检查，不删会红——这是故意的）。

## 没做 / 拿不准

- push 过程中一直被 reset，收尾时重试成功（远端 ref 已核对，见文首）。
- **足迹越界两处，都如实记在上面 δ-3 那段**：`backend/src/config/cli.ts` 与
  `backend/src/config/index.ts` 归 γ，本 lane 因为 δ-3（V163）与 δ-4（chatSyncMaxMs 注册）
  动了它们；改动都是加法，收口时若冲突以 γ 为准。
- **V156 方向③（断连即取消）没做**：需要客户端断开信号透传进 orchestrator，是收口专属文件的口子。
- **δ-1 的判据有个前提**：「归档后工作台默认打开的不是验收项目」只有把验收产物归档**干净**
  才成立，自动跳转本身保证不了——它只保证跳到一个还活着的项目。任务书的「跑完归档」一步就是补这个。
