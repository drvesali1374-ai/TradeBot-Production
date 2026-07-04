import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase } from '@/lib/tradebot/database'
import { runCycle } from '@/lib/tradebot/cycle-engine'

// Ensure database is loaded
initializeDatabase()

/**
 * Server-Side Run Cycle API
 * ==========================
 *
 * Executes one full automation cycle on the server — identical to clicking the
 * "یک چرخه" (Run Once) button in the browser, but without requiring the browser
 * tab to stay open.
 *
 * This endpoint is what the Cloudflare Cron Worker calls every 5 minutes to
 * keep automation running 24/7.
 *
 * Usage:
 *   GET  /api/run-cycle             — run one cycle (auto-selects next symbol)
 *   POST /api/run-cycle             — same, but supports { symbol } override
 *   POST /api/run-cycle?source=cron — called by the Cloudflare Cron Worker
 *
 * Security:
 *   - When called with ?source=cron, requires the RUN_CYCLE_SECRET header to
 *     match the RUN_CYCLE_SECRET env var (Cloudflare Secret). This prevents
 *     unauthorized users from triggering cycles.
 *   - When called manually (no source=cron), it runs without a secret so the
 *     browser "Run Once" button can call it directly.
 *
 * Response:
 *   { success: boolean, result: CycleResult }
 */

export async function GET(request: NextRequest) {
  return handleRunCycle(request)
}

export async function POST(request: NextRequest) {
  return handleRunCycle(request)
}

async function handleRunCycle(request: NextRequest) {
  const startTime = Date.now()
  const url = new URL(request.url)
  const source = url.searchParams.get('source')
  const isCron = source === 'cron'

  // Security check for cron-triggered requests
  if (isCron) {
    const providedSecret = request.headers.get('X-Run-Cycle-Secret')
    const expectedSecret = process.env.RUN_CYCLE_SECRET
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: invalid or missing secret' },
        { status: 401 }
      )
    }
  }

  // Determine the base URL for internal API calls.
  // In local dev: http://localhost:3000
  // In Cloudflare: the deployed Pages URL (from request)
  const protocol = url.protocol
  const host = request.headers.get('host') || 'localhost:3000'
  const baseUrl = `${protocol}//${host}`

  // Optional symbol override (from POST body)
  let symbolOverride: string | null = null
  if (request.method === 'POST') {
    try {
      const body = await request.json()
      if (body && typeof body.symbol === 'string') {
        symbolOverride = body.symbol
      }
    } catch {
      // body is optional / not JSON — ignore
    }
  }

  try {
    const result = await runCycle(baseUrl, {
      symbolOverride,
      triggerSource: isCron ? 'cron' : 'manual'
    })

    return NextResponse.json({
      success: result.success,
      result,
      duration: Date.now() - startTime
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/run-cycle] Error:', error)
    return NextResponse.json(
      {
        success: false,
        error: message,
        duration: Date.now() - startTime
      },
      { status: 500 }
    )
  }
}
