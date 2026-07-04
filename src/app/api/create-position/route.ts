import { NextRequest, NextResponse } from 'next/server'
import { buildSortedQuery, generateSignature } from '@/lib/tradebot/helpers'
export const runtime = 'edge'


export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { symbol, direction, usdtAmount, leverage, clientOrderId, tpPrice, slPrice } = body

    const settings = body.settings || {}
    const apiKey = settings.apiKey || process.env.TOOBIT_API_KEY || 'X8eeI84g9PrhgxmfCqilP9GR8gTWy9TEyfh2vG8DoTGOXwxDSwqqh2zusT69429j'
    const secretKey = settings.secretKey || process.env.TOOBIT_SECRET_KEY || 'CimriVFjSdI7POG4B4pzNRxsxZNrhltDnRwq95vshhtZFyjnW2JVrX6pcH8v9z6H'
    const baseUrl = settings.baseUrl || process.env.TOOBIT_BASE || 'https://api.toobit.com'

    if (!symbol || !direction || !usdtAmount) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 })
    }

    const fullSymbol = `${symbol}-SWAP-USDT`

    // Set leverage (with larger recvWindow)
    if (leverage && leverage > 1) {
      const levParams: Record<string, string> = {
        symbol: fullSymbol,
        leverage: leverage.toString(),
        timestamp: Date.now().toString(),
        recvWindow: '60000'
      }

      const levQs = buildSortedQuery(levParams)
      const levSig = await generateSignature(levQs, secretKey)
      const levPayload = `${levQs}&signature=${levSig}`

      await fetch(`${baseUrl}/api/v1/futures/leverage`, {
        method: 'POST',
        headers: {
          'X-BB-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: levPayload
      })

      // Short delay after setting leverage
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    // Get current price
    const priceResponse = await fetch(`${baseUrl}/quote/v1/ticker/price?symbol=${fullSymbol}`)
    const priceData = await priceResponse.json()
    const currentPrice = Array.isArray(priceData) ? parseFloat(priceData[0].p) : parseFloat(priceData.price || priceData.p)

    // Calculate quantity
    const contractSize = 0.11
    const notional = usdtAmount * (leverage || 1)
    let quantity = notional / (currentPrice * contractSize)
    quantity = Math.ceil(quantity) // Round up to integer

    // Create order (with larger recvWindow and new timestamp)
    const side = direction.toLowerCase() === 'long' ? 'BUY_OPEN' : 'SELL_OPEN'
    const orderParams: Record<string, string> = {
      symbol: fullSymbol,
      side: side,
      type: 'LIMIT',
      quantity: quantity.toString(),
      priceType: 'MARKET',
      newClientOrderId: clientOrderId || `${symbol}_${Date.now()}`,
      timestamp: Date.now().toString(),
      recvWindow: '60000'
    }

    const orderQs = buildSortedQuery(orderParams)
    const orderSig = await generateSignature(orderQs, secretKey)
    const orderPayload = `${orderQs}&signature=${orderSig}`

    const orderResponse = await fetch(`${baseUrl}/api/v1/futures/order`, {
      method: 'POST',
      headers: {
        'X-BB-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: orderPayload
    })

    if (!orderResponse.ok) {
      const errorText = await orderResponse.text()
      return NextResponse.json({ error: 'Failed to create order', details: errorText }, { status: orderResponse.status })
    }

    const orderData = await orderResponse.json()

    // Short delay after creating order
    await new Promise(resolve => setTimeout(resolve, 200))

    // Set TP/SL if provided (with larger recvWindow)
    if (tpPrice || slPrice) {
      const positionSide = direction.toLowerCase() === 'long' ? 'LONG' : 'SHORT'
      const stopParams: Record<string, string> = {
        symbol: fullSymbol,
        side: positionSide,
        timestamp: Date.now().toString(),
        recvWindow: '60000'
      }

      if (tpPrice) {
        stopParams.takeProfit = tpPrice.toString()
        stopParams.tpTriggerBy = 'CONTRACT_PRICE'
      }
      if (slPrice) {
        stopParams.stopLoss = slPrice.toString()
        stopParams.slTriggerBy = 'CONTRACT_PRICE'
      }

      const stopQs = buildSortedQuery(stopParams)
      const stopSig = await generateSignature(stopQs, secretKey)
      const stopPayload = `${stopQs}&signature=${stopSig}`

      await fetch(`${baseUrl}/api/v1/futures/position/trading-stop`, {
        method: 'POST',
        headers: {
          'X-BB-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: stopPayload
      })
    }

    return NextResponse.json({ success: true, order: orderData })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
