// Funnel & analytics (prototype v17) – typed calls to /api/v1/funnel. Phase 1 of 5: the "Funnel" view
// (KPI strip, stage funnel, split-by, stage×dimension matrix, stuck-beyond-SLA, records table, export).
// Journey & trends / Segment / Vertical / Customer / Leadership analytics ship in later phases.
import api from '@/services/api'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

export interface Meta { objects: string[]; periods: string[]; dimensions: { key: string; label: string }[]; owners: { id: number; name: string }[] }
export interface Flow { key: string; name: string }
export interface Step { l: string; n: number; v: number; sla: number | null; cv: number | null }
export interface Kpi {
  entry_n: number; entry_v: number; reached_last: number; conversion_pct: number; win_rate_pct: number
  open_n: number; open_v: number; biggest_leak: string | null; biggest_leak_pct: number | null; stuck_n: number; stuck_v: number
}
export interface Board { kpi: Kpi; steps: Step[]; row_count: number }
export interface SplitGroup { group: string; n: number; value: number; open: number; won: number; lost: number; open_value: number; won_value: number; win_rate_pct: number; share_pct: number }
export interface Matrix { cols: string[]; rows: { group: string; cells: number[] }[]; max: number }
export interface DrillResult { split: SplitGroup[]; matrix: Matrix }
export interface StuckRow { id: number; type: string; name: string; stage: string; age_days: number; sla_days: number | null; owner: string; owner_id: number | null; value: number }
export interface RecordRow { id: number; type: string; name: string; customer: string; segment: string | null; sub_segment: string | null; vertical: string | null; model: string | null; stage: string; value: number; owner: string }

export interface FunnelQuery {
  obj: string; period: string; flow?: string; open_only?: boolean; owner_id?: number; drill?: string
}

const qs = (p: FunnelQuery) => ({ obj: p.obj, period: p.period, flow: p.flow, open_only: p.open_only, owner_id: p.owner_id, drill: p.drill })

export interface SankeyNode { id: string; col: number; label: string; n: number }
export interface SankeyLink { source: string; target: string; value: number }
export interface Sankey { nodes: SankeyNode[]; links: SankeyLink[] }
export interface Trend { labels: string[]; leads_created: number[]; leads_converted: number[]; deals_won: number[] }
export interface FlowRow { name: string; object: string; n: number; open: number; win_rate_pct: number; value: number }
export interface AgeingRow { stage: string; avg_age: number; n: number; sla: number | null; breach: boolean }
export interface Journey {
  kpi: Kpi & { weighted_pipeline: number; leakage_value: number }
  steps: Step[]; sankey: Sankey; trend: Trend; by_flow: FlowRow[]; lost_reasons: { l: string; v: number }[]; tender_ageing: AgeingRow[]
}

export const funnelApi = {
  // prototype v17 Funnel & analytics – every view's rows (GET /funnel/data)
  data: () => api.get<import('./funnelViews').ModuleData>('/funnel/data').then(r => r.data),
  meta: () => api.get<Meta>('/funnel/meta').then(r => r.data),
  flows: (obj: string) => api.get<{ items: Flow[] }>('/funnel/flows', { params: { obj } }).then(r => r.data.items),
  board: (p: FunnelQuery) => api.get<Board>('/funnel/board', { params: qs(p) }).then(r => r.data),
  drill: (p: FunnelQuery, dim: string) => api.get<DrillResult>('/funnel/drill', { params: { ...qs(p), dim } }).then(r => r.data),
  stuck: (p: FunnelQuery) => api.get<{ items: StuckRow[] }>('/funnel/stuck', { params: qs(p) }).then(r => r.data.items),
  records: (p: FunnelQuery, extra: { q?: string; sort?: string; offset?: number; limit?: number }) =>
    api.get<{ items: RecordRow[]; total: number }>('/funnel/records', { params: { ...qs(p), ...extra } }).then(r => r.data),
  exportCsv: (p: FunnelQuery) => api.get('/funnel/export', { params: qs(p), responseType: 'blob' }).then(r => r.data as Blob),
  journey: (period: string) => api.get<Journey>('/funnel/journey', { params: { period } }).then(r => r.data),
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
