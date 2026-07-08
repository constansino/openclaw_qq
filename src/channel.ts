import { promises as fs, constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

declare const process: any;
import {
    type ChannelPlugin,
    type ChannelAccountSnapshot,
    type ChannelSetupInput,
    type OpenClawConfig,
    buildChannelConfigSchema,
    type ReplyPayload,
    applyAccountNameToChannelSection,
    migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import { OneBotClient } from "./client.js";
import { QQConfigSchema, type QQConfig } from "./config.js";
import { getQQRuntime } from "./runtime.js";
import type { OneBotMessage, OneBotMessageSegment } from "./types.js";

export type ResolvedQQAccount = ChannelAccountSnapshot & {
    config: QQConfig;
    client?: OneBotClient;
};

interface PendingQQMsg {
    ctxPayload: any;
    runEpoch: number;
    executeDispatch: (mergedCtx: any, runState: { isStale: () => boolean }, abortSignal?: AbortSignal) => Promise<void>;
}

interface SessionQueue {
    pendingPayloads: PendingQQMsg[];
    timer: ReturnType<typeof setTimeout> | null;
    isProcessing: boolean;
    latestEpoch: number;
    activeEpoch: number;
}

type OneBotImageHint = {
    url: string;
    fileName?: string;
    mimeType?: string;
};

type InboundMediaEntry = {
    url?: string;
    path?: string;
    type?: string;
};

type QQInboundAttachmentHint = {
    kind: "file" | "audio" | "video";
    name: string;
    url?: string;
    localPath?: string;
    fileId?: string;
    busid?: string;
    size?: number;
    mimeType?: string;
};

type QQOutboundMediaItem = {
    url: string;
    name?: string;
    kind?: "image" | "audio" | "video" | "file";
};

type QQOutboundMediaAccess = {
    workspaceDir?: string;
    readFile?: (filePath: string) => Promise<Buffer>;
};

type QQOutboundMediaOptions = {
    mediaAccess?: QQOutboundMediaAccess;
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    mediaLocalRoots?: readonly string[] | "any";
    fileNameHint?: string;
    mediaKindHint?: "image" | "audio" | "video" | "file";
    forceDocument?: boolean;
    audioAsVoice?: boolean;
};

type QQInboundLinkPreview = {
    url: string;
    finalUrl?: string;
    host?: string;
    title?: string;
    description?: string;
    siteName?: string;
    text?: string;
    contentType?: string;
    status?: number;
    error?: string;
};

type QQSetupInput = ChannelSetupInput & {
    wsUrl?: string;
};

const sessionQueues = new Map<string, SessionQueue>();

type QQConversationContextKind = "group" | "guild" | "direct";
type QQConversationContextSource = "user" | "bot" | "system";

type QQConversationContextEntry = {
    messageId?: string;
    userId?: string;
    senderName?: string;
    source: QQConversationContextSource;
    text: string;
    timestampMs: number;
    recalled?: boolean;
    recalledAtMs?: number;
    operatorId?: string;
};

const qqConversationContextCache = new Map<string, QQConversationContextEntry[]>();
const QQ_CONVERSATION_CONTEXT_CACHE_LIMIT = 80;
const QQ_CONVERSATION_CONTEXT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function normalizeQQContextId(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text ? text : undefined;
}

function normalizeQQContextTimestampMs(value: unknown): number {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed < 1000000000000 ? parsed * 1000 : parsed;
    }
    return Date.now();
}

function buildQQConversationContextKey(params: {
    accountId: string;
    kind: QQConversationContextKind;
    groupId?: unknown;
    guildId?: unknown;
    channelId?: unknown;
    userId?: unknown;
}): string | null {
    const accountId = normalizeQQContextId(params.accountId) || DEFAULT_ACCOUNT_ID;
    if (params.kind === "group") {
        const groupId = normalizeQQContextId(params.groupId);
        return groupId ? `${accountId}:group:${groupId}` : null;
    }
    if (params.kind === "guild") {
        const guildId = normalizeQQContextId(params.guildId);
        const channelId = normalizeQQContextId(params.channelId);
        return guildId && channelId ? `${accountId}:guild:${guildId}:${channelId}` : null;
    }
    const userId = normalizeQQContextId(params.userId);
    return userId ? `${accountId}:direct:${userId}` : null;
}

function getQQConversationKind(params: { isGroup?: boolean; isGuild?: boolean }): QQConversationContextKind {
    if (params.isGroup) return "group";
    if (params.isGuild) return "guild";
    return "direct";
}

function compactQQContextText(value: unknown, maxChars = 700): string {
    const cleaned = cleanCQCodes(String(value || ""))
        .replace(/\s+/g, " ")
        .trim();
    return compactTextSnippet(cleaned, maxChars);
}

function pruneQQConversationContext(entries: QQConversationContextEntry[]): QQConversationContextEntry[] {
    const cutoff = Date.now() - QQ_CONVERSATION_CONTEXT_CACHE_TTL_MS;
    const recent = entries.filter((entry) => entry.timestampMs >= cutoff);
    const source = recent.length > 0 ? recent : entries;
    return source.slice(-QQ_CONVERSATION_CONTEXT_CACHE_LIMIT);
}

function rememberQQConversationMessage(params: {
    accountId: string;
    isGroup?: boolean;
    isGuild?: boolean;
    groupId?: unknown;
    guildId?: unknown;
    channelId?: unknown;
    userId?: unknown;
    senderName?: unknown;
    source?: QQConversationContextSource;
    text?: unknown;
    messageId?: unknown;
    timestampMs?: unknown;
    recalled?: boolean;
    recalledAtMs?: unknown;
    operatorId?: unknown;
}): void {
    const kind = getQQConversationKind(params);
    const key = buildQQConversationContextKey({
        accountId: params.accountId,
        kind,
        groupId: params.groupId,
        guildId: params.guildId,
        channelId: params.channelId,
        userId: params.userId,
    });
    if (!key) return;

    const text = compactQQContextText(params.text, 900);
    if (!text) return;

    const messageId = normalizeQQContextId(params.messageId);
    const nextEntry: QQConversationContextEntry = {
        ...(messageId ? { messageId } : {}),
        ...(normalizeQQContextId(params.userId) ? { userId: normalizeQQContextId(params.userId) } : {}),
        ...(normalizeQQContextId(params.senderName) ? { senderName: compactTextSnippet(String(params.senderName), 80) } : {}),
        source: params.source || "user",
        text,
        timestampMs: normalizeQQContextTimestampMs(params.timestampMs),
        ...(params.recalled ? { recalled: true } : {}),
        ...(params.recalledAtMs ? { recalledAtMs: normalizeQQContextTimestampMs(params.recalledAtMs) } : {}),
        ...(normalizeQQContextId(params.operatorId) ? { operatorId: normalizeQQContextId(params.operatorId) } : {}),
    };

    const entries = qqConversationContextCache.get(key) || [];
    if (messageId) {
        const existingIndex = entries.findIndex((entry) => entry.messageId === messageId);
        if (existingIndex >= 0) {
            const previous = entries[existingIndex]!;
            entries[existingIndex] = {
                ...previous,
                ...nextEntry,
                recalled: previous.recalled || nextEntry.recalled,
                recalledAtMs: previous.recalledAtMs || nextEntry.recalledAtMs,
                operatorId: nextEntry.operatorId || previous.operatorId,
            };
            qqConversationContextCache.set(key, pruneQQConversationContext(entries));
            return;
        }
    }

    entries.push(nextEntry);
    qqConversationContextCache.set(key, pruneQQConversationContext(entries));
}

function isQQRecallNotice(event: any): boolean {
    if (event?.post_type !== "notice") return false;
    const noticeType = String(event?.notice_type ?? "").toLowerCase();
    return [
        "group_recall",
        "friend_recall",
        "message_recall",
        "group_msg_recall",
        "friend_msg_recall",
    ].includes(noticeType);
}

function summarizeQQRecallNotice(event: any): string {
    const noticeType = String(event?.notice_type ?? "");
    const groupId = event?.group_id ?? "-";
    const userId = event?.user_id ?? "-";
    const operatorId = event?.operator_id ?? "-";
    const messageId = event?.message_id ?? event?.msg_id ?? "-";
    return `type=${noticeType} group=${groupId} user=${userId} operator=${operatorId} msg=${messageId}`;
}

function markQQConversationMessageRecalled(params: { accountId: string; event: any }): void {
    const messageId = normalizeQQContextId(params.event?.message_id ?? params.event?.msg_id);
    if (!messageId) return;

    const noticeType = String(params.event?.notice_type ?? "").toLowerCase();
    const isGroup = noticeType.includes("group") || params.event?.group_id !== undefined;
    const isGuild = params.event?.guild_id !== undefined || params.event?.channel_id !== undefined;
    const primaryKey = buildQQConversationContextKey({
        accountId: params.accountId,
        kind: getQQConversationKind({ isGroup, isGuild }),
        groupId: params.event?.group_id,
        guildId: params.event?.guild_id,
        channelId: params.event?.channel_id,
        userId: params.event?.user_id ?? params.event?.operator_id,
    });
    const candidateKeys = new Set<string>();
    if (primaryKey) candidateKeys.add(primaryKey);
    for (const [key, entries] of qqConversationContextCache.entries()) {
        if (!key.startsWith(`${params.accountId}:`)) continue;
        if (entries.some((entry) => entry.messageId === messageId)) candidateKeys.add(key);
    }

    const recalledAtMs = Date.now();
    const operatorId = normalizeQQContextId(params.event?.operator_id);
    let touched = false;
    for (const key of candidateKeys) {
        const entries = qqConversationContextCache.get(key);
        if (!entries) continue;
        let changed = false;
        for (const entry of entries) {
            if (entry.messageId !== messageId) continue;
            entry.recalled = true;
            entry.recalledAtMs = recalledAtMs;
            if (operatorId) entry.operatorId = operatorId;
            changed = true;
            touched = true;
        }
        if (changed) qqConversationContextCache.set(key, pruneQQConversationContext(entries));
    }

    if (!touched && primaryKey) {
        rememberQQConversationMessage({
            accountId: params.accountId,
            isGroup,
            isGuild,
            groupId: params.event?.group_id,
            guildId: params.event?.guild_id,
            channelId: params.event?.channel_id,
            userId: params.event?.user_id ?? params.event?.operator_id,
            senderName: params.event?.user_id ? `QQ ${params.event.user_id}` : "unknown",
            source: "user",
            text: "（撤回消息，内容未缓存）",
            messageId,
            timestampMs: recalledAtMs,
            recalled: true,
            recalledAtMs,
            operatorId,
        });
    }
}

function resolveQQConversationContextLimit(config: QQConfig): number {
    const raw = Number((config as any).conversationContextLimit ?? 10);
    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, Math.min(40, Math.floor(raw)));
}

function resolveQQConversationContextMaxChars(config: QQConfig): number {
    const raw = Number((config as any).conversationContextMaxChars ?? 2400);
    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, Math.min(10000, Math.floor(raw)));
}

function formatQQConversationContextTime(timestampMs: number): string {
    const date = new Date(normalizeQQContextTimestampMs(timestampMs));
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
}

function buildQQConversationContextBlock(params: {
    accountId: string;
    config: QQConfig;
    isGroup: boolean;
    isGuild: boolean;
    groupId?: unknown;
    guildId?: unknown;
    channelId?: unknown;
    userId?: unknown;
    currentMessageId?: unknown;
}): string {
    const limit = resolveQQConversationContextLimit(params.config);
    const maxChars = resolveQQConversationContextMaxChars(params.config);
    if (limit <= 0 || maxChars <= 0) return "";

    const key = buildQQConversationContextKey({
        accountId: params.accountId,
        kind: getQQConversationKind(params),
        groupId: params.groupId,
        guildId: params.guildId,
        channelId: params.channelId,
        userId: params.userId,
    });
    if (!key) return "";

    const currentMessageId = normalizeQQContextId(params.currentMessageId);
    const includeRecalled = (params.config as any).includeRecalledMessagesInContext !== false;
    const prunedEntries = pruneQQConversationContext(qqConversationContextCache.get(key) || []);
    qqConversationContextCache.set(key, prunedEntries);
    const entries = prunedEntries
        .filter((entry) => !currentMessageId || entry.messageId !== currentMessageId)
        .filter((entry) => includeRecalled || !entry.recalled);
    if (entries.length === 0) return "";

    const lines: string[] = [];
    let totalChars = 0;
    for (const entry of entries.slice(-limit).reverse()) {
        const text = sanitizeGroupHistoryLineForModel(entry.text);
        if (!text) continue;
        const timePart = formatQQConversationContextTime(entry.timestampMs);
        const msgPart = entry.messageId ? ` msg=${entry.messageId}` : "";
        const recalledPart = entry.recalled ? " [已撤回]" : "";
        const speaker = entry.source === "bot"
            ? "机器人"
            : `${compactTextSnippet(entry.senderName || "用户", 60)}${entry.userId ? `(${entry.userId})` : ""}`;
        const line = `[${timePart}${msgPart}] ${speaker}${recalledPart}: ${text}`;
        if (lines.length > 0 && totalChars + line.length + 1 > maxChars) break;
        lines.unshift(line);
        totalChars += line.length + 1;
    }
    if (lines.length === 0) return "";

    return [
        "<recent_qq_context>",
        "同一 QQ 会话最近消息，当前用户消息未重复列出；[已撤回] 表示消息后来被撤回，但内容来自收到时的缓存。",
        ...lines,
        "</recent_qq_context>",
        "",
    ].join("\n");
}

function buildQQLanguageConsistencyBlock(currentText: string): string {
    const text = normalizeInboundTextEntities(currentText || "");
    const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const latinCount = (text.match(/[A-Za-z]/g) || []).length;
    const preferredLanguage = cjkCount >= Math.max(2, latinCount) ? "中文" : latinCount > cjkCount ? "English" : "用户当前消息的主要语言";
    return [
        "<reply_language_policy>",
        `优先使用${preferredLanguage}回复。`,
        "保持整段回复语言一致；除非用户明确要求翻译、术语本身只能用英文，或代码/API/模型名必须保留原文，不要在中文和英文之间无故切换。",
        "</reply_language_policy>",
        "",
    ].join("\n");
}

function resolveDispatchTimeoutMs(config: QQConfig): number {
    const configured = Number((config as any).dispatchTimeoutMs ?? 180000);
    if (!Number.isFinite(configured)) return 180000;
    return Math.max(0, Math.trunc(configured));
}

async function drainSessionQueue(sessionKey: string, config: QQConfig, sendMessageFn: (msg: string) => void) {
    const q = sessionQueues.get(sessionKey);
    if (!q || q.isProcessing || q.pendingPayloads.length === 0) return;
    const interruptOnNewMessage = config.interruptOnNewMessage === true;

    q.isProcessing = true;
    const payloads = q.pendingPayloads;
    q.pendingPayloads = [];
    const runEpoch = payloads[payloads.length - 1]?.runEpoch ?? q.latestEpoch;
    q.activeEpoch = runEpoch;
    try {
        const mergedCtx = { ...payloads[0].ctxPayload };
        if (payloads.length > 1) {
            const mergeText = (key: string) => {
                if (payloads.some(p => typeof p.ctxPayload[key] === "string")) {
                    mergedCtx[key] = payloads.map((p, i) => {
                        const val = p.ctxPayload[key] || p.ctxPayload.Body || p.ctxPayload.RawBody || "";
                        return `[消息 ${i + 1}]: ${val}`;
                    }).join("\n\n");
                }
            };

            mergeText("Body");
            mergeText("RawBody");
            mergeText("BodyForAgent");
            mergeText("BodyForCommands");
            mergeText("CommandBody");

            const mergedMediaPayload = buildInboundMediaPayloadFromEntries(
                payloads.flatMap((p) => collectInboundMediaEntriesFromCtx(p.ctxPayload))
            );
            Object.assign(mergedCtx, mergedMediaPayload);

            if (config.enableQueueNotify !== false) {
                sendMessageFn(`[OpenClawQQ] 已合并 ${payloads.length} 条连续消息并开始处理。`);
            }
        }

        const runState = {
            isStale: () => {
                const state = sessionQueues.get(sessionKey);
                if (!state) return true;
                if (state.activeEpoch !== runEpoch) return true;
                return interruptOnNewMessage && state.latestEpoch !== runEpoch;
            },
        };
        const timeoutMs = resolveDispatchTimeoutMs(config);
        let timedOut = false;
        const abortController = new AbortController();
        const dispatchPromise = payloads[0].executeDispatch(mergedCtx, runState, abortController.signal).catch((err) => {
            if (timedOut) {
                console.error(`[QQ] stale dispatch failed after timeout session=${sessionKey}:`, err);
                return;
            }
            throw err;
        });

        if (timeoutMs > 0) {
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
            const timeoutPromise = new Promise<"timeout">((resolve) => {
                timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
            });
            const result = await Promise.race([
                dispatchPromise.then(() => "done" as const),
                timeoutPromise,
            ]);
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (result === "timeout") {
                timedOut = true;
                console.warn(`[QQ] dispatch timeout after ${timeoutMs}ms; aborting and releasing queue session=${sessionKey}`);
                abortController.abort();
                const abortGraceMs = 1500;
                const graceResult = await Promise.race([
                    dispatchPromise.then(() => "settled" as const),
                    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), abortGraceMs)),
                ]);
                if (graceResult === "timeout") {
                    console.warn(`[QQ] dispatch abort did not settle within ${abortGraceMs}ms session=${sessionKey}`);
                }
            }
        } else {
            await dispatchPromise;
        }

    } finally {
        q.isProcessing = false;
        q.activeEpoch = 0;
        if (q.pendingPayloads.length > 0 && !q.timer) {
            setTimeout(() => { void drainSessionQueue(sessionKey, config, sendMessageFn); }, 0);
        } else if (q.pendingPayloads.length === 0) {
            sessionQueues.delete(sessionKey);
        }
    }
}

function enqueueQQMessageForDispatch(sessionKey: string, msg: PendingQQMsg, config: QQConfig, sendMessageFn: (msg: string) => void) {
    let q = sessionQueues.get(sessionKey);
    if (!q) {
        q = { pendingPayloads: [], timer: null, isProcessing: false, latestEpoch: 0, activeEpoch: 0 };
        sessionQueues.set(sessionKey, q);
    }

    q.latestEpoch += 1;
    msg.runEpoch = q.latestEpoch;
    q.pendingPayloads.push(msg);

    if (config.interruptOnNewMessage === true && q.isProcessing && q.activeEpoch > 0) {
        if (config.enableQueueNotify !== false) {
            sendMessageFn("[OpenClawQQ] 检测到新消息，正在中断上一轮回复并切换到新请求。");
        }
    }

    if (q.timer) clearTimeout(q.timer);

    const configuredDebounceMs = Number(config.queueDebounceMs ?? 0);
    const debounceMs = Number.isFinite(configuredDebounceMs)
        ? Math.max(0, configuredDebounceMs)
        : 0;

    q.timer = setTimeout(() => {
        q!.timer = null;
        void drainSessionQueue(sessionKey, config, sendMessageFn);
    }, debounceMs);
}

const memberCache = new Map<string, { name: string, time: number }>();
const groupInfoCache = new Map<string, { name: string, time: number }>();
const execFile = promisify(execFileCallback);
const QQ_INBOUND_MEDIA_DIR = path.join(process.env.HOME || homedir(), ".openclaw", "media", "inbound", "qq");
const QQ_INBOUND_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const QQ_INBOUND_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const QQ_INBOUND_VIDEO_MAX_BYTES = 200 * 1024 * 1024;
const QQ_INBOUND_MEDIA_FETCH_TIMEOUT_MS = 5000;
const QQ_CONTEXT_FETCH_TIMEOUT_MS = 2500;
const QQ_HISTORY_FETCH_TIMEOUT_MS = 1500;
const QQ_GROUP_INFO_FETCH_TIMEOUT_MS = 1200;
const QQ_LAYER_CONTEXT_TIMEOUT_MS = 3000;
const QQ_LINK_PREVIEW_TIMEOUT_MS = 20000;
const QQ_LINK_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const QQ_LINK_PREVIEW_MAX_LINKS = 8;
const DEFAULT_QQ_IMAGE_MIME = "image/jpeg";
const DEFAULT_QQ_BINARY_MIME = "application/octet-stream";
const IMAGE_EXT_TO_MIME = new Map<string, string>([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".apng", "image/apng"],
    [".webp", "image/webp"],
    [".avif", "image/avif"],
    [".bmp", "image/bmp"],
    [".tif", "image/tiff"],
    [".tiff", "image/tiff"],
    [".heic", "image/heic"],
    [".heif", "image/heif"],
]);
const IMAGE_MIME_TO_EXT = new Map<string, string>([
    ["image/png", ".png"],
    ["image/jpeg", ".jpg"],
    ["image/gif", ".gif"],
    ["image/apng", ".apng"],
    ["image/webp", ".webp"],
    ["image/avif", ".avif"],
    ["image/bmp", ".bmp"],
    ["image/tiff", ".tiff"],
    ["image/heic", ".heic"],
    ["image/heif", ".heif"],
]);
const GENERIC_EXT_TO_MIME = new Map<string, string>([
    ...IMAGE_EXT_TO_MIME.entries(),
    [".amr", "audio/amr"],
    [".silk", "audio/silk"],
    [".wav", "audio/wav"],
    [".mp3", "audio/mpeg"],
    [".m4a", "audio/mp4"],
    [".ogg", "audio/ogg"],
    [".oga", "audio/ogg"],
    [".flac", "audio/flac"],
    [".aac", "audio/aac"],
    [".mp4", "video/mp4"],
    [".m4v", "video/mp4"],
    [".mov", "video/quicktime"],
    [".mkv", "video/x-matroska"],
    [".webm", "video/webm"],
    [".avi", "video/x-msvideo"],
    [".flv", "video/x-flv"],
    [".3gp", "video/3gpp"],
    [".pdf", "application/pdf"],
    [".txt", "text/plain"],
    [".md", "text/markdown"],
    [".csv", "text/csv"],
    [".json", "application/json"],
    [".zip", "application/zip"],
    [".doc", "application/msword"],
    [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [".xls", "application/vnd.ms-excel"],
    [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [".ppt", "application/vnd.ms-powerpoint"],
    [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
]);
const GENERIC_MIME_TO_EXT = new Map<string, string>([
    ...IMAGE_MIME_TO_EXT.entries(),
    ["audio/amr", ".amr"],
    ["audio/silk", ".silk"],
    ["audio/wav", ".wav"],
    ["audio/mpeg", ".mp3"],
    ["audio/mp4", ".m4a"],
    ["audio/ogg", ".ogg"],
    ["audio/flac", ".flac"],
    ["audio/aac", ".aac"],
    ["video/mp4", ".mp4"],
    ["video/quicktime", ".mov"],
    ["video/x-matroska", ".mkv"],
    ["video/webm", ".webm"],
    ["video/x-msvideo", ".avi"],
    ["video/x-flv", ".flv"],
    ["video/3gpp", ".3gp"],
    ["application/pdf", ".pdf"],
    ["text/plain", ".txt"],
    ["text/markdown", ".md"],
    ["text/csv", ".csv"],
    ["application/json", ".json"],
    ["application/zip", ".zip"],
    ["application/msword", ".doc"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
    ["application/vnd.ms-excel", ".xls"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
    ["application/vnd.ms-powerpoint", ".ppt"],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
]);

async function runModelSyncScript(): Promise<{ ok: boolean; text: string }> {
    const home = process.env.HOME || homedir();
    const candidates = [
        process.env.OPENCLAW_MODELSYNC_SCRIPT,
        path.join(home, ".openclaw", "workspace", "scripts", "sync_wuju_allowed_models.sh"),
    ].filter((v): v is string => Boolean(v && v.trim()));

    let scriptPath = "";
    for (const candidate of candidates) {
        try {
            await fs.access(candidate, fsConstants.X_OK);
            scriptPath = candidate;
            break;
        } catch { }
    }
    if (!scriptPath) {
        return { ok: false, text: "未找到可执行同步脚本。请确认 ~/.openclaw/workspace/scripts/sync_wuju_allowed_models.sh 存在并有执行权限。" };
    }

    try {
        const { stdout, stderr } = await execFile(scriptPath, [], {
            timeout: 180000,
            maxBuffer: 1024 * 1024 * 4,
            env: process.env,
        });
        const merged = [stdout, stderr].filter(Boolean).join("\n").trim();
        return { ok: true, text: merged || "模型同步完成。" };
    } catch (err: any) {
        const stdout = typeof err?.stdout === "string" ? err.stdout : "";
        const stderr = typeof err?.stderr === "string" ? err.stderr : "";
        const code = err?.code ?? "unknown";
        const merged = [stdout, stderr].filter(Boolean).join("\n").trim();
        const detail = merged ? `\n${merged}` : "";
        return { ok: false, text: `模型同步失败（code=${code}）。${detail}` };
    }
}

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

function getCachedGroupName(accountId: string, groupId: string): string | null {
    const key = `${accountId}:${groupId}`;
    const cached = groupInfoCache.get(key);
    if (cached && Date.now() - cached.time < 3600000) {
        return cached.name;
    }
    return null;
}

function setCachedGroupName(accountId: string, groupId: string, name: string) {
    groupInfoCache.set(`${accountId}:${groupId}`, { name, time: Date.now() });
}

function decodeOneBotCQValue(value: string): string {
    return value
        .replace(/&#44;/g, ",")
        .replace(/&#91;/g, "[")
        .replace(/&#93;/g, "]")
        .replace(/&amp;/g, "&");
}

function decodeHtmlEntities(value: string | undefined | null): string {
    if (!value) return "";
    return String(value)
        .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_match, name) => {
            const normalized = String(name).toLowerCase();
            if (normalized === "amp") return "&";
            if (normalized === "lt") return "<";
            if (normalized === "gt") return ">";
            if (normalized === "quot") return "\"";
            if (normalized === "apos") return "'";
            return " ";
        })
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
            const code = Number.parseInt(hex, 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
        })
        .replace(/&#(\d+);/g, (_match, raw) => {
            const code = Number.parseInt(raw, 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
        });
}

function normalizeInboundTextEntities(value: string | undefined | null): string {
    return decodeHtmlEntities(decodeOneBotCQValue(String(value || "")));
}

function compactTextSnippet(input: string | undefined | null, maxChars: number): string {
    const text = decodeHtmlEntities(String(input || ""))
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!text || maxChars <= 0) return "";
    return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
}

function trimLikelyUrl(input: string): string {
    let url = decodeHtmlEntities(input).trim();
    while (/[)\]\}>"'，。！？；：、]+$/u.test(url)) {
        url = url.slice(0, -1).trimEnd();
    }
    if (/[.,!?;:]$/u.test(url)) url = url.slice(0, -1).trimEnd();
    return url;
}

function extractHttpUrlsFromText(text: string | undefined | null, maxLinks = QQ_LINK_PREVIEW_MAX_LINKS): string[] {
    const decoded = normalizeInboundTextEntities(String(text || ""));
    const out: string[] = [];
    const seen = new Set<string>();
    const urlRegex = /https?:\/\/[^\s<>"'`]+/gi;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(decoded)) !== null) {
        const url = trimLikelyUrl(match[0]);
        if (!/^https?:\/\//i.test(url)) continue;
        try {
            new URL(url);
        } catch {
            continue;
        }
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
        if (out.length >= maxLinks) break;
    }
    return out;
}

function formatUrlForModel(url: string): string {
    try {
        const parsed = new URL(url);
        const pathValue = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
        const queryHint = parsed.search ? "?..." : "";
        return `${parsed.origin}${pathValue}${queryHint}`;
    } catch {
        return compactTextSnippet(url, 120);
    }
}

function replaceInboundLinksForModel(text: string, urls: string[]): string {
    let result = normalizeInboundTextEntities(text);
    urls.forEach((url, index) => {
        const marker = `[链接 ${index + 1}: ${formatUrlForModel(url)}]`;
        const encoded = url.replace(/&/g, "&amp;");
        result = result.split(url).join(marker);
        result = result.split(encoded).join(marker);
    });
    return result.replace(/\s+/g, " ").trim();
}

function sanitizeGroupHistoryLineForModel(line: string): string {
    let result = normalizeInboundTextEntities(line);
    const urls = extractHttpUrlsFromText(result, 20);
    if (urls.length > 0) result = replaceInboundLinksForModel(result, urls);
    return compactTextSnippet(
        result
            .replace(/sensitive_words_detected/gi, "provider_filter_error")
            .replace(/sensitive words detected/gi, "provider filter error")
            .replace(/敏感词汇|敏感词/g, "过滤词")
            .replace(/\s+/g, " ")
            .trim(),
        500,
    );
}

function extractHtmlAttr(tag: string, attr: string): string {
    const re = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
    const match = tag.match(re);
    return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function extractHtmlMeta(html: string, names: string[]): string {
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    const metaRegex = /<meta\b[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = metaRegex.exec(html)) !== null) {
        const tag = match[0];
        const key = (extractHtmlAttr(tag, "property") || extractHtmlAttr(tag, "name") || extractHtmlAttr(tag, "itemprop")).toLowerCase();
        if (!key || !wanted.has(key)) continue;
        const content = extractHtmlAttr(tag, "content");
        if (content) return compactTextSnippet(content, 500);
    }
    return "";
}

function extractHtmlTitle(html: string): string {
    const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    return compactTextSnippet(match?.[1] || "", 220);
}

function decodeJsStringFragment(input: string): string {
    return decodeHtmlEntities(input
        .replace(/\\x([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\\//g, "/")
        .replace(/\\"/g, "\"")
        .replace(/\\'/g, "'"));
}

function extractAssignedJsString(html: string, names: string[]): string {
    for (const name of names) {
        const re = new RegExp(`(?:var\\s+)?${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, "i");
        const match = html.match(re);
        if (match?.[2]) return compactTextSnippet(decodeJsStringFragment(match[2]), 500);
    }
    return "";
}

function stripHtmlToText(html: string, maxChars = 1600): string {
    const withoutNoise = html
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<(?:br|p|div|li|h[1-6]|section|article)\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " ");
    return compactTextSnippet(withoutNoise, maxChars);
}

function findDeepStringValues(value: unknown, keyPattern: RegExp, out: string[] = [], depth = 0): string[] {
    if (depth > 7 || value === null || value === undefined) return out;
    if (typeof value === "string") return out;
    if (Array.isArray(value)) {
        for (const item of value) findDeepStringValues(item, keyPattern, out, depth + 1);
        return out;
    }
    if (typeof value !== "object") return out;
    for (const [key, nextValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof nextValue === "string" && keyPattern.test(key)) {
            const text = compactTextSnippet(nextValue, 500);
            if (text) out.push(text);
        }
        findDeepStringValues(nextValue, keyPattern, out, depth + 1);
    }
    return out;
}

function collectDeepUrls(value: unknown, out: string[] = [], depth = 0): string[] {
    if (depth > 7 || value === null || value === undefined) return out;
    if (typeof value === "string") {
        out.push(...extractHttpUrlsFromText(value, QQ_LINK_PREVIEW_MAX_LINKS));
        return out;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectDeepUrls(item, out, depth + 1);
        return out;
    }
    if (typeof value !== "object") return out;
    for (const nextValue of Object.values(value as Record<string, unknown>)) {
        collectDeepUrls(nextValue, out, depth + 1);
    }
    return out;
}

function parseJsonLikePayload(raw: string): unknown | null {
    const decoded = normalizeInboundTextEntities(raw).trim();
    if (!decoded) return null;
    try {
        return JSON.parse(decoded);
    } catch { }
    const unescaped = decoded.replace(/\\"/g, "\"");
    try {
        return JSON.parse(unescaped);
    } catch {
        return null;
    }
}

function uniqueStrings(values: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function summarizeOneBotLinkPayload(type: string, attrs: Record<string, unknown>): { text: string; urls: string[] } {
    const normalizedType = String(type || "").toLowerCase();
    const rawPayload = String(
        attrs.data ?? attrs.content ?? attrs.text ?? attrs.json ?? attrs.xml ?? attrs.message ?? ""
    );
    const directStrings = [
        attrs.url,
        attrs.jumpUrl,
        attrs.jump_url,
        attrs.link,
        attrs.href,
        attrs.title,
        attrs.desc,
        attrs.description,
        attrs.content,
        attrs.text,
    ].filter((value): value is string => typeof value === "string");

    const parsed = rawPayload ? parseJsonLikePayload(rawPayload) : null;
    const deepUrls = parsed ? collectDeepUrls(parsed) : [];
    const rawUrls = extractHttpUrlsFromText(rawPayload);
    const directUrls = directStrings.flatMap((value) => extractHttpUrlsFromText(value));
    const urls = uniqueStrings([...directUrls, ...deepUrls, ...rawUrls]).slice(0, QQ_LINK_PREVIEW_MAX_LINKS);

    const titles = parsed
        ? findDeepStringValues(parsed, /^(title|name|prompt|summary)$/i)
        : [];
    const descriptions = parsed
        ? findDeepStringValues(parsed, /^(desc|description|digest|content|text)$/i)
        : [];
    for (const key of ["title", "name", "summary"]) {
        const value = attrs[key];
        if (typeof value === "string") titles.push(value);
    }
    for (const key of ["desc", "description", "content", "text"]) {
        const value = attrs[key];
        if (typeof value === "string") descriptions.push(value);
    }

    const title = compactTextSnippet(uniqueStrings(titles)[0] || "", 120);
    const desc = compactTextSnippet(uniqueStrings(descriptions).find((item) => item !== title) || "", 180);
    let fallbackText = "";
    if (!title && !desc && rawPayload && normalizedType !== "json") {
        fallbackText = compactTextSnippet(stripHtmlToText(rawPayload, 220), 220);
    }

    const label = normalizedType === "share" ? "分享链接" : "卡片链接";
    const parts = [title, desc || fallbackText].filter(Boolean);
    const urlHint = urls[0] ? ` ${urls[0]}` : "";
    const text = urls.length > 0 || parts.length > 0
        ? ` [${label}: ${parts.join(" - ")}${urlHint}]`
        : "";
    return { text, urls };
}

function summarizeOneBotLinkLikeSegment(segment: any): { text: string; urls: string[] } {
    const type = String(segment?.type || "").toLowerCase();
    const data = segment?.data && typeof segment.data === "object" ? segment.data : {};
    return summarizeOneBotLinkPayload(type, data);
}

async function readResponseTextLimited(resp: Response, maxBytes: number): Promise<string> {
    const body: any = (resp as any).body;
    if (!body || typeof body.getReader !== "function") {
        const text = await resp.text();
        return text.slice(0, maxBytes);
    }
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    let cancelled = false;
    try {
        while (total < maxBytes) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            const remaining = maxBytes - total;
            if (chunk.byteLength > remaining) {
                chunks.push(chunk.subarray(0, remaining));
                total += remaining;
                await reader.cancel().catch(() => undefined);
                cancelled = true;
                break;
            }
            chunks.push(chunk);
            total += chunk.byteLength;
        }
        if (!cancelled && total >= maxBytes) {
            await reader.cancel().catch(() => undefined);
            cancelled = true;
        }
    } finally {
        try { reader.releaseLock?.(); } catch { }
    }
    return Buffer.concat(chunks).toString("utf-8");
}

function parseHtmlLinkPreview(html: string): Pick<QQInboundLinkPreview, "title" | "description" | "siteName" | "text"> {
    const title = extractAssignedJsString(html, ["msg_title", "window.msg_title"])
        || extractHtmlMeta(html, ["og:title", "twitter:title", "title"])
        || extractHtmlTitle(html);
    const description = extractAssignedJsString(html, ["msg_desc", "window.msg_desc"])
        || extractHtmlMeta(html, ["og:description", "twitter:description", "description"]);
    const siteName = extractHtmlMeta(html, ["og:site_name", "application-name"]);
    const text = stripHtmlToText(html, 1600);
    return {
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(siteName ? { siteName } : {}),
        ...(text && text !== title && text !== description ? { text } : {}),
    };
}

async function fetchQQLinkPreview(url: string): Promise<QQInboundLinkPreview> {
    const normalizedUrl = trimLikelyUrl(url);
    let host = "";
    try {
        host = new URL(normalizedUrl).host;
    } catch {
        return { url: normalizedUrl, error: "invalid_url" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QQ_LINK_PREVIEW_TIMEOUT_MS);
    try {
        const resp = await fetch(normalizedUrl, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) OpenClawQQ/1.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
            },
        });
        const contentType = resp.headers.get("content-type") || "";
        const preview: QQInboundLinkPreview = {
            url: normalizedUrl,
            finalUrl: resp.url && resp.url !== normalizedUrl ? resp.url : undefined,
            host,
            status: resp.status,
            contentType,
        };
        if (!resp.ok) {
            return { ...preview, error: `HTTP ${resp.status}` };
        }
        if (!/(?:text\/html|application\/xhtml\+xml|text\/plain|application\/json|application\/xml)/i.test(contentType)) {
            return preview;
        }
        const body = await readResponseTextLimited(resp, QQ_LINK_PREVIEW_MAX_BYTES);
        if (/html|xml/i.test(contentType) || /<html|<title|<meta/i.test(body)) {
            return { ...preview, ...parseHtmlLinkPreview(body) };
        }
        return { ...preview, text: compactTextSnippet(body, 1600) };
    } catch (err) {
        return { url: normalizedUrl, host, error: String(err) };
    } finally {
        clearTimeout(timer);
    }
}

async function fetchQQLinkPreviews(urls: string[]): Promise<QQInboundLinkPreview[]> {
    const unique = uniqueStrings(urls).slice(0, QQ_LINK_PREVIEW_MAX_LINKS);
    if (unique.length === 0) return [];
    return await Promise.all(unique.map((url) => fetchQQLinkPreview(url)));
}

function buildInboundLinkContextBlock(previews: QQInboundLinkPreview[]): string {
    const useful = previews.filter((preview) => preview.url);
    if (useful.length === 0) return "";
    const lines = [
        "<links>",
        "The user sent link(s). Read the linked content before answering. Use the fetched content below first; if it is missing or insufficient, open/fetch the link again instead of answering from the URL alone.",
    ];
    useful.forEach((preview, index) => {
        const url = preview.finalUrl || preview.url;
        lines.push(`- [link ${index + 1}] url=${compactTextSnippet(url, 900)} host=${preview.host || ""}${preview.status ? ` status=${preview.status}` : ""}`);
        if (preview.title) lines.push(`  title=${preview.title}`);
        if (preview.description) lines.push(`  description=${preview.description}`);
        if (preview.siteName) lines.push(`  site=${preview.siteName}`);
        if (preview.text) lines.push(`  excerpt=${preview.text}`);
        if (preview.error && !preview.title && !preview.description && !preview.text) lines.push(`  preview_error=${preview.error}`);
    });
    lines.push("</links>");
    return `${lines.join("\n")}\n\n`;
}

function normalizeOneBotMediaUrlCandidate(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = normalizeInboundTextEntities(value).trim();
    if (!trimmed) return undefined;
    if (/^(?:https?:\/\/|base64:\/\/|file:)/i.test(trimmed)) return trimmed;
    if (trimmed.startsWith("/")) return `file://${trimmed}`;
    return undefined;
}

function parseOneBotCQAttributes(rawAttrs: string | undefined): Record<string, string> {
    const attrs: Record<string, string> = {};
    if (!rawAttrs) return attrs;
    for (const part of rawAttrs.split(",")) {
        const idx = part.indexOf("=");
        if (idx <= 0) continue;
        const key = part.slice(0, idx).trim();
        if (!key) continue;
        attrs[key] = decodeOneBotCQValue(part.slice(idx + 1));
    }
    return attrs;
}

function isImageLikeOneBotSegment(segment: any): boolean {
    const type = String(segment?.type || "").toLowerCase();
    return type === "image" ||
        type === "mface" ||
        type === "face" ||
        type === "emoji" ||
        type === "emoticon" ||
        type === "sticker" ||
        type === "marketface";
}

function readOneBotImageLikeUrl(segment: any): string | undefined {
    const data = segment?.data || {};
    return normalizeOneBotMediaUrlCandidate(data.url)
        ?? normalizeOneBotMediaUrlCandidate(data.file)
        ?? normalizeOneBotMediaUrlCandidate(data.path)
        ?? normalizeOneBotMediaUrlCandidate(data.image)
        ?? normalizeOneBotMediaUrlCandidate(data.imageUrl)
        ?? normalizeOneBotMediaUrlCandidate(data.image_url)
        ?? normalizeOneBotMediaUrlCandidate(data.preview)
        ?? normalizeOneBotMediaUrlCandidate(data.previewUrl)
        ?? normalizeOneBotMediaUrlCandidate(data.preview_url)
        ?? normalizeOneBotMediaUrlCandidate(data.thumb)
        ?? normalizeOneBotMediaUrlCandidate(data.thumbUrl)
        ?? normalizeOneBotMediaUrlCandidate(data.thumb_url);
}

function getOneBotImageLikeLabel(segment: any): string {
    const data = segment?.data || {};
    const raw = data.summary ?? data.text ?? data.name ?? data.emoji_name ?? data.face_name ?? data.id ?? data.emoji_id ?? data.file;
    const text = raw === undefined || raw === null ? "" : String(raw).trim();
    if (!text) return "表情";
    if (/^\[?表情\]?$/i.test(text)) return "表情";
    return text.replace(/^\[(.*)\]$/, "$1").trim() || "表情";
}

function extractTextualEmojiPlaceholders(input: string | undefined): string[] {
    if (!input) return [];
    const labels: string[] = [];
    const regex = /\[表情\](?:\/([^\s，。！？,.!?;；:：)）\]]+))?/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
        labels.push(match[1] ? `表情/${match[1]}` : "表情");
    }
    return labels;
}

function normalizeMimeTypeHint(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.split(";")[0]?.trim().toLowerCase();
    return trimmed || undefined;
}

function inferImageMimeType(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const local = toLocalPathIfAny(value) || value;
    const clean = local.split("?")[0].split("#")[0];
    const ext = path.extname(clean).toLowerCase();
    return IMAGE_EXT_TO_MIME.get(ext);
}

function inferImageExtension(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const local = toLocalPathIfAny(value) || value;
    const clean = local.split("?")[0].split("#")[0];
    const ext = path.extname(clean).toLowerCase();
    if (IMAGE_EXT_TO_MIME.has(ext)) return ext;
    return undefined;
}

function buildImageCachePath(sourceKey: string, extHint?: string): string {
    const digest = createHash("sha1").update(sourceKey).digest("hex");
    const ext = extHint && IMAGE_EXT_TO_MIME.has(extHint) ? extHint : ".img";
    return path.join(QQ_INBOUND_MEDIA_DIR, `${digest}${ext}`);
}

function inferGenericMimeType(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const local = toLocalPathIfAny(value) || value;
    const clean = local.split("?")[0].split("#")[0];
    const ext = path.extname(clean).toLowerCase();
    return GENERIC_EXT_TO_MIME.get(ext);
}

function inferGenericExtension(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const local = toLocalPathIfAny(value) || value;
    const clean = local.split("?")[0].split("#")[0];
    const ext = path.extname(clean).toLowerCase();
    return GENERIC_EXT_TO_MIME.has(ext) ? ext : undefined;
}

function buildAttachmentCachePath(sourceKey: string, extHint?: string): string {
    const digest = createHash("sha1").update(sourceKey).digest("hex");
    const ext = extHint || ".bin";
    return path.join(QQ_INBOUND_MEDIA_DIR, `${digest}${ext}`);
}

async function cacheInboundAttachmentLocally(
    url: string,
    meta?: { fileName?: string; mimeType?: string },
    maxBytes = QQ_INBOUND_ATTACHMENT_MAX_BYTES
): Promise<{ path: string; mimeType: string } | null> {
    const normalized = normalizeOneBotMediaUrlCandidate(url);
    if (!normalized) return null;

    const mimeTypeHint = normalizeMimeTypeHint(meta?.mimeType)
        ?? inferGenericMimeType(meta?.fileName)
        ?? inferGenericMimeType(normalized)
        ?? DEFAULT_QQ_BINARY_MIME;
    const extHint = inferGenericExtension(meta?.fileName)
        ?? inferGenericExtension(normalized)
        ?? GENERIC_MIME_TO_EXT.get(mimeTypeHint)
        ?? ".bin";
    const cacheKey = `${normalized}|${meta?.fileName || ""}|${mimeTypeHint}`;
    const cachedPath = buildAttachmentCachePath(cacheKey, extHint);

    try {
        await fs.access(cachedPath, fsConstants.R_OK);
        return { path: cachedPath, mimeType: mimeTypeHint };
    } catch { }

    await fs.mkdir(QQ_INBOUND_MEDIA_DIR, { recursive: true });

    const localPath = toLocalPathIfAny(normalized);
    if (localPath) {
        const stat = await fs.stat(localPath);
        if (stat.size > maxBytes) {
            throw new Error(`local attachment too large: ${stat.size}`);
        }
        await fs.copyFile(localPath, cachedPath);
        return {
            path: cachedPath,
            mimeType: inferGenericMimeType(localPath) ?? mimeTypeHint,
        };
    }

    if (/^base64:\/\//i.test(normalized)) {
        const buffer = Buffer.from(normalized.slice("base64://".length), "base64");
        if (buffer.byteLength > maxBytes) {
            throw new Error(`base64 attachment too large: ${buffer.byteLength}`);
        }
        await fs.writeFile(cachedPath, buffer);
        return { path: cachedPath, mimeType: mimeTypeHint };
    }

    if (!/^https?:\/\//i.test(normalized)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QQ_INBOUND_MEDIA_FETCH_TIMEOUT_MS);
    try {
        const resp = await fetch(normalized, {
            signal: controller.signal,
            headers: {
                "User-Agent": "OpenClawQQ/1.0",
            },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const contentLength = Number(resp.headers.get("content-length") || "0");
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            throw new Error(`remote attachment too large: ${contentLength}`);
        }

        const buffer = Buffer.from(await resp.arrayBuffer());
        if (buffer.byteLength > maxBytes) {
            throw new Error(`remote attachment too large after download: ${buffer.byteLength}`);
        }

        await fs.writeFile(cachedPath, buffer);
        return {
            path: cachedPath,
            mimeType: normalizeMimeTypeHint(resp.headers.get("content-type")) ?? mimeTypeHint,
        };
    } finally {
        clearTimeout(timer);
    }
}

function rememberImageHint(
    imageHints: string[],
    imageHintMeta: Map<string, { fileName?: string; mimeType?: string }>,
    hint: OneBotImageHint | undefined
) {
    const url = hint?.url?.trim();
    if (!url) return;
    if (!imageHints.includes(url)) imageHints.push(url);
    const current = imageHintMeta.get(url) ?? {};
    imageHintMeta.set(url, {
        fileName: current.fileName || hint?.fileName,
        mimeType: current.mimeType || hint?.mimeType,
    });
}

function extractImageHints(message: OneBotMessage | string | undefined, maxImages = 3): OneBotImageHint[] {
    const hints: OneBotImageHint[] = [];
    const seen = new Set<string>();

    const pushHint = (hint: OneBotImageHint | undefined) => {
        const url = hint?.url?.trim();
        if (!url || seen.has(url)) return;
        seen.add(url);
        hints.push(hint!);
    };

    if (Array.isArray(message)) {
        for (const segment of message) {
            if (!isImageLikeOneBotSegment(segment)) continue;
            const url = readOneBotImageLikeUrl(segment);
            if (!url) continue;
            const fileName = typeof segment.data?.file === "string" ? guessFileName(segment.data.file) : undefined;
            pushHint({
                url,
                fileName,
                mimeType: inferImageMimeType(fileName) ?? inferImageMimeType(url),
            });
            if (hints.length >= maxImages) break;
        }
    } else if (typeof message === "string") {
        const imageRegex = /\[CQ:(?:image|mface|emoji|emoticon|sticker|marketface),([^\]]+)\]/g;
        let match: RegExpExecArray | null;
        while ((match = imageRegex.exec(message)) !== null) {
            const attrs = parseOneBotCQAttributes(match[1]);
            const url = normalizeOneBotMediaUrlCandidate(attrs.url)
                ?? normalizeOneBotMediaUrlCandidate(attrs.file)
                ?? normalizeOneBotMediaUrlCandidate(attrs.path)
                ?? normalizeOneBotMediaUrlCandidate(attrs.image)
                ?? normalizeOneBotMediaUrlCandidate(attrs.imageUrl)
                ?? normalizeOneBotMediaUrlCandidate(attrs.image_url)
                ?? normalizeOneBotMediaUrlCandidate(attrs.preview)
                ?? normalizeOneBotMediaUrlCandidate(attrs.preview_url)
                ?? normalizeOneBotMediaUrlCandidate(attrs.thumb)
                ?? normalizeOneBotMediaUrlCandidate(attrs.thumb_url);
            if (!url) continue;
            const fileNameRaw = attrs.file ? guessFileName(attrs.file) : undefined;
            pushHint({
                url,
                fileName: fileNameRaw,
                mimeType: inferImageMimeType(fileNameRaw) ?? inferImageMimeType(url),
            });
            if (hints.length >= maxImages) break;
        }
    }

    return hints;
}

async function cacheOneBotImageLocally(
    url: string,
    meta?: { fileName?: string; mimeType?: string }
): Promise<{ path: string; mimeType: string } | null> {
    const normalized = normalizeOneBotMediaUrlCandidate(url);
    if (!normalized) return null;

    const mimeTypeHint = normalizeMimeTypeHint(meta?.mimeType)
        ?? inferImageMimeType(meta?.fileName)
        ?? inferImageMimeType(normalized)
        ?? DEFAULT_QQ_IMAGE_MIME;
    const extHint = inferImageExtension(meta?.fileName)
        ?? inferImageExtension(normalized)
        ?? IMAGE_MIME_TO_EXT.get(mimeTypeHint)
        ?? ".img";
    const cacheKey = `${normalized}|${meta?.fileName || ""}|${mimeTypeHint}`;
    const cachedPath = buildImageCachePath(cacheKey, extHint);

    try {
        await fs.access(cachedPath, fsConstants.R_OK);
        return { path: cachedPath, mimeType: mimeTypeHint };
    } catch { }

    await fs.mkdir(QQ_INBOUND_MEDIA_DIR, { recursive: true });

    const localPath = toLocalPathIfAny(normalized);
    if (localPath) {
        const stat = await fs.stat(localPath);
        if (stat.size > QQ_INBOUND_MEDIA_MAX_BYTES) {
            throw new Error(`local image too large: ${stat.size}`);
        }
        await fs.copyFile(localPath, cachedPath);
        return {
            path: cachedPath,
            mimeType: inferImageMimeType(localPath) ?? mimeTypeHint,
        };
    }

    if (/^base64:\/\//i.test(normalized)) {
        const buffer = Buffer.from(normalized.slice("base64://".length), "base64");
        if (buffer.byteLength > QQ_INBOUND_MEDIA_MAX_BYTES) {
            throw new Error(`base64 image too large: ${buffer.byteLength}`);
        }
        await fs.writeFile(cachedPath, buffer);
        return { path: cachedPath, mimeType: mimeTypeHint };
    }

    if (!/^https?:\/\//i.test(normalized)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QQ_INBOUND_MEDIA_FETCH_TIMEOUT_MS);
    try {
        const resp = await fetch(normalized, {
            signal: controller.signal,
            headers: {
                "User-Agent": "OpenClawQQ/1.0",
            },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const contentLength = Number(resp.headers.get("content-length") || "0");
        if (Number.isFinite(contentLength) && contentLength > QQ_INBOUND_MEDIA_MAX_BYTES) {
            throw new Error(`remote image too large: ${contentLength}`);
        }

        const buffer = Buffer.from(await resp.arrayBuffer());
        if (buffer.byteLength > QQ_INBOUND_MEDIA_MAX_BYTES) {
            throw new Error(`remote image too large after download: ${buffer.byteLength}`);
        }

        await fs.writeFile(cachedPath, buffer);
        return {
            path: cachedPath,
            mimeType: normalizeMimeTypeHint(resp.headers.get("content-type")) ?? mimeTypeHint,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function cacheImageHintsLocally(
    imageUrls: string[],
    imageHintMeta: Map<string, { fileName?: string; mimeType?: string }>
): Promise<{ entries: InboundMediaEntry[]; failures: Array<{ url: string; error: string }> }> {
    const entries: InboundMediaEntry[] = [];
    const failures: Array<{ url: string; error: string }> = [];

    const results = await Promise.all(imageUrls.map(async (url) => {
        const normalizedUrl = normalizeOneBotMediaUrlCandidate(url);
        if (!normalizedUrl) return null;
        const meta = imageHintMeta.get(normalizedUrl);
        const mimeTypeHint = normalizeMimeTypeHint(meta?.mimeType)
            ?? inferImageMimeType(meta?.fileName)
            ?? inferImageMimeType(normalizedUrl)
            ?? DEFAULT_QQ_IMAGE_MIME;
        try {
            const cached = await cacheOneBotImageLocally(normalizedUrl, meta);
            if (cached?.path) {
                return {
                    entry: {
                        url: normalizedUrl,
                        path: cached.path,
                        type: cached.mimeType || mimeTypeHint,
                    },
                };
            }
        } catch (err) {
            return {
                entry: {
                    url: normalizedUrl,
                    type: mimeTypeHint,
                },
                failure: { url: normalizedUrl, error: String(err) },
            };
        }
        return {
            entry: {
                url: normalizedUrl,
                type: mimeTypeHint,
            },
        };
    }));

    for (const result of results) {
        if (!result) continue;
        entries.push(result.entry);
        if (result.failure) failures.push(result.failure);
    }

    return { entries, failures };
}

function collectInboundMediaEntriesFromCtx(ctx: any): InboundMediaEntry[] {
    if (!ctx || typeof ctx !== "object") return [];
    const urls = Array.isArray(ctx.MediaUrls)
        ? ctx.MediaUrls
        : typeof ctx.MediaUrl === "string" && ctx.MediaUrl.trim()
            ? [ctx.MediaUrl]
            : [];
    const paths = Array.isArray(ctx.MediaPaths)
        ? ctx.MediaPaths
        : typeof ctx.MediaPath === "string" && ctx.MediaPath.trim()
            ? [ctx.MediaPath]
            : [];
    const types = Array.isArray(ctx.MediaTypes)
        ? ctx.MediaTypes
        : typeof ctx.MediaType === "string" && ctx.MediaType.trim()
            ? [ctx.MediaType]
            : [];

    const count = Math.max(urls.length, paths.length);
    const entries: InboundMediaEntry[] = [];
    for (let i = 0; i < count; i += 1) {
        const url = typeof urls[i] === "string" ? urls[i].trim() : "";
        const pathValue = typeof paths[i] === "string" ? paths[i].trim() : "";
        const type = typeof types[i] === "string" ? types[i].trim() : "";
        if (!url && !pathValue) continue;
        entries.push({
            ...(url ? { url } : {}),
            ...(pathValue ? { path: pathValue } : {}),
            type: type || DEFAULT_QQ_IMAGE_MIME,
        });
    }
    return entries;
}

function hasInboundImageLikeContent(ctx: any): boolean {
    if (!ctx || typeof ctx !== "object") return false;
    const mediaEntries = collectInboundMediaEntriesFromCtx(ctx);
    if (mediaEntries.some((entry) => {
        const type = String(entry.type || "").toLowerCase();
        if (type.startsWith("image/")) return true;
        const candidate = `${entry.url || ""} ${entry.path || ""}`.toLowerCase();
        return /\.(jpg|jpeg|png|gif|webp|apng|avif|bmp|heic|heif)(?:[?#\s]|$)/i.test(candidate);
    })) {
        return true;
    }

    const textFields = [
        ctx.Body,
        ctx.RawBody,
        ctx.BodyForAgent,
        ctx.BodyForCommands,
        ctx.CommandBody,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    const combined = textFields.join("\n");
    return /\[CQ:(?:image|mface|face|emoji|emoticon|sticker|marketface)[,\]]/i.test(combined) ||
        /\[(?:图片|表情|表情图片|qq_image|image)\b/i.test(combined) ||
        /qq_image\s+url=/i.test(combined);
}

function buildInboundMediaPayloadFromEntries(entries: InboundMediaEntry[]): Record<string, unknown> {
    if (!entries.length) return {};
    const unique: InboundMediaEntry[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        const url = entry.url?.trim();
        const pathValue = entry.path?.trim();
        if (!url && !pathValue) continue;
        const key = `${pathValue || ""}|${url || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({
            ...(url ? { url } : {}),
            ...(pathValue ? { path: pathValue } : {}),
            type: entry.type || DEFAULT_QQ_IMAGE_MIME,
        });
    }
    if (!unique.length) return {};

    const allHavePaths = unique.every((entry) => Boolean(entry.path));
    const mediaUrls = unique.map((entry) => entry.url || entry.path || "").filter(Boolean);
    const mediaTypes = unique.map((entry) => entry.type || DEFAULT_QQ_IMAGE_MIME);
    if (allHavePaths) {
        const mediaPaths = unique.map((entry) => entry.path!).filter(Boolean);
        return {
            MediaPath: mediaPaths[0],
            MediaUrl: mediaUrls[0] || mediaPaths[0],
            MediaType: mediaTypes[0],
            MediaPaths: mediaPaths,
            MediaUrls: mediaUrls.length === mediaPaths.length ? mediaUrls : mediaPaths,
            MediaTypes: mediaTypes,
        };
    }

    return {
        MediaUrl: mediaUrls[0],
        MediaType: mediaTypes[0],
        MediaUrls: mediaUrls,
        MediaTypes: mediaTypes,
    };
}

function parseOneBotFileSize(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
    return undefined;
}

function attachmentHintToInboundMediaEntry(hint: QQInboundAttachmentHint): InboundMediaEntry | null {
    const url = hint.url?.trim();
    const pathValue = hint.localPath?.trim();
    if (!url && !pathValue) return null;
    return {
        ...(url ? { url } : {}),
        ...(pathValue ? { path: pathValue } : {}),
        type: hint.mimeType || inferGenericMimeType(hint.name) || DEFAULT_QQ_BINARY_MIME,
    };
}

function collectAttachmentMediaEntries(hints: QQInboundAttachmentHint[], opts?: { includeFiles?: boolean }): InboundMediaEntry[] {
    const entries: InboundMediaEntry[] = [];
    for (const hint of hints) {
        // Generic QQ files (txt/pdf/zip/etc.) must stay metadata-only in Body.
        // If we put their local path into MediaPath, OpenClaw's runtime may auto-read
        // text-like files into the model context, which lets arbitrary file contents
        // pollute instructions. Users can still ask us to read local_path explicitly.
        if (hint.kind === "file" && opts?.includeFiles !== true) continue;
        const entry = attachmentHintToInboundMediaEntry(hint);
        if (entry) entries.push(entry);
    }
    return entries;
}

function rememberAttachmentHint(hints: QQInboundAttachmentHint[], hint: QQInboundAttachmentHint | null | undefined): void {
    if (!hint) return;
    const nextKey = `${hint.kind}|${hint.localPath || hint.url || hint.fileId || hint.name}`;
    if (hints.some((item) => `${item.kind}|${item.localPath || item.url || item.fileId || item.name}` === nextKey)) return;
    hints.push(hint);
}

function unwrapOneBotActionData(info: any): any {
    if (info && typeof info === "object" && info.data && typeof info.data === "object") return info.data;
    return info;
}

async function resolveOneBotFileUrl(
    client: OneBotClient,
    segment: any,
    opts?: { groupId?: number; userId?: number }
): Promise<string | undefined> {
    if (!segment || String(segment?.type || "").toLowerCase() !== "file") return undefined;

    const existing = normalizeOneBotMediaUrlCandidate(segment?.data?.url)
        ?? normalizeOneBotMediaUrlCandidate(segment?.data?.file);
    if (existing && /^https?:\/\//i.test(existing)) {
        if (!segment.data?.url) segment.data.url = existing;
        return existing;
    }

    const fileIdCandidate = segment?.data?.file_id ?? segment?.data?.fileUuid ?? segment?.data?.file_uuid;
    const fileId = fileIdCandidate !== undefined && fileIdCandidate !== null ? String(fileIdCandidate).trim() : "";
    if (!fileId) return existing;

    if (opts?.groupId !== undefined) {
        try {
            const info = unwrapOneBotActionData(await (client as any).sendWithResponse("get_group_file_url", {
                group_id: opts.groupId,
                file_id: fileId,
                ...(segment.data?.busid !== undefined ? { busid: segment.data.busid } : {}),
            }, QQ_CONTEXT_FETCH_TIMEOUT_MS));
            const resolved = normalizeOneBotMediaUrlCandidate(info?.url) ?? normalizeOneBotMediaUrlCandidate(info?.file);
            if (resolved) {
                segment.data.url = resolved;
                if (!segment.data.name && (info?.file_name || info?.name)) segment.data.name = info.file_name || info.name;
                return resolved;
            }
        } catch (err) {
            console.warn(`[QQ] Failed to resolve group file URL: ${String(err)}`);
        }
    }

    try {
        const info = unwrapOneBotActionData(await (client as any).sendWithResponse("get_private_file_url", {
            file_id: fileId,
            ...(opts?.userId !== undefined ? { user_id: opts.userId } : {}),
        }, QQ_CONTEXT_FETCH_TIMEOUT_MS));
        const resolved = normalizeOneBotMediaUrlCandidate(info?.url) ?? normalizeOneBotMediaUrlCandidate(info?.file);
        if (resolved) {
            segment.data.url = resolved;
            if (!segment.data.name && (info?.file_name || info?.name)) segment.data.name = info.file_name || info.name;
            return resolved;
        }
    } catch (err) {
        console.warn(`[QQ] Failed to resolve private file URL: ${String(err)}`);
    }

    return existing;
}

async function resolveOneBotImageUrl(client: OneBotClient, segment: any): Promise<string | undefined> {
    if (!segment || String(segment?.type || "").toLowerCase() !== "image") return undefined;

    const directUrl = normalizeOneBotMediaUrlCandidate(segment?.data?.url)
        ?? normalizeOneBotMediaUrlCandidate(segment?.data?.file);
    if (directUrl) {
        if (!segment?.data?.url) segment.data.url = directUrl;
        return directUrl;
    }

    const fileRef = typeof segment?.data?.file === "string" ? segment.data.file.trim() : "";
    if (!fileRef) return undefined;

    try {
        const info = await (client as any).sendWithResponse("get_image", { file: fileRef }, QQ_CONTEXT_FETCH_TIMEOUT_MS);
        const resolved = normalizeOneBotMediaUrlCandidate(info?.url) ?? normalizeOneBotMediaUrlCandidate(info?.file);
        if (resolved) {
            segment.data.url = resolved;
            return resolved;
        }
    } catch (err) {
        console.warn(`[QQ] Failed to resolve image URL via get_image: ${String(err)}`);
    }

    return undefined;
}

async function hydrateOneBotMessageMedia(
    client: OneBotClient,
    message: OneBotMessage | string | undefined,
    opts?: { groupId?: number; userId?: number }
): Promise<void> {
    if (!Array.isArray(message)) return;

    for (const segment of message as any[]) {
        const segType = String(segment?.type || "").toLowerCase();
        if (segType === "image") {
            await resolveOneBotImageUrl(client, segment);
            continue;
        }
        if (segType === "video" && !segment?.data?.url) {
            const resolved = normalizeOneBotMediaUrlCandidate(segment?.data?.file)
                ?? normalizeOneBotMediaUrlCandidate(segment?.data?.path);
            if (resolved) segment.data.url = resolved;
            continue;
        }
        if (segType === "file" && !segment?.data?.url) {
            await resolveOneBotFileUrl(client, segment, opts);
        }
    }
}

async function collectFileHintFromOneBotSegment(
    client: OneBotClient,
    segment: any,
    opts?: { groupId?: number; userId?: number }
): Promise<QQInboundAttachmentHint | null> {
    if (!segment || String(segment?.type || "").toLowerCase() !== "file") return null;

    if (!segment.data?.url) await resolveOneBotFileUrl(client, segment, opts);

    const fileName = segment.data?.name || segment.data?.file_name || segment.data?.file || "未命名";
    const fileId = segment.data?.file_id ? String(segment.data.file_id) : undefined;
    const busid = segment.data?.busid !== undefined ? String(segment.data.busid) : undefined;
    const fileUrl = typeof segment.data?.url === "string" ? segment.data.url : undefined;
    const parsedSize = parseOneBotFileSize(segment.data?.file_size);
    let mimeType = inferGenericMimeType(fileName) ?? DEFAULT_QQ_BINARY_MIME;
    let localPath: string | undefined;
    if (fileUrl) {
        try {
            const cached = await cacheInboundAttachmentLocally(fileUrl, { fileName, mimeType });
            if (cached?.path) {
                localPath = cached.path;
                mimeType = cached.mimeType || mimeType;
            }
        } catch (err) {
            console.warn(`[QQ] Failed to cache inbound file: ${String(err)}`);
        }
    }

    return {
        kind: "file",
        name: fileName,
        ...(fileUrl ? { url: fileUrl } : {}),
        ...(localPath ? { localPath } : {}),
        ...(fileId ? { fileId } : {}),
        ...(busid ? { busid } : {}),
        ...(parsedSize !== undefined ? { size: parsedSize } : {}),
        ...(mimeType ? { mimeType } : {}),
    };
}

async function collectVideoHintFromOneBotSegment(segment: any): Promise<QQInboundAttachmentHint | null> {
    if (!segment || String(segment?.type || "").toLowerCase() !== "video") return null;

    const candidates = [
        normalizeOneBotMediaUrlCandidate(segment.data?.url),
        normalizeOneBotMediaUrlCandidate(segment.data?.file),
        normalizeOneBotMediaUrlCandidate(segment.data?.path),
    ].filter((value): value is string => Boolean(value));
    const videoUrl = candidates.find((value) => /^https?:\/\//i.test(value) || /^base64:\/\//i.test(value) || /^file:\/\//i.test(value));
    const fileName = guessFileName(
        typeof segment.data?.name === "string"
            ? segment.data.name
            : typeof segment.data?.file === "string"
                ? segment.data.file
                : typeof segment.data?.path === "string"
                    ? segment.data.path
                    : videoUrl || "video.mp4"
    );
    const parsedSize = parseOneBotFileSize(segment.data?.file_size);
    let mimeType = inferGenericMimeType(fileName) ?? inferGenericMimeType(videoUrl) ?? "video/mp4";
    let localPath: string | undefined;

    if (videoUrl) {
        try {
            const cached = await cacheInboundAttachmentLocally(videoUrl, { fileName, mimeType }, QQ_INBOUND_VIDEO_MAX_BYTES);
            if (cached?.path) {
                localPath = cached.path;
                mimeType = cached.mimeType || mimeType;
            }
        } catch (err) {
            console.warn(`[QQ] Failed to cache inbound video: ${String(err)}`);
        }
    }

    return {
        kind: "video",
        name: fileName,
        ...(videoUrl ? { url: videoUrl } : {}),
        ...(localPath ? { localPath } : {}),
        ...(parsedSize !== undefined ? { size: parsedSize } : {}),
        ...(mimeType ? { mimeType } : {}),
    };
}

async function collectAudioHintFromOneBotSegment(segment: any): Promise<QQInboundAttachmentHint | null> {
    if (!segment || String(segment?.type || "").toLowerCase() !== "record") return null;

    const candidates = [
        normalizeOneBotMediaUrlCandidate(segment.data?.url),
        normalizeOneBotMediaUrlCandidate(segment.data?.file),
        normalizeOneBotMediaUrlCandidate(segment.data?.path),
    ].filter((value): value is string => Boolean(value));
    const audioUrl = candidates.find((value) => /^https?:\/\//i.test(value) || /^base64:\/\//i.test(value) || (/^file:\/\//i.test(value) && !/^file:\/\/\/app\//i.test(value)));
    const fileName = guessFileName(
        typeof segment.data?.file === "string"
            ? segment.data.file
            : typeof segment.data?.path === "string"
                ? segment.data.path
                : audioUrl || "voice.amr"
    );
    const parsedSize = parseOneBotFileSize(segment.data?.file_size);
    let mimeType = inferGenericMimeType(fileName) ?? "audio/amr";
    let localPath: string | undefined;
    if (audioUrl) {
        try {
            const cached = await cacheInboundAttachmentLocally(audioUrl, { fileName, mimeType });
            if (cached?.path) {
                localPath = cached.path;
                mimeType = cached.mimeType || mimeType;
            }
        } catch (err) {
            console.warn(`[QQ] Failed to cache inbound audio: ${String(err)}`);
        }
    }

    return {
        kind: "audio",
        name: fileName,
        ...(audioUrl ? { url: audioUrl } : {}),
        ...(localPath ? { localPath } : {}),
        ...(parsedSize !== undefined ? { size: parsedSize } : {}),
        ...(mimeType ? { mimeType } : {}),
    };
}

function extractImageUrls(message: OneBotMessage | string | undefined, maxImages = 3): string[] {
    return extractImageHints(message, maxImages).map((hint) => hint.url);
}

function cleanCQCodes(text: string | undefined): string {
    if (!text) return "";

    let result = normalizeInboundTextEntities(text);
    const imageUrls: string[] = [];

    // Match both url= and file= if they look like URLs
    const imageRegex = /\[CQ:(?:image|mface|emoji|emoticon|sticker|marketface),([^\]]+)\]/g;
    let match;
    while ((match = imageRegex.exec(result)) !== null) {
        const attrs = parseOneBotCQAttributes(match[1]);
        const val = normalizeOneBotMediaUrlCandidate(attrs.url)
            ?? normalizeOneBotMediaUrlCandidate(attrs.file)
            ?? normalizeOneBotMediaUrlCandidate(attrs.path)
            ?? normalizeOneBotMediaUrlCandidate(attrs.image)
            ?? normalizeOneBotMediaUrlCandidate(attrs.imageUrl)
            ?? normalizeOneBotMediaUrlCandidate(attrs.image_url)
            ?? normalizeOneBotMediaUrlCandidate(attrs.preview)
            ?? normalizeOneBotMediaUrlCandidate(attrs.preview_url)
            ?? normalizeOneBotMediaUrlCandidate(attrs.thumb)
            ?? normalizeOneBotMediaUrlCandidate(attrs.thumb_url);
        if (val) {
            imageUrls.push(val);
        }
    }

    result = result.replace(/\[CQ:face,id=(\d+)\]/g, "[表情]");
    result = result.replace(/\[CQ:(?:mface|emoji|emoticon|sticker|marketface),([^\]]+)\]/g, (match, rawAttrs) => {
        const attrs = parseOneBotCQAttributes(rawAttrs);
        const label = attrs.summary || attrs.text || attrs.name || attrs.id || "表情";
        return `[表情:${label}]`;
    });
    result = result.replace(/\[CQ:(json|xml|share),([^\]]+)\]/g, (_match, type, rawAttrs) => {
        const attrs = parseOneBotCQAttributes(rawAttrs);
        const summary = summarizeOneBotLinkPayload(type, attrs);
        return summary.text || "[卡片消息]";
    });

    result = result.replace(/\[CQ:[^\]]+\]/g, (match) => {
        if (match.startsWith("[CQ:image")) {
            return "[图片]";
        }
        if (match.startsWith("[CQ:video")) {
            return "[视频]";
        }
        if (match.startsWith("[CQ:record")) {
            return "[语音]";
        }
        if (match.startsWith("[CQ:file")) {
            const nameMatch = match.match(/(?:^|,)(?:name|file)=([^,\]]+)/);
            const name = nameMatch?.[1] ? nameMatch[1].replace(/&amp;/g, "&") : "文件";
            return `[文件:${name}]`;
        }
        return "";
    });

    result = result.replace(/\s+/g, " ").trim();

    if (imageUrls.length > 0) {
        result = result ? `${result} [图片: ${imageUrls.join(", ")}]` : `[图片: ${imageUrls.join(", ")}]`;
    }

    return result;
}

function splitLongText(input: string, maxLength = 2800): string[] {
    const text = (input || "").trim();
    if (!text) return [];
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > maxLength) {
        let cut = rest.lastIndexOf("\n", maxLength);
        if (cut < Math.floor(maxLength * 0.5)) cut = maxLength;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
    }
    if (rest) chunks.push(rest);
    return chunks;
}

async function grokDrawDirect(prompt: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const p = (prompt || "").trim();
    if (!p) return { ok: false, error: "缺少提示词。用法: /grok_draw <提示词>" };

    const baseUrl = (process.env.GROK2API_BASE_URL || "http://127.0.0.1:18001/v1").replace(/\/+$/, "");
    const apiKey = process.env.GROK2API_KEY || "grok2api";

    try {
        const resp = await fetch(`${baseUrl}/images/generations`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "grok-imagine-1.0",
                prompt: p,
                n: 1,
                size: "1024x1024",
            }),
        });

        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            return { ok: false, error: `Grok API 错误: HTTP ${resp.status}${text ? ` | ${text.slice(0, 300)}` : ""}` };
        }

        const data = await resp.json().catch(() => null) as any;
        const url = typeof data?.data?.[0]?.url === "string" ? data.data[0].url.trim() : "";
        if (!url) return { ok: false, error: "Grok 返回中没有图片 URL" };
        return { ok: true, url };
    } catch (err) {
        return { ok: false, error: `调用 Grok 失败: ${String(err)}` };
    }
}

function buildQQReplyConfig(cfg: OpenClawConfig, config: QQConfig): OpenClawConfig {
    const blockStreaming = config.blockStreaming ?? true;
    const blockStreamingBreak = config.blockStreamingBreak ?? "message_end";

    return {
        ...cfg,
        agents: {
            ...cfg.agents,
            defaults: {
                ...cfg.agents?.defaults,
                blockStreamingDefault: blockStreaming ? "on" : "off",
                blockStreamingBreak,
            },
        },
        channels: {
            ...cfg.channels,
            qq: {
                ...((cfg.channels?.qq as Record<string, unknown> | undefined) ?? {}),
                blockStreaming,
            },
        },
    };
}

function buildModelProbeUrls(rawBaseUrl: string): string[] {
    const out: string[] = [];
    const baseUrl = (rawBaseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl) return out;
    out.push(`${baseUrl}/models`);
    try {
        const url = new URL(baseUrl);
        const origin = url.origin;
        const path = url.pathname.replace(/\/+$/, "");
        out.push(`${origin}/v1/models`);
        if (/\/codex\/v1$/i.test(path)) out.push(`${origin}${path.replace(/\/codex\/v1$/i, "/v1")}/models`);
        if (/\/v1$/i.test(path)) out.push(`${origin}${path}/models`);
    } catch { }
    return [...new Set(out)];
}

async function fetchProviderModelIdsDynamic(baseUrl: string, apiKey?: string): Promise<{ ids: string[]; source: string } | null> {
    const probeUrls = buildModelProbeUrls(baseUrl);
    for (const url of probeUrls) {
        try {
            const headers: Record<string, string> = {};
            if (apiKey && apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
            const resp = await fetch(url, { method: "GET", headers });
            if (!resp.ok) continue;
            const text = await resp.text();
            const data = JSON.parse(text) as any;
            const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
            const ids: string[] = arr
                .map((item: any) => (typeof item?.id === "string" ? item.id.trim() : ""))
                .filter((id: string) => Boolean(id));
            if (ids.length > 0) {
                const uniqueIds: string[] = [];
                for (const id of ids) {
                    if (!uniqueIds.includes(id)) uniqueIds.push(id);
                }
                return { ids: uniqueIds, source: url };
            }
        } catch { }
    }
    return null;
}

async function buildModelCatalogText(enableDynamicLookup: boolean): Promise<string> {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const candidates = [
        process.env.OPENCLAW_CONFIG,
        process.env.OPENCLAW_CONFIG_PATH,
        home ? path.join(home, ".openclaw", "openclaw.json") : "",
    ].filter((value): value is string => Boolean(value && value.trim()));

    let parsed: any = null;
    let usedPath = "";
    for (const cfgPath of candidates) {
        try {
            const raw = await fs.readFile(cfgPath, "utf-8");
            parsed = JSON.parse(raw);
            usedPath = cfgPath;
            break;
        } catch { }
    }

    if (!parsed) {
        return "[OpenClawd QQ]\n无法读取模型配置文件。请在服务器执行：openclaw status";
    }

    const providers = parsed?.models?.providers as Record<string, any> | undefined;
    const currentModel = shortenVisibleModelRefs(
        (typeof parsed?.agents?.defaults?.model?.primary === "string" && parsed.agents.defaults.model.primary.trim())
        || (typeof parsed?.agent?.model === "string" && parsed.agent.model.trim())
        || "unknown"
    );
    if (!providers || typeof providers !== "object") {
        return `[OpenClawd QQ]\nCurrent: ${currentModel}\n未找到 models.providers 配置。`;
    }

    const lines: string[] = [`[OpenClawd QQ]`, `Current: ${currentModel}`, `Providers:`];
    let index = 1;
    for (const [providerName, providerValue] of Object.entries(providers)) {
        const cfgModels = Array.isArray((providerValue as any)?.models) ? (providerValue as any).models : [];
        const cfgModelIds = cfgModels
            .map((model: any) => (typeof model?.id === "string" ? model.id.trim() : ""))
            .filter((id: string) => Boolean(id));
        const baseUrl = typeof (providerValue as any)?.baseUrl === "string" ? (providerValue as any).baseUrl.trim() : "";
        const apiKey = typeof (providerValue as any)?.apiKey === "string" ? (providerValue as any).apiKey : "";
        const dynamic = enableDynamicLookup && baseUrl ? await fetchProviderModelIdsDynamic(baseUrl, apiKey) : null;
        const modelIds = dynamic?.ids ?? cfgModelIds;
        const source = dynamic ? `dynamic: ${dynamic.source}` : "config";
        lines.push(`- ${providerName} (${modelIds.length}) [${source}]`);
        for (const modelId of modelIds) {
            lines.push(`  ${index}. ${shortenVisibleModelRefs(`${providerName}/${modelId}`)}`);
            index += 1;
        }
    }
    lines.push(`Config: ${usedPath}`);
    return lines.join("\n");
}


function getReplyMessageId(message: OneBotMessage | string | undefined, rawMessage?: string, extra?: any): string | null {
    if (message && typeof message !== "string") {
        for (const segment of message as any[]) {
            const segType = String(segment?.type || "").toLowerCase();
            if (segType !== "reply") continue;
            const idCandidate = segment?.data?.id ?? segment?.data?.message_id ?? segment?.data?.reply;
            const id = typeof idCandidate === "number" ? String(idCandidate) : String(idCandidate || "").trim();
            if (id && /^-?\d+$/.test(id)) return id;
        }
    }
    if (rawMessage) {
        const match = rawMessage.match(/\[CQ:reply,id=(\d+)\]/);
        if (match) return match[1];
    }
    const candidates = [
        extra?.reply?.message_id,
        extra?.reply?.id,
        extra?.source?.message_id,
        extra?.source?.id,
        extra?.quoted_message_id,
        extra?.quote_id,
    ];
    for (const c of candidates) {
        const id = typeof c === "number" ? String(c) : (typeof c === "string" ? c.trim() : "");
        if (id && /^-?\d+$/.test(id)) return id;
    }
    return null;
}

type LayerSegmentContext = {
    text: string;
    images: string[];
    files: Array<{ name: string; url?: string; fileId?: string; busid?: string; size?: number }>;
};

function oneBotPayloadData(payload: any): any {
    if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") return payload.data;
    return payload;
}

function extractMessageLikeFromPayload(payload: any): OneBotMessage | string | undefined {
    const data = oneBotPayloadData(payload);
    const candidates = [data?.message, data?.content, data?.raw_message, data?.rawMessage];
    for (const c of candidates) {
        if (Array.isArray(c) || typeof c === "string") return c as any;
    }
    return undefined;
}

function extractForwardNodeList(payload: any): any[] {
    const data = oneBotPayloadData(payload);
    if (Array.isArray(data)) return data;
    const nodes = data?.messages ?? data?.message ?? data?.nodes ?? data?.nodeList;
    return Array.isArray(nodes) ? nodes : [];
}

function forwardNodeData(node: any): any {
    if (node && typeof node === "object" && node.data && typeof node.data === "object") return node.data;
    return node;
}

function getForwardNodeSenderName(node: any): string {
    const data = forwardNodeData(node);
    return data?.sender?.nickname ||
        data?.sender?.card ||
        data?.sender?.user_id ||
        data?.nickname ||
        data?.name ||
        data?.user_id ||
        data?.uin ||
        "unknown";
}

function getForwardNodeContent(node: any): OneBotMessage | string | undefined {
    const data = forwardNodeData(node);
    const candidates = [
        data?.message,
        data?.content,
        data?.raw_message,
        data?.rawMessage,
        data?.message_obj?.message,
        data?.messageObj?.message,
    ];
    for (const candidate of candidates) {
        if (Array.isArray(candidate) || typeof candidate === "string") return candidate as any;
    }
    return undefined;
}

function getForwardNodeRawMessage(node: any): string | undefined {
    const data = forwardNodeData(node);
    const raw = data?.raw_message ?? data?.rawMessage;
    return typeof raw === "string" ? raw : undefined;
}

function truncateWithEllipsis(text: string, maxChars: number): string {
    if (maxChars <= 0) return "";
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function collectForwardIdsFromMessage(message: OneBotMessage | string | undefined): string[] {
    const ids: string[] = [];
    if (Array.isArray(message)) {
        for (const seg of message as any[]) {
            const segType = String(seg?.type || "").toLowerCase();
            if (!["forward", "forward_msg", "nodes"].includes(segType)) continue;
            const fid = seg?.data?.id ?? seg?.data?.message_id ?? seg?.data?.forward_id;
            if (fid !== undefined && fid !== null) ids.push(String(fid).trim());
        }
    } else if (typeof message === "string" && message) {
        const patterns = [
            /\[CQ:forward,id=([^,\]]+)\]/g,
            /\[CQ:forward_msg,id=([^,\]]+)\]/g,
            /\[CQ:forward,message_id=([^,\]]+)\]/g,
            /\[CQ:nodes,id=([^,\]]+)\]/g,
        ];
        for (const re of patterns) {
            let m: RegExpExecArray | null;
            while ((m = re.exec(message)) !== null) {
                if (m[1]) ids.push(String(m[1]).trim());
            }
        }
    }
    return ids.filter(Boolean);
}

function collectForwardIdsFromCandidates(...messages: Array<OneBotMessage | string | undefined>): string[] {
    const unique = new Set<string>();
    const orderedMessages = [
        ...messages.filter((message) => typeof message === "string"),
        ...messages.filter((message) => typeof message !== "string"),
    ];
    for (const message of orderedMessages) {
        for (const id of collectForwardIdsFromMessage(message)) {
            unique.add(id);
        }
    }
    return Array.from(unique);
}

function summarizeOneBotSegments(message: OneBotMessage | string | undefined, maxChars: number): LayerSegmentContext {
    const images = extractImageUrls(message, 5);
    const files: Array<{ name: string; url?: string; fileId?: string; busid?: string; size?: number }> = [];
    let text = "";
    if (typeof message === "string") {
        text = cleanCQCodes(message);
    } else if (Array.isArray(message)) {
        for (const seg of message) {
            if (seg.type === "text") text += normalizeInboundTextEntities(seg.data?.text || "");
            else if (seg.type === "at") text += `@${seg.data?.qq || "unknown"}`;
            else if (seg.type === "record") text += ` [语音${seg.data?.text ? `:${seg.data.text}` : ""}]`;
            else if (seg.type === "image") text += " [图片]";
            else if (seg.type === "video") text += seg.data?.url ? ` [视频:${seg.data.url}]` : " [视频]";
            else if (seg.type === "json" || seg.type === "xml" || seg.type === "share") {
                const cardSummary = summarizeOneBotLinkLikeSegment(seg);
                text += cardSummary.text || " [卡片]";
            }
            else if (seg.type === "file") {
                const fileName = seg.data?.name || seg.data?.file || "未命名";
                text += ` [文件:${fileName}]`;
                files.push({
                    name: fileName,
                    ...(typeof seg.data?.url === "string" ? { url: seg.data.url } : {}),
                    ...(seg.data?.file_id ? { fileId: String(seg.data.file_id) } : {}),
                    ...(seg.data?.busid !== undefined ? { busid: String(seg.data.busid) } : {}),
                    ...(parseOneBotFileSize(seg.data?.file_size) !== undefined ? { size: parseOneBotFileSize(seg.data?.file_size)! } : {}),
                });
            } else if (seg.type === "forward" && seg.data?.id) {
                text += ` [转发:${seg.data.id}]`;
            } else if (seg.type === "reply" && seg.data?.id) {
                text += ` [引用:${seg.data.id}]`;
            }
        }
        text = cleanCQCodes(text);
    }
    return { text: truncateWithEllipsis(text, maxChars), images, files };
}

async function buildReplyForwardContextBlock(opts: {
    client: OneBotClient;
    rootEvent: any;
    repliedMsg: any;
    cfg: QQConfig;
}): Promise<{ block: string; imageUrls: string[] }> {
    const { client, rootEvent, repliedMsg, cfg } = opts;
    if (cfg.enrichReplyForwardContext === false) return { block: "", imageUrls: [] };
    const debugLayerTrace = cfg.debugLayerTrace === true;

    const maxReplyLayers = Math.max(0, Math.trunc(cfg.maxReplyLayers ?? 5));
    const maxForwardLayers = Math.max(0, Math.trunc(cfg.maxForwardLayers ?? 5));
    const maxForwardMessagesPerLayer = Math.max(1, Math.trunc(cfg.maxForwardMessagesPerLayer ?? 8));
    const maxCharsPerLayer = Math.max(100, Math.trunc(cfg.maxCharsPerLayer ?? 900));
    const maxTotalContextChars = Math.max(300, Math.trunc(cfg.maxTotalContextChars ?? 3000));
    const includeSenderInLayers = cfg.includeSenderInLayers !== false;
    const includeCurrentOutline = cfg.includeCurrentOutline !== false;

    const lines: string[] = [];
    const layeredImages = new Set<string>();
    let usedChars = 0;
    const pushLine = (line: string) => {
        if (!line) return;
        if (usedChars >= maxTotalContextChars) return;
        const remaining = maxTotalContextChars - usedChars;
        const safe = truncateWithEllipsis(line, remaining);
        if (!safe) return;
        lines.push(safe);
        usedChars += safe.length + 1;
    };

    const seenForwardIds = new Set<string>();
    const forwardQueue: Array<{ id: string; depth: number; layerTag: string }> = [];
    const enqueueForwardId = (id: string | undefined | null, depth: number, layerTag: string) => {
        const fid = String(id || "").trim();
        if (!fid || seenForwardIds.has(fid) || depth > maxForwardLayers) return;
        seenForwardIds.add(fid);
        forwardQueue.push({ id: fid, depth, layerTag });
    };

    const collectAndEnqueueForwards = (
        depth: number,
        layerTag: string,
        ...messages: Array<OneBotMessage | string | undefined>
    ) => {
        const fids = collectForwardIdsFromCandidates(...messages);
        if (debugLayerTrace && fids.length > 0) {
            console.log(`[QQLayerTrace] enqueue forward ids depth=${depth} tag=${layerTag} ids=${fids.join(",")}`);
        }
        for (const fid of fids) {
            enqueueForwardId(fid, depth, layerTag);
        }
    };

    if (includeCurrentOutline) {
        await hydrateOneBotMessageMedia(client, rootEvent.message, { groupId: rootEvent?.group_id });
        const current = summarizeOneBotSegments(rootEvent.message, maxCharsPerLayer);
        for (const u of current.images) layeredImages.add(u);
        pushLine(`[Layer 0][current] ${current.text || "(空文本)"}`);
        collectAndEnqueueForwards(1, "forward", rootEvent.message, rootEvent.raw_message);
    }

    const seenReplyIds = new Set<string>();
    let cursor = repliedMsg;
    for (let i = 1; i <= maxReplyLayers && cursor; i += 1) {
        if (debugLayerTrace) {
            const mlike = extractMessageLikeFromPayload(cursor);
            const mtype = Array.isArray(mlike) ? "array" : typeof mlike;
            console.log(`[QQLayerTrace] reply layer=${i} hasCursor=true messageLikeType=${mtype}`);
        }
        const senderName = cursor?.sender?.nickname || cursor?.sender?.card || cursor?.sender?.user_id || "unknown";
        const msgBody = extractMessageLikeFromPayload(cursor) ?? (Array.isArray(cursor?.message) ? cursor.message : cursor?.raw_message);
        await hydrateOneBotMessageMedia(client, msgBody, { groupId: cursor?.group_id ?? rootEvent?.group_id });
        const summarized = summarizeOneBotSegments(msgBody, maxCharsPerLayer);
        for (const u of summarized.images) layeredImages.add(u);
        const prefix = includeSenderInLayers ? `[Layer ${i}][reply][from:${senderName}]` : `[Layer ${i}][reply]`;
        pushLine(`${prefix} ${summarized.text || "(空文本)"}`);

        collectAndEnqueueForwards(1, "forward-in-reply", msgBody, cursor?.raw_message, oneBotPayloadData(cursor)?.raw_message);

        const nextReplyId = getReplyMessageId(extractMessageLikeFromPayload(cursor), cursor?.raw_message, oneBotPayloadData(cursor));
        if (debugLayerTrace) console.log(`[QQLayerTrace] reply layer=${i} nextReplyId=${nextReplyId || ""}`);
        if (!nextReplyId || seenReplyIds.has(nextReplyId)) break;
        seenReplyIds.add(nextReplyId);
        try {
            cursor = await client.getMsg(nextReplyId, QQ_CONTEXT_FETCH_TIMEOUT_MS);
            if (debugLayerTrace) console.log(`[QQLayerTrace] get_msg ok id=${nextReplyId}`);
        } catch (err) {
            if (debugLayerTrace) console.warn(`[QQLayerTrace] get_msg failed id=${nextReplyId} err=${String(err)}`);
            break;
        }
    }

    while (forwardQueue.length > 0) {
        const item = forwardQueue.shift()!;
        if (item.depth > maxForwardLayers) continue;
        if (debugLayerTrace) console.log(`[QQLayerTrace] dequeue forward id=${item.id} depth=${item.depth} tag=${item.layerTag}`);
        try {
            const forwardData = await client.getForwardMsg(item.id, QQ_CONTEXT_FETCH_TIMEOUT_MS);
            if (debugLayerTrace) console.log(`[QQLayerTrace] get_forward_msg ok id=${item.id}`);
            const allNodes = extractForwardNodeList(forwardData);
            if (debugLayerTrace) console.log(`[QQLayerTrace] forward id=${item.id} nodes=${allNodes.length}`);
            const messages = allNodes.slice(0, maxForwardMessagesPerLayer);
            let idx = 0;
            for (const m of messages) {
                idx += 1;
                const senderName = getForwardNodeSenderName(m);
                const content = getForwardNodeContent(m) ?? "";
                await hydrateOneBotMessageMedia(client, content, { groupId: m?.group_id ?? rootEvent?.group_id });
                const summarized = summarizeOneBotSegments(content, maxCharsPerLayer);
                for (const u of summarized.images) layeredImages.add(u);
                const prefix = includeSenderInLayers
                    ? `[Layer F${item.depth}.${idx}][${item.layerTag}][from:${senderName}]`
                    : `[Layer F${item.depth}.${idx}][${item.layerTag}]`;
                pushLine(`${prefix} ${summarized.text || "(空文本)"}`);

                // nested forward inside forward message
                if (item.depth < maxForwardLayers) {
                    collectAndEnqueueForwards(item.depth + 1, "forward-nested", content as any, getForwardNodeRawMessage(m));
                }

                // reply inside forward message
                const replyIdInForward = getReplyMessageId(
                    Array.isArray(content) ? content : undefined,
                    getForwardNodeRawMessage(m),
                    m,
                );
                if (replyIdInForward && item.depth < maxForwardLayers) {
                    try {
                        const replied = await client.getMsg(replyIdInForward, QQ_CONTEXT_FETCH_TIMEOUT_MS);
                        const rSender = replied?.sender?.nickname || replied?.sender?.card || replied?.sender?.user_id || "unknown";
                        const rBody = Array.isArray(replied?.message) ? replied.message : replied?.raw_message;
                        await hydrateOneBotMessageMedia(client, rBody, { groupId: replied?.group_id ?? rootEvent?.group_id });
                        const rSummarized = summarizeOneBotSegments(rBody, maxCharsPerLayer);
                        for (const u of rSummarized.images) layeredImages.add(u);
                        const rPrefix = includeSenderInLayers
                            ? `[Layer RF${item.depth}.${idx}][reply-in-forward][from:${rSender}]`
                            : `[Layer RF${item.depth}.${idx}][reply-in-forward]`;
                        pushLine(`${rPrefix} ${rSummarized.text || "(空文本)"}`);
                        collectAndEnqueueForwards(item.depth + 1, "forward-in-reply-in-forward", rBody, replied?.raw_message);
                    } catch { }
                }
            }
        } catch (err) {
            if (debugLayerTrace) console.warn(`[QQLayerTrace] get_forward_msg failed id=${item.id} err=${String(err)}`);
            continue;
        }
    }

    if (debugLayerTrace) console.log(`[QQLayerTrace] done lines=${lines.length} images=${layeredImages.size}`);
    if (lines.length === 0) return { block: "", imageUrls: Array.from(layeredImages).slice(0, 5) };
    return {
        block: `<context_layers>\n${lines.join("\n")}\n</context_layers>\n\n`,
        imageUrls: Array.from(layeredImages).slice(0, 5),
    };
}

function normalizeTarget(raw: string): string {
    const normalizedLegacy = normalizeQQDeliveryTarget(raw);
    const { base, tmpSuffix } = splitTmpSuffix(normalizedLegacy.replace(/^(qq:)/i, "").trim());
    if (!base) return base;
    if (/^guild:[^:]+:[^:]+$/i.test(base)) return `${base}${tmpSuffix}`;
    const groupMatch = base.match(/^group:(\d{5,12})$/i);
    if (groupMatch) return `group:${groupMatch[1]}${tmpSuffix}`;
    const userMatch = base.match(/^(?:user|u|dm|direct):(\d{5,12})$/i);
    if (userMatch) return `user:${userMatch[1]}${tmpSuffix}`;
    const plainId = base.match(/^(\d{5,12})$/);
    if (plainId) return `user:${plainId[1]}${tmpSuffix}`;
    return `${base}${tmpSuffix}`;
}

async function resetSessionByKey(storePath: string, sessionKey: string): Promise<boolean> {
    try {
        const raw = await fs.readFile(storePath, "utf-8");
        const store = JSON.parse(raw) as Record<string, unknown>;
        if (!store || typeof store !== "object") return false;
        if (!(sessionKey in store)) return false;
        delete store[sessionKey];
        await fs.writeFile(storePath, JSON.stringify(store, null, 2));
        return true;
    } catch {
        return false;
    }
}

const clients = new Map<string, OneBotClient>();
const allClientsByAccount = new Map<string, Set<OneBotClient>>();
const accountConfigs = new Map<string, QQConfig>();
const blockedNotifyCache = new Map<string, number>();
const activeTaskIds = new Set<string>();
const groupBusyCounters = new Map<string, number>();
const groupBaseCards = new Map<string, string>();
const groupBusySuffixes = new Map<string, string>();

function normalizeNumericId(value: string | number | undefined | null): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string") {
        const trimmed = value.trim().replace(/^"|"$|^'|'$/g, "");
        if (!/^\d+$/.test(trimmed)) return null;
        const parsed = Number.parseInt(trimmed, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function normalizeNumericIdList(values: Array<string | number> | undefined): number[] {
    if (!Array.isArray(values)) return [];
    const out: number[] = [];
    for (const value of values) {
        const parsed = normalizeNumericId(value);
        if (parsed !== null) out.push(parsed);
    }
    return out;
}

function parseIdListInput(values: string | number | Array<string | number> | undefined): number[] {
    if (typeof values === "number") {
        const parsed = normalizeNumericId(values);
        return parsed === null ? [] : [parsed];
    }
    if (typeof values === "string") {
        const parts = values
            .split(/[\n,，;；\s]+/)
            .map((part) => part.trim())
            .filter(Boolean);
        return normalizeNumericIdList(parts);
    }
    return normalizeNumericIdList(values);
}

function parseKeywordTriggersInput(values: string | string[] | undefined): string[] {
    if (typeof values === "string") {
        return values
            .split(/[\n,，;；\s]+/)
            .map((part) => part.trim())
            .filter(Boolean);
    }
    if (Array.isArray(values)) {
        return values
            .map((part) => String(part).trim())
            .filter(Boolean);
    }
    return [];
}

function normalizeAccountLookupId(accountId: string | undefined | null): string {
    const raw = typeof accountId === "string" ? accountId.trim() : "";
    if (!raw) return DEFAULT_ACCOUNT_ID;
    if (raw === DEFAULT_ACCOUNT_ID) return raw;

    const noPrefix = raw.replace(/^qq:/i, "");
    if (noPrefix) return noPrefix;
    return DEFAULT_ACCOUNT_ID;
}

function buildTaskKey(accountId: string, isGroup: boolean, isGuild: boolean, groupId?: number, guildId?: string, channelId?: string, userId?: number): string {
    if (isGroup && groupId !== undefined && userId !== undefined) return `${accountId}:group:${groupId}:user:${userId}`;
    if (isGuild && guildId && channelId && userId !== undefined) return `${accountId}:guild:${guildId}:${channelId}:user:${userId}`;
    return `${accountId}:dm:${String(userId ?? "unknown")}`;
}

function stripTrailingBusySuffixes(card: string, busySuffix: string): string {
    const normalized = (card || "").trim();
    const suffix = (busySuffix || "输入中").trim();
    if (!normalized || !suffix) return normalized;

    const marker = `(${suffix})`;
    let result = normalized;
    while (result.endsWith(marker)) {
        result = result.slice(0, -marker.length).trimEnd();
    }
    return result.trim();
}

function countActiveTasksForAccount(accountId: string): number {
    let count = 0;
    const prefix = `${accountId}:`;
    for (const taskId of activeTaskIds) {
        if (taskId.startsWith(prefix)) count += 1;
    }
    return count;
}


const TEMP_SESSION_STATE_FILE = path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".openclaw",
    "workspace",
    "qq-temp-sessions.json",
);

type TempSessionState = {
    active?: Record<string, string>;
    history?: Record<string, string[]>;
};

const tempSessionSlots = new Map<string, string>();
const tempSessionHistory = new Map<string, string[]>();
let tempSessionSlotsLoaded = false;
let tempSessionSlotsLoading: Promise<void> | null = null;
const globalProcessedMsgIds = new Set<string>();
const recentCommandFingerprints = new Map<string, number>();
const accountStartGeneration = new Map<string, number>();
let globalProcessedMsgCleanupTimer: ReturnType<typeof setTimeout> | null = null;

function ensureGlobalProcessedMsgCleanupTimer(): void {
    if (globalProcessedMsgCleanupTimer) return;
    globalProcessedMsgCleanupTimer = setInterval(() => {
        if (globalProcessedMsgIds.size > 5000) {
            globalProcessedMsgIds.clear();
        }
        const now = Date.now();
        for (const [key, ts] of recentCommandFingerprints.entries()) {
            if (now - ts > 10_000) {
                recentCommandFingerprints.delete(key);
            }
        }
    }, 3600000);
}

function markAndCheckRecentCommandDuplicate(key: string, ttlMs = 2500): boolean {
    const now = Date.now();
    const lastTs = recentCommandFingerprints.get(key);
    recentCommandFingerprints.set(key, now);
    return typeof lastTs === "number" && now - lastTs <= ttlMs;
}

function normalizeSlashVariants(input: string): string {
    if (!input) return "";
    return input.replace(/[／⁄∕]/g, "/");
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLeadingInlineCommand(input: string, keywordTriggers: string[]): {
    command: string;
    keywordPrefixed: boolean;
    bareCommand: boolean;
} {
    const normalized = normalizeSlashVariants(input).trim();
    if (!normalized) {
        return { command: "", keywordPrefixed: false, bareCommand: false };
    }
    if (normalized.startsWith("/")) {
        return { command: normalized, keywordPrefixed: false, bareCommand: true };
    }

    const sortedKeywords = [...keywordTriggers]
        .map((item) => item.trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
    for (const keyword of sortedKeywords) {
        const escapedKeyword = escapeRegExp(keyword);
        const match = normalized.match(new RegExp(`^${escapedKeyword}(?:[\\s,，:：]+)?(\\/.*)$`));
        if (!match) continue;
        return {
            command: match[1].trim(),
            keywordPrefixed: true,
            bareCommand: false,
        };
    }

    return { command: "", keywordPrefixed: false, bareCommand: false };
}

function buildTempThreadKey(accountId: string, isGroup: boolean, isGuild: boolean, groupId?: number, guildId?: string, channelId?: string, userId?: number): string {
    if (isGroup && groupId !== undefined) return `${accountId}:group:${groupId}`;
    if (isGuild && guildId && channelId) return `${accountId}:guild:${guildId}:${channelId}`;
    return `${accountId}:dm:${String(userId ?? "unknown")}`;
}

function splitTmpSuffix(raw: string): { base: string; tmpSuffix: string } {
    const value = String(raw || "").trim();
    const idx = value.indexOf("::tmp:");
    if (idx < 0) return { base: value, tmpSuffix: "" };
    return {
        base: value.slice(0, idx).trim(),
        tmpSuffix: value.slice(idx),
    };
}

function normalizeLegacyQQPeerId(raw: string): string {
    const { base, tmpSuffix } = splitTmpSuffix(raw);
    const trimmed = base.trim();
    if (!trimmed) return trimmed;
    const withoutProvider = trimmed.replace(/^qq:/i, "");
    const peerMatch = withoutProvider.match(/^(?:user|group):(\d{5,12})$/i);
    if (peerMatch) return `${peerMatch[1]}${tmpSuffix}`;
    return `${trimmed}${tmpSuffix}`;
}

function normalizeQQSessionStoreKey(raw: string): string {
    const trimmed = String(raw || "").trim();
    if (!trimmed.toLowerCase().startsWith("agent:")) return trimmed;
    const { base, tmpSuffix } = splitTmpSuffix(trimmed);
    const parts = base.split(":");
    if (parts.length < 5) return trimmed;
    if (parts[0] !== "agent" || parts[2]?.toLowerCase() !== "qq") return trimmed;

    const kindIndex = parts.findIndex((part, idx) => idx >= 3 && /^(direct|group|channel)$/i.test(part));
    if (kindIndex < 0 || kindIndex >= parts.length - 1) return trimmed;

    const normalizedPeer = normalizeLegacyQQPeerId(parts.slice(kindIndex + 1).join(":"));
    const next = [...parts.slice(0, kindIndex + 1), normalizedPeer].join(":");
    return `${next}${tmpSuffix}`;
}

function normalizeQQDeliveryTarget(raw: string): string {
    const trimmed = String(raw || "").trim();
    if (!trimmed) return trimmed;
    const { base, tmpSuffix } = splitTmpSuffix(trimmed);
    const withoutProvider = base.replace(/^qq:/i, "");
    const directMatch = withoutProvider.match(/^user:(\d{5,12})$/i);
    if (directMatch) return `user:${directMatch[1]}${tmpSuffix}`;
    const groupMatch = withoutProvider.match(/^group:(\d{5,12})$/i);
    if (groupMatch) return `group:${groupMatch[1]}${tmpSuffix}`;
    return `${withoutProvider}${tmpSuffix}`;
}

function inferQQSessionPeerKind(sessionKey: string): "direct" | "group" | "channel" | null {
    const trimmed = String(sessionKey || "").trim();
    if (!trimmed.toLowerCase().startsWith("agent:")) return null;
    const { base } = splitTmpSuffix(trimmed);
    const parts = base.split(":");
    if (parts.length < 5) return null;
    if (parts[0] !== "agent" || parts[2]?.toLowerCase() !== "qq") return null;
    const kind = parts.find((part, idx) => idx >= 3 && /^(direct|group|channel)$/i.test(part));
    if (!kind) return null;
    return kind.toLowerCase() as "direct" | "group" | "channel";
}

function normalizeQQDeliveryTargetForSession(raw: string, sessionKey: string): string {
    const normalized = normalizeQQDeliveryTarget(raw);
    const { base, tmpSuffix } = splitTmpSuffix(normalized);
    const plainId = base.match(/^(\d{5,12})$/);
    if (!plainId) return normalized;
    const kind = inferQQSessionPeerKind(sessionKey);
    if (kind === "group") return `group:${plainId[1]}${tmpSuffix}`;
    if (kind === "direct") return `user:${plainId[1]}${tmpSuffix}`;
    return normalized;
}

function pickPreferredSessionEntry(current: any, incoming: any): any {
    if (!current) return incoming;
    if (!incoming) return current;
    const currentUpdatedAt = Number(current?.updatedAt ?? 0);
    const incomingUpdatedAt = Number(incoming?.updatedAt ?? 0);
    return incomingUpdatedAt >= currentUpdatedAt ? { ...current, ...incoming } : current;
}

function normalizeQQSessionStoreEntry(entry: any, sessionKey: string): any {
    if (!entry || typeof entry !== "object") return entry;
    const next = { ...entry } as Record<string, any>;
    if (typeof next.lastTo === "string") next.lastTo = normalizeQQDeliveryTargetForSession(next.lastTo, sessionKey);
    if (next.deliveryContext && typeof next.deliveryContext === "object") {
        next.deliveryContext = { ...next.deliveryContext };
        if (typeof next.deliveryContext.to === "string") {
            next.deliveryContext.to = normalizeQQDeliveryTargetForSession(next.deliveryContext.to, sessionKey);
        }
    }
    return next;
}

async function migrateLegacyQQSessionStore(storePath: string): Promise<number> {
    try {
        const raw = await fs.readFile(storePath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, any>;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;

        let changed = 0;
        const nextStore: Record<string, any> = {};
        for (const [key, value] of Object.entries(parsed)) {
            const normalizedKey = normalizeQQSessionStoreKey(key);
            const normalizedEntry = normalizeQQSessionStoreEntry(value, normalizedKey);
            if (normalizedKey !== key) changed += 1;
            if (JSON.stringify(normalizedEntry) !== JSON.stringify(value)) changed += 1;
            nextStore[normalizedKey] = pickPreferredSessionEntry(nextStore[normalizedKey], normalizedEntry);
        }

        if (changed <= 0) return 0;

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await fs.copyFile(storePath, `${storePath}.bak.qq-session-normalize.${stamp}`);
        await fs.writeFile(storePath, JSON.stringify(nextStore, null, 2), "utf-8");
        return changed;
    } catch (err) {
        console.warn(`[QQ] Failed to migrate legacy session store ${storePath}: ${String(err)}`);
        return 0;
    }
}

let legacyQQSessionMigrationPromise: Promise<void> | null = null;

async function ensureLegacyQQSessionMigration(): Promise<void> {
    if (legacyQQSessionMigrationPromise) {
        await legacyQQSessionMigrationPromise;
        return;
    }
    legacyQQSessionMigrationPromise = (async () => {
        const home = process.env.HOME || process.env.USERPROFILE || "";
        if (!home) return;
        const agentsDir = path.join(home, ".openclaw", "agents");
        let totalChanged = 0;
        try {
            const agents = await fs.readdir(agentsDir, { withFileTypes: true });
            for (const agent of agents) {
                if (!agent.isDirectory()) continue;
                const storePath = path.join(agentsDir, agent.name, "sessions", "sessions.json");
                try {
                    await fs.access(storePath, fsConstants.F_OK | fsConstants.R_OK | fsConstants.W_OK);
                } catch {
                    continue;
                }
                totalChanged += await migrateLegacyQQSessionStore(storePath);
            }
        } catch (err) {
            console.warn(`[QQ] Failed to scan legacy session stores: ${String(err)}`);
            return;
        }
        if (totalChanged > 0) {
            console.log(`[QQ] Normalized ${totalChanged} legacy QQ session key/update(s) in local session stores`);
        }
    })();
    await legacyQQSessionMigrationPromise;
}

function sanitizeTempSlotName(input: string | undefined): string {
    const raw = String(input || "").trim();
    if (!raw) return "";
    return raw
        .replace(/\s+/g, "-")
        .replace(/[^\p{L}\p{N}_-]+/gu, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
}

function formatSessionTimeCompact(inputMs?: number): string {
    const dt = typeof inputMs === "number" && Number.isFinite(inputMs) ? new Date(inputMs) : new Date();
    const value = Number.isFinite(dt.getTime()) ? dt : new Date();
    const yyyy = String(value.getFullYear());
    const mm = String(value.getMonth() + 1).padStart(2, "0");
    const dd = String(value.getDate()).padStart(2, "0");
    const hh = String(value.getHours()).padStart(2, "0");
    const mi = String(value.getMinutes()).padStart(2, "0");
    return `${yyyy}${mm}${dd}${hh}${mi}`;
}

function sanitizeSessionTitle(input: string | undefined, fallback: string): string {
    const raw = String(input || "").trim();
    if (!raw) return fallback;
    const compact = raw
        .replace(/\s+/g, "-")
        .replace(/[^\p{L}\p{N}_-]+/gu, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
    return (compact || fallback).slice(0, 80);
}

function buildQQSessionLabel(params: {
    isGroup: boolean;
    isGuild: boolean;
    groupId?: number;
    guildId?: string;
    channelId?: string;
    userId: number;
    activeTempSlot: string | null;
    timestampMs?: number;
    text?: string;
}): string {
    const peer = params.isGroup
        ? `g-${String(params.groupId ?? "unknown")}`
        : params.isGuild
            ? `guild-${String(params.guildId ?? "unknown")}-${String(params.channelId ?? "unknown")}`
            : `u-${String(params.userId)}`;
    const fallbackTitle = params.isGroup ? "group" : params.isGuild ? "channel" : "direct";
    const baseTitle = params.activeTempSlot || String(params.text || "").trim().slice(0, 80);
    const title = sanitizeSessionTitle(baseTitle, fallbackTitle);
    return `qq:${peer}-${formatSessionTimeCompact(params.timestampMs)}-${title}`;
}

function buildEffectiveFromId(baseFromId: string, tempSlot: string | null): string {
    if (!tempSlot) return baseFromId;
    return `${baseFromId}::tmp:${tempSlot}`;
}

function buildPerMessageFromId(baseFromId: string, event: any, userId: number): string {
    const rawId = event?.message_id !== undefined
        ? String(event.message_id)
        : `${String(event?.time ?? Date.now())}-${String(userId)}`;
    const messageId = rawId.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80) || `${Date.now()}-${userId}`;
    return `${baseFromId}::msg:${messageId}`;
}

type SessionCommandTarget = {
    slot: string | null;
    label: string;
};

function listSessionCommandTargets(threadKey: string): SessionCommandTarget[] {
    return [
        { slot: null, label: "默认会话" },
        ...getTempSessionHistory(threadKey).map((slot) => ({ slot, label: slot })),
    ];
}

function resolveSessionCommandTargetByIndex(threadKey: string, index: number): SessionCommandTarget | null {
    if (!Number.isInteger(index) || index < 1) return null;
    return listSessionCommandTargets(threadKey)[index - 1] || null;
}

function renderSessionCommandTargetList(threadKey: string, activeTempSlot: string | null): string {
    return listSessionCommandTargets(threadKey)
        .map((target, idx) => {
            const isCurrent = target.slot ? target.slot === activeTempSlot : !activeTempSlot;
            return `${idx + 1}. ${target.label}${isCurrent ? " (当前)" : ""}`;
        })
        .join("\n");
}

function getTempSessionHistory(threadKey: string): string[] {
    return tempSessionHistory.get(threadKey) || [];
}

function pushTempHistory(threadKey: string, slot: string): void {
    const prev = tempSessionHistory.get(threadKey) || [];
    const next = [slot, ...prev.filter((item) => item !== slot)];
    tempSessionHistory.set(threadKey, next);
}

async function ensureTempSessionSlotsLoaded(): Promise<void> {
    if (tempSessionSlotsLoaded) return;
    if (tempSessionSlotsLoading) {
        await tempSessionSlotsLoading;
        return;
    }
    tempSessionSlotsLoading = (async () => {
        try {
            const raw = await fs.readFile(TEMP_SESSION_STATE_FILE, "utf-8");
            const parsed = JSON.parse(raw) as TempSessionState | Record<string, string>;

            if (parsed && typeof parsed === "object" && "active" in parsed) {
                const state = parsed as TempSessionState;
                if (state.active && typeof state.active === "object") {
                    for (const [key, value] of Object.entries(state.active)) {
                        const slot = sanitizeTempSlotName(value);
                        if (slot) tempSessionSlots.set(key, slot);
                    }
                }
                if (state.history && typeof state.history === "object") {
                    for (const [key, values] of Object.entries(state.history)) {
                        if (!Array.isArray(values)) continue;
                        const cleaned = values
                            .map((value) => sanitizeTempSlotName(String(value)))
                            .filter(Boolean);
                        if (cleaned.length > 0) tempSessionHistory.set(key, cleaned);
                    }
                }
            } else if (parsed && typeof parsed === "object") {
                for (const [key, value] of Object.entries(parsed)) {
                    const slot = sanitizeTempSlotName(String(value));
                    if (slot) {
                        tempSessionSlots.set(key, slot);
                        pushTempHistory(key, slot);
                    }
                }
            }
        } catch { }
        tempSessionSlotsLoaded = true;
    })();
    await tempSessionSlotsLoading;
    tempSessionSlotsLoading = null;
}

async function reloadTempSessionStateFromDisk(): Promise<void> {
    try {
        const raw = await fs.readFile(TEMP_SESSION_STATE_FILE, "utf-8");
        const parsed = JSON.parse(raw) as TempSessionState | Record<string, string>;
        const nextSlots = new Map<string, string>();
        const nextHistory = new Map<string, string[]>();

        if (parsed && typeof parsed === "object" && "active" in parsed) {
            const state = parsed as TempSessionState;
            if (state.active && typeof state.active === "object") {
                for (const [key, value] of Object.entries(state.active)) {
                    const slot = sanitizeTempSlotName(value);
                    if (slot) nextSlots.set(key, slot);
                }
            }
            if (state.history && typeof state.history === "object") {
                for (const [key, values] of Object.entries(state.history)) {
                    if (!Array.isArray(values)) continue;
                    const cleaned = values
                        .map((value) => sanitizeTempSlotName(String(value)))
                        .filter(Boolean);
                    if (cleaned.length > 0) nextHistory.set(key, cleaned);
                }
            }
        } else if (parsed && typeof parsed === "object") {
            for (const [key, value] of Object.entries(parsed)) {
                const slot = sanitizeTempSlotName(String(value));
                if (!slot) continue;
                nextSlots.set(key, slot);
                nextHistory.set(key, [slot]);
            }
        } else {
            return;
        }

        tempSessionSlots.clear();
        tempSessionHistory.clear();
        for (const [key, value] of nextSlots.entries()) tempSessionSlots.set(key, value);
        for (const [key, values] of nextHistory.entries()) tempSessionHistory.set(key, values);
        tempSessionSlotsLoaded = true;
    } catch (err) {
        console.warn(`[QQ] Failed to reload temp session state from disk: ${String(err)}`);
    }
}

async function persistTempSessionSlots(): Promise<void> {
    try {
        await fs.mkdir(path.dirname(TEMP_SESSION_STATE_FILE), { recursive: true });
        const active: Record<string, string> = {};
        for (const [key, value] of tempSessionSlots.entries()) {
            active[key] = value;
        }
        const history: Record<string, string[]> = {};
        for (const [key, values] of tempSessionHistory.entries()) {
            if (values.length > 0) history[key] = values;
        }
        const state: TempSessionState = { active, history };
        await fs.writeFile(TEMP_SESSION_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
        console.warn(`[QQ] Failed to persist temp session slots: ${String(err)}`);
    }
}

function getTempSessionSlot(threadKey: string): string | null {
    const slot = tempSessionSlots.get(threadKey);
    return slot || null;
}

async function setTempSessionSlot(threadKey: string, slot: string | null): Promise<void> {
    if (slot) {
        tempSessionSlots.set(threadKey, slot);
        pushTempHistory(threadKey, slot);
    } else {
        tempSessionSlots.delete(threadKey);
    }
    await persistTempSessionSlots();
}

async function setGroupTypingCard(client: OneBotClient, accountId: string, groupId: number, busySuffix: string): Promise<void> {
    const selfId = client.getSelfId();
    if (!selfId) return;
    const groupKey = `${accountId}:group:${groupId}`;
    const suffix = (busySuffix || "输入中").trim() || "输入中";
    const current = groupBusyCounters.get(groupKey) || 0;
    const next = current + 1;
    groupBusyCounters.set(groupKey, next);
    groupBusySuffixes.set(groupKey, suffix);

    if (current > 0) return;

    try {
        const info = await (client as any).sendWithResponse("get_group_member_info", { group_id: groupId, user_id: selfId, no_cache: true }, QQ_CONTEXT_FETCH_TIMEOUT_MS);
        const currentCard = (info?.card || info?.nickname || "").trim();
        const baseCard = stripTrailingBusySuffixes(currentCard, suffix);
        groupBaseCards.set(groupKey, baseCard);
        const nextCard = baseCard ? `${baseCard}(${suffix})` : `(${suffix})`;
        client.setGroupCard(groupId, selfId, nextCard);
    } catch (err) {
        console.warn(`[QQ] Failed to set busy group card: ${String(err)}`);
    }
}

async function activateGroupTypingIndicator(client: OneBotClient, accountId: string, groupId: number, busySuffix: string): Promise<boolean> {
    const selfId = client.getSelfId();
    if (selfId) {
        try {
            const activated = await client.setInputStatus(groupId, selfId);
            if (activated) return false;
        } catch (err) {
            console.warn(`[QQ] Native typing indicator unavailable, falling back to group card: ${String(err)}`);
        }
    }

    await setGroupTypingCard(client, accountId, groupId, busySuffix);
    return true;
}

function clearGroupTypingCard(client: OneBotClient, accountId: string, groupId: number, busySuffix?: string): void {
    const selfId = client.getSelfId();
    if (!selfId) return;
    const groupKey = `${accountId}:group:${groupId}`;
    const current = groupBusyCounters.get(groupKey) || 0;
    if (current <= 1) {
        groupBusyCounters.delete(groupKey);
        const suffix = (groupBusySuffixes.get(groupKey) || busySuffix || "输入中").trim() || "输入中";
        const baseCard = stripTrailingBusySuffixes(groupBaseCards.get(groupKey) || "", suffix);
        groupBaseCards.delete(groupKey);
        groupBusySuffixes.delete(groupKey);
        try {
            client.setGroupCard(groupId, selfId, baseCard);
        } catch (err) {
            console.warn(`[QQ] Failed to restore group card: ${String(err)}`);
        }
        return;
    }
    groupBusyCounters.set(groupKey, current - 1);
}

function getClientForAccount(accountId: string | undefined | null) {
    const lookupId = normalizeAccountLookupId(accountId);
    const direct = clients.get(lookupId);
    if (direct) return direct;

    const normalized = normalizeAccountId(lookupId);
    if (normalized && clients.has(normalized)) {
        return clients.get(normalized);
    }

    const suffix = lookupId.includes(":") ? lookupId.split(":").pop() : lookupId;
    if (suffix && clients.has(suffix)) {
        return clients.get(suffix);
    }

    if (clients.size === 1) {
        return Array.from(clients.values())[0];
    }

    console.warn(`[QQ] Client lookup miss: requested=${String(accountId)} resolved=${lookupId} keys=${Array.from(clients.keys()).join(",")}`);
    return undefined;
}

function pickFirstDefined(obj: Record<string, any> | undefined | null, keys: string[]): any {
    if (!obj || typeof obj !== "object") return undefined;
    for (const key of keys) {
        if (obj[key] !== undefined && obj[key] !== null) return obj[key];
    }
    return undefined;
}

function normalizeQQMessageRef(value: unknown): string | number | null {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "string") return null;
    const trimmed = value.trim().replace(/^"|"$|^'|'$/g, "");
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed) && trimmed.length < 16) {
        const parsed = Number.parseInt(trimmed, 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    return trimmed;
}

function normalizeQQEmojiRef(value: unknown): string | number | null {
    const ref = normalizeQQMessageRef(value);
    if (ref === null) return null;
    return ref;
}

function normalizeQQEmojiSetFlag(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["false", "0", "no", "n", "off", "remove", "delete", "cancel", "取消"].includes(normalized)) return false;
        if (["true", "1", "yes", "y", "on", "add", "set", "添加"].includes(normalized)) return true;
    }
    return true;
}

function parseQQEmojiRefList(value: unknown): Array<string | number> {
    const rawItems = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(/[\s,，;；|]+/)
            : value === undefined || value === null
                ? []
                : [value];
    const out: Array<string | number> = [];
    const seen = new Set<string>();
    for (const raw of rawItems) {
        const ref = normalizeQQEmojiRef(raw);
        if (ref === null) continue;
        const key = String(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ref);
    }
    return out;
}

function resolveQQAutoReactProbability(config: QQConfig): number {
    const raw = Number((config as any).groupAutoReactProbability ?? 0.2);
    if (!Number.isFinite(raw)) return 0;
    return Math.min(1, Math.max(0, raw));
}

function pickQQAutoReactEmoji(config: QQConfig): string | number | null {
    const candidates = parseQQEmojiRefList((config as any).groupAutoReactEmojiIds);
    if (candidates.length === 0) {
        const fallback = normalizeQQEmojiRef((config as any).groupAutoReactEmojiId ?? "76");
        return fallback;
    }
    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index] ?? null;
}

function extractQQEmojiLikeSummaries(payload: any): Array<{ emojiId: string; emojiType?: string; count?: number; clicked?: boolean }> {
    const root = payload?.data ?? payload;
    const candidates = [
        root?.emoji_likes_list,
        root?.emojiLikesList,
        root?.emoji_like_list,
        root?.message?.emoji_likes_list,
        root?.message?.emojiLikesList,
        root?.raw?.emoji_likes_list,
        root?.raw?.emojiLikesList,
        root?.likes,
    ];
    const list = candidates.find((item) => Array.isArray(item));
    if (!Array.isArray(list)) return [];
    return list
        .map((entry: any) => {
            const emojiId = String(entry?.emoji_id ?? entry?.emojiId ?? entry?.id ?? entry?.code ?? "").trim();
            if (!emojiId) return null;
            const rawCount = entry?.count ?? entry?.likesCnt ?? entry?.likes_count ?? entry?.like_count;
            const count = Number(rawCount);
            const rawClicked = entry?.isClicked ?? entry?.is_clicked ?? entry?.clicked;
            return {
                emojiId,
                emojiType: entry?.emoji_type !== undefined ? String(entry.emoji_type) : entry?.emojiType !== undefined ? String(entry.emojiType) : undefined,
                count: Number.isFinite(count) ? count : undefined,
                clicked: rawClicked === true || rawClicked === "true" || rawClicked === "1",
            };
        })
        .filter((entry): entry is { emojiId: string; emojiType?: string; count?: number; clicked?: boolean } => Boolean(entry));
}

function extractQQEmojiLikeUsers(payload: any): Array<{ userId: string; nickName?: string; headUrl?: string }> {
    const root = payload?.data ?? payload;
    const candidates = [
        root?.emoji_like_list,
        root?.emojiLikeList,
        root?.emojiLikesList,
        root?.likes,
        root?.users,
    ];
    const list = candidates.find((item) => Array.isArray(item));
    if (!Array.isArray(list)) return [];
    return list
        .map((entry: any) => {
            const userId = String(entry?.user_id ?? entry?.userId ?? entry?.tinyId ?? entry?.uin ?? entry?.id ?? "").trim();
            if (!userId) return null;
            return {
                userId,
                nickName: entry?.nick_name ?? entry?.nickName ?? entry?.nickname ?? entry?.name,
                headUrl: entry?.headUrl ?? entry?.head_url ?? entry?.avatar,
            };
        })
        .filter((entry): entry is { userId: string; nickName?: string; headUrl?: string } => Boolean(entry));
}

function renderQQEmojiLikeSummary(messageId: string | number, summaries: Array<{ emojiId: string; emojiType?: string; count?: number; clicked?: boolean }>): string {
    if (summaries.length === 0) {
        return `[OpenClawd QQ]\n消息 ${String(messageId)} 当前没有可见的贴表情汇总，或当前 OneBot 实现未返回 emoji_likes_list。`;
    }
    const lines = summaries.map((item) => {
        const parts = [`emoji_id=${item.emojiId}`];
        if (item.emojiType) parts.push(`type=${item.emojiType}`);
        if (item.count !== undefined) parts.push(`count=${item.count}`);
        if (item.clicked) parts.push("self=clicked");
        return `- ${parts.join(" ")}`;
    });
    return `[OpenClawd QQ]\n消息 ${String(messageId)} 的贴表情汇总：\n${lines.join("\n")}\n\n查看某个表情点击者：/查贴表情 ${String(messageId)} <emoji_id>`;
}

function renderQQEmojiLikeUsers(messageId: string | number, emojiId: string | number, users: Array<{ userId: string; nickName?: string }>): string {
    if (users.length === 0) {
        return `[OpenClawd QQ]\n消息 ${String(messageId)} 的 emoji_id=${String(emojiId)} 未返回点击者列表。`;
    }
    const lines = users.slice(0, 80).map((user) => `- ${user.nickName ? `${user.nickName} ` : ""}(${user.userId})`);
    const suffix = users.length > lines.length ? `\n...另有 ${users.length - lines.length} 人` : "";
    return `[OpenClawd QQ]\n消息 ${String(messageId)} 的 emoji_id=${String(emojiId)} 点击者：\n${lines.join("\n")}${suffix}`;
}

function isQQEmojiLikeNotice(event: any): boolean {
    if (event?.post_type !== "notice") return false;
    const noticeType = String(event?.notice_type ?? "").toLowerCase();
    return noticeType === "group_msg_emoji_like" || noticeType === "reaction";
}

function summarizeQQEmojiLikeNotice(event: any): string {
    const noticeType = String(event?.notice_type ?? "");
    const groupId = event?.group_id ?? "-";
    const actorId = event?.user_id ?? event?.operator_id ?? event?.sender_id ?? "-";
    const messageId = event?.message_id ?? "-";
    const action = event?.is_add === false || event?.sub_type === "remove" ? "remove" : "add";
    const likes = extractQQEmojiLikeSummaries(event);
    const fallbackEmoji = event?.emoji_id ?? event?.code;
    const renderedLikes = likes.length > 0
        ? likes.map((item) => `${item.emojiId}${item.count !== undefined ? `x${item.count}` : ""}`).join(",")
        : fallbackEmoji !== undefined
            ? String(fallbackEmoji)
        : "-";
    return `type=${noticeType} action=${action} group=${groupId} actor=${actorId} msg=${messageId} likes=${renderedLikes}`;
}

async function setQQMessageEmojiLike(params: {
    client: OneBotClient;
    messageId: string | number;
    emojiId: string | number;
    set?: boolean;
}): Promise<{ ok: boolean; data?: any; error?: string }> {
    try {
        const data = await params.client.setMsgEmojiLike(params.messageId, params.emojiId, params.set ?? true, 5000);
        return { ok: true, data };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

async function getQQMessageEmojiLikeSummary(params: {
    client: OneBotClient;
    messageId: string | number;
}): Promise<{ ok: boolean; text: string; data?: any; summaries?: Array<{ emojiId: string; emojiType?: string; count?: number; clicked?: boolean }>; error?: string }> {
    try {
        const data = await params.client.getMsg(params.messageId, 5000);
        const summaries = extractQQEmojiLikeSummaries(data);
        return {
            ok: true,
            text: renderQQEmojiLikeSummary(params.messageId, summaries),
            data,
            summaries,
        };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            text: `[OpenClawd QQ]\n查询消息 ${String(params.messageId)} 的贴表情失败：${error}`,
            error,
        };
    }
}

async function getQQMessageEmojiLikeUsers(params: {
    client: OneBotClient;
    messageId: string | number;
    emojiId: string | number;
    groupId?: number | string;
    emojiType?: string | number;
    count?: number | string;
}): Promise<{ ok: boolean; text: string; data?: any; users?: Array<{ userId: string; nickName?: string; headUrl?: string }>; error?: string }> {
    try {
        const data = await params.client.getMsgEmojiLikes(params.messageId, params.emojiId, {
            groupId: params.groupId,
            emojiType: params.emojiType,
            count: params.count ?? 0,
            timeoutMs: 7000,
        });
        const users = extractQQEmojiLikeUsers(data);
        return {
            ok: true,
            text: renderQQEmojiLikeUsers(params.messageId, params.emojiId, users),
            data,
            users,
        };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            text: `[OpenClawd QQ]\n查询消息 ${String(params.messageId)} 的 emoji_id=${String(params.emojiId)} 点击者失败：${error}`,
            error,
        };
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withSoftTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T, label: string): Promise<T> {
    const safeTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.trunc(timeoutMs)) : 0;
    if (safeTimeoutMs <= 0) {
        try {
            return await promise;
        } catch (err) {
            console.warn(`[QQ] ${label} failed: ${String(err)}`);
            return fallback;
        }
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const wrapped = promise.then(
        (value) => ({ type: "value" as const, value }),
        (error) => ({ type: "error" as const, error }),
    );
    const timeout = new Promise<{ type: "timeout" }>((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ type: "timeout" }), safeTimeoutMs);
    });

    try {
        const result = await Promise.race([wrapped, timeout]);
        if (result.type === "value") return result.value;
        if (result.type === "error") {
            console.warn(`[QQ] ${label} failed: ${String(result.error)}`);
            return fallback;
        }
        console.warn(`[QQ] ${label} timed out after ${safeTimeoutMs}ms; continuing without it`);
        return fallback;
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }
}

function isImageFile(url: string): boolean {
    const lower = (toLocalPathIfAny(url) || url).split("?")[0].split("#")[0].toLowerCase();
    const mime = inferGenericMimeType(url);
    if (mime?.startsWith("image/")) return true;
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.gif') || lower.endsWith('.webp') || lower.endsWith(".apng") || lower.endsWith(".avif");
}

function isAudioFile(url: string): boolean {
    const lower = (toLocalPathIfAny(url) || url).split("?")[0].split("#")[0].toLowerCase();
    const mime = inferGenericMimeType(url);
    if (mime?.startsWith("audio/")) return true;
    return lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.m4a') || lower.endsWith('.ogg') || lower.endsWith('.flac') || lower.endsWith('.aac');
}

function isVideoFile(url: string): boolean {
    const lower = (toLocalPathIfAny(url) || url).split("?")[0].split("#")[0].toLowerCase();
    const mime = inferGenericMimeType(url);
    if (mime?.startsWith("video/")) return true;
    return lower.endsWith(".mp4") || lower.endsWith(".mov") || lower.endsWith(".mkv") || lower.endsWith(".avi") || lower.endsWith(".webm") || lower.endsWith(".m4v");
}

type MediaKind = "image" | "audio" | "video" | "file";

function detectMediaKind(...values: Array<string | undefined | null>): MediaKind {
    let sawNonMediaFileExtension = false;
    for (const value of values) {
        if (!value) continue;
        if (isImageFile(value)) return "image";
        if (isAudioFile(value)) return "audio";
        if (isVideoFile(value)) return "video";
        if (/^data:image\//i.test(value)) return "image";
        if (/^data:audio\//i.test(value)) return "audio";
        if (/^data:video\//i.test(value)) return "video";
        if (!/^base64:\/\//i.test(value)) {
            const local = toLocalPathIfAny(value) || value;
            const ext = path.extname(local.split("?")[0].split("#")[0]);
            if (ext) sawNonMediaFileExtension = true;
        }
    }
    if (sawNonMediaFileExtension) return "file";
    if (values.some((value) => typeof value === "string" && value.startsWith("base64://"))) return "image";
    return "file";
}

function normalizeOutboundMediaKind(value: unknown): MediaKind | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === "image" || normalized === "img" || normalized === "picture" || normalized === "photo" || normalized === "sticker" || normalized === "emoji" || normalized === "emoticon") return "image";
    if (normalized === "audio" || normalized === "voice" || normalized === "record") return "audio";
    if (normalized === "video") return "video";
    if (normalized === "file" || normalized === "document" || normalized === "attachment") return "file";
    if (normalized.startsWith("image/")) return "image";
    if (normalized.startsWith("audio/")) return "audio";
    if (normalized.startsWith("video/")) return "video";
    return undefined;
}

function classifyMediaError(error: string): "rich_media" | "timeout" | "connection" | "permission" | "unsupported" | "unknown" {
    const msg = (error || "").toLowerCase();
    if (msg.includes("rich media transfer failed") || msg.includes("rich media")) return "rich_media";
    if (msg.includes("timeout")) return "timeout";
    if (msg.includes("websocket not open") || msg.includes("econn") || msg.includes("connection")) return "connection";
    if (msg.includes("permission") || msg.includes("forbidden") || msg.includes("denied")) return "permission";
    if (msg.includes("unsupported") || msg.includes("not supported") || msg.includes("unknown action")) return "unsupported";
    return "unknown";
}

function parseGroupIdFromTarget(to: string): number | null {
    const normalized = normalizeQQDeliveryTarget(to);
    const { base } = splitTmpSuffix(normalized);
    if (!/^group:/i.test(base)) return null;
    const n = parseInt(base.replace(/^group:/i, ""), 10);
    return Number.isFinite(n) ? n : null;
}

function parseUserIdFromTarget(to: string): number | null {
    const trimmed = normalizeQQDeliveryTarget(String(to || "").trim());
    const { base } = splitTmpSuffix(trimmed);
    const raw = base.replace(/^(?:qq:)/i, "");
    const match = raw.match(/^(?:user:)?(\d{5,12})$/i);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    return Number.isFinite(n) ? n : null;
}

function guessFileName(input: string): string {
    try {
        if (/^https?:\/\//i.test(input)) {
            const parsed = new URL(input);
            const fname = parsed.searchParams.get("fname") || parsed.searchParams.get("filename") || parsed.searchParams.get("name");
            if (fname && fname.trim()) return path.basename(decodeURIComponent(fname.trim()));
        }
    } catch { }
    const local = toLocalPathIfAny(input);
    const name = path.basename(local || input.split("?")[0].split("#")[0]);
    if (!name || name === "." || name === "/") return `media_${Date.now()}.bin`;
    return name;
}

function sanitizeQQFileName(input: string | undefined | null, fallback = "file.bin"): string {
    const raw = String(input || "").trim() || fallback;
    const base = path.basename(raw.replace(/\\/g, "/"));
    const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
    return cleaned || fallback;
}

async function stageLocalFileForContainer(localPath: string, hostSharedDir: string, containerSharedDir: string): Promise<string | null> {
    if (!hostSharedDir) return null;
    try {
        const copiedName = await ensureFileInSharedMedia(localPath, hostSharedDir);
        return path.posix.join(containerSharedDir.replace(/\\/g, "/"), copiedName);
    } catch (err) {
        console.warn(`[QQ] Failed to stage local file into shared media dir: ${String(err)}`);
        return null;
    }
}

async function uploadGroupFile(
    client: OneBotClient,
    groupId: number,
    filePath: string,
    fileName: string,
): Promise<{ ok: boolean; data?: any; error?: string }> {
    try {
        const data = await (client as any).sendWithResponse("upload_group_file", {
            group_id: groupId,
            file: filePath,
            name: fileName,
        }, 30000);
        return { ok: true, data };
    } catch (err) {
        return { ok: false, error: String(err) };
    }
}

async function uploadPrivateFile(
    client: OneBotClient,
    userId: number,
    filePath: string,
    fileName: string,
): Promise<{ ok: boolean; data?: any; error?: string }> {
    try {
        const data = await (client as any).sendWithResponse("upload_private_file", {
            user_id: userId,
            file: filePath,
            name: fileName,
        }, 30000);
        return { ok: true, data };
    } catch (err) {
        return { ok: false, error: String(err) };
    }
}

async function uploadFileToTarget(
    client: OneBotClient,
    to: string,
    filePath: string,
    fileName: string,
): Promise<{ ok: boolean; data?: any; error?: string; transport?: "upload_group_file" | "upload_private_file" }> {
    const groupId = parseGroupIdFromTarget(to);
    if (groupId) {
        const result = await uploadGroupFile(client, groupId, filePath, fileName);
        return { ...result, transport: "upload_group_file" };
    }
    const userId = parseUserIdFromTarget(to);
    if (userId) {
        const result = await uploadPrivateFile(client, userId, filePath, fileName);
        return { ...result, transport: "upload_private_file" };
    }
    return { ok: false, error: `File upload unsupported for target: ${to}` };
}

async function findRecentAudioFallback(preferredExt?: string): Promise<string | null> {
    const home = process.env.HOME;
    if (!home) return null;
    const fallbackDir = path.join(home, ".openclaw", "workspace", "voicevox_output");
    try {
        const entries = await fs.readdir(fallbackDir, { withFileTypes: true });
        const candidates = entries
            .filter((entry) => entry.isFile())
            .map((entry) => path.join(fallbackDir, entry.name))
            .filter((filePath) => isAudioFile(filePath));
        if (candidates.length === 0) return null;

        const preferred = preferredExt ? candidates.filter((filePath) => filePath.toLowerCase().endsWith(preferredExt.toLowerCase())) : [];
        const pool = preferred.length > 0 ? preferred : candidates;

        let bestPath: string | null = null;
        let bestMtime = 0;
        for (const filePath of pool) {
            const stat = await fs.stat(filePath);
            const mtime = stat.mtimeMs || 0;
            if (mtime > bestMtime) {
                bestMtime = mtime;
                bestPath = filePath;
            }
        }
        return bestPath;
    } catch {
        return null;
    }
}

async function readLocalFileAsBase64(localPath: string, readFile?: (filePath: string) => Promise<Buffer>): Promise<string> {
    const data = readFile ? await readFile(localPath) : await fs.readFile(localPath);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
    return `base64://${buffer.toString("base64")}`;
}

async function ensureFileInSharedMedia(localPath: string, hostSharedDir: string): Promise<string> {
    const ext = path.extname(localPath) || ".dat";
    const baseName = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`;
    await fs.mkdir(hostSharedDir, { recursive: true });
    const destPath = path.join(hostSharedDir, baseName);
    await fs.copyFile(localPath, destPath);
    return baseName;
}

function toLocalPathIfAny(value: string, workspaceDir?: string): string | null {
    if (!value) return null;
    if (value.startsWith("file:")) {
        try {
            return fileURLToPath(value);
        } catch {
            return null;
        }
    }
    if (
        value.startsWith("/") ||
        value.startsWith("./") ||
        value.startsWith("../") ||
        /^[A-Za-z]:[\\/]/.test(value)
    ) {
        return path.isAbsolute(value) ? value : path.resolve(workspaceDir || process.cwd(), value);
    }
    return null;
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

function resolveOutboundMessageId(...candidates: Array<unknown>): string {
    for (const candidate of candidates) {
        if (candidate && typeof candidate === "object") {
            const fromAck = (candidate as any).message_id ?? (candidate as any).messageId ?? (candidate as any).file_id ?? (candidate as any).fileId;
            if (fromAck !== undefined && fromAck !== null && String(fromAck).trim()) {
                return String(fromAck).trim();
            }
            continue;
        }
        if (candidate !== undefined && candidate !== null && String(candidate).trim()) {
            return String(candidate).trim();
        }
    }
    return `qq-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function extractOutboundMessageId(candidate: unknown): string | undefined {
    if (!candidate || typeof candidate !== "object") return normalizeQQContextId(candidate);
    const root = (candidate as any).data && typeof (candidate as any).data === "object"
        ? (candidate as any).data
        : candidate as any;
    return normalizeQQContextId(root.message_id ?? root.messageId ?? root.msg_id ?? root.msgId);
}

function buildQQHiddenMetaBlock(params: {
    accountId: string;
    userId: number;
    isGroup: boolean;
    isGuild: boolean;
    groupId?: number;
    guildId?: string;
    channelId?: string;
    conversationLabel: string;
    sessionLabel: string;
    senderName?: string;
    senderRole?: string;
    isAdmin: boolean;
    activeTempSlot: string | null;
    mentionedByAt: boolean;
    mentionedByReply: boolean;
    keywordTriggered: boolean;
}): string {
    const chatType = params.isGroup ? "group" : params.isGuild ? "guild" : "direct";
    const triggerSummary = [
        params.mentionedByAt ? "mention" : "",
        params.mentionedByReply ? "reply" : "",
        params.keywordTriggered ? "keyword" : "",
    ].filter(Boolean).join(",");
    const lines = [
        "<qq_context>",
        `accountId=${params.accountId}`,
        `chatType=${chatType}`,
        `userId=${params.userId}`,
        params.isGroup ? `groupId=${String(params.groupId ?? "")}` : "",
        params.isGuild ? `guildId=${String(params.guildId ?? "")}` : "",
        params.isGuild ? `channelId=${String(params.channelId ?? "")}` : "",
        `senderName=${params.senderName || "unknown"}`,
        `senderRole=${params.senderRole || "unknown"}`,
        `isAdmin=${String(params.isAdmin)}`,
        `trigger=${triggerSummary || "normal"}`,
        `tempSession=${params.activeTempSlot || "none"}`,
        `conversationLabel=${params.conversationLabel}`,
        `sessionLabel=${params.sessionLabel}`,
        "</qq_context>",
    ].filter(Boolean);
    return `${lines.join("\n")}\n\n`;
}

function resolveReplySessionSourceLabel(activeTempSlot: string | null): string {
    const cleaned = sanitizeTempSlotName(activeTempSlot || "");
    return cleaned ? `会话${cleaned}` : "主会话";
}

function buildReplySessionSourcePrefix(activeTempSlot: string | null): string {
    return `（来自${resolveReplySessionSourceLabel(activeTempSlot)}）`;
}

function normalizeAssistantTextPhase(value: unknown): "commentary" | "final_answer" | undefined {
    return value === "commentary" || value === "final_answer" ? value : undefined;
}

function resolveReplyPayloadPhase(payload: any): "commentary" | "final_answer" | undefined {
    const directPhase = normalizeAssistantTextPhase(payload?.phase);
    if (directPhase) return directPhase;
    const rawSignature = payload?.textSignature;
    if (typeof rawSignature === "string") {
        const trimmed = rawSignature.trim();
        if (!trimmed.startsWith("{")) return undefined;
        try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            return normalizeAssistantTextPhase(parsed.phase);
        } catch {
            return undefined;
        }
    }
    if (rawSignature && typeof rawSignature === "object") {
        return normalizeAssistantTextPhase((rawSignature as Record<string, unknown>).phase);
    }
    return undefined;
}

function isInternalNoticeLine(line: string): boolean {
    const text = line.trim();
    if (!text) return false;
    if (/^↪️?\s*Model Fallback:/i.test(text)) return true;
    if (/Model Fallback:/i.test(text) && /selected model unavailable/i.test(text)) return true;
    if (/当前服务无响应.*备用线路/.test(text)) return true;
    if (/没拿到内容，?重发一次/.test(text)) return true;
    if (/这边没拿到结果，?重发一次/.test(text)) return true;
    if (/^[-–—*•]*\s*(System|Developer|Assistant|Human|User|Tool|Function|Analysis|Commentary|Final)\s*[:：]/i.test(text)) return true;
    return /^[-–—*•]*\s*(系统|开发者|助手|用户|工具|函数|分析|旁白|状态|模型切换|模型回退)\s*[:：]/.test(text);
}

function stripInternalNoticeText(input: string): string {
    return input
        .split(/\r?\n/)
        .filter((line) => !isInternalNoticeLine(line))
        .join("\n")
        .trim();
}

function escapeRegExpText(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortenVisibleModelRefs(input: string): string {
    let text = input;
    const providers = [
        "agentrouter-completions",
        "agentrouter",
        "deepseek",
        "openrouter",
        "openai",
        "anthropic",
        "google",
        "github-copilot",
        "copilot",
        "z.ai",
        "zai",
    ];
    for (const provider of providers) {
        const re = new RegExp(`\\b${escapeRegExpText(provider)}\\/([A-Za-z0-9][A-Za-z0-9._:-]{1,120})`, "g");
        text = text.replace(re, "$1");
    }
    return text;
}

function normalizeQQVisibleText(input: string): string {
    let text = stripInternalNoticeText(input);
    text = shortenVisibleModelRefs(text);
    text = text.replace(/[。．.]\s*$/u, "");
    text = text.replace(/([\u4e00-\u9fff])\s+([\p{Extended_Pictographic}\u2600-\u27bf])/gu, "$1$2");
    return text.trim();
}

async function sendLongTextAsForwardMessage(params: {
    client: OneBotClient;
    groupId?: number;
    userId?: number;
    text?: string;
    texts?: string[];
    nodeName: string;
    nodeUin: string;
    nodeCharLimit: number;
}): Promise<boolean> {
    const rawTexts = (Array.isArray(params.texts) ? params.texts : [params.text ?? ""])
        .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
    if (rawTexts.length === 0) return false;

    const buildForwardMessages = (nodeCharLimit: number) => {
        const shouldSplitNodes = Number.isFinite(nodeCharLimit) && nodeCharLimit > 0;
        const safeNodeLimit = shouldSplitNodes ? Math.max(200, Math.floor(nodeCharLimit)) : 0;
        const chunks = shouldSplitNodes
            ? rawTexts.flatMap((text) => splitMessage(text, safeNodeLimit))
            : [rawTexts.join("")];
        return chunks
            .filter((chunk) => typeof chunk === "string" && chunk.trim().length > 0)
            .map((chunk) => ({
                type: "node",
                data: {
                    name: params.nodeName,
                    uin: params.nodeUin,
                    content: chunk,
                },
            }));
    };

    const attemptForwardSend = async (messages: Array<Record<string, unknown>>, label: string): Promise<boolean> => {
        const groupId = typeof params.groupId === "number" && Number.isFinite(params.groupId) ? params.groupId : undefined;
        const userId = typeof params.userId === "number" && Number.isFinite(params.userId) ? params.userId : undefined;
        const targetLabel = groupId !== undefined ? `group=${groupId}` : userId !== undefined ? `user=${userId}` : "target=unknown";
        const tries: Array<{ action: string; params: Record<string, unknown> }> = groupId !== undefined
            ? [
                { action: "send_group_forward_msg", params: { group_id: groupId, messages } },
                { action: "send_forward_msg", params: { group_id: groupId, messages } },
            ]
            : userId !== undefined
                ? [
                    { action: "send_private_forward_msg", params: { user_id: userId, messages } },
                    { action: "send_forward_msg", params: { user_id: userId, messages } },
                ]
                : [];
        if (tries.length === 0) return false;
        for (const attempt of tries) {
            try {
                await (params.client as any).sendWithResponse(attempt.action, attempt.params, 15000);
                console.log(`[QQ] forward-send success mode=${label} nodes=${messages.length} ${targetLabel} action=${attempt.action}`);
                return true;
            } catch (err) {
                console.warn(`[QQ] forward-send failed mode=${label} nodes=${messages.length} ${targetLabel} action=${attempt.action} err=${String(err)}`);
            }
        }
        return false;
    };

    const preferredNodeLimitRaw = Number(params.nodeCharLimit);
    const preferredNodeLimit = Number.isFinite(preferredNodeLimitRaw) ? preferredNodeLimitRaw : 0;
    const preferredMessages = buildForwardMessages(preferredNodeLimit);
    if (preferredMessages.length > 0 && await attemptForwardSend(preferredMessages, preferredNodeLimit > 0 ? `split_${Math.floor(preferredNodeLimit)}` : "single_node")) {
        return true;
    }

    if (preferredNodeLimit <= 0) {
        const fallbackNodeLimit = 2400;
        const fallbackMessages = buildForwardMessages(fallbackNodeLimit);
        if (fallbackMessages.length > 1 && await attemptForwardSend(fallbackMessages, `fallback_split_${fallbackNodeLimit}`)) {
            return true;
        }
    }
    return false;
}

function stripMarkdown(text: string): string {
    return text
        .replace(/\*\*(.*?)\*\*/g, "$1") // Bold
        .replace(/\*(.*?)\*/g, "$1")     // Italic
        .replace(/`(.*?)`/g, "$1")       // Inline code
        .replace(/#+\s+(.*)/g, "$1")     // Headers
        .replace(/\[(.*?)\]\(.*?\)/g, "$1") // Links
        .replace(/^\s*>\s+(.*)/gm, "▎$1") // Blockquotes
        .replace(/```[\s\S]*?```/g, "[代码块]") // Code blocks
        .replace(/^\|.*\|$/gm, (match) => { // Simple table row approximation
            return match.replace(/\|/g, " ").trim();
        })
        .replace(/^[\-\*]\s+/gm, "• "); // Lists
}

function processAntiRisk(text: string): string {
    return text.replace(/(https?:\/\/)/gi, "$1 ");
}

async function resolveMediaUrl(url: string, opts?: { workspaceDir?: string; readFile?: (filePath: string) => Promise<Buffer> }): Promise<string> {
    if (url.startsWith("file:")) {
        try {
            const localPath = fileURLToPath(url);
            return await readLocalFileAsBase64(localPath, opts?.readFile);
        } catch (e) {
            const preferredExt = path.extname(url);
            const fallback = await findRecentAudioFallback(preferredExt);
            if (fallback) {
                try {
                    console.warn(`[QQ] Local media missing, fallback to recent audio: ${fallback}`);
                    return await readLocalFileAsBase64(fallback, opts?.readFile);
                } catch { }
            }
            console.warn(`[QQ] Failed to convert local file to base64: ${e}`);
            return url;
        }
    }

    const looksLocalPath =
        url.startsWith("/") ||
        url.startsWith("./") ||
        url.startsWith("../") ||
        /^[A-Za-z]:[\\/]/.test(url);
    if (looksLocalPath) {
        try {
            const absolutePath = path.isAbsolute(url) ? url : path.resolve(opts?.workspaceDir || process.cwd(), url);
            return await readLocalFileAsBase64(absolutePath, opts?.readFile);
        } catch (e) {
            if (isAudioFile(url)) {
                const preferredExt = path.extname(url);
                const fallback = await findRecentAudioFallback(preferredExt);
                if (fallback) {
                    try {
                        console.warn(`[QQ] Local audio path unavailable, fallback to ${fallback}`);
                        return await readLocalFileAsBase64(fallback, opts?.readFile);
                    } catch { }
                }
            }
            console.warn(`[QQ] Failed to read local media path for base64 conversion: ${url} (${e})`);
            return url;
        }
    }

    return url;
}

async function resolveInlineCqRecord(text: string): Promise<string> {
    const regex = /\[CQ:record,([^\]]*)\]/g;
    let result = text;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        const whole = match[0];
        const params = match[1];
        const fileMatch = params.match(/(?:^|,)file=([^,]+)/);
        if (!fileMatch) continue;
        const rawFile = fileMatch[1].trim();
        const decoded = rawFile.replace(/&amp;/g, "&");
        const converted = await resolveMediaUrl(decoded);
        if (converted === decoded) continue;
        const nextParams = params.replace(fileMatch[1], converted);
        result = result.replace(whole, `[CQ:record,${nextParams}]`);
    }
    return result;
}

async function sendOneBotMessageWithAck(client: OneBotClient, to: string, message: OneBotMessage | string): Promise<{ ok: boolean; data?: any; error?: string }> {
    try {
        if (to.startsWith("group:")) {
            const data = await client.sendGroupMsgAck(parseInt(to.replace("group:", ""), 10), message);
            return { ok: true, data };
        }
        if (to.startsWith("guild:")) {
            const parts = to.split(":");
            if (parts.length >= 3) {
                const data = await client.sendGuildChannelMsgAck(parts[1], parts[2], message);
                return { ok: true, data };
            }
            return { ok: false, error: `Invalid guild target: ${to}` };
        }
        const userId = parseUserIdFromTarget(to);
        if (!userId) {
            return { ok: false, error: `Invalid private target: ${to}` };
        }
        const data = await client.sendPrivateMsgAck(userId, message);
        return { ok: true, data };
    } catch (err) {
        return { ok: false, error: String(err) };
    }
}

function collectOutboundMediaItemsFromPayload(payload: any): QQOutboundMediaItem[] {
    const items: QQOutboundMediaItem[] = [];
    const push = (url: unknown, name?: unknown, kind?: unknown) => {
        if (typeof url !== "string") return;
        const trimmed = url.trim();
        if (!trimmed) return;
        const kindHint = normalizeOutboundMediaKind(kind);
        items.push({
            url: trimmed,
            ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
            ...(kindHint ? { kind: kindHint } : {}),
        });
    };
    const pushObject = (value: unknown, defaultKind?: MediaKind) => {
        if (typeof value === "string") {
            push(value, undefined, defaultKind);
            return;
        }
        if (!value || typeof value !== "object") return;
        const obj = value as Record<string, unknown>;
        const kindHint = normalizeOutboundMediaKind(obj.kind)
            ?? normalizeOutboundMediaKind(obj.type)
            ?? normalizeOutboundMediaKind(obj.mediaType)
            ?? normalizeOutboundMediaKind(obj.mimeType)
            ?? defaultKind;
        push(
            obj.url ?? obj.mediaUrl ?? obj.imageUrl ?? obj.stickerUrl ?? obj.emojiUrl ?? obj.localPath ?? obj.path ?? obj.filePath ?? obj.file,
            obj.name ?? obj.filename ?? obj.fileName ?? obj.title,
            kindHint,
        );
    };

    if (Array.isArray(payload?.mediaUrls)) {
        for (const url of payload.mediaUrls) pushObject(url);
    }
    push(payload?.mediaUrl, undefined, payload?.mediaKind ?? payload?.type ?? payload?.mimeType);

    if (Array.isArray(payload?.imageUrls)) {
        for (const image of payload.imageUrls) pushObject(image, "image");
    }
    push(payload?.imageUrl, payload?.imageName ?? payload?.name, "image");
    pushObject(payload?.image, "image");

    if (Array.isArray(payload?.images)) {
        for (const image of payload.images) pushObject(image, "image");
    }

    if (Array.isArray(payload?.stickerUrls)) {
        for (const sticker of payload.stickerUrls) pushObject(sticker, "image");
    }
    push(payload?.stickerUrl, payload?.stickerName ?? payload?.name, "image");
    pushObject(payload?.sticker, "image");

    if (Array.isArray(payload?.stickers)) {
        for (const sticker of payload.stickers) pushObject(sticker, "image");
    }

    if (Array.isArray(payload?.emojiUrls)) {
        for (const emoji of payload.emojiUrls) pushObject(emoji, "image");
    }
    push(payload?.emojiUrl, payload?.emojiName ?? payload?.name, "image");
    pushObject(payload?.emoji, "image");

    if (Array.isArray(payload?.emojis)) {
        for (const emoji of payload.emojis) pushObject(emoji, "image");
    }

    if (Array.isArray(payload?.emoticonUrls)) {
        for (const emoticon of payload.emoticonUrls) pushObject(emoticon, "image");
    }
    push(payload?.emoticonUrl, payload?.emoticonName ?? payload?.name, "image");
    pushObject(payload?.emoticon, "image");

    if (Array.isArray(payload?.emoticons)) {
        for (const emoticon of payload.emoticons) pushObject(emoticon, "image");
    }

    if (Array.isArray(payload?.files)) {
        for (const file of payload.files) {
            pushObject(file);
        }
    }

    if (Array.isArray(payload?.attachments)) {
        for (const attachment of payload.attachments) {
            pushObject(attachment);
        }
    }

    const unique: QQOutboundMediaItem[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        const key = `${item.url}|${item.name || ""}|${item.kind || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
    }
    return unique;
}

function resolveOutboundReadFile(opts?: QQOutboundMediaOptions): ((filePath: string) => Promise<Buffer>) | undefined {
    return opts?.mediaReadFile || opts?.mediaAccess?.readFile;
}

function resolveOutboundWorkspaceDir(opts?: QQOutboundMediaOptions): string | undefined {
    const workspaceDir = opts?.mediaAccess?.workspaceDir;
    return typeof workspaceDir === "string" && workspaceDir.trim() ? workspaceDir.trim() : undefined;
}

function getRuntimeCfgForAccount(accountId: string | undefined | null): Partial<QQConfig> {
    const lookupId = normalizeAccountLookupId(accountId || DEFAULT_ACCOUNT_ID);
    return (accountConfigs.get(lookupId)
        || accountConfigs.get(normalizeAccountId(lookupId))
        || accountConfigs.get(DEFAULT_ACCOUNT_ID)
        || {}) as Partial<QQConfig>;
}

function resolveQQMessageFont(config: Partial<QQConfig> | undefined | null): number | undefined {
    const raw = Number((config as any)?.messageFont ?? 0);
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return Math.trunc(raw);
}

async function sendQQTextMessage(params: {
    client: OneBotClient;
    to: string;
    text: string;
    replyToId?: string | null;
    delayBetweenChunksMs?: number;
}): Promise<any> {
    const normalizedText = await resolveInlineCqRecord(params.text || "");
    if (!normalizedText.trim()) return null;
    const chunks = splitMessage(normalizedText, 4000);
    let lastAck: any = null;
    for (let i = 0; i < chunks.length; i += 1) {
        let message: OneBotMessage | string = chunks[i];
        if (params.replyToId && i === 0) {
            message = [{ type: "reply", data: { id: String(params.replyToId) } }, { type: "text", data: { text: chunks[i] } }];
        }
        const ack = await sendOneBotMessageWithAck(params.client, params.to, message);
        if (!ack.ok) throw new Error(ack.error || "Failed to send text");
        lastAck = ack.data;
        if (chunks.length > 1) await sleep(params.delayBetweenChunksMs ?? 1000);
    }
    return lastAck;
}

async function buildUploadableMediaRef(params: {
    mediaUrl: string;
    localSourcePath?: string | null;
    stagedSharedPath?: string | null;
    workspaceDir?: string;
    readFile?: (filePath: string) => Promise<Buffer>;
}): Promise<string> {
    if (params.stagedSharedPath) return params.stagedSharedPath;
    const localPath = params.localSourcePath || toLocalPathIfAny(params.mediaUrl, params.workspaceDir);
    if (localPath) return readLocalFileAsBase64(localPath, params.readFile);
    return params.mediaUrl;
}

async function sendQQMediaMessage(params: {
    client: OneBotClient;
    to: string;
    text?: string;
    mediaUrl: string;
    accountId?: string | null;
    replyToId?: string | null;
} & QQOutboundMediaOptions): Promise<any> {
    const mediaUrl = String(params.mediaUrl || "").trim();
    if (!mediaUrl) {
        if (params.text?.trim()) {
            const textAck = await sendQQTextMessage({ client: params.client, to: params.to, text: params.text, replyToId: params.replyToId });
            return {
                channel: "qq",
                messageId: resolveOutboundMessageId(textAck),
                timestamp: Date.now(),
                meta: { textSent: Boolean(textAck), mediaSent: false },
            };
        }
        throw new Error("mediaUrl is required");
    }

    const runtimeCfg = getRuntimeCfgForAccount(params.accountId || DEFAULT_ACCOUNT_ID);
    const hostSharedDir = typeof runtimeCfg.sharedMediaHostDir === "string" ? runtimeCfg.sharedMediaHostDir.trim() : "";
    const containerSharedDirRaw = typeof runtimeCfg.sharedMediaContainerDir === "string" ? runtimeCfg.sharedMediaContainerDir.trim() : "";
    const containerSharedDir = containerSharedDirRaw || "/openclaw_media";
    const workspaceDir = resolveOutboundWorkspaceDir(params);
    const readFile = resolveOutboundReadFile(params);

    const localSourcePath = toLocalPathIfAny(mediaUrl, workspaceDir);
    let stagedSharedPath: string | null = null;
    if (localSourcePath && hostSharedDir) {
        stagedSharedPath = await stageLocalFileForContainer(localSourcePath, hostSharedDir, containerSharedDir);
    }

    const fileName = sanitizeQQFileName(params.fileNameHint || guessFileName(mediaUrl));
    const hintedKind = normalizeOutboundMediaKind(params.mediaKindHint);
    const detectedKind = detectMediaKind(params.fileNameHint, mediaUrl);
    const sourceKind = hintedKind ?? detectedKind;

    let textAck: any = null;
    if (params.text && params.text.trim()) {
        textAck = await sendQQTextMessage({ client: params.client, to: params.to, text: params.text, replyToId: params.replyToId });
    }

    const uploadableFileRef = await buildUploadableMediaRef({
        mediaUrl,
        localSourcePath,
        stagedSharedPath,
        workspaceDir,
        readFile,
    });

    const mediaMessage: OneBotMessage = [];
    if (params.replyToId && !(params.text && params.text.trim())) mediaMessage.push({ type: "reply", data: { id: String(params.replyToId) } });

    const mediaKind = sourceKind === "image" ? "image" : params.forceDocument ? "file" : sourceKind;
    const audioLike = mediaKind === "audio";
    const imageLike = mediaKind === "image";
    const videoLike = mediaKind === "video";
    const fileLike = mediaKind === "file";

    if (audioLike && textAck) {
        const configuredDelay = Number(runtimeCfg.rateLimitMs ?? 1000);
        const delayMs = Number.isFinite(configuredDelay) ? Math.max(1200, configuredDelay) : 1200;
        await sleep(delayMs);
    }

    if (fileLike) {
        const uploadAck = await uploadFileToTarget(params.client, params.to, uploadableFileRef, fileName);
        if (uploadAck.ok) {
            return {
                channel: "qq",
                messageId: resolveOutboundMessageId(uploadAck.data, textAck),
                timestamp: Date.now(),
                meta: {
                    textSent: Boolean(textAck),
                    mediaSent: true,
                    transport: uploadAck.transport || "file_segment",
                    mediaKind: "file",
                    fileName,
                },
            };
        }
        console.warn(`[QQ] file upload failed, falling back to file segment: ${uploadAck.error || "unknown"}`);
        mediaMessage.push({ type: "file", data: { file: uploadableFileRef, name: fileName } });
    } else if (imageLike) {
        const imageFile = stagedSharedPath || await resolveMediaUrl(mediaUrl, { workspaceDir, readFile });
        mediaMessage.push({ type: "image", data: { file: imageFile } });
    } else if (audioLike) {
        const recordFile = stagedSharedPath || await resolveMediaUrl(mediaUrl, { workspaceDir, readFile });
        mediaMessage.push({ type: "record", data: { file: recordFile } });
    } else if (videoLike) {
        mediaMessage.push({ type: "video", data: { file: uploadableFileRef } });
    } else {
        mediaMessage.push({ type: "file", data: { file: uploadableFileRef, name: fileName } });
    }

    const mediaAck = await sendOneBotMessageWithAck(params.client, params.to, mediaMessage);
    if (!mediaAck.ok) {
        const primaryError = mediaAck.error || "unknown";
        const errorClass = classifyMediaError(primaryError);
        if (imageLike) {
            console.warn(`[QQ] image send failed, not falling back to file upload: ${primaryError}`);
            throw new Error(`Image send failed: ${primaryError} [${errorClass}]`);
        }
        const uploadAck = await uploadFileToTarget(params.client, params.to, uploadableFileRef, fileName);
        if (uploadAck.ok) {
            return {
                channel: "qq",
                messageId: resolveOutboundMessageId(uploadAck.data, textAck),
                timestamp: Date.now(),
                meta: {
                    textSent: Boolean(textAck),
                    mediaSent: true,
                    fallbackSent: true,
                    fallbackType: uploadAck.transport || "upload_file",
                    mediaKind,
                    fileName,
                    errorClass,
                    note: `Primary media path failed; fallback upload succeeded. reason=${primaryError}`,
                },
            };
        }
        throw new Error(`Media send failed: ${primaryError} [${errorClass}]`);
    }

    return {
        channel: "qq",
        messageId: resolveOutboundMessageId(mediaAck.data, textAck),
        timestamp: Date.now(),
        meta: {
            textSent: Boolean(textAck),
            mediaSent: true,
            mediaKind,
            fileName,
        },
    };
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
        reactions: true,
        blockStreaming: true,
        // @ts-ignore
        deleteMessage: true,
    },
    configSchema: (() => {
        const baseSchema = buildChannelConfigSchema(QQConfigSchema) as any;
        return {
            ...baseSchema,
            uiHints: {
                ...(baseSchema.uiHints || {}),
                maxRetries: {
                    label: "自动重试次数",
                    help: "默认 0（关闭）。模型报错或返回空内容时，最多再试几次；次数越大越稳，但等待也会更久。",
                },
                retryDelayMs: {
                    label: "重试间隔（毫秒）",
                    help: "默认预置 3000ms；仅在自动重试次数大于 0 时生效。",
                },
                fastFailErrors: {
                    label: "快速跳过错误关键词",
                    help: "默认关闭（空数组）。填写如 401、Unauthorized、余额不足 后，命中时会直接跳过当前模型。",
                },
                groupAutoReact: {
                    label: "群聊随机贴表情",
                    help: "默认关闭。开启后，只有本 bot 实际回复某条群消息后，才按概率给那条消息贴 QQ 表情。",
                },
                groupAutoReactProbability: {
                    label: "随机贴表情概率",
                    help: "默认 0.2。0=不随机贴，1=每次回复都贴。",
                },
                groupAutoReactEmojiIds: {
                    label: "随机贴表情池",
                    help: "填写 NapCat/QQ 的 emoji_id 列表，用逗号或空格分隔；默认使用当前 NapCat QQ 表情全集。",
                },
                groupAutoReactEmojiId: {
                    label: "兼容旧表情 ID",
                    help: "当随机贴表情池为空时使用这个单个 emoji_id。",
                },
                conversationContextLimit: {
                    label: "近期上下文条数",
                    help: "默认 10。即使群聊开启每条消息独立会话，也会把同一群/私聊最近消息注入给模型；设 0 关闭。",
                },
                conversationContextMaxChars: {
                    label: "近期上下文最大字符数",
                    help: "默认 2400。过长会优先保留最新消息。",
                },
                includeRecalledMessagesInContext: {
                    label: "保留撤回消息上下文",
                    help: "默认开启。已收到并缓存的撤回消息会以 [已撤回] 标记继续作为上下文。",
                },
                queueDebounceMs: {
                    label: "同会话消息合并窗口（毫秒）",
                    help: "默认 0（关闭）。大于 0 时，短时间连续发来的多条消息会先合并再处理。",
                },
                interruptOnNewMessage: {
                    label: "新消息打断旧回复",
                    help: "默认关闭。同一会话里来了更新的消息时，可优先切换去处理新消息。",
                },
                injectGatewayMeta: {
                    label: "注入隐藏 QQ 网关上下文",
                    help: "默认关闭。开启后会给模型注入不可见的会话来源/触发方式等上下文。",
                },
                blockStreaming: {
                    label: "按消息分块发送",
                    help: "默认开启。推荐保留开启，让 commentary / final 按完整 assistant message 落地，不再只等最后一条最终回复。",
                },
                blockStreamingBreak: {
                    label: "分块发送边界",
                    help: "默认 message_end。每条 assistant message 完成后再发，更适合 QQ 群聊，也能减少工具调用前后的边界丢失。",
                },
                enrichReplyForwardContext: {
                    label: "解析 reply/forward 多层上下文",
                    help: "默认开启。会递归展开引用和合并转发内容，方便模型理解‘你在回谁、上下文是什么’。",
                },
                forwardLongReplyThreshold: {
                    label: "长回复转合并转发阈值",
                    help: "final_answer 大于这个字符数时，自动改用 QQ 合并转发发送。默认 300；commentary 仍按普通消息发送。",
                },
                showReplySessionSource: {
                    label: "回复前标注来源会话",
                    help: "默认开启。回复前会自动加上 `（来自主会话）` 或 `（来自会话xxx）`，特别适合用了 /会话 之后快速分辨当前回复来自哪个会话。",
                },
                messageFont: {
                    label: "发送字体参数",
                    help: "默认 0 表示不显式设置。若当前 OneBot/NapCat 支持 QQ font 数字参数，可填对应字体编号，群聊和私聊都会透传。",
                },
                keywordOnlyTrigger: {
                    label: "群聊仅关键词触发",
                    help: "开启后会忽略 @ 和回复触发；群聊里只有命中关键词才会触发。",
                },
                allowBareGroupCommands: {
                    label: "允许群聊裸 slash 指令",
                    help: "默认关闭。关闭后，/model 这类群聊指令需要配合关键词触发；如果想恢复旧体验再手动开启。",
                },
            },
        };
    })(),
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
            blockStreaming: acc.config.blockStreaming ?? true,
            blockStreamingBreak: acc.config.blockStreamingBreak ?? "message_end",
            forwardLongReplyThreshold: acc.config.forwardLongReplyThreshold ?? 300,
        }),
    },
    directory: {
        listPeers: async ({ accountId }) => {
            const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
            if (!client) return [];
            try {
                const friends = await client.getFriendList();
                return friends.map(f => ({
                    kind: "user" as const,
                    id: String(f.user_id),
                    name: f.remark || f.nickname,
                    raw: { ...f }
                }));
            } catch (e) {
                return [];
            }
        },
        listGroups: async ({ accountId, cfg }) => {
            const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
            if (!client) return [];
            const list: any[] = [];

            try {
                const groups = await client.getGroupList();
                list.push(...groups.map(g => ({
                    kind: "group" as const,
                    id: String(g.group_id),
                    name: g.group_name,
                    raw: { ...g }
                })));
            } catch (e) { }

            // @ts-ignore
            const enableGuilds = cfg?.channels?.qq?.enableGuilds ?? true;
            if (enableGuilds) {
                try {
                    const guilds = await client.getGuildList();
                    list.push(...guilds.map(g => ({
                        kind: "channel" as const,
                        id: `guild:${g.guild_id}`,
                        name: `[频道] ${g.guild_name}`,
                        raw: { ...g }
                    })));
                } catch (e) { }
            }
            return list;
        }
    },
    status: {
        probeAccount: async ({ account, timeoutMs }) => {
            if (!account.config.wsUrl) return { ok: false, error: "Missing wsUrl" };

            const runningClient = clients.get(account.accountId);
            if (runningClient) {
                try {
                    const info = await Promise.race([
                        runningClient.getLoginInfo(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Probe timeout")), timeoutMs || 5000)),
                    ]);
                    const data = info as any;
                    return {
                        ok: true,
                        bot: { id: String(data?.user_id ?? ""), username: data?.nickname },
                    };
                } catch (err) {
                    return { ok: false, error: String(err) };
                }
            }

            const client = new OneBotClient({
                wsUrl: account.config.wsUrl,
                accessToken: account.config.accessToken,
            });
            client.setDefaultSendOptions({ font: resolveQQMessageFont(account.config) });

            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    client.disconnect();
                    resolve({ ok: false, error: "Connection timeout" });
                }, timeoutMs || 5000);

                client.on("connect", async () => {
                    try {
                        const info = await client.getLoginInfo();
                        clearTimeout(timer);
                        client.disconnect();
                        resolve({
                            ok: true,
                            bot: { id: String(info.user_id), username: info.nickname }
                        });
                    } catch (e) {
                        clearTimeout(timer);
                        client.disconnect();
                        resolve({ ok: false, error: String(e) });
                    }
                });

                client.on("error", (err) => {
                    clearTimeout(timer);
                    client.disconnect();
                    resolve({ ok: false, error: String(err) });
                });

                client.connect();
            });
        },
        buildAccountSnapshot: ({ account, runtime, probe }) => {
            return {
                accountId: account.accountId,
                name: account.name,
                enabled: account.enabled,
                configured: account.configured,
                running: runtime?.running ?? false,
                lastStartAt: runtime?.lastStartAt ?? null,
                lastError: runtime?.lastError ?? null,
                probe,
            };
        }
    },
    setup: {
        resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
        applyAccountName: ({ cfg, accountId, name }) =>
            applyAccountNameToChannelSection({ cfg, channelKey: "qq", accountId, name }),
        validateInput: ({ input }) => null,
        applyAccountConfig: ({ cfg, accountId, input }) => {
            const setupInput = input as QQSetupInput;
            const namedConfig = applyAccountNameToChannelSection({
                cfg,
                channelKey: "qq",
                accountId,
                name: setupInput.name,
            });

            const next = accountId !== DEFAULT_ACCOUNT_ID
                ? migrateBaseNameToDefaultAccount({ cfg: namedConfig, channelKey: "qq" })
                : namedConfig;

            const newConfig = {
                wsUrl: setupInput.wsUrl || setupInput.url || "ws://localhost:3001",
                accessToken: setupInput.accessToken,
                enabled: true,
            };

            if (accountId === DEFAULT_ACCOUNT_ID) {
                return {
                    ...next,
                    channels: {
                        ...next.channels,
                        qq: { ...next.channels?.qq, ...newConfig }
                    }
                };
            }

            return {
                ...next,
                channels: {
                    ...next.channels,
                    qq: {
                        ...next.channels?.qq,
                        enabled: true,
                        accounts: {
                            ...next.channels?.qq?.accounts,
                            [accountId]: {
                                ...next.channels?.qq?.accounts?.[accountId],
                                ...newConfig
                            }
                        }
                    }
                }
            };
        }
    },
    actions: {
        describeMessageTool: () => ({
            actions: ["react", "reactions"] as any,
            capabilities: ["presentation"] as any,
        }),
        supportsAction: ({ action }) => action === "react" || action === "reactions",
        handleAction: async ({ action, params, accountId, toolContext }) => {
            const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
            if (!client) {
                return jsonResult({
                    ok: false,
                    channel: "qq",
                    action,
                    error: "QQ client not connected",
                });
            }

            const messageId = normalizeQQMessageRef(
                pickFirstDefined(params as any, ["message_id", "messageId", "message", "id", "target_message_id", "targetMessageId"])
                ?? (toolContext as any)?.currentMessageId
            );
            if (messageId === null) {
                return jsonResult({
                    ok: false,
                    channel: "qq",
                    action,
                    error: "QQ reaction action requires message_id or current message context",
                });
            }

            if (action === "react") {
                const emojiId = normalizeQQEmojiRef(
                    pickFirstDefined(params as any, ["emoji_id", "emojiId", "emoji", "reaction", "code"])
                );
                if (emojiId === null) {
                    return jsonResult({
                        ok: false,
                        channel: "qq",
                        action,
                        error: "QQ react requires emoji_id",
                    });
                }
                const set = normalizeQQEmojiSetFlag(
                    pickFirstDefined(params as any, ["set", "is_set", "add", "enabled", "value"])
                );
                const result = await setQQMessageEmojiLike({ client, messageId, emojiId, set });
                return jsonResult({
                    ok: result.ok,
                    channel: "qq",
                    action,
                    message_id: messageId,
                    emoji_id: emojiId,
                    set,
                    data: result.data,
                    error: result.error,
                });
            }

            const emojiId = normalizeQQEmojiRef(
                pickFirstDefined(params as any, ["emoji_id", "emojiId", "emoji", "reaction", "code"])
            );
            if (emojiId === null) {
                const summary = await getQQMessageEmojiLikeSummary({ client, messageId });
                return jsonResult({
                    ok: summary.ok,
                    channel: "qq",
                    action,
                    message_id: messageId,
                    summaries: summary.summaries ?? [],
                    data: summary.data,
                    error: summary.error,
                });
            }

            const users = await getQQMessageEmojiLikeUsers({
                client,
                messageId,
                emojiId,
                groupId: pickFirstDefined(params as any, ["group_id", "groupId"]),
                emojiType: pickFirstDefined(params as any, ["emoji_type", "emojiType"]),
                count: pickFirstDefined(params as any, ["count", "limit"]),
            });
            return jsonResult({
                ok: users.ok,
                channel: "qq",
                action,
                message_id: messageId,
                emoji_id: emojiId,
                users: users.users ?? [],
                data: users.data,
                error: users.error,
            });
        },
    },
    gateway: {
        startAccount: async (ctx) => {
            const { account, cfg } = ctx;
            await ensureLegacyQQSessionMigration();
            const config = account.config;
            accountConfigs.set(account.accountId, config);
            const adminIds = [...new Set(parseIdListInput(config.admins as string | number | Array<string | number> | undefined))];
            const allowedGroupIds = [...new Set(parseIdListInput(config.allowedGroups as string | number | Array<string | number> | undefined))];
            const blockedUserIds = [...new Set(parseIdListInput(config.blockedUsers as string | number | Array<string | number> | undefined))];
            const blockedNotifyCooldownMs = Math.max(0, Number(config.blockedNotifyCooldownMs ?? 10000));

            if (!config.wsUrl) throw new Error("QQ: wsUrl is required");

            const existingLiveClient = clients.get(account.accountId);
            if (existingLiveClient?.isConnected()) {
                console.log(`[QQ] Existing live client detected for account ${account.accountId}; skip duplicate start`);
                await new Promise<void>((resolve) => {
                    if (ctx.abortSignal.aborted) {
                        resolve();
                        return;
                    }
                    ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
                });
                return;
            }
            const accountGen = (accountStartGeneration.get(account.accountId) || 0) + 1;
            accountStartGeneration.set(account.accountId, accountGen);

            // 1. Prevent multiple clients for the same account
            const existingSet = allClientsByAccount.get(account.accountId);
            if (existingSet && existingSet.size > 0) {
                console.log(`[QQ] Disconnecting ${existingSet.size} stale client(s) for account ${account.accountId}`);
                for (const stale of existingSet) {
                    try { stale.disconnect(); } catch { }
                }
                existingSet.clear();
            }
            const existingClient = clients.get(account.accountId);
            if (existingClient) {
                console.log(`[QQ] Stopping existing client for account ${account.accountId} before restart`);
                existingClient.disconnect();
            }

            const client = new OneBotClient({
                wsUrl: config.wsUrl,
                accessToken: config.accessToken,
            });
            client.setDefaultSendOptions({ font: resolveQQMessageFont(config) });

            const isStaleGeneration = () => accountStartGeneration.get(account.accountId) !== accountGen;

            clients.set(account.accountId, client);
            const clientSet = allClientsByAccount.get(account.accountId) || new Set<OneBotClient>();
            clientSet.add(client);
            allClientsByAccount.set(account.accountId, clientSet);
            ensureGlobalProcessedMsgCleanupTimer();

            client.on("connect", async () => {
                if (isStaleGeneration()) {
                    console.log(`[QQ] Ignore stale client connect for account ${account.accountId} gen=${accountGen}`);
                    client.disconnect();
                    return;
                }
                console.log(`[QQ] Connected account ${account.accountId}`);
                try {
                    const info = await client.getLoginInfo();
                    if (info && info.user_id) client.setSelfId(info.user_id);
                    if (info && info.nickname) console.log(`[QQ] Logged in as: ${info.nickname} (${info.user_id})`);
                    getQQRuntime().channel.activity.record({
                        channel: "qq", accountId: account.accountId, direction: "inbound",
                    });
                } catch (err) { }
            });

            client.on("heartbeat", () => {
                if (isStaleGeneration()) return;
                getQQRuntime().channel.activity.record({
                    channel: "qq",
                    accountId: account.accountId,
                    direction: "inbound",
                });
            });

            client.on("request", (event) => {
                if (isStaleGeneration()) return;
                if (config.autoApproveRequests) {
                    if (event.request_type === "friend") client.setFriendAddRequest(event.flag, true);
                    else if (event.request_type === "group") client.setGroupAddRequest(event.flag, event.sub_type, true);
                }
            });

            client.on("message", async (event) => {
                try {
                    if (isStaleGeneration()) return;
                    getQQRuntime().channel.activity.record({
                        channel: "qq",
                        accountId: account.accountId,
                        direction: "inbound",
                    });
                    if (event.post_type === "message") {
                        const rawPreview = typeof event.raw_message === "string"
                            ? event.raw_message.replace(/\s+/g, " ").slice(0, 160)
                            : "";
                        if (rawPreview.includes("/") || rawPreview.includes("临时") || rawPreview.includes("会话")) {
                            console.log(
                                `[QQEVT] inbound type=${event.message_type ?? "-"} group=${event.group_id ?? "-"} user=${event.user_id ?? "-"} msg="${rawPreview}"`
                            );
                        }
                    }
                    if (event.post_type === "meta_event") {
                        if (event.meta_event_type === "lifecycle" && event.sub_type === "connect" && event.self_id) client.setSelfId(event.self_id);
                        return;
                    }

                    if (isQQEmojiLikeNotice(event)) {
                        console.log(`[QQ] emoji-like notice ${summarizeQQEmojiLikeNotice(event)}`);
                        return;
                    }

                    if (isQQRecallNotice(event)) {
                        markQQConversationMessageRecalled({ accountId: account.accountId, event });
                        console.log(`[QQ] recall notice ${summarizeQQRecallNotice(event)}`);
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

                    // 2. Dynamic self-message filtering
                    const selfId = client.getSelfId() || event.self_id;
                    if (selfId && String(event.user_id) === String(selfId)) return;

                    if (config.enableDeduplication !== false && event.message_id) {
                        const msgIdKey = `${account.accountId}:${event.self_id ?? ""}:${event.message_type ?? ""}:${event.group_id ?? ""}:${event.user_id ?? ""}:${String(event.message_id)}`;
                        if (globalProcessedMsgIds.has(msgIdKey)) return;
                        globalProcessedMsgIds.add(msgIdKey);
                    }

                    const isGroup = event.message_type === "group";
                    const isGuild = event.message_type === "guild";

                    if (isGuild && !config.enableGuilds) return;

                    const userId = event.user_id;
                    const groupId = event.group_id;
                    const guildId = event.guild_id;
                    const channelId = event.channel_id;

                    const inboundRawMessage = typeof event.raw_message === "string" ? event.raw_message : "";
                    let text = inboundRawMessage || "";
                    const fileHints: QQInboundAttachmentHint[] = [];
                    const audioHints: QQInboundAttachmentHint[] = [];
                    const imageHints: string[] = [];
                    const imageHintMeta = new Map<string, { fileName?: string; mimeType?: string }>();
                    let hasCurrentInboundNonTextContent =
                        /\[CQ:(?:image|mface|face|emoji|emoticon|sticker|marketface|file|record|video|forward|forward_msg|nodes|music)[,\]]/i.test(inboundRawMessage) ||
                        extractTextualEmojiPlaceholders(inboundRawMessage).length > 0;

                    if (Array.isArray(event.message)) {
                        let resolvedText = "";
                        for (const seg of event.message) {
                            if (seg.type === "text") resolvedText += normalizeInboundTextEntities(seg.data?.text || "");
                            else if (seg.type === "at") {
                                let name = seg.data?.qq;
                                if (name !== "all" && isGroup) {
                                    const cached = getCachedMemberName(String(groupId), String(name));
                                    if (cached) name = cached;
                                    else {
                                        try {
                                            const info = await (client as any).sendWithResponse("get_group_member_info", { group_id: groupId, user_id: name }, QQ_CONTEXT_FETCH_TIMEOUT_MS);
                                            name = info?.card || info?.nickname || name;
                                            setCachedMemberName(String(groupId), String(seg.data.qq), name);
                                        } catch (e) { }
                                    }
                                }
                                resolvedText += `@${name}`;
                            } else if (seg.type === "record") {
                                hasCurrentInboundNonTextContent = true;
                                const audioHint = await collectAudioHintFromOneBotSegment(seg);
                                rememberAttachmentHint(audioHints, audioHint);
                                resolvedText += ` [语音消息]${seg.data?.text ? `(${seg.data.text})` : ""}`;
                            }
                            else if (isImageLikeOneBotSegment(seg)) {
                                hasCurrentInboundNonTextContent = true;
                                const imageUrl = seg.type === "image"
                                    ? await resolveOneBotImageUrl(client, seg)
                                    : readOneBotImageLikeUrl(seg);
                                const label = getOneBotImageLikeLabel(seg);
                                if (imageUrl) {
                                    rememberImageHint(imageHints, imageHintMeta, {
                                        url: imageUrl,
                                        fileName: typeof seg.data?.file === "string" ? guessFileName(seg.data.file) : undefined,
                                        mimeType: inferImageMimeType(typeof seg.data?.file === "string" ? seg.data.file : undefined),
                                    });
                                    resolvedText += ` [表情图片:${label}, ${imageUrl}]`;
                                } else {
                                    resolvedText += ` [表情图片:${label}]`;
                                }
                            }
                            else if (seg.type === "video") {
                                hasCurrentInboundNonTextContent = true;
                                const videoHint = await collectVideoHintFromOneBotSegment(seg);
                                rememberAttachmentHint(fileHints, videoHint);
                                if (videoHint?.url) resolvedText += ` [视频: ${videoHint.url}]`;
                                else resolvedText += " [视频消息]";
                            }
                            else if (seg.type === "json" || seg.type === "xml" || seg.type === "share") {
                                const cardSummary = summarizeOneBotLinkLikeSegment(seg);
                                resolvedText += cardSummary.text || " [卡片消息]";
                            }
                            else if (seg.type === "forward" && seg.data?.id) {
                                hasCurrentInboundNonTextContent = true;
                                try {
                                    const forwardData = await withSoftTimeout(
                                        client.getForwardMsg(seg.data.id, QQ_CONTEXT_FETCH_TIMEOUT_MS),
                                        QQ_CONTEXT_FETCH_TIMEOUT_MS,
                                        null,
                                        "current forward preview",
                                    );
                                    if (forwardData?.messages) {
                                        resolvedText += "\n[转发聊天记录]:";
                                        for (const m of forwardData.messages.slice(0, 10)) {
                                            resolvedText += `\n${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.content || m.raw_message)}`;
                                        }
                                    }
                                } catch (e) { }
                            } else if (seg.type === "file") {
                                hasCurrentInboundNonTextContent = true;
                                const fileHint = await collectFileHintFromOneBotSegment(client, seg, { groupId: isGroup ? groupId : undefined, userId });
                                rememberAttachmentHint(fileHints, fileHint);
                                const shortHint = fileHint?.url
                                    ? ` [文件: ${fileHint.name}, 下载=${fileHint.url}]`
                                    : fileHint?.fileId
                                        ? ` [文件: ${fileHint.name}, file_id=${fileHint.fileId}${fileHint.busid ? `, busid=${fileHint.busid}` : ""}]`
                                        : ` [文件: ${fileHint?.name || "未命名"}]`;
                                resolvedText += shortHint;
                            } else if (seg.type && seg.type !== "reply") {
                                hasCurrentInboundNonTextContent = true;
                            }
                        }
                        if (resolvedText) text = normalizeInboundTextEntities(resolvedText);
                    }
                    text = normalizeInboundTextEntities(text);

                    if (blockedUserIds.includes(userId)) return;
                    if (isGroup && allowedGroupIds.length && !allowedGroupIds.includes(groupId)) return;

                    rememberQQConversationMessage({
                        accountId: account.accountId,
                        isGroup,
                        isGuild,
                        groupId,
                        guildId,
                        channelId,
                        userId,
                        senderName: event.sender?.card || event.sender?.nickname || event.sender?.user_id || userId,
                        source: "user",
                        text,
                        messageId: event.message_id,
                        timestampMs: event.time,
                    });

                    const isAdmin = adminIds.includes(userId);
                    await ensureTempSessionSlotsLoaded();
                    const threadSessionKey = buildTempThreadKey(account.accountId, isGroup, isGuild, groupId, guildId, channelId, userId);
                    let activeTempSlot = getTempSessionSlot(threadSessionKey);
                    const extractedTextFromSegments = Array.isArray(event.message)
                        ? event.message
                            .filter((seg) => seg?.type === "text")
                            .map((seg) => String(seg.data?.text || ""))
                            .join(" ")
                            .trim()
                        : "";
                    const keywordTriggers = parseKeywordTriggersInput(config.keywordTriggers as string | string[] | undefined);
                    // Some OneBot variants may not emit text segments for plain messages.
                    // Fall back to already-normalized text to avoid losing slash commands.
                    const commandTextCandidate = normalizeSlashVariants(extractedTextFromSegments || text.trim());
                    const extractedInlineCommand = extractLeadingInlineCommand(commandTextCandidate, keywordTriggers);
                    const inlineCommand = extractedInlineCommand.command;
                    if (inlineCommand) {
                        const shortInline = inlineCommand.replace(/\s+/g, " ").slice(0, 160);
                        console.log(`[QQCMD] inbound user=${userId} group=${groupId ?? "-"} admin=${isAdmin} cmd="${shortInline}"`);
                    }
                    const normalizedCommandKey = inlineCommand
                        ? `${account.accountId}:${event.message_type ?? ""}:${String(groupId ?? "")}:${String(guildId ?? "")}:${String(channelId ?? "")}:${String(userId ?? "")}:${inlineCommand.replace(/\s+/g, " ").toLowerCase()}`
                        : "";
                    const hasKeywordTriggerInCommandText = extractedInlineCommand.keywordPrefixed;
                    const allowBareGroupCommands = config.allowBareGroupCommands === true;
                    const allowGroupInlineCommand = !isGroup || allowBareGroupCommands || hasKeywordTriggerInCommandText;
                    const bareInlineCommandOnly = Boolean(inlineCommand) && extractedInlineCommand.bareCommand;
                    if (normalizedCommandKey && markAndCheckRecentCommandDuplicate(normalizedCommandKey)) {
                        console.log(`[QQ] dropped duplicate command key=${normalizedCommandKey}`);
                        return;
                    }
                    if (isGroup && inlineCommand && !allowGroupInlineCommand && bareInlineCommandOnly) {
                        const shortInline = inlineCommand.replace(/\s+/g, " ").slice(0, 160);
                        console.log(`[QQCMD] ignored bare group command without keyword user=${userId} group=${groupId ?? "-"} cmd="${shortInline}"`);
                        return;
                    }

                    let forceTriggered = false;
                    if (inlineCommand && (!isGroup || allowGroupInlineCommand)) {
                        text = inlineCommand;
                        forceTriggered = true;
                    }
                    if (isGroup && /^\/models\b/i.test(inlineCommand)) {
                        if (!isAdmin) return;
                    } else if (isGroup && /^\/model\b/i.test(inlineCommand)) {
                        if (!isAdmin) return;
                    } else if (isGroup && /^\/newsession\b/i.test(inlineCommand)) {
                        if (!isAdmin) return;
                        text = "/newsession";
                    }
                    else if (isGroup && /^\/(会话重命名|临时重命名|tmprename|会话结束|临时结束|tmpend|会话列表|临时列表|tmplist|会话状态|临时状态|tmpstatus|退出会话|退出临时|exittemp|会话|临时|tmp)(?=\s|$)/i.test(inlineCommand)) {
                        if (!isAdmin) {
                            console.warn(`[QQCMD] session command denied: non-admin user=${userId} group=${groupId ?? "-"}`);
                            if (config.notifyNonAdminBlocked) {
                                client.sendGroupMsg(groupId, "当前仅管理员可使用会话命令。");
                            }
                            return;
                        }
                        text = inlineCommand;
                        console.log(`[QQCMD] session command accepted user=${userId} group=${groupId ?? "-"}`);
                    }
                    else if (isGroup && /^\/grok_draw\b/i.test(inlineCommand)) {
                        if (!isAdmin) return;
                        text = inlineCommand;
                    }
                    else if (isGroup && /^\/modelsync\b/i.test(inlineCommand)) {
                        if (!isAdmin) return;
                        text = "/modelsync";
                    }

                    const normalizedTextForCommand = normalizeSlashVariants(text).trim();
                    const allowLocalSlashCommandExecution = !isGroup || forceTriggered || allowBareGroupCommands;
                    if (!isGuild && isAdmin && normalizedTextForCommand.startsWith('/') && allowLocalSlashCommandExecution) {
                        const parts = normalizedTextForCommand.split(/\s+/);
                        const cmd = parts[0];
                        const baseFromIdForCommand = isGroup
                            ? String(groupId)
                            : isGuild
                                ? `guild:${guildId}:${channelId}`
                                : String(userId);

                        if (cmd === '/会话' || cmd === '/临时' || cmd === '/tmp') {
                            const rawArg = parts.slice(1).join(' ').trim();
                            if (!rawArg) {
                                const current = activeTempSlot
                                    ? `当前会话: ${activeTempSlot}`
                                    : "当前会话: 默认会话";
                                const usage = `[OpenClawd QQ]
${current}
用法:
/会话 <名称> 新建或进入会话
/会话 <序号> 切换到已有会话
/会话重命名 <新名称> 重命名当前会话
/退出会话 回到默认会话
/会话状态 查看当前会话
/会话列表 查看已有会话
/会话结束 结束当前会话`;
                                if (isGroup) client.sendGroupMsg(groupId, usage); else client.sendPrivateMsg(userId, usage);
                                return;
                            }
                            if (/^\d+$/.test(rawArg)) {
                                const requestedIndex = Number(rawArg);
                                const selectedTarget = resolveSessionCommandTargetByIndex(threadSessionKey, requestedIndex);
                                if (!selectedTarget) {
                                    const maxIndex = listSessionCommandTargets(threadSessionKey).length;
                                    const msg = `[OpenClawd QQ]\n未找到序号 ${requestedIndex} 对应的会话。\n当前可用序号：1-${maxIndex}\n可先用 /会话列表 查看。`;
                                    if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                                    return;
                                }
                                const isAlreadyActive = selectedTarget.slot
                                    ? selectedTarget.slot === activeTempSlot
                                    : !activeTempSlot;
                                if (isAlreadyActive) {
                                    const msg = `[OpenClawd QQ]\n当前已在${selectedTarget.slot ? `会话: ${selectedTarget.label}` : "默认会话"}。`;
                                    if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                                    return;
                                }
                                await setTempSessionSlot(threadSessionKey, selectedTarget.slot);
                                activeTempSlot = selectedTarget.slot;
                                const msg = selectedTarget.slot
                                    ? `[OpenClawd QQ]\n✅ 已切换到会话: ${selectedTarget.label}`
                                    : `[OpenClawd QQ]\n✅ 已切换到默认会话。`;
                                if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                                return;
                            }
                            const requested = sanitizeTempSlotName(rawArg);
                            if (!requested) {
                                const msg = `[OpenClawd QQ]\n会话名称不能为空。\n用法：/会话 <名称>`;
                                if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                                return;
                            }
                            await setTempSessionSlot(threadSessionKey, requested);
                            activeTempSlot = requested;
                            const msg = `[OpenClawd QQ]
✅ 已进入会话: ${requested}
后续消息将写入该会话，不占用默认会话。\n可用命令：/会话状态 /会话列表 /会话重命名 /退出会话 /会话结束`;
                            if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                            return;
                        }

                        if (cmd === '/会话重命名' || cmd === '/临时重命名' || cmd === '/tmprename') {
                            if (!activeTempSlot) {
                                const msg = `[OpenClawd QQ]\n当前在默认会话中，无法重命名。\n先用 /会话 <名称> 进入命名会话。`;
                                if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                                return;
                            }
                            const renamed = sanitizeTempSlotName(parts.slice(1).join(' '));
                            if (!renamed) {
                                const msg = `[OpenClawd QQ]\n用法：/会话重命名 <新名称>`;
                                if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                                return;
                            }
                            const oldName = activeTempSlot;
                            await setTempSessionSlot(threadSessionKey, renamed);
                            activeTempSlot = renamed;
                            const msg = `[OpenClawd QQ]\n✅ 会话已重命名：${oldName} -> ${renamed}`;
                            if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                            return;
                        }

                        if (cmd === '/退出会话' || cmd === '/退出临时' || cmd === '/exittemp') {
                            if (!activeTempSlot) {
                                const msg = `[OpenClawd QQ]
当前已在默认会话中。`;
                                if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                                return;
                            }
                            const prev = activeTempSlot;
                            await setTempSessionSlot(threadSessionKey, null);
                            activeTempSlot = null;
                            const msg = `[OpenClawd QQ]
✅ 已退出会话: ${prev}
当前已回到默认会话。`;
                            if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                            return;
                        }

                        if (cmd === '/会话状态' || cmd === '/临时状态' || cmd === '/tmpstatus') {
                            const effective = buildEffectiveFromId(baseFromIdForCommand, activeTempSlot);
                            const msg = `[OpenClawd QQ]
当前会话: ${activeTempSlot ? `会话(${activeTempSlot})` : '默认会话'}
会话键ID: ${effective}`;
                            if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                            return;
                        }

                        if (cmd === '/会话列表' || cmd === '/临时列表' || cmd === '/tmplist') {
                            await reloadTempSessionStateFromDisk();
                            activeTempSlot = getTempSessionSlot(threadSessionKey);
                            const slots = getTempSessionHistory(threadSessionKey);
                            console.log(`[QQ] /会话列表 thread=${threadSessionKey} slots=${slots.length}`);
                            try {
                                const rawState = await fs.readFile(TEMP_SESSION_STATE_FILE, "utf-8");
                                const parsedState = JSON.parse(rawState) as TempSessionState;
                                const diskSlots = Array.isArray(parsedState?.history?.[threadSessionKey])
                                    ? parsedState.history![threadSessionKey]!.length
                                    : 0;
                                console.error(`[QQDBG] /会话列表 thread=${threadSessionKey} mem=${slots.length} disk=${diskSlots}`);
                            } catch (err) {
                                console.error(`[QQDBG] /会话列表 read-state-failed thread=${threadSessionKey} err=${String(err)}`);
                            }
                            const rendered = renderSessionCommandTargetList(threadSessionKey, activeTempSlot);
                            const msg = `[OpenClawd QQ]\n会话列表：\n${rendered}\n使用 /会话 <名称> 新建或进入，/会话 <序号> 切换`;
                            if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                            return;
                        }

                        if (cmd === '/会话结束' || cmd === '/临时结束' || cmd === '/tmpend') {
                            if (!activeTempSlot) {
                                const msg = `[OpenClawd QQ]
当前在默认会话中，默认会话无需结束。`;
                                if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                                return;
                            }
                            const runtimeForEnd = getQQRuntime();
                            const tempFromId = buildEffectiveFromId(baseFromIdForCommand, activeTempSlot);
                            const routeForEnd = runtimeForEnd.channel.routing.resolveAgentRoute({
                                cfg,
                                channel: "qq",
                                accountId: account.accountId,
                                peer: {
                                    kind: isGuild ? "channel" : (isGroup ? "group" : "direct"),
                                    id: tempFromId,
                                },
                            });
                            const storePathForEnd = runtimeForEnd.channel.session.resolveStorePath(cfg.session?.store, { agentId: routeForEnd.agentId });
                            await resetSessionByKey(storePathForEnd, routeForEnd.sessionKey);
                            await setTempSessionSlot(threadSessionKey, null);
                            const msg = `[OpenClawd QQ]
✅ 会话 ${activeTempSlot} 已结束并清空，已回到默认会话。`;
                            activeTempSlot = null;
                            if (isGroup) client.sendGroupMsg(groupId, msg); else client.sendPrivateMsg(userId, msg);
                            return;
                        }
                        if (cmd === '/models' || (cmd === '/model' && (!parts[1] || /^list$/i.test(parts[1])))) {
                            const dynamicModelCatalogEnabled = config.enableDynamicModelCatalog === true;
                            console.log(`[QQCMD] local model catalog user=${userId} group=${groupId ?? "-"} dynamic=${String(dynamicModelCatalogEnabled)}`);
                            const catalog = await buildModelCatalogText(dynamicModelCatalogEnabled);
                            if (!isGuild) {
                                const sentAsForward = await sendLongTextAsForwardMessage({
                                    client,
                                    groupId: isGroup ? groupId : undefined,
                                    userId: isGroup ? undefined : userId,
                                    text: catalog,
                                    nodeName: (config.forwardNodeName || "OpenClaw").trim() || "OpenClaw",
                                    nodeUin: String(client.getSelfId() || userId),
                                    nodeCharLimit: 0,
                                });
                                if (sentAsForward) return;
                            }
                            const chunks = splitLongText(catalog, 2800);
                            for (const chunk of chunks) {
                                if (isGroup) client.sendGroupMsg(groupId, chunk);
                                else client.sendPrivateMsg(userId, chunk);
                                if (config.rateLimitMs > 0) await sleep(Math.min(config.rateLimitMs, 800));
                            }
                            return;
                        }
                        if (cmd === '/modelsync') {
                            const startMsg = `[OpenClawd QQ]\n开始同步模型 allowlist（来源：provider /models）...`;
                            if (isGroup) client.sendGroupMsg(groupId, startMsg);
                            else client.sendPrivateMsg(userId, startMsg);
                            const syncResult = await runModelSyncScript();
                            const prefix = syncResult.ok ? "✅" : "❌";
                            const restartHint = syncResult.ok
                                ? `\n\n⚠️ 注意：allowlist 已写入配置，但需要执行 \`openclaw gateway restart\` 后才会生效。`
                                : "";
                            const output = `[OpenClawd QQ]\n${prefix} /modelsync ${syncResult.ok ? "完成" : "失败"}\n${syncResult.text}${restartHint}`;
                            const chunks = splitLongText(output, 2800);
                            for (const chunk of chunks) {
                                if (isGroup) client.sendGroupMsg(groupId, chunk);
                                else client.sendPrivateMsg(userId, chunk);
                                if (config.rateLimitMs > 0) await sleep(Math.min(config.rateLimitMs, 800));
                            }
                            return;
                        }
                        if (cmd === '/贴表情' || cmd === '/react') {
                            const messageId = normalizeQQMessageRef(parts[1]);
                            const emojiId = normalizeQQEmojiRef(parts[2]);
                            const set = normalizeQQEmojiSetFlag(parts[3]);
                            if (messageId === null || emojiId === null) {
                                const usage = `[OpenClawd QQ]\n用法：/贴表情 <message_id> <emoji_id> [true|false]\n示例：/贴表情 123456 76`;
                                if (isGroup) client.sendGroupMsg(groupId, usage);
                                else client.sendPrivateMsg(userId, usage);
                                return;
                            }
                            const result = await setQQMessageEmojiLike({ client, messageId, emojiId, set });
                            const msg = result.ok
                                ? `[OpenClawd QQ]\n已${set ? "添加" : "取消"}贴表情：message_id=${String(messageId)} emoji_id=${String(emojiId)}`
                                : `[OpenClawd QQ]\n贴表情失败：${result.error ?? "unknown error"}`;
                            if (isGroup) client.sendGroupMsg(groupId, msg);
                            else client.sendPrivateMsg(userId, msg);
                            return;
                        }
                        if (cmd === '/查贴表情' || cmd === '/reactions') {
                            const messageId = normalizeQQMessageRef(parts[1]);
                            const emojiId = normalizeQQEmojiRef(parts[2]);
                            const count = parts[3] && /^\d+$/.test(parts[3]) ? Number(parts[3]) : 0;
                            if (messageId === null) {
                                const usage = `[OpenClawd QQ]\n用法：/查贴表情 <message_id> [emoji_id] [count]\n不传 emoji_id 时返回表情汇总；传 emoji_id 时返回点击者列表。`;
                                if (isGroup) client.sendGroupMsg(groupId, usage);
                                else client.sendPrivateMsg(userId, usage);
                                return;
                            }
                            const result = emojiId === null
                                ? await getQQMessageEmojiLikeSummary({ client, messageId })
                                : await getQQMessageEmojiLikeUsers({
                                    client,
                                    messageId,
                                    emojiId,
                                    groupId: isGroup ? groupId : undefined,
                                    count,
                                });
                            if (isGroup) client.sendGroupMsg(groupId, result.text);
                            else client.sendPrivateMsg(userId, result.text);
                            return;
                        }
                        if (cmd === '/newsession') {
                            const runtimeForReset = getQQRuntime();
                            const baseFromIdForReset = isGroup
                                ? String(groupId)
                                : isGuild
                                    ? `guild:${guildId}:${channelId}`
                                    : String(userId);
                            const fromIdForReset = buildEffectiveFromId(baseFromIdForReset, activeTempSlot);
                            const routeForReset = runtimeForReset.channel.routing.resolveAgentRoute({
                                cfg,
                                channel: "qq",
                                accountId: account.accountId,
                                peer: {
                                    kind: isGuild ? "channel" : (isGroup ? "group" : "direct"),
                                    id: fromIdForReset,
                                },
                            });
                            const storePath = runtimeForReset.channel.session.resolveStorePath(cfg.session?.store, { agentId: routeForReset.agentId });
                            const resetOk = await resetSessionByKey(storePath, routeForReset.sessionKey);
                            const notice = resetOk
                                ? "✅ 当前会话已重置。请继续发送你的问题。"
                                : "ℹ️ 当前会话本就为空，已为你准备新会话。";
                            if (isGroup) client.sendGroupMsg(groupId, notice);
                            else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, notice);
                            else client.sendPrivateMsg(userId, notice);
                            return;
                        }
                        if (cmd === '/grok_draw') {
                            const prompt = text.trim().slice('/grok_draw'.length).trim();
                            console.log(`[QQ] direct command hit: /grok_draw prompt_len=${prompt.length} group=${groupId || "-"} user=${userId}`);
                            const draw = await grokDrawDirect(prompt);
                            if (draw.ok === false) {
                                const fail = `[OpenClawd QQ]\n❌ ${draw.error}`;
                                if (isGroup) client.sendGroupMsg(groupId, fail);
                                else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, fail);
                                else client.sendPrivateMsg(userId, fail);
                                return;
                            }
                            const okMsg = `[CQ:image,file=${draw.url}]`;
                            if (isGroup) client.sendGroupMsg(groupId, okMsg);
                            else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, okMsg);
                            else client.sendPrivateMsg(userId, okMsg);
                            return;
                        }
                        if (cmd === '/status') {
                            const activeCount = countActiveTasksForAccount(account.accountId);
                            const statusMsg = `[OpenClawd QQ]\nState: Connected\nSelf ID: ${client.getSelfId()}\nMemory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB\nActiveTasks: ${activeCount}`;
                            if (isGroup) client.sendGroupMsg(groupId, statusMsg); else client.sendPrivateMsg(userId, statusMsg);
                            return;
                        }
                        if (cmd === '/help') {
                            const helpMsg = `[OpenClawd QQ]
/status - 状态
/会话 <名称> - 新建或进入会话
/会话 <序号> - 切换到已有会话
/会话重命名 <新名称> - 重命名当前会话
/退出会话 - 回到默认会话
/会话状态 - 查看当前会话
/会话列表 - 查看已有会话
/会话结束 - 结束当前会话
/newsession - 重置当前会话
/modelsync - 同步模型allowlist（按provider /models）
/贴表情 <message_id> <emoji_id> - 给消息贴表情
/查贴表情 <message_id> [emoji_id] - 查看消息贴表情
/mute @用户 [分] - 禁言
/kick @用户 - 踢出
/help - 帮助`;
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
                    const replyMsgId = getReplyMessageId(event.message, inboundRawMessage, event);
                    if (config.debugLayerTrace) {
                        const segTypes = Array.isArray(event.message)
                            ? event.message.map((seg) => String(seg?.type || "?")).join(",")
                            : typeof event.message;
                        const inboundForwardIds = collectForwardIdsFromCandidates(event.message, inboundRawMessage);
                        console.log(
                            `[QQLayerTrace] inbound segTypes=${segTypes} rawHasReply=${String(/\[CQ:reply[,]/.test(inboundRawMessage))} rawHasForward=${String(/\[CQ:(?:forward|forward_msg|nodes)[,\]]/.test(inboundRawMessage))} replyMsgId=${replyMsgId || ""} forwardIds=${inboundForwardIds.join(",")}`
                        );
                    }
                    if (replyMsgId) {
                        repliedMsg = await withSoftTimeout(
                            client.getMsg(replyMsgId, QQ_CONTEXT_FETCH_TIMEOUT_MS),
                            QQ_CONTEXT_FETCH_TIMEOUT_MS,
                            null,
                            "reply message fetch",
                        );
                    }

                    if (repliedMsg) {
                        try {
                            await withSoftTimeout(
                                hydrateOneBotMessageMedia(client, Array.isArray(repliedMsg.message) ? repliedMsg.message : undefined, {
                                    groupId: repliedMsg?.group_id ?? groupId,
                                    userId: repliedMsg?.user_id ?? userId,
                                }),
                                QQ_CONTEXT_FETCH_TIMEOUT_MS,
                                undefined,
                                "reply media hydrate",
                            );
                            const replyImageHints = extractImageHints(Array.isArray(repliedMsg.message) ? repliedMsg.message : repliedMsg.raw_message, 5);
                            for (const hint of replyImageHints) {
                                rememberImageHint(imageHints, imageHintMeta, hint);
                            }
                        } catch { }
                    }

                    if (repliedMsg) {
                        try {
                            const replySegments = Array.isArray(repliedMsg.message) ? repliedMsg.message : [];
                            for (const seg of replySegments) {
                                if (seg?.type === "file") {
                                    rememberAttachmentHint(
                                        fileHints,
                                        await collectFileHintFromOneBotSegment(client, seg, { groupId: isGroup ? groupId : undefined, userId }),
                                    );
                                } else if (seg?.type === "video") {
                                    rememberAttachmentHint(fileHints, await collectVideoHintFromOneBotSegment(seg));
                                } else if (seg?.type === "record") {
                                    rememberAttachmentHint(audioHints, await collectAudioHintFromOneBotSegment(seg));
                                }
                            }

                            if (fileHints.length === 0 && typeof repliedMsg.raw_message === "string") {
                                const raw = repliedMsg.raw_message;
                                const fileNameMatch = raw.match(/\[文件[:：]?\s*([^\]]+)\]/);
                                if (fileNameMatch) {
                                    fileHints.push({ kind: "file", name: fileNameMatch[1].trim() || "未命名" });
                                }
                            }
                        } catch { }
                    }

                    let historyContext = "";
                    const groupHistoryLimit = Number(config.historyLimit ?? 0);
                    if (isGroup && Number.isFinite(groupHistoryLimit) && groupHistoryLimit > 0) {
                        try {
                            const history = await withSoftTimeout(
                                client.getGroupMsgHistory(groupId, QQ_HISTORY_FETCH_TIMEOUT_MS),
                                QQ_HISTORY_FETCH_TIMEOUT_MS,
                                null,
                                "group history fetch",
                            );
                            if (history?.messages) {
                                const limit = Math.floor(groupHistoryLimit);
                                historyContext = history.messages.slice(-(limit + 1), -1)
                                    .map((m: any) => sanitizeGroupHistoryLineForModel(`${m.sender?.nickname || m.user_id}: ${cleanCQCodes(m.raw_message || "")}`))
                                    .filter(Boolean)
                                    .join("\n");
                            }
                        } catch (e) { }
                    }

                    const keywordOnlyTrigger = Boolean(config.keywordOnlyTrigger) && isGroup;
                    let isTriggered = forceTriggered || !isGroup || text.includes("[动作] 用户戳了你一下");
                    let keywordTriggered = false;
                    if (!isTriggered && keywordTriggers.length > 0) {
                        for (const kw of keywordTriggers) {
                            if (text.includes(kw)) {
                                isTriggered = true;
                                keywordTriggered = true;
                                break;
                            }
                        }
                    }

                    let mentionedByAt = false;
                    let mentionedByReply = false;

                    const checkMention = isGroup || isGuild;
                    if (keywordOnlyTrigger && !isTriggered) return;
                    if (checkMention && config.requireMention && !keywordOnlyTrigger && !isTriggered) {
                        const selfId = client.getSelfId();
                        const effectiveSelfId = selfId ?? event.self_id;
                        if (!effectiveSelfId) return;
                        if (Array.isArray(event.message)) {
                            for (const s of event.message) {
                                if (s.type === "at" && (String(s.data?.qq) === String(effectiveSelfId) || s.data?.qq === "all")) {
                                    mentionedByAt = true;
                                    break;
                                }
                            }
                        } else if (text.includes(`[CQ:at,qq=${effectiveSelfId}]`)) {
                            mentionedByAt = true;
                        }
                        if (!mentionedByAt && repliedMsg?.sender?.user_id === effectiveSelfId) {
                            mentionedByReply = true;
                        }
                        if (!mentionedByAt && !mentionedByReply) return;
                    }

                    if (config.adminOnlyChat && !isAdmin) {
                        if (config.notifyNonAdminBlocked) {
                            const shouldNotifyBlocked = !isGroup && !isGuild ? true : (isTriggered || mentionedByAt);
                            if (!shouldNotifyBlocked) return;
                            const now = Date.now();
                            const targetKey = isGroup
                                ? `g:${groupId}:u:${userId}`
                                : isGuild
                                    ? `guild:${guildId}:${channelId}:u:${userId}`
                                    : `dm:${userId}`;
                            const cacheKey = `${account.accountId}:${targetKey}`;
                            const lastNotifyAt = blockedNotifyCache.get(cacheKey) ?? 0;
                            if (blockedNotifyCooldownMs > 0 && now - lastNotifyAt < blockedNotifyCooldownMs) return;
                            blockedNotifyCache.set(cacheKey, now);
                            const msg = (config.nonAdminBlockedMessage || "当前仅管理员可触发机器人。\n如需使用请联系管理员。").trim();
                            if (msg) {
                                if (isGroup) client.sendGroupMsg(groupId, msg);
                                else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, msg);
                                else client.sendPrivateMsg(userId, msg);
                            }
                        }
                        return;
                    }

                    const pendingAutoReact = (() => {
                        if (!isGroup || config.groupAutoReact !== true || event.message_id === undefined) return null;
                        const probability = resolveQQAutoReactProbability(config);
                        if (probability <= 0 || Math.random() >= probability) return null;
                        const messageId = normalizeQQMessageRef(event.message_id);
                        const emojiId = pickQQAutoReactEmoji(config);
                        if (messageId === null || emojiId === null) return null;
                        return { messageId, emojiId, probability };
                    })();

                    let baseFromId = String(userId);
                    let conversationLabel = `QQ User ${userId}`;
                    if (isGroup) {
                        baseFromId = String(groupId);
                        const cachedGroupName = getCachedGroupName(account.accountId, String(groupId));
                        let resolvedGroupName = cachedGroupName || "";
                        if (!resolvedGroupName) {
                            try {
                                const groupInfo = await withSoftTimeout(
                                    client.getGroupInfo(groupId, true, QQ_GROUP_INFO_FETCH_TIMEOUT_MS),
                                    QQ_GROUP_INFO_FETCH_TIMEOUT_MS,
                                    null,
                                    "group info fetch",
                                );
                                const groupName = typeof groupInfo?.group_name === "string"
                                    ? groupInfo.group_name.trim()
                                    : (typeof groupInfo?.data?.group_name === "string" ? groupInfo.data.group_name.trim() : "");
                                if (groupName) {
                                    resolvedGroupName = groupName;
                                    setCachedGroupName(account.accountId, String(groupId), groupName);
                                }
                            } catch (err) {
                                console.warn(`[QQ] Failed to resolve group name for ${groupId}: ${String(err)}`);
                            }
                        }
                        conversationLabel = resolvedGroupName ? `QQ Group "${resolvedGroupName}"` : `QQ Group ${groupId}`;
                    } else if (isGuild) {
                        baseFromId = `guild:${guildId}:${channelId}`;
                        conversationLabel = `QQ Guild ${guildId} Channel ${channelId}`;
                    }
                    const stableFromId = buildEffectiveFromId(baseFromId, activeTempSlot);
                    const usePerMessageGroupSession =
                        isGroup &&
                        !activeTempSlot &&
                        !forceTriggered &&
                        !inlineCommand &&
                        config.groupPerMessageSessions === true;
                    const fromId = usePerMessageGroupSession
                        ? buildPerMessageFromId(stableFromId, event, userId)
                        : stableFromId;
                    const deliveryTo = buildEffectiveFromId(
                        isGroup
                            ? `group:${String(groupId)}`
                            : isGuild
                                ? `guild:${String(guildId)}:${String(channelId)}`
                                : `user:${String(userId)}`,
                        activeTempSlot,
                    );
                    const sessionLabel = buildQQSessionLabel({
                        isGroup,
                        isGuild,
                        groupId,
                        guildId,
                        channelId,
                        userId,
                        activeTempSlot,
                        timestampMs: event.time * 1000,
                        text,
                    });

                    const runtime = getQQRuntime();
                    const route = runtime.channel.routing.resolveAgentRoute({
                        cfg,
                        channel: "qq",
                        accountId: account.accountId,
                        peer: {
                            kind: isGuild ? "channel" : (isGroup ? "group" : "direct"),
                            id: fromId,
                        },
                    });
                    if (usePerMessageGroupSession) {
                        console.log(`[QQ] per-message group session route base=${stableFromId} session=${route.sessionKey} msg=${String(event.message_id ?? "-")}`);
                    }

                    let deliveredAnything = false;
                    // Track generated visible output separately from delivery completion.
                    // Unknown block text may be flushed by a short debounce timer; if that
                    // async flush races with dispatch completion, deliveredAnything can still
                    // be false even though a real reply is already queued/sending. Do not send
                    // the empty-reply fallback in that case.
                    let sawReplyContent = false;
                    let dispatcherError: any = null;
                    let currentRunState: { isStale: () => boolean } | null = null;
                    let autoReactDispatched = false;
                    const forwardThreshold = Number(config.forwardLongReplyThreshold ?? 0);
                    const canUseMergedForward = !isGuild && Number.isFinite(forwardThreshold) && forwardThreshold > 0;
                    const unknownBlockBoundaryThreshold = Number.isFinite(forwardThreshold) && forwardThreshold > 0 ? forwardThreshold : 300;
                    const unknownBlockMergeWindowMs = 350;
                    const bufferedFinalTexts: string[] = [];
                    let bufferedFinalTotalChars = 0;
                    const bufferedUnknownTexts: string[] = [];
                    let bufferedUnknownTotalChars = 0;
                    let bufferedUnknownLastAt = 0;
                    let unknownFlushTimer: ReturnType<typeof setTimeout> | null = null;
                    let unknownFlushVersion = 0;
                    let pendingReplySessionSourcePrefix = config.showReplySessionSource
                        ? buildReplySessionSourcePrefix(activeTempSlot)
                        : "";

                    const takeReplySessionSourcePrefix = (): string => {
                        if (!pendingReplySessionSourcePrefix) return "";
                        const prefix = pendingReplySessionSourcePrefix;
                        pendingReplySessionSourcePrefix = "";
                        return prefix;
                    };

                    const maybeDispatchAutoReactAfterReply = (phase: string) => {
                        if (!pendingAutoReact || autoReactDispatched || currentRunState?.isStale()) return;
                        autoReactDispatched = true;
                        void setQQMessageEmojiLike({
                            client,
                            messageId: pendingAutoReact.messageId,
                            emojiId: pendingAutoReact.emojiId,
                            set: true,
                        }).then((result) => {
                            if (result.ok) {
                                console.log(`[QQ] random emoji-like ok phase=${phase} group=${groupId} msg=${String(pendingAutoReact.messageId)} emoji=${String(pendingAutoReact.emojiId)} p=${pendingAutoReact.probability}`);
                            } else {
                                console.warn(`[QQ] random emoji-like failed phase=${phase} group=${groupId} msg=${String(pendingAutoReact.messageId)} emoji=${String(pendingAutoReact.emojiId)} err=${result.error ?? "unknown"}`);
                            }
                        }).catch((err) => {
                            console.warn(`[QQ] random emoji-like error phase=${phase} group=${groupId} msg=${String(pendingAutoReact.messageId)} emoji=${String(pendingAutoReact.emojiId)} err=${String(err)}`);
                        });
                    };

                    const rememberBotConversationReply = (replyText: string, messageId?: unknown) => {
                        const textForContext = compactQQContextText(replyText, 900);
                        if (!textForContext) return;
                        rememberQQConversationMessage({
                            accountId: account.accountId,
                            isGroup,
                            isGuild,
                            groupId,
                            guildId,
                            channelId,
                            userId,
                            senderName: "机器人",
                            source: "bot",
                            text: textForContext,
                            messageId,
                            timestampMs: Date.now(),
                        });
                    };

                    const sendSessionSourcePrefixOnly = async (): Promise<boolean> => {
                        const prefix = takeReplySessionSourcePrefix();
                        if (!prefix || currentRunState?.isStale()) return false;
                        const result = await sendOneBotMessageWithAck(client, deliveryTo, prefix);
                        if (!result.ok) {
                            console.warn(`[QQ] text send failed phase=session_source target=${deliveryTo} err=${result.error || "unknown"}`);
                            return false;
                        }
                        console.log(`[QQ] text delivered phase=session_source target=${deliveryTo}`);
                        rememberBotConversationReply(prefix, extractOutboundMessageId(result.data));
                        maybeDispatchAutoReactAfterReply("session_source");
                        return true;
                    };

                    const resetBufferedFinalTexts = () => {
                        bufferedFinalTexts.length = 0;
                        bufferedFinalTotalChars = 0;
                    };

                    const clearUnknownFlushTimer = () => {
                        if (!unknownFlushTimer) return;
                        clearTimeout(unknownFlushTimer);
                        unknownFlushTimer = null;
                    };

                    const resetBufferedUnknownTexts = () => {
                        clearUnknownFlushTimer();
                        bufferedUnknownTexts.length = 0;
                        bufferedUnknownTotalChars = 0;
                        bufferedUnknownLastAt = 0;
                        unknownFlushVersion += 1;
                    };

                    const prepareOutgoingText = async (msg: string): Promise<string> => {
                        let processed = normalizeQQVisibleText(msg);
                        if (!processed) return "";
                        const sessionPrefix = takeReplySessionSourcePrefix();
                        if (sessionPrefix) {
                            processed = processed.trim()
                                ? `${sessionPrefix}\n${processed}`
                                : sessionPrefix;
                        }
                        if (config.formatMarkdown) processed = stripMarkdown(processed);
                        if (config.antiRiskMode) processed = processAntiRisk(processed);
                        return await resolveInlineCqRecord(processed);
                    };

                    const sendProcessedText = async (processed: string): Promise<boolean> => {
                        if (currentRunState?.isStale()) return false;
                        if (canUseMergedForward && processed.length >= forwardThreshold) {
                            const sentAsForward = await sendLongTextAsForwardMessage({
                                client,
                                groupId: isGroup ? groupId : undefined,
                                userId: isGroup ? undefined : userId,
                                text: processed,
                                nodeName: (config.forwardNodeName || "OpenClaw").trim() || "OpenClaw",
                                nodeUin: String(client.getSelfId() || userId),
                                nodeCharLimit: Number(config.forwardNodeCharLimit ?? 0),
                            });
                            if (currentRunState?.isStale()) return false;
                            if (sentAsForward) {
                                console.log(`[QQ] merged-forward delivered phase=single_text len=${processed.length} threshold=${forwardThreshold} target=${deliveryTo}`);
                                rememberBotConversationReply(processed);
                                maybeDispatchAutoReactAfterReply("merged_forward_single_text");
                                return true;
                            }
                            console.warn(`[QQ] merged-forward failed, fallback to plain chunks phase=single_text len=${processed.length} threshold=${forwardThreshold} target=${deliveryTo}`);
                        }
                        const chunks = splitMessage(processed, config.maxMessageLength || 4000);
                        let sentAnything = false;
                        for (let i = 0; i < chunks.length; i++) {
                            if (currentRunState?.isStale()) return i > 0;
                            let chunk = chunks[i];
                            const result = await sendOneBotMessageWithAck(client, deliveryTo, chunk);
                            if (!result.ok) {
                                console.warn(`[QQ] text send failed phase=plain chunk=${i + 1}/${chunks.length} target=${deliveryTo} err=${result.error || "unknown"}`);
                                return sentAnything;
                            }
                            sentAnything = true;
                            console.log(`[QQ] text delivered phase=plain chunk=${i + 1}/${chunks.length} len=${chunk.length} target=${deliveryTo}`);
                            rememberBotConversationReply(chunk, extractOutboundMessageId(result.data));
                            maybeDispatchAutoReactAfterReply("plain_text");

                            if (!isGuild && config.enableTTS && i === 0 && chunk.length < 100) {
                                const tts = chunk.replace(/\[CQ:.*?\]/g, "").trim();
                                if (tts) {
                                    if (isGroup) client.sendGroupMsg(groupId, `[CQ:tts,text=${tts}]`);
                                    else client.sendPrivateMsg(userId, `[CQ:tts,text=${tts}]`);
                                }
                            }

                            if (chunks.length > 1 && config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                        }
                        return sentAnything;
                    };

                    const flushTextBatch = async (
                        texts: string[],
                        totalLen: number,
                        meta: { phaseLabel: string; reason?: string },
                    ): Promise<boolean> => {
                        if (currentRunState?.isStale() || texts.length === 0) return false;
                        if (canUseMergedForward && totalLen >= forwardThreshold) {
                            const sentAsForward = await sendLongTextAsForwardMessage({
                                client,
                                groupId: isGroup ? groupId : undefined,
                                userId: isGroup ? undefined : userId,
                                texts,
                                nodeName: (config.forwardNodeName || "OpenClaw").trim() || "OpenClaw",
                                nodeUin: String(client.getSelfId() || userId),
                                nodeCharLimit: Number(config.forwardNodeCharLimit ?? 0),
                            });
                            if (currentRunState?.isStale()) return false;
                            if (sentAsForward) {
                                console.log(`[QQ] merged-forward delivered phase=${meta.phaseLabel} blocks=${texts.length} len=${totalLen} threshold=${forwardThreshold} target=${deliveryTo}${meta.reason ? ` reason=${meta.reason}` : ""}`);
                                rememberBotConversationReply(texts.join("\n"));
                                maybeDispatchAutoReactAfterReply(`merged_forward_${meta.phaseLabel}`);
                                return true;
                            }
                            console.warn(`[QQ] merged-forward failed, fallback to plain chunks phase=${meta.phaseLabel} blocks=${texts.length} len=${totalLen} threshold=${forwardThreshold} group=${groupId}${meta.reason ? ` reason=${meta.reason}` : ""}`);
                        }

                        let sentAnything = false;
                        for (const textItem of texts) {
                            const sent = await sendProcessedText(textItem);
                            if (sent) sentAnything = true;
                        }
                        if (sentAnything && meta.phaseLabel === "unknown") {
                            console.log(`[QQ] plain-text delivered phase=unknown blocks=${texts.length} len=${totalLen} group=${groupId}${meta.reason ? ` reason=${meta.reason}` : ""}`);
                        }
                        return sentAnything;
                    };

                    const flushBufferedFinalTexts = async (): Promise<boolean> => {
                        if (currentRunState?.isStale() || bufferedFinalTexts.length === 0) return false;
                        const texts = [...bufferedFinalTexts];
                        const totalLen = bufferedFinalTotalChars;
                        resetBufferedFinalTexts();
                        return await flushTextBatch(texts, totalLen, { phaseLabel: "final_answer" });
                    };

                    const flushBufferedUnknownTexts = async (reason: string): Promise<boolean> => {
                        if (currentRunState?.isStale() || bufferedUnknownTexts.length === 0) return false;
                        const texts = [...bufferedUnknownTexts];
                        const totalLen = bufferedUnknownTotalChars;
                        resetBufferedUnknownTexts();
                        return await flushTextBatch(texts, totalLen, { phaseLabel: "unknown", reason });
                    };

                    const scheduleUnknownFlush = () => {
                        if (bufferedUnknownTexts.length === 0) return;
                        clearUnknownFlushTimer();
                        const version = ++unknownFlushVersion;
                        unknownFlushTimer = setTimeout(() => {
                            if (version !== unknownFlushVersion) return;
                            void (async () => {
                                const flushed = await flushBufferedUnknownTexts("debounce");
                                if (flushed) deliveredAnything = true;
                            })();
                        }, unknownBlockMergeWindowMs);
                    };

                    const bufferUnknownBlockText = async (processed: string): Promise<void> => {
                        const now = Date.now();
                        const gapMs = bufferedUnknownLastAt > 0 ? now - bufferedUnknownLastAt : 0;
                        const shouldSplitShortThenLong = bufferedUnknownTexts.length > 0 &&
                            bufferedUnknownTotalChars > 0 &&
                            bufferedUnknownTotalChars < unknownBlockBoundaryThreshold &&
                            processed.length >= unknownBlockBoundaryThreshold;
                        if (bufferedUnknownTexts.length > 0 && (gapMs > unknownBlockMergeWindowMs || shouldSplitShortThenLong)) {
                            const flushed = await flushBufferedUnknownTexts(gapMs > unknownBlockMergeWindowMs ? `gap_${gapMs}` : "short_then_long");
                            if (flushed) deliveredAnything = true;
                        }

                        bufferedUnknownTexts.push(processed);
                        bufferedUnknownTotalChars += processed.length;
                        bufferedUnknownLastAt = now;
                        if (config.debugLayerTrace) {
                            console.log(`[QQLayerTrace] unknown block buffered blocks=${bufferedUnknownTexts.length} total=${bufferedUnknownTotalChars} last=${processed.length}`);
                        }
                        scheduleUnknownFlush();
                    };

                    const deliver = async (payload: any, info?: { kind?: string }) => {
                        if (currentRunState?.isStale()) return;
                        const isTextFailure = payload.text && (
                            payload.text.includes("Agent failed before reply:") ||
                            payload.text.includes("Context overflow") ||
                            payload.text.includes("Message ordering conflict")
                        );

                        if (payload.isError || isTextFailure) {
                            dispatcherError = new Error(payload.text || "API Error");
                            return;
                        }
                        const phase = resolveReplyPayloadPhase(payload);
                        if (config.debugLayerTrace && payload.text && payload.text.trim()) {
                            console.log(`[QQLayerTrace] outbound text kind=${info?.kind || "unknown"} phase=${phase || "unknown"} len=${payload.text.length}`);
                        }
                        if (payload.text && payload.text.trim()) {
                            const cleanedText = stripInternalNoticeText(payload.text);
                            if (!cleanedText.trim()) {
                                return;
                            }
                            const processed = await prepareOutgoingText(cleanedText);
                            if (currentRunState?.isStale()) return;
                            if (processed.trim()) {
                                sawReplyContent = true;
                                const isUnknownBlockText = !phase && info?.kind === "block";
                                if (isUnknownBlockText) {
                                    const flushedBufferedFinal = await flushBufferedFinalTexts();
                                    if (flushedBufferedFinal) deliveredAnything = true;
                                    await bufferUnknownBlockText(processed);
                                } else {
                                    const flushedBufferedUnknown = await flushBufferedUnknownTexts(`before_${phase || info?.kind || "text"}`);
                                    if (flushedBufferedUnknown) deliveredAnything = true;
                                    const shouldBufferKnownFinal = canUseMergedForward && (
                                        phase === "final_answer" ||
                                        (!phase && info?.kind === "final")
                                    );
                                    if (shouldBufferKnownFinal) {
                                        bufferedFinalTexts.push(processed);
                                        bufferedFinalTotalChars += processed.length;
                                    } else {
                                        const flushedBufferedText = await flushBufferedFinalTexts();
                                        if (flushedBufferedText) deliveredAnything = true;
                                        const sentText = await sendProcessedText(processed);
                                        if (sentText) deliveredAnything = true;
                                    }
                                }
                            }
                        }
                        const outboundMediaItems = collectOutboundMediaItemsFromPayload(payload);
                        if (outboundMediaItems.length > 0) {
                            if (outboundMediaItems.length > 0) {
                                sawReplyContent = true;
                            }
                            const flushedUnknownText = await flushBufferedUnknownTexts("before_files");
                            if (flushedUnknownText) deliveredAnything = true;
                            const flushedBufferedText = await flushBufferedFinalTexts();
                            if (flushedBufferedText) deliveredAnything = true;
                            if (!payload.text && pendingReplySessionSourcePrefix) {
                                const sentPrefix = await sendSessionSourcePrefixOnly();
                                if (sentPrefix) deliveredAnything = true;
                            }
                            for (const f of outboundMediaItems) {
                                if (currentRunState?.isStale()) return;
                                const result = await sendQQMediaMessage({
                                    client,
                                    to: deliveryTo,
                                    mediaUrl: f.url,
                                    fileNameHint: f.name,
                                    mediaKindHint: f.kind,
                                    accountId: account.accountId,
                                    replyToId: payload.replyToId || undefined,
                                    audioAsVoice: payload.audioAsVoice,
                                });
                                if (currentRunState?.isStale()) return;
                                if (result) {
                                    deliveredAnything = true;
                                    const mediaSummary = [
                                        f.kind ? `[${f.kind}]` : "[媒体]",
                                        f.name || "",
                                        f.url || "",
                                    ].filter(Boolean).join(" ");
                                    rememberBotConversationReply(mediaSummary, extractOutboundMessageId(result));
                                    maybeDispatchAutoReactAfterReply("media");
                                }
                                if (config.rateLimitMs > 0) await sleep(config.rateLimitMs);
                            }
                        }
                    };

                    let replyToBody = "";
                    let replyToSender = "";
                    if (replyMsgId && repliedMsg) {
                        replyToBody = cleanCQCodes(typeof repliedMsg.message === 'string' ? repliedMsg.message : repliedMsg.raw_message || '');
                        replyToSender = repliedMsg.sender?.nickname || repliedMsg.sender?.card || String(repliedMsg.sender?.user_id || '');
                    }

                    const cleanedUserBody = cleanCQCodes(text);
                    const inboundLinks = extractHttpUrlsFromText(cleanedUserBody, QQ_LINK_PREVIEW_MAX_LINKS);
                    const linkPreviews = inboundLinks.length > 0
                        ? await withSoftTimeout(
                            fetchQQLinkPreviews(inboundLinks),
                            QQ_LINK_PREVIEW_TIMEOUT_MS + 700,
                            [] as QQInboundLinkPreview[],
                            "link preview",
                        )
                        : [] as QQInboundLinkPreview[];
                    if (inboundLinks.length > 0) {
                        console.log(`[QQ] inbound links=${inboundLinks.length} previews=${linkPreviews.filter((item) => item.title || item.description || item.text).length}`);
                    }
                    const linkContextBlock = buildInboundLinkContextBlock(linkPreviews);
                    const bodyForAgentText = inboundLinks.length > 0
                        ? replaceInboundLinksForModel(cleanedUserBody, inboundLinks)
                        : cleanedUserBody;
                    const replySuffix = replyToBody ? `\n\n[Replying to ${replyToSender || "unknown"}]\n${replyToBody}\n[/Replying]` : "";
                    let bodyWithReply = bodyForAgentText + replySuffix;
                    let systemBlock = "";
                    if (config.injectGatewayMeta !== false) {
                        systemBlock += buildQQHiddenMetaBlock({
                            accountId: account.accountId,
                            userId,
                            isGroup,
                            isGuild,
                            groupId,
                            guildId,
                            channelId,
                            conversationLabel,
                            sessionLabel,
                            senderName: event.sender?.nickname || event.sender?.card || "Unknown",
                            senderRole: event.sender?.role,
                            isAdmin,
                            activeTempSlot,
                            mentionedByAt,
                            mentionedByReply,
                            keywordTriggered,
                        });
                    }
                    if (config.systemPrompt) systemBlock += `<system>${config.systemPrompt}</system>\n\n`;
                    systemBlock += buildQQLanguageConsistencyBlock(bodyForAgentText);
                    if (linkContextBlock) systemBlock += linkContextBlock;
                    if (historyContext) systemBlock += `<history>\n${historyContext}\n</history>\n\n`;
                    const recentConversationContextBlock = buildQQConversationContextBlock({
                        accountId: account.accountId,
                        config,
                        isGroup,
                        isGuild,
                        groupId,
                        guildId,
                        channelId,
                        userId,
                        currentMessageId: event.message_id,
                    });
                    if (recentConversationContextBlock) systemBlock += recentConversationContextBlock;
                    if (config.debugLayerTrace) {
                        console.log(`[QQLayerTrace] invoke buildReplyForwardContextBlock enrich=${String(config.enrichReplyForwardContext)} debug=${String(config.debugLayerTrace)} hasReply=${String(Boolean(repliedMsg))}`);
                    }
                    const layeredContext = await withSoftTimeout(
                        buildReplyForwardContextBlock({
                            client,
                            rootEvent: event,
                            repliedMsg,
                            cfg: config,
                        }),
                        QQ_LAYER_CONTEXT_TIMEOUT_MS,
                        { block: "", imageUrls: [] },
                        "reply/forward context build",
                    );
                    if (config.debugLayerTrace) {
                        console.log(`[QQLayerTrace] blockLen=${layeredContext.block.length} imageCount=${layeredContext.imageUrls.length}`);
                    }
                    if (layeredContext.block) systemBlock += layeredContext.block;
                    if (fileHints.length > 0 || audioHints.length > 0 || imageHints.length > 0) {
                        systemBlock += `<attachments>\n`;
                        for (const hint of [...fileHints, ...audioHints]) {
                            const tag = hint.kind === "video" ? "qq_video" : hint.kind === "audio" ? "qq_audio" : "qq_file";
                            const parts = [`name=${hint.name}`];
                            if (hint.url) parts.push(`url=${hint.url}`);
                            if (hint.localPath) parts.push(`local_path=${hint.localPath}`);
                            if (hint.fileId) parts.push(`file_id=${hint.fileId}`);
                            if (hint.busid) parts.push(`busid=${hint.busid}`);
                            if (hint.size !== undefined) parts.push(`size=${hint.size}`);
                            if (hint.mimeType) parts.push(`mime=${hint.mimeType}`);
                            systemBlock += `- ${tag} ${parts.join(" ")}\n`;
                        }
                        for (const imageUrl of imageHints.slice(0, 5)) {
                            systemBlock += `- qq_image url=${imageUrl}\n`;
                        }
                        systemBlock += `</attachments>\n\n`;
                    }
                    bodyWithReply = systemBlock + bodyWithReply;

                    const inboundMediaUrls = Array.from(new Set([
                        ...extractImageUrls(event.message),
                        ...imageHints,
                        ...layeredContext.imageUrls,
                    ])).slice(0, 5);
                    const cachedInboundImages = config.cacheInboundImagesToLocal !== false
                        ? await cacheImageHintsLocally(inboundMediaUrls, imageHintMeta)
                        : { entries: inboundMediaUrls.map((url) => ({ url, type: imageHintMeta.get(url)?.mimeType ?? inferImageMimeType(url) ?? DEFAULT_QQ_IMAGE_MIME })), failures: [] as Array<{ url: string; error: string }> };
                    const attachmentMediaEntries = collectAttachmentMediaEntries([...fileHints, ...audioHints]);
                    const inboundMediaPayload = buildInboundMediaPayloadFromEntries([
                        ...cachedInboundImages.entries,
                        ...attachmentMediaEntries,
                    ]);
                    if (config.debugLayerTrace) {
                        const mediaPathCount = Array.isArray((inboundMediaPayload as any).MediaPaths)
                            ? (inboundMediaPayload as any).MediaPaths.length
                            : ((inboundMediaPayload as any).MediaPath ? 1 : 0);
                        const mediaUrlCount = Array.isArray((inboundMediaPayload as any).MediaUrls)
                            ? (inboundMediaPayload as any).MediaUrls.length
                            : ((inboundMediaPayload as any).MediaUrl ? 1 : 0);
                        console.log(
                            `[QQLayerTrace] inbound media urls=${inboundMediaUrls.length} attachments=${attachmentMediaEntries.length} ctxUrls=${mediaUrlCount} ctxPaths=${mediaPathCount} cacheFailures=${cachedInboundImages.failures.length}`
                        );
                        if (cachedInboundImages.failures.length > 0) {
                            console.warn(
                                `[QQLayerTrace] inbound media cache failed urls=${cachedInboundImages.failures.map((item) => `${item.url} err=${item.error}`).join(" | ")}`
                            );
                        }
                    }

                    const shouldComputeCommandAuthorized = runtime.channel.commands.shouldComputeCommandAuthorized(text, cfg);
                    const commandAuthorized = shouldComputeCommandAuthorized ? isAdmin : true;
                    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
                        Provider: "qq", Channel: "qq", From: fromId, To: "qq:bot", Body: bodyWithReply, RawBody: bodyForAgentText,
                        BodyForAgent: bodyWithReply,
                        BodyForCommands: bodyForAgentText,
                        SenderId: String(userId), SenderName: event.sender?.nickname || "Unknown", ConversationLabel: conversationLabel, ThreadLabel: sessionLabel,
                        SessionKey: route.sessionKey, AccountId: route.accountId, ChatType: isGroup ? "group" : isGuild ? "channel" : "direct", Timestamp: event.time * 1000,
                        Surface: "qq",
                        ...(event.message_id !== undefined && { MessageSid: String(event.message_id) }),
                        OriginatingChannel: "qq", OriginatingTo: deliveryTo, CommandAuthorized: commandAuthorized,
                        ...inboundMediaPayload,
                        ...(replyMsgId && { ReplyToId: replyMsgId, ReplyToBody: replyToBody, ReplyToSender: replyToSender }),
                    });
                    if (config.debugLayerTrace) {
                        const ctxMediaUrls = Array.isArray(ctxPayload.MediaUrls)
                            ? ctxPayload.MediaUrls
                            : (ctxPayload.MediaUrl ? [ctxPayload.MediaUrl] : []);
                        const ctxMediaPaths = Array.isArray(ctxPayload.MediaPaths)
                            ? ctxPayload.MediaPaths
                            : (ctxPayload.MediaPath ? [ctxPayload.MediaPath] : []);
                        console.log(
                            `[QQLayerTrace] session ctx media urls=${ctxMediaUrls.length} paths=${ctxMediaPaths.length} sampleUrl=${ctxMediaUrls[0] || ""} samplePath=${ctxMediaPaths[0] || ""}`
                        );
                    }

                    const executeDispatch = async (mergedCtx: any, runState: { isStale: () => boolean }, abortSignal?: AbortSignal) => {
                        currentRunState = runState;
                        let processingDelayTimer: ReturnType<typeof setTimeout> | null = null;
                        let typingCardActivated = false;
                        const taskKey = buildTaskKey(account.accountId, isGroup, isGuild, groupId, guildId, channelId, userId);

                        const clearProcessingTimers = () => {
                            if (processingDelayTimer) {
                                clearTimeout(processingDelayTimer);
                                processingDelayTimer = null;
                            }
                        };

                        if (config.showProcessingStatus !== false) {
                            activeTaskIds.add(taskKey);
                            const delayMs = Math.max(100, Number(config.processingStatusDelayMs ?? 500));
                            processingDelayTimer = setTimeout(() => {
                                if (isGroup) {
                                    void activateGroupTypingIndicator(
                                        client,
                                        account.accountId,
                                        groupId,
                                        (config.processingStatusText || "输入中").trim() || "输入中",
                                    ).then((fallbackActivated) => {
                                        typingCardActivated = fallbackActivated;
                                    });
                                }
                            }, delayMs);
                        }

                        const maxRetries = config.maxRetries ?? 3;
                        const retryDelayMs = config.retryDelayMs ?? 3000;

                        try {
                            const matchedAgentId = route.agentId;
                            const matchedAgentConfig = ((cfg as any).agents?.list || []).find((a: any) => a.id === matchedAgentId);
                            // OpenClaw accepts either "provider/model" or
                            // { primary, fallbacks } for agent model config.
                            const normalizeModelConfig = (value: any) => {
                                if (typeof value === "string") {
                                    const primary = value.trim();
                                    return primary ? { primary, fallbacks: [] as string[] } : undefined;
                                }
                                if (!value || typeof value !== "object") {
                                    return undefined;
                                }
                                const primary = typeof value.primary === "string" ? value.primary.trim() : "";
                                const fallbacks = Array.isArray(value.fallbacks)
                                    ? value.fallbacks
                                        .map((entry: any) => (typeof entry === "string" ? entry.trim() : ""))
                                        .filter((entry: string) => Boolean(entry))
                                    : [];
                                if (!primary && fallbacks.length === 0) {
                                    return undefined;
                                }
                                return { primary, fallbacks };
                            };
                            const rawModelConfig =
                                normalizeModelConfig(matchedAgentConfig?.model) ||
                                normalizeModelConfig((cfg as any).agents?.defaults?.model) ||
                                { primary: "", fallbacks: [] as string[] };
                            const mergedHasInboundImage = hasInboundImageLikeContent(mergedCtx);
                            const shouldUseClaudeForInboundMedia = mergedHasInboundImage;
                            const mediaModelOverride = shouldUseClaudeForInboundMedia ? "agentrouter-completions/claude-opus-4-8" : "";
                            const mediaModelFallbacks = shouldUseClaudeForInboundMedia ? ["agentrouter-completions/claude-opus-4-6"] : [];
                            const effectiveModelConfig = mediaModelOverride
                                ? {
                                    primary: mediaModelOverride,
                                    fallbacks: mediaModelFallbacks,
                                }
                                : rawModelConfig;
                            const fallbacks = effectiveModelConfig.fallbacks;
                            if (mediaModelOverride) {
                                console.log(`[QQ] inbound image/media detected; primary model override=${mediaModelOverride} currentNonText=${String(hasCurrentInboundNonTextContent)} mergedImage=${String(mergedHasInboundImage)} fallbacks=${fallbacks.join(",") || "-"}`);
                            }

                            const modelsToTry: Array<string | null> = [null];
                            let globalDispatchError: any = null;

                            out_loop:
                            for (let modelIndex = 0; modelIndex < modelsToTry.length; modelIndex++) {
                                const modelToTest = modelsToTry[modelIndex] || effectiveModelConfig.primary;
                                const candidateFallbacks = modelsToTry[modelIndex] ? [] : fallbacks;
                                let currentCfg = cfg as any;
                                if (runState.isStale()) {
                                    break out_loop;
                                }

                                if (!modelToTest) {
                                    globalDispatchError = new Error("[QQ] No model resolved for this route; check agents.<id>.model or agents.defaults.model");
                                    console.error(globalDispatchError);
                                    break out_loop;
                                }

                                if (modelIndex > 0) {
                                    console.log(`[QQ] Failover triggered: Switching to fallback model ${modelToTest}`);
                                }

                                currentCfg = {
                                    ...(cfg as any),
                                    agents: {
                                        ...((cfg as any).agents || {}),
                                        defaults: {
                                            ...((cfg as any).agents?.defaults || {}),
                                            model: { primary: modelToTest, fallbacks: candidateFallbacks }
                                        },
                                        list: ((cfg as any).agents?.list || []).map((a: any) => {
                                            if (a.id === matchedAgentId) {
                                                return { ...a, model: { primary: modelToTest, fallbacks: candidateFallbacks } };
                                            }
                                            return a;
                                        })
                                    }
                                };

                                let sessionConflictRetryCount = 0;
                                for (let tryCount = 0; tryCount <= maxRetries; tryCount++) {
                                    if (runState.isStale()) {
                                        break out_loop;
                                    }
                                    deliveredAnything = false;
                                    globalDispatchError = null;
                                    dispatcherError = null;
                                    try {
                                        if (tryCount > 0) {
                                            console.log(`[QQ] Model request failed or returned empty. Retrying (${tryCount}/${maxRetries}) after ${retryDelayMs}ms...`);
                                            await sleep(retryDelayMs);
                                            if (runState.isStale()) {
                                                break out_loop;
                                            }
                                        }

                                        const dispatchStartTime = Date.now();
                                        let dispatchResult: any = null;
                                        try {
                                            resetBufferedFinalTexts();
                                            resetBufferedUnknownTexts();
                                            const replyCfg = buildQQReplyConfig(currentCfg as OpenClawConfig, config);
                                            dispatchResult = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
                                                ctx: mergedCtx,
                                                cfg: replyCfg,
                                                dispatcherOptions: {
                                                    deliver,
                                                    onError: (err, deliveryInfo) => {
                                                        if (deliveryInfo.kind === "final") {
                                                            dispatcherError = err;
                                                        }
                                                        console.error(`[QQ] buffered dispatch ${deliveryInfo.kind} failed: ${String(err)}`);
                                                    },
                                                },
                                                replyOptions: {
                                                    ...(abortSignal ? { abortSignal } : {}),
                                                },
                                            });
                                            if (!runState.isStale()) {
                                                console.log(`[QQ] dispatch result queuedFinal=${String(Boolean(dispatchResult?.queuedFinal))} counts=${JSON.stringify(dispatchResult?.counts || {})} session=${route.sessionKey}`);
                                            }
                                        } catch (err) {
                                            globalDispatchError = err;
                                            console.error(`[QQ] Error during buffered reply dispatch (attempt ${tryCount + 1}/${maxRetries + 1}):`, err);
                                        }
                                        const dispatchDurationMs = Date.now() - dispatchStartTime;
                                        if (runState.isStale()) {
                                            break out_loop;
                                        }

                                        globalDispatchError = globalDispatchError || dispatcherError;
                                        const errMessage = globalDispatchError ? ((globalDispatchError instanceof Error) ? globalDispatchError.message : String(globalDispatchError)) : "";
                                        if (globalDispatchError) {
                                            resetBufferedUnknownTexts();
                                            resetBufferedFinalTexts();
                                            if (/reply session initialization conflicted|message ordering conflict/i.test(errMessage) && sessionConflictRetryCount < 3 && !runState.isStale()) {
                                                sessionConflictRetryCount += 1;
                                                const conflictDelayMs = 750 * sessionConflictRetryCount;
                                                console.warn(`[QQ] reply session conflict; retrying after ${conflictDelayMs}ms (${sessionConflictRetryCount}/3): ${errMessage}`);
                                                await sleep(conflictDelayMs);
                                                tryCount -= 1;
                                                continue;
                                            }
                                            if (/reply session initialization conflicted|message ordering conflict|aborted|aborterror/i.test(errMessage)) {
                                                console.warn(`[QQ] stopping dispatch loop for non-retryable session/abort error: ${errMessage}`);
                                                const notifyMsg = (config.errorReplyFallbackText || "这边没拿到结果，重发一次").trim();
                                                if (config.enableErrorNotify && notifyMsg && !runState.isStale()) {
                                                    const visibleNotify = normalizeQQVisibleText(notifyMsg);
                                                    if (visibleNotify) await deliver({ text: visibleNotify });
                                                }
                                                break out_loop;
                                            }
                                        }

                                        if (globalDispatchError) {
                                            const fastFailWords = config.fastFailErrors || ["api key", "no api key found", "not found", "401", "unauthorized", "billing", "余额不足", "已欠费"];
                                            const shouldFastFail = fastFailWords.some((word: string) => errMessage.toLowerCase().includes(word.toLowerCase()));

                                            // Handle fast skips for predictable API errors like invalid tokens
                                            // Ensure we don't accidentally skip actual rate limit errors
                                            if (shouldFastFail && !errMessage.toLowerCase().includes("rate limit") && !errMessage.toLowerCase().includes("429")) {
                                                console.log(`[QQ] Skipping retries for model due to fast-fail auth error: ${errMessage}`);
                                                tryCount = maxRetries;
                                            }
                                        }

                                        if (!globalDispatchError) {
                                            const flushedUnknownText = await flushBufferedUnknownTexts("dispatch_end");
                                            if (flushedUnknownText) deliveredAnything = true;
                                            const flushedBufferedText = await flushBufferedFinalTexts();
                                            if (flushedBufferedText) deliveredAnything = true;
                                            const shouldFallback = config.enableEmptyReplyFallback !== false && !text.trim().startsWith('/');
                                            const dispatchCounts = (dispatchResult?.counts && typeof dispatchResult.counts === "object") ? dispatchResult.counts : {};
                                            const sawDispatcherOutput = Boolean(
                                                dispatchResult?.queuedFinal ||
                                                Number(dispatchCounts.block || 0) > 0 ||
                                                Number(dispatchCounts.final || 0) > 0
                                            );
                                            if (deliveredAnything || sawReplyContent || sawDispatcherOutput) {
                                                break out_loop;
                                            }
                                            if (!shouldFallback) {
                                                break out_loop;
                                            }

                                            if (dispatchDurationMs < 500) {
                                                console.log(`[QQ] Core returned empty quickly (duration ${dispatchDurationMs}ms). Sending fallback if configured.`);
                                            }
                                        }

                                        if (tryCount === maxRetries) {
                                                if (modelIndex === modelsToTry.length - 1 && !runState.isStale()) {
                                                    if (globalDispatchError) {
                                                        const notifyMsg = (config.errorReplyFallbackText || "这边没拿到结果，重发一次").trim();
                                                        if (config.enableErrorNotify && notifyMsg) {
                                                            const visibleNotify = normalizeQQVisibleText(notifyMsg);
                                                            if (visibleNotify) deliver({ text: visibleNotify });
                                                        }
                                                    } else {
                                                        const fallbackText = (config.emptyReplyFallbackText || "没拿到内容，重发一次").trim();
                                                        const visibleFallback = normalizeQQVisibleText(fallbackText);
                                                        if (visibleFallback) {
                                                            console.log(`[QQ] no visible reply fallback delivered session=${route.sessionKey} text=${JSON.stringify(visibleFallback)}`);
                                                            if (isGroup) client.sendGroupMsg(groupId, visibleFallback);
                                                            else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, visibleFallback);
                                                            else client.sendPrivateMsg(userId, visibleFallback);
                                                        }
                                                    }
                                            }
                                            break;
                                        }
                                    } catch (loopErr) {
                                        console.error(`[QQ] Unexpected error in dispatch loop:`, loopErr);
                                    }
                                }
                            }
                        } catch (error) {
                            console.error(`[QQ] Outer error:`, error);
                        }
                        finally {
                            resetBufferedUnknownTexts();
                            resetBufferedFinalTexts();
                            currentRunState = null;
                            clearProcessingTimers();
                            activeTaskIds.delete(taskKey);
                            if (typingCardActivated && isGroup) {
                                clearGroupTypingCard(client, account.accountId, groupId, (config.processingStatusText || "输入中").trim() || "输入中");
                            }
                        }
                    };

                    enqueueQQMessageForDispatch(
                        route.sessionKey,
                        { ctxPayload, executeDispatch, runEpoch: 0 },
                        config,
                        (msg: string) => {
                            if (isGroup) client.sendGroupMsg(groupId, msg);
                            else if (isGuild) client.sendGuildChannelMsg(guildId, channelId, msg);
                            else client.sendPrivateMsg(userId, msg);
                        }
                    );
                } catch (err) {
                    console.error("[QQ] Critical error in message handler:", err);
                }
            });

            client.connect();
            await new Promise<void>((resolve) => {
                if (ctx.abortSignal.aborted) {
                    resolve();
                    return;
                }
                ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
            });
            try {
                // keep provider task alive until gateway abort; avoid health-monitor restart loop
            } finally {
                if (accountStartGeneration.get(account.accountId) === accountGen) {
                    accountStartGeneration.set(account.accountId, accountGen + 1);
                }
                client.disconnect();
                clients.delete(account.accountId);
                accountConfigs.delete(account.accountId);
                const setForAccount = allClientsByAccount.get(account.accountId);
                if (setForAccount) {
                    setForAccount.delete(client);
                    if (setForAccount.size === 0) {
                        allClientsByAccount.delete(account.accountId);
                    }
                }
            }
        },
        logoutAccount: async ({ accountId, cfg }) => {
            return { loggedOut: true, cleared: true };
        }
    },
    outbound: {
        sendText: async ({ to, text, accountId, replyToId }) => {
            const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
            if (!client) throw new Error("QQ client not connected");
            const lastAck = await sendQQTextMessage({ client, to, text, replyToId });
            return {
                channel: "qq",
                messageId: resolveOutboundMessageId(lastAck),
                timestamp: Date.now(),
            };
        },
        sendMedia: async (ctx) => {
            const { to, text, mediaUrl, accountId, replyToId } = ctx;
            const extra = ctx as any;
            const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
            if (!client) throw new Error("QQ client not connected");
            if (!mediaUrl) throw new Error("mediaUrl is required");
            return await sendQQMediaMessage({
                client,
                to,
                text,
                mediaUrl,
                accountId,
                replyToId,
                mediaAccess: extra.mediaAccess as QQOutboundMediaAccess | undefined,
                mediaLocalRoots: extra.mediaLocalRoots,
                mediaReadFile: extra.mediaReadFile,
                fileNameHint: extra.fileNameHint ?? extra.name ?? extra.filename ?? extra.fileName,
                mediaKindHint: normalizeOutboundMediaKind(extra.mediaKindHint ?? extra.kind ?? extra.type ?? extra.mimeType),
                forceDocument: extra.forceDocument,
                audioAsVoice: extra.audioAsVoice,
            });
        },
        sendPayload: async (ctx) => {
            const { to, text, payload, accountId, replyToId } = ctx;
            const extra = ctx as any;
            const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
            if (!client) throw new Error("QQ client not connected");
            const mediaItems = collectOutboundMediaItemsFromPayload(payload);
            const payloadText = typeof (payload as any)?.text === "string" ? (payload as any).text : text;
            const effectiveReplyToId = (payload as any)?.replyToId || replyToId;
            const effectiveAudioAsVoice = typeof (payload as any)?.audioAsVoice === "boolean" ? (payload as any).audioAsVoice : extra.audioAsVoice;

            if (mediaItems.length === 0) {
                const lastAck = await sendQQTextMessage({ client, to, text: payloadText || "", replyToId: effectiveReplyToId });
                return { channel: "qq", messageId: resolveOutboundMessageId(lastAck), timestamp: Date.now() };
            }

            let lastResult: any = null;
            for (let i = 0; i < mediaItems.length; i += 1) {
                const item = mediaItems[i];
                lastResult = await sendQQMediaMessage({
                    client,
                    to,
                    text: i === 0 ? payloadText : "",
                    mediaUrl: item.url,
                    accountId,
                    replyToId: effectiveReplyToId,
                    mediaAccess: extra.mediaAccess as QQOutboundMediaAccess | undefined,
                    mediaLocalRoots: extra.mediaLocalRoots,
                    mediaReadFile: extra.mediaReadFile,
                    fileNameHint: item.name,
                    mediaKindHint: item.kind,
                    forceDocument: extra.forceDocument,
                    audioAsVoice: effectiveAudioAsVoice,
                });
                if (i < mediaItems.length - 1) await sleep(1000);
            }
            return lastResult || { channel: "qq", messageId: resolveOutboundMessageId(), timestamp: Date.now() };
        },
        // @ts-ignore
        deleteMessage: async ({ messageId, accountId }) => {
            const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
            if (!client) return { channel: "qq", success: false, error: "Client not connected" };
            try { client.deleteMsg(messageId); return { channel: "qq", success: true }; }
            catch (err) { return { channel: "qq", success: false, error: String(err) }; }
        }
    },
    messaging: {
        normalizeTarget,
        targetResolver: {
            looksLikeId: (raw, normalized) => {
                const value = String(normalized || raw || "").trim();
                return /^user:\d{5,12}$/i.test(value) || /^group:\d{5,12}$/i.test(value) || /^guild:/i.test(value);
            },
            hint: "私聊用 user:QQ号，群聊用 group:群号，频道用 guild:id:channel（不要只写纯数字）",
        }
    },
    agentPrompt: {
        messageToolHints: () => [
            "QQ 发送目标必须带类型前缀：私聊 `user:<QQ号>`，群聊 `group:<群号>`，频道 `guild:<guildId>:<channelId>`；不要只写纯数字。",
            "QQ message action 支持 `react` 和 `reactions`：`react` 用 `message_id`/当前消息上下文 + `emoji_id` 给群消息贴表情，`reactions` 用 `message_id` 查看贴表情汇总，附带 `emoji_id` 可拉取点击者列表。QQ/NapCat 的贴表情通常需要 QQ emoji id，私聊 reaction 不可靠。",
        ],
    }
};
