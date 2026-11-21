// Automation Studio (prototype v17) – typed calls to /api/v1/automation (+ the existing approval matrix at
// /approval-workflows for the Approval policies tab, and /integrations360/webhooks for the Webhooks tab).
import api from '@/services/api'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

export interface Meta { modules: { key: string; label: string; fields: string[] }[]; triggers: Record<string, string>; actions: string[]; ops: string[] }
export interface Condition { f: string; o: string; v: string }
export interface Action { t: string; p?: string }
export interface Rule { id: number; n: string; mod: string; trig: string; stage: string; conds: Condition[]; acts: Action[]; on: boolean; runs: number; last: string | null }
export interface Overview { active_rules: number; policies: number; runs_7d: number; runs_7d_series: { l: string; v: number }[]; pending_approvals: number; most_active: { n: string; r: number }[] }
export interface ScoringRule { id: number; c: string; p: number; on: boolean }
export interface AssignmentRule { id: number; a: string; b: string; on: boolean }
export interface SlaRule { key: string; n: string; mod: string; on: boolean; match: number; last: string | null }
export interface RunLogRow { t: string; r: string; mod: string; matched: number; a: string; s: string }

export const automationApi = {
  meta: () => api.get<Meta>('/automation/meta').then(r => r.data),
  overview: () => api.get<Overview>('/automation/overview').then(r => r.data),

  rules: () => api.get<{ items: Rule[] }>('/automation/rules').then(r => r.data.items),
  createRule: (d: Omit<Rule, 'id' | 'runs' | 'last'>) => api.post('/automation/rules', d).then(r => r.data),
  updateRule: (id: number, d: Omit<Rule, 'id' | 'runs' | 'last'>) => api.put(`/automation/rules/${id}`, d).then(r => r.data),
  toggleRule: (id: number, on: boolean) => api.put(`/automation/rules/${id}/toggle`, { on }),
  deleteRule: (id: number) => api.delete(`/automation/rules/${id}`),
  runRule: (id: number) => api.post<{ matched: number; result: string }>(`/automation/rules/${id}/run`).then(r => r.data),

  scoringRules: () => api.get<{ items: ScoringRule[] }>('/automation/scoring-rules').then(r => r.data.items),
  saveScoringRule: (d: { c: string; p: number; on: boolean }, id?: number) =>
    (id ? api.put(`/automation/scoring-rules/${id}`, d) : api.post('/automation/scoring-rules', d)).then(r => r.data),
  deleteScoringRule: (id: number) => api.delete(`/automation/scoring-rules/${id}`),

  assignmentRules: () => api.get<{ items: AssignmentRule[] }>('/automation/assignment-rules').then(r => r.data.items),
  saveAssignmentRule: (d: { a: string; b: string; on: boolean }, id?: number) =>
    (id ? api.put(`/automation/assignment-rules/${id}`, d) : api.post('/automation/assignment-rules', d)).then(r => r.data),
  deleteAssignmentRule: (id: number) => api.delete(`/automation/assignment-rules/${id}`),

  slaRules: () => api.get<{ items: SlaRule[] }>('/automation/sla-rules').then(r => r.data.items),
  toggleSla: (key: string, on: boolean) => api.put(`/automation/sla-rules/${key}/toggle`, { on }),
  runSla: (key: string) => api.post<{ matched: number; result: string }>(`/automation/sla-rules/${key}/run`).then(r => r.data),

  runLog: () => api.get<{ items: RunLogRow[] }>('/automation/run-log').then(r => r.data.items),
}

export interface Webhook { id: number; u: string; e: string; events: string[]; s: 'Active' | 'Failed'; l: string | null; code: number | null; err: string | null }
export const webhooksApi = {
  list: () => api.get<{ items: Webhook[]; events: string[] }>('/integrations360/webhooks').then(r => r.data),
  create: (d: { url: string; events: string[] }) => api.post<{ item: Webhook; secret: string }>('/integrations360/webhooks', d).then(r => r.data),
  remove: (id: number) => api.delete(`/integrations360/webhooks/${id}`),
}

// Approval policies tab reads and writes the existing Approval Matrix (generic approval engine) directly – the
// list and the "New / Edit policy" modal use the SAME /approval-workflows endpoints the full matrix page uses,
// just through a lighter, prototype-styled form for the common single-requester case. Multi-group fan-out and
// the org-hierarchy escalation-level builder stay on the full Approval Matrix (/approval-workflow).
export interface ApprovalStep { id?: number; step_no: number; approver_type: string; approver_role: string | null; approver_user_id?: number | null; approver_user_name: string | null; approver_level: number | null; escalation_minutes?: number | null }
export interface ApprovalRuleSummary {
  id: number; name: string; module_key: string; action_key: string; approval_type: string; is_active: boolean
  requester_type: string; requester_role: string | null; requester_user_id?: number | null; requester_user_name: string | null
  requester_group_id?: number | null; requester_group_name?: string | null
  step_count: number; steps: ApprovalStep[]
}
export interface ApprovalCatalog {
  modules: { key: string; label: string; actions: { key: string; label: string }[] }[]
  requester_types: { key: string; label: string }[]
  requester_roles: { key: string; label: string }[]
  approver_roles: { key: string; label: string }[]
  users: { id: number; full_name: string; email: string; role: string }[]
  groups: { id: number; name: string; lead_id: number | null; lead_name: string | null }[]
}
export interface ApprovalRuleStepIn { step_no: number; approver_type: 'role' | 'specific_user' | 'hierarchy_level'; approver_role?: string; approver_user_id?: number; approver_level?: number }
export interface ApprovalRulePayload {
  module_key: string; action_key: string; name: string
  requester_type: 'role' | 'specific_user' | 'group'
  requester_role?: string; requester_user_id?: number; requester_group_id?: number
  approval_type: 'hierarchy' | 'sequential'; is_active: boolean
  steps: ApprovalRuleStepIn[]
}
export interface GroupLevel { level: number; level_label: string; is_group_lead: boolean; is_l1: boolean; user_count: number }
export interface EscalationRule { id: number; module_key: string; action_key: string; approver_role: string; escalation_minutes: number; is_active: boolean }
export const approvalPoliciesApi = {
  list: () => api.get<ApprovalRuleSummary[]>('/approval-workflows/rules').then(r => r.data),
  toggle: (id: number, is_active: boolean) => api.patch(`/approval-workflows/rules/${id}/status`, { is_active }),
  meta: () => api.get<ApprovalCatalog>('/approval-workflows/meta').then(r => r.data),
  create: (d: ApprovalRulePayload) => api.post<ApprovalRuleSummary>('/approval-workflows/rules', d).then(r => r.data),
  update: (id: number, d: ApprovalRulePayload) => api.put<ApprovalRuleSummary>(`/approval-workflows/rules/${id}`, d).then(r => r.data),
  setStepEscalation: (ruleId: number, stepId: number, minutes: number | null) =>
    api.patch(`/approval-workflows/rules/${ruleId}/steps/${stepId}/escalation`, { escalation_minutes: minutes }),
  groupLevels: (groupId: number) => api.get<GroupLevel[]>(`/masters/groups/${groupId}/reporting-hierarchy`).then(r => r.data ?? []),
  escalationRules: () => api.get<EscalationRule[]>('/approval-workflows/escalation/rules').then(r => r.data),
  saveEscalationRule: (d: { module_key: string; action_key: string; approver_role: string; escalation_minutes: number; is_active: boolean }, id?: number) =>
    (id ? api.put(`/approval-workflows/escalation/rules/${id}`, d) : api.post('/approval-workflows/escalation/rules', d)).then(r => r.data),
}
