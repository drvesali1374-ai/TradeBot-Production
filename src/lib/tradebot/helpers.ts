/**
 * TradeBot Helpers — Cloudflare-ready (works in both Node.js and Edge/Worker runtimes)
 *
 * ✓ Uses Web Crypto API when available (Cloudflare Workers / Edge Runtime)
 * ✓ Falls back to Node.js crypto module in local dev (Node.js runtime)
 * ✓ generateSignature is async (required by Web Crypto)
 *
 * IMPORTANT: All callers MUST `await generateSignature(...)`.
 */

// Detect runtime: Edge/Worker has globalThis.crypto.subtle (Web Crypto API)
// Node.js >= 20 also exposes crypto.subtle, but we keep the Node fallback for
// compatibility with older versions and the JSON-file dev database.
const hasWebCrypto =
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as { crypto?: { subtle?: unknown } }).crypto !== 'undefined' &&
  typeof (globalThis as { crypto: { subtle?: unknown } }).crypto.subtle !== 'undefined'

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
 * ✓ Cloudflare-ready: uses Web Crypto API (async) when available.
 * ✓ Backward-compatible: falls back to Node.js crypto in local dev.
 *
 * @returns hex-encoded HMAC-SHA256 digest
 */
export async function generateSignature(
  queryString: string,
  secretKey: string
): Promise<string> {
  if (hasWebCrypto) {
    // Web Crypto API (Cloudflare Workers / Edge Runtime / modern Node.js)
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

  // Node.js fallback (local dev with JSON-file database)
  const nodeCrypto = await import('crypto')
  return nodeCrypto.createHmac('sha256', secretKey).update(queryString).digest('hex')
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
    process.env.TOOBIT_API_KEY ||
    ''
  const secretKey =
    settings.secretKey ||
    headers.get('X-Secret-Key') ||
    process.env.TOOBIT_SECRET_KEY ||
    ''
  const baseUrl =
    settings.baseUrl ||
    headers.get('X-Base-Url') ||
    process.env.TOOBIT_BASE ||
    'https://api.toobit.com'

  return { apiKey, secretKey, baseUrl }
}
