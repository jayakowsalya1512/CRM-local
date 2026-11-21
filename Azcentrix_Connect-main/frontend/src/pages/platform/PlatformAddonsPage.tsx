import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { platformApi, type AddonRow, type AddonsOverview } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, C, Empty, Field, Ic, Loading, Note, PageHead, Panel, Pill, Strip, Switch, Table, Tabs, errMsg, fd, inputCls, inr, num, type Tone } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout, tabs, tables and fields follow the Bidwise prototype v9 Add-ons & usage pricing page (P.addons). Every value comes from
// the platform API: the add-on catalogue and tenant subscriptions, per-plan usage rates, metered overage charges and price books.
const TABS = ['Add-ons', 'Usage-based pricing', 'Trials & price books'] as const
const addonTone = (s: AddonRow['status']): Tone => s === 'Active' ? 'ok' : s === 'Draft' ? 'wa' : s === 'Paused' ? 'mu' : 'inf'
const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/** Saves when the field is left (or Enter); a refused value goes back to the stored one. Empty is not saved. */
function SaveInput({ value, onSave, width, step, type = 'number', disabled, placeholder, full }: {
  value: string; onSave: (v: string) => Promise<void>; width?: number; step?: string; type?: string; disabled?: boolean; placeholder?: string; full?: boolean
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return <input className={full ? `${inputCls} w-full` : `${inputCls} sm`} style={full ? undefined : { width }} type={type} step={step} value={v} disabled={disabled} placeholder={placeholder}
    onChange={e => setV(e.target.value)} onBlur={() => { if (v.trim() !== value && v.trim() !== '') void onSave(v.trim()).catch(() => setV(value)); else if (v.trim() === '') setV(value) }}
    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
}

export default function PlatformAddonsPage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<AddonsOverview | null>(null)
  const [error, setError] = useState('')
  const [params, setParams] = useSearchParams()
  const tab = (TABS as readonly string[]).includes(params.get('tab') || '') ? params.get('tab')! : TABS[0]
  const setTab = (t: string) => setParams({ tab: t }, { replace: true })
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try { const { data: d } = await platformApi.addons(); setData(d); setError('') } catch (err) { setError(errMsg(err, 'Add-ons & usage pricing unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])

  const canManage = can('billing', 'manage')
  const wide = canManage && !!data?.all_scope
  const noWide = !canManage ? 'Needs Billing manage access' : data && !data.all_scope ? 'Needs all-tenant scope' : undefined
  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key)
    try { await fn(); success(done); await load() } catch (err) { showError(errMsg(err, 'Not saved')); await load(); throw err } finally { setBusy('') }
  }
  const quiet = (p: Promise<unknown>) => { void p.catch(() => undefined) }
  const k = data?.kpis

  let body: ReactNode = <Loading />
  if (data && tab === 'Add-ons') {
    body = <>
      <div className="mb-2.5 flex items-center gap-2">
        <Btn p disabled={!wide || !!busy} title={noWide} onClick={() => quiet(run('new', () => platformApi.createAddon(), 'Add-on created as a draft – name and price it, then activate it'))}><Ic n="plus" /> New add-on</Btn>
      </div>
      {!data.addons.length ? <Empty>No add-ons yet</Empty> : <Table head={['Add-on', 'Price (₹)', { t: 'Tenants', r: true }, { t: 'MRR', r: true }, 'Status', '']} minWidth={720}>
        {data.addons.map(a => <tr key={a.id}>
          <td>{a.status === 'Draft' ? <SaveInput type="text" width={240} value={a.name} disabled={!wide} onSave={v => run(`n${a.id}`, () => platformApi.updateAddon(a.id, { name: v }), 'Name saved')} /> : <b>{a.name}</b>}</td>
          <td className="whitespace-nowrap"><SaveInput width={100} step="1" value={String(a.price)} disabled={!wide} onSave={v => run(`p${a.id}`, () => platformApi.updateAddon(a.id, { price: Number(v) }), 'Price saved')} /> <small style={{ color: C.mu }}>{a.unit}</small></td>
          <td className="text-right">{num(a.tenants)}</td>
          <td className="text-right" title="Price × quantity of paying tenants' active subscriptions">{inr(a.mrr)}</td>
          <td><Pill t={addonTone(a.status)} title={a.status === 'Draft' ? 'Not offered to tenants until activated' : a.status === 'Paused' ? 'No new subscriptions; existing ones keep billing' : undefined}>{a.status}</Pill></td>
          <td><Btn s disabled={!wide || !!busy} title={noWide} onClick={() => quiet(run(`s${a.id}`, () => platformApi.setAddonStatus(a.id, a.status === 'Active' ? 'Paused' : 'Active'),
            a.status === 'Active' ? `${a.name} paused – no new subscriptions` : `${a.name} is now Active`))}>{a.status === 'Active' ? 'Pause' : 'Activate'}</Btn></td>
        </tr>)}
      </Table>}
    </>
  } else if (data && tab === 'Usage-based pricing') {
    body = <>
      <Note info className="mb-2.5">Each plan includes a quota. Usage beyond it is billed at the overage price on the next invoice.</Note>
      {data.usage.map(m => <Panel key={m.metric} className="mb-2.5" flush title={<>{m.label} <small style={{ color: C.mu }}>per {m.unit}</small></>}>
        {!m.rows.length ? <Empty>No active plans</Empty> : <Table head={['Plan', 'Included quota', 'Overage price (₹ per unit)', 'Example: 150% of quota']} minWidth={560}>
          {m.rows.map(r => <tr key={r.plan_id}>
            <td>{r.plan}</td>
            <td className="text-right"><SaveInput width={110} step={m.metric === 'storage' ? '0.01' : '1'} placeholder="Not set" value={r.included == null ? '' : String(r.included)} disabled={!wide}
              onSave={v => run(`q${m.metric}${r.plan_id}`, () => platformApi.setUsageRate({ plan_id: r.plan_id, metric: m.metric, included: Number(v) }), 'Quota saved')} /></td>
            <td className="text-right"><SaveInput width={90} step="0.1" placeholder="Not set" value={r.price == null ? '' : String(r.price)} disabled={!wide}
              onSave={v => run(`o${m.metric}${r.plan_id}`, () => platformApi.setUsageRate({ plan_id: r.plan_id, metric: m.metric, price: Number(v) }), 'Price saved')} /></td>
            <td className="text-right" title={r.effective_from ? `Rate in force from ${fd(r.effective_from)}` : 'Set a quota and an overage price to bill overage'}>{r.example == null ? '—' : inr(r.example)}</td>
          </tr>)}
        </Table>}
        <div className="px-3 py-1.5 text-xs" style={{ color: C.mu }}>{m.metered ? `Metered by ${m.source.replace(/^Usage Monitoring – /, 'Usage Monitoring: ')}${m.since ? ` since ${fd(m.since)}` : ''}` : m.source}</div>
      </Panel>)}
    </>
  } else if (data) {
    const t = data.trials
    const pb = data.price_books
    body = <div className="bw-g g2">
      <Panel title="Free trial"><div className="grid gap-x-3 gap-y-[9px] sm:grid-cols-2">
        <Field label="Trial length (days)"><SaveInput full value={String(t.trial_days)} disabled={!wide} onSave={v => run('td', () => platformApi.updateTrials({ trial_days: Number(v) }), 'Trial length saved – applies to new tenants')} /></Field>
        <Field label="Extension allowed (days)"><SaveInput full value={String(t.extension_days)} disabled={!wide} onSave={v => run('te', () => platformApi.updateTrials({ extension_days: Number(v) }), 'Saved')} /></Field>
        <div className="sm:col-span-2"><label className="flex items-center gap-2"><Switch on={false} label="Require card to start trial" disabled onChange={() => undefined} /> Require card to start trial</label>
          <small className="mt-0.5 block" style={{ color: C.mu }}>{t.status.require_card}</small></div>
        <div className="sm:col-span-2"><label className="flex flex-wrap items-center gap-2"><Switch on={t.auto_convert} label="Convert automatically after trial" disabled={!wide} onChange={v => quiet(run('ac', () => platformApi.updateTrials({ auto_convert: v }), 'Saved'))} />
          Convert automatically to <select className={`${inputCls} sm`} style={{ width: 140 }} value={t.convert_plan_id ?? ''} disabled={!wide} onChange={e => quiet(run('cp', () => platformApi.updateTrials({ convert_plan_id: Number(e.target.value) || null }), 'Saved'))}>
            <option value="">— plan —</option>{data.plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select> after trial</label>
          <small className="mt-0.5 block" style={{ color: C.mu }}>{t.status.auto_convert}</small></div>
        <div className="sm:col-span-2"><label className="flex items-center gap-2"><Switch on={false} label="Seed sample data in trial workspaces" disabled onChange={() => undefined} /> Seed sample data in trial workspaces</label>
          <small className="mt-0.5 block" style={{ color: C.mu }}>{t.status.seed_sample}</small></div>
      </div></Panel>
      <Panel title="Price books by currency" flush>
        <Table head={['Currency', 'Rate', ...pb.plans.map(p => `${p.name} / seat`), 'Tax']} minWidth={520}>
          {pb.rows.map(r => <tr key={r.currency}>
            <td>{r.currency}</td>
            <td className="text-right">{r.currency === 'INR' ? <input className={`${inputCls} sm`} style={{ width: 90 }} disabled value="1" /> :
              <span title={r.effective_from ? `₹ per ${r.currency} from ${fd(r.effective_from)}` : 'No rate set'}><SaveInput width={90} step="0.01" placeholder="Not set" value={r.rate == null ? '' : String(r.rate)} disabled={!wide}
                onSave={v => run(`fx${r.currency}`, () => platformApi.setFxRate(r.currency, Number(v), isoToday()), `${r.currency} rate saved from today`)} /></span>}
              {r.upcoming && <small className="block" style={{ color: C.mu }}>{r.upcoming.rate} from {fd(r.upcoming.effective_from)}</small>}</td>
            {r.seats.map((s, i) => <td key={i} className="text-right">{s == null ? '—' : `${r.symbol}${s.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}</td>)}
            <td className="whitespace-nowrap" title={r.tax.includes(' – ') ? r.tax : undefined}>{r.tax.split(' – ')[0]}</td>
          </tr>)}
        </Table>
        <div className="px-3 py-1.5 text-xs" style={{ color: C.mu }}>Seat price = plan’s monthly price ÷ included users ({pb.plans.map(p => `${p.name} ${rupees(p.per_seat_inr)}`).join(', ') || 'no paid plans'}). Rate = ₹ per unit of the currency.</div>
      </Panel>
    </div>
  }

  return <div>
    <PageHead crumb="Business" title="Add-ons & usage pricing" />
    {error && <Note className="mb-2">{error}</Note>}
    <Strip items={[
      { l: 'Add-ons', v: k ? num(k.addons) : '—', kpi: 'addons.count' },
      { l: 'Add-on MRR', v: k ? inr(k.addon_mrr) : '—', kpi: 'addons.mrr', dc: 'tok', title: 'Monthly price × quantity of paying tenants’ active add-ons' },
      { l: 'Tenants with add-ons', v: k ? num(k.tenants_with_addons) : '—', kpi: 'addons.tenants' },
      { l: 'Metered overage · month', v: k ? inr(k.overage_month) : '—', kpi: 'addons.overage', title: k ? (k.overage_month_closed ? `Overage charged for ${k.overage_month_label}` : `${k.overage_month_label} has not been closed yet`) : undefined },
    ]} />
    <div className="bw-panel">
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      <div className="pb">{body}</div>
    </div>
  </div>
}
