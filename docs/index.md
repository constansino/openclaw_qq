# OpenClaw QQ 文档中心

> OneBot v11 渠道插件文档主页。
>
> 当前仓库文档统一维护中文版本。

## 快速入口

- [3 分钟快速开始](./quickstart.md)
- [配置参考（分组版）](./config-reference.md)
- [2026-04-30 原生文件 / 媒体收发更新](./2026-04-30-native-media-file-update.md)
- [2026-03-27 媒体链路与传输模式更新](./2026-03-27-media-transport-update.md)
- [2026-03-20 默认行为调整](./2026-03-20-default-behavior-update.md)
- [部署指引（NapCat）](https://github.com/constansino/openclaw_qq/blob/main/deploy/napcat/README.md)
- [高级能力与完整参数](./advanced.md)
- [在线文档首页](https://constansino.github.io/openclaw_qq/)

## 文档目标

本项目文档按“先跑通，再进阶”的思路组织：

1. 先完成最小可用配置，确保机器人可收发消息。
2. 再按需开启高级能力（重试、上下文增强、并发防漏、长回复转发等）。
3. 生产环境最后再做权限和风控加固。

## 推荐阅读顺序

1. [快速开始](./quickstart.md)
2. [配置参考](./config-reference.md)
3. [2026-04-30 原生文件 / 媒体收发更新](./2026-04-30-native-media-file-update.md)
4. [2026-03-27 媒体链路与传输模式更新](./2026-03-27-media-transport-update.md)
5. [2026-03-20 默认行为调整](./2026-03-20-default-behavior-update.md)
6. [部署指引（NapCat）](https://github.com/constansino/openclaw_qq/blob/main/deploy/napcat/README.md)

## 交流与支持

- **官方交流论坛（唯一）：**
  - https://aiya.de5.net/c/25-category/25
- 不建立 QQ 群，问题与经验统一沉淀在论坛，便于检索与追踪。

## 传输模式

- 当前版本仅维护 OneBot WebSocket 接入；插件侧 HTTP + webhook 模式已移除。
