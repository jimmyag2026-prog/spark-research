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

**当前状态（v0.6 G-2 已补完打包字段，V29 关闭）**：

- [x] `files` 字段：tarball 只带 `backend/src`、`frontend/workspace/dist`、`llms.txt`、
      `docs/INSTALL.md`、`README.md`。
- [x] `prepublishOnly`：发布前自动 `bun run build:web`（dist 随包，`npx spark-research server`
      开箱有 UI）+ 全量单测。
- [x] `engines`：`{ "bun": ">=1.2.0" }`。
- [x] `frontend/workspace/dist` 随包发布（约 100KB gzip 级，开箱即用优先）。

实际发不发 npm 由维护者决定；字段与脚本已备齐。

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

## 3. 单二进制

```bash
bun run build   # scripts/build-binary.ts：build:web → 前端清单内嵌 → 编译 → 还原存根
bun run smoke   # scripts/smoke-binary.sh：版本一致 + capabilities + server/UI 三段冒烟
```

实测数据（`docs/devlog/W1-d.md` §2 有完整记录）：构建耗时约 300ms，产物 62M（Mach-O arm64
可执行文件，不依赖 `node_modules`）。

**当前状态（v0.5 修 V27/V33，v0.6 G-2 修 V43①）**：干净机器上核心链路全部可用——
`project new` / `lit` 全系 / `idea` / `exp run` / `doctor` / `capabilities` /
**`server`（Web 工作台已内嵌，打开即用）**。前端产物在构建时经
`scripts/gen-frontend-embed.ts` 写入内嵌清单、运行期解包托管；源码模式与二进制
走同一条托管代码路径。

**仍只在源码 checkout 可用（V43②，二进制里是显式拒绝而非静默做错）**：

```
dist/spark-research new skill|connector|platform    ← 脚手架要写仓库源码树
dist/spark-research ext verify --kind platform      ← 同上
```

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

## 5. 环境变量命名：一律 `SPARK_RESEARCH_*` 前缀（v0.8 起旧名直接报错）

四个超时项的旧名在 v0.7 进入废弃周期（读到 warn 仍生效），**v0.8 起移除**：任一旧名被设置，任何命令启动时
`resolveSetting` 会直接抛错并指出新名——不会静默落回默认值，也不会 warn 后照用。把值原样搬到新名、`unset` 旧名即可。

| 旧名（v0.8 起报错） | 新名 |
| --- | --- |
| `SPARK_HTTP_TIMEOUT_MS` | `SPARK_RESEARCH_HTTP_TIMEOUT_MS` |
| `SPARK_LLM_TIMEOUT_MS` | `SPARK_RESEARCH_LLM_TIMEOUT_MS` |
| `SPARK_KERNEL_TIMEOUT_MS` | `SPARK_RESEARCH_KERNEL_TIMEOUT_MS` |
| `SPARK_TASK_TIMEOUT_MS` | `SPARK_RESEARCH_TASK_TIMEOUT_MS` |

全部配置项与对应环境变量：`spark-research config list`。
