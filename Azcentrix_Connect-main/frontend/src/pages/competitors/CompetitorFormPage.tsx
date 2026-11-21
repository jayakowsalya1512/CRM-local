import { useState, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Building2,
  FileText,
  Globe,
  MapPin,
  ShieldAlert,
  Target,
} from 'lucide-react'
import type { ReactNode } from 'react'
import api from '@/services/api'
import FormPageHeader from '@/components/ui/FormPageHeader'
import { FormGrid, useToast, FormCard, useFieldErrors } from '@/components/ui/FormComponents'
import Input, { Textarea } from '@/components/ui/Input'
import SearchableSelect, { MultiSearchableSelect, type SelectOption } from '@/components/ui/SearchableSelect'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { requiredSelectMessage } from '@/utils/masterFieldMessages'
import { inferRule, mapApiErrors, validate as checkField, type FieldSpec, type Rule } from '@/utils/validation'
import { useUIStore } from '@/store'
import { useFormConfig } from '@/hooks/useFormConfig'
import { CustomFields } from '@/components/form/CustomFields'

interface Competitor {
  [key: string]: unknown
  id: number
  name: string
  registration_type?: string | null
  registration_year?: string | null
  country?: string | null
  state?: string | null
  district?: string | null
  city?: string | null
  address?: string | null
  pincode?: string | null
  mobile_no?: string | null
  gst_no?: string | null
  pan_no?: string | null
  email?: string | null
  company_type?: string | null
  directors?: string | null
  manpower_strength?: string | null
  website?: string | null
  strengths?: string | null
  weaknesses?: string | null
  threat_level?: string | null
  market_reputation?: string | null
  oem_partnerships?: string | null
  strong_regions?: string | null
  strong_departments?: string | null
  annual_turnover?: string | null
  support_quality?: string | null
  internal_notes?: string | null
  custom_data?: Record<string, unknown> | null
}

interface CompetitorForm {
  name: string
  registration_type: string
  registration_year: string
  country: string
  state: string
  district: string
  city: string
  address: string
  pincode: string
  mobile_no: string
  gst_no: string
  pan_no: string
  email: string
  company_type: string
  directors: string
  manpower_strength: string
  website: string
  strengths: string
  weaknesses: string
  threat_level: string
  market_reputation: string
  oem_partnerships: string
  strong_regions: string
  strong_departments: string
  annual_turnover: string
  support_quality: string
  internal_notes: string
}

type FormErrors = Partial<Record<keyof CompetitorForm, string>>

interface CompetitorFieldMeta {
  label: string
  required: boolean
  visible: boolean
  sortOrder: number
}

type OrderedCompetitorSectionItem =
  | { kind: 'builtin'; key: keyof CompetitorForm; sortOrder: number; defaultOrder: number }
  | { kind: 'custom'; field: any; sortOrder: number; defaultOrder: number }


type LocationStateOption = {
  value: string
  label: string
  id: number
  region_id?: number | null
  region_name?: string
}

type LocationDistrictOption = {
  value: string
  label: string
  id: number
  state_id: number
  state_name?: string
  region_id?: number | null
  region_name?: string
}

const identityKey = (value: string | null | undefined) =>
  String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

const REGISTRATION_TYPES = [
  'Proprietor',
  'Partnership',
  'Private Limited',
  'Public Limited',
  'LLP',
  'Government',
  'Trust',
  'Other',
].map(value => ({ value, label: value }))

const CURRENT_YEAR = new Date().getFullYear()
const REGISTRATION_YEARS = Array.from({ length: CURRENT_YEAR - 1900 + 1 }, (_item, index) => {
  const value = String(CURRENT_YEAR - index)
  return { value, label: value }
})

const COMPANY_TYPES = [
  'Product',
  'Services',
  'Works Contract Services',
  'System Integrator',
  'Consultant',
  'Distributor',
  'Other',
].map(value => ({ value, label: value }))

const THREAT_LEVELS = ['Low', 'Medium', 'High', 'Critical'].map(value => ({ value, label: value }))
const MARKET_REPUTATIONS = ['Excellent', 'Strong', 'Established', 'Average', 'Limited', 'Weak', 'Unknown'].map(value => ({ value, label: value }))
const MANPOWER_STRENGTH_OPTIONS = ['1 - 25', '26 - 50', '51 - 100', '101 - 250', '251 - 500', '501 - 1000', '1000 Above']
  .map(value => ({ value, label: value }))
const SUPPORT_QUALITY = ['Excellent', 'Good', 'Average', 'Poor', 'Unknown'].map(value => ({ value, label: value }))
const DEPARTMENT_OPTIONS = ['Sales', 'Support', 'Accounts', 'Operations', 'Management', 'IT', 'HR']
  .map(value => ({ value, label: value }))

const PROFILE_FIELD_KEYS = [
  'name',
  'registration_type',
  'registration_year',
  'company_type',
  'gst_no',
  'pan_no',
  'email',
  'mobile_no',
  'manpower_strength',
  'directors',
] as const

const ADDRESS_FIELD_KEYS = [
  'address',
  'pincode',
  'country',
  'state',
  'district',
  'city',
] as const

const MARKET_FIELD_KEYS = [
  'website',
  'annual_turnover',
  'threat_level',
  'support_quality',
  'market_reputation',
] as const

const COVERAGE_FIELD_KEYS = [
  'oem_partnerships',
  'strong_regions',
  'strong_departments',
] as const

const ANALYSIS_FIELD_KEYS = [
  'strengths',
  'weaknesses',
  'internal_notes',
] as const

function parseMultiValue(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return Array.from(new Set(parsed.map(item => String(item).trim()).filter(Boolean)))
      }
    } catch {
      // Legacy text values fall through to delimited parsing.
    }
  }

  return Array.from(new Set(trimmed.split(/[,;\n]+/).map(item => item.trim()).filter(Boolean)))
}

function serializeMultiValue(values: (string | number)[]) {
  return values.map(value => String(value).trim()).filter(Boolean).join(', ')
}

function mergeSelectedOptions(options: SelectOption[], selected: string[]) {
  const byValue = new Map<string, SelectOption>()
  options.forEach(option => byValue.set(String(option.value), option))
  selected.forEach(value => {
    if (!byValue.has(value)) byValue.set(value, { value, label: value })
  })
  return Array.from(byValue.values())
}

function emptyForm(): CompetitorForm {
  return {
    name: '',
    registration_type: '',
    registration_year: '',
    country: 'India',
    state: '',
    district: '',
    city: '',
    address: '',
    pincode: '',
    mobile_no: '',
    gst_no: '',
    pan_no: '',
    email: '',
    company_type: '',
    directors: '',
    manpower_strength: '',
    website: '',
    strengths: '',
    weaknesses: '',
    threat_level: '',
    market_reputation: '',
    oem_partnerships: '',
    strong_regions: '',
    strong_departments: '',
    annual_turnover: '',
    support_quality: '',
    internal_notes: '',
  }
}

function mapCompetitorToForm(row: Competitor): CompetitorForm {
  return {
    name: row.name || '',
    registration_type: row.registration_type || '',
    registration_year: row.registration_year || '',
    country: row.country || 'India',
    state: row.state || '',
    district: row.district || '',
    city: row.city || '',
    address: row.address || '',
    pincode: row.pincode || '',
    mobile_no: row.mobile_no || '',
    gst_no: row.gst_no || '',
    pan_no: row.pan_no || '',
    email: row.email || '',
    company_type: row.company_type || '',
    directors: row.directors || '',
    manpower_strength: row.manpower_strength || '',
    website: row.website || '',
    strengths: row.strengths || '',
    weaknesses: row.weaknesses || '',
    threat_level: row.threat_level || '',
    market_reputation: row.market_reputation || '',
    oem_partnerships: row.oem_partnerships || '',
    strong_regions: row.strong_regions || '',
    strong_departments: row.strong_departments || '',
    annual_turnover: row.annual_turnover || '',
    support_quality: row.support_quality || '',
    internal_notes: row.internal_notes || '',
  }
}

// format rule + max length per built-in field; required flags come from the field meta (Form Builder overrides)
const COMP_RULES: Record<string, Partial<FieldSpec>> = {
  name: { rule: 'name', min: 2, max: 200 }, registration_type: { rule: 'select' }, registration_year: { rule: 'integer', min: 1800, max: new Date().getFullYear() },
  company_type: { rule: 'select' }, gst_no: { rule: 'gstin' }, pan_no: { rule: 'pan' }, email: { rule: 'email' }, mobile_no: { rule: 'mobile' },
  manpower_strength: { rule: 'select' }, directors: { rule: 'textarea', max: 2000 },
  address: { rule: 'text', min: 2, max: 500 }, pincode: { rule: 'pincode' }, country: { rule: 'text', min: 2, max: 100 }, state: { rule: 'select' },
  district: { rule: 'select' }, city: { rule: 'text', min: 2, max: 100 },
  website: { rule: 'url' }, annual_turnover: { rule: 'text', max: 100 }, threat_level: { rule: 'select' }, support_quality: { rule: 'select' }, market_reputation: { rule: 'select' },
  strengths: { rule: 'textarea', max: 2000 }, weaknesses: { rule: 'textarea', max: 2000 }, internal_notes: { rule: 'textarea', max: 5000 },
}
const COMP_FIELD_ORDER = Object.keys(COMP_RULES)

function cleanPayload(form: CompetitorForm) {
  return Object.fromEntries(
    Object.entries(form)
      .map(([key, value]) => [key, typeof value === 'string' ? value.trim() || null : value]),
  )
}

export default function CompetitorFormPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const competitor = location.state?.competitor as Competitor | undefined
  const isEdit = !!(competitor?.id)

  const { label: moduleLabel, singular, singularLower } = useModuleName('competitors')
  const { success, error: showError } = useToast()

  const [form, setForm] = useState<CompetitorForm>(() => competitor ? mapCompetitorToForm(competitor) : emptyForm())
  const { fieldErrors: errors, setFieldErrors: setErrors, clearFieldError } = useFieldErrors()
  // the message itself is passed to the field (Input / Textarea / SearchableSelect render it under the field with a red border)
  const errProp = (key: string): string | undefined => errors[key] || undefined
  const touched = useRef<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [locationStates, setLocationStates] = useState<LocationStateOption[]>([])
const [locationDistricts, setLocationDistricts] = useState<LocationDistrictOption[]>([])

  const [oemOptions, setOemOptions] = useState<SelectOption[]>([])
  const [regionOptions, setRegionOptions] = useState<SelectOption[]>([])
  const [customData, setCustomData] = useState<Record<string, unknown>>(() => competitor?.custom_data ?? {})
  const { fields: formConfigFields } = useFormConfig('competitors')
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore()
  const wasCollapsed = useRef(sidebarCollapsed)

  useEffect(() => {
    setSidebarCollapsed(true)
    return () => { setSidebarCollapsed(wasCollapsed.current) }
  }, [])

  useEffect(() => {
    const loadDetailOptions = async () => {
      const [oemsResponse, regionsResponse, statesResponse, districtsResponse] = await Promise.all([
  api.get('/masters/oems').catch(() => ({ data: [] })),
  api.get('/masters/regions').catch(() => ({ data: [] })),
  api.get('/masters/states').catch(() => ({ data: [] })),
  api.get('/masters/districts').catch(() => ({ data: [] })),
])

      setOemOptions((Array.isArray(oemsResponse.data) ? oemsResponse.data : [])
        .map((item: any) => String(item.name || '').trim())
        .filter(Boolean)
        .map((name: string) => ({ value: name, label: name })))
      setRegionOptions((Array.isArray(regionsResponse.data) ? regionsResponse.data : [])
        .map((item: any) => String(item.name || '').trim())
        .filter(Boolean)
        .map((name: string) => ({ value: name, label: name })))
        setLocationStates(
          (Array.isArray(statesResponse.data) ? statesResponse.data : [])
            .filter((item: any) => item?.name)
            .map((item: any) => ({
              value: String(item.name || ''),
              label: item.region_name ? `${item.name} - ${item.region_name}` : String(item.name || ''),
              id: Number(item.id),
              region_id: item.region_id ?? null,
              region_name: item.region_name ?? '',
            }))
        )

        setLocationDistricts(
          (Array.isArray(districtsResponse.data) ? districtsResponse.data : [])
            .filter((item: any) => item?.name)
            .map((item: any) => ({
              value: String(item.name || ''),
              label: item.state_name ? `${item.name} - ${item.state_name}` : String(item.name || ''),
              id: Number(item.id),
              state_id: Number(item.state_id),
              state_name: item.state_name ?? '',
              region_id: item.region_id ?? null,
              region_name: item.region_name ?? '',
            }))
        )
    }

    void loadDetailOptions()
  }, [])

  const putErr = (k: string, msg: string) => setErrors(prev => {
    if ((prev[k] || '') === msg) return prev
    const n = { ...prev }; if (msg) n[k] = msg; else delete n[k]; return n
  })
  const msgFor = (k: string, v: any, s: FieldSpec) => {
    const m = checkField(v, s)
    if (m && k === 'state' && !String(v || '').trim()) return requiredSelectMessage(s.label, locationStates)
    if (m && k === 'district' && !String(v || '').trim()) return requiredSelectMessage(s.label, districtOptions, { available: !!form.state })
    return m
  }
  // change: format errors show immediately, "required" only once the field was left (or on save); blur: full check
  const check = (k: string, v: any, mode: 'change' | 'blur') => {
    const s = specFor(k)
    if (!s) { putErr(k, ''); return }
    if (mode === 'blur') touched.current.add(k)
    const full = msgFor(k, v, s)
    putErr(k, mode === 'change' && !touched.current.has(k) && full && !checkField(v, { ...s, required: false }) ? '' : full)
  }
  const setF = <K extends keyof CompetitorForm>(key: K, value: CompetitorForm[K]) => {
    setForm(prev => ({ ...prev, [key]: value }))
    check(key as string, value, 'change')
  }
  const leave = (k: keyof CompetitorForm) => () => check(k as string, form[k], 'blur')

  // const handlePincodeChange = async (value: string) => {
  //   const pincode = value.replace(/\D/g, '').slice(0, 6)
  //   setF('pincode', pincode)
  //   if (pincode.length !== 6) {
  //     setPincodeAddressLocked(false)
  //     return
  //   }

  //   setPincodeLoading(true)
  //   try {
  //     const response = await api.get(`/masters/pincode/${pincode}`)
  //     const data = response.data || {}
  //     if (!data.found) {
  //       setPincodeAddressLocked(false)
  //       return
  //     }
  //     setForm(prev => ({
  //       ...prev,
  //       country: data.country || prev.country || 'India',
  //       state: data.state || prev.state,
  //       district: data.city || prev.district,
  //       city: data.area || prev.city,
  //     }))
  //     setPincodeAddressLocked(true)
  //   } catch {
  //     setPincodeAddressLocked(false)
  //   } finally {
  //     setPincodeLoading(false)
  //   }
  // }

  const handlePincodeChange = (value: string) => {
  const pincode = value.replace(/\D/g, '').slice(0, 6)
  setF('pincode', pincode)
}

const getSelectedStateId = (stateName: string) => {
  const selected = locationStates.find(
    state => identityKey(state.value) === identityKey(stateName)
  )

  return selected?.id ?? null
}

const getDistrictOptionsByState = (stateName: string): SelectOption[] => {
  const selectedStateId = getSelectedStateId(stateName)

  if (!selectedStateId) return []

  return locationDistricts
    .filter(district => Number(district.state_id) === Number(selectedStateId))
    .map(district => ({
      value: district.value,
      label: district.label,
    }))
}

  // scroll to and focus the first field showing an error (after React has rendered the messages)
  const focusFirstError = () => setTimeout(() => {
    const el = document.querySelector<HTMLElement>('main .form-control.error, main .error input, main [aria-invalid="true"]')
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); try { el.focus({ preventScroll: true }) } catch { el.focus() } }
  }, 0)

  const handleSave = async () => {
    const nextErrors: FormErrors = {}
    COMP_FIELD_ORDER.forEach(k => {
      touched.current.add(k)
      const s = specFor(k)
      const m = s ? msgFor(k, (form as any)[k], s) : ''
      if (m) nextErrors[k as keyof CompetitorForm] = m
    })
    // tenant custom fields (Form Builder): required flag + rule inferred from key / label / type
    const customErr = formConfigFields.filter(f => f.is_custom && f.is_visible !== false).map(f =>
      checkField(customData[f.field_key] as any, { label: f.label, required: !!f.is_required, rule: inferRule(f.field_key, f.label, f.field_type) as Rule })).find(Boolean)
    if (Object.keys(nextErrors).length > 0 || customErr) {
      setErrors(nextErrors)
      if (nextErrors.state && locationStates.length === 0) {
        showError(requiredSelectMessage('State', locationStates))
      } else if (nextErrors.district && form.state && districtOptions.length === 0) {
        showError(requiredSelectMessage('City / District', districtOptions))
      } else if (!Object.keys(nextErrors).length && customErr) {
        showError(customErr)
      }
      focusFirstError()
      return
    }
    setSaving(true)
    try {
      const payload = {
        ...cleanPayload(form),
        custom_data: Object.keys(customData).length ? customData : null,
      }
      if (isEdit) {
        await api.put(`/masters/competitors/${competitor.id}`, payload)
        success(`${singular} saved`)
      } else {
        await api.post('/masters/competitors', payload)
        success(`${singular} saved`)
      }
      navigate('/competitors')
    } catch (e: any) {
      // field errors from the API land under their fields; a duplicate name (409) belongs to the name field
      const detail = e.response?.data?.detail
      const fx = Object.fromEntries(Object.entries(mapApiErrors(e)).filter(([k]) => COMP_FIELD_ORDER.includes(k)))
      if (e.response?.status === 409 && typeof detail === 'string' && !Object.keys(fx).length) fx.name = detail
      if (Object.keys(fx).length) { setErrors(prev => ({ ...prev, ...fx })); focusFirstError() }
      else showError(typeof detail === 'string' ? detail : `Failed to save ${singularLower}`)
    } finally {
      setSaving(false)
    }
  }

  const selectedOemPartnerships = useMemo(() => parseMultiValue(form.oem_partnerships), [form.oem_partnerships])
  const selectedStrongRegions = useMemo(() => parseMultiValue(form.strong_regions), [form.strong_regions])
  const selectedStrongDepartments = useMemo(() => parseMultiValue(form.strong_departments), [form.strong_departments])
  const oemPartnershipOptions = useMemo(
    () => mergeSelectedOptions(oemOptions, selectedOemPartnerships),
    [oemOptions, selectedOemPartnerships],
  )
  const strongRegionOptions = useMemo(
    () => mergeSelectedOptions(regionOptions, selectedStrongRegions),
    [regionOptions, selectedStrongRegions],
  )
  const strongDepartmentOptions = useMemo(
    () => mergeSelectedOptions(DEPARTMENT_OPTIONS, selectedStrongDepartments),
    [selectedStrongDepartments],
  )
  const registrationYearOptions = useMemo(
    () => mergeSelectedOptions(REGISTRATION_YEARS, form.registration_year ? [form.registration_year] : []),
    [form.registration_year],
  )
  const marketReputationOptions = useMemo(
    () => mergeSelectedOptions(MARKET_REPUTATIONS, form.market_reputation ? [form.market_reputation] : []),
    [form.market_reputation],
  )


  const builtinFieldOverrides = useMemo(() => {
    const map = new Map<string, any>()

    formConfigFields
      .filter(field => !field.is_custom)
      .forEach(field => {
        map.set(`${field.section}.${field.field_key}`, field)
      })

    return map
  }, [formConfigFields])

  const fieldMeta = (
    section: string,
    key: keyof CompetitorForm,
    fallbackLabel: string,
    fallbackRequired = false,
    fallbackSortOrder = 0,
  ): CompetitorFieldMeta => {
    const override = builtinFieldOverrides.get(`${section}.${key}`)

    return {
      label: override?.label || fallbackLabel,
      required: override?.is_required ?? fallbackRequired,
      visible: override?.is_visible ?? true,
      sortOrder: override?.sort_order && override.sort_order > 0 ? override.sort_order : fallbackSortOrder,
    }
  }

  const profileFieldMeta = useMemo<Record<string, CompetitorFieldMeta>>(() => ({
    name: fieldMeta('profile', 'name', `${singular} Name`, true),
    registration_type: fieldMeta('profile', 'registration_type', 'Registration Type'),
    registration_year: fieldMeta('profile', 'registration_year', 'Registration Year'),
    company_type: fieldMeta('profile', 'company_type', 'Type Of Company'),
    gst_no: fieldMeta('profile', 'gst_no', 'GST No'),
    pan_no: fieldMeta('profile', 'pan_no', 'PAN No'),
    email: fieldMeta('profile', 'email', 'Email'),
    mobile_no: fieldMeta('profile', 'mobile_no', 'Mobile No'),
    manpower_strength: fieldMeta('profile', 'manpower_strength', 'Manpower Strength'),
    directors: fieldMeta('profile', 'directors', 'Directors'),
  }), [builtinFieldOverrides, singular])

  const addressFieldMeta = useMemo<Record<string, CompetitorFieldMeta>>(() => ({
    address: fieldMeta('address', 'address', 'Street Address', true),
    pincode: fieldMeta('address', 'pincode', 'Pincode', true),
    country: fieldMeta('address', 'country', 'Country', true),
    state: fieldMeta('address', 'state', 'State', true),
    district: fieldMeta('address', 'district', 'City / District', true),
    city: fieldMeta('address', 'city', 'Area / Locality', true),
  }), [builtinFieldOverrides])

  const marketFieldMeta = useMemo<Record<string, CompetitorFieldMeta>>(() => ({
    website: fieldMeta('market', 'website', 'Website'),
    annual_turnover: fieldMeta('market', 'annual_turnover', 'Annual Turnover'),
    threat_level: fieldMeta('market', 'threat_level', 'Threat Level'),
    support_quality: fieldMeta('market', 'support_quality', 'Support Quality'),
    market_reputation: fieldMeta('market', 'market_reputation', 'Market Reputation'),
  }), [builtinFieldOverrides])

  const coverageFieldMeta = useMemo<Record<string, CompetitorFieldMeta>>(() => ({
    oem_partnerships: fieldMeta('coverage', 'oem_partnerships', 'OEM Partnerships'),
    strong_regions: fieldMeta('coverage', 'strong_regions', 'Strong Regions'),
    strong_departments: fieldMeta('coverage', 'strong_departments', 'Strong Departments'),
  }), [builtinFieldOverrides])

  const analysisFieldMeta = useMemo<Record<string, CompetitorFieldMeta>>(() => ({
    strengths: fieldMeta('analysis', 'strengths', 'Strengths'),
    weaknesses: fieldMeta('analysis', 'weaknesses', 'Weaknesses'),
    internal_notes: fieldMeta('analysis', 'internal_notes', 'Internal Notes'),
  }), [builtinFieldOverrides])

  const specFor = (k: string): FieldSpec | undefined => {
    const m = profileFieldMeta[k] ?? addressFieldMeta[k] ?? marketFieldMeta[k] ?? analysisFieldMeta[k]
    if (!m || !m.visible || !COMP_RULES[k]) return undefined
    return { label: m.label, required: m.required, ...COMP_RULES[k] }
  }

  const customFieldsForSection = (section: string) => (
    formConfigFields
      .filter(field => field.section === section && field.is_custom)
      .sort((a, b) => {
        const aOrder = a.sort_order && a.sort_order > 0 ? a.sort_order : Number.MAX_SAFE_INTEGER
        const bOrder = b.sort_order && b.sort_order > 0 ? b.sort_order : Number.MAX_SAFE_INTEGER
        if (aOrder !== bOrder) return aOrder - bOrder
        return a.id - b.id
      })
  )

  const orderedSectionItems = (
    section: string,
    keys: readonly (keyof CompetitorForm)[],
    metaMap: Record<string, CompetitorFieldMeta>,
  ): OrderedCompetitorSectionItem[] => {
    const builtins: OrderedCompetitorSectionItem[] = keys.map((key, index) => ({
      kind: 'builtin',
      key,
      sortOrder: metaMap[key]?.sortOrder && metaMap[key].sortOrder > 0 ? metaMap[key].sortOrder : index + 1,
      defaultOrder: index + 1,
    }))

    const custom = customFieldsForSection(section).map((field, index) => ({
      kind: 'custom' as const,
      field,
      sortOrder: field.sort_order && field.sort_order > 0 ? field.sort_order : keys.length + index + 1,
      defaultOrder: keys.length + index + 1,
    }))

    return [...builtins, ...custom].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
      return a.defaultOrder - b.defaultOrder
    })
  }

  const orderedProfileItems = useMemo(
    () => orderedSectionItems('profile', PROFILE_FIELD_KEYS, profileFieldMeta),
    [formConfigFields, profileFieldMeta],
  )

  const orderedAddressItems = useMemo(
    () => orderedSectionItems('address', ADDRESS_FIELD_KEYS, addressFieldMeta),
    [formConfigFields, addressFieldMeta],
  )

  const orderedMarketItems = useMemo(
    () => orderedSectionItems('market', MARKET_FIELD_KEYS, marketFieldMeta),
    [formConfigFields, marketFieldMeta],
  )

  const orderedCoverageItems = useMemo(
    () => orderedSectionItems('coverage', COVERAGE_FIELD_KEYS, coverageFieldMeta),
    [formConfigFields, coverageFieldMeta],
  )

  const orderedAnalysisItems = useMemo(
    () => orderedSectionItems('analysis', ANALYSIS_FIELD_KEYS, analysisFieldMeta),
    [formConfigFields, analysisFieldMeta],
  )

  const renderCustomField = (section: string, field: any) => (
    <CustomFields
      key={`custom-${section}-${field.id}`}
      section={section}
      fields={[field]}
      values={customData}
      onChange={(key, value) => setCustomData(prev => ({ ...prev, [key]: value }))}
    />
  )

  const renderProfileField = (key: keyof CompetitorForm) => {
    const meta = profileFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'name') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.name}
          error={errProp('name')}
          onBlur={leave('name')}
          onChange={e => setF('name', e.target.value)}
        />
      )
    }

    if (key === 'registration_type') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={REGISTRATION_TYPES}
          error={errProp('registration_type')}
          value={form.registration_type || null}
          onChange={v => setF('registration_type', String(v || ''))}
          clearable
        />
      )
    }

    if (key === 'registration_year') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={registrationYearOptions}
          value={form.registration_year || null}
          error={errProp('registration_year')}
          onChange={v => setF('registration_year', String(v || ''))}
          placeholder="Select year"
          clearable
        />
      )
    }

    if (key === 'company_type') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={COMPANY_TYPES}
          error={errProp('company_type')}
          value={form.company_type || null}
          onChange={v => setF('company_type', String(v || ''))}
          clearable
        />
      )
    }

    if (key === 'gst_no') {
      return <Input key={key} label={meta.label} required={meta.required} value={form.gst_no} error={errProp('gst_no')} onBlur={leave('gst_no')} onChange={e => setF('gst_no', e.target.value.toUpperCase())} />
    }

    if (key === 'pan_no') {
      return <Input key={key} label={meta.label} required={meta.required} value={form.pan_no} error={errProp('pan_no')} onBlur={leave('pan_no')} onChange={e => setF('pan_no', e.target.value.toUpperCase())} />
    }

    if (key === 'email') {
      return <Input key={key} label={meta.label} required={meta.required} type="email" value={form.email} error={errProp('email')} onBlur={leave('email')} onChange={e => setF('email', e.target.value)} />
    }

    if (key === 'mobile_no') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          inputMode="numeric"
          maxLength={10}
          value={form.mobile_no}
          error={errProp('mobile_no')}
          onBlur={leave('mobile_no')}
          onChange={e => setF('mobile_no', e.target.value.replace(/\D/g, '').slice(0, 10))}
        />
      )
    }

    if (key === 'manpower_strength') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={MANPOWER_STRENGTH_OPTIONS}
          error={errProp('manpower_strength')}
          value={form.manpower_strength || null}
          onChange={v => setF('manpower_strength', String(v || ''))}
          placeholder="Select manpower strength"
          clearable
        />
      )
    }

    if (key === 'directors') {
      return (
        <div key={key} className="sm:col-span-3">
          <Textarea
            label={meta.label}
            rows={3}
            value={form.directors}
            error={errProp('directors')}
            onBlur={leave('directors')}
            onChange={e => setF('directors', e.target.value)}
          />
        </div>
      )
    }

    return null
  }

  const renderAddressField = (key: keyof CompetitorForm) => {
    const meta = addressFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'address') {
      return <Input key={key} label={meta.label} required={meta.required} value={form.address} error={errProp('address')} onBlur={leave('address')} onChange={e => setF('address', e.target.value)} />
    }

    if (key === 'pincode') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          inputMode="numeric"
          maxLength={6}
          value={form.pincode}
          error={errProp('pincode')}
          onBlur={leave('pincode')}
          onChange={e => handlePincodeChange(e.target.value)}
        />
      )
    }

    if (key === 'country') {
      return <Input key={key} label={meta.label} required={meta.required} value={form.country} error={errProp('country')} onBlur={leave('country')} onChange={e => setF('country', e.target.value)} />
    }

    if (key === 'state') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={locationStates}
          value={form.state || null}
          error={errProp('state')}
          onChange={value => {
            setForm(prev => ({
              ...prev,
              state: value ? String(value) : '',
              district: '',
            }))
            check('state', value ? String(value) : '', 'change')
            clearFieldError('district')
          }}
          placeholder="Select state"
          clearable
        />
      )
    }

    if (key === 'district') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={districtOptions}
          value={form.district || null}
          error={errProp('district')}
          onChange={value => {
            setF('district', value ? String(value) : '')
          }}
          placeholder={form.state ? 'Select district' : 'Select state first'}
          disabled={!form.state}
          clearable
        />
      )
    }

    if (key === 'city') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.city}
          error={errProp('city')}
          onBlur={leave('city')}
          placeholder="Enter area / locality"
          onChange={e => setF('city', e.target.value)}
        />
      )
    }

    return null
  }

  const renderMarketField = (key: keyof CompetitorForm) => {
    const meta = marketFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'website') {
      return <Input key={key} label={meta.label} required={meta.required} value={form.website} error={errProp('website')} onBlur={leave('website')} onChange={e => setF('website', e.target.value)} />
    }

    if (key === 'annual_turnover') {
      return <Input key={key} label={meta.label} required={meta.required} value={form.annual_turnover} error={errProp('annual_turnover')} onBlur={leave('annual_turnover')} onChange={e => setF('annual_turnover', e.target.value)} />
    }

    if (key === 'threat_level') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={THREAT_LEVELS}
          error={errProp('threat_level')}
          value={form.threat_level || null}
          onChange={v => setF('threat_level', String(v || ''))}
          clearable
        />
      )
    }

    if (key === 'support_quality') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={SUPPORT_QUALITY}
          error={errProp('support_quality')}
          value={form.support_quality || null}
          onChange={v => setF('support_quality', String(v || ''))}
          clearable
        />
      )
    }

    if (key === 'market_reputation') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={marketReputationOptions}
          error={errProp('market_reputation')}
          value={form.market_reputation || null}
          onChange={v => setF('market_reputation', String(v || ''))}
          clearable
        />
      )
    }

    return null
  }

  const renderCoverageField = (key: keyof CompetitorForm) => {
    const meta = coverageFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'oem_partnerships') {
      return (
        <MultiSearchableSelect
          key={key}
          label={meta.label}
          options={oemPartnershipOptions}
          value={selectedOemPartnerships}
          onChange={values => setF('oem_partnerships', serializeMultiValue(values))}
          placeholder="Select OEM partnerships..."
        />
      )
    }

    if (key === 'strong_regions') {
      return (
        <MultiSearchableSelect
          key={key}
          label={meta.label}
          options={strongRegionOptions}
          value={selectedStrongRegions}
          onChange={values => setF('strong_regions', serializeMultiValue(values))}
          placeholder="Select strong regions..."
        />
      )
    }

    if (key === 'strong_departments') {
      return (
        <MultiSearchableSelect
          key={key}
          label={meta.label}
          options={strongDepartmentOptions}
          value={selectedStrongDepartments}
          onChange={values => setF('strong_departments', serializeMultiValue(values))}
          placeholder="Select strong departments..."
        />
      )
    }

    return null
  }

  const renderAnalysisField = (key: keyof CompetitorForm) => {
    const meta = analysisFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'strengths') {
      return <Textarea key={key} label={meta.label} rows={3} value={form.strengths} error={errProp('strengths')} onBlur={leave('strengths')} onChange={e => setF('strengths', e.target.value)} />
    }

    if (key === 'weaknesses') {
      return <Textarea key={key} label={meta.label} rows={3} value={form.weaknesses} error={errProp('weaknesses')} onBlur={leave('weaknesses')} onChange={e => setF('weaknesses', e.target.value)} />
    }

    if (key === 'internal_notes') {
      return (
        <div key={key} className="sm:col-span-3">
          <Textarea
            label={meta.label}
            rows={4}
            value={form.internal_notes}
            error={errProp('internal_notes')}
            onBlur={leave('internal_notes')}
            onChange={e => setF('internal_notes', e.target.value)}
          />
        </div>
      )
    }

    return null
  }


  const districtOptions = getDistrictOptionsByState(form.state)

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="w-full">
        <div className="bg-white border border-slate-200 shadow-sm">
          <FormPageHeader
            breadcrumb={moduleLabel}
            onBreadcrumbClick={() => navigate('/competitors')}
            title={singular}
            isEdit={isEdit}
            onCancel={() => navigate('/competitors')}
            onSave={handleSave}
            saving={saving}
          />
          <main className="min-w-0">
            {/* Profile section */}
            <FormCard id="profile" title="Profile" icon={Building2}>
              <FormGrid cols={3}>
                {orderedProfileItems.map(item => (
                  item.kind === 'custom'
                    ? renderCustomField('profile', item.field)
                    : renderProfileField(item.key)
                ))}
              </FormGrid>
            </FormCard>

            {/* Address section */}
            <FormCard id="address" title={`${singular} Address`} icon={MapPin}>
              <FormGrid cols={3}>
                {orderedAddressItems.map(item => (
                  item.kind === 'custom'
                    ? renderCustomField('address', item.field)
                    : renderAddressField(item.key)
                ))}
              </FormGrid>
            </FormCard>

            {/* Market Profile section */}
            <FormCard id="market" title="Market Profile" icon={Target}>
              <FormGrid cols={3}>
                {orderedMarketItems.map(item => (
                  item.kind === 'custom'
                    ? renderCustomField('market', item.field)
                    : renderMarketField(item.key)
                ))}
              </FormGrid>
            </FormCard>

            {/* Competitive Coverage section */}
            <FormCard id="coverage" title="Competitive Coverage" icon={ShieldAlert}>
              <FormGrid cols={3}>
                {orderedCoverageItems.map(item => (
                  item.kind === 'custom'
                    ? renderCustomField('coverage', item.field)
                    : renderCoverageField(item.key)
                ))}
              </FormGrid>
            </FormCard>

            {/* Analysis section */}
            <FormCard id="analysis" title="Analysis" icon={FileText}>
              <FormGrid cols={3}>
                {orderedAnalysisItems.map(item => (
                  item.kind === 'custom'
                    ? renderCustomField('analysis', item.field)
                    : renderAnalysisField(item.key)
                ))}
              </FormGrid>
            </FormCard>
          </main>
        </div>
      </div>
    </div>
  )
}
