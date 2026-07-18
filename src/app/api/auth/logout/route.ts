import { NextResponse } from 'next/server'

export const runtime = 'edge'

/**
 * Logout API
 * ==========
 *
 * Clears the auth cookie.
 *
 * Request:
 *   POST /api/auth/logout
 *
 * Response:
 *   { success: true }
 */
export async function POST() {
  const response = NextResponse.json({ success: true })
  response.cookies.delete('auth_token')
  return response
}
