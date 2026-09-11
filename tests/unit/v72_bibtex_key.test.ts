import { describe, expect, test } from "bun:test";
import { assignBibtexKeys, bibtexBaseKey, toBibTeX } from "../../backend/src/literature/export";
import { emptyPaper, type Paper } from "../../backend/src/literature/models";

// V72（BACKLOG V72）：中文无作者论文的 BibTeX key 嵌入原始汉字，会破坏部分下游
// BibTeX 工具链（外部验收 R1-T3）。规则：作者姓氏含非 ASCII → 若能安全转拼音则用
// （不引入 npm 依赖；没有零依赖的可靠拼音表，本次不做拼音转换）→ 否则退化为
// anon<year>；key 只允许 `[A-Za-z0-9_-]`。既有英文 key 生成（含 V38 的「Last F」
// 形态）必须逐字节不变。
//
// 这条 BACKLOG 覆盖了更早的 E-5 决定（E-5 曾把 key 改成保留 `\p{Script=Han}`）——
// literature.test.ts 里同名 describe 块已经跟着改成新行为，这里补齐 BACKLOG 点名
// 要求的四类用例：中文作者、无作者、混合、既有英文回归。

function paper(overrides: Partial<Paper>): Paper {
  return { ...emptyPaper(), ...overrides };
}

describe("V72 · bibtex key 中文降级", () => {
  test("中文作者 + 中文标题 → 降级为 anon<year>untitled，key 纯 ASCII", () => {
    const zh = paper({
      title: "深度学习蛋白质结构预测综述",
      authors: [{ name: "张伟" }],
      year: 2022,
    });
    const key = bibtexBaseKey(zh);
    expect(key).toBe("anon2022untitled");
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("无作者（中文标题）→ author 段与既有「无作者」兜底一致，都是 anon", () => {
    const noAuthor = paper({ title: "中文标题但没有作者", year: 2020 });
    const key = bibtexBaseKey(noAuthor);
    expect(key).toBe("anon2020untitled");
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("无作者 + 英文标题 → 只有 author 段降级，标题首词照常提取（不因为无作者就整体退化）", () => {
    const noAuthor = paper({ title: "A Review of Deep Learning", year: 2020 });
    expect(bibtexBaseKey(noAuthor)).toBe("anon2020review");
  });

  test("中英混合作者名 → 只保留 ASCII 残余（非空则不整体降级为 anon）", () => {
    // "Wei 张#Zhang!" 归一化后姓段是「张 zhang」，asciiOnly 砍掉汉字/符号/空格后
    // 剩 "zhang"（非空）——不必再降级为 anon，这是 pinyin 之外的合理折中：
    // ASCII 残余本身就是可用的、无歧义的拉丁字符。
    const mixed = paper({ title: "Mixed Title", authors: [{ name: "Wei 张#Zhang!" }], year: 2020 });
    expect(bibtexBaseKey(mixed)).toBe("zhang2020mixed");
    expect(bibtexBaseKey(mixed)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("中英混合、ASCII 残余为空（纯汉字姓氏）→ 整体降级为 anon", () => {
    const zh = paper({ title: "Pure Ascii Title", authors: [{ name: "张三" }], year: 2019 });
    expect(bibtexBaseKey(zh)).toBe("anon2019pure");
  });

  test("既有英文回归：第一作者姓 + 年份 + 标题首词，逐字节不变（V38「Last F」形态也不变）", () => {
    expect(
      bibtexBaseKey(
        paper({
          title: "Highly accurate protein structure prediction with AlphaFold",
          authors: [{ name: "John Jumper" }],
          year: 2021,
        }),
      ),
    ).toBe("jumper2021highly");
    // V38：Europe PMC/PubMed 的「Last F」形态（姓在前、名缩写在后）。
    expect(
      bibtexBaseKey(
        paper({
          title: "Highly accurate protein structure prediction with AlphaFold",
          authors: [{ name: "Jumper J" }],
          year: 2021,
        }),
      ),
    ).toBe("jumper2021highly");
    expect(bibtexBaseKey(paper({ title: "The Origin of Species", authors: [{ name: "Charles Darwin" }], year: 1859 })))
      .toBe("darwin1859origin");
  });

  test("多篇中文无作者论文同 key → 靠 a/b/c 后缀区分，不因转拼音失败而冲突", () => {
    const a = paper({ title: "深度学习综述", authors: [{ name: "张伟" }], year: 2021 });
    const b = paper({ title: "深度学习综述", authors: [{ name: "张伟" }], year: 2021, doi: "10.1/b" });
    const c = paper({ title: "深度学习综述", authors: [{ name: "张伟" }], year: 2021, doi: "10.1/c" });
    expect(assignBibtexKeys([a, b, c])).toEqual(["anon2021untitled", "anon2021untitleda", "anon2021untitledb"]);
  });

  test("toBibTeX 整篇输出：key 是纯 ASCII，其余字段（title/author/venue）仍保留原始汉字", () => {
    const zh = paper({
      title: "深度学习蛋白质结构预测综述",
      authors: [{ name: "张伟" }],
      year: 2022,
      venue: "计算机学报",
    });
    const bib = toBibTeX([zh]);
    expect(bib).toContain("@article{anon2022untitled,");
    expect(bib).toContain("title = {深度学习蛋白质结构预测综述}");
    expect(bib).toContain("author = {张伟}");
    expect(bib).toContain("journal = {计算机学报}");
  });
});
