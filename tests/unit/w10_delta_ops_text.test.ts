import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ellipsize, runConfigCommand } from "../../backend/src/config/cli";
import { importExport } from "../../backend/src/data/import";
import { ProjectManager } from "../../backend/src/project/manager";
import { createApp } from "../../backend/src/server/app";

// δ-3（V163 / V169 / V170）门禁。三条文案/文档漂移各一条，外加一条把 V170 那类漂移
// 长期兜住的断言（任务书里写的 /api/ 路径必须真的注册在 app 上）。

describe("δ-3 V163 · config list 长值加省略号", () => {
  test("ellipsize：超长才截，截了就带 …，总宽不超 max", () => {
    expect(ellipsize("abc", 5)).toBe("abc");
    expect(ellipsize("abcdefghij", 5)).toBe("abcd…");
    // CJK 按两列算：6 列预算 → 正文只放得下 2 个汉字（4 列）+ …
    expect(ellipsize("中文中文中文", 6)).toBe("中文…");
  });

  test("接线：config list 真实输出里，被截断的值带 …", () => {
    const root = mkdtempSync(join(tmpdir(), "w10-delta-cfg-"));
    const longValue = "http://a.example.com,http://b.example.com,http://c.example.com";
    Bun.write(join(root, "config.json"), JSON.stringify({ originAllowlist: longValue }));
    const lines: string[] = [];
    const code = runConfigCommand(["list"], { root, out: (l) => lines.push(l) });
    expect(code).toBe(0);
    const row = lines.find((l) => l.startsWith("originAllowlist"));
    expect(row).toBeDefined();
    // 钉的是「接线」：渲染那一行真的经过了 ellipsize，而不是只有辅助函数自己对。
    expect(row!).toContain("…");
    expect(row!).not.toContain(longValue);
  });
});

describe("δ-3 V169 · data import 拒绝文案与判据一致", () => {
  test("目标项目已存在 → 文案说「须不存在」，不再说「只重建到空项目」", () => {
    const manager = new ProjectManager(mkdtempSync(join(tmpdir(), "w10-delta-imp-")));
    manager.create("taken");
    let message = "";
    try {
      importExport(manager, mkdtempSync(join(tmpdir(), "w10-delta-dir-")), "taken");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // 判据本身：拒的是「已存在」，不是「非空」。
    expect(message).toContain("已存在");
    expect(message).toContain("须不存在");
    expect(message).not.toContain("只重建到空项目");
  });
});

describe("δ-3 V170 · 任务书里的 /api/ 路径必须存在", () => {
  // 把 V170 那类漂移长期兜住：任务书里写的每个 /api/ 路径，都要能在 createApp() 注册的
  // 路由表里找到匹配的模式。T5 第 13 步引用的 `/api/config/OPENROUTER_API_KEY` 就是这样
  // 漂掉的——端点早改名成 `/api/settings/general/:key`，文档没人改，验收者照着敲得到 404。
  function docApiPaths(): Array<{ file: string; path: string }> {
    const out: Array<{ file: string; path: string }> = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".md")) {
          for (const m of readFileSync(full, "utf8").matchAll(/`?(\/api\/[A-Za-z0-9_\-./:{}*]*)/g)) {
            // 注册路由里没有一条带 `.`，所以行文里的 `/api/health.version`（「health 的
            // version 字段」）按 `/api/health` 算，标点尾巴一并去掉。
            const raw = m[1]!.split(".")[0]!.replace(/[,;)]+$/, "");
            if (raw === "/api/" || raw.includes("*")) continue;
            out.push({ file: full, path: raw });
          }
        }
      }
    };
    walk("docs/taskbooks");
    return out;
  }

  function routeMatches(registered: string[], documented: string): boolean {
    return registered.some((pattern) => {
      const p = pattern.split("/").filter(Boolean);
      const d = documented.split("/").filter(Boolean);
      if (p.length !== d.length) return false;
      return p.every((seg, i) => seg.startsWith(":") || seg === d[i]);
    });
  }

  test("docs/taskbooks/** 里出现的 /api/ 路径都注册在 app 上", () => {
    const app = createApp({ root: mkdtempSync(join(tmpdir(), "w10-delta-routes-")) });
    const registered = [...new Set(app.routes.map((r) => r.path))];
    const documented = docApiPaths();
    expect(documented.length).toBeGreaterThan(0);
    const missing = documented.filter((d) => !routeMatches(registered, d.path));
    expect(missing.map((m) => `${m.file}: ${m.path}`)).toEqual([]);
  });
});
