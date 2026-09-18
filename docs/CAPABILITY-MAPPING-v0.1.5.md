# CAPABILITY-MAPPING v0.1.5 增量勘误 — 平台适配差异与宣称修正

> 本文件是 docs/current/CAPABILITY-MAPPING.md（v0.1.3 原表：16 项逐字移植 / 9 项降级 / 其余适配）的**增量勘误层**，不是替代。原表的移植/降级分级继续有效；本层记录 v0.1.5 修复轮确认并落地的五类差异（SPEC R17 点名）与对应修复 commit。上游行为基准：opencode-dcp v3.1.15（DCP 原版）。

## 一、五类平台适配差异（R17）

| # | 差异 | 内容 | 修复落点 |
|---|---|---|---|
| 1 | **工具名形态**（R2.4） | opencode 工具名全小写（edit/write/question），ZCode 首字母大写（Write/Edit）且提问工具存在 `AskUserQuestion`/`AskUserQuestions` 单复数两种名形观测。dedup 跳过名单已改为基名不区分大小写五元素集合 {edit,write,question,askuserquestion,askuserquestions}，两处硬编码现场（输出替换 + questions input 替换）共享 | feec15b |
| 2 | **sweep/decompress 降级**（R4/R5/#3/#5/#14） | DCP 原版 sweep=真功能（裁最近 N / 上一 user 后工具输出，状态化实现）、decompress 无参=列出可用块+单块恢复；本移植因无状态重推架构两者均为占位命令（sweep 无锚点状态可清；decompress 排除表历史上无写入者）。**v0.1.5 (Gate 1.5 B2/B3)**：sweep 已实现为**指令+下一请求消费**（admin 写 `sweepDirective` → pipeline `transformRequest` 消费）——语义对齐原版，但**应用时点**从即时延后到"下一 /v1/messages 请求通过时"。decompress 同样实现为**指令+下一请求消费**：pipeline 每请求把活跃块摘要写回 `lightState.activeBlockSummaries`（`{blockId, topic, approxTokens}`），admin `state/decompress` 无参=渲染列表（`b<N> (~T tokens) - topic`，对齐 DCP `formatAvailableBlocksMessage` 精神），`?blockId=N`=把 N 加入 `decompressBlockIds` 排除表（**接通 v0.1.4 的死路**——排除表此前全仓无写入者）；原始块恢复语义走"排除后下一请求该块区间保留原文"。嵌套祖先语义按平台差异简化（按块号直接排除，不实现 `findActiveAncestorBlockId`——无状态重推下"排除目标块后其覆盖区间保留原文"自然近似）。**行为变更声明**：无参路径从 v0.1.4 的"清空全部排除表"变为"列出可用块"（非破坏）；"恢复全部"语义迁移到 `dcp_recompress`（保持现有清排除表+关 manualMode 行为不变）。**与原版的细化差异补充声明（审查 I-1/M-5）**：① sweep 额外跳过 is_error 工具（错误输出留 purgeErrors 策略管辖避免双重占位——本移植设计决定，DCP 原版 sweep.ts:170-189 无此跳过）；② decompress 列表数字 approxTokens=摘要 on-wire token 成本（原版 compressedTokens=被压原文 token 数——口径不同，操作语义为"恢复它能省回多少摘要开销"） | 034c68d + Gate 1.5 B2 commit + Gate 1.5 B3 commit |
| 3 | **idleTimeout 行为变更**（R6/#4） | `idleTimeoutMin: 0` 现按 README 宣称永不过期自毁（原 falsy 回落 30 分钟为笔误级缺陷）；负数/NaN 由静默落 1 分钟改为回落 30 分钟 + warn | c3519d7 |
| 4 | **状态路径勘误**（R11/#10） | v0.1.3 原表宣称状态存于 `ZCODE_PLUGIN_DATA/state/`，实际为 `dataDir/light-state/<fp>.json` + `active-sessions.json`（原子写 + TTL 表）。原表路径作废 | 本文件 |
| 5 | **受理≠生效计数偏差**（R3.1/#2） | compressRuns 计"受理的 compress 调用"（runId 增量，首见建基线禁追溯）；已受理但 ref 无效（派生持续失败、从未产生压缩效果）的调用不计。与 F-P-4 字面"K 次受理=K"的该收窄已声明 | b67fc95/23140dd |

## 二、v0.1.3 原表的其他修正

| 原表条目 | 修正 |
|---|---|
| "Protected tools (TodoWrite, Agent, Skill, Write, Edit, …) are never pruned"（源自 protect.mjs 死常量） | 不成立（DCP 原版 dedup 保护默认亦为空）。已改写为硬编码跳过名单事实 + protectedTools 配置指引（feec15b + README 双语） |
| stats 含 "Compress runs"（#2） | v0.1.4 及之前恒 0（无递增点）；v0.1.5 起真计数（上表第 5 行） |
| "Cache hit rate"（#8/#9） | 实为节省率 saved/(sent+saved)。v0.1.5 改名 "Savings rate"、byStrategy 标注 hits（命中次数）、新增 per-strategy token 行（034c68d + 7c30982/7d3ce6c） |
| 响应头"逐字节"（#6） | v0.1.4 及之前头名被 Node 小写化（语义等价非逐字节）；v0.1.5 起保留上游原始大小写+多值头聚合（057bebc） |
| daemon 版本 0.1.0（#12） | v0.1.5 起单源读取插件清单（c3519d7） |
| 冷启动首轮无简报（#11） | v0.1.5 起 3 秒有界等待后注入（冷启动多数情况获得简报；超时除外）（a7cd53e/b1d3f05） |
| 测试宣称 364 项 | v0.1.5 工作区当前 489 项全绿（B3 decompress 列表+单块恢复落地 +19；CRLF 敏感性说明：autocrlf=true 检出下 2 个命令用例因行尾 \r 失败，LF 检出全绿） |

## 三、新增能力（只增不改的诊断增强，REQUIREMENT In-scope-4 授权）

- `stats-all.json` 新增 `byStrategyTokens.{dedup,purge,sweep,compress}` 累计（分策略 token 归因；重叠 id 单选归属 dedup-first，分量和=savedTokensEst 守恒）（7c30982/7d3ce6c）
- `dataDir/stats/requests.jsonl` per-request 记录（{ts,fp,sent,saved,byStrategy,byStrategyTokens}；异步追加；10 万行单代轮转）——增量窗口复测与根因拆解的数据源（7c30982）
- `byStrategy.sweep` 落盘丢失先例 bug 顺带修复（7c30982）

## 四、已知未决（进 Gate 1.5 清单）

- estimateCompressSavings 估算器系统性归 0（摘要经 enhanceSummary 后常长于对比基准）——compress 的 token 贡献在生产统计中可能被低估为 ~0，真实节省率或高于面板显示
- sentTokens 估算不含 tools 定义（分母低估+天花板共存，量化见根因报告）
- sweep/decompress 真实现（上表第 2 行）
