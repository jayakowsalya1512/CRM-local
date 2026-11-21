import { Fragment, useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { platformApi, type BillingInvoiceLine, type BillingInvoiceRow, type BillingOverview, type BillingRunItem, type BillingConfig } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Field, Ic, Kv, Note, Panel, Pill, Strip, Table, errMsg, fd, inputCls, inputStyle, num } from '@/components/platform/bw'
import { HBars } from '@/components/platform/charts'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'
import { PlanFormPanel } from '@/pages/platform/PlatformPlansPage'

// Layout, KPIs, tables and actions follow the Bidwise prototype Plans & billing page (P.billing).
// Revenue comes from paying tenants' plan prices (or their tenant price override); invoices are stored platform invoices.
const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const today = () => new Date().toISOString().slice(0, 10)
const qty = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })

function Lines({ lines, taxRate, tax, subtotal, total }: { lines: BillingInvoiceLine[]; taxRate: number; tax: number; subtotal: number; total: number }) {
  return <Table head={['Item', { t: 'Qty', r: true }, { t: 'Rate', r: true }, { t: 'Amount', r: true }]} minWidth={480}>
    {lines.map((l, i) => <tr key={i}>
      <td>{l.description}{l.note && <><br /><small style={{ color: C.mu }}>{l.note}</small></>}</td>
      <td className="text-right">{l.kind === 'note' ? '' : qty(l.quantity)}</td>
      <td className="text-right">{l.kind === 'note' ? '' : rupees(l.unit_price)}</td>
      <td className="text-right">{l.kind === 'note' ? '—' : rupees(l.amount)}</td>
    </tr>)}
    <tr><td colSpan={3} className="text-right" style={{ color: C.mu }}>Subtotal</td><td className="text-right">{rupees(subtotal)}</td></tr>
    <tr><td colSpan={3} className="text-right" style={{ color: C.mu }}>{taxRate ? `GST ${taxRate}%` : 'Tax'}</td><td className="text-right">{rupees(tax)}</td></tr>
    <tr><td colSpan={3} className="text-right"><b>Total</b></td><td className="text-right"><b>{rupees(total)}</b></td></tr>
  </Table>
}

function RunModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast()
  const [plan, setPlan] = useState<{ items: BillingRunItem[]; config: BillingConfig } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => { platformApi.billingRunPreview().then(r => setPlan(r.data)).catch(err => setError(errMsg(err, 'Unable to prepare the invoicing run'))) }, [])
  const due = plan?.items.filter(i => i.action === 'invoice') ?? []
  const run = async () => {
    setBusy(true)
    try {
      const { data } = await platformApi.billingRun()
      success(data.created ? `${data.created} invoice(s) created: ${data.invoices.join(', ')}` : 'No invoices were due')
      onDone()
    } catch (err) { showError(errMsg(err, 'Invoicing failed')) } finally { setBusy(false) }
  }
  return <BwModal title="Run invoicing" width={760} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn>
    <Btn p disabled={busy || !due.length} onClick={() => void run()}>{busy ? 'Creating invoices…' : `Create ${due.length} invoice${due.length === 1 ? '' : 's'}`}</Btn></>}>
    {error ? <Note>{error}</Note> : !plan ? <Empty>Calculating charges from plans and usage…</Empty> : <>
      <Kv rows={[['Billing cycle', plan.config.cycle], ['Invoice prefix', plan.config.prefix], ['Payment due', `${plan.config.due_days} days`], ['Tax', plan.config.tax],
        ['Over-limit usage', plan.config.over_limit], ['Overage rates', `Seat ${rupees(plan.config.overage_prices.seat)} · Storage ${rupees(plan.config.overage_prices.storage_gb)}/GB · AI ${rupees(plan.config.overage_prices.ai_query)}/query`]]} />
      <div className="mt-2" />
      {!plan.items.length ? <Empty>No tenants to bill.</Empty> : <Table head={['Tenant', 'Period', 'Plan', { t: 'Total', r: true }, 'Result']} minWidth={640}>
        {plan.items.map(i => <Fragment key={i.tenant_id}>
          <tr style={{ cursor: i.lines ? 'pointer' : undefined }} onClick={() => i.lines && setOpen(open === i.tenant_id ? null : i.tenant_id)}>
            <td><b>{i.tenant}</b></td>
            <td>{fd(i.period_start)} – {fd(i.period_end)}</td>
            <td>{i.plan ?? '—'}</td>
            <td className="text-right">{i.total != null ? rupees(i.total) : '—'}</td>
            <td>{i.action === 'invoice' ? <Pill t="ok">Will invoice</Pill> : <span style={{ color: C.mu }}>{i.reason}</span>}</td>
          </tr>
          {open === i.tenant_id && i.lines && <tr><td colSpan={5} style={{ background: C.hd }}>
            <Lines lines={i.lines} taxRate={i.tax_rate ?? 0} tax={i.tax_amount ?? 0} subtotal={i.subtotal ?? 0} total={i.total ?? 0} />
            {!!i.notes?.length && <div className="mt-1 text-xs" style={{ color: C.mu }}>{i.notes.join(' · ')}</div>}
          </td></tr>}
        </Fragment>)}
      </Table>}
      {!!due.length && <div className="mt-2 text-xs" style={{ color: C.mu }}>Click a tenant to see its invoice lines. Invoices already raised for a period are never created again.</div>}
    </>}
  </BwModal>
}

function InvoiceModal({ id, canPay, onClose, onPaid }: { id: number; canPay: boolean; onClose: () => void; onPaid: () => void }) {
  const { success, error: showError } = useToast()
  const [inv, setInv] = useState<(BillingInvoiceRow & { tax_rate: number; created_by: string | null; billing_email: string | null; lines: BillingInvoiceLine[] }) | null>(null)
  const [error, setError] = useState('')
  const [paidOn, setPaidOn] = useState(today())
  const [ref, setRef] = useState('')
  const [evidence, setEvidence] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { platformApi.billingInvoice(id).then(r => setInv(r.data)).catch(err => setError(errMsg(err, 'Invoice unavailable'))) }, [id])
  const pay = async () => {
    setBusy(true)
    try { await platformApi.billingRecordPayment(id, paidOn, ref, evidence); success('Payment recorded'); onPaid() }
    catch (err) { showError(errMsg(err, 'Unable to record the payment')) } finally { setBusy(false) }
  }
  const pending = inv?.status === 'Pending'
  return <BwModal title={inv ? `Invoice ${inv.number}` : 'Invoice'} width={680} onClose={onClose} foot={<><Btn onClick={onClose}>Close</Btn>
    {pending && canPay && <Btn p disabled={busy || ref.trim().length < 2 || evidence.trim().length < 5} onClick={() => void pay()}>{busy ? 'Saving…' : 'Record payment'}</Btn>}</>}>
    {error ? <Note>{error}</Note> : !inv ? <Empty>Loading…</Empty> : <>
      <Kv rows={[['Tenant', inv.tenant], ['Plan', inv.plan ?? '—'], ['Period', `${fd(inv.period_start)} – ${fd(inv.period_end)} (${inv.cycle})`], ['Issued', fd(inv.issued_on)],
        ['Due', <>{fd(inv.due_on)}{inv.overdue && <> <Pill t="ba">Overdue</Pill></>}</>], ['Bill to', inv.billing_email ?? '—'],
        ['Status', inv.status === 'Paid' ? <><Pill t="ok">Paid</Pill> {fd(inv.paid_on)} · ref {inv.payment_ref}</> : <Pill t="wa">Pending</Pill>], ['Raised by', inv.created_by ?? '—']]} />
      <div className="mt-2"><Lines lines={inv.lines} taxRate={inv.tax_rate} tax={inv.tax_amount} subtotal={inv.subtotal} total={inv.total} /></div>
      {pending && canPay && <div className="mt-2 grid grid-cols-2 gap-2">
        <Field label="Paid on"><input type="date" className={inputCls} style={inputStyle} value={paidOn} min={inv.issued_on} max={today()} onChange={e => setPaidOn(e.target.value)} /></Field>
        <Field label="Payment reference"><input className={inputCls} style={inputStyle} value={ref} maxLength={120} placeholder="UTR / cheque / transaction ID" onChange={e => setRef(e.target.value)} /></Field>
        <div className="col-span-2"><Field label="Payment evidence"><input className={inputCls} style={inputStyle} value={evidence} maxLength={500} placeholder="e.g. HDFC statement 12 Nov, credit of ₹… from …" onChange={e => setEvidence(e.target.value)} /></Field></div>
      </div>}
    </>}
  </BwModal>
}

export default function PlatformBillingPage() {
  const navigate = useNavigate()
  const { can } = usePlatformAccess()
  const [data, setData] = useState<BillingOverview | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'run' | 'plan' | null>(null)
  const [invoice, setInvoice] = useState<number | null>(null)
  const load = useCallback(async () => {
    try { const { data: next } = await platformApi.billingOverview(); setData(next); setError('') }
    catch (err) { setError(errMsg(err, 'Billing unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])
  const canManage = can('billing', 'manage')
  const k = data?.kpis

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2 flex flex-wrap items-end gap-2">
      <div className="flex-1"><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Business</div><h1 className="text-xl font-semibold">Plans &amp; billing</h1></div>
      <Btn disabled={!canManage || !data?.all_scope} title={!data?.all_scope ? 'Invoicing bills every tenant – it needs all-tenant scope' : undefined} onClick={() => setModal('run')}>Run invoicing</Btn>
      <Btn p disabled={!canManage} onClick={() => setModal('plan')}><Ic n="plus" /> New plan</Btn>
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}

    <Strip items={[
      { l: 'MRR', kpi: 'billing.mrr', v: k ? rupees(k.mrr) : '—', d: k ? `${k.paying_tenants} paying tenant${k.paying_tenants === 1 ? '' : 's'}` : undefined },
      { l: 'ARR', kpi: 'billing.arr', v: k ? rupees(k.arr) : '—' },
      { l: 'Outstanding', kpi: 'billing.outstanding', v: k ? <span style={{ color: k.outstanding ? C.wa : undefined }}>{rupees(k.outstanding)}</span> : '—', d: k ? `${k.pending_invoices} unpaid invoice${k.pending_invoices === 1 ? '' : 's'}` : undefined },
      { l: 'Trials', kpi: 'billing.trials', v: k ? num(k.trials) : '—' },
    ]} />

    {!data ? <Panel title="Plans & billing"><Empty>{error || 'Loading…'}</Empty></Panel> : <>
      <div className="grid gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title="Plans" flush>
          {!data.plans.length ? <Empty>No plans yet – create one with New plan.</Empty> : <Table head={['Plan', { t: 'Price / month', r: true }, { t: 'Users', r: true }, { t: 'Storage GB', r: true }, { t: 'Modules', r: true }, { t: 'Tenants', r: true }]} minWidth={560}>
            {data.plans.map(p => <tr key={p.id}>
              <td><b>{p.name}</b>{!p.is_active && <> <Pill t="mu">Inactive</Pill></>}</td>
              <td className="text-right">{rupees(p.price_monthly)}</td>
              <td className="text-right">{num(p.max_users)}</td>
              <td className="text-right" title={p.storage_gb.length ? 'Storage limits set on this plan’s tenants' : 'No tenant on this plan'}>{p.storage_gb.length ? p.storage_gb.map(qty).join(' / ') : '—'}</td>
              <td className="text-right">{num(p.modules)}</td>
              <td className="text-right">{num(p.tenants)}</td>
            </tr>)}
          </Table>}
        </Panel>
        <Panel title="Revenue by tenant">
          {!data.revenue_by_tenant.length ? <Empty>No paying tenants yet{k?.trials ? ` – ${k.trials} tenant${k.trials === 1 ? ' is' : 's are'} on trial` : ''}.</Empty>
            : <HBars lw={60} vw={70} onPick={i => navigate(`/platform/tenants/${data.revenue_by_tenant[i].tenant_id}`)} rows={data.revenue_by_tenant.map(r => ({ l: r.name, v: r.mrr, text: rupees(r.mrr), note: r.source ? `${r.name}: ${rupees(r.mrr)} / month (${r.source})` : null }))} />}
        </Panel>
      </div>
      <div className="mt-2"><Panel title="Recent invoices" flush>
        {!data.invoices.length ? <Empty>No invoices yet – Run invoicing raises them for paying tenants.</Empty> : <Table head={['Invoice', 'Tenant', 'Date', { t: 'Amount', r: true }, 'Status']} minWidth={560}>
          {data.invoices.map(i => <tr key={i.id} style={{ cursor: 'pointer' }} onClick={() => setInvoice(i.id)}>
            <td><b>{i.number}</b></td>
            <td>{i.tenant}</td>
            <td>{fd(i.issued_on)}</td>
            <td className="text-right">{rupees(i.total)}</td>
            <td>{i.status === 'Paid' ? <Pill t="ok">Paid</Pill> : <Pill t={i.overdue ? 'ba' : 'wa'} title={`Due ${fd(i.due_on)}`}>{i.overdue ? 'Overdue' : 'Pending'}</Pill>}</td>
          </tr>)}
        </Table>}
      </Panel></div>
    </>}

    {modal === 'run' && <RunModal onClose={() => setModal(null)} onDone={() => { setModal(null); void load() }} />}
    {modal === 'plan' && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={e => e.target === e.currentTarget && setModal(null)}>
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto">
        <PlanFormPanel editPlan={null} onSaved={() => { setModal(null); void load() }} onCancel={() => setModal(null)} />
        <div className="mt-2 text-right"><Btn onClick={() => setModal(null)}>Cancel</Btn></div>
      </div>
    </div>}
    {invoice != null && <InvoiceModal id={invoice} canPay={canManage} onClose={() => setInvoice(null)} onPaid={() => { setInvoice(null); void load() }} />}
  </div>
}
