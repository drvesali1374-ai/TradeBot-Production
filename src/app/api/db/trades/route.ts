import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, Trades } from '@/lib/tradebot/database'

export const runtime = 'edge'

export async function GET(request: NextRequest) {
  try {
    await initializeDatabase()
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '100')
    const trades = await Trades.getAll(limit)
    return NextResponse.json({ success: true, data: trades })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    await initializeDatabase()
    const body = await request.json()
    const result = await Trades.add(body)
    return NextResponse.json({ success: true, id: result.lastInsertRowid })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
