/**
 * TradeBot Database — Cloudflare-ready (KV) with local JSON file fallback
 *
 * ✓ Works on Cloudflare Workers/Pages using KV namespace (TRADING_DATA)
 * ✓ Works in local dev using JSON file (lib/tradebot/trading_data.json)
 * ✓ ALL methods are async (required for KV)
 *
 * The storage backend is auto-detected at runtime:
 *   - If getRequestContext() from @cloudflare/next-on-pages is available → KV
 *   - Otherwise → JSON file (local dev)
 *
 * KV key layout:
 *   settings:<key>          → individual setting value
 *   automationState:<key>   → individual automation state value
 *   trades                   → JSON array of all trades
 *   positions                → JSON array of all positions
 *   signals                  → JSON array of all signals
 *   logs                     → JSON array of all logs (max 500)
 *   errors                   → JSON array of all errors
 *
 * Each write REPLACES the previous value (no append), so the latest data
 * always overwrites the old data — matching the user's requirement.
 */

// ---------------------------------------------------------------------------
// KV binding accessor — works with @cloudflare/next-on-pages
// ---------------------------------------------------------------------------

let _kvCache = undefined // undefined = not yet checked, null = no KV, object = KV

async function getKV() {
  if (_kvCache !== undefined) return _kvCache

  try {
    // @cloudflare/next-on-pages provides getRequestContext() to access env bindings
    const { getRequestContext } = await import('@cloudflare/next-on-pages')
    const ctx = getRequestContext()
    _kvCache = (ctx.env && ctx.env.TRADING_DATA) || null
  } catch {
    // Not on Cloudflare — local dev, use JSON file
    _kvCache = null
  }

  return _kvCache
}

// ---------------------------------------------------------------------------
// JSON file storage (local dev only)
// ---------------------------------------------------------------------------

const DB_PATH = '/home/z/my-project/lib/tradebot/trading_data.json'

let fileDatabase = null

async function loadFileDatabase() {
  if (fileDatabase !== null) return fileDatabase
  try {
    const fs = await import('fs')
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf-8')
      fileDatabase = JSON.parse(data)
    } else {
      fileDatabase = {
        settings: {},
        automationState: {},
        trades: [],
        positions: [],
        signals: [],
        logs: [],
        errors: []
      }
      saveFileDatabase()
    }
  } catch (e) {
    console.error('❌ Error loading file database:', e)
    fileDatabase = {
      settings: {},
      automationState: {},
      trades: [],
      positions: [],
      signals: [],
      logs: [],
      errors: []
    }
  }
  return fileDatabase
}

function saveFileDatabase() {
  if (fileDatabase === null) return
  try {
    // Dynamic import to avoid bundling fs in Cloudflare build
    import('fs').then(fs => {
      fs.writeFileSync(DB_PATH, JSON.stringify(fileDatabase, null, 2))
    })
  } catch (e) {
    console.error('Error saving file database:', e)
  }
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

async function kvGet(key) {
  const kv = await getKV()
  if (!kv) return null
  const val = await kv.get(key)
  if (val === null || val === undefined) return null
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

async function kvSet(key, value) {
  const kv = await getKV()
  if (!kv) return
  await kv.put(key, JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initializeDatabase() {
  const kv = await getKV()
  if (kv) {
    console.log('✅ Database initialized (Cloudflare KV)')
    return true
  }
  await loadFileDatabase()
  console.log('✅ Database loaded successfully (local JSON file)')
  return true
}

// Synchronous version for backward compatibility (no-op in KV/Edge mode)
// In local dev (Node.js), this loads the JSON file synchronously.
// In Edge/Cloudflare, this is a no-op — async initializeDatabase() handles init.
export function initializeDatabaseSync() {
  try {
    // Use globalThis.__tradebotDb to share state with async path
    if (typeof globalThis !== 'undefined' && globalThis.__tradebotFileSyncLoaded) {
      return true
    }
    // Only attempt fs in Node.js (not Edge)
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs')
      if (fs.existsSync(DB_PATH)) {
        const data = fs.readFileSync(DB_PATH, 'utf-8')
        fileDatabase = JSON.parse(data)
      } else {
        fileDatabase = {
          settings: {},
          automationState: {},
          trades: [],
          positions: [],
          signals: [],
          logs: [],
          errors: []
        }
        fs.writeFileSync(DB_PATH, JSON.stringify(fileDatabase, null, 2))
      }
      if (typeof globalThis !== 'undefined') {
        globalThis.__tradebotFileSyncLoaded = true
      }
      console.log('✅ Database loaded (sync)')
      return true
    }
    return false
  } catch {
    // Edge Runtime or no fs — async init will handle it
    return false
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const Settings = {
  async get(key) {
    const kv = await getKV()
    if (kv) {
      return await kvGet(`settings:${key}`)
    }
    const db = await loadFileDatabase()
    return db.settings[key] || null
  },

  async set(key, value) {
    const kv = await getKV()
    if (kv) {
      await kvSet(`settings:${key}`, value)
      return { success: true }
    }
    const db = await loadFileDatabase()
    db.settings[key] = value
    saveFileDatabase()
    return { success: true }
  },

  async getAll() {
    const kv = await getKV()
    if (kv) {
      // KV doesn't support listing with prefix easily in all contexts;
      // return empty object — callers should use individual keys
      return {}
    }
    const db = await loadFileDatabase()
    return db.settings
  },

  async delete(key) {
    const kv = await getKV()
    if (kv) {
      const kvNs = kv
      await kvNs.delete(`settings:${key}`)
      return { success: true }
    }
    const db = await loadFileDatabase()
    delete db.settings[key]
    saveFileDatabase()
    return { success: true }
  }
}

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

export const Trades = {
  async add(trade) {
    const kv = await getKV()
    if (kv) {
      const trades = (await kvGet('trades')) || []
      trade.id = trades.length > 0 ? Math.max(...trades.map(t => t.id || 0)) + 1 : 1
      trade.created_at = new Date().toISOString()
      trade.updated_at = new Date().toISOString()
      trades.push(trade)
      await kvSet('trades', trades)
      return { id: trade.id, lastInsertRowid: trade.id }
    }
    const db = await loadFileDatabase()
    trade.id = db.trades.length > 0 ? Math.max(...db.trades.map(t => t.id || 0)) + 1 : 1
    trade.created_at = new Date().toISOString()
    trade.updated_at = new Date().toISOString()
    db.trades.push(trade)
    saveFileDatabase()
    return { id: trade.id, lastInsertRowid: trade.id }
  },

  async update(id, updates) {
    const kv = await getKV()
    if (kv) {
      const trades = (await kvGet('trades')) || []
      const trade = trades.find(t => t.id === id)
      if (trade) {
        Object.assign(trade, updates)
        trade.updated_at = new Date().toISOString()
        await kvSet('trades', trades)
        return { changes: 1 }
      }
      return { changes: 0 }
    }
    const db = await loadFileDatabase()
    const trade = db.trades.find(t => t.id === id)
    if (trade) {
      Object.assign(trade, updates)
      trade.updated_at = new Date().toISOString()
      saveFileDatabase()
      return { changes: 1 }
    }
    return { changes: 0 }
  },

  async getById(id) {
    const kv = await getKV()
    if (kv) {
      const trades = (await kvGet('trades')) || []
      return trades.find(t => t.id === id) || null
    }
    const db = await loadFileDatabase()
    return db.trades.find(t => t.id === id) || null
  },

  async getByOrderId(orderId) {
    const kv = await getKV()
    if (kv) {
      const trades = (await kvGet('trades')) || []
      return trades.find(t => t.order_id === orderId) || null
    }
    const db = await loadFileDatabase()
    return db.trades.find(t => t.order_id === orderId) || null
  },

  async getBySymbol(symbol, limit = 100) {
    const kv = await getKV()
    if (kv) {
      const trades = (await kvGet('trades')) || []
      return trades.filter(t => t.symbol === symbol).slice(-limit)
    }
    const db = await loadFileDatabase()
    return db.trades.filter(t => t.symbol === symbol).slice(-limit)
  },

  async getAll(limit = 1000) {
    const kv = await getKV()
    if (kv) {
      const trades = (await kvGet('trades')) || []
      return trades.slice(-limit)
    }
    const db = await loadFileDatabase()
    return db.trades.slice(-limit)
  },

  async getByStatus(status, limit = 100) {
    const kv = await getKV()
    if (kv) {
      const trades = (await kvGet('trades')) || []
      return trades.filter(t => t.status === status).slice(-limit)
    }
    const db = await loadFileDatabase()
    return db.trades.filter(t => t.status === status).slice(-limit)
  }
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export const Positions = {
  async add(position) {
    const kv = await getKV()
    if (kv) {
      const positions = (await kvGet('positions')) || []
      position.id = positions.length > 0 ? Math.max(...positions.map(p => p.id || 0)) + 1 : 1
      position.created_at = new Date().toISOString()
      position.updated_at = new Date().toISOString()
      positions.push(position)
      await kvSet('positions', positions)
      return { id: position.id, lastInsertRowid: position.id }
    }
    const db = await loadFileDatabase()
    position.id = db.positions.length > 0 ? Math.max(...db.positions.map(p => p.id || 0)) + 1 : 1
    position.created_at = new Date().toISOString()
    position.updated_at = new Date().toISOString()
    db.positions.push(position)
    saveFileDatabase()
    return { id: position.id, lastInsertRowid: position.id }
  },

  async update(id, updates) {
    const kv = await getKV()
    if (kv) {
      const positions = (await kvGet('positions')) || []
      const pos = positions.find(p => p.id === id)
      if (pos) {
        Object.assign(pos, updates)
        pos.updated_at = new Date().toISOString()
        await kvSet('positions', positions)
        return { changes: 1 }
      }
      return { changes: 0 }
    }
    const db = await loadFileDatabase()
    const pos = db.positions.find(p => p.id === id)
    if (pos) {
      Object.assign(pos, updates)
      pos.updated_at = new Date().toISOString()
      saveFileDatabase()
      return { changes: 1 }
    }
    return { changes: 0 }
  },

  async updateBySymbol(symbol, updates) {
    const kv = await getKV()
    if (kv) {
      const positions = (await kvGet('positions')) || []
      const pos = positions.find(p => p.symbol === symbol)
      if (pos) {
        Object.assign(pos, updates)
        pos.updated_at = new Date().toISOString()
        await kvSet('positions', positions)
        return { changes: 1 }
      }
      return { changes: 0 }
    }
    const db = await loadFileDatabase()
    const pos = db.positions.find(p => p.symbol === symbol)
    if (pos) {
      Object.assign(pos, updates)
      pos.updated_at = new Date().toISOString()
      saveFileDatabase()
      return { changes: 1 }
    }
    return { changes: 0 }
  },

  async getBySymbol(symbol) {
    const kv = await getKV()
    if (kv) {
      const positions = (await kvGet('positions')) || []
      return positions.find(p => p.symbol === symbol) || null
    }
    const db = await loadFileDatabase()
    return db.positions.find(p => p.symbol === symbol) || null
  },

  async getAll() {
    const kv = await getKV()
    if (kv) {
      const positions = (await kvGet('positions')) || []
      return positions.filter(p => p.status !== 'CLOSED')
    }
    const db = await loadFileDatabase()
    return db.positions.filter(p => p.status !== 'CLOSED')
  },

  async delete(id) {
    const kv = await getKV()
    if (kv) {
      let positions = (await kvGet('positions')) || []
      positions = positions.filter(p => p.id !== id)
      await kvSet('positions', positions)
      return { changes: 1 }
    }
    const db = await loadFileDatabase()
    db.positions = db.positions.filter(p => p.id !== id)
    saveFileDatabase()
    return { changes: 1 }
  },

  async deleteBySymbol(symbol) {
    const kv = await getKV()
    if (kv) {
      let positions = (await kvGet('positions')) || []
      positions = positions.filter(p => p.symbol !== symbol)
      await kvSet('positions', positions)
      return { changes: 1 }
    }
    const db = await loadFileDatabase()
    db.positions = db.positions.filter(p => p.symbol !== symbol)
    saveFileDatabase()
    return { changes: 1 }
  }
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export const Signals = {
  async add(signal) {
    const kv = await getKV()
    if (kv) {
      const signals = (await kvGet('signals')) || []
      signal.id = signals.length > 0 ? Math.max(...signals.map(s => s.id || 0)) + 1 : 1
      signal.created_at = new Date().toISOString()
      signals.push(signal)
      await kvSet('signals', signals)
      return { id: signal.id }
    }
    const db = await loadFileDatabase()
    signal.id = db.signals.length > 0 ? Math.max(...db.signals.map(s => s.id || 0)) + 1 : 1
    signal.created_at = new Date().toISOString()
    db.signals.push(signal)
    saveFileDatabase()
    return { id: signal.id }
  },

  async update(id, updates) {
    const kv = await getKV()
    if (kv) {
      const signals = (await kvGet('signals')) || []
      const sig = signals.find(s => s.id === id)
      if (sig) {
        Object.assign(sig, updates)
        await kvSet('signals', signals)
        return { changes: 1 }
      }
      return { changes: 0 }
    }
    const db = await loadFileDatabase()
    const sig = db.signals.find(s => s.id === id)
    if (sig) {
      Object.assign(sig, updates)
      saveFileDatabase()
      return { changes: 1 }
    }
    return { changes: 0 }
  },

  async getById(id) {
    const kv = await getKV()
    if (kv) {
      const signals = (await kvGet('signals')) || []
      return signals.find(s => s.id === id) || null
    }
    const db = await loadFileDatabase()
    return db.signals.find(s => s.id === id) || null
  },

  async getBySymbol(symbol, limit = 50) {
    const kv = await getKV()
    if (kv) {
      const signals = (await kvGet('signals')) || []
      return signals.filter(s => s.symbol === symbol).slice(-limit)
    }
    const db = await loadFileDatabase()
    return db.signals.filter(s => s.symbol === symbol).slice(-limit)
  },

  async getPending(limit = 100) {
    const kv = await getKV()
    if (kv) {
      const signals = (await kvGet('signals')) || []
      return signals.filter(s => s.status === 'PENDING').slice(-limit)
    }
    const db = await loadFileDatabase()
    return db.signals.filter(s => s.status === 'PENDING').slice(-limit)
  },

  async getLatest(symbol) {
    const kv = await getKV()
    if (kv) {
      const signals = (await kvGet('signals')) || []
      const list = signals.filter(s => s.symbol === symbol)
      return list.length > 0 ? list[list.length - 1] : null
    }
    const db = await loadFileDatabase()
    const list = db.signals.filter(s => s.symbol === symbol)
    return list.length > 0 ? list[list.length - 1] : null
  }
}

// ---------------------------------------------------------------------------
// Automation Logs
// ---------------------------------------------------------------------------

export const AutomationLogs = {
  async add(log) {
    const kv = await getKV()
    if (kv) {
      const logs = (await kvGet('logs')) || []
      log.id = logs.length > 0 ? Math.max(...logs.map(l => l.id || 0)) + 1 : 1
      log.created_at = new Date().toISOString()
      logs.push(log)
      // Keep only latest 500 logs to stay within KV size limits
      const trimmed = logs.slice(-500)
      await kvSet('logs', trimmed)
      return { id: log.id }
    }
    const db = await loadFileDatabase()
    log.id = db.logs.length > 0 ? Math.max(...db.logs.map(l => l.id || 0)) + 1 : 1
    log.created_at = new Date().toISOString()
    db.logs.push(log)
    saveFileDatabase()
    return { id: log.id }
  },

  async getBySymbol(symbol, limit = 100) {
    const kv = await getKV()
    if (kv) {
      const logs = (await kvGet('logs')) || []
      return logs.filter(l => l.symbol === symbol).slice(-limit)
    }
    const db = await loadFileDatabase()
    return db.logs.filter(l => l.symbol === symbol).slice(-limit)
  },

  async getRecent(limit = 200) {
    const kv = await getKV()
    if (kv) {
      const logs = (await kvGet('logs')) || []
      return logs.slice(-limit)
    }
    const db = await loadFileDatabase()
    return db.logs.slice(-limit)
  },

  async getErrors(limit = 100) {
    const kv = await getKV()
    if (kv) {
      const logs = (await kvGet('logs')) || []
      return logs.filter(l => l.status === 'ERROR').slice(-limit)
    }
    const db = await loadFileDatabase()
    return db.logs.filter(l => l.status === 'ERROR').slice(-limit)
  },

  // ✓ Batch append — used by /api/run-cycle to write ALL cycle logs in a
  //   SINGLE KV write (read existing logs ONCE, append, write ONCE).
  //   This replaces the previous per-cycle "Strategy 2" write which did a
  //   full read-modify-write on every cycle (one write per cycle).
  //   `newLogs` items should already have: symbol, action, status, message,
  //   error_code, details, created_at. We auto-assign sequential ids.
  async appendBatch(newLogs) {
    if (!Array.isArray(newLogs) || newLogs.length === 0) {
      return { added: 0 }
    }
    const kv = await getKV()
    if (kv) {
      const existing = (await kvGet('logs')) || []
      const maxId = existing.length > 0
        ? Math.max(...existing.map(l => l.id || 0))
        : 0
      const enriched = newLogs.map((l, i) => ({
        id: maxId + i + 1,
        symbol: l.symbol || '',
        action: l.action || 'automation_cycle',
        status: l.status || 'SUCCESS',
        message: l.message || '',
        error_code: l.error_code || null,
        details: l.details || JSON.stringify({ timestamp: l.created_at || new Date().toISOString() }),
        created_at: l.created_at || new Date().toISOString()
      }))
      // Keep only latest 500 logs to stay within KV size limits
      const trimmed = [...existing, ...enriched].slice(-500)
      await kvSet('logs', trimmed)
      return { added: enriched.length }
    }
    // Local dev (JSON file) — fall back to individual pushes
    const db = await loadFileDatabase()
    for (const l of newLogs) {
      l.id = db.logs.length > 0 ? Math.max(...db.logs.map(x => x.id || 0)) + 1 : 1
      l.created_at = l.created_at || new Date().toISOString()
      db.logs.push(l)
    }
    saveFileDatabase()
    return { added: newLogs.length }
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const Errors = {
  async log(error) {
    const kv = await getKV()
    if (kv) {
      const errors = (await kvGet('errors')) || []
      const err = {
        id: errors.length > 0 ? Math.max(...errors.map(e => e.id || 0)) + 1 : 1,
        type: error.type || 'UNKNOWN',
        message: error.message || '',
        stack: error.stack || '',
        context: error.context || {},
        created_at: new Date().toISOString()
      }
      errors.push(err)
      await kvSet('errors', errors)
      return { id: err.id }
    }
    const db = await loadFileDatabase()
    const err = {
      id: db.errors.length > 0 ? Math.max(...db.errors.map(e => e.id || 0)) + 1 : 1,
      type: error.type || 'UNKNOWN',
      message: error.message || '',
      stack: error.stack || '',
      context: error.context || {},
      created_at: new Date().toISOString()
    }
    db.errors.push(err)
    saveFileDatabase()
    return { id: err.id }
  },

  async getRecent(limit = 100) {
    const kv = await getKV()
    if (kv) {
      const errors = (await kvGet('errors')) || []
      return errors.slice(-limit)
    }
    const db = await loadFileDatabase()
    return db.errors.slice(-limit)
  }
}

// ---------------------------------------------------------------------------
// Automation State (key-value store)
// ---------------------------------------------------------------------------

export const AutomationState = {
  async get(key) {
    const kv = await getKV()
    if (kv) {
      return await kvGet(`automationState:${key}`)
    }
    const db = await loadFileDatabase()
    return db.automationState[key] || null
  },

  async set(key, value) {
    const kv = await getKV()
    if (kv) {
      await kvSet(`automationState:${key}`, value)
      return { success: true }
    }
    const db = await loadFileDatabase()
    db.automationState[key] = value
    saveFileDatabase()
    return { success: true }
  },

  async delete(key) {
    const kv = await getKV()
    if (kv) {
      const kvNs = kv
      await kvNs.delete(`automationState:${key}`)
      return { success: true }
    }
    const db = await loadFileDatabase()
    delete db.automationState[key]
    saveFileDatabase()
    return { success: true }
  },

  async getAll() {
    const kv = await getKV()
    if (kv) {
      // KV doesn't easily support listing all keys with prefix in route handlers
      // Return empty — callers should use individual key lookups
      return {}
    }
    const db = await loadFileDatabase()
    return db.automationState
  }
}

// ---------------------------------------------------------------------------
// Analytics (computed on-the-fly from Trades)
// ---------------------------------------------------------------------------

export const Analytics = {
  async getTradingStats() {
    const trades = await Trades.getAll(10000)
    const closedTrades = trades.filter(t => t.status === 'CLOSED')
    const wins = closedTrades.filter(t => t.pnl > 0).length
    const losses = closedTrades.filter(t => t.pnl < 0).length
    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0)

    return {
      total_trades: closedTrades.length,
      winning_trades: wins,
      losing_trades: losses,
      total_pnl: totalPnl,
      avg_pnl: closedTrades.length > 0 ? totalPnl / closedTrades.length : 0,
      max_profit: Math.max(...closedTrades.map(t => t.pnl || 0), 0),
      max_loss: Math.min(...closedTrades.map(t => t.pnl || 0), 0)
    }
  },

  async getSymbolStats(symbol) {
    const trades = await Trades.getBySymbol(symbol, 10000)
    const closedTrades = trades.filter(t => t.status === 'CLOSED')
    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0)

    return {
      symbol: symbol,
      total_trades: closedTrades.length,
      winning_trades: closedTrades.filter(t => t.pnl > 0).length,
      total_pnl: totalPnl,
      avg_pnl: closedTrades.length > 0 ? totalPnl / closedTrades.length : 0
    }
  },

  async getDailyStats(days = 7) {
    const trades = await Trades.getAll(10000)
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - days)

    const stats = {}
    trades.forEach(trade => {
      if (trade.status === 'CLOSED' && new Date(trade.opened_at) >= cutoffDate) {
        const date = new Date(trade.opened_at).toISOString().split('T')[0]
        if (!stats[date]) {
          stats[date] = { trades: 0, wins: 0, daily_pnl: 0 }
        }
        stats[date].trades++
        if (trade.pnl > 0) stats[date].wins++
        stats[date].daily_pnl += trade.pnl || 0
      }
    })

    return Object.entries(stats).map(([date, data]) => ({ date, ...data }))
  }
}

export default {
  initializeDatabase,
  Settings,
  Trades,
  Positions,
  Signals,
  AutomationLogs,
  Errors,
  AutomationState,
  Analytics
}
