/**
 * IntegrationsPage.tsx
 * Admin-only page to configure WhatsApp / Email / Telephone lead integrations.
 * Shows webhook URLs to copy into external services and lets admins set
 * the default assignee for auto-created leads.
 */
import { useState, useEffect } from 'react'
import {
  MessageCircle, Mail, Phone, Copy, Check, RefreshCw,
  Settings, ChevronDown, ChevronUp, AlertCircle, CheckCircle2,
  ExternalLink, Clock, User,
} from 'lucide-react'
import { integrationsApi, mastersApi } from '@/services/api'
import { PageHeader, useToast } from '@/components/ui/FormComponents'
import { useModuleName } from '@/context/ModuleLabelsContext'
import Button from '@/components/ui/Button'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChannelConfig {
  enabled: boolean
  default_assignee: number | null
  verify_token?: string
  provider?: string
}

interface Config {
  whatsapp:  ChannelConfig & { verify_token: string }
  email:     ChannelConfig
  telephone: ChannelConfig & { provider: string }
}

interface WebhookInfo {
  whatsapp:  { webhook_url: string; verify_token: string; instructions: string }
  email:     { webhook_url: string; instructions: string }
  telephone: { webhook_url: string; instructions: string }
}

interface LogItem {
  id: number
  channel: string
  channel_ref_id: string
  status: string
  lead_id: number | null
  error_message: string | null
  created_at: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={handleCopy}
      className="ml-2 p-1 rounded hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-700"
      title="Copy to clipboard">
      {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
    </button>
  )
}

function WebhookUrlBox({ url, label }: { url: string; label: string }) {
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>
      <div className="flex items-center gap-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
        <code className="text-xs text-gray-700 break-all flex-1">{url}</code>
        <CopyButton text={url} />
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    processed: 'bg-emerald-100 text-emerald-700',
    duplicate: 'bg-amber-100 text-amber-700',
    failed:    'bg-red-100 text-red-700',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${map[status] || 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  )
}

// ─── Channel Section Component ────────────────────────────────────────────────

function ChannelSection({
  title, icon, color, channel, cfg, webhookInfo, users, onToggle, onAssigneeChange, onSave, saving,
  extraFields,
}: {
  title: string
  icon: React.ReactNode
  color: string
  channel: string
  cfg: ChannelConfig
  webhookInfo: Record<string, any>
  users: { value: number; label: string }[]
  onToggle: () => void
  onAssigneeChange: (id: number | null) => void
  onSave: () => void
  saving: boolean
  extraFields?: React.ReactNode
}) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="border border-gray-200 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className={`flex items-center justify-between px-5 py-4 ${color}`}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-white/80 rounded-xl flex items-center justify-center shadow-sm">
            {icon}
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 text-sm">{title}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {cfg.enabled ? 'Active — receiving leads' : 'Disabled'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Toggle */}
          <button
            onClick={onToggle}
            className={`relative w-10 h-5 rounded-full transition-colors ${cfg.enabled ? 'bg-blue-600' : 'bg-gray-300'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${cfg.enabled ? 'translate-x-5' : ''}`} />
          </button>
          <button onClick={() => setExpanded(e => !e)} className="text-gray-400 hover:text-gray-600">
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-5 py-4 space-y-4 bg-white">
          {/* Webhook URL */}
          {webhookInfo?.webhook_url && (
            <div>
              <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5 mb-1">
                <ExternalLink size={12} /> Webhook URL
              </p>
              <WebhookUrlBox url={webhookInfo.webhook_url} label="Configure this URL in your external service" />
              {webhookInfo.instructions && (
                <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                  <AlertCircle size={11} /> {webhookInfo.instructions}
                </p>
              )}
            </div>
          )}

          {/* Extra fields (e.g. verify token) */}
          {extraFields}

          {/* Default Assignee */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1.5">
              <User size={12} /> Default Assignee
            </label>
            <p className="text-xs text-gray-400 mb-2">
              Leads from this channel will be assigned to this user automatically.
            </p>
            <select
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
              value={cfg.default_assignee ?? ''}
              onChange={e => onAssigneeChange(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Auto-select (first available sales user)</option>
              {users.map(u => (
                <option key={u.value} value={u.value}>{u.label}</option>
              ))}
            </select>
          </div>

          <div className="pt-2 flex justify-end">
            <Button
              onClick={onSave}
              disabled={saving}
              className="bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 px-4 py-2 text-sm"
            >
              {saving ? 'Saving…' : 'Save Settings'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function IntegrationsPage() {
  const { label: integrationsLabel } = useModuleName('integrations')
  const [config,      setConfig]      = useState<Config | null>(null)
  const [webhookInfo, setWebhookInfo] = useState<WebhookInfo | null>(null)
  const [logs,        setLogs]        = useState<LogItem[]>([])
  const [users,       setUsers]       = useState<{ value: number; label: string }[]>([])
  const [loading,     setLoading]     = useState(true)
  const [saving,      setSaving]      = useState<string | null>(null)
  const [logsChannel, setLogsChannel] = useState('')
  const { success, error: showError } = useToast()

  const load = async () => {
    setLoading(true)
    try {
      const [cfgRes, infoRes, logsRes, usersRes] = await Promise.all([
        integrationsApi.getConfig(),
        integrationsApi.getWebhookInfo(),
        integrationsApi.getLogs({ limit: 20 }),
        mastersApi.usersForSelect('admin,ceo,manager,sales'),
      ])
      setConfig(cfgRes.data)
      setWebhookInfo(infoRes.data)
      setLogs(logsRes.data.items || [])
      const rawUsers = Array.isArray(usersRes.data) ? usersRes.data : (usersRes.data?.users || [])
      setUsers(rawUsers.map((u: any) => ({ value: u.id, label: u.full_name || u.name })))
    } catch {
      showError('Failed to load integration settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const loadLogs = async (channel = logsChannel) => {
    try {
      const res = await integrationsApi.getLogs({ limit: 20, channel: channel || undefined })
      setLogs(res.data.items || [])
    } catch {
      showError('Failed to reload logs')
    }
  }

  const saveChannel = async (channel: 'whatsapp' | 'email' | 'telephone') => {
    if (!config) return
    setSaving(channel)
    try {
      const cfg = config[channel] as any
      const payload: Record<string, any> = {
        [`${channel}_enabled`]:          cfg.enabled,
        [`${channel}_default_assignee`]: cfg.default_assignee,
      }
      if (channel === 'whatsapp') payload.whatsapp_verify_token = cfg.verify_token
      if (channel === 'telephone') payload.telephone_provider    = cfg.provider
      await integrationsApi.updateConfig(payload)
      success('Settings saved')
    } catch {
      showError('Failed to save settings')
    } finally {
      setSaving(null)
    }
  }

  const toggle = (ch: 'whatsapp' | 'email' | 'telephone') =>
    setConfig(c => c ? { ...c, [ch]: { ...c[ch], enabled: !c[ch].enabled } } : c)

  const setAssignee = (ch: 'whatsapp' | 'email' | 'telephone', id: number | null) =>
    setConfig(c => c ? { ...c, [ch]: { ...c[ch], default_assignee: id } } : c)

  if (loading) return (
    <div className="p-6 flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!config || !webhookInfo) return null

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <PageHeader
        title={`Channel ${integrationsLabel}`}
        subtitle="Configure WhatsApp, Email, and Telephone lead capture via API webhooks"
        breadcrumb={['Settings', integrationsLabel]}
        actions={<button onClick={load} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>}
      />

      {/* ── WhatsApp ──────────────────────────────────────────────────────── */}
      <ChannelSection
        title="WhatsApp Business API"
        icon={<MessageCircle size={18} className="text-green-600" />}
        color="bg-green-50"
        channel="whatsapp"
        cfg={config.whatsapp}
        webhookInfo={webhookInfo.whatsapp}
        users={users}
        onToggle={() => toggle('whatsapp')}
        onAssigneeChange={id => setAssignee('whatsapp', id)}
        onSave={() => saveChannel('whatsapp')}
        saving={saving === 'whatsapp'}
        extraFields={
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              Verify Token
            </label>
            <p className="text-xs text-gray-400 mb-2">
              Paste this token into the Meta WhatsApp webhook verification field.
            </p>
            <div className="flex items-center gap-1 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              <code className="text-xs text-gray-700 flex-1">{config.whatsapp.verify_token}</code>
              <CopyButton text={config.whatsapp.verify_token} />
            </div>
          </div>
        }
      />

      {/* ── Email ─────────────────────────────────────────────────────────── */}
      <ChannelSection
        title="Email Inbound (SendGrid / Mailgun / Postmark)"
        icon={<Mail size={18} className="text-blue-600" />}
        color="bg-blue-50"
        channel="email"
        cfg={config.email}
        webhookInfo={webhookInfo.email}
        users={users}
        onToggle={() => toggle('email')}
        onAssigneeChange={id => setAssignee('email', id)}
        onSave={() => saveChannel('email')}
        saving={saving === 'email'}
      />

      {/* ── Telephone ─────────────────────────────────────────────────────── */}
      <ChannelSection
        title="Telephone / Call Center (Exotel / Twilio / Knowlarity)"
        icon={<Phone size={18} className="text-orange-600" />}
        color="bg-orange-50"
        channel="telephone"
        cfg={config.telephone}
        webhookInfo={webhookInfo.telephone}
        users={users}
        onToggle={() => toggle('telephone')}
        onAssigneeChange={id => setAssignee('telephone', id)}
        onSave={() => saveChannel('telephone')}
        saving={saving === 'telephone'}
        extraFields={
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Provider</label>
            <select
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
              value={config.telephone.provider || 'generic'}
              onChange={e => setConfig(c => c ? { ...c, telephone: { ...c.telephone, provider: e.target.value } } : c)}
            >
              <option value="generic">Generic</option>
              <option value="exotel">Exotel</option>
              <option value="twilio">Twilio</option>
              <option value="knowlarity">Knowlarity</option>
            </select>
          </div>
        }
      />

      {/* ── Recent Logs ───────────────────────────────────────────────────── */}
      <div className="border border-gray-200 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 bg-gray-50 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-gray-500" />
            <h3 className="font-semibold text-gray-800 text-sm">Recent Webhook Events</h3>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="text-xs border border-gray-300 rounded-lg px-2 py-1.5 focus:outline-none"
              value={logsChannel}
              onChange={e => { setLogsChannel(e.target.value); loadLogs(e.target.value) }}
            >
              <option value="">All channels</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
              <option value="telephone">Telephone</option>
            </select>
            <button onClick={() => loadLogs()}
              className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-500 transition-colors">
              <RefreshCw size={14} />
            </button>
          </div>
        </div>

        {logs.length === 0 ? (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">
            No webhook events yet
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {logs.map(log => (
              <div key={log.id} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-base">
                  {log.channel === 'whatsapp'  && '💬'}
                  {log.channel === 'email'     && '✉️'}
                  {log.channel === 'telephone' && '📞'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-700 capitalize">{log.channel}</span>
                    <StatusPill status={log.status} />
                    {log.lead_id && (
                      <span className="text-[10px] text-emerald-600 flex items-center gap-0.5">
                        <CheckCircle2 size={10} /> Lead #{log.lead_id}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-gray-400 truncate mt-0.5">
                    {log.channel_ref_id || '—'}
                    {log.error_message && ` · ${log.error_message}`}
                  </p>
                </div>
                <span className="text-[11px] text-gray-400 flex-shrink-0">
                  {log.created_at ? new Date(log.created_at).toLocaleString('en-IN', {
                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                  }) : '—'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
