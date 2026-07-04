import { NextRequest, NextResponse } from 'next/server'
import { AutomationState, initializeDatabase } from '@/lib/tradebot/database'

export const runtime = 'edge'

/**
 * Centralized Settings API
 *
 * Stores ALL application settings in the permanent database (KV in Cloudflare)
 * instead of relying solely on browser localStorage.
 *
 * Settings managed here:
 *   1. marketSignalSettings — indicator params, symbol/interval, API keys (from settings.html)
 *   2. automation_settings  — risk params, leverage, bale token/chat (from automation.html)
 *   3. automation_symbols   — symbol list for automation
 *
 * GET  /api/settings              → returns all settings groups
 * GET  /api/settings?key=xxx      → returns a single group
 * POST /api/settings              → saves a settings group { key, value }
 *
 * This ensures settings persist across devices/browsers and are available
 * to server-side operations (like the cron-triggered run-cycle).
 */

// Keys used to store each settings group in the database
const SETTINGS_KEYS = {
  marketSignal: 'marketSignalSettings',
  automation: 'automation_settings',
  symbols: 'automation_symbols',
  apiKeys: 'settings_apiKeys',
  htfSource: 'htfConfirmationSource'
} as const

type SettingsKey = keyof typeof SETTINGS_KEYS | string

export async function GET(request: NextRequest) {
  try {
    await initializeDatabase()
    const key = request.nextUrl.searchParams.get('key')

    if (key) {
      // Return a single settings group
      const value = await AutomationState.get(key)
      return NextResponse.json({ success: true, data: value })
    }

    // Return all known settings groups
    const all: Record<string, unknown> = {}
    for (const k of Object.values(SETTINGS_KEYS)) {
      const v = await AutomationState.get(k)
      if (v !== null && v !== undefined) {
        all[k] = v
      }
    }
    return NextResponse.json({ success: true, data: all })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    await initializeDatabase()
    const body = await request.json()
    const { key, value } = body as { key: SettingsKey; value: unknown }

    if (!key) {
      return NextResponse.json(
        { success: false, error: 'Key is required' },
        { status: 400 }
      )
    }

    await AutomationState.set(key, value)

    // If saving marketSignalSettings, also keep a separate apiKeys entry
    // for backwards compatibility with settings.html which reads 'settings_apiKeys'
    if (key === SETTINGS_KEYS.marketSignal && value && typeof value === 'object') {
      const v = value as Record<string, string>
      await AutomationState.set(SETTINGS_KEYS.apiKeys, {
        apiKey: v.apiKey || '',
        secretKey: v.secretKey || '',
        baseUrl: v.baseUrl || 'https://api.toobit.com'
      })
    }

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
