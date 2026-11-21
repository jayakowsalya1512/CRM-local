import { useCallback, useEffect, useState } from 'react'
import { platformApi, type ApiWebhooksOverview, type CreatedApiKey, type TenantUserRow } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { copyText, Btn, BwModal, C, Empty, Field, Ic, Note, Panel, Pill, Strip, Table, errMsg, inputCls, inputStyle, num, type Tone } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout follows the Bidwise prototype API & webhooks page (P.papi): four KPI cards, Rate-limit policy and Recent webhook
// deliveries side by side, and + Create key. All figures are real: tenant API traffic, per-plan API-key limits, delivery log.
const STATUS_TONE: Record<string, Tone> = { Done: 'ok', Failed: 'ba', Retrying: 'wa', Pending: 'mu' }
const compact = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e4 ? `${Math.round(n / 1e3)} K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} K` : String(n)

function CreateKeyModal({ data, onClose }: { data: ApiWebhooksOverview; onClose: () => void }) {
  const { error: showError, success } = useToast()
  const [tenant, setTenant] = useState(String(data.tenants[0]?.id ?? ''))
  const [users, setUsers] = useState<TenantUserRow[] | null>(null)
  const [usersErr, setUsersErr] = useState('')
  const [user, setUser] = useState('')
  const [name, setName] = useState('')
  const [write, setWrite] = useState(true)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  useEffect(() => {
    if (!tenant) return
    setUsers(null); setUsersErr('')
    platformApi.tenantUsers(Number(tenant)).then(r => { const a = r.data.filter(u => u.is_active); setUsers(a); setUser(String(a[0]?.id ?? '')) })
      .catch(e => { setUsers([]); setUsersErr(errMsg(e, 'Users unavailable')) })
  }, [tenant])
  const create = async () => {
    setBusy(true)
    try { const { data: k } = await platformApi.createApiKey({ tenant_id: Number(tenant), user_id: Number(user), name, scopes: write ? ['read', 'write'] : ['read'] }); setCreated(k) }
    catch (e) { showError(errMsg(e, 'Unable to create the key')) } finally { setBusy(false) }
  }
  const copy = async () => { if (await copyText(created!.key)) success('Key copied'); else showError('Copy failed – select the key and copy it') }
  if (created) return <BwModal title="API key created" width={560} onClose={onClose} foot={<Btn p onClick={onClose}>Done</Btn>}>
    <Note className="mb-2">Copy the key now – only a hash is stored, so it can't be shown again.</Note>
    <div className="flex gap-2"><input readOnly className={`${inputCls} font-mono`} style={inputStyle} value={created.key} onFocus={e => e.target.select()} /><Btn onClick={() => void copy()}><Ic n="copy" /> Copy</Btn></div>
    <div className="mt-2 text-xs" style={{ color: C.mu }}>{created.name} · {created.tenant} · signs in as user #{created.user_id} · scopes {created.scopes.join(', ')} · limited to {created.rate_limit.per_minute} requests/min, burst {created.rate_limit.burst}{created.rate_limit.daily_cap ? `, ${created.rate_limit.daily_cap.toLocaleString('en-IN')} a day` : ''}.
      Send it as <span className="font-mono">Authorization: Bearer &lt;key&gt;</span> with the tenant&apos;s <span className="font-mono">X-Tenant-Slug</span>.</div>
  </BwModal>
  return <BwModal title="Create API key" width={480} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn>
    <Btn p disabled={busy || !tenant || !user || !name.trim()} onClick={() => void create()}>{busy ? 'Creating…' : 'Create key'}</Btn></>}>
    <div className="grid gap-2">
      <Field label="Tenant"><select className={inputCls} style={inputStyle} value={tenant} onChange={e => setTenant(e.target.value)}>{data.tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
      <Field label="Signs in as"><select className={inputCls} style={inputStyle} value={user} disabled={!users?.length} onChange={e => setUser(e.target.value)}>
        {users === null ? <option>Loading…</option> : !users.length ? <option value="">{usersErr || 'No active users'}</option>
          : users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email}) · {u.role}</option>)}</select></Field>
      <Field label="Key name"><input className={inputCls} style={inputStyle} value={name} maxLength={120} placeholder="e.g. ERP integration" onChange={e => setName(e.target.value)} /></Field>
      <Field label="Scopes"><div className="flex gap-3">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked disabled /> read</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={write} onChange={e => setWrite(e.target.checked)} /> write</label></div></Field>
    </div>
  </BwModal>
}

export default function PlatformApiWebhooksPage() {
  const { can } = usePlatformAccess()
  const { error: showError } = useToast()
  const [data, setData] = useState<ApiWebhooksOverview | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState(false)
  const load = useCallback(async () => {
    try { const { data: next } = await platformApi.apiWebhooks(); setData(next); setError('') }
    catch (err) { setError(errMsg(err, 'API & webhooks unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])
  const page = async (offset: number) => {
    try { const { data: d } = await platformApi.webhookDeliveries(offset); setData(x => x && { ...x, deliveries: d }) } catch (err) { showError(errMsg(err, 'Unable to load deliveries')) }
  }
  const k = data?.kpis
  const d = data?.deliveries

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2 flex flex-wrap items-end gap-2">
      <div className="flex-1"><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Platform admin</div><h1 className="text-xl font-semibold">API &amp; webhooks</h1></div>
      <Btn p disabled={!data || !can('tenants', 'manage') || !data.tenants.length} onClick={() => setModal(true)}><Ic n="plus" /> Create key</Btn>
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}

    <Strip items={[
      { l: 'API requests · 24h', kpi: 'webhooks.api_requests', v: k ? <span title={`${num(k.api_requests_24h)} tenant API requests`}>{compact(k.api_requests_24h)}</span> : '—' },
      { l: 'Webhook deliveries', kpi: 'webhooks.deliveries', v: k ? <span title="Deliveries created in the last 24 hours">{compact(k.webhook_deliveries_24h)}</span> : '—' },
      { l: 'Delivery success', kpi: 'webhooks.success', v: k?.delivery_success != null ? <span title={`${k.delivered} delivered, ${k.failed} failed after retries (24h)`}>{k.delivery_success}%</span> : '—',
        c: k?.delivery_success != null ? C.ok : undefined, d: k && k.delivery_success == null ? 'no finished deliveries' : undefined },
      { l: 'Rate-limited', kpi: 'webhooks.rate_limited', v: k?.rate_limited != null ? <span title={`${k.rate_limited_requests} API-key requests refused (24h)`}>{k.rate_limited}%</span> : '—' },
    ]} />

    <div className="grid gap-2 md:grid-cols-2">
      <Panel title="Rate-limit policy" flush>
        <Table head={['Plan', { t: 'Requests / min', r: true }, { t: 'Burst', r: true }]} minWidth={320}>
          {!data ? <tr><td colSpan={3} className="!p-0"><Empty>{error || 'Loading…'}</Empty></td></tr>
            : !data.rate_limits.length ? <tr><td colSpan={3} className="!p-0"><Empty>No active plans.</Empty></td></tr>
              : data.rate_limits.map(r => <tr key={r.plan_id} title={r.updated_by ? `Set by ${r.updated_by}` : undefined}>
                <td>{r.plan}</td><td className="text-right tabular-nums">{num(r.per_minute)}</td><td className="text-right tabular-nums">{num(r.burst)}</td></tr>)}
        </Table>
      </Panel>
      <Panel title="Recent webhook deliveries" flush>
        <Table head={['Tenant', 'Event', 'Status', { t: 'Latency', r: true }]} minWidth={380}>
          {!d ? <tr><td colSpan={4} className="!p-0"><Empty>{error || 'Loading…'}</Empty></td></tr>
            : !d.items.length ? <tr><td colSpan={4} className="!p-0"><Empty>No webhook deliveries yet. Deliveries appear once a tenant registers an endpoint and events occur.</Empty></td></tr>
              : d.items.map(x => <tr key={x.id} title={[`${x.attempts} attempt(s)`, x.response_code ? `HTTP ${x.response_code}` : '', x.error ?? ''].filter(Boolean).join(' · ')}>
                <td>{x.tenant}</td><td className="font-mono text-xs">{x.event}</td><td><Pill t={STATUS_TONE[x.status] ?? 'mu'}>{x.status}</Pill></td>
                <td className="text-right tabular-nums">{x.latency_ms != null ? `${num(x.latency_ms)} ms` : '—'}</td></tr>)}
        </Table>
        {d && d.total > d.limit && <div className="flex items-center justify-end gap-2 border-t px-2.5 py-1.5 text-xs" style={{ borderColor: C.ln2, color: C.mu }}>
          <span>{d.offset + 1}–{d.offset + d.items.length} of {d.total}</span>
          <Btn s disabled={!d.offset} onClick={() => void page(Math.max(0, d.offset - d.limit))}>Prev</Btn>
          <Btn s disabled={d.offset + d.limit >= d.total} onClick={() => void page(d.offset + d.limit)}>Next</Btn></div>}
      </Panel>
    </div>
    {modal && data && <CreateKeyModal data={data} onClose={() => { setModal(false); void load() }} />}
  </div>
}
