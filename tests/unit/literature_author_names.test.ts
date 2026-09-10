import { describe, expect, test } from "bun:test";
import { assignBibtexKeys, bibtexBaseKey, toCSLJSON, toCSLName } from "../../backend/src/literature/export";
import { authorSurname, emptyPaper, firstAuthorSurname, type Paper } from "../../backend/src/literature/models";

// V38：「Last F」形态的作者名（Europe PMC / PubMed 的原生形态）。
//
// 外部验收发现：`lit export --format bibtex` 对 Europe PMC 入库的论文生成的引用 key
// 是 `j2021xxx` 而不是 `jumper2021xxx`——旧的 authorSurname 无条件取最后一段当姓，
// 而这些源给的是 `"Jumper J"`（姓在前、名缩写在后）。
//
// 修法的判据是「最后一段是不是 1~3 个大写字母（可带点）」。下面两组用例分别锁住
// **修好的形态**与**不能被误伤的形态**——后者更要紧：一个过于激进的判据会把
// `"Jan van der Berg"` 的姓改错，那是把一个引用 key bug 换成另一个。

function paper(overrides: Partial<Paper>): Paper {
  return { ...emptyPaper(), ...overrides };
}

describe("作者姓名解析 · V38「Last F」形态", () => {
  test("Europe PMC / PubMed 形态：姓在前、名缩写在后", () => {
    expect(authorSurname("Jumper J")).toBe("jumper");
    expect(authorSurname("Varadi MG")).toBe("varadi");
    expect(authorSurname("Evans R")).toBe("evans");
    // 带点的缩写同样是缩写
    expect(authorSurname("Jumper J.")).toBe("jumper");
    expect(authorSurname("Tunyasuvunakool K.A.")).toBe("tunyasuvunakool");
    // 复姓 + 缩写：姓是缩写之前的全部
    expect(authorSurname("van der Berg J")).toBe("van der berg");
  });

  test("不能误伤：西式「名 姓」、逗号形态、单名、中文名的既有行为原样保留", () => {
    expect(authorSurname("John Jumper")).toBe("jumper");
    expect(authorSurname("Jan van der Berg")).toBe("berg");
    expect(authorSurname("Lovelace, Ada")).toBe("lovelace");
    expect(authorSurname("Plato")).toBe("plato");
    expect(authorSurname("张伟")).toBe("张伟");
    // "Li" / "Xu" 含小写字母 → 不是缩写，仍按「最后一段是姓」处理
    expect(authorSurname("Xu Li")).toBe("li");
    expect(authorSurname("")).toBe("");
  });

  test("bibtex key：Europe PMC 形态不再退化成单字母", () => {
    const epmc = paper({
      title: "Highly accurate protein structure prediction with AlphaFold",
      authors: [{ name: "Jumper J" }],
      year: 2021,
    });
    expect(bibtexBaseKey(epmc)).toBe("jumper2021highly");
    // 同一篇论文从 OpenAlex 入库（"John Jumper"）必须得到**同一个 key**——
    // 这才是 V38 的实质危害：同源同篇、key 却随入库渠道而变。
    const openalex = paper({ ...epmc, authors: [{ name: "John Jumper" }] });
    expect(bibtexBaseKey(openalex)).toBe(bibtexBaseKey(epmc));
  });

  test("跨源去重用的首作者姓也跟着修正（同一篇论文两个源不再姓得不一样）", () => {
    const a = paper({ authors: [{ name: "Jumper J" }] });
    const b = paper({ authors: [{ name: "John Jumper" }] });
    expect(firstAuthorSurname(a)).toBe(firstAuthorSurname(b));
    expect(firstAuthorSurname(a)).toBe("jumper");
  });

  test("CSL-JSON 姓名：family/given 不再颠倒", () => {
    expect(toCSLName("Jumper J")).toEqual({ family: "Jumper", given: "J" });
    expect(toCSLName("Varadi MG")).toEqual({ family: "Varadi", given: "MG" });
    // 既有行为不变
    expect(toCSLName("Lovelace, Ada")).toEqual({ family: "Lovelace", given: "Ada" });
    expect(toCSLName("Plato")).toEqual({ literal: "Plato" });
    expect(toCSLName("Jan van der Berg")).toEqual({ family: "Berg", given: "Jan van der" });
  });

  test("CSL 导出整篇：Europe PMC 形态的作者列表 family 全部正确", () => {
    const p = paper({
      title: "Protein structure prediction",
      authors: [{ name: "Jumper J" }, { name: "Evans R" }, { name: "Ada Lovelace" }],
      year: 2021,
    });
    const item = toCSLJSON([p])[0]!;
    expect(item.author!.map((a) => a.family)).toEqual(["Jumper", "Evans", "Lovelace"]);
  });

  test("冲突后缀仍确定：两篇同姓同年同首词按 a/b 排", () => {
    const a = paper({ title: "Highly accurate prediction", authors: [{ name: "Jumper J" }], year: 2021 });
    const b = paper({ title: "Highly accurate prediction", authors: [{ name: "John Jumper" }], year: 2021, doi: "10.1/b" });
    expect(assignBibtexKeys([a, b])).toEqual(["jumper2021highly", "jumper2021highlya"]);
  });
});
