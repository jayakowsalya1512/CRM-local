// Shared field validation for every form in the application (Customers, Contacts, Leads, Deals, Bids & Tenders,
// Quotes, Products & Price Books, Orders, Instruments, Directory …). The backend (app/core/validators.py) applies the
// same rules, so a request that bypasses the UI is rejected with the same field-level messages.
//
// Every validator returns '' when the value is valid, otherwise the message to show under the field.
// Optional fields are only validated once a value is entered; `required` adds the empty check.

export type Rule =
  | 'text' | 'name' | 'phone' | 'mobile' | 'email' | 'gstin' | 'pan' | 'pincode' | 'url'
  | 'amount' | 'percent' | 'integer' | 'date' | 'select' | 'checkbox' | 'textarea'

export interface FieldSpec {
  label: string
  rule?: Rule
  required?: boolean
  min?: number          // text: min length · amount/percent/integer: min value
  max?: number          // text: max length · amount/percent/integer: max value
  minDate?: string      // ISO yyyy-mm-dd
  maxDate?: string
  dateLabel?: { min?: string; max?: string }   // e.g. { min: 'the issue date' } → "must be on or after the issue date"
}

export type Val = string | number | boolean | null | undefined | { id?: unknown }

const str = (v: Val) => (v === null || v === undefined || typeof v === 'object' ? '' : String(v))
export const isEmpty = (v: Val) => {
  if (v === null || v === undefined || v === false) return true
  if (typeof v === 'object') return !v || (v as { id?: unknown }).id == null
  return String(v).trim() === ''
}

// ── regexes ─────────────────────────────────────────────────────────────────
export const EMAIL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._%+'-]{0,62}[A-Za-z0-9_%+'-])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/
export const PAN_RE = /^[A-Z]{3}[ABCFGHJLPT][A-Z][0-9]{4}[A-Z]$/
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
export const PINCODE_RE = /^[1-9][0-9]{5}$/
export const URL_RE = /^(https?:\/\/)?(www\.)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(:\d{2,5})?(\/[^\s]*)?$/i

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** GSTIN check character (mod-36, weights 1/2 alternating). */
export function gstinCheckChar(first14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const p = GST_CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1)
    sum += Math.floor(p / 36) + (p % 36)
  }
  return GST_CHARS[(36 - (sum % 36)) % 36]
}
const GST_STATE_OK = (code: number) => (code >= 1 && code <= 38) || code === 97 || code === 99

// ── individual validators ───────────────────────────────────────────────────
export function vRequired(v: Val, label: string, rule?: Rule): string {
  if (!isEmpty(v)) return ''
  return rule === 'select' ? `Please select ${label.toLowerCase()}.` : `${label} is required.`
}

/** Indian mobile number: exactly 10 digits starting with 6–9. */
export function vMobile(raw: Val, label = 'Phone number'): string {
  const s = str(raw).trim()
  if (!s) return ''
  if (!/^\d+$/.test(s)) return 'Only numbers are allowed.'
  if (s.length > 10) return 'Maximum 10 digits allowed.'
  if (s.length < 10) return `${label} must contain exactly 10 digits.`
  if (!/^[6-9]/.test(s)) return `${label} must start with 6, 7, 8 or 9.`
  return ''
}
/** Landline / office number: 10 digits (STD code + number), digits only. */
export function vPhone(raw: Val, label = 'Phone number'): string {
  const s = str(raw).trim()
  if (!s) return ''
  if (!/^\d+$/.test(s)) return 'Only numbers are allowed.'
  if (s.length > 10) return 'Maximum 10 digits allowed.'
  if (s.length < 10) return `${label} must contain exactly 10 digits.`
  return ''
}
export function vEmail(raw: Val): string {
  const s = str(raw).trim()
  if (!s) return ''
  if (s.length > 254) return 'Email address is too long.'
  if (!EMAIL_RE.test(s) || s.includes('..')) return 'Enter a valid email address (e.g. user@example.com).'
  return ''
}
export function vPan(raw: Val): string {
  const s = str(raw).trim().toUpperCase()
  if (!s) return ''
  if (s.length !== 10) return 'PAN must be exactly 10 characters.'
  if (!PAN_RE.test(s)) return 'Enter a valid PAN (e.g. ABCPE1234F).'
  return ''
}
export function vGstin(raw: Val): string {
  const s = str(raw).trim().toUpperCase()
  if (!s) return ''
  if (s.length !== 15) return 'GSTIN must be exactly 15 characters.'
  if (!GSTIN_RE.test(s)) return 'Enter a valid GSTIN (e.g. 27AAPFU0939F1ZV).'
  if (!GST_STATE_OK(Number(s.slice(0, 2)))) return 'GSTIN state code (first 2 digits) is not valid.'
  if (!PAN_RE.test(s.slice(2, 12))) return 'GSTIN characters 3–12 must be a valid PAN.'
  if (gstinCheckChar(s.slice(0, 14)) !== s[14]) return 'GSTIN checksum is invalid – please re-check the number.'
  return ''
}
export function vPincode(raw: Val): string {
  const s = str(raw).trim()
  if (!s) return ''
  if (!/^\d+$/.test(s)) return 'Only numbers are allowed.'
  if (s.length !== 6) return 'Pincode must be exactly 6 digits.'
  if (!PINCODE_RE.test(s)) return 'Pincode cannot start with 0.'
  return ''
}
export function vUrl(raw: Val): string {
  const s = str(raw).trim()
  if (!s) return ''
  if (s.length > 255) return 'Website URL is too long.'
  if (!URL_RE.test(s)) return 'Enter a valid website URL (e.g. https://www.example.com).'
  return ''
}
export function vName(raw: Val, label = 'Name', min = 2, max = 200): string {
  const s = str(raw)
  if (!s) return ''
  if (!s.trim()) return `${label} cannot be blank or only spaces.`
  return vText(s, label, min, max)
}
export function vText(raw: Val, label: string, min?: number, max?: number): string {
  const s = str(raw)
  if (!s) return ''
  const t = s.trim()
  if (!t) return `${label} cannot be blank or only spaces.`
  if (min && t.length < min) return `${label} must be at least ${min} characters.`
  if (max && t.length > max) return `${label} cannot exceed ${max} characters.`
  return ''
}
export function vAmount(raw: Val, label = 'Amount', min = 0, max = 1e13): string {
  const s = str(raw).trim()
  if (!s) return ''
  if (!/^-?\d*\.?\d+$/.test(s.replace(/,/g, ''))) return `${label} must be a valid number.`
  const n = Number(s.replace(/,/g, ''))
  if (!Number.isFinite(n)) return `${label} must be a valid number.`
  if (n < min) return min === 0 ? `${label} cannot be negative.` : `${label} must be at least ${min}.`
  if (n > max) return `${label} cannot exceed ${max.toLocaleString('en-IN')}.`
  if (/\.\d{3,}$/.test(s)) return `${label} can have at most 2 decimal places.`
  return ''
}
export function vInteger(raw: Val, label = 'Value', min = 0, max = Number.MAX_SAFE_INTEGER): string {
  const s = str(raw).trim()
  if (!s) return ''
  if (!/^-?\d+$/.test(s)) return `${label} must be a whole number.`
  const n = Number(s)
  if (n < min) return min === 0 ? `${label} cannot be negative.` : `${label} must be at least ${min}.`
  if (n > max) return `${label} cannot exceed ${max}.`
  return ''
}
export function vPercent(raw: Val, label = 'Percentage'): string {
  const s = str(raw).trim()
  if (!s) return ''
  const n = Number(s)
  if (!/^-?\d*\.?\d+$/.test(s) || !Number.isFinite(n)) return `${label} must be a valid number.`
  if (n < 0 || n > 100) return `${label} must be between 0 and 100.`
  return ''
}
export function vDate(raw: Val, label = 'Date', o: Pick<FieldSpec, 'minDate' | 'maxDate' | 'dateLabel'> = {}): string {
  const s = str(raw).trim()
  if (!s) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return `${label} is not a valid date.`
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return `${label} is not a valid date.`
  if (y < 1900 || y > 2100) return `${label} must be between 1900 and 2100.`
  const day = s.slice(0, 10)
  if (o.minDate && day < o.minDate.slice(0, 10)) return `${label} must be on or after ${o.dateLabel?.min || fmtDay(o.minDate)}.`
  if (o.maxDate && day > o.maxDate.slice(0, 10)) return `${label} must be on or before ${o.dateLabel?.max || fmtDay(o.maxDate)}.`
  return ''
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmtDay = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d} ${MON[Number(m) - 1]} ${y}` }
export const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

// ── rule dispatch ───────────────────────────────────────────────────────────
const TEXT_MAX: Partial<Record<Rule, number>> = { text: 200, name: 200, textarea: 5000 }

/** Validate one value against its spec; returns '' or the message. */
export function validate(value: Val, spec: FieldSpec): string {
  const { label, rule = 'text', required } = spec
  if (required) { const r = vRequired(value, label, rule); if (r) return r }
  if (isEmpty(value)) return ''
  switch (rule) {
    case 'mobile': return vMobile(value, label)
    case 'phone': return vPhone(value, label)
    case 'email': return vEmail(value)
    case 'gstin': return vGstin(value)
    case 'pan': return vPan(value)
    case 'pincode': return vPincode(value)
    case 'url': return vUrl(value)
    case 'amount': return vAmount(value, label, spec.min ?? 0, spec.max ?? 1e13)
    case 'integer': return vInteger(value, label, spec.min ?? 0, spec.max)
    case 'percent': return vPercent(value, label)
    case 'date': return vDate(value, label, spec)
    case 'name': return vName(value, label, spec.min ?? 2, spec.max ?? TEXT_MAX.name)
    case 'text': case 'textarea': return vText(value, label, spec.min, spec.max ?? TEXT_MAX[rule])
    default: return ''
  }
}

/**
 * Infer the rule for a field from its id / label / input type – used for generic and tenant custom fields
 * (Form Builder) so a field called "GSTIN", "Mobile", "Pincode" etc. gets the right check automatically.
 */
export function inferRule(id: string, label = '', type = 'text'): Rule {
  const k = `${id} ${label}`.toLowerCase()
  if (type === 'email' || /\be-?mail\b/.test(k)) return 'email'
  if (/\bgst(in)?\b|gst_number|gst number/.test(k)) return 'gstin'
  if (/\bpan\b|pan_number/.test(k)) return 'pan'
  if (/pin ?code|\bpin\b|postal|zip/.test(k)) return 'pincode'
  if (type === 'url' || /website|\burl\b/.test(k)) return 'url'
  if (type === 'phone' || type === 'tel' || /mobile|phone|\bcell\b|whatsapp/.test(k)) return /office|landline|\bfax\b/.test(k) ? 'phone' : 'mobile'
  if (type === 'date') return 'date'
  if (type === 'select') return 'select'
  if (type === 'checkbox') return 'checkbox'
  if (/percent|\b%|_pct\b|\bpct\b|discount %|gst %/.test(k)) return 'percent'
  if (type === 'number' || /amount|price|cost|₹/.test(k)) return 'amount'
  if (type === 'textarea') return 'textarea'
  return 'text'
}

/** Validate a map of values against a map of specs → { field: message } (only invalid fields). */
export function validateAll<K extends string>(values: Partial<Record<K, Val>>, specs: Partial<Record<K, FieldSpec>>): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {}
  for (const k of Object.keys(specs) as K[]) {
    const m = validate(values[k], specs[k]!)
    if (m) out[k] = m
  }
  return out
}

// ── server errors ───────────────────────────────────────────────────────────
const clean = (m: unknown) => String(m ?? '').replace(/^Value error, /, '').replace(/^Assertion failed, /, '')

/**
 * Field-level errors returned by the API (FastAPI 422 `detail` list or our `field_errors` map), keyed by the
 * request field name (e.g. `gst_number`, `custom_data.vendor_code`, `contacts.0.mobile`).
 */
export function apiFieldErrors(e: any): Record<string, string> {
  const data = e?.response?.data
  const out: Record<string, string> = {}
  if (data?.field_errors && typeof data.field_errors === 'object') {
    for (const [k, m] of Object.entries(data.field_errors)) out[k] = clean(m)
  }
  const d = data?.detail
  if (Array.isArray(d)) {
    for (const it of d) {
      const loc: unknown[] = Array.isArray(it?.loc) ? it.loc.filter((x: unknown) => x !== 'body') : []
      if (loc.length && !out[loc.join('.')]) out[loc.join('.')] = clean(it?.msg)
    }
  } else if (d && typeof d === 'object' && typeof d.field === 'string') {
    out[d.field] = clean(d.message ?? d.msg)
  }
  return out
}

/**
 * Map API field errors onto form field ids. `map` translates request keys to form ids
 * (`{ gst_number: 'gst', custom_data: 'cf_' }` – a value ending in `_` is used as a prefix for nested keys).
 */
export function mapApiErrors(e: any, map: Record<string, string> = {}): Record<string, string> {
  const raw = apiFieldErrors(e), out: Record<string, string> = {}
  for (const [k, m] of Object.entries(raw)) {
    const [head, ...rest] = k.split('.')
    const to = map[k] ?? map[head]
    if (to && to.endsWith('_') && rest.length) out[`${to}${rest.join('.')}`] = m
    else out[to ?? k] = m
  }
  return out
}

/** Scroll to and focus the first invalid element among `order` (form ids), using a refs map or element ids. */
export function focusFirst(order: string[], bad: Record<string, string> | Set<string>, find: (id: string) => HTMLElement | null | undefined) {
  const has = (id: string) => (bad instanceof Set ? bad.has(id) : !!bad[id])
  const id = order.find(has)
  if (!id) return
  const el = find(id)
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); try { el.focus({ preventScroll: true }) } catch { el.focus() } }
}
