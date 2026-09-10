# F-c · V27 定性（`import.meta.dir` 在单二进制里全线失效）

> 分支 `feat/F-c` · 2026-09-10 · v0.5 闸门 F
> 范围真源：主会话任务书「F-c：V27 定性」
> 文件所有权：`backend/src/doctor/**` · `docs/INSTALL.md` · `docs/devlog/F-c.md`（本文件）·
> `tests/unit/doctor.test.ts`
> 任务性质：**调查 + 结论**，不是去改 23 处（那是另一条 lane 的活）

---

## 0. 一句话结论

**V27 可以修，成本可控——不建议永久降级成"不发单二进制"。**

最小可行集（3 处 `schema.sql` 改静态 `import ... with { type: "text" }`，本 lane 只在 `project/records.ts`
上做了真实编译验证，因为改另外两处不在本 lane 文件所有权内）实测让 `project new` 在
`bun build --compile` 产物里从 `❌ ENOENT` 变成 `✅ 已创建项目`——见 §2 的对照编译记录，
补丁前/补丁后各编译一次、各运行一次，四条终端输出都在。`.sql`/`.txt` 这类进程内 `readFileSync`
的资产，静态 `import ... with { type: "text" }` 直接可用；`.py` 这类要被**外部子进程** spawn 的
资产不能只做静态 import——本 lane 实测证明 Bun 的 `type: "file"` embedded-asset 机制生成的
虚拟路径外部进程读不到（§3.2），必须多做一步「解包到真实临时文件再 spawn」，但这一步本身也
实测验证可行（§3.3）。

精确盘点（§1）把 BACKLOG 记的「23 处 17 个文件」拆解清楚：这个数字**混进了注释、诊断性代码、
脚手架生成的目标代码文本**。真正「运行期会因为读不到资产而坏掉、且没有既有降级保护」的代码
路径是 **15 处、13 个文件**（§1.3）。其中 3 处目前有安全兜底（`existsSync` 门控，不崩溃，只是
体验打折），2 处是自我诊断过的纯开发工具路径（`ext verify`、`scaffold new`，语义上就假设跑在
源码仓库里），真正需要按「修」这条路补的核心是 **10 处**：3 个 `schema.sql`、4 个 `.py`
（`opentrons_backend.py`/两个 `runner.py`/`python_kernel.py`）、3 处 prompt `.txt`
（`orchestrator.ts` 的 prompt 读取 + `coexplore` 的 prompt 目录），外加一个不走「资产读取」
套路、需要单独设计的例外——`skills/frontmatter.ts` 的 `SKILLS_DIR`（目录扫描，不是单文件读取，
静态 import 机制覆盖不到，见 §1.4）。

顺带修的 `doctor` 误报（§4，已完成）：`doctor` 之前会把「二进制打包限制」误报成「依赖没装」——
用户照着报错去 `uv pip install opentrons`，装完问题分毫不动。现在 `doctor` 能把两者分开，
`--json` 里新增 `tiers[].packagingLimitation` 字段。

六道门：typecheck 干净、`bun test tests/unit/` **1400 pass / 0 fail / 0 skip**（基线 1396 + 本
lane 新增 4）、concurrency+timeout **12/12**、e2e **14/14**、`test:py` **48 passed**、`test:lab`
**26 passed**。阴性对照：把 doctor 的判定逻辑改坏后专门跑了一次 `bun test`，**2 条测试如期变红**
（见 §4.4 的真实终端输出），还原后恢复 16/16。

---

## 1. 精确盘点

### 1.1 方法

`grep -rn "import.meta.dir" --include="*.ts" backend/` 在 F-c 开始时（本 lane 改动之前）命中
**34 行、19 个文件**。逐行读上下文分类，不是数出现次数——很多行是注释或已经妥善处理过的诊断
代码，不是"待修的坏点"。

### 1.2 分类结果

| 类别 | 行数 | 说明 |
|---|---|---|
| 纯注释/文档 | 9 | `index.ts`×2、`version.ts`×2（V27 的两处已修记录）、`onboarding/demo.ts`×4、`onboarding/init.ts`×1 |
| 诊断性用途，非资产读取，用法本身正确 | 4 | `demo.ts`/`init.ts` 各 2 处：用 `import.meta.dir.startsWith("/$bunfs")` 判断"是不是在编译产物里"，给用户诚实的降级提示——这是**应对 V27 的正确写法**，不是待修的坏点 |
| 脚手架生成的目标代码文本 | 2 | `scaffold/templates.ts:112,404`：出现在模板字符串里，是**生成给新 skill/platform 用的源码**，不是这个二进制自己执行的路径（见 §1.4） |
| venv 兜底路径，`existsSync` 门控不崩溃 | 3 | `kernels/manager.ts:28`、`lab/wet_backend.ts:108`、`simulation/platform.ts:29`——`resolvePython()`；`SPARK_PYTHON` 设了就不走这段；没设时在二进制里 `existsSync` 对虚拆路径返回 `false`，静默退化成 `"python3"`，**不抛异常** |
| 前端目录，`existsSync` 门控不崩溃 | 1 | `server/app.ts:27` `DEFAULT_FRONTEND_DIR`：读不到就走"未构建"分支，只是体验打折（永远报未构建），不是崩溃 |
| **真实会读资产/拼目录、无降级保护** | **15** | 见 §1.3，这才是 V27 真正的坏点 |

**BACKLOG 记的"23 处 17 个文件"高估了**——很可能是早期扫描时把注释/诊断代码也计入了行数。
真正需要处理的是 15 处、13 个文件，其中 3 处已经安全（venv 兜底）、2 处是自我诊断过的纯开发
工具路径。核心待修集是 10 处（§0）。

### 1.3 真实坏点清单（15 处、13 个文件）

| 文件 · 行号 | 读什么 | 坏了影响哪条命令 | 已验证？ | 修法难度 |
|---|---|---|---|---|
| `agents/orchestrator.ts:177` | prompt `.txt`（`readFileSync(join(import.meta.dir,"prompt",filename))`） | `chat`、`server`（走 orchestrator 的路径全部） | 机制验证（同类 `.txt` 静态 import 实测过，见 §2），未单独编译这一处 | 易：`import x from "./prompt/xxx.txt" with {type:"text"}` |
| `agents/orchestrator.ts:223` | 非资产：`workspaceRoot` 默认值 | `chat`、`server`——**且不是简单 ENOENT**：`join("/$bunfs/root","../../../workspaces")` 归一化后是 `/workspaces`（`bun -e` 实测确认，见 §1.5），`mkdirSync` 会尝试在文件系统根目录建目录，权限不足直接崩，权限足够则**写到用户完全想不到的位置** | 路径计算已用 `bun -e` 验证；未在真实二进制里触发 mkdir（安全起见没有真的往 `/` 写） | 易：默认值改成 `os.tmpdir()` 或强制调用方必须显式传 `workspaceRoot`（不给隐式默认） |
| `agents/orchestrator.ts:719` | 传给 sub_agent 的 `promptDir` | 同上，链路见 B | 同 A | 易，同 A |
| `agents/sub_agent.ts:238` | `DEFAULT_PROMPT_DIR` | `chat`/`exp`/`lit`/`idea`/`lab` 任何 orchestrator 委派给子代理的任务 | 未单独验证 | 易，同 A |
| `artifacts/store.ts:147` | `schema.sql`（Artifact 存储） | `Project.artifacts()`（惰性），任何操作 artifact 的命令、`server` | 机制验证（同类 `.sql` 静态 import 已编译验证，见 §2），本文件未单独打补丁编译 | 易，同 §2 记录 `records.ts` 的手法 |
| `extensions/platform_verify.ts:25` | 非资产：`REPO_ROOT`（找 `tests/helpers/simulation_contract.ts`） | `ext verify`（kind=platform） | 该文件自身注释已写明"编译产物里没有 tests/ 目录，会明确报错，不是静默退化"——**语义上就是开发工具**，本 lane 认可这个自我诊断 | 不建议按"修"处理：`ext verify` 复用 `tests/` 目录下的契约测试套件，这个依赖关系在单二进制发行版里本来就不成立（除非把整个 `tests/` 目录也打进产物，得不偿失）。应在 `docs/INSTALL.md`/`--help` 里明说"`ext verify` 只在源码 checkout 可用" |
| `ideation/coexplore.ts:35` | prompt `.txt`（co-explore 用） | `idea`/`ideation`、`chat`（mode=coexplore）、`server` 的 ideation 路由 | 未单独验证 | 易，同 A |
| `kernels/manager.ts:74` | `python_kernel.py`（spawn） | `exp`（Jupyter-like 代码执行 kernel）、orchestrator 的 kernel 工具调用 | 机制验证（§3.3 的 unpack-then-spawn 已编译验证），未单独打这一处补丁 | 中：需要「静态 import 文本 + 运行期写临时文件 + spawn 真实路径」（§3.3），不是单纯改 import 就完事 |
| `lab/wet_backend.ts:112` | `opentrons_backend.py`（spawn） | `lab`（模拟/真机执行）、`doctor`/`capabilities --probe` 的 lab 档探测 | **实机确认**：`doctor` 在未打补丁的二进制里真实报出 `can't open file '/$bunfs/root/opentrons_backend.py'`（§4 原始输出） | 中，同上 |
| `literature/library.ts:162` | `schema.sql`（文献库） | `lit search --add`、`idea`、任何往文献库写数据的命令 | **实机确认**：本 lane 编译的（只补了 `records.ts` 的）二进制上跑 `lit search --add` 真实复现 `ENOENT: .../schema.sql`（§2.3） | 易，同 `records.ts` 手法（§2） |
| `project/records.ts:175` | `schema.sql`（记录库） | `project new`/`idea`/`exp`/`lab`/`chat`——几乎所有 project-scoped 命令的共同底座 | **已修复并实机验证**（§2）：这是本 lane 唯一真正打了补丁、编译、运行验证过的一处 | 易——本 lane 已实测证明 |
| `scaffold/cli.ts:53` | 非资产：`DEFAULT_REPO_ROOT` | `new skill/connector/platform` | 路径计算用 `bun -e` 验证会归一化到 `/`（同 A 的问题模式），未实机触发写操作 | 不建议按"修"处理：脚手架的产出物**就是往仓库里写新源码文件**，编译产物本身没有一个"仓库"可以写——即使把 `DEFAULT_REPO_ROOT` 修对，`new skill` 在单二进制发行版里语义上也不成立。同 `ext verify`，应在文档里明说是源码工具 |
| `simulation/openmm/index.ts:34` | `runner.py`（spawn） | `exp --platform openmm`、`doctor`/`capabilities --probe` 的 science 档**实际执行**（注意：`probeCode()` 是内联 python 字符串，探测本身不受影响，*只有真的提交任务*才会摸到这个坏点——`doctor` 现在的"science 可用"结论对"能不能真的跑一次 openmm 任务"是有盲区的，这个盲区本 lane 未处理，记在 §5 未完成项） | 未单独验证 | 中，同 `python_kernel.py` 手法 |
| `simulation/pyref/index.ts:28` | `runner.py`（spawn） | `exp --platform pyref`（**零依赖档**，`core` 里唯一的"干实验"能力也会因为这个坏掉——即使不装任何 Python 包） | 未单独验证 | 中，同上 |
| `skills/frontmatter.ts:53` | 非单文件：`SKILLS_DIR`（目录扫描，`skillDirs()`/`loadSkills()` 逐个子目录找 `SKILL.md`） | `capabilities`/`caps`、`server` 的能力清单路由——**真实终端用户会摸到的命令**（确认见 §1.6，不是只有测试引用） | 未验证；且这处**不适用**静态 import 机制（见 §1.4） | **难，需要单独设计**：静态 import 处理的是"读一个已知路径的文件"，这里是"运行期枚举一个目录下有哪些子目录"——bun 打包器做不到把一次 `readdirSync` 结果内嵌成"目录列表"。可行方向：build 时跑一个 codegen 脚本，把 `skillDirs()` 的结果 + 每个 `SKILL.md` 的内容序列化成一个静态 TS 模块（`import { SKILL_MANIFEST } from "./skills.generated"`），`loadSkills()` 二进制模式下改读这个内嵌的静态清单 |

### 1.4 一个不适用"改成静态 import"套路的例外

`skills/frontmatter.ts` 的 `SKILLS_DIR` 不是在读一个**已知路径**的文件，是在**枚举一个目录**
（`readdirSync(root)` 找哪些子目录有 `SKILL.md`）。静态 `import x from "./f" with {type:"text"}`
要求编译期就知道具体文件名——这里恰恰是运行期才知道"有哪些技能目录"。这处需要一个
codegen 步骤（build 时扫一遍 `backend/src/skills/*/SKILL.md`，生成一个静态清单模块），跟其余
14 处「路径已知、只是拼错了」的坏点性质不同，修复工作量也不同——**任何后续修复 lane 拿到
BACKLOG V27 时都应该把这处单独排期，不要指望跟其余处用同一个脚本批量改完**。

### 1.5 危险子类：不是 ENOENT，是"路径归一化到文件系统根"

`orchestrator.ts:223`（`workspaceRoot`）和 `scaffold/cli.ts:53`（`DEFAULT_REPO_ROOT`）都是
`join(import.meta.dir, "../../../...")`/`join(import.meta.dir, "../../..")` 这种"往上跳几层"
的写法。`import.meta.dir` 在编译产物里是 `/$bunfs/root`，往上跳的层数比虚拟路径的深度还多，
`node:path` 的归一化会把结果钉在文件系统真实的根：

```
$ bun -e 'import { join } from "node:path"; console.log(join("/$bunfs/root", "../../../workspaces"));'
/workspaces
$ bun -e 'import { resolve } from "node:path"; console.log(resolve("/$bunfs/root", "../../.."));'
/
```

这两处不是"读不到文件报错"，是"**会尝试对文件系统根目录做写操作**"——权限不足会崩溃，
权限足够（比如误用 root 跑二进制）会把数据写到完全意料之外的位置。修复时不能只当成"跟
`schema.sql` 一样改成静态 import 就行"，这类"默认值退化成危险路径"的坏点要单独处理（默认值
改成 `os.tmpdir()`，或者干脆不给隐式默认、强制调用方传参）。本 lane 没有实机触发过真实的
`mkdirSync("/workspaces")`（不想在验证过程中真的往系统根目录写东西），这条是路径计算层面的
确定性证明，不是运行时崩溃的实机复现——如实记录未验证的部分。

### 1.6 调用链证据来源

命令级影响判断（"这处坏了会拖累哪条 CLI 子命令"）主要来自一次只读代码探查（追踪各符号的调用方
到 CLI 子命令入口），结论已经吸收进上表。其中 `skills/frontmatter.ts` 是**真实终端用户会摸到
的路径**（`capabilities`/`caps` 命令、`server` 的能力清单路由都会调用 `loadSkills()`），不是
只有测试引用——这点特意确认过，因为它决定了这一处的修复优先级不能排到最后。

---

## 2. 修法 (a)：静态 import——已编译验证，`project new` 从崩到通

### 2.1 最小样例（独立于本仓库的干净验证）

```ts
// main.ts
import sqlText from "./schema.sql" with { type: "text" };
import pyText from "./runner.py" with { type: "text" };
import promptText from "./prompt.txt" with { type: "text" };
console.log("import.meta.dir =", import.meta.dir);
console.log("sqlText length:", sqlText.length);
```

源码模式（`bun run main.ts`）：三种资产类型全部正常读到内容。编译后（`bun build main.ts
--compile --outfile ./bin_main`），**从一个完全没有源文件的目录**运行：

```
$ ./bin_main            # 在 /tmp/elsewhere_run，没有 schema.sql/runner.py/prompt.txt
import.meta.dir = /$bunfs/root
sqlText length: 44 "CREATE TABLE demo (id INTEGER "
pyText length: 30
promptText: this is a prompt file
```

**结论**：Bun 支持 `.sql`/`.py`/`.txt` 用 `with { type: "text" }` 静态 import，内容在编译期
被内嵌进二进制，运行期不依赖真实文件系统。这对"进程内 `readFileSync` 读文本内容"的场景
（`.sql` 建表、prompt `.txt`）**直接可用**，是最简单的一类修法。

### 2.2 在真实仓库上打补丁 + 编译 + 跑 `project new`（要求的最小可行集验证）

只改了一处（`backend/src/project/records.ts`，本 lane 的实验性验证副本，**没有提交进
`feat/F-c`**——改这个文件超出本 lane 文件所有权）：

```diff
+import SCHEMA_SQL from "./schema.sql" with { type: "text" };
...
   initSchema(): void {
-    const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
-    this.db.exec(schema);
+    this.db.exec(SCHEMA_SQL);
     this.migrateRevColumn();
   }
```

`ProjectManager.create()`（`project/manager.ts:109`）在建项目时立刻调用 `project.records()`，
这是 `project new` 命令唯一会**立即**触发的资产读取，所以这一处补丁就够验证"最小可行集能不能
让 `project new` 跑通"。

**对照编译（补丁前，控制组）**：

```
$ bun build backend/src/index.ts --compile --outfile ./dist_bin_unpatched
   [39ms]  bundle  397 modules
 [165ms] compile  ./dist_bin_unpatched
$ ./dist_bin_unpatched project new demo-control
❌ ENOENT: no such file or directory, open '/$bunfs/root/schema.sql'
exit=1
```

**补丁后编译，从一个干净目录运行**（`SPARK_RESEARCH_DATA_DIR` 指向临时目录，没有任何源码树）：

```
$ bun build backend/src/index.ts --compile --outfile ./dist_bin
   [41ms]  bundle  398 modules
 [181ms] compile  ./dist_bin
$ ./spark-research --version
0.4.0
$ ./spark-research project new demo-exp
✅ 已创建项目 'demo-exp'
项目 demo-exp（demo-exp）
  状态: active
  创建: 2026-09-10T08:19:58.104Z
  目录: /tmp/elsewhere_run2/data/projects/demo-exp
  records.db: /tmp/elsewhere_run2/data/projects/demo-exp/records.db（0 条 record）
  artifacts/: /tmp/elsewhere_run2/data/projects/demo-exp/artifacts
  papers/: /tmp/elsewhere_run2/data/projects/demo-exp/papers
  experiments/: /tmp/elsewhere_run2/data/projects/demo-exp/experiments
exit=0
$ ./spark-research project list
* demo-exp  demo-exp  创建于 2026-09-10T08:19:58.104Z
```

**对照干净：同一份代码，只差这一处补丁，同样的编译命令，`project new` 从 `exit=1` 变成
`exit=0`**。这是任务书要求的"至少对最小可行集做一次真实验证"的证据。

### 2.3 补丁范围之外的部分依然会坏——证明"15 处不是各自独立、必须全修"

在**同一个补丁过的二进制**（只修了 `records.ts`）上继续跑：

```
$ ./spark-research lit search "test query" --limit 2 --add
检索 "test query"：6 条原始结果 → ...
 1. Indexing by latent semantic analysis ...
 2. Testing containment of conjunctive queries ...
❌ ENOENT: no such file or directory, open '/$bunfs/root/schema.sql'
```

`lit search --add` 先完整跑完网络检索（走的是 `literature/library.ts` 之外的逻辑），最后落库
时命中 `literature/library.ts:162` 的**同款**坏点。这确认了 §1.3 的判断：`literature/library.ts`
和 `artifacts/store.ts` 需要跟 `records.ts` 一样的补丁，**不会因为改了 records.ts 就顺带修好**——
三处独立、互不覆盖，修复工作量大致是"改几处就修好几处"，不存在一次改动覆盖全部的捷径。

（旁注：`lit search --add` 在这个坏点上 `exit=0` 而不是 `exit=1`——报错打到了 stderr 但命令的
返回码没有跟着置 1，这是 `literature/cli.ts` 里一个独立的、跟 V27 无关的退出码处理问题，本
lane 不在所有权范围内，如实记录，不修。）

---

## 3. 修法 (b)：Bun embedded files（`type: "file"` / `Bun.embeddedFiles`）——实测对"外部子进程 spawn"无效

### 3.1 为什么要单独测这条

`.sql`/`.txt` 这类"进程内读文本内容"的资产，§2 的静态 `type: "text"` import 已经够用。但
`opentrons_backend.py`/`runner.py`/`python_kernel.py` 这几处不一样：它们要被 `Bun.spawn([python,
scriptPath])` 当成**外部进程的命令行参数**——需要的是一个**磁盘上真实存在的路径**，不是文件
内容本身。Bun 文档里 `type: "file"` 的 embedded-file 机制看起来像是为这种场景设计的（import
一个文件，拿到一个"路径"），值得单独实测它是否能覆盖这个场景。

### 3.2 实测：`type: "file"` 拿到的路径，外部进程读不到

```ts
// main2.ts
import pyPath from "./runner.py" with { type: "file" };
import { spawnSync } from "node:child_process";
console.log("pyPath =", pyPath);
const result = spawnSync("python3", [pyPath], { encoding: "utf8" });
console.log("spawn result:", JSON.stringify(result.stdout), result.status);
```

源码模式：`pyPath` 是真实磁盘路径，`spawnSync` 正常执行，输出 `"hello from runner.py\n"`，
`status=0`。**编译后**，从没有源文件的目录运行：

```
$ ./bin_main2
pyPath = /$bunfs/root/runner-zkwrb3ab.py
spawn result: "" 2 undefined
```

`pyPath` 变成了 `/$bunfs/root/runner-zkwrb3ab.py`——这是 Bun 运行时内部认识的虚拟路径（用来
支持 `Bun.file()`/`fetch()` 这类 Bun 自己的 API 读取内嵌资产），但 `python3` 是一个完全独立的
外部进程，它面对的是操作系统的真实文件系统，看不到这个虚拟路径，`exit=2`（`No such file or
directory`）。

用 `Bun.embeddedFiles` 直接读同一份内嵌资产确认了它确实被打进了二进制（`Bun.embeddedFiles.length
=== 1`，`name: "runner-zkwrb3ab.py"`, `size: 30`）——**内容在二进制里，只是不能直接喂给外部
进程当路径参数**。

**结论**：修法 (b) 单独使用**无法**覆盖"资产需要被外部子进程按路径读取"这一类场景（`.py` 脚本
全部属于这一类）。这不是猜测——两次独立编译 + 运行的对照实验都实测到了。

### 3.3 组合修法：(a) 静态 import 内容 + (c) 运行期解包到真实临时文件再 spawn——实测可行

```ts
// main.ts（§2.1 同一个文件，附加的验证）
import pyText from "./runner.py" with { type: "text" };
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "bunexp-"));
const outPath = join(dir, "runner.py");
writeFileSync(outPath, pyText);
const result = spawnSync("python3", [outPath], { encoding: "utf8" });
console.log("spawn python3 on unpacked runner.py ->", result.stdout.trim(), result.status);
```

编译后，从没有源文件的目录运行：

```
$ ./bin_main
spawn python3 on unpacked runner.py -> hello from runner.py 0
```

**结论**：`.py` 类资产的正确修法是"用 `type: "text"` 静态 import 把内容编译进二进制 → 运行期
`writeFileSync` 到一个真实临时文件 → `Bun.spawn` 指向这个临时文件路径"，即修法 (a)+(c) 的组合，
**不是 (b) 单独能解决的**。这条路径已经实测验证可行（两次独立编译）。

`opentrons_backend.py`/两个 `runner.py`/`python_kernel.py` 四处都应该套用同一个模式——可以
抽一个共享 helper（例如 `ensureUnpackedScript(name: string, content: string): string`，内部
做临时目录缓存，避免每次调用都重新写盘），本 lane 没有写这个 helper（不在文件所有权内），
留给修复 V27 的 lane。

---

## 4. 顺带修：`doctor` 的误报（已完成）

### 4.1 问题的真实样子（打补丁前，实机跑出来的）

在 §2.2 只补了 `records.ts` 的二进制上跑 `doctor`：

```
▎依赖分层（core 零依赖 · science=openmm · lab=opentrons）
  ✅ core      文献 / idea / novelty / 记录 / 报告（零 Python 依赖，只需要 bun）
  ❌ science   干实验仿真（openmm）
      openmm 探测失败（python=python3, exit=1）：openmm 不可用: No module named 'openmm' 安装：uv pip install openmm
  ❌ lab       湿实验模拟器（opentrons）
      opentrons 模拟器不可用（python=python3, exit=2）：/Library/Developer/CommandLineTools/usr/bin/python3: can't open file '/$bunfs/root/opentrons_backend.py': [Errno 2] No such file or directory。安装：VIRTUAL_ENV=.venv uv pip install opentrons
```

science 那条是**真的**没装 openmm（系统 python3 确实没有这个包）——`opentrons` 那条不是：
`can't open file '/$bunfs/root/opentrons_backend.py'` 是 V27 那个虚拟路径问题，装
`opentrons` 解决不了任何东西。但两条在渲染上长得一模一样（都是 ❌ + "安装：uv pip
install ..."），用户没法从界面上分辨该不该真的去装。**这正是任务书点名的诊断工具误导**。

顺带一提，这次实机验证还发现了一个比"误报"更隐蔽的不对称问题：`science` 档的可用性探测
（`OpenMMPlatform.probeCode()`）是一段**内联** Python 字符串，不读磁盘上的 `runner.py`，所以
它在编译产物里"探测"这一步不受 V27 影响；但**真正提交一次仿真任务**时走的是
`entryPointFor()`，那个才会去读 `runner.py`（§1.3 表里已记）。也就是说即便 §5 之后把
`opentrons_backend.py` 那条也修了，`doctor` 对 science 档报"可用"这个结论对"能不能真的跑一次
openmm 任务"仍然是有盲区的——这不属于本次"分清误报"的任务范围（`doctor` 现在没有、也不该去
真的提交一次任务来验证"能跑"），如实记录在这里，留给以后。

### 4.2 修法

不需要额外接一条"现在是不是跑在编译产物里"的环境判断，也不需要给测试注入假的
`import.meta.dir`——探测失败原因里出现 `/$bunfs/` 这个子串本身就是唯一、无歧义的证据（只有
`import.meta.dir` 在编译产物里才会展开成这个虚拟路径；源码/npm/npx 三条路径下任何真实报错都
不会包含它）。`backend/src/doctor/index.ts` 新增：

```ts
function isPackagingLimitation(reason: string | null): boolean {
  return typeof reason === "string" && reason.includes("/$bunfs/");
}

function describeTierReason(reason: string | null): string {
  if (!isPackagingLimitation(reason)) return reason ?? "";
  return (
    `这不是依赖没装——是单二进制发行版的已知限制（BACKLOG V27）：` +
    `编译产物（bun build --compile）没有把运行期脚本一起打包，探测子进程读不到文件，` +
    `装依赖解决不了。请改用源码运行（\`bun backend/src/index.ts ...\`）或 npm/npx 安装方式。` +
    `原始报错：${reason}`
  );
}
```

`DependencyTierStatus` 新增 `packagingLimitation: boolean` 字段（`--json` 消费方不用猜文案，
直接读这个布尔）；science/lab 两档的 `reason` 构建时都套一层 `describeTierReason`。
`renderDoctor`（`cli.ts`）把打包限制的图标从 ❌ 改成 ⚠️——❌ 的语义是"装一下就好"，跟这里的
诊断矛盾。

### 4.3 单测

`tests/unit/doctor.test.ts` 新增一个 describe 块（4 条测试）：

1. lab 探测失败原因带 `/$bunfs/` → `packagingLimitation: true`，`reason` 含 `"BACKLOG V27"`
   与 `"不是依赖没装"`，原始报错仍保留在文案末尾供排障。
2. science 同样适用（不止 lab 一档吃得到这条逻辑）。
3. **阴性对照的另一半**：真缺依赖（reason 不含 `/$bunfs/`）不能被误判成打包限制——`reason`
   原样保留，不出现 `"BACKLOG V27"` 字样。
4. `renderDoctor` 渲染层：打包限制打 ⚠️ 不打 ❌。

### 4.4 阴性对照（任务书要求的"让它把「产物坏了」报成「依赖没装」→ 测试红"）

把 `isPackagingLimitation()` 改成永远返回 `false`（模拟"没做这个判断/判断写错了，所有失败都
按老样子报成依赖没装"），重跑：

```
$ bun test tests/unit/doctor.test.ts
156 |       probeLab: async () => ({ ok: false, reason: REAL_BUNFS_REASON }),
...
      expect(lab.packagingLimitation).toBe(true);
                                          ^
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) doctor · V27 打包限制 vs 真没装依赖（F-c） > lab 探测失败原因带 /$bunfs/ → 判定为打包限制...

      expect(science.packagingLimitation).toBe(true);
                                              ^
error: expect(received).toBe(expected)
Expected: true
Received: false
(fail) doctor · V27 打包限制 vs 真没装依赖（F-c） > science 探测失败原因带 /$bunfs/ 同样被判定为打包限制...

 14 pass
 2 fail
 49 expect() calls
```

**恰好**断言"判定为打包限制"的那两条变红，其余 14 条（含"阴性对照：真缺依赖不能被误判"那条
——因为破坏后的实现对这条用例反而"巧合正确"，`false === false`）不受影响。还原后重跑
16/16 恢复全绿。

---

## 5. 结论与建议

### 5.1 修，不降级

- **不建议**把"不发单二进制"写成永久承诺。§2/§3 的实测证明核心机制（静态 `type:"text"`
  import + 需要时解包到临时文件再 spawn）成立，`project new` 这个最有代表性的"建项目"路径
  已经端到端验证通过。
- **最小可行集**（让 `core` 档在二进制里名副其实）：3 个 `schema.sql`（`project/records.ts`
  已验证，`literature/library.ts`、`artifacts/store.ts` 同款手法）+ 3 处 prompt `.txt`
  （`orchestrator.ts` 两处 + `coexplore.ts` 一处）+ `orchestrator.ts:223` 的危险默认值
  （§1.5，优先级不能压到最后，这个不是"功能缺失"是"可能往系统根目录写东西"）。
- **第二阶段**（`science`/`lab` 档名副其实）：4 处 `.py`（§3.3 的 unpack-then-spawn 模式，
  建议抽一个共享 helper 而不是四处各写一遍）。
- **第三阶段 / 需要单独设计**：`skills/frontmatter.ts` 的目录扫描（§1.4，codegen 生成静态
  清单），`ext verify`/`scaffold new` 两处建议**不修，改成文档明说"只在源码 checkout 可用"**
  （这两个命令语义上就假设有个仓库可读/可写，单二进制发行版里本来就不该提供）。
- 工作量估计（不含 `skills/frontmatter.ts` 的 codegen 设计）：10 处按 §2/§3 已验证的两种套路
  批量改，单处改动本身很小（`records.ts` 那次是 2 行 diff），主要成本在**跑齐六道门 + 针对
  编译产物的实机验证**（V28 提到的"跑源码测试证明不了产物能用"），预估比 W1-d 修那两处的
  单处成本略高但同量级，不是一次大重构。

### 5.2 `docs/INSTALL.md` 现状

已在 §3（单二进制）追加一段，明确这不是永久判决，指向本文档的实测证据；已在 §4（`doctor`）
追加 `packagingLimitation` 字段的说明。原有"不建议单二进制作为主力分发形态"的结论**未改**——
V27 本身还没修（那是另一条 lane 的活），现状依然是"能列连接器，建不了项目"，只是现在
`doctor` 不会在这个前提下再给错误的诊断方向。

---

## 6. 六道门

| 门 | 结果 |
|---|---|
| `bun run typecheck` | 干净（两个 tsconfig 都过） |
| `bun test tests/unit/` | **1400 pass / 0 fail / 0 skip**（基线 1396 + 本 lane 新增 4：`doctor.test.ts` 的 V27 打包限制 describe 块） |
| `bun test tests/concurrency/ tests/timeout/` | 12 pass / 0 fail（7 个文件） |
| `bun run test:e2e`（`SPARK_E2E_PORT=4453`） | **14/14 passed**（8.7s） |
| `bun run test:py` | 48 passed |
| `bun run test:lab` | 26 passed |
| 阴性对照 | §4.4，2 条精确变红，还原后恢复 16/16 |

---

## 7. 诚实记录：哪些没有验成

- §2.2 的编译验证**只打了 `records.ts` 一处补丁**（这是本 lane 唯一改过 §1.3 表格里所列文件
  的地方，且只存在于 `/private/tmp/.../spark-exp` 这个一次性实验副本里，**没有提交进
  `feat/F-c` 分支**——`literature/library.ts`/`artifacts/store.ts` 没有同样打补丁验证，是从
  §2.3 的对照实验 + 同款代码结构（`readFileSync(join(import.meta.dir,"schema.sql"))`）推断
  "应该同样有效"，不是逐处独立实机验证过。
- prompt `.txt` 类（`orchestrator.ts` 两处、`coexplore.ts` 一处）：验证的是**通用机制**（§2.1
  的最小样例里含 `.txt` 静态 import，编译后正常工作），没有对仓库里这几处具体位置打补丁编译。
- `.py` 类的 unpack-then-spawn 模式（§3.3）：验证的是**通用机制**（合成的 `runner.py`），
  没有对 `opentrons_backend.py`/两个 `runner.py`/`python_kernel.py` 具体位置打补丁编译。
- `agents/orchestrator.ts:223`/`scaffold/cli.ts:53` 的"路径归一化到文件系统根"（§1.5）：只做
  了 `bun -e` 的路径计算验证，**没有**在真实编译产物里触发 `mkdirSync`/写操作（不想在验证
  过程中真的对文件系统根目录做写测试）。
- `skills/frontmatter.ts` 的 codegen 修法（§1.4）：只是方向性建议，没有做任何原型验证。
- `exp --platform openmm`/`exp --platform pyref` 在编译产物里的实际提交-执行流程：没有端到端
  跑过（§1.3 表格已标注 science 档"探测通过、实际执行未必通过"的盲区，但没有实机复现"实际
  执行"这一步失败）。
- `ext verify`/`scaffold new` 在编译产物里的行为：没有实机跑过，判断依据是读代码 + 这两个
  文件自身的注释（`platform_verify.ts` 已经自我记录了这个限制）。

---

## 8. 文件清单

```
backend/src/doctor/index.ts     改：新增 packagingLimitation 字段 + isPackagingLimitation()/describeTierReason()
backend/src/doctor/cli.ts       改：renderDoctor 打包限制用 ⚠️ 不用 ❌
tests/unit/doctor.test.ts       改：fixture 补 packagingLimitation 字段 + 新增 4 条测试（V27 打包限制 describe 块）
docs/INSTALL.md                 改：§3 追加"修，不是永久降级"的结论指针；§4 追加 packagingLimitation 说明
docs/devlog/F-c.md              新建：本文件——精确盘点 + 三条修法实测 + 结论
```
