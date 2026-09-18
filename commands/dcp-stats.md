---
description: "查看 DCP 统计：真实发送 token、裁剪节省、各策略命中次数（hits）、Savings rate、各策略节省 token"
allowed-tools: "mcp__dcp__dcp_stats"
---

请调用 dcp_stats 工具（MCP 工具，名称类似 mcp__dcp__dcp_stats）获取 DCP 统计数据，然后把返回的文本原样展示给我（用代码块包裹）。不要总结、不要改写——我要看原始数字。

当前 dcp_stats 输出包含（R8 渲染新口径）：
- 请求总数 / Compress 次数 / 发送 token / 节省 token
- **Savings rate** = saved / (sent + saved)，不是上游 prompt-cache 命中率
- 各策略命中次数（hits，每请求命中累计）：deduplication / purge-errors / sweep / compress
- 各策略节省 token（Saved tokens by strategy，仅当 stats 文件含 `byStrategyTokens` 字段时出现——老格式 stats 文件该行省略）
- 活跃会话列表（≤5 条）