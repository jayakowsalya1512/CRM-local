// Trip drawer – prototype v17 openRec('travel'): header (purpose · ID · company · status), Edit / Delete, tabs Overview ·
// Itinerary & expenses · Activity · Documents · Notes. Itinerary & expenses = kv(Route · Dates · Mode · Estimate · Advance),
// "Expenses" table Head | Amount and "+ Add expense" (real entry form + receipt upload instead of the prototype's random line).
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Pill } from '@/pages/customers/kit'
import { errMsg, fd, inr, moneyOk, todayIso, tone, trApi, type Detail, type Meta } from './travelApi'

const TABS = ['Overview', 'Itinerary & expenses', 'Activity', 'Documents', 'Notes'] as const
type Tab = typeof TABS[number]
const dt = (s: string | null) => s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
const DOC_TYPES = ['Receipt', 'Invoice', 'Ticket', 'Hotel Bill', 'Other']
const FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.csv'

export default function TripDrawer({ id, meta, onClose, onChanged }: { id: number; meta: Meta; onClose: () => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const { success, error } = useToast()
  const [d, setD] = useState<Detail | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [tab, setTab] = useState<Tab>('Overview')
  const [busy, setBusy] = useState(false)
  const [dlg, setDlg] = useState<null | 'expense' | 'upload' | 'delete' | 'disbursed' | 'refunded'>(null)
  const [note, setNote] = useState('')

  const load = useCallback(() => { setLoadErr(''); trApi.get(id).then(setD).catch(e => { setD(null); setLoadErr(errMsg(e, 'Could not open this trip')) }) }, [id])
  useEffect(() => { setD(null); setTab('Overview'); load() }, [load])
  const refresh = useCallback(() => { load(); onChanged() }, [load, onChanged])
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !dlg && !document.querySelector('.bwi-ov')) onClose() }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [onClose, dlg])
  const run = async (fn: () => Promise<unknown>, ok: string, bad: string, after?: () => void) => {
    if (busy) return
    setBusy(true)
    try { await fn(); success(ok); setDlg(null); after ? after() : refresh() } catch (e) { error(bad, errMsg(e)) } finally { setBusy(false) }
  }
  const host = document.querySelector('.crm-shell') ?? document.body
  const a = d?.actions

  const body = loadErr ? <div className="dcard empty">{loadErr} · <a onClick={load}>Retry</a></div> : !d ? <div className="empty">Loading…</div>
    : tab === 'Overview' ? <>
      <div className="kvp">
        {([['Traveller', d.traveller], ['Department', d.department || '—'], ['Reporting manager', d.manager || '—'], ['Purpose', d.purpose],
          ['From', d.from || '—'], ['To', d.to], ['Start', fd(d.start)], ['End', fd(d.end)], ['Mode', d.mode], ['Cost', inr(d.cost)],
          ['Advance', inr(d.advance)], ['Status', <Pill key="s" s={d.status} t={tone(d.status)} />], ['Raised by', d.created_by || '—'],
          ['Created', d.created_at ? fd(d.created_at) : '—'], ...(d.approved_by ? [['Approved by', `${d.approved_by}${d.approved_at ? ` · ${fd(d.approved_at)}` : ''}`]] : [])] as [string, React.ReactNode][])
          .map(([l, v]) => <div key={l}><span>{l}</span><span>{v}</span></div>)}
      </div>
      {d.raw_status === 'Rejected' && <div className="note">Trip rejected{d.rejection_reason ? `: ${d.rejection_reason}` : ''}. Edit and resubmit it for approval.</div>}
    </>
      : tab === 'Itinerary & expenses' ? <>
        <div className="kvp">
          <div><span>Route</span><span>{d.from || '—'} → {d.to}</span></div>
          <div><span>Dates</span><span>{fd(d.start)} – {fd(d.end)}</span></div>
          <div><span>Mode</span><span>{d.mode}</span></div>
          <div><span>Estimate</span><span>{inr(d.cost)}</span></div>
          <div><span>Advance</span><span title={`Requested ₹${d.advance.toLocaleString('en-IN')} · disbursed ₹${d.advance_issued.toLocaleString('en-IN')} · adjusted ₹${d.advance_adjusted.toLocaleString('en-IN')} · outstanding ₹${d.advance_outstanding.toLocaleString('en-IN')}`}>{inr(d.advance)}</span></div>
        </div>
        <h3 className="mt mb">Expenses</h3>
        {d.expenses.length ? <table className="t"><thead><tr><th>Head</th><th className="r">Amount</th></tr></thead><tbody>
          {d.expenses.map(x => <tr key={x.id}><td title={`${fd(x.date)} · ${x.description}`}>{x.head}
            {x.receipts.length > 0 ? <span className="rc"> · {x.receipts.map(r => <a key={r.id} href={r.url} target="_blank" rel="noreferrer">{r.type}</a>)}</span>
              : d.claim && ['Draft', 'Rejected'].includes(d.claim.status) ? <small className="twarn"> · receipt needed</small> : null}
            {a?.add_expense && <> <a role="button" title="Remove this expense" onClick={() => run(() => trApi.delExpense(d.id, x.id), 'Expense removed', 'Could not remove the expense')}><Ic n="x" size={11} /></a></>}</td>
            <td className="r">{inr(x.amount)}</td></tr>)}</tbody></table>
          : <div className="empty" style={{ padding: 16 }}>No records match. Adjust filters or create a new record.</div>}
        <button type="button" className="btn mt" disabled={!a?.add_expense || busy} onClick={() => setDlg('expense')}
          title={a?.add_expense ? undefined : d.traveller_id !== meta.me.id ? 'Only the traveller adds expenses' : !['Approved', 'Completed'].includes(d.raw_status) ? 'Expenses can be added once the trip is approved' : 'The claim has been submitted'}><Ic n="plus" /> Add expense</button>
        {(d.claim || d.advance_issued > 0 || a?.submit || a?.complete || a?.advance) && <div className="note inf">
          {d.claim && <div>Claim <b>{d.claim.no}</b>: <Pill s={d.claim.label} t={tone(d.claim.label)} /> · claimed {inr(d.claimed)} · advance {inr(d.advance_issued)} · balance {inr(d.balance)}
            {d.claim.reason && d.claim.label === 'Rejected' ? <> · returned: {d.claim.reason}</> : null}
            {d.claim.payment_date ? <> · paid {fd(d.claim.payment_date)}{d.claim.payment_reference ? ` (${d.claim.payment_reference})` : ''}</> : null}</div>}
          {d.advance > 0 && <div>Advance: requested {inr(d.advance)} · disbursed {inr(d.advance_issued)} · outstanding {inr(d.advance_outstanding)}</div>}
          <div className="row mt">
            {a?.submit && <button type="button" className="btn s p" disabled={busy} onClick={() => run(() => trApi.update(d.id, { traveller_id: d.traveller_id, purpose: d.purpose, from: d.from, to: d.to, start: d.start || '', end: d.end || '', mode: d.mode, cost: String(d.cost), advance: String(d.advance) }), 'Trip submitted for approval', 'Could not submit the trip')}>Submit for approval</button>}
            {a?.submit_claim && <button type="button" className="btn s p" disabled={busy} onClick={() => run(() => trApi.submitClaim(d.id), 'Claim submitted for approval', 'Claim not submitted')}>Submit claim</button>}
            {a?.complete && <button type="button" className="btn s" disabled={busy} onClick={() => run(() => trApi.complete(d.id), 'Trip marked completed', 'Could not complete the trip')}><Ic n="check" /> Mark completed</button>}
            {a?.advance && d.advance_issued < d.advance && <button type="button" className="btn s" disabled={busy} onClick={() => setDlg('disbursed')}>Record advance paid</button>}
            {a?.advance && d.advance_outstanding > 0 && <button type="button" className="btn s" disabled={busy} onClick={() => setDlg('refunded')}>Record advance refund</button>}
          </div>
        </div>}
      </>
        : tab === 'Activity' ? (d.activity.length ? <div className="tl">{d.activity.map((x, i) => <div key={i}><b>{x.t}</b><br /><small>{x.by || 'System'}{x.d ? ` · ${dt(x.d)}` : ''}</small></div>)}</div> : <div className="empty">No activity yet</div>)
          : tab === 'Documents' ? <>
            {d.documents.length ? <table className="t"><thead><tr><th>File</th><th>Expense</th><th>Uploaded</th></tr></thead><tbody>
              {d.documents.map(x => <tr key={x.id}><td><a href={x.url} target="_blank" rel="noreferrer">{x.name}</a> <small className="mu">{x.type}</small></td><td>{x.expense}</td><td>{x.by}{x.at ? ` · ${fd(x.at)}` : ''}</td></tr>)}
            </tbody></table> : <div className="empty">No documents linked yet</div>}
            <button type="button" className="btn mt" disabled={!a?.add_expense || !d.expenses.length || busy} onClick={() => setDlg('upload')}
              title={!d.expenses.length ? 'Add an expense first – every document is a proof for an expense' : !a?.add_expense ? 'Only the traveller can upload while the claim is open' : undefined}><Ic n="up" /> Upload document</button>
          </>
            : <>
              <div className="list">{d.notes.length ? d.notes.map(n => <div key={n.id} style={{ display: 'block' }}>{n.body}<br /><small className="mu">{n.by} · {dt(n.at)}</small></div>) : <div className="mu">No notes yet</div>}</div>
              <textarea className="in mt" rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note, @mention a teammate…" maxLength={5000} />
              <button type="button" className="btn p mt" disabled={!note.trim() || busy} onClick={() => run(async () => { const r = await trApi.note(d.id, note); setD(x => x ? { ...x, notes: r.notes } : x); setNote('') }, 'Note added', 'Could not add the note', () => undefined)}>Add note</button>
            </>

  return createPortal(<div className="bwi">
    <div className="bwi-dwo" onMouseDown={onClose} />
    <aside className="bwi-dw trv" role="dialog" aria-modal="true" aria-label={d ? `Trip ${d.code}` : 'Trip'}>
      <div className="dh">
        <div className="fl">
          <h2>{d?.purpose || (loadErr ? 'Trip' : 'Loading…')}</h2>
          {d && <div className="sub"><span>{d.code}</span> · <Pill s={d.company || 'Workspace'} t="ac" /> · <Pill s={d.status} t={tone(d.status)} /></div>}
        </div>
        {a?.edit && <button type="button" className="btn s" onClick={() => navigate(`/travel/${d!.id}/edit`)}><Ic n="edit" /> Edit</button>}
        {a?.delete && <button type="button" className="btn s d" title="Delete" aria-label="Delete trip" onClick={() => setDlg('delete')}><Ic n="trash" /></button>}
        <button type="button" className="btn g ib" onClick={onClose} aria-label="Close"><Ic n="x" /></button>
      </div>
      <div className="tabs" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}</div>
      <div className="db">{body}</div>
    </aside>
    {d && dlg === 'expense' && <ExpenseModal d={d} meta={meta} onClose={() => setDlg(null)} onDone={() => { setDlg(null); refresh() }} />}
    {d && dlg === 'upload' && <UploadModal d={d} meta={meta} onClose={() => setDlg(null)} onDone={() => { setDlg(null); refresh() }} />}
    {d && (dlg === 'disbursed' || dlg === 'refunded') && <AdvanceModal d={d} kind={dlg} onClose={() => setDlg(null)} onDone={() => { setDlg(null); refresh() }} />}
    {d && dlg === 'delete' && <Modal title="Delete trip?" width={440} onClose={() => setDlg(null)} foot={<><span className="fl" />
      <button type="button" className="btn" onClick={() => setDlg(null)}>Cancel</button>
      <button type="button" className="btn d" disabled={busy} onClick={() => run(() => trApi.remove(d.id), 'Trip deleted', 'Could not delete the trip', () => { onChanged(); onClose() })}>Delete</button></>}>
      <p style={{ margin: 0 }}>Delete {d.code} ({d.purpose})? Only draft or rejected trips without expenses can be deleted; the deletion is logged.</p>
    </Modal>}
  </div>, host)
}

function FileField({ meta, file, setFile, err }: { meta: Meta; file: File | null; setFile: (f: File | null) => void; err?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  return <div className="f1"><label>Receipt / supporting document</label>
    <div className="row" style={{ gap: 6, alignItems: 'center' }}>
      <button type="button" className="btn s" onClick={() => ref.current?.click()}><Ic n="up" /> {file ? 'Change file' : 'Choose file'}</button>
      <small className="mu">{file ? `${file.name} · ${Math.ceil(file.size / 1024)} KB` : `PDF, image or office file · up to ${meta.max_receipt_mb} MB`}</small>
    </div>
    <input ref={ref} type="file" hidden accept={FILE_ACCEPT} onChange={e => { setFile(e.target.files?.[0] || null); e.target.value = '' }} />
    {err && <div className="ferr">{err}</div>}</div>
}
const fileErr = (meta: Meta, f: File | null) => !f ? '' : f.size > meta.max_receipt_mb * 1024 * 1024 ? `File is larger than ${meta.max_receipt_mb} MB`
  : !FILE_ACCEPT.split(',').includes(`.${(f.name.split('.').pop() || '').toLowerCase()}`) ? 'This file type is not allowed' : ''

function ExpenseModal({ d, meta, onClose, onDone }: { d: Detail; meta: Meta; onClose: () => void; onDone: () => void }) {
  const { success, error, warning } = useToast()
  const [v, setV] = useState({ head: '', amount: '', date: todayIso() > (d.end || '') && d.end ? d.end : todayIso(), description: '' })
  const [file, setFile] = useState<File | null>(null)
  const [bad, setBad] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const e: Record<string, string> = {}
    if (!v.head) e.head = 'Choose an expense head'
    if (!moneyOk(v.amount, true)) e.amount = 'Enter an amount greater than zero, with at most 2 decimals'
    if (!v.date) e.date = 'Choose the expense date'
    else if (v.date > todayIso()) e.date = "Expense date can't be in the future"
    const fe = fileErr(meta, file); if (fe) e.file = fe
    setBad(e)
    if (Object.keys(e).length || busy) return
    setBusy(true)
    try {
      const r = await trApi.addExpense(d.id, { head: v.head, amount: v.amount.trim(), date: v.date, description: v.description.trim() })
      if (file) {
        try { await trApi.receipt(d.id, r.id, file) } catch (er) { warning('Expense added, receipt not uploaded', errMsg(er)); onDone(); return }
      }
      success('Expense added', file ? 'Receipt attached' : 'Attach a receipt before submitting the claim')
      onDone()
    } catch (er) { error('Expense not added', errMsg(er)) } finally { setBusy(false) }
  }
  return <Modal title={`Add expense – ${d.code}`} width={520} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add expense'}</button></>}>
    <div className="fg2">
      <div><label>Head *</label><select className={`in ${bad.head ? 'bad' : ''}`} value={v.head} onChange={e => setV({ ...v, head: e.target.value })}><option value="">— select —</option>{meta.heads.map(h => <option key={h}>{h}</option>)}</select>{bad.head && <div className="ferr">{bad.head}</div>}</div>
      <div><label>Amount (₹) *</label><input className={`in ${bad.amount ? 'bad' : ''}`} inputMode="decimal" value={v.amount} onChange={e => setV({ ...v, amount: e.target.value })} placeholder="0.00" />{bad.amount && <div className="ferr">{bad.amount}</div>}</div>
      <div><label>Date *</label><input className={`in ${bad.date ? 'bad' : ''}`} type="date" max={todayIso()} value={v.date} onChange={e => setV({ ...v, date: e.target.value })} />{bad.date && <div className="ferr">{bad.date}</div>}</div>
      <div><label>Description</label><input className="in" maxLength={500} value={v.description} onChange={e => setV({ ...v, description: e.target.value })} placeholder="e.g. Taxi airport → client site" /></div>
      <FileField meta={meta} file={file} setFile={setFile} err={bad.file} />
    </div>
    <small className="mu">Each expense needs a receipt before the claim can be submitted.</small>
  </Modal>
}

function UploadModal({ d, meta, onClose, onDone }: { d: Detail; meta: Meta; onClose: () => void; onDone: () => void }) {
  const { success, error } = useToast()
  const [item, setItem] = useState<number>(d.expenses.find(x => !x.receipts.length)?.id || d.expenses[0]?.id || 0)
  const [type, setType] = useState('Receipt')
  const [file, setFile] = useState<File | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const fe = !file ? 'Choose a file' : fileErr(meta, file)
    setErr(fe)
    if (fe || busy || !file) return
    setBusy(true)
    try { await trApi.receipt(d.id, item, file, type); success('Document uploaded'); onDone() } catch (e) { error('Upload failed', errMsg(e)) } finally { setBusy(false) }
  }
  return <Modal title="Upload document" width={480} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Uploading…' : 'Upload'}</button></>}>
    <div className="fg2">
      <div className="f1"><label>For expense *</label><select className="in" value={item} onChange={e => setItem(Number(e.target.value))}>{d.expenses.map(x => <option key={x.id} value={x.id}>{x.head} · {inr(x.amount)} · {fd(x.date)}{x.receipts.length ? '' : ' (no receipt yet)'}</option>)}</select></div>
      <div><label>Document type</label><select className="in" value={type} onChange={e => setType(e.target.value)}>{DOC_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
      <FileField meta={meta} file={file} setFile={setFile} err={err} />
    </div>
  </Modal>
}

function AdvanceModal({ d, kind, onClose, onDone }: { d: Detail; kind: 'disbursed' | 'refunded'; onClose: () => void; onDone: () => void }) {
  const { success, error } = useToast()
  const max = kind === 'disbursed' ? d.advance - d.advance_issued : d.advance_outstanding
  const [v, setV] = useState({ amount: String(Math.max(0, Math.round(max * 100) / 100)), date: todayIso(), reference: '', mode: 'Bank Transfer' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const e = !moneyOk(v.amount, true) ? 'Enter an amount greater than zero' : Number(v.amount) > max + 1e-9 ? `At most ${inr(max)}` : ''
    setErr(e)
    if (e || busy) return
    setBusy(true)
    try { await trApi.advance(d.id, { kind, ...v }); success(kind === 'disbursed' ? 'Advance disbursement recorded' : 'Advance refund recorded'); onDone() }
    catch (er) { error('Not recorded', errMsg(er)) } finally { setBusy(false) }
  }
  return <Modal title={kind === 'disbursed' ? `Record advance paid – ${d.code}` : `Record advance refund – ${d.code}`} width={460} onClose={onClose}
    foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Record'}</button></>}>
    <div className="fg2">
      <div><label>Amount (₹) *</label><input className={`in ${err ? 'bad' : ''}`} inputMode="decimal" value={v.amount} onChange={e => setV({ ...v, amount: e.target.value })} />{err && <div className="ferr">{err}</div>}</div>
      <div><label>Date *</label><input className="in" type="date" max={todayIso()} value={v.date} onChange={e => setV({ ...v, date: e.target.value })} /></div>
      <div><label>Mode</label><select className="in" value={v.mode} onChange={e => setV({ ...v, mode: e.target.value })}>{['Bank Transfer', 'UPI', 'Cheque', 'Cash'].map(x => <option key={x}>{x}</option>)}</select></div>
      <div><label>Reference</label><input className="in" maxLength={120} value={v.reference} onChange={e => setV({ ...v, reference: e.target.value })} placeholder="UTR / voucher no." /></div>
    </div>
  </Modal>
}
