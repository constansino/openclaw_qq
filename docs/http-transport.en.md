# OneBot HTTP Transport Guide

> Use this mode when you prefer OneBot HTTP API + webhook instead of reverse WebSocket.

## When to use it

- Your OneBot / NapCat deployment already exposes an HTTP API.
- You want inbound events to flow into an OpenClaw-owned webhook route.
- You want HTTP transport without duplicating the existing QQ message handling pipeline.

## Config fields

Under `channels.qq`, configure these fields:

- `transport`: set to `http` to enable HTTP mode. The default remains `ws`.
- `httpUrl`: OneBot HTTP API endpoint, for example `http://127.0.0.1:3000`.
- `httpWebhookPath`: webhook path used by the plugin to receive OneBot events. Defaults to `/plugins/qq/<accountId>/onebot` when empty.
- `httpWebhookToken`: webhook auth token for HTTP mode. Falls back to `accessToken` when omitted.
- `accessToken`: token used for outbound API calls, and also for webhook validation when `httpWebhookToken` is empty.

## Minimal example

```json
{
  "channels": {
    "qq": {
      "transport": "http",
      "httpUrl": "http://127.0.0.1:3000",
      "httpWebhookPath": "/plugins/qq/default/onebot",
      "httpWebhookToken": "your_webhook_token",
      "accessToken": "your_token",
      "requireMention": true
    }
  },
  "plugins": {
    "entries": {
      "qq": { "enabled": true }
    }
  }
}
```

## What your OneBot side must provide

HTTP mode needs two paths to work together:

1. **Outbound API**
   - OpenClaw QQ sends `POST <httpUrl>/<action>` requests.
   - Your OneBot server must expose standard HTTP actions and accept `Authorization: Bearer <token>`.

2. **Inbound event webhook**
   - Your OneBot server must push message / notice / request events to the configured `httpWebhookPath`.
   - The plugin accepts these auth headers:
     - `Authorization`
     - `x-onebot-token`
     - `x-access-token`

## Default behavior

- If `transport` is not set, the plugin still uses WebSocket mode.
- HTTP mode only changes the transport layer. Existing QQ parsing, media handling, session behavior, and reply flow stay the same.
- When an account stops, the plugin unregisters the runtime webhook route to avoid stale handlers after restart.

## Troubleshooting

### Can send, but cannot receive

Check:

- whether OneBot is actually calling the configured `httpWebhookPath`
- whether the webhook token matches `httpWebhookToken` / `accessToken`
- whether the callback uses `POST`

### Can receive, but cannot send

Check:

- whether `httpUrl` is reachable from the OpenClaw host
- whether your OneBot server supports standard actions such as `send_private_msg` and `send_group_msg`
- whether `accessToken` matches the OneBot server config

### Migrating from WebSocket mode

Recommended order:

1. Keep the existing `accessToken`
2. Change `transport` to `http`
3. Set `httpUrl`
4. Point OneBot event callback to `httpWebhookPath`
5. Run `openclaw gateway restart`

## Related links

- `docs/config-reference.en.md`
- `deploy/napcat/README.md`
- PR `#36`
