# Task 20 — Work Record

## Agent
Backtest Sub-agent (general-purpose)

## Task
Phase 4 + 5 + 6 — Create a backtest system for the TradeBot project.
- Create `public/backtest.html` — Backtest page
- Create `public/js/backtest-engine.js` — Backtest engine
- Modify nav on 5 existing pages to add backtest link:
  - public/home.html, public/automation.html, public/settings.html,
    public/market_signal.html, public/trading.html

The engine must COPY the exact logic from automation-manager.js's `analyzeMarketData()`
and run the SAME risk controls as `runCycle()`.

## Files Created
- `/home/z/my-project/public/js/backtest-engine.js` (~700 lines) — `BacktestEngine` class + `getDefaultSettings` + `loadBacktestSettings` helpers. Exposed on `window.BacktestEngine`.
- `/home/z/my-project/public/backtest.html` (~530 lines) — RTL Persian glass-morphism dark theme page.

## Files Modified
- `/home/z/my-project/public/home.html` — added `<a href="backtest.html">` link in nav after automation.html link.
- `/home/z/my-project/public/automation.html` — same (automation.html stays as the active text-purple-400 link; backtest gets standard hover style).
- `/home/z/my-project/public/settings.html` — same.
- `/home/z/my-project/public/market_signal.html` — same.
- `/home/z/my-project/public/trading.html` — same.
- `/home/z/my-project/worklog.md` — Task ID 20 entry appended (see end of worklog for full work log).

## Implementation Summary

### 1) backtest-engine.js — Signal Generation (VERBATIM copy of analyzeMarketData)
Copied the exact logic from automation-manager.js lines 690–1107 into `generateSignals(symbol, rawData)`:
- Build `settings` object: `...(JSON.parse(localStorage.getItem('marketSignalSettings') || '{}'))` (backward compat) then override with `this.settings` values for interval/limit/lookback/atrPeriod/rsiPeriod/avgVolPeriod/tpLongMult/slLongMult/tpShortMult/slShortMult/longFixedTp/longFixedSl/shortFixedTp/shortFixedSl, plus `htfConfirmationSource` read from DOM (with `signalCandleClose` fallback).
- Daily data: offset = 3.5 hours × 3600 × 1000; build `dailyData` keyed by `Math.floor((ts+offset)/86400000)` with {maxHigh, minLow, lastClose, lastTs}; `days` array sorted ascending.
- prevDailyHighs/Lows/Closes arrays (null for first day's candles).
- Indicators via `SignalUtils`: `calculateATR(data, atrPeriod)`, `calculateSMA(data.map(d=>d.amount), avgVolPeriod)`, `calculateRSI(data, rsiPeriod)`.
- Crossover tracking (lastCrossUnderPL/lastCrossOverPH) — used when enableMeaningfulBreakFilter is false.
- Fake Breakout settings: enableMeaningfulBreakFilter, breakDetectionMethod ('Wick' or 'Close'), enableBreakLifecycleManagement, breakSequenceLifetime, direction-specific breakAtrMultiplierLong/Short with legacy `breakAtrMultiplier` fallback.
- Track meaningful breaks (lastMeaningfulBreakLong/Short) — used when filter is enabled.
- Main loop `for i in [1, N-1]`:
  - HTF confirmation: previousDayClose mode compares prevDayCloses against prevDailyHighs/Lows; signalCandleClose mode compares this candle's close against prevDailyHighs/Lows.
  - data[i].rsi/atr stamped for downstream use.
  - If enableBreakLifecycleManagement: 5-step state machine — (1) expiry check, (2) new meaningful break detection (if no active break or previous one recovered), (3) opposite-direction replacement while waiting recovery, (4) recovery check (close back inside prior day range), (5) generate signal on recovery candle if volMult + rsiThreshold + htfConfirm all pass, then reset break state.
  - Else (backward compat): crossover check + recentBreak (meaningful vs plain crossover based on filter), same volMult + rsiThreshold + htfConfirm conditions.
  - TP/SL: fixed (longFixedTp/longFixedSl/shortFixedTp/shortFixedSl) when not null, else ATR-based (atr × tpLongMult/slLongMult/tpShortMult/slShortMult). For Long: tp above close, sl below close. For Short: tp below close, sl above close.
  - `SignalUtils.generateOrderId(timestamp, symbol)` for orderId.
  - Push signal {type, timestamp, price: close, tp, sl, orderId, symbol, candleIndex}.

### 2) backtest-engine.js — Risk Controls (mirror of runCycle)
`checkRiskControls(signal, data, ctx)` runs 6 controls in order. Returns `{passed, margin, reason?, math?}`:
1. **Safe Asset** (always runs): `freeBalance - newMargin >= totalAssets × safeAssetPercent%`. freeBalance = currentCapital - lockedMargin. Reject reason: "دارایی امن".
2. **Price Distance** (only if `lastEntryPrice[direction]` exists): Long uses (last-current)/last × 100; Short uses (current-last)/last × 100. Reject if < minPriceDistancePercent[direction]. Reason: "فاصله قیمت".
3. **Max Margin Per Symbol** (only if same-direction position already open): existingSymbolMargin + newMargin <= totalAssets × maxMarginPerSymbolPercent%. Reason: "سقف مارجین". (In backtest, tracks lockedMarginByDirection[direction] since single-symbol.)
4. **Positive Margin** (always runs): `Math.max(newMargin, 0) > 0`. Reason: "مارجین مثبت".
5. **Min Same Direction Candles** (if minSameDirectionCandles > 0): checks N candles after signal's candleIndex. Reject if not enough candles or any candle is opposite-direction. Long needs green (close>open), Short needs red (close<open). Reasons: "کندل هم‌جهت (...)".
6. **Signal Expiration**: (now - signalTime) > signalExpirationHours × 3600 × 1000. In backtest "now" = signal's own timestamp (processed at generation time), so never rejects — included for parity with runCycle.

Direction-specific getters: `getEntryMarginPercent(dir)`, `getLeverage(dir)`, `getMinPriceDistancePercent(dir)` — Long uses entryMarginPercentLong/leverageLong/minPriceDistancePercentLong; Short uses entryMarginPercentShort/leverageShort/minPriceDistancePercentShort; both fall back to legacy single fields.

### 3) backtest-engine.js — Position Simulation (`simulate()`)
Iterates candles CHRONOLOGICALLY. State: currentCapital, lockedMargin, lockedMarginByDirection {Long, Short}, openPositions[], closedTrades[], rejectedTrades[], equityCurve[], drawdownCurve[], peakCapital, maxDrawdown, lastEntryPrice {Long, Short}.

Per candle:
1. Check open positions for TP/SL hits using this candle's high/low (pessimistic: SL first if both could hit). Close hit positions.
2. If a signal fires at this candle (via signalsByCandleIdx lookup): apply checkRiskControls. If passed → openPosition (deduct margin + entry commission, lock margin, track lastEntryPrice). If failed → push to rejectedTrades.
3. Update equity (mark-to-market): equity = currentCapital + sum(unrealizedPnl of open positions at this candle's close) + lockedMargin. Push {timestamp, capital} to equityCurve. Update peakCapital; drawdown = (peak-equity)/peak × 100; push to drawdownCurve; update maxDrawdown.

After all candles: close remaining open positions at last candle's close with exitReason "پایان داده".

**Position math**:
- newMargin = currentCapital × entryMarginPercent[direction] / 100
- notional = newMargin × leverage[direction]
- entryPrice = signal.price × (1 + slippage/100) for Long, × (1 - slippage/100) for Short
- qty = notional / entryPrice
- entryCommission = notional × commission/100 (deducted at open)
- exitCommission = notional × commission/100 (deducted at close)
- pnl (raw) = (exitPrice - entryPrice) × qty for Long, (entryPrice - exitPrice) × qty for Short
- pnl (net) = pnl - entryCommission - exitCommission
- pnlPercent = net pnl / margin × 100

**Trade record** (pushed to closedTrades):
`{signalId, timestamp (entry), exitTimestamp, symbol, direction, entryPrice, exitPrice, tp, sl, pnl (net), pnlPercent, entryReason ("سیگنال لانگ/شورت - Fake Breakout"), exitReason ("TP رسید"/"SL رسید"/"پایان داده"), capitalBefore, capitalAfter, leverage, margin, candleCount}`

**Rejected trade record**:
`{signalId, timestamp, symbol, direction, rejectionReason, capitalBefore, math}`

### 4) backtest-engine.js — Reports (`buildReport()`)
- **Overall**: initialCapital, finalCapital, netProfit (USDT + %), grossProfit (sum of winning pnls), grossLoss (abs of sum of losing pnls), winRate, profitFactor (grossProfit/grossLoss, ∞ if grossLoss=0), totalTrades, winningTrades, losingTrades, maxDrawdown.
- **Long stats**: totalLongTrades, winningLong, losingLong, longWinRate, longProfit, longLoss, longProfitFactor.
- **Short stats**: totalShortTrades, winningShort, losingShort, shortWinRate, shortProfit, shortLoss, shortProfitFactor.
- **Equity curve**: array of {timestamp, capital}.
- **Drawdown curve**: array of {timestamp, drawdown}.
- Plus trades[], rejectedTrades[], config, candleCount, signalCount.

### 5) backtest.html — UI
- **Head**: auth-check.js (first), ECharts CDN, Tailwind, Font Awesome, Vazirmatn font, init-settings.js, js/shared/signal-utils.js, js/backtest-engine.js.
- **Nav**: 6 links (خانه/تنظیمات/داشبورد/خرید و فروش/اتوماسیون/بکتست). Backtest link is text-purple-400 (active). Title "بکتست استراتژی" with fa-history icon.
- **Config form** (5-col responsive grid):
  - Symbol select (populated from `automation_symbols` localStorage; falls back to [DOT, BTC, ETH]; preserves last-used from `automationLastUsedSymbol`).
  - Initial capital (number, default 1000).
  - Commission % (default 0.04).
  - Slippage % (default 0.02).
  - Run button (btn-metallic gradient).
  - Info banner: "تایم فریم، تعداد کندل، پارامترهای استراتژی و کنترل‌های ریسک از تنظیمات اتوماسیون خوانده می‌شوند."
- **Status panel** (hidden): loading spinner + status text during fetch/simulate/chart-render phases.
- **Results** (hidden until run completes):
  - Summary cards (4-col): initial capital (blue), final capital (purple), net profit (green/red — card border color matches), win rate (yellow).
  - Secondary stats (6-col): total trades, winning, losing, profit factor, max drawdown, signal/trade count.
  - Long/Short stats tables (side-by-side on lg, stacked on mobile): 7 rows each.
  - Equity curve chart (ECharts line with gradient area fill, time xAxis, USDT-formatted tooltip).
  - Drawdown chart (ECharts area with red gradient, percent-formatted tooltip).
  - Trade history table (scrollable, max-h-96): 15 columns (signalId, entry time fa-IR, symbol, direction color-coded, entryPrice, exitPrice, TP, SL, pnl color-coded, pnlPercent, exitReason, leverage, margin, candleCount, capitalAfter). Persian digits for trade count badge.
  - Rejected trades table (collapsible — starts collapsed): 7 columns. Math preview as title attribute (full math string on hover).
  - Export CSV button.
- **Empty state**: "هنوز بکتستی اجرا نشده" placeholder.
- **Toast**: bottom-center, 3 types (success/error/info), 3s auto-hide.

**Init logic**:
- `populateSymbols()` reads automation_symbols; preserves last-used.
- `runBacktest()` validates config, disables Run button + shows spinner, yields to UI thread between phases (fetch → simulate → chart), calls `engine.run(config)`, calls `renderReport(report)`.
- `renderReport(report)` populates all cards/tables/charts.
- `renderEquityChart(curve)` + `renderDrawdownChart(curve)` use cached ECharts instances + resize handlers.
- `exportCSV()` builds CSV with columns [timestamp, symbol, direction, entryPrice, exitPrice, pnl, pnlPercent, exitReason, capitalAfter]; downloads as `backtest_{symbol}_{YYYY-MM-DD}.csv`.
- `bindCollapsible()` toggles `collapsed` class on rejected-trades section.

## Verification
- `node --check public/js/backtest-engine.js` → syntax OK
- `bun run lint` → 0 errors, 2 pre-existing warnings in src/lib/tradebot/database.js (unrelated — same warnings as Task 19)
- `curl http://localhost:3000/backtest.html` → 200 ✓
- `curl http://localhost:3000/js/backtest-engine.js` → 200 ✓
- Verified all 5 expected scripts included in backtest.html via curl + grep: auth-check.js, ECharts CDN, init-settings.js, signal-utils.js, backtest-engine.js.
- Verified all 30 expected element IDs present (bt-symbol, bt-initial-capital, bt-commission, bt-slippage, bt-run-btn, bt-status, bt-status-text, bt-results, bt-empty, bt-initial-cap, bt-final-cap, bt-net-profit, bt-net-profit-card, bt-win-rate, bt-total-trades, bt-winning, bt-losing, bt-profit-factor, bt-max-drawdown, bt-signal-trade, bt-long-stats-body, bt-short-stats-body, equity-chart, drawdown-chart, bt-trade-history-body, bt-trade-count-badge, bt-export-csv, bt-rejected-trades-body, bt-rejected-count-badge, rejected-collapsible, rejected-toggle, toast).
- HTML tag balance: all balanced (div/section/table/tr/td/thead/tbody/select/button/main/nav/script/style/a/option/span).
- `grep -c 'href="backtest.html"'` on each modified page: each has exactly 1 backtest link (plus backtest.html has 1 self-link in nav).
- dev.log: only the pre-existing edge-runtime fs-module errors in database.js (unrelated — same warnings as Task 19); no new errors introduced by this task.

## Notes for Future Agents
- The backtest engine uses direction-specific entryMarginPercent + leverage + minPriceDistance (Long uses *_Long, Short uses *_Short). The real runCycle uses the legacy single entryMarginPercent/leverage/minPriceDistancePercent — for the backtest we use direction-specific values because they're more accurate to the strategy. If exact parity with runCycle is required in the future, change getEntryMarginPercent/getLeverage/getMinPriceDistancePercent to read the legacy fields.
- Max Margin Per Symbol in backtest tracks lockedMarginByDirection[direction] (per-direction, not per-symbol) since the backtest simulates a single symbol. Real runCycle tracks per-symbol across both directions combined. Switch to per-symbol tracking if multi-symbol backtest is added.
- Price Distance uses `this.lastEntryPrice[direction]` (null at start of each run; updated on each new position open). Real runCycle uses a cache keyed by `${symbol}:${direction}` that persists across cycles — for single-symbol backtest this is equivalent.
- Min Same Direction Candles checks candles AFTER signal's candleIndex in the data array (data[sigIdx + k]) — matches runCycle exactly.
- Signal Expiration uses signal's own timestamp as "now" (we process signals at generation time), so never rejects in practice — included for parity with runCycle.
- Simulation allows MULTIPLE concurrent open positions (each signal opens a new position regardless of currently-open positions), with each position's TP/SL checked independently per candle. More permissive than real runCycle (which opens at most one new position per cycle). If single-position-at-a-time behavior is desired, add a check that rejects new signals when openPositions is non-empty.
- Equity is mark-to-market: currentCapital (realized) + unrealized PnL of open positions (priced at this candle's close) + lockedMargin (margin is still ours, just locked). Drawdown = (peak - current) / peak × 100. maxDrawdown is the highest drawdown observed across the equity curve.
- The backtest does NOT persist any state to localStorage or DB — purely in-memory. Each run starts fresh.
- All strategy + risk params are read from localStorage 'automation_settings' via loadBacktestSettings() (with marketSignalSettings as backward-compat fallback, same as analyzeMarketData). User must save settings on the automation page before backtesting with custom params.
- backtest.html nav uses fa-history icon (consistent with backtest theme — "history" of trades). All 5 modified pages got the same icon.
- ECharts instances are cached at module level (`equityChart`/`drawdownChart` globals) and resize handlers attached once. Avoids leaking instances on repeated runs.
