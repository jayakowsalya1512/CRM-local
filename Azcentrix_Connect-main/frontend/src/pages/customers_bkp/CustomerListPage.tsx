import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  Building2, Plus, Trash2, Pencil, MapPin,
  MoreVertical, Eye, Phone, Mail,
  TrendingUp, Activity, ExternalLink, IndianRupee,
  BarChart2, AlertTriangle, Info, FileText,
  Package, ShieldCheck, RefreshCw, User,
  Boxes, PhoneCall, Video, Navigation, CalendarCheck,
  Sparkles, AlertCircle,
} from 'lucide-react'
import { useUIStore } from '@/store'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import { DataTable, Column } from '@/components/ui/DataTable'
import SlidePanel from '@/components/ui/SlidePanel'
import { PageHeader, useToast } from '@/components/ui/FormComponents'
import { usePermissions } from '@/hooks/Usepermissions'
import { formatDateValue } from '@/utils/date'
import { useModuleName } from '@/context/ModuleLabelsContext'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Contact {
  id?: number; contact_name: string; designation: string; department: string
  office_phone: string; mobile: string; office_email: string
  is_primary: boolean; notes: string
}
interface CurrentUser { id: number | null; role: string; full_name: string }

type C360SubTab = 'overview' | 'leads' | 'tenders' | 'workorders' | 'payments' | 'products' | 'activities' | 'emdbg'

// ─── Constants ────────────────────────────────────────────────────────────────

const CEO_ROLES     = ['admin', 'ceo']
const MANAGER_ROLES = ['manager', 'vp']
const SALES_ROLES   = ['sales', 'support', 'accounts']

const C360_TABS: { id: C360SubTab; label: string; icon: React.ReactNode }[] = [
  { id: 'overview',   label: 'Overview',    icon: <BarChart2   size={14} /> },
  { id: 'leads',      label: 'Leads',       icon: <TrendingUp  size={14} /> },
  { id: 'tenders',    label: 'Tenders',     icon: <FileText    size={14} /> },
  { id: 'workorders', label: 'Work Orders', icon: <Package     size={14} /> },
  { id: 'payments',   label: 'Payments',    icon: <IndianRupee size={14} /> },
  { id: 'products',   label: 'Products',    icon: <Boxes       size={14} /> },
  { id: 'activities', label: 'KAM',         icon: <Activity    size={14} /> },
  { id: 'emdbg',      label: 'BG / EMD',    icon: <ShieldCheck size={14} /> },
]

const FLAG_CFG: Record<string, { bg: string; border: string; text: string; sub: string; dot: string; icon: React.ReactNode }> = {
  critical: { bg: 'bg-rose-50',  border: 'border-rose-200',  text: 'text-rose-700',  sub: 'text-rose-500',  dot: 'bg-rose-500',  icon: <AlertCircle   size={13} className="text-rose-500 flex-shrink-0 mt-0.5" /> },
  warning:  { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-800', sub: 'text-amber-600', dot: 'bg-amber-500', icon: <AlertTriangle size={13} className="text-amber-500 flex-shrink-0 mt-0.5" /> },
  info:     { bg: 'bg-sky-50',   border: 'border-sky-200',   text: 'text-sky-800',   sub: 'text-sky-600',   dot: 'bg-sky-500',   icon: <Info          size={13} className="text-sky-500 flex-shrink-0 mt-0.5" /> },
}

const S_PILL: Record<string, string> = {
  Won: 'bg-emerald-100 text-emerald-700 border-emerald-200', Lost: 'bg-rose-100 text-rose-600 border-rose-200',
  Pending: 'bg-amber-100 text-amber-700 border-amber-200', Completed: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  Active: 'bg-blue-100 text-blue-700 border-blue-200', Converted: 'bg-violet-100 text-violet-700 border-violet-200',
  Assigned: 'bg-blue-100 text-blue-700 border-blue-200', 'Opportunity Created': 'bg-indigo-100 text-indigo-700 border-indigo-200',
  'In Progress': 'bg-blue-100 text-blue-700 border-blue-200', Delayed: 'bg-rose-100 text-rose-600 border-rose-200',
  Submitted: 'bg-teal-100 text-teal-700 border-teal-200', Cancelled: 'bg-gray-100 text-gray-500 border-gray-200',
  Closed: 'bg-gray-100 text-gray-500 border-gray-200', Aligned: 'bg-slate-100 text-slate-600 border-slate-200',
  Draft: 'bg-gray-100 text-gray-500 border-gray-200', 'On Hold': 'bg-amber-100 text-amber-700 border-amber-200',
  High: 'bg-rose-50 text-rose-600 border-rose-200', Medium: 'bg-amber-50 text-amber-700 border-amber-200',
  Low: 'bg-gray-50 text-gray-500 border-gray-200', Qualified: 'bg-cyan-100 text-cyan-700 border-cyan-200',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) =>
  n >= 10000000 ? `₹${(n / 10000000).toFixed(1)}Cr`
  : n >= 100000  ? `₹${(n / 100000).toFixed(1)}L`
  : n >= 1000    ? `₹${(n / 1000).toFixed(0)}K`
  : `₹${n.toLocaleString('en-IN')}`

const fmtPct = (n: number | null | undefined) => n == null ? '—' : `${n.toFixed(1)}%`

const fmtCompactValue = (n: number) =>
  n >= 10000000 ? `${(n / 10000000).toFixed(1)}Cr`
  : n >= 100000  ? `${(n / 100000).toFixed(1)}L`
  : n >= 1000    ? `${(n / 1000).toFixed(1)}K`
  : `${n.toLocaleString('en-IN')}`

const fmtTableCurrency = (value: unknown) => { const n = Number(value || 0); return n > 0 ? `₹${fmtCompactValue(n)}` : '-' }
const fmtTableDate     = (value: unknown) => formatDateValue(value, undefined, '-')

const primaryContactOf = (row: any) => row.contacts?.find((c: any) => c.is_primary) ?? row.contacts?.[0] ?? null
const toTitleCase = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase())

const copyText = async (value: string) => {
  if (!value) return false
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(value); return true } } catch {}
  const textarea = document.createElement('textarea')
  textarea.value = value; textarea.setAttribute('readonly', ''); textarea.style.position = 'fixed'; textarea.style.left = '-9999px'
  document.body.appendChild(textarea); textarea.select()
  let copied = false
  try { copied = document.execCommand('copy') } finally { document.body.removeChild(textarea) }
  return copied
}

// ─── useCurrentUser ───────────────────────────────────────────────────────────

function useCurrentUser(): CurrentUser {
  const [user, setUser] = useState<CurrentUser>({ id: null, role: '', full_name: '' })
  useEffect(() => {
    api.get('/auth/me')
      .then((r: any) => setUser({ id: r.data.id ?? null, role: (r.data.role ?? '').toLowerCase(), full_name: r.data.full_name ?? '' }))
      .catch(() => {
        const tokenKeys = ['access_token', 'token', 'authToken', 'jwt']
        for (const key of tokenKeys) {
          const token = localStorage.getItem(key)
          if (token && token.split('.').length === 3) {
            try { const payload = JSON.parse(atob(token.split('.')[1])); if (payload.sub) { setUser(prev => ({ ...prev, id: Number(payload.sub) })); break } } catch {}
          }
        }
      })
  }, [])
  return user
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const SPill = ({ s }: { s: string }) => (
  <span className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full border ${S_PILL[s] || 'bg-gray-100 text-gray-500 border-gray-200'}`}>{s}</span>
)

function KpiCard({ label, value, sub, color = 'slate', warn = false, icon }: { label: string; value: string | number; sub?: string; color?: string; warn?: boolean; icon?: React.ReactNode }) {
  const tc = warn ? 'text-rose-600' : color === 'green' ? 'text-emerald-700' : color === 'blue' ? 'text-blue-700' : color === 'amber' ? 'text-amber-600' : color === 'violet' ? 'text-violet-700' : color === 'teal' ? 'text-teal-700' : color === 'red' ? 'text-rose-600' : 'text-slate-800'
  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm px-4 py-3.5 flex flex-col gap-1.5 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider truncate flex-1">{label}</p>
        {icon && <span className="text-slate-300">{icon}</span>}
      </div>
      <p className={`text-base font-bold leading-tight ${tc}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 truncate">{sub}</p>}
    </div>
  )
}

function MiniBar({ v, t, color = 'bg-blue-500' }: { v: number; t: number; color?: string }) {
  const pct = t > 0 ? Math.min(100, Math.round(v / t * 100)) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} /></div>
      <span className="text-xs text-slate-400 w-8 text-right">{pct}%</span>
    </div>
  )
}

function SecTitle({ icon, title, count }: { icon: React.ReactNode; title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-slate-400">{icon}</span>
      <h4 className="text-sm font-bold text-slate-700">{title}</h4>
      {count !== undefined && <span className="ml-auto text-xs font-semibold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{count}</span>}
    </div>
  )
}

function Empty({ icon, msg, sub }: { icon: React.ReactNode; msg: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <span className="text-slate-200 text-3xl">{icon}</span>
      <p className="text-sm font-semibold text-slate-400">{msg}</p>
      {sub && <p className="text-xs text-slate-300">{sub}</p>}
    </div>
  )
}

// ─── 360 Tab Components ───────────────────────────────────────────────────────

function Tab360Overview({ data }: { data: any }) {
  const flags = data?.flags || []; const pay = data?.payment_summary || {}
  const leads = data?.lead_summary || {}; const tend = data?.tender_summary || {}
  const wo = data?.workorder_summary || {}; const kam = data?.kam_summary || {}
  const ak = data?.assigned_kam || {}; const ps = data?.products_supplied || []
  const conts = data?.contacts || []

  const kpis = [
    { label: 'Open Leads', value: leads.open ?? 0, sub: `${leads.total ?? 0} total`, color: 'blue', icon: <TrendingUp size={14} /> },
    { label: 'Active Tenders', value: tend.active ?? 0, sub: `${tend.total ?? 0} total`, color: 'violet', icon: <FileText size={14} /> },
    { label: 'Work Orders', value: wo.active ?? 0, sub: `₹${fmtCompactValue(wo.value ?? 0)}`, color: 'teal', icon: <Package size={14} /> },
    { label: 'Payments Due', value: fmtTableCurrency(pay.overdue_amount), warn: (pay.overdue_amount ?? 0) > 0, icon: <IndianRupee size={14} /> },
  ]

  return (
    <div className="space-y-5">
      {flags.length > 0 && (
        <div className="space-y-2">
          {flags.map((f: any, i: number) => {
            const cfg = FLAG_CFG[f.severity] ?? FLAG_CFG.info
            return (
              <div key={i} className={`flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border ${cfg.bg} ${cfg.border}`}>
                {cfg.icon}
                <div className="flex-1 min-w-0">
                  <p className={`text-xs font-bold ${cfg.text}`}>{f.title}</p>
                  {f.detail && <p className={`text-xs mt-0.5 ${cfg.sub}`}>{f.detail}</p>}
                </div>
              </div>
            )
          })}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">{kpis.map(k => <KpiCard key={k.label} {...k} />)}</div>
      {ak?.name && (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm px-4 py-3.5">
          <SecTitle icon={<User size={14} />} title="Assigned KAM" />
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-sm flex-shrink-0">{ak.name?.charAt(0)?.toUpperCase()}</div>
            <div>
              <p className="text-sm font-bold text-slate-800">{ak.name}</p>
              {ak.email && <p className="text-xs text-slate-400">{ak.email}</p>}
            </div>
          </div>
        </div>
      )}
      {conts.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm px-4 py-3.5">
          <SecTitle icon={<PhoneCall size={14} />} title="Contacts" count={conts.length} />
          <div className="space-y-2.5">
            {conts.slice(0, 3).map((c: any, i: number) => (
              <div key={i} className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 text-xs font-bold flex-shrink-0">{c.contact_name?.charAt(0)?.toUpperCase()}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-slate-700 truncate">{c.contact_name}</p>
                  <p className="text-xs text-slate-400 truncate">{c.designation}{c.department ? ` · ${c.department}` : ''}</p>
                </div>
                {c.mobile && <a href={`tel:${c.mobile}`} className="text-xs text-blue-600 hover:text-blue-700 flex-shrink-0"><Phone size={12} /></a>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Tab360Leads({ data }: { data: any }) {
  const { singularLower } = useModuleName('customers')
  const leads = data?.lead_summary || {}
  const items = data?.recent_leads || []
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2.5">
        <KpiCard label="Total" value={leads.total ?? 0} color="blue" />
        <KpiCard label="Open" value={leads.open ?? 0} color="amber" />
        <KpiCard label="Won" value={leads.won ?? 0} color="green" />
      </div>
      {leads.total > 0 && <MiniBar v={leads.won ?? 0} t={leads.total ?? 0} color="bg-emerald-500" />}
      {items.length > 0 ? (
        <div className="space-y-2">
          <SecTitle icon={<TrendingUp size={14} />} title="Recent Leads" count={items.length} />
          {items.map((l: any, i: number) => (
            <div key={i} className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 bg-white">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-slate-800 truncate">{l.title || l.lead_title || `Lead #${l.id}`}</p>
                <p className="text-xs text-slate-400 truncate mt-0.5">{fmtTableDate(l.created_at)}</p>
              </div>
              <SPill s={l.status} />
            </div>
          ))}
        </div>
      ) : <Empty icon={<TrendingUp />} msg={`No leads for this ${singularLower}`} />}
    </div>
  )
}

function Tab360Tenders({ data }: { data: any }) {
  const { singularLower } = useModuleName('tenders')
  const tend = data?.tender_summary || {}
  const items = data?.recent_tenders || []
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2.5">
        <KpiCard label="Total" value={tend.total ?? 0} color="blue" />
        <KpiCard label="Active" value={tend.active ?? 0} color="violet" />
        <KpiCard label="Won" value={tend.won ?? 0} color="green" />
      </div>
      {items.length > 0 ? (
        <div className="space-y-2">
          <SecTitle icon={<FileText size={14} />} title={`Recent ${singularLower}s`} count={items.length} />
          {items.map((t: any, i: number) => (
            <div key={i} className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 bg-white">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-slate-800 truncate">{t.title || t.tender_number || `Tender #${t.id}`}</p>
                <p className="text-xs text-slate-400 mt-0.5">{fmtTableDate(t.created_at)}{t.value ? ` · ${fmtTableCurrency(t.value)}` : ''}</p>
              </div>
              <SPill s={t.status} />
            </div>
          ))}
        </div>
      ) : <Empty icon={<FileText />} msg={`No ${singularLower}s`} />}
    </div>
  )
}

function Tab360WorkOrders({ data }: { data: any }) {
  const wo = data?.workorder_summary || {}
  const items = data?.recent_workorders || []
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5">
        <KpiCard label="Total Value" value={fmtTableCurrency(wo.value)} color="teal" />
        <KpiCard label="Active" value={wo.active ?? 0} />
      </div>
      {items.length > 0 ? (
        <div className="space-y-2">
          <SecTitle icon={<Package size={14} />} title="Recent Work Orders" count={items.length} />
          {items.map((w: any, i: number) => (
            <div key={i} className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 bg-white">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-slate-800 truncate">{w.title || w.wo_number || `WO #${w.id}`}</p>
                <p className="text-xs text-slate-400 mt-0.5">{fmtTableCurrency(w.value)}{w.delivery_date ? ` · Due ${fmtTableDate(w.delivery_date)}` : ''}</p>
              </div>
              <SPill s={w.status} />
            </div>
          ))}
        </div>
      ) : <Empty icon={<Package />} msg="No work orders" />}
    </div>
  )
}

function Tab360Payments({ data }: { data: any }) {
  const pay = data?.payment_summary || {}; const kam = data?.kam_summary || {}
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5">
        <KpiCard label="Received" value={fmtTableCurrency(pay.received_amount)} color="green" icon={<CheckCircle size={14} />} />
        <KpiCard label="Overdue"  value={fmtTableCurrency(pay.overdue_amount)}  warn={(pay.overdue_amount ?? 0) > 0} icon={<AlertCircle size={14} />} />
        <KpiCard label="Pending"  value={fmtTableCurrency(pay.pending_amount)}  color="amber" />
        <KpiCard label="Total"    value={fmtTableCurrency(pay.total_amount)} />
      </div>
      {kam?.last_visit_date && (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm px-4 py-3.5">
          <SecTitle icon={<CalendarCheck size={14} />} title="Last KAM Visit" />
          <p className="text-sm font-bold text-slate-800">{fmtTableDate(kam.last_visit_date)}</p>
          {kam.visit_count && <p className="text-xs text-slate-400 mt-0.5">{kam.visit_count} total visits</p>}
        </div>
      )}
    </div>
  )
}

function Tab360Products({ data }: { data: any }) {
  const [view, setView] = useState<'supplied' | 'demanded'>('supplied')
  const supplied = data?.products_supplied || []
  const demanded = data?.products_demanded || []
  const gapCount = demanded.filter((p: any) => p.lead_no_tender && p.lead_count >= 1).length
  const list = view === 'supplied' ? supplied : demanded
  return (
    <div className="space-y-4">
      <div className="flex gap-1.5 bg-slate-100 rounded-xl p-1">
        {[{ id: 'supplied', label: 'Supplied' }, { id: 'demanded', label: `Demanded${gapCount > 0 ? ` (${gapCount} gaps)` : ''}` }].map(v => (
          <button key={v.id} onClick={() => setView(v.id as any)}
            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${view === v.id ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{v.label}</button>
        ))}
      </div>
      {list.length > 0 ? (
        <div className="space-y-2">
          {list.map((p: any, i: number) => (
            <div key={i} className="flex items-center gap-3 p-3 rounded-xl border border-slate-100 bg-white">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-slate-800 truncate">{p.name || p.product_name}</p>
                <p className="text-xs text-slate-400 mt-0.5">{p.category || ''}{p.count ? ` · ×${p.count}` : ''}</p>
              </div>
              {view === 'demanded' && p.lead_no_tender && <span className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full font-semibold">Gap</span>}
            </div>
          ))}
        </div>
      ) : <Empty icon={<Boxes />} msg={view === 'supplied' ? 'No products supplied' : 'No products demanded'} />}
    </div>
  )
}

function Tab360KAM({ data }: { data: any }) {
  const kam = data?.kam_summary || {}
  const items = data?.recent_kam || []
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5">
        <KpiCard label="Total Activities" value={kam.total ?? 0} color="blue" icon={<Activity size={14} />} />
        <KpiCard label="Last 30 Days"     value={kam.recent ?? 0} />
      </div>
      {items.length > 0 ? (
        <div className="space-y-2">
          <SecTitle icon={<Activity size={14} />} title="Recent Activities" count={items.length} />
          {items.map((k: any, i: number) => (
            <div key={i} className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 bg-white">
              <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-blue-50 flex-shrink-0 mt-0.5">
                {k.activity_type === 'visit' ? <Navigation size={13} className="text-blue-600" /> : k.activity_type === 'call' ? <PhoneCall size={13} className="text-blue-600" /> : k.activity_type === 'video' ? <Video size={13} className="text-blue-600" /> : <Activity size={13} className="text-blue-600" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-slate-800 truncate capitalize">{k.activity_type || 'Activity'}</p>
                <p className="text-xs text-slate-400 mt-0.5">{fmtTableDate(k.activity_date)}{k.notes ? ` · ${k.notes.slice(0, 60)}` : ''}</p>
              </div>
            </div>
          ))}
        </div>
      ) : <Empty icon={<Activity />} msg="No KAM activities recorded" />}
    </div>
  )
}

function Tab360EMDBG({ data }: { data: any }) {
  const bg = data?.emdbg_summary || {}
  const items = data?.recent_emdbg || []
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5">
        <KpiCard label="Active BGs" value={bg.active ?? 0} color="blue" icon={<ShieldCheck size={14} />} />
        <KpiCard label="Total Value" value={fmtTableCurrency(bg.total_value)} />
      </div>
      {items.length > 0 ? (
        <div className="space-y-2">
          <SecTitle icon={<ShieldCheck size={14} />} title="Recent BG / EMD" count={items.length} />
          {items.map((e: any, i: number) => (
            <div key={i} className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 bg-white">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-slate-800 truncate">{e.bg_number || `BG #${e.id}`}</p>
                <p className="text-xs text-slate-400 mt-0.5">{fmtTableCurrency(e.amount)}{e.expiry_date ? ` · Exp ${fmtTableDate(e.expiry_date)}` : ''}</p>
              </div>
              <SPill s={e.status} />
            </div>
          ))}
        </div>
      ) : <Empty icon={<ShieldCheck />} msg="No BG / EMD records" />}
    </div>
  )
}

// ─── Intelligence360Tab ───────────────────────────────────────────────────────

function Intelligence360Tab({ customers, initialCustomerId, currentUser, teamMemberUsers }: {
  customers: any[]; initialCustomerId: number | null
  currentUser: CurrentUser; teamMemberUsers: { value: number; label: string }[]
}) {
  const { label: moduleLabel, singular, singularLower, labelLower } = useModuleName('customers')
  const { label: tenderLabel } = useModuleName('tenders')
  const { label: emdbgLabel }  = useModuleName('emdbg')

  const displayC360Tabs = C360_TABS.map(t => ({
    ...t,
    label: t.id === 'leads' ? moduleLabel.replace('s', '') + ' Leads' : t.id === 'tenders' ? tenderLabel : t.id === 'emdbg' ? emdbgLabel : t.label,
  }))

  const [selectedId, setSelectedId] = useState<number | null>(initialCustomerId)
  const [subTab,     setSubTab]     = useState<C360SubTab>('overview')
  const [data,       setData]       = useState<any>(null)
  const [loading,    setLoading]    = useState(false)
  const [err,        setErr]        = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [search,     setSearch]     = useState('')
  const searchRef                   = useRef<HTMLInputElement>(null)
  const dropdownRef                 = useRef<HTMLDivElement>(null)

  const statusDot: Record<string, string> = { Active: 'bg-emerald-400', Prospect: 'bg-blue-400', Inactive: 'bg-gray-400', Churned: 'bg-rose-400' }

  const scopedCustomers = customers
  const filtered = React.useMemo(() =>
    search.trim() ? scopedCustomers.filter(c =>
      c.customer_name?.toLowerCase().includes(search.toLowerCase()) ||
      c.billing_city?.toLowerCase().includes(search.toLowerCase()) ||
      c.group_name?.toLowerCase().includes(search.toLowerCase())
    ) : scopedCustomers
  , [scopedCustomers, search])

  const load360 = useCallback(async (id: number) => {
    setLoading(true); setErr(null); setData(null)
    try {
      const r = await api.get(`/customers/${id}/360`)
      setData(r.data)
    } catch {
      setErr('Failed to load 360° data')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { if (selectedId) load360(selectedId) }, [selectedId, load360])
  useEffect(() => { if (initialCustomerId) setSelectedId(initialCustomerId) }, [initialCustomerId])
  useEffect(() => {
    if (searchOpen && searchRef.current) setTimeout(() => searchRef.current?.focus(), 60)
  }, [searchOpen])
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setSearchOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selected   = scopedCustomers.find((c: any) => c.id === selectedId)
  const fc         = data?.flag_count   || {}
  const cust       = data?.customer     || {}
  const ak         = data?.assigned_kam || {}
  const scopeLabel = CEO_ROLES.includes(currentUser.role) ? 'All accounts' : MANAGER_ROLES.includes(currentUser.role) ? 'Team accounts' : 'Your accounts'

  return (
    <div className="flex gap-4 min-h-[600px]">
      {/* Sidebar */}
      <div className="w-64 flex-shrink-0 bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
        <div className="px-3 pt-3 pb-2 border-b border-slate-100">
          <div ref={dropdownRef} className="relative">
            <button onClick={() => setSearchOpen(o => !o)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-left hover:border-blue-300 transition-colors">
              <Building2 size={13} className="text-slate-400 flex-shrink-0" />
              <span className="flex-1 text-xs truncate text-slate-600 font-medium">{selected ? selected.customer_name : `Select ${singularLower}…`}</span>
            </button>
            {searchOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl border border-slate-200 shadow-xl z-30 overflow-hidden">
                <div className="p-2 border-b border-slate-100">
                  <input ref={searchRef} value={search} onChange={e => setSearch(e.target.value)} placeholder={`Search ${labelLower}…`}
                    className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 bg-slate-50" />
                </div>
                <p className="text-xs text-slate-300 mt-0.5 px-3 py-1">{scopeLabel} · {scopedCustomers.length} available</p>
                <div className="max-h-56 overflow-y-auto py-1">
                  {filtered.length > 0 ? filtered.slice(0, 40).map((c: any) => (
                    <button key={c.id} onClick={() => { setSelectedId(c.id); setSubTab('overview'); setSearchOpen(false); setSearch('') }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-slate-50 transition-colors ${c.id === selectedId ? 'bg-blue-50 text-blue-700' : 'text-slate-700'}`}>
                      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot[c.account_status] || 'bg-gray-400'}`} />
                      <span className="truncate font-medium">{c.customer_name}</span>
                    </button>
                  )) : <div className="px-3 py-4 text-xs text-slate-400 text-center">No results</div>}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-1.5 px-1.5">
          {scopedCustomers.slice(0, 60).map((c: any) => (
            <button key={c.id} onClick={() => { setSelectedId(c.id); setSubTab('overview') }}
              className={`w-full flex items-start gap-2 px-2.5 py-2.5 rounded-xl text-left transition-all ${c.id === selectedId ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-700 hover:bg-slate-50'}`}>
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1 ${c.id === selectedId ? 'bg-white/70' : (statusDot[c.account_status] || 'bg-gray-400')}`} />
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-semibold truncate ${c.id === selectedId ? 'text-white' : 'text-slate-800'}`}>{c.customer_name}</p>
                <p className={`text-xs truncate mt-0.5 ${c.id === selectedId ? 'text-blue-200' : 'text-slate-400'}`}>{c.billing_city || c.account_status}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
        {!selectedId ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center"><Building2 size={28} className="text-slate-300" /></div>
            <p className="text-sm font-semibold text-slate-400">Select a {singularLower} to view 360° intelligence</p>
          </div>
        ) : loading ? (
          <div className="flex-1 flex items-center justify-center"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>
        ) : err ? (
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">{err}</div>
        ) : (
          <>
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h3 className="text-base font-black text-slate-900">{cust.customer_name || selected?.customer_name}</h3>
                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                  {cust.account_status && <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${S_PILL[cust.account_status] || 'bg-gray-100 text-gray-500 border-gray-200'}`}>{cust.account_status}</span>}
                  {cust.account_potential && <span className={`text-xs font-bold px-2.5 py-1 rounded-full border ${S_PILL[cust.account_potential] || 'bg-gray-100 text-gray-500 border-gray-200'}`}>{cust.account_potential}</span>}
                  {cust.customer_vertical && <span className="text-xs text-slate-400">{cust.customer_vertical}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {(fc.critical ?? 0) > 0 && <span className="flex items-center gap-1 text-xs font-bold text-rose-600 bg-rose-50 border border-rose-200 px-2.5 py-1 rounded-full"><AlertCircle size={11} />{fc.critical} critical</span>}
                {(fc.warning  ?? 0) > 0 && <span className="flex items-center gap-1 text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full"><AlertTriangle size={11} />{fc.warning} warnings</span>}
                {ak.name && <span className="text-xs text-slate-400 bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-full">KAM: {ak.name}</span>}
              </div>
            </div>

            {/* Tab strip */}
            <div className="flex items-center gap-0.5 px-3 pt-2.5 border-b border-slate-100 overflow-x-auto">
              {displayC360Tabs.map(t => (
                <button key={t.id} onClick={() => setSubTab(t.id)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 whitespace-nowrap transition-all ${subTab === t.id ? 'border-blue-600 text-blue-700 bg-blue-50/50' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}>
                  {t.icon}{t.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto p-5">
              {subTab === 'overview'   && <Tab360Overview   data={data} />}
              {subTab === 'leads'      && <Tab360Leads      data={data} />}
              {subTab === 'tenders'    && <Tab360Tenders    data={data} />}
              {subTab === 'workorders' && <Tab360WorkOrders data={data} />}
              {subTab === 'payments'   && <Tab360Payments   data={data} />}
              {subTab === 'products'   && <Tab360Products   data={data} />}
              {subTab === 'activities' && <Tab360KAM        data={data} />}
              {subTab === 'emdbg'      && <Tab360EMDBG      data={data} />}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0, placement: 'top' as 'top' | 'bottom' })
  const ref = useRef<HTMLDivElement>(null)
  const updatePosition = () => {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    const placement = r.top > 44 ? 'top' : 'bottom'
    setPos({ top: placement === 'top' ? r.top - 8 : r.bottom + 8, left: Math.max(12, Math.min(r.left + r.width / 2, window.innerWidth - 12)), placement })
  }
  return (
    <div ref={ref} className="inline-flex" onMouseEnter={() => { updatePosition(); setShow(true) }} onMouseLeave={() => setShow(false)} onFocus={() => { updatePosition(); setShow(true) }} onBlur={() => setShow(false)}>
      {children}
      {show && createPortal(
        <div className="pointer-events-none fixed z-[9999] -translate-x-1/2" style={{ top: pos.top, left: pos.left, transform: pos.placement === 'top' ? 'translate(-50%, -100%)' : 'translateX(-50%)' }}>
          <div className="relative rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg whitespace-nowrap">
            {text}
            <div className={`absolute left-1/2 -translate-x-1/2 border-4 border-transparent ${pos.placement === 'top' ? 'top-full border-t-gray-900' : 'bottom-full border-b-gray-900'}`} />
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

function IconBtn({ tooltip, onClick, disabled, loading, children, color = 'gray' }: {
  tooltip: string; onClick?: () => void; disabled?: boolean; loading?: boolean
  children: React.ReactNode; color?: 'gray' | 'blue' | 'green' | 'red'
}) {
  const colors = { gray: 'text-gray-400 hover:text-gray-700 hover:bg-gray-100', blue: 'text-gray-400 hover:text-blue-600 hover:bg-blue-50', green: 'text-gray-400 hover:text-green-600 hover:bg-green-50', red: 'text-gray-400 hover:text-red-500 hover:bg-red-50' }
  return (
    <Tooltip text={tooltip}>
      <button type="button" onClick={onClick} disabled={disabled || loading} className={`p-1.5 rounded-lg transition-colors disabled:opacity-40 ${colors[color]}`}>
        {loading ? <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> : children}
      </button>
    </Tooltip>
  )
}

function ActionMenuItem({ icon, label, iconBg, iconColor, labelColor = 'text-gray-700', onClick, danger = false }: {
  icon: React.ReactNode; label: string; iconBg: string; iconColor: string
  labelColor?: string; onClick: () => void; danger?: boolean
}) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-xl text-xs font-medium transition-all ${danger ? 'hover:bg-red-50' : 'hover:bg-gray-50'}`}>
      <div className={`w-7 h-7 rounded-xl ${iconBg} flex items-center justify-center flex-shrink-0 ${iconColor}`}>{icon}</div>
      <span className={labelColor}>{label}</span>
    </button>
  )
}

function RowActions({ row, onEdit, onView, onView360, onStatusChange, onDelete, canEdit, canDelete }: {
  row: any; onEdit: (r: any) => void; onView: (r: any) => void; onView360: (id: number) => void
  onStatusChange: (id: number, s: string) => void; onDelete: (id: number, n: string) => void
  canEdit?: boolean; canDelete?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pos,  setPos]  = useState({ top: 0, left: 0 })
  const btnRef          = useRef<HTMLButtonElement>(null)
  const MENU_W = 210; const MENU_H = 220

  const reposition = () => {
    if (!btnRef.current) return
    const r    = btnRef.current.getBoundingClientRect()
    const top  = r.bottom + MENU_H > window.innerHeight ? r.top + window.scrollY - MENU_H - 4 : r.bottom + window.scrollY + 4
    const left = Math.max(8, Math.min(r.right + window.scrollX - MENU_W, window.innerWidth - MENU_W - 8))
    setPos({ top, left })
  }
  const toggle = (e: React.MouseEvent) => { e.stopPropagation(); if (!open) reposition(); setOpen(o => !o) }
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close) }
  }, [open])

  const statusDot: Record<string, string> = { Active: 'bg-emerald-500', Prospect: 'bg-blue-500', Inactive: 'bg-gray-400', Churned: 'bg-rose-400' }

  const menu = (
    <div onMouseDown={e => e.stopPropagation()}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: MENU_W, zIndex: 60 }}
      className="bg-white rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.15)] border border-gray-100 overflow-hidden">
      <div className="px-3 pt-3 pb-2.5 border-b border-gray-100">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
            {row.customer_name?.substring(0, 2)?.toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-gray-800 truncate">{row.customer_name}</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot[row.account_status] || 'bg-gray-400'}`} />
              <p className="text-xs text-gray-400 truncate">{row.account_status} · {row.account_potential}</p>
            </div>
          </div>
        </div>
      </div>
      <div className="p-1.5 space-y-0.5">
        <ActionMenuItem icon={<Eye size={14} />} label="View" iconBg="bg-blue-50" iconColor="text-blue-600" onClick={() => { onView(row); setOpen(false) }} />
        {canEdit !== false && <ActionMenuItem icon={<Pencil size={14} />} label="Edit" iconBg="bg-slate-50" iconColor="text-slate-600" onClick={() => { onEdit(row); setOpen(false) }} />}
      </div>
      {canDelete !== false && (
        <>
          <div className="mx-3 border-t border-gray-100" />
          <div className="p-1.5">
            <ActionMenuItem icon={<Trash2 size={14} />} label="Delete" iconBg="bg-red-50" iconColor="text-red-500" labelColor="text-red-600" onClick={() => { onDelete(row.id, row.customer_name); setOpen(false) }} danger />
          </div>
        </>
      )}
    </div>
  )

  return (
    <div onClick={e => e.stopPropagation()}>
      <button ref={btnRef} onClick={toggle}
        className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all ${open ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'}`}>
        <MoreVertical size={15} />
      </button>
      {open && createPortal(menu, document.body)}
    </div>
  )
}

// ─── DeleteModal ──────────────────────────────────────────────────────────────

function DeleteModal({ name, onConfirm, onCancel }: { name: string; onConfirm: () => void; onCancel: () => void }) {
  const { singular } = useModuleName('customers')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-rose-100 rounded-xl flex items-center justify-center flex-shrink-0">
            <AlertCircle size={20} className="text-rose-600" />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900">Delete {singular}</h3>
            <p className="text-xs text-gray-400 mt-0.5">This action cannot be undone</p>
          </div>
        </div>
        <p className="text-sm text-gray-500 mb-5 pl-[52px]">
          Deleting <strong className="text-gray-800">{name}</strong> will permanently remove all contacts, consignees, and zones.
        </p>
        <div className="flex gap-2.5 justify-end">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 font-medium">Cancel</button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm rounded-xl bg-rose-600 text-white hover:bg-rose-700 font-semibold">Delete</button>
        </div>
      </div>
    </div>
  )
}

// ─── ViewPanel ────────────────────────────────────────────────────────────────

function ViewPanel({ customer, onClose, onEdit }: { customer: any; onClose: () => void; onEdit: (c: any) => void }) {
  const { success, error: showError } = useToast()
  const { can } = usePermissions()
  const { singular } = useModuleName('customers')
  if (!customer) return null
  const allContacts   = customer.contacts ?? []
  const primary       = allContacts.find((c: any) => c.is_primary) ?? allContacts[0]
  const otherContacts = allContacts.filter((c: any) => c !== primary)

  const statusCfg: Record<string, { dot: string; badge: string }> = {
    Active:   { dot: 'bg-emerald-400', badge: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    Prospect: { dot: 'bg-blue-400',    badge: 'bg-blue-100 text-blue-700 border-blue-200' },
    Inactive: { dot: 'bg-gray-400',    badge: 'bg-gray-100 text-gray-600 border-gray-200' },
    Churned:  { dot: 'bg-rose-400',    badge: 'bg-rose-100 text-rose-700 border-rose-200' },
  }
  const potentialCfg: Record<string, string> = {
    High:   'bg-rose-100 text-rose-700 border-rose-200',
    Medium: 'bg-amber-100 text-amber-700 border-amber-200',
    Low:    'bg-slate-100 text-slate-600 border-slate-200',
  }
  const sc      = statusCfg[customer.account_status] ?? { dot: 'bg-gray-400', badge: 'bg-gray-100 text-gray-600 border-gray-200' }
  const initials = customer.customer_name?.split(' ').map((w: string) => w?.[0] ?? '').join('').substring(0, 2).toUpperCase() ?? '--'
  const addrParts = [customer.billing_address, customer.billing_area, customer.billing_city, customer.billing_state, customer.billing_pincode].filter(Boolean)
  const deliveryCount = (customer.billing_consignees?.length ?? 0) + (customer.billing_zones?.length ?? 0)

  const copyPhoneNumber = async (phone?: string | number | null) => {
    const cleanPhone = String(phone || '').replace(/[^\d+]/g, '')
    if (!cleanPhone) return
    const copied = await copyText(cleanPhone)
    copied ? success('Phone number copied') : showError('Unable to copy phone number')
  }

  const InfoCard = ({ label, value, icon, href, onClick, className = '', iconClassName = 'text-blue-500' }: {
    label: string; value?: string | number | null; icon?: React.ReactNode
    href?: string; onClick?: () => void; className?: string; iconClassName?: string
  }) => value ? (
    <div className={`rounded-lg border border-slate-100 bg-white px-3 py-2 shadow-[0_1px_2px_rgba(15,23,42,0.03)] ${className}`}>
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</span>
      <div className="mt-0.5 flex items-center gap-1.5">
        {icon && <span className={`flex-shrink-0 ${iconClassName}`}>{icon}</span>}
        {href ? (
          <a href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer"
            className="truncate text-sm font-semibold text-blue-600 underline-offset-2 hover:text-blue-700 hover:underline">{value}</a>
        ) : onClick ? (
          <button type="button" onClick={onClick} className="truncate text-left text-sm font-semibold text-blue-600 hover:text-blue-700">{value}</button>
        ) : (
          <span className="truncate text-sm font-semibold text-slate-900">{value}</span>
        )}
      </div>
    </div>
  ) : null

  const Section = ({ title, icon, children, iconClassName = 'text-blue-500' }: { title: string; icon?: React.ReactNode; children: React.ReactNode; iconClassName?: string }) => (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50/70 shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-white px-4 py-2.5">
        {icon && <span className={iconClassName}>{icon}</span>}
        <span className="text-sm font-bold text-slate-700">{title}</span>
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  )

  return (
    <SlidePanel open={!!customer} onClose={onClose}
      title={`${singular} Details`} subtitle={customer.customer_name || ''}
      insetLeft="var(--sidebar-w, 220px)" bodyClassName="!px-0 !py-0 bg-slate-50"
      headerClassName="bg-white border-slate-100"
      footer={
        <div className="flex items-center gap-3">
          <Button onClick={onClose}>Close</Button>
          {can('customers.update') && (
            <Button onClick={() => { onClose(); setTimeout(() => onEdit(customer), 100) }}>
              <Pencil size={14} className="mr-1.5 inline-block" /> Edit {singular}
            </Button>
          )}
        </div>
      }
    >
      <div className="border-b border-slate-100 bg-white px-6 py-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-lg font-extrabold text-white shadow-sm">{initials}</div>
          <div className="min-w-[220px] flex-1">
            <h2 className="text-lg font-black leading-tight text-slate-900">{customer.customer_name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {customer.account_status && (
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${sc.badge}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${sc.dot}`} />{customer.account_status}
                </span>
              )}
              {customer.account_potential && <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${potentialCfg[customer.account_potential] || 'bg-gray-100 text-gray-500 border-gray-200'}`}>{customer.account_potential}</span>}
              {customer.customer_vertical && <span className="text-xs font-medium text-slate-400">{customer.customer_vertical}</span>}
              {customer.group_name && <span className="text-xs font-medium text-slate-400">· {customer.group_name}</span>}
            </div>
          </div>
        </div>
      </div>
      <div className="space-y-3 px-5 py-4 overflow-y-auto">
        <Section title="Contact Information" icon={<PhoneCall size={15} />}>
          {primary ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-sm flex-shrink-0">{primary.contact_name?.charAt(0)?.toUpperCase()}</div>
                <div>
                  <p className="text-sm font-bold text-slate-800">{primary.contact_name}</p>
                  <p className="text-xs text-slate-400">{[primary.designation, primary.department].filter(Boolean).join(' · ')}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <InfoCard label="Mobile" value={primary.mobile} icon={<Phone size={12} />} onClick={() => copyPhoneNumber(primary.mobile)} />
                <InfoCard label="Office Phone" value={primary.office_phone} icon={<Phone size={12} />} onClick={() => copyPhoneNumber(primary.office_phone)} />
                <InfoCard label="Email" value={primary.office_email} icon={<Mail size={12} />} href={primary.office_email ? `mailto:${primary.office_email}` : undefined} className="col-span-2" />
              </div>
              {otherContacts.length > 0 && (
                <div className="mt-2 pt-2 border-t border-slate-100">
                  <p className="text-xs font-semibold text-slate-400 mb-2">Other Contacts ({otherContacts.length})</p>
                  {otherContacts.map((c: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 py-1.5">
                      <div className="w-6 h-6 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 text-xs font-bold flex-shrink-0">{c.contact_name?.charAt(0)?.toUpperCase()}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-slate-700 truncate">{c.contact_name}</p>
                        <p className="text-xs text-slate-400 truncate">{c.designation}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : <p className="text-xs text-slate-400">No contacts added</p>}
        </Section>

        <Section title="Business Address" icon={<MapPin size={15} />} iconClassName="text-slate-400">
          {addrParts.length > 0 ? (
            <p className="text-sm text-slate-700 leading-relaxed">{addrParts.join(', ')}</p>
          ) : <p className="text-xs text-slate-400">No address on record</p>}
          {deliveryCount > 0 && <p className="mt-1 text-xs text-slate-400">{deliveryCount} delivery location{deliveryCount !== 1 ? 's' : ''}</p>}
        </Section>

        <Section title="Account Details" icon={<Building2 size={15} />} iconClassName="text-slate-500">
          <div className="grid grid-cols-2 gap-2">
            <InfoCard label="Division" value={customer.division} />
            <InfoCard label="GST" value={customer.gst_number} />
            <InfoCard label="PAN" value={customer.pan_number} />
            {customer.website && <InfoCard label="Website" value={customer.website} href={customer.website?.startsWith('http') ? customer.website : `https://${customer.website}`} icon={<ExternalLink size={12} />} className="col-span-2" />}
            {customer.assigned_user_name && <InfoCard label="Assigned To" value={customer.assigned_user_name} icon={<User size={12} />} className="col-span-2" />}
            {customer.potential_value && <InfoCard label="Potential Value" value={`₹${Number(customer.potential_value).toLocaleString('en-IN')}`} icon={<IndianRupee size={12} />} className="col-span-2" />}
          </div>
        </Section>

        {customer.remarks && (
          <Section title="Remarks" icon={<FileText size={15} />} iconClassName="text-slate-400">
            <p className="text-sm text-slate-600 leading-relaxed">{customer.remarks}</p>
          </Section>
        )}
      </div>
    </SlidePanel>
  )
}

// ─── CustomerListPage (main) ──────────────────────────────────────────────────

type PageTab = 'list' | '360'

export default function CustomerListPage() {
  const navigate = useNavigate()
  const { label: moduleLabel, singular, singularLower, labelLower } = useModuleName('customers')
  const currentUser = useCurrentUser()
  const { can } = usePermissions()

  const [customers,       setCustomers]       = useState<any[]>([])
  const [teamMemberUsers, setTeamMemberUsers] = useState<{ value: number; label: string }[]>([])
  const [loading,         setLoading]         = useState(true)
  const [viewingCustomer, setViewingCustomer] = useState<any | null>(null)
  const [deleteTarget,    setDeleteTarget]    = useState<{ id: number; name: string } | null>(null)
  const [statusFilter,    setStatusFilter]    = useState<string>('')
  const [filterCreatedBy, setFilterCreatedBy] = useState<string>('')
  const [tableSearch,     setTableSearch]     = useState<string>('')
  const [allUsers,        setAllUsers]        = useState<{ value: number; label: string }[]>([])
  const [pageTab,         setPageTab]         = useState<PageTab>('list')
  const [c360TargetId,    setC360TargetId]    = useState<number | null>(null)
  const { success, error: showError }         = useToast()
  const { setSidebarCollapsed }               = useUIStore()
  const sidebarWasCollapsed                   = useRef<boolean>(false)

  // ── Data load ──────────────────────────────────────────────────────────────
  const load = async () => {
    setLoading(true)
    try   { const r = await api.get('/customers/'); setCustomers(r.data) }
    catch { showError(`Failed to load ${labelLower}`) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    load()
    api.post('/customers/mark-seen').catch(() => {})
    api.get('/masters/users-for-select').then((r: any) => {
      setAllUsers((r.data as any[]).filter((x: any) => x.label).map((x: any) => ({ value: x.id, label: x.label })))
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get('/customers/team-users')
      .then((res: any) => setTeamMemberUsers((res.data || []).map((u: any) => ({ value: Number(u.id), label: u.label || u.full_name || u.username }))))
      .catch(() => setTeamMemberUsers([]))
  }, [])

  // ── Navigation to form — sidebar managed entirely by CustomerFormPage ─────
  const openAdd  = () => navigate('/customers/new')
  const openEdit = (row: any) => navigate(`/customers/${row.id}/edit`, { state: { customer: row } })

  // ── ViewPanel open/close with sidebar toggle ───────────────────────────────
  const openView  = (row: any) => {
    sidebarWasCollapsed.current = useUIStore.getState().sidebarCollapsed
    setSidebarCollapsed(true)
    setViewingCustomer(row)
  }
  const closeView = () => {
    setViewingCustomer(null)
    setSidebarCollapsed(sidebarWasCollapsed.current)
  }

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleStatusChange = async (id: number, status: string) => {
    try   { await api.patch(`/customers/${id}/status?status=${status}`); success(`Marked as ${status}`); load() }
    catch { showError('Failed to update status') }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try   { await api.delete(`/customers/${deleteTarget.id}`); success(`${singular} deleted`); setDeleteTarget(null); load() }
    catch { showError(`Failed to delete ${singularLower}`) }
  }

  const handleView360 = (id: number) => { setC360TargetId(id); setPageTab('360') }

  // ── Role-scoped list ───────────────────────────────────────────────────────
  const roleFilteredCustomers = React.useMemo(() => {
    const role = currentUser.role
    const myId = Number(currentUser.id)
    if (!role || !myId) return customers
    if (CEO_ROLES.includes(role)) return customers
    const teamIds = teamMemberUsers.map(u => Number(u.value))
    const visibleUserIds = [myId, ...teamIds]
    return customers.filter(c => visibleUserIds.includes(Number(c.created_by)) || visibleUserIds.includes(Number(c.assigned_to)))
  }, [customers, currentUser, teamMemberUsers])

  const fmtCount = (value: number) => value.toLocaleString('en-IN')

  const creatorNames = React.useMemo(() => {
    if (CEO_ROLES.includes(currentUser.role)) {
      const fromApi     = allUsers.map(u => u.label)
      const fromRecords = customers.filter(c => c.assigned_user_name).map(c => c.assigned_user_name as string)
      return Array.from(new Set([...fromApi, ...fromRecords])).filter(Boolean).sort()
    }
    return Array.from(new Set(teamMemberUsers.map(u => u.label))).filter(Boolean).sort()
  }, [currentUser.role, allUsers, customers, teamMemberUsers])

  const filteredData = React.useMemo(() => {
    let list = statusFilter ? roleFilteredCustomers.filter(c => c.account_status === statusFilter) : roleFilteredCustomers
    if (filterCreatedBy) list = list.filter(c => c.assigned_user_name === filterCreatedBy)
    if (tableSearch.trim()) {
      const q = tableSearch.toLowerCase()
      list = list.filter(c =>
        (c.customer_name      ?? '').toLowerCase().includes(q) ||
        (c.billing_city       ?? '').toLowerCase().includes(q) ||
        (c.billing_state      ?? '').toLowerCase().includes(q) ||
        (c.gst_number         ?? '').toLowerCase().includes(q) ||
        (c.created_by_name    ?? '').toLowerCase().includes(q) ||
        (c.assigned_user_name ?? '').toLowerCase().includes(q)
      )
    }
    return list
  }, [roleFilteredCustomers, statusFilter, filterCreatedBy, tableSearch])

  // ── Columns ────────────────────────────────────────────────────────────────
  const columns: Column<any>[] = [
    {
      key: 'customer_name', header: singular, sortable: true, width: '23%', searchable: true, searchKeys: ['group_name', 'billing_city', 'billing_state', 'assigned_user_name', 'created_by_name'],
      render: (_: unknown, row: any) => {
        const isPending  = row.approval_status === 'pending'
        const isRejected = row.approval_status === 'rejected'
        return (
          <div className={`min-w-0 ${isPending || isRejected ? 'opacity-60' : ''}`}>
            <p className="truncate text-sm font-semibold leading-tight text-slate-900">{row.customer_name || '-'}</p>
            <p className="mt-1.5 truncate text-xs font-medium text-slate-400">{toTitleCase(row.group_name) || '-'}</p>
            {isPending  && <span className="mt-1 inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">{row.approval_display || 'Pending Approval'}</span>}
            {isRejected && <span className="mt-1 inline-flex rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-600">Rejected</span>}
          </div>
        )
      },
    },
    {
      key: 'customer_vertical', header: 'Segment', sortable: true, width: '16%', searchable: true, searchKeys: ['division'],
      render: (_: unknown, row: any) => {
        const primary = primaryContactOf(row)
        const secondary = [row.division, primary?.department].filter(Boolean).join('  ')
        return (
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-800">{row.customer_vertical || '-'}</p>
            <p className="mt-1.5 truncate text-xs font-medium text-slate-400">{secondary || '-'}</p>
          </div>
        )
      },
    },
    {
      key: 'billing_city', header: 'Location', sortable: true, width: '9%', searchable: true, searchKeys: ['billing_state'],
      render: (_: unknown, row: any) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-800">{row.billing_city || '-'}</p>
          <p className="mt-1.5 truncate text-xs font-medium text-slate-400">{row.billing_state || '-'}</p>
        </div>
      ),
    },
    {
      key: 'account_status', header: 'Status', sortable: true, width: '7%', align: 'center',
      render: (v: unknown) => {
        const status = String(v || '-')
        const colors: Record<string, string> = { Active: 'border-emerald-200 bg-emerald-50 text-emerald-700', Inactive: 'border-slate-200 bg-slate-100 text-slate-500', Prospect: 'border-blue-200 bg-blue-50 text-blue-700', Churned: 'border-rose-200 bg-rose-50 text-rose-600' }
        return <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-bold ${colors[status] || 'border-slate-200 bg-slate-100 text-slate-500'}`}>{status}</span>
      },
    },
    {
      key: 'account_potential', header: 'Potential', sortable: true, width: '8%',
      render: (v: unknown, row: any) => {
        const p = String(v || '')
        const badge: Record<string, string> = { High: 'bg-rose-50 text-rose-600', Medium: 'bg-amber-50 text-amber-600', Low: 'bg-slate-100 text-slate-500' }
        return (
          <div className="flex flex-col gap-0.5">
            {p ? <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold w-fit ${badge[p] || 'bg-slate-100 text-slate-500'}`}>{p}</span> : <span className="text-slate-300">—</span>}
            {row.potential_value ? <span className="pl-2 text-xs font-bold text-slate-800">{fmtTableCurrency(row.potential_value)}</span> : null}
          </div>
        )
      },
    },
    {
      key: 'assigned_user_name', header: 'Assigned To', sortable: true, width: '10%', searchable: true,
      render: (v: unknown, row: any) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-800">{String(v || '-')}</p>
          {row.team_name && <p className="mt-0.5 truncate text-xs text-slate-400">{row.team_name}</p>}
        </div>
      ),
    },
    {
      key: 'contacts', header: 'Contact', sortable: false, width: '14%', searchable: true,
      render: (_: unknown, row: any) => {
        const primary = primaryContactOf(row)
        const phone   = primary?.mobile || primary?.office_phone || ''
        const email   = primary?.office_email || ''
        const copyPhone = async (e: React.MouseEvent) => {
          e.stopPropagation()
          e.preventDefault()
          if (!phone) return
          const clean = phone.replace(/[^\d+]/g, '')
          try {
            if (navigator.clipboard && window.isSecureContext) {
              await navigator.clipboard.writeText(clean)
            } else {
              const ta = document.createElement('textarea')
              ta.value = clean; ta.style.cssText = 'position:fixed;left:-9999px'
              document.body.appendChild(ta); ta.select()
              document.execCommand('copy'); document.body.removeChild(ta)
            }
            success('Phone number copied')
          } catch {
            showError('Could not copy — try long-pressing the number')
          }
        }
        return (
          <div className="min-w-0" onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
            {primary
              ? <p className="truncate text-sm font-semibold text-slate-800">{toTitleCase(primary.contact_name)}</p>
              : <p className="text-xs text-slate-300">No contact</p>
            }
            <div className="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                disabled={!phone}
                onClick={copyPhone}
                title={phone ? `Copy ${phone}` : 'No phone number'}
                className={`flex h-6 w-6 items-center justify-center rounded-lg transition-all ${phone ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100 cursor-pointer' : 'cursor-not-allowed bg-slate-50 text-slate-300'}`}>
                <Phone size={12} />
              </button>
              {email ? (
                <a href={`mailto:${email}`} title={email} onClick={e => e.stopPropagation()}
                  className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-all">
                  <Mail size={12} />
                </a>
              ) : (
                <span title="No email" className="flex h-6 w-6 items-center justify-center rounded-lg bg-slate-50 text-slate-300 cursor-not-allowed">
                  <Mail size={12} />
                </span>
              )}
            </div>
          </div>
        )
      },
    },
    {
      key: 'last_activity_date', header: 'Last Activity', sortable: true, width: '8%',
      render: (_: unknown, row: any) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-800">{row.last_activity_type || '-'}</p>
          <p className="mt-1.5 truncate text-xs font-medium text-slate-400">{fmtTableDate(row.last_activity_date)}</p>
        </div>
      ),
    },
    {
      key: 'actions', header: 'Actions', width: '7%', searchable: false, align: 'center',
      render: (_: unknown, row: any) => (
        <div className="flex items-center justify-center gap-1">
          <Tooltip text="360° Intelligence">
            <button onClick={e => { e.stopPropagation(); handleView360(row.id) }}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-indigo-50 hover:text-indigo-600">
              <Sparkles size={13} />
            </button>
          </Tooltip>
          <RowActions row={row} onView={openView} onEdit={openEdit} onView360={handleView360}
            onStatusChange={handleStatusChange} onDelete={(id, name) => setDeleteTarget({ id, name })}
            canEdit={can('customers.update')} canDelete={can('customers.delete')} />
        </div>
      ),
    },
  ]

  const canFilterCreatedBy = Boolean(currentUser.role)
  const statusToolbar = (
    <div className="flex min-w-0 items-center gap-1.5 flex-wrap">
      {canFilterCreatedBy && creatorNames.length > 0 && (
        <select value={filterCreatedBy} onChange={e => setFilterCreatedBy(e.target.value)}
          className={`w-[180px] text-xs border rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 bg-white ${filterCreatedBy ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500'}`}>
          <option value="">Assigned To</option>
          {currentUser.full_name && creatorNames.includes(currentUser.full_name) && <option key="__you__" value={currentUser.full_name}>{currentUser.full_name} (You)</option>}
          {creatorNames.filter(n => n !== currentUser.full_name).map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      )}
      <div className="flex min-w-0 items-center gap-1 rounded-2xl border border-slate-200 bg-white/90 p-1 shadow-sm">
        {['', 'Active', 'Prospect', 'Inactive'].map(s => {
          const count = s ? roleFilteredCustomers.filter(c => c.account_status === s).length : roleFilteredCustomers.length
          return (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all whitespace-nowrap ${statusFilter === s ? 'bg-[#071d3a] text-white shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}>
              <span>{s || 'All Accounts'}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-xs font-bold ${statusFilter === s ? 'bg-white/15 text-white' : 'bg-slate-100 text-slate-500'}`}>{fmtCount(count)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-5">
      {deleteTarget    && <DeleteModal name={deleteTarget.name} onConfirm={handleDelete} onCancel={() => setDeleteTarget(null)} />}
      {viewingCustomer && <ViewPanel customer={viewingCustomer} onClose={closeView} onEdit={openEdit} />}

      <PageHeader
        title={moduleLabel}
        subtitle={`Manage ${labelLower} accounts, contacts, and addresses`}
        breadcrumb={[moduleLabel]}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={load} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
            {can('customers.create') && <Button onClick={openAdd}><Plus size={15} className="mr-1.5 inline-block" /> Add {singular}</Button>}
          </div>
        }
      />

      {/* Page tabs */}
      <div className="flex items-center gap-1 bg-slate-100 rounded-2xl p-1.5 w-fit">
        {([
          { id: 'list', label: moduleLabel,         count: roleFilteredCustomers.length, icon: <Building2 size={13} /> },
          { id: '360',  label: '360° Intelligence', count: null,                         icon: <Sparkles  size={13} /> },
        ] as { id: string; label: string; count: number | null; icon: React.ReactNode }[]).map(t => (
          <button key={t.id} onClick={() => setPageTab(t.id as PageTab)}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl transition-all whitespace-nowrap ${pageTab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {t.icon}{t.label}
            {t.count !== null && <span className="text-xs px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 font-bold leading-none">{t.count}</span>}
          </button>
        ))}
      </div>

      {pageTab === 'list' && (
        <DataTable
          columns={columns} data={filteredData} loading={loading} keyField="id"
          onRowClick={openView}
          showSearch searchValue={tableSearch} onSearchChange={setTableSearch}
          searchPlaceholder={`Search ${labelLower}…`}
          showExport showColumnToggle exportFilename={labelLower}
          emptyMessage={`No ${labelLower} found`}
          toolbar={statusToolbar} striped compact maxHeight="560px"
        />
      )}

      {pageTab === '360' && (
        <Intelligence360Tab customers={customers} initialCustomerId={c360TargetId} currentUser={currentUser} teamMemberUsers={teamMemberUsers} />
      )}
    </div>
  )
}
