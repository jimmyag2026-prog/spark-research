import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SETTINGS } from "../../backend/src/config";
import {
  DEFAULT_PANEL,
  SETTINGS_PANELS,
  SETTINGS_PANEL_IDS,
  SETTINGS_SECTIONS,
  preloadPanel,
} from "../../frontend/workspace/src/components/settings/registry";

// W9-ε：设置面注册表的门禁。
//
// 这张表是「网页端有哪些设置面板」的真源。它管两件事，两件都是 AD-12 的直接落点：
//   ① 表本身自洽（id 唯一、section 在四组里、每个面板真的能加载）；
//   ② 表里**不许有没底子的面板**，尤其是 `sandbox`——上游 12 个面板里有它，我们没有
//      那个底子（V42：local network 声明不强制）。放一个「未实现」的占位面板等于在 UI
//      里声称一个不存在的能力。
//
// 外加一条只能用 grep 做的：面板源码里不许出现 `CONFIG_SETTINGS` 任何一条说明的原文。
// U6 的修改方向明写「每个键的说明文字 config list 里已经有了，直接用，不要另写一份」；
// 前端再抄一份，两份就会分家，而分家的那天没有任何测试会红——除了这一条。

const SETTINGS_DIR = join(import.meta.dir, "../../frontend/workspace/src/components/settings");

function panelSources(): Array<{ file: string; text: string }> {
  return readdirSync(SETTINGS_DIR)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(SETTINGS_DIR, file), "utf8") }));
}

describe("设置面板注册表", () => {
  test("① 面板 id 唯一，section ∈ 四组，且与 SETTINGS_PANEL_IDS 一一对应", () => {
    const ids = SETTINGS_PANELS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    const sections = new Set(SETTINGS_SECTIONS.map((s) => s.id));
    expect(sections).toEqual(new Set(["inference", "capabilities", "runtime", "app"]));
    for (const panel of SETTINGS_PANELS) {
      expect(sections.has(panel.section)).toBe(true);
    }

    // 真源清单与实际注册表必须是同一个集合：不存在「悄悄多一个面板」或
    // 「清单里写了但没人注册」。
    expect(new Set(ids)).toEqual(new Set(SETTINGS_PANEL_IDS));
    expect(SETTINGS_PANEL_IDS).toContain(DEFAULT_PANEL);
  });

  test("① 减配面板必须写清少了哪一块（gap 非空）", () => {
    for (const panel of SETTINGS_PANELS) {
      if (panel.parity === "reduced") {
        expect(panel.gap ?? "").not.toBe("");
      } else {
        // 标成「能力对齐」就不许再挂一条「其实还少点什么」的尾巴。
        expect(panel.gap).toBeUndefined();
      }
    }
  });

  // ② 「每个面板的 component 可懒加载」。
  //
  // **这里做不到真的 import 一遍**，如实记下来：Solid 的 JSX 不是 React 那种运行时
  // 工厂，`solid-js/jsx-dev-runtime` 指向 `dist/solid.js`，里面根本没有 `jsxDEV` 导出
  // ——JSX 是由 `vite-plugin-solid` 在编译期整个消掉的。bun test 没有那个插件，
  // `import("./General.tsx")` 必然 `SyntaxError: Export named 'jsxDEV' not found`。
  // （试过在文件头加 `@jsxImportSource solid-js` 的 pragma，能改变解析目标但改不了
  // 那个模块没有这个导出的事实。）
  //
  // 所以这一条拆成两半，两半都不靠自觉：
  //   - 静态半：`lazy()` 真的产出了一个组件函数，且它 import 的路径在磁盘上真有文件、
  //     文件里真有 `export default`。路径是从 registry.ts 源码里读出来的，不是测试里
  //     手抄的第二份映射——写错一个字母这里就红。
  //   - 运行半：每个面板在 tests/e2e/workbench.spec.ts 里都有一条用例，在真浏览器里
  //     点开它并断言内容。懒加载真的能加载，是那边证的。
  test("② 每个面板的 component 是 lazy 组件，且 import 的文件真实存在、有默认导出", async () => {
    for (const panel of SETTINGS_PANELS) {
      expect(typeof panel.component).toBe("function");
      await preloadPanel(panel.id).catch(() => undefined);

      const file = join(SETTINGS_DIR, sourceFileFor(panel.id));
      const source = readFileSync(file, "utf8");
      expect(source).toContain("export default");
    }
  });

  test("③ 面板源码里不得出现任何 CONFIG_SETTINGS 说明的原文（说明只有一份，来自 API）", () => {
    const sources = panelSources();
    const offenders: string[] = [];

    for (const spec of CONFIG_SETTINGS) {
      // 太短的片段容易假阳性（比如两三个字的通用词），只查有辨识度的整句。
      for (const prose of [spec.summary, spec.effect]) {
        if (typeof prose !== "string" || prose.length < 12) continue;
        for (const source of sources) {
          if (source.text.includes(prose)) {
            offenders.push(`${source.file} 抄了 ${spec.key} 的说明原文`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("④ 没有 sandbox 面板，也没有 sandbox 占位文件", () => {
    expect(SETTINGS_PANEL_IDS as readonly string[]).not.toContain("sandbox");
    expect(SETTINGS_PANELS.map((p) => p.id as string)).not.toContain("sandbox");

    const files = readdirSync(SETTINGS_DIR).map((f) => f.toLowerCase());
    expect(files.some((f) => f.startsWith("sandbox."))).toBe(false);
  });
});

// 面板 id → 源文件名。注册表里是 `lazy(() => import("./X"))`，字符串在闭包里拿不到，
// 所以从 registry.ts 源码里把这一对关系读出来，而不是在测试里手抄第二份映射。
function sourceFileFor(id: string): string {
  const registry = readFileSync(join(SETTINGS_DIR, "registry.ts"), "utf8");
  const pattern = new RegExp(`id:\\s*"${id}"[\\s\\S]*?import\\("\\./([A-Za-z]+)"\\)`);
  const match = registry.match(pattern);
  if (!match) throw new Error(`registry.ts 里找不到面板 ${id} 的 import`);
  return `${match[1]}.tsx`;
}
