import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunIntegrityError,
  AgentRunLedger,
  AgentRunValidationError,
  computePromptHash,
  computeSystemHash,
  type AgentRunFrame,
} from "../../backend/src/agents/ledger";
import { RecordConflictError, RecordStore, RecordValidationError } from "../../backend/src/project/records";

// v0.4 P13 波次 W3-b：`agent_run` 帧级记账（第 9 类 record）。
// 见 backend/src/agents/ledger.ts 顶部注释与 docs/devlog/W3-b.md。

const dirs: string[] = [];
function tempRoot(prefix = "spark-ledger-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function store(): RecordStore {
  return new RecordStore(join(tempRoot(), "records.db"), "demo");
}

function baseFrame(overrides: Partial<AgentRunFrame> = {}): AgentRunFrame {
  return {
    agent: "explore-1",
    model: "gpt-4o",
    provider: "openai",
    systemPrompt: "you are a careful research assistant",
    prompt: "find papers about X",
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
    toolCalls: 2,
    stopReason: "done",
    ...overrides,
  };
}

describe("RecordStore.createAgentRun · 第 9 类 record 的写入窄口", () => {
  test("成功写入，字段落在 metadata 里，type='agent_run'", () => {
    const s = store();
    const record = s.createAgentRun({
      agent: "explore-1",
      model: "gpt-4o",
      provider: "openai",
      systemHash: "a".repeat(64),
      promptHash: "b".repeat(64),
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      toolCalls: 1,
      stopReason: "done",
    });
    expect(record.type as string).toBe("agent_run");
    expect(record.metadata.agent).toBe("explore-1");
    expect(record.metadata.stopReason).toBe("done");
    expect(record.evidence).toBe("observed");
    expect(record.origin.kind).toBe("session");
  });

  test("必填字段缺失时拒绝写入（agent/model/provider/systemHash/promptHash/stopReason）", () => {
    const s = store();
    const good = {
      agent: "a",
      model: "m",
      provider: "p",
      systemHash: "h1",
      promptHash: "h2",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
      toolCalls: 0,
      stopReason: "done",
    };
    for (const key of ["agent", "model", "provider", "systemHash", "promptHash", "stopReason"] as const) {
      expect(() => s.createAgentRun({ ...good, [key]: "" })).toThrow(RecordValidationError);
    }
  });

  test("usage 形状不对（inputTokens/outputTokens 非 number，或 costUsd 既非 number 也非 null）拒绝写入", () => {
    const s = store();
    const good = {
      agent: "a",
      model: "m",
      provider: "p",
      systemHash: "h1",
      promptHash: "h2",
      toolCalls: 0,
      stopReason: "done",
    };
    expect(() =>
      s.createAgentRun({ ...good, usage: { inputTokens: "10" as unknown as number, outputTokens: 5, costUsd: null } }),
    ).toThrow(RecordValidationError);
    expect(() =>
      s.createAgentRun({
        ...good,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: "free" as unknown as number },
      }),
    ).toThrow(RecordValidationError);
  });

  test("toolCalls 必须是非负整数", () => {
    const s = store();
    const good = {
      agent: "a",
      model: "m",
      provider: "p",
      systemHash: "h1",
      promptHash: "h2",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
      stopReason: "done",
    };
    expect(() => s.createAgentRun({ ...good, toolCalls: -1 })).toThrow(RecordValidationError);
    expect(() => s.createAgentRun({ ...good, toolCalls: 1.5 })).toThrow(RecordValidationError);
  });

  test("走与其它 8 类 record 相同的 rev/CAS 路径——rev 从 1 起，update(expectedRev) 生效", () => {
    const s = store();
    const record = s.createAgentRun({
      agent: "a",
      model: "m",
      provider: "p",
      systemHash: "h1",
      promptHash: "h2",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
      toolCalls: 0,
      stopReason: "done",
    });
    expect(s.getRev(record.id)).toBe(1);
    const updated = s.update(record.id, { title: "renamed" }, { expectedRev: 1 });
    expect(updated.title).toBe("renamed");
    expect(s.getRev(record.id)).toBe(2);
    // 用旧 rev 再写一次必须被 CAS 拒绝——证明 agent_run 没有绕过这套并发控制。
    expect(() => s.update(record.id, { title: "stale" }, { expectedRev: 1 })).toThrow(RecordConflictError);
  });
});

describe("指纹算法：systemHash/promptHash", () => {
  test("性质①：内容变了指纹必须变", () => {
    const h1 = computePromptHash("find papers about X");
    const h2 = computePromptHash("find papers about Y");
    expect(h1).not.toBe(h2);

    const s1 = computeSystemHash("you are assistant A");
    const s2 = computeSystemHash("you are assistant B");
    expect(s1).not.toBe(s2);
  });

  test("性质②：同一 prompt 任何时候/任何调用都得到同一指纹（纯函数，不掺时间戳/随机数）", () => {
    const prompt = { role: "user", parts: ["find", "papers", { about: "X" }] };
    const first = computePromptHash(prompt);
    // 独立地重新构造一份等价对象（不是同一个引用），且刻意让 key 插入顺序不同——
    // canonicalize 应该让这两次调用产出相同哈希。
    const equivalent = { parts: ["find", "papers", { about: "X" }], role: "user" };
    const second = computePromptHash(equivalent);
    expect(second).toBe(first);

    // 字符串同理：多次独立调用必须得到同一个哈希。
    const a = computeSystemHash("stable system prompt");
    const b = computeSystemHash("stable system prompt");
    const c = computeSystemHash("stable system prompt");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("是 sha256 十六进制摘要（64 位），不是猜测值/占位符", () => {
    expect(computePromptHash("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(computeSystemHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("AgentRunLedger.record() · 诚实铁律", () => {
  test("frame.usage 缺省 → costUsd=null 且 usageUnavailable=true，绝不是 costUsd:0", () => {
    const s = store();
    const ledger = new AgentRunLedger({ records: s });
    const { usage: _drop, ...rest } = baseFrame();
    const view = ledger.record(rest as AgentRunFrame);
    expect(view.usage.costUsd).toBeNull();
    expect(view.usage.usageUnavailable).toBe(true);
    expect(view.usage.inputTokens).toBe(0);
    expect(view.usage.outputTokens).toBe(0);
  });

  test("usageUnavailable=true 但 costUsd 非 null 是调用方自相矛盾——直接拒绝，不圆谎", () => {
    const s = store();
    const ledger = new AgentRunLedger({ records: s });
    expect(() =>
      ledger.record(
        baseFrame({ usage: { inputTokens: 0, outputTokens: 0, costUsd: 5, usageUnavailable: true } }),
      ),
    ).toThrow(AgentRunValidationError);
  });

  test("usage 拿到了但单价查不到（costUsd:null，usageUnavailable 不给/false）——合法透传，不报错", () => {
    const s = store();
    const ledger = new AgentRunLedger({ records: s });
    const view = ledger.record(baseFrame({ usage: { inputTokens: 20, outputTokens: 10, costUsd: null } }));
    expect(view.usage.costUsd).toBeNull();
    expect(view.usage.inputTokens).toBe(20);
  });
});

describe("AgentRunLedger.record() · 字段落图与父子关系", () => {
  test("基本字段原样落到 view 与底层 record.metadata", () => {
    const s = store();
    const ledger = new AgentRunLedger({ records: s });
    const view = ledger.record(baseFrame());
    expect(view.agent).toBe("explore-1");
    expect(view.model).toBe("gpt-4o");
    expect(view.provider).toBe("openai");
    expect(view.toolCalls).toBe(2);
    expect(view.stopReason).toBe("done");
    expect(view.parentRunId).toBeNull();
    expect(view.systemHash).toBe(computeSystemHash("you are a careful research assistant"));
    expect(view.promptHash).toBe(computePromptHash("find papers about X"));
    expect(view.integrityHash).not.toBeNull();
    expect(view.record.type as string).toBe("agent_run");
  });

  test("子 run 建 derives_from 边指向父 run，children() 能找回子 run", () => {
    const s = store();
    const ledger = new AgentRunLedger({ records: s });
    const parent = ledger.record(baseFrame({ agent: "orchestrator" }));
    const child = ledger.record(baseFrame({ agent: "explore-1", parentRunId: parent.id }));

    expect(child.parentRunId).toBe(parent.id);
    const edges = s.edgesOf(parent.id);
    expect(edges.incoming.some((e) => e.sourceId === child.id && e.type === "derives_from")).toBe(true);

    const kids = ledger.children(parent.id);
    expect(kids.map((k) => k.id)).toEqual([child.id]);
  });

  test("linkProduced()：产物 record 挂在 agent_run 的 id 下（derives_from：产物→来源）", () => {
    const s = store();
    const ledger = new AgentRunLedger({ records: s });
    const run = ledger.record(baseFrame());
    const idea = s.create({ type: "idea", title: "候选想法", content: "...", evidence: "inferred" });

    ledger.linkProduced(run.id, idea.id);

    const edges = s.edgesOf(run.id);
    expect(edges.incoming.some((e) => e.sourceId === idea.id && e.type === "derives_from")).toBe(true);
  });

  test("get() 读一条不存在/非 agent_run 类型的 id 会拒绝", () => {
    const s = store();
    const ledger = new AgentRunLedger({ records: s });
    expect(() => ledger.get("does-not-exist")).toThrow(AgentRunValidationError);

    const idea = s.create({ type: "idea", title: "x", content: "x", evidence: "inferred" });
    expect(() => ledger.get(idea.id)).toThrow(AgentRunValidationError);
  });
});

describe("AgentRunLedger 完整性校验（integrityHash，不绕过 rev/CAS 机制）", () => {
  test("正常读取：get() 核验通过，不抛错", () => {
    const s = store();
    const ledger = new AgentRunLedger({ records: s });
    const run = ledger.record(baseFrame());
    const reread = ledger.get(run.id);
    expect(reread.id).toBe(run.id);
    expect(reread.integrityHash).toBe(run.integrityHash);
  });

  test("绕过 AgentRunLedger、直接用 RecordStore.update() 改受保护字段 → get() 拒绝信任", () => {
    const s = store();
    const ledger = new AgentRunLedger({ records: s });
    const run = ledger.record(baseFrame());

    // 直接用通用窄口把 toolCalls 从 2 改成 999——不经过 AgentRunLedger，
    // integrityHash 不会被重算，下一次读必须被逮到。
    s.update(run.id, { metadata: { toolCalls: 999 } }, { expectedRev: s.getRev(run.id)! });

    expect(() => ledger.get(run.id)).toThrow(AgentRunIntegrityError);
  });

  test("绕过写入还会污染 children()：父 run 的子列表读取同样拒绝信任被篡改的子 run", () => {
    const s = store();
    const ledger = new AgentRunLedger({ records: s });
    const parent = ledger.record(baseFrame({ agent: "orchestrator" }));
    const child = ledger.record(baseFrame({ agent: "explore-1", parentRunId: parent.id }));

    s.update(child.id, { metadata: { stopReason: "done-but-fake" } }, { expectedRev: s.getRev(child.id)! });

    expect(() => ledger.children(parent.id)).toThrow(AgentRunIntegrityError);
  });
});
