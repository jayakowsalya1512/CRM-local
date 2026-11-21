/**
 * LoginTrackerTab.tsx — User Login Tracking & Analytics Dashboard
 *
 * Changes from previous version:
 *  - KPI cards: Total Employees / Today Logged In / Not Logged In Yet
 *  - Report view: two lists — Logged In Today (unique) + Not Logged In (with mail)
 *  - Multi-select + bulk send-mail for not-logged-in users
 *  - Removed admin login logs/data (CEO kept)
 *  - Removed Activity Trend + Department-wise charts; kept user-type chart + others
 *  - Role scoping: VP → multi-group employees; Manager → own group only
 */
import { useEffect, useState, useMemo, useCallback } from 'react'
import {
  Shield, Users, Clock, AlertTriangle, Activity, Monitor, Globe2,
  ChevronDown, ChevronUp, Download, Search, Filter, RefreshCw,
  LogIn, LogOut, Wifi, WifiOff, UserCheck, UserX, Calendar,
  BarChart3, Smartphone, Laptop, Settings2, Eye, Mail,
  CheckSquare, Square, Send, Phone, User as UserIcon, X,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
  AreaChart, Area, LineChart, Line, PieChart, Pie, Legend,
} from 'recharts'
import api from '@/services/api'
import {
  fmtN, fmtRsL, num, pct,
  ChartTip, Badge, KpiCard, DataTable, FilterBar,
  Section, TabSkeleton,
  EMPTY_FILTERS, FilterState, ColDef, AXIS_X, AXIS_Y, CGRID,
} from './_shared'

// ─── Palette ──────────────────────────────────────────────────────────────────
const C = {
  indigo: '#4f46e5', indigoLight: '#818cf8', indigoBg: '#eef2ff',
  emerald: '#059669', emeraldLight: '#34d399', emeraldBg: '#ecfdf5',
  amber: '#d97706', amberLight: '#fbbf24', amberBg: '#fffbeb',
  red: '#dc2626', redLight: '#f87171', redBg: '#fef2f2',
  sky: '#0284c7', skyLight: '#38bdf8', skyBg: '#f0f9ff',
  violet: '#7c3aed', violetLight: '#a78bfa', violetBg: '#f5f3ff',
  slate: '#475569', slateMuted: '#94a3b8', slateBg: '#f8fafc',
}

const PIE_COLORS = ['#4f46e5', '#7c3aed', '#0284c7', '#059669', '#d97706', '#dc2626', '#ec4899', '#14b8a6']

// ─── Card Primitives ──────────────────────────────────────────────────────────
function SCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05)] ${className}`}>
      {children}
    </div>
  )
}
function SCardHead({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between border-b border-slate-200/60 px-5 pt-4 pb-3">
      <div>
        <div className="text-[13px] font-semibold text-slate-900">{title}</div>
        {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
      </div>
      {right}
    </div>
  )
}

// ─── Mini KPI ─────────────────────────────────────────────────────────────────
function MiniKpi({ icon: Icon, label, value, sub, color, bgColor, onClick }: {
  icon: any; label: string; value: string | number; sub?: string; color: string; bgColor: string; onClick?: () => void
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border border-slate-100 bg-white px-4 py-3.5 shadow-sm transition-all ${
        onClick ? 'cursor-pointer hover:shadow-md hover:border-slate-200 hover:scale-[1.02]' : ''
      }`}
      onClick={onClick}
    >
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl" style={{ background: bgColor }}>
        <Icon size={18} style={{ color }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">{label}</div>
        <div className="text-[20px] font-bold tabular-nums" style={{ color }}>{value}</div>
        {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
      </div>
      {onClick && <Eye size={13} className="flex-shrink-0 text-slate-300" />}
    </div>
  )
}

// ─── Status Dot ───────────────────────────────────────────────────────────────
function StatusDot({ active }: { active: boolean }) {
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${active ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
  )
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmtDuration(minutes: number | null | undefined): string {
  const totalMinutes = Math.round(Number(minutes) || 0)
  if (totalMinutes <= 0) return '—'
  if (totalMinutes < 60) return `${totalMinutes}m`
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
  } catch { return '—' }
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return '—' }
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })
  } catch { return '—' }
}

function downloadCsv(filename: string, headers: string[], rows: any[][]) {
  const csv = [headers, ...rows]
    .map(row => row.map((cell: any) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ─── View Toggle ──────────────────────────────────────────────────────────────
type ViewMode = 'dashboard' | 'report'
type ReportTab = 'all' | 'logged_in' | 'not_logged_in' | 'failed'

// ─── Send Mail Modal ──────────────────────────────────────────────────────────
function SendMailModal({
  users,
  onClose,
  onSend,
}: {
  users: any[]
  onClose: () => void
  onSend: (subject: string, message: string, userIds: number[]) => Promise<void>
}) {
  const [subject, setSubject] = useState('Action Required: Please Log In to the CRM System Today')
  const [message, setMessage] = useState(
    `Dear {name},\n\nWe noticed that you have not logged in to the CRM system today. Please log in and update your activities at the earliest.\n\nThis is a reminder to ensure your daily tasks and follow-ups are recorded in the system.\n\nRegards,\nManagement`
  )
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSend = async () => {
    setSending(true)
    try {
      await onSend(subject, message, users.map((u) => u.id))
      setSent(true)
      setTimeout(onClose, 1500)
    } catch (e) {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Send Login Reminder</h3>
            <p className="text-xs text-slate-500">{users.length} user(s) selected</p>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100">Close</button>
        </div>

        {/* Recipients */}
        <div className="max-h-[120px] overflow-y-auto border-b divide-y divide-slate-100">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-3 px-5 py-2">
              <div className="h-6 w-6 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 text-[10px] font-bold flex-shrink-0">
                {(u.name || u.user_name || '?').charAt(0).toUpperCase()}
              </div>
              <span className="text-xs font-medium text-slate-700">{u.name || u.user_name}</span>
              {u.email && <span className="text-[11px] text-slate-400">· {u.email}</span>}
              {u.phone && <span className="text-[11px] text-slate-400">· {u.phone}</span>}
            </div>
          ))}
        </div>

        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500 mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-[0.1em] text-slate-500 mb-1">Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={6}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200 resize-none"
            />
            <div className="text-[10px] text-slate-400 mt-1">{'{name}'} will be replaced with the user's name</div>
          </div>
        </div>

        <div className="border-t px-5 py-3 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-xs font-medium text-slate-600 rounded-lg hover:bg-slate-100">Cancel</button>
          <button
            onClick={handleSend}
            disabled={sending || sent}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60"
          >
            {sent ? <><CheckSquare size={13} /> Sent!</> : sending ? 'Sending...' : <><Send size={13} /> Send Reminder</>}
          </button>
        </div>
      </div>
    </div>
  )
}




// ─── Main Component ───────────────────────────────────────────────────────────
export default function LoginTrackerTab() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<any>(null)
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [pendingFilters, setPendingFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [viewMode, setViewMode] = useState<ViewMode>('dashboard')
  const [reportTab, setReportTab] = useState<ReportTab>('logged_in')
  const [searchQuery, setSearchQuery] = useState('')
  const [activeChart, setActiveChart] = useState<'hourly' | 'weekday'>('hourly')
  const [selectedRole, setSelectedRole] = useState<any>(null)
  const [selectedNotLoggedIn, setSelectedNotLoggedIn] = useState<Set<number>>(new Set())
  const [showMailModal, setShowMailModal] = useState(false)
  const [mailTargetUsers, setMailTargetUsers] = useState<any[]>([])
  const [mailSuccess, setMailSuccess] = useState<string | null>(null)

  // ── Fetch ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true)
    const p: Record<string, string> = {}
    if (filters.date_from)   p.date_from   = filters.date_from
    if (filters.date_to)     p.date_to     = filters.date_to
    if (filters.assigned_to) p.assigned_to = filters.assigned_to
    if (filters.group)       p.group       = filters.group

    api.get('/dashboard/tab/login_tracker', { params: p })
      .then(r => setData(r.data || {}))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [filters])

  const handleChange = (k: keyof FilterState, v: string) => setPendingFilters(p => ({ ...p, [k]: v }))
  const handleApply  = () => setFilters(pendingFilters)
  const handleReset  = () => { setFilters(EMPTY_FILTERS); setPendingFilters(EMPTY_FILTERS) }
  const openReportTable = useCallback((tab: ReportTab) => {
  setViewMode('report')
  setReportTab(tab)
  setSearchQuery('')
  setSelectedNotLoggedIn(new Set())
}, [])

  // ── Derived ────────────────────────────────────────────────────────────────
  const s = data?.summary || {}
  const charts = data?.charts || {}
  const dailyLog = data?.daily_log || []
  const loggedInTodayFromBackend: any[] = data?.logged_in_today || []
  const activeSessions = data?.active_sessions || []
  const sessionTable = data?.session_table || []
  const topLists = data?.top_lists || {}
  const alerts = data?.alerts || []
  const filterOpts = data?.filters || {}
  const notLoggedIn: any[] = data?.not_logged_in || []

  // ── Unique logged-in today (from daily_log, date = today) ──────────────────
  const today = new Date().toISOString().slice(0, 10)
  const loggedInToday = useMemo(() => {
  const rows = Array.isArray(loggedInTodayFromBackend) && loggedInTodayFromBackend.length > 0
    ? loggedInTodayFromBackend
    : dailyLog

  const seen = new Set<number>()

  return rows.filter((r: any) => {
    const uid = Number(r.user_id)
    if (!uid) return false
    if (seen.has(uid)) return false
    seen.add(uid)
    return true
  })
}, [loggedInTodayFromBackend, dailyLog])

  // ── Filter not-logged-in list ───────────────────────────────────────────────
  const filteredNotLoggedIn = useMemo(() => {
    let rows = [...notLoggedIn]
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      rows = rows.filter((r: any) =>
        (r.name || '').toLowerCase().includes(q) ||
        (r.username || '').toLowerCase().includes(q) ||
        (r.role || '').toLowerCase().includes(q) ||
        (r.group || '').toLowerCase().includes(q) ||
        (r.region || '').toLowerCase().includes(q) ||
        (r.employee_code || '').toLowerCase().includes(q) ||
        (r.phone || '').includes(q)
      )
    }
    return rows
  }, [notLoggedIn, searchQuery])

  // ── Filter logged-in report ─────────────────────────────────────────────────
  const filteredLoggedIn = useMemo(() => {
    let rows = [...loggedInToday]
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      rows = rows.filter((r: any) =>
        (r.user_name || '').toLowerCase().includes(q) ||
        (r.username || '').toLowerCase().includes(q) ||
        (r.role || '').toLowerCase().includes(q) ||
        (r.group || '').toLowerCase().includes(q) ||
        (r.region || '').toLowerCase().includes(q)
      )
    }
    return rows
  }, [loggedInToday, searchQuery])

  const allEmployeeRows = useMemo(() => {
  const loggedInSet = new Set(loggedInToday.map((u: any) => u.user_id))

  const loggedRows = loggedInToday.map((u: any) => ({
    id: u.user_id,
    name: u.user_name,
    username: u.username,
    role: u.role,
    region: u.region,
    group: u.group,
    branch: u.branch,
    status: 'Logged In',
    first_login: u.first_login,
    last_logout: u.last_logout,
    duration_minutes: u.duration_minutes,
    session_count: u.session_count,
  }))

  const notRows = notLoggedIn
    .filter((u: any) => !loggedInSet.has(u.id))
    .map((u: any) => ({
      id: u.id,
      name: u.name || u.user_name,
      username: u.username,
      role: u.role,
      region: u.region,
      group: u.group,
      branch: u.branch,
      phone: u.phone,
      employee_code: u.employee_code,
      status: 'Not Logged In',
      last_login: u.last_login,
    }))

  return [...loggedRows, ...notRows]
}, [loggedInToday, notLoggedIn])

const failedLoginRows = useMemo(() => {
  return (topLists.most_failed || []).map((u: any, index: number) => ({
    id: u.id || u.user_id || u.raw_username || index,
    name: u.name || u.user_name || u.username,
    username: u.raw_username || u.username,
    role: u.role || '—',
    attempts: u.attempts || 0,
    status: 'Failed',
  }))
}, [topLists])

const filteredAllEmployees = useMemo(() => {
  let rows = [...allEmployeeRows]
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase()
    rows = rows.filter((r: any) =>
      (r.name || '').toLowerCase().includes(q) ||
      (r.username || '').toLowerCase().includes(q) ||
      (r.role || '').toLowerCase().includes(q) ||
      (r.group || '').toLowerCase().includes(q) ||
      (r.region || '').toLowerCase().includes(q) ||
      (r.employee_code || '').toLowerCase().includes(q) ||
      (r.phone || '').includes(q)
    )
  }
  return rows
}, [allEmployeeRows, searchQuery])

const filteredFailedLogins = useMemo(() => {
  let rows = [...failedLoginRows]
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase()
    rows = rows.filter((r: any) =>
      (r.name || '').toLowerCase().includes(q) ||
      (r.username || '').toLowerCase().includes(q) ||
      (r.role || '').toLowerCase().includes(q)
    )
  }
  return rows
}, [failedLoginRows, searchQuery])


  // ── Selection helpers ───────────────────────────────────────────────────────
  const toggleSelectUser = (userId: number) => {
    setSelectedNotLoggedIn(prev => {
      const next = new Set(prev)
      next.has(userId) ? next.delete(userId) : next.add(userId)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedNotLoggedIn.size === filteredNotLoggedIn.length && filteredNotLoggedIn.length > 0) {
      setSelectedNotLoggedIn(new Set())
    } else {
      setSelectedNotLoggedIn(new Set(filteredNotLoggedIn.map((u: any) => u.id)))
    }
  }

  const openMailForSelected = () => {
    const targets = filteredNotLoggedIn.filter((u: any) => selectedNotLoggedIn.has(u.id))
    setMailTargetUsers(targets)
    setShowMailModal(true)
  }

  const openMailForOne = (user: any) => {
    setMailTargetUsers([user])
    setShowMailModal(true)
  }

  // ── Send Mail Handler ───────────────────────────────────────────────────────
  const handleSendMail = useCallback(async (subject: string, message: string, userIds: number[]) => {
    await api.post('/dashboard/send-login-reminder', { user_ids: userIds, subject, message })
    setShowMailModal(false)
    setSelectedNotLoggedIn(new Set())
    setMailSuccess(`Reminder sent to ${userIds.length} user(s)`)
    setTimeout(() => setMailSuccess(null), 4000)
  }, [])

  // ── CSV Export ──────────────────────────────────────────────────────────────
  const handleExportLoggedIn = useCallback(() => {
    const headers = ['User', 'Username', 'Role', 'Region', 'Group', 'Branch', 'First Login', 'Last Logout', 'Duration (min)', 'Sessions']
    const rows = filteredLoggedIn.map((r: any) => [
      r.user_name, r.username, r.role, r.region, r.group, r.branch,
      r.first_login ? new Date(r.first_login).toLocaleString() : '',
      r.last_logout ? new Date(r.last_logout).toLocaleString() : '',
      r.duration_minutes ?? '', r.session_count,
    ])
    downloadCsv(`logged_in_today_${today}.csv`, headers, rows)
  }, [filteredLoggedIn, today])

  const handleExportNotLoggedIn = useCallback(() => {
    const headers = ['Name', 'Username', 'Role', 'Region', 'Group', 'Branch', 'Phone', 'Employee Code', 'Last Login']
    const rows = filteredNotLoggedIn.map((r: any) => [
      r.name, r.username, r.role, r.region, r.group, r.branch, r.phone || '', r.employee_code || '',
      r.last_login ? new Date(r.last_login).toLocaleString() : 'Never',
    ])
    downloadCsv(`not_logged_in_${today}.csv`, headers, rows)
  }, [filteredNotLoggedIn, today])

  const handleExportAllEmployees = useCallback(() => {
    const headers = ['Name', 'Username', 'Role', 'Group', 'Region', 'Branch', 'Status', 'Login / Last Login']
    const rows = filteredAllEmployees.map((r: any) => [
      r.name, r.username, r.role, r.group, r.region, r.branch, r.status,
      r.status === 'Logged In'
        ? (r.first_login ? new Date(r.first_login).toLocaleString() : '')
        : (r.last_login ? new Date(r.last_login).toLocaleString() : 'Never'),
    ])
    downloadCsv(`all_employees_login_status_${today}.csv`, headers, rows)
  }, [filteredAllEmployees, today])

  const handleExportFailedLogins = useCallback(() => {
    const headers = ['User', 'Username', 'Role', 'Attempts', 'Status']
    const rows = filteredFailedLogins.map((r: any) => [
      r.name, r.username, r.role, r.attempts || 0, r.status,
    ])
    downloadCsv(`failed_logins_${today}.csv`, headers, rows)
  }, [filteredFailedLogins, today])

  const handleExportReport = useCallback(() => {
    if (reportTab === 'all') {
      handleExportAllEmployees()
      return
    }
    if (reportTab === 'failed') {
      handleExportFailedLogins()
      return
    }
    if (reportTab === 'logged_in') {
      handleExportLoggedIn()
      return
    }
    handleExportNotLoggedIn()
  }, [
    handleExportAllEmployees,
    handleExportFailedLogins,
    handleExportLoggedIn,
    handleExportNotLoggedIn,
    reportTab,
  ])

  if (loading) return <TabSkeleton />

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 p-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between rounded-2xl border border-[#e6eaf1] bg-gradient-to-b from-white to-slate-50/40 px-5 py-4 shadow-sm">
        <div className="flex flex-1 items-center gap-3">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm text-indigo-600">
            <Shield size={18} />
          </div>
          <div className="flex flex-1 items-center justify-between gap-8">
            <div className="min-w-0">
              <h1 className="text-[16px] font-bold text-slate-900 m-0">Login Tracker</h1>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {fmtN(s.total_users || 0)} employees in scope
              </div>
            </div>
            {/* ── New KPI Bar ── */}
            <div className="flex min-w-[600px] items-center justify-between rounded-xl border border-slate-100 bg-white/70 px-5 py-2.5">
              <button onClick={() => openReportTable('all')} className="group text-center px-3 rounded-lg py-1 hover:bg-slate-50 transition-colors cursor-pointer">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.16em]">Total Employees</div>
                <div className="text-[22px] font-bold text-slate-700 group-hover:text-indigo-700 transition-colors">{fmtN(allEmployeeRows.length || s.total_users || 0)}</div>
              </button>
              <div className="w-px h-8 bg-slate-200" />
              <button onClick={() => openReportTable('logged_in')} className="group text-center px-3 rounded-lg py-1 hover:bg-emerald-50 transition-colors cursor-pointer">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.16em]">Logged In Today</div>
                <div className="text-[22px] font-bold text-emerald-600 group-hover:text-emerald-700 transition-colors">{fmtN(loggedInToday.length || s.unique_users_today || 0)}</div>
              </button>
              <div className="w-px h-8 bg-slate-200" />
              <button onClick={() => openReportTable('not_logged_in')} className="group text-center px-3 rounded-lg py-1 hover:bg-red-50 transition-colors cursor-pointer">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.16em]">Not Logged In</div>
                <div className={`text-[22px] font-bold transition-colors ${(s.not_logged_in_today || 0) > 0 ? 'text-red-600 group-hover:text-red-700' : 'text-slate-400'}`}>
                  {fmtN(notLoggedIn.length || s.not_logged_in_today || 0)}
                </div>
              </button>
              <div className="w-px h-8 bg-slate-200" />
              <button onClick={() => openReportTable('failed')} className="group text-center px-3 rounded-lg py-1 hover:bg-amber-50 transition-colors cursor-pointer">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.16em]">Failed Today</div>
                <div className={`text-[22px] font-bold transition-colors ${(s.failed_today || 0) > 0 ? 'text-amber-600 group-hover:text-amber-700' : 'text-slate-400'}`}>
                  {fmtN(s.failed_today || 0)}
                </div>
              </button>
            </div>
          </div>
        </div>

        {/* View toggle */}
        <div className="ml-4 flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-1">
          <button
            onClick={() => setViewMode('dashboard')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
              viewMode === 'dashboard' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <BarChart3 size={13} /> Dashboard
          </button>
          <button
            onClick={() => setViewMode('report')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
              viewMode === 'report' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Calendar size={13} /> Report
          </button>
        </div>
      </div>

      {/* ── Filters ────────────────────────────────────────────────────────── */}
      <FilterBar
        filters={pendingFilters}
        onChange={handleChange}
        onApply={handleApply}
        onReset={handleReset}
        filterOptions={filterOpts}
        loading={loading}
      />

      {/* Mail success toast */}
      {mailSuccess && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckSquare size={15} className="text-emerald-600" />
          {mailSuccess}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          DASHBOARD VIEW
         ═══════════════════════════════════════════════════════════════════════ */}
      {viewMode === 'dashboard' && (
        <>
          {/* ── KPI Row ──────────────────────────────────────────────────────── */}
          {/* <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <MiniKpi icon={Users}         label="Total Employees"   value={fmtN(s.total_users || 0)}          color={C.slate}   bgColor={C.slateBg}   onClick={() => openCardPopup('total')} />
            <MiniKpi icon={UserCheck}     label="Logged In Today"   value={fmtN(s.unique_users_today || 0)}   color={C.emerald} bgColor={C.emeraldBg} onClick={() => openCardPopup('logged_in')} />
            <MiniKpi icon={UserX}         label="Not Logged In Yet" value={fmtN(s.not_logged_in_today || 0)}  color={C.red}     bgColor={C.redBg}     onClick={() => openCardPopup('not_logged_in')} />
            <MiniKpi icon={AlertTriangle} label="Failed Today"      value={fmtN(s.failed_today || 0)}         color={C.amber}   bgColor={C.amberBg}   onClick={() => openCardPopup('failed')} />
          </div> */}

          {/* ── Alerts ────────────────────────────────────────────────────────── */}
          {alerts.length > 0 && (
            <SCard>
              <SCardHead title="Security Alerts" sub={`${alerts.length} alert(s) detected`} />
              <div className="divide-y divide-slate-100">
                {alerts.map((a: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50/60 transition-colors">
                    <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${
                      a.severity === 'high' ? 'bg-red-100 text-red-600'
                      : a.severity === 'medium' ? 'bg-amber-100 text-amber-600'
                      : 'bg-slate-100 text-slate-500'
                    }`}>
                      <AlertTriangle size={14} />
                    </div>
                    <span className="flex-1 text-[12px] text-slate-700">{a.message}</span>
                    <span className={`text-[9.5px] font-bold px-2 py-0.5 rounded-full ${
                      a.severity === 'high' ? 'bg-red-100 text-red-700'
                      : a.severity === 'medium' ? 'bg-amber-100 text-amber-700'
                      : 'bg-slate-100 text-slate-500'
                    }`}>
                      {a.severity}
                    </span>
                  </div>
                ))}
              </div>
            </SCard>
          )}

          {/* ── Charts Row 1: Hourly/Weekday + Active Sessions ────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <SCard className="lg:col-span-2">
              <div className="flex items-center justify-between border-b border-slate-200/60 px-5 pt-4 pb-3">
                <div>
                  <div className="text-[13px] font-semibold text-slate-900">Login Activity</div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {activeChart === 'hourly' ? 'Logins by hour of day' : 'Unique employees by weekday'}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {(['hourly', 'weekday'] as const).map(mode => (
                    <button key={mode} onClick={() => setActiveChart(mode)}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                        activeChart === mode ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-100'
                      }`}>
                      {mode === 'hourly' ? 'Hourly' : 'Weekday'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="px-2 pb-3 pt-2">
                <ResponsiveContainer width="100%" height={260}>
                  {activeChart === 'hourly' ? (
                    <BarChart data={charts.hourly_distribution || []} margin={{ top: 10, right: 20, left: 0, bottom: 6 }}>
                      <CartesianGrid {...CGRID} />
                      <XAxis dataKey="label" {...AXIS_X} interval={2} />
                      <YAxis {...AXIS_Y} />
                      <Tooltip content={<ChartTip />} />
                      <Bar dataKey="count" name="Logins" radius={[4, 4, 0, 0]}>
                        {(charts.hourly_distribution || []).map((d: any, i: number) => (
                          <Cell key={i} fill={d.count > 10 ? C.indigo : d.count > 5 ? C.indigoLight : '#c7d2fe'} />
                        ))}
                      </Bar>
                    </BarChart>
                  ) : (
                    <BarChart data={charts.by_weekday || []} margin={{ top: 10, right: 20, left: 0, bottom: 6 }}>
                      <CartesianGrid {...CGRID} />
                      <XAxis dataKey="name" {...AXIS_X} />
                      <YAxis {...AXIS_Y} />
                      <Tooltip content={<ChartTip />} />
                      <Bar dataKey="value" name="Logins" radius={[4, 4, 0, 0]} fill={C.violet} />
                    </BarChart>
                  )}
                </ResponsiveContainer>
              </div>
            </SCard>

            {/* Active Sessions Panel */}
            <SCard>
              <SCardHead title="Active Sessions" sub={`${activeSessions.length} user(s) online now`} />
              <div className="max-h-[280px] overflow-y-auto divide-y divide-slate-100">
                {activeSessions.length === 0 ? (
                  <div className="flex items-center justify-center py-10 text-sm text-slate-400">
                    <WifiOff size={16} className="mr-2" /> No active sessions
                  </div>
                ) : activeSessions.map((s: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <StatusDot active={true} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-semibold text-slate-800 truncate">{s.user_name}</div>
                      <div className="text-[10px] text-slate-400 flex items-center gap-1.5 flex-wrap">
                        <span>{s.role}</span>
                        {s.region && <><span>·</span><span>{s.region}</span></>}
                        {s.group && <><span>·</span><span>{s.group}</span></>}
                      </div>
                    </div>
                    <div className="flex-shrink-0 text-right">
                      <div className="text-[10px] text-slate-400">{s.browser}</div>
                      <div className="text-[10px] text-slate-400">{s.ip_address}</div>
                    </div>
                  </div>
                ))}
              </div>
            </SCard>
          </div>

          {/* ── Charts Row 2: User Type + Browsers ───────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* By Role / User Type */}
            <SCard className="lg:col-span-2">
              <SCardHead title="Users by Role / Type" sub="Click a count to view users" />
              <div className="px-4 pb-4 pt-3 space-y-2">
                {(charts.by_role_users || []).length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-6">No role data</p>
                ) : (charts.by_role_users || []).map((d: any, i: number) => {
                  const maxV = charts.by_role_users[0]?.value || 1
                  return (
                    <button
                      key={d.name}
                      onClick={() => setSelectedRole(d)}
                      className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-xs transition hover:bg-slate-50"
                    >
                      <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span className="flex-1 font-medium text-slate-700 truncate text-left capitalize">{d.name}</span>
                      <div className="w-24 h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(d.value / maxV) * 100}%`, background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      </div>
                      <span className="w-10 text-right font-bold text-indigo-600">{d.value}</span>
                    </button>
                  )
                })}
              </div>
            </SCard>

            {/* By Browser / OS */}
            <SCard>
              <SCardHead title="Devices & Browsers" sub="Session distribution by platform" />
              <div className="px-4 pb-4 pt-3">
                {(charts.by_browser || []).length > 0 && (
                  <div className="mb-3">
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400 mb-1.5">Browsers</div>
                    <div className="space-y-1.5">
                      {(charts.by_browser || []).map((d: any, i: number) => {
                        const maxV = charts.by_browser[0]?.value || 1
                        return (
                          <div key={d.name} className="flex items-center gap-2 text-xs">
                            <Monitor size={11} className="text-slate-400 flex-shrink-0" />
                            <span className="flex-1 text-slate-700 truncate">{d.name}</span>
                            <div className="w-12 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                              <div className="h-full rounded-full bg-indigo-400" style={{ width: `${(d.value / maxV) * 100}%` }} />
                            </div>
                            <span className="w-6 text-right font-medium text-slate-600">{d.value}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                {(charts.by_os || []).length > 0 && (
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400 mb-1.5 mt-3">Operating Systems</div>
                    <div className="space-y-1.5">
                      {(charts.by_os || []).map((d: any, i: number) => {
                        const maxV = charts.by_os[0]?.value || 1
                        return (
                          <div key={d.name} className="flex items-center gap-2 text-xs">
                            <Laptop size={11} className="text-slate-400 flex-shrink-0" />
                            <span className="flex-1 text-slate-700 truncate">{d.name}</span>
                            <div className="w-12 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                              <div className="h-full rounded-full bg-violet-400" style={{ width: `${(d.value / maxV) * 100}%` }} />
                            </div>
                            <span className="w-6 text-right font-medium text-slate-600">{d.value}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </SCard>
          </div>

          {/* ── Top Lists ─────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Most Active Users */}
            <SCard>
              <SCardHead title="Most Active Users" sub="By login count in selected period" />
              <div className="divide-y divide-slate-100">
                {(topLists.most_active || []).length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-8">No data</p>
                ) : (topLists.most_active || []).map((r: any, i: number) => {
                  const maxC = topLists.most_active[0]?.login_count || 1
                  return (
                    <div key={r.user_id} className="flex items-center gap-3 px-4 py-2.5">
                      <span className={`flex-shrink-0 w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center ${
                        i < 3 ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <span className="text-[12px] font-semibold text-slate-800 truncate">{r.name}</span>
                        <div className="text-[10px] text-slate-400">{r.role} {r.group ? `· ${r.group}` : ''}</div>
                      </div>
                      <div className="w-16 h-1.5 rounded-full bg-slate-100 overflow-hidden flex-shrink-0">
                        <div className="h-full rounded-full bg-indigo-500" style={{ width: `${(r.login_count / maxC) * 100}%` }} />
                      </div>
                      <span className="text-[12px] font-bold text-indigo-700 tabular-nums w-8 text-right">{r.login_count}</span>
                    </div>
                  )
                })}
              </div>
            </SCard>

            {/* Failed Attempts */}
            <SCard>
              <SCardHead title="Failed Login Attempts" sub="Users with most failures in period" />
              <div className="divide-y divide-slate-100">
                {(topLists.most_failed || []).length === 0 ? (
                  <div className="flex items-center justify-center py-8 text-sm text-slate-400">
                    <Shield size={16} className="mr-2 text-emerald-500" /> No failed attempts
                  </div>
                ) : (topLists.most_failed || []).map((r: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <div className={`flex-shrink-0 w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center ${
                      r.attempts >= 5 ? 'bg-red-600 text-white' : 'bg-amber-100 text-amber-700'
                    }`}>
                      <AlertTriangle size={12} />
                    </div>
                    <span className="flex-1 text-[12px] font-medium text-slate-800 truncate">{r.username}</span>
                    <span className={`text-[12px] font-bold tabular-nums ${r.attempts >= 5 ? 'text-red-600' : 'text-amber-600'}`}>
                      {r.attempts} attempt{r.attempts !== 1 ? 's' : ''}
                    </span>
                  </div>
                ))}
              </div>
            </SCard>
          </div>

          {/* ── Session History Table ──────────────────────────────────────────── */}
          <Section idx="05" title="Session History" />
          <SCard>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1200px] table-fixed text-[12px]">
                <colgroup>
                  <col className="w-[14%]" />
                  <col className="w-[7%]" />
                  <col className="w-[9%]" />
                  <col className="w-[9%]" />
                  <col className="w-[11%]" />
                  <col className="w-[11%]" />
                  <col className="w-[7%]" />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                  <col className="w-[6%]" />
                  <col className="w-[6%]" />
                </colgroup>
                <thead>
                  <tr className="bg-slate-50/80 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
                    <th className="border-b border-slate-200 px-3 py-2.5 text-left">User</th>
                    <th className="border-b border-slate-200 px-3 py-2.5 text-left">Role</th>
                    <th className="border-b border-slate-200 px-3 py-2.5 text-left">Region</th>
                    <th className="border-b border-slate-200 px-3 py-2.5 text-left">Group</th>
                    <th className="border-b border-slate-200 px-3 py-2.5 text-center">Login Time</th>
                    <th className="border-b border-slate-200 px-3 py-2.5 text-center">Logout Time</th>
                    <th className="border-b border-slate-200 px-3 py-2.5 text-center">Duration</th>
                    <th className="border-b border-slate-200 px-3 py-2.5 text-left">Device</th>
                    <th className="border-b border-slate-200 px-3 py-2.5 text-left">IP</th>
                    <th className="border-b border-slate-200 px-3 py-2.5 text-center">Browser</th>
                    <th className="border-b border-slate-200 px-3 py-2.5 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionTable.length === 0 ? (
                    <tr><td colSpan={11} className="px-4 py-10 text-center text-sm text-slate-400">No sessions found</td></tr>
                  ) : sessionTable.slice(0, 100).map((r: any, i: number) => (
                    <tr key={r.id || i} className={`border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? '' : 'bg-slate-50/30'}`}>
                      <td className="px-3 py-2 font-medium text-slate-800 truncate" title={r.user_name}>{r.user_name}</td>
                      <td className="px-3 py-2 text-slate-600">{r.role}</td>
                      <td className="px-3 py-2 text-slate-600 truncate">{r.region || '—'}</td>
                      <td className="px-3 py-2 text-slate-600 truncate">{r.group || '—'}</td>
                      <td className="px-3 py-2 text-center tabular-nums text-slate-700">{fmtDateTime(r.login_time)}</td>
                      <td className="px-3 py-2 text-center tabular-nums text-slate-500">{fmtDateTime(r.logout_time)}</td>
                      <td className="px-3 py-2 text-center tabular-nums text-violet-700 font-medium">{fmtDuration(r.duration_minutes)}</td>
                      <td className="px-3 py-2 text-slate-500 truncate text-[11px]" title={r.device}>{r.device || '—'}</td>
                      <td className="px-3 py-2 text-slate-400 tabular-nums text-[11px]">{r.ip_address || '—'}</td>
                      <td className="px-3 py-2 text-center text-slate-500 text-[11px]">{r.browser || '—'}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          r.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                        }`}>
                          <StatusDot active={r.is_active} />
                          {r.is_active ? 'Active' : 'Ended'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SCard>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          REPORT VIEW — Logged In Today + Not Logged In
         ═══════════════════════════════════════════════════════════════════════ */}
      {viewMode === 'report' && (
        <>
          {/* Report toolbar */}
          <div className="flex items-center gap-3 flex-wrap">
            {/* Tab toggle */}
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
              <button
  onClick={() => { setReportTab('all'); setSearchQuery(''); setSelectedNotLoggedIn(new Set()) }}
  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
    reportTab === 'all' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
  }`}
>
  <Users size={12} />
  All Employees
  <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
    reportTab === 'all' ? 'bg-indigo-700 text-white' : 'bg-slate-200 text-slate-600'
  }`}>
    {fmtN(allEmployeeRows.length)}
  </span>
</button>
              <button
                onClick={() => { setReportTab('logged_in'); setSearchQuery(''); setSelectedNotLoggedIn(new Set()) }}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                  reportTab === 'logged_in' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <UserCheck size={12} />
                Logged In Today
                <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  reportTab === 'logged_in' ? 'bg-emerald-700 text-white' : 'bg-slate-200 text-slate-600'
                }`}>{fmtN(loggedInToday.length)}</span>
              </button>
              <button
                onClick={() => { setReportTab('not_logged_in'); setSearchQuery(''); setSelectedNotLoggedIn(new Set()) }}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                  reportTab === 'not_logged_in' ? 'bg-red-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <UserX size={12} />
                Not Logged In
                <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  reportTab === 'not_logged_in' ? 'bg-red-700 text-white' : 'bg-slate-200 text-slate-600'
                }`}>{fmtN(notLoggedIn.length)}</span>
              </button>

              <button
  onClick={() => { setReportTab('failed'); setSearchQuery(''); setSelectedNotLoggedIn(new Set()) }}
  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
    reportTab === 'failed' ? 'bg-amber-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
  }`}
>
  <AlertTriangle size={12} />
  Failed
  <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
    reportTab === 'failed' ? 'bg-amber-700 text-white' : 'bg-slate-200 text-slate-600'
  }`}>
    {fmtN(failedLoginRows.length)}
  </span>
</button>
            </div>

            {/* Search */}
            <div className="relative flex-1 min-w-[240px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder={
  reportTab === 'logged_in'
    ? 'Search by name, role, group.'
    : reportTab === 'failed'
      ? 'Search by username, role.'
      : 'Search by name, employee code, phone.'
}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white pl-9 pr-4 py-2.5 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400"
              />
            </div>

            {/* Bulk send mail */}
            {reportTab === 'not_logged_in' && selectedNotLoggedIn.size > 0 && (
              <button
                onClick={openMailForSelected}
                className="flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3.5 py-2 text-xs font-medium text-indigo-700 hover:bg-indigo-100 transition-colors shadow-sm"
              >
                <Send size={13} /> Send Reminder ({selectedNotLoggedIn.size})
              </button>
            )}

            {/* Export */}
            <button
              onClick={handleExportReport}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
            >
              <Download size={13} /> Export CSV
            </button>
          </div>

          {reportTab === 'all' && (
  <SCard>
    <SCardHead
      title="All Employees"
      sub={`${filteredAllEmployees.length} employee(s) in current scope`}
    />

    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-xs">
        <thead>
          <tr className="bg-slate-50 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
            <th className="px-4 py-2.5 text-left">Employee</th>
            <th className="px-4 py-2.5 text-left">Username</th>
            <th className="px-4 py-2.5 text-left">Role</th>
            <th className="px-4 py-2.5 text-left">Group</th>
            <th className="px-4 py-2.5 text-left">Region</th>
            <th className="px-4 py-2.5 text-left">Branch</th>
            <th className="px-4 py-2.5 text-left">Status</th>
            <th className="px-4 py-2.5 text-left">Login / Last Login</th>
          </tr>
        </thead>

        <tbody>
          {filteredAllEmployees.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-400">
                No employees found
              </td>
            </tr>
          ) : filteredAllEmployees.map((r: any, i: number) => (
            <tr key={r.id || i} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-4 py-2.5 font-semibold text-slate-800">{r.name || '—'}</td>
              <td className="px-4 py-2.5 text-slate-500">@{r.username || '—'}</td>
              <td className="px-4 py-2.5">{r.role || '—'}</td>
              <td className="px-4 py-2.5">{r.group || '—'}</td>
              <td className="px-4 py-2.5">{r.region || '—'}</td>
              <td className="px-4 py-2.5">{r.branch || '—'}</td>
              <td className="px-4 py-2.5">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  r.status === 'Logged In'
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-red-100 text-red-600'
                }`}>
                  {r.status}
                </span>
              </td>
              <td className="px-4 py-2.5 text-slate-600">
                {r.status === 'Logged In'
                  ? fmtTime(r.first_login)
                  : r.last_login
                    ? fmtDateTime(r.last_login)
                    : 'Never logged in'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </SCard>
)}

{reportTab === 'failed' && (
  <SCard>
    <SCardHead
      title="Failed Login Attempts"
      sub={`${filteredFailedLogins.length} user(s) with failed attempts`}
    />

    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-xs">
        <thead>
          <tr className="bg-slate-50 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">
            <th className="px-4 py-2.5 text-left">User</th>
            <th className="px-4 py-2.5 text-left">Username</th>
            <th className="px-4 py-2.5 text-left">Role</th>
            <th className="px-4 py-2.5 text-right">Attempts</th>
            <th className="px-4 py-2.5 text-left">Status</th>
          </tr>
        </thead>

        <tbody>
          {filteredFailedLogins.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-400">
                No failed login attempts
              </td>
            </tr>
          ) : filteredFailedLogins.map((r: any, i: number) => (
            <tr key={r.id || r.username || i} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-4 py-2.5 font-semibold text-slate-800">{r.name || '—'}</td>
              <td className="px-4 py-2.5 text-slate-500">@{r.username || '—'}</td>
              <td className="px-4 py-2.5">{r.role || '—'}</td>
              <td className="px-4 py-2.5 text-right font-bold text-amber-700">{r.attempts || 0}</td>
              <td className="px-4 py-2.5">
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                  Failed
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </SCard>
)}

          {/* ── LOGGED IN TODAY TABLE ─────────────────────────────────────────── */}
          {reportTab === 'logged_in' && (
            <SCard>
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <div className="text-xs text-slate-500">
                  <span className="font-semibold text-slate-700">{fmtN(filteredLoggedIn.length)}</span> unique employees logged in today
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] table-fixed text-[12px]">
                  <colgroup>
                    <col className="w-[16%]" />
                    <col className="w-[8%]" />
                    <col className="w-[10%]" />
                    <col className="w-[10%]" />
                    <col className="w-[8%]" />
                    <col className="w-[12%]" />
                    <col className="w-[12%]" />
                    <col className="w-[8%]" />
                    <col className="w-[8%]" />
                    <col className="w-[8%]" />
                  </colgroup>
                  <thead>
                    <tr className="bg-slate-50/80">
                      {[
                        'Employee', 'Role', 'Region', 'Group', 'Branch',
                        'First Login', 'Last Activity', 'Duration', 'Sessions', 'Device',
                      ].map(label => (
                        <th key={label} className="border-b border-slate-200 px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLoggedIn.length === 0 ? (
                      <tr><td colSpan={10} className="px-4 py-10 text-center text-sm text-slate-400">No employees logged in today</td></tr>
                    ) : filteredLoggedIn.map((r: any, i: number) => (
                      <tr key={`${r.user_id}-${i}`}
                        className={`border-b border-slate-100 last:border-b-0 hover:bg-emerald-50/30 transition-colors ${i % 2 === 0 ? '' : 'bg-slate-50/30'}`}>
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-800 truncate" title={r.user_name}>{r.user_name}</div>
                          <div className="text-[10px] text-slate-400">{r.username}</div>
                        </td>
                        <td className="px-3 py-2">
                          <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 capitalize">{r.role}</span>
                        </td>
                        <td className="px-3 py-2 text-slate-600 truncate">{r.region || '—'}</td>
                        <td className="px-3 py-2 text-slate-600 truncate">{r.group || '—'}</td>
                        <td className="px-3 py-2 text-slate-500 truncate">{r.branch || '—'}</td>
                        <td className="px-3 py-2">
                          <div className="tabular-nums text-emerald-700 font-medium">{fmtTime(r.first_login)}</div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="tabular-nums text-slate-600">{fmtTime(r.last_logout)}</div>
                        </td>
                        <td className="px-3 py-2 text-center tabular-nums font-semibold text-violet-700">{fmtDuration(r.duration_minutes)}</td>
                        <td className="px-3 py-2 text-center font-bold text-indigo-700 tabular-nums">{r.session_count}</td>
                        <td className="px-3 py-2 text-[10px] text-slate-400 truncate">
                          {(r.devices || []).length > 0 ? (r.devices || [])[0] : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SCard>
          )}

          {/* ── NOT LOGGED IN TABLE ───────────────────────────────────────────── */}
          {reportTab === 'not_logged_in' && (
            <SCard>
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">
                <div className="text-xs text-slate-500">
                  <span className="font-semibold text-slate-700">{fmtN(filteredNotLoggedIn.length)}</span> employees haven't logged in today
                </div>
                {filteredNotLoggedIn.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={toggleSelectAll}
                      className="flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-indigo-600 transition-colors"
                    >
                      {selectedNotLoggedIn.size === filteredNotLoggedIn.length && filteredNotLoggedIn.length > 0
                        ? <CheckSquare size={14} className="text-indigo-600" />
                        : <Square size={14} />
                      }
                      {selectedNotLoggedIn.size === filteredNotLoggedIn.length && filteredNotLoggedIn.length > 0
                        ? 'Deselect All' : 'Select All'
                      }
                    </button>
                    {selectedNotLoggedIn.size > 0 && (
                      <span className="text-xs text-indigo-700 font-medium">{selectedNotLoggedIn.size} selected</span>
                    )}
                  </div>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1000px] table-fixed text-[12px]">
                  <colgroup>
                    <col className="w-[4%]" />
                    <col className="w-[16%]" />
                    <col className="w-[8%]" />
                    <col className="w-[9%]" />
                    <col className="w-[9%]" />
                    <col className="w-[7%]" />
                    <col className="w-[10%]" />
                    <col className="w-[9%]" />
                    <col className="w-[14%]" />
                    <col className="w-[10%]" />
                  </colgroup>
                  <thead>
                    <tr className="bg-slate-50/80">
                      <th className="border-b border-slate-200 px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selectedNotLoggedIn.size === filteredNotLoggedIn.length && filteredNotLoggedIn.length > 0}
                          onChange={toggleSelectAll}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-200"
                        />
                      </th>
                      {['Employee', 'Role', 'Region', 'Group', 'Branch', 'Phone', 'Emp Code', 'Last Login', 'Action'].map(label => (
                        <th key={label} className="border-b border-slate-200 px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredNotLoggedIn.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-4 py-10 text-center">
                          <div className="flex flex-col items-center gap-2 text-slate-400">
                            <UserCheck size={24} className="text-emerald-400" />
                            <span className="text-sm font-medium text-emerald-600">All employees have logged in today!</span>
                          </div>
                        </td>
                      </tr>
                    ) : filteredNotLoggedIn.map((r: any, i: number) => (
                      <tr key={r.id || i}
                        className={`border-b border-slate-100 last:border-b-0 hover:bg-red-50/30 transition-colors ${
                          selectedNotLoggedIn.has(r.id) ? 'bg-indigo-50/50' : i % 2 === 0 ? '' : 'bg-slate-50/30'
                        }`}>
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={selectedNotLoggedIn.has(r.id)}
                            onChange={() => toggleSelectUser(r.id)}
                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-200"
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-slate-800 truncate" title={r.name || r.user_name}>{r.name || r.user_name}</div>
                          <div className="text-[10px] text-slate-400">{r.username}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 capitalize">{r.role}</span>
                        </td>
                        <td className="px-3 py-2.5 text-slate-600 truncate">{r.region || '—'}</td>
                        <td className="px-3 py-2.5 text-slate-600 truncate">{r.group || '—'}</td>
                        <td className="px-3 py-2.5 text-slate-500 truncate">{r.branch || '—'}</td>
                        <td className="px-3 py-2.5">
                          {r.phone ? (
                            <a href={`tel:${r.phone}`} className="flex items-center gap-1 text-sky-600 hover:text-sky-700 font-medium text-[11px]">
                              <Phone size={11} /> {r.phone}
                            </a>
                          ) : <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-slate-500 font-mono text-[11px]">{r.employee_code || '—'}</td>
                        <td className="px-3 py-2.5">
                          {r.last_login ? (
                            <div>
                              <div className="tabular-nums text-slate-600 text-[11px]">{fmtDateTime(r.last_login)}</div>
                              <div className="text-[10px] text-slate-400">
                                {(() => {
                                  try {
                                    const days = Math.floor((Date.now() - new Date(r.last_login).getTime()) / 86400000)
                                    return days === 0 ? 'Yesterday' : `${days}d ago`
                                  } catch { return '' }
                                })()}
                              </div>
                            </div>
                          ) : (
                            <span className="text-[11px] text-red-400 font-medium">Never logged in</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <button
                            onClick={() => openMailForOne(r)}
                            className="flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100 transition-colors"
                          >
                            <Mail size={11} /> Send Mail
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredNotLoggedIn.length > 0 && selectedNotLoggedIn.size > 0 && (
                <div className="border-t border-slate-100 px-5 py-3 flex items-center justify-end">
                  <button
                    onClick={openMailForSelected}
                    className="flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-4 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors"
                  >
                    <Send size={13} /> Send Reminder to {selectedNotLoggedIn.size} Selected
                  </button>
                </div>
              )}
            </SCard>
          )}
        </>
      )}

      {/* ── Role Drill-Down Modal ──────────────────────────────────────────────── */}
      {selectedRole && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-3xl rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <div>
                <h3 className="text-sm font-bold text-slate-900 capitalize">{selectedRole.name} Users</h3>
                <p className="text-xs text-slate-500">{selectedRole.value} user(s)</p>
              </div>
              <button onClick={() => setSelectedRole(null)} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100">Close</button>
            </div>
            <div className="max-h-[420px] overflow-y-auto divide-y divide-slate-100">
              {(selectedRole.users || []).map((u: any) => (
                <div key={u.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{u.name}</div>
                    <div className="text-xs text-slate-400">{u.username} · {u.email || 'No email'}</div>
                    <div className="text-xs text-slate-400">
                      {u.group || 'No group'} {u.region ? `· ${u.region}` : ''} {u.branch ? `· ${u.branch}` : ''}
                    </div>
                  </div>
                  <div className="text-right text-xs text-slate-500">
                    <div>{u.last_login ? fmtDateTime(u.last_login) : 'Never logged in'}</div>
                    <div className={u.is_active ? 'text-emerald-600' : 'text-slate-400'}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

     

      {/* ── Send Mail Modal ────────────────────────────────────────────────────── */}
      {showMailModal && (
        <SendMailModal
          users={mailTargetUsers}
          onClose={() => setShowMailModal(false)}
          onSend={handleSendMail}
        />
      )}
    </div>
  )
}
