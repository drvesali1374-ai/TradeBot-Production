// Auto-initialize settings on first load
// ✓ Cloudflare-ready: Syncs settings from the permanent database (KV in Cloudflare)
//   instead of relying solely on browser localStorage.
//   localStorage acts as a cache; the database is the source of truth.
(function () {
    const defaultSettings = {
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
        htfConfirmationSource: 'signalCandleClose',
        apiKey: '',
        secretKey: '',
        baseUrl: 'https://api.toobit.com'
    };

    // Initialize localStorage with defaults if nothing exists
    if (!localStorage.getItem('marketSignalSettings')) {
        localStorage.setItem('marketSignalSettings', JSON.stringify(defaultSettings));
        console.log('✓ init-settings: local defaults initialized');
    }

    // ✓ NEW: Sync from permanent database (takes priority over localStorage)
    // This ensures settings saved on one device/browser are available everywhere
    // and are available to server-side operations (cron-triggered run-cycle).
    async function syncSettingsFromDB() {
        try {
            // Try the dedicated settings_apiKeys key first (used by settings.html)
            const apiKeysRes = await fetch('/api/db/automation-state?key=settings_apiKeys');
            if (apiKeysRes.ok) {
                const apiKeysData = await apiKeysRes.json();
                if (apiKeysData.success && apiKeysData.data) {
                    const dbKeys = typeof apiKeysData.data === 'string'
                        ? JSON.parse(apiKeysData.data)
                        : apiKeysData.data;
                    if (dbKeys && (dbKeys.apiKey || dbKeys.secretKey)) {
                        const local = JSON.parse(localStorage.getItem('marketSignalSettings') || '{}');
                        // DB takes priority for API keys
                        if (dbKeys.apiKey) local.apiKey = dbKeys.apiKey;
                        if (dbKeys.secretKey) local.secretKey = dbKeys.secretKey;
                        if (dbKeys.baseUrl) local.baseUrl = dbKeys.baseUrl;
                        localStorage.setItem('marketSignalSettings', JSON.stringify(local));
                        console.log('✓ init-settings: API keys synced from database');
                    }
                }
            }

            // Also try the full marketSignalSettings object from the centralized settings API
            const settingsRes = await fetch('/api/settings?key=marketSignalSettings');
            if (settingsRes.ok) {
                const settingsData = await settingsRes.json();
                if (settingsData.success && settingsData.data) {
                    const dbSettings = typeof settingsData.data === 'string'
                        ? JSON.parse(settingsData.data)
                        : settingsData.data;
                    if (dbSettings && typeof dbSettings === 'object') {
                        // Merge: DB values take priority but preserve any local-only keys
                        const local = JSON.parse(localStorage.getItem('marketSignalSettings') || '{}');
                        const merged = { ...defaultSettings, ...local, ...dbSettings };
                        localStorage.setItem('marketSignalSettings', JSON.stringify(merged));
                        console.log('✓ init-settings: full settings synced from database');
                    }
                }
            }
        } catch (e) {
            // Network or server error — gracefully fall back to localStorage
            console.warn('init-settings: could not sync from DB (using localStorage)', e);
        }
    }

    // Run sync asynchronously (non-blocking — page loads with localStorage first)
    syncSettingsFromDB();

    // Expose for manual re-sync if needed
    window.syncSettingsFromDB = syncSettingsFromDB;
})();
