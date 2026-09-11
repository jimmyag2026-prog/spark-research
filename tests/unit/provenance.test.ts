import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_CONNECTORS } from "../../backend/src/connectors/registry";
import {
  CONNECTOR_LICENSES,
  PROVENANCE_CLASSES,
  USER_OWNED_LICENSE,
  classForOrigin,
  connectorLicense,
  shareable,
} from "../../backend/src/provenance/policy";
import { RecordStore, deriveQuality } from "../../backend/src/project/records";
import { ProjectManager } from "../../backend/src/project/manager";

// v0.7 W7-D0 · L3 来源分级：登记表与注册表对账（V34 形状）· shareable 三规则（G6）·
// 生产写入点显式声明（源码门禁）· 老库回填迁移。

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "spark-prov-"));
  dirs.push(d);
  return d;
}

describe("CONNECTOR_LICENSES 与 BUILTIN_CONNECTORS 逐字对账", () => {
  const builtin = Object.values(BUILTIN_CONNECTORS).flatMap((defs) => defs.map((d) => d.name)).sort();
  test("每个内置 connector 都有许可登记；登记表没有多余条目", () => {
    expect(Object.keys(CONNECTOR_LICENSES).sort()).toEqual(builtin);
  });
  test("凭据源一律 proprietary；未登记的源诚实返回 unknown", () => {
    for (const name of ["aminer", "cnki", "wanfang"]) expect(connectorLicense(name)).toBe(`LicenseRef-proprietary-${name}`);
    expect(connectorLicense("not-a-connector")).toBe("unknown");
    expect(connectorLicense(null)).toBe("unknown");
  });
});

describe("shareable() · AD-16 三规则（门禁 G6）", () => {
  test("upstream 一律拒；license 未知拒；proprietary 拒；其余放行", () => {
    expect(shareable({ provenanceClass: "upstream", license: "CC0-1.0" }).ok).toBe(false);
    expect(shareable({ provenanceClass: "derived", license: "unknown" }).ok).toBe(false);
    expect(shareable({ provenanceClass: "derived", license: null }).ok).toBe(false);
    expect(shareable({ provenanceClass: "model_generated", license: "LicenseRef-proprietary-aminer" }).ok).toBe(false);
    expect(shareable({ provenanceClass: "model_generated", license: USER_OWNED_LICENSE }).ok).toBe(true);
    expect(shareable({ provenanceClass: "user_authored", license: USER_OWNED_LICENSE }).ok).toBe(true);
    expect(shareable({ provenanceClass: "derived", license: USER_OWNED_LICENSE }).ok).toBe(true);
  });
});

describe("classForOrigin · 兜底/回填口径", () => {
  test("connector→upstream · agent_run→model_generated · manual/import→user_authored · 其余 derived", () => {
    expect(classForOrigin({ kind: "connector", connector: "openalex" }, "paper")).toBe("upstream");
    expect(classForOrigin({ kind: "session" }, "agent_run")).toBe("model_generated");
    expect(classForOrigin({ kind: "manual" }, "decision")).toBe("user_authored");
    expect(classForOrigin({ kind: "import" }, "paper")).toBe("user_authored");
    expect(classForOrigin({ kind: "session" }, "idea")).toBe("derived");
    expect(classForOrigin({ kind: "cell" }, "observation")).toBe("derived");
  });
});

// ── 源码门禁：生产写入方必须显式声明 provenanceClass ──────────────────────────────
// 判据是语法结构（`.create({` 紧跟 `type: "<record 类型>"`），不是模糊匹配。兜底推断只给
// 老库回填与测试用；生产代码省略它就是把「这条数据能不能出门」交给猜——门禁红。
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}
const SRC = join(import.meta.dir, "../../backend/src");
const RECORD_TYPE_LINE = /^\s*type: "(idea|decision|experiment|observation|reading|conclusion|paper|artifact)",/;

describe("源码门禁 · 生产 record 写入点显式声明 provenanceClass", () => {
  const offenders: string[] = [];
  let sites = 0;
  for (const file of walk(SRC)) {
    if (file.endsWith("project/records.ts")) continue; // 兜底逻辑本身
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const isCreate = /\.create\(\{\s*$/.test(lines[i]!);
      const isFromArtifact = /createFromArtifact\([^,]+,\s*\{\s*$/.test(lines[i]!);
      if (!isCreate && !isFromArtifact) continue;
      let typed = isFromArtifact;
      for (let k = i + 1; k < Math.min(i + 6, lines.length) && !typed; k++) if (RECORD_TYPE_LINE.test(lines[k]!)) typed = true;
      if (!typed) continue; // 不是 RecordStore 的 create（如 run_store / conclusion store 的上层 create）
      sites += 1;
      const window = lines.slice(i, i + 14).join("\n");
      if (!/provenanceClass:/.test(window)) offenders.push(`${file.replace(SRC, "backend/src")}:${i + 1}`);
    }
  }
  test("扫描到的写入点数量合理（防止正则失效变成 0 个也绿）", () => {
    expect(sites).toBeGreaterThanOrEqual(18);
  });
  test("没有省略 provenanceClass 的生产写入点", () => {
    expect(offenders).toEqual([]);
  });
});

describe("RecordStore · 三列落库、默认许可、quality 派生、过滤", () => {
  test("显式 class 落库；license 缺省按 class 推；quality 从 metadata 派生并与显式合并", () => {
    const db = join(tmp(), "records.db");
    const store = new RecordStore(db, "p");
    const paper = store.create({
      type: "paper",
      content: "x",
      origin: { kind: "connector", connector: "openalex" },
      provenanceClass: "upstream",
    });
    expect(paper.provenanceClass).toBe("upstream");
    expect(paper.license).toBe("CC0-1.0");
    const obs = store.create({
      type: "observation",
      content: "y",
      origin: { kind: "cell" },
      provenanceClass: "derived",
      quality: ["custom"],
      metadata: { deterministic: false, basis: "abstract", simulated: true },
    });
    expect(obs.license).toBe(USER_OWNED_LICENSE);
    expect(obs.quality).toEqual(["custom", "deterministic:false", "basis:abstract", "simulated"]);
    expect(store.list({ provenanceClass: "upstream" }).map((r) => r.id)).toEqual([paper.id]);
    expect(store.count({ provenanceClass: "derived" })).toBe(1);
    expect(() => store.create({ type: "idea", content: "z", provenanceClass: "bogus" as never })).toThrow(/provenanceClass/);
    store.close();
  });

  test("deriveQuality 去重且不动 metadata", () => {
    expect(deriveQuality({ deterministic: true }, ["deterministic:true"])).toEqual(["deterministic:true"]);
    expect(deriveQuality({})).toEqual([]);
  });

  test("老库（无三列）打开即迁移：列补上、老行按 classForOrigin 回填、幂等", () => {
    const db = join(tmp(), "records.db");
    // 用 v0.6 的建表脚本造一个「老库」：没有 provenance_class / license / quality 三列。
    const raw = new Database(db);
    raw.exec(readFileSync(join(SRC, "project/schema.sql"), "utf8"));
    raw.exec("ALTER TABLE records ADD COLUMN rev INTEGER NOT NULL DEFAULT 1");
    const ins = raw.query(
      "INSERT INTO records (id, project, type, title, content, evidence, origin_kind, origin_ref, origin_connector, session_id, artifact_id, metadata, created_at) VALUES (?, 'p', ?, '', '', ?, ?, NULL, ?, NULL, NULL, ?, '2026-01-01T00:00:00.000Z')",
    );
    ins.run("r-paper", "paper", "sourced", "connector", "aminer", "{}");
    ins.run("r-agent", "agent_run", "observed", "session", null, JSON.stringify({ agent: "x" }));
    ins.run("r-manual", "decision", "inferred", "manual", null, "{}");
    ins.run("r-cell", "observation", "computed", "cell", null, JSON.stringify({ deterministic: true, simulated: true }));
    raw.close();

    const store = new RecordStore(db, "p");
    const byId = Object.fromEntries(store.list().map((r) => [r.id, r]));
    expect(byId["r-paper"]!.provenanceClass).toBe("upstream");
    expect(byId["r-paper"]!.license).toBe("LicenseRef-proprietary-aminer");
    expect(byId["r-agent"]!.provenanceClass).toBe("model_generated");
    expect(byId["r-manual"]!.provenanceClass).toBe("user_authored");
    expect(byId["r-cell"]!.provenanceClass).toBe("derived");
    expect(byId["r-cell"]!.quality).toEqual(["deterministic:true", "simulated"]);
    store.close();
    // 幂等：再开一次不变。
    const again = new RecordStore(db, "p");
    expect(again.get("r-paper")!.license).toBe("LicenseRef-proprietary-aminer");
    again.close();
  });

  test("project new 会建 raw/ 目录；Project.raw() 返回同一 sink", () => {
    const manager = new ProjectManager(tmp());
    const project = manager.create("raw-dir");
    expect(existsSync(project.paths.rawDir)).toBe(true);
    expect(project.raw()).toBe(project.raw());
    expect(PROVENANCE_CLASSES.length).toBe(4);
    project.close();
  });
});
