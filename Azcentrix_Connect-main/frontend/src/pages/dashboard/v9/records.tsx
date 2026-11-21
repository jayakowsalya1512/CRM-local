import { Avatar, Bar, fd, inr, num } from '@/components/platform/bw'
import type { GridCol } from '@/components/platform/BwGrid'
import { statusPill, type DrillSpec } from './ui'

// Where dashboard records open: the existing CRM record pages (no duplicate detail views).
export const ROUTE = {
  leads: '/leads', opps: '/opportunities', tenders: '/tenders', emd: '/emdbg', orders: '/workorders',
  approvals: '/approvals', kam: '/kam', users: '/users',
  lead: (id: number) => `/leads/${id}`,
  opp: (id: number) => `/opportunities/${id}`,
  tender: (id: number) => `/tenders/${id}/edit`,
  kam360: (id: number) => `/kam?tab=360&kam=${id}`,
}

// Column keys are the record fields returned by /dashboard/v9/records, so server-side sorting uses them directly.
type Col = GridCol<any>
const c = (k: string, t: string, o: Partial<Col> = {}): Col => ({ k, t, ...o })
const user = (n: string | null | undefined) => n ? <span className="inline-flex items-center gap-1.5"><Avatar name={n} size={18} />{n}</span> : '—'
const money = (k: string, t: string, w = 110): Col => c(k, t, { w, r: true, money: true, fn: (r: any) => (r[k] ? inr(r[k]) : '—'), sv: (r: any) => r[k] ?? 0 })
const date = (k: string, t: string): Col => c(k, t, { w: 110, date: true, fn: (r: any) => fd(r[k]), txt: (r: any) => r[k] || '' })
const pill = (k: string, t: string, w = 120): Col => c(k, t, { w, fn: (r: any) => statusPill(r[k]), txt: (r: any) => r[k] || '' })
const person = (k: string, t: string): Col => c(k, t, { w: 160, fn: (r: any) => user(r[k]), txt: (r: any) => r[k] || '' })

export const COLS: Record<string, Col[]> = {
  leads: [c('ref', 'Lead', { w: 140, fn: r => <b>{r.ref}</b> }), c('title', 'Title', { w: 220 }), c('customer', 'Customer', { w: 190 }), pill('status', 'Stage'),
    money('value', 'Value'), c('source', 'Source', { w: 130 }), person('owner', 'Owner'), date('created', 'Created')],
  deals: [c('name', 'Deal', { w: 200, fn: r => <b>{r.name}</b> }), c('customer', 'Customer', { w: 180 }), money('value', 'Value'), pill('stage', 'Stage', 140),
    pill('outcome', 'Outcome', 100), c('type', 'Deal type', { w: 110, fn: r => (r.type === 'Tender' ? 'Tender-led' : 'Quote-led') }), person('owner', 'Owner'),
    c('days_in_stage', 'Days in stage', { w: 110, r: true, fn: r => r.days_in_stage ?? '—', sv: r => r.days_in_stage ?? 0 }), date('close', 'Closed'), c('journey', 'Journey', { w: 140 })],
  tenders: [c('num', 'Bid', { w: 160, fn: r => <b>{r.num}</b> }), c('title', 'Title', { w: 220 }), c('customer', 'Customer', { w: 190 }), pill('stage', 'Stage'), pill('result', 'Result', 100),
    c('portal', 'Portal', { w: 130 }), money('value', 'Value'), person('manager', 'Bid manager'), date('deadline', 'Deadline'), c('journey', 'Journey', { w: 140 })],
  orders: [c('number', 'Order', { w: 140, fn: r => <b>{r.number}</b> }), c('title', 'Title', { w: 190 }), c('customer', 'Customer', { w: 180 }), c('type', 'Contract type', { w: 130 }),
    pill('stage', 'Stage'), c('progress', 'Progress', { w: 140, fn: r => <Bar value={r.progress} />, sv: r => r.progress }),
    c('billed_pct', 'Billed %', { w: 90, r: true, fn: r => `${r.billed_pct}%`, sv: r => r.billed_pct }), money('value', 'Value'), date('due', 'Due'), person('pm', 'PM')],
  invoices: [c('number', 'Invoice', { w: 150, fn: r => <b>{r.number}</b> }), c('order', 'Order', { w: 130 }), c('customer', 'Customer', { w: 190 }), date('invoice_date', 'Invoice date'),
    date('due_date', 'Due'), money('total', 'Amount'), money('paid', 'Paid'), money('outstanding', 'Outstanding'), pill('status', 'Status', 110)],
  // Orders & Projects payment ledger (same rows as Collections & finance)
  payments: [c('order', 'Order', { w: 130, fn: r => <b>{r.order}</b> }), c('customer', 'Customer', { w: 190 }), c('stage', 'Stage', { w: 200 }), date('due', 'Due'),
    money('amount', 'Amount'), money('received', 'Received'), money('awaiting', 'Awaiting finance', 120), money('receivable', 'Outstanding'),
    c('days_overdue', 'Days overdue', { w: 100, r: true, fn: r => r.days_overdue || '—', sv: r => r.days_overdue ?? 0 }), pill('status', 'Status', 140)],
  receipts: [date('credited_on', 'Credited'), c('order', 'Order', { w: 130, fn: r => <b>{r.order}</b> }), c('customer', 'Customer', { w: 190 }), money('amount', 'Amount'),
    c('mode', 'Mode', { w: 100 }), c('ref', 'Reference', { w: 140 }), person('by', 'Collected by'), pill('status', 'Finance', 130), person('ack_by', 'Acknowledged by')],
  guarantees: [c('type', 'Type', { w: 120 }), c('ref', 'Ref', { w: 160, fn: r => <b>{r.ref}</b> }), c('customer', 'Customer', { w: 190 }), c('bid', 'Bid', { w: 150 }),
    c('bank', 'Bank', { w: 120 }), money('amount', 'Amount'), date('valid_until', 'Valid until'), pill('status', 'Status', 100)],
  kams: [person('name', 'KAM'), c('role', 'Role', { w: 110 }), money('target', 'Target'), money('achieved', 'Achieved'),
    c('achieved_pct', 'Target achieved', { w: 150, fn: r => (r.achieved_pct == null ? '—' : <Bar value={r.achieved_pct} />), sv: r => r.achieved_pct ?? -1 }),
    money('pipeline', 'Pipeline'), c('activities', 'Activities', { w: 90, r: true }), c('visits', 'Visits', { w: 80, r: true }),
    c('win_rate', 'Win rate', { w: 90, fn: r => (r.win_rate == null ? '—' : `${r.win_rate}%`), sv: r => r.win_rate ?? -1 }), c('customers', 'Customers', { w: 90, r: true })],
  activities: [date('date', 'Date'), person('kam', 'KAM'), c('type', 'Type', { w: 120 }), c('customer', 'Customer', { w: 190 }), c('subject', 'Subject', { w: 200 }), pill('status', 'Status', 110)],
  approvals: [c('title', 'Request', { w: 280 }), person('by', 'By'), money('value', 'Value'), pill('status', 'Status', 100), date('requested_at', 'Requested')],
  logins: [person('user', 'User'), c('role', 'Role', { w: 120 }), date('date', 'Date'), c('time', 'Time', { w: 70 }), c('device', 'Device', { w: 190, fn: r => r.device || '—' }),
    c('ip', 'IP address', { w: 130, fn: r => r.ip || '—' }), c('location', 'Location', { w: 100, fn: r => r.location || '—', txt: r => r.location || '' }),
    c('method', 'Method', { w: 130 }), c('minutes', 'Session (min)', { w: 110, r: true, fn: r => r.minutes ?? '—', sv: r => r.minutes ?? -1 }), pill('result', 'Result', 170)],
  signals: [date('date', 'Date'), person('user', 'User'), c('kind', 'Signal', { w: 180 }), c('detail', 'Detail', { w: 240 }), c('ip', 'IP address', { w: 130, fn: r => r.ip || '—' })],
}

const ROW_TO: Record<string, (r: any) => string | null> = {
  leads: r => ROUTE.lead(r.id), deals: r => ROUTE.opp(r.id), tenders: r => ROUTE.tender(r.id), orders: () => ROUTE.orders, invoices: () => ROUTE.orders,
  payments: r => `${ROUTE.orders}?open=${r.wo_id}`, receipts: r => `${ROUTE.orders}?open=${r.wo_id}`,
  guarantees: () => ROUTE.emd, kams: r => ROUTE.kam360(r.id), activities: () => ROUTE.kam, approvals: () => ROUTE.approvals, logins: () => null, signals: () => null,
}
const MODULE: Record<string, { label: string; to: string } | undefined> = {
  leads: { label: 'Leads', to: ROUTE.leads }, deals: { label: 'Opportunities', to: ROUTE.opps }, tenders: { label: 'Bids & Tenders', to: ROUTE.tenders },
  orders: { label: 'Orders & Projects', to: ROUTE.orders }, invoices: { label: 'Orders & Projects', to: ROUTE.orders },
  payments: { label: 'Collections & finance', to: ROUTE.orders }, receipts: { label: 'Collections & finance', to: ROUTE.orders }, guarantees: { label: 'EMD / BG', to: ROUTE.emd },
  kams: { label: 'KAM 360', to: ROUTE.kam }, activities: { label: 'KAM 360', to: ROUTE.kam }, approvals: { label: 'Approvals', to: ROUTE.approvals },
  logins: { label: 'Users', to: ROUTE.users }, signals: { label: 'Users', to: ROUTE.users },
}

// A drill-down on one record source with one of the server's named filters (e.g. drill('tenders', 'due:7', 'Due ≤ 7 days')).
export const drill = (source: string, filter: string, title: string, o: Partial<DrillSpec> = {}): DrillSpec => ({
  title, source, filter, cols: COLS[source], rowTo: ROW_TO[source], route: MODULE[source], ...o,
})

export const n = num
export const L = (v: number) => inr(v || 0)
