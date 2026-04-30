# 2026-04-30 原生文件 / 媒体收发更新

本次更新把 QQ 文件与富媒体收发能力收进 `openclaw_qq` 插件本体，目标是：普通 OpenClaw 回复、`message` 工具、自动回复 payload 都可以直接通过 QQ 插件完成图片、语音、视频和普通文件发送，不再依赖外部“发文件 skill”兜底。

## 1. 这轮解决了什么

### 入站：QQ 文件能收到，但不再污染上下文

- 支持从当前消息、引用消息、合并转发中提取 QQ 文件线索。
- 文件会保留完整元数据：`name`、`url`、`local_path`、`file_id`、`busid`、`size`、`mime`。
- 普通文件（例如 `.txt`、`.zip`、`.pdf`）默认只作为 `<attachments>` 元数据进入上下文。
- 普通文件不会再自动注入 `MediaPath` / `MediaPaths`，避免 TXT 这类文本附件被 runtime 自动展开全文，造成提示词污染或外部文件注入。
- 用户明确要求读取文件时，agent 仍可根据 `local_path` 主动读取。

### 出站：图片、语音、视频、压缩包走插件原生逻辑

- `outbound.sendMedia` 现在会根据文件类型自动分流：
  - 图片：OneBot `image` segment
  - 音频 / 语音：OneBot `record` segment
  - 视频：OneBot `video` segment
  - 普通文件：优先 `upload_group_file` / `upload_private_file`
- `outbound.sendPayload` 会处理 `payload.mediaUrl`、`payload.mediaUrls`、`payload.files`，支持文本 + 多附件同发。
- 普通文件上传返回的 `file_id` 会被作为可读 message id 回传，避免出现 `[object Object]` 这种错误结果。

## 2. 为什么 TXT 不再自动读入上下文

QQ 文件附件和用户直接上传给模型看的文件不是一回事。

如果插件把普通 QQ 文件的本地路径直接塞进 `MediaPath`，OpenClaw runtime 可能会把 `text/plain` / `.txt` 自动展开成 `<file>...</file>`。这对“引用人格模板、日志、配置、压缩包说明”等场景很危险：文件内容可能不是用户当前指令，却会直接进入模型上下文。

因此本轮规则改为：

- 图片仍可进入媒体上下文，便于多模态读取。
- 音频 / 视频继续保留媒体线索。
- 普通文件只进附件元数据。
- 需要读正文时，由用户明确要求后再读 `local_path`。

## 3. 路径与容器场景

插件同时兼容几类出站媒体来源：

- 本机绝对路径
- `file://` URL
- HTTP(S) URL
- `base64://` 数据
- OpenClaw runtime 提供的 `mediaReadFile` / `mediaAccess.readFile`

普通文件上传时，插件会优先走 OneBot/NapCat 的文件上传接口。对于远端 NapCat 容器无法直接读取的本机文件，插件会尽量使用可被 OneBot 接受的 URL / base64 / 上传路径；如果配置了 `sharedMediaHostDir` 与 `sharedMediaContainerDir`，本地文件也会先 staging 到共享目录再交给容器读取。

## 4. 失败回退策略

- 图片、语音、视频先走对应 rich media segment。
- rich media 发送失败时，插件会尝试回退为普通文件上传。
- 普通文件优先走 `upload_group_file` / `upload_private_file`；失败后再尝试 OneBot `file` segment。
- 返回结果会在 `meta` 中标记 `mediaKind`、`transport`、`fallbackSent`、`fallbackType` 等字段，便于排查。

## 5. 已验证场景

本轮已实测：

- 引用 QQ 压缩包文件后，插件能收到并落盘到本地入站缓存目录。
- 引用 TXT 文件后，上下文只保留附件元数据，不再自动展开 TXT 正文。
- 使用固化 QQ 插件原生逻辑发送图片成功。
- 使用固化 QQ 插件原生逻辑发送语音成功。
- 使用固化 QQ 插件原生逻辑发送 `.zip` 压缩包成功，走 `upload_group_file`。

## 6. 涉及的主要代码点

- `src/channel.ts`
  - 入站附件提取与 metadata-only 保护
  - `sendMedia` 原生图片 / 音频 / 视频 / 文件分流
  - `sendPayload` 多附件处理
  - `upload_group_file` / `upload_private_file` 文件上传
  - rich media 失败后的文件上传 fallback
- `src/types.ts`
  - 补齐 OneBot `file` / `record` / `image` segment 的常见字段类型

## 7. 使用建议

- 日常发送 QQ 图片、语音、视频、压缩包，直接走 OpenClaw 正常回复或 `message` 工具即可。
- 不再需要为了 QQ 文件发送单独调用旧的发文件 skill。
- 对外部 QQ 文件内容保持默认不信任：先看元数据，确认需要后再读取正文。
