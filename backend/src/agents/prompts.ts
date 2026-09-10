// V27 · agent prompt（`backend/src/agents/prompt/*.txt`）的内嵌副本。
//
// 三个调用点原本各自 `readFileSync(join(<某个 import.meta.dir 推出来的目录>, filename))`：
//   * `orchestrator.ts` 的 `loadPrompt()`（core.txt / research.txt）
//   * `sub_agent.ts` 的 `loadPromptFile()`（explore / literature / execute / lab / reviewer）
//   * `ideation/coexplore.ts` 的 `loadCoExplorePrompt()`（coexplore.txt）
// 在 `bun build --compile` 产物里这些目录全是 `/$bunfs/...`，读不到——前两处的降级是
// 把 system prompt 悄悄换成 `[prompt missing: x.txt]`（**静默降智**，比崩溃更难发现），
// 第三处直接抛错。
//
// 修法：把八个 prompt 用 `with { type: "text" }` 静态 import 进来，编译期入二进制。
//
// 解析顺序刻意是 **文件系统优先、内嵌兜底**：
//   * 调用方显式传了 promptDir（测试、扩展、将来的用户自定义 prompt 目录）时行为一个字不变；
//   * 源码模式下读的仍然是磁盘上那份，改 prompt 不用重新编译；
//   * 只有磁盘那份读不到（= 单二进制）才落到内嵌副本。
// 反过来（内嵌优先）会让"传自定义 promptDir"这个既有能力失效，那是拿一个 bug 换另一个。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import coexploreTxt from "./prompt/coexplore.txt" with { type: "text" };
import coreTxt from "./prompt/core.txt" with { type: "text" };
import executeTxt from "./prompt/execute.txt" with { type: "text" };
import exploreTxt from "./prompt/explore.txt" with { type: "text" };
import labTxt from "./prompt/lab.txt" with { type: "text" };
import literatureTxt from "./prompt/literature.txt" with { type: "text" };
import researchTxt from "./prompt/research.txt" with { type: "text" };
import reviewerTxt from "./prompt/reviewer.txt" with { type: "text" };

/**
 * 文件名 → prompt 正文。key 必须与 `backend/src/agents/prompt/` 下的文件名一一对应；
 * 漏一个的后果是那个子代理在单二进制里静默降智，所以
 * `tests/unit/embedded_assets.test.ts` 有一条断言把两边钉死。
 */
export const EMBEDDED_PROMPTS: Readonly<Record<string, string>> = Object.freeze({
  "coexplore.txt": coexploreTxt,
  "core.txt": coreTxt,
  "execute.txt": executeTxt,
  "explore.txt": exploreTxt,
  "lab.txt": labTxt,
  "literature.txt": literatureTxt,
  "research.txt": researchTxt,
  "reviewer.txt": reviewerTxt,
});

/** prompt 目录的规范位置（源码模式下是真目录；编译产物里读不到，靠内嵌兜底）。 */
export const DEFAULT_PROMPT_DIR = join(import.meta.dir, "prompt");

/**
 * 读一个 prompt：先试 `dir` 下的真文件，读不到再落内嵌副本；两者都没有才返回 null。
 * 返回 null 的语义仍是"这个 prompt 不存在"——调用方原有的报错/降级路径不变。
 */
export function readPromptText(dir: string, filename: string): string | null {
  try {
    return readFileSync(join(dir, filename), "utf8");
  } catch {
    // 落到内嵌副本。这里刻意不区分 ENOENT / EACCES / EISDIR：
    // 任何"磁盘上这份拿不到"的情形，内嵌副本都是比 `[prompt missing]` 更好的答案。
  }
  return EMBEDDED_PROMPTS[filename] ?? null;
}
