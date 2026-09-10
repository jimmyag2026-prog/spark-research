import { describe, expect, test } from "bun:test";

describe("good-skill 配套 e2e（ext verify 测试夹具）", () => {
  test("最小验证：这个测试真的能跑且通过", () => {
    expect(1 + 1).toBe(2);
  });
});
