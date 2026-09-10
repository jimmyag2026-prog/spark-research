// ext verify 测试夹具：一个合规的 rule 扩展。纯函数、零 IO、确定性。
//
// 契约（与 backend/src/lab/safety.ts 的 SafetyRule 结构对齐，鸭子类型）：
//   rule: { id, check, description, evaluate(input) }
//   VERIFY_SAMPLE_INPUT: ext verify 用来调用 evaluate() 两次比对确定性的样例输入

export const VERIFY_SAMPLE_INPUT = { name: "widget" };

export const rule = {
  id: "nonempty-name",
  check: "nonempty name",
  description: "输入对象的 name 字段不得为空字符串",
  evaluate(input: unknown): { check: string; passed: boolean; detail?: string } {
    const name = (input as { name?: unknown } | null)?.name;
    const passed = typeof name === "string" && name.trim().length > 0;
    return { check: "nonempty name", passed, detail: passed ? undefined : `name 是 ${JSON.stringify(name)}` };
  },
};
