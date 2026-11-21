// Automation Studio – prototype v17 R.auto. Tabs: Overview · Workflow rules · Approval policies ·
// Assignment & scoring · Scheduled & SLA · Webhooks · Run log.
// Approval policies is the existing approval matrix (/approval-workflow) – linked here, not duplicated.
// Webhooks is the existing Marketplace & API outbound webhooks (/integrations360/webhooks) – linked here too.
// Workflow rules / Assignment & scoring / Scheduled & SLA are configured here; "Run now" performs the two safe
// actions (create a task-note, send a notification) for matching records on demand – not auto-fired on every
// live create/edit/delete across the app, which would need dedicated per-module testing beyond this page.
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Bars, Panel, Pill, Strip, Tbl } from '@/pages/customers/kit'
import {
  approvalPoliciesApi, automationApi, errMsg, webhooksApi,
  type Action, type ApprovalCatalog, type ApprovalRuleSummary, type ApprovalStep, type AssignmentRule, type Condition, type EscalationRule, type GroupLevel, type Meta, type Overview, type Rule, type RunLogRow, type ScoringRule, type SlaRule, type Webhook,
} from './automationApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import '@/pages/settings/appSettings.css'
import '@/pages/settings/admin360.css'
import '@/pages/approvals/approvals.css'
import './automation.css'

const TABS = ['Overview', 'Workflow rules', 'Approval policies', 'Assignment & scoring', 'Scheduled & SLA', 'Webhooks', 'Run log'] as const
type Tab = typeof TABS[number]

export default function AutomationStudioPage() {
  const { success, error } = useToast()
  const nav = useNavigate()
  const [sp, setSp] = useSearchParams()
  const tab = (TABS.includes(sp.get('tab') as Tab) ? (sp.get('tab') as Tab) : 'Overview')
  const setTab = (t: Tab) => setSp(s => { const n = new URLSearchParams(s); n.set('tab', t); return n })

  const [meta, setMeta] = useState<Meta | null>(null)
  const [ov, setOv] = useState<Overview | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [scoring, setScoring] = useState<ScoringRule[]>([])
  const [assignment, setAssignment] = useState<AssignmentRule[]>([])
  const [sla, setSla] = useState<SlaRule[]>([])
  const [hooks, setHooks] = useState<Webhook[]>([])
  const [policies, setPolicies] = useState<ApprovalRuleSummary[]>([])
  const [log, setLog] = useState<RunLogRow[]>([])
  const [ruleForm, setRuleForm] = useState<Rule | null>(null)
  const [policyForm, setPolicyForm] = useState<ApprovalRuleSummary | 'new' | null>(null)
  const [approvalCatalog, setApprovalCatalog] = useState<ApprovalCatalog | null>(null)
  const [rev, setRev] = useState(0)
  const bump = () => setRev(v => v + 1)

  useEffect(() => { automationApi.meta().then(setMeta).catch(e => error(errMsg(e))) }, [error])

  useEffect(() => {
    let alive = true
    const go = async () => {
      try {
        if (tab === 'Overview') setOv(await automationApi.overview())
        else if (tab === 'Workflow rules') setRules(await automationApi.rules())
        else if (tab === 'Assignment & scoring') { setScoring(await automationApi.scoringRules()); setAssignment(await automationApi.assignmentRules()) }
        else if (tab === 'Scheduled & SLA') setSla(await automationApi.slaRules())
        else if (tab === 'Approval policies') setPolicies(await approvalPoliciesApi.list())
        else if (tab === 'Webhooks') setHooks((await webhooksApi.list()).items)
        else if (tab === 'Run log') setLog(await automationApi.runLog())
      } catch (e) { if (alive) error(errMsg(e, 'Could not load Automation Studio')) }
    }
    go()
    return () => { alive = false }
  }, [tab, rev, error])

  const toggleRule = useCallback(async (r: Rule) => {
    try { await automationApi.toggleRule(r.id, !r.on); bump(); success('Rule ' + (!r.on ? 'activated' : 'paused')) } catch (e) { error(errMsg(e)) }
  }, [error, success])
  const runRule = useCallback(async (r: Rule) => {
    try { const res = await automationApi.runRule(r.id); success(res.result); bump() } catch (e) { error(errMsg(e)) }
  }, [error, success])
  const deleteRule = useCallback(async (r: Rule) => {
    if (!confirm(`Delete “${r.n}”?`)) return
    try { await automationApi.deleteRule(r.id); bump(); success('Deleted') } catch (e) { error(errMsg(e)) }
  }, [error, success])

  const newRule = (): Rule => ({ id: 0, n: 'New workflow rule', mod: meta?.modules[0]?.key || 'leads', trig: 'create', stage: '', conds: [], acts: [{ t: 'Create task', p: '' }], on: true, runs: 0, last: null })
  const togglePolicy = useCallback(async (p: ApprovalRuleSummary) => {
    try { await approvalPoliciesApi.toggle(p.id, !p.is_active); bump(); success('Policy ' + (!p.is_active ? 'activated' : 'paused')) } catch (e) { error(errMsg(e)) }
  }, [error, success])
  const openPolicyForm = useCallback(async (p: ApprovalRuleSummary | 'new') => {
    try {
      if (!approvalCatalog) setApprovalCatalog(await approvalPoliciesApi.meta())
      setPolicyForm(p)
    } catch (e) { error(errMsg(e, 'Could not load the approval policy form')) }
  }, [approvalCatalog, error])

  return <div className="bwi">
    <div className="pg">
      <div><div className="crumb">Automation &amp; control</div><h1>Automation studio</h1></div>
      <span className="cnt">{ov ? `${ov.active_rules} rules · ${ov.policies} approval policies active` : ''}</span>
      <span className="fl" />
      <button className="btn" onClick={() => openPolicyForm('new')}><Ic n="lock" /> New approval policy</button>
      <button className="btn p" onClick={() => setRuleForm(newRule())}><Ic n="plus" /> New workflow rule</button>
    </div>
    <div className="panel">
      <div className="tabs" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'Enter') setTab(t) }}>{t}</div>)}</div>
      <div className="pb">
        {tab === 'Overview' && <OverviewTab ov={ov} />}
        {tab === 'Workflow rules' && <RulesTab rules={rules} onToggle={toggleRule} onRun={runRule} onDelete={deleteRule} onEdit={setRuleForm} />}
        {tab === 'Approval policies' && <PoliciesTab policies={policies} onToggle={togglePolicy} onEdit={openPolicyForm} onNew={() => openPolicyForm('new')} />}
        {tab === 'Assignment & scoring' && <ScoringAssignmentTab scoring={scoring} assignment={assignment} onChanged={bump} error={error} success={success} />}
        {tab === 'Scheduled & SLA' && <SlaTab rows={sla} onChanged={bump} error={error} success={success} />}
        {tab === 'Webhooks' && <WebhooksTab hooks={hooks} onChanged={bump} error={error} success={success} />}
        {tab === 'Run log' && <RunLogTab rows={log} />}
      </div>
    </div>
    {ruleForm && meta && <RuleModal rule={ruleForm} meta={meta} onClose={() => setRuleForm(null)} onSaved={() => { setRuleForm(null); bump(); success('Workflow rule saved') }} />}
    {policyForm && approvalCatalog && <PolicyModal rule={policyForm === 'new' ? null : policyForm} catalog={approvalCatalog}
      onClose={() => setPolicyForm(null)} onSaved={() => { setPolicyForm(null); bump(); success('Approval policy saved') }} />}
  </div>
}

function OverviewTab({ ov }: { ov: Overview | null }) {
  if (!ov) return <div className="empty">Loading…</div>
  return <>
    <div className="note inf mb">Build approvals for anything from the <b>Approval policies</b> tab, or automate a task / notification from <b>Workflow rules</b> when records are created and match your conditions.</div>
    <Strip items={[
      { l: 'Active workflow rules', v: ov.active_rules, f: 'int' },
      { l: 'Approval policies', v: ov.policies, f: 'int' },
      { l: 'Runs · 7 days', v: ov.runs_7d, f: 'int' },
      { l: 'Pending approvals', v: ov.pending_approvals, f: 'int' },
    ]} />
    <div className="g g2">
      <Panel title="Most active"><Tbl cols={[{ k: 'n', t: 'Rule' }, { k: 'r', t: 'Runs', r: true }]} rows={ov.most_active} empty="No rules have run yet" /></Panel>
      <Panel title="Runs per day"><Bars d={ov.runs_7d_series.map(x => ({ l: x.l, v: x.v }))} h={120} f={v => String(v)} /></Panel>
    </div>
  </>
}

function RulesTab({ rules, onToggle, onRun, onDelete, onEdit }: { rules: Rule[]; onToggle: (r: Rule) => void; onRun: (r: Rule) => void; onDelete: (r: Rule) => void; onEdit: (r: Rule) => void }) {
  if (!rules.length) return <div className="empty">No workflow rules yet. Create one to automate a task or notification when records match a condition.</div>
  return <div className="list">{rules.map(r => <div key={r.id}>
    <label className="sw"><input type="checkbox" checked={r.on} onChange={() => onToggle(r)} /><i /></label>
    <span className="fl"><b>{r.n}</b><br /><small>{r.mod} · when {r.trig === 'stage' ? `stage → ${r.stage}` : r.trig}{r.conds.length ? ` · ${r.conds.length} condition(s)` : ''}</small><br />
      <small className="mu">→ {r.acts.map(a => `${a.t}${a.p ? ': ' + a.p : ''}`).join(' · ')}</small></span>
    <small>{r.runs} runs</small>
    <button className="btn s" onClick={() => onRun(r)}>Run now</button>
    <button className="btn s" onClick={() => onEdit(r)}>Edit</button>
    <button className="btn s d" onClick={() => onDelete(r)}><Ic n="x" /></button>
  </div>)}</div>
}

const stepLabel = (s: ApprovalStep) => s.approver_user_name || s.approver_role || (s.approver_level ? `Org level ${s.approver_level}` : s.approver_type)

function PoliciesTab({ policies, onToggle, onEdit, onNew }: { policies: ApprovalRuleSummary[]; onToggle: (p: ApprovalRuleSummary) => void; onEdit: (p: ApprovalRuleSummary) => void; onNew: () => void }) {
  const nav = useNavigate()
  if (!policies.length) return <div className="empty">No approval policies yet. Click “New approval policy” above to require sign-off before a module action goes through.</div>
  return <>
    <div className="list">{policies.map(p => <div key={p.id}>
      <label className="sw"><input type="checkbox" checked={p.is_active} onChange={() => onToggle(p)} /><i /></label>
      <span className="fl"><b>{p.name}</b><br /><small>{p.module_key} · <b>{p.action_key}</b> · requester: {p.requester_group_name || p.requester_role || p.requester_user_name || p.requester_type}</small><br />
        <span className="chain" style={{ marginTop: 3, display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
          {p.steps.map((s, i) => <span key={i} className="pill mu">{stepLabel(s)}</span>)}
        </span></span>
      <small className="mu">{p.step_count} step{p.step_count === 1 ? '' : 's'}</small>
      <button className="btn s" onClick={() => onEdit(p)}>Edit</button>
    </div>)}</div>
    <div className="row mt"><button className="btn s p" onClick={onNew}><Ic n="lock" /> New approval policy</button>
      <button className="btn g s" onClick={() => nav('/approval-workflow')}>Open full Approval Matrix</button>
      <small className="mu">Multi-group fan-out and adding extra escalation levels happen in the full matrix.</small></div>
  </>
}

function ScoringAssignmentTab({ scoring, assignment, onChanged, error, success }: { scoring: ScoringRule[]; assignment: AssignmentRule[]; onChanged: () => void; error: (m: string) => void; success: (m: string) => void }) {
  const [sc, setSc] = useState<{ c: string; p: string }>({ c: '', p: '0' })
  const [as, setAs] = useState<{ a: string; b: string }>({ a: '', b: '' })
  const addScoring = async () => {
    if (!sc.c.trim()) return
    try { await automationApi.saveScoringRule({ c: sc.c.trim(), p: Number(sc.p) || 0, on: true }); setSc({ c: '', p: '0' }); onChanged(); success('Scoring criterion added') } catch (e) { error(errMsg(e)) }
  }
  const addAssignment = async () => {
    if (!as.a.trim() || !as.b.trim()) return
    try { await automationApi.saveAssignmentRule({ a: as.a.trim(), b: as.b.trim(), on: true }); setAs({ a: '', b: '' }); onChanged(); success('Assignment rule added') } catch (e) { error(errMsg(e)) }
  }
  return <div className="g g2">
    <Panel title="Lead scoring" act={<small className="mu">Configuration only — not yet wired to a live scoring engine</small>}>
      <div className="list">{scoring.map(r => <div key={r.id}><span className="fl">{r.c}</span><b>{r.p > 0 ? '+' : ''}{r.p}</b>
        <button className="btn s d" onClick={async () => { await automationApi.deleteScoringRule(r.id); onChanged() }}><Ic n="x" /></button></div>)}</div>
      <div className="row mt" style={{ gap: 6 }}>
        <input className="in sm" placeholder="Criterion" value={sc.c} onChange={e => setSc(v => ({ ...v, c: e.target.value }))} />
        <input className="in sm" style={{ width: 70 }} type="number" value={sc.p} onChange={e => setSc(v => ({ ...v, p: e.target.value }))} />
        <button className="btn s" onClick={addScoring}><Ic n="plus" /> Add</button>
      </div>
    </Panel>
    <Panel title="Assignment rules" act={<small className="mu">Configuration only — not yet wired to a live assignment engine</small>}>
      <div className="list">{assignment.map(r => <div key={r.id}><span className="fl"><b>{r.a}</b><br /><small>→ {r.b}</small></span>
        <button className="btn s d" onClick={async () => { await automationApi.deleteAssignmentRule(r.id); onChanged() }}><Ic n="x" /></button></div>)}</div>
      <div className="row mt" style={{ gap: 6 }}>
        <input className="in sm" placeholder="Condition (e.g. State = Tamil Nadu)" value={as.a} onChange={e => setAs(v => ({ ...v, a: e.target.value }))} />
        <input className="in sm" placeholder="Assignee" value={as.b} onChange={e => setAs(v => ({ ...v, b: e.target.value }))} />
        <button className="btn s" onClick={addAssignment}><Ic n="plus" /> Add</button>
      </div>
    </Panel>
  </div>
}

function SlaTab({ rows, onChanged, error, success }: { rows: SlaRule[]; onChanged: () => void; error: (m: string) => void; success: (m: string) => void }) {
  return <>
    <div className="note inf mb">Time-based watchers check your live data. The count shows how many records match right now.</div>
    <div className="list">{rows.map(r => <div key={r.key}>
      <label className="sw"><input type="checkbox" checked={r.on} onChange={async () => { try { await automationApi.toggleSla(r.key, !r.on); onChanged() } catch (e) { error(errMsg(e)) } }} /><i /></label>
      <span className="fl"><b>{r.n}</b><br /><small>{r.mod}</small></span>
      <span className={`pill ${r.match ? 'wa' : 'ok'}`}>{r.match} match now</span>
      <button className="btn s" onClick={async () => { try { const res = await automationApi.runSla(r.key); success(res.result); onChanged() } catch (e) { error(errMsg(e)) } }}>Run now</button>
    </div>)}</div>
  </>
}

function WebhooksTab({ hooks, onChanged, error, success }: { hooks: Webhook[]; onChanged: () => void; error: (m: string) => void; success: (m: string) => void }) {
  const nav = useNavigate()
  return <>
    <div className="list">{hooks.map(w => <div key={w.id}>
      <span className={`pill ${w.s === 'Active' ? 'ok' : 'ba'}`}>{w.s}</span>
      <span className="fl"><b>{w.u}</b><br /><small>events: {w.e || '—'}</small></span>
      <button className="btn s d" onClick={async () => { try { await webhooksApi.remove(w.id); onChanged(); success('Webhook removed') } catch (e) { error(errMsg(e)) } }}><Ic n="x" /></button>
    </div>)}</div>
    {!hooks.length && <div className="empty">No outbound webhooks yet.</div>}
    <div className="row mt"><button className="btn p" onClick={() => nav('/integrations')}><Ic n="plus" /> Manage webhooks in Marketplace &amp; API</button>
      <small className="mu">Signed with HMAC-SHA256 · retried with back-off</small></div>
  </>
}

function RunLogTab({ rows }: { rows: RunLogRow[] }) {
  return <Tbl cols={[{ k: 't', t: 'Time' }, { k: 'r', t: 'Rule / watcher' }, { k: 'mod', t: 'Module' }, { k: 'matched', t: 'Matched', r: true }, { k: 'a', t: 'Result' }, { k: 's', t: 'Status', fn: row => <Pill s={row.s} /> }]}
    rows={rows} empty="No runs yet — use “Run now” on a workflow rule or SLA watcher." />
}

function RuleModal({ rule, meta, onClose, onSaved }: { rule: Rule; meta: Meta; onClose: () => void; onSaved: () => void }) {
  const { error } = useToast()
  const [x, setX] = useState<Rule>(rule)
  const fields = meta.modules.find(m => m.key === x.mod)?.fields ?? []
  const save = async () => {
    try {
      const payload = { n: x.n, mod: x.mod, trig: x.trig, stage: x.stage, conds: x.conds, acts: x.acts, on: x.on }
      if (x.id) await automationApi.updateRule(x.id, payload); else await automationApi.createRule(payload)
      onSaved()
    } catch (e) { error(errMsg(e, 'Could not save rule')) }
  }
  const setCond = (i: number, patch: Partial<Condition>) => setX(v => ({ ...v, conds: v.conds.map((c, j) => j === i ? { ...c, ...patch } : c) }))
  const setAct = (i: number, patch: Partial<Action>) => setX(v => ({ ...v, acts: v.acts.map((a, j) => j === i ? { ...a, ...patch } : a) }))
  return <Modal title={<><Ic n="git" /> Workflow rule</>} width={760} onClose={onClose} foot={<>
    <label className="row"><input type="checkbox" checked={x.on} onChange={e => setX(v => ({ ...v, on: e.target.checked }))} /> Active</label>
    <span className="fl" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn p" onClick={save}>Save rule</button></>}>
    <div className="g g2">
      <div>
        <label className="lb">Name</label><input className="in mb" value={x.n} onChange={e => setX(v => ({ ...v, n: e.target.value }))} />
        <label className="lb">Applies to</label>
        <select className="in" value={x.mod} onChange={e => setX(v => ({ ...v, mod: e.target.value, conds: [] }))}>
          {meta.modules.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>
      <div>
        <label className="lb">Trigger</label>
        <select className="in" value={x.trig} onChange={e => setX(v => ({ ...v, trig: e.target.value }))}>
          {Object.entries(meta.triggers).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {x.trig === 'stage' && <><label className="lb mt">Stage</label><input className="in" value={x.stage} onChange={e => setX(v => ({ ...v, stage: e.target.value }))} /></>}
      </div>
    </div>
    <div className="mt">
      <div className="row"><b>If these conditions match</b><span className="fl" /><button className="btn s" onClick={() => setX(v => ({ ...v, conds: [...v.conds, { f: fields[0] || '', o: '=', v: '' }] }))}><Ic n="plus" /> Condition</button></div>
      {x.conds.map((c, i) => <div key={i} className="row mb" style={{ gap: 6 }}>
        <select className="in sm" value={c.f} onChange={e => setCond(i, { f: e.target.value })}>{fields.map(f => <option key={f} value={f}>{f}</option>)}</select>
        <select className="in sm" style={{ width: 90 }} value={c.o} onChange={e => setCond(i, { o: e.target.value })}>{meta.ops.map(o => <option key={o} value={o}>{o}</option>)}</select>
        <input className="in sm" value={c.v} onChange={e => setCond(i, { v: e.target.value })} placeholder="value" />
        <button className="btn g s" onClick={() => setX(v => ({ ...v, conds: v.conds.filter((_, j) => j !== i) }))}><Ic n="x" /></button>
      </div>)}
      {!x.conds.length && <div className="mu" style={{ fontSize: 12 }}>No conditions — applies to every record.</div>}
    </div>
    <div className="mt">
      <div className="row"><b>Then do these actions</b><span className="fl" /><button className="btn s" onClick={() => setX(v => ({ ...v, acts: [...v.acts, { t: 'Send notification', p: '' }] }))}><Ic n="plus" /> Action</button></div>
      {x.acts.map((a, i) => <div key={i} className="row mb" style={{ gap: 6 }}>
        <select className="in sm" style={{ width: 170 }} value={a.t} onChange={e => setAct(i, { t: e.target.value })}>{meta.actions.map(t => <option key={t} value={t}>{t}</option>)}</select>
        <input className="in sm" value={a.p || ''} onChange={e => setAct(i, { p: e.target.value })} placeholder="Task title / message" />
        <button className="btn g s" onClick={() => setX(v => ({ ...v, acts: v.acts.filter((_, j) => j !== i) }))}><Ic n="x" /></button>
      </div>)}
      <div className="note inf" style={{ fontSize: 12 }}>“Run now” performs <b>Create task</b> and <b>Send notification</b> for matched records. Other action types are logged but not yet auto-executed.</div>
    </div>
  </Modal>
}

type ChainStep = { id?: number; approver_type: 'role' | 'specific_user' | 'hierarchy_level'; role: string; user_id: number | ''; level: number | '' }
type PolicyForm = {
  id: number; name: string; module_key: string; action_key: string
  requester_type: 'role' | 'specific_user' | 'group'
  requester_role: string; requester_user_id: number | ''; requester_group_id: number | ''
  is_active: boolean; chain: ChainStep[]
  respondHours: string; escalateToRole: string; escalateAfterHours: string
}

// Mirrors buildHierarchySteps() in the full Approval Matrix (ApprovalsTab.tsx): one approver per org level
// above the group, highest level first, L1 last – so escalation climbs the tree if nobody acts.
function buildHierarchySteps(levels: GroupLevel[]): ChainStep[] {
  const asc = [...levels].sort((a, b) => a.level - b.level)
  return asc.slice(0, -1).reverse().map(l => ({ approver_type: 'hierarchy_level' as const, role: '', user_id: '' as const, level: l.level }))
}

function PolicyModal({ rule, catalog, onClose, onSaved }: { rule: ApprovalRuleSummary | null; catalog: ApprovalCatalog; onClose: () => void; onSaved: () => void }) {
  const { error } = useToast()
  const firstModule = catalog.modules[0]
  const [x, setX] = useState<PolicyForm>(() => {
    if (rule) {
      const chain: ChainStep[] = rule.steps.map(s => ({
        id: s.id, approver_type: s.approver_type === 'hierarchy_level' ? 'hierarchy_level' : s.approver_type === 'specific_user' ? 'specific_user' : 'role',
        role: s.approver_role || catalog.approver_roles[0]?.key || '', user_id: s.approver_user_id ?? '', level: s.approver_level ?? '',
      }))
      return {
        id: rule.id, name: rule.name, module_key: rule.module_key, action_key: rule.action_key,
        requester_type: (rule.requester_type as PolicyForm['requester_type']) || 'role',
        requester_role: rule.requester_role || catalog.requester_roles[0]?.key || '', requester_user_id: rule.requester_user_id ?? '', requester_group_id: rule.requester_group_id ?? '',
        is_active: rule.is_active, chain: chain.length ? chain : [{ approver_type: 'role', role: catalog.approver_roles[0]?.key || '', user_id: '', level: '' }],
        respondHours: rule.steps[0]?.escalation_minutes ? String(Math.round(rule.steps[0].escalation_minutes / 60)) : '', escalateToRole: '', escalateAfterHours: '',
      }
    }
    return {
      id: 0, name: 'New approval policy', module_key: firstModule?.key || '', action_key: firstModule?.actions[0]?.key || '',
      requester_type: 'role', requester_role: catalog.requester_roles[0]?.key || '', requester_user_id: '', requester_group_id: '',
      is_active: true, chain: [{ approver_type: 'role', role: catalog.approver_roles[0]?.key || '', user_id: '', level: '' }],
      respondHours: '', escalateToRole: catalog.approver_roles[0]?.key || '', escalateAfterHours: '',
    }
  })
  const [groupLevels, setGroupLevels] = useState<GroupLevel[]>([])
  const [addLevelChoice, setAddLevelChoice] = useState('')
  const [escRules, setEscRules] = useState<EscalationRule[]>([])
  const actions = catalog.modules.find(m => m.key === x.module_key)?.actions ?? []
  const isGroup = x.requester_type === 'group'

  useEffect(() => { approvalPoliciesApi.escalationRules().then(setEscRules).catch(() => {}) }, [])
  useEffect(() => {
    const existing = escRules.find(r => r.module_key === x.module_key && r.action_key === x.action_key)
    if (existing) setX(v => ({ ...v, escalateToRole: existing.approver_role, escalateAfterHours: String(Math.round(existing.escalation_minutes / 60)) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escRules, x.module_key, x.action_key])
  useEffect(() => {
    if (!isGroup || !x.requester_group_id) { setGroupLevels([]); return }
    let alive = true
    approvalPoliciesApi.groupLevels(Number(x.requester_group_id)).then(levels => {
      if (!alive) return
      setGroupLevels(levels)
      if (!rule || rule.requester_group_id !== Number(x.requester_group_id)) setX(v => ({ ...v, chain: buildHierarchySteps(levels) }))
    }).catch(() => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGroup, x.requester_group_id])

  const setChain = (i: number, patch: Partial<ChainStep>) => setX(v => ({ ...v, chain: v.chain.map((c, j) => j === i ? { ...c, ...patch } : c) }))
  const moveChain = (i: number, d: number) => setX(v => { const c = [...v.chain], j = i + d; if (j < 0 || j >= c.length) return v; [c[i], c[j]] = [c[j], c[i]]; return { ...v, chain: c } })
  const levelLabel = (lvl: number | '') => groupLevels.find(l => l.level === lvl)?.level_label || (lvl === '' ? 'Level' : `Level ${lvl}`)
  const unusedLevels = groupLevels.filter(l => !x.chain.some(c => c.level === l.level))

  const save = async () => {
    if (!x.name.trim()) return error('Name the policy')
    if (!x.module_key || !x.action_key) return error('Pick a module and action')
    if (!x.chain.length) return error(isGroup ? 'This group has no organisation levels above it yet' : 'Add at least one approver')
    if (isGroup && !x.requester_group_id) return error('Pick a group')
    const respondMinutes = x.respondHours && Number(x.respondHours) > 0 ? Math.round(Number(x.respondHours) * 60) : null
    const payload = {
      module_key: x.module_key, action_key: x.action_key, name: x.name.trim(),
      requester_type: x.requester_type,
      requester_role: x.requester_type === 'role' ? x.requester_role : undefined,
      requester_user_id: x.requester_type === 'specific_user' && x.requester_user_id ? Number(x.requester_user_id) : undefined,
      requester_group_id: isGroup && x.requester_group_id ? Number(x.requester_group_id) : undefined,
      approval_type: (isGroup ? 'hierarchy' : 'sequential') as 'hierarchy' | 'sequential',
      is_active: x.is_active,
      steps: x.chain.map((s, i) => ({
        step_no: i + 1, approver_type: s.approver_type,
        approver_role: s.approver_type === 'role' ? s.role : undefined,
        approver_user_id: s.approver_type === 'specific_user' && s.user_id ? Number(s.user_id) : undefined,
        approver_level: s.approver_type === 'hierarchy_level' && s.level !== '' ? Number(s.level) : undefined,
      })),
    }
    try {
      const saved = x.id ? await approvalPoliciesApi.update(x.id, payload) : await approvalPoliciesApi.create(payload)
      await Promise.all(saved.steps.map(s => s.id ? approvalPoliciesApi.setStepEscalation(saved.id, s.id, respondMinutes).catch(() => {}) : Promise.resolve()))
      if (x.escalateToRole && Number(x.escalateAfterHours) > 0) {
        const existing = escRules.find(r => r.module_key === x.module_key && r.action_key === x.action_key)
        await approvalPoliciesApi.saveEscalationRule({ module_key: x.module_key, action_key: x.action_key, approver_role: x.escalateToRole, escalation_minutes: Math.round(Number(x.escalateAfterHours) * 60), is_active: true }, existing?.id).catch(() => {})
      }
      onSaved()
    } catch (e) { error(errMsg(e, 'Could not save the policy')) }
  }

  return <Modal title={<><Ic n="lock" /> Approval policy</>} width={860} onClose={onClose} foot={<>
    <label className="row"><input type="checkbox" checked={x.is_active} onChange={e => setX(v => ({ ...v, is_active: e.target.checked }))} /> Active</label>
    <span className="fl" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn p" onClick={save}>Save policy</button></>}>
    <div className="g g2">
      <div>
        <label className="lb">Name</label><input className="in mb" value={x.name} onChange={e => setX(v => ({ ...v, name: e.target.value }))} />
        <label className="lb">Applies to</label>
        <select className="in" value={x.module_key} onChange={e => { const mk = e.target.value; const first = catalog.modules.find(m => m.key === mk)?.actions[0]?.key || ''; setX(v => ({ ...v, module_key: mk, action_key: first })) }}>
          {catalog.modules.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>
      <div>
        <label className="lb">Action</label>
        <select className="in" value={x.action_key} onChange={e => setX(v => ({ ...v, action_key: e.target.value }))}>
          {actions.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
      </div>
    </div>
    <div className="mt g g2">
      <div>
        <label className="lb">Requester is a…</label>
        <select className="in" value={x.requester_type} onChange={e => setX(v => ({ ...v, requester_type: e.target.value as PolicyForm['requester_type'], chain: [{ approver_type: 'role', role: catalog.approver_roles[0]?.key || '', user_id: '', level: '' }] }))}>
          {catalog.requester_types.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </div>
      <div>
        {x.requester_type === 'role' && <><label className="lb">Role</label>
          <select className="in" value={x.requester_role} onChange={e => setX(v => ({ ...v, requester_role: e.target.value }))}>
            {catalog.requester_roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select></>}
        {x.requester_type === 'specific_user' && <><label className="lb">User</label>
          <select className="in" value={x.requester_user_id} onChange={e => setX(v => ({ ...v, requester_user_id: Number(e.target.value) }))}>
            <option value="">Select a user…</option>
            {catalog.users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </select></>}
        {isGroup && <><label className="lb">Group</label>
          <select className="in" value={x.requester_group_id} onChange={e => setX(v => ({ ...v, requester_group_id: Number(e.target.value) }))}>
            <option value="">Select a group…</option>
            {catalog.groups.map(g => <option key={g.id} value={g.id}>{g.name}{g.lead_name ? ` · ${g.lead_name}` : ''}</option>)}
          </select></>}
      </div>
    </div>
    <div className="mt">
      <div className="row"><b>{isGroup ? 'Escalation levels – in order' : 'Approver chain – in order'}</b><span className="fl" />
        {!isGroup && <button className="btn s" onClick={() => setX(v => ({ ...v, chain: [...v.chain, { approver_type: 'role', role: catalog.approver_roles[0]?.key || '', user_id: '', level: '' }] }))}><Ic n="plus" /> Add approver</button>}
      </div>
      {isGroup && !x.requester_group_id && <div className="mu" style={{ fontSize: 12 }}>Pick a group to load its organisation levels.</div>}
      {x.chain.map((s, i) => <div key={i} className="row mb" style={{ gap: 6 }}>
        <b style={{ width: 20 }}>{i + 1}</b>
        {isGroup
          ? <span className="pill mu fl">{levelLabel(s.level)}</span>
          : <><select className="in sm" style={{ width: 120 }} value={s.approver_type} onChange={e => setChain(i, { approver_type: e.target.value as ChainStep['approver_type'] })}>
              <option value="role">Role</option><option value="specific_user">Specific user</option>
            </select>
            {s.approver_type === 'role'
              ? <select className="in sm" value={s.role} onChange={e => setChain(i, { role: e.target.value })}>{catalog.approver_roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}</select>
              : <select className="in sm" value={s.user_id} onChange={e => setChain(i, { user_id: Number(e.target.value) })}><option value="">Select a user…</option>{catalog.users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>}</>}
        <button className="btn g s" onClick={() => moveChain(i, -1)}>↑</button>
        <button className="btn g s" onClick={() => moveChain(i, 1)}>↓</button>
        <button className="btn g s" onClick={() => setX(v => ({ ...v, chain: v.chain.filter((_, j) => j !== i) }))} disabled={x.chain.length <= 1}><Ic n="x" /></button>
      </div>)}
      {isGroup && unusedLevels.length > 0 && <div className="row mt" style={{ gap: 6 }}>
        <select className="in sm" value={addLevelChoice} onChange={e => setAddLevelChoice(e.target.value)}>
          <option value="">Pick a level to add…</option>
          {unusedLevels.map(l => <option key={l.level} value={l.level}>{l.level_label}</option>)}
        </select>
        <button className="btn s" disabled={!addLevelChoice} onClick={() => { setX(v => ({ ...v, chain: [...v.chain, { approver_type: 'hierarchy_level', role: '', user_id: '', level: Number(addLevelChoice) }] })); setAddLevelChoice('') }}><Ic n="plus" /> Add level</button>
      </div>}
    </div>
    <div className="mt g g2">
      <div>
        <label className="lb">Respond within (hours)</label>
        <input className="in" type="number" min={0} placeholder="e.g. 24" value={x.respondHours} onChange={e => setX(v => ({ ...v, respondHours: e.target.value }))} />
      </div>
      <div className="g g2">
        <div><label className="lb">Escalate to</label>
          <select className="in" value={x.escalateToRole} onChange={e => setX(v => ({ ...v, escalateToRole: e.target.value }))}>
            {catalog.approver_roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </div>
        <div><label className="lb">Escalate after (hours)</label>
          <input className="in" type="number" min={0} placeholder="e.g. 48" value={x.escalateAfterHours} onChange={e => setX(v => ({ ...v, escalateAfterHours: e.target.value }))} />
        </div>
      </div>
    </div>
    <div className="note inf mt" style={{ fontSize: 12 }}>
      “Respond within” sets how long each approver has before their step is flagged overdue. “Escalate to / after” applies to every policy on this module + action – it hands the request to that role if nobody has decided within that time.
      {isGroup && ' Levels are built from the group\'s place in the organisation tree; multi-group fan-out still happens in the full Approval Matrix.'}
    </div>
  </Modal>
}
