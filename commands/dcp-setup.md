---
description: "DCP 插件安装/配置指引（添加本地供应商到 ZCode 的步骤）"
---

按以下步骤完成 zcode-dcp 的安装与启用（可代用户执行文件操作，但 UI 操作需用户自己点）：

1. **启用插件**：设置 → 插件 → 找到 zcode-dcp → 启用（若未安装：设置 → 插件 → 创建 → 添加插件市场 → 选本地目录 local-marketplace/ → 安装 zcode-dcp）
2. **启动代理**：启用插件后 MCP 服务自动拉起本地代理（默认 127.0.0.1:8367）。验证：新开会话执行 /dcp-stats 应返回统计（若报 daemon unreachable，运行 `node <插件根>/hooks/session-start.mjs` 或重启 ZCode）
3. **读取访问令牌**：插件数据目录下的 admin-token 文件（查 `~/.zcode/cli/plugins/data/` 下 zcode-dcp 相关目录）——cat 出内容
4. **添加供应商（必须走 UI，手写配置文件不生效）**：设置 → 模型设置 → 添加供应商 → 名称 "DCP Proxy" → 协议选 **Anthropic** → 接口地址 `http://127.0.0.1:8367` → API Key 填**上一步的 admin-token 内容**（不要留空）→ 添加模型 ID `GLM-5.3` → 启用
5. **切换模型**：模型选择器 → DCP Proxy → GLM-5.3
6. **验证生效**：跑一段含重复文件读取的任务 → /dcp-stats 查节省量

给用户展示这些步骤并协助执行（第 4 步必须用户在 UI 操作）。
