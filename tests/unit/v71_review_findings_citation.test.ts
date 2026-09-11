import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../../backend/src/project/manager";
import { runReviewCommand } from "../../backend/src/reviewer/cli";
import { FindingsStore } from "../../backend/src/reviewer/findings_store";
import { CITATION_RULE, citationIntegrity } from "../../backend/src/reviewer/rules";

// V71（BACKLOG V71）：「soft finding 刚写入证据图，review findings 却看不到」。
//
// 复现之前先定位「证据图」：`spark-research lit review` 生成综述草稿后跑
// citation-integrity（literature/cli.ts），确实会往 project 的证据图（RecordStore /
// records.db）落一条 `observation` record——但那条 record 只是**计数摘要**
// （`${hard.length} 条 hard finding，${soft.length} 条 soft finding`），不是逐条
// finding。`review findings` 读的是完全独立的另一张库（findings.db，见
// findings_store.ts 顶部注释：故意不共用 records.ts 的表/db）。
//
// 下面两组测试证明：findings_store.ts 的存储层与 reviewer/cli.ts 的查询/显示层本身
// 没有过滤条件、类型映射或状态默认值的洞——只要 (checker, severity=soft) 真的被
// `reviewTarget()` upsert 进 findings.db，`review findings`（含默认无 `--open`、
// `--project` 定位）就能看到它，严重度也原样是 soft，没有被悄悄升级或吞掉。
// 真正的洞在写入侧：`literature/cli.ts` 的 `lit review` 命令算出了逐条 citation
// finding（`check.findings`，含 soft），但从未调用 `project.findings().reviewTarget()`
// 把它们 upsert 进 findings.db——只写了上面说的计数摘要。这一侧的文件按任务书禁止
// 本 lane 改动，诊断与 ≤5 行修复 diff 写进了报告，交收口在 B-2 那侧接上。

async function newProject(slug: string) {
  const root = mkdtempSync(join(tmpdir(), "v71-review-findings-"));
  const manager = new ProjectManager(root);
  const project = manager.create(slug);
  const projectRoot = project.paths.root; // pathsFor(slug) = root/projects/<slug>，不是 root/<slug>
  project.close(); // 立刻关闭：后面分别用新的 ProjectManager/FindingsStore 实例操作，
  // 与 findings_store.test.ts「review CLI」小节同一套纪律（bun:sqlite 的 Database
  // close() 之后不能复用，必须各开各的实例指向同一个 db 文件）。
  return { root, manager, projectRoot };
}

// 用真实的 citationIntegrity() 产出一条 soft finding（unsupported_claim：强断言句
// 没有引用支撑），而不是手写一个 FindingHit——这样「finding 的语义是 soft」这件事
// 本身就是检查器的真实产出，不是测试自己编的。
async function realSoftCitationFinding() {
  const result = await citationIntegrity({
    draft: "本方法显著优于所有已有基线。",
    knownKeys: [],
    checkUnsupportedClaims: true,
  });
  const finding = result.findings.find((f) => f.severity === "soft");
  if (!finding) throw new Error("测试前提不成立：citationIntegrity 应该产出至少一条 soft finding");
  return finding;
}

describe("V71 · review findings 数据面本身没有过滤/类型/状态洞", () => {
  test("citation-integrity 的 soft finding 一旦落进 findings.db，review findings（不带 --open）默认就能看到，severity 仍是 soft", async () => {
    const { root, manager, projectRoot } = await newProject("v71-visible");
    const finding = await realSoftCitationFinding();

    const dbPath = join(projectRoot, "findings.db");
    const seed = new FindingsStore(dbPath);
    seed.reviewTarget({
      project: "v71-visible",
      target: { kind: "artifact", id: "draft-art-1" },
      checker: CITATION_RULE,
      hits: [{ severity: finding.severity, fingerprint: "unsupported_claim-1", evidence: finding.message }],
    });
    seed.close();

    const lines: string[] = [];
    const code = await runReviewCommand(["findings", "--project", "v71-visible"], {
      manager,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR: ${l}`),
    });
    const text = lines.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("findings：1 条");
    expect(text).toContain("soft");
    expect(text).toContain(CITATION_RULE);
    expect(text).not.toContain("hard"); // 语义没被 CLI 显示层悄悄升级
    void root;
  });

  test("--open 口径下同样可见（soft finding 首次出现就是 open，属于「仍需要关注」）", async () => {
    const { root, manager, projectRoot } = await newProject("v71-open");
    const finding = await realSoftCitationFinding();

    const dbPath = join(projectRoot, "findings.db");
    const seed = new FindingsStore(dbPath);
    seed.reviewTarget({
      project: "v71-open",
      target: { kind: "artifact", id: "draft-art-2" },
      checker: CITATION_RULE,
      hits: [{ severity: finding.severity, fingerprint: "unsupported_claim-2", evidence: finding.message }],
    });
    seed.close();

    const store = new FindingsStore(dbPath);
    const rows = store.list({ project: "v71-open", open: true });
    store.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe("soft");
    expect(rows[0]!.state).toBe("open");
    void manager;
    void root;
  });

  // 阴性对照：真正的洞——写入侧从不调用 reviewTarget()（这正是 literature/cli.ts 今天
  // `lit review` 命令的实际行为：只往 records.db 写一条计数摘要 observation，见本文件
  // 顶部注释）。这里不落库任何 finding，直接证明「不接线 → review findings 看不到」，
  // 与上面两条「接线之后就能看到」构成同一件事的正反两面（把上面的 reviewTarget() 调用
  // 拆掉，上面两条测试会红——已经在 devlog W7-B4.md 里记录了真跑的红/绿输出）。
  test("阴性对照：citation-integrity 检查算出了 soft finding，但没有调 reviewTarget() 落库 → review findings 看不到（这就是 V71 的真实洞：写入侧缺线，不是查询侧）", async () => {
    const { root, manager } = await newProject("v71-gap");
    const finding = await realSoftCitationFinding();
    void finding; // 算出来了，但——如同 literature/cli.ts 今天的真实代码——不调用 reviewTarget()。

    const lines: string[] = [];
    const code = await runReviewCommand(["findings", "--project", "v71-gap"], {
      manager,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR: ${l}`),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("还没有任何 finding");
  });
});
