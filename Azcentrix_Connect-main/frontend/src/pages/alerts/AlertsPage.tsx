import { useState, useEffect } from 'react'
import { Bell, AlertTriangle, AlertCircle, Info, CheckCircle, BellOff, RefreshCw } from 'lucide-react'
import api from '@/services/api'
import Card from '@/components/ui/Card'
import Button from '@/components/ui/Button'
import { PageHeader, StatCard, useToast } from '@/components/ui/FormComponents'
import { useModuleName } from '@/context/ModuleLabelsContext'

const SEVERITY_STYLES: Record<string, { bg: string; border: string; icon: React.ReactNode; text: string }> = {
  critical: { bg: 'bg-red-50', border: 'border-red-200', icon: <AlertCircle size={18} className="text-red-500"/>, text: 'text-red-700' },
  error:    { bg: 'bg-red-50', border: 'border-red-200', icon: <AlertCircle size={18} className="text-red-500"/>, text: 'text-red-700' },
  warning:  { bg: 'bg-amber-50', border: 'border-amber-200', icon: <AlertTriangle size={18} className="text-amber-500"/>, text: 'text-amber-700' },
  info:     { bg: 'bg-blue-50', border: 'border-blue-200', icon: <Info size={18} className="text-blue-500"/>, text: 'text-blue-700' },
}

export default function AlertsPage() {
  const { label: alertLabel, singular: alertSingular } = useModuleName('alerts')
  const [alerts, setAlerts] = useState<any[]>([])
  const [allAlerts, setAllAlerts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [severity, setSeverity] = useState('')
  const [category, setCategory] = useState('')
  const { success, error: showError } = useToast()

  const load = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (severity) params.append('severity', severity)
      if (category) params.append('category', category)
      const [filtered, all] = await Promise.all([
        api.get(`/alerts?${params}`),
        api.get('/alerts'),
      ])
      setAlerts(filtered.data)
      setAllAlerts(all.data)
    } catch { showError('Failed to load alerts') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [severity, category])

  const markRead = async (id: number) => {
    try { await api.put(`/alerts/${id}/read`); load() }
    catch {}
  }

  const markAllRead = async () => {
    try { await api.put('/alerts/mark-all-read'); success(`All ${alertLabel.toLowerCase()} marked as read`); load() }
    catch { showError('Failed') }
  }

  const dismiss = async (id: number) => {
    try { await api.put(`/alerts/${id}/dismiss`); load() }
    catch {}
  }

  const unread = allAlerts.filter(a => !a.is_read).length
  const critical = allAlerts.filter(a => a.severity === 'critical').length
  const warning = allAlerts.filter(a => a.severity === 'warning').length

  const categories = [...new Set(allAlerts.map(a => a.category))].filter(Boolean)

  return (
    <div className="p-6">
      <PageHeader title={alertLabel} subtitle={`System ${alertLabel.toLowerCase()} and automated notifications across all modules`}
        breadcrumb={[alertLabel]}
        actions={
          <div className="flex gap-2">
            <button onClick={load} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
            {unread > 0 && <Button variant="secondary" size="sm" onClick={markAllRead}>Mark All Read</Button>}
          </div>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard title="Unread" value={unread} icon={<Bell size={20}/>} color="blue" />
        <StatCard title="Critical" value={critical} icon={<AlertCircle size={20}/>} color="red" />
        <StatCard title="Warnings" value={warning} icon={<AlertTriangle size={20}/>} color="amber" />
        <StatCard title="Total" value={alerts.length} icon={<Bell size={20}/>} color="indigo" />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {['','critical','warning','error','info'].map(s => (
          <button key={s} onClick={() => setSeverity(s)}
            className={`px-3 py-1 text-sm font-medium rounded-full border transition-all
              ${severity===s ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:border-gray-400'}`}>
            {s || 'All Severity'}
          </button>
        ))}
        <div className="h-5 w-px bg-gray-200 mx-1" />
        {['', ...categories].map(c => (
          <button key={c} onClick={() => setCategory(c)}
            className={`px-3 py-1 text-sm font-medium rounded-full border transition-all
              ${category===c ? 'bg-gray-800 text-white border-gray-800' : 'border-gray-200 text-gray-600 hover:border-gray-400'}`}>
            {c || 'All Categories'}
          </button>
        ))}
      </div>

      {/* Alerts List */}
      {loading ? (
        <Card><div className="p-12 text-center text-gray-400">Loading...</div></Card>
      ) : alerts.length === 0 ? (
        <Card>
          <div className="p-16 text-center">
            <BellOff size={48} className="text-gray-200 mx-auto mb-3" />
            <p className="text-gray-500 font-medium">No alerts</p>
            <p className="text-sm text-gray-400">You're all caught up!</p>
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {alerts.filter(a => !a.is_dismissed).map((alert: any) => {
            const style = SEVERITY_STYLES[alert.severity] || SEVERITY_STYLES.info
            return (
              <div key={alert.id}
                className={`flex items-start gap-3 p-4 rounded-xl border ${style.bg} ${style.border} ${!alert.is_read ? 'shadow-sm' : 'opacity-70'}`}>
                <div className="mt-0.5 flex-shrink-0">{style.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className={`text-sm font-semibold ${style.text}`}>{alert.title}</p>
                      <p className="text-sm text-gray-700 mt-0.5">{alert.message}</p>
                      <div className="flex items-center gap-2 mt-1">
                        {alert.category && <span className="text-xs text-gray-400 bg-white/60 px-1.5 py-0.5 rounded">{alert.category}</span>}
                        {alert.module && <span className="text-xs text-gray-400">{alert.module}</span>}
                        <span className="text-xs text-gray-400">{new Date(alert.created_at).toLocaleString('en-IN')}</span>
                      </div>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      {!alert.is_read && (
                        <button onClick={() => markRead(alert.id)}
                          className="p-1 rounded text-gray-400 hover:text-green-600 hover:bg-white transition-colors" title="Mark read">
                          <CheckCircle size={14}/>
                        </button>
                      )}
                      <button onClick={() => dismiss(alert.id)}
                        className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-white transition-colors" title="Dismiss">
                        <BellOff size={14}/>
                      </button>
                    </div>
                  </div>
                </div>
                {!alert.is_read && <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-1.5" />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
