import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { platformApi, type CapacityServer, type InfrastructureOverview, type Release, type ReleaseStep, type ServiceHealth } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { BwModal, Btn, C, Empty, Field, Ic, Kv, Note, Panel, Pill, Table, errMsg, fdt, inputCls, inputStyle, type Tone } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'
import { niceMax } from '@/components/platform/charts'

// Layout, sections and actions follow the Bidwise prototype Infrastructure & releases page (P.infra).
// Services are the processes on our self-hosted servers; release steps run through the deployment service configured
// on the API server (PLATFORM_DEPLOY_COMMAND) and only count as done when that service reports success.
const REFRESH_MS = 15_000
const BUSY_REFRESH_MS = 4_000
const VERSION_RE = /^\d{1,4}\.\d{1,3}\.\d{1,4}(-[0-9A-Za-z.]{1,20})?$/
const HEALTH_TONE: Record<ServiceHealth, Tone> = { Healthy: 'ok', Degraded: 'wa', Down: 'ba', Unavailable: 'mu' }
const STATUS_PILL: Record<string, [string, Tone]> = {
  deploying: ['Deploying', 'inf'], canary: ['Canary', 'inf'], production: ['Production', 'ok'], failed: ['Failed', 'ba'],
  rolled_back: ['Rolled back', 'wa'], superseded: ['Superseded', 'mu'], pending: ['Pending', 'mu'],
}

const splitVersion = (v: string): [number[], string] => { const i = v.indexOf('-'); return [(i < 0 ? v : v.slice(0, i)).split('.').map(Number), i < 0 ? '' : v.slice(i + 1)] }
function isNewer(a: string, b: string) {
  const [ac, ap] = splitVersion(a), [bc, bp] = splitVersion(b)
  for (let i = 0; i < 3; i++) if (ac[i] !== bc[i]) return ac[i] > bc[i]
  if (!ap !== !bp) return !ap // a release is newer than its pre-releases
  return ap > bp
}
function suggestVersion(production?: string) {
  const d = new Date(), ym = `${d.getFullYear()}.${d.getMonth() + 1}`
  if (!production) return `${ym}.1`
  const [c] = splitVersion(production)
  if (c[0] >= 2000) return c[0] === d.getFullYear() && c[1] === d.getMonth() + 1 ? `${ym}.${c[2] + 1}` : `${ym}.1`
  return `${c[0]}.${c[1]}.${c[2] + 1}`
}
const gb = (v: number) => v >= 1024 ? `${(v / 1024).toFixed(1)}T` : `${v >= 100 ? Math.round(v) : v.toFixed(1)}G`

// Prototype bar(): 60 px track, accent fill, percentage after it.
function UsageBar({ v, note }: { v: number | null; note: string | null }) {
  if (v == null) return <span style={{ color: C.mu }} title={note ?? undefined}>—</span>
  return <span className="whitespace-nowrap" title={note ?? undefined}>
    <span className="mr-[5px] inline-block h-1.5 w-[60px] overflow-hidden rounded-md align-middle" style={{ background: C.ln2 }}><i className="block h-full" style={{ width: `${Math.min(100, v)}%`, background: C.ac }} /></span>{Math.round(v)}%
  </span>
}

function statusText(r: Release) {
  const op = r.operation === 'rollback' ? ` · rolling back to ${r.rollback_to ?? r.previous_version}` : r.operation === 'promote' ? ` · promoting to ${r.next_percent}%` : ''
  switch (r.status) {
    case 'deploying': return `Deploying to ${r.config?.initial_percent ?? 100}%`
    case 'canary': return `Canary ${r.rollout_percent}%${op}`
    case 'production': return `Production 100%${r.verified ? '' : ' · verifying'}${op}`
    default: return `${STATUS_PILL[r.status]?.[0] ?? r.status}${op}`
  }
}

function ReleaseRow({ r, canAct, busy, onPromote, onRollback, onOpen }: { r: Release; canAct: boolean; busy: boolean; onPromote: () => void; onRollback: () => void; onOpen: () => void }) {
  const inFlight = r.status === 'canary' || r.status === 'deploying'
  const rollbackTitle = r.rollback_to ? `Restore ${r.rollback_to}` : 'No verified previous release to restore'
  const rollback = <Btn s d disabled={!canAct || busy || !!r.operation || !r.rollback_to} title={rollbackTitle} onClick={onRollback}>Rollback</Btn>
  const [label, tone] = STATUS_PILL[r.status] ?? [r.status, 'mu' as Tone]
  return <div className="border-b px-[14px] py-2.5 last:border-0" style={{ borderColor: C.ln2 }}>
    <div className="flex items-center gap-2">
      <button type="button" className="font-bold hover:underline" title="Deployment history" onClick={onOpen}>{r.version}</button>
      <span className="min-w-0 flex-1 truncate" title={r.notes ?? undefined}>{statusText(r)}</span>
      {inFlight ? <>
        <Btn s disabled={!canAct || busy || !!r.operation || r.status !== 'canary'} title={r.next_percent ? `Increase to ${r.next_percent}% of traffic` : undefined} onClick={onPromote}>Promote</Btn>
        {rollback}
      </> : <>
        <Pill t={tone}>{label}</Pill>
        {(r.status === 'failed' || (r.status === 'production' && r.rollback_to)) && rollback}
      </>}
    </div>
    {r.last_error && <small className="mt-0.5 block text-xs" style={{ color: C.ba }}>{r.last_error}</small>}
  </div>
}

// Prototype bars(..., {h: 130, vals: 1}): 400×130 frame capped at 1.5× height, dashed grid with axis values, rounded
// gradient columns with the value on top. Each server shows used storage now and the projection beside it; growth and
// time-to-full are in the tooltips so the card keeps the prototype's height.
function CapacityBars({ rows, days }: { rows: CapacityServer[]; days: number }) {
  const data = rows.filter(r => r.used_gb != null)
  if (!data.length) return <Empty>{rows.find(r => r.reason)?.reason ?? 'Collecting capacity samples…'}</Empty>
  const W = 400, H = 130, ml = 34, mb = 24, mt = 16, gap = 3
  const mx = niceMax(Math.max(...data.flatMap(r => [r.used_gb ?? 0, r.projected_gb ?? 0]), 0.001) * 1.04)
  const gw = (W - ml - 8) / data.length
  const projected = `color-mix(in srgb, ${C.ac} 45%, var(--bw-sf))`
  const y = (v: number) => mt + (H - mt - mb) * (1 - v / mx)
  const detail = (r: CapacityServer) => [
    `${gb(r.used_gb!)}${r.total_gb ? ` of ${gb(r.total_gb)}` : ''} ${r.kind === 'database' ? 'tenant databases' : 'disk'}`,
    r.growth_gb_per_day != null ? `${r.growth_gb_per_day >= 0 ? '+' : ''}${r.growth_gb_per_day.toFixed(2)} GB/day` : r.reason,
    r.days_to_full != null ? `full in ~${r.days_to_full} days` : null,
  ].filter(Boolean).join(' · ')
  return <>
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', overflow: 'visible', maxHeight: H * 1.5 }}>
      <defs>{[C.ac, projected].map((c, i) => <linearGradient key={i} id={`capg${i}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={c} /><stop offset="1" stopColor={c} stopOpacity=".62" /></linearGradient>)}</defs>
      {[0, .25, .5, .75, 1].map(g => <g key={g}>
        <line x1={ml} x2={W - 6} y1={y(mx * g)} y2={y(mx * g)} stroke="var(--bw-ln2)" strokeDasharray={g ? '3 3' : undefined} />
        <text x={ml - 6} y={y(mx * g) + 3} fontSize="9" textAnchor="end" fill="var(--bw-mu)">{gb(mx * g)}</text>
      </g>)}
      {data.map((r, i) => {
        const bars = [{ v: r.used_gb!, g: 0, t: 'Used now' }, ...(r.projected_gb != null ? [{ v: r.projected_gb, g: 1, t: `Projected in ${days} days` }] : [])]
        const bw = Math.min(gw * .6 / bars.length, 44), cx = ml + i * gw + gw / 2, x0 = cx - (bars.length * bw + (bars.length - 1) * gap) / 2
        return <g key={r.server} className="bgp">
          {bars.map((b, j) => { const h = Math.max(1, b.v / mx * (H - mt - mb)), x = x0 + j * (bw + gap); return <g key={j}>
            <rect x={x} y={H - mb - h} width={bw} height={h} fill={`url(#capg${b.g})`} rx={Math.min(5, bw / 2)}><title>{`${r.server} · ${b.t}: ${gb(b.v)}\n${detail(r)}`}</title></rect>
            <text x={x + bw / 2} y={H - mb - h - 4} fontSize="9.5" fontWeight="600" textAnchor="middle" fill="var(--bw-tx)">{gb(b.v)}</text>
          </g> })}
          <text x={cx} y={H - 8} fontSize="9.5" textAnchor="middle" fill="var(--bw-mu)">{r.server.slice(0, 10)}<title>{`${r.server} · ${detail(r)}`}</title></text>
        </g>
      })}
    </svg>
  </>
}

// Legend for the capacity chart, shown in the panel header so the card keeps the prototype's height.
const CapacityLegend = ({ days }: { days: number }) => <span className="lgd !mt-0 font-normal">
  <span><i style={{ background: C.ac }} />Used now</span><span><i style={{ background: `color-mix(in srgb, ${C.ac} 45%, var(--bw-sf))` }} />Projected in {days} days</span>
</span>

function NewReleaseModal({ data, onClose, onDone }: { data: InfrastructureOverview; onClose: () => void; onDone: (r: Release) => void }) {
  const { error: showError } = useToast()
  const production = data.pipeline.releases.find(r => r.status === 'production')
  const [version, setVersion] = useState(suggestVersion(production?.version))
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const { canary } = data.pipeline
  const v = version.trim()
  const problem = !VERSION_RE.test(v) ? 'Use a version like 2026.10.4 or 3.1.0' : production && !isNewer(v, production.version) ? `Must be newer than production ${production.version}` : data.pipeline.releases.some(r => r.version === v) ? 'This version is already in the release history' : ''
  const submit = async () => {
    setBusy(true)
    try { onDone((await platformApi.createRelease({ version: v, notes: notes.trim() || undefined })).data) }
    catch (err) { showError(errMsg(err, 'Release could not be started')) }
    finally { setBusy(false) }
  }
  return <BwModal title="New release" width={480} onClose={() => !busy && onClose()} foot={<>
    <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
    <Btn p disabled={busy || !!problem} onClick={() => void submit()}>{busy ? 'Validating…' : 'Validate & deploy'}</Btn>
  </>}>
    <div className="space-y-2.5">
      <Field label="Release version"><input className={inputCls} style={inputStyle} value={version} maxLength={40} autoFocus onChange={e => setVersion(e.target.value)} /></Field>
      {v && problem && <small className="-mt-1.5 block text-xs" style={{ color: C.ba }}>{problem}</small>}
      <Field label="Release notes"><textarea className="w-full rounded-md border px-2 py-1 text-[13px]" style={inputStyle} rows={3} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      <Kv rows={[
        ['Production', production ? production.version : 'None tracked yet'],
        ['Rollout', canary.enabled ? `Canary ${canary.initial_percent}%, then ${canary.steps.filter(s => s > canary.initial_percent).join(' → ')}%` : 'Straight to 100% (canary releases are off)'],
        ['Auto-rollback', canary.enabled && canary.auto_rollback ? 'On error spike' : 'Off'],
      ]} />
      <small className="block text-xs" style={{ color: C.mu }}>The deployment service first checks that this release can be deployed. Canary and auto-rollback follow Control Center → Release &amp; change management.</small>
    </div>
  </BwModal>
}

function HistoryModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [data, setData] = useState<{ release: Release; steps: ReleaseStep[] } | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => { platformApi.releaseSteps(id).then(({ data: d }) => setData(d)).catch(err => setError(errMsg(err, 'History unavailable'))) }, [id])
  const r = data?.release
  return <BwModal title={<>Release {r?.version ?? ''} {r && <Pill t={STATUS_PILL[r.status]?.[1] ?? 'mu'}>{STATUS_PILL[r.status]?.[0] ?? r.status}</Pill>}</>} width={680} onClose={onClose} foot={<Btn onClick={onClose}>Close</Btn>}>
    {error ? <Note>{error}</Note> : !data || !r ? <Empty>Loading…</Empty> : <>
      <Kv rows={[
        ['Rollout', `${r.rollout_percent}%`], ['Previous release', r.previous_version ?? '—'],
        ['Verified in production', r.verified_at ? fdt(r.verified_at) : '—'], ['Started by', r.created_by ?? '—'],
        ['Started', fdt(r.started_at)], ['Production since', fdt(r.production_at)], ['Ended', fdt(r.ended_at)], ['Notes', r.notes ?? '—'],
      ]} />
      <div className="mt-2.5"><Table head={['Started', 'Step', 'Result', 'By', 'Finished']} minWidth={560}>
        {data.steps.length === 0 ? <tr><td colSpan={5} className="text-center" style={{ color: C.mu }}>No deployment steps recorded</td></tr> : data.steps.map(s => <Fragment key={s.id}>
          <tr className="cursor-pointer" onClick={() => setOpen(open === s.id ? null : s.id)} title="Show deployment output">
            <td>{fdt(s.started_at)}</td>
            <td>{s.action === 'rollback' ? `Rollback to ${s.target_version}` : `${s.action === 'deploy' ? 'Deploy' : 'Promote'} ${s.from_percent ?? 0}% → ${s.to_percent}%`}{s.trigger === 'auto' ? ' (auto)' : ''}</td>
            <td><Pill t={s.status === 'succeeded' ? 'ok' : s.status === 'failed' ? 'ba' : 'inf'}>{s.status === 'running' ? 'Running' : s.status === 'succeeded' ? 'Succeeded' : 'Failed'}</Pill></td>
            <td>{s.actor ?? '—'}</td>
            <td>{fdt(s.finished_at)}</td>
          </tr>
          {open === s.id && <tr><td colSpan={5} className="!whitespace-normal">
            {s.message && <div className="mb-1 text-xs">{s.message}</div>}
            <pre className="max-h-[220px] overflow-auto rounded-md p-2 text-[11.5px] leading-[1.45]" style={{ background: '#0E1621', color: '#D3E4F6', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace' }}>{s.output || 'No output captured'}</pre>
          </td></tr>}
        </Fragment>)}
      </Table></div>
    </>}
  </BwModal>
}

export default function PlatformInfrastructurePage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<InfrastructureOverview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [history, setHistory] = useState<number | null>(null)
  const seq = useRef(0)
  const load = useCallback(async (refresh = false) => {
    const mine = ++seq.current
    try { const { data: next } = await platformApi.infrastructureOverview(refresh); if (mine === seq.current) { setData(next); setError('') } }
    catch (err) { if (mine === seq.current) setError(errMsg(err, 'Infrastructure & releases unavailable')) }
  }, [])
  const stepRunning = !!data?.pipeline.releases.some(r => r.operation)
  useEffect(() => {
    void load()
    const t = window.setInterval(() => { if (!document.hidden) void load() }, stepRunning ? BUSY_REFRESH_MS : REFRESH_MS)
    return () => window.clearInterval(t)
  }, [load, stepRunning])

  const service = data?.pipeline.service
  const canAct = can('infrastructure', 'manage') && !!data?.all_scope && !!service?.configured
  const denied = !can('infrastructure', 'manage') ? 'Your platform role can’t manage releases' : data && !data.all_scope ? 'Releases need all-tenant scope' : service && !service.configured ? service.error ?? undefined : undefined
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try { await fn(); success(done); await load() } catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy(false) }
  }
  const promote = (r: Release) => {
    if (!window.confirm(`Promote ${r.version} from ${r.rollout_percent}% to ${r.next_percent}% of traffic?`)) return
    void act(() => platformApi.promoteRelease(r.id), `Promotion of ${r.version} to ${r.next_percent}% started`)
  }
  const rollback = (r: Release) => {
    if (!window.confirm(`Roll back ${r.version} and restore ${r.rollback_to} on all servers?`)) return
    void act(() => platformApi.rollbackRelease(r.id), `Rollback to ${r.rollback_to} started`)
  }

  return <div>
    {creating && data && <NewReleaseModal data={data} onClose={() => setCreating(false)} onDone={r => { setCreating(false); success(`Release ${r.version} validated – deployment started`); void load() }} />}
    {history != null && <HistoryModal id={history} onClose={() => setHistory(null)} />}
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <div><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Data &amp; infrastructure</div><h1 className="text-xl font-semibold">Infrastructure &amp; releases</h1></div>
      <span className="flex-1" />
      <Btn p disabled={!canAct || busy || stepRunning} title={denied ?? (stepRunning ? 'A release step is running' : undefined)} onClick={() => setCreating(true)}><Ic n="up" /> New release</Btn>
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}

    {!data ? <Panel title="Infrastructure & releases"><Empty>{error || 'Loading…'}</Empty></Panel> : <>
      <div className="bw-g g21 mb-2">
        <Panel title="Services" flush>
          <Table head={['Service', 'Version', { t: 'Replicas', r: true }, 'CPU', 'Memory', 'Health']} minWidth={600}>
            {data.services.map(s => <tr key={s.name}>
              <td><b>{s.name}</b></td>
              <td title={s.version_source ?? undefined}>{s.version ?? <span style={{ color: C.mu }}>—</span>}</td>
              <td className="text-right">{s.replicas ?? <span style={{ color: C.mu }}>—</span>}</td>
              <td><UsageBar v={s.cpu} note={s.usage_note} /></td>
              <td><UsageBar v={s.memory} note={s.usage_note} /></td>
              <td><Pill t={HEALTH_TONE[s.health]} title={s.detail}>{s.health}</Pill></td>
            </tr>)}
          </Table>
        </Panel>
        <Panel title="Release pipeline" flush>
          {service && !service.configured && <div className="px-[14px] pt-2.5"><Note>{service.error}</Note></div>}
          {data.pipeline.releases.length === 0 ? <Empty>No releases recorded yet</Empty>
            : <div>{data.pipeline.releases.map(r => <ReleaseRow key={r.id} r={r} canAct={canAct} busy={busy}
              onPromote={() => promote(r)} onRollback={() => rollback(r)} onOpen={() => setHistory(r.id)} />)}</div>}
        </Panel>
      </div>
      <Panel title="Capacity forecast" act={data.capacity.servers.some(r => r.used_gb != null) && <CapacityLegend days={data.capacity.forecast_days} />}><CapacityBars rows={data.capacity.servers} days={data.capacity.forecast_days} /></Panel>
    </>}
  </div>
}
