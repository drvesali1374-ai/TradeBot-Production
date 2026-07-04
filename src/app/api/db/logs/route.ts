import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, AutomationLogs } from '@/lib/tradebot/database'

export const runtime = 'edge'

export async function GET(request: NextRequest) {
  try {
    await initializeDatabase()
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '200')

    // ✓ Read the shared historical logs
    const logs = await AutomationLogs.getRecent(limit)

    // ✓ Also read `lastCycleLogs` — this contains the COMPLETE logs from the most
    //   recent automation cycle (no race condition). We merge it with the shared
    //   logs so the automation page always shows the latest cycle's full activity.
    let lastCycleLogs: unknown[] = []
    try {
      const { getRequestContext } = await import('@cloudflare/next-on-pages')
      const ctx = getRequestContext()
      if (ctx.env && ctx.env.TRADING_DATA) {
        const raw = await ctx.env.TRADING_DATA.get('lastCycleLogs')
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && Array.isArray(parsed.logs)) {
            lastCycleLogs = parsed.logs
          }
        }
      }
    } catch {
      // Not on Cloudflare — skip
    }

    // Merge: deduplicate by created_at + message, then sort newest first
    const allLogs = [...logs, ...lastCycleLogs]
    const seen = new Set<string>()
    const deduped = allLogs.filter((l: Record<string, unknown>) => {
      const key = `${l.created_at}|${l.message}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    // Sort by created_at descending (newest first)
    deduped.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const ta = (a.created_at as string) || ''
      const tb = (b.created_at as string) || ''
      return tb.localeCompare(ta)
    })
    // Apply limit
    const result = deduped.slice(0, limit)

    return NextResponse.json({ success: true, data: result })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    await initializeDatabase()
    const body = await request.json()
    await AutomationLogs.add(body)
    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
