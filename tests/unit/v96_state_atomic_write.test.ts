import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";

// V96（v0.8 G-5）：state.json 非原子写。
// 裸 writeFileSync = 截断 + 写，中间被 kill 留下空/半个 JSON → readState 退回空状态，currentProject
// 与 session 绑定全部丢失。改成同目录 tmp + fsync + rename。
//
// 可观测差异：rename 替换的是目录项，state.json 的 inode 每次写都变；原地 writeFileSync 的 inode 不变。
// 阴性对照（已验红）：writeState 改回裸 writeFileSync → 第一条 inode 断言红。

describe("V96 · state.json 原子写", () => {
  test("每次写 state.json 都经 rename（inode 变化），目录里不留 .tmp", () => {
    const root = mkdtempSync(join(tmpdir(), "v96-"));
    const m = new ProjectManager(root);
    m.create("a");
    m.create("b");
    m.setCurrent("a");
    const ino1 = statSync(m.stateFile).ino;
    m.setCurrent("b");
    const ino2 = statSync(m.stateFile).ino;
    expect(ino2).not.toBe(ino1);
    expect(m.readState().currentProject).toBe("b");
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(`${m.stateFile}.lock`)).toBe(false); // 锁也释放了
  });

  test("kill 模拟：目录里残留别的进程写一半的 .tmp，不影响主文件读取；下一次写照常覆盖成完整内容", () => {
    const root = mkdtempSync(join(tmpdir(), "v96-"));
    const m = new ProjectManager(root);
    m.create("a");
    m.setCurrent("a");
    writeFileSync(join(root, "state.json.99999.zzzzzz.tmp"), '{"currentProject":"b","sess'); // 半个 JSON
    expect(m.readState().currentProject).toBe("a");
    m.bindSession("s1", "a");
    const parsed = JSON.parse(readFileSync(m.stateFile, "utf8"));
    expect(parsed).toEqual({ currentProject: "a", sessions: { s1: "a" } });
  });

  test("写出的文件永远是完整 JSON（连续 50 次写后逐次可解析）", () => {
    const root = mkdtempSync(join(tmpdir(), "v96-"));
    const m = new ProjectManager(root);
    m.create("a");
    for (let i = 0; i < 50; i++) {
      m.bindSession(`s${i}`, "a");
      expect(() => JSON.parse(readFileSync(m.stateFile, "utf8"))).not.toThrow();
    }
    expect(Object.keys(m.readState().sessions)).toHaveLength(50);
  });
});
