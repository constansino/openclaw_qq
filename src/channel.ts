import {
  type ChannelPlugin,
  type ChannelAccountSnapshot,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import { OneBotClient } from "./client.js";
import { QQConfigSchema, type QQConfig } from "./config.js";
import { getQQRuntime } from "./runtime.js";
import type { OneBotMessage, OneBotMessageSegment } from "./types.js";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
  config: QQConfig;
  client?: OneBotClient;
};

const memberCache = new Map<string, { name: string, time: number }>();

function getCachedMemberName(groupId: string, userId: string): string | null {
    const key = `${groupId}:${userId}`;
    const cached = memberCache.get(key);
    if (cached && Date.now() - cached.time < 3600000) { // 1 hour cache
        return cached.name;
    }
    return null;
}

function setCachedMemberName(groupId: string, userId: string, name: string) {
    memberCache.set(`${groupId}:${userId}`, { name, time: Date.now() });
}

/**
 * Extract image URLs from message segments
 */
function extractImageUrls(message: OneBotMessage | string | undefined, maxImages = 3): string[] {
  if (!message || typeof message === "string") return [];
  
  const urls: string[] = [];
  for (const segment of message) {
    if (segment.type === "image") {
      const url = segment.data?.url || segment.data?.file;
      if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
        urls.push(url);
        if (urls.length >= maxImages) break;
      }
    }
  }
  return urls;
}

/**
 * Clean CQ codes from message text
 */
function cleanCQCodes(text: string | undefined): string {
  if (!text) return "";
  
  let result = text;
  const imageUrls: string[] = [];
  
  const imageRegex = /\[CQ:image,[^\]]*url=([^,\]]+)[^\]]*\]/g;
  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    const url = match[1].replace(/&amp;/g, "&");
    imageUrls.push(url);
  }

  result = result.replace(/\[CQ:face,id=(\d+)\]/g, "[表情]");
  
  result = result.replace(/\[CQ:[^\]]+\]/g, (match) => {
    if (match.startsWith("[CQ:image") && match.includes("url=")) {
      return "[图片]";
    }
    return "";
  });
  
  result = result.replace(/\s+/g, " ").trim();
  
  if (imageUrls.length > 0) {
    result = result ? `${result} [图片: ${imageUrls.join(", ")}]` : `[图片: ${imageUrls.join(", ")}]`;
  }
  
  return result;
}

/**
 * Get reply message ID
 */
function getReplyMessageId(message: OneBotMessage | string | undefined, rawMessage?: string): string | null {
  if (message && typeof message !== "string") {
    for (const segment of message) {
      if (segment.type === "reply" && segment.data?.id) {
        const id = String(segment.data.id).trim();
        if (id && /^-?\d+$/.test(id)) {
          return id;
        }
      }
    }
  }
  if (rawMessage) {
    const match = rawMessage.match(/\[CQ:reply,id=(\d+)\]/);
    if (match) return match[1];
  }
  return null;
}

function normalizeTarget(raw: string): string {
  return raw.replace(/^(qq:)/i, "");
}

const clients = new Map<string, OneBotClient>();
const processedMsgIds = new Set<string>();

setInterval(() => {
    if (processedMsgIds.size > 1000) processedMsgIds.clear();
}, 3600000);

function getClientForAccount(accountId: string) {
    return clients.get(accountId);
}

function isImageFile(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.gif') || lower.endsWith('.webp');
}

function splitMessage(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const chunks = [];
    let current = text;
    while (current.length > 0) {
        chunks.push(current.slice(0, limit));
        current = current.slice(limit);
    }
    return chunks;
}

function stripMarkdown(text: string): string {
    return text
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/`(.*?)`/g, "$1")
        .replace(/#+\s+(.*)/g, "$1")
        .replace(/\[(.*?)\]\(.*?\)/g, "$1")
        .replace(/^\s*>\s+(.*)/gm, "▎$1")
        .replace(/```[\s\S]*?```/g, "[代码块]")
        .replace(/^\|.*\|$/gm, (match) => match.replace(/\|/g, " ").trim())
        .replace(/^[\-\*]\s+/gm, "• ");
}

function processAntiRisk(text: string): string {
    return text.replace(/(https?:\/\/)/gi, "$1 ");
}

export const qqChannel: ChannelPlugin<ResolvedQQAccount> = {
  id: "qq",
  meta: {
    id: "qq",
    label: "QQ (OneBot)",
    selectionLabel: "QQ",
    docsPath: "extensions/qq",
    blurb: "Connect to QQ via OneBot v11",
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    // @ts-ignore
    deleteMessage: true,
  },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg) => {
        // @ts-ignore
        const qq = cfg.channels?.qq;
        if (!qq) return [];
        if (qq.accounts) return Object.keys(qq.accounts);
        return [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => {
        const id = accountId ?? DEFAULT_ACCOUNT_ID;
        // @ts-ignore
        const qq = cfg.channels?.qq;
        const accountConfig = id === DEFAULT_ACCOUNT_ID ? qq : qq?.accounts?.[id];
        return {
            accountId: id,
            name: accountConfig?.name ?? "QQ Default",
            enabled: true,
            configured: Boolean(accountConfig?.wsUrl),
            tokenSource: accountConfig?.accessToken ? "config" : "none",
            config: accountConfig || {},
        };
    },
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    describeAccount: (acc) => ({
        accountId: acc.accountId,
        configured: acc.configured,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
        const { account, cfg } = ctx;
        const config = account.config;

        if (!config.wsUrl) throw new Error("QQ: wsUrl is required");

        const client = new OneBotClient({
            wsUrl: config.wsUrl,
            accessToken: config.accessToken,
        });
        
        clients.set(account.accountId, client);

        client.on("connect", async () => {
             console.log(`[QQ] Connected account ${account.accountId}`);
             try {
                const info = await client.getLoginInfo();
                if (info && info.nickname) console.log(`[QQ] Logged in as: ${info.nickname} (${info.user_id})`);
                getQQRuntime().channel.activity.record({
                    channel: "qq", accountId: account.accountId, direction: "inbound", 
                 });
             } catch (err) { }
        });

        client.on("request", (event) => {
            if (config.autoApproveRequests) {
                if (event.request_type === "friend") client.setFriendAddRequest(event.flag, true);
                else if (event.request_type === "group") client.setGroupAddRequest(event.flag, event.sub_type, true);
            }
        });

        client.on("message", async (event) => {
            if (event.post_type === "meta_event") {
                 if (event.meta_event_type === "lifecycle" && event.sub_type === "connect" && event.self_id) client.setSelfId(event.self_id);
                 return;
            }

            if (event.post_type === "notice" && event.notice_type === "notify" && event.sub_type === "poke") {
                if (String(event.target_id) === String(client.getSelfId())) {
                    event.post_type = "message";
                    event.message_type = event.group_id ? "group" : "private";
                    event.raw_message = `[动作] 用户戳了你一下`;
                    event.message = [{ type: "text", data: { text: event.raw_message } }];
                } else return;
            }

            if (event.post_type !== "message") return;
            if ([2854196310].includes(event.user_id)) return;
            if (typeof event.message === "string") console.warn(`[QQ Warning] Message format is 'string'. Please use 'array'.`);

            if (config.enableDeduplication !== false && event.message_id) {
                const msgIdKey = String(event.message_id);
                if (processedMsgIds.has(msgIdKey)) return;
                processedMsgIds.add(msgIdKey);
            }

            const isGroup = event.message_type === "group";
            const userId = event.user_id;
            const groupId = event.group_id;
            let text = event.raw_message || "";
            
            if (Array.isArray(event.message)) {
                let resolvedText = "";
                for (const seg of event.message) {
                    if (seg.type === "text") resolvedText += seg.data?.text || "";
                    else if (seg.type === "at") {
                        let name = seg.data?.qq;
                        if (name !== "all" && isGroup) {
                            const cached = getCachedMemberName(String(groupId), String(name));
                            if (cached) name = cached;
                            else {
                                try {
                                    const info = await (client as any).sendWithResponse("get_group_member_info", { group_id: groupId, user_id: name });
                                    name = info?.card || info?.nickname || name;
                                    setCachedMemberName(String(groupId), String(seg.data.qq), name);
                                } catch (e) {}
                            }
                        }
                        resolvedText += ` @${name} `;
                    } else if (seg.type === "record") resolvedText += ` [语音消息]${seg.data?.text ? `(${seg.data.text})` : ""}`;
                    else if (seg.type === "video") resolvedText += " [视频消息]";
                    else if (seg.type === "json") resolvedText += " [卡片消息]";
                    else if (seg.type === "forward" && seg.data?.id) {
                        try {
                            const forwardData = await client.getForwardMsg(seg.data.id);
                            if (forwardData?.messages) {
                                resolvedText += "\n[转发聊天记录]:";
                                for (const m of forwardData.messages.slice(0, 10)) {
                                    resolvedText += `\n${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.content || m.raw_message)}`;
                                }
                            }
                        } catch (e) {}
                    } else if (seg.type === "file") {
                         if (!seg.data?.url && isGroup) {
                             try {
                                 const info = await (client as any).sendWithResponse("get_group_file_url", { group_id: groupId, file_id: seg.data?.file_id, busid: seg.data?.busid });
                                 if (info?.url) seg.data.url = info.url;
                             } catch(e) {}
                         }
                         resolvedText += ` [文件: ${seg.data?.file || "未命名"}]`;
                    }
                }
                if (resolvedText) text = resolvedText;
            }
            
            if (config.blockedUsers?.includes(userId)) return;
            if (isGroup && config.allowedGroups?.length && !config.allowedGroups.includes(groupId)) return;
            
            const isAdmin = config.admins?.includes(userId) ?? false;
            if (config.admins?.length && !isAdmin) return;

            if (isAdmin && text.trim().startsWith('/')) {
                const parts = text.trim().split(/\s+/);
                const cmd = parts[0];
                if (cmd === '/status') {
                    const statusMsg = `[OpenClawd QQ]\nState: Connected\nSelf ID: ${client.getSelfId()}\nMemory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`;
                    if (isGroup) client.sendGroupMsg(groupId, statusMsg); else client.sendPrivateMsg(userId, statusMsg);
                    return;
                }
                if (cmd === '/help') {
                    const helpMsg = `[OpenClawd QQ]\n/status - 状态\n/mute @用户 [分] - 禁言\n/kick @用户 - 踢出\n/help - 帮助`;
                    if (isGroup) client.sendGroupMsg(groupId, helpMsg); else client.sendPrivateMsg(userId, helpMsg);
                    return;
                }
                if (isGroup && (cmd === '/mute' || cmd === '/ban')) {
                    const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                    const targetId = targetMatch ? parseInt(targetMatch[1]) : (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        client.setGroupBan(groupId, targetId, parts[2] ? parseInt(parts[2]) * 60 : 1800);
                        client.sendGroupMsg(groupId, `已禁言。`);
                    }
                    return;
                }
                if (isGroup && cmd === '/kick') {
                    const targetMatch = text.match(/\[CQ:at,qq=(\d+)\]/);
                    const targetId = targetMatch ? parseInt(targetMatch[1]) : (parts[1] ? parseInt(parts[1]) : null);
                    if (targetId) {
                        client.setGroupKick(groupId, targetId);
                        client.sendGroupMsg(groupId, `已踢出。`);
                    }
                    return;
                }
            }
            
            let repliedMsg: any = null;
            const replyMsgId = getReplyMessageId(event.message, text);
            if (replyMsgId) {
                try { repliedMsg = await client.getMsg(replyMsgId); } catch (err) {}
            }
            
            let historyContext = "";
            if (isGroup && config.historyLimit !== 0) {
                 try {
                     const history = await client.getGroupMsgHistory(groupId);
                     if (history?.messages) {
                         const limit = config.historyLimit || 5;
                         historyContext = history.messages.slice(-(limit + 1), -1).map((m: any) => `${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.raw_message || "")}`).join("\n");
                     }
                 } catch (e) {}
            }

            let isTriggered = !isGroup || text.includes("[动作] 用户戳了你一下");
            if (!isTriggered && config.keywordTriggers) {
                for (const kw of config.keywordTriggers) { if (text.includes(kw)) { isTriggered = true; break; } }
            }
            if (isGroup && config.requireMention && !isTriggered) {
                const selfId = client.getSelfId();
                const effectiveSelfId = selfId ?? event.self_id;
                if (!effectiveSelfId) return;
                let mentioned = false;
                if (Array.isArray(event.message)) {
                    for (const s of event.message) { if (s.type === "at" && (String(s.data?.qq) === String(effectiveSelfId) || s.data?.qq === "all")) { mentioned = true; break; } }
                } else if (text.includes(`[CQ:at,qq=${effectiveSelfId}]`)) mentioned = true;
                if (!mentioned && repliedMsg?.sender?.user_id === effectiveSelfId) mentioned = true;
                if (!mentioned) return;
            }

            const fromId = isGroup ? `group:${groupId}` : String(userId);
            const runtime = getQQRuntime();

            const deliver = async (payload: ReplyPayload) => {
                 const send = (msg: string) => {
                     let processed = msg;
                     if (config.formatMarkdown) processed = stripMarkdown(processed);
                     if (config.antiRiskMode) processed = processAntiRisk(processed);
                     const chunks = splitMessage(processed, config.maxMessageLength || 4000);
                     for (let i = 0; i < chunks.length; i++) {
                         let chunk = chunks[i];
                         if (isGroup && i === 0) chunk = `[CQ:at,qq=${userId}] ${chunk}`;
                         if (isGroup) client.sendGroupMsg(groupId, chunk); else client.sendPrivateMsg(userId, chunk);
                         if (config.enableTTS && i === 0 && chunk.length < 100) {
                             const tts = chunk.replace(/\[CQ:.*?\]/g, "").trim();
                             if (tts) { if (isGroup) client.sendGroupMsg(groupId, `[CQ:tts,text=${tts}]`); else client.sendPrivateMsg(userId, `[CQ:tts,text=${tts}]`); }
                         }
                     }
                 };
                 if (payload.text) send(payload.text);
                 if (payload.files) {
                     for (const f of payload.files) { if (f.url) { if (isImageFile(f.url)) send(`[CQ:image,file=${f.url}]`); else send(`[CQ:file,file=${f.url},name=${f.name || 'file'}]`); } }
                 }
            };

            const { dispatcher, replyOptions } = runtime.channel.reply.createReplyDispatcherWithTyping({ deliver });

            let replyToBody = "";
            let replyToSender = "";
            if (replyMsgId && repliedMsg) {
                replyToBody = cleanCQCodes(typeof repliedMsg.message === 'string' ? repliedMsg.message : repliedMsg.raw_message || '');
                replyToSender = repliedMsg.sender?.nickname || repliedMsg.sender?.card || String(repliedMsg.sender?.user_id || '');
            }

            const replySuffix = replyToBody ? `\n\n[Replying to ${replyToSender || "unknown"}]\n${replyToBody}\n[/Replying]` : "";
            let bodyWithReply = cleanCQCodes(text) + replySuffix;
            let systemBlock = "";
            if (config.systemPrompt) systemBlock += `<system>${config.systemPrompt}</system>\n\n`;
            if (historyContext) systemBlock += `<history>\n${historyContext}\n</history>\n\n`;
            bodyWithReply = systemBlock + bodyWithReply;

            const ctxPayload = runtime.channel.reply.finalizeInboundContext({
                Provider: "qq", Channel: "qq", From: fromId, To: "qq:bot", Body: bodyWithReply, RawBody: text,
                SenderId: String(userId), SenderName: event.sender?.nickname || "Unknown", ConversationLabel: isGroup ? `QQ Group ${groupId}` : `QQ User ${userId}`,
                SessionKey: `qq:${fromId}`, AccountId: account.accountId, ChatType: isGroup ? "group" : "direct", Timestamp: event.time * 1000,
                OriginatingChannel: "qq", OriginatingTo: fromId, CommandAuthorized: true,
                ...(extractImageUrls(event.message).length > 0 && { MediaUrls: extractImageUrls(event.message) }),
                ...(replyMsgId && { ReplyToId: replyMsgId, ReplyToBody: replyToBody, ReplyToSender: replyToSender }),
            });
            
            await runtime.channel.session.recordInboundSession({
                storePath: runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: "default" }),
                sessionKey: ctxPayload.SessionKey!, ctx: ctxPayload,
                updateLastRoute: { sessionKey: ctxPayload.SessionKey!, channel: "qq", to: fromId, accountId: account.accountId },
                onRecordError: (err) => console.error("QQ Session Error:", err)
            });

            try { await runtime.channel.reply.dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
            } catch (error) { if (config.enableErrorNotify) deliver({ text: "⚠️ 服务调用失败，请稍后重试。" }); }
        });

        client.connect();
        return () => { client.disconnect(); clients.delete(account.accountId); };
    },
  },
  outbound: {
    sendText: async ({ to, text, accountId, replyTo }) => {
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
        const chunks = splitMessage(text, 4000);
        for (let i = 0; i < chunks.length; i++) {
            let message: OneBotMessage | string = chunks[i];
            if (replyTo && i === 0) message = [ { type: "reply", data: { id: String(replyTo) } }, { type: "text", data: { text: chunks[i] } } ];
            if (to.startsWith("group:")) client.sendGroupMsg(parseInt(to.replace("group:", ""), 10), message);
            else client.sendPrivateMsg(parseInt(to, 10), message);
        }
        return { channel: "qq", sent: true };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyTo }) => {
         const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
         if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
         const message: OneBotMessage = [];
         if (replyTo) message.push({ type: "reply", data: { id: String(replyTo) } });
         if (text) message.push({ type: "text", data: { text } });
         if (isImageFile(mediaUrl)) message.push({ type: "image", data: { file: mediaUrl } });
         else message.push({ type: "text", data: { text: `[CQ:file,file=${mediaUrl},url=${mediaUrl}]` } });
         if (to.startsWith("group:")) client.sendGroupMsg(parseInt(to.replace("group:", ""), 10), message);
         else client.sendPrivateMsg(parseInt(to, 10), message);
         return { channel: "qq", sent: true };
    },
    // @ts-ignore
    deleteMessage: async ({ messageId, accountId }) => {
        const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
        if (!client) return { channel: "qq", success: false, error: "Client not connected" };
        try { client.deleteMsg(messageId); return { channel: "qq", success: true }; }
        catch (err) { return { channel: "qq", success: false, error: String(err) }; }
    }
  },
  messaging: { normalizeTarget },
  setup: { resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) }
};
