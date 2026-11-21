import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Package, User, FileText, Building2 } from 'lucide-react'
import api from '@/services/api'
import FormPageHeader from '@/components/ui/FormPageHeader'
import { FormGrid, useToast, DatePicker, FormCard, useFieldErrors } from '@/components/ui/FormComponents'
import Input from '@/components/ui/Input'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { useUIStore } from '@/store'
import { useFormConfig } from '@/hooks/useFormConfig'
import { CustomFields } from '@/components/form/CustomFields'
import { requiredSelectMessage } from '@/utils/masterFieldMessages'
import FieldError from '@/components/form/FieldError'
import { inferRule, mapApiErrors, validate as checkField, type FieldSpec, type Rule } from '@/utils/validation'

const emptyForm = {
  type: 'OEM',
  name: '', product_id: '', contact_name: '', contact_designation: '', contact_email: '',
  contact_phone: '', account_manager: '', auth_date: '', auth_number: '',
  support_sla: '', credit_limit: '', payment_terms: '', notes: '', brands_handled: ''
}

type FormErrors = Record<string, string>

type OemFieldMeta = {
  label: string
  required: boolean
  visible: boolean
  sortOrder: number
}

type OrderedOemSectionItem =
  | { kind: 'builtin'; key: string; sortOrder: number; defaultOrder: number }
  | { kind: 'custom'; field: any; sortOrder: number; defaultOrder: number }

const OEM_DETAILS_FIELD_KEYS = [
  'name',
  'product_id',
  'account_manager',
  'auth_number',
  'auth_date',
  'support_sla',
  'credit_limit',
  'payment_terms',
  'brands_handled',
] as const

const CONTACT_FIELD_KEYS = [
  'contact_name',
  'contact_designation',
  'contact_phone',
  'contact_email',
] as const

const OEM_NOTES_FIELD_KEYS = [
  'notes',
] as const

// ── Validation ───────────────────────────────────────────────────────────────
// format rule + max length per built-in field (lengths follow the OEM table columns); required flags come from the
// field meta (Form Builder overrides), custom fields are inferred from their key / label / type.
const OEM_RULES: Record<string, Partial<FieldSpec>> = {
  name: { rule: 'name', min: 2, max: 200 }, product_id: { rule: 'select' }, account_manager: { rule: 'name', min: 2, max: 100 },
  auth_number: { rule: 'text', max: 100 }, auth_date: { rule: 'date' }, support_sla: { rule: 'text', max: 50 },
  credit_limit: { rule: 'amount', max: 1e13 }, payment_terms: { rule: 'text', max: 100 }, brands_handled: { rule: 'textarea', max: 5000 },
  contact_name: { rule: 'name', min: 2, max: 100 }, contact_designation: { rule: 'text', min: 2, max: 200 },
  contact_phone: { rule: 'mobile' }, contact_email: { rule: 'email' }, notes: { rule: 'textarea', max: 5000 },
}
const OEM_FIELD_ORDER = ['name', 'product_id', 'account_manager', 'auth_number', 'auth_date', 'support_sla', 'credit_limit', 'payment_terms', 'brands_handled',
  'contact_name', 'contact_designation', 'contact_phone', 'contact_email', 'notes']

// ── Type Toggle ──────────────────────────────────────────────────────────────
function TypeToggle({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg w-fit">
      {['OEM', 'Distributor'].map(t => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
            value === t
              ? 'bg-white text-blue-700 shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  )
}

// ── Number to Words ───────────────────────────────────────────────────────────
function numberToWords(num: number): string {
  if (!num) return ''
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  const inWords = (n: number): string => {
    if (n < 20) return a[n]
    if (n < 100) return b[Math.floor(n / 10)] + ' ' + a[n % 10]
    if (n < 1000) return a[Math.floor(n / 100)] + ' Hundred ' + inWords(n % 100)
    if (n < 100000) return inWords(Math.floor(n / 1000)) + ' Thousand ' + inWords(n % 1000)
    if (n < 10000000) return inWords(Math.floor(n / 100000)) + ' Lakh ' + inWords(n % 100000)
    return inWords(Math.floor(n / 10000000)) + ' Crore ' + inWords(n % 10000000)
  }
  return inWords(num).trim() + ' Only'
}

// ── OEM Form Page ────────────────────────────────────────────────────────────
export default function OEMFormPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const oem = location.state?.oem
  const isEdit = !!oem?.id
  const { label: moduleLabel, singular } = useModuleName('oems')
  const { success, error: showError } = useToast()

  const [form, setForm] = useState<any>(
    oem
      ? {
          type: oem.type || 'OEM',
          name: oem.name || '',
          product_id: oem.product_id || '',
          contact_name: oem.contact_name || '',
          contact_designation: oem.contact_designation || '',
          contact_email: oem.contact_email || '',
          contact_phone: oem.contact_phone || '',
          account_manager: oem.account_manager || '',
          auth_date: oem.auth_date || '',
          auth_number: oem.auth_number || '',
          support_sla: oem.support_sla || '',
          credit_limit: oem.credit_limit || '',
          payment_terms: oem.payment_terms || '',
          notes: oem.notes || '',
          brands_handled: oem.brands_handled || '',
          id: oem.id || '',
        }
      : emptyForm
  )
  const [customData, setCustomData] = useState<Record<string, unknown>>(oem?.custom_data ?? {})
  const { fieldErrors: errors, setFieldErrors: setErrors } = useFieldErrors()
  // the message itself is passed to the field (Input / Select / DatePicker render it under the field with a red border)
  const errProp = (key: string): string | undefined => errors[key] || undefined
  const touched = useRef<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [cat, setCat] = useState<any[]>([])
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore()
  const wasCollapsed = useRef(sidebarCollapsed)

  const {
    fields: formConfigFields,
  } = useFormConfig('oem')

  useEffect(() => {
    setSidebarCollapsed(true)
    return () => { setSidebarCollapsed(wasCollapsed.current) }
  }, [])

  useEffect(() => {
    api.get('/oems/categorys').then(r => setCat(r.data.cat)).catch(() => {})
  }, [])

  const catOptions = cat.map(c => ({ value: c.id, label: c.category }))

  const putErr = (k: string, msg: string) => setErrors(prev => {
    if ((prev[k] || '') === msg) return prev
    const n = { ...prev }; if (msg) n[k] = msg; else delete n[k]; return n
  })
  // change: format errors show immediately, "required" only once the field was left (or on save); blur: full check
  const check = (k: string, v: any, mode: 'change' | 'blur') => {
    const s = specFor(k)
    if (!s) { putErr(k, ''); return }
    if (mode === 'blur') touched.current.add(k)
    const full = checkField(v, s) && (k === 'product_id' ? requiredSelectMessage('Category / Product Line', catOptions) : checkField(v, s))
    putErr(k, mode === 'change' && !touched.current.has(k) && full && !checkField(v, { ...s, required: false }) ? '' : full)
  }
  const setF = (k: string, v: any) => {
    setForm((p: any) => ({ ...p, [k]: v }))
    check(k, v, 'change')
  }
  const leave = (k: string) => () => check(k, form[k], 'blur')

  const isOEM = form.type === 'OEM'
  const nameLabel       = isOEM ? `${singular} / Brand Name`     : 'Distributor Name'
  const namePlaceholder = isOEM ? 'e.g. HP, Dell, Cisco'         : 'e.g. ABC Distributors Pvt Ltd'
  const authLabel       = isOEM ? 'Auth Certificate No.'         : 'Distributor Code / Ref No.'
  const authDateLabel   = isOEM ? 'Auth Expiry Date'             : 'Agreement Expiry Date'
  const amLabel         = isOEM ? 'Account Manager'              : 'Relationship Manager'

  const builtinFieldOverrides = useMemo(() => {
    const map = new Map<string, any>()

    formConfigFields
      .filter(field => !field.is_custom)
      .forEach(field => {
        map.set(`${field.section}.${field.field_key}`, field)
      })

    return map
  }, [formConfigFields])

  const fieldMeta = useCallback((
    section: string,
    key: string,
    fallbackLabel: string,
    fallbackRequired = false,
    fallbackSortOrder = 0,
  ): OemFieldMeta => {
    const override = builtinFieldOverrides.get(`${section}.${key}`)

    return {
      label: override?.label || fallbackLabel,
      required: override?.is_required ?? fallbackRequired,
      visible: override?.is_visible ?? true,
      sortOrder: override?.sort_order && override.sort_order > 0
        ? override.sort_order
        : fallbackSortOrder,
    }
  }, [builtinFieldOverrides])

  const oemDetailsFieldMeta = useMemo<Record<string, OemFieldMeta>>(() => ({
    name: fieldMeta('oem_details', 'name', nameLabel, true),
    product_id: fieldMeta('oem_details', 'product_id', 'Category / Product Line', true),
    account_manager: fieldMeta('oem_details', 'account_manager', amLabel, true),
    auth_number: fieldMeta('oem_details', 'auth_number', authLabel, true),
    auth_date: fieldMeta('oem_details', 'auth_date', authDateLabel, true),
    support_sla: fieldMeta('oem_details', 'support_sla', 'Support SLA', true),
    credit_limit: fieldMeta('oem_details', 'credit_limit', 'Credit Limit (₹)', true),
    payment_terms: fieldMeta('oem_details', 'payment_terms', 'Payment Terms', true),
    brands_handled: fieldMeta('oem_details', 'brands_handled', 'Brands / OEMs Handled', !isOEM),
  }), [fieldMeta, nameLabel, amLabel, authLabel, authDateLabel, isOEM])

  const contactFieldMeta = useMemo<Record<string, OemFieldMeta>>(() => ({
    contact_name: fieldMeta('contact', 'contact_name', 'Contact Name', true),
    contact_designation: fieldMeta('contact', 'contact_designation', 'Designation', true),
    contact_phone: fieldMeta('contact', 'contact_phone', 'Phone', true),
    contact_email: fieldMeta('contact', 'contact_email', 'Email', true),
  }), [fieldMeta])

  const notesFieldMeta = useMemo<Record<string, OemFieldMeta>>(() => ({
    notes: fieldMeta('oem_notes', 'notes', 'Notes'),
  }), [fieldMeta])

  const specFor = (k: string): FieldSpec | undefined => {
    const m = oemDetailsFieldMeta[k] ?? contactFieldMeta[k] ?? notesFieldMeta[k]
    if (!m || !m.visible || !OEM_RULES[k] || (k === 'brands_handled' && isOEM)) return undefined
    return { label: m.label, required: m.required, ...OEM_RULES[k] }
  }

  const customFieldsForSection = useCallback((section: string) => (
    formConfigFields
      .filter(field => field.section === section && field.is_custom)
      .sort((a, b) => {
        const aOrder = a.sort_order && a.sort_order > 0 ? a.sort_order : Number.MAX_SAFE_INTEGER
        const bOrder = b.sort_order && b.sort_order > 0 ? b.sort_order : Number.MAX_SAFE_INTEGER
        if (aOrder !== bOrder) return aOrder - bOrder
        return a.id - b.id
      })
  ), [formConfigFields])

  const orderedSectionItems = useCallback((
    section: string,
    keys: readonly string[],
    metaMap: Record<string, OemFieldMeta>,
  ): OrderedOemSectionItem[] => {
    const builtins: OrderedOemSectionItem[] = keys.map((key, index) => ({
      kind: 'builtin',
      key,
      sortOrder: metaMap[key]?.sortOrder && metaMap[key].sortOrder > 0
        ? metaMap[key].sortOrder
        : index + 1,
      defaultOrder: index + 1,
    }))

    const custom = customFieldsForSection(section).map((field, index) => ({
      kind: 'custom' as const,
      field,
      sortOrder: field.sort_order && field.sort_order > 0
        ? field.sort_order
        : keys.length + index + 1,
      defaultOrder: keys.length + index + 1,
    }))

    return [...builtins, ...custom].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
      return a.defaultOrder - b.defaultOrder
    })
  }, [customFieldsForSection])

  const orderedOemDetailsItems = useMemo(
    () => orderedSectionItems('oem_details', OEM_DETAILS_FIELD_KEYS, oemDetailsFieldMeta),
    [orderedSectionItems, oemDetailsFieldMeta],
  )

  const orderedContactItems = useMemo(
    () => orderedSectionItems('contact', CONTACT_FIELD_KEYS, contactFieldMeta),
    [orderedSectionItems, contactFieldMeta],
  )

  const orderedNotesItems = useMemo(
    () => orderedSectionItems('oem_notes', OEM_NOTES_FIELD_KEYS, notesFieldMeta),
    [orderedSectionItems, notesFieldMeta],
  )

  const renderCustomField = (section: string, field: any) => (
    <CustomFields
      key={`custom-${section}-${field.id}`}
      section={section}
      fields={[field]}
      values={customData}
      onChange={(k, v) => setCustomData(p => ({ ...p, [k]: v }))}
    />
  )

  const renderOemDetailsField = (key: string) => {
    const meta = oemDetailsFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'name') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          placeholder={namePlaceholder}
          value={form.name}
          onChange={(v: any) => setF('name', v?.target?.value ?? v?.value ?? v ?? '')}
          error={errProp('name')}
          onBlur={leave('name')}
        />
      )
    }

    if (key === 'product_id') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={catOptions}
          value={form.product_id}
          onChange={v => setF('product_id', v)}
          error={errProp('product_id')}
        />
      )
    }

    if (key === 'account_manager') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.account_manager}
          onChange={(v: any) => setF('account_manager', v?.target?.value ?? v?.value ?? v ?? '')}
          error={errProp('account_manager')}
          onBlur={leave('account_manager')}
        />
      )
    }

    if (key === 'auth_number') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.auth_number}
          onChange={(v: any) => setF('auth_number', v?.target?.value ?? v?.value ?? v ?? '')}
          error={errProp('auth_number')}
          onBlur={leave('auth_number')}
        />
      )
    }

    if (key === 'auth_date') {
      return (
        <DatePicker
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.auth_date}
          onChange={v => setF('auth_date', v)}
          error={errProp('auth_date')}
        />
      )
    }

    if (key === 'support_sla') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.support_sla}
          onChange={(v: any) => setF('support_sla', v?.target?.value ?? v?.value ?? v ?? '')}
          error={errProp('support_sla')}
          onBlur={leave('support_sla')}
        />
      )
    }

    if (key === 'credit_limit') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          type="text"
          numberOnly
          value={form.credit_limit}
          onChange={(v: any) => setF('credit_limit', v?.target?.value ?? v?.value ?? v ?? '')}
          error={errProp('credit_limit')}
          onBlur={leave('credit_limit')}
        />
      )
    }

    if (key === 'payment_terms') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.payment_terms}
          onChange={(v: any) => setF('payment_terms', v?.target?.value ?? v?.value ?? v ?? '')}
          error={errProp('payment_terms')}
          onBlur={leave('payment_terms')}
        />
      )
    }

    if (key === 'brands_handled') {
      if (isOEM) return null
      return (
        <div key={key}>
          <Input
            label={meta.label}
            required={meta.required}
            placeholder="e.g. HP, Dell, Lenovo, Cisco"
            value={form.brands_handled}
            onChange={(v: any) => setF('brands_handled', v?.target?.value ?? v?.value ?? v ?? '')}
            error={errProp('brands_handled')}
            onBlur={leave('brands_handled')}
          />
          {!errors.brands_handled && (
            <p className="text-xs text-gray-400 mt-1">Comma-separated list of brands this distributor handles</p>
          )}
        </div>
      )
    }

    return null
  }

  const renderContactField = (key: string) => {
    const meta = contactFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'contact_name') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.contact_name}
          onChange={(v: any) => setF('contact_name', v?.target?.value ?? v?.value ?? v ?? '')}
          error={errProp('contact_name')}
          onBlur={leave('contact_name')}
        />
      )
    }

    if (key === 'contact_designation') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.contact_designation}
          onChange={(v: any) => setF('contact_designation', v?.target?.value ?? v?.value ?? v ?? '')}
          error={errProp('contact_designation')}
          onBlur={leave('contact_designation')}
        />
      )
    }

    if (key === 'contact_phone') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.contact_phone}
          onChange={(v: any) => {
            let val = v?.target?.value ?? v?.value ?? v ?? ''
            val = val.replace(/\D/g, '').slice(0, 10)
            setF('contact_phone', val)
          }}
          error={errProp('contact_phone')}
          onBlur={leave('contact_phone')}
        />
      )
    }

    if (key === 'contact_email') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          type="email"
          value={form.contact_email}
          onChange={(v: any) => setF('contact_email', v?.target?.value ?? v?.value ?? v ?? '')}
          error={errProp('contact_email')}
          onBlur={leave('contact_email')}
        />
      )
    }

    return null
  }

  const renderNotesField = (key: string) => {
    const meta = notesFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'notes') {
      return (
        <div key={key}>
          <textarea
            id="oem-form-notes"
            value={form.notes}
            onChange={(v: any) => setF('notes', v?.target?.value ?? v?.value ?? v ?? '')}
            onBlur={leave('notes')}
            rows={6}
            placeholder="Optional notes..."
            aria-label={meta.label}
            aria-invalid={errors.notes ? true : undefined}
            className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 resize-none ${errors.notes ? '!border-red-500' : ''}`}
          />
          <FieldError id="oem-form-notes" msg={errors.notes} />
        </div>
      )
    }

    return null
  }

  // scroll to and focus the first field showing an error (after React has rendered the messages)
  const focusFirstError = () => setTimeout(() => {
    const el = document.querySelector<HTMLElement>('main .form-control.error, main .error input, main [aria-invalid="true"]')
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); try { el.focus({ preventScroll: true }) } catch { el.focus() } }
  }, 0)

  const handleSave = async () => {
    const errs: FormErrors = {}
    OEM_FIELD_ORDER.forEach(k => {
      touched.current.add(k)
      const s = specFor(k)
      const m = s ? checkField(form[k], s) : ''
      if (m) errs[k] = k === 'product_id' ? requiredSelectMessage('Category / Product Line', catOptions) : m
    })
    // tenant custom fields (Form Builder): required flag + rule inferred from key / label / type
    const customErr = formConfigFields.filter(f => f.is_custom && f.is_visible !== false).map(f =>
      checkField(customData[f.field_key] as any, { label: f.label, required: !!f.is_required, rule: inferRule(f.field_key, f.label, f.field_type) as Rule })).find(Boolean)
    if (Object.keys(errs).length > 0 || customErr) {
      setErrors(errs)
      if (errs.product_id && catOptions.length === 0) showError(errs.product_id)
      else if (!Object.keys(errs).length && customErr) showError(customErr)
      focusFirstError()
      return
    }
    setErrors({})
    setSaving(true)
    try {
      const payload = {
        ...form,
        product_id: Number(form.product_id),
        credit_limit: form.credit_limit === '' ? 0 : Number(form.credit_limit),
        auth_date: form.auth_date === '' ? null : form.auth_date,
        custom_data: Object.keys(customData).length ? customData : null,
      }
      if (isEdit) {
        await api.put(`/oems/${oem.id}`, payload)
        success(`${form.type} updated`)
      } else {
        await api.post('/oems', payload)
        success(`${form.type} created`)
      }
      navigate('/oems')
    } catch (e: any) {
      // field errors from the API land under their fields; a duplicate name (409) belongs to the name field
      const detail = e.response?.data?.detail
      const fx = Object.fromEntries(Object.entries(mapApiErrors(e)).filter(([k]) => OEM_FIELD_ORDER.includes(k)))
      if (e.response?.status === 409 && typeof detail === 'string' && !Object.keys(fx).length) fx.name = detail
      if (Object.keys(fx).length) { setErrors(prev => ({ ...prev, ...fx })); focusFirstError() }
      else if (Array.isArray(detail)) showError(detail.map((d: any) => String(d.msg).replace(/^Value error, /, '')).join(', '))
      else showError(detail || 'Failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="w-full">
        <div className="bg-white border border-slate-200 shadow-sm">
          <FormPageHeader
            breadcrumb={moduleLabel}
            onBreadcrumbClick={() => navigate('/oems')}
            title={singular}
            isEdit={isEdit}
            onCancel={() => navigate('/oems')}
            onSave={handleSave}
            saving={saving}
          />
          <main className="min-w-0">
            <FormCard id="type" title="Entry Type" icon={Package}>
              <TypeToggle value={form.type} onChange={v => { setF('type', v); setErrors({}) }} />
            </FormCard>

            <FormCard id="oem_details" title={`${form.type} Details`} icon={Building2}>
              <FormGrid cols={3}>
                {orderedOemDetailsItems.map(item =>
                  item.kind === 'custom'
                    ? renderCustomField('oem_details', item.field)
                    : renderOemDetailsField(item.key)
                )}
              </FormGrid>
              {form.credit_limit && !errors.credit_limit && (
                <p className="text-xs text-gray-500 mt-3 italic">{numberToWords(Number(form.credit_limit))}</p>
              )}
            </FormCard>

            <FormCard id="contact" title="Contact" icon={User}>
              <FormGrid cols={3}>
                {orderedContactItems.map(item =>
                  item.kind === 'custom'
                    ? renderCustomField('contact', item.field)
                    : renderContactField(item.key)
                )}
              </FormGrid>
            </FormCard>

            <FormCard id="oem_notes" title="Notes" icon={FileText}>
              <div className="space-y-4">
                {orderedNotesItems.map(item =>
                  item.kind === 'custom'
                    ? (
                      <div key={`custom-oem_notes-${item.field.id}`} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                        {renderCustomField('oem_notes', item.field)}
                      </div>
                    )
                    : renderNotesField(item.key)
                )}
              </div>
            </FormCard>
          </main>
        </div>
      </div>
    </div>
  )
}
