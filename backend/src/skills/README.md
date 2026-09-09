# 技能目录（Skills）

本地优先加载的 instruction bundle（DESIGN §2.2 第 4 条、AD-5）。

## 目录结构

```
backend/src/skills/
  <skill-name>/
    SKILL.md          必需：YAML frontmatter + 工作流说明
    scripts/          可选：技能专用脚本
    references/       可选：按需加载的长文档（不预填 context）
```

## SKILL.md frontmatter 字段（P9 规范化，schema 由 CI 校验）

真源：`backend/src/skills/frontmatter.ts`；校验门：`tests/unit/skill_frontmatter.test.ts`。

| 字段 | 必需 | 类型 | 说明 |
|------|------|------|------|
| `name` | 是 | kebab-case | 必须与目录名一致（不一致直接报错） |
| `description` | 是 | 字符串 | 一段话说清「做什么 + 何时用」，agent 靠它决定是否加载。≥40 字符 |
| `category` | 是 | 枚举 | `literature` / `ideation` / `experiment` / `report` |
| `domain` | 是 | A-E | 对应 DESIGN 的五大功能域，可用 `/` 连接（如 `C/E`） |
| `triggers` | 是 | 数组 | **用户说什么时该加载这个技能**。机器可读，是 agent 选技能的第一判据；至少一条 |
| `connectors` | 是 | 数组 | 依赖哪些 connector（id 必须真实存在）。不依赖外部数据源写 `[]` |
| `platforms` | 否 | 数组 | 依赖哪些仿真平台（id 必须真实存在） |
| `validation` | 是 | 数组 | 配套验证的测试文件路径。**CI 会去磁盘核对文件是否存在**——AD-5 从一句口号变成一道门 |
| `allowed-tools` | 否 | 数组 | 该技能预期用到的工具 |

解析器只支持 YAML 的一个极小子集（标量 + 单行数组），刻意不引入 YAML 依赖：
frontmatter 复杂到需要真 YAML 解析器时，说明它已经不适合当「读几行就懂」的索引了。
未知字段一律拒绝——拼错的 `trigger:`（少个 s）静默失效比报错糟糕得多。

新建技能用脚手架，别手抄：`spark-research new skill <name>`。

## 纪律（AD-5：少而深）

- **每个技能必须有配套验证才算完成**，SKILL.md 末尾的「验证方式」小节要指向真实存在的测试文件。
- 技能文档写「怎么组合已有能力」和「什么情况下不该做什么」，不写能力本身的实现——实现在 `backend/src/` 里，文档漂移了以代码为准。
- 反模式小节是必需的：说清边界比说清用法更能防止 agent 越界。

## 当前技能

| 技能 | 域 | 状态 |
|------|-----|------|
| literature-search | A | P2 落地 |
| paper-download | A | P2 落地 |
| library-curation | A | P2 落地 |
| literature-review | A | P3 落地 |
| idea-coexplore | A | P4 落地 |
| novelty-check | D | P4 落地 |
| protein-analysis | B | P5 落地 |
| dry-experiment | B | P5 落地 |
| wet-protocol | B | P6 落地 |
| research-report | C/E | P8 落地 |
