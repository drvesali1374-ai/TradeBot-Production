/**
 * Backtest Engine
 * ===============
 *
 * Phase 4 + 5 + 6 — Backtest system for the TradeBot project.
 *
 * Copies the EXACT signal generation logic from automation-manager.js's
 * analyzeMarketData() function and the SAME risk controls from runCycle().
 * Instead of opening real positions, simulates them against historical
 * candle data to produce a backtest report (overall + Long/Short stats,
 * equity curve, drawdown curve, trade history).
 *
 * Dependencies (must be loaded BEFORE this file):
 *   - /js/shared/signal-utils.js  (window.SignalUtils)
 *
 * Settings:
 *   - Read from localStorage.getItem('automation_settings') (same as automation page)
 *   - Falls back to defaults if missing
 *
 * API:
 *   - Fetches historical candles from /api/toobit-proxy (same as automation page)
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

// ==================== Backtest Engine ====================

class BacktestEngine {
    /**
     * @param {Object} settings  - automation_settings (use loadBacktestSettings())
     */
    constructor(settings) {
        this.settings = settings || getDefaultSettings();
        // Per-signal last-entry-price cache (used by Price Distance control)
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

    /**
     * Generate signals from candle data.
     * COPIES the EXACT analyzeMarketData() logic from automation-manager.js.
     * @param {string} symbol
     * @param {Array}  rawData  - raw klines array
     * @returns {Object} { data, signals } — data is the per-candle array with
     *   signal/tp/sl/rsi/atr fields, signals is the array of generated signals.
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

        // ---- Daily data (offset 3.5 hours) ----
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

        // ---- Generate signals ----
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
     * Run all risk controls for a candidate signal. Returns { passed, reason }.
     * Mirrors runCycle's controls: Safe Asset, Price Distance, Max Margin,
     * Positive Margin, Min Same Direction Candles, Signal Expiration.
     *
     * @param {Object} signal          - the generated signal
     * @param {Object} data            - the per-candle data array
     * @param {Object} ctx             - simulation context:
     *   { currentCapital, lockedMargin, lockedMarginByDirection }
     */
    checkRiskControls(signal, data, ctx) {
        const direction = signal.type; // 'Long' | 'Short'
        const totalAssets = ctx.currentCapital;
        const freeBalance = ctx.currentCapital - ctx.lockedMargin;
        const newMargin =
            totalAssets * (this.getEntryMarginPercent(direction) / 100);

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
        const lastEntry = this.lastEntryPrice[direction];
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
        // In backtest, we only run one symbol — use lockedMarginByDirection[direction]
        const existingSymbolMargin = ctx.lockedMarginByDirection[direction] || 0;
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
            const sigIdx =
                typeof signal.candleIndex === 'number' ? signal.candleIndex : -1;
            if (sigIdx < 0) {
                // can't verify — treat as fail (matches runCycle's "skip" path; here we reject)
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

        // 6. Signal Expiration (mirrors isSignalExpired; in backtest we use the
        //    signal's own timestamp as "now", so this won't reject in practice —
        //    but we include the control for parity with runCycle).
        const signalTime = signal.timestamp instanceof Date
            ? signal.timestamp.getTime()
            : new Date(signal.timestamp).getTime();
        // "now" = the signal's own timestamp (we process signals at their generation time)
        const now = signalTime;
        const expirationMs = (this.settings.signalExpirationHours || 6) * 60 * 60 * 1000;
        if ((now - signalTime) > expirationMs) {
            return {
                passed: false,
                reason: 'انقضای سیگنال',
                margin: newMargin
            };
        }

        return { passed: true, margin: finalMargin };
    }

    // ==================== Position Simulation ====================

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

        // 2. Generate signals (exact same logic as analyzeMarketData)
        const { data, signals } = this.generateSignals(cfg.symbol, rawData);

        // 3. Simulate positions
        const simulation = this.simulate(data, signals, cfg);

        // 4. Build report
        const report = this.buildReport(simulation, cfg);
        report.config = cfg;
        report.candleCount = data.length;
        report.signalCount = signals.length;
        return report;
    }

    /**
     * Core simulation loop — iterates candles chronologically, opens virtual
     * positions on signal candles (subject to risk controls), and closes them
     * when TP/SL is hit by subsequent candles (or at end of data).
     *
     * @param {Array}  data     - per-candle array (with signal/tp/sl fields)
     * @param {Array}  signals  - generated signals
     * @param {Object} cfg      - BacktestConfig
     * @returns {Object} simulation state for report building
     */
    simulate(data, signals, cfg) {
        const state = {
            cfg,
            currentCapital: cfg.initialCapital,
            lockedMargin: 0,
            lockedMarginByDirection: { Long: 0, Short: 0 },
            openPositions: [], // { signalId, direction, entryPrice, tp, sl, qty, margin, leverage, entryCandleIdx, entryCommission, entryTimestamp, signal }
            closedTrades: [],
            rejectedTrades: [],
            equityCurve: [],   // { timestamp, capital }
            drawdownCurve: [],  // { timestamp, drawdown }
            peakCapital: cfg.initialCapital,
            maxDrawdown: 0,
            // Track last entry price per direction (for Price Distance control)
            lastEntryPrice: { Long: null, Short: null }
        };

        // Reset the engine-level lastEntryPrice (used by checkRiskControls)
        this.lastEntryPrice = state.lastEntryPrice;

        // Build a quick lookup: candleIndex -> signal
        const signalsByCandleIdx = new Map();
        for (const s of signals) {
            signalsByCandleIdx.set(s.candleIndex, s);
        }

        let signalIdCounter = 0;

        // Helper: compute unrealized PnL of an open position at a given candle
        const unrealizedPnl = (pos, candle) => {
            const markPrice = candle.close;
            if (pos.direction === 'Long') {
                return (markPrice - pos.entryPrice) * pos.qty;
            }
            return (pos.entryPrice - markPrice) * pos.qty;
        };

        // Helper: close a position at a given price/candle
        const closePosition = (pos, exitPrice, exitCandleIdx, exitReason) => {
            const pnl = pos.direction === 'Long'
                ? (exitPrice - pos.entryPrice) * pos.qty
                : (pos.entryPrice - exitPrice) * pos.qty;
            const exitCommission = pos.notional * (cfg.commission / 100);
            const capitalBefore = state.currentCapital;
            // Apply: PnL + return margin - exit commission
            // (entry commission was already deducted at open time; margin was deducted at open)
            state.currentCapital = state.currentCapital + pnl - exitCommission;
            // Unlock margin
            state.lockedMargin -= pos.margin;
            state.lockedMarginByDirection[pos.direction] -= pos.margin;
            const capitalAfter = state.currentCapital;
            const pnlPercent = pos.entryPrice > 0
                ? ((pnl - pos.entryCommission - exitCommission) / pos.margin) * 100
                : 0;

            state.closedTrades.push({
                signalId: pos.signalId,
                timestamp: pos.entryTimestamp,
                exitTimestamp: data[exitCandleIdx].timestamp,
                symbol: pos.symbol,
                direction: pos.direction,
                entryPrice: pos.entryPrice,
                exitPrice: exitPrice,
                tp: pos.tp,
                sl: pos.sl,
                pnl: pnl - pos.entryCommission - exitCommission, // net PnL after commissions
                pnlPercent: pnlPercent,
                entryReason: pos.entryReason,
                exitReason: exitReason,
                capitalBefore: capitalBefore,
                capitalAfter: capitalAfter,
                leverage: pos.leverage,
                margin: pos.margin,
                candleCount: exitCandleIdx - pos.entryCandleIdx
            });
        };

        // Helper: check open positions for TP/SL hits using candle's high/low.
        // Iterates in order (oldest first). Uses pessimistic assumption: if both
        // TP and SL could hit on the same candle, SL hits first.
        const checkOpenPositionsAtCandle = (candleIdx) => {
            const candle = data[candleIdx];
            // Iterate over a snapshot (closePosition mutates openPositions)
            const snapshot = state.openPositions.slice();
            for (const pos of snapshot) {
                if (state.openPositions.indexOf(pos) === -1) continue; // already closed
                let exitPrice = null;
                let exitReason = null;
                if (pos.direction === 'Long') {
                    if (candle.low <= pos.sl) {
                        exitPrice = pos.sl;
                        exitReason = 'SL رسید';
                    } else if (candle.high >= pos.tp) {
                        exitPrice = pos.tp;
                        exitReason = 'TP رسید';
                    }
                } else {
                    if (candle.high >= pos.sl) {
                        exitPrice = pos.sl;
                        exitReason = 'SL رسید';
                    } else if (candle.low <= pos.tp) {
                        exitPrice = pos.tp;
                        exitReason = 'TP رسید';
                    }
                }
                if (exitPrice !== null) {
                    // Remove from openPositions
                    const idx = state.openPositions.indexOf(pos);
                    if (idx >= 0) state.openPositions.splice(idx, 1);
                    closePosition(pos, exitPrice, candleIdx, exitReason);
                }
            }
        };

        // Helper: open a new position from a signal
        const openPosition = (signal, candleIdx, margin, leverage, entryReason) => {
            const entryMarginPercent = this.getEntryMarginPercent(signal.type);
            const notional = margin * leverage; // leveraged position size in USDT
            // Apply slippage: Long pays higher, Short receives lower
            const slippageFactor = cfg.slippage / 100;
            const entryPrice = signal.type === 'Long'
                ? signal.price * (1 + slippageFactor)
                : signal.price * (1 - slippageFactor);
            const qty = notional / entryPrice;
            const entryCommission = notional * (cfg.commission / 100);

            // Deduct margin + entry commission from capital
            const capitalBefore = state.currentCapital;
            state.currentCapital = state.currentCapital - margin - entryCommission;
            state.lockedMargin += margin;
            state.lockedMarginByDirection[signal.type] =
                (state.lockedMarginByDirection[signal.type] || 0) + margin;

            const pos = {
                signalId: signalIdCounter++,
                direction: signal.type,
                entryPrice: entryPrice,
                tp: signal.tp,
                sl: signal.sl,
                qty: qty,
                notional: notional,
                margin: margin,
                leverage: leverage,
                entryCandleIdx: candleIdx,
                entryTimestamp: signal.timestamp,
                entryCommission: entryCommission,
                entryReason: entryReason,
                symbol: signal.symbol,
                signal: signal
            };
            state.openPositions.push(pos);
            // Update last entry price for direction (used by Price Distance control)
            state.lastEntryPrice[signal.type] = entryPrice;
            this.lastEntryPrice[signal.type] = entryPrice;
            return pos;
        };

        // ===== Iterate candles chronologically =====
        for (let i = 0; i < data.length; i++) {
            const candle = data[i];

            // 1. Check open positions for TP/SL hits using this candle's high/low
            checkOpenPositionsAtCandle(i);

            // 2. Check if a signal fires at this candle — apply risk controls
            const signal = signalsByCandleIdx.get(i);
            if (signal) {
                const ctx = {
                    currentCapital: state.currentCapital,
                    lockedMargin: state.lockedMargin,
                    lockedMarginByDirection: state.lockedMarginByDirection
                };
                const rc = this.checkRiskControls(signal, data, ctx);
                if (rc.passed) {
                    const margin = rc.margin;
                    const leverage = this.getLeverage(signal.type);
                    const entryReason = `سیگنال ${signal.type === 'Long' ? 'لانگ' : 'شورت'} - Fake Breakout`;
                    openPosition(signal, i, margin, leverage, entryReason);
                } else {
                    // Rejected trade
                    state.rejectedTrades.push({
                        signalId: signalIdCounter++,
                        timestamp: signal.timestamp,
                        symbol: signal.symbol,
                        direction: signal.type,
                        rejectionReason: rc.reason,
                        capitalBefore: state.currentCapital,
                        math: rc.math || ''
                    });
                }
            }

            // 3. Update equity & drawdown curves (mark-to-market)
            let equity = state.currentCapital;
            for (const pos of state.openPositions) {
                equity += unrealizedPnl(pos, candle);
            }
            // Also count locked margin as part of equity (margin is still ours, just locked)
            // equity already includes currentCapital which has margin deducted from it,
            // so we add back the locked margin to get the true equity.
            equity += state.lockedMargin;
            state.equityCurve.push({ timestamp: candle.timestamp, capital: equity });

            if (equity > state.peakCapital) {
                state.peakCapital = equity;
            }
            const drawdown = state.peakCapital > 0
                ? ((state.peakCapital - equity) / state.peakCapital) * 100
                : 0;
            state.drawdownCurve.push({ timestamp: candle.timestamp, drawdown: drawdown });
            if (drawdown > state.maxDrawdown) {
                state.maxDrawdown = drawdown;
            }
        }

        // 4. Close any remaining open positions at the last candle's close
        const lastCandleIdx = data.length - 1;
        const snapshot = state.openPositions.slice();
        for (const pos of snapshot) {
            const idx = state.openPositions.indexOf(pos);
            if (idx >= 0) state.openPositions.splice(idx, 1);
            closePosition(pos, data[lastCandleIdx].close, lastCandleIdx, 'پایان داده');
        }

        return state;
    }

    // ==================== Reports ====================

    /**
     * Build the full backtest report from the simulation state.
     */
    buildReport(state, cfg) {
        const trades = state.closedTrades;
        const rejected = state.rejectedTrades;

        // Overall stats
        const finalCapital = state.currentCapital;
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
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

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
            maxDrawdown: state.maxDrawdown
        };

        // Long stats
        const longTrades = trades.filter(t => t.direction === 'Long');
        const winningLong = longTrades.filter(t => t.pnl > 0);
        const losingLong = longTrades.filter(t => t.pnl < 0);
        const longProfit = winningLong.reduce((s, t) => s + t.pnl, 0);
        const longLoss = Math.abs(losingLong.reduce((s, t) => s + t.pnl, 0));
        const longStats = {
            totalLongTrades: longTrades.length,
            winningLong: winningLong.length,
            losingLong: losingLong.length,
            longWinRate: longTrades.length > 0
                ? (winningLong.length / longTrades.length) * 100
                : 0,
            longProfit: longProfit,
            longLoss: longLoss,
            longProfitFactor: longLoss > 0 ? longProfit / longLoss : (longProfit > 0 ? Infinity : 0)
        };

        // Short stats
        const shortTrades = trades.filter(t => t.direction === 'Short');
        const winningShort = shortTrades.filter(t => t.pnl > 0);
        const losingShort = shortTrades.filter(t => t.pnl < 0);
        const shortProfit = winningShort.reduce((s, t) => s + t.pnl, 0);
        const shortLoss = Math.abs(losingShort.reduce((s, t) => s + t.pnl, 0));
        const shortStats = {
            totalShortTrades: shortTrades.length,
            winningShort: winningShort.length,
            losingShort: losingShort.length,
            shortWinRate: shortTrades.length > 0
                ? (winningShort.length / shortTrades.length) * 100
                : 0,
            shortProfit: shortProfit,
            shortLoss: shortLoss,
            shortProfitFactor: shortLoss > 0 ? shortProfit / shortLoss : (shortProfit > 0 ? Infinity : 0)
        };

        return {
            overall,
            longStats,
            shortStats,
            equityCurve: state.equityCurve,
            drawdownCurve: state.drawdownCurve,
            trades,
            rejectedTrades: rejected
        };
    }
}

// Make available globally
window.BacktestEngine = BacktestEngine;
window.getDefaultBacktestSettings = getDefaultSettings;
window.loadBacktestSettings = loadBacktestSettings;
console.log('✓ BacktestEngine loaded and available globally');
