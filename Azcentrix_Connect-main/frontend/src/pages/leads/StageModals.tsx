// Prototype lostPrompt() ("Why was this lost?") and convertHint() ("Next step") dialogs for lead stage moves.
// Reasons come from the tenant's lead_lost_reasons setting (meta.lost) – never hard-coded here.
import { useState } from 'react'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { mapApiErrors, type FieldSpec } from '@/utils/validation'
import { errMsg } from './leadApi'

export type LostCfg = { required: boolean; reasons: string[] }

export function LostModal({ lost, label = 'Lost', count, onClose, onConfirm }: {
  lost: LostCfg; label?: string; count?: number; onClose: () => void; onConfirm: (reason: string, comment: string) => Promise<unknown>
}) {
  const { error } = useToast()
  const [reason, setReason] = useState(lost.reasons[0] || '')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const fe = useFieldErrors()
  const need = lost.required && !reason
  // backend StageIn: reason ≤ 120, comment ≤ 1000 characters
  const specs: Record<'lr' | 'lc', FieldSpec> = { lr: { label: 'Reason', rule: 'select', required: lost.required && lost.reasons.length > 0 }, lc: { label: 'Comment', rule: 'textarea', max: 1000 } }
  return <Modal title="Why was this lost?" width={420} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy || need} onClick={async () => {
      if (Object.keys(fe.validateAll({ lr: reason, lc: comment }, specs)).length) return
      setBusy(true)
      try { await onConfirm(reason, comment.trim()) } catch (e) {
        const fx = mapApiErrors(e, { reason: 'lr', comment: 'lc' }), known = Object.fromEntries(Object.entries(fx).filter(([k]) => k === 'lr' || k === 'lc'))
        if (Object.keys(known).length) fe.setErrors(x => ({ ...x, ...known })); else error(errMsg(e, 'Could not change the stage'))
      } finally { setBusy(false) }
    }}>{busy ? 'Saving…' : `Mark as ${label.toLowerCase()}`}{count && count > 1 ? ` (${count})` : ''}</button></>}>
    <label className="lb" htmlFor="lr">Reason{lost.required && <b className="tbad"> *</b>}</label>
    {lost.reasons.length
      ? <select id="lr" className={`in ${fe.errors.lr ? 'err' : ''}`} value={reason} aria-invalid={!!fe.errors.lr || undefined}
        onChange={e => { setReason(e.target.value); fe.change('lr', e.target.value, specs.lr) }} onBlur={() => fe.blur('lr', reason, specs.lr)}>
        {!lost.required && <option value="">—</option>}{lost.reasons.map(x => <option key={x}>{x}</option>)}</select>
      : <div className="note">No lost reasons are configured for this workspace.</div>}
    <FieldError id="lr" msg={fe.errors.lr} />
    <label className="lb mt" htmlFor="lc" style={{ marginTop: 10 }}>Comment (optional)</label>
    <textarea id="lc" className={`in ${fe.errors.lc ? 'err' : ''}`} rows={2} value={comment} aria-invalid={!!fe.errors.lc || undefined}
      onChange={e => { setComment(e.target.value); fe.change('lc', e.target.value, specs.lc) }} onBlur={() => fe.blur('lc', comment, specs.lc)} />
    <FieldError id="lc" msg={fe.errors.lc} />
  </Modal>
}

export function NextStepModal({ name, action = 'Convert lead to deal', onClose, onConvert }: { name: string; action?: string; onClose: () => void; onConvert: () => Promise<unknown> }) {
  const { error } = useToast()
  const [busy, setBusy] = useState(false)
  return <Modal title="Next step" width={400} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Not now</button>
    <button type="button" className="btn p" disabled={busy} onClick={async () => {
      setBusy(true)
      try { await onConvert() } catch (e) { error(errMsg(e, 'Could not convert the lead')) } finally { setBusy(false) }
    }}>{busy ? 'Converting…' : action}</button></>}>
    <p style={{ margin: 0 }}><b>{name}</b> reached its winning stage. Continue the flow?</p>
  </Modal>
}
