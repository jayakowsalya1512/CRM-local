// Prototype v18 cmModal(): New commitment / Edit commitment.
// Header (Commitment by · Commit for · Period with dates, days and weeks) → target strip (Target for this period ·
// Payment commitment · Weekly equivalent) → existing-commitment warning → one block per enabled commitment type with
// its entries (Add entry / remove) → types not offered → Note to manager → Cancel · Submit commitment / Save changes.
import { useEffect, useState } from 'react'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { fd, inr } from '@/pages/customers/customerApi'
import { cmApi, errText, fmtN, noPeopleWhy, lakh, pctOf, type Entry, type FormMeta, type Meta, type PeriodOpt, type Refs, type TypeKey } from './commitmentApi'

export type Open = { owner?: number; id?: number; edit?: { owner_id: number; per: string; anchor: string; note: string; entries: Entry[] } }
const blank = (t: TypeKey): Entry => ({ type: t, n: 1, value: 0, customer_id: null, tender_id: null, old_tender: '', work_order_id: null, deal_id: null, source: '', expected_on: null, note: '' })
const minD = (a: string, b: string) => a < b ? a : b, maxD = (a: string, b: string) => a > b ? a : b

/** Number input that keeps what is being typed ("1.", "") and reports the parsed value. */
function NumIn({ v, onV, step = 1, label }: { v: number; onV: (n: number) => void; step?: number; label: string }) {
  const [s, setS] = useState(String(v))
  useEffect(() => { if (Number(s) !== v) setS(String(v)) }, [v]) // eslint-disable-line react-hooks/exhaustive-deps
  return <input className="in" type="number" min={0} step={step} value={s} aria-label={label} onChange={e => { setS(e.target.value); onV(Number(e.target.value) || 0) }} />
}

export default function CommitmentModal({ meta, open, onClose, onSaved }: { meta: Meta; open: Open; onClose: () => void; onSaved: () => void }) {
  const { success, error } = useToast()
  const ppl = meta.people
  const startWho = open.edit?.owner_id ?? (open.owner && ppl.some(p => p.id === open.owner) ? open.owner : ppl.some(p => p.id === meta.me.id) ? meta.me.id : ppl[0]?.id)
  const [id, setId] = useState<number | undefined>(open.id)
  const [who, setWho] = useState<number | undefined>(startWho)
  const [per, setPer] = useState(open.edit?.per ?? (meta.settings.periods.includes('Week') ? 'Week' : meta.settings.periods[0]))
  const [anchor, setAnchor] = useState<string | null>(open.edit?.anchor ?? null)
  const [lines, setLines] = useState<Entry[]>(open.edit?.entries ?? [])
  const [note, setNote] = useState(open.edit?.note ?? '')
  const [fm, setFm] = useState<FormMeta | null>(null)
  const [fmErr, setFmErr] = useState<string | null>(null)
  const [extra, setExtra] = useState<PeriodOpt | null>(null)
  const [refs, setRefs] = useState<Record<number, Refs>>({})
  const [busy, setBusy] = useState(false)
  const types = meta.types.filter(t => t.on)
  const off = meta.types.filter(t => !t.on)

  useEffect(() => {
    if (!who) return
    setFm(null); setFmErr(null)
    cmApi.formMeta(who).then(setFm).catch(e => setFmErr(errText(e, 'Could not load the commitment form')))
  }, [who])
  useEffect(() => { if (!open.edit && !lines.length) setLines(types.map(t => blank(t.k))) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const opts = fm?.periods[per] ?? []
  const cur = opts.find(o => o.opt.endsWith('· current')) ?? opts[0]
  const P: PeriodOpt | undefined = (anchor && (opts.find(o => o.from === anchor) || (extra?.from === anchor ? extra : undefined))) || cur
  useEffect(() => { // an older period being edited is not in the standard options – ask the server for it
    if (anchor && fm && !opts.some(o => o.from === anchor) && extra?.from !== anchor) cmApi.period(per, anchor).then(setExtra).catch(() => undefined)
  }, [anchor, per, fm]) // eslint-disable-line react-hooks/exhaustive-deps
  const allOpts = P && !opts.some(o => o.from === P.from) ? [P, ...opts] : opts

  const loadRefs = (cid: number) => { if (!refs[cid]) cmApi.refs(cid).then(r => setRefs(s => ({ ...s, [cid]: r }))).catch(() => setRefs(s => ({ ...s, [cid]: { tenders: [], orders: [] } }))) }
  useEffect(() => { lines.forEach(l => { if (l.type === 'pay' && l.customer_id) loadRefs(l.customer_id) }) }, [lines.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const person = ppl.find(p => p.id === who)
  const mg = !!fm?.owner.head
  const tg = fm?.target ?? 0
  const days = P?.days ?? 7, wk = days / 7
  const ptg = Math.round(tg * days / 365)
  const pay = lines.filter(l => l.type === 'pay').reduce((s, l) => s + (+l.value || 0), 0)
  const ex = fm && P ? fm.existing.find(c => c.id !== id && c.per === per && c.from === P.from) : undefined

  const upd = (i: number, patch: Partial<Entry>) => setLines(L => L.map((l, j) => j === i ? { ...l, ...patch } : l))
  const setTender = (i: number, l: Entry, v: string) => {
    if (v === '__old') return upd(i, { tender_id: null, work_order_id: null, old_tender: l.old_tender || ' ' })
    if (!v) return upd(i, { tender_id: null, work_order_id: null, old_tender: '' })
    const t = (refs[l.customer_id || 0]?.tenders || []).find(x => x.tender_id === Number(v))
    const patch: Partial<Entry> = { tender_id: Number(v), old_tender: '', work_order_id: t?.wo_id ?? null }
    if (t?.next && !l.value && P) { patch.value = Math.round(t.next.balance / 1e5) * 1e5; patch.expected_on = l.expected_on || minD(maxD(t.next.due || meta.today, meta.today), P.to) }
    upd(i, patch)
  }
  const pickWho = (v: number) => { setWho(v); setId(undefined); const ok = new Set(types.map(t => t.k)); setLines(L => L.filter(l => ok.has(l.type))) }
  const pickPer = (v: string) => { setPer(v); setAnchor(null); setExtra(null) }
  const editExisting = async (cid: number) => {
    try {
      const d = await cmApi.detail(cid)
      if (!d.can.edit) { error('This commitment cannot be edited', 'Its period is over or you are not allowed to change it'); return }
      setId(d.id); setPer(d.edit.per); setAnchor(d.edit.anchor); setLines(d.edit.entries); setNote(d.edit.note)
    } catch (e) { error('Could not open the commitment', errText(e)) }
  }

  const save = async () => {
    if (!who || !P) return
    const L = lines.filter(l => l.type === 'pay' ? (l.customer_id || l.value) : ((+l.n || 0) > 0 || (+l.value || 0) > 0))
    for (const l of L) {
      if (l.type === 'pay') {
        if (!l.customer_id) return error('Choose the customer for each payment')
        const cn = fm?.customers.find(c => c.id === l.customer_id)?.name || 'this customer'
        if (meta.settings.pay_tender && !l.tender_id && !l.old_tender.trim()) return error(`Choose the tender (or name the old tender) for the payment from ${cn}`)
        if (!(l.value > 0)) return error(`Enter the amount for the payment from ${cn}`)
        if (l.expected_on && isNaN(Date.parse(l.expected_on))) return error('Enter a valid expected date')
      } else if (!((+l.n || 0) > 0)) return error('Enter how many for each entry')
    }
    if (!L.length) return error('Add at least one entry')
    setBusy(true)
    try {
      const body = { owner_id: who, per, anchor: P.from, entries: L.map(l => ({ ...l, old_tender: l.old_tender.trim() })), note, replace: !!ex }
      const r = id ? await cmApi.update(id, body) : await cmApi.create(body)
      success(r.updated ? 'Commitment updated' : 'Commitment submitted', r.label)
      onSaved()
    } catch (e: any) {
      const d = e?.response?.data?.detail
      if (e?.response?.status === 409 && d?.existing_id && fm) { setFm({ ...fm, existing: [...fm.existing.filter(x => x.id !== d.existing_id), { id: d.existing_id, code: '', per, from: P.from, scope: mg ? 'team' : 'self' }] }) }
      error(id ? 'Commitment not saved' : 'Commitment not submitted', errText(e))
    } finally { setBusy(false) }
  }

  const sel = (val: string | number | null | undefined, onV: (v: string) => void, list: [string | number, string][], ph: string | null, label: string) =>
    <select className="in" value={val ?? ''} aria-label={label} onChange={e => onV(e.target.value)}>{ph != null && <option value="">{ph}</option>}{list.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
  const x = (i: number) => <button type="button" className="btn g s" title="Remove" aria-label="Remove entry" onClick={() => setLines(L => L.filter((_, j) => j !== i))}><Ic n="x" /></button>
  const num = (i: number, lab: string, v: number, f: (n: number) => Partial<Entry>, step = 1) => <div><label>{lab}</label><NumIn v={v} step={step} label={lab} onV={n => upd(i, f(n))} /></div>
  const txt = (i: number, l: Entry) => <div className="w"><label>Note</label><input className="in" value={l.note} maxLength={500} onChange={e => upd(i, { note: e.target.value })} /></div>
  const custs: [number, string][] = (fm?.customers || []).map(c => [c.id, c.name])

  const row = (l: Entry, i: number) => {
    if (l.type === 'pay') {
      const T = refs[l.customer_id || 0]?.tenders || [], old = !l.tender_id && !!l.old_tender
      return <div className="cm8-ln pay" key={i}>
        <div className="w"><label>Customer <b className="tbad">*</b></label>{sel(l.customer_id, v => { const c = Number(v) || null; upd(i, { customer_id: c, tender_id: null, old_tender: '', work_order_id: null }); if (c) loadRefs(c) }, custs, 'Select customer…', 'Customer')}</div>
        <div className="w"><label>Against tender {meta.settings.pay_tender && <b className="tbad">*</b>}</label>{sel(old ? '__old' : l.tender_id, v => setTender(i, l, v), [...T.map(t => [t.tender_id, t.label] as [number, string]), ['__old', 'Old tender – not in the system']], l.customer_id ? 'Select tender…' : 'Pick the customer first', 'Against tender')}</div>
        {old && <div className="w"><label>Old tender name / number</label><input className="in" value={l.old_tender.trim() ? l.old_tender : ''} placeholder="e.g. NIT/2023/118 – Substation AMC" maxLength={300} onChange={e => upd(i, { old_tender: e.target.value || ' ' })} /></div>}
        {num(i, 'Amount (₹ lakh)', lakh(l.value), n => ({ value: Math.round(n * 1e5) }), 0.1)}
        <div><label>Expected on</label><input className="in" type="date" value={l.expected_on || ''} onChange={e => upd(i, { expected_on: e.target.value || null })} /></div>
        {txt(i, l)}{x(i)}</div>
    }
    if (l.type === 'deal') {
      return <div className="cm8-ln" key={i}>
        <div className="w"><label>Deal (optional)</label>{sel(l.deal_id, v => { const o = fm?.deals.find(d => d.id === Number(v)); upd(i, o ? { deal_id: o.id, n: 1, value: o.value, customer_id: o.customer_id } : { deal_id: null }) }, (fm?.deals || []).map(o => [o.id, `J-${String(o.id).padStart(4, '0')} · ${o.name.slice(0, 40)}`]), 'Any deal / not listed', 'Deal')}</div>
        {!l.deal_id && num(i, 'Deals', l.n, n => ({ n }))}
        {num(i, 'Value (₹ lakh)', lakh(l.value), n => ({ value: Math.round(n * 1e5) }), 0.1)}
        <div><label>Expected close</label><input className="in" type="date" value={l.expected_on || ''} onChange={e => upd(i, { expected_on: e.target.value || null })} /></div>
        {txt(i, l)}{x(i)}</div>
    }
    if (l.type === 'bid') {
      return <div className="cm8-ln" key={i}>
        <div className="w"><label>Tender (optional)</label>{sel(l.tender_id, v => { const t = fm?.tenders.find(d => d.id === Number(v)); upd(i, t ? { tender_id: t.id, n: 1, value: t.value } : { tender_id: null }) }, (fm?.tenders || []).map(t => [t.id, `${t.ref} · ${t.customer.slice(0, 24)}${t.submit ? ` · due ${fd(t.submit).slice(0, 6)}` : ''}`]), 'Any tender', 'Tender')}</div>
        {!l.tender_id && num(i, 'Bids', l.n, n => ({ n }))}
        {num(i, 'Value (₹ lakh)', lakh(l.value), n => ({ value: Math.round(n * 1e5) }), 0.1)}
        {txt(i, l)}{x(i)}</div>
    }
    return <div className="cm8-ln" key={i}>
      {num(i, ({ lead: 'Leads', quote: 'Quotes', order: 'Orders' } as Record<string, string>)[l.type] || 'Count', l.n, n => ({ n }))}
      {num(i, 'Est. value (₹ lakh)', lakh(l.value), n => ({ value: Math.round(n * 1e5) }), 0.1)}
      {l.type !== 'lead'
        ? <div className="w"><label>Customer (optional)</label>{sel(l.customer_id, v => upd(i, { customer_id: Number(v) || null }), custs, 'Any customer', 'Customer')}</div>
        : <div className="w"><label>Source / segment</label>{sel(l.source, v => upd(i, { source: v }), (fm?.sources || []).map(s => [s, s]), 'Any source', 'Source / segment')}</div>}
      {txt(i, l)}{x(i)}</div>
  }

  return <Modal title={<><Ic n="target" /> {id ? 'Edit commitment' : 'New commitment'}</>} width={940} onClose={onClose}
    foot={<><small className="fl mu">Cut-off: {meta.settings.cutoff} · achievements are tracked automatically from leads, deals, bids and Finance-acknowledged payments</small>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn p" disabled={busy || !fm || !P} onClick={save}>{busy ? 'Saving…' : id ? 'Save changes' : 'Submit commitment'}</button></>}>
    {!ppl.length ? <div className="note">{noPeopleWhy(meta)}</div> : <>
      <div className="cm8-hd">
        <div><label className="lb">Commitment by</label>
          <select className="in" value={who ?? ''} disabled={!!id || !meta.can.others} aria-label="Commitment by" onChange={e => pickWho(Number(e.target.value))}>
            {ppl.filter(p => meta.can.others || p.id === meta.me.id || p.id === who).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <small className="mu">{mg ? `Team commitment for ${(fm?.owner.teams || []).join(' + ') || 'the whole team'}` : person?.team}</small></div>
        <div><label className="lb">Commit for</label><div className="seg8">{meta.settings.periods.map(p => <button key={p} type="button" className={p === per ? 'on' : ''} onClick={() => pickPer(p)}>{p}</button>)}</div></div>
        <div><label className="lb">Period</label>
          <select className="in" value={P?.from ?? ''} aria-label="Period" onChange={e => setAnchor(e.target.value)}>{allOpts.map(o => <option key={o.from} value={o.from}>{o.opt || o.label}</option>)}</select>
          {P && <small className="mu">{fd(P.from)} – {fd(P.to)} · {P.days} days · {fmtN(wk)} week{fmtN(wk) === '1' ? '' : 's'}</small>}</div>
      </div>
      {fmErr && <div className="err-box mb">{fmErr}</div>}
      <div className="cm8-tg">
        <div><small>Target for this period</small><b>{inr(ptg)}</b><span className="mu">{mg ? 'team' : 'annual'} target {inr(tg)} × {days}/365</span></div>
        <div><small>Payment commitment</small><b>{inr(pay)}</b><span className={pay >= ptg ? 'tok' : 'twarn'}>{pctOf(pay, ptg)}% of the period target</span></div>
        <div><small>Weekly equivalent</small><b>{inr(pay / wk)}</b><span className="mu">used in the weekly management report</span></div>
      </div>
      {ex && <div className="note mb row"><Ic n="alert" /><span className="fl">{person?.name} already has a {per.toLowerCase()} commitment for this period{ex.code ? ` (${ex.code})` : ''}. Saving replaces it.</span>
        <button type="button" className="btn s" onClick={() => editExisting(ex.id)}>Edit that one instead</button></div>}
      {types.map(t => {
        const L = lines.map((l, i) => [l, i] as const).filter(([l]) => l.type === t.k)
        const n = L.reduce((s, [l]) => s + (t.k === 'pay' ? 1 : (+l.n || 0)), 0), v = L.reduce((s, [l]) => s + (+l.value || 0), 0)
        return <div className="cm8-blk" key={t.k}>
          <div className="cm8-bh"><span className="cm8-bi"><Ic n={t.ic} /></span><div className="fl"><b>{t.n}</b><small className="mu">{t.h}</small></div>
            <span className="cm8-sum">{t.money ? inr(v) : `${fmtN(n)} ${t.s}${v ? ` · ${inr(v)}` : ''}`}<small className="mu">{t.money ? `≈ ${inr(v / wk)}` : `≈ ${fmtN(n / wk)}`}/week</small></span>
            <button type="button" className="btn s" onClick={() => setLines(X => [...X, blank(t.k)])}><Ic n="plus" /> Add entry</button></div>
          {L.length ? L.map(([l, i]) => row(l, i)) : <div className="cm8-none">No entry – this type is left out of the commitment</div>}
        </div>
      })}
      {off.length > 0 && <small className="mu">Not offered: {off.map(t => t.n).join(', ')} – {off.some(t => !t.flow) ? 'that step is switched off in the business flow' : 'switched off in commitment settings'}.</small>}
      <label className="lb mt">Note to manager</label>
      <textarea className="in" rows={2} value={note} maxLength={4000} placeholder="Risks, help needed, key meetings this period" onChange={e => setNote(e.target.value)} />
    </>}
  </Modal>
}
