import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_SETTINGS } from "../../backend/src/config";
import {
  DEFAULT_PANEL,
  SETTINGS_PANEL_IDS,
  SETTINGS_PANEL_INFO,
  SETTINGS_SECTIONS,
} from "../../frontend/workspace/src/components/settings/registry_table";

// W9-ε：设置面注册表的门禁。
//
// 这张表是「网页端有哪些设置面板」的真源。它管四件事，每件都是 AD-12 的直接落点：
//   ① 表本身自洽（id 唯一、section 在四组里、清单与明细一一对应）；
//   ② 每个面板真的绑到了一个存在的实现文件（正反两向核，不许有孤儿绑定）；
//   ③ 面板源码里不许出现 `CONFIG_SETTINGS` 任何一条说明的原文——U6 的修改方向明写
//      「每个键的说明文字 config list 里已经有了，直接用，不要另写一份」；前端再抄一份，
//      两份就会分家，而分家的那天没有任何测试会红，除了这一条；
//   ④ 表里**不许有没底子的面板**，尤其是 `sandbox`——上游 12 个面板里有它，我们没有
//      那个底子（V42：local network 声明不强制）。放一个「未实现」的占位面板等于在 UI
//      里声称一个不存在的能力。
//
// **为什么 import 的是 `registry_table.ts` 而不是 `registry.ts`**：后者有
// `lazy(() => import("./General"))`，会把一个 `.tsx` 拽进 program，而仓库根的
// tsconfig（`include: tests/**/*.ts`）没开 `jsx`，`bun run typecheck` 会报
// TS6142。真源清单因此单独拆成一个只有数据的模块；两边的一致性由 ② 核对，
// 不靠自觉。

const SETTINGS_DIR = join(import.meta.dir, "../../frontend/workspace/src/components/settings");
const REGISTRY = readFileSync(join(SETTINGS_DIR, "registry.ts"), "utf8");

function panelSources(): Array<{ file: string; text: string }> {
  return readdirSync(SETTINGS_DIR)
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(SETTINGS_DIR, file), "utf8") }));
}

/** registry.ts 里所有 `<id>: lazy(() => import("./X"))` 绑定，从源码读出来。 */
function bindings(): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /(?:"([a-z-]+)"|([A-Za-z][A-Za-z0-9]*)):\s*lazy\(\(\) => import\("\.\/([A-Za-z]+)"\)\)/g;
  for (const match of REGISTRY.matchAll(pattern)) {
    found.set(match[1] ?? match[2]!, `${match[3]}.tsx`);
  }
  return found;
}

describe("设置面板注册表", () => {
  test("① 面板 id 唯一，section ∈ 四组，清单与明细一一对应", () => {
    const ids = SETTINGS_PANEL_INFO.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    const sections = new Set(SETTINGS_SECTIONS.map((s) => s.id));
    expect(sections).toEqual(new Set(["inference", "capabilities", "runtime", "app"]));
    for (const panel of SETTINGS_PANEL_INFO) {
      expect(sections.has(panel.section)).toBe(true);
      expect(panel.title.trim()).not.toBe("");
      expect(panel.glyph.trim()).not.toBe("");
    }

    // 不存在「悄悄多一个面板」或「清单里写了但没人注册」。
    expect(new Set(ids)).toEqual(new Set(SETTINGS_PANEL_IDS));
    expect(SETTINGS_PANEL_IDS as readonly string[]).toContain(DEFAULT_PANEL);
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
  //   - 静态半：清单里每个 id 在 registry.ts 里都有一条 `lazy(import)` 绑定，绑定的
  //     文件真的存在、真的有 `export default`；**反向**也核——registry.ts 里不许有
  //     清单之外的绑定。绑定关系是从源码里读出来的，不是测试里手抄的第二份映射。
  //   - 运行半：每个面板在 tests/e2e/workbench.spec.ts 里都有一条用例，在真浏览器里
  //     点开它并断言内容。懒加载真的能加载，是那边证的。
  test("② 每个面板都绑到一个真实存在、有默认导出的实现文件（正反两向）", () => {
    const bound = bindings();
    const files = new Set(readdirSync(SETTINGS_DIR));

    for (const id of SETTINGS_PANEL_IDS) {
      const file = bound.get(id);
      expect(file, `registry.ts 里没有面板 ${id} 的 lazy import 绑定`).toBeDefined();
      expect(files.has(file!), `${file} 不存在`).toBe(true);
      expect(readFileSync(join(SETTINGS_DIR, file!), "utf8")).toContain("export default");
    }

    // 反向：绑定表里不许有清单外的面板（删了清单项却忘了删绑定 → 红）。
    expect([...bound.keys()].sort()).toEqual([...SETTINGS_PANEL_IDS].sort());
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

  test("③b 前端不存第二份能力分级（分级只来自 API 的 meta.level）", () => {
    // 面板「全功能 / 减配 / 只读」的判断是后端给的。注册表里一旦又长出一个
    // `parity` / `level` / `gap` 字段，就有了第二个真源，且两边分家时没人会红。
    for (const forbidden of ["parity", "gap:", "level:"]) {
      expect(
        REGISTRY.includes(forbidden),
        `registry.ts 里出现了 ${forbidden}——能力分级只能来自 API 的 meta.level`,
      ).toBe(false);
    }
  });

  test("④ 没有 sandbox 面板，也没有 sandbox 占位文件", () => {
    expect(SETTINGS_PANEL_IDS as readonly string[]).not.toContain("sandbox");
    expect(bindings().has("sandbox")).toBe(false);

    const files = readdirSync(SETTINGS_DIR).map((f) => f.toLowerCase());
    expect(files.some((f) => f.startsWith("sandbox."))).toBe(false);
  });
});
