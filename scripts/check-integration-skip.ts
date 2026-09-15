#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// δ-1（USAGE_LOG U7）绊线。
//
// 背景：`bun test tests/integration` 曾经恒定 `0 pass / 8 skip / 0 fail`——三个文件顶层
// 都是 `describe.skipIf(!RECORDING)`，默认 FIXTURE_MODE=replay 下整套不执行。`0 fail`
// 让人读成「过了」，实际那三条链路一次都没被验证。根治已经做了（去掉 skipIf，replay 下
// 照常回放执行，见三个测试文件顶部注释），**这个脚本是绊线，不是根治**。
//
// 判据（收口复跑时收紧过一次，见下）：`bun test` 自己非零退出时原样透传；否则
//
//   ① 一个用例都没收集到            → 1
//   ② skip 数 > 0                   → 1
//   ③ pass 数 < 收集数              → 1
//
// **② 是收口复跑抓到的漏洞补的。** 第一版只拦「全部跳过」（`skip === total`），
// 于是「只跳一个文件」这种更常见的形态从门缝里过去了：给
// `tests/integration/protein_record.test.ts` 顶层 describe 加一个 `.skipIf(true)`，
// 输出是 `6 pass / 2 skip / 0 fail`，脚本**退出 0**。U7 要的从来不是「别整套跳过」，
// 是「任何一条没跑都要显形」——一条链路没验和三条链路没验，差别只是程度。
// ③ 是 ② 的兜底：它不依赖「skip」这个词出现在摘要里，只要「收集了 N 条、通过的不足 N 条」
// 就判红，能一并兜住 todo、以及将来 bun 改了摘要措辞的情况。
//
// 拦下时会**逐条打印跳过了哪些用例**。bun 默认 reporter 只给汇总数字、不列名字，
// 所以这里同时让它写一份 junit XML 到临时文件，从里面把 `<skipped/>` 的用例名捞出来
// （拿不到就降级成一句提示，不因为拿不到名字就不报）。
//
// 可测试性：核心判定是纯函数 `decideExitCode` / `summarize` / `skippedTestNames`，
// 单测直接喂模拟的 bun 输出与 junit 文本，不需要真的 spawn 子进程
// （见 tests/unit/integration_skip_gate.test.ts）。

export interface Summary {
  pass: number;
  skip: number;
  fail: number;
  todo: number;
  /** `Ran N tests across M files` 里的 N；拿不到时为 null。 */
  collected: number | null;
  /** 判据用的总数：优先信 `Ran N tests`，拿不到才退回四项相加。 */
  total: number;
}

function count(output: string, word: string): number {
  const m = output.match(new RegExp(`(\\d+)\\s+${word}\\b`));
  return m ? Number(m[1]) : 0;
}

export function summarize(output: string): Summary {
  const pass = count(output, "pass");
  const skip = count(output, "skip");
  const fail = count(output, "fail");
  const todo = count(output, "todo");
  const ran = output.match(/Ran\s+(\d+)\s+tests?\b/);
  const collected = ran ? Number(ran[1]) : null;
  return { pass, skip, fail, todo, collected, total: collected ?? pass + skip + fail + todo };
}

/**
 * bunTestExitCode：`bun test tests/integration` 自己的退出码。非零（真的有用例失败）时
 * 原样透传——绊线只用来堵「看起来绿但没全跑」，不能反过来把真失败盖成别的退出码
 * （137 这类被 SIGKILL 打死的码尤其要原样带出去，否则查错方向整个歪掉）。
 */
export function decideExitCode(output: string, bunTestExitCode: number): number {
  if (bunTestExitCode !== 0) return bunTestExitCode;
  const { pass, skip, total } = summarize(output);
  // ① 一个用例都没收集到，也是「什么都没验证却退出 0」。U7 里点名的先例就是这个形态的
  // 另一半：pytest 曾因文件名不匹配静默收集到零个用例，整个 Python 侧等于没有门槛。
  if (total === 0) return 1;
  // ② 任何一条被跳过就判红——不是只拦「全跳」。
  if (skip > 0) return 1;
  // ③ 不依赖「skip」措辞的兜底：收集了 N 条，通过的不足 N 条。
  if (pass < total) return 1;
  return 0;
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#10;": "\n",
  "&#13;": "\r",
  "&#9;": "\t",
};

function unescapeXml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#10|#13|#9);/g, (m) => XML_ENTITIES[m] ?? m);
}

function attr(head: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(head);
  return m ? unescapeXml(m[1]!) : null;
}

/**
 * 从 bun 的 junit XML 里捞出被跳过的用例名。
 *
 * bun 把跳过的 testcase 写成带 `<skipped />` 子元素的非自闭合标签，没跳过的写成自闭合
 * （`<testcase … />`）。所以判据是「这条 testcase 不是自闭合，且它自己的 body 里有 <skipped」——
 * 必须按自己的 `</testcase>` 截断 body，否则自闭合的那条会一路读到后面某条的 `</testcase>`，
 * 把别人的 skipped 算到自己头上。
 */
export function skippedTestNames(xml: string): string[] {
  const names: string[] = [];
  for (const part of xml.split(/<testcase\b/).slice(1)) {
    const gt = part.indexOf(">");
    if (gt === -1) continue;
    const head = part.slice(0, gt + 1);
    if (head.replace(/\s+$/, "").endsWith("/>")) continue; // 自闭合 = 没有子元素 = 没跳过
    const rest = part.slice(gt + 1);
    const end = rest.indexOf("</testcase>");
    const inner = end === -1 ? rest : rest.slice(0, end);
    if (!inner.includes("<skipped")) continue;
    const name = attr(head, "name") ?? "(未知用例)";
    const file = attr(head, "file");
    const cls = attr(head, "classname");
    names.push(`${file ? `${file} :: ` : ""}${cls ? `${cls} > ` : ""}${name}`);
  }
  return names;
}

if (import.meta.main) {
  const workDir = mkdtempSync(join(tmpdir(), "spark-integration-gate-"));
  const junitPath = join(workDir, "integration.junit.xml");
  try {
    const result = spawnSync(
      "bun",
      ["test", "tests/integration", "--reporter=junit", `--reporter-outfile=${junitPath}`],
      { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] },
    );
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    process.stdout.write(stdout);
    process.stderr.write(stderr);

    const combined = `${stdout}\n${stderr}`;
    const exitCode = decideExitCode(combined, result.status ?? 1);
    if (exitCode === 1 && (result.status ?? 0) === 0) {
      const mode = process.env.FIXTURE_MODE ?? "(未设置，默认 replay)";
      const { pass, skip, total } = summarize(combined);
      const lines: string[] = [""];
      if (total === 0) {
        lines.push("✖ check-integration-skip：tests/integration 一个用例都没收集到——退出 0 不代表验证过。");
      } else if (skip === total) {
        lines.push(
          "✖ check-integration-skip：tests/integration 全部用例都被跳过——这不是「通过」，" +
            `是本轮三条集成链路一次都没被验证。当前 FIXTURE_MODE=${mode}。`,
        );
      } else {
        lines.push(
          `✖ check-integration-skip：tests/integration 收集了 ${total} 条，只跑了 ${pass} 条` +
            `（${skip} 条被跳过）。当前 FIXTURE_MODE=${mode}。`,
        );
        lines.push("  没跑的那几条等于本轮没被验证——门禁不区分「跳了一条」和「跳了全部」，只区分「跑没跑」。");
      }

      const skipped = existsSync(junitPath) ? skippedTestNames(readFileSync(junitPath, "utf8")) : [];
      if (skipped.length > 0) {
        lines.push("", "  被跳过的用例：");
        for (const name of skipped) lines.push(`    · ${name}`);
      } else if (skip > 0) {
        lines.push("", "  （拿不到被跳过用例的名字：junit 报告没生成或解析不出，只能报数量。）");
      }

      lines.push(
        "",
        "  δ-1 之后这套用例在默认 replay 下就该全跑（零网络，回放 tests/fixtures/**）；" +
          "有 skip 说明有人加了条件跳过，或 fixture 不可用。",
      );
      console.error(lines.join("\n"));
    }
    process.exit(exitCode);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
