import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, AutomationState } from '@/lib/tradebot/database'

export const runtime = 'edge'

/**
 * Update Credentials API
 * ======================
 *
 * Updates the username and password stored in KV.
 * Requires the user to be authenticated (valid auth cookie).
 *
 * Request:
 *   POST /api/auth/update-credentials
 *   Body: { newUsername: string, newPassword: string, currentPassword: string }
 *
 * Response:
 *   - Success: { success: true }
 *   - Failure: { success: false, error: string }
 */

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

async function verifyCookie(cookieValue: string, secret: string): Promise<boolean> {
  try {
    const parts = cookieValue.split(':')
    if (parts.length !== 3) return false
    const [username, expiryStr, signature] = parts
    const expiry = parseInt(expiryStr)
    if (Date.now() > expiry) return false
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const expectedSignature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${username}:${expiryStr}`)
    )
    const expectedHex = Array.from(new Uint8Array(expectedSignature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    return signature === expectedHex
  } catch {
    return false
  }
}

export async function POST(request: NextRequest) {
  try {
    await initializeDatabase()

    // Verify auth
    const authCookie = request.cookies.get('auth_token')?.value
    if (!authCookie) {
      return NextResponse.json({ success: false, error: 'احراز هویت نشده' }, { status: 401 })
    }
    const authSecret = process.env.AUTH_SECRET || 'tradebot-default-auth-secret-change-me'
    const isValid = await verifyCookie(authCookie, authSecret)
    if (!isValid) {
      return NextResponse.json({ success: false, error: 'احراز هویت نامعتبر' }, { status: 401 })
    }

    const body = await request.json()
    const { newUsername, newPassword, currentPassword } = body

    if (!newUsername || !newPassword || !currentPassword) {
      return NextResponse.json(
        { success: false, error: 'همه فیلدها الزامی است' },
        { status: 400 }
      )
    }

    // Verify current password
    const storedCreds = await AutomationState.get('auth_credentials')
    if (!storedCreds) {
      return NextResponse.json(
        { success: false, error: 'هیچ اعتبارنامه‌ای تنظیم نشده' },
        { status: 400 }
      )
    }

    const creds = typeof storedCreds === 'string' ? JSON.parse(storedCreds) : storedCreds
    const currentPasswordHash = await hashPassword(currentPassword)

    if (currentPasswordHash !== creds.passwordHash) {
      return NextResponse.json(
        { success: false, error: 'رمز عبور فعلی اشتباه است' },
        { status: 401 }
      )
    }

    // Update credentials
    const newPasswordHash = await hashPassword(newPassword)
    await AutomationState.set('auth_credentials', {
      username: newUsername,
      passwordHash: newPasswordHash
    })

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
