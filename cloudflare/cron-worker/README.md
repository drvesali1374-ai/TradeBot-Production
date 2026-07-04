# TradeBot Cron Worker

Cloudflare Worker that triggers the TradeBot automation cycle every 5 minutes.

## Why?

Cloudflare Pages does **not** support Cron Triggers — only Cloudflare Workers do.
So this separate Worker fires every 5 minutes and calls the `/api/run-cycle`
endpoint on your deployed Pages app.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Login to Cloudflare (one-time)
npx wrangler login

# 3. Set the app URL (your deployed Pages URL)
npx wrangler secret put APP_URL
# Enter: https://your-tradebot-app.pages.dev

# 4. Set the shared secret (must match the Pages app's RUN_CYCLE_SECRET)
npx wrangler secret put RUN_CYCLE_SECRET

# 5. Deploy
npx wrangler deploy
```

## Local Development

```bash
npx wrangler dev
```

Then test the cron handler manually:
```bash
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

Or trigger via HTTP:
```bash
curl "http://localhost:8787/?secret=YOUR_RUN_CYCLE_SECRET"
```

## How It Works

```
Every 5 minutes (cron)
    ↓
scheduled() handler fires
    ↓
fetch(APP_URL/api/run-cycle?source=cron)
    Headers: X-Run-Cycle-Secret: <shared secret>
    ↓
Pages app runs full 14-step automation cycle
    ↓
Returns result
```

## Configuration

See `wrangler.toml` for all settings. Key values:

| Variable | Type | Description |
|----------|------|-------------|
| `APP_URL` | var/secret | Base URL of your deployed Pages app |
| `RUN_CYCLE_SECRET` | secret | Shared secret for authorizing cron calls |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |
| GET/POST | `/?secret=xxx` | Manual trigger (requires secret) |
