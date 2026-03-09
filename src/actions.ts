import {
  type ChannelMessageActionAdapter,
  type ChannelMessageActionName,
  extractToolSend,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "openclaw/plugin-sdk";
import { getRegisteredQQClient } from "./registry.js";

const SUPPORTED_ACTIONS = new Set<ChannelMessageActionName>([
  "member-info",
  "channel-info",
  "react",
  "sendWithEffect",
]);

function normalizeQQActionTarget(raw: string): string {
  const value = String(raw || "").trim().replace(/^qq:/i, "");
  if (!value) return value;
  const directMatch = value.match(/^(?:user|u|dm|direct):(\d{5,12})$/i);
  if (directMatch) return `user:${directMatch[1]}`;
  const groupMatch = value.match(/^group:(\d{5,12})$/i);
  if (groupMatch) return `group:${groupMatch[1]}`;
  if (/^guild:[^:]+:[^:]+$/i.test(value)) return value;
  if (/^\d{5,12}$/.test(value)) return `user:${value}`;
  return value;
}

function parseGroupId(target: string | undefined): number | null {
  const match = String(target || "").match(/^group:(\d{5,12})$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseUserId(target: string | undefined): number | null {
  const match = String(target || "").match(/^user:(\d{5,12})$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readFlexibleId(params: Record<string, unknown>, keys: string[]): string | number | undefined {
  for (const key of keys) {
    const numeric = readNumberParam(params, key, { integer: true });
    if (typeof numeric === "number") return numeric;
    const value = readStringParam(params, key);
    if (value) return value;
  }
  return undefined;
}

function resolveTarget(params: Record<string, unknown>, toolContext?: { currentChannelId?: string }): string | undefined {
  const explicit = readStringParam(params, "to") ?? readStringParam(params, "target");
  const fallback = toolContext?.currentChannelId;
  const target = explicit || fallback;
  return target ? normalizeQQActionTarget(target) : undefined;
}

function readRequestedUserId(params: Record<string, unknown>, requesterSenderId?: string | null): number | null {
  const explicit =
    readNumberParam(params, "userId", { integer: true }) ??
    readNumberParam(params, "memberId", { integer: true }) ??
    readNumberParam(params, "targetUserId", { integer: true }) ??
    readNumberParam(params, "qq", { integer: true });
  if (typeof explicit === "number") return explicit;
  if (requesterSenderId && /^\d+$/.test(requesterSenderId.trim())) {
    const parsed = Number.parseInt(requesterSenderId.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export const qqMessageActions: ChannelMessageActionAdapter = {
  listActions: () => Array.from(SUPPORTED_ACTIONS),
  supportsAction: ({ action }) => SUPPORTED_ACTIONS.has(action),
  extractToolSend: ({ args }) => extractToolSend(args, "send"),
  handleAction: async ({ action, params, accountId, toolContext, requesterSenderId }) => {
    const client = getRegisteredQQClient(accountId ?? undefined);
    if (!client) {
      throw new Error("QQ client not connected.");
    }

    if (action === "member-info") {
      const target = resolveTarget(params, toolContext);
      const groupId = parseGroupId(target);
      const requestedUserId = readRequestedUserId(params, requesterSenderId);

      if (groupId) {
        if (requestedUserId) {
          const member = await client.getGroupMemberInfo(groupId, requestedUserId, true);
          return jsonResult({ ok: true, groupId, userId: requestedUserId, member });
        }
        const members = await client.getGroupMemberList(groupId);
        return jsonResult({
          ok: true,
          groupId,
          memberCount: Array.isArray(members) ? members.length : 0,
          members,
        });
      }

      const userId = parseUserId(target) ?? requestedUserId;
      if (!userId) {
        throw new Error("QQ member-info requires a group target or userId.");
      }
      const user = await client.getStrangerInfo(userId, true);
      return jsonResult({ ok: true, userId, user });
    }

    if (action === "channel-info") {
      const target = resolveTarget(params, toolContext);
      const groupId = parseGroupId(target);
      if (!groupId) {
        throw new Error("QQ channel-info currently supports group targets only.");
      }
      const group = await client.getGroupInfo(groupId, true);
      let announcements: any[] = [];
      try {
        const notices = await client.getGroupNotice(groupId);
        announcements = Array.isArray(notices) ? notices : (notices ? [notices] : []);
      } catch {
        announcements = [];
      }
      return jsonResult({ ok: true, groupId, group, announcements });
    }

    if (action === "react") {
      const messageId = readFlexibleId(params, ["messageId", "message_id", "id", "replyTo"]);
      if (messageId === undefined) {
        throw new Error("QQ react requires messageId.");
      }
      const reaction = readReactionParams(params, {
        removeErrorMessage: "QQ react requires emoji or emojiId.",
      });
      const emojiId = readFlexibleId(params, ["emojiId", "emoji_id"]) ?? reaction.emoji;
      await client.setMsgEmojiLike(messageId, emojiId, !reaction.remove);
      return jsonResult({ ok: true, messageId, emojiId, remove: reaction.remove });
    }

    if (action === "sendWithEffect") {
      const effectId = readStringParam(params, "effectId") ?? readStringParam(params, "effect") ?? "poke";
      if (!/poke/i.test(effectId)) {
        throw new Error("QQ sendWithEffect currently supports effectId=poke only.");
      }
      const target = resolveTarget(params, toolContext);
      const groupId = parseGroupId(target);
      if (groupId) {
        const userId = readRequestedUserId(params, requesterSenderId);
        if (!userId) {
          throw new Error("QQ group poke requires userId/memberId/targetUserId.");
        }
        client.sendGroupPoke(groupId, userId);
        return jsonResult({ ok: true, effect: "poke", groupId, userId });
      }
      const userId = parseUserId(target) ?? readRequestedUserId(params, requesterSenderId);
      if (!userId) {
        throw new Error("QQ poke requires a direct target or userId.");
      }
      await client.friendPoke(userId);
      return jsonResult({ ok: true, effect: "poke", userId });
    }

    throw new Error(`QQ action ${action} is not supported.`);
  },
};
