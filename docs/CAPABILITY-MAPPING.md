# 能力对照表：DCP v3.1.15 → ZCode 移植版

> 项目：port-opencode-dcp-to-zcode | 状态：DRAFT | 配套：《DCP-CAPABILITY-LIST.md》（编号索引）
> 结论分级：**已移植**（行为等价，含协议层适配）/ **降级**（核心效果保留，机制或形态改变）/ **不可行**（ZCode 无对应机制，给出替代与原因）
> 架构前提（Gate 1 定案）：方案 A 本地代理——代理只改 messages 数组，其余字段与全部上游响应逐字节透传（H1）

## 总览统计（按逐项表主判定重算，R2'）

| 分级 | 数量 | 能力编号 |
|---|---|---|
| 已移植 | 16 | 01,02,03,04,05,06,07,08,09,11,12,15,16,18,28,30 |
| 降级 | 9 | 10(响应侧不可行),13,14,17,19,20,24(ask 态),27,31 |
| 部分移植 | 1 | 29 |
| 不可行 | 3 | 21(TUI),22(通知),25(自动更新) |
| 不适用 | 3 | 23(宿主配置改写),26(auth),32(幽灵键) |

> 合计 32，与《DCP-CAPABILITY-LIST》编号一一对应。复合项按主判定计数，括号注次要部分。

## 逐项对照

| # | DCP 能力 | 结论 | ZCode 实现 / 替代 | 差异与原因 |
|---|---|---|---|---|
| CAP-01 | 消息裁剪管线（4 类占位替换+range 替换） | **已移植** | 代理在 Anthropic 协议 messages 上重实现：tool_result 内容块→占位符；error 工具的 tool_use 字符串参数→占位符；被压缩 range→摘要合成消息。占位符文本逐字一致 | opencode parts 结构（msg.parts[].state.output）→ Anthropic content blocks（user 消息内 tool_result）映射；行为等价 |
| CAP-02 | Deduplication | **已移植** | 代理按 tool_use.name+规范化 input 签名分组，保留最近一次；**每请求确定性推导** | DCP 在 compress 执行时重算并缓存于 state；代理无状态每请求重derive——对同一历史结果恒定，前缀稳定，cache 影响等价，行为略更及时 |
| CAP-03 | PurgeErrors | **已移植** | error 判定=tool_result.is_error；turnAge≥N（默认 4）裁 input | turn 计数以 user 消息为 turn 边界（ZCode 协议层无 step-start part）——语义近似，差异文档化 |
| CAP-04 | compress range 模式 | **已移植** | MCP 工具 `compress`（命名空间后 mcp__dcp__compress），schema 与 DCP 一致（topic + content[{startId,endId,summary}]）；工具 description=DCP compress-range prompt + 格式块（不可覆写部分保留） | 执行侧后移：DCP 在工具执行时做边界解析/占位符校验/protected 追加/建块（依赖 SDK 读会话）；ZCode 的 MCP 工具无会话访问权，**这些后处理由代理在下一请求时从消息历史中的 tool_use 参数推导执行**。模型可见效果一致（调用确认+后续请求摘要生效且已增强）。工具返回值从精确计数 `Compressed N messages...` 改为受理确认（N 在下请求才可知，精确计数见统计工具） |
| CAP-05 | compress message 模式（实验） | **已移植** | 同 CAP-04 机制；schema=message 版（messageId/topic/summary）；跳过原因七分类在代理推导时判定，效果对模型一致 | 同 CAP-04 后移差异 |
| CAP-06 | 压缩块生命周期/嵌套/失活 | **已移植** | 代理从消息历史中的 compress tool_use 序列推导块状态（active/consumed/effective 集/嵌套吸收）；块 id bN 分配按历史调用顺序确定性推导 | DCP 状态存 opencode storage；代理无盘推导天然抗重启/抗 compact。deactivatedByUser（用户手动解压）走 MCP 工具写持久覆盖（见 CAP-20） |
| CAP-07 | protected 内容追加进摘要 | **已移植** | 代理推导摘要时按 DCP 顺序执行：占位符展开→protectedUserMessages→protectTags→protectedTools→missingBlockSummaries；标题文本逐字一致 | 同 CAP-04 后移（追加发生在代理应用摘要时而非工具执行时，模型下次请求可见的已是增强后摘要） |
| CAP-08 | nudge 三类+阈值+防重复 | **已移植** | 阈值数据源升级：currentTokens 直接取**代理透传的上游响应 usage**（比 DCP 的 SDK 上报更直接准确）；anchor 防重复/节流/清空逻辑保留（轻状态按会话指纹持久化于插件数据目录） | ①"X%"百分比模式需配置显式 contextWindow（代理从请求体看不到模型窗口大小——DCP 靠 system.transform 的 input.model.limit.context，代理无此通道）；②nudge 文本仍自动包裹 `<dcp-system-reminder>`、注入位置适配 Anthropic 消息结构 |
| CAP-09 | 消息 ID 标签 mNNNN/bN | **已移植** | 分配算法（最小未用槽位/上限 9999/跳过规则）、标签格式（属性字母序+XML 转义）、注入位置（user text 尾部/assistant text 或 tool_result 尾部）全对齐 | 注入目标从 opencode part 改为 Anthropic content block；每请求重新分配（确定性，与 DCP 持久 map 行为一致：对同一历史恒定）；**字符串 content 归一化为块数组**：Anthropic /v1/messages 允许 `content` 为字符串简写（等价于 `[{type:"text", text:...}]`），管线在 gate 通过后/裁剪前将 `user`/`assistant` 消息的字符串 content 转块数组——下游 stripDcpTags/prune/nudges/compress/injectMessageIds（`message.content.push(...)`）均假设数组形态，原样透传会 TypeError（8.6 实测） |
| CAP-10 | 幻觉标签清洗 | **降级** | **请求侧全量保留**：代理在转发前剥历史消息中的 4 类 dcp 标签（含模型幻觉回显的）；**响应侧不可行**：H1 要求上游响应逐字节透传，text.complete 等价物不存在 | 响应侧清洗只影响 UI 显示（剥掉模型输出的幻觉标签），不影响模型上下文（下请求代理侧会剥）；UI 可能短暂显示幻觉标签。差记录于此 |
| CAP-11 | protectedTools 双清单 | **已移植** | 默认清单按 ZCode 工具名映射：commands/sweep 清单→ `Agent(Task), Skill, TodoWrite, TodoRead, compress(mcp__dcp__compress), Write, Edit, Read 不在默认`（DCP 原清单十项中 batch/plan_enter/plan_exit 为 opencode 特有→剔除，ZCode 的 ApplyPatch 别名归并 Write/Edit）；compress 摘要清单→ `Agent, Skill, TodoWrite, TodoRead`；glob 匹配语义逐行移植 | 工具名映射表进配置文档；mcp__ 前缀命名空间感知（匹配时剥前缀） |
| CAP-12 | protectedFilePatterns + 路径提取 | **已移植** | glob 实现逐行移植（语义一致）；路径提取适配 ZCode 工具参数：file_path/path（Read/Write/Edit/Glob 等）、ApplyPatch 的 patch 文本解析 | opencode 的 multiedit 参数形态不存在于 ZCode，对应分支剔除 |
| CAP-13 | turnProtection | **降级** | 保留：最近 N turns 的工具不被 dedup/purge/sweep 裁剪；turn 边界改用 user 消息计数 | DCP 用 step-start part 计 turn（ZCode 协议层不可见）；user 消息边界是合理近似，保护强度等价偏保守 |
| CAP-14 | 子代理/内部代理识别 | **降级** | **白名单策略**：代理只对"system 含 ZCode 主对话签名"的请求执行裁剪；子代理请求（system 为子智能体定义文本）与内部辅助请求（标题/摘要类）system 不同→自动跳过。签名列表可配置追加 | DCP 能 SDK 查 parentID 精确判定子代理；代理只能看请求本身。白名单比黑名单稳（未知形态默认不裁=安全默认）。allowSubAgents=true 时放开白名单为黑名单模式（签名列表命中才跳过）——与 DCP 语义对齐 |
| CAP-15 | protectTags/protectUserMessages | **已移植** | 并入 CAP-07（追加）+CAP-09（BLOCKED 标记）；正则逐字移植 | 无 |
| CAP-16 | 会话状态体系+持久化 | **已移植（架构重设计）** | **重状态（压缩块/裁剪决策/ID 分配）不落盘**——从消息历史确定性推导（天然抗重启、抗 ZCode 原生 compact）；**轻状态（nudge anchor/fetch 计数/sweep 覆盖/decompress 标记/manualMode/统计）持久化**于 `ZCODE_PLUGIN_DATA/state/`（按会话指纹键控）；1000 条 FIFO 工具缓存不再需要（无缓存推导） | DCP 全状态落 opencode storage（sessionId 键控）；代理以会话指纹（消息前缀哈希）代替 sessionId。会话指纹稳定性见 DESIGN 决策 D6 |
| CAP-17 | token 计数（anthropic tokenizer） | **降级** | 估算：chars/≈4（中英混合按字节权重）+ 可配置比率；阈值判定以**上游 usage 为准**（精确），估算仅用于摘要 token 计量与统计展示 | GLM 模型 tokenizer 与 @anthropic-ai/tokenizer 本就不同，DCP 原实现也是近似；代理侧不带原生依赖 |
| CAP-18 | 配置体系三级合并 | **已移植** | `~/.zcode/dcp/dcp.jsonc`（用户级）+ 工作区 `.zcode/dcp.jsonc`（项目级，向上查找 .zcode）；JSONC 自写解析器（注释+尾逗号，解析失败明确报错）；标量覆盖/数组并集/model*Limits 整表替换语义一致；dcp.schema.json 随插件分发供 `$schema` 引用 | OPENCODE_CONFIG_DIR 中间级无 ZCode 对应物（两级足够）；配置告警 toast→启动日志+统计工具可见 |
| CAP-19 | prompt 体系与覆写 | **降级** | 5 个可覆写：compress-range/compress-message/context-limit-nudge/turn-nudge/iteration-nudge（`~/.zcode/dcp/dcp-prompts/`+工作区，优先级/归一化/包裹语义一致）；**system prompt 注入不可行**（H1 禁改 system）→其职能（compress 哲学/WHEN 判据/标签说明）由 compress 工具 description + nudge 文本承载；manual/subagent extension 随之并入工具描述 | ZCode 的工具 description 由 MCP 服务器声明（ZCode 自动组装进 tools 数组，代理不碰）——合法且等效的承载位 |
| CAP-20 | /dcp 命令套件 | **降级** | 斜杠命令（ZCode command .md，prompt 模板）+ MCP 工具组合：/dcp-stats、/dcp-context→模型调 mcp__dcp__stats/context 工具并展示；/dcp-compress [focus]→命令正文=DCP 手动触发 prompt（逐字移植 `<compress triggered manually>` 句式）；/dcp-manual、/dcp-sweep、/dcp-decompress、/dcp-recompress→命令指示模型调对应 MCP 工具改持久状态；/dcp-help | ZCode 斜杠命令是 prompt 模板非代码执行——状态变更经"命令→模型调 MCP 工具"多一跳模型轮次；输出展示为对话内文本（DCP 的 ignored-message 专用通道不存在）。compress-pending 三态简化：命令本身即触发，无需 pending 状态机 |
| CAP-21 | TUI 面板 | **不可行** | ZCode 无 TUI 框架/模态面板 API。替代：/dcp-stats、/dcp-context 命令输出全部等价数据（token 分类/压缩比/all-time） | 平台机制缺失；数据面无损，交互形态损失（鼠标开关 manual→/dcp-manual 命令） |
| CAP-22 | 通知系统（chat/toast） | **不可行** | 两个通道都无宿主 API：chat 通知依赖 client.session.prompt（ignored 消息），toast 依赖宿主通知 API。替代：①统计类信息集中到 mcp__dcp__stats 随时查；②压缩发生的事实对模型可见（工具结果+摘要消息），对用户经统计命令可见 | 平台机制缺失；损失"实时被动通知"，换来主动查询。pruneNotification 配置项保留但仅控制统计粒度 |
| CAP-23 | 宿主配置改写（config hook） | **不适用** | ZCode 插件无宿主配置改写钩子；也不需要——compress 经 MCP 自动注册（无需 primary_tools）、/dcp-compress 经 command .md 声明 | 机制由 ZCode 声明式组件天然覆盖 |
| CAP-24 | permission 三态 | **降级** | allow=工具注册；deny=不注册（nudge/裁剪策略不受影响，与 DCP 一致）；**ask 无等价实现**——ZCode 的 MCP 工具权限由客户端权限系统管理（用户可在设置中配置 MCP 工具调用需确认），DCP 的 ask 语义由 ZCode 原生机制近似承担 | 宿主权限模型不同；ask 行为取决于用户客户端配置而非插件配置 |
| CAP-25 | 自动更新 | **不可行** | ZCode 插件市场承担版本管理（marketplace.json version + 客户端检查更新）。autoUpdate 配置项移除 | 平台机制替代；删除 npm 重装式更新逻辑 |
| CAP-26 | auth/secure mode | **不适用** | opencode 特有（OPENCODE_SERVER_PASSWORD）；ZCode 无此模式 | 无对应场景 |
| CAP-27 | 子代理结果展开（task 输出增强） | **降级** | 不可直接移植（需 SDK 读子代理会话消息，代理架构无此通道且默认跳过子代理请求）。task 工具的 tool_result 本身已含子代理结果 | allowSubAgents=true 场景下损失"子代理最终文本替换增强"；主对话功能不受影响 |
| CAP-28 | 原生 compaction 适配 | **已移植（天然自愈）** | 无状态推导架构下无需显式 reset：ZCode 原生 compact 替换历史后，代理下一请求从新历史重新推导（旧裁剪/块自然消失，等同 resetOnCompaction） | DCP 需检测 compaction 时间戳+全量重置；代理免检。注意 compact 后 mNNNN 重新编号（与 DCP 行为一致） |
| CAP-29 | shape 防御/systemPromptTokens/stripStaleMetadata/耗时链/toast 延时 | **部分移植** | shape 防御→协议层结构校验（畸形请求原样透传不处理+日志告警）；压缩耗时→MCP 工具侧计时（wall-clock）；systemPromptTokens/stripStaleMetadata/toast 延时→不适用（opencode part metadata/启动时序特有） | 适配项行为等价，不适项有因可查 |
| CAP-30 | debug 日志与上下文快照 | **已移植（增强）** | 代理 debug 模式：每请求落"裁剪后转发请求"消息级明细 JSON（**验收证据源**）+ 每日运行日志；API key/敏感头强制脱敏 | 比 DCP 的 minimized 快照更直接（记录的是真实转发体）；磁盘开销提示保留 |
| CAP-31 | 辅助脚本 | **降级** | 移植 rollout 分析脚本：token 对照（直连 vs 代理）、会话 token 增长曲线——基于 `~/.zcode/cli/rollout/model-io-*.jsonl`；opencode SQLite 系列 6 脚本不适用 | 数据源从 opencode db 换成 ZCode rollout jsonl（更直接） |
| CAP-32 | 幽灵配置键 showUpdateToasts | **不适用** | 不移植 | 历史遗留，无行为 |

## 覆盖核对（验收三条件之 3）

- 能力清单 32 项 ↔ 对照表 32 行：一一对应，无缺口；统计按主判定：已移植 16 / 降级 9 / 部分移植 1 / 不可行 3 / 不适用 3
- 每项均含结论 + 原因或机制
- P0 核心（CAP-01/02/03/04/05/06/07/08/09 裁剪+压缩+引导+寻址）全部"已移植"——满足"自动裁剪过时工具输出"必达
- 用户红线 H1/H2 的落地位置：CAP-01/02/03（仅改 messages）+ CAP-08/30（usage 透传保真）+ CAP-24（权限不越权）
- Stage 5.5 待实测关联项：MCP 工具实际调用名形态（影响 CAP-04/11 的工具名匹配）、ZCode→localhost 供应商请求形态（影响 CAP-01 管线入口）、system 前缀跨请求稳定性（影响 CAP-16 会话指纹）

## 修订记录

- R2'（2026-09-11，Stage 3 审查修复）：总览统计按逐项表主判定重算（修正 33≠32 算术错与 CAP-17/26 张冠李戴）；CAP-10 主判定归降级；补 5.5 实测关联项注记
