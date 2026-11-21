import { useEffect } from 'react'
import { useAuthStore, useThemeStore } from '@/store'
import { buildApiAssetUrl, themeApi } from '@/services/api'
import { normalizeDateFormat, setActiveDateFormat } from '@/utils/date'

export interface ThemeSettings {
  theme_primary?: string
  theme_secondary?: string
  theme_accent?: string
  theme_sidebar?: string
  theme_success?: string
  theme_warning?: string
  theme_danger?: string
  theme_font?: string
  theme_font_size?: string | number
  company_name?: string
  theme_logo?: string
  theme_logo_version?: string
  company_logo?: string
  primary_color?: string
  secondary_color?: string
  accent_color?: string
  sidebar_color?: string
  success_color?: string
  warning_color?: string
  danger_color?: string
  font_family?: string
  font_size?: string | number
  logo_url?: string
  date_format?: 'DD-MM-YYYY' | 'MM-DD-YYYY' | 'YYYY-MM-DD'
}

interface ApplyThemeOptions {
  persist?: boolean
  tenantSlug?: string | null
}

const LOCAL_UI_FONT_FALLBACK = "'Inter', 'Roboto', 'Open Sans', sans-serif"
const LOCAL_THEME_FONTS = [
  'Inter',
  'Rubik',
  'Manrope',
  'Roboto',
  'Nunito Sans',
  'Nunito',
  'Poppins',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Lexend Deca',
]
const LOCAL_THEME_FONT_SET = new Set(LOCAL_THEME_FONTS)
const DEFAULT_COMPANY_NAME = 'AZCENTRIX'
const TAB_TITLE = 'AZCENTRIX'
const DEFAULT_FAVICON_URL = '/favicon.png?v=20260605-2'
const DEFAULT_THEME_FONT_SIZE = 16
const MIN_THEME_FONT_SIZE = 12
const MAX_THEME_FONT_SIZE = 24

const resolveTenantSlug = (tenantSlug?: string | null) =>
  tenantSlug ?? localStorage.getItem('tenant_slug')

function devLog(message: string) {
  if (import.meta.env.DEV) {
    console.debug(message)
  }
}

const getThemeCacheKey = (tenantSlug?: string | null) => {
  const slug = resolveTenantSlug(tenantSlug)
  return slug ? `crm_theme:${slug}` : null
}

const unwrapSettingValue = (value: unknown) => (
  value && typeof value === 'object' && !Array.isArray(value) && 'value' in value
    ? (value as { value?: unknown }).value
    : value
)

const getSettingsPayload = (data: unknown) => {
  if (!data || typeof data !== 'object') return {}
  if (!Array.isArray(data) && 'settings' in data && data.settings && typeof data.settings === 'object') {
    return data.settings
  }
  if (!Array.isArray(data) && 'data' in data && data.data && typeof data.data === 'object') {
    return data.data
  }
  return data
}

const flattenSettingsPayload = (data: unknown) => {
  const source = getSettingsPayload(data)
  const flat: Record<string, any> = {}

  if (Array.isArray(source)) {
    source.forEach((item) => {
      if (!item || typeof item !== 'object' || !('key' in item)) return
      flat[String(item.key)] = unwrapSettingValue((item as { value?: unknown }).value)
    })
    return flat
  }

  Object.entries(source || {}).forEach(([key, value]) => {
    flat[key] = unwrapSettingValue(value)
  })
  return flat
}

const settingString = (value: unknown, fallback = '') => {
  const raw = unwrapSettingValue(value)
  if (raw == null) return fallback
  const text = String(raw).trim()
  return text || fallback
}

const firstSettingString = (fallback: string, ...values: unknown[]) => {
  for (const value of values) {
    const text = settingString(value)
    if (text) return text
  }
  return fallback
}

const resolveRawThemeLogo = (theme: ThemeSettings) =>
  firstSettingString('', theme.theme_logo, theme.company_logo, theme.logo_url)

const resolveCompanyName = (name?: string | null) => {
  return name?.trim() || ''
}

const normalizeThemeFontSize = (value?: string | number | null) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_THEME_FONT_SIZE
  return Math.min(MAX_THEME_FONT_SIZE, Math.max(MIN_THEME_FONT_SIZE, Math.round(parsed)))
}

const normalizeThemeFont = (font: string) =>
  LOCAL_THEME_FONT_SET.has(font) ? font : 'Inter'

const resolveThemeFontStack = (font: string) =>
  `'${normalizeThemeFont(font)}', ${LOCAL_UI_FONT_FALLBACK}`

export function buildThemeLogoUrl(theme: Pick<ThemeSettings, 'theme_logo' | 'theme_logo_version' | 'company_logo' | 'logo_url'>) {
  const rawLogo = resolveRawThemeLogo(theme)
  if (!rawLogo) return ''

  const assetUrl = buildApiAssetUrl(rawLogo)
  const version = theme.theme_logo_version?.trim()
  if (!version) return assetUrl

  try {
    const url = new URL(assetUrl, window.location.origin)
    url.searchParams.set('v', version)
    return url.toString()
  } catch {
    const separator = assetUrl.includes('?') ? '&' : '?'
    return `${assetUrl}${separator}v=${encodeURIComponent(version)}`
  }
}

function syncDocumentBranding() {
  document.title = TAB_TITLE

  const faviconLinks = document.querySelectorAll<HTMLLinkElement>("link[rel~='icon']")
  if (!faviconLinks.length) {
    const favicon = document.createElement('link')
    favicon.rel = 'icon'
    favicon.type = 'image/png'
    favicon.href = DEFAULT_FAVICON_URL
    document.head.appendChild(favicon)
    return
  }

  faviconLinks.forEach((favicon) => {
    favicon.type = 'image/png'
    favicon.href = DEFAULT_FAVICON_URL
  })
}

export function applyTheme(t: ThemeSettings, options: ApplyThemeOptions = {}) {
  const root = document.documentElement
  const persist = options.persist ?? true
  const theme = flattenSettingsPayload(t) as ThemeSettings

  const primary = firstSettingString('#0B1F3A', theme.theme_primary, theme.primary_color)
  const secondary = firstSettingString('#1E3A5F', theme.theme_secondary, theme.secondary_color)
  const accent = firstSettingString('#3B82F6', theme.theme_accent, theme.accent_color)
  const sidebar = firstSettingString('#0F172A', theme.theme_sidebar, theme.sidebar_color)
  const success = firstSettingString('#059669', theme.theme_success, theme.success_color)
  const warning = firstSettingString('#D97706', theme.theme_warning, theme.warning_color)
  const danger = firstSettingString('#DC2626', theme.theme_danger, theme.danger_color)
  const font = normalizeThemeFont(firstSettingString('Inter', theme.theme_font, theme.font_family))
  const fontSize = normalizeThemeFontSize(theme.theme_font_size ?? theme.font_size)
  const fontStack = resolveThemeFontStack(font)
  const themeLogo = resolveRawThemeLogo(theme)
  const themeLogoVersion = settingString(theme.theme_logo_version)
  const companyName = resolveCompanyName(settingString(theme.company_name))
  const dateFormat = normalizeDateFormat(settingString(theme.date_format))

  root.style.setProperty('--color-primary', primary)
  root.style.setProperty('--color-secondary', secondary)
  root.style.setProperty('--color-accent', accent)
  root.style.setProperty('--color-sidebar', sidebar)
  root.style.setProperty('--color-success', success)
  root.style.setProperty('--color-warning', warning)
  root.style.setProperty('--color-danger', danger)
  root.style.setProperty('--font-family', fontStack)
  root.style.setProperty('--font-size-base', `${fontSize}px`)

  root.style.setProperty('--color-accent-light', accent + '20')
  root.style.setProperty('--color-accent-ring', accent + '40')

  setActiveDateFormat(dateFormat)
  syncDocumentBranding()
  document.body.style.fontFamily = fontStack
  document.body.style.fontSize = '0.875rem'

  useThemeStore.getState().setTheme({
    primary_color: primary,
    secondary_color: secondary,
    accent_color: accent,
    sidebar_color: sidebar,
    success_color: success,
    warning_color: warning,
    danger_color: danger,
    font_family: font,
    company_name: companyName,
    theme_logo: themeLogo,
    theme_logo_version: themeLogoVersion,
    logo_url: themeLogo,
    font_size: String(fontSize),
    date_format: dateFormat,
  })

  if (!persist) return

  try {
    const cacheKey = getThemeCacheKey(options.tenantSlug)
    if (!cacheKey) return

    localStorage.setItem(cacheKey, JSON.stringify({
      theme_primary: primary,
      theme_secondary: secondary,
      theme_accent: accent,
      theme_sidebar: sidebar,
      theme_success: success,
      theme_warning: warning,
      theme_danger: danger,
      theme_font: font,
      theme_font_size: String(fontSize),
      company_name: companyName,
      theme_logo: themeLogo,
      theme_logo_version: themeLogoVersion,
      company_logo: themeLogo,
      logo_url: themeLogo,
      date_format: dateFormat,
    }))
  } catch {
    // ignore localStorage errors
  }
}

export function applyThemeFromCache(tenantSlug?: string | null): boolean {
  syncDocumentBranding()

  try {
    const cacheKey = getThemeCacheKey(tenantSlug)
    if (!cacheKey) return false

    const cached = localStorage.getItem(cacheKey)
    if (cached) {
      applyTheme(JSON.parse(cached), { persist: false, tenantSlug })
      return true
    }
  } catch {
    // ignore cache parsing errors
  }
  return false
}

export function useTheme() {
  const tenantSlug = useAuthStore((state) => state.tenant_slug)

  useEffect(() => {
    const resolvedTenantSlug = resolveTenantSlug(tenantSlug)
    applyThemeFromCache(resolvedTenantSlug)
    devLog('Using cached/default settings')
    if (!resolvedTenantSlug) return

    devLog('Refreshing settings in background')
    Promise.allSettled([themeApi.getTheme(), themeApi.getSettings()])
      .then(([themeResult, settingsResult]) => {
        const nextTheme = themeResult.status === 'fulfilled'
          ? flattenSettingsPayload(themeResult.value.data)
          : {}
        if (settingsResult.status === 'fulfilled') {
          const flatSettings = flattenSettingsPayload(settingsResult.value.data)
          Object.assign(nextTheme, flatSettings)
        }

        if (!Object.keys(nextTheme).length) {
          throw themeResult.status === 'rejected' ? themeResult.reason : new Error('No theme settings returned')
        }

        applyTheme(nextTheme as ThemeSettings, { persist: true, tenantSlug: resolvedTenantSlug })
      })
      .catch(() => {
        // keep cached or default theme
      })
  }, [tenantSlug])
}
