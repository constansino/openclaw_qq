# Config Reference (Grouped)

> Goal: know what is required first, then enable advanced options as needed.

## A. Required

- `wsUrl`: OneBot WebSocket endpoint.
- `accessToken`: OneBot token (if auth is enabled).

## B. Trigger & Access Control

- `requireMention`: group trigger gate (@mention / reply / keyword).
- `keywordOnlyTrigger`: accept keyword hits only in group chats (ignore @mentions / replies).
- `admins`: admin QQ IDs.
- `adminOnlyChat`: only admins can trigger chat.
- `allowedGroups`: group allowlist.
- `blockedUsers`: user blocklist.

## C. Reliability

- `maxRetries`: retry count on failures (default `0`, disabled).
- `retryDelayMs`: delay between retries (only applies when `maxRetries > 0`).
- `fastFailErrors`: skip waiting for unrecoverable errors (default `[]`, disabled).
- `enableEmptyReplyFallback`: fallback when model returns empty output.
- `emptyReplyFallbackText`: fallback message.

## D. Concurrency & Interrupt

- `queueDebounceMs`: debounce window for same-session bursts (default `0`, disabled).
- `interruptOnNewMessage`: interrupt old reply when new input arrives (default disabled).

## E. Context Enrichment

- `historyLimit`: injected group history count (recommended default `0`).
- `enrichReplyForwardContext`: recursive reply/forward context parsing.
- `maxReplyLayers` / `maxForwardLayers`: recursion depth.
- `maxTotalContextChars`: total context char budget.

## F. Output & Risk Control

- `maxMessageLength`: max chars per single message.
- `rateLimitMs`: delay between split sends.
- `formatMarkdown`: convert markdown to plain text.
- `antiRiskMode`: anti-risk output mode.
- `showReplySessionSource`: prepend a session-source hint to replies (useful for `/tmp` flows).
- `forwardLongReplyThreshold`: switch long replies to merged-forward mode.

## G. Media & Guild

- `enableTTS`: TTS reply.
- `enableGuilds`: QQ Guild support.
- `sharedMediaHostDir` / `sharedMediaContainerDir`: shared media mount paths.

## Recommended Minimal Production Config

```json
{
  "channels": {
    "qq": {
      "wsUrl": "ws://127.0.0.1:3001",
      "accessToken": "your_token",
      "requireMention": true,
      "admins": "10000001",
      "adminOnlyChat": true,
      "allowedGroups": "20000001",
      "rateLimitMs": 1000,
      "maxRetries": 0,
      "retryDelayMs": 3000,
      "fastFailErrors": [],
      "queueDebounceMs": 0,
      "injectGatewayMeta": false,
      "interruptOnNewMessage": false
    }
  }
}
```

## Read More

- Full parameter table: see root `archive/README.en.legacy.md`.
- Deployment details: [NapCat deployment guide](../deploy/napcat/archive/README.en.legacy.md).
