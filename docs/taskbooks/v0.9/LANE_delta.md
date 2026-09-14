# lane δ · 门禁与小项（U7 / U2 / U8 / V120 / V62 / δ-6）— worktree `~/Desktop/AI4S/spark-research-delta`，分支 `feat/W9-delta`

先读 `_COMMON.md` 逐条遵守，再读 `docs/USAGE_LOG.md` 的 **U7 / U2 / U8** 证据段。基线 `v0.9.0-alpha.1`。这条 lane 是最容易被砍尾的（§七砍尾顺序：δ-6 · δ-5 · V62 先砍），**所以按下面的顺序做，前两条最重要**。

## 六件事（各一个 commit，按序）

### δ-1 · 集成套件不再「静默像通过」（U7）
现状：`tests/integration/*.test.ts` 三个文件顶层 `describe.skipIf(!RECORDING)`，默认 `FIXTURE_MODE=replay` → `0 pass / 8 skip / 0 fail`，27ms 跑完，读起来是绿的。
交付：① **先回答一个问题并写进 devlog**：fixture 已录好、回放不需要网络，为什么连回放都跳？读 `backend/src/http/fixture.ts:74` 与三个测试文件，判断「回放模式下这 8 条能不能跑」。**能跑就让它默认跑**（只在 `record`/`live` 时才需要开关），这是根治；**不能跑要写清为什么**（例如 fixture 里没有对应 key），退回②。② 兜底：跳过时在 `beforeAll` 打一行显著提示 `⚠️ 集成套件已整体跳过（FIXTURE_MODE=replay）——文献/创新性/蛋白三条链路本轮未验证`，并在 `package.json` 的 `test:integration` 后接一个检查脚本：若 skip 数 == 总数则 **exit 1**，让「全跳过」在 CI 里是红的。③ `.github/workflows/ci.yml` 加一个每周一次的 job `integration-live`（`schedule: cron`），`FIXTURE_MODE=live` 跑，失败只告警不阻塞主 CI（上游接口漂移的探针）。
测试：`tests/unit/integration_skip_gate.test.ts`——模拟「全 skip」输出 → 检查脚本退出码 1；「有 pass」→ 0。

### δ-2 · `doctor` 探运行实例（U2；已裁定探端口，不做 pid 文件）
现状：alpha.3 孤儿 server 存活两天、工作树已删、`doctor` 查不到。
交付：`doctor` 加一档「运行实例」：对 `[4321, config 里 serverPort 若有]` 逐个 `GET http://127.0.0.1:<p>/api/health`（超时 1s），拿到 `version` 与本 checkout 的 `version.ts` 比对；再 `lsof -nP -iTCP:<p> -sTCP:LISTEN -t` 取 pid，`ps -o args=,lstart= -p` 取命令行与启动时间，`lsof -a -p <pid> -d cwd` 取 cwd 并检查目录是否仍存在。输出三种：✅ 一致 / ⚠️ 版本不一致（给出「kill <pid> 后重起」下一步）/ ⚠️ 工作目录已不存在（孤儿）。**macOS 与 Linux 都要能跑**（lsof 两边都有；`ps` 参数注意兼容），拿不到就降级为「只比版本」并说明。`doctor --json` 同步加字段。
测试 `tests/unit/doctor_running_instance.test.ts`：起一个假 health server 返回不同版本 → 报不一致；不起 → 报「无运行实例」。

### δ-4 · 删重复启动日志（U8）
`backend/src/index.ts:686-687` 与 `server/server.ts:26-27` 各打一份，前者硬编码 `127.0.0.1`。**收口 diff**：删 index.ts 那两行。你在 devlog 里贴 diff 即可，一分钟的事，但要有。

### δ-5 · `records_write_race` 偶发 `database is locked`（V120）
现状：alpha.2 收口观察到偶发，未根治。
交付：先复现——`tests/concurrency/` 里现有 `records_write_race` 用例循环跑 50 次，记失败率写进 devlog。**复现不了就如实写「50 次 0 复现，未改代码」，本条结束**。复现了：看 `backend/src/records/` 的 SQLite 打开参数（`busy_timeout` 是否设置、是否 `PRAGMA journal_mode=WAL`），最小改动优先；改完再跑 50 次。
**不要**为了修它重构 records 层。

### V62 · `tests/e2e/tsconfig.json` 约 45 个既有类型错误
交付：让 `tsc --noEmit -p tests/e2e/tsconfig.json` 干净，并把它加进 `bun run typecheck`。只修类型，不改测试语义；改了语义的地方在 devlog 里逐条列。

### δ-6 · 补 `docs/DEVELOPMENT_PLAN_v0.8.1.md`
V137 的提交信息引用了它，仓库里没有。写一页：闸门 H 六条（V134–V141）各一行「问题 / 修法 / 阴性对照在哪个测试」，来源 = 各提交信息 + PR #109 正文。**不要编造当时没有的规划过程**——开头写明「本文为事后补记，依据提交信息与 PR #109」。

## 足迹
- 允许：`tests/integration/*.test.ts` · `scripts/check-integration-skip.ts`（新）· `package.json`（只改 `test:integration` 与 `typecheck` 两行）· `.github/workflows/ci.yml` · `backend/src/doctor/*.ts` · `backend/src/records/**` · `tests/concurrency/**` · `tests/e2e/tsconfig.json` · `tests/e2e/*.ts`（只修类型）· `docs/DEVELOPMENT_PLAN_v0.8.1.md`（新）· 两个新测试文件 · `docs/devlog/W9-delta.md`
- 禁止：`backend/src/index.ts`（δ-4 交 diff）· `backend/src/http/fixture.ts`（只读，要改就交 diff 并说明）· `frontend/**`（γ 的）

## 阴性对照
- δ-1：检查脚本里把「全 skip → exit 1」改成 exit 0 → `integration_skip_gate` 红。
- δ-2：版本比对改成恒等 → 「不同版本报不一致」测试红。
- δ-5：若改了 `busy_timeout`，改回 0 → 50 次循环里失败率回升（贴数字）。

## 追加（闸门 I 盘点后由主会话填写）
（空）
