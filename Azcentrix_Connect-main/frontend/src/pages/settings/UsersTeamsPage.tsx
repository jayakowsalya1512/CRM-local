// Users & Teams – prototype v17 R.users(): subnav Users · Teams & territories · Login history.
// Users = listPage('users'): crumb (company) · "Users" · N records · Import · + New user, views All · Invited · No MFA (with counts),
// role filter, grid User | Email | Role | Department | Reports to | MFA | Last active | Status, ⋯ row actions, bulk Deactivate / Sign out.
// Teams & territories = two panels (Team · Lead · Members, + Team) and (Territory · States / rule · Owner · Accounts, + Territory).
// Login history = grid User | Time | IP address | Device | Result (server paginated from login_logs).
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import FieldError from '@/components/form/FieldError'
import { useModalValidation } from '@/components/form/useModalValidation'
import { apiFieldErrors, validate } from '@/utils/validation'
import { Av, Panel, Pill, Tbl } from '@/pages/customers/kit'
import { admin360Api, errMsg, fd, fdt, type LoginRow, type Team, type Territory, type UserDetail, type UserRow, type UsersMeta, type UsersQuery } from './admin360Api'
import '@/pages/leads/leads.css'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './appSettings.css'
import './admin360.css'

const TABS = ['Users', 'Teams & territories', 'Login history'] as const
type Tab = typeof TABS[number]
const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}
const statusTone = (s: string) => (s === 'Active' ? 'ok' : s === 'Invited' ? 'wa' : 'mu')

export default function UsersTeamsPage() {
  const [sp, setSp] = useSearchParams()
  const tab: Tab = (TABS as readonly string[]).includes(sp.get('tab') || '') ? (sp.get('tab') as Tab) : 'Users'
  const setTab = (t: Tab) => setSp(s => { const n = new URLSearchParams(s); n.set('tab', t); return n })
  return (
    <div className="bwi">
      <div className="snav" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}</div>
      {tab === 'Users' && <UsersTab />}
      {tab === 'Teams & territories' && <TeamsTab />}
      {tab === 'Login history' && <LoginHistoryTab />}
    </div>
  )
}

/* ───────────── Users (listPage) ───────────── */
function UsersTab() {
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const [sp, setSp] = useSearchParams()
  const open = Number(sp.get('open') || 0) || null
  const setOpen = (id: number | null) => setSp(s => { const n = new URLSearchParams(s); if (id) n.set('open', String(id)); else n.delete('open'); return n })
  const [meta, setMeta] = useState<UsersMeta | null>(null)
  const [view, setView] = useState<string>(() => store.get('users:view', 'All'))
  const [role, setRole] = useState('')
  const [p, setP] = useState<Omit<UsersQuery, 'view' | 'role' | 'q' | 'f'>>({ adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 25 })
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [data, setData] = useState<{ items: UserRow[]; total: number; total_all: number; counts: Record<string, number>; loading: boolean }>({ items: [], total: 0, total_all: 0, counts: {}, loading: true })
  const [rev, setRev] = useState(0)
  const [confirm, setConfirm] = useState<{ title: string; body: string; ok: string; danger?: boolean; fn: () => Promise<void> } | null>(null)

  useEffect(() => { admin360Api.usersMeta().then(m => { setMeta(m); setView(v => m.views.includes(v) ? v : 'All') }).catch(e => error(errMsg(e, 'Could not load Users'))) }, [error])
  useEffect(() => { store.set('users:view', view) }, [view])
  const key = JSON.stringify([view, role, p, qf, rev])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const t = setTimeout(() => {
      admin360Api.users({ view, role, q: qf.q, f: qf.f, ...p }).then(r => { if (live) setData({ ...r, loading: false }) })
        .catch(e => { if (live) { setData(d => ({ ...d, loading: false })); error(errMsg(e, 'Could not load users')) } })
    }, 120)
    return () => { live = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const changed = useCallback(() => setRev(r => r + 1), [])
  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][]; adv: UsersQuery['adv'] }) => setP({ offset: s.offset, limit: s.limit, sorts: s.sorts, adv: s.adv }), [])
  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => { setQf(s); setP(x => ({ ...x, offset: 0 })) }, [])
  const can = meta?.can.manage

  const cols = useMemo<GridCol<UserRow>[]>(() => [
    { k: 'name', t: 'User', w: 220, fn: r => <span className="ucell"><Av name={r.name} /><a onClick={e => { e.stopPropagation(); setOpen(r.id) }}>{r.name}</a></span>, txt: r => r.name },
    { k: 'email', t: 'Email', w: 220 },
    { k: 'role', t: 'Role', w: 140, fn: r => <Pill s={r.role_label} t="ac" />, txt: r => r.role_label },
    { k: 'dept', t: 'Department', w: 140 },
    { k: 'mgr', t: 'Reports to', w: 160 },
    { k: 'mfa', t: 'MFA', w: 70, fn: r => r.mfa ? <span className="tok">✓</span> : <span className="tbad">✕</span>, txt: r => (r.mfa ? 'Yes' : 'No') },
    { k: 'last', t: 'Last active', w: 130, date: true, fn: r => fd(r.last), txt: r => r.last || '' },
    { k: 'status', t: 'Status', w: 100, fn: r => <Pill s={r.status} t={statusTone(r.status)} />, txt: r => r.status },
  ], [])    // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (label: string, fn: () => Promise<unknown>) => { try { await fn(); changed(); success(label) } catch (e) { error(errMsg(e)) } }
  const menu = (r: UserRow): GridMenuItem[] => can ? [
    { l: 'Open', i: <Ic n="eye" />, fn: () => setOpen(r.id) },
    { l: 'Edit', i: <Ic n="edit" />, fn: () => navigate(`/users/${r.id}/edit`) },
    { l: 'Send password reset link', i: <Ic n="mail" />, fn: () => act(`Reset link sent to ${r.email}`, () => admin360Api.sendResetLink(r.id)) },
    { l: 'Sign out everywhere', i: <Ic n="out" />, fn: () => act(`${r.name} signed out`, () => admin360Api.logoutUsers([r.id])) },
    r.is_active
      ? { l: 'Deactivate', i: <Ic n="x" />, danger: true, fn: () => setConfirm({ title: 'Deactivate user', body: `${r.name} will no longer be able to sign in. Their records stay assigned.`, ok: 'Deactivate', danger: true, fn: async () => { setConfirm(null); await act(`${r.name} deactivated`, () => admin360Api.setActive(r.id, false)) } }) }
      : { l: 'Activate', i: <Ic n="check" />, fn: () => act(`${r.name} activated`, () => admin360Api.setActive(r.id, true)) },
  ] : [{ l: 'View', i: <Ic n="eye" />, fn: () => setOpen(r.id) }]
  const bulk: [string, (rows: UserRow[]) => void][] = can ? [
    ['Sign out', rows => act(`${rows.length} signed out`, () => admin360Api.logoutUsers(rows.map(r => r.id)))],
    ['Deactivate', rows => setConfirm({ title: 'Deactivate users', body: `${rows.length} user${rows.length === 1 ? '' : 's'} will no longer be able to sign in.`, ok: `Deactivate ${rows.length}`, danger: true,
      fn: async () => { setConfirm(null); const failed: string[] = []; for (const r of rows) { try { await admin360Api.setActive(r.id, false) } catch (e) { failed.push(errMsg(e)) } } changed(); failed.length ? warning(`${rows.length - failed.length} deactivated`, failed[0]) : success(`${rows.length} deactivated`) } })],
  ] : []
  const tools = <select className="in sm" style={{ width: 140 }} value={role} aria-label="Role" onChange={e => { setRole(e.target.value); setP(x => ({ ...x, offset: 0 })) }}>
    <option value="">All</option>{(meta?.roles || []).map(r => <option key={r.name} value={r.name}>{r.label}</option>)}</select>

  return <>
    <div className="pg">
      <div><div className="crumb">{meta?.company || 'Workspace'}</div><h1>Users</h1></div>
      <span className="cnt">{data.total_all} records</span>
      <span className="fl" />
      {can &&<button type="button" className="btn p" onClick={() => navigate('/users/new')}><Ic n="plus" /> New user</button>}
    </div>
    <div className="row wrap mb" style={{ gap: 6 }}>
      {(meta?.views || ['All']).map(v => <span key={v} role="button" tabIndex={0} className={`chip ${view === v ? 'on' : ''}`} onClick={() => { setView(v); setP(x => ({ ...x, offset: 0 })) }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(v) } }}>{v} <small style={{ color: 'inherit', opacity: .7 }}>{data.counts[v] ?? ''}</small></span>)}
    </div>
    <div className="panel" aria-busy={data.loading}>
      <BwGrid id="users-v17" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => setOpen(r.id)} bulk={bulk} tools={tools} menu={menu}
        server={{ total: data.total, onChange: onServer }} onQuery={onQuery} empty={data.loading ? 'Loading…' : 'No users match the current filters.'} />
    </div>
    {confirm && <Modal title={confirm.title} width={440} onClose={() => setConfirm(null)}
      foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button><button type="button" className={`btn ${confirm.danger ? 'd' : 'p'}`} onClick={confirm.fn}>{confirm.ok}</button></>}>
      <p style={{ margin: 0 }}>{confirm.body}</p></Modal>}
    {open && <UserDrawer id={open} onClose={() => setOpen(null)} onChanged={changed} />}
  </>
}

/* ───────────── User record drawer (prototype openRec('users')): Overview · Activity · Documents · Notes ───────────── */
const DTABS = ['Overview', 'Activity', 'Documents', 'Notes'] as const
type DTab = typeof DTABS[number]
function UserDrawer({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const { success, error } = useToast()
  const [d, setD] = useState<UserDetail | null>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<DTab>('Overview')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => { setErr(''); admin360Api.user(id).then(setD).catch(e => { setD(null); setErr(errMsg(e, 'Could not open this user')) }) }, [id])
  useEffect(() => { setD(null); setTab('Overview'); load() }, [load])
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [onClose])
  const host = document.querySelector('.crm-shell') ?? document.body
  const kv = (rows: [string, ReactNode][]) => <div className="kv">{rows.map(([l, v]) => <div key={l}><span>{l}</span><span>{v}</span></div>)}</div>
  const toggle = async () => { if (!d) return; setBusy(true); try { await admin360Api.setActive(d.id, !d.is_active); success(d.is_active ? `${d.name} deactivated` : `${d.name} activated`); load(); onChanged() } catch (e) { error(errMsg(e)) } finally { setBusy(false) } }
  const NOTE_SPEC = { label: 'Note', rule: 'textarea' as const, max: 2000 }
  const [noteErr, setNoteErr] = useState('')
  const addNote = async () => {
    if (!d || !note.trim()) return
    const m = validate(note, NOTE_SPEC); setNoteErr(m)
    if (m) { document.getElementById('ud-note')?.focus(); return }
    setBusy(true); try { await admin360Api.addUserNote(d.id, note.trim()); setNote(''); load() } catch (e) { const m = apiFieldErrors(e).text; if (m) setNoteErr(m); else error(errMsg(e)) } finally { setBusy(false) }
  }
  return createPortal(<div className="bwi">
    <div className="bwi-dwo" onMouseDown={onClose} />
    <aside className="bwi-dw" role="dialog" aria-modal="true" aria-label={d?.name || 'User'}>
      <div className="dh">
        <div className="fl"><h2>{d?.name || (err ? 'User' : 'Loading…')}</h2>
          {d && <div className="sub"><span className="mono">U-{d.id}</span> · <Pill s={d.role_label} t="ac" /> · <Pill s={d.status} t={statusTone(d.status)} /></div>}</div>
        {d && d.can.manage && <button type="button" className="btn s" onClick={() => navigate(`/users/${d.id}/edit`)}><Ic n="edit" /> Edit</button>}
        {d && d.can.manage && <button type="button" className={`btn s ${d.is_active ? 'd' : ''}`} disabled={busy} onClick={toggle}>{d.is_active ? 'Deactivate' : 'Activate'}</button>}
        <button type="button" className="btn g ib" onClick={onClose} aria-label="Close"><Ic n="x" /></button>
      </div>
      <div className="tabs" role="tablist">{DTABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}{t === 'Notes' && d?.notes.length ? <small>{d.notes.length}</small> : null}</div>)}</div>
      <div className="db">
        {err ? <div className="dcard empty">{err} · <a onClick={load}>Retry</a></div> : !d ? <div className="empty">Loading…</div>
          : tab === 'Overview' ? <div className="dcard">{kv([['Name', d.name], ['Email', d.email], ['Username', d.username], ['Role', d.role_label], ['Dept', d.dept || '—'], ['Designation', d.designation || '—'],
            ['Mgr', d.mgr || '—'], ['Mfa', d.mfa ? 'Yes' : 'No'], ['Last', d.last ? fdt(d.last) : '—'], ['Status', d.status], ['Phone', d.phone || '—'], ['Branch', d.branch || '—'], ['Employee code', d.employee_code || '—'], ['Created', fd(d.created)]])}</div>
            : tab === 'Activity' ? <div className="dcard"><div className="tl">
              {d.activity.map((a, i) => <div key={`a${i}`}><b>{a.t}</b><br /><small>{a.by} · {a.d ? fdt(a.d) : ''}</small></div>)}
              {d.logins.map((l, i) => <div key={`l${i}`}><b>{l.r === 'Success' ? 'Signed in' : 'Failed sign-in'} · {l.d}</b><br /><small>{l.ip} · {l.t ? fdt(l.t) : ''}</small></div>)}
              <div><b>Record created</b><br /><small>System · {fd(d.created)}</small></div></div></div>
              : tab === 'Documents' ? <div className="dcard"><div className="empty">No documents linked yet</div>
                <button type="button" className="btn mt" onClick={() => navigate('/document-management')}><Ic n="up" /> Upload document</button></div>
                : <div className="dcard"><div className="list bx">{d.notes.length ? d.notes.map(n => <div key={n.id}><span className="fl">{n.t}</span><small>{n.by} · {n.d ? fd(n.d) : ''}</small></div>) : <div className="mu">No notes yet</div>}</div>
                  <textarea id="ud-note" className={`in mt ${noteErr ? 'err' : ''}`} rows={3} placeholder="Add a note, @mention a teammate…" value={note} aria-invalid={noteErr ? true : undefined}
                    onChange={e => { setNote(e.target.value); setNoteErr(validate(e.target.value, NOTE_SPEC)) }} /><FieldError id="ud-note" msg={noteErr} />
                  <button type="button" className="btn p mt" disabled={busy || !note.trim()} onClick={addNote}>Add note</button></div>}
      </div>
    </aside>
  </div>, host)
}

/* ───────────── Teams & territories ───────────── */
function TeamsTab() {
  const { success, error } = useToast()
  const [teams, setTeams] = useState<Team[] | null>(null)
  const [terr, setTerr] = useState<Territory[] | null>(null)
  const [meta, setMeta] = useState<UsersMeta | null>(null)
  const [people, setPeople] = useState<UserRow[]>([])
  const [states, setStates] = useState<string[]>([])
  const [teamM, setTeamM] = useState(false)
  const [terrM, setTerrM] = useState<Territory | 'new' | null>(null)
  const [del, setDel] = useState<Territory | null>(null)
  const load = useCallback(() => {
    admin360Api.teams().then(setTeams).catch(e => error(errMsg(e, 'Could not load teams')))
    admin360Api.territories().then(setTerr).catch(e => error(errMsg(e, 'Could not load territories')))
  }, [error])
  useEffect(() => {
    load()
    admin360Api.usersMeta().then(setMeta).catch(() => undefined)
    admin360Api.users({ view: 'All', role: '', q: '', f: {}, adv: { logic: 'AND', conds: [] }, sorts: [['name', 1]], offset: 0, limit: 250 }).then(r => setPeople(r.items.filter(u => u.is_active))).catch(() => undefined)
    admin360Api.states().then(s => setStates(s.map(x => x.name))).catch(() => undefined)
  }, [load])
  const can = !!meta?.can.manage
  return <>
    <div className="g g2">
      <Panel title="Teams" z act={can ? <button type="button" className="btn s" onClick={() => setTeamM(true)}><Ic n="plus" /> Team</button> : undefined}>
        {teams === null ? <div className="empty">Loading…</div> : <Tbl<Team> cols={[
          { k: 'n', t: 'Team', fn: t => <b>{t.n}</b> }, { k: 'l', t: 'Lead', fn: t => t.l ? <span className="ucell"><Av name={t.l} />{t.l}</span> : <span className="mu">—</span> }, { k: 'm', t: 'Members', r: true },
        ]} rows={teams} empty="No teams yet. Create one to group users for sharing and reporting." />}
      </Panel>
      <Panel title="Territories" z act={can ? <button type="button" className="btn s" onClick={() => setTerrM('new')}><Ic n="plus" /> Territory</button> : undefined}>
        {terr === null ? <div className="empty">Loading…</div> : <Tbl<Territory> cols={[
          { k: 't', t: 'Territory', fn: t => <b>{t.t}</b> }, { k: 's', t: 'States / rule', wr: true }, { k: 'o', t: 'Owner', fn: t => t.o ? <span className="ucell"><Av name={t.o} />{t.o}</span> : <span className="mu">—</span> },
          { k: 'a', t: 'Accounts', r: true },
          { k: 'x', t: '', fn: t => can ? <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}><button type="button" className="btn s g" aria-label="Edit" onClick={e => { e.stopPropagation(); setTerrM(t) }}><Ic n="edit" /></button>
            <button type="button" className="btn s g" aria-label="Delete" onClick={e => { e.stopPropagation(); setDel(t) }}><Ic n="trash" /></button></span> : null },
        ]} rows={terr} empty="No territories yet. Territories route leads and group accounts by state or rule." />}
      </Panel>
    </div>
    {teamM && <TeamModal people={people} onClose={() => setTeamM(false)} onDone={() => { setTeamM(false); load(); success('Team created') }} />}
    {terrM && <TerritoryModal t={terrM === 'new' ? null : terrM} people={people} states={states} onClose={() => setTerrM(null)} onDone={() => { setTerrM(null); load(); success(terrM === 'new' ? 'Territory created' : 'Territory updated') }} />}
    {del && <Modal title="Remove territory" width={420} onClose={() => setDel(null)} foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
      <button type="button" className="btn d" onClick={async () => { try { await admin360Api.deleteTerritory(del.id); setDel(null); load(); success('Territory removed') } catch (e) { error(errMsg(e)) } }}>Remove</button></>}>
      <p style={{ margin: 0 }}>Remove <b>{del.t}</b>? Accounts are not changed.</p></Modal>}
  </>
}

function TeamModal({ people, onClose, onDone }: { people: UserRow[]; onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const [name, setName] = useState(''); const [lead, setLead] = useState(''); const [desc, setDesc] = useState('')
  const vals = { name, lead, desc }
  const v = useModalValidation(vals, () => ({
    name: { label: 'Team name', rule: 'name', required: true, min: 2, max: 100 },
    desc: { label: 'Description', rule: 'text', max: 500 },
  }), () => ({}), { name: 'tm-name', lead: 'tm-lead', desc: 'tm-desc' })
  const save = async () => {
    if (!v.submit()) return
    try { await admin360Api.createTeam({ name: name.trim(), manager_id: lead ? Number(lead) : null, description: desc.trim() }); onDone() }
    catch (e) { if (!v.server(e, { manager_id: 'lead', description: 'desc' })) error(errMsg(e)) }
  }
  return <Modal title="New team" width={460} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={save}>Create team</button></>}>
    <div className="fg"><div className="f1"><label>Team name</label><input id="tm-name" className={`in ${v.bad('name') ? 'err' : ''}`} value={name} {...v.aria('name')} onChange={e => { setName(e.target.value); v.change({ ...vals, name: e.target.value }, 'name') }} autoFocus /><FieldError id="tm-name" msg={v.errors.name} /></div>
      <div className="f1"><label>Team lead</label><select id="tm-lead" className={`in ${v.bad('lead') ? 'err' : ''}`} value={lead} onChange={e => { setLead(e.target.value); v.change({ ...vals, lead: e.target.value }, 'lead') }}><option value="">— none —</option>{people.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select><FieldError id="tm-lead" msg={v.errors.lead} /></div>
      <div className="f1"><label>Description</label><input id="tm-desc" className={`in ${v.bad('desc') ? 'err' : ''}`} value={desc} {...v.aria('desc')} onChange={e => { setDesc(e.target.value); v.change({ ...vals, desc: e.target.value }, 'desc') }} /><FieldError id="tm-desc" msg={v.errors.desc} /></div></div>
  </Modal>
}

function TerritoryModal({ t, people, states, onClose, onDone }: { t: Territory | null; people: UserRow[]; states: string[]; onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const [name, setName] = useState(t?.t || ''); const [sel, setSel] = useState<string[]>(t?.states || []); const [rule, setRule] = useState(t?.rule || ''); const [owner, setOwner] = useState(t?.owner_id ? String(t.owner_id) : '')
  const opts = useMemo(() => Array.from(new Set([...states, ...sel])), [states, sel])
  const vals = { name, rule, owner }
  const v = useModalValidation(vals, () => ({
    name: { label: 'Territory name', rule: 'name', required: true, min: 2, max: 100 },
    rule: { label: 'Rule', rule: 'text', max: 200 },
  }), () => ({}), { name: 'tr-name', rule: 'tr-rule', owner: 'tr-owner' })
  const save = async () => {
    if (!v.submit()) return
    try { await admin360Api.saveTerritory({ name: name.trim(), states: sel, rule: rule.trim(), owner_id: owner ? Number(owner) : null }, t?.id); onDone() }
    catch (e) { if (!v.server(e, { owner_id: 'owner' })) error(errMsg(e)) }
  }
  return <Modal title={t ? 'Edit territory' : 'New territory'} width={520} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={save}>{t ? 'Save' : 'Create territory'}</button></>}>
    <div className="fg"><div><label>Territory name</label><input id="tr-name" className={`in ${v.bad('name') ? 'err' : ''}`} value={name} {...v.aria('name')} onChange={e => { setName(e.target.value); v.change({ ...vals, name: e.target.value }, 'name') }} autoFocus /><FieldError id="tr-name" msg={v.errors.name} /></div>
      <div><label>Owner</label><select id="tr-owner" className={`in ${v.bad('owner') ? 'err' : ''}`} value={owner} onChange={e => { setOwner(e.target.value); v.change({ ...vals, owner: e.target.value }, 'owner') }}><option value="">— none —</option>{people.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select><FieldError id="tr-owner" msg={v.errors.owner} /></div>
      <div className="f1"><label>States</label><div className="row wrap" style={{ gap: 5 }}>{opts.map(s => <span key={s} role="button" tabIndex={0} className={`chip ${sel.includes(s) ? 'on' : ''}`}
        onClick={() => setSel(x => x.includes(s) ? x.filter(y => y !== s) : [...x, s])} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(x => x.includes(s) ? x.filter(y => y !== s) : [...x, s]) } }}>{s}</span>)}
        {!opts.length && <small className="mu">No states in Masters yet – add them under Directory → Masters, or describe a rule below.</small>}</div></div>
      <div className="f1"><label>Rule (optional, used when not state based)</label><input id="tr-rule" className={`in ${v.bad('rule') ? 'err' : ''}`} placeholder="e.g. Account tier A (any state)" value={rule} {...v.aria('rule')} onChange={e => { setRule(e.target.value); v.change({ ...vals, rule: e.target.value }, 'rule') }} /><FieldError id="tr-rule" msg={v.errors.rule} /></div></div>
  </Modal>
}

/* ───────────── Login history ───────────── */
function LoginHistoryTab() {
  const { error } = useToast()
  const [q, setQ] = useState(''); const [result, setResult] = useState('')
  const [page, setPage] = useState({ offset: 0, limit: 50 })
  const [data, setData] = useState<{ items: LoginRow[]; total: number; loading: boolean }>({ items: [], total: 0, loading: true })
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const t = setTimeout(() => admin360Api.loginHistory({ q, result, ...page }).then(r => { if (live) setData({ ...r, loading: false }) }).catch(e => { if (live) { setData(d => ({ ...d, loading: false })); error(errMsg(e, 'Could not load login history')) } }), 120)
    return () => { live = false; clearTimeout(t) }
  }, [q, result, page, error])
  const pages = Math.max(1, Math.ceil(data.total / page.limit)), cur = Math.floor(page.offset / page.limit) + 1
  return <div className="panel" aria-busy={data.loading}>
    <div className="row" style={{ padding: 8, gap: 8, borderBottom: '1px solid var(--bw-ln)' }}>
      <div className="sr2"><Ic n="search" /><input className="in" placeholder="Search user or IP…" value={q} onChange={e => { setQ(e.target.value); setPage(p => ({ ...p, offset: 0 })) }} /></div>
      <select className="in sm" style={{ width: 120 }} value={result} aria-label="Result" onChange={e => { setResult(e.target.value); setPage(p => ({ ...p, offset: 0 })) }}><option value="">All results</option><option>Success</option><option>Failed</option></select>
      <span className="fl" /><small className="mu">{data.total} sign-ins</small>
    </div>
    <div className="tw"><Tbl<LoginRow> cols={[
      { k: 'u', t: 'User', fn: r => <span className="ucell"><Av name={r.u} />{r.u}</span> }, { k: 't', t: 'Time', fn: r => fdt(r.t) }, { k: 'ip', t: 'IP address', fn: r => <span className="mono">{r.ip || '—'}</span> },
      { k: 'd', t: 'Device' }, { k: 'r', t: 'Result', fn: r => <span title={r.reason}><Pill s={r.r} t={r.r === 'Success' ? 'ok' : 'ba'} /></span> },
    ]} rows={data.items} empty={data.loading ? 'Loading…' : 'No sign-ins recorded yet.'} /></div>
    <div className="pgn"><span className="fl">Page {cur} of {pages}</span>
      <button type="button" className="btn s" disabled={page.offset === 0} onClick={() => setPage(p => ({ ...p, offset: Math.max(0, p.offset - p.limit) }))}>‹ Prev</button>
      <button type="button" className="btn s" disabled={page.offset + page.limit >= data.total} onClick={() => setPage(p => ({ ...p, offset: p.offset + p.limit }))}>Next ›</button></div>
  </div>
}
