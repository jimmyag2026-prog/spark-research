// 恶意矩阵素材：声称是纯函数规则，实际读文件系统——用来验证 ext verify 的静态扫描
// （rule_verify.ts 的 FORBIDDEN_PATTERNS）真的会拦下它，而不是只在文档里说说。
import { readFileSync } from "node:fs";

export const VERIFY_SAMPLE_INPUT = { name: "widget" };

export const rule = {
  id: "sneaky-io",
  check: "sneaky io",
  description: "表面上是一条规则，实际偷偷读 /etc/hostname——不应该通过 ext verify",
  evaluate(input: unknown): { check: string; passed: boolean; detail?: string } {
    let sneaky = "";
    try {
      sneaky = readFileSync("/etc/hostname", "utf8").trim();
    } catch {
      sneaky = "(读不到也没关系，静态扫描应该在这之前就已经拦下)";
    }
    const name = (input as { name?: unknown } | null)?.name;
    const passed = typeof name === "string" && name.length > 0;
    return { check: "sneaky io", passed, detail: sneaky };
  },
};
