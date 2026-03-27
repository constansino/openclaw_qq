# 高级能力与完整参数

> 此页面保留此前的长版 README 内容。

# OpenClaw QQ 插件 (OneBot v11)


## 📚 文档中心

- [文档主页](./index.md)
- [3 分钟快速开始](./quickstart.md)
- [配置参考（分组版）](./config-reference.md)

## 📢 官方交流方式（唯一）

**本插件指定交流地点：**  
**https://aiya.de5.net/c/25-category/25**

- 我们不建立 QQ 群，统一在论坛交流、提问与更新跟踪。
- 论坛方式更利于沉淀问题与解决方案，也方便后续检索。
- 欢迎在该版块反馈使用问题、配置经验和功能建议。

## 最近更新（2026-03）

- 本轮重点是 QQ 插件默认行为调整，不改 OpenClaw core 的主逻辑；旧体验仍可通过配置项手动恢复。
- 默认关闭 `interruptOnNewMessage`，并修正为“只有显式配置 `true` 才启用新消息打断”。
- 默认启用 `blockStreaming=true` 与 `blockStreamingBreak=message_end`，让 commentary / final 按完整 assistant message 落地。
- 默认 `forwardLongReplyThreshold=300`，长 `final_answer` 超过阈值时改走 QQ 合并转发；commentary 仍按普通消息发送。
- 默认 `forwardNodeCharLimit=0`，合并转发时不再按长度拆节点，同一轮长回复尽量合并成一个转发。
- 已补强 QQ 引用消息与合并转发内容的上下文提取，更容易读到 reply / forward 里的原文线索。
- 详细说明见：[2026-03-20 默认行为调整](./2026-03-20-default-behavior-update.md)

OpenClawd 是一个多功能代理。下面的聊天演示仅展示了最基础的功能。
<img width="3659" height="1899" alt="PixPin_2026-02-13_02-52-12" src="https://github.com/user-attachments/assets/f606e35e-014b-4a7e-960b-eb23794ac9ee" />

## 最近更新（2026-02）

- 修复 `channel restart` / `health-monitor` 重启循环：`startAccount` 改为常驻直到 `abort`，避免网关误判通道“已退出”后重复拉起。
- 增强 OneBot 连接状态判断：新增 `isConnected()`，用于同账号重复启动防抖。
- 提升发送可靠性：发送失败自动回队列并触发重连，降低“日志显示已回复但 QQ 未落地”的概率。
- 新增心跳事件透传：客户端接收 heartbeat 时向上层发事件，便于健康状态判断。
- 新增多层上下文解析：支持递归解析 `reply/forward`，按层提取文本/图片/文件线索并注入上下文。
- 新增自动重试 + Fast Fail：支持 `maxRetries` / `retryDelayMs` / `fastFailErrors`；这些能力默认关闭，按需开启即可。
- 新增 Active Model Failover：主模型连续失败或空回复时，自动切到 `openclaw.json` 的 `fallbacks` 备用模型。
- 新增并发防漏吞队列：同会话并发消息先进入防抖窗口再串行分发，降低“并发忙导致直接丢消息”风险。
- 新增隐藏 QQ 元数据注入：可向模型注入会话来源、触发方式、会话标签等网关上下文（当前默认关闭，按需开启）。
- 新增同会话“新消息打断旧回复”：发送中若收到新消息，旧轮输出会被软中断并切换到最新请求。
- 新增长回复自动合并转发：支持按阈值自动改用 QQ 合并转发输出，减少群内刷屏。

本插件通过 OneBot v11 协议（WebSocket）为 [OpenClaw](https://github.com/openclaw/openclaw) 添加全功能的 QQ 频道支持。它不仅支持基础聊天，还集成了群管、频道、多模态交互和生产级风控能力。

## ✨ 核心特性

### 🧠 深度智能与上下文
*   **历史回溯 (Context)**：可选在群聊中获取最近 N 条历史消息（默认 0，不额外注入），用于需要“强制保留上下文原文”的场景。
*   **系统提示词 (System Prompt)**：支持注入自定义提示词，让 Bot 扮演特定角色（如“猫娘”、“严厉的管理员”）。
*   **多层 reply/forward 解析**：AI 可递归展开引用链与合并转发链路，按层读取上下文、图片和文件线索，处理复杂信息更稳定。
*   **关键词唤醒**：除了 @机器人，支持配置特定的关键词（如“小助手”）来触发对话。
*   **隐藏网关元数据注入**：可选向系统上下文追加 `<qq_context>` 块（对用户不可见），帮助模型更稳地理解触发来源与会话类型；当前默认关闭。

### 🛡️ 强大的管理与风控
*   **模型故障转移 (Active Model Failover)**：当主大模型 API 出现由于限流、宕机导致的超时报错，或持续返回空回复时，自带带有退避逻辑的重试机制，并在达到重试阈值（第3次重试）时自动、无缝地切换至核心配置 (`openclaw.json`) 中 `fallbacks` 数组定义的备用模型，双重保障不漏回消息。
*   **连接自愈**：内置心跳检测与重连指数退避机制，能自动识别并修复“僵尸连接”，确保 7x24 小时在线。
*   **群管指令**：管理员可直接在 QQ 中使用指令管理群成员（禁言/踢出）。
*   **黑白名单**：
    *   **群组白名单**：只在指定的群组中响应，避免被拉入广告群。
    *   **用户黑名单**：屏蔽恶意用户的骚扰。
*   **自动请求处理**：可配置自动通过好友申请和入群邀请，实现无人值守运营。
*   **生产级风控**：
    *   **默认 @ 触发**：默认开启 `requireMention`，仅在被 @ 时回复，保护 Token 并不打扰他人。
    *   **速率限制**：发送多条消息时自动插入随机延迟，防止被 QQ 风控禁言。
    *   **URL 规避**：自动对链接进行处理（如加空格），降低被系统吞消息的概率。
    *   **系统号屏蔽**：自动过滤 QQ 管家等系统账号的干扰。

### 🎭 丰富的交互体验
*   **戳一戳 (Poke)**：当用户“戳一戳”机器人时，AI 会感知到并做出有趣的回应。
*   **拟人化回复**：
    *   **自动 @**：在群聊回复时，自动 @原发送者（仅在第一段消息），符合人类社交礼仪。
    *   **新消息可打断旧回复**：同一会话里，若上一轮还在发送，收到新消息会优先切到新请求，避免“越回越乱”。
    *   **昵称解析**：将消息中的 `[CQ:at]` 代码转换为真实昵称（如 `@张三`），AI 回复更自然。
    *   **长回复自动合并转发**：可配置字符阈值，超过后自动改用 QQ 合并转发发送，减少多段刷屏。
*   **多模态支持**：
    *   **图片**：支持收发图片。优化了对 `base64://` 格式的支持，即使 Bot 与 OneBot 服务端不在同一局域网也可正常交互。
    *   **语音**：接收语音消息（需服务端支持 STT）并可选开启 TTS 语音回复。
    *   **文件**：支持群文件和私聊文件的收发。
*   **QQ 频道 (Guild)**：原生支持 QQ 频道消息收发。

## 🔐 权限与安全模型

- `admins`：管理员身份来源，仅管理员可执行管理指令（如 `/kick`、`/status`、`/newsession` 等）。
- `adminOnlyChat`：是否限制“只有管理员可以触发 AI 对话”。建议生产群开启。
- `allowedGroups` / `blockedUsers`：会话入口白名单/黑名单，优先用于流量和风险控制。
- 命令授权：插件会在检测到命令时按管理员身份计算 `CommandAuthorized`，不再固定放行。
- 建议组合：`requireMention=true` + `keywordTriggers` + `adminOnlyChat=true`，可显著降低误触发与盗刷。

## ⚠️ 已知限制（务必阅读）

- QQ 不支持 Telegram 那样的原生流式输出/消息编辑/按钮交互。
- 合并转发递归解析会增加上下文 token 成本；群消息很长时建议下调层数与字符预算。
- `debugLayerTrace` 仅用于排障，生产环境建议保持关闭（默认已关闭）。

---

## 📋 前置条件

1.  **OpenClaw**：已安装并运行 OpenClaw 主程序。
2.  **OneBot v11 服务端**：你需要一个运行中的 OneBot v11 实现。
    *   推荐：**[NapCat (Docker)](https://github.com/NapCatQQ/NapCat-Docker)** 或 **Lagrange**。
    *   **重要配置**：请务必在 OneBot 配置中将 `message_post_format` 设置为 `array`（数组格式），否则无法解析多媒体消息。
    *   网络：确保开启了正向 WebSocket 服务（通常端口为 3001）。

---

## 🚀 安装指南

### 方法 1: 使用 OpenClaw CLI (推荐)
如果你的 OpenClaw 版本支持插件市场或 CLI 安装：
```bash
# 进入插件目录
cd openclaw/extensions
# 克隆仓库
git clone https://github.com/constansino/openclaw_qq.git qq
# 安装依赖并构建 (注意这里回退了两层目录，即回到了 openclaw 的根目录)
cd ../..
pnpm install && pnpm build
```

> [!NOTE] 
> **全局 NPM 安装 / 单独更新插件的用户注意**
> 如果你是通过 `npm install -g openclaw` 安装的生产环境服务器，你的主配置可能在 `~/.openclaw`，且该目录下没有整个源码主工程的构建脚手架。  
> 此时直接进入 `~/.openclaw/extensions/qq` 拉取最新代码后，**仅需执行 `npm install`，千万不要执行 `npm build`** (会提示 `Missing script: "build"`)。安装完依赖直接 `openclaw gateway restart` 即可，OpenClaw 会在运行时自定捕获 TypeScript 源码运行。

### 方法 2: Docker 集成
在你的 `docker-compose.yml` 或 `Dockerfile` 中，将本插件代码复制到 `/app/extensions/qq` 目录，然后重新构建镜像。

---

## ⚙️ 配置说明

### 1. 标准化配置 (OpenClaw Setup)
如果已集成到 OpenClaw CLI，可运行：
```bash
openclaw setup qq
```

### 2. 手动配置详解 (`openclaw.json`)
你也可以直接编辑配置文件。以下是完整配置清单：

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://127.0.0.1:3001",
      "accessToken": "你的Token",
      "admins": "12345678,87654321",
      "adminOnlyChat": false,
      "notifyNonAdminBlocked": false,
      "nonAdminBlockedMessage": "当前仅管理员可触发机器人。\n如需使用请联系管理员。",
      "blockedNotifyCooldownMs": 10000,
      "showProcessingStatus": true,
      "showReplySessionSource": true,
      "processingStatusDelayMs": 500,
      "processingStatusText": "输入中",
      "maxRetries": 0,
      "retryDelayMs": 3000,
      "fastFailErrors": [],
      "allowedGroups": "10001,10002",
      "blockedUsers": "999999",
      "systemPrompt": "你是一个名为“人工智障”的QQ机器人，说话风格要风趣幽默。",
      "historyLimit": 0,
      "keywordOnlyTrigger": false,
      "keywordTriggers": "小助手, 帮助",
      "autoApproveRequests": true,
      "enableGuilds": true,
      "enableTTS": false,
      "sharedMediaHostDir": "/Users/yourname/openclaw_qq/deploy/napcat/shared_media",
      "sharedMediaContainerDir": "/openclaw_media",
      "cacheInboundImagesToLocal": true,
      "rateLimitMs": 1000,
      "formatMarkdown": true,
      "antiRiskMode": false,
      "maxMessageLength": 4000,
      "queueDebounceMs": 0,
      "injectGatewayMeta": false,
      "interruptOnNewMessage": false,
      "blockStreaming": true,
      "blockStreamingBreak": "message_end",
      "forwardLongReplyThreshold": 300,
      "forwardNodeCharLimit": 0,
      "forwardNodeName": "OpenClaw"
    }
  },
  "plugins": {
    "entries": {
      "qq": { "enabled": true }
    }
  },
  "session": {
    "dmScope": "per-channel-peer"
  }
}
```

### 3. 跨平台私聊会话隔离（强烈建议）

当你同时接入多个私聊渠道（如 Telegram + QQ + Feishu）时，建议在 OpenClaw 顶层配置中启用：

```json
{
  "session": {
    "dmScope": "per-channel-peer"
  }
}
```

原因：OpenClaw 在 `dmScope=main`（默认）下会把 direct chat 汇聚到主会话键（`agent:main:main`），多渠道并行时可能出现上下文混用。
当前版本已回归 OpenClaw 官方 session 命名风格：QQ 私聊 peer id 直接使用纯 QQ 号；若你要严格隔离不同渠道的私聊上下文，优先使用 `per-channel-peer`。

> 如果你需要“同一个人跨平台共享上下文”，可改为其他策略；若要严格隔离，优先 `per-channel-peer`。

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `wsUrl` | string | **必填** | OneBot v11 WebSocket 地址。当前版本仅维护 WebSocket 接入。 |
| `accessToken` | string | - | 连接鉴权 Token |
| `admins` | string | `""` | **管理员 QQ 号列表（字符串）**。Web表单直接填：`10000001,123456789`；Raw JSON 填：`"10000001,123456789"`。用于 `/status`, `/kick` 等管理员指令权限。 |
| `adminOnlyChat` | boolean | `false` | **仅管理员可触发聊天回复**。开启后，非管理员即使 @ 机器人也不会触发对话（适合防止 Token 被刷）。 |
| `notifyNonAdminBlocked` | boolean | `false` | 当 `adminOnlyChat=true` 且被非管理员触发时，是否发送提示消息。 |
| `nonAdminBlockedMessage` | string | `当前仅管理员可触发机器人。\n如需使用请联系管理员。` | 非管理员被拦截时的提示文案。 |
| `blockedNotifyCooldownMs` | number | `10000` | 非管理员提示防抖（毫秒）。同一用户在同一会话内重复触发时，冷却期内不重复提示。 |
| `maxRetries` | number | `0` | **最大重试次数**。默认关闭自动重试；当你把它设为大于 `0` 时，模型请求失败或返回空回复会自动重试。 |
| `retryDelayMs` | number | `3000` | **重试等待延迟**。仅在 `maxRetries > 0` 时生效。 |
| `fastFailErrors` | array | `[]` | 快速跳过错误关键词列表。默认关闭；当你填入如 `"401"`、`"Unauthorized"`、`"余额不足"` 等文本后，命中这些不可恢复错误时会直接跳过当前模型。 |
| `queueDebounceMs` | number | `0` | 并发消息队列防抖窗口（毫秒）。默认关闭；大于 `0` 时，同会话短时间内的多条消息会先聚合后再分发。 |
| `injectGatewayMeta` | boolean | `false` | 是否注入隐藏 QQ 网关元数据（`<qq_context>`），用于增强模型对会话来源和触发方式的理解。默认关闭。 |
| `interruptOnNewMessage` | boolean | `false` | 同会话收到新消息时，是否软中断上一轮回复并切换到最新请求。默认关闭。 |
| `blockStreaming` | boolean | `true` | 是否按 assistant message 分块发送回复。默认开启；开启后 commentary / final 都可以按消息边界落地。 |
| `blockStreamingBreak` | string | `message_end` | 分块发送边界。默认 `message_end`，即每条 assistant message 完整后再发；`text_end` 会更碎、更接近逐段流式。 |
| `forwardLongReplyThreshold` | number | `300` | `final_answer` 超过该字符数时自动改用 QQ 合并转发；`commentary` 仍按普通消息发送。默认 `300`。 |
| `forwardNodeCharLimit` | number | `0` | 长回复合并转发时，每个节点的字符上限。默认 `0` 表示不按长度拆节点，尽量把同一轮回复放进一个转发。 |
| `forwardNodeName` | string | `OpenClaw` | 长回复合并转发时，节点显示名称。 |
| `enableEmptyReplyFallback` | boolean | `true` | 空回复兜底开关。模型返回空内容时，自动发提示，避免看起来“机器人没反应”。 |
| `emptyReplyFallbackText` | string | `⚠️ 本轮模型返回空内容。请重试，或先执行 /newsession 后再试。` | 空回复兜底提示文案。 |
| `showProcessingStatus` | boolean | `true` | 忙碌状态可视化（默认开启）。处理中会把机器人群名片临时改为 `（输入中）` 后缀。 |
| `showReplySessionSource` | boolean | `true` | 是否在每次面向用户的回复前附加来源会话标记，例如 `(from 会话写方案)` 或 `(from 主会话)`。默认开启；使用 `/临时` 功能区分上下文时尤其有用。 |
| `processingStatusDelayMs` | number | `500` | 触发“输入中”后缀的延迟毫秒数。 |
| `processingStatusText` | string | `输入中` | 忙碌后缀文本，默认 `输入中`。 |
| `requireMention` | boolean | `true` | **群聊触发门槛**。`true`=仅在被 @ / 回复机器人 / 命中关键词时触发；若同时开启 `keywordOnlyTrigger`，则群聊只认关键词；`false`=普通群消息也可能触发（不建议长期关闭）。 |
| `keywordOnlyTrigger` | boolean | `false` | **群聊仅关键词触发**。开启后，@机器人 / 回复机器人消息不再触发；建议与 `keywordTriggers` 一起使用，适合与其他机器人共用同一 QQ 账号时避免双重回复。 |
| `allowedGroups` | string | `""` | **群组白名单（字符串）**。Web表单填：`20000001 123456789`；Raw JSON 填：`"20000001 123456789"`。若设置，Bot 仅在这些群组响应。 |
| `blockedUsers` | string | `""` | **用户黑名单（字符串）**。Web表单填：`30000001` 或 `30000001,10002`；Raw JSON 填：`"30000001"`。Bot 将忽略这些用户消息。 |
| `systemPrompt` | string | - | **人设设定**。注入到 AI 上下文的系统提示词。 |
| `historyLimit` | number | `0` | **历史消息条数**。默认依赖 OpenClaw 会话系统管理上下文；仅在你需要强制携带群内最近原文时才建议设为 `>0`。 |
| `enrichReplyForwardContext` | boolean | `true` | 是否启用多层 reply/forward 上下文解析与注入。 |
| `cacheInboundImagesToLocal` | boolean | `true` | 是否把当前消息及 reply / forward 中识别到的图片缓存到本地 `MediaPaths`。默认开启，便于 ACP 与多模态 agent 实际读图；关闭后仅保留 URL 提示。 |
| `maxReplyLayers` | number | `5` | reply 链最大递归层数。 |
| `maxForwardLayers` | number | `5` | forward 链最大递归层数。 |
| `maxForwardMessagesPerLayer` | number | `8` | 每层 forward 最多展开的子消息数。 |
| `maxCharsPerLayer` | number | `900` | 每层提取文本的字符上限。 |
| `maxTotalContextChars` | number | `3000` | reply/forward 注入总字符上限。 |
| `includeSenderInLayers` | boolean | `true` | 分层上下文中是否包含发送者昵称/ID。 |
| `includeCurrentOutline` | boolean | `true` | 是否附加“当前消息概要层”。 |
| `debugLayerTrace` | boolean | `false` | 调试日志开关。开启后打印分层解析链路。 |
| `keywordTriggers` | string | `""` | **关键词触发（字符串）**。Web表单填：`小助手, 帮我`；Raw JSON 填：`"小助手, 帮我"`。当 `requireMention=true` 时，命中关键词可不@触发；当 `requireMention=false` 时，关键词不是必需条件；当 `keywordOnlyTrigger=true` 时，群聊里只有命中这些关键词才会触发。 |
| `autoApproveRequests` | boolean | `false` | 是否自动通过好友申请和群邀请。 |
| `enableGuilds` | boolean | `true` | 是否开启 QQ 频道 (Guild) 支持。 |
| `enableTTS` | boolean | `false` | (实验性) 是否将 AI 回复转为语音发送 (需服务端支持 TTS)。 |
| `sharedMediaHostDir` | string | `""` | 可选：宿主机共享媒体目录。建议设为 `openclaw_qq/deploy/napcat/shared_media`，用于把本地音频复制到 NapCat 可访问路径，提升语音/文件发送成功率。 |
| `sharedMediaContainerDir` | string | `"/openclaw_media"` | 可选：共享目录在 NapCat 容器内路径，需与 `deploy/napcat/docker-compose.yml` 中挂载保持一致。 |
| `rateLimitMs` | number | `1000` | **发送限速**。多条消息间的延迟(毫秒)，建议设为 1000 以防风控。 |
| `formatMarkdown` | boolean | `false` | 是否将 Markdown 表格/列表转换为易读的纯文本排版。 |
| `antiRiskMode` | boolean | `false` | 是否开启风控规避（如给 URL 加空格）。 |
| `maxMessageLength` | number | `4000` | 单条消息最大长度，超过将自动分片发送。 |

> 推荐：默认保持 `historyLimit = 0`。这与 Telegram 通道行为更一致，能减少重复上下文注入和日志噪音。
> 仅当你明确希望每轮都附带“群内原始近几条消息”时，再开启 `historyLimit`（例如设为 `3~5`）。
>
> 安全建议：若你担心群内高频 @ 导致 Token 消耗过快，建议配置 `admins` 并开启 `adminOnlyChat = true`。
>
> 运维建议：入站图片、群文件和语音会缓存到本地状态目录（如 `~/.openclaw/media/inbound/qq`），生产环境建议自行加定期清理策略。

### 4. 多层 reply/forward 调参建议

- 大群默认：`maxReplyLayers=3~5`、`maxForwardLayers=2~4`、`maxForwardMessagesPerLayer=5~8`。
- 压缩 token 成本：优先下调 `maxForwardMessagesPerLayer` 与 `maxTotalContextChars`。
- 关注可读性：若对“谁说的”敏感，保持 `includeSenderInLayers=true`。
- 问题排查：临时开启 `debugLayerTrace=true`，定位后及时关闭。

### 5. 模型故障转移 (Active Model Failover) 配置

本插件内置了“多次请求失败/空回复后自动切换备用模型”的能力。该能力默认关闭；当你把 `maxRetries` 设为大于 `0` 后，再配合 `retryDelayMs` 使用，可在主模型报错或触发限流时切换到备用模型。

配置方式如下，在主配置文件 `openclaw.json` 中找到或添加 `model` 字段（可以是全局 `agents.defaults.model` 或特定 agent 内），使用对象结构配置 `fallbacks`：

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "provider-a/your-primary-model", 
        "fallbacks": [
          "provider-b/your-fallback-model",
          "provider-c/another-fallback-model"
        ]
      }
    }
  }
}
```

> **触发机制**：对于常规的网络超时错误，系统将在当前模型上反复尝试最多 `maxRetries` 次。但如果返回的错误文本包含了 `fastFailErrors` 数组中定义的词组（如 "401"、"无效的API Key" 等严重授权异常），系统会直接跳过重试等待，**瞬间切换 (Fast Fail)** 至下一个可用的 `fallbacks` 备用大模型。

### 6. 智能并发防止漏吞消息 (Concurrency Queue)

插件内置了基于特定群组/用户的滑动窗口防抖队列，可极大降低消息丢失的风险。如果 5 个群友同时在群里对机器人说话，队列会将这 5 条并发事件安全地打包收集为上下文组合，并确保它们被串行处理，而不会像以前那样被 OpenClaw 核心因并发繁忙而直接拒收丢弃。

- 防抖窗口：通过 `queueDebounceMs` 控制，默认 `0`（关闭）；大于 `0` 时才开启明显的消息合并窗口。
- 作用范围：按会话键（群/私聊/频道）局部生效，不会把所有会话强行串成单队列。
- 调参建议：若群消息密集且漏吞风险高，可适度提高到 `4000~6000`；若更重视实时性，可降到 `1000~2000`。

---

## 🎮 使用指南

### 🗣️ 基础聊天
*   **私聊**：直接发送消息给机器人即可。
*   **群聊**：
    *   **@机器人** + 消息。
    *   回复机器人的消息。
    *   发送包含**关键词**（如配置中的“小助手”）的消息。
    *   **戳一戳**机器人头像。

> 若你开启了 `keywordOnlyTrigger=true`，则上面的 **@机器人** / **回复机器人消息** 将不再触发；群聊里只有命中 `keywordTriggers` 才会触发。

### 👥 建议建一个“双人测试群”

强烈建议额外建一个仅 2 人的测试群（你 + 机器人），用于排障与状态观察：

- 你可以更清楚地看到机器人群名片后缀（如 `输入中`）是否出现/恢复。
- 不会被大群消息噪音干扰，便于确认“正在处理”还是“已经空闲”。
- 新功能（如 `/newsession`、模型切换、文件/语音发送）先在测试群验证，再放到主群。

> 实战建议：生产群继续正常使用；排错与压测尽量在双人测试群完成。

### 🧭 触发规则速查（非常重要）

请重点关注 `requireMention`、`keywordOnlyTrigger` 与 `keywordTriggers` 的组合：

- `keywordOnlyTrigger=true` + `keywordTriggers` 非空：
  - 群聊里只有 **命中关键词** 才触发，**@机器人 / 回复机器人** 不再触发。
- `keywordOnlyTrigger=true` + `keywordTriggers` 为空：
  - 群聊普通文本、@、回复都不会触发；请先配置唤醒词。

- `requireMention=true` + `keywordTriggers` 为空：
  - 只有 **@机器人** 或 **回复机器人消息** 才触发。
- `requireMention=true` + `keywordTriggers` 非空：
  - **@机器人 / 回复机器人 / 命中关键词** 任一满足即可触发。
- `requireMention=false`（无论关键词是否为空）：
  - 普通群消息也可能触发，关键词不再是“必须条件”。

> 如果你希望“可以不@，但必须说唤醒词”，推荐：
>
> - `requireMention=true`
> - `keywordTriggers="椰子"`（或多个关键词）

> 如果你希望“只认唤醒词，@ / 回复都不要触发”，请设置：
>
> - `keywordOnlyTrigger=true`
> - `keywordTriggers="椰子"`（或多个关键词）

### 👮‍♂️ 管理员指令
仅配置在 `admins` 列表中的用户可用：

*   群聊模型命令支持（仅管理员）：
    *   默认不允许群聊里直接裸发 `/models`、`/model`、`/newsession` 触发。
    *   推荐用法是 `唤醒词 /models`、`唤醒词 /model`、`唤醒词 /model 28`、`唤醒词 /newsession`。
    *   例如：`椰子 /model`。
    *   如果你确实想恢复“群里直接发 `/model` 就执行”的旧体验，可手动把 `allowBareGroupCommands=true`。

*   临时会话槽（同群分话题，类似 tmux，仅管理员）：
    *   `/临时 <名称>` 进入/创建临时会话（示例：`/临时 检查ssh`，会保留完整名称，不再被截成 `ssh`）。
    *   `/临时重命名 <新名称>` 重命名当前临时会话。
    *   `/临时状态` 查看当前会话槽与会话键。
    *   `/临时列表` 查看本群已记录的全部临时会话（无 12 条上限，当前会话会标注“当前”）。
    *   `/退出临时` 回到主会话（不删除临时会话内容）。
    *   `/临时结束` 清空并结束当前临时会话，然后回主会话。
    *   别名：`/tmp`、`/tmprename`、`/tmpstatus`、`/tmplist`、`/exittemp`、`/tmpend`。
    *   当前版本暂不支持 `/临时 1` 这种按序号直接切换；请使用 `/临时 <名称>`。

*   `/status`
    *   查看机器人运行状态（内存占用、连接状态、Self ID）。
*   `/help`
    *   显示帮助菜单。
*   `/mute @用户 [分钟]` (仅群聊)
    *   禁言指定用户。不填时间默认 30 分钟。
    *   示例：`/mute @张三 10`
*   `/kick @用户` (仅群聊)
    *   将指定用户移出群聊。

### 💻 CLI 命令行使用
如果你在服务器终端操作 OpenClaw，可以使用以下标准命令：

1.  **查看状态**
    ```bash
    openclaw status
    ```
    显示 QQ 连接状态、延迟及当前 Bot 昵称。

2.  **列出群组/频道**
    ```bash
    openclaw list-groups --channel qq
    ```
    列出所有已加入的群聊和频道 ID。

3.  **主动发送消息**
    ```bash
    # 发送私聊
    openclaw send qq 12345678 "你好，这是测试消息"
    
    # 发送群聊 (使用 group: 前缀)
    openclaw send qq group:88888888 "大家好"
    
    # 发送频道消息
    openclaw send qq guild:GUILD_ID:CHANNEL_ID "频道消息"
    ```

4.  **最小复现：QQ 文件/视频发送链路（含完整请求回包）**
    ```bash
    node scripts/qq-send-media-repro.mjs \
      --ws ws://127.0.0.1:3001 \
      --token 你的OneBotToken \
      --group 20000001 \
      --mp4 /openclaw_media/test_short.mp4 \
      --txt /openclaw_media/test.txt
    ```
    - 脚本会依次调用：
      - `send_group_msg` + `video` 段
      - `send_group_msg` + `file` 段
      - `upload_group_file`（mp4/txt）
    - 每一步都会打印完整 `-> 请求` 与 `<- 响应` JSON，便于对照 NapCat 日志定位 `rich media transfer failed`。

### 🔐 管理员/黑名单（防盗刷）推荐配置

如果你只希望指定 QQ 号能触发机器人（尤其是群聊），推荐按下面做：

1. **设置管理员（可触发聊天）**
   ```bash
   openclaw config set channels.qq.admins '"10000001,123456789"' --json
   ```

2. **开启仅管理员可触发**
   ```bash
   openclaw config set channels.qq.adminOnlyChat true --json
   ```

3. **（可选）给非管理员提示 + 防抖**
   ```bash
   openclaw config set channels.qq.notifyNonAdminBlocked true --json
   openclaw config set channels.qq.nonAdminBlockedMessage '"当前仅管理员可触发机器人。"' --json
   openclaw config set channels.qq.blockedNotifyCooldownMs 10000 --json
   ```

4. **设置黑名单（直接忽略，不回复）**
   ```bash
   openclaw config set channels.qq.blockedUsers '"30000001,10002"' --json
   ```

5. **重启网关生效**
   ```bash
   openclaw gateway restart
   ```

6. **（推荐）启用共享媒体目录（解决跨容器语音路径问题）**
   ```bash
   mkdir -p openclaw_qq/deploy/napcat/shared_media
   cd openclaw_qq/deploy/napcat && docker compose up -d

   openclaw config set channels.qq.sharedMediaHostDir '"/Users/你的用户名/openclaw_qq/deploy/napcat/shared_media"' --json
   openclaw config set channels.qq.sharedMediaContainerDir '"/openclaw_media"' --json
   openclaw gateway restart
   ```

> 说明：`admins` / `blockedUsers` 在本插件中使用 **字符串列表** 存储，CLI 推荐始终用上面这种 `--json` 写法。
>
> Web 配置页可直接填：`10000001,123456789`（不需要手动加引号）；Raw JSON 模式则填：`"10000001,123456789"`。

### ⚠️ 关于 `/config` 页面保存 `invalid config`

如果你在 OpenClaw Web UI 修改 QQ 配置时，报错却指向 `models.providers.*.models[].maxTokens`，这是 **OpenClaw Core 的整包校验链路问题**，不是 QQ 插件业务逻辑本身。

相关跟踪（英文）：

- Issue: https://github.com/openclaw/openclaw/issues/13959
- PR: https://github.com/openclaw/openclaw/pull/13960

在官方合并前，建议优先使用上面的 CLI 命令修改 `channels.qq.*`，可避开大部分 Web 表单序列化/校验噪音。

---

## ❓ 常见问题 (FAQ)

**Q: 安装依赖时报错 `openclaw @workspace:*` 找不到？**
A: 这是因为主仓库的 workspace 协议导致的。我们已在最新版本中将其修复，请执行 `git pull` 后直接使用 `pnpm install` 或 `npm install` 即可，无需特殊环境。

**Q: 给机器人发图片它没反应？**
A: 
1. 确认你使用的 OneBot 实现（如 NapCat）开启了图片上报。
2. 建议在 OneBot 配置中开启“图片转 Base64”，这样即使你的 OpenClaw 在公网云服务器上，也能正常接收本地内网机器人的图片。
3. 插件现在会自动识别并提取图片，不再强制要求开启 `message_post_format: array`。

**Q: 机器人与 OneBot 不在同一个网络环境（非局域网）能用吗？**
A: **完全可以**。只要 `wsUrl` 能够通过内网穿透或公网 IP 访问到，且图片通过 Base64 传输，即可实现跨地域部署。

**Q: 为什么群聊不回话？**
A: 
1. 若未开启 `keywordOnlyTrigger`，检查 `requireMention` 是否开启（默认开启），需要 @机器人。
2. 检查群组是否在 `allowedGroups` 白名单内（如果设置了的话）。
3. 检查 OneBot 日志，确认消息是否已上报。

**Q: 为什么我没 @ 也没触发词，机器人还是回了？**
A: 通常是 `requireMention` 被设成了 `false`。在该模式下，群内普通消息也可能触发。若你要“非@时必须说唤醒词”，请设置：

1. `requireMention=true`
2. `keywordTriggers` 填入唤醒词（如 `椰子`）

**Q: 我想让群里只有唤醒词触发，连 @ / 回复都忽略，怎么配？**
A: 设置：

1. `keywordOnlyTrigger=true`
2. `keywordTriggers` 填入唤醒词（如 `椰子`）

**Q: QQ 日志里为什么会看到“带历史内容”的请求体？**
A: 这是 `historyLimit` 的行为。当前版本默认 `0`，即不额外拼接群历史，主要依赖 OpenClaw 会话系统管理上下文（更接近 Telegram 行为）。
如果你把 `historyLimit` 设为 `>0`，插件会在每次群聊请求里附加最近 N 条原文消息。


**Q: 怎么判断机器人是在忙还是已经空闲？**
A: 默认已开启 `showProcessingStatus=true`。机器人执行任务时会临时把群名片改为 `yezi(输入中)`，任务结束会自动恢复原名。
另外可用管理员命令 `/status` 查看 `ActiveTasks`：
- `ActiveTasks > 0`：仍在执行中
- `ActiveTasks = 0`：当前空闲，需要新指令才会继续

## 🆕 近期改进

*   修复 `admins` 逻辑：`admins` 现在仅控制管理员指令权限，不再拦截普通群消息。
*   优化会话路由：QQ 会话改为标准路由器管理，减少在控制台/WebUI中的会话错位与混淆。
*   降低上下文噪音：`historyLimit` 默认改为 `0`，默认依赖会话系统，不重复注入历史原文。

**Q: 如何让 Bot 说话（TTS）？**
A: 将 `enableTTS` 设为 `true`。注意：这取决于 OneBot 服务端是否支持 TTS 转换。通常 NapCat/Lagrange 对此支持有限，可能需要额外插件。

---

## 🆚 与 Telegram 插件的功能区别

如果您习惯使用 OpenClaw 的 Telegram 插件，以下是 `openclaw_qq` 在体验上的主要差异：

| 功能特性 | QQ 插件 (openclaw_qq) | Telegram 插件 | 体验差异说明 |
| :--- | :--- | :--- | :--- |
| **消息排版** | **纯文本** | **原生 Markdown** | QQ 不支持加粗、代码块高亮，插件会自动转换排版。 |
| **流式输出** | ❌ 不支持 | ✅ 支持 | TG 可实时看到 AI 打字；QQ 需等待 AI 生成完毕后整段发送。 |
| **消息编辑** | ❌ 不支持 | ✅ 支持 | TG 可修改已发内容；QQ 发送后无法修改，只能撤回。 |
| **交互按钮** | ❌ 暂不支持 | ✅ 支持 | TG 消息下方可带按钮；QQ 目前完全依靠文本指令。 |
| **风控等级** | 🔴 **极高** | 🟢 **极低** | QQ 极易因回复过快或敏感词封号，插件已内置分片限速。 |
| **戳一戳** | ✅ **特色支持** | ❌ 不支持 | QQ 特有的社交互动，AI 可感知并回应。 |
| **转发消息** | ✅ **深度支持** | ❌ 基础支持 | QQ 插件专门优化了对“合并转发”聊天记录的解析。 |
