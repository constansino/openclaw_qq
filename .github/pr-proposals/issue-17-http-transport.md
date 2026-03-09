# 提案：接入 OneBot HTTP 传输层

对应 Issue: #17

Refs #17

## 说明
- 这是一个正式评审用 PR。
- 当前 PR 先以独立方案文档与最小变更承载评审，供团队决定是否继续沿本分支补正式实现。

## 目标
- 在保持现有 WebSocket 行为不变的前提下，为 QQ 插件补充 OneBot HTTP 接入能力。
- 明确拆分 transport 层，避免后续在 `src/client.ts` 中继续混写 ws/http 分支。

## 本 PR 的边界
- 只处理 transport 抽象与 HTTP 模式配置。
- 不顺手改 AI runtime tools、session key、typing indicator、媒体发送链路。

## 拟议改动
1. `src/client.ts`
   - 抽出 `OneBotTransport` 抽象：`send`、`sendWithResponse`、`connect/startInbound`、`disconnect`
   - 保留现有 `WebSocketTransport`
   - 新增 `HttpTransport`
2. `src/config.ts`
   - 新增 `transport: "ws" | "http"`
   - 新增 `httpApiUrl`、`httpListenHost`、`httpListenPort`、`httpListenPath` 等配置
3. `src/channel.ts`
   - 启动时按 transport 选择底层实现
   - HTTP 入站事件复用现有消息处理器，不复制业务逻辑
4. `README.md`
   - 增加 HTTP 模式样例与迁移说明

## 不在本 PR 范围
- #22 的 routing / session 归档问题
- #32 的 typing 机制替换
- #33 的工具暴露

## 验收标准
- `ws` 模式行为不回退
- `http` 模式可收消息、发消息、做状态探测
- 文档覆盖最小可用配置

## 相关 issue
- #17
- #22
- #26
- #33

