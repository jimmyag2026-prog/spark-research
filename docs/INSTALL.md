# 安装 Spark Research

三条路径，按推荐程度排序。选之前先看清楚每条路径**实际能跑什么**——单二进制目前有明确限制，
见 [§3](#3-单二进制实验性只有浅层命令可用)。

---

## 0. 依赖分层：装多少取决于你要用哪块功能

Spark Research 的 Python 依赖分三档，**不是全装或不装**：

| 档位 | 需要的包 | 覆盖的功能 | 装不装的影响 |
|---|---|---|---|
| **core** | 无（零 Python 依赖，只需要 bun） | 文献检索/入库、idea 共探、novelty check、记录、结论评审、报告导出 | 装了 bun 就能用，这一档不用管 Python |
| **science** | `openmm` | 干实验仿真（`exp new --platform openmm`；不装的话默认走零依赖的 `pyref` 平台，`exp` 命令照样可用，只是仿真更简化） | 不装：`exp` 仍可用（`pyref`），只是拿不到 OpenMM 那档更真实的分子动力学结果 |
| **lab** | `opentrons` | 湿实验模拟器（`lab simulate`，默认后端） | 不装：`lab compile`/审批流程仍可用，但 `simulate`/`execute` 这两步会失败 |

**装哪个用哪条命令**（都是直接装进仓库 `.venv`，不碰系统 Python——这是仓库现有约定，见
`backend/src/simulation/openmm/index.ts` 的探测器提示）：

```bash
# science 档
VIRTUAL_ENV=.venv uv pip install openmm

# lab 档
VIRTUAL_ENV=.venv uv pip install opentrons
```

**不确定装了没有、缺什么**：跑 `spark-research doctor`——它会真的去探测三档各自能不能用，
缺什么直接给出上面这类可复制的命令，而不是让你翻文档猜。

> **为什么这里给的是运行时命令，不是"改 `pyproject.toml` 里的一行"**：仓库根的
> `pyproject.toml` 目前的 `[dependencies]` table 不是标准 PEP 621 形态（标准应为
> `[project] dependencies = [...]` 数组），`uv sync` 读不到它。这个问题本身已知，
> 修复涉及跨 lane 协调（详见 `docs/devlog/W1-d.md` §3），**本次安装文档刻意不依赖
> `uv sync` 能正常工作**，上面两条命令直接装具体的包，绕开这个问题。

---

## 1. 源码克隆（推荐，开发/贡献者路径）

```bash
git clone https://github.com/<org>/spark-research.git
cd spark-research
bun install
uv venv --python 3.12 .venv            # 建 core 档需要的 venv（core 本身零 Python 依赖，
                                        # 但 unit/e2e 测试套件里有 Python 侧用例要跑）
VIRTUAL_ENV=.venv uv pip install pytest numpy pandas jupyter-client ipykernel rdkit
# 按需追加 science / lab 档（见 §0）

bun run build:web                      # 可选：不跑的话 Web UI 不可用，CLI/API 仍正常
spark-research doctor                  # 确认环境状态
spark-research auth                    # 配置一把 LLM API key
spark-research
```

`bin` 字段（见 `package.json`）指向 `backend/src/index.ts` 本体，`#!/usr/bin/env bun` 直接执行，
不需要编译步骤——这是目前唯一**端到端实测通过**的分发形态（`docs/devlog/W1-d.md` §2.2 有
`project new`/`idea list` 等真实命令的实测输出）。

---

## 2. npm 包 / `npx spark-research`（发布步骤——**尚未发布**，以下是给发布者看的清单）

**当前状态**：`package.json` 的 `bin` 字段已经指向 `backend/src/index.ts`，运行时验证过可行
（`bun` 作为 shebang 解释器直接执行 `.ts` 源文件，不需要编译）。**但发布前的打磨还没做完**：

- [ ] `files` 字段：限定 npm tarball 只带 `backend/`、`package.json`、`README.md`（当前没有这个
      字段，npm 默认行为可能打包进不必要的内容，比如 `llms-full.txt`）。
- [ ] `prepublishOnly` 脚本：发布前跑一次 `bun run build:web`，把 `frontend/workspace/dist`
      塞进 npm 包，否则 `npx spark-research server` 起来的 Web UI 是空的。
- [ ] `engines` 字段：声明 `{ "bun": ">=1.3.0" }`，让 npm/npx 在没有 bun 的机器上给出更清楚的
      报错，而不是 shebang 解释器找不到时的原始 shell 错误。
- [ ] 决定 `frontend/workspace/dist` 要不要真的随包发布（体积 vs. 开箱即用的取舍）。

**前置条件（无论谁来发布都要知道）**：`npx spark-research` 执行的是 `#!/usr/bin/env bun` 脚本，
**目标机器必须已经装了 `bun`**。这跟"零依赖秒装"的体验目标有落差——如果要做到目标机器
完全不需要预装任何运行时，只有单二进制路径（§3）能做到，但那条路径目前功能不完整。

**发布步骤**（补完上面的 checklist 之后）：

```bash
npm login
bun run build:web
npm publish --access public
```

发布后验证：

```bash
npx spark-research --version
npx spark-research doctor
```

---

## 3. 单二进制（实验性，只有浅层命令可用）

```bash
bun run build   # bun run build:web && bun build backend/src/index.ts --compile --outfile dist/spark-research
```

实测数据（`docs/devlog/W1-d.md` §2 有完整记录）：构建耗时约 300ms，产物 62M（Mach-O arm64
可执行文件，不依赖 `node_modules`）。

**已验证可用**：

```bash
dist/spark-research --version
dist/spark-research --help
dist/spark-research capabilities --json
dist/spark-research doctor
dist/spark-research doctor --json
```

**已知不可用**（BACKLOG V27，跨模块问题，详见 `docs/devlog/W1-d.md` §5）：

```
dist/spark-research project new <名字>     ← ENOENT: schema.sql
dist/spark-research idea ...                ← 同上（同一个 records.db schema）
dist/spark-research lab simulate ...        ← ENOENT: opentrons_backend.py
```

根因：`bun build --compile` 只把 **JS/TS 模块图内的静态 import** 编译进产物；`.sql`/`.py` 这类
通过 `join(import.meta.dir, "...")` 在运行期拼路径读取的资源文件**不会**被自动内嵌，产物运行时
这些路径指向虚拟文件系统（`/$bunfs/root/`），真实文件不存在。`index.ts` 里读 `package.json`
版本号的同款问题已经修复（改用静态 `import`），但同一模式在仓库另外 17 个文件里还有 23 处，
是一次专门的修复工作，不是这次打包分发 lane 的范围。

**结论**：单二进制目前**不建议**作为主力分发形态。想要完整功能，用 §1（源码）或 §2（npm，
但目标机器需要预装 bun）。

**这不是永久判决**：`docs/devlog/F-c.md`（v0.5 闸门 F-c）对 V27 做了精确盘点 + 三条修法的
实测验证，**结论是「修，成本可控」，不是「永久降级」**——最小可行集（3 处 `schema.sql` 改静态
`import ... with { type: "text" }`）实测编译后 `project new` 即可在单二进制里跑通，见该文档
§2 的真实终端输出（补丁前 ENOENT、补丁后成功建项目，两次编译两次运行的对照）。`.py` 类资源
（`opentrons_backend.py`、各 `runner.py`、`python_kernel.py`）需要额外一步（内容静态 import
成文本 + 运行期 `writeFileSync` 到临时目录再 `Bun.spawn` 那个真实路径），`docs/devlog/F-c.md`
§3 里也有实测验证 Bun 的 `type: "file"`/`Bun.embeddedFiles` **不能**直接用于外部子进程 spawn
（虚拟路径外部进程读不到），这条路必须走"解包到真实磁盘路径"这一步。真正把这 23 处改完是
另一条 lane 的工作（不在 F-c 文件所有权内），F-c 只负责把可行性、修法优先级和风险敲实。

---

## 4. 环境体检：`spark-research doctor`

任何一条安装路径装完之后，先跑这个确认状态：

```bash
spark-research doctor          # 人看的表格
spark-research doctor --json   # 机器可读，给 agent/脚本判断用
```

报告内容：bun 版本、Python 解释器路径与版本、core/science/lab 三档依赖各自是否可用（真探测，
不是猜）、配置了哪些 LLM provider key（只报"已配置/未配置"，**密钥值永不出现在输出里**）、
前端产物是否已构建。缺什么，输出里直接给可复制粘贴的修复命令。

**在单二进制里跑 `doctor`**：`lab` 档探测 `opentrons_backend.py` 会因为 V27（见 §3）读不到
文件，但 `doctor` 现在（F-c 修复）能把这种「二进制打包限制」跟「真没装 opentrons」分清楚——
前者打 ⚠️ 而不是 ❌，文案明确写「这不是依赖没装」，不会误导你去跑一遍装不完的 `uv pip
install`。`--json` 输出里对应 `tiers[].packagingLimitation` 字段，供脚本/agent 判断，不用猜
文案。判定法：探测失败原因里出现 `/$bunfs/` 这个子串——只有编译产物才会产生这个虚拟路径，
源码/npm/npx 三条路径下这个子串不会出现在任何真实报错里，不会误伤真实缺依赖的场景。
