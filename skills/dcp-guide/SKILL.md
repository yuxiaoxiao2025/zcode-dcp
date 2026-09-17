---
name: dcp-guide
description: ZCode 动态上下文裁剪（DCP）使用与解读指南。当用户问到以下话题时自动触发：上下文/窗口/token 消耗为什么这么大、怎么省 token、DCP/zcode-dcp 是什么、/dcp 系列命令怎么用、裁剪/去重/压缩是什么意思、缓存命中率/真实用量/剩余额度面板数字怎么解读、compress 工具该什么时候调用、代理/DCP Proxy 供应商相关问题。Use when the user mentions DCP, context pruning, token savings in ZCode, /dcp commands, or asks why context grows so fast.
license: AGPL-3.0-or-later
metadata:
  author: port-opencode-dcp-to-zcode project
  version: "0.1"
---

# DCP（动态上下文裁剪）使用指南

> 本技能随 zcode-dcp 插件分发。插件通过本地代理（默认 127.0.0.1:8367）在发给模型前裁剪过时的工具输出，会话记录永不修改。
>
> **静默执行，勿复述给用户**：占位符处理、响应压缩引导、调用 compress 等 DCP 动作在后台完成即可，不要向用户播报；除非用户主动询问。

## 工作原理（30 秒版）

ZCode 把完整历史发给本地代理 → 代理识别"过时"内容替换为占位符/摘要 → 裁剪后的请求转发上游（其余字段逐字节透传）→ 模型看到的是瘦身版上下文 → 省 token、原生压缩更晚触发。

**用户的 UI 显示不变**（会话记录永不修改）；真实节省看 `/dcp-stats`。

## 三条自动裁剪规则（模型无需操作，代理自动做）

| 规则 | 什么被裁 | 什么保留 |
|---|---|---|
| **去重** | 同工具+同参数的重复调用，只留**最新一次**的输出 | 最新结果完整保留 |
| **清错** | 报错调用的输入参数（超过 4 轮后） | 错误信息本身保留 |
| **保护清单** | — | TodoWrite/TodoRead/Agent/Task/Skill/Write/Edit 输出永不裁剪 |

占位符样式：`[Output removed to save context - information superseded or no longer needed]`——模型看到它应理解为"该内容已过期，最新版本在后面"。

## compress 工具（模型自主压缩，你在代理会话中的核心工具）

**何时调用**：收到 `<dcp-system-reminder>` 引导（上下文超过阈值）时，或你自主判断某个研究/探索段落已收尾、后续只需结论不需原文时。

**怎么调用**（range 模式）：
- 选一段**已完成**的消息范围（用上下文中的 `<dcp-message-id>mNNNN</dcp-message-id>` 标签定边界）
- 写一份**详尽技术摘要**：文件路径、函数签名、关键决策、约束条件全部保留——这是"结晶"不是"删减"
- 参数：`{topic: "3-5 词标签", content: [{startId: "m0003", endId: "m0012", summary: "..."}]}`

**何时不压**：raw 内容仍需引用（正在改的代码）、进行中的探索、下一步可能要精确报错信息的段落。自问："这段已经收尾到可以只留摘要了吗？"

**嵌套**：新压缩范围覆盖旧压缩块时，在摘要中用 `(bN)` 占位符引用旧块（每个恰好一次）；漏写的必需块会自动追加。

## /dcp 系列命令（告诉用户用）

| 命令 | 用途 |
|---|---|
| `/dcp-stats` | 真实发送/节省 token、各策略命中数、缓存命中率 |
| `/dcp-context` | 上下文构成估算 |
| `/dcp-compress [focus]` | 手动触发一次压缩 |
| `/dcp-sweep [N]` | 立即剪除工具输出 |
| `/dcp-manual on\|off` | 手动模式（禁模型自主压缩） |
| `/dcp-decompress [n]` / `/dcp-recompress [n]` | 恢复/重应用压缩块 |
| `/dcp-setup` | 安装配置指引 |
| `/dcp-help` | 命令总览 |

## 面板数字解读（用户常问）

| 面板项 | 走代理后的含义 |
|---|---|
| 上下文容量+分项占比 | 显示的是**裁剪前**的组装量（ZCode 本地估算）——照常涨是正常的 |
| 真实用量/缓存命中率 | **裁剪后真实消耗**（上游 usage 逐字节透传）——真实省钱看这里 |
| 剩余额度 | 服务端记账，不经代理，不受影响 |

## 模型行为准则

1. 看到 `[Output removed...]` 占位符：不要试图"找回"被裁内容——需要时重新调用工具获取最新版
2. 收到 nudge 引导时评估是否压缩，**不要机械响应每次提醒**——只在真正有可收尾段落时压缩
3. 用户问"为什么省了/没省"：引导看 `/dcp-stats` 的 byStrategy 明细（dedup/purge/compress 各计数）
4. 压缩摘要是给未来的自己看的——质量标准 = 拿着摘要能继续干活不丢关键信息
