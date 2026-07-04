/**
 * Market Signal Utils - Shared Mathematical Calculations
 * محاسبات مشترک برای تحلیل سیگنال بازار
 */

class SignalUtils {
    /**
     * Calculate RSI (Relative Strength Index)
     * @param {Array} data - Array of price objects with 'close' property
     * @param {Number} period - RSI period (default: 14)
     * @returns {Array} RSI values
     */
    static calculateRSI(data, period = 14) {
        let avgGain = 0, avgLoss = 0;
        const rsiValues = [];
        
        // Ensure we have enough data
        if (data.length < period) {
            return new Array(data.length).fill(null);
        }
        
        for (let i = 1; i < data.length; i++) {
            const change = data[i].close - data[i - 1].close;
            const gain = Math.max(change, 0);
            const loss = Math.max(-change, 0);
            
            if (i <= period) {
                avgGain += gain;
                avgLoss += loss;
                if (i === period) {
                    avgGain /= period;
                    avgLoss /= period;
                }
                rsiValues.push(null);
            } else {
                avgGain = (avgGain * (period - 1) + gain) / period;
                avgLoss = (avgLoss * (period - 1) + loss) / period;
                const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
                rsiValues.push(100 - (100 / (1 + rs)));
            }
        }
        
        return rsiValues;
    }

    /**
     * Calculate ATR (Average True Range)
     * @param {Array} data - Array of candle objects
     * @param {Number} period - ATR period (default: 14)
     * @returns {Array} ATR values
     */
    static calculateATR(data, period = 14) {
        const atrValues = [];
        
        // Calculate True Range
        const trueRanges = data.map((candle, i) => {
            if (i === 0) return candle.high - candle.low;
            
            const prevClose = data[i - 1].close;
            return Math.max(
                candle.high - candle.low,
                Math.abs(candle.high - prevClose),
                Math.abs(candle.low - prevClose)
            );
        });
        
        // Calculate ATR
        atrValues[0] = trueRanges[0];
        for (let i = 1; i < data.length; i++) {
            atrValues[i] = ((period - 1) * atrValues[i - 1] + trueRanges[i]) / period;
        }
        
        return atrValues;
    }

    /**
     * Calculate SMA (Simple Moving Average)
     * @param {Array} data - Array of price objects or numbers
     * @param {Number} period - SMA period
     * @returns {Array} SMA values
     */
    static calculateSMA(data, period) {
        const smaValues = [];
        
        for (let i = 0; i < data.length; i++) {
            if (i < period - 1) {
                smaValues.push(null);
            } else {
                let sum = 0;
                for (let j = i - period + 1; j <= i; j++) {
                    const val = typeof data[j] === 'object' ? data[j].close : data[j];
                    sum += val;
                }
                smaValues.push(sum / period);
            }
        }
        
        return smaValues;
    }

    /**
     * Calculate TP (Take Profit) and SL (Stop Loss) levels
     * @param {Object} signal - Signal object with price and type
     * @param {Number} atr - ATR value for risk calculation
     * @param {Number} atrMultiplier - ATR multiplier for TP/SL (default: 2)
     * @returns {Object} Object with tp and sl properties
     */
    static calculateTPSL(signal, atr, atrMultiplier = 2) {
        const riskDistance = atr * atrMultiplier;
        
        if (signal.type === 'Long' || signal.type === 'long') {
            return {
                tp: signal.price + riskDistance,
                sl: signal.price - (riskDistance / 2)
            };
        } else {
            return {
                tp: signal.price - riskDistance,
                sl: signal.price + (riskDistance / 2)
            };
        }
    }

    /**
     * Calculate Signal Status
     * @param {Number} currentPrice - Current price
     * @param {Object} signal - Signal object with tp, sl, type
     * @returns {Object} Status object with text and color
     */
    static calculateSignalStatus(currentPrice, signal) {
        if (!signal) {
            return { text: 'بدون سیگنال', color: 'text-gray-400' };
        }

        const isLong = signal.type === 'Long' || signal.type === 'long';
        const isProfitable = isLong 
            ? currentPrice > signal.tp 
            : currentPrice < signal.tp;
        
        if (isProfitable) {
            return { text: 'سود (TP)', color: 'text-green-400' };
        }
        
        const isLoss = isLong 
            ? currentPrice < signal.sl 
            : currentPrice > signal.sl;
        
        if (isLoss) {
            return { text: 'زیان (SL)', color: 'text-red-400' };
        }
        
        return { text: 'فعال', color: 'text-yellow-400' };
    }

    /**
     * Validate Settings
     * @param {Object} settings - Settings object
     * @returns {Boolean} True if valid
     */
    static validateSettings(settings) {
        const required = [
            'symbolName', 'interval', 'limit', 'lookback', 
            'volMult', 'avgVolPeriod', 'rsiThreshold', 'rsiPeriod', 'atrPeriod'
        ];
        
        const missing = required.filter(key => !settings[key]);
        
        if (missing.length > 0) {
            throw new Error(`تنظیمات ناقص است. مقادیر زیر مورد نیاز است: ${missing.join(', ')}`);
        }
        
        if (settings.limit < 10 || settings.limit > 2000) {
            throw new Error('مقدار limit باید بین 10 تا 2000 باشد');
        }
        
        if (settings.rsiThreshold < 0 || settings.rsiThreshold > 100) {
            throw new Error('مقدار rsiThreshold باید بین 0 تا 100 باشد');
        }
        
        return true;
    }

    /**
     * Generate Order ID from timestamp and symbol
     * @param {Number} timestamp - Timestamp in milliseconds
     * @param {String} symbol - Symbol name
     * @returns {String} Order ID
     */
    static generateOrderId(timestamp, symbol) {
        const dt = new Date(timestamp);
        const year = dt.getFullYear().toString().padStart(4, '0');
        const month = (dt.getMonth() + 1).toString().padStart(2, '0');
        const day = dt.getDate().toString().padStart(2, '0');
        const hour = dt.getHours().toString().padStart(2, '0');
        const minute = dt.getMinutes().toString().padStart(2, '0');
        const second = dt.getSeconds().toString().padStart(2, '0');
        return `${symbol}_${year}${month}${day}_${hour}${minute}${second}`;
    }

    /**
     * Format number to fixed decimals
     * @param {Number} num - Number to format
     * @param {Number} decimals - Decimal places
     * @returns {String} Formatted number
     */
    static formatNumber(num, decimals = 4) {
        return parseFloat(num).toFixed(decimals);
    }

    /**
     * Format price with localization
     * @param {Number} num - Price to format
     * @param {Number} decimals - Decimal places
     * @returns {String} Formatted price
     */
    static formatPrice(num, decimals = 4) {
        return parseFloat(num).toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }

    /**
     * Format date to Persian locale
     * @param {Date|Number} date - Date to format
     * @returns {String} Formatted date
     */
    static formatDate(date) {
        return new Date(date).toLocaleString('fa-IR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }
}

// Make available globally
window.SignalUtils = SignalUtils;
console.log('✓ SignalUtils loaded and available globally');

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SignalUtils;
}
