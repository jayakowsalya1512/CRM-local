import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { isApprovalQueued, platformApi, type PlatformApproval } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import PlatformTeamTabs, {
  Pill, TeamModal, TeamPanel, apiError, buttonClass, fieldLabelClass, formatDateTime, inputClass,
  primaryButtonClass, smallButtonClass, smallDangerButtonClass, smallPrimaryButtonClass,
} from '@/components/platform/PlatformTeamTabs'
import { notifyPlatformAccessChanged, usePlatformAccess } from '@/components/platform/usePlatformAccess'

const STATUS_TONE = { pending: 'wa', approved: 'ok', rejected: 'ba', failed: 'ba', cancelled: 'mu' } as const
const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', failed: 'Failed', cancelled: 'Withdrawn' } as const
const COVERED = [
  'Suspend a tenant',
  'Turn on global maintenance mode',
  'Delete a plan',
  'Deactivate a staff account',
  'Change a staff member’s role or tenant scope',
  'Change a role’s permissions',
  'Turn four-eyes approval off',
]

type Decision = { request: PlatformApproval; verdict: 'approve' | 'reject' }

export default function PlatformApprovalQueuePage() {
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const { me, can, reload } = usePlatformAccess()
  const [rows, setRows] = useState<PlatformApproval[]>([])
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [deciding, setDeciding] = useState<Decision | null>(null)
  const [policyBusy, setPolicyBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await platformApi.listApprovals(filter)
      setRows(data)
    } catch (err) {
      toastRef.current.error(apiError(err, 'Unable to load the approval queue'))
    } finally {
      setLoading(false)
    }
  }, [filter])
  useEffect(() => { void load() }, [load])

  const refreshAll = async () => {
    notifyPlatformAccessChanged()
    await load()
  }

  const withdraw = async (row: PlatformApproval) => {
    setBusyId(row.id)
    try {
      await platformApi.cancelRequest(row.id)
      toast.success(`Request #${row.id} withdrawn`)
      await refreshAll()
    } catch (err) {
      toast.error(apiError(err, 'Unable to withdraw the request'))
    } finally {
      setBusyId(null)
    }
  }

  const togglePolicy = async () => {
    if (!me) return
    const next = !me.four_eyes_enabled
    if (!next && !window.confirm('Turn off four-eyes approval? Another staff member must approve this.')) return
    setPolicyBusy(true)
    try {
      const { data } = await platformApi.setFourEyes(next)
      if (isApprovalQueued(data)) toast.info('Sent for approval', data.message)
      else toast.success(`Four-eyes approval ${next ? 'on' : 'off'}`)
      reload()
      await refreshAll()
    } catch (err) {
      toast.error(apiError(err, 'Unable to change four-eyes approval'))
    } finally {
      setPolicyBusy(false)
    }
  }

  return (
    <PlatformTeamTabs title="Approval queue">
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <TeamPanel
          title="Four-eyes approval queue"
          actions={
            <div className="flex rounded-md border border-[var(--bw-ln)] bg-white p-px" role="group" aria-label="Show">
              {(['pending', 'all'] as const).map(option => (
                <button key={option} type="button" aria-pressed={filter === option} onClick={() => setFilter(option)}
                  className={`h-[22px] rounded-[2px] px-2 text-[12px] font-medium ${filter === option ? 'bg-[var(--bw-ac)] text-white' : 'text-[var(--bw-mu)] hover:text-[var(--bw-tx)]'}`}>
                  {option === 'pending' ? 'Pending' : 'All'}
                </button>
              ))}
            </div>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left">
              <thead>
                <tr>
                  <th className="w-[70px]">Request</th>
                  <th>Action</th>
                  <th className="w-[110px]">Area</th>
                  <th className="w-[140px]">Requested by</th>
                  <th className="w-[90px]">Status</th>
                  <th className="w-[150px]"><span className="sr-only">Decision</span></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="!py-6 text-center text-[var(--bw-mu)]">Loading queue…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6} className="!py-6 text-center text-[var(--bw-mu)]">{filter === 'pending' ? 'Nothing is waiting for approval.' : 'No approval requests yet.'}</td></tr>
                ) : rows.map(row => (
                  <tr key={row.id}>
                    <td className="font-medium text-[var(--bw-ac)]">#{row.id}</td>
                    <td className="!whitespace-normal">
                      <div>{row.summary}</div>
                      {row.status !== 'pending' && (
                        <div className="text-[11px] text-[var(--bw-mu)]">
                          {row.decided_by && `${STATUS_LABEL[row.status]} by ${row.decided_by} · ${formatDateTime(row.decided_at)}`}
                          {row.decision_note && ` · “${row.decision_note}”`}
                          {row.status === 'failed' && row.result && <span className="text-[var(--bw-ba)]"> · {row.result}</span>}
                        </div>
                      )}
                    </td>
                    <td>{row.module_label}</td>
                    <td>
                      <div className="truncate">{row.requested_by}</div>
                      <div className="text-[11px] text-[var(--bw-mu)]">{formatDateTime(row.requested_at)}</div>
                    </td>
                    <td><Pill tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Pill></td>
                    <td className="text-right">
                      {row.status === 'pending' && (
                        <div className="flex justify-end gap-1">
                          {row.can_decide && <>
                            <button type="button" className={smallPrimaryButtonClass} disabled={busyId !== null} onClick={() => setDeciding({ request: row, verdict: 'approve' })}>Approve</button>
                            <button type="button" className={smallDangerButtonClass} disabled={busyId !== null} onClick={() => setDeciding({ request: row, verdict: 'reject' })}>Reject</button>
                          </>}
                          {row.can_cancel && (
                            <button type="button" className={smallButtonClass} disabled={busyId !== null} onClick={() => withdraw(row)}>
                              {busyId === row.id && <Loader2 size={11} className="animate-spin" />}Withdraw
                            </button>
                          )}
                          {!row.can_decide && !row.can_cancel && <span className="text-[11px] text-[var(--bw-mu)]">Awaiting approver</span>}                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TeamPanel>

        <TeamPanel title="Policy">
          <div className="px-2.5 py-2">
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <div className="font-medium">Four-eyes approval</div>
                <div className="text-[11px] text-[var(--bw-mu)]">A second staff member must approve sensitive actions.</div>
              </div>
              <button
                type="button" role="switch" aria-checked={!!me?.four_eyes_enabled} aria-label="Four-eyes approval"
                disabled={!me || !can('team', 'manage') || policyBusy}
                onClick={togglePolicy}
                className={`relative h-4 w-[30px] flex-none rounded-[9px] transition-colors disabled:opacity-50 ${me?.four_eyes_enabled ? 'bg-[var(--bw-ac)]' : 'bg-[var(--bw-ln)]'}`}
              >
                <span className={`absolute top-[2px] h-3 w-3 rounded-full bg-white transition-all ${me?.four_eyes_enabled ? 'left-4' : 'left-[2px]'}`} />
              </button>
            </div>
            <div className="mt-2 border-t border-[var(--bw-ln2)] pt-1.5 text-[11px] text-[var(--bw-mu)]">Needs approval when on:</div>
            <ul className="mt-0.5 space-y-0.5 text-[12px]">
              {COVERED.map(item => <li key={item} className="flex gap-1.5"><span className="text-[var(--bw-ac)]">•</span>{item}</li>)}
            </ul>
            <p className="mt-2 text-[11px] text-[var(--bw-mu)]">
              The requester can't approve their own request, and the approver needs Manage access to that area. Turning it on needs at least two staff who can manage the platform team.
            </p>
          </div>
        </TeamPanel>
      </div>

      {deciding && (
        <DecisionModal decision={deciding} onClose={() => setDeciding(null)}
          onDone={(status, message) => {
            setDeciding(null)
            if (status === 'failed') toast.error('Approved, but it could not be applied', message)
            else toast.success(message)
            void refreshAll()
          }} />
      )}
    </PlatformTeamTabs>
  )
}

function DecisionModal({ decision, onClose, onDone }: { decision: Decision; onClose: () => void; onDone: (status: string, message: string) => void }) {
  const { request, verdict } = decision
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true); setError('')
    try {
      const { data } = verdict === 'approve'
        ? await platformApi.approveRequest(request.id, note || undefined)
        : await platformApi.rejectRequest(request.id, note || undefined)
      onDone(data.status, data.message)
    } catch (err) {
      setError(apiError(err, `Unable to ${verdict} this request`))
    } finally {
      setSaving(false)
    }
  }

  return (
    <TeamModal title={`${verdict === 'approve' ? 'Approve' : 'Reject'} request #${request.id}`} onClose={onClose} onSubmit={submit} width={460} footer={<>
      <button type="button" className={buttonClass} onClick={onClose}>Cancel</button>
      <button type="submit" disabled={saving}
        className={verdict === 'approve' ? primaryButtonClass : `${buttonClass} !border-[var(--bw-ba)] !bg-[var(--bw-ba)] !text-white hover:brightness-110`}>
        {saving && <Loader2 size={13} className="animate-spin" />}{verdict === 'approve' ? 'Approve and apply' : 'Reject'}
      </button>
    </>}>
      {error && <p role="alert" className="mb-2.5 text-[12px] text-[var(--bw-ba)]">{error}</p>}
      <div className="rounded-md border border-[var(--bw-ln)] bg-[var(--bw-hd)] px-2.5 py-2">
        <div className="font-medium">{request.summary}</div>
        <div className="mt-0.5 text-[11px] text-[var(--bw-mu)]">{request.module_label} · requested by {request.requested_by} · {formatDateTime(request.requested_at)}</div>
      </div>
      {verdict === 'approve' && <p className="mt-2 text-[12px] text-[var(--bw-mu)]">Approving applies the change immediately, recorded in the audit log under your name.</p>}
      <label className={`${fieldLabelClass} mt-2.5`} htmlFor="decision-note">Note {verdict === 'reject' ? '(tell the requester why)' : '(optional)'}</label>
      <textarea id="decision-note" className={`${inputClass} !h-auto py-1.5`} rows={3} maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
    </TeamModal>
  )
}
