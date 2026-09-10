// ext verify 测试夹具：kind="backend" 的结构性检查正向用例。
//
// 已知限制（见 docs/devlog/W2-c.md）：这里只验证导出形状像 WetLabBackend
// （id / description / available() / execute()），不跑 backend/src/lab/ 的真实
// wet_loop / wet_e2e 契约测试——那些测试依赖真实 opentrons.simulate，且
// backend/src/lab/** 不在本 lane 的文件所有权内。

export const backend = {
  id: "good-backend",
  description: "ext verify 测试夹具：一个仅用于结构检查的 WetLabBackend 扩展",
  async available(): Promise<{ ok: boolean; reason: string | null }> {
    return { ok: true, reason: null };
  },
  async execute(): Promise<{ entries: unknown[] }> {
    return { entries: [] };
  },
};
