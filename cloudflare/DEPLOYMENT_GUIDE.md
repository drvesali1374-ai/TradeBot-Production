# ☁️ راهنمای استقرار در Cloudflare — TradeBot

> این سند نحوه استقرار پروژه TradeBot در بستر Cloudflare را به‌صورت گام‌به‌گام توضیح می‌دهد.

---

## ساختار استقرار

پروژه از **دو بخش مجزا** در Cloudflare تشکیل می‌شود:

| بخش | نوع | هدف |
|------|-----|------|
| **Pages App** | Cloudflare Pages | اپلیکیشن Next.js (فرانت‌اند + API Routes) |
| **Cron Worker** | Cloudflare Worker | اجرای خودکار چرخه هر ۵ دقیقه |

> **چرا دو بخش؟** Cloudflare Pages از Cron Trigger پشتیبانی نمی‌کند. فقط Workers این قابلیت را دارند. بنابراین یک Worker جداگانه می‌سازیم که هر ۵ دقیقه endpoint `/api/run-cycle` را در Pages فراخوانی می‌کند.

---

## پیش‌نیازها

1. حساب Cloudflare (رایگان کافی است)
2. `wrangler` CLI: `npm install -g wrangler`
3. ورود: `npx wrangler login`
4. پکیج `@cloudflare/next-on-pages`: `npm install -D @cloudflare/next-on-pages`

---

## مرحله ۱: ساخت KV Namespace (دیتابیس دائمی)

KV جایگزین فایل JSON محلی می‌شود — تمام تنظیمات و داده‌ها در آن ذخیره می‌شوند.

```bash
npx wrangler kv namespace create TRADING_DATA
```

خروجی شامل `id` است. آن را در `wrangler.toml` جایگزین `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` کنید:

```toml
[[kv_namespaces]]
binding = "TRADING_DATA"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

---

## مرحله ۲: تنظیم Secrets (کلیدهای API)

این مقادیر به‌صورت رمزنگاری‌شده در Cloudflare ذخیره می‌شوند و هرگز در کد ظاهر نمی‌شوند:

```bash
# کلیدهای صرافی Toobit
npx wrangler secret put TOOBIT_API_KEY
npx wrangler secret put TOOBIT_SECRET_KEY

# کلیدهای ربات بله
npx wrangler secret put BALE_TOKEN
npx wrangler secret put BALE_CHAT_ID

# راز مشترک برای احراز هویت Cron Worker
# یک رشته تصادفی طولانی انتخاب کنید (مثلاً: openssl rand -hex 32)
npx wrangler secret put RUN_CYCLE_SECRET
```

> **نکته:** مقدار `RUN_CYCLE_SECRET` را یادداشت کنید — در مرحله ۴ برای Cron Worker هم نیاز است.

---

## مرحله ۳: ساخت و استقرار Pages App

```bash
# ۱. ساخت نسخه Cloudflare-compatible
npx @cloudflare/next-on-pages

# ۲. تست محلی (اختیاری)
npx wrangler pages dev .vercel/output/static --kv TRADING_DATA --compatibility-flag nodejs_compat

# ۳. استقرار
npx wrangler pages deploy .vercel/output/static
```

URL استقرار را یادداشت کنید (مثلاً `https://tradebot.pages.dev`).

---

## مرحله ۴: استقرار Cron Worker

```bash
cd cloudflare/cron-worker

# ۱. تنظیم APP_URL (URL Pages app از مرحله ۳)
#    یا در wrangler.toml [vars] یا به‌عنوان secret:
npx wrangler secret put APP_URL
#    مقدار: https://tradebot.pages.dev

# ۲. تنظیم RUN_CYCLE_SECRET (همان مقدار مرحله ۲)
npx wrangler secret put RUN_CYCLE_SECRET

# ۳. استقرار
npx wrangler deploy
```

پس از استقرار، در داشبورد Cloudflare بررسی کنید:
- **Workers & Pages → tradebot-cron-worker → Triggers → Cron Triggers**
- باید `*/5 * * * *` را ببینید

---

## مرحله ۵: انتقال داده‌های موجود به KV (اختیاری)

اگر داده‌هایی در فایل `lib/tradebot/trading_data.json` دارید که می‌خواهید به KV منتقل کنید:

```bash
# اسکریپت نمونه (نمایشی):
npx wrangler kv key put --namespace-id=YOUR_KV_ID "automation_symbols" "$(cat lib/tradebot/trading_data.json | jq '.automationState.automation_symbols')"
npx wrangler kv key put --namespace-id=YOUR_KV_ID "automation_settings" "$(cat lib/tradebot/trading_data.json | jq '.automationState.automation_settings')"
npx wrangler kv key put --namespace-id=YOUR_KV_ID "marketSignalSettings" "$(cat lib/tradebot/trading_data.json | jq '.automationState.marketSignalSettings // {}')"
```

> **نکته:** تنظیمات از طریق صفحه «تنظیمات» در اپلیکیشن نیز به KV ذخیره می‌شوند، بنابراین این مرحله فقط برای انتقال داده‌های تاریخی ضروری است.

---

## معماری نهایی

```
┌──────────────────────────────────────────────────────────┐
│                   Cloudflare Cron                         │
│              (هر ۵ دقیقه — */5 * * * *)                  │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│              Cron Worker (tradebot-cron-worker)           │
│                                                          │
│   scheduled() → fetch(APP_URL/api/run-cycle?source=cron) │
│                  header: X-Run-Cycle-Secret: xxx         │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│            Pages App (tradebot.pages.dev)                 │
│                                                          │
│   /api/run-cycle → runCycle() → 14 مرحله:               │
│     1. انتخاب نماد                                        │
│     2. دریافت کندل‌ها (Toobit)                            │
│     3. تولید سیگنال (RSI/ATR/SMA)                        │
│     4. دریافت تاریخچه                                     │
│     5. بررسی سیگنال آماده                                  │
│     6. دریافت قیمت                                        │
│     7. بستن پوزیشن مخالف                                  │
│     8. دریافت مارجین نماد                                 │
│     9. دریافت موجودی                                       │
│    10. محاسبه مارجین                                      │
│    11. کنترل ریسک (۵ کنترل)                              │
│    12. باز کردن پوزیشن                                    │
│    13. نوتیف بله                                          │
│    14. ذخیره وضعیت                                        │
│                                                          │
│   داده‌ها ←→ KV (TRADING_DATA)                           │
│   Secrets ←→ Cloudflare Secrets                          │
└──────────────────────────────────────────────────────────┘
```

---

## مهاجرت ذخیره‌سازی: localStorage → KV

| داده | قبلاً (localStorage) | حالا (KV / Database) |
|------|---------------------|----------------------|
| تنظیمات بازار (`marketSignalSettings`) | ✅ localStorage | ✅ `/api/settings` → KV |
| تنظیمات اتوماسیون (`automation_settings`) | ✅ localStorage + DB | ✅ KV (DB source of truth) |
| لیست نمادها (`automation_symbols`) | ✅ localStorage + DB | ✅ KV (DB source of truth) |
| کلیدهای API | ✅ localStorage | ✅ KV + Cloudflare Secrets |
| وضعیت اتوماسیون | ✅ localStorage | ✅ KV |
| موجودی / پوزیشن‌های باز | ✅ localStorage | ✅ KV |

> **سازگاری با گذشته:** localStorage همچنان به‌عنوان کش محلی استفاده می‌شود تا در صورت قطعی شبکه، اپلیکیشن کار کند. اما منبع حقیقت (source of truth) اکنون KV است.

---

## تست و نظارت

### تست دستی چرخه
```bash
curl -X POST https://tradebot.pages.dev/api/run-cycle
```

### تست Cron Worker
```bash
# آدرس Worker را از داشبورد Cloudflare بگیرید
curl "https://tradebot-cron-worker.your-subdomain.workers.dev/health"
curl "https://tradebot-cron-worker.your-subdomain.workers.dev/?secret=YOUR_RUN_CYCLE_SECRET"
```

### مشاهده لاگ‌ها
```bash
# Pages app logs
npx wrangler pages deployment tail

# Cron worker logs
cd cloudflare/cron-worker && npx wrangler tail
```

### بررسی KV
```bash
npx wrangler kv key list --namespace-id=YOUR_KV_ID
npx wrangler kv key get --namespace-id=YOUR_KV_ID "automation_settings"
```

---

## عیب‌یابی

| مشکل | راه‌حل |
|------|--------|
| خطای `APP_URL not configured` در Worker | `npx wrangler secret put APP_URL` را اجرا کنید |
| خطای `Unauthorized` در `/api/run-cycle?source=cron` | `RUN_CYCLE_SECRET` در Pages و Worker یکسان نیست |
| خطای `API credentials not configured` | کلیدهای API را در صفحه «تنظیمات» ذخیره کنید یا `TOOBIT_API_KEY`/`TOOBIT_SECRET_KEY` را به‌عنوان Secret تنظیم کنید |
| چرخه اجرا نمی‌شود | داشبورد Cloudflare → Worker → Triggers → Cron را بررسی کنید |
| داده‌ها در KV ذخیره نمی‌شوند | `binding = "TRADING_DATA"` و `id` صحیح در wrangler.toml را بررسی کنید |

---

## نکات امنیتی

1. **هرگز** کلیدهای API را در کد ننویسید — فقط از Cloudflare Secrets استفاده کنید
2. `RUN_CYCLE_SECRET` باید یک رشته تصادفی طولانی باشد (`openssl rand -hex 32`)
3. در محیط تولید، `/api/run-cycle` را فقط با `?source=cron` و secret معتبر فراخوانی کنید
4. دسترسی به KV را در داشبورد Cloudflare محدود کنید
