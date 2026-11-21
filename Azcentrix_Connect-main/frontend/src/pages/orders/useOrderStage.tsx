// Order stage moves (board drag-and-drop, drawer stage path) – prototype moveStage(): checklist gate → "Stage checklist –
// <stage>" dialog; approval gate → held and sent to the approver (toast). The server applies every rule again.
import { useState, type ReactNode } from 'react'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { errDetail, errMsg, orderApi, type Stage } from './orderApi'

export interface MoveTarget { id: number; name: string; stages: Stage[]; currentId: number }

export function useOrderStage(canUpdate: boolean, onChanged: () => void): { move: (t: MoveTarget, s: Stage) => Promise<void>; ui: ReactNode } {
  const { success, error, warning } = useToast()
  const [check, setCheck] = useState<{ t: MoveTarget; s: Stage } | null>(null)

  const send = async (t: MoveTarget, s: Stage, checklist?: string[]) => {
    try {
      const r = await orderApi.stage(t.id, { stage_id: s.id, ...(checklist ? { checklist } : {}) })
      if (r.status === 'pending') warning(r.message || `“${s.name}” needs approval`)
      else if (r.status === 'moved') success(r.message || `Moved to ${s.name}`)
      onChanged()
    } catch (e) {
      if (errDetail(e).checklist) { setCheck({ t, s }); return }
      error(errMsg(e, 'Could not change the stage'))
      throw e
    }
  }
  const move = async (t: MoveTarget, s: Stage) => {
    if (s.id === t.currentId) return
    if (!canUpdate) { warning('You can view orders but not move them'); return }
    const order = t.stages.map(x => x.id)
    const forward = order.indexOf(s.id) > order.indexOf(t.currentId)
    if (forward && s.gate === 'Checklist' && s.checklist.length) { setCheck({ t, s }); return }
    try { await send(t, s) } catch { /* reported */ }
  }
  const ui = check && <ChecklistModal stage={check.s} onClose={() => setCheck(null)} onConfirm={async items => { await send(check.t, check.s, items); setCheck(null) }} />
  return { move, ui }
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
