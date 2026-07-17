import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, AutomationState } from '@/lib/tradebot/database'
import { runCycle } from '@/lib/tradebot/cycle-engine'

export const runtime = 'edge'

/**
 * Server-Side Run Cycle API
 * ==========================
 *
 * Executes automation cycle(s) on the server.
 *
 * ✓ مورد ۷: تعداد چرخه قابل تنظیم است (cyclesPerRun از دیتابیس خوانده می‌شود)
 *   - هم دکمه دستی «یک چرخه» و هم Cron Trigger به تعداد cyclesPerRun چرخه اجرا می‌کنند
 *   - بین هر چرخه ۱ ثانیه تاخیر برای جلوگیری از rate-limit صرافی
 *
 * Usage:
 *   GET  /api/run-cycle             — run cycle(s) (auto-selects next symbol)
 *   POST /api/run-cycle             — same, but supports { symbol } override
 *   POST /api/run-cycle?source=cron — called by the Cloudflare Cron Worker
 *
 * Security:
 *   - When called with ?source=cron, requires the RUN_CYCLE_SECRET header
 *
 * Response:
 *   { success: boolean, results: CycleResult[], duration: number }
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

  // ✓ Initialize database (async — KV or JSON file)
  await initializeDatabase()

  // Determine the base URL for internal API calls
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

  // ✓ مورد ۷: Read cyclesPerRun from database (default: 1)
  let cyclesPerRun = 1
  try {
    const dbSettings = await AutomationState.get('automation_settings')
    if (dbSettings) {
      const parsed = typeof dbSettings === 'string' ? JSON.parse(dbSettings) : dbSettings
      if (parsed && typeof parsed.cyclesPerRun === 'number' && parsed.cyclesPerRun >= 1) {
        cyclesPerRun = Math.min(parsed.cyclesPerRun, 10) // cap at 10
      }
    }
  } catch {
    // use default 1
  }

  try {
    const results = []
    let anySuccess = false

    // ✓ Run cyclesPerRun cycles sequentially
    for (let i = 0; i < cyclesPerRun; i++) {
      console.log(`[/api/run-cycle] Running cycle ${i + 1} of ${cyclesPerRun}`)

      const result = await runCycle(baseUrl, {
        symbolOverride,
        triggerSource: isCron ? 'cron' : 'manual'
      })
      results.push(result)

      if (result.success) {
        anySuccess = true
      }

      // ✓ Delay between cycles (1 second) to avoid exchange rate-limits
      // (skip delay after the last cycle)
      if (i < cyclesPerRun - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    return NextResponse.json({
      success: anySuccess,
      results,
      cyclesRun: results.length,
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
