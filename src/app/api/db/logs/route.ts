import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, AutomationLogs } from '@/lib/tradebot/database'

// Ensure database is initialized
initializeDatabase()

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '200')
    const logs = AutomationLogs.getRecent(limit)
    return NextResponse.json({ success: true, data: logs })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    AutomationLogs.add(body)
    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
