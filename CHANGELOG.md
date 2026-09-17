# Changelog

本插件版本历史（日期为对应提交日期）。

## 0.1.4 — 2026-09-16

- dcp-guide 技能与 SessionStart 简报加入"静默执行"纪律：占位符处理、压缩引导等 DCP 后台动作不再向用户播报。

## 0.1.3 — 2026-09-13

- SessionStart hook 通过 `additionalContext` 注入 DCP 简报：新会话自动掌握占位符语义与 compress 工具用法。

## 0.1.2 — 2026-09-13

- 新增 `dcp-guide` 技能：面向模型的 DCP 知识库（工作原理 / 命令表 / 面板数字解读 / 模型行为准则）。

## 0.1.1 — 2026-09-13

- 修复 MCP stdio 握手超时：stdout 输出改为行分隔 JSON。
- 修复 daemon 入站鉴权（POST /v1/messages 的 admin-token 校验）、上游 404（入站路径+查询透传）、Anthropic 字符串 content 简写规范化。
- 确定性回放实测：上下文缩减 41%。

## 0.1.0 — 2026-09-11

- 首个完整版本：将 [opencode-dcp v3.1.15](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)（AGPL-3.0-or-later）移植为 ZCode 原生插件。
- 本地代理（默认 `127.0.0.1:8367`）：仅修改请求体 `messages` 数组，其余字段与全部响应内容逐字节透传；会话记录与 UI 永不修改。
- 四条裁剪策略：去重 / 清错 / 摘要替换 / 引导注入，外加保护清单（TodoWrite、Agent、Skill、Write、Edit 等永不裁剪）。
- 9 个 `/dcp-*` 斜杠命令、MCP 服务器（compress / 统计与状态工具）、`dcp.schema.json` 配置模式。
- 364 项测试全部通过。
