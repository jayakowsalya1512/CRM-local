// Intelligence → Funnel & analytics – prototype v17 R.funnel (p33/p34): crumb "Intelligence", "Funnel & analytics", six view
// buttons (Funnel · Journey & trends · Segment analytics · Vertical analytics · Customer analytics · Leadership) and the view.
// "Funnel" is the prototype funnelBoard() – the same component as the dashboard's Funnel tab. All figures come from
// GET /api/v1/funnel/data: each module's own permissions and Data Visibility decide which records are included.
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { PageHead } from '@/components/platform/bw'
import { FunnelBoard } from '@/pages/dashboard/v9/boards/Funnel'
import '@/pages/dashboard/v9/dashboards.css'
import '@/pages/dashboard/v9/boards/funnel.css'
import { errMsg, funnelApi } from './funnelApi'
import { CustomerView, JourneyView, LeadershipView, SegmentView, VerticalView, type ModuleData } from './funnelViews'
import './funnel.css'

const FVIEWS: [string, string][] = [['Funnel', 'funnel'], ['Journey & trends', 'route'], ['Segment analytics', 'layout'], ['Vertical analytics', 'chart'], ['Customer analytics', 'building'], ['Leadership', 'spark']]

export default function FunnelAnalyticsPage() {
  const [sp, setSp] = useSearchParams()
  const view = FVIEWS.some(v => v[0] === sp.get('view')) ? String(sp.get('view')) : 'Funnel'
  const [d, setD] = useState<ModuleData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [drill, setDrill] = useState<{ k: number; v: [string, string][] }>({ k: 0, v: [] })
  useEffect(() => {
    let alive = true
    funnelApi.data().then(x => { if (alive) setD(x) }).catch(e => { if (alive) setErr(errMsg(e, 'Could not load the funnel')) })
    return () => { alive = false }
  }, [])
  const setView = (v: string) => { const n = new URLSearchParams(sp); if (v === 'Funnel') n.delete('view'); else n.set('view', v); setSp(n, { replace: true }) }
  // Journey & trends → click a segment / vertical / customer row: open the Funnel view drilled into it (prototype fdGo)
  const go = (dim: string, v: string) => { setDrill(x => ({ k: x.k + 1, v: [[dim, v]] })); setView('Funnel') }

  return <div className="bwd fmod">
    <PageHead crumb="Intelligence" title="Funnel & analytics" cnt="stages · customer segments · business verticals · customers · leadership" />
    <div className="fvt" role="tablist">{FVIEWS.map(([v, i]) => <button key={v} type="button" role="tab" aria-selected={v === view} className={v === view ? 'on' : ''} onClick={() => setView(v)}><Ic n={i} size={15} /> {v}</button>)}</div>
    {err ? <div className="bw-panel"><div className="pb"><div className="fempty">{err}</div></div></div>
      : !d ? <div className="bw-panel"><div className="pb"><div className="fempty">Loading…</div></div></div>
        : <div className="fnm">
          {view === 'Journey & trends' ? <JourneyView d={d} go={go} toFunnel={() => setView('Funnel')} />
            : view === 'Segment analytics' ? <SegmentView d={d} />
              : view === 'Vertical analytics' ? <VerticalView d={d} />
                : view === 'Customer analytics' ? <CustomerView d={d} />
                  : view === 'Leadership' ? <LeadershipView d={d} />
                    : <FunnelBoard key={drill.k} d={d} initDrill={drill.v} />}
        </div>}
  </div>
}
