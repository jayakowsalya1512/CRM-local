import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { platformApi, type Paged, type TsCase, type TsCaseDetail, type TsHistory, type TsOverview, type TsUser } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Field, Kv, Note, Panel, Pill, Strip, Switch, Table, errMsg, fd, inputCls, inputStyle, type Tone } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout follows the Bidwise prototype Trust & safety page (P.abuse): KPI strip, abuse cases, acceptable-use enforcement,
// find and act on a user (all tenants), recent enforcement actions; case drawer (caseOpen), user termination (tuser) and
// tenant suspension / termination (tTermOpen) modals. Every outcome shown comes from what the backend actually did.
const SEV_TONE: Record<string, Tone> = { Critical: 'ba', High: 'wa', Medium: 'inf', Low: 'mu' }
const STATUS_TONE: Record<string, Tone> = { 'Under review': 'inf', Investigating: 'wa', Escalated: 'ba', Closed: 'mu', Active: 'ok', Suspended: 'wa', Terminated: 'ba' }
const sel = `${inputCls} bg-transparent`

function EmptyRow({ cols, children }: { cols: number; children: ReactNode }) {
  return <tr><td colSpan={cols} className="!p-0"><Empty>{children}</Empty></td></tr>
}

function Pager<T>({ page, onPage }: { page: Paged<T>; onPage: (offset: number) => void }) {
  if (page.total <= page.limit) return null
  return <div className="flex items-center justify-end gap-2 border-t px-2.5 py-1.5 text-xs" style={{ borderColor: C.ln2, color: C.mu }}>
    <span>{page.offset + 1}–{Math.min(page.offset + page.items.length, page.total)} of {page.total}</span>
    <Btn s disabled={page.offset === 0} onClick={() => onPage(Math.max(0, page.offset - page.limit))}>Prev</Btn>
    <Btn s disabled={page.offset + page.limit >= page.total} onClick={() => onPage(page.offset + page.limit)}>Next</Btn>
  </div>
}

function Check({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange?: (v: boolean) => void; children: ReactNode }) {
  return <label className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2, opacity: disabled && !checked ? 0.6 : 1 }}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange?.(e.target.checked)} style={{ accentColor: 'var(--bw-ac)' }} />
    <span className="flex-1">{children}</span>
  </label>
}

// ── Case drawer (prototype .dw) ──────────────────────────────────────────────
function CaseDrawer({ id, canManage, onClose, onChanged, onTenant }: { id: number; canManage: boolean; onClose: () => void; onChanged: () => void; onTenant: (tenantId: number | null, caseId: number) => void }) {
  const { success, error: showError } = useToast()
  const [c, setC] = useState<TsCaseDetail | null>(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => { platformApi.tsCase(id).then(r => setC(r.data)).catch(e => setErr(errMsg(e, 'Case unavailable'))) }, [id])
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h) }, [onClose])
  const act = async (action: string) => {
    setBusy(action)
    try { const { data } = await platformApi.tsCaseAction(id, action, note); setC(data.case); setNote(''); success(data.message); onChanged() }
    catch (e) { showError(errMsg(e, 'Action failed')) } finally { setBusy('') }
  }
  const closed = c?.status === 'Closed'
  const dis = (a: string) => !canManage || closed || !!busy || (a === 'authority' && !note.trim()) || ((a === 'request_info' || a === 'warn') && !c?.tenant_id)
  const hashes = c?.evidence_items.map(e => `${e.description}: ${e.sha256 ? `sha256 ${e.sha256.slice(0, 16)}…` : e.export ? `export ${e.export.status}` : 'pending'}`).join('\n')
  return <div className="fixed inset-0 z-50" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="absolute bottom-0 right-0 top-0 flex flex-col border-l text-[13px]" style={{ width: 'min(680px, 100%)', background: C.sf, borderColor: C.ln, color: C.tx, boxShadow: '0 10px 28px rgba(8,14,22,.22)' }}>
      <div className="flex items-start gap-2 border-b px-3.5 py-2.5" style={{ borderColor: C.ln }}>
        <div className="flex-1">{c ? <><h2 className="text-base font-semibold">{c.title}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-1" style={{ color: C.mu }}>{c.ref} · <Pill t={SEV_TONE[c.severity]}>{c.severity}</Pill> <Pill t={STATUS_TONE[c.status]}>{c.status}</Pill> · {c.category}</div></>
          : <h2 className="text-base font-semibold">{err || 'Loading…'}</h2>}</div>
        <button type="button" aria-label="Close" onClick={onClose} style={{ color: C.mu }}><X size={16} /></button>
      </div>
      {c && <div className="flex-1 overflow-auto px-3.5 py-2.5">
        <Kv rows={[['Tenant', c.tenant ?? '—'], ['Source', c.source], ['Opened', fd(c.opened_at)], ['Evidence items', <span title={hashes || undefined}>{c.evidence}</span>], ['Assigned', c.assigned_to ?? '—']]} />
        <Note className="mt-2">Evidence is preserved with hash locks and a legal hold; deleting the user or tenant never deletes it.</Note>
        <h3 className="mb-2 mt-3 font-semibold">Timeline</h3>
        <div className="ml-1.5 border-l-2 pl-3" style={{ borderColor: C.ln }}>{c.timeline.map((t, i) =>
          <div key={i} className="relative pb-2.5"><span className="absolute rounded-full" style={{ left: -18, top: 4, width: 8, height: 8, background: C.ac }} />
            <b>{t.event}</b><br /><small style={{ color: C.mu }}>{fd(t.at)} · {t.actor}</small></div>)}</div>
        <h3 className="mb-2 mt-3 font-semibold">Actions</h3>
        <textarea className={`${inputCls} mb-2 h-auto py-1`} style={inputStyle} rows={2} value={note} disabled={!canManage || closed} onChange={e => setNote(e.target.value)}
          placeholder="Note – sent with a request or warning; required to log a notice to authorities (authority and reference)" />
        <div className="grid grid-cols-2 gap-2">
          <Btn disabled={dis('request_info')} onClick={() => void act('request_info')}>Request information</Btn>
          <Btn disabled={dis('warn')} onClick={() => void act('warn')}>Warn tenant admin</Btn>
          <Btn disabled={dis('escalate')} onClick={() => void act('escalate')}>Escalate to legal</Btn>
          <Btn disabled={dis('authority')} title={!note.trim() ? 'Write which authority was notified and the reference first' : undefined} onClick={() => void act('authority')}>Log notice to authorities</Btn>
          <Btn d disabled={!canManage || closed || !c.tenant_id} onClick={() => onTenant(c.tenant_id, c.id)}>Suspend / terminate tenant</Btn>
          <Btn p disabled={dis('close')} onClick={() => void act('close')}>Close case</Btn>
        </div>
      </div>}
    </div>
  </div>
}

// ── Terminate user modal (prototype tuser → terminate) ───────────────────────
function TerminateUserModal({ user, data, onClose, onDone }: { user: TsUser; data: TsOverview; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast()
  const [reason, setReason] = useState(data.options.user_reasons[0])
  const [caseId, setCaseId] = useState('')
  const [notes, setNotes] = useState('')
  const [others, setOthers] = useState<TsUser[] | null>(null)
  const [transfer, setTransfer] = useState('')
  const [revoke, setRevoke] = useState(true)
  const [notify, setNotify] = useState(true)
  const [block, setBlock] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    platformApi.tsUsers('', 0, user.tenant_id, 500).then(r => {
      const list = r.data.items.filter(u => u.id !== user.id && u.status === 'Active'); setOthers(list); if (list.length) setTransfer(String(list[0].id))
    }).catch(() => setOthers([]))
  }, [user])
  const go = async () => {
    setBusy(true)
    try {
      const { data: r } = await platformApi.tsTerminateUser(user.tenant_id, user.id, { reason, case_id: caseId ? Number(caseId) : null, notes,
        transfer_to: transfer ? Number(transfer) : null, revoke, notify, block, legal_hold: true, confirm })
      const parts = [`evidence preserved (sha256 ${r.evidence_sha256.slice(0, 12)}…)`]
      if (r.revoked) parts.push(`${r.revoked.sessions} session(s) revoked`)
      const moved = Object.values(r.transferred || {}).reduce((a, b) => a + b, 0)
      if (transfer) parts.push(`${moved} record(s) transferred`)
      if (r.notified) parts.push(r.notified.sent ? 'tenant admin notified' : `tenant admin not notified (${r.notified.detail})`)
      if (r.blocked.domain) parts.push(`${r.blocked.domain} and ${r.blocked.devices} device(s) blocked`)
      success(`${r.name} terminated`, parts.join(' · '))
      onDone()
    } catch (e) { showError(errMsg(e, 'Unable to terminate the user')) } finally { setBusy(false) }
  }
  return <BwModal width={560} onClose={onClose} title={<span style={{ color: C.ba }}>Terminate {user.name}</span>} foot={<>
    <Btn onClick={onClose}>Cancel</Btn><Btn d disabled={busy || confirm.trim() !== 'TERMINATE'} onClick={() => void go()}>{busy ? 'Terminating…' : 'Terminate user'}</Btn></>}>
    <div className="rounded-md border px-2.5 py-1.5 text-xs" style={{ borderColor: C.ba, background: `color-mix(in srgb, ${C.ba} 8%, var(--bw-sf))` }}>
      This permanently blocks sign-in for <b>{user.email}</b> in <b>{user.tenant}</b>. Their data stays with the tenant; evidence is preserved.</div>
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      <Field label="Reason"><select className={sel} style={inputStyle} value={reason} onChange={e => setReason(e.target.value)}>{data.options.user_reasons.map(r => <option key={r}>{r}</option>)}</select></Field>
      <Field label="Linked case"><select className={sel} style={inputStyle} value={caseId} onChange={e => setCaseId(e.target.value)}>
        <option value="">None</option>{data.cases.items.filter(c => c.tenant_id === user.tenant_id && c.status !== 'Closed').map(c => <option key={c.id} value={c.id}>{c.ref}</option>)}</select></Field>
      <div className="sm:col-span-2"><Field label="Notes (kept in the audit trail)"><textarea className={`${inputCls} h-auto py-1`} style={inputStyle} rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></Field></div>
      <div className="sm:col-span-2"><Field label="Transfer their owned records to"><select className={sel} style={inputStyle} value={transfer} disabled={!others?.length} onChange={e => setTransfer(e.target.value)}>
        {others === null ? <option>Loading…</option> : !others.length ? <option value="">No other active user in {user.tenant}</option> : others.map(o => <option key={o.id} value={o.id}>{o.name} ({o.email})</option>)}</select></Field></div>
    </div>
    <div className="mt-2 rounded-md border" style={{ borderColor: C.ln }}>
      <Check checked disabled>Preserve evidence under legal hold (required)</Check>
      <Check checked={revoke} onChange={setRevoke}>Revoke all sessions, API keys and OAuth tokens</Check>
      <Check checked={notify} onChange={setNotify}>Notify the tenant administrator</Check>
      <Check checked={block} onChange={setBlock}>Block the email domain and device fingerprints</Check>
    </div>
    <label className="mb-0.5 mt-2 block text-xs" style={{ color: C.mu }}>Type <b>TERMINATE</b> to confirm</label>
    <input className={inputCls} style={inputStyle} value={confirm} onChange={e => setConfirm(e.target.value)} />
  </BwModal>
}

// ── Suspend / terminate a tenant (prototype tTermOpen) ───────────────────────
function TenantModal({ data, tenantId, caseId, onClose, onDone }: { data: TsOverview; tenantId: number | null; caseId: number | null; onClose: () => void; onDone: () => void }) {
  const { success, info, error: showError } = useToast()
  const [tenant, setTenant] = useState(String(tenantId ?? data.tenants[0]?.id ?? ''))
  const [action, setAction] = useState<'suspend' | 'terminate'>('suspend')
  const [reason, setReason] = useState(data.options.tenant_reasons[0])
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const t = data.tenants.find(x => String(x.id) === tenant)
  const go = async () => {
    if (!t) return
    setBusy(true)
    try {
      const { data: r } = await platformApi.tsEnforceTenant(t.id, { action, reason, case_id: caseId, confirm })
      if (r.approval_required) info('Sent for approval', r.message); else success(r.action ?? 'Done', r.message)
      onDone()
    } catch (e) { showError(errMsg(e, 'Unable to apply the action')) } finally { setBusy(false) }
  }
  return <BwModal width={520} onClose={onClose} title={<span style={{ color: C.ba }}>Suspend or terminate a tenant</span>} foot={<>
    <Btn onClick={onClose}>Cancel</Btn><Btn d disabled={busy || !t || confirm.trim().toLowerCase() !== t.slug.toLowerCase()} onClick={() => void go()}>{busy ? 'Working…' : 'Proceed'}</Btn></>}>
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Tenant"><select className={sel} style={inputStyle} value={tenant} onChange={e => { setTenant(e.target.value); setConfirm('') }}>
        {data.tenants.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field></div>
      <Field label="Action"><select className={sel} style={inputStyle} value={action} onChange={e => setAction(e.target.value as 'suspend' | 'terminate')}>
        <option value="suspend">Suspend (reversible)</option><option value="terminate">Terminate ({data.options.grace_days} day grace, then delete)</option></select></Field>
      <Field label="Reason"><select className={sel} style={inputStyle} value={reason} onChange={e => setReason(e.target.value)}>{data.options.tenant_reasons.map(r => <option key={r}>{r}</option>)}</select></Field>
    </div>
    <Note className="mt-2">Data export for legal hold is generated automatically before termination. A second approver is required when four-eyes is on.</Note>
    <label className="mb-0.5 mt-2 block text-xs" style={{ color: C.mu }}>Type the tenant short name to confirm</label>
    <input className={inputCls} style={inputStyle} value={confirm} placeholder={t?.slug} onChange={e => setConfirm(e.target.value)} />
  </BwModal>
}

// ── Report abuse ─────────────────────────────────────────────────────────────
function ReportModal({ data, onClose, onDone }: { data: TsOverview; onClose: () => void; onDone: (id: number) => void }) {
  const { success, error: showError } = useToast()
  const [f, setF] = useState({ tenant_id: String(data.all_scope ? '' : data.tenants[0]?.id ?? ''), title: '', category: data.options.categories[0], severity: 'Medium', source: '', evidence: '' })
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(p => ({ ...p, [k]: e.target.value }))
  const go = async () => {
    setBusy(true)
    try { const { data: c } = await platformApi.tsReport({ ...f, tenant_id: f.tenant_id ? Number(f.tenant_id) : null }); success(`${c.ref} opened`); onDone(c.id) }
    catch (e) { showError(errMsg(e, 'Unable to file the report')) } finally { setBusy(false) }
  }
  return <BwModal width={560} onClose={onClose} title="Report abuse" foot={<><Btn onClick={onClose}>Cancel</Btn>
    <Btn p disabled={busy || !f.title.trim() || !f.source.trim()} onClick={() => void go()}>{busy ? 'Reporting…' : 'Report'}</Btn></>}>
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Tenant"><select className={sel} style={inputStyle} value={f.tenant_id} onChange={set('tenant_id')}>
        {data.all_scope && <option value="">No specific tenant</option>}{data.tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field></div>
      <div className="sm:col-span-2"><Field label="Summary"><input className={inputCls} style={inputStyle} value={f.title} onChange={set('title')} maxLength={300} /></Field></div>
      <Field label="Category"><select className={sel} style={inputStyle} value={f.category} onChange={set('category')}>{data.options.categories.map(c => <option key={c}>{c}</option>)}</select></Field>
      <Field label="Severity"><select className={sel} style={inputStyle} value={f.severity} onChange={set('severity')}>{data.options.severities.map(s => <option key={s}>{s}</option>)}</select></Field>
      <div className="sm:col-span-2"><Field label="Source"><input className={inputCls} style={inputStyle} value={f.source} onChange={set('source')} maxLength={120} placeholder="e.g. Customer complaint, Automated scan, Law enforcement request" /></Field></div>
      <div className="sm:col-span-2"><Field label="Evidence (preserved with a hash lock)"><textarea className={`${inputCls} h-auto py-1`} style={inputStyle} rows={3} value={f.evidence} onChange={set('evidence')} /></Field></div>
    </div>
  </BwModal>
}

export default function PlatformTrustSafetyPage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<TsOverview | null>(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [users, setUsers] = useState<TsOverview['users'] | null>(null)
  const [drawer, setDrawer] = useState<number | null>(null)
  const [params, setParams] = useSearchParams()  // ?case=<id> opens a case (KPI drill-down links)
  useEffect(() => { const id = Number(params.get('case')); if (id) setDrawer(id) }, [params])
  const closeDrawer = () => { setDrawer(null); if (params.has('case')) setParams(p => { const n = new URLSearchParams(p); n.delete('case'); return n }) }
  const [term, setTerm] = useState<TsUser | null>(null)
  const [tenantModal, setTenantModal] = useState<{ tenantId: number | null; caseId: number | null } | null>(null)
  const [report, setReport] = useState(false)
  const [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    // The user list keeps its own search / page; the overview only seeds it on first load.
    try { const { data: next } = await platformApi.tsOverview(); setData(next); setUsers(u => u ?? next.users); setError('') }
    catch (err) { setError(errMsg(err, 'Trust & safety unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])
  const canManage = can('tenants', 'manage')
  const loadUsers = async (offset: number, query = q) => {
    try { const { data: u } = await platformApi.tsUsers(query, offset); setUsers(u) } catch (err) { showError(errMsg(err, 'Users unavailable')) }
  }
  useEffect(() => { if (!data) return; const t = setTimeout(() => void loadUsers(0, q), 350); return () => clearTimeout(t) }, [q])  // eslint-disable-line react-hooks/exhaustive-deps
  const page = <K extends 'cases' | 'history'>(key: K, fetcher: (o: number) => Promise<{ data: TsOverview[K] }>) => async (offset: number) => {
    try { const { data: p } = await fetcher(offset); setData(d => d && { ...d, [key]: p }) } catch (err) { showError(errMsg(err, 'Unable to load')) }
  }
  const userAct = async (u: TsUser, action: 'suspend' | 'reinstate' | 'restore') => {
    setBusy(`${u.tenant_id}:${u.id}`)
    try { await platformApi.tsUserAction(u.tenant_id, u.id, action); success(`${u.name} ${action === 'suspend' ? 'suspended – sessions revoked' : action === 'reinstate' ? 'reinstated' : 'restored'}`); await load(); await loadUsers(users?.offset ?? 0) }
    catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy('') }
  }
  const setPolicy = async (key: string, enabled: boolean) => {
    try { const { data: p } = await platformApi.tsSetPolicy(key, enabled); setData(d => d && { ...d, policies: p }) } catch (err) { showError(errMsg(err, 'Unable to change the policy')) }
  }
  const k = data?.kpis
  const refresh = () => { void load(); void loadUsers(users?.offset ?? 0) }

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2 flex flex-wrap items-end gap-2">
      <div className="flex-1"><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Governance</div><h1 className="text-xl font-semibold">Trust &amp; safety</h1></div>
      <Btn disabled={!data || !canManage} onClick={() => setReport(true)}>Report abuse</Btn>
      <Btn d disabled={!data || !canManage || !data.tenants.length} onClick={() => setTenantModal({ tenantId: null, caseId: null })}>Terminate a tenant…</Btn>
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}
    {!!users?.unreachable.length && <Note className="mb-2">Users of {users.unreachable.join(', ')} could not be read – their database is unreachable.</Note>}

    <Strip items={[
      { l: 'Open cases', kpi: 'trust.open_cases', v: k ? <span style={{ color: k.open ? C.ba : undefined }}>{k.open}</span> : '—' },
      { l: 'Critical', kpi: 'trust.critical', v: k ? <span style={{ color: k.critical ? C.ba : undefined }}>{k.critical}</span> : '—' },
      { l: 'Users terminated · 90d', kpi: 'trust.users_terminated', v: k ? k.users_terminated_90d : '—' },
      { l: 'Users suspended', kpi: 'trust.users_suspended', v: k?.users_suspended ?? '—' },
      { l: 'Tenants suspended', kpi: 'trust.tenants_suspended', v: k ? k.tenants_suspended : '—' },
      { l: 'Avg. resolution', kpi: 'trust.avg_resolution', v: k?.avg_resolution_days != null ? `${k.avg_resolution_days} days` : '—', d: k && k.avg_resolution_days == null ? 'no closed cases' : undefined },
    ]} />

    <div className="mb-2 grid gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Panel title="Abuse cases" flush>
        <Table head={['Case', 'Summary', 'Category', 'Severity', 'Status', 'Tenant', 'Source', 'Opened', { t: 'Evidence', r: true }]} minWidth={900}>
          {!data ? <EmptyRow cols={9}>{error || 'Loading…'}</EmptyRow> : !data.cases.items.length ? <EmptyRow cols={9}>No abuse cases. Use Report abuse to open one.</EmptyRow>
            : data.cases.items.map((c: TsCase) => <tr key={c.id} className="cursor-pointer" onClick={() => setDrawer(c.id)}>
              <td className="font-medium">{c.ref}</td><td className="max-w-[300px] truncate" title={c.title}>{c.title}</td><td>{c.category}</td>
              <td><Pill t={SEV_TONE[c.severity]}>{c.severity}</Pill></td><td><Pill t={STATUS_TONE[c.status]}>{c.status}</Pill></td>
              <td>{c.tenant ? <Pill t="ac">{c.tenant}</Pill> : '—'}</td><td>{c.source}</td><td>{fd(c.opened_at)}</td><td className="text-right tabular-nums">{c.evidence}</td>
            </tr>)}
        </Table>
        {data && <Pager page={data.cases} onPage={page('cases', o => platformApi.tsCases('all', o))} />}
      </Panel>
      <Panel title="Acceptable-use enforcement" flush>
        {!data ? <Empty>{error || 'Loading…'}</Empty> : <div>{data.policies.map(p =>
          <div key={p.key} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}
            title={[p.queues.length ? `When a ${p.category} case is reported: ${p.queues.join(', ')} is sent for approval${p.escalates ? '; the case is escalated to legal' : ''}` : '', p.unsupported ? `Not automated: ${p.unsupported}` : ''].filter(Boolean).join('\n')}>
            <Switch on={p.enabled} disabled={!canManage || !data.all_scope} onChange={v => void setPolicy(p.key, v)} />
            <span className="flex-1"><b>{p.name}</b><br /><small style={{ color: C.mu }}>{p.action}</small></span>
          </div>)}</div>}
      </Panel>
    </div>

    <Panel className="mb-2" title="Find and act on a user (all tenants)" flush
      act={<input className={`${inputCls} !w-56`} style={inputStyle} placeholder="Search name, email, tenant…" value={q} onChange={e => setQ(e.target.value)} />}>
      <Table head={['User', 'Email', 'Tenant', 'Role', 'MFA', 'Last active', 'Status', 'Action']} minWidth={980}>
        {!users ? <EmptyRow cols={8}>{error || 'Loading…'}</EmptyRow> : !users.items.length ? <EmptyRow cols={8}>{q ? 'No users match.' : 'No tenant users.'}</EmptyRow>
          : users.items.map(u => <tr key={`${u.tenant_id}:${u.id}`}>
            <td className="font-medium">{u.name}</td><td>{u.email}</td><td><Pill t="ac">{u.tenant}</Pill></td><td><Pill t="ac">{u.role}</Pill></td>
            <td>{u.mfa ? 'Yes' : 'No'}</td><td>{fd(u.last_active)}</td><td><Pill t={STATUS_TONE[u.status]}>{u.status}</Pill></td>
            <td className="whitespace-nowrap">{u.status === 'Terminated'
              ? <Btn s disabled={!canManage || !!busy} onClick={() => void userAct(u, 'restore')}>Restore</Btn>
              : <span className="inline-flex gap-1"><Btn s disabled={!canManage || !!busy} onClick={() => void userAct(u, u.status === 'Suspended' ? 'reinstate' : 'suspend')}>{u.status === 'Suspended' ? 'Reinstate' : 'Suspend'}</Btn>
                <Btn s d disabled={!canManage || !!busy} onClick={() => setTerm(u)}>Terminate…</Btn></span>}</td>
          </tr>)}
      </Table>
      {users && <Pager page={users} onPage={o => void loadUsers(o)} />}
    </Panel>

    <Panel title="Recent enforcement actions" flush>
      <Table head={['When', 'Action', 'Target', 'Reason', 'By']} minWidth={640}>
        {!data ? <EmptyRow cols={5}>{error || 'Loading…'}</EmptyRow> : !data.history.items.length ? <EmptyRow cols={5}>No enforcement actions yet.</EmptyRow>
          : data.history.items.map((h: TsHistory) => <tr key={h.id}><td>{fd(h.at)}</td><td>{h.action}</td><td>{h.target}</td><td>{h.reason ?? '—'}</td><td>{h.by}</td></tr>)}
      </Table>
      {data && <Pager page={data.history} onPage={page('history', o => platformApi.tsHistory(o))} />}
    </Panel>

    {drawer != null && <CaseDrawer id={drawer} canManage={canManage} onClose={closeDrawer} onChanged={() => void load()}
      onTenant={(tenantId, caseId) => { closeDrawer(); setTenantModal({ tenantId, caseId }) }} />}
    {term && data && <TerminateUserModal user={term} data={data} onClose={() => setTerm(null)} onDone={() => { setTerm(null); refresh() }} />}
    {tenantModal && data && <TenantModal data={data} tenantId={tenantModal.tenantId} caseId={tenantModal.caseId} onClose={() => setTenantModal(null)} onDone={() => { setTenantModal(null); refresh() }} />}
    {report && data && <ReportModal data={data} onClose={() => setReport(false)} onDone={id => { setReport(false); void load(); setDrawer(id) }} />}
  </div>
}
