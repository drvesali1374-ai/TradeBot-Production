import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, Trades } from '@/lib/tradebot/database'

// Ensure database is initialized
initializeDatabase()

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '100')
    const trades = Trades.getAll(limit)
    return NextResponse.json({ success: true, data: trades })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const result = Trades.add(body)
    return NextResponse.json({ success: true, id: result.lastInsertRowid })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
