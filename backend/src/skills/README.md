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

## SKILL.md frontmatter 字段

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | 是 | 与目录名一致 |
| `description` | 是 | 一段话说清「做什么 + 何时用」，agent 靠它决定是否加载 |
| `category` | 是 | 归类（literature / experiment / review …） |
| `domain` | 是 | 对应 DESIGN 的五大功能域 A-E |
| `allowed-tools` | 否 | 该技能预期用到的工具 |

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
