import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { platformApi, type CannedResponse, type SlaCalendar, type SlaOverview, type SlaPolicy, type SupportTicket } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Field, Note, PageHead, Panel, Strip, errMsg, fd, inputCls, inputStyle, useKpiPopup } from '@/components/platform/bw'
import { HBars, LineChart, PAL } from '@/components/platform/charts'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'
import { getCurrentTicket, insertIntoDraft, setCurrentTicket } from '@/components/platform/supportDraft'

// Layout follows the Bidwise prototype v9 SLA & customer satisfaction page (P.sla): five KPIs, SLA policy by plan + CSAT
// trend, Breaches by priority + Canned responses. Every figure comes from Support Desk tickets, their SLA clocks and the
// ratings customers gave (platform_sla); nothing is estimated – a value with no data shows "—" and says why.
const MAX_FIRST = 168, MAX_RES = 2160
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const hrs = (v: number | null) => v == null ? '—' : `${v >= 10 ? Math.round(v) : v.toFixed(1)} h`

function HoursInput({ value, label, onSave, disabled }: { value: number; label: string; onSave: (v: number) => Promise<boolean>; disabled?: boolean }) {
  const [v, setV] = useState(String(value))
  const [busy, setBusy] = useState(false)
  useEffect(() => setV(String(value)), [value])
  const commit = async () => {
    const n = Number(v)
    if (v.trim() === '' || n === value) { setV(String(value)); return }
    setBusy(true)
    if (!await onSave(n)) setV(String(value))
    setBusy(false)
  }
  return <input className={`${inputCls} sm`} style={{ ...inputStyle, width: 70 }} type="number" min={0.25} step={0.25} aria-label={label} value={v} disabled={disabled || busy}
    onChange={e => setV(e.target.value)} onBlur={() => void commit()} onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setV(String(value)); e.currentTarget.blur() } }} />
}

function ChannelsModal({ policy, channels, onClose, onSave }: { policy: SlaPolicy; channels: Record<string, string>; onClose: () => void; onSave: (c: string[]) => Promise<boolean> }) {
  const [sel, setSel] = useState(new Set(policy.channels))
  const [busy, setBusy] = useState(false)
  return <BwModal title={`Channels · ${policy.plan}`} width={380} onClose={onClose} foot={<>
    <Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy || !sel.size} onClick={async () => { setBusy(true); if (await onSave([...sel])) onClose(); setBusy(false) }}>Save</Btn></>}>
    <div className="grid gap-1.5">{Object.entries(channels).map(([k, l]) => <label key={k} className="flex items-center gap-2">
      <input type="checkbox" checked={sel.has(k)} onChange={e => setSel(s => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n })} />{l}</label>)}</div>
  </BwModal>
}

function CalendarModal({ cal, onClose, onSaved }: { cal: SlaCalendar; onClose: () => void; onSaved: () => void }) {
  const { success, error: showError } = useToast()
  const [days, setDays] = useState(new Set(cal.days))
  const [start, setStart] = useState(cal.day_start)
  const [end, setEnd] = useState(cal.day_end)
  const [holidays, setHolidays] = useState(cal.holidays.map(h => `${h.date} ${h.name}`).join('\n'))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const list = holidays.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [date, ...rest] = l.split(/\s+/); return { date, name: rest.join(' ') } })
    setBusy(true)
    try {
      await platformApi.slaUpdateCalendar({ days: [...days].sort(), day_start: start, day_end: end, holidays: list })
      success('Business hours saved', 'Applies to tickets opened from now on')
      onSaved()
    } catch (err) { showError(errMsg(err, 'Unable to save business hours')) } finally { setBusy(false) }
  }
  return <BwModal title="Business hours & holidays" width={480} onClose={onClose} foot={<>
    <Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy || !days.size} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
    <div className="grid gap-2">
      <Note info>Business-hours SLAs count only this working time (India Standard Time). Plans with 24×7 coverage, and P1 tickets on “24×7 for P1” plans, count every hour.</Note>
      <Field label="Working days"><div className="flex flex-wrap gap-1.5">{DAYS.map((d, i) => <label key={d} className="flex items-center gap-1">
        <input type="checkbox" checked={days.has(i + 1)} onChange={e => setDays(s => { const n = new Set(s); if (e.target.checked) n.add(i + 1); else n.delete(i + 1); return n })} />{d}</label>)}</div></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Day starts"><input className={inputCls} style={inputStyle} type="time" value={start} onChange={e => setStart(e.target.value)} /></Field>
        <Field label="Day ends"><input className={inputCls} style={inputStyle} type="time" value={end} onChange={e => setEnd(e.target.value)} /></Field>
      </div>
      <Field label="Holidays (one per line: YYYY-MM-DD Name)"><textarea className={`${inputCls} h-auto py-1`} style={inputStyle} rows={6} value={holidays} onChange={e => setHolidays(e.target.value)} /></Field>
    </div>
  </BwModal>
}

function PickTicketModal({ canned, onClose, onPick }: { canned: CannedResponse; onClose: () => void; onPick: (t: SupportTicket) => void }) {
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { platformApi.supportTickets(0).then(({ data }) => setTickets(data.items)).catch(err => setError(errMsg(err, 'Unable to load open tickets'))) }, [])
  return <BwModal title={`Insert “${canned.title}” into…`} width={520} onClose={onClose} foot={<Btn onClick={onClose}>Cancel</Btn>}>
    {!tickets ? <Empty>{error || 'Loading…'}</Empty> : !tickets.length ? <Empty>No open tickets to reply to.</Empty>
      : <div className="bw-list -mx-[14px]">{tickets.map(t => <div key={t.id}><span className="flex-1"><b>{t.ref}</b> · {t.subject}<br /><small style={{ color: C.mu }}>{t.tenant} · {t.priority}</small></span>
        <Btn s onClick={() => onPick(t)}>Insert</Btn></div>)}</div>}
  </BwModal>
}

export default function PlatformSlaPage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const navigate = useNavigate()
  const [data, setData] = useState<SlaOverview | null>(null)
  const [error, setError] = useState('')
  const [channelsFor, setChannelsFor] = useState<SlaPolicy | null>(null)
  const [calOpen, setCalOpen] = useState(false)
  const [picking, setPicking] = useState<CannedResponse | null>(null)
  const [openKpi, kpiPopup] = useKpiPopup()
  const load = useCallback(async () => {
    try { const { data: next } = await platformApi.sla(); setData(next); setError('') } catch (err) { setError(errMsg(err, 'SLA & CSAT unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])
  const canEdit = can('tenants', 'manage') && !!data?.all_scope

  const save = async (p: SlaPolicy, change: Partial<Pick<SlaPolicy, 'first_response_h' | 'resolution_h' | 'coverage' | 'channels'>>) => {
    const first = change.first_response_h ?? p.first_response_h, res = change.resolution_h ?? p.resolution_h
    const problem = !(first > 0 && first <= MAX_FIRST) ? `First response must be above 0 and at most ${MAX_FIRST} h`
      : !(res > 0 && res <= MAX_RES) ? `Resolution must be above 0 and at most ${MAX_RES} h` : first > res ? "First response can't be longer than resolution" : ''
    if (problem) { showError(problem); return false }
    try {
      const { data: r } = await platformApi.slaUpdatePolicy(p.plan_id, change)
      setData(d => d && { ...d, policies: d.policies.map(x => x.plan_id === p.plan_id ? r.policy : x) })
      if (r.changed) success('SLA policy saved', `${p.plan} – version ${r.version}; open tickets keep the policy they were raised under`)
      return true
    } catch (err) { showError(errMsg(err, 'Unable to save the SLA policy')); return false }
  }

  const insert = (c: CannedResponse, t: { id: number; ref: string }) => {
    insertIntoDraft(t.id, c.body)
    setCurrentTicket(t)
    success('Response inserted', `“${c.title}” added to the reply draft of ${t.ref} – review it before sending`)
    navigate(`/platform/support?ticket=${t.id}`)
  }
  const use = (c: CannedResponse) => { const cur = getCurrentTicket(); if (cur) insert(c, cur); else setPicking(c) }

  const k = data?.kpis
  const trend = data?.csat
  const rated = !!trend?.values.some(v => v != null)
  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <PageHead crumb="Governance" title="SLA & customer satisfaction" />
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}
    {k && <Strip items={[
      { l: 'SLA met · 30 days', kpi: 'sla.met', v: k.sla_met == null ? '—' : `${k.sla_met}%`, dc: k.sla_met == null ? undefined : k.sla_met >= 95 ? 'tok' : k.sla_met >= 85 ? 'twarn' : 'tbad', sp: k.sla_spark,
        d: k.sla_met == null ? 'no settled tickets' : undefined, title: `${k.met} of ${k.known} tickets with a known outcome met both targets` },
      { l: 'Avg first response', kpi: 'sla.first_response', v: hrs(k.avg_first_response_h), d: k.avg_first_response_h == null ? 'no replies yet' : undefined, title: `${k.first_responses} ticket(s) answered · 30 days` },
      { l: 'Avg resolution', kpi: 'sla.resolution', v: hrs(k.avg_resolution_h), d: k.avg_resolution_h == null ? 'none resolved' : undefined, title: `${k.resolutions} ticket(s) resolved · 30 days` },
      { l: 'CSAT', kpi: 'sla.csat', v: k.csat == null ? '—' : `${k.csat.toFixed(1)} / 5`, dc: k.csat == null ? undefined : k.csat >= 4 ? 'tok' : k.csat >= 3 ? 'twarn' : 'tbad',
        d: k.csat == null ? 'no ratings · 30 days' : undefined, title: `${k.csat_responses} rating(s) · 30 days` },
      { l: 'Breaches', kpi: 'sla.breaches', v: k.breaches, dc: k.breaches ? 'tbad' : undefined, title: `${k.first_breaches} first-response and ${k.resolution_breaches} resolution breach(es); a ticket counts once · 30 days` },
    ]} />}
    <div className="mb-2 grid gap-2 lg:grid-cols-2">
      <Panel title="SLA policy by plan" flush act={data && <Btn s g onClick={() => setCalOpen(true)} disabled={!canEdit}
        title={canEdit ? 'Working time used for business-hours SLAs' : 'Needs Tenants manage access with all-tenant scope'}>Business hours</Btn>}>
        <div className="overflow-x-auto"><table className="w-full text-left" style={{ minWidth: 520 }}>
          <thead><tr><th>Plan</th><th>First response (h)</th><th>Resolution (h)</th><th>Coverage</th><th>Channels</th></tr></thead>
          <tbody>{!data ? <tr><td colSpan={5} className="!p-0"><Empty>{error || 'Loading…'}</Empty></td></tr>
            : data.policies.map(p => <tr key={p.plan_id} title={p.version ? `Version ${p.version}${p.updated_by && p.updated_by !== 'seed' ? ` · ${p.updated_by}` : ''}` : undefined}>
              <td><b>{p.plan}</b>{!p.active && <small style={{ color: C.mu }}> · inactive</small>}</td>
              <td><HoursInput value={p.first_response_h} label={`${p.plan} first response hours`} disabled={!canEdit} onSave={v => save(p, { first_response_h: v })} /></td>
              <td><HoursInput value={p.resolution_h} label={`${p.plan} resolution hours`} disabled={!canEdit} onSave={v => save(p, { resolution_h: v })} /></td>
              <td>{canEdit ? <select className={`${inputCls} sm`} style={{ ...inputStyle, width: 'auto' }} value={p.coverage} aria-label={`${p.plan} coverage`}
                onChange={e => void save(p, { coverage: e.target.value as SlaPolicy['coverage'] })}>
                {Object.entries(data.coverage).map(([key, l]) => <option key={key} value={key}>{l}</option>)}</select> : p.coverage_label}</td>
              <td>{canEdit ? <button type="button" className="text-left underline decoration-dotted underline-offset-2" onClick={() => setChannelsFor(p)}>{p.channels_label}</button> : p.channels_label}</td>
            </tr>)}</tbody>
        </table></div>
      </Panel>
      <Panel title="CSAT trend">
        {!trend ? <Empty>{error || 'Loading…'}</Empty> : !rated ? <Empty>No satisfaction ratings in the last six months.</Empty> : <>
          <LineChart h={160} labels={trend.labels} f={v => (+v).toFixed(1)} series={[{ n: 'CSAT', c: PAL[2], v: trend.values }]} />
          <div className="mt-1 text-[11px]" style={{ color: C.mu }}>Monthly average of 1–5 ratings on resolved tickets; months without ratings are left out. {trend.responses.reduce((a, b) => a + b, 0)} rating(s) since {fd(trend.months[0])}.</div>
        </>}
      </Panel>
    </div>
    <div className="grid gap-2 lg:grid-cols-2">
      <Panel title="Breaches by priority">
        {!data ? <Empty>{error || 'Loading…'}</Empty>
          : <HBars lw={110} vw={30} c={C.ba} rows={data.breaches.map(b => ({ l: b.label, v: b.breaches, text: String(b.breaches),
            note: `${b.label}: ${b.breaches} ticket(s) breached · ${b.first_response} first response, ${b.resolution} resolution · 30 days` }))}
            onPick={i => { const b = data.breaches[i]; openKpi({ kpi: 'sla.breaches', title: `Breaches · ${b.label}`, value: b.breaches, query: { facet: b.label } }) }} />}
      </Panel>
      <Panel title="Canned responses" flush>
        {!data ? <Empty>{error || 'Loading…'}</Empty> : <div className="bw-list">{data.canned.map(c => <div key={c.id}>
          <span className="flex-1"><b>{c.title}</b><br /><small style={{ color: C.mu }}>{c.body}</small></span>
          <Btn s disabled={!can('tenants', 'manage')} title={can('tenants', 'manage') ? 'Insert into the reply draft of the current Support Desk ticket (not sent)' : 'Needs Tenants manage access'}
            onClick={() => use(c)}>Use</Btn>
        </div>)}</div>}
      </Panel>
    </div>
    {channelsFor && data && <ChannelsModal policy={channelsFor} channels={data.channels} onClose={() => setChannelsFor(null)} onSave={c => save(channelsFor, { channels: c })} />}
    {calOpen && data && <CalendarModal cal={data.calendar} onClose={() => setCalOpen(false)} onSaved={() => { setCalOpen(false); void load() }} />}
    {kpiPopup}
    {picking && <PickTicketModal canned={picking} onClose={() => setPicking(null)} onPick={t => { setPicking(null); insert(picking, { id: t.id, ref: t.ref }) }} />}
  </div>
}
