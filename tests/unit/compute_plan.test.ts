import { describe, expect, test } from "bun:test";
import {
  MAX_TIMEOUT_MINUTES,
  PlanValidationError,
  buildPlan,
  derivedApprovalRequired,
  planDigest,
  validatePlan,
  type ComputePlan,
  type PlanInput,
  type PricingLookup,
} from "../../backend/src/compute/plan";
import type { AdapterCapabilities } from "../../backend/src/compute/target";

// CB-1 · plan 与 digest（设计 §1.1.3 / §2.2）。

const CAPS: AdapterCapabilities = {
  billable: false,
  persistentVolume: false,
  recovery: true,
  secretRefs: true,
  network: ["none", "unrestricted"],
  gpus: ["A10G"],
  uploadLimits: { count: 200, bytes: 256 * 1024 * 1024 },
};

const BILLABLE: AdapterCapabilities = { ...CAPS, billable: true };

const NO_PRICE: PricingLookup = () => ({ unitPriceUsd: null, source: null, verifiedDate: null });
const PRICED: PricingLookup = () => ({
  unitPriceUsd: 0.000306,
  source: "https://modal.com/pricing",
  verifiedDate: "2026-09-10",
});

const SHA = "c".repeat(64);

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    target: { kind: "local" },
    purpose: "跑一次分子动力学",
    command: ["python", "runner.py", "--params", "params.json"],
    env: { OMP_NUM_THREADS: "4" },
    image: null,
    secretRefs: [],
    resources: { gpu: null, cpus: 2, memoryGb: 4, timeoutMinutes: 10 },
    network: "none",
    uploads: [{ path: "runner.py", size: 120, sha256: SHA }],
    outputs: ["out/*.dcd"],
    workspaceRoot: "/Users/someone/work",
    ...over,
  };
}

describe("digest", () => {
  test("排除 workspaceRoot：同样的内容换个绝对路径，digest 不变", () => {
    const a = buildPlan(input(), CAPS, NO_PRICE);
    const b = buildPlan(input({ workspaceRoot: "/tmp/elsewhere" }), CAPS, NO_PRICE);
    expect(b.digest).toBe(a.digest);
  });

  test("对象字面量书写顺序不影响 digest（canonical JSON）", () => {
    const a = buildPlan(input({ env: { A: "1", B: "2" } }), CAPS, NO_PRICE);
    const b = buildPlan(input({ env: { B: "2", A: "1" } }), CAPS, NO_PRICE);
    expect(b.digest).toBe(a.digest);
  });

  test("command / uploads / resources / network 任一改变都改变 digest", () => {
    const base = buildPlan(input(), CAPS, NO_PRICE).digest;
    expect(buildPlan(input({ command: ["python", "other.py"] }), CAPS, NO_PRICE).digest).not.toBe(base);
    expect(
      buildPlan(input({ uploads: [{ path: "runner.py", size: 121, sha256: SHA }] }), CAPS, NO_PRICE).digest,
    ).not.toBe(base);
    expect(buildPlan(input({ resources: { gpu: null, cpus: 4, memoryGb: 4, timeoutMinutes: 10 } }), CAPS, NO_PRICE).digest).not.toBe(base);
    expect(buildPlan(input({ network: "unrestricted" }), CAPS, NO_PRICE).digest).not.toBe(base);
  });

  test("estimate 进 digest：价格表变了就该重新批", () => {
    const cheap = buildPlan(input(), BILLABLE, NO_PRICE);
    const priced = buildPlan(input(), BILLABLE, PRICED);
    expect(priced.digest).not.toBe(cheap.digest);
  });

  test("digest 与内容对不上（plan 被改过）→ validatePlan 拒", () => {
    const plan = buildPlan(input(), CAPS, NO_PRICE);
    const tampered: ComputePlan = { ...plan, command: [...plan.command, "--secretly-added"] };
    expect(() => validatePlan(tampered, CAPS)).toThrow(/被改过/);
  });

  test("planDigest 只吃内容，不吃 digest 字段自身", () => {
    const plan = buildPlan(input(), CAPS, NO_PRICE);
    const { digest, ...rest } = plan;
    expect(planDigest(rest)).toBe(digest);
  });
});

describe("L-3 · approvalRequired 是派生值", () => {
  test("billable / 联网 / 用密钥，三者任一即需审批", () => {
    expect(derivedApprovalRequired({ network: "none", secretRefs: [] }, CAPS)).toBe(false);
    expect(derivedApprovalRequired({ network: "none", secretRefs: [] }, BILLABLE)).toBe(true);
    expect(derivedApprovalRequired({ network: "unrestricted", secretRefs: [] }, CAPS)).toBe(true);
    expect(derivedApprovalRequired({ network: "none", secretRefs: ["modal"] }, CAPS)).toBe(true);
  });

  test("调用方伪造 approvalRequired=false 的计费 plan → 拒", () => {
    const plan = buildPlan(input(), BILLABLE, NO_PRICE);
    expect(plan.approvalRequired).toBe(true);
    const forged: ComputePlan = { ...plan, approvalRequired: false };
    expect(() => validatePlan(forged, BILLABLE)).toThrow(/派生字段/);
  });
});

describe("command 必须是 argv", () => {
  test("拒绝 `sh -c '<字符串>'`", () => {
    expect(() => buildPlan(input({ command: ["/bin/sh", "-c", "python runner.py"] }), CAPS, NO_PRICE)).toThrow(
      /shell 展开/,
    );
    expect(() => buildPlan(input({ command: ["bash", "-lc", "python runner.py"] }), CAPS, NO_PRICE)).toThrow(
      /shell 展开/,
    );
  });

  test("拒绝一整条 shell 字符串", () => {
    expect(() => buildPlan(input({ command: ["python runner.py > out.txt"] }), CAPS, NO_PRICE)).toThrow(
      /拆成 argv/,
    );
  });

  test("空 argv / 空串一律拒", () => {
    expect(() => buildPlan(input({ command: [] }), CAPS, NO_PRICE)).toThrow(PlanValidationError);
    expect(() => buildPlan(input({ command: ["python", ""] }), CAPS, NO_PRICE)).toThrow(PlanValidationError);
  });

  test("普通 argv 里带元字符是允许的（那是数据，不是代码）", () => {
    const plan = buildPlan(input({ command: ["/bin/echo", "$(id -u)"] }), CAPS, NO_PRICE);
    expect(plan.command[1]).toBe("$(id -u)");
  });
});

describe("env 只允许非密钥", () => {
  test.each([
    ["OPENAI_API_KEY", "sk-abcdefghijklmnop"],
    ["MODAL_TOKEN_SECRET", "whatever"],
    ["DB_PASSWORD", "hunter2"],
    ["AUTHORIZATION", "Bearer abcdefgh"],
  ])("key '%s' 命中密钥模式 → 拒", (key, value) => {
    expect(() => buildPlan(input({ env: { [key]: value } }), CAPS, NO_PRICE)).toThrow(/secretRefs/);
  });

  test("值命中凭据模式也拒（key 名伪装成无害的样子）", () => {
    expect(() => buildPlan(input({ env: { HARMLESS: "sk-abcdefghijklmnop" } }), CAPS, NO_PRICE)).toThrow(
      /凭据模式/,
    );
  });

  test("非法环境变量名 → 拒", () => {
    expect(() => buildPlan(input({ env: { "not a name": "1" } }), CAPS, NO_PRICE)).toThrow(/环境变量名/);
  });

  test("secretRefs 只是符号名；adapter 不支持时拒", () => {
    const plan = buildPlan(input({ secretRefs: ["modal"] }), CAPS, NO_PRICE);
    expect(plan.secretRefs).toEqual(["modal"]);
    expect(() => buildPlan(input({ secretRefs: ["modal"] }), { ...CAPS, secretRefs: false }, NO_PRICE)).toThrow(
      /不支持 secretRefs/,
    );
  });
});

describe("estimate 的 PRICING 纪律", () => {
  test("查不到单价 → unitPriceUsd 与 upperBoundUsd 都是 null，**不是 0**", () => {
    const plan = buildPlan(input(), BILLABLE, NO_PRICE);
    expect(plan.estimate.unitPriceUsd).toBeNull();
    expect(plan.estimate.upperBoundUsd).toBeNull();
    expect(plan.warning).toContain("未知");
  });

  test("有单价 → 必须带 source 与 verifiedDate，upperBound = 单价 × timeout 秒数（上界，不是预测）", () => {
    const plan = buildPlan(input(), BILLABLE, PRICED);
    expect(plan.estimate.quantity).toBe(10 * 60);
    expect(plan.estimate.upperBoundUsd).toBeCloseTo(0.000306 * 600, 6);
    expect(plan.estimate.source).toContain("http");
    expect(plan.estimate.verifiedDate).toBe("2026-09-10");
    expect(plan.warning).toContain("$");
  });

  test("单价填 0 → 拒（0 会被读成「这次真的免费」）", () => {
    const zero: PricingLookup = () => ({ unitPriceUsd: 0, source: "x", verifiedDate: "2026-09-10" });
    expect(() => buildPlan(input(), BILLABLE, zero)).toThrow(/不许填 0/);
  });

  test("有单价却没来源 → 拒", () => {
    const noSource: PricingLookup = () => ({ unitPriceUsd: 0.1, source: null, verifiedDate: null });
    expect(() => buildPlan(input(), BILLABLE, noSource)).toThrow(/source/);
  });
});

describe("资源、上传与产出的边界", () => {
  test("GPU 必须在 adapter 声明的型号里", () => {
    expect(buildPlan(input({ resources: { gpu: "A10G", cpus: 1, memoryGb: 1, timeoutMinutes: 5 } }), CAPS, NO_PRICE).resources.gpu).toBe("A10G");
    expect(() =>
      buildPlan(input({ resources: { gpu: "H100", cpus: 1, memoryGb: 1, timeoutMinutes: 5 } }), CAPS, NO_PRICE),
    ).toThrow(/不提供 GPU/);
  });

  test("timeoutMinutes 越界 → 拒", () => {
    expect(() =>
      buildPlan(input({ resources: { gpu: null, cpus: 1, memoryGb: 1, timeoutMinutes: 0 } }), CAPS, NO_PRICE),
    ).toThrow(/timeoutMinutes/);
    expect(() =>
      buildPlan(
        input({ resources: { gpu: null, cpus: 1, memoryGb: 1, timeoutMinutes: MAX_TIMEOUT_MINUTES + 1 } }),
        CAPS,
        NO_PRICE,
      ),
    ).toThrow(/timeoutMinutes/);
  });

  test("adapter 不支持的 network → 拒", () => {
    expect(() => buildPlan(input({ network: "unrestricted" }), { ...CAPS, network: ["none"] }, NO_PRICE)).toThrow(
      /不支持 network/,
    );
  });

  test("上传路径必须在工作区内、不许重复、sha256 必须是 64 位 hex", () => {
    expect(() => buildPlan(input({ uploads: [{ path: "/etc/passwd", size: 1, sha256: SHA }] }), CAPS, NO_PRICE)).toThrow(
      /相对路径/,
    );
    expect(() => buildPlan(input({ uploads: [{ path: "../x", size: 1, sha256: SHA }] }), CAPS, NO_PRICE)).toThrow(
      /相对路径/,
    );
    expect(() =>
      buildPlan(
        input({ uploads: [{ path: "a", size: 1, sha256: SHA }, { path: "a", size: 1, sha256: SHA }] }),
        CAPS,
        NO_PRICE,
      ),
    ).toThrow(/重复/);
    expect(() => buildPlan(input({ uploads: [{ path: "a", size: 1, sha256: "zz" }] }), CAPS, NO_PRICE)).toThrow(
      /sha256/,
    );
  });

  test("uploadBytes 是逐条相加的结果，改一个就对不上", () => {
    const plan = buildPlan(
      input({ uploads: [{ path: "a", size: 10, sha256: SHA }, { path: "b", size: 5, sha256: SHA }] }),
      CAPS,
      NO_PRICE,
    );
    expect(plan.uploadBytes).toBe(15);
    expect(() => validatePlan({ ...plan, uploadBytes: 14 }, CAPS)).toThrow(/对不上/);
  });

  test("双限额：文件数与总字节各自超限都拒", () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ path: `f${i}`, size: 1, sha256: SHA }));
    expect(() => buildPlan(input({ uploads: many }), { ...CAPS, uploadLimits: { count: 2, bytes: 1024 } }, NO_PRICE)).toThrow(
      /文件数/,
    );
    expect(() =>
      buildPlan(input({ uploads: [{ path: "big", size: 2048, sha256: SHA }] }), {
        ...CAPS,
        uploadLimits: { count: 10, bytes: 1024 },
      }, NO_PRICE),
    ).toThrow(/字节/);
  });

  test("output glob 不许逃出工作区", () => {
    expect(() => buildPlan(input({ outputs: ["../escape/*"] }), CAPS, NO_PRICE)).toThrow(/相对路径/);
  });

  test("purpose 为空 → 拒（审批面上人得知道这是要干什么）", () => {
    expect(() => buildPlan(input({ purpose: "  " }), CAPS, NO_PRICE)).toThrow(/purpose/);
  });

  test("cwd 恒为 /workspace，schemaVersion 恒为 1", () => {
    const plan = buildPlan(input(), CAPS, NO_PRICE);
    expect(plan.cwd).toBe("/workspace");
    expect(plan.schemaVersion).toBe(1);
    expect(() => validatePlan({ ...plan, schemaVersion: 2 as 1 }, CAPS)).toThrow(/schemaVersion/);
  });
});
