import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { OneBotClient } from "../client.js";
import type { QQConfig } from "../config.js";
import type { OneBotMessage } from "../types.js";
import {
  ensureFileInSharedMedia,
  isAudioFile,
  isImageFile,
  resolveInlineCqRecord,
  resolveMediaUrl,
  sendOneBotMessageWithAck,
  splitMessage,
  toLocalPathIfAny,
} from "../media/outbound.js";

export function createQQOutbound(opts: {
  getClientForAccount: (accountId: string | undefined | null) => OneBotClient | undefined;
  accountConfigs: Map<string, QQConfig>;
  sleep: (ms: number) => Promise<void>;
}) {
  const { getClientForAccount, accountConfigs, sleep } = opts;

  return {
    sendText: async ({ to, text, accountId, replyTo }: { to: string; text: string; accountId?: string; replyTo?: string }) => {
      const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
      if (!client) return { channel: "qq", sent: false, error: "Client not connected" };
      const normalizedText = await resolveInlineCqRecord(text);
      const chunks = splitMessage(normalizedText, 4000);
      let lastAck: any = null;
      for (let i = 0; i < chunks.length; i++) {
        let message: OneBotMessage | string = chunks[i];
        if (replyTo && i === 0) {
          message = [
            { type: "reply", data: { id: String(replyTo) } },
            { type: "text", data: { text: chunks[i] } },
          ];
        }
        const ack = await sendOneBotMessageWithAck(client, to, message);
        if (!ack.ok) {
          return { channel: "qq", sent: false, error: ack.error || "Failed to send text" };
        }
        lastAck = ack.data;

        if (chunks.length > 1) await sleep(1000);
      }
      return { channel: "qq", sent: true, messageId: lastAck?.message_id ?? lastAck?.messageId ?? null };
    },

    sendMedia: async ({ to, text, mediaUrl, accountId, replyTo }: { to: string; text?: string; mediaUrl: string; accountId?: string; replyTo?: string }) => {
      const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
      if (!client) return { channel: "qq", sent: false, error: "Client not connected" };

      const runtimeCfg = accountConfigs.get(accountId || DEFAULT_ACCOUNT_ID) || accountConfigs.get(DEFAULT_ACCOUNT_ID) || {};

      const hostSharedDir = typeof runtimeCfg.sharedMediaHostDir === "string" ? runtimeCfg.sharedMediaHostDir.trim() : "";
      const containerSharedDirRaw = typeof runtimeCfg.sharedMediaContainerDir === "string" ? runtimeCfg.sharedMediaContainerDir.trim() : "";
      const containerSharedDir = containerSharedDirRaw || "/openclaw_media";

      const audioLikeSource = isAudioFile(mediaUrl);
      let stagedAudioFile: string | null = null;
      if (audioLikeSource && hostSharedDir) {
        const localSourcePath = toLocalPathIfAny(mediaUrl);
        if (localSourcePath) {
          try {
            const copiedName = await ensureFileInSharedMedia(localSourcePath, hostSharedDir);
            stagedAudioFile = path.posix.join(containerSharedDir.replace(/\\/g, "/"), copiedName);
          } catch (err) {
            console.warn(`[QQ] Failed to stage source audio into shared media dir: ${String(err)}`);
          }
        }
      }

      const finalUrl = await resolveMediaUrl(mediaUrl);

      let textAck: any = null;
      if (text && text.trim()) {
        const textMessage: OneBotMessage = [];
        if (replyTo) textMessage.push({ type: "reply", data: { id: String(replyTo) } });
        textMessage.push({ type: "text", data: { text } });
        const ack = await sendOneBotMessageWithAck(client, to, textMessage);
        if (!ack.ok) {
          return { channel: "qq", sent: false, error: `Text send failed: ${ack.error || "unknown"}` };
        }
        textAck = ack.data;
      }

      const mediaMessage: OneBotMessage = [];
      if (replyTo && !(text && text.trim())) mediaMessage.push({ type: "reply", data: { id: String(replyTo) } });
      const sourceAudioLike = isAudioFile(mediaUrl);
      const sourceImageLike = isImageFile(mediaUrl);
      const audioLike = sourceAudioLike || isAudioFile(finalUrl);
      const imageLike = !audioLike && (sourceImageLike || isImageFile(finalUrl) || finalUrl.startsWith("base64://"));

      if (audioLike && textAck) {
        const configuredDelay = Number(runtimeCfg.rateLimitMs ?? 1000);
        const delayMs = Number.isFinite(configuredDelay) ? Math.max(1200, configuredDelay) : 1200;
        await sleep(delayMs);
      }

      if (imageLike) mediaMessage.push({ type: "image", data: { file: finalUrl } });
      else if (audioLike) {
        let recordFile = stagedAudioFile || finalUrl;
        if (!finalUrl.startsWith("base64://") && hostSharedDir) {
          try {
            const localPath = finalUrl.startsWith("file:") ? fileURLToPath(finalUrl) : finalUrl;
            const copiedName = await ensureFileInSharedMedia(localPath, hostSharedDir);
            recordFile = path.posix.join(containerSharedDir.replace(/\\/g, "/"), copiedName);
          } catch (err) {
            console.warn(`[QQ] Failed to stage audio into shared media dir: ${String(err)}`);
          }
        }
        mediaMessage.push({ type: "record", data: { file: recordFile } });
      } else {
        mediaMessage.push({ type: "file", data: { file: finalUrl } });
      }

      const mediaAck = await sendOneBotMessageWithAck(client, to, mediaMessage);
      if (!mediaAck.ok) {
        if (audioLike) {
          const fileFallback: OneBotMessage = [];
          if (replyTo && !(text && text.trim())) fileFallback.push({ type: "reply", data: { id: String(replyTo) } });
          let fallbackFile = stagedAudioFile || finalUrl;
          if (fallbackFile.startsWith("base64://")) {
            return {
              channel: "qq",
              sent: Boolean(textAck),
              error: `Media send failed: ${mediaAck.error || "unknown"}`,
              textSent: Boolean(textAck),
              mediaSent: false,
              messageId: textAck?.message_id ?? textAck?.messageId ?? null,
            };
          }
          if (!finalUrl.startsWith("base64://") && hostSharedDir) {
            try {
              const localPath = finalUrl.startsWith("file:") ? fileURLToPath(finalUrl) : finalUrl;
              const copiedName = await ensureFileInSharedMedia(localPath, hostSharedDir);
              fallbackFile = path.posix.join(containerSharedDir.replace(/\\/g, "/"), copiedName);
            } catch (err) {
              console.warn(`[QQ] Failed to stage fallback audio file into shared media dir: ${String(err)}`);
            }
          }
          fileFallback.push({ type: "file", data: { file: fallbackFile } });
          const fallbackAck = await sendOneBotMessageWithAck(client, to, fileFallback);
          if (fallbackAck.ok) {
            return {
              channel: "qq",
              sent: true,
              textSent: Boolean(textAck),
              mediaSent: false,
              fallbackSent: true,
              fallbackType: "file",
              error: `Audio(record) failed; fallback file sent. reason=${mediaAck.error || "unknown"}`,
              messageId:
                fallbackAck.data?.message_id ??
                fallbackAck.data?.messageId ??
                textAck?.message_id ??
                textAck?.messageId ??
                null,
            };
          }
        }
        return {
          channel: "qq",
          sent: Boolean(textAck),
          error: `Media send failed: ${mediaAck.error || "unknown"}`,
          textSent: Boolean(textAck),
          mediaSent: false,
          messageId: textAck?.message_id ?? textAck?.messageId ?? null,
        };
      }
      return {
        channel: "qq",
        sent: true,
        textSent: Boolean(textAck),
        mediaSent: true,
        messageId: mediaAck.data?.message_id ?? mediaAck.data?.messageId ?? textAck?.message_id ?? textAck?.messageId ?? null,
      };
    },

    deleteMessage: async ({ messageId, accountId }: { messageId: string; accountId?: string }) => {
      const client = getClientForAccount(accountId || DEFAULT_ACCOUNT_ID);
      if (!client) return { channel: "qq", success: false, error: "Client not connected" };
      try {
        client.deleteMsg(messageId);
        return { channel: "qq", success: true };
      } catch (err) {
        return { channel: "qq", success: false, error: String(err) };
      }
    },
  };
}
