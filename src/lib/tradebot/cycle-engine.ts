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
  // ✓ مورد ۶: حداقل تعداد کندل هم‌جهت بعد از سیگنال (0 = غیرفعال)
  minSameDirectionCandles: number
  // ✓ مورد ۸: تعداد رکوردهای ارسالی در نوتیف تاریخچه پوزیشن‌های بسته
  closedPositionsNotifyCount: number
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
  // ✓ Index of the candle in `data[]` that this signal was generated on.
  //   Used by the min-same-direction-candles risk control (مورد ۶) to look
  //   up the N candles after the signal candle.
  candleIndex?: number
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
    // ✓ مورد ۶: حداقل تعداد کندل هم‌جهت بعد از سیگنال (0 = غیرفعال)
    minSameDirectionCandles: 0,
    // ✓ مورد ۸: تعداد رکوردهای ارسالی در نوتیف تاریخچه پوزیشن‌های بسته
    closedPositionsNotifyCount: 10,
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
    // ✓ IMPORTANT: now async (await) — caller MUST await to ensure KV consistency
    // -------------------------------------------------------------------
    const updateSymbolState = async (
      updates: Partial<SymbolEntry>
    ) => {
      const idx = symbols.findIndex((s) => s.id === symbol!.id)
      if (idx >= 0) {
        symbols[idx] = { ...symbols[idx], ...updates }
        // ✓ Await KV write to ensure consistency before next cycle starts
        await AutomationState.set('automation_symbols', symbols)
      }
    }

    // ✓ FIX (مشکل ۱): Set lastCycleTime IMMEDIATELY after symbol selection
    //   This ensures that even if the next cycle starts in the same second,
    //   this symbol won't be selected again (tradeWaitTime hasn't passed).
    //   We await the KV write to guarantee it's persisted before continuing.
    await updateSymbolState({ status: 'running', lastCycleTime: Date.now(), errorCount: 0 })

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
          symbol: symbol.name,
          // ✓ مورد ۶: candle index — used by min-same-direction-candles risk control
          candleIndex: i
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
          symbol: symbol.name,
          // ✓ مورد ۶: candle index — used by min-same-direction-candles risk control
          candleIndex: i
        })
      }
    }

    log(`${symbol.name}: ${signals.length} سیگنال تولید شد`, 'info', symbol.name)

    if (signals.length === 0) {
      log(`${symbol.name}: هیچ سیگنالی یافت نشد - شرایط بازار مناسب نیست`, 'warning', symbol.name)
      await updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
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
    // calculateSignalStatus — ✓ includes signal expiration logic (مورد ۴)
    const isSignalExpired = (signal: Signal): boolean => {
      if (!signal || !signal.timestamp) return false
      const signalTime = signal.timestamp instanceof Date
        ? signal.timestamp.getTime()
        : new Date(signal.timestamp).getTime()
      const now = Date.now()
      const expirationMs = (automationSettings.signalExpirationHours || 6) * 60 * 60 * 1000
      return (now - signalTime) > expirationMs
    }

    const calculateSignalStatus = (signal: Signal): { text: string } => {
      if (!currentSymbolHistory || !Array.isArray(currentSymbolHistory)) {
        const isLatest = signals.indexOf(signal) === signals.length - 1
        // ✓ Check expiration even without history
        if (isLatest && isSignalExpired(signal)) {
          return { text: 'منقضی شده' }
        }
        return { text: isLatest ? 'در انتظار' : 'باز نشده' }
      }
      const signalDirection = signal.type === 'Long' ? 'BUY' : 'SELL'
      const openPositions = currentSymbolHistory.filter(
        (pos) => pos.side && pos.side.includes('OPEN') && pos.side.includes(signalDirection)
      )
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
        // ✓ Check if signal is expired (مورد ۴)
        if (isLatest && isSignalExpired(signal)) {
          return { text: 'منقضی شده' }
        }
        return { text: isLatest ? 'در انتظار' : 'باز نشده' }
      }
      return { text: 'باز شده' }
    }

    const latestSignal = signals[signals.length - 1]
    const status = calculateSignalStatus(latestSignal)
    // ✓ Expired signals are NOT selected — they can't be traded
    const selectedSignal = status.text === 'در انتظار' ? latestSignal : null

    if (!selectedSignal) {
      if (status.text === 'منقضی شده') {
        log(`${symbol.name}: سیگنال منقضی شده است (بیش از ${automationSettings.signalExpirationHours} ساعت از صدور گذشته) - از این نماد عبور میشود`, 'warning', symbol.name)
      } else {
        log(`${symbol.name}: هیچ سیگنالی برای ورود آماده نیست - از این نماد عبو میشود`, 'warning', symbol.name)
      }
      await updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
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

    // ===================================================================
    // ✓ مورد ۶: Min Same-Direction Candles Control
    //   When minSameDirectionCandles > 0, check that the N candles AFTER
    //   the signal candle are all the same direction as the signal:
    //     - Long signal  → all N candles must be GREEN (close > open)
    //     - Short signal → all N candles must be RED   (close < open)
    //   If NOT enough candles exist after the signal (signal too recent)
    //   → REJECT (wait for more candles to form).
    //   If even one candle is opposite → REJECT.
    //   Placement: AFTER closeOppositePositions (step 8) and BEFORE step 9
    //   (refresh history). This control only blocks position OPENING.
    // ===================================================================
    const minSameDir = automationSettings.minSameDirectionCandles || 0
    if (minSameDir > 0) {
      const sigIdx = typeof selectedSignal.candleIndex === 'number' ? selectedSignal.candleIndex : -1
      if (sigIdx < 0) {
        // Should not happen — but guard anyway
        log(`${symbol.name}: شماره کندل سیگنال نامشخص — کنترل کندل هم‌جهت skip شد`, 'warning', symbol.name)
      } else {
        const candlesAfterSignal = data.length - sigIdx - 1
        if (candlesAfterSignal < minSameDir) {
          // Not enough candles after the signal yet
          const checkedIdxs: number[] = []
          for (let k = 1; k <= candlesAfterSignal; k++) checkedIdxs.push(sigIdx + k)
          const checkedList = checkedIdxs.length > 0
            ? checkedIdxs.join('، ')
            : '—'
          const math =
            `سیگنال روی کندل ${sigIdx} صادر شده\n` +
            `حداقل کندل هم‌جهت مورد نیاز = ${minSameDir}\n` +
            `کندل‌های موجود بعد از سیگنال: ${candlesAfterSignal} (کندل ${checkedList})\n` +
            `نتیجه: تعداد کندل کافی نیست — صبر کنید تا کندل‌های بیشتری تشکیل شوند`
          log(`${symbol.name}: کندل‌های هم‌جهت کافی نیست (${candlesAfterSignal} < ${minSameDir}) — رد شد`, 'warning', symbol.name)
          await notifyRiskControlBlocked(
            'حداقل کندل هم‌جهت (Min Same-Direction Candles)',
            math
          )
          await updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
          return {
            success: false,
            symbol: symbol.name,
            action: 'risk_blocked',
            logs,
            errorCount: 0,
            duration: Date.now() - startTime
          }
        }

        // Check each of the N candles after the signal
        const checkedIdxs: number[] = []
        for (let k = 1; k <= minSameDir; k++) checkedIdxs.push(sigIdx + k)
        const candleLines: string[] = []
        let failedIdx: number | null = null
        let failedReason = ''
        for (let k = 1; k <= minSameDir; k++) {
          const ci = sigIdx + k
          const c = data[ci]
          const isGreen = c.close > c.open
          const isRed = c.close < c.open
          if (selectedSignal.type === 'Long') {
            // Need GREEN candles
            if (isGreen) {
              candleLines.push(`کندل ${ci}: سبز (close > open) ✓`)
            } else {
              candleLines.push(`کندل ${ci}: قرمز (close < open) ✗ — کندل مخالف سیگنال لانگ`)
              failedIdx = ci
              failedReason = 'قرمز (close < open) — کندل مخالف سیگنال لانگ'
              break
            }
          } else {
            // Short — need RED candles
            if (isRed) {
              candleLines.push(`کندل ${ci}: قرمز (close < open) ✓`)
            } else {
              candleLines.push(`کندل ${ci}: سبز (close > open) ✗ — کندل مخالف سیگنال شورت`)
              failedIdx = ci
              failedReason = 'سبز (close > open) — کندل مخالف سیگنال شورت'
              break
            }
          }
        }

        if (failedIdx !== null) {
          const math =
            `سیگنال روی کندل ${sigIdx} صادر شده\n` +
            `حداقل کندل هم‌جهت مورد نیاز = ${minSameDir}\n` +
            `کندل‌های بررسی شده: ${checkedIdxs.join('، ')}\n` +
            `${candleLines.join('\n')}\n` +
            `نتیجه: شرایط برقرار نیست — پوزیشن باز نشد`
          log(`${symbol.name}: کندل مخالف سیگنال یافت شد (کندل ${failedIdx}: ${failedReason}) — رد شد`, 'warning', symbol.name)
          await notifyRiskControlBlocked(
            'حداقل کندل هم‌جهت (Min Same-Direction Candles)',
            math
          )
          await updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
          return {
            success: false,
            symbol: symbol.name,
            action: 'risk_blocked',
            logs,
            errorCount: 0,
            duration: Date.now() - startTime
          }
        }

        log(`${symbol.name}: ${minSameDir} کندل هم‌جهت تأیید شد (کندل‌های ${checkedIdxs.join('، ')})`, 'success', symbol.name)
      }
    }

    // -------------------------------------------------------------------
    // ✓ Step 9 (NEW): Refresh "سوابق پوزیشن‌ها" (position history) table
    // Fetch fresh history AFTER closing opposite positions so the history
    // reflects the latest state (including any newly-closed positions).
    // This history is used to compute the "آخرین ورود" column in step 10.
    // -------------------------------------------------------------------
    log(`${symbol.name}: بروزرسانی جدول سوابق پوزیشن‌ها...`, 'info', symbol.name)
    // ✓ Re-fetch fresh history (currentSymbolHistory was already declared in step 5)
    currentSymbolHistory = []
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
          log(`${symbol.name}: جدول سوابق پوزیشن‌ها بروزرسانی شد (${currentSymbolHistory.length} ردیف)`, 'success', symbol.name)
        }
      } catch (e) {
        log(`${symbol.name}: خطا در بروزرسانی سوابق پوزیشن‌ها - ${e instanceof Error ? e.message : 'unknown'}`, 'warning', symbol.name)
      }
    }

    // -------------------------------------------------------------------
    // ✓ Step 10 (NEW): Refresh "پوزیشن‌های باز" (open positions) table +
    //   compute "آخرین ورود" column from the fresh history (step 9).
    //   This replaces the old getSymbolMargin() call.
    //   The open positions data is stored in `freshOpenPositions` for
    //   use by the risk controls in step 12.
    // -------------------------------------------------------------------
    log(`${symbol.name}: بروزرسانی جدول پوزیشن‌های باز...`, 'info', symbol.name)
    let freshOpenPositions: Record<string, unknown>[] = []
    // ✓ lastEntryPriceCache for this symbol (computed from fresh history)
    let symbolLastEntryPrice: number | null = null
    if (apiKey && secretKey) {
      try {
        const opResponse = await fetch(`${baseUrl}/api/open-positions`, {
          headers: {
            'X-API-Key': apiKey,
            'X-Secret-Key': secretKey,
            'X-Base-Url': toobitBaseUrl
          }
        })
        if (opResponse.ok) {
          const opData = await opResponse.json()
          freshOpenPositions = (opData.positions || opData.data || []) as Record<string, unknown>[]

          // ✓ Compute "آخرین ورود" for the current cycle symbol from the fresh history
          // Logic: find the latest row (newest time) in currentSymbolHistory.
          //   - If its side is OPEN (BUY_OPEN or SELL_OPEN) → use its price as "آخرین ورود"
          //   - If its side is CLOSE (BUY_CLOSE or SELL_CLOSE) → null (no open position)
          if (currentSymbolHistory.length > 0) {
            const signalDirection = selectedSignal.type === 'Long' ? 'long' : 'short'
            const sidePrefix = signalDirection === 'long' ? 'BUY' : 'SELL'
            // Sort chronologically (ascending by time)
            const sortedHistory = [...currentSymbolHistory].sort((a, b) => a.time.getTime() - b.time.getTime())
            // Find the LATEST OPEN trade matching direction
            let latestOpen: HistoryEntry | null = null
            for (let i = sortedHistory.length - 1; i >= 0; i--) {
              const t = sortedHistory[i]
              if (t.side && t.side.includes(sidePrefix) && t.side.includes('OPEN')) {
                latestOpen = t
                break
              }
            }
            symbolLastEntryPrice = latestOpen ? latestOpen.price : null
          }

          // Persist open positions to DB (so the UI can display them)
          AutomationState.set('openPositions', freshOpenPositions).catch(() => {})
          log(`${symbol.name}: جدول پوزیشن‌های باز بروزرسانی شد (${freshOpenPositions.length} پوزیشن)`, 'success', symbol.name)
        }
      } catch (e) {
        log(`${symbol.name}: خطا در بروزرسانی پوزیشن‌های باز - ${e instanceof Error ? e.message : 'unknown'}`, 'warning', symbol.name)
      }
    }

    // -------------------------------------------------------------------
    // ✓ Step 11: fetchBalance()
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
    // ✓ Step 12: calculateNewMargin() + Risk Controls
    // -------------------------------------------------------------------
    log(`${symbol.name}: محاسبه مارجین (${automationSettings.entryMarginPercent}% از کل دارایی)...`, 'info', symbol.name)
    const newMargin = parseFloat((totalAssets * (automationSettings.entryMarginPercent / 100)).toFixed(2))
    log(`${symbol.name}: مارجین محاسبه شده = ${newMargin} USDT`, 'success', symbol.name)

    // Helper to send Bale notification for risk-control blocks
    /**
     * ✓ Send Bale notification
     *
     * ✓ Cloudflare issue: Cloudflare's edge servers can't reach tapi.bale.ai (DNS error 1016)
     *   because the Bale API is hosted in Iran.
     *
     * ✓ Solution:
     *   1. Try sending via /api/bale-send (might work if not on Cloudflare)
     *   2. If that fails, store the message in KV as "pendingBaleMessages"
     *   3. When the user opens the automation page in their browser, the browser
     *      will pick up pending messages and send them directly to Bale API
     *      (browser can reach tapi.bale.ai because it's in Iran)
     */
    const sendBaleNotification = async (text: string) => {
      const token = automationSettings.baleToken
      const chatId = automationSettings.baleChatId
      if (!token || !chatId) return { ok: false, error: 'Not configured' }

      // Method 1: Try via /api/bale-send
      try {
        const res = await fetch(`${baseUrl}/api/bale-send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, chatId, text })
        })
        const data = await res.json()
        if (data.ok) {
          return data
        }
        // If bale-send failed (e.g., Cloudflare can't reach tapi.bale.ai),
        // fall through to Method 2
      } catch {
        // fall through to Method 2
      }

      // Method 2: Store in KV as pending message for the browser to send
      try {
        const existing = (await AutomationState.get('pendingBaleMessages')) || []
        const messages = Array.isArray(existing) ? existing : []
        messages.push({
          text,
          token,
          chatId,
          timestamp: new Date().toISOString()
        })
        // Keep only latest 50 pending messages
        const trimmed = messages.slice(-50)
        await AutomationState.set('pendingBaleMessages', trimmed)
        log('پیام بله در صف ارسال مرورگر ذخیره شد (سرور نمی‌تواند به tapi.bale.ai برسد)', 'info')
        return { ok: false, error: 'Queued for browser delivery', queued: true }
      } catch {
        return { ok: false, error: 'Failed to queue message' }
      }
    }

    const notifyRiskControlBlocked = async (
      controlName: string,
      math: string
    ) => {
      const eventTime = toJalali(new Date())
      const directionIcon = selectedSignal.type === 'Long' ? '🔵' : '🔴'
      const directionText = selectedSignal.type === 'Long' ? 'لانگ' : 'شورت'

      // ✓ Determine hashtag based on control name
      let hashtag = '#کنترل_ریسک'
      if (controlName.includes('فاصله قیمت')) {
        hashtag = '#فاصله_قیمت'
      } else if (controlName.includes('دارایی امن')) {
        hashtag = '#دارایی_امن'
      } else if (controlName.includes('سقف مارجین')) {
        hashtag = '#سقف_مارجین'
      } else if (controlName.includes('مارجین مثبت')) {
        hashtag = '#مارجین_مثبت'
      } else if (controlName.includes('کندل هم‌جهت') || controlName.includes('کندل هم جهت')) {
        hashtag = '#کندل_هم‌جهت'
      }

      const text =
        `🚫 جلوگیری از باز شدن پوزیشن\n` +
        `⭐ نماد: ${symbol!.name}\n` +
        `${directionIcon} جهت سیگنال: ${directionText}\n` +
        `🚦 کنترل فعال: ${controlName}\n\n` +
        `📐 قیاس ریاضی:\n${math}\n\n` +
        `🕐 زمان رویداد: ${eventTime}\n` +
        `${hashtag}`
      return sendBaleNotification(text)
    }

    // ===================================================================
    // ✓ Control 2 (الف): Safe Asset Check — ALWAYS runs
    // ===================================================================
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
        `کل دارایی = ${totalAssets.toFixed(4)} USDT\n` +
          `موجودی آزاد = ${freeBalance.toFixed(4)} USDT\n` +
          `مارجین ورودی جدید = ${newMargin.toFixed(4)} USDT\n` +
          `درصد دارایی امن = ${automationSettings.safeAssetPercent}%\n` +
          `دارایی امن = ${totalAssets.toFixed(4)} × ${automationSettings.safeAssetPercent}% = ${safeAmount.toFixed(4)} USDT\n` +
          `موجودی آزاد پیش‌بینی‌شده = ${freeBalance.toFixed(4)} - ${newMargin.toFixed(4)} = ${projectedFree.toFixed(4)} USDT\n` +
          `${projectedFree.toFixed(4)} < ${safeAmount.toFixed(4)} ✗`
      )
      await updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
      return {
        success: false,
        symbol: symbol.name,
        action: 'risk_blocked',
        logs,
        errorCount: 0,
        duration: Date.now() - startTime
      }
    }

    // ===================================================================
    // ✓ Controls 3 & 4: Price Distance + Max Margin Per Symbol
    //   NEW LOGIC: Only run if the current cycle symbol is in the open
    //   positions table (freshOpenPositions from step 10).
    //   If the symbol is NOT in open positions → skip both controls.
    // ===================================================================
    const symbolPosition = freshOpenPositions.find((pos) => {
      const posSymbol = String(pos.symbol || '').toUpperCase()
      return posSymbol === fullSymbol.toUpperCase()
    })

    if (symbolPosition) {
      // Symbol IS in open positions table → run controls 3 & 4
      log(`${symbol.name}: نماد در پوزیشن‌های باز یافت شد — اجرای کنترل‌های فاصله قیمت و سقف مارجین`, 'info', symbol.name)

      // ── Control 3: Price Distance Check ──────────────────────────────
      // ✓ Read "آخرین ورود" from symbolLastEntryPrice (computed in step 10)
      if (symbolLastEntryPrice !== null && symbolLastEntryPrice !== undefined) {
        let distancePercent: number
        if (selectedSignal.type === 'Long') {
          distancePercent = ((symbolLastEntryPrice - price) / symbolLastEntryPrice) * 100
        } else {
          distancePercent = ((price - symbolLastEntryPrice) / symbolLastEntryPrice) * 100
        }
        if (distancePercent < automationSettings.minPriceDistancePercent) {
          log(
            `${symbol.name}: فاصله قیمت کافی نیست (آخرین ورود: ${symbolLastEntryPrice}, فعلی: ${price}, فاصله: ${distancePercent.toFixed(2)}% < ${automationSettings.minPriceDistancePercent}%) — رد شد`,
            'warning',
            symbol.name
          )
          const distanceFormula =
            selectedSignal.type === 'Long'
              ? `فاصله = (آخرین ورود - فعلی) / آخرین ورود × 100\nفاصله = (${symbolLastEntryPrice} - ${price}) / ${symbolLastEntryPrice} × 100`
              : `فاصله = (فعلی - آخرین ورود) / آخرین ورود × 100\nفاصله = (${price} - ${symbolLastEntryPrice}) / ${symbolLastEntryPrice} × 100`
          await notifyRiskControlBlocked(
            'فاصله قیمت (Price Distance)',
            `آخرین قیمت ورود هم‌جهت = ${symbolLastEntryPrice}\n` +
              `قیمت فعلی = ${price}\n` +
              `جهت سیگنال = ${selectedSignal.type === 'Long' ? 'لانگ' : 'شورت'}\n` +
              `${distanceFormula}\n` +
              `فاصله = ${distancePercent.toFixed(4)}%\n` +
              `حداقل فاصله قیمت = ${automationSettings.minPriceDistancePercent}%\n` +
              `${distancePercent.toFixed(4)}% < ${automationSettings.minPriceDistancePercent}% ✗`
          )
          await updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
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
      } else {
        log(`${symbol.name}: آخرین ورود هم‌جهت در تاریخچه یافت نشد — کنترل قیمت انجام نشد`, 'info', symbol.name)
      }

      // ── Control 4: Max Margin Per Symbol ────────────────────────────
      // ✓ Read "مارجین موجود نماد" from the "مارجین" column of the open positions table
      const existingSymbolMargin = parseFloat(String(symbolPosition.margin || 0))
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
          `کل دارایی = ${totalAssets.toFixed(4)} USDT\n` +
            `درصد سقف مارجین نماد = ${automationSettings.maxMarginPerSymbolPercent}%\n` +
            `سقف مارجین نماد = ${totalAssets.toFixed(4)} × ${automationSettings.maxMarginPerSymbolPercent}% = ${maxMarginPerSymbol.toFixed(4)} USDT\n` +
            `مارجین موجود نماد = ${existingSymbolMargin.toFixed(4)} USDT (از ستون «مارجین» جدول پوزیشن‌های باز)\n` +
            `مارجین ورودی جدید = ${newMargin.toFixed(4)} USDT\n` +
            `مجموع مارجین نماد = ${existingSymbolMargin.toFixed(4)} + ${newMargin.toFixed(4)} = ${totalSymbolMargin.toFixed(4)} USDT\n` +
            `${totalSymbolMargin.toFixed(4)} > ${maxMarginPerSymbol.toFixed(4)} ✗`
        )
        await updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
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
    } else {
      // Symbol NOT in open positions table → skip controls 3 & 4
      log(`${symbol.name}: نماد در پوزیشن‌های باز یافت نشد — کنترل‌های فاصله قیمت و سقف مارجین skip شدند`, 'info', symbol.name)
    }

    // ===================================================================
    // ✓ Control 5 (Fallback): Ensure margin is positive — ALWAYS runs
    // ===================================================================
    const finalMargin = Math.max(newMargin, 0)
    if (finalMargin <= 0) {
      log(`${symbol.name}: مارجین نهایی صفر یا منفی — رد شد`, 'warning', symbol.name)
      await notifyRiskControlBlocked(
        'مارجین مثبت (Positive Margin)',
        `کل دارایی = ${totalAssets.toFixed(4)} USDT\n` +
          `درصد مارجین ورودی = ${automationSettings.entryMarginPercent}%\n` +
          `مارجین محاسبه‌شده = ${totalAssets.toFixed(4)} × ${automationSettings.entryMarginPercent}% = ${newMargin.toFixed(4)} USDT\n` +
          `مارجین نهایی = max(${newMargin.toFixed(4)}, 0) = ${finalMargin.toFixed(4)} USDT\n` +
          `${finalMargin.toFixed(4)} ≤ 0 ✗`
      )
      await updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
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
        `⭐ نماد: ${closedPositionInfo.symbol || symbol.name}\n` +
        `${closedDirectionIcon} جهت: ${closedDirectionText}\n` +
        `🔢 اهرم: ${closedPositionInfo.leverage || automationSettings.leverage}x\n` +
        `💵 مارجین: ${closedMargin} USDT\n` +
        `${closedPnLColor} سود/زیان: ${closedPnL} USDT (${closedPnLPercent}%)\n\n`
    } else if (closedCount > 0) {
      baleText +=
        `🔒 بسته شدن پوزیشن معکوس\n` +
        `⭐ نماد: ${symbol.name}\n` +
        `${closedDirectionIcon} جهت: ${closedDirectionText}\n` +
        `🔢 اهرم: ${automationSettings.leverage}x\n\n`
    } else {
      baleText += `⚠️ پوزیشن مخالف جهت بستن وجود نداشت\n\n`
    }

    baleText +=
      `🚀 ورود به پوزیشن جدید\n` +
      `⭐ نماد: ${symbol.name}\n` +
      `${directionIcon} جهت: ${directionText}\n` +
      `💰 قیمت ورود: ${price}\n` +
      `🎯 حد سود: ${selectedSignal.tp.toFixed(4)}\n` +
      `🛑 حد ضرر: ${selectedSignal.sl.toFixed(4)}\n` +
      `💵 مارجین: ${finalMargin} USDT\n` +
      `🔢 اهرم: ${automationSettings.leverage}x\n` +
      `🏦 موجودی کل: ${updatedBalance.total || '-'} USDT\n` +
      `🏦 موجودی آزاد: ${updatedBalance.free || '-'} USDT\n` +
      `🕐 زمان صدور سیگنال: ${signalTime}\n` +
      `🕐 زمان رویداد: ${eventTime}\n` +
      `#ورود_پوزیشن`

    await sendBaleNotification(baleText)

    // -------------------------------------------------------------------
    // Update symbol status
    // -------------------------------------------------------------------
    await updateSymbolState({ status: 'waiting', lastCycleTime: Date.now(), errorCount: 0 })
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

        // ✓ Local Bale notification helper for catch block
        //   (the try block's sendBaleNotification is out of scope here)
        const sendBaleNotificationCatch = async (text: string) => {
          const token = autoSettings.baleToken as string
          const chatId = autoSettings.baleChatId as string
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

        // ✓ Bale notification for cycle errors (mirrors client-side notifyError)
        const notifyError = async (symbolName: string, errorMessage: string) => {
          const eventTime = toJalali(new Date())
          const text =
            `❌ خطای اتوماسیون\n` +
            `⭐ نماد: ${symbolName}\n` +
            `📝 پیام: ${errorMessage}\n` +
            `🕐 زمان رویداد: ${eventTime}\n` +
            `#خطا`
          return sendBaleNotificationCatch(text)
        }

        // ✓ Bale notification for symbol skip (mirrors client-side notifySymbolSkipped)
        const notifySymbolSkipped = async (symbolName: string) => {
          const eventTime = toJalali(new Date())
          const text =
            `⏭️ عبور از نماد\n` +
            `⭐ نماد: ${symbolName}\n` +
            `📝 تعداد خطاها به حد مجاز رسید - خطاها ریست شد و به نماد بعدی پرش شد\n` +
            `🕐 زمان رویداد: ${eventTime}\n` +
            `#عبور_نماد`
          return sendBaleNotificationCatch(text)
        }

        if (symbols[idx].errorCount >= autoSettings.allowedErrors) {
          symbols[idx].errorCount = 0
          symbols[idx].status = 'waiting'
          symbols[idx].lastCycleTime = Date.now()
          log(`${symbols[idx].name}: خطا به حد مجاز رسید - عبور از نماد`, 'error', symbols[idx].name)
          await notifySymbolSkipped(symbols[idx].name)
        } else {
          symbols[idx].status = 'error'
          log(`${symbols[idx].name}: خطا - ${message} (تلاش ${symbols[idx].errorCount}/${autoSettings.allowedErrors})`, 'error', symbols[idx].name)
          await notifyError(symbols[idx].name, message)
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

// ---------------------------------------------------------------------------
// ✓ مورد ۸: Check Closed Positions History
//   This function is called AFTER the last cycle completes (not during each cycle).
//   It fetches ALL closed positions from Toobit and compares with lastPositionId
//   stored in KV. If different → new positions detected → send Bale notification.
//
//   ✓ Fix (مشکل ۲): Moved from beginning of each cycle to end of LAST cycle only.
//   This prevents repeated notifications when cyclesPerRun > 1.
// ---------------------------------------------------------------------------

export async function checkClosedPositionsHistory(
  baseUrl: string
): Promise<void> {
  const startTime = Date.now()
  console.log('[ClosedPositionsHistory] Starting check...')

  try {
    // Load settings from KV
    await initializeDatabase()

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

    const cpApiKey = marketSettings.apiKey || ''
    const cpSecretKey = marketSettings.secretKey || ''
    const cpBaseUrl = marketSettings.baseUrl || 'https://api.toobit.com'

    if (!cpApiKey || !cpSecretKey) {
      console.log('[ClosedPositionsHistory] API keys not configured — skipping')
      return
    }

    // Fetch all closed positions (no symbol filter → all symbols)
    const cpResponse = await fetch(`${baseUrl}/api/history-positions`, {
      headers: {
        'X-API-Key': cpApiKey,
        'X-Secret-Key': cpSecretKey,
        'X-Base-Url': cpBaseUrl
      }
    })

    if (!cpResponse.ok) {
      console.warn(`[ClosedPositionsHistory] HTTP ${cpResponse.status} — skipping`)
      return
    }

    const cpData = await cpResponse.json()

    // Normalize response
    let cpRecords: Record<string, unknown>[] = []
    if (Array.isArray(cpData)) {
      cpRecords = cpData
    } else if (cpData && Array.isArray(cpData.data)) {
      cpRecords = cpData.data
    } else if (cpData && Array.isArray(cpData.result)) {
      cpRecords = cpData.result
    } else if (cpData && typeof cpData === 'object') {
      const found = Object.values(cpData).find((v) => Array.isArray(v))
      cpRecords = (found as Record<string, unknown>[]) || []
    }

    if (cpRecords.length === 0) {
      console.log('[ClosedPositionsHistory] No closed positions found')
      return
    }

    // Sort by closeTime DESC (newest first)
    cpRecords.sort((a, b) => {
      const ta = parseInt(String(a.closeTime || 0))
      const tb = parseInt(String(b.closeTime || 0))
      return tb - ta
    })

    const firstRecord = cpRecords[0]
    const firstId = String(firstRecord.id || '')

    // Compare with lastPositionId from KV
    const lastPosIdRaw = await AutomationState.get('lastPositionId')
    const lastIdStr =
      lastPosIdRaw === null || lastPosIdRaw === undefined ? '' : String(lastPosIdRaw)

    if (!firstId || firstId === lastIdStr) {
      console.log('[ClosedPositionsHistory] No new positions (lastPositionId unchanged)')
      return
    }

    // New positions detected — build Bale notification
    const notifyCount = automationSettings.closedPositionsNotifyCount || 10
    const toNotify = cpRecords.slice(0, notifyCount)

    // Persian numeral helper
    const persianNum = (n: number | string): string => {
      const map = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹']
      return String(n).replace(/\d/g, (d) => map[parseInt(d)])
    }

    // ✓ Fix (مشکل ۴): New 3-line format per position
    //   Line 1: نماد (مختصر) + قیمت بسته
    //   Line 2: جهت + سود/زیان (مقدار + درصد) + لوریج
    //   Line 3: زمان
    const lines: string[] = ['📋 تاریخچه پوزیشن‌های بسته‌شده', '']
    toNotify.forEach((pos, idx) => {
      // ✓ Convert full symbol to short name (XRP-SWAP-USDT → XRP)
      const fullSym = String(pos.symbol || '-')
      const shortSym = fullSym.replace('-SWAP-USDT', '').replace('USDT', '')

      const sideRaw = String(pos.side || '').toUpperCase()
      const sideText = sideRaw === 'SHORT' ? 'Short' : 'Long'
      const sideIcon = sideRaw === 'SHORT' ? '🔴' : '🔵'

      const closePrice = String(pos.closeAvgPrice || '-')

      // ✓ PnL fields (from Toobit API)
      const realizedPnL = parseFloat(String(pos.realizedPnL || 0))
      const realizedPnlRate = parseFloat(String(pos.realizedPnlRate || 0))
      const pnlIcon = realizedPnL >= 0 ? '📈' : '📉'
      const pnlStr = `${realizedPnL.toFixed(4)} USDT`
      const pnlPercentStr = `(${realizedPnlRate.toFixed(2)}%)`

      // ✓ Leverage
      const leverage = String(pos.leverage || '-')

      const closeTimeMs = parseInt(String(pos.closeTime || 0))
      const timeStr = closeTimeMs > 0 ? toJalali(closeTimeMs) : '-'

      lines.push(
        `${persianNum(idx + 1)}. ⭐ نماد: ${shortSym} | 💰 قیمت بسته: ${closePrice}`
      )
      lines.push(
        `   ${sideIcon} جهت: ${sideText} | ${pnlIcon} سود/زیان: ${pnlStr} ${pnlPercentStr} | 🔢 لوریج: ${leverage}x`
      )
      lines.push(
        `   🕐 زمان: ${timeStr}`
      )
    })
    lines.push('')
    lines.push(`🕐 زمان رویداد: ${toJalali(new Date())}`)
    lines.push(`#تاریخچه_بسته`)

    const text = lines.join('\n')
    console.log(`[ClosedPositionsHistory] Built notification with ${toNotify.length} records`)
    console.log(`[ClosedPositionsHistory] Message preview:\n${text.substring(0, 500)}...`)

    // Send notification
    const token = automationSettings.baleToken
    const chatId = automationSettings.baleChatId
    if (token && chatId) {
      try {
        const baleUrl = `https://tapi.bale.ai/bot${token}/sendMessage`
        await fetch(baleUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ chat_id: String(chatId), text })
        })
        console.log(`[ClosedPositionsHistory] Notification sent to Bale`)
      } catch (e) {
        // Cloudflare can't reach tapi.bale.ai → store as pending for browser delivery
        console.warn('[ClosedPositionsHistory] Direct Bale send failed, queuing for browser')
        try {
          const existing = (await AutomationState.get('pendingBaleMessages')) || []
          const messages = Array.isArray(existing) ? existing : []
          messages.push({ text, token, chatId, timestamp: new Date().toISOString() })
          await AutomationState.set('pendingBaleMessages', messages.slice(-50))
        } catch {
          // give up silently
        }
      }
    }

    // ✓ Save the new firstId to KV (regardless of whether Bale succeeded)
    //   so we don't keep re-notifying on every cycle.
    await AutomationState.set('lastPositionId', firstId)
    console.log(`[ClosedPositionsHistory] Done in ${Date.now() - startTime}ms (firstId=${firstId})`)
  } catch (e) {
    console.warn(
      `[ClosedPositionsHistory] Error: ${e instanceof Error ? e.message : 'unknown'}`
    )
  }
}
