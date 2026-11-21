const AUTH_STORAGE_KEYS = ['access_token', 'refresh_token', 'tenant_slug', 'digitcrm-auth'] as const

export type JwtPayload = {
  exp?: number
  sub?: string
  user_id?: number
  [key: string]: unknown
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return atob(padded)
}

export function decodeToken(token: string | null | undefined): JwtPayload | null {
  if (!token) return null

  const parts = token.split('.')
  if (parts.length < 2) return null

  try {
    return JSON.parse(decodeBase64Url(parts[1])) as JwtPayload
  } catch {
    return null
  }
}

export function getTokenExpiryMs(token: string | null | undefined): number | null {
  const payload = decodeToken(token)
  if (!payload?.exp || typeof payload.exp !== 'number') return null
  return payload.exp * 1000
}

export function isTokenExpired(token: string | null | undefined, now = Date.now()): boolean {
  const expiryMs = getTokenExpiryMs(token)
  if (!expiryMs) return true
  return expiryMs <= now
}

export function clearAuthStorage(): void {
  AUTH_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key))
}
