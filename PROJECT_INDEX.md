# 📖 نمایه کامل پروژه — سیستم اتوماسیون هوشمند معاملات آتی صرافی توبیت (نسخه تولیدی)

> این سند شامل نقشه کامل ساختار، مکانیزم‌ها و نحوه عملکرد تمام بخش‌های پروژه است.
> هر توسعه‌دهنده‌ای با مطالعه این سند باید بتواند پروژه را به طور کامل درک کند.
> این نسخه شامل تمام تغییرات اعمال‌شده تا تاریخ اکتبر ۲۰۲۶ است.

---

## ۱. مشخصات کلی پروژه

| ویژگی | مقدار |
|--------|-------|
| **نام پروژه** | سیستم اتوماسیون هوشمند معاملات آتی (Futures) |
| **صنعت** | معاملات رمزارز — صرافی توبیت (Toobit) |
| **زبان** | TypeScript / JavaScript (فارسی — RTL) |
| **فریمورک اصلی** | Next.js 16 با App Router |
| **زمان‌اجرا** | Bun (توسعه محلی) / Cloudflare Pages (تولید) |
| **پورت توسعه** | 3000 |
| **خروجی** | Cloudflare Pages (@cloudflare/next-on-pages) |
| **پشتیبانی زبان** | فارسی (فونت Vazirmatn) |
| **تم بصری** | Dark glass-morphism با گرادیان بنفش |
| **پلتفرم تولید** | Cloudflare Pages + Cloudflare Worker (Cron) |
| **دیتابیس** | Cloudflare KV (TRADING_DATA namespace) |

### هدف پروژه
سیستم اتوماسیون معاملات آتی رمزارزها بر اساس تحلیل تکنیکال. این سیستم:
- داده‌های کندل ساعتی را از صرافی توبیت دریافت می‌کند
- اندیکاتورهای فنی (RSI, ATR, SMA) و سطوح روزانه را محاسبه می‌کند
- سیگنال‌های ورود لانگ/شورت تولید می‌کند
- به صورت خودکار پوزیشن‌ها را باز و بسته می‌کند
- کنترل‌های ریسک متعدد را اعمال می‌نماید
- نوتیفیکیشن‌های پیام‌رسان بله را ارسال می‌کند

---

## ۲. ساختار دایرکتوری

```
/home/z/my-project/
│
├── 📁 public/                          ← صفحات HTML استاتیک + JS/CSS (فرانت‌اند اصلی)
│   ├── home.html                       ← صفحه فرود (لندینگ)
│   ├── settings.html                   ← صفحه تنظیمات عمومی (API keys + Bale)
│   ├── automation.html                 ← صفحه اتوماسیون (صفحه اصلی + تنظیمات استراتژی)
│   ├── trading.html                    ← صفحه معاملات دستی
│   ├── market_signal.html              ← صفحه داشبورد/تحلیل
│   ├── login.html                      ← صفحه ورود (احراز هویت)
│   ├── auth-check.js                   ← اسکریپت بررسی احراز هویت
│   ├── init-settings.js                ← مقداردهی اولیه localStorage
│   ├── main.js                         ← ابزارهای مشترک (MarketSignalUtils)
│   └── js/
│       ├── automation-manager.js       ← موتور اتوماسیون (سمت کلاینت)
│       ├── market-signal-analyzer.js   ← منطق داشبورد
│       └── shared/
│           ├── visualization.js        ← رندر نمودار ECharts
│           ├── ui-utils.js             ← ابزارهای رابط کاربری
│           └── signal-utils.js         ← محاسبات اندیکاتورها (RSI, ATR, SMA)
│
├── 📁 src/                             ← بک‌اند Next.js
│   ├── app/
│   │   ├── layout.tsx                  ← لایه‌بندی ریشه (RTL, فارسی)
│   │   ├── page.tsx                    ← صفحه ریشه (redirect به login یا home)
│   │   ├── globals.css                 ← CSS سراسری + متغیرهای shadcn
│   │   └── api/                        ← API Routes (Edge Runtime)
│   │       ├── auth/                   ← احراز هویت
│   │       │   ├── login/route.ts      ← ورود (Signed Cookie)
│   │       │   ├── logout/route.ts     ← خروج
│   │       │   ├── verify/route.ts     ← بررسی توکن
│   │       │   └── update-credentials/route.ts ← تغییر نام کاربری/رمز
│   │       ├── bale-send/route.ts      ← ارسال پیام بله
│   │       ├── balance/route.ts        ← دریافت موجودی
│   │       ├── close-position/route.ts ← بستن پوزیشن
│   │       ├── create-position/route.ts← باز کردن پوزیشن
│   │       ├── history/route.ts        ← دریافت تاریخچه معاملات
│   │       ├── history-positions/route.ts ← دریافت پوزیشن‌های بسته‌شده
│   │       ├── open-positions/route.ts ← دریافت پوزیشن‌های باز
│   │       ├── toobit-proxy/route.ts   ← پروکسی کندل‌ها
│   │       ├── run-cycle/route.ts      ← اجرای چرخه اتوماسیون (Cron + دستی)
│   │       ├── settings/route.ts       ← تنظیمات (GET/POST)
│   │       ├── route.ts                ← Health check
│   │       └── db/                     ← CRUD دیتابیس KV
│   │           ├── automation-state/route.ts
│   │           ├── logs/route.ts
│   │           ├── positions/route.ts
│   │           ├── positions/[param]/route.ts
│   │           ├── signals/route.ts
│   │           ├── stats/route.ts
│   │           ├── stats/[symbol]/route.ts
│   │           ├── trades/route.ts
│   │           └── trades/[param]/route.ts
│   ├── components/ui/                  ← کامپوننت‌های shadcn/ui (40+ کامپوننت)
│   ├── hooks/                          ← هوک‌های React
│   └── lib/
│       ├── db.ts                       ← سینگلتون Prisma Client
│       ├── utils.ts                    ← cn() (clsx + tailwind-merge)
│       └── tradebot/
│           ├── database.js             ← دیتابیس KV-compatible (async)
│           ├── helpers.ts              ← امضای HMAC (Web Crypto API)
│           └── cycle-engine.ts         ← موتور چرخه سمت سرور (Cron)
│
├── 📁 lib/tradebot/                    ← کپی دیتابیس JSON (محیط محلی)
│   └── trading_data.json               ← فایل دیتابیس محلی
│
├── 📁 cloudflare/                      ← تنظیمات Cloudflare
│   ├── DEPLOYMENT_GUIDE.md             ← راهنمای استقرار
│   └── cron-worker/                    ← Worker کرون (هر ۵ دقیقه)
│       ├── src/index.ts                ← کد Worker
│       ├── wrangler.toml               ← تنظیمات Worker
│       ├── package.json
│       └── tsconfig.json
│
├── 📁 prisma/
│   └── schema.prisma                   ← اسکیما Prisma (غیرفعال)
│
├── 📁 examples/websocket/              ← نمونه WebSocket
│
├── worklog.md                          ← لاگ کامل توسعه
├── wrangler.toml                       ← تنظیمات Cloudflare Pages
├── next.config.ts                      ← تنظیمات Next.js
├── package.json                        ← وابستگی‌ها + اسکریپت‌ها
├── tailwind.config.ts                  ← تنظیمات Tailwind
├── tsconfig.json                       ← تنظیمات TypeScript
├── eslint.config.mjs                   ← تنظیمات ESLint
├── Caddyfile                           ← پروکسی معکوس
├── .run_cycle_secret                   ← راز مشترک Cron Worker
└── .env                                ← متغیرهای محیطی
```

---

## ۳. معماری سیستم

### ۳.۱ الگوی معماری

```
┌─────────────────────────────────────────────────┐
│            Cloudflare Cron (هر ۵ دقیقه)          │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│         Cron Worker (tradebot-cron-worker)       │
│                                                 │
│   scheduled() → fetch(/api/run-cycle?source=cron)│
│                 header: X-Run-Cycle-Secret      │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│            Pages App (tradebot-b9u.pages.dev)    │
│                                                 │
│   /api/run-cycle → runCycle() → ۱۴ مرحله:      │
│     1. انتخاب نماد (selectNextSymbol)           │
│     2. دریافت کندل‌ها (Toobit API)              │
│     3. تولید سیگنال (RSI/ATR/SMA + Fake Breakout)│
│     4. دریافت تاریخچه                           │
│     5. بررسی سیگنال آماده + انقضای سیگنال        │
│     6. دریافت قیمت                              │
│     7. بستن پوزیشن مخالف                        │
│     8. بروزرسانی جدول سوابق                     │
│     9. بروزرسانی جدول پوزیشن‌های باز            │
│    10. دریافت موجودی                            │
│    11. محاسبه مارجین                            │
│    12. کنترل‌های ریسک (۶ کنترل)                │
│    13. باز کردن پوزیشن                          │
│    14. نوتیف بله                                │
│                                                 │
│   داده‌ها ←→ KV (TRADING_DATA)                  │
│   Secrets ←→ Cloudflare Secrets                 │
└─────────────────────────────────────────────────┘
```

### ۳.۲ لایه‌های ذخیره‌سازی (Two-Layer Storage)

| لایه | نوع | کاربرد |
|------|------|--------|
| **Worker Memory** | حافظه موقت | logs, balance, signals (در طول چرخه) |
| **KV** | دائمی | settings, automation_symbols, lastCycleTime, lastCycleLogs, lastPositionCloseTime |
| **localStorage** | مرورگر | کش محلی (fallback) |

### ۳.۳ بهینه‌سازی KV Writes

| تکنیک | توضیح |
|-------|-------|
| **Transaction Buffer** | تمام state updates در حافظه، ۱ write در پایان |
| **Batch Logs** | همه لاگ‌های چرخه در یک write |
| **No Debounce** | lastCycleLogs در هر چرخه نوشته می‌شود |
| **مجموع writes/day** | ~۸۶۴ (زیر حد ۱,۰۰۰) |

---

## ۴. صفحات فرانت‌اند

### ۴.۱ صفحه فرود (home.html)
- کارت‌های معرفی ویژگی‌ها و لینک به صفحات دیگر
- نوار ناوبری (۵ لینک: خانه، تنظیمات، داشبارد، خرید و فروش، اتوماسیون)

### ۴.۲ صفحه اتوماسیون (automation.html) — صفحه اصلی
**بخش‌های صفحه:**
| بخش | شناسه HTML | عملکرد |
|------|-----------|--------|
| هدر و کنترل | start/stop/run-once-btn | شروع/توقف/اجرا یک‌بار |
| نوار موجودی | balance-total/free/position-margin | نمایش موجودی USDT |
| پوزیشن‌های باز | positions-table-body | جدول پوزیشن‌های فعال |
| جدول نمادها | symbols-table-body | مدیریت لیست نمادها (drag & drop) |
| لاگ چرخه | cycle-log-body | لاگ لحظه‌ای اجرای چرخه |
| نمودار قیمت | price-chart | نمودار شمعی ECharts |
| سیگنال آماده | ready-signal-container | کارت سیگنال قابل اجرا |
| لیست سیگنال‌ها | signal-list | جزئیات تمام سیگنال‌ها |
| جدول داده‌های بازار | market-data-body | کندل‌ها + اندیکاتورها |
| سوابق پوزیشن‌ها | history-table-body | تاریخچه معاملات |
| تنظیمات (مودال) | settings-modal | پارامترهای استراتژی + ریسک |

### ۴.۳ صفحه تنظیمات (settings.html)
- کلیدهای API صرافی (apiKey, secretKey, baseUrl)
- تنظیمات بله (baleToken, baleChatId)
- دکمه تست بله
- تغییر نام کاربری/رمز عبور

### ۴.۴ صفحه ورود (login.html)
- فرم نام کاربری/رمز عبور
- Signed Cookie با HMAC-SHA256
- پیش‌فرض: admin/admin (قابل تغییر)

---

## ۵. تنظیمات (دو بخش مستقل)

### ۵.الف تنظیمات عمومی سیستم (settings.html)
| تنظیم | کلید | توضیح |
|-------|------|--------|
| API Key | apiKey | کلید API صرافی توبیت |
| Secret Key | secretKey | کلید مخفی صرافی |
| Base URL | baseUrl | آدرس API (https://api.toobit.com) |
| Bale Token | baleToken | توکن ربات بله |
| Bale Chat ID | baleChatId | شناسه چت بله |

### ۵.ب تنظیمات اتوماسیون (automation.html)
**گروه‌بندی:**

| گروه | پارامترها |
|------|-----------|
| **بازار** | interval, limit, lookback |
| **اندیکاتورها** | rsiLongThreshold, rsiShortThreshold, rsiPeriod, atrPeriod, avgVolPeriod, volMultLong, volMultShort, htfConfirmationSource |
| **Fake Breakout** | enableMeaningfulBreakFilter, breakAtrMultiplierLong, breakAtrMultiplierShort, breakDetectionMethod, enableBreakLifecycleManagement, breakSequenceLifetime |
| **TP/SL** | tpLongMult, slLongMult, tpShortMult, slShortMult, longFixedTp/Sl, shortFixedTp/Sl |
| **مدیریت ریسک** | safeAssetPercent, maxMarginPerSymbolPercent, signalExpirationHours, minSameDirectionCandles, minPriceDistancePercentLong, minPriceDistancePercentShort |
| **اجرای معاملات** | leverageLong, leverageShort, entryMarginPercentLong, entryMarginPercentShort, tradeWaitTime, allowedErrors, cyclesPerRun, closedPositionsNotifyCount |

**نکته:** تمام پارامترهای RSI، Volume، Leverage، Break ATR، Entry Margin و Price Distance برای Long و Short **مستقل** هستند.

---

## ۶. موتور اتوماسیون

### ۶.۱ سمت کلاینت (automation-manager.js)
- کلاس `AutomationManager` (~۲۲۲KB)
- مدیریت UI، تولید سیگنال، کنترل‌های ریسک
- `runCycle()` — اجرای چرخه کامل
- `analyzeMarketData()` — تحلیل و تولید سیگنال
- `calculateSignalStatus()` — وضعیت سیگنال (در انتظار/باز شده/منقضی شده)

### ۶.۲ سمت سرور (cycle-engine.ts)
- کلاس `runCycle()` — پورت TypeScript از منطق کلاینت
- `checkClosedPositionsHistory()` — بررسی پوزیشن‌های بسته‌شده جدید
- اجرا توسط Cron Worker هر ۵ دقیقه

### ۶.۳ ترتیب ۱۴ مرحله چرخه
1. `selectNextSymbol()` — انتخاب اولین نماد آماده
2. `fetchMarketData()` — دریافت کندل‌ها
3. `analyzeMarketData()` — تولید سیگنال (شامل Fake Breakout + Lifecycle)
4. `fetchPositionHistory()` — دریافت تاریخچه
5. `updateSelectedSignal()` — بررسی سیگنال آماده + انقضا
6. `fetchPrice()` — قیمت فعلی
7. `closeOppositePositions()` — بستن پوزیشن مخالف
8. بروزرسانی جدول سوابق پوزیشن‌ها
9. بروزرسانی جدول پوزیشن‌های باز + محاسبه «آخرین ورود»
10. `fetchBalance()` — موجودی
11. `calculateNewMargin()` — مارجین ورودی
12. کنترل‌های ریسک (۶ کنترل)
13. `openPosition()` — باز کردن پوزیشن
14. `notifyOpenPosition()` — نوتیف بله

---

## ۷. استراتژی Fake Breakout

### ۷.۱ اصلاح ۱: فیلتر شکست معنادار (Meaningful Break Filter)
- شکست فقط زمانی معتبر است که قیمت حداقل `ATR × breakAtrMultiplier` از سطح عبور کرده باشد
- دو روش تشخیص: Wick (High/Low) یا Close
- پارامترهای مستقل Long/Short

### ۷.۲ اصلاح ۲: مدیریت چرخه شکست (Break Lifecycle Management)
- State Machine: Idle → Break → Waiting Recovery → Recovery → Signal → Reset
- انقضای شکست بعد از `breakSequenceLifetime` کندل
- شکست جدید جایگزین شکست قبلی
- سیگنال فقط در کندل Recovery تولید می‌شود

---

## ۸. کنترل‌های ریسک

| # | کنترل | شرط |
|---|-------|-----|
| ۱ | دارایی امن | freeBalance - newMargin ≥ totalAssets × safeAssetPercent% |
| ۲ | فاصله قیمت | distance ≥ minPriceDistancePercent (Long/Short مستقل) |
| ۳ | سقف مارجین نماد | existingMargin + newMargin ≤ maxMarginPerSymbolPercent% |
| ۴ | مارجین مثبت | finalMargin > 0 |
| ۵ | حداقل کندل هم‌جهت | N کندل بعد از سیگنال همگی هم‌جهت |
| ۶ | انقضای سیگنال | signal age < signalExpirationHours |

**نکته:** کنترل‌های ۲ و ۳ فقط اگر نماد در جدول پوزیشن‌های باز باشد اجرا می‌شوند.

---

## ۹. نوتیفیکیشن‌های بله

### ۹.۱ هشتگ‌گذاری
| نوع پیام | هشتگ |
|----------|------|
| کنترل فاصله قیمت | #فاصله_قیمت |
| کنترل دارایی امن | #دارایی_امن |
| کنترل سقف مارجین | #سقف_مارجین |
| کنترل مارجین مثبت | #مارجین_مثبت |
| کنترل کندل هم‌جهت | #کندل_هم‌جهت |
| ورود به پوزیشن | #ورود_پوزیشن |
| خطای اتوماسیون | #خطا |
| عبور از نماد | #عبور_نماد |
| تاریخچه پوزیشن‌های بسته | #تاریخچه_بسته |

### ۹.۲ ارسال از مرورگر (Cloudflare fix)
- Cloudflare نمی‌تواند به `tapi.bale.ai` برسد (DNS error 1016)
- مرورگر مستقیماً با `mode: 'no-cors'` + `Content-Type: text/plain` ارسال می‌کند
- پیام‌های معوق در KV (`pendingBaleMessages`) ذخیره و توسط مرورگر ارسال می‌شوند

---

## ۱۰. احراز هویت

- صفحه `login.html` با فرم نام کاربری/رمز عبور
- Signed Cookie با HMAC-SHA256 (7 روز اعتبار)
- Credentials در KV (`auth_credentials`) با هش SHA-256
- پیش‌فرض: admin/admin (قابل تغییر از صفحه تنظیمات)
- `auth-check.js` در تمام صفحات (redirect به login اگر احراز هویت نشده)

---

## ۱۱. API Routes

### ۱۱.۱ Exchange API Routes (همه Edge Runtime)
| Route | متد | توضیح |
|-------|------|--------|
| `/api/toobit-proxy` | GET | پروکسی کندل‌ها |
| `/api/balance` | GET | موجودی (HMAC-SHA256) |
| `/api/open-positions` | GET | پوزیشن‌های باز |
| `/api/history` | POST | تاریخچه معاملات |
| `/api/history-positions` | GET | پوزیشن‌های بسته‌شده |
| `/api/create-position` | POST | باز کردن پوزیشن |
| `/api/close-position` | POST | بستن پوزیشن |
| `/api/bale-send` | POST | ارسال پیام بله |

### ۱۱.۲ Database API Routes
| Route | متدها | توضیح |
|-------|--------|--------|
| `/api/db/automation-state` | GET/POST/DELETE | KV key-value store |
| `/api/db/logs` | GET/POST | لاگ‌ها |
| `/api/db/positions` | GET/POST | پوزیشن‌ها |
| `/api/db/signals` | GET/POST | سیگنال‌ها |
| `/api/db/trades` | GET/POST | معاملات |
| `/api/db/stats` | GET | آمار |

### ۱۱.۳ Other API Routes
| Route | متد | توضیح |
|-------|------|--------|
| `/api/run-cycle` | GET/POST | اجرای چرخه (Cron + دستی) |
| `/api/settings` | GET/POST | تنظیمات |
| `/api/auth/login` | POST | ورود |
| `/api/auth/logout` | POST | خروج |
| `/api/auth/verify` | GET | بررسی توکن |
| `/api/auth/update-credentials` | POST | تغییر credentials |

---

## ۱۲. Cloudflare Deployment

### ۱۲.۱ ساختار
| بخش | نوع | هدف |
|------|------|------|
| Pages App | Cloudflare Pages | اپلیکیشن Next.js |
| Cron Worker | Cloudflare Worker | اجرای خودکار هر ۵ دقیقه |
| KV Namespace | TRADING_DATA | دیتابیس دائمی |

### ۱۲.۲ KV Keys
| Key | محتوا |
|-----|-------|
| `automationState:automation_settings` | تنظیمات اتوماسیون |
| `automationState:automation_symbols` | لیست نمادها + lastCycleTime |
| `automationState:marketSignalSettings` | تنظیمات بازار + API keys |
| `automationState:auth_credentials` | نام کاربری/رمز عبور (هش) |
| `automationState:lastPositionCloseTime` | آخرین timestamp پوزیشن بسته‌شده |
| `automationState:pendingBaleMessages` | پیام‌های بله معوق |
| `lastCycleLogs` | لاگ‌های آخرین چرخه |
| `logs` | آرایه لاگ‌های مشترک (max 500) |

### ۱۲.۳ Secrets
| Secret | هدف |
|--------|------|
| `RUN_CYCLE_SECRET` | احراز هویت Cron Worker ↔ Pages |
| `AUTH_SECRET` | امضای Cookie احراز هویت |

---

## ۱۳. وابستگی‌ها

### ۱۳.۱ اصلی
| فناوری | نسخه | استفاده |
|--------|------|---------|
| Next.js | 16 | فریمورک اصلی |
| React | 19 | رندر صفحه ریشه |
| Tailwind CSS | 4 | استایل‌دهی |
| shadcn/ui | — | کامپوننت‌های UI |
| ECharts | (CDN) | نمودار شمعی |
| @cloudflare/next-on-pages | — | Build برای Cloudflare |
| wrangler | — | CLI Cloudflare |

### ۱۳.۲ Cron Worker
| فناوری | نسخه | استفاده |
|--------|------|---------|
| TypeScript | 5 | زبان |
| wrangler | 4 | deploy |

---

## ۱۴. نکات مهم برای توسعه‌دهندگان

1. **محیط محلی:** `bun run dev` روی پورت ۳۰۰۰ — دیتابیس JSON file
2. **Cloudflare:** `npx @cloudflare/next-on-pages` سپس `npx wrangler pages deploy`
3. **Cron Worker:** `cd cloudflare/cron-worker && npx wrangler deploy` سپس re-set secret
4. **پس از deploy Worker:** همیشه `RUN_CYCLE_SECRET` را دوباره تنظیم کنید (deploy آن را پاک می‌کند)
5. **محدودیت KV:** ۱,۰۰۰ writes/day (پلان رایگان) — با بهینه‌سازی فعلی ~۸۶۴ writes/day
6. **بله API:** از مرورگر با `no-cors` ارسال می‌شود (Cloudflare نمی‌تواند به tapi.bale.ai برسد)
7. **Edge Runtime:** تمام API routes از `export const runtime = 'edge'` استفاده می‌کنند
8. **Web Crypto API:** `helpers.ts` فقط از Web Crypto استفاده می‌کند (نه Node.js crypto)
9. **پارامترهای Long/Short:** تمام پارامترهای استراتژی برای Long و Short مستقل هستند
10. **worklog.md:** لاگ کامل تغییرات — برای درک تاریخچه پروژه بخوانید
