// Quote stage moves (board drag-and-drop, stepper, Send for approval) – prototype moveStage():
// checklist gate → "Stage checklist – <stage>"; lost stage → reason dialog; approval gate → held and sent to the
// approver; winning stage → "Next step · Create work order". The server applies every rule again.
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { LostModal, NextStepModal } from '@/pages/leads/StageModals'
import { openWorkOrder } from './workOrder'
import { errDetail, errMsg, quoteApi, type Stage } from './quoteApi'

export interface MoveTarget { id: number; name: string; stages: Stage[]; currentId: number }

export function useQuoteStage(lost: { required: boolean; reasons: string[] } | null, canUpdate: boolean, onChanged: () => void) {
  const { success, error, warning } = useToast()
  const navigate = useNavigate()
  const [lostAsk, setLostAsk] = useState<{ t: MoveTarget; s: Stage } | null>(null)
  const [check, setCheck] = useState<{ t: MoveTarget; s: Stage } | null>(null)
  const [next, setNext] = useState<MoveTarget | null>(null)

  const after = (t: MoveTarget, r: { status: string; message?: string; next?: unknown }, s: string) => {
    if (r.status === 'pending') warning(r.message || `“${s}” needs approval`)
    else if (r.status === 'moved') success(`Moved to ${s}`)
    onChanged()
    if (r.next) setNext(t)
  }
  const send = async (t: MoveTarget, s: Stage, extra: { reason?: string; comment?: string; checklist?: string[] } = {}) => {
    try {
      after(t, await quoteApi.stage(t.id, { stage_id: s.id, ...extra }), s.name)
    } catch (e) {
      const d = errDetail(e)
      if (d.lost) { setLostAsk({ t, s }); return }
      if (d.checklist) { setCheck({ t, s }); return }
      error(errMsg(e, 'Could not change the stage'))
      throw e
    }
  }
  const move = async (t: MoveTarget, s: Stage) => {
    if (s.id === t.currentId) return
    if (!canUpdate) { warning('You can view quotes but not move them'); return }
    const order = t.stages.map(x => x.id)
    const forward = order.indexOf(s.id) > order.indexOf(t.currentId) && s.kind !== 'lost'
    if (s.kind === 'lost') { setLostAsk({ t, s }); return }
    if (forward && s.gate === 'Checklist' && s.checklist.length) { setCheck({ t, s }); return }
    try { await send(t, s) } catch { /* reported */ }
  }
  /** prototype qsend(): move to the approval-gated stage */
  const sendForApproval = async (t: MoveTarget, label: string) => {
    if (!canUpdate) { warning('You can view quotes but not move them'); return }
    try { after(t, await quoteApi.sendForApproval(t.id), label) } catch (e) { error(errMsg(e, 'Could not send for approval')) }
  }
  const ui: ReactNode = <>
    {lostAsk && lost && <LostModal lost={lost} label={lostAsk.s.name} onClose={() => setLostAsk(null)} onConfirm={async (reason, comment) => {
      await send(lostAsk.t, lostAsk.s, { reason, comment }); setLostAsk(null)
    }} />}
    {check && <ChecklistModal stage={check.s} onClose={() => setCheck(null)} onConfirm={async items => { await send(check.t, check.s, { checklist: items }); setCheck(null) }} />}
    {next && <NextStepModal name={next.name} action="Create work order" onClose={() => setNext(null)} onConvert={async () => {
      try {
        const r = await quoteApi.workOrder(next.id)
        setNext(null); success(r.message); onChanged()
        await openWorkOrder(navigate, r.id)
      } catch (e) { error(errMsg(e, 'Could not create the work order')) }
    }} />}
  </>
  return { move, sendForApproval, ui }
}

function ChecklistModal({ stage, onClose, onConfirm }: { stage: Stage; onClose: () => void; onConfirm: (items: string[]) => Promise<void> }) {
  const { warning } = useToast()
  const [done, setDone] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  return <Modal title={`Stage checklist – ${stage.name}`} width={440} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={async () => {
      if (done.size < stage.checklist.length) { warning('Tick every mandatory item first'); return }
      setBusy(true)
      try { await onConfirm([...done]) } catch { /* reported */ } finally { setBusy(false) }
    }}>Confirm &amp; move</button></>}>
    <p className="mb" style={{ marginTop: 0 }}>Complete all mandatory items to enter this stage.</p>
    {stage.checklist.map(x => <label key={x} className="row mb" style={{ gap: 8, cursor: 'pointer' }}>
      <input type="checkbox" className="cl" checked={done.has(x)} onChange={e => setDone(s => { const n = new Set(s); e.target.checked ? n.add(x) : n.delete(x); return n })} /> {x}</label>)}
  </Modal>
}
