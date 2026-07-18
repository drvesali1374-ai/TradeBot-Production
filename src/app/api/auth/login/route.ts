import { NextRequest, NextResponse } from 'next/server'
import { initializeDatabase, AutomationState } from '@/lib/tradebot/database'

export const runtime = 'edge'

/**
 * Login API
 * ==========
 *
 * Authenticates the user with username/password and sets a signed cookie.
 *
 * Credentials are stored in KV under key 'auth_credentials':
 *   { username: string, passwordHash: string }
 *
 * The password is hashed using Web Crypto API (SHA-256) for security.
 * The cookie is signed using HMAC-SHA256 with AUTH_SECRET env var.
 *
 * Request:
 *   POST /api/auth/login
 *   Body: { username: string, password: string }
 *
 * Response:
 *   - Success: { success: true } + Set-Cookie header
 *   - Failure: { success: false, error: string } (401)
 */

// Hash a password using SHA-256 (Web Crypto API)
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// Sign a value using HMAC-SHA256
async function signValue(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function POST(request: NextRequest) {
  try {
    await initializeDatabase()

    const body = await request.json()
    const { username, password } = body

    if (!username || !password) {
      return NextResponse.json(
        { success: false, error: 'نام کاربری و رمز عبور الزامی است' },
        { status: 400 }
      )
    }

    // Get stored credentials from KV
    const storedCreds = await AutomationState.get('auth_credentials')

    // If no credentials stored yet, use default (admin/admin) and store them
    let creds
    if (!storedCreds) {
      // First login: set default credentials (admin/admin)
      // User should change these immediately from settings
      const defaultHash = await hashPassword('admin')
      creds = { username: 'admin', passwordHash: defaultHash }
      await AutomationState.set('auth_credentials', creds)
    } else {
      creds = typeof storedCreds === 'string' ? JSON.parse(storedCreds) : storedCreds
    }

    // Verify credentials
    const passwordHash = await hashPassword(password)
    if (username !== creds.username || passwordHash !== creds.passwordHash) {
      return NextResponse.json(
        { success: false, error: 'نام کاربری یا رمز عبور اشتباه است' },
        { status: 401 }
      )
    }

    // Create signed cookie
    // Cookie format: username:expiry:signature
    const authSecret = process.env.AUTH_SECRET || 'tradebot-default-auth-secret-change-me'
    const expiry = Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days
    const cookieValue = `${username}:${expiry}`
    const signature = await signValue(cookieValue, authSecret)
    const signedCookie = `${cookieValue}:${signature}`

    const response = NextResponse.json({ success: true })
    response.cookies.set('auth_token', signedCookie, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 7 * 24 * 60 * 60, // 7 days
    })

    return response
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/auth/login] Error:', error)
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    )
  }
}
