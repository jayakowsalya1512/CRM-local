/**
 * DrilldownDrawer.tsx
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  X, Maximize2, Minimize2, Info, UserCircle, FileText, Receipt, Shield, Package, Activity,
} from 'lucide-react'
import api from '@/services/api'
import { fmtN, fmtRsL, num, Badge } from '../../dashboard/tabs/_shared'

export type DrilldownEntity = 'customer' | 'lead' | 'tender' | 'emdbg' | 'workorder' | 'quotation'

export interface DrilldownRequest {
  entity: DrilldownEntity
  id: number | string
  label?: string
  seedRow?: any
}

type CacheMap = Map<string | number, any>

const caches: Record<DrilldownEntity, CacheMap> = {
  customer: new Map(),
  lead: new Map(),
  tender: new Map(),
  emdbg: new Map(),
  workorder: new Map(),
  quotation: new Map(),
}

export function useDrilldownData(request: DrilldownRequest | null) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const reqRef = useRef(0)

  useEffect(() => {
    if (!request) {
      setData(null)
      return
    }

    const cache = caches[request.entity]

    if (cache.has(request.id)) {
      setData(cache.get(request.id))
      return
    }

    setData(null)
    setLoading(true)

    const myReq = ++reqRef.current

    const load = async () => {
      try {
        let result: any = { seedRow: request.seedRow }

        if (request.entity === 'customer') {
          const [r, emdbg] = await Promise.allSettled([
            api.get(`/customers/${request.id}/360`),
            api.get(`/emdbg?customer_id=${request.id}`),
          ])

          if (r.status === 'fulfilled') result = { ...result, ...r.value.data }
          result.emdbg_list = emdbg.status === 'fulfilled' ? emdbg.value.data : []
        } else if (request.entity === 'lead') {
          const [lead, tenders, quotations, workorders, activities] = await Promise.allSettled([
            api.get(`/leads/${request.id}`),
            api.get(`/tenders/by-lead/${request.id}`),
            api.get(`/quotations/by-lead/${request.id}`),
            api.get(`/workorders/by-lead/${request.id}`),
            api.get(`/kam/activities?lead_id=${request.id}`),
          ])

          if (lead.status === 'fulfilled') result = { ...result, ...(lead.value.data || {}) }

          // by-lead endpoints return a single object (or null) — normalize to an array
          const tenderRow = tenders.status === 'fulfilled' ? tenders.value.data : null
          const workorderRow = workorders.status === 'fulfilled' ? workorders.value.data : null
          const quotationRows = quotations.status === 'fulfilled' ? (quotations.value.data || []) : []
          result.tenders = tenderRow ? [tenderRow] : []
          result.quotations = quotationRows
          result.activities = activities.status === 'fulfilled' ? activities.value.data : []

          // A work order can be linked to its source quotation directly
          // (wo.quotation_id) even when wo.lead_id was never set on it — by-lead
          // alone would miss those, so also check each of the lead's quotations.
          const byQuotation = await Promise.allSettled(
            quotationRows.map((q: any) => api.get(`/workorders/by-quotation/${q.id}`)),
          )
          const workorderRows = new Map<number, any>()
          if (workorderRow) workorderRows.set(workorderRow.id, workorderRow)
          byQuotation.forEach(r => {
            if (r.status === 'fulfilled' && r.value.data) {
              workorderRows.set(r.value.data.id, r.value.data)
            }
          })
          result.workorders = Array.from(workorderRows.values())

          const pipelineTenderId =
            tenderRow?.id
            || workorderRow?.tender_id
            || Array.from(workorderRows.values()).find((row: any) => row?.tender_id)?.tender_id
            || request.seedRow?.tender_id

          const emdbg = pipelineTenderId
            ? await api.get(`/emdbg/from-tender/${pipelineTenderId}`).catch(() => ({ data: [] }))
            : { data: [] }
          result.emdbg = Array.isArray(emdbg.data) ? emdbg.data : []
        } else if (request.entity === 'tender') {
          const [tender, quotations, workorders, emdbg] = await Promise.allSettled([
            api.get(`/tenders/${request.id}`),
            api.get(`/quotations/all?tender_id=${request.id}`),
            api.get(`/workorders/by-tender/${request.id}`),
            api.get(`/emdbg/from-tender/${request.id}`),
          ])

          const workorderRow = workorders.status === 'fulfilled' ? workorders.value.data : null
          if (tender.status === 'fulfilled') result = { ...result, ...(tender.value.data || {}) }
          result.quotations = quotations.status === 'fulfilled' ? quotations.value.data : []
          result.workorders = workorderRow ? [workorderRow] : []
          result.emdbg = emdbg.status === 'fulfilled' ? emdbg.value.data : []
        } else if (request.entity === 'workorder') {
          const tenderId = request.seedRow?.tender_id
          const leadId = request.seedRow?.lead_id
          const qParams = new URLSearchParams()
          if (tenderId) qParams.set('tender_id', String(tenderId))
          if (leadId) qParams.set('lead_id', String(leadId))

          const [quotations, emdbg] = await Promise.allSettled([
            qParams.toString() ? api.get(`/quotations/all?${qParams}`) : Promise.resolve({ data: [] }),
            tenderId ? api.get(`/emdbg/from-tender/${tenderId}`) : Promise.resolve({ data: [] }),
          ])

          result.quotations = quotations.status === 'fulfilled' ? quotations.value.data : []
          result.emdbg = emdbg.status === 'fulfilled' ? emdbg.value.data : []
        } else if (request.entity === 'quotation') {
          const r = await api.get(`/quotations/${request.id}`)
          result = { ...result, ...r.data }
        } else if (request.entity === 'emdbg') {
          const detail = await api.get(`/emdbg/${request.id}`).catch(() => ({ data: null }))
          if (detail.data) result = { ...result, ...(detail.data || {}) }

          const customerId = result.customer_id || request.seedRow?.customer_id
          const tenderId = result.tender_id || request.seedRow?.tender_id

          if (customerId || tenderId) {
            const p = new URLSearchParams()
            if (customerId) p.set('customer_id', String(customerId))
            if (tenderId) p.set('tender_id', String(tenderId))

            const r = await api.get(`/emdbg?${p}`)
            result.siblings = r.data
          } else {
            result.siblings = []
          }
        }

        if (reqRef.current === myReq) {
          cache.set(request.id, result)
          setData(result)
        }
      } catch {
        if (reqRef.current === myReq) {
          setData({ seedRow: request.seedRow, error: true })
        }
      } finally {
        if (reqRef.current === myReq) {
          setLoading(false)
        }
      }
    }

    load()
  }, [request?.entity, request?.id])

  return { data, loading }
}

export function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-dashed border-slate-100 py-2 text-[12.5px] last:border-b-0">
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold text-slate-900 tabular-nums">{value ?? '—'}</span>
    </div>
  )
}

export function MiniTable({
  rows,
  cols,
  empty,
  onRowClick,
}: {
  rows: any[]
  cols: { key: string; label: string; money?: boolean }[]
  empty: string
  onRowClick?: (row: any) => void
}) {
  if (!rows?.length) {
    return <div className="py-6 text-center text-xs text-slate-400">{empty}</div>
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="bg-slate-50">
            {cols.map(c => (
              <th
                key={c.key}
                className="whitespace-nowrap px-3 py-2 text-left text-[9.5px] font-bold uppercase tracking-wide text-slate-500"
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 50).map((r, i) => (
            <tr
              key={i}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={`border-t border-slate-100 ${onRowClick ? 'cursor-pointer hover:bg-slate-50' : ''}`}
            >
              {cols.map(c => (
                <td key={c.key} className="px-3 py-2 text-slate-700">
                  {c.money ? fmtRsL(num(r[c.key])) : String(r[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── "Pipeline Status" summary — a lead/tender/work order/EMD-BG can all be
// live at once for the same record (no strict linear stage), so instead of
// one status field we show one badge per linked record type that actually
// has data, each carrying its own count + dominant status. ────────────────
function resolveStatusValue(row: any, fields: string | string[]): string {
  const keys = Array.isArray(fields) ? fields : [fields]
  for (const key of keys) {
    const value = row?.[key]
    if (value != null && String(value).trim()) {
      return String(value).trim()
    }
  }

  // Older activity rows can be missing an explicit status even though
  // outcome / follow-up data implies one.
  if (row?.outcome && String(row.outcome).trim()) return 'Completed'
  if (row?.cancellation_reason && String(row.cancellation_reason).trim()) return 'Cancelled'
  if (row?.next_action || row?.next_action_date) return 'Planned'

  return ''
}

function summarizeStatuses(rows: any[], fields: string | string[]): { count: number; status: string } {
  const count = rows?.length || 0
  if (!count) return { count: 0, status: '' }
  const vals = rows
    .map((r: any) => resolveStatusValue(r, fields))
    .filter(Boolean)
  const uniq = Array.from(new Set(vals))
  if (!uniq.length) return { count, status: 'Logged' }
  if (uniq.length === 1) return { count, status: String(uniq[0]) }
  const priority = ['Won', 'Active', 'Completed', 'Converted', 'Released', 'Planned', 'In Progress']
  const hit = priority.find(p => uniq.includes(p))
  return { count, status: hit ? `${hit} +${uniq.length - 1}` : `${uniq.length} statuses` }
}

const PIPELINE_ICONS: Record<string, typeof Info> = {
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

function CustomerOverview({ data }: { data: any }) {
  const c = data.customer || {}
  const ls = data.lead_summary || {}
  const ts = data.tender_summary || {}
  const es = data.emdbg_summary || {}

  return (
    <div className="space-y-4">
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
          {
            label: 'Quotations',
            total: data.quotation_summary?.total || 0,
            detail: `${fmtN(data.quotation_summary?.accepted || 0)} accepted · ${fmtRsL(num(data.quotation_summary?.accepted_value))}`,
            tone: data.quotation_summary?.accepted ? 'Accepted' : data.quotation_summary?.pending ? 'Pending' : data.quotation_summary?.rejected ? 'Rejected' : '',
          },
        ]}
      />
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-slate-200 p-3.5">
          <div className="mb-1.5 text-[10px] font-bold uppercase text-slate-400">Classification</div>
          <KV label="Vertical" value={c.vertical} />
          <KV label="Division" value={c.division} />
          <KV label="Group" value={c.group_name} />
          <KV label="Industry" value={c.industry} />
          <KV label="Tags" value={Array.isArray(c.tags) ? c.tags.join(', ') : c.tags} />
          <KV label="Status" value={c.account_status && <Badge text={c.account_status} />} />
          <KV label="Potential" value={c.account_potential} />
          <KV label="Potential Value" value={fmtRsL(num(c.potential_value))} />
        </div>

        <div className="rounded-xl border border-slate-200 p-3.5">
          <div className="mb-1.5 text-[10px] font-bold uppercase text-slate-400">Billing Address</div>
          <KV label="Address" value={c.billing_address} />
          <KV label="City" value={c.billing_city} />
          <KV label="State" value={c.billing_state} />
          <KV label="Pincode" value={c.billing_pincode} />
          <KV label="Country" value={c.billing_country} />
          <KV label="Area" value={c.billing_area} />
        </div>

        <div className="rounded-xl border border-slate-200 p-3.5">
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

function firstFilled(row: any, keys: string[]) {
  for (const key of keys) {
    const value = row?.[key]
    if (value != null && String(value).trim()) return value
  }
  return undefined
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

function TABS_CLASS(active: boolean) {
  return `px-3 py-2.5 text-[12px] font-semibold border-b-2 transition-colors ${
    active
      ? 'border-indigo-600 text-indigo-700'
      : 'border-transparent text-slate-500 hover:text-slate-800'
  }`
}

export function DrilldownDrawer({
  request,
  onClose,
}: {
  request: DrilldownRequest | null
  onClose: () => void
}) {
  const { data, loading } = useDrilldownData(request)
  const [tab, setTab] = useState('overview')
  const [maximized, setMaximized] = useState(true)

  useEffect(() => {
    setTab('overview')
  }, [request?.entity, request?.id])

  if (!request) return null

  const tabsByEntity: Record<DrilldownEntity, { key: string; label: string }[]> = {
    customer: [
      { key: 'overview', label: 'Overview' },
      { key: 'leads', label: 'Leads' },
      { key: 'tenders', label: 'Tenders' },
      { key: 'emdbg', label: 'EMD/BG' },
      { key: 'workorders', label: 'Work Orders' },
      { key: 'activity', label: 'Activity' },
    ],
    lead: [
      { key: 'overview', label: 'Overview' },
      { key: 'tenders', label: 'Tenders' },
      { key: 'quotations', label: 'Quotations' },
      { key: 'workorders', label: 'Work Orders' },
      { key: 'activities', label: 'Activities' },
    ],
    tender: [
      { key: 'overview', label: 'Overview' },
      { key: 'quotations', label: 'Quotations' },
      { key: 'workorders', label: 'Work Orders' },
      { key: 'emdbg', label: 'EMD/BG' },
    ],
    emdbg: [
      { key: 'overview', label: 'Overview' },
      { key: 'siblings', label: 'Related Instruments' },
    ],
    workorder: [
      { key: 'overview', label: 'Overview' },
      { key: 'quotations', label: 'Quotations' },
      { key: 'emdbg', label: 'EMD/BG' },
    ],
    quotation: [
      { key: 'overview', label: 'Overview' },
      { key: 'line_items', label: 'Line Items' },
    ],
  }

  const tabs = tabsByEntity[request.entity]

  const entityTitle =
    request.entity === 'customer'
      ? 'Customer'
      : request.entity === 'lead'
      ? 'Lead'
      : request.entity === 'tender'
      ? 'Tender'
      : request.entity === 'workorder'
      ? 'Work Order'
      : request.entity === 'quotation'
      ? 'Quotation'
      : 'EMD/BG Instrument'

  const seed = data ? { ...(request.seedRow || {}), ...data } : request.seedRow || {}

  const drawerTitle =
    request.label || seed.lead_title || seed.name || seed.client_name || seed.client || seed.title || entityTitle || 'Details'

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden bg-slate-950/40 p-4 backdrop-blur-sm">
      <div
        className={`flex w-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-all duration-300 ${
          maximized ? 'h-full' : 'max-w-[900px] h-[85vh]'
        }`}
      >
        <div className="flex shrink-0 items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <div className="text-[15px] font-bold text-slate-900">{drawerTitle}</div>
            <div className="mt-0.5 text-[11.5px] text-slate-500">{entityTitle}</div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setMaximized(v => !v)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-900"
              title={maximized ? 'Minimize' : 'Maximize'}
            >
              {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>

            <button
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-red-50 hover:text-red-600"
              title="Close"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="shrink-0 border-b border-slate-200 px-5">
          <div className="flex gap-1 overflow-x-auto">
            {tabs.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={TABS_CLASS(tab === t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading && !data ? (
            <div className="flex h-full items-center justify-center py-16 text-sm text-slate-400">
              Loading…
            </div>
          ) : (
            <div className="space-y-4">
              {request.entity === 'customer' && data && (
                <>
                  {tab === 'overview' && <CustomerOverview data={data} />}

                  {tab === 'leads' && (
  <MiniTable
    rows={data.lead_summary?.all_list || data.lead_summary?.recent || []}
    cols={[
      { key: 'title', label: 'Lead' },
      { key: 'lead_type', label: 'Type' },
      { key: 'status', label: 'Status' },
      { key: 'priority', label: 'Priority' },
      { key: 'source_name', label: 'Source' },
      { key: 'assigned_to_name', label: 'Owner' },
      { key: 'value', label: 'Value', money: true },
    ]}
    empty="No leads found"
  />
)}

                  {tab === 'tenders' && (
                    <MiniTable
                      rows={data.tender_summary?.all_list || data.tender_summary?.recent || []}
                      cols={[
                        { key: 'title', label: 'Tender' },
                        { key: 'status', label: 'Status' },
                        { key: 'result', label: 'Result' },
                        { key: 'assigned_to_name', label: 'Owner' },
                        { key: 'submission', label: 'Submission' },
                        { key: 'est_value', label: 'Est. Value', money: true },
                        { key: 'bid_amount', label: 'Bid', money: true },
                      ]}
                      empty="No tenders found"
                    />
                  )}

                  {tab === 'emdbg' && (
                    <MiniTable
                      rows={data.emdbg_list || []}
                      cols={[
                        { key: 'tender_title', label: 'Tender' },
                        { key: 'instrument_type', label: 'Type' },
                        { key: 'sales_person_name', label: 'Owner' },
                        { key: 'bank_name', label: 'Bank' },
                        { key: 'amount', label: 'Amount', money: true },
                        { key: 'expiry_date', label: 'Expiry' },
                        { key: 'status', label: 'Status' },
                        { key: 'finance_status', label: 'Payment Status' },
                      ]}
                      empty="No instruments found"
                    />
                  )}

                  {tab === 'workorders' && (
                    <MiniTable
                      rows={data.workorder_summary?.recent || []}
                      cols={[
                        { key: 'project', label: 'Project' },
                        { key: 'status', label: 'Status' },
                        { key: 'owner', label: 'Owner' },
                        { key: 'po_number', label: 'PO Number' },
                        { key: 'delivery', label: 'Delivery' },
                        { key: 'po_value', label: 'PO Value', money: true },
                        { key: 'value', label: 'WO Value', money: true },
                      ]}
                      empty="No work orders found"
                    />
                  )}

                  {tab === 'activity' && (
                    <MiniTable
                      rows={data.kam_summary?.recent || []}
                      cols={[
                        { key: 'type', label: 'Type' },
                        { key: 'subject', label: 'Subject' },
                        { key: 'owner', label: 'Owner' },
                        { key: 'date', label: 'Date' },
                        { key: 'status', label: 'Status' },
                        { key: 'next_action_date', label: 'Next Follow-up' },
                        { key: 'next_action', label: 'Next Action' },
                        { key: 'outcome', label: 'Outcome' },
                      ]}
                      empty="No activities logged"
                    />
                  )}
                </>
              )}

              {request.entity === 'lead' && (
                <>
                  {tab === 'overview' && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-3 gap-3">
                        <StatTile label="Status" value={seed.status} tone="indigo" />
                        <StatTile label="Priority" value={seed.priority} tone="amber" />
                        <StatTile label="Est. Value" value={seed.est_value != null ? fmtRsL(num(seed.est_value)) : undefined} tone="emerald" />
                      </div>
                      <PipelineStatusRow
                        items={[
                          { label: 'Tenders', ...summarizeStatuses(data?.tenders || [], ['tender_status', 'status', 'result']) },
                          { label: 'Quotations', ...summarizeStatuses(data?.quotations || [], ['status', 'approval_status']) },
                          { label: 'Work Orders', ...summarizeStatuses(data?.workorders || [], ['wo_status', 'status']) },
                          { label: 'EMD / BG', ...summarizeStatuses(data?.emdbg || [], ['status', 'return_status', 'finance_status']) },
                          { label: 'Activities', ...summarizeStatuses(data?.activities || [], 'status') },
                        ]}
                      />
                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                        <OverviewCard title="Lead Details">
                          <KV label="Lead Ref" value={seed.lead_ref_id} />
                          <KV label="Opportunity Ref" value={seed.opportunity_ref_id} />
                          <KV label="Title" value={firstFilled(seed, ['lead_title', 'title', 'record_label'])} />
                          <KV label="Customer" value={firstFilled(seed, ['customer_name', 'customer'])} />
                          <KV label="Department" value={seed.department} />
                          <KV label="Product" value={seed.product_description} />
                        </OverviewCard>
                        <OverviewCard title="Contact & Source">
                          <KV label="Contact Person" value={seed.contact_person} />
                          <KV label="Designation" value={seed.designation} />
                          <KV label="Mobile" value={seed.mobile} />
                          <KV label="Email" value={seed.email} />
                          <KV label="Source" value={firstFilled(seed, ['source_name', 'lead_source', 'source'])} />
                          <KV label="Channel" value={seed.channel} />
                        </OverviewCard>
                        <OverviewCard title="Ownership & Timeline">
                          <KV label="Owner" value={firstFilled(seed, ['assigned_to_name', 'assigned_to'])} />
                          <KV label="Region" value={seed.region} />
                          <KV label="Branch" value={seed.branch} />
                          <KV label="Follow-up" value={dateValue(seed.follow_up)} />
                          <KV label="Created" value={dateTimeValue(firstFilled(seed, ['lead_created_at', 'created_at']))} />
                          <KV label="Opportunity Created" value={dateTimeValue(seed.opportunity_created_at)} />
                          <KV label="Converted" value={dateTimeValue(seed.converted_at)} />
                          <KV label="Lost" value={dateTimeValue(seed.lost_at)} />
                          <KV label="Conversion Target" value={seed.conversion_target} />
                          <KV label="Approval" value={seed.approval_status} />
                        </OverviewCard>
                      </div>
                    </div>
                  )}

                  {tab === 'tenders' && (
                    <MiniTable
                      rows={data?.tenders || []}
                      cols={[
                        { key: 'tender_title', label: 'Tender' },
                        { key: 'customer_name', label: 'Customer' },
                        { key: 'tender_status', label: 'Status' },
                        { key: 'result', label: 'Result' },
                        { key: 'source_portal', label: 'Portal' },
                        { key: 'submission_date', label: 'Submission' },
                        { key: 'est_value', label: 'Est. Value', money: true },
                        { key: 'bid_amount', label: 'Bid', money: true },
                      ]}
                      empty="No linked tenders"
                    />
                  )}

                  {tab === 'quotations' && (
                    <MiniTable
                      rows={(data?.quotations || []).map((q: any) => ({ ...q, customer_name: q.customer_name || seed.customer }))}
                      cols={[
                        { key: 'revision_label', label: 'Revision' },
                        { key: 'customer_name', label: 'Customer' },
                        { key: 'subject', label: 'Subject' },
                        { key: 'status', label: 'Status' },
                        { key: 'approval_status', label: 'Approval' },
                        { key: 'valid_until', label: 'Valid Until' },
                        { key: 'total_amount', label: 'Amount', money: true },
                      ]}
                      empty="No linked quotations"
                    />
                  )}

                  {tab === 'workorders' && (
                    <MiniTable
                      rows={data?.workorders || []}
                      cols={[
                        { key: 'project_title', label: 'Project' },
                        { key: 'customer_name', label: 'Customer' },
                        { key: 'po_number', label: 'PO Number' },
                        { key: 'wo_status', label: 'Status' },
                        { key: 'progress_percent', label: 'Progress %' },
                        { key: 'delivery_date', label: 'Delivery' },
                        { key: 'po_value', label: 'PO Value', money: true },
                        { key: 'wo_value', label: 'WO Value', money: true },
                      ]}
                      empty="No linked work orders"
                    />
                  )}

                  {tab === 'activities' && (
                    <MiniTable
                      rows={data?.activities || []}
                      cols={[
                        { key: 'activity_type', label: 'Type' },
                        { key: 'subject', label: 'Subject' },
                        { key: 'customer_name', label: 'Customer' },
                        { key: 'user_name', label: 'Owner' },
                        { key: 'activity_date', label: 'Date' },
                        { key: 'status', label: 'Status' },
                        { key: 'next_action_date', label: 'Next Follow-up' },
                        { key: 'next_action', label: 'Next Action' },
                        { key: 'outcome', label: 'Outcome' },
                      ]}
                      empty="No activities logged"
                    />
                  )}
                </>
              )}

              {request.entity === 'tender' && (
                <>
                  {tab === 'overview' && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-3 gap-3">
                        <StatTile label="Status" value={seed.status} tone="indigo" />
                        <StatTile label="Result" value={seed.result} tone="amber" />
                        <StatTile label="Bid Amount" value={fmtRsL(num(seed.bid_amount))} tone="emerald" />
                      </div>
                      <PipelineStatusRow
                        items={[
                          { label: 'Quotations', ...summarizeStatuses(data?.quotations || [], ['status', 'approval_status']) },
                          { label: 'Work Orders', ...summarizeStatuses(data?.workorders || [], ['wo_status', 'status']) },
                          { label: 'EMD / BG', ...summarizeStatuses(data?.emdbg || [], ['status', 'return_status', 'finance_status']) },
                        ]}
                      />
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <OverviewCard title="Details">
                          <KV label="Title" value={seed.title} />
                          <KV label="Customer" value={seed.customer} />
                          <KV label="Est. Value" value={fmtRsL(num(seed.est_value))} />
                          <KV label="Portal" value={seed.portal} />
                        </OverviewCard>
                        <OverviewCard title="Timeline & Ownership">
                          <KV label="Submission Date" value={seed.submission_date} />
                          <KV label="Owner" value={seed.assigned_to} />
                        </OverviewCard>
                      </div>
                    </div>
                  )}

                  {tab === 'quotations' && (
                    <MiniTable
                      rows={data?.quotations || []}
                      cols={[
                        { key: 'quotation_number', label: 'Quotation' },
                        { key: 'revision_label', label: 'Revision' },
                        { key: 'customer_name', label: 'Customer' },
                        { key: 'subject', label: 'Subject' },
                        { key: 'status', label: 'Status' },
                        { key: 'approval_status', label: 'Approval' },
                        { key: 'valid_until', label: 'Valid Until' },
                        { key: 'total_amount', label: 'Amount', money: true },
                      ]}
                      empty="No quotations found"
                    />
                  )}

                  {tab === 'workorders' && (
                    <MiniTable
                      rows={data?.workorders || []}
                      cols={[
                        { key: 'wo_number', label: 'WO Number' },
                        { key: 'project_title', label: 'Project' },
                        { key: 'customer_name', label: 'Customer' },
                        { key: 'po_number', label: 'PO Number' },
                        { key: 'wo_status', label: 'Status' },
                        { key: 'progress_percent', label: 'Progress %' },
                        { key: 'delivery_date', label: 'Delivery' },
                        { key: 'po_value', label: 'PO Value', money: true },
                        { key: 'wo_value', label: 'WO Value', money: true },
                      ]}
                      empty="No work orders found"
                    />
                  )}

                  {tab === 'emdbg' && (
                    <MiniTable
                      rows={data?.emdbg || []}
                      cols={[
                        { key: 'reference_num', label: 'Ref' },
                        { key: 'customer_name_display', label: 'Customer' },
                        { key: 'instrument_type', label: 'Type' },
                        { key: 'sales_person_name', label: 'Owner' },
                        { key: 'bank_name', label: 'Bank' },
                        { key: 'amount', label: 'Amount', money: true },
                        { key: 'expiry_date', label: 'Expiry' },
                        { key: 'status', label: 'Status' },
                        { key: 'finance_status', label: 'Payment Status' },
                      ]}
                      empty="No EMD/BG linked"
                    />
                  )}
                </>
              )}

              {request.entity === 'workorder' && (
                <>
                  {tab === 'overview' && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-3 gap-3">
                        <StatTile label="Status" value={seed.status} tone="indigo" />
                        <StatTile label="Progress" value={seed.progress_percent != null ? `${seed.progress_percent}%` : null} tone="amber" />
                        <StatTile label="WO Value" value={fmtRsL(num(seed.wo_value))} tone="emerald" />
                      </div>
                      <PipelineStatusRow
                        items={[
                          { label: 'Quotations', ...summarizeStatuses(data?.quotations || [], ['status', 'approval_status']) },
                          { label: 'EMD / BG', ...summarizeStatuses(data?.emdbg || [], ['status', 'return_status', 'finance_status']) },
                        ]}
                      />
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <OverviewCard title="Details">
                          <KV label="WO Number" value={seed.wo_number} />
                          <KV label="Project" value={seed.project_title} />
                          <KV label="Customer" value={seed.customer_name} />
                        </OverviewCard>
                        <OverviewCard title="Delivery & Ownership">
                          <KV label="Delivery Date" value={seed.delivery_date} />
                          <KV label="Owner" value={seed.project_manager} />
                        </OverviewCard>
                      </div>
                    </div>
                  )}

                  {tab === 'quotations' && (
                    <MiniTable
                      rows={data?.quotations || []}
                      cols={[
                        { key: 'quotation_number', label: 'Quotation' },
                        { key: 'revision_label', label: 'Revision' },
                        { key: 'customer_name', label: 'Customer' },
                        { key: 'subject', label: 'Subject' },
                        { key: 'status', label: 'Status' },
                        { key: 'approval_status', label: 'Approval' },
                        { key: 'valid_until', label: 'Valid Until' },
                        { key: 'total_amount', label: 'Amount', money: true },
                      ]}
                      empty="No linked quotations"
                    />
                  )}

                  {tab === 'emdbg' && (
                    <MiniTable
                      rows={data?.emdbg || []}
                      cols={[
                        { key: 'reference_num', label: 'Ref' },
                        { key: 'customer_name_display', label: 'Customer' },
                        { key: 'instrument_type', label: 'Type' },
                        { key: 'sales_person_name', label: 'Owner' },
                        { key: 'bank_name', label: 'Bank' },
                        { key: 'amount', label: 'Amount', money: true },
                        { key: 'expiry_date', label: 'Expiry' },
                        { key: 'status', label: 'Status' },
                        { key: 'finance_status', label: 'Payment Status' },
                      ]}
                      empty="No EMD/BG linked"
                    />
                  )}
                </>
              )}

              {request.entity === 'quotation' && (
                <>
                  {tab === 'overview' && (
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
                        <OverviewCard title="Validity & Ownership">
                          <KV label="Valid Until" value={seed.valid_until} />
                          <KV label="Created By" value={seed.created_by} />
                        </OverviewCard>
                      </div>
                    </div>
                  )}

                  {tab === 'line_items' && (
                    <MiniTable
                      rows={data?.line_items || []}
                      cols={[
                        { key: 'description', label: 'Description' },
                        { key: 'quantity', label: 'Qty' },
                        { key: 'unit_price', label: 'Unit Price', money: true },
                        { key: 'tax_percent', label: 'Tax %' },
                        { key: 'line_total', label: 'Line Total', money: true },
                      ]}
                      empty="No line items"
                    />
                  )}
                </>
              )}

              {request.entity === 'emdbg' && (
                <>
                  {tab === 'overview' && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-3 gap-3">
                        <StatTile label="Status" value={firstFilled(seed, ['status', 'expiry_status'])} tone="indigo" />
                        <StatTile label="Type" value={firstFilled(seed, ['instrument_type', 'type'])} tone="amber" />
                        <StatTile label="Amount" value={seed.amount != null ? fmtRsL(num(seed.amount)) : undefined} tone="emerald" />
                      </div>
                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                        <OverviewCard title="Details">
                          <KV label="Reference No" value={firstFilled(seed, ['reference_num', 'record_label'])} />
                          <KV label="Client" value={firstFilled(seed, ['customer_name_display', 'client_name', 'client', 'customer_name'])} />
                          <KV label="Tender No" value={firstFilled(seed, ['tender_num_display', 'tender_num'])} />
                          <KV label="Tender Title" value={firstFilled(seed, ['tender_title', 'title'])} />
                          <KV label="Instrument Number" value={seed.instrument_number} />
                        </OverviewCard>
                        <OverviewCard title="Bank & Dates">
                          <KV label="Bank" value={firstFilled(seed, ['bank_name', 'bank'])} />
                          <KV label="Branch" value={seed.bank_branch} />
                          <KV label="Issued Date" value={dateValue(firstFilled(seed, ['issued_date', 'issue_date']))} />
                          <KV label="Submitted Date" value={dateValue(seed.submitted_date)} />
                          <KV label="Valid From" value={dateValue(seed.valid_from)} />
                          <KV label="Expiry Date" value={dateValue(seed.expiry_date)} />
                        </OverviewCard>
                        <OverviewCard title="Ownership & Workflow">
                          <KV label="Owner" value={firstFilled(seed, ['sales_person_name', 'created_by_name', 'owner'])} />
                          <KV label="Approval" value={firstFilled(seed, ['approval_display', 'approval_status'])} />
                          <KV label="Finance Status" value={seed.finance_status} />
                          <KV label="Return Status" value={seed.return_status} />
                        </OverviewCard>
                      </div>
                    </div>
                  )}

                  {tab === 'siblings' && (
                    <MiniTable
                      rows={(data?.siblings || []).filter((s: any) => s.id !== request.id)}
                      cols={[
                        { key: 'reference_num', label: 'Ref' },
                        { key: 'customer_name_display', label: 'Customer' },
                        { key: 'tender_title', label: 'Tender' },
                        { key: 'instrument_type', label: 'Type' },
                        { key: 'sales_person_name', label: 'Owner' },
                        { key: 'bank_name', label: 'Bank' },
                        { key: 'amount', label: 'Amount', money: true },
                        { key: 'expiry_date', label: 'Expiry' },
                        { key: 'status', label: 'Status' },
                      ]}
                      empty="No related instruments"
                    />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
