# 提案：向 AI 暴露 OneBot 运行时工具

对应 Issue: #33

Refs #33

## 说明
- 这是一个正式评审用 PR。
- 当前 PR 先以独立方案文档与最小变更承载评审，供团队决定是否继续沿本分支补正式实现。

## 目标
- 把高价值 OneBot 查询与动作能力暴露给 AI 在运行时主动调用。
- 先从低风险读工具开始，再补带副作用写工具。

## 本 PR 的边界
- 只加 channel agent tools / message action 能力。
- 不改 transport、不改 routing、不改 typing、不顺手改媒体链路。

## 拟议改动
1. 读工具（首批）
   - `qq_group_members`
   - `qq_group_info`
   - `qq_group_announcements`
   - `qq_user_info`
2. 写工具（带权限门）
   - `qq_react`
   - `qq_poke`
3. `src/client.ts`
   - 补 `get_group_member_list`、`get_group_info`、`get_group_notice`、`get_stranger_info`、`set_msg_emoji_like`、`friend_poke` 等 API 包装
4. tool gating
   - 写操作复用 `admins` / `CommandAuthorized` 或显式 ownerOnly 约束

## 不在本 PR 范围
- #17 的 HTTP transport
- #22 的会话归档修复
- #32 的 typing 替换

## 验收标准
- AI 可在运行时调用读工具查询 QQ 环境
- 写工具有明确权限门与错误提示

## 相关 issue
- #33
- #30
- #29

