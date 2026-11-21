import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { platformApi, type UsageMeterKey, type UsageMonitoring, type UsagePeriod, type UsageTenantRow } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { Btn, BwModal, C, Empty, Field, Ic, Kv, Note, Panel, Pill, Strip, errMsg, inputCls, inputStyle, num, useKpiPopup, type Tone } from '@/components/platform/bw'
import { HBars, LineChart, PAL } from '@/components/platform/charts'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout, KPIs, panels, chips, columns and bulk actions follow the Bidwise prototype Usage monitoring page (P.usage).
// Values come from hourly meters and the tenants' own databases; nothing is estimated on this page.
const PERIODS: UsagePeriod[] = ['24h', '7d', '30d', '90d']
const REFRESH_MS = 60_000
const compact = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(1)} M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)} K` : num(v)
const gbText = (v: number) => v >= 1 ? `${v.toFixed(2)} GB` : `${Math.round(v * 1024)} MB`
const METERS: Record<UsageMeterKey, { label: string; f: (v: number) => string; metered?: boolean }> = {
  api: { label: 'API calls', f: compact, metered: true },
  dau: { label: 'Active users', f: v => num(v) },
  rec: { label: 'Records created', f: compact },
  em: { label: 'Emails sent', f: compact, metered: true },
  ai: { label: 'AI queries', f: compact, metered: true },
  gb: { label: 'Storage', f: gbText, metered: true },
  ocr: { label: 'OCR pages', f: compact },
}
const METER_KPI: Record<Exclude<UsageMeterKey, 'ocr'>, string> = { api: 'usage.api_calls', dau: 'usage.dau', rec: 'usage.records', em: 'usage.emails', ai: 'usage.ai_queries', gb: 'usage.storage' }
const STATUS_TONE: Record<string, Tone> = { Healthy: 'ok', 'Near limit': 'wa', 'Over limit': 'ba' }
const rid = (r: UsageTenantRow) => String(r.id)  // stable: BwGrid re-validates its selection whenever rid changes
const sum = (rows: UsageTenantRow[], k: UsageMeterKey) => rows.some(r => r.values[k] != null) ? rows.reduce((a, r) => a + (r.values[k] ?? 0), 0) : null

// Prototype bar(v, colour): 60 px bar and percentage.
function UsageBar({ pct, warn, text, title }: { pct: number | null; warn: number; text?: ReactNode; title?: string }) {
  if (pct == null) return <span title={title} style={{ color: C.mu }}>{text ?? '—'}</span>
  const tone = pct > 100 ? C.ba : pct >= warn ? C.wa : C.ac
  return <span className="inline-flex items-center whitespace-nowrap" title={title}>
    <span className="mr-[5px] inline-block h-1.5 w-[60px] overflow-hidden rounded-md align-middle" style={{ background: C.ln2 }}><i className="block h-full" style={{ width: `${Math.min(100, pct)}%`, background: tone }} /></span>
    {Math.round(pct)}%{text != null && <small className="ml-1 text-[11px]" style={{ color: C.mu }}>{text}</small>}
  </span>
}

const limitTitle = (label: string, l: UsageTenantRow['limits']['users'], unit = '') => l.limit
  ? `${label}: ${num(l.used)}${unit} used of ${num(l.limit)}${unit} · ${num(l.remaining)}${unit} remaining · limit from ${l.source}`
  : `${label}: no limit configured`

type BulkKind = 'notify' | 'raise' | 'upsell'

function BulkModal({ kind, rows, onClose, onDone }: { kind: BulkKind; rows: UsageTenantRow[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { success, error: showError } = useToast()
  const names = rows.map(r => r.name).join(', ')
  const usageLine = (r: UsageTenantRow) => `${r.name}: seats ${r.limits.users.percent ?? '—'}% · storage ${r.limits.storage.percent ?? '—'}%`
  const [title, setTitle] = useState(kind === 'upsell' ? 'Room to grow on a larger plan' : 'Usage update from your platform team')
  const [message, setMessage] = useState(kind === 'upsell'
    ? 'Your workspace is using most of its plan allowance. Upgrading adds more user seats and storage, so your team can keep growing without interruption. Reply to this notice or contact your account manager to upgrade.'
    : 'Your workspace is approaching its plan limits. Please review user seats and stored documents, or contact us to raise your limits.')
  const [seats, setSeats] = useState('')
  const [storage, setStorage] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string[] | null>(null)

  const raise = async () => {
    const newSeats = seats ? Number(seats) : null, newStorage = storage ? Number(storage) : null
    if (newSeats == null && newStorage == null) return showError('Enter a new seat limit or storage limit')
    for (const r of rows) {
      if (newSeats != null && (!Number.isInteger(newSeats) || newSeats < (r.limits.users.limit ?? 0) || newSeats < (r.limits.users.used ?? 0))) return showError(`${r.name}: seat limit must be a whole number of at least ${Math.max(r.limits.users.limit ?? 0, r.limits.users.used ?? 0)}`)
      if (newStorage != null && (!Number.isInteger(newStorage) || newStorage < (r.limits.storage.limit ?? 0) || newStorage < (r.limits.storage.used ?? 0))) return showError(`${r.name}: storage limit must be at least ${Math.ceil(Math.max(r.limits.storage.limit ?? 0, r.limits.storage.used ?? 0))} MB`)
    }
    const res = await Promise.allSettled(rows.map(r => platformApi.updateTenant(r.id, { ...(newSeats != null ? { max_users: newSeats } : {}), ...(newStorage != null ? { storage_limit_mb: newStorage } : {}) })))
    const failed = res.filter(x => x.status === 'rejected').length
    if (failed) showError(`${failed} tenant(s) could not be updated`); else success(`Limits raised for ${rows.length} tenant(s)`)
    await onDone(); onClose()
  }
  const announce = async () => {
    if (!title.trim() || !message.trim()) return showError('Enter a title and a message')
    const { data } = await platformApi.sendAnnouncement(rows.map(r => r.id), title.trim(), message.trim())
    setResult(data.results.map(r => r.error ? `${r.tenant}: failed` : `${r.tenant}: ${r.recipients} users notified`))
    success(kind === 'upsell' ? 'Upsell offer sent' : 'Tenants notified')
  }
  const run = async () => {
    setBusy(true)
    try { await (kind === 'raise' ? raise() : announce()) } catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy(false) }
  }
  const heading = { notify: 'Notify tenants', raise: 'Raise limit', upsell: 'Upsell offer' }[kind]
  return <BwModal title={`${heading} · ${rows.length} tenant${rows.length === 1 ? '' : 's'}`} width={560} onClose={onClose}
    foot={<><Btn onClick={onClose}>{result ? 'Close' : 'Cancel'}</Btn>{!result && <Btn p disabled={busy} onClick={() => void run()}>{busy ? 'Working…' : kind === 'raise' ? 'Raise limits' : 'Send'}</Btn>}</>}>
    {kind === 'raise' ? <div className="space-y-2.5">
      <div className="text-xs" style={{ color: C.mu }}>{rows.map(r => <div key={r.id}>{r.name}: seats {num(r.limits.users.used)} / {num(r.limits.users.limit)} · storage {num(r.limits.storage.used)} / {num(r.limits.storage.limit)} MB</div>)}</div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Field label="New user-seat limit"><input type="number" min={1} className={inputCls} style={inputStyle} value={seats} onChange={e => setSeats(e.target.value)} placeholder="unchanged" /></Field>
        <Field label="New storage limit (MB)"><input type="number" min={1} className={inputCls} style={inputStyle} value={storage} onChange={e => setStorage(e.target.value)} placeholder="unchanged" /></Field>
      </div>
      <Note info>Sets the tenant-specific limits (they override the plan’s seat count). Limits can only be raised here, never below current usage.</Note>
    </div> : <div className="space-y-2.5">
      <p>An in-app notice goes to every active user of {names}.</p>
      <div className="text-xs" style={{ color: C.mu }}>{rows.map(r => <div key={r.id}>{usageLine(r)}</div>)}</div>
      <Field label="Title"><input className={inputCls} style={inputStyle} value={title} maxLength={200} onChange={e => setTitle(e.target.value)} /></Field>
      <Field label="Message"><textarea className="w-full rounded-md border px-2 py-1 text-[13px]" rows={4} style={inputStyle} value={message} onChange={e => setMessage(e.target.value)} /></Field>
      {result && <Note info>{result.map(l => <div key={l}>{l}</div>)}</Note>}
    </div>}
  </BwModal>
}

export default function PlatformUsageMonitoringPage() {
  const navigate = useNavigate()
  const { can } = usePlatformAccess()
  const canManage = can('tenants', 'manage')
  const { error: showError } = useToast()
  const [period, setPeriod] = useState<UsagePeriod>('30d')
  const [tenantFilter, setTenantFilter] = useState('all')
  const [meter, setMeter] = useState<UsageMeterKey>('api')
  const [data, setData] = useState<UsageMonitoring | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [bulk, setBulk] = useState<{ kind: BulkKind; rows: UsageTenantRow[] } | null>(null)
  const [openKpi, kpiPopup] = useKpiPopup()

  const seq = useRef(0)
  const load = useCallback(async (refresh = false) => {
    const mine = ++seq.current
    setLoading(true)
    try { const { data: next } = await platformApi.usageMonitoring(period, refresh); if (mine === seq.current) { setData(next); setError('') } }
    catch (err) { if (mine === seq.current) setError(errMsg(err, 'Usage data unavailable')) }
    finally { if (mine === seq.current) setLoading(false) }
  }, [period])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const all = data?.tenants ?? []
  const U = useMemo(() => all.filter(r => tenantFilter === 'all' || String(r.id) === tenantFilter), [all, tenantFilter])
  const warn = data?.warn_percent ?? 80
  const trendOf = (k: UsageMeterKey) => {
    const series = U.map(r => r.trend[k]).filter((s): s is (number | null)[] => !!s)
    if (!series.length) return null
    return series[0].map((_, i) => series.some(s => s[i] != null) ? Math.round(series.reduce((a, s) => a + (s[i] ?? 0), 0) * 1000) / 1000 : null)
  }
  const apiNow = sum(U, 'api'), apiPrev = U.reduce((a, r) => a + r.api_previous, 0)
  const apiDelta = data?.previous_complete && apiPrev > 0 && apiNow != null ? Math.round((apiNow - apiPrev) / apiPrev * 100) : null
  const unavailable = U.filter(r => !r.available)
  const partial = (k: UsageMeterKey) => unavailable.length && ['dau', 'rec'].includes(k) ? `${unavailable.length} tenant database(s) unavailable` : undefined
  const kpi = (k: UsageMeterKey, f: (v: number) => string) => { const v = sum(U, k); return v == null ? '—' : f(v) }
  const sinceText = data?.collecting_since ? new Date(data.collecting_since * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null
  // Meters that began inside the selected period say so, so a low count is not read as the whole period.
  const periodMs = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }[period] * 86400_000
  const sinceDate = data?.collecting_since ? new Date(data.collecting_since * 1000) : null
  const meteredHint = sinceDate && sinceDate.getTime() > Date.now() - periodMs
    ? `since ${sinceDate.toDateString() === new Date().toDateString() ? sinceDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : sinceDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}` : undefined
  const lastSignIn = U.reduce<string | null>((a, r) => r.last_sign_in && (!a || r.last_sign_in > a) ? r.last_sign_in : a, null)
  const dauHint = sum(U, 'dau') === 0 && lastSignIn ? `last ${new Date(lastSignIn).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}` : undefined
  const activeTitle = period === '24h' ? 'Distinct users with a session active in the last 24 hours' : `Distinct users with a session active in the last ${period}`

  const go = (id: number) => navigate(`/platform/tenants/${id}`)
  const kq = tenantFilter === 'all' ? undefined : { tenant_id: Number(tenantFilter) }  // the popup keeps the page's tenant filter
  const anomalyAction = (a: UsageMonitoring['anomalies'][number]) => {
    const row = all.find(r => r.id === a.tenant_id)
    const label = { investigate: 'Investigate', notify: 'Notify admin', files: 'View files', contact: 'Contact', case: 'Open case' }[a.kind]
    const onClick = () => {
      if (a.kind === 'notify') { if (!canManage) return showError('Your platform role can’t notify tenants'); if (row) setBulk({ kind: 'notify', rows: [row] }) }
      else if (a.kind === 'contact' && row?.admin_email) window.location.href = `mailto:${row.admin_email}`
      else go(a.tenant_id)
    }
    return <button type="button" className="text-xs font-medium hover:underline" style={{ color: C.ac }} onClick={onClick}>{label}</button>
  }

  const exportCsv = () => {
    const head = ['Tenant', 'Plan', 'Active users', 'Seat limit', 'Seats %', 'API calls', 'Records created', 'Emails sent', 'AI queries', 'AI quota', 'Storage MB', 'Storage limit MB', 'Storage %', 'Status', 'Measured at']
    const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const lines = U.map(r => [r.name, r.plan, r.limits.users.used, r.limits.users.limit, r.limits.users.percent, r.values.api, r.values.rec, r.values.em, r.values.ai, r.limits.ai.limit, r.limits.storage.used, r.limits.storage.limit, r.limits.storage.percent, r.usage_status, r.measured_at].map(cell).join(','))
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `usage-${period}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href)
  }

  const cols: GridCol<UsageTenantRow>[] = [
    { k: 'n', t: 'Tenant', w: 210, sv: r => r.name, txt: r => r.name, fn: r => <b style={{ color: C.ac }}>{r.name}</b> },
    { k: 'plan', t: 'Plan', sv: r => r.plan ?? '', txt: r => r.plan ?? '—' },
    { k: 'u', t: 'Users', w: 150, sv: r => r.limits.users.percent ?? -1, txt: r => `${r.limits.users.used ?? '—'}/${r.limits.users.limit ?? '—'}`,
      fn: r => <UsageBar pct={r.limits.users.percent} warn={warn} text={`${r.limits.users.used ?? '—'}/${r.limits.users.limit ?? '—'}`} title={r.available ? limitTitle('Seats', r.limits.users) : r.error ?? undefined} /> },
    { k: 'a', t: 'API calls', w: 130, sv: r => r.values.api ?? -1, txt: r => String(r.values.api ?? ''), fn: r => <UsageBar pct={null} warn={warn} text={compact(r.values.api ?? 0)} title={`${num(r.values.api)} API calls in ${period} · no API quota configured`} /> },
    { k: 'g', t: 'Storage', w: 130, sv: r => r.limits.storage.percent ?? -1, txt: r => `${r.limits.storage.percent ?? ''}`, fn: r => <UsageBar pct={r.limits.storage.percent} warn={warn} title={limitTitle('Document storage', r.limits.storage, ' MB')} /> },
    { k: 'ai', t: 'AI', w: 110, sv: r => r.limits.ai.percent ?? -1, txt: r => `${r.limits.ai.percent ?? ''}`, fn: r => <UsageBar pct={r.limits.ai.percent} warn={warn} title={`${limitTitle('AI queries (rolling 30 days)', r.limits.ai)} · not enforced`} /> },
    { k: 'em', t: 'Email', w: 110, sv: r => r.values.em ?? -1, txt: r => String(r.values.em ?? ''), fn: r => <UsageBar pct={null} warn={warn} text={compact(r.values.em ?? 0)} title={`${num(r.values.em)} e-mails in ${period} · no e-mail quota configured`} /> },
    { k: 's', t: 'Status', w: 110, sv: r => r.ratio ?? -1, txt: r => r.usage_status ?? '—', fn: r => r.usage_status ? <Pill t={STATUS_TONE[r.usage_status]}>{r.usage_status}</Pill> : <Pill t="mu" title={r.error ?? undefined}>Unknown</Pill> },
  ]
  const forBulk = (kind: BulkKind) => (rows: UsageTenantRow[]) => {
    if (!canManage) return showError('Your platform role can’t change tenants')
    if (!rows.length) return showError('Select at least one tenant')
    setBulk({ kind, rows })
  }

  const m = METERS[meter]
  const bars = U.map(r => ({ id: r.id, name: r.name, l: `${r.slug.toUpperCase()} · ${r.name.slice(0, 14)}`, v: r.values[meter], note: r.error })).sort((a, b) => (b.v ?? -1) - (a.v ?? -1))
  const trend = trendOf(meter)
  const trendLabels = Array.from({ length: 15 }, (_, i) => i % 3 === 0 ? `D-${30 - i * 2}` : '')

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    {kpiPopup}
    {bulk && <BulkModal kind={bulk.kind} rows={bulk.rows} onClose={() => setBulk(null)} onDone={() => load(true)} />}
    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      <div><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Data &amp; infrastructure</div><h1 className="text-xl font-semibold">Usage monitoring</h1></div>
      <Pill t={error ? 'wa' : 'ok'} title={data ? `Updated ${new Date(data.generated_at).toLocaleTimeString()}${sinceText ? ` · meters collecting since ${sinceText}` : ''} · refreshes every minute` : undefined}>
        <span className={`mr-[5px] inline-block h-[7px] w-[7px] rounded-full ${loading ? '' : 'animate-pulse'}`} style={{ background: error ? C.wa : '#3DDC97' }} />{loading && data ? 'Updating…' : 'Metered hourly'}
      </Pill>
      <span className="flex-1" />
      <select className={`${inputCls} !w-[200px]`} style={inputStyle} value={tenantFilter} onChange={e => setTenantFilter(e.target.value)} aria-label="Tenant">
        <option value="all">All tenants</option>{all.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      {PERIODS.map(p => <button key={p} type="button" onClick={() => setPeriod(p)} className="inline-flex h-[22px] items-center rounded-[11px] border px-2 text-xs"
        style={p === period ? { background: C.ac, borderColor: C.ac, color: '#fff' } : { background: C.sf, borderColor: C.ln, color: C.tx }}>{p}</button>)}
      <Btn disabled={!U.length} onClick={exportCsv}><Ic n="dl" /> Export</Btn>
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}

    <Strip items={[
      { l: 'API calls', v: kpi('api', compact), sp: trendOf('api') ?? undefined, d: apiDelta != null ? `${apiDelta >= 0 ? '+' : ''}${apiDelta}%` : meteredHint, c: apiDelta != null ? (apiDelta >= 0 ? C.ok : C.wa) : undefined, kpi: 'usage.api_calls', kpiQuery: kq },
      { l: 'Active users (DAU)', v: <span title={partial('dau') ?? activeTitle}>{kpi('dau', num)}</span>, sp: trendOf('dau') ?? undefined, d: dauHint, kpi: 'usage.dau', kpiQuery: kq },
      { l: 'Records created', v: <span title={partial('rec')}>{kpi('rec', compact)}</span>, sp: trendOf('rec') ?? undefined, kpi: 'usage.records', kpiQuery: kq },
      { l: 'Emails sent', v: <span title={meteredHint ? `Metered since ${sinceText}; earlier e-mails from notification delivery logs` : undefined}>{kpi('em', compact)}</span>, kpi: 'usage.emails', kpiQuery: kq },
      { l: 'AI queries', v: kpi('ai', compact), sp: trendOf('ai') ?? undefined, d: meteredHint, kpi: 'usage.ai_queries', kpiQuery: kq },
      { l: 'Storage', v: kpi('gb', gbText), kpi: 'usage.storage', kpiQuery: kq },
      { l: 'Near / over limit', v: data ? <span style={{ color: U.some(r => r.usage_status && r.usage_status !== 'Healthy') ? C.wa : undefined }}>{U.filter(r => r.usage_status === 'Near limit' || r.usage_status === 'Over limit').length}</span> : '—', kpi: 'usage.near_limit', kpiQuery: kq },
    ]} />

    {!data ? <Panel title="Usage"><Empty>{loading ? 'Loading…' : 'Usage data unavailable'}</Empty></Panel> : <div style={{ opacity: loading ? .7 : 1 }} aria-busy={loading}>
      <div className="mb-2 grid gap-2 lg:grid-cols-2">
        <Panel title={`Usage by tenant · ${m.label}`}>
          <div className="mb-2 flex flex-wrap gap-1">{(Object.keys(METERS) as UsageMeterKey[]).map(k => <button key={k} type="button" onClick={() => setMeter(k)} className="inline-flex h-[22px] items-center rounded-[11px] border px-2 text-xs"
            style={k === meter ? { background: C.ac, borderColor: C.ac, color: '#fff' } : { background: C.sf, borderColor: C.ln, color: C.tx }}>{METERS[k].label}</button>)}</div>
          {meter === 'ocr' ? <Empty>OCR pages are not metered: no OCR service is installed on the platform</Empty>
            : !bars.length ? <Empty>No tenants</Empty>
              : <HBars lw={150} vw={84} rows={bars.map(b => ({ l: b.l, v: b.v, text: b.v == null ? 'n/a' : m.f(b.v), note: b.v == null ? (b.note || 'Not available') : null }))}
                onPick={i => openKpi({ kpi: METER_KPI[meter], title: `${m.label} · ${bars[i].name}`, value: bars[i].v == null ? '—' : m.f(bars[i].v!), query: { tenant_id: bars[i].id } })} />}
        </Panel>
        <Panel title="Trend · last 30 days">
          {meter === 'ocr' || !trend ? <Empty>{meter === 'ocr' ? 'OCR pages are not metered' : 'No data for this meter'}</Empty> : <>
            <LineChart h={170} series={[{ n: m.label, c: PAL[0], v: trend }]} labels={trendLabels} f={v => meter === 'gb' ? v.toFixed(2) : v < 10 ? v.toFixed(1) : String(Math.round(v))} />
            {m.metered && sinceText && data.collecting_since! * 1000 > Date.now() - 30 * 86400_000 && <small className="block text-[11px]" style={{ color: C.mu }}>Metering since {sinceText} – earlier days have no data yet</small>}
          </>}
        </Panel>
      </div>

      <div className="mb-2 grid gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title="Tenant usage vs plan limits" flush>
          <BwGrid id="usage-limits" cols={cols} rows={U} rid={rid} onRow={r => go(r.id)} empty="No tenants"
            bulk={[['Notify tenants', forBulk('notify')], ['Raise limit', forBulk('raise')], ['Upsell offer', forBulk('upsell')]]} />
        </Panel>
        <Panel title="Anomalies & alerts" flush>
          {data.anomalies.filter(a => tenantFilter === 'all' || String(a.tenant_id) === tenantFilter).length ? <div>{data.anomalies.filter(a => tenantFilter === 'all' || String(a.tenant_id) === tenantFilter).map((a, i) =>
            <div key={i} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}><Pill t="wa">Warning</Pill><span className="flex-1">{a.text}</span>{anomalyAction(a)}</div>)}</div>
            : <Empty>No anomalies detected</Empty>}
        </Panel>
      </div>

      <Panel title="Metering rules"><Kv rows={data.rules} /></Panel>
    </div>}
  </div>
}
