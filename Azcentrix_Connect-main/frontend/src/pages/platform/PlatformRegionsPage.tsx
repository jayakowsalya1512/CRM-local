import { useCallback, useEffect, useState } from 'react'
import { platformApi, type FailoverTestResult, type RegionRow, type RegionsOverview } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Ic, Loading, Note, PageHead, Panel, Pill, Strip, Table, errMsg, fdt, inr, num, useKpiPopup, type Tone } from '@/components/platform/bw'
import { HBars, LineChart, PAL } from '@/components/platform/charts'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout, labels and actions follow the Bidwise prototype v9 Regions & capacity page (P.regions, A.regNew, A.regGo).
// Regions are the self-hosted server registry (PLATFORM_SERVERS); "DB shards" are the MariaDB servers holding tenant
// databases; utilisation is the measured disk use of those servers. Nothing is simulated.
const statusTone = (s: string): Tone => s === 'Healthy' ? 'ok' : s === 'Planned' ? 'inf' : s === 'Degraded' ? 'wa' : 'ba'
const barColor = (v: number) => v > 80 ? 'var(--bw-ba)' : v > 65 ? 'var(--bw-wa)' : 'var(--bw-ok)'
// Prototype bar(): 60 px track, accent fill, percentage after it.
const UsageBar = ({ v }: { v: number }) => <span className="whitespace-nowrap">
  <span className="mr-[5px] inline-block h-1.5 w-[60px] overflow-hidden rounded align-middle" style={{ background: C.ln2 }}><i className="block h-full rounded" style={{ width: `${Math.min(100, v)}%`, background: C.ac }} /></span>{Math.round(v)}%
</span>

function FailoverResult({ region, result, onClose }: { region: string; result: FailoverTestResult; onClose: () => void }) {
  return <BwModal title={<>Failover test · {region} <Pill t={result.passed ? 'ok' : 'ba'}>{result.passed ? 'Passed' : 'Failed'}</Pill></>} width={560} onClose={onClose} foot={<Btn onClick={onClose}>Close</Btn>}>
    <p className="mb-2">{result.summary}. This was a readiness check – nothing was failed over.</p>
    <Table head={['Replica', 'Primary', { t: 'Lag', r: true }, 'Result']} minWidth={440}>
      {result.checks.map(c => <tr key={c.server}><td><b>{c.server}</b></td><td>{c.primary ?? '—'}</td><td className="text-right">{c.lag_seconds == null ? '—' : `${c.lag_seconds} s`}</td>
        <td>{c.passed ? <Pill t="ok">Ready</Pill> : <span style={{ color: C.ba }}>{c.problems.join('; ')}</span>}</td></tr>)}
    </Table>
    <div className="mt-2">{result.backups.problems.length ? <Note>{result.backups.problems.map(p => <div key={p}>{p}</div>)}</Note>
      : <Note info>All {result.backups.tenants} tenant backup(s) in this region are recent and available.</Note>}</div>
  </BwModal>
}

export default function PlatformRegionsPage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<RegionsOverview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState<RegionRow | null>(null)
  const [result, setResult] = useState<{ region: string; r: FailoverTestResult } | null>(null)
  const [openKpi, kpiPopup] = useKpiPopup()

  // Loaded on open and after an action – the page probes every server, so it does not poll.
  const load = useCallback(async () => {
    try { const { data } = await platformApi.regions(); setData(data); setError('') }
    catch (err) { setError(errMsg(err, 'Regions & capacity unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])

  const canManage = can('infrastructure', 'manage')
  const addRegion = async () => {
    setBusy('add')
    try { const { data: r } = await platformApi.addRegion(); success(`Region ${r.region} added to the plan`); await load() }
    catch (err) { showError(errMsg(err, 'The region could not be added')) } finally { setBusy('') }
  }
  const runTest = async (row: RegionRow) => {
    setBusy(row.region)
    try { const { data: r } = await platformApi.regionFailoverTest(row.region); setResult({ region: row.region, r }); await load() }
    catch (err) { showError(errMsg(err, 'The failover test could not run')) } finally { setBusy('') }
  }

  const k = data?.kpis
  const live = data?.regions.filter(r => !r.planned) ?? []
  const fc = data?.forecast
  const series = (fc?.series ?? []).flatMap((s, i) => [
    { n: s.region, c: PAL[i % PAL.length], v: s.measured },
    ...(s.projected ? [{ n: `${s.region} · forecast`, c: PAL[i % PAL.length], v: s.projected, dash: true, fill: false }] : []),
  ])
  const addTitle = !canManage ? 'Needs Infrastructure manage access' : data && !data.add_region.available ? data.add_region.reason ?? undefined : data?.add_region.next ? `Adds ${data.add_region.next} as Planned` : undefined

  const measured = live.filter(r => r.utilisation != null)

  return <div>
    {kpiPopup}
    {confirm && <BwModal title="Test failover" width={480} onClose={() => setConfirm(null)} foot={<><Btn onClick={() => setConfirm(null)}>Cancel</Btn>
      <Btn p onClick={() => { const r = confirm; setConfirm(null); void runTest(r) }}>Run test</Btn></>}>
      <p>Check whether <b>{confirm.region}</b> could fail over: every replica must be running, within the replication-lag alert and read-only, and every tenant in the region needs a recent, available backup. Production databases are not interrupted and nothing is failed over. The result is recorded in the audit trail.</p>
    </BwModal>}
    {result && <FailoverResult region={result.region} result={result.r} onClose={() => setResult(null)} />}

    <PageHead crumb="Data & infrastructure" title="Regions & capacity">
      <Btn p onClick={() => void addRegion()} disabled={!data || !canManage || !data.add_region.available || !!busy} title={addTitle}><Ic n="plus" /> Add region</Btn>
    </PageHead>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}

    <Strip items={[
      { l: 'Regions live', v: k ? num(k.regions_live) : '—', kpi: 'regions.live' },
      { l: 'DB shards', v: k ? num(k.db_shards) : '—', title: 'MariaDB servers that hold tenant databases', kpi: 'regions.db_shards' },
      { l: 'Avg utilisation', v: k ? (k.avg_utilisation == null ? '—' : `${Math.round(k.avg_utilisation)}%`) : '—', title: 'Disk use of the region servers (hourly capacity samples)', kpi: 'regions.avg_utilisation' },
      { l: 'Monthly infra cost', v: k ? (k.monthly_cost == null ? '—' : inr(k.monthly_cost)) : '—', title: k && k.monthly_cost == null ? 'Set monthly_cost on the PLATFORM_SERVERS entries to show it' : undefined, kpi: 'regions.monthly_cost' },
      { l: 'Shards above 80%', v: k ? num(k.shards_above_80) : '—', dc: k && k.shards_above_80 ? 'tbad' : 'tok', kpi: 'regions.shards_above_80' },
    ]} />

    <div className="bw-g g2 mb-2">
      <Panel title="Capacity by region">
        {!data ? <Loading /> : live.some(r => r.utilisation != null)
          ? <HBars lw={110} vw={44} onPick={i => openKpi({ kpi: 'regions.avg_utilisation', title: `Utilisation · ${measured[i].region}`, value: `${Math.round(measured[i].utilisation!)}%`, query: { facet: measured[i].region } })}
              rows={measured.map(r => ({ l: r.region, v: r.utilisation, text: `${Math.round(r.utilisation!)}%`, c: barColor(r.utilisation!),
              note: `${r.servers.join(', ')} · ${r.utilisation_source ?? ''}` }))} />
          : <Empty>No utilisation measured yet</Empty>}
      </Panel>
      <Panel title="Capacity forecast">
        {!data ? <Loading /> : !series.length ? <Empty>{fc?.notes[0] ?? 'No utilisation history yet'}</Empty> : <>
          <LineChart h={160} labels={fc!.labels} series={series} f={v => `${Math.round(v)}%`} />
          {fc!.notes.length > 0 && <small className="mt-1 block" style={{ color: C.mu }}>{fc!.notes.join(' · ')}</small>}
        </>}
      </Panel>
    </div>

    <Panel title="Regions" flush>
      {!data ? (error ? <Empty>{error}</Empty> : <Loading />) : !data.regions.length ? <Empty>No regions in the server registry</Empty> :
        <Table head={['Region', 'City', 'Residency', { t: 'Shards', r: true }, 'Utilisation', { t: 'Tenants', r: true }, { t: 'Latency', r: true }, { t: 'Cost / month', r: true }, 'Status', 'Actions']} minWidth={1000}>
          {data.regions.map(r => <tr key={r.region}>
            <td><b>{r.region}</b></td>
            <td>{r.city ?? <span style={{ color: C.mu }}>—</span>}</td>
            <td>{r.residency ?? <span style={{ color: C.mu }}>—</span>}</td>
            <td className="text-right" title={r.servers.join(', ')}>{r.shards}</td>
            <td title={r.utilisation_source ?? undefined}>{r.planned || r.utilisation == null ? <span style={{ color: C.mu }}>—</span> : <UsageBar v={r.utilisation} />}</td>
            <td className="text-right">{num(r.tenants)}</td>
            <td className="text-right" title={r.latency_source ?? undefined}>{r.latency_ms == null ? '—' : `${Math.round(r.latency_ms)} ms`}</td>
            <td className="text-right" title={r.cost == null ? 'Not configured (monthly_cost in PLATFORM_SERVERS)' : undefined}>{r.cost == null ? '—' : inr(r.cost)}</td>
            <td><Pill t={statusTone(r.status)}>{r.status}</Pill></td>
            <td className="whitespace-nowrap">{r.planned
              ? <Btn s p disabled={!r.provision?.available || !canManage} title={r.provision?.reason ?? undefined}>Provision</Btn>
              : <Btn s disabled={!r.failover.available || !canManage || !!busy} onClick={() => setConfirm(r)}
                  title={!canManage ? 'Needs Infrastructure manage access' : r.failover.reason ?? (r.last_failover ? `Last test ${fdt(r.last_failover.at)}: ${r.last_failover.summary}` : undefined)}>
                  {busy === r.region ? 'Testing…' : 'Test failover'}</Btn>}</td>
          </tr>)}
        </Table>}
    </Panel>
  </div>
}
