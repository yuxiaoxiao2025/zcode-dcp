---
description: "DCP 命令帮助：列出全部 /dcp 命令"
---

DCP (Dynamic Context Pruning) 可用命令：

| 命令 | 作用 |
|---|---|
| `/dcp-compress [focus]` | 手动触发一次压缩（可指定关注点） |
| `/dcp-stats` | 真实发送/节省 token、各策略命中、缓存命中率 |
| `/dcp-context` | 上下文构成估算 |
| `/dcp-sweep [N]` | 立即剪除工具输出（全部或最后 N 个） |
| `/dcp-manual on\|off` | 手动模式开关 |
| `/dcp-decompress [n]` | 解压压缩块（无参列出） |
| `/dcp-recompress [n]` | 重应用解压过的块 |
| `/dcp-setup` | 安装/供应商配置指引 |

模型自主工具：`compress`（上下文超过阈值时模型会收到引导并自主调用）；统计/状态类 MCP 工具（dcp_stats 等）模型可随时调用。

配置文件：`~/.zcode/dcp/dcp.jsonc`（用户级）与工作区 `.zcode/dcp.jsonc`（项目级覆盖）。改配置后新会话生效。
