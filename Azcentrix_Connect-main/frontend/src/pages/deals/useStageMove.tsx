// Deal stage moves (board drag-and-drop, drawer stage bar, Next stage) – prototype moveStage():
// checklist gate → "Stage checklist – <stage>" dialog; lost stage → "Why was this lost?"; approval gate → held and sent
// to the approver (toast); winning stage → "Next step" (Create tender record / Create quotation). The server applies
// every rule again (stage engine), so the dialogs only collect what it asks for.
import { useState, type ReactNode } from 'react'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import FieldError from '@/components/form/FieldError'
import { LostModal, NextStepModal } from '@/pages/leads/StageModals'
import { dealApi, errDetail, errMsg, type Meta, type Stage } from './dealApi'

export interface MoveTarget { id: number; name: string; stages: Stage[]; currentId: number }

export function useStageMove(meta: Meta | null, onChanged: () => void, onOpen?: (id: number) => void): { move: (t: MoveTarget, s: Stage) => Promise<void>; ui: ReactNode } {
  const { success, error, warning } = useToast()
  const [lost, setLost] = useState<{ t: MoveTarget; s: Stage } | null>(null)
  const [check, setCheck] = useState<{ t: MoveTarget; s: Stage } | null>(null)
  const [next, setNext] = useState<{ t: MoveTarget; label: string } | null>(null)

  const send = async (t: MoveTarget, s: Stage, extra: { reason?: string; comment?: string; checklist?: string[] } = {}) => {
    try {
      const r = await dealApi.stage(t.id, { stage_id: s.id, ...extra })
      if (r.status === 'pending') warning(r.message || `“${s.name}” needs approval`)
      else if (r.status === 'moved') success(`Moved to ${s.name}`)
      onChanged()
      if (r.next) setNext({ t, label: r.next.label })
    } catch (e) {
      const d = errDetail(e)
      if (d.lost) { setLost({ t, s }); return }
      if (d.checklist) { setCheck({ t, s }); return }
      error(errMsg(e, 'Could not change the stage'))
      throw e
    }
  }
  const move = async (t: MoveTarget, s: Stage) => {
    if (s.id === t.currentId) return
    if (!meta?.can.update) { warning('You can view deals but not move them'); return }
    const order = t.stages.map(x => x.id)
    const forward = order.indexOf(s.id) > order.indexOf(t.currentId) && s.kind !== 'lost'
    if (s.kind === 'lost') { setLost({ t, s }); return }
    if (forward && s.gate === 'Checklist' && s.checklist.length) { setCheck({ t, s }); return }
    try { await send(t, s) } catch { /* reported */ }
  }
  const ui = <>
    {lost && meta && <LostModal lost={meta.lost} label={lost.s.name} onClose={() => setLost(null)} onConfirm={async (reason, comment) => {
      await send(lost.t, lost.s, { reason, comment }); setLost(null)
    }} />}
    {check && <ChecklistModal stage={check.s} onClose={() => setCheck(null)} onConfirm={async items => { await send(check.t, check.s, { checklist: items }); setCheck(null) }} />}
    {next && <NextStepModal name={next.t.name} action={next.label} onClose={() => setNext(null)} onConvert={async () => {
      const r = await dealApi.convert(next.t.id)
      const id = next.t.id
      setNext(null)
      r.approval_status === 'pending' ? warning(r.message || 'Conversion sent for approval') : success(r.message || 'Converted')
      onChanged(); onOpen?.(id)
    }} />}
  </>
  return { move, ui }
}

function ChecklistModal({ stage, onClose, onConfirm }: { stage: Stage; onClose: () => void; onConfirm: (items: string[]) => Promise<void> }) {
  const [done, setDone] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [miss, setMiss] = useState('')   // shown under the checklist until every mandatory item is ticked
  return <Modal title={`Stage checklist – ${stage.name}`} width={440} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={async () => {
      if (done.size < stage.checklist.length) { setMiss(`Tick every mandatory item first (${stage.checklist.length - done.size} left).`); return }
      setBusy(true)
      try { await onConfirm([...done]) } catch { /* reported */ } finally { setBusy(false) }
    }}>Confirm &amp; move</button></>}>
    <p className="mb" style={{ marginTop: 0 }}>Complete all mandatory items to enter this stage.</p>
    {stage.checklist.map(x => <label key={x} className="row mb" style={{ gap: 8, cursor: 'pointer' }}>
      <input type="checkbox" className="cl" checked={done.has(x)} aria-invalid={miss && !done.has(x) ? true : undefined} onChange={e => {
        const n = new Set(done); e.target.checked ? n.add(x) : n.delete(x); setDone(n)
        if (miss) setMiss(n.size < stage.checklist.length ? `Tick every mandatory item first (${stage.checklist.length - n.size} left).` : '')
      }} /> {x}</label>)}
    <FieldError msg={miss} />
  </Modal>
}
