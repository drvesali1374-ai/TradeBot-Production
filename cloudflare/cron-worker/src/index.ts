/**
 * TradeBot Cron Worker
 * =====================
 *
 * A Cloudflare Worker that triggers the TradeBot automation cycle every 5
 * minutes via a Cron Trigger.
 *
 * Why a separate Worker?
 *   Cloudflare Pages does NOT support Cron Triggers. Only Cloudflare Workers
 *   do. So we deploy this small Worker alongside the Pages app. Every 5
 *   minutes the cron fires the `scheduled` handler, which makes a single
 *   HTTP request to the /api/run-cycle endpoint on the Pages app.
 *
 * Flow:
 *   Cron (every 5 min) → scheduled() → fetch(APP_URL/api/run-cycle?source=cron)
 *     → Pages app runs full automation cycle (14 steps) → returns result
 *
 * Security:
 *   The request includes an X-Run-Cycle-Secret header that must match the
 *   RUN_CYCLE_SECRET environment variable set on the Pages app. This prevents
 *   unauthorized users from triggering cycles by hitting the endpoint directly.
 *
 * Configuration:
 *   - APP_URL: set in wrangler.toml [vars] or as a secret (npx wrangler secret put APP_URL)
 *   - RUN_CYCLE_SECRET: set as a secret (npx wrangler secret put RUN_CYCLE_SECRET)
 *
 * Local testing:
 *   npx wrangler dev
 *   Then trigger the cron manually:
 *   curl "http://localhost:8787/__scheduled?cron=...5-minute-pattern..."
 */

export interface Env {
  APP_URL: string
  RUN_CYCLE_SECRET: string
}

export default {
  /**
   * Scheduled handler — called by Cloudflare Cron Trigger every 5 minutes.
   */
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(triggerCycle(env))
  },

  /**
   * Optional fetch handler — allows manual triggering via HTTP for testing.
   * Visit the worker URL in a browser to manually trigger a cycle.
   * Requires the RUN_CYCLE_SECRET as a query param or header.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'tradebot-cron-worker' }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Manual trigger: /?secret=xxx  or  header X-Run-Cycle-Secret: xxx
    const providedSecret = url.searchParams.get('secret') || request.headers.get('X-Run-Cycle-Secret')
    if (!env.RUN_CYCLE_SECRET || providedSecret !== env.RUN_CYCLE_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const result = await triggerCycle(env)
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * Call the /api/run-cycle endpoint on the Pages app.
 */
async function triggerCycle(env: Env): Promise<{
  ok: boolean
  triggeredAt: string
  result?: unknown
  error?: string
}> {
  const triggeredAt = new Date().toISOString()
  const appUrl = (env.APP_URL || '').replace(/\/$/, '')
  if (!appUrl) {
    console.error('[CronWorker] APP_URL is not configured')
    return { ok: false, triggeredAt, error: 'APP_URL not configured' }
  }

  const endpoint = `${appUrl}/api/run-cycle?source=cron`
  console.log(`[CronWorker] Triggering cycle at ${endpoint}`)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Run-Cycle-Secret': env.RUN_CYCLE_SECRET || ''
      },
      body: JSON.stringify({})
    })

    if (!response.ok) {
      const text = await response.text()
      console.error(`[CronWorker] Cycle failed: HTTP ${response.status} - ${text}`)
      return {
        ok: false,
        triggeredAt,
        error: `HTTP ${response.status}: ${text}`
      }
    }

    const data = await response.json()
    console.log('[CronWorker] Cycle completed:', JSON.stringify(data).slice(0, 500))
    return { ok: true, triggeredAt, result: data }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[CronWorker] Error triggering cycle:', message)
    return { ok: false, triggeredAt, error: message }
  }
}
