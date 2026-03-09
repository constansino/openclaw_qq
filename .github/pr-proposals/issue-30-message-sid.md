# 提案：在入站上下文中补充 MessageSid

对应 Issue: #30

Refs #30

## 说明
- 这是一个正式评审用 PR。
- 当前 PR 先以独立方案文档与最小变更承载评审，供团队决定是否继续沿本分支补正式实现。

## 目标
- 把当前入站消息的 `message_id` 明确透传为 `MessageSid`。
- 为后续消息引用、动作工具和诊断链路提供统一锚点。

## 本 PR 的边界
- 只补当前消息的 `MessageSid`。
- 不扩展 sender.role、不改标签、不改 routing。

## 拟议改动
1. `finalizeInboundContext(...)`
   - 注入 `MessageSid: String(event.message_id)`
2. 兼容性处理
   - 缺失 `message_id` 时不注入
3. 保持现有逻辑不动
   - 不影响 dedup、reply 查询、dispatch 行为

## 不在本 PR 范围
- #29 的 sender role 透传
- #31 的会话标签增强
- #33 的工具扩展

## 验收标准
- 群聊 / 私聊 / 频道入站消息都能拿到 `MessageSid`
- 现有行为不回退

## 相关 issue
- #30
- #29
- #33
- #35

