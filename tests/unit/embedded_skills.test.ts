import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDED_SKILLS } from "../../backend/src/skills/embedded";
import { SKILLS_DIR, loadSkills, skillDirs } from "../../backend/src/skills/frontmatter";

// V27 收口：技能索引在单二进制里恒为空（`capabilities --json` 报「技能 0 个」，
// 源码模式 10 个）。目录枚举没法靠静态 import 覆盖，只能逐份内嵌 SKILL.md。
//
// 这张表是**手工维护**的，所以必须有门禁——否则新增一个技能而忘了登记，
// 二进制里那个技能就永远不存在，而且**不报错**（这正是 AD-12 要防的形状：
// 安静的错误答案）。下面两条断言让「忘了改」当场变红。
describe("V27：内嵌技能表与磁盘目录必须逐字一致", () => {
  const onDisk = readdirSync(SKILLS_DIR)
    .filter((e) => statSync(join(SKILLS_DIR, e)).isDirectory() && existsSync(join(SKILLS_DIR, e, "SKILL.md")))
    .sort();

  test("键集合与磁盘上的技能目录集合一致（新增/删除技能忘了登记 → 红）", () => {
    expect(Object.keys(EMBEDDED_SKILLS).sort()).toEqual(onDisk);
  });

  test("每份内容与磁盘上的 SKILL.md 逐字一致（改了 SKILL.md 忘了重新生成 → 红）", () => {
    for (const name of onDisk) {
      expect(EMBEDDED_SKILLS[name]).toBe(readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8"));
    }
  });

  test("内嵌兜底解析出的技能与磁盘加载的结果一致（不是只对上了文件名）", () => {
    const fromDisk = loadSkills();
    expect(fromDisk.length).toBe(onDisk.length);
    // 兜底路径只在磁盘不可用时触发，源码模式下走的是磁盘——这里退而验证内嵌内容
    // 确实能被同一个 parser 解析出同样的 frontmatter.name。
    for (const entry of fromDisk) {
      expect(EMBEDDED_SKILLS[entry.name]).toBeDefined();
      expect(EMBEDDED_SKILLS[entry.name]).toContain(`name: ${entry.frontmatter.name}`);
    }
  });

  test("显式传一个不存在的 root 时不许拿内嵌副本顶包（那会让扩展目录说谎）", () => {
    expect(skillDirs("/nonexistent-skills-root-for-test")).toEqual([]);
  });
});
