// Order record drawer – prototype v17 openRec('wo'): header (title · WO no. · stage), Edit / Delete, tabs Overview /
// Milestones / Activity / Documents / Notes. Overview = recHero('wo') tiles (Order value · Progress · Billed · Due · PM) with
// stage progress + Log activity and signals ("Work done but not invoiced"), the stage path, the journey (Lead → Deal →
// Tender / Quote → Work order → Follow-on contract with "＋ <lifecycle>") and detailCards(). Milestones = Milestone |
// Date | Billing | Status + "Billing realised x% vs progress y%".
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import api from '@/services/api'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { buildFilePreviewUrl } from '@/pages/questionnaire/questionnaireFormShared'
import { Modal } from '@/pages/notifications/Modal'
import FieldError from '@/components/form/FieldError'
import { useModalValidation } from '@/components/form/useModalValidation'
import { Av, BarPct, Pill } from '@/pages/customers/kit'
import { masters, useMaster } from '@/pages/leads/leadApi'
import { useOrderStage } from './useOrderStage'
import { PaymentsTab } from './OrderPayments'
import { dto, errMsg, fd, inr, orderApi, stagePill, todayIso, type Detail, type Milestone } from './orderApi'

// v18 M.wo.tabs = { Payments, …Milestones } after Overview
const TABS = ['Overview', 'Payments', 'Milestones', 'Activity', 'Documents', 'Notes'] as const
export type Tab = typeof TABS[number]
const DOT: Record<string, string> = { ok: 'var(--bw-ok)', wa: 'var(--bw-wa)', ba: 'var(--bw-ba)', inf: 'var(--bw-in)' }
const JICO: Record<string, string> = { lead: 'funnel', deal: 'target', tq: 'file', order: 'brief' }
const dt = (s: string | null) => s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
const cdn = (d: string | null) => { if (!d) return ''; const n = dto(d); return n < 0 ? <span className="tbad">{-n} d ago</span> : n === 0 ? 'today' : `in ${n} d` }

export default function OrderDrawer({ id, meId, onClose, onChanged, onOpen, initialTab = 'Overview' }: { id: number; meId: number; onClose: () => void; onChanged: () => void; onOpen: (id: number) => void; initialTab?: Tab }) {
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const [d, setD] = useState<Detail | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [tab, setTab] = useState<Tab>(initialTab)
  const [busy, setBusy] = useState(false)
  const [del, setDel] = useState(false)
  const [logAct, setLogAct] = useState(false)

  const load = useCallback(() => { setLoadErr(''); orderApi.get(id).then(setD).catch(e => { setD(null); setLoadErr(errMsg(e, 'Could not open this order')) }) }, [id])
  useEffect(() => { setD(null); setTab(initialTab); load() }, [load, initialTab])
  const refresh = useCallback(() => { load(); onChanged() }, [load, onChanged])
  const { move, ui } = useOrderStage(!!d?.can.update, refresh)
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !del && !logAct && !document.querySelector('.bwi-ov')) onClose() }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [onClose, del, logAct])

  const host = document.querySelector('.crm-shell') ?? document.body
  const editable = !!d && d.can.update && !d.pending
  const curIdx = d ? d.stages.findIndex(s => s.id === d.stage.id) : -1
  const tgt = d ? { id: d.id, name: d.title, stages: d.stages, currentId: d.stage.id } : null
  const follow = async (key: string) => {
    if (!d) return
    setBusy(true)
    try { const r = await orderApi.followOn(d.id, key); success(r.message); onChanged(); onOpen(r.id) } catch (e) { error(errMsg(e, 'Could not create the follow-on contract')) } finally { setBusy(false) }
  }

  return createPortal(<div className="bwi">
    <div className="bwi-dwo" onMouseDown={onClose} />
    <aside className="bwi-dw" role="dialog" aria-modal="true" aria-label={d ? `${d.title} – order ${d.ref}` : 'Order'}>
      <div className="dh">
        <div className="fl">
          <h2>{d?.title || (loadErr ? 'Order' : 'Loading…')}</h2>
          {d && <div className="sub"><span>{d.ref}</span> · <Pill s={d.stage.name} t={stagePill(d.stage.name, d.stage.kind)} />
            {d.lifecycle.key !== 'wo' && <Pill s={d.lifecycle.type} t="ac" />}
            {d.pending && <Pill s={`Awaiting approval → ${d.pending.stage}`} t="wa" />}</div>}
        </div>
        {d && d.can.update && <button type="button" className="btn" onClick={() => navigate(`/workorders/${d.id}/edit`)}><Ic n="edit" /> Edit</button>}
        {d && d.can.delete && <button type="button" className="btn d ib" title="Delete" aria-label="Delete order" onClick={() => setDel(true)}><Ic n="trash" /></button>}
        <button type="button" className="btn g ib" onClick={onClose} aria-label="Close"><Ic n="x" /></button>
      </div>
      <div className="tabs" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}{t === 'Notes' && d?.notes.length ? <small>{d.notes.length}</small> : null}</div>)}</div>
      <div className="db">
        {loadErr ? <div className="dcard empty">{loadErr} · <a onClick={load}>Retry</a></div>
          : !d ? <div className="empty">Loading…</div>
            : tab === 'Overview' ? <>
              <div className="dcard">
                <div className="kgrid">
                  <K l="Order value" v={inr(d.value)} />
                  <K l="Progress" v={`${d.progress}%`} />
                  <K l="Billed" v={`${d.billed}%`} s={inr(d.billed_amount)} />
                  <K l="Due" v={d.due ? fd(d.due) : '—'} s={cdn(d.due)} />
                  <K l="PM" v={(d.pm || '—').split(' ')[0]} />
                </div>
                <div className="lprog">
                  <div style={{ flex: '1 1 220px', minWidth: 160 }}>
                    <div className="pm"><i style={{ width: `${d.stage.kind === 'open' ? Math.round((d.stage_no - 1) / Math.max(d.stages_of, 1) * 100) : 100}%`, background: d.stage.kind === 'won' ? 'var(--bw-ok)' : 'var(--bw-ac)' }} /></div>
                    <small>{d.stage.kind === 'open' ? `Stage ${d.stage_no} of ${d.stages_of}` : d.stage.name} · {d.lifecycle.type}{d.stage.sla && d.stage.kind === 'open' ? ` · SLA ${d.stage.sla} d` : ''}</small>
                  </div>
                  {d.can.log_activity && <button type="button" className="btn s" onClick={() => setLogAct(true)}><Ic n="pin" /> Log activity</button>}
                </div>
                {(d.signals.length > 0 || (d.customer_id && d.can.customers)) && <div className="sigs">{d.signals.map(s => <span key={s.s} className="sig"><i style={{ background: DOT[s.t] || DOT.inf }} />{s.s}</span>)}
                  {d.customer_id && d.can.customers && <a className="sig" onClick={() => navigate(`/customers/${d.customer_id}`)}><Ic n="building" size={13} /> {d.customer.slice(0, 28)} · 360 →</a>}</div>}
              </div>
              <div className="lpath" role="list" aria-label="Order stages">
                {d.stages.map((s, i) => {
                  const cls = `s ${i < curIdx && s.kind === 'open' ? 'done' : ''} ${i === curIdx ? 'cur' : ''} ${s.kind}`
                  return <button key={s.id} type="button" role="listitem" className={cls} disabled={!editable || i === curIdx || busy}
                    title={`${s.name}${s.sla ? ` · SLA ${s.sla}d` : ''}${s.gate !== 'None' ? ` · gate: ${s.gate}` : ''}`} onClick={() => tgt && void move(tgt, s)}>{s.name}</button>
                })}
              </div>
              {d.pending && <div className="note mb">Awaiting approval to move to <b>{d.pending.stage}</b>. <a onClick={() => navigate('/approvals')}>View approval</a></div>}
              <div className="jy">
                <div className="jy-h"><Ic n="flow" /> <b>Journey</b> {d.journey.id && <small className="mu">{d.journey.id}</small>}<small className="mu"> · {inr(d.value)}{d.parent ? <> · follow-on of <a onClick={() => onOpen(d.parent!.id)}>{d.parent.ref}</a></> : ''}</small></div>
                <div className="jy-r">{d.journey.steps.map((j, i) => {
                  const cur = j.done && !(d.journey.steps[i + 1]?.done)
                  return <div key={j.k} className={`jy-s ${j.done ? 'done' : ''} ${cur ? 'cur' : ''}`}>
                    <span className="jy-n"><Ic n={JICO[j.k] || 'doc'} /></span>
                    <b>{j.label}</b>
                    {j.ref ? (j.route ? <a onClick={() => navigate(j.route!)}>{j.ref}</a> : <small>{j.ref}</small>) : <small>not started</small>}
                    {j.stage && <Pill s={j.stage} t={j.k === 'order' && j.me ? stagePill(d.stage.name, d.stage.kind) : undefined} />}
                    {j.value != null && j.value > 0 && <span className="jv">{inr(j.value)}</span>}
                    {j.date && <span className="jd"><Ic n="cal" size={12} /> {fd(j.date)}</span>}
                  </div>
                })}
                  {(d.journey.follow_ons.length > 0 || d.follow_on_options.length > 0) && <div className={`jy-s ${d.journey.follow_ons.length ? 'done' : ''}`} style={d.journey.follow_ons.length ? undefined : { border: '1px dashed var(--bw-ac)' }}>
                    <span className="jy-n"><Ic n="copy" /></span>
                    <b>Follow-on contract</b>
                    {d.journey.follow_ons.map(f => f.me ? <small key={f.id}>{f.ref} · {f.type}</small> : <a key={f.id} onClick={() => onOpen(f.id)}>{f.ref} · {f.type}</a>)}
                    {d.can.create && <div className="row wrap" style={{ gap: 4, marginTop: 3 }}>{d.follow_on_options.filter(o => !d.journey.follow_ons.some(f => f.type === o.type)).map(o =>
                      <button key={o.key} type="button" className="btn s p" disabled={busy} onClick={() => void follow(o.key)}>＋ {o.type}</button>)}</div>}
                  </div>}
                </div>
              </div>
              <div className="fpan">{d.panels.map(p => {
                const n = p.f.filter(x => x[1] !== null && x[1] !== undefined && x[1] !== '').length
                return <div className="panel" key={p.t}><div className="ph"><Ic n={p.i} /> <span className="fl">{p.t}</span><small className="mu">{n}/{p.f.length} filled</small></div>
                  <div className="pb"><div className="fkv">{p.f.map(([l, val, kind]) => <div key={l}><div className="kl">{l}</div><div className="kv">{fmtVal(val, kind, d)}</div></div>)}</div></div></div>
              })}</div>
            </>
              : tab === 'Payments' ? <PaymentsTab id={d.id} onChanged={refresh} />
              : tab === 'Milestones' ? <MilestonesTab d={d} onChanged={refresh} />
                : tab === 'Activity' ? <div className="dcard">
                  <div className="row mb"><b className="fl">Activity</b>{d.can.log_activity && <button type="button" className="btn s" onClick={() => setLogAct(true)}><Ic n="plus" /> Log activity</button>}</div>
                  {d.timeline.length ? <div className="tl">{d.timeline.map((t, i) => <div key={i}><b>{t.t}</b><br /><small>{t.by}{t.by && t.d ? ' · ' : ''}{dt(t.d)}</small></div>)}</div> : <div className="empty">No activity yet</div>}
                </div>
                  : tab === 'Documents' ? <DocsTab id={d.id} can={d.can.documents} />
                    : <NotesTab d={d} meId={meId} onChanged={load} />}
      </div>
    </aside>
    {ui}
    {del && d && <Modal title="Delete record?" width={420} onClose={() => setDel(false)} foot={<><span className="fl" />
      <button type="button" className="btn" onClick={() => setDel(false)}>Cancel</button>
      <button type="button" className="btn d" disabled={busy} onClick={async () => {
        setBusy(true)
        try { await orderApi.remove(d.id); success('Deleted'); setDel(false); onChanged(); onClose() } catch (e) { error(errMsg(e, 'Could not delete the order')) } finally { setBusy(false) }
      }}>Delete</button></>}>
      <p style={{ margin: 0 }}>Delete order <b>{d.ref}</b>? Orders with invoices, customer receipts or follow-on contracts cannot be deleted. The linked tender and quote are kept; the deletion is audit-logged.</p>
    </Modal>}
    {logAct && d && <LogActivityModal d={d} onClose={() => setLogAct(false)} onDone={() => { setLogAct(false); success('Activity logged'); refresh() }} warn={warning} />}
  </div>, host)
}

function K({ l, v, s }: { l: string; v: ReactNode; s?: ReactNode }) {
  return <div className="kcard"><div className="kl">{l}</div><div className="kv">{v}</div>{s ? <div className="ks">{s}</div> : null}</div>
}
function fmtVal(v: unknown, kind: string | undefined, d: Detail): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="mu">—</span>
  if (kind === 'inr') return <b>{inr(Number(v))}</b>
  if (kind === 'date') return <>{fd(String(v))} <small className="mu">{dto(String(v)) >= 0 ? `in ${dto(String(v))} d` : `${-dto(String(v))} d ago`}</small></>
  if (kind === 'due') { const n = dto(String(v)); return <span className={n < 0 && d.stage.kind !== 'won' ? 'tbad' : n <= 7 && d.stage.kind !== 'won' ? 'twarn' : ''}>{fd(String(v))} <small>{n < 0 ? `${-n} d ago` : n === 0 ? 'today' : `in ${n} d`}</small></span> }
  if (kind === 'user') return <span className="row" style={{ gap: 5, display: 'inline-flex' }}><Av name={String(v)} />{String(v)}</span>
  if (kind === 'pill') return <Pill s={String(v)} t={stagePill(String(v), d.stage.kind)} />
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

// prototype tabs Milestones: tbl([Milestone, Date, Billing, Status]) + "Billing realised x% vs progress y%"
function MilestonesTab({ d, onChanged }: { d: Detail; onChanged: () => void }) {
  const { success, error } = useToast()
  const [data, setData] = useState<Awaited<ReturnType<typeof orderApi.milestones>> | null>(null)
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState<Milestone | 'new' | null>(null)
  const [inv, setInv] = useState<Milestone | 'free' | null>(null)
  const [prog, setProg] = useState(false)
  const load = useCallback(() => { setErr(''); orderApi.milestones(d.id).then(setData).catch(e => { setData({ items: [], invoices: [], invoiced: 0 }); setErr(errMsg(e, 'Could not load milestones')) }) }, [d.id])
  useEffect(() => { load() }, [load])
  const changed = () => { load(); onChanged() }
  const can = d.can.update
  return <div className="dcard">
    {!data ? <div className="empty">Loading…</div> : err ? <div className="empty">{err} · <a onClick={load}>Retry</a></div> : <>
      {data.items.length ? <table className="t"><thead><tr><th>Milestone</th><th>Date</th><th className="r">Billing</th><th>Status</th></tr></thead>
        <tbody>{data.items.map(m => <tr key={m.id} data-a={can ? 'open' : undefined} onClick={can ? () => setEdit(m) : undefined} title={m.invoice ? `Invoiced: ${m.invoice.number} · ${inr(m.invoice.amount)}` : can ? 'Edit milestone' : undefined}>
          <td>{m.name}</td><td className={m.overdue ? 'tbad' : ''}>{fd(m.date)}</td><td className="r">{inr(m.amount)}</td>
          <td><Pill s={m.status} /></td></tr>)}</tbody></table>
        : <div className="empty">{d.config.milestones ? 'No milestones yet' : 'Milestone tracking is switched off in Settings → Orders & projects'}</div>}
      <div className="mt">Billing realised <b>{d.billed}%</b> vs progress <b>{d.progress}%</b></div>
      {can && <div className="row wrap mt" style={{ gap: 6 }}>
        {d.config.milestones && <button type="button" className="btn s" onClick={() => setEdit('new')}><Ic n="plus" /> Add milestone</button>}
        <button type="button" className="btn s" onClick={() => setInv('free')}><Ic n="doc" /> Record invoice</button>
        {d.progress_basis === 'manual' && <button type="button" className="btn s" onClick={() => setProg(true)}><Ic n="up" /> Update progress</button>}
        <small className="mu fl" style={{ textAlign: 'right' }}>Billing model: {d.config.billing_model} · Billed % counts recorded invoices only</small>
      </div>}
    </>}
    {edit && <MilestoneModal d={d} m={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onInvoice={m => { setEdit(null); setInv(m) }}
      onDone={msg => { setEdit(null); success(msg); changed() }} onError={e => error(errMsg(e, 'Could not save the milestone'))} />}
    {inv && <InvoiceModal d={d} m={inv === 'free' ? null : inv} milestones={(data?.items || []).filter(x => !x.invoice)} onClose={() => setInv(null)}
      onDone={() => { setInv(null); success('Invoice recorded'); changed() }} />}
    {prog && <ProgressModal d={d} onClose={() => setProg(false)} onDone={() => { setProg(false); success('Progress updated'); changed() }} />}
  </div>
}

function MilestoneModal({ d, m, onClose, onDone, onError, onInvoice }: { d: Detail; m: Milestone | null; onClose: () => void; onDone: (msg: string) => void; onError: (e: unknown) => void; onInvoice: (m: Milestone) => void }) {
  const [f, setF] = useState({ name: m?.name || '', date: m?.date || '', amount: m ? String(m.amount || '') : '', done: m?.done || false, notes: m?.notes || '' })
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const vx = useModalValidation(f, () => ({ name: { label: 'Milestone', rule: 'text', required: true, max: 200 }, date: { label: 'Date', rule: 'date' },
    amount: { label: 'Billing', rule: 'amount' }, notes: { label: 'Notes', rule: 'textarea', max: 2000 } }), undefined, { name: 'ms-n', date: 'ms-d', amount: 'ms-a', notes: 'ms-no' })
  const upd = (p: Partial<typeof f>) => { const n = { ...f, ...p }; setF(n); vx.change(n, ...Object.keys(p)) }
  const save = async () => {
    if (!vx.submit()) return
    setBusy(true)
    try { await orderApi.saveMilestone(d.id, m?.id ?? null, { name: f.name.trim(), date: f.date || null, amount: Number(f.amount || 0), done: f.done, notes: f.notes.trim() || null }); onDone(m ? 'Milestone updated' : 'Milestone added') }
    catch (e) { if (!vx.server(e)) onError(e) } finally { setBusy(false) }
  }
  return <Modal title={m ? `Milestone – ${m.name}` : 'Add milestone'} width={480} onClose={onClose} foot={<>
    {m && !m.invoice && (confirmDel
      ? <button type="button" className="btn d" disabled={busy} onClick={async () => { setBusy(true); try { await orderApi.deleteMilestone(d.id, m.id); onDone('Milestone deleted') } catch (e) { onError(e) } finally { setBusy(false) } }}>Confirm delete</button>
      : <button type="button" className="btn g" onClick={() => setConfirmDel(true)}><Ic n="trash" /> Delete</button>)}
    {m && !m.invoice && <button type="button" className="btn" onClick={() => onInvoice(m)}><Ic n="doc" /> Invoice</button>}
    <span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
    <div className="fg">
      <div className="f1"><label htmlFor="ms-n">Milestone *</label><input id="ms-n" className={`in ${vx.bad('name') ? 'err' : ''}`} {...vx.aria('name')} maxLength={200} value={f.name} onChange={e => upd({ name: e.target.value })} /><FieldError id="ms-n" msg={vx.errors.name} /></div>
      <div><label htmlFor="ms-d">Date</label><input id="ms-d" className={`in ${vx.bad('date') ? 'err' : ''}`} {...vx.aria('date')} type="date" value={f.date} onChange={e => upd({ date: e.target.value })} /><FieldError id="ms-d" msg={vx.errors.date} /></div>
      <div><label htmlFor="ms-a">Billing</label><div className="cur-in"><span>₹</span><input id="ms-a" className={`in ${vx.bad('amount') ? 'err' : ''}`} {...vx.aria('amount')} type="number" min={0} step="any" value={f.amount} onChange={e => upd({ amount: e.target.value })} /></div><FieldError id="ms-a" msg={vx.errors.amount} /></div>
      <div className="f1"><label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.done} onChange={e => setF({ ...f, done: e.target.checked })} /> Done – the milestone is complete</label>
        <small className="mu">Completing a milestone moves progress; it is billed only when an invoice is recorded.</small></div>
      {m?.invoice && <div className="f1 note">Invoiced: <b>{m.invoice.number}</b> · {fd(m.invoice.date)} · {inr(m.invoice.amount)} · {m.invoice.status}</div>}
      <div className="f1"><label htmlFor="ms-no">Notes</label><textarea id="ms-no" className={`in ${vx.bad('notes') ? 'err' : ''}`} {...vx.aria('notes')} rows={2} value={f.notes} onChange={e => upd({ notes: e.target.value })} /><FieldError id="ms-no" msg={vx.errors.notes} /></div>
    </div>
  </Modal>
}

function InvoiceModal({ d, m, milestones, onClose, onDone }: { d: Detail; m: Milestone | null; milestones: Milestone[]; onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const [f, setF] = useState({ number: '', date: todayIso(), amount: m ? String(m.amount || '') : '', gst: '', milestone: m ? String(m.id) : '' })
  const [busy, setBusy] = useState(false)
  const vx = useModalValidation(f, () => ({ number: { label: 'Invoice number', rule: 'text', required: true, max: 100 }, date: { label: 'Invoice date', rule: 'date' },
    amount: { label: 'Amount', rule: 'amount', required: true }, gst: { label: 'GST amount', rule: 'amount' } }),
  x => ({ amount: x.amount.trim() !== '' && Number(x.amount) === 0 ? 'Amount must be more than 0.' : '' }), { number: 'iv-n', date: 'iv-d', amount: 'iv-a', gst: 'iv-g' })
  const upd = (p: Partial<typeof f>) => { const n = { ...f, ...p }; setF(n); vx.change(n, ...Object.keys(p)) }
  return <Modal title="Record invoice" width={480} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={async () => {
      if (!vx.submit()) return
      setBusy(true)
      try { await orderApi.invoice(d.id, { number: f.number.trim(), date: f.date || null, amount: Number(f.amount), gst: Number(f.gst || 0), milestone_id: f.milestone ? Number(f.milestone) : null }); onDone() }
      catch (e) { if (!vx.server(e)) error(errMsg(e, 'Could not record the invoice')) } finally { setBusy(false) }
    }}>{busy ? 'Saving…' : 'Record invoice'}</button></>}>
    <div className="fg">
      <div><label htmlFor="iv-n">Invoice number *</label><input id="iv-n" className={`in ${vx.bad('number') ? 'err' : ''}`} {...vx.aria('number')} maxLength={100} value={f.number} onChange={e => upd({ number: e.target.value })} /><FieldError id="iv-n" msg={vx.errors.number} /></div>
      <div><label htmlFor="iv-d">Invoice date</label><input id="iv-d" className={`in ${vx.bad('date') ? 'err' : ''}`} {...vx.aria('date')} type="date" value={f.date} onChange={e => upd({ date: e.target.value })} /><FieldError id="iv-d" msg={vx.errors.date} /></div>
      <div><label htmlFor="iv-a">Amount (before GST) *</label><div className="cur-in"><span>₹</span><input id="iv-a" className={`in ${vx.bad('amount') ? 'err' : ''}`} {...vx.aria('amount')} type="number" min={0} step="any" value={f.amount} onChange={e => upd({ amount: e.target.value })} /></div><FieldError id="iv-a" msg={vx.errors.amount} /></div>
      <div><label htmlFor="iv-g">GST amount</label><div className="cur-in"><span>₹</span><input id="iv-g" className={`in ${vx.bad('gst') ? 'err' : ''}`} {...vx.aria('gst')} type="number" min={0} step="any" value={f.gst} onChange={e => upd({ gst: e.target.value })} /></div><FieldError id="iv-g" msg={vx.errors.gst} /></div>
      <div className="f1"><label htmlFor="iv-m">Milestone</label><select id="iv-m" className="in" value={f.milestone} onChange={e => setF({ ...f, milestone: e.target.value })} disabled={!!m}>
        <option value="">Not linked to a milestone</option>{(m ? [m] : milestones).map(x => <option key={x.id} value={x.id}>{x.name} · {inr(x.amount)}</option>)}</select></div>
      <div className="f1"><small className="mu">Order value {inr(d.value)} · already invoiced {inr(d.billed_amount)}.</small></div>
    </div>
  </Modal>
}

function ProgressModal({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const [v, setV] = useState(String(d.progress))
  const [busy, setBusy] = useState(false)
  const n = Number(v), ok = v !== '' && Number.isInteger(n) && n >= 0 && n <= 100
  const vx = useModalValidation({ progress: v }, () => ({ progress: { label: 'Progress', rule: 'integer', required: true, min: 0, max: 100 } }), undefined, { progress: 'pg-v' })
  return <Modal title="Update progress" width={380} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={async () => { if (!vx.submit()) return; setBusy(true); try { await orderApi.progress(d.id, n); onDone() } catch (e) { if (!vx.server(e)) error(errMsg(e, 'Could not update progress')) } finally { setBusy(false) } }}>Save</button></>}>
    <div className="fg"><div className="f1"><label htmlFor="pg-v">Progress (%)</label><input id="pg-v" className={`in ${vx.bad('progress') ? 'err' : ''}`} {...vx.aria('progress')} type="number" min={0} max={100} step={1} value={v} onChange={e => { setV(e.target.value); vx.change({ progress: e.target.value }, 'progress') }} /><FieldError id="pg-v" msg={vx.errors.progress} />
      <div className="mt"><BarPct v={ok ? n : 0} /></div></div></div>
  </Modal>
}

function DocsTab({ id, can }: { id: number; can: boolean }) {
  const { success, error } = useToast()
  const [docs, setDocs] = useState<Awaited<ReturnType<typeof orderApi.documents>> | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const load = useCallback(() => { setErr(''); orderApi.documents(id).then(setDocs).catch(e => { setDocs({ items: [], allowed: true }); setErr(errMsg(e, 'Could not load documents')) }) }, [id])
  useEffect(() => { load() }, [load])
  const upload = async (f: File) => {
    setBusy(true)
    try { await orderApi.upload(id, f); success(`${f.name} uploaded`); load() } catch (e) { error(errMsg(e, 'Upload failed')) } finally { setBusy(false); if (file.current) file.current.value = '' }
  }
  return <div className="dcard">
    {!docs ? <div className="empty">Loading…</div>
      : err ? <div className="empty">{err} · <a onClick={load}>Retry</a></div>
        : !docs.allowed ? <div className="empty">You do not have access to Document Hub.</div>
          : !docs.items.length ? <div className="empty">No documents linked yet</div>
            : <table className="t"><thead><tr><th>File</th><th>Folder</th><th>Updated</th></tr></thead><tbody>
              {docs.items.map(x => <tr key={x.id}><td><Ic n="file" /> <a href={x.url ? buildFilePreviewUrl(x.url) : undefined} target="_blank" rel="noreferrer">{x.name}</a></td>
                <td>{x.folder}</td><td>{x.updated_at ? fd(x.updated_at) : '—'}</td></tr>)}</tbody></table>}
    {can && <><input ref={file} type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f) upload(f) }} />
      <button type="button" className="btn mt" disabled={busy} onClick={() => file.current?.click()}><Ic n="up" /> {busy ? 'Uploading…' : 'Upload document'}</button></>}
  </div>
}

function NotesTab({ d, meId, onChanged }: { d: Detail; meId: number; onChanged: () => void }) {
  const { success, error } = useToast()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<{ id: number; body: string } | null>(null)
  const [mq, setMq] = useState<string | null>(null)
  const users = useMaster(masters.users)
  const ta = useRef<HTMLTextAreaElement>(null)
  const sugg = mq === null ? [] : (users.items || []).filter(u => u.name.toLowerCase().startsWith(mq.toLowerCase()) || u.name.toLowerCase().includes(` ${mq.toLowerCase()}`)).slice(0, 6)
  const insert = (name: string) => {
    const el = ta.current, pos = el?.selectionStart ?? body.length
    const before = body.slice(0, pos).replace(/@([\w.-]*)$/, `@${name} `)
    setBody(before + body.slice(pos)); setMq(null); setTimeout(() => { el?.focus(); el?.setSelectionRange(before.length, before.length) }, 0)
  }
  const add = async () => {
    if (!body.trim()) return
    setBusy(true)
    try { const r = await orderApi.note(d.id, body.trim()); setBody(''); success(r.mentioned ? `Note added · ${r.mentioned} teammate${r.mentioned > 1 ? 's' : ''} notified` : 'Note added'); onChanged() }
    catch (e) { error(errMsg(e, 'Could not add the note')) } finally { setBusy(false) }
  }
  return <div className="dcard">
    <div className="list">{d.notes.length ? d.notes.map(n => <div key={n.id} style={{ display: 'block' }}>
      {edit?.id === n.id ? <><textarea className="in" rows={3} value={edit.body} onChange={e => setEdit({ ...edit, body: e.target.value })} aria-label="Edit note" />
        <div className="row mt"><span className="fl" /><button type="button" className="btn s" onClick={() => setEdit(null)}>Cancel</button>
          <button type="button" className="btn p s" disabled={!edit.body.trim()} onClick={async () => {
            try { await orderApi.editNote(d.id, n.id, edit.body.trim()); setEdit(null); success('Note updated'); onChanged() } catch (e) { error(errMsg(e, 'Could not save the note')) }
          }}>Save</button></div></>
        : <><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{n.body}</div>
          <small>{n.by}{n.at ? ` · ${dt(n.at)}` : ''}</small>
          {n.by_id != null && n.by_id === meId && <> · <a onClick={() => setEdit({ id: n.id, body: n.body })}>Edit</a></>}</>}
    </div>) : <div className="mu">No notes yet</div>}</div>
    <div style={{ position: 'relative' }}>
      <textarea ref={ta} className="in mt" id="nt" rows={3} placeholder="Add a note, @mention a teammate…" value={body} aria-label="New note"
        onChange={e => { setBody(e.target.value); const m = /(?:^|\s)@([\w.-]*)$/.exec(e.target.value.slice(0, e.target.selectionStart)); setMq(m ? m[1] : null) }}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add() } if (e.key === 'Escape') setMq(null) }} />
      {mq !== null && sugg.length > 0 && <div className="mpop">{sugg.map(u => <div key={u.id} onMouseDown={e => { e.preventDefault(); insert(u.name) }}>{u.name}{u.sub && <small> · {u.sub}</small>}</div>)}</div>}
    </div>
    <button type="button" className="btn p mt" disabled={busy || !body.trim()} onClick={add}>{busy ? 'Adding…' : 'Add note'}</button>
  </div>
}

function LogActivityModal({ d, onClose, onDone, warn }: { d: Detail; onClose: () => void; onDone: () => void; warn: (m: string) => void }) {
  const { error } = useToast()
  const [kmeta, setKmeta] = useState<{ activity_types: string[]; statuses: string[] } | null>(null)
  const [metaErr, setMetaErr] = useState('')
  const [f, setF] = useState({ type: '', subject: '', date: todayIso(), status: '', outcome: '', description: '' })
  const [busy, setBusy] = useState(false)
  const loadMeta = useCallback(() => { setMetaErr(''); api.get('/kam/meta').then(r => { setKmeta(r.data); setF(s => ({ ...s, type: s.type || r.data.activity_types?.[0] || '', status: s.status || r.data.statuses?.[0] || '' })) })
    .catch(e => setMetaErr(errMsg(e, 'Could not load activity types'))) }, [])
  useEffect(() => { loadMeta() }, [loadMeta])
  const needOutcome = f.status === 'Completed', needDesc = f.status === 'Postponed' || f.status === 'Cancelled'
  const vx = useModalValidation(f, x => ({ type: { label: 'Type', rule: 'select', required: true }, subject: { label: 'Subject', rule: 'text', required: true, max: 255 },
    date: { label: 'Date', rule: 'date', required: true },
    outcome: x.status === 'Completed' ? { label: 'Outcome', rule: 'text', required: true, max: 1000 } : undefined,
    description: { label: x.status === 'Postponed' || x.status === 'Cancelled' ? 'Reason' : 'Notes', rule: 'textarea', required: x.status === 'Postponed' || x.status === 'Cancelled', max: 5000 } }),
  undefined, { type: 'oa-t', subject: 'oa-sub', date: 'oa-d', outcome: 'oa-o', description: 'oa-n' })
  const upd = (p: Partial<typeof f>) => { const n = { ...f, ...p }; setF(n); vx.change(n, ...Object.keys(p)) }
  return <Modal title="Log activity" width={520} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={async () => {
      if (!vx.submit()) return
      if (!d.customer_id) { warn('This order has no customer record to log the activity against'); return }
      setBusy(true)
      try {
        await api.post('/kam/activities', { activity_type: f.type, lead_id: d.journey.lead_id, customer_id: d.customer_id, subject: f.subject.trim(), activity_date: f.date, status: f.status,
          outcome: f.outcome.trim() || null, description: [`Order ${d.ref}`, f.description.trim()].filter(Boolean).join(' – '), ...(f.status === 'Cancelled' ? { cancellation_reason: f.description.trim() } : {}) })
        onDone()
      } catch (e) { if (!vx.server(e, { activity_type: 'type', activity_date: 'date', cancellation_reason: 'description' })) error(errMsg(e, 'Could not log the activity')) } finally { setBusy(false) }
    }}>{busy ? 'Saving…' : 'Log activity'}</button></>}>
    {metaErr ? <div className="note bad">{metaErr} · <a onClick={loadMeta}>Retry</a></div> : !kmeta ? <div className="empty">Loading…</div> :
      <div className="fg">
        <div><label htmlFor="oa-t">Type</label><select id="oa-t" className={`in ${vx.bad('type') ? 'err' : ''}`} {...vx.aria('type')} value={f.type} onChange={e => upd({ type: e.target.value })}>{kmeta.activity_types.map(t => <option key={t}>{t}</option>)}</select><FieldError id="oa-t" msg={vx.errors.type} /></div>
        <div><label htmlFor="oa-s">Status</label><select id="oa-s" className="in" value={f.status} onChange={e => upd({ status: e.target.value })}>{kmeta.statuses.map(t => <option key={t}>{t}</option>)}</select></div>
        <div className="f1"><label htmlFor="oa-sub">Subject *</label><input id="oa-sub" className={`in ${vx.bad('subject') ? 'err' : ''}`} {...vx.aria('subject')} value={f.subject} onChange={e => upd({ subject: e.target.value })} placeholder={`Site visit – ${d.ref}`} /><FieldError id="oa-sub" msg={vx.errors.subject} /></div>
        <div><label htmlFor="oa-d">Date *</label><input id="oa-d" className={`in ${vx.bad('date') ? 'err' : ''}`} {...vx.aria('date')} type="date" value={f.date} onChange={e => upd({ date: e.target.value })} /><FieldError id="oa-d" msg={vx.errors.date} /></div>
        {needOutcome && <div className="f1"><label htmlFor="oa-o">Outcome *</label><input id="oa-o" className={`in ${vx.bad('outcome') ? 'err' : ''}`} {...vx.aria('outcome')} value={f.outcome} onChange={e => upd({ outcome: e.target.value })} /><FieldError id="oa-o" msg={vx.errors.outcome} /></div>}
        <div className="f1"><label htmlFor="oa-n">{needDesc ? 'Reason *' : 'Notes'}</label><textarea id="oa-n" className={`in ${vx.bad('description') ? 'err' : ''}`} {...vx.aria('description')} rows={3} value={f.description} onChange={e => upd({ description: e.target.value })} /><FieldError id="oa-n" msg={vx.errors.description} /></div>
      </div>}
  </Modal>
}
