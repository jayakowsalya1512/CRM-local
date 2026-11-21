import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Plane, Plus, CheckCircle, XCircle, Clock, MapPin,
  Navigation, AlertTriangle, ChevronRight, RefreshCw,
  X, Activity, UserCircle, Car, Train, Bus,
  FileText, Loader2,
  Calendar, ArrowRight, Briefcase, CreditCard,
  ChevronDown, Bike, Pencil, MoreVertical, Eye,
} from 'lucide-react'   
import api from '@/services/api'
import Button from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { DataTable, Column } from '@/components/ui/DataTable'
import {
  PageHeader, StatCard, useToast,
} from '@/components/ui/FormComponents'
import { useAuthStore, useUIStore } from '@/store'
import { usePermissions } from '@/hooks/Usepermissions'
import { useModuleName } from '@/context/ModuleLabelsContext'
import TravelFormPage from './TravelFormPage'
import TravelModuleTabs from './TravelModuleTabs'
import { useFormConfig } from '@/hooks/useFormConfig'
import { isEmpty, mapApiErrors, validate, type FieldSpec } from '@/utils/validation'

// Field rules for the travel request form (backend twin: travel_router.TravelRequestCreate).
const TRAVEL_SPECS: Record<string, FieldSpec> = {
  purpose: { label: 'Purpose of Travel', rule: 'text', required: true, min: 3, max: 500 },
  visit_type: { label: 'Visit Type', rule: 'select' },
  from_city: { label: 'From City', rule: 'text', required: true, min: 2, max: 100 },
  to_city: { label: 'To City', rule: 'text', required: true, min: 2, max: 100 },
  travel_date: { label: 'Travel Date', rule: 'date', required: true },
  return_date: { label: 'Return Date', rule: 'date', required: true },
  account_id: { label: 'Customer', rule: 'select' },
  contact_name: { label: 'Contact Name', rule: 'text', max: 200 },
  contact_phone: { label: 'Contact Phone', rule: 'mobile' },
  opportunity_id: { label: 'Opportunity', rule: 'select' },
  lead_id: { label: 'Lead', rule: 'integer', min: 1 },
  tender_id: { label: 'Tender', rule: 'select' },
  advance_amount: { label: 'Advance Amount', rule: 'amount', required: true, max: 9999999999.99 },
  accommodation_type: { label: 'Accommodation Type', rule: 'select' },
  hotel_name: { label: 'Hotel Name', rule: 'text', max: 200 },
  check_in_date: { label: 'Check-in Date', rule: 'date' },
  check_out_date: { label: 'Check-out Date', rule: 'date' },
  accommodation_cost: { label: 'Accommodation Cost', rule: 'amount', max: 9999999999.99 },
  companions: { label: 'Companions', rule: 'textarea', max: 2000 },
  notes: { label: 'Notes', rule: 'textarea', max: 5000 },
}
const TRAVEL_STEP1_KEYS = ['purpose', 'visit_type', 'from_city', 'to_city', 'travel_date', 'return_date', 'account_id', 'contact_name', 'contact_phone', 'opportunity_id', 'lead_id', 'tender_id']
const TRAVEL_STEP2_KEYS = ['advance_amount', 'accommodation_type', 'hotel_name', 'check_in_date', 'check_out_date', 'accommodation_cost', 'companions', 'notes']
const ACCOMMODATION_KEYS = ['accommodation_type', 'hotel_name', 'check_in_date', 'check_out_date', 'accommodation_cost']
const TRAVEL_DEPENDENTS: Record<string, string[]> = {
  travel_date: ['return_date'], check_in_date: ['check_out_date'],
  advance_required: ['advance_amount'], accommodation_required: ACCOMMODATION_KEYS,
}

// â”€â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const STATUS_CFG: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  Draft:     { bg: 'bg-slate-100',   text: 'text-slate-600',   border: 'border-slate-200',  dot: 'bg-slate-400'   },
  Pending:   { bg: 'bg-amber-50',    text: 'text-amber-700',   border: 'border-amber-200',  dot: 'bg-amber-400'   },
  Submitted: { bg: 'bg-amber-50',    text: 'text-amber-700',   border: 'border-amber-200',  dot: 'bg-amber-400'   },
  Approved:  { bg: 'bg-emerald-50',  text: 'text-emerald-700', border: 'border-emerald-200',dot: 'bg-emerald-500' },
  Rejected:  { bg: 'bg-rose-50',     text: 'text-rose-600',    border: 'border-rose-200',   dot: 'bg-rose-500'    },
  Completed: { bg: 'bg-blue-50',     text: 'text-blue-700',    border: 'border-blue-200',   dot: 'bg-blue-500'    },
  Cancelled: { bg: 'bg-slate-100',   text: 'text-slate-400',   border: 'border-slate-200',  dot: 'bg-slate-300'   },
}

// â”€â”€â”€ Small Components â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function StatusChip({ status, label }: { status: string; label?: string }) {
  const c = STATUS_CFG[status] || STATUS_CFG.Draft

  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold px-2.5 py-0.5 rounded-full border ${c.bg} ${c.text} ${c.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.dot}`} />
      {label || status}
    </span>
  )
}

function SourceBadge({ source, kamSubject }: { source?: string; kamSubject?: string }) {
  if (source !== 'kam') return null
  return (
    <span
      title={kamSubject ? `From KAM: ${kamSubject}` : 'From KAM Activity'}
      className="inline-flex items-center gap-1 text-xs bg-indigo-50 text-indigo-600 border border-indigo-200 px-2 py-0.5 rounded-full font-semibold"
    >
      <Activity size={10} />KAM
    </span>
  )
}

function TransportBadge({ mode }: { mode?: string }) {
  const map: Record<string, { icon: JSX.Element; label: string; bg: string; text: string }> = {
    flight:      { icon: <Plane size={11} />,      label: 'Flight',       bg: 'bg-sky-50',     text: 'text-sky-600'    },
    train:       { icon: <Train size={11} />,      label: 'Train',        bg: 'bg-violet-50',  text: 'text-violet-600' },
    bus:         { icon: <Bus size={11} />,        label: 'Bus',          bg: 'bg-teal-50',    text: 'text-teal-600'   },
    own_vehicle: { icon: <Car size={11} />,        label: 'Own Vehicle',  bg: 'bg-orange-50',  text: 'text-orange-600' },
    company_car: { icon: <Car size={11} />,        label: 'Company Car',  bg: 'bg-blue-50',    text: 'text-blue-600'   },
    bike:        { icon: <Bike size={11} />,       label: 'Bike',         bg: 'bg-rose-50',    text: 'text-rose-500'   },
    taxi_cab:    { icon: <Navigation size={11} />, label: 'Taxi / Cab',   bg: 'bg-yellow-50',  text: 'text-yellow-700' },
    other:       { icon: <Navigation size={11} />, label: 'Other',        bg: 'bg-slate-100',  text: 'text-slate-500'  },
  }
  const cfg = map[mode || ''] || map.other
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${cfg.bg} ${cfg.text}`}>
      {cfg.icon}{cfg.label}
    </span>
  )
}

function getApprovalStatusMeta(req: any) {
  const approvalStatus = String(req?.approval_status || '').trim().toLowerCase()
  const rawLabel = typeof req?.approval_display === 'string' ? req.approval_display.trim() : ''
  const rawCurrent = Number(req?.approval_progress_current)
  const rawTotal = Number(req?.approval_progress_total)
  const hasCurrent = Number.isFinite(rawCurrent)
  const hasTotal = Number.isFinite(rawTotal) && rawTotal > 0
  const isPending = approvalStatus === 'pending' || req?.status === 'Submitted'
  const current = hasCurrent ? rawCurrent : 0
  const total = hasTotal ? rawTotal : null

  let statusLabel = rawLabel
  if (isPending && total && (!statusLabel || /^pending$/i.test(statusLabel))) {
    statusLabel = `Pending (${current}/${total})`
  } else if (isPending && !statusLabel) {
    statusLabel = 'Pending'
  } else if (!statusLabel) {
    statusLabel = req?.status || 'Draft'
  }

  return {
    isPending,
    visualStatus: isPending ? 'Pending' : (req?.status || 'Draft'),
    statusLabel,
  }
}

// â”€â”€â”€ Collapsible Form Section â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function CollapsibleSection({
  title, icon, children, defaultOpen = true, badge,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  badge?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50 transition-colors text-left"
      >
        <span className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0 text-blue-500">
          {icon}
        </span>
        <span className="text-sm font-semibold text-slate-800 flex-1">{title}</span>
        {badge && (
          <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-medium">{badge}</span>
        )}
        <ChevronDown
          size={15}
          className={`text-slate-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="px-5 pb-5 pt-1 space-y-4 border-t border-slate-100">
          {children}
        </div>
      )}
    </div>
  )
}

// â”€â”€â”€ Toggle Card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function DetailField({
  label, value, fullWidth = false,
}: {
  label: string
  value?: React.ReactNode
  fullWidth?: boolean
}) {
  if (value === undefined || value === null || value === '') return null
  return (
    <div className={fullWidth ? 'md:col-span-2' : ''}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">{label}</p>
      <div className="min-h-[42px] rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 flex items-center">
        {value}
      </div>
    </div>
  )
}

// â”€â”€â”€ Empty Form â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const EMPTY_FORM = {
  purpose: '', visit_type: 'Customer Visit',
  from_city: '', to_city: '',
  travel_date: '', return_date: '',
  is_outside_district: false, notes: '',
  account_id: '', contact_name: '', contact_phone: '',
  opportunity_id: '', lead_id: '', tender_id: '',
  transport_mode: null, vehicle_number: null,
  estimated_kms: '', advance_booking_ref: null,
  estimated_cost: '', advance_required: false,
  advance_amount: '', cost_center: null, budget_code: null,
  accommodation_required: false, accommodation_type: 'Not Required',
  hotel_name: '', check_in_date: '', check_out_date: '',
  accommodation_cost: '', companions: '',
}

const normalizePhoneDigits = (value: unknown) => String(value ?? '').replace(/\D/g, '')
const FIELD_HIGHLIGHT = ' '

function TravelRowActions({
  row,
  onView,
  onEdit,
  onSubmit,
  canEdit,
  canSubmit,
  submitting,
}: {
  row: any
  onView: (row: any) => void
  onEdit: (row: any) => void
  onSubmit: (id: number) => void
  canEdit: boolean
  canSubmit: boolean
  submitting: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const stopActionClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const toggleMenu = (e: React.MouseEvent) => {
    stopActionClick(e)

    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      setPos({
        top: rect.bottom + 6,
        left: Math.max(8, rect.right - 176),
      })
    }

    setOpen((prev) => !prev)
  }

  useEffect(() => {
    if (!open) return

    const closeMenu = (event: MouseEvent) => {
      const target = event.target as Node

      if (buttonRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return

      setOpen(false)
    }

    const closeOnScroll = () => setOpen(false)

    document.addEventListener('mousedown', closeMenu)
    window.addEventListener('scroll', closeOnScroll, true)

    return () => {
      document.removeEventListener('mousedown', closeMenu)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [open])

  return (
    <div
      className="relative inline-flex justify-center"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        ref={buttonRef}
        type="button"
        title="Actions"
        onClick={toggleMenu}
        onMouseDown={(e) => e.stopPropagation()}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
      >
        <MoreVertical size={16} />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              zIndex: 99999,
            }}
            className="w-44 overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="p-1.5">
              <button
                type="button"
                onClick={(e) => {
                  stopActionClick(e)
                  onView(row)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <Eye size={14} className="text-blue-600" />
                View
              </button>

              {canEdit && (
                <button
                  type="button"
                  onClick={(e) => {
                    stopActionClick(e)
                    onEdit(row)
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Pencil size={14} className="text-indigo-600" />
                  Edit
                </button>
              )}

              {canSubmit && (
                <button
                  type="button"
                  disabled={submitting}
                  onClick={(e) => {
                    stopActionClick(e)
                    if (submitting) return
                    onSubmit(row.id)
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                  {row.status === 'Rejected' ? 'Re-submit' : 'Submit'}
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

// â”€â”€â”€ Main Page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default function TravelListPage() {
  const { label: travelLabel, singular: travelSingular } = useModuleName('travel')
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore()
  const [requests,      setRequests]      = useState<any[]>([])
  const [loading,       setLoading]       = useState(true)
  const [panelOpen,     setPanelOpen]     = useState(false)
  const [activeStep,    setActiveStep]    = useState(1)
  const [detailOpen,    setDetailOpen]    = useState(false)
  const [selectedRequest, setSelectedRequest] = useState<any | null>(null)
  const [saving,        setSaving]        = useState(false)
  const [submittingId,  setSubmittingId]  = useState<number | null>(null)
  const [statusFilter,   setStatusFilter]   = useState('')
  const [memberFilter,   setMemberFilter]   = useState('')
  const [customerFilter, setCustomerFilter] = useState('')
  const [tableSearch,    setTableSearch]    = useState('')
  const [customers,      setCustomers]      = useState<any[]>([])
  const [memberOptions,  setMemberOptions]  = useState<Array<{ value: string; label: string }>>([])
  const [opportunities, setOpportunities] = useState<any[]>([])
  const [tenders,       setTenders]       = useState<any[]>([])
  const [form,          setForm]          = useState<any>(EMPTY_FORM)
  const [formErrors,    setFormErrors]    = useState<Record<string, string>>({})
  const [editingRequest, setEditingRequest] = useState<any | null>(null)
  const [sidebarWasCollapsed, setSidebarWasCollapsed] = useState(false)
  const [accountSelectVersion, setAccountSelectVersion] = useState(0)

  const { success, error: showError } = useToast()
  const { fields: travelFormCfg } = useFormConfig('travel')
  const { user } = useAuthStore()
  const { can } = usePermissions()

  const load = async () => {
    setLoading(true)
    try {
      const r = await api.get('/travel/requests')
      setRequests(r.data)
    } catch { showError('Failed to load travel requests') }
    finally { setLoading(false) }
  }

  const loadCrmData = async () => {
  try {
    const custs = await api.get('/travel/team-customers')
    setCustomers((custs.data || [])
      .map((x: any) => ({
        value: String(x.id),
        label: String(x.customer_name || x.label || ''),
      }))
      .filter((x: any) => x.value && x.label)
    )
  } catch {}

  try {
    const users = await api.get('/travel/team-users')
    setMemberOptions((users.data || [])
      .map((u: any) => ({
        value: String(u.id),
        label: String(u.label || u.full_name || u.username || ''),
      }))
      .filter((u: any) => u.value && u.label)
      .sort((a: any, b: any) => a.label.localeCompare(b.label))
    )
  } catch {}

  try {
    const opps = await api.get('/leads', { params: { status: 'Opportunity Created' } })
    const rows = Array.isArray(opps.data) ? opps.data : (opps.data?.items || [])
    setOpportunities(rows.map((o: any) => {
      const ref = o.opportunity_ref_id || o.lead_ref_id || ''
      const title = o.lead_title || o.customer_name || `Opportunity #${o.id}`
      const customer = o.customer_name && o.customer_name !== title ? ` - ${o.customer_name}` : ''
      return {
        ...o,
        name: `${ref ? `${ref} - ` : ''}${title}${customer}`,
      }
    }))
  } catch {}

  try {
    const tnds = await api.get('/tenders/dropdown')
    setTenders(Array.isArray(tnds.data) ? tnds.data : [])
  } catch {}
}

  useEffect(() => { load() }, [])
  useEffect(() => {
  loadCrmData()
}, [])

  // ── field validation: format errors while typing, "required" after the field was left once, all on step/save ──
  const travelTouched = useRef<Set<string>>(new Set())
  const travelSpec = (k: string, f: any): FieldSpec | undefined => {
    if (k === 'advance_amount' && !f.advance_required) return undefined
    if (ACCOMMODATION_KEYS.includes(k) && !f.accommodation_required) return undefined
    const base = TRAVEL_SPECS[k]
    if (!base) return undefined
    const cfg = travelFormCfg.find(x => !x.is_custom && x.field_key === k)
    if (cfg && cfg.is_visible === false && !base.required) return undefined
    return { ...base, label: cfg?.label || base.label, required: !!base.required || !!(cfg?.is_required && cfg.is_visible !== false) }
  }
  const travelFieldMsg = (k: string, f: any): string => {
    const sp = travelSpec(k, f)
    const m = sp ? validate(f[k], sp) : ''
    if (m) return m
    if (k === 'return_date' && f.travel_date && f.return_date && f.return_date < f.travel_date)
      return 'Return date cannot be before the travel date.'
    if (k === 'check_out_date' && f.accommodation_required && f.check_in_date && f.check_out_date && f.check_out_date < f.check_in_date)
      return 'Check-out date cannot be before the check-in date.'
    return ''
  }

  const setF = (k: string, v: any) => {
    const nextForm = { ...form, [k]: v }
    setForm((p: any) => ({ ...p, [k]: v }))
    setFormErrors((prev) => {
      const out = { ...prev }
      for (const key of new Set([k, ...(TRAVEL_DEPENDENTS[k] || []), ...Object.keys(prev)])) {
        if (!TRAVEL_SPECS[key]) continue
        let m = travelFieldMsg(key, nextForm)
        // an empty required field only complains once it was left (or on Next / Save)
        if (m && isEmpty(nextForm[key]) && !travelTouched.current.has(key) && !prev[key]) m = ''
        if (m) out[key] = m
        else delete out[key]
      }
      return out
    })
  }

  const blurF = (k: string) => {
    travelTouched.current.add(k)
    const m = travelFieldMsg(k, form)
    setFormErrors((prev) => {
      if ((prev[k] || '') === m) return prev
      const out = { ...prev }
      if (m) out[k] = m
      else delete out[k]
      return out
    })
  }

  /** Validate `keys`; shows every message, returns the errors found. */
  const checkTravelFields = (keys: string[]) => {
    const errors: Record<string, string> = {}
    for (const k of keys) {
      travelTouched.current.add(k)
      const m = travelFieldMsg(k, form)
      if (m) errors[k] = m
    }
    setFormErrors((prev) => {
      const out = { ...prev }
      keys.forEach(k => { delete out[k] })
      return { ...out, ...errors }
    })
    return errors
  }

  const focusFirstTravelError = () => {
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>('.form-control.error, .form-control[aria-invalid="true"]')
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); try { el.focus({ preventScroll: true }) } catch { el.focus() } }
    }, 60)
  }

  const goToRequestDetails = () => {
    const errors = checkTravelFields(TRAVEL_STEP1_KEYS)
    if (Object.keys(errors).length) {
      setActiveStep(1)
      focusFirstTravelError()
      showError('Please correct the highlighted fields')
      return
    }
    setActiveStep(2)
  }

  const buildPayload = () => {
    const INT_FIELDS  = ['account_id', 'opportunity_id', 'lead_id', 'tender_id']
    const NUM_FIELDS  = ['estimated_kms', 'estimated_cost', 'advance_amount', 'accommodation_cost']
    const DATE_FIELDS = ['check_in_date', 'check_out_date']
    const payload = { ...form, contact_phone: normalizePhoneDigits(form.contact_phone) || null }
    for (const f of [...INT_FIELDS, ...NUM_FIELDS, ...DATE_FIELDS])
      if (payload[f] === '' || payload[f] === undefined) payload[f] = null
    return payload
  }

  const handleSave = async (submitAfter = false) => {
    if (saving) return
    const step1Errors = checkTravelFields(TRAVEL_STEP1_KEYS)
    if (Object.keys(step1Errors).length) {
      setActiveStep(1)
      focusFirstTravelError()
      showError('Please correct the highlighted fields')
      return
    }
    const step2Errors = checkTravelFields(TRAVEL_STEP2_KEYS)
    if (Object.keys(step2Errors).length) {
      setActiveStep(2)
      focusFirstTravelError()
      showError('Please correct the highlighted fields')
      return
    }
    setSaving(true)
    const payload = buildPayload()
    try {
      let savedId: number | null = null
      if (editingRequest?.id) {
        const r = await api.put(`/travel/requests/${editingRequest.id}`, payload)
        savedId = editingRequest.id
        if (!submitAfter) success(r.data?.message || 'Travel request updated')
      } else {
        const r = await api.post('/travel/requests', payload)
        savedId = r.data?.id ?? null
        if (!submitAfter) success('Travel request created successfully')
      }
      if (submitAfter && savedId) {
        try {
          const s = await api.post(`/travel/requests/${savedId}/submit`)
          if (s.data?.status === 'Approved') success(s.data?.message || 'Travel request auto-approved')
          else if (s.data?.requested_to) success(`Submitted to ${s.data.requested_to}`)
          else success(s.data?.message || 'Travel request submitted successfully')
        } catch (e: any) {
          showError(e.response?.data?.detail || 'Request saved as draft, but submit failed — submit it from the list')
        }
      }
      closePanel()
      load()
    } catch (e: any) {
      // field-level 422 from the server → show each message under its field, keep the entered data
      const fieldErrs = Object.fromEntries(Object.entries(mapApiErrors(e)).filter(([k]) => k in TRAVEL_SPECS))
      if (Object.keys(fieldErrs).length) {
        setFormErrors((prev) => ({ ...prev, ...fieldErrs }))
        setActiveStep(TRAVEL_STEP1_KEYS.some(k => fieldErrs[k]) ? 1 : 2)
        focusFirstTravelError()
        showError('Please correct the highlighted fields')
      } else {
        const d = e.response?.data?.detail
        showError(typeof d === 'string' ? d : (editingRequest ? 'Failed to update request' : 'Failed to create request'))
      }
    }
    finally { setSaving(false) }
  }

  const handleSubmit = async (id: number) => {
    setSubmittingId(id)
    try {
      const r = await api.post(`/travel/requests/${id}/submit`)
      if (r.data?.status === 'Approved') success(r.data?.message || 'Travel request auto-approved')
      else if (r.data?.requested_to) success(`Submitted to ${r.data.requested_to}`)
      else success(r.data?.message || 'Travel request submitted successfully')
      load()
    } catch (e: any) { showError(e.response?.data?.detail || 'Failed to submit') }
    finally { setSubmittingId(null) }
  }

  const myRole      = user?.role || ''
  const isManagerUp = ['admin', 'ceo', 'vp', 'manager'].includes(myRole)
  // Records in the list are already limited by the role's Data Visibility;
  // actions are governed solely by the configured permissions.
  const canSubmit   = (req: any) =>
    can('travel.update') &&
    (req.status === 'Draft' || req.status === 'Rejected')
  const canEditRequest = (req: any) =>
    can('travel.update') &&
    ['Draft', 'Rejected', 'Submitted'].includes(req?.status)

  const filtered = requests.filter(r => {
    if (statusFilter && r.status !== statusFilter) return false
    if (memberFilter && String(r.employee_id || '') !== memberFilter) return false
    if (customerFilter && String(r.customer_id || r.account_id || '') !== customerFilter) return false

    if (tableSearch.trim()) {
      const q = tableSearch.toLowerCase()
      const searchText = [
        r.request_number,
        r.purpose,
        r.visit_type,
        r.from_city,
        r.to_city,
        r.travel_date,
        r.return_date,
        r.account_name,
        r.employee_name,
        r.transport_mode,
        r.status,
        r.approval_display,
        r.kam_activity_subject,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      if (!searchText.includes(q)) return false
    }

    return true
  })

  const stats = {
    total:     requests.length,
    kam:       requests.filter(r => r.source === 'kam').length,
    pending:   requests.filter(r => (r.approval_status || '').toLowerCase() === 'pending' || r.status === 'Submitted').length,
    approved:  requests.filter(r => r.status === 'Approved').length,
    rejected:  requests.filter(r => r.status === 'Rejected').length,
  }
  const openPanel = () => {
    setSidebarWasCollapsed(sidebarCollapsed)
    if (!sidebarCollapsed) setSidebarCollapsed(true)
    setEditingRequest(null)
    setForm(EMPTY_FORM)
    setFormErrors({}); travelTouched.current.clear()
    setActiveStep(1)
    setPanelOpen(true)
  }

  const closePanel = () => {
    if (!sidebarWasCollapsed) setSidebarCollapsed(false)
    setPanelOpen(false)
    setActiveStep(1)
    setForm(EMPTY_FORM)
    setFormErrors({}); travelTouched.current.clear()
    setEditingRequest(null)
  }

  const requestToForm = (req: any) => {
    const valueOrBlank = (value: any) => (value === null || value === undefined ? '' : String(value))
    return {
      ...EMPTY_FORM,
      purpose: req.purpose || '',
      visit_type: req.visit_type || 'Customer Visit',
      from_city: req.from_city || '',
      to_city: req.to_city || '',
      travel_date: req.travel_date || '',
      return_date: req.return_date || '',
      is_outside_district: !!req.is_outside_district,
      notes: req.notes || '',
      account_id: req.customer_id ?? req.account_id ?? '',
      contact_name: req.contact_name || '',
      contact_phone: normalizePhoneDigits(req.contact_phone).slice(0, 10),
      opportunity_id: req.opportunity_id ?? '',
      lead_id: req.lead_id ?? '',
      tender_id: req.tender_id ?? '',
      transport_mode: req.transport_mode || null,
      vehicle_number: req.vehicle_number || null,
      estimated_kms: valueOrBlank(req.estimated_kms),
      advance_booking_ref: req.advance_booking_ref || null,
      estimated_cost: valueOrBlank(req.estimated_cost ?? req.estimated_total),
      advance_required: !!req.advance_required,
      advance_amount: valueOrBlank(req.advance_amount),
      cost_center: req.cost_center || null,
      budget_code: req.budget_code || null,
      accommodation_required: !!req.accommodation_required,
      accommodation_type: req.accommodation_type || 'Not Required',
      hotel_name: req.hotel_name || '',
      check_in_date: req.check_in_date || '',
      check_out_date: req.check_out_date || '',
      accommodation_cost: valueOrBlank(req.accommodation_cost),
      companions: req.companions || '',
    }
  }

  const openEditRequest = (req: any) => {
    setSidebarWasCollapsed(sidebarCollapsed)
    if (!sidebarCollapsed) setSidebarCollapsed(true)
    setEditingRequest(req)
    setForm(requestToForm(req))
    setFormErrors({}); travelTouched.current.clear()
    setActiveStep(1)
    setDetailOpen(false)
    setSelectedRequest(null)
    setPanelOpen(true)
  }

  const openRequestDetails = (req: any) => {
    setSelectedRequest(req)
    setDetailOpen(true)
  }
  const closeRequestDetails = () => {
    setDetailOpen(false)
    setSelectedRequest(null)
  }

  useEffect(() => {
    if (!selectedRequest) return
    const latest = requests.find((r: any) => r.id === selectedRequest.id)
    if (latest) setSelectedRequest(latest)
  }, [requests, selectedRequest?.id])

  const STATUS_OPTIONS = ['', 'Approved', 'Rejected', 'Submitted', 'Draft', 'Completed', 'Cancelled']
  const requestMemberOptions = requests
    .filter(r => r.employee_id && r.employee_name)
    .reduce((acc: Array<{ value: string; label: string }>, r: any) => {
      const value = String(r.employee_id)
      if (!acc.some(opt => opt.value === value)) acc.push({ value, label: r.employee_name })
      return acc
    }, [])
    .sort((a, b) => a.label.localeCompare(b.label))

  const customerOptions = customers


  // useEffect(() => {
  //   if (!myId) {
  //     setMemberOptions(requestMemberOptions)
  //     return
  //   }

  //   if (!['admin', 'ceo', 'manager'].includes(myRole)) {
  //     setMemberOptions(requestMemberOptions)
  //     return
  //   }

  //   api.get('/travel/team-users')
  //     .then((r: any) => {
  //       const users = Array.isArray(r.data) ? r.data : []
  //       const scopedUsers = myRole === 'manager'
  //         ? users.filter((u: any) => Number(u.id) === Number(myId) || Number(u.reporting_manager_id) === Number(myId))
  //         : users

  //       const options = scopedUsers
  //         .filter((u: any) => u.id && u.full_name)
  //         .map((u: any) => ({ value: String(u.id), label: u.full_name }))
  //         .sort((a: any, b: any) => a.label.localeCompare(b.label))

  //       setMemberOptions(options)
  //     })
  //     .catch(() => {
  //       setMemberOptions(requestMemberOptions)
  //     })
  // }, [myId, myRole, requests])

  useEffect(() => {
    if (memberFilter && !memberOptions.some(opt => opt.value === memberFilter)) {
      setMemberFilter('')
    }
  }, [memberFilter, memberOptions])


  const tableFilterToolbar = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <select
        value={statusFilter}
        onChange={e => setStatusFilter(e.target.value)}
        className={`h-9 w-[150px] rounded-xl border px-3 text-xs font-medium outline-none transition-all ${statusFilter ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}
      >
        <option value="">All Statuses</option>
        {STATUS_OPTIONS.filter(Boolean).map(status => (
          <option key={status} value={status}>{status}</option>
        ))}
      </select>

      <select
        value={memberFilter}
        onChange={e => setMemberFilter(e.target.value)}
        className={`h-9 w-[165px] rounded-xl border px-3 text-xs font-medium outline-none transition-all ${memberFilter ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}
      >
        <option value="">All Members</option>
        {memberOptions.map(member => (
          <option key={member.value} value={member.value}>{member.label}</option>
        ))}
      </select>

      <select
        value={customerFilter}
        onChange={e => setCustomerFilter(e.target.value)}
        className={`h-9 w-[185px] rounded-xl border px-3 text-xs font-medium outline-none transition-all ${customerFilter ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}
      >
        <option value="">All Customers</option>
        {customerOptions.map(customer => (
          <option key={customer.value} value={customer.value}>{customer.label}</option>
        ))}
      </select>

      {(statusFilter || memberFilter || customerFilter) && (
        <button
          type="button"
          onClick={() => { setStatusFilter(''); setMemberFilter(''); setCustomerFilter('') }}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-rose-100 bg-rose-50 px-3 text-xs font-semibold text-rose-600 transition-all hover:bg-rose-100"
        >
          <X size={13} />
          Clear
        </button>
      )}

      <div className="ml-auto hidden items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 lg:flex">
        <span className="text-xs text-slate-500">Showing</span>
        <span className="text-sm font-bold text-slate-800">{filtered.length}</span>
        <span className="text-xs text-slate-500">requests</span>
      </div>
    </div>
  )

  const travelColumns: Column<any>[] = [
    {
      key: 'purpose',
      header: 'Request',
      sortable: true,
      width: '15%',
      searchable: true,
      searchKeys: ['purpose', 'visit_type', 'kam_activity_subject'],
      render: (_: unknown, row: any) => {
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <SourceBadge source={row.source} kamSubject={row.kam_activity_subject} />
            </div>
            <p className="mt-1.5 truncate text-sm font-semibold text-slate-900">
              {row.purpose || '-'}
            </p>
            {row.kam_activity_subject && (
              <p className="mt-1 truncate text-xs font-medium text-indigo-500">
                KAM: {row.kam_activity_subject}
              </p>
            )}
          </div>
        )
      },
    },
    {
      key: 'request_number',
      header: 'Travel ID',
      sortable: true,
      width: '10%',
      hidden: true,
      render: (_: unknown, row: any) => (
        <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-lg">
          {row.request_number || '-'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      width: '13%',
      align: 'center',
      searchable: true,
      searchKeys: ['approval_status', 'approval_display'],
      render: (_: unknown, row: any) => {
        const { visualStatus, statusLabel } = getApprovalStatusMeta(row)
        const pendingApproverName = row.approval_requested_to_name || row.requested_to_name

        return (
          <div className="flex min-w-[125px] flex-col items-center gap-1">
            <StatusChip status={visualStatus} label={statusLabel} />
            {pendingApproverName && visualStatus === 'Pending' && (
              <span className="max-w-[120px] truncate text-[10px] font-medium text-amber-600" title={`Pending with ${pendingApproverName}`}>
                {pendingApproverName}
              </span>
            )}
            {row.status === 'Rejected' && row.rejection_reason && (
              <span className="max-w-[120px] truncate text-[10px] font-medium text-rose-500" title={row.rejection_reason}>
                Reason available
              </span>
            )}
          </div>
        )
      },
    },
    {
      key: 'route',
      header: 'Route',
      sortable: false,
      width: '14%',
      searchable: true,
      searchKeys: ['from_city', 'to_city'],
      render: (_: unknown, row: any) => (
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-slate-800">
            <MapPin size={13} className="text-slate-400 flex-shrink-0" />
            <span className="truncate">{row.from_city || '-'}</span>
            <ArrowRight size={12} className="text-slate-300 flex-shrink-0" />
            <span className="truncate">{row.to_city || '-'}</span>
          </p>
          <p className="mt-1.5 truncate text-xs font-medium text-slate-400">
            {row.visit_type || '-'}
          </p>
        </div>
      ),
    },
    {
      key: 'travel_date',
      header: 'Dates',
      sortable: true,
      width: '13%',
      searchable: true,
      searchKeys: ['return_date'],
      render: (_: unknown, row: any) => (
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-slate-800">
            <Calendar size={13} className="text-slate-400 flex-shrink-0" />
            {row.travel_date || '-'}
          </p>
          <p className="mt-1.5 truncate text-xs font-medium text-slate-400">
            Return: {row.return_date || '-'}
          </p>
        </div>
      ),
    },
    {
      key: 'transport_mode',
      header: 'Transport',
      sortable: true,
      width: '11%',
      align: 'center',
      render: (value: unknown) => (
        value ? <TransportBadge mode={String(value)} /> : <span className="text-xs text-slate-300">-</span>
      ),
    },
    {
      key: 'account_name',
      header: 'Customer',
      sortable: true,
      width: '13%',
      searchable: true,
      render: (_: unknown, row: any) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-800">
            {row.account_name || '-'}
          </p>
          {isManagerUp && row.employee_name && (
            <p className="mt-1.5 flex items-center gap-1 truncate text-xs font-medium text-slate-400">
              <UserCircle size={11} />
              {row.employee_name}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'estimated_cost',
      header: 'Cost',
      sortable: true,
      width: '9%',
      align: 'right',
      render: (value: unknown, row: any) => (
        <div className="min-w-0 text-right">
          <p className="text-sm font-bold text-slate-800">
            {value ? `INR ${Number(value).toLocaleString('en-IN')}` : '-'}
          </p>
          {row.advance_required && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-600">
              <CreditCard size={10} />
              Advance
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'stay',
      header: 'Stay',
      sortable: false,
      width: '7%',
      align: 'center',
      render: (_: unknown, row: any) => (
        row.accommodation_required ? (
          <span className="inline-flex rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-600">
            Yes
          </span>
        ) : (
          <span className="text-xs text-slate-300">No</span>
        )
      ),
    },

 {
  key: 'actions',
  header: 'Actions',
  width: '7%',
  searchable: false,
  align: 'center',
  render: (_: unknown, row: any) => (
    <div
      className="flex items-center justify-center"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <TravelRowActions
        row={row}
        onView={openRequestDetails}
        onEdit={openEditRequest}
        onSubmit={handleSubmit}
        canEdit={canEditRequest(row)}
        canSubmit={canSubmit(row)}
        submitting={submittingId === row.id}
      />
    </div>
  ),
},
  ]

  return (
    <div className="p-6 space-y-5">
      <PageHeader
        title={travelSingular}
        subtitle={`Plan and track business ${travelLabel.toLowerCase()} - expense claims are filed via ${travelLabel} after the trip`}
        breadcrumb={[travelLabel, 'Requests']}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={load} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
            {can('travel.create') && (
              <Button onClick={openPanel}>
                <Plus size={14} className="mr-1.5 inline-block" />New {travelSingular}
              </Button>
            )}
          </div>
        }
      />

      <TravelModuleTabs active="requests" requestCount={stats.total} travelLabel={travelLabel} />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard title="Total" value={stats.total} icon={<Plane size={20} />} color="blue" />
        <StatCard title="From KAM" value={stats.kam} icon={<Activity size={20} />} color="indigo" />
        <StatCard title="Pending Review" value={stats.pending} icon={<Clock size={20} />} color="amber" />
        <StatCard title="Approved" value={stats.approved} icon={<CheckCircle size={20} />} color="green" />
        <StatCard title="Rejected" value={stats.rejected} icon={<XCircle size={20} />} color="red" />
      </div>

      <DataTable
        columns={travelColumns}
        data={filtered}
        loading={loading}
        keyField="id"
        onRowClick={openRequestDetails}
        showSearch
        searchValue={tableSearch}
        onSearchChange={setTableSearch}
        searchPlaceholder={`Search ${travelLabel.toLowerCase()} requests...`}
        showExport={can('travel.export')}
        showColumnToggle
        exportFilename={travelLabel.toLowerCase().replace(/\s+/g, '-')}
        emptyMessage="No travel requests found"
        toolbar={tableFilterToolbar}
        striped
        compact
        maxHeight="560px"
      />

      <Modal
        open={detailOpen}
        onClose={closeRequestDetails}
        title="Travel Request Details"
        subtitle={selectedRequest?.request_number || undefined}
        size="xl"
        footer={
          <div className="flex justify-end gap-2">
            {selectedRequest && canEditRequest(selectedRequest) && (
              <button
                onClick={() => openEditRequest(selectedRequest)}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm rounded-xl bg-blue-600 text-white hover:bg-blue-700 font-semibold transition-colors"
              >
                <Pencil size={14} />
                Edit
              </button>
            )}
            <button
              onClick={closeRequestDetails}
              className="px-5 py-2.5 text-sm rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium transition-colors"
            >
              Close
            </button>
          </div>
        }
      >
        {selectedRequest && (
          <div className="space-y-4">
            {(() => {
              const {
                isPending: detailPending,
                visualStatus: detailStatus,
                statusLabel: detailLabel,
              } = getApprovalStatusMeta(selectedRequest)
              return (
            <div className="rounded-[28px] border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-blue-50 p-5 shadow-sm">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip status={detailStatus} label={detailLabel} />
                    <span className="text-xs text-slate-600 bg-white border border-slate-200 px-2.5 py-1 rounded-lg font-medium">{selectedRequest.visit_type}</span>
                    <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 px-2.5 py-1 rounded-lg">{selectedRequest.request_number}</span>
                    <SourceBadge source={selectedRequest.source} kamSubject={selectedRequest.kam_activity_subject} />
                  </div>
                  <div>
                    <p className="text-xl font-bold text-slate-900 break-words">{selectedRequest.purpose}</p>
                    <p className="text-sm text-slate-500 mt-1">Travel request overview and trip information</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-600">
                    <span className="flex items-center gap-1.5 font-semibold text-slate-700">
                      <MapPin size={14} className="text-slate-400" />
                      {selectedRequest.from_city}
                      <ArrowRight size={12} className="text-slate-300" />
                      {selectedRequest.to_city}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Calendar size={13} className="text-slate-400" />
                      {selectedRequest.travel_date}
                      {selectedRequest.return_date && selectedRequest.return_date !== selectedRequest.travel_date && (
                        <> - {selectedRequest.return_date}</>
                      )}
                    </span>
                    {selectedRequest.employee_name && (
                      <span className="flex items-center gap-1.5">
                        <UserCircle size={13} className="text-slate-400" />
                        {selectedRequest.employee_name}
                      </span>
                    )}
                    {selectedRequest.account_name && (
                      <span className="flex items-center gap-1.5 text-indigo-600 font-medium">
                        <Briefcase size={13} />
                        {selectedRequest.account_name}
                      </span>
                    )}
                  </div>
                  {selectedRequest.status === 'Rejected' && selectedRequest.rejection_reason && (
                    <div className="flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-3">
                      <AlertTriangle size={15} className="text-rose-500 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-rose-500">Rejected Request</p>
                        <p className="text-sm text-rose-600 mt-1">{selectedRequest.rejection_reason}</p>
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 xl:min-w-[280px]">
                  <div className="rounded-2xl border border-white/80 bg-white/80 px-4 py-3 shadow-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Trip Days</p>
                    <p className="mt-1 text-lg font-bold text-slate-800">{selectedRequest.total_days || '--'}</p>
                  </div>
                  <div className="rounded-2xl border border-white/80 bg-white/80 px-4 py-3 shadow-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Transport</p>
                    <div className="mt-1 min-h-[28px] flex items-center">
                      {selectedRequest.transport_mode ? (
                        <TransportBadge mode={selectedRequest.transport_mode} />
                      ) : (
                        <span className="text-sm font-medium text-slate-500">Not set</span>
                      )}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/80 bg-white/80 px-4 py-3 shadow-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Advance</p>
                    <p className="mt-1 text-lg font-bold text-slate-800">{selectedRequest.advance_required ? 'Required' : 'No'}</p>
                  </div>
                  <div className="rounded-2xl border border-white/80 bg-white/80 px-4 py-3 shadow-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Stay</p>
                    <p className="mt-1 text-lg font-bold text-slate-800">{selectedRequest.accommodation_required ? 'Required' : 'No'}</p>
                  </div>
                </div>
              </div>
            </div>
              )
            })()}

            <CollapsibleSection title="Trip Summary" icon={<Plane size={15} />} defaultOpen>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <DetailField label="Employee" value={selectedRequest.employee_name} />
                <DetailField label="Source" value={selectedRequest.source_label || selectedRequest.source} />
                <DetailField label="From City" value={selectedRequest.from_city} />
                <DetailField label="To City" value={selectedRequest.to_city} />
                <DetailField label="Travel Date" value={selectedRequest.travel_date} />
                <DetailField label="Return Date" value={selectedRequest.return_date} />
                <DetailField label="Total Days" value={selectedRequest.total_days ? String(selectedRequest.total_days) : ''} />
                <DetailField label="Outside District / City" value={selectedRequest.is_outside_district ? 'Yes' : 'No'} />
              </div>
            </CollapsibleSection>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {(selectedRequest.account_name || selectedRequest.contact_name || selectedRequest.contact_phone || selectedRequest.opportunity_id || selectedRequest.lead_id || selectedRequest.tender_id || selectedRequest.kam_activity_subject) && (
                <CollapsibleSection title="CRM Linkage" icon={<Briefcase size={15} />} defaultOpen>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <DetailField label="Account / Customer" value={selectedRequest.account_name} />
                    <DetailField label="Linked Opportunity" value={selectedRequest.opportunity_id ? String(selectedRequest.opportunity_id) : ''} />
                    <DetailField label="Contact Person" value={selectedRequest.contact_name} />
                    <DetailField label="Contact Phone" value={selectedRequest.contact_phone} />
                    <DetailField label="Lead / Reference ID" value={selectedRequest.lead_id ? String(selectedRequest.lead_id) : ''} />
                    <DetailField label="Linked Tender" value={selectedRequest.tender_num ? `${selectedRequest.tender_num}${selectedRequest.tender_title ? ` – ${selectedRequest.tender_title}` : ''}` : (selectedRequest.tender_id ? `Tender #${selectedRequest.tender_id}` : '')} />
                    <DetailField label="KAM Activity" value={selectedRequest.kam_activity_subject} />
                  </div>
                </CollapsibleSection>
              )}

              {(selectedRequest.transport_mode || selectedRequest.vehicle_number || selectedRequest.estimated_kms || selectedRequest.advance_booking_ref || selectedRequest.estimated_cost || selectedRequest.advance_required || selectedRequest.advance_amount) && (
                <CollapsibleSection title="Travel & Budget" icon={<CreditCard size={15} />} defaultOpen>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <DetailField label="Transport Mode" value={selectedRequest.transport_mode ? <TransportBadge mode={selectedRequest.transport_mode} /> : ''} />
                    <DetailField label="Vehicle Number" value={selectedRequest.vehicle_number} />
                    <DetailField label="Estimated Distance (km)" value={selectedRequest.estimated_kms ? String(selectedRequest.estimated_kms) : ''} />
                    <DetailField label="Booking / PNR Reference" value={selectedRequest.advance_booking_ref} />
                    <DetailField label="Estimated Cost" value={selectedRequest.estimated_cost ? `INR ${Number(selectedRequest.estimated_cost).toLocaleString()}` : ''} />
                    <DetailField label="Advance Required" value={selectedRequest.advance_required ? 'Yes' : 'No'} />
                    <DetailField label="Advance Amount" value={selectedRequest.advance_amount ? `INR ${Number(selectedRequest.advance_amount).toLocaleString()}` : ''} />
                  </div>
                </CollapsibleSection>
              )}

              {(selectedRequest.accommodation_required || selectedRequest.accommodation_type || selectedRequest.hotel_name || selectedRequest.check_in_date || selectedRequest.check_out_date || selectedRequest.accommodation_cost) && (
                <CollapsibleSection title="Accommodation" icon={<svg viewBox="0 0 24 24" className="w-[15px] h-[15px] fill-none stroke-current" strokeWidth="2"><path d="M2 20h20M2 20V8l10-5 10 5v12" /></svg>} defaultOpen>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <DetailField label="Accommodation Required" value={selectedRequest.accommodation_required ? 'Yes' : 'No'} />
                    <DetailField label="Accommodation Type" value={selectedRequest.accommodation_type} />
                    <DetailField label="Hotel / Property Name" value={selectedRequest.hotel_name} fullWidth />
                    <DetailField label="Check-in Date" value={selectedRequest.check_in_date} />
                    <DetailField label="Check-out Date" value={selectedRequest.check_out_date} />
                    <DetailField label="Accommodation Cost" value={selectedRequest.accommodation_cost ? `INR ${Number(selectedRequest.accommodation_cost).toLocaleString()}` : ''} />
                  </div>
                </CollapsibleSection>
              )}

              {(selectedRequest.companions || selectedRequest.notes || selectedRequest.rejection_reason) && (
                <CollapsibleSection title="Additional Info" icon={<FileText size={15} />} defaultOpen>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <DetailField label="Travel Companions" value={selectedRequest.companions} fullWidth />
                    <DetailField label="Notes / Special Instructions" value={selectedRequest.notes} fullWidth />
                    <DetailField label="Rejection Reason" value={selectedRequest.rejection_reason} fullWidth />
                  </div>
                </CollapsibleSection>
              )}
            </div>
          </div>
        )}
      </Modal>

      <TravelFormPage
        open={panelOpen}
        onClose={closePanel}
        travelLabel={travelLabel}
        travelSingular={travelSingular}
        editingRequest={editingRequest}
        activeStep={activeStep}
        setActiveStep={setActiveStep}
        goToRequestDetails={goToRequestDetails}
        handleSave={handleSave}
        saving={saving}
        form={form}
        setF={setF}
        formErrors={formErrors}
        onBlurField={blurF}
        customers={customers}
        opportunities={opportunities}
        tenders={tenders}
        accountSelectVersion={accountSelectVersion}
        setAccountSelectVersion={setAccountSelectVersion}
        normalizePhoneDigits={normalizePhoneDigits}
      />
    </div>
  )
}

