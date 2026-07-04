import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, Analytics } from '@/lib/tradebot/database'

// Ensure database is initialized
initializeDatabase()

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ symbol: string }> }
) {
  try {
    const { symbol } = await params
    const stats = Analytics.getSymbolStats(symbol)
    return NextResponse.json({ success: true, data: stats })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
