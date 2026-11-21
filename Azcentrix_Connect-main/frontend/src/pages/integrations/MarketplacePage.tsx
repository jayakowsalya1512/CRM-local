// Marketplace & API – prototype v17 R.integrations(): subnav Marketplace · API & webhooks · Connected apps.
// Marketplace = original R.integrations: crumb Administration · "Integrations" · "N connected" · API keys button, category chips, .g3 cards
//   (logo · name · description · Connected / Disconnected pill · Configure / Connect) and the connect / configure modal (A.intg).
// API & webhooks = two panels: API keys (Name · Key · Scope · Created, + Key) and Webhooks (Event · Endpoint · Status · Last delivery, + Webhook).
// Connected apps = OAuth connected apps (Application · Authorised by · Scopes · Since · Revoke).
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av, Panel, Pill, Tbl } from '@/pages/customers/kit'
import { ago, errMsg, fd, fdt, integrationsApi, type ApiKey, type ConnectedApp, type Integration, type Marketplace, type Webhook } from './integrationsApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/settings/appSettings.css'
import '@/pages/settings/admin360.css'
import './integrations.css'

const TABS = ['Marketplace', 'API & webhooks', 'Connected apps'] as const
type Tab = typeof TABS[number]
const PAL = ['#0F6E8C', '#B26B00', '#1B8559', '#7A4DB8', '#C13B2A', '#3E63A8', '#6B7D2A', '#B0447A']
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) }

function CopyBtn({ text }: { text: string }) {
  const { success, error } = useToast()
  return <button type="button" className="btn s" onClick={() => navigator.clipboard.writeText(text).then(() => success('Copied')).catch(() => error('Could not copy – select and copy it manually'))}><Ic n="copy" /> Copy</button>
}

export default function MarketplacePage() {
  const [sp, setSp] = useSearchParams()
  const tab: Tab = (TABS as readonly string[]).includes(sp.get('tab') || '') ? (sp.get('tab') as Tab) : 'Marketplace'
  const setTab = (t: Tab) => setSp(s => { const n = new URLSearchParams(s); n.set('tab', t); return n })
  return (
    <div className="bwi">
      <div className="snav" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}</div>
      {tab === 'Marketplace' && <MarketplaceTab goApi={() => setTab('API & webhooks')} />}
      {tab === 'API & webhooks' && <ApiTab />}
      {tab === 'Connected apps' && <AppsTab />}
    </div>
  )
}

/* ───────────── Marketplace (original R.integrations) ───────────── */
function MarketplaceTab({ goApi }: { goApi: () => void }) {
  const { success, error } = useToast()
  const [m, setM] = useState<Marketplace | null>(null)
  const [cat, setCat] = useState('All')
  const [sel, setSel] = useState<Integration | null>(null)
  const load = useCallback(() => integrationsApi.marketplace().then(setM).catch(e => error(errMsg(e, 'Could not load the marketplace'))), [error])
  useEffect(() => { load() }, [load])
  if (!m) return <div className="empty">Loading…</div>
  const L = m.items.filter(i => cat === 'All' || i.cat === cat)
  const act = async (msg: string, fn: () => Promise<unknown>) => { try { await fn(); await load(); success(msg); setSel(null) } catch (e) { error(errMsg(e)) } }
  return <>
    <div className="pg"><div><div className="crumb">Administration</div><h1>Integrations</h1></div><span className="cnt">{m.connected} connected</span><span className="fl" />
      <button type="button" className="btn" onClick={goApi}><Ic n="key" /> API keys</button></div>
    <div className="row wrap mb" style={{ gap: 5 }}>{['All', ...m.categories].map(c => <span key={c} role="button" tabIndex={0} className={`chip ${c === cat ? 'on' : ''}`} onClick={() => setCat(c)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCat(c) } }}>{c}</span>)}</div>
    <div className="g g3">{L.map(i => <div key={i.key} className="panel appc"><div className="pb">
      <span className="logo" style={{ background: PAL[hash(i.name) % PAL.length] }}>{i.name[0]}</span>
      <div className="fl"><b>{i.name}</b><span className="mu">{i.desc}</span>
        <div className="row mt"><Pill s={i.connected ? 'Connected' : 'Disconnected'} t={i.connected ? 'ok' : 'mu'} /><span className="fl" />
          <button type="button" className={`btn s ${i.connected ? '' : 'p'}`} onClick={() => (i.developer ? goApi() : setSel(i))}>{i.connected ? 'Configure' : 'Connect'}</button></div></div>
    </div></div>)}</div>
    {sel && <IntgModal i={sel} syncs={m.sync_options} can={m.can_manage} onClose={() => setSel(null)} act={act} />}
  </>
}

/** prototype A.intg(): connect (API key / secret) or configure (sync frequency, last sync, field mapping) */
function IntgModal({ i, syncs, can, onClose, act }: { i: Integration; syncs: string[]; can: boolean; onClose: () => void; act: (m: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const { info } = useToast()
  const [cid, setCid] = useState('')
  const [sec, setSec] = useState('')
  const [sync, setSync] = useState(i.sync)
  const [busy, setBusy] = useState(false)
  const run = async (msg: string, fn: () => Promise<unknown>) => { setBusy(true); try { await act(msg, fn) } finally { setBusy(false) } }
  return <Modal title={i.name} width={500} onClose={onClose}
    foot={<>{i.connected && <button type="button" className="btn d" disabled={!can || busy} onClick={() => run(`${i.name} disconnected`, () => integrationsApi.disconnect(i.key))}>Disconnect</button>}
      <span className="fl" /><button type="button" className="btn" onClick={onClose}>Close</button>
      {i.connected
        ? <button type="button" className="btn p" disabled={!can || busy} onClick={() => (sync === i.sync ? onClose() : run('Settings saved', () => integrationsApi.configure(i.key, sync)))}>Save</button>
        : <button type="button" className="btn p" disabled={!can || busy} onClick={() => { if (!cid.trim() || !sec.trim()) return info('Paste the API key / client ID and the secret'); void run(`${i.name} connected`, () => integrationsApi.connect(i.key, { client_id: cid.trim(), secret: sec.trim() })) }}>Connect</button>}</>}>
    {i.connected ? <div className="fg">
      <div><label>Sync frequency</label><select className="in" value={sync} disabled={!can} onChange={e => setSync(e.target.value)}>{syncs.map(s => <option key={s}>{s}</option>)}</select></div>
      <div><label>Last sync</label><input className="in" disabled value={i.last_sync ? fdt(i.last_sync) : 'Not synced yet'} readOnly /></div>
      <div className="f1"><label>Field mapping</label><div className="note">{i.mapping}</div></div>
      {i.channel && <div className="f1"><small className="mu">Inbound {i.channel} lead capture is switched on while this integration is connected. Webhook URLs are on the classic integrations page.</small></div>}
    </div> : <>
      <div className="fg"><div className="f1"><label>API key / client ID</label><input className="in" autoFocus placeholder="Paste key" value={cid} disabled={!can} onChange={e => setCid(e.target.value)} /></div>
        <div className="f1"><label>Secret</label><input className="in" type="password" value={sec} disabled={!can} onChange={e => setSec(e.target.value)} autoComplete="new-password" /></div></div>
      <p className="mu mt">You will be redirected to authorise access where required.</p></>}
  </Modal>
}

/* ───────────── API & webhooks ───────────── */
function ApiTab() {
  const { success, error } = useToast()
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [hooks, setHooks] = useState<{ items: Webhook[]; events: string[] } | null>(null)
  const [modal, setModal] = useState<{ t: 'key' } | { t: 'hook' } | { t: 'secret'; title: string; label: string; value: string; note: string } | { t: 'confirm'; title: string; body: string; ok: string; fn: () => Promise<unknown> } | null>(null)
  const load = useCallback(() => {
    integrationsApi.apiKeys().then(setKeys).catch(e => error(errMsg(e, 'Could not load API keys')))
    integrationsApi.webhooks().then(setHooks).catch(e => error(errMsg(e, 'Could not load webhooks')))
  }, [error])
  useEffect(() => { load() }, [load])
  const act = async (msg: string, fn: () => Promise<unknown>) => { try { await fn(); load(); success(msg); setModal(null) } catch (e) { error(errMsg(e)) } }
  return <>
    <div className="pg"><div><div className="crumb">Administration</div><h1>API &amp; webhooks</h1></div></div>
    <div className="g g2">
      <Panel z title="API keys" act={<button type="button" className="btn s" onClick={() => setModal({ t: 'key' })}><Ic n="plus" /> Key</button>}>
        <Tbl<ApiKey> rows={keys || []} empty={keys ? 'No API keys yet – generate one to connect Tally, Power BI or your own systems.' : 'Loading…'} cols={[
          { k: 'n', t: 'Name' }, { k: 'k', t: 'Key', fn: r => <code>{r.k}</code> }, { k: 's', t: 'Scope' }, { k: 'c', t: 'Created', fn: r => fd(r.c) },
          { k: 'x', t: '', r: true, fn: r => <button type="button" className="btn s d" onClick={() => setModal({ t: 'confirm', title: 'Revoke API key', body: `Revoke “${r.n}”? Systems using it will stop working at once.`, ok: 'Revoke', fn: () => integrationsApi.revokeApiKey(r.id) })}>Revoke</button> },
        ]} />
      </Panel>
      <Panel z title="Webhooks" act={<button type="button" className="btn s" onClick={() => setModal({ t: 'hook' })}><Ic n="plus" /> Webhook</button>}>
        <Tbl<Webhook> rows={hooks?.items || []} empty={hooks ? 'No webhooks yet – add an endpoint to receive events.' : 'Loading…'} cols={[
          { k: 'e', t: 'Event' }, { k: 'u', t: 'Endpoint', fn: r => <span title={r.u}>{r.u}</span> },
          { k: 's', t: 'Status', fn: r => <Pill s={r.s} t={r.s === 'Failed' ? 'ba' : 'ok'} /> }, { k: 'l', t: 'Last delivery', fn: r => <span title={r.err || (r.code ? `HTTP ${r.code}` : '')}>{r.l ? ago(r.l) : 'No deliveries yet'}</span> },
          { k: 'x', t: '', r: true, fn: r => <button type="button" className="btn s d" onClick={() => setModal({ t: 'confirm', title: 'Remove webhook', body: `Stop delivering events to ${r.u}?`, ok: 'Remove', fn: () => integrationsApi.deleteWebhook(r.id) })}>Remove</button> },
        ]} />
      </Panel>
    </div>
    {modal?.t === 'key' && <KeyModal onClose={() => setModal(null)} onCreate={d => integrationsApi.createApiKey(d).then(r => { load(); success('API key generated – copy it now'); setModal({ t: 'secret', title: `API key · ${r.item.n}`, label: 'API key', value: r.key, note: 'This key is shown once. Store it in your integration now – it cannot be displayed again.' }) }).catch(e => error(errMsg(e)))} />}
    {modal?.t === 'hook' && hooks && <HookModal events={hooks.events} onClose={() => setModal(null)} onCreate={d => integrationsApi.createWebhook(d).then(r => { load(); success('Webhook added'); setModal({ t: 'secret', title: `Webhook · ${r.item.u}`, label: 'Signing secret', value: r.secret, note: 'Verify deliveries with X-Azcentrix-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>. The secret is shown once.' }) }).catch(e => error(errMsg(e)))} />}
    {modal?.t === 'secret' && <Modal title={modal.title} width={520} onClose={() => setModal(null)} foot={<><span className="fl" /><button type="button" className="btn p" onClick={() => setModal(null)}>Done</button></>}>
      <label className="lb">{modal.label}</label><div className="keybox"><code>{modal.value}</code><CopyBtn text={modal.value} /></div><p className="mu mt">{modal.note}</p></Modal>}
    {modal?.t === 'confirm' && <Modal title={modal.title} width={440} onClose={() => setModal(null)}
      foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button><button type="button" className="btn d" onClick={() => act(modal.ok === 'Revoke' ? 'API key revoked' : 'Webhook removed', modal.fn)}>{modal.ok}</button></>}>
      <p style={{ margin: 0 }}>{modal.body}</p></Modal>}
  </>
}

function KeyModal({ onClose, onCreate }: { onClose: () => void; onCreate: (d: { name: string; scope: 'rw' | 'ro' }) => void }) {
  const { info } = useToast()
  const [d, setD] = useState<{ name: string; scope: 'rw' | 'ro' }>({ name: '', scope: 'rw' })
  return <Modal title="New API key" width={460} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={() => (d.name.trim() ? onCreate({ ...d, name: d.name.trim() }) : info('Name the key'))}>Generate key</button></>}>
    <div className="fg"><div className="f1"><label>Name</label><input className="in" autoFocus placeholder="e.g. Tally sync, Power BI" value={d.name} onChange={e => setD({ ...d, name: e.target.value })} /></div>
      <div className="f1"><label>Scope</label><select className="in" value={d.scope} onChange={e => setD({ ...d, scope: e.target.value as 'rw' | 'ro' })}><option value="rw">Read / write</option><option value="ro">Read only</option></select></div></div></Modal>
}

function HookModal({ events, onClose, onCreate }: { events: string[]; onClose: () => void; onCreate: (d: { url: string; events: string[] }) => void }) {
  const { info } = useToast()
  const [url, setUrl] = useState('')
  const [ev, setEv] = useState<string[]>(events)
  return <Modal title="New webhook" width={500} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" onClick={() => { if (!/^https:\/\//i.test(url.trim())) return info('Enter a public https:// endpoint'); if (!ev.length) return info('Choose at least one event'); onCreate({ url: url.trim(), events: ev }) }}>Add webhook</button></>}>
    <div className="fg"><div className="f1"><label>Endpoint</label><input className="in" autoFocus placeholder="https://erp.example.in/hooks/bids" value={url} onChange={e => setUrl(e.target.value)} /></div>
      <div className="f1"><label>Events</label><div className="chk">{events.map(e => <label key={e}><input type="checkbox" checked={ev.includes(e)} onChange={x => setEv(v => (x.target.checked ? [...v, e] : v.filter(y => y !== e)))} /> {e}</label>)}</div></div></div>
    <p className="mu mt">Deliveries are signed, retried with back-off and logged. Only public https endpoints are accepted.</p></Modal>
}

/* ───────────── Connected apps ───────────── */
function AppsTab() {
  const { success, error } = useToast()
  const [apps, setApps] = useState<ConnectedApp[] | null>(null)
  const [rev, setRev] = useState<ConnectedApp | null>(null)
  const load = useCallback(() => integrationsApi.connectedApps().then(setApps).catch(e => error(errMsg(e, 'Could not load connected apps'))), [error])
  useEffect(() => { load() }, [load])
  return <>
    <div className="pg"><div><div className="crumb">Administration</div><h1>Connected apps</h1></div></div>
    <Panel z title="OAuth connected apps">
      <Tbl<ConnectedApp> rows={apps || []} rowKey={r => r.app_id} empty={apps ? 'No apps have been authorised yet. Install apps from the marketplace to see them here.' : 'Loading…'} cols={[
        { k: 'a', t: 'Application', fn: r => <><b>{r.a}</b> <small className="mu">· {r.pub}</small></> }, { k: 'u', t: 'Authorised by', fn: r => <span className="ucell"><Av name={r.u} />{r.u}</span> },
        { k: 's', t: 'Scopes' }, { k: 'd', t: 'Since', fn: r => fd(r.d) },
        { k: 'x', t: '', r: true, fn: r => <button type="button" className="btn s d" onClick={() => setRev(r)}>Revoke</button> },
      ]} />
    </Panel>
    {rev && <Modal title="Revoke access" width={440} onClose={() => setRev(null)} foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setRev(null)}>Cancel</button>
      <button type="button" className="btn d" onClick={() => integrationsApi.revokeApp(rev.app_id).then(() => { setRev(null); load(); success('Access revoked') }).catch(e => error(errMsg(e)))}>Revoke</button></>}>
      <p style={{ margin: 0 }}>Revoke {rev.a}'s access? It will no longer be able to read or write your data.</p></Modal>}
  </>
}
