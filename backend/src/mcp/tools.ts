// MCP 工具定义（P9 交付物 5）。
//
// ── 三条设计判断，先读这段再改代码 ───────────────────────────────────────────
//
// 判断一：**危险动作不暴露为 MCP tool**。
//   `lab approve` / `lab reject` / `lab simulate` / `conclusion review` 一律不做成工具。
//   理由不是「怕出错」，是 AD-6 的字面含义：物理世界的操作不自动化审批。
//   如果外部 agent 能调 approve，它就能自己编译协议、自己批准、自己执行——
//   approve gate 退化成一句注释。`conclusion review` 同理：结论能否进报告结论区
//   是可信度的最后一道闸，不交给外部 agent 自评。
//   MCP 层的正确表达是 `lab_compile` 停在 awaiting_approval 并**把人拉回环里**：
//   返回体里写清「需要人执行哪条命令」。清单见本文件末尾的 `MCP_WITHHELD`，
//   它同时会出现在 `capabilities` 输出里——让外部 agent 一眼看到边界，而不是试了才知道。
//
// 判断二：**描述按「LLM 第一次见就会用」写**。每条 description 必须含四段：
//   ①什么时候该调（不是「做什么」）②真实值参数示例 ③何时**不**该用 ④典型组合链路。
//   反面教材：`"Search literature. Args: query (string)"`。
//
// 判断三：**长任务默认同步等待**。P7 的 HTTP 层是 202 + 句柄语义，那是给浏览器的；
//   外部 agent 的心智应当是「调用 → 拿结果」。所以这里提交后自己轮询到落定，
//   只有超过 `mcpTimeoutMs` 才降级成返回句柄 + 提示改用 `task_status`。
//   不把 202 的复杂度甩给调用方。
//
// 实现纪律：每个工具都只是**对 P7 HTTP 端点的一次调用**（`request()` 返回方法+路径+body），
// 由 `server.ts` 用同一个 Hono app 在进程内 fetch。MCP 层不重实现任何业务逻辑——
// 重实现意味着 CLI / HTTP / MCP 三套口径，迟早对不上。

// 收口(W5-1)：源清单从 `DEFAULT_SEARCH_SOURCES` 派生，不再手写。
// 这里原本写死「并发查 OpenAlex / CrossRef / Europe PMC / Semantic Scholar」，
// V34 修完默认集变成 6 个之后，这段给外部 agent 看的能力声明就低报了实际行为——
// 手写副本本身就是 V34 的病根，所以改的不是数字，是取值方式。
import { DEFAULT_SEARCH_SOURCES } from "../literature/models";

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface McpRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: Record<string, unknown>;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  // 走 P7 的任务句柄语义（202）：由 MCP 层轮询到落定后再返回。
  longRunning?: boolean;
  request(args: Record<string, unknown>): McpRequest;
  // 结果加工：把「下一步该做什么」写进返回体（尤其是需要人来做的那一步）。
  present?(payload: unknown, args: Record<string, unknown>): unknown;
}

function str(description: string, example?: string): Record<string, unknown> {
  return example ? { type: "string", description, examples: [example] } : { type: "string", description };
}

function num(description: string, example?: number): Record<string, unknown> {
  return { type: "number", description, ...(example !== undefined ? { examples: [example] } : {}) };
}

function strList(description: string, example?: string[]): Record<string, unknown> {
  return {
    type: "array",
    items: { type: "string" },
    description,
    ...(example ? { examples: [example] } : {}),
  };
}

const PROJECT_ARG = str(
  "项目 slug。不给就用当前项目（与 CLI 的 `spark-research project open` 选中的那个一致）。",
  "gpcr-allostery",
);

function withProject(path: string, args: Record<string, unknown>): string {
  const slug = typeof args.project === "string" && args.project.trim() !== "" ? args.project.trim() : null;
  if (!slug) return path;
  return path + (path.includes("?") ? "&" : "?") + `project=${encodeURIComponent(slug)}`;
}

export const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: "research_capabilities",
    description: `【何时调】接入 Spark Research 后的第一次调用，或任何时候你不确定「有哪些文献源可用 / 哪些仿真平台装好了 / 有哪些技能」。一次调用即可 introspect 整个工作台。
【参数示例】{"probe": true} —— probe 会真去 spawn 子进程问「openmm / opentrons 装了没」，多花几秒但结果可信；不给 probe 时平台可用性是 "unknown"。
【何时不该用】不要在每次工具调用前都调一遍——能力清单在一次会话里不会变，调一次记住即可。
【典型链路】research_capabilities → 看 connectors 里哪些是 available → lit_search（用可用的源）。
【读法】connectors[].availability 有四档：available / needs_credential（要 key 但没配，检索时会被 skip 而不是报错）/ placeholder（占位实现，调用会失败）/ unavailable。caveat 字段是已知的坑（例如 Semantic Scholar 匿名请求实测持续 429）。`,
    inputSchema: {
      type: "object",
      properties: {
        probe: {
          type: "boolean",
          description: "是否真去探测本地仿真平台与湿实验后端的安装情况（慢几秒，但结果是真的）",
        },
      },
      additionalProperties: false,
    },
    request: (args) => ({ method: "GET", path: `/api/capabilities${args.probe === true ? "?probe=1" : ""}` }),
  },

  {
    name: "project_list",
    description: `【何时调】开始任何研究工作之前，先确认「现在在哪个课题下」。Spark Research 是 project-centric 的：文献库、思路库、实验、结论都挂在项目下，选错项目等于写进别人的实验记录本。
【参数示例】{"all": true} 连已归档的一起列。
【何时不该用】只想知道当前项目时不必列全部——返回体里的 current 字段就是。
【典型链路】project_list → （没有合适的）project_create → 之后所有工具默认作用在当前项目上。`,
    inputSchema: {
      type: "object",
      properties: { all: { type: "boolean", description: "是否包含已归档项目" } },
      additionalProperties: false,
    },
    request: (args) => ({ method: "GET", path: `/api/projects${args.all === true ? "?all=1" : ""}` }),
  },

  {
    name: "project_create",
    description: `【何时调】用户提出一个**新课题**（不是新问题、不是新会话）时。判据：这批文献、思路、实验是否要和已有项目分开积累？要，就新建。
【参数示例】{"slug": "gpcr-allostery", "name": "GPCR 变构位点预测", "description": "用 MD + 序列共进化找 β2AR 的隐藏变构口袋"}
【何时不该用】同一课题的第二个子问题不要新建项目——那会把证据图切碎，novelty check 与报告都只能看到半张图。
【典型链路】project_create → lit_search --add → idea_coexplore → idea_novelty_check。`,
    inputSchema: {
      type: "object",
      properties: {
        slug: str("项目短名（小写 kebab-case，作为目录名与所有工具的 project 参数）", "gpcr-allostery"),
        name: str("显示名称", "GPCR 变构位点预测"),
        description: str("一两句话说清课题要回答什么问题（会进研究报告的开头）", "用 MD + 序列共进化找 β2AR 的隐藏变构口袋"),
        setCurrent: { type: "boolean", description: "创建后是否设为当前项目（默认 true）" },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    request: (args) => ({ method: "POST", path: "/api/projects", body: args }),
  },

  {
    name: "project_use",
    description: `【何时调】要在一个已存在的项目下工作，且不想每次都传 project 参数时。
【参数示例】{"slug": "gpcr-allostery"}
【何时不该用】只做一次跨项目查询时——直接给那次调用传 project 参数更安全，不会把用户的当前项目切走（用户可能正在另一个项目里工作）。
【典型链路】project_list → project_use → records_timeline（看这个课题最近发生了什么）。
【副作用】这会改变 CLI 与工作台看到的「当前项目」，是一个用户可见的全局状态变更，切之前最好说一声。`,
    inputSchema: {
      type: "object",
      properties: { slug: str("要切换到的项目 slug", "gpcr-allostery") },
      required: ["slug"],
      additionalProperties: false,
    },
    request: (args) => ({ method: "POST", path: "/api/projects/current", body: args }),
  },

  {
    name: "lit_search",
    description: `【何时调】需要摸清某个问题上的已有工作时；为综述或创新性核验准备候选池时。${DEFAULT_SEARCH_SOURCES.length} 个源并发检索（${DEFAULT_SEARCH_SOURCES.join(" / ")}；配了凭据还有 AMiner），按 DOI 与标题模糊匹配去重合并。
【参数示例】{"query": "allosteric site prediction molecular dynamics GPCR", "limit": 20, "add": true, "tags": ["background"]}
【何时不该用】① 已经拿到确定的 DOI/arXiv id 只想入库 → 用 lit_add。② 不要把用户的一整句话直接当 query——先拆成 2-4 个核心概念，每个概念查一次。③ 不要 add: true 一次灌几百条，入库是显式动作。
【典型链路】lit_search(add=false) 先看候选 → 挑选后 lit_search(add=true) 或 lit_add → lit_read_cards → lit_review_draft。
【必读返回字段】sources[] 里每个源有 outcome：ok / skipped（没配凭据或该源不认这个 id，**不是失败**）/ failed（真失败）。有 failed 就必须在回答里说明「覆盖面不全」——把失败静默吞掉后声称「已全面检索」是本工作台明令禁止的行为。`,
    longRunning: true,
    inputSchema: {
      type: "object",
      properties: {
        query: str("检索式。用英文关键词组合，不要整句自然语言", "allosteric site prediction molecular dynamics"),
        sources: strList("限定文献源；不给则用全部默认源", [...DEFAULT_SEARCH_SOURCES].slice(0, 3)),
        limit: num("每源返回上限", 20),
        add: { type: "boolean", description: "是否直接把结果入项目文献库（默认 false，先看后入）" },
        tags: strList("入库时打的标签（仅 add=true 时生效）", ["background"]),
        project: PROJECT_ARG,
      },
      required: ["query"],
      additionalProperties: false,
    },
    request: (args) => ({ method: "POST", path: withProject("/api/lit/search", args), body: args }),
  },

  {
    name: "lit_add",
    description: `【何时调】已经有确定的标识符（DOI / arXiv id / PMID），想把这一篇放进项目文献库时。入库会自动去重合并，并在证据图里建一个 type=paper 的锚点，后续所有引用都指向它。
【参数示例】{"identifier": "10.1038/s41586-021-03819-2", "tags": ["method"]}
【何时不该用】只有标题没有标识符时——先 lit_search 拿到 DOI 再入库，否则会入一条元数据残缺的记录。
【典型链路】lit_search → 挑出要精读的几篇 → lit_add → lit_read_cards。`,
    longRunning: true,
    inputSchema: {
      type: "object",
      properties: {
        identifier: str("DOI / arXiv id / PMID", "10.1038/s41586-021-03819-2"),
        sources: strList("从哪些源解析该标识符", ["crossref", "openalex"]),
        tags: strList("入库标签", ["method"]),
        project: PROJECT_ARG,
      },
      required: ["identifier"],
      additionalProperties: false,
    },
    request: (args) => ({ method: "POST", path: withProject("/api/lit/papers", args), body: args }),
  },

  {
    name: "lit_list",
    description: `【何时调】要知道项目文献库里已经有什么（写综述前、判断某篇是否已入库、找 bibtexKey 时）。
【参数示例】{"tag": "background", "status": "unread"}
【何时不该用】要找库**外**的论文时——那是 lit_search。
【典型链路】lit_list → 看哪些 readingStatus 还是 unread → lit_read_cards。
【关键字段】bibtexKey 是写引用时唯一合法的 key 形式（[@key]）；引用库外 key 会被 citation-integrity 判为伪造引用并 veto。`,
    inputSchema: {
      type: "object",
      properties: {
        tag: str("按标签过滤", "background"),
        status: str("按阅读状态过滤：unread / reading / read", "unread"),
        q: str("标题/作者关键词模糊过滤", "allosteric"),
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    request: (args) => {
      const params = new URLSearchParams();
      for (const key of ["tag", "status", "q"]) {
        const value = args[key];
        if (typeof value === "string" && value !== "") params.set(key, value);
      }
      const qs = params.toString();
      return { method: "GET", path: withProject(`/api/lit/papers${qs ? `?${qs}` : ""}`, args) };
    },
  },

  {
    name: "lit_read_cards",
    description: `【何时调】文献入库之后、写综述之前。为每篇论文生成结构化精读卡（问题/方法/结论/局限/与本项目关系），卡片是证据图里的 reading record，综述的每一句话都要能追到某张卡。
【参数示例】{"all": true, "tag": "background"} 批量精读某个标签下的全部论文；或 {"paperId": "a1b2c3d4"} 只精读一篇。
【何时不该用】库里还没有论文时（先 lit_search --add）；只想看已有卡片时用 lit_list 的 readingCards。
【典型链路】lit_search(add=true) → lit_read_cards(all=true) → lit_review_draft。
【代价提示】每篇一次模型调用，20 篇就是 20 次——先用 tag 收窄范围。
【增量语义（v0.2.1）】all=true 批量精读**默认跳过已有精读卡的论文**：中途超时重跑不会把已读的重烧一遍模型调用。想强制重生成（换了模型或改了 prompt）传 redoRead=true；若目标全部已读会明确报「都已经有精读卡了」，不静默空跑。`,
    longRunning: true,
    inputSchema: {
      type: "object",
      properties: {
        paperId: str("单篇精读时给论文 id（支持前 8 位前缀）", "a1b2c3d4"),
        all: { type: "boolean", description: "批量精读（与 tag 组合收窄范围）；默认跳过已有精读卡的论文" },
        tag: str("批量精读时按标签过滤", "background"),
        redoRead: {
          type: "boolean",
          description: "强制重新生成已有精读卡的论文（默认 false：批量精读跳过已读，避免重试时重烧模型调用）",
        },
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    request: (args) => ({ method: "POST", path: withProject("/api/lit/read", args), body: args }),
  },

  {
    name: "lit_review_draft",
    description: `【何时调】精读卡已经齐了，要产出一份带真实引用的综述草稿时。生成后立即跑 citation-integrity 核验，返回体里 vetoed=true 表示草稿里有伪造引用或库外引用——**那份草稿不能拿去用**，要先修引用。
【参数示例】{"topic": "变构位点预测方法的演进"}
【何时不该用】库里精读卡为零时（会直接报错）；想让模型「凭知识写综述」时——本工具的引用只允许指向项目文献库内的论文，这是刻意的。
【典型链路】lit_read_cards → lit_review_draft → 若 vetoed 则看 citation.findings 逐条修 → 再跑一次。
【返回读法】citation.findings 里 severity=hard 的是必须修的（库外 key）；soft 是提示（陈述与卡片冲突 / 强断言无引用），由人判断。`,
    longRunning: true,
    inputSchema: {
      type: "object",
      properties: {
        topic: str("综述主题；不给则按项目描述组织", "变构位点预测方法的演进"),
        judge: { type: "boolean", description: "是否启用 LLM 辅助的「真 key 假内容」判定（默认 true）" },
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    request: (args) => ({ method: "POST", path: withProject("/api/lit/review", args), body: args }),
  },

  {
    name: "lit_export",
    description: `【何时调】要把项目文献库交给写作工具（LaTeX / Zotero）时。
【参数示例】{"format": "bibtex", "tag": "cited"}
【何时不该用】只想在对话里列几篇论文时——用 lit_list，导出是给文件用的。
【典型链路】lit_review_draft → lit_export(bibtex) → 交给论文模板。
【返回形态】不是 JSON 而是文本内容（content 字段里是 .bib 原文）。bibtexKey 与综述草稿里的 [@key] 完全一致，读者可以直接对照。`,
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["bibtex", "csl"], description: "导出格式" },
        tag: str("只导出某个标签下的论文", "cited"),
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    request: (args) => {
      const format = typeof args.format === "string" ? args.format : "bibtex";
      const tag = typeof args.tag === "string" && args.tag ? `&tag=${encodeURIComponent(args.tag)}` : "";
      return { method: "GET", path: withProject(`/api/lit/export?format=${encodeURIComponent(format)}${tag}`, args) };
    },
  },

  {
    name: "idea_coexplore",
    description: `【何时调】用户抛出一个研究想法、想被挑毛病、想判断方向值不值得做时。这不是「附和式头脑风暴」：产出的 Idea 卡**强制**包含至少一条反对证据，每条观点要么给库内 bibtexKey，要么显式标 inferred。
【参数示例】{"message": "我想用 MD 轨迹的互信息找 β2AR 的隐藏变构口袋，比序列共进化更直接", "persist": true}
【何时不该用】① 文献库为空时先做检索——库空时返回体里 emptyLibrary=true，那一轮的观点全是推断，不要当成有文献支撑的判断。② 多轮讨论的中间轮用 persist=false，别把每一轮都落成一张卡。
【读法】落库后返回体顶层有 ideaId（也可从 stored.recordId 取，两者相同），直接把它传给 idea_novelty_check 即可。
【典型链路】lit_search(add=true) → idea_coexplore(persist=true) → idea_novelty_check。`,
    longRunning: true,
    inputSchema: {
      type: "object",
      properties: {
        message: str("研究想法或要被批判的陈述，写具体", "用 MD 轨迹的互信息找 β2AR 的隐藏变构口袋"),
        sessionId: str("多轮共探时传同一个 sessionId 以保持上下文", "coexplore-2026-09"),
        persist: { type: "boolean", description: "是否把这一轮的 Idea 卡落库（默认 true；中间轮建议 false）" },
        project: PROJECT_ARG,
      },
      required: ["message"],
      additionalProperties: false,
    },
    request: (args) => ({ method: "POST", path: withProject("/api/ideas", args), body: args }),
  },

  {
    name: "idea_list",
    description: `【何时调】要看项目里已经有哪些想法、哪些还没做过创新性核验时。
【参数示例】{"status": "unchecked"} 找出还没查过新颖性的想法。
【何时不该用】要看某一条的完整证据边时——用 record_get 展开证据图。
【典型链路】idea_list(status=unchecked) → idea_novelty_check（逐条查）。
【状态读法】unchecked / checked-novel / checked-incremental / checked-overlap。注意：查过但没查出结论的会**维持 unchecked**，报告指针仍写回——「查过没结论」与「没查过」在数据上是分得开的。`,
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["unchecked", "checked-novel", "checked-incremental", "checked-overlap"],
          description: "按 novelty 状态过滤",
        },
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    request: (args) => {
      const status = typeof args.status === "string" && args.status ? `?status=${encodeURIComponent(args.status)}` : "";
      return { method: "GET", path: withProject(`/api/ideas${status}`, args) };
    },
  },

  {
    name: "idea_novelty_check",
    description: `【何时调】一个想法成形后、投入实验之前，问「有没有人做过 / 我们新在哪」时。流程是：抽 claim → 每条 claim 多路检索真实文献 → 逐条列最近邻 + 相同点 + 不同点 + 评级。
【参数示例】{"ideaId": "3f2a1b0c", "perSource": 5}
【何时不该用】① 想法还很模糊时——claim 抽不出来，结论会是「不可用」。② 不要把本工具的评级当作最终判断：模型给的评级会被一层确定性代码按检索结果校正（存在高相似候选却评 novel 会被升级为 existing），报告里两个评级都列出，要看校正后的那个。
【典型链路】idea_coexplore → idea_novelty_check → 若 checked-overlap 则回到 idea_coexplore 换角度。
【返回读法】conclusive=false 表示「查过但没查出结论」（例如一条候选都没检到）——**检索不到不等于新颖**，这是本工作台明确拒绝的推理。`,
    longRunning: true,
    inputSchema: {
      type: "object",
      properties: {
        ideaId: str("Idea 卡的 record id（支持前缀）", "3f2a1b0c"),
        sources: strList("限定检索源", ["openalex", "semanticscholar"]),
        perSource: num("每个检索式每源取多少候选", 5),
        project: PROJECT_ARG,
      },
      required: ["ideaId"],
      additionalProperties: false,
    },
    request: (args) => {
      const id = String(args.ideaId ?? "");
      return { method: "POST", path: withProject(`/api/ideas/${encodeURIComponent(id)}/check`, args), body: args };
    },
  },

  {
    name: "exp_design",
    description: `【何时调】要把一个假设变成可执行的干实验（in silico）算例时。只建实验记录、不开始跑（状态停在 design）。
【参数示例】{"title": "水盒子平衡 300K", "platform": "openmm", "kind": "water-box-md", "params": {"steps": 5000, "boxSizeNm": 2.0}, "hypothesis": "2 nm 盒子在 5 ps 内可达到温度平衡"}
【何时不该用】不知道有哪些平台/kind/参数时——先 research_capabilities 看 simulationPlatforms（每个平台的 kinds 与 deterministic 位都在里面）。参数写错会在 design 阶段就被拒，不会让你跑完才发现。
【典型链路】research_capabilities → exp_design → exp_run。
【平台选择】pyref 零依赖、确定性（deterministic=true，结论可做逐位对账）；openmm 是真实 MD 但 CPU 上不逐位复现（deterministic=false，下游结论必须按「区间/趋势对账」措辞）。`,
    inputSchema: {
      type: "object",
      properties: {
        title: str("实验标题", "水盒子平衡 300K"),
        platform: { type: "string", enum: ["pyref", "openmm"], description: "仿真平台" },
        kind: str("任务种类（见 capabilities 里该平台的 kinds）", "water-box-md"),
        params: { type: "object", description: "平台参数；写错会在 design 阶段被拒", additionalProperties: true },
        hypothesis: str("这个算例要验证的假设", "2 nm 盒子在 5 ps 内可达到温度平衡"),
        project: PROJECT_ARG,
      },
      required: ["title"],
      additionalProperties: false,
    },
    request: (args) => ({ method: "POST", path: withProject("/api/experiments", args), body: args }),
  },

  {
    name: "exp_run",
    description: `【何时调】exp_design 建好之后，真正提交算例并等结果时。跑完自动回收产出进 artifact、生成 observation record 并进入 analyze 状态。
【参数示例】{"experimentId": "9c8b7a6d", "note": "第一轮基线"}；进程中断后重连用 {"experimentId": "9c8b7a6d", "resume": true}。
【何时不该用】① 实验已经 concluded 时（状态机会拒绝）。② 想直接下结论时——conclude 参数只在这一轮确实得到结论时才给，别用它跳过分析。
【典型链路】exp_design → exp_run → record_get（看 observation）→ 需要结论时 exp_run 的 conclude 参数或另起一轮。
【超时行为】MD 任务可能跑几分钟。超过配置的等待上限会返回任务句柄，之后用 task_status 查。
【句柄的有效范围（重要）】任务句柄存在 **server 进程内存里**，只在**当前这条 MCP 连接存活期间**有效。连接断开后 taskId 就查不到了。
  但干实验的**状态真源在磁盘上**（AD-4）——所以新连接里用 exp_list 找到该实验，再 exp_run 带 resume 接回来即可，进度不会丢。
【想避免超时】**两个上限要一起调**，只调一个没用：
  · SPARK_RESEARCH_MCP_TIMEOUT_MS=900000 —— MCP 工具同步等待的上限（也可 spark-research config set mcpTimeoutMs 900000）
  · SPARK_TASK_TIMEOUT_MS=900000 —— 任务本身的生命周期上限，**默认只有 600000（10 分钟）**，超过它任务会被结构化地判为超时失败
  只调大前者而不调后者，任务仍会在 10 分钟被掐掉，你等到的是一个超时失败。`,
    longRunning: true,
    inputSchema: {
      type: "object",
      properties: {
        experimentId: str("实验 record id（支持前缀）", "9c8b7a6d"),
        resume: { type: "boolean", description: "断点续跑：任务还在跑就接回来，已丢失则标 failed 可重试" },
        note: str("写进 analyze 记录的备注", "第一轮基线"),
        conclude: str("若这一轮直接得到结论，给出结论陈述（会落一张 pending 的结论卡）", "2 nm 盒子在 5 ps 内温度已平衡"),
        timeoutMs: num("单次 run 的等待上限（毫秒）", 600000),
        project: PROJECT_ARG,
      },
      required: ["experimentId"],
      additionalProperties: false,
    },
    request: (args) => {
      const id = String(args.experimentId ?? "");
      return { method: "POST", path: withProject(`/api/experiments/${encodeURIComponent(id)}/run`, args), body: args };
    },
  },

  {
    name: "exp_list",
    description: `【何时调】要看项目里的干实验都在什么状态时（哪些还没跑、哪些失败了可重试）。
【参数示例】{"state": "failed"}
【何时不该用】要看湿实验时——那是 lab_status，干湿是两张分开的状态机，状态名不通用。
【典型链路】exp_list(state=failed) → 看 recoverable → exp_run(resume=true)。
【失败读法】failed 且 recoverable=true 通常是「任务随编排进程一起被杀」，重跑即可；recoverable=false 是算例本身跑挂了，要改参数而不是重试。`,
    inputSchema: {
      type: "object",
      properties: {
        state: str("按状态过滤：design / dry_run / collect / analyze / concluded / iterated / failed", "failed"),
        platform: str("按平台过滤", "pyref"),
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    request: (args) => {
      const params = new URLSearchParams();
      for (const key of ["state", "platform"]) {
        const value = args[key];
        if (typeof value === "string" && value !== "") params.set(key, value);
      }
      const qs = params.toString();
      return { method: "GET", path: withProject(`/api/experiments${qs ? `?${qs}` : ""}`, args) };
    },
  },

  {
    name: "protein_analyze",
    description: `【何时调】要确定「这个蛋白有没有实验结构、分辨率多少、AlphaFold 预测置信度多高」时，或者准备跑干实验（MD / 对接）之前要先选定拿哪个构象做起点时——本工具是 exp_design 的前置。一次调用串联三步：UniProt 查询确定唯一身份 → RCSB PDB 取实验结构元数据（方法/分辨率/发布年份）→ AlphaFold 取预测模型与全局 pLDDT，给出「拿哪个结构去做下游计算」的判断。
【参数示例】{"query": "hemoglobin subunit beta AND organism_id:9606 AND reviewed:true"} —— UniProt 检索语法；查询越收敛越好，见下面「常见错误」。
【何时不该用】① 已经知道要用哪个 PDB id、只是想跑仿真——直接 exp_design，不必先过这个工具。② 想找论文/背景调研——那是 lit_search，这个工具只查结构数据库，不查文献。
【典型链路】protein_analyze → 看返回体最后一段「拿哪个结构去跑干实验」的判断 → 若判断是「该停下」就不要往下走；否则把选定的 PDB id / AlphaFold 模型带进 exp_design。
【常见错误】query 只写基因名或俗名（比如只写 "hemoglobin"）会撞到多个物种/多个同源基因的条目，UniProt 只回第一条未必是你要的那个——务必加 organism_id 与 reviewed:true 收敛到唯一条目；查不到唯一匹配会返回 422，不是故障，是查询不够收敛。
【读法】experimentalStructureCount 是 RCSB 的真实总数（服务端全量统计，不是截断后的数组长度）；structures 数组只展示前几条（默认 3 条）。alphafold.available=false 且 note 有内容是正常结论（未收录/取不到，不代表调用出错）——不要把 available=false 当失败重试。`,
    inputSchema: {
      type: "object",
      properties: {
        query: str(
          "UniProt 检索查询。建议带 organism_id 与 reviewed:true 收敛到唯一条目，否则容易撞车到同名基因/跨物种同源",
          "hemoglobin subunit beta AND organism_id:9606 AND reviewed:true",
        ),
        persist: { type: "boolean", description: "是否把结果落一条 observation record（evidence=sourced），默认 true" },
        project: PROJECT_ARG,
      },
      required: ["query"],
      additionalProperties: false,
    },
    request: (args) => ({ method: "POST", path: withProject("/api/proteins/analyze", args), body: args }),
  },

  {
    name: "lab_compile",
    description: `【何时调】要把一个自然语言湿实验方案变成可执行、可审计的协议时。做三件事并停下：编译成 Opentrons Python Protocol API v2 脚本 → 过 4 条安全门规则 → 停在 awaiting_approval。
【参数示例】{"naturalLanguage": "取样品 50 µL 加入 96 孔板 A1-A6，加入 100 µL 缓冲液，37°C 孵育 30 分钟，600 nm 读 OD", "title": "OD 时序"}
【何时不该用】想让协议直接执行时——**做不到，这是刻意的**。执行需要人工批准（AD-6：安全门通过是必要非充分条件，物理世界的操作不自动化审批）。approve / reject / simulate 都不是 MCP 工具。
【典型链路】lab_compile → 把返回体里的 humanAction 原样转达给用户 → 用户自己批准并执行 → lab_status 看结果。
【被拦下时】安全门不通过会返回 422 与 blocked 清单（超浓度 / 不兼容试剂 / 超生物安全等级 / 单孔累计溢孔）。改方案重新编译，不要试图绕过。
【重新编译的后果】任何一次重新编译都会作废先前的批准——协议在改，旧批准不能跨版本存活。`,
    inputSchema: {
      type: "object",
      properties: {
        naturalLanguage: str(
          "自然语言协议。写清体积、容器、温度、时间、读数波长",
          "取样品 50 µL 加入 96 孔板 A1-A6，加入 100 µL 缓冲液，37°C 孵育 30 分钟，600 nm 读 OD",
        ),
        title: str("实验标题", "OD 时序"),
        hypothesis: str("这个湿实验要验证什么", "加缓冲后 30 分钟内 OD 上升趋于平台"),
        fromDry: str("由哪个干实验衍生而来（干湿闭环接棒）", "9c8b7a6d"),
        project: PROJECT_ARG,
      },
      required: ["naturalLanguage"],
      additionalProperties: false,
    },
    request: (args) => ({ method: "POST", path: withProject("/api/lab/experiments", args), body: args }),
    present: (payload, args) => {
      const data = payload as { experiment?: { id?: string; state?: string } };
      const id = data?.experiment?.id ?? "<实验 id>";
      const slug = typeof args.project === "string" && args.project ? ` --project ${args.project}` : "";
      return {
        ...(payload as Record<string, unknown>),
        // 把人拉回环里：不是「你没权限」，而是「下一步该谁做、怎么做」。
        humanAction: {
          why: "AD-6：安全门通过 ≠ 可以执行。物理世界的操作不自动化审批，approve 不是 MCP 工具。",
          state: data?.experiment?.state ?? "awaiting_approval",
          nextStepForHuman: `spark-research lab approve ${id} --actor <你的名字>${slug}`,
          orInWorkbench: "或在工作台底部的实验面板点「批准」按钮（会记名并落一条 decision record）",
          afterApproval: `批准之后由人执行：spark-research lab simulate ${id}${slug}；执行完可用 lab_status 查看 run log`,
        },
      };
    },
  },

  {
    name: "lab_status",
    description: `【何时调】要看湿实验链上的实验处在哪一步时（尤其是「我编译完了，人批了没」「批完执行了没」）。
【参数示例】{"state": "awaiting_approval"} 列出所有卡在等人批准的实验。
【何时不该用】想推动状态前进时——本工具只读。推进要由人来做。
【典型链路】lab_compile → lab_status(state=awaiting_approval) → 提醒用户去批准 → 用户执行后 lab_status 看 concluded。`,
    inputSchema: {
      type: "object",
      properties: {
        state: str(
          "按状态过滤：design / compile / safety_check / awaiting_approval / wet_run / collect / analyze / concluded / iterated / rejected / failed",
          "awaiting_approval",
        ),
        experimentId: str("只看某一个实验", "5e4d3c2b"),
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    request: (args) => {
      if (typeof args.experimentId === "string" && args.experimentId !== "") {
        return {
          method: "GET",
          path: withProject(`/api/lab/experiments/${encodeURIComponent(args.experimentId)}`, args),
        };
      }
      const state = typeof args.state === "string" && args.state ? `?state=${encodeURIComponent(args.state)}` : "";
      return { method: "GET", path: withProject(`/api/lab/experiments${state}`, args) };
    },
  },

  {
    name: "records_timeline",
    description: `【何时调】要回答「这个课题最近发生了什么」「某类记录有哪些」时。证据图的时间线视图，8 类 record（idea / decision / experiment / observation / reading / conclusion / paper / artifact）。
【参数示例】{"type": ["conclusion", "observation"], "limit": 20}
【何时不该用】要看某一条的上下游关系时——用 record_get（它带证据子图）。
【典型链路】records_timeline → 挑出可疑的一条 → record_get 展开它的证据链。`,
    inputSchema: {
      type: "object",
      properties: {
        type: strList("record 类型过滤（可多选）", ["conclusion", "observation"]),
        evidence: {
          type: "string",
          enum: ["observed", "sourced", "computed", "inferred"],
          description: "证据类型过滤",
        },
        limit: num("返回条数上限（最大 500）", 50),
        offset: num("分页偏移", 0),
        since: str("起始时间（ISO 8601）", "2026-09-01T00:00:00Z"),
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    request: (args) => {
      const params = new URLSearchParams();
      if (Array.isArray(args.type) && args.type.length > 0) params.set("type", (args.type as string[]).join(","));
      for (const key of ["evidence", "since", "until"]) {
        const value = args[key];
        if (typeof value === "string" && value !== "") params.set(key, value);
      }
      for (const key of ["limit", "offset"]) {
        const value = args[key];
        if (typeof value === "number") params.set(key, String(value));
      }
      const qs = params.toString();
      return { method: "GET", path: withProject(`/api/records${qs ? `?${qs}` : ""}`, args) };
    },
  },

  {
    name: "record_get",
    description: `【何时调】要核对某条记录的证据链时——「这个结论是基于什么」「这个观察来自哪次运行」。返回记录本体 + 出入边 + 关联 artifact 内容。
【参数示例】{"recordId": "7a6b5c4d", "graphDepth": 2}
【何时不该用】只想列一批记录时用 records_timeline。
【典型链路】conclusion_list → record_get（展开证据）→ 判断结论是否站得住。
【边方向】supports / contradicts 是 paper→idea（查一条 idea 的支撑文献看它的 incoming 边）；cites 是新产物→被引论文；derives_from 是产物→来源。方向读反会得出相反结论。`,
    inputSchema: {
      type: "object",
      properties: {
        recordId: str("record id", "7a6b5c4d"),
        graphDepth: num("同时取证据子图的深度（1-5）；不给则只返回记录本身与直接边", 2),
        project: PROJECT_ARG,
      },
      required: ["recordId"],
      additionalProperties: false,
    },
    request: (args) => {
      const id = encodeURIComponent(String(args.recordId ?? ""));
      if (typeof args.graphDepth === "number") {
        return { method: "GET", path: withProject(`/api/records/${id}/graph?depth=${args.graphDepth}`, args) };
      }
      return { method: "GET", path: withProject(`/api/records/${id}`, args) };
    },
  },

  {
    name: "conclusion_list",
    description: `【何时调】要看项目里的结论卡及其评审状态时。只有 review=approved 的结论才会进研究报告的「结论」区，pending / vetoed 进「待验证」区。
【参数示例】{"review": "pending"} 找出还没评审的结论。
【何时不该用】想改变评审状态时——评审不是 MCP 工具（见 conclusion_get 的说明）。
【典型链路】conclusion_list(review=pending) → conclusion_get（看预评估）→ 把结果转达给用户，由人决定评审。`,
    inputSchema: {
      type: "object",
      properties: {
        review: { type: "string", enum: ["pending", "approved", "vetoed"], description: "按评审状态过滤" },
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    request: (args) => {
      const review = typeof args.review === "string" && args.review ? `?review=${encodeURIComponent(args.review)}` : "";
      return { method: "GET", path: withProject(`/api/conclusions${review}`, args) };
    },
  },

  {
    name: "conclusion_get",
    description: `【何时调】要看一张结论卡的详情与**预评估**时。预评估会跑三个检查器（data-consistency / capability-labeling / stats-plausibility）但**不落库、不改状态**——它告诉你「如果现在评审会是什么结果」。
【参数示例】{"conclusionId": "2b3c4d5e"}
【何时不该用】想真正评审时——评审会落一条记名的 decision record，必须由人执行：\`spark-research conclusion review <id> --actor <名字>\`。结论能否进报告是可信度的最后一道闸，不交给外部 agent 自评。
【典型链路】conclusion_get → 把 findings 里的 hard 项转达给用户并给出修复建议 → 用户修完自己评审。
【返回读法】wouldApprove=false 时看 findings：任一 hard 就会 vetoed，且**不提供人工推翻 hard 的路径**（三条 hard 全是可核对的事实判断）。`,
    inputSchema: {
      type: "object",
      properties: {
        conclusionId: str("结论卡 record id", "2b3c4d5e"),
        project: PROJECT_ARG,
      },
      required: ["conclusionId"],
      additionalProperties: false,
    },
    request: (args) => ({
      method: "GET",
      path: withProject(`/api/conclusions/${encodeURIComponent(String(args.conclusionId ?? ""))}`, args),
    }),
  },

  {
    name: "report_export",
    description: `【何时调】要把一个项目这段时间的工作整理成带证据链接的 Markdown 报告时。正文全部由代码渲染、不经过模型——每条陈述都带 record id，读者可以逐条回原始记录核对。
【参数示例】{"verbose": true}
【何时不该用】想让模型「写一份漂亮的报告」时——本工具刻意不让模型碰正文，那是为了让报告可审计。要润色请在拿到 Markdown 之后自己做，但不要改动 record id。
【典型链路】（一段研究工作之后）conclusion_list → 提醒用户评审待定结论 → report_export。
【读法】结论区只包含 approved 的卡；pending 与 vetoed 在「待验证」区并逐条列出阻塞它的 hard finding。报告不替评审人按通过键。`,
    inputSchema: {
      type: "object",
      properties: {
        verbose: { type: "boolean", description: "是否输出更详细的证据索引" },
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    request: (args) => ({
      method: "GET",
      path: withProject(`/api/report?format=json${args.verbose === true ? "&verbose=1" : ""}`, args),
    }),
  },

  {
    name: "chem_depict",
    description: `【何时调】要把一个 SMILES 分子式变成可看的 2D 结构图时——比如在报告/讨论里给出「这个分子长什么样」，或者拿到一个 SMILES 想先核实 RDKit 解析出来的 canonical 形式、分子式、分子量是否符合预期。产出是一张 SVG 结构图，落一条 artifact（image/svg+xml）+ 一条 evidence=computed 的 record，可在工作台「产物」页打开查看。
【参数示例】{"smiles": "CCO", "name": "ethanol"} —— name 可省略（省略时按 canonical SMILES 的短 hash 生成文件名，重复 depict 同一个分子会稳定落到同一个 artifact 并递增版本号）。
【何时不该用】① 只是想核对 SMILES 语法是否合法而不需要图——直接本地跑 RDKit 更快。② 需要 3D 构象/对接姿态——这个工具只画 2D 结构图，不算 3D 坐标，也不做对接。
【典型链路】lit_search / idea_coexplore 聊到某个具体分子 → chem_depict 生成结构图存进证据图 → 结构图的 artifactId 可以在报告里引用。
【常见错误】SMILES 语法不合法（括号不配对、化合价超限等）会返回失败而不是一张空图——错误信息里带了具体该查哪里（元素符号/化合价/环闭合编号/括号），不是「解析失败」四个字了事。`,
    inputSchema: {
      type: "object",
      properties: {
        smiles: str("要绘制的分子 SMILES 表达式", "CCO"),
        name: str("产物文件名（不含扩展名）。省略则按 canonical SMILES 的短 hash 自动生成", "ethanol"),
        width: num("SVG 宽度（像素），默认 400", 400),
        height: num("SVG 高度（像素），默认 300", 300),
        project: PROJECT_ARG,
      },
      required: ["smiles"],
      additionalProperties: false,
    },
    request: (args) => ({ method: "POST", path: withProject("/api/chem/depict", args), body: args }),
  },

  // ── 远端算力（v0.5 C1 · CB-5 接线）────────────────────────────────────────
  //
  // 只暴露四个：plan（无副作用）+ status/list（只读）+ collect（产物落地）。
  // **approve / run / release 一律扣留**，见本文件末尾的 MCP_WITHHELD——
  // agent 经 MCP 只能 plan 与查状态，**从不派发**（AD-14）。
  {
    name: "compute_plan",
    description: `【何时调】任务在本机跑不动（要 GPU、要几十分钟、要独立环境）时，先用它生成一份**待人审批的算力计划**。它**不执行任何东西**：不建远端资源、不解析凭据、不产生账单，只算出「要跑什么命令、带哪些文件上去、收哪些产物回来、上界花多少钱」，然后停在 awaiting_approval 等人点头。
【参数示例】{"purpose": "在 GPU 上跑 100ns MD 采样", "command": ["python", "run.py", "--steps", "50000000"], "upload": ["run.py", "system.pdb"], "outputs": ["traj.dcd", "log.txt"], "target": "local", "timeoutMinutes": 120}
【command 必须是 argv 数组】不接受 shell 字符串——被审批的命令不该再经过一次 shell 展开。写 ["bash","-c","..."] 会被直接拒。
【何时不该用】① 几秒钟就能算完的东西——本地 exp_run 更快，不必绕远端。② 你想「顺便把它跑起来」——做不到：派发必须由人在真实终端里执行 \`spark-research compute approve <jobId> --run\`，这个工具面上没有派发入口，试也调不到。
【典型链路】compute_plan（拿到 jobId + digest + 逐文件上传清单 + 费用上界）→ **人**看过之后在终端 approve --run → compute_status 轮询 → 终态后 compute_collect 取产物。
【返回体里最该看的三样】① warning：这次用谁的账户、上界多少钱；② uploads：**逐个文件**列出来了，会离开这台机器的就是这些，别的都不会；③ humanAction：需要人去敲的那条命令，原样转达给人，不要自己想办法绕过去。`,
    inputSchema: {
      type: "object",
      properties: {
        purpose: str("这次运行要干什么（会出现在审批面上，人靠它做判断）", "在 GPU 上跑 100ns MD 采样"),
        command: strList("要执行的 argv 数组（**不是** shell 字符串）", ["python", "run.py", "--steps", "50000000"]),
        upload: strList("要带上去的文件/目录（相对 workspaceRoot）。密钥类路径会被 deny-list 硬拦", ["run.py", "system.pdb"]),
        outputs: strList("要收割回来的产物（相对路径 glob）", ["traj.dcd", "log.txt"]),
        target: str("执行地：local（本机子进程，不计费）或 modal（云端，计费）。不给就用配置的 computeTarget", "local"),
        workspaceRoot: str("上传的根目录（绝对路径）。不给就用当前项目目录", "~/.spark-research/projects/gpcr-allostery"),
        network: str("none（默认，声明这次运行不需要网络）或 unrestricted", "none"),
        secretRefs: strList("密钥的**符号名**（值永不进 plan/job/record）", ["hf_token"]),
        gpu: str("GPU 型号；local 不提供 GPU，填了会被拒", "A100"),
        cpus: num("CPU 核数，默认 1", 4),
        memoryGb: num("内存 GiB，默认 1", 16),
        timeoutMinutes: num("墙钟超时（分钟），默认 30；费用上界 = 它 × 单价", 120),
        project: PROJECT_ARG,
      },
      required: ["purpose", "command"],
      additionalProperties: false,
    },
    request: (args) => ({ method: "POST", path: withProject("/api/compute/jobs", args), body: args }),
  },

  {
    name: "compute_status",
    description: `【何时调】plan 之后想知道「人批了没 / 跑到哪了 / 产物收了没」。返回三轴状态（execution / delivery / resource）+ 三段审批（未消费的 approval、已消费的 consumedApproval、因 plan 变更而作废的 supersededApproval）。
【参数示例】{"jobId": "cj-m2x9k1-1a2b3c4d"}
【怎么读三轴】execution 是「跑没跑完」，delivery 是「产物取没取回来」，resource 是「远端资源还在不在」。三者独立：execution=succeeded 且 delivery=pending 意味着**跑完了但产物还在远端**，这时候该调 compute_collect。
【何时不该用】想推进状态时——这是只读的。批准与派发都必须由人在真实终端里做。
【典型链路】compute_plan → （人 approve --run）→ compute_status 轮询到 execution 终态 → compute_collect。`,
    inputSchema: {
      type: "object",
      properties: { jobId: str("算力任务 id", "cj-m2x9k1-1a2b3c4d"), project: PROJECT_ARG },
      required: ["jobId"],
      additionalProperties: false,
    },
    request: (args) => ({
      method: "GET",
      path: withProject(`/api/compute/jobs/${encodeURIComponent(String(args.jobId ?? ""))}`, args),
    }),
  },

  {
    name: "compute_list",
    description: `【何时调】想看这个项目里有哪些算力任务、有没有卡在 awaiting_approval 等人批的。可按 execution 状态过滤。
【参数示例】{"state": "awaiting_approval"} —— 不给 state 就返回全部。
【何时不该用】只关心某一个任务时——compute_status 更直接。
【典型链路】compute_list（发现有三个还等着人批）→ 把 humanAction 转达给人 → 人批完之后 compute_status 跟进。`,
    inputSchema: {
      type: "object",
      properties: {
        state: str("按 execution 状态过滤（planned / awaiting_approval / approved / running / succeeded …）", "awaiting_approval"),
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    request: (args) => ({
      method: "GET",
      path: withProject(
        `/api/compute/jobs${args.state ? `?state=${encodeURIComponent(String(args.state))}` : ""}`,
        args,
      ),
    }),
  },

  {
    name: "compute_collect",
    description: `【何时调】**只在 delivery=pending 时**——也就是 execution 已经到终态（succeeded/failed/timed_out/cancelled）但产物还在远端。它把 outputs 拉回本地 <job>/harvest/，并把 delivery 推进到 complete。
【参数示例】{"jobId": "cj-m2x9k1-1a2b3c4d"}
【何时不该用】① execution 还没到终态——会得到 409，不是「等一会再试」的意思，是「你调早了」。② delivery 已经是 complete——再调一次没有语义。
【典型链路】compute_status 看到 execution=succeeded & delivery=pending → compute_collect → 产物落到 harvest/，之后才允许人 release 远端资源。
【为什么收割是独立一步】产物只剩远端那一份时（recoverable=true），释放资源会被状态机直接拒——**不许关掉持有唯一副本的资源**。收割就是把「唯一副本」变成两份的那一步。`,
    inputSchema: {
      type: "object",
      properties: { jobId: str("算力任务 id", "cj-m2x9k1-1a2b3c4d"), project: PROJECT_ARG },
      required: ["jobId"],
      additionalProperties: false,
    },
    request: (args) => ({
      method: "POST",
      path: withProject(`/api/compute/jobs/${encodeURIComponent(String(args.jobId ?? ""))}/collect`, args),
      body: {},
    }),
  },

  {
    name: "task_status",
    description: `【何时调】某个长任务工具因为超时返回了任务句柄（taskId）时，用它查最终结果。
【参数示例】{"taskId": "6d5e4f3a-..."}
【何时不该用】工具已经返回了结果时——那就是终态，不必再查。
【典型链路】exp_run（超时，返回 taskId）→ 等一会 → task_status → state=succeeded 时取 result。
【句柄的有效范围（重要）】taskId 存在 **server 进程内存里**，只在**当前这条 MCP 连接存活期间**有效——连接一断，句柄就查不到了（返回「task 不存在」）。这不代表任务被取消，而是句柄没了。
【连接断了怎么办】分两种：
  · **干实验（exp_run）**：状态真源在磁盘上，用 exp_list 找到实验后 exp_run 带 resume 接回，进度不丢。
  · **文献/思路类长任务（lit_read_cards、lit_review_draft、idea_novelty_check）**：没有磁盘 checkpoint，连接断开后**任务确实会随进程一起结束**，已完成的部分（已落库的精读卡等）保留，未完成的需要重跑。
【所以更该做的是别让它超时】调大**两个**上限（只调一个没用）：SPARK_RESEARCH_MCP_TIMEOUT_MS（MCP 等待）与 SPARK_TASK_TIMEOUT_MS（任务生命周期，默认 600000 即 10 分钟）；或缩小单次范围（如 lit_read_cards 用 tag 分批）。
【超时失败长什么样】error.timeout=true 表示是生命周期兜底触发的，不是任务体自己报的错——区别在于前者该调超时或缩范围，后者该看错误内容。`,
    inputSchema: {
      type: "object",
      properties: { taskId: str("长任务句柄 id", "6d5e4f3a-1b2c-4d5e-8f90-1a2b3c4d5e6f") },
      required: ["taskId"],
      additionalProperties: false,
    },
    request: (args) => ({ method: "GET", path: `/api/tasks/${encodeURIComponent(String(args.taskId ?? ""))}` }),
  },
];

// ── 刻意不暴露的动作（AD-6 / 判断一）────────────────────────────────────────
//
// 这张表不是「未实现清单」，是**设计声明**。它进 `capabilities` 输出，也进 MCP server
// 的 instructions —— 外部 agent 读到的是「这些必须人来做，以及人该怎么做」，
// 而不是调用失败后自己猜。
export interface WithheldAction {
  name: string;
  reason: string;
  humanAction: string;
}

export const MCP_WITHHELD: readonly WithheldAction[] = [
  {
    name: "lab_approve",
    reason:
      "AD-6：湿实验执行前的人工审批是硬门。若 agent 能自己批准，它就能自己编译、自己批准、自己执行，approve gate 退化成注释。",
    humanAction: "spark-research lab approve <id> --actor <名字>（或在工作台实验面板点「批准」）",
  },
  {
    name: "lab_reject",
    reason: "拒绝同样是记名决策，会落一条 decision record；由人署名才有审计意义。",
    humanAction: "spark-research lab reject <id> --actor <名字> --reason <理由>",
  },
  {
    name: "lab_simulate",
    reason:
      "执行协议是物理世界动作的模拟入口，且只允许从 awaiting_approval 经人工批准进入。开放它等于绕过 approve gate。",
    humanAction: "spark-research lab simulate <id>（须先经人工 approve）",
  },
  {
    name: "conclusion_review",
    reason:
      "结论卡能否进报告结论区是可信度的最后一道闸。让外部 agent 给自己产出的结论盖章，等于取消这道闸。预评估已通过 conclusion_get 只读开放。",
    humanAction: "spark-research conclusion review <id> --actor <名字>",
  },
  {
    name: "project_archive",
    reason: "归档会把项目移出默认视图，是破坏性的组织动作，不应由外部 agent 代劳。",
    humanAction: "spark-research project archive <slug>",
  },
  // ── v0.5 C1（CB-5）：算力的三条扣留 ────────────────────────────────────────
  //
  // AD-14「子代理永不自批准」在算力上比湿实验更直接：这里批下去的是**真金白银**。
  // 三条各自对标一个已有先例，不是新发明的边界：
  //   compute_approve ↔ lab_approve（AD-6：花钱/动物理世界的审批是硬门）
  //   compute_run     ↔ lab_simulate（派发 = 计费动作本身，只允许从 approved 经人工进入）
  //   compute_release ↔ project_archive（删远端卷 = 破坏性动作）
  //
  // 这张表同时是 `sub_agent.ts:assertNoWithheldGrants` 的**唯一**数据源
  // （`WITHHELD_NAMES` 从这里派生），所以往这里加一条，AD-14 的三道防线
  // （构造期 / 运行期 / ToolBus）自动覆盖，不需要在别处再写一遍。
  {
    name: "compute_approve",
    reason:
      "AD-6 同构：批准一次算力派发就是批准一笔账单。若 agent 能自己批准，它就能自己 plan、自己批准、自己派发，审批门退化成注释——而这一次退化的代价是真钱。",
    humanAction: "spark-research compute approve <jobId> --actor <名字>（须在真实交互终端里执行）",
  },
  {
    name: "compute_run",
    reason:
      "派发就是计费动作本身，且只允许从 approved 经人工进入（与 lab_simulate 同构）。开放它等于绕过 approve gate；HTTP 层也刻意没有这个端点，不存在「换条路调」的余地。",
    humanAction: "spark-research compute run <jobId>（须先经人工 approve）",
  },
  {
    name: "compute_release",
    reason:
      "释放会删掉远端卷/工作目录，是不可逆的破坏性动作（与 project_archive 同构）。产物只剩远端那一份时状态机会拦，但「该不该扔掉这批结果」本身是人的判断。",
    humanAction: "spark-research compute release <jobId>（先 collect，或用 --discard 显式放弃产物）",
  },
];

export function toolByName(name: string): McpToolDef | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}
