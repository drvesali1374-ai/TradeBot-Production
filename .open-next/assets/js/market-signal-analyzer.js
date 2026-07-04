/**
 * Market Signal Analyzer - Dashboard specific logic
 * منطق خاص صفحه داشبورد تجزیه سیگنال‌های بازار
 * Uses shared utilities from: signal-utils.js, visualization.js, ui-utils.js
 */

class MarketSignalAnalyzer {
    constructor() {
        this.marketData = [];
        this.historyData = [];
        this.signals = [];
        this.settings = {};
        this.chart = null;
        
        // Timestamps for preserving original fetch times
        this.marketDataTimestamp = null;
        this.historyTimestamp = null;
        this.signalTimestamp = null;
        this.chartTimestamp = null;
        
        // Store symbol names at fetch time
        this.marketDataSymbol = null;
        this.historyDataSymbol = null;
        this.signalSymbol = null;
        
        // Load persisted data from sessionStorage
        this.loadPersistedData();
        this.loadSettings();
        this.initChart();
        this.bindEvents();
        
        // Restore UI if data exists
        if (this.marketData.length > 0) {
            this.populateTable();
            this.updateStatistics();
            if (this.marketDataTimestamp) {
                this.updateMarketDataMeta();
                this.updateMarketStatsSymbol();
            }
            document.getElementById('analyze-btn').disabled = false;
            document.getElementById('export-market-btn').disabled = false;
        }
        if (this.historyData.length > 0) {
            this.populateHistoryTable();
            if (this.historyTimestamp) {
                this.updateHistoryMeta();
            }
            document.getElementById('export-history-btn').disabled = false;
        }
        if (this.signals.length > 0) {
            this.showSignalDetails();
            this.renderChart();
            if (this.signalTimestamp) {
                this.updateSignalMeta();
                this.updateSignalStatsSymbol();
            }
            if (this.chartTimestamp) {
                this.updateChartMeta();
            }
        }
    }

    getDefaultSettings() {
        return {
            symbolName: 'DOT',
            interval: '1h',
            limit: 1000,
            lookback: 50,
            volMult: 0.2,
            avgVolPeriod: 50,
            rsiThreshold: 50,
            rsiPeriod: 14,
            atrPeriod: 14,
            tpLongMult: 20,
            slLongMult: 6,
            tpShortMult: 24,
            slShortMult: 4,
            longFixedTp: null,
            longFixedSl: null,
            shortFixedTp: null,
            shortFixedSl: 6,
            apiKey: '',
            secretKey: '',
            baseUrl: 'https://api.toobit.com'
        };
    }

    loadSettings() {
        const saved = localStorage.getItem('marketSignalSettings');
        this.settings = saved ? JSON.parse(saved) : this.getDefaultSettings();
        if (!this.settings.symbolName || this.settings.symbolName.trim() === '') {
            this.settings.symbolName = 'DOT';
        }
    }

    // Save data to sessionStorage with timestamps
    savePersistedData() {
        try {
            sessionStorage.setItem('marketData', JSON.stringify(this.marketData.map(d => ({
                ...d,
                timestamp: d.timestamp.toISOString ? d.timestamp.toISOString() : d.timestamp
            }))));
            sessionStorage.setItem('historyData', JSON.stringify(this.historyData.map(d => ({
                ...d,
                time: d.time.toISOString ? d.time.toISOString() : d.time
            }))));
            sessionStorage.setItem('signals', JSON.stringify(this.signals.map(s => ({
                ...s,
                timestamp: s.timestamp.toISOString ? s.timestamp.toISOString() : s.timestamp
            }))));
            
            // Save timestamps and symbols
            const metadata = {
                marketDataTimestamp: this.marketDataTimestamp,
                historyTimestamp: this.historyTimestamp,
                signalTimestamp: this.signalTimestamp,
                chartTimestamp: this.chartTimestamp,
                marketDataSymbol: this.marketDataSymbol,
                historyDataSymbol: this.historyDataSymbol,
                signalSymbol: this.signalSymbol
            };
            sessionStorage.setItem('metadata', JSON.stringify(metadata));
        } catch (e) {
            console.warn('Failed to persist data:', e);
        }
    }

    // Load persisted data from sessionStorage
    loadPersistedData() {
        try {
            const marketData = sessionStorage.getItem('marketData');
            const historyData = sessionStorage.getItem('historyData');
            const signals = sessionStorage.getItem('signals');
            const metadata = sessionStorage.getItem('metadata');
            
            if (marketData) {
                this.marketData = JSON.parse(marketData).map(d => ({
                    ...d,
                    timestamp: new Date(d.timestamp)
                }));
            }
            if (historyData) {
                this.historyData = JSON.parse(historyData).map(d => ({
                    ...d,
                    time: new Date(d.time)
                }));
            }
            if (signals) {
                this.signals = JSON.parse(signals).map(s => ({
                    ...s,
                    timestamp: new Date(s.timestamp)
                }));
            }
            if (metadata) {
                const meta = JSON.parse(metadata);
                this.marketDataTimestamp = meta.marketDataTimestamp;
                this.historyTimestamp = meta.historyTimestamp;
                this.signalTimestamp = meta.signalTimestamp;
                this.chartTimestamp = meta.chartTimestamp;
                this.marketDataSymbol = meta.marketDataSymbol;
                this.historyDataSymbol = meta.historyDataSymbol;
                this.signalSymbol = meta.signalSymbol;
            }
        } catch (e) {
            console.warn('Failed to load persisted data:', e);
        }
    }

    // Update meta info with PRESERVED timestamps and symbols
    updateMarketDataMeta() {
        const meta = document.getElementById('market-data-meta');
        const now = this.marketDataTimestamp ? new Date(this.marketDataTimestamp).toLocaleString('fa-IR') : new Date().toLocaleString('fa-IR');
        const symbol = this.marketDataSymbol || this.settings.symbolName;
        meta.textContent = `نماد: ${symbol} | بارگذاری: ${now}`;
    }

    updateMarketStatsSymbol() {
        const el = document.getElementById('market-stats-symbol');
        const symbol = this.marketDataSymbol || this.settings.symbolName;
        el.textContent = `نماد: ${symbol}`;
    }

    updateSignalStatsSymbol() {
        const el = document.getElementById('signal-stats-symbol');
        const symbol = this.signalSymbol || this.settings.symbolName;
        el.textContent = `نماد: ${symbol}`;
    }

    updateHistoryMeta() {
        const meta = document.getElementById('history-meta');
        const now = this.historyTimestamp ? new Date(this.historyTimestamp).toLocaleString('fa-IR') : new Date().toLocaleString('fa-IR');
        const symbol = this.historyDataSymbol || this.settings.symbolName;
        meta.textContent = `نماد: ${symbol} | بارگذاری: ${now}`;
    }

    updateSignalMeta() {
        const meta = document.getElementById('signal-meta');
        const now = this.signalTimestamp ? new Date(this.signalTimestamp).toLocaleString('fa-IR') : new Date().toLocaleString('fa-IR');
        const symbol = this.signalSymbol || this.settings.symbolName;
        meta.textContent = `نماد: ${symbol} | تولید سیگنال: ${now}`;
    }

    updateChartMeta() {
        const meta = document.getElementById('chart-meta');
        const symbolName = document.getElementById('chart-symbol-name');
        const now = this.chartTimestamp ? new Date(this.chartTimestamp).toLocaleString('fa-IR') : new Date().toLocaleString('fa-IR');
        meta.textContent = `بارگذاری: ${now}`;
        const symbol = this.signalSymbol || this.settings.symbolName;
        symbolName.textContent = symbol;
    }

    bindEvents() {
        const bindIfExists = (elementId, eventType, callback) => {
            const el = document.getElementById(elementId);
            if (el) {
                el.addEventListener(eventType, callback);
            }
        };

        bindIfExists('fetch-data-btn', 'click', () => this.fetchData());
        bindIfExists('fetch-history-btn', 'click', () => this.fetchHistory());
        bindIfExists('analyze-btn', 'click', () => this.analyzeData());
        bindIfExists('export-market-btn', 'click', () => this.exportMarketData());
        bindIfExists('export-history-btn', 'click', () => this.exportHistoryData());
        bindIfExists('table-search', 'input', (e) => this.filterTable(e.target.value));
        bindIfExists('signal-filter', 'change', (e) => this.filterBySignal(e.target.value));
        bindIfExists('history-search', 'input', (e) => this.filterHistoryTable(e.target.value));
        bindIfExists('side-filter', 'change', (e) => this.filterBySide(e.target.value));
    }

    initChart() {
        this.chart = VisualizationUtils.initChart(document.getElementById('price-chart'));
    }

    async fetchData() {
        UIUtils.setLoading(true, 'loading-indicator');
        this.updateStatus('در حال دریافت داده‌های بازار...', 'loading');

        const market = this.settings.symbolName + 'USDT';
        const url = `/api/toobit-proxy?symbol=${encodeURIComponent(market)}&interval=${encodeURIComponent(this.settings.interval)}&limit=${encodeURIComponent(this.settings.limit)}`;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || 'Network response was not ok: ' + response.statusText);
            }
            const data = await response.json();
            if (!Array.isArray(data)) {
                throw new Error('Toobit API error: ' + (data.msg || 'Unknown error'));
            }

            this.marketData = data.map(candle => ({
                timestamp: new Date(candle[0]),
                open: parseFloat(candle[1]),
                high: parseFloat(candle[2]),
                low: parseFloat(candle[3]),
                close: parseFloat(candle[4]),
                amount: parseFloat(candle[5]),
                value: parseFloat(candle[7])
            }));

            // Store timestamp and symbol when data was fetched
            this.marketDataTimestamp = Date.now();
            this.marketDataSymbol = this.settings.symbolName;
            
            this.updateStatus('داده‌های بازار با موفقیت دریافت شدند', 'success');
            document.getElementById('analyze-btn').disabled = false;
            document.getElementById('export-market-btn').disabled = false;
            this.populateTable();
            this.updateStatistics();
            this.updateMarketDataMeta();
            this.updateMarketStatsSymbol();
            this.savePersistedData();
        } catch (e) {
            console.error('Fetch error:', e);
            alert('خطا در دریافت داده‌های بازار: ' + e.message);
            this.updateStatus('خطا در دریافت داده‌های بازار: ' + e.message, 'error');
        } finally {
            UIUtils.setLoading(false, 'loading-indicator');
        }
    }

    async fetchHistory() {
        UIUtils.setLoading(true, 'loading-indicator');
        this.updateStatus('در حال دریافت سوابق پوزیشن‌ها...', 'loading');

        const historySymbol = this.settings.symbolName + '-SWAP-USDT';

        try {
            const response = await fetch('/api/history', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    symbol: historySymbol,
                    apiKey: this.settings.apiKey,
                    secretKey: this.settings.secretKey,
                    baseUrl: this.settings.baseUrl || 'https://api.toobit.com',
                    limit: '100',
                    recvWindow: '5000'
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || 'History API response not ok: ' + response.statusText);
            }

            const data = await response.json();
            if (!Array.isArray(data)) {
                throw new Error('History API error: ' + (data.msg || 'Unknown error'));
            }

            this.historyData = data.map(item => ({
                time: new Date(parseInt(item.time || 0)),
                symbol: item.symbol || '-',
                price: parseFloat(item.price || 0),
                qty: parseFloat(item.qty || 0),
                commission: parseFloat(item.commission || 0),
                side: item.side || '-',
                realizedPnl: parseFloat(item.realizedPnl || 0)
            }));

            // Store timestamp and symbol when data was fetched
            this.historyTimestamp = Date.now();
            this.historyDataSymbol = this.settings.symbolName;

            this.updateStatus(`سوابق پوزیشن‌ها با موفقیت دریافت شدند (${this.historyData.length} رکورد)`, 'success');
            document.getElementById('export-history-btn').disabled = false;
            this.populateHistoryTable();
            this.updateHistoryMeta();
            this.savePersistedData();
        } catch (e) {
            console.error(e);
            alert('خطا در دریافت سوابق پوزیشن‌ها: ' + e.message);
            this.updateStatus('خطا در دریافت سوابق پوزیشن‌ها: ' + e.message, 'error');
        } finally {
            UIUtils.setLoading(false, 'loading-indicator');
        }
    }

    analyzeData() {
        if (this.marketData.length === 0) {
            this.updateStatus('ابتدا داده‌ها را دریافت کنید', 'error');
            return;
        }

        UIUtils.setLoading(true, 'loading-indicator');
        this.updateStatus('در حال تحلیل...', 'loading');

        const offset = 3.5 * 3600 * 1000;
        const N = this.marketData.length;
        const data = this.marketData;

        // Calculate daily data
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

        const dates = [];
        const prevDailyHighs = [];
        const prevDailyLows = [];
        const dailyCloses = [];
        for (let i = 0; i < N; i++) {
            const localTs = data[i].timestamp.getTime() + offset;
            const day = Math.floor(localTs / 86400000);
            const midnightUtc = day * 86400000 - offset;
            dates.push(new Date(midnightUtc));
            const prevDayIndex = days.indexOf(day) - 1;
            if (prevDayIndex >= 0) {
                const prevDay = days[prevDayIndex];
                prevDailyHighs.push(dailyData[prevDay].maxHigh);
                prevDailyLows.push(dailyData[prevDay].minLow);
            } else {
                prevDailyHighs.push(null);
                prevDailyLows.push(null);
            }
            dailyCloses.push(dailyData[day].lastClose);
        }

        // Calculate indicators using shared utilities
        const atr = SignalUtils.calculateATR(data, this.settings.atrPeriod);
        const avgVols = SignalUtils.calculateSMA(data.map(d => d.amount), this.settings.avgVolPeriod);
        const rsi = SignalUtils.calculateRSI(data, this.settings.rsiPeriod);

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
            const htfConfirmLong = prevDailyLows[i] !== null && dailyCloses[i] > prevDailyLows[i];
            const htfConfirmShort = prevDailyHighs[i] !== null && dailyCloses[i] < prevDailyHighs[i];
            const condLong = isCrossOverPL
                && lastCrossUnderPL[i] <= this.settings.lookback
                && avgVols[i] !== null
                && data[i].amount > avgVols[i] * this.settings.volMult
                && rsi[i] !== null
                && rsi[i] < this.settings.rsiThreshold
                && htfConfirmLong;
            const condShort = isCrossUnderPH
                && lastCrossOverPH[i] <= this.settings.lookback
                && avgVols[i] !== null
                && data[i].amount > avgVols[i] * this.settings.volMult
                && rsi[i] !== null
                && rsi[i] > this.settings.rsiThreshold
                && htfConfirmShort;

            data[i].rsi = rsi[i];
            data[i].atr = atr[i];

            if (condLong) {
                data[i].signal = 'Long';
                if (this.settings.longFixedTp !== null && !isNaN(this.settings.longFixedTp)) {
                    data[i].tp = data[i].close + (data[i].close * (this.settings.longFixedTp / 100));
                } else {
                    data[i].tp = data[i].close + (atr[i] * this.settings.tpLongMult);
                }
                if (this.settings.longFixedSl !== null && !isNaN(this.settings.longFixedSl)) {
                    data[i].sl = data[i].close - (data[i].close * (this.settings.longFixedSl / 100));
                } else {
                    data[i].sl = data[i].close - (atr[i] * this.settings.slLongMult);
                }
                data[i].clientOrderId = SignalUtils.generateOrderId(data[i].timestamp, this.settings.symbolName);
                this.signals.push({
                    type: 'Long',
                    timestamp: data[i].timestamp,
                    price: data[i].close,
                    tp: data[i].tp,
                    sl: data[i].sl,
                    orderId: data[i].clientOrderId,
                    symbol: this.settings.symbolName
                });
            } else if (condShort) {
                data[i].signal = 'Short';
                if (this.settings.shortFixedTp !== null && !isNaN(this.settings.shortFixedTp)) {
                    data[i].tp = data[i].close - (data[i].close * (this.settings.shortFixedTp / 100));
                } else {
                    data[i].tp = data[i].close - (atr[i] * this.settings.tpShortMult);
                }
                if (this.settings.shortFixedSl !== null && !isNaN(this.settings.shortFixedSl)) {
                    data[i].sl = data[i].close + (data[i].close * (this.settings.shortFixedSl / 100));
                } else {
                    data[i].sl = data[i].close + (atr[i] * this.settings.slShortMult);
                }
                data[i].clientOrderId = SignalUtils.generateOrderId(data[i].timestamp, this.settings.symbolName);
                this.signals.push({
                    type: 'Short',
                    timestamp: data[i].timestamp,
                    price: data[i].close,
                    tp: data[i].tp,
                    sl: data[i].sl,
                    orderId: data[i].clientOrderId,
                    symbol: this.settings.symbolName
                });
            }
        }

        // Store timestamps and symbol
        this.signalTimestamp = Date.now();
        this.chartTimestamp = Date.now();
        this.signalSymbol = this.settings.symbolName;

        this.updateStatus('تحلیل با موفقیت انجام شد', 'success');
        this.populateTable();
        this.showSignalDetails();
        this.updateStatistics();
        this.renderChart();
        this.updateSignalMeta();
        this.updateSignalStatsSymbol();
        this.updateChartMeta();
        this.savePersistedData();
        UIUtils.setLoading(false, 'loading-indicator');
    }

    renderChart() {
        if (this.marketData.length === 0) return;
        
        // Prepare candlestick data
        const candlestickData = this.marketData.map(c => [c.open, c.close, c.low, c.high]);
        const timestamps = this.marketData.map(c => c.timestamp.getTime());
        
        // Prepare signal markers
        const longSignals = [];
        const shortSignals = [];
        
        this.marketData.forEach((c, idx) => {
            if (c.signal === 'Long') {
                longSignals.push([idx, c.low * 0.999]);
            } else if (c.signal === 'Short') {
                shortSignals.push([idx, c.high * 1.001]);
            }
        });
        
        // Prepare CLOSE position markers from history data
        const closePositions = [];
        if (this.historyData && this.historyData.length > 0) {
            const closeEntries = this.historyData.filter(pos => 
                pos.side && pos.side.includes('CLOSE')
            );
            
            closeEntries.forEach(closePos => {
                const closeTime = closePos.time.getTime();
                let closestIdx = -1;
                let minDiff = Infinity;
                
                this.marketData.forEach((candle, idx) => {
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
                data: this.marketData.map(d => d.timestamp.toLocaleString('fa-IR', { 
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
        
        this.chart.setOption(option, true);
    }

    populateTable() {
        const tbody = document.getElementById('data-table-body');
        tbody.innerHTML = '';
        
        this.marketData.forEach(candle => {
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

    populateHistoryTable() {
        const tbody = document.getElementById('history-table-body');
        tbody.innerHTML = '';
        
        this.historyData.forEach(item => {
            const row = document.createElement('tr');
            row.className = 'border-b border-gray-700 hover:bg-gray-700';
            const pnlClass = item.realizedPnl > 0 ? 'text-green-400' : 
                            item.realizedPnl < 0 ? 'text-red-400' : '';
            
            row.innerHTML = `
                <td class="px-4 py-3">${item.time.toLocaleString('fa-IR')}</td>
                <td class="px-4 py-3">${item.symbol}</td>
                <td class="px-4 py-3">${item.price.toFixed(4)}</td>
                <td class="px-4 py-3">${item.qty.toFixed(2)}</td>
                <td class="px-4 py-3">${item.commission.toFixed(4)}</td>
                <td class="px-4 py-3">${item.side}</td>
                <td class="px-4 py-3 ${pnlClass}">${item.realizedPnl.toFixed(4)}</td>
            `;
            tbody.appendChild(row);
        });
    }

    filterHistoryTable(searchTerm) {
        const rows = document.querySelectorAll('#history-table-body tr');
        rows.forEach(row => {
            const text = row.textContent.toLowerCase();
            row.style.display = text.includes(searchTerm.toLowerCase()) ? '' : 'none';
        });
    }

    filterBySide(side) {
        const rows = document.querySelectorAll('#history-table-body tr');
        rows.forEach(row => {
            if (side === '') {
                row.style.display = '';
            } else {
                const sideCell = row.cells[5];
                if (sideCell) {
                    const cellText = sideCell.textContent.trim();
                    row.style.display = cellText.includes(side) ? '' : 'none';
                }
            }
        });
    }

    calculateSignalStatus(signal) {
        const openPositions = this.historyData.filter(pos => 
            pos.side && pos.side.includes('OPEN')
        );
        
        if (openPositions.length === 0) {
            const isLatest = this.signals.indexOf(signal) === this.signals.length - 1;
            return {
                text: isLatest ? 'در انتظار' : 'باز نشده',
                color: isLatest ? 'text-yellow-400' : 'text-gray-400'
            };
        }
        
        // Filter by same direction as signal: BUY_OPEN → Long, SELL_OPEN → Short
        const signalDirection = signal.type === 'Long' ? 'BUY' : 'SELL';
        const sameDirectionPositions = openPositions.filter(pos =>
            pos.side && pos.side.includes(signalDirection)
        );
        
        if (sameDirectionPositions.length === 0) {
            const isLatest = this.signals.indexOf(signal) === this.signals.length - 1;
            return {
                text: isLatest ? 'در انتظار' : 'باز نشده',
                color: isLatest ? 'text-yellow-400' : 'text-gray-400'
            };
        }
        
        const currentIndex = this.signals.indexOf(signal);
        const nextSignal = currentIndex < this.signals.length - 1 ? this.signals[currentIndex + 1] : null;
        
        const currentTime = signal.timestamp.getTime();
        const nextTime = nextSignal ? nextSignal.timestamp.getTime() : Infinity;
        
        // Match: same-direction OPEN position in time range [T_i, T_{i+1})
        const matchingPositions = sameDirectionPositions.filter(pos => {
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

    showSignalDetails() {
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
            
            const symbolFull = `${this.signalSymbol || this.settings.symbolName}-SWAP-USDT`;
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

    updateStatistics() {
        const totalCandles = this.marketData.length;
        const longSignals = this.signals.filter(s => s.type === 'Long').length;
        const shortSignals = this.signals.filter(s => s.type === 'Short').length;
        const lastPrice = totalCandles > 0 ? this.marketData[totalCandles - 1].close : 0;
        
        document.getElementById('total-candles').textContent = totalCandles;
        document.getElementById('long-signals').textContent = longSignals;
        document.getElementById('short-signals').textContent = shortSignals;
        document.getElementById('last-price').textContent = lastPrice ? lastPrice.toFixed(4) : '-';
    }

    filterTable(searchTerm) {
        const rows = document.querySelectorAll('#data-table-body tr');
        rows.forEach(row => {
            const text = row.textContent.toLowerCase();
            row.style.display = text.includes(searchTerm.toLowerCase()) ? '' : 'none';
        });
    }

    filterBySignal(signalType) {
        const rows = document.querySelectorAll('#data-table-body tr');
        rows.forEach(row => {
            const signalCell = row.cells[8];
            if (signalCell) {
                const cellText = signalCell.textContent.trim();
                if (signalType === '') {
                    row.style.display = '';
                } else if (signalType === 'signals') {
                    row.style.display = (cellText === 'Long' || cellText === 'Short') ? '' : 'none';
                } else if (signalType === 'none') {
                    row.style.display = cellText === '-' ? '' : 'none';
                } else {
                    row.style.display = cellText === signalType ? '' : 'none';
                }
            }
        });
    }

    exportMarketData() {
        if (this.marketData.length === 0) {
            this.updateStatus('داده‌ای برای خروجی وجود ندارد', 'error');
            return;
        }
        
        const data = this.marketData.map(candle => ({
            timestamp: candle.timestamp.toISOString(),
            open: candle.open.toFixed(4),
            close: candle.close.toFixed(4),
            high: candle.high.toFixed(4),
            low: candle.low.toFixed(4),
            amount: candle.amount.toFixed(2),
            value: candle.value ? candle.value.toFixed(2) : '',
            rsi: candle.rsi ? candle.rsi.toFixed(2) : '',
            atr: candle.atr ? candle.atr.toFixed(4) : '',
            signal: candle.signal || '',
            sl: candle.sl ? candle.sl.toFixed(4) : '',
            tp: candle.tp ? candle.tp.toFixed(4) : '',
            clientOrderId: candle.clientOrderId || ''
        }));
        
        UIUtils.exportToCSV(data, `${this.settings.symbolName}_market_data_${new Date().toISOString().split('T')[0]}.csv`);
        this.updateStatus('داده‌ها با موفقیت خروجی گرفته شدند', 'success');
    }

    exportHistoryData() {
        if (this.historyData.length === 0) {
            this.updateStatus('داده‌ای برای خروجی وجود ندارد', 'error');
            return;
        }
        
        const data = this.historyData.map(item => ({
            time: item.time.toISOString(),
            symbol: item.symbol,
            price: item.price.toFixed(4),
            qty: item.qty.toFixed(2),
            commission: item.commission.toFixed(4),
            side: item.side,
            realizedPnl: item.realizedPnl.toFixed(4)
        }));
        
        UIUtils.exportToCSV(data, `${this.settings.symbolName}_history_${new Date().toISOString().split('T')[0]}.csv`);
        this.updateStatus('داده‌ها با موفقیت خروجی گرفته شدند', 'success');
    }

    setLoading(loading) {
        UIUtils.setLoading(loading, 'loading-indicator');
    }

    updateStatus(message, type) {
        const indicator = document.getElementById('status-indicator');
        const color = type === 'success' ? 'text-green-400' : 
                     type === 'error' ? 'text-red-400' : 
                     type === 'loading' ? 'text-blue-400' : 'text-gray-400';
        const icon = type === 'success' ? 'fa-check-circle' : 
                    type === 'error' ? 'fa-exclamation-circle' : 
                    type === 'loading' ? 'fa-spinner fa-spin' : 'fa-circle';
        
        indicator.innerHTML = `
            <i class="fas ${icon} ${color} ml-1"></i>
            ${message}
        `;
    }
}

// Initialize
let analyzer;
console.log('✓ market-signal-analyzer.js loaded');
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOMContentLoaded - Initializing MarketSignalAnalyzer...');
    analyzer = new MarketSignalAnalyzer();
    console.log('✓ MarketSignalAnalyzer initialized');
    
    window.addEventListener('resize', () => {
        if (analyzer.chart) {
            VisualizationUtils.resizeChart(analyzer.chart);
        }
    });
});
