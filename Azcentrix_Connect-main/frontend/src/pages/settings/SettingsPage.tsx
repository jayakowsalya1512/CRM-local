
import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import { Palette, Bell, Building2, Shield, Save, Eye, EyeOff, Trash2, X, ExternalLink, Plus, MapPin, ChevronDown, RefreshCw, ClipboardCheck, Clock3, Tag, Wand2 } from 'lucide-react'
import api, { authApi, themeApi, approvalWorkflowApi } from '@/services/api'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import DropFileUpload from '@/components/ui/DropFileUpload'
import { PageHeader, useToast, FormSection, FormGrid } from '@/components/ui/FormComponents'
import { applyTheme, buildThemeLogoUrl } from '@/hooks/UseTheme'
import { useAuthStore } from '@/store'
import { useModuleLabels, useModuleName, DEFAULT_MODULE_NAMES } from '@/context/ModuleLabelsContext'
import ApprovalsTab from './ApprovalsTab'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { mapApiErrors, validate, type FieldSpec, type Val } from '@/utils/validation'
import AutoApproveTab from './AutoApproveTab'

const FONT_OPTIONS = [
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
const LOCAL_UI_FONT_FALLBACK = "'Inter', 'Roboto', 'Open Sans', sans-serif"
const FONT_OPTION_SET = new Set(FONT_OPTIONS)
const normalizeThemeFont = (font?: string) => FONT_OPTION_SET.has(font || '') ? String(font) : 'Inter'
const getFontStack = (font?: string) => `'${normalizeThemeFont(font)}', ${LOCAL_UI_FONT_FALLBACK}`
const DEFAULT_THEME_FONT_SIZE = 16
const MIN_THEME_FONT_SIZE = 12
const MAX_THEME_FONT_SIZE = 24

const THEME_PRESETS = [
  { name: 'Ocean Blue', primary: '#0B1F3A', secondary: '#1E3A5F', accent: '#3B82F6', sidebar: '#0F172A', success: '#059669', warning: '#D97706', danger: '#DC2626' },
  { name: 'Emerald', primary: '#064E3B', secondary: '#065F46', accent: '#10B981', sidebar: '#022C22', success: '#059669', warning: '#D97706', danger: '#DC2626' },
  { name: 'Royal Purple', primary: '#3B0764', secondary: '#581C87', accent: '#8B5CF6', sidebar: '#1E0533', success: '#059669', warning: '#D97706', danger: '#DC2626' },
  { name: 'Crimson', primary: '#450A0A', secondary: '#7F1D1D', accent: '#EF4444', sidebar: '#1C0808', success: '#059669', warning: '#D97706', danger: '#EF4444' },
  { name: 'Slate', primary: '#0F172A', secondary: '#1E293B', accent: '#6366F1', sidebar: '#020617', success: '#059669', warning: '#D97706', danger: '#DC2626' },
  { name: 'Teal', primary: '#042F2E', secondary: '#134E4A', accent: '#14B8A6', sidebar: '#021A19', success: '#059669', warning: '#D97706', danger: '#DC2626' },
  { name: 'Amber', primary: '#451A03', secondary: '#78350F', accent: '#F59E0B', sidebar: '#1C0A00', success: '#059669', warning: '#F59E0B', danger: '#DC2626' },
  { name: 'Rose', primary: '#4C0519', secondary: '#881337', accent: '#F43F5E', sidebar: '#200008', success: '#059669', warning: '#D97706', danger: '#F43F5E' },
]

const SETTINGS_SAVE_EXCLUDE_KEYS = new Set([
  'theme_logo',
  'company_logo',
  'logo_url',
  'theme_logo_version',
  'letter_pad_seal',
  'max_users',
  'active_user_count',
  'company_mail',
  'address',
  'street_address',
  'pincode',
  'country',
  'state',
  'city_district',
  'area_locality',
])

const FISCAL_YEAR_OPTIONS = ['01', '02', '03', '04', '07', '10'].map((value) => ({
  value,
  label: new Date(2024, Number.parseInt(value, 10) - 1, 1).toLocaleString('en', { month: 'long' }),
}))

const MINUTES_PER_DAY = 24 * 60

type SmtpProvider = 'google' | 'microsoft' | 'zoho' | 'custom'
type SmtpSecurity = 'TLS' | 'SSL'
type LeadNotificationRecipientKey = 'assigned_user' | 'manager' | 'admin' | 'ceo'
type LeadNotificationEventKey =
  | 'new_lead'
  | 'lead_assignment'
  | 'status_qualified'
  | 'status_won'
  | 'status_lost'
  | 'high_priority_lead'
type CompanyAddress = {
  id?: number
  label: string
  street_address: string
  pincode: string
  area_locality: string
  city_district: string
  state: string
  country: string
  is_primary: boolean
  is_active: boolean
  sort_order: number
}
type NotificationOption = {
  key: string
  label: string
}
type NotificationEventItem = {
  id: number
  module_key: string
  module_label: string
  event_key: string
  label: string
  category: string
  description?: string | null
  default_action?: string | null
  is_system: boolean
  is_active: boolean
}
type NotificationRuleItem = {
  event_definition_id: number
  module_key?: string | null
  event_key?: string | null
  recipients: string[]
  available_linked_resolvers: string[]
  linked_users: boolean
  manager: boolean
  admin: boolean
  ceo: boolean
  condition_json?: Record<string, any> | null
  is_active: boolean
  recipient_types: string[]
  role_keys: string[]
  specific_user_ids: number[]
  record_field_name?: string | null
}
type NotificationTemplateItem = {
  event_definition_id: number
  module_key?: string | null
  event_key?: string | null
  subject_template?: string | null
  body_template?: string | null
  html_template?: string | null
  action_url_template?: string | null
  is_active: boolean
}
type NotificationEventsResponse = {
  modules: NotificationOption[]
  recipient_types: NotificationOption[]
  role_options: NotificationOption[]
  ui_recipient_columns?: NotificationOption[]
  events: NotificationEventItem[]
}
type NotificationUser = {
  id: number
  username: string
  email: string
  full_name: string
  role: string
  is_active: boolean
}

const DEFAULT_NOTIFICATION_MODULES: NotificationOption[] = [
  { key: 'leads', label: 'Leads' },
  { key: 'tenders', label: 'Tenders' },
  { key: 'workorders', label: 'Work Orders' },
  { key: 'emdbg', label: 'EMD/BG' },
  { key: 'customers', label: 'Customers' },
]

const SMTP_PROVIDER_OPTIONS: { value: SmtpProvider; label: string }[] = [
  { value: 'google', label: 'Google' },
  { value: 'microsoft', label: 'Microsoft' },
  { value: 'zoho', label: 'Zoho' },
  { value: 'custom', label: 'Custom' },
]

const SMTP_SECURITY_OPTIONS: { value: SmtpSecurity; label: string }[] = [
  { value: 'TLS', label: 'TLS' },
  { value: 'SSL', label: 'SSL' },
]

const LEAD_NOTIFICATION_RECIPIENTS: { key: LeadNotificationRecipientKey; label: string }[] = [
  { key: 'assigned_user', label: 'Assigned User' },
  { key: 'manager', label: 'Manager' },
  { key: 'admin', label: 'Admin' },
  { key: 'ceo', label: 'CEO' },
]

const LEAD_NOTIFICATION_DEFAULTS: Record<LeadNotificationEventKey, Record<LeadNotificationRecipientKey, 'true' | 'false'>> = {
  new_lead: {
    assigned_user: 'false',
    manager: 'false',
    admin: 'false',
    ceo: 'false',
  },
  lead_assignment: {
    assigned_user: 'true',
    manager: 'false',
    admin: 'false',
    ceo: 'false',
  },
  status_qualified: {
    assigned_user: 'true',
    manager: 'true',
    admin: 'false',
    ceo: 'false',
  },
  status_won: {
    assigned_user: 'true',
    manager: 'true',
    admin: 'true',
    ceo: 'true',
  },
  status_lost: {
    assigned_user: 'true',
    manager: 'true',
    admin: 'true',
    ceo: 'true',
  },
  high_priority_lead: {
    assigned_user: 'true',
    manager: 'true',
    admin: 'true',
    ceo: 'true',
  },
}

const LEAD_NOTIFICATION_EVENTS: { key: LeadNotificationEventKey; label: string; desc: string }[] = [
  { key: 'new_lead', label: 'New Lead', desc: 'Fires when a lead is first created.' },
  { key: 'lead_assignment', label: 'Lead Assignment', desc: 'Fires when the assigned user changes.' },
  { key: 'status_qualified', label: 'Status: Qualified', desc: 'Mapped to the Opportunity Created stage.' },
  { key: 'status_won', label: 'Status: Won', desc: 'Mapped to Converted after the lead becomes a tender.' },
  { key: 'status_lost', label: 'Status: Lost', desc: 'Fires when the lead is marked Lost.' },
  { key: 'high_priority_lead', label: 'High Priority Lead', desc: 'Fires when a lead is created or updated as High priority.' },
]

const leadNotificationSettingKey = (eventKey: LeadNotificationEventKey, recipientKey: LeadNotificationRecipientKey) =>
  `lead_notify_${eventKey}_${recipientKey}`

const createEmptyCompanyAddress = (index = 0, isPrimary = false): CompanyAddress => ({
  label: index === 0 ? 'Head office' : '',
  street_address: '',
  pincode: '',
  area_locality: '',
  city_district: '',
  state: '',
  country: 'India',
  is_primary: isPrimary,
  is_active: true,
  sort_order: index,
})

const SMTP_PROVIDER_DEFAULTS: Record<Exclude<SmtpProvider, 'custom'>, { host: string; port: string; security: SmtpSecurity }> = {
  google: { host: 'smtp.gmail.com', port: '587', security: 'TLS' },
  microsoft: { host: 'smtp.office365.com', port: '587', security: 'TLS' },
  zoho: { host: 'smtp.zoho.com', port: '587', security: 'TLS' },
}

const SMTP_PROVIDER_GUIDE_LINKS: Partial<Record<SmtpProvider, { href: string; label: string }>> = {
  google: { href: 'https://myaccount.google.com/apppasswords', label: 'Open Google App Passwords' },
  microsoft: { href: 'https://account.microsoft.com/security', label: 'Open Microsoft Security' },
  zoho: { href: 'https://accounts.zoho.com', label: 'Open Zoho Accounts' },
}

const unwrapSettingValue = (value: any) => (
  value && typeof value === 'object' && !Array.isArray(value) && 'value' in value
    ? value.value
    : value
)

const getSettingsPayload = (data: any) => {
  if (!data || typeof data !== 'object') return {}
  if (!Array.isArray(data) && data.settings && typeof data.settings === 'object') return data.settings
  if (!Array.isArray(data) && data.data && typeof data.data === 'object') return data.data
  return data
}

const flattenSettings = (data: Record<string, any>) => {
  const source = getSettingsPayload(data)
  const flat: Record<string, any> = {}

  if (Array.isArray(source)) {
    source.forEach((item: any) => {
      if (!item?.key) return
      flat[String(item.key)] = unwrapSettingValue(item.value)
    })
    return flat
  }

  Object.entries(source).forEach(([key, value]: any) => {
    flat[key] = unwrapSettingValue(value)
  })
  return flat
}

const normalizeBoolSetting = (value: any, fallback = 'false') =>
  String(value ?? fallback).trim().toLowerCase() === 'true' ? 'true' : 'false'

const normalizeNonNegativeDecimalSetting = (value: any, fallback = '0') => {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  const sanitized = raw.replace(/[^\d.]/g, '')
  const [wholePartRaw = '', ...decimalParts] = sanitized.split('.')
  const wholePart = wholePartRaw.replace(/^0+(?=\d)/, '') || '0'
  const decimalPart = decimalParts.join('').slice(0, 4)
  return decimalPart ? `${wholePart}.${decimalPart}` : wholePart
}

const normalizeSmtpSecurity = (value: any): SmtpSecurity =>
  String(value ?? '').trim().toUpperCase() === 'SSL' ? 'SSL' : 'TLS'

const normalizeHexColor = (value: any) => String(value ?? '').trim().toLowerCase()

const normalizeThemeFontSize = (value: any, fallback = DEFAULT_THEME_FONT_SIZE) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return String(fallback)
  return String(Math.min(MAX_THEME_FONT_SIZE, Math.max(MIN_THEME_FONT_SIZE, Math.round(parsed))))
}

const minutesToDaysSetting = (value: any, fallback = '0') => {
  const totalMinutes = Number(value)
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return fallback
  const totalDays = totalMinutes / MINUTES_PER_DAY
  if (Number.isInteger(totalDays)) return String(totalDays)
  return totalDays.toFixed(4).replace(/\.?0+$/, '') || fallback
}

const daysToMinutesSetting = (value: any, fallback = '0') => {
  const totalDays = Number(value)
  if (!Number.isFinite(totalDays) || totalDays < 0) return fallback
  return String(Math.round(totalDays * MINUTES_PER_DAY))
}

const COMPANY_ADDRESS_REQUIRED_FIELDS: Array<{ key: keyof CompanyAddress; label: string }> = [
  { key: 'label', label: 'Address label' },
  { key: 'street_address', label: 'Street address' },
  { key: 'pincode', label: 'Pincode' },
  { key: 'area_locality', label: 'Area / Locality' },
  { key: 'city_district', label: 'City / District' },
  { key: 'state', label: 'State' },
  { key: 'country', label: 'Country' },
]

const getCompanyAddressName = (address: CompanyAddress, index: number) =>
  address.label.trim() || `Address ${index + 1}`

// ── field validation (shared rules in utils/validation.ts; backend theme_router mirrors them) ──
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const HOST_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/
const THEME_COLOR_FIELDS: [string, string][] = [
  ['theme_primary', 'Primary colour'], ['theme_secondary', 'Secondary colour'], ['theme_accent', 'Accent colour'], ['theme_sidebar', 'Sidebar colour'],
  ['theme_success', 'Success colour'], ['theme_warning', 'Warning colour'], ['theme_danger', 'Danger colour'],
]
const SETTING_SPECS: Record<string, FieldSpec> = {
  company_name: { label: 'Company name', rule: 'name', min: 2, max: 200 },
  smtp_user: { label: 'SMTP user', rule: 'email' },
  smtp_host: { label: 'SMTP host', rule: 'text', max: 253 },
  smtp_port: { label: 'Port', rule: 'integer', min: 1, max: 65535 },
  travel_auto_approve_minutes: { label: 'Auto approve days', rule: 'amount', max: 365 },
  travel_request_advance_days: { label: 'Prior travel request days', rule: 'integer', min: 0, max: 30 },
  escalation_hours: { label: 'Escalation time', rule: 'amount', max: 8760 },
  ...Object.fromEntries(THEME_COLOR_FIELDS.map(([k, label]) => [k, { label, rule: 'text' as const, max: 7 }])),
}
const ADDRESS_LIMITS: Record<string, [number, number]> = {
  label: [2, 100], street_address: [5, 500], area_locality: [2, 150], city_district: [2, 100], state: [2, 100], country: [2, 100],
}
/** Which settings tab shows a field (to switch there when it is invalid). */
const settingTab = (id: string) => (id.startsWith('addr.') || id.startsWith('smtp_') || id === 'company_name' ? 'company'
  : id.startsWith('theme_') ? 'theme' : id.startsWith('travel_') ? 'notifications' : id === 'escalation_hours' ? 'security' : '')
const settingExtra = (id: string, v: Val): string => {
  const s = v == null ? '' : String(v).trim()
  if (!s) return ''
  if (id.startsWith('theme_') && !HEX_COLOR_RE.test(s)) return `${SETTING_SPECS[id]?.label || 'Colour'} must be a hex colour like #0F6E8C.`
  if (id === 'smtp_host' && !HOST_RE.test(s)) return 'Enter a valid SMTP host (e.g. smtp.gmail.com).'
  return ''
}
const addressSpec = (key: string, label: string): FieldSpec => key === 'pincode'
  ? { label, rule: 'pincode', required: true }
  : { label, rule: 'text', required: true, min: ADDRESS_LIMITS[key]?.[0], max: ADDRESS_LIMITS[key]?.[1] }

const validateCompanyAddresses = (addresses: CompanyAddress[]) => {
  for (const [index, address] of addresses.entries()) {
    const addressName = getCompanyAddressName(address, index)
    for (const field of COMPANY_ADDRESS_REQUIRED_FIELDS) {
      const value = String(address[field.key] ?? '').trim()
      if (!value) return `${addressName}: ${field.label} is required`
    }
    if (!/^\d{6}$/.test(address.pincode.trim())) {
      return `${addressName}: Pincode must be exactly 6 digits`
    }
  }
  return null
}

const normalizeCompanyAddresses = (addresses: any[]): CompanyAddress[] => {
  const rows = Array.isArray(addresses)
    ? addresses.map((item: any, index: number) => ({
        id: typeof item?.id === 'number' ? item.id : undefined,
        label: String(item?.label ?? '').trim(),
        street_address: String(item?.street_address ?? '').trim(),
        pincode: String(item?.pincode ?? '').trim(),
        area_locality: String(item?.area_locality ?? '').trim(),
        city_district: String(item?.city_district ?? '').trim(),
        state: String(item?.state ?? '').trim(),
        country: String(item?.country ?? '').trim() || 'India',
        is_primary: String(item?.is_primary ?? '').trim().toLowerCase() === 'true' || item?.is_primary === true,
        is_active: item?.is_active !== false,
        sort_order: Number.isFinite(Number(item?.sort_order)) ? Number(item.sort_order) : index,
      }))
    : []
  if (!rows.length) return []
  const primaryIndex = rows.findIndex((row) => row.is_primary)
  return rows.map((row, index) => ({
    ...row,
    is_primary: primaryIndex >= 0 ? index === primaryIndex : index === 0,
    sort_order: index,
  }))
}

const NOTIFICATION_CATEGORY_STYLES: Record<string, string> = {
  approval: 'border-amber-200 bg-amber-50 text-amber-700',
  alert: 'border-rose-200 bg-rose-50 text-rose-700',
  event: 'border-blue-200 bg-blue-50 text-blue-700',
}

const createEmptyNotificationRule = (event: NotificationEventItem): NotificationRuleItem => ({
  event_definition_id: event.id,
  module_key: event.module_key,
  event_key: event.event_key,
  recipients: [],
  available_linked_resolvers: [],
  linked_users: false,
  manager: false,
  admin: false,
  ceo: false,
  condition_json: null,
  is_active: false,
  recipient_types: [],
  role_keys: [],
  specific_user_ids: [],
  record_field_name: '',
})

const getManagedNotificationRecipients = (rule: Partial<NotificationRuleItem>) => new Set([
  ...((rule.available_linked_resolvers || []).map((recipient) => String(recipient).trim().toLowerCase()).filter(Boolean)),
  'manager',
  'role:admin',
  'role:ceo',
])

const deriveRecipientTypesFromRule = (rule: Partial<NotificationRuleItem>) => {
  if (Array.isArray(rule.recipient_types) && rule.recipient_types.length > 0) {
    return [...new Set(rule.recipient_types.map((item) => String(item).trim()).filter(Boolean))]
  }
  const managedRecipients = getManagedNotificationRecipients(rule)
  return [...new Set((rule.recipients || [])
    .map((recipient) => String(recipient).trim().toLowerCase())
    .filter((recipient) => Boolean(recipient) && !recipient.startsWith('role:') && !managedRecipients.has(recipient)))]
}

const deriveRoleKeysFromRule = (rule: Partial<NotificationRuleItem>) => {
  if (Array.isArray(rule.role_keys) && rule.role_keys.length > 0) {
    return [...new Set(rule.role_keys.map((item) => String(item).trim().toLowerCase()).filter(Boolean))]
  }
  const managedRecipients = getManagedNotificationRecipients(rule)
  return [...new Set((rule.recipients || [])
    .map((recipient) => String(recipient).trim().toLowerCase())
    .filter((recipient) => recipient.startsWith('role:') && !managedRecipients.has(recipient))
    .map((recipient) => recipient.slice(5))
    .filter(Boolean))]
}

const hydrateNotificationRules = (
  events: NotificationEventItem[],
  rules: NotificationRuleItem[],
) => {
  const ruleMap = new Map(rules.map((rule) => [rule.event_definition_id, rule]))
  return events.map((event) => {
    const existing = ruleMap.get(event.id)
    if (existing) {
      return {
        ...existing,
        module_key: event.module_key,
        event_key: event.event_key,
        recipients: [...new Set(existing.recipients || [])],
        available_linked_resolvers: [...new Set(existing.available_linked_resolvers || [])],
        linked_users: Boolean(existing.linked_users),
        manager: Boolean(existing.manager),
        admin: Boolean(existing.admin),
        ceo: Boolean(existing.ceo),
        recipient_types: deriveRecipientTypesFromRule(existing),
        role_keys: deriveRoleKeysFromRule(existing),
        specific_user_ids: [...new Set((existing.specific_user_ids || []).map((userId) => Number(userId)).filter((userId) => Number.isFinite(userId) && userId > 0))],
        record_field_name: String(existing.record_field_name || '').trim(),
      }
    }
    return createEmptyNotificationRule(event)
  })
}

const hydrateNotificationTemplates = (
  events: NotificationEventItem[],
  templates: NotificationTemplateItem[],
) => {
  const templateMap = new Map(templates.map((template) => [template.event_definition_id, template]))
  return events.map((event) => {
    const existing = templateMap.get(event.id)
    if (existing) {
      return {
        ...existing,
        module_key: event.module_key,
        event_key: event.event_key,
      }
    }
    return {
      event_definition_id: event.id,
      module_key: event.module_key,
      event_key: event.event_key,
      subject_template: '',
      body_template: '',
      html_template: '',
      action_url_template: '',
      is_active: true,
    }
  })
}

const normalizeNotificationCatalog = (catalog: NotificationEventsResponse): NotificationEventsResponse => {
  const moduleMap = new Map<string, NotificationOption>()

  DEFAULT_NOTIFICATION_MODULES.forEach((module) => {
    moduleMap.set(module.key, module)
  })

  ;(catalog.modules || []).forEach((module) => {
    if (!module?.key) return
    moduleMap.set(module.key, {
      key: String(module.key),
      label: String(module.label || module.key),
    })
  })

  ;(catalog.events || []).forEach((event) => {
    if (!event?.module_key) return
    if (!moduleMap.has(event.module_key)) {
      moduleMap.set(event.module_key, {
        key: String(event.module_key),
        label: String(event.module_label || event.module_key),
      })
    }
  })

  const moduleOrder = [
    ...DEFAULT_NOTIFICATION_MODULES.map((module) => module.key),
    ...Array.from(moduleMap.keys()).filter((key) => !DEFAULT_NOTIFICATION_MODULES.some((module) => module.key === key)),
  ]

  return {
    ...catalog,
    modules: moduleOrder
      .map((key) => moduleMap.get(key))
      .filter((module): module is NotificationOption => Boolean(module)),
  }
}

const sortNotificationRules = (rules: NotificationRuleItem[]) =>
  [...rules].sort((left, right) => {
    if (left.event_definition_id !== right.event_definition_id) return left.event_definition_id - right.event_definition_id
    return 0
  })

const getUnmanagedNotificationRecipients = (rule: NotificationRuleItem) => {
  const managedRecipients = getManagedNotificationRecipients(rule)
  return (rule.recipients || []).filter((recipient) => !managedRecipients.has(recipient))
}

const buildNotificationRecipientsForSave = (rule: NotificationRuleItem) => {
  // This screen only exposes the 4 visible recipient columns.
  // Persisting hidden resolver keys like creator/requester/customer_owner
  // causes non-lead modules to re-enable rules the user has unchecked.
  return []
}

const inferSmtpProvider = (flat: Record<string, any>): SmtpProvider => {
  const host = String(flat.smtp_host ?? '').trim().toLowerCase()
  const port = String(flat.smtp_port ?? '').trim()
  const security = normalizeSmtpSecurity(flat.smtp_security)
  if (!host && !port && !String(flat.smtp_security ?? '').trim()) return 'google'
  for (const [provider, config] of Object.entries(SMTP_PROVIDER_DEFAULTS) as Array<[Exclude<SmtpProvider, 'custom'>, { host: string; port: string; security: SmtpSecurity }]>) {
    if (host === config.host && port === config.port && security === config.security) return provider
  }
  return 'custom'
}

function GuideNote({ tone, label, text }: { tone: 'danger' | 'success' | 'warning' | 'neutral'; label: string; text: string }) {
  const toneClassName = {
    danger: 'border-red-200 bg-red-50/90 text-red-900',
    success: 'border-emerald-200 bg-emerald-50/90 text-emerald-900',
    warning: 'border-amber-200 bg-amber-50/90 text-amber-900',
    neutral: 'border-slate-200 bg-slate-50/90 text-slate-900',
  }[tone]
  return (
    <div className={`rounded-2xl border px-4 py-3 shadow-sm ${toneClassName}`}>
      <p><span className="font-semibold">{label}</span> {text}</p>
    </div>
  )
}

function GuideHero({ provider, title, summary, highlights }: { provider: string; title: string; summary: string; highlights: string[] }) {
  return (
    <section className="overflow-hidden rounded-[24px] border border-slate-200 bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.18),_transparent_38%),linear-gradient(135deg,_#f8fbff_0%,_#eef4ff_55%,_#ffffff_100%)] p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full border border-blue-200 bg-white/90 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-700">SMTP Setup Guide</span>
        <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-900 px-3 py-1 text-xs font-medium text-white">{provider}</span>
      </div>
      <div className="mt-4">
        <h4 className="text-xl font-semibold text-slate-950">{title}</h4>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{summary}</p>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {highlights.map((highlight) => (
          <div key={highlight} className="rounded-2xl border border-white/80 bg-white/80 px-3 py-2 text-sm font-medium text-slate-700 shadow-sm">{highlight}</div>
        ))}
      </div>
    </section>
  )
}

function GuideSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <h4 className="text-base font-semibold text-slate-900">{title}</h4>
      <div className="mt-3 space-y-2 text-sm leading-6 text-slate-700">{children}</div>
    </section>
  )
}

function GuideLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700">
      <span>{children}</span>
      <ExternalLink size={13} />
    </a>
  )
}

function SmtpGuideContent({ provider }: { provider: SmtpProvider }) {
  if (provider === 'google') {
    return (
      <div className="space-y-5">
        <GuideHero provider="Google" title="Google (Gmail / Google Workspace)" summary="Use a Google App Password for SMTP instead of your normal mailbox password. This is the recommended and secure setup." highlights={['2-Step Verification', 'App Password', 'Shown once only']} />
        <GuideSection title="Google (Gmail / Google Workspace)"><p>Use a Google App Password for SMTP.</p></GuideSection>
        <GuideSection title="Step 1 - Enable 2-step verification">
          <p>1. Go to <GuideLink href="https://myaccount.google.com/security">myaccount.google.com/security</GuideLink></p>
          <p>2. Find <span className="font-semibold text-slate-900">2-Step Verification</span> and turn it ON</p>
        </GuideSection>
        <GuideSection title="Step 2 - Generate an app password">
          <p>1. Go to <GuideLink href="https://myaccount.google.com/apppasswords">myaccount.google.com/apppasswords</GuideLink></p>
          <p>2. Select:</p>
          <div className="space-y-1 pl-4 text-slate-600"><p>App -&gt; Mail</p><p>Device -&gt; Other (Custom name)</p></div>
          <p>3. Enter name (e.g. CRM Application) and click Generate</p>
        </GuideSection>
        <GuideSection title="Step 3 - Copy the password">
          <p>Google will show a 16-character password.</p>
          <p>Copy it. It is shown only once.</p>
        </GuideSection>
        <GuideSection title="If password changes">
          <p>1. Delete old app password</p>
          <p>2. Generate a new one</p>
          <p>3. Update in CRM</p>
        </GuideSection>
      </div>
    )
  }
  if (provider === 'microsoft') {
    return (
      <div className="space-y-5">
        <GuideHero provider="Microsoft" title="Microsoft 365 / Outlook" summary="Use an App Password when MFA is enabled. If MFA is not enabled in your tenant, your normal mailbox password may still work." highlights={['Advanced Security', 'App Password', 'Update CRM after change']} />
        <GuideSection title="Microsoft (Outlook / Microsoft 365)"><p>If MFA is enabled, use an App Password. If not, use the normal password.</p></GuideSection>
        <GuideSection title="Steps (App Password)">
          <p>1. Go to <GuideLink href="https://account.microsoft.com/security">account.microsoft.com/security</GuideLink></p>
          <p>2. Open <span className="font-semibold text-slate-900">Advanced Security Options</span></p>
          <p>3. Find <span className="font-semibold text-slate-900">App Passwords</span></p>
          <p>4. Create new password</p>
          <p>5. Copy it</p>
        </GuideSection>
        <GuideSection title="If password changes">
          <p>Normal password - update in CRM</p>
          <p>App password - regenerate and update in CRM</p>
        </GuideSection>
      </div>
    )
  }
  if (provider === 'zoho') {
    return (
      <div className="space-y-5">
        <GuideHero provider="Zoho" title="Zoho Mail" summary="Use a Zoho App Password for SMTP so the CRM can send mail without exposing your main account password." highlights={['Zoho Accounts', 'App Password', 'Generate then save']} />
        <GuideSection title="Zoho Mail"><p>Use an App Password.</p></GuideSection>
        <GuideSection title="Steps">
          <p>1. Go to <GuideLink href="https://accounts.zoho.com">accounts.zoho.com</GuideLink></p>
          <p>2. Security -&gt; App Passwords</p>
          <p>3. Generate new password</p>
          <p>4. Name: CRM Application</p>
          <p>5. Copy it</p>
        </GuideSection>
        <GuideSection title="If password changes">
          <p>1. Delete old password</p>
          <p>2. Generate new password</p>
          <p>3. Update in CRM</p>
        </GuideSection>
      </div>
    )
  }
  return (
    <div className="space-y-5">
      <GuideHero provider="Custom" title="Custom Email / Company Domain" summary="Use the SMTP credentials provided by your hosting company, mail server, or IT team. Enter the exact host, port, security, and password they provide." highlights={['Host + Port', 'TLS / SSL', 'Provider-issued password']} />
      <GuideSection title="Custom Email (Company Domain)"><p>Use the email account password from your IT team or hosting provider.</p></GuideSection>
      <GuideSection title="Example SMTP">
        <p>Host: mail.yourdomain.com</p>
        <p>Port: 587 (TLS) or 465 (SSL)</p>
        <p>Security: TLS / SSL</p>
      </GuideSection>
      <GuideSection title="If password changes">
        <p>1. Change it in the mail server</p>
        <p>2. Update it in CRM</p>
      </GuideSection>
    </div>
  )
}

function SettingsSelectField({ label, value, options, onChange, disabled = false }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
      <select value={value || options[0]?.value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 ${disabled ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : ''}`}>
        {options.map((option) => (<option key={option.value} value={option.value}>{option.label}</option>))}
      </select>
    </div>
  )
}

function SettingsTextInput({ label, value, onChange, placeholder, type = 'text', autoComplete, readOnly = false, maxLength, inputMode, id, error, onBlur }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: 'text' | 'password' | 'email' | 'number'; autoComplete?: string; readOnly?: boolean; maxLength?: number; inputMode?: 'none' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | 'search'; id?: string; error?: string; onBlur?: () => void }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
      <input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} placeholder={placeholder} autoComplete={autoComplete} readOnly={readOnly} maxLength={maxLength} inputMode={inputMode} aria-invalid={error ? true : undefined} aria-describedby={error && id ? `${id}-err` : undefined} className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 ${readOnly ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : ''} ${error ? 'err' : ''}`} />
      <FieldError id={id} msg={error} />
    </div>
  )
}

function SettingsTextareaField({ label, value, onChange, placeholder, rows = 3, id, error, onBlur }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; rows?: number; id?: string; error?: string; onBlur?: () => void }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} placeholder={placeholder} rows={rows} aria-invalid={error ? true : undefined} aria-describedby={error && id ? `${id}-err` : undefined} className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 resize-y ${error ? 'err' : ''}`} />
      <FieldError id={id} msg={error} />
    </div>
  )
}

function CompanyAddressCard({ address, index, onChange, onRemove, onSetPrimary, errors = {}, onBlur }: { address: CompanyAddress; index: number; onChange: (key: keyof CompanyAddress, value: string | boolean) => void; onRemove: () => void; onSetPrimary: () => void; errors?: Record<string, string>; onBlur?: (key: keyof CompanyAddress) => void }) {
  const [isExpanded, setIsExpanded] = useState(true)
  const e = (k: string) => errors[`addr.${index}.${k}`]
  const fid = (k: string) => `addr-${index}-${k}`
  // an invalid field inside a collapsed card must be reachable
  const hasErr = Object.keys(errors).some(k => k.startsWith(`addr.${index}.`) && !k.endsWith('.label'))
  useEffect(() => { if (hasErr) setIsExpanded(true) }, [hasErr])
  return (
    <div className={`overflow-hidden rounded-2xl border ${address.is_primary ? 'border-blue-400 shadow-sm shadow-blue-100' : 'border-gray-200'}`}>
      <div className={`flex flex-wrap items-center gap-3 bg-gray-50 px-4 py-3 ${isExpanded ? 'border-b border-gray-100' : ''}`}>
        <button type="button" onClick={() => setIsExpanded((prev) => !prev)} aria-label={isExpanded ? 'Hide address details' : 'View address details'} className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-gray-300 bg-white text-gray-500 hover:bg-gray-50 hover:text-gray-700">
          <ChevronDown size={16} className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : 'rotate-0'}`} />
        </button>
        <div className="min-w-0 flex-1">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Address Label *</label>
          <input id={fid('label')} value={address.label} onChange={(ev) => onChange('label', ev.target.value)} onBlur={() => onBlur?.('label')} aria-invalid={e('label') ? true : undefined} placeholder={index === 0 ? 'Head office' : 'Branch / Warehouse / Office'} className={`w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:border-blue-500 ${e('label') ? 'err' : ''}`} />
          <FieldError id={fid('label')} msg={e('label')} />
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${address.is_primary ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>{address.is_primary ? 'Primary' : 'Address'}</span>
          <button type="button" onClick={onSetPrimary} className="rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Set primary</button>
          <button type="button" onClick={onRemove} className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-gray-300 bg-white text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40" title="Remove address"><Trash2 size={16} /></button>
        </div>
      </div>
      {isExpanded && (
        <div className="grid gap-4 p-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <SettingsTextareaField id={fid('street_address')} error={e('street_address')} onBlur={() => onBlur?.('street_address')} label="Street Address *" value={address.street_address} onChange={(value) => onChange('street_address', value)} placeholder="Building, street, office address" rows={3} />
          </div>
          <SettingsTextInput id={fid('pincode')} error={e('pincode')} onBlur={() => onBlur?.('pincode')} label="Pincode *" value={address.pincode} onChange={(value) => onChange('pincode', value)} placeholder="6-digit pincode" inputMode="numeric" maxLength={6} />
          <SettingsTextInput id={fid('area_locality')} error={e('area_locality')} onBlur={() => onBlur?.('area_locality')} label="Area / Locality *" value={address.area_locality} onChange={(value) => onChange('area_locality', value)} placeholder="Area or locality" />
          <SettingsTextInput id={fid('city_district')} error={e('city_district')} onBlur={() => onBlur?.('city_district')} label="City / District *" value={address.city_district} onChange={(value) => onChange('city_district', value)} placeholder="City or district" />
          <SettingsTextInput id={fid('state')} error={e('state')} onBlur={() => onBlur?.('state')} label="State *" value={address.state} onChange={(value) => onChange('state', value)} placeholder="State" />
          <SettingsTextInput id={fid('country')} error={e('country')} onBlur={() => onBlur?.('country')} label="Country *" value={address.country} onChange={(value) => onChange('country', value)} placeholder="Country" />
        </div>
      )}
    </div>
  )
}

// ─── NEW: Recipient config used for Option B colours ───────────────────────────
const RECIPIENT_STYLES: Record<LeadNotificationRecipientKey, { bg: string; activeBg: string; activeText: string; activeBorder: string; avatarBg: string; avatarText: string }> = {
  assigned_user: {
    bg: 'bg-slate-50',
    activeBg: 'bg-blue-50',
    activeText: 'text-blue-700',
    activeBorder: 'border-blue-300',
    avatarBg: 'bg-blue-100',
    avatarText: 'text-blue-700',
  },
  manager: {
    bg: 'bg-slate-50',
    activeBg: 'bg-emerald-50',
    activeText: 'text-emerald-700',
    activeBorder: 'border-emerald-300',
    avatarBg: 'bg-emerald-100',
    avatarText: 'text-emerald-700',
  },
  admin: {
    bg: 'bg-slate-50',
    activeBg: 'bg-violet-50',
    activeText: 'text-violet-700',
    activeBorder: 'border-violet-300',
    avatarBg: 'bg-violet-100',
    avatarText: 'text-violet-700',
  },
  ceo: {
    bg: 'bg-slate-50',
    activeBg: 'bg-rose-50',
    activeText: 'text-rose-700',
    activeBorder: 'border-rose-300',
    avatarBg: 'bg-rose-100',
    avatarText: 'text-rose-700',
  },
}

const RECIPIENT_INITIALS: Record<LeadNotificationRecipientKey, string> = {
  assigned_user: 'AU',
  manager: 'MG',
  admin: 'AD',
  ceo: 'CE',
}

// ─── NEW: LeadNotificationRecipientBlock (Option B) ────────────────────────────
function LeadNotificationRecipientBlock({
  recipient,
  settings,
  onToggle,
}: {
  recipient: { key: LeadNotificationRecipientKey; label: string }
  settings: Record<string, any>
  onToggle: (settingKey: string) => void
}) {
  const rs = RECIPIENT_STYLES[recipient.key]
  const activeEvents = LEAD_NOTIFICATION_EVENTS.filter(
    (ev) => settings[leadNotificationSettingKey(ev.key, recipient.key)] === 'true',
  )

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className={`flex items-center gap-3 px-4 py-3 ${rs.bg} border-b border-slate-100`}>
        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${rs.avatarBg} ${rs.avatarText}`}>
          {RECIPIENT_INITIALS[recipient.key]}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-800">{recipient.label}</p>
          <p className="text-xs text-slate-400 mt-0.5">
            {activeEvents.length === 0
              ? 'No events enabled'
              : activeEvents.length === LEAD_NOTIFICATION_EVENTS.length
              ? 'All events enabled'
              : `${activeEvents.length} of ${LEAD_NOTIFICATION_EVENTS.length} events enabled`}
          </p>
        </div>
        {/* Mini active count badge */}
        <span className={`inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full text-[11px] font-bold
          ${activeEvents.length > 0 ? `${rs.activeBg} ${rs.activeText}` : 'bg-slate-100 text-slate-400'}`}>
          {activeEvents.length}
        </span>
      </div>

      {/* Event chips */}
      <div className="flex flex-wrap gap-2 p-4">
        {LEAD_NOTIFICATION_EVENTS.map((event) => {
          const settingKey = leadNotificationSettingKey(event.key, recipient.key)
          const enabled = settings[settingKey] === 'true'
          return (
            <button
              key={event.key}
              type="button"
              onClick={() => onToggle(settingKey)}
              title={event.desc}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold transition-all duration-150
                ${enabled
                  ? `${rs.activeBg} ${rs.activeText} ${rs.activeBorder}`
                  : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100'
                }`}
            >
              {/* dot indicator */}
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${enabled ? rs.activeText.replace('text-', 'bg-') : 'bg-slate-300'}`} />
              {event.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function NotificationRuleEditor({
  rule,
  recipientTypeOptions,
  roleOptions,
  users,
  onChange,
}: {
  rule: NotificationRuleItem
  recipientTypeOptions: NotificationOption[]
  roleOptions: NotificationOption[]
  users: NotificationUser[]
  onChange: (patch: Partial<NotificationRuleItem>) => void
}) {
  const toggleRecipientType = (recipientType: string) => {
    const nextRecipientTypes = rule.recipient_types.includes(recipientType)
      ? rule.recipient_types.filter((item) => item !== recipientType)
      : [...rule.recipient_types, recipientType]
    onChange({
      recipient_types: nextRecipientTypes,
      record_field_name: recipientType === 'record_email' || nextRecipientTypes.includes('record_email')
        ? rule.record_field_name || ''
        : '',
    })
  }

  const toggleRoleKey = (roleKey: string) => {
    const nextRoleKeys = rule.role_keys.includes(roleKey)
      ? rule.role_keys.filter((item) => item !== roleKey)
      : [...rule.role_keys, roleKey]
    onChange({ role_keys: nextRoleKeys })
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-800">Recipients</p>
          <p className="text-xs text-slate-500">Select all recipient types that should receive both in-app and email notifications for this event.</p>
        </div>
        <button
          type="button"
          onClick={() => onChange({ is_active: !rule.is_active })}
          className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${rule.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}
        >
          {rule.is_active ? 'Active' : 'Disabled'}
        </button>
      </div>

      <div className="mt-4 space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Recipient Types</label>
          <div className="flex flex-wrap gap-2">
            {recipientTypeOptions.map((option) => {
              const selected = rule.recipient_types.includes(option.key)
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => toggleRecipientType(option.key)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${selected ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Role Recipients</label>
          <div className="flex flex-wrap gap-2">
            {roleOptions.map((option) => {
              const selected = rule.role_keys.includes(option.key)
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => toggleRoleKey(option.key)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${selected ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Specific Users</label>
          <select
            multiple
            value={rule.specific_user_ids.map((userId) => String(userId))}
            onChange={(event) => onChange({
              specific_user_ids: Array.from(event.target.selectedOptions).map((option) => Number(option.value)),
            })}
            className="min-h-[140px] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          >
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.full_name} ({user.role})
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">Hold Ctrl or Cmd to select multiple users.</p>
        </div>

        {rule.recipient_types.includes('record_email') && (
          <SettingsTextInput
            label="Record Email Field"
            value={rule.record_field_name || ''}
            onChange={(value) => onChange({ record_field_name: value })}
            placeholder="Optional, leave blank to use the module default"
          />
        )}
      </div>
    </div>
  )
}

function NotificationTemplateEditor({
  template,
  onChange,
}: {
  template: NotificationTemplateItem
  onChange: (patch: Partial<NotificationTemplateItem>) => void
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-800">Shared Template</p>
          <p className="text-xs text-slate-500">The same subject and body will be used for both in-app and email notifications.</p>
        </div>
        <button
          type="button"
          onClick={() => onChange({ is_active: !template.is_active })}
          className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${template.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}
        >
          {template.is_active ? 'Active' : 'Disabled'}
        </button>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <SettingsTextInput
          label="Subject"
          value={template.subject_template || ''}
          onChange={(value) => onChange({ subject_template: value })}
          placeholder="Example: Lead Assigned: {{lead_title}}"
        />
        <SettingsTextInput
          label="Action URL"
          value={template.action_url_template || ''}
          onChange={(value) => onChange({ action_url_template: value })}
          placeholder="/module/path"
        />
        <div className="md:col-span-2">
          <SettingsTextareaField
            label="Body"
            value={template.body_template || ''}
            onChange={(value) => onChange({ body_template: value })}
            placeholder="Use placeholders like {{actor_name}}, {{record_ref}}, {{assignee_name}}"
            rows={4}
          />
        </div>
      </div>
    </div>
  )
}

type DraftEntry = { label: string; singular: string }

function ModuleLabelsTab() {
  const { customLabels, setModuleNames, resetLabel } = useModuleLabels()
  const [modules, setModules] = useState<Array<{ key: string; default_label: string }>>([])
  const [drafts, setDrafts] = useState<Record<string, DraftEntry>>({})
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})

  useEffect(() => {
    api.get('/modules').then(res => {
      const rows = (res.data as Array<{ key: string; label: string; default_label?: string }>)
        .filter(m => m.key !== 'dashboard')
        .map(m => ({ key: m.key, default_label: m.default_label || m.label }))
      setModules(rows)
      const init: Record<string, DraftEntry> = {}
      rows.forEach(m => {
        const def = DEFAULT_MODULE_NAMES[m.key] || { label: m.default_label, singular: '' }
        const custom = customLabels[m.key]
        init[m.key] = {
          label: (custom?.label && custom.label.trim()) ? custom.label : def.label,
          singular: (custom?.singular && custom.singular.trim()) ? custom.singular : def.singular,
        }
      })
      setDrafts(init)
    }).catch(() => {})
  }, [])

  const setDraft = useCallback((key: string, field: keyof DraftEntry, value: string) => {
    setDrafts(p => ({ ...p, [key]: { ...p[key], [field]: value } }))
  }, [])

  const handleSave = useCallback((key: string) => {
    const d = draftsRef.current[key]
    if (!d) return
    const def = DEFAULT_MODULE_NAMES[key] || { label: '', singular: '' }
    const label = d.label.trim()
    const singular = d.singular.trim()
    setSaving(p => ({ ...p, [key]: true }))
    const isDefault = label === def.label && singular === def.singular
    if (isDefault) {
      resetLabel(key)
    } else {
      setModuleNames(key, { label: label || def.label, singular: singular || def.singular })
    }
    setSaving(p => ({ ...p, [key]: false }))
    setSaved(p => ({ ...p, [key]: true }))
    setTimeout(() => setSaved(p => ({ ...p, [key]: false })), 1500)
  }, [setModuleNames, resetLabel])

  const handleReset = useCallback((key: string) => {
    const def = DEFAULT_MODULE_NAMES[key] || { label: '', singular: '' }
    resetLabel(key)
    setDrafts(p => ({ ...p, [key]: { label: def.label, singular: def.singular } }))
  }, [resetLabel])

  return (
    <Card>
      <div className="p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Module Labels</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Customise how module names appear across the application — sidebar, buttons, placeholders, and more.
            Set both the plural (tab/heading) and singular (button/form) forms.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map(m => {
            const def = DEFAULT_MODULE_NAMES[m.key] || { label: m.default_label, singular: '' }
            const hasCustom = !!customLabels[m.key]
            const d = drafts[m.key] || { label: def.label, singular: def.singular }
            return (
              <div key={m.key} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{def.label}</p>
                  <div className="flex gap-1">
                    {hasCustom && (
                      <button
                        onClick={() => handleReset(m.key)}
                        className="h-6 px-2 rounded-lg text-[10px] font-semibold bg-slate-100 text-slate-500 hover:bg-red-50 hover:text-red-500 transition-colors"
                      >
                        Reset
                      </button>
                    )}
                    <button
                      onClick={() => handleSave(m.key)}
                      className={`h-6 px-2 rounded-lg text-[10px] font-semibold transition-colors ${saved[m.key] ? 'bg-green-100 text-green-700' : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'}`}
                    >
                      {saving[m.key] ? '…' : saved[m.key] ? '✓ Saved' : 'Save'}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-[10px] text-slate-400 mb-0.5">Plural</p>
                    <input
                      type="text"
                      value={d.label}
                      onChange={e => setDraft(m.key, 'label', e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleSave(m.key) }}
                      placeholder={def.label}
                      className="w-full text-[12px] font-medium text-slate-800 bg-white border border-slate-200 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                    />
                  </div>
                  <div>
                    <p className="text-[10px] text-slate-400 mb-0.5">Singular</p>
                    <input
                      type="text"
                      value={d.singular}
                      onChange={e => setDraft(m.key, 'singular', e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleSave(m.key) }}
                      placeholder={def.singular}
                      className="w-full text-[12px] font-medium text-slate-800 bg-white border border-slate-200 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <p className="text-[11px] text-slate-400">
          💡 <strong>Plural</strong> — used in headings, tabs, and navigation (e.g. "Enquiries").
          <strong className="ml-2">Singular</strong> — used in buttons and forms (e.g. "Add Enquiry").
        </p>
      </div>
    </Card>
  )
}

export default function SettingsPage() {
  const { label: settingsLabel } = useModuleName('settings')
  const [settings, setSettings] = useState<Record<string, any>>({})
  const [companyAddresses, setCompanyAddresses] = useState<CompanyAddress[]>([])
  const [notificationCatalog, setNotificationCatalog] = useState<NotificationEventsResponse | null>(null)
  const [notificationRules, setNotificationRules] = useState<NotificationRuleItem[]>([])
  const [notificationTemplates, setNotificationTemplates] = useState<NotificationTemplateItem[]>([])
  const [notificationUsers, setNotificationUsers] = useState<NotificationUser[]>([])
  const [selectedNotificationModule, setSelectedNotificationModule] = useState('')
  const [selectedNotificationEventId, setSelectedNotificationEventId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('theme')

  // ── Escalation policy (shown in Security tab) ─────────────────────────────
  const [escalationEnabled, setEscalationEnabled] = useState(false)
  const [escalationHours, setEscalationHours] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [removeLogo, setRemoveLogo] = useState(false)
  const [pendingLogoPreview, setPendingLogoPreview] = useState('')
  const [letterPadSealFile, setLetterPadSealFile] = useState<File | null>(null)
  const [removeLetterPadSeal, setRemoveLetterPadSeal] = useState(false)
  const [pendingLetterPadSealPreview, setPendingLetterPadSealPreview] = useState('')
  const [isLogoViewerOpen, setIsLogoViewerOpen] = useState(false)
  const [isSmtpGuideOpen, setIsSmtpGuideOpen] = useState(false)
  const [isSmtpPasswordVisible, setIsSmtpPasswordVisible] = useState(false)
  const [smtpProvider, setSmtpProvider] = useState<SmtpProvider>('custom')
  const customSmtpConfigRef = useRef<{ host: string; port: string; security: SmtpSecurity }>({ host: '', port: '', security: 'TLS' })
  const { success, error: showError } = useToast()
  const tenantSlug = useAuthStore((state) => state.tenant_slug)
  const fe = useFieldErrors()
  const errs = fe.errors

  const applyLoadedSettings = (data: Record<string, any>) => {
    const flat = flattenSettings(data)
    const normalized: Record<string, any> = {
      ...flat,
      theme_font: normalizeThemeFont(String(flat.theme_font ?? flat.font_family ?? 'Inter')),
      theme_font_size: normalizeThemeFontSize(flat.theme_font_size ?? flat.font_size),
      forgot_password_enabled: normalizeBoolSetting(flat.forgot_password_enabled, 'true'),
      force_password_change_on_first_login: normalizeBoolSetting(flat.force_password_change_on_first_login),
      new_device_login_alert_enabled: normalizeBoolSetting(flat.new_device_login_alert_enabled),
      otp_mode: (['first_login', 'never'].includes(flat.otp_mode) ? flat.otp_mode : 'always'),
      captcha_mode: (['always', 'never'].includes(flat.captcha_mode) ? flat.captcha_mode : 'after_failed'),
      email_notifications: normalizeBoolSetting(flat.email_notifications, 'true'),
      approval_email_notifications: normalizeBoolSetting(flat.approval_email_notifications, 'true'),
      alert_email_notifications: normalizeBoolSetting(flat.alert_email_notifications, 'true'),
      event_email_notifications: normalizeBoolSetting(flat.event_email_notifications, 'true'),
      travel_auto_approve_minutes: minutesToDaysSetting(flat.travel_auto_approve_minutes, '0'),
      street_address: String(flat.street_address ?? '').trim(),
      pincode: String(flat.pincode ?? '').trim(),
      country: String(flat.country ?? '').trim() || 'India',
      state: String(flat.state ?? '').trim(),
      city_district: String(flat.city_district ?? '').trim(),
      area_locality: String(flat.area_locality ?? '').trim(),
      smtp_host: String(flat.smtp_host ?? '').trim(),
      smtp_port: String(flat.smtp_port ?? '').trim(),
      smtp_security: normalizeSmtpSecurity(flat.smtp_security),
    }
    LEAD_NOTIFICATION_EVENTS.forEach((event) => {
      LEAD_NOTIFICATION_RECIPIENTS.forEach((recipient) => {
        const settingKey = leadNotificationSettingKey(event.key, recipient.key)
        normalized[settingKey] = normalizeBoolSetting(flat[settingKey], LEAD_NOTIFICATION_DEFAULTS[event.key][recipient.key])
      })
    })
    const nextProvider = inferSmtpProvider(normalized)
    const nextSettings = nextProvider === 'custom'
      ? normalized
      : { ...normalized, smtp_host: SMTP_PROVIDER_DEFAULTS[nextProvider].host, smtp_port: SMTP_PROVIDER_DEFAULTS[nextProvider].port, smtp_security: SMTP_PROVIDER_DEFAULTS[nextProvider].security }
    if (nextProvider === 'custom') {
      customSmtpConfigRef.current = { host: normalized.smtp_host, port: normalized.smtp_port, security: normalized.smtp_security }
    } else {
      customSmtpConfigRef.current = { host: '', port: '', security: 'TLS' }
    }
    setPreviewing(false)
    setLogoFile(null)
    setRemoveLogo(false)
    setLetterPadSealFile(null)
    setRemoveLetterPadSeal(false)
    setPendingLetterPadSealPreview('')
    setIsLogoViewerOpen(false)
    setSmtpProvider(nextProvider)
    setSettings(nextSettings)
    return nextSettings
  }

  const applyLoadedCompanyAddresses = (addresses: any[]) => {
    setCompanyAddresses(normalizeCompanyAddresses(addresses))
  }

  const applyLoadedNotificationConfig = (
    catalog: NotificationEventsResponse,
    rules: NotificationRuleItem[],
    templates: NotificationTemplateItem[],
    users: NotificationUser[],
  ) => {
    const normalizedCatalog = normalizeNotificationCatalog(catalog)
    const activeUsers = [...users]
      .filter((user) => user.is_active)
      .sort((left, right) => left.full_name.localeCompare(right.full_name))
    setNotificationCatalog(normalizedCatalog)
    setNotificationRules(sortNotificationRules(hydrateNotificationRules(normalizedCatalog.events || [], rules || [])))
    setNotificationTemplates(hydrateNotificationTemplates(normalizedCatalog.events || [], templates || []))
    setNotificationUsers(activeUsers)
  }

  const fetchSettings = async () => {
    const response = await api.get('/settings/settings')
    return flattenSettings(response.data)
  }

  const fetchCompanyAddresses = async () => {
    const response = await api.get('/settings/company-addresses')
    return normalizeCompanyAddresses(response.data?.addresses ?? [])
  }

  const fetchNotificationCatalog = async () => {
    const response = await themeApi.getNotificationEvents()
    return response.data as NotificationEventsResponse
  }

  const fetchNotificationRules = async () => {
    const response = await themeApi.getNotificationRules()
    return (response.data?.rules ?? []) as NotificationRuleItem[]
  }

  const fetchNotificationTemplates = async () => {
    const response = await themeApi.getNotificationTemplates()
    return (response.data?.templates ?? []) as NotificationTemplateItem[]
  }

  const fetchNotificationUsers = async () => {
    const response = await authApi.listUsers()
    return (response.data ?? []) as NotificationUser[]
  }

  const load = async () => {
    setLoading(true)
    try {
      const [loadedSettings, loadedAddresses, catalog, rules, templates, users, escalationRes] = await Promise.all([
        fetchSettings(),
        fetchCompanyAddresses(),
        fetchNotificationCatalog(),
        fetchNotificationRules(),
        fetchNotificationTemplates(),
        fetchNotificationUsers(),
        approvalWorkflowApi.getEscalationSettings().catch(() => null),
      ])
      const normalizedSettings = applyLoadedSettings(loadedSettings)
      applyLoadedCompanyAddresses(loadedAddresses)
      applyLoadedNotificationConfig(catalog, rules, templates, users)
      applyTheme(normalizedSettings, { persist: true, tenantSlug: tenantSlug?.trim() || undefined })
      if (escalationRes?.data) {
        setEscalationEnabled(!!escalationRes.data.is_enabled)
        const mins = escalationRes.data.default_escalation_minutes
        setEscalationHours(mins && mins > 0 ? String(Number((mins / 60).toFixed(2))) : '')
      }
      return { settings: normalizedSettings }
    } catch {
      showError('Failed to load settings')
      return null
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    const moduleKeys = notificationCatalog?.modules.map((module) => module.key) || []
    if (!moduleKeys.length) {
      if (selectedNotificationModule) setSelectedNotificationModule('')
      return
    }
    if (!selectedNotificationModule || !moduleKeys.includes(selectedNotificationModule)) {
      setSelectedNotificationModule(moduleKeys[0])
    }
  }, [notificationCatalog, selectedNotificationModule])

  useEffect(() => {
    const moduleEvents = (notificationCatalog?.events || []).filter((event) => event.module_key === selectedNotificationModule && event.is_active)
    if (!moduleEvents.length) {
      if (selectedNotificationEventId !== null) setSelectedNotificationEventId(null)
      return
    }
    if (!selectedNotificationEventId || !moduleEvents.some((event) => event.id === selectedNotificationEventId)) {
      setSelectedNotificationEventId(moduleEvents[0].id)
    }
  }, [notificationCatalog, selectedNotificationModule, selectedNotificationEventId])

  useEffect(() => {
    if (!logoFile) { setPendingLogoPreview(''); return }
    const objectUrl = URL.createObjectURL(logoFile)
    setPendingLogoPreview(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [logoFile])

  useEffect(() => {
    if (!letterPadSealFile) { setPendingLetterPadSealPreview(''); return }
    const objectUrl = URL.createObjectURL(letterPadSealFile)
    setPendingLetterPadSealPreview(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [letterPadSealFile])

  const setS = (key: string, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
    if (SETTING_SPECS[key]) checkSetting(key, value, 'change')
  }
  /** Validate one settings field (format while typing, everything on blur); extra rules = hex colour / SMTP host. */
  const checkSetting = (id: string, value: Val, mode: 'change' | 'blur') => {
    const sp = id.startsWith('addr.') ? addrSpecOf(id) : SETTING_SPECS[id]
    if (!sp) return
    if (mode === 'change') fe.change(id, value, sp); else fe.blur(id, value, sp)
    const x = settingExtra(id, value)
    if (x && !validate(value, { ...sp, required: false })) fe.setError(id, x)
  }
  const addrSpecOf = (id: string) => {
    const key = id.split('.')[2]
    const label = COMPANY_ADDRESS_REQUIRED_FIELDS.find((f) => f.key === key)?.label || (key === 'label' ? 'Address label' : key)
    return addressSpec(key, key === 'label' ? 'Address label' : label)
  }
  const blurSetting = (id: string) => checkSetting(id, id === 'escalation_hours' ? escalationHours : settings[id], 'blur')
  /** Every settings / address value that is validated, keyed by its error id. */
  const validatedValues = (): Record<string, Val> => {
    const out: Record<string, Val> = Object.fromEntries(Object.keys(SETTING_SPECS).map((k) => [k, settings[k]]))
    out.escalation_hours = escalationHours
    if (smtpProvider !== 'custom') { delete out.smtp_host; delete out.smtp_port }
    if (settings.travel_approval_required !== 'true') delete out.travel_auto_approve_minutes
    if (!escalationEnabled) delete out.escalation_hours
    companyAddresses.forEach((a, i) => {
      out[`addr.${i}.label`] = a.label
      COMPANY_ADDRESS_REQUIRED_FIELDS.forEach((f) => { out[`addr.${i}.${String(f.key)}`] = String(a[f.key] ?? '') })
    })
    return out
  }
  const focusSettingError = (bad: Record<string, string>) => {
    const ids = Object.keys(validatedValues())
    const first = ids.find((k) => bad[k]) || Object.keys(bad)[0]
    if (!first) return
    const tab = settingTab(first)
    if (tab && tab !== activeTab) setActiveTab(tab)
    const elId = first.startsWith('addr.') ? first.replace(/\./g, '-') : `set-${first}`
    window.setTimeout(() => {
      const el = document.getElementById(elId)
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() }
    }, 60)
  }
  const themeFontSize = Number(normalizeThemeFontSize(settings.theme_font_size))
  const selectedThemeFont = normalizeThemeFont(settings.theme_font)

  const adjustThemeFontSize = (delta: number) => {
    setS('theme_font_size', normalizeThemeFontSize(themeFontSize + delta))
  }

  const updateCompanyAddress = (index: number, key: keyof CompanyAddress, value: string | boolean) => {
    const normalizedValue = typeof value === 'string' && key === 'pincode' ? value.replace(/\D/g, '').slice(0, 6) : value
    setCompanyAddresses((prev) => prev.map((address, currentIndex) => (currentIndex === index ? { ...address, [key]: normalizedValue } : address)))
    if (typeof normalizedValue === 'string') {
      checkSetting(`addr.${index}.${String(key)}`, normalizedValue, 'change')
      if (key === 'pincode' && /\D/.test(String(value))) fe.setError(`addr.${index}.pincode`, 'Only numbers are allowed.')
    }
  }

  const addCompanyAddress = () => {
    setCompanyAddresses((prev) => [...prev, createEmptyCompanyAddress(prev.length, prev.length === 0)])
  }

  const removeCompanyAddress = (index: number) => {
    // row indexes shift – drop every address message; they are re-checked on save
    fe.setErrors((x) => Object.fromEntries(Object.entries(x).filter(([k]) => !k.startsWith('addr.'))))
    setCompanyAddresses((prev) => {
      const next = prev.filter((_, currentIndex) => currentIndex !== index)
      if (!next.length) return []
      const primaryIndex = next.findIndex((address) => address.is_primary)
      return next.map((address, currentIndex) => ({ ...address, is_primary: primaryIndex >= 0 ? currentIndex === primaryIndex : currentIndex === 0, sort_order: currentIndex }))
    })
  }

  const setPrimaryCompanyAddress = (index: number) => {
    setCompanyAddresses((prev) => prev.map((address, currentIndex) => ({ ...address, is_primary: currentIndex === index })))
  }

  const updateNotificationTemplate = (
    eventDefinitionId: number | null,
    patch: Partial<NotificationTemplateItem>,
  ) => {
    if (!eventDefinitionId) return
    setNotificationTemplates((prev) => prev.map((template) => (
      template.event_definition_id === eventDefinitionId
        ? { ...template, ...patch }
        : template
    )))
  }

  const updateNotificationRule = (
    eventDefinitionId: number | null,
    patch: Partial<NotificationRuleItem>,
  ) => {
    if (!eventDefinitionId) return
    setNotificationRules((prev) => sortNotificationRules(prev.map((rule) => (
      rule.event_definition_id === eventDefinitionId
        ? { ...rule, ...patch }
        : rule
    ))))
  }

  const handleSmtpProviderChange = (provider: SmtpProvider) => {
    setSmtpProvider(provider)
    fe.clear('smtp_host'); fe.clear('smtp_port')
    if (provider === 'custom') {
      setSettings((prev) => ({ ...prev, smtp_host: customSmtpConfigRef.current.host, smtp_port: customSmtpConfigRef.current.port, smtp_security: customSmtpConfigRef.current.security }))
      return
    }
    const preset = SMTP_PROVIDER_DEFAULTS[provider]
    setSettings((prev) => ({ ...prev, smtp_host: preset.host, smtp_port: preset.port, smtp_security: preset.security }))
  }

  const handleCustomSmtpFieldChange = (key: 'smtp_host' | 'smtp_port' | 'smtp_security', value: string) => {
    if (key === 'smtp_host') { customSmtpConfigRef.current = { ...customSmtpConfigRef.current, host: value }; setS(key, value); return }
    if (key === 'smtp_port') { customSmtpConfigRef.current = { ...customSmtpConfigRef.current, port: value }; setS(key, value); return }
    const nextSecurity = normalizeSmtpSecurity(value)
    customSmtpConfigRef.current = { ...customSmtpConfigRef.current, security: nextSecurity }
    setS(key, nextSecurity)
  }

  const applyPreset = (preset: typeof THEME_PRESETS[0]) =>
    setSettings((prev) => ({ ...prev, theme_primary: preset.primary, theme_secondary: preset.secondary, theme_accent: preset.accent, theme_sidebar: preset.sidebar, theme_success: preset.success, theme_warning: preset.warning, theme_danger: preset.danger }))

  const handlePreview = () => {
    applyTheme({ ...settings, theme_font: selectedThemeFont }, { persist: false })
    setPreviewing(true)
    success('Preview applied for this session only')
  }

  const handleLogoSelection = (selectedFile: File) => {
    if (!selectedFile.type.startsWith('image/')) {
      showError('Please choose an image file')
      return
    }
    setLogoFile(selectedFile)
    setRemoveLogo(false)
    setIsLogoViewerOpen(false)
  }

  const handleRemoveLogo = () => {
    setLogoFile(null)
    setPendingLogoPreview('')
    setRemoveLogo(Boolean(settings.theme_logo))
    setIsLogoViewerOpen(false)
  }

  const handleLetterPadSealSelection = (selectedFile: File) => {
    if (!selectedFile.type.startsWith('image/')) {
      showError('Please choose an image file')
      return
    }
    setLetterPadSealFile(selectedFile)
    setRemoveLetterPadSeal(false)
  }

  const handleRemoveLetterPadSeal = () => {
    setLetterPadSealFile(null)
    setPendingLetterPadSealPreview('')
    setRemoveLetterPadSeal(Boolean(settings.letter_pad_seal))
  }

  const notificationModules = notificationCatalog?.modules || []
  const notificationEvents = notificationCatalog?.events || []
  const selectedModuleEvents = notificationEvents.filter((event) => event.module_key === selectedNotificationModule && event.is_active)
  const selectedNotificationEvent = selectedModuleEvents.find((event) => event.id === selectedNotificationEventId) || selectedModuleEvents[0]
  const selectedNotificationRule = notificationRules.find((rule) => rule.event_definition_id === selectedNotificationEvent?.id)
  const selectedNotificationTemplate = notificationTemplates.find((template) => template.event_definition_id === selectedNotificationEvent?.id)

  const handleSave = async () => {
    const values = validatedValues()
    const specs: Record<string, FieldSpec> = Object.fromEntries(Object.keys(values).map((k) => [k, k.startsWith('addr.') ? addrSpecOf(k) : SETTING_SPECS[k]]))
    const extra = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, settingExtra(k, v)]).filter(([, m]) => m))
    const bad = fe.validateAll(values, specs, extra)
    if (Object.keys(bad).length) { focusSettingError(bad); return }
    const companyAddressValidationError = validateCompanyAddresses(companyAddresses)
    if (companyAddressValidationError) { showError(companyAddressValidationError); return }
    for (const rule of notificationRules) {
      const eventLabel = notificationEvents.find((event) => event.id === rule.event_definition_id)?.label || 'notification event'
      const hasVisibleRecipient = rule.linked_users || rule.manager || rule.admin || rule.ceo
      const hasUnmanagedRecipient = getUnmanagedNotificationRecipients(rule).length > 0
      if (rule.is_active && !hasVisibleRecipient && !hasUnmanagedRecipient) {
        showError(`${eventLabel}: select at least one recipient column`)
        return
      }
    }
    for (const template of notificationTemplates) {
      const eventLabel = notificationEvents.find((event) => event.id === template.event_definition_id)?.label || 'notification event'
      if (template.is_active && !String(template.subject_template || '').trim()) {
        showError(`${eventLabel}: template subject is required`)
        return
      }
      if (template.is_active && !String(template.body_template || '').trim()) {
        showError(`${eventLabel}: template body is required`)
        return
      }
    }
    setSaving(true)
    try {
      if (logoFile) {
        await themeApi.uploadCompanyLogo(logoFile)
      } else if (removeLogo && settings.theme_logo) {
        await themeApi.deleteCompanyLogo(true)
      }
      if (letterPadSealFile) {
        await themeApi.uploadLetterPadSeal(letterPadSealFile)
      } else if (removeLetterPadSeal && settings.letter_pad_seal) {
        await themeApi.deleteLetterPadSeal()
      }
      const payload = Object.fromEntries(
        Object.entries(settings).filter(([key, value]) => {
          if (SETTINGS_SAVE_EXCLUDE_KEYS.has(key)) return false
          if (key === 'smtp_password' && !String(value ?? '').trim()) return false
          return true
        }).map(([key, value]) => {
          if (key === 'travel_auto_approve_minutes') return [key, daysToMinutesSetting(value)]
          if (key === 'theme_font') return [key, selectedThemeFont]
          return [key, value]
        })
      )
      const replaceEventDefinitionIds = notificationEvents.map((event) => event.id)
      const notificationRulePayload = {
        replace_event_definition_ids: replaceEventDefinitionIds,
        rules: sortNotificationRules(notificationRules).map((rule) => ({
          event_definition_id: rule.event_definition_id,
          module_key: rule.module_key,
          event_key: rule.event_key,
          recipients: buildNotificationRecipientsForSave(rule),
          available_linked_resolvers: [...(rule.available_linked_resolvers || [])],
          linked_users: Boolean(rule.linked_users),
          manager: Boolean(rule.manager),
          admin: Boolean(rule.admin),
          ceo: Boolean(rule.ceo),
          recipient_types: [...new Set((rule.recipient_types || []).map((item) => String(item).trim()).filter(Boolean))],
          role_keys: [...new Set((rule.role_keys || []).map((item) => String(item).trim().toLowerCase()).filter(Boolean))],
          specific_user_ids: [...new Set((rule.specific_user_ids || []).map((userId) => Number(userId)).filter((userId) => Number.isFinite(userId) && userId > 0))],
          record_field_name: String(rule.record_field_name || '').trim(),
          condition_json: rule.condition_json || null,
          is_active: Boolean(rule.is_active),
        })),
      }
      const notificationTemplatePayload = {
        replace_event_definition_ids: replaceEventDefinitionIds,
        templates: hydrateNotificationTemplates(notificationEvents, notificationTemplates).map((template) => ({
          event_definition_id: template.event_definition_id,
          subject_template: String(template.subject_template || '').trim(),
          body_template: String(template.body_template || '').trim(),
          html_template: template.html_template || null,
          action_url_template: String(template.action_url_template || '').trim(),
          is_active: Boolean(template.is_active),
        })),
      }
      const trimmedEscalationHours = escalationHours.trim()
      const escalationHoursValue = trimmedEscalationHours ? Number(trimmedEscalationHours) : null
      const escalationMinutes = escalationHoursValue && escalationHoursValue > 0 ? Math.max(1, Math.round(escalationHoursValue * 60)) : null
      await Promise.all([
        api.put('/settings/settings', payload),
        api.put('/settings/company-addresses', { addresses: companyAddresses.map((address, index) => ({ ...address, sort_order: index })) }),
        themeApi.updateNotificationRules(notificationRulePayload),
        themeApi.updateNotificationTemplates(notificationTemplatePayload),
        approvalWorkflowApi.updateEscalationSettings({
          is_enabled: escalationEnabled,
          default_escalation_minutes: escalationMinutes,
        }),
      ])
      const loaded = await load()
      const flattenedSettings = loaded?.settings ? flattenSettings(loaded.settings) : settings
      applyTheme(flattenedSettings, { persist: true, tenantSlug: tenantSlug?.trim() || undefined })
      success('Settings saved and applied')
    } catch (err: any) {
      // server field errors → under the field (addresses.0.pincode → addr.0.pincode, default_escalation_minutes → escalation hours)
      const mapped = Object.fromEntries(Object.entries(mapApiErrors(err, { addresses: 'addr.', default_escalation_minutes: 'escalation_hours' }))
        .filter(([k]) => k.startsWith('addr.') || SETTING_SPECS[k]))
      if (Object.keys(mapped).length) { fe.setErrors((x) => ({ ...x, ...mapped })); focusSettingError(mapped) }
      else showError(typeof err?.response?.data?.detail === 'string' ? err.response.data.detail : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const previewLogoSrc = pendingLogoPreview || (!removeLogo ? buildThemeLogoUrl({ theme_logo: settings.theme_logo, theme_logo_version: settings.theme_logo_version, logo_url: settings.logo_url }) : '')
  const previewLetterPadSealSrc = pendingLetterPadSealPreview || (!removeLetterPadSeal ? String(settings.letter_pad_seal || '') : '')
  const smtpProviderLabel = SMTP_PROVIDER_OPTIONS.find((option) => option.value === smtpProvider)?.label || 'Custom'
  const smtpGuideLink = SMTP_PROVIDER_GUIDE_LINKS[smtpProvider]
  const activeThemePresetName = THEME_PRESETS.find((preset) => (
    normalizeHexColor(settings.theme_primary) === normalizeHexColor(preset.primary)
    && normalizeHexColor(settings.theme_secondary) === normalizeHexColor(preset.secondary)
    && normalizeHexColor(settings.theme_accent) === normalizeHexColor(preset.accent)
    && normalizeHexColor(settings.theme_sidebar) === normalizeHexColor(preset.sidebar)
    && normalizeHexColor(settings.theme_success) === normalizeHexColor(preset.success)
    && normalizeHexColor(settings.theme_warning) === normalizeHexColor(preset.warning)
    && normalizeHexColor(settings.theme_danger) === normalizeHexColor(preset.danger)
  ))?.name ?? null
  const dynamicNotificationSubtitle = selectedNotificationModule === 'customers'
    ? 'Toggle customer approval, status, potential, create, update, and delete notifications. Each notification goes to both in-app and email.'
    : 'Toggle events and choose who gets notified. Each notification goes to both in-app and email.'

  const ColorField = ({ k, label }: { k: string; label: string }) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1.5">{label}</label>
      <div className="flex items-center gap-2">
        <input type="color" value={settings[k] || '#000000'} onChange={(e) => setS(k, e.target.value)} className="w-10 h-10 rounded-lg border border-gray-200 cursor-pointer p-0.5 flex-shrink-0" />
        <input id={`set-${k}`} type="text" value={settings[k] || ''} onChange={(e) => setS(k, e.target.value)} onBlur={() => blurSetting(k)} aria-invalid={errs[k] ? true : undefined} className={`flex-1 px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:outline-none focus:border-blue-400 ${errs[k] ? 'err' : ''}`} maxLength={7} placeholder="#000000" />
        <div className="w-8 h-8 rounded-lg border border-gray-200 flex-shrink-0 transition-colors" style={{ background: settings[k] || '#ccc' }} />
      </div>
      <FieldError id={`set-${k}`} msg={errs[k]} />
    </div>
  )

  const ToggleSetting = ({ k, label, desc, disabled = false }: { k: string; label: string; desc: string; disabled?: boolean }) => (
    <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors">
      <div>
        <p className="text-sm font-medium text-gray-800">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
      </div>
      <button type="button" disabled={disabled} onClick={() => setS(k, settings[k] === 'true' ? 'false' : 'true')} className={`w-12 h-6 rounded-full transition-all relative flex-shrink-0 ${settings[k] === 'true' ? 'bg-blue-600' : 'bg-gray-300'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}>
        <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-all ${settings[k] === 'true' ? 'left-6' : 'left-0.5'}`} />
      </button>
    </div>
  )

  const ThemePreviewStrip = () => (
    <div className="rounded-xl overflow-hidden border border-gray-200 shadow-sm">
      <div className="flex h-20">
        <div className="w-16 flex flex-col items-center justify-center gap-1.5 flex-shrink-0" style={{ background: settings.theme_sidebar || '#0F172A' }}>
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="w-6 h-1.5 rounded-full opacity-60" style={{ background: index === 1 ? (settings.theme_accent || '#3B82F6') : 'white' }} />
          ))}
        </div>
        <div className="flex-1 flex flex-col">
          <div className="h-8 flex items-center px-3 gap-2" style={{ background: settings.theme_primary || '#0B1F3A' }}>
            <div className="text-white text-xs font-bold opacity-90" style={{ fontFamily: getFontStack(selectedThemeFont) }}>{settings.company_name || 'AZCENTRIX'}</div>
            <div className="ml-auto w-5 h-5 rounded-full" style={{ background: settings.theme_accent || '#3B82F6' }} />
          </div>
          <div className="flex-1 p-2 bg-gray-50 flex items-center gap-2">
            {[settings.theme_accent, settings.theme_success, settings.theme_warning, settings.theme_danger].map((color, index) => (
              <div key={index} className="flex-1 h-5 rounded-md flex items-center justify-center text-white text-[9px] font-bold" style={{ background: color || '#ccc' }}>
                {['Accent', 'Success', 'Warning', 'Danger'][index]}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="px-3 py-2 bg-white border-t border-gray-100 flex items-center gap-2">
        <span className="text-[10px] text-gray-400">Font preview:</span>
        <span className="text-gray-700" style={{ fontFamily: getFontStack(selectedThemeFont), fontSize: `${themeFontSize}px` }}>{selectedThemeFont} {themeFontSize}px - The quick brown fox</span>
      </div>
    </div>
  )

  const TABS = [
    { key: 'theme', label: 'Theme & Branding', icon: <Palette size={15} /> },
    { key: 'company', label: 'Company', icon: <Building2 size={15} /> },
    { key: 'notifications', label: 'Notifications', icon: <Bell size={15} /> },
    { key: 'security', label: 'Security', icon: <Shield size={15} /> },
    { key: 'approvals', label: 'Approvals', icon: <ClipboardCheck size={15} /> },
    { key: 'escalation_overrides', label: 'Escalation Overrides', icon: <Clock3 size={15} /> },
    { key: 'auto_approve', label: 'Auto Approve', icon: <Wand2 size={15} /> },
  ]

  return (
    <div className="flex h-[calc(100vh-3.5rem)] max-h-[calc(100vh-3.5rem)] min-h-0 flex-col overflow-hidden p-6">
      <PageHeader
        title={settingsLabel}
        subtitle="Configure theme, company info, notifications, security, approvals and escalation overrides"
        breadcrumb={[settingsLabel]}
        actions={['approvals', 'escalation_overrides', 'auto_approve'].includes(activeTab) ? undefined : (
          <div className="flex items-center gap-2">
            <button onClick={load} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
            {previewing && (
              <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2.5 py-1.5 rounded-lg font-medium">
                Preview active - not yet saved
              </span>
            )}
            <button onClick={handlePreview} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors">
              <Eye size={14} /> Preview
            </button>
            <Button onClick={handleSave} loading={saving}>
              <Save size={14} className="mr-1.5 inline-block" /> Save &amp; Apply
            </Button>
          </div>
        )}
      />

      <div className="flex min-h-0 flex-1 items-stretch gap-6 overflow-hidden">
        <div className="w-52 flex-shrink-0 overflow-y-auto overscroll-contain pr-1">
          <div className="space-y-1">
            {TABS.map((tab) => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)} className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-xl transition-all ${activeTab === tab.key ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'}`}>
                {tab.icon} {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-scrollbar-hidden min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pb-1 pr-2" style={{ background: 'var(--surface-2)' }}>
          {loading ? (
            <Card><div className="p-12 text-center text-gray-400">Loading settings...</div></Card>
          ) : (
            <>
              {activeTab === 'theme' && (
                <div className="space-y-5">
                  <Card>
                    <div className="p-5 space-y-6">
                      <FormSection title="Live Preview" subtitle="Updates as you change colours"><ThemePreviewStrip /></FormSection>
                      <FormSection title="Theme Presets" subtitle="One-click colour schemes">
                        <div className="grid grid-cols-4 gap-3">
                          {THEME_PRESETS.map((preset) => {
                            const isActive = activeThemePresetName === preset.name
                            return (
                              <button key={preset.name} onClick={() => applyPreset(preset)} type="button" aria-pressed={isActive} className={`relative flex flex-col items-center gap-1.5 rounded-xl border p-3 transition-all ${isActive ? 'border-blue-500 bg-blue-50 shadow-sm ring-2 ring-blue-100' : 'border-gray-200 hover:border-blue-400 hover:bg-blue-50'}`}>
                                <div className="flex gap-1">
                                  <div className="w-5 h-5 rounded-full" style={{ background: preset.primary }} />
                                  <div className="w-5 h-5 rounded-full" style={{ background: preset.accent }} />
                                  <div className="w-5 h-5 rounded-full" style={{ background: preset.sidebar }} />
                                </div>
                                <span className={`text-xs font-medium ${isActive ? 'text-blue-700' : 'text-gray-700'}`}>{preset.name}</span>
                              </button>
                            )
                          })}
                        </div>
                      </FormSection>
                      <FormSection title="Custom Colours" subtitle="Fine-tune each colour individually">
                        <FormGrid cols={3}>
                          <ColorField k="theme_primary" label="Primary (Topbar)" />
                          <ColorField k="theme_secondary" label="Secondary" />
                          <ColorField k="theme_accent" label="Accent (Buttons, links)" />
                          <ColorField k="theme_sidebar" label="Sidebar" />
                          <ColorField k="theme_success" label="Success" />
                          <ColorField k="theme_warning" label="Warning" />
                          <ColorField k="theme_danger" label="Danger / Error" />
                        </FormGrid>
                      </FormSection>
                      <FormSection title="Typography">
                        <div className="max-w-3xl space-y-3">
                          <div className="grid gap-4 md:grid-cols-[minmax(0,280px)_minmax(0,240px)]">
                            <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1.5">Font Family</label>
                          <select value={selectedThemeFont} onChange={(e) => setS('theme_font', e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500">
                            {FONT_OPTIONS.map((font) => (<option key={font} value={font} style={{ fontFamily: getFontStack(font) }}>{font}</option>))}
                          </select>
                            </div>
                            <div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1.5">Font Size</label>
                            <div className="flex items-center gap-2">
                              <button type="button" onClick={() => adjustThemeFontSize(-1)} disabled={themeFontSize <= MIN_THEME_FONT_SIZE} aria-label="Decrease font size" className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-gray-300 bg-white text-lg font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40">
                                -
                              </button>
                              <div className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-center">
                                <div className="text-base font-semibold text-gray-900">{themeFontSize}px</div>
                                {/* <div className="text-[11px] text-gray-500">{MIN_THEME_FONT_SIZE}px to {MAX_THEME_FONT_SIZE}px</div> */}
                              </div>
                              <button type="button" onClick={() => adjustThemeFontSize(1)} disabled={themeFontSize >= MAX_THEME_FONT_SIZE} aria-label="Increase font size" className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-gray-300 bg-white text-lg font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40">
                                +
                              </button>
                            </div>
                            {/* <p className="mt-2 text-xs text-gray-500">Preview or save to apply this font size across the current tenant.</p> */}
                          </div>
                            </div>
                          </div>
                          <p className="text-gray-700 bg-gray-50 rounded-lg px-3 py-2 border border-gray-100" style={{ fontFamily: getFontStack(selectedThemeFont), fontSize: `${themeFontSize}px` }}>
                            The quick brown fox jumps over the lazy dog.
                            <br />
                            <span className="font-bold">Bold text</span> · <span className="italic">Italic text</span> · 1234567890
                          </p>
                        </div>
                      </FormSection>
                      <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700">
                        <Eye size={14} className="flex-shrink-0" />
                        Click <strong>Preview</strong> to see changes live without saving, or <strong>Save &amp; Apply</strong> to make them permanent for all users.
                      </div>
                    </div>
                  </Card>
                </div>
              )}

              {activeTab === 'company' && (
                <Card>
                  <div className="p-5 space-y-6">
                    <FormSection title="Company Information">
                      <FormGrid cols={2}>
                        <SettingsTextInput id="set-company_name" error={errs.company_name} onBlur={() => blurSetting('company_name')} label="Company Name" value={settings.company_name || ''} onChange={(value) => setS('company_name', value)} placeholder="e.g. Acme Corp Ltd." />
                        <SettingsSelectField label="Date Format" value={settings.date_format || 'DD-MM-YYYY'} onChange={(value) => setS('date_format', value)} options={['DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY-MM-DD'].map((value) => ({ value, label: value }))} />
                        <SettingsSelectField label="Fiscal Year Start" value={settings.fiscal_year_start || FISCAL_YEAR_OPTIONS[0]?.value || ''} onChange={(value) => setS('fiscal_year_start', value)} options={FISCAL_YEAR_OPTIONS} />
                      </FormGrid>
                    </FormSection>

                    <FormSection title="Company Addresses" subtitle="Add multiple office, branch, warehouse, or registered addresses and choose one primary address.">
                      <div className="space-y-4">
                        {companyAddresses.length > 0 ? (
                          companyAddresses.map((address, index) => (
                            <CompanyAddressCard key={address.id ?? `address-${index}`} address={address} index={index} errors={errs} onBlur={(key) => checkSetting(`addr.${index}.${String(key)}`, String(companyAddresses[index]?.[key] ?? ''), 'blur')} onChange={(key, value) => updateCompanyAddress(index, key, value)} onRemove={() => removeCompanyAddress(index)} onSetPrimary={() => setPrimaryCompanyAddress(index)} />
                          ))
                        ) : (
                          <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-5 py-10 text-center">
                            <MapPin size={28} className="mx-auto mb-3 text-gray-300" />
                            <p className="text-sm font-medium text-gray-700">No company addresses added yet</p>
                            <p className="mt-1 text-xs text-gray-500">Add your head office, branch, warehouse, or any other company address block here.</p>
                          </div>
                        )}
                        <button type="button" onClick={addCompanyAddress} className="inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
                          <Plus size={15} />
                          {companyAddresses.length === 0 ? 'Add Head Office Address' : 'Add Another Address'}
                        </button>
                      </div>
                    </FormSection>

                    <FormSection title="Mail & Branding">
                      <FormGrid cols={2}>
                        <SettingsTextInput id="set-smtp_user" error={errs.smtp_user} onBlur={() => blurSetting('smtp_user')} label="SMTP User" value={settings.smtp_user || ''} onChange={(value) => setS('smtp_user', value)} type="email" placeholder="smtp-user@example.com" autoComplete="email" />
                        {smtpProvider === 'custom' && (
                          <>
                            <SettingsTextInput id="set-smtp_host" error={errs.smtp_host} onBlur={() => blurSetting('smtp_host')} label="SMTP Host" value={settings.smtp_host || ''} onChange={(value) => handleCustomSmtpFieldChange('smtp_host', value)} placeholder="mail.yourdomain.com" />
                            <SettingsTextInput id="set-smtp_port" error={errs.smtp_port} onBlur={() => blurSetting('smtp_port')} label="Port" value={settings.smtp_port || ''} onChange={(value) => handleCustomSmtpFieldChange('smtp_port', value)} placeholder="587 or 465" />
                            <SettingsSelectField label="Security" value={normalizeSmtpSecurity(settings.smtp_security)} onChange={(value) => handleCustomSmtpFieldChange('smtp_security', value)} options={SMTP_SECURITY_OPTIONS} />
                          </>
                        )}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
                          <div className="relative">
                            <input type={isSmtpPasswordVisible ? 'text' : 'password'} value={settings.smtp_password || ''} onChange={(e) => setS('smtp_password', e.target.value)} placeholder="Enter SMTP password (leave blank to keep current)" autoComplete="new-password" className="w-full px-3 py-2 pr-10 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500" />
                            <button type="button" onClick={() => setIsSmtpPasswordVisible((prev) => !prev)} aria-label={isSmtpPasswordVisible ? 'Hide SMTP password' : 'Show SMTP password'} aria-pressed={isSmtpPasswordVisible} className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
                              {isSmtpPasswordVisible ? <Eye size={13} /> : <EyeOff size={13} />}
                            </button>
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-3">
                            <p className="text-xs text-slate-500">Enter the app password or SMTP password provided by {smtpProviderLabel}.</p>
                            <button type="button" onClick={() => setIsSmtpGuideOpen(true)} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">View guide</button>
                          </div>
                        </div>
                        <div className="col-span-2 pt-2 space-y-3">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1.5">Company Logo</label>
                            <div className="space-y-3">
                              <DropFileUpload
                                label="Drop company logo here, or click to browse"
                                file={logoFile}
                                accept="image/*"
                                variant="panel"
                                disabled={saving}
                                helperText={logoFile ? 'Ready to upload on save.' : 'Supports drag and drop for PNG, JPG, SVG, and other image files.'}
                                className="border-gray-300 bg-white text-gray-600 hover:border-blue-400 hover:bg-blue-50"
                                onFile={handleLogoSelection}
                              />
                              <button type="button" onClick={handleRemoveLogo} className="inline-flex items-center gap-2 px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
                                <Trash2 size={14} /><span>Delete Logo</span>
                              </button>
                            </div>
                          </div>
                          {previewLogoSrc ? (
                            <button type="button" onClick={() => setIsLogoViewerOpen(true)} className="p-3 bg-gray-50 rounded-xl border border-gray-100 inline-flex items-center gap-3 hover:border-blue-200 hover:bg-blue-50/60 transition-colors text-left">
                              <img src={previewLogoSrc} alt="Logo preview" className="h-12 max-w-[180px] object-contain" onError={(event) => { (event.target as HTMLImageElement).style.display = 'none' }} />
                              <div className="min-w-0">
                                <span className="block text-xs text-gray-500">{logoFile ? `Ready to upload: ${logoFile.name}` : 'Current logo'}</span>
                                <span className="block text-[11px] text-blue-600 mt-1 font-medium">Click to view</span>
                              </div>
                            </button>
                          ) : (
                            <div className="text-xs text-gray-400">{removeLogo ? 'Logo will be removed on save.' : 'No logo uploaded yet.'}</div>
                          )}
                          <div className="border-t border-gray-100 pt-4">
                            <label className="block text-sm font-medium text-gray-700 mb-1.5">Letter Pad Seal</label>
                            <div className="space-y-3">
                              <DropFileUpload
                                label="Drop letter pad seal here, or click to browse"
                                file={letterPadSealFile}
                                accept="image/*"
                                variant="panel"
                                disabled={saving}
                                helperText={letterPadSealFile ? 'Ready to upload on save.' : 'Supports PNG, JPG, SVG, and other image files.'}
                                className="border-gray-300 bg-white text-gray-600 hover:border-blue-400 hover:bg-blue-50"
                                onFile={handleLetterPadSealSelection}
                              />
                              <button type="button" onClick={handleRemoveLetterPadSeal} disabled={!letterPadSealFile && !settings.letter_pad_seal} className="inline-flex items-center gap-2 px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50">
                                <Trash2 size={14} /><span>Delete Seal</span>
                              </button>
                            </div>
                          </div>
                          {previewLetterPadSealSrc ? (
                            <div className="p-3 bg-gray-50 rounded-xl border border-gray-100 inline-flex items-center gap-3">
                              <img src={previewLetterPadSealSrc} alt="Letter pad seal preview" className="h-16 max-w-[180px] object-contain" onError={(event) => { (event.target as HTMLImageElement).style.display = 'none' }} />
                              <span className="block text-xs text-gray-500">{letterPadSealFile ? `Ready to upload: ${letterPadSealFile.name}` : 'Current letter pad seal'}</span>
                            </div>
                          ) : (
                            <div className="text-xs text-gray-400">{removeLetterPadSeal ? 'Letter pad seal will be removed on save.' : 'No letter pad seal uploaded yet.'}</div>
                          )}
                        </div>
                      </FormGrid>
                    </FormSection>
                  </div>
                </Card>
              )}

              {activeTab === 'notifications' && (
                <Card>
                  <div className="p-5 space-y-6">
                    <FormSection title="Approval & Notification Settings">
                      <div className="space-y-3">
                        <ToggleSetting k="email_notifications" label="Email Notifications" desc="Master switch for all approval, alert, and event emails" />
                        <ToggleSetting k="approval_email_notifications" label="Approval Emails" desc="Send emails when approvals are requested, approved, or rejected" disabled={settings.email_notifications !== 'true'} />
                        <ToggleSetting k="alert_email_notifications" label="Alert Emails" desc="Send critical alerts instantly and non-critical alerts in the daily digest" disabled={settings.email_notifications !== 'true'} />
                        <ToggleSetting k="event_email_notifications" label="Event Emails" desc="Send workflow update emails for non-approval events and status changes" disabled={settings.email_notifications !== 'true'} />
                      </div>
                    </FormSection>

                  {/* Dynamic Notification Rules */}
<FormSection
  title="Dynamic Notification Rules"
  subtitle={dynamicNotificationSubtitle}
>
  {!notificationCatalog || notificationEvents.length === 0 ? (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center text-sm text-slate-500">
      Notification events are not available yet.
    </div>
  ) : (
    <div className="space-y-4">

      {/* Module filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-500">Module:</span>
        {notificationModules.map((module) => (
          <button
            key={module.key}
            type="button"
            onClick={() => setSelectedNotificationModule(module.key)}
            className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
              selectedNotificationModule === module.key
                ? 'border-blue-300 bg-blue-50 text-blue-700'
                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
            }`}
          >
            {module.label}
          </button>
        ))}
      </div>

      {/* Table */}
      {(() => {
        const RECIPIENTS = notificationCatalog?.ui_recipient_columns || [
          { key: 'linked_users', label: 'Linked Users' },
          { key: 'manager', label: 'Manager' },
          { key: 'admin', label: 'Admin' },
          { key: 'ceo', label: 'CEO' },
        ]

        const COL = 'w-[110px] flex justify-center'

        // Compute "select all" state per recipient column
        const activeEvents = selectedModuleEvents.filter((ev) => {
          const rule = notificationRules.find((r) => r.event_definition_id === ev.id)
          return rule?.is_active ?? false
        })

        const allEventsOn = selectedModuleEvents.length > 0 &&
          selectedModuleEvents.every((ev) => {
            const rule = notificationRules.find((r) => r.event_definition_id === ev.id)
            return rule?.is_active ?? false
          })

        const toggleAllEvents = () => {
          selectedModuleEvents.forEach((ev) => {
            const rule = notificationRules.find((r) => r.event_definition_id === ev.id)
            if (!rule) return
            updateNotificationRule(ev.id, { is_active: !allEventsOn })
          })
        }

        const isColAllOn = (recipientKey: string) =>
          activeEvents.length > 0 &&
          activeEvents.every((ev) => {
            const rule = notificationRules.find((r) => r.event_definition_id === ev.id)
            return Boolean(rule?.[recipientKey as keyof NotificationRuleItem])
          })

        const toggleCol = (recipientKey: string) => {
          const allOn = isColAllOn(recipientKey)
          activeEvents.forEach((ev) => {
            const rule = notificationRules.find((r) => r.event_definition_id === ev.id)
            if (!rule) return
            updateNotificationRule(ev.id, { [recipientKey]: !allOn } as Partial<NotificationRuleItem>)
          })
        }

        const CircleBtn = ({
          enabled,
          disabled = false,
          onClick,
          size = 'sm',
        }: {
          enabled: boolean
          disabled?: boolean
          onClick: () => void
          size?: 'sm' | 'md'
        }) => {
          const dim = size === 'md' ? 'h-8 w-8' : 'h-7 w-7'
          return (
            <button
              type="button"
              disabled={disabled}
              onClick={onClick}
              className={`${dim} rounded-full border transition-all flex items-center justify-center flex-shrink-0 ${
                enabled
                  ? 'border-blue-400 bg-blue-500'
                  : 'border-slate-300 bg-white hover:border-slate-400'
              } ${disabled ? 'pointer-events-none opacity-35' : ''}`}
            >
              {enabled && (
                <svg viewBox="0 0 12 12" width="12" height="12" fill="none">
                  <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          )
        }

        if (selectedModuleEvents.length === 0) {
          const selectedModuleLabel = notificationModules.find((module) => module.key === selectedNotificationModule)?.label || 'This module'
          return (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
              <p className="text-sm font-medium text-slate-700">{selectedModuleLabel} notification events are not available yet</p>
              <p className="mt-1 text-xs text-slate-500">The module tab is ready, but the backend has not returned any active notification events for it yet.</p>
            </div>
          )
        }

        return (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">

            {/* Column headers */}
            <div className="flex items-center border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Event</div>
              {RECIPIENTS.map((r) => (
                <div key={r.key} className={COL}>
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{r.label}</span>
                </div>
              ))}
            </div>

            {/* Select-all row */}
            <div className="flex items-center border-b border-slate-200 bg-slate-50/60 px-4 py-2.5">
              <div className="flex flex-1 items-center gap-3">
                <button
                  type="button"
                  onClick={toggleAllEvents}
                  aria-label={allEventsOn ? 'Disable all events' : 'Enable all events'}
                  className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
                    allEventsOn ? 'bg-blue-600' : 'bg-slate-300'
                  }`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all ${allEventsOn ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
                <span className="text-xs font-semibold text-slate-500">Select all events</span>
              </div>
              {RECIPIENTS.map((r) => (
                <div key={r.key} className={COL}>
                  <CircleBtn
                    size="md"
                    enabled={isColAllOn(r.key)}
                    disabled={activeEvents.length === 0}
                    onClick={() => toggleCol(r.key)}
                  />
                </div>
              ))}
            </div>

            {/* Event rows */}
            {selectedModuleEvents.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-slate-400">No events configured for this module.</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {selectedModuleEvents.map((event) => {
                  const rule = notificationRules.find((r) => r.event_definition_id === event.id)
                  const isActive = rule?.is_active ?? false

                  const toggleActive = () =>
                    updateNotificationRule(event.id, { is_active: !isActive })

                  const toggleRecipient = (key: string) => {
                    if (!rule) return
                    updateNotificationRule(event.id, { [key]: !Boolean(rule[key as keyof NotificationRuleItem]) } as Partial<NotificationRuleItem>)
                  }

                  return (
                    <div
                      key={event.id}
                      className={`flex items-center px-4 py-3.5 transition-colors ${
                        isActive ? 'bg-white hover:bg-slate-50/50' : 'bg-slate-50/30 opacity-50'
                      }`}
                    >
                      {/* Event info */}
                      <div className="flex flex-1 items-center gap-3 min-w-0 pr-4">
                        <button
                          type="button"
                          onClick={toggleActive}
                          aria-label={isActive ? 'Disable' : 'Enable'}
                          className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
                            isActive ? 'bg-blue-600' : 'bg-slate-300'
                          }`}
                        >
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all ${isActive ? 'left-[18px]' : 'left-0.5'}`} />
                        </button>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-800 leading-snug">{event.label}</p>
                          <p className="mt-0.5 text-xs text-slate-400">{event.description || '—'}</p>
                        </div>
                      </div>

                      {/* Recipient circles */}
                      {RECIPIENTS.map(({ key }) => (
                        <div key={key} className={COL}>
                          <CircleBtn
                            enabled={Boolean(rule?.[key as keyof NotificationRuleItem])}
                            disabled={!isActive}
                            onClick={() => toggleRecipient(key)}
                          />
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}

          </div>
        )
      })()}

    </div>
  )}
</FormSection>

                    <FormSection title="Workflow Rules">
                      <div className="space-y-3">
                        <div className={`rounded-xl border bg-gray-50 hover:bg-gray-100 transition-colors ${settings.travel_approval_required === 'true' ? 'border-gray-200' : 'border-gray-200 opacity-70'}`}>
                          <div className="flex items-center justify-between px-4 py-4">
                            <div>
                              <p className="text-sm font-medium text-gray-800">Travel Request Approval</p>
                              <p className="text-xs text-gray-500 mt-0.5">Require manager approval for travel requests</p>
                            </div>
                            <button type="button" onClick={() => setS('travel_approval_required', settings.travel_approval_required === 'true' ? 'false' : 'true')} className={`w-12 h-6 rounded-full transition-all relative flex-shrink-0 ${settings.travel_approval_required === 'true' ? 'bg-blue-600' : 'bg-gray-300'}`}>
                              <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-all ${settings.travel_approval_required === 'true' ? 'left-6' : 'left-0.5'}`} />
                            </button>
                          </div>
                          <div className={`flex items-center gap-4 border-t border-gray-200 px-4 py-3 ${settings.travel_approval_required === 'true' ? 'bg-white' : 'bg-gray-50'}`}>
                            <p className="text-xs text-gray-500 flex-1">Auto-approve after (days). Set to <span className="font-mono font-medium">0</span> for manual approval only.</p>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <label htmlFor="set-travel_auto_approve_minutes" className="text-xs font-medium text-gray-600 whitespace-nowrap">Auto Approve (Days)</label>
                              <input id="set-travel_auto_approve_minutes" type="text" inputMode="decimal" value={settings.travel_auto_approve_minutes || '0'} onChange={(e) => setS('travel_auto_approve_minutes', normalizeNonNegativeDecimalSetting(e.target.value))} onBlur={() => blurSetting('travel_auto_approve_minutes')} aria-invalid={errs.travel_auto_approve_minutes ? true : undefined} readOnly={settings.travel_approval_required !== 'true'} placeholder="0" className={`w-20 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 text-center ${settings.travel_approval_required !== 'true' ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-white'} ${errs.travel_auto_approve_minutes ? 'err' : ''}`} />
                            </div>
                          </div>
                          {errs.travel_auto_approve_minutes && <div className="px-4 pb-2 text-right"><FieldError id="set-travel_auto_approve_minutes" msg={errs.travel_auto_approve_minutes} /></div>}
                        </div>

                        {/* Travel advance notice days */}
                        <div className="rounded-xl border border-gray-200 bg-gray-50">
                          <div className="flex items-center justify-between px-4 py-4">
                            <div>
                              <p className="text-sm font-medium text-gray-800">Prior Travel Request Days</p>
                              <p className="text-xs text-gray-500 mt-0.5">Minimum days before the travel date that a request must be submitted. Staff cannot raise a travel request within this window.</p>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <input
                                id="set-travel_request_advance_days"
                                type="number"
                                min="0" max="30"
                                value={settings.travel_request_advance_days ?? '3'}
                                onChange={(e) => setS('travel_request_advance_days', String(Math.max(0, parseInt(e.target.value) || 0)))}
                                onBlur={() => blurSetting('travel_request_advance_days')}
                                aria-invalid={errs.travel_request_advance_days ? true : undefined}
                                className={`w-20 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 text-center bg-white ${errs.travel_request_advance_days ? 'err' : ''}`}
                              />
                              <span className="text-xs text-gray-500 whitespace-nowrap">days prior</span>
                            </div>
                          </div>
                          {errs.travel_request_advance_days && <div className="px-4 pb-2 text-right"><FieldError id="set-travel_request_advance_days" msg={errs.travel_request_advance_days} /></div>}
                          <div className="border-t border-gray-200 px-4 py-2.5 bg-white rounded-b-xl">
                            <p className="text-xs text-gray-400">
                              Example: if set to <span className="font-mono font-medium text-gray-600">{settings.travel_request_advance_days ?? '3'}</span> days, a request for travel on <span className="font-medium text-gray-600">Friday</span> must be submitted by <span className="font-medium text-gray-600">{(() => { const d = new Date(); d.setDate(d.getDate() + (5 - d.getDay() + 7) % 7 || 7); const adv = parseInt(settings.travel_request_advance_days ?? '3') || 3; d.setDate(d.getDate() - adv); return d.toLocaleDateString('en-IN', {weekday:'long', day:'numeric', month:'short'}) })()} or earlier</span>.
                            </p>
                          </div>
                        </div>
                      </div>
                    </FormSection>
                  </div>
                </Card>
              )}

              {activeTab === 'security' && (
                <Card>
                  <div className="p-5">
                    <FormSection title="Login & Recovery Controls" subtitle="Manage tenant-level access and password recovery behavior">
                      <div className="space-y-3">
                        <ToggleSetting k="forgot_password_enabled" label="Forgot Password" desc="Allow users to request a password reset link from the login screen" />
                        <ToggleSetting k="force_password_change_on_first_login" label="Force Change On First Login" desc="Require newly created users to change the admin-set password after their first successful sign-in" />
                        <ToggleSetting k="new_device_login_alert_enabled" label="New Device Login Alert" desc="Send a login alert when an account signs in from a new browser or device" />
                        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors">
                          <div>
                            <p className="text-sm font-medium text-gray-800">Two-Step OTP Verification</p>
                            <p className="text-xs text-gray-500 mt-0.5">Control when the one-time password is required during login</p>
                          </div>
                          <select
                            value={settings.otp_mode || 'always'}
                            onChange={(e) => setS('otp_mode', e.target.value)}
                            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 bg-white"
                          >
                            <option value="always">Every Login</option>
                            <option value="first_login">First Login Only</option>
                            <option value="never">Never</option>
                          </select>
                        </div>
                        <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl hover:bg-gray-100 transition-colors">
                          <div>
                            <p className="text-sm font-medium text-gray-800">Captcha Verification</p>
                            <p className="text-xs text-gray-500 mt-0.5">Choose when the login math challenge is required</p>
                          </div>
                          <select
                            value={settings.captcha_mode || 'after_failed'}
                            onChange={(e) => setS('captcha_mode', e.target.value)}
                            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 bg-white"
                          >
                            <option value="after_failed">After 3 Failed Attempts</option>
                            <option value="always">Every Login</option>
                            <option value="never">Never</option>
                          </select>
                        </div>
                      </div>
                    </FormSection>
                    <FormSection title="Approval Escalation" subtitle="Auto-escalate overdue approval steps to the next approver">
                      <div className={`rounded-xl border transition-colors ${escalationEnabled ? 'border-gray-200 bg-gray-50 hover:bg-gray-100' : 'border-gray-200 bg-gray-50 opacity-80'}`}>
                        <div className="flex items-center justify-between px-4 py-4">
                          <div>
                            <p className="text-sm font-medium text-gray-800">Common Escalation Time</p>
                            <p className="text-xs text-gray-500 mt-0.5">Apply one default SLA before approval steps move to the next approver</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => { setEscalationEnabled((value) => !value); fe.clear('escalation_hours') }}
                            className={`w-12 h-6 rounded-full transition-all relative flex-shrink-0 ${escalationEnabled ? 'bg-blue-600' : 'bg-gray-300'}`}
                          >
                            <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-all ${escalationEnabled ? 'left-6' : 'left-0.5'}`} />
                          </button>
                        </div>
                        <div className={`flex items-center gap-4 border-t border-gray-200 px-4 py-3 ${escalationEnabled ? 'bg-white' : 'bg-gray-50'}`}>
                          <p className="text-xs text-gray-500 flex-1">Escalate after this many hours. Use the <span className="font-medium text-gray-700">Escalation Overrides</span> tab for module or role-specific exceptions.</p>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <label className="text-xs font-medium text-gray-600 whitespace-nowrap">Escalate After (Hours)</label>
                            <input
                              type="number"
                              min="0"
                              step="0.25"
                              id="set-escalation_hours"
                              value={escalationHours}
                              onChange={(e) => { setEscalationHours(e.target.value); checkSetting('escalation_hours', e.target.value, 'change') }}
                              onBlur={() => blurSetting('escalation_hours')}
                              aria-invalid={errs.escalation_hours ? true : undefined}
                              readOnly={!escalationEnabled}
                              placeholder="24"
                              className={`w-24 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 text-center ${!escalationEnabled ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-white'} ${errs.escalation_hours ? 'err' : ''}`}
                            />
                          </div>
                        </div>
                        {errs.escalation_hours && <div className="px-4 pb-2 text-right"><FieldError id="set-escalation_hours" msg={errs.escalation_hours} /></div>}
                      </div>
                    </FormSection>

                    <FormSection title="Security Baseline">
                      <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 space-y-2.5">
                        {[
                          'Password: Min 8 chars, uppercase, lowercase, digit, special character',
                          'Captcha: configurable as every login, never, or after 3 failed attempts',
                          'Login lockout: 5 failed attempts -> 30-minute lockout',
                          'JWT access token: 30 minutes | Refresh token: 7 days',
                          'All API requests logged for performance and audit',
                          'Approved decisions are immutable - cannot be reverted',
                          'Every approval triggers email and in-app notification',
                          'Multi-tenant isolation: each tenant has separate database',
                          'RBAC: 7 roles with hierarchical permissions',
                          'Audit logs track old/new data for every CRUD operation',
                        ].map((policy, index) => (<p key={index} className="text-sm text-blue-800">{policy}</p>))}
                      </div>
                    </FormSection>
                  </div>
                </Card>
              )}

              {activeTab === 'approvals' && <ApprovalsTab view="approvals" />}
              {activeTab === 'escalation_overrides' && <ApprovalsTab view="escalations" />}
              {activeTab === 'auto_approve' && <AutoApproveTab />}
              {activeTab === 'module_labels' && <ModuleLabelsTab />}
            </>
          )}
        </div>
      </div>

      {isLogoViewerOpen && previewLogoSrc && (
        <div className="fixed inset-0 z-[90] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-6">
          <button type="button" className="absolute inset-0" onClick={() => setIsLogoViewerOpen(false)} aria-label="Close logo preview" />
          <div className="relative max-w-3xl w-full bg-white rounded-2xl shadow-2xl border border-slate-200 p-4">
            <button type="button" onClick={() => setIsLogoViewerOpen(false)} className="absolute top-3 right-3 w-9 h-9 rounded-full border border-slate-200 bg-white text-slate-500 hover:text-slate-800 hover:border-slate-300 flex items-center justify-center" aria-label="Close"><X size={16} /></button>
            <div className="pt-6 px-2 pb-2"><img src={previewLogoSrc} alt="Company logo full preview" className="max-h-[70vh] w-full object-contain" /></div>
          </div>
        </div>
      )}

      {isSmtpGuideOpen && (
        <div className="fixed inset-0 z-[95] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-6">
          <button type="button" className="absolute inset-0" onClick={() => setIsSmtpGuideOpen(false)} aria-label="Close SMTP password guide" />
          <div className="relative max-w-3xl w-full max-h-[85vh] overflow-y-auto bg-white rounded-2xl shadow-2xl border border-slate-200 p-6">
            <button type="button" onClick={() => setIsSmtpGuideOpen(false)} className="absolute top-4 right-4 w-9 h-9 rounded-full border border-slate-200 bg-white text-slate-500 hover:text-slate-800 hover:border-slate-300 flex items-center justify-center" aria-label="Close"><X size={16} /></button>
            <div className="pr-10">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">Help Center</span>
                <span className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">{smtpProviderLabel}</span>
              </div>
              <h3 className="mt-3 text-xl font-bold text-slate-900">SMTP Password Guide</h3>
              <p className="mt-1 text-sm text-slate-500">A quick setup reference for the selected provider, with steps, notes, and a direct help link.</p>
            </div>
            <div className="mt-6 space-y-6 text-sm text-slate-700">
              <SmtpGuideContent provider={smtpProvider} />
              <section>
                <h4 className="text-base font-semibold text-slate-900">Important notes</h4>
                <div className="mt-3 space-y-3">
                  <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                    <p><span className="font-semibold text-red-700">Avoid</span>{' '}{smtpProvider === 'custom' ? 'Do not guess SMTP details. Use the exact host, port and password given by your mail provider.' : `Do not use your regular ${smtpProviderLabel} login password unless your provider explicitly allows it.`}</p>
                  </div>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                    <p><span className="font-semibold text-emerald-700">Required</span>{' '}{smtpProvider === 'custom' ? 'Use the SMTP password or app password issued by your mail host.' : `Use the app password or secure password flow recommended for ${smtpProviderLabel}.`}</p>
                  </div>
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                    <p><span className="font-semibold text-amber-700">Note</span> Passwords or app passwords may be shown only once, so regenerate if lost.</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <p><span className="font-semibold text-slate-700">Note</span> Keep this password secure and update CRM whenever it changes.</p>
                  </div>
                </div>
              </section>
              {smtpGuideLink && (
                <div className="pt-2">
                  <a href={smtpGuideLink.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors">
                    <ExternalLink size={14} />{smtpGuideLink.label}
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


