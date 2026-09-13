import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorAgent } from "../../backend/src/agents/orchestrator";
import { ProjectManager } from "../../backend/src/project/manager";
import { SparkResearchDaemon } from "../../backend/src/daemon/daemon";

// V138：`OrchestratorAgent.projectCache` was a plain `Map` with `.get()`/`.set()`
// and no eviction anywhere — a long-running server accumulates one entry per
// distinct sessionId forever. There is no session-end hook in daemon.ts to
// piggyback on, so the fix caps the cache and evicts least-recently-used on
// overflow. `projectCacheMaxEntries` is a test-only override (production default
// is 200); the private `projectCache` field is inspected via a cast, matching the
// existing `PrivateToolRunnerAccess` pattern in orchestrator.test.ts.

interface PrivateProjectCacheAccess {
  projectCache: Map<string, unknown>;
}

function cacheOf(orch: OrchestratorAgent): Map<string, unknown> {
  return (orch as unknown as PrivateProjectCacheAccess).projectCache;
}

describe("V138：projectForSession() 缓存有界淘汰", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "spark-orch-cache-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("超过上限后不再无界增长，只保留最近使用的 N 条", () => {
    const manager = new ProjectManager(tmp);
    const daemon = new SparkResearchDaemon({ projects: manager });
    const orch = new OrchestratorAgent(daemon, { projects: manager, projectCacheMaxEntries: 3 });

    for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
      orch.projectForSession(id);
    }

    const cache = cacheOf(orch);
    expect(cache.size).toBe(3);
    // 最久未用的两条（s1/s2）应该已经被淘汰；最近的三条（s3/s4/s5）留着。
    expect(cache.has("s1")).toBe(false);
    expect(cache.has("s2")).toBe(false);
    expect(cache.has("s3")).toBe(true);
    expect(cache.has("s4")).toBe(true);
    expect(cache.has("s5")).toBe(true);
  });

  test("命中缓存会把这条挪到最近使用——不是「先创建先淘汰」，是「最久没被用到的先淘汰」", () => {
    const manager = new ProjectManager(tmp);
    const daemon = new SparkResearchDaemon({ projects: manager });
    const orch = new OrchestratorAgent(daemon, { projects: manager, projectCacheMaxEntries: 3 });

    orch.projectForSession("s1");
    orch.projectForSession("s2");
    orch.projectForSession("s3");
    // 重新访问 s1——按最近使用排序它现在排在 s2 后面，比 s2 新。
    orch.projectForSession("s1");
    // 加入 s4，缓存满，必须淘汰一条：最久未用的是 s2（s1 刚被重新访问过，不该被淘汰）。
    orch.projectForSession("s4");

    const cache = cacheOf(orch);
    expect(cache.size).toBe(3);
    expect(cache.has("s2")).toBe(false); // 淘汰的是它，不是 s1。
    expect(cache.has("s1")).toBe(true);
    expect(cache.has("s3")).toBe(true);
    expect(cache.has("s4")).toBe(true);
  });

  test("默认上限是 200（不传 projectCacheMaxEntries 时用生产默认值，不是无界）", () => {
    const manager = new ProjectManager(tmp);
    const daemon = new SparkResearchDaemon({ projects: manager });
    const orch = new OrchestratorAgent(daemon, { projects: manager });

    for (let i = 0; i < 205; i++) {
      orch.projectForSession(`sess-${i}`);
    }

    const cache = cacheOf(orch);
    expect(cache.size).toBe(200);
  });
});
