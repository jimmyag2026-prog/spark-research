import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";

// W8-2 SDK lane · `sdk/python/pyproject.toml` 的 version 字段要跟根 package.json 同步。
//
// npm semver 的预发布写法（`0.8.0-alpha.1`）不是合法 PEP 440（Python 包版本号），
// 所以不能原样抄——要转写：`-alpha.N` → `aN`，`-beta.N` → `bN`，`-rc.N` → `rcN`；
// 没有预发布后缀就原样保留。转写规则在这里复刻一份（纯字符串处理，没有第二套
// 语义），只用来钉住"两处版本号没有漂移"，不是这条门禁本身的真源。

function toPep440(npmVersion: string): string {
  const m = /^(\d+\.\d+\.\d+)-(alpha|beta|rc)\.(\d+)$/.exec(npmVersion);
  if (!m) return npmVersion;
  const suffix: Record<string, string> = { alpha: "a", beta: "b", rc: "rc" };
  return `${m[1]}${suffix[m[2]!]}${m[3]}`;
}

const REPO_ROOT = join(import.meta.dir, "../..");

describe("W8-2 SDK · pyproject.toml 版本与 package.json 同步", () => {
  test("sdk/python/pyproject.toml 的 version 字段 == package.json 版本的 PEP440 转写", () => {
    const expected = toPep440(pkg.version);
    const pyproject = readFileSync(join(REPO_ROOT, "sdk/python/pyproject.toml"), "utf8");
    const m = /^version = "([^"]+)"$/m.exec(pyproject);
    expect(m, "sdk/python/pyproject.toml 缺少顶层 version 字段").not.toBeNull();
    expect(m![1]).toBe(expected);
  });

  test("PEP440 转写规则本身的形状（防止转写函数被改坏而两边一起漂移还测不出来）", () => {
    expect(toPep440("0.8.0-alpha.1")).toBe("0.8.0a1");
    expect(toPep440("1.2.3-beta.4")).toBe("1.2.3b4");
    expect(toPep440("1.2.3-rc.5")).toBe("1.2.3rc5");
    expect(toPep440("1.2.3")).toBe("1.2.3");
  });
});
