// Product & Price Books – prototype v18 pxBooks(): two columns – Price books list (name · type · % · currency ·
// status, + New) and the selected book: Adjustment on list (%) · Valid from · Valid to · Status · Applies to, the
// pricing note and the table Code | Product | Status | List | Book price | Override (₹) | Margin | Floor.
// Book price = list ± adjustment unless overridden; floor = cost + the company's minimum margin.
import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { errMsg, inr, money, plusDays, productApi, stTone, today, type Book, type BookDetail, type BookRow, type Meta } from './productApi'

const Pill = ({ s, t }: { s: string; t: string }) => <span className={`pill ${t}`}>{s}</span>
const bookTone = (s: string) => s === 'Active' ? 'ok' : s === 'Expired' ? 'ba' : 'mu'
const pctTxt = (n: number) => `${n > 0 ? '+' : ''}${n}%`

export default function PriceBooksTab({ meta }: { meta: Meta }) {
  const { success, error, warning } = useToast()
  const [sp, setSp] = useSearchParams()
  const [books, setBooks] = useState<Book[] | null>(null)
  const [d, setD] = useState<BookDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [delBook, setDelBook] = useState<Book | null>(null)
  const [rev, setRev] = useState(0)
  const sel = sp.get('book') ? Number(sp.get('book')) : null
  const setSel = useCallback((id: number | null) => setSp(s => { const n = new URLSearchParams(s); if (id) n.set('book', String(id)); else n.delete('book'); return n }, { replace: true }), [setSp])
  const can = meta.can

  useEffect(() => {
    productApi.books().then(r => { setBooks(r.items); if (!r.items.some(b => b.id === sel) && r.items[0]) setSel(r.items[0].id) })
      .catch(e => error(errMsg(e, 'Could not load price books')))
  }, [rev]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sel == null) { setD(null); return }
    let live = true
    productApi.book(sel).then(x => { if (live) setD(x) }).catch(e => { if (live) error(errMsg(e, 'Could not load the price book')) })
    return () => { live = false }
  }, [sel, rev, error])

  const patch = async (b: Partial<{ adjustment: number; valid_from: string; valid_to: string; status: string; applies_to: string; rate: number }>) => {
    if (!d) return
    try { const r = await productApi.patchBook(d.id, b); r.message ? warning(r.message) : success('Price book updated'); setRev(x => x + 1) }
    catch (e) { error(errMsg(e, 'Could not update the price book')); setRev(x => x + 1) }
  }
  const saveOverride = useCallback(async (r: BookRow, v: string) => {
    if (!d) return
    const t = v.trim()
    if (t === '' && r.override == null) return
    if (t !== '' && (Number.isNaN(Number(t)) || Number(t) < 0)) { error('Override must be a number of 0 or more'); return }
    if (t !== '' && r.override != null && Number(t) === r.override) return
    try {
      const res = await productApi.override(d.id, r.id, t === '' ? null : Number(t))
      res.message ? warning(res.message) : success(t === '' ? `${r.code} back to the book rule` : `${r.code} override saved`)
      if (res.row) setD(x => x ? { ...x, rows: x.rows.map(y => y.id === r.id ? res.row! : y) } : x)
      setRev(x => x + 1)
    } catch (e) { error(errMsg(e, 'Could not save the override')); setRev(x => x + 1) }
  }, [d, success, error, warning])

  const cur = d?.currency || meta.config.base_currency, min = d?.min_margin ?? meta.model.rules.minMargin
  const editable = !!can.update && d?.approval !== 'pending'
  const cols: GridCol<BookRow>[] = useMemo(() => [
    { k: 'code', t: 'Code', w: 120, fn: r => <b>{r.code}</b>, txt: r => r.code },
    { k: 'name', t: 'Product', w: 260 },
    { k: 'status', t: 'Status', w: 130, txt: r => r.status, fn: r => r.status ? <Pill s={r.status} t={stTone(meta.model, r.status)} /> : <span className="mu">—</span> },
    { k: 'list', t: 'List', w: 110, r: true, sv: r => r.list ?? -1, fn: r => r.list != null ? inr(r.list) : <span className="mu">—</span> },
    { k: 'price', t: 'Book price', w: 120, r: true, sv: r => r.price ?? -1, fn: r => <>{r.price != null ? <b className={r.below_floor ? 'tbad' : ''}>{money(r.price, cur)}</b>
      : <span className="mu" title={cur !== d?.base_currency ? 'Set the exchange rate of this book' : 'No list price'}>—</span>}
      {r.pending != null && <> <Pill s={`Pending ${money(r.pending, cur)}`} t="wa" /></>}</> },
    { k: 'override', t: `Override (${cur === 'INR' ? '₹' : cur})`, w: 140, txt: r => r.override != null ? String(r.override) : '',
      fn: r => <input key={`${r.id}-${r.override ?? ''}`} className="in sm" type="number" min={0} step="any" placeholder="—" style={{ width: 120 }} aria-label={`Override for ${r.code}`}
        defaultValue={r.override ?? ''} disabled={!editable || r.pending != null} onClick={e => e.stopPropagation()}
        onBlur={e => void saveOverride(r, e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} /> },
    { k: 'margin', t: 'Margin', w: 90, r: true, sv: r => r.margin ?? -9999, fn: r => r.margin == null ? <span className="mu">—</span> : <span className={r.margin < min ? 'tbad' : 'tok'}>{r.margin}%</span> },
    { k: 'floor', t: 'Floor', w: 110, r: true, sv: r => r.floor ?? -1, fn: r => r.floor != null ? money(r.floor, cur) : <span className="mu">—</span> },
  ], [meta.model, cur, d?.base_currency, editable, min, saveOverride])

  return <>
    {meta.companies.length > 1 && <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}><small className="mu">Company</small>{meta.companies.map(c => <span key={c.id} className="chip on">{c.name}</span>)}</div>}
    <div className="g pxbooks">
      <div className="panel"><div className="ph">Price books<span className="fl" />{can.create && <button type="button" className="btn s p" onClick={() => setCreating(true)}><Ic n="plus" /> New</button>}</div>
        <div className="side" role="listbox" aria-label="Price books">
          {!books ? <div className="mu">Loading…</div> : !books.length ? <div className="mu">No price books yet</div> : books.map(b => <div key={b.id} role="option" aria-selected={b.id === sel} tabIndex={0}
            className={b.id === sel ? 'on' : ''} onClick={() => setSel(b.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(b.id) } }}>
            <div className="fl"><b>{b.name}</b><br /><small className="mu">{b.type} · {pctTxt(b.adjustment)} · {b.currency}</small></div>
            {b.approval === 'pending' ? <Pill s="Pending" t="wa" /> : <Pill s={b.status} t={bookTone(b.status)} />}</div>)}
        </div></div>
      <div className="panel">
        {!d ? <div className="empty">{books?.length === 0 ? 'Create a price book to get started.' : 'Loading…'}</div> : <>
          <div className="ph">{d.name}<span className="fl" />{d.approval === 'pending' ? <Pill s="Pending approval" t="wa" /> : <Pill s={d.status} t={bookTone(d.status)} />}
            {can.delete && !d.is_default && <button type="button" className="btn g s" title="Delete price book" aria-label="Delete price book" onClick={() => setDelBook(d)}><Ic n="trash" /></button>}</div>
          <div className="pb">
            {d.approval === 'pending' && <div className="note mb">Waiting for approval: {d.pending_adjustment != null ? pctTxt(d.pending_adjustment) : ''} adjustment. Prices below use the approved rule.</div>}
            {d.approval !== 'pending' && d.pending_adjustment != null && <div className="note mb">A change to {pctTxt(d.pending_adjustment)} is waiting for approval – prices below use {pctTxt(d.adjustment)}.</div>}
            <BookForm key={`${d.id}-${rev}`} d={d} disabled={!editable} onPatch={patch} />
            <div className="note inf mt">Book price = list {d.adjustment >= 0 ? '+' : '−'} {Math.abs(d.adjustment)}% unless overridden. Prices below cost + {d.min_margin}% are {d.floor_policy === 'Block' ? 'blocked' : d.floor_policy === 'Approval' ? 'sent for approval' : 'flagged'}; discounts beyond {d.approval_limit}% route to Sales Head approval in quotes.</div>
          </div>
          <div className="pb z"><BwGrid id={`pb-v18-${d.id}`} cols={cols} rows={d.rows} rid={r => String(r.id)} empty="No products in this price book." /></div>
        </>}
      </div>
    </div>
    {creating && <NewBookModal meta={meta} onClose={() => setCreating(false)} onCreated={(id, msg) => { setCreating(false); msg ? warning(msg) : success('Price book created as draft'); setSel(id); setRev(x => x + 1) }} />}
    {delBook && <Modal title="Delete price book?" width={420} onClose={() => setDelBook(null)} foot={<><span className="fl" />
      <button type="button" className="btn" onClick={() => setDelBook(null)}>Cancel</button>
      <button type="button" className="btn d" onClick={async () => {
        try { await productApi.deleteBook(delBook.id); success('Price book deleted'); setDelBook(null); setSel(null); setRev(x => x + 1) } catch (e) { error(errMsg(e, 'Could not delete')) }
      }}>Delete</button></>}>
      <p style={{ margin: 0 }}>Delete <b>{delBook.name}</b>? Its overrides and change history are kept for audit.</p>
    </Modal>}
  </>
}

/** selected book configuration: Adjustment on list (%) · Valid from · Valid to · Status · Applies to (+ rate for a foreign book) */
function BookForm({ d, disabled, onPatch }: { d: BookDetail; disabled: boolean; onPatch: (b: Record<string, string | number>) => void }) {
  const [v, setV] = useState({ adjustment: String(d.adjustment), valid_from: d.valid_from || '', valid_to: d.valid_to || '', applies_to: d.applies_to, rate: d.rate != null ? String(d.rate) : '' })
  const blur = (k: keyof typeof v, orig: string) => {
    const x = v[k].trim()
    if (x === orig) return
    if (k === 'adjustment' || k === 'rate') {
      if (x === '' || Number.isNaN(Number(x))) { setV(s => ({ ...s, [k]: orig })); return }
      onPatch({ [k]: Number(x) })
    } else onPatch({ [k]: x })
  }
  const foreign = d.currency !== d.base_currency
  return <div className="fg" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
    <div><label htmlFor="pb-adj">Adjustment on list (%)</label><input id="pb-adj" className="in" type="number" step="any" disabled={disabled} value={v.adjustment}
      onChange={e => setV(s => ({ ...s, adjustment: e.target.value }))} onBlur={() => blur('adjustment', String(d.adjustment))} /></div>
    <div><label htmlFor="pb-from">Valid from</label><input id="pb-from" className="in" type="date" disabled={disabled} value={v.valid_from} max={v.valid_to || undefined}
      onChange={e => setV(s => ({ ...s, valid_from: e.target.value }))} onBlur={() => blur('valid_from', d.valid_from || '')} /></div>
    <div><label htmlFor="pb-to">Valid to</label><input id="pb-to" className="in" type="date" disabled={disabled} value={v.valid_to} min={v.valid_from || undefined}
      onChange={e => setV(s => ({ ...s, valid_to: e.target.value }))} onBlur={() => blur('valid_to', d.valid_to || '')} /></div>
    <div><label htmlFor="pb-st">Status</label><select id="pb-st" className="in" disabled={disabled} value={d.status} onChange={e => onPatch({ status: e.target.value })}>
      {['Draft', 'Active', 'Expired'].map(s => <option key={s}>{s}</option>)}</select></div>
    <div className="f1" style={{ gridColumn: foreign ? 'span 3' : '1 / -1' }}><label htmlFor="pb-app">Applies to</label><input id="pb-app" className="in" disabled={disabled} value={v.applies_to} maxLength={300}
      onChange={e => setV(s => ({ ...s, applies_to: e.target.value }))} onBlur={() => blur('applies_to', d.applies_to)} /></div>
    {foreign && <div><label htmlFor="pb-rate">Rate ({d.base_currency} per 1 {d.currency})</label><input id="pb-rate" className="in" type="number" min={0} step="any" disabled={disabled} value={v.rate}
      placeholder="Required for prices" onChange={e => setV(s => ({ ...s, rate: e.target.value }))} onBlur={() => blur('rate', d.rate != null ? String(d.rate) : '')} /></div>}
  </div>
}

/** prototype A.pbNew – Name · Type · Adjustment on list (%) · Currency · Valid to · Applies to; created as Draft */
function NewBookModal({ meta, onClose, onCreated }: { meta: Meta; onClose: () => void; onCreated: (id: number, msg: string | null) => void }) {
  const { error } = useToast()
  const [v, setV] = useState({ name: '', type: 'Customer contract', adjustment: '-5', currency: meta.config.base_currency, valid_to: plusDays(180), applies_to: '' })
  const [err, setErr] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const check = () => {
    const e: Record<string, string> = {}
    if (v.name.trim().length < 2) e.name = 'Name the price book'
    if (v.adjustment.trim() === '' || Number.isNaN(Number(v.adjustment)) || Number(v.adjustment) <= -100 || Number(v.adjustment) > 1000) e.adjustment = 'Enter a percentage above −100 and up to 1000'
    if (!meta.config.currencies.includes(v.currency)) e.currency = 'Choose a configured currency'
    if (!v.valid_to) e.valid_to = 'Valid to is required'
    else if (v.valid_to < today()) e.valid_to = 'Valid to cannot be in the past'
    if (!v.applies_to.trim()) e.applies_to = 'Say who this book applies to'
    setErr(e)
    return !Object.keys(e).length
  }
  const F = (k: keyof typeof v, label: string, el: ReactNode, cls = '') => <div className={cls}><label htmlFor={`nb-${k}`}>{label}</label>{el}{err[k] && <small className="tbad" role="alert">{err[k]}</small>}</div>
  const on = (k: keyof typeof v) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV(s => ({ ...s, [k]: e.target.value }))
  return <Modal title="New price book" width={520} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={async () => {
      if (!check()) return
      setBusy(true)
      try { const r = await productApi.createBook({ ...v, name: v.name.trim(), applies_to: v.applies_to.trim(), adjustment: Number(v.adjustment) }); onCreated(r.id, r.message) }
      catch (e) { error(errMsg(e, 'Could not create the price book')) } finally { setBusy(false) }
    }}>{busy ? 'Creating…' : 'Create price book'}</button></>}>
    <div className="fg">
      {F('name', 'Name', <input id="nb-name" className="in" value={v.name} maxLength={120} placeholder="e.g. State rate contract FY27" onChange={on('name')} />, 'f1')}
      {F('type', 'Type', <select id="nb-type" className="in" value={v.type} onChange={on('type')}>{meta.lookups.book_types.map(t => <option key={t}>{t}</option>)}</select>)}
      {F('adjustment', 'Adjustment on list (%)', <input id="nb-adjustment" className="in" type="number" step="any" value={v.adjustment} onChange={on('adjustment')} />)}
      {F('currency', 'Currency', <select id="nb-currency" className="in" value={v.currency} onChange={on('currency')}>{meta.config.currencies.map(c => <option key={c}>{c}</option>)}</select>)}
      {F('valid_to', 'Valid to', <input id="nb-valid_to" className="in" type="date" min={today()} value={v.valid_to} onChange={on('valid_to')} />)}
      {F('applies_to', 'Applies to', <input id="nb-applies_to" className="in" value={v.applies_to} maxLength={300} placeholder="Customer, segment or scheme" onChange={on('applies_to')} />, 'f1')}
    </div>
  </Modal>
}
