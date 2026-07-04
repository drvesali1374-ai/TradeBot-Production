import crypto from 'crypto'

/**
 * Build a sorted query string from params object
 */
export function buildSortedQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')
}

/**
 * Generate HMAC-SHA256 signature
 */
export function generateSignature(queryString: string, secretKey: string): string {
  return crypto.createHmac('sha256', secretKey).update(queryString).digest('hex')
}

/**
 * Extract settings from request body and headers
 */
export function getSettingsFromRequest(
  body: Record<string, unknown> | null,
  headers: Headers
): { apiKey: string; secretKey: string; baseUrl: string } {
  const settings = (body?.settings || {}) as Record<string, string>

  const apiKey = settings.apiKey || headers.get('X-API-Key') || process.env.TOOBIT_API_KEY || ''
  const secretKey = settings.secretKey || headers.get('X-Secret-Key') || process.env.TOOBIT_SECRET_KEY || ''
  const baseUrl = settings.baseUrl || headers.get('X-Base-Url') || process.env.TOOBIT_BASE || 'https://api.toobit.com'

  return { apiKey, secretKey, baseUrl }
}
