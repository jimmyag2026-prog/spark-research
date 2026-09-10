import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SKILL_CATEGORIES,
  SkillFrontmatterError,
  loadSkills,
  parseSkillFrontmatter,
  skillDirs,
  splitFrontmatter,
} from "../../backend/src/skills/frontmatter";
import { BUILTIN_CONNECTORS } from "../../backend/src/connectors/registry";
import { SIMULATION_PLATFORM_IDS } from "../../backend/src/simulation/registry";

const REPO_ROOT = join(import.meta.dir, "../..");
const CONNECTOR_IDS = Object.values(BUILTIN_CONNECTORS).flatMap((defs) => defs.map((d) => d.name));

function valid(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    name: "demo-skill",
    description:
      '"演示技能：做一件具体的事（这里是用于测试解析器的占位说明），并说清在什么情况下该用它、什么情况下不该用它，让 agent 只读这一段就能判断要不要加载。"',
    category: "literature",
    domain: "A",
    triggers: "[帮我查一下, 演示一下]",
    connectors: "[]",
    validation: "[tests/unit/skill_frontmatter.test.ts]",
    ...overrides,
  };
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${body}\n---\n\n# 演示\n`;
}

describe("SKILL.md frontmatter · 解析器", () => {
  test("解析标量与单行数组", () => {
    const fm = parseSkillFrontmatter(valid({ connectors: "[openalex, crossref]", "allowed-tools": "[Bash, Read]" }));
    expect(fm.name).toBe("demo-skill");
    expect(fm.connectors).toEqual(["openalex", "crossref"]);
    expect(fm.allowedTools).toEqual(["Bash", "Read"]);
    expect(fm.platforms).toEqual([]);
  });

  test("引号包裹的描述被剥掉引号", () => {
    expect(parseSkillFrontmatter(valid()).description.startsWith('"')).toBe(false);
  });

  test("没有 frontmatter / 未闭合 → 报错", () => {
    expect(() => splitFrontmatter("# 没有 frontmatter")).toThrow(SkillFrontmatterError);
    expect(() => splitFrontmatter("---\nname: x\n# 忘了闭合")).toThrow(SkillFrontmatterError);
  });

  test("拼错的字段名不许静默失效", () => {
    // `trigger:`（少个 s）是最典型的静默失效：字段没生效但没人知道。
    const source = valid().replace("triggers:", "trigger:");
    expect(() => parseSkillFrontmatter(source)).toThrow(/未知字段/);
  });

  test("重复字段报错", () => {
    const source = valid().replace("domain: A", "domain: A\ndomain: B");
    expect(() => parseSkillFrontmatter(source)).toThrow(/重复/);
  });
});

describe("SKILL.md frontmatter · schema 约束", () => {
  test("必填字段缺一不可", () => {
    for (const key of ["name", "description", "category", "domain"]) {
      const source = valid()
        .split("\n")
        .filter((l) => !l.startsWith(`${key}:`))
        .join("\n");
      expect(() => parseSkillFrontmatter(source)).toThrow(/缺少必填字段/);
    }
    for (const key of ["triggers", "connectors", "validation"]) {
      const source = valid()
        .split("\n")
        .filter((l) => !l.startsWith(`${key}:`))
        .join("\n");
      expect(() => parseSkillFrontmatter(source)).toThrow(/缺少必填字段/);
    }
  });

  test("connectors 为空数组是合法的（不依赖外部数据源）", () => {
    expect(parseSkillFrontmatter(valid({ connectors: "[]" })).connectors).toEqual([]);
  });

  test("triggers 与 validation 不许为空", () => {
    expect(() => parseSkillFrontmatter(valid({ triggers: "[]" }))).toThrow(/triggers/);
    // AD-5：技能必须有配套验证才算完成
    expect(() => parseSkillFrontmatter(valid({ validation: "[]" }))).toThrow(/AD-5/);
  });

  test("name / category / domain / description 的形态约束", () => {
    expect(() => parseSkillFrontmatter(valid({ name: "Demo_Skill" }))).toThrow(/kebab-case/);
    expect(() => parseSkillFrontmatter(valid({ category: "misc" }))).toThrow(/category/);
    expect(() => parseSkillFrontmatter(valid({ domain: "Z" }))).toThrow(/domain/);
    expect(() => parseSkillFrontmatter(valid({ description: '"太短了"' }))).toThrow(/太短/);
  });

  test("connectors / platforms 里的 id 必须真实存在", () => {
    expect(() =>
      parseSkillFrontmatter(valid({ connectors: "[nosuch-source]" }), { knownConnectors: CONNECTOR_IDS }),
    ).toThrow(/不存在的 connector/);
    expect(() =>
      parseSkillFrontmatter(valid({ platforms: "[nosuch-platform]" }), {
        knownPlatforms: SIMULATION_PLATFORM_IDS,
      }),
    ).toThrow(/不存在的仿真平台/);
  });

  test("validation 指向的文件不存在 → 报错", () => {
    expect(() =>
      parseSkillFrontmatter(valid({ validation: "[tests/unit/does_not_exist.test.ts]" }), { repoRoot: REPO_ROOT }),
    ).toThrow(/不存在/);
  });

  test("目录名与 name 不一致 → 报错", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-skills-"));
    mkdirSync(join(root, "other-name"));
    writeFileSync(join(root, "other-name", "SKILL.md"), valid());
    expect(() => loadSkills({ root })).toThrow(/与目录名/);
  });
});

describe("SKILL.md frontmatter · 仓库内 13 个技能全部合规（CI 门）", () => {
  const skills = loadSkills({
    repoRoot: REPO_ROOT,
    knownConnectors: CONNECTOR_IDS,
    knownPlatforms: SIMULATION_PLATFORM_IDS,
  });

  test("技能目录被完整扫到", () => {
    expect(skillDirs().length).toBe(13);
    expect(skills).toHaveLength(13);
  });

  for (const skill of skills) {
    test(`${skill.name} 的 frontmatter 合规且验证文件真实存在`, () => {
      expect(skill.frontmatter.name).toBe(skill.name);
      expect(SKILL_CATEGORIES).toContain(skill.frontmatter.category as never);
      expect(skill.frontmatter.triggers.length).toBeGreaterThan(0);
      for (const rel of skill.frontmatter.validation) {
        expect(existsSync(join(REPO_ROOT, rel))).toBe(true);
      }
    });
  }
});
