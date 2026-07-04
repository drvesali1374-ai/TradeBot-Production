import { NextRequest, NextResponse } from 'next/server'
import { buildSortedQuery, generateSignature, getSettingsFromRequest } from '@/lib/tradebot/helpers'
export const runtime = 'edge'


export async function GET(request: NextRequest) {
  try {
    const { apiKey, secretKey, baseUrl } = getSettingsFromRequest(null, request.headers)

    // Validate API keys
    if (!apiKey || !secretKey) {
      return NextResponse.json(
        {
          error: 'API keys not configured',
          message: 'Please configure your API keys in settings page',
          positions: []
        },
        { status: 401 }
      )
    }

    const params: Record<string, string> = {
      timestamp: Date.now().toString(),
      recvWindow: '5000'
    }

    const queryString = buildSortedQuery(params)
    const signature = await generateSignature(queryString, secretKey)
    const url = `${baseUrl}/api/v1/futures/positions?${queryString}&signature=${signature}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-BB-APIKEY': apiKey,
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      return NextResponse.json({ error: 'Failed to fetch positions', details: errorText }, { status: response.status })
    }

    const data = await response.json()
    const positions = Array.isArray(data) ? data : (data.data || data.result || [])

    return NextResponse.json({ positions })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
