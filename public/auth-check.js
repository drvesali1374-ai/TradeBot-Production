/**
 * Auth Check Script
 * =================
 *
 * ✓ مورد ۵: بررسی احراز هویت در همه صفحات
 *
 * این اسکریپت در ابتدای همه صفحات HTML (به جز login.html) اجرا می‌شود.
 * اگر کاربر احراز هویت نکرده باشد، به صفحه login.html redirect می‌شود.
 *
 * نحوه استفاده:
 *   <script src="/auth-check.js"></script>
 *
 *   یا در ابتدای صفحه:
 *   <script src="/auth-check.js"></script>
 */

(function() {
    // Skip auth check on login page itself
    if (window.location.pathname === '/login.html') return;

    // Check auth status
    fetch('/api/auth/verify', { credentials: 'same-origin' })
        .then(response => {
            if (!response.ok) {
                // Not authenticated — redirect to login
                window.location.href = '/login.html';
            }
        })
        .catch(() => {
            // Network error — redirect to login (safer)
            window.location.href = '/login.html';
        });
})();
