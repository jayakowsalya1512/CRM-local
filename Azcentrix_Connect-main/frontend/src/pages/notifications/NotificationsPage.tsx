import { useState, useEffect, useCallback } from 'react'
import {
  Bell, BellOff, CheckCheck, Check, Trash2, RefreshCw,
  CheckCircle, XCircle, Clock, AlertTriangle, Info,
} from 'lucide-react'
import api from '@/services/api'
import { useToast }     from '@/components/ui/FormComponents'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { useNotifStore } from '@/store/notifStore'

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Meta = {
  icon: React.ReactNode
  iconBg: string; iconColor: string
  dot: string
  tag: string; tagText: string
}

function getMeta(action = ''): Meta {
  if (action.includes('approved') || action.includes('conversion_approved'))
    return { icon: <CheckCircle size={15} />, iconBg: 'bg-green-50', iconColor: 'text-green-600', dot: 'bg-green-500', tag: 'bg-green-50 text-green-700', tagText: 'Approved' }
  if (action.includes('rejected') || action.includes('conversion_rejected'))
    return { icon: <XCircle size={15} />,     iconBg: 'bg-red-50',   iconColor: 'text-red-500',   dot: 'bg-red-500',   tag: 'bg-red-50 text-red-600',     tagText: 'Rejected' }
  if (action.includes('request') || action.includes('approval') || action.includes('pending'))
    return { icon: <Clock size={15} />,       iconBg: 'bg-amber-50', iconColor: 'text-amber-600', dot: 'bg-amber-500', tag: 'bg-amber-50 text-amber-700', tagText: 'Pending'  }
  if (action.includes('warn') || action.includes('alert'))
    return { icon: <AlertTriangle size={15} />, iconBg: 'bg-orange-50', iconColor: 'text-orange-500', dot: 'bg-orange-500', tag: 'bg-orange-50 text-orange-600', tagText: 'Alert' }
  return   { icon: <Info size={15} />,        iconBg: 'bg-blue-50',  iconColor: 'text-blue-500',  dot: 'bg-blue-500',  tag: 'bg-blue-50 text-blue-600',   tagText: 'Info'     }
}

function timeAgo(iso: string): string {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60)     return 'Just now'
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function NotifRow({ n, onRead, onDelete }: {
  n: any; onRead: (id: number) => void; onDelete: (id: number) => void
}) {
  const meta = getMeta(n.action)
  return (
    <div className="group flex items-start gap-4 px-5 py-4 border-b border-gray-100
      last:border-0 transition-colors hover:bg-gray-50/60">

      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0
        mt-0.5 ${meta.iconBg} ${meta.iconColor}`}>
        {meta.icon}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-sm font-semibold leading-snug
                ${n.is_read ? 'text-gray-500' : 'text-gray-800'}`}>
                {n.title}
              </span>
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${meta.tag}`}>
                {meta.tagText}
              </span>
              {n.module && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md
                  bg-gray-100 text-gray-400 uppercase tracking-wide">
                  {n.module}
                </span>
              )}
            </div>
            <p className={`text-xs mt-1 leading-relaxed line-clamp-2
              ${n.is_read ? 'text-gray-400' : 'text-gray-500'}`}>
              {n.message}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <span className="text-[11px] text-gray-400 whitespace-nowrap">{timeAgo(n.created_at)}</span>
            {!n.is_read && <div className={`w-2 h-2 rounded-full ${meta.dot}`} />}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100
        transition-opacity flex-shrink-0 mt-1">
        {!n.is_read && (
          <button onClick={() => onRead(n.id)} title="Mark as read"
            className="w-7 h-7 rounded-lg border border-gray-200 bg-white flex items-center
              justify-center text-gray-400 hover:text-green-600 hover:border-green-200 transition-colors">
            <Check size={12} />
          </button>
        )}
        <button onClick={() => onDelete(n.id)} title="Delete"
          className="w-7 h-7 rounded-lg border border-gray-200 bg-white flex items-center
            justify-center text-gray-400 hover:text-red-500 hover:border-red-200 transition-colors">
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NotificationsPage() {
  const { label: notifLabel } = useModuleName('notifications')
  const [notifications, setNotifications] = useState<any[]>([])
  const [loading,       setLoading]       = useState(true)
  const [filter,        setFilter]        = useState<'all' | 'unread'>('all')
  const { error: showError, success }     = useToast()

  // Shared store — badge in Header reflects changes made here instantly
  const { markRead: storeMark, markAll: storeMarkAll, refresh: storeRefresh } = useNotifStore()

  const unreadCount   = notifications.filter(n => !n.is_read).length
  const approvedCount = notifications.filter(n => n.action?.includes('approved')).length
  const rejectedCount = notifications.filter(n => n.action?.includes('rejected')).length

  // ── fetch ─────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get(`/notifications${filter === 'unread' ? '?unread_only=true' : ''}`)
      setNotifications(Array.isArray(r.data) ? r.data : r.data.items ?? [])
    } catch { showError('Failed to load notifications') }
    finally   { setLoading(false) }
  }, [filter])

  useEffect(() => { load() }, [load])

  // Refresh the badge whenever this page mounts (user may have read from dropdown)
  useEffect(() => { storeRefresh() }, [])

  // ── mark single read ──────────────────────────────────────────────────────
  const markRead = async (id: number) => {
    // Optimistic local update
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n))
    storeMark()   // badge decrements immediately
    try {
      await api.put(`/notifications/${id}/read`)
      if (filter === 'unread') setNotifications(prev => prev.filter(n => n.id !== id))
    } catch {
      // revert
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: false } : n))
      storeRefresh()
      showError('Failed to mark as read')
    }
  }

  // ── mark all read ─────────────────────────────────────────────────────────
  const markAllRead = async () => {
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })))
    storeMarkAll()  // badge zeroes immediately
    try {
      await api.put('/notifications/mark-all-read')
      if (filter === 'unread') setNotifications([])
      success('All marked as read')
    } catch { showError('Failed'); load(); storeRefresh() }
  }

  // ── delete ────────────────────────────────────────────────────────────────
  const deleteNotif = async (id: number) => {
    const wasUnread = notifications.find(n => n.id === id)?.is_read === false
    setNotifications(prev => prev.filter(n => n.id !== id))
    if (wasUnread) storeMark()
    try { await api.delete(`/notifications/${id}`) }
    catch { showError('Failed to delete'); load(); storeRefresh() }
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-5">

      {/* Page header */}
      <div>
        <p className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-0.5">Management</p>
        <h1 className="text-2xl font-bold text-gray-900">{notifLabel}</h1>
        <p className="text-sm text-gray-500 mt-0.5">All system alerts and approval updates</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'TOTAL',    value: notifications.length, icon: <Bell size={20} />,       bg: 'bg-blue-50',  color: 'text-blue-500'  },
          { label: 'UNREAD',   value: unreadCount,          icon: <Clock size={20} />,       bg: 'bg-amber-50', color: 'text-amber-500' },
          { label: 'APPROVED', value: approvedCount,        icon: <CheckCircle size={20} />, bg: 'bg-green-50', color: 'text-green-500' },
          { label: 'REJECTED', value: rejectedCount,        icon: <XCircle size={20} />,     bg: 'bg-red-50',   color: 'text-red-500'   },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-2xl border border-gray-100 p-5
            flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-gray-400 tracking-wide">{s.label}</p>
              <p className="text-3xl font-bold text-gray-800 mt-1">{s.value}</p>
            </div>
            <div className={`w-12 h-12 rounded-2xl ${s.bg} ${s.color}
              flex items-center justify-center`}>
              {s.icon}
            </div>
          </div>
        ))}
      </div>

      {/* Main panel */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">

        {/* Toolbar */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
            {(['all', 'unread'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-all
                  ${filter === f
                    ? 'bg-white text-gray-800 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'}`}>
                {f === 'all' ? 'All' : `Unread${unreadCount > 0 ? ` (${unreadCount})` : ''}`}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <button onClick={markAllRead}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold
                  text-gray-600 bg-white border border-gray-200 rounded-xl
                  hover:bg-gray-50 transition-all">
                <CheckCheck size={13} /> Mark All Read
              </button>
            )}
            <button onClick={load}
              className="w-8 h-8 flex items-center justify-center rounded-xl
                border border-gray-200 text-gray-400 hover:text-gray-700
                hover:bg-gray-50 transition-all">
              <RefreshCw size={13} />
            </button>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div>
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="flex items-start gap-4 px-5 py-4
                border-b border-gray-100 last:border-0">
                <div className="w-9 h-9 rounded-xl bg-gray-100 animate-pulse flex-shrink-0" />
                <div className="flex-1 space-y-2 py-1">
                  <div className="h-3.5 bg-gray-100 rounded-lg animate-pulse w-44" />
                  <div className="h-3 bg-gray-100 rounded-lg animate-pulse w-full" />
                  <div className="h-3 bg-gray-100 rounded-lg animate-pulse w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center
              justify-center mb-4">
              <BellOff size={28} className="text-gray-300" />
            </div>
            <p className="text-base font-semibold text-gray-700">
              {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
            </p>
            <p className="text-sm text-gray-400 mt-1">
              {filter === 'unread' ? "You're all caught up!" : 'Notifications will appear here'}
            </p>
            {filter === 'unread' && (
              <button onClick={() => setFilter('all')}
                className="mt-4 text-sm font-semibold text-blue-600 hover:underline">
                View all notifications
              </button>
            )}
          </div>
        ) : (
          <div>
            {notifications.map((n: any) => (
              <NotifRow key={n.id} n={n} onRead={markRead} onDelete={deleteNotif} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}