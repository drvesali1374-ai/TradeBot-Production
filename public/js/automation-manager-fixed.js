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
        
        // Market data storage (for signal generation)
        this.marketData = [];
        this.marketDataTimestamp = null;
        this.marketDataSymbol = null;
        
        // Signal storage (تمام سیگنال‌های تولید شده)
        this.signals = [];
        this.signalTimestamp = null;
        this.signalSymbol = null;
        
        // Visualization data
        this.currentSymbolData = null;
        this.currentSymbolHistory = null;
        this.chart = null;
        
        // Settings panel state
        this.settingsPanelCollapsed = false;
        
        this.init();
    }

    init() {
        this.loadSettings();
        this.loadSymbols();
        this.loadLogsFromDatabase();
        this.initChart();
        this.bindEvents();
        this.renderSymbolsTable();
        this.updateUIState();
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
            winRate: 55,
            riskReward: 2,
            kellyFraction: 0.25,
            minMargin: 2,
            maxMargin: 10,
            tradeWaitTime: 60,
            allowedErrors: 3,
            leverage: 4,
            signalExpirationHours: 6
        };
    }

    loadSettings() {
        const saved = localStorage.getItem('automation_settings');
        if (saved) {
            this.settings = { ...this.getDefaultSettings(), ...JSON.parse(saved) };
        }
        this.populateSettingsForm();
    }

    saveSettings() {
        this.settings = {
            winRate: parseFloat(document.getElementById('win-rate').value),
            riskReward: parseFloat(document.getElementById('risk-reward').value),
            kellyFraction: parseFloat(document.getElementById('kelly-fraction').value),
            minMargin: parseFloat(document.getElementById('min-margin').value),
            maxMargin: parseFloat(document.getElementById('max-margin').value),
            tradeWaitTime: parseInt(document.getElementById('trade-wait-time').value),
            allowedErrors: parseInt(document.getElementById('allowed-errors').value),
            leverage: parseInt(document.getElementById('leverage').value),
            signalExpirationHours: parseInt(document.getElementById('signal-expiration').value) || 6
        };
        localStorage.setItem('automation_settings', JSON.stringify(this.settings));
        this.log('تنظیمات با موفقیت ذخیره شد', 'success');
        UIUtils.showNotification('تنظیمات به‌روز شدند ✓', 'success', 2000);
        this.renderSymbolsTable();
    }

    populateSettingsForm() {
        document.getElementById('win-rate').value = this.settings.winRate;
        document.getElementById('risk-reward').value = this.settings.riskReward;
        document.getElementById('kelly-fraction').value = this.settings.kellyFraction;
        document.getElementById('min-margin').value = this.settings.minMargin;
        document.getElementById('max-margin').value = this.settings.maxMargin;
        document.getElementById('trade-wait-time').value = this.settings.tradeWaitTime;
        document.getElementById('allowed-errors').value = this.settings.allowedErrors;
        document.getElementById('leverage').value = this.settings.leverage;
        document.getElementById('signal-expiration').value = this.settings.signalExpirationHours;
    }

    loadSymbols() {
        const saved = localStorage.getItem('automation_symbols');
        if (saved) {
            this.symbols = JSON.parse(saved);
        } else {
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
            if (symbol.errorCount < this.settings.allowedErrors) {
                symbol.errorCount = 0;
                symbol.status = 'waiting';
            }
        });
        this.saveSymbols();
        this.renderSymbolsTable();
        this.log('خطاهای قابل پاکسازی حذف شدند', 'success');
    }

    selectNextSymbol() {
        const now = Date.now();
        const waitTimeMs = this.settings.tradeWaitTime * 60 * 1000;

        const readySymbols = this.symbols.filter(symbol => {
            if (symbol.errorCount >= this.settings.allowedErrors) {
                return false;
            }

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

        const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
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
        for (let i = 0; i < N; i++) {
            const localTs = data[i].timestamp.getTime() + offset;
            const day = Math.floor(localTs / 86400000);
            const prevDayIndex = days.indexOf(day) - 1;
            if (prevDayIndex >= 0) {
                const prevDay = days[prevDayIndex];
                prevDailyHighs.push(dailyData[prevDay].maxHigh);
                prevDailyLows.push(dailyData[prevDay].minLow);
            } else {
                prevDailyHighs.push(null);
                prevDailyLows.push(null);
            }
        }

        // Calculate indicators
        const atr = SignalUtils.calculateATR(data, settings.atrPeriod || 14);
        const avgVols = SignalUtils.calculateSMA(data.map(d => d.amount), settings.avgVolPeriod || 50);
        const rsi = SignalUtils.calculateRSI(data, settings.rsiPeriod || 14);

        // Track crossovers
        let lastUL = null, lastOH = null;
        const lastCrossUnderPL = new Array(N).fill(Infinity);
        const lastCrossOverPH = new Array(N).fill(Infinity);
        for (let i = 1; i < N; i++) {
            if (data[i].close < prevDailyLows[i] && data[i - 1].close >= prevDailyLows[i - 1]) lastUL = i;
            if (data[i].close > prevDailyHighs[i] && data[i - 1].close <= prevDailyHighs[i - 1]) lastOH = i;
            lastCrossUnderPL[i] = lastUL === null ? Infinity : i - lastUL;
            lastCrossOverPH[i] = lastOH === null ? Infinity : i - lastOH;
        }

        // Generate signals
        this.signals = [];
        for (let i = 1; i < N - 1; i++) {
            const isCrossOverPL = data[i].close > prevDailyLows[i] && data[i - 1].close <= prevDailyLows[i - 1];
            const isCrossUnderPH = data[i].close < prevDailyHighs[i] && data[i - 1].close >= prevDailyHighs[i - 1];
            const htfConfirmLong = prevDailyLows[i] !== null && data[i].close > prevDailyLows[i];
            const htfConfirmShort = prevDailyHighs[i] !== null && data[i].close < prevDailyHighs[i];
            
            const condLong = isCrossOverPL
                && lastCrossUnderPL[i] <= (settings.lookback || 50)
                && avgVols[i] !== null
                && data[i].amount > avgVols[i] * (settings.volMult || 0.2)
                && rsi[i] !== null
                && rsi[i] < (settings.rsiThreshold || 50)
                && htfConfirmLong;
            
            const condShort = isCrossUnderPH
                && lastCrossOverPH[i] <= (settings.lookback || 50)
                && avgVols[i] !== null
                && data[i].amount > avgVols[i] * (settings.volMult || 0.2)
                && rsi[i] !== null
                && rsi[i] > (settings.rsiThreshold || 50)
                && htfConfirmShort;

            data[i].rsi = rsi[i];
            data[i].atr = atr[i];

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
                    symbol: symbol
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
                    symbol: symbol
                });
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
    calculateSignalStatus(signal) {
        const openPositions = this.currentSymbolHistory.filter(pos => 
            pos.side && pos.side.includes('OPEN')
        );
        
        if (openPositions.length === 0) {
            const isLatest = this.signals.indexOf(signal) === this.signals.length - 1;
            return {
                text: isLatest ? 'در انتظار' : 'باز نشده',
                color: 'text-yellow-400'
            };
        }
        
        const currentIndex = this.signals.indexOf(signal);
        const nextSignal = currentIndex < this.signals.length - 1 ? this.signals[currentIndex + 1] : null;
        
        const currentTime = signal.timestamp.getTime();
        const nextTime = nextSignal ? nextSignal.timestamp.getTime() : Infinity;
        
        const matchingPositions = openPositions.filter(pos => {
            const posTime = pos.time.getTime();
            return posTime >= currentTime && posTime < nextTime;
        });
        
        if (matchingPositions.length === 0) {
            const isLatest = currentIndex === this.signals.length - 1;
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
    }

    /**
     * رندر کردن نمودار با علامت‌های Long، Short و Close
     * (دقیقاً مثل داشبورد)
     */
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
     */
    populateMarketDataTable() {
        const tbody = document.getElementById('market-data-body');
        tbody.innerHTML = '';
        
        this.currentSymbolData.forEach(candle => {
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

    // ==================== اپدیت و نمایش ویژولایزیشن ====================
    
    updateVisualization(symbol, marketData) {
        // Clear previous data
        this.currentSymbolData = [];
        this.signals = [];
        
        // Clear UI
        document.getElementById('market-data-body').innerHTML = '';
        document.getElementById('signal-list').innerHTML = '';
        
        try {
            // Analyze market and generate signals
            this.analyzeMarketData(symbol);
            
            // Populate all sections in order
            this.populateMarketDataTable();
            this.renderSignalDetails();
            this.renderChart();
            
            this.log(`${symbol}: داده‌ها و سیگنال‌ها به‌روز شدند`, 'success', symbol);
        } catch (error) {
            this.log(`${symbol}: خطا در به‌روز رسانی: ${error.message}`, 'error', symbol);
        }
    }

    // ==================== چرخه اتوماسیون ====================

    async runCycle() {
        const symbol = this.selectNextSymbol();
        
        if (!symbol) {
            this.log('هیچ نمادی برای معامله آماده نیست', 'warning');
            return false;
        }

        this.currentCycleSymbol = symbol;
        symbol.status = 'running';
        this.renderSymbolsTable();
        this.log(`شروع چرخه برای نماد ${symbol.name}`, 'info', symbol.name);

        try {
            // 1. Fetch market data
            await this.fetchMarketData(symbol.name);
            
            // 2. Update visualization with signal analysis
            this.updateVisualization(symbol.name, this.marketData);
            
            // 3. Check if latest signal exists and has valid status
            if (this.signals.length === 0) {
                throw new Error('NO_SIGNAL_GENERATED');
            }
            
            const latestSignal = this.signals[this.signals.length - 1];
            const latestStatus = this.calculateSignalStatus(latestSignal);
            
            // Validate signal is in "در انتظار" (Pending) status
            if (latestStatus.text !== 'در انتظار') {
                this.log(`${symbol.name}: آخرین سیگنال وضعیت "در انتظار" را ندارد - از این نماد عبور میشود`, 'warning', symbol.name);
                symbol.status = 'waiting';
                symbol.lastCycleTime = Date.now();
                symbol.errorCount = 0;
                this.saveSymbols();
                this.renderSymbolsTable();
                this.currentCycleSymbol = null;
                return false;
            }

            // 4. Fetch position history
            this.log(`${symbol.name}: دریافت تاریخچه معاملات...`, 'info', symbol.name);
            const history = await this.fetchPositionHistory(symbol.name);
            
            this.currentSymbolHistory = history.map(item => ({
                time: new Date(parseInt(item.time || 0)),
                symbol: item.symbol || '-',
                price: parseFloat(item.price || 0),
                qty: parseFloat(item.qty || 0),
                commission: parseFloat(item.commission || 0),
                side: item.side || '-',
                realizedPnl: parseFloat(item.realizedPnl || 0)
            }));
            
            this.log(`${symbol.name}: ${this.currentSymbolHistory.length} معامله یافت شد`, 'success', symbol.name);
            
            // Update visualization again with history
            this.renderSignalDetails();
            this.renderChart();

            // 5. Fetch current price
            this.log(`${symbol.name}: دریافت قیمت...`, 'info', symbol.name);
            const price = await this.fetchPrice(symbol.name);
            this.log(`${symbol.name}: قیمت فعلی = ${price}`, 'success', symbol.name);

            // 6. Close opposite positions
            this.log(`${symbol.name}: بررسی پوزیشن‌های مخالف...`, 'info', symbol.name);
            const closed = await this.closeOppositePositions(symbol.name, latestSignal.type);
            if (closed > 0) {
                this.log(`${symbol.name}: ${closed} پوزیشن مخالف بسته شد`, 'success', symbol.name);
            } else {
                this.log(`${symbol.name}: پوزیشن مخالفی یافت نشد`, 'info', symbol.name);
            }

            // 7. Fetch balance
            this.log(`${symbol.name}: دریافت موجودی حساب...`, 'info', symbol.name);
            const balance = await this.fetchBalance();
            this.log(`${symbol.name}: موجودی آزاد = ${balance.free} USDT`, 'success', symbol.name);

            // 8. Calculate margin
            this.log(`${symbol.name}: محاسبه مارجین با استفاده از Kelly Criterion...`, 'info', symbol.name);
            const margin = this.calculateMargin(balance.free, this.currentSymbolHistory);
            this.log(`${symbol.name}: مارجین محاسبه شده = ${margin} USDT`, 'success', symbol.name);

            // 9. Open position
            this.log(`${symbol.name}: باز کردن پوزیشن جدید...`, 'info', symbol.name);
            const signalType = latestSignal.type === 'Long' ? 'long' : 'short';
            const result = await this.openPosition(symbol.name, {
                type: signalType,
                entryPrice: price,
                tp: latestSignal.tp,
                sl: latestSignal.sl
            }, margin);
            this.log(`${symbol.name}: پوزیشن باز شد (سفارش: ${result.orderId}, مقدار: ${result.quantity})`, 'success', symbol.name);

            // Update symbol status
            symbol.status = 'waiting';
            symbol.lastCycleTime = Date.now();
            symbol.errorCount = 0;
            this.saveSymbols();
            this.renderSymbolsTable();

            this.log(`چرخه ${symbol.name} با موفقیت انجام شد`, 'success', symbol.name);
            this.currentCycleSymbol = null;
            return true;

        } catch (error) {
            if (error.message === 'NO_SIGNAL_GENERATED') {
                this.log(`${symbol.name}: هیچ سیگنالی یافت نشد - شرایط بازار مناسب نیست`, 'warning', symbol.name);
                this.currentCycleSymbol = null;
                return false;
            }
            
            symbol.errorCount++;
            
            if (symbol.errorCount >= this.settings.allowedErrors) {
                // Update last cycle time before locking
                symbol.lastCycleTime = Date.now();
                symbol.status = 'locked';
                this.log(`${symbol.name}: خطا - تعداد خطا به حد مجاز رسید. نماد قفل شد.`, 'error', symbol.name);
                symbol.errorCount = 0;
            } else {
                symbol.status = 'error';
                this.log(`${symbol.name}: خطا - ${error.message} (تلاش ${symbol.errorCount}/${this.settings.allowedErrors})`, 'error', symbol.name);
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
            return data.data || [];
        } catch (error) {
            throw new Error(`خطا در دریافت تاریخچه: ${error.message}`);
        }
    }

    async closeOppositePositions(symbol, signalType) {
        try {
            const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};
            const oppositeDirection = signalType === 'Long' ? 'short' : 'long';

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
            return data.closed || 0;
        } catch (error) {
            console.warn('Error closing opposite positions:', error);
            return 0;
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

    calculateMargin(availableBalance, history) {
        const winRate = this.settings.winRate / 100;
        const riskReward = this.settings.riskReward;
        const kellyPercent = winRate - ((1 - winRate) / riskReward);
        const adjustedKelly = kellyPercent * this.settings.kellyFraction;
        
        let margin = availableBalance * adjustedKelly;
        margin = Math.max(this.settings.minMargin, margin);
        margin = Math.min(this.settings.maxMargin, margin);
        
        return parseFloat(margin.toFixed(2));
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
                               symbol.status === 'error' ? 'status-error' :
                               symbol.status === 'locked' ? 'status-locked' : 'status-waiting';
            
            const statusText = symbol.status === 'running' ? 'در حال اجرا' :
                              symbol.status === 'error' ? 'خطا' :
                              symbol.status === 'locked' ? 'قفل شده' : 'در انتظار';
            
            const lastCycleText = symbol.lastCycleTime ? 
                new Date(symbol.lastCycleTime).toLocaleString('fa-IR') : '-';

            const waitTimeText = symbol.errorCount >= this.settings.allowedErrors ? 
                'قفل شده' : (remainingTime > 0 ? `${remainingTime} دقیقه` : 'آماده');

            return `
                <tr class="border-b border-gray-800 hover:bg-white/5">
                    <td class="px-4 py-3">${index + 1}</td>
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
        UIUtils.log(message, type, 'cycle-log');
        
        this.saveLogToDatabase({
            symbol: symbol || null,
            action: 'automation_cycle',
            status: type === 'error' ? 'ERROR' : type === 'warning' ? 'WARNING' : 'SUCCESS',
            message: message,
            error_code: type === 'error' ? 'SIGNAL_ERROR' : null,
            details: JSON.stringify({ timestamp: new Date().toISOString(), type: type })
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
                const logDiv = document.getElementById('cycle-log');
                logDiv.innerHTML = '';
                
                result.data.reverse().forEach(log => {
                    const typeMap = { 'ERROR': 'error', 'WARNING': 'warning', 'SUCCESS': 'success' };
                    const type = typeMap[log.status] || 'info';
                    const timestamp = new Date(log.created_at).toLocaleString('fa-IR');
                    
                    const icon = type === 'success' ? 'fa-check-circle' : 
                                type === 'error' ? 'fa-exclamation-circle' : 
                                type === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle';
                    
                    const color = type === 'success' ? 'text-green-400' : 
                                 type === 'error' ? 'text-red-400' : 
                                 type === 'warning' ? 'text-yellow-400' : 'text-blue-400';
                    
                    const logEntry = document.createElement('div');
                    logEntry.className = `${color} text-xs`;
                    logEntry.innerHTML = `
                        <span class="text-gray-500">[${timestamp}]</span>
                        <i class="fas ${icon} mx-1"></i>
                        ${log.message}
                    `;
                    logDiv.appendChild(logEntry);
                });
            }
        } catch (err) {
            console.warn('Failed to load logs:', err);
        }
    }

    clearLog() {
        UIUtils.clearLog('cycle-log');
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
            this.log('تنظیمات به حالت پیش‌فرض بازگردانده شد', 'info');
        });

        bindIfExists('add-symbol-btn', 'click', () => {
            const nameInput = document.getElementById('new-symbol-name');
            if (nameInput) {
                const name = nameInput.value;
                this.addSymbol(name);
            }
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
            await this.runCycle();
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
    }
}

// Initialize
let automationManager;
console.log('✓ automation-manager.js loaded');
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOMContentLoaded - Initializing AutomationManager...');
    automationManager = new AutomationManager();
    console.log('✓ AutomationManager initialized');
    
    window.addEventListener('resize', () => {
        if (automationManager.chart) {
            VisualizationUtils.resizeChart(automationManager.chart);
        }
    });
});
