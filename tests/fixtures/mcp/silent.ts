// tests/fixtures/mcp · 模拟"进程起来了但从不回应"：不做任何 MCP 握手，只是
// 活着（不退出），直到被父进程杀掉。用于阴性对照②的"外部 server 超时"这一支——
// 与 dead_on_arrival 的区别：这个进程 spawn 会成功，只是永远不说 JSON-RPC。
setInterval(() => {}, 1 << 30);
