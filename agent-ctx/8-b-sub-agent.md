# Task 8-b — Work Record

## Agent
Sub-agent (general-purpose)

## Task
Implement TWO features in the TradeBot project:
1. Feature 1: Min Same-Direction Candles Control (مورد ۶)
2. Feature 2: Global Closed Positions History (مورد ۸)

## Files Modified
- `/home/z/my-project/src/lib/tradebot/cycle-engine.ts` (server-side cycle engine)
- `/home/z/my-project/public/js/automation-manager.js` (client-side cycle engine)
- `/home/z/my-project/worklog.md` (work record appended)

## Files Created
- `/home/z/my-project/src/app/api/history-positions/route.ts` (new Edge API route)

## Implementation Summary

### Feature 1 (مورد ۶) — Min Same-Direction Candles Control
- Added `minSameDirectionCandles: number` and `closedPositionsNotifyCount: number` to AutomationSettings interface + defaults (0, 10) in cycle-engine.ts
- Added `candleIndex?: number` to Signal interface + added `candleIndex: i` to both Long/Short signal push sites in BOTH cycle-engine.ts and automation-manager.js
- New control block placed AFTER closeOppositePositions (step 8) and BEFORE refresh-history (step 9):
  - Skipped when `minSameDirectionCandles === 0`
  - If not enough candles after signal → REJECT (Bale notification + risk_blocked return)
  - If even one candle is opposite direction → REJECT (Bale notification with per-candle status + risk_blocked return)
  - Long needs GREEN candles (close > open), Short needs RED candles (close < open)
  - Uses existing `notifyRiskControlBlocked` helper (auto-selects '#کندل_هم‌جهت' hashtag from task 8-a)
- Mirrored in BOTH server-side (cycle-engine.ts) and client-side (automation-manager.js)

### Feature 2 (مورد ۸) — Global Closed Positions History
- Created `/home/z/my-project/src/app/api/history-positions/route.ts` (Edge runtime):
  - GET handler proxies Toobit's `/api/v1/futures/historyPositions` (no symbol → all symbols)
  - Reads API keys from headers (X-API-Key, X-Secret-Key, X-Base-Url)
  - Signs request with HMAC-SHA256 via `generateSignature` helper (Web Crypto / Edge-compatible)
  - Returns raw Toobit response
- Added new Step 0 at the very start of `runCycle()` in cycle-engine.ts (before symbols check, before step 1):
  - Wrapped entirely in try-catch (non-blocking — logs warning on failure, continues cycle)
  - Fetches closed positions via internal `/api/history-positions` route
  - Normalizes response (Array, {data:[...]}, {result:[...]}, or any object with array value)
  - Sorts by `closeTime` DESC (newest first)
  - Compares first record's `id` with `lastPositionId` stored in KV (AutomationState.get('lastPositionId'))
  - If different → sends Bale notification with last N records (N = `closedPositionsNotifyCount`, default 10) with Persian message format, then saves new id to KV
  - Bale message format: '📋 تاریخچه پوزیشن‌های بسته‌شده' + per-record line with ⭐ symbol, 🔵/🔴 direction icon, 💰 close price, 🕐 Jalali time + footer with event time + '#تاریخچه_بسته' hashtag
  - Persian numeral helper (۰-۹) used for index numbering

## Verification
- `bun run lint` → 0 errors (2 pre-existing warnings in database.js unrelated)
- `curl http://localhost:3000/api/history-positions` → HTTP 401 (correct — no API keys configured)
- `curl http://localhost:3000/` → HTTP 200 (page loads)
- `curl http://localhost:3000/automation.html` → HTTP 200 (automation page loads)
- `POST http://localhost:3000/api/run-cycle` → HTTP 200 with `no_ready_symbol` (cycle runs end-to-end; step 0 silently skips because no API keys in local dev KV, then symbols check returns early — expected)
- grep confirms step placement: Step 0 at line 472, symbols check at line 593, Step 1 at line 607, Step 8 at line 977, مورد ۶ control at line 1057, Step 9 at line 1166
- grep confirms `candleIndex: i` in 4 places (2 in cycle-engine.ts, 2 in automation-manager.js)
- grep confirms new settings fields in getDefaultAutomationSettings() and AutomationSettings interface

## Notes for Future Agents
- The new control only blocks position OPENING, not closing (matches task spec)
- Step 0 is non-blocking: any failure (network, API, JSON parse) is caught and logged as warning, cycle continues
- The `lastPositionId` KV key is set regardless of whether Bale notification succeeded (prevents re-notifying on every cycle if Bale is down)
- The /api/history-positions route uses headers-only (no KV fallback) to match open-positions pattern — initial KV fallback attempt caused noisy fs-module errors in local dev Edge runtime (database.js's loadFileDatabase tries import('fs') which fails in Edge)
- On first cycle (when lastPositionId not yet in KV), step 0 will send a notification with the latest N closed positions (initial sync) — this is the desired behavior
- The control's Bale notification uses the existing 2-arg `notifyRiskControlBlocked(controlName, math)` signature on server-side and 3-arg `notifyRiskControlBlocked(symbol, signal, controlDetails)` on client-side (existing patterns from task 8-a)
