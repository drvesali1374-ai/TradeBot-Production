# Task 19 — Work Record

## Agent
Settings Split Sub-agent (general-purpose)

## Task
Phase 2: Split System Settings from Automation Settings.

- `settings.html` should ONLY contain: API keys (apiKey, secretKey, baseUrl), Bale settings (baleToken, baleChatId), test Bale button.
- `automation.html` should contain ALL strategy parameters (interval, limit, lookback, volMult, atrPeriod, rsiPeriod, tp/sl multipliers, fixed tp/sl, htfConfirmationSource).
- `analyzeMarketData()` in automation-manager.js should read strategy params from `this.settings` (automation_settings), NOT from `localStorage.getItem('marketSignalSettings')`.

## Files Modified
- `/home/z/my-project/public/automation.html` — added new "بازار" (Market) section + new "اهداف TP/SL" section; removed Bale notification section.
- `/home/z/my-project/public/js/automation-manager.js` — extended getDefaultSettings, saveSettings, populateSettingsForm, loadSettings, analyzeMarketData to handle the new strategy params; preserved backward compat via `??` fallback chains; Bale DOM elements gone from automation.html so saveSettings/populateSettingsForm now preserve `this.settings.baleToken/baleChatId` (synced from marketSignalSettings by loadSettings).
- `/home/z/my-project/public/settings.html` — removed "تنظیمات پایه", "پارامترهای سیگنال", "اندیکاتورهای تکنیکال", "مدیریت ریسک" sections; KEPT API Credentials section; added new Bale notification section with bale-token, bale-chat-id, test-bale-btn; trimmed getDefaultSettings to only apiKey/secretKey/baseUrl/baleToken/baleChatId; removed the obsolete symbol-name auto-uppercase handler; added sendBaleNotification + testBaleNotification methods.
- `/home/z/my-project/worklog.md` — work record appended (Task ID 19).

## Implementation Summary

### 1) automation.html — Settings Modal Restructure
Old layout (6 groups): Risk, Execution, Indicators, Fake Breakout, Bale (اطلاع‌رسانی), Symbol Management.

New layout (7 groups, Bale section removed):
1. مدیریت ریسک (Risk)
2. اجرای معاملات (Execution)
3. **بازار (Market) — NEW**: interval (select), limit, lookback, atr-period, rsi-period, avg-vol-period (3×2 grid)
4. اندیکاتورها (Indicators): htf-confirmation-source, rsi-long/short-threshold, vol-mult-long/short (unchanged)
5. **اهداف TP/SL — NEW**: Long block (tp-long-mult, sl-long-mult, long-fixed-tp, long-fixed-sl), Short block (tp-short-mult, sl-short-mult, short-fixed-tp, short-fixed-sl) — mirrors the old settings.html "مدیریت ریسک" layout but compact (border + h4 instead of separate panels)
6. Fake Breakout (unchanged)
7. مدیریت نمادها (Symbol Management, unchanged)

The Bale (اطلاع‌رسانی) section was deleted entirely — bale-token, bale-chat-id, test-bale-btn now live only on settings.html.

All new input IDs match the camelCase conversion that automation-manager.js uses (e.g. `atr-period` ↔ `atrPeriod`), verified via the regex `/-(a-z)/g`.

### 2) automation-manager.js — getDefaultSettings()
Added new defaults (between legacy fallback block and Bale block):
```js
interval: '1h', limit: 1000, lookback: 50,
atrPeriod: 14, rsiPeriod: 14, avgVolPeriod: 50,
tpLongMult: 20, slLongMult: 6, tpShortMult: 24, slShortMult: 4,
longFixedTp: null, longFixedSl: null, shortFixedTp: null, shortFixedSl: 6,
```
Kept `baleToken: ''` and `baleChatId: ''` (sendBaleNotification still reads from this.settings).

### 3) automation-manager.js — saveSettings()
- Added DOM reads for all 14 new strategy fields following the existing pattern (e.g. `parseInt(...) || 1000`, `parseFloat(...) || 20`).
- For the 4 fixed TP/SL fields: `value === '' ? null : parseFloat(value)` — matches settings.html's existing pattern (empty → null = ATR-based).
- Changed `baleToken` / `baleChatId` reading from `document.getElementById('bale-token').value.trim()` (would throw — element gone from automation.html) → `this.settings.baleToken || ''` (preserve existing value, which loadSettings keeps in sync from marketSignalSettings).
- Extended the existing marketSignalSettings sync block (which previously only saved `htfConfirmationSource`) to also mirror the 14 new strategy params to marketSignalSettings. This keeps the server-side `cycle-engine.ts` (which reads from marketSignalSettings) in sync with the new frontend-canonical source. Backward compat: legacy `volMult`, `rsiThreshold`, `symbolName` keys are preserved in old marketSignalSettings saves — the `??` fallbacks in analyzeMarketData still pick them up.

### 4) automation-manager.js — populateSettingsForm()
- Added populating 14 new strategy fields from `this.settings` with `??` fallbacks (e.g. `this.settings.interval ?? '1h'`).
- For the 4 fixed TP/SL fields: `(value === null || value === undefined) ? '' : value` — empty when null so the input renders the ATR-based placeholder.
- All element reads use `const el = document.getElementById(...); if (el) el.value = ...;` (defensive — also guards if a field is removed in the future).
- Removed the obsolete `document.getElementById('bale-token').value = ...` and `document.getElementById('bale-chat-id').value = ...` lines (those elements no longer exist on automation.html).
- HTF source population unchanged (still read from marketSignalSettings, since that's where it's saved).

### 5) automation-manager.js — loadSettings()
After the existing marketSignalSettings DB sync, added a cross-source sync block:
- Bale: `mss.baleToken` and `mss.baleChatId` always override `this.settings` — settings.html is now the canonical source.
- Strategy params: only migrate from marketSignalSettings if `localStorage.getItem('automation_settings')` is missing — i.e., a one-time migration for legacy users who previously saved strategy params via settings.html. Once the user saves from automation.html, this.settings (automation_settings) becomes canonical and the migration is skipped.

### 6) automation-manager.js — analyzeMarketData()
Replaced the existing `const settings = JSON.parse(localStorage.getItem('marketSignalSettings')) || {};` with the exact pattern specified in the task:
```js
const settings = {
    ...(JSON.parse(localStorage.getItem('marketSignalSettings') || '{}')),  // backward compat
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
```
This means: this.settings (automation_settings) takes priority; marketSignalSettings is the fallback for backward compat. The existing downstream uses of `settings.lookback`, `settings.tpLongMult`, `settings.longFixedTp`, `settings.htfConfirmationSource`, `settings.atrPeriod`, `settings.rsiPeriod`, `settings.avgVolPeriod`, etc. all continue to work unchanged.

### 7) settings.html — Form Restructure
- Removed: "تنظیمات پایه" (symbol-name, interval, limit), "پارامترهای سیگنال" (lookback, vol-mult, avg-vol-period, rsi-threshold), "اندیکاتورهای تکنیکال" (rsi-period, atr-period), "مدیریت ریسک" (tp/sl multipliers, fixed tp/sl).
- KEPT: API Credentials section (api-key, secret-key, base-url) — moved from `lg:col-span-2` to a regular grid cell since the layout is now 2 columns (API + Bale).
- ADDED: "اطلاع‌رسانی بله" (Bale Notification) section with bale-token, bale-chat-id, test-bale-btn + a status message div `#bale-test-message`.
- Trimmed `getDefaultSettings()` to: `apiKey, secretKey, baseUrl, baleToken, baleChatId`.
- Removed the obsolete `symbol-name` auto-uppercase input handler (the element no longer exists).
- Added new methods to SettingsManager:
  - `sendBaleNotification(text)` — same approach as automation-manager.js (no-cors + text/plain, with /api/bale-send fallback).
  - `testBaleNotification()` — sends a Persian test message, shows result in `#bale-test-message`.
- Wired up `test-bale-btn` click handler in `bindEvents`.

The auth section (تغییر نام کاربری و رمز عبور) and footer are UNCHANGED.

## Verification
- `node --check public/js/automation-manager.js` → syntax OK
- Extracted inline JS from settings.html via python regex → `node --check` → syntax OK
- `bun run lint` → 0 errors, 2 pre-existing warnings in database.js (out of scope, unrelated)
- HTML tag balance: automation.html — 7 section open / 7 close, 128 div / 128 div; settings.html — 1 section / 1 section, 35 div / 35 div. All balanced.
- ID verification (python script):
  - All 14 new strategy IDs present in automation.html ✓
  - Bale IDs (bale-token, bale-chat-id, test-bale-btn) — present in settings.html, gone from automation.html ✓
  - All strategy IDs (interval, limit, lookback, atr-period, rsi-period, avg-vol-period, tp-long-mult, sl-long-mult, tp-short-mult, sl-short-mult, long-fixed-tp, long-fixed-sl, short-fixed-tp, short-fixed-sl) — gone from settings.html ✓
  - API keys (api-key, secret-key, base-url) — still in settings.html ✓
- HTTP check: `automation.html: 200`, `settings.html: 200`, `automation-manager.js: 200`
- dev.log: only pre-existing edge-runtime fs-module errors in database.js; no new errors related to my changes. API routes still return 200.

## Notes for Future Agents
- The server-side `cycle-engine.ts` was NOT modified (out of scope per task). It continues to read strategy params from `marketSignalSettings` (DB). The new `saveSettings()` in automation-manager.js mirrors all 14 strategy params + htfConfirmationSource to marketSignalSettings so the backend stays in sync. If the user only edits automation.html and saves, both `automation_settings` and `marketSignalSettings` reflect the new values.
- `sendBaleNotification()` in automation-manager.js still reads from `this.settings.baleToken/baleChatId`. These are kept in sync from `marketSignalSettings` (which settings.html writes to) by the new cross-source sync block in `loadSettings()`. No need to change `sendBaleNotification()` itself.
- The `bindIfExists('test-bale-btn', 'click', ...)` call in automation-manager.js's `bindEvents()` is now a no-op on automation.html (the element is gone) — it silently skips via the `if (el)` guard inside `bindIfExists`. Safe to leave as-is for backward compat (in case any cached HTML still has the button).
- `loadSettings()` only migrates strategy params from marketSignalSettings when `automation_settings` is missing in localStorage. Once the user saves from automation.html (post-Task-19), the migration is skipped. This means: legacy users with old `marketSignalSettings` (saved from settings.html pre-Task-19) will see their existing values pre-populated in automation.html on first visit; new users see defaults.
- The pre-existing bug where `settings.html`'s `saveSettings()` (which iterates `document.querySelectorAll('input, select')`) saves auth password fields (`authCurrentPassword`, `authNewPassword`) into marketSignalSettings localStorage+DB is unchanged — out of scope for this task. Future agents should consider filtering the iteration to only the API+Bale+Auth-username fields, NOT passwords.
- `htfConfirmationSource` is still saved to BOTH `this.settings`-derived `marketSettings` and read directly from the DOM in `analyzeMarketData()` (per task spec). The DOM-read at analysis time means changes between `saveSettings()` and the next analysis run are picked up live.
