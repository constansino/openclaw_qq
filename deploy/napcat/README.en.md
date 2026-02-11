# NapCat Docker for OpenClaw QQ

## Start

```bash
cd openclaw_qq/deploy/napcat
docker compose up -d
```

## First Login

1. Open `http://127.0.0.1:6099/webui`.
2. Scan QR code to log in to QQ.
3. In OneBot WebSocket settings, confirm:
   - Forward WS port: `3001`
   - Access Token: must match `NAPCAT_WS_TOKEN` in `.env`
   - `message_post_format`: `array`

## Align with OpenClaw

OpenClaw should be set to:

- `channels.qq.wsUrl = ws://127.0.0.1:3001`
- `channels.qq.accessToken = NAPCAT_WS_TOKEN`

If you change the token, remember to also update `channels.qq.accessToken` in `~/.openclaw/openclaw.json`.
