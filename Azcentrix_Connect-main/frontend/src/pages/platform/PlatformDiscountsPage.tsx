import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { platformApi, type CouponRow, type DiscountsOverview, type NegotiatedDiscount } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Field, Ic, Loading, Note, PageHead, Panel, Pill, Strip, Switch, Table, Tabs, errMsg, fd, inputCls, inr, num, useKpiPopup, type Tone } from '@/components/platform/bw'
import { Donut, HBars } from '@/components/platform/charts'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout, tabs, tables, modals and actions follow the Bidwise prototype v9 Discounts & coupons page (P.coupons, A.cpNew,
// A.tdNew …). Every value comes from the platform API; discounts are taken off real invoices by Billing & Metering.
const TABS = ['Coupons', 'Volume tiers', 'Tenant discounts', 'Partner discounts', 'Approvals'] as const
const DURATIONS: [string, string][] = [['once', 'Once'], ['repeat_3', 'Repeating · 3 months'], ['repeat_12', 'Repeating · 12 months'], ['forever', 'Forever'], ['annual', 'Annual prepay']]
const couponTone = (s: string): Tone => s === 'Active' ? 'ok' : s === 'Expired' ? 'ba' : s === 'Exhausted' ? 'inf' : 'mu'
const discTone = (s: string): Tone => s === 'Active' ? 'ok' : s === 'Pending approval' ? 'inf' : s === 'Rejected' ? 'ba' : 'mu'
const daysTo = (day: string) => { const n = Math.round((new Date(`${day}T00:00:00`).getTime() - new Date(isoDay(0) + 'T00:00:00').getTime()) / 864e5); return n >= 0 ? `in ${n}d` : `${-n}d ago` }
const isoDay = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const MiniBar = ({ v }: { v: number }) => <span className="ml-1.5 inline-block h-1.5 w-[60px] overflow-hidden rounded align-middle" style={{ background: C.ln2 }}><i className="block h-full rounded" style={{ width: `${Math.min(100, v)}%`, background: v >= 100 ? C.wa : C.ac }} /></span>

type Confirm = { title: string; body: ReactNode; label: string; danger?: boolean; run: () => Promise<void> }

// Number input that saves when it loses focus (prototype data-c handlers).
function NumField({ value, onSave, min, max, width = 70, suffix, disabled, full }: { value: number; onSave: (v: number) => Promise<void>; min?: number; max?: number; width?: number; suffix?: string; disabled?: boolean; full?: boolean }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  return <span className={full ? 'block' : 'whitespace-nowrap'}><input type="number" className={full ? `${inputCls} w-full` : `${inputCls} sm`} style={full ? undefined : { width }} min={min} max={max} value={v} disabled={disabled}
    onChange={e => setV(e.target.value)} onBlur={() => { if (v !== String(value) && v !== '') void onSave(Number(v)).catch(() => setV(String(value))) }}
    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />{suffix && <> {suffix}</>}</span>
}

function NewCoupon({ data, onClose, onDone }: { data: DiscountsOverview; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast()
  const [f, setF] = useState({ code: '', kind: 'percent', value: '10', duration: 'once', plans: data.plans.map(p => p.id), limit: '50', until: isoDay(60), note: '' })
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }))
  const value = Number(f.value), limit = Number(f.limit)
  const invalid = { code: !/^[A-Z0-9_-]{1,40}$/.test(f.code), value: !(value > 0) || (f.kind === 'percent' && value > 100), plans: !f.plans.length,
    limit: !Number.isInteger(limit) || limit < 0, until: !f.until || f.until < isoDay(0) }
  const save = async () => {
    setTried(true)
    const problem = invalid.code ? 'Enter a code (letters, digits, - and _)' : invalid.value ? 'Enter a value above zero (a percentage up to 100)' : invalid.plans ? 'Choose at least one plan'
      : invalid.limit ? 'The redemption limit must be 0 or more' : invalid.until ? '“Valid until” can’t be in the past' : ''
    if (problem) return showError(problem)
    setBusy(true)
    try {
      const all = f.plans.length === data.plans.length
      const { data: r } = await platformApi.createCoupon({ code: f.code, kind: f.kind, value, duration: f.duration, plan_ids: all ? null : f.plans, limit, valid_until: f.until, note: f.note.trim() })
      success(`Coupon ${r.code} is live`); onDone(); onClose()
    } catch (err) { showError(errMsg(err, 'The coupon could not be created')) } finally { setBusy(false) }
  }
  const err = (bad: boolean) => tried && bad ? 'err' : ''
  return <BwModal title="New coupon" width={560} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy} onClick={() => void save()}>{busy ? 'Creating…' : 'Create coupon'}</Btn></>}>
    <div className="grid gap-x-3 gap-y-[9px] sm:grid-cols-2">
      <Field label="Code"><input className={`${inputCls} font-mono uppercase ${err(invalid.code)}`} placeholder="e.g. SUMMER20" maxLength={40} autoFocus value={f.code} onChange={e => set('code', e.target.value.toUpperCase().replace(/\s/g, ''))} /></Field>
      <Field label="Type"><select className={inputCls} value={f.kind} onChange={e => set('kind', e.target.value)}><option value="percent">Percentage off</option><option value="amount">Fixed amount off (₹)</option></select></Field>
      <Field label="Value"><input type="number" min={0} className={`${inputCls} ${err(invalid.value)}`} value={f.value} onChange={e => set('value', e.target.value)} /></Field>
      <Field label="Duration"><select className={inputCls} value={f.duration} onChange={e => set('duration', e.target.value)}>{DURATIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      <div className="sm:col-span-2"><span className="mb-0.5 block text-xs" style={{ color: C.mu }}>Applies to plans</span>
        <div className="flex flex-wrap gap-1.5">{data.plans.map(p => { const on = f.plans.includes(p.id); return <label key={p.id} className={`bw-chip ${on ? 'on' : ''}`}>
          <input type="checkbox" className="mr-1" checked={on} onChange={() => set('plans', on ? f.plans.filter(x => x !== p.id) : [...f.plans, p.id])} />{p.name}</label> })}</div>
        {tried && invalid.plans && <small style={{ color: C.ba }}>Choose at least one plan</small>}</div>
      <Field label="Redemption limit (0 = unlimited)"><input type="number" min={0} className={`${inputCls} ${err(invalid.limit)}`} value={f.limit} onChange={e => set('limit', e.target.value)} /></Field>
      <Field label="Valid until"><input type="date" min={isoDay(0)} className={`${inputCls} ${err(invalid.until)}`} value={f.until} onChange={e => set('until', e.target.value)} /></Field>
      <div className="sm:col-span-2"><Field label="Internal note"><input className={inputCls} maxLength={300} value={f.note} onChange={e => set('note', e.target.value)} /></Field></div>
    </div>
  </BwModal>
}

function NewNegotiated({ data, onClose, onDone }: { data: DiscountsOverview; onClose: () => void; onDone: (pending: boolean) => void }) {
  const { success, info, error: showError } = useToast()
  const [f, setF] = useState({ tenant: data.tenants[0]?.id ?? 0, pct: '10', term: '12', reason: '' })
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }))
  const save = async () => {
    const pct = Number(f.pct)
    if (!f.tenant) return showError('Choose a tenant')
    if (!(pct >= 1 && pct <= 60)) return showError('The discount must be between 1 and 60%')
    if (f.reason.trim().length < 5) return showError('Give the reason (at least 5 characters)')
    setBusy(true)
    try {
      const { data: r } = await platformApi.createNegotiatedDiscount({ tenant_id: f.tenant, pct, term: Number(f.term), reason: f.reason.trim() })
      if (r.status === 'pending') info('Sent for second approval', 'Another billing manager approves it in the Approvals tab')
      else success(`Discount applied to ${data.tenants.find(t => t.id === f.tenant)?.name}`)
      onDone(r.status === 'pending'); onClose()
    } catch (err) { showError(errMsg(err, 'The discount could not be saved')) } finally { setBusy(false) }
  }
  return <BwModal title="Negotiated discount" width={500} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy || !data.tenants.length} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
    <div className="grid gap-x-3 gap-y-[9px] sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Tenant"><select className={inputCls} value={f.tenant} onChange={e => set('tenant', Number(e.target.value))}>{data.tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field></div>
      <Field label="Discount (%)"><input type="number" min={1} max={60} className={inputCls} value={f.pct} onChange={e => set('pct', e.target.value)} /></Field>
      <Field label="Term"><select className={inputCls} value={f.term} onChange={e => set('term', e.target.value)}><option value="12">12 months</option><option value="24">24 months</option><option value="36">36 months</option></select></Field>
      <div className="sm:col-span-2"><Field label="Reason"><input className={inputCls} maxLength={300} placeholder="Why is this discount justified?" value={f.reason} onChange={e => set('reason', e.target.value)} /></Field></div>
    </div>
    <Note className="mt-2">Discounts above 20% are sent for a second approval.</Note>
  </BwModal>
}

export default function PlatformDiscountsPage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<DiscountsOverview | null>(null)
  const [error, setError] = useState('')
  const [params, setParams] = useSearchParams()
  const tab = (TABS as readonly string[]).includes(params.get('tab') || '') ? params.get('tab')! : TABS[0]
  const setTab = (t: string) => setParams({ tab: t }, { replace: true })
  const [offset, setOffset] = useState(0)
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => { const t = setTimeout(() => { setQuery(q.trim()); setOffset(0) }, 300); return () => clearTimeout(t) }, [q])
  const [modal, setModal] = useState<'coupon' | 'negotiated' | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState('')
  const [openKpi, kpiPopup] = useKpiPopup()

  const load = useCallback(async () => {
    try { const { data } = await platformApi.discounts(offset, query); setData(data); setError('') }
    catch (err) { setError(errMsg(err, 'Discounts & coupons unavailable')) }
  }, [offset, query])
  useEffect(() => { void load() }, [load])

  const canManage = can('billing', 'manage')
  const platformWide = canManage && !!data?.all_scope
  const noManage = canManage ? (data && !data.all_scope ? 'Needs all-tenant scope' : undefined) : 'Needs Billing manage access'
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key)
    try { await fn(); success(done); await load() } catch (err) { showError(errMsg(err, 'Action failed')); await load() } finally { setBusy('') }
  }
  const saveSetting = (key: string) => async (v: number | boolean) => {
    try { await platformApi.updateDiscountSetting(key, v); success('Saved'); await load() } catch (err) { showError(errMsg(err, 'Not saved')); throw err }
  }
  const decide = (d: NegotiatedDiscount, action: 'approve' | 'reject' | 'end') =>
    act(`${action}${d.id}`, () => platformApi.decideNegotiatedDiscount(d.id, action), action === 'approve' ? 'Discount approved' : action === 'reject' ? 'Discount rejected' : 'Discount ended')
  const own = (d: NegotiatedDiscount) => !!data?.me && d.requested_by_id === data.me

  const k = data?.kpis, s = data?.settings ?? {}
  const decisionButtons = (d: NegotiatedDiscount) => <>
    <Btn s p disabled={!canManage || own(d) || !!busy} title={own(d) ? 'Needs a second approver – you requested this discount' : noManage} onClick={() => void decide(d, 'approve')}>Approve</Btn>{' '}
    <Btn s d disabled={!canManage || !!busy} title={noManage} onClick={() => void decide(d, 'reject')}>Reject</Btn>
  </>

  let body: ReactNode = <Loading />
  if (data && tab === 'Coupons') {
    const page = data.coupons
    body = <>
      <Panel title="Coupon codes" flush>
        <div className="flex items-center gap-1.5 border-b px-2.5 py-2" style={{ borderColor: C.ln2 }}>
          <label className="relative w-full max-w-[260px]"><span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2" style={{ color: C.mu }}><Ic n="search" /></span>
            <input className={`${inputCls} w-full pl-7`} placeholder="Search code or note…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search coupons" /></label>
        </div>
        {!page.items.length ? <Empty>{query ? 'No coupons match your search' : 'No coupons yet. Use New coupon to create one.'}</Empty> : <>
          <Table head={['Code', 'Discount', 'Applies to', 'Duration', 'Redeemed', 'Valid till', 'Status', 'Note', 'Actions']} minWidth={1100}>
            {page.items.map((c: CouponRow) => <tr key={c.id} style={{ cursor: 'pointer' }} title={`${c.code} — click for redemptions`}
              onClick={() => openKpi({ kpi: 'discounts.redemptions', title: `Redemptions · ${c.code}`, value: num(c.redeemed), query: { facet: c.code } })}>
              <td><b className="font-mono">{c.code}</b></td>
              <td>{c.kind === 'percent' ? `${c.value}%` : `₹${c.value.toLocaleString('en-IN')}`}</td>
              <td>{c.applies_to}</td>
              <td>{c.duration_label}</td>
              <td className="whitespace-nowrap">{c.limit ? <>{c.redeemed} / {c.limit}<MiniBar v={c.redeemed / c.limit * 100} /></> : `${c.redeemed} (unlimited)`}</td>
              <td className="whitespace-nowrap" style={{ color: c.status === 'Expired' ? C.ba : undefined }}>{fd(c.valid_until)}</td>
              <td><Pill t={couponTone(c.status)}>{c.status}</Pill></td>
              <td className="max-w-[220px] truncate" title={c.note ?? undefined}>{c.note || '—'}</td>
              <td className="whitespace-nowrap" onClick={e => e.stopPropagation()}>
                <Btn s disabled={!platformWide || !!busy} title={noManage} onClick={() => void act(`t${c.id}`, () => platformApi.toggleCoupon(c.id), `${c.code} ${c.paused ? 'activated' : 'paused'}`)}>{c.paused ? 'Activate' : 'Pause'}</Btn>{' '}
                <Btn s disabled={!platformWide || !!busy} title={noManage} onClick={() => void act(`x${c.id}`, () => platformApi.extendCoupon(c.id), 'Extended by 30 days')}>+30 d</Btn>{' '}
                <Btn s d disabled={!platformWide || !!busy} title={noManage ?? 'Delete'} onClick={() => setConfirm({
                  title: 'Delete coupon', label: 'Delete', danger: true, body: <p>Delete coupon <b className="font-mono">{c.code}</b>? Tenants who already used it keep their discount.</p>,
                  run: () => act(`d${c.id}`, () => platformApi.deleteCoupon(c.id), 'Coupon deleted'),
                })}><Ic n="trash" /></Btn>
              </td>
            </tr>)}
          </Table>
          <div className="bw-pgn"><span className="flex-1">{page.offset + 1}–{Math.min(page.offset + page.limit, page.total)} of {num(page.total)}</span>
            <span>Page {Math.floor(page.offset / page.limit) + 1} / {Math.max(1, Math.ceil(page.total / page.limit))}</span>
            <Btn s disabled={page.offset === 0} onClick={() => setOffset(Math.max(0, offset - page.limit))}>‹</Btn>
            <Btn s disabled={page.offset + page.limit >= page.total} onClick={() => setOffset(offset + page.limit)}>›</Btn></div>
        </>}
      </Panel>
      <div className="bw-g g2 mt-2">
        <Panel title="Redemptions by coupon">{data.redemptions_by_coupon.length
          ? <HBars lw={110} vw={40} rows={data.redemptions_by_coupon.map(r => ({ l: r.code, v: r.count, text: num(r.count) }))}
            onPick={i => { const r = data.redemptions_by_coupon[i]; openKpi({ kpi: 'discounts.redemptions', title: `Redemptions · ${r.code}`, value: num(r.count), query: { facet: r.code } }) }} />
          : <Empty>No coupon has been redeemed yet</Empty>}</Panel>
        <Panel title="Discount by plan">{data.discount_by_plan.length
          ? <Donut data={data.discount_by_plan.map(d => ({ l: d.plan, v: d.amount }))} f={v => inr(v)} center="100%" caption="of discounts"
            onPick={i => { const d = data.discount_by_plan[i]; openKpi({ kpi: 'discounts.mrr_discount', title: `Discount · ${d.plan}`, value: inr(d.amount), query: { facet: d.plan } }) }} />
          : <Empty>{k?.paying_tenants ? 'No paying tenant has a discount this month' : 'No paying tenants yet – discounts show here once tenants are billed'}</Empty>}</Panel>
      </div>
    </>
  } else if (data && tab === 'Volume tiers') {
    body = <>
      <Note info className="mb-2">Volume discounts apply automatically to the subscription price as the number of seats grows. Edit a band and every new invoice uses it.{!s.volume && <> <b>Volume-based pricing is off</b> in Control Center, so no band is applied.</>}</Note>
      <Panel title="Seat-based volume discounts" flush>
        <Table head={[{ t: 'From seats', r: true }, { t: 'To seats', r: true }, { t: 'Discount', r: true }, { t: 'Example: 100 seats at ₹ 799 / seat', r: true }]} minWidth={560}>
          {data.volume_tiers.map(t => { const n = Math.min(t.to ?? t.from + 50, Math.max(t.from, 100)); return <tr key={t.id}>
            <td className="text-right">{t.from}</td><td className="text-right">{t.to ?? '∞'}</td>
            <td className="text-right"><NumField value={t.pct} min={0} max={40} suffix="%" disabled={!platformWide} onSave={async v => { await act(`v${t.id}`, () => platformApi.updateVolumeTier(t.id, v), 'Volume tier saved') }} /></td>
            <td className="text-right">{inr(n * 799 * 12 * (1 - t.pct / 100))} / yr</td>
          </tr> })}
        </Table>
      </Panel>
      <div className="bw-g g2 mt-2">
        <Panel title="Annual prepay discount">
          <div className="grid gap-x-3 gap-y-[9px] sm:grid-cols-2">
            {([['dcAnnual', 'Discount when paying yearly'], ['dcMulti2', 'Multi-year (2 years)'], ['dcMulti3', 'Multi-year (3 years)'], ['couponMax', 'Maximum stackable discount']] as const).map(([key, label]) =>
              <Field key={key} label={label}><NumField value={Number(s[key] ?? 0)} min={0} max={100} full disabled={!platformWide} onSave={saveSetting(key)} /></Field>)}
          </div>
          <small className="mt-2 block" style={{ color: C.mu }}>{data.setting_notes.dcMulti2}</small>
        </Panel>
        <Panel title="Rules" flush>
          <div className="bw-list">{([['dcStackVol', 'Coupons and volume discounts can stack'], ['dcNegReplace', 'Negotiated discounts replace volume discounts'], ['dcShowInv', 'Show discount on invoices'], ['dcApproval', 'Discounts above 20% need a second approver']] as const).map(([key, label]) =>
            <div key={key}><Switch on={!!s[key]} label={label} disabled={!platformWide} onChange={v => void saveSetting(key)(v).catch(() => undefined)} /><span className="flex-1">{label}</span></div>)}</div>
        </Panel>
      </div>
    </>
  } else if (data && tab === 'Tenant discounts') {
    body = <>
      <div className="mb-2 flex items-center gap-2"><Btn p disabled={!canManage} title={noManage} onClick={() => setModal('negotiated')}><Ic n="plus" /> Negotiated discount</Btn><small style={{ color: C.mu }}>Discounts above 20% need a second approver.</small></div>
      <Panel title="Negotiated discounts" flush>
        {!data.negotiated.length ? <Empty>No negotiated discounts</Empty> :
          <Table head={['Tenant', { t: 'Discount', r: true }, 'Term', 'Valid until', 'Reason', 'Requested by', 'Status', 'Actions']} minWidth={980}>
            {data.negotiated.map(d => <tr key={d.id}>
              <td><Link to={`/platform/tenants/${d.tenant_id}`}><b>{d.tenant}</b></Link></td>
              <td className="text-right">{d.pct}%</td><td>{d.term}</td>
              <td className="whitespace-nowrap">{d.valid_until ? <>{fd(d.valid_until)}{d.status_key !== 'ended' && d.status_key !== 'rejected' && <small style={{ color: C.mu }}> {daysTo(d.valid_until)}</small>}</> : '—'}</td>
              <td className="max-w-[260px] truncate" title={d.reason}>{d.reason}</td>
              <td>{d.requested_by ?? '—'}</td>
              <td><Pill t={discTone(d.status)} title={d.decided_by ? `${d.status_key === 'rejected' ? 'Rejected' : 'Approved'} by ${d.decided_by}` : undefined}>{d.status}</Pill></td>
              <td className="whitespace-nowrap">{d.status_key === 'pending' ? decisionButtons(d) : d.status_key === 'active'
                ? <Btn s disabled={!canManage || !!busy} title={noManage} onClick={() => setConfirm({ title: 'End discount', label: 'End', danger: true,
                    body: <p>End the {d.pct}% negotiated discount for <b>{d.tenant}</b>? Invoices issued from now on use the normal price. Issued invoices don’t change.</p>, run: () => decide(d, 'end') })}>End</Btn> : null}</td>
            </tr>)}
          </Table>}
      </Panel>
    </>
  } else if (data && tab === 'Partner discounts') {
    body = <>
      <Note info className="mb-2">Resellers buy at a discounted partner price. Tiers are reached automatically from ARR under management.</Note>
      <Panel title="Reseller tiers" flush>
        <Table head={['Tier', 'Reached at', { t: 'Partner margin', r: true }, 'Typical']} minWidth={640}>
          {data.reseller_tiers.map(r => <tr key={r.tier}>
            <td><b>{r.tier}</b></td>
            <td>₹ <NumField value={r.min_arr} min={0} width={130} suffix="ARR" disabled={!platformWide} onSave={async v => { await act(`r${r.tier}`, () => platformApi.updateResellerTier(r.tier, { min_arr: v }), 'Tier saved') }} /></td>
            <td className="text-right"><NumField value={r.margin} min={0} max={60} suffix="%" disabled={!platformWide} onSave={async v => { await act(`m${r.tier}`, () => platformApi.updateResellerTier(r.tier, { margin: v }), 'Partner margin saved') }} /></td>
            <td title={r.resellers.map(x => `${x.name}: ${inr(x.arr)} ARR`).join('\n') || undefined}>{r.resellers.length ? `${r.resellers.length} reseller${r.resellers.length === 1 ? '' : 's'} · ${inr(r.resellers.reduce((a, x) => a + x.arr, 0))} ARR` : <span style={{ color: C.mu }}>No reseller qualifies yet</span>}</td>
          </tr>)}
        </Table>
      </Panel>
      <div className="bw-g g2 mt-2">
        <Panel title="Referral programme">
          <div className="grid gap-x-3 gap-y-[9px] sm:grid-cols-2">
            <Field label="Referral discount for new customer"><NumField value={Number(s.refPct ?? 0)} min={0} max={90} full disabled={!platformWide} onSave={saveSetting('refPct')} /></Field>
            <Field label="Reward for referring tenant (credit ₹)"><NumField value={Number(s.refCredit ?? 0)} min={0} full disabled={!platformWide} onSave={saveSetting('refCredit')} /></Field>
          </div>
          <small className="mt-2 block" style={{ color: C.mu }}>{data.setting_notes.refPct}</small>
        </Panel>
        <Panel title="Non-profit & education">
          <div className="grid gap-x-3 gap-y-[9px] sm:grid-cols-2">
            <Field label="Standard discount (%)"><NumField value={Number(s.npoPct ?? 0)} min={0} max={90} full disabled={!platformWide} onSave={saveSetting('npoPct')} /></Field>
            <label className="flex items-center gap-2 self-end pb-1 sm:col-span-2" style={{ color: C.tx }}><Switch on={!!s.npoVerify} label="Require document verification" disabled={!platformWide} onChange={v => void saveSetting('npoVerify')(v).catch(() => undefined)} /> Require document verification</label>
          </div>
          <small className="mt-2 block" style={{ color: C.mu }}>{data.setting_notes.npoPct}</small>
        </Panel>
      </div>
    </>
  } else if (data) {
    body = <Panel title="Discounts awaiting approval" flush>
      {!data.approvals.length ? <Empty>No discounts waiting for approval</Empty> :
        <Table head={['Tenant', { t: 'Discount', r: true }, 'Reason', 'Requested by', 'Actions']} minWidth={760}>
          {data.approvals.map(d => <tr key={d.id}><td><Link to={`/platform/tenants/${d.tenant_id}`}><b>{d.tenant}</b></Link></td><td className="text-right">{d.pct}%</td><td className="max-w-[320px] truncate" title={d.reason}>{d.reason}</td>
            <td>{d.requested_by ?? '—'}</td><td className="whitespace-nowrap">{decisionButtons(d)}</td></tr>)}
        </Table>}
    </Panel>
  }

  return <div>
    {kpiPopup}
    {modal === 'coupon' && data && <NewCoupon data={data} onClose={() => setModal(null)} onDone={() => { setOffset(0); void load() }} />}
    {modal === 'negotiated' && data && <NewNegotiated data={data} onClose={() => setModal(null)} onDone={() => { setTab('Tenant discounts'); void load() }} />}
    {confirm && <BwModal title={confirm.title} width={460} onClose={() => setConfirm(null)}
      foot={<><Btn onClick={() => setConfirm(null)}>Cancel</Btn><Btn p={!confirm.danger} d={confirm.danger} onClick={() => { const r = confirm.run; setConfirm(null); void r() }}>{confirm.label}</Btn></>}>{confirm.body}</BwModal>}

    <PageHead crumb="Business" title="Discounts & coupons">
      <Btn p onClick={() => setModal('coupon')} disabled={!data || !platformWide} title={noManage}><Ic n="plus" /> New coupon</Btn>
    </PageHead>
    {error && <Note className="mb-2">{error}</Note>}

    <Strip items={[
      { l: 'Active coupons', v: k ? num(k.active_coupons) : '—', kpi: 'discounts.active_coupons' },
      { l: 'Redemptions', v: k ? num(k.redemptions) : '—', kpi: 'discounts.redemptions', sp: k && k.redemptions_trend.some(Boolean) ? k.redemptions_trend : undefined },
      { l: 'MRR given as discount', v: k ? inr(k.mrr_discount) : '—', kpi: 'discounts.mrr_discount', dc: 'twarn', title: 'List MRR minus effective MRR of paying tenants (Billing & Metering)' },
      { l: 'Avg discount', v: k ? (k.avg_discount == null ? '—' : `${Math.round(k.avg_discount)}%`) : '—', kpi: 'discounts.avg_discount', title: 'Average effective discount of paying tenants that have one' },
      { l: 'Awaiting approval', v: k ? num(k.awaiting_approval) : '—', kpi: 'discounts.awaiting_approval', dc: k?.awaiting_approval ? 'twarn' : undefined },
    ]} />

    <div className="bw-panel">
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      <div className="pb">{body}</div>
    </div>
  </div>
}
