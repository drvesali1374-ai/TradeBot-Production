import { NextResponse } from 'next/server'
import { initializeDatabase, Analytics } from '@/lib/tradebot/database'

// Ensure database is initialized
initializeDatabase()

export async function GET() {
  try {
    const tradingStats = Analytics.getTradingStats()
    const dailyStats = Analytics.getDailyStats(7)
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
