// Guarantees & Deposits – prototype v18 modals: A.gdNew (New guarantee / deposit request), A.gdPay (Finance pays / issues),
// A.gdRet (refund / release), A.gdRecv (mark received back), A.gdAck (Finance acknowledgement), A.gdExt (extend
// validity), A.gdForf (mark forfeited), A.gdWithdraw and A.gdResub (revise & resubmit). Every action is validated again
// by FastAPI – nothing here changes a status on its own.
import { useEffect, useState, type ReactNode } from 'react'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { addDays, dto, errMsg, fd, inr, insApi, todayIso, type Defaults, type Detail, type Meta, type Option, type Row } from './instrumentApi'

type Vals = Record<string, string>
const F = ({ label, req, children, full, err }: { label: string; req?: boolean; children: ReactNode; full?: boolean; err?: string }) =>
  <div className={full ? 'f1' : ''}><label>{label}{req && <> <b className="tbad">*</b></>}</label>{children}{err && <small className="tbad" role="alert">{err}</small>}</div>

function Shell({ title, width = 560, busy, ok, okLabel = 'Save', onClose, children }: { title: ReactNode; width?: number; busy: boolean; ok: () => void; okLabel?: string; onClose: () => void; children: ReactNode }) {
  return <Modal title={title} width={width} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={ok}>{busy ? 'Saving…' : okLabel}</button></>}>{children}</Modal>
}

function useRun(onDone: (msg: string) => void) {
  const { error } = useToast()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, msg: string | ((r: any) => string)) => {
    setBusy(true)
    try { const r = await fn(); onDone(typeof msg === 'function' ? msg(r) : msg) } catch (e) { error(errMsg(e, 'Could not save')) } finally { setBusy(false) }
  }
  return { busy, run }
}

/* ── New guarantee / deposit request ── */
export function NewRequestModal({ meta, tenderId, onClose, onDone }: { meta: Meta; tenderId?: number | null; onClose: () => void; onDone: (msg: string, id: number) => void }) {
  const { error } = useToast()
  const [opts, setOpts] = useState<{ tenders: Option[]; orders: Option[] } | null>(null)
  const [v, setV] = useState<Vals>({ against: tenderId ? `t:${tenderId}` : '', type: 'EMD', amount: '', mode: meta.modes[0], due: '', bene: '', at: '', bank: meta.config.preferred_bank, remarks: '', cert: '' })
  const [df, setDf] = useState<Defaults | null>(null)
  const [err, setErr] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => { insApi.options().then(setOpts).catch(e => error(errMsg(e, 'Could not load tenders'))) }, [error])
  const [kind, idStr] = v.against.split(':')
  const tid = kind === 't' ? Number(idStr) : null, wid = kind === 'w' ? Number(idStr) : null
  useEffect(() => {   // tender / order + instrument → amount, mode, required-by, beneficiary, payable at
    if (!tid && !wid) { setDf(null); return }
    let live = true
    insApi.defaults(v.type, tid, wid).then(d => { if (!live) return; setDf(d)
      setV(s => ({ ...s, amount: d.amount != null ? String(d.amount) : '', mode: d.req === 'Exempted' ? meta.exempt_mode : (d.mode || s.mode), due: d.due && d.due >= todayIso() ? d.due : addDays(todayIso(), 5),
        bene: d.bene || '', at: d.at || '', bank: d.bank || s.bank, cert: d.cert || '' })) }).catch(e => error(errMsg(e, 'Could not load the tender details')))
    return () => { live = false }
  }, [tid, wid, v.type]) // eslint-disable-line react-hooks/exhaustive-deps
  const exempt = v.mode === meta.exempt_mode
  const modes = meta.modes.filter(m => m !== meta.exempt_mode || ['EMD', 'TF'].includes(v.type))
  const set = (k: string) => (e: { target: { value: string } }) => setV(s => ({ ...s, [k]: e.target.value }))
  const submit = async () => {
    const x: Record<string, string> = {}
    if (!tid && !wid) x.against = 'Choose the tender'
    if (!meta.types.some(t => t.key === v.type)) x.type = 'Choose the instrument'
    if (!exempt && !(Number(v.amount) > 0)) x.amount = 'Enter an amount greater than zero'
    if (!exempt && !v.due) x.due = 'Enter the required-by date'
    else if (v.due && v.due < todayIso()) x.due = 'Required by cannot be in the past'
    if (!exempt && !v.bene.trim()) x.bene = 'Enter the beneficiary'
    if (exempt && v.cert.trim().length < 4) x.cert = 'Enter the exemption certificate / reference'
    setErr(x)
    if (Object.keys(x).length) return
    setBusy(true)
    try {
      const r = await insApi.create({ tender_id: tid, wo_id: wid, type: v.type, amount: v.amount === '' ? 0 : Number(v.amount), mode: v.mode, due: v.due || null, bene: v.bene || null,
        at: v.at || null, bank: v.bank || null, remarks: v.remarks || null, cert: exempt ? v.cert : null })
      onDone(r.message, r.id)
    } catch (e) { error(errMsg(e, 'Could not send the request')) } finally { setBusy(false) }
  }
  return <Shell title={<><Ic n="shield" /> New guarantee / deposit request</>} width={640} busy={busy} ok={submit} okLabel={exempt ? 'Record exemption' : 'Send for approval'} onClose={onClose}>
    <div className="note inf mb">The request goes to the Sales Head for approval, then to Finance to pay and enter the UTR or issue the instrument.{Number(v.amount) >= meta.high_value ? ' Requests of ₹50 lakh or above also need Company Admin approval.' : ''}</div>
    <div className="fg">
      <F label="Against tender" req full err={err.against}><select className="in" value={v.against} onChange={set('against')} aria-label="Against tender">
        <option value="">{opts ? 'Select tender…' : 'Loading…'}</option>
        {opts && opts.tenders.length > 0 && <optgroup label="Tenders">{opts.tenders.map(t => <option key={t.id} value={`t:${t.id}`}>{t.ref} · {t.customer.slice(0, 28)} · {t.title.slice(0, 34)}</option>)}</optgroup>}
        {opts && opts.orders.length > 0 && <optgroup label="Orders (PBG / security deposit)">{opts.orders.map(o => <option key={o.id} value={`w:${o.id}`}>{o.ref} · {o.customer.slice(0, 28)} · {o.title.slice(0, 30)}</option>)}</optgroup>}
      </select>{df && <small className="mu">{df.customer}{df.tender_no ? ` · ${df.tender_no}` : ''}{df.rule ? ` · ${df.rule}` : ''}</small>}</F>
      <F label="Instrument" err={err.type}><select className="in" value={v.type} onChange={set('type')}>{meta.types.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select></F>
      <F label="Amount (₹)" req={!exempt} err={err.amount}><input className="in" type="number" min={0} step="any" value={v.amount} onChange={set('amount')} /></F>
      <F label="Mode of payment"><select className="in" value={modes.includes(v.mode) ? v.mode : modes[0]} onChange={set('mode')}>{modes.map(m => <option key={m}>{m}</option>)}</select></F>
      <F label="Required by" req={!exempt} err={err.due}><input className="in" type="date" min={todayIso()} value={v.due} onChange={set('due')} /></F>
      <F label="Beneficiary" req={!exempt} err={err.bene}><input className="in" maxLength={200} value={v.bene} onChange={set('bene')} /></F>
      <F label="Payable at"><input className="in" maxLength={200} value={v.at} onChange={set('at')} /></F>
      <F label="Preferred bank"><select className="in" value={v.bank} onChange={set('bank')}>{meta.banks.map(b => <option key={b}>{b}</option>)}</select></F>
      {exempt && <F label="Exemption certificate" req err={err.cert}><input className="in" maxLength={150} value={v.cert} placeholder="MSE / Udyam or Startup India certificate no." onChange={set('cert')} /></F>}
      <F label="Remarks" full><input className="in" maxLength={2000} value={v.remarks} placeholder="e.g. Pay through the GeM portal before 5 pm" onChange={set('remarks')} /></F>
    </div>
  </Shell>
}

/* ── Finance: payment details / instrument details ── */
export function PayModal({ r, meta, onClose, onDone }: { r: Detail | Row; meta: Meta; onClose: () => void; onDone: (m: string) => void }) {
  const bg = r.bg && r.type_key !== 'TF', dd = r.mode === 'Demand draft'
  const [v, setV] = useState<Vals>({ ref: '', utr: '', txn_ref: '', bank: r.bank || meta.config.preferred_bank, pay_date: todayIso(), validity: r.validity || (bg ? addDays(r.due || todayIso(), 165) : r.type_key === 'EMD' ? addDays(r.due || todayIso(), 120) : ''),
    margin_pct: '10', margin_amount: '', charges: bg ? String(Math.round(r.amount * 0.008)) : dd ? '150' : '0', account: meta.accounts[0] || '', remarks: '' })
  const { busy, run } = useRun(onDone)
  const { error } = useToast()
  const set = (k: string) => (e: { target: { value: string } }) => setV(s => ({ ...s, [k]: e.target.value }))
  const mAmt = v.margin_amount !== '' ? Number(v.margin_amount) : Math.round(r.amount * Number(v.margin_pct || 0) / 100)
  const ok = () => {
    if (bg && !v.ref.trim()) return error('Enter the BG / bond number')
    if (bg && (!v.validity || v.validity <= v.pay_date)) return error('Enter a validity date after the issue date')
    if (!bg && dd && !v.ref.trim()) return error('Enter the DD number')
    if (!bg && !dd && !v.utr.trim()) return error('Enter the UTR / transaction reference')
    run(() => insApi.pay(r.id, { ...v, utr: v.utr || null, ref: v.ref || null, validity: v.validity || null, margin_pct: bg && meta.config.track_margin ? Number(v.margin_pct || 0) : null,
      margin_amount: bg && meta.config.track_margin ? mAmt : null, charges: v.charges === '' ? null : Number(v.charges) }), `${r.type} ${r.type_key === 'TF' ? 'marked paid' : bg ? 'issued' : 'paid'}`)
  }
  return <Shell title={<><Ic n="card" /> {bg ? 'Instrument details' : 'Payment details'} · {r.type} {inr(r.amount)}</>} busy={busy} ok={ok} onClose={onClose}>
    <div className="fg">
      <div className="f1 note inf">Approved by {r.approved_by || '—'} on {fd(r.approved_on)}. Required by <b>{fd(r.due)}</b>{r.due ? ` (${dto(r.due)} d)` : ''}. Beneficiary: {'bene' in r ? r.bene : r.customer}.</div>
      {bg ? <>
        <F label="BG / bond number" req><input className="in" maxLength={100} value={v.ref} onChange={set('ref')} /></F>
        <F label="Issuing bank"><select className="in" value={v.bank} onChange={set('bank')}>{meta.banks.map(b => <option key={b}>{b}</option>)}</select></F>
        <F label="Issue date"><input className="in" type="date" max={todayIso()} value={v.pay_date} onChange={set('pay_date')} /></F>
        <F label="Valid until" req><input className="in" type="date" min={v.pay_date} value={v.validity} onChange={set('validity')} /></F>
        {meta.config.track_margin && <><F label="Margin held (%)"><input className="in" type="number" min={0} max={100} step="any" value={v.margin_pct} onChange={set('margin_pct')} /></F>
          <F label="Margin / lien amount (₹)"><input className="in" type="number" min={0} step="any" value={v.margin_amount} placeholder={String(mAmt)} onChange={set('margin_amount')} /></F></>}
        <F label="Bank charges (₹)"><input className="in" type="number" min={0} step="any" value={v.charges} onChange={set('charges')} /></F>
      </> : <>
        {dd ? <F label="DD number" req><input className="in" maxLength={100} value={v.ref} placeholder="6-digit DD no." onChange={set('ref')} /></F>
          : <F label="UTR / transaction reference" req><input className="in" maxLength={100} value={v.utr} placeholder="e.g. SBIN2610270012345" onChange={set('utr')} /></F>}
        <F label={dd ? 'DD date' : 'Payment date'}><input className="in" type="date" max={todayIso()} value={v.pay_date} onChange={set('pay_date')} /></F>
        <F label="Transaction reference"><input className="in" maxLength={100} value={v.txn_ref} onChange={set('txn_ref')} /></F>
        <F label="Debited from"><input className="in" list="gd-accts" maxLength={150} value={v.account} placeholder="Company bank account" onChange={set('account')} />
          <datalist id="gd-accts">{meta.accounts.map(a => <option key={a} value={a} />)}</datalist></F>
        <F label="Bank charges (₹)"><input className="in" type="number" min={0} step="any" value={v.charges} onChange={set('charges')} /></F>
        {r.type_key !== 'TF' && <F label="Refund due by (bid validity)"><input className="in" type="date" min={v.pay_date} value={v.validity} onChange={set('validity')} /></F>}
      </>}
      <F label="Remarks" full><input className="in" maxLength={2000} value={v.remarks} onChange={set('remarks')} /></F>
    </div>
  </Shell>
}

/* ── Request refund / release ── */
export function RefundModal({ r, meta, onClose, onDone }: { r: Row; meta: Meta; onClose: () => void; onDone: (m: string) => void }) {
  const [v, setV] = useState<Vals>({ on: todayIso(), letter: '', reason: meta.ret_reasons[0] })
  const { busy, run } = useRun(onDone)
  const set = (k: string) => (e: { target: { value: string } }) => setV(s => ({ ...s, [k]: e.target.value }))
  return <Shell title="Request refund / release" busy={busy} onClose={onClose} ok={() => run(() => insApi.refund(r.id, v), (x: { message: string }) => x.message)}>
    <div className="fg">
      <F label="Requested on"><input className="in" type="date" max={todayIso()} value={v.on} onChange={set('on')} /></F>
      <F label="Letter reference"><input className="in" maxLength={100} value={v.letter} placeholder="e.g. LTR/26/104" onChange={set('letter')} /></F>
      <F label="Reason" full><select className="in" value={v.reason} onChange={set('reason')}>{meta.ret_reasons.map(x => <option key={x}>{x}</option>)}</select></F>
      {meta.config.release_approval && <div className="f1 note inf">Setup → Approval to request release is on – the request goes through Approvals before it is marked Release Requested.</div>}
    </div>
  </Shell>
}

/* ── Mark received back ── */
export function ReceiveModal({ r, meta, onClose, onDone }: { r: Row; meta: Meta; onClose: () => void; onDone: (m: string) => void }) {
  const bg = r.bg
  const [v, setV] = useState<Vals>({ on: todayIso(), amount: String(r.amount), mode: meta.recv_modes[0], ref: '', remarks: '' })
  const { busy, run } = useRun(onDone)
  const { error } = useToast()
  const set = (k: string) => (e: { target: { value: string } }) => setV(s => ({ ...s, [k]: e.target.value }))
  const ok = () => {
    if (!bg && !(Number(v.amount) > 0 && Number(v.amount) <= r.amount)) return error(`Amount received must be more than 0 and at most ${inr(r.amount)}`)
    run(() => insApi.receive(r.id, bg ? { on: v.on, ref: v.ref, remarks: v.remarks } : { ...v, amount: Number(v.amount) }), 'Marked received – sent to Finance for acknowledgement')
  }
  return <Shell title={<><Ic n="check" /> Mark {r.type} received back</>} busy={busy} ok={ok} onClose={onClose}>
    <div className="fg">
      <div className="f1 note inf">Finance will be asked to acknowledge this receipt against the bank statement.</div>
      {bg ? <><F label="Original returned on"><input className="in" type="date" max={todayIso()} value={v.on} onChange={set('on')} /></F>
        <F label="Courier / hand-over ref"><input className="in" maxLength={150} value={v.ref} onChange={set('ref')} /></F></>
        : <><F label="Amount received (₹)" req><input className="in" type="number" min={0} max={r.amount} step="any" value={v.amount} onChange={set('amount')} /></F>
          <F label="Received on"><input className="in" type="date" max={todayIso()} value={v.on} onChange={set('on')} /></F>
          <F label="Mode"><select className="in" value={v.mode} onChange={set('mode')}>{meta.recv_modes.map(m => <option key={m}>{m}</option>)}</select></F>
          <F label="Credit / cheque reference"><input className="in" maxLength={150} value={v.ref} onChange={set('ref')} /></F></>}
      <F label="Remarks" full><input className="in" maxLength={2000} value={v.remarks} onChange={set('remarks')} /></F>
    </div>
  </Shell>
}

/* ── Finance acknowledgement ── */
export function AckModal({ r, meta, onClose, onDone }: { r: Row; meta: Meta; onClose: () => void; onDone: (m: string) => void }) {
  const got = r.recv_amount ?? r.amount
  const [v, setV] = useState<Vals>({ on: todayIso(), ref: (r.recv_ref.match(/\d{5,}/) || [''])[0], amount: String(got), account: meta.accounts[0] || '', remarks: '' })
  const { busy, run } = useRun(onDone)
  const { error } = useToast()
  const set = (k: string) => (e: { target: { value: string } }) => setV(s => ({ ...s, [k]: e.target.value }))
  const short = got - Number(v.amount || 0)
  const ok = () => {
    if (!r.bg && !v.ref.trim()) return error('Enter the credit reference / UTR')
    if (!(Number(v.amount) >= 0 && Number(v.amount) <= got)) return error(`Amount credited must be between 0 and ${inr(got)}`)
    run(() => insApi.acknowledge(r.id, { ...v, amount: Number(v.amount) }), (x: { shortfall: number }) => `Acknowledged – instrument closed${x.shortfall ? ` · short by ${inr(x.shortfall)}` : ''}`)
  }
  return <Shell title={<><Ic n="check" /> Acknowledge receipt · {r.type}</>} busy={busy} ok={ok} onClose={onClose}>
    <div className="fg">
      <div className="f1 kvm"><div><span>Marked by</span><span>{r.recv_by || '—'} on {fd(r.recv_on)}</span></div><div><span>Amount</span><span>{inr(got)}</span></div><div><span>Reference</span><span>{r.recv_ref || '—'}</span></div></div>
      <F label="Bank credit date"><input className="in" type="date" min={r.recv_on || undefined} max={todayIso()} value={v.on} onChange={set('on')} /></F>
      <F label="Credit reference / UTR" req={!r.bg}><input className="in" maxLength={100} value={v.ref} onChange={set('ref')} /></F>
      <F label="Amount credited (₹)"><input className="in" type="number" min={0} max={got} step="any" value={v.amount} onChange={set('amount')} /></F>
      <F label="Credited to"><input className="in" list="gd-accts2" maxLength={150} value={v.account} placeholder="Company bank account" onChange={set('account')} />
        <datalist id="gd-accts2">{meta.accounts.map(a => <option key={a} value={a} />)}</datalist></F>
      {short > 0 && <div className="f1 note">Short by <b>{inr(short)}</b> – the difference is kept in the audit record.</div>}
      <F label="Remarks" full><input className="in" maxLength={2000} value={v.remarks} placeholder="e.g. Matched with bank statement" onChange={set('remarks')} /></F>
    </div>
  </Shell>
}

/* ── Extend validity ── */
export function ExtendModal({ r, onClose, onDone }: { r: Row; onClose: () => void; onDone: (m: string) => void }) {
  const base = r.validity && r.validity > todayIso() ? r.validity : todayIso()
  const [v, setV] = useState<Vals>({ validity: addDays(base, 90), reason: '' })
  const { busy, run } = useRun(onDone)
  const { error } = useToast()
  const ok = () => {
    if (!v.validity || (r.validity && v.validity <= r.validity)) return error(`The new validity must be after ${fd(r.validity)}`)
    if (!v.reason.trim()) return error('Give the reason for the extension')
    run(() => insApi.extend(r.id, v.validity, v.reason.trim()), (x: { message: string }) => x.message)
  }
  return <Shell title="Extend validity" busy={busy} ok={ok} onClose={onClose}>
    <div className="fg">
      <F label="Current validity"><input className="in" disabled value={fd(r.validity)} /></F>
      <F label="New validity" req><input className="in" type="date" min={addDays(r.validity || todayIso(), 1)} value={v.validity} onChange={e => setV(s => ({ ...s, validity: e.target.value }))} /></F>
      <F label="Reason" req full><input className="in" maxLength={500} value={v.reason} placeholder="Customer asked for bid validity extension" onChange={e => setV(s => ({ ...s, reason: e.target.value }))} /></F>
    </div>
  </Shell>
}

/* ── Mark forfeited (confirmation) ── */
export function ForfeitModal({ r, onClose, onDone }: { r: Row; onClose: () => void; onDone: (m: string) => void }) {
  const [v, setV] = useState<Vals>({ on: todayIso(), reason: '', remarks: '' })
  const { busy, run } = useRun(onDone)
  const { error } = useToast()
  return <Modal title="Mark forfeited?" width={480} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn d" disabled={busy} onClick={() => { if (v.reason.trim().length < 4) return error('Give the reason for the forfeiture'); run(() => insApi.forfeit(r.id, v), 'Marked forfeited') }}>Mark forfeited</button></>}>
    <p style={{ marginTop: 0 }}>Mark <b>{r.type} {inr(r.amount)}</b> for {r.tender || r.wo || '—'} · {r.customer} as forfeited by the customer? It leaves the outstanding total.</p>
    <div className="fg">
      <F label="Forfeiture date"><input className="in" type="date" max={todayIso()} value={v.on} onChange={e => setV(s => ({ ...s, on: e.target.value }))} /></F>
      <div />
      <F label="Reason" req full><input className="in" maxLength={2000} value={v.reason} onChange={e => setV(s => ({ ...s, reason: e.target.value }))} /></F>
      <F label="Supporting remarks" full><input className="in" maxLength={2000} value={v.remarks} onChange={e => setV(s => ({ ...s, remarks: e.target.value }))} /></F>
    </div>
  </Modal>
}

/* ── Withdraw / revise & resubmit ── */
export function WithdrawModal({ r, onClose, onDone }: { r: Row; onClose: () => void; onDone: (m: string) => void }) {
  const { busy, run } = useRun(onDone)
  return <Modal title="Withdraw this request?" width={440} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn d" disabled={busy} onClick={() => run(() => insApi.withdraw(r.id), 'Request withdrawn')}>Withdraw</button></>}>
    <p style={{ margin: 0 }}>The pending approval is cancelled and the request moves to Rejected – you can revise and resubmit it later.</p>
  </Modal>
}

export function ResubmitModal({ d, meta, onClose, onDone }: { d: Detail; meta: Meta; onClose: () => void; onDone: (m: string) => void }) {
  const [v, setV] = useState<Vals>({ amount: String(d.form.amount ?? ''), mode: d.form.mode || meta.modes[0], due: d.form.due && d.form.due >= todayIso() ? d.form.due : addDays(todayIso(), 5),
    bene: d.form.bene, at: d.form.at, bank: d.form.bank || meta.config.preferred_bank, remarks: d.form.remarks })
  const { busy, run } = useRun(onDone)
  const { error } = useToast()
  const set = (k: string) => (e: { target: { value: string } }) => setV(s => ({ ...s, [k]: e.target.value }))
  const ok = () => {
    if (!(Number(v.amount) > 0)) return error('Enter an amount greater than zero')
    if (!v.due || v.due < todayIso()) return error('Enter a required-by date from today')
    if (!v.bene.trim()) return error('Enter the beneficiary')
    run(() => insApi.resubmit(d.id, { ...v, amount: Number(v.amount) }), (x: { message: string }) => `Resubmitted – ${x.message}`)
  }
  return <Shell title="Revise & resubmit" busy={busy} ok={ok} okLabel="Send for approval" onClose={onClose}>
    {d.approval.rejection && <div className="note mb">Rejected: “{d.approval.rejection}”</div>}
    <div className="fg">
      <F label="Amount (₹)" req><input className="in" type="number" min={0} step="any" value={v.amount} onChange={set('amount')} /></F>
      <F label="Mode of payment"><select className="in" value={v.mode} onChange={set('mode')}>{meta.modes.filter(m => m !== meta.exempt_mode).map(m => <option key={m}>{m}</option>)}</select></F>
      <F label="Required by" req><input className="in" type="date" min={todayIso()} value={v.due} onChange={set('due')} /></F>
      <F label="Beneficiary" req><input className="in" maxLength={200} value={v.bene} onChange={set('bene')} /></F>
      <F label="Payable at"><input className="in" maxLength={200} value={v.at} onChange={set('at')} /></F>
      <F label="Preferred bank"><select className="in" value={v.bank} onChange={set('bank')}>{meta.banks.map(b => <option key={b}>{b}</option>)}</select></F>
      <F label="Remarks" full><input className="in" maxLength={2000} value={v.remarks} onChange={set('remarks')} /></F>
    </div>
  </Shell>
}

export type ActionKey = 'pay' | 'refund' | 'receive' | 'acknowledge' | 'extend' | 'forfeit' | 'withdraw' | 'resubmit'
/** one place that renders the modal for an action on a register row / drawer record */
export function ActionModal({ act, r, d, meta, onClose, onDone }: { act: ActionKey; r: Row; d?: Detail | null; meta: Meta; onClose: () => void; onDone: (m: string) => void }) {
  if (act === 'pay') return <PayModal r={d || r} meta={meta} onClose={onClose} onDone={onDone} />
  if (act === 'refund') return <RefundModal r={r} meta={meta} onClose={onClose} onDone={onDone} />
  if (act === 'receive') return <ReceiveModal r={r} meta={meta} onClose={onClose} onDone={onDone} />
  if (act === 'acknowledge') return <AckModal r={r} meta={meta} onClose={onClose} onDone={onDone} />
  if (act === 'extend') return <ExtendModal r={r} onClose={onClose} onDone={onDone} />
  if (act === 'forfeit') return <ForfeitModal r={r} onClose={onClose} onDone={onDone} />
  if (act === 'withdraw') return <WithdrawModal r={r} onClose={onClose} onDone={onDone} />
  if (act === 'resubmit' && d) return <ResubmitModal d={d} meta={meta} onClose={onClose} onDone={onDone} />
  return null
}
