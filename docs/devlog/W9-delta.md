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
