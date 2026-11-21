import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { platformApi, type ApiKeyRow, type ApiVersionRow, type Paged, type PlanRateLimit, type RateLimitsOverview } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol, type GridServer } from '@/components/platform/BwGrid'
import { copyText, Bar, Btn, BwModal, C, Empty, Field, Ic, Note, PageHead, Panel, Pill, Strip, errMsg, fd, fdt, inputCls, inputStyle, num, type Tone } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout follows the Bidwise prototype v9 Rate limits & API keys page (P.apikeys): five KPIs, Rate limits by plan + API
// versions, and the API keys grid with Rotate / Revoke. Figures are measured (usage meters, Monitoring histograms, key
// records); limits are enforced on every API-key request by the shared Redis limiter. v2 and v3 (beta) are the
// prototype's versions, shown greyed out because this backend doesn't serve them.
const KEY_TONE: Record<ApiKeyRow['status'], Tone> = { Active: 'ok', 'Rotate soon': 'wa', Revoked: 'ba' }
const VERSION_TONE: Record<ApiVersionRow['status'], Tone> = { Current: 'ok', Deprecated: 'wa', Beta: 'inf' }
const compact = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e4 ? `${Math.round(n / 1e3)} K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} K` : String(n)

function LimitInput({ value, label, min, onSave, disabled }: { value: number; label: string; min: number; onSave: (v: number) => Promise<boolean>; disabled?: boolean }) {
  const [v, setV] = useState(String(value))
  const [busy, setBusy] = useState(false)
  useEffect(() => setV(String(value)), [value])
  const commit = async () => {
    const n = Number(v)
    if (v.trim() === '' || n === value) { setV(String(value)); return }
    setBusy(true)
    if (!await onSave(n)) setV(String(value))
    setBusy(false)
  }
  return <input className={`${inputCls} sm`} style={{ ...inputStyle, width: 90 }} type="number" min={min} step={1} aria-label={label} value={v} disabled={disabled || busy}
    onChange={e => setV(e.target.value)} onBlur={() => void commit()}
    onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setV(String(value)); e.currentTarget.blur() } }} />
}

function KeyShown({ title, raw, lines, onClose }: { title: string; raw: string; lines: string[]; onClose: () => void }) {
  const { success, error: showError } = useToast()
  const copy = async () => { if (await copyText(raw)) success('Key copied'); else showError('Copy failed – select the key and copy it') }
  return <BwModal title={title} width={560} onClose={onClose} foot={<Btn p onClick={onClose}>Done</Btn>}>
    <Note className="mb-2">Copy the key now – only a hash is stored, so it can't be shown again.</Note>
    <div className="flex gap-2"><input readOnly autoComplete="off" className={`${inputCls} font-mono`} style={inputStyle} value={raw} onFocus={e => e.target.select()} /><Btn onClick={() => void copy()}><Ic n="copy" /> Copy</Btn></div>
    {lines.map(l => <div key={l} className="mt-1.5 text-xs" style={{ color: C.mu }}>{l}</div>)}
  </BwModal>
}

function VersionModal({ v, onClose, onSaved }: { v: ApiVersionRow; onClose: () => void; onSaved: () => void }) {
  const { success, error: showError } = useToast()
  const [status, setStatus] = useState(v.status)
  const [sunset, setSunset] = useState(v.sunset ?? '')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await platformApi.updateApiVersion(v.version, status === 'Deprecated' && sunset ? { status, sunset } : { status, clear_sunset: !sunset || status !== 'Deprecated' })
      success('API version saved', status === 'Deprecated' ? `${v.version} keeps working; responses carry Deprecation${sunset ? ' and Sunset' : ''} headers` : undefined)
      onSaved()
    } catch (err) { showError(errMsg(err, 'Unable to save the API version')) } finally { setBusy(false) }
  }
  return <BwModal title={`API ${v.version}`} width={420} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
    <div className="grid gap-2">
      <Field label="Status"><select className={inputCls} style={inputStyle} value={status} onChange={e => setStatus(e.target.value as ApiVersionRow['status'])}>
        <option>Current</option><option>Deprecated</option><option>Beta</option></select></Field>
      {status === 'Deprecated' && <Field label="Sunset (optional)"><input className={inputCls} style={inputStyle} type="date" value={sunset} min={new Date().toISOString().slice(0, 10)} onChange={e => setSunset(e.target.value)} /></Field>}
      <Note info>Deprecating never switches a version off – clients are warned through response headers until you retire it.</Note>
    </div>
  </BwModal>
}

export default function PlatformRateLimitsPage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<RateLimitsOverview | null>(null)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<Paged<ApiKeyRow> | null>(null)
  const [query, setQuery] = useState({ q: '', status: '', sort: '', offset: 0, limit: 25 })
  const [rotating, setRotating] = useState<ApiKeyRow | null>(null)
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null)
  const [reason, setReason] = useState('')
  const [issued, setIssued] = useState<{ raw: string; lines: string[] } | null>(null)
  const [editVersion, setEditVersion] = useState<ApiVersionRow | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try { const { data: next } = await platformApi.rateLimits(); setData(next); setError('') } catch (err) { setError(errMsg(err, 'Rate limits & API keys unavailable')) }
  }, [])
  const loadRows = useCallback(async () => {
    try { const { data: next } = await platformApi.apiKeys(query.q, query.status, query.sort, query.offset, query.limit); setRows(next) }
    catch (err) { showError(errMsg(err, 'Unable to load API keys')) }
  }, [query, showError])
  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadRows() }, [loadRows])
  const canManage = can('tenants', 'manage')
  const canPlatform = canManage && !!data?.all_scope

  const saveLimit = async (p: PlanRateLimit, change: Partial<Pick<PlanRateLimit, 'per_minute' | 'burst'>>) => {
    const [k, v] = Object.entries(change)[0] as [string, number]
    if (!Number.isInteger(v) || v < 1) { showError(`${k === 'burst' ? 'Burst' : 'Requests / min'} must be a whole number of at least 1`); return false }
    try {
      const { data: r } = await platformApi.updatePlanRateLimit(p.plan_id, change)
      setData(d => d && { ...d, plans: d.plans.map(x => x.plan_id === p.plan_id ? r.plan : x) })
      if (r.changed) success('Limit saved', `${p.plan}: ${num(r.plan.per_minute)}/min, burst ${num(r.plan.burst)} – applies to every API worker within ${r.applies_within_seconds} s`)
      return true
    } catch (err) { showError(errMsg(err, 'Unable to save the limit')); return false }
  }
  const rotate = async () => {
    if (!rotating) return
    setBusy(true)
    try {
      const { data: r } = await platformApi.rotateApiKey(rotating.id)
      setRotating(null)
      setIssued({ raw: r.key, lines: [`${r.new.name} · ${r.new.tenant} · scopes ${r.new.scopes.join(', ')}`,
        r.overlap_hours ? `The old key (${r.old.key}) works for ${r.overlap_hours} more hour${r.overlap_hours === 1 ? '' : 's'} – until ${fdt(r.old.expires_at)}.` : 'The old key stopped working now (no overlap configured).'] })
      success('New key issued', r.overlap_hours ? `The old one works for ${r.overlap_hours} more hours` : 'The old one stopped working')
      void loadRows(); void load()
    } catch (err) { showError(errMsg(err, 'Unable to rotate the key')) } finally { setBusy(false) }
  }
  const revoke = async () => {
    if (!revoking) return
    setBusy(true)
    try {
      await platformApi.revokeApiKey(revoking.id, reason)
      success('Key revoked', `${revoking.key} stopped working immediately`)
      setRevoking(null); setReason('')
      void loadRows(); void load()
    } catch (err) { showError(errMsg(err, 'Unable to revoke the key')) } finally { setBusy(false) }
  }

  const cols: GridCol<ApiKeyRow>[] = [
    { k: 't', t: 'Tenant', w: 210, sv: r => r.tenant ?? '', txt: r => r.tenant ?? '', fn: r => <span title={r.name}>{r.tenant}<br /><small style={{ color: C.mu }}>{r.name}</small></span> },
    { k: 'key', t: 'Key', w: 230, txt: r => r.key, fn: r => <code className="font-mono text-xs">{r.key}</code> },
    { k: 'sc', t: 'Scopes', w: 120, txt: r => r.scopes.join(', ') },
    { k: 'cr', t: 'Created', w: 110, date: true, sv: r => r.created, txt: r => fd(r.created), fn: r => <span title={r.created_by ? `by ${r.created_by}` : undefined}>{fd(r.created)}</span> },
    { k: 'last', t: 'Last used', w: 110, date: true, sv: r => r.last_used, txt: r => r.last_used ? fd(r.last_used) : 'Never',
      fn: r => r.last_used ? <span title={fdt(r.last_used)}>{fd(r.last_used)}</span> : <span style={{ color: C.mu }}>Never</span> },
    { k: 'st', t: 'Status', w: 110, txt: r => r.status, fn: r => <Pill t={KEY_TONE[r.status]} title={r.status === 'Revoked' ? (r.revoked_at ? `Revoked ${fdt(r.revoked_at)}${r.revoked_by ? ` by ${r.revoked_by}` : ''}` : `Replaced – stopped working ${fdt(r.expires_at)}`)
      : r.expires_at ? `Replaced by rotation – works until ${fdt(r.expires_at)}` : r.status === 'Rotate soon' ? `Older than ${data?.rotate_after_days ?? 90} days` : undefined}>{r.status}</Pill> },
    { k: 'x', t: 'Actions', w: 170, txt: () => '', fn: r => <span className="flex gap-1" onClick={e => e.stopPropagation()}>
      <Btn s disabled={!canManage || r.status === 'Revoked' || r.replaced_by_id != null} title={r.replaced_by_id != null ? 'Already rotated – rotate its replacement' : undefined} onClick={() => setRotating(r)}>Rotate</Btn>
      <Btn s d disabled={!canManage || r.status === 'Revoked'} onClick={() => { setReason(''); setRevoking(r) }}>Revoke</Btn></span> },
  ]
  const server: GridServer = {
    total: rows?.total ?? 0,
    onChange: useCallback(s => {
      const sort = s.sorts.map(([k, d]) => `${k}:${d}`).join(',')
      setQuery(x => x.offset === s.offset && x.limit === s.limit && x.sort === sort ? x : { ...x, offset: s.offset, limit: s.limit, sort })
    }, []),
  }
  const onQuery = useCallback((s: { q: string }) => setQuery(x => x.q === s.q ? x : { ...x, q: s.q, offset: 0 }), [])

  const k = data?.kpis
  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <PageHead crumb="Platform admin" title="Rate limits & API keys" />
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}
    {k && <Strip items={[
      { l: 'API calls · 24 h', kpi: 'apikeys.api_calls', v: compact(k.api_calls_24h), sp: k.api_spark, title: `${num(k.api_calls_24h)} tenant API requests; sparkline = daily totals, last 7 days` },
      { l: 'Throttled requests', kpi: 'apikeys.throttled', v: k.throttled_pct == null ? '—' : `${k.throttled_pct}%`, d: k.throttled_pct == null ? 'no API calls' : undefined,
        title: `${num(k.throttled_requests)} API-key request(s) refused with 429 · 24 h` },
      { l: 'Active keys', kpi: 'apikeys.active', v: k.active_keys },
      { l: 'Keys older than 90 d', kpi: 'apikeys.older_90d', v: k.keys_older_90d, dc: k.keys_older_90d ? 'twarn' : undefined },
      { l: 'p95 latency', kpi: 'apikeys.p95', v: k.p95_ms == null ? '—' : `${num(k.p95_ms)} ms`, d: k.p95_ms == null ? 'no requests measured' : undefined, title: `95th percentile response time of API requests · 24 h · ${k.p95_scope}` },
    ]} />}
    <div className="mb-2 grid gap-2 lg:grid-cols-2">
      <Panel title="Rate limits by plan" flush>
        <div className="overflow-x-auto"><table className="w-full text-left" style={{ minWidth: 420 }}>
          <thead><tr><th>Plan</th><th>Requests / min</th><th>Burst</th><th className="text-right">Daily cap</th></tr></thead>
          <tbody>{!data ? <tr><td colSpan={4} className="!p-0"><Empty>{error || 'Loading…'}</Empty></td></tr>
            : !data.plans.length ? <tr><td colSpan={4} className="!p-0"><Empty>No active plans.</Empty></td></tr>
              : data.plans.map(p => <tr key={p.plan_id} title={p.updated_by ? `Set by ${p.updated_by}${p.updated_at ? ` · ${fdt(p.updated_at)}` : ''}` : undefined}>
                <td><b>{p.plan}</b></td>
                <td><LimitInput value={p.per_minute} min={1} label={`${p.plan} requests per minute`} disabled={!canPlatform} onSave={v => saveLimit(p, { per_minute: v })} /></td>
                <td><LimitInput value={p.burst} min={1} label={`${p.plan} burst`} disabled={!canPlatform} onSave={v => saveLimit(p, { burst: v })} /></td>
                <td className="text-right tabular-nums">{p.daily_cap ? p.daily_cap.toLocaleString('en-IN') : <span style={{ color: C.mu }}>No cap</span>}</td>
              </tr>)}</tbody>
        </table></div>
      </Panel>
      <Panel title="API versions" flush>
        <div className="overflow-x-auto"><table className="w-full text-left" style={{ minWidth: 380 }}>
          <thead><tr><th>Version</th><th>Status</th><th>Sunset</th><th>Traffic</th></tr></thead>
          <tbody>{!data ? <tr><td colSpan={4} className="!p-0"><Empty>{error || 'Loading…'}</Empty></td></tr>
            : data.versions.map(v => v.implemented
              ? <tr key={v.version} className={canPlatform ? 'cursor-pointer' : undefined} onClick={canPlatform ? () => setEditVersion(v) : undefined}
                title={`${num(v.requests)} request(s) in the last 7 days${canPlatform ? ' · click to change status or sunset' : ''}`}>
                <td><b>{v.version}</b></td><td><Pill t={VERSION_TONE[v.status]}>{v.status}</Pill></td><td>{v.sunset ? fd(v.sunset) : '—'}</td>
                <td style={{ minWidth: 120 }}>{v.traffic == null ? <span style={{ color: C.mu }}>—</span> : <Bar value={v.traffic} tone={C.ac} />}</td></tr>
              : <tr key={v.version} style={{ opacity: .55 }} title="Prototype entry – this version is not implemented by the backend">
                <td><b>{v.version}</b></td><td><Pill t="mu">Not implemented</Pill></td><td>—</td><td><span style={{ color: C.mu }}>—</span></td></tr>)}</tbody>
        </table></div>
      </Panel>
    </div>
    <Panel title="API keys" flush>
      <BwGrid id="api-keys" cols={cols} rows={rows?.items ?? []} rid={r => String(r.id)} server={server} onQuery={onQuery}
        empty={rows ? 'No API keys. Create one in API & Webhooks.' : 'Loading…'} />
    </Panel>

    {rotating && <BwModal title="Rotate API key" width={460} onClose={() => setRotating(null)} foot={<>
      <Btn onClick={() => setRotating(null)}>Cancel</Btn><Btn p disabled={busy} onClick={() => void rotate()}>{busy ? 'Rotating…' : 'Issue new key'}</Btn></>}>
      <p>A new key is issued for <b>{rotating.tenant}</b> ({rotating.name}, scopes {rotating.scopes.join(', ')}).</p>
      <p className="mt-1.5" style={{ color: C.mu }}>{data?.overlap_hours ? `The current key ${rotating.key} keeps working for ${data.overlap_hours} more hours, then stops.` : `The current key ${rotating.key} stops working immediately.`} The overlap is set in Control Center → Rate limiting &amp; API.</p>
    </BwModal>}
    {revoking && <BwModal title="Revoke API key?" width={460} onClose={() => setRevoking(null)} foot={<>
      <Btn onClick={() => setRevoking(null)}>Cancel</Btn><Btn d disabled={busy} onClick={() => void revoke()}>{busy ? 'Revoking…' : 'Revoke key'}</Btn></>}>
      <p><code className="font-mono text-xs">{revoking.key}</code> of <b>{revoking.tenant}</b> stops working immediately. Integrations using it will get 401 errors. This can't be undone.</p>
      <div className="mt-2"><Field label="Reason (optional, kept in the audit trail)"><input className={inputCls} style={inputStyle} value={reason} maxLength={300} onChange={e => setReason(e.target.value)} /></Field></div>
    </BwModal>}
    {issued && <KeyShown title="New API key issued" raw={issued.raw} lines={issued.lines} onClose={() => setIssued(null)} />}
    {editVersion && <VersionModal v={editVersion} onClose={() => setEditVersion(null)} onSaved={() => { setEditVersion(null); void load() }} />}
  </div>
}
