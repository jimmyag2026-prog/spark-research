#!/usr/bin/env bun
// Playwright e2e 的被测服务（不是测试文件，bun test 不会收它）。
//
// 它就是**生产的那个 app**，只是把三处外部依赖换成回放/假件：
//   - 文献检索 → tests/fixtures/literature 的 cassette（P2/P4 真实录制）
//   - LLM      → 按 prompt 分派的脚本化 fake（不打任何模型 API）
//   - 湿实验后端 → MockDeviceBackend（不需要装 opentrons）
// 干实验用的是**真的** pyref（零依赖、秒级），所以那段是真跑不是打桩。
//
// 用法：bun tests/e2e/fixture_server.ts <port> <workspaceRoot>

import { MockDeviceBackend } from "../../backend/src/lab/wet_backend";
import { libraryKeyIndex } from "../../backend/src/literature/export";
import { LibraryStore } from "../../backend/src/literature/library";
import type { LiteratureSearcher } from "../../backend/src/literature/search";
import { ProjectManager } from "../../backend/src/project/manager";
import { startServer } from "../../backend/src/server/server";
import { CASSETTES, SEARCH_QUERY, searcherWith } from "../helpers/literature_scenario";
import { PUBLISHED_CLAIM, ScriptedLlm, candidatesByClaim, noveltySearcher } from "../helpers/ideation_scenario";
import { cardJson } from "../helpers/review_scenario";

const port = Number(process.argv[2] ?? 4399);
const root = process.argv[3];
if (!root) {
  console.error("用法: bun tests/e2e/fixture_server.ts <port> <workspaceRoot>");
  process.exit(2);
}

const projects = new ProjectManager(root);

// V88 e2e：新建项目时把这个字符串放进项目描述（`projectContext`），批量精读的
// prompt 就会带上它——下面包一层 delay，只在命中它时人为拖慢单次调用。目的是让
// 3 篇精读的 done/total 中间态跨过任务面板 2s 的轮询间隔，稳定露出来（不这样做的话，
// ScriptedLlm 是纯同步分派，3 篇精读实际耗时 <10ms，面板两次轮询之间大概率直接从
// 0 跳到 3，看不出「逐篇回传」这件事本身——即便 V88 的接线是对的）。不影响其余用例：
// 没有这个 marker 的项目描述，调用照旧同步返回。
export const READING_PROGRESS_MARKER = "w88-reading-progress-marker";

// 当前项目文献库的 bibtex key。co-explore 的卡必须引用库内 key（P4 硬门），
// 而 key 要等入库之后才知道，所以每次调用时现查。
function currentLibraryKeys(): string[] {
  const slug = projects.currentSlug();
  if (!slug) return [];
  const project = projects.open(slug);
  const library = new LibraryStore(project.paths.libraryDb, { records: project.records() });
  try {
    return libraryKeyIndex(library.list()).keys;
  } finally {
    library.close();
    project.close();
  }
}

const baseLlm = new ScriptedLlm([
  // ① co-explore：产出 Idea 卡（必须引到库内 key，且至少一条反面证据）
  (user) => {
    if (!user.includes("可用引用 key 白名单")) return null;
    const keys = currentLibraryKeys();
    if (keys.length < 2) return null;
    return JSON.stringify({
      critique:
        `这条思路的关键假设是注意力足以替代循环结构[@${keys[0]}]；` +
        `但同一批工作也提示评测口径本身不稳定[@${keys[1]}]。你打算怎么证伪它？（inferred）`,
      hypothesis: "用 Transformer 的自注意力完全替代循环结构做序列转导",
      supporting: [{ key: keys[0], note: "同一范式下的代表性结果" }],
      contradicting: [{ key: keys[1], note: "该工作提示结论对评测口径敏感" }],
      openQuestions: ["在长序列与低资源设定下是否同样成立"],
    });
  },
  // ② novelty claim 提取
  (user) =>
    user.includes("待验证点")
      ? JSON.stringify({ claims: [{ statement: PUBLISHED_CLAIM.statement, queries: PUBLISHED_CLAIM.queries }] })
      : null,
  // ③ novelty 对比评级（只能引 prompt 里真实检索到的候选）
  (user) => {
    if (!user.includes("候选工作")) return null;
    const candidates = candidatesByClaim(user).get("c1") ?? [];
    const hit =
      candidates.find((c) => c.title.toLowerCase().includes(PUBLISHED_CLAIM.expectTitle)) ?? candidates[0];
    if (!hit) return JSON.stringify({ claims: [] });
    return JSON.stringify({
      claims: [
        {
          claimId: "c1",
          rating: "existing",
          verdict: "见最近邻对比",
          nearestWorks: [
            {
              key: hit.key,
              sameness: "同样用自注意力替代循环结构做序列转导",
              difference: "本 claim 没有提出任何新机制",
            },
          ],
        },
      ],
    });
  },
  // ④ 精读卡
  (user) => (user.includes("精读") || user.includes("结构化精读卡") ? cardJson() : null),
  // ⑤ 综述草稿：只引库内 key（生成器会用白名单卡住越界 key）
  (user) => {
    if (!user.includes("精读卡") && !user.includes("综述")) return null;
    const keys = currentLibraryKeys();
    if (keys.length === 0) return null;
    return (
      `# 蛋白结构预测方法综述\n\n` +
      `近年来端到端预测方法成为主线 [@${keys[0]}]。` +
      (keys[1] ? ` 与之互补的评测工作提示结论对口径敏感 [@${keys[1]}]。` : "")
    );
  },
]);

// `baseLlm` 本身是同步分派（见 ideation_scenario.ts 的 ScriptedLlm）；这里包一层只在
// prompt 命中 READING_PROGRESS_MARKER 时插入延迟，其余调用原样透传，不改变现有用例
// 的时序。
const llm = {
  call: (...args: Parameters<typeof baseLlm.call>) => {
    const messages = args[0];
    const user = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    if (user.includes(READING_PROGRESS_MARKER)) {
      // 面板轮询间隔是 2000ms（TasksView，center.tsx）——延迟必须明显大于它，否则两次
      // 轮询之间可能直接从 done=0 跳到 done=2，把 1/3 这个中间态漏采样掉（不是 bug，
      // 只是采样点没对上）。2600ms 留了 30% 冗余。
      return new Promise((resolve) => setTimeout(resolve, 2600)).then(() => baseLlm.call(...args));
    }
    return baseLlm.call(...args);
  },
  listModels: baseLlm.listModels,
};

// 两个 cassette 按 query 分派：播文献库用 alphafold 的，novelty 密集检索用它自己的。
class DualCassetteSearcher {
  private library = searcherWith(CASSETTES.search, "replay");
  private novelty = noveltySearcher("replay");

  search: LiteratureSearcher["search"] = (query, options) =>
    (query === SEARCH_QUERY ? this.library : this.novelty).search(query, options);

  fetchById: LiteratureSearcher["fetchById"] = (id, options) => this.library.fetchById(id, options);
}

const server = startServer(port, {
  root,
  projects,
  llm,
  searcher: new DualCassetteSearcher() as unknown as LiteratureSearcher,
  wetBackend: new MockDeviceBackend(),
});

console.log(`e2e fixture server ready on ${server.port}`);
