import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { platformApi, type ChangeSetRow, type EnvironmentsOverview, type SandboxRow, type SandboxSource } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Field, Ic, Loading, Note, PageHead, Panel, Pill, Strip, Table, errMsg, fd, inputCls, num, type Tone } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout, labels, modal and actions follow the Bidwise prototype v9 Environments & sandboxes page (P.envs, A.envNew,
// A.envAct, A.csPromote). Sandboxes are real MariaDB databases built in the background; a row shows Active only once
// its database exists (and, for masked copies, masking was verified against production).
const PAGE = 25
const SOURCES: [SandboxSource, string][] = [['masked', 'Production (masked PII)'], ['full', 'Production (full)'], ['template', 'Template data'], ['empty', 'Empty']]
const BUSY_STATES = ['Provisioning', 'Refreshing']
// Prototype sizes: GB with one decimal ("4.2 GB"), MB below 0.1 GB.
const size = (v: number) => v >= 102.4 ? `${(v / 1024).toFixed(1)} GB` : `${v.toFixed(1)} MB`
// The table names the production sources without "PII", as in the prototype.
const SOURCE_LABEL: Record<SandboxSource, string> = { masked: 'Production (masked)', full: 'Production (full)', template: 'Template data', empty: 'Empty' }
const envTone = (s: string): Tone => s === 'Active' ? 'ok' : s === 'Failed' ? 'ba' : 'wa'
const setTone = (s: string): Tone => s === 'Promoted' ? 'ok' : s === 'Failed' ? 'ba' : s === 'Rolled back' ? 'mu' : s === 'Awaiting approval' || s === 'Promoting' ? 'inf' : 'wa'

type Confirm = { title: string; body: ReactNode; label: string; danger?: boolean; run: () => Promise<void> }

function NewSandbox({ data, onClose, onDone }: { data: EnvironmentsOverview; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast()
  const [f, setF] = useState({ tenant_id: data.tenants[0]?.id ?? 0, name: '', source: 'masked' as SandboxSource, days: String(data.defaults.days || 30) })
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  const [authorise, setAuthorise] = useState(false)
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }))
  const days = Number(f.days)
  const invalid = { tenant: !f.tenant_id, name: !f.name.trim(), days: !Number.isInteger(days) || days < 1 || days > 365 }
  const submit = async (confirmUnmasked = false) => {
    setTried(true)
    if (invalid.tenant) return showError('Choose a tenant')
    if (invalid.name) return showError('Name the sandbox')
    if (invalid.days) return showError('Expires in must be a whole number from 1 to 365 days')
    if (f.source === 'full' && !confirmUnmasked) { setAuthorise(true); return }
    setBusy(true)
    try {
      await platformApi.createSandbox({ tenant_id: f.tenant_id, name: f.name.trim(), source: f.source, days, confirm_unmasked: confirmUnmasked })
      success('Sandbox is being created – it shows Active once its database is ready')
      onDone(); onClose()
    } catch (err) { showError(errMsg(err, 'The sandbox could not be created')) } finally { setBusy(false); setAuthorise(false) }
  }
  const err = (bad: boolean) => tried && bad ? 'err' : ''
  if (authorise) return <BwModal title="Unmasked production copy" width={480} onClose={() => setAuthorise(false)}
    foot={<><Btn onClick={() => setAuthorise(false)}>Cancel</Btn><Btn d disabled={busy} onClick={() => void submit(true)}>{busy ? 'Creating…' : 'I am authorised – create'}</Btn></>}>
    <p>This copies production <b>with real personal data</b> (names, emails, phone numbers, addresses, tax and bank details) into a sandbox. Only do this with the data owner’s authorisation; the request is recorded in the audit trail.</p>
  </BwModal>
  return <BwModal title="New sandbox" width={500} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy || !data.tenants.length} onClick={() => void submit()}>{busy ? 'Creating…' : 'Create sandbox'}</Btn></>}>
    <div className="grid gap-x-3 gap-y-[9px] sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Tenant"><select className={`${inputCls} ${err(invalid.tenant)}`} value={f.tenant_id} onChange={e => set('tenant_id', Number(e.target.value))}>
        {data.tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select></Field></div>
      <div className="sm:col-span-2"><Field label="Name"><input className={`${inputCls} ${err(invalid.name)}`} value={f.name} maxLength={120} autoFocus placeholder="e.g. UAT – new approvals" onChange={e => set('name', e.target.value)} /></Field></div>
      <Field label="Copy data from"><select className={inputCls} value={f.source} onChange={e => set('source', e.target.value as SandboxSource)}>{SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      <Field label="Expires in (days)"><input type="number" min={1} max={365} className={`${inputCls} ${err(invalid.days)}`} value={f.days} onChange={e => set('days', e.target.value)} /></Field>
    </div>
  </BwModal>
}

export default function PlatformEnvironmentsPage() {
  const { can } = usePlatformAccess()
  const { success, info, error: showError } = useToast()
  const [data, setData] = useState<EnvironmentsOverview | null>(null)
  const [error, setError] = useState('')
  const [offset, setOffset] = useState(0)
  const [csOffset, setCsOffset] = useState(0)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try { const { data } = await platformApi.environments(offset, csOffset, PAGE); setData(data); setError('') }
    catch (err) { setError(errMsg(err, 'Environments & sandboxes unavailable')) }
  }, [offset, csOffset])
  const building = !!data?.environments.items.some(e => BUSY_STATES.includes(e.status)) || !!data?.change_sets.items.some(c => c.status_key === 'promoting')
  useEffect(() => {
    void load()
    const t = window.setInterval(() => { if (!document.hidden) void load() }, building ? 4000 : 30000)
    return () => window.clearInterval(t)
  }, [load, building])

  const canManage = can('databases', 'manage')
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key)
    try { await fn(); success(done); await load() } catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy('') }
  }
  const envAct = (e: SandboxRow, v: 'refresh' | 'extend' | 'delete') => {
    if (v === 'extend') return void act(`x${e.id}`, () => platformApi.extendSandbox(e.id), 'Extended by 30 days')
    if (v === 'refresh') return setConfirm({
      title: 'Refresh sandbox', label: 'Refresh', body: <p>Rebuild <b>{e.name}</b> from {e.source}? A new copy is made from production as it is now; changes made in this sandbox that were not promoted are discarded. Production is not changed.</p>,
      run: () => act(`r${e.id}`, () => platformApi.refreshSandbox(e.id), 'Refreshing from source'),
    })
    setConfirm({
      title: 'Delete sandbox', label: 'Delete', danger: true,
      body: <p>Delete <b>{e.name}</b> ({e.tenant})? Its database <code className="text-xs">{e.database}</code> and database account are dropped. The tenant’s production database is not affected.</p>,
      run: () => act(`d${e.id}`, () => platformApi.deleteSandbox(e.id), 'Sandbox deleted'),
    })
  }
  const promote = (c: ChangeSetRow) => setConfirm({
    title: 'Promote change set', label: 'Promote', body: <p>Promote this change set to production? It is applied with a rollback point.</p>,
    run: async () => {
      setBusy(`p${c.id}`)
      try {
        const { data: r } = await platformApi.promoteChangeSet(c.id)
        if (r.approval_required) info('Sent for approval', `Request #${r.request_id} – another staff member with Databases access approves it in Platform team → Approval actions`)
        else success('Change set promoted to production')
        await load()
      } catch (err) { showError(errMsg(err, 'The change set could not be promoted')); await load() } finally { setBusy('') }
    },
  })

  const k = data?.kpis
  const env = data?.environments, sets = data?.change_sets
  const pager = (p: { total: number; offset: number; limit: number } | undefined, set: (n: number) => void) => p && p.total > p.limit && <div className="bw-pgn">
    <span className="flex-1">{p.offset + 1}–{Math.min(p.offset + p.limit, p.total)} of {num(p.total)}</span>
    <Btn s disabled={p.offset === 0} onClick={() => set(Math.max(0, p.offset - p.limit))}>‹ Prev</Btn>
    <Btn s disabled={p.offset + p.limit >= p.total} onClick={() => set(p.offset + p.limit)}>Next ›</Btn>
  </div>
  const noManage = canManage ? undefined : 'Needs Databases manage access'

  return <div>
    {creating && data && <NewSandbox data={data} onClose={() => setCreating(false)} onDone={() => { setOffset(0); void load() }} />}
    {confirm && <BwModal title={confirm.title} width={460} onClose={() => setConfirm(null)}
      foot={<><Btn onClick={() => setConfirm(null)}>Cancel</Btn><Btn p={!confirm.danger} d={confirm.danger} onClick={() => { const run = confirm.run; setConfirm(null); void run() }}>{confirm.label}</Btn></>}>{confirm.body}</BwModal>}

    <PageHead crumb="Data & infrastructure" title="Environments & sandboxes">
      <Btn p onClick={() => setCreating(true)} disabled={!data || !canManage} title={noManage}><Ic n="plus" /> New sandbox</Btn>
    </PageHead>
    {error && <Note className="mb-2">{error}</Note>}

    <Strip items={[
      { l: 'Sandboxes', v: k ? num(k.sandboxes) : '—', kpi: 'environments.sandboxes' },
      { l: 'Storage used', v: k ? size(k.storage_mb) : '—', kpi: 'environments.storage' },
      { l: 'Pending change sets', v: k ? num(k.pending_change_sets) : '—', kpi: 'environments.pending_change_sets' },
      { l: 'Expiring ≤ 14 days', v: k ? num(k.expiring_14d) : '—', dc: 'twarn', kpi: 'environments.expiring' },
    ]} />

    <Panel title="Environments" flush>
      {!data ? (error ? <Empty>{error}</Empty> : <Loading />) : !env?.items.length ? <Empty>No sandboxes yet. Use New sandbox to copy a tenant into an isolated database.</Empty> : <>
        <Table head={['Name', 'Tenant', 'Source', { t: 'Size', r: true }, 'Created', 'Expires', 'Status', 'Actions']} minWidth={980}>
          {env.items.map(e => { const working = BUSY_STATES.includes(e.status); return <tr key={e.id}>
            <td><b>{e.name}</b>{(e.progress && working) || e.error ? <><br /><small style={{ color: e.error ? C.ba : C.mu }} title={e.error ?? undefined}>{e.error ? (e.error.length > 80 ? `${e.error.slice(0, 80)}…` : e.error) : e.progress}</small></> : null}</td>
            <td>{e.tenant}</td>
            <td>{SOURCE_LABEL[e.source_key] ?? e.source}{e.masking_verified && <small style={{ color: C.ok }} title="Masking verified against production"> ✓</small>}</td>
            <td className="text-right">{e.size_mb == null ? '—' : size(e.size_mb)}</td>
            <td className="whitespace-nowrap">{fd(e.created_at)}</td>
            <td className="whitespace-nowrap"><span style={{ color: e.expires_in_days < 0 ? C.ba : e.expires_in_days <= 14 ? C.wa : undefined }}>{fd(e.expires_at)}</span> <small style={{ color: C.mu }}>{e.expires_in_days < 0 ? 'expired' : `in ${e.expires_in_days}d`}</small></td>
            <td><Pill t={envTone(e.status)}>{e.status}</Pill></td>
            <td className="whitespace-nowrap">
              <Btn s disabled={!canManage || e.status !== 'Active' || !!busy} title={noManage} onClick={() => envAct(e, 'refresh')}>Refresh</Btn>{' '}
              <Btn s disabled={!canManage || !!busy} title={noManage} onClick={() => envAct(e, 'extend')}>Extend</Btn>{' '}
              <Btn s d disabled={!canManage || working || !!busy} title={noManage ?? (working ? 'Wait until the build finishes' : undefined)} onClick={() => envAct(e, 'delete')}>Delete</Btn>
            </td>
          </tr> })}
        </Table>
        {pager(env, setOffset)}
      </>}
    </Panel>

    <div className="mt-2">
      <Panel title="Change sets · promote sandbox changes to production" flush>
        {!data ? <Loading /> : !sets?.items.length ? <Empty>No change sets. Configuration changed in an active sandbox appears here within a few minutes.</Empty> : <>
          <Table head={['Change set', 'Contents', 'Tenant', 'From sandbox', { t: 'Items', r: true }, 'Status', 'Action']} minWidth={900}>
            {sets.items.map(c => <tr key={c.id}>
              <td><b>{c.code}</b></td>
              <td className="max-w-[360px] whitespace-normal">{c.contents}{c.error && <><br /><small style={{ color: C.ba }}>{c.error}</small></>}</td>
              <td>{c.tenant}</td>
              <td>{c.from_sandbox}</td>
              <td className="text-right">{num(c.items)}</td>
              <td><Pill t={setTone(c.status)} title={c.promoted_at ? `${fd(c.promoted_at)} · ${c.promoted_by ?? ''}` : c.approval_request_id ? `Approval request #${c.approval_request_id}` : undefined}>{c.status}</Pill></td>
              <td>{(c.status_key === 'ready' || c.status_key === 'failed') && <Btn s p disabled={!canManage || !!busy} title={noManage} onClick={() => promote(c)}>{busy === `p${c.id}` ? 'Promoting…' : 'Promote'}</Btn>}</td>
            </tr>)}
          </Table>
          {pager(sets, setCsOffset)}
        </>}
      </Panel>
    </div>
  </div>
}
