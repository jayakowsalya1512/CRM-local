// Bids & Tenders (prototype v17 · Sales → Bids & Tenders) – /api/v1/bids
import api from '@/services/api'
export { errMsg, errDetail, inr, fd, dto, todayIso, stagePill } from '@/pages/deals/dealApi'

export interface Stage { id: number; name: string; kind: 'open' | 'won' | 'lost'; sla: number; gate: 'None' | 'Approval' | 'Checklist'; owner_role: string | null; checklist: string[]; flow: string; tenders?: number }
/** A tender & bid flow (prototype Process Designer) with its own stages. */
export interface Flow { key: string; name: string; default: boolean; active: boolean; stages: Stage[] }
/** A board column: one stage name merged across flows (prototype WFS()), with that stage's id in each flow. */
export interface BoardCol { name: string; kind: 'open' | 'won' | 'lost'; sla: number; gate: 'None' | 'Approval' | 'Checklist'; checklist: string[]; ids: Record<string, number> }
export interface Journey { id: string; steps: { k: string; label: string; done: boolean; stage: string | null; ref?: string | null; me?: boolean }[] }
export interface Meta {
  company: string | null; views: string[]; flows: Flow[]; board: BoardCol[]; stages: { name: string; kind: string; gate: string }[]
  me: { id: number; name: string }; lost: { required: boolean; reasons: string[] }
  config: { gst_pct: number; emd_default_pct: number; reminder_days: number[] }
  can: { create: boolean; update: boolean; delete: boolean; export: boolean; documents: boolean; workorders: boolean; configure: boolean }
}
export interface Row {
  id: number; ref: string; title: string; nit: string; customer: string; customer_id: number | null; portal: string; portal_id: number | null
  value: number; emd: number; stage: string; stage_id: number; stage_kind: string; submit: string | null; owner: string; owner_id: number | null
  pending: boolean; sla: 'ok' | 'due' | 'breached' | null
  /** prototype Journey · Flow · Vertical columns */
  flow: string; flow_key: string; vertical: string; jid: string; journey: Journey
}
export interface ListParams { view: string; stage: string; q: string; f: Record<string, string>; adv: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] }; sorts: [string, number][]; offset: number; limit: number }
export type Ref = { id: number; name: string } | null
export interface Line { id: number; item: string; product_id: number | null; oem_id: number | null; oem: string; qty: number; rate: number; amount: number }
export interface Bid { n: string; p: number; me: boolean; id: number | null; competitor_id: number | null }
export interface Detail {
  id: number; ref: string; title: string; nit: string; customer: string; customer_id: number | null; value: number; submit: string | null; owner: string | null; owner_id: number | null
  company: string | null; stages: Stage[]; stage: Stage; next: Stage | null; pending: { stage: string | null; approval_request_id: number | null } | null
  flow: { key: string; name: string }; flows: { key: string; name: string }[]; created: string | null
  hero: { value: number; emd: number; emd_furnished: boolean; submit: string | null; submit_in: number | null; portal: string | null; oem: string | null
    published: string | null; published_ago: number | null; stage_no: number | null; stages_of: number; pct: number; kind: string; flow: string; signals: { t: string; s: string }[] }
  sla: { sla: number; days: number; left: number; state: string } | null; progress: { index: number; of: number }
  lost: { reason: string | null; note: string | null } | null
  journey: { id: string; steps: { k: string; label: string; icon: string; ref: string | null; stage: string | null; value: number | null; route: string | null; me?: boolean; done: boolean
    date: string | null; note: string | null }[] }
  basic: { title: string; nit: string; customer: Ref; portal: Ref; category: Ref; location: Ref; owner: Ref; oem: Ref; value: number; emd: number; fee: number; custom: [string, unknown][]; custom_data: Record<string, unknown>
    vertical: Ref; flow: { id: string; name: string } }
  details: { published: string | null; prebid: string | null; submit: string | null; opening: string | null; opening2: string | null; validity: number; scope: string
    selection_method: string; jv_allowed: boolean; jv_member_count: number | null; gst_applicable: boolean
    corrigenda: { id: number; n: string; t: string; d: string }[]; eligibility: { id: number; t: string; ok: boolean }[]
    documents: { id: number; t: string; ok: boolean; document_id: string | null; document_name: string | null }[]
    documents_commercial: { id: number; t: string; ok: boolean; document_id: string | null; document_name: string | null }[]
    documents_final: { id: number; t: string; ok: boolean; document_id: string | null; document_name: string | null }[]
    fee_items: FeeItem[]; penalty: PenaltyClause[]; milestones: Milestone[] }
  workings: { lines: Line[]; oh_pct: number; cg_pct: number; mg_pct: number; base: number; oh: number; cg: number; cost: number; price: number; margin: number; vs: number | null
    synced: number | null; synced_at: string | null; initial_products: number; locked: boolean }
  tech: { rows: { id: number; c: string; w: number; s: number | null; rm: string }[]; score: number; max: number; pct: number; cutoff: number; scored: boolean; any: boolean; result: string; auto_advance: boolean }
  financial: { our: number; synced: boolean; rank: number; l1: number; bids: Bid[]; gst_pct: number; gst: number; total: number; pbg_pct: number; pbg: number; emd: number; pay: string
    final: number | null; price_status: string | null; rounds: { n: number; p: number; note: string; by: string; at: string | null }[]
    instruments: { id: number; ref: string; type: string; amount: number; bank: string | null; expiry: string | null; status: string | null; days: number | null }[]; emd_alert_days: number }
  po: { no: string; date: string | null; value: number | null; deliv: string; ld: string; ack: boolean; won: boolean; wo: string | null
    consignees: { id: number; name: string; loc: string; qty: string; contact: string; del: string | null }[] }
  lost_reasons: { required: boolean; reasons: string[] }
  history: { t: string; a: string; by: string; d: string | null }[]
  can: { update: boolean; delete: boolean; documents: boolean; workorders: boolean; manage: boolean }
}
export interface BidInput { title: string; nit: string; customer_id: number; portal_id: number | null; value: number | null; emd: number | null; submit: string
  owner_id: number | null; category_id: number | null; location_id: number | null; vertical_id: number | null; flow: string | null; custom_data?: Record<string, unknown> | null }
export interface StageResult { status: 'moved' | 'pending' | 'unchanged'; stage: string; pending_stage?: string; message?: string }
export interface ImportResult { created: number; dry_run: boolean; duplicates: { row: number; name: string; error: string }[]; errors: { row: number; name: string; error: string }[]; error_count: number; duplicate_count: number }
export type Opt = { id: number; name: string; sub?: string }
export interface Masters { portals: Opt[]; categories: Opt[]; oems: Opt[]; competitors: Opt[]; products: Opt[]; verticals: Opt[] }
export type Doc = { id: string; name: string; folder: string; updated_at: string | null; url: string; type: string; size_kb: number | null; owner: string }
/** Tender Details → Fee & document checklist row – bookkeeping only, not a Guarantees & Deposits (EMDBG) instrument. */
export interface FeeItem { id: number; label: string; amount: number | null; mode: string; stakeholder: string; cutoff: string | null; document_id: string | null; document_name: string | null; status: 'pending' | 'paid' | 'not_due' }
export interface FeeItemInput { label?: string; amount?: number | null; mode?: string | null; stakeholder?: string; cutoff?: string | null; status?: 'pending' | 'paid' | 'not_due'; document_id?: string | null }
/** Specific Tender Details → Penalty Clause / Payment Milestone rows. */
export interface PenaltyClause { id: number; desc: string; amount: string; remarks: string }
export interface PenaltyInput { description?: string; amount?: string; remarks?: string }
export interface Milestone { id: number; milestone: string; desc: string; remarks: string }
export interface MilestoneInput { milestone?: string; description?: string; remarks?: string }

const B = '/bids'
const MULTI = { headers: { 'Content-Type': 'multipart/form-data' } }
export const bidApi = {
  meta: () => api.get<Meta>(`${B}/meta`).then(r => r.data),
  list: (p: ListParams) => api.get<{ items: Row[]; total: number; total_all: number; counts: Record<string, number>; value_total: number }>(`${B}/list`, {
    params: { view: p.view, stage: p.stage, q: p.q, offset: p.offset, limit: p.limit, f: Object.values(p.f).some(Boolean) ? JSON.stringify(p.f) : '',
      adv: p.adv.conds.length ? JSON.stringify(p.adv) : '', sorts: p.sorts.length ? JSON.stringify(p.sorts) : '' },
  }).then(r => r.data),
  get: (id: number) => api.get<Detail>(`${B}/${id}`).then(r => r.data),
  create: (b: BidInput) => api.post<{ id: number; ref: string }>(B, b).then(r => r.data),
  update: (id: number, b: BidInput) => api.put<{ id: number }>(`${B}/${id}`, b).then(r => r.data),
  patch: (id: number, values: Record<string, unknown>) => api.patch<{ id: number; changed: string[] }>(`${B}/${id}`, { values }).then(r => r.data),
  remove: (id: number) => api.delete(`${B}/${id}`).then(r => r.data),
  stage: (id: number, body: { stage_id: number; reason?: string; comment?: string; checklist?: string[] }) => api.post<StageResult>(`${B}/${id}/stage`, body).then(r => r.data),
  masters: () => api.get<Masters>(`${B}/masters`).then(r => r.data),
  customers: (q: string) => api.get<{ items: Opt[] }>(`${B}/customers`, { params: { q, limit: 50 } }).then(r => r.data.items),
  locations: (q: string) => api.get<{ items: Opt[] }>(`${B}/locations`, { params: { q, limit: 50 } }).then(r => r.data.items),
  duplicates: (p: { customer_id?: number; title?: string; nit?: string; exclude_id?: number }) => api.get<{ items: { id: number; ref: string; title: string; why: string }[] }>(`${B}/duplicates`, { params: p }).then(r => r.data.items),
  documents: (id: number) => api.get<{ items: Doc[]; allowed: boolean }>(`${B}/${id}/documents`).then(r => r.data),
  upload: (id: number, file: File) => { const fd = new FormData(); fd.append('file', file); fd.append('linked_source', 'tenders'); fd.append('linked_record_id', String(id)); fd.append('name', file.name); return api.post('/document-management/upload', fd, MULTI).then(r => r.data) },
  corrigendum: (id: number, b: { number?: string; description: string; date: string }) => api.post<{ id: number; number: string }>(`${B}/${id}/corrigenda`, b).then(r => r.data),
  checklist: (id: number, itemId: number, b: { ok?: boolean; document_id?: string }) => api.patch(`${B}/${id}/checklist/${itemId}`, b).then(r => r.data),
  addFeeItem: (id: number, b: FeeItemInput) => api.post<{ id: number }>(`${B}/${id}/fee-items`, b).then(r => r.data),
  feeItem: (id: number, itemId: number, b: FeeItemInput) => api.patch<{ id: number }>(`${B}/${id}/fee-items/${itemId}`, b).then(r => r.data),
  delFeeItem: (id: number, itemId: number) => api.delete(`${B}/${id}/fee-items/${itemId}`).then(r => r.data),
  addPenalty: (id: number, b: PenaltyInput) => api.post<{ id: number }>(`${B}/${id}/penalty`, b).then(r => r.data),
  penalty: (id: number, itemId: number, b: PenaltyInput) => api.patch<{ id: number }>(`${B}/${id}/penalty/${itemId}`, b).then(r => r.data),
  delPenalty: (id: number, itemId: number) => api.delete(`${B}/${id}/penalty/${itemId}`).then(r => r.data),
  addMilestone: (id: number, b: MilestoneInput) => api.post<{ id: number }>(`${B}/${id}/milestones`, b).then(r => r.data),
  milestone: (id: number, itemId: number, b: MilestoneInput) => api.patch<{ id: number }>(`${B}/${id}/milestones/${itemId}`, b).then(r => r.data),
  delMilestone: (id: number, itemId: number) => api.delete(`${B}/${id}/milestones/${itemId}`).then(r => r.data),
  addLine: (id: number, b: { item?: string; product_id?: number | null; oem_id?: number | null; qty?: number; rate?: number }) => api.post<{ id: number }>(`${B}/${id}/boq`, b).then(r => r.data),
  line: (id: number, lineId: number, b: { item?: string; product_id?: number | null; oem_id?: number | null; qty?: number; rate?: number }) => api.patch(`${B}/${id}/boq/${lineId}`, b).then(r => r.data),
  delLine: (id: number, lineId: number) => api.delete(`${B}/${id}/boq/${lineId}`).then(r => r.data),
  copyProducts: (id: number) => api.post<{ copied: number }>(`${B}/${id}/boq/copy-products`).then(r => r.data),
  syncPrice: (id: number) => api.post<{ price: number }>(`${B}/${id}/sync-price`).then(r => r.data),
  score: (id: number, rowId: number, b: { awarded?: number | null; remark?: string; clear?: boolean }) => api.patch<{ id: number; advanced: string | null }>(`${B}/${id}/tech/${rowId}`, b).then(r => r.data),
  competitor: (id: number, b: { competitor_id: number; amount: number }) => api.post(`${B}/${id}/competitors`, b).then(r => r.data),
  delCompetitor: (id: number, rowId: number) => api.delete(`${B}/${id}/competitors/${rowId}`).then(r => r.data),
  negotiation: (id: number, b: { our_price: number; note?: string }) => api.post<{ round: number }>(`${B}/${id}/negotiation`, b).then(r => r.data),
  freeze: (id: number) => api.post<{ status: string; message: string }>(`${B}/${id}/freeze`).then(r => r.data),
  consignee: (id: number, b: { name: string; location_id: number | null; qty: string; contact: string; delivery: string | null }) => api.post<{ id: number }>(`${B}/${id}/consignees`, b).then(r => r.data),
  delConsignee: (id: number, cid: number) => api.delete(`${B}/${id}/consignees/${cid}`).then(r => r.data),
  workOrder: (id: number) => api.post<{ wo_number: string; wo_id: number }>(`${B}/${id}/work-order`).then(r => r.data),
  bulk: (ids: number[], action: 'reassign' | 'delete', value?: string) => api.post<{ done: number; failed: { id: number; error: string }[] }>(`${B}/bulk`, { ids, action, value }).then(r => r.data),
  importCsv: (file: File, dryRun: boolean) => { const fd = new FormData(); fd.append('file', file); return api.post<ImportResult>(`${B}/import`, fd, { ...MULTI, params: { dry_run: dryRun } }).then(r => r.data) },
  template: () => api.get(`${B}/import/template`, { responseType: 'blob' }).then(r => r.data as Blob),
}
