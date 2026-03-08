# Advanced Features & Full Parameters

> This page keeps the previous long-form README content.

# OpenClaw QQ Plugin (OneBot v11)

## 📚 Docs Hub

- [Docs Home](./docs/index.en.md)
- [3-minute Quickstart](./docs/quickstart.en.md)
- [Config Reference (Grouped)](./docs/config-reference.en.md)

## 📢 Official Discussion Channel (Primary)

**Designated forum for this plugin:**  
**https://aiya.de5.net/c/25-category/25**

- We do not run a QQ group for plugin support.
- All questions, updates, and feedback are centralized on the forum.
- Forum threads are easier to search and better for long-term knowledge retention.

OpenClawd is a multi-purpose agent. The chat demo below only shows the most basic capabilities.

## Recent Updates (2026-02)

- Fixed `channel restart` / `health-monitor` restart loop: `startAccount` now stays alive until `abort`, so the gateway no longer treats the provider task as exited immediately.
- Added `isConnected()` in the OneBot client for duplicate-start suppression on the same account.
- Improved outbound reliability: failed WS sends are re-queued and trigger reconnect, reducing "logged as sent but not delivered in QQ" cases.
- Added heartbeat event passthrough from client to upper layer for better health visibility.
- Added multi-layer context parsing: recursive `reply/forward` expansion with layered text/image/file hints injected into context.
- Added auto-retry + Fast Fail: supports `maxRetries` / `retryDelayMs` / `fastFailErrors`; these controls are disabled by default and can be enabled when needed.
- Added Active Model Failover: automatically switches to `fallbacks` in `openclaw.json` when the primary model repeatedly fails or returns empty output.
- Added concurrency anti-drop queue: concurrent messages in the same session are debounced and serialized to reduce "busy drop" cases.
- Added hidden QQ metadata injection: optional gateway context (trigger type/session label/source) can be injected into system context (enabled by default).
- Added same-session interruption: when a new message arrives, in-progress old reply output is soft-interrupted and switched to the latest request.
- Added long-reply forward mode: replies over a configurable threshold can be sent as QQ merged forward messages to reduce spam.

This plugin adds full-featured QQ channel support to [OpenClaw](https://github.com/openclaw/openclaw) via the OneBot v11 protocol (WebSocket). It supports not only basic chat, but also group administration, QQ Guild channels, multimodal interaction, and production-grade risk controls.

## ✨ Core Features

### 🧠 Deep Intelligence & Context
* **History Backtracking (Context)**: Optionally fetch the latest N messages in group chats (default: `0`, no extra injection), for scenarios where you need to forcibly preserve raw historical context.
* **System Prompt**: Inject custom prompts so the bot can play specific roles (for example, a “catgirl” or a “strict admin”).
* **Multi-layer Reply/Forward Parsing**: The AI can recursively expand reply chains and merged forwards, injecting layered text/image/file hints for more reliable context understanding.
* **Keyword Wake-up**: In addition to @mentions, you can configure specific keywords (for example, “assistant”) to trigger conversation.
* **Hidden Gateway Metadata Injection**: Appends a hidden `<qq_context>` block (not visible to end users) so the model can better understand trigger source and session type.

### 🛡️ Powerful Management & Risk Control
* **Active Model Failover**: Built-in retry mechanism with backoff logic. If the primary LLM API fails due to rate limits/timeouts or returns an empty response repeatedly, it automatically and seamlessly switches to defined fallback models in `openclaw.json` (triggering on the 3rd attempt) to guarantee 24/7 chat availability.
* **Self-healing Connection**: Built-in heartbeat detection plus exponential backoff reconnection can auto-detect and recover “zombie connections” for 24/7 uptime.
* **Group Moderation Commands**: Admins can use commands directly in QQ to manage members (mute/kick).
* **Allow/Block Lists**:
  * **Group Allowlist**: Reply only in specified groups to avoid spam/ad groups.
  * **User Blocklist**: Block harassment from malicious users.
* **Automatic Request Handling**: Optionally auto-approve friend requests and group invites for unattended operation.
* **Production-grade Risk Control**:
  * **@mention Trigger by Default**: `requireMention` is enabled by default; the bot only replies when mentioned, reducing token spend and noise.
  * **Rate Limiting**: Automatically inserts random delays when sending multiple messages to reduce QQ anti-spam risk.
  * **URL Evasion**: Automatically processes links (for example, inserting spaces) to reduce the chance of message suppression.
  * **System Account Filtering**: Automatically ignores interference from QQ system accounts (for example, QQ Butler).

### 🎭 Rich Interaction Experience
* **Poke**: When a user pokes the bot, the AI can detect it and respond in a fun way.
* **Human-like Replies**:
  * **Auto @mention**: In group replies, automatically @mentions the original sender (first segment only), matching human social norms.
  * **Interrupt Old Reply on New Input**: In the same session, if a new message arrives while replying, output switches to the latest request.
  * **Nickname Resolution**: Converts `[CQ:at]` codes to real nicknames (for example, `@ZhangSan`) so replies feel more natural.
  * **Long Reply as Merged Forward**: You can set a character threshold; once exceeded, the plugin sends QQ merged forward messages instead of many split chunks.
* **Multimodal Support**:
  * **Images**: Supports sending and receiving images. Optimized for `base64://` so it works even when the bot and OneBot server are not in the same LAN.
  * **Voice**: Receives voice messages (requires server-side STT support) and can optionally send TTS voice replies.
  * **Files**: Supports file send/receive in groups and private chats.
* **QQ Guild Channels**: Native support for QQ Guild message send/receive.

## 🔐 Permission & Security Model

- `admins`: source of admin identity; only admins can run management commands (`/kick`, `/status`, `/newsession`, etc.).
- `adminOnlyChat`: whether only admins can trigger normal AI chat replies. Recommended for production groups.
- `allowedGroups` / `blockedUsers`: ingress allowlist/blocklist for traffic and abuse control.
- Command auth: when a command is detected, the plugin computes `CommandAuthorized` based on admin identity (no longer hardcoded allow).
- Recommended baseline: `requireMention=true` + `keywordTriggers` + `adminOnlyChat=true`.

## ⚠️ Known Limits (Read Before Production)

- QQ does not support Telegram-like native streaming output, message editing, or inline buttons.
- Recursive forward/reply parsing increases context-token usage; tune depth/char budgets for busy groups.
- Keep `debugLayerTrace` off in production (default is off); enable only while troubleshooting.

---

## 📋 Prerequisites

1. **OpenClaw**: OpenClaw main program is installed and running.
2. **OneBot v11 Server**: You need a running OneBot v11 implementation.
   * Recommended: **[NapCat (Docker)](https://github.com/NapCatQQ/NapCat-Docker)** or **Lagrange**.
   * **Important**: In OneBot config, set `message_post_format` to `array`, otherwise multimedia parsing will fail.
   * Network: make sure forward WebSocket service is enabled (usually port `3001`).

---

## 🚀 Installation

### Method 1: OpenClaw CLI (Recommended)
If your OpenClaw version supports plugin marketplace or CLI install:
```bash
# Enter extension directory
cd openclaw/extensions
# Clone repository
git clone https://github.com/constansino/openclaw_qq.git qq
# Install deps and build
cd ../..
pnpm install && pnpm build
```

### Method 2: Docker Integration
In your `docker-compose.yml` or `Dockerfile`, copy this plugin code into `/app/extensions/qq`, then rebuild the image.

---

## ⚙️ Configuration

### 1. Standard Setup (OpenClaw Setup)
If integrated into OpenClaw CLI, run:
```bash
openclaw setup qq
```

### 2. Manual Configuration (`openclaw.json`)
You can also edit config directly. Full config example:

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://127.0.0.1:3001",
      "accessToken": "YourToken",
      "admins": "12345678,87654321",
      "adminOnlyChat": false,
      "notifyNonAdminBlocked": false,
      "nonAdminBlockedMessage": "Only admins can trigger this bot currently.\nPlease contact an administrator if you need access.",
      "blockedNotifyCooldownMs": 10000,
      "showProcessingStatus": true,
      "showReplySessionSource": true,
      "processingStatusDelayMs": 500,
      "processingStatusText": "输入中",
      "maxRetries": 0,
      "retryDelayMs": 3000,
      "fastFailErrors": [],
      "allowedGroups": "10001,10002",
      "blockedUsers": "999999",
      "systemPrompt": "You are a QQ bot named 'Artificial Dummy', with a witty and humorous speaking style.",
      "historyLimit": 0,
      "keywordOnlyTrigger": false,
      "keywordTriggers": "assistant, help",
      "autoApproveRequests": true,
      "enableGuilds": true,
      "enableTTS": false,
      "sharedMediaHostDir": "/Users/yourname/openclaw_qq/deploy/napcat/shared_media",
      "sharedMediaContainerDir": "/openclaw_media",
      "rateLimitMs": 1000,
      "formatMarkdown": true,
      "antiRiskMode": false,
      "maxMessageLength": 4000,
      "queueDebounceMs": 0,
      "injectGatewayMeta": false,
      "interruptOnNewMessage": false,
      "forwardLongReplyThreshold": 0,
      "forwardNodeCharLimit": 1000,
      "forwardNodeName": "OpenClaw"
    }
  },
  "plugins": {
    "entries": {
      "qq": { "enabled": true }
    }
  },
  "session": {
    "dmScope": "per-channel-peer"
  }
}
```

### 3. Cross-Channel DM Session Isolation (Strongly Recommended)

If you run multiple DM channels at the same time (for example Telegram + QQ + Feishu), enable this top-level OpenClaw setting:

```json
{
  "session": {
    "dmScope": "per-channel-peer"
  }
}
```

Why: with `dmScope=main` (default), direct chats can collapse into the main session key (`agent:main:main`), which may mix context across channels.
This plugin also namespaces QQ private `fromId` as `qq:user:<id>` to further reduce cross-channel user-id collisions.

> If you intentionally want cross-platform shared context, choose another scope. For strict isolation, prefer `per-channel-peer`.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `wsUrl` | string | **Required** | OneBot v11 WebSocket URL |
| `accessToken` | string | - | Connection auth token |
| `admins` | string | `""` | **Admin QQ ID list (string)**. In Web form: `10000001,123456789`; in Raw JSON: `"10000001,123456789"`. Used for admin command permissions like `/status`, `/kick`. |
| `adminOnlyChat` | boolean | `false` | **Only admins can trigger chat replies**. When enabled, non-admins cannot trigger conversations even if they @mention the bot (useful to prevent token abuse). |
| `notifyNonAdminBlocked` | boolean | `false` | When `adminOnlyChat=true` and a non-admin triggers, whether to send a rejection notice. |
| `nonAdminBlockedMessage` | string | `Only admins can trigger this bot currently.\nPlease contact an administrator if you need access.` | Rejection message shown to blocked non-admin users. |
| `blockedNotifyCooldownMs` | number | `10000` | Cooldown (ms) for non-admin rejection notices. Prevents repeated notices within the same session/user target. |
| `maxRetries` | number | `0` | **Max auto-retries**. Auto-retry is disabled by default; set this above `0` if you want model failures or empty replies to retry automatically. |
| `retryDelayMs` | number | `3000` | Delay in milliseconds between retries. Only applies when `maxRetries > 0`. |
| `fastFailErrors` | array | `[]` | A list of fast-skip error keywords. Disabled by default; when you add terms like `"401"`, `"Unauthorized"`, or `"No API key found"`, unrecoverable auth/billing errors skip the current model immediately. |
| `queueDebounceMs` | number | `0` | Debounce window (ms) for same-session burst merging. Disabled by default; set it above `0` to group burst messages before dispatch. |
| `injectGatewayMeta` | boolean | `false` | Whether to inject hidden QQ gateway metadata (`<qq_context>`) for better model awareness of source/trigger/session. Disabled by default. |
| `interruptOnNewMessage` | boolean | `false` | Whether to soft-interrupt the in-progress reply when a newer message arrives in the same session. Disabled by default. |
| `forwardLongReplyThreshold` | number | `0` | Character threshold for auto-switching long replies to QQ merged forward mode. `0` disables this behavior. |
| `forwardNodeCharLimit` | number | `1000` | Max chars per node when long replies are sent as merged forwards. |
| `forwardNodeName` | string | `OpenClaw` | Display name used in merged forward nodes for long replies. |
| `enableEmptyReplyFallback` | boolean | `true` | Empty-reply fallback switch. If the model returns empty content, the bot sends a user-visible hint instead of appearing silent. |
| `emptyReplyFallbackText` | string | `⚠️ The model returned empty content this turn. Please retry, or run /newsession first.` | Fallback text used when a model turn returns empty output. |
| `showProcessingStatus` | boolean | `true` | Busy-status visualization (enabled by default). While processing, the bot temporarily appends ` (输入中)` to its group card. |
| `showReplySessionSource` | boolean | `true` | Whether to prepend a session-source hint to each user-facing reply, such as `(from 会话draft)` or `(from 主会话)`. Enabled by default; especially useful when you use `/tmp` sessions heavily. |
| `processingStatusDelayMs` | number | `500` | Delay in milliseconds before applying the busy suffix. |
| `processingStatusText` | string | `输入中` | Busy suffix text. Default is `输入中`. |
| `requireMention` | boolean | `true` | **Group trigger gate**. `true` = trigger only on @mention / reply-to-bot / keyword hit; if `keywordOnlyTrigger` is also enabled, group chats accept keyword hits only; `false` = normal group messages may also trigger (not recommended for long-term use). |
| `keywordOnlyTrigger` | boolean | `false` | **Keyword-only trigger mode for groups**. When enabled, @mentions and reply-to-bot messages no longer trigger; use it together with `keywordTriggers` when you share one QQ account with another bot and want to avoid duplicate replies. |
| `allowedGroups` | string | `""` | **Group allowlist (string)**. In Web form: `20000001 123456789`; in Raw JSON: `"20000001 123456789"`. If set, bot only replies in listed groups. |
| `blockedUsers` | string | `""` | **User blocklist (string)**. In Web form: `30000001` or `30000001,10002`; in Raw JSON: `"30000001"`. Bot ignores messages from these users. |
| `systemPrompt` | string | - | **Persona/system role prompt** injected into AI context. |
| `historyLimit` | number | `0` | **Number of historical messages to inject**. Default relies on OpenClaw session system; set `>0` only when you explicitly need to force raw group history into each turn. |
| `enrichReplyForwardContext` | boolean | `true` | Enable layered context enrichment from recursive reply/forward parsing. |
| `maxReplyLayers` | number | `5` | Max recursive depth for reply chains. |
| `maxForwardLayers` | number | `5` | Max recursive depth for forward chains. |
| `maxForwardMessagesPerLayer` | number | `8` | Max expanded child messages per forward layer. |
| `maxCharsPerLayer` | number | `900` | Max extracted text chars per layer. |
| `maxTotalContextChars` | number | `3000` | Total char budget for injected reply/forward context. |
| `includeSenderInLayers` | boolean | `true` | Include sender nickname/ID in layered context lines. |
| `includeCurrentOutline` | boolean | `true` | Include a "current message outline" layer. |
| `debugLayerTrace` | boolean | `false` | Debug switch for layered parsing traces. |

> Recommendation: keep `historyLimit = 0` by default. This aligns better with Telegram channel behavior and reduces redundant context injection and log noise.
> Only enable `historyLimit` (for example `3~5`) when you explicitly want to append recent raw group messages on every turn.
>
> Security recommendation: if you worry about heavy token usage from frequent group @mentions, configure `admins` and enable `adminOnlyChat = true`.

| `keywordTriggers` | string | `""` | **Keyword trigger list (string)**. In Web form: `assistant, help me`; in Raw JSON: `"assistant, help me"`. When `requireMention=true`, keyword hits can trigger without @mention; when `requireMention=false`, keywords are not required to trigger; when `keywordOnlyTrigger=true`, group chats trigger only when one of these keywords is hit. |
| `autoApproveRequests` | boolean | `false` | Whether to auto-approve friend requests and group invites. |
| `enableGuilds` | boolean | `true` | Whether to enable QQ Guild support. |
| `enableTTS` | boolean | `false` | (Experimental) Whether to convert AI replies into voice (requires server-side TTS support). |
| `sharedMediaHostDir` | string | `""` | Optional host-side shared media directory. Recommended: `openclaw_qq/deploy/napcat/shared_media` so local audio can be copied to a NapCat-accessible path. |
| `sharedMediaContainerDir` | string | `"/openclaw_media"` | Optional in-container mount path for shared media. Must match `deploy/napcat/docker-compose.yml`. |
| `rateLimitMs` | number | `1000` | **Send rate limit**. Delay in ms between multiple segments; `1000` is recommended for anti-risk control. |
| `formatMarkdown` | boolean | `false` | Whether to convert Markdown tables/lists to readable plain-text formatting for QQ. |
| `antiRiskMode` | boolean | `false` | Whether to enable anti-risk formatting (for example, adding spaces in URLs). |
| `maxMessageLength` | number | `4000` | Max length per message. Longer output is auto-split. |

### 4. Tuning Multi-layer Reply/Forward Parsing

- Safe defaults for busy groups: `maxReplyLayers=3~5`, `maxForwardLayers=2~4`, `maxForwardMessagesPerLayer=5~8`.
- To reduce token cost first lower `maxForwardMessagesPerLayer` and `maxTotalContextChars`.
- Keep `includeSenderInLayers=true` if sender attribution matters for your workflows.
- Use `debugLayerTrace=true` only during diagnosis, then switch it back off.

### 5. Active Model Failover Configuration

This plugin features a built-in auto-failover mechanism that triggers upon repeated request failures or empty AI replies. It is disabled by default; once you set `maxRetries` above `0`, you can combine it with `retryDelayMs` to switch to fallback models when the primary model encounters rate limits or errors.

To configure this, find or add the `model` object field inside your `openclaw.json` (either globally at `agents.defaults.model` or inside a specific agent configuration), and define a `fallbacks` array like so:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "provider-a/your-primary-model", 
        "fallbacks": [
          "provider-b/your-fallback-model",
          "provider-c/another-fallback-model"
        ]
      }
    }
  }
}
```

> **Trigger Condition**: General network errors will attempt to retry on the current model up to `maxRetries` times. However, if the error contains a phrase defined in `fastFailErrors` (e.g., "401", "API Key Invalid"), the system skips the retries and **instantly jumps** to the next available `fallbacks` model to avoid waiting.

### 6. Smart Concurrency Queue

The plugin implements a localized sliding-window debounce queue per-group/per-user to mitigate the risk of message dropping. If 5 users talk to the bot in a group simultaneously, the queue will capture all 5 events, combine them as context, and ensure they are sequentially processed instead of OpenClaw rejecting concurrent events as busy.

- Debounce window: controlled by `queueDebounceMs` (default `0`, disabled; set it above `0` to enable burst merging).
- Scope: local to each session key (group/direct/channel), not a global single queue.
- Tuning: increase to `4000~6000` for heavy group bursts; decrease to `1000~2000` if you prefer lower latency.


---

## 🎮 Usage Guide

### 🗣️ Basic Chat
* **Private Chat**: Just send messages directly to the bot.
* **Group Chat**:
  * `@bot` + message.
  * Reply to a bot message.
  * Send messages containing configured **keywords** (for example, `assistant`).
  * **Poke** the bot avatar.

> If you enable `keywordOnlyTrigger=true`, the `@bot` and reply-to-bot paths above stop triggering in group chats; only `keywordTriggers` hits continue to trigger.

### 👥 Recommended: Create a 2-Person Test Group

Strongly recommended: create a separate test group with only 2 members (you + the bot) for troubleshooting and status checks:

- You can clearly observe whether the bot card suffix (for example `输入中`) appears and recovers correctly.
- Less noise than a busy production group, so it is easier to distinguish "processing" vs "idle".
- Validate new features first (`/newsession`, model switching, file/voice sending), then roll out to the main group.

> Practical workflow: keep your main group for normal usage, and use the 2-person group for debugging/stress tests.

### 🧭 Trigger Rules Quick Reference (Important)

Pay close attention to the combination of `requireMention`, `keywordOnlyTrigger`, and `keywordTriggers`:

- `keywordOnlyTrigger=true` + non-empty `keywordTriggers`:
  - Group chat triggers only on **keyword hit**; **@mentions / reply-to-bot** no longer trigger.
- `keywordOnlyTrigger=true` + empty `keywordTriggers`:
  - Normal group text, @mentions, and replies will not trigger; configure a wake word first.

- `requireMention=true` + empty `keywordTriggers`:
  - Trigger only on **@mention** or **reply-to-bot**.
- `requireMention=true` + non-empty `keywordTriggers`:
  - Trigger on **@mention / reply-to-bot / keyword hit** (any one).
- `requireMention=false` (with or without keywords):
  - Normal group messages may trigger; keywords are no longer a required condition.

> If you want "no @mention needed, but wake-word required", use:
>
> - `requireMention=true`
> - `keywordTriggers="yezi"` (or multiple keywords)

> If you want "wake word only; ignore @mentions and replies", use:
>
> - `keywordOnlyTrigger=true`
> - `keywordTriggers="yezi"` (or multiple keywords)

### 👮‍♂️ Admin Commands
Only users listed in `admins` can use:

* Group model command support (admin-only):
  * `@bot /models` directly triggers model listing (admin-only).
  * `@bot /model` and `@bot /model 28` are also admin-only in groups.
  * `@bot /newsession` or `wakeword /newsession` resets the **current session lane** (admin-only).

* Temporary session lanes (tmux-like topic split in one group, admin-only):
  * `/临时 <name>` enter/create a temporary lane (example: `/临时 检查ssh`; full phrase is preserved, not reduced to `ssh`).
  * `/临时重命名 <new-name>` rename the current temporary lane.
  * `/临时状态` show current lane and effective session key.
  * `/临时列表` list all recorded temporary lanes in this group (no 12-item cap; marks current one).
  * `/退出临时` leave temporary lane and return to main lane (keeps lane data).
  * `/临时结束` clear and end current temporary lane, then return to main lane.
  * Aliases: `/tmp`, `/tmprename`, `/tmpstatus`, `/tmplist`, `/exittemp`, `/tmpend`.
  * Current version does not support numeric switching like `/临时 1`; use `/临时 <name>` instead.

* `/status`
  * View bot runtime status (memory usage, connection status, self ID).
* `/help`
  * Show help menu.
* `/mute @user [minutes]` (group only)
  * Mute the specified user. Defaults to 30 minutes if omitted.
  * Example: `/mute @ZhangSan 10`
* `/kick @user` (group only)
  * Remove the specified user from the group.

### 💻 CLI Usage
If you operate OpenClaw from a server terminal, use these standard commands:

1. **Check status**
   ```bash
   openclaw status
   ```
   Shows QQ connection status, latency, and current bot nickname.

2. **List groups/channels**
   ```bash
   openclaw list-groups --channel qq
   ```
   Lists all joined groups and channel IDs.

3. **Send messages proactively**
   ```bash
   # Send private message
   openclaw send qq 12345678 "Hello, this is a test message"

   # Send group message (use group: prefix)
   openclaw send qq group:88888888 "Hello everyone"

   # Send guild channel message
   openclaw send qq guild:GUILD_ID:CHANNEL_ID "Channel message"
   ```

### 🔐 Recommended Admin/Blocklist Setup (Anti-abuse)

If you want only specific QQ IDs to trigger the bot (especially in groups), use this setup:

1. **Set admins (allowed to trigger chat)**
   ```bash
   openclaw config set channels.qq.admins '"10000001,123456789"' --json
   ```

2. **Enable admin-only chat triggering**
   ```bash
   openclaw config set channels.qq.adminOnlyChat true --json
   ```

3. **(Optional) Notify blocked non-admins + debounce**
   ```bash
   openclaw config set channels.qq.notifyNonAdminBlocked true --json
   openclaw config set channels.qq.nonAdminBlockedMessage '"Only admins can trigger this bot currently."' --json
   openclaw config set channels.qq.blockedNotifyCooldownMs 10000 --json
   ```

4. **Set blocklist (silently ignore, no reply)**
   ```bash
   openclaw config set channels.qq.blockedUsers '"30000001,10002"' --json
   ```

5. **Restart gateway to apply**
   ```bash
   openclaw gateway restart
   ```

6. **(Recommended) Enable shared media mount (fix cross-container audio path issues)**
   ```bash
   mkdir -p openclaw_qq/deploy/napcat/shared_media
   cd openclaw_qq/deploy/napcat && docker compose up -d

   openclaw config set channels.qq.sharedMediaHostDir '"/Users/yourname/openclaw_qq/deploy/napcat/shared_media"' --json
   openclaw config set channels.qq.sharedMediaContainerDir '"/openclaw_media"' --json
   openclaw gateway restart
   ```

> Note: `admins` / `blockedUsers` are stored as **string lists** in this plugin. For CLI, always use the `--json` form above.
>
> In Web config form, you can directly enter: `10000001,123456789` (no manual quotes required). In Raw JSON mode, enter: `"10000001,123456789"`.

### ⚠️ About `invalid config` errors on `/config`

If you edit QQ settings in OpenClaw Web UI and see errors pointing to `models.providers.*.models[].maxTokens`, that is an **OpenClaw Core full-payload validation path issue**, not QQ plugin business logic.

Related tracking (English):

- Issue: https://github.com/openclaw/openclaw/issues/13959
- PR: https://github.com/openclaw/openclaw/pull/13960

Before upstream merges the fix, prefer the CLI commands above for `channels.qq.*` updates to avoid most Web form serialization/validation noise.

---

## ❓ FAQ

**Q: Why does installation fail with `openclaw @workspace:* not found`?**
A: This was caused by workspace protocol settings in the parent environment. It is fixed in the latest version. Run `git pull`, then use `pnpm install` or `npm install` directly.

**Q: Why doesn’t the bot respond to images?**
A:
1. Confirm your OneBot implementation (for example NapCat) has image reporting enabled.
2. It is recommended to enable “image to Base64” in OneBot config, so even if OpenClaw runs on a public cloud server, it can still receive images from local/private networks.
3. The plugin now auto-detects and extracts images; `message_post_format: array` is no longer strictly required for image extraction.

**Q: Can this work when bot and OneBot are not in the same network (not LAN)?**
A: **Yes.** As long as `wsUrl` is reachable via tunnel/public IP and images are transmitted via Base64, cross-region deployment works.

**Q: Why no replies in group chat?**
A:
1. If `keywordOnlyTrigger` is not enabled, check whether `requireMention` is enabled (enabled by default): you must @mention the bot.
2. Check whether the group is included in `allowedGroups` (if set).
3. Check OneBot logs to confirm events are being delivered.

**Q: Why did the bot reply even without @mention and without wake word?**
A: Most likely `requireMention` is set to `false`. In that mode, normal group messages may trigger. If you want "non-@mention must include wake word", set:

1. `requireMention=true`
2. Put your wake word in `keywordTriggers` (for example, `yezi`)

**Q: I want group chats to react only to wake words and ignore @mentions / replies. How should I configure it?**
A: Set:

1. `keywordOnlyTrigger=true`
2. Put your wake word in `keywordTriggers` (for example, `yezi`)

**Q: Why do QQ request logs include prior chat text/history?**
A: That is controlled by `historyLimit`. Current default is `0`, meaning no extra group-history injection; context is mainly managed by OpenClaw session system (closer to Telegram behavior).
If you set `historyLimit > 0`, the plugin appends recent raw group messages on each group request.


**Q: How can I tell whether the bot is busy or idle?**
A: `showProcessingStatus=true` is enabled by default. While running a task, the bot temporarily changes its group card to `yezi(输入中)`, then restores it after completion.
You can also use admin command `/status` and check `ActiveTasks`:
- `ActiveTasks > 0`: still processing
- `ActiveTasks = 0`: idle now, a new instruction is required to continue

## 🆕 Recent Improvements

* Fixed `admins` logic: `admins` now controls admin-command permissions only and no longer blocks normal group messages.
* Optimized session routing: QQ sessions now use the standard router, reducing session misalignment/confusion in Console/WebUI.
* Reduced context noise: `historyLimit` default changed to `0`, relying on session system by default instead of repeatedly injecting raw history.

**Q: How to enable bot voice (TTS)?**
A: Set `enableTTS` to `true`. Note this depends on OneBot server-side TTS support. NapCat/Lagrange support may be limited and could require extra plugin support.

---

## 🆚 Feature Differences vs Telegram Plugin

If you are used to OpenClaw Telegram plugin, here are the major experience differences in `openclaw_qq`:

| Feature | QQ Plugin (openclaw_qq) | Telegram Plugin | Difference Notes |
| :--- | :--- | :--- | :--- |
| **Message Formatting** | **Plain text** | **Native Markdown** | QQ does not support rich markdown formatting; plugin auto-converts output format. |
| **Streaming Output** | ❌ Not supported | ✅ Supported | TG can show live typing/streaming; QQ waits and sends full output after completion. |
| **Message Editing** | ❌ Not supported | ✅ Supported | TG can edit sent content; QQ cannot edit after send (only recall). |
| **Interactive Buttons** | ❌ Not yet | ✅ Supported | TG supports inline buttons; QQ currently relies on text commands. |
| **Risk Control Level** | 🔴 **Very high** | 🟢 **Very low** | QQ is much easier to rate-limit/flag; plugin includes built-in segmented send throttling. |
| **Poke Interaction** | ✅ **Supported** | ❌ Not supported | QQ-specific social interaction that AI can detect/respond to. |
| **Forwarded Message Parsing** | ✅ **Deep support** | ❌ Basic support | QQ plugin has dedicated optimization for merged-forwarded chat parsing. |
