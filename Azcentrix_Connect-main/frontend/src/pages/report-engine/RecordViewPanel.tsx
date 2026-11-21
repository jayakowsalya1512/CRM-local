/**
 * RecordViewPanel.tsx — record view for the Report Engine.
 *
 * Reuses only the DATA layer already built for the Reports section's
 * DrilldownDrawer (useDrilldownData + its per-entity fetch/cache) — the
 * presentational shell is its own: by default a docked column inside the
 * Report Engine page (so opening a record never navigates away or disturbs
 * the current report's filters/sort/pagination/view mode). Maximize pops it
 * into the same full-screen overlay style as Analytical Reports' drawer;
 * Minimize returns it to the docked panel. Either way the underlying report
 * page is never replaced or reset — maximizing only changes how this
 * component renders itself, not the Report Engine's own state.
 *
 * Tab bar and related-record tables follow the same visual language as the
 * KAM 360 drill-down popup: a funnel-style tab header (icon + record count
 * per tab) and a searchable / paginated / exportable table underneath.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  Activity, ChevronLeft, ChevronRight, Columns3, Download, FileText,
  Info, ListChecks, Maximize2, Minimize2, Package, Receipt, Search,
  Shield, SlidersHorizontal, UserCircle, X,
} from 'lucide-react'
import { fmtN, fmtRsL, num, Badge } from '../dashboard/tabs/_shared'
import {
  useDrilldownData, KV,
  type DrilldownEntity, type DrilldownRequest,
} from '../reports/shared/DrilldownDrawer'

type TabIcon = typeof Info

const TABS_BY_ENTITY: Record<DrilldownEntity, { key: string; label: string; icon: TabIcon }[]> = {
  customer: [
    { key: 'overview', label: 'Overview', icon: Info },
    { key: 'leads', label: 'Leads', icon: UserCircle },
    { key: 'tenders', label: 'Tenders', icon: FileText },
    { key: 'quotations', label: 'Quotations', icon: Receipt },
    { key: 'emdbg', label: 'EMD/BG', icon: Shield },
    { key: 'workorders', label: 'Work Orders', icon: Package },
    { key: 'activity', label: 'Activity', icon: Activity },
  ],
  lead: [
    { key: 'overview', label: 'Overview', icon: Info },
    { key: 'tenders', label: 'Tenders', icon: FileText },
    { key: 'quotations', label: 'Quotations', icon: Receipt },
    { key: 'workorders', label: 'Work Orders', icon: Package },
    { key: 'emdbg', label: 'EMD/BG', icon: Shield },
    { key: 'activities', label: 'Activities', icon: Activity },
  ],
  tender: [
    { key: 'overview', label: 'Overview', icon: Info },
    { key: 'quotations', label: 'Quotations', icon: Receipt },
    { key: 'workorders', label: 'Work Orders', icon: Package },
    { key: 'emdbg', label: 'EMD/BG', icon: Shield },
  ],
  workorder: [
    { key: 'overview', label: 'Overview', icon: Info },
    { key: 'quotations', label: 'Quotations', icon: Receipt },
    { key: 'emdbg', label: 'EMD/BG', icon: Shield },
  ],
  quotation: [
    { key: 'overview', label: 'Overview', icon: Info },
    { key: 'line_items', label: 'Line Items', icon: ListChecks },
  ],
  emdbg: [
    { key: 'overview', label: 'Overview', icon: Info },
    { key: 'siblings', label: 'Related Instruments', icon: Shield },
  ],
}

// ─── Per-entity list-tab specs: where the rows live in `data` and which
// columns to render. Centralized so the funnel header can show an accurate
// record count per tab without duplicating the same lookups in the body. ──
type ListTabSpec = {
  rows: (data: any, seed: any) => any[]
  cols: { key: string; label: string; money?: boolean }[]
  empty: string
}

const LIST_TABS: Partial<Record<DrilldownEntity, Record<string, ListTabSpec>>> = {
  customer: {
    leads: {
      rows: d => d.lead_summary?.all_list || d.lead_summary?.recent || [],
      cols: [
        { key: 'title', label: 'Lead' }, { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' },
        { key: 'source_name', label: 'Source' }, { key: 'assigned_to_name', label: 'Owner' },
        { key: 'created', label: 'Created' }, { key: 'value', label: 'Value', money: true },
      ],
      empty: 'No leads found',
    },
    tenders: {
      rows: d => d.tender_summary?.all_list || d.tender_summary?.recent || [],
      cols: [
        { key: 'title', label: 'Tender' }, { key: 'status', label: 'Status' }, { key: 'result', label: 'Result' },
        { key: 'submission', label: 'Submission' }, { key: 'assigned_to_name', label: 'Owner' },
        { key: 'est_value', label: 'Est. Value', money: true }, { key: 'bid_amount', label: 'Bid', money: true },
      ],
      empty: 'No tenders found',
    },
    quotations: {
      rows: d => d.quotation_summary?.all_list || d.quotation_summary?.recent || [],
      cols: [
        { key: 'status', label: 'Status' }, { key: 'valid_until', label: 'Valid Until' },
        { key: 'owner', label: 'Owner' }, { key: 'total_amount', label: 'Amount', money: true },
      ],
      empty: 'No quotations found',
    },
    emdbg: {
      rows: d => d.emdbg_list || [],
      cols: [
        { key: 'tender_title', label: 'Tender' }, { key: 'instrument_type', label: 'Type' },
        { key: 'bank_name', label: 'Bank' }, { key: 'amount', label: 'Amount', money: true },
        { key: 'expiry_date', label: 'Expiry' }, { key: 'status', label: 'Status' }, { key: 'sales_person_name', label: 'Owner' },
      ],
      empty: 'No instruments found',
    },
    workorders: {
      rows: d => d.workorder_summary?.recent || [],
      cols: [
        { key: 'project', label: 'Project' }, { key: 'status', label: 'Status' }, { key: 'owner', label: 'Owner' },
        { key: 'created', label: 'Created' }, { key: 'delivery', label: 'Delivery' }, { key: 'value', label: 'Value', money: true },
      ],
      empty: 'No work orders found',
    },
    activity: {
      rows: d => d.kam_summary?.recent || [],
      cols: [
        { key: 'type', label: 'Type' }, { key: 'subject', label: 'Subject' }, { key: 'owner', label: 'Owner' },
        { key: 'date', label: 'Date' }, { key: 'status', label: 'Status' },
        { key: 'next_action_date', label: 'Next Follow-up' }, { key: 'next_action', label: 'Next Action' }, { key: 'outcome', label: 'Outcome' },
      ],
      empty: 'No activities logged',
    },
  },
  lead: {
    tenders: {
      rows: d => d?.tenders || [],
      cols: [
        { key: 'tender_title', label: 'Tender' }, { key: 'tender_status', label: 'Status' }, { key: 'result', label: 'Result' },
        { key: 'assigned_to_name', label: 'Owner' }, { key: 'est_value', label: 'Est. Value', money: true }, { key: 'bid_amount', label: 'Bid', money: true },
      ],
      empty: 'No linked tenders',
    },
    quotations: {
      rows: d => (d?.quotations || []).map((q: any) => ({ ...q, source_type: q.source_type === 'tender' ? 'Tender' : 'Opportunity' })),
      cols: [
        { key: 'source_type', label: 'Source' }, { key: 'revision_label', label: 'Rev' }, { key: 'subject', label: 'Subject' },
        { key: 'status', label: 'Status' }, { key: 'approval_status', label: 'Approval' },
        { key: 'valid_until', label: 'Valid Until' }, { key: 'created_at', label: 'Created' }, { key: 'total_amount', label: 'Amount', money: true },
      ],
      empty: 'No linked quotations',
    },
    workorders: {
      rows: d => d?.workorders || [],
      cols: [
        { key: 'project_title', label: 'Project' }, { key: 'po_number', label: 'PO Number' }, { key: 'wo_status', label: 'Status' },
        { key: 'progress_percent', label: 'Progress %' }, { key: 'delivery_date', label: 'Delivery' },
        { key: 'po_value', label: 'PO Value', money: true }, { key: 'wo_value', label: 'WO Value', money: true }, { key: 'owner_name', label: 'Owner' },
      ],
      empty: 'No linked work orders',
    },
    emdbg: {
      rows: d => d?.emdbg || [],
      cols: [
        { key: 'instrument_type', label: 'Type' }, { key: 'sales_person_name', label: 'Owner' },
        { key: 'bank_name', label: 'Bank' }, { key: 'amount', label: 'Amount', money: true },
        { key: 'expiry_date', label: 'Expiry' }, { key: 'status', label: 'Status' },
        { key: 'finance_status', label: 'Payment Status' },
      ],
      empty: 'No EMD/BG linked',
    },
    activities: {
      rows: d => d?.activities || [],
      cols: [
        { key: 'activity_type', label: 'Type' }, { key: 'subject', label: 'Subject' },
        { key: 'owner', label: 'Owner' }, { key: 'activity_date', label: 'Date' }, { key: 'status', label: 'Status' },
        { key: 'next_action_date', label: 'Next Follow-up' }, { key: 'next_action', label: 'Next Action' }, { key: 'outcome', label: 'Outcome' },
      ],
      empty: 'No activities logged',
    },
  },
  tender: {
    quotations: {
      rows: d => d?.quotations || [],
      cols: [
        { key: 'revision_label', label: 'Rev' }, { key: 'subject', label: 'Subject' },
        { key: 'status', label: 'Status' }, { key: 'approval_status', label: 'Approval' },
        { key: 'valid_until', label: 'Valid Until' }, { key: 'total_amount', label: 'Amount', money: true },
      ],
      empty: 'No quotations found',
    },
    workorders: {
      rows: d => d?.workorders || [],
      cols: [
        { key: 'project_title', label: 'Project' }, { key: 'po_number', label: 'PO Number' }, { key: 'wo_status', label: 'Status' },
        { key: 'progress_percent', label: 'Progress %' }, { key: 'delivery_date', label: 'Delivery' },
        { key: 'po_value', label: 'PO Value', money: true }, { key: 'wo_value', label: 'WO Value', money: true }, { key: 'owner_name', label: 'Owner' },
      ],
      empty: 'No work orders found',
    },
    emdbg: {
      rows: d => d?.emdbg || [],
      cols: [
        { key: 'tender_title', label: 'Tender' }, { key: 'instrument_type', label: 'Type' }, { key: 'bank_name', label: 'Bank' },
        { key: 'amount', label: 'Amount', money: true }, { key: 'issued_date', label: 'Issued' }, { key: 'expiry_date', label: 'Expiry' },
        { key: 'status', label: 'Status' }, { key: 'sales_person_name', label: 'Owner' },
      ],
      empty: 'No EMD/BG linked',
    },
  },
  workorder: {
    quotations: {
      rows: d => d?.quotations || [],
      cols: [
        { key: 'status', label: 'Status' }, { key: 'approval_status', label: 'Approval' },
        { key: 'valid_until', label: 'Valid Until' }, { key: 'total_amount', label: 'Amount', money: true }, { key: 'created_by_name', label: 'Owner' },
      ],
      empty: 'No linked quotations',
    },
    emdbg: {
      rows: d => d?.emdbg || [],
      cols: [
        { key: 'tender_title', label: 'Tender' }, { key: 'instrument_type', label: 'Type' },
        { key: 'expiry_date', label: 'Expiry' }, { key: 'amount', label: 'Amount', money: true }, { key: 'sales_person_name', label: 'Owner' },
      ],
      empty: 'No EMD/BG linked',
    },
  },
  quotation: {
    line_items: {
      rows: d => d?.line_items || [],
      cols: [
        { key: 'description', label: 'Description' }, { key: 'quantity', label: 'Qty' },
        { key: 'unit_price', label: 'Unit Price', money: true }, { key: 'tax_percent', label: 'Tax %' },
        { key: 'gst_value', label: 'GST Value', money: true }, { key: 'net_price', label: 'Net Price', money: true },
        { key: 'line_total', label: 'Total', money: true },
      ],
      empty: 'No line items',
    },
  },
  emdbg: {
    siblings: {
      rows: (d, seed) => (d?.siblings || []).filter((s: any) => String(s.id) !== String(seed?.id)),
      cols: [
        { key: 'tender_title', label: 'Tender' }, { key: 'instrument_type', label: 'Type' },
        { key: 'expiry_date', label: 'Expiry' }, { key: 'amount', label: 'Amount', money: true }, { key: 'sales_person_name', label: 'Owner' },
      ],
      empty: 'No related instruments',
    },
  },
}

export function RecordViewPanel({
  request,
  onClose,
}: {
  request: DrilldownRequest | null
  onClose: () => void
}) {
  const { data, loading } = useDrilldownData(request)
  const [maximized, setMaximized] = useState(false)
  const [tab, setTab] = useState('overview')
  const navigate = useNavigate()

  useEffect(() => {
    setTab('overview')
  }, [request?.entity, request?.id])

  if (!request) return null

  const baseSeed = { ...(request.seedRow || {}), ...(request.label ? { record_label: request.label } : {}) }
  const seed = data ? { ...baseSeed, ...data } : baseSeed
  const entityTitle =
    request.entity === 'customer' ? 'Customer'
    : request.entity === 'lead' ? 'Lead'
    : request.entity === 'tender' ? 'Tender'
    : request.entity === 'workorder' ? 'Work Order'
    : request.entity === 'quotation' ? 'Quotation'
    : 'EMD/BG Instrument'

  const title = request.label || seed.lead_title || seed.name || seed.client_name || seed.client || seed.title || entityTitle
  const tabs = TABS_BY_ENTITY[request.entity]
  const entityListTabs = LIST_TABS[request.entity]

  const header = (
    <div className="flex shrink-0 items-start justify-between border-b border-slate-200 px-5 py-4">
      <div className="min-w-0">
        <div className="truncate text-[15px] font-bold text-slate-900">{title}</div>
        <div className="mt-0.5 text-[11.5px] text-slate-500">{entityTitle}</div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setMaximized(v => !v)}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-900"
          title={maximized ? 'Minimize' : 'Maximize'}
        >
          {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-red-50 hover:text-red-600"
          title="Close"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  )

  const tabBar = (
    <TabFunnelHeader
      tabs={tabs}
      active={tab}
      onChange={setTab}
      counts={tabs.reduce<Record<string, number | null>>((acc, t) => {
        if (t.key === 'overview') { acc[t.key] = null; return acc }
        const spec = entityListTabs?.[t.key]
        acc[t.key] = spec && data ? spec.rows(data, seed).length : null
        return acc
      }, {})}
    />
  )

  const body = (
    <div className={`min-h-0 flex-1 overflow-y-auto ${maximized ? 'p-5' : 'p-4'}`}>
      {loading && !data ? (
        <div className="flex h-full items-center justify-center py-16 text-sm text-slate-400">
          Loading…
        </div>
      ) : !data ? (
        <div className="flex h-full items-center justify-center py-16 text-sm text-slate-400">
          Record not found
        </div>
      ) : (
        <RecordViewBody
          entity={request.entity}
          tab={tab}
          data={data}
          seed={seed}
          onOpenQuotationHistory={
            request.entity === 'lead'
              ? () => { onClose(); navigate('/quotations', { state: { openLeadId: request.id } }) }
              : undefined
          }
        />
      )}
    </div>
  )

  // Same pattern as Analytical Reports' DrilldownDrawer: a floating overlay
  // that never resizes or reflows the underlying page — only its own size
  // changes between maximized (full screen) and minimized (centered modal).
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden bg-slate-950/40 p-4 backdrop-blur-sm">
      <div
        className={`flex w-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-all duration-200 ${
          maximized ? 'h-full' : 'max-w-[960px] h-[85vh]'
        }`}
      >
        {header}
        {tabBar}
        {body}
      </div>
    </div>,
    document.body,
  )
}

// ─── Funnel-style tab header — round icon per tab with a record count
// underneath, connected by a line, active tab highlighted. Mirrors the KAM
// 360 drill-down popup's pipeline funnel so both drill-downs read the same
// visual language across the app. ──────────────────────────────────────────
function TabFunnelHeader({
  tabs, active, onChange, counts,
}: {
  tabs: { key: string; label: string; icon: TabIcon }[]
  active: string
  onChange: (key: string) => void
  counts: Record<string, number | null>
}) {
  return (
    <div className="shrink-0 border-b border-slate-100 bg-white px-5 py-3">
      <div className="flex items-start overflow-x-auto pb-1">
        {tabs.map((t, idx) => {
          const isActive = active === t.key
          const count = counts[t.key]
          const Icon = t.icon
          return (
            <div key={t.key} className="flex min-w-[120px] flex-1 items-start">
              <button
                type="button"
                onClick={() => onChange(t.key)}
                className="group flex flex-1 flex-col items-center text-center outline-none"
              >
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded-full border-[3px] shadow-lg transition ${
                    isActive
                      ? 'border-blue-600 bg-blue-600 text-white shadow-blue-100'
                      : 'border-slate-200 bg-white text-slate-400 shadow-transparent group-hover:border-blue-100'
                  }`}
                >
                  <Icon size={16} />
                </span>
                <span className={`mt-1.5 whitespace-nowrap text-xs font-black ${isActive ? 'text-blue-700' : 'text-slate-400 group-hover:text-slate-700'}`}>
                  {t.label}
                </span>
                <span className={`mt-0.5 text-[9.5px] font-black ${isActive ? 'text-blue-600' : 'text-slate-300'}`}>
                  {count === null ? ' ' : `${fmtN(count)} record${count === 1 ? '' : 's'}`}
                </span>
              </button>
              {idx < tabs.length - 1 && (
                <div className="mt-[19px] h-0.5 min-w-[24px] flex-1 rounded-full bg-slate-200" />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Badge-style coloring for status/result/priority-like columns — mirrors
// the KAM 360 drill-down's tone functions so record rows read the same way
// (green = won/converted/active, amber = pending, red = lost/rejected). ────
const STATUS_KEYS = new Set(['status', 'wo_status', 'tender_status', 'approval_status'])
const RESULT_KEYS = new Set(['result'])
const PRIORITY_KEYS = new Set(['priority'])
const BADGE_KEYS = new Set([...STATUS_KEYS, ...RESULT_KEYS, ...PRIORITY_KEYS])

function badgeTone(key: string, value: string): string {
  const v = String(value || '').toLowerCase()
  if (PRIORITY_KEYS.has(key)) {
    if (v === 'high') return 'bg-red-50 text-red-700'
    if (v === 'medium') return 'bg-amber-50 text-orange-700'
    if (v === 'low') return 'bg-slate-100 text-slate-600'
    return 'bg-slate-100 text-slate-600'
  }
  if (RESULT_KEYS.has(key)) {
    return v === 'won' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
  }
  // status-like
  if (['won', 'converted', 'active', 'accepted', 'approved', 'completed'].includes(v)) return 'bg-emerald-50 text-emerald-700'
  if (['lost', 'rejected', 'inactive', 'cancelled'].includes(v)) return 'bg-red-50 text-red-700'
  if (v) return 'bg-blue-50 text-blue-700'
  return 'bg-slate-100 text-slate-500'
}

// Common owner/assignee and date-ish column keys — used to auto-detect which
// filter controls (Assigned To, date range, Status) apply to a given tab's
// column set, without needing a separate filter spec per tab.
const ASSIGNEE_KEYS = ['assigned_to_name', 'owner', 'owner_name', 'created_by_name', 'sales_person_name']
const DATE_KEYS = [
  'submission', 'created', 'created_at', 'valid_until', 'expiry_date', 'delivery', 'delivery_date',
  'issue_date', 'issued_date', 'submitted_date', 'valid_from', 'finance_paid_date', 'release_date',
  'date', 'activity_date', 'expiry',
]

function firstFilled(row: any, keys: string[]) {
  for (const key of keys) {
    const value = row?.[key]
    if (value != null && String(value).trim()) return value
  }
  return undefined
}

function moneyValue(value: any) {
  if (value == null || value === '') return undefined
  return fmtRsL(num(value))
}

function dateValue(value: any) {
  if (!value) return undefined
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function dateTimeValue(value: any) {
  if (!value) return undefined
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

// ─── Rich related-record table — search, filters, column visibility, CSV
// export, and pagination, matching the KAM 360 drill-down's table experience
// (filter bar + colored status/result/priority badges). ───────────────────
function RecordTable({
  rows, cols, empty, onRowClick,
}: {
  rows: any[]
  cols: { key: string; label: string; money?: boolean }[]
  empty: string
  onRowClick?: (row: any) => void
}) {
  const [search, setSearch] = useState('')
  const [assigneeFilter, setAssigneeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() => new Set(cols.map(c => c.key)))
  const [columnPickerOpen, setColumnPickerOpen] = useState(false)
  const columnPickerRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const assigneeCol = useMemo(() => cols.find(c => ASSIGNEE_KEYS.includes(c.key)), [cols])
  const statusCol = useMemo(() => cols.find(c => STATUS_KEYS.has(c.key)), [cols])
  const dateCol = useMemo(() => cols.find(c => DATE_KEYS.includes(c.key)), [cols])

  const assigneeOptions = useMemo(() => (
    assigneeCol ? Array.from(new Set(rows.map(r => r[assigneeCol.key]).filter(Boolean))).sort() : []
  ), [rows, assigneeCol])
  const statusOptions = useMemo(() => (
    statusCol ? Array.from(new Set(rows.map(r => r[statusCol.key]).filter(Boolean))).sort() : []
  ), [rows, statusCol])

  useEffect(() => { setVisibleCols(new Set(cols.map(c => c.key))) }, [cols])
  useEffect(() => { setPage(1) }, [search, rows, assigneeFilter, statusFilter, fromDate, toDate])
  useEffect(() => { setAssigneeFilter(''); setStatusFilter(''); setFromDate(''); setToDate('') }, [cols])

  useEffect(() => {
    if (!columnPickerOpen) return
    const onClickOutside = (e: MouseEvent) => {
      if (columnPickerRef.current && !columnPickerRef.current.contains(e.target as Node)) {
        setColumnPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [columnPickerOpen])

  const activeCols = cols.filter(c => visibleCols.has(c.key))

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(r => {
      if (q && !cols.some(c => String(r[c.key] ?? '').toLowerCase().includes(q))) return false
      if (assigneeCol && assigneeFilter && r[assigneeCol.key] !== assigneeFilter) return false
      if (statusCol && statusFilter && r[statusCol.key] !== statusFilter) return false
      if (dateCol && (fromDate || toDate)) {
        const d = r[dateCol.key] ? new Date(r[dateCol.key]) : null
        if (!d || Number.isNaN(d.getTime())) return false
        if (fromDate && d < new Date(fromDate)) return false
        if (toDate && d > new Date(toDate)) return false
      }
      return true
    })
  }, [rows, search, cols, assigneeCol, assigneeFilter, statusCol, statusFilter, dateCol, fromDate, toDate])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize)

  const exportCsv = () => {
    const escape = (v: unknown) => {
      const s = String(v ?? '')
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [
      activeCols.map(c => escape(c.label)).join(','),
      ...filtered.map(r => activeCols.map(c => escape(c.money ? num(r[c.key]) : r[c.key])).join(',')),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'export.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!rows?.length) {
    return <div className="py-6 text-center text-xs text-slate-400">{empty}</div>
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-nowrap items-center gap-1.5 overflow-visible border-b border-slate-100 bg-slate-50/70 px-2.5 py-1.5">
        <div className="relative w-[200px] flex-none">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="h-7 w-full rounded-lg border border-slate-200 bg-white pl-7 pr-2 text-[10px] font-semibold text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
          />
        </div>
        <div className="flex flex-none flex-nowrap items-center gap-1.5">
          {assigneeCol && (
            <select
              value={assigneeFilter}
              onChange={e => setAssigneeFilter(e.target.value)}
              className="h-7 w-[112px] rounded-lg border border-slate-200 bg-white px-1.5 text-[10px] font-black text-slate-600 outline-none transition focus:border-blue-400"
            >
              <option value="">All Assigned To</option>
              {assigneeOptions.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          )}
          {dateCol && (
            <>
              <input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                className="h-7 w-[92px] rounded-lg border border-slate-200 bg-white px-1.5 text-[10px] font-black text-slate-600 outline-none transition focus:border-blue-400"
              />
              <input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                className="h-7 w-[92px] rounded-lg border border-slate-200 bg-white px-1.5 text-[10px] font-black text-slate-600 outline-none transition focus:border-blue-400"
              />
            </>
          )}
          {statusCol && (
            <label className="inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-1.5 text-[10px] font-black text-slate-600">
              <SlidersHorizontal size={11} className="text-slate-400" />
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="max-w-[76px] bg-transparent text-[10px] font-black text-slate-600 outline-none"
              >
                <option value="">All Status</option>
                {statusOptions.map(status => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="min-w-2 flex-1" />
        <div className="ml-auto flex flex-none items-center justify-end gap-1.5">
          <div className="relative" ref={columnPickerRef}>
            <button
              type="button"
              onClick={() => setColumnPickerOpen(v => !v)}
              className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2 text-[10.5px] font-black text-slate-700 transition hover:bg-slate-50"
            >
              <Columns3 size={12} />
              Columns
            </button>
            {columnPickerOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg">
                {cols.map(c => (
                  <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-slate-700 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={visibleCols.has(c.key)}
                      onChange={() => setVisibleCols(prev => {
                        const next = new Set(prev)
                        if (next.has(c.key)) { if (next.size > 1) next.delete(c.key) } else next.add(c.key)
                        return next
                      })}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2 text-[10.5px] font-black text-slate-700 transition hover:border-blue-200 hover:bg-blue-50"
          >
            <Download size={12} />
            Export
          </button>
          <span className="ml-1 whitespace-nowrap text-[11px] font-semibold text-slate-400">{filtered.length} record{filtered.length === 1 ? '' : 's'}</span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-[11.5px]">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-black uppercase text-slate-500">
              {activeCols.map(c => (
                <th
                  key={c.key}
                  className="whitespace-nowrap px-3 py-2 text-left"
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {pageRows.length === 0 && (
              <tr><td colSpan={activeCols.length} className="px-3 py-6 text-center text-xs text-slate-400">No matching records</td></tr>
            )}
            {pageRows.map((r, i) => (
              <tr
                key={i}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={`transition-colors hover:bg-slate-50 ${onRowClick ? 'cursor-pointer' : ''}`}
              >
                {activeCols.map(c => {
                  const value = r[c.key]
                  return (
                    <td key={c.key} className="px-3 py-2 text-slate-700">
                      {c.money ? (
                        <span className="font-black tabular-nums text-slate-950">{fmtRsL(num(value))}</span>
                      ) : BADGE_KEYS.has(c.key) && value != null && value !== '' ? (
                        <span className={`inline-flex rounded-lg px-2 py-1 text-[10px] font-black ${badgeTone(c.key, value)}`}>{String(value)}</span>
                      ) : (
                        String(value ?? '—')
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length > pageSize && (
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>Page {page} of {totalPages}</span>
          <div className="flex items-center gap-1.5">
            <select
              value={pageSize}
              onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}
              className="h-7 rounded-lg border border-slate-300 bg-white px-1.5 text-[11px] text-slate-600"
            >
              {[10, 25, 50].map(n => <option key={n} value={n}>{n}/page</option>)}
            </select>
            <button
              type="button"
              disabled={page === 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 disabled:opacity-40"
            >
              <ChevronLeft size={13} />
            </button>
            <button
              type="button"
              disabled={page === totalPages}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 disabled:opacity-40"
            >
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── "Pipeline Status" summary — a lead/tender/work order/EMD-BG can all be
// live at once for the same record (no strict linear stage), so instead of
// one status field we show one badge per linked record type that actually
// has data, each carrying its own count + dominant status. Badges reuse
// badgeTone() so colors match the same record's table rows exactly. ───────
function resolveStatusValue(row: any, fields: string | string[]): string {
  const keys = Array.isArray(fields) ? fields : [fields]
  for (const key of keys) {
    const value = row?.[key]
    if (value != null && String(value).trim()) {
      return String(value).trim()
    }
  }

  if (row?.outcome && String(row.outcome).trim()) return 'Completed'
  if (row?.cancellation_reason && String(row.cancellation_reason).trim()) return 'Cancelled'
  if (row?.next_action || row?.next_action_date) return 'Planned'

  return ''
}

function summarizeStatuses(rows: any[], fields: string | string[]): { count: number; status: string } {
  const count = rows?.length || 0
  if (!count) return { count: 0, status: '' }
  const vals = rows
    .map(r => resolveStatusValue(r, fields))
    .filter(Boolean)
  const uniq = Array.from(new Set(vals))
  if (!uniq.length) return { count, status: 'Logged' }
  if (uniq.length === 1) return { count, status: String(uniq[0]) }
  const priority = ['Won', 'Active', 'Completed', 'Converted', 'Released', 'Planned', 'In Progress']
  const hit = priority.find(p => uniq.includes(p))
  return { count, status: hit ? `${hit} +${uniq.length - 1}` : `${uniq.length} statuses` }
}

// Furthest-reached pipeline stage for a tender, checked downstream-first
// (EMD/BG > Work Orders > Quotations) so a record with, say, an active EMD/BG
// reads as "EMD / BG – Active" even while its Quotations tab is also open —
// independent of whichever tab happens to be selected in the drilldown.
function currentTenderStage(
  tender: any,
  rows: { quotationRows: any[]; workorderRows: any[]; emdbgRows: any[] },
): { label: string; status: string } {
  const stages: { label: string; rows: any[]; fields: string[] }[] = [
    { label: 'EMD / BG', rows: rows.emdbgRows, fields: ['status', 'return_status', 'finance_status'] },
    { label: 'Work Orders', rows: rows.workorderRows, fields: ['wo_status', 'status'] },
    { label: 'Quotations', rows: rows.quotationRows, fields: ['status', 'approval_status'] },
  ]
  for (const stage of stages) {
    if (stage.rows?.length) {
      const { status } = summarizeStatuses(stage.rows, stage.fields)
      return { label: stage.label, status }
    }
  }
  return { label: 'Tender', status: firstFilled(tender, ['tender_status', 'workflow_status']) || '' }
}

function CurrentStageCard({ label, status }: { label: string; status: string }) {
  const tone = pipelineTone(status)
  const Icon = PIPELINE_ICONS[label] || Info
  return (
    <div className={`rounded-xl border p-3 ${tone.border} ${tone.bg}`}>
      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">Current Stage</div>
      <div className="flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm ${tone.icon}`}>
          <Icon size={15} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-black text-slate-900">{label}</div>
          {status && <div className={`truncate text-[11px] font-bold ${tone.text}`}>{status}</div>}
        </div>
      </div>
    </div>
  )
}

function OwnerCard({ name }: { name?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">Owner</div>
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-500">
          <UserCircle size={15} />
        </span>
        <div className="min-w-0 truncate text-[13px] font-black text-slate-900">{name || '—'}</div>
      </div>
    </div>
  )
}

const PIPELINE_ICONS: Record<string, TabIcon> = {
  Leads: UserCircle,
  Tenders: FileText,
  Quotations: Receipt,
  'EMD / BG': Shield,
  'Work Orders': Package,
  Activity,
  Activities: Activity,
}

function pipelineTone(status: string): { bg: string; border: string; text: string; icon: string } {
  const v = String(status || '').toLowerCase()
  if (['won', 'converted', 'active', 'accepted', 'approved', 'completed', 'released'].some(s => v.includes(s))) {
    return { bg: 'bg-emerald-50/60', border: 'border-emerald-200', text: 'text-emerald-700', icon: 'text-emerald-600' }
  }
  if (['lost', 'rejected', 'inactive', 'cancelled', 'expired'].some(s => v.includes(s))) {
    return { bg: 'bg-red-50/60', border: 'border-red-200', text: 'text-red-700', icon: 'text-red-600' }
  }
  if (v) return { bg: 'bg-blue-50/60', border: 'border-blue-200', text: 'text-blue-700', icon: 'text-blue-600' }
  return { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-500', icon: 'text-slate-400' }
}

function PipelineStatusRow({ items }: { items: { label: string; count: number; status?: string }[] }) {
  const visible = items.filter(i => i.count > 0)
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">Pipeline Status</div>
      {visible.length ? (
        <div className="flex flex-wrap gap-2">
          {visible.map((it, i) => {
            const tone = pipelineTone(it.status || '')
            const Icon = PIPELINE_ICONS[it.label] || Info
            return (
              <div
                key={i}
                className={`flex min-w-[128px] flex-1 items-center gap-2.5 rounded-xl border px-3 py-2 ${tone.border} ${tone.bg}`}
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm ${tone.icon}`}>
                  <Icon size={15} />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[9.5px] font-black uppercase tracking-wide text-slate-500">{it.label}</div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[15px] font-black tabular-nums text-slate-900">{fmtN(it.count)}</span>
                    {it.status && <span className={`truncate text-[10.5px] font-bold ${tone.text}`}>{it.status}</span>}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-[11px] font-medium text-slate-400">
          No linked pipeline records yet
        </div>
      )}
    </div>
  )
}

// ─── Merged "Activity Summary" card — one row per linked record type, each
// carrying its full detail line (e.g. "6 converted · ₹3.63L pipeline") rather
// than a simplified status word, so the total and its sub-metric never read
// as contradictory the way two separate cards could. ──────────────────────
function ActivitySummaryCard({
  items,
}: {
  items: { label: string; total: number; detail: string; tone?: string }[]
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">Activity Summary</div>
      <div className="grid grid-cols-6 gap-2">
        {items.map((it, i) => {
          const tone = pipelineTone(it.tone || '')
          const Icon = PIPELINE_ICONS[it.label] || Info
          return (
            <div key={i} className={`min-w-0 rounded-xl border p-3 ${tone.border} ${tone.bg}`}>
              <div className="flex items-center gap-2">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm ${tone.icon}`}>
                  <Icon size={13} />
                </span>
                <span className="truncate text-[9.5px] font-black uppercase tracking-wide text-slate-500">{it.label}</span>
              </div>
              <div className="mt-2 text-[20px] font-black leading-none tabular-nums text-slate-900">{fmtN(it.total)}</div>
              <div className="mt-1 truncate text-[10.5px] font-semibold text-slate-500">{it.detail}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RecordViewBody({
  entity, tab, data, seed, onOpenQuotationHistory,
}: {
  entity: DrilldownEntity; tab: string; data: any; seed: any
  onOpenQuotationHistory?: () => void
}) {
  // Every non-overview tab is a list of related records — render it through
  // the shared, searchable/paginated/exportable RecordTable.
  const listSpec = tab !== 'overview' ? LIST_TABS[entity]?.[tab] : undefined
  if (listSpec) {
    return (
      <RecordTable
        rows={listSpec.rows(data, seed)}
        cols={listSpec.cols}
        empty={listSpec.empty}
        onRowClick={entity === 'lead' && tab === 'quotations' ? onOpenQuotationHistory : undefined}
      />
    )
  }

  if (entity === 'customer') {
    const c = data.customer || {}
    const ls = data.lead_summary || {}
    const ts = data.tender_summary || {}
    const es = data.emdbg_summary || {}
    const qs = data.quotation_summary || {}

    return (
      <div className="space-y-3">
        <ActivitySummaryCard
          items={[
            {
              label: 'Leads',
              total: ls.total || 0,
              detail: `${fmtN(ls.converted || 0)} converted · ${fmtRsL(num(ls.pipeline_value))} pipeline`,
              tone: ls.converted ? 'Converted' : ls.active ? 'Active' : ls.lost ? 'Lost' : '',
            },
            {
              label: 'Tenders',
              total: ts.total || 0,
              detail: `${fmtN(ts.won || 0)} won · ${fmtRsL(num(ts.won_value))}`,
              tone: ts.won ? 'Won' : ts.active ? 'Active' : ts.pending ? 'Pending' : ts.lost ? 'Lost' : '',
            },
            {
              label: 'Quotations',
              total: qs.total || 0,
              detail: `${fmtN(qs.accepted || 0)} accepted · ${fmtRsL(num(qs.accepted_value))}`,
              tone: qs.accepted ? 'Accepted' : qs.pending ? 'Pending' : qs.rejected ? 'Rejected' : '',
            },
            {
              label: 'EMD / BG',
              total: es.total || 0,
              detail: `${fmtRsL(num(es.total_exposure))} exposure`,
              tone: es.active ? 'Active' : '',
            },
            {
              label: 'Work Orders',
              total: data.workorder_summary?.total || 0,
              detail: `${fmtN(data.workorder_summary?.active || 0)} active · ${fmtN(data.workorder_summary?.completed || 0)} completed`,
              tone: data.workorder_summary?.active ? 'Active' : data.workorder_summary?.completed ? 'Completed' : '',
            },
            {
              label: 'Activity',
              total: data.kam_summary?.total_activities || 0,
              detail: data.kam_summary?.last_activity ? `Last activity ${data.kam_summary.last_activity}` : 'No activity yet',
              tone: data.kam_summary?.last_activity ? 'Active' : '',
            },
          ]}
        />
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="mb-1.5 text-[10px] font-bold uppercase text-slate-400">Classification</div>
            <KV label="Segment" value={c.customer_vertical || c.vertical} />
            <KV label="Division" value={c.division} />
            <KV label="Group" value={c.group_name} />
            <KV label="Industry" value={c.industry} />
            <KV label="Tags" value={Array.isArray(c.tags) ? c.tags.join(', ') : c.tags} />
            <KV label="Status" value={c.account_status && <Badge text={c.account_status} />} />
            <KV label="Potential" value={c.account_potential} />
            <KV label="Potential Value" value={fmtRsL(num(c.potential_value))} />
            <KV label="Assigned To" value={c.assigned_to_name} />
          </div>
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="mb-1.5 text-[10px] font-bold uppercase text-slate-400">Location</div>
            <KV label="District" value={c.billing_city} />
            <KV label="State" value={c.billing_state} />
            <KV label="Pincode" value={c.billing_pincode} />
            <KV label="Country" value={c.billing_country} />
            <KV label="Address" value={c.billing_address} />
          </div>
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="mb-1.5 text-[10px] font-bold uppercase text-slate-400">Financial & Identity</div>
            <KV label="GST Number" value={c.gst_number} />
            <KV label="PAN Number" value={c.pan_number} />
            <KV label="Annual Revenue" value={c.annual_revenue ? fmtRsL(num(c.annual_revenue)) : undefined} />
            <KV label="Employee Count" value={c.employee_count} />
            <KV label="Website" value={c.website} />
          </div>
        </div>
      </div>
    )
  }

  if (entity === 'lead') {
    const lead = { ...seed, ...data }
    const tenderRows = data?.tenders || []
    const quotationRows = data?.quotations || []
    const workorderRows = data?.workorders || []
    const emdbgRows = data?.emdbg || []
    const activityRows = data?.activities || []
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="Status" value={lead.status} tone="indigo" />
          <StatTile label="Priority" value={lead.priority} tone="amber" />
          <StatTile label="Est. Value" value={moneyValue(lead.est_value)} tone="emerald" />
        </div>
        <PipelineStatusRow
          items={[
            { label: 'Tenders', ...summarizeStatuses(tenderRows, ['tender_status', 'status', 'result']) },
            { label: 'Quotations', ...summarizeStatuses(quotationRows, ['status', 'approval_status']) },
            { label: 'Work Orders', ...summarizeStatuses(workorderRows, ['wo_status', 'status']) },
            { label: 'EMD / BG', ...summarizeStatuses(emdbgRows, ['status', 'return_status', 'finance_status']) },
            { label: 'Activities', ...summarizeStatuses(activityRows, 'status') },
          ]}
        />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <OverviewCard title="Lead Details">
            <KV label="Lead Ref" value={lead.lead_ref_id} />
            <KV label="Opportunity Ref" value={lead.opportunity_ref_id} />
            <KV label="Title" value={firstFilled(lead, ['lead_title', 'title', 'record_label'])} />
            <KV label="Customer" value={firstFilled(lead, ['customer_name', 'customer'])} />
            <KV label="Department" value={lead.department} />
            <KV label="Product" value={lead.product_description} />
          </OverviewCard>
          <OverviewCard title="Contact & Source">
            <KV label="Contact Person" value={lead.contact_person} />
            <KV label="Designation" value={lead.designation} />
            <KV label="Mobile" value={lead.mobile} />
            <KV label="Email" value={lead.email} />
            <KV label="Source" value={firstFilled(lead, ['source_name', 'lead_source', 'source'])} />
            <KV label="Channel" value={lead.channel} />
          </OverviewCard>
          <OverviewCard title="Ownership & Timeline">
            <KV label="Owner" value={firstFilled(lead, ['assigned_to_name', 'assigned_to'])} />
            <KV label="Region" value={lead.region} />
            <KV label="Branch" value={lead.branch} />
            <KV label="Follow-up" value={dateValue(lead.follow_up)} />
            <KV label="Created" value={dateTimeValue(firstFilled(lead, ['lead_created_at', 'created_at']))} />
            <KV label="Opportunity Created" value={dateTimeValue(lead.opportunity_created_at)} />
            <KV label="Converted" value={dateTimeValue(lead.converted_at)} />
            <KV label="Lost" value={dateTimeValue(lead.lost_at)} />
            <KV label="Conversion Target" value={lead.conversion_target} />
            <KV label="Approval" value={lead.approval_status} />
          </OverviewCard>
        </div>
      </div>
    )
  }

  if (entity === 'tender') {
    const tender = { ...seed, ...data }
    const quotationRows = data?.quotations || []
    const workorderRows = data?.workorders || []
    const emdbgRows = data?.emdbg || []
    const bidAmount = firstFilled(tender, ['bid_amount', 'reverse_auction_final_bid'])
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="Status" value={firstFilled(tender, ['tender_status', 'workflow_status'])} tone="indigo" />
          <StatTile label="Result" value={firstFilled(tender, ['result', 'approval_display', 'approval_status'])} tone="amber" />
          <StatTile label="Bid Amount" value={moneyValue(bidAmount)} tone="emerald" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <OverviewCard title="Details">
            <KV label="Tender No" value={firstFilled(tender, ['tender_num', 'portal_ref_number'])} />
            <KV label="Title" value={firstFilled(tender, ['tender_title', 'title', 'record_label'])} />
            <KV label="Customer" value={firstFilled(tender, ['customer_name', 'customer'])} />
            <KV label="Source" value={firstFilled(tender, ['source_name', 'source_portal'])} />
            <KV label="Est. Value" value={moneyValue(tender.est_value)} />
            <KV label="Business Unit" value={firstFilled(tender, ['business_vertical_name', 'business_vertical_category_name'])} />
          </OverviewCard>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <CurrentStageCard {...currentTenderStage(tender, { quotationRows, workorderRows, emdbgRows })} />
              <OwnerCard name={firstFilled(tender, ['assigned_to_name', 'assigned_to'])} />
            </div>
            <OverviewCard title="Timeline">
              <KV label="Published Date" value={dateValue(tender.published_date)} />
              <KV label="Pre-Bid Date" value={dateValue(tender.pre_bid_date)} />
              <KV label="Submission Date" value={dateValue(tender.submission_date)} />
              <KV label="Result Date" value={dateValue(tender.result_date)} />
              <KV label="Created" value={dateValue(tender.created_at)} />
              <KV label="Updated" value={dateValue(tender.updated_at)} />
            </OverviewCard>
          </div>
        </div>
      </div>
    )
  }

  if (entity === 'workorder') {
    const quotationRows = data?.quotations || []
    const emdbgRows = data?.emdbg || []
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="Status" value={seed.status} tone="indigo" />
          <StatTile label="Progress" value={seed.progress_percent != null ? `${seed.progress_percent}%` : null} tone="amber" />
          <StatTile label="WO Value" value={fmtRsL(num(seed.wo_value))} tone="emerald" />
        </div>
        <PipelineStatusRow
          items={[
            { label: 'Quotations', ...summarizeStatuses(quotationRows, ['status', 'approval_status']) },
            { label: 'EMD / BG', ...summarizeStatuses(emdbgRows, ['status', 'return_status', 'finance_status']) },
          ]}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <OverviewCard title="Details">
            <KV label="WO Number" value={seed.wo_number} />
            <KV label="Project" value={seed.project_title} />
            <KV label="Customer" value={seed.customer_name} />
            <KV label="Site Location" value={seed.site_location} />
          </OverviewCard>
          <OverviewCard title="Commercial & Delivery">
            <KV label="PO Number" value={seed.po_number} />
            <KV label="PO Value" value={fmtRsL(num(seed.po_value))} />
            <KV label="Delivery Date" value={seed.delivery_date} />
            <KV label="Warranty (months)" value={seed.warranty_months} />
            <KV label="Owner" value={seed.created_by_name} />
          </OverviewCard>
        </div>
      </div>
    )
  }

  if (entity === 'quotation') {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="Status" value={seed.status} tone="indigo" />
          <StatTile label="Approval" value={seed.approval_status} tone="amber" />
          <StatTile label="Total Amount" value={fmtRsL(num(seed.total_amount))} tone="emerald" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <OverviewCard title="Details">
            <KV label="Quotation No" value={seed.quotation_number} />
            <KV label="Revision" value={seed.revision_label} />
            <KV label="Customer" value={seed.customer_name} />
            <KV label="Subject" value={seed.subject} />
          </OverviewCard>
          <OverviewCard title="Financials & Validity">
            <KV label="Amount (excl. tax)" value={fmtRsL(num(seed.amount))} />
            <KV label="Tax Amount" value={fmtRsL(num(seed.tax_amount))} />
            <KV label="Valid Until" value={seed.valid_until} />
            <KV label="Created" value={seed.created_at} />
          </OverviewCard>
        </div>
      </div>
    )
  }

  // emdbg overview
  const emdbg = { ...seed, ...data }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <StatTile label="Status" value={firstFilled(emdbg, ['status', 'expiry_status'])} tone="indigo" />
        <StatTile label="Type" value={firstFilled(emdbg, ['instrument_type', 'type'])} tone="amber" />
        <StatTile label="Amount" value={moneyValue(emdbg.amount)} tone="emerald" />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <OverviewCard title="Details">
          <KV label="Reference No" value={firstFilled(emdbg, ['reference_num', 'record_label'])} />
          <KV label="Client" value={firstFilled(emdbg, ['customer_name_display', 'client_name', 'client', 'customer_name'])} />
          <KV label="Tender No" value={firstFilled(emdbg, ['tender_num_display', 'tender_num'])} />
          <KV label="Tender Title" value={firstFilled(emdbg, ['tender_title', 'title'])} />
          <KV label="Instrument Number" value={emdbg.instrument_number} />
          <KV label="Purpose" value={emdbg.purpose} />
        </OverviewCard>
        <OverviewCard title="Bank & Dates">
          <KV label="Bank" value={firstFilled(emdbg, ['bank_name', 'bank'])} />
          <KV label="Branch" value={emdbg.bank_branch} />
          <KV label="Issued Date" value={dateValue(firstFilled(emdbg, ['issued_date', 'issue_date']))} />
          <KV label="Submitted Date" value={dateValue(emdbg.submitted_date)} />
          <KV label="Valid From" value={dateValue(emdbg.valid_from)} />
          <KV label="Expiry Date" value={dateValue(emdbg.expiry_date)} />
        </OverviewCard>
        <OverviewCard title="Ownership & Workflow">
          <KV label="Owner" value={firstFilled(emdbg, ['sales_person_name', 'created_by_name', 'owner'])} />
          <KV label="Approval" value={firstFilled(emdbg, ['approval_display', 'approval_status'])} />
          <KV label="Finance Status" value={emdbg.finance_status} />
          <KV label="Return Status" value={emdbg.return_status} />
          <KV label="Paid Date" value={dateValue(emdbg.finance_paid_date)} />
          <KV label="Release Date" value={dateValue(emdbg.release_date)} />
        </OverviewCard>
      </div>
    </div>
  )
}

function StatTile({
  label, value, tone = 'slate',
}: {
  label: string
  value: React.ReactNode
  tone?: 'slate' | 'emerald' | 'indigo' | 'amber'
}) {
  const toneCls: Record<string, string> = {
    slate: 'bg-slate-50 text-slate-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    amber: 'bg-amber-50 text-amber-700',
  }
  return (
    <div className={`rounded-xl border border-slate-200 p-3 ${toneCls[tone]}`}>
      <div className="text-[10px] font-bold uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 truncate text-[15px] font-bold">{value ?? '—'}</div>
    </div>
  )
}

function OverviewCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="mb-1.5 text-[10px] font-bold uppercase text-slate-400">{title}</div>
      {children}
    </div>
  )
}
