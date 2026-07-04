import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.join(__dirname, 'trading_data.json')

// Load existing database or create empty structure
let database = {
  settings: {},
  trades: [],
  positions: [],
  signals: [],
  logs: [],
  errors: []
}

// Initialize database from file
export function initializeDatabase() {
  try {
    if (fs.existsSync(dbPath)) {
      const data = fs.readFileSync(dbPath, 'utf-8')
      database = JSON.parse(data)
      console.log('✅ Database loaded successfully')
    } else {
      saveDatabase()
      console.log('✅ New database created')
    }
    return true
  } catch (error) {
    console.error('❌ Error initializing database:', error)
    return false
  }
}

// Save database to file
function saveDatabase() {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(database, null, 2))
  } catch (error) {
    console.error('Error saving database:', error)
  }
}

/**
 * Settings Management
 */
export const Settings = {
  get: (key) => {
    return database.settings[key] || null
  },

  set: (key, value) => {
    database.settings[key] = value
    saveDatabase()
    return { success: true }
  },

  getAll: () => {
    return database.settings
  },

  delete: (key) => {
    delete database.settings[key]
    saveDatabase()
    return { success: true }
  }
}

/**
 * Trades Management
 */
export const Trades = {
  add: (trade) => {
    trade.id = database.trades.length > 0 ? Math.max(...database.trades.map(t => t.id || 0)) + 1 : 1
    trade.created_at = new Date().toISOString()
    trade.updated_at = new Date().toISOString()
    database.trades.push(trade)
    saveDatabase()
    return { id: trade.id, lastInsertRowid: trade.id }
  },

  update: (id, updates) => {
    const trade = database.trades.find(t => t.id === id)
    if (trade) {
      Object.assign(trade, updates)
      trade.updated_at = new Date().toISOString()
      saveDatabase()
      return { changes: 1 }
    }
    return { changes: 0 }
  },

  getById: (id) => {
    return database.trades.find(t => t.id === id) || null
  },

  getByOrderId: (orderId) => {
    return database.trades.find(t => t.order_id === orderId) || null
  },

  getBySymbol: (symbol, limit = 100) => {
    return database.trades.filter(t => t.symbol === symbol).slice(-limit)
  },

  getAll: (limit = 1000) => {
    return database.trades.slice(-limit)
  },

  getByStatus: (status, limit = 100) => {
    return database.trades.filter(t => t.status === status).slice(-limit)
  }
}

/**
 * Open Positions Management
 */
export const Positions = {
  add: (position) => {
    position.id = database.positions.length > 0 ? Math.max(...database.positions.map(p => p.id || 0)) + 1 : 1
    position.created_at = new Date().toISOString()
    position.updated_at = new Date().toISOString()
    database.positions.push(position)
    saveDatabase()
    return { id: position.id, lastInsertRowid: position.id }
  },

  update: (id, updates) => {
    const position = database.positions.find(p => p.id === id)
    if (position) {
      Object.assign(position, updates)
      position.updated_at = new Date().toISOString()
      saveDatabase()
      return { changes: 1 }
    }
    return { changes: 0 }
  },

  updateBySymbol: (symbol, updates) => {
    const position = database.positions.find(p => p.symbol === symbol)
    if (position) {
      Object.assign(position, updates)
      position.updated_at = new Date().toISOString()
      saveDatabase()
      return { changes: 1 }
    }
    return { changes: 0 }
  },

  getBySymbol: (symbol) => {
    return database.positions.find(p => p.symbol === symbol) || null
  },

  getAll: () => {
    return database.positions.filter(p => p.status !== 'CLOSED')
  },

  delete: (id) => {
    database.positions = database.positions.filter(p => p.id !== id)
    saveDatabase()
    return { changes: 1 }
  },

  deleteBySymbol: (symbol) => {
    database.positions = database.positions.filter(p => p.symbol !== symbol)
    saveDatabase()
    return { changes: 1 }
  }
}

/**
 * Signals Management
 */
export const Signals = {
  add: (signal) => {
    signal.id = database.signals.length > 0 ? Math.max(...database.signals.map(s => s.id || 0)) + 1 : 1
    signal.created_at = new Date().toISOString()
    database.signals.push(signal)
    saveDatabase()
    return { id: signal.id }
  },

  update: (id, updates) => {
    const signal = database.signals.find(s => s.id === id)
    if (signal) {
      Object.assign(signal, updates)
      saveDatabase()
      return { changes: 1 }
    }
    return { changes: 0 }
  },

  getById: (id) => {
    return database.signals.find(s => s.id === id) || null
  },

  getBySymbol: (symbol, limit = 50) => {
    return database.signals.filter(s => s.symbol === symbol).slice(-limit)
  },

  getPending: (limit = 100) => {
    return database.signals.filter(s => s.status === 'PENDING').slice(-limit)
  },

  getLatest: (symbol) => {
    const list = database.signals.filter(s => s.symbol === symbol)
    return list.length > 0 ? list[list.length - 1] : null
  }
}

/**
 * Automation Logs Management
 */
export const AutomationLogs = {
  add: (log) => {
    log.id = database.logs.length > 0 ? Math.max(...database.logs.map(l => l.id || 0)) + 1 : 1
    log.created_at = new Date().toISOString()
    database.logs.push(log)
    saveDatabase()
    return { id: log.id }
  },

  getBySymbol: (symbol, limit = 100) => {
    return database.logs.filter(l => l.symbol === symbol).slice(-limit)
  },

  getRecent: (limit = 200) => {
    return database.logs.slice(-limit)
  },

  getErrors: (limit = 100) => {
    return database.logs.filter(l => l.status === 'ERROR').slice(-limit)
  }
}

/**
 * Error Tracking
 */
export const Errors = {
  log: (error) => {
    const err = {
      id: database.errors.length > 0 ? Math.max(...database.errors.map(e => e.id || 0)) + 1 : 1,
      type: error.type || 'UNKNOWN',
      message: error.message || '',
      stack: error.stack || '',
      context: error.context || {},
      created_at: new Date().toISOString()
    }
    database.errors.push(err)
    saveDatabase()
    return { id: err.id }
  },

  getRecent: (limit = 100) => {
    return database.errors.slice(-limit)
  }
}

/**
 * Statistics & Analytics
 */
export const Analytics = {
  getTradingStats: () => {
    const closedTrades = database.trades.filter(t => t.status === 'CLOSED')
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

  getSymbolStats: (symbol) => {
    const trades = database.trades.filter(t => t.symbol === symbol && t.status === 'CLOSED')
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0)
    
    return {
      symbol: symbol,
      total_trades: trades.length,
      winning_trades: trades.filter(t => t.pnl > 0).length,
      total_pnl: totalPnl,
      avg_pnl: trades.length > 0 ? totalPnl / trades.length : 0
    }
  },

  getDailyStats: (days = 7) => {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - days)
    
    const stats = {}
    database.trades.forEach(trade => {
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

export default database
