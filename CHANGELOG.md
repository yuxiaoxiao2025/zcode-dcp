# Changelog

本插件版本历史（日期为对应提交日期）。

## 0.1.5 — 2026-09-18

**宣称与实现对齐轮（14 项出入复核修复）+ 统计口径诚实化 + 手动裁剪能力落地。**

- **保护机制如实化**：去重跳过名单改为基名不区分大小写（`Write`/`Edit`/`AskUserQuestion` 及 opencode 小写名形全部命中，两处硬编码现场统一）；README 保护宣称改写为真实行为（TodoWrite/Agent/Skill 默认可被去重，与 DCP 原版一致，可经 `strategies.*.protectedTools` 配置）。
- **统计口径修正（数字会变动）**：`/dcp-stats` 的 "Cache hit rate" 改名 "Savings rate"（实为节省率，非上游缓存命中率）；byStrategy 明确标注命中次数；compress 节省改按"覆盖区间原文−合成消息"记账（旧估算器系统性记 0）；`sentTokens` 补计 tools 定义（旧口径不含，分母被低估约 2.6 倍——**旧 1.5% 是夸大值，诚实口径自然节省率约 0.5-0.75%**）；新增 `byStrategyTokens` 分策略 token 归因与 `requests.jsonl` 每请求记录（增量窗口复测数据源）。
- **compressRuns 真计数**：按受理调用计数（multi-range 计 1、首见建基线不追溯）。
- **sweep 真实现**（对齐 DCP 原版语义，适配为指令+下一请求生效）：`/dcp-sweep [N]` 裁上一条 user 消息后或最近 N 个工具输出；新增 `commands.protectedTools` 配置（默认对齐原版 10 工具，大小写不敏感）；保护工具与错误输出跳过。
- **decompress 真实现**：无参=列出可用压缩块；`blockId` 参数恢复单块（原文下一请求返回）。
- **修复**：`idleTimeoutMin: 0` 恒为永续（原 falsy 回落 30 分钟）；响应头保留上游原始大小写+多值头聚合（原被 Node 小写化）；版本号单源（identify/MCP 自报=插件清单）；冷启动会话 3 秒有界等待后注入 DCP 简报；配置层 protectedTools 大小写不敏感（原对 ZCode 大写工具名静默失效）。
- 测试 364 → 494 项全部通过；平台适配差异详见 CAPABILITY-MAPPING v0.1.5 增量勘误。

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
