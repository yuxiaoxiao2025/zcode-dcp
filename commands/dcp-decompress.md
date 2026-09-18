---
description: "解压 DCP 压缩块：无参=列出可用块（块号+token 数+topic）；blockId=<n>=按块号加入排除表（下一请求原文恢复）"
argument-hint: "[blockId]"
allowed-tools: "mcp__dcp__dcp_decompress"
---

请调用 dcp_decompress 工具（MCP 工具，名称类似 mcp__dcp__dcp_decompress）$ARGUMENTS（无参=列出当前会话可恢复的压缩块；带 blockId=<n> 则把第 n 块加入排除表，下一请求该块的原文区间会保留而非被合成摘要替换）。展示返回文本。

注意：
- 「全部恢复」请改用 /dcp-recompress（清空排除表 + 关闭 manualMode）；本工具无参路径**不清空**任何状态。
- 嵌套祖先语义：本移植按块号直接排除目标块（无状态重推下由"排除目标块后其覆盖区间保留原文"自然近似）；若目标块在另一活动块的覆盖范围内，按上游应先恢复祖先再恢复子块，本移植取简化适配（平台差异已在 CAPABILITY-MAPPING-v0.1.5.md 第 2 行声明）。
- 块号以 daemon/MCP 列表渲染的 `b<N>` 为准；传错类型（非正整数）会返回错误而不是静默忽略。