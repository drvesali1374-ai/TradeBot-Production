import { NextRequest, NextResponse } from 'next/server'
export const runtime = 'edge'


export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const symbol = searchParams.get('symbol')
  const interval = searchParams.get('interval')
  const limit = searchParams.get('limit')

  if (!symbol || !interval || !limit) {
    return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 })
  }

  try {
    const url = `https://api.toobit.com/quote/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`
    const response = await fetch(url)

    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch from Toobit API' }, { status: response.status })
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: 'Internal server error: ' + message }, { status: 500 })
  }
}
