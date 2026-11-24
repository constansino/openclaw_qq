# Thinking 级别提示的过滤

OpenClaw 可能保留会话请求的 `max` 思考偏好，同时为当前模型采用支持的 `xhigh` 级别，并生成 `Thinking level clamped ... (requested ...; preference retained).` 诊断通知。

QQ 通道过滤符合这一完整格式的通知行。模型请求、保留的 thinking 偏好以及 OpenClaw 的诊断元数据不受影响。单独的通知不会计为机器人回答；与通知同一载荷中的正常正文和附件继续投递。普通文本引用和 API 错误处理也保持原行为。

可以在插件目录执行：

```sh
node scripts/qq-thinking-notice-repro.mjs
```

脚本从实际 `src/channel.ts` 提取投递函数和文本处理函数，以内存发送端回放 final、block、混合正文、引用、错误和附件场景。无需 QQ 登录、网络请求或 API 密钥。修改前会报告 `thinking clamp leaked through final delivery`；修改后 9 项回放通过。
