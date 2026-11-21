import { useCallback, useEffect, useRef, useState } from 'react'
import { platformApi, type JobsOverview } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, C, Empty, Note, Panel, Pill, Strip, Table, errMsg, fdt, num } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout, KPIs, tables and actions follow the Bidwise prototype Jobs & queues page (P.jobs).
// Queues are the Celery queues on the Redis broker; scheduled jobs are the platform's own background loops.
const REFRESH_MS = 10_000
const age = (s: number | null) => s == null ? '—' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
const ms = (v: number | null) => v == null ? '' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`

export default function PlatformJobsPage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<JobsOverview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const seq = useRef(0)
  const load = useCallback(async (refresh = false) => {
    const mine = ++seq.current
    try { const { data: next } = await platformApi.jobsOverview(refresh); if (mine === seq.current) { setData(next); setError('') } }
    catch (err) { if (mine === seq.current) setError(errMsg(err, 'Jobs & queues unavailable')) }
  }, [])
  useEffect(() => {
    void load()
    const t = window.setInterval(() => { if (!document.hidden) void load() }, REFRESH_MS)
    return () => window.clearInterval(t)
  }, [load])
  const canAct = can('jobs', 'manage') && !!data?.all_scope
  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key)
    try { await fn(); success(done); await load(true) } catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy('') }
  }

  const k = data?.kpis
  const brokerDown = !!data && !data.broker.ok
  const dash = (title: string) => <span title={title} style={{ color: C.mu }}>—</span>
  const brokerNote = data?.broker.error ?? 'Broker unreachable'

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2"><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Data &amp; infrastructure</div><h1 className="text-xl font-semibold">Jobs &amp; queues</h1></div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}

    <Strip items={[
      { l: 'Queued', v: !k ? '—' : k.queued == null ? dash(brokerNote) : num(k.queued), kpi: 'jobs.queued' },
      { l: 'Running', v: !k ? '—' : <span title={`${k.running_tasks ?? '—'} queue task(s) · ${k.running_jobs} scheduled job(s)`}>{num(k.running)}</span>, kpi: 'jobs.running' },
      { l: 'Failed · 24h', v: !k ? '—' : <span style={{ color: k.failed_24h ? C.wa : undefined }} title={`${k.failed_tasks_24h ?? '—'} queue task(s) · ${k.failed_jobs_24h} scheduled run(s)`}>{num(k.failed_24h)}</span>, kpi: 'jobs.failed' },
      { l: 'Dead-letter', v: !k ? '—' : k.dead_letter == null ? dash(brokerNote) : <span style={{ color: k.dead_letter ? C.ba : undefined }}>{num(k.dead_letter)}</span>, kpi: 'jobs.dead_letter' },
      { l: 'Throughput', v: !k ? '—' : <span title={`${k.tasks_per_min ?? '—'} queue tasks + ${k.job_runs_per_min} scheduled runs per minute (last 15 min)`}>{k.throughput_per_min} / min</span>, kpi: 'jobs.throughput' },
    ]} />

    {!data ? <Panel title="Jobs & queues"><Empty>{error || 'Loading…'}</Empty></Panel> : <div className="grid gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Panel title="Queues" flush act={data.broker.ok ? <small style={{ color: data.workers.ok ? C.mu : C.wa }} title={data.workers.names.join(', ') || undefined}>
        {data.workers.ok ? `${data.workers.count} worker${data.workers.count === 1 ? '' : 's'} · ${data.broker.url}` : 'No workers online'}</small> : undefined}>
        {brokerDown ? <div className="p-2.5"><Note>{data.broker.error} – queued e-mail and push notifications can’t be sent until the Redis broker is running.</Note></div>
          : <>{!data.workers.ok && <div className="px-2.5 pt-2.5"><Note>{data.workers.error}</Note></div>}
            <Table head={['Queue', { t: 'Depth', r: true }, { t: 'Workers', r: true }, { t: 'Rate / min', r: true }, { t: 'Failed', r: true }, { t: 'Oldest', r: true }, '']} minWidth={640}>
              {data.queues.map(q => <tr key={q.name}>
                <td><b>{q.name}</b>{q.paused && <> <Pill t="wa">Paused</Pill></>}</td>
                <td className="text-right">{num(q.depth)}</td>
                <td className="text-right">{num(q.workers)}</td>
                <td className="text-right">{q.rate_per_min}</td>
                <td className="text-right" title={`${q.failed_24h} failed and ${q.retries_24h} retried in 24 h · ${q.dead_letter} waiting in dead-letter`}>{num(q.failed_24h)}</td>
                <td className="text-right">{q.depth ? age(q.oldest_seconds) : '—'}</td>
                <td className="whitespace-nowrap text-right">
                  {q.paused ? <Btn s disabled={!canAct || busy === `r${q.name}`} onClick={() => void act(`r${q.name}`, () => platformApi.resumeQueue(q.name), `${q.name} resumed`)}>Resume</Btn>
                    : <Btn s disabled={!canAct || !q.workers || busy === `p${q.name}`} title={!q.workers ? 'No worker consumes this queue' : undefined} onClick={() => void act(`p${q.name}`, () => platformApi.pauseQueue(q.name), `${q.name} paused`)}>Pause</Btn>}{' '}
                  <Btn s disabled={!canAct || !q.dead_letter || busy === `x${q.name}`} title={q.dead_letter ? `${q.dead_letter} failed task(s) waiting` : 'No failed tasks waiting'} onClick={() => void act(`x${q.name}`, async () => { const { data: r } = await platformApi.retryQueue(q.name); return r }, `Failed tasks in ${q.name} re-sent`)}>Retry failed</Btn>
                </td>
              </tr>)}
            </Table></>}
      </Panel>
      <Panel title="Scheduled jobs" flush>
        <div>{data.scheduled.map(j => <div key={j.key} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}>
          <span className="min-w-0 flex-1"><b>{j.name}</b><br />
            <small style={{ color: j.last_status === 'failed' ? C.ba : C.mu }} title={j.last_error ?? j.last_result ?? undefined}>
              {j.schedule}{j.running ? ' · running now' : j.last_run_at ? ` · last ${fdt(j.last_run_at)} ${j.last_status === 'failed' ? 'failed' : 'ok'}${j.last_duration_ms != null ? ` in ${ms(j.last_duration_ms)}` : ''}` : ' · not run yet'}
              {j.failed_24h ? ` · ${j.failed_24h} of ${j.runs_24h} failed in 24 h` : ''}
            </small></span>
          <Btn s disabled={!canAct || j.running || busy === `j${j.key}`} onClick={() => void act(`j${j.key}`, () => platformApi.runScheduledJob(j.key), `${j.name} triggered`)}>Run now</Btn>
        </div>)}</div>
      </Panel>
    </div>}
  </div>
}
