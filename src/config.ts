import { z } from "zod";

const normalizeLooseString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeLooseString(item))
      .filter((item): item is string => Boolean(item && item.trim().length > 0))
      .join(",");
  }
  if (typeof value === "object") {
    const values = Object.values(value as Record<string, unknown>);
    return values
      .map((item) => normalizeLooseString(item))
      .filter((item): item is string => Boolean(item && item.trim().length > 0))
      .join(",");
  }
  return String(value).trim();
};

const IdListStringSchema = z.preprocess((value) => {
  const normalized = normalizeLooseString(value);
  if (normalized === undefined) return undefined;
  return normalized.replace(/^"|"$|^'|'$/g, "").trim();
}, z.string().optional().default(""));

const NumberInputSchema = (defaultValue: number) => z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value;
  const normalized = normalizeLooseString(value);
  if (!normalized) return undefined;
  const cleaned = normalized.replace(/^"|"$|^'|'$/g, "").trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : value;
}, z.number().optional().default(defaultValue));

const BooleanInputSchema = (defaultValue: boolean) => z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  const normalized = normalizeLooseString(value)?.toLowerCase().trim();
  if (!normalized) return undefined;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return value;
}, z.boolean().optional().default(defaultValue));

const KeywordTriggersSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeLooseString(item) ?? "")
      .map((item) => item.replace(/^"|"$|^'|'$/g, "").trim())
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((item) => normalizeLooseString(item) ?? "")
      .map((item) => item.replace(/^"|"$|^'|'$/g, "").trim())
      .filter(Boolean)
      .join(", ");
  }
  return String(value).replace(/^"|"$|^'|'$/g, "").trim();
}, z.string().optional().default(""));

export const QQConfigSchema = z.object({
  transport: z.preprocess((value) => normalizeLooseString(value)?.toLowerCase(), z.enum(["ws", "http"]).optional().default("ws")).describe("OneBot transport mode. ws = WebSocket; http = HTTP API + plugin webhook."),
  wsUrl: z.preprocess((value) => normalizeLooseString(value), z.string().url().optional()).describe("OneBot WebSocket URL. Example: ws://127.0.0.1:3001"),
  httpUrl: z.preprocess((value) => normalizeLooseString(value), z.string().url().optional()).describe("OneBot HTTP API URL. Example: http://127.0.0.1:3000"),
  httpWebhookPath: z.preprocess((value) => normalizeLooseString(value), z.string().optional().default("")).describe("Plugin webhook path used to receive OneBot events in HTTP mode."),
  httpWebhookToken: z.preprocess((value) => normalizeLooseString(value), z.string().optional()).describe("Webhook auth token for HTTP mode. Falls back to accessToken when empty."),
  accessToken: z.preprocess((value) => normalizeLooseString(value), z.string().optional()).describe("OneBot access token. Must match the OneBot/NapCat server configuration."),
  admins: IdListStringSchema.describe("管理员QQ号（字符串）。Web表单直接填：10000001,123456789；Raw JSON 填：\"10000001,123456789\"。"),
  requireMention: BooleanInputSchema(true).describe("群聊触发门槛（含命令）。true=仅在被@/回复机器人/命中关键词时触发；若同时开启 keywordOnlyTrigger，则群聊只认关键词。false=群内普通消息与命令都可能触发（容易被刷，谨慎关闭）。"),
  systemPrompt: z.preprocess((value) => normalizeLooseString(value), z.string().optional()).describe("系统提示词。示例：你是一个高效、礼貌的助理。"),
  enableDeduplication: BooleanInputSchema(true).describe("启用消息去重，避免重复回复。"),
  enableErrorNotify: BooleanInputSchema(true).describe("调用失败时是否给用户提示。"),
  adminOnlyChat: BooleanInputSchema(false).describe("仅管理员可触发聊天（防盗刷推荐开启）。"),
  notifyNonAdminBlocked: BooleanInputSchema(false).describe("启用管理员模式后，是否提示非管理员“无权限”。"),
  nonAdminBlockedMessage: z.preprocess((value) => normalizeLooseString(value), z.string().optional().default("当前仅管理员可触发机器人。\n如需使用请联系管理员。")).describe("非管理员被拦截时的提示文案。"),
  blockedNotifyCooldownMs: NumberInputSchema(10000).describe("非管理员拦截提示防抖时长（毫秒）。10秒可填 10000。"),
  enableEmptyReplyFallback: BooleanInputSchema(true).describe("空回复兜底开关。开启后，若模型返回空内容，会自动给出提示，避免群里看起来像无响应。"),
  emptyReplyFallbackText: z.preprocess((value) => normalizeLooseString(value), z.string().optional().default("⚠️ 本轮模型返回空内容。请重试，或先执行 /newsession 后再试。")).describe("空回复兜底文案。示例：⚠️ 本轮模型返回空内容，请 /newsession 后重试。"),
  maxRetries: NumberInputSchema(0).describe("模型请求失败或返回空回复时的最大自动重试次数。默认 0（关闭自动重试）。"),
  retryDelayMs: NumberInputSchema(3000).describe("自动重试之间的间隔时间（毫秒，默认 3000；仅在 maxRetries > 0 时生效）。"),
  fastFailErrors: z.array(z.string()).optional().default([]).describe("快速跳过错误关键词列表。默认空数组（关闭）；填写如 401、Unauthorized、余额不足 后，命中时会直接跳过当前模型。"),
  showProcessingStatus: BooleanInputSchema(true).describe("忙碌状态可视化开关（默认开启）。开启后，机器人在群里处理任务时会临时把自己的群名片改成“(输入中)”后缀。"),
  showReplySessionSource: BooleanInputSchema(true).describe("是否在每次面向用户的回复前附加来源会话标记，例如 `(from 会话写方案)` 或 `(from 主会话)`。默认开启；使用 /临时 功能区分上下文时尤其有用。"),
  processingStatusDelayMs: NumberInputSchema(500).describe("触发“输入中”群名片后缀的延迟（毫秒，默认 500）。"),
  processingStatusIntervalMs: NumberInputSchema(0).describe("保留字段（当前未使用）。"),
  processingStatusText: z.preprocess((value) => normalizeLooseString(value), z.string().optional().default("输入中")).describe("忙碌后缀文本（默认“输入中”）。示例：输入中。"),
  processingPulseText: z.preprocess((value) => normalizeLooseString(value), z.string().optional().default("")).describe("保留字段（当前未使用）。"),
  autoApproveRequests: BooleanInputSchema(false).describe("自动通过好友申请/群邀请。"),
  maxMessageLength: NumberInputSchema(4000).describe("单条消息最大长度，超出后自动分段发送。"),
  formatMarkdown: BooleanInputSchema(false).describe("把 Markdown 转纯文本，QQ 显示更清晰。"),
  antiRiskMode: BooleanInputSchema(false).describe("风控规避模式（例如处理 URL 发送样式）。"),
  allowedGroups: IdListStringSchema.describe("允许响应的群号白名单（字符串）。Web表单填：20000001 123456789；Raw JSON 填：\"20000001 123456789\"。"),
  blockedUsers: IdListStringSchema.describe("用户黑名单QQ号（字符串）。Web表单填：30000001 或 30000001,10002；Raw JSON 填：\"30000001\"。"),
  historyLimit: NumberInputSchema(0).describe("群历史注入条数。默认0（推荐，依赖会话系统）；需强保留原文时可设 3~5。"),
  keywordOnlyTrigger: BooleanInputSchema(false).describe("群聊仅关键词触发开关。开启后，@机器人/回复机器人消息不再触发；建议配合 keywordTriggers 一起使用。适合与其他机器人共用同一 QQ 账号时避免双重回复。"),
  keywordTriggers: KeywordTriggersSchema.describe("关键词触发（字符串）。Web表单填：小助手, 帮我；Raw JSON 填：\"小助手, 帮我\"。当 requireMention=true 时，命中关键词可不@直接触发；当 requireMention=false 时，关键词不是必需条件；当 keywordOnlyTrigger=true 时，群聊里只有命中这些关键词才会触发。"),
  enableTTS: BooleanInputSchema(false).describe("是否启用语音回复（依赖 OneBot 服务端支持）。"),
  sharedMediaHostDir: z.preprocess((value) => normalizeLooseString(value), z.string().optional().default("")).describe("可选：宿主机共享媒体目录（供 NapCat 容器访问）。示例：/Users/xxx/openclaw_qq/deploy/napcat/shared_media。"),
  sharedMediaContainerDir: z.preprocess((value) => normalizeLooseString(value), z.string().optional().default("/openclaw_media")).describe("可选：共享目录在 NapCat 容器内的挂载路径。默认 /openclaw_media。"),
  enableGuilds: BooleanInputSchema(true).describe("是否启用 QQ 频道（Guild）支持。"),
  enrichReplyForwardContext: BooleanInputSchema(true).describe("是否递归解析 reply/forward 并注入多层上下文。默认开启。"),
  maxReplyLayers: NumberInputSchema(5).describe("reply 最大递归层数。默认 5。"),
  maxForwardLayers: NumberInputSchema(5).describe("forward 最大递归层数。默认 5。"),
  maxForwardMessagesPerLayer: NumberInputSchema(8).describe("每层 forward 最多展开多少条子消息。默认 8。"),
  maxCharsPerLayer: NumberInputSchema(900).describe("每层注入文本最大字符数。默认 900。"),
  maxTotalContextChars: NumberInputSchema(3000).describe("reply/forward 总注入字符上限。默认 3000。"),
  includeSenderInLayers: BooleanInputSchema(true).describe("层级上下文里是否包含发送者昵称/ID。"),
  includeCurrentOutline: BooleanInputSchema(true).describe("是否注入当前消息概要层。"),
  rateLimitMs: NumberInputSchema(1000).describe("多段消息发送间隔（毫秒）。建议 1000。"),
  enableQueueNotify: BooleanInputSchema(true).describe("当消息进入防抖合并队列时，是否发送提示（由于已经是静默合并，建议设为false或保持默认）。"),
  queueDebounceMs: NumberInputSchema(0).describe("连续消息合并防抖等待时间（毫秒，默认 0=关闭；大于 0 时才会开启明显的消息合并窗口）。"),
  injectGatewayMeta: BooleanInputSchema(false).describe("是否在系统提示前注入隐藏 QQ 网关元数据（会话来源、触发方式、会话标签等）。默认关闭。"),
  interruptOnNewMessage: BooleanInputSchema(false).describe("同会话新消息到达时，是否中断上一轮回复并优先处理最新请求。默认关闭。"),
  forwardLongReplyThreshold: NumberInputSchema(0).describe("长回复自动转为 QQ 合并转发的阈值（字符数）。0=关闭该功能。"),
  forwardNodeCharLimit: NumberInputSchema(1000).describe("启用长回复合并转发时，每个转发节点的最大字符数。默认 1000。"),
  forwardNodeName: z.preprocess((value) => normalizeLooseString(value), z.string().optional().default("OpenClaw")).describe("启用长回复合并转发时，节点显示昵称。默认 OpenClaw。"),
}).passthrough();

export type QQConfig = z.infer<typeof QQConfigSchema>;
