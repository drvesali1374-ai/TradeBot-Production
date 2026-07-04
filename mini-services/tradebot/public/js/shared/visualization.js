/**
 * Visualization Utils - Shared Rendering Functions
 * توابع مشترک برای رسم نمودارات و جداول
 */

class VisualizationUtils {
    /**
     * Initialize ECharts instance
     * @param {String|Element} container - DOM element or selector
     * @returns {Object} ECharts instance
     */
    static initChart(container) {
        const dom = typeof container === 'string' ? document.querySelector(container) : container;
        if (!dom) return null;
        return echarts.init(dom);
    }

    /**
     * Render candlestick chart
     * @param {Object} chart - ECharts instance
     * @param {Array} data - Candle data array
     * @param {Object} options - Additional chart options
     */
    static renderCandlestickChart(chart, data, options = {}) {
        if (!chart || !data || data.length === 0) return;

        const candleData = data.map(candle => {
            if (Array.isArray(candle)) {
                // Raw Toobit format: [timestamp, open, high, low, close, ...]
                return [candle[1], candle[4], candle[1], candle[4]]; // open, close, low, high
            } else {
                // Object format
                return [candle.open, candle.close, candle.low, candle.high];
            }
        });

        const timeLabels = data.map(candle => {
            const timestamp = Array.isArray(candle) ? candle[0] : candle.timestamp;
            const date = new Date(timestamp);
            return date.toLocaleString('fa-IR', { 
                month: '2-digit', 
                day: '2-digit', 
                hour: '2-digit', 
                minute: '2-digit' 
            });
        });

        const chartOption = {
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross' },
                backgroundColor: 'rgba(50, 50, 50, 0.9)',
                textStyle: { color: '#fff' }
            },
            grid: {
                left: '10%',
                right: '10%',
                bottom: '15%',
                top: '10%'
            },
            xAxis: {
                type: 'category',
                data: timeLabels,
                axisLine: { lineStyle: { color: '#8392A5' } },
                axisLabel: { color: '#9ca3af', fontSize: 10 }
            },
            yAxis: {
                type: 'value',
                scale: true,
                axisLine: { lineStyle: { color: '#8392A5' } },
                axisLabel: { color: '#9ca3af' },
                splitLine: { lineStyle: { color: '#374151' } }
            },
            dataZoom: [
                { type: 'inside', start: 70, end: 100 },
                { show: true, type: 'slider', bottom: '5%', start: 70, end: 100 }
            ],
            series: [
                {
                    name: 'قیمت',
                    type: 'candlestick',
                    data: candleData,
                    itemStyle: {
                        color: '#10b981',
                        color0: '#ef4444',
                        borderColor: '#10b981',
                        borderColor0: '#ef4444'
                    }
                }
            ],
            ...options
        };

        chart.setOption(chartOption, true);
    }

    /**
     * Render signal details cards
     * @param {String|Element} container - Container element
     * @param {Array} signals - Array of signal objects
     */
    static renderSignalCards(container, signals) {
        const dom = typeof container === 'string' ? document.querySelector(container) : container;
        if (!dom) return;

        dom.innerHTML = '';

        if (!signals || signals.length === 0) {
            dom.innerHTML = `
                <div class="text-center text-gray-400 py-8">
                    <i class="fas fa-chart-line text-4xl mb-4"></i>
                    <div>سیگنالی برای نمایش وجود ندارد</div>
                </div>
            `;
            return;
        }

        signals.forEach(signal => {
            const borderColor = signal.type === 'Long' || signal.type === 'long' 
                ? 'border-green-500' 
                : 'border-red-500';
            
            const typeColor = signal.type === 'Long' || signal.type === 'long'
                ? 'text-green-400'
                : 'text-red-400';

            const signalCard = document.createElement('div');
            signalCard.className = `glass-effect rounded-lg p-4 border-r-4 ${borderColor}`;

            signalCard.innerHTML = `
                <div class="grid grid-cols-2 gap-4 text-sm">
                    <div class="space-y-2">
                        <div>
                            <span class="text-lg font-bold ${typeColor}">
                                ${signal.type === 'Long' || signal.type === 'long' ? 'Long' : 'Short'}
                            </span>
                        </div>
                        <div>
                            <span class="text-gray-400">قیمت:</span>
                            <span class="ml-2">${SignalUtils.formatNumber(signal.price || signal.entryPrice || 0)}</span>
                        </div>
                        <div>
                            <span class="text-gray-400">حد سود:</span>
                            <span class="text-green-400 ml-2">${SignalUtils.formatNumber(signal.tp || 0)}</span>
                        </div>
                    </div>
                    <div class="space-y-2">
                        <div>
                            <span class="text-gray-400">زمان:</span>
                            <span class="text-xs ml-2">${SignalUtils.formatDate(signal.timestamp || new Date())}</span>
                        </div>
                        <div>
                            <span class="text-gray-400">حد ضرر:</span>
                            <span class="text-red-400 ml-2">${SignalUtils.formatNumber(signal.sl || 0)}</span>
                        </div>
                        <div>
                            <span class="text-gray-400">RSI:</span>
                            <span class="ml-2">${signal.rsi ? SignalUtils.formatNumber(signal.rsi, 2) : '-'}</span>
                        </div>
                    </div>
                </div>
            `;

            dom.appendChild(signalCard);
        });
    }

    /**
     * Populate market data table
     * @param {String|Element} container - Table body element
     * @param {Array} data - Candle data array
     */
    static populateMarketDataTable(container, data) {
        const dom = typeof container === 'string' ? document.querySelector(container) : container;
        if (!dom) return;

        dom.innerHTML = '';

        if (!data || data.length === 0) {
            dom.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-gray-400">داده‌ای برای نمایش وجود ندارد</td></tr>';
            return;
        }

        data.forEach(candle => {
            const timestamp = Array.isArray(candle) ? candle[0] : candle.timestamp;
            const open = Array.isArray(candle) ? candle[1] : candle.open;
            const high = Array.isArray(candle) ? candle[2] : candle.high;
            const low = Array.isArray(candle) ? candle[3] : candle.low;
            const close = Array.isArray(candle) ? candle[4] : candle.close;
            const amount = Array.isArray(candle) ? candle[5] : candle.amount;
            const rsi = candle.rsi ? SignalUtils.formatNumber(candle.rsi, 2) : '-';
            const atr = candle.atr ? SignalUtils.formatNumber(candle.atr, 4) : '-';

            const row = document.createElement('tr');
            row.className = 'border-b border-gray-700 hover:bg-gray-700';
            
            row.innerHTML = `
                <td class="px-4 py-3 text-xs">${SignalUtils.formatDate(timestamp)}</td>
                <td class="px-4 py-3">${SignalUtils.formatNumber(open)}</td>
                <td class="px-4 py-3">${SignalUtils.formatNumber(close)}</td>
                <td class="px-4 py-3">${SignalUtils.formatNumber(high)}</td>
                <td class="px-4 py-3">${SignalUtils.formatNumber(low)}</td>
                <td class="px-4 py-3">${SignalUtils.formatNumber(amount)}</td>
                <td class="px-4 py-3">${rsi}</td>
                <td class="px-4 py-3">${atr}</td>
            `;

            dom.appendChild(row);
        });
    }

    /**
     * Populate position history table
     * @param {String|Element} container - Table body element
     * @param {Array} data - History data array
     */
    static populateHistoryTable(container, data) {
        const dom = typeof container === 'string' ? document.querySelector(container) : container;
        if (!dom) return;

        dom.innerHTML = '';

        if (!data || data.length === 0) {
            dom.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-gray-400">داده‌ای برای نمایش وجود ندارد</td></tr>';
            return;
        }

        data.forEach(item => {
            const row = document.createElement('tr');
            row.className = 'border-b border-gray-700 hover:bg-gray-700';
            
            const pnlClass = item.realizedPnl > 0 ? 'text-green-400' : 
                            item.realizedPnl < 0 ? 'text-red-400' : '';

            row.innerHTML = `
                <td class="px-4 py-3 text-xs">${SignalUtils.formatDate(item.time)}</td>
                <td class="px-4 py-3">${item.symbol || '-'}</td>
                <td class="px-4 py-3">${SignalUtils.formatNumber(item.price || 0)}</td>
                <td class="px-4 py-3">${SignalUtils.formatNumber(item.qty || 0)}</td>
                <td class="px-4 py-3">${SignalUtils.formatNumber(item.commission || 0, 6)}</td>
                <td class="px-4 py-3">${item.side || '-'}</td>
                <td class="px-4 py-3 ${pnlClass}">${SignalUtils.formatNumber(item.realizedPnl || 0)}</td>
            `;

            dom.appendChild(row);
        });
    }

    /**
     * Resize chart to fit container
     * @param {Object} chart - ECharts instance
     */
    static resizeChart(chart) {
        if (chart) {
            chart.resize();
        }
    }

    /**
     * Clear chart
     * @param {Object} chart - ECharts instance
     */
    static clearChart(chart) {
        if (chart) {
            chart.clear();
        }
    }
}

// Make available globally
window.VisualizationUtils = VisualizationUtils;
console.log('✓ VisualizationUtils loaded and available globally');

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VisualizationUtils;
}
