# 提案：使用群名提升 ConversationLabel 可读性

对应 Issue: #31

Refs #31

## 说明
- 这是一个正式评审用 PR。
- 当前 PR 先以独立方案文档与最小变更承载评审，供团队决定是否继续沿本分支补正式实现。

## 目标
- 用真实 `group_name` 提升 `ConversationLabel` 的可读性。
- 保持线程内部使用的 `ThreadLabel` / session 语义不变。

## 本 PR 的边界
- 只改给模型看的会话标签与隐藏 meta。
- 不改 session key，不改会话迁移，不改 routing。

## 拟议改动
1. 群信息缓存
   - 新增 `groupInfoCache`
   - 按需调用 `get_group_info(group_id)` 获取 `group_name`
2. label 分流
   - `ConversationLabel` 使用人类可读群名
   - `ThreadLabel` 保留当前线程标签语义
3. 隐藏 meta
   - 补充 `groupName=...`
4. 失败回退
   - API 失败时回退到 `group_id`

## 不在本 PR 范围
- #22 / #34 的 session key 与归档修复
- #29 / #30 的字段增强

## 验收标准
- 群消息的 `ConversationLabel` 优先显示真实群名
- 原有会话线程逻辑不变

## 相关 issue
- #31
- #22
- #34

