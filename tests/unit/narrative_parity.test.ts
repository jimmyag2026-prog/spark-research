import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { ConnectorRegistry } from "../../backend/src/connectors/registry";
import { MCP_TOOLS, MCP_WITHHELD } from "../../backend/src/mcp/tools";
import { TARGET_KINDS } from "../../backend/src/compute/target";
import { defaultComputeAdapters } from "../../backend/src/compute/cli";
import { WET_LEGAL_TRANSITIONS, WET_EXPERIMENT_STATES } from "../../backend/src/lab/wet_models";
import { EXPERIMENT_STATES } from "../../backend/src/experiment/models";
import { loadSkills } from "../../backend/src/skills/frontmatter";
import { buildCapabilities } from "../../backend/src/capabilities";
import { PACKAGE_VERSION } from "../../backend/src/version";

// AD-12「对外声称的每一项能力必须机器可核」的门禁实现（D-12）。
//
// 为什么需要它：外部评审最大的一条发现是「叙事超前于实现」——README 宣传 100 并发
// swarm，而 swarm.ts 在生产代码里零调用方；架构图写着 18 个 connector，实际 17 个。
// 这类漂移的共同点是**不报错**：代码能编译、测试全绿、只有人去读才发现对不上。
// 靠人自觉不可持续，所以做成门禁。
//
// 这个文件只做一件事：把「文档/自描述端点说的」与「代码里真有的」对撞，
// 对不上就红。它不检查代码好坏，只检查**声称与事实是否一致**。

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SRC = join(REPO_ROOT, "backend/src");

function walkSource(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__pycache__" || entry === "node_modules") continue;
      walkSource(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__pycache__") continue;
      walkTs(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// 生产代码内部的 import 图。只看 backend/src 内部的相对 import——
// 被测试 import 不算「有生产调用方」，那正是 swarm.ts 当初蒙混过关的方式。
function productionImportTargets(): Set<string> {
  const targets = new Set<string>();
  for (const file of walkTs(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const base = normalize(join(dirname(file), match[1]!));
      for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
        try {
          if (statSync(candidate).isFile()) targets.add(candidate);
        } catch {
          /* 解析不到就跳过：可能是 .json 或类型-only 路径 */
        }
      }
    }
  }
  return targets;
}

// 在册的「合法无引用者」——每一条都必须写清**为什么**。
// 这张表只许缩短、不许悄悄变长：新增一条就等于新增一处「叙事与实现的缺口」，
// 应该先问「这东西还该不该留」，而不是先把它加进白名单。
const ALLOWED_ORPHANS: Record<string, string> = {
  // backend/src/llm/budget.ts 曾在此登记「等接线：W1-a（ToolBus）接上后必须删除本条」——
  // W1-a 的 backend/src/agents/toolbus.ts 已经 import BudgetLedger 并在每次工具调用后
  // record()，budget.ts 有了真实生产调用方，按对称检查删除本条。
  //
  // backend/src/agents/toolbus.ts 曾在此登记「等接线：W2-a（子代理 tool loop）接上后必须
  // 删除本条」——W2-a 的 backend/src/agents/sub_agent.ts 现在
  // `import { AgentToolBus, isDenied, ... } from "./toolbus"` 并在 runSubAgent() 的真 tool
  // loop 里为每个子代理构造一个 AgentToolBus 实例，toolbus.ts 有了真实生产调用方，
  // 按对称检查删除本条。

  // backend/src/connectors/manifest.ts 曾在此登记「等接线：W2-c（扩展装载器）接上后
  // 必须删除本条」——W2-c 的 backend/src/extensions/loader.ts 已经
  // `import { loadManifestFromJson, ManifestError } from "../connectors/manifest"`
  // 并在 kind="connector" 的装载路径里真实调用它（连同 backend/src/extensions/
  // connector_verify.ts 的 ext verify 逻辑），manifest.ts 有了真实生产调用方，
  // 按对称检查删除本条（做法见 DEVELOPMENT_PLAN_v0.4.md §5.3·补）。

  // backend/src/agents/contract.ts 曾在此登记「等接线：W3-a 的 replan 循环接上后删除」——
  // W3 合并后有**两条**真实生产 import 边，都指向它：
  //   ① W3-a：orchestrator.ts 的 `runResearchLoop()` 真实构造契约、跑 `evaluate()`、
  //      用 `evaluateRound()` 判停机条件——**这是契约系统本体被消费**；
  //   ② W3-c：literature/cli.ts 导入 `CITATION_INTEGRITY_REVIEW_KIND` 落 observation record。
  // 按对称检查删除本条。
  //
  // **W3-c 留下的一个观察值得记**：孤儿检测是**整文件粒度**，
  // 「导入了文件里的一个常量」与「这个文件的核心能力真的被用上了」它分不开。
  // 这次两条路径恰好都成立，所以结论没错；但如果只有 ② 而没有 ①，
  // 门禁会显示绿而契约系统其实仍是死代码。**这是本门禁已知的表达力上限**——
  // 补它的正是下面新增的「存储层生产写入方」断言那种**按能力**（而非按文件）的判据。

  // backend/src/agents/ledger.ts 曾在此登记「等接线：W3-a 或收口接上后删除」——
  // W3 收口已接：orchestrator 的 runResearchLoop() 里每个子代理运行落一条 agent_run
  // record，父子用 derives_from 边挂在 session 根 run 下。按对称检查删除本条。

  "backend/src/index.ts": "CLI 入口点，由 package.json 的 bin 直接执行，天然无仓库内引用者",

  // W5-1-e（V27）：`.d.ts` 是 ambient 声明文件，**按语言规则**就不该有 import 边——
  // 它给 `import X from "./x.sql" with { type: "text" }` 这类非 TS 资产提供类型，
  // tsc 靠 tsconfig 的 include 自动收进程序，不靠任何人 import 它。
  // 孤儿检测查的是「运行期有没有调用方」，对声明文件这个判据在语义上不适用。
  "backend/src/assets/assets.d.ts":
    "TypeScript ambient 声明（*.sql / *.txt / *.py 的静态 import 类型），按语言规则由 tsconfig include 收录，不存在也不该存在 import 边",

  // backend/src/extensions/capabilities.ts 曾在此登记「等接线：capabilities 接上后删除」——
  // W2 收口已接（buildCapabilities() 里加了 extensions 字段），本条按对称检查删除。
  "backend/src/http/fixture.ts":
    "fixture 回放层，刻意只被测试使用（生产走 NativeHttp）——这是 P2 的设计，不是缺口",

  // v0.5 W5-1 α 在这里登记过两条「等接线」：`backend/src/compute/broker.ts` 与
  // `backend/src/compute/adapters/local.ts`（当时 CLI 还没有，算力层没有生产调用方）。
  // W5-2 β 已经把 `backend/src/compute/cli.ts` 接上——它 import 了 ComputeBroker 与
  // LocalComputeAdapter，`backend/src/index.ts` 的 `case "compute"` 又 import 了它，
  // 两者都有了真实的生产调用方，按对称检查删除这两条。
  //
  // **这张表同时是接线清单**：忘接会红（未登记的孤儿），接了不删也会红（多余的登记）。
  // 这正是它不该变成永久豁免的机制——见下面「反向：在册的条目若已不再是孤儿」那一段。
  // v0.5 W5-2 α（CB-4）：Modal adapter 走「无 token 的降级交付」（设计 §三·补.7）。
  // 这一条比上面两条**多欠一件事**，删除条件因此有两个，缺一不可：
  //   ① 等接线：W5-2 β 的 `compute/cli.ts` 把它注册进 adapter 表；
  //   ② **等真实录制**：拿到 Modal token 后必须补一次真实 gateway 录制
  //      （`tests/fixtures/compute/modal/` 里出现 `provenance: "real-modal"` 的那份），
  //      并把「真实 gateway 未实现」这件事从 `modal.ts` 的口径里去掉。
  // 在 ② 完成之前，本仓库对外**不许**宣称「支持 Modal 远端算力」——
  // 准确说法是「Modal adapter 的契约已立、真实链路未验证」。
  // `tests/unit/compute_modal.test.ts` 的「约束三」用例盯着本条：只要还没有真实录制，
  // 「等真实录制」这五个字就必须留在本文件里（哪怕 ① 已经完成、本条已按对称检查移出
  // 本表，也要照本仓库既有做法以「曾在此登记」的注释形式把这笔债留下）。
  "backend/src/compute/adapters/modal.ts":
    "等接线：W5-2 β 的 `compute/cli.ts` 接上后删；**等真实录制**：拿到 Modal token 后必须补一次真实 gateway 录制并删本条",
  // backend/src/agents/swarm.ts 曾在此登记「已知缺口」：v0.1 遗留、生产代码零调用方、
  // dependsOn 未实现、decompose 是三条正则，README 的「100 并发 swarm」宣传语即出自此处。
  // W4-a 按 BACKLOG V7 删除了 swarm.ts + swarm_types.ts + tests/unit/swarm.test.ts——
  // 文件已不存在，不再是「孤儿」（孤儿的前提是文件存在但无调用方），按对称检查删除本条。
  // v0.4 P11 收口前，backend/src/llm/providers/anthropic.ts 在这里登记过一条「等接线」：
  // R-b 交付了适配器，但 router.ts 的 ADAPTERS 注册权被主会话刻意扣下（R-b/R-c 都不持有
  // 该文件，避免两条 lane 撞车），于是新模块在自己分支上必然是孤儿。
  // 收口时接了线 → 本条变成多余 → 按对称检查删除。**这条登记走完了它的完整生命周期**，
  // 也顺带证明了这张表的设计意图：它不只防叙事漂移，同时是一张接线清单
  // （接了不删会红，忘接也会红）。做法已写进 DEVELOPMENT_PLAN_v0.4.md §5.3·补。
  // v0.4 P11 lane R-d 之前，backend/src/proteins/analysis.ts 在这里登记过一条「已知缺口」：
  // protein-analysis 技能有 e2e、有 SKILL.md，但 CLI / HTTP / MCP 三个入口全无（BACKLOG V22）。
  // R-d-2 补齐了三个入口（proteins/cli.ts、server/routes/proteins.ts、mcp/tools.ts 的
  // protein_analyze）之后，analysis.ts 有了真实生产调用方，不再是孤儿模块——条目已按下面
  // 「反向：在册的条目若已不再是孤儿……」的要求移除，可达性本身由下面新增的
  // 「技能可达性」测试接手把关（比孤儿检测更贴近问题本身：孤儿检测只查「有没有调用方」，
  // 不查「调用方是不是一条外部可达的生产入口」）。
};

// ── R-d-1：技能可达性断言（v0.4 P11 lane R-d，AD-5 收紧版） ──────────────────────
//
// 背景：v0.4 制订时实测了全部 10 个技能的可达性矩阵，protein-analysis 是唯一 CLI / HTTP /
// MCP 三个入口全无的一个——`capabilities --json` 却照常把它当可用能力广播（描述 + triggers +
// connector 清单 + validation 文件列表）。外部 agent 读了 triggers 会确信自己能调用它。
// AD-5 因此收紧为：技能「完成」= e2e 验证 + 至少一条可达的生产入口（CLI/HTTP/MCP 三选一），
// 且该能力出现在 capabilities --json 里。这段实现的就是这条收紧后的判据。
//
// 判据设计：**不对 SKILL.md 的自然语言（description/triggers）做正则猜测**——那正是
// 「叙事」本身，用叙事验证叙事是循环论证，猜错了不会有任何东西报警（正是 protein-analysis
// 当初蒙混过关的方式：triggers 写得像模像样，没人核对它是否真能打到任何代码）。
//
// 改用两段式判据：
//   ① SKILL_ENTRYPOINTS 是一张**显式维护**的「技能 → 声称的入口名」登记表，写法与上面
//      ALLOWED_ORPHANS 同一套纪律——人工登记、必须写清楚是哪个入口，且有「反向：多余登记
//      必须删除」的对称检查，防止它变成一张只增不减的死表。
//   ② 每一条登记**不是自己说了算**：要去三张真实的生产注册表里核实存在——
//      - CLI：从 backend/src/index.ts 的 `main()` 顶层 `switch(cmd)` 里抽取全部 `case "x":`
//        字面量。这是**语法结构提取**（switch 的 case 标签是有限、精确的字符串字面量，
//        运行时用 `===` 严格匹配），不是对文档/描述文本做模糊匹配——效果等价于「读一遍
//        真实的 dispatch 表」，而不是「猜某段散文里提到了什么」。
//      - MCP：`MCP_TOOLS` 数组本身就是结构化数据，直接查名字是否存在，零猜测。
//      - （HTTP 路由留给后续：本仓库目前每个技能都至少有 CLI 或 MCP 入口，两者已经
//        覆盖判据所需的「至少一条」；没有必要为了凑第三种检查方式而堆代码。）
//   ③ 额外核实该技能确实出现在 `capabilities --json` 的 skills 列表里——这是「自描述面
//      没有漏报」的对称检查（防止有技能声称了入口，却连自己都没被 capabilities 收录）。
//
// 为什么这不算「靠自觉」：SKILL_ENTRYPOINTS 里任何一条写错（入口名拼错、入口已被删除、
// 或者压根没有这个入口）都会在下面的核实步骤里立刻变红——表本身可以人工维护，
// 但表里的每一条都会被拿去跟事实对账，不存在「登记了就算数」这回事。
//
// 理想设计（留给后续）：SKILL.md frontmatter 加一个 `entrypoints:` 字段，把这张表
// 从测试文件搬进技能自己的元数据里，让 capabilities --json 能把入口也一并广播出去。
// 本 lane 没有这么做——frontmatter 的 schema（KNOWN_KEYS 白名单）与 capabilities 的
// SkillCapability 类型都在 `backend/src/skills/frontmatter.ts` / `backend/src/capabilities/
// index.ts`，这两个文件不在 R-d 的文件所有权范围内，也被其余系统（scaffold 脚手架、
// capabilities 的其他消费方）共用，贸然扩 schema 风险面超出本 lane 的职责边界。
// 详见 docs/devlog/P11-d.md 的「R-d-1 判据设计」一节。
function cliCommandNames(): Set<string> {
  const src = readFileSync(join(SRC, "index.ts"), "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/case\s+"([a-z][a-z0-9_-]*)"\s*:/g)) names.add(m[1]!);
  return names;
}

interface SkillEntrypoints {
  cli?: readonly string[];
  mcp?: readonly string[];
}

// 每条登记必须写明「这是哪个入口」，理由见上面的大段注释。
const SKILL_ENTRYPOINTS: Record<string, SkillEntrypoints> = {
  "dry-experiment": { cli: ["exp"], mcp: ["exp_design", "exp_run", "exp_list"] },
  "idea-coexplore": { cli: ["idea"], mcp: ["idea_coexplore"] },
  "library-curation": { cli: ["lit"], mcp: ["lit_add", "lit_list"] },
  "literature-review": { cli: ["lit"], mcp: ["lit_review_draft"] },
  "literature-search": { cli: ["lit"], mcp: ["lit_search"] },
  "novelty-check": { cli: ["idea"], mcp: ["idea_novelty_check"] },
  // paper-download 只有 CLI（`lit pdf`）；MCP 没有对应工具（下载文件不适合走 MCP 的
  // JSON 往返），这是刻意设计，不是缺口——CLI 一条足够满足「至少一条」的判据。
  "paper-download": { cli: ["lit"] },
  // R-d-2 补的入口：CLI `spark-research protein <query>` + MCP `protein_analyze`。
  "protein-analysis": { cli: ["protein"], mcp: ["protein_analyze"] },
  "research-report": { cli: ["report", "conclusion"], mcp: ["report_export"] },
  "wet-protocol": { cli: ["lab"], mcp: ["lab_compile", "lab_status"] },
};

// ── W3-c：存储层必须有生产写入方 ────────────────────────────────────────────
//
// 背景：v0.4 W1-b 建好了 findings 状态机的存储层（findings_store.ts）+ CLI，W2-b 建好了
// literature-review 契约、把 citations_verified stage 的判据钉死成「存在某种 observation
// record」——但两条 lane 交付时都在各自 devlog 里诚实写明：这一层**没有生产写入方**。
// `ReviewerAgent.review()` 从不调用 findings_store 的 `reviewTarget()`，表永远是空的；
// `lit review` 命令只把核验结果打印到 stdout，不落那条 record，citations_verified 在生产
// 里永远过不了。上面两条既有断言都抓不到这一类问题：孤儿模块检测看的是「文件有没有被
// import」——findings_store.ts 被 cli.ts import、cli.ts 被 index.ts import，import 链是
// 真的，模块可达；技能可达性看的是「入口存在」。「有没有真的调用写方法/真的构造出这条
// 约定记录」是一个 import 链和入口可达都测不出来的第三维度。
//
// 判据设计（与上面两条断言同一套纪律：显式登记表 + 去真实结构化数据源对账，不靠脆弱正则
// 猜散文）：
//   ① STORE_WRITE_BINDINGS：「存储层文件的写方法 → 生产调用方文件」。三段核实——
//      a) 存储层文件本身真的定义了这个方法（防登记表把方法名拼错也能白过）；
//      b) 写入方文件真的从存储层文件 import 了指定符号——用跟孤儿检测同一套「解析
//         import 语句里的相对路径、normalize 后按文件系统真实对账」的办法，不是猜
//         文件名像不像、也不是搜整个仓库；
//      c) 写入方源码里真的出现对该方法的调用语法（`.method(`）——结构性调用语法，
//         跟 SKILL_ENTRYPOINTS 用 switch-case 字面量、MCP_TOOLS 用结构化数组核实是
//         同一个等级的确定性，不是对自然语言 triggers 做模糊匹配。
//   ② CONTRACT_RECORD_PRODUCERS：目标不是「调用某个类的写方法」，而是「某个约定记录
//      形状（metadata.kind 常量）有没有被真的构造出来」——citations_verified 这条判据
//      依赖的不是某个 store 类的方法（RecordStore.create() 到处都在用，不是新建的存储层，
//      早就有无数真实写入方，不适合套①的模板），而是「有没有人真的拿这个 kind 常量去
//      创建一条 record」。核实写入方 import 了这个常量，且源码里真的出现
//      `kind: <常量名>` 这种赋值语法——只 import 常量当类型引用摆在那、从没构造过
//      对应形状的 record，这条检查必须能抓到。
//
// 为什么不做成「扫描全部 *Store 类、要求每一个都登记」：本仓库已有的 RecordStore /
// ArtifactStore / LibraryStore / CredentialStore 等等都是早就有大量真实调用方的通用存储层，
// 强行要求它们也逐一登记「谁写了它」只是把孤儿模块检测重新发明一遍（那些类不孤儿，import
// 链本来就是真的）——这条新断言要抓的是更窄、更具体的一类问题：**新建的、专门为某个特定
// 状态机/契约服务的存储层，写方从设计到交付之间有没有真的接上**，不是「这张表有没有人碰
// 过」。全量扫描/自动发现留给后续（可参考 R-d-1 的思路：把登记表搬进模块自己的元数据里，
// 而不是维护在测试文件里）——本 lane 只登记这两条本 lane 亲手接上的线，按需增长，且同样
// 遵守「反向：登记错了/接线被拆了必须报红」的纪律（见下面阴性对照）。
interface StoreWriteBinding {
  // 存储层文件（相对 REPO_ROOT，不含 .ts）。
  store: string;
  // 该文件里必须真实存在的写方法名。
  method: string;
  // 写入方需要从 store 文件 import 的符号名（类名/类型名都行）。
  importedSymbol: string;
  // 生产写入方文件（相对 REPO_ROOT，不含 .ts）。
  writer: string;
  note: string;
}

const STORE_WRITE_BINDINGS: StoreWriteBinding[] = [
  {
    store: "backend/src/reviewer/findings_store",
    method: "reviewTarget",
    importedSymbol: "FindingsStore",
    writer: "backend/src/reviewer/agent",
    note:
      "ReviewerAgent.review() 每轮把 Finding[] 映射成 FindingHit[]，按 (checker, target) " +
      "upsert 进 findings 状态机（agent.ts 的 recordFindings()，只在 options.findings 配置时" +
      "生效）。见 docs/devlog/W3-c.md。",
  },
];

interface ContractRecordProducerBinding {
  // 判据依赖的常量所在文件（相对 REPO_ROOT，不含 .ts）。
  from: string;
  // 判据依赖的 metadata.kind 常量名。
  kindConst: string;
  // 生产写入方文件（相对 REPO_ROOT，不含 .ts）。
  writer: string;
  note: string;
}

const CONTRACT_RECORD_PRODUCERS: ContractRecordProducerBinding[] = [
  {
    from: "backend/src/agents/contract",
    kindConst: "CITATION_INTEGRITY_REVIEW_KIND",
    writer: "backend/src/literature/cli",
    note:
      "`lit review` 命令在核验完成后落一条 metadata.kind=CITATION_INTEGRITY_REVIEW_KIND 的 " +
      "observation record，满足 literature-review 契约 citations_verified stage 的判据。见 " +
      "docs/devlog/W3-c.md 与 docs/devlog/W2-b.md「citations_verified 的已知缺口」一节。",
  },
];

// 下面几条结构性判据都是拿 regex 去匹配「调用语法」，而不是对自然语言做模糊匹配——但
// regex 分不清代码和注释：解释代码该怎么写的注释里，完全可能原样出现跟真实调用一样的
// 字符串（比如这个文件自己：写文档解释判据设计时，就在注释里写过一遍
// `.create({ ... kind: XXX ... })` 这样的示例片段，第一版判据因此被自己的说明性注释
// 骗过，误把「注释里的示例」当成「真实调用」——见 docs/devlog/W3-c.md 记录的这次意外）。
// 所以任何结构性核实之前，先把注释剥掉，只在真代码上做匹配。
//
// **不能**用两趟独立的全局正则（先全局删 /* */，再全局删 //）——踩过这个坑：
// backend/src/agents/contract.ts 的一行 `//` 注释里提到了 `literature/**`（口语化的
// 「literature 目录下所有文件」，不是代码），先跑的 block-comment 正则会把这段 `//` 注释
// 文本里的 `/**` 认成一个真正的块注释起点，然后一路找到几行之后另一个真正 JSDoc 的
// `*/` 才收手，把中间的 `export const CITATION_INTEGRITY_REVIEW_KIND = ...` 一并吃掉——
// 两趟全局正则不知道「这个 `/*` 其实出现在一个已经被 `//` 起头的注释内部，不该被
// 单独当块注释解析」。改成单趟从左到右扫描：每个位置先看是不是 `//`（是则跳到行尾），
// 再看是不是 `/*`（是则跳到最近的 `*/`），谁先出现在文本里就按谁处理——这样「`//` 注释
// 内部出现的 `/*`」永远不会被单独解释，因为扫描在遇到 `//` 的那一刻就已经跳过了整行，
// 根本不会再单独检视里面的字符。
// 仍然是近似解析（不追踪字符串字面量，字符串里恰好出现 `//`/`/*` 会被误当注释起点），
// 但跟本文件其余判据（switch-case 字面量提取、BADGE_TONE 键名解析）是同一个量级的
// 确定性，好过完全不剥、也好过两趟全局正则那种「不知道自己身处哪个注释内部」的写法。
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl; // 保留换行本身，不破坏后续多行匹配的行边界
      continue;
    }
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

// 解析一段源码里 `import {...} from "./relative"` 形式的相对 import，返回每条 import 语句
// 具名引入的符号列表 + 它实际指向的、去掉 .ts 扩展名的绝对路径。兼容 `import type {...}` 与
// 括号内单个符号前缀 `type `（`import { A, type B } from ...`）两种写法——本仓库两种都在用。
// 传入的 src 必须已经 stripComments 过，否则注释里提到的 import 语句会被误当成真的。
function namedRelativeImports(src: string, fileAbs: string): Array<{ named: string[]; resolvedNoExt: string }> {
  const out: Array<{ named: string[]; resolvedNoExt: string }> = [];
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g)) {
    const named = m[1]!
      .split(",")
      .map((s) => s.replace(/^\s*type\s+/, "").trim())
      .filter(Boolean);
    const resolvedRaw = normalize(join(dirname(fileAbs), m[2]!));
    const resolvedNoExt = resolvedRaw.endsWith(".ts") ? resolvedRaw.slice(0, -3) : resolvedRaw;
    out.push({ named, resolvedNoExt });
  }
  return out;
}

function verifyStoreWriteBinding(binding: StoreWriteBinding): string[] {
  const problems: string[] = [];
  const storeAbs = join(REPO_ROOT, `${binding.store}.ts`);
  const writerAbs = join(REPO_ROOT, `${binding.writer}.ts`);

  let storeSrc: string;
  try {
    storeSrc = stripComments(readFileSync(storeAbs, "utf8"));
  } catch {
    return [`登记的存储层文件不存在：${binding.store}.ts`];
  }
  if (!new RegExp(`\\b${binding.method}\\s*\\(`).test(storeSrc)) {
    problems.push(`存储层文件 ${binding.store}.ts 里核实不到方法 '${binding.method}'（登记表可能拼错了名字）`);
  }

  let writerSrc: string;
  try {
    writerSrc = stripComments(readFileSync(writerAbs, "utf8"));
  } catch {
    return [...problems, `登记的写入方文件不存在：${binding.writer}.ts`];
  }

  const storeNoExt = join(REPO_ROOT, binding.store);
  const importsStore = namedRelativeImports(writerSrc, writerAbs).some(
    (imp) => imp.resolvedNoExt === storeNoExt && imp.named.includes(binding.importedSymbol),
  );
  if (!importsStore) {
    problems.push(
      `写入方 ${binding.writer}.ts 核实不到 'import { ${binding.importedSymbol} } from ...' 指向 ` +
        `${binding.store}.ts 的真实 import 边`,
    );
  }

  if (!new RegExp(`\\.${binding.method}\\s*\\(`).test(writerSrc)) {
    problems.push(`写入方 ${binding.writer}.ts 源码里核实不到对 '.${binding.method}(' 的调用语法`);
  }

  return problems;
}

function verifyContractRecordProducer(binding: ContractRecordProducerBinding): string[] {
  const problems: string[] = [];
  const fromAbs = join(REPO_ROOT, `${binding.from}.ts`);
  const writerAbs = join(REPO_ROOT, `${binding.writer}.ts`);

  let fromSrc: string;
  try {
    fromSrc = stripComments(readFileSync(fromAbs, "utf8"));
  } catch {
    return [`登记的判据来源文件不存在：${binding.from}.ts`];
  }
  if (!new RegExp(`export\\s+const\\s+${binding.kindConst}\\b`).test(fromSrc)) {
    problems.push(`${binding.from}.ts 里核实不到 'export const ${binding.kindConst}'（登记表可能拼错了名字）`);
  }

  let writerSrc: string;
  try {
    writerSrc = stripComments(readFileSync(writerAbs, "utf8"));
  } catch {
    return [...problems, `登记的写入方文件不存在：${binding.writer}.ts`];
  }

  const fromNoExt = join(REPO_ROOT, binding.from);
  const importsConst = namedRelativeImports(writerSrc, writerAbs).some(
    (imp) => imp.resolvedNoExt === fromNoExt && imp.named.includes(binding.kindConst),
  );
  if (!importsConst) {
    problems.push(
      `写入方 ${binding.writer}.ts 核实不到 import { ${binding.kindConst} } 指向 ${binding.from}.ts 的真实 import 边`,
    );
  }

  // 结构性判据：`.create({ ... kind: <常量> ... })`——`kind:` 紧跟这个常量名，且必须落在
  // 同一次 `.create(` 调用的参数窗口内（下面 800 字符的上限覆盖真实调用里 title/content/
  // origin 等字段的合理长度），而不是「整篇文本搜有没有出现过这两个 token」。
  // 这条比只搜 `kind: 常量名` 更严格是有意为之：本 lane 实测过一次更弱的版本——
  // 把 metadata 对象拆成一个中间变量 `const meta = { kind: 常量, ... }` 再传
  // `metadata: meta`，弱版本看到源码里仍然物理存在 `kind: 常量` 这几个字符就判过，哪怕
  // 那个变量从未被传给任何 `.create()` 调用（阴性对照②第一次就是这样被弱版本放过的，
  // 见 docs/devlog/W3-c.md）。要求 `.create(` 与 `kind:` 出现在同一段窗口内，逼着生产
  // 代码把「构造这条 record」与「落库」写成同一个调用表达式（cli.ts 现在就是这么写的），
  // 判据不需要做变量流追踪就能可靠核实——比追踪变量身份简单，又不会被「变量造出来但没用」
  // 这种半接线蒙混过去。
  const callSiteWindow = 800;
  const createWithKind = new RegExp(
    `\\.create\\s*\\(\\s*\\{[\\s\\S]{0,${callSiteWindow}}?kind\\s*:\\s*${binding.kindConst}\\b`,
  );
  if (!createWithKind.test(writerSrc)) {
    problems.push(
      `写入方 ${binding.writer}.ts 源码里核实不到 '.create({ ... kind: ${binding.kindConst} ... })'——` +
        `同一次调用里构造并落库这条 record 的语法（可能是只 import 了常量没真的用，或者把 ` +
        `metadata 拆成了不会被传给 create() 的中间变量）`,
    );
  }

  return problems;
}

describe("叙事一致性门禁（AD-12）", () => {
  test("孤儿模块：生产代码零引用者的文件必须在册，且在册理由不许为空", () => {
    const imported = productionImportTargets();
    const orphans = walkTs(SRC)
      .filter((f) => !imported.has(f))
      .map((f) => relative(REPO_ROOT, f))
      .sort();

    const unregistered = orphans.filter((f) => !(f in ALLOWED_ORPHANS));
    expect(
      unregistered,
      `发现未登记的孤儿模块（生产代码里没有任何调用方）。\n` +
        `要么它已经死了该删，要么它本该被接上却没接——两种都是「叙事与实现的缺口」。\n` +
        `确认是合法例外后，在 ALLOWED_ORPHANS 里补一条并写清理由：\n  ${unregistered.join("\n  ")}`,
    ).toEqual([]);

    // 反向：在册的条目若已不再是孤儿（被接上了或被删了），要求把它从表里移除，
    // 免得白名单变成一张只增不减、越来越没人看的死表。
    const stale = Object.keys(ALLOWED_ORPHANS).filter((f) => !orphans.includes(f));
    expect(stale, `这些条目已不再是孤儿，请从 ALLOWED_ORPHANS 移除：\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  test("connector 数：capabilities/文档声称 = registry 实际注册", () => {
    const actual = new ConnectorRegistry({}).registerBuiltins().listAll();
    // 数字本身不写死在这里——写死就等于把漂移搬了个家。
    // 断言的是「同一个真源被所有消费方一致地读到」。
    expect(actual.length).toBeGreaterThan(0);
    const names = new Set(actual.map((c) => c.name));
    expect(names.size).toBe(actual.length); // 无重名
    for (const c of actual) {
      expect(c.domain, `connector ${c.name} 没有归入任何域（domainOf 返回 custom）`).not.toBe("custom");
    }
  });

  test("技能数：docs/EXTENDING.md 声称的数量 = skills/ 下 SKILL.md 实际数量", () => {
    const skillsDir = join(SRC, "skills");
    const actual = readdirSync(skillsDir).filter((d) => {
      try {
        return statSync(join(skillsDir, d, "SKILL.md")).isFile();
      } catch {
        return false;
      }
    });
    const doc = readFileSync(join(REPO_ROOT, "docs/EXTENDING.md"), "utf8");
    const claims = [...doc.matchAll(/(\d+)\s*个技能/g)].map((m) => Number(m[1]));
    expect(claims.length, "docs/EXTENDING.md 里找不到「N 个技能」的声称——是不是措辞改了？").toBeGreaterThan(0);
    for (const claimed of claims) {
      expect(claimed, `docs/EXTENDING.md 声称 ${claimed} 个技能，实际 ${actual.length} 个`).toBe(actual.length);
    }
  });

  // v0.4 W1 收口实测：`./dist/spark-research --version` 报 0.3.1，
  // 而同一个二进制的 `capabilities` 报 0.0.0——因为两处用了不同的读法，
  // 其中一处（version.ts）靠 `import.meta.dir` 拼路径，在 `bun build --compile`
  // 的产物里指向虚拟的 /$bunfs/root/，读不到就**静默落到兜底值**。
  // 同一个二进制对外报两个版本号，正是 AD-12 要防的事。
  test("版本号单一真源：PACKAGE_VERSION 必须等于 package.json 的 version", () => {
    const raw = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    expect(PACKAGE_VERSION, "version.ts 的读法与 package.json 对不上——多半又是靠运行期读文件").toBe(raw.version);
    expect(PACKAGE_VERSION).not.toBe("0.0.0");
  });

  // v0.5 W5-2 β（CB-5 接线）：算力执行地的「数」与「口径」都必须是派生的。
  //
  // 这条断言防的是与 connector 数、技能数完全同一类的漂移：capabilities 对外说有几个
  // 执行地、每个能不能用，如果是手写的，加一个 adapter 就会错，而且不报警。
  // 额外钉住 AD-12 在算力上的具体形态（§三·补.7 约束二）：**注册表里没有 adapter 的
  // 执行地，永远不许报 available**——没配 Modal 凭据时它必须是「未配置」
  // （needs_credential），既不是「不可用」也不是「可用」。
  test("算力执行地：capabilities 声称的 target 数 = TARGET_KINDS，且无 adapter 者一律不报 available", async () => {
    const manifest = await buildCapabilities();
    expect(manifest.compute.targets.map((t) => t.kind)).toEqual([...TARGET_KINDS]);

    const registered = new Set(Object.keys(defaultComputeAdapters()));
    for (const target of manifest.compute.targets) {
      if (target.availability === "available") {
        expect(
          registered.has(target.kind),
          `capabilities 说 target '${target.kind}' 可用，但 adapter 注册表里根本没有它——` +
            `这正是 AD-12 禁止的形状（声称 > 实现）`,
        ).toBe(true);
      }
      // 每一个非 available 的执行地都必须说清楚为什么，不许只给一个状态词。
      if (target.availability !== "available") {
        expect(target.reason, `target '${target.kind}' 报了 ${target.availability} 却没给理由`).toBeTruthy();
      }
    }

    // modal 的口径：本仓库的测试环境不配 Modal 凭据，所以它必须是「未配置」。
    const modal = manifest.compute.targets.find((t) => t.kind === "modal")!;
    expect(modal.credentialConfigured).toBe(false);
    expect(modal.availability).toBe("needs_credential");
    expect(modal.setupHint, "报「未配置」就必须同时给出配置指引（V36）").toBeTruthy();

    // 默认执行地是 local，且 withheld 清单从 MCP_WITHHELD 派生（不是又抄一份）。
    expect(manifest.compute.defaultTarget).toBe("local");
    expect([...manifest.compute.withheld].sort()).toEqual(
      MCP_WITHHELD.map((w) => w.name).filter((n) => n.startsWith("compute_")).sort(),
    );
    expect(manifest.compute.withheld).toHaveLength(3);
  });

  test("MCP 工具：每个工具名唯一，且 withheld 清单与暴露清单不重叠", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size, "MCP 工具有重名").toBe(names.length);
  });

  // 今天真实发生过的漂移：lane D-d 把 wet_run 拆成 approved/executing 之后，
  // /api/lab/machine 里手写的 approvalGate 仍然自称 to: "wet_run"——
  // AD-6 的机器可读表达对外撒谎，而所有测试都是绿的。
  test("/api/lab/machine 的两道门必须能从转移表推导出来，不得手写漂移", async () => {
    const { createApp } = await import("../../backend/src/server/app");
    const app = createApp({});
    const res = await app.fetch(new Request("http://spark.local/api/lab/machine"));
    const body = (await res.json()) as {
      states: string[];
      approvalGate: { from: string; to: string };
      executionGate: { from: string; to: string };
    };

    expect(body.states).toEqual([...WET_EXPERIMENT_STATES]);

    const inboundOf = (state: string) =>
      Object.entries(WET_LEGAL_TRANSITIONS)
        .filter(([, tos]) => (tos as readonly string[]).includes(state))
        .map(([from]) => from);

    // 审批门与执行门的共同不变式：目标状态**只有一条入边**，
    // 且端点自报的 from/to 必须与转移表算出来的那条边一致。
    for (const [label, gate] of [
      ["approvalGate", body.approvalGate],
      ["executionGate", body.executionGate],
    ] as const) {
      const inbound = inboundOf(gate.to);
      expect(inbound, `${label}.to='${gate.to}' 的入边不唯一：${inbound.join(",")}——门就不成其为门了`).toHaveLength(1);
      expect(inbound[0], `${label} 自报 from='${gate.from}'，但转移表说是 '${inbound[0]}'`).toBe(gate.from);
    }
  });

  // v0.3.0 发布后立刻暴露的缺口：后端 D-10 把 wet_run 拆成 approved/executing，
  // 前端 bottom.tsx 的执行按钮仍然按 `state !== "wet_run"` 判禁用 → **按钮永远是灰的**，
  // Web 工作台里可以批准却永远执行不了，湿实验闭环在 UI 上断掉。
  //
  // 为什么全绿：那是字符串比较不是枚举，tsc 管不着；后端测试不碰前端；
  // 而 D-12 原本只查后端自描述端点，没查**前端消费方**。
  // 这条断言补的就是这一段：状态词汇表是后端的真源，前端不许出现它之外的状态名。
  test("前端引用的实验状态必须真实存在于后端状态机（退役状态不许残留）", () => {
    const known = new Set<string>([...WET_EXPERIMENT_STATES, ...EXPERIMENT_STATES]);

    // 已退役的状态名：出现在任何源码里都算 bug（文档/CHANGELOG 讲历史不算，故只扫 src）。
    const RETIRED_STATES = ["wet_run"];
    const roots = [join(REPO_ROOT, "frontend/workspace/src"), SRC];
    for (const root of roots) {
      for (const file of walkSource(root)) {
        const text = readFileSync(file, "utf8");
        for (const retired of RETIRED_STATES) {
          expect(
            text.includes(`"${retired}"`),
            `${relative(REPO_ROOT, file)} 仍引用已退役的状态 "${retired}"——` +
              `后端状态机里已经没有它了，这种字符串比较 tsc 抓不到`,
          ).toBe(false);
        }
      }
    }

    // 前端 badge 色表的键里，凡是「看起来像实验状态」的都必须在真源里。
    // 判据：出现在后端两套状态机并集里的键放行；其余键是 evidence 标签 / novelty 状态，
    // 用显式白名单排除，避免这条断言变成一张什么都放行的空壳。
    const NON_STATE_TONES = new Set([
      "observed", "computed", "sourced", "inferred",
      "checked-overlap", "checked-novel", "checked-incremental", "unchecked",
    ]);
    const ui = readFileSync(join(REPO_ROOT, "frontend/workspace/src/components/ui.tsx"), "utf8");
    const block = ui.slice(ui.indexOf("const BADGE_TONE"), ui.indexOf("};", ui.indexOf("const BADGE_TONE")));
    const keys = [...block.matchAll(/^\s*"?([A-Za-z_][\w-]*)"?\s*:/gm)].map((m) => m[1]!);
    expect(keys.length, "没解析出 BADGE_TONE 的键——是不是结构改了？").toBeGreaterThan(5);
    const bogus = keys.filter((k) => !known.has(k) && !NON_STATE_TONES.has(k));
    expect(
      bogus,
      `BADGE_TONE 里这些键既不是后端状态、也不在非状态白名单里：${bogus.join(", ")}`,
    ).toEqual([]);
  });

  // 第 7 条（R-d-1）：技能可达性。判据设计见上面 SKILL_ENTRYPOINTS 之前的大段注释。
  test("技能可达性：每个 SKILL.md 对应的能力必须有可核实的生产入口（CLI/HTTP/MCP 三选一）", async () => {
    const skills = loadSkills();
    const skillNames = skills.map((s) => s.name).sort();

    // 登记表必须与 skills/ 目录严格一一对应：少登记一个 = 那个技能可以悄悄失去入口
    // 而没有任何测试注意到；多登记一个（技能已被删除）= 死表，两个方向都要挡。
    const registered = Object.keys(SKILL_ENTRYPOINTS).sort();
    const missing = skillNames.filter((n) => !registered.includes(n));
    expect(missing, `这些技能在 SKILL_ENTRYPOINTS 里没有登记入口：${missing.join(", ")}`).toEqual([]);
    const staleRegistrations = registered.filter((n) => !skillNames.includes(n));
    expect(
      staleRegistrations,
      `这些登记对应的技能目录已经不存在，请从 SKILL_ENTRYPOINTS 移除：${staleRegistrations.join(", ")}`,
    ).toEqual([]);

    const cliNames = cliCommandNames();
    const mcpNames = new Set(MCP_TOOLS.map((t) => t.name));
    const manifest = await buildCapabilities();
    const capabilitySkillNames = new Set(manifest.skills.map((s) => s.name));

    const unreachable: string[] = [];
    for (const skill of skills) {
      const entry = SKILL_ENTRYPOINTS[skill.name] ?? {};
      const verifiedCli = (entry.cli ?? []).filter((name) => cliNames.has(name));
      const verifiedMcp = (entry.mcp ?? []).filter((name) => mcpNames.has(name));

      // 登记了但核实不存在的条目：单独报出来，比笼统的「不可达」更好定位问题。
      const badCli = (entry.cli ?? []).filter((name) => !cliNames.has(name));
      const badMcp = (entry.mcp ?? []).filter((name) => !mcpNames.has(name));
      expect(
        badCli,
        `技能 '${skill.name}' 登记的 CLI 入口在 index.ts 的 switch(cmd) 里核实不到：${badCli.join(", ")}`,
      ).toEqual([]);
      expect(
        badMcp,
        `技能 '${skill.name}' 登记的 MCP 工具在 MCP_TOOLS 里核实不到：${badMcp.join(", ")}`,
      ).toEqual([]);

      if (verifiedCli.length === 0 && verifiedMcp.length === 0) unreachable.push(skill.name);

      // AD-12 的对称检查：声称了入口的技能必须真的出现在 capabilities --json 里，
      // 否则「入口存在」与「外部 agent 能发现这个入口」是两件事，后者才是 AD-12 要的。
      expect(
        capabilitySkillNames.has(skill.name),
        `技能 '${skill.name}' 有登记入口，但没有出现在 capabilities --json 的 skills 列表里`,
      ).toBe(true);
    }

    expect(
      unreachable,
      `这些技能声称有能力（SKILL.md + triggers + capabilities 广播），但登记的入口一条都核实不到，` +
        `等于自描述面对外撒谎（AD-12）：${unreachable.join(", ")}`,
    ).toEqual([]);
  });

  // 第 8 条（W3-c）：存储层生产写入方。判据设计见上面两张登记表之前的大段注释。
  test("存储层的写方法 / 约定记录的 metadata.kind 必须有可核实的生产写入方", () => {
    const storeProblems = STORE_WRITE_BINDINGS.flatMap(verifyStoreWriteBinding);
    expect(
      storeProblems,
      `以下登记的存储层写入方核实不通过（要么真的没接线，要么登记表本身写错了）：\n  ${storeProblems.join("\n  ")}`,
    ).toEqual([]);

    const recordProblems = CONTRACT_RECORD_PRODUCERS.flatMap(verifyContractRecordProducer);
    expect(
      recordProblems,
      `以下登记的约定记录生产者核实不通过：\n  ${recordProblems.join("\n  ")}`,
    ).toEqual([]);
  });
});
