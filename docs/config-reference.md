# 配置参考（分组版）

> 目标：先理解“必须配什么”，再看“按需开启什么”。

## A. 必需项

- `wsUrl`：OneBot WebSocket 地址。
- `accessToken`：OneBot 访问令牌（如启用鉴权）。

## B. 基础触发与访问控制

- `requireMention`：群聊触发门槛（@ / 回复 / 关键词）。
- `keywordOnlyTrigger`：群聊是否只接受关键词触发（忽略 @ / 回复）。
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
- `maxReplyLayers` / `maxForwardLayers`：递归深度上限。
- `maxTotalContextChars`：注入字符预算上限。

## F. 输出与风控

- `maxMessageLength`：单条消息最大长度。
- `rateLimitMs`：多段发送间隔。
- `formatMarkdown`：Markdown 转纯文本。
- `antiRiskMode`：风控规避模式。
- `showReplySessionSource`：给回复附加来源会话标记（临时会话场景很有用）。
- `forwardLongReplyThreshold`：长回复自动合并转发阈值。

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
      "admins": "10000001",
      "adminOnlyChat": true,
      "allowedGroups": "20000001",
      "rateLimitMs": 1000,
      "maxRetries": 0,
      "retryDelayMs": 3000,
      "fastFailErrors": [],
      "queueDebounceMs": 0,
      "injectGatewayMeta": false,
      "interruptOnNewMessage": false
    }
  }
}
```

## 进一步阅读

- 完整参数与示例：查看仓库根目录 `README.md` 的配置章节。
- 部署细节：查看 [NapCat 部署说明](https://github.com/constansino/openclaw_qq/blob/main/deploy/napcat/README.md)。
