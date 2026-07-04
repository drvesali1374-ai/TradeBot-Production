import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, Signals } from '@/lib/tradebot/database'

// Ensure database is initialized
initializeDatabase()

export async function GET() {
  try {
    const pending = Signals.getPending(100)
    return NextResponse.json({ success: true, data: pending })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const result = Signals.add(body)
    return NextResponse.json({ success: true, id: result.lastInsertRowid })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
