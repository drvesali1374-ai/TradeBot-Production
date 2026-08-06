/**
 * TradeBot Cron Worker — with comprehensive error logging
 */

export interface Env {
  APP_URL: string
  RUN_CYCLE_SECRET: string
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    console.log('[CRON] scheduled handler fired at', new Date().toISOString())
    ctx.waitUntil(triggerCycle(env))
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'tradebot-cron-worker', time: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const providedSecret = url.searchParams.get('secret') || request.headers.get('X-Run-Cycle-Secret')
    if (!env.RUN_CYCLE_SECRET || providedSecret !== env.RUN_CYCLE_SECRET) {
      return new Response(JSON.stringify({ error: 'Unauthorized', hasSecret: !!env.RUN_CYCLE_SECRET }), {
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

async function triggerCycle(env: Env): Promise<{
  ok: boolean
  triggeredAt: string
  result?: unknown
  error?: string
  appUrl?: string
  hasSecret?: boolean
}> {
  const triggeredAt = new Date().toISOString()
  const appUrl = (env.APP_URL || '').replace(/\/$/, '')
  
  console.log('[CRON] triggerCycle started:', { appUrl, hasSecret: !!env.RUN_CYCLE_SECRET, triggeredAt })
  
  if (!appUrl) {
    console.error('[CRON] APP_URL is not configured!')
    return { ok: false, triggeredAt, error: 'APP_URL not configured', appUrl: '', hasSecret: !!env.RUN_CYCLE_SECRET }
  }

  const endpoint = `${appUrl}/api/run-cycle?source=cron`
  console.log('[CRON] Fetching:', endpoint)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Run-Cycle-Secret': env.RUN_CYCLE_SECRET || ''
      },
      body: JSON.stringify({})
    })

    console.log('[CRON] Response status:', response.status)

    if (!response.ok) {
      const text = await response.text()
      console.error('[CRON] Failed:', response.status, text.substring(0, 200))
      return {
        ok: false,
        triggeredAt,
        error: `HTTP ${response.status}: ${text.substring(0, 200)}`,
        appUrl,
        hasSecret: !!env.RUN_CYCLE_SECRET
      }
    }

    const data = await response.json()
    console.log('[CRON] Success:', JSON.stringify(data).substring(0, 300))
    return { ok: true, triggeredAt, result: data, appUrl, hasSecret: !!env.RUN_CYCLE_SECRET }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[CRON] Error:', message)
    return { ok: false, triggeredAt, error: message, appUrl, hasSecret: !!env.RUN_CYCLE_SECRET }
  }
}
