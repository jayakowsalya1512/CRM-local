// Product & Price Books (prototype v18) – product forms and modals:
// pxInput (field by model type), A.pxNew (New product), A.pxEdit (Edit details), A.pxStat (record status move),
// A.pxUnlock (change window on an approved record) and A.pxImp (Import Product Master workbook with preview).
import { useMemo, useState } from 'react'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { download, errMsg, inr, productApi, stTone, type Detail, type ImportPreview, type MField, type Meta, type Vals } from './productApi'

const Pill = ({ s, t }: { s: string; t: string }) => <span className={`pill ${t}`}>{s}</span>

/** prototype pxInput(): one product-model field */
export function FieldInput({ f, meta, value, onChange, disabled, id }: { f: MField; meta: Meta; value: unknown; onChange: (v: string) => void; disabled?: boolean; id: string }) {
  const v = value == null ? '' : String(value)
  const m = meta.model
  const sel = (opts: [string, string][], ph = 'Select…') => <select id={id} className="in" value={v} disabled={disabled} onChange={e => onChange(e.target.value)}>
    <option value="">{ph}</option>{opts.map(([val, l]) => <option key={val} value={val}>{l}</option>)}</select>
  if (f.type === 'ta') return <textarea id={id} className="in" rows={2} value={v} disabled={disabled} onChange={e => onChange(e.target.value)} />
  if (f.type === 'cat') return sel(m.categories.map(c => [c.name, c.name]))
  if (f.type === 'unit') return sel(m.units.map(u => [u, u]))
  if (f.type === 'oem') return sel(meta.lookups.oems.map(o => [String(o.id), o.name]), meta.lookups.oems.length ? 'Select…' : 'No partners in Partners & OEM')
  if (f.type === 'sel') return sel((f.options || []).map(o => [o, o]))
  if (f.type === 'status') return <input id={id} className="in" disabled value={v} />
  if (f.type === 'cur' || f.type === 'num') return <input id={id} className="in" type="number" min={0} step="any" value={v} disabled={disabled} onChange={e => onChange(e.target.value)} />
  if (f.type === 'date') return <input id={id} className="in" type="date" value={v.slice(0, 10)} disabled={disabled} onChange={e => onChange(e.target.value)} />
  return <input id={id} className="in" value={v} disabled={disabled} maxLength={f.type === 'code' ? 40 : undefined} onChange={e => onChange(e.target.value)} />
}

const req = (f: MField) => f.req ? <> <b className="tbad">*</b></> : null
const missing = (fs: MField[], v: Vals) => fs.filter(f => f.req && !['status', 'code'].includes(f.key) && (v[f.key] == null || String(v[f.key]).trim() === '')).map(f => f.label)
const pct = (list: unknown, cost: unknown) => { const l = Number(list || 0), c = Number(cost || 0); return l ? Math.round((1 - c / l) * 100) : null }

/** prototype A.pxNew – fields and lists from the company model; starts in the first record status */
export function NewProductModal({ meta, onClose, onCreated }: { meta: Meta; onClose: () => void; onCreated: (id: number, code: string) => void }) {
  const { error } = useToast()
  const m = meta.model
  const fs = useMemo(() => m.fields.filter(f => f.on && f.key !== 'status' && (f.req || ['code', 'unit', 'list', 'cost', 'coo', 'features', 'oem'].includes(f.key))), [m.fields])
  const [v, setV] = useState<Vals>(() => ({ cat: m.categories[0]?.name || '', unit: m.units[0] || '' }))
  const [stage, setStage] = useState<number | ''>(m.stages[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const mg = pct(v.list, v.cost)
  const save = async () => {
    const miss = missing(fs, v)
    if (miss.length) { setErr(`Required: ${miss.join(', ')}`); return }
    if (Number(v.list || 0) < 0 || Number(v.cost || 0) < 0) { setErr('List price and standard cost must be zero or more'); return }
    setBusy(true); setErr('')
    try { const r = await productApi.create(v, stage === '' ? null : stage); onCreated(r.id, r.code) }
    catch (e) { const t = errMsg(e, 'Could not create the product'); setErr(t); error(t) } finally { setBusy(false) }
  }
  return <Modal title="New product" width={760} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Creating…' : 'Create product'}</button></>}>
    {meta.companies.length > 1 && <div className="mb"><label className="lb">Company</label><select className="in" value={meta.companies[0].id} disabled>{meta.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
    <div className="note inf mb">Fields and lists come from the <b>{m.name}</b> model for {meta.company}. The product starts as <b>{m.statuses[0]?.name}</b>; leave the code empty to generate it as <b>{m.code}</b>.</div>
    {err && <div className="note mb" role="alert"><Ic n="alert" /> {err}</div>}
    <div className="fg">
      {fs.map(f => <div key={f.key} className={f.type === 'ta' ? 'f1' : ''}>
        <label htmlFor={`pn-${f.key}`}>{f.key === 'code' ? 'Product code' : f.label}{f.key === 'code' ? null : req(f)}</label>
        <FieldInput id={`pn-${f.key}`} f={f} meta={meta} value={v[f.key]} disabled={false} onChange={x => setV(s => ({ ...s, [f.key]: x }))} />
        {f.key === 'code' ? <small>Optional – generated from {m.code} when empty</small> : f.help ? <small>{f.help}</small> : null}</div>)}
      <div><label htmlFor="pn-stage">{m.grouping} (primary mapping)</label>
        <select id="pn-stage" className="in" value={stage} onChange={e => setStage(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Map later</option>{m.stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
      <div><label>Margin</label><input className="in" disabled value={mg == null ? '—' : `${mg}%${mg < meta.model.rules.minMargin ? ' · below the minimum margin' : ''}`} /></div>
    </div>
  </Modal>
}

/** prototype A.pxEdit – every shown field; approved records need an open change window (reason + approval) */
export function EditProductModal({ meta, d, onClose, onSaved }: { meta: Meta; d: Detail; onClose: () => void; onSaved: (msg: string) => void }) {
  const { error, warning } = useToast()
  const fs = useMemo(() => meta.model.fields.filter(f => f.on && f.key !== 'status'), [meta.model.fields])
  const [v, setV] = useState<Vals>(() => ({ ...d.fields, oem: d.oem_id != null ? String(d.oem_id) : '' }))
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const needWindow = d.locked && meta.model.rules.lockEdits && d.window?.status !== 'open'
  const save = async () => {
    const miss = missing(fs, v)
    if (miss.length) { setErr(`Required: ${miss.join(', ')}`); return }
    if (needWindow && why.trim().length < 3) { setErr('Give a reason for the change'); return }
    setBusy(true); setErr('')
    try {
      if (needWindow) {
        if (d.window?.status === 'pending') { setErr('The change window is waiting for approval'); return }
        const w = await productApi.openWindow(d.id, why.trim())
        if (w.window.status !== 'open') { warning(w.message); onSaved(''); return }
      }
      const out: Vals = {}
      fs.forEach(f => { if (f.key !== 'code') out[f.key] = v[f.key] ?? '' })
      const r = await productApi.update(d.id, out)
      onSaved(r.changed ? `${r.changed} field${r.changed > 1 ? 's' : ''} updated${d.locked ? ' and logged' : ''}` : 'No changes')
    } catch (e) { const t = errMsg(e, 'Could not save the changes'); setErr(t); error(t) } finally { setBusy(false) }
  }
  return <Modal title={`Edit ${d.code}`} width={780} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy || d.window?.status === 'pending'} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button></>}>
    {d.locked && <div className="note mb"><Ic n="lock" /> {d.status} record – {d.window?.status === 'open' ? <>change window open (“{d.window.reason}” · approver {d.window.approver}). Each changed field is written to the change log.</>
      : d.window?.status === 'pending' ? 'the change window is waiting for approval in Approvals.' : 'give a reason; the change is routed through Approvals and each changed field is written to the change log.'}</div>}
    {needWindow && d.window?.status !== 'pending' && <div className="fg mb"><div className="f1"><label htmlFor="pe-why">Reason for change <b className="tbad">*</b></label>
      <input id="pe-why" className="in" value={why} onChange={e => setWhy(e.target.value)} maxLength={500} /></div></div>}
    {err && <div className="note mb" role="alert"><Ic n="alert" /> {err}</div>}
    <div className="fg">{fs.map(f => <div key={f.key} className={f.type === 'ta' ? 'f1' : ''}>
      <label htmlFor={`pe-${f.key}`}>{f.label}{req(f)}</label>
      <FieldInput id={`pe-${f.key}`} f={f} meta={meta} value={v[f.key]} disabled={f.key === 'code'} onChange={x => setV(s => ({ ...s, [f.key]: x }))} />
      {f.help && <small>{f.help}</small>}</div>)}</div>
  </Modal>
}

/** prototype A.pxStat – move the record status; the approved status is routed through Approvals */
export function StatusModal({ meta, d, to, kind, onClose, onDone }: { meta: Meta; d: Detail; to: string; kind: 'next' | 'final' | 'return'; onClose: () => void; onDone: (msg: string) => void }) {
  const { error } = useToast()
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = meta.model.lock
  const need = kind !== 'next'
  return <Modal title={`Move ${d.code} to ${to}`} width={480} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className={`btn ${kind === 'final' ? 'd' : 'p'}`} disabled={busy || (need && why.trim().length < 3)} onClick={async () => {
      setBusy(true)
      try { const r = await productApi.status(d.id, to, why.trim()); onDone(r.message) } catch (e) { error(errMsg(e, 'Could not change the status')) } finally { setBusy(false) }
    }}>{busy ? 'Saving…' : `Move to ${to}`}</button></>}>
    <div className="row" style={{ gap: 8, marginBottom: 12 }}><Pill s={d.status} t={stTone(meta.model, d.status)} /><span className="mu">→</span><Pill s={to} t={stTone(meta.model, to)} /></div>
    {to === lock && <div className="note inf mb">Approving makes the product available in quotes and brochures. The request goes through Approvals (Product · Approve product record); after approval, changes need a reason and an approver.</div>}
    {kind === 'return' && <div className="note mb">The record goes back to {to} for correction. Give the reason so the owner knows what to fix.</div>}
    {kind === 'final' && <div className="note mb">{to} is the final status – the product leaves price books, quotes and the category map.</div>}
    <label className="lb" htmlFor="ps-why">{need ? <>Reason <b className="tbad">*</b></> : 'Remarks'}</label>
    <input id="ps-why" className="in" value={why} maxLength={500} placeholder={to === lock ? 'Technical review completed' : need ? '' : 'Optional'} onChange={e => setWhy(e.target.value)} />
  </Modal>
}

/** prototype A.pxUnlock – open a change window on an approved record (reason; approval through Approvals) */
export function WindowModal({ d, onClose, onDone }: { d: Detail; onClose: () => void; onDone: (msg: string) => void }) {
  const { error } = useToast()
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)
  return <Modal title={<><Ic n="lock" /> Open a change window</>} width={480} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy || why.trim().length < 3} onClick={async () => {
      setBusy(true)
      try { const r = await productApi.openWindow(d.id, why.trim()); onDone(r.message) } catch (e) { error(errMsg(e, 'Could not open a change window')) } finally { setBusy(false) }
    }}>Open change window</button></>}>
    <p className="mu" style={{ marginBottom: 10 }}><b>{d.name}</b> is {d.status}. Edits you make in the window are logged with this reason and the approver who approves it in Approvals.</p>
    <div className="fg"><div className="f1"><label htmlFor="pw-why">Reason for change <b className="tbad">*</b></label>
      <input id="pw-why" className="in" value={why} maxLength={500} onChange={e => setWhy(e.target.value)} /></div></div>
  </Modal>
}

/** prototype A.pxImp – Product Master workbook: preview (row-level validation) before anything is saved */
export function ImportModal({ meta, onClose, onDone }: { meta: Meta; onClose: () => void; onDone: (msg: string) => void }) {
  const { error } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [im, setIm] = useState<ImportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const check = async (f: File) => {
    setFile(f); setIm(null); setBusy(true)
    try { setIm(await productApi.importXlsx(f, true)) } catch (e) { error(errMsg(e, 'Could not read the workbook')) } finally { setBusy(false) }
  }
  const run = async () => {
    if (!file || !im?.ok) return
    setBusy(true)
    try { const r = await productApi.importXlsx(file, false); onDone(`Imported into ${meta.company}: ${r.added ?? 0} added, ${r.updated ?? 0} updated`) }
    catch (e) { error(errMsg(e, 'Import failed')) } finally { setBusy(false) }
  }
  const issues = im ? [...im.products.flatMap(r => [...r.errors.map(e => ({ sheet: 'Product Master', row: r.row, code: r.code, t: e, bad: true })), ...r.warnings.map(e => ({ sheet: 'Product Master', row: r.row, code: r.code, t: e, bad: false }))]),
    ...im.mappings.flatMap(r => r.errors.map(e => ({ sheet: 'Category Mapping', row: r.row, code: r.code, t: e, bad: true }))),
    ...im.specs.flatMap(r => r.errors.map(e => ({ sheet: 'Specifications', row: r.row, code: r.code, t: e, bad: true })))] : []
  const report = () => {
    const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const csv = ['Sheet,Row,Product code,Type,Message', ...issues.map(x => [x.sheet, x.row, x.code, x.bad ? 'Error' : 'Warning', x.t].map(esc).join(','))].join('\n')
    download(new Blob([csv], { type: 'text/csv' }), 'product-import-errors.csv')
  }
  return <Modal title={<><Ic n="up" /> Import Product Master workbook</>} width={820} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={!im?.ok || busy} onClick={run}>{busy && im ? 'Importing…' : `Import${im?.ok ? ` ${im.add + im.update} product${im.add + im.update === 1 ? '' : 's'}` : ''}`}</button></>}>
    <div className="note inf mb">Reads the sheets <b>Product Master</b>, <b>Category Mapping</b> and <b>Specifications</b>. Rows are matched on Product Code – new codes are added, existing codes are updated and the change is logged. Values are checked against the {meta.model.name} lists for {meta.company}; nothing is saved while any row has an error.</div>
    <label className="px8-drop"><input type="file" accept=".xlsx,.xlsm" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void check(f); e.target.value = '' }} /><Ic n="up" />
      <b>{file ? file.name : 'Choose the workbook (.xlsx)'}</b><small>{file ? 'Choose another file' : 'Same layout as the downloaded template'}</small></label>
    {busy && !im && <div className="mu mt">Checking the workbook…</div>}
    {im && <>
      <div className="g g3 mt" style={{ gap: 8 }}>{([['Product Master', im.products.length], ['Category Mapping', im.mappings.length], ['Specifications', im.specs.length]] as [string, number][]).map(([n, c]) =>
        <div key={n} className="px8-ims"><small>{n}</small><b>{c}</b><span>rows</span></div>)}</div>
      <div className="row mt" style={{ gap: 12 }}><span className="tok">{im.add} new</span><span className="twarn">{im.update} to update</span><span className="mu">{im.unchanged} unchanged</span>
        {im.error_rows > 0 && <span className="tbad">{im.error_rows} row{im.error_rows > 1 ? 's' : ''} with errors</span>}<span className="fl" />
        {issues.length > 0 && <button type="button" className="btn s" onClick={report}><Ic n="dl" /> Error report</button>}</div>
      {issues.length > 0 && <div className="list mt" style={{ border: '1px solid var(--bw-ln)', borderRadius: 8, maxHeight: 170, overflow: 'auto' }}>
        {issues.map((x, i) => <div key={i} className={x.bad ? 'tbad' : 'twarn'}><Ic n={x.bad ? 'x' : 'alert'} /> <span className="fl">{x.sheet} · row {x.row}{x.code ? ` · ${x.code}` : ''}: {x.t}</span></div>)}</div>}
      <div className="tw fit mt" style={{ maxHeight: 220, overflow: 'auto' }}><table className="t"><thead><tr><th>Row</th><th>Product code</th><th>Description</th><th>Category</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{im.products.map(r => <tr key={r.row}><td>{r.row}</td><td><b>{r.code || <span className="mu">new code</span>}</b></td><td>{r.name}</td><td>{r.category}</td><td>{r.status}</td>
          <td>{r.errors.length ? <Pill s="Error" t="ba" /> : <Pill s={r.action === 'add' ? 'Add' : r.action === 'update' ? 'Update' : 'Unchanged'} t={r.action === 'add' ? 'ok' : r.action === 'update' ? 'wa' : 'mu'} />}</td></tr>)}</tbody></table></div>
    </>}
  </Modal>
}

export const marginText = (list: number | null, cost: number | null) => { const m = pct(list, cost); return m == null ? '—' : `${m}%` }
export const floorText = (cost: number | null, min: number) => cost == null ? '—' : inr(Math.round(cost * (1 + min / 100)))
