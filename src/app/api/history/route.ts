import { NextRequest, NextResponse } from 'next/server'
import { generateSignature } from '@/lib/tradebot/helpers'
export const runtime = 'edge'


/**
 * Fetch user trade history from Toobit.
 *
 * ✓ Cloudflare-ready: uses the shared generateSignature helper which
 *   automatically uses Web Crypto API in Edge/Worker runtimes and
 *   Node.js crypto in local dev.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { symbol, apiKey, secretKey, baseUrl, limit, recvWindow } = body

    if (!symbol || !apiKey || !secretKey || !baseUrl) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 })
    }

    const timestamp = Date.now()
    const queryString = `symbol=${symbol}&limit=${limit || '100'}&recvWindow=${recvWindow || '5000'}&timestamp=${timestamp}`

    // ✓ Cloudflare-ready: async signature generation (Web Crypto compatible)
    const signature = await generateSignature(queryString, secretKey)

    const url = `${baseUrl}/api/v1/futures/userTrades?${queryString}&signature=${signature}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-BB-APIKEY': apiKey
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      return NextResponse.json({ error: 'Failed to fetch from exchange API', details: errorText }, { status: response.status })
    }

    const responseData = await response.json()
    return NextResponse.json(responseData)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: 'Internal server error: ' + message }, { status: 500 })
  }
}
