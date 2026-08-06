/**
 * Backtest Engine — Event-Driven Timeline (Task 21 rewrite)
 * =========================================================
 *
 * ARCHITECTURE
 * ------------
 * Previous engine was "Signal-Driven" (looped over a pre-computed list of
 * signals). This rewrite is "Event-Driven": it loops over CANDLES, processing
 * each candle as a discrete time step.
 *
 * Per-candle processing order (matches task spec):
 *   1. Receive new candle (timestamp, OHLCV)
 *   2. Update market price for all open positions (mark-to-market)
 *   3. Check TP/SL for all open positions using this candle's high/low
 *   4. Close positions that hit TP or SL
 *      - Calculate realized PnL, free up margin, update balance
 *   5. Check signal expiration for pending signal (if any)
 *   6. Try to consume pending signal (if any) via risk controls
 *   7. Generate new signal based on this candle (using same analyzeMarketData
 *      logic — pre-computed signals are looked up by candleIndex for parity)
 *      - If new signal generated:
 *        a. Check all risk controls (Safe Asset, Price Distance, Max Margin,
 *           Positive Margin, Min Same Direction Candles, Signal Expiration)
 *        b. If signal direction conflicts with an open position on the same
 *           symbol → close the opposite position first
 *        c. If all checks pass → open new position
 *           - Deduct margin from free balance (mark as used)
 *           - Apply entry commission
 *   8. Record snapshot:
 *      { timestamp, balance, equity, freeMargin, usedMargin,
 *        unrealizedPnl, realizedPnl, openPositions }
 *   9. Move to next candle
 *
 * ACCOUNTING MODEL (MT4/MT5-style)
 * --------------------------------
 *   balance       = realized cash (includes margin that's "marked as used";
 *                   only entryCommission is deducted at open)
 *   At open       : balance -= entryCommission ; usedMargin += margin
 *   At close      : balance += pnl - exitCommission ; usedMargin -= margin
 *   unrealizedPnl = sum of unrealized PnL of open positions (mark-to-market)
 *   realizedPnl   = cumulative net PnL of closed trades (after commissions)
 *   equity        = balance + unrealizedPnl
 *   freeMargin    = equity - usedMargin
 *
 * DEPENDENCIES (must be loaded BEFORE this file):
 *   - /js/shared/signal-utils.js  (window.SignalUtils)
 *
 * SETTINGS:
 *   - Read from localStorage.getItem('automation_settings') (same as automation page)
 *   - Falls back to defaults if missing
 *
 * Browser-only — no server-side state changes.
 */

// ==================== Default Settings (mirror of automation-manager.js) ====================

function getDefaultSettings() {
    return {
        safeAssetPercent: 50,
        maxMarginPerSymbolPercent: 10,
        tradeWaitTime: 60,
        allowedErrors: 3,
        signalExpirationHours: 6,
        minSameDirectionCandles: 0,
        cyclesPerRun: 1,
        closedPositionsNotifyCount: 10,
        // Fake Breakout
        enableMeaningfulBreakFilter: true,
        breakDetectionMethod: 'Wick',
        enableBreakLifecycleManagement: true,
        breakSequenceLifetime: 0,
        // Long/Short independent params
        rsiLongThreshold: 30,
        rsiShortThreshold: 70,
        volMultLong: 0.2,
        volMultShort: 0.2,
        leverageLong: 4,
        leverageShort: 4,
        breakAtrMultiplierLong: 0.20,
        breakAtrMultiplierShort: 0.20,
        entryMarginPercentLong: 5,
        entryMarginPercentShort: 5,
        minPriceDistancePercentLong: 0.5,
        minPriceDistancePercentShort: 0.5,
        // Legacy fallback
        entryMarginPercent: 5,
        minPriceDistancePercent: 0.5,
        leverage: 4,
        breakAtrMultiplier: 0.20,
        // Market params
        interval: '1h',
        limit: 1000,
        lookback: 50,
        // Indicator params
        atrPeriod: 14,
        rsiPeriod: 14,
        avgVolPeriod: 50,
        // TP/SL multipliers
        tpLongMult: 20,
        slLongMult: 6,
        tpShortMult: 24,
        slShortMult: 4,
        // Fixed TP/SL (null = ATR-based)
        longFixedTp: null,
        longFixedSl: null,
        shortFixedTp: null,
        shortFixedSl: 6
    };
}

function loadBacktestSettings() {
    const defaults = getDefaultSettings();
    const saved = localStorage.getItem('automation_settings');
    if (!saved) return defaults;
    try {
        return { ...defaults, ...JSON.parse(saved) };
    } catch (e) {
        return defaults;
    }
}

// ==================== Backtest Engine (Event-Driven) ====================

class BacktestEngine {
    /**
     * @param {Object} settings  - automation_settings (use loadBacktestSettings())
     */
    constructor(settings) {
        this.settings = settings || getDefaultSettings();
        // Per-direction last-entry-price cache (used by Price Distance control)
        this.lastEntryPrice = { Long: null, Short: null };
    }

    /**
     * Fetch historical candle data from /api/toobit-proxy.
     * @param {string} symbol   - e.g. 'DOT'
     * @param {string} interval - e.g. '1h'
     * @param {number} limit    - e.g. 1000
     * @returns {Promise<Array>} Raw klines array (array of arrays)
     */
    async fetchCandles(symbol, interval, limit) {
        const fullSymbol = `${symbol}-SWAP-USDT`;
        const url = `/api/toobit-proxy?symbol=${encodeURIComponent(fullSymbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`);
        }
        const rawData = await response.json();
        if (!Array.isArray(rawData)) {
            throw new Error('داده‌های دریافتی آرایه نیست');
        }
        if (rawData.length === 0) {
            throw new Error('هیچ داده‌ای دریافت نشد');
        }
        if (!Array.isArray(rawData[0])) {
            throw new Error('فرمت داده نادرست است - باید آرایه‌ای از آرایه‌ها باشد');
        }
        return rawData;
    }

    // ==================== Signal Generation (verbatim copy of analyzeMarketData) ====================

    /**
     * Pre-compute indicators AND signals from candle data.
     * COPIES the EXACT analyzeMarketData() logic from automation-manager.js.
     *
     * NOTE: Pre-computing signals is OK per the task spec ("the simplest approach:
     * pre-compute indicators AND signals (like current engine does), but then
     * loop over CANDLES (not signals)"). The signal generation logic only
     * depends on candle data UP TO the signal's candle index, so pre-computing
     * gives the same result as inline generation. The signal CONSUMPTION
     * (risk controls, position opening) happens inline in the candle loop.
     *
     * @param {string} symbol
     * @param {Array}  rawData  - raw klines array
     * @returns {Object} { data, signals } — data is the per-candle array with
     *   signal/tp/sl/rsi/atr fields stamped per candle, signals is the array
     *   of generated signals (each tagged with candleIndex).
     */
    generateSignals(symbol, rawData) {
        // Build the settings object exactly like analyzeMarketData does:
        //   spread marketSignalSettings (backward compat) then override with
        //   this.settings values (canonical source post-Task-19).
        const settings = {
            ...(JSON.parse(localStorage.getItem('marketSignalSettings') || '{}')),
            interval: this.settings.interval || '1h',
            limit: this.settings.limit || 1000,
            lookback: this.settings.lookback || 50,
            atrPeriod: this.settings.atrPeriod || 14,
            rsiPeriod: this.settings.rsiPeriod || 14,
            avgVolPeriod: this.settings.avgVolPeriod || 50,
            tpLongMult: this.settings.tpLongMult || 20,
            slLongMult: this.settings.slLongMult || 6,
            tpShortMult: this.settings.tpShortMult || 24,
            slShortMult: this.settings.slShortMult || 4,
            longFixedTp: this.settings.longFixedTp,
            longFixedSl: this.settings.longFixedSl,
            shortFixedTp: this.settings.shortFixedTp,
            shortFixedSl: this.settings.shortFixedSl,
            htfConfirmationSource:
                (typeof document !== 'undefined'
                    && document.getElementById('htf-confirmation-source')
                    && document.getElementById('htf-confirmation-source').value)
                || 'signalCandleClose'
        };
        const autoSettings = this.settings || {};
        const N = rawData.length;

        // Convert raw klines to candle objects
        const data = rawData.map(c => ({
            timestamp: new Date(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            amount: parseFloat(c[5])
        }));

        // ---- Daily data (offset 3.5 hours for Tehran) ----
        const offset = 3.5 * 3600 * 1000;
        const dailyData = {};
        for (let i = 0; i < N; i++) {
            const localTs = data[i].timestamp.getTime() + offset;
            const day = Math.floor(localTs / 86400000);
            if (!dailyData[day]) {
                dailyData[day] = {
                    maxHigh: -Infinity,
                    minLow: Infinity,
                    lastClose: 0,
                    lastTs: -Infinity
                };
            }
            dailyData[day].maxHigh = Math.max(dailyData[day].maxHigh, data[i].high);
            dailyData[day].minLow = Math.min(dailyData[day].minLow, data[i].low);
            if (localTs > dailyData[day].lastTs) {
                dailyData[day].lastTs = localTs;
                dailyData[day].lastClose = data[i].close;
            }
        }

        const days = Object.keys(dailyData).sort((a, b) => a - b).map(Number);

        const prevDailyHighs = [];
        const prevDailyLows = [];
        const prevDayCloses = [];
        for (let i = 0; i < N; i++) {
            const localTs = data[i].timestamp.getTime() + offset;
            const day = Math.floor(localTs / 86400000);
            const prevDayIndex = days.indexOf(day) - 1;
            if (prevDayIndex >= 0) {
                const prevDay = days[prevDayIndex];
                prevDailyHighs.push(dailyData[prevDay].maxHigh);
                prevDailyLows.push(dailyData[prevDay].minLow);
                prevDayCloses.push(dailyData[prevDay].lastClose);
            } else {
                prevDailyHighs.push(null);
                prevDailyLows.push(null);
                prevDayCloses.push(null);
            }
        }

        // ---- Indicators ----
        const atr = SignalUtils.calculateATR(data, settings.atrPeriod || 14);
        const avgVols = SignalUtils.calculateSMA(data.map(d => d.amount), settings.avgVolPeriod || 50);
        const rsi = SignalUtils.calculateRSI(data, settings.rsiPeriod || 14);

        // ---- Crossover tracking (kept for backward compatibility — used when filters are disabled) ----
        let lastUL = null, lastOH = null;
        const lastCrossUnderPL = new Array(N).fill(Infinity);
        const lastCrossOverPH = new Array(N).fill(Infinity);
        for (let i = 1; i < N; i++) {
            if (data[i].close < prevDailyLows[i] && data[i - 1].close >= prevDailyLows[i - 1]) lastUL = i;
            if (data[i].close > prevDailyHighs[i] && data[i - 1].close <= prevDailyHighs[i - 1]) lastOH = i;
            lastCrossUnderPL[i] = lastUL === null ? Infinity : i - lastUL;
            lastCrossOverPH[i] = lastOH === null ? Infinity : i - lastOH;
        }

        // ---- Fake Breakout settings ----
        const fbSettings = this.settings || {};
        const enableMeaningfulBreakFilter = fbSettings.enableMeaningfulBreakFilter !== false;
        const breakAtrMultiplierLong =
            (fbSettings.breakAtrMultiplierLong !== undefined && fbSettings.breakAtrMultiplierLong !== null)
                ? fbSettings.breakAtrMultiplierLong
                : ((fbSettings.breakAtrMultiplier !== undefined && fbSettings.breakAtrMultiplier !== null)
                    ? fbSettings.breakAtrMultiplier : 0.20);
        const breakAtrMultiplierShort =
            (fbSettings.breakAtrMultiplierShort !== undefined && fbSettings.breakAtrMultiplierShort !== null)
                ? fbSettings.breakAtrMultiplierShort
                : ((fbSettings.breakAtrMultiplier !== undefined && fbSettings.breakAtrMultiplier !== null)
                    ? fbSettings.breakAtrMultiplier : 0.20);
        const breakDetectionMethod = fbSettings.breakDetectionMethod === 'Close' ? 'Close' : 'Wick';
        const enableBreakLifecycleManagement = fbSettings.enableBreakLifecycleManagement !== false;
        const breakSequenceLifetime =
            (fbSettings.breakSequenceLifetime !== undefined && fbSettings.breakSequenceLifetime !== null)
                ? fbSettings.breakSequenceLifetime : 0;

        // ---- Track meaningful breaks (used when enableMeaningfulBreakFilter is true) ----
        const lastMeaningfulBreakLong = new Array(N).fill(Infinity);
        const lastMeaningfulBreakShort = new Array(N).fill(Infinity);
        {
            let lastMBL = null, lastMBS = null;
            for (let i = 1; i < N; i++) {
                const bdLong = (atr[i] || 0) * breakAtrMultiplierLong;
                const bdShort = (atr[i] || 0) * breakAtrMultiplierShort;
                let mbl = false, mbs = false;
                if (breakDetectionMethod === 'Wick') {
                    mbl = prevDailyLows[i] !== null && data[i].low <= (prevDailyLows[i] - bdLong);
                    mbs = prevDailyHighs[i] !== null && data[i].high >= (prevDailyHighs[i] + bdShort);
                } else {
                    mbl = prevDailyLows[i] !== null && data[i].close <= (prevDailyLows[i] - bdLong);
                    mbs = prevDailyHighs[i] !== null && data[i].close >= (prevDailyHighs[i] + bdShort);
                }
                if (mbl) lastMBL = i;
                if (mbs) lastMBS = i;
                lastMeaningfulBreakLong[i] = lastMBL === null ? Infinity : i - lastMBL;
                lastMeaningfulBreakShort[i] = lastMBS === null ? Infinity : i - lastMBS;
            }
        }

        // ---- Generate signals (pre-computed; consumed inline during candle loop) ----
        const signals = [];
        const htfSource = settings.htfConfirmationSource || 'signalCandleClose';

        // Break Lifecycle state machine
        const resetBreakState = () => ({
            active: false,
            type: null,
            breakCandleIndex: null,
            waitingRecovery: false,
            recovered: false,
            recoveryCandleIndex: null
        });
        let breakState = resetBreakState();

        for (let i = 1; i < N - 1; i++) {
            // HTF confirmation
            let htfConfirmLong, htfConfirmShort;
            if (htfSource === 'previousDayClose') {
                htfConfirmLong = prevDayCloses[i] !== null && prevDayCloses[i] > prevDailyLows[i];
                htfConfirmShort = prevDayCloses[i] !== null && prevDayCloses[i] < prevDailyHighs[i];
            } else {
                htfConfirmLong = prevDailyLows[i] !== null && data[i].close > prevDailyLows[i];
                htfConfirmShort = prevDailyHighs[i] !== null && data[i].close < prevDailyHighs[i];
            }

            data[i].rsi = rsi[i];
            data[i].atr = atr[i];

            if (enableBreakLifecycleManagement) {
                // ===== Break Lifecycle Management state machine =====
                const breakDistanceLong = (atr[i] || 0) * breakAtrMultiplierLong;
                const breakDistanceShort = (atr[i] || 0) * breakAtrMultiplierShort;
                let isMeaningfulBreakLong = false;
                let isMeaningfulBreakShort = false;
                if (breakDetectionMethod === 'Wick') {
                    isMeaningfulBreakLong =
                        prevDailyLows[i] !== null && data[i].low <= (prevDailyLows[i] - breakDistanceLong);
                    isMeaningfulBreakShort =
                        prevDailyHighs[i] !== null && data[i].high >= (prevDailyHighs[i] + breakDistanceShort);
                } else {
                    isMeaningfulBreakLong =
                        prevDailyLows[i] !== null && data[i].close <= (prevDailyLows[i] - breakDistanceLong);
                    isMeaningfulBreakShort =
                        prevDailyHighs[i] !== null && data[i].close >= (prevDailyHighs[i] + breakDistanceShort);
                }

                // 1. Check expiry
                if (breakState.active && !breakState.recovered && breakState.breakCandleIndex !== null) {
                    const lifetime = breakSequenceLifetime > 0 ? breakSequenceLifetime : (settings.lookback || 50);
                    if (i - breakState.breakCandleIndex > lifetime) {
                        breakState = resetBreakState();
                    }
                }

                // 2. Check for new meaningful break (only if no active break, or previous one recovered/consumed)
                if (!breakState.active || breakState.recovered) {
                    if (isMeaningfulBreakLong) {
                        breakState = {
                            active: true, type: 'Long', breakCandleIndex: i,
                            waitingRecovery: true, recovered: false, recoveryCandleIndex: null
                        };
                    } else if (isMeaningfulBreakShort) {
                        breakState = {
                            active: true, type: 'Short', breakCandleIndex: i,
                            waitingRecovery: true, recovered: false, recoveryCandleIndex: null
                        };
                    }
                }

                // 3. Check for new break while waiting recovery (replace old break if OPPOSITE direction)
                if (breakState.active && !breakState.recovered) {
                    if (breakState.type === 'Long' && isMeaningfulBreakShort) {
                        breakState = {
                            active: true, type: 'Short', breakCandleIndex: i,
                            waitingRecovery: true, recovered: false, recoveryCandleIndex: null
                        };
                    } else if (breakState.type === 'Short' && isMeaningfulBreakLong) {
                        breakState = {
                            active: true, type: 'Long', breakCandleIndex: i,
                            waitingRecovery: true, recovered: false, recoveryCandleIndex: null
                        };
                    }
                }

                // 4. Check recovery — price closes back inside the prior day range
                if (breakState.active && breakState.waitingRecovery) {
                    if (breakState.type === 'Long') {
                        if (data[i].close > prevDailyLows[i]) {
                            breakState.recovered = true;
                            breakState.recoveryCandleIndex = i;
                            breakState.waitingRecovery = false;
                        }
                    } else if (breakState.type === 'Short') {
                        if (data[i].close < prevDailyHighs[i]) {
                            breakState.recovered = true;
                            breakState.recoveryCandleIndex = i;
                            breakState.waitingRecovery = false;
                        }
                    }
                }

                // 5. Generate signal ONLY if recovered, on the recovery candle
                if (breakState.recovered && breakState.recoveryCandleIndex === i) {
                    if (breakState.type === 'Long') {
                        const condLong = avgVols[i] !== null
                            && data[i].amount > avgVols[i] * (autoSettings.volMultLong ?? settings.volMult ?? 0.2)
                            && rsi[i] !== null
                            && rsi[i] < (autoSettings.rsiLongThreshold ?? settings.rsiThreshold ?? 30)
                            && htfConfirmLong;

                        if (condLong) {
                            data[i].signal = 'Long';
                            if (settings.longFixedTp !== null && !isNaN(settings.longFixedTp)) {
                                data[i].tp = data[i].close + (data[i].close * (settings.longFixedTp / 100));
                            } else {
                                data[i].tp = data[i].close + (atr[i] * (settings.tpLongMult || 20));
                            }
                            if (settings.longFixedSl !== null && !isNaN(settings.longFixedSl)) {
                                data[i].sl = data[i].close - (data[i].close * (settings.longFixedSl / 100));
                            } else {
                                data[i].sl = data[i].close - (atr[i] * (settings.slLongMult || 6));
                            }
                            data[i].clientOrderId = SignalUtils.generateOrderId(data[i].timestamp, symbol);
                            signals.push({
                                type: 'Long',
                                timestamp: data[i].timestamp,
                                price: data[i].close,
                                tp: data[i].tp,
                                sl: data[i].sl,
                                orderId: data[i].clientOrderId,
                                symbol: symbol,
                                candleIndex: i
                            });
                        }
                    } else if (breakState.type === 'Short') {
                        const condShort = avgVols[i] !== null
                            && data[i].amount > avgVols[i] * (autoSettings.volMultShort ?? settings.volMult ?? 0.2)
                            && rsi[i] !== null
                            && rsi[i] > (autoSettings.rsiShortThreshold ?? settings.rsiThreshold ?? 70)
                            && htfConfirmShort;

                        if (condShort) {
                            data[i].signal = 'Short';
                            if (settings.shortFixedTp !== null && !isNaN(settings.shortFixedTp)) {
                                data[i].tp = data[i].close - (data[i].close * (settings.shortFixedTp / 100));
                            } else {
                                data[i].tp = data[i].close - (atr[i] * (settings.tpShortMult || 24));
                            }
                            if (settings.shortFixedSl !== null && !isNaN(settings.shortFixedSl)) {
                                data[i].sl = data[i].close + (data[i].close * (settings.shortFixedSl / 100));
                            } else {
                                data[i].sl = data[i].close + (atr[i] * (settings.slShortMult || 4));
                            }
                            data[i].clientOrderId = SignalUtils.generateOrderId(data[i].timestamp, symbol);
                            signals.push({
                                type: 'Short',
                                timestamp: data[i].timestamp,
                                price: data[i].close,
                                tp: data[i].tp,
                                sl: data[i].sl,
                                orderId: data[i].clientOrderId,
                                symbol: symbol,
                                candleIndex: i
                            });
                        }
                    }

                    // Reset after signal generation (break is consumed whether or not signal was generated)
                    breakState = resetBreakState();
                }
            } else {
                // ===== Backward compatible: original logic with optional meaningful break filter =====
                const isCrossOverPL =
                    data[i].close > prevDailyLows[i] && data[i - 1].close <= prevDailyLows[i - 1];
                const isCrossUnderPH =
                    data[i].close < prevDailyHighs[i] && data[i - 1].close >= prevDailyHighs[i - 1];

                const recentBreakLong = enableMeaningfulBreakFilter
                    ? lastMeaningfulBreakLong[i]
                    : lastCrossUnderPL[i];
                const recentBreakShort = enableMeaningfulBreakFilter
                    ? lastMeaningfulBreakShort[i]
                    : lastCrossOverPH[i];

                const condLong = isCrossOverPL
                    && recentBreakLong <= (settings.lookback || 50)
                    && avgVols[i] !== null
                    && data[i].amount > avgVols[i] * (autoSettings.volMultLong ?? settings.volMult ?? 0.2)
                    && rsi[i] !== null
                    && rsi[i] < (autoSettings.rsiLongThreshold ?? settings.rsiThreshold ?? 30)
                    && htfConfirmLong;

                const condShort = isCrossUnderPH
                    && recentBreakShort <= (settings.lookback || 50)
                    && avgVols[i] !== null
                    && data[i].amount > avgVols[i] * (autoSettings.volMultShort ?? settings.volMult ?? 0.2)
                    && rsi[i] !== null
                    && rsi[i] > (autoSettings.rsiShortThreshold ?? settings.rsiThreshold ?? 70)
                    && htfConfirmShort;

                if (condLong) {
                    data[i].signal = 'Long';
                    if (settings.longFixedTp !== null && !isNaN(settings.longFixedTp)) {
                        data[i].tp = data[i].close + (data[i].close * (settings.longFixedTp / 100));
                    } else {
                        data[i].tp = data[i].close + (atr[i] * (settings.tpLongMult || 20));
                    }
                    if (settings.longFixedSl !== null && !isNaN(settings.longFixedSl)) {
                        data[i].sl = data[i].close - (data[i].close * (settings.longFixedSl / 100));
                    } else {
                        data[i].sl = data[i].close - (atr[i] * (settings.slLongMult || 6));
                    }
                    data[i].clientOrderId = SignalUtils.generateOrderId(data[i].timestamp, symbol);
                    signals.push({
                        type: 'Long',
                        timestamp: data[i].timestamp,
                        price: data[i].close,
                        tp: data[i].tp,
                        sl: data[i].sl,
                        orderId: data[i].clientOrderId,
                        symbol: symbol,
                        candleIndex: i
                    });
                } else if (condShort) {
                    data[i].signal = 'Short';
                    if (settings.shortFixedTp !== null && !isNaN(settings.shortFixedTp)) {
                        data[i].tp = data[i].close - (data[i].close * (settings.shortFixedTp / 100));
                    } else {
                        data[i].tp = data[i].close - (atr[i] * (settings.tpShortMult || 24));
                    }
                    if (settings.shortFixedSl !== null && !isNaN(settings.shortFixedSl)) {
                        data[i].sl = data[i].close + (data[i].close * (settings.shortFixedSl / 100));
                    } else {
                        data[i].sl = data[i].close + (atr[i] * (settings.slShortMult || 4));
                    }
                    data[i].clientOrderId = SignalUtils.generateOrderId(data[i].timestamp, symbol);
                    signals.push({
                        type: 'Short',
                        timestamp: data[i].timestamp,
                        price: data[i].close,
                        tp: data[i].tp,
                        sl: data[i].sl,
                        orderId: data[i].clientOrderId,
                        symbol: symbol,
                        candleIndex: i
                    });
                }
            }
        }

        return { data, signals };
    }

    // ==================== Risk Controls (mirror of runCycle) ====================

    /**
     * Direction-specific entry margin percent (Long uses entryMarginPercentLong, etc.)
     * Falls back to legacy entryMarginPercent.
     */
    getEntryMarginPercent(direction) {
        if (direction === 'Long') {
            return (this.settings.entryMarginPercentLong ?? this.settings.entryMarginPercent ?? 5);
        }
        return (this.settings.entryMarginPercentShort ?? this.settings.entryMarginPercent ?? 5);
    }

    getLeverage(direction) {
        if (direction === 'Long') {
            return (this.settings.leverageLong ?? this.settings.leverage ?? 4);
        }
        return (this.settings.leverageShort ?? this.settings.leverage ?? 4);
    }

    getMinPriceDistancePercent(direction) {
        if (direction === 'Long') {
            return (this.settings.minPriceDistancePercentLong ?? this.settings.minPriceDistancePercent ?? 0.5);
        }
        return (this.settings.minPriceDistancePercentShort ?? this.settings.minPriceDistancePercent ?? 0.5);
    }

    /**
     * Run all risk controls for a candidate signal. Returns { passed, reason, math, margin }.
     * Mirrors runCycle's controls: Safe Asset, Price Distance, Max Margin,
     * Positive Margin, Min Same Direction Candles, Signal Expiration.
     *
     * @param {Object} signal              - the candidate signal
     * @param {Array}  data                - per-candle data array (for Min Same Direction Candles)
     * @param {Object} account             - account state snapshot:
     *   { balance, equity, usedMargin, freeMargin, unrealizedPnl, realizedPnl }
     * @param {Object} ctx                 - per-direction context:
     *   { usedMarginByDirection, lastEntryPrice, currentCandleTimestamp }
     */
    checkRiskControls(signal, data, account, ctx) {
        const direction = signal.type; // 'Long' | 'Short'
        const totalAssets = account.balance; // realized cash (MT4/MT5-style; includes locked margin)
        // freeBalance (available cash for new margin) = balance - usedMargin (== freeMargin when unrealizedPnl=0)
        // The spec uses "free balance" loosely; in MT4/MT5 free margin = equity - usedMargin.
        // For Safe Asset check we use freeMargin (== equity - usedMargin).
        const freeBalance = account.freeMargin;
        const newMargin = totalAssets * (this.getEntryMarginPercent(direction) / 100);

        // 1. Safe Asset Check (always runs)
        const safeAmount = totalAssets * (this.settings.safeAssetPercent / 100);
        const projectedFree = freeBalance - newMargin;
        if (projectedFree < safeAmount) {
            return {
                passed: false,
                reason: 'دارایی امن',
                margin: newMargin,
                math:
                    `کل دارایی = ${totalAssets.toFixed(4)} USDT\n` +
                    `موجودی آزاد = ${freeBalance.toFixed(4)} USDT\n` +
                    `مارجین ورودی جدید = ${newMargin.toFixed(4)} USDT\n` +
                    `درصد دارایی امن = ${this.settings.safeAssetPercent}%\n` +
                    `دارایی امن = ${totalAssets.toFixed(4)} × ${this.settings.safeAssetPercent}% = ${safeAmount.toFixed(4)} USDT\n` +
                    `موجودی آزاد پیش‌بینی‌شده = ${freeBalance.toFixed(4)} - ${newMargin.toFixed(4)} = ${projectedFree.toFixed(4)} USDT\n` +
                    `${projectedFree.toFixed(4)} < ${safeAmount.toFixed(4)} ✗`
            };
        }

        // 2. Price Distance Check (only if same-direction position already open for this symbol)
        const lastEntry = ctx.lastEntryPrice[direction];
        if (lastEntry !== null && lastEntry !== undefined) {
            const currentPrice = signal.price;
            let distancePercent;
            if (direction === 'Long') {
                distancePercent = ((lastEntry - currentPrice) / lastEntry) * 100;
            } else {
                distancePercent = ((currentPrice - lastEntry) / lastEntry) * 100;
            }
            const minDist = this.getMinPriceDistancePercent(direction);
            if (distancePercent < minDist) {
                return {
                    passed: false,
                    reason: 'فاصله قیمت',
                    margin: newMargin,
                    math:
                        `آخرین قیمت ورود هم‌جهت = ${lastEntry}\n` +
                        `قیمت فعلی = ${currentPrice}\n` +
                        `جهت سیگنال = ${direction === 'Long' ? 'لانگ' : 'شورت'}\n` +
                        `فاصله = ${distancePercent.toFixed(4)}%\n` +
                        `حداقل فاصله قیمت = ${minDist}%\n` +
                        `${distancePercent.toFixed(4)}% < ${minDist}% ✗`
                };
            }
        }

        // 3. Max Margin Per Symbol (only if same-direction position already open for this symbol)
        // In single-symbol backtest we use usedMarginByDirection[direction].
        const existingSymbolMargin = ctx.usedMarginByDirection[direction] || 0;
        const maxMarginPerSymbol = totalAssets * (this.settings.maxMarginPerSymbolPercent / 100);
        const totalSymbolMargin = existingSymbolMargin + newMargin;
        if (totalSymbolMargin > maxMarginPerSymbol) {
            return {
                passed: false,
                reason: 'سقف مارجین',
                margin: newMargin,
                math:
                    `کل دارایی = ${totalAssets.toFixed(4)} USDT\n` +
                    `درصد سقف مارجین نماد = ${this.settings.maxMarginPerSymbolPercent}%\n` +
                    `سقف مارجین نماد = ${maxMarginPerSymbol.toFixed(4)} USDT\n` +
                    `مارجین موجود نماد = ${existingSymbolMargin.toFixed(4)} USDT\n` +
                    `مارجین ورودی جدید = ${newMargin.toFixed(4)} USDT\n` +
                    `مجموع مارجین نماد = ${totalSymbolMargin.toFixed(4)} USDT\n` +
                    `${totalSymbolMargin.toFixed(4)} > ${maxMarginPerSymbol.toFixed(4)} ✗`
            };
        }

        // 4. Positive Margin Check (always runs)
        const finalMargin = Math.max(newMargin, 0);
        if (finalMargin <= 0) {
            return {
                passed: false,
                reason: 'مارجین مثبت',
                margin: newMargin,
                math:
                    `کل دارایی = ${totalAssets.toFixed(4)} USDT\n` +
                    `درصد مارجین ورودی = ${this.getEntryMarginPercent(direction)}%\n` +
                    `مارجین محاسبه‌شده = ${newMargin.toFixed(4)} USDT\n` +
                    `مارجین نهایی = max(${newMargin.toFixed(4)}, 0) = ${finalMargin.toFixed(4)} USDT\n` +
                    `${finalMargin.toFixed(4)} ≤ 0 ✗`
            };
        }

        // 5. Min Same Direction Candles (if minSameDirectionCandles > 0)
        const minSameDir = this.settings.minSameDirectionCandles || 0;
        if (minSameDir > 0) {
            const sigIdx = typeof signal.candleIndex === 'number' ? signal.candleIndex : -1;
            if (sigIdx < 0) {
                return {
                    passed: false,
                    reason: 'کندل هم‌جهت (شماره کندل نامشخص)',
                    margin: newMargin
                };
            }
            const candlesAfterSignal = data.length - sigIdx - 1;
            if (candlesAfterSignal < minSameDir) {
                return {
                    passed: false,
                    reason: 'کندل هم‌جهت (تعداد کافی نیست)',
                    margin: newMargin,
                    math:
                        `سیگنال روی کندل ${sigIdx} صادر شده\n` +
                        `حداقل کندل هم‌جهت مورد نیاز = ${minSameDir}\n` +
                        `کندل‌های موجود بعد از سیگنال: ${candlesAfterSignal}\n` +
                        `نتیجه: تعداد کندل کافی نیست`
                };
            }
            for (let k = 1; k <= minSameDir; k++) {
                const ci = sigIdx + k;
                const c = data[ci];
                if (!c) {
                    return {
                        passed: false,
                        reason: `کندل هم‌جهت (کندل ${ci} موجود نیست)`,
                        margin: newMargin
                    };
                }
                const isGreen = c.close > c.open;
                const isRed = c.close < c.open;
                if (direction === 'Long' && !isGreen) {
                    return {
                        passed: false,
                        reason: `کندل هم‌جهت (کندل ${ci} قرمز)`,
                        margin: newMargin
                    };
                }
                if (direction === 'Short' && !isRed) {
                    return {
                        passed: false,
                        reason: `کندل هم‌جهت (کندل ${ci} سبز)`,
                        margin: newMargin
                    };
                }
            }
        }

        // 6. Signal Expiration (uses CURRENT candle timestamp as "now", not signal's own timestamp)
        const signalTime = signal.timestamp instanceof Date
            ? signal.timestamp.getTime()
            : new Date(signal.timestamp).getTime();
        const now = ctx.currentCandleTimestamp instanceof Date
            ? ctx.currentCandleTimestamp.getTime()
            : new Date(ctx.currentCandleTimestamp).getTime();
        const expirationMs = (this.settings.signalExpirationHours || 6) * 60 * 60 * 1000;
        if ((now - signalTime) > expirationMs) {
            return {
                passed: false,
                reason: 'انقضای سیگنال',
                margin: newMargin,
                math:
                    `زمان سیگنال = ${new Date(signalTime).toLocaleString('fa-IR')}\n` +
                    `زمان فعلی = ${new Date(now).toLocaleString('fa-IR')}\n` +
                    `اختلاف = ${((now - signalTime) / 3600000).toFixed(2)} ساعت\n` +
                    `حداکثر عمر سیگنال = ${this.settings.signalExpirationHours} ساعت\n` +
                    `${((now - signalTime) / 3600000).toFixed(2)} > ${this.settings.signalExpirationHours} ✗`
            };
        }

        return { passed: true, margin: finalMargin };
    }

    // ==================== Top-level orchestration ====================

    /**
     * Run the full backtest.
     * @param {Object} config - BacktestConfig:
     *   { symbol, interval, limit, initialCapital, commission, slippage }
     * @returns {Promise<Object>} backtest report
     */
    async run(config) {
        const cfg = {
            symbol: config.symbol || 'DOT',
            interval: config.interval || this.settings.interval || '1h',
            limit: config.limit || this.settings.limit || 1000,
            initialCapital: parseFloat(config.initialCapital) || 1000,
            commission: parseFloat(config.commission) || 0.04, // %
            slippage: parseFloat(config.slippage) || 0.02       // %
        };

        // 1. Fetch candle data
        const rawData = await this.fetchCandles(cfg.symbol, cfg.interval, cfg.limit);
        console.log('[Backtest] Fetched', rawData.length, 'candles');

        // 2. Generate signals (pre-computed; consumed inline during candle loop)
        const { data, signals } = this.generateSignals(cfg.symbol, rawData);
        console.log('[Backtest] Generated', signals.length, 'signals from', data.length, 'candles');

        // 3. Simulate (event-driven candle loop)
        const simulation = this.simulate(data, signals, cfg);
        console.log('[Backtest] Simulation complete:', simulation.closedTrades.length, 'trades,', simulation.rejectedTrades.length, 'rejected');

        // 4. Build report
        const report = this.buildReport(simulation, cfg);
        report.config = cfg;
        report.candleCount = data.length;
        report.signalCount = signals.length;
        report.interval = cfg.interval;
        // Expose raw candles + signals for chart rendering
        report.candles = data;
        report.signals = signals;
        return report;
    }

    // ==================== Event-Driven Simulation ====================

    /**
     * EVENT-DRIVEN CANDLE LOOP.
     *
     * Iterates candles chronologically, processing each candle as a discrete
     * time step. Per-candle order:
     *   1. Mark-to-market update for open positions
     *   2. TP/SL check (pessimistic — SL first if both hit on same candle)
     *   3. Pending signal expiration check
     *   4. Try to consume pending signal via risk controls
     *   5. Generate new signal (lookup in pre-computed signalsByCandleIdx):
     *      - Close opposite positions on same symbol
     *      - Try to open via risk controls; on fail, set as pending
     *   6. Update accountState + record snapshot
     *
     * @param {Array}  data     - per-candle array (with signal/tp/sl/rsi/atr fields)
     * @param {Array}  signals  - pre-computed signals (each has candleIndex)
     * @param {Object} cfg      - BacktestConfig
     * @returns {Object} simulation state for report building
     */
    simulate(data, signals, cfg) {
        const state = {
            cfg,
            data,           // ✓ Store raw candle data for chart rendering
            signals,        // ✓ Store signals for chart rendering
            // ===== Account state (MT4/MT5-style) =====
            // balance: realized cash (includes margin marked-as-used; only entryCommission
            //         is deducted at open). At close: balance += pnl - exitCommission.
            balance: cfg.initialCapital,
            usedMargin: 0,
            unrealizedPnl: 0,
            realizedPnl: 0,
            // derived (recomputed each candle): equity, freeMargin
            equity: cfg.initialCapital,
            freeMargin: cfg.initialCapital,

            // ===== Positions =====
            openPositions: [],       // array of openPosition objects (see openPosition())
            closedTrades: [],        // array of closed-position records
            rejectedTrades: [],      // array of rejection records

            // ===== Per-direction context =====
            usedMarginByDirection: { Long: 0, Short: 0 },
            lastEntryPrice: { Long: null, Short: null },

            // ===== Pending signal model (mirrors automation-manager.js selectedSignal) =====
            pendingSignal: null,    // signal awaiting consumption (risk controls failed previously)
            pendingRejection: null, // rejection record for pendingSignal (pushed when replaced/expired)

            // ===== Snapshots =====
            snapshots: [],           // { timestamp, balance, equity, freeMargin, usedMargin, unrealizedPnl, realizedPnl, openPositions }
            equityCurve: [],         // { timestamp, equity }
            drawdownCurve: [],       // { timestamp, drawdown }
            peakEquity: cfg.initialCapital,
            maxDrawdown: 0,          // percent

            // ===== Per-candle returns (for Sharpe ratio) =====
            returns: [],
        };

        // Sync engine-level lastEntryPrice (used by checkRiskControls)
        this.lastEntryPrice = state.lastEntryPrice;

        // Quick lookup: candleIndex -> signal
        const signalsByCandleIdx = new Map();
        for (const s of signals) {
            signalsByCandleIdx.set(s.candleIndex, s);
        }

        let positionIdCounter = 1;
        let rejectedIdCounter = 1;

        // ---------- Helpers ----------

        // Compute unrealized PnL of an open position at a given candle's close price.
        const computeUnrealizedPnl = (pos, markPrice) => {
            if (pos.direction === 'Long') {
                return (markPrice - pos.entryPrice) * pos.qty;
            }
            return (pos.entryPrice - markPrice) * pos.qty;
        };

        // Recompute account-level unrealizedPnl + derived fields
        const recomputeAccountState = (currentCandleClose) => {
            let upnl = 0;
            for (const p of state.openPositions) {
                upnl += computeUnrealizedPnl(p, currentCandleClose);
            }
            state.unrealizedPnl = upnl;
            state.equity = state.balance + upnl;
            state.freeMargin = state.equity - state.usedMargin;
        };

        // Open a new position from a signal at candleIdx.
        const openPosition = (signal, candleIdx, margin, leverage, entryReason) => {
            const notional = margin * leverage; // leveraged position size in USDT
            // Apply slippage: Long pays higher, Short receives lower
            const slippageFactor = cfg.slippage / 100;
            const entryPrice = signal.type === 'Long'
                ? signal.price * (1 + slippageFactor)
                : signal.price * (1 - slippageFactor);
            const qty = notional / entryPrice;
            const entryCommission = notional * (cfg.commission / 100);

            const capitalBefore = state.balance;
            // MT4/MT5-style: only entryCommission is deducted from balance at open;
            // margin is "marked as used" (still part of balance).
            state.balance = state.balance - entryCommission;
            state.usedMargin += margin;
            state.usedMarginByDirection[signal.type] =
                (state.usedMarginByDirection[signal.type] || 0) + margin;

            const pos = {
                id: positionIdCounter++,
                symbol: signal.symbol,
                direction: signal.type,        // 'Long' | 'Short'
                entryPrice: entryPrice,
                exitPrice: null,
                tp: signal.tp,
                sl: signal.sl,
                qty: qty,
                notional: notional,
                margin: margin,
                leverage: leverage,
                entryCandleIdx: candleIdx,
                entryTimestamp: signal.timestamp,
                entryCommission: entryCommission,
                exitCommission: null,
                pnl: null,
                pnlPercent: null,
                status: 'open',
                exitReason: null,
                exitCandleIdx: null,
                exitTimestamp: null,
                capitalBefore: capitalBefore,
                entryReason: entryReason,
                signal: signal
            };
            state.openPositions.push(pos);
            state.lastEntryPrice[signal.type] = entryPrice;
            this.lastEntryPrice[signal.type] = entryPrice;
            return pos;
        };

        // Close a position at exitPrice/candleIdx/exitReason. Updates balance,
        // usedMargin, realizedPnl, and pushes a closed-trade record.
        const closePosition = (pos, exitPrice, exitCandleIdx, exitReason) => {
            const pnl = pos.direction === 'Long'
                ? (exitPrice - pos.entryPrice) * pos.qty
                : (pos.entryPrice - exitPrice) * pos.qty;
            const exitCommission = pos.notional * (cfg.commission / 100);
            const capitalBefore = state.balance;
            // MT4/MT5-style: balance += pnl - exitCommission (margin was never deducted from balance)
            state.balance = state.balance + pnl - exitCommission;
            // Free up margin
            state.usedMargin -= pos.margin;
            state.usedMarginByDirection[pos.direction] -= pos.margin;
            const capitalAfter = state.balance;

            // Net PnL for this trade (after both commissions)
            const netPnl = pnl - pos.entryCommission - exitCommission;
            const pnlPercent = pos.margin > 0
                ? (netPnl / pos.margin) * 100
                : 0;

            // Update position object (full lifecycle record)
            pos.exitPrice = exitPrice;
            pos.exitCommission = exitCommission;
            pos.pnl = netPnl;
            pos.pnlPercent = pnlPercent;
            pos.status = 'closed';
            pos.exitReason = exitReason;
            pos.exitCandleIdx = exitCandleIdx;
            pos.exitTimestamp = data[exitCandleIdx].timestamp;
            pos.capitalAfter = capitalAfter;
            pos.candleCount = exitCandleIdx - pos.entryCandleIdx;

            // Add to realized PnL (net of commissions)
            state.realizedPnl += netPnl;

            state.closedTrades.push({
                id: pos.id,
                signalId: pos.id,
                symbol: pos.symbol,
                direction: pos.direction,
                entryPrice: pos.entryPrice,
                exitPrice: pos.exitPrice,
                tp: pos.tp,
                sl: pos.sl,
                qty: pos.qty,
                margin: pos.margin,
                leverage: pos.leverage,
                entryCandleIdx: pos.entryCandleIdx,
                entryTimestamp: pos.entryTimestamp,
                exitCandleIdx: pos.exitCandleIdx,
                exitTimestamp: pos.exitTimestamp,
                entryCommission: pos.entryCommission,
                exitCommission: pos.exitCommission,
                pnl: pos.pnl,
                pnlPercent: pos.pnlPercent,
                entryReason: pos.entryReason,
                exitReason: pos.exitReason,
                capitalBefore: pos.capitalBefore,
                capitalAfter: pos.capitalAfter,
                candleCount: pos.candleCount,
                status: 'closed'
            });
        };

        // Check open positions for TP/SL hits using candle's high/low.
        // Pessimistic assumption: if both TP and SL could hit on the same candle,
        // SL hits first (we assume the worst for the trader).
        const checkTpSl = (candleIdx) => {
            const candle = data[candleIdx];
            const snapshot = state.openPositions.slice();
            for (const pos of snapshot) {
                if (state.openPositions.indexOf(pos) === -1) continue; // already closed
                let exitPrice = null;
                let exitReason = null;
                if (pos.direction === 'Long') {
                    // Long: SL if low <= SL, else TP if high >= TP
                    if (candle.low <= pos.sl) {
                        exitPrice = pos.sl;
                        exitReason = 'SL';
                    } else if (candle.high >= pos.tp) {
                        exitPrice = pos.tp;
                        exitReason = 'TP';
                    }
                } else {
                    // Short: SL if high >= SL, else TP if low <= TP
                    if (candle.high >= pos.sl) {
                        exitPrice = pos.sl;
                        exitReason = 'SL';
                    } else if (candle.low <= pos.tp) {
                        exitPrice = pos.tp;
                        exitReason = 'TP';
                    }
                }
                if (exitPrice !== null) {
                    const idx = state.openPositions.indexOf(pos);
                    if (idx >= 0) state.openPositions.splice(idx, 1);
                    closePosition(pos, exitPrice, candleIdx, exitReason);
                }
            }
        };

        // Close all open positions of the OPPOSITE direction to newDirection on
        // the same symbol. Mirrors runCycle's closeOppositePositions().
        const closeOppositePositions = (newDirection, candleIdx) => {
            const oppositeDir = newDirection === 'Long' ? 'Short' : 'Long';
            const exitPrice = data[candleIdx].close;
            const snapshot = state.openPositions.slice();
            for (const pos of snapshot) {
                if (pos.direction !== oppositeDir) continue;
                if (pos.symbol !== state.cfg.symbol) continue; // single-symbol backtest; safety
                const idx = state.openPositions.indexOf(pos);
                if (idx >= 0) state.openPositions.splice(idx, 1);
                closePosition(pos, exitPrice, candleIdx, 'بستن پوزیشن مخالف');
            }
        };

        // Try to open a position from a signal via risk controls.
        // Returns { opened: bool, rejectionReason: string|null, math: string|null }.
        const tryOpen = (signal, candleIdx) => {
            const ctx = {
                usedMarginByDirection: state.usedMarginByDirection,
                lastEntryPrice: state.lastEntryPrice,
                currentCandleTimestamp: data[candleIdx].timestamp
            };
            const rc = this.checkRiskControls(signal, data, state, ctx);
            if (rc.passed) {
                const leverage = this.getLeverage(signal.type);
                const entryReason = `سیگنال ${signal.type === 'Long' ? 'لانگ' : 'شورت'} - Fake Breakout`;
                openPosition(signal, candleIdx, rc.margin, leverage, entryReason);
                return { opened: true, rejectionReason: null, math: null };
            }
            return { opened: false, rejectionReason: rc.reason, math: rc.math || '' };
        };

        // Make a rejection record (not yet pushed to rejectedTrades — caller decides)
        const makeRejectionRecord = (signal, reason, math) => ({
            id: rejectedIdCounter++,
            signalId: rejectedIdCounter - 1,
            timestamp: signal.timestamp,
            symbol: signal.symbol,
            direction: signal.type,
            rejectionReason: reason,
            capitalBefore: state.balance,
            math: math || ''
        });

        // ---------- Main event-driven loop ----------
        const expirationMs = (this.settings.signalExpirationHours || 6) * 60 * 60 * 1000;

        for (let i = 0; i < data.length; i++) {
            const candle = data[i];

            // ===== Step 1+2: Mark-to-market update + TP/SL check =====
            // (TP/SL must run BEFORE signal generation so a position that hits TP
            //  on candle X doesn't count as open when checking risk for a new
            //  signal on the same candle.)
            checkTpSl(i);

            // ===== Step 3+4: Pending signal expiration + retry =====
            if (state.pendingSignal) {
                const sigTime = state.pendingSignal.timestamp instanceof Date
                    ? state.pendingSignal.timestamp.getTime()
                    : new Date(state.pendingSignal.timestamp).getTime();
                const nowTime = candle.timestamp.getTime();
                const expired = (nowTime - sigTime) > expirationMs;
                if (expired) {
                    // Push rejection with expiration reason (override any earlier reason)
                    const rec = state.pendingRejection || makeRejectionRecord(state.pendingSignal, '', '');
                    rec.rejectionReason = 'انقضای سیگنال';
                    rec.math = (rec.math || '') +
                        (rec.math ? '\n' : '') +
                        `زمان سیگنال = ${new Date(sigTime).toLocaleString('fa-IR')}\n` +
                        `زمان انقضا = ${new Date(nowTime).toLocaleString('fa-IR')}\n` +
                        `اختلاف = ${((nowTime - sigTime) / 3600000).toFixed(2)} ساعت\n` +
                        `حداکثر عمر سیگنال = ${this.settings.signalExpirationHours} ساعت`;
                    state.rejectedTrades.push(rec);
                    state.pendingSignal = null;
                    state.pendingRejection = null;
                } else {
                    // Retry opening pending signal at this candle
                    const result = tryOpen(state.pendingSignal, i);
                    if (result.opened) {
                        state.pendingSignal = null;
                        state.pendingRejection = null;
                    } else {
                        // Update rejection record with latest reason (don't push yet)
                        if (!state.pendingRejection) {
                            state.pendingRejection = makeRejectionRecord(
                                state.pendingSignal, result.rejectionReason, result.math
                            );
                        } else {
                            state.pendingRejection.rejectionReason = result.rejectionReason;
                            state.pendingRejection.math = result.math;
                            state.pendingRejection.capitalBefore = state.balance;
                        }
                    }
                }
            }

            // ===== Step 5: Generate new signal (lookup pre-computed) =====
            const newSignal = signalsByCandleIdx.get(i);
            if (newSignal) {
                // Discard old pending signal (push its rejection if any)
                if (state.pendingSignal && state.pendingRejection) {
                    state.rejectedTrades.push(state.pendingRejection);
                }
                state.pendingSignal = null;
                state.pendingRejection = null;

                // Close opposite positions on same symbol (mirrors runCycle step 8)
                closeOppositePositions(newSignal.type, i);

                // Try to open the new signal
                const result = tryOpen(newSignal, i);
                if (result.opened) {
                    // Opened successfully — no rejection to record
                } else {
                    // Failed — set as pending for retry on subsequent candles
                    state.pendingSignal = newSignal;
                    state.pendingRejection = makeRejectionRecord(
                        newSignal, result.rejectionReason, result.math
                    );
                }
            }

            // ===== Step 6: Update account state + record snapshot =====
            recomputeAccountState(candle.close);

            // Track per-candle return for Sharpe ratio
            if (state.equityCurve.length > 0) {
                const prevEquity = state.equityCurve[state.equityCurve.length - 1].equity;
                if (prevEquity > 0) {
                    state.returns.push((state.equity - prevEquity) / prevEquity);
                }
            }

            state.snapshots.push({
                timestamp: candle.timestamp,
                balance: state.balance,
                equity: state.equity,
                freeMargin: state.freeMargin,
                usedMargin: state.usedMargin,
                unrealizedPnl: state.unrealizedPnl,
                realizedPnl: state.realizedPnl,
                openPositions: state.openPositions.length
            });
            state.equityCurve.push({ timestamp: candle.timestamp, equity: state.equity });

            if (state.equity > state.peakEquity) {
                state.peakEquity = state.equity;
            }
            const drawdown = state.peakEquity > 0
                ? ((state.peakEquity - state.equity) / state.peakEquity) * 100
                : 0;
            state.drawdownCurve.push({ timestamp: candle.timestamp, drawdown: drawdown });
            if (drawdown > state.maxDrawdown) {
                state.maxDrawdown = drawdown;
            }
        }

        // ---------- End of data: close remaining open positions ----------
        const lastCandleIdx = data.length - 1;
        const lastClose = data[lastCandleIdx].close;
        const snapshot = state.openPositions.slice();
        for (const pos of snapshot) {
            const idx = state.openPositions.indexOf(pos);
            if (idx >= 0) state.openPositions.splice(idx, 1);
            closePosition(pos, lastClose, lastCandleIdx, 'پایان داده');
        }

        // Push any pending rejection with "پایان داده" reason
        if (state.pendingSignal) {
            const rec = state.pendingRejection || makeRejectionRecord(state.pendingSignal, '', '');
            rec.rejectionReason = 'پایان داده';
            state.rejectedTrades.push(rec);
            state.pendingSignal = null;
            state.pendingRejection = null;
        }

        // Final account state recompute
        recomputeAccountState(lastClose);

        return state;
    }

    // ==================== Sharpe Ratio ====================

    /**
     * Calculate annualized Sharpe ratio from per-candle returns.
     * Uses risk-free rate = 0.
     * @param {Array<number>} returns   - per-candle returns
     * @param {string}        interval  - candle interval (1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w)
     * @returns {number} annualized Sharpe ratio (0 if undefined)
     */
    calculateSharpeRatio(returns, interval) {
        if (!returns || returns.length < 2) return 0;
        const n = returns.length;
        const mean = returns.reduce((s, r) => s + r, 0) / n;
        const variance = returns.reduce((s, r) => s + (r - mean) * (r - mean), 0) / n;
        const std = Math.sqrt(variance);
        if (std === 0) return 0;
        const perCandleSharpe = mean / std;

        // Candles per year (annualization factor)
        const candlesPerYear = {
            '1m': 525600, '3m': 175200, '5m': 105120, '15m': 35040,
            '30m': 17520, '60m': 8760, '1h': 8760, '2h': 4380, '4h': 2190,
            '6h': 1460, '8h': 1095, '12h': 730, '1d': 365, '1w': 52, '1M': 12
        };
        const cpy = candlesPerYear[interval] || 8760; // default to 1h
        return perCandleSharpe * Math.sqrt(cpy);
    }

    // ==================== Reports ====================

    /**
     * Build the full backtest report from the simulation state.
     * Includes: Overall stats, Long stats, Short stats, Equity Curve,
     * Drawdown Curve, Trade History, Rejected Trades, Sharpe Ratio.
     */
    buildReport(state, cfg) {
        const trades = state.closedTrades;
        const rejected = state.rejectedTrades;

        // ===== Overall stats =====
        const finalCapital = state.balance;
        const netProfit = finalCapital - cfg.initialCapital;
        const netProfitPercent = cfg.initialCapital > 0
            ? (netProfit / cfg.initialCapital) * 100
            : 0;

        const winningTrades = trades.filter(t => t.pnl > 0);
        const losingTrades = trades.filter(t => t.pnl < 0);
        const grossProfit = winningTrades.reduce((s, t) => s + t.pnl, 0);
        const grossLoss = Math.abs(losingTrades.reduce((s, t) => s + t.pnl, 0));
        const winRate = trades.length > 0
            ? (winningTrades.length / trades.length) * 100
            : 0;
        const profitFactor = grossLoss > 0
            ? grossProfit / grossLoss
            : (grossProfit > 0 ? Infinity : 0);

        const sharpeRatio = this.calculateSharpeRatio(state.returns, cfg.interval);

        const overall = {
            initialCapital: cfg.initialCapital,
            finalCapital: finalCapital,
            netProfit: netProfit,
            netProfitPercent: netProfitPercent,
            grossProfit: grossProfit,
            grossLoss: grossLoss,
            winRate: winRate,
            profitFactor: profitFactor,
            totalTrades: trades.length,
            winningTrades: winningTrades.length,
            losingTrades: losingTrades.length,
            maxDrawdown: state.maxDrawdown,
            maxDrawdownPercent: state.maxDrawdown,
            sharpeRatio: sharpeRatio
        };

        // ===== Long stats =====
        const longTrades = trades.filter(t => t.direction === 'Long');
        const winningLong = longTrades.filter(t => t.pnl > 0);
        const losingLong = longTrades.filter(t => t.pnl < 0);
        const longGrossProfit = winningLong.reduce((s, t) => s + t.pnl, 0);
        const longGrossLoss = Math.abs(losingLong.reduce((s, t) => s + t.pnl, 0));
        const longNetProfit = longTrades.reduce((s, t) => s + t.pnl, 0);
        const longStats = {
            totalLongTrades: longTrades.length,
            winningLong: winningLong.length,
            losingLong: losingLong.length,
            longWinRate: longTrades.length > 0
                ? (winningLong.length / longTrades.length) * 100
                : 0,
            longGrossProfit: longGrossProfit,
            longGrossLoss: longGrossLoss,
            longProfitFactor: longGrossLoss > 0
                ? longGrossProfit / longGrossLoss
                : (longGrossProfit > 0 ? Infinity : 0),
            longNetProfit: longNetProfit
        };

        // ===== Short stats =====
        const shortTrades = trades.filter(t => t.direction === 'Short');
        const winningShort = shortTrades.filter(t => t.pnl > 0);
        const losingShort = shortTrades.filter(t => t.pnl < 0);
        const shortGrossProfit = winningShort.reduce((s, t) => s + t.pnl, 0);
        const shortGrossLoss = Math.abs(losingShort.reduce((s, t) => s + t.pnl, 0));
        const shortNetProfit = shortTrades.reduce((s, t) => s + t.pnl, 0);
        const shortStats = {
            totalShortTrades: shortTrades.length,
            winningShort: winningShort.length,
            losingShort: losingShort.length,
            shortWinRate: shortTrades.length > 0
                ? (winningShort.length / shortTrades.length) * 100
                : 0,
            shortGrossProfit: shortGrossProfit,
            shortGrossLoss: shortGrossLoss,
            shortProfitFactor: shortGrossLoss > 0
                ? shortGrossProfit / shortGrossLoss
                : (shortGrossProfit > 0 ? Infinity : 0),
            shortNetProfit: shortNetProfit
        };

        return {
            overall,
            longStats,
            shortStats,
            equityCurve: state.equityCurve,
            drawdownCurve: state.drawdownCurve,
            trades,
            rejectedTrades: rejected,
            // Expose raw data + signals + snapshots for chart rendering
            candles: (state.data || []).map(c => ({ timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp), open: c.open, high: c.high, low: c.low, close: c.close, amount: c.amount })),
            signals: state.signals || [],
            snapshots: state.snapshots,
            config: { symbol: cfg.symbol, initialCapital: cfg.initialCapital, commission: cfg.commission, slippage: cfg.slippage },
            interval: cfg.interval
        };
    }
}

// Make available globally
window.BacktestEngine = BacktestEngine;
window.getDefaultBacktestSettings = getDefaultSettings;
window.loadBacktestSettings = loadBacktestSettings;
console.log('✓ BacktestEngine (Event-Driven) loaded and available globally');
