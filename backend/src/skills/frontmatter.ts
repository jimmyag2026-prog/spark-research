import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// SKILL.md frontmatter 规范化（P9）。
//
// 技能目录是 LLM 的操作手册：agent 按需加载，不预填 context（DESIGN §2.2 第 4 条）。
// 「按需」要成立，frontmatter 就必须让 agent 只读几行就能判断「这个技能现在该不该加载」。
// v0.2 之前的 frontmatter 只有 name/description/category/domain——描述里塞满了「何时用」，
// 但没有机器可读的触发条件，也没写清依赖哪些 connector（缺凭据时该技能其实跑不通）。
//
// P9 定的 schema 加三个必填字段：
//   triggers    —— 用户说什么时该加载（机器可读，agent 选技能的第一判据）
//   connectors  —— 依赖哪些 connector（空数组是合法的，表示「不依赖外部数据源」）
//   validation  —— 配套验证的测试文件路径。AD-5「技能必须有配套 e2e 才算完成」
//                  在此之前只是文档里的一句话，现在校验器会去磁盘上核对文件是否真实存在。
//
// 解析器刻意只支持 YAML 的一个极小子集（标量 + 单行数组），不引入 YAML 依赖：
// frontmatter 复杂到需要真 YAML 解析器时，说明它已经不适合当「读几行就懂」的索引了。

export const SKILL_FILE = "SKILL.md";
export const SKILL_CATEGORIES = ["literature", "ideation", "experiment", "report"] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export interface SkillFrontmatter {
  name: string;
  description: string;
  category: string;
  domain: string;
  triggers: string[];
  connectors: string[];
  platforms: string[];
  allowedTools: string[];
  validation: string[];
}

export interface SkillEntry {
  name: string;
  dir: string;
  path: string;
  frontmatter: SkillFrontmatter;
}

export class SkillFrontmatterError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "SkillFrontmatterError";
  }
}

export const SKILLS_DIR = import.meta.dir;

// 单行数组：`[a, b]` 或 `["a", "b"]`。空数组 `[]` 合法。
function parseList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (inner === "") return [];
  return inner
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter((item) => item.length > 0);
}

function unquote(raw: string): string {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export interface RawFrontmatter {
  fields: Record<string, string>;
  body: string;
}

export function splitFrontmatter(source: string, path = "<memory>"): RawFrontmatter {
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new SkillFrontmatterError("SKILL.md 必须以 `---` 开头的 YAML frontmatter 起始", path);
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    throw new SkillFrontmatterError("frontmatter 没有闭合的 `---`", path);
  }
  const fields: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new SkillFrontmatterError(`frontmatter 第 ${i + 1} 行不是 \`key: value\`：${line}`, path);
    }
    const key = line.slice(0, colon).trim();
    if (fields[key] !== undefined) {
      throw new SkillFrontmatterError(`frontmatter 里 '${key}' 重复出现`, path);
    }
    fields[key] = line.slice(colon + 1).trim();
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

const REQUIRED_SCALARS = ["name", "description", "category", "domain"] as const;
const REQUIRED_LISTS = ["triggers", "connectors", "validation"] as const;
const KNOWN_KEYS = new Set<string>([
  ...REQUIRED_SCALARS,
  ...REQUIRED_LISTS,
  "platforms",
  "allowed-tools",
]);

export interface ParseOptions {
  path?: string;
  // 校验 validation 指向的测试文件是否真实存在（CI 用；解析用途可关掉）。
  repoRoot?: string;
  // 已知的 connector id 集合；给了就校验 connectors 里的每一项都真实存在。
  knownConnectors?: readonly string[];
  // 同上，平台 id。
  knownPlatforms?: readonly string[];
}

export function parseSkillFrontmatter(source: string, options: ParseOptions = {}): SkillFrontmatter {
  const path = options.path ?? "<memory>";
  const { fields } = splitFrontmatter(source, path);

  const unknown = Object.keys(fields).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    // 未知字段一律拒绝：拼错的 `trigger:`（少个 s）静默失效比报错糟糕得多。
    throw new SkillFrontmatterError(
      `frontmatter 含未知字段 ${unknown.join(", ")}（可用：${[...KNOWN_KEYS].join(", ")}）`,
      path,
    );
  }
  for (const key of REQUIRED_SCALARS) {
    if (!fields[key]) throw new SkillFrontmatterError(`frontmatter 缺少必填字段 '${key}'`, path);
  }
  for (const key of REQUIRED_LISTS) {
    if (fields[key] === undefined) {
      throw new SkillFrontmatterError(`frontmatter 缺少必填字段 '${key}'（无依赖时写 []）`, path);
    }
    if (!fields[key]!.startsWith("[")) {
      throw new SkillFrontmatterError(`字段 '${key}' 必须是单行数组，如 [a, b]`, path);
    }
  }

  const frontmatter: SkillFrontmatter = {
    name: unquote(fields.name!),
    description: unquote(fields.description!),
    category: unquote(fields.category!),
    domain: unquote(fields.domain!),
    triggers: parseList(fields.triggers!),
    connectors: parseList(fields.connectors!),
    platforms: fields.platforms ? parseList(fields.platforms) : [],
    allowedTools: fields["allowed-tools"] ? parseList(fields["allowed-tools"]!) : [],
    validation: parseList(fields.validation!),
  };

  if (!/^[a-z][a-z0-9-]*$/.test(frontmatter.name)) {
    throw new SkillFrontmatterError(`name '${frontmatter.name}' 必须是小写 kebab-case`, path);
  }
  if (!(SKILL_CATEGORIES as readonly string[]).includes(frontmatter.category)) {
    throw new SkillFrontmatterError(
      `category '${frontmatter.category}' 不在允许集合（${SKILL_CATEGORIES.join(" / ")}）`,
      path,
    );
  }
  if (!/^[A-E](\/[A-E])*$/.test(frontmatter.domain)) {
    throw new SkillFrontmatterError(`domain '${frontmatter.domain}' 必须是 A-E（可用 / 连接，如 C/E）`, path);
  }
  // 描述要同时说清「做什么」与「何时用」——只说做什么的描述会让 agent 猜。
  if (frontmatter.description.length < 40) {
    throw new SkillFrontmatterError("description 太短：要同时说清「做什么」与「何时用」", path);
  }
  if (frontmatter.triggers.length === 0) {
    throw new SkillFrontmatterError("triggers 至少要有一条——没有触发条件的技能没人会加载它", path);
  }
  if (frontmatter.validation.length === 0) {
    throw new SkillFrontmatterError("validation 至少要有一条（AD-5：技能必须有配套验证才算完成）", path);
  }
  if (options.knownConnectors) {
    const bad = frontmatter.connectors.filter((id) => !options.knownConnectors!.includes(id));
    if (bad.length > 0) {
      throw new SkillFrontmatterError(`connectors 里有不存在的 connector: ${bad.join(", ")}`, path);
    }
  }
  if (options.knownPlatforms) {
    const bad = frontmatter.platforms.filter((id) => !options.knownPlatforms!.includes(id));
    if (bad.length > 0) {
      throw new SkillFrontmatterError(`platforms 里有不存在的仿真平台: ${bad.join(", ")}`, path);
    }
  }
  if (options.repoRoot) {
    // AD-5 的执行面：validation 指向的文件必须真的在磁盘上。
    const missing = frontmatter.validation.filter((rel) => !existsSync(join(options.repoRoot!, rel)));
    if (missing.length > 0) {
      throw new SkillFrontmatterError(`validation 指向的文件不存在: ${missing.join(", ")}`, path);
    }
  }
  return frontmatter;
}

export function skillDirs(root: string = SKILLS_DIR): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => {
      const dir = join(root, entry);
      return statSync(dir).isDirectory() && existsSync(join(dir, SKILL_FILE));
    })
    .sort();
}

// 全量加载技能索引。任何一个技能坏了都抛错（而不是跳过）——
// 静默跳过等于让一个坏掉的技能永远不被发现。
export function loadSkills(options: ParseOptions & { root?: string } = {}): SkillEntry[] {
  const root = options.root ?? SKILLS_DIR;
  return skillDirs(root).map((name) => {
    const path = join(root, name, SKILL_FILE);
    const frontmatter = parseSkillFrontmatter(readFileSync(path, "utf8"), { ...options, path });
    if (frontmatter.name !== name) {
      throw new SkillFrontmatterError(`frontmatter.name='${frontmatter.name}' 与目录名 '${name}' 不一致`, path);
    }
    return { name, dir: join(root, name), path, frontmatter };
  });
}
