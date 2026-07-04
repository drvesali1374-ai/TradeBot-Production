import { NextRequest, NextResponse } from 'next/server'
import { buildSortedQuery, generateSignature } from '@/lib/tradebot/helpers'
export const runtime = 'edge'


export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { symbol, direction, clientOrderId } = body

    const settings = body.settings || {}
    const apiKey = settings.apiKey || process.env.TOOBIT_API_KEY || 'X8eeI84g9PrhgxmfCqilP9GR8gTWy9TEyfh2vG8DoTGOXwxDSwqqh2zusT69429j'
    const secretKey = settings.secretKey || process.env.TOOBIT_SECRET_KEY || 'CimriVFjSdI7POG4B4pzNRxsxZNrhltDnRwq95vshhtZFyjnW2JVrX6pcH8v9z6H'
    const baseUrl = settings.baseUrl || process.env.TOOBIT_BASE || 'https://api.toobit.com'

    if (!symbol || !direction) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 })
    }

    const fullSymbol = `${symbol}-SWAP-USDT`

    // Fetch open positions (with larger recvWindow, no symbol filter)
    const posParams: Record<string, string> = {
      timestamp: Date.now().toString(),
      recvWindow: '60000'
    }

    const posQs = buildSortedQuery(posParams)
    const posSig = await generateSignature(posQs, secretKey)
    const posUrl = `${baseUrl}/api/v1/futures/positions?${posQs}&signature=${posSig}`

    const posResponse = await fetch(posUrl, {
      method: 'GET',
      headers: {
        'X-BB-APIKEY': apiKey
      }
    })

    const posData = await posResponse.json()
    const positions = Array.isArray(posData) ? posData : (posData.data || posData.result || [])

    // Filter positions by symbol AND direction
    const targetSide = direction.toLowerCase() === 'long' ? 'LONG' : 'SHORT'
    const targetPositions = positions.filter((pos: Record<string, unknown>) => {
      const posSymbol = (pos.symbol || '').toString().toUpperCase()
      const side = (pos.side || '').toString().toUpperCase()
      const available = parseFloat(pos.available as string || pos.position as string || '0')

      return posSymbol === fullSymbol.toUpperCase() &&
             side === targetSide &&
             available > 0
    })

    if (targetPositions.length === 0) {
      return NextResponse.json({ success: false, error: 'No open positions found', closed: 0, total: 0 })
    }

    // Close each position (with larger recvWindow and delay between requests)
    let closedCount = 0
    const errors: string[] = []

    for (const pos of targetPositions) {
      const closeSide = targetSide === 'LONG' ? 'SELL_CLOSE' : 'BUY_CLOSE'
      const quantity = parseFloat(pos.available as string || pos.position as string || '0')

      if (quantity <= 0) continue

      const closeParams: Record<string, string> = {
        symbol: fullSymbol,
        side: closeSide,
        type: 'LIMIT',
        quantity: Math.ceil(quantity).toString(),
        priceType: 'MARKET',
        newClientOrderId: clientOrderId || `close_${Date.now()}_${closedCount}`,
        timestamp: Date.now().toString(),
        recvWindow: '60000'
      }

      const closeQs = buildSortedQuery(closeParams)
      const closeSig = await generateSignature(closeQs, secretKey)
      const closePayload = `${closeQs}&signature=${closeSig}`

      const closeResponse = await fetch(`${baseUrl}/api/v1/futures/order`, {
        method: 'POST',
        headers: {
          'X-BB-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: closePayload
      })

      if (closeResponse.ok) {
        closedCount++
      } else {
        const errorText = await closeResponse.text()
        errors.push(`Position ${pos.symbol}: ${errorText}`)
      }

      // Short delay between closing each position
      if (targetPositions.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }

    return NextResponse.json({
      success: closedCount > 0,
      closed: closedCount,
      total: targetPositions.length,
      errors: errors.length > 0 ? errors : undefined
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
