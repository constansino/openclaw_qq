# 配置参考（分组版）

> 目标：先理解“必须配什么”，再看“按需开启什么”。

## A. 必需项

- `wsUrl`：OneBot WebSocket 地址。
- 当前版本仅支持 OneBot WebSocket 接入；旧版 `transport` / `httpUrl` / `httpWebhook*` 已移除。
- `accessToken`：OneBot 访问令牌（如启用鉴权）。

## B. 基础触发与访问控制

- `requireMention`：群聊触发门槛（@ / 回复 / 关键词）。
- `keywordOnlyTrigger`：群聊是否只接受关键词触发（忽略 @ / 回复）。
- `keywordTriggers`：群聊唤醒词列表。
- `allowBareGroupCommands`：是否允许群聊裸 `/model` 这类 slash 指令直接触发（默认关闭）。
- `admins`：管理员 QQ 列表。
- `adminOnlyChat`：仅管理员可触发聊天。
- `allowedGroups`：群白名单。
- `blockedUsers`：用户黑名单。

## C. 稳定性与容错

- `maxRetries`：失败后自动重试次数（默认 `0`，关闭）。
- `retryDelayMs`：重试间隔（仅在 `maxRetries > 0` 时生效）。
- `fastFailErrors`：命中即快速切换模型/跳过等待（默认空数组，关闭）。
- `enableEmptyReplyFallback`：空回复兜底。
- `emptyReplyFallbackText`：空回复兜底文案。

## D. 并发与打断

- `queueDebounceMs`：同会话消息防抖合并窗口（默认 `0`，关闭）。
- `interruptOnNewMessage`：新消息是否打断旧回复（默认关闭）。

## E. 上下文增强

- `historyLimit`：注入群历史条数（推荐默认 0）。
- `enrichReplyForwardContext`：是否递归解析 reply/forward。
- `cacheInboundImagesToLocal`：是否把当前消息及 reply / forward 里的图片缓存到本地 `MediaPaths`。
- `maxReplyLayers` / `maxForwardLayers`：递归深度上限。
- `maxTotalContextChars`：注入字符预算上限。

## F. 输出与风控

- `maxMessageLength`：单条消息最大长度。
- `rateLimitMs`：多段发送间隔。
- `blockStreaming`：是否按 assistant message 分块发送回复。
- `blockStreamingBreak`：分块发送边界（推荐 `message_end`）。
- `formatMarkdown`：Markdown 转纯文本。
- `antiRiskMode`：风控规避模式。
- `showReplySessionSource`：给回复附加来源会话标记（临时会话场景很有用）。
- `forwardLongReplyThreshold`：最终长回复自动合并转发阈值（默认 `300`，仅对 `final_answer` 生效）。
- `forwardNodeCharLimit`：合并转发时单节点字符上限（默认 `0`，表示不按长度拆节点）。
- `enableDynamicModelCatalog`：本地 `/model` 是否主动探测 provider `/models` 全量目录（默认关闭）。

## G. 多媒体与频道

- `enableTTS`：语音回复开关。
- `enableGuilds`：QQ 频道消息支持。
- `sharedMediaHostDir` / `sharedMediaContainerDir`：媒体共享路径（容器部署时常用）。

## 推荐最小生产配置

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://127.0.0.1:3001",
      "accessToken": "your_token",
      "requireMention": true,
      "keywordTriggers": "椰子",
      "admins": "10000001",
      "adminOnlyChat": true,
      "allowedGroups": "20000001",
      "rateLimitMs": 1000,
      "maxRetries": 0,
      "retryDelayMs": 3000,
      "fastFailErrors": [],
      "queueDebounceMs": 0,
      "injectGatewayMeta": false,
      "interruptOnNewMessage": false,
      "allowBareGroupCommands": false,
      "blockStreaming": true,
      "blockStreamingBreak": "message_end",
      "cacheInboundImagesToLocal": true,
      "forwardLongReplyThreshold": 300,
      "forwardNodeCharLimit": 0,
      "enableDynamicModelCatalog": false
    }
  }
}
```

## 当前默认输出策略

- 过程句会按普通消息发送，不需要为了短 commentary 额外走转发。
- `final_answer` 超过 `300` 字时，默认自动改用 QQ 合并转发。
- 默认不会把同一轮长回复继续按节点长度拆开；`forwardNodeCharLimit=0` 就是“不拆节点”。
- 默认不因同会话新消息而打断当前任务；只有把 `interruptOnNewMessage` 显式设为 `true` 才会启用。
- 默认不允许群聊裸 slash 指令直接触发；请用 `椰子 /model` 这类“唤醒词 + 指令”形式。
- 本地 `/model` 默认不主动探测 provider `/models` 全量目录；只在你显式开启 `enableDynamicModelCatalog=true` 时才做动态聚合。
- 默认会把识别到的入站图片缓存到本地 `MediaPaths`；如果你只想保留 URL 提示，可把 `cacheInboundImagesToLocal` 设为 `false`。

## 恢复旧体验示例

如果你更喜欢之前更激进的打断/拆分方式，可以手动配置：

```json
{
  "channels": {
    "qq": {
      "interruptOnNewMessage": true,
      "allowBareGroupCommands": true,
      "enableDynamicModelCatalog": true,
      "blockStreamingBreak": "text_end",
      "forwardLongReplyThreshold": 800,
      "forwardNodeCharLimit": 1000
    }
  }
}
```

## 进一步阅读

- 默认行为调整说明：查看 [2026-03-20 默认行为调整](./2026-03-20-default-behavior-update.md)。
- 完整参数与示例：查看仓库根目录 `README.md` 的配置章节。
- 部署细节：查看 [NapCat 部署说明](https://github.com/constansino/openclaw_qq/blob/main/deploy/napcat/README.md)。
