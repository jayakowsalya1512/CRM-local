// Audit Logs – list in the shared module grid (BwGrid: search, column quick filters, advanced filter, sorting,
// column chooser, density, saved views, export, server-side paging) like Orders & Projects / Leads; page header and
// panel use the module styles (.bwi .pg / .panel). Filtering, sorting and paging run on the server (/audit-logs).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, Globe, RefreshCw, User as UserIcon } from 'lucide-react'
import { isAxiosError } from 'axios'
import api, { withPassiveSessionActivity } from '@/services/api'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { Modal } from '@/components/ui/Modal'
import { Av, Pill } from '@/pages/customers/kit'
import { formatDateTimeValue } from '@/utils/date'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import '@/pages/deals/deals.css'
import './audit-logs.css'

interface AuditEntry {
  id: number
  user_id: number | null
  user_name: string | null
  module: string
  action: string
  record_id: number | null
  record_name: string | null
  description: string | null
  ip_address: string | null
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  created_at: string | null
}
interface AuditResponse {
  items: AuditEntry[]
  total: number
  modules: { key: string; label: string }[]
  actions: string[]
  users: { id: number; name: string }[]
}

// action → module pill tone (ok / inf / wa / ba / ac / mu – theme colours, light and dark)
const ACTION_TONE: Record<string, string> = {}
'create approve activate workflow_enable'.split(' ').forEach(a => { ACTION_TONE[a] = 'ok' })
'update bulk_update assign reassign login import export upload download integration_change'.split(' ').forEach(a => { ACTION_TONE[a] = 'inf' })
'delete permanent_delete reject bulk_delete'.split(' ').forEach(a => { ACTION_TONE[a] = 'ba' })
'status_change submit_for_approval'.split(' ').forEach(a => { ACTION_TONE[a] = 'wa' })
'restore merge convert workflow_create workflow_update permission_change role_change'.split(' ').forEach(a => { ACTION_TONE[a] = 'ac' })
const actionTone = (action: string) => ACTION_TONE[action] || 'mu'
// same tones for the (Tailwind) details modal
const TONE_CLS: Record<string, string> = { ok: 'bg-emerald-50 text-emerald-700', inf: 'bg-blue-50 text-blue-700', ba: 'bg-red-50 text-red-700',
  wa: 'bg-amber-50 text-amber-700', ac: 'bg-violet-50 text-violet-700', mu: 'bg-slate-100 text-slate-600' }

const humanize = (value: string) => value.replace(/_/g, ' ')
const userLabel = (row: Pick<AuditEntry, 'user_name' | 'user_id'>) => row.user_name || (row.user_id ? `User #${row.user_id}` : 'System / deleted user')

const HIDDEN_RECORD_FIELDS = new Set(['customer_id'])

// Lead fields stored as raw foreign-key ids in old_data/new_data — resolved to
// display names in the Record Details view so it reads like the Lead Details page
// instead of a dump of database columns.
const LEAD_FIELD_LABELS: Record<string, string> = {
  source_id: 'source',
  business_vertical_id: 'business unit',
  assigned_to: 'assigned to',
  competitor_ids: 'competitors',
}

interface LeadRefs {
  sources: Record<number, string>
  competitors: Record<number, string>
  users: Record<number, string>
  businessUnits: Record<number, string>
}

const EMPTY_LEAD_REFS: LeadRefs = { sources: {}, competitors: {}, users: {}, businessUnits: {} }

const USER_REFERENCE_FIELDS = new Set([
  'assigned_to', 'assigned_user_id', 'owner_id', 'record_owner_id',
  'created_by', 'updated_by', 'user_id',
])

function readableAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not set'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return readableAuditValue(JSON.parse(trimmed)) } catch { /* Keep the original value. */ }
    }
    return value
  }
  if (Array.isArray(value)) return value.length ? value.map(item => `? ${typeof item === 'string' ? item.replace(/[._]/g, ' ') : readableAuditValue(item)}`).join('\n') : 'None'
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return entries.length ? entries.map(([key, item]) => `${humanize(key)}: ${readableAuditValue(item)}`).join('\n') : 'None'
  }
  return String(value)
}

function formatAuditFieldValue(key: string, value: unknown, users: Record<number, string>): string {
  if (value === null || value === undefined || value === '') return '—'
  if (USER_REFERENCE_FIELDS.has(key) && !Array.isArray(value)) return users[Number(value)] || `User #${value}`
  if (USER_REFERENCE_FIELDS.has(key) && Array.isArray(value)) return value.map(id => users[Number(id)] || `User #${id}`).join(', ') || '—'
  return readableAuditValue(value)
}

function formatLeadFieldValue(key: string, value: unknown, refs: LeadRefs): string {
  if (value === null || value === undefined || value === '') return '—'
  if (key === 'source_id') return refs.sources[Number(value)] || String(value)
  if (key === 'business_vertical_id') return refs.businessUnits[Number(value)] || String(value)
  if (key === 'assigned_to') return refs.users[Number(value)] || String(value)
  if (key === 'competitor_ids' && Array.isArray(value)) {
    return value.length ? value.map(id => refs.competitors[Number(id)] || String(id)).join(', ') : '—'
  }
  if ((key === 'timeline' || key === 'follow_up') && typeof value === 'string') {
    return formatDateTimeValue(value, { day: '2-digit', month: 'short', year: 'numeric' })
  }
  return readableAuditValue(value)
}

function parseAuditCollection(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function diffRows(oldData: Record<string, unknown> | null, newData: Record<string, unknown> | null, module?: string, refs?: LeadRefs, users: Record<number, string> = {}) {
  const rows: { key: string; oldValue: string; newValue: string }[] = []
  const keys = Array.from(new Set([...Object.keys(oldData || {}), ...Object.keys(newData || {})]))
    .filter(key => !HIDDEN_RECORD_FIELDS.has(key)).sort()
  for (const key of keys) {
    const oldValue = parseAuditCollection(oldData?.[key])
    const newValue = parseAuditCollection(newData?.[key])
    if (Array.isArray(oldValue) && Array.isArray(newValue) && oldValue.every(v => typeof v === 'string') && newValue.every(v => typeof v === 'string')) {
      const before = new Set(oldValue as string[])
      const after = new Set(newValue as string[])
      const removed = [...before].filter(v => !after.has(v))
      const added = [...after].filter(v => !before.has(v))
      if (removed.length || added.length) rows.push({ key, oldValue: removed.length ? readableAuditValue(removed) : 'None', newValue: added.length ? readableAuditValue(added) : 'None' })
    } else if (oldValue && newValue && typeof oldValue === 'object' && typeof newValue === 'object' && !Array.isArray(oldValue) && !Array.isArray(newValue)) {
      const before = oldValue as Record<string, unknown>
      const after = newValue as Record<string, unknown>
      for (const subKey of Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()) {
        const oldText = readableAuditValue(before[subKey])
        const newText = readableAuditValue(after[subKey])
        if (oldText !== newText) rows.push({ key: `${key} ? ${humanize(subKey)}`, oldValue: oldText, newValue: newText })
      }
    } else {
      const oldText = module === 'leads' && refs ? formatLeadFieldValue(key, oldValue, refs) : formatAuditFieldValue(key, oldValue, users)
      const newText = module === 'leads' && refs ? formatLeadFieldValue(key, newValue, refs) : formatAuditFieldValue(key, newValue, users)
      if (oldText !== newText) rows.push({ key, oldValue: oldText, newValue: newText })
    }
  }
  return rows
}

export default function AuditLogPage() {
  const [data, setData] = useState<AuditResponse>({ items: [], total: 0, modules: [], actions: [], users: [] })
  const [module, setModule] = useState('')
  const [action, setAction] = useState('')
  const [userId, setUserId] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  // grid state (search box, column quick filters, advanced filter, sorting, page) – sent to the server
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [gp, setGp] = useState<{ offset: number; limit: number; sorts: [string, number][]; adv: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] } }>(
    { offset: 0, limit: 25, sorts: [], adv: { logic: 'AND', conds: [] } })
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [viewing, setViewing] = useState<AuditEntry | null>(null)
  const [leadRefs, setLeadRefs] = useState<LeadRefs>(EMPTY_LEAD_REFS)
  const [leadRefsLoaded, setLeadRefsLoaded] = useState(false)
  const [auditUsers, setAuditUsers] = useState<Record<number, string>>({})

  useEffect(() => {
    if (viewing?.module !== 'leads' || leadRefsLoaded) return
    setLeadRefsLoaded(true)
    Promise.all([
      api.get('/masters/lead-sources'),
      api.get('/masters/competitors'),
      api.get('/masters/users-for-select'),
      api.get('/masters/business-units'),
    ]).then(([s, comp, u, bv]) => {
      const sources: Record<number, string> = {}
      ;(s.data as any[]).forEach(x => { if (x.id && x.name) sources[x.id] = x.name })
      const competitors: Record<number, string> = {}
      ;(comp.data as any[]).forEach(x => { if (x.id && x.name) competitors[x.id] = x.name })
      const users: Record<number, string> = {}
      ;(u.data as any[]).forEach(x => { if (x.id && x.label) users[x.id] = x.label })
      const businessUnits: Record<number, string> = {}
      ;(bv.data as any[]).forEach(x => {
        const unitName = x.name || x.business_unit || ''
        const verticalName = x.vertical_name || x.category_name || x.business_vertical || x.business_category || ''
        if (x.id && unitName) businessUnits[x.id] = verticalName ? `${unitName} - Vertical: ${verticalName}` : unitName
      })
      setLeadRefs({ sources, competitors, users, businessUnits })
    }).catch(() => {})
  }, [viewing, leadRefsLoaded])

  useEffect(() => {
    if (!viewing || Object.keys(auditUsers).length) return
    api.get('/masters/users-for-select').then(({ data }) => {
      const users: Record<number, string> = {}
      ;(data as any[]).forEach(user => {
        if (user.id) users[user.id] = user.label || user.full_name || user.name || `User #${user.id}`
      })
      setAuditUsers(users)
    }).catch(() => {})
  }, [viewing, auditUsers])

  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') setRefresh(value => value + 1)
    }
    const interval = window.setInterval(refreshVisible, 30000)
    window.addEventListener('focus', refreshVisible)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshVisible)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    const typing = qf.q || Object.values(qf.f).some(Boolean)
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.get<AuditResponse>('/audit-logs', {
          ...withPassiveSessionActivity(), signal: controller.signal,
          params: {
            search: qf.q, module, action, user_id: userId || undefined, date_from: dateFrom || undefined, date_to: dateTo || undefined,
            offset: gp.offset, page_size: gp.limit,
            f: Object.values(qf.f).some(Boolean) ? JSON.stringify(qf.f) : undefined,
            adv: gp.adv.conds.length ? JSON.stringify(gp.adv) : undefined,
            sorts: gp.sorts.length ? JSON.stringify(gp.sorts) : undefined,
          },
        })
        if (!controller.signal.aborted) setData(response.data)
      } catch (err: unknown) {
        const detail = isAxiosError(err) ? err.response?.data?.detail : undefined
        if (!controller.signal.aborted) setError(typeof detail === 'string' ? detail : 'Unable to load audit logs. Please retry.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, typing ? 250 : 0)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [qf, gp, module, action, userId, dateFrom, dateTo, refresh])

  const onQuery = useCallback((x: { q: string; f: Record<string, string> }) => setQf(c => JSON.stringify(c) === JSON.stringify(x) ? c : x), [])
  const onServer = useCallback((x: typeof gp) => setGp(c => JSON.stringify(c) === JSON.stringify(x) ? c : x), [])
  const filtered = !!(module || action || userId || dateFrom || dateTo)
  const clearFilters = () => { setModule(''); setAction(''); setUserId(''); setDateFrom(''); setDateTo('') }
  const dateTime = (value?: string | null) => value ? formatDateTimeValue(value, { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—'
  const moduleLabel = useMemo(() => Object.fromEntries(data.modules.map(m => [m.key, m.label])), [data.modules])

  // columns: Date & time · User · Module · Action · Record name · IP address · Changes (+ row ⋯ menu)
  const cols: GridCol<AuditEntry>[] = useMemo(() => [
    { k: 'created_at', t: 'Date & time', w: 190, date: true, sv: r => r.created_at || '', txt: r => dateTime(r.created_at), fn: r => <span className="nowrap">{dateTime(r.created_at)}</span> },
    { k: 'user', t: 'User', w: 190, txt: r => userLabel(r), sv: r => userLabel(r),
      fn: r => <span className="row" style={{ gap: 6, display: 'inline-flex', minWidth: 0 }} title={userLabel(r)}><Av name={userLabel(r)} /><b className="al-trunc">{userLabel(r)}</b></span> },
    { k: 'module', t: 'Module', w: 150, txt: r => moduleLabel[r.module] || humanize(r.module), fn: r => <Pill s={moduleLabel[r.module] || humanize(r.module)} t="mu" /> },
    { k: 'action', t: 'Action', w: 150, txt: r => humanize(r.action), fn: r => <Pill s={humanize(r.action)} t={actionTone(r.action)} /> },
    { k: 'record_name', t: 'Record name', w: 230, txt: r => r.record_name || (r.record_id ? `#${r.record_id}` : ''),
      fn: r => r.record_name ? <span className="al-trunc" title={r.record_name}>{r.record_name}</span> : r.record_id && r.module !== 'auth' ? <span className="mono mu">#{r.record_id}</span> : <span className="mu">—</span> },
    { k: 'ip_address', t: 'IP address', w: 130, txt: r => r.ip_address || '', fn: r => r.ip_address ? <span className="mono">{r.ip_address}</span> : <span className="mu">—</span> },
    { k: 'changes', t: 'Changes', w: 100, nogroup: true, txt: () => '',
      fn: r => <a onClick={e => { e.stopPropagation(); setViewing(r) }}><Ic n="eye" size={13} /> View</a> },
  ], [moduleLabel]) // eslint-disable-line react-hooks/exhaustive-deps

  const menu = useCallback((r: AuditEntry): GridMenuItem[] => [{ l: 'View changes', i: <Ic n="eye" />, fn: () => setViewing(r) }], [])

  const tools = <span className="ctools">
    <select className={`in sm ${module ? 'on' : ''}`} style={{ width: 150 }} value={module} onChange={e => setModule(e.target.value)} aria-label="Module">
      <option value="">All modules</option>{data.modules.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}</select>
    <select className={`in sm ${action ? 'on' : ''}`} style={{ width: 140 }} value={action} onChange={e => setAction(e.target.value)} aria-label="Action">
      <option value="">All actions</option>{data.actions.map(v => <option key={v} value={v}>{humanize(v)}</option>)}</select>
    <select className={`in sm ${userId ? 'on' : ''}`} style={{ width: 150 }} value={userId} onChange={e => setUserId(e.target.value)} aria-label="User">
      <option value="">All users</option>{data.users.map(u => <option key={u.id} value={String(u.id)}>{u.name}</option>)}</select>
    <input type="date" className="in sm" style={{ width: 138 }} value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)} aria-label="From date" title="From date" />
    <input type="date" className="in sm" style={{ width: 138 }} value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} aria-label="To date" title="To date" />
    {filtered && <button type="button" className="btn s p" onClick={clearFilters}>Clear filters ✕</button>}
  </span>

  return <div className="bwi">
    <div className="pg">
      <div><div className="crumb">Administration</div><h1>Audit Logs</h1></div>
      <span className="cnt">{data.total.toLocaleString('en-IN')} records</span>
      <span className="fl" />
      <button type="button" className="btn" aria-label="Refresh" title="Refresh" onClick={() => setRefresh(v => v + 1)} disabled={loading}>
        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>
    </div>
    <div className="note inf mb">Recorded activity for your tenant. Audit records are read-only – open a row to see the field changes.</div>
    <div className="panel" aria-busy={loading}>
      {error ? <div role="alert" className="empty">{error} · <a onClick={() => setRefresh(v => v + 1)}>Retry</a></div>
        : <BwGrid id="audit-logs" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => setViewing(r)} tools={tools} menu={menu}
          server={{ total: data.total, onChange: onServer }} onQuery={onQuery} empty={loading ? 'Loading…' : 'No audit records match these filters.'} />}
    </div>

    {viewing && <Modal open onClose={() => setViewing(null)} title="Audit Entry Details" size="2xl">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-4">
          <span className="inline-block rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{humanize(viewing.module)}</span>
          <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLS[actionTone(viewing.action)]}`}>{humanize(viewing.action)}</span>
          {viewing.record_name && <span className="text-sm font-semibold text-slate-800">{viewing.record_name}</span>}
        </div>

        <div className="grid grid-cols-3 gap-4 text-sm">
          <div className="flex items-start gap-2">
            <UserIcon size={14} className="mt-0.5 flex-none text-slate-400" />
            <div><p className="text-xs text-slate-400">User</p><p className="font-medium text-slate-700">{userLabel(viewing)}</p></div>
          </div>
          <div className="flex items-start gap-2">
            <Globe size={14} className="mt-0.5 flex-none text-slate-400" />
            <div><p className="text-xs text-slate-400">IP Address</p><p className="font-medium text-slate-700">{viewing.ip_address || '—'}</p></div>
          </div>
          <div className="flex items-start gap-2">
            <Clock size={14} className="mt-0.5 flex-none text-slate-400" />
            <div><p className="text-xs text-slate-400">Timestamp</p><p className="font-medium text-slate-700">{dateTime(viewing.created_at)}</p></div>
          </div>
        </div>

        {viewing.description && <div className="rounded-lg bg-slate-50 p-3">
          <p className="text-xs text-slate-400">Description</p>
          <p className="mt-0.5 text-sm text-slate-700">{viewing.description}</p>
        </div>}

        <div>
          {viewing.old_data && viewing.new_data ? <>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">Field Changes</p>
            <div className="rounded-lg border border-slate-200">
              <table className="w-full table-fixed text-left text-xs">
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr>
                  <th className="w-1/5 px-3 py-2 font-semibold">Field</th>
                  <th className="px-3 py-2 font-semibold">Before</th>
                  <th className="px-3 py-2 font-semibold">After</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {diffRows(viewing.old_data, viewing.new_data, viewing.module, leadRefs, auditUsers).map(row => <tr key={row.key} className={row.oldValue !== row.newValue ? 'bg-amber-50/40' : ''}>
                    <td className="px-3 py-2 font-medium text-slate-600">{viewing.module === 'leads' && LEAD_FIELD_LABELS[row.key] || humanize(row.key)}</td>
                    <td className="whitespace-pre-wrap break-words px-3 py-2 align-top text-slate-500 [overflow-wrap:anywhere]">{row.oldValue}</td>
                    <td className="whitespace-pre-wrap break-words px-3 py-2 align-top text-slate-700 [overflow-wrap:anywhere]">{row.newValue}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          </> : viewing.old_data || viewing.new_data ? <>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
              {viewing.action === 'delete' ? 'Deleted Record Details' : 'Record Details'}
            </p>
            <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-xs lg:grid-cols-2">
                  {Object.entries(viewing.old_data || viewing.new_data || {}).filter(([key]) => !HIDDEN_RECORD_FIELDS.has(key)).map(([key, value]) => <div key={key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] bg-white">
                    <dt className="break-words bg-slate-50 px-3 py-2 font-medium text-slate-600">{viewing.module === 'leads' && LEAD_FIELD_LABELS[key] || humanize(key)}</dt>
                    <dd className="min-w-0 whitespace-pre-wrap px-3 py-2 text-slate-700 [overflow-wrap:anywhere]">
                      {viewing.module === 'leads' ? formatLeadFieldValue(key, value, leadRefs) : formatAuditFieldValue(key, value, auditUsers)}
                    </dd>
                  </div>)}
            </dl>
          </> : (
            <>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">Field Changes</p>
              <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">No before/after values were recorded for this action.</p>
            </>
          )}
        </div>
      </div>
    </Modal>}
  </div>
}
