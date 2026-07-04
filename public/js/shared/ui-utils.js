/**
 * UI Utils - Shared UI and UX Functions
 * توابع مشترک برای رابط کاربری
 */

class UIUtils {
    /**
     * Show notification
     * @param {String} message - Notification message
     * @param {String} type - Type: 'success', 'error', 'warning', 'info'
     * @param {Number} duration - Duration in milliseconds
     */
    static showNotification(message, type = 'info', duration = 3000) {
        const notification = document.createElement('div');
        
        const bgColor = type === 'success' ? 'bg-green-900/30 border border-green-500' :
                       type === 'error' ? 'bg-red-900/30 border border-red-500' :
                       type === 'warning' ? 'bg-yellow-900/30 border border-yellow-500' :
                       'bg-blue-900/30 border border-blue-500';
        
        const textColor = type === 'success' ? 'text-green-400' : 
                         type === 'error' ? 'text-red-400' : 
                         type === 'warning' ? 'text-yellow-400' : 'text-blue-400';
        
        const icon = type === 'success' ? 'fa-check-circle' : 
                    type === 'error' ? 'fa-exclamation-circle' : 
                    type === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle';
        
        notification.className = `fixed top-20 right-4 z-50 px-6 py-3 rounded-lg backdrop-filter backdrop-blur-lg ${bgColor} ${textColor} transition-all duration-300`;
        notification.style.transform = 'translateX(100%)';
        notification.style.opacity = '0';
        
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

    /**
     * Log message to UI
     * @param {String} message - Log message
     * @param {String} type - Type: 'info', 'success', 'warning', 'error'
     * @param {String} containerId - ID of log container
     */
    static log(message, type = 'info', containerId = 'cycle-log') {
        const logDiv = document.getElementById(containerId);
        if (!logDiv) return;

        const timestamp = new Date().toLocaleString('fa-IR');
        
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
            ${message}
        `;

        // Clear placeholder if exists
        if (logDiv.children.length === 1 && logDiv.children[0].textContent.includes('گزارشی موجود نیست')) {
            logDiv.innerHTML = '';
        }

        logDiv.insertBefore(logEntry, logDiv.firstChild);

        // Keep only last 100 entries in UI
        while (logDiv.children.length > 100) {
            logDiv.removeChild(logDiv.lastChild);
        }
    }

    /**
     * Clear log
     * @param {String} containerId - ID of log container
     */
    static clearLog(containerId = 'cycle-log') {
        const logDiv = document.getElementById(containerId);
        if (logDiv) {
            logDiv.innerHTML = '<div class="text-gray-400 text-center py-4">گزارشی موجود نیست</div>';
        }
    }

    /**
     * Filter table rows by search term
     * @param {String} searchTerm - Search term
     * @param {String} tableBodyId - ID of table body
     */
    static filterTable(searchTerm, tableBodyId) {
        const rows = document.querySelectorAll(`#${tableBodyId} tr`);
        rows.forEach(row => {
            const text = row.textContent.toLowerCase();
            row.style.display = text.includes(searchTerm.toLowerCase()) ? '' : 'none';
        });
    }

    /**
     * Filter table by specific column value
     * @param {String} filterValue - Filter value
     * @param {Number} columnIndex - Column index
     * @param {String} tableBodyId - ID of table body
     */
    static filterTableByColumn(filterValue, columnIndex, tableBodyId) {
        const rows = document.querySelectorAll(`#${tableBodyId} tr`);
        rows.forEach(row => {
            const cell = row.cells[columnIndex];
            if (cell) {
                const cellText = cell.textContent.trim().toLowerCase();
                row.style.display = cellText.includes(filterValue.toLowerCase()) ? '' : 'none';
            }
        });
    }

    /**
     * Export data to CSV
     * @param {Array} data - Array of data objects
     * @param {String} filename - Output filename
     */
    static exportToCSV(data, filename = 'export.csv') {
        if (!data || data.length === 0) {
            UIUtils.showNotification('داده‌ای برای خروجی وجود ندارد', 'error');
            return;
        }
        
        const headers = Object.keys(data[0]).join(',');
        const csvContent = [
            headers,
            ...data.map(row => Object.values(row).map(val => {
                // Escape values containing commas or quotes
                if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
                    return `"${val.replace(/"/g, '""')}"`;
                }
                return val;
            }).join(','))
        ].join('\n');
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        
        URL.revokeObjectURL(link.href);
        UIUtils.showNotification('داده‌ها با موفقیت خروجی گرفته شدند', 'success');
    }

    /**
     * Set loading state
     * @param {Boolean} loading - Loading state
     * @param {String} elementId - ID of loading indicator
     */
    static setLoading(loading, elementId = 'loading-indicator') {
        const element = document.getElementById(elementId);
        if (element) {
            if (loading) {
                element.classList.remove('hidden');
            } else {
                element.classList.add('hidden');
            }
        }
    }

    /**
     * Update status indicator
     * @param {String} message - Status message
     * @param {String} type - Type: 'success', 'error', 'loading', 'info'
     * @param {String} elementId - ID of status indicator
     */
    static updateStatus(message, type = 'info', elementId = 'status-indicator') {
        const element = document.getElementById(elementId);
        if (!element) return;

        const color = type === 'success' ? 'text-green-400' : 
                     type === 'error' ? 'text-red-400' : 
                     type === 'loading' ? 'text-blue-400' : 'text-gray-400';
        
        const icon = type === 'success' ? 'fa-check-circle' : 
                    type === 'error' ? 'fa-exclamation-circle' : 
                    type === 'loading' ? 'fa-spinner fa-spin' : 'fa-circle';
        
        element.innerHTML = `
            <i class="fas ${icon} ${color} ml-1"></i>
            ${message}
        `;
    }

    /**
     * Debounce function
     * @param {Function} func - Function to debounce
     * @param {Number} wait - Wait time in milliseconds
     * @returns {Function} Debounced function
     */
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

    /**
     * Throttle function
     * @param {Function} func - Function to throttle
     * @param {Number} limit - Limit in milliseconds
     * @returns {Function} Throttled function
     */
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

    /**
     * Show/hide element
     * @param {String} elementId - ID of element
     * @param {Boolean} show - Show or hide
     */
    static toggleElement(elementId, show) {
        const element = document.getElementById(elementId);
        if (element) {
            if (show) {
                element.classList.remove('hidden');
            } else {
                element.classList.add('hidden');
            }
        }
    }

    /**
     * Toggle CSS class
     * @param {String} elementId - ID of element
     * @param {String} className - CSS class name
     */
    static toggleClass(elementId, className) {
        const element = document.getElementById(elementId);
        if (element) {
            element.classList.toggle(className);
        }
    }

    /**
     * Enable/disable button
     * @param {String} buttonId - ID of button
     * @param {Boolean} enabled - Enable or disable
     */
    static setButtonEnabled(buttonId, enabled) {
        const button = document.getElementById(buttonId);
        if (button) {
            button.disabled = !enabled;
            if (enabled) {
                button.classList.remove('opacity-50', 'cursor-not-allowed');
            } else {
                button.classList.add('opacity-50', 'cursor-not-allowed');
            }
        }
    }
}

// Make available globally
window.UIUtils = UIUtils;
console.log('✓ UIUtils loaded and available globally');

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = UIUtils;
}
