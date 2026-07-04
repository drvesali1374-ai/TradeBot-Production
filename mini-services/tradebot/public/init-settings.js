// Auto-initialize settings on first load
(function() {
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
        apiKey: 'gSCY0fKpFRcO7HPD74Lg7gJNcF1DQN10IzjnyVmHovN0r4UWyt4oWkEz5lqvYfW1',
        secretKey: 'kpDy9X2jJSLmG6Gy3S1yHvy3i3cc22ebKIsTD8jeNFACm4LNTg4XSaCh6Sh01GiI',
        baseUrl: 'https://api.toobit.com'
    };
    
    if (!localStorage.getItem('marketSignalSettings')) {
        localStorage.setItem('marketSignalSettings', JSON.stringify(defaultSettings));
        console.log('✓ Settings initialized with default values and API keys');
    } else {
        console.log('✓ init-settings.js loaded - existing settings found');
    }
})();
