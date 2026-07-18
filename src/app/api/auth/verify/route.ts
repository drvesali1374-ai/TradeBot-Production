import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

/**
 * Verify Auth API
 * ===============
 *
 * Verifies if the auth cookie is valid.
 * Used by client-side pages to check if user is logged in.
 *
 * Request:
 *   GET /api/auth/verify
 *
 * Response:
 *   - Valid: { success: true, username: string }
 *   - Invalid: { success: false } (401)
 */

async function verifyCookie(cookieValue: string, secret: string): Promise<boolean> {
  try {
    const parts = cookieValue.split(':')
    if (parts.length !== 3) return false

    const [username, expiryStr, signature] = parts
    const expiry = parseInt(expiryStr)

    // Check if expired
    if (Date.now() > expiry) return false

    // Verify signature
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

export async function GET(request: NextRequest) {
  const authCookie = request.cookies.get('auth_token')?.value

  if (!authCookie) {
    return NextResponse.json({ success: false }, { status: 401 })
  }

  const authSecret = process.env.AUTH_SECRET || 'tradebot-default-auth-secret-change-me'
  const isValid = await verifyCookie(authCookie, authSecret)

  if (!isValid) {
    return NextResponse.json({ success: false }, { status: 401 })
  }

  // Extract username from cookie
  const username = authCookie.split(':')[0]
  return NextResponse.json({ success: true, username })
}
