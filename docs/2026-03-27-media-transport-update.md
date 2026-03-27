# 2026-03-27 媒体链路与传输模式更新

本次更新聚焦两件事：

1. 把 QQ 插件收口为稳定的 OneBot WebSocket 接入。
2. 把入站图片、文件、语音的上下文可见性补齐到可实际用于 AI 与多模态读取。

## 1. 传输模式调整

- QQ 插件现在只维护 OneBot WebSocket 模式。
- 旧版 `transport` / `httpUrl` / `httpWebhookPath` / `httpWebhookToken` 已移除。
- `wsUrl` 现在是必填项。

这样做的原因很直接：插件侧 HTTP + webhook 逻辑长期分叉、维护成本高，而且本地部署里主流仍是 NapCat / Lagrange 的 WebSocket 接入。

## 2. 入站媒体现在会优先落地到本地

- 当前消息、reply、forward 里识别到的图片会优先缓存到本地，再注入 `MediaPath` / `MediaPaths`。
- 如果图片无法落地到本地，仍会保留 `MediaUrl` / `MediaUrls` 作为回退。
- 群文件、语音也会尽量补全下载地址、本地缓存路径与 MIME 信息。

默认新增配置项：

```json
{
  "channels": {
    "qq": {
      "cacheInboundImagesToLocal": true
    }
  }
}
```

默认开启的原因是：很多 QQ 临时媒体 URL 不稳定，单纯把 URL 塞给 agent，经常会在实际读图时失效。

## 3. reply / forward 的媒体补全增强

- 解析引用消息时，会先补 OneBot 图片 URL、群文件 URL，再做上下文摘要。
- 解析合并转发时，会递归处理节点里的图片、文件、语音线索。
- 同会话并发消息合并时，不再只合并文本，也会合并媒体上下文。

这意味着 AI 在处理“引用一张图问问题”或“转发一串上下文再继续问”时，拿到的信息比之前完整得多。

## 4. 运维说明

- 入站缓存目录位于本地 OpenClaw 状态目录下，例如 `~/.openclaw/media/inbound/qq`。
- 该目录会持续增长，建议生产环境自行加清理策略。
- `sharedMediaHostDir` / `sharedMediaContainerDir` 仍然建议保留给出站音频、文件发送链路使用；它和入站缓存目录不是一回事。

## 5. 相关问题

这轮更新主要覆盖以下问题类型：

- `#23`：`file://` 入站图片和语音线索对 AI 不可见。
- `#26`：本地截图类媒体路径在 QQ 发送链路中兼容性不足。
- `#47`：图片 / 文件收发链路在容器和临时 URL 场景下不稳定。
