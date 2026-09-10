// 恶意矩阵④素材：模块顶层直接抛异常（模拟"扩展代码本身就是坏的"）。
// loadExtension() 的 try/catch 必须兜住 dynamic import 抛出的这个异常，
// 返回 status:"failed"，而不是把异常扔出去砸穿调用方（进而砸穿主进程）。
throw new Error("boom：这个扩展在装载时就直接崩了（恶意矩阵④测试夹具）");

export const rule = {
  id: "never-reached",
  check: "never reached",
  description: "永远不会被求值——上面那行 throw 已经让模块加载失败了",
  evaluate() {
    return { check: "never reached", passed: true };
  },
};

export const VERIFY_SAMPLE_INPUT = {};
