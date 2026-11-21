import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { platformApi, type MarketApp, type MarketOverview, type Paged } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol, type GridServer } from '@/components/platform/BwGrid'
import { Btn, BwModal, C, Empty, Field, Note, Panel, Pill, Strip, Switch, Table, errMsg, inputCls, inputStyle, num, type Tone } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout follows the Bidwise prototype v7 Marketplace administration page (P.market): KPI strip, apps grid, marketplace
// policy and plan visibility. Apps arrive through the publisher API and installs through the tenant API; ratings, paid-app
// billing and a developer portal don't exist yet and are shown as such.
const SCAN_TONE = (label: string): Tone => label === 'Clean' ? 'ok' : label === 'Critical' ? 'ba' : 'wa'
const STATUS_TONE = (st: string): Tone => st === 'Live' ? 'ok' : st === 'Suspended' ? 'ba' : 'wa'
const VERB: Record<string, string> = { approve: 'Approve', reject: 'Reject', suspend: 'Suspend', reinstate: 'Reinstate' }

function ReasonModal({ app, action, onClose, onOk }: { app: MarketApp; action: string; onClose: () => void; onOk: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  return <BwModal title={`${VERB[action]} ${app.name}`} width={460} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn>
    <Btn d disabled={busy || !reason.trim()} onClick={async () => { setBusy(true); try { await onOk(reason.trim()) } finally { setBusy(false) } }}>{busy ? 'Working…' : VERB[action]}</Btn></>}>
    <div className="mb-2">{action === 'suspend'
      ? <>Suspend <b>{app.name}</b> by {app.publisher}? It is hidden from tenants and can’t be installed until reinstated ({num(app.installs)} current install{app.installs === 1 ? '' : 's'}).</>
      : <>Reject <b>{app.name}</b> by {app.publisher}? The publisher sees the reason through the publisher API.</>}</div>
    <Field label="Reason"><input className={inputCls} style={inputStyle} value={reason} maxLength={300} autoFocus onChange={e => setReason(e.target.value)} /></Field>
  </BwModal>
}

export default function PlatformMarketplacePage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<MarketOverview | null>(null)
  const [error, setError] = useState('')
  const [apps, setApps] = useState<Paged<MarketApp>>({ items: [], total: 0, offset: 0, limit: 25 })
  const [appQ, setAppQ] = useState({ q: '', offset: 0, limit: 25 })
  const [modal, setModal] = useState<ReactNode>(null)
  const load = useCallback(async () => {
    try { const { data: next } = await platformApi.marketplace(); setData(next); setError('') } catch (err) { setError(errMsg(err, 'Marketplace administration unavailable')) }
  }, [])
  const loadApps = useCallback(async () => {
    try { const { data: next } = await platformApi.marketplaceApps(appQ.q, appQ.offset, appQ.limit); setApps(next) } catch (err) { showError(errMsg(err, 'Unable to load apps')) }
  }, [appQ, showError])
  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadApps() }, [loadApps])
  const canPlatform = can('tenants', 'manage') && !!data?.all_scope
  const close = () => setModal(null)

  const act = (a: MarketApp, action: string) => {
    const go = async (reason: string) => {
      try { const { data: r } = await platformApi.marketplaceAppAction(a.id, action, reason); success(`${a.name}: ${r.status}`); close(); await Promise.all([load(), loadApps()]) }
      catch (err) { showError(errMsg(err, `Unable to ${action} the app`)) }
    }
    if (action === 'reject' || action === 'suspend') setModal(<ReasonModal app={a} action={action} onClose={close} onOk={go} />)
    else void go('')
  }
  const setPolicy = async (key: string, enabled: boolean) => {
    try { await platformApi.marketplacePolicy(key, enabled); success('Marketplace policy saved'); await load() } catch (err) { showError(errMsg(err, 'Unable to save the policy')) }
  }

  const cols: GridCol<MarketApp>[] = [
    { k: 'n', t: 'App', w: 200, txt: a => a.name, fn: a => <><b>{a.name}</b>{a.private && <span className="ml-1"><Pill t="mu">Private</Pill></span>}{a.price_monthly > 0 && <span className="ml-1"><Pill t="mu">Paid</Pill></span>}</> },
    { k: 'pub', t: 'Publisher', txt: a => a.publisher },
    { k: 'cat', t: 'Category', txt: a => a.category },
    { k: 'ins', t: 'Installs', r: true, sum: true, sv: a => a.installs, sumv: a => a.installs, txt: a => num(a.installs) },
    { k: 'rat', t: 'Rating', r: true, txt: () => '—', fn: () => <span title="Tenant ratings are not collected yet" style={{ color: C.mu }}>—</span> },
    { k: 'sc', t: 'Scopes requested', w: 230, txt: a => a.scopes.join(', ') },
    { k: 'scan', t: 'Security scan', txt: a => a.security.label, fn: a => <span title={[
      `Scope review: ${a.security.scope_review}${a.security.scope_findings.length ? ` – ${a.security.scope_findings.join('; ')}` : ''}`,
      a.security.code_scanned ? `Code scan: ${a.security.scan_result}` : 'Code scan: not received',
    ].join('\n')}><Pill t={SCAN_TONE(a.security.label)}>{a.security.label}</Pill></span> },
    { k: 'st', t: 'Status', txt: a => a.status, fn: a => <span title={a.status_reason ?? undefined}><Pill t={STATUS_TONE(a.status)}>{a.status}</Pill></span> },
    { k: 'x', t: '', w: 200, txt: () => '', fn: a => <span className="inline-flex gap-1" onClick={e => e.stopPropagation()}>
      {a.status === 'In review' ? <><Btn s p disabled={!canPlatform} onClick={() => act(a, 'approve')}>Approve</Btn><Btn s d disabled={!canPlatform} onClick={() => act(a, 'reject')}>Reject</Btn></>
        : a.status === 'Live' ? <Btn s d disabled={!canPlatform} onClick={() => act(a, 'suspend')}>Suspend</Btn>
        : <Btn s disabled={!canPlatform} onClick={() => act(a, 'reinstate')}>Reinstate</Btn>}</span> },
  ]
  const server: GridServer = { total: apps.total, onChange: useCallback(s => setAppQ(x => x.offset === s.offset && x.limit === s.limit ? x : { ...x, offset: s.offset, limit: s.limit }), []) }
  const onQuery = useCallback((s: { q: string }) => setAppQ(x => x.q === s.q ? x : { ...x, q: s.q, offset: 0 }), [])
  const k = data?.kpis

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2 flex flex-wrap items-end gap-2">
      <div><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Mobile &amp; ecosystem</div><h1 className="text-xl font-semibold">Marketplace administration</h1></div>
      <span className="flex-1" />
      <Btn disabled title="There is no developer portal yet – publishers submit apps through the publisher API (X-Publisher-Key)">Developer portal</Btn>
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}
    {data && !data.scanner_connected && <Note className="mb-2">No external security scanner is connected (MARKETPLACE_SCANNER_SECRET is not set) – apps show the platform’s scope review only{data.policy.find(p => p.key === 'scan_required')?.enabled ? ', and approval needs a code-scan result' : ''}.</Note>}
    {k ? <Strip items={[
      { l: 'Live apps', kpi: 'market.live', v: num(k.live) },
      { l: 'In review', kpi: 'market.in_review', v: <span style={{ color: k.in_review ? C.wa : undefined }}>{num(k.in_review)}</span> },
      { l: 'Installs', kpi: 'market.installs', v: num(k.installs) },
      { l: 'Suspended', kpi: 'market.suspended', v: <span style={{ color: k.suspended ? C.ba : undefined }}>{num(k.suspended)}</span> },
      { l: 'Revenue share · 30d', kpi: 'market.revenue_share', v: '—', d: 'no paid-app billing' },
    ]} /> : !error && <Panel title="Marketplace"><Empty>Loading…</Empty></Panel>}
    <Panel title="Apps" flush>
      <BwGrid id="market-apps" cols={cols} rows={apps.items} rid={a => String(a.id)} server={server} onQuery={onQuery}
        empty="No marketplace apps. Apps appear here when a publisher submits one through the publisher API." />
    </Panel>
    <div className="mt-2 grid gap-2 lg:grid-cols-2">
      <Panel title="Marketplace policy">
        {data ? <div className="grid gap-2">{data.policy.map(p => <div key={p.key} className="flex items-center gap-2">
          <Switch on={p.enabled} label={p.label} disabled={!canPlatform} onChange={v => void setPolicy(p.key, v)} /><span className="flex-1">{p.label}</span></div>)}</div>
          : <Empty>{error || 'Loading…'}</Empty>}
      </Panel>
      <Panel title="Plan visibility" flush>
        {data ? <Table head={['Plan', 'Marketplace access']} minWidth={300}>
          {data.plans.map(p => <tr key={p.plan_id}><td>{p.plan}</td><td>{p.label}</td></tr>)}
        </Table> : <Empty>{error || 'Loading…'}</Empty>}
      </Panel>
    </div>
    {modal}
  </div>
}
