# OneBot HTTP 模式说明

> 通过 HTTP API + webhook 对接 QQ，不使用 WebSocket 长连接。

## 核心配置

- `transport`：`http`，启用 HTTP 模式。
- `httpUrl`：OneBot HTTP API 地址，例如 `http://127.0.0.1:3000`。
- `httpWebhookPath`：webhook 路径，留空时默认 `/plugins/qq/<accountId>/onebot`。
- `httpWebhookToken`：webhook 鉴权 token，留空时回退到 `accessToken`。
- `accessToken`：OpenClaw 调用 OneBot HTTP API 的 token，需与 OneBot / NapCat 一致。
- HTTP 模式下不需要 `wsUrl`。
- webhook 鉴权支持 `Authorization`、`x-onebot-token`、`x-access-token`。

## 示例配置

```json
{
  "channels": {
    "qq": {
      "transport": "http",
      "httpUrl": "http://127.0.0.1:3000",
      "httpWebhookPath": "/plugins/qq/default/onebot",
      "httpWebhookToken": "your_webhook_token",
      "accessToken": "your_token",
      "requireMention": true
    }
  },
  "plugins": {
    "entries": {
      "qq": { "enabled": true }
    }
  }
}
```

## 工作流程

1. OpenClaw 通过 `httpUrl` 发送 `POST <httpUrl>/<action>` 请求。
2. OneBot / NapCat 将事件 `POST` 到 `httpWebhookPath`。
3. 插件 webhook 仅接受 `POST`，并优先使用 `httpWebhookToken` 校验；未配置时回退到 `accessToken`。

## 常见排查

- `401 unauthorized`：检查 webhook token 或请求头。
- `405 Method Not Allowed`：OneBot 上报方式不是 `POST`。
- 启动时报 `httpUrl is required for http transport`：说明已切到 HTTP 模式但未填写 `httpUrl`。
- 能发消息但收不到事件：优先检查 `httpWebhookPath`、OpenClaw 可达性和 token 是否一致。

## 相关文档

- `docs/config-reference.md`
- `deploy/napcat/README.md`
- `README.md`
