# zcode-dcp

**ZCode 动态上下文裁剪** —— 把
[`@tarquinen/opencode-dcp` v3.1.15](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
（AGPL-3.0-or-later）移植为 ZCode 原生插件。

通过本地代理（默认 `127.0.0.1:8367`）裁剪发给模型的请求里过时的工具
输出，给长会话省 token。会话记录与 UI 历史永不修改。

[![test](https://github.com/yuxiaoxiao2025/zcode-dcp/actions/workflows/test.yml/badge.svg)](https://github.com/yuxiaoxiao2025/zcode-dcp/actions/workflows/test.yml)

---

## 这是什么

zcode-dcp 在 ZCode 自定义供应商与真实模型端点之间跑了一个小型本地
HTTP 守护进程。代理在转发请求**前**，只对请求体的 `messages` 数组
做修改（去重 / 清错 / 摘要替换 / 引导注入）；其余字段与全部响应内容
（SSE 流、`usage`、响应头……）**逐字节透传**。

会话日志和 UI 显示的对话历史永远不动。被裁剪的只是「模型实际收到
的那份请求体」。

---

## 怎么工作

```
┌──────────┐  自定义供应商    ┌──────────────┐  上游 HTTPS ┌────────────┐
│  ZCode   │ ──────────────▶  │  本地代理     │ ──────────▶ │  上游      │
│  客户端  │  http://127.0.0.1 │  127.0.0.1:  │            │  Anthropic │
│          │       :8367       │      8367    │            │  端点      │
└──────────┘                   └──────────────┘            └────────────┘
                                       │
                                       ▼
                          只改 messages[] 数组
                          （去重 / 清错 / 摘要替换 / 引导）
                          其余字段全部逐字节透传
```

裁剪策略（从 DCP v3.1.15 1:1 移植而来）：

- **Deduplication（去重）** —— 同一工具 + 同一参数的多次调用，只
  保留最近一次的输出，更早的用占位符替换。
- **PurgeErrors（清错）** —— 返回 error 的工具输出在经过 N turns
  （默认 4）后被裁剪，但错误信息本身保留。
- **Summary replacement（摘要替换）** —— 模型调用 `compress` MCP
  工具写摘要后，代理在后续请求中用该摘要替换被压缩的消息段。
- **Nudge injection（引导注入）** —— 上下文接近配置阈值时，代理
  注入一条引导消息，提示模型去压缩。

受保护的工具（`TodoWrite`、`Agent`、`Skill`、`Write`、`Edit`……）
永不参与裁剪。

---

## 安装

仓库根目录即插件本体（市场清单位于 `.claude-plugin/marketplace.json`，
插件源为仓库根）。两种安装方式：

### 方式一：git 市场（推荐，无需克隆）

1. **添加市场。** 设置 → 插件 → 添加插件市场 → 选 **Git 仓库** → 填
   `https://github.com/yuxiaoxiao2025/zcode-dcp`。
2. **安装并启用** `zcode-dcp`。

### 方式二：本地目录（离线机器 / 自己改了代码）

1. **克隆本仓库**到任意目录（或下载 zip 解压）。
2. 新建一个 `marketplace.json`（放在任意独立文件夹里），把
   `<克隆的绝对路径>` 替换成实际值：

   ```json
   {
     "name": "zcode-dcp-local",
     "plugins": [
       {
         "name": "zcode-dcp",
         "source": { "source": "directory", "path": "<克隆的绝对路径>" },
         "description": "Dynamic Context Pruning for ZCode (local copy)",
         "version": "0.1.4"
       }
     ]
   }
   ```

   > 市场清单的 `path` **必须是绝对路径**——ZCode 客户端不支持相对
   > 路径遍历。
3. 设置 → 插件 → 添加插件市场 → 选 **本地目录** → 选中该文件夹 →
   安装并启用 `zcode-dcp`。

### 装完之后（两种方式通用）

1. **重启 ZCode 或新建一个会话。** 插件的 hooks 与 MCP 随会话快照
   生效。
2. **确认代理已拉起。** 新开会话后执行 `/dcp-stats`，应返回统计。
   （若报 `daemon unreachable`，重启 ZCode，或在 shell 里跑
   `node <插件根>/hooks/session-start.mjs`。）
3. **读取访问令牌。** 插件数据目录位于
   `~/.zcode/cli/plugins/data/` 下 `zcode-dcp` 相关的子目录中，
   `cat` 里面的 `admin-token` 文件即可。
4. **添加供应商必须走 UI。** 手写 `~/.zcode/v2/config.json` 或
   `cli/config.json` **不生效**——UI 只认自己的注册表，
   `config.json` 只是单向导出桥。
   - 设置 → 模型设置 → 添加供应商
   - 名称：随便取（如 `DCP Proxy`）
   - 协议：**Anthropic**
   - 接口地址：`http://127.0.0.1:8367`
   - API Key：粘贴第 3 步读到的 `admin-token` 内容（**不可留空**）
   - 模型 ID：`GLM-5.3`（或你上游支持的型号名）
   - 启用该供应商
5. **模型选择器**切到该供应商对应的模型。
6. **验证。** 跑一段含重复文件读取的任务，再 `/dcp-stats` 看节省量。

> 第 4 步在 UI 里加的供应商指向本地代理（`http://127.0.0.1:8367`）；
> 代理本身的 `upstream.baseUrl` / `upstream.apiKey`（在下面
> `dcp.jsonc` 里配）指向真实模型端点。这是两件事。

---

## 配置

| 作用域 | 路径                                | 用途                                                                 |
|--------|-------------------------------------|----------------------------------------------------------------------|
| 用户级 | `~/.zcode/dcp/dcp.jsonc`            | 默认配置（首次启动或 setup 引导生成）                                |
| 项目级 | `<工作区>/.zcode/dcp.jsonc`         | 项目级覆盖；与用户级按 **数组并集** 合并                              |

把 `$schema` 指向插件内的 `dcp.schema.json` 可获得 IDE 自动补全：

```jsonc
{
  "$schema": "./dcp.schema.json",
  "upstream": {
    "baseUrl": "https://open.bigmodel.cn/api/anthropic",
    "apiKey": "你的真实供应商 key"
  },
  "proxy": {
    "port": 8367
  },
  "debug": false
}
```

**改配置后新会话生效。**

> **重要——第 5 步前必须先配 `upstream`。** `upstream` 为空时代理对
> 每次请求都会返回 **502**，所以第 5 步加的「代理供应商」看似连上了
> 但所有模型调用都会失败，直到 `dcp.jsonc` 里填好 `baseUrl` +
> `apiKey`。

### ZCode 专属关键段

- `proxy.port` —— 本地代理监听的 TCP 端口（仅回环；默认 `8367`）。
- `proxy.idleTimeoutMin` —— 多久无活动后守护进程自动退出（`0` =
  永驻）。
- `proxy.adminTokenFile` —— 插件数据目录里存放 bearer token 的文件
  名（默认 `admin-token`）。
- `upstream.baseUrl`、`upstream.apiKey` —— 代理把请求转发到的真实
  端点与 key。**默认为空，必须用户配置。**
- `contextWindow` —— 显式指定上游模型的上下文窗口 token 数；不填则
  使用上游自身宣告的窗口。

其余段（`strategies`、`compress`、`manualMode`、
`protectedFilePatterns`……）从上游 DCP 沿袭，详见仓库根的
`dcp.schema.json`。

---

## 用法

### 命令

| 命令                    | 作用                                                                          |
|-------------------------|-------------------------------------------------------------------------------|
| `/dcp-compress [focus]` | 手动触发一次压缩（可指定关注点）。                                            |
| `/dcp-stats`            | 真实发送/节省 token、各策略命中、缓存命中率。                                 |
| `/dcp-context`          | 上下文构成估算。                                                              |
| `/dcp-sweep [N]`        | 立即剪除工具输出（全部或最后 N 个）。                                         |
| `/dcp-manual on\|off`   | 自动策略的手动模式开关。                                                      |
| `/dcp-decompress [n]`   | 解压压缩块（无参列出）。                                                      |
| `/dcp-recompress [n]`   | 重应用解压过的块。                                                            |
| `/dcp-setup`            | 打印安装/供应商配置指引。                                                     |

### 模型自主工具

插件暴露了一个 MCP 服务（`dcp`），两类工具：

- **`compress`** —— 上下文超过配置阈值时，模型自己写摘要并调用
  `compress`；代理在后续请求中用摘要替换被压缩的段落。
- **统计/状态类工具**（`dcp_stats` 等）—— 模型可随时查询节省量、
  策略命中、代理状态。

### 推理档位

推理参数（`thinking`、`effort` 等）按原样透传在请求体里，由你的上游
解析应用。最高档照常生效，与直连上游效果一致。

### HTTP 代理豁免检查

若 ZCode 设置了全局 HTTP 代理，请确认其对 `127.0.0.1` 回环豁免——
否则模型流量会被路由进外部代理，本地守护进程变得不可达。（本机没
设系统代理则无此虑。）

---

## 用量统计三口径

代理保留三种独立信号：

1. **真实用量 / 缓存命中率。** 来自上游响应 `usage`，代理逐字节
   透传。**照常更新，反映裁剪后的真实消耗。**
2. **上下文容量主数字 + 分项占比（MCP 工具 / 系统工具 / 消息 /
   技能 / 系统提示词）。** ZCode 按即将发出的请求在本地估算。
   **照常显示，但代表「裁剪前组装量」——真实发送更小。**
3. **剩余额度（5 小时 / 每周 / 工具调用）。** 套餐服务端记账，不
   经代理，完全不受影响。

要看**真实发送量 vs 节省量**（含各策略命中明细），随时跑
`/dcp-stats`。

---

## 已知限制

如实列出，附原因：

1. **`tee` 对 gzip 压缩的 SSE 透明失明。** 若上游用
   `Content-Encoding: gzip` 返回（罕见；多数供应商 SSE 不压缩），
   tee 解不出来，`usage` / 缓存命中率统计断供。转发本身不受影响。
2. **代理重启后 nudge 阈值用的最近 usage 短暂重置。** 守护进程把
   最近上游 `usage` 放在内存缓存里，重启后下一请求之前该信号短暂
   缺失。
3. **两个会话窗口并发时手动命令可能作用于另一窗口。** `/dcp-sweep`
   `/dcp-manual` `/dcp-decompress` `/dcp-recompress` 可能命中另一
   窗口的 session id。**自动裁剪（去重 / 清错 / nudge）按历史推导
   不受影响。**
4. **`sentTokens` 估算不含 tools 定义。** ZCode 本地上下文计数器不
   算工具定义本身的字节。要看「实际计费 token」以**上游 `usage`**
   为准。
5. **`EADDRINUSE` 端口被外家占用。** 在 `dcp.jsonc` 改 `proxy.port`，
   并把第 5 步加的供应商 URL 一起改。
6. **裁剪会让 prompt cache 命中率短暂下降。** 因消息前缀变了，缓存
   复用率暂时下降。实测（DCP 原版）：裁剪后 ~85% vs 直连 ~90%。
   长会话总收益为正。

---

## 故障排查

| 现象                                       | 处理                                                                                                       |
|--------------------------------------------|------------------------------------------------------------------------------------------------------------|
| `/dcp-stats` 返回 `daemon unreachable`     | 重启 ZCode，或在 shell 里跑 `node <插件根>/hooks/session-start.mjs`。                                       |
| 代理启动报 `EADDRINUSE`                    | 8367 被别的进程占了。改 `dcp.jsonc` 的 `proxy.port`，并在第 5 步同步更新供应商 URL。                       |
| 供应商加上了但每次调用都失败               | `dcp.jsonc` 里 `upstream.baseUrl` / `upstream.apiKey` 为空——代理对未配 upstream 的请求一律 502。            |
| 统计停止更新                               | 多半是上游对 SSE 启用了 gzip 压缩（见限制 1）——换不压缩的供应商或修 tee。                                  |
| ZCode 找不到本地代理                       | 检查 ZCode 的全局 HTTP 代理（如有）对 `127.0.0.1` 是否豁免。                                                |
| 需要详细日志                               | `~/.zcode/cli/plugins/data/<zcode-dcp>/logs/` 下有 `dcp-<日期>.log`（代理 + 消息级明细）和 `_daemon-launcher.log`。把 `dcp.jsonc` 的 `debug` 设为 `true` 即可打 trace。 |

---

## 开发与测试

零依赖——`node --test test/*.test.mjs` 即可跑全套测试（要求 Node 22+，
依赖带位置信息的 V8 JSON 错误消息，已在 Node 22/24 验证）。
注意：`test/mcp.test.mjs` 的集成测试在守护进程清理处使用了 Windows
专用助手（`cmd.exe` / `taskkill`），完整测试套件目前要求在 Windows 上
运行（CI 跑在 `windows-latest`）。插件运行时代码本身是纯跨平台 Node。

---

## 许可

`AGPL-3.0-or-later`，衍生自 `@tarquinen/opencode-dcp` v3.1.15。逐
模块来源标注与完整能力对照（已移植 16 / 降级 9 / 部分 1 / 不可行 3
/ 不适用 3）见 [`docs/CAPABILITY-MAPPING.md`](./docs/CAPABILITY-MAPPING.md)。

详见 [`LICENSE`](./LICENSE) 与 [`NOTICE`](./NOTICE)。