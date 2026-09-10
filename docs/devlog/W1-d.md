# W1-d · 打包与分发（P14 · B-a）

> 分支 `feat/W1-d` · 2026-09-10 · v0.4.0 W1 波次
> 范围真源：`docs/DEVELOPMENT_PLAN_v0.4.md` §4.4（P14 设计）+ §5·补.2（W1-d 任务定义）
> 文件所有权：`package.json`（scripts/bin/files 段）· `scripts/**` · `backend/src/index.ts`（零参数行为 + doctor 命令）·
> `backend/src/doctor/**`（新建）· `tests/unit/doctor.test.ts` · `tests/unit/cli_entry.test.ts` · `docs/INSTALL.md` · 本文件

---

## 0. 一句话结论

`spark-research doctor` 做出来了，且用真探测（不是硬编码）区分 core/science/lab 三档，缺什么给可直接复制的修复命令。零参数路径从"一句话 + help"扩成"当前状态 + 下一步"，不抢 W2-d 的向导设计。npm/`npx` 路径（`bun backend/src/index.ts ...`）经实测**端到端可用**——这是目前唯一真正能跑通完整研究流程的分发形态。

**单二进制（`bun build --compile`）产物本身有严重限制，必须诚实报告**：我在本 lane 修了一个由此暴露的真 bug（`index.ts` 的 `pkg.version` 读取方式在编译产物里会炸），但同一个 bug 模式**在仓库另外 17 个文件的 23 处**也存在（`backend/src/version.ts` 是其中一处，由主会话独立复验时发现并修复；其余登记为 BACKLOG V27，本 lane 未修，也不在本 lane 文件所有权范围内）。**编译产物目前只有 `--version`/`--help`/`capabilities`（读，非探测）/`doctor` 这类浅层命令可用，`project new`/`idea`/`exp`/`lab` 这些依赖 `.sql`/`.py` 资源文件的命令会直接 ENOENT。**

npm meta 包的 `package.json` 打磨（`files` 字段、`prepublishOnly` 之类）**没做完**——主会话中途把本 lane 剩余范围收窄成"只补文档"，这部分诚实记为未完成项，不是被我漏掉。

六道门：typecheck 干净、unit **1042 pass / 0 fail / 0 skip**（基线 1018 + 24 新增）、concurrency+timeout 12/12、**e2e 13/13**、pytest 48（含 lab 子集 26）全绿、两次阴性对照真实跑过且终端输出记在 §5。

---

## 1. 交付物与状态

| # | 交付物 | 状态 | 说明 |
|---|--------|------|------|
| 1 | 单二进制 `bun build --compile` | ⚠️ 部分 | 产物能跑，但只有浅层命令；见 §2、§4 |
| 2 | npm 包 / `npx` 路径 | ⚠️ 部分 | 运行时验证通过（`bin` 指向 `.ts`，bun 直接跑），但 `files`/发布前打磨未完成 |
| 3 | 依赖分层（core/science/lab） | ✅ | 运行时探测，不动 `pyproject.toml`；见 §3 |
| 4 | `spark-research doctor` | ✅ | 见 §4 |
| 5 | 零参数行为 | ✅ | 见 §6 |
| 6 | `--version`/`-v` | ✅ | 之前完全没有这个 case（新增） |
| 7 | `docs/INSTALL.md` | ✅ | 三条安装路径 + 依赖分层表 + 已知限制 |

---

## 2. 单二进制：实测数据

```
$ bun build backend/src/index.ts --compile --outfile dist/spark-research
  [50-54ms]  bundle  349 modules
  [213-330ms] compile  dist/spark-research
```

- **构建耗时**：bundle ~50ms + compile ~250ms，总计约 300ms（不含 `build:web` 的前端构建，那部分独立约 440ms）。快到可以直接进 CI 当冒烟测试（见 §7 V28）。
- **产物大小**：64,750,562 字节（**62M**），Mach-O 64-bit arm64 可执行文件。体积主要是 bun 运行时本身，不随代码量线性增长。
- **不入 git**：`.gitignore` 已有 `dist/`，覆盖 `build` 脚本的默认产物路径 `dist/spark-research`，本 lane 未新增条目。

### 2.1 三条必测路径的实际输出（本 lane 交付时）

```
$ /tmp/spark-research-final-bin --version
0.3.1

$ /tmp/spark-research-final-bin --help | head -3
Spark Research v0.3.1
开源科学 Agent 平台：干湿闭环 + 自动化实验室

$ /tmp/spark-research-final-bin capabilities --json | head -4
{
  "service": "spark-research",
  "version": "0.0.0",
  "probed": false,
```

`--version` 和 `--help` 都正确显示 `0.3.1`（本 lane 修的那处）；`capabilities --json` 的 `version` 字段却是 `0.0.0`——同一个二进制里两个不同的版本号读法，见 §5.2。

### 2.2 深层命令在编译产物里的真实状态

```
$ SPARK_RESEARCH_DATA_DIR=/tmp/x /tmp/spark-research-final-bin project new demo
❌ ENOENT: no such file or directory, open '/$bunfs/root/schema.sql'

$ SPARK_PYTHON=<repo>/.venv/bin/python /tmp/spark-research-final-bin doctor --json
...
"lab": {
  "available": false,
  "reason": "opentrons 模拟器不可用 ... can't open file '/$bunfs/root/opentrons_backend.py' ..."
}
```

有意思的一点：**同一次 `doctor` 调用里 science 档（openmm）能探测成功，lab 档（opentrons）不能**——原因是 `OpenMMPlatform.probeCode()` 是一段内联的 `python -c "..."` 字符串（不依赖磁盘上的 `.py` 文件），而 opentrons 的探测要 `Bun.spawn([python, BACKEND_SCRIPT, "--probe"])`，`BACKEND_SCRIPT` 是 `join(import.meta.dir, "opentrons_backend.py")`——编译产物里 `import.meta.dir` 是虚拟路径 `/$bunfs/root/`，这个文件从来没有被搬到真实磁盘上过。这个细节直接指向 §5 的根因和 V27 的范围判断。

**结论**：单二进制目前**不适合**作为主推的分发形态，`docs/INSTALL.md` 已经把这条路径标成"实验性/仅浅层命令"，主推 npm/`npx`（§1 交付物 2）和源码克隆两条路径。

---

## 3. 依赖分层：为什么没动 `pyproject.toml`

### 3.1 先查清楚（任务书要求的"先查清楚再改"）

用仓库自带的 `.venv`（3.12）读了一遍 `pyproject.toml`：

```python
>>> import tomllib
>>> data = tomllib.load(open("pyproject.toml", "rb"))
>>> list(data.keys())
['project', 'tool', 'dependencies']
>>> list(data['project'].keys())
['name', 'version', 'description', 'requires-python', 'license']
>>> 'dependencies' in data
True
>>> data['dependencies']
{'numpy': '>=1.26', 'pandas': '>=2.0', 'jupyter-client': '>=8.0', 'ipykernel': '>=6.29',
 'rdkit': '>=2023.9', 'openmm': '>=8.1', 'opentrons': '>=9.0', 'pytest': '>=8.0'}
```

确认了任务书的猜测：`[dependencies]` 是一个**与 `[project]` 平级的独立顶层 table**，不是 PEP 621 要求的 `[project] dependencies = [...]` 数组。`[project]` 本身没有 `dependencies` 键。另外仓库也**没有 `[build-system]` table**——`[tool.uv] package = true` 意味着 uv 会把它当成一个要构建的包，但没声明构建后端，`uv sync` 大概率会在"选构建后端"这一步就出问题，而不仅仅是"读不到依赖"。

两个问题叠在一起，`uv sync` 的失败模式很可能是"选默认构建后端时报错"而不是"装出一个零依赖环境"——具体哪种要实测 `uv sync` 才能确认，但**我没有跑**，理由见下一节。

### 3.2 为什么不修

1. **文件所有权不含 `pyproject.toml`**——任务书的"只改这些"清单是穷举式的，这份文件不在里面。就算判断风险很低，越权也是越权。
2. **跑 `uv sync` 本身有真实风险**：这个 worktree 的 `.venv` 是指向主仓 `.venv` 的**符号链接**（`git worktree` 的已知坑，任务书也点名了），`uv sync` 一旦真的执行写操作，动的是**共享给 W1-a/b/c 和主仓的同一份环境**，不是这条 lane 私有的。别的 lane 可能正并发在用它跑 Python 测试。这不是"改不改一个文件"的风险，是"跨 lane 环境爆炸半径"的风险，跟单一文件所有权比起来更不该在没有协调的情况下动。
3. **就算真的是 PEP 621 形态问题，修复方案也不止一种**（挪进 `[project.dependencies]` 数组、还是拆 `[project.optional-dependencies]` 三档、还是继续用 `[tool.uv]` 的其他机制），选哪种需要知道 v0.5 规划里 Python 依赖还会怎么长（比如 v0.5 workstreams 提到的新 connector 会不会引入新 Python 依赖），这是跨 lane、跨阶段的决策，不该由打包分发这条 lane 单方面拍板。

### 3.3 改用运行时分层

不问 `pyproject.toml` 声明了什么，直接问"这个 Python 解释器真的 `import` 得到这个包吗"——`backend/src/doctor/index.ts` 复用了 P5/P6 已经写好、且被 `capabilities --probe` 同样调用的探测器：

- **science**（openmm）：`SimulationRegistry.get("openmm").available()`（`backend/src/simulation/openmm/index.ts` 的 `probeCode()`，内联 `python -c` 探测，装没装、装了报什么版本、缺了给什么安装命令，全部复用现成实现）。
- **lab**（opentrons）：直接 `new OpentronsSimulatorBackend({ python }).available()`（`backend/src/lab/wet_backend.ts`）。`wetBackend()` 工厂函数不接受 `python` 覆盖参数，所以绕开工厂直接实例化类——这是本 lane 唯一"动了别的模块的实例化方式"的地方，但没有改那个模块的文件本身，只是从 doctor 这边换了个调用方式。
- **core**（文献/idea/novelty/记录/报告）：零 Python 依赖，`available` 恒为 `true`，不需要探测。

好处：判断口径和 `capabilities --probe` **完全一致**（同一份底层探测器），不会出现"doctor 说能用、capabilities 说不能用"这种两套真源打架的情况；`pyproject.toml` 将来无论怎么改，`doctor` 都不需要跟着改，因为它压根不读那个文件。

代价（诚实记录）：真机验证前，用户没法从 `pyproject.toml` 一眼看出装哪些包——`doctor` 的输出里已经把 `uv pip install openmm` / `VIRTUAL_ENV=.venv uv pip install opentrons` 这类具体命令打出来，等于把"文档"变成"运行时自解释"，但确实没有修那份声明性文档本身。

---

## 4. `spark-research doctor`

### 4.1 输出形态

`backend/src/doctor/index.ts` 导出 `buildDoctorReport(options): Promise<DoctorReport>`（纯函数，探测器/Python 解释器/前端目录/env 全部可注入，供测试用），`backend/src/doctor/cli.ts` 导出 `runDoctorCommand`/`renderDoctor`，跟 `capabilities` 模块同一套 DI 风格。

文本模式（默认）：

```
$ spark-research doctor
Spark Research v0.3.1 · doctor（2026-09-10T00:39:28.352Z）

▎运行时
  bun     1.3.14（darwin/arm64）
  ✅ python  <repo>/.venv/bin/python（Python 3.12.12）
  数据目录  /Users/jimmyclaw/.spark-research

▎依赖分层（core 零依赖 · science=openmm · lab=opentrons）
  ✅ core      文献 / idea / novelty / 记录 / 报告（零 Python 依赖，只需要 bun）
  ✅ science   干实验仿真（openmm）
  ✅ lab       湿实验模拟器（opentrons）

▎LLM Provider Key（6，只报已配置/未配置，值永不打印）
  🔑 openrouter  OPENROUTER_API_KEY
  · anthropic   ANTHROPIC_API_KEY（未配置）
  · deepseek    DEEPSEEK_API_KEY（未配置）
  ...

▎前端
  ❌ 未构建  /frontend/workspace/dist
      修复：bun run build:web
```

`--json` 模式给出同一份数据的机器可读版本（`tiers[].available`/`reason`、`providers[].configured`、`python.ok`/`version`/`error`、`frontendBuilt` 等字段），供脚本/agent 判断用，不必解析文本。

### 4.2 安全边界

`providers[].configured` 只报布尔值，`env`/`config.json` 里的真实 key 值不会出现在报告的任何字段里——`tests/unit/doctor.test.ts` 有一条专门测这个（把一个真实样例密钥字符串注入 env，断言 `JSON.stringify(report)` 里不包含它）。

### 4.3 三档判断口径

见 §3.3。值得强调一次：`doctor` 不会为了"看起来全绿"而简化判断——缺依赖就是 `available: false` + 具体 `reason`，`reason` 直接来自被探测适配器的原始报错（含安装命令），doctor 自己不重新编写一遍安装说明，避免两处文案漂移。

---

## 5. 单二进制的两个真 bug（含主会话独立复验的发现）

### 5.1 本 lane 发现并修复：`index.ts` 的 `pkg.version`

原实现：

```ts
const pkg = await Bun.file(join(import.meta.dir, "../../package.json")).json();
```

编译产物里 `import.meta.dir` 指向虚拟路径 `/$bunfs/root/`，`../../package.json` 拼出去之后落在真实文件系统的 `/package.json`——不存在，`ENOENT`，而且这行是模块顶层、**无 try/catch**，所以整个二进制的**任何命令**（`--help`/`--version`/`capabilities`/`doctor`……）在编译产物里全部炸，连 HELP 文本都打不出来。

用最小复现验证了修法：

```ts
// 能在 --compile 产物里工作
import pkg from "./pkg.json";
```

静态 `import` 是 Bun 打包器能分析到的引用，JSON 内容会被直接编译进二进制，运行期不需要真实文件系统。改成这个写法后 `dist/spark-research`（以及 `bun backend/src/index.ts` 的正常执行）两种模式都不再依赖运行期路径拼接。同时顺手补了完全缺失的 `--version`/`-v` case（之前落进 `default`，打印整份 HELP + `exitCode 1`，对脚本化探测很不友好）。

### 5.2 本 lane 遗漏、主会话独立复验时发现：`backend/src/version.ts`

`backend/src/version.ts` 的 `PACKAGE_VERSION`（`capabilities`/`doctor` 的 `version` 字段用的就是它，跟 `index.ts` 的 `pkg.version` 是**两个独立的读法**）用的是运行时 `readFileSync(join(import.meta.dir, "../../package.json"))`——同一个 bug 模式，只是包了 try/catch，所以编译产物里**不崩溃、但静默退化成 `"0.0.0"`**，比 `index.ts` 原来那个"直接崩"更隐蔽：命令能跑、能返回 200/exit 0，版本号却是假的。

**这个我在自己的验证里完全没测出来**——`--version`（走 `index.ts`）我测过且是对的（`0.3.1`），但没有交叉核对 `capabilities --json`/`doctor --json` 里独立的 `version` 字段是不是**同一个**版本号。主会话拿编译好的产物手工跑了这三条路径做独立复验，才抓到"同一个二进制报两个版本号"这个不一致。`version.ts` 不在本 lane 文件所有权范围内，我没有修；主会话已经修复（改成同款静态 import）并往 `tests/unit/narrative_parity.test.ts` 加了一条版本号一致性断言（该文件也不在本 lane 所有权范围内，改动由主会话完成）。

### 5.3 登记为 BACKLOG 的系统性问题：V27

主会话复验后确认，`import.meta.dir` 拼路径读资源文件这个模式**在仓库另外 17 个文件、23 处**出现——不只是版本号：

- `backend/src/lab/wet_backend.ts` 找 `opentrons_backend.py`（§2.2 已实测复现，lab 档探测在编译产物里必炸）
- `backend/src/simulation/**` 的其他适配器找 runner 脚本
- `backend/src/project/records.ts`、`backend/src/literature/library.ts`、`backend/src/artifacts/store.ts` 找各自的 `schema.sql`（§2.2 已实测复现，`project new` 在编译产物里直接 ENOENT——**这意味着连"core 零依赖"档位的功能，在编译产物这一种分发形态下也不可用**，"core 可用"这个结论只对 npm/源码这两条运行时路径成立）
- `backend/src/agents/**` 找 prompt `.txt`
- `backend/src/scaffold/**`、`backend/src/server/**`（找前端产物）

主会话已把这个登记为 **BACKLOG V27**，本 lane 没有修——一是不在文件所有权范围内（横跨 6+ 个模块，大半是别的 lane 在管），二是修法不止一种（`import x from "./f" with {type:"file"}` 只对"同进程内 `readFileSync` 读"有效；对 `.py` 这种要 spawn 外部进程指着真实路径读的场景，得改成"把内容 embed 成文本 + 运行时先 `writeFileSync` 到临时目录再 spawn"，两种资源类型的修法不一样，需要通盘设计而不是照抄一处）。

**留给后来人的教训**（按主会话的要求原话记录）：

> **二进制是另一个运行时，跑源码的测试证明不了产物能用。**

本 lane 的六道门全部在 `bun backend/src/index.ts`（源码直跑）和 `bun test`（同样是源码直跑）上完成，全绿；但编译产物是完全不同的资源解析路径，源码测试对它没有任何覆盖力。这不是"多测一下就能顺带发现"的问题——需要**专门针对编译产物的冒烟测试**（见 §7 V28）。

---

## 6. 零参数行为：选择与理由

方案 §4.4/P14 原话是"起 server + 开浏览器"，但那是**向导/demo**的形态（`docs/DEVELOPMENT_PLAN_v0.4.md` §5·补.2 把 B-b/B-c 明确记在 W2-d，不在 W1-d 任务书里）。

**判断**：一个刚 `npx spark-research` 装完、什么都没配置过的人，此刻最需要的不是被直接扔进一个还没配好 key 的 Web UI（配了 key 才有意义），而是**看清楚当前状态 + 该敲哪条命令**。如果这条 lane 抢先把"起 server"做成零参数行为，W2-d 真正做向导时会撞出两套"第一屏"设计——一套是我这里做的"状态 + 命令列表"，一套是 W2-d 要做的"向导 + demo"，谁覆盖谁、要不要合并，会变成 W2-d 启动时的额外协调成本。

所以本 lane 把零参数行为收窄成：

- **快**：不 spawn 子进程探测 Python/三档依赖（那是 `doctor` 的活，`doctor` 本身要 spawn 3 次子进程，肉眼可感的延迟），只做 `existsSync` 级别的廉价检查（前端是否构建）+ 读 env/config.json（API key 是否配置）。
- **不报错、不只是一句话**：之前是"版本号 + 一句 API 状态 + 一句『运行 help』"，现在是"当前状态（API key / Web 前端 / 数据目录三行）+ 下一步（按状态动态给 2-4 条具体命令，未配置 key 时把 `auth` 排第一条）"。
- **不抢向导设计**：不起 server、不开浏览器、不做任何需要用户后续交互确认的事——这些行为验证了在 `tests/unit/cli_entry.test.ts` 里有专门一条断言"输出不包含 `listening at http`"。

如果后续 W2-d 判断零参数就该直接起向导，这里的实现是纯函数（`welcome(options)`，全部依赖可注入），替换成本很低，不存在"推倒重来"的沉没成本。

---

## 7. 六道门 + 阴性对照

### 7.1 六道门（本 lane 交付时的真实数字）

| 门 | 结果 |
|---|---|
| `bun run typecheck` | 干净（两个 tsconfig 都过） |
| `bun test tests/unit/` | **1042 pass / 0 fail / 0 skip**（基线 1018 + 本 lane 新增 24：`doctor.test.ts` 12 + `cli_entry.test.ts` 12） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail（7 个文件） |
| `bun run test:e2e`（`SPARK_E2E_PORT=4414`） | **13/13 passed**（7.6s） |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed（`tests/lab/` 子集，与 v0.3.0 修过的"曾经空转"那个坑对照：这次真的收集到用例并跑了，不是静默 0 个） |

### 7.2 阴性对照①：doctor 谎报"可用"必须让测试变红

**手法**：往 `backend/src/doctor/index.ts` 的 `buildDoctorReport()` 里、`probeScience`/`probeLab` 拿到真实探测结果之后，硬编码 `science.ok = true; lab.ok = true;`（无视探测结果），模拟"实现偷懒/写错，谎报可用"的场景。

**实际终端输出**（`bun test tests/unit/doctor.test.ts tests/unit/cli_entry.test.ts`）：

```
error: expect(received).toBe(expected)
Expected: false
Received: true
      at .../tests/unit/doctor.test.ts:52:31
(fail) doctor · buildDoctorReport（注入假探测器） > science/lab 缺依赖时报 unavailable 并带 reason [2.32ms]

error: expect(received).toBe(expected)
Expected: false
Received: true
      at .../tests/unit/doctor.test.ts:154:31
(fail) doctor · 真实探测（阴性对照①的正样本） > 系统 python3（没装 openmm/opentrons）必须被真实判定为 unavailable，不是随便一个假值

 22 pass
 2 fail
 56 expect() calls
```

两条测试**恰好**是断言"缺依赖时必须报 unavailable"的那两条变红，其余 22 条（含跟 science/lab 状态无关的 provider key/前端产物检测）不受影响——说明测试的失败面精确对应被破坏的逻辑，不是误报。还原硬编码后重跑，24/24 恢复全绿。

### 7.3 阴性对照②：打包产物（前端）缺失时零参数路径不能报错/沉默

**手法**：往 `welcome()` 里，把 `out(\`    Web 前端  ${frontendBuilt ? ... : ...}\`)` 硬改成永远打印"已构建"（无视 `frontendBuilt` 参数），模拟"忘了处理缺失情况"的场景。

**实际终端输出**（`bun test tests/unit/cli_entry.test.ts`）：

```
error: expect(received).toContain(expected)
Expected to contain: "未构建"
Received: "\n  Spark Research v0.3.1\n  开源科学 Agent 平台 — 对标 Claude Science\n\n
  当前状态\n    API Key   未配置\n    Web 前端  已构建\n    数据目录  /x\n\n
  下一步\n    spark-research auth ...\n    spark-research doctor ...\n..."

(fail) welcome()（零参数引导，DI 单测） > 阴性对照②：打包产物（前端构建）缺失时不报错、
不沉默，明确标出状态并指向 doctor 拿修复命令

 11 pass
 1 fail
 27 expect() calls
```

只有断言"前端未构建时文案里要出现『未构建』"那一条变红，其余 11 条（含"不抛异常"那条——因为破坏后的实现依然不抛异常，只是内容错了）不受影响。还原后重跑，12/12 恢复全绿；随后又跑了一次 `tests/unit/doctor.test.ts + cli_entry.test.ts` 联合验证 24/24，确认两处还原互不干扰。

---

## 8. 未完成项（诚实记录）

1. **npm 包发布前的 `package.json` 打磨没做完**：`files` 字段、`engines`（声明需要 bun）、`prepublishOnly`（发布前确保 `frontend/workspace/dist` 已构建随包带上）都还没加。主会话中途把本 lane 收窄为"只补文档"，这部分留在 `docs/INSTALL.md` 的"发布步骤"一节里写成 TODO，不是被漏掉，是被明确挪出了本次交付范围。
2. **单二进制的深层命令不可用**（§2.2、§5.3，BACKLOG V27）：修复需要跨越至少 6 个不在本 lane 所有权范围内的模块，且两类资源（同进程读的 `.sql`、外部子进程读的 `.py`）修法不同，需要专门立项。
3. **没有针对编译产物的自动化冒烟测试**（BACKLOG V28，见下）——本次的 §2/§5 全部是手工跑二进制验证的，没有进 CI。
4. **brew 分发没有做**：任务书原文列出的是"单二进制/npm meta 包/brew"三选项，本 lane 收到的具体任务清单（见任务书"任务"一节）只要求 1/2/3/4/5 五项，没有 brew，判断为超出本次范围，未做。

---

## 9. BACKLOG 现状（据主会话反馈整理，供后续 lane 参考）

- **V27**：`import.meta.dir` 拼路径读资源文件，在 `bun build --compile` 产物里普遍失效。17 个文件、23 处，跨 `simulation/**`、`lab/**`、`project/**`、`literature/**`、`artifacts/**`、`agents/**`、`scaffold/**`、`server/**`。`version.ts` 一处已由主会话修复；其余待专门 lane 处理，建议按"同进程读"（改 `import x from "./f" with {type:'file'}`）和"外部进程读"（embed 成文本 + 运行时 `writeFileSync` 到临时目录）两条路径分别设计，不要指望一种修法通吃。
- **V28**：单二进制没有冒烟测试。构建只要 ~300ms（§2 实测），值得进 CI：至少覆盖 `--version`（版本号要跟 `package.json` 一致，覆盖 §5.2 那种"多处读版本号互相不一致"的回归）、`--help`、`capabilities --json`（parse 得出来）、`doctor --json`（parse 得出来）。V27 修完之前，不建议把"深层命令在编译产物里能跑"也放进这条冒烟测试——先锁住"至少不崩"，V27 修完后再加严。

---

## 10. 文件清单

```
backend/src/doctor/index.ts     新建：buildDoctorReport() + 探测器（DI 友好）
backend/src/doctor/cli.ts       新建：runDoctorCommand() / renderDoctor()
backend/src/index.ts            改：pkg.version 静态 import 修复 · --version/-v · doctor 接线 ·
                                     welcome() 重写为 DI 友好 + import.meta.main 守卫
tests/unit/doctor.test.ts       新建：12 条（DI 单测 + 1 条真实系统 python3 探测 + CLI 渲染/调度）
tests/unit/cli_entry.test.ts    新建：12 条（welcome() DI 单测 + 真进程冒烟）
docs/INSTALL.md                 新建
docs/devlog/W1-d.md             本文件
```
