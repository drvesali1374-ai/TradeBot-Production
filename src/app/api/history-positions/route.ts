import { NextRequest, NextResponse } from 'next/server'
import { buildSortedQuery, generateSignature, getSettingsFromRequest } from '@/lib/tradebot/helpers'
export const runtime = 'edge'

/**
 * Fetch ALL closed positions history from Toobit (no symbol filter).
 *
 * Proxies Toobit's `GET /api/v1/futures/historyPositions` endpoint.
 * Used by the cycle engine's step 0 (closed-positions history check, مورد ۸)
 * to detect newly-closed positions across ALL symbols and send a Bale
 * notification when new ones appear.
 *
 * ✓ Cloudflare-ready: uses the shared generateSignature helper which
 *   automatically uses Web Crypto API in Edge/Worker runtimes and
 *   Node.js crypto in local dev.
 *
 * Settings source: request headers (X-API-Key, X-Secret-Key, X-Base-Url).
 *   The cycle engine reads the API keys from KV (AutomationState) itself
 *   and forwards them as headers, so this route does not need to access
 *   KV directly (which would trigger a noisy fs-module error in local
 *   dev Edge runtime).
 */
export async function GET(request: NextRequest) {
  try {
    const { apiKey, secretKey, baseUrl } = getSettingsFromRequest(null, request.headers)

    // Validate API keys
    if (!apiKey || !secretKey) {
      return NextResponse.json(
        {
          error: 'API keys not configured',
          message: 'Please configure your API keys in settings page',
          success: false
        },
        { status: 401 }
      )
    }

    // Build signed query — NO symbol param → returns closed positions for ALL symbols
    const params: Record<string, string> = {
      timestamp: Date.now().toString(),
      recvWindow: '60000'
    }

    const queryString = buildSortedQuery(params)
    const signature = await generateSignature(queryString, secretKey)
    const url = `${baseUrl}/api/v1/futures/historyPositions?${queryString}&signature=${signature}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-BB-APIKEY': apiKey,
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      return NextResponse.json(
        { error: 'Failed to fetch closed positions history', details: errorText },
        { status: response.status }
      )
    }

    // Return the raw response from Toobit (the caller will sort/parse it)
    const data = await response.json()
    return NextResponse.json(data)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
