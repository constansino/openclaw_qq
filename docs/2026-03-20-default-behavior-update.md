# 2026-03-20 默认行为调整

> 这轮更新的重点是调整 `openclaw_qq` 的默认值和默认输出策略，让 QQ 群聊体验更稳、更接近实际使用习惯。
>
> 原则上不改 OpenClaw core 的既有设计；如果你更喜欢旧体验，仍可通过配置项手动恢复。

## 这轮改了什么

### 1. 默认关闭“新消息打断旧回复”

- `interruptOnNewMessage` 默认保持 `false`。
- 只有在你显式配置为 `true` 时，插件才会因为同会话新消息到达而中断上一轮回复。

这样做的原因是：QQ 群聊里很多时候希望一轮任务完整走完，避免“刚说到一半就被下一条消息顶掉”。

### 2. 默认按完整 assistant message 落地

- `blockStreaming=true`
- `blockStreamingBreak=message_end`

这意味着：

- 过程句可以继续正常发出。
- 但不会退回到更碎的逐段切片输出。
- commentary / final 会尽量按完整消息边界落地，更适合 QQ 群聊阅读。

### 3. 默认长正文超过 300 字就改用 QQ 合并转发

- `forwardLongReplyThreshold=300`

当前默认策略是：

- 短 commentary：普通消息直接发送。
- 长 `final_answer`：超过 300 字时自动改为 QQ 合并转发。

这样可以保留过程句，又避免长正文在群里刷成多段。

### 4. 默认转发不再按长度拆节点

- `forwardNodeCharLimit=0`

这里的 `0` 不是关闭转发，而是表示：

- 启用合并转发时，不再按“每个节点多少字”继续拆分。
- 同一轮长回复会尽量塞进一个合并转发里。

这更符合 QQ 使用场景，因为既然已经转发了，就没必要再人为拆成多个节点。

### 5. 默认关闭群聊裸 slash 指令

- `allowBareGroupCommands=false`

默认情况下，群聊里单独发送 `/model`、`/models`、`/newsession` 这类 slash 指令不会直接触发。

当前更推荐的默认用法是：

- `椰子 /model`
- `椰子 /models`
- `椰子 /newsession`

这样可以避免群里普通讨论里夹带 `/xxx` 时误触发本地命令，也更符合“先唤醒，再执行管理指令”的使用习惯。

### 6. 默认关闭 `/model` 的动态全量模型探测

- `enableDynamicModelCatalog=false`

这项配置关闭时，本地 `/model` 列表不会主动去探测各 provider 的 `/models` 接口拉取全量目录，而是优先按本地配置展示。

这样做的目的是让默认行为更保守，也更接近 OpenClaw 原本“按现有配置/allowlist 工作”的思路；如果你确实需要插件层动态聚合所有模型目录，再手动开启即可。

### 7. reply / forward 上下文读取补强

这轮还补强了 QQ 消息里的上下文解析：

- 引用消息里的原文，现在可以更稳定地被读取并注入给模型。
- 合并转发里的文本线索，也会继续参与上下文构建。

这部分属于 QQ 插件层的上下文提取与输出适配，不是去改 OpenClaw core 的主逻辑。

## 默认值变化一览

| 配置项 | 现在默认值 | 说明 |
| :--- | :--- | :--- |
| `interruptOnNewMessage` | `false` | 默认不因新消息打断当前任务 |
| `blockStreaming` | `true` | 保留按 assistant message 的分块发送 |
| `blockStreamingBreak` | `message_end` | 每条 assistant message 完整后再发 |
| `forwardLongReplyThreshold` | `300` | 长 `final_answer` 超过 300 字自动走合并转发 |
| `forwardNodeCharLimit` | `0` | 转发时不按长度拆节点，尽量合并成一个转发 |
| `allowBareGroupCommands` | `false` | 群聊裸 `/model` 默认不触发，需配合唤醒词 |
| `enableDynamicModelCatalog` | `false` | `/model` 默认不主动探测 provider `/models` 全量目录 |

## 推荐理解方式

可以把默认输出策略理解成下面这条规则：

1. 短过程句，直接作为普通消息发出。
2. 长正文，如果超过阈值，就整体改成一个 QQ 合并转发。
3. 默认不因为“同一轮 reply 被拆成多个 block”就把 QQ 侧发成多条零碎消息或多个转发节点。

## 如果你想恢复旧体验

如果你更喜欢以前那种更激进的切换/拆分方式，可以手动改回去。例如：

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

这会更接近旧体验：

- 新消息可以打断旧回复。
- 群聊里裸 `/model` 这类命令又可以直接触发。
- `/model` 会重新主动探测 provider `/models` 全量目录。
- 输出边界更碎。
- 长文要到更长才转发。
- 转发节点会继续按长度切分。

## 适用场景

这组默认值主要面向以下 QQ 场景：

- 群里需要先看到一条简短过程句，再看到完整长正文。
- 不希望机器人因为新消息太多而频繁打断自己的上一轮任务。
- 长文尽量少刷屏，直接走合并转发。
- 已经走合并转发后，不希望再拆成多个节点影响阅读。

## 结论

这轮更新的核心不是“改 OpenClaw 的工作方式”，而是把 `openclaw_qq` 的默认行为调得更保守、更贴近 QQ 的实际交互习惯。

如果你需要之前的行为，配置项仍然保留，随时可以手动调回。
