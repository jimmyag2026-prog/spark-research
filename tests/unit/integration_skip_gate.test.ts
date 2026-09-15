import { describe, expect, test } from "bun:test";
import { decideExitCode, skippedTestNames, summarize } from "../../scripts/check-integration-skip";

// δ-1（USAGE_LOG U7）· 绊线本身的门禁。
//
// 被测的是纯函数 `decideExitCode(bun 测试输出, bun 自己的退出码)`，喂的是真实形状的
// bun test 摘要文本（下面几段都照抄自实跑输出），不 spawn 子进程——所以这条用例
// 属于 `bun test tests/unit`，零额外耗时、不受并行噪音影响。
//
// 要守住的四件事：
//   ① 全部 skip → 退出 1（U7 现场：`0 pass / 8 skip / 0 fail`，27ms，读起来像绿的）
//   ② **部分 skip → 退出 1**（收口复跑抓到的漏洞：第一版只拦「全跳」，
//      给一个文件加 `.skipIf(true)` 得到 `6 pass / 2 skip / 0 fail`，脚本退出 0 放行了）
//   ③ 一个用例都没收集到 → 退出 1（同一形态的另一半，U7 里点名的 pytest 零收集先例）
//   ④ 真有用例失败时原样透传 bun 的退出码——绊线不许把真失败改写成别的码

// U7 记录的现场输出（δ-1 修复前，`bun run test:integration` 的原样输出）。
const ALL_SKIPPED = `
 0 pass
 8 skip
 0 fail
Ran 8 tests across 3 files. [27.00ms]
`;

// δ-1 修复后同一条命令的实跑输出。
const ALL_PASSING = `
 8 pass
 0 fail
 11 expect() calls
Ran 8 tests across 3 files. [69.00ms]
`;

// 收口复跑的复现原文：只给 tests/integration/protein_record.test.ts 顶层 describe
// 加 `.skipIf(true)`，`bun run test:integration` 的实际输出就是这几行。
const PARTIALLY_SKIPPED = `
 6 pass
 2 skip
 0 fail
 5 expect() calls
Ran 8 tests across 3 files. [81.00ms]
`;

// 没有 skip 但 pass 少于收集数（例如 todo）——判据③ 兜的就是这种不带「skip」措辞的形态。
const HAS_TODO = `
 6 pass
 2 todo
 0 fail
Ran 8 tests across 3 files. [60.00ms]
`;

const NOTHING_COLLECTED = `
 0 pass
 0 fail
Ran 0 tests across 0 files. [3.00ms]
`;

const HAS_FAILURE = `
 6 pass
 2 fail
Ran 8 tests across 3 files. [88.00ms]
`;

describe("check-integration-skip · summarize", () => {
  test("从 bun test 摘要里读出 pass / skip / fail", () => {
    expect(summarize(ALL_SKIPPED)).toEqual({ pass: 0, skip: 8, fail: 0, todo: 0, collected: 8, total: 8 });
    expect(summarize(ALL_PASSING)).toEqual({ pass: 8, skip: 0, fail: 0, todo: 0, collected: 8, total: 8 });
    expect(summarize(PARTIALLY_SKIPPED)).toEqual({ pass: 6, skip: 2, fail: 0, todo: 0, collected: 8, total: 8 });
  });

  test("total 优先信 `Ran N tests`，而不是四项相加", () => {
    // 摘要行缺项时，`Ran N tests` 仍然给得出收集数——判据③ 依赖的就是它。
    expect(summarize("\n 6 pass\n 0 fail\nRan 8 tests across 3 files. [9ms]\n").total).toBe(8);
    expect(summarize(HAS_TODO)).toEqual({ pass: 6, skip: 0, fail: 0, todo: 2, collected: 8, total: 8 });
  });

  test("摘要里没有某一项时按 0 计，不抛", () => {
    expect(summarize(NOTHING_COLLECTED)).toEqual({ pass: 0, skip: 0, fail: 0, todo: 0, collected: 0, total: 0 });
    expect(summarize("完全不是 bun test 的输出")).toEqual({
      pass: 0, skip: 0, fail: 0, todo: 0, collected: null, total: 0,
    });
  });
});

describe("check-integration-skip · decideExitCode", () => {
  test("① 全部跳过 → 退出 1（U7 现场：0 pass / 8 skip / 0 fail 不许再算通过）", () => {
    expect(decideExitCode(ALL_SKIPPED, 0)).toBe(1);
  });

  test("② 部分跳过 → 退出 1（收口复跑的漏洞：6 pass / 2 skip / 0 fail 曾被放行）", () => {
    expect(decideExitCode(PARTIALLY_SKIPPED, 0)).toBe(1);
  });

  test("③ 一个用例都没收集到 → 退出 1", () => {
    expect(decideExitCode(NOTHING_COLLECTED, 0)).toBe(1);
  });

  test("③ 没有 skip 但 pass 不足收集数（todo）→ 退出 1", () => {
    expect(decideExitCode(HAS_TODO, 0)).toBe(1);
  });

  test("有 pass → 退出 0", () => {
    expect(decideExitCode(ALL_PASSING, 0)).toBe(0);
  });

  test("④ bun 自己非零退出时原样透传，不被绊线改写", () => {
    expect(decideExitCode(HAS_FAILURE, 1)).toBe(1);
    // 137 = 被 SIGKILL 打死（OOM / 超时杀进程）。这类码必须原样带出去，
    // 否则 CI 上「被杀」会被误报成「全跳过」，查错方向整个歪掉。
    expect(decideExitCode(ALL_SKIPPED, 137)).toBe(137);
    expect(decideExitCode("", 2)).toBe(2);
  });
});

// bun 的 junit reporter 实际写出来的形状（照抄自本机一次真实运行：只给 protein 那个文件
// 加了 `.skipIf(true)`）。跳过的 testcase 是**非自闭合**、带 `<skipped />` 子元素；
// 没跳过的是自闭合 `<testcase … />`。
const JUNIT_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test">
<testsuite name="tests/integration/protein_record.test.ts">
<testcase name="UniProt → PDB → AlphaFold 三段链路" classname="protein-analysis" time="0" file="tests/integration/protein_record.test.ts" line="42" assertions="0">
<skipped />
</testcase>
<testcase name="AlphaFold 未收录的 accession：是结论不是故障" classname="protein-analysis" time="0" file="tests/integration/protein_record.test.ts" line="67" assertions="0">
<skipped />
</testcase>
</testsuite>
<testsuite name="tests/integration/literature_record.test.ts">
<testcase name="跨源检索四个免 key 源" classname="文献链路" time="0.005" file="tests/integration/literature_record.test.ts" line="53" assertions="1" />
<testcase name="按 DOI 取单篇" classname="文献链路" time="0.002" file="tests/integration/literature_record.test.ts" line="74" assertions="1" />
</testsuite>
</testsuites>
`;

describe("check-integration-skip · 从 junit 报告里捞被跳过的用例名", () => {
  test("只列出带 <skipped> 的那几条，自闭合的不算", () => {
    expect(skippedTestNames(JUNIT_SAMPLE)).toEqual([
      "tests/integration/protein_record.test.ts :: protein-analysis > UniProt → PDB → AlphaFold 三段链路",
      "tests/integration/protein_record.test.ts :: protein-analysis > AlphaFold 未收录的 accession：是结论不是故障",
    ]);
  });

  test("自闭合的 testcase 不会把后面某条的 </testcase> 当成自己的（否则会误报）", () => {
    // 自闭合在前、带 skipped 的在后：如果不按自己的 </testcase> 截断 body，
    // 第一条会一路读到第二条的 </testcase>，把别人的 skipped 算到自己头上。
    const xml =
      `<testcase name="通过的" classname="C" file="a.ts" />` +
      `<testcase name="跳过的" classname="C" file="a.ts"><skipped /></testcase>`;
    expect(skippedTestNames(xml)).toEqual(["a.ts :: C > 跳过的"]);
  });

  test("一条都没跳过 → 空数组；不是 junit 的文本 → 空数组，不抛", () => {
    const xml = `<testcase name="a" classname="C" file="a.ts" /><testcase name="b" classname="C" file="a.ts" />`;
    expect(skippedTestNames(xml)).toEqual([]);
    expect(skippedTestNames("")).toEqual([]);
    expect(skippedTestNames("完全不是 XML")).toEqual([]);
  });

  test("用例名里的 XML 转义字符要还原（& < > 在中文测试名里很常见）", () => {
    const xml = `<testcase name="a &amp; b &lt;c&gt;" classname="C &amp; D" file="a.ts"><skipped /></testcase>`;
    expect(skippedTestNames(xml)).toEqual(["a.ts :: C & D > a & b <c>"]);
  });
});
