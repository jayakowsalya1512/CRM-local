import api from '@/services/api'
import { vEmail, vMobile } from '@/utils/validation'

export function buildFilePreviewUrl(rawPath: string, endpoint: '/preview/file' | '/preview/download' = '/preview/file'): string {
  if (!rawPath) return ''
  const envBase: string = (import.meta as any).env?.VITE_API_BASE_URL || ''
  const axiosBase: string = (api.defaults?.baseURL as string) || ''
  const apiBase = (envBase || axiosBase || `${window.location.origin}/api/v1`).replace(/\/$/, '')
  const filePath = rawPath.startsWith('http') ? new URL(rawPath).pathname : rawPath
  const token = localStorage.getItem('access_token') || localStorage.getItem('token') || ''
  const tenant = localStorage.getItem('tenant_slug') || ''
  const params = new URLSearchParams({ path: filePath })
  if (token) params.set('token', token)
  if (tenant) params.set('tenant', tenant)
  return `${apiBase}${endpoint}?${params.toString()}`
}

// Mirrors backend `_validate_answer` so the user sees the exact problem while typing,
// instead of only finding out after a failed save round-trip.
export function validateAnswerClient(inputType: string, isRequired: boolean, value: string): string | null {
  if (isRequired && !value.trim()) return 'This field is required'
  if (!value.trim()) return null
  const v = value.trim()

  switch (inputType) {
    case 'number':
      if (!/^-?\d+$/.test(v)) return 'Must be a whole number'
      break
    case 'decimal':
    case 'currency':
      if (isNaN(Number(v))) return 'Must be a number'
      break
    case 'percentage': {
      const n = Number(v)
      if (isNaN(n)) return 'Must be a number'
      if (n < 0 || n > 100) return 'Must be between 0 and 100'
      break
    }
    case 'date': {
      if (isNaN(new Date(v).getTime())) return 'Must be a valid date'
      const y = Number(v.slice(0, 4))
      if (/^\d{4}-/.test(v) && (y < 1900 || y > 2100)) return 'Date must be between 1900 and 2100'
      break
    }
    case 'year':
      if (!/^\d{4}$/.test(v)) return 'Must be a valid 4-digit year'
      if (Number(v) < 1900 || Number(v) > 2100) return 'Year must be between 1900 and 2100'
      break
    case 'time':
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return 'Must be a valid time (HH:MM)'
      break
    case 'email':
      return vEmail(v) || null
    case 'mobile':
      return vMobile(v.replace(/[\s-]/g, '').replace(/^\+91/, ''), 'Mobile number') || null
    case 'text':
      if (v.length > 5000) return 'Must be at most 5000 characters'
      break
    case 'textarea':
      if (v.length > 20000) return 'Must be at most 20000 characters'
      break
    case 'rating': {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 5) return 'Must be between 1 and 5'
      break
    }
    case 'checkbox':
      if (v !== 'true' && v !== 'false') return 'Invalid value'
      break
    default:
      break
  }
  return null
}

// Backend validation failures can arrive in a few shapes — a plain string, {errors: [...]},
// or FastAPI's own pydantic-level {detail: [{msg, loc}, ...]} — always surface the real reason.
export function extractSaveErrorMessage(e: unknown): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray((detail as any)?.errors) && (detail as any).errors.length) {
    return (detail as any).errors.join('; ')
  }
  if (Array.isArray(detail) && detail.length) {
    return detail
      .map((item) => (typeof item === 'string' ? item : (item as { msg?: string })?.msg))
      .filter(Boolean)
      .join('; ') || 'Save failed'
  }
  return 'Save failed'
}

export const INPUT_TYPES = [
  { value: 'yes_no', label: 'Yes / No' },
  { value: 'yes_no_na', label: 'Yes / No / Unknown / N/A' },
  { value: 'yes_no_direct', label: 'Direct Yes / No' },
  { value: 'yes_no_conditional', label: 'Conditional Yes / No' },
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Textarea' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'rating', label: 'Rating (Stars)' },
  { value: 'number', label: 'Number' },
  { value: 'decimal', label: 'Decimal' },
  { value: 'percentage', label: 'Percentage' },
  { value: 'currency', label: 'Currency' },
  { value: 'date', label: 'Date' },
  { value: 'year', label: 'Year' },
  { value: 'time', label: 'Time' },
  { value: 'email', label: 'Email' },
  { value: 'mobile', label: 'Mobile Number' },
  { value: 'single_select', label: 'Single Select' },
  { value: 'multi_select', label: 'Multi Select' },
  { value: 'file', label: 'File Upload' },
]

// Older rows saved before Direct/Conditional existed used the plain 'yes_no' value,
// which behaved like today's Conditional Yes / No (it always showed the field groups).
export function isYesNoAnswerType(inputType: string): boolean {
  return inputType === 'yes_no' || inputType === 'yes_no_direct' || inputType === 'yes_no_conditional'
}

// A field whose type is one of these two IS the question's own answer (chosen from the
// same Type dropdown as any other field) rather than a plain supplementary field.
export function isAnswerMarkerType(inputType: string): boolean {
  return inputType === 'yes_no_direct' || inputType === 'yes_no_conditional'
}

export const MASTER_KEYS = [
  { value: 'customer_categories', label: 'Customer Categories' },
  { value: 'states', label: 'States' },
  { value: 'district', label: 'District' },
  { value: 'service_types', label: 'Service Types' },
  { value: 'contract_types', label: 'Contract Types' },
]

export type FormState = {
  element_code: string
  element_label: string
  input_type: string
  is_required: boolean
  allow_remarks: boolean
  display_order: number
  placeholder: string
  default_value: string
  validationText: string
  crmNote: string
  show_when_operator: string
  show_when_value: string
  optionsSource: 'custom' | 'master'
  optionsText: string
  masterKey: string
  is_active: boolean
}

export function blankForm(order = 1): FormState {
  return {
    element_code: '',
    element_label: '',
    input_type: 'text',
    is_required: false,
    allow_remarks: false,
    display_order: order,
    placeholder: '',
    default_value: '',
    validationText: '',
    crmNote: '',
    show_when_operator: '',
    show_when_value: '',
    optionsSource: 'custom',
    optionsText: '',
    masterKey: 'customer_categories',
    is_active: true,
  }
}

export function inputLabel(value?: string) {
  return INPUT_TYPES.find((item) => item.value === value)?.label || value || 'Text'
}

export function buildValidationJson(validationText: string, crmNote: string) {
  const text = validationText.trim()
  const note = crmNote.trim()
  let parsed: unknown = null

  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { rule: text }
    }
  }

  if (!note) return parsed
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ...(parsed as Record<string, unknown>), crm_note: note }
  }
  return { value: parsed, crm_note: note }
}

export function decodeValidation(value: unknown) {
  if (!value) return { validationText: '', crmNote: '' }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = { ...(value as Record<string, unknown>) }
    const crmNote = typeof obj.crm_note === 'string' ? obj.crm_note : ''
    delete obj.crm_note
    return {
      validationText: Object.keys(obj).length ? JSON.stringify(obj, null, 2) : '',
      crmNote,
    }
  }

  return { validationText: JSON.stringify(value, null, 2), crmNote: '' }
}

export function buildOptionsJson(form: { optionsSource: 'custom' | 'master'; optionsText: string; masterKey: string }): unknown {
  if (form.optionsSource === 'master') return { source_type: 'master', master_key: form.masterKey }
  const lines = form.optionsText.split('\n').map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return null

  return lines.map((line) => {
    const [label, value] = line.split('|')
    const optionLabel = (label || '').trim()
    return { label: optionLabel, value: (value ?? optionLabel).trim() }
  })
}
