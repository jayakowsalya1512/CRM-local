// Product & Price Books – prototype v18 pxConfig(): everything set per company.
// Product model (templates · Apply) · Lists (categories + internal groupings, grouping label and values, mapping
// roles, units, price-book currencies) · Record lifecycle (ordered statuses with colour and the approved status,
// delivery lifecycle, rules: logging, quotes, brochures, locking, minimum margin, discount limit, below-floor policy,
// code format) · Fields (label, show, required, guidance) · Default specification parameters.
import { useEffect, useState } from 'react'
import { Ic } from '@/components/crm/kit'
import { Switch } from '@/components/platform/bw'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { errMsg, productApi, STATUS_TONES, type MField, type Meta, type Model } from './productApi'

const Pill = ({ s, t }: { s: string; t: string }) => <span className={`pill ${t}`}>{s}</span>
type Save = Parameters<typeof productApi.saveModel>[0]

export default function ConfigurationTab({ meta, onSaved }: { meta: Meta; onSaved: () => void }) {
  const { success, error } = useToast()
  const [m, setM] = useState<Model>(meta.model)
  const [cur, setCur] = useState<string[]>(meta.config.currencies)
  const [apply, setApply] = useState<Model['templates'][number] | null>(null)
  const [addField, setAddField] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setM(meta.model); setCur(meta.config.currencies) }, [meta.model, meta.config.currencies])
  const ro = !meta.can.configure
  const save = async (b: Save, msg = 'Configuration saved') => {
    if (ro) return
    setBusy(true)
    try { const r = await productApi.saveModel(b); setM(r); setCur(r.config.currencies); success(msg); onSaved() }
    catch (e) { error(errMsg(e, 'Could not save the configuration')); setM(meta.model) } finally { setBusy(false) }
  }
  const usedHint = <small className="mu">Values still used by products can’t be removed – re-map them first.</small>

  return <>
    {meta.companies.length > 1 && <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}><small className="mu">Company</small>{meta.companies.map(c => <span key={c.id} className="chip on">{c.name}</span>)}</div>}
    <div className="note inf mb">Everything below is set per company – <b>{meta.company}</b> sells {m.name.toLowerCase()}. Lists, fields, statuses and lifecycle follow this configuration in the catalogue, product records, imports and the downloadable template.
      {ro && <> You can view the configuration; changing it needs the Settings permission.</>}</div>

    <div className="panel mb"><div className="ph"><Ic n="layout" /> Product model<span className="fl" /><small className="mu">Applying a model replaces the lists below – existing products are kept</small></div>
      <div className="pb">
        <div className="row mb" style={{ gap: 8 }}><label htmlFor="pc-name" className="mu">Model name</label>
          <TextSave id="pc-name" value={m.name} disabled={ro} width={320} onSave={v => save({ name: v })} /></div>
        <div className="px8-tpls">{m.templates.map(t => <div key={t.key} className={`px8-tpl ${m.template === t.key ? 'on' : ''}`}>
          <div className="row"><b className="fl">{t.name}</b>{m.template === t.key ? <Pill s="In use" t="ok" /> : !ro && <button type="button" className="btn s" onClick={() => setApply(t)}>Apply</button>}</div>
          <p>{t.description}</p>
          <small className="mu">{t.categories} categories · {t.grouping.toLowerCase()}: {t.stages.join(', ')}… · statuses: {t.statuses.join(' → ')}</small></div>)}</div>
      </div></div>

    <div className="g g2 mb" style={{ alignItems: 'start' }}>
      <div className="panel"><div className="ph">Lists</div><div className="pb">
        <ListEd label="Product categories" items={m.categories.map(c => c.name)} ph="New category" disabled={ro || busy}
          onChange={names => save({ categories: names.map(n => m.categories.find(c => c.name === n) || { name: n, internal: false }) })} />
        <div className="row wrap" style={{ gap: 6, margin: '-4px 0 14px' }}><small className="mu">Hidden from customers:</small>
          {m.categories.filter(c => c.internal).map(c => <span key={c.name} className="px8-tag" style={{ borderStyle: 'dashed' }}>{c.name}
            {!ro && <a role="button" title="Show to customers" onClick={() => save({ categories: m.categories.map(x => x.name === c.name ? { ...x, internal: false } : x) })}>×</a>}</span>)}
          {!m.categories.some(c => c.internal) && <small className="mu">none</small>}
          {!ro && m.categories.some(c => !c.internal) && <select className="in sm" style={{ width: 'auto', maxWidth: 220 }} value="" aria-label="Hide another category"
            onChange={e => { if (e.target.value) save({ categories: m.categories.map(x => x.name === e.target.value ? { ...x, internal: true } : x) }, 'Hidden from brochures and customer documents') }}>
            <option value="">Hide another category…</option>{m.categories.filter(c => !c.internal).map(c => <option key={c.name}>{c.name}</option>)}</select>}
        </div>
        <div className="row" style={{ marginBottom: 6 }}><b>Grouping used in category mapping</b><span className="fl" />
          <TextSave id="pc-grp" value={m.grouping} disabled={ro} width={200} onSave={v => save({ grouping: v })} /></div>
        <ListEd label={`${m.grouping}s`} items={m.stages.map(s => s.name)} ph={`New ${m.grouping.toLowerCase()}`} disabled={ro || busy}
          onChange={names => save({ stages: names.map(n => m.stages.find(s => s.name === n) || { name: n }) })} />
        <ListEd label="Mapping roles" items={m.roles} ph="New role" disabled={ro || busy} onChange={roles => save({ roles })} />
        <ListEd label="Units" items={m.units} ph="New unit" disabled={ro || busy} onChange={units => save({ units })} />
        <ListEd label="Price book currencies" items={cur} ph="e.g. USD" disabled={ro || busy} fixed={[meta.config.base_currency]} onChange={currencies => save({ currencies })} upper />
        {usedHint}
      </div></div>

      <div className="panel"><div className="ph">Record lifecycle</div><div className="pb">
        <b>Record statuses</b><small className="mu"> · in order – first is the draft status, last the final status</small>
        <Statuses m={m} disabled={ro || busy} onSave={st => save({ statuses: st })} />
        <ListEd label="Product delivery lifecycle" items={m.life} ph="New lifecycle step" disabled={ro || busy} onChange={life => save({ life })} />
        <b>Rules</b>
        <div className="list" style={{ border: '1px solid var(--bw-ln)', borderRadius: 8, marginTop: 6 }}>
          {([['log', 'Log every change to records that are not yet approved'], ['lockEdits', `Approved records need a change window (reason + approval) before editing`],
            ['quoteApproved', 'Only approved products can be added to quotes'], ['quoteDiscApproval', 'Quote discounts beyond the limit need Sales Head approval'],
            ['hideInternal', 'Hide internal groupings in brochures and customer documents']] as [keyof Model['rules'], string][]).map(([k, l]) =>
            <div key={k}><span className="fl">{l}</span><Switch on={!!m.rules[k]} disabled={ro || busy} label={l} onChange={v => save({ rules: { ...m.rules, [k]: v } }, 'Rule updated')} /></div>)}
          <div><span className="fl">Minimum margin %</span><NumSave value={m.rules.minMargin} disabled={ro} onSave={v => save({ rules: { ...m.rules, minMargin: v } }, 'Rule updated')} /></div>
          <div><span className="fl">Discount needing approval beyond %</span><NumSave value={m.rules.discLimit} disabled={ro} onSave={v => save({ rules: { ...m.rules, discLimit: v } }, 'Rule updated')} /></div>
          <div><span className="fl">Book price below the floor</span><select className="in sm" style={{ width: 170 }} disabled={ro || busy} value={m.rules.floorPolicy} aria-label="Below-floor policy"
            onChange={e => save({ rules: { ...m.rules, floorPolicy: e.target.value as Model['rules']['floorPolicy'] } }, 'Rule updated')}>
            <option value="Warn">Warn – save and flag</option><option value="Approval">Send for approval</option><option value="Block">Block</option></select></div>
          <div><span className="fl">Product code format</span><TextSave id="pc-code" value={m.code} disabled={ro} width={160} onSave={v => save({ code: v }, 'Code format updated')} /></div>
        </div>
        <small className="mu">Approvals for the approved status and change windows follow Approvals → rules for “Product”.</small>
      </div></div>
    </div>

    <div className="panel mb"><div className="ph">Fields<span className="fl" /><small className="mu">Core fields come from the Product Master sheet · {m.name} adds its own · labels, visibility and required flags are per company</small>
      {!ro && <button type="button" className="btn s p" onClick={() => setAddField(true)}><Ic n="plus" /> Custom field</button>}</div>
      <div className="pb z"><div className="tw fit"><Fields m={m} disabled={ro || busy} onSave={fields => save({ fields })} /></div></div></div>

    <div className="panel"><div className="ph">Default specification parameters<span className="fl" /><small className="mu">Added to new products and with “Add template parameters”</small>
      {!ro && <button type="button" className="btn s" onClick={() => setM(x => ({ ...x, specs: [...x.specs, ['New parameter', '', '', '', '']] }))}><Ic n="plus" /> Parameter</button>}</div>
      <div className="pb z"><div className="tw fit"><table className="t"><thead><tr><th>Parameter</th><th>Default value</th><th>Unit</th><th>Standard / material</th><th>Remarks</th><th /></tr></thead>
        <tbody>{m.specs.map((s, i) => <tr key={i}>{[0, 1, 2, 3, 4].map(j => <td key={j}><input className="in sm" disabled={ro} value={s[j] || ''} aria-label={`Parameter ${i + 1} column ${j + 1}`}
          onChange={e => setM(x => ({ ...x, specs: x.specs.map((r, ri) => ri === i ? r.map((c, ci) => ci === j ? e.target.value : c) : r) }))}
          onBlur={() => { if (JSON.stringify(m.specs) !== JSON.stringify(meta.model.specs)) void save({ specs: m.specs }) }} /></td>)}
          <td>{!ro && <button type="button" className="btn g s" aria-label="Remove parameter" onClick={() => save({ specs: m.specs.filter((_, ri) => ri !== i) })}><Ic n="x" /></button>}</td></tr>)}
          {!m.specs.length && <tr><td colSpan={6}><div className="empty">No default parameters</div></td></tr>}</tbody></table></div></div></div>

    {apply && <Modal title="Apply product model" width={480} onClose={() => setApply(null)} foot={<><span className="fl" />
      <button type="button" className="btn" onClick={() => setApply(null)}>Cancel</button>
      <button type="button" className="btn p" disabled={busy} onClick={async () => {
        setBusy(true)
        try { const r = await productApi.applyTemplate(apply.key); setM(r); success(`Product model set to ${apply.name}`); setApply(null); onSaved() }
        catch (e) { error(errMsg(e, 'Could not apply the model')) } finally { setBusy(false) }
      }}>Apply model</button></>}>
      <p style={{ margin: 0 }}>Apply <b>{apply.name}</b> to {meta.company}? Categories, {apply.grouping.toLowerCase()}s, statuses, fields and lifecycle are replaced. Values still used by products are kept;
        products in a status the model does not have move to its first status (logged).</p>
    </Modal>}
    {addField && <CustomFieldModal onClose={() => setAddField(false)} onAdded={r => { setM(r); setAddField(false); success('Field added to every product form'); onSaved() }} />}
  </>
}

function TextSave({ id, value, onSave, disabled, width }: { id: string; value: string; onSave: (v: string) => void; disabled?: boolean; width: number }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return <input id={id} className="in sm" style={{ width }} disabled={disabled} value={v} onChange={e => setV(e.target.value)}
    onBlur={() => { const t = v.trim(); if (t && t !== value) onSave(t); else setV(value) }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
}

function NumSave({ value, onSave, disabled }: { value: number; onSave: (v: number) => void; disabled?: boolean }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  return <input className="in sm" type="number" min={0} max={100} step="any" style={{ width: 80 }} disabled={disabled} value={v} onChange={e => setV(e.target.value)}
    onBlur={() => { const n = Number(v); if (v.trim() === '' || Number.isNaN(n) || n < 0 || n > 100) { setV(String(value)); return } if (n !== value) onSave(n) }} />
}

/** prototype lsEd(): chips with × and an add box */
function ListEd({ label, items, ph, onChange, disabled, fixed = [], upper }: { label: string; items: string[]; ph: string; onChange: (v: string[]) => void; disabled?: boolean; fixed?: string[]; upper?: boolean }) {
  const [v, setV] = useState('')
  const { error } = useToast()
  const add = () => {
    const t = (upper ? v.trim().toUpperCase() : v.trim())
    if (!t) { error('Type a value first'); return }
    if (items.some(x => x.toLowerCase() === t.toLowerCase())) { error(`“${t}” is already in the list`); return }
    onChange([...items, t]); setV('')
  }
  return <div className="px8-ls"><div className="row"><b>{label}</b><span className="fl" /><small className="mu">{items.length}</small></div>
    <div className="row wrap" style={{ gap: 5, margin: '8px 0' }}>{items.map((x, i) => <span key={x} className="px8-tag">{x}
      {!disabled && !fixed.includes(x) && <a role="button" title="Remove" onClick={() => { if (items.length < 2) { error('Keep at least one value'); return } onChange(items.filter((_, j) => j !== i)) }}>×</a>}</span>)}</div>
    {!disabled && <div className="row" style={{ gap: 6 }}><input className="in sm" placeholder={ph} value={v} aria-label={ph} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }} />
      <button type="button" className="btn s" onClick={add}><Ic n="plus" /> Add</button></div>}
  </div>
}

function Statuses({ m, onSave, disabled }: { m: Model; onSave: (s: Model['statuses']) => void; disabled?: boolean }) {
  const [st, setSt] = useState(m.statuses)
  useEffect(() => setSt(m.statuses), [m.statuses])
  const commit = (next: Model['statuses']) => { setSt(next); onSave(next) }
  return <>
    <div className="px8-sts">{st.map((s, i) => <div key={s.id ?? `n${i}`}>
      <span className="px8-n">{i + 1}</span>
      <input className="in sm" value={s.name} disabled={disabled} aria-label={`Status ${i + 1} name`} onChange={e => setSt(x => x.map((y, j) => j === i ? { ...y, name: e.target.value } : y))}
        onBlur={() => { if (st[i].name.trim() && st[i].name !== m.statuses[i]?.name) commit(st); else setSt(m.statuses) }} />
      <select className="in sm" style={{ width: 110 }} value={s.color} disabled={disabled} aria-label={`Status ${i + 1} colour`} onChange={e => commit(st.map((y, j) => j === i ? { ...y, color: e.target.value } : y))}>
        {STATUS_TONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <label className="row" style={{ gap: 4 }} title="Records in this status are locked – changes need a reason and approver">
        <input type="radio" name="pxlk" checked={s.lock} disabled={disabled || i === 0 || i === st.length - 1} onChange={() => commit(st.map((y, j) => ({ ...y, lock: j === i })))} /> approved</label>
      <button type="button" className="btn g s" aria-label={`Remove ${s.name}`} disabled={disabled || st.length < 4 || s.lock} onClick={() => commit(st.filter((_, j) => j !== i))}><Ic n="x" /></button>
    </div>)}</div>
    {!disabled && <button type="button" className="btn s mt mb" onClick={() => { const n = [...st]; n.splice(n.length - 1, 0, { name: `New status ${st.length}`, color: 'inf', lock: false }); commit(n) }}><Ic n="plus" /> Add status</button>}
  </>
}

function Fields({ m, onSave, disabled }: { m: Model; onSave: (f: MField[]) => void; disabled?: boolean }) {
  const [fs, setFs] = useState(m.fields)
  useEffect(() => setFs(m.fields), [m.fields])
  const always = (k: string) => ['code', 'name', 'status'].includes(k)
  const commit = (next: MField[]) => { setFs(next); onSave(next) }
  const src = (f: MField) => f.source === 'core' ? <Pill s="Template" t="ac" /> : f.source === 'x' ? <Pill s={m.name.split(' ')[0]} t="inf" /> : f.source === 'com' ? <Pill s="Commercial" t="mu" /> : <Pill s="Custom" t="wa" />
  return <table className="t"><thead><tr><th>Field</th><th>Label shown</th><th>Source</th><th className="c">Show</th><th className="c">Required</th><th>Guidance</th>{!disabled && <th />}</tr></thead>
    <tbody>{fs.map((f, i) => <tr key={f.key}>
      <td><code>{f.key}</code></td>
      <td><input className="in sm" value={f.label} disabled={disabled} aria-label={`Label for ${f.key}`} onChange={e => setFs(x => x.map((y, j) => j === i ? { ...y, label: e.target.value } : y))}
        onBlur={() => { if (fs[i].label.trim() && fs[i].label !== m.fields[i]?.label) commit(fs); else setFs(m.fields) }} /></td>
      <td>{src(f)}</td>
      <td className="c">{always(f.key) ? '—' : <Switch on={f.on} disabled={disabled} label={`Show ${f.label}`} onChange={v => commit(fs.map((y, j) => j === i ? { ...y, on: v, req: v ? y.req : false } : y))} />}</td>
      <td className="c">{always(f.key) ? 'Always' : <Switch on={f.req} disabled={disabled} label={`${f.label} required`} onChange={v => commit(fs.map((y, j) => j === i ? { ...y, req: v, on: v ? true : y.on } : y))} />}</td>
      <td><input className="in sm" value={f.help} disabled={disabled} placeholder="Help text shown under the field" aria-label={`Guidance for ${f.key}`}
        onChange={e => setFs(x => x.map((y, j) => j === i ? { ...y, help: e.target.value } : y))} onBlur={() => { if (fs[i].help !== (m.fields[i]?.help || '')) commit(fs) }} /></td>
      {!disabled && <td>{f.source === 'custom' && <button type="button" className="btn g s" aria-label={`Remove ${f.label}`} onClick={() => commit(fs.filter((_, j) => j !== i))}><Ic n="x" /></button>}</td>}
    </tr>)}</tbody></table>
}

function CustomFieldModal({ onClose, onAdded }: { onClose: () => void; onAdded: (m: Model) => void }) {
  const { error } = useToast()
  const [v, setV] = useState({ l: '', type: 'text', req: false })
  const [busy, setBusy] = useState(false)
  return <Modal title="Add custom field" width={440} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy || v.l.trim().length < 2} onClick={async () => {
      setBusy(true)
      try { onAdded(await productApi.addField(v.l.trim(), v.type, v.req)) } catch (e) { error(errMsg(e, 'Could not add the field')) } finally { setBusy(false) }
    }}>Add field</button></>}>
    <div className="fg">
      <div className="f1"><label htmlFor="cf-l">Label</label><input id="cf-l" className="in" placeholder="e.g. Noise level" maxLength={150} value={v.l} onChange={e => setV(s => ({ ...s, l: e.target.value }))} /></div>
      <div><label htmlFor="cf-t">Type</label><select id="cf-t" className="in" value={v.type} onChange={e => setV(s => ({ ...s, type: e.target.value }))}>
        <option value="text">Text</option><option value="num">Number</option><option value="date">Date</option><option value="ta">Long text</option></select></div>
      <div><label className="row" style={{ marginTop: 20, gap: 6 }}><input type="checkbox" checked={v.req} onChange={e => setV(s => ({ ...s, req: e.target.checked }))} /> Required</label></div>
    </div>
  </Modal>
}
