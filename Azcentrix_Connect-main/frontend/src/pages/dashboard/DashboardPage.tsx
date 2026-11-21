import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ComponentType } from 'react'
import { useSearchParams } from 'react-router-dom'
import { usePermissions } from '@/hooks'
import { useThemeStore } from '@/store'
import { useToast } from '@/components/ui/ToastContext'
import api from '@/services/api'
import { Btn, BwModal, C, Empty, PageHead, copyText, inputCls, inputStyle } from '@/components/platform/bw'
import { Ic } from '@/components/crm/kit'
import { PERIODS, PERM, layoutsApi, type Layout, type LayoutWidget, type Period } from './v9/data'
import { DrillDrawer, DrillProvider, LoadingBox, Sec, type DrillSpec } from './v9/ui'
import { CLONE_WIDGETS, NEW_WIDGETS, WID } from './v9/widgets'
import WelcomeCard from './v9/WelcomeCard'
import { AnnouncementBanner } from '@/components/announcements/AnnouncementsFooter'
import './v9/dashboards.css'

// Dashboards — Bidwise CRM Prototype v9 (CRM application › Dashboards).
// Eight predefined dashboards (protected: they can be saved as a copy, never edited or deleted) plus custom dashboards
// stored per tenant in MariaDB (dashboard_layouts). Every number is live and permission / data-visibility scoped.
const Overview = lazy(() => import('./v9/boards/Overview'))
const Leads = lazy(() => import('./v9/boards/Leads'))
const Deals = lazy(() => import('./v9/boards/Deals'))
const Bids = lazy(() => import('./v9/boards/Bids'))
const FunnelBoard = lazy(() => import('./v9/boards/Funnel'))
const Commitments = lazy(() => import('./v9/boards/Commitments'))
const Kam = lazy(() => import('./v9/boards/Kam'))
const Orders = lazy(() => import('./v9/boards/Orders'))
const Finance = lazy(() => import('./v9/boards/Finance'))
const Login = lazy(() => import('./v9/boards/Login'))

type BoardProps = { period: Period; nonce: number }
const SYS: { key: string; name: string; icon: string; perm: string; C: ComponentType<BoardProps> }[] = [
  { key: 'overview', name: 'Overview', icon: 'home', perm: PERM.base, C: Overview },
  { key: 'leads', name: 'Leads', icon: 'funnel', perm: PERM.leads, C: Leads },
  { key: 'deals', name: 'Deals', icon: 'target', perm: PERM.deals, C: Deals },
  { key: 'bids', name: 'Bids & Tenders', icon: 'file', perm: PERM.tenders, C: Bids },
  // prototype v17 DSYS.splice(4, 0, Funnel): leads → deals → bids & quotes → won → orders (rows limited by each module's permissions)
  { key: 'funnel', name: 'Funnel', icon: 'funnel', perm: PERM.base, C: FunnelBoard },
  // prototype v18 DSYS.splice(5, 0, Commitments) – the management view of Field Sales 360 → Commitments (needs kam.view)
  { key: 'commitments', name: 'Commitments', icon: 'target', perm: PERM.base, C: Commitments },
  { key: 'kam', name: 'KAM performance', icon: 'users', perm: PERM.kam, C: Kam },
  { key: 'orders', name: 'Orders & delivery', icon: 'brief', perm: PERM.orders, C: Orders },
  { key: 'finance', name: 'Finance', icon: 'card', perm: PERM.finance, C: Finance },
  { key: 'login', name: 'Login tracker', icon: 'lock', perm: PERM.login, C: Login },
]
// Older links (?tab=tenders, ?tab=kam360 …) land on the matching dashboard.
const ALIAS: Record<string, string> = { tenders: 'bids', tender: 'bids', kam360: 'kam', 'kam-360': 'kam', login_tracker: 'login', 'login-tracker': 'login', emdbg: 'finance', opportunities: 'deals', workorders: 'orders' }

type Dialog = null | 'add' | 'rename' | 'delete' | 'share'
type ShareState = Layout['share']

export default function DashboardPage() {
  const { can } = usePermissions()
  const { success, error: showError } = useToast()
  const company = useThemeStore(s => s.theme.company_name) || 'Azcentrix'
  const [params, setParams] = useSearchParams()
  const [layouts, setLayouts] = useState<Layout[] | null>(null)
  const [period, setPeriod] = useState<Period>('FY')
  const [editing, setEditing] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [renameTo, setRenameTo] = useState('')
  const [share, setShare] = useState<ShareState>({ scope: 'private', user_ids: [], roles: [] })
  const [drill, setDrill] = useState<DrillSpec | null>(null)
  const nonce = 0
  // Consolidated (parent-group) views come from the tenant hierarchy, which the CRM application doesn't expose yet.
  const isGroupView = false

  const loadLayouts = useCallback(() => layoutsApi.list().then(setLayouts).catch(() => setLayouts([])), [])
  useEffect(() => { loadLayouts() }, [loadLayouts])

  const visibleSys = useMemo(() => SYS.filter(d => can(d.perm)), [can])
  const dashParam = Number(params.get('dash')) || null
  const tabParam = (() => { const t = String(params.get('tab') || params.get('module') || '').toLowerCase(); return ALIAS[t] || t })()
  const cur = dashParam ? layouts?.find(d => d.id === dashParam) ?? null : null
  const sys = cur ? null : visibleSys.find(d => d.key === tabParam) ?? visibleSys[0] ?? null
  const title = cur ? cur.name : sys?.name ?? 'Dashboard'
  const canEdit = !!cur?.mine

  const select = (next: { tab?: string; dash?: number }, replace = false) => {
    const p = new URLSearchParams(params)
    p.delete('tab'); p.delete('module'); p.delete('view'); p.delete('dash')
    if (next.dash) p.set('dash', String(next.dash))
    else if (next.tab && next.tab !== 'overview') p.set('tab', next.tab)
    setParams(p, { replace })
    setEditing(false)
  }
  // A link to a dashboard that was deleted or isn't shared with this user falls back to Overview.
  useEffect(() => { if (dashParam && layouts && !cur) { showError('That dashboard is not available to you'); select({ tab: 'overview' }, true) } }, [dashParam, layouts, cur]) // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (e: any, msg: string) => showError(e?.response?.data?.detail || msg)
  const replaceLayout = (l: Layout) => setLayouts(L => (L ?? []).map(x => (x.id === l.id ? l : x)))
  // Widget edits apply immediately and are saved in the background; a failed save reloads the stored layout.
  const saveWidgets = (w: LayoutWidget[]) => {
    if (!cur) return
    replaceLayout({ ...cur, widgets: w })
    layoutsApi.update(cur.id, { widgets: w }).then(replaceLayout).catch(e => { fail(e, 'Could not save the layout'); loadLayouts() })
  }
  const createLayout = async (name: string, widgets: LayoutWidget[], toast?: string) => {
    try {
      const l = await layoutsApi.create(name, widgets)
      setLayouts(L => [...(L ?? []), l])
      select({ dash: l.id }); setEditing(true)
      if (toast) success(toast)
    } catch (e) { fail(e, 'Could not create the dashboard') }
  }
  const saveAsMine = () => createLayout(`My ${(sys?.name ?? 'dashboard').toLowerCase()}`, CLONE_WIDGETS, 'Saved – add or remove widgets to make it yours')
  const newDashboard = () => createLayout('New dashboard', NEW_WIDGETS)
  const rename = async () => {
    if (!cur) return
    try { replaceLayout(await layoutsApi.update(cur.id, { name: renameTo.trim() || 'Dashboard' })); setDialog(null) } catch (e) { fail(e, 'Could not rename the dashboard') }
  }
  const removeCur = async () => {
    if (!cur) return
    try {
      await layoutsApi.remove(cur.id)
      setLayouts(L => (L ?? []).filter(d => d.id !== cur.id))
      setDialog(null); select({ tab: 'overview' })
      success(`Dashboard "${cur.name}" deleted`)
    } catch (e) { fail(e, 'Could not delete the dashboard') }
  }
  const copyLink = async () => (await copyText(window.location.href)) ? success('Dashboard link copied') : showError('Could not copy the link')
  const saveShare = async () => {
    if (!cur) return
    try { replaceLayout(await layoutsApi.share(cur.id, share)); setDialog(null); await copyLink() } catch (e) { fail(e, 'Could not update sharing') }
  }
  const moveWidget = (i: number, d: number) => { if (!cur) return; const w = [...cur.widgets], j = i + d; if (j < 0 || j >= w.length) return; [w[i], w[j]] = [w[j], w[i]]; saveWidgets(w) }
  const sizeWidget = (i: number) => cur && saveWidgets(cur.widgets.map((w, k) => (k === i ? { ...w, s: ((w.s % 3) + 1) as 1 | 2 | 3 } : w)))
  const removeWidget = (i: number) => cur && saveWidgets(cur.widgets.filter((_, k) => k !== i))
  const addWidget = (id: string) => { if (cur) saveWidgets([...cur.widgets, { id, s: WID[id].s }]); setDialog(null) }

  const Board = sys?.C
  return <DrillProvider value={setDrill}>
    <div className="bwd">
      {/* prototype v17 dashHero(): greeting + announcement banner above the page header, on every dashboard */}
      <WelcomeCard nonce={nonce} />
      <AnnouncementBanner />
      <div className="bwd-head">
        <PageHead crumb={<>{company}{isGroupView ? ' · consolidated' : ''}</>} title={title}>
          <select className="bwd-per" aria-label="Period" value={period} onChange={e => setPeriod(e.target.value as Period)}>
            {PERIODS.map(p => <option key={p.v} value={p.v}>{p.l}</option>)}
          </select>
          {cur ? (canEdit ? (editing ? <>
            <Btn onClick={() => setDialog('add')}><Ic n="plus" size={14} /> Add widget</Btn>
            <Btn onClick={() => { setRenameTo(cur.name); setDialog('rename') }}>Rename</Btn>
            <Btn d onClick={() => setDialog('delete')}>Delete</Btn>
            <Btn p onClick={() => setEditing(false)}>Done</Btn>
          </> : <Btn onClick={() => setEditing(true)}><Ic n="layout" size={14} /> Customise</Btn>)
            : <Btn onClick={() => createLayout(`${cur.name} (copy)`, cur.widgets, 'Saved a copy you can customise')}><Ic n="copy" size={14} /> Save as my dashboard</Btn>)
            : <Btn onClick={saveAsMine} disabled={!sys}><Ic n="copy" size={14} /> Save as my dashboard</Btn>}
          <Btn onClick={() => { if (cur?.mine) setShare(cur.share); setDialog('share') }}><Ic n="share" size={14} /> Share</Btn>
        </PageHead>
      </div>

      <div className="bwd-tabs" role="tablist">
        {visibleSys.map(d => <button key={d.key} type="button" role="tab" aria-selected={!cur && sys?.key === d.key} className={`bw-tab ${!cur && sys?.key === d.key ? 'on' : ''}`} onClick={() => select({ tab: d.key })}>
          <Ic n={d.icon} size={14} />{d.name}
        </button>)}
        {(layouts ?? []).map(d => <button key={d.id} type="button" role="tab" aria-selected={cur?.id === d.id} className={`bw-tab ${cur?.id === d.id ? 'on' : ''}`} onClick={() => select({ dash: d.id })}
          title={d.mine ? undefined : `Shared by ${d.owner || 'a colleague'}`}>{d.name}{!d.mine && <Ic n="users" size={12} style={{ opacity: .6 }} />}</button>)}
        <button type="button" className="bw-tab new" onClick={newDashboard}>＋ New dashboard</button>
      </div>

      <Suspense fallback={<LoadingBox />}>
        {cur ? <CustomBoard layout={cur} period={period} nonce={nonce} editing={editing && canEdit} onMove={moveWidget} onSize={sizeWidget} onRemove={removeWidget} />
          : dashParam && !layouts ? <LoadingBox />
            : Board ? <Board period={period} nonce={nonce} />
              : <Empty>You don't have access to any dashboard. Ask your administrator to enable dashboard permissions.</Empty>}
      </Suspense>
    </div>

    {dialog === 'add' && cur && <BwModal title="Add widget" width={520} onClose={() => setDialog(null)}>
      {(() => {
        const have = new Set(cur.widgets.map(w => w.id))
        const left = Object.entries(WID).filter(([k]) => !have.has(k))
        return left.length ? <div className="bw-list -mx-[14px] -my-[14px]">{left.map(([k, w]) => <div key={k}>
          <span className="min-w-0 flex-1"><b>{w.t}</b></span><Btn s p onClick={() => addWidget(k)}>Add</Btn>
        </div>)}</div> : <Empty>All widgets are already on this dashboard</Empty>
      })()}
    </BwModal>}

    {dialog === 'rename' && cur && <BwModal title="Rename dashboard" width={380} onClose={() => setDialog(null)}
      foot={<><Btn onClick={() => setDialog(null)}>Cancel</Btn><Btn p onClick={rename}>Save</Btn></>}>
      <input autoFocus className={inputCls} style={{ ...inputStyle, width: '100%' }} value={renameTo} maxLength={80} aria-label="Dashboard name"
        onChange={e => setRenameTo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') rename() }} />
    </BwModal>}

    {dialog === 'delete' && cur && <BwModal title="Delete dashboard" width={420} onClose={() => setDialog(null)}
      foot={<><Btn onClick={() => setDialog(null)}>Cancel</Btn><Btn d onClick={removeCur}>Delete</Btn></>}>
      Delete <b>{cur.name}</b>? Its layout is removed for you{cur.share.scope !== 'private' ? ' and everyone it is shared with' : ''}. The predefined dashboards are not affected.
    </BwModal>}

    {dialog === 'share' && <ShareDialog title={title} layout={cur} share={share} setShare={setShare} onCopy={async () => { await copyLink(); setDialog(null) }} onSave={saveShare} onClose={() => setDialog(null)} />}

    {drill && <DrillDrawer spec={drill} period={period} onClose={() => setDrill(null)} />}
  </DrillProvider>
}

// Share: predefined dashboards and layouts you don't own share as a link (each viewer sees their own permitted data);
// your own layouts can be shared with specific people, roles or everyone in the company.
function ShareDialog({ title, layout, share, setShare, onCopy, onSave, onClose }: {
  title: string; layout: Layout | null; share: ShareState; setShare: (s: ShareState) => void; onCopy: () => void; onSave: () => void; onClose: () => void
}) {
  const own = !!layout?.mine
  const { can } = usePermissions()
  // Picking individual people needs access to the user directory; roles and "everyone" don't.
  const canPickUsers = can('users.view') || can('users.manage')
  const [users, setUsers] = useState<{ id: number; name: string }[]>([])
  const [roles, setRoles] = useState<{ name: string; display_name: string }[]>([])
  useEffect(() => {
    if (!own) return
    api.get('/roles').then(r => setRoles((r.data || []).map((x: any) => ({ name: x.name, display_name: x.display_name || x.name })))).catch(() => setRoles([]))
    if (canPickUsers) api.get('/auth/users').then(r => setUsers((Array.isArray(r.data) ? r.data : r.data?.items || []).filter((u: any) => u.is_active !== false).map((u: any) => ({ id: u.id, name: u.full_name || u.username })))).catch(() => setUsers([]))
  }, [own, canPickUsers])
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])
  const opt = (v: ShareState['scope'], label: string) => <label className="flex cursor-pointer items-center gap-2 py-1"><input type="radio" name="share-scope" checked={share.scope === v} onChange={() => setShare({ ...share, scope: v })} />{label}</label>

  return <BwModal title={`Share “${title}”`} width={480} onClose={onClose}
    foot={own ? <><Btn onClick={onClose}>Cancel</Btn><Btn p onClick={onSave}><Ic n="link" size={14} /> Save &amp; copy link</Btn></> : <><Btn onClick={onClose}>Cancel</Btn><Btn p onClick={onCopy}><Ic n="link" size={14} /> Copy link</Btn></>}>
    <p className="mb-2">Everyone who opens this link sees the dashboard with their own permissions and data visibility — never your data.</p>
    <input readOnly className={inputCls} style={{ ...inputStyle, width: '100%' }} value={window.location.href} onFocus={e => e.currentTarget.select()} aria-label="Dashboard link" />
    {own && <div className="mt-3">
      <b className="text-[12.5px]">Who can open this layout</b>
      {opt('private', 'Only me')}
      {opt('roles', 'People with these roles')}
      {share.scope === 'roles' && <div className="mb-1 ml-6 flex flex-wrap gap-1">{roles.map(r => <button key={r.name} type="button" className={`bw-chip ${share.roles.includes(r.name) ? 'on' : ''}`} onClick={() => setShare({ ...share, roles: toggle(share.roles, r.name) })}>{r.display_name}</button>)}</div>}
      {canPickUsers && opt('users', 'Specific people')}
      {share.scope === 'users' && <div className="mb-1 ml-6 max-h-40 overflow-auto rounded border p-1" style={{ borderColor: C.ln }}>{users.length ? users.map(u => <label key={u.id} className="flex items-center gap-2 px-1 py-0.5 text-[12.5px]"><input type="checkbox" checked={share.user_ids.includes(u.id)} onChange={() => setShare({ ...share, user_ids: toggle(share.user_ids, u.id) })} />{u.name}</label>) : <small style={{ color: C.mu }}>No users available to pick</small>}</div>}
      {opt('tenant', 'Everyone in this company')}
    </div>}
    {layout && !own && <p className="mt-2 text-xs" style={{ color: C.mu }}>Shared with you by {layout.owner || 'a colleague'}. Use “Save as my dashboard” to make your own copy.</p>}
  </BwModal>
}

function CustomBoard({ layout, period, nonce, editing, onMove, onSize, onRemove }: { layout: Layout; period: Period; nonce: number; editing: boolean; onMove: (i: number, d: number) => void; onSize: (i: number) => void; onRemove: (i: number) => void }) {
  if (!layout.widgets.length) return <Empty>This dashboard is empty. Use “Add widget”.</Empty>
  return <div className="bw-g g3 bwd-wg">
    {layout.widgets.map((w, i) => {
      const W = WID[w.id]
      if (!W) return null
      const tools = editing ? <span className="bwd-wtools">
        <Btn g s onClick={() => onMove(i, -1)} disabled={i === 0} title="Move up">↑</Btn>
        <Btn g s onClick={() => onMove(i, 1)} disabled={i === layout.widgets.length - 1} title="Move down">↓</Btn>
        <Btn g s onClick={() => onSize(i)} title="Change width">{w.s}/3</Btn>
        <Btn g s onClick={() => onRemove(i)} title="Remove widget"><Ic n="x" size={13} /></Btn>
      </span> : undefined
      return <div key={`${w.id}-${i}`} className={`wsp${w.s} ${editing ? 'wedit' : ''}`}>
        {w.id === 'kpi' && !editing ? <W.C period={period} nonce={nonce} />
          : <Sec t={W.t} flush={W.flush} act={tools}><W.C period={period} nonce={nonce} /></Sec>}
      </div>
    })}
  </div>
}
