import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, Positions } from '@/lib/tradebot/database'

export const runtime = 'edge'

export async function GET() {
  try {
    await initializeDatabase()
    const positions = await Positions.getAll()
    return NextResponse.json({ success: true, data: positions })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    await initializeDatabase()
    const body = await request.json()
    const result = await Positions.add(body)
    return NextResponse.json({ success: true, id: result.lastInsertRowid })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
