// V27 收口：技能索引在单二进制里恒为空。
//
// `skillDirs()` 靠 `readdirSync(SKILLS_DIR)` **枚举目录**。`bun build --compile` 不打包
// 目录结构，`SKILLS_DIR`（= `import.meta.dir`）在产物里是 `/$bunfs/root`，`existsSync`
// 为假 → 返回 `[]` → `capabilities --json` 如实地报「技能 0 个」，而源码模式是 10 个。
//
// **这比 ENOENT 更糟**：ENOENT 是响亮的失败，这个是安静的错误答案——二进制会平静地
// 告诉外部 agent「我没有任何技能」，而这恰好是 AD-12（能力声称必须机器可核）要防的形状。
// 目录枚举没法靠单个静态 import 覆盖，所以这里把 10 份 SKILL.md 逐个静态 import 进来，
// 内容编译期入二进制。
//
// 解析顺序与 `agents/prompts.ts` 一致：**文件系统优先、内嵌兜底**——源码模式下改 SKILL.md
// 不用重新编译，显式传 root 的调用方（测试、扩展目录）行为一个字不变。
//
// 这张表由收口手工维护，但**不是"靠自觉"**：`tests/unit/embedded_skills.test.ts` 断言
// 它与磁盘上的目录集合逐字一致，新增或删除技能而忘了改这里，测试立刻变红。

import DryExperimentMd from "./dry-experiment/SKILL.md" with { type: "text" };
import IdeaCoexploreMd from "./idea-coexplore/SKILL.md" with { type: "text" };
import LibraryCurationMd from "./library-curation/SKILL.md" with { type: "text" };
import LiteratureReviewMd from "./literature-review/SKILL.md" with { type: "text" };
import LiteratureSearchMd from "./literature-search/SKILL.md" with { type: "text" };
import NoveltyCheckMd from "./novelty-check/SKILL.md" with { type: "text" };
import PaperDownloadMd from "./paper-download/SKILL.md" with { type: "text" };
import ProteinAnalysisMd from "./protein-analysis/SKILL.md" with { type: "text" };
import ResearchReportMd from "./research-report/SKILL.md" with { type: "text" };
import WetProtocolMd from "./wet-protocol/SKILL.md" with { type: "text" };

/** 技能名 → SKILL.md 原文。键集合与 backend/src/skills 下各技能目录的 SKILL.md 一致。 */
export const EMBEDDED_SKILLS: Readonly<Record<string, string>> = {
  "dry-experiment": DryExperimentMd,
  "idea-coexplore": IdeaCoexploreMd,
  "library-curation": LibraryCurationMd,
  "literature-review": LiteratureReviewMd,
  "literature-search": LiteratureSearchMd,
  "novelty-check": NoveltyCheckMd,
  "paper-download": PaperDownloadMd,
  "protein-analysis": ProteinAnalysisMd,
  "research-report": ResearchReportMd,
  "wet-protocol": WetProtocolMd,
};
