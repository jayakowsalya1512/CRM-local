// Setup → Sales modules → Guarantees & deposits (prototype v18): Expiry reminder (days before) · Track bank margin / lien ·
// Approval to request release · Auto-create instrument when a bid needs EMD · Preferred bank (SBI, HDFC Bank, ICICI Bank,
// Axis Bank) · Escalate unreleased after (days) · Track FDR deposits. Tenant settings; settings.manage only.
import { useEffect, useState } from 'react'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { errMsg, insApi, type InsConfig } from './instrumentApi'
import FieldError from '@/components/form/FieldError'
import { useModalValidation } from '@/components/form/useModalValidation'

export default function InstrumentSettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { success, error } = useToast()
  const [f, setF] = useState<(InsConfig & { preferred_banks: string[] }) | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { insApi.config().then(c => setF(c)).catch(e => { error(errMsg(e, 'Could not load the settings')); onClose() }) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // reminder / escalation: whole number of days 1–3650
  const vx = useModalValidation({ remind_days: f?.remind_days, escalate_days: f?.escalate_days }, () => ({
    remind_days: { label: 'Expiry reminder', rule: 'integer', required: true, min: 1, max: 3650 }, escalate_days: { label: 'Escalation', rule: 'integer', required: true, min: 1, max: 3650 } }),
  undefined, { remind_days: 'gs-rem', escalate_days: 'gs-esc' })
  const set = <K extends keyof InsConfig>(k: K, v: InsConfig[K]) => {
    setF(x => x ? { ...x, [k]: v } : x)
    if (f && (k === 'remind_days' || k === 'escalate_days')) vx.change({ remind_days: f.remind_days, escalate_days: f.escalate_days, [k]: v }, k)
  }
  const sw = (k: 'track_margin' | 'release_approval' | 'auto_create' | 'track_fdr' | 'alert_email', label: string) =>
    <div className="f1"><label className="row" style={{ gap: 8, cursor: 'pointer' }}><input type="checkbox" checked={!!f?.[k]} onChange={e => set(k, e.target.checked)} /> {label}</label></div>
  return <Modal title={<><Ic n="shield" /> Guarantees &amp; deposits</>} width={560} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={!f || busy} onClick={async () => {
      if (!f || !vx.submit()) return
      setBusy(true)
      try {
        await insApi.saveConfig({ remind_days: Number(f.remind_days), track_margin: f.track_margin, release_approval: f.release_approval, auto_create: f.auto_create,
          preferred_bank: f.preferred_bank, escalate_days: Number(f.escalate_days), track_fdr: f.track_fdr, alert_email: f.alert_email,
          accounts: f.accounts.map(x => x.trim()).filter(Boolean) })
        success('Guarantees & deposits settings saved'); onSaved(); onClose()
      } catch (e) { if (!vx.server(e)) error(errMsg(e, 'Could not save')) } finally { setBusy(false) }
    }}>{busy ? 'Saving…' : 'Save'}</button></>}>
    {!f ? <div className="empty">Loading…</div> : <>
      <h4 style={{ margin: '0 0 8px' }}>Bid security</h4>
      <div className="fg">
        <div><label htmlFor="gs-rem">Expiry reminder (days before)</label><input id="gs-rem" className={`in ${vx.bad('remind_days') ? 'err' : ''}`} {...vx.aria('remind_days')} type="number" min={1} max={3650} value={f.remind_days} onChange={e => set('remind_days', Number(e.target.value))} />
          <FieldError id="gs-rem" msg={vx.errors.remind_days} /></div>
        <div />
        {sw('track_margin', 'Track bank margin / lien')}
        {sw('release_approval', 'Approval to request release')}
        {sw('auto_create', 'Auto-create instrument when a bid needs EMD')}
        <div><label htmlFor="gs-bank">Preferred bank</label><select id="gs-bank" className="in" value={f.preferred_bank} onChange={e => set('preferred_bank', e.target.value)}>
          {[...new Set([...f.preferred_banks, f.preferred_bank])].map(b => <option key={b}>{b}</option>)}</select></div>
        <div><label htmlFor="gs-esc">Escalate unreleased after (days)</label><input id="gs-esc" className={`in ${vx.bad('escalate_days') ? 'err' : ''}`} {...vx.aria('escalate_days')} type="number" min={1} max={3650} value={f.escalate_days} onChange={e => set('escalate_days', Number(e.target.value))} />
          <FieldError id="gs-esc" msg={vx.errors.escalate_days} /></div>
        {sw('track_fdr', 'Track FDR deposits')}
      </div>
      <h4 style={{ margin: '14px 0 8px' }}>Finance &amp; alerts</h4>
      <div className="fg">
        <div className="f1"><label htmlFor="gs-acc">Company bank accounts (debit / credit) – one per line</label>
          <textarea id="gs-acc" className="in" rows={3} value={f.accounts.join('\n')} placeholder="e.g. SBI current a/c ••3021" onChange={e => set('accounts', e.target.value.split('\n'))} /></div>
        {sw('alert_email', 'Also send guarantee & deposit alerts by email')}
      </div>
    </>}
  </Modal>
}
