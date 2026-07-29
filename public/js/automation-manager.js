/**
 * Automation Manager - Automation Page Logic (مطابق داشبورد)
 * منطق خاص صفحه اتوماسیون - ۱۰۰% شبیه داشبورد
 * Uses shared utilities from: signal-utils.js, visualization.js, ui-utils.js
 */

class AutomationManager {
    constructor() {
        this.symbols = [];
        this.settings = this.getDefaultSettings();
        this.isRunning = false;
        this.automationInterval = null;
        this.currentCycleSymbol = null;
        this.lastUsedSymbol = null;  // ✓ Track last used symbol for restoration
        
        // Market data storage (for signal generation)
        this.marketData = [];
        this.marketDataTimestamp = null;
        this.marketDataSymbol = null;
        
        // Signal storage (تمام سیگنال‌های تولید شده)
        this.signals = [];
        this.signalTimestamp = null;
        this.signalSymbol = null;
        this.selectedSignal = null;  // ✓ Signal ready for entry (only if status is "در انتظار")
        
        // Visualization data
        this.currentSymbolData = [];
        this.currentSymbolHistory = [];
        this.chart = null;
        
        // Settings panel state
        this.settingsPanelCollapsed = false;
        this.lastEntryPriceCache = {};  // Cache for last entry prices per symbol
        
        // Signal generation timestamp for Bale notifications
        this.signalGenerationTime = null;
        
        this.init();
    }

    async init() {
        await this.loadSettings();
        await this.loadSymbols();
        this.loadLogsFromDatabase();
        this.initChart();
        this.bindEvents();
        this.renderSymbolsTable();
        this.updateUIState();

        // Load balance and open positions display (top bar + positions table)
        this.loadBalanceFromDB();
        this.fetchBalanceForBar();
        // First load position history for all symbols (needed for last entry price cache)
        // ✓ loadHistoryForOpenPositions no longer modifies currentSymbolHistory (race condition fixed)
        this.loadHistoryForOpenPositions().then(() => {
            // Then load and display open positions (which uses the history cache)
            this.loadOpenPositionsFromDB();
            this.fetchOpenPositionsForTable();
        });
        
        // ✓ Try to load previous data for the last used symbol
        //   lastUsedSymbol is read from DB first (priority), then localStorage as fallback.
        //   This runs AFTER loadHistoryForOpenPositions to avoid race condition:
        //   loadHistoryForOpenPositions populates lastEntryPriceCache without touching currentSymbolHistory,
        //   then loadAutomationData sets currentSymbolHistory/Signals/marketData for lastUsedSymbol.
        const dbLastUsedSymbol = await this.dbGet('lastUsedSymbol');
        this.lastUsedSymbol = dbLastUsedSymbol || localStorage.getItem('automationLastUsedSymbol');
        
        if (this.lastUsedSymbol) {
            // Try to load data for the last used symbol
            this.loadAutomationData(this.lastUsedSymbol).then(loaded => {
                if (loaded) {
                    this.restoreUIWithLoadedData(this.lastUsedSymbol);
                }
            });
        } else if (this.symbols.length > 0) {
            // Fallback to first symbol if no last used symbol
            const firstSymbol = this.symbols[0];
            this.loadAutomationData(firstSymbol.name).then(loaded => {
                if (loaded) {
                    this.restoreUIWithLoadedData(firstSymbol.name);
                }
            });
        }

        // ✓ Cloudflare Bale fix: Send pending Bale messages from the browser
        // The server (Cron Trigger) can't reach tapi.bale.ai from Cloudflare,
        // so it stores messages in KV. The browser (in Iran) can reach Bale API,
        // so we pick up pending messages and send them directly.
        this.sendPendingBaleMessages();
    }
    
    /**
     * ✓ Cloudflare Bale fix: Send pending Bale messages from the browser
     *
     * پیام‌های بله که از سرور (Cron) قابل ارسال نبودند را از KV می‌خواند
     * و مستقیماً از مرورگر به Bale API ارسال می‌کند.
     */
    async sendPendingBaleMessages() {
        try {
            const pending = await this.dbGet('pendingBaleMessages');
            if (!pending || !Array.isArray(pending) || pending.length === 0) return;

            console.log(`[BaleFix] Found ${pending.length} pending Bale messages to send from browser`);

            let sentCount = 0;
            const failedMessages = [];

            for (const msg of pending) {
                try {
                    const baleUrl = `https://tapi.bale.ai/bot${msg.token}/sendMessage`;
                    await fetch(baleUrl, {
                        method: 'POST',
                        mode: 'no-cors', // ✓ bypass CORS
                        headers: { 'Content-Type': 'text/plain' },
                        body: JSON.stringify({
                            chat_id: String(msg.chatId),
                            text: String(msg.text)
                        })
                    });
                    sentCount++;
                } catch (e) {
                    // Network error — keep the message for next attempt
                    failedMessages.push(msg);
                }
            }

            console.log(`[BaleFix] Sent ${sentCount}/${pending.length} pending messages`);

            // Clear sent messages, keep only failed ones (for retry next time)
            await this.dbSet('pendingBaleMessages', failedMessages);

            if (sentCount > 0) {
                this.log(`${sentCount} پیام بله معوق از مرورگر ارسال شد`, 'success');
            }
        } catch (e) {
            console.warn('[BaleFix] Error sending pending Bale messages:', e);
        }
    }

    restoreUIWithLoadedData(symbolName) {
        // ✓ Restore ALL 8 sections of the automation page from loaded data.
        //   This is called after loadAutomationData() successfully loads data
        //   from the permanent database, so navigating away and returning to
        //   the automation page shows the most recent data.

        let restoredSections = [];

        // 1. "داده‌های بازار" — market data table
        if (this.currentSymbolData && this.currentSymbolData.length > 0) {
            this.populateMarketDataTable();
            restoredSections.push('داده‌های بازار');
        }

        // 2. "جزئیات سیگنال‌ها" + 5. "نمودار قیمت و سیگنال‌ها"
        //    (chart is rendered from currentSymbolData + signals)
        if (this.signals && this.signals.length > 0) {
            this.renderSignalDetails();
            this.renderChart();
            this.updateChartSymbolName(symbolName);
            restoredSections.push('جزئیات سیگنال‌ها + نمودار');
        }

        // 4. "سیگنال آماده برای ورود" — ready signal card
        //    ✓ This is the key addition: previously this section was NOT restored
        //      on page reload, so the ready-signal card was always empty when
        //      returning to the automation page. Now it's restored from DB.
        this.renderSelectedSignal();
        if (this.selectedSignal) {
            restoredSections.push('سیگنال آماده');
        }

        // 3. "سوابق پوزیشن‌ها" — history table
        if (this.currentSymbolHistory && this.currentSymbolHistory.length > 0) {
            this.populateHistoryTable();
            restoredSections.push('سوابق پوزیشن‌ها');
        }

        if (restoredSections.length > 0) {
            this.log(`${symbolName}: داده‌های قبلی بارگذاری شدند (${restoredSections.join('، ')})`, 'success', symbolName);
        }
    }

    initChart() {
        const chartDiv = document.getElementById('price-chart');
        if (chartDiv) {
            this.chart = VisualizationUtils.initChart(chartDiv);
        }
    }

    toggleSettings() {
        const modal = document.getElementById('settings-modal');
        this.settingsPanelCollapsed = !this.settingsPanelCollapsed;
        if (this.settingsPanelCollapsed) {
            modal.classList.add('active');
        } else {
            modal.classList.remove('active');
        }
    }

    getDefaultSettings() {
        return {
            safeAssetPercent: 50,
            maxMarginPerSymbolPercent: 10,
            tradeWaitTime: 60,
            allowedErrors: 3,
            signalExpirationHours: 6,
            minSameDirectionCandles: 0,
            cyclesPerRun: 1,
            closedPositionsNotifyCount: 10,
            // ✓ Fake Breakout Settings
            enableMeaningfulBreakFilter: true,
            breakDetectionMethod: 'Wick',
            enableBreakLifecycleManagement: true,
            breakSequenceLifetime: 0,
            // ✓ فاز ۱: پارامترهای مستقل Long/Short
            // RSI
            rsiLongThreshold: 30,       // لانگ: RSI باید زیر این آستانه باشد (اشباع فروش)
            rsiShortThreshold: 70,     // شورت: RSI باید بالای این آستانه باشد (اشباع خرید)
            // Volume Multiplier
            volMultLong: 0.2,
            volMultShort: 0.2,
            // Leverage
            leverageLong: 4,
            leverageShort: 4,
            // Break ATR Multiplier
            breakAtrMultiplierLong: 0.20,
            breakAtrMultiplierShort: 0.20,
            // Entry Margin %
            entryMarginPercentLong: 5,
            entryMarginPercentShort: 5,
            // Min Price Distance %
            minPriceDistancePercentLong: 0.5,
            minPriceDistancePercentShort: 0.5,
            // Legacy fallback (برای سازگاری به عقب)
            entryMarginPercent: 5,
            minPriceDistancePercent: 0.5,
            leverage: 4,
            breakAtrMultiplier: 0.20,
            // ✓ Task 19: Strategy params (moved from settings.html)
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
            shortFixedSl: 6,
            // Bale (Task 19: moved to settings.html, but kept here for backward compat —
            //   sendBaleNotification() reads from this.settings.baleToken/baleChatId;
            //   loadSettings() syncs them from marketSignalSettings so settings.html
            //   remains the canonical source)
            baleToken: '',
            baleChatId: ''
        };
    }

    async loadSettings() {
        const defaults = this.getDefaultSettings();
        // Start with defaults
        this.settings = { ...defaults };
        
        // Override with localStorage if exists
        const saved = localStorage.getItem('automation_settings');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                this.settings = { ...defaults, ...parsed };
            } catch (e) { /* ignore */ }
        }
        
        // Override with DB if exists (DB takes priority)
        try {
            const dbSettings = await this.dbGet('automation_settings');
            if (dbSettings) {
                const parsed = typeof dbSettings === 'string' ? JSON.parse(dbSettings) : dbSettings;
                this.settings = { ...defaults, ...parsed };
            }
        } catch (e) { /* ignore */ }

        // ✓ Cloudflare-ready: Also sync marketSignalSettings from DB (indicator params + API keys).
        // This ensures the automation page uses the same API keys / indicator config that were
        // saved on the settings page, persisted in the permanent database.
        try {
            const dbMarketSettings = await this.dbGet('marketSignalSettings');
            if (dbMarketSettings) {
                const parsed = typeof dbMarketSettings === 'string' ? JSON.parse(dbMarketSettings) : dbMarketSettings;
                const local = JSON.parse(localStorage.getItem('marketSignalSettings') || '{}');
                // DB takes priority; merge over localStorage
                const merged = { ...local, ...parsed };
                localStorage.setItem('marketSignalSettings', JSON.stringify(merged));
            }
        } catch (e) { /* ignore */ }

        // ✓ Task 19: Cross-source sync.
        //   - Bale settings (baleToken/baleChatId) are now managed by settings.html
        //     (saved to marketSignalSettings). Copy them into this.settings so
        //     sendBaleNotification() picks up the latest values without requiring
        //     the user to re-enter them on automation.html.
        //   - Strategy params (interval, limit, lookback, atrPeriod, rsiPeriod,
        //     avgVolPeriod, tpLongMult, slLongMult, tpShortMult, slShortMult,
        //     longFixedTp, longFixedSl, shortFixedTp, shortFixedSl) — for backward
        //     compat: if this.settings still has defaults (no automation_settings
        //     saved yet) but marketSignalSettings has user-saved values (from the
        //     old settings.html), migrate them into this.settings so the user's
        //     existing configuration is preserved.
        try {
            const mss = JSON.parse(localStorage.getItem('marketSignalSettings') || '{}');
            if (mss && typeof mss === 'object') {
                // Bale — settings.html is canonical source, always wins
                if (typeof mss.baleToken === 'string') this.settings.baleToken = mss.baleToken;
                if (typeof mss.baleChatId === 'string') this.settings.baleChatId = mss.baleChatId;
                // Strategy params — migrate from marketSignalSettings if this.settings
                // still has defaults (i.e., the user hasn't saved automation_settings
                // post-Task-19 yet). Once the user saves from automation.html,
                // this.settings becomes the canonical source.
                const savedAuto = localStorage.getItem('automation_settings');
                if (!savedAuto) {
                    if (mss.interval) this.settings.interval = mss.interval;
                    if (typeof mss.limit === 'number') this.settings.limit = mss.limit;
                    if (typeof mss.lookback === 'number') this.settings.lookback = mss.lookback;
                    if (typeof mss.atrPeriod === 'number') this.settings.atrPeriod = mss.atrPeriod;
                    if (typeof mss.rsiPeriod === 'number') this.settings.rsiPeriod = mss.rsiPeriod;
                    if (typeof mss.avgVolPeriod === 'number') this.settings.avgVolPeriod = mss.avgVolPeriod;
                    if (typeof mss.tpLongMult === 'number') this.settings.tpLongMult = mss.tpLongMult;
                    if (typeof mss.slLongMult === 'number') this.settings.slLongMult = mss.slLongMult;
                    if (typeof mss.tpShortMult === 'number') this.settings.tpShortMult = mss.tpShortMult;
                    if (typeof mss.slShortMult === 'number') this.settings.slShortMult = mss.slShortMult;
                    if (mss.longFixedTp !== undefined) this.settings.longFixedTp = mss.longFixedTp;
                    if (mss.longFixedSl !== undefined) this.settings.longFixedSl = mss.longFixedSl;
                    if (mss.shortFixedTp !== undefined) this.settings.shortFixedTp = mss.shortFixedTp;
                    if (mss.shortFixedSl !== undefined) this.settings.shortFixedSl = mss.shortFixedSl;
                }
            }
        } catch (e) { /* ignore */ }
        
        this.populateSettingsForm();
    }

    saveSettings() {
        this.settings = {
            safeAssetPercent: parseFloat(document.getElementById('safe-asset-percent').value),
            maxMarginPerSymbolPercent: parseFloat(document.getElementById('max-margin-per-symbol-percent').value),
            tradeWaitTime: parseInt(document.getElementById('trade-wait-time').value),
            allowedErrors: parseInt(document.getElementById('allowed-errors').value),
            signalExpirationHours: parseInt(document.getElementById('signal-expiration').value) || 6,
            minSameDirectionCandles: parseInt(document.getElementById('min-same-direction-candles').value) || 0,
            cyclesPerRun: parseInt(document.getElementById('cycles-per-run').value) || 1,
            closedPositionsNotifyCount: parseInt(document.getElementById('closed-positions-notify-count').value) || 10,
            // ✓ Fake Breakout Settings
            enableMeaningfulBreakFilter: document.getElementById('enable-meaningful-break-filter').checked,
            breakDetectionMethod: document.getElementById('break-detection-method').value,
            enableBreakLifecycleManagement: document.getElementById('enable-break-lifecycle').checked,
            breakSequenceLifetime: parseInt(document.getElementById('break-sequence-lifetime').value) || 0,
            // ✓ فاز ۱: پارامترهای مستقل Long/Short
            rsiLongThreshold: parseFloat(document.getElementById('rsi-long-threshold').value) || 30,
            rsiShortThreshold: parseFloat(document.getElementById('rsi-short-threshold').value) || 70,
            volMultLong: parseFloat(document.getElementById('vol-mult-long').value) || 0.2,
            volMultShort: parseFloat(document.getElementById('vol-mult-short').value) || 0.2,
            leverageLong: parseInt(document.getElementById('leverage-long').value) || 4,
            leverageShort: parseInt(document.getElementById('leverage-short').value) || 4,
            breakAtrMultiplierLong: parseFloat(document.getElementById('break-atr-multiplier-long').value) || 0.20,
            breakAtrMultiplierShort: parseFloat(document.getElementById('break-atr-multiplier-short').value) || 0.20,
            entryMarginPercentLong: parseFloat(document.getElementById('entry-margin-percent-long').value) || 5,
            entryMarginPercentShort: parseFloat(document.getElementById('entry-margin-percent-short').value) || 5,
            minPriceDistancePercentLong: parseFloat(document.getElementById('min-price-distance-percent-long').value) || 0.5,
            minPriceDistancePercentShort: parseFloat(document.getElementById('min-price-distance-percent-short').value) || 0.5,
            // Legacy fallback
            entryMarginPercent: parseFloat(document.getElementById('entry-margin-percent-long').value) || 5,
            minPriceDistancePercent: parseFloat(document.getElementById('min-price-distance-percent-long').value) || 0.5,
            leverage: parseInt(document.getElementById('leverage-long').value) || 4,
            breakAtrMultiplier: parseFloat(document.getElementById('break-atr-multiplier-long').value) || 0.20,
            // ✓ Task 19: Strategy params (moved from settings.html — now read from automation.html DOM)
            // Market params
            interval: document.getElementById('interval').value || '1h',
            limit: parseInt(document.getElementById('limit').value) || 1000,
            lookback: parseInt(document.getElementById('lookback').value) || 50,
            // Indicator params
            atrPeriod: parseInt(document.getElementById('atr-period').value) || 14,
            rsiPeriod: parseInt(document.getElementById('rsi-period').value) || 14,
            avgVolPeriod: parseInt(document.getElementById('avg-vol-period').value) || 50,
            // TP/SL multipliers
            tpLongMult: parseFloat(document.getElementById('tp-long-mult').value) || 20,
            slLongMult: parseFloat(document.getElementById('sl-long-mult').value) || 6,
            tpShortMult: parseFloat(document.getElementById('tp-short-mult').value) || 24,
            slShortMult: parseFloat(document.getElementById('sl-short-mult').value) || 4,
            // Fixed TP/SL (empty = null = ATR-based)
            longFixedTp: document.getElementById('long-fixed-tp').value === '' ? null : parseFloat(document.getElementById('long-fixed-tp').value),
            longFixedSl: document.getElementById('long-fixed-sl').value === '' ? null : parseFloat(document.getElementById('long-fixed-sl').value),
            shortFixedTp: document.getElementById('short-fixed-tp').value === '' ? null : parseFloat(document.getElementById('short-fixed-tp').value),
            shortFixedSl: document.getElementById('short-fixed-sl').value === '' ? null : parseFloat(document.getElementById('short-fixed-sl').value),
            // Bale — DOM elements moved to settings.html (Task 19). Preserve existing
            // this.settings.baleToken/baleChatId (which loadSettings() syncs from marketSignalSettings).
            baleToken: this.settings.baleToken || '',
            baleChatId: this.settings.baleChatId || ''
        };
        localStorage.setItem('automation_settings', JSON.stringify(this.settings));
        
        // Also save to DB
        this.dbSet('automation_settings', this.settings);

        // ✓ Task 19: Save HTF Confirmation Source + new strategy params to marketSignalSettings
        // (used by analyzeMarketData fallback AND by the server-side cycle-engine.ts cron —
        //  the backend reads strategy params from marketSignalSettings, so we keep them in sync).
        const htfSource = document.getElementById('htf-confirmation-source').value;
        const marketSettings = JSON.parse(localStorage.getItem('marketSignalSettings') || '{}');
        marketSettings.htfConfirmationSource = htfSource;
        // Sync strategy params (moved from settings.html) so backend cron continues to use latest values
        marketSettings.interval = this.settings.interval;
        marketSettings.limit = this.settings.limit;
        marketSettings.lookback = this.settings.lookback;
        marketSettings.atrPeriod = this.settings.atrPeriod;
        marketSettings.rsiPeriod = this.settings.rsiPeriod;
        marketSettings.avgVolPeriod = this.settings.avgVolPeriod;
        marketSettings.tpLongMult = this.settings.tpLongMult;
        marketSettings.slLongMult = this.settings.slLongMult;
        marketSettings.tpShortMult = this.settings.tpShortMult;
        marketSettings.slShortMult = this.settings.slShortMult;
        marketSettings.longFixedTp = this.settings.longFixedTp;
        marketSettings.longFixedSl = this.settings.longFixedSl;
        marketSettings.shortFixedTp = this.settings.shortFixedTp;
        marketSettings.shortFixedSl = this.settings.shortFixedSl;
        localStorage.setItem('marketSignalSettings', JSON.stringify(marketSettings));
        // ✓ Cloudflare-ready: persist marketSignalSettings (incl. HTF source + strategy params) to permanent DB
        // so server-side run-cycle can read the same indicator configuration.
        this.dbSet('marketSignalSettings', marketSettings);
        this.updateHtfDescription(htfSource);

        this.log('تنظیمات با موفقیت ذخیره شد', 'success');
        UIUtils.showNotification('تنظیمات به‌روز شدند ✓', 'success', 2000);
        this.renderSymbolsTable();
    }

    populateSettingsForm() {
        document.getElementById('safe-asset-percent').value = this.settings.safeAssetPercent;
        document.getElementById('max-margin-per-symbol-percent').value = this.settings.maxMarginPerSymbolPercent;
        document.getElementById('trade-wait-time').value = this.settings.tradeWaitTime;
        document.getElementById('allowed-errors').value = this.settings.allowedErrors;
        document.getElementById('signal-expiration').value = this.settings.signalExpirationHours;
        document.getElementById('min-same-direction-candles').value = this.settings.minSameDirectionCandles || 0;
        document.getElementById('cycles-per-run').value = this.settings.cyclesPerRun || 1;
        document.getElementById('closed-positions-notify-count').value = this.settings.closedPositionsNotifyCount || 10;
        // ✓ Fake Breakout Settings
        document.getElementById('enable-meaningful-break-filter').checked = this.settings.enableMeaningfulBreakFilter !== false;
        document.getElementById('break-detection-method').value = this.settings.breakDetectionMethod || 'Wick';
        document.getElementById('enable-break-lifecycle').checked = this.settings.enableBreakLifecycleManagement !== false;
        document.getElementById('break-sequence-lifetime').value = this.settings.breakSequenceLifetime || 0;
        // ✓ فاز ۱: پارامترهای مستقل Long/Short
        document.getElementById('rsi-long-threshold').value = this.settings.rsiLongThreshold ?? 30;
        document.getElementById('rsi-short-threshold').value = this.settings.rsiShortThreshold ?? 70;
        document.getElementById('vol-mult-long').value = this.settings.volMultLong ?? 0.2;
        document.getElementById('vol-mult-short').value = this.settings.volMultShort ?? 0.2;
        document.getElementById('leverage-long').value = this.settings.leverageLong ?? 4;
        document.getElementById('leverage-short').value = this.settings.leverageShort ?? 4;
        document.getElementById('break-atr-multiplier-long').value = this.settings.breakAtrMultiplierLong ?? 0.20;
        document.getElementById('break-atr-multiplier-short').value = this.settings.breakAtrMultiplierShort ?? 0.20;
        document.getElementById('entry-margin-percent-long').value = this.settings.entryMarginPercentLong ?? 5;
        document.getElementById('entry-margin-percent-short').value = this.settings.entryMarginPercentShort ?? 5;
        document.getElementById('min-price-distance-percent-long').value = this.settings.minPriceDistancePercentLong ?? 0.5;
        document.getElementById('min-price-distance-percent-short').value = this.settings.minPriceDistancePercentShort ?? 0.5;
        // ✓ Task 19: Strategy params (moved from settings.html — populate from this.settings)
        // Market params
        const intervalEl = document.getElementById('interval');
        if (intervalEl) intervalEl.value = this.settings.interval ?? '1h';
        const limitEl = document.getElementById('limit');
        if (limitEl) limitEl.value = this.settings.limit ?? 1000;
        const lookbackEl = document.getElementById('lookback');
        if (lookbackEl) lookbackEl.value = this.settings.lookback ?? 50;
        // Indicator params
        const atrPeriodEl = document.getElementById('atr-period');
        if (atrPeriodEl) atrPeriodEl.value = this.settings.atrPeriod ?? 14;
        const rsiPeriodEl = document.getElementById('rsi-period');
        if (rsiPeriodEl) rsiPeriodEl.value = this.settings.rsiPeriod ?? 14;
        const avgVolPeriodEl = document.getElementById('avg-vol-period');
        if (avgVolPeriodEl) avgVolPeriodEl.value = this.settings.avgVolPeriod ?? 50;
        // TP/SL multipliers
        const tpLongMultEl = document.getElementById('tp-long-mult');
        if (tpLongMultEl) tpLongMultEl.value = this.settings.tpLongMult ?? 20;
        const slLongMultEl = document.getElementById('sl-long-mult');
        if (slLongMultEl) slLongMultEl.value = this.settings.slLongMult ?? 6;
        const tpShortMultEl = document.getElementById('tp-short-mult');
        if (tpShortMultEl) tpShortMultEl.value = this.settings.tpShortMult ?? 24;
        const slShortMultEl = document.getElementById('sl-short-mult');
        if (slShortMultEl) slShortMultEl.value = this.settings.slShortMult ?? 4;
        // Fixed TP/SL (null = empty = ATR-based)
        const longFixedTpEl = document.getElementById('long-fixed-tp');
        if (longFixedTpEl) longFixedTpEl.value = (this.settings.longFixedTp === null || this.settings.longFixedTp === undefined) ? '' : this.settings.longFixedTp;
        const longFixedSlEl = document.getElementById('long-fixed-sl');
        if (longFixedSlEl) longFixedSlEl.value = (this.settings.longFixedSl === null || this.settings.longFixedSl === undefined) ? '' : this.settings.longFixedSl;
        const shortFixedTpEl = document.getElementById('short-fixed-tp');
        if (shortFixedTpEl) shortFixedTpEl.value = (this.settings.shortFixedTp === null || this.settings.shortFixedTp === undefined) ? '' : this.settings.shortFixedTp;
        const shortFixedSlEl = document.getElementById('short-fixed-sl');
        if (shortFixedSlEl) shortFixedSlEl.value = (this.settings.shortFixedSl === null || this.settings.shortFixedSl === undefined) ? '' : this.settings.shortFixedSl;
        // Bale — DOM elements moved to settings.html (Task 19). sendBaleNotification()
        // still reads from this.settings.baleToken/baleChatId (kept in sync by loadSettings()
        // from marketSignalSettings). No form elements to populate on automation.html.

        // Load HTF Confirmation Source from marketSignalSettings
        const marketSettings = JSON.parse(localStorage.getItem('marketSignalSettings') || '{}');
        const htfSource = marketSettings.htfConfirmationSource || 'signalCandleClose';
        document.getElementById('htf-confirmation-source').value = htfSource;
        this.updateHtfDescription(htfSource);
    }

    /**
     * به‌روزرسانی توضیحات گزینه HTF Confirmation
     */
    updateHtfDescription(source) {
        const desc = document.getElementById('htf-source-description');
        if (!desc) return;
        if (source === 'previousDayClose') {
            desc.textContent = 'کلوز آخرین کندل روز قبل با سطوح روز قبل مقایسه می‌شود';
        } else {
            desc.textContent = 'کلوز کندل سیگنال با سطوح روز قبل مقایسه می‌شود';
        }
    }

    async loadSymbols() {
        const saved = localStorage.getItem('automation_symbols');
        if (saved) {
            try {
                this.symbols = JSON.parse(saved);
            } catch (e) {
                this.symbols = [];
            }
        }
        
        // Try DB (takes priority)
        try {
            const dbSymbols = await this.dbGet('automation_symbols');
            if (dbSymbols) {
                const parsed = typeof dbSymbols === 'string' ? JSON.parse(dbSymbols) : dbSymbols;
                if (Array.isArray(parsed) && parsed.length > 0) {
                    this.symbols = parsed;
                }
            }
        } catch (e) { /* ignore */ }
        
        if (!this.symbols || this.symbols.length === 0) {
            this.symbols = [
                { id: 1, name: 'DOT', status: 'waiting', errorCount: 0, lastCycleTime: null },
                { id: 2, name: 'BTC', status: 'waiting', errorCount: 0, lastCycleTime: null },
                { id: 3, name: 'ETH', status: 'waiting', errorCount: 0, lastCycleTime: null }
            ];
            this.saveSymbols();
        }
    }

    saveSymbols() {
        localStorage.setItem('automation_symbols', JSON.stringify(this.symbols));
        this.dbSet('automation_symbols', this.symbols);
    }

    addSymbol(name) {
        if (!name || name.trim() === '') {
            this.log('نام نماد نمی‌تواند خالی باشد', 'error');
            return;
        }

        name = name.trim().toUpperCase();
        
        if (this.symbols.some(s => s.name === name)) {
            this.log(`نماد ${name} قبلاً اضافه شده است`, 'warning');
            return;
        }

        const newSymbol = {
            id: this.symbols.length > 0 ? Math.max(...this.symbols.map(s => s.id)) + 1 : 1,
            name: name,
            status: 'waiting',
            errorCount: 0,
            lastCycleTime: null
        };

        this.symbols.push(newSymbol);
        this.saveSymbols();
        this.renderSymbolsTable();
        this.log(`نماد ${name} با موفقیت اضافه شد`, 'success');
        document.getElementById('new-symbol-name').value = '';
    }

    removeSymbol(id) {
        if (this.currentCycleSymbol && this.currentCycleSymbol.id === id) {
            this.log('نمی‌توان نماد در حال اجرا را حذف کرد', 'error');
            return;
        }

        this.symbols = this.symbols.filter(s => s.id !== id);
        this.saveSymbols();
        this.renderSymbolsTable();
        this.log('نماد با موفقیت حذف شد', 'success');
    }

    clearErrors() {
        this.symbols.forEach(symbol => {
            symbol.errorCount = 0;
            symbol.status = 'waiting';
        });
        this.saveSymbols();
        this.renderSymbolsTable();
        this.log('همه خطاها پاکسازی شدند', 'success');
    }

    selectNextSymbol() {
        const now = Date.now();
        const waitTimeMs = this.settings.tradeWaitTime * 60 * 1000;

        const readySymbols = this.symbols.filter(symbol => {
            if (!symbol.lastCycleTime) {
                return true;
            }

            const elapsedTime = now - symbol.lastCycleTime;
            return elapsedTime >= waitTimeMs;
        });

        return readySymbols.length > 0 ? readySymbols[0] : null;
    }

    getRemainingWaitTime(symbol) {
        if (!symbol.lastCycleTime) return 0;
        
        const now = Date.now();
        const waitTimeMs = this.settings.tradeWaitTime * 60 * 1000;
        const elapsedTime = now - symbol.lastCycleTime;
        const remainingTime = waitTimeMs - elapsedTime;
        
        return Math.max(0, Math.ceil(remainingTime / 60000));
    }

    async fetchMarketData(symbol) {
        try {
            this.log(`${symbol}: دریافت داده‌های بازار...`, 'info', symbol);
            
            const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
            const interval = settings.interval || '1h';
            const limit = settings.limit || 1000;
            
            const fullSymbol = `${symbol}-SWAP-USDT`;
            const url = `/api/toobit-proxy?symbol=${encodeURIComponent(fullSymbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;
            
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            let rawData = await response.json();
            
            if (!Array.isArray(rawData)) {
                throw new Error('داده‌های دریافتی آرایه نیست');
            }
            
            if (rawData.length === 0) {
                throw new Error('هیچ داده‌ای دریافت نشد');
            }
            
            if (!Array.isArray(rawData[0])) {
                throw new Error('فرمت داده نادرست است - باید آرایه‌ای از آرایه‌ها باشد');
            }
            
            this.marketData = rawData;
            this.marketDataTimestamp = Date.now();
            this.marketDataSymbol = symbol;
            
            this.log(`${symbol}: ${this.marketData.length} کندل دریافت و ذخیره شد`, 'success', symbol);
            return true;
        } catch (error) {
            console.error('Fetch Market Data Error:', error);
            throw new Error(`خطا در دریافت داده‌های بازار: ${error.message}`);
        }
    }

    // ==================== سیگنال تحلیل و نمایش (مثل داشبورد) ====================
    
    /**
     * تحلیل داده‌های بازار و تولید تمام سیگنال‌ها
     * (مطابق analyzeData در داشبورد)
     */
    analyzeMarketData(symbol) {
        if (this.marketData.length === 0) {
            throw new Error('داده‌های بازار موجود نیست');
        }

        // ✓ Task 19: Strategy params now read from this.settings (automation_settings),
        //   which is the canonical source after the split from settings.html.
        //   Fall back to marketSignalSettings for backward compat (e.g., if
        //   this.settings hasn't been saved yet, or for legacy users).
        const settings = {
            // Fall back to marketSignalSettings for backward compat
            ...(JSON.parse(localStorage.getItem('marketSignalSettings') || '{}')),
            // Override with automation settings (takes priority)
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
            htfConfirmationSource: document.getElementById('htf-confirmation-source')?.value || 'signalCandleClose',
        };
        // ✓ Phase 17: Independent Long/Short params (fall back to legacy `settings` with ??)
        const autoSettings = this.settings || {};
        const N = this.marketData.length;
        
        // تبدیل داده‌ها به فرمت استفاده شده
        const data = this.marketData.map(c => ({
            timestamp: new Date(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            amount: parseFloat(c[5])
        }));

        // Calculate daily data
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

        // Calculate indicators
        const atr = SignalUtils.calculateATR(data, settings.atrPeriod || 14);
        const avgVols = SignalUtils.calculateSMA(data.map(d => d.amount), settings.avgVolPeriod || 50);
        const rsi = SignalUtils.calculateRSI(data, settings.rsiPeriod || 14);

        // Track crossovers (kept for backward compatibility — used when filters are disabled)
        let lastUL = null, lastOH = null;
        const lastCrossUnderPL = new Array(N).fill(Infinity);
        const lastCrossOverPH = new Array(N).fill(Infinity);
        for (let i = 1; i < N; i++) {
            if (data[i].close < prevDailyLows[i] && data[i - 1].close >= prevDailyLows[i - 1]) lastUL = i;
            if (data[i].close > prevDailyHighs[i] && data[i - 1].close <= prevDailyHighs[i - 1]) lastOH = i;
            lastCrossUnderPL[i] = lastUL === null ? Infinity : i - lastUL;
            lastCrossOverPH[i] = lastOH === null ? Infinity : i - lastOH;
        }

        // ✓ Fake Breakout settings (read from this.settings — Fake Breakout fields live there)
        const fbSettings = (this && this.settings) ? this.settings : {};
        const enableMeaningfulBreakFilter = fbSettings.enableMeaningfulBreakFilter !== false;
        // ✓ Phase 17: Direction-specific break ATR multipliers (fall back to legacy breakAtrMultiplier)
        const breakAtrMultiplierLong = (fbSettings.breakAtrMultiplierLong !== undefined && fbSettings.breakAtrMultiplierLong !== null)
            ? fbSettings.breakAtrMultiplierLong
            : ((fbSettings.breakAtrMultiplier !== undefined && fbSettings.breakAtrMultiplier !== null)
                ? fbSettings.breakAtrMultiplier : 0.20);
        const breakAtrMultiplierShort = (fbSettings.breakAtrMultiplierShort !== undefined && fbSettings.breakAtrMultiplierShort !== null)
            ? fbSettings.breakAtrMultiplierShort
            : ((fbSettings.breakAtrMultiplier !== undefined && fbSettings.breakAtrMultiplier !== null)
                ? fbSettings.breakAtrMultiplier : 0.20);
        const breakDetectionMethod = fbSettings.breakDetectionMethod === 'Close' ? 'Close' : 'Wick';
        const enableBreakLifecycleManagement = fbSettings.enableBreakLifecycleManagement !== false;
        const breakSequenceLifetime = (fbSettings.breakSequenceLifetime !== undefined && fbSettings.breakSequenceLifetime !== null)
            ? fbSettings.breakSequenceLifetime : 0;

        // ✓ Track meaningful breaks (used when enableMeaningfulBreakFilter is true)
        //   A meaningful break for Long = price goes BELOW prevDailyLow by (atr * breakAtrMultiplierLong)
        //   A meaningful break for Short = price goes ABOVE prevDailyHigh by (atr * breakAtrMultiplierShort)
        const lastMeaningfulBreakLong = new Array(N).fill(Infinity);
        const lastMeaningfulBreakShort = new Array(N).fill(Infinity);
        {
            let lastMBL = null, lastMBS = null;
            for (let i = 1; i < N; i++) {
                // ✓ Phase 17: Direction-specific ATR multipliers
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

        // Generate signals
        this.signals = [];
        const htfSource = settings.htfConfirmationSource || 'signalCandleClose';

        // ✓ Break Lifecycle State Machine (used when enableBreakLifecycleManagement is true)
        const resetBreakState = () => ({
            active: false,
            type: null,           // 'Long' | 'Short' | null
            breakCandleIndex: null,
            waitingRecovery: false,
            recovered: false,
            recoveryCandleIndex: null
        });
        let breakState = resetBreakState();

        for (let i = 1; i < N - 1; i++) {
            // HTF confirmation (always computed — used by both branches)
            let htfConfirmLong, htfConfirmShort;
            if (htfSource === 'previousDayClose') {
                htfConfirmLong = prevDayCloses[i] !== null && prevDayCloses[i] > prevDailyLows[i];
                htfConfirmShort = prevDayCloses[i] !== null && prevDayCloses[i] < prevDailyHighs[i];
            } else {
                // Default: Signal Candle Close
                htfConfirmLong = prevDailyLows[i] !== null && data[i].close > prevDailyLows[i];
                htfConfirmShort = prevDailyHighs[i] !== null && data[i].close < prevDailyHighs[i];
            }

            data[i].rsi = rsi[i];
            data[i].atr = atr[i];

            if (enableBreakLifecycleManagement) {
                // ===========================================================
                // ✓ Fake Breakout: Break Lifecycle Management state machine
                //   Signal is generated at the RECOVERY candle (price closing
                //   back inside the prior day range), not at the break candle.
                // ===========================================================

                // Compute meaningful break conditions for this candle
                // ✓ Phase 17: Direction-specific ATR multipliers
                const breakDistanceLong = (atr[i] || 0) * breakAtrMultiplierLong;
                const breakDistanceShort = (atr[i] || 0) * breakAtrMultiplierShort;
                let isMeaningfulBreakLong = false;
                let isMeaningfulBreakShort = false;
                if (breakDetectionMethod === 'Wick') {
                    isMeaningfulBreakLong = prevDailyLows[i] !== null && data[i].low <= (prevDailyLows[i] - breakDistanceLong);
                    isMeaningfulBreakShort = prevDailyHighs[i] !== null && data[i].high >= (prevDailyHighs[i] + breakDistanceShort);
                } else {
                    isMeaningfulBreakLong = prevDailyLows[i] !== null && data[i].close <= (prevDailyLows[i] - breakDistanceLong);
                    isMeaningfulBreakShort = prevDailyHighs[i] !== null && data[i].close >= (prevDailyHighs[i] + breakDistanceShort);
                }

                // 1. Check expiry — if a break has been waiting too long without recovery, discard it
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
                        // Recovery: price closes back above Previous Daily Low
                        if (data[i].close > prevDailyLows[i]) {
                            breakState.recovered = true;
                            breakState.recoveryCandleIndex = i;
                            breakState.waitingRecovery = false;
                        }
                    } else if (breakState.type === 'Short') {
                        // Recovery: price closes back below Previous Daily High
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
                            this.signals.push({
                                type: 'Long',
                                timestamp: data[i].timestamp,
                                price: data[i].close,
                                tp: data[i].tp,
                                sl: data[i].sl,
                                orderId: data[i].clientOrderId,
                                symbol: symbol,
                                // ✓ مورد ۶: candle index — used by min-same-direction-candles risk control
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
                            this.signals.push({
                                type: 'Short',
                                timestamp: data[i].timestamp,
                                price: data[i].close,
                                tp: data[i].tp,
                                sl: data[i].sl,
                                orderId: data[i].clientOrderId,
                                symbol: symbol,
                                // ✓ مورد ۶: candle index — used by min-same-direction-candles risk control
                                candleIndex: i
                            });
                        }
                    }

                    // Reset after signal generation (break is consumed whether or not signal was generated)
                    breakState = resetBreakState();
                }
            } else {
                // ===========================================================
                // ✓ Backward compatible: original logic (with optional meaningful break filter)
                //   When enableMeaningfulBreakFilter is false → EXACT original behavior
                //   When enableMeaningfulBreakFilter is true  → prior-break crossover check
                //     is replaced with the meaningful break check (filter out weak breaks)
                // ===========================================================
                const isCrossOverPL = data[i].close > prevDailyLows[i] && data[i - 1].close <= prevDailyLows[i - 1];
                const isCrossUnderPH = data[i].close < prevDailyHighs[i] && data[i - 1].close >= prevDailyHighs[i - 1];

                // Recent prior break — use meaningful break tracker when filter is enabled,
                // otherwise use plain crossover tracker (original behavior)
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
                    this.signals.push({
                        type: 'Long',
                        timestamp: data[i].timestamp,
                        price: data[i].close,
                        tp: data[i].tp,
                        sl: data[i].sl,
                        orderId: data[i].clientOrderId,
                        symbol: symbol,
                        // ✓ مورد ۶: candle index — used by min-same-direction-candles risk control
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
                    this.signals.push({
                        type: 'Short',
                        timestamp: data[i].timestamp,
                        price: data[i].close,
                        tp: data[i].tp,
                        sl: data[i].sl,
                        orderId: data[i].clientOrderId,
                        symbol: symbol,
                        // ✓ مورد ۶: candle index — used by min-same-direction-candles risk control
                        candleIndex: i
                    });
                }
            }
        }

        // Store processed data
        this.currentSymbolData = data;
        this.signalTimestamp = Date.now();
        this.signalSymbol = symbol;

        this.log(`${symbol}: ${this.signals.length} سیگنال تولید شد`, 'success', symbol);
    }

    /**
     * محاسبه وضعیت سیگنال (در انتظار / باز شده / بسته شده)
     * (کپی از داشبورد)
     */
    /**
     * ✓ محاسبه وضعیت سیگنال (در انتظار / باز شده / باز نشده / منقضی شده)
     *
     * ✓ منطق انقضای سیگنال (مورد ۴):
     *   اگر اختلاف زمان فعلی و زمان صدور سیگنال بیشتر از signalExpirationHours باشد
     *   و پوزیشن هم‌جهتی برای آن نماد باز نشده باشد → وضعیت: «منقضی شده»
     */
    calculateSignalStatus(signal) {
        // Handle case where currentSymbolHistory is not yet loaded
        if (!this.currentSymbolHistory || !Array.isArray(this.currentSymbolHistory)) {
            const isLatest = this.signals.indexOf(signal) === this.signals.length - 1;
            // ✓ Check expiration even without history
            if (isLatest && this.isSignalExpired(signal)) {
                return { text: 'منقضی شده', color: 'text-orange-400' };
            }
            return {
                text: isLatest ? 'در انتظار' : 'باز نشده',
                color: isLatest ? 'text-yellow-400' : 'text-gray-400'
            };
        }
        
        // Filter OPEN positions with same direction as signal
        // BUY_OPEN → Long, SELL_OPEN → Short
        const signalDirection = signal.type === 'Long' ? 'BUY' : 'SELL';
        const openPositions = this.currentSymbolHistory.filter(pos => 
            pos.side && pos.side.includes('OPEN') && pos.side.includes(signalDirection)
        );
        
        const currentIndex = this.signals.indexOf(signal);
        const nextSignal = currentIndex < this.signals.length - 1 ? this.signals[currentIndex + 1] : null;
        
        const currentTime = signal.timestamp.getTime();
        const nextTime = nextSignal ? nextSignal.timestamp.getTime() : Infinity;
        
        // Match: same-direction OPEN position in time range [T_i, T_{i+1})
        const matchingPositions = openPositions.filter(pos => {
            const posTime = pos.time.getTime();
            return posTime >= currentTime && posTime < nextTime;
        });
        
        if (matchingPositions.length === 0) {
            // No matching position found
            const isLatest = currentIndex === this.signals.length - 1;
            
            // ✓ Check if signal is expired (مورد ۴)
            if (isLatest && this.isSignalExpired(signal)) {
                return { text: 'منقضی شده', color: 'text-orange-400' };
            }
            
            return {
                text: isLatest ? 'در انتظار' : 'باز نشده',
                color: isLatest ? 'text-yellow-400' : 'text-gray-400'
            };
        }
        
        const earliestPosition = matchingPositions.reduce((earliest, current) => {
            return current.time.getTime() < earliest.time.getTime() ? current : earliest;
        });
        
        return {
            text: earliestPosition.time.toLocaleString('fa-IR', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            }),
            color: 'text-green-400'
        };
    }

    /**
     * ✓ بررسی انقضای سیگنال (مورد ۴)
     *
     * اگر اختلاف زمان فعلی و زمان صدور سیگنال بیشتر از signalExpirationHours باشد → true
     */
    isSignalExpired(signal) {
        if (!signal || !signal.timestamp) return false;
        const signalTime = signal.timestamp instanceof Date 
            ? signal.timestamp.getTime() 
            : new Date(signal.timestamp).getTime();
        const now = Date.now();
        const expirationMs = (this.settings.signalExpirationHours || 6) * 60 * 60 * 1000;
        return (now - signalTime) > expirationMs;
    }

    /**
     * آماده‌سازی برای شروع یک چرخه یا نماد جدید - پاک کردن تمام داده‌های قدیمی
     */
    setupForCycle() {
        console.log('[SetupForCycle] Clearing all data for new cycle/symbol');
        
        // Clear all data
        this.currentSymbolData = [];
        this.currentSymbolHistory = [];
        this.signals = [];
        this.selectedSignal = null;
        this.signalTimestamp = null;
        this.signalSymbol = null;
        
        // Clear all UI sections
        this.clearMarketDataTable();
        this.clearSignalDetails();
        this.clearSelectedSignal();
        this.clearHistoryTable();
        this.renderChart(); // This will do nothing since data is empty
        
        console.log('[SetupForCycle] All data and UI cleared');
    }
    
    clearMarketDataTable() {
        const tbody = document.getElementById('market-data-body');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="12" class="px-4 py-8 text-center text-gray-400">داده‌ای برای نمایش وجود ندارد</td></tr>';
        }
    }
    
    clearSignalDetails() {
        const list = document.getElementById('signal-list');
        if (list) {
            list.innerHTML = `
                <div class="text-center text-gray-400 py-8">
                    <i class="fas fa-chart-line text-4xl mb-4"></i>
                    <div>سیگنالی برای نمایش وجود ندارد</div>
                </div>
            `;
        }
    }
    
    clearSelectedSignal() {
        const container = document.getElementById('ready-signal-container');
        if (container) {
            container.innerHTML = `
                <div class="text-center text-gray-400 py-8">
                    <i class="fas fa-ban text-4xl mb-4"></i>
                    <div>بدون سیگنال</div>
                </div>
            `;
        }
    }
    
    clearHistoryTable() {
        const tbody = document.getElementById('history-table-body');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-gray-400">داده‌ای برای نمایش وجود ندارد</td></tr>';
        }
    }

    /**
     * نمایش جزئیات تمام سیگنال‌های تولید شده
     * (دقیقاً مثل داشبورد)
     */
    renderSignalDetails() {
        const list = document.getElementById('signal-list');
        list.innerHTML = '';
        
        if (this.signals.length === 0) {
            list.innerHTML = `
                <div class="text-center text-gray-400 py-8">
                    <i class="fas fa-chart-line text-4xl mb-4"></i>
                    <div>سیگنالی تولید نشد</div>
                    <div class="text-sm mt-2">شرایط بازار برای تولید سیگنال مناسب نیست</div>
                </div>
            `;
            return;
        }
        
        this.signals.slice().reverse().forEach(signal => {
            const signalCard = document.createElement('div');
            signalCard.className = `glass-effect rounded-lg p-4 ${
                signal.type === 'Long' ? 'border-r-4 border-green-500' : 'border-r-4 border-red-500'
            }`;
            
            const symbolFull = `${this.signalSymbol || '-'}-SWAP-USDT`;
            const status = this.calculateSignalStatus(signal);
            
            signalCard.innerHTML = `
                <div class="flex justify-between items-start">
                    <div class="flex-1">
                        <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                            <!-- Column 1 -->
                            <div class="space-y-2">
                                <div>
                                    <span class="text-lg font-bold ${
                                        signal.type === 'Long' ? 'text-green-400' : 'text-red-400'
                                    }">${signal.type}</span>
                                    <span class="text-xs text-gray-400 bg-gray-700 px-2 py-1 rounded mr-2">
                                        ${signal.timestamp.toLocaleString('fa-IR')}
                                    </span>
                                </div>
                                <div>
                                    <span class="text-gray-400 ml-1">قیمت ورود:</span>
                                    <span style="font-family: 'Vazirmatn', sans-serif;">${signal.price.toFixed(4)}</span>
                                </div>
                                <div>
                                    <span class="text-gray-400 ml-1">حد سود:</span>
                                    <span class="text-green-400" style="font-family: 'Vazirmatn', sans-serif;">${signal.tp.toFixed(4)}</span>
                                </div>
                                <div>
                                    <span class="text-gray-400 ml-1">کد سفارش:</span>
                                    <span class="text-xs text-gray-300" style="font-family: 'Vazirmatn', sans-serif;">${signal.orderId}</span>
                                </div>
                            </div>
                            
                            <!-- Column 2 -->
                            <div class="space-y-2">
                                <div>
                                    <span class="text-gray-400 ml-1">نماد:</span>
                                    <span class="text-xs" style="font-family: 'Vazirmatn', sans-serif;">${symbolFull}</span>
                                </div>
                                <div>
                                    <span class="text-gray-400 ml-1">وضعیت:</span>
                                    <span class="text-xs ${status.color}" style="font-family: 'Vazirmatn', sans-serif;">${status.text}</span>
                                </div>
                                <div>
                                    <span class="text-gray-400 ml-1">حد ضرر:</span>
                                    <span class="text-red-400" style="font-family: 'Vazirmatn', sans-serif;">${signal.sl.toFixed(4)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            list.appendChild(signalCard);
        });
        
        // ✓ Issue #7: Auto-update ready signal section after signal details are updated
        this.updateSelectedSignal();
    }

    /**
     * نمایش سیگنال آماده برای ورود (فقط آخرین سیگنال با وضعیت "در انتظار")
     */
    renderSelectedSignal() {
        const container = document.getElementById('ready-signal-container');
        
        if (!this.selectedSignal) {
            container.innerHTML = `
                <div class="text-center text-gray-400 py-8">
                    <i class="fas fa-ban text-4xl mb-4"></i>
                    <div>بدون سیگنال</div>
                </div>
            `;
            return;
        }
        
        const signal = this.selectedSignal;
        const symbolFull = `${this.signalSymbol || '-'}-SWAP-USDT`;
        
        const card = document.createElement('div');
        card.className = `glass-effect rounded-lg p-6 border-l-4 ${
            signal.type === 'Long' ? 'border-green-500' : 'border-red-500'
        }`;
        
        card.innerHTML = `
            <div class="flex justify-between items-center mb-4">
                <div>
                    <span class="text-2xl font-bold ${
                        signal.type === 'Long' ? 'text-green-400' : 'text-red-400'
                    }">${signal.type}</span>
                    <span class="text-xs text-gray-400 bg-gray-700 px-3 py-1 rounded ml-3">
                        وضعیت: در انتظار ✓
                    </span>
                </div>
                <div class="text-right">
                    <div class="text-sm text-gray-400">زمان سیگنال</div>
                    <div class="text-xs text-gray-300">${signal.timestamp.toLocaleString('fa-IR')}</div>
                </div>
            </div>
            
            <div class="grid grid-cols-4 gap-4">
                <div class="bg-gray-700 rounded p-3">
                    <div class="text-xs text-gray-400 mb-1">نماد</div>
                    <div class="text-sm font-semibold" style="font-family: 'Vazirmatn', sans-serif;">${symbolFull}</div>
                </div>
                <div class="bg-gray-700 rounded p-3">
                    <div class="text-xs text-gray-400 mb-1">قیمت ورود</div>
                    <div class="text-sm font-semibold text-blue-400" style="font-family: 'Vazirmatn', sans-serif;">${signal.price.toFixed(4)}</div>
                </div>
                <div class="bg-gray-700 rounded p-3">
                    <div class="text-xs text-gray-400 mb-1">حد سود</div>
                    <div class="text-sm font-semibold text-green-400" style="font-family: 'Vazirmatn', sans-serif;">${signal.tp.toFixed(4)}</div>
                </div>
                <div class="bg-gray-700 rounded p-3">
                    <div class="text-xs text-gray-400 mb-1">حد ضرر</div>
                    <div class="text-sm font-semibold text-red-400" style="font-family: 'Vazirmatn', sans-serif;">${signal.sl.toFixed(4)}</div>
                </div>
            </div>
            
            <div class="mt-4 text-xs text-gray-400 bg-gray-800 p-3 rounded">
                <div>کد سفارش: <span class="text-gray-300" style="font-family: 'Vazirmatn', sans-serif;">${signal.orderId}</span></div>
            </div>
        `;
        
        container.innerHTML = '';
        container.appendChild(card);
    }

    /**
     * تعیین سیگنال آماده برای ورود (آخرین سیگنال با وضعیت "در انتظار")
     */
    updateSelectedSignal() {
        this.selectedSignal = null;
        
        if (this.signals.length === 0) {
            return;
        }
        
        const latestSignal = this.signals[this.signals.length - 1];
        const status = this.calculateSignalStatus(latestSignal);
        
        console.log(`[UpdateSelectedSignal] Checking latest signal:`, {
            signalType: latestSignal.type,
            signalTime: latestSignal.timestamp,
            statusText: status.text,
            isPending: status.text === 'در انتظار',
            isExpired: status.text === 'منقضی شده'
        });
        
        // Only select if the latest signal is in "در انتظار" status
        // ✓ Expired signals ("منقضی شده") are NOT selected — they can't be traded
        if (status.text === 'در انتظار') {
            this.selectedSignal = latestSignal;
            console.log('[UpdateSelectedSignal] Signal selected for entry');
        } else if (status.text === 'منقضی شده') {
            console.log('[UpdateSelectedSignal] Signal is expired — not selected for entry');
        } else {
            console.log('[UpdateSelectedSignal] No signal ready - status is not "در انتظار"');
        }
        
        // Always render the UI
        this.renderSelectedSignal();
    }

    /**
     * رندر کردن نمودار با علامت‌های Long، Short و Close
     * (دقیقاً مثل داشبورد)
     */
    /**
     * ✓ بروزرسانی برچسب نماد در هدر نمودار
     */
    updateChartSymbolName(symbol) {
        const el = document.getElementById('chart-symbol-name');
        if (!el) return;
        if (symbol) {
            const fullSym = `${symbol}-SWAP-USDT`;
            el.textContent = fullSym;
            el.style.display = 'inline-block';
        } else {
            el.style.display = 'none';
        }
    }

    renderChart() {
        if (this.currentSymbolData.length === 0) return;
        
        // Prepare candlestick data
        const candlestickData = this.currentSymbolData.map(c => [c.open, c.close, c.low, c.high]);
        
        // Prepare signal markers
        const longSignals = [];
        const shortSignals = [];
        
        this.currentSymbolData.forEach((c, idx) => {
            if (c.signal === 'Long') {
                longSignals.push([idx, c.low * 0.999]);
            } else if (c.signal === 'Short') {
                shortSignals.push([idx, c.high * 1.001]);
            }
        });
        
        // Prepare CLOSE position markers from history data
        const closePositions = [];
        if (this.currentSymbolHistory && this.currentSymbolHistory.length > 0) {
            const closeEntries = this.currentSymbolHistory.filter(pos => 
                pos.side && pos.side.includes('CLOSE')
            );
            
            closeEntries.forEach(closePos => {
                const closeTime = closePos.time.getTime();
                let closestIdx = -1;
                let minDiff = Infinity;
                
                this.currentSymbolData.forEach((candle, idx) => {
                    const diff = Math.abs(candle.timestamp.getTime() - closeTime);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestIdx = idx;
                    }
                });
                
                if (closestIdx >= 0) {
                    closePositions.push([closestIdx, closePos.price]);
                }
            });
        }
        
        // Determine zoom range
        const startPercent = Math.max(0, 80);
        const endPercent = 100;
        
        const option = {
            backgroundColor: 'transparent',
            title: {
                text: '',
                left: 'center',
                textStyle: { color: '#ffffff' }
            },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross' },
                backgroundColor: 'rgba(50, 50, 50, 0.9)',
                borderColor: '#777',
                textStyle: { color: '#fff' }
            },
            legend: {
                data: ['قیمت', 'Long', 'Short', 'بسته شده'],
                textStyle: { color: '#ffffff' },
                top: 10
            },
            grid: {
                left: '10%',
                right: '10%',
                bottom: '20%',
                top: '15%'
            },
            xAxis: {
                type: 'category',
                data: this.currentSymbolData.map(d => d.timestamp.toLocaleString('fa-IR', { 
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' 
                })),
                scale: true,
                boundaryGap: true,
                axisLine: { lineStyle: { color: '#8392A5' } },
                splitLine: { show: false },
                axisLabel: { 
                    rotate: 45,
                    color: '#9ca3af',
                    fontSize: 10
                },
                min: 'dataMin',
                max: 'dataMax'
            },
            yAxis: {
                type: 'value',
                scale: true,
                splitArea: { show: false },
                axisLine: { lineStyle: { color: '#8392A5' } },
                axisLabel: { color: '#9ca3af' },
                splitLine: { lineStyle: { color: '#374151' } }
            },
            dataZoom: [
                {
                    type: 'inside',
                    start: startPercent,
                    end: endPercent
                },
                {
                    show: true,
                    type: 'slider',
                    bottom: '5%',
                    start: startPercent,
                    end: endPercent,
                    textStyle: { color: '#fff' },
                    borderColor: '#667eea',
                    fillerColor: 'rgba(102, 126, 234, 0.2)',
                    handleStyle: {
                        color: '#667eea'
                    }
                }
            ],
            series: [
                {
                    name: 'قیمت',
                    type: 'candlestick',
                    data: candlestickData,
                    itemStyle: {
                        color: '#10b981',
                        color0: '#ef4444',
                        borderColor: '#10b981',
                        borderColor0: '#ef4444'
                    }
                },
                {
                    name: 'Long',
                    type: 'scatter',
                    data: longSignals,
                    symbol: 'triangle',
                    symbolSize: 12,
                    symbolRotate: 0,
                    itemStyle: {
                        color: '#10b981',
                        borderColor: '#fff',
                        borderWidth: 1
                    },
                    zlevel: 2
                },
                {
                    name: 'Short',
                    type: 'scatter',
                    data: shortSignals,
                    symbol: 'triangle',
                    symbolSize: 12,
                    symbolRotate: 180,
                    itemStyle: {
                        color: '#ef4444',
                        borderColor: '#fff',
                        borderWidth: 1
                    },
                    zlevel: 2
                },
                {
                    name: 'بسته شده',
                    type: 'scatter',
                    data: closePositions,
                    symbol: 'arrow',
                    symbolSize: 10,
                    symbolRotate: 90,
                    itemStyle: {
                        color: '#fbbf24',
                        borderColor: '#fff',
                        borderWidth: 1
                    },
                    zlevel: 2
                }
            ]
        };
        
        if (this.chart) {
            this.chart.setOption(option, true);
        }
    }

    /**
     * جدول داده‌های بازار با ۱۲ ستون (دقیقاً مثل داشبورد)
     * ✓ سورت بر حسب زمان به صورت نزولی (جدیدترین در بالا)
     */
    populateMarketDataTable() {
        const tbody = document.getElementById('market-data-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        
        if (!this.currentSymbolData || this.currentSymbolData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="12" class="px-4 py-8 text-center text-gray-400">داده‌ای برای نمایش وجود ندارد</td></tr>';
            return;
        }
        
        // ✓ Sort by timestamp DESC (newest first)
        const sortedData = [...this.currentSymbolData].sort((a, b) => {
            const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
            const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
            return tb - ta; // descending
        });
        
        sortedData.forEach(candle => {
            const row = document.createElement('tr');
            row.className = 'border-b border-gray-700 hover:bg-gray-700';
            const signalClass = candle.signal === 'Long' ? 'text-green-400 font-bold' : 
                               candle.signal === 'Short' ? 'text-red-400 font-bold' : '';
            
            row.innerHTML = `
                <td class="px-4 py-3">${candle.timestamp.toLocaleString('fa-IR')}</td>
                <td class="px-4 py-3">${candle.open.toFixed(4)}</td>
                <td class="px-4 py-3">${candle.close.toFixed(4)}</td>
                <td class="px-4 py-3">${candle.high.toFixed(4)}</td>
                <td class="px-4 py-3">${candle.low.toFixed(4)}</td>
                <td class="px-4 py-3">${candle.amount.toFixed(2)}</td>
                <td class="px-4 py-3">${candle.rsi ? candle.rsi.toFixed(2) : '-'}</td>
                <td class="px-4 py-3">${candle.atr ? candle.atr.toFixed(4) : '-'}</td>
                <td class="px-4 py-3 ${signalClass}">${candle.signal || '-'}</td>
                <td class="px-4 py-3">${candle.tp ? candle.tp.toFixed(4) : '-'}</td>
                <td class="px-4 py-3">${candle.sl ? candle.sl.toFixed(4) : '-'}</td>
                <td class="px-4 py-3 text-xs">${candle.clientOrderId || '-'}</td>
            `;
            tbody.appendChild(row);
        });
    }

    /**
     * جدول سوابق پوزیشن‌ها
     * ✓ سورت بر حسب زمان به صورت نزولی (جدیدترین در بالا)
     */
    populateHistoryTable() {
        const tbody = document.getElementById('history-table-body');
        if (!tbody) {
            console.error('[PopulateHistory] history-table-body element not found');
            return;
        }
        
        console.log(`[PopulateHistory] Called with ${this.currentSymbolHistory.length} items`);
        tbody.innerHTML = '';
        
        // Ensure currentSymbolHistory is an array
        const historyData = Array.isArray(this.currentSymbolHistory) ? this.currentSymbolHistory : [];
        
        console.log(`[PopulateHistory] Data after validation: ${historyData.length} items`);
        
        if (historyData.length === 0) {
            console.log('[PopulateHistory] No history data, showing empty message');
            tbody.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-gray-400">داده‌ای برای نمایش وجود ندارد</td></tr>';
            return;
        }
        
        console.log('[PopulateHistory] Rendering history rows...');
        let successCount = 0;
        let errorCount = 0;
        
        // ✓ Sort by time DESC (newest first)
        const sortedHistory = [...historyData].sort((a, b) => {
            const ta = a.time instanceof Date ? a.time.getTime() : new Date(a.time).getTime();
            const tb = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
            return tb - ta; // descending
        });
        
        sortedHistory.forEach((item, index) => {
            try {
                const row = document.createElement('tr');
                row.className = 'border-b border-gray-700 hover:bg-gray-700';
                
                // Safer PnL color assignment
                let pnlClass = '';
                const pnl = parseFloat(item.realizedPnl);
                if (!isNaN(pnl)) {
                    pnlClass = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : '';
                }
                
                // Safe data extraction with validation
                const time = item.time instanceof Date ? item.time.toLocaleString('fa-IR') : '-';
                const symbol = String(item.symbol || '-');
                const price = !isNaN(parseFloat(item.price)) ? parseFloat(item.price).toFixed(4) : '-';
                const qty = !isNaN(parseFloat(item.qty)) ? parseFloat(item.qty).toFixed(2) : '-';
                const commission = !isNaN(parseFloat(item.commission)) ? parseFloat(item.commission).toFixed(4) : '-';
                const side = String(item.side || '-');
                const pnlDisplay = !isNaN(pnl) ? pnl.toFixed(4) : '-';
                
                row.innerHTML = `
                    <td class="px-4 py-3">${time}</td>
                    <td class="px-4 py-3">${symbol}</td>
                    <td class="px-4 py-3">${price}</td>
                    <td class="px-4 py-3">${qty}</td>
                    <td class="px-4 py-3">${commission}</td>
                    <td class="px-4 py-3">${side}</td>
                    <td class="px-4 py-3 ${pnlClass}">${pnlDisplay}</td>
                `;
                tbody.appendChild(row);
                successCount++;
            } catch (err) {
                console.error('[PopulateHistory] Error rendering row at index ' + index + ':', err, item);
                errorCount++;
            }
        });
        
        console.log(`[PopulateHistory] Rendering complete - ${successCount} rows rendered, ${errorCount} errors`);
    }

    // ==================== اپدیت و نمایش ویژولایزیشن ====================
    
    updateVisualization(symbol, marketData) {
        // Clear previous data (but NOT currentSymbolHistory - it's needed for signal status calculation)
        this.currentSymbolData = [];
        // NOTE: this.currentSymbolHistory is intentionally NOT cleared here.
        // History must be preserved so calculateSignalStatus() can determine
        // whether each signal was opened or not. Clearing is done only in
        // setupForCycle() at the start of a brand-new cycle.
        this.signals = [];
        
        // Clear UI
        document.getElementById('market-data-body').innerHTML = '';
        document.getElementById('signal-list').innerHTML = '';
        
        try {
            // Analyze market and generate signals
            this.analyzeMarketData(symbol);
            
            // ✓ Update chart symbol name label
            this.updateChartSymbolName(symbol);
            
            // Populate all sections in order
            this.populateMarketDataTable();
            this.renderSignalDetails();
            this.renderChart();
            
            // Save to database
            this.saveAutomationData(symbol);
            
            this.log(`${symbol}: داده‌ها و سیگنال‌ها به‌روز شدند`, 'success', symbol);
        } catch (error) {
            this.log(`${symbol}: خطا در به‌روز رسانی: ${error.message}`, 'error', symbol);
        }
    }

    // ==================== ذخیره و بارگذاری از دیتابیس ====================

    /**
     * ذخیره تمام داده‌های اتوماسیون در دیتابیس
     *
     * ✓ Cloudflare-ready: All 8 sections of the automation page persist to the
     *   permanent database (KV in Cloudflare) so that navigating away and
     *   returning to the page restores the most recent data.
     *
     * Sections persisted (per symbol):
     *   1. "داده‌های بازار"      → marketData_{symbol}
     *   2. "جزئیات سیگنال‌ها"    → signals_{symbol}
     *   3. "سوابق پوزیشن‌ها"     → history_{symbol}
     *   4. "سیگنال آماده برای ورود" → selectedSignal_{symbol}
     *
     * Sections persisted (global, not per-symbol):
     *   5. "نمودار قیمت و سیگنال‌ها" → rendered from marketData + signals (no separate key needed)
     *   6. "گزارش چرخه‌ها"        → already persisted via log() → /api/db/logs
     *   7. "لیست نمادها"         → automation_symbols (handled in saveSymbols())
     *   8. "پوزیشن‌های باز"       → openPositions (handled in fetchOpenPositionsForTable())
     *   + balance bar            → balance (handled in fetchBalanceForBar())
     *
     * Each save REPLACES the previous value for the same key (no append),
     * so the latest data always overwrites the old data.
     */
    async saveAutomationData(symbol) {
        try {
            // Save market data (داده‌های بازار) — replaces previous
            if (this.currentSymbolData && this.currentSymbolData.length > 0) {
                const marketDataPayload = {
                    symbol: symbol,
                    data: this.currentSymbolData.map(d => ({
                        timestamp: d.timestamp.getTime(),
                        open: d.open,
                        high: d.high,
                        low: d.low,
                        close: d.close,
                        amount: d.amount,
                        rsi: d.rsi || null,
                        atr: d.atr || null,
                        signal: d.signal || null,
                        tp: d.tp || null,
                        sl: d.sl || null,
                        clientOrderId: d.clientOrderId || null
                    })),
                    timestamp: Date.now(),
                    metadata: {
                        signalsCount: this.signals.length,
                        dataPointsCount: this.currentSymbolData.length
                    }
                };
                localStorage.setItem(`automation_market_${symbol}`, JSON.stringify(marketDataPayload));
                // ✓ Always overwrite with latest raw market data (used for chart + market table)
                await this.dbSet(`marketData_${symbol}`, this.marketData);
                // ✓ Also store the processed candle data (with rsi/atr/signal/tp/sl) so it can be
                //   restored exactly as shown in the market data table + chart on page reload.
                await this.dbSet(`processedData_${symbol}`, this.currentSymbolData.map(d => ({
                    timestamp: d.timestamp.getTime(),
                    open: d.open,
                    high: d.high,
                    low: d.low,
                    close: d.close,
                    amount: d.amount,
                    rsi: d.rsi || null,
                    atr: d.atr || null,
                    signal: d.signal || null,
                    tp: d.tp || null,
                    sl: d.sl || null,
                    clientOrderId: d.clientOrderId || null
                })));
            }

            // Save signals (جزئیات سیگنال‌ها) — replaces previous
            if (this.signals && this.signals.length > 0) {
                const signalsPayload = {
                    symbol: symbol,
                    signals: this.signals.map(s => ({
                        type: s.type,
                        timestamp: s.timestamp.getTime(),
                        price: s.price,
                        tp: s.tp,
                        sl: s.sl,
                        orderId: s.orderId,
                        symbol: s.symbol
                    })),
                    timestamp: Date.now()
                };
                localStorage.setItem(`automation_signals_${symbol}`, JSON.stringify(signalsPayload));
                await this.dbSet(`signals_${symbol}`, this.signals);
            } else {
                // ✓ Clear any previously saved signals so stale data doesn't persist
                await this.dbSet(`signals_${symbol}`, []);
            }

            // Save position history (سوابق پوزیشن‌ها) — replaces previous
            if (this.currentSymbolHistory && this.currentSymbolHistory.length > 0) {
                const historyPayload = {
                    symbol: symbol,
                    history: this.currentSymbolHistory.map(h => ({
                        time: h.time.getTime(),
                        symbol: h.symbol,
                        price: h.price,
                        qty: h.qty,
                        commission: h.commission,
                        side: h.side,
                        realizedPnl: h.realizedPnl
                    })),
                    timestamp: Date.now()
                };
                localStorage.setItem(`automation_history_${symbol}`, JSON.stringify(historyPayload));
                await this.dbSet(`history_${symbol}`, this.currentSymbolHistory);
            }

            // ✓ Save the ready signal (سیگنال آماده برای ورود) — replaces previous
            //    This persists the selectedSignal so it's restored when returning to the page.
            if (this.selectedSignal) {
                const selectedSignalPayload = {
                    symbol: symbol,
                    signal: {
                        type: this.selectedSignal.type,
                        timestamp: this.selectedSignal.timestamp.getTime(),
                        price: this.selectedSignal.price,
                        tp: this.selectedSignal.tp,
                        sl: this.selectedSignal.sl,
                        orderId: this.selectedSignal.orderId,
                        symbol: this.selectedSignal.symbol
                    },
                    signalSymbol: this.signalSymbol || symbol,
                    signalTimestamp: this.signalTimestamp || null,
                    signalGenerationTime: this.signalGenerationTime ? this.signalGenerationTime.getTime() : null,
                    savedAt: Date.now()
                };
                await this.dbSet(`selectedSignal_${symbol}`, selectedSignalPayload);
            } else {
                // No ready signal — clear any previously saved one
                await this.dbSet(`selectedSignal_${symbol}`, null);
            }

            // ✓ Persist lastUsedSymbol to DB (not just localStorage) so it survives
            //   cross-device/cross-browser access in Cloudflare deployment.
            if (symbol) {
                await this.dbSet('lastUsedSymbol', symbol);
            }
        } catch (error) {
            console.warn(`Failed to save automation data for ${symbol}:`, error);
        }
    }

    /**
     * بارگذاری داده‌های اتوماسیون از دیتابیس
     *
     * ✓ Cloudflare-ready: Restores all per-symbol sections from the permanent
     *   database so that returning to the automation page shows the most recent
     *   data — even after navigating to other pages or closing the browser.
     *
     * Sections restored (per symbol):
     *   1. "داده‌های بازار"      ← processedData_{symbol} (preferred) or marketData_{symbol}
     *   2. "جزئیات سیگنال‌ها"    ← signals_{symbol}
     *   3. "سوابق پوزیشن‌ها"     ← history_{symbol}
     *   4. "سیگنال آماده برای ورود" ← selectedSignal_{symbol}
     *   5. "نمودار قیمت و سیگنال‌ها" ← rebuilt from currentSymbolData + signals (in restoreUIWithLoadedData)
     *
     * Sections restored (global, handled elsewhere in init()):
     *   6. "گزارش چرخه‌ها"        ← loadLogsFromDatabase()
     *   7. "لیست نمادها"         ← loadSymbols()
     *   8. "پوزیشن‌های باز"       ← loadOpenPositionsFromDB()
     *   + balance bar            ← loadBalanceFromDB()
     */
    async loadAutomationData(symbol) {
        try {
            // ✓ Try DB first for PROCESSED market data (includes rsi/atr/signal/tp/sl columns)
            //    This is preferred over raw marketData because it has all the indicator values
            //    needed to fully restore the "داده‌های بازار" table + chart.
            let loadedFromDB = false;
            try {
                const dbProcessed = await this.dbGet(`processedData_${symbol}`);
                if (dbProcessed) {
                    const processedData = typeof dbProcessed === 'string' ? JSON.parse(dbProcessed) : dbProcessed;
                    if (Array.isArray(processedData) && processedData.length > 0) {
                        this.currentSymbolData = processedData.map(d => ({
                            ...d,
                            timestamp: new Date(d.timestamp)
                        }));
                        loadedFromDB = true;
                    }
                }
            } catch (e) { /* ignore */ }

            // ✓ Fall back to raw marketData_{symbol}
            //    This can be in TWO formats:
            //      (a) Array of objects {timestamp, open, high, low, close, amount} — saved by newer code
            //      (b) Array of arrays [ts, open, high, low, close, volume, ...] — raw Toobit API format
            //    We detect the format and normalize to objects.
            if (!loadedFromDB) {
                try {
                    const dbMarket = await this.dbGet(`marketData_${symbol}`);
                    if (dbMarket) {
                        const marketData = typeof dbMarket === 'string' ? JSON.parse(dbMarket) : dbMarket;
                        if (Array.isArray(marketData) && marketData.length > 0) {
                            // Detect format: if first item is an array → raw Toobit format
                            if (Array.isArray(marketData[0])) {
                                this.currentSymbolData = marketData.map(c => ({
                                    timestamp: new Date(c[0]),
                                    open: parseFloat(c[1]),
                                    high: parseFloat(c[2]),
                                    low: parseFloat(c[3]),
                                    close: parseFloat(c[4]),
                                    amount: parseFloat(c[5])
                                }));
                            } else {
                                // Object format
                                this.currentSymbolData = marketData.map(d => ({
                                    timestamp: new Date(d.timestamp),
                                    open: d.open,
                                    high: d.high,
                                    low: d.low,
                                    close: d.close,
                                    amount: d.amount,
                                    rsi: d.rsi || null,
                                    atr: d.atr || null,
                                    signal: d.signal || null,
                                    tp: d.tp || null,
                                    sl: d.sl || null,
                                    clientOrderId: d.clientOrderId || null
                                }));
                            }
                            loadedFromDB = true;
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            if (!loadedFromDB) {
                // Load market data from localStorage (legacy fallback)
                const marketDataStr = localStorage.getItem(`automation_market_${symbol}`);
                if (marketDataStr) {
                    try {
                        const marketData = JSON.parse(marketDataStr);
                        if (Array.isArray(marketData.data)) {
                            this.currentSymbolData = marketData.data.map(d => ({
                                ...d,
                                timestamp: new Date(d.timestamp)
                            }));
                        }
                    } catch (e) {
                        console.warn('Failed to parse market data:', e);
                        this.currentSymbolData = [];
                    }
                } else {
                    this.currentSymbolData = [];
                }
            }

            // ✓ Try DB first for signals (جزئیات سیگنال‌ها)
            let signalsFromDB = false;
            try {
                const dbSignals = await this.dbGet(`signals_${symbol}`);
                if (dbSignals) {
                    const signalsData = typeof dbSignals === 'string' ? JSON.parse(dbSignals) : dbSignals;
                    if (Array.isArray(signalsData)) {
                        this.signals = signalsData.map(s => ({
                            ...s,
                            timestamp: new Date(s.timestamp)
                        }));
                        this.signalSymbol = symbol;
                        signalsFromDB = true;
                    }
                }
            } catch (e) { /* ignore */ }

            if (!signalsFromDB) {
                // Load signals from localStorage (legacy fallback)
                const signalsStr = localStorage.getItem(`automation_signals_${symbol}`);
                if (signalsStr) {
                    try {
                        const signalsData = JSON.parse(signalsStr);
                        if (Array.isArray(signalsData.signals)) {
                            this.signals = signalsData.signals.map(s => ({
                                ...s,
                                timestamp: new Date(s.timestamp)
                            }));
                            this.signalTimestamp = signalsData.timestamp;
                            this.signalSymbol = symbol;
                        }
                    } catch (e) {
                        console.warn('Failed to parse signals:', e);
                        this.signals = [];
                    }
                } else {
                    this.signals = [];
                }
            }

            // ✓ Try DB first for history (سوابق پوزیشن‌ها)
            let historyFromDB = false;
            try {
                const dbHistory = await this.dbGet(`history_${symbol}`);
                if (dbHistory) {
                    const historyData = typeof dbHistory === 'string' ? JSON.parse(dbHistory) : dbHistory;
                    if (Array.isArray(historyData)) {
                        this.currentSymbolHistory = historyData.map(h => ({
                            ...h,
                            time: new Date(h.time)
                        }));
                        historyFromDB = true;
                    }
                }
            } catch (e) { /* ignore */ }

            if (!historyFromDB) {
                // Load position history from localStorage (legacy fallback)
                const historyStr = localStorage.getItem(`automation_history_${symbol}`);
                if (historyStr) {
                    try {
                        const historyData = JSON.parse(historyStr);
                        if (Array.isArray(historyData.history)) {
                            this.currentSymbolHistory = historyData.history.map(h => ({
                                ...h,
                                time: new Date(h.time)
                            }));
                        } else {
                            this.currentSymbolHistory = [];
                        }
                    } catch (e) {
                        console.warn('Failed to parse history:', e);
                        this.currentSymbolHistory = [];
                    }
                } else {
                    this.currentSymbolHistory = [];
                }
            }

            // ✓ Load the ready signal (سیگنال آماده برای ورود) from DB
            //    This restores the "selectedSignal" so the ready-signal card shows
            //    the same signal that was ready before navigating away.
            try {
                const dbSelectedSignal = await this.dbGet(`selectedSignal_${symbol}`);
                if (dbSelectedSignal) {
                    const payload = typeof dbSelectedSignal === 'string' ? JSON.parse(dbSelectedSignal) : dbSelectedSignal;
                    if (payload && payload.signal) {
                        this.selectedSignal = {
                            type: payload.signal.type,
                            timestamp: new Date(payload.signal.timestamp),
                            price: payload.signal.price,
                            tp: payload.signal.tp,
                            sl: payload.signal.sl,
                            orderId: payload.signal.orderId,
                            symbol: payload.signal.symbol
                        };
                        // Restore associated state
                        if (payload.signalSymbol) this.signalSymbol = payload.signalSymbol;
                        if (payload.signalTimestamp) this.signalTimestamp = payload.signalTimestamp;
                        if (payload.signalGenerationTime) {
                            this.signalGenerationTime = new Date(payload.signalGenerationTime);
                        }
                    } else {
                        this.selectedSignal = null;
                    }
                } else {
                    this.selectedSignal = null;
                }
            } catch (e) {
                this.selectedSignal = null;
            }

            return true;
        } catch (error) {
            console.warn(`Failed to load automation data for ${symbol}:`, error);
            return false;
        }
    }

    /**
     * حذف داده‌های اتوماسیون برای نماد
     */
    clearAutomationData(symbol) {
        localStorage.removeItem(`automation_market_${symbol}`);
        localStorage.removeItem(`automation_signals_${symbol}`);
        localStorage.removeItem(`automation_history_${symbol}`);
    }

    // ==================== چرخه اتوماسیون ====================

    async dbGet(key) {
        try {
            const response = await fetch(`/api/db/automation-state?key=${encodeURIComponent(key)}`);
            if (!response.ok) return null;
            const result = await response.json();
            // API returns { success: true, data: value }
            if (result.success && result.data !== undefined && result.data !== null) {
                return result.data;
            }
            return null;
        } catch (e) {
            console.warn(`dbGet failed for key ${key}:`, e);
            return null;
        }
    }

    async dbSet(key, value) {
        try {
            await fetch('/api/db/automation-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value })
            });
        } catch (e) {
            console.warn(`dbSet failed for key ${key}:`, e);
        }
    }

    async dbDelete(key) {
        try {
            await fetch(`/api/db/automation-state?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
        } catch (e) {
            console.warn(`dbDelete failed for key ${key}:`, e);
        }
    }

    async runCycle() {
        const symbol = this.selectNextSymbol();
        
        if (!symbol) {
            this.log('هیچ نمادی برای معامله آماده نیست', 'warning');
            return false;
        }

        this.currentCycleSymbol = symbol;
        // ✓ FIX: Don't set status to 'running' in KV — keep as 'waiting'.
        //   Only set lastCycleTime (prevents duplicate symbol selection).
        //   Status 'running' was never being reset back to 'waiting' in KV,
        //   causing all symbols to show "در حال اجرا" permanently.
        symbol.lastCycleTime = Date.now();
        this.saveSymbols(); // Persist to localStorage + DB immediately
        this.renderSymbolsTable();
        this.log(`شروع چرخه برای نماد ${symbol.name}`, 'info', symbol.name);

        try {
            // ✓ Step 1: Clear all data at the beginning of cycle/symbol
            console.log('[RunCycle] Step 1: Clearing all data for new symbol');
            this.setupForCycle();
            
            // 2. Fetch market data
            console.log('[RunCycle] Step 2: Fetching market data');
            await this.fetchMarketData(symbol.name);
            
            // 3. Update visualization with signal analysis (generates signals)
            console.log('[RunCycle] Step 3: Generating signals');
            this.updateVisualization(symbol.name, this.marketData);
            
            // Record signal generation time for Bale notifications
            this.signalGenerationTime = new Date();
            
            // 4. Check if signals were generated
            if (this.signals.length === 0) {
                throw new Error('NO_SIGNAL_GENERATED');
            }
            
            this.log(`${symbol.name}: ${this.signals.length} سیگنال تولید شد`, 'info', symbol.name);

            // 5. Fetch position history
            console.log('[RunCycle] Step 4: Fetching position history');
            this.log(`${symbol.name}: دریافت تاریخچه معاملات...`, 'info', symbol.name);
            const history = await this.fetchPositionHistory(symbol.name);
            
            // history is already mapped and formatted from fetchPositionHistory
            this.currentSymbolHistory = Array.isArray(history) ? history : [];
            console.log(`[RunCycle] Set currentSymbolHistory with ${this.currentSymbolHistory.length} items`);
            
            this.log(`${symbol.name}: ${this.currentSymbolHistory.length} معامله یافت شد`, 'success', symbol.name);
            
            // ✓ Save the current symbol as the last used symbol so it can be restored on next page load
            this.lastUsedSymbol = symbol.name;
            localStorage.setItem('automationLastUsedSymbol', symbol.name);
            this.dbSet('lastUsedSymbol', symbol.name);
            
            // 6. Update visualization with history
            console.log('[RunCycle] Step 5: Rendering all visualizations');
            this.renderSignalDetails();
            this.populateHistoryTable();
            this.renderChart();
            this.updateChartSymbolName(symbol.name);
            
            // ✓ Step 6: Check signal status AFTER signal generation (this is critical!)
            console.log('[RunCycle] Step 6: Checking signal status - MUST be after signal generation');
            this.updateSelectedSignal();
            
            // ✓ Step 7: Only proceed if we have a signal ready for entry
            if (!this.selectedSignal) {
                this.log(`${symbol.name}: هیچ سیگنالی برای ورود آماده نیست - از این نماد عبور میشود`, 'warning', symbol.name);
                symbol.status = 'waiting';
                symbol.lastCycleTime = Date.now();
                symbol.errorCount = 0;
                this.saveSymbols();
                this.renderSymbolsTable();
                this.currentCycleSymbol = null;
                return false;
            }
            
            console.log('[RunCycle] Step 7: Signal is ready for entry - proceeding with position opening');
            
            // Save position history to database
            await this.saveAutomationData(symbol.name);

            // 8. Fetch current price
            this.log(`${symbol.name}: دریافت قیمت...`, 'info', symbol.name);
            const price = await this.fetchPrice(symbol.name);
            this.log(`${symbol.name}: قیمت فعلی = ${price}`, 'success', symbol.name);

            // ===================================================================
            // ✓ Step 8: Close opposite positions (بستن پوزیشن‌های مخالف)
            // This MUST happen BEFORE refreshing the tables so the tables reflect
            // the post-close state (the symbol we're about to control may have been
            // closed here, meaning it no longer has an open position to check).
            // ===================================================================
            this.log(`${symbol.name}: بررسی پوزیشن‌های مخالف...`, 'info', symbol.name);
            const closeResult = await this.closeOppositePositions(symbol.name, this.selectedSignal.type);
            const closedCount = closeResult.closed || 0;
            const closedPositionInfo = closeResult.closedPositionInfo || null;
            if (closedCount > 0) {
                this.log(`${symbol.name}: ${closedCount} پوزیشن مخالف بسته شد`, 'success', symbol.name);
            } else {
                this.log(`${symbol.name}: پوزیشن مخالفی یافت نشد`, 'info', symbol.name);
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
            const minSameDir = this.settings.minSameDirectionCandles || 0;
            if (minSameDir > 0) {
                const sigIdx = typeof this.selectedSignal.candleIndex === 'number' ? this.selectedSignal.candleIndex : -1;
                if (sigIdx < 0) {
                    this.log(`${symbol.name}: شماره کندل سیگنال نامشخص — کنترل کندل هم‌جهت skip شد`, 'warning', symbol.name);
                } else {
                    const candlesAfterSignal = (this.currentSymbolData ? this.currentSymbolData.length : 0) - sigIdx - 1;
                    if (candlesAfterSignal < minSameDir) {
                        // Not enough candles after the signal yet
                        const checkedIdxsNotEnough = [];
                        for (let k = 1; k <= candlesAfterSignal; k++) checkedIdxsNotEnough.push(sigIdx + k);
                        const checkedListNotEnough = checkedIdxsNotEnough.length > 0 ? checkedIdxsNotEnough.join('، ') : '—';
                        const mathNotEnough =
                            `سیگنال روی کندل ${sigIdx} صادر شده\n` +
                            `حداقل کندل هم‌جهت مورد نیاز = ${minSameDir}\n` +
                            `کندل‌های موجود بعد از سیگنال: ${candlesAfterSignal} (کندل ${checkedListNotEnough})\n` +
                            `نتیجه: تعداد کندل کافی نیست — صبر کنید تا کندل‌های بیشتری تشکیل شوند`;
                        this.log(`${symbol.name}: کندل‌های هم‌جهت کافی نیست (${candlesAfterSignal} < ${minSameDir}) — رد شد`, 'warning', symbol.name);
                        await this.notifyRiskControlBlocked(symbol.name, this.selectedSignal, {
                            controlName: 'حداقل کندل هم‌جهت (Min Same-Direction Candles)',
                            math: mathNotEnough
                        });
                        symbol.status = 'waiting';
                        symbol.lastCycleTime = Date.now();
                        symbol.errorCount = 0;
                        this.saveSymbols();
                        this.renderSymbolsTable();
                        this.currentCycleSymbol = null;
                        return false;
                    }

                    // Check each of the N candles after the signal
                    const checkedIdxs = [];
                    for (let k = 1; k <= minSameDir; k++) checkedIdxs.push(sigIdx + k);
                    const candleLines = [];
                    let failedIdx = null;
                    let failedReason = '';
                    for (let k = 1; k <= minSameDir; k++) {
                        const ci = sigIdx + k;
                        const c = this.currentSymbolData[ci];
                        if (!c) {
                            // Should not happen, but guard
                            candleLines.push(`کندل ${ci}: موجود نیست ✗`);
                            failedIdx = ci;
                            failedReason = 'موجود نیست';
                            break;
                        }
                        const isGreen = c.close > c.open;
                        const isRed = c.close < c.open;
                        if (this.selectedSignal.type === 'Long') {
                            if (isGreen) {
                                candleLines.push(`کندل ${ci}: سبز (close > open) ✓`);
                            } else {
                                candleLines.push(`کندل ${ci}: قرمز (close < open) ✗ — کندل مخالف سیگنال لانگ`);
                                failedIdx = ci;
                                failedReason = 'قرمز (close < open) — کندل مخالف سیگنال لانگ';
                                break;
                            }
                        } else {
                            if (isRed) {
                                candleLines.push(`کندل ${ci}: قرمز (close < open) ✓`);
                            } else {
                                candleLines.push(`کندل ${ci}: سبز (close > open) ✗ — کندل مخالف سیگنال شورت`);
                                failedIdx = ci;
                                failedReason = 'سبز (close > open) — کندل مخالف سیگنال شورت';
                                break;
                            }
                        }
                    }

                    if (failedIdx !== null) {
                        const mathFail =
                            `سیگنال روی کندل ${sigIdx} صادر شده\n` +
                            `حداقل کندل هم‌جهت مورد نیاز = ${minSameDir}\n` +
                            `کندل‌های بررسی شده: ${checkedIdxs.join('، ')}\n` +
                            `${candleLines.join('\n')}\n` +
                            `نتیجه: شرایط برقرار نیست — پوزیشن باز نشد`;
                        this.log(`${symbol.name}: کندل مخالف سیگنال یافت شد (کندل ${failedIdx}: ${failedReason}) — رد شد`, 'warning', symbol.name);
                        await this.notifyRiskControlBlocked(symbol.name, this.selectedSignal, {
                            controlName: 'حداقل کندل هم‌جهت (Min Same-Direction Candles)',
                            math: mathFail
                        });
                        symbol.status = 'waiting';
                        symbol.lastCycleTime = Date.now();
                        symbol.errorCount = 0;
                        this.saveSymbols();
                        this.renderSymbolsTable();
                        this.currentCycleSymbol = null;
                        return false;
                    }

                    this.log(`${symbol.name}: ${minSameDir} کندل هم‌جهت تأیید شد (کندل‌های ${checkedIdxs.join('، ')})`, 'success', symbol.name);
                }
            }

            // ===================================================================
            // ✓ Step 9 (NEW): Refresh "سوابق پوزیشن‌ها" (position history) table
            // Fetch fresh history AFTER closing opposite positions so the history
            // reflects the latest state (including any newly-closed positions).
            // This history is used to compute the "آخرین ورود" column in step 10.
            // ===================================================================
            this.log(`${symbol.name}: بروزرسانی جدول سوابق پوزیشن‌ها...`, 'info', symbol.name);
            try {
                const freshHistory = await this.fetchPositionHistory(symbol.name);
                this.currentSymbolHistory = Array.isArray(freshHistory) ? freshHistory : [];
                this.populateHistoryTable();
                this.log(`${symbol.name}: جدول سوابق پوزیشن‌ها بروزرسانی شد (${this.currentSymbolHistory.length} ردیف)`, 'success', symbol.name);
            } catch (e) {
                this.log(`${symbol.name}: خطا در بروزرسانی سوابق پوزیشن‌ها - ${e.message}`, 'warning', symbol.name);
            }

            // ===================================================================
            // ✓ Step 10 (NEW): Refresh "پوزیشن‌های باز" (open positions) table +
            //   compute "آخرین ورود" column from the fresh history (step 9).
            //   This replaces the old getSymbolMargin() call.
            //   The open positions data is stored in `this.freshOpenPositions` for
            //   use by the risk controls in step 12.
            // ===================================================================
            this.log(`${symbol.name}: بروزرسانی جدول پوزیشن‌های باز...`, 'info', symbol.name);
            let freshOpenPositions = [];
            try {
                const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
                const opResponse = await fetch('/api/open-positions', {
                    headers: {
                        'X-API-Key': settings.apiKey,
                        'X-Secret-Key': settings.secretKey,
                        'X-Base-Url': settings.baseUrl || 'https://api.toobit.com'
                    }
                });
                if (opResponse.ok) {
                    const opData = await opResponse.json();
                    freshOpenPositions = opData.positions || opData.data || [];
                    // ✓ Compute "آخرین ورود" for each position from the fresh history
                    // Populate lastEntryPriceCache for all symbols in open positions
                    const opSymbols = [...new Set(freshOpenPositions.map(p => {
                        const sym = p.symbol || '';
                        return sym.replace('-SWAP-USDT', '').replace('USDT', '');
                    }).filter(s => s))];
                    for (const sym of opSymbols) {
                        // Fetch history for this symbol if different from current cycle symbol
                        if (sym === symbol.name) {
                            // Use the already-fetched currentSymbolHistory
                            this.getLastEntryPrice(sym, 'long', this.currentSymbolHistory);
                            this.getLastEntryPrice(sym, 'short', this.currentSymbolHistory);
                        } else {
                            // Fetch history for other symbols
                            const hist = await this.fetchPositionHistory(sym);
                            if (Array.isArray(hist) && hist.length > 0) {
                                this.getLastEntryPrice(sym, 'long', hist);
                                this.getLastEntryPrice(sym, 'short', hist);
                            }
                        }
                    }
                    // Display the fresh open positions (with computed "آخرین ورود")
                    this.displayOpenPositions(freshOpenPositions);
                    // Save to DB
                    await this.dbSet('openPositions', freshOpenPositions);
                    this.log(`${symbol.name}: جدول پوزیشن‌های باز بروزرسانی شد (${freshOpenPositions.length} پوزیشن)`, 'success', symbol.name);
                }
            } catch (e) {
                this.log(`${symbol.name}: خطا در بروزرسانی پوزیشن‌های باز - ${e.message}`, 'warning', symbol.name);
            }

            // ===================================================================
            // ✓ Step 11: Fetch balance (for margin calculation)
            // ===================================================================
            this.log(`${symbol.name}: دریافت موجودی حساب...`, 'info', symbol.name);
            const balanceForMargin = await this.fetchBalance();
            const totalAssets = balanceForMargin.total;
            const freeBalance = balanceForMargin.free;
            this.log(`${symbol.name}: کل دارایی = ${totalAssets} USDT, آزاد = ${freeBalance} USDT`, 'success', symbol.name);
            
            // Update balance bar
            const totalEl = document.getElementById('balance-total');
            const marginEl = document.getElementById('balance-position-margin');
            const freeEl = document.getElementById('balance-free');
            if (totalEl) totalEl.textContent = totalAssets || '-';
            if (marginEl) marginEl.textContent = balanceForMargin.positionMargin || '-';
            if (freeEl) freeEl.textContent = freeBalance || '-';
            
            // Save balance to DB
            await this.dbSet('balance', balanceForMargin);

            // ===================================================================
            // ✓ Step 12: Calculate new margin + Risk Controls
            // ===================================================================
            this.log(`${symbol.name}: محاسبه مارجین (${this.settings.entryMarginPercent}% از کل دارایی)...`, 'info', symbol.name);
            const newMargin = this.calculateNewMargin(totalAssets);
            this.log(`${symbol.name}: مارجین محاسبه شده = ${newMargin} USDT`, 'success', symbol.name);

            // ===================================================================
            // ✓ Control 2 (الف): Safe Asset Check — ALWAYS runs
            // ===================================================================
            const safeCheck = this.checkSafeAsset(totalAssets, freeBalance, newMargin);
            if (!safeCheck.safe) {
                this.log(`${symbol.name}: دارایی امن کافی نیست (آزاد ${freeBalance} - مارجین ${newMargin} = ${safeCheck.projectedFree.toFixed(2)} < دارایی امن ${safeCheck.safeAmount.toFixed(2)}) — رد شد`, 'warning', symbol.name);
                await this.notifyRiskControlBlocked(symbol.name, this.selectedSignal, {
                    controlName: 'دارایی امن (Safe Asset)',
                                        math:
                        `کل دارایی = ${totalAssets.toFixed(4)} USDT\n` +
                        `موجودی آزاد = ${freeBalance.toFixed(4)} USDT\n` +
                        `مارجین ورودی جدید = ${newMargin.toFixed(4)} USDT\n` +
                        `درصد دارایی امن = ${this.settings.safeAssetPercent}%\n` +
                        `دارایی امن = ${totalAssets.toFixed(4)} × ${this.settings.safeAssetPercent}% = ${safeCheck.safeAmount.toFixed(4)} USDT\n` +
                        `موجودی آزاد پیش‌بینی‌شده = ${freeBalance.toFixed(4)} - ${newMargin.toFixed(4)} = ${safeCheck.projectedFree.toFixed(4)} USDT\n` +
                        `${safeCheck.projectedFree.toFixed(4)} < ${safeCheck.safeAmount.toFixed(4)} ✗`
                });
                symbol.status = 'waiting';
                symbol.lastCycleTime = Date.now();
                symbol.errorCount = 0;
                this.saveSymbols();
                this.renderSymbolsTable();
                this.currentCycleSymbol = null;
                return false;
            }

            // ===================================================================
            // ✓ Controls 3 & 4: Price Distance + Max Margin Per Symbol
            //   NEW LOGIC: Only run if the current cycle symbol is in the open
            //   positions table (freshOpenPositions from step 10).
            //   If the symbol is NOT in open positions → skip both controls.
            // ===================================================================
            const fullSymbolName = `${symbol.name}-SWAP-USDT`;
            const symbolPosition = freshOpenPositions.find(p => {
                const posSymbol = (p.symbol || '').toString().toUpperCase();
                return posSymbol === fullSymbolName.toUpperCase();
            });

            if (symbolPosition) {
                // Symbol IS in open positions table → run controls 3 & 4
                this.log(`${symbol.name}: نماد در پوزیشن‌های باز یافت شد — اجرای کنترل‌های فاصله قیمت و سقف مارجین`, 'info', symbol.name);

                // ── Control 3: Price Distance Check ──────────────────────────────
                // ✓ Read "آخرین ورود" from lastEntryPriceCache (keyed by symbol:direction)
                const signalDirection = this.selectedSignal.type === 'Long' ? 'long' : 'short';
                const lastEntryPrice = this.lastEntryPriceCache[`${symbol.name}:${signalDirection}`] || this.lastEntryPriceCache[`${fullSymbolName}:${signalDirection}`] || null;

                if (lastEntryPrice !== null && lastEntryPrice !== undefined) {
                    const currentPrice = price;
                    let distancePercent;
                    if (this.selectedSignal.type === 'Long') {
                        // Long: current should be lower than last entry (cheaper = better)
                        distancePercent = ((lastEntryPrice - currentPrice) / lastEntryPrice) * 100;
                    } else {
                        // Short: current should be higher than last entry (more expensive = better)
                        distancePercent = ((currentPrice - lastEntryPrice) / lastEntryPrice) * 100;
                    }
                    
                    if (distancePercent < this.settings.minPriceDistancePercent) {
                        this.log(`${symbol.name}: فاصله قیمت کافی نیست (آخرین ورود: ${lastEntryPrice}, فعلی: ${currentPrice}, فاصله: ${distancePercent.toFixed(2)}% < ${this.settings.minPriceDistancePercent}%) — رد شد`, 'warning', symbol.name);
                        const distanceFormula = this.selectedSignal.type === 'Long'
                            ? `فاصله = (آخرین ورود - فعلی) / آخرین ورود × 100\nفاصله = (${lastEntryPrice} - ${currentPrice}) / ${lastEntryPrice} × 100`
                            : `فاصله = (فعلی - آخرین ورود) / آخرین ورود × 100\nفاصله = (${currentPrice} - ${lastEntryPrice}) / ${lastEntryPrice} × 100`;
                        await this.notifyRiskControlBlocked(symbol.name, this.selectedSignal, {
                            controlName: 'فاصله قیمت (Price Distance)',
                                                        math:
                                `آخرین قیمت ورود هم‌جهت = ${lastEntryPrice}\n` +
                                `قیمت فعلی = ${currentPrice}\n` +
                                `جهت سیگنال = ${this.selectedSignal.type === 'Long' ? 'لانگ' : 'شورت'}\n` +
                                `${distanceFormula}\n` +
                                `فاصله = ${distancePercent.toFixed(4)}%\n` +
                                `حداقل فاصله قیمت = ${this.settings.minPriceDistancePercent}%\n` +
                                `${distancePercent.toFixed(4)}% < ${this.settings.minPriceDistancePercent}% ✗`
                        });
                        symbol.status = 'waiting';
                        symbol.lastCycleTime = Date.now();
                        symbol.errorCount = 0;
                        this.saveSymbols();
                        this.renderSymbolsTable();
                        this.currentCycleSymbol = null;
                        return false;
                    }
                    this.log(`${symbol.name}: فاصله قیمت OK (${distancePercent.toFixed(2)}% ≥ ${this.settings.minPriceDistancePercent}%)`, 'success', symbol.name);
                } else {
                    this.log(`${symbol.name}: آخرین ورود هم‌جهت در تاریخچه یافت نشد — کنترل قیمت انجام نشد`, 'info', symbol.name);
                }

                // ── Control 4: Max Margin Per Symbol ────────────────────────────
                // ✓ Read "مارجین موجود نماد" from the "مارجین" column of the open positions table
                const existingSymbolMargin = parseFloat(symbolPosition.margin || 0);
                const maxMarginPerSymbol = totalAssets * (this.settings.maxMarginPerSymbolPercent / 100);
                const totalSymbolMargin = existingSymbolMargin + newMargin;
                if (totalSymbolMargin > maxMarginPerSymbol) {
                    this.log(`${symbol.name}: سقف مارجین نماد (${totalSymbolMargin.toFixed(2)} > ${maxMarginPerSymbol.toFixed(2)} USDT) — رد شد`, 'warning', symbol.name);
                    await this.notifyRiskControlBlocked(symbol.name, this.selectedSignal, {
                        controlName: 'سقف مارجین نماد (Max Margin Per Symbol)',
                                                math:
                            `کل دارایی = ${totalAssets.toFixed(4)} USDT\n` +
                            `درصد سقف مارجین نماد = ${this.settings.maxMarginPerSymbolPercent}%\n` +
                            `سقف مارجین نماد = ${totalAssets.toFixed(4)} × ${this.settings.maxMarginPerSymbolPercent}% = ${maxMarginPerSymbol.toFixed(4)} USDT\n` +
                            `مارجین موجود نماد = ${existingSymbolMargin.toFixed(4)} USDT (از ستون «مارجین» جدول پوزیشن‌های باز)\n` +
                            `مارجین ورودی جدید = ${newMargin.toFixed(4)} USDT\n` +
                            `مجموع مارجین نماد = ${existingSymbolMargin.toFixed(4)} + ${newMargin.toFixed(4)} = ${totalSymbolMargin.toFixed(4)} USDT\n` +
                            `${totalSymbolMargin.toFixed(4)} > ${maxMarginPerSymbol.toFixed(4)} ✗`
                    });
                    symbol.status = 'waiting';
                    symbol.lastCycleTime = Date.now();
                    symbol.errorCount = 0;
                    this.saveSymbols();
                    this.renderSymbolsTable();
                    this.currentCycleSymbol = null;
                    return false;
                }
                this.log(`${symbol.name}: مارجین نماد OK (${totalSymbolMargin.toFixed(2)} ≤ ${maxMarginPerSymbol.toFixed(2)} USDT)`, 'success', symbol.name);
            } else {
                // Symbol NOT in open positions table → skip controls 3 & 4
                this.log(`${symbol.name}: نماد در پوزیشن‌های باز یافت نشد — کنترل‌های فاصله قیمت و سقف مارجین skip شدند`, 'info', symbol.name);
            }

            // ===================================================================
            // ✓ Control 5 (Fallback): Ensure margin is positive — ALWAYS runs
            // ===================================================================
            const finalMargin = Math.max(newMargin, 0);
            if (finalMargin <= 0) {
                this.log(`${symbol.name}: مارجین نهایی صفر یا منفی — رد شد`, 'warning', symbol.name);
                await this.notifyRiskControlBlocked(symbol.name, this.selectedSignal, {
                    controlName: 'مارجین مثبت (Positive Margin)',
                                        math:
                        `کل دارایی = ${totalAssets.toFixed(4)} USDT\n` +
                        `درصد مارجین ورودی = ${this.settings.entryMarginPercent}%\n` +
                        `مارجین محاسبه‌شده = ${totalAssets.toFixed(4)} × ${this.settings.entryMarginPercent}% = ${newMargin.toFixed(4)} USDT\n` +
                        `مارجین نهایی = max(${newMargin.toFixed(4)}, 0) = ${finalMargin.toFixed(4)} USDT\n` +
                        `${finalMargin.toFixed(4)} ≤ 0 ✗`
                });
                symbol.status = 'waiting';
                symbol.lastCycleTime = Date.now();
                symbol.errorCount = 0;
                this.saveSymbols();
                this.renderSymbolsTable();
                this.currentCycleSymbol = null;
                return false;
            }

            // ===================================================================
            // ✓ Step 13: Open position
            // ===================================================================
            this.log(`${symbol.name}: باز کردن پوزیشن جدید...`, 'info', symbol.name);
            const signalType = this.selectedSignal.type === 'Long' ? 'long' : 'short';
            const result = await this.openPosition(symbol.name, {
                type: signalType,
                entryPrice: price,
                tp: this.selectedSignal.tp,
                sl: this.selectedSignal.sl
            }, finalMargin);
            this.log(`${symbol.name}: پوزیشن باز شد (سفارش: ${result.orderId}, مقدار: ${result.quantity})`, 'success', symbol.name);
            
            // ===================================================================
            // ✓ Step 14: Fetch updated balance + Send Bale notification
            // ===================================================================
            let updatedBalance = balanceForMargin;
            try {
                updatedBalance = await this.fetchBalance();
                this.log(`${symbol.name}: موجودی به‌روزرسانی شده - کل: ${updatedBalance.total || '-'}, آزاد: ${updatedBalance.free}`, 'success', symbol.name);
                // Update balance bar
                if (totalEl) totalEl.textContent = updatedBalance.total || '-';
                if (marginEl) marginEl.textContent = updatedBalance.positionMargin || '-';
                if (freeEl) freeEl.textContent = updatedBalance.free || '-';
            } catch (e) {
                console.warn('Could not fetch updated balance after position open:', e);
            }
            
            // Send Bale notification for position opened (with closed position info + updated balance)
            await this.notifyOpenPosition(symbol.name, {
                type: this.selectedSignal.type,
                entryPrice: price,
                tp: this.selectedSignal.tp,
                sl: this.selectedSignal.sl
            }, finalMargin, this.settings.leverage, updatedBalance, closedCount > 0, closedPositionInfo, this.selectedSignal.timestamp);

            // Update symbol status
            symbol.status = 'waiting';
            symbol.lastCycleTime = Date.now();
            symbol.errorCount = 0;
            this.saveSymbols();
            this.renderSymbolsTable();

            // ✓ Save all automation data (market data, signals, history, selected signal)
            //   so that returning to the automation page shows the latest state.
            //   After a successful position open, the selectedSignal is still the one
            //   we just traded — we keep it persisted so the UI shows what happened.
            await this.saveAutomationData(symbol.name);
            this.lastUsedSymbol = symbol.name;
            localStorage.setItem('automationLastUsedSymbol', symbol.name);

            this.log(`چرخه ${symbol.name} با موفقیت انجام شد`, 'success', symbol.name);
            this.currentCycleSymbol = null;
            return true;

        } catch (error) {
            if (error.message === 'NO_SIGNAL_GENERATED') {
                this.log(`${symbol.name}: هیچ سیگنالی یافت نشد - شرایط بازار مناسب نیست`, 'warning', symbol.name);
                symbol.status = 'waiting';
                symbol.lastCycleTime = Date.now();
                symbol.errorCount = 0;
                this.saveSymbols();
                this.renderSymbolsTable();
                this.currentCycleSymbol = null;
                return false;
            }
            
            symbol.errorCount++;
            
            if (symbol.errorCount >= this.settings.allowedErrors) {
                // Reset error count and skip to next symbol
                this.log(`${symbol.name}: خطا - ${error.message} (تلاش ${symbol.errorCount}/${this.settings.allowedErrors}) - تعداد خطا به حد مجاز رسید، ریست و عبور به نماد بعدی`, 'error', symbol.name);
                symbol.errorCount = 0;
                symbol.status = 'waiting';
                symbol.lastCycleTime = Date.now();
                await this.notifySymbolSkipped(symbol.name);
            } else {
                symbol.status = 'error';
                this.log(`${symbol.name}: خطا - ${error.message} (تلاش ${symbol.errorCount}/${this.settings.allowedErrors})`, 'error', symbol.name);
                await this.notifyError(symbol.name, error.message);
            }

            this.saveSymbols();
            this.renderSymbolsTable();
            this.currentCycleSymbol = null;
            return false;
        }
    }

    async fetchPrice(symbol) {
        try {
            const response = await fetch(`/api/toobit-proxy?symbol=${symbol}-SWAP-USDT&interval=1h&limit=1`);
            if (!response.ok) throw new Error('Failed to fetch price');
            
            const data = await response.json();
            const klines = Array.isArray(data) ? data : (data.data || []);
            if (klines.length === 0) throw new Error('No price data received');
            
            return parseFloat(klines[0][4]);
        } catch (error) {
            throw new Error(`خطا در دریافت قیمت: ${error.message}`);
        }
    }

    async fetchPositionHistory(symbol) {
        try {
            const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
            const apiKey = settings.apiKey;
            const secretKey = settings.secretKey;
            const baseUrl = settings.baseUrl || 'https://api.toobit.com';

            if (!apiKey || !secretKey) {
                throw new Error('API credentials not found');
            }

            const response = await fetch('/api/history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol: `${symbol}-SWAP-USDT`,
                    apiKey,
                    secretKey,
                    baseUrl,
                    limit: 100
                })
            });

            if (!response.ok) throw new Error('Failed to fetch history');
            
            const data = await response.json();
            console.log(`[History] Received API response for ${symbol}:`, data);
            
            // Handle different API response formats
            let histories = [];
            if (Array.isArray(data)) {
                // Direct array response
                console.log(`[History] Detected direct array response with ${data.length} items`);
                histories = data;
            } else if (data.data && Array.isArray(data.data)) {
                // Wrapped in data object
                console.log(`[History] Detected .data wrapped response with ${data.data.length} items`);
                histories = data.data;
            } else if (data.result && Array.isArray(data.result)) {
                // Wrapped in result object
                console.log(`[History] Detected .result wrapped response with ${data.result.length} items`);
                histories = data.result;
            } else if (typeof data === 'object' && data !== null) {
                // Try to extract array from any field
                const values = Object.values(data).find(v => Array.isArray(v));
                console.log(`[History] Detected object response, found array field with ${values ? values.length : 0} items`);
                histories = values || [];
            } else {
                console.warn(`[History] Unexpected response format for ${symbol}:`, typeof data);
            }
            
            console.log(`[History] Returning ${histories.length} history items for ${symbol}`);
            
            // Map to consistent structure
            const mapped = (Array.isArray(histories) ? histories : []).map(item => ({
                time: new Date(parseInt(item.time || 0)),
                symbol: item.symbol || '-',
                price: parseFloat(item.price || 0),
                qty: parseFloat(item.qty || 0),
                commission: parseFloat(item.commission || 0),
                side: item.side || '-',
                realizedPnl: parseFloat(item.realizedPnl || 0)
            }));
            
            console.log(`[History] Mapped ${mapped.length} items for ${symbol}`);
            return mapped;
        } catch (error) {
            console.error(`[History] Error fetching position history for ${symbol}:`, error);
            console.warn(`خطا در دریافت تاریخچه برای ${symbol}:`, error);
            return [];
        }
    }

    async closeOppositePositions(symbol, signalType) {
        try {
            const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
            const oppositeDirection = signalType === 'Long' ? 'short' : 'long';

            // ✓ Step 1: Fetch open positions BEFORE closing, to get details of the position being closed
            let closedPositionInfo = null;
            try {
                const posResponse = await fetch('/api/open-positions', {
                    headers: {
                        'X-API-Key': settings.apiKey,
                        'X-Secret-Key': settings.secretKey,
                        'X-Base-Url': settings.baseUrl || 'https://api.toobit.com'
                    }
                });
                if (posResponse.ok) {
                    const posResult = await posResponse.json();
                    const allPositions = posResult.positions || posResult.data || [];
                    const fullSymbol = `${symbol}-SWAP-USDT`;
                    // Find the opposite direction position for this symbol
                    const targetSide = oppositeDirection.toUpperCase();
                    const matchingPos = allPositions.find(pos => {
                        const posSymbol = (pos.symbol || '').toString().toUpperCase();
                        const side = (pos.side || '').toString().toUpperCase();
                        const available = parseFloat(pos.available || pos.position || 0);
                        return posSymbol === fullSymbol.toUpperCase() && side === targetSide && available > 0;
                    });
                    if (matchingPos) {
                        const margin = parseFloat(matchingPos.margin || 0);
                        const unrealizedPnL = parseFloat(matchingPos.unrealizedPnL || 0);
                        const profitRate = parseFloat(matchingPos.profitRate || 0) * 100;
                        closedPositionInfo = {
                            symbol: matchingPos.symbol,
                            side: matchingPos.side,         // e.g. "SHORT" or "LONG"
                            leverage: matchingPos.leverage,
                            margin: margin,
                            unrealizedPnL: unrealizedPnL,
                            profitRate: profitRate,
                            avgPrice: parseFloat(matchingPos.avgPrice || 0),
                            available: parseFloat(matchingPos.available || 0)
                        };
                    }
                }
            } catch (e) {
                console.warn('Could not fetch position details before closing:', e);
            }

            // ✓ Step 2: Close the opposite position
            const response = await fetch('/api/close-position', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol: `${symbol}`,
                    direction: oppositeDirection,
                    clientOrderId: `${symbol}_close_${Date.now()}`,
                    settings: {
                        apiKey: settings.apiKey,
                        secretKey: settings.secretKey,
                        baseUrl: settings.baseUrl || 'https://api.toobit.com'
                    }
                })
            });

            if (!response.ok) throw new Error('Failed to close positions');
            
            const data = await response.json();
            const closedCount = data.closed || 0;
            
            // ✓ Step 3: Return both count and closed position info
            return { closed: closedCount, closedPositionInfo };
        } catch (error) {
            console.warn('Error closing opposite positions:', error);
            return { closed: 0, closedPositionInfo: null };
        }
    }

    async fetchBalance() {
        try {
            const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
            const apiKey = settings.apiKey;
            const secretKey = settings.secretKey;
            const baseUrl = settings.baseUrl || 'https://api.toobit.com';

            if (!apiKey || !secretKey) {
                throw new Error('API credentials not found');
            }

            const response = await fetch('/api/balance', {
                headers: {
                    'X-API-Key': apiKey,
                    'X-Secret-Key': secretKey,
                    'X-Base-Url': baseUrl
                }
            });
            
            if (!response.ok) throw new Error('Failed to fetch balance');
            
            const data = await response.json();
            return data.balance || data;
        } catch (error) {
            throw new Error(`خطا در دریافت موجودی: ${error.message}`);
        }
    }

    /**
     * دریافت هدرهای API از تنظیمات (برای فراخوانی‌های مستقیم موجودی/پوزیشن)
     */
    getApiHeaders() {
        const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
        return {
            'Content-Type': 'application/json',
            'X-API-Key': settings.apiKey || '',
            'X-Secret-Key': settings.secretKey || '',
            'X-Base-Url': settings.baseUrl || 'https://api.toobit.com'
        };
    }

    /**
     * بروزرسانی نوار موجودی در بالای صفحه اتوماسیون
     * (موجودی کل / در معامله / آزاد)
     */
    async fetchBalanceForBar() {
        try {
            const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
            
            // Check if API keys are configured (like trading page does)
            if (!settings.apiKey || !settings.secretKey) {
                console.warn('[fetchBalanceForBar] API keys not configured');
                document.getElementById('balance-total').textContent = '-';
                document.getElementById('balance-position-margin').textContent = '-';
                document.getElementById('balance-free').textContent = '-';
                return;
            }
            
            const response = await fetch('/api/balance', {
                headers: {
                    'X-API-Key': settings.apiKey,
                    'X-Secret-Key': settings.secretKey,
                    'X-Base-Url': settings.baseUrl || 'https://api.toobit.com'
                }
            });
            
            if (!response.ok) {
                document.getElementById('balance-total').textContent = '-';
                document.getElementById('balance-position-margin').textContent = '-';
                document.getElementById('balance-free').textContent = '-';
                return;
            }
            
            const result = await response.json();
            
            // API returns { success: true, balance: {...} } — same as trading page
            if (result.success && result.balance) {
                const balance = result.balance;
                document.getElementById('balance-total').textContent = balance.total || '-';
                document.getElementById('balance-position-margin').textContent = balance.positionMargin || '-';
                document.getElementById('balance-free').textContent = balance.free || '-';
                await this.dbSet('balance', balance);
            } else {
                console.warn('[fetchBalanceForBar] Unexpected response:', result);
                document.getElementById('balance-total').textContent = '-';
                document.getElementById('balance-position-margin').textContent = '-';
                document.getElementById('balance-free').textContent = '-';
            }
        } catch (e) {
            console.error('[fetchBalanceForBar] Error:', e);
            document.getElementById('balance-total').textContent = '-';
            document.getElementById('balance-position-margin').textContent = '-';
            document.getElementById('balance-free').textContent = '-';
        }
    }

    async loadBalanceFromDB() {
        try {
            const balance = await this.dbGet('balance');
            if (balance) {
                const b = typeof balance === 'string' ? JSON.parse(balance) : balance;
                const totalEl = document.getElementById('balance-total');
                const marginEl = document.getElementById('balance-position-margin');
                const freeEl = document.getElementById('balance-free');
                if (totalEl && b.total) totalEl.textContent = b.total;
                if (marginEl && b.positionMargin) marginEl.textContent = b.positionMargin;
                if (freeEl && b.free) freeEl.textContent = b.free;
            }
        } catch (e) { /* ignore */ }
    }

    async fetchOpenPositionsForTable() {
        try {
            const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
            const response = await fetch('/api/open-positions', {
                headers: {
                    'X-API-Key': settings.apiKey,
                    'X-Secret-Key': settings.secretKey,
                    'X-Base-Url': settings.baseUrl || 'https://api.toobit.com'
                }
            });
            
            if (!response.ok) {
                this.displayOpenPositions([]);
                return;
            }
            
            const result = await response.json();
            const positions = result.positions || result.data || [];
            this.displayOpenPositions(positions);
            await this.dbSet('openPositions', positions);
        } catch (e) {
            this.displayOpenPositions([]);
        }
    }

    async loadOpenPositionsFromDB() {
        try {
            const positions = await this.dbGet('openPositions');
            if (positions) {
                const p = typeof positions === 'string' ? JSON.parse(positions) : positions;
                this.displayOpenPositions(p);
            }
        } catch (e) { /* ignore */ }
    }

    /**
     * ✓ بارگذاری تاریخچه پوزیشن‌ها برای تکمیل ستون «آخرین ورود» در جدول پوزیشن‌های باز
     *
     * ✓ اصلاح Race Condition: این متد دیگر this.currentSymbolHistory را بازنویسی نمی‌کند.
     *   به جای آن، تاریخچه هر نماد را به getLastEntryPrice به‌عنوان پارامتر پاس می‌دهد.
     *   این از تداخل داده‌های نمادهای مختلف جلوگیری می‌کند.
     */
    async loadHistoryForOpenPositions() {
        try {
            // Get unique symbols from open positions to fetch their history
            const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
            if (!settings.apiKey || !settings.secretKey) return;

            // Fetch open positions first to know which symbols to load history for
            const opResponse = await fetch('/api/open-positions', {
                headers: {
                    'X-API-Key': settings.apiKey,
                    'X-Secret-Key': settings.secretKey,
                    'X-Base-Url': settings.baseUrl || 'https://api.toobit.com'
                }
            });
            
            if (!opResponse.ok) return;
            const opResult = await opResponse.json();
            const openPositions = opResult.positions || opResult.data || [];
            
            if (openPositions.length === 0) return;
            
            // Get unique symbols from open positions
            const symbols = [...new Set(openPositions.map(p => {
                const sym = p.symbol || '';
                return sym.replace('-SWAP-USDT', '').replace('USDT', '');
            }).filter(s => s))];
            
            // Fetch history for each symbol and populate lastEntryPriceCache
            // ✓ IMPORTANT: do NOT modify this.currentSymbolHistory — use local variable
            for (const symbol of symbols) {
                try {
                    const history = await this.fetchPositionHistory(symbol);
                    if (Array.isArray(history) && history.length > 0) {
                        // ✓ Pass history as parameter — do NOT overwrite this.currentSymbolHistory
                        this.getLastEntryPrice(symbol, 'long', history);
                        this.getLastEntryPrice(symbol, 'short', history);
                    }
                } catch (e) {
                    console.warn(`[loadHistoryForOpenPositions] Failed to load history for ${symbol}:`, e);
                }
            }
        } catch (e) {
            console.warn('[loadHistoryForOpenPositions] Error:', e);
        }
    }

    /**
     * ✓ بروزرسانی کامل داده‌ها: تاریخچه → بازار → سیگنال → نمودار → سیگنال آماده
     * با فشردن دکمه بروزرسانی بالای جدول سوابق فراخوانی می‌شود
     */
    async refreshAllData() {
        const symbol = this.symbols.length > 0 ? this.symbols[0].name : null;
        if (!symbol) {
            UIUtils.showNotification('نمادی برای بروزرسانی وجود ندارد', 'warning');
            return;
        }

        UIUtils.showNotification(`بروزرسانی داده‌ها برای ${symbol}...`, 'info', 2000);
        this.log(`${symbol}: شروع بروزرسانی کامل...`, 'info', symbol);

        try {
            // Step 1: Clear all data
            this.setupForCycle();

            // Step 2: Fetch position history FIRST (needed for last entry price cache + signal status)
            this.log(`${symbol}: دریافت تاریخچه معاملات...`, 'info', symbol);
            const history = await this.fetchPositionHistory(symbol);
            this.currentSymbolHistory = Array.isArray(history) ? history : [];
            this.log(`${symbol}: ${this.currentSymbolHistory.length} معامله یافت شد`, 'success', symbol);
            
            // ✓ Populate last entry price cache from history (keyed by symbol:direction)
            this.getLastEntryPrice(symbol, 'long');
            this.getLastEntryPrice(symbol, 'short');
            
            // Populate history table
            this.populateHistoryTable();

            // Step 3: Fetch market data
            this.log(`${symbol}: دریافت داده‌های بازار...`, 'info', symbol);
            await this.fetchMarketData(symbol);

            // Step 4: Generate signals + update visualization
            this.updateVisualization(symbol, this.marketData);

            // Step 5: Render signal details + chart (uses history for signal status)
            this.renderSignalDetails();
            this.renderChart();

            // ✓ Update chart symbol name label
            this.updateChartSymbolName(symbol);

            // ✓ Step 6: Auto-update ready signal section (Issue #7)
            this.updateSelectedSignal();

            // Step 7: Save all data
            await this.saveAutomationData(symbol);
            this.lastUsedSymbol = symbol;
            localStorage.setItem('automationLastUsedSymbol', symbol);
            this.dbSet('lastUsedSymbol', symbol);

            // Step 8: Refresh open positions table (now has updated lastEntryPriceCache)
            await this.loadHistoryForOpenPositions();
            await this.fetchOpenPositionsForTable();

            // Step 9: Refresh balance
            await this.fetchBalanceForBar();

            this.log(`${symbol}: بروزرسانی کامل انجام شد`, 'success', symbol);
            UIUtils.showNotification(`بروزرسانی ${symbol} انجام شد ✓`, 'success', 2000);
        } catch (error) {
            this.log(`${symbol}: خطا در بروزرسانی - ${error.message}`, 'error', symbol);
            UIUtils.showNotification(`خطا در بروزرسانی: ${error.message}`, 'error', 3000);
        }
    }

    /**
     * ✓ بروزرسانی فقط داده‌های بازار: دریافت داده‌های بازار برای اولین نماد
     * و بروزرسانی جدول داده‌های بازار + نمودار
     */
    async refreshMarketDataOnly() {
        const symbol = this.symbols.length > 0 ? this.symbols[0].name : null;
        if (!symbol) {
            UIUtils.showNotification('نمادی برای بروزرسانی وجود ندارد', 'warning');
            return;
        }

        UIUtils.showNotification(`بروزرسانی داده‌های بازار برای ${symbol}...`, 'info', 2000);
        this.log(`${symbol}: شروع بروزرسانی داده‌های بازار...`, 'info', symbol);

        try {
            // ✓ Step 1: Fetch position history (needed for signal status calculation)
            this.log(`${symbol}: دریافت تاریخچه معاملات...`, 'info', symbol);
            const history = await this.fetchPositionHistory(symbol);
            this.currentSymbolHistory = Array.isArray(history) ? history : [];
            this.log(`${symbol}: ${this.currentSymbolHistory.length} معامله یافت شد`, 'success', symbol);
            this.populateHistoryTable();

            // Step 2: Fetch market data for the first symbol
            await this.fetchMarketData(symbol);

            // Step 3: Generate signals from market data (history is now available for status)
            this.updateVisualization(symbol, this.marketData);

            // Step 4: Update chart symbol name
            this.updateChartSymbolName(symbol);

            // Step 5: Render chart
            this.renderChart();

            // Step 6: Save data
            await this.saveAutomationData(symbol);
            this.lastUsedSymbol = symbol;
            localStorage.setItem('automationLastUsedSymbol', symbol);
            this.dbSet('lastUsedSymbol', symbol);

            this.log(`${symbol}: داده‌های بازار بروزرسانی شد`, 'success', symbol);
            UIUtils.showNotification(`داده‌های بازار ${symbol} بروزرسانی شد ✓`, 'success', 2000);
        } catch (error) {
            this.log(`${symbol}: خطا در بروزرسانی داده‌های بازار - ${error.message}`, 'error', symbol);
            UIUtils.showNotification(`خطا در بروزرسانی داده‌های بازار: ${error.message}`, 'error', 3000);
        }
    }

    /**
     * ✓ تولید سیگنال: تحلیل و تولید سیگنال با استفاده از داده‌های بازار و تاریخچه فعلی
     * (مشابه دکمه "تولید سیگنال" در صفحه داشبورد)
     */
    async refreshSignalsOnly() {
        const symbol = this.symbols.length > 0 ? this.symbols[0].name : this.marketDataSymbol;
        if (!symbol) {
            UIUtils.showNotification('نمادی برای تولید سیگنال وجود ندارد', 'warning');
            return;
        }

        UIUtils.showNotification(`تولید سیگنال برای ${symbol}...`, 'info', 2000);
        this.log(`${symbol}: شروع تولید سیگنال...`, 'info', symbol);

        try {
            // Step 1: If no market data exists, fetch it first
            if (this.marketData.length === 0 || this.marketDataSymbol !== symbol) {
                this.log(`${symbol}: داده‌های بازار موجود نیست - در حال دریافت...`, 'info', symbol);
                await this.fetchMarketData(symbol);
            }

            // Step 2: Ensure position history is loaded (needed for signal status)
            if (this.currentSymbolHistory.length === 0) {
                this.log(`${symbol}: تاریخچه موجود نیست - در حال دریافت...`, 'info', symbol);
                const history = await this.fetchPositionHistory(symbol);
                this.currentSymbolHistory = Array.isArray(history) ? history : [];
                this.populateHistoryTable();
            }

            // ✓ Step 3: Save history before clearing (setupForCycle clears it)
            const savedHistory = [...this.currentSymbolHistory];

            // Step 4: Clear signal-related data for fresh generation
            this.setupForCycle();

            // ✓ Step 5: Restore history immediately — it must be available for
            // calculateSignalStatus() inside updateVisualization → renderSignalDetails
            this.currentSymbolHistory = savedHistory;

            // Step 6: Generate signals from market data (history is now available)
            this.updateVisualization(symbol, this.marketData);

            // Step 7: Re-render history table and signal details
            this.populateHistoryTable();
            this.renderSignalDetails();

            // Step 8: Update chart symbol name
            this.updateChartSymbolName(symbol);

            // Step 9: Render chart
            this.renderChart();

            // Step 10: Auto-update ready signal section
            this.updateSelectedSignal();

            // Step 11: Save data
            await this.saveAutomationData(symbol);
            this.lastUsedSymbol = symbol;
            localStorage.setItem('automationLastUsedSymbol', symbol);
            this.dbSet('lastUsedSymbol', symbol);

            this.log(`${symbol}: سیگنال‌ها تولید شدند - ${this.signals.length} سیگنال`, 'success', symbol);
            UIUtils.showNotification(`${this.signals.length} سیگنال برای ${symbol} تولید شد ✓`, 'success', 2000);
        } catch (error) {
            this.log(`${symbol}: خطا در تولید سیگنال - ${error.message}`, 'error', symbol);
            UIUtils.showNotification(`خطا در تولید سیگنال: ${error.message}`, 'error', 3000);
        }
    }

    /**
     * ✓ نمایش پوزیشن‌های باز در جدول فشرده صفحه اتوماسیون
     * ✓ سورت بر حسب زمان باز شدن پوزیشن به صورت نزولی (جدیدترین در بالا)
     * ✓ ستون «آخرین ورود» از lastEntryPriceCache محاسبه می‌شود
     */
    displayOpenPositions(positions) {
        const tbody = document.getElementById('positions-table-body');
        const badge = document.getElementById('positions-count-badge');
        const meta = document.getElementById('positions-meta');
        if (!tbody) return;

        if (badge) {
            badge.textContent = (positions && positions.length ? positions.length : 0).toLocaleString('fa-IR');
        }
        
        // ✓ Show last update timestamp (Issue #4)
        if (meta) {
            meta.textContent = `آخرین بروزرسانی: ${new Date().toLocaleString('fa-IR')} | تعداد: ${positions ? positions.length : 0}`;
        }

        if (!positions || positions.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="9" class="px-4 py-4 text-center text-gray-400">
                        <i class="fas fa-check-circle text-2xl mb-1 block"></i>
                        <div>پوزیشنی باز نیست</div>
                    </td>
                </tr>
            `;
            return;
        }

        // ✓ Sort positions by open time DESC (newest first)
        // Toobit positions have 'time' or 'updateTime' or 'openTime' field
        const sortedPositions = [...positions].sort((a, b) => {
            const ta = new Date(a.time || a.openTime || a.updateTime || a.createdTime || 0).getTime();
            const tb = new Date(b.time || b.openTime || b.updateTime || b.createdTime || 0).getTime();
            return tb - ta; // descending
        });

        tbody.innerHTML = '';
        sortedPositions.forEach(pos => {
            const row = document.createElement('tr');
            row.className = 'border-b border-gray-700 hover:bg-gray-700';

            // ✓ Fix direction detection: use pos.side field from Toobit API
            let side;
            const sideStr = (pos.side || '').toUpperCase();
            const posSide = (pos.posSide || '').toUpperCase();
            
            if (sideStr === 'LONG' || sideStr.includes('LONG') || posSide === 'LONG') {
                side = 'Long';
            } else if (sideStr === 'SHORT' || sideStr.includes('SHORT') || posSide === 'SHORT') {
                side = 'Short';
            } else {
                const qty = parseFloat(pos.available || pos.amount || pos.positionAmt || 0);
                if (qty < 0) {
                    side = 'Short';
                } else {
                    side = 'Long';
                }
            }
            
            const sideClass = side === 'Long' ? 'text-green-400' : 'text-red-400';
            const pnl = parseFloat(pos.unrealizedPnL || 0);
            const pnlClass = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : '';
            const margin = parseFloat(pos.margin || 0);
            const profitRate = parseFloat(pos.profitRate || 0) * 100;
            const profitRateClass = profitRate > 0 ? 'text-green-400' : profitRate < 0 ? 'text-red-400' : '';
            
            // ✓ Get last entry price from lastEntryPriceCache (keyed by symbol:direction)
            // The direction is determined by the position's side (Long/Short)
            const symbolName = (pos.symbol || '').replace('-SWAP-USDT', '').replace('USDT', '');
            const posDirection = side === 'Long' ? 'long' : 'short';
            const lastEntry = this.lastEntryPriceCache[`${pos.symbol}:${posDirection}`] 
                || this.lastEntryPriceCache[`${symbolName}:${posDirection}`] 
                || '-';

            row.innerHTML = `
                <td class="px-2 py-2" style="font-family: 'Vazirmatn', sans-serif;">${pos.symbol || '-'}</td>
                <td class="px-2 py-2 ${sideClass} font-bold">${side}</td>
                <td class="px-2 py-2" style="font-family: 'Vazirmatn', sans-serif;">${parseFloat(pos.avgPrice || 0).toFixed(4)}</td>
                <td class="px-2 py-2" style="font-family: 'Vazirmatn', sans-serif;">${parseFloat(pos.available || 0).toFixed(2)}</td>
                <td class="px-2 py-2" style="font-family: 'Vazirmatn', sans-serif;">${pos.leverage || '-'}x</td>
                <td class="px-2 py-2" style="font-family: 'Vazirmatn', sans-serif;">${margin.toFixed(4)}</td>
                <td class="px-2 py-2 ${pnlClass}" style="font-family: 'Vazirmatn', sans-serif;">${pnl.toFixed(4)}</td>
                <td class="px-2 py-2 ${profitRateClass}" style="font-family: 'Vazirmatn', sans-serif;">${profitRate.toFixed(2)}%</td>
                <td class="px-2 py-2" style="font-family: 'Vazirmatn', sans-serif;">${lastEntry}</td>
            `;
            tbody.appendChild(row);
        });
    }

    /**
     * محاسبه مارجین جدید بر اساس درصد کل دارایی
     * newMargin = totalAssets × (entryMarginPercent / 100)
     */
    calculateNewMargin(totalAssets) {
        const margin = totalAssets * (this.settings.entryMarginPercent / 100);
        return parseFloat(margin.toFixed(2));
    }

    /**
     * بررسی دارایی امن
     * safeAmount = totalAssets × (safeAssetPercent / 100)
     * if (free - newMargin < safeAmount) → skip
     */
    checkSafeAsset(totalAssets, freeBalance, newMargin) {
        const safeAmount = totalAssets * (this.settings.safeAssetPercent / 100);
        const projectedFree = freeBalance - newMargin;
        return { safe: projectedFree >= safeAmount, safeAmount, projectedFree };
    }

    /**
     * ✓ آخرین قیمت ورود هم‌جهت از تاریخچه (منطق جدید)
     *
     * نحوه محاسبه جدید:
     *   ۱. آخرین ردیف جدول «سوابق پوزیشن‌ها» (جدیدترین/بزرگ‌ترین مقدار در ستون «زمان») را پیدا کن
     *   ۲. مقدار ستون «سمت» آن ردیف را بررسی کن:
     *      - اگر از جنس OPEN بود (BUY_OPEN یا SELL_OPEN) → مقدار ستون «قیمت» آن ردیف را برگردان
     *      - اگر از جنس CLOSE بود (BUY_CLOSE یا SELL_CLOSE) → null برگردان (پوزیشن بازی وجود ندارد)
     *
     * ✓ Cache با کلید symbol:direction ذخیره می‌شود تا long و short یکدیگر را بازنویسی نکنند
     *
     * @param symbol - نماد (برای cache)
     * @param direction - جهت ('long' یا 'short') — برای فیلتر BUY/SELL
     * @param historyParam - آرایه تاریخچه (اختیاری — اگر ارائه نشود از this.currentSymbolHistory استفاده می‌شود)
     */
    getLastEntryPrice(symbol, direction, historyParam) {
        const history = historyParam || this.currentSymbolHistory;
        if (!history || history.length === 0) return null;

        const sidePrefix = direction === 'long' ? 'BUY' : 'SELL';

        // Sort chronologically (ascending by time) to find the latest row
        const sorted = [...history].sort((a, b) => {
            const ta = a.time instanceof Date ? a.time.getTime() : new Date(a.time).getTime();
            const tb = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
            return ta - tb;
        });

        // Find the LATEST row (newest time) that matches the direction (BUY for long, SELL for short)
        // and is an OPEN trade (BUY_OPEN or SELL_OPEN)
        let latestOpen = null;
        for (let i = sorted.length - 1; i >= 0; i--) {
            const t = sorted[i];
            if (t.side && t.side.includes(sidePrefix) && t.side.includes('OPEN')) {
                latestOpen = t;
                break;
            }
        }

        if (latestOpen) {
            // ✓ Cache with symbol:direction key to prevent long/short from overwriting each other
            const cacheKey = `${symbol}:${direction}`;
            const fullSymKey = `${symbol}-SWAP-USDT:${direction}`;
            this.lastEntryPriceCache[cacheKey] = latestOpen.price;
            this.lastEntryPriceCache[fullSymKey] = latestOpen.price;
            return latestOpen.price;
        }

        // No OPEN trade found → no open position → return null
        return null;
    }

    /**
     * مجموع مارجین پوزیشن‌های باز برای یک نماد+جهت
     */
    async getSymbolMargin(symbol, direction) {
        try {
            const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
            const apiKey = settings.apiKey;
            const secretKey = settings.secretKey;
            const baseUrl = settings.baseUrl || 'https://api.toobit.com';

            if (!apiKey || !secretKey) return 0;

            const response = await fetch('/api/open-positions', {
                headers: {
                    'X-API-Key': apiKey,
                    'X-Secret-Key': secretKey,
                    'X-Base-Url': baseUrl,
                    'X-Symbol': `${symbol}-SWAP-USDT`
                }
            });

            if (!response.ok) return 0;
            const data = await response.json();
            const positions = data.positions || data.data || [];
            
            // Filter same direction: LONG for Long, SHORT for Short
            // Toobit API returns side as "LONG"/"SHORT" for open positions
            const targetSide = direction === 'long' ? 'LONG' : 'SHORT';
            const sameDirection = positions.filter(pos => {
                const sideStr = (pos.side || '').toUpperCase();
                return sideStr === targetSide || sideStr.includes(targetSide);
            });
            
            let totalMargin = 0;
            sameDirection.forEach(pos => {
                const markPrice = parseFloat(pos.markPrice || pos.avgPrice || 0);
                const available = parseFloat(pos.available || 0);
                const leverage = parseInt(pos.leverage || 1);
                if (markPrice > 0 && leverage > 0) {
                    totalMargin += (available * markPrice) / leverage;
                }
            });
            
            return parseFloat(totalMargin.toFixed(2));
        } catch (e) {
            console.warn('getSymbolMargin error:', e);
            return 0;
        }
    }

    async openPosition(symbol, signal, margin) {
        try {
            const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
            
            const response = await fetch('/api/create-position', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol: symbol,
                    direction: signal.type,
                    usdtAmount: margin,
                    leverage: this.settings.leverage,
                    tpPrice: signal.tp,
                    slPrice: signal.sl,
                    clientOrderId: SignalUtils.generateOrderId(Date.now(), symbol),
                    settings: {
                        apiKey: settings.apiKey,
                        secretKey: settings.secretKey,
                        baseUrl: settings.baseUrl || 'https://api.toobit.com'
                    }
                })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to open position');
            }
            
            const data = await response.json();
            const order = data.order || data;
            return {
                orderId: order.orderId,
                quantity: order.origQty
            };
        } catch (error) {
            throw new Error(`خطا در باز کردن پوزیشن: ${error.message}`);
        }
    }

    startAutomation() {
        if (this.isRunning) return;
        
        // ✓ Clear all data when starting automation
        this.setupForCycle();
        
        this.isRunning = true;
        this.updateUIState();
        this.log('اتوماسیون شروع شد', 'success');
        this.runCycle();
        this.automationInterval = setInterval(() => {
            this.runCycle();
        }, 5 * 60 * 1000);
    }

    stopAutomation() {
        if (!this.isRunning) return;
        this.isRunning = false;
        if (this.automationInterval) {
            clearInterval(this.automationInterval);
            this.automationInterval = null;
        }
        this.updateUIState();
        this.log('اتوماسیون متوقف شد', 'warning');
    }

    renderSymbolsTable() {
        const tbody = document.getElementById('symbols-table-body');
        if (this.symbols.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-gray-400">نمادی موجود نیست</td></tr>';
            return;
        }

        tbody.innerHTML = this.symbols.map((symbol, index) => {
            const remainingTime = this.getRemainingWaitTime(symbol);
            const statusClass = symbol.status === 'running' ? 'status-running' :
                               symbol.status === 'error' ? 'status-error' : 'status-waiting';
            
            const statusText = symbol.status === 'running' ? 'در حال اجرا' :
                              symbol.status === 'error' ? 'خطا' : 'در انتظار';
            
            const lastCycleText = symbol.lastCycleTime ? 
                new Date(symbol.lastCycleTime).toLocaleString('fa-IR') : '-';

            const waitTimeText = remainingTime > 0 ? `${remainingTime} دقیقه` : 'آماده';

            return `
                <tr class="border-b border-gray-800 hover:bg-white/5" draggable="true" data-symbol-id="${symbol.id}">
                    <td class="px-4 py-3">
                        <i class="fas fa-grip-vertical drag-handle ml-2" title="جابجایی"></i>
                        ${index + 1}
                    </td>
                    <td class="px-4 py-3 font-semibold">${symbol.name}</td>
                    <td class="px-4 py-3">
                        <span class="${statusClass}">
                            <i class="fas fa-circle ml-1"></i>
                            ${statusText}
                        </span>
                    </td>
                    <td class="px-4 py-3">
                        <span class="${symbol.errorCount >= this.settings.allowedErrors ? 'text-red-400' : 'text-gray-300'}">
                            ${symbol.errorCount} / ${this.settings.allowedErrors}
                        </span>
                    </td>
                    <td class="px-4 py-3 text-xs">${lastCycleText}</td>
                    <td class="px-4 py-3">${waitTimeText}</td>
                    <td class="px-4 py-3">
                        <button onclick="automationManager.removeSymbol(${symbol.id})" 
                                class="glass-effect px-3 py-1 rounded hover:bg-red-600 transition-all duration-300"
                                ${this.currentCycleSymbol && this.currentCycleSymbol.id === symbol.id ? 'disabled' : ''}>
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        // Setup drag & drop
        this.setupDragAndDrop();
    }

    /**
     * راه‌اندازی drag & drop برای جدول نمادها
     * ✓ پشتیبانی از mouse (desktop) و touch (موبایل)
     */
    setupDragAndDrop() {
        const tbody = document.getElementById('symbols-table-body');
        if (!tbody) return;

        let draggedRow = null;

        // ── Desktop: HTML5 Drag and Drop API (mouse) ────────────────────
        tbody.querySelectorAll('tr[draggable]').forEach(row => {
            row.addEventListener('dragstart', (e) => {
                draggedRow = row;
                row.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', row.dataset.symbolId);
            });

            row.addEventListener('dragend', () => {
                row.classList.remove('dragging');
                tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
                draggedRow = null;
            });

            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (row !== draggedRow) {
                    row.classList.add('drag-over');
                }
            });

            row.addEventListener('dragleave', () => {
                row.classList.remove('drag-over');
            });

            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.classList.remove('drag-over');

                if (!draggedRow || row === draggedRow) return;

                const draggedId = parseInt(draggedRow.dataset.symbolId);
                const targetId = parseInt(row.dataset.symbolId);

                const draggedIndex = this.symbols.findIndex(s => s.id === draggedId);
                const targetIndex = this.symbols.findIndex(s => s.id === targetId);

                if (draggedIndex === -1 || targetIndex === -1) return;

                // Reorder symbols array
                const [moved] = this.symbols.splice(draggedIndex, 1);
                this.symbols.splice(targetIndex, 0, moved);

                this.saveSymbols();
                this.renderSymbolsTable();
                this.log('ترتیب نمادها تغییر کرد', 'info');
            });
        });

        // ── Mobile: Touch Events API ────────────────────────────────────
        // HTML5 Drag and Drop doesn't work on touch devices, so we add
        // touch event handlers to enable drag-and-drop on mobile.
        this.setupTouchDragAndDrop(tbody);
    }

    /**
     * ✓ راه‌اندازی drag & drop لمسی برای جدول نمادها (موبایل)
     * از touchstart, touchmove, touchend استفاده می‌کند
     */
    setupTouchDragAndDrop(tbody) {
        if (!tbody) return;

        let touchDraggedRow = null;
        let touchClone = null;
        let touchStartY = 0;
        let touchStartX = 0;
        let touchMoved = false;

        tbody.querySelectorAll('tr[draggable]').forEach(row => {
            // ✓ Prevent default drag behavior on touch (allows our custom touch handling)
            row.addEventListener('touchstart', (e) => {
                // Only handle single-touch (not multi-touch/zoom)
                if (e.touches.length !== 1) return;

                const touch = e.touches[0];
                touchStartY = touch.clientY;
                touchStartX = touch.clientX;
                touchMoved = false;
                touchDraggedRow = row;

                // Don't prevent default on touchstart — allow scrolling to start
                // We'll only prevent default if the user moves enough to indicate a drag
            }, { passive: true });

            row.addEventListener('touchmove', (e) => {
                if (!touchDraggedRow || e.touches.length !== 1) return;

                const touch = e.touches[0];
                const deltaY = touch.clientY - touchStartY;
                const deltaX = touch.clientX - touchStartX;

                // ✓ Only start drag if vertical movement is dominant (not horizontal scroll)
                // and movement is more than 10px (avoid accidental drags on tap)
                if (!touchMoved && Math.abs(deltaY) > 10 && Math.abs(deltaY) > Math.abs(deltaX)) {
                    touchMoved = true;
                    // Now prevent default to stop scrolling
                    e.preventDefault();

                    // Create a visual clone that follows the finger
                    if (touchClone) touchClone.remove();
                    touchClone = row.cloneNode(true);
                    touchClone.style.position = 'fixed';
                    touchClone.style.pointerEvents = 'none';
                    touchClone.style.zIndex = '9999';
                    touchClone.style.opacity = '0.8';
                    touchClone.style.background = 'rgba(30, 30, 60, 0.95)';
                    touchClone.style.width = row.offsetWidth + 'px';
                    document.body.appendChild(touchClone);

                    row.classList.add('dragging');
                }

                if (touchMoved && touchClone) {
                    e.preventDefault();
                    // Position the clone under the finger
                    touchClone.style.left = (touch.clientX - row.offsetWidth / 2) + 'px';
                    touchClone.style.top = (touch.clientY - 20) + 'px';

                    // Highlight the row under the finger
                    const elementUnder = document.elementFromPoint(touch.clientX, touch.clientY);
                    const targetRow = elementUnder ? elementUnder.closest('tr[draggable]') : null;

                    // Clear previous highlights
                    tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));
                    if (targetRow && targetRow !== touchDraggedRow) {
                        targetRow.classList.add('drag-over');
                    }
                }
            }, { passive: false });

            row.addEventListener('touchend', (e) => {
                if (!touchDraggedRow) return;

                if (touchClone) {
                    touchClone.remove();
                    touchClone = null;
                }

                touchDraggedRow.classList.remove('dragging');
                tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over'));

                if (touchMoved) {
                    // Find the row where the finger was released
                    const touch = e.changedTouches[0];
                    if (touch) {
                        const elementUnder = document.elementFromPoint(touch.clientX, touch.clientY);
                        const targetRow = elementUnder ? elementUnder.closest('tr[draggable]') : null;

                        if (targetRow && targetRow !== touchDraggedRow) {
                            const draggedId = parseInt(touchDraggedRow.dataset.symbolId);
                            const targetId = parseInt(targetRow.dataset.symbolId);

                            const draggedIndex = this.symbols.findIndex(s => s.id === draggedId);
                            const targetIndex = this.symbols.findIndex(s => s.id === targetId);

                            if (draggedIndex !== -1 && targetIndex !== -1) {
                                const [moved] = this.symbols.splice(draggedIndex, 1);
                                this.symbols.splice(targetIndex, 0, moved);
                                this.saveSymbols();
                                this.renderSymbolsTable();
                                this.log('ترتیب نمادها تغییر کرد (لمسی)', 'info');
                            }
                        }
                    }
                }

                touchDraggedRow = null;
                touchMoved = false;
            }, { passive: true });
        });
    }

    updateUIState() {
        const startBtn = document.getElementById('start-automation-btn');
        const stopBtn = document.getElementById('stop-automation-btn');
        const statusDiv = document.getElementById('automation-status');

        if (this.isRunning) {
            startBtn.disabled = true;
            stopBtn.disabled = false;
            statusDiv.innerHTML = '<i class="fas fa-circle text-green-500 ml-1"></i><span>فعال</span>';
        } else {
            startBtn.disabled = false;
            stopBtn.disabled = true;
            statusDiv.innerHTML = '<i class="fas fa-circle text-gray-500 ml-1"></i><span>غیرفعال</span>';
        }

        if (this.isRunning) {
            setTimeout(() => {
                if (this.isRunning) {
                    this.renderSymbolsTable();
                    this.updateUIState();
                }
            }, 1000);
        }
    }

    log(message, type = 'info', symbol = null) {
        // Parse process and details from message
        const processMap = {
            'شروع چرخه': 'چرخه',
            'دریافت داده': 'دریافت داده',
            'کندل دریافت': 'دریافت داده',
            'سیگنال تولید': 'تحلیل',
            'سیگنالی یافت نشد': 'تحلیل',
            'دریافت تاریخچه': 'تاریخچه',
            'معامله یافت شد': 'تاریخچه',
            'دریافت قیمت': 'قیمت',
            'قیمت فعلی': 'قیمت',
            'بررسی پوزیشن': 'بستن پوزیشن',
            'پوزیشن مخالف بسته': 'بستن پوزیشن',
            'پوزیشن مخالفی یافت': 'بستن پوزیشن',
            'دریافت موجودی': 'موجودی',
            'موجودی آزاد': 'موجودی',
            'محاسبه مارجین': 'مارجین',
            'مارجین محاسبه': 'مارجین',
            'باز کردن پوزیشن': 'ورود',
            'پوزیشن باز شد': 'ورود',
            'چرخه.*با موفقیت': 'اتمام چرخه',
            'اتوماسیون شروع': 'اتوماسیون',
            'اتوماسیون متوقف': 'اتوماسیون',
            'تنظیمات': 'تنظیمات',
            'هیچ نمادی': 'چرخه',
            'هیچ سیگنالی برای ورود': 'تحلیل',
            'نماد.*اضافه': 'مدیریت نماد',
            'نماد با موفقیت حذف': 'مدیریت نماد',
            'خطا': 'خطا',
            'داده‌های قبلی': 'بارگذاری'
        };

        let process = 'سیستم';
        for (const [key, value] of Object.entries(processMap)) {
            if (new RegExp(key).test(message)) {
                process = value;
                break;
            }
        }

        const statusMap = {
            'success': { text: 'موفق', color: 'text-green-400', icon: 'fa-check-circle' },
            'error': { text: 'خطا', color: 'text-red-400', icon: 'fa-exclamation-circle' },
            'warning': { text: 'هشدار', color: 'text-yellow-400', icon: 'fa-exclamation-triangle' },
            'info': { text: 'اطلاع', color: 'text-blue-400', icon: 'fa-info-circle' }
        };

        const status = statusMap[type] || statusMap['info'];
        const timestamp = new Date().toLocaleString('fa-IR', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });

        // Add row to the table
        const tbody = document.getElementById('cycle-log-body');
        if (tbody) {
            // Remove empty state row
            const emptyRow = tbody.querySelector('td[colspan]');
            if (emptyRow) emptyRow.parentElement.remove();

            const row = document.createElement('tr');
            row.className = 'border-b border-gray-800 hover:bg-white/5';
            row.innerHTML = `
                <td class="px-3 py-2 text-xs text-gray-400">${timestamp}</td>
                <td class="px-3 py-2 text-xs font-semibold">${symbol || '-'}</td>
                <td class="px-3 py-2 text-xs">${process}</td>
                <td class="px-3 py-2 text-xs">
                    <span class="${status.color}">
                        <i class="fas ${status.icon} ml-1"></i>${status.text}
                    </span>
                </td>
                <td class="px-3 py-2 text-xs text-gray-300">${message}</td>
            `;
            tbody.insertBefore(row, tbody.firstChild);

            // Keep max 200 rows
            while (tbody.children.length > 200) {
                tbody.removeChild(tbody.lastChild);
            }
        }

        this.saveLogToDatabase({
            symbol: symbol || null,
            action: 'automation_cycle',
            status: type === 'error' ? 'ERROR' : type === 'warning' ? 'WARNING' : 'SUCCESS',
            message: message,
            error_code: type === 'error' ? 'SIGNAL_ERROR' : null,
            details: JSON.stringify({ timestamp: new Date().toISOString(), type: type, process: process })
        });
    }
    
    saveLogToDatabase(logData) {
        fetch('/api/db/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(logData)
        }).catch(err => console.warn('Failed to save log:', err));
    }
    
    async loadLogsFromDatabase() {
        try {
            const response = await fetch('/api/db/logs?limit=100');
            const result = await response.json();
            
            if (result.success && result.data && result.data.length > 0) {
                const tbody = document.getElementById('cycle-log-body');
                if (!tbody) return;
                tbody.innerHTML = '';
                
                const statusMap = {
                    'ERROR': { text: 'خطا', color: 'text-red-400', icon: 'fa-exclamation-circle' },
                    'WARNING': { text: 'هشدار', color: 'text-yellow-400', icon: 'fa-exclamation-triangle' },
                    'SUCCESS': { text: 'موفق', color: 'text-green-400', icon: 'fa-check-circle' }
                };

                // ✓ Sort by created_at DESC (newest first)
                const sortedLogs = [...result.data].sort((a, b) => {
                    const ta = new Date(a.created_at || 0).getTime();
                    const tb = new Date(b.created_at || 0).getTime();
                    return tb - ta; // descending
                });

                sortedLogs.forEach(log => {
                    const type = statusMap[log.status] || { text: 'اطلاع', color: 'text-blue-400', icon: 'fa-info-circle' };
                    const timestamp = new Date(log.created_at).toLocaleString('fa-IR', {
                        year: 'numeric', month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit', second: '2-digit'
                    });
                    
                    const row = document.createElement('tr');
                    row.className = 'border-b border-gray-800 hover:bg-white/5';
                    row.innerHTML = `
                        <td class="px-3 py-2 text-xs text-gray-400">${timestamp}</td>
                        <td class="px-3 py-2 text-xs font-semibold">${log.symbol || '-'}</td>
                        <td class="px-3 py-2 text-xs">-</td>
                        <td class="px-3 py-2 text-xs">
                            <span class="${type.color}">
                                <i class="fas ${type.icon} ml-1"></i>${type.text}
                            </span>
                        </td>
                        <td class="px-3 py-2 text-xs text-gray-300">${log.message}</td>
                    `;
                    tbody.appendChild(row);
                });
            }
        } catch (err) {
            console.warn('Failed to load logs:', err);
        }
    }

    clearLog() {
        const tbody = document.getElementById('cycle-log-body');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-8 text-center text-gray-400">گزارشی موجود نیست</td></tr>';
        }
    }

    // ==================== اطلاع‌رسانی بله ====================

    /**
     * تبدیل تاریخ میلادی به شمسی (جلالی) با وقت تهران
     */
    toJalali(date) {
        if (!date) date = new Date();
        if (typeof date === 'number') date = new Date(date);
        
        // Convert to Tehran time (UTC+3:30)
        const tehranOffset = 3.5 * 60; // minutes
        const utcTime = date.getTime() + date.getTimezoneOffset() * 60000;
        const tehranTime = new Date(utcTime + tehranOffset * 60000);
        
        const gy = tehranTime.getFullYear();
        const gm = tehranTime.getMonth() + 1;
        const gd = tehranTime.getDate();
        
        const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
        let jy, jm, jd, gy2, days;
        
        gy2 = (gm > 2) ? (gy + 1) : gy;
        days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1];
        jy = -1595 + (33 * Math.floor(days / 12053));
        days %= 12053;
        jy += 4 * Math.floor(days / 1461);
        days %= 1461;
        if (days > 365) {
            jy += Math.floor((days - 1) / 365);
            days = (days - 1) % 365;
        }
        if (days < 186) {
            jm = 1 + Math.floor(days / 31);
            jd = 1 + (days % 31);
        } else {
            jm = 7 + Math.floor((days - 186) / 30);
            jd = 1 + ((days - 186) % 30);
        }
        
        const hours = String(tehranTime.getHours()).padStart(2, '0');
        const minutes = String(tehranTime.getMinutes()).padStart(2, '0');
        const seconds = String(tehranTime.getSeconds()).padStart(2, '0');
        
        return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')} - ${hours}:${minutes}:${seconds}`;
    }

    /**
     * ✓ ارسال نوتیفیکیشن بله
     *
     * ✓ Cloudflare fix: مرورگر مستقیماً به Bale API درخواست می‌فرستد
     *   (Cloudflare سرورها نمی‌توانند به tapi.bale.ai برسند — خطای DNS 1016)
     *   اما مرورگر کاربر در ایران می‌تواند مستقیماً به Bale API دسترسی داشته باشد.
     *
     * ✓ CORS fix: از mode: 'no-cors' با Content-Type: text/plain استفاده می‌کنیم
     *   چون Bale API از CORS پشتیبانی نمی‌کند. با no-cors، مرورگر درخواست را
     *   می‌فرستد ولی پاسخ را نمی‌خواند (برای ارسال پیام کافی است).
     *   Bale API با text/plain هم JSON را می‌پذیرد.
     */
    async sendBaleNotification(text) {
        const token = this.settings.baleToken;
        const chatId = this.settings.baleChatId;
        
        if (!token || !chatId) {
            console.log('Bale notification skipped: token or chatId not configured');
            return { ok: false, error: 'Not configured' };
        }

        // ✓ Method 1: Send directly from browser to Bale API using no-cors mode
        // This works because:
        // 1. The browser is in Iran and can reach tapi.bale.ai
        // 2. mode: 'no-cors' bypasses CORS restrictions (text/plain is a simple content type)
        // 3. Bale API accepts text/plain and parses JSON body
        try {
            const baleUrl = `https://tapi.bale.ai/bot${token}/sendMessage`;
            await fetch(baleUrl, {
                method: 'POST',
                mode: 'no-cors', // ✓ bypass CORS — we can't read response but message is sent
                headers: { 'Content-Type': 'text/plain' }, // ✓ simple content type (no preflight)
                body: JSON.stringify({
                    chat_id: String(chatId),
                    text: String(text)
                })
            });
            // With no-cors, we can't read the response, but the request was sent.
            // If there was a network error, the catch block would handle it.
            console.log('✓ Bale notification sent (no-cors from browser)');
            return { ok: true };
        } catch (directError) {
            console.warn('Direct Bale send failed, trying via /api/bale-send:', directError.message);
            
            // ✓ Method 2: Fallback to server-side /api/bale-send
            // This works on local dev (where server can reach tapi.bale.ai)
            try {
                const response = await fetch('/api/bale-send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, chatId, text })
                });

                const result = await response.json();
                if (!result.ok) {
                    console.warn('Bale notification failed (fallback):', result.error);
                }
                return result;
            } catch (error) {
                console.warn('Bale notification error (all methods failed):', error);
                return { ok: false, error: error.message };
            }
        }
    }

    /**
     * ارسال نوتیفیکیشن باز شدن پوزیشن جدید
     * شامل اطلاعات پوزیشن بسته شده (در صورت وجود) + اطلاعات پوزیشن باز شده
     * تاریخ صدور سیگنال = تاریخ کندلی که سیگنال روی آن صادر شده
     * ✓ جهت پوزیشن بسته شده = خلاف جهت سیگنال (پوزیشن معکوس)
     * ✓ پارامترهای اضافه: مارجین، سود/زیان، درصد سود/زیان پوزیشن بسته شده
     * ✓ ترتیب زمان: ابتدا زمان صدور سیگنال، سپس زمان رویداد
     */
    async notifyOpenPosition(symbol, signal, margin, leverage, balance, hadClosedPosition, closedPositionInfo, signalTimestamp) {
        const directionIcon = signal.type === 'Long' ? '🔵' : '🔴';
        const directionText = signal.type === 'Long' ? 'لانگ' : 'شورت';
        const eventTime = this.toJalali(new Date());
        const signalTime = signalTimestamp ? this.toJalali(signalTimestamp) : '-';

        // ✓ جهت پوزیشن بسته شده = خلاف جهت سیگنال جدید (پوزیشن معکوس)
        const closedDirectionText = signal.type === 'Long' ? 'شورت' : 'لانگ';
        const closedDirectionIcon = signal.type === 'Long' ? '🔴' : '🔵';

        let text = '';

        // بخش اول: اطلاعات پوزیشن بسته شده یا عدم وجود پوزیشن مخالف
        if (hadClosedPosition && closedPositionInfo) {
            // ✓ Use actual position data from closedPositionInfo
            const closedMargin = closedPositionInfo.margin ? closedPositionInfo.margin.toFixed(4) : '-';
            const closedPnL = closedPositionInfo.unrealizedPnL !== undefined ? closedPositionInfo.unrealizedPnL.toFixed(4) : '-';
            const closedPnLPercent = closedPositionInfo.profitRate !== undefined ? closedPositionInfo.profitRate.toFixed(2) : '-';
            const closedPnLColor = closedPositionInfo.unrealizedPnL >= 0 ? '📈' : '📉';
            
            text += `🔒 بسته شدن پوزیشن معکوس\n` +
                `⭐ نماد: ${closedPositionInfo.symbol || symbol}\n` +
                `${closedDirectionIcon} جهت: ${closedDirectionText}\n` +
                `🔢 اهرم: ${closedPositionInfo.leverage || leverage}x\n` +
                `💵 مارجین: ${closedMargin} USDT\n` +
                `${closedPnLColor} سود/زیان: ${closedPnL} USDT (${closedPnLPercent}%)\n\n`;
        } else if (hadClosedPosition) {
            // Fallback if position details not available
            text += `🔒 بسته شدن پوزیشن معکوس\n` +
                `⭐ نماد: ${symbol}\n` +
                `${closedDirectionIcon} جهت: ${closedDirectionText}\n` +
                `🔢 اهرم: ${leverage}x\n\n`;
        } else {
            text += `⚠️ پوزیشن مخالف جهت بستن وجود نداشت\n\n`;
        }

        // بخش دوم: اطلاعات پوزیشن باز شده
        text += `🚀 ورود به پوزیشن جدید\n` +
            `⭐ نماد: ${symbol}\n` +
            `${directionIcon} جهت: ${directionText}\n` +
            `💰 قیمت ورود: ${signal.entryPrice || signal.price}\n` +
            `🎯 حد سود: ${signal.tp.toFixed(4)}\n` +
            `🛑 حد ضرر: ${signal.sl.toFixed(4)}\n` +
            `💵 مارجین: ${margin} USDT\n` +
            `🔢 اهرم: ${leverage}x\n` +
            `🏦 موجودی کل: ${balance.total || '-'} USDT\n` +
            `🏦 موجودی آزاد: ${balance.free || '-'} USDT\n` +
            `🕐 زمان صدور سیگنال: ${signalTime}\n` +
            `🕐 زمان رویداد: ${eventTime}\n` +
            `#ورود_پوزیشن`;

        return this.sendBaleNotification(text);
    }

    /**
     * ارسال نوتیفیکیشن خطای مهم
     */
    async notifyError(symbol, errorMessage) {
        const eventTime = this.toJalali(new Date());
        const text = `❌ خطای اتوماسیون\n` +
            `⭐ نماد: ${symbol || '-'}\n` +
            `📝 پیام: ${errorMessage}\n` +
            `🕐 زمان رویداد: ${eventTime}\n` +
            `#خطا`;
        return this.sendBaleNotification(text);
    }

    /**
     * ارسال نوتیفیکیشن عبور از نماد (به دلیل رسیدن خطا به حد مجاز)
     */
    async notifySymbolSkipped(symbol) {
        const eventTime = this.toJalali(new Date());
        const text = `⏭️ عبور از نماد\n` +
            `⭐ نماد: ${symbol}\n` +
            `📝 تعداد خطاها به حد مجاز رسید - خطاها ریست شد و به نماد بعدی پرش شد\n` +
            `🕐 زمان رویداد: ${eventTime}\n` +
            `#عبور_نماد`;
        return this.sendBaleNotification(text);
    }

    /**
     * ✓ ارسال نوتیفیکیشن بله هنگام جلوگیری از باز شدن پوزیشن به دلیل کنترل ریسک
     *
     * ✓ ساختار جدید (ساده‌سازی شده):
     *   - حذف بخش «جزئیات کنترل» (description)
     *   - حذف بخش «نتیجه» (result)
     *   - تغییر ایموجی‌ها: 🚫 ⭐ 🚦 🕐
     *   - اضافه شدن هشتگ در انتهای پیام
     */
    async notifyRiskControlBlocked(symbol, signal, controlDetails) {
        const eventTime = this.toJalali(new Date());
        const directionIcon = signal.type === 'Long' ? '🔵' : '🔴';
        const directionText = signal.type === 'Long' ? 'لانگ' : 'شورت';

        // ✓ تعیین هشتگ بر اساس نوع کنترل
        let hashtag = '#کنترل_ریسک';
        if (controlDetails.controlName.includes('فاصله قیمت')) {
            hashtag = '#فاصله_قیمت';
        } else if (controlDetails.controlName.includes('دارایی امن')) {
            hashtag = '#دارایی_امن';
        } else if (controlDetails.controlName.includes('سقف مارجین')) {
            hashtag = '#سقف_مارجین';
        } else if (controlDetails.controlName.includes('مارجین مثبت')) {
            hashtag = '#مارجین_مثبت';
        } else if (controlDetails.controlName.includes('کندل هم‌جهت') || controlDetails.controlName.includes('کندل هم جهت')) {
            hashtag = '#کندل_هم‌جهت';
        }

        let text = `🚫 جلوگیری از باز شدن پوزیشن\n` +
            `⭐ نماد: ${symbol}\n` +
            `${directionIcon} جهت سیگنال: ${directionText}\n` +
            `🚦 کنترل فعال: ${controlDetails.controlName}\n\n` +
            `📐 قیاس ریاضی:\n` +
            `${controlDetails.math}\n\n` +
            `🕐 زمان رویداد: ${eventTime}\n` +
            `${hashtag}`;

        return this.sendBaleNotification(text);
    }

    /**
     * ارسال پیام تست بله
     */
    async testBaleNotification() {
        const text = '🔔 پیام تست از سیستم اتوماسیون معاملات\nآماده ارسال اطلاعات هستم ✅';
        const result = await this.sendBaleNotification(text);
        if (result.ok) {
            this.log('پیام تست بله با موفقیت ارسال شد', 'success');
            UIUtils.showNotification('پیام تست ارسال شد ✓', 'success', 2000);
        } else {
            this.log('خطا در ارسال پیام تست بله: ' + (result.error || 'نامشخص'), 'error');
            UIUtils.showNotification('خطا در ارسال پیام تست', 'error', 2000);
        }
        return result;
    }

    bindEvents() {
        const bindIfExists = (elementId, eventType, callback) => {
            const el = document.getElementById(elementId);
            if (el) {
                el.addEventListener(eventType, callback);
            }
        };

        bindIfExists('save-settings-btn', 'click', () => {
            this.saveSettings();
        });

        bindIfExists('reset-settings-btn', 'click', () => {
            this.settings = this.getDefaultSettings();
            this.populateSettingsForm();
            localStorage.removeItem('automation_settings');
            this.dbDelete('automation_settings');
            this.log('تنظیمات به حالت پیش‌فرض بازگردانده شد', 'info');
        });

        bindIfExists('add-symbol-btn', 'click', () => {
            const nameInput = document.getElementById('new-symbol-name');
            if (nameInput) {
                const name = nameInput.value;
                this.addSymbol(name);
            }
        });

        // HTF Confirmation Source dropdown - live description update
        const htfSelect = document.getElementById('htf-confirmation-source');
        if (htfSelect) {
            htfSelect.addEventListener('change', () => {
                this.updateHtfDescription(htfSelect.value);
            });
        }

        // Test Bale notification button
        bindIfExists('test-bale-btn', 'click', () => {
            this.testBaleNotification();
        });

        const newSymbolInput = document.getElementById('new-symbol-name');
        if (newSymbolInput) {
            newSymbolInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    const name = e.target.value;
                    this.addSymbol(name);
                }
            });
        }

        bindIfExists('clear-errors-btn', 'click', () => {
            this.clearErrors();
        });

        bindIfExists('start-automation-btn', 'click', () => {
            this.startAutomation();
        });

        bindIfExists('stop-automation-btn', 'click', () => {
            this.stopAutomation();
        });

        bindIfExists('run-once-btn', 'click', async function() {
            if (this.isRunning) {
                this.log('اتوماسیون در حال اجرا است. لطفاً ابتدا آن را متوقف کنید', 'warning');
                return;
            }
            // ✓ مورد ۷: Run cyclesPerRun cycles sequentially
            const cyclesPerRun = this.settings.cyclesPerRun || 1;
            this.log(`شروع ${cyclesPerRun} چرخه متوالی...`, 'info');
            for (let i = 0; i < cyclesPerRun; i++) {
                this.log(`چرخه ${i + 1} از ${cyclesPerRun}`, 'info');
                await this.runCycle();
                // ✓ Delay between cycles (1 second) to avoid exchange rate-limits
                if (i < cyclesPerRun - 1) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
            this.log(`${cyclesPerRun} چرخه تکمیل شد`, 'success');
        }.bind(this));

        bindIfExists('toggle-settings-btn', 'click', () => {
            this.toggleSettings();
        });

        const settingsModal = document.getElementById('settings-modal');
        if (settingsModal) {
            settingsModal.addEventListener('click', (e) => {
                if (e.target.id === 'settings-modal') {
                    this.toggleSettings();
                }
            });
        }
        
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.settingsPanelCollapsed) {
                this.toggleSettings();
            }
        });

        bindIfExists('clear-log-btn', 'click', () => {
            this.clearLog();
        });

        bindIfExists('table-search', 'input', (e) => {
            UIUtils.filterTable(e.target.value, 'market-data-body');
        });

        bindIfExists('history-search', 'input', (e) => {
            UIUtils.filterTable(e.target.value, 'history-table-body');
        });

        bindIfExists('export-market-btn', 'click', () => {
            if (this.currentSymbolData) {
                UIUtils.exportToCSV(this.currentSymbolData, `${this.signalSymbol}_market_${new Date().toISOString().split('T')[0]}.csv`);
            }
        });

        bindIfExists('export-history-btn', 'click', () => {
            if (this.currentSymbolHistory) {
                UIUtils.exportToCSV(this.currentSymbolHistory, `${this.signalSymbol}_history_${new Date().toISOString().split('T')[0]}.csv`);
            }
        });

        // Balance refresh (top bar)
        bindIfExists('refresh-balance-btn', 'click', () => {
            this.fetchBalanceForBar();
        });

        // Open positions refresh
        bindIfExists('refresh-positions-btn', 'click', () => {
            this.fetchOpenPositionsForTable();
        });

        // ✓ Refresh all data button (history → market → signals → chart → ready signal)
        bindIfExists('refresh-all-data-btn', 'click', () => {
            this.refreshAllData();
        });

        // ✓ Refresh market data only (fetches market data for first symbol + updates market table + chart)
        bindIfExists('refresh-market-data-btn', 'click', () => {
            this.refreshMarketDataOnly();
        });

        // ✓ Generate signals (uses current market data + history for first symbol + updates signal details + chart)
        bindIfExists('refresh-signals-btn', 'click', () => {
            this.refreshSignalsOnly();
        });
    }
}

// Initialize
let automationManager;
console.log('✓ automation-manager.js loaded');
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOMContentLoaded - Initializing AutomationManager...');
    automationManager = new AutomationManager();
    // ✓ Expose on window for debugging / inspection
    window.automationManager = automationManager;
    console.log('✓ AutomationManager initialized');
    
    window.addEventListener('resize', () => {
        if (automationManager.chart) {
            VisualizationUtils.resizeChart(automationManager.chart);
        }
    });
});
