# 提案：收紧 QQ 私聊目标路由与会话归档

对应 Issue: #22

Refs #22

## 说明
- 这是一个正式评审用 PR。
- 当前 PR 先以独立方案文档与最小变更承载评审，供团队决定是否继续沿本分支补正式实现。

## 目标
- 尽可能在插件侧继续收紧 `user:` / `group:` 目标的标准化，减少主动私聊误落到 group 会话的概率。
- 为后续上游核心修复准备更明确的回归样例与诊断信息。

## 本 PR 的边界
- 只做插件侧的 target 归一化、session 诊断和回归保护。
- 不宣称单独在插件仓内彻底修复所有会话分裂问题。

## 拟议改动
1. `src/channel.ts`
   - 进一步统一 `From`、`OriginatingTo`、last-route 使用的目标前缀
   - 禁止纯数字目标在内部恢复路径中重新变成歧义 target
2. `messaging.targetResolver`
   - 继续强化 `user:<QQ号>` / `group:<群号>` 约束
   - 减少模型或恢复路径写入裸数字 target 的机会
3. session 诊断
   - 为 direct/group 会话归档增加更清晰的调试日志
   - 便于定位究竟是插件侧还是核心 routing 侧发生分裂
4. 回归保护
   - 补覆盖“主动私聊 -> direct 会话”“重复主动私聊 -> 不新增 group 会话”的样例

## 不在本 PR 范围
- 上游 `openclaw` 核心的最终 routing/session key 归档逻辑
- #34 已处理过的 session key 风格回归以外的更大范围重构

## 验收标准
- 插件内部不再重新产出歧义 target
- 诊断日志能区分 direct/group 归档链路
- 为后续上游修复提供稳定复现基础

## 相关 issue
- #22
- #34

