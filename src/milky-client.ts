import WebSocket from "ws";
import EventEmitter from "events";
import type { OneBotEvent, OneBotMessage, OneBotMessageSegment } from "./types.js";

interface MilkyClientOptions {
  baseUrl: string;
  accessToken?: string;
}

type MilkyIncomingSeg =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { resource_id: string; temp_url?: string } }
  | { type: "record"; data: { resource_id: string; temp_url?: string } }
  | { type: "video"; data: { resource_id: string; temp_url?: string } }
  | { type: "file"; data: { file_id: string; file_name: string; file_size?: number } }
  | { type: "mention"; data: { user_id: number } }
  | { type: "mention_all"; data: Record<string, never> }
  | { type: "face"; data: { face_id: string } }
  | { type: "reply"; data: { message_seq: number; sender_id: number; time: number; segments?: MilkyIncomingSeg[]; sender_name?: string } }
  | { type: "forward"; data: { id: string } }
  | { type: "light_app"; data: { json_payload: string } };

type MilkyEvent = {
  event_type: string;
  time: number;
  self_id: number;
  data: {
    message_scene?: "friend" | "group" | "temp";
    peer_id?: number;
    message_seq?: number;
    sender_id?: number;
    time?: number;
    segments?: MilkyIncomingSeg[];
    friend?: { user_id: number; nickname: string; remark?: string };
    group?: { group_id: number; group_name: string };
    group_member?: { user_id: number; nickname: string; card?: string; role?: string };
    [key: string]: unknown;
  };
};

function toInt(value: unknown): number {
  if (typeof value === "number") return value;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : 0;
}

export class MilkyClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: MilkyClientOptions;
  private selfId: number | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectDelay = 60000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private msgSceneCache = new Map<string, { scene: string; peer_id: number }>();
  private replyCache = new Map<string, unknown>();

  constructor(options: MilkyClientOptions) {
    super();
    this.options = options;
  }

  getSelfId(): number | null { return this.selfId; }
  setSelfId(id: number) { this.selfId = id; }
  isConnected(): boolean { return this.connected; }

  emitEvent(payload: OneBotEvent) {
    this.emit("message", payload);
  }

  private get httpBase(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  private get wsEventUrl(): string {
    return this.httpBase.replace(/^http(s?):\/\//, (_, s: string) => `ws${s}://`) + "/event";
  }

  connect() {
    this.cleanup();
    const headers: Record<string, string> = {};
    if (this.options.accessToken) headers["Authorization"] = `Bearer ${this.options.accessToken}`;

    try {
      this.ws = new WebSocket(this.wsEventUrl, { headers });

      this.ws.on("open", () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.lastMessageAt = Date.now();
        this.emit("connect");
        console.log("[QQ/Milky] Connected");
        this.startHeartbeat();
      });

      this.ws.on("message", (data) => {
        this.lastMessageAt = Date.now();
        try {
          const event = JSON.parse(data.toString()) as MilkyEvent;
          this.dispatchInboundEvent(event);
        } catch { /* ignore non-JSON */ }
      });

      this.ws.on("pong", () => {
        this.lastMessageAt = Date.now();
      });

      this.ws.on("close", () => { this.handleDisconnect(); });

      this.ws.on("error", (err) => {
        console.error("[QQ/Milky] WebSocket error:", err);
        this.handleDisconnect();
      });
    } catch (err) {
      console.error("[QQ/Milky] Failed to connect:", err);
      this.scheduleReconnect();
    }
  }

  disconnect() { this.cleanup(); }

  private cleanup() {
    this.connected = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, "cleanup");
      } else if (this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate();
      }
      this.ws = null;
    }
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const staleMs = Date.now() - this.lastMessageAt;
      if (staleMs > 90000) {
        console.warn(`[QQ/Milky] No pong for ${Math.round(staleMs / 1000)}s, reconnecting...`);
        this.handleDisconnect();
        return;
      }
      this.ws.ping();
    }, 30000);
  }

  private handleDisconnect() {
    this.cleanup();
    this.emit("disconnect");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    console.log(`[QQ/Milky] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts + 1})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  private dispatchInboundEvent(event: MilkyEvent) {
    if (event.event_type !== "message_receive") return;
    const translated = this.translateEvent(event);
    if (!translated) return;
    if (translated.self_id && !this.selfId) this.selfId = translated.self_id;
    this.emit("message", translated);
  }

  private translateEvent(event: MilkyEvent): OneBotEvent | null {
    const d = event.data;
    const scene = d.message_scene;
    if (!scene) return null;

    if (d.message_seq != null && d.peer_id != null) {
      this.msgSceneCache.set(String(d.message_seq), { scene, peer_id: d.peer_id });
      if (this.msgSceneCache.size > 1000) {
        const firstKey = this.msgSceneCache.keys().next().value;
        if (firstKey != null) this.msgSceneCache.delete(firstKey);
      }
    }

    const segments = d.segments ?? [];
    const message = segments
      .map((s) => this.translateSegIn(s))
      .filter((s): s is OneBotMessageSegment => s !== null);

    for (const seg of segments) {
      if (seg.type === "reply" && seg.data.message_seq != null) {
        const key = String(seg.data.message_seq);
        if (!this.replyCache.has(key)) {
          this.replyCache.set(key, {
            message_id: key,
            time: seg.data.time ?? 0,
            message_type: scene === "group" ? "group" : "private",
            sender: { user_id: seg.data.sender_id ?? 0, nickname: seg.data.sender_name ?? String(seg.data.sender_id ?? "") },
            message: (seg.data.segments ?? []).map((s) => this.translateSegIn(s)).filter(Boolean),
          });
          if (this.replyCache.size > 500) {
            const firstKey = this.replyCache.keys().next().value;
            if (firstKey != null) this.replyCache.delete(firstKey);
          }
        }
      }
    }

    const rawText = message
      .filter((s) => s.type === "text")
      .map((s) => (s as { type: "text"; data: { text: string } }).data.text)
      .join("");

    const sender =
      scene === "group"
        ? {
            user_id: d.group_member?.user_id ?? d.sender_id ?? 0,
            nickname: d.group_member?.nickname ?? String(d.sender_id ?? ""),
            card: d.group_member?.card,
            role: d.group_member?.role as "owner" | "admin" | "member" | undefined,
          }
        : {
            user_id: d.friend?.user_id ?? d.sender_id ?? 0,
            nickname: d.friend?.nickname ?? String(d.sender_id ?? ""),
          };

    const base: OneBotEvent = {
      time: event.time,
      self_id: event.self_id,
      post_type: "message",
      message_id: d.message_seq,
      user_id: d.sender_id,
      message,
      raw_message: rawText,
      sender,
    };

    if (scene === "group") {
      base.message_type = "group";
      base.group_id = d.peer_id;
    } else if (scene === "friend" || scene === "temp") {
      base.message_type = "private";
      base.sub_type = scene === "temp" ? "group" : "friend";
    } else {
      return null;
    }

    return base;
  }

  private translateSegIn(seg: MilkyIncomingSeg): OneBotMessageSegment | null {
    switch (seg.type) {
      case "text":
        return { type: "text", data: { text: seg.data.text } };
      case "mention":
        return { type: "at", data: { qq: String(seg.data.user_id) } };
      case "mention_all":
        return { type: "at", data: { qq: "all" } };
      case "reply":
        return { type: "reply", data: { id: String(seg.data.message_seq) } };
      case "image":
        return { type: "image", data: { file: seg.data.resource_id, url: seg.data.temp_url } };
      case "record":
        return { type: "record", data: { file: seg.data.resource_id, url: seg.data.temp_url } };
      case "video":
        return { type: "video", data: { file: seg.data.resource_id, url: seg.data.temp_url } };
      case "file":
        return { type: "file", data: { file_id: seg.data.file_id, name: seg.data.file_name, file_size: seg.data.file_size } };
      case "forward":
        return { type: "forward", data: { id: seg.data.id } };
      case "light_app":
        return { type: "json", data: { json: seg.data.json_payload } };
      default:
        return null;
    }
  }

  private translateSegOut(seg: OneBotMessageSegment): unknown {
    switch (seg.type) {
      case "text":
        return { type: "text", data: { text: seg.data.text } };
      case "at":
        return seg.data.qq === "all"
          ? { type: "mention_all", data: {} }
          : { type: "mention", data: { user_id: parseInt(seg.data.qq, 10) } };
      case "reply":
        return { type: "reply", data: { message_seq: parseInt(seg.data.id, 10) } };
      case "image":
        return { type: "image", data: { uri: seg.data.file, summary: "[图片]" } };
      case "record":
        return { type: "record", data: { uri: seg.data.file, summary: "[语音]" } };
      case "video":
        return { type: "video", data: { uri: seg.data.file, summary: "[视频]" } };
      default:
        return null;
    }
  }

  private parseCQString(text: string): unknown[] {
    const segments: unknown[] = [];
    const cqRegex = /\[CQ:(\w+)(?:,([^\]]*))?\]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = cqRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ type: "text", data: { text: text.slice(lastIndex, match.index) } });
      }
      const type = match[1];
      const params: Record<string, string> = Object.fromEntries(
        (match[2] ?? "").split(",").filter(Boolean).map((p) => {
          const eqIdx = p.indexOf("=");
          return eqIdx >= 0 ? [p.slice(0, eqIdx), p.slice(eqIdx + 1)] : [p, ""];
        })
      );
      switch (type) {
        case "at":
          if (params["qq"] === "all") segments.push({ type: "mention_all", data: {} });
          else if (params["qq"]) segments.push({ type: "mention", data: { user_id: parseInt(params["qq"], 10) } });
          break;
        case "image":
          if (params["file"]) segments.push({ type: "image", data: { uri: params["file"], summary: "[图片]" } });
          break;
        case "record":
          if (params["file"]) segments.push({ type: "record", data: { uri: params["file"], summary: "[语音]" } });
          break;
        case "video":
          if (params["file"]) segments.push({ type: "video", data: { uri: params["file"], summary: "[视频]" } });
          break;
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      segments.push({ type: "text", data: { text: text.slice(lastIndex) } });
    }
    return segments.filter(Boolean);
  }

  private translateMessage(message: OneBotMessage | string): unknown[] {
    if (typeof message === "string") return this.parseCQString(message);
    return message.map((s) => this.translateSegOut(s)).filter(Boolean);
  }

  async sendWithResponse(action: string, params: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
    if (action === "send_group_forward_msg" || action === "send_forward_msg") {
      const nodes = (params["messages"] as Array<{ data?: { name?: string; uin?: string; content?: string } }>) ?? [];
      const messages = nodes.map((node) => ({
        sender_id: parseInt(node.data?.uin ?? "0", 10) || (this.selfId ?? 0),
        sender_name: node.data?.name ?? "OpenClaw",
        time: Math.floor(Date.now() / 1000),
        message: [{ type: "text", data: { text: String(node.data?.content ?? "") } }],
      }));
      return this.apiCall("send_group_message", { group_id: params["group_id"], message: [{ type: "forward", data: { messages } }] }, timeoutMs);
    }
    if (action === "upload_group_file") {
      return this.apiCall("upload_group_file", {
        group_id: params["group_id"],
        file_uri: params["file"],
        file_name: params["name"],
        parent_folder_id: "/",
      }, timeoutMs);
    }
    if (action === "upload_private_file") {
      return this.apiCall("upload_private_file", {
        user_id: params["user_id"],
        file_uri: params["file"],
        file_name: params["name"],
      }, timeoutMs);
    }
    if (action === "get_group_file_url") {
      return this.apiCall("get_group_file_download_url", {
        group_id: params["group_id"],
        file_id: params["file_id"],
      }, timeoutMs);
    }
    if (action === "get_private_file_url") {
      return this.apiCall("get_private_file_download_url", {
        user_id: params["user_id"],
        file_id: params["file_id"],
      }, timeoutMs);
    }
    if (action === "get_group_member_info") {
      return this.apiCall("get_group_member_info", {
        group_id: toInt(params["group_id"]),
        user_id: toInt(params["user_id"]),
      }, timeoutMs);
    }
    return this.apiCall(action, params, timeoutMs);
  }

  private async apiCall(action: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    const url = `${this.httpBase}/api/${action}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.options.accessToken) headers["Authorization"] = `Bearer ${this.options.accessToken}`;

    const fetchImpl = (globalThis as Record<string, unknown>)["fetch"] as typeof fetch | undefined;
    if (typeof fetchImpl !== "function") throw new Error("Global fetch is not available");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(params ?? {}),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (payload?.["status"] === "failed") {
        throw new Error(String(payload?.["message"] ?? `Milky API error retcode=${payload?.["retcode"]}`));
      }
      return payload?.["data"] ?? payload;
    } finally {
      clearTimeout(timer);
    }
  }

  sendPrivateMsg(userId: number, message: OneBotMessage | string) {
    void this.apiCall("send_private_message", { user_id: userId, message: this.translateMessage(message) })
      .catch((err: unknown) => console.warn("[QQ/Milky] sendPrivateMsg failed:", err));
  }

  async sendPrivateMsgAck(userId: number, message: OneBotMessage | string): Promise<unknown> {
    return this.apiCall("send_private_message", { user_id: userId, message: this.translateMessage(message) }, 15000);
  }

  sendGroupMsg(groupId: number, message: OneBotMessage | string) {
    void this.apiCall("send_group_message", { group_id: groupId, message: this.translateMessage(message) })
      .catch((err: unknown) => console.warn("[QQ/Milky] sendGroupMsg failed:", err));
  }

  async sendGroupMsgAck(groupId: number, message: OneBotMessage | string): Promise<unknown> {
    return this.apiCall("send_group_message", { group_id: groupId, message: this.translateMessage(message) }, 15000);
  }

  deleteMsg(messageId: number | string) {
    const seq = String(messageId);
    const cached = this.msgSceneCache.get(seq);
    const seqNum = parseInt(seq, 10);
    if (cached?.scene === "group") {
      void this.apiCall("recall_group_message", { group_id: cached.peer_id, message_seq: seqNum }).catch(() => {});
    } else {
      void this.apiCall("recall_private_message", { user_id: cached?.peer_id ?? 0, message_seq: seqNum }).catch(() => {});
    }
  }

  async getLoginInfo(): Promise<unknown> {
    const data = await this.apiCall("get_login_info", {}) as Record<string, unknown>;
    return { user_id: data?.["uid"] ?? data?.["user_id"] ?? 0, nickname: data?.["name"] ?? data?.["nickname"] ?? "" };
  }

  async getMsg(messageId: number | string): Promise<unknown> {
    const seq = String(messageId);
    const cached = this.replyCache.get(seq);
    if (cached) return cached;
    return this.apiCall("get_message", { message_seq: parseInt(seq, 10) });
  }

  async getForwardMsg(id: string): Promise<unknown> {
    return this.apiCall("get_forwarded_messages", { id });
  }

  async getGroupInfo(groupId: number, _noCache?: boolean): Promise<unknown> {
    return this.apiCall("get_group_info", { group_id: groupId });
  }

  async getGroupList(): Promise<unknown[]> {
    try { return await this.apiCall("get_group_list", {}) as unknown[]; } catch { return []; }
  }

  async getFriendList(): Promise<unknown[]> {
    try { return await this.apiCall("get_friend_list", {}) as unknown[]; } catch { return []; }
  }

  async getGroupMsgHistory(_groupId: number): Promise<unknown> {
    return { messages: [] };
  }

  setGroupBan(groupId: number, userId: number, duration = 1800) {
    void this.apiCall("set_group_ban", { group_id: groupId, user_id: userId, duration }).catch(() => {});
  }

  setGroupKick(groupId: number, userId: number) {
    void this.apiCall("set_group_kick", { group_id: groupId, user_id: userId }).catch(() => {});
  }

  setGroupCard(_groupId: number, _userId: number, _card: string) { /* no-op: not supported by Milky */ }

  async setInputStatus(_groupId: number, _userId?: number | null): Promise<boolean> { return false; }

  setGroupAddRequest(_flag: string, _subType: string, _approve = true, _reason = "") { /* no-op */ }

  setFriendAddRequest(_flag: string, _approve = true, _remark = "") { /* no-op */ }

  sendGuildChannelMsg(_guildId: string, _channelId: string, _message: OneBotMessage | string) { /* no-op: Milky has no Guild support */ }

  async sendGuildChannelMsgAck(_guildId: string, _channelId: string, _message: OneBotMessage | string): Promise<unknown> {
    throw new Error("Guild not supported in Milky protocol");
  }

  async getGuildList(): Promise<unknown[]> { return []; }
  async getGuildServiceProfile(): Promise<unknown> { return null; }

  sendGroupPoke(_groupId: number, _userId: number) { /* no-op */ }
}
