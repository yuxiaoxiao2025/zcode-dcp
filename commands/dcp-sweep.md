---
description: "裁剪最近 N 条 / 上一 user 消息之后的工具输出（延迟应用：下一请求生效）。参数 count 为正整数 N，不带则裁上一 user 后全部"
argument-hint: "[N]"
allowed-tools: "mcp__dcp__dcp_sweep"
---

请调用 dcp_sweep 工具（MCP 工具，名称类似 mcp__dcp__dcp_sweep）。两种形态：

- 无参：`dcp_sweep` —— 裁掉上一条 user 消息之后的所有工具输出（mode: since-user）。
- 带参：`dcp_sweep` `{count: N}` —— 裁掉最近的 N 条工具调用（mode: last-n，N 必须是正整数）。

调用后展示返回的文本（含 "Last sweep: applied N tool(s), M protected skipped." 即上一次实际结果）。

⚠️ **延迟应用语义**：本移植在 stateless 代理架构下无法立即裁剪——sweep 指令会写入 light-state，**真正的裁剪发生在该会话的下一次 /v1/messages 请求通过 pipeline 时**。MCP 工具调用是同步入队的，实际生效需要等模型发起下一轮请求。

跳过：commands.protectedTools 命中（如 TodoWrite / Skill / Write / Edit）+ protectedFilePatterns 命中 + is_error 工具结果（错误由 purgeErrors 单独清理输入）。