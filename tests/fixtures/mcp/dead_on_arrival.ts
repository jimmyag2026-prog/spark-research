// tests/fixtures/mcp · 模拟"命令本身就跑不起来/立刻崩溃"：进程直接非零退出，
// 不完成任何 MCP 握手。用于阴性对照②的"外部 server 挂了"这一支。
process.exit(7);
