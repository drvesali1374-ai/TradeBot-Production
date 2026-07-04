import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, Trades } from '@/lib/tradebot/database'

export const runtime = 'edge'

// GET /api/db/trades/[param] - Get trades by symbol (param = symbol)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ param: string }> }
) {
  try {
    await initializeDatabase()
    const { param: symbol } = await params
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '100')
    const trades = await Trades.getBySymbol(symbol, limit)
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
    await initializeDatabase()
    const { param: id } = await params
    const body = await request.json()
    await Trades.update(parseInt(id), body)
    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
