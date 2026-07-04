/**
 * Server-Side Cycle Engine
 * =========================
 *
 * A faithful TypeScript port of the client-side `AutomationManager.runCycle()`
 * logic (from public/js/automation-manager.js) so that a full automation cycle
 * can run on the server — triggered either manually via /api/run-cycle or
 * automatically via the Cloudflare Cron Worker (every 5 minutes).
 *
 * CRITICAL DESIGN RULES:
 *  - The logic MUST exactly mirror the client-side runCycle() so that
 *    behaviour is identical whether triggered from the browser button
 *    or from the cron worker. Do not "improve" or refactor the logic.
 *  - All settings are read from the permanent database (AutomationState),
 *    NOT from localStorage. This is the key Cloudflare migration requirement.
 *  - Indicator math (RSI/ATR/SMA, signal generation) is copied verbatim
 *    from public/js/shared/signal-utils.js and analyzeMarketData().
 *  - Risk controls (safe asset, price distance, max margin, positive margin)
 *    use the same formulas and produce the same Bale notifications.
 *
 * Flow (mirrors runCycle() 14 steps):
 *   1. selectNextSymbol()   — pick first ready symbol (respects tradeWaitTime)
 *   2. setupForCycle()      — clear per-cycle state
 *   3. fetchMarketData()    — GET /api/toobit-proxy (klines)
 *   4. analyzeMarketData()  — generate signals (RSI/ATR/SMA/daily levels)
 *   5. fetchPositionHistory — POST /api/history (mapped to consistent shape)
 *   6. updateSelectedSignal — only latest signal with status "در انتظار"
 *   7. fetchPrice()         — current price
 *   8. closeOppositePositions
 *   9. getSymbolMargin()    — existing same-direction margin
 *  10. fetchBalance()       — total / free / positionMargin
 *  11. calculateNewMargin()
 *  12. Risk controls (safe asset, price distance, max margin, positive margin)
 *  13. openPosition()       — POST /api/create-position
 *  14. notifyOpenPosition() — POST /api/bale-send
 *
 * After success or skip, the symbol's status/lastCycleTime/errorCount are
 * persisted back to the database.
 */

import { AutomationState, AutomationLogs } from '@/lib/tradebot/database'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarketSignalSettings {
  symbolName?: string
  interval?: string
  limit?: number
  lookback?: number
  volMult?: number
  avgVolPeriod?: number
  rsiThreshold?: number
  rsiPeriod?: number
  atrPeriod?: number
  tpLongMult?: number
  slLongMult?: number
  tpShortMult?: number
  slShortMult?: number
  longFixedTp?: number | null
  longFixedSl?: number | null
  shortFixedTp?: number | null
  shortFixedSl?: number | null
  htfConfirmationSource?: string
  apiKey?: string
  secretKey?: string
  baseUrl?: string
}

export interface AutomationSettings {
  safeAssetPercent: number
  entryMarginPercent: number
  maxMarginPerSymbolPercent: number
  minPriceDistancePercent: number
  tradeWaitTime: number
  allowedErrors: number
  leverage: number
  signalExpirationHours: number
  baleToken: string
  baleChatId: string
}

export interface SymbolEntry {
  id: number
  name: string
  status: 'waiting' | 'running' | 'error'
  errorCount: number
  lastCycleTime: number | null
}

export interface Candle {
  timestamp: Date
  open: number
  high: number
  low: number
  close: number
  amount: number
  rsi?: number | null
  atr?: number | null
  signal?: 'Long' | 'Short' | null
  tp?: number | null
  sl?: number | null
  clientOrderId?: string | null
}

export interface Signal {
  type: 'Long' | 'Short'
  timestamp: Date
  price: number
  tp: number
  sl: number
  orderId: string
  symbol: string
}

export interface HistoryEntry {
  time: Date
  symbol: string
  price: number
  qty: number
  commission: number
  side: string
  realizedPnl: number
}

export interface BalanceInfo {
  asset: string
  total: string
  available: string
  free: string
  positionMargin: string
  orderMargin: string
  unrealizedPnL: string
  fetchedAt: string
}

export interface CycleLogEntry {
  message: string
  type: 'info' | 'success' | 'warning' | 'error'
  symbol?: string
  timestamp: string
}

export interface CycleResult {
  success: boolean
  symbol: string | null
  action: 'position_opened' | 'no_signal' | 'no_ready_symbol' | 'risk_blocked' | 'error' | 'skipped'
  logs: CycleLogEntry[]
  errorCount: number
  duration: number
}

// ---------------------------------------------------------------------------
// Default settings (mirror getDefaultSettings() in automation-manager.js)
// ---------------------------------------------------------------------------

function getDefaultAutomationSettings(): AutomationSettings {
  return {
    safeAssetPercent: 50,
    entryMarginPercent: 5,
    maxMarginPerSymbolPercent: 10,
    minPriceDistancePercent: 0.5,
    tradeWaitTime: 60,
    allowedErrors: 3,
    leverage: 4,
    signalExpirationHours: 6,
    baleToken: '',
    baleChatId: ''
  }
}

// ---------------------------------------------------------------------------
// Indicator calculations — verbatim port of signal-utils.js
// ---------------------------------------------------------------------------

function calculateRSI(data: Candle[], period = 14): (number | null)[] {
  let avgGain = 0
  let avgLoss = 0
  const rsiValues: (number | null)[] = []

  if (data.length < period) {
    return new Array(data.length).fill(null)
  }

  for (let i = 1; i < data.length; i++) {
    const change = data[i].close - data[i - 1].close
    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)

    if (i <= period) {
      avgGain += gain
      avgLoss += loss
      if (i === period) {
        avgGain /= period
        avgLoss /= period
      }
      rsiValues.push(null)
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
      rsiValues.push(100 - 100 / (1 + rs))
    }
  }

  return rsiValues
}

function calculateATR(data: Candle[], period = 14): number[] {
  const atrValues: number[] = []

  const trueRanges = data.map((candle, i) => {
    if (i === 0) return candle.high - candle.low
    const prevClose = data[i - 1].close
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevClose),
      Math.abs(candle.low - prevClose)
    )
  })

  atrValues[0] = trueRanges[0]
  for (let i = 1; i < data.length; i++) {
    atrValues[i] = ((period - 1) * atrValues[i - 1] + trueRanges[i]) / period
  }

  return atrValues
}

function calculateSMA(data: number[], period: number): (number | null)[] {
  const smaValues: (number | null)[] = []
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      smaValues.push(null)
    } else {
      let sum = 0
      for (let j = i - period + 1; j <= i; j++) {
        sum += data[j]
      }
      smaValues.push(sum / period)
    }
  }
  return smaValues
}

function generateOrderId(timestamp: number | Date, symbol: string): string {
  const dt = new Date(timestamp)
  const year = dt.getFullYear().toString().padStart(4, '0')
  const month = (dt.getMonth() + 1).toString().padStart(2, '0')
  const day = dt.getDate().toString().padStart(2, '0')
  const hour = dt.getHours().toString().padStart(2, '0')
  const minute = dt.getMinutes().toString().padStart(2, '0')
  const second = dt.getSeconds().toString().padStart(2, '0')
  return `${symbol}_${year}${month}${day}_${hour}${minute}${second}`
}

// ---------------------------------------------------------------------------
// Jalali date conversion — verbatim port of toJalali() in automation-manager.js
// ---------------------------------------------------------------------------

function toJalali(date?: Date | number): string {
  if (!date) date = new Date()
  if (typeof date === 'number') date = new Date(date)

  const tehranOffset = 3.5 * 60 // minutes
  const utcTime = date.getTime() + date.getTimezoneOffset() * 60000
  const tehranTime = new Date(utcTime + tehranOffset * 60000)

  const gy = tehranTime.getFullYear()
  const gm = tehranTime.getMonth() + 1
  const gd = tehranTime.getDate()

  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
  let jy: number, jm: number, jd: number, gy2: number, days: number

  gy2 = gm > 2 ? gy + 1 : gy
  days =
    355666 +
    365 * gy +
    Math.floor((gy2 + 3) / 4) -
    Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) +
    gd +
    g_d_m[gm - 1]
  jy = -1595 + 33 * Math.floor(days / 12053)
  days %= 12053
  jy += 4 * Math.floor(days / 1461)
  days %= 1461
  if (days > 365) {
    jy += Math.floor((days - 1) / 365)
    days = (days - 1) % 365
  }
  if (days < 186) {
    jm = 1 + Math.floor(days / 31)
    jd = 1 + (days % 31)
  } else {
    jm = 7 + Math.floor((days - 186) / 30)
    jd = 1 + ((days - 186) % 30)
  }

  const hours = String(tehranTime.getHours()).padStart(2, '0')
  const minutes = String(tehranTime.getMinutes()).padStart(2, '0')
  const seconds = String(tehranTime.getSeconds()).padStart(2, '0')

  return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')} - ${hours}:${minutes}:${seconds}`
}

// ---------------------------------------------------------------------------
// Core cycle engine
// ---------------------------------------------------------------------------

/**
 * Execute one full automation cycle on the server.
 *
 * @param baseUrl - the base URL of the running app (for internal API calls).
 *                  In local dev this is http://localhost:3000.
 *                  In Cloudflare this is the deployed Pages URL.
 * @param options - optional overrides (used by tests / manual triggers)
 */
export async function runCycle(
  baseUrl: string,
  options: {
    symbolOverride?: string | null
    triggerSource?: 'manual' | 'cron'
  } = {}
): Promise<CycleResult> {
  const startTime = Date.now()
  const logs: CycleLogEntry[] = []
  // ✓ Batch logging: collect all logs in memory during the cycle, then flush
  //   them to KV in a SINGLE write at the end. This avoids the race condition
  //   where concurrent cron cycles overwrite each other's logs (each log was
  //   previously doing a full read-modify-write of the entire logs array).
  const pendingDbLogs: Array<{
    message: string
    type: string
    symbol: string
    source: string
    timestamp: string
  }> = []

  const log = (message: string, type: CycleLogEntry['type'] = 'info', symbol?: string) => {
    const entry: CycleLogEntry = { message, type, symbol, timestamp: new Date().toISOString() }
    logs.push(entry)
    // Buffer for batch write — do NOT write to KV on each log call
    pendingDbLogs.push({
      message,
      type,
      symbol: symbol || '',
      source: options.triggerSource || 'server',
      timestamp: entry.timestamp
    })
    console.log(`[CycleEngine${options.triggerSource ? `:${options.triggerSource}` : ''}] ${type.toUpperCase()} ${symbol ? `[${symbol}] ` : ''}${message}`)
  }

  // ✓ Flush all buffered logs to KV in a single batch operation.
  //   Uses TWO write strategies to avoid race conditions:
  //   1. `lastCycleLogs` — stores THIS cycle's complete logs (overwrite, no race)
  //   2. `logs` — appends to the shared historical log (best-effort, may lose some entries
  //      under concurrent cron fire, but `lastCycleLogs` always has the complete picture)
  const flushLogs = async () => {
    if (pendingDbLogs.length === 0) return

    // Strategy 1: Write this cycle's complete logs to `lastCycleLogs` (no race condition)
    try {
      const cycleLogEntry = {
        timestamp: new Date().toISOString(),
        source: options.triggerSource || 'server',
        logCount: pendingDbLogs.length,
        logs: pendingDbLogs.map((l, i) => ({
          id: i + 1,
          symbol: l.symbol,
          action: 'automation_cycle',
          status: l.type === 'error' ? 'ERROR' : l.type === 'warning' ? 'WARNING' : 'SUCCESS',
          message: l.message,
          error_code: l.type === 'error' ? 'SIGNAL_ERROR' : null,
          details: JSON.stringify({ timestamp: l.timestamp, type: l.type, source: l.source }),
          created_at: l.timestamp
        }))
      }
      try {
        const { getRequestContext } = await import('@cloudflare/next-on-pages')
        const ctx = getRequestContext()
        if (ctx.env && ctx.env.TRADING_DATA) {
          await ctx.env.TRADING_DATA.put('lastCycleLogs', JSON.stringify(cycleLogEntry))
        }
      } catch {
        // Not on Cloudflare — skip (local dev doesn't need this)
      }
    } catch (e) {
      console.warn('[CycleEngine] Failed to write lastCycleLogs:', e)
    }

    // Strategy 2: Append to shared `logs` array (best-effort, may lose some under concurrency)
    try {
      const existingLogs = (await AutomationLogs.getRecent(500)) || []
      const maxId = existingLogs.length > 0
        ? Math.max(...existingLogs.map((l: { id?: number }) => l.id || 0))
        : 0
      const newLogs = pendingDbLogs.map((l, i) => ({
        id: maxId + i + 1,
        symbol: l.symbol,
        action: 'automation_cycle',
        status: l.type === 'error' ? 'ERROR' : l.type === 'warning' ? 'WARNING' : 'SUCCESS',
        message: l.message,
        error_code: l.type === 'error' ? 'SIGNAL_ERROR' : null,
        details: JSON.stringify({ timestamp: l.timestamp, type: l.type, source: l.source }),
        created_at: l.timestamp
      }))
      const allLogs = [...existingLogs, ...newLogs].slice(-500)
      try {
        const { getRequestContext } = await import('@cloudflare/next-on-pages')
        const ctx = getRequestContext()
        if (ctx.env && ctx.env.TRADING_DATA) {
          await ctx.env.TRADING_DATA.put('logs', JSON.stringify(allLogs))
        }
      } catch {
        // Not on Cloudflare — use individual adds for local dev
        for (const l of pendingDbLogs) {
          await AutomationLogs.add({
            message: l.message,
            type: l.type as 'info' | 'success' | 'warning' | 'error',
            symbol: l.symbol,
            source: l.source,
            timestamp: l.timestamp
          }).catch(() => {})
        }
      }
    } catch (e) {
      console.warn('[CycleEngine] Failed to append to shared logs:', e)
    }
  }

  try {
    // -------------------------------------------------------------------
    // Load settings + symbols from the permanent database (async — KV)
    // -------------------------------------------------------------------
    const dbAutomationSettings = await AutomationState.get('automation_settings')
    const automationSettings: AutomationSettings = {
      ...getDefaultAutomationSettings(),
      ...(typeof dbAutomationSettings === 'string'
        ? JSON.parse(dbAutomationSettings)
        : (dbAutomationSettings as Record<string, unknown>) || {})
    }

    const dbMarketSettings = await AutomationState.get('marketSignalSettings')
    const marketSettings: MarketSignalSettings =
      typeof dbMarketSettings === 'string'
        ? JSON.parse(dbMarketSettings)
        : (dbMarketSettings as MarketSignalSettings) || {}

    const dbSymbols = await AutomationState.get('automation_symbols')
    const symbols: SymbolEntry[] = (() => {
      const parsed =
        typeof dbSymbols === 'string' ? JSON.parse(dbSymbols) : (dbSymbols as SymbolEntry[]) || []
      return Array.isArray(parsed) ? parsed : []
    })()

    if (symbols.length === 0) {
      log('هیچ نمادی در لیست اتوماسیون وجود ندارد', 'warning')
      return {
        success: false,
        symbol: null,
        action: 'no_ready_symbol',
        logs,
        errorCount: 0,
        duration: Date.now() - startTime
      }
    }

    // -------------------------------------------------------------------
    // Step 1: selectNextSymbol()
    // -------------------------------------------------------------------
    const now = Date.now()
    const waitTimeMs = automationSettings.tradeWaitTime * 60 * 1000
    const readySymbols = symbols.filter((s) => {
      if (!s.lastCycleTime) return true
      return now - s.lastCycleTime >= waitTimeMs
    })

    let symbol: SymbolEntry | null = null
    if (options.symbolOverride) {
      symbol = symbols.find((s) => s.name === options.symbolOverride) || null
    } else {
      symbol = readySymbols.length > 0 ? readySymbols[0] : null
    }

    if (!symbol) {
      log('هیچ نمادی برای معامله آماده نیست', 'warning')
      return {
        success: false,
        symbol: null,
        action: 'no_ready_symbol',
        logs,
        errorCount: 0,
        duration: Date.now() - startTime
      }
    }

    log(`شروع چرخه برای نماد ${symbol.name}`, 'info', symbol.name)

    // -------------------------------------------------------------------
    // Helper to persist symbol state back to DB
    // -------------------------------------------------------------------
    const updateSymbolState = (
      updates: Partial<SymbolEntry>
    ) => {
      const idx = symbols.findIndex((s) => s.id === symbol!.id)
      if (idx >= 0) {
        symbols[idx] = { ...symbols[idx], ...updates }
        // ✓ async DB write (fire-and-forget for state updates)
        AutomationState.set('automation_symbols', symbols).catch(() => {})
      }
    }

    // -------------------------------------------------------------------
    // Step 2-3: fetchMarketData()
    // -------------------------------------------------------------------
    const interval = marketSettings.interval || '1h'
    const limit = marketSettings.limit || 1000
    const fullSymbol = `${symbol.name}-SWAP-USDT`
    const proxyUrl = `${baseUrl}/api/toobit-proxy?symbol=${encodeURIComponent(fullSymbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`

    log(`${symbol.name}: دریافت داده‌های بازار...`, 'info', symbol.name)
    const marketResponse = await fetch(proxyUrl)
    if (!marketResponse.ok) {
      throw new Error(`Failed to fetch market data: HTTP ${marketResponse.status}`)
    }
    const rawData = await marketResponse.json()
    if (!Array.isArray(rawData) || rawData.length === 0 || !Array.isArray(rawData[0])) {
      throw new Error('داده‌های بازار معتبر نیست')
    }
    log(`${symbol.name}: ${rawData.length} کندل دریافت شد`, 'success', symbol.name)

    // -------------------------------------------------------------------
    // Step 4: analyzeMarketData() — signal generation (verbatim port)
    // -------------------------------------------------------------------
    const N = rawData.length
    const data: Candle[] = rawData.map((c: unknown[]) => ({
      timestamp: new Date(c[0] as number),
      open: parseFloat(c[1] as string),
      high: parseFloat(c[2] as string),
      low: parseFloat(c[3] as string),
      close: parseFloat(c[4] as string),
      amount: parseFloat(c[5] as string)
    }))

    // Calculate daily data (Tehran offset +3:30)
    const offset = 3.5 * 3600 * 1000
    const dailyData: Record<number, { maxHigh: number; minLow: number; lastClose: number; lastTs: number }> = {}
    for (let i = 0; i < N; i++) {
      const localTs = data[i].timestamp.getTime() + offset
      const day = Math.floor(localTs / 86400000)
      if (!dailyData[day]) {
        dailyData[day] = { maxHigh: -Infinity, minLow: Infinity, lastClose: 0, lastTs: -Infinity }
      }
      dailyData[day].maxHigh = Math.max(dailyData[day].maxHigh, data[i].high)
      dailyData[day].minLow = Math.min(dailyData[day].minLow, data[i].low)
      if (localTs > dailyData[day].lastTs) {
        dailyData[day].lastTs = localTs
        dailyData[day].lastClose = data[i].close
      }
    }

    const days = Object.keys(dailyData).sort((a, b) => Number(a) - Number(b)).map(Number)

    const prevDailyHighs: (number | null)[] = []
    const prevDailyLows: (number | null)[] = []
    const prevDayCloses: (number | null)[] = []
    for (let i = 0; i < N; i++) {
      const localTs = data[i].timestamp.getTime() + offset
      const day = Math.floor(localTs / 86400000)
      const prevDayIndex = days.indexOf(day) - 1
      if (prevDayIndex >= 0) {
        const prevDay = days[prevDayIndex]
        prevDailyHighs.push(dailyData[prevDay].maxHigh)
        prevDailyLows.push(dailyData[prevDay].minLow)
        prevDayCloses.push(dailyData[prevDay].lastClose)
      } else {
        prevDailyHighs.push(null)
        prevDailyLows.push(null)
        prevDayCloses.push(null)
      }
    }

    const atr = calculateATR(data, marketSettings.atrPeriod || 14)
    const avgVols = calculateSMA(data.map((d) => d.amount), marketSettings.avgVolPeriod || 50)
    const rsi = calculateRSI(data, marketSettings.rsiPeriod || 14)

    // Track crossovers
    let lastUL: number | null = null
    let lastOH: number | null = null
    const lastCrossUnderPL = new Array(N).fill(Infinity)
    const lastCrossOverPH = new Array(N).fill(Infinity)
    for (let i = 1; i < N; i++) {
      if (data[i].close < (prevDailyLows[i] as number) && data[i - 1].close >= (prevDailyLows[i - 1] as number)) lastUL = i
      if (data[i].close > (prevDailyHighs[i] as number) && data[i - 1].close <= (prevDailyHighs[i - 1] as number)) lastOH = i
      lastCrossUnderPL[i] = lastUL === null ? Infinity : i - lastUL
      lastCrossOverPH[i] = lastOH === null ? Infinity : i - lastOH
    }

    // Generate signals
    const signals: Signal[] = []
    const htfSource = marketSettings.htfConfirmationSource || 'signalCandleClose'
    for (let i = 1; i < N - 1; i++) {
      const isCrossOverPL = data[i].close > (prevDailyLows[i] as number) && data[i - 1].close <= (prevDailyLows[i - 1] as number)
      const isCrossUnderPH = data[i].close < (prevDailyHighs[i] as number) && data[i - 1].close >= (prevDailyHighs[i - 1] as number)

      let htfConfirmLong: boolean
      let htfConfirmShort: boolean
      if (htfSource === 'previousDayClose') {
        htfConfirmLong = prevDayCloses[i] !== null && (prevDayCloses[i] as number) > (prevDailyLows[i] as number)
        htfConfirmShort = prevDayCloses[i] !== null && (prevDayCloses[i] as number) < (prevDailyHighs[i] as number)
      } else {
        htfConfirmLong = prevDailyLows[i] !== null && data[i].close > (prevDailyLows[i] as number)
        htfConfirmShort = prevDailyHighs[i] !== null && data[i].close < (prevDailyHighs[i] as number)
      }

      const condLong =
        isCrossOverPL &&
        lastCrossUnderPL[i] <= (marketSettings.lookback || 50) &&
        avgVols[i] !== null &&
        data[i].amount > (avgVols[i] as number) * (marketSettings.volMult || 0.2) &&
        rsi[i] !== null &&
        (rsi[i] as number) < (marketSettings.rsiThreshold || 50) &&
        htfConfirmLong

      const condShort =
        isCrossUnderPH &&
        lastCrossOverPH[i] <= (marketSettings.lookback || 50) &&
        avgVols[i] !== null &&
        data[i].amount > (avgVols[i] as number) * (marketSettings.volMult || 0.2) &&
        rsi[i] !== null &&
        (rsi[i] as number) > (marketSettings.rsiThreshold || 50) &&
        htfConfirmShort

      data[i].rsi = rsi[i]
      data[i].atr = atr[i]

      if (condLong) {
        data[i].signal = 'Long'
        if (marketSettings.longFixedTp !== null && !isNaN(marketSettings.longFixedTp as number)) {
          data[i].tp = data[i].close + data[i].close * (marketSettings.longFixedTp as number / 100)
        } else {
          data[i].tp = data[i].close + atr[i] * (marketSettings.tpLongMult || 20)
        }
        if (marketSettings.longFixedSl !== null && !isNaN(marketSettings.longFixedSl as number)) {
          data[i].sl = data[i].close - data[i].close * (marketSettings.longFixedSl as number / 100)
        } else {
          data[i].sl = data[i].close - atr[i] * (marketSettings.slLongMult || 6)
        }
        data[i].clientOrderId = generateOrderId(data[i].timestamp, symbol.name)
        signals.push({
          type: 'Long',
          timestamp: data[i].timestamp,
          price: data[i].close,
          tp: data[i].tp as number,
          sl: data[i].sl as number,
          orderId: data[i].clientOrderId as string,
          symbol: symbol.name
        })
      } else if (condShort) {
        data[i].signal = 'Short'
        if (marketSettings.shortFixedTp !== null && !isNaN(marketSettings.shortFixedTp as number)) {
          data[i].tp = data[i].close - data[i].close * (marketSettings.shortFixedTp as number / 100)
        } else {
          data[i].tp = data[i].close - atr[i] * (marketSettings.tpShortMult || 24)
        }
        if (marketSettings.shortFixedSl !== null && !isNaN(marketSettings.shortFixedSl as number)) {
          data[i].sl = data[i].close + data[i].close * (marketSettings.shortFixedSl as number / 100)
        } else {
          data[i].sl = data[i].close + atr[i] * (marketSettings.slShortMult || 4)
        }
        data[i].clientOrderId = generateOrderId(data[i].timestamp, symbol.name)
        signals.push({
          type: 'Short',
          timestamp: data[i].timestamp,
          price: data[i].close,
          tp: data[i].tp as number,
          sl: data[i].sl as number,
          orderId: data[i].clientOrderId as string,
          symbol: symbol.name
        })
      }
    }

    log(`${symbol.name}: ${signals.length} سیگنال تولید شد`, 'info', symbol.name)

    if (signals.length === 0) {
      log(`${symbol.name}: هیچ سیگنالی یافت نشد - شرایط بازار مناسب نیست`, 'warning', symbol.name)
      updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
      return {
        success: false,
        symbol: symbol.name,
        action: 'no_signal',
        logs,
        errorCount: 0,
        duration: Date.now() - startTime
      }
    }

    // -------------------------------------------------------------------
    // Step 5: fetchPositionHistory()
    // -------------------------------------------------------------------
    log(`${symbol.name}: دریافت تاریخچه معاملات...`, 'info', symbol.name)
    const apiKey = marketSettings.apiKey
    const secretKey = marketSettings.secretKey
    const toobitBaseUrl = marketSettings.baseUrl || 'https://api.toobit.com'

    let currentSymbolHistory: HistoryEntry[] = []
    if (apiKey && secretKey) {
      try {
        const historyResponse = await fetch(`${baseUrl}/api/history`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: fullSymbol,
            apiKey,
            secretKey,
            baseUrl: toobitBaseUrl,
            limit: 100
          })
        })
        if (historyResponse.ok) {
          const historyData = await historyResponse.json()
          let histories: unknown[] = []
          if (Array.isArray(historyData)) {
            histories = historyData
          } else if (historyData.data && Array.isArray(historyData.data)) {
            histories = historyData.data
          } else if (historyData.result && Array.isArray(historyData.result)) {
            histories = historyData.result
          } else if (typeof historyData === 'object' && historyData !== null) {
            const values = Object.values(historyData).find((v) => Array.isArray(v))
            histories = values || []
          }
          currentSymbolHistory = (histories as Record<string, unknown>[]).map((item) => ({
            time: new Date(parseInt(String(item.time || 0))),
            symbol: String(item.symbol || '-'),
            price: parseFloat(String(item.price || 0)),
            qty: parseFloat(String(item.qty || 0)),
            commission: parseFloat(String(item.commission || 0)),
            side: String(item.side || '-'),
            realizedPnl: parseFloat(String(item.realizedPnl || 0))
          }))
        }
      } catch (e) {
        log(`${symbol.name}: خطا در دریافت تاریخچه - ${e instanceof Error ? e.message : 'unknown'}`, 'warning', symbol.name)
      }
    }
    log(`${symbol.name}: ${currentSymbolHistory.length} معامله یافت شد`, 'success', symbol.name)

    // -------------------------------------------------------------------
    // Step 6: updateSelectedSignal() — only latest signal with "در انتظار" status
    // -------------------------------------------------------------------
    // calculateSignalStatus (verbatim port)
    const calculateSignalStatus = (signal: Signal): { text: string } => {
      if (!currentSymbolHistory || !Array.isArray(currentSymbolHistory)) {
        const isLatest = signals.indexOf(signal) === signals.length - 1
        return { text: isLatest ? 'در انتظار' : 'باز نشده' }
      }
      const signalDirection = signal.type === 'Long' ? 'BUY' : 'SELL'
      const openPositions = currentSymbolHistory.filter(
        (pos) => pos.side && pos.side.includes('OPEN') && pos.side.includes(signalDirection)
      )
      if (openPositions.length === 0) {
        const isLatest = signals.indexOf(signal) === signals.length - 1
        return { text: isLatest ? 'در انتظار' : 'باز نشده' }
      }
      const currentIndex = signals.indexOf(signal)
      const nextSignal = currentIndex < signals.length - 1 ? signals[currentIndex + 1] : null
      const currentTime = signal.timestamp.getTime()
      const nextTime = nextSignal ? nextSignal.timestamp.getTime() : Infinity
      const matchingPositions = openPositions.filter((pos) => {
        const posTime = pos.time.getTime()
        return posTime >= currentTime && posTime < nextTime
      })
      if (matchingPositions.length === 0) {
        const isLatest = currentIndex === signals.length - 1
        return { text: isLatest ? 'در انتظار' : 'باز نشده' }
      }
      return { text: 'باز شده' }
    }

    const latestSignal = signals[signals.length - 1]
    const status = calculateSignalStatus(latestSignal)
    const selectedSignal = status.text === 'در انتظار' ? latestSignal : null

    if (!selectedSignal) {
      log(`${symbol.name}: هیچ سیگنالی برای ورود آماده نیست - از این نماد عبو میشود`, 'warning', symbol.name)
      updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
      return {
        success: false,
        symbol: symbol.name,
        action: 'no_signal',
        logs,
        errorCount: 0,
        duration: Date.now() - startTime
      }
    }

    log(`${symbol.name}: سیگنال آماده ورود - ${selectedSignal.type}`, 'success', symbol.name)

    // -------------------------------------------------------------------
    // Step 7: fetchPrice()
    // -------------------------------------------------------------------
    log(`${symbol.name}: دریافت قیمت...`, 'info', symbol.name)
    const priceResponse = await fetch(
      `${baseUrl}/api/toobit-proxy?symbol=${encodeURIComponent(fullSymbol)}&interval=1h&limit=1`
    )
    if (!priceResponse.ok) throw new Error('Failed to fetch price')
    const priceData = await priceResponse.json()
    const klines = Array.isArray(priceData) ? priceData : priceData.data || []
    if (klines.length === 0) throw new Error('No price data received')
    const price = parseFloat(klines[0][4])
    log(`${symbol.name}: قیمت فعلی = ${price}`, 'success', symbol.name)

    // -------------------------------------------------------------------
    // Step 8: closeOppositePositions()
    // -------------------------------------------------------------------
    log(`${symbol.name}: بررسی پوزیشن‌های مخالف...`, 'info', symbol.name)
    let closedCount = 0
    let closedPositionInfo: {
      symbol: string
      side: string
      leverage: number
      margin: number
      unrealizedPnL: number
      profitRate: number
      avgPrice: number
      available: number
    } | null = null

    if (apiKey && secretKey) {
      try {
        // First fetch open positions to find the opposite one's details
        const posResponse = await fetch(`${baseUrl}/api/open-positions`, {
          headers: {
            'X-API-Key': apiKey,
            'X-Secret-Key': secretKey,
            'X-Base-Url': toobitBaseUrl
          }
        })
        if (posResponse.ok) {
          const posResult = await posResponse.json()
          const allPositions = posResult.positions || posResult.data || []
          const oppositeDirection = selectedSignal.type === 'Long' ? 'short' : 'long'
          const targetSide = oppositeDirection.toUpperCase()
          const matchingPos = (allPositions as Record<string, unknown>[]).find((pos) => {
            const posSymbol = String(pos.symbol || '').toUpperCase()
            const side = String(pos.side || '').toUpperCase()
            const available = parseFloat(String(pos.available || pos.position || 0))
            return posSymbol === fullSymbol.toUpperCase() && side === targetSide && available > 0
          })
          if (matchingPos) {
            const margin = parseFloat(String(matchingPos.margin || 0))
            const unrealizedPnL = parseFloat(String(matchingPos.unrealizedPnL || 0))
            const profitRate = parseFloat(String(matchingPos.profitRate || 0)) * 100
            closedPositionInfo = {
              symbol: String(matchingPos.symbol || ''),
              side: String(matchingPos.side || ''),
              leverage: parseInt(String(matchingPos.leverage || 1)),
              margin,
              unrealizedPnL,
              profitRate,
              avgPrice: parseFloat(String(matchingPos.avgPrice || 0)),
              available: parseFloat(String(matchingPos.available || 0))
            }
          }
        }

        // Close the opposite position
        const oppositeDir = selectedSignal.type === 'Long' ? 'short' : 'long'
        const closeResponse = await fetch(`${baseUrl}/api/close-position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: symbol.name,
            direction: oppositeDir,
            clientOrderId: `${symbol.name}_close_${Date.now()}`,
            settings: { apiKey, secretKey, baseUrl: toobitBaseUrl }
          })
        })
        if (closeResponse.ok) {
          const closeData = await closeResponse.json()
          closedCount = closeData.closed || 0
        }
      } catch (e) {
        log(`${symbol.name}: خطا در بستن پوزیشن مخالف - ${e instanceof Error ? e.message : 'unknown'}`, 'warning', symbol.name)
      }
    }
    if (closedCount > 0) {
      log(`${symbol.name}: ${closedCount} پوزیشن مخالف بسته شد`, 'success', symbol.name)
    } else {
      log(`${symbol.name}: پوزیشن مخالفی یافت نشد`, 'info', symbol.name)
    }

    // -------------------------------------------------------------------
    // Step 9: getSymbolMargin() — existing same-direction margin
    // -------------------------------------------------------------------
    let existingSymbolMargin = 0
    let hasSameDirectionPosition = false
    if (apiKey && secretKey) {
      try {
        const signalDirection = selectedSignal.type === 'Long' ? 'long' : 'short'
        const symMarginResponse = await fetch(`${baseUrl}/api/open-positions`, {
          headers: {
            'X-API-Key': apiKey,
            'X-Secret-Key': secretKey,
            'X-Base-Url': toobitBaseUrl,
            'X-Symbol': fullSymbol
          }
        })
        if (symMarginResponse.ok) {
          const symMarginData = await symMarginResponse.json()
          const positions = symMarginData.positions || symMarginData.data || []
          const targetSide = signalDirection === 'long' ? 'LONG' : 'SHORT'
          const sameDirection = (positions as Record<string, unknown>[]).filter((pos) => {
            const sideStr = String(pos.side || '').toUpperCase()
            return sideStr === targetSide || sideStr.includes(targetSide)
          })
          sameDirection.forEach((pos) => {
            const markPrice = parseFloat(String(pos.markPrice || pos.avgPrice || 0))
            const available = parseFloat(String(pos.available || 0))
            const leverage = parseInt(String(pos.leverage || 1))
            if (markPrice > 0 && leverage > 0) {
              existingSymbolMargin += (available * markPrice) / leverage
            }
          })
          existingSymbolMargin = parseFloat(existingSymbolMargin.toFixed(2))
          hasSameDirectionPosition = existingSymbolMargin > 0
        }
      } catch (e) {
        log(`${symbol.name}: خطا در دریافت پوزیشن‌های باز`, 'warning', symbol.name)
      }
    }

    // -------------------------------------------------------------------
    // Step 10: fetchBalance()
    // -------------------------------------------------------------------
    log(`${symbol.name}: دریافت موجودی حساب...`, 'info', symbol.name)
    let balance: BalanceInfo
    if (apiKey && secretKey) {
      const balanceResponse = await fetch(`${baseUrl}/api/balance`, {
        headers: {
          'X-API-Key': apiKey,
          'X-Secret-Key': secretKey,
          'X-Base-Url': toobitBaseUrl
        }
      })
      if (!balanceResponse.ok) throw new Error('Failed to fetch balance')
      const balanceData = await balanceResponse.json()
      balance = balanceData.balance || balanceData
    } else {
      throw new Error('API credentials not configured')
    }

    const totalAssets = parseFloat(balance.total)
    const freeBalance = parseFloat(balance.free)
    log(`${symbol.name}: کل دارایی = ${totalAssets} USDT, آزاد = ${freeBalance} USDT`, 'success', symbol.name)

    // Persist balance to DB (so the UI can display it) — async, fire-and-forget
    AutomationState.set('balance', balance).catch(() => {})

    // -------------------------------------------------------------------
    // Step 11: calculateNewMargin()
    // -------------------------------------------------------------------
    log(`${symbol.name}: محاسبه مارجین (${automationSettings.entryMarginPercent}% از کل دارایی)...`, 'info', symbol.name)
    const newMargin = parseFloat((totalAssets * (automationSettings.entryMarginPercent / 100)).toFixed(2))
    log(`${symbol.name}: مارجین محاسبه شده = ${newMargin} USDT`, 'success', symbol.name)

    // -------------------------------------------------------------------
    // Step 12: Risk Controls
    // -------------------------------------------------------------------
    // Helper to send Bale notification for risk-control blocks
    const sendBaleNotification = async (text: string) => {
      const token = automationSettings.baleToken
      const chatId = automationSettings.baleChatId
      if (!token || !chatId) return { ok: false, error: 'Not configured' }
      try {
        const res = await fetch(`${baseUrl}/api/bale-send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, chatId, text })
        })
        return await res.json()
      } catch {
        return { ok: false, error: 'fetch failed' }
      }
    }

    const notifyRiskControlBlocked = async (
      controlName: string,
      description: string,
      math: string,
      result: string
    ) => {
      const eventTime = toJalali(new Date())
      const directionIcon = selectedSignal.type === 'Long' ? '🔵' : '🔴'
      const directionText = selectedSignal.type === 'Long' ? 'لانگ' : 'شورت'
      const text =
        `🛑 جلوگیری از باز شدن پوزیشن\n` +
        `📌 نماد: ${symbol!.name}\n` +
        `${directionIcon} جهت سیگنال: ${directionText}\n` +
        `📝 کنترل فعال: ${controlName}\n\n` +
        `📊 جزئیات کنترل:\n${description}\n\n` +
        `📐 قیاس ریاضی:\n${math}\n\n` +
        `❌ نتیجه: ${result}\n` +
        `🕐 زمان رویداد: ${eventTime}`
      return sendBaleNotification(text)
    }

    // Control 2: Safe Asset Check
    const safeAmount = totalAssets * (automationSettings.safeAssetPercent / 100)
    const projectedFree = freeBalance - newMargin
    if (projectedFree < safeAmount) {
      log(
        `${symbol.name}: دارایی امن کافی نیست (آزاد ${freeBalance} - مارجین ${newMargin} = ${projectedFree.toFixed(2)} < دارایی امن ${safeAmount.toFixed(2)}) — رد شد`,
        'warning',
        symbol.name
      )
      await notifyRiskControlBlocked(
        'دارایی امن (Safe Asset)',
        `موجودی آزاد حساب پس از کسر مارجین ورودی باید حداقل برابر با دارایی امن باشد.\n` +
          `دارایی امن = کل دارایی × درصد دارایی امن\n` +
          `شرط عبور: موجودی آزاد پیش‌بینی‌شده ≥ دارایی امن`,
        `کل دارایی = ${totalAssets.toFixed(4)} USDT\n` +
          `موجودی آزاد = ${freeBalance.toFixed(4)} USDT\n` +
          `مارجین ورودی جدید = ${newMargin.toFixed(4)} USDT\n` +
          `درصد دارایی امن = ${automationSettings.safeAssetPercent}%\n` +
          `دارایی امن = ${totalAssets.toFixed(4)} × ${automationSettings.safeAssetPercent}% = ${safeAmount.toFixed(4)} USDT\n` +
          `موجودی آزاد پیش‌بینی‌شده = ${freeBalance.toFixed(4)} - ${newMargin.toFixed(4)} = ${projectedFree.toFixed(4)} USDT\n` +
          `${projectedFree.toFixed(4)} < ${safeAmount.toFixed(4)} ✗`,
        'موجودی آزاد پس از کسر مارجین کمتر از دارایی امن است — پوزیشن باز نشد'
      )
      updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
      return {
        success: false,
        symbol: symbol.name,
        action: 'risk_blocked',
        logs,
        errorCount: 0,
        duration: Date.now() - startTime
      }
    }

    // Controls 3-5 only if same-direction position exists
    if (hasSameDirectionPosition) {
      const signalDirection = selectedSignal.type === 'Long' ? 'long' : 'short'

      // Control 3: Price Distance Check
      const sidePrefix = signalDirection === 'long' ? 'BUY' : 'SELL'
      const sorted = [...currentSymbolHistory].sort((a, b) => a.time.getTime() - b.time.getTime())
      const openTrades = sorted.filter((t) => t.side && t.side.includes(sidePrefix) && t.side.includes('OPEN'))
      const lastEntry = openTrades.length > 0 ? openTrades[openTrades.length - 1].price : null

      if (lastEntry !== null) {
        let distancePercent: number
        if (selectedSignal.type === 'Long') {
          distancePercent = ((lastEntry - price) / lastEntry) * 100
        } else {
          distancePercent = ((price - lastEntry) / lastEntry) * 100
        }
        if (distancePercent < automationSettings.minPriceDistancePercent) {
          log(
            `${symbol.name}: فاصله قیمت کافی نیست (آخرین ورود: ${lastEntry}, فعلی: ${price}, فاصله: ${distancePercent.toFixed(2)}% < ${automationSettings.minPriceDistancePercent}%) — رد شد`,
            'warning',
            symbol.name
          )
          const distanceFormula =
            selectedSignal.type === 'Long'
              ? `فاصله = (آخرین ورود - فعلی) / آخرین ورود × 100\nفاصله = (${lastEntry} - ${price}) / ${lastEntry} × 100`
              : `فاصله = (فعلی - آخرین ورود) / آخرین ورود × 100\nفاصله = (${price} - ${lastEntry}) / ${lastEntry} × 100`
          await notifyRiskControlBlocked(
            'فاصله قیمت (Price Distance)',
            `قیمت فعلی باید فاصله کافی از آخرین نقطه ورود هم‌جهت داشته باشد.\n` +
              `برای لانگ: قیمت فعلی باید ارزان‌تر از آخرین ورود باشد\n` +
              `برای شورت: قیمت فعلی باید گران‌تر از آخرین ورود باشد\n` +
              `شرط عبور: فاصله ≥ حداقل فاصله قیمت`,
            `آخرین قیمت ورود هم‌جهت = ${lastEntry}\n` +
              `قیمت فعلی = ${price}\n` +
              `جهت سیگنال = ${selectedSignal.type === 'Long' ? 'لانگ' : 'شورت'}\n` +
              `${distanceFormula}\n` +
              `فاصله = ${distancePercent.toFixed(4)}%\n` +
              `حداقل فاصله قیمت = ${automationSettings.minPriceDistancePercent}%\n` +
              `${distancePercent.toFixed(4)}% < ${automationSettings.minPriceDistancePercent}% ✗`,
            'فاصله قیمت فعلی از آخرین ورود هم‌جهت کمتر از حد مجاز است — پوزیشن باز نشد'
          )
          updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
          return {
            success: false,
            symbol: symbol.name,
            action: 'risk_blocked',
            logs,
            errorCount: 0,
            duration: Date.now() - startTime
          }
        }
        log(`${symbol.name}: فاصله قیمت OK (${distancePercent.toFixed(2)}% ≥ ${automationSettings.minPriceDistancePercent}%)`, 'success', symbol.name)
      }

      // Control 4: Max Margin Per Symbol
      const maxMarginPerSymbol = totalAssets * (automationSettings.maxMarginPerSymbolPercent / 100)
      const totalSymbolMargin = existingSymbolMargin + newMargin
      if (totalSymbolMargin > maxMarginPerSymbol) {
        log(
          `${symbol.name}: سقف مارجین نماد (${totalSymbolMargin.toFixed(2)} > ${maxMarginPerSymbol.toFixed(2)} USDT) — رد شد`,
          'warning',
          symbol.name
        )
        await notifyRiskControlBlocked(
          'سقف مارجین نماد (Max Margin Per Symbol)',
          `مجموع مارجین پوزیشن‌های باز هم‌جهت یک نماد به علاوه مارجین ورودی جدید نباید از سقف مجاز فراتر کند.\n` +
            `سقف مارجین نماد = کل دارایی × درصد سقف مارجین نماد\n` +
            `شرط عبور: مجموع مارجین نماد ≤ سقف مارجین نماد`,
          `کل دارایی = ${totalAssets.toFixed(4)} USDT\n` +
            `درصد سقف مارجین نماد = ${automationSettings.maxMarginPerSymbolPercent}%\n` +
            `سقف مارجین نماد = ${totalAssets.toFixed(4)} × ${automationSettings.maxMarginPerSymbolPercent}% = ${maxMarginPerSymbol.toFixed(4)} USDT\n` +
            `مارجین موجود نماد = ${existingSymbolMargin.toFixed(4)} USDT\n` +
            `مارجین ورودی جدید = ${newMargin.toFixed(4)} USDT\n` +
            `مجموع مارجین نماد = ${existingSymbolMargin.toFixed(4)} + ${newMargin.toFixed(4)} = ${totalSymbolMargin.toFixed(4)} USDT\n` +
            `${totalSymbolMargin.toFixed(4)} > ${maxMarginPerSymbol.toFixed(4)} ✗`,
          'مجموع مارجین نماد از سقف مجاز فراتر رفته — پوزیشن باز نشد'
        )
        updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
        return {
          success: false,
          symbol: symbol.name,
          action: 'risk_blocked',
          logs,
          errorCount: 0,
          duration: Date.now() - startTime
        }
      }
      log(`${symbol.name}: مارجین نماد OK (${totalSymbolMargin.toFixed(2)} ≤ ${maxMarginPerSymbol.toFixed(2)} USDT)`, 'success', symbol.name)
    }

    // Control 5: Positive margin
    const finalMargin = Math.max(newMargin, 0)
    if (finalMargin <= 0) {
      log(`${symbol.name}: مارجین نهایی صفر یا منفی — رد شد`, 'warning', symbol.name)
      await notifyRiskControlBlocked(
        'مارجین مثبت (Positive Margin)',
        `مارجین ورودی محاسبه‌شده باید بزرگتر از صفر باشد.\n` +
          `مارجین = کل دارایی × درصد مارجین ورودی\n` +
          `شرط عبور: مارجین نهایی > 0`,
        `کل دارایی = ${totalAssets.toFixed(4)} USDT\n` +
          `درصد مارجین ورودی = ${automationSettings.entryMarginPercent}%\n` +
          `مارجین محاسبه‌شده = ${totalAssets.toFixed(4)} × ${automationSettings.entryMarginPercent}% = ${newMargin.toFixed(4)} USDT\n` +
          `مارجین نهایی = max(${newMargin.toFixed(4)}, 0) = ${finalMargin.toFixed(4)} USDT\n` +
          `${finalMargin.toFixed(4)} ≤ 0 ✗`,
        'مارجین نهایی صفر یا منفی است — پوزیشن باز نشد'
      )
      updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
      return {
        success: false,
        symbol: symbol.name,
        action: 'risk_blocked',
        logs,
        errorCount: 0,
        duration: Date.now() - startTime
      }
    }

    // -------------------------------------------------------------------
    // Step 13: openPosition()
    // -------------------------------------------------------------------
    log(`${symbol.name}: باز کردن پوزیشن جدید...`, 'info', symbol.name)
    const signalType = selectedSignal.type === 'Long' ? 'long' : 'short'
    const createResponse = await fetch(`${baseUrl}/api/create-position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: symbol.name,
        direction: signalType,
        usdtAmount: finalMargin,
        leverage: automationSettings.leverage,
        tpPrice: selectedSignal.tp,
        slPrice: selectedSignal.sl,
        clientOrderId: generateOrderId(Date.now(), symbol.name),
        settings: { apiKey, secretKey, baseUrl: toobitBaseUrl }
      })
    })
    if (!createResponse.ok) {
      const errBody = await createResponse.json().catch(() => ({}))
      throw new Error(errBody.error || `Failed to create position (HTTP ${createResponse.status})`)
    }
    const createData = await createResponse.json()
    const order = createData.order || createData
    log(`${symbol.name}: پوزیشن باز شد (سفارش: ${order.orderId}, مقدار: ${order.origQty})`, 'success', symbol.name)

    // -------------------------------------------------------------------
    // Fetch updated balance for notification
    // -------------------------------------------------------------------
    let updatedBalance = balance
    try {
      const updatedBalanceResponse = await fetch(`${baseUrl}/api/balance`, {
        headers: {
          'X-API-Key': apiKey,
          'X-Secret-Key': secretKey,
          'X-Base-Url': toobitBaseUrl
        }
      })
      if (updatedBalanceResponse.ok) {
        const updatedBalanceData = await updatedBalanceResponse.json()
        updatedBalance = updatedBalanceData.balance || updatedBalanceData
      }
    } catch {
      /* ignore */
    }

    // -------------------------------------------------------------------
    // Step 14: notifyOpenPosition() — Bale notification
    // -------------------------------------------------------------------
    const directionIcon = selectedSignal.type === 'Long' ? '🔵' : '🔴'
    const directionText = selectedSignal.type === 'Long' ? 'لانگ' : 'شورت'
    const eventTime = toJalali(new Date())
    const signalTime = toJalali(selectedSignal.timestamp)
    const closedDirectionText = selectedSignal.type === 'Long' ? 'شورت' : 'لانگ'
    const closedDirectionIcon = selectedSignal.type === 'Long' ? '🔴' : '🔵'

    let baleText = ''
    if (closedCount > 0 && closedPositionInfo) {
      const closedMargin = closedPositionInfo.margin ? closedPositionInfo.margin.toFixed(4) : '-'
      const closedPnL = closedPositionInfo.unrealizedPnL !== undefined ? closedPositionInfo.unrealizedPnL.toFixed(4) : '-'
      const closedPnLPercent = closedPositionInfo.profitRate !== undefined ? closedPositionInfo.profitRate.toFixed(2) : '-'
      const closedPnLColor = closedPositionInfo.unrealizedPnL >= 0 ? '📈' : '📉'
      baleText +=
        `🔒 بسته شدن پوزیشن معکوس\n` +
        `📌 نماد: ${closedPositionInfo.symbol || symbol.name}\n` +
        `${closedDirectionIcon} جهت: ${closedDirectionText}\n` +
        `🔢 اهرم: ${closedPositionInfo.leverage || automationSettings.leverage}x\n` +
        `💵 مارجین: ${closedMargin} USDT\n` +
        `${closedPnLColor} سود/زیان: ${closedPnL} USDT (${closedPnLPercent}%)\n\n`
    } else if (closedCount > 0) {
      baleText +=
        `🔒 بسته شدن پوزیشن معکوس\n` +
        `📌 نماد: ${symbol.name}\n` +
        `${closedDirectionIcon} جهت: ${closedDirectionText}\n` +
        `🔢 اهرم: ${automationSettings.leverage}x\n\n`
    } else {
      baleText += `⚠️ پوزیشن مخالف جهت بستن وجود نداشت\n\n`
    }

    baleText +=
      `🚀 ورود به پوزیشن جدید\n` +
      `📌 نماد: ${symbol.name}\n` +
      `${directionIcon} جهت: ${directionText}\n` +
      `💰 قیمت ورود: ${price}\n` +
      `🎯 حد سود: ${selectedSignal.tp.toFixed(4)}\n` +
      `🛑 حد ضرر: ${selectedSignal.sl.toFixed(4)}\n` +
      `💵 مارجین: ${finalMargin} USDT\n` +
      `🔢 اهرم: ${automationSettings.leverage}x\n` +
      `🏦 موجودی کل: ${updatedBalance.total || '-'} USDT\n` +
      `🏦 موجودی آزاد: ${updatedBalance.free || '-'} USDT\n` +
      `🕐 زمان صدور سیگنال: ${signalTime}\n` +
      `🕐 زمان رویداد: ${eventTime}`

    await sendBaleNotification(baleText)

    // -------------------------------------------------------------------
    // Update symbol status
    // -------------------------------------------------------------------
    updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
    log(`چرخه ${symbol.name} با موفقیت انجام شد`, 'success', symbol.name)

    return {
      success: true,
      symbol: symbol.name,
      action: 'position_opened',
      logs,
      errorCount: 0,
      duration: Date.now() - startTime
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'

    // Handle the NO_SIGNAL_GENERATED case
    if (message === 'NO_SIGNAL_GENERATED') {
      return {
        success: false,
        symbol: null,
        action: 'no_signal',
        logs,
        errorCount: 0,
        duration: Date.now() - startTime
      }
    }

    log(`خطای چرخه: ${message}`, 'error')
    console.error('[CycleEngine] Error:', error)

    // Try to update the symbol's error count if we have a symbol
    try {
      const dbSymbols = await AutomationState.get('automation_symbols')
      const symbols: SymbolEntry[] =
        typeof dbSymbols === 'string' ? JSON.parse(dbSymbols) : (dbSymbols as SymbolEntry[]) || []
      // Find the symbol that was running (status === 'running')
      const idx = symbols.findIndex((s) => s.status === 'running')
      if (idx >= 0) {
        symbols[idx].errorCount = (symbols[idx].errorCount || 0) + 1
        const automationSettings = getDefaultAutomationSettings()
        const dbAuto = await AutomationState.get('automation_settings')
        const autoSettings = {
          ...automationSettings,
          ...(typeof dbAuto === 'string' ? JSON.parse(dbAuto) : (dbAuto as Record<string, unknown>) || {})
        }
        if (symbols[idx].errorCount >= autoSettings.allowedErrors) {
          symbols[idx].errorCount = 0
          symbols[idx].status = 'waiting'
          symbols[idx].lastCycleTime = Date.now()
          log(`${symbols[idx].name}: خطا به حد مجاز رسید - عبور از نماد`, 'error', symbols[idx].name)
        } else {
          symbols[idx].status = 'error'
          log(`${symbols[idx].name}: خطا - ${message} (تلاش ${symbols[idx].errorCount}/${autoSettings.allowedErrors})`, 'error', symbols[idx].name)
        }
        await AutomationState.set('automation_symbols', symbols)
        return {
          success: false,
          symbol: symbols[idx].name,
          action: 'error',
          logs,
          errorCount: symbols[idx].errorCount,
          duration: Date.now() - startTime
        }
      }
    } catch {
      /* ignore */
    }

    return {
      success: false,
      symbol: null,
      action: 'error',
      logs,
      errorCount: 0,
      duration: Date.now() - startTime
    }
  } finally {
    // ✓ Flush all buffered logs to KV in a single batch write.
    //   This runs before ANY return (success, no_signal, risk_blocked, error).
    //   Using finally ensures logs are always persisted even if the cycle crashes.
    await flushLogs()
  }
}
