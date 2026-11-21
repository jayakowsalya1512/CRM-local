import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react'
import { CheckCircle, ChevronRight } from 'lucide-react'
import Button from '@/components/ui/Button'
import SlidePanel from '@/components/ui/SlidePanel'
import Input, { Textarea } from '@/components/ui/Input'
import {
  DatePicker,
  FormGrid,
  FormSection,
} from '@/components/ui/FormComponents'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { useFormConfig, type FormFieldConfig } from '@/hooks/useFormConfig'
import { CustomFields } from '@/components/form/CustomFields'

const VISIT_TYPES = [
  'Customer Visit', 'Site Visit', 'Training', 'Conference',
  'Meeting', 'Demo / Presentation', 'Audit', 'Follow-up', 'Other',
]

const ACCOMMODATION_TYPES = [
  'Company Guest House', 'Hotel (Self-Book)', 'Hotel (Company Arranged)',
  'Customer Arranged', 'Home Stay', 'Not Required',
]

const TRAVEL_STEPS = [
  { label: 'Travel Info', desc: 'Basic details' },
  { label: 'Request Details', desc: 'CRM & stay' },
]

const TRAVEL_DETAILS_FIELD_KEYS = [
  'purpose',
  'visit_type',
  'from_city',
  'to_city',
  'travel_date',
  'return_date',
  'is_outside_district',
] as const

const CRM_LINKAGE_FIELD_KEYS = [
  'account_id',
  'contact_name',
  'contact_phone',
  'opportunity_id',
  'lead_id',
  'tender_id',
] as const

const ADVANCE_BUDGET_FIELD_KEYS = [
  'advance_required',
  'advance_amount',
] as const

const ACCOMMODATION_FIELD_KEYS = [
  'accommodation_required',
  'accommodation_type',
  'hotel_name',
  'check_in_date',
  'check_out_date',
  'accommodation_cost',
] as const

const ADDITIONAL_INFO_FIELD_KEYS = [
  'companions',
  'notes',
] as const

interface TravelFieldMeta {
  label: string
  required: boolean
  visible: boolean
  sortOrder: number
}

type OrderedTravelSectionItem =
  | { kind: 'builtin'; key: string; sortOrder: number; defaultOrder: number }
  | { kind: 'custom'; field: FormFieldConfig; sortOrder: number; defaultOrder: number }

function StepIndicator({ currentStep, steps }: {
  currentStep: number
  steps: { label: string; desc: string }[]
}) {
  return (
    <div className="flex items-center w-full mb-6 px-2">
      {steps.map((s, i) => {
        const stepNum = i + 1
        const done = stepNum < currentStep
        const active = stepNum === currentStep
        return (
          <div key={i} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center">
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all
                  ${done
                    ? 'bg-emerald-500 border-emerald-500 text-white'
                    : active
                      ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-200'
                      : 'bg-white border-gray-200 text-gray-400'}`}
              >
                {done ? <CheckCircle size={16} /> : stepNum}
              </div>
              <div className="text-center mt-1.5">
                <p className={`text-xs font-semibold ${active ? 'text-blue-700' : done ? 'text-emerald-600' : 'text-gray-400'}`}>{s.label}</p>
                <p className="text-[10px] text-gray-400 hidden sm:block">{s.desc}</p>
              </div>
            </div>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-0.5 mx-2 mt-[-18px] transition-all ${done ? 'bg-emerald-400' : 'bg-gray-200'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

interface TravelFormPageProps {
  open: boolean
  onClose: () => void
  travelLabel: string
  travelSingular: string
  editingRequest: any | null
  activeStep: number
  setActiveStep: (step: number) => void
  goToRequestDetails: () => void
  handleSave: (submitAfter?: boolean) => void
  saving: boolean
  form: any
  setF: (key: string, value: any) => void
  formErrors: Record<string, string>
  /** Called when a field loses focus – runs the full (required + format) check for it. */
  onBlurField?: (key: string) => void
  customers: any[]
  opportunities: any[]
  tenders: any[]
  accountSelectVersion: number
  setAccountSelectVersion: Dispatch<SetStateAction<number>>
  normalizePhoneDigits: (value: unknown) => string
}

export default function TravelFormPage({
  open,
  onClose,
  travelLabel,
  travelSingular,
  editingRequest,
  activeStep,
  setActiveStep,
  goToRequestDetails,
  handleSave,
  saving,
  form,
  setF,
  formErrors,
  onBlurField,
  customers,
  opportunities,
  tenders,
  accountSelectVersion,
  setAccountSelectVersion,
  normalizePhoneDigits,
}: TravelFormPageProps) {
  const { fields: formConfigFields } = useFormConfig('travel')
  const blurOf = (key: string) => () => onBlurField?.(key)

  const builtinFieldOverrides = useMemo(() => {
    const map = new Map<string, FormFieldConfig>()

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
  ): TravelFieldMeta => {
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

  const travelDetailsFieldMeta = useMemo<Record<string, TravelFieldMeta>>(() => ({
    purpose: fieldMeta('travel_details', 'purpose', 'Purpose of Travel', true),
    visit_type: fieldMeta('travel_details', 'visit_type', 'Visit Type'),
    from_city: fieldMeta('travel_details', 'from_city', 'From City', true),
    to_city: fieldMeta('travel_details', 'to_city', 'To City', true),
    travel_date: fieldMeta('travel_details', 'travel_date', 'Travel Date', true),
    return_date: fieldMeta('travel_details', 'return_date', 'Return Date', true),
    is_outside_district: fieldMeta('travel_details', 'is_outside_district', 'Outside district / city'),
  }), [fieldMeta])

  const crmLinkageFieldMeta = useMemo<Record<string, TravelFieldMeta>>(() => ({
    account_id: fieldMeta('crm_linkage', 'account_id', 'Account / Customer'),
    contact_name: fieldMeta('crm_linkage', 'contact_name', 'Contact Person'),
    contact_phone: fieldMeta('crm_linkage', 'contact_phone', 'Contact Phone'),
    opportunity_id: fieldMeta('crm_linkage', 'opportunity_id', 'Linked Opportunity'),
    lead_id: fieldMeta('crm_linkage', 'lead_id', 'Lead / Reference ID'),
    tender_id: fieldMeta('crm_linkage', 'tender_id', 'Linked Tender'),
  }), [fieldMeta])

  const advanceBudgetFieldMeta = useMemo<Record<string, TravelFieldMeta>>(() => ({
    advance_required: fieldMeta('advance_budget', 'advance_required', 'Request Cash Advance'),
    advance_amount: fieldMeta('advance_budget', 'advance_amount', 'Advance Amount Required (INR)', true),
  }), [fieldMeta])

  const accommodationFieldMeta = useMemo<Record<string, TravelFieldMeta>>(() => ({
    accommodation_required: fieldMeta('accommodation', 'accommodation_required', 'Accommodation Required'),
    accommodation_type: fieldMeta('accommodation', 'accommodation_type', 'Accommodation Type'),
    hotel_name: fieldMeta('accommodation', 'hotel_name', 'Hotel / Property Name'),
    check_in_date: fieldMeta('accommodation', 'check_in_date', 'Check-in Date'),
    check_out_date: fieldMeta('accommodation', 'check_out_date', 'Check-out Date'),
    accommodation_cost: fieldMeta('accommodation', 'accommodation_cost', 'Estimated Accommodation Cost (INR)'),
  }), [fieldMeta])

  const additionalInfoFieldMeta = useMemo<Record<string, TravelFieldMeta>>(() => ({
    companions: fieldMeta('additional_info', 'companions', 'Travel Companions'),
    notes: fieldMeta('additional_info', 'notes', 'Notes / Special Instructions'),
  }), [fieldMeta])

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
    metaMap: Record<string, TravelFieldMeta>,
  ): OrderedTravelSectionItem[] => {
    const builtins: OrderedTravelSectionItem[] = keys.map((key, index) => ({
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

  const orderedTravelDetailsItems = useMemo(
    () => orderedSectionItems('travel_details', TRAVEL_DETAILS_FIELD_KEYS, travelDetailsFieldMeta),
    [orderedSectionItems, travelDetailsFieldMeta],
  )

  const orderedCrmLinkageItems = useMemo(
    () => orderedSectionItems('crm_linkage', CRM_LINKAGE_FIELD_KEYS, crmLinkageFieldMeta),
    [orderedSectionItems, crmLinkageFieldMeta],
  )

  const orderedAdvanceBudgetItems = useMemo(
    () => orderedSectionItems('advance_budget', ADVANCE_BUDGET_FIELD_KEYS, advanceBudgetFieldMeta),
    [orderedSectionItems, advanceBudgetFieldMeta],
  )

  const orderedAccommodationItems = useMemo(
    () => orderedSectionItems('accommodation', ACCOMMODATION_FIELD_KEYS, accommodationFieldMeta),
    [orderedSectionItems, accommodationFieldMeta],
  )

  const orderedAdditionalInfoItems = useMemo(
    () => orderedSectionItems('additional_info', ADDITIONAL_INFO_FIELD_KEYS, additionalInfoFieldMeta),
    [orderedSectionItems, additionalInfoFieldMeta],
  )

  const renderCustomField = (section: string, field: FormFieldConfig) => (
    <CustomFields
      key={`custom-${section}-${field.id}`}
      section={section}
      fields={[field]}
      values={form.custom_data ?? {}}
      onChange={(key, value) => {
        const currentCustomData = form.custom_data && typeof form.custom_data === 'object'
          ? form.custom_data
          : {}
        setF('custom_data', { ...currentCustomData, [key]: value })
      }}
    />
  )

  const renderTravelDetailsField = (key: string) => {
    const meta = travelDetailsFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'purpose') {
      return (
        <div key={key}>
          <Input
            label={meta.label}
            required={meta.required}
            placeholder="e.g. Q3 review meeting with Acme Corp"
            value={form.purpose}
            onChange={(v: any) => setF('purpose', typeof v === 'string' ? v : v?.target?.value || '')}
            onBlur={blurOf('purpose')}
            error={formErrors.purpose}
          />
        </div>
      )
    }

    if (key === 'visit_type') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={VISIT_TYPES.map(t => ({ value: t, label: t }))}
          value={form.visit_type}
          onChange={v => setF('visit_type', v)}
          error={formErrors.visit_type}
        />
      )
    }

    if (key === 'is_outside_district') {
      return (
        <div key={key} className="flex items-end">
          <label className="flex items-center gap-2 mb-2 cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={form.is_outside_district}
              onChange={e => setF('is_outside_district', e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 cursor-pointer"
            />
            <span className="text-sm font-medium text-gray-700">{meta.label}</span>
          </label>
        </div>
      )
    }

    if (key === 'from_city') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          placeholder="Departure city"
          value={form.from_city}
          onChange={(v: any) => setF('from_city', typeof v === 'string' ? v : v?.target?.value || '')}
          onBlur={blurOf('from_city')}
          error={formErrors.from_city}
        />
      )
    }

    if (key === 'to_city') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          placeholder="Destination city"
          value={form.to_city}
          onChange={(v: any) => setF('to_city', typeof v === 'string' ? v : v?.target?.value || '')}
          onBlur={blurOf('to_city')}
          error={formErrors.to_city}
        />
      )
    }

    if (key === 'travel_date') {
      return (
        <DatePicker
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.travel_date}
          onChange={(v: any) => setF('travel_date', v)}
          error={formErrors.travel_date}
        />
      )
    }

    if (key === 'return_date') {
      return (
        <DatePicker
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.return_date}
          onChange={(v: any) => setF('return_date', v)}
          min={form.travel_date}
          error={formErrors.return_date}
        />
      )
    }

    return null
  }

  const renderCrmLinkageField = (key: string) => {
    const meta = crmLinkageFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'account_id') {
      return (
        <div key={key}>
          <SearchableSelect
            key={`travel-account-${accountSelectVersion}`}
            label={meta.label}
            required={meta.required}
            options={customers}
            value={form.account_id ? String(form.account_id) : null}
            onChange={v => setF('account_id', v ? String(v) : '')}
            error={formErrors.account_id}
            placeholder="Search customer..."
            clearable
          />
        </div>
      )
    }

    if (key === 'contact_name') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          placeholder="Name of person to meet"
          value={form.contact_name}
          onChange={(v: any) => setF('contact_name', typeof v === 'string' ? v : v?.target?.value || '')}
          onBlur={blurOf('contact_name')}
          error={formErrors.contact_name}
        />
      )
    }

    if (key === 'contact_phone') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          placeholder="9876543210"
          type="tel"
          inputMode="numeric"
          maxLength={10}
          value={form.contact_phone}
          onChange={(v: any) => setF('contact_phone', normalizePhoneDigits(typeof v === 'string' ? v : v?.target?.value || '').slice(0, 10))}
          onBlur={blurOf('contact_phone')}
          error={formErrors.contact_phone}
        />
      )
    }

    if (key === 'opportunity_id') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={opportunities.map((o: any) => ({ value: o.id, label: o.name }))}
          value={form.opportunity_id}
          onChange={v => setF('opportunity_id', v)}
          error={formErrors.opportunity_id}
          placeholder="Select opportunity..."
        />
      )
    }

    if (key === 'lead_id') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          placeholder="Optional lead or ref number"
          value={form.lead_id}
          onChange={(v: any) => setF('lead_id', typeof v === 'string' ? v : v?.target?.value || '')}
          onBlur={blurOf('lead_id')}
          error={formErrors.lead_id}
        />
      )
    }

    if (key === 'tender_id') {
      return (
        <div key={key} onMouseDownCapture={() => setAccountSelectVersion(v => v + 1)}>
          <SearchableSelect
            label={meta.label}
            required={meta.required}
            options={tenders.map((t: any) => ({
              value: t.id,
              label: t.tender_num ? `${t.tender_num} - ${t.tender_title || t.customer_name}` : (t.tender_title || t.customer_name || `Tender #${t.id}`),
              subtitle: t.customer_name,
            }))}
            value={form.tender_id ? Number(form.tender_id) : null}
            onChange={v => setF('tender_id', v ? Number(v) : '')}
            error={formErrors.tender_id}
            placeholder="Search tender..."
            clearable
          />
        </div>
      )
    }

    return null
  }

  const renderAdvanceBudgetField = (key: string) => {
    const meta = advanceBudgetFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'advance_required') {
      return (
        <div key={key} className="md:col-span-3">
          <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={form.advance_required}
              onChange={e => setF('advance_required', e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 cursor-pointer"
            />
            <span className="text-sm font-medium text-gray-700">
              {meta.label}
            </span>
          </label>
        </div>
      )
    }

    if (key === 'advance_amount' && form.advance_required) {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          placeholder="Enter amount needed in advance"
          value={form.advance_amount}
          onChange={(v: any) =>
            setF('advance_amount', typeof v === 'string' ? v : v?.target?.value || '')
          }
          onBlur={blurOf('advance_amount')}
          error={formErrors.advance_amount}
        />
      )
    }

    return null
  }

  const renderAccommodationField = (key: string) => {
    const meta = accommodationFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'accommodation_required') {
      return (
        <div key={key} className="md:col-span-3">
          <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={form.accommodation_required}
              onChange={e => setF('accommodation_required', e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-blue-600 cursor-pointer"
            />
            <span className="text-sm font-medium text-gray-700">
              {meta.label}
            </span>
          </label>
        </div>
      )
    }

    if (!form.accommodation_required) return null

    if (key === 'accommodation_type') {
      return (
        <SearchableSelect
          key={key}
          label={meta.label}
          required={meta.required}
          options={ACCOMMODATION_TYPES.map(t => ({ value: t, label: t }))}
          value={form.accommodation_type}
          onChange={v => setF('accommodation_type', v)}
          error={formErrors.accommodation_type}
        />
      )
    }

    if (key === 'hotel_name') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          placeholder="Name of hotel or guest house"
          value={form.hotel_name}
          onChange={(v: any) =>
            setF('hotel_name', typeof v === 'string' ? v : v?.target?.value || '')
          }
          onBlur={blurOf('hotel_name')}
          error={formErrors.hotel_name}
        />
      )
    }

    if (key === 'check_in_date') {
      return (
        <DatePicker
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.check_in_date}
          onChange={(v: any) => setF('check_in_date', v)}
          min={form.travel_date}
          error={formErrors.check_in_date}
        />
      )
    }

    if (key === 'check_out_date') {
      return (
        <DatePicker
          key={key}
          label={meta.label}
          required={meta.required}
          value={form.check_out_date}
          onChange={(v: any) => setF('check_out_date', v)}
          min={form.check_in_date || form.travel_date}
          error={formErrors.check_out_date}
        />
      )
    }

    if (key === 'accommodation_cost') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          placeholder="Per night or total"
          value={form.accommodation_cost}
          onChange={(v: any) =>
            setF('accommodation_cost', typeof v === 'string' ? v : v?.target?.value || '')
          }
          onBlur={blurOf('accommodation_cost')}
          error={formErrors.accommodation_cost}
        />
      )
    }

    return null
  }

  const renderAdditionalInfoField = (key: string) => {
    const meta = additionalInfoFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'companions') {
      return (
        <Input
          key={key}
          label={meta.label}
          required={meta.required}
          placeholder="Names of colleagues travelling together (if any)"
          value={form.companions}
          onChange={(v: any) => setF('companions', typeof v === 'string' ? v : v?.target?.value || '')}
          onBlur={blurOf('companions')}
          error={formErrors.companions}
        />
      )
    }

    if (key === 'notes') {
      return (
        <Textarea
          key={key}
          label={meta.label}
          required={meta.required}
          rows={3}
          value={form.notes}
          onChange={e => setF('notes', e.target.value)}
          onBlur={blurOf('notes')}
          error={formErrors.notes}
          placeholder="Any additional context for the approver - special requirements, urgency reason..."
        />
      )
    }

    return null
  }

  return (
    <SlidePanel
      open={open}
      onClose={onClose}
      title={editingRequest ? `Edit ${travelSingular}` : `New ${travelSingular}`}
      subtitle={
        editingRequest
          ? `${editingRequest.request_number || `${travelSingular}`} - update details${editingRequest.status === 'Submitted' ? ' while approval is in progress' : ''}`
          : `Fill in the details below - actual expenses are claimed via ${travelLabel} after travel`
      }
      width="w-full"
      insetLeft="var(--sidebar-w, 220px)"
      footer={
        <div className="flex justify-end gap-3">
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>

          {activeStep === 1 && (
            <Button onClick={goToRequestDetails} disabled={saving}>
              Next: Request Details
            </Button>
          )}

          {activeStep === 2 && editingRequest && (
            <>
              <Button onClick={() => handleSave(false)} loading={saving}>
                Update Request
              </Button>

              {['Draft', 'Rejected'].includes(editingRequest.status) && (
                <Button onClick={() => handleSave(true)} loading={saving}>
                  Update &amp; Submit
                </Button>
              )}
            </>
          )}

          {activeStep === 2 && !editingRequest && (
            <>
              <Button onClick={() => handleSave(false)} loading={saving}>
                Save as Draft
              </Button>

              <Button onClick={() => handleSave(true)} loading={saving}>
                Create Request
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="px-5 pt-4">
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <button
            type="button"
            onClick={onClose}
            className="hover:text-slate-800 transition-colors"
          >
            {travelLabel}
          </button>
          <ChevronRight size={12} className="text-slate-300" />
          <span className="font-medium text-slate-700">
            {editingRequest ? `Edit ${travelSingular}` : `New ${travelSingular}`}
          </span>
        </div>
      </div>

      <div className="px-5 pt-5">
        <StepIndicator currentStep={activeStep} steps={TRAVEL_STEPS} />
      </div>

      {activeStep === 1 && (
        <>
          <FormSection title="Travel Details">
            <FormGrid cols={3}>
              {orderedTravelDetailsItems.map(item => (
                item.kind === 'custom'
                  ? renderCustomField('travel_details', item.field)
                  : renderTravelDetailsField(item.key)
              ))}
            </FormGrid>
          </FormSection>

          <FormSection title="CRM Linkage">
            <FormGrid cols={3}>
              {orderedCrmLinkageItems.map(item => (
                item.kind === 'custom'
                  ? renderCustomField('crm_linkage', item.field)
                  : renderCrmLinkageField(item.key)
              ))}
            </FormGrid>
          </FormSection>
        </>
      )}

      {activeStep === 2 && (
        <>
          <FormSection title="Advance Request">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {orderedAdvanceBudgetItems.map(item => (
                item.kind === 'custom'
                  ? renderCustomField('advance_budget', item.field)
                  : renderAdvanceBudgetField(item.key)
              ))}
            </div>
          </FormSection>

          <FormSection title="Accommodation">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {orderedAccommodationItems.map(item => (
                item.kind === 'custom'
                  ? renderCustomField('accommodation', item.field)
                  : renderAccommodationField(item.key)
              ))}
            </div>
          </FormSection>

          <FormSection title="Additional Info" className="mb-4">
            <FormGrid cols={3}>
              {orderedAdditionalInfoItems.map(item => (
                item.kind === 'custom'
                  ? renderCustomField('additional_info', item.field)
                  : renderAdditionalInfoField(item.key)
              ))}
            </FormGrid>
          </FormSection>
        </>
      )}
    </SlidePanel>
  )
}
