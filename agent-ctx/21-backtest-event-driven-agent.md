# Task 21 — Backtest Engine Event-Driven Rewrite

**Agent:** Backtest Event-Driven Sub-agent (general-purpose)
**Task:** Completely rewrite `public/js/backtest-engine.js` AND `public/backtest.html` to convert the engine from "Signal-Driven" (loops over signals) to "Event-Driven" (loops over candles, processing each candle as a time step).

## Context Review

- Read `/home/z/my-project/worklog.md` Tasks 0–20 for full project context.
- Read `/home/z/my-project/agent-ctx/20-backtest-agent.md` — previous backtest agent's notes on engine structure and conventions.
- Read the existing `public/js/backtest-engine.js` (1101 lines) and `public/backtest.html` (911 lines).
- Read `public/js/shared/signal-utils.js` for the SignalUtils API (calculateRSI, calculateATR, calculateSMA, generateOrderId).
- Read `public/js/automation-manager.js` lines 2840–2925 (`closeOppositePositions`) to mirror that behavior.
- Verified signal-generation logic (in `generateSignals`) was already a verbatim copy of `analyzeMarketData` and did NOT need changes — only the simulation loop and reports needed rewriting.

## Implementation

### `public/js/backtest-engine.js` — full rewrite (~1100 → ~1200 lines)

**Architecture change:** Previous `simulate()` iterated candles but only minimally tracked state (`currentCapital`, `lockedMargin`, `openPositions` array of partial objects). New `simulate()` implements the full Event-Driven Timeline per the task spec:

Per-candle order (matches spec):
1. Mark-to-market update for open positions (computed lazily via `recomputeAccountState()`)
2. TP/SL check using current candle's high/low (pessimistic — SL first if both hit)
3. Pending signal expiration check (uses CURRENT candle timestamp as "now")
4. Try to consume pending signal via risk controls (retry on each candle)
5. Generate new signal (lookup in pre-computed `signalsByCandleIdx`):
   - Discard old pending signal (push its rejection to `rejectedTrades`)
   - **Close opposite positions** on same symbol (mirrors `runCycle` step 8)
   - Try to open via risk controls; on fail, set as pending
6. Update accountState + record snapshot
7. Update equity curve, drawdown curve, peak, maxDrawdown, per-candle returns

After loop: close remaining open positions at last candle's close (`exitReason = 'پایان داده'`); push pending rejection with `'پایان داده'` if any.

**Accounting model (MT4/MT5-style):**
- `balance`: realized cash; INCLUDES margin (margin is "marked as used", not deducted from balance)
- At open: `balance -= entryCommission`; `usedMargin += margin`
- At close: `balance += pnl - exitCommission`; `usedMargin -= margin`
- `unrealizedPnl`: sum of unrealized PnLs of open positions (mark-to-market at current candle close)
- `realizedPnl`: cumulative net PnL of closed trades (after commissions)
- `equity = balance + unrealizedPnl`
- `freeMargin = equity - usedMargin`

Sanity check (verified end-to-end): at end of run with no open positions, `balance = initialCapital + realizedPnl`, `equity = balance`, `freeMargin = balance`, `usedMargin = 0`. ✓

**Position object (full lifecycle):**
```javascript
{
  id, symbol, direction,           // 'Long' | 'Short'
  entryPrice, exitPrice,           // exitPrice set on close
  tp, sl,
  qty, notional, margin, leverage,
  entryCandleIdx, entryTimestamp,
  exitCandleIdx, exitTimestamp,    // set on close
  entryCommission, exitCommission, // exitCommission set on close
  pnl, pnlPercent,                 // net (after commissions), set on close
  status,                          // 'open' | 'closed'
  exitReason,                      // 'TP' | 'SL' | 'بستن پوزیشن مخالف' | 'پایان داده'
  capitalBefore, capitalAfter,
  entryReason,
  candleCount,
  signal                           // ref to source signal
}
```

**Risk controls (`checkRiskControls`)** — 6 controls mirror `runCycle`:
1. Safe Asset: `freeMargin - newMargin >= balance × safeAssetPercent%`
2. Price Distance: same-direction `lastEntryPrice` distance check
3. Max Margin Per Symbol: per-direction `usedMarginByDirection[direction] + newMargin <= balance × maxMarginPerSymbolPercent%`
4. Positive Margin: `newMargin > 0`
5. Min Same Direction Candles: N candles after signal's candleIndex
6. **Signal Expiration: now uses `ctx.currentCandleTimestamp` (NOT signal's own timestamp)** — so expiration can actually trigger when a pending signal ages beyond `signalExpirationHours`

**Pending signal model (mirrors `automation-manager.js selectedSignal`):**
- At most one `pendingSignal` at a time (single-slot queue)
- On generation, immediately try to open; on fail, set as pending + record `pendingRejection` (not yet pushed to `rejectedTrades`)
- On subsequent candles: check expiration first; if not expired, retry risk controls; if pass, open and clear
- When a new signal replaces an old pending: push the old `pendingRejection` to `rejectedTrades`
- When a pending signal expires: push rejection with reason `'انقضای سیگنال'`

**Sharpe Ratio (`calculateSharpeRatio`):**
- Computes per-candle returns from equity curve
- `Sharpe = mean(return) / std(return) × sqrt(candlesPerYear)` (risk-free rate = 0)
- Annualization factor based on interval: 1m→525600, 5m→105120, 15m→35040, 30m→17520, 1h→8760, 4h→2190, 1d→365, 1w→52, etc.

**Reports (`buildReport`):**
- Overall: `initialCapital, finalCapital, netProfit, netProfitPercent, grossProfit, grossLoss, winRate, profitFactor, totalTrades, winningTrades, losingTrades, maxDrawdown, maxDrawdownPercent, sharpeRatio`
- Long: `totalLongTrades, winningLong, losingLong, longWinRate, longGrossProfit, longGrossLoss, longProfitFactor, longNetProfit`
- Short: `totalShortTrades, winningShort, losingShort, shortWinRate, shortGrossProfit, shortGrossLoss, shortProfitFactor, shortNetProfit`
- `equityCurve`: `[{timestamp, equity}]`
- `drawdownCurve`: `[{timestamp, drawdown}]`
- `trades`: array of full closed-position objects
- `rejectedTrades`: `[{id, signalId, timestamp, symbol, direction, rejectionReason, capitalBefore, math}]`
- `snapshots`: `[{timestamp, balance, equity, freeMargin, usedMargin, unrealizedPnl, realizedPnl, openPositions}]` (one per candle)
- `candles` and `signals` (raw, for chart rendering)

### `public/backtest.html` — full rewrite (~910 → ~1290 lines)

**New: TradingView-style candlestick chart** (`#candlestick-chart`, 560px tall, `dir="ltr"`):
- Two-grid ECharts layout: candlestick (top 62%) + volume bars (bottom 18%) sharing X axis
- Candlestick: green up bars, red down bars (Toobit/Binance convention)
- Volume bars: colored by candle direction (green up / red down)
- **Signal markers (markPoint):**
  - Long: green triangle pointing UP, placed below candle low
  - Short: red triangle pointing DOWN, placed above candle high
- **Entry markers (markPoint):** blue circle at entry price
- **Exit markers (markPoint):** diamond colored by PnL (green=profit, red=loss)
- **TP/SL lines (markLine):** horizontal dashed lines from entry candle to exit candle; TP=green, SL=red
- `dataZoom`: both `inside` (mouse wheel/touch) and `slider` (visible bottom slider) for pan/zoom; minValueSpan=20
- Tooltip: shows OHLC + change + volume + signal info (if candle has signal)
- Legend pills above chart: Long signal / Short signal / Entry / Exit / TP line / SL line

**Preserved from Task 20:**
- Glass-morphism dark theme, RTL Persian
- `auth-check.js` (in head before any other scripts)
- ECharts 5.4.3 CDN
- `init-settings.js` + `js/shared/signal-utils.js` + `js/backtest-engine.js`
- Nav with 6 links (backtest highlighted)
- Config form (symbol, initial capital, commission, slippage, run button)
- Status panel with loading spinner
- Summary cards (4): initial, final, net profit (color-coded), win rate
- Secondary stats (6): total trades, winning, losing, profit factor, max drawdown, **sharpe ratio (NEW)**
- Long/Short stats tables (side-by-side on lg, stacked on mobile) — **added `longNetProfit` / `shortNetProfit` row** (سود خالص)
- Equity curve chart (ECharts line with gradient area fill)
- Drawdown chart (ECharts area with red gradient)
- Trade history table (scrollable, max-h-96, 15 columns)
- Rejected trades table (collapsible, 7 columns)
- CSV export (now includes entryTimestamp, exitTimestamp, tp, sl, leverage, margin, qty, entryCommission, exitCommission, candleCount)
- Toast notifications
- Empty state placeholder

**Chart lifecycle:** Each chart instance is `dispose()`d before re-init on re-run (prevents memory leaks and stale options). Single resize handler attached to `window`.

## Verification

### Syntax & lint
- `node --check public/js/backtest-engine.js` → SYNTAX OK ✓
- Extracted inline JS from backtest.html via Python regex → `node --check` → INLINE JS SYNTAX OK ✓
- `bun run lint` → 0 errors, 2 pre-existing warnings in `src/lib/tradebot/database.js` (out of scope, unrelated — same warnings present in Task 19 & 20) ✓
- HTML tag balance (Python script): div=77/77, table=4/4, tbody=4/4, thead=2/2, tr=4/4, td=2/2, th=22/22, main=1/1, nav=1/1, select=1/1, button=2/2, span=15/15, a=6/6, h2=1/1, h3=7/7 — **all balanced** ✓

### HTTP
- `curl http://localhost:3000/backtest.html` → 200 ✓
- `curl http://localhost:3000/js/backtest-engine.js` → 200 ✓
- `curl http://localhost:3000/js/shared/signal-utils.js` → 200 ✓
- `curl http://localhost:3000/auth-check.js` → 200 ✓
- `curl http://localhost:3000/init-settings.js` → 200 ✓

### End-to-end test (Node.js with mocked browser globals)
Wrote a Node test that loads SignalUtils + BacktestEngine via `eval`, mocks `localStorage` and `document`, then runs the engine two ways:

**1. Synthetic data test (200 candles, sine wave + noise):**
- 4 signals generated, 2 trades opened (1 Long + 1 Short)
- Exit reasons seen: `['SL', 'TP', 'پایان داده']` ✓
- Rejection reasons seen: `['فاصله قیمت', 'انقضای سیگنال']` ✓ (signal expiration actually triggered via pending model!)
- Position object missing-field check: NONE ✓ (all 24 required fields present)
- equityCurve/drawdownCurve/snapshots: 200 points each (one per candle) ✓

**2. Real data test (DOT/USDT 1h, 1000 candles via /api/toobit-proxy):**
```
Candles: 1000, Signals: 5
Initial: 1000 USDT, Final: 992.17 USDT
Net Profit: -7.83 USDT (-0.78%)
Trades: 3 (W:1 L:2), Win Rate: 33.33%
Profit Factor: 0.63, Max DD: 3.47%, Sharpe: -0.702
Long: 2 trades, net -21.26 USDT, winRate 0.0%
Short: 1 trades, net 13.43 USDT, winRate 100.0%
Rejected: 2
Exit reasons: {"بستن پوزیشن مخالف":1, "SL":2}    ← close-opposite-positions WORKS!
Rejection reasons: {"انقضای سیگنال":2}              ← signal expiration WORKS!
Equity curve points: 1000
Snapshots points: 1000
Last snapshot: {balance:992.17, equity:992.17, freeMargin:992.17, usedMargin:0, unrealizedPnl:0, realizedPnl:-7.83, openPositions:0}
```
- Account state invariants hold: `balance = initialCapital + realizedPnl = 1000 + (-7.83) = 992.17` ✓
- `equity = balance + unrealizedPnl = 992.17 + 0 = 992.17` ✓
- `freeMargin = equity - usedMargin = 992.17 - 0 = 992.17` ✓
- 1 trade closed via `بستن پوزیشن مخالف` (close-opposite-positions logic triggered) ✓
- 2 rejections with `انقضای سیگنال` (pending signal expiration triggered) ✓

### Dev log
- `tail dev.log` shows only the pre-existing edge-runtime fs-module errors in `database.js` (unrelated — same warnings as Tasks 19 & 20)
- No new errors related to `backtest-engine.js` or `backtest.html`
- `/api/toobit-proxy?symbol=DOT-SWAP-USDT&interval=1h&limit=1000` returns 200 ✓

## Stage Summary

- ✅ **Event-driven timeline engine**: loops over candles (not signals), processes each candle as a discrete time step with the exact 8-step pipeline from the task spec
- ✅ **Full account state tracking**: `balance`, `equity`, `freeMargin`, `usedMargin`, `unrealizedPnl`, `realizedPnl` — all recomputed per candle and stored in `snapshots[]`
- ✅ **MT4/MT5-style accounting**: margin is "marked as used" (not deducted from balance); only entryCommission is deducted at open; `equity = balance + unrealizedPnl`, `freeMargin = equity - usedMargin`
- ✅ **Full position object** with all 24 required fields (id, symbol, direction, entryPrice, exitPrice, tp, sl, qty, margin, leverage, entryCandleIdx, entryTimestamp, entryCommission, exitCommission, pnl, pnlPercent, status, exitReason, exitCandleIdx, exitTimestamp, capitalBefore, capitalAfter, entryReason, candleCount, signal)
- ✅ **TP/SL checking** (pessimistic — SL first if both hit on same candle), runs BEFORE signal generation in each candle so a position that hits TP on candle X doesn't count as open when checking risk for a new signal on the same candle
- ✅ **Close opposite positions**: when a new signal conflicts with an open position on the same symbol, the opposite position is closed at current candle's close price (`exitReason = 'بستن پوزیشن مخالف'`) — verified end-to-end with real data
- ✅ **Pending signal + expiration model**: signal persists across candles if risk controls fail; expires after `signalExpirationHours` (uses CURRENT candle timestamp as "now") — verified end-to-end (2 expirations seen in real backtest)
- ✅ **All 6 risk controls** mirror `runCycle`: Safe Asset, Price Distance, Max Margin Per Symbol, Positive Margin, Min Same Direction Candles, Signal Expiration
- ✅ **Reports**: Overall + Long + Short stats with `netProfit` per direction; `sharpeRatio` (annualized); `equityCurve`, `drawdownCurve`, `tradeHistory`, `rejectedTrades`, `snapshots`
- ✅ **TradingView-style candlestick chart**: candlestick + volume (dual grid) + signal markers (Long up-arrow / Short down-arrow) + entry markers (blue circle) + exit markers (PnL-colored diamond) + TP/SL lines (green/red dashed horizontal segments) + dataZoom (inside + slider)
- ✅ **Equity curve + Drawdown charts** preserved from Task 20
- ✅ **Trade history table** with full position fields; **rejected trades table** (collapsible) with math tooltips; **CSV export** with extended columns
- ✅ **Sharpe ratio** stat card added (cyan, annualized)
- ✅ **Long/Short stats tables** now include `longNetProfit` / `shortNetProfit` (سود خالص) row
- ✅ Signal generation logic preserved verbatim (still pre-computes indicators AND signals, but consumes them inline during the candle loop — per task spec: "the simplest approach: pre-compute indicators AND signals (like current engine does), but then loop over CANDLES (not signals) and process signals as they occur at their candle index")
- ✅ Browser-only — no server-side state changes; only `/api/toobit-proxy` called for fetching candles; settings read from `localStorage 'automation_settings'` with `marketSignalSettings` as backward-compat fallback

## Notes for Future Agents

- **Accounting model**: balance INCLUDES margin (MT4/MT5 style). If you change to "margin deducted from balance" convention, you must update: `openPosition` (deduct margin), `closePosition` (return margin), `recomputeAccountState` (equity = balance + unrealizedPnl + usedMargin), and `checkRiskControls` Safe Asset check (use `balance - usedMargin` for freeBalance instead of `freeMargin`).
- **Pending signal model**: a signal that fails risk controls becomes `pendingSignal` and is retried on each subsequent candle until either (a) it opens, (b) it's replaced by a newer signal (old silently discarded + its rejection pushed), or (c) it expires. Only ONE rejection is recorded per signal (the most recent failure reason, or `'انقضای سیگنال'` on expiration, or `'پایان داده'` if still pending at end of data).
- **Signal Expiration actually triggers now** (unlike Task 20 where it used the signal's own timestamp as "now"). The `ctx.currentCandleTimestamp` is passed to `checkRiskControls`, so a pending signal aging past `signalExpirationHours` will be rejected.
- **Close opposite positions**: triggered when a NEW signal arrives (in step 5 of the candle loop) and there's an open position in the opposite direction on the same symbol. The opposite position is closed at the current candle's CLOSE price (not at TP/SL). After closing, the new signal's risk controls are checked normally.
- **TP/SL checking order**: TP/SL is checked BEFORE signal generation in each candle. This ensures a position that hits TP on candle X doesn't count as open when checking risk for a new signal on the same candle. Verified by spec section "CRITICAL".
- **Pessimistic SL-first**: if both TP and SL could hit on the same candle, SL is assumed to hit first (worst case for the trader). For Long: `if (candle.low <= sl) exit at sl; else if (candle.high >= tp) exit at tp`. For Short: `if (candle.high >= sl) exit at sl; else if (candle.low <= tp) exit at tp`.
- **Sharpe ratio annualization**: uses `sqrt(candlesPerYear)` multiplier. The candles-per-year map covers 1m through 1M. Default fallback is 8760 (1h) if interval is unrecognized.
- **Chart performance**: with 1000+ candles + many markPoints + many markLines, the chart can be slow to render. `animation: false` is set on the candlestick series, markPoint, and markLine to mitigate. `dataZoom` with `minValueSpan: 20` prevents over-zoom.
- **Memory management**: chart instances are `dispose()`d before re-init on each run. A single `window.resize` listener handles all three charts.
- **Trade history table**: now displays `entryTimestamp` (was `timestamp` in Task 20). The `exitReason` is mapped from short codes (`'TP'`, `'SL'`) to Persian labels for display (`'TP رسید'`, `'SL رسید'`); `'بستن پوزیشن مخالف'` and `'پایان داده'` pass through unchanged.
- **CSV export**: now exports 19 columns (was 9 in Task 20): entryTimestamp, exitTimestamp, symbol, direction, entryPrice, exitPrice, tp, sl, leverage, margin, qty, pnl, pnlPercent, entryCommission, exitCommission, exitReason, capitalBefore, capitalAfter, candleCount.
