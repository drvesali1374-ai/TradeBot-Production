import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, Trades } from '@/lib/tradebot/database'

// Ensure database is initialized
initializeDatabase()

// GET /api/db/trades/[param] - Get trades by symbol (param = symbol)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ param: string }> }
) {
  try {
    const { param: symbol } = await params
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '100')
    const trades = Trades.getBySymbol(symbol, limit)
    return NextResponse.json({ success: true, data: trades })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// PUT /api/db/trades/[param] - Update trade by id (param = id)
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ param: string }> }
) {
  try {
    const { param: id } = await params
    const body = await request.json()
    Trades.update(parseInt(id), body)
    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
