// Forecasts – prototype v17 R.forecast(): crumb "Sales" · "Forecasts" · period chips (FY 2026-27 · Q3 · Q4, generated from the
// fiscal calendar) · Submit forecast; KPI strip Quota | Closed won | Commit (≥70%) | Best case (40–69%) | Pipeline (<40%) | Gap to quota;
// g21 grid: "Forecast by rep" (Rep | Quota | Closed | Commit | Best case | Pipeline | Manager adj. | Attainment, adjustment edited inline)
// and "Composition" (doughnut Closed / Commit / Best case / Pipeline, centre = (Closed + Commit) / Quota).
// All values come from /api/v1/forecasts/summary in one request; an adjustment save returns the recalculated summary.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useToast } from '@/components/ui/ToastContext'
import { Av, BarPct, Donut } from '@/pages/customers/kit'
import { errMsg, forecastApi, inr, type RepRow, type Summary } from './forecastApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './forecasts.css'

const PERIOD_KEY = 'forecasts:period'
const store = {
  get: (): string | undefined => { try { return sessionStorage.getItem(PERIOD_KEY) || undefined } catch { return undefined } },
  set: (v: string) => { try { sessionStorage.setItem(PERIOD_KEY, v) } catch { /* private mode */ } },
}
const pct = (v: number | null | undefined) => v == null ? '—' : `${Math.round(v)}%`

export default function ForecastsPage() {
  const { success, error } = useToast()
  const [data, setData] = useState<Summary | null>(null)
  const [period, setPeriod] = useState<string | undefined>(store.get)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const seq = useRef(0)

  const load = useCallback((key?: string) => {
    const my = ++seq.current
    setLoading(true)
    forecastApi.summary(key)
      .then(s => { if (my === seq.current) { setData(s); setPeriod(s.period.key) } })
      .catch(e => {
        if (my !== seq.current) return
        if (key && e?.response?.status === 422) { store.set(''); load(undefined); return }   // stale saved period
        error(errMsg(e, 'Could not load the forecast'))
      })
      .finally(() => { if (my === seq.current) setLoading(false) })
  }, [error])

  useEffect(() => { load(period) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (period) store.set(period) }, [period])

  // prototype A.fper: select the period → every KPI, row and the doughnut refresh
  const pick = (key: string) => { if (key === period && data) return; setPeriod(key); load(key) }

  // a saved adjustment returns the recalculated summary (attainment, KPIs, Gap to quota, doughnut) – applied only if that
  // period is still the one on screen
  const onSaved = useCallback((s: Summary) => setData(d => (d && d.period.key !== s.period.key ? d : s)), [])

  const submit = async () => {
    if (!data || submitting) return
    setSubmitting(true)
    try {
      const r = await forecastApi.submit(data.period.key)
      success(r.message)
      setData(d => d && d.period.key === r.submission.period ? { ...d, submission: r.submission } : d)
    } catch (e) { error(errMsg(e, 'Could not submit the forecast')) }
    finally { setSubmitting(false) }
  }

  const k = data?.kpis
  const v = (n: number | undefined) => data ? inr(n) : '—'
  const th = data?.thresholds || { commit: 70, best: 40 }
  const sub = data?.submission
  const submitTitle = !data ? undefined : !data.can.submit ? 'You do not have permission to submit forecasts'
    : sub ? `Last submitted: v${sub.version} · ${sub.status === 'pending' ? `waiting for ${sub.approver || 'approval'}` : sub.status}` : `Submit the ${data.period.full} forecast for approval`

  return <div className="bwi fcst">
    <div className="pg">
      <div><div className="crumb">Sales</div><h1>Forecasts</h1></div>
      <span className="fl" />
      {(data?.periods || []).map(p => <span key={p.key} className={`chip ${p.key === period ? 'on' : ''}`} title={p.full} role="button" tabIndex={0}
        onClick={() => pick(p.key)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(p.key) } }}>{p.label}</span>)}
      <button className="btn p" onClick={submit} disabled={!data || !data.can.submit || submitting || loading} title={submitTitle}>
        {submitting ? 'Submitting…' : 'Submit forecast'}
      </button>
    </div>

    <div className={loading && data ? 'fbusy' : undefined} aria-busy={loading}>
      {/* prototype strip(): six KPI cards, one row */}
      <div className="strip">
        <div className="st"><div className="sth"><label>Quota</label></div><b>{v(k?.quota)}</b></div>
        <div className="st tok"><div className="sth"><label>Closed won</label></div><b>{v(k?.closed)}</b>{data && <i className="tok">{pct(k?.closed_pct)}</i>}</div>
        <div className="st"><div className="sth"><label>Commit (≥{th.commit}%)</label></div><b>{v(k?.commit)}</b></div>
        <div className="st"><div className="sth"><label>Best case ({th.best}–{th.commit - 1}%)</label></div><b>{v(k?.best_case)}</b></div>
        <div className="st"><div className="sth"><label>Pipeline (&lt;{th.best}%)</label></div><b>{v(k?.pipeline)}</b></div>
        <div className="st tbad"><div className="sth"><label>Gap to quota</label></div><b>{v(k?.gap)}</b></div>
      </div>

      <div className="g g21">
        <div className="panel">
          <div className="ph">Forecast by rep<span className="fl" /><small>Edit the manager adjustment inline</small></div>
          <div className="tw fit"><table className="t">
            <thead><tr><th>Rep</th><th className="r">Quota</th><th className="r">Closed</th><th className="r">Commit</th><th className="r">Best case</th>
              <th className="r">Pipeline</th><th className="r">Manager adj.</th><th>Attainment</th></tr></thead>
            <tbody>
              {!data ? <tr><td colSpan={8} className="empty">{loading ? 'Loading…' : 'The forecast could not be loaded.'}</td></tr>
                : !data.rows.length ? <tr><td colSpan={8} className="empty">No quotas or deals for {data.period.full}.</td></tr>
                : data.rows.map(r => <tr key={r.rep_id}>
                  <td title={r.name}><span className="row" style={{ gap: 5, display: 'inline-flex' }}><Av name={r.name} /><span className="rn">{r.name}</span></span></td>
                  <td className="r">{inr(r.quota)}</td><td className="r">{inr(r.closed)}</td><td className="r">{inr(r.commit)}</td>
                  <td className="r">{inr(r.best_case)}</td><td className="r">{inr(r.pipeline)}</td>
                  <td className="r"><AdjInput row={r} period={data.period.key} data={data} onSaved={onSaved} /></td>
                  <td title={r.attainment == null ? 'No quota assigned for this period' : undefined}>
                    {r.attainment == null ? <><span className="bar"><i style={{ width: 0 }} /></span>—</> : <BarPct v={r.attainment} />}
                  </td>
                </tr>)}
            </tbody>
          </table></div>
        </div>
        <div className="panel">
          <div className="ph">Composition</div>
          <div className="pb">
            <Donut f={inr} c={data ? pct(data.composition.center) : '—'}
              d={(data?.composition.items || [{ l: 'Closed', v: 0 }, { l: 'Commit', v: 0 }, { l: 'Best case', v: 0 }, { l: 'Pipeline', v: 0 }])
                .map(x => ({ ...x, c: COMP[x.l] }))} />
          </div>
        </div>
      </div>
    </div>
  </div>
}

// prototype donut colours: Closed var(--ok) · Commit var(--ac) · Best case var(--wa) · Pipeline var(--ln)
const COMP: Record<string, string> = { Closed: 'var(--bw-ok)', Commit: 'var(--bw-ac)', 'Best case': 'var(--bw-wa)', Pipeline: 'var(--bw-ln)' }

/** prototype `<input class="in sm" type="number" style="width:100px;text-align:right" data-c="fadj">` – saved on change (blur / Enter). */
function AdjInput({ row, period, data, onSaved }: { row: RepRow; period: string; data: Summary; onSaved: (s: Summary) => void }) {
  const { success, error } = useToast()
  const [val, setVal] = useState(String(row.adjustment))
  const [state, setState] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle')
  const saved = useRef(row.adjustment)
  useEffect(() => { saved.current = row.adjustment; if (state !== 'saving') setVal(String(row.adjustment)) }, [row.adjustment]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (state !== 'ok' && state !== 'err') return; const t = setTimeout(() => setState('idle'), 1600); return () => clearTimeout(t) }, [state])

  const commit = async () => {
    const raw = val.trim() === '' ? '0' : val.trim()
    const n = Number(raw)
    if (!Number.isFinite(n)) { error('Enter a numeric adjustment'); setVal(String(saved.current)); setState('err'); return }
    if (Math.round(n * 100) === Math.round(saved.current * 100)) { setVal(String(saved.current)); return }
    setState('saving')
    try {
      const r = await forecastApi.adjust(period, row.rep_id, raw)
      saved.current = r.amount
      setVal(String(r.amount))
      setState('ok')
      onSaved(r.summary)
      success(`Manager adjustment for ${row.name} saved`)
    } catch (e) {
      setVal(String(saved.current)); setState('err')
      error(errMsg(e, 'Could not save the adjustment'))
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
    else if (e.key === 'Escape') { setVal(String(saved.current)); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()) }
  }
  const why = !data.can.adjustments_enabled ? 'Manager adjustments are switched off in Forecast settings'
    : data.locked ? 'The forecast is locked – the period has started'
    : !row.editable ? 'Only managers with forecast adjustment rights can edit this' : undefined
  return <input className={`in sm fadj ${state}`} type="number" step="any" style={{ width: 100, textAlign: 'right' }} value={val}
    disabled={!row.editable || state === 'saving'} title={why} aria-label={`Manager adjustment for ${row.name}`} aria-busy={state === 'saving'}
    onChange={e => setVal(e.target.value)} onBlur={() => { if (row.editable && state !== 'saving') void commit() }} onKeyDown={onKey} />
}
