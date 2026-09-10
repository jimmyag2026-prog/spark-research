import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoctorReport } from "../../backend/src/doctor";

// W6-1 lane γ · V53：doctor 的 `packagingLimitation` 机制（识别失败原因里的 `/$bunfs/`
// 子串 → 标 ⚠️ 而不是 ❌）此前只被「装依赖也解决不了」的真实故障（chem depict，见
// docs/devlog/F-c.md）间接验证过一次，且那次故障根本不在 doctor 的探测范围内——
// `doctor --json` 三档 `packagingLimitation` 全是 false（BACKLOG V53）。
//
// `tests/unit/doctor.test.ts`（F-c 那次落的）已经用注入的假探测结果验证过分类逻辑本身
// （命中 /$bunfs/ → true，正常「装一下」文案 → false）。这里补的是 V53 任务书点名、
// 前者没覆盖的一个具体缺口：**负例用真实 Node/Python 会产生的 ENOENT 报错原文**（而不是
// 已经改写过的「xxx 不可用：装一下」这种成品文案），确认它不会被 `/$bunfs/` 子串判定
// 误伤——两种「探测失败」的措辞都要各自落在正确的一侧。

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "spark-doctor-w61-"));
}

describe("V53 · packagingLimitation 用构造的 fake 探测结果验证，而非等真实故障撞上", () => {
  test("探测失败原因里含 /$bunfs/ 的 fake 结果 → packagingLimitation=true，文案是「打包限制」而不是「缺依赖」", async () => {
    const report = await buildDoctorReport({
      root: tmpRoot(),
      env: {},
      python: "fake-python",
      probePython: async () => ({ path: "fake-python", ok: true, version: "x", error: null }),
      probeScience: async () => ({ ok: true, reason: null }),
      probeLab: async () => ({
        ok: false,
        reason:
          "opentrons 模拟器不可用（python=python3, exit=2）：" +
          "/usr/bin/python3: can't open file '/$bunfs/root/opentrons_backend.py': No such file or directory。" +
          "安装：VIRTUAL_ENV=.venv uv pip install opentrons",
      }),
      frontendDir: tmpRoot(),
    });
    const lab = report.tiers.find((t) => t.id === "lab")!;
    expect(lab.packagingLimitation).toBe(true);
    // 文案必须是「这是打包限制，装依赖没用」，不能是听起来像缺依赖的建议。
    expect(lab.reason).toContain("不是依赖没装");
    expect(lab.reason).not.toMatch(/^opentrons 不可用：装一下/);
  });

  test("阴性对照：真实 Node ENOENT 报错原文（不含 /$bunfs/）不得被误判为打包限制", async () => {
    // 这是「依赖真的没装」时 Node/子进程会产出的原生报错形状——不是经过 describeTierReason
    // 改写过的成品文案，是探测器可能原样透传的那种真实错误字符串。
    const rawEnoent =
      "Error: ENOENT: no such file or directory, open " +
      "'/Users/x/.venv/lib/python3.12/site-packages/opentrons/__init__.py'";
    const report = await buildDoctorReport({
      root: tmpRoot(),
      env: {},
      python: "fake-python",
      probePython: async () => ({ path: "fake-python", ok: true, version: "x", error: null }),
      probeScience: async () => ({ ok: false, reason: rawEnoent }),
      probeLab: async () => ({ ok: true, reason: null }),
      frontendDir: tmpRoot(),
    });
    const science = report.tiers.find((t) => t.id === "science")!;
    expect(science.packagingLimitation).toBe(false);
    // 原始报错必须原样透传，不能被「打包限制」的改写逻辑碰过。
    expect(science.reason).toBe(rawEnoent);
    expect(science.reason).not.toContain("BACKLOG V27");
    expect(science.reason).not.toContain("不是依赖没装");
  });
});
