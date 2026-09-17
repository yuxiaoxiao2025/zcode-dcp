---
description: "切换 DCP 手动模式（on=模型不能自主压缩，仅手动触发；off=恢复自动）"
argument-hint: "on|off"
allowed-tools: "mcp__dcp__dcp_manual"
---

请调用 dcp_manual 工具（MCP 工具，名称类似 mcp__dcp__dcp_manual），参数 enabled=$ARGUMENTS（只允许 on 或 off；用户未给参数时先问）。调用后把工具返回的确认文本展示给我。
