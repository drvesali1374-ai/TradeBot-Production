import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, AutomationState, AutomationLogs } from '@/lib/tradebot/database'
import { runCycle, checkClosedPositionsHistory, type CycleResult } from '@/lib/tradebot/cycle-engine'

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
    const results: CycleResult[] = []
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

    // ✓ Fix (مشکل ۲): Check closed positions history ONLY after the LAST cycle
    console.log('[/api/run-cycle] Checking closed positions history (post-cycle)...')
    const historyResult = await checkClosedPositionsHistory(baseUrl)
    console.log('[/api/run-cycle] History check result:', JSON.stringify(historyResult))

    // ✓ Transaction Buffer (پیشنهاد ۱+۶): Persist symbols to KV ONCE
    //   During the cycle, symbols were only updated in-memory.
    //   Now we do a single KV write for the final symbols state.
    const lastResultWithSymbols = [...results].reverse().find(r => r.symbols)
    if (lastResultWithSymbols && lastResultWithSymbols.symbols) {
      try {
        await AutomationState.set('automation_symbols', lastResultWithSymbols.symbols)
        console.log('[/api/run-cycle] Persisted symbols to KV (single write)')
      } catch (e) {
        console.warn('[/api/run-cycle] Failed to persist symbols:', e)
      }
    }

    // ✓ Write Debounce (پیشنهاد ۳): Write lastCycleLogs only if enough time has passed
    //   If tradeWaitTime is 30 minutes and cron runs every 5 minutes,
    //   we only write logs every 30 minutes (6x reduction in writes)
    let logsWritten = false
    try {
      const dbSettings = await AutomationState.get('automation_settings')
      const settings = typeof dbSettings === 'string' ? JSON.parse(dbSettings) : dbSettings || {}
      const tradeWaitTime = settings.tradeWaitTime || 30
      const debounceMs = tradeWaitTime * 60 * 1000

      const lastWriteRaw = await AutomationState.get('lastCycleLogsWriteTime')
      const lastWriteTime = lastWriteRaw ? parseInt(String(lastWriteRaw)) : 0
      const now = Date.now()

      if (now - lastWriteTime >= debounceMs) {
        const lastCycleResult = results[results.length - 1]
        if (lastCycleResult && lastCycleResult.logs && lastCycleResult.logs.length > 0) {
          const cycleLogEntry = {
            timestamp: new Date().toISOString(),
            source: isCron ? 'cron' : 'manual',
            logCount: lastCycleResult.logs.length,
            logs: lastCycleResult.logs.map((l, i) => ({
              id: i + 1,
              symbol: l.symbol || '',
              action: 'automation_cycle',
              status: l.type === 'error' ? 'ERROR' : l.type === 'warning' ? 'WARNING' : 'SUCCESS',
              message: l.message,
              error_code: l.type === 'error' ? 'SIGNAL_ERROR' : null,
              details: JSON.stringify({ timestamp: l.timestamp, type: l.type, source: isCron ? 'cron' : 'manual' }),
              created_at: l.timestamp
            }))
          }
          try {
            const { getRequestContext } = await import('@cloudflare/next-on-pages')
            const ctx = getRequestContext()
            if (ctx.env && ctx.env.TRADING_DATA) {
              await ctx.env.TRADING_DATA.put('lastCycleLogs', JSON.stringify(cycleLogEntry))
              await AutomationState.set('lastCycleLogsWriteTime', now)
              logsWritten = true
              console.log(`[/api/run-cycle] Wrote lastCycleLogs (debounced: ${Math.round((now - lastWriteTime) / 60000)}min since last)`)
            }
          } catch { /* Not on Cloudflare */ }
        }
      } else {
        console.log(`[/api/run-cycle] Skipping lastCycleLogs (debounced: ${Math.round((now - lastWriteTime) / 60000)}min < ${tradeWaitTime}min)`)
      }
    } catch (e) {
      console.warn('[/api/run-cycle] lastCycleLogs write error:', e)
    }

    // ✓ Batch-write ALL cycle logs to shared `logs` array (only if lastCycleLogs was written)
    if (logsWritten) {
      try {
        const triggerSource = isCron ? 'cron' : 'manual'
        const allNewLogs = []
        for (const result of results) {
          if (!result.logs || result.logs.length === 0) continue
          for (const lg of result.logs) {
            allNewLogs.push({
              symbol: lg.symbol || '',
              action: 'automation_cycle',
              status: lg.type === 'error' ? 'ERROR' : lg.type === 'warning' ? 'WARNING' : 'SUCCESS',
              message: lg.message,
              error_code: lg.type === 'error' ? 'SIGNAL_ERROR' : null,
              details: JSON.stringify({ timestamp: lg.timestamp, type: lg.type, source: triggerSource }),
              created_at: lg.timestamp
            })
          }
        }
        if (allNewLogs.length > 0) {
          console.log(`[/api/run-cycle] Batch-writing ${allNewLogs.length} logs (single KV write)`)
          await AutomationLogs.appendBatch(allNewLogs)
        }
      } catch (e) {
        console.warn('[/api/run-cycle] Failed to batch-write logs:', e)
      }
    }

    return NextResponse.json({
      success: anySuccess,
      results,
      cyclesRun: results.length,
      historyCheck: historyResult,
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
