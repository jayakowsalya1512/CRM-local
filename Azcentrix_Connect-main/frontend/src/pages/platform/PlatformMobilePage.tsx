import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { platformApi, type MobileDevice, type MobileOverview, type MobileProvider, type MobilePush, type MobileRelease, type MobileTenant } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol, type GridServer } from '@/components/platform/BwGrid'
import { Bar, Btn, BwModal, C, Empty, Field, Ic, Note, Panel, Pill, Strip, Switch, Table, Tabs, errMsg, fd, inputCls, inputStyle, num, useKpiPopup, type Tone } from '@/components/platform/bw'
import { Donut, HBars, LineChart, PAL } from '@/components/platform/charts'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout follows the Bidwise prototype v7 Mobile app control page (P.mob): seven tabs, KPI strip, releases, devices,
// tenant controls, push & messaging, security policy, branding & stores. Everything shown is real; what the platform
// can't do yet (crash data, store status, builds, APNs / SMS, device-side enforcement) is labelled as such.
const TABS = ['Overview', 'Releases', 'Devices', 'Tenant controls', 'Push & messaging', 'Security & policy', 'Branding & stores'] as const
type Tab = typeof TABS[number]
const REL_TONE: Record<string, Tone> = { Live: 'ok', Deprecated: 'ba', Blocked: 'ba', Paused: 'wa', 'Rolling out': 'inf' }
const DEV_TONE: Record<string, Tone> = { Active: 'ok', Locked: 'wa', Blocked: 'ba', 'Wipe pending': 'ba', Wiped: 'ba' }
const PROV_TONE: Record<string, Tone> = { Connected: 'ok', 'Not verified': 'wa', 'Not connected': 'ba', 'Not configured': 'mu', 'Not available': 'mu' }
const ROLES = [['admin', 'Admin'], ['ceo', 'CEO'], ['manager', 'Manager'], ['kam', 'KAM']] as const
const FLAGS = [['offline', 'Offline'], ['gps', 'GPS check-in'], ['voice', 'Voice notes'], ['biometric', 'Biometric'], ['screenshots_blocked', 'Screenshots blocked'], ['device_approval', 'Device approval']] as const
const ROLE_NOTE: Record<string, string> = { admin: 'admin role', ceo: 'ceo role', manager: 'manager and vp roles', kam: 'sales (KAM) role' }

function Confirm({ title, body, action, danger, onClose, onOk }: { title: string; body: ReactNode; action: string; danger?: boolean; onClose: () => void; onOk: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false)
  return <BwModal title={title} width={460} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn>
    <Btn d={danger} p={!danger} disabled={busy} onClick={async () => { setBusy(true); try { await onOk() } finally { setBusy(false) } }}>{busy ? 'Working…' : action}</Btn></>}>
    <div>{body}</div>
  </BwModal>
}

function NewReleaseModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast()
  const [f, setF] = useState({ version: '', platform: 'iOS', channel: 'Beta', rollout: '10', notes: '' })
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }))
  const ok = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(f.version.trim()) && Number(f.rollout) >= 0 && Number(f.rollout) <= 100
  const save = async () => {
    setBusy(true)
    try { const { data } = await platformApi.mobileRelease({ ...f, version: f.version.trim(), rollout: Number(f.rollout) }); success('Release recorded', `${data.version} ${data.platform} at ${data.rollout}% – store submission is not automated`); onDone() }
    catch (err) { showError(errMsg(err, 'Unable to create the release')) } finally { setBusy(false) }
  }
  return <BwModal title="New mobile release" width={480} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy || !ok} onClick={() => void save()}>{busy ? 'Saving…' : 'Create release'}</Btn></>}>
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="Version"><input className={inputCls} style={inputStyle} value={f.version} placeholder="3.4.0" onChange={set('version')} /></Field>
      <Field label="Platform"><select className={inputCls} style={inputStyle} value={f.platform} onChange={set('platform')}><option>iOS</option><option>Android</option></select></Field>
      <Field label="Channel"><select className={inputCls} style={inputStyle} value={f.channel} onChange={set('channel')}><option>Beta</option><option>Production</option></select></Field>
      <Field label="Initial rollout %"><input className={inputCls} style={inputStyle} type="number" min={0} max={100} value={f.rollout} onChange={set('rollout')} /></Field>
      <div className="sm:col-span-2"><Field label="Release notes"><input className={inputCls} style={inputStyle} value={f.notes} maxLength={500} onChange={set('notes')} /></Field></div>
    </div>
  </BwModal>
}

export default function PlatformMobilePage() {
  const { can } = usePlatformAccess()
  const { success, info, warning, error: showError } = useToast()
  const [tab, setTab] = useState<Tab>('Overview')
  const [data, setData] = useState<MobileOverview | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<ReactNode>(null)
  const load = useCallback(async () => {
    try { const { data: next } = await platformApi.mobile(); setData(next); setError('') } catch (err) { setError(errMsg(err, 'Mobile app control unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])
  const canManage = can('tenants', 'manage')
  const canPlatform = canManage && !!data?.all_scope
  const run = async (fn: () => Promise<unknown>, done?: string, fallback = 'Action failed') => {
    try { await fn(); if (done) success(done); await load(); return true } catch (err) { showError(errMsg(err, fallback)); return false }
  }
  const close = () => setModal(null)
  const k = data?.kpis
  const [openKpi, kpiPopup] = useKpiPopup()

  // ── Overview ─────────────────────────────────────────────────────────────
  const overview = data && k && <>
    <Strip items={[
      { l: 'Registered devices', kpi: 'mobile.registered', v: num(k.registered) },
      { l: 'Active · 7 days', kpi: 'mobile.active_7d', v: num(k.active_7d) },
      { l: 'Crash-free sessions', kpi: 'mobile.crash_free', v: '—', d: 'no crash reporting' },
      { l: k.latest_version ? `On latest (${k.latest_version}+)` : 'On latest', kpi: 'mobile.on_latest', v: k.on_latest != null ? `${k.on_latest}%` : '—',
        d: !k.latest_version ? 'no Live release recorded' : !k.versions_reported ? 'app doesn’t report versions yet' : undefined },
      { l: 'Push delivered · 24h', kpi: 'mobile.push_24h', v: num(k.push_24h), d: k.push_rate != null ? <span title="Accepted by FCM">{k.push_rate}%</span> : undefined, c: C.ok },
      { l: 'Flagged devices', kpi: 'mobile.flagged', v: <span style={{ color: k.flagged ? C.ba : undefined }}>{num(k.flagged)}</span> },
    ]} />
    {!!data.unreachable.length && <Note className="mb-2">Not read: {data.unreachable.join(', ')} – tenant database unreachable.</Note>}
    <div className="mb-2 grid gap-2 lg:grid-cols-3">
      <Panel title="App versions in the field"><Donut data={data.versions.map((v, i) => ({ l: v.l, v: v.v, c: v.l === 'Not reported' ? 'var(--bw-mu)' : PAL[i % PAL.length] }))} f={v => String(v)} center={String(k.registered)}
        onPick={i => { const v = data.versions[i]; openKpi({ kpi: 'mobile.registered', title: `Devices on ${v.l}`, value: num(v.v), query: { facet: v.l } }) }} /></Panel>
      <Panel title="Platform & OS"><HBars lw={110} vw={40} rows={data.platforms.map(p => ({ l: p.l, v: p.v, text: String(p.v), muted: p.l === 'Not reported' }))}
        onPick={i => { const p = data.platforms[i]; openKpi({ kpi: 'mobile.platforms', title: `Devices · ${p.l}`, value: num(p.v), query: { facet: p.l } }) }} /></Panel>
      <Panel title="Store status" flush><div>{['Apple App Store', 'Apple TestFlight', 'Google Play', 'Google Play (prod)'].map(n => {
        const pf = n.startsWith('Apple') ? 'iOS' : 'Android'
        const r = data.releases.find(x => x.platform === pf && (n.includes('TestFlight') || n === 'Google Play' ? x.channel === 'Beta' : x.channel === 'Production'))
        return <div key={n} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}>
          <span className="flex-1"><b>{n}</b><br /><small style={{ color: C.mu }}>{r ? `Recorded here: v${r.version} · ${r.status}` : 'No release recorded'}</small></span>
          <Pill t="mu" title="No App Store Connect / Google Play Console credentials are configured, so the live store status can't be read">Not connected</Pill></div>
      })}</div></Panel>
    </div>
    <div className="grid gap-2 lg:grid-cols-2">
      <Panel title="Daily active mobile users · 14 days"><LineChart h={130} series={[{ n: 'DAU', c: PAL[0], v: data.dau.values }]} labels={data.dau.labels.map((d, i) => i % 3 === 0 ? `D-${14 - i}` : '')} f={v => Number.isInteger(v) ? String(v) : ''} /></Panel>
      <Panel title="Mobile usage by tenant"><HBars lw={140} vw={40} rows={data.usage.map(u => ({ l: u.l, v: u.v, text: String(u.v), note: 'mobile sessions · 30 days' }))}
        onPick={i => { const t = data.tenants.find(x => x.name === data.usage[i].l); if (t) openKpi({ kpi: 'mobile.registered', title: `Devices · ${t.name}`, value: `${num(data.usage[i].v)} sessions · 30 d`, query: { tenant_id: t.id } }) }} /></Panel>
    </div>
  </>

  // ── Releases ─────────────────────────────────────────────────────────────
  const releaseAct = (r: MobileRelease, action: string) => {
    if (action === 'force') return setModal(<Confirm title="Force update" danger action="Force update" onClose={close}
      body={<>Force every user below <b>{r.version}</b> on {r.platform} to update before they can continue? This is enforced at sign-in for app builds that report their version.</>}
      onOk={async () => { if (await run(() => platformApi.mobileReleaseAction(r.id, 'force', true), `Forced update – minimum supported ${r.platform} is now ${r.version}`)) close() }} />)
    void run(() => platformApi.mobileReleaseAction(r.id, action), action === 'roll' ? `${r.version} ${r.platform} rollout +25%` : `Rollout paused for ${r.version} ${r.platform}`)
  }
  const [kill, setKill] = useState('')
  const releasesTab = data && <>
    <div className="mb-2 flex flex-wrap items-center gap-2"><h3 className="flex-1 font-semibold">Releases &amp; rollout</h3>
      <Btn p disabled={!canPlatform} onClick={() => setModal(<NewReleaseModal onClose={close} onDone={() => { close(); void load() }} />)}><Ic n="plus" /> New release</Btn></div>
    <Note info className="mb-2">Roll out gradually, pause on crash spikes, and force an update when a version must be retired. Rollouts apply to every tenant on the shared app.
      Releases are recorded here and served by the app’s version check – submitting builds to the stores is not automated.</Note>
    <Panel title="Releases" flush>
      <Table head={['Version', 'Platform', 'Channel', 'Rollout', 'Status', 'Min supported', '']} minWidth={760}>
        {!data.releases.length ? <tr><td colSpan={7} className="!p-0"><Empty>No releases recorded yet.</Empty></td></tr> : data.releases.map(r => <tr key={r.id} title={r.notes ?? undefined}>
          <td><b>{r.version}</b></td><td><Pill t="ac">{r.platform}</Pill></td><td>{r.channel}</td><td style={{ minWidth: 110 }}><Bar value={r.rollout} /></td>
          <td><Pill t={REL_TONE[r.status] ?? 'inf'}>{r.status}</Pill></td><td>{r.min_supported ?? '—'}</td>
          <td className="whitespace-nowrap"><span className="inline-flex gap-1">
            <Btn s disabled={!canPlatform || r.rollout >= 100 || ['Blocked', 'Deprecated'].includes(r.status)} onClick={() => releaseAct(r, 'roll')}>+25%</Btn>
            <Btn s disabled={!canPlatform || ['Paused', 'Blocked', 'Deprecated'].includes(r.status)} onClick={() => releaseAct(r, 'pause')}>Pause</Btn>
            <Btn s d disabled={!canPlatform} onClick={() => releaseAct(r, 'force')}>Force update</Btn></span></td>
        </tr>)}
      </Table>
    </Panel>
    <div className="mt-2 grid gap-2 lg:grid-cols-2">
      <Panel title="Minimum supported version">
        <div className="grid gap-2 sm:grid-cols-2">{(['iOS', 'Android'] as const).map(pf => <Field key={pf} label={pf}>
          <input className={inputCls} style={inputStyle} defaultValue={data.settings.min_supported[pf] ?? ''} placeholder="none" disabled={!canPlatform}
            onBlur={e => { const v = e.target.value.trim(); if (v && v !== (data.settings.min_supported[pf] ?? '')) void run(() => platformApi.mobileMinSupported(pf, v), `Minimum supported ${pf} version saved`) }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} /></Field>)}
          <div className="sm:col-span-2 flex items-center gap-2"><Switch on={data.settings.soft_prompt} disabled={!canPlatform} onChange={v => void run(() => platformApi.mobileSoftPrompt(v), 'Update prompt saved')} />
            <span>Show a soft “update available” prompt from the next version</span></div>
        </div>
      </Panel>
      <Panel title="Kill switch">
        <p className="mb-2" style={{ color: C.mu }}>Immediately blocks a version and sends users to the update screen.</p>
        <div className="flex gap-2"><select className={inputCls} style={inputStyle} value={kill} onChange={e => setKill(e.target.value)}>
          <option value="">Choose a version…</option>{data.releases.filter(r => r.status !== 'Blocked').map(r => <option key={r.id} value={r.id}>{r.version} · {r.platform}</option>)}</select>
          <Btn d disabled={!canPlatform || !kill} onClick={() => { const r = data.releases.find(x => String(x.id) === kill)!; setModal(<Confirm title="Block version" danger action="Block version" onClose={close}
            body={<>Block <b>{r.version} · {r.platform}</b> immediately? Sign-ins from this version are refused and the version check sends users to the update screen (for app builds that report their version).</>}
            onOk={async () => { if (await run(() => platformApi.mobileReleaseAction(r.id, 'block', true), 'Version blocked – kill switch active')) { setKill(''); close() } }} />) }}>Block version</Btn></div>
      </Panel>
    </div>
  </>

  // ── Devices ──────────────────────────────────────────────────────────────
  const [devs, setDevs] = useState<{ items: MobileDevice[]; total: number }>({ items: [], total: 0 })
  const [devQ, setDevQ] = useState({ q: '', offset: 0, limit: 25 })
  const loadDevs = useCallback(async () => {
    try { const { data: d } = await platformApi.mobileDevices(devQ.q, devQ.offset, devQ.limit); setDevs(d) } catch (err) { showError(errMsg(err, 'Devices unavailable')) }
  }, [devQ, showError])
  useEffect(() => { if (tab === 'Devices') void loadDevs() }, [tab, loadDevs])
  const devAct = (d: MobileDevice, action: string) => {
    const go = async (confirm: boolean) => {
      try {
        const { data: r } = await platformApi.mobileDeviceAction(d.id, action, confirm)
        const eff = r.effects ? Object.entries(r.effects).filter(([, n]) => n).map(([k2, n]) => `${n} ${k2.replace('_', ' ')}`).join(', ') : ''
        if (action === 'wipe') warning('Wipe queued', `Revoked: ${eff || 'nothing active'}. The device's data is erased only when the app confirms the wipe.`)
        else success(action === 'restore' ? 'Device restored' : `Device ${r.status.toLowerCase()}`, eff ? `Revoked: ${eff}` : undefined)
        close(); await loadDevs(); await load()
      } catch (err) { showError(errMsg(err, 'Action failed')) }
    }
    if (action === 'wipe' || action === 'block') setModal(<Confirm title={action === 'wipe' ? 'Wipe device' : 'Block device'} danger action={action === 'wipe' ? 'Wipe' : 'Block'} onClose={close}
      body={action === 'wipe' ? <>Queue a remote wipe for <b>{d.model ?? 'this device'}</b> ({d.user})? The user is signed out of the app now; the app’s data is erased only when the app receives and confirms the wipe.</>
        : <>Block mobile access for <b>{d.user}</b>? Their app sessions, quick-PIN and this device’s push registration are revoked, and new mobile sign-ins are refused until restored.</>}
      onOk={() => go(true)} />)
    else void go(false)
  }
  const bulk = (action: string) => (rows: MobileDevice[]) => {
    const go = async () => {
      try { const { data: r } = await platformApi.mobileBulk(rows.map(x => x.id), action, true); success(`${r.done.length} device(s): ${action}`, r.skipped.length ? `${r.skipped.length} skipped` : undefined); close(); await loadDevs(); await load() }
      catch (err) { showError(errMsg(err, 'Bulk action failed')) }
    }
    setModal(<Confirm title={`${action[0].toUpperCase()}${action.slice(1)} ${rows.length} device(s)`} danger={action !== 'lock'} action={action[0].toUpperCase() + action.slice(1)} onClose={close}
      body={<>Apply <b>{action}</b> to {rows.length} selected device(s)?{action === 'wipe' ? ' Data is erased only on devices whose app confirms the wipe.' : ''}</>} onOk={go} />)
  }
  const devCols: GridCol<MobileDevice>[] = [
    { k: 'who', t: 'User', w: 170, txt: d => d.user ?? `#${d.user_id}` },
    { k: 'ten', t: 'Tenant', w: 120, txt: d => d.tenant, fn: d => <Pill t="ac">{d.tenant}</Pill> },
    { k: 'model', t: 'Device', w: 150, txt: d => d.model ?? 'Not reported' },
    { k: 'os', t: 'OS', w: 100, txt: d => [d.platform, d.os].filter(Boolean).join(' ') || 'Not reported' },
    { k: 'ver', t: 'App version', w: 100, txt: d => d.app_version ?? 'Not reported' },
    { k: 'last', t: 'Last seen', date: true, txt: d => fd(d.last_seen) },
    { k: 'jb', t: 'Integrity', w: 110, txt: d => d.integrity ?? 'Not reported', fn: d => d.integrity === 'compromised' ? <Pill t="ba">Jailbroken</Pill> : d.integrity === 'verified' ? <Pill t="ok">Verified</Pill> : <Pill t="mu">Not reported</Pill> },
    { k: 'st', t: 'Status', w: 110, txt: d => d.status, fn: d => <Pill t={DEV_TONE[d.status] ?? 'mu'}>{d.status}</Pill> },
    { k: 'x', t: 'Actions', w: 240, txt: () => '', fn: d => <span className="inline-flex gap-1" onClick={e => e.stopPropagation()}>
      <Btn s disabled={!canManage || d.status === 'Wiped'} onClick={() => devAct(d, 'lock')}>Lock</Btn>
      <Btn s disabled={!canManage || d.status === 'Wiped'} onClick={() => devAct(d, 'wipe')}>Wipe</Btn>
      <Btn s d disabled={!canManage || d.status === 'Wiped'} onClick={() => devAct(d, 'block')}>Block</Btn>
      {d.status !== 'Active' && <Btn s p disabled={!canManage} onClick={() => devAct(d, 'restore')}>Restore</Btn>}</span> },
  ]
  const devServer: GridServer = { total: devs.total, onChange: useCallback(s => setDevQ(x => x.offset === s.offset && x.limit === s.limit ? x : { ...x, offset: s.offset, limit: s.limit }), []) }
  const devQuery = useCallback((s: { q: string }) => setDevQ(x => x.q === s.q ? x : { ...x, q: s.q, offset: 0 }), [])
  const devicesTab = <Panel title="Registered devices" flush>
    <BwGrid id="mobile-devices" cols={devCols} rows={devs.items} rid={d => String(d.id)} server={devServer} onQuery={devQuery}
      bulk={canManage ? [['Lock selected', bulk('lock')], ['Wipe selected', bulk('wipe')], ['Block selected', bulk('block')]] : []}
      empty="No registered devices. Devices appear when the app registers for push notifications or calls the device registration API." />
  </Panel>

  // ── Tenant controls ──────────────────────────────────────────────────────
  const setTenant = (t: MobileTenant, changes: Record<string, unknown>, label: string) => void run(() => platformApi.mobileTenant(t.id, changes), `${label} saved for ${t.name}`, 'Unable to save')
  const tenantsTab = data && <>
    <Note info className="mb-2">Control the mobile app for every tenant: switch it on or off, choose which roles may sign in, and set the device and security rules. Tenant admins can only tighten these, never loosen them.
      Mobile access, roles and blocked users are enforced at mobile sign-in; offline, GPS, voice notes, biometric, screenshots and device approval are sent to the app, which applies them.</Note>
    <Panel title="Mobile access by tenant" flush>
      <div className="overflow-x-auto"><table className="w-full" style={{ minWidth: 1180 }}><thead><tr>
        <th className="text-left">Tenant</th><th className="text-center">Mobile app</th>{ROLES.map(([r, l]) => <th key={r} className="text-center" title={`Applies to the ${ROLE_NOTE[r]}`}>{l}</th>)}
        {FLAGS.map(([f2, l]) => <th key={f2} className="text-center">{l}</th>)}<th className="text-right">Max devices</th></tr></thead>
        <tbody>{data.tenants.map(t => <tr key={t.id}>
          <td><b>{t.name}</b></td>
          <td className="text-center"><span className="inline-flex"><Switch on={t.enabled} disabled={!canManage} onChange={v => setTenant(t, { enabled: v }, 'Mobile app')} /></span></td>
          {ROLES.map(([r]) => <td key={r} className="text-center"><input type="checkbox" checked={t.roles[r]} disabled={!canManage} style={{ accentColor: 'var(--bw-ac)' }}
            onChange={e => setTenant(t, { roles: { [r]: e.target.checked } }, `${r.toUpperCase()} access`)} /></td>)}
          {FLAGS.map(([f2]) => <td key={f2} className="text-center"><span className="inline-flex"><Switch on={t[f2] as boolean} disabled={!canManage} onChange={v => setTenant(t, { [f2]: v }, 'Mobile setting')} /></span></td>)}
          <td className="text-right"><input className={`${inputCls} !w-16 text-right`} style={inputStyle} type="number" min={1} max={50} defaultValue={t.max_devices} disabled={!canManage}
            onBlur={e => { const v = Number(e.target.value); if (v !== t.max_devices) setTenant(t, { max_devices: v }, 'Max devices') }} /></td>
        </tr>)}</tbody></table></div>
    </Panel>
    <div className="mt-2 flex flex-wrap gap-2">
      <Btn disabled={!canPlatform} onClick={() => setModal(<Confirm title="Enable mobile for all tenants" action="Yes, continue" onClose={close} body="Enable the mobile app for every tenant?"
        onOk={async () => { if (await run(() => platformApi.mobileAllTenants(true), 'Mobile app enabled for all tenants')) close() }} />)}>Enable mobile for all tenants</Btn>
      <Btn d disabled={!canPlatform} onClick={() => setModal(<Confirm title="Disable mobile for all tenants" danger action="Yes, continue" onClose={close}
        body="Disable the mobile app for every tenant? New mobile sign-ins are refused; sessions already open continue until they expire."
        onOk={async () => { if (await run(() => platformApi.mobileAllTenants(false), 'Mobile app disabled for all tenants')) close() }} />)}>Disable mobile for all tenants</Btn>
    </div>
  </>

  // ── Push & messaging ─────────────────────────────────────────────────────
  const [compose, setCompose] = useState({ audience: 'all', when: 'Send now', title: '', message: '' })
  const [pushes, setPushes] = useState<MobilePush[] | null>(null)
  const [provs, setProvs] = useState<MobileProvider[] | null>(null)
  const loadPush = useCallback(async () => {
    platformApi.mobilePushes().then(r => setPushes(r.data)).catch(err => showError(errMsg(err, 'Notifications unavailable')))
    platformApi.mobileProviders().then(r => setProvs(r.data)).catch(() => setProvs([]))
  }, [showError])
  useEffect(() => { if (tab === 'Push & messaging') void loadPush() }, [tab, loadPush])
  const [sending, setSending] = useState(false)
  const send = async () => {
    setSending(true)
    try {
      const { data: p } = await platformApi.mobileSendPush(compose)
      if (p.status === 'scheduled') info('Push scheduled', `${p.title} · ${p.when}`)
      else if (p.status === 'failed') showError('Push not delivered', p.error ?? undefined)
      else success('Push sent', `${p.accepted} of ${p.sent} device(s) accepted by FCM${p.error ? ` · ${p.error}` : ''}`)
      setCompose(c => ({ ...c, title: '', message: '' })); void loadPush(); void load()
    } catch (err) { showError(errMsg(err, 'Unable to send')) } finally { setSending(false) }
  }
  const pushTab = data && <>
    <div className="mb-2 grid gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Panel title="Compose push notification">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Audience"><select className={inputCls} style={inputStyle} value={compose.audience} onChange={e => setCompose(c => ({ ...c, audience: e.target.value }))}>
            {data.all_scope && <option value="all">{data.audiences.all}</option>}{data.tenants.map(t => <option key={t.id} value={`tenant:${t.id}`}>{t.name}</option>)}
            {data.all_scope && ['kam', 'manager', 'ceo'].map(a => <option key={a} value={a}>{data.audiences[a]}</option>)}</select></Field>
          <Field label="When"><select className={inputCls} style={inputStyle} value={compose.when} onChange={e => setCompose(c => ({ ...c, when: e.target.value }))}>{data.when.map(w => <option key={w}>{w}</option>)}</select></Field>
          <div className="sm:col-span-2"><Field label="Title"><input className={inputCls} style={inputStyle} value={compose.title} maxLength={200} placeholder="e.g. Quarter-end targets" onChange={e => setCompose(c => ({ ...c, title: e.target.value }))} /></Field></div>
          <div className="sm:col-span-2"><Field label="Message"><textarea className={`${inputCls} h-auto py-1`} style={inputStyle} rows={3} maxLength={2000} value={compose.message} onChange={e => setCompose(c => ({ ...c, message: e.target.value }))} /></Field></div>
        </div>
        <div className="mt-2 flex gap-2">
          <Btn disabled title="Platform staff don’t have a registered mobile device, so there is nowhere to send a test">Send test to me</Btn>
          <Btn p disabled={!canManage || sending || !compose.title.trim() || !compose.message.trim()} onClick={() => void send()}><Ic n="megaphone" /> {sending ? 'Sending…' : 'Send'}</Btn>
        </div>
      </Panel>
      <Panel title="Providers" flush>{!provs ? <Empty>Checking providers…</Empty> : <div>{provs.map(p => <div key={p.name} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}>
        <span className="flex-1"><b>{p.name}</b><br /><small style={{ color: C.mu }}>{p.detail}</small></span><Pill t={PROV_TONE[p.status] ?? 'mu'}>{p.status}</Pill></div>)}</div>}</Panel>
    </div>
    <Panel title="Recent notifications" flush>
      <Table head={['Title', 'Audience', { t: 'Sent', r: true }, { t: 'Delivered', r: true }, 'Date']} minWidth={620}>
        {!pushes ? <tr><td colSpan={5} className="!p-0"><Empty>Loading…</Empty></td></tr> : !pushes.length ? <tr><td colSpan={5} className="!p-0"><Empty>No notifications sent yet.</Empty></td></tr>
          : pushes.map(p => <tr key={p.id} title={p.error ?? undefined}><td><b>{p.title}</b></td><td>{p.audience}</td>
            <td className="text-right tabular-nums">{p.status === 'scheduled' ? <Pill t="inf">Scheduled</Pill> : num(p.sent)}</td>
            <td className="text-right tabular-nums" title="Accepted by FCM">{p.delivered_pct != null ? `${p.delivered_pct}%` : '—'}</td><td>{fd(p.date)}</td></tr>)}
      </Table>
    </Panel>
  </>

  // ── Security & policy ────────────────────────────────────────────────────
  const policyTab = data && <>
    <Note info className="mb-2">Platform-wide defaults for every mobile build. Tenants inherit these and may only make them stricter. These settings are sent to the app through its configuration API;
      the device-side controls take effect only in app builds that implement them – the platform can’t verify that from here.</Note>
    <Panel title="Mobile security policy" flush><div>{data.policy.map(p => <div key={p.key} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}>
      <span className="flex-1">{p.label}<br /><small style={{ color: C.mu }}>{p.enforcement === 'server_if_reported' ? 'Enforced at sign-in when the app reports its OS version' : 'Configured · applied by the app (not verified)'}</small></span>
      {p.type === 'num' ? <input className={`${inputCls} !w-20 text-right`} style={inputStyle} type="number" defaultValue={p.value as number} disabled={!canPlatform}
        onBlur={e => { const v = Number(e.target.value); if (v !== p.value) void run(() => platformApi.mobilePolicy(p.key, v), 'Policy saved') }} />
        : <Switch on={!!p.value} disabled={!canPlatform} onChange={v => void run(() => platformApi.mobilePolicy(p.key, v), 'Policy saved')} />}
    </div>)}</div></Panel>
  </>

  // ── Branding & stores ────────────────────────────────────────────────────
  const brandingTab = data && <>
    <Note info className="mb-2">Each tenant can ship the app under its own name, icon and bundle id. Enterprise plans get a fully branded build in the App Store and Google Play.
      Building and submitting apps is not available: no build pipeline or store credentials are configured.</Note>
    <Panel title="Branding & store listings" flush>
      <Table head={['Tenant', 'App name', 'Bundle id', 'Colour', 'Distribution', '']} minWidth={820}>
        {data.tenants.map(t => <tr key={t.id}>
          <td><b>{t.name}</b></td>
          <td><input className={`${inputCls} !w-[200px]`} style={inputStyle} defaultValue={t.app_name} maxLength={120} disabled={!canManage}
            onBlur={e => { const v = e.target.value.trim(); if (v && v !== t.app_name) setTenant(t, { app_name: v }, 'App name') }} /></td>
          <td className="font-mono text-xs">{t.bundle_id}</td>
          <td>{t.colour ? <span className="inline-flex items-center gap-1.5"><span className="inline-block h-4 w-4 rounded" style={{ background: t.colour }} />{t.colour}</span> : '—'}</td>
          <td><Pill t={t.distribution === 'Branded app' ? 'ac' : 'mu'}>{t.distribution}</Pill></td>
          <td>{t.distribution === 'Branded app'
            ? <Btn s disabled title="No build pipeline or App Store / Play Console credentials are configured">Build &amp; submit</Btn>
            : <Btn s disabled={!canManage || !t.enterprise} title={t.enterprise ? undefined : 'A branded app needs the Enterprise plan'} onClick={() => setTenant(t, { distribution: 'Branded app' }, 'Branded app')}>Enable branded app</Btn>}</td>
        </tr>)}
      </Table>
    </Panel>
  </>

  const body: Record<Tab, ReactNode> = { Overview: overview, Releases: releasesTab, Devices: devicesTab, 'Tenant controls': tenantsTab, 'Push & messaging': pushTab, 'Security & policy': policyTab, 'Branding & stores': brandingTab }
  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2 flex flex-wrap items-end gap-2">
      <div><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Mobile &amp; ecosystem</div><h1 className="text-xl font-semibold">Mobile app control</h1></div>
      {data && <Pill t="ok"><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: C.ok }} />{num(data.active_devices)} devices active</Pill>}
      <span className="flex-1" />
      <Btn onClick={() => setTab('Push & messaging')}><Ic n="megaphone" /> Push notification</Btn>
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}
    <div className="mb-2"><Tabs tabs={TABS} active={tab} onChange={t => setTab(t as Tab)} /></div>
    {!data && tab !== 'Devices' ? <Panel title={tab}><Empty>{error || 'Loading…'}</Empty></Panel> : body[tab]}
    {modal}
    {kpiPopup}
  </div>
}
