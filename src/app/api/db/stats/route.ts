import { NextResponse } from 'next/server'
import { initializeDatabase, Analytics } from '@/lib/tradebot/database'

export const runtime = 'edge'

export async function GET() {
  try {
    await initializeDatabase()
    const tradingStats = await Analytics.getTradingStats()
    const dailyStats = await Analytics.getDailyStats(7)
    return NextResponse.json({
      success: true,
      trading: tradingStats,
      daily: dailyStats
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
