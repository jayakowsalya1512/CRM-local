// Prototype v18 cmOpen(): commitment drawer (860px). Header (owner · period, ID · type · status · team) with Edit,
// Acknowledge and Delete; period / target / submitted strip; one achievement card per type; entry tables (payments:
// Customer | Tender | Committed | Expected | Received | Status); Weekly view for periods longer than a week; note.
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Pill, Tbl } from '@/pages/customers/kit'
import { fd, inr } from '@/pages/customers/customerApi'
import { CMSC, cmApi, cmFmt, errText, fmtN, pc3, pctOf, stTone, type DEntry, type Detail } from './commitmentApi'
import { MBar, TenH } from './parts'

const fdt = (s: string | null) => s ? `${fd(s)} ${s.slice(11, 16)}` : '—'

export default function CommitmentDrawer({ id, onClose, onChanged, onEdit }: { id: number; onClose: () => void; onChanged: () => void; onEdit: (d: Detail) => void }) {
  const { success, error } = useToast()
  const [d, setD] = useState<Detail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const load = useCallback(() => { setErr(null); cmApi.detail(id).then(setD).catch(e => setErr(errText(e, 'Could not load the commitment'))) }, [id])
  useEffect(load, [load])
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !confirm) onClose() }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h) }, [onClose, confirm])
  const host = document.querySelector('.crm-shell') ?? document.body

  const ack = async () => {
    setBusy(true)
    try { await cmApi.ack(id); success('Commitment acknowledged'); onChanged(); onClose() } catch (e) { error('Not acknowledged', errText(e)) } finally { setBusy(false) }
  }
  const del = async () => {
    setBusy(true)
    try { await cmApi.remove(id); success('Commitment deleted'); setConfirm(false); onChanged(); onClose() } catch (e) { error('Not deleted', errText(e)) } finally { setBusy(false) }
  }
  const T = (k: string) => d?.types.find(t => t.k === k)

  return createPortal(<div className="bwi">
    <div className="bwi-dwo" onMouseDown={onClose} />
    <aside className="bwi-dw cm8-dw" role="dialog" aria-modal="true" aria-label="Commitment">
      <div className="dh"><div className="fl">
        {!d ? <h2>{err || 'Loading…'}</h2> : <><h2>{d.owner} · {d.label}</h2>
          <div className="sub">{d.code} · <Pill s={d.per} t="ac" /> · <Pill s={d.status} t={stTone(d.status)} /> · {d.scope === 'team' ? 'team commitment' : d.team}</div></>}</div>
        {d?.can.edit && <button type="button" className="btn s" onClick={() => onEdit(d)}><Ic n="edit" /> Edit</button>}
        {d?.can.ack && <button type="button" className="btn s p" disabled={busy} onClick={ack}><Ic n="check" /> Acknowledge</button>}
        {d?.can.delete && <button type="button" className="btn s d" aria-label="Delete commitment" disabled={busy} onClick={() => setConfirm(true)}><Ic n="trash" /></button>}
        <button type="button" className="btn g s" aria-label="Close" onClick={onClose}><Ic n="x" /></button>
      </div>
      {err && !d && <div className="db"><div className="err-box">{err} <button type="button" className="btn s" onClick={load}>Retry</button></div></div>}
      {d && <div className="db">
        <div className="cm8-tg">
          <div><small>Period</small><b>{fd(d.from)} – {fd(d.to)}</b><span className="mu">{d.days} days · {d.closed ? 'closed' : `${d.elapsed} days elapsed (${Math.round(d.elapsed / d.days * 100)}%)`}</span></div>
          <div><small>Target for the period</small><b>{inr(d.target)}</b><span className="mu">payment commitment {pctOf(d.pay, d.target)}% of target</span></div>
          <div><small>Submitted</small><b>{fdt(d.submitted_at)}</b><span className="mu">by {d.submitted_by || '—'}{d.acknowledged_by ? ` · acknowledged by ${d.acknowledged_by}` : ''}</span></div>
        </div>
        <div className="cm8-kp">{d.per_type.map(x => { const t = T(x.k)!
          return <div key={x.k}><div className="row" style={{ gap: 6 }}><Ic n={t.ic} /><small>{t.n}</small></div>
            <b>{cmFmt(t, x.av)} <small>/ {cmFmt(t, x.cv)}</small></b><MBar p={x.p} c={pc3(x.p)} />
            <small className="mu">{x.p}% achieved{!d.closed ? ` · ${x.exp}% of period gone` : ''}{x.pend ? ` · ${inr(x.pend)} awaiting finance` : ''}</small></div> })}</div>
        {d.per_type.map(x => { const t = T(x.k)!
          return <div className="panel mb" key={x.k}><div className="ph"><Ic n={t.ic} /> {t.n}<span className="fl" /><small className="mu">{x.entries.length} entr{x.entries.length === 1 ? 'y' : 'ies'}</small></div>
            <div className="pb z">{x.k === 'pay'
              ? <Tbl<DEntry> rows={x.entries} cols={[
                { k: 'cust', t: 'Customer', fn: l => l.customer || '—' }, { k: 'ten', t: 'Tender', fn: l => <TenH l={l} /> },
                { k: 'v', t: 'Committed', r: true, fn: l => inr(l.v) }, { k: 'due', t: 'Expected', fn: l => fd(l.due) },
                { k: 'a', t: 'Received', r: true, fn: l => <>{inr(l.r?.ack)}{l.r?.pen ? <><br /><small className="twarn">{inr(l.r.pen)} awaiting finance</small></> : null}</> },
                { k: 's', t: 'Status', fn: l => l.r ? <Pill s={l.r.st} t={CMSC[l.r.st]} /> : '—' }]} />
              : <Tbl<DEntry> rows={x.entries} cols={[
                { k: 'n', t: 'Committed', r: true, fn: l => fmtN(l.n) }, { k: 'v', t: 'Value', r: true, fn: l => inr(l.v) },
                { k: 'ref', t: 'Reference', fn: l => l.deal_id ? `J-${String(l.deal_id).padStart(4, '0')}` : l.tender_id ? <TenH l={l} /> : (l.customer || l.source || '—') },
                { k: 'note', t: 'Note', fn: l => l.note },
                { k: 's', t: 'Status', fn: l => l.r ? <Pill s={l.r.st} t={CMSC[l.r.st]} /> : <small className="mu">counted at type level</small> }]} />}
            </div></div> })}
        {d.weeks.length > 1 && <div className="panel mb"><div className="ph">Weekly view<span className="fl" /><small className="mu">{d.per} commitment converted to weeks (pro-rata by days)</small></div>
          <div className="pb z"><div className="tw fit"><table className="t"><thead><tr><th>Week</th>{d.per_type.map(x => <th key={x.k} className="r">{T(x.k)!.n}</th>)}</tr></thead>
            <tbody>{d.weeks.map(w => <tr key={w.from}><td>{w.label}</td>{w.cells.map(c => { const t = T(c.k)
              return <td key={c.k} className="r">{c.future ? <span className="mu">{cmFmt(t, c.cv)}</span>
                : <>{cmFmt(t, c.av)} <small className="mu">/ {cmFmt(t, c.cv)}</small> <small style={{ color: pc3(c.p) }}>{c.p}%</small></>}</td> })}</tr>)}</tbody></table></div></div></div>}
        {d.note && <div className="note inf">{d.note}</div>}
      </div>}
    </aside>
    {confirm && d && <Modal title="Delete this commitment?" width={420} onClose={() => setConfirm(false)}
      foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setConfirm(false)}>Cancel</button><button type="button" className="btn d" disabled={busy} onClick={del}>Delete</button></>}>
      {d.code} – {d.owner} · {d.label}. Its entries are removed; achievements in the source modules are not affected.
    </Modal>}
  </div>, host)
}
