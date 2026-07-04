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
          success: false
        },
        { status: 401 }
      )
    }

    const params: Record<string, string> = {
      timestamp: Date.now().toString(),
      recvWindow: '60000'
    }

    const queryString = buildSortedQuery(params)
    const signature = await generateSignature(queryString, secretKey)
    const url = `${baseUrl}/api/v1/futures/balance?${queryString}&signature=${signature}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-BB-APIKEY': apiKey,
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      return NextResponse.json({ error: 'Failed to fetch balance', details: errorText }, { status: response.status })
    }

    const data = await response.json()

    // Normalize response structure
    let balancesArray: unknown[] | null = null
    if (Array.isArray(data)) {
      balancesArray = data
    } else if (data.data && Array.isArray(data.data)) {
      balancesArray = data.data
    } else if (data.result && Array.isArray(data.result)) {
      balancesArray = data.result
    } else if (data.balances && Array.isArray(data.balances)) {
      balancesArray = data.balances
    } else if (data.asset || data.currency) {
      balancesArray = [data]
    } else {
      return NextResponse.json({ error: 'Unknown response structure', rawData: data }, { status: 500 })
    }

    // Find USDT item
    const usdtItem = (balancesArray as Record<string, unknown>[]).find((item) => {
      const asset = (item.asset || item.coin || item.currency || item.symbol || '').toString().toUpperCase()
      return asset === 'USDT'
    })

    if (!usdtItem) {
      return NextResponse.json({ error: 'No USDT balance found', rawData: balancesArray }, { status: 404 })
    }

    // Extract fields with fallback names
    const getValue = (key: string, alt?: string): unknown => {
      if (usdtItem[key] !== undefined && usdtItem[key] !== null) return usdtItem[key]
      if (alt && usdtItem[alt] !== undefined && usdtItem[alt] !== null) return usdtItem[alt]
      return 0
    }

    const totalBalance = parseFloat(getValue('balance', 'total') as string || '0')
    const availableBalance = parseFloat(getValue('availableBalance', 'available') as string || getValue('free', 'availableBalance') as string || '0')
    const positionMargin = parseFloat(getValue('positionMargin', 'position_margin') as string || '0')
    const orderMargin = parseFloat(getValue('orderMargin', 'order_margin') as string || getValue('frozen', 'orderMargin') as string || '0')
    const unrealizedPnL = parseFloat(getValue('crossUnRealizedPnl', 'unrealizedPnl') as string || getValue('unrealized', undefined) as string || '0')
    const freeBalance = availableBalance - orderMargin

    const balance = {
      asset: (usdtItem.asset || usdtItem.coin || usdtItem.currency || 'USDT'),
      total: Number(totalBalance).toFixed(4),
      available: Number(availableBalance).toFixed(4),
      free: Number(freeBalance).toFixed(4),
      positionMargin: Number(positionMargin).toFixed(4),
      orderMargin: Number(orderMargin).toFixed(4),
      unrealizedPnL: Number(unrealizedPnL).toFixed(4),
      fetchedAt: new Date().toISOString()
    }

    return NextResponse.json({ success: true, balance })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
