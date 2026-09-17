---
description: "解压 DCP 压缩块（无参=列出可恢复项；n=恢复指定块）"
argument-hint: "[blockId]"
allowed-tools: "mcp__dcp__dcp_decompress"
---

请调用 dcp_decompress 工具（MCP 工具，名称类似 mcp__dcp__dcp_decompress）$ARGUMENTS（无参不带参数=列出；有参数则 blockId=<n>）。展示返回文本。注意：若提示嵌套在祖先块内，按提示先恢复祖先。
