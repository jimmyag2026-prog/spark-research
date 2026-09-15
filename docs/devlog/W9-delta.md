# lane δ 开发日志（W9 · 门禁与小项）

分支 `feat/W9-delta`，基线 `integration/v0.9-base`（f921bf0）。
任务书 `docs/taskbooks/v0.9/LANE_delta.md`，证据来源 `docs/USAGE_LOG.md` U7 / U2 / U8。

**接手说明**：本 lane 的前一个子代理在 Anthropic API 通道反复 `Connection refused` 下被终止，
留下 wip commit `fb24396`（提交信息里自述「未经任何验证」）。本文档由接手代理续写，
凡沿用前一个代理的产物，均在下面标注「复核结论」。

---

## δ-1 · 集成套件不再「静默像通过」（U7）

### 先回答任务书的问题：fixture 已录好、回放不需要网络，为什么连回放都跳？

**答案：没有技术原因。这 8 条在 replay 下能跑、而且全绿。**
`describe.skipIf(!RECORDING)` 这道闸是「文件用途」带来的历史产物，不是「回放跑不了」的结果。

先把事实链摆清楚：

1. **闸的来源是文件定位，不是能力边界。** 三个文件的头部注释都写着自己是「录制脚本」
   （`本地录制：FIXTURE_MODE=record bun test tests/integration/...`）。作者的心智模型是
   「这个文件是用来重录 fixture 的」，于是顺手给整个 `describe` 加了 `skipIf(!RECORDING)`，
   让它在 CI 上不打网络。这一步在当时是对的——**但它把「不要打网络」写成了「不要执行」**。
   这两件事在 FixtureHttp 存在之后就已经不是同一件事了：`FixtureHttp` 在 `replay` 模式下
   零网络（`backend/src/http/fixture.ts` 的三档 `replay|record|live`），而这三个文件里
   **每一个** HTTP 客户端都是 `fixtureHttp(cassette, MODE)` 构造的，没有一处直连 `defaultHttp`。
   也就是说：把 `MODE` 留在 `replay` 而让 describe 执行，代码路径上根本不会产生一个 socket。

2. **cassette 齐全，四条都在仓库里。** `tests/fixtures/literature/{search-alphafold,fetch-by-id,pdf-download,aminer-search}.json`、
   `tests/fixtures/literature/novelty-check.json`、`tests/fixtures/proteins/protein-analysis.json` 全部存在且非空。
   录制端与回放端共用 `tests/helpers/{literature,ideation,protein}_scenario.ts` 的常量，
   fixture key 天然对得上——这正是 helper 文件头注释所强制的（「任何一个常量改了就必须重新录制」）。

3. **唯一一个「可能 miss」的疑点已排查干净。** `literature_record.test.ts` 的 AMiner 用例
   会 `new CredentialStore()` 读本机 `~/.spark-research/credentials.json`，走两条分支：
   无凭据 → 断言降级为 `credentials_missing`（纯本地，必然可回放）；
   有凭据 → 真的发 `paper/search` 请求。后者在 replay 下需要 cassette 命中，
   实测 `aminer-search.json` 里正好录了 1 条 `GET .../paper/search?page=1&size=3&title=AlphaFold → 200`，
   与用例里 `search({ query: "AlphaFold", size: 3 })` 的参数一致。**两条分支在 replay 下都成立**，
   所以这个用例不是「有凭据的机器上会红」的隐患。

### 阴性/阳性判据：真跑了一次

把三个文件的 `describe.skipIf(!RECORDING)` 临时改成无条件 `describe`（改法见下），
在**默认 replay**（不设 `FIXTURE_MODE`、不给任何凭据）下跑：

```
$ sed -i '' 's/describe\.skipIf(!RECORDING)/describe("FORCED-REPLAY-PROBE", () => {}); describe/' tests/integration/*.test.ts
$ FIXTURE_MODE=replay bun test tests/integration
...
[record] 检索 "AlphaFold protein structure prediction"
  openalex         ok       10 条 3ms
  crossref         ok       10 条 3ms
  europepmc        ok       10 条 3ms
  semanticscholar  skipped  0 条 3ms  连接器 'semanticscholar' 未配置凭据，已跳过该数据源
  合并后 30 条（原始 30，合并掉 0）
[record] PDF 下载
  ✅ arxiv 2048 字节 sha256:8add49da...
  ✅ europepmc 2048 字节 sha256:1ee73ccf...
[record] AMiner: 未配置凭据 → 验证降级路径

 8 pass
 0 fail
 11 expect() calls
Ran 8 tests across 3 files. [87.00ms]
```

**8 pass / 0 fail / 87ms / 零网络。** 所以按任务书 δ-1 ①「能跑就让它默认跑，这是根治」——默认跑。

> 顺带纠正一处前一个代理写下的结论。`fb24396` 落盘的 `scripts/check-integration-skip.ts`
> 头部注释断言「让它在 replay 下也跑只是把同一件事验两遍，是纯重复，CI 时间加倍换不来新覆盖」，
> 并据此**不做**根治、只做兜底。这个结论有一半是对的、结论是错的：
> `tests/unit/{literature,novelty,protein}_e2e.test.ts` 确实存在、确实共用同一批 cassette、
> 确实在 `bun test tests/unit` 里跑（这半是对的，我核过文件与 helper 引用）；
> 但**覆盖面并不重合**：`tests/integration` 里的 PDF 真实下载两篇（arXiv + Europe PMC 双 origin
> 回退链）、`fetchById` 跨四源、AMiner 连接器的 `credentials_missing` 降级这几条，
> 在 unit 侧的 `*_e2e.test.ts` 里没有等价用例。而「CI 时间加倍」的量级实测是 **87ms**。
> 更重要的是：任务书把「能跑就默认跑」定为根治，不是可选项。

### 做了什么

1. **根治**：三个文件去掉 `describe.skipIf(!RECORDING)`，默认（replay）就执行。
   `record`/`live` 仍然只由 `FIXTURE_MODE` 控制——那是 `fixtureHttp(cassette, MODE)` 一层的事，
   与「跑不跑」解耦。日志前缀从硬编码的 `[record]` 改成 `[${MODE}]`，replay 下不再谎称在录制。
2. **顶层 banner**（取代前一个代理写的「已整体跳过」提示，那句话在默认跑之后就不成立了）：
   `beforeAll` 按模式打一行，replay 下明说「回放录制响应，**不校验上游接口是否漂移**」，
   live/record 下说明在打真实网络。
3. **兜底门禁**：`scripts/check-integration-skip.ts` 包住 `bun test tests/integration`，
   「总数 > 0 且全部 skip」→ exit 1。根治之后这条路径平时不该触发，它是**绊线**：
   将来谁再加一道 `skipIf` 把整套关掉，`bun run test:integration` 会红，而不是又回到 `0 fail` 的绿灯剧场。
   真失败（bun 自己非零退出）原样透传，不被这层盖掉。
4. **CI**：`test:integration` 接进主 job（replay，零网络零凭据），并新增每周一次的
   `integration-live` job（`schedule: cron`，`FIXTURE_MODE=live`，`continue-on-error`），
   专抓 fixture 回放**永远发现不了**的上游接口漂移。同时改掉 `ci.yml` 顶部注释里
   「test:integration 恒定全 skip，纯粹的绿灯剧场，故意不接」那段——那段话的前提已经被本条消灭了。

### 阴性对照（真跑）

见本文档末尾「阴性对照汇总」。

---
## δ-2 · `doctor` 探运行实例（U2；已裁定探端口，不做 pid 文件）

新文件 `backend/src/doctor/running_instance.ts`，接进 `DoctorReport.runningInstances`（可选字段，
与 `segmenter` 同一个理由：`tests/unit/doctor.test.ts` 手写了几份 `DoctorReport` 字面量喂给
`renderDoctor()`，那个文件不在本 lane 足迹内，不强改它）。`--json` 自动带上。

四种判定，各给具体的下一步：

| verdict | 什么情况 | 下一步 |
|---|---|---|
| `match` | 版本一致、工作目录还在 | 无 |
| `version_mismatch` | 是我们的 server，版本对不上 | `kill <pid>` 后重起 |
| `orphan_cwd` | 工作目录已不存在（U2 现场） | 说明它靠已打开的 inode 在跑、与当前 checkout 共用数据目录，`kill <pid>` |
| `foreign` | 端口被别的服务占着 | 让出端口或换端口——**不建议 kill 别人的进程**，也不去 lsof 探它 |

三层判据逐层降级：HTTP health → 版本比对 → `lsof` 取 pid / `ps -o args=,lstart=` 取命令行与启动时间 /
`lsof -Fn -a -p <pid> -d cwd` 取工作目录。任一层拿不到就降级（例如精简容器里没有 `lsof`
→ 只比版本，并把「为什么没拿到」放进 `degraded` 字段），**绝不因为拿不到就整段不报**。

### 撞出来的一个真问题：`fetch` 会把 `127.0.0.1` 也送进代理

第一版用 `fetch("http://127.0.0.1:4321/api/health")`。在本轮的开发沙箱里它**恒定超时**，
doctor 于是报「这几个端口上没有在跑的实例」——而 `lsof` 明明能看到 pid 8298 在监听。
查下来是 `http_proxy` / `https_proxy` / `all_proxy` 三个环境变量：`fetch` 一律照读，对回环地址也不例外，
而这个环境没有设 `no_proxy`。

```
$ env | grep -i proxy
all_proxy=socks5://127.0.0.1:11080
http_proxy=http://127.0.0.1:11081
https_proxy=http://127.0.0.1:11081

# 同一台机器、4321 上真有实例在跑：
fetch 默认            → The operation timed out.
fetch + proxy:""      → The operation timed out.
Bun.connect 裸 TCP    → {"status":"ok","service":"spark-research","version":"0.8.0"}
```

这不是沙箱特有的：公司网络、VPN 客户端、各种代理工具都会设这几个变量。**一个诊断工具在这种环境下
给假阴性，比不诊断更糟**——而且这恰恰就是 U2 那个实例能活两天没被发现的同一类失效（没有任何机制会告诉你）。
所以改成 `Bun.connect` 裸 TCP + 手写一个 `Connection: close` 的 HTTP/1.1 GET，只对回环地址这么做。

### 真机验证

在本 worktree 起一个实例，`doctor` 的输出：

```
▎运行实例（探端口 4321）
  ✅:4321    版本一致（v0.8.0）
      pid 8298 · 启动于 Tue Sep 15 10:56:02 2026
      bun backend/src/index.ts server 4321
      cwd /Users/jimmyclaw/Desktop/AI4S/spark-research-delta
```

没有实例时：

```
▎运行实例（探端口 4321）
  · 这几个端口上没有在跑的实例
      注意：探端口只看得见这几个端口。`spark-research server <别的端口>` 起的实例这里看不到。
```

第二行是刻意的。探端口方案的代价就是**只能探已知端口**（这是裁定时就认下的），
那就得把盲区说出来，而不是笼统报一句「没有实例」让人以为已经查干净了。

`config` 里目前**没有** `serverPort` 这个设置项（`CONFIG_SETTINGS` 里查过，不存在），
所以 `probePorts()` 默认只出 `[4321]`；真加了这一项时它会自动被并进来（字符串形态也认，垃圾值忽略）。

测试 `tests/unit/doctor_running_instance.test.ts`（10 条）：health 探测这一层**起真的 `Bun.serve`**
而不是 mock——探测走的是裸 TCP + 手写 HTTP/1.1，只有对着真服务端才谈得上验证；`lsof`/`ps` 那层反过来
必须注入，真跑会把用例绑死在 runner 的权限与工具链上。端口一律 `port: 0` 让内核挑，不撞开发机上真在跑的 4321。

---

## δ-4 · 删重复启动日志（U8）· 收口 diff

`backend/src/index.ts` 是禁止文件，diff 交收口。**已临时应用验证过**（`bun run typecheck` 干净 +
真起一次 server 确认日志只剩一份），验完 `git checkout --` 还原，未提交。

```diff
--- a/backend/src/index.ts
+++ b/backend/src/index.ts
@@ -685,9 +685,9 @@
-      const server = startServer(port);
-      console.log(`Spark Research server listening at http://127.0.0.1:${server.port}`);
-      console.log("Press Ctrl+C to stop");
+      // U8：启动日志只由 startServer() 打一份。原来这里还手写了一份副本，
+      // 且硬编码 127.0.0.1（startServer 用的是真实 url），将来支持绑别的地址时会打错地址。
+      startServer(port);
       break;
```

注意 `const server =` 也要一起去掉：两行 `console.log` 删掉之后 `server` 就没有读者了。

应用前（真实输出，U8 现场）：

```
Spark Research server listening at http://127.0.0.1:4321
Press Ctrl+C to stop
Spark Research server listening at http://127.0.0.1:4321
Press Ctrl+C to stop
```

应用后：

```
⚠️  工作台前端尚未构建，Web UI 不可用（API 正常）。先跑一次：bun run build:web
Spark Research server listening at http://127.0.0.1:4399
Press Ctrl+C to stop
```

---

## δ-5 · `records_write_race` 偶发 `database is locked`（V120）· **未复现，未改代码**

先看现状：`backend/src/project/records.ts:233-236` 已经是

```ts
this.db = new Database(dbPath);
// V80：busy_timeout 必须在 journal_mode 之前——切 WAL 本身也要拿锁，否则并发首开就可能 SQLITE_BUSY。
this.db.exec("PRAGMA busy_timeout = 5000;");
this.db.exec("PRAGMA journal_mode = WAL;");
```

`busy_timeout` 设了、WAL 开了，而且 13 处写事务全部走 `tx.immediate()`（V80 的真因修法：
DEFERRED 事务在「读→写升级」时后来者立即拿到 SQLITE_BUSY，`busy_timeout` 不起作用）。
任务书交代的三处检查点因此都已经是对的。

**复现尝试（两轮，共 110 次，0 复现）：**

| 轮次 | 方式 | 结果 |
|---|---|---|
| 1 | `bun test tests/concurrency/records_write_race.test.ts` 串行循环 50 次 | 失败 0 次；50 份日志里 `database is locked` 出现 0 次 |
| 2 | 每轮 6 个测试进程并发 × 10 轮 = 60 次（模拟多 lane 并行时的机器负载，alpha.2 观察到它的条件） | 60 份日志全部 `1 pass / 0 fail`；`database is locked` 出现 0 次 |

（第 2 轮的 shell 循环里 `wait` 在 zsh 下报了 `job not found`，那个「失败 10 次」是 shell 的假象；
按日志逐份核对：60 份全绿。）

**结论：50 次 0 复现，加压 60 次仍 0 复现，未改代码。** 按任务书「复现不了就如实写，本条结束」。
合理推断是 V120 记录的现象已被 V80 那次修法根治（alpha.2 的观察早于 V80），但我**没有**证据能证明
这一点——没能复现只能说明「在这台机器、这个负载下没再出现」，不等于「不存在」。
真要钉死，得拿到 alpha.2 当时的失败日志，或者构造一个能稳定复现的场景，两者本轮都没有。
所以这条不该被当成「已修复」销号，应保留在 BACKLOG 里并标注本轮的复现尝试与结论。

---

## V62 · `tests/e2e/tsconfig.json` 类型错误清零

初始 47 个错误（任务书写的「约 45 个」）。**一行测试代码都没改**——
47 个错误没有一个在 `tests/e2e/*.ts` 里，全部落在被 `fixture_server.ts` 传递引入的 `backend/src/**` 上。
根因是这份 tsconfig 与根 tsconfig 的配置差异，所以修法全在 tsconfig 里。

最终配置改了四处。**逐处单独从最终配置里拿掉**，看各自扛着多少个错误（真跑）：

| 改动 | 单独拿掉后的错误数 | 它在挡什么 |
|---|---|---|
| `include` 加 `../../backend/src/assets/assets.d.ts` | **42** | 那份 ambient 声明（V27 的产物）是 `*.sql` / `*.py` / `*.md` 静态资产 import 的唯一类型来源。原 `include` 只有 `"**/*.ts"`，相对 `tests/e2e/` 解析，够不到它 |
| `allowImportingTsExtensions: true` | **3** | `backend/src/reviewer/agent.ts` 里三处带 `.ts` 扩展名的 import（TS5097）。根 tsconfig 有这一项 |
| `lib` 加 `DOM.AsyncIterable` | **2** | `lib` 含 `DOM`（playwright `page.evaluate` 需要）会用 DOM 版 `ReadableStream` 盖掉 Bun 版，而 DOM 版没有 `[Symbol.asyncIterator]`（TS2504，`kernels/manager.ts` 两处） |
| `types: ["node"]` → `["bun"]` | **0** | 见下面的更正 |

42 + 3 + 2 = 47，正好对上初始错误数。

**更正一处我自己先前的说法。** 这一步的 commit 信息里写「`types: [node] → [bun]` 消掉 3 个错误」——
那是按我当时的施加顺序说的（那一步同时改了 `types` 与 `allowImportingTsExtensions`，两者合计 -3）。
拿最终配置做单项剔除才看得准：**扛住那 3 个的是 `allowImportingTsExtensions`，`types` 这一项是冗余的**
（单独改回 `["node"]`，错误数仍是 0）。

那还留着 `["bun"]` 吗？留。理由不是错误数，是**别依赖偶然**：这是个 Bun 代码库，
`Bun.spawn` / `Bun.serve` / `bun:sqlite` 的类型在 `types: ["node"]` 下居然也能解析，
说明 bun 的类型是从某条非显式路径被带进来的——依赖这种偶然解析，
哪天依赖树一变就会冒出一批文不对题的错误。根 tsconfig 写的就是 `["bun"]`，对齐它。
这个取舍如实写在这里，不假装它是必需的。

最后把 `tsc --noEmit -p tests/e2e/tsconfig.json` 接进了 `bun run typecheck`（package.json 那一行）。

---

## δ-6 · `docs/DEVELOPMENT_PLAN_v0.8.1.md`

任务书让我「事后补记」。动手前先查了一句：

```
$ git log --all --oneline -- docs/DEVELOPMENT_PLAN_v0.8.1.md
3e00f4a docs: register V148 (test:sdk order-dependent failures) + update H-8/H-6 status
c8eda4d docs: translate planning/backlog to English; add v0.8.1 remediation plan
```

**这份文件一直存在**，写于 2026-09-13，只是落在分支 `docs/v0.8.1-plan-and-english-i18n` 上从没合进 main。
所以没有补记，直接把原件恢复过来（逐字取自 `3e00f4a`，正文未删改），
只在顶部加 provenance 说明、文末追加一节「合入事实核对」。

重写会比恢复差在哪，很具体：原件 H-6（V139）那一整段是「查了 `raw/sink.ts`，
发现 `append()` 的同步语义是文件头注释里的刻意设计、而每次 append 重读尾部哈希正是 V91 对多进程
哈希链损坏的修法——所以原方案里提的两个缓解都是错的，决定不修」。这种「调查了、有结论、决定不动」
的判断，光看六条提交信息**推不出来**（它根本没有对应的 commit），照着提交信息补记必然把它写丢。

追加的一节做了两件事：

1. 八行 → 六个合入 commit 的 SHA 对照 + 每条的阴性对照落在哪个测试文件（路径逐个确认存在于基线）。
   顺带对上了：六个 commit 覆盖 H-1…H-5、H-7、H-8；H-6 没有 commit，因为它就是「决定不修」那条。
2. **报一个撞号**（见下）。

### V143–V146 撞号（需要收口拍板）

这份计划在 §3/§4 把外部评审的条目登记为 V143–V147；与此同时闸门 I 的盘点在 main 上**独立地**
把另外四条登记成了 V143–V146。两边都从 V143 往后编号：

| 号 | v0.8.1 计划（2026-09-13） | 今天的 `docs/BACKLOG.md`（闸门 I 盘点，2026-09-14） |
|---|---|---|
| V142 | orchestrator 死代码的处置决定 | CI 自 v0.8.0 起就是红的 |
| V143 | AD-12 门禁升级到符号级 | `ProviderCapabilities` 三个布尔无人消费 |
| V144 | `ControlRepl` 不是沙箱 | `WetLabLoop.execute(options.note)` 从未读（← 本轮 lane δ 修的就是这条） |
| V145 | `Host` 头未校验 | `OrchestratorAgent.chat(req.model)` 主路径丢弃 |
| V146 | 湿实验安全闸跨句覆盖缺口 | 闸门 I 形状② 的扫描面边界 |

根因就是「文档停在未合分支上」这件事本身——`BACKLOG.md` 看不到它占掉的号段。
**lane δ 不自行改号**：改号要动 `docs/BACKLOG.md`（收口文件）和一串引用了这些号的提交信息与注释，
得由收口统一决定给哪一侧重编号。这里只把事实摆出来。

---

## V144 · `WetLabLoop.execute(options.note)`（闸门 I 盘点划给本 lane）

这条是上一个代理（`fb24396`，自述「未经任何验证」）写的，本轮**复核并实跑验证**，结论是可以沿用：

- `execute()` 本身不产出 observation record，note 先落进 collect 态 meta 的新字段 `executionNote`；
  `analyze()` 没有自己的 note 时回落读它，最终写进 observation 的正文与 `metadata.note`。
  优先级是 analyze 的 note > execute 的 note，这个顺序有专门的用例钉住。
- `tests/unit/gate_i_param_readers.test.ts` 的 `GATE_I_ALLOWLIST` 里那条
  `lab/wet_loop.ts::WetLabLoop.execute::options.note` **已被删除**（核对过 diff）；
  留着不删会被陈旧检查判红。
- `tests/unit/wet_execute_note.test.ts`（3 条）+ `gate_i_param_readers.test.ts`：实跑 **7 pass / 0 fail**。

---

## 阴性对照汇总（全部真跑）

| # | 条目 | 改法 | 结果 |
|---|---|---|---|
| A | δ-1 | 把 `describe.skipIf(!RECORDING)` 加回三个集成文件（模拟有人重新关掉整套） | `bun run test:integration` **退出码 1**（输出 `0 pass / 8 skip / 0 fail` + 绊线报错）；还原后退出码 0 ✅ |
| B | δ-1 | `decideExitCode` 里「全 skip → return 1」改成 `return 0` | `integration_skip_gate` **红**：`① 全部跳过 → 退出 1` 失败（6 pass / 1 fail） |
| C | δ-1 | 「零收集 → return 1」改成 `return 0` | `integration_skip_gate` **红**：`② 一个用例都没收集到 → 退出 1` 失败（6 pass / 1 fail） |
| D | δ-2 | 版本比对 `version === currentVersion` 改成恒 `true` | `doctor_running_instance` **红** 2 条：`版本不一致 → version_mismatch`、`拿不到进程信息时降级`（8 pass / 2 fail） |
| E | δ-2 | cwd 存在性检查改成恒 `true`（拆掉孤儿判定） | `doctor_running_instance` **红**：`U2 现场：工作目录已不存在 → orphan_cwd`（9 pass / 1 fail） |
| F | V62 | 从 e2e `include` 里去掉 `assets.d.ts` | `tsc -p tests/e2e` **42 个错误** |
| G | V62 | `types` 改回 `["node"]` | **0 个错误**——所以这一项是冗余的（见 V62 那节的更正） |
| H | V62 | `lib` 去掉 `DOM.AsyncIterable` | `tsc -p tests/e2e` **2 个错误**（TS2504） |
| I | V62 | 去掉 `allowImportingTsExtensions` | `tsc -p tests/e2e` **3 个错误**（TS5097） |
| — | δ-5 | 不适用：没复现出问题，也就没有「把修复拆掉」可拆 | 见 δ-5 那节的 110 次复现记录 |

每一条对照跑完都 `git checkout --` 还原并复跑确认回到绿。

> 教训记一笔：做对照 C 时我用 `git checkout -- scripts/check-integration-skip.ts` 还原，
> 把那个文件上**尚未提交**的改动一起抹了（它当时只提交过上一个代理的版本）。
> 重写了一遍。**对照之前先 commit**——这条纪律本轮是花代价学的。

---

## 六套件数字（本 worktree 实跑）

⚠️ 全部命令都加了 `env -u http_proxy -u https_proxy -u all_proxy`。不加的话
`bun test tests/unit` 是 **2340 pass / 164 fail**——那 164 条全是测试里 `fetch("http://127.0.0.1:…")`
被沙箱代理劫持（503 / 超时）导致的，与本 lane 的改动无关（δ-2 撞到的是同一个东西）。
去掉代理变量后 0 fail。这一点写在这里，免得收口复跑时按错的环境对数字。

| 套件 | 命令 | 结果 |
|---|---|---|
| typecheck | `bun run typecheck` | ✅ 0 错误（**含新接入的 `tests/e2e/tsconfig.json`**） |
| 单测 | `bun test tests/unit` | **2504 pass / 0 fail**，12689 expect，199 文件，169.46s |
| 并发 | `bun run test:concurrency` | **33 pass / 0 fail**，1658 expect，10 文件，5.82s |
| 超时 | `bun run test:timeout` | **4 pass / 0 fail**，23 expect，4 文件，1.31s |
| 实验室 | `bun run test:lab` | **26 passed**，3.43s |
| e2e | `bun run test:e2e` | **25 passed**，21.0s |
| （加跑）集成 | `bun run test:integration` | **8 pass / 0 fail**，85ms，退出码 0 —— δ-1 之前这里是 `0 pass / 8 skip` |

无 skip、无并行超时重跑。
