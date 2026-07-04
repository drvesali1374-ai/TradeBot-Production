import { NextRequest, NextResponse } from 'next/server'
import { AutomationState, initializeDatabase } from '@/lib/tradebot/database'

export const runtime = 'edge'

/**
 * Automation State API
 * 
 * Key-value store for automation state persistence.
 * This route was previously missing (caused 404 errors).
 * The frontend (automation-manager.js, settings.html) calls this to
 * persist state to the database instead of relying solely on localStorage.
 *
 * In Cloudflare deployment, this data will be stored in KV.
 * Locally, it uses the JSON file database.
 *
 * Response format (required by frontend):
 *   GET: { success: true, data: value } or { success: true, data: { key: value, ... } }
 *   POST: { success: true }
 *   DELETE: { success: true }
 */

// GET: retrieve a single key or all state
export async function GET(request: NextRequest) {
  try {
    await initializeDatabase()
    const key = request.nextUrl.searchParams.get('key')

    if (key) {
      const value = await AutomationState.get(key)
      return NextResponse.json({ success: true, data: value })
    }

    // No key provided — return all state
    const all = await AutomationState.getAll()
    return NextResponse.json({ success: true, data: all })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

// POST: set a key-value pair
export async function POST(request: NextRequest) {
  try {
    await initializeDatabase()
    const body = await request.json()
    const { key, value } = body

    if (!key) {
      return NextResponse.json(
        { success: false, error: 'Key is required' },
        { status: 400 }
      )
    }

    await AutomationState.set(key, value)
    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}

// DELETE: remove a key
export async function DELETE(request: NextRequest) {
  try {
    await initializeDatabase()
    const key = request.nextUrl.searchParams.get('key')

    if (!key) {
      // Try to read from body as fallback
      try {
        const body = await request.json()
        if (body && body.key) {
          await AutomationState.delete(body.key)
          return NextResponse.json({ success: true })
        }
      } catch {
        // body parse failed
      }
      return NextResponse.json(
        { success: false, error: 'Key is required' },
        { status: 400 }
      )
    }

    await AutomationState.delete(key)
    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
