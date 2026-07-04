import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, Positions } from '@/lib/tradebot/database'

export const runtime = 'edge'

// GET /api/db/positions/[param] - Get position by symbol (param = symbol)
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ param: string }> }
) {
  try {
    await initializeDatabase()
    const { param: symbol } = await params
    const position = await Positions.getBySymbol(symbol)
    return NextResponse.json({ success: true, data: position })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// PUT /api/db/positions/[param] - Update position by id (param = id)
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ param: string }> }
) {
  try {
    await initializeDatabase()
    const { param: id } = await params
    const body = await request.json()
    await Positions.update(parseInt(id), body)
    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
