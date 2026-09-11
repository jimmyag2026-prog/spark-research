export const CONTRACT_HELP = `用法:
  spark-research contract [--json] [--write <文件>]

  --json           输出机器可读的运行时契约（给 SDK 生成器与外部 agent）
  --write <文件>    把契约 JSON 写到文件（Release 会把 contract.json 挂到 assets）

契约内容（全部从真源派生，不手写）：CLI 命令/子命令/旗标（各模块 HELP）· HTTP 路由（Hono 路由表）
· HTTP/导出 manifest 的 JSON Schema（构建期由 TS 接口生成）· MCP 工具（含 inputSchema）· 配置项（不含凭据值）。
不带参数时打印各段计数。SDK 是它的薄投影：改契约 → 重新生成 SDK。
`;
