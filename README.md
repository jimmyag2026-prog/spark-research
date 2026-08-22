# Kimi Science

开源科学Agent平台：干湿闭环 + 自动化实验室，对标 Claude Science。

## 特性

- **Daemon-Worker 架构**：能力边界（permit set），不同 Kernel 不同权限
- **Python 有状态 Kernel**：持久化 namespace，跨调用保留变量
- **Artifact 溯源**：SQLite 存储 + 版本依赖图 + 版本冲突检测
- **Reviewer 验证**：独立只读 Agent，可否决结果（trace don't recompute）
- **科学连接器**：UniProt / PDB / AlphaFold / Ensembl / NCBI / ChEMBL / PubChem / PubMed / arXiv / CNCB（中国）/ CNKI（占位）/ 万方（占位）
- **Agent 编排**：双 Prompt 架构 + Explore/Execute/Review 子代理 + Agent Swarm（100 并发）
- **实验室闭环**：协议编译器（自然语言→设备指令）+ 安全门 + Opentrons 驱动 + 干湿循环
- **Web 工作台**：三栏界面 + 实验室面板 + Artifact 浏览器

## 快速开始

```bash
bun install
bun run dev
# 浏览器访问 http://127.0.0.1:4321
```

模型路由通过 `OPENROUTER_API_KEY` 环境变量（默认 `moonshotai/kimi-k2.6`）。

## 测试

```bash
bun test tests/unit/
python3 tests/lab/protocol_agent.test.py
```

## License

Apache 2.0
