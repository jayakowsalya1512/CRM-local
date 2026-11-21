import { useThemeStore } from '@/store'

export type TenantDateFormat = 'DD-MM-YYYY' | 'MM-DD-YYYY' | 'YYYY-MM-DD'

export const DEFAULT_DATE_FORMAT: TenantDateFormat = 'DD-MM-YYYY'

const DATE_KEYS = [
  'date',
  'day',
  'dob',
  'created',
  'updated',
  'published',
  'submitted',
  'follow_up',
  'timeline',
  'expiry',
  'issued',
  'valid_from',
  'release',
  'renewal',
  'converted',
  'lost',
  'claim',
  'travel',
  'return',
  'delivery',
  'installation',
  'completion',
  'warranty',
  'activity',
  'payment',
  'result',
  'auth',
]

const DATE_OUTPUT_OPTIONS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
}

const DEFAULT_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
}

const DATE_OPTION_KEYS = [
  'calendar',
  'dateStyle',
  'day',
  'era',
  'month',
  'numberingSystem',
  'timeZone',
  'weekday',
  'year',
] as const

const PRIMARY_DATE_OPTION_KEYS = [
  'dateStyle',
  'day',
  'era',
  'month',
  'weekday',
  'year',
] as const

const TIME_OPTION_KEYS = [
  'calendar',
  'dayPeriod',
  'fractionalSecondDigits',
  'hour',
  'hour12',
  'hourCycle',
  'minute',
  'numberingSystem',
  'second',
  'timeStyle',
  'timeZone',
] as const

const PRIMARY_TIME_OPTION_KEYS = [
  'dayPeriod',
  'fractionalSecondDigits',
  'hour',
  'hour12',
  'hourCycle',
  'minute',
  'second',
  'timeStyle',
] as const

const nativeToLocaleDateString = Date.prototype.toLocaleDateString
const nativeToLocaleString = Date.prototype.toLocaleString

let activeDateFormat = normalizeDateFormat(useThemeStore.getState().theme.date_format)

type SafeIntlOptions = Intl.DateTimeFormatOptions | undefined

function getDateOrder(format: TenantDateFormat) {
  if (format === 'MM-DD-YYYY') return ['month', 'day', 'year'] as const
  if (format === 'YYYY-MM-DD') return ['year', 'month', 'day'] as const
  return ['day', 'month', 'year'] as const
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function pickIntlOptions<T extends readonly string[]>(
  source: SafeIntlOptions,
  keys: T,
) {
  const result: Record<string, unknown> = {}
  if (!isPlainObject(source)) return result

  keys.forEach((key) => {
    if (source[key as keyof Intl.DateTimeFormatOptions] !== undefined) {
      result[key] = source[key as keyof Intl.DateTimeFormatOptions]
    }
  })
  return result as Intl.DateTimeFormatOptions
}

function hasAnyOption(options: SafeIntlOptions, keys: readonly string[]) {
  if (!isPlainObject(options)) return false
  return keys.some((key) => options[key as keyof Intl.DateTimeFormatOptions] !== undefined)
}

function shouldUseCustomDateFormat(locales?: Intl.LocalesArgument) {
  if (locales == null) return true

  const list = Array.isArray(locales) ? locales : [locales]
  return list.some((locale) => String(locale).toLowerCase().startsWith('en-in'))
}

function isValidDate(date: Date) {
  return Number.isFinite(date.getTime())
}

function formatDateParts(date: Date, options?: Intl.DateTimeFormatOptions) {
  const dateOptions = hasAnyOption(options, DATE_OPTION_KEYS)
    ? pickIntlOptions(options, DATE_OPTION_KEYS)
    : DATE_OUTPUT_OPTIONS

  const parts = new Intl.DateTimeFormat('en-IN', dateOptions).formatToParts(date)
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}

  parts.forEach((part) => {
    if (part.type === 'day' || part.type === 'month' || part.type === 'year' || part.type === 'weekday' || part.type === 'era') {
      values[part.type] = part.value
    }
  })

  const ordered = getDateOrder(activeDateFormat)
    .map((token) => values[token])
    .filter((token): token is string => Boolean(token))

  if (ordered.length === 0) {
    return Reflect.apply(nativeToLocaleDateString, date, ['en-IN', dateOptions]) as string
  }

  const separator = ordered.every((token) => /^\d+$/.test(token)) ? '-' : ' '
  let output = ordered.join(separator)

  if (values.weekday) output = `${values.weekday}, ${output}`
  if (values.era) output = `${output} ${values.era}`

  return output
}

function formatTimeParts(date: Date, options?: Intl.DateTimeFormatOptions) {
  const timeOptions = hasAnyOption(options, TIME_OPTION_KEYS)
    ? pickIntlOptions(options, TIME_OPTION_KEYS)
    : DEFAULT_TIME_OPTIONS

  if (!hasAnyOption(timeOptions, PRIMARY_TIME_OPTION_KEYS)) return ''
  return new Intl.DateTimeFormat('en-IN', timeOptions).format(date)
}

function hasDateComponent(options?: Intl.DateTimeFormatOptions) {
  return hasAnyOption(options, PRIMARY_DATE_OPTION_KEYS)
}

function hasTimeComponent(options?: Intl.DateTimeFormatOptions) {
  return hasAnyOption(options, PRIMARY_TIME_OPTION_KEYS)
}

export function normalizeDateFormat(value?: string | null): TenantDateFormat {
  if (value === 'MM-DD-YYYY' || value === 'YYYY-MM-DD') return value
  return DEFAULT_DATE_FORMAT
}

export function setActiveDateFormat(value?: string | null) {
  activeDateFormat = normalizeDateFormat(value)
}

export function getActiveDateFormat() {
  return activeDateFormat
}

export function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date) return isValidDate(value) ? value : null
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  if (!trimmed) return null

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00` : trimmed
  const parsed = new Date(normalized)
  return isValidDate(parsed) ? parsed : null
}

export function isDateColumnKey(key?: string) {
  if (!key) return false
  const normalized = key.toLowerCase()
  return DATE_KEYS.some((token) => normalized.includes(token))
}

export function isDateLikeValue(value: unknown, key?: string) {
  if (value instanceof Date) return isValidDate(value)
  if (typeof value !== 'string') return false
  if (!value.trim()) return false

  const looksLikeIsoDate = /^\d{4}-\d{2}-\d{2}(?:[t\s].*)?$/i.test(value.trim())
  if (looksLikeIsoDate) return true

  return isDateColumnKey(key) && Boolean(parseDateValue(value))
}

export function formatDateValue(
  value: unknown,
  options?: Intl.DateTimeFormatOptions,
  fallback = '-',
) {
  const date = parseDateValue(value)
  if (!date) return value == null || value === '' ? fallback : String(value)
  return formatDateParts(date, options)
}

export function formatDateTimeValue(
  value: unknown,
  options?: Intl.DateTimeFormatOptions,
  fallback = '-',
) {
  const date = parseDateValue(value)
  if (!date) return value == null || value === '' ? fallback : String(value)

  const wantsDate = hasDateComponent(options) || !hasTimeComponent(options)
  const wantsTime = hasTimeComponent(options) || !hasDateComponent(options)

  const datePart = wantsDate ? formatDateParts(date, wantsDate ? options : undefined) : ''
  const timePart = wantsTime ? formatTimeParts(date, options) : ''

  if (datePart && timePart) return `${datePart}, ${timePart}`
  return datePart || timePart || fallback
}

export function formatTableDateValue(value: unknown, key?: string) {
  return isDateLikeValue(value, key) ? formatDateValue(value) : String(value ?? '')
}

export function installDateFormattingPatch() {
  const proto = Date.prototype as Date & { __crmDateFormatPatched__?: boolean }
  if (proto.__crmDateFormatPatched__) return

  Object.defineProperty(Date.prototype, 'toLocaleDateString', {
    configurable: true,
    writable: true,
    value: function toLocaleDateStringPatched(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      if (!shouldUseCustomDateFormat(locales)) {
        return Reflect.apply(nativeToLocaleDateString, this, [locales, options]) as string
      }

      const date = this instanceof Date ? this : new Date(this)
      if (!isValidDate(date)) {
        return Reflect.apply(nativeToLocaleDateString, this, [locales, options]) as string
      }

      return formatDateParts(date, options)
    },
  })

  Object.defineProperty(Date.prototype, 'toLocaleString', {
    configurable: true,
    writable: true,
    value: function toLocaleStringPatched(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      if (!shouldUseCustomDateFormat(locales)) {
        return Reflect.apply(nativeToLocaleString, this, [locales, options]) as string
      }

      const date = this instanceof Date ? this : new Date(this)
      if (!isValidDate(date)) {
        return Reflect.apply(nativeToLocaleString, this, [locales, options]) as string
      }

      return formatDateTimeValue(date, options, Reflect.apply(nativeToLocaleString, this, [locales, options]) as string)
    },
  })

  proto.__crmDateFormatPatched__ = true
}

installDateFormattingPatch()
