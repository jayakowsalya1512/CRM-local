import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { platformApi, type FinopsOverview, type FinopsPage, type FinopsRow, type FinopsSaving } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol, type GridServer } from '@/components/platform/BwGrid'
import { Btn, C, Empty, Ic, Note, PageHead, Panel, Pill, Strip, downloadBlob, errMsg, fd, inr, useKpiPopup } from '@/components/platform/bw'
import { Donut, LineChart, PAL } from '@/components/platform/charts'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout follows the Bidwise prototype v9 Cost & margin page (P.finops): five KPIs, Cost by tenant grid + Where the money
// goes, Cost trend · 6 months + Savings opportunities – with Discount and Net MRR columns added. Costs are the measured
// allocation of server, storage, AI, egress and support costs (platform_finops); revenue is pre-GST, after the
// Discounts & coupons engine and partner commission. Nothing is estimated: unset costs read as zero and say why.
const marginTone = (m: number) => m < 40 ? C.ba : m < 65 ? C.wa : C.ok
const pct = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)}%`
type MoneyField = 'compute' | 'database' | 'storage' | 'ai' | 'egress' | 'support' | 'total' | 'mrr' | 'discount' | 'net_mrr' | 'profit'
const money = (f: MoneyField, k: string, t: string, extra: Partial<GridCol<FinopsRow>> = {}): GridCol<FinopsRow> =>
  ({ k, t, r: true, money: true, sv: r => r[f], sumv: r => r[f], sumFmt: inr, txt: r => inr(r[f]), ...extra })

export default function PlatformCostMarginPage() {
  const { can } = usePlatformAccess()
  const navigate = useNavigate()
  const [openKpi, kpiPopup] = useKpiPopup()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<FinopsOverview | null>(null)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<FinopsPage | null>(null)
  const [query, setQuery] = useState({ q: '', sort: 'tt:-1', offset: 0, limit: 25 })
  const [exporting, setExporting] = useState(false)
  const [applying, setApplying] = useState('')
  const load = useCallback(async (refresh = false) => {
    try { const { data: next } = await platformApi.finops(refresh); setData(next); setError('') } catch (err) { setError(errMsg(err, 'Cost & margin unavailable')) }
  }, [])
  const loadRows = useCallback(async () => {
    try { const { data: next } = await platformApi.finopsTenants(query.q, query.sort, query.offset, query.limit); setRows(next) }
    catch (err) { showError(errMsg(err, 'Unable to load cost by tenant')) }
  }, [query, showError])
  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadRows() }, [loadRows])

  const exportReport = async () => {
    setExporting(true)
    try {
      const { data: blob } = await platformApi.finopsExport()
      downloadBlob(blob, `cost-margin-${(data?.month ?? new Date().toISOString()).slice(0, 7)}.xlsx`)
      success('FinOps report exported', 'Tenant costs, MRR, discounts, net MRR, gross profit and margin')
    } catch (err) { showError(errMsg(err, 'Export failed')) } finally { setExporting(false) }
  }
  const canApply = can('storage', 'manage') && !!data?.all_scope
  const apply = async (s: FinopsSaving) => {
    setApplying(s.key)
    try {
      await platformApi.setStoragePolicy(s.action.policy, true)
      success('Optimisation scheduled', `“${s.action.label}” is on – it runs with the hourly storage policies`)
      await load()
    } catch (err) { showError(errMsg(err, 'Unable to apply the optimisation')) } finally { setApplying('') }
  }

  const discountTitle = (r: FinopsRow) => r.discount_lines.length ? r.discount_lines.map(l => `${l.label}: ${inr(l.monthly)} / month`).join('\n') : 'No discount applies this month'
  const cols: GridCol<FinopsRow>[] = [
    { k: 't', t: 'Tenant', w: 200, sv: r => r.name, txt: r => r.name, fn: r => <Link to={`/platform/tenants/${r.id}`} onClick={e => e.stopPropagation()} style={{ color: C.ac }}><b>{r.name}</b></Link> },
    money('compute', 'cp', 'Compute', { sum: true }),
    money('database', 'db', 'Database', { sum: true }),
    money('storage', 'st', 'Storage'),
    money('ai', 'ai', 'AI'),
    money('egress', 'eg', 'Egress'),
    money('support', 'sp', 'Support', { hide: true }),
    money('total', 'tt', 'Total cost', { sum: true, fn: r => <b title={`Includes support ${inr(r.support)}`}>{inr(r.total)}</b> }),
    money('mrr', 'm', 'MRR', { sum: true,
      fn: r => <span title={r.paying ? `Subscription ${inr(r.subscription)}${r.addons ? ` + add-ons ${inr(r.addons)}` : ''} · excl. GST` : `Not billed (${r.status}${r.billing_status ? `, ${r.billing_status}` : ''})`}>{inr(r.mrr)}</span> }),
    money('discount', 'dc', 'Discount', { sum: true,
      fn: r => <span title={discountTitle(r)} style={{ color: r.discount ? C.wa : C.mu }}>{r.discount ? `−${inr(r.discount)}` : inr(0)}</span> }),
    money('net_mrr', 'nm', 'Net MRR', { sum: true, fn: r => <b>{inr(r.net_mrr)}</b> }),
    money('profit', 'gp', 'Gross profit', { hide: true, fn: r => <span style={{ color: r.profit < 0 ? C.ba : undefined }}>{r.profit < 0 ? `−${inr(-r.profit)}` : inr(r.profit)}</span> }),
    { k: 'gm', t: 'Margin', w: 110, sv: r => r.margin, txt: r => r.margin == null ? '—' : pct(r.margin),
      fn: r => r.margin == null ? <span title="No revenue this month – margin is undefined" style={{ color: C.mu }}>—</span> : <span style={{ color: marginTone(r.margin), fontWeight: 600 }}>{pct(r.margin)}</span> },
  ]
  const server: GridServer = {
    total: rows?.total ?? 0,
    onChange: useCallback(s => {
      const sort = s.sorts.length ? s.sorts.map(([k, d]) => `${k}:${d}`).join(',') : 'tt:-1'
      setQuery(x => x.offset === s.offset && x.limit === s.limit && x.sort === sort ? x : { ...x, offset: s.offset, limit: s.limit, sort })
    }, []),
  }
  const onQuery = useCallback((s: { q: string }) => setQuery(x => x.q === s.q ? x : { ...x, q: s.q, offset: 0 }), [])

  const k = data?.kpis
  const src = data?.sources
  const budgetTone = k?.budget_used == null ? undefined : k.budget_used > 100 ? 'tbad' : k.budget_used >= 75 ? 'twarn' : 'tok'
  const missing = src ? [
    ...(src.unpriced.length ? [`no monthly_cost on server${src.unpriced.length > 1 ? 's' : ''} ${src.unpriced.join(', ')} (PLATFORM_SERVERS)`] : []),
    ...(!src.servers.length && !src.rates.storage_gb && !src.rates.ai_question && !src.rates.egress_gb ? ['no unit rates (Control Center → Cost & capacity)'] : []),
    ...(!src.rates.support_month ? ['no monthly support cost'] : []),
  ] : []

  const trend = data?.trend
  const hasTrend = !!trend && trend.cost.some(v => v != null)
  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <PageHead crumb="Business" title="Cost & margin">
      <Btn disabled={!data || exporting} onClick={() => void exportReport()} title="Excel report: tenant costs, original MRR, discounts, net MRR, gross profit and margin"><Ic n="dl" /> {exporting ? 'Exporting…' : 'Export'}</Btn>
    </PageHead>
    {kpiPopup}
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}
    {missing.length > 0 && <Note info className="mb-2">Some costs are not configured, so they count as ₹0: {missing.join('; ')}.{' '}
      <Link to="/platform/control-center" style={{ color: C.ac }}>Control Center</Link></Note>}
    {k && <Strip items={[
      { l: 'Infra + support cost / month', v: inr(k.cost), kpi: 'cost.cost', title: 'Allocated server costs plus metered storage, AI, egress and support costs this month' },
      { l: 'Revenue (MRR)', v: inr(k.net_mrr), kpi: 'cost.revenue', d: k.discount ? `${inr(k.original_mrr)} before discounts` : undefined, title: 'Net MRR after discounts, excluding GST' },
      { l: 'Gross margin', v: k.margin == null ? '—' : pct(k.margin), kpi: 'cost.margin',
        d: k.margin == null ? 'no revenue' : k.margin_change != null ? `${k.margin_change >= 0 ? '+' : ''}${k.margin_change} pts` : undefined,
        dc: k.margin_change == null ? undefined : k.margin_change >= 0 ? 'tok' : 'tbad' },
      { l: 'Avg cost / tenant', v: k.avg_cost == null ? '—' : inr(k.avg_cost), kpi: 'cost.avg_cost' },
      { l: 'Budget used', v: k.budget_used == null ? '—' : `${Math.round(k.budget_used)}%`, kpi: 'cost.budget', d: k.budget ? `of ${inr(k.budget)}` : 'no budget set', dc: budgetTone },
    ]} />}
    <div className="mb-2 grid gap-2 lg:grid-cols-[2fr_1fr]">
      <Panel title="Cost by tenant" flush>
        <BwGrid id="finops-tenants" cols={cols} rows={rows?.items ?? []} rid={r => String(r.id)} onRow={r => navigate(`/platform/tenants/${r.id}`)} server={server} onQuery={onQuery}
          empty={rows ? 'No tenants match.' : 'Loading…'} />
      </Panel>
      <Panel title="Where the money goes">
        {!data ? <Empty>{error || 'Loading…'}</Empty> : <>
          <Donut data={data.mix.map(m => ({ l: m.label, v: m.value }))} f={inr} center={inr(k!.cost)}
            onPick={i => openKpi({ kpi: 'cost.cost', title: `${data.mix[i].label} cost by tenant`, value: inr(data.mix[i].value), query: { sort: data.mix[i].key, dir: 'desc' } })} />
          {data.discounts.some(d => d.value) && <div className="mt-3 border-t pt-2" style={{ borderColor: C.ln2 }}>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.mu }}>Discounts · per month</div>
            {data.discounts.filter(d => d.value).map(d => <div key={d.key} className="flex justify-between py-0.5"><span>{d.label}</span><b>−{inr(d.value)}</b></div>)}
          </div>}
        </>}
      </Panel>
    </div>
    <div className="grid gap-2 lg:grid-cols-2">
      <Panel title="Cost trend · 6 months">
        {!trend ? <Empty>{error || 'Loading…'}</Empty> : !hasTrend ? <Empty>No monthly history recorded yet.</Empty> : <>
          <LineChart h={130} labels={trend.labels} f={inr} series={[
            { n: 'Cost', c: PAL[4], v: trend.cost },
            { n: 'Net revenue', c: PAL[2], v: trend.net_revenue },
          ]} />
          {trend.since && <div className="mt-1 text-[11px]" style={{ color: C.mu }}>Recorded monthly since {fd(trend.since)}; net revenue is after discounts, excluding GST. The current month is month to date.</div>}
        </>}
      </Panel>
      <Panel title="Savings opportunities" flush>
        {!data ? <Empty>{error || 'Loading…'}</Empty> : !data.savings.length ? <Empty>No optimisation found in the measured storage.</Empty>
          : <div className="bw-list">{data.savings.map(s => <div key={s.key}>
            <span className="flex-1">{s.title}<br />
              <small style={{ color: s.saving ? C.ok : C.mu }}>{s.saving ? `Save ${inr(s.saving)} / month` : `Frees ${s.gb.toFixed(2)} GB${s.saving_note ? ` – ${s.saving_note}` : ''}`}</small></span>
            {s.enabled ? s.unavailable ? <Pill t="wa" title={`The policy is on but can't run: ${s.unavailable}`}>Can't run</Pill>
              : <Pill t="ok" title="The storage policy is on and runs hourly">Scheduled</Pill>
              : <Btn s disabled={!canApply || !!s.unavailable || applying === s.key} onClick={() => void apply(s)}
                title={s.unavailable ?? (canApply ? `Turn on “${s.action.label}” (Documents & storage)` : 'Needs Storage manage access with all-tenant scope')}>
                {applying === s.key ? 'Applying…' : 'Apply'}</Btn>}
          </div>)}</div>}
      </Panel>
    </div>
  </div>
}
