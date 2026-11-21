import { useCallback, useEffect, useMemo, useState } from 'react'
import { platformApi, type Reseller, type ResellersOverview } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { Btn, BwModal, C, Field, Ic, Note, Panel, Pill, Strip, errMsg, inputCls, inputStyle, inr, type Tone } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout follows the Bidwise prototype v7 Resellers & partners page (P.resell, resNew, resAssign): KPI strip, the
// Reseller accounts grid with inline commission editing, and the New reseller / Assign tenant dialogs. Real records only.
const TIER_TONE: Record<string, Tone> = { Platinum: 'ac', Gold: 'wa', Silver: 'inf', Bronze: 'mu' }
const pct = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(2).replace(/0$/, '')}%`

function NewResellerModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast()
  const [name, setName] = useState('')
  const [region, setRegion] = useState('')
  const [comm, setComm] = useState('20')
  const [busy, setBusy] = useState(false)
  const n = Number(comm)
  const valid = name.trim() && comm.trim() !== '' && !Number.isNaN(n) && n >= 0 && n <= 100
  const create = async () => {
    setBusy(true)
    try { const { data } = await platformApi.createReseller({ name: name.trim(), region: region.trim(), commission: n }); success('Reseller created', `${data.name} · ${data.domain}`); onDone() }
    catch (err) { showError(errMsg(err, 'Unable to create the reseller')) } finally { setBusy(false) }
  }
  return <BwModal title="New reseller" width={460} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn>
    <Btn p disabled={busy || !valid} onClick={() => void create()}>{busy ? 'Creating…' : 'Create'}</Btn></>}>
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Company"><input className={inputCls} style={inputStyle} value={name} maxLength={200} onChange={e => setName(e.target.value)} /></Field></div>
      <Field label="Region"><input className={inputCls} style={inputStyle} value={region} maxLength={120} onChange={e => setRegion(e.target.value)} /></Field>
      <Field label="Commission %"><input className={inputCls} style={inputStyle} type="number" min={0} max={100} step={0.5} value={comm} onChange={e => setComm(e.target.value)} /></Field>
    </div>
    {comm.trim() !== '' && !valid && name.trim() && <div className="mt-1.5 text-xs" style={{ color: C.ba }}>Commission must be between 0 and 100 %.</div>}
  </BwModal>
}

function AssignModal({ reseller, data, onClose, onDone }: { reseller: Reseller; data: ResellersOverview; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast()
  const free = data.tenants.filter(t => !t.reseller)
  const [tenant, setTenant] = useState(String(free[0]?.id ?? ''))
  const [busy, setBusy] = useState(false)
  const assign = async () => {
    setBusy(true)
    try { const { data: r } = await platformApi.assignResellerTenant(reseller.id, Number(tenant)); success(`Tenant assigned to ${r.reseller}`, r.tenant); onDone() }
    catch (err) { showError(errMsg(err, 'Unable to assign the tenant')) } finally { setBusy(false) }
  }
  return <BwModal title="Assign tenant" width={420} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn>
    <Btn p disabled={busy || !tenant} onClick={() => void assign()}>{busy ? 'Assigning…' : 'Assign'}</Btn></>}>
    <select className={inputCls} style={inputStyle} value={tenant} aria-label="Tenant" onChange={e => setTenant(e.target.value)}>
      {!free.length && <option value="">Every tenant already has a reseller</option>}
      {data.tenants.map(t => <option key={t.id} value={t.id} disabled={!!t.reseller}>{t.name}{t.reseller ? ` — via ${t.reseller}` : ''}</option>)}
    </select>
  </BwModal>
}

export default function PlatformResellersPage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<ResellersOverview | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'new' | Reseller | null>(null)
  const load = useCallback(async () => {
    try { const { data: next } = await platformApi.resellers(); setData(next); setError('') }
    catch (err) { setError(errMsg(err, 'Resellers unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])
  const canEdit = can('billing', 'manage') && !!data?.all_scope

  const cols = useMemo<GridCol<Reseller>[]>(() => [
    { k: 'n', t: 'Reseller', w: 220, txt: r => r.name, fn: r => <b>{r.name}</b> },
    { k: 'region', t: 'Region', txt: r => r.region ?? '—' },
    { k: 'tier', t: 'Tier', w: 110, txt: r => r.tier, fn: r => <Pill t={TIER_TONE[r.tier] ?? 'mu'}>{r.tier}</Pill> },
    { k: 'comm', t: 'Commission', r: true, w: 120, txt: r => pct(r.commission), sv: r => r.commission,
      ...(canEdit ? { ed: { t: 'num' as const, min: 0, max: 100, step: 0.5, value: (r: Reseller) => String(r.commission),
        save: async (r: Reseller, v: string) => {
          const n = Number(v)
          if (v.trim() === '' || Number.isNaN(n) || n < 0 || n > 100) { showError('Commission must be between 0 and 100 %'); throw new Error('invalid') }
          try { await platformApi.setResellerCommission(r.id, n); success(`${r.name}: ${pct(n)} commission`); await load() }
          catch (err) { showError(errMsg(err, 'Unable to change the commission')); throw err }
        } } } : {}) },
    { k: 'tn', t: 'Tenants', r: true, w: 100, txt: r => String(r.tenants), sv: r => r.tenants },
    { k: 'dom', t: 'White-label domain', w: 200, txt: r => r.domain, fn: r => <span title="Proposed host name – DNS and SSL are not configured from here">{r.domain}</span> },
    { k: 'x', t: '', w: 130, txt: () => '', fn: r => <Btn s disabled={!canEdit} onClick={() => setModal(r)}>Assign tenant…</Btn> },
  ], [canEdit, load, showError, success])

  const k = data?.kpis
  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2 flex flex-wrap items-end gap-2">
      <div className="flex-1"><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Command</div><h1 className="text-xl font-semibold">Resellers &amp; partners</h1></div>
      <Btn p disabled={!canEdit} title={data && !data.all_scope ? 'Resellers span tenants – needs all-tenant scope' : undefined} onClick={() => setModal('new')}><Ic n="plus" /> New reseller</Btn>
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}
    <Strip items={[
      { l: 'Resellers', v: k ? k.resellers : '—', kpi: 'resellers.count' },
      { l: 'Tenants via resellers', v: k ? k.tenants_via_resellers : '—', kpi: 'resellers.tenants' },
      { l: 'Commission payable', kpi: 'resellers.commission', v: k ? <span title="Commission earned on paid invoices of reseller tenants since they were assigned (no payouts recorded yet)">{inr(k.commission_payable)}</span> : '—' },
      { l: 'Avg. commission', v: k?.avg_commission != null ? pct(k.avg_commission) : '—', kpi: 'resellers.avg_commission' },
    ]} />
    <Panel title="Reseller accounts" flush>
      <BwGrid id="resellers" cols={cols} rows={data?.resellers ?? []} rid={r => String(r.id)}
        empty={!data ? (error || 'Loading…') : 'No resellers yet. Use New reseller to add one.'} />
    </Panel>
    {modal === 'new' && <NewResellerModal onClose={() => setModal(null)} onDone={() => { setModal(null); void load() }} />}
    {modal && modal !== 'new' && data && <AssignModal reseller={modal} data={data} onClose={() => setModal(null)} onDone={() => { setModal(null); void load() }} />}
  </div>
}
