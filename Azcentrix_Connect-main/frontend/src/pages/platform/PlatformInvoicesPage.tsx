import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  platformApi, type BillingRunItem, type CreditableInvoice, type CreditNoteRow, type GatewayCard, type InvoiceRow, type InvoiceStatus, type InvoicingOverview,
} from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Field, Ic, Loading, Note, PageHead, Panel, Pill, Strip, Switch, Table, Tabs, errMsg, fd, inputCls, inr, num, type Tone } from '@/components/platform/bw'
import BwGrid, { type GridCol, type GridServer } from '@/components/platform/BwGrid'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout, tabs, tables and settings follow the Bidwise prototype v9 Invoices & dunning page (P.invoices). Every value comes from
// the platform API: invoices raised by the billing run, recorded payments, credit notes, and the module's stored settings.
const TABS = ['Invoices', 'Credit notes', 'Dunning', 'Tax & e-invoice', 'Gateways'] as const
const statusTone = (s: InvoiceStatus): Tone => s === 'Paid' ? 'ok' : s === 'Overdue' || s === 'Failed' ? 'ba' : s === 'Credited' ? 'mu' : 'inf'
const gwTone = (s: GatewayCard['status']): Tone => s === 'Connected' || s === 'Available' ? 'ok' : s === 'Verification failed' ? 'ba' : s === 'Not verified' ? 'wa' : 'mu'
const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const EINVOICE: [keyof InvoicingOverview['einvoice'], string][] = [['irn', 'Generate IRN and QR code'], ['cancel_irn', 'Auto-cancel IRN on credit notes'], ['gstn_24h', 'Report to GSTN within 24 hours'], ['tds_reminder', 'Include TDS certificate reminder']]
const POLICY: [keyof InvoicingOverview['dunning']['policy'], string, string?][] = [['grace_days', 'Grace period (days)'], ['max_retries', 'Max retries'], ['suspend_after', 'Suspend after (days)'], ['late_fee_pct', 'Late fee (%)', '0.1']]

/** Saves when the field is left (or Enter); a refused value goes back to the stored one. */
function SaveField({ value, onSave, type = 'text', step, disabled, maxLength }: { value: string; onSave: (v: string) => Promise<void>; type?: string; step?: string; disabled?: boolean; maxLength?: number }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return <input className={`${inputCls} w-full`} type={type} step={step} value={v} disabled={disabled} maxLength={maxLength} onChange={e => setV(e.target.value)}
    onBlur={() => { if (v !== value) void onSave(v).catch(() => setV(value)) }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
}

function MarkPaid({ row, gateways, onClose, onDone }: { row: InvoiceRow; gateways: GatewayCard[]; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast()
  const methods = gateways.filter(g => ['bank', 'manual', 'razorpay', 'stripe'].includes(g.key) && g.enabled)
  const [f, setF] = useState({ amount: row.balance.toFixed(2), gateway: (methods.find(m => m.key === 'bank')?.key ?? methods[0]?.key ?? '') as string, reference: '', paid_on: today(), evidence: '', confirm: false })
  const [busy, setBusy] = useState(false)
  const amount = Number(f.amount)
  const problem = !methods.length ? 'No payment method is switched on (Gateways tab)' : !(amount > 0) ? 'Enter the amount received' : amount > row.balance + 0.001 ? `More than the ${rupees(row.balance)} due`
    : f.reference.trim().length < 3 ? 'Enter the payment reference' : f.evidence.trim().length < 5 ? 'Describe the evidence of payment' : !f.confirm ? 'Confirm the money was received' : ''
  const save = async () => {
    setBusy(true)
    try { const { data } = await platformApi.invoicingMarkPaid(row.id, { ...f, amount }); success(`${row.number} · ${data.status}`, data.balance ? `${rupees(data.balance)} still due` : undefined); onDone(); onClose() }
    catch (err) { showError(errMsg(err, 'Payment not recorded')) } finally { setBusy(false) }
  }
  return <BwModal title={`Mark paid · ${row.number}`} width={520} onClose={onClose}
    foot={<><span className="flex-1 text-xs" style={{ color: C.mu }}>{problem}</span><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={!!problem || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Mark paid'}</Btn></>}>
    <div className="mb-2.5 text-xs" style={{ color: C.mu }}>{row.tenant} · {row.period} · total {rupees(row.total)} · due {rupees(row.balance)}</div>
    <div className="grid gap-2.5 sm:grid-cols-2">
      <Field label="Amount received (₹)" req><input className={`${inputCls} w-full`} type="number" step="0.01" min={0} value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></Field>
      <Field label="Received by" req><select className={`${inputCls} w-full`} value={f.gateway} onChange={e => setF({ ...f, gateway: e.target.value })}>{methods.map(m => <option key={m.key} value={m.key}>{m.name}</option>)}</select></Field>
      <Field label="Payment date" req><input className={`${inputCls} w-full`} type="date" value={f.paid_on} min={row.issued_on} max={today()} onChange={e => setF({ ...f, paid_on: e.target.value })} /></Field>
      <Field label="Reference (UTR / cheque no. / payment id)" req><input className={`${inputCls} w-full`} maxLength={120} value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} /></Field>
      <div className="sm:col-span-2"><Field label="Evidence" req><input className={`${inputCls} w-full`} maxLength={500} placeholder="e.g. HDFC statement 12 Nov – NEFT credit from the tenant" value={f.evidence} onChange={e => setF({ ...f, evidence: e.target.value })} /></Field></div>
      <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={f.confirm} onChange={e => setF({ ...f, confirm: e.target.checked })} /> I have checked that this money has been received</label>
    </div>
  </BwModal>
}

function NewCredit({ invoice, onClose, onDone }: { invoice?: InvoiceRow; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast()
  const [q, setQ] = useState('')
  const [options, setOptions] = useState<CreditableInvoice[] | null>(invoice ? [] : null)
  const [pick, setPick] = useState<number | null>(invoice?.id ?? null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (invoice) return
    const t = setTimeout(() => { platformApi.creditableInvoices(q).then(({ data }) => setOptions(data)).catch(err => { setOptions([]); showError(errMsg(err, 'Invoices unavailable')) }) }, 250)
    return () => clearTimeout(t)
  }, [q, invoice, showError])
  const sel = invoice ? { id: invoice.id, number: invoice.number, tenant: invoice.tenant, total: invoice.total, creditable: invoice.creditable } : options?.find(o => o.id === pick)
  const value = Number(amount)
  const problem = !sel ? 'Choose the invoice to credit' : !(value > 0) ? 'Enter the amount' : value > sel.creditable + 0.001 ? `At most ${rupees(sel.creditable)} can be credited` : reason.trim().length < 5 ? 'Give a reason' : ''
  const save = async () => {
    setBusy(true)
    try {
      const { data } = await platformApi.issueCreditNote({ invoice_id: sel!.id, amount: value, reason: reason.trim() })
      success(`Credit note ${data.number} issued`, data.refund_due ? `${rupees(data.refund_due)} was already paid – refund it to the tenant` : `${sel!.number} balance ${rupees(data.balance)}`)
      onDone(); onClose()
    } catch (err) { showError(errMsg(err, 'Credit note not issued')) } finally { setBusy(false) }
  }
  return <BwModal title="Issue credit note" width={520} onClose={onClose}
    foot={<><span className="flex-1 text-xs" style={{ color: C.mu }}>{problem}</span><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={!!problem || busy} onClick={() => void save()}>{busy ? 'Issuing…' : 'Issue credit note'}</Btn></>}>
    <div className="grid gap-2.5">
      {invoice ? <Field label="Invoice"><input className={`${inputCls} w-full`} disabled value={`${invoice.number} · ${invoice.tenant} · ${rupees(invoice.total)}`} /></Field> : <>
        <Field label="Find invoice"><input className={`${inputCls} w-full`} placeholder="Invoice number or tenant" value={q} onChange={e => setQ(e.target.value)} /></Field>
        <Field label="Invoice" req>{options == null ? <Loading /> : !options.length ? <Empty>No invoice left to credit</Empty>
          : <select className={`${inputCls} w-full`} value={pick ?? ''} onChange={e => setPick(Number(e.target.value) || null)}><option value="">— Select —</option>
            {options.map(o => <option key={o.id} value={o.id}>{o.number} · {o.tenant} · {o.status} · up to {rupees(o.creditable)}</option>)}</select>}</Field>
      </>}
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Field label={`Amount incl. GST (₹)${sel ? ` – up to ${rupees(sel.creditable)}` : ''}`} req><input className={`${inputCls} w-full`} type="number" step="0.01" min={0} value={amount} onChange={e => setAmount(e.target.value)} /></Field>
        <Field label="Reason" req><input className={`${inputCls} w-full`} maxLength={300} placeholder="e.g. Downtime credit" value={reason} onChange={e => setReason(e.target.value)} /></Field>
      </div>
      <div className="text-xs" style={{ color: C.mu }}>The invoice and its payments are kept as issued; the credit lowers what is still due.</div>
    </div>
  </BwModal>
}

function RunBilling({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast()
  const [items, setItems] = useState<BillingRunItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { platformApi.billingRunPreview().then(({ data }) => setItems(data.items)).catch(err => { showError(errMsg(err, 'Billing preview unavailable')); onClose() }) }, [showError, onClose])
  const due = items?.filter(i => i.action === 'invoice') ?? []
  const skipped = items?.filter(i => i.action === 'skip') ?? []
  const run = async () => {
    setBusy(true)
    try { const { data } = await platformApi.billingRun(); success(data.created ? `${data.created} invoice(s) created` : 'No invoices were due', data.invoices.join(', ') || undefined); onDone(); onClose() }
    catch (err) { showError(errMsg(err, 'Billing run failed')) } finally { setBusy(false) }
  }
  return <BwModal title="Run billing" width={620} onClose={onClose}
    foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy || !due.length} onClick={() => void run()}>{busy ? 'Creating invoices…' : `Create ${due.length} invoice${due.length === 1 ? '' : 's'}`}</Btn></>}>
    {!items ? <Loading /> : <>
      <p className="mb-2">{due.length ? <>Invoices for <b>{due.length}</b> tenant{due.length === 1 ? '' : 's'} totalling <b>{rupees(due.reduce((s, i) => s + (i.total ?? 0), 0))}</b> (incl. GST). Each tenant is billed once per period.</> : 'Nothing to invoice right now.'}</p>
      {skipped.length > 0 && <Table head={['Tenant', 'Not invoiced because']} minWidth={480}>{skipped.map(i => <tr key={i.tenant_id}><td>{i.tenant}</td><td style={{ color: C.mu }}>{i.reason}</td></tr>)}</Table>}
    </>}
  </BwModal>
}

function InvoicesTab({ data, canManage, reloadAll, onPay, onCredit }: { data: InvoicingOverview; canManage: boolean; reloadAll: () => void; onPay: (r: InvoiceRow) => void; onCredit: (r: InvoiceRow) => void }) {
  const navigate = useNavigate()
  const { success, error: showError } = useToast()
  const [rows, setRows] = useState<InvoiceRow[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(0)
  const [query, setQuery] = useState({ q: '', f: {} as Record<string, string> })
  const [view, setView] = useState<Parameters<GridServer['onChange']>[0]>({ offset: 0, limit: 25, sorts: [], adv: { logic: 'AND', conds: [] } })
  const seq = useRef(0)
  const load = useCallback(() => {
    const n = ++seq.current
    platformApi.invoicingInvoices({ q: query.q, quick: JSON.stringify(Object.fromEntries(Object.entries(query.f).filter(([, v]) => v))), conds: JSON.stringify(view.adv.conds.filter(c => c.k)),
      logic: view.adv.logic, sort: JSON.stringify(view.sorts), offset: view.offset, limit: view.limit })
      .then(({ data: d }) => { if (n === seq.current) { setRows(d.items); setTotal(d.total); setError('') } })
      .catch(err => { if (n === seq.current) setError(errMsg(err, 'Invoices unavailable')) })
  }, [query, view])
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t) }, [load, data])
  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => setQuery(p => JSON.stringify(p) === JSON.stringify(s) ? p : s), [])
  const onChange = useCallback<GridServer['onChange']>(s => setView(p => JSON.stringify(p) === JSON.stringify(s) ? p : s), [])
  const remind = async (r: InvoiceRow) => {
    setBusy(r.id)
    try { const { data: d } = await platformApi.invoicingRemind(r.id); success(`Payment reminder sent to ${d.recipient}`) } catch (err) { showError(errMsg(err, 'Reminder not sent')) } finally { setBusy(0); reloadAll() }
  }
  const settled = (r: InvoiceRow) => r.status === 'Paid' || r.status === 'Credited'
  const noManage = canManage ? undefined : 'Needs Billing manage access'
  const cols: GridCol<InvoiceRow>[] = [
    { k: 'number', t: 'Invoice', w: 120, fn: r => <b className="font-mono">{r.number}</b>, txt: r => r.number },
    { k: 'tenant', t: 'Tenant', w: 210, txt: r => r.tenant },
    { k: 'period', t: 'Period', w: 100, txt: r => r.period },
    { k: 'total', t: 'Amount (incl. GST)', w: 140, r: true, money: true, sum: true, fn: r => rupees(r.total), sv: r => r.total, sumv: r => r.total, sumFmt: inr },
    { k: 'tax', t: 'GST', w: 100, r: true, money: true, sum: true, fn: r => rupees(r.tax), sv: r => r.tax, sumv: r => r.tax, sumFmt: inr },
    { k: 'due', t: 'Due', w: 110, date: true, fn: r => <span style={{ color: r.due_on < today() ? C.ba : undefined }}>{fd(r.due_on)}</span>, txt: r => r.due_on, sv: r => r.due_on },
    { k: 'gateway', t: 'Gateway', w: 110, txt: r => r.gateway ?? '—' },
    { k: 'status', t: 'Status', w: 100, fn: r => <Pill t={statusTone(r.status)} title={r.failure ?? (r.balance && !settled(r) && r.balance < r.total ? `${rupees(r.balance)} still due` : undefined)}>{r.status}</Pill>, txt: r => r.status },
    { k: 'x', t: '', w: 250, fn: r => <span className="whitespace-nowrap" onClick={e => e.stopPropagation()}>
      <Btn s disabled={!canManage || settled(r) || busy === r.id} title={settled(r) ? 'Already settled' : noManage} onClick={() => void remind(r)}>{busy === r.id ? 'Sending…' : 'Remind'}</Btn>{' '}
      {!settled(r) && <><Btn s p disabled={!canManage} title={noManage} onClick={() => onPay(r)}>Mark paid</Btn>{' '}</>}
      <Btn s disabled={!canManage || !data.credit_notes_enabled || r.creditable <= 0} title={!data.credit_notes_enabled ? 'Credit notes are switched off in Control Center' : r.creditable <= 0 ? 'Fully credited' : noManage} onClick={() => onCredit(r)}>Credit note</Btn>
    </span>, txt: () => '' },
  ]
  return <>
    {error && <Note className="m-2.5">{error}</Note>}
    <BwGrid id="platform-invoices" cols={cols} rows={rows} rid={r => String(r.id)} onRow={r => navigate(`/platform/tenants/${r.tenant_id}`)} onQuery={onQuery} server={{ total, onChange }}
      empty={total ? 'No invoices match the current filters.' : 'No invoices yet – Run billing raises them for paying tenants.'} />
  </>
}

function CreditNotesTab({ canManage, enabled, reloadKey, onNew }: { canManage: boolean; enabled: boolean; reloadKey: number; onNew: () => void }) {
  const navigate = useNavigate()
  const [page, setPage] = useState<{ items: CreditNoteRow[]; total: number; offset: number; limit: number } | null>(null)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => { platformApi.creditNotes(offset).then(({ data }) => { setPage(data); setError('') }).catch(err => setError(errMsg(err, 'Credit notes unavailable'))) }, [offset, reloadKey])
  return <>
    <div className="mb-2.5 flex items-center gap-2"><Btn p disabled={!canManage || !enabled} title={!enabled ? 'Credit notes are switched off in Control Center' : !canManage ? 'Needs Billing manage access' : undefined} onClick={onNew}><Ic n="plus" /> Issue credit note</Btn></div>
    {error && <Note className="mb-2">{error}</Note>}
    {!page ? <Loading /> : !page.items.length ? <Empty>No credit notes issued yet</Empty> : <div className="rounded-md border" style={{ borderColor: C.ln }}>
      <Table head={['Credit note', 'Tenant', { t: 'Amount', r: true }, 'Reason', 'Issued']} minWidth={640}>
        {page.items.map(n => <tr key={n.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/platform/tenants/${n.tenant_id}`)}><td><b className="font-mono">{n.number}</b> <small style={{ color: C.mu }}>on {n.invoice}</small></td><td>{n.tenant}</td><td className="text-right">{rupees(n.amount)}</td>
          <td>{n.reason}</td><td className="whitespace-nowrap" title={n.issued_by ? `by ${n.issued_by}` : undefined}>{fd(n.issued_at)}</td></tr>)}
      </Table>
      {page.total > page.limit && <div className="bw-pgn"><span className="flex-1">{page.offset + 1}–{Math.min(page.offset + page.limit, page.total)} of {num(page.total)}</span>
        <Btn s disabled={!page.offset} onClick={() => setOffset(Math.max(0, offset - page.limit))}>‹</Btn><Btn s disabled={page.offset + page.limit >= page.total} onClick={() => setOffset(offset + page.limit)}>›</Btn></div>}
    </div>}
  </>
}

export default function PlatformInvoicesPage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<InvoicingOverview | null>(null)
  const [error, setError] = useState('')
  const [params, setParams] = useSearchParams()
  const tab = (TABS as readonly string[]).includes(params.get('tab') || '') ? params.get('tab')! : TABS[0]
  const setTab = (t: string) => setParams({ tab: t }, { replace: true })
  const [modal, setModal] = useState<{ kind: 'run' } | { kind: 'pay'; row: InvoiceRow } | { kind: 'credit'; row?: InvoiceRow } | null>(null)
  const [creditKey, setCreditKey] = useState(0)
  const [verifying, setVerifying] = useState('')

  const load = useCallback(async () => {
    try { const { data: d } = await platformApi.invoicing(); setData(d); setError('') } catch (err) { setError(errMsg(err, 'Invoices & dunning unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])
  const reloadAll = useCallback(() => { void load(); setCreditKey(n => n + 1) }, [load])
  const closeModal = useCallback(() => setModal(null), [])

  const canManage = can('billing', 'manage')
  const platformWide = canManage && !!data?.all_scope
  const noWide = !canManage ? 'Needs Billing manage access' : data && !data.all_scope ? 'Needs all-tenant scope' : undefined
  const save = (key: Parameters<typeof platformApi.updateInvoicingSetting>[0]) => async (values: Record<string, unknown>) => {
    try { await platformApi.updateInvoicingSetting(key, values); success('Saved'); await load() } catch (err) { showError(errMsg(err, 'Not saved')); throw err }
  }
  const verify = async (g: GatewayCard) => {
    setVerifying(g.key)
    try { const { data: c } = await platformApi.verifyGateway(g.key); (c.status === 'Connected' || c.status === 'Available' ? success : showError)(`${c.name}: ${c.status}`, c.detail ?? undefined); await load() }
    catch (err) { showError(errMsg(err, 'Verification failed')) } finally { setVerifying('') }
  }
  const k = data?.kpis

  let body: ReactNode = <Loading />
  if (data && tab === 'Invoices') body = <InvoicesTab data={data} canManage={canManage} reloadAll={reloadAll} onPay={row => setModal({ kind: 'pay', row })} onCredit={row => setModal({ kind: 'credit', row })} />
  else if (data && tab === 'Credit notes') body = <CreditNotesTab canManage={canManage} enabled={data.credit_notes_enabled} reloadKey={creditKey} onNew={() => setModal({ kind: 'credit' })} />
  else if (data && tab === 'Dunning') {
    const p = data.dunning.policy
    body = <>
      <Note info className="mb-2.5">When a payment fails or an invoice is overdue, Azcentrix retries and reminds automatically before it limits access.</Note>
      <div className="bw-g g2">
        <Panel title="Retry & reminder schedule" flush><div className="bw-list">{data.dunning.steps.map(s => <div key={s.key}>
          <b style={{ width: 60, flex: 'none' }}>Day {s.day}</b>
          <span className="flex-1">{s.text}{(s.key === 'readonly' || s.key === 'suspend' || s.key === 'd0') && <small className="block" style={{ color: C.mu }}>{data.dunning.notes[s.key === 'd0' ? 'retry' : s.key as 'readonly' | 'suspend']}</small>}</span>
          <Switch on={s.on} label={`Day ${s.day}`} disabled={!platformWide} onChange={v => void save('dunning_steps')({ [s.key]: v }).catch(() => undefined)} />
        </div>)}</div></Panel>
        <Panel title="Policy"><div className="grid gap-x-3 gap-y-[9px] sm:grid-cols-2">
          {POLICY.map(([key, label, step]) => <Field key={key} label={label}><SaveField type="number" step={step} value={String(p[key])} disabled={!platformWide} onSave={v => save('dunning_policy')({ [key]: key === 'late_fee_pct' ? v : Number(v) })} /></Field>)}
          <label className="flex items-center gap-2 sm:col-span-2"><Switch on={p.pause_on_plan} label="Pause dunning" disabled={!platformWide} onChange={v => void save('dunning_policy')({ pause_on_plan: v }).catch(() => undefined)} /> Pause dunning for tenants with an approved payment plan</label>
          {data.payment_plans.length > 0 && <small className="sm:col-span-2" style={{ color: C.mu }}>Approved payment plans: {data.payment_plans.map(pl => `${pl.tenant} (until ${fd(pl.until)})`).join(', ')}</small>}
        </div></Panel>
      </div>
    </>
  } else if (data && tab === 'Tax & e-invoice') {
    const g = data.gst
    body = <>
      {(g.problem || !g.tax_on) && <Note className="mb-2.5">{g.problem ?? 'Tax is off in Control Center (Calculate tax automatically) – invoices carry no GST.'}</Note>}
      <div className="bw-g g2">
        <Panel title="GST"><div className="grid gap-x-3 gap-y-[9px] sm:grid-cols-2">
          <Field label="Platform GSTIN"><SaveField value={g.gstin} maxLength={15} disabled={!platformWide} onSave={v => save('gst')({ gstin: v })} /></Field>
          <Field label="HSN / SAC"><SaveField value={g.sac} maxLength={6} disabled={!platformWide} onSave={v => save('gst')({ sac: v })} /></Field>
          <Field label="Default rate (%)"><SaveField type="number" value={String(g.rate)} disabled={!platformWide} onSave={v => save('gst')({ rate: Number(v) })} /></Field>
          <Field label="Place of supply"><select className={`${inputCls} w-full`} value={g.supply} disabled={!platformWide} onChange={e => void save('gst')({ supply: e.target.value }).catch(() => undefined)}>
            {Object.entries(g.supply_options).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        </div></Panel>
        <Panel title="E-invoicing" flush>
          <div className="bw-list">{EINVOICE.map(([key, label]) => <div key={key}><Switch on={data.einvoice.configured && !!data.einvoice[key]} label={label} disabled={!platformWide || !data.einvoice.configured}
            onChange={v => void save('einvoice')({ [key]: v }).catch(() => undefined)} /><span className="flex-1">{label}</span></div>)}</div>
          {!data.einvoice.configured && <div className="px-3 py-2 text-xs" style={{ color: C.mu }}>{data.einvoice.detail}</div>}
        </Panel>
      </div>
    </>
  } else if (data) {
    body = <div className="bw-g g3">{data.gateways.map(g => <div key={g.key} className="bw-panel">
      <div className="ph">{g.name}<span className="flex-1" /><Switch on={g.enabled} label={g.name} disabled={!platformWide || (!g.configured && !g.enabled)} onChange={v => void save('gateways')({ [g.key]: v }).catch(() => undefined)} /></div>
      <div className="pb">
        <div style={{ color: C.mu }}>{g.description}</div>
        <div className="mt-2 flex items-center gap-2"><Pill t={gwTone(g.status)} title={g.detail ?? undefined}>{g.status}</Pill>
          {g.can_verify && g.status !== 'Off' && g.status !== 'Connected' && g.status !== 'Available' && <Btn s disabled={!platformWide || verifying === g.key} title={noWide} onClick={() => void verify(g)}>{verifying === g.key ? 'Verifying…' : 'Verify'}</Btn>}</div>
        {g.detail && <small className="mt-1.5 block" style={{ color: C.mu }}>{g.detail}</small>}
      </div>
    </div>)}</div>
  }

  return <div>
    {modal?.kind === 'run' && <RunBilling onClose={closeModal} onDone={reloadAll} />}
    {modal?.kind === 'pay' && data && <MarkPaid row={modal.row} gateways={data.gateways} onClose={closeModal} onDone={reloadAll} />}
    {modal?.kind === 'credit' && <NewCredit invoice={modal.row} onClose={closeModal} onDone={() => { reloadAll(); if (!modal.row) setTab('Credit notes') }} />}
    <PageHead crumb="Business" title="Invoices & dunning">
      <Btn disabled={!data || !platformWide} title={noWide ?? 'Raise this period’s invoices for every paying tenant'} onClick={() => setModal({ kind: 'run' })}><Ic n="doc" /> Run billing</Btn>
    </PageHead>
    {error && <Note className="mb-2">{error}</Note>}
    <Strip items={[
      { l: 'Invoiced · month', v: k ? inr(k.invoiced_month) : '—', kpi: 'invoices.invoiced_month', title: k ? `${num(k.invoices_month)} invoice(s) issued this month, incl. GST` : undefined },
      { l: 'Collected', v: k ? inr(k.collected_month) : '—', kpi: 'invoices.collected', dc: 'tok', title: 'Payments received this month' },
      { l: 'Due', v: k ? inr(k.due) : '—', kpi: 'invoices.due', title: 'Unpaid balance of invoices not yet past their due date' },
      { l: 'Overdue / failed', v: k ? inr(k.overdue) : '—', kpi: 'invoices.overdue', dc: 'tbad', title: 'Unpaid balance past the due date or with a failed payment' },
      { l: 'At-risk tenants', v: k ? num(k.at_risk_tenants) : '—', kpi: 'invoices.at_risk', dc: 'twarn', title: 'Tenants with an overdue or failed invoice' },
    ]} />
    <div className="bw-panel">
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      <div className={`pb ${tab === 'Invoices' ? 'z' : ''}`}>{body}</div>
    </div>
  </div>
}
