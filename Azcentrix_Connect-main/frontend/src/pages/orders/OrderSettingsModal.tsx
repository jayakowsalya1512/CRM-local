// Settings → Orders & projects (prototype v17 SETTINGS 'Orders & projects' › Fulfilment): Milestone tracking · Billing model ·
// Track retention money · Retention (%) · Auto-assign project manager · Alert when a milestone slips · Order number format.
// Below: the order lifecycles (Process Designer) with the prototype "New order lifecycle" dialog (Name · Start from · How is it
// created?) and delete (its contracts move to Project / Supply). Stored per tenant; settings.manage only.
import { useCallback, useEffect, useState } from 'react'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { errMsg, orderApi, type Lifecycle, type OrderConfig } from './orderApi'
import FieldError from '@/components/form/FieldError'
import { useModalValidation } from '@/components/form/useModalValidation'

const BILLING = ['Milestone', 'Time & material', 'Fixed monthly', 'On delivery']
const FORMATS = ['WO-YY-####', 'PO-based', 'Custom']
const TRIG: Record<string, string> = { manual: 'Manually', closure: 'When a project order closes', won: 'When a deal is won' }

export default function OrderSettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { success, error, warning } = useToast()
  const [f, setF] = useState<(OrderConfig & { next_number: string }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [lcs, setLcs] = useState<{ items: Lifecycle[]; templates: string[]; triggers: Record<string, string> } | null>(null)
  const [newLc, setNewLc] = useState(false)
  const [delLc, setDelLc] = useState<Lifecycle | null>(null)
  const loadLcs = useCallback(() => orderApi.lifecycles().then(setLcs).catch(e => error(errMsg(e, 'Could not load the order lifecycles'))), [error])
  useEffect(() => {
    orderApi.config().then(c => setF(c)).catch(e => { error(errMsg(e, 'Could not load Orders & projects settings')); onClose() })
    void loadLcs()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // retention 0–100 %, custom number pattern required (≤ 60) when the Custom format is chosen
  const vx = useModalValidation({ retention_pct: f?.retention_pct, number_custom: f?.number_custom, number_format: f?.number_format },
    x => ({ retention_pct: { label: 'Retention', rule: 'percent' }, number_custom: x.number_format === 'Custom' ? { label: 'Custom pattern', rule: 'text', required: true, max: 60 } : undefined }),
    undefined, { retention_pct: 'os-ret', number_custom: 'os-pat' })
  const set = <K extends keyof OrderConfig>(k: K, v: OrderConfig[K]) => {
    setF(x => x ? { ...x, [k]: v } : x)
    if (f) vx.change({ retention_pct: f.retention_pct, number_custom: f.number_custom, number_format: f.number_format, [k]: v }, k as string)
  }
  const sw = (k: 'milestones' | 'retention' | 'auto_pm' | 'slip_alert', label: string) =>
    <div className="f1"><label className="row" style={{ gap: 8, cursor: 'pointer' }}><input type="checkbox" checked={!!f?.[k]} onChange={e => set(k, e.target.checked)} /> {label}</label></div>

  return <Modal title={<><Ic n="brief" /> Orders &amp; projects</>} width={640} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Close</button>
    <button type="button" className="btn p" disabled={!f || busy} onClick={async () => {
      if (!f || !vx.submit()) return
      setBusy(true)
      try {
        await orderApi.saveConfig({ milestones: f.milestones, billing_model: f.billing_model, retention: f.retention, retention_pct: Number(f.retention_pct), auto_pm: f.auto_pm,
          slip_alert: f.slip_alert, number_format: f.number_format, number_custom: f.number_custom })
        success('Orders & projects settings saved'); onSaved(); onClose()
      } catch (e) { if (!vx.server(e)) error(errMsg(e, 'Could not save')) } finally { setBusy(false) }
    }}>{busy ? 'Saving…' : 'Save'}</button></>}>
    {!f ? <div className="empty">Loading…</div> : <>
      <h4 className="mb" style={{ margin: '0 0 8px' }}>Fulfilment</h4>
      <div className="fg">
        {sw('milestones', 'Milestone tracking')}
        <div><label htmlFor="os-bill">Billing model</label><select id="os-bill" className="in" value={f.billing_model} onChange={e => set('billing_model', e.target.value)}>{BILLING.map(x => <option key={x}>{x}</option>)}</select></div>
        <div />
        {sw('retention', 'Track retention money')}
        <div><label htmlFor="os-ret">Retention (%)</label><input id="os-ret" className={`in ${vx.bad('retention_pct') ? 'err' : ''}`} {...vx.aria('retention_pct')} type="number" min={0} max={100} step="0.5" value={f.retention_pct} onChange={e => set('retention_pct', e.target.value === '' ? 0 : Number(e.target.value))} />
          <FieldError id="os-ret" msg={vx.errors.retention_pct} /></div>
        <div />
        {sw('auto_pm', 'Auto-assign project manager')}
        {sw('slip_alert', 'Alert when a milestone slips')}
        <div><label htmlFor="os-no">Order number format</label><select id="os-no" className="in" value={f.number_format} onChange={e => set('number_format', e.target.value)}>{FORMATS.map(x => <option key={x}>{x}</option>)}</select>
          <small>Next: {f.number_format === 'PO-based' ? 'the order\'s PO number' : f.next_number}</small></div>
        {f.number_format === 'Custom' && <div><label htmlFor="os-pat">Custom pattern</label><input id="os-pat" className={`in ${vx.bad('number_custom') ? 'err' : ''}`} {...vx.aria('number_custom')} maxLength={60} value={f.number_custom} onChange={e => set('number_custom', e.target.value)} />
          <FieldError id="os-pat" msg={vx.errors.number_custom} />{!vx.errors.number_custom && <small>Tokens {'{YYYY} {YY} {MM} {####}'}</small>}</div>}
      </div>
      <h4 className="mt mb" style={{ margin: '16px 0 8px' }}>Order lifecycles <small className="mu">Process Designer</small></h4>
      {!lcs ? <div className="empty">Loading…</div> : <table className="t"><thead><tr><th>Lifecycle</th><th>Stages</th><th>Created</th><th className="r">Orders</th><th /></tr></thead><tbody>
        {lcs.items.map(l => <tr key={l.key}><td><b>{l.type}</b></td><td className="wr"><small>{l.stages.map(s => s.name).join(' › ')}</small></td><td>{TRIG[l.trigger] || l.trigger}</td>
          <td className="r">{l.orders ?? 0}</td><td>{l.key !== 'wo' && <button type="button" className="btn g s" title="Delete lifecycle" onClick={() => setDelLc(l)}><Ic n="trash" /></button>}</td></tr>)}
      </tbody></table>}
      <button type="button" className="btn mt" onClick={() => setNewLc(true)}><Ic n="plus" /> New order lifecycle</button>
    </>}
    {newLc && lcs && <NewLifecycle templates={lcs.templates} triggers={lcs.triggers} onClose={() => setNewLc(false)} onDone={l => {
      setNewLc(false); success(`“${l.type}” added – it now appears under Orders & Projects`); void loadLcs(); onSaved()
    }} />}
    {delLc && <Modal title="Delete lifecycle?" width={420} onClose={() => setDelLc(null)} foot={<><span className="fl" />
      <button type="button" className="btn" onClick={() => setDelLc(null)}>Cancel</button>
      <button type="button" className="btn d" onClick={async () => {
        try { const r = await orderApi.deleteLifecycle(delLc.key); setDelLc(null); r.moved ? warning(`Lifecycle deleted – ${r.moved} contracts moved to Project / Supply`) : success('Lifecycle deleted'); void loadLcs(); onSaved() }
        catch (e) { error(errMsg(e, 'Could not delete the lifecycle')) }
      }}>Delete</button></>}>
      <p style={{ margin: 0 }}>Delete lifecycle “{delLc.type}”? Its contracts move to Project / Supply.</p>
    </Modal>}
  </Modal>
}

// prototype A.olNew: note · Name · Start from (AMC / service contract, Warranty & support, Rental / lease, Copy of project lifecycle) · How is it created?
function NewLifecycle({ templates, triggers, onClose, onDone }: { templates: string[]; triggers: Record<string, string>; onClose: () => void; onDone: (l: Lifecycle) => void }) {
  const { error } = useToast()
  const [f, setF] = useState({ name: '', template: templates[0] || '', trigger: 'manual' })
  const [busy, setBusy] = useState(false)
  const vx = useModalValidation(f, () => ({ name: { label: 'Name', rule: 'name', required: true, min: 2, max: 80 } }), undefined, { name: 'oln' })
  return <Modal title="New order lifecycle" width={520} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={async () => {
      if (!vx.submit()) return
      setBusy(true)
      try { onDone(await orderApi.newLifecycle({ name: f.name.trim(), template: f.template, trigger: f.trigger })) } catch (e) { if (!vx.server(e)) error(errMsg(e, 'Could not create the lifecycle')) } finally { setBusy(false) }
    }}>Create lifecycle</button></>}>
    <div className="note inf mb">Use this for steps that follow an order – for example <b>AMC</b>, service contracts or rentals. They are listed under <b>Orders &amp; Projects</b> and linked to the same customer journey.</div>
    <div className="fg">
      <div className="f1"><label htmlFor="oln">Name</label><input id="oln" className={`in ${vx.bad('name') ? 'err' : ''}`} {...vx.aria('name')} maxLength={80} placeholder="e.g. AMC / Service" value={f.name} onChange={e => { const n = { ...f, name: e.target.value }; setF(n); vx.change(n, 'name') }} />
        <FieldError id="oln" msg={vx.errors.name} /></div>
      <div><label htmlFor="olt">Start from</label><select id="olt" className="in" value={f.template} onChange={e => setF({ ...f, template: e.target.value })}>{templates.map(t => <option key={t}>{t}</option>)}</select></div>
      <div><label htmlFor="olw">How is it created?</label><select id="olw" className="in" value={f.trigger} onChange={e => setF({ ...f, trigger: e.target.value })}>
        {Object.entries(triggers).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
    </div>
  </Modal>
}
