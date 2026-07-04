/**
 * TradeBot Helpers — Cloudflare-ready (Edge Runtime + local dev)
 *
 * ✓ Uses Web Crypto API (works in both Cloudflare Edge Runtime AND Node.js 18+)
 * ✓ No Node.js `crypto` module import — fully Edge-compatible
 * ✓ generateSignature is async (required by Web Crypto)
 *
 * IMPORTANT: All callers MUST `await generateSignature(...)`.
 */

/**
 * Build a sorted query string from params object.
 * Identical behaviour to the original (synchronous, no crypto).
 */
export function buildSortedQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')
}

/**
 * Generate HMAC-SHA256 signature.
 *
 * ✓ Uses Web Crypto API exclusively — works in both Cloudflare Edge Runtime
 *   and Node.js 18+ (which both support crypto.subtle).
 *
 * @returns hex-encoded HMAC-SHA256 digest
 */
export async function generateSignature(
  queryString: string,
  secretKey: string
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(queryString)
  )
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Extract settings from request body and headers.
 * Falls back to environment variables (Cloudflare Secrets / .env) if not provided.
 */
export function getSettingsFromRequest(
  body: Record<string, unknown> | null,
  headers: Headers
): { apiKey: string; secretKey: string; baseUrl: string } {
  const settings = (body?.settings || {}) as Record<string, string>

  const apiKey =
    settings.apiKey ||
    headers.get('X-API-Key') ||
    (typeof process !== 'undefined' ? process.env?.TOOBIT_API_KEY : '') ||
    ''
  const secretKey =
    settings.secretKey ||
    headers.get('X-Secret-Key') ||
    (typeof process !== 'undefined' ? process.env?.TOOBIT_SECRET_KEY : '') ||
    ''
  const baseUrl =
    settings.baseUrl ||
    headers.get('X-Base-Url') ||
    (typeof process !== 'undefined' ? process.env?.TOOBIT_BASE : '') ||
    'https://api.toobit.com'

  return { apiKey, secretKey, baseUrl }
}
