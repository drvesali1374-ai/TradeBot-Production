import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { cors } from 'hono/cors'
import crypto from 'crypto'
import {
  initializeDatabase,
  Settings,
  Trades,
  Positions,
  Signals,
  AutomationLogs,
  Analytics
} from './database.js'

const app = new Hono()

// Initialize database on startup
try {
  initializeDatabase()
  console.log('📊 Database ready for use')
} catch (error) {
  console.error('❌ Database initialization failed:', error)
}

// Enable CORS
app.use('/*', cors())

// Serve static files from public directory
app.use('/*', serveStatic({ root: './public' }))

// API proxy for Toobit klines
app.get('/api/toobit-proxy', async (c) => {
  const symbol = c.req.query('symbol')
  const interval = c.req.query('interval')
  const limit = c.req.query('limit')
  
  if (!symbol || !interval || !limit) {
    return c.json({ error: 'Missing required parameters' }, 400)
  }
  
  try {
    const url = `https://api.toobit.com/quote/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`
    const response = await fetch(url)
    
    if (!response.ok) {
      return c.json({ error: 'Failed to fetch from Toobit API' }, response.status)
    }
    
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ error: 'Internal server error: ' + error.message }, 500)
  }
})

// API proxy for position history with signature generation
app.post('/api/history', async (c) => {
  try {
    const body = await c.req.json()
    const { symbol, apiKey, secretKey, baseUrl, limit, recvWindow } = body
    
    if (!symbol || !apiKey || !secretKey || !baseUrl) {
      return c.json({ error: 'Missing required parameters' }, 400)
    }
    
    const timestamp = Date.now()
    const queryString = `symbol=${symbol}&limit=${limit || '100'}&recvWindow=${recvWindow || '5000'}&timestamp=${timestamp}`
    
    // Generate HMAC signature
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(queryString)
      .digest('hex')
    
    const url = `${baseUrl}/api/v1/futures/userTrades?${queryString}&signature=${signature}`
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-BB-APIKEY': apiKey
      }
    })
    
    if (!response.ok) {
      const errorText = await response.text()
      return c.json({ error: 'Failed to fetch from exchange API', details: errorText }, response.status)
    }
    
    const responseData = await response.json()
    return c.json(responseData)
  } catch (error) {
    return c.json({ error: 'Internal server error: ' + error.message }, 500)
  }
})

// Helper function for signed requests
function buildSortedQuery(params) {
  return Object.keys(params)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')
}

function generateSignature(queryString, secretKey) {
  return crypto.createHmac('sha256', secretKey).update(queryString).digest('hex')
}

// Helper function to get settings from localStorage (client-side)
function getSettingsFromRequest(c, body = null) {
  // Try to get from request body first
  const settings = body?.settings || {}
  
  // Get from localStorage (simulated via query params or headers)
  const apiKey = settings.apiKey || c.req.header('X-API-Key') || process.env.TOOBIT_API_KEY
  const secretKey = settings.secretKey || c.req.header('X-Secret-Key') || process.env.TOOBIT_SECRET_KEY
  const baseUrl = settings.baseUrl || c.req.header('X-Base-Url') || process.env.TOOBIT_BASE || 'https://api.toobit.com'
  
  return { apiKey, secretKey, baseUrl }
}

// API: Fetch open positions
app.get('/api/open-positions', async (c) => {
  try {
    const { apiKey, secretKey, baseUrl } = getSettingsFromRequest(c)
    
    // Validate API keys
    if (!apiKey || !secretKey) {
      return c.json({ 
        error: 'API keys not configured',
        message: 'Please configure your API keys in settings page',
        positions: []
      }, 401)
    }
    
    const params = {
      timestamp: Date.now().toString(),
      recvWindow: '5000'
    }
    
    const queryString = buildSortedQuery(params)
    const signature = generateSignature(queryString, secretKey)
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
      return c.json({ error: 'Failed to fetch positions', details: errorText }, response.status)
    }
    
    const data = await response.json()
    const positions = Array.isArray(data) ? data : (data.data || data.result || [])
    
    return c.json({ positions })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// API: Create position (اصلاح شده با recvWindow بزرگتر و تأخیر)
app.post('/api/create-position', async (c) => {
  try {
    const body = await c.req.json()
    const { symbol, direction, usdtAmount, leverage, clientOrderId, tpPrice, slPrice } = body
    
    const settings = body.settings || {}
    const apiKey = settings.apiKey || process.env.TOOBIT_API_KEY || 'X8eeI84g9PrhgxmfCqilP9GR8gTWy9TEyfh2vG8DoTGOXwxDSwqqh2zusT69429j'
    const secretKey = settings.secretKey || process.env.TOOBIT_SECRET_KEY || 'CimriVFjSdI7POG4B4pzNRxsxZNrhltDnRwq95vshhtZFyjnW2JVrX6pcH8v9z6H'
    const baseUrl = settings.baseUrl || process.env.TOOBIT_BASE || 'https://api.toobit.com'
    
    if (!symbol || !direction || !usdtAmount) {
      return c.json({ error: 'Missing required parameters' }, 400)
    }
    
    const fullSymbol = `${symbol}-SWAP-USDT`
    
    // Set leverage (با recvWindow بزرگتر)
    if (leverage && leverage > 1) {
      const levParams = {
        symbol: fullSymbol,
        leverage: leverage.toString(),
        timestamp: Date.now().toString(),
        recvWindow: '60000'
      }
      
      const levQs = buildSortedQuery(levParams)
      const levSig = generateSignature(levQs, secretKey)
      const levPayload = `${levQs}&signature=${levSig}`
      
      const levResp = await fetch(`${baseUrl}/api/v1/futures/leverage`, {
        method: 'POST',
        headers: {
          'X-BB-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: levPayload
      })
      
      // تأخیر کوتاه بعد از تنظیم leverage
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
    
    // Create order (با recvWindow بزرگتر و timestamp جدید)
    const side = direction.toLowerCase() === 'long' ? 'BUY_OPEN' : 'SELL_OPEN'
    const orderParams = {
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
    const orderSig = generateSignature(orderQs, secretKey)
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
      return c.json({ error: 'Failed to create order', details: errorText }, orderResponse.status)
    }
    
    const orderData = await orderResponse.json()
    
    // تأخیر کوتاه بعد از ایجاد order
    await new Promise(resolve => setTimeout(resolve, 200))
    
    // Set TP/SL if provided (با recvWindow بزرگتر)
    if (tpPrice || slPrice) {
      const positionSide = direction.toLowerCase() === 'long' ? 'LONG' : 'SHORT'
      const stopParams = {
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
      const stopSig = generateSignature(stopQs, secretKey)
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
    
    return c.json({ success: true, order: orderData })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// API: Get balance
app.get('/api/balance', async (c) => {
  try {
    const { apiKey, secretKey, baseUrl } = getSettingsFromRequest(c)
    
    // Validate API keys
    if (!apiKey || !secretKey) {
      return c.json({ 
        error: 'API keys not configured',
        message: 'Please configure your API keys in settings page',
        success: false
      }, 401)
    }
    
    const params = {
      timestamp: Date.now().toString(),
      recvWindow: '60000'
    }
    
    const queryString = buildSortedQuery(params)
    const signature = generateSignature(queryString, secretKey)
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
      return c.json({ error: 'Failed to fetch balance', details: errorText }, response.status)
    }
    
    const data = await response.json()
    
    // Normalize response structure
    let balancesArray = null
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
      return c.json({ error: 'Unknown response structure', rawData: data }, 500)
    }
    
    // Find USDT item
    const usdtItem = balancesArray.find(item => {
      const asset = (item.asset || item.coin || item.currency || item.symbol || '').toString().toUpperCase()
      return asset === 'USDT'
    })
    
    if (!usdtItem) {
      return c.json({ error: 'No USDT balance found', rawData: balancesArray }, 404)
    }
    
    // Extract fields with fallback names
    const getValue = (key, alt) => {
      if (usdtItem[key] !== undefined && usdtItem[key] !== null) return usdtItem[key]
      if (alt && usdtItem[alt] !== undefined && usdtItem[alt] !== null) return usdtItem[alt]
      return 0
    }
    
    const totalBalance = parseFloat(getValue('balance', 'total') || 0)
    const availableBalance = parseFloat(getValue('availableBalance', 'available') || getValue('free', 'availableBalance') || 0)
    const positionMargin = parseFloat(getValue('positionMargin', 'position_margin') || 0)
    const orderMargin = parseFloat(getValue('orderMargin', 'order_margin') || getValue('frozen', 'orderMargin') || 0)
    const unrealizedPnL = parseFloat(getValue('crossUnRealizedPnl', 'unrealizedPnl') || getValue('unrealized', null) || 0)
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
    
    return c.json({ success: true, balance })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// API: Close position
app.post('/api/close-position', async (c) => {
  try {
    const body = await c.req.json()
    const { symbol, direction, clientOrderId } = body
    
    const settings = body.settings || {}
    const apiKey = settings.apiKey || process.env.TOOBIT_API_KEY || 'X8eeI84g9PrhgxmfCqilP9GR8gTWy9TEyfh2vG8DoTGOXwxDSwqqh2zusT69429j'
    const secretKey = settings.secretKey || process.env.TOOBIT_SECRET_KEY || 'CimriVFjSdI7POG4B4pzNRxsxZNrhltDnRwq95vshhtZFyjnW2JVrX6pcH8v9z6H'
    const baseUrl = settings.baseUrl || process.env.TOOBIT_BASE || 'https://api.toobit.com'
    
    if (!symbol || !direction) {
      return c.json({ error: 'Missing required parameters' }, 400)
    }
    
    const fullSymbol = `${symbol}-SWAP-USDT`
    
    // Fetch open positions (با recvWindow بزرگتر و بدون symbol filter)
    const posParams = {
      timestamp: Date.now().toString(),
      recvWindow: '60000'
    }
    
    const posQs = buildSortedQuery(posParams)
    const posSig = generateSignature(posQs, secretKey)
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
    const targetPositions = positions.filter(pos => {
      const posSymbol = (pos.symbol || '').toUpperCase()
      const side = (pos.side || '').toUpperCase()
      const available = parseFloat(pos.available || pos.position || 0)
      
      return posSymbol === fullSymbol.toUpperCase() && 
             side === targetSide && 
             available > 0
    })
    
    if (targetPositions.length === 0) {
      return c.json({ success: false, error: 'No open positions found', closed: 0, total: 0 })
    }
    
    // Close each position (با recvWindow بزرگتر و تأخیر بین درخواست‌ها)
    let closedCount = 0
    let errors = []
    
    for (const pos of targetPositions) {
      const closeSide = targetSide === 'LONG' ? 'SELL_CLOSE' : 'BUY_CLOSE'
      const quantity = parseFloat(pos.available || pos.position || 0)
      
      if (quantity <= 0) continue
      
      const closeParams = {
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
      const closeSig = generateSignature(closeQs, secretKey)
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
      
      // تأخیر کوتاه بین بستن هر پوزیشن
      if (targetPositions.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }
    
    return c.json({ 
      success: closedCount > 0, 
      closed: closedCount, 
      total: targetPositions.length,
      errors: errors.length > 0 ? errors : undefined
    })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// ============================================
// DATABASE API ENDPOINTS
// ============================================

// Get all trades
app.get('/api/db/trades', async (c) => {
  try {
    const limit = c.req.query('limit') || 100
    const trades = Trades.getAll(parseInt(limit))
    return c.json({ success: true, data: trades })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Get trades by symbol
app.get('/api/db/trades/:symbol', async (c) => {
  try {
    const symbol = c.req.param('symbol')
    const limit = c.req.query('limit') || 100
    const trades = Trades.getBySymbol(symbol, parseInt(limit))
    return c.json({ success: true, data: trades })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Add new trade
app.post('/api/db/trades', async (c) => {
  try {
    const body = await c.req.json()
    const result = Trades.add(body)
    return c.json({ success: true, id: result.lastInsertRowid })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Update trade
app.put('/api/db/trades/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    Trades.update(parseInt(id), body)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Get all open positions
app.get('/api/db/positions', async (c) => {
  try {
    const positions = Positions.getAll()
    return c.json({ success: true, data: positions })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Get position by symbol
app.get('/api/db/positions/:symbol', async (c) => {
  try {
    const symbol = c.req.param('symbol')
    const position = Positions.getBySymbol(symbol)
    return c.json({ success: true, data: position })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Add position
app.post('/api/db/positions', async (c) => {
  try {
    const body = await c.req.json()
    const result = Positions.add(body)
    return c.json({ success: true, id: result.lastInsertRowid })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Update position
app.put('/api/db/positions/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    Positions.update(parseInt(id), body)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Get signals
app.get('/api/db/signals', async (c) => {
  try {
    const pending = Signals.getPending(100)
    return c.json({ success: true, data: pending })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Add signal
app.post('/api/db/signals', async (c) => {
  try {
    const body = await c.req.json()
    const result = Signals.add(body)
    return c.json({ success: true, id: result.lastInsertRowid })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Get automation logs
app.get('/api/db/logs', async (c) => {
  try {
    const limit = c.req.query('limit') || 200
    const logs = AutomationLogs.getRecent(parseInt(limit))
    return c.json({ success: true, data: logs })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Add automation log
app.post('/api/db/logs', async (c) => {
  try {
    const body = await c.req.json()
    AutomationLogs.add(body)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Get trading statistics
app.get('/api/db/stats', async (c) => {
  try {
    const tradingStats = Analytics.getTradingStats()
    const dailyStats = Analytics.getDailyStats(7)
    return c.json({ 
      success: true, 
      trading: tradingStats,
      daily: dailyStats
    })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Get symbol statistics
app.get('/api/db/stats/:symbol', async (c) => {
  try {
    const symbol = c.req.param('symbol')
    const stats = Analytics.getSymbolStats(symbol)
    return c.json({ success: true, data: stats })
  } catch (error) {
    return c.json({ error: error.message }, 500)
  }
})

// Start server
const port = 3003
console.log(`Server is running on http://0.0.0.0:${port}`)

serve({
  fetch: app.fetch,
  port
})
