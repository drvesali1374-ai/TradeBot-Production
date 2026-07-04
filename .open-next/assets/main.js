// Market Signal Analysis System - Shared JavaScript Functions
// Author: AI Assistant
// Date: 2025

class MarketSignalUtils {
    static formatNumber(num, decimals = 4) {
        return parseFloat(num).toFixed(decimals);
    }
    
    static formatPrice(num, decimals = 4) {
        return parseFloat(num).toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }
    
    static formatDate(date) {
        return new Date(date).toLocaleString('fa-IR', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }
    
    static generateOrderId(timestamp, symbol) {
        const dt = new Date(timestamp);
        const year = dt.getFullYear().toString().padStart(4, '0');
        const month = (dt.getMonth() + 1).toString().padStart(2, '0');
        const day = dt.getDate().toString().padStart(2, '0');
        const hour = dt.getHours().toString().padStart(2, '0');
        const minute = dt.getMinutes().toString().padStart(2, '0');
        const second = dt.getSeconds().toString().padStart(2, '0');
        return `${symbol}_${year}_${month}_${day}_${hour}${minute}${second}`;
    }
    
    static calculateRSI(data, period = 14) {
        let avgGain = 0, avgLoss = 0;
        const rsiValues = [];
        
        // Ensure we have enough data
        if (data.length < period) {
            // If not enough data, return array of nulls
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
    
    static calculateSMA(data, period) {
        const smaValues = [];
        
        for (let i = 0; i < data.length; i++) {
            if (i < period - 1) {
                smaValues.push(null);
            } else {
                const sum = data.slice(i - period + 1, i + 1).reduce((acc, val) => acc + val, 0);
                smaValues.push(sum / period);
            }
        }
        
        return smaValues;
    }
    
    static showNotification(message, type = 'info', duration = 3000) {
        const notification = document.createElement('div');
        notification.className = `fixed top-20 right-4 z-50 px-6 py-3 rounded-lg glass-effect ${
            type === 'success' ? 'text-green-400' : 
            type === 'error' ? 'text-red-400' : 
            type === 'warning' ? 'text-yellow-400' : 'text-blue-400'
        }`;
        
        const icon = type === 'success' ? 'fa-check-circle' : 
                    type === 'error' ? 'fa-exclamation-circle' : 
                    type === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle';
        
        notification.innerHTML = `
            <i class="fas ${icon} mr-2"></i>
            ${message}
        `;
        
        document.body.appendChild(notification);
        
        // Animate in
        setTimeout(() => {
            notification.style.transform = 'translateX(0)';
            notification.style.opacity = '1';
        }, 10);
        
        // Remove after duration
        setTimeout(() => {
            notification.style.transform = 'translateX(100%)';
            notification.style.opacity = '0';
            setTimeout(() => notification.remove(), 300);
        }, duration);
    }
    
    static validateSettings(settings) {
        const required = [
            'symbolName', 'interval', 'limit', 'lookback', 
            'volMult', 'avgVolPeriod', 'rsiThreshold', 'rsiPeriod', 'atrPeriod'
        ];
        
        const missing = required.filter(key => !settings[key]);
        
        if (missing.length > 0) {
            throw new Error(`تنظیمات ناقص است. مقادیر زیر مورد نیاز است: ${missing.join(', ')}`);
        }
        
        // Validate ranges
        if (settings.limit < 10 || settings.limit > 2000) {
            throw new Error('مقدار limit باید بین 10 تا 2000 باشد');
        }
        
        if (settings.rsiThreshold < 0 || settings.rsiThreshold > 100) {
            throw new Error('مقدار rsiThreshold باید بین 0 تا 100 باشد');
        }
        
        return true;
    }
    
    static exportToCSV(data, filename) {
        if (!data || data.length === 0) {
            throw new Error('داده‌ای برای خروجی وجود ندارد');
        }
        
        const headers = Object.keys(data[0]).join(',');
        const csvContent = [
            headers,
            ...data.map(row => Object.values(row).join(','))
        ].join('\n');
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        
        URL.revokeObjectURL(link.href);
    }
    
    static debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
    
    static throttle(func, limit) {
        let inThrottle;
        return function() {
            const args = arguments;
            const context = this;
            if (!inThrottle) {
                func.apply(context, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }
}

// Global utility functions
window.MarketSignalUtils = MarketSignalUtils;
console.log('✓ main.js loaded - MarketSignalUtils available');

// Mobile menu functionality for all pages
document.addEventListener('DOMContentLoaded', function() {
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const mobileMenu = document.getElementById('mobile-menu');
    
    if (mobileMenuBtn && mobileMenu) {
        mobileMenuBtn.addEventListener('click', () => {
            mobileMenu.classList.toggle('translate-x-full');
        });
        
        // Close mobile menu when clicking outside
        document.addEventListener('click', (e) => {
            if (!mobileMenu.contains(e.target) && !mobileMenuBtn.contains(e.target)) {
                mobileMenu.classList.add('translate-x-full');
            }
        });
    }
    
    // Add loading states to buttons
    const buttons = document.querySelectorAll('button');
    buttons.forEach(button => {
        button.addEventListener('click', function() {
            if (!this.disabled) {
                this.style.opacity = '0.7';
                setTimeout(() => {
                    this.style.opacity = '1';
                }, 200);
            }
        });
    });
});

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MarketSignalUtils;
}