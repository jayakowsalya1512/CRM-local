// Customer 360 tabs – prototype v17 cust360() body, segVertTab(), hierTab().
import { useEffect, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { buildFilePreviewUrl } from '@/pages/questionnaire/questionnaireFormShared'
import { Modal } from '@/pages/notifications/Modal'
import { Av, BarPct, Bars, DOT, Donut, Funnel, Gauge, HBars, Line, PALC, Panel, Pill, Strip, Tbl } from './kit'
import { custApi, errMsg, fd, inr, type C360, type Doc, type Hierarchy, type Journey, type PeerRow, type Segment } from './customerApi'
import { PYC } from '@/pages/orders/orderApi'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { mapApiErrors, validate, type FieldSpec } from '@/utils/validation'

type Acts = { onLog: () => void; onEmail: (to?: string) => void; onNewDeal: () => void; onAddContact: () => void; onTab: (t: string) => void; onTimeline: (j: Journey) => void }
const fmtBy = (f: string, v: number) => f === 'inr' ? inr(v) : f === 'pct' ? `${Math.round(v)}%` : f === 'num' ? String(Math.round(v * 10) / 10) : String(Math.round(v))
const HICO: Record<string, string> = { 'Head Office': 'building', 'LHO / Regional Office': 'layout', 'Zone': 'globe', 'Divisional Office': 'brief', 'Branch / Site': 'pin' }

// ─── 360 overview ─────────────────────────────────────────────────────────────
export function Overview({ d, a }: { d: C360; a: Acts }) {
  const navigate = useNavigate()
  const o = d.overview, P = o.position
  return <>
    <div className="g g3 mb">
      <Panel title="Customer journey"><Funnel d={o.funnel} /></Panel>
      <Panel title="Revenue · 6 months"><Bars d={o.revenue6} h={120} f={v => `${+v.toFixed(1)}L`} /></Panel>
      <Panel title="Pipeline by stage"><HBars d={o.pipeline} f={inr} lw={110} vw={84} /></Panel>
    </div>
    <div className="g g2 mb">
      <Panel title="Position vs peers" z>
        <div className="row mb" style={{ gap: 6, flexWrap: 'wrap', padding: '10px 14px 0' }}><Pill s={P.band} t={P.band === 'Strategic' ? 'ok' : P.band === 'Growth' ? 'inf' : 'mu'} /><Pill s={P.vertical} t="ac" />
          {P.rank && <small className="mu">#{P.rank} of {P.of} in {P.band.toLowerCase()} by FY revenue</small>}</div>
        <Tbl rowKey={r => r.m} cols={[{ k: 'm', t: 'Metric' }, { k: 't', t: 'This customer', r: true, fn: r => <b>{fmtBy(r.f, r.t)}</b> },
          { k: 's', t: `${P.band} avg`, r: true, fn: r => fmtBy(r.f, r.s) }, { k: 'v', t: `${P.vertical} avg`, r: true, fn: r => fmtBy(r.f, r.v) },
          { k: 'd', t: 'vs segment', fn: r => { const dd = r.s ? Math.round((r.t - r.s) / r.s * 100) : 0, good = r.hi ? r.t >= r.s : r.t <= r.s; return <span className={good ? 'tok' : 'twarn'}>{dd > 0 ? '+' : ''}{dd}%</span> } }]} rows={P.rows} />
        <div style={{ padding: '8px 14px' }}><a onClick={() => a.onTab('Segment & vertical')}>Open full segment &amp; vertical analytics →</a></div>
      </Panel>
      <Panel title="Open items" z><div className="list">{o.open_items.length ? o.open_items.map((x, i) => <div key={i}><span className="fl"><b>{x.t}</b><br /><small>{x.s}</small></span><a onClick={() => navigate(x.route)}>Open</a></div>)
        : <div className="empty" style={{ padding: 12 }}>Nothing open</div>}</div></Panel>
    </div>
    <Panel title="Recent timeline">{o.timeline.length ? <div className="tl">{o.timeline.map((x, i) => <div key={i}><b>{x.text}</b> <Pill s={x.kind} t="mu" /><br /><small>{x.by ? `${x.by} · ` : ''}{fd(x.date)}</small></div>)}</div>
      : <div className="empty" style={{ padding: 12 }}>No activity, bids, orders or emails yet.</div>}</Panel>
  </>
}

// ─── Hierarchy ────────────────────────────────────────────────────────────────
export function HierarchyTab({ id, canUpdate, canCreate, onChanged }: { id: number; canUpdate: boolean; canCreate: boolean; onChanged: () => void }) {
  const navigate = useNavigate()
  const { success, error } = useToast()
  const [h, setH] = useState<Hierarchy | null>(null)
  const [adding, setAdding] = useState(false)
  useEffect(() => { setH(null); custApi.hierarchy(id).then(setH).catch(e => error(errMsg(e, 'Could not load the hierarchy'))) }, [id, error])
  if (!h) return <div className="empty">Loading…</div>
  const save = async (body: { kam_mode?: string; kam_id?: number | null }) => {
    try { setH(await custApi.setHierarchy(id, body)); success(body.kam_mode === 'Inherit from parent' ? 'Now using the common KAM from the parent' : 'KAM updated'); onChanged() }
    catch (e) { error(errMsg(e, 'Could not update the KAM')) }
  }
  const byId = Object.fromEntries(h.rows.map(r => [r.id, r]))
  const kids = (pid: number) => h.rows.filter(r => r.parent === pid)
  const node = (r: Hierarchy['rows'][number], depth: number): ReactElement => <div key={r.id}>
    <div className={`hnode ${r.id === h.current ? 'me' : ''}`} style={{ marginLeft: depth * 22 }}>
      <span className="hico"><Ic n={HICO[r.level] || 'building'} /></span>
      <div className="fl"><a onClick={() => navigate(`/customers/${r.id}`)}><b>{r.name}</b></a> {r.id === h.current && <Pill s="this" t="ac" />}<br />
        <small className="mu">{r.level} · {r.city} · {r.below ? `${r.below} below` : 'leaf'}</small></div>
      <div className="hkam">{r.kam ? <><Av name={r.kam} /> <span>{r.kam.split(' ')[0]}</span>{r.kam_own ? <Pill s="own" t="ok" /> : <span className="pill mu" title={`Common KAM from ${r.kam_from}`}>common</span>}</> : <span className="mu">unassigned</span>}</div>
      <div className="hnum">{inr(r.revenue)}<small>{r.open} open</small></div>
    </div>
    {kids(r.id).map(k => node(k, depth + 1))}
  </div>
  const root = byId[h.root.id]
  return <>
    <Strip items={h.strip} />
    <div className="note inf mb">A customer can report to a parent. Each entity either has its <b>own KAM</b> or <b>inherits a common KAM</b> from the nearest parent. Roll-ups add every entity below.</div>
    <div className="g g21 mb">
      <Panel title="Group structure" z act={canCreate ? <button type="button" className="btn s p" onClick={() => setAdding(true)}><Ic n="plus" /> Add child entity</button> : undefined}>
        <div className="htree">{root ? node(root, 0) : null}</div>
      </Panel>
      <Panel title="KAM coverage" z>
        <div className="list">{h.kams.length ? h.kams.map(k => <div key={k.name}><Av name={k.name} /><span className="fl"><b>{k.name}</b><br /><small className="mu">{k.entities} entities · {k.own} dedicated · {k.common} common</small></span><b>{inr(k.revenue)}</b></div>)
          : <div className="empty">No KAM assigned yet</div>}</div>
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--bw-ln)' }}>
          <label className="lb" htmlFor="hkm">KAM for {byId[h.current]?.name}</label>
          <div className="row" style={{ gap: 6 }}>
            <select id="hkm" className="in" value={h.kam_mode} disabled={!canUpdate} onChange={e => save({ kam_mode: e.target.value })}>
              <option>Own KAM</option><option disabled={!h.has_parent}>Inherit from parent</option></select>
            {h.kam_mode === 'Inherit from parent'
              ? <span className="pill mu" style={{ alignSelf: 'center' }}>{byId[h.current]?.kam || '—'} (common)</span>
              : <select className="in" aria-label="KAM" value={h.kam_id ?? ''} disabled={!canUpdate} onChange={e => save({ kam_mode: 'Own KAM', kam_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">—</option>{h.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
          </div>
        </div>
      </Panel>
    </div>
    <Panel title="Roll-up by entity" z>
      <Tbl rows={h.rows} onRow={r => navigate(`/customers/${r.id}`)} cols={[
        { k: 'n', t: 'Entity', fn: r => <span style={{ paddingLeft: r.depth * 14 }}>{r.depth ? <span className="mu">└ </span> : null}<a>{r.name}</a></span> },
        { k: 'l', t: 'Level', fn: r => r.level }, { k: 'kam', t: 'KAM', fn: r => <>{r.kam ? r.kam.split(' ')[0] : '—'}{!r.kam_own && r.kam ? <> <Pill s="common" t="mu" /></> : null}</> },
        { k: 'rev', t: 'Revenue', r: true, fn: r => inr(r.revenue) }, { k: 'pipe', t: 'Open pipeline', r: true, fn: r => inr(r.pipeline) },
        { k: 'ld', t: 'Leads', r: true, fn: r => r.leads }, { k: 'dl', t: 'Deals', r: true, fn: r => r.deals }, { k: 'tn', t: 'Bids', r: true, fn: r => r.bids }, { k: 'wo', t: 'Orders', r: true, fn: r => r.orders },
      ]} />
    </Panel>
    {adding && <AddChildModal h={h} parent={byId[h.current]?.name || ''} id={id} onClose={() => setAdding(false)} onDone={nid => { setAdding(false); success('Entity added – it follows the normal customer approval'); navigate(`/customers/${nid}`) }} />}
  </>
}

const CHILD_ORDER: [string, string][] = [['name', 'hn'], ['level', 'hl'], ['city', 'hc'], ['kam_id', 'hk']]
const invAttr = (m: string | undefined, id: string) => ({ 'aria-invalid': m ? true : undefined, 'aria-describedby': m ? `${id}-err` : undefined })
function AddChildModal({ h, parent, id, onClose, onDone }: { h: Hierarchy; parent: string; id: number; onClose: () => void; onDone: (id: number) => void }) {
  const { error } = useToast()
  const [v, setV] = useState({ name: '', level: h.next_level, city: h.rows.find(r => r.id === h.current)?.city?.replace('—', '') || '', kam_mode: 'Inherit from parent', kam_id: '' })
  const [busy, setBusy] = useState(false)
  const fe = useFieldErrors(), errs = fe.errors
  // backend ChildIn: name 2–300, level required, city 2–100 optional, kam_id required with Own KAM
  const specs = (all = v): Record<string, FieldSpec | undefined> => ({
    name: { label: 'Entity name', rule: 'name', required: true, min: 2, max: 300 }, level: { label: 'Level', rule: 'select', required: true },
    city: { label: 'City', rule: 'text', min: 2, max: 100 }, kam_id: all.kam_mode === 'Own KAM' ? { label: 'KAM', rule: 'select', required: true } : undefined,
  })
  const set = (k: keyof typeof v, x: string) => {
    const next = { ...v, [k]: x }; setV(next)
    if (k === 'kam_mode') { if (x !== 'Own KAM') fe.clear('kam_id') } else fe.change(k, x, specs(next)[k])
  }
  const leave = (k: keyof typeof v) => fe.blur(k, v[k], specs()[k])
  const jump = (bad: Record<string, string>) => { const f = CHILD_ORDER.find(([k]) => bad[k]); const el = f && document.getElementById(f[1]); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() } }
  const go = async () => {
    const bad = fe.validateAll(v, specs())
    if (Object.keys(bad).length) { jump(bad); return }
    setBusy(true)
    try { const r = await custApi.addChild(id, { name: v.name.trim(), level: v.level, city: v.city.trim(), kam_mode: v.kam_mode, kam_id: v.kam_id ? Number(v.kam_id) : null }); onDone(r.id) }
    catch (e) {
      const fx = Object.fromEntries(Object.entries(mapApiErrors(e)).filter(([k]) => CHILD_ORDER.some(([f]) => f === k)))
      if (Object.keys(fx).length) { fe.setErrors(x => ({ ...x, ...fx })); jump(fx) }
      else error(errMsg(e, 'Could not create the entity'))
    } finally { setBusy(false) }
  }
  return <Modal title={`Add child entity under ${parent}`} width={520} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" disabled={busy} onClick={go}>Create entity</button></>}>
    <div className="fg">
      <div className="f1"><label htmlFor="hn">Entity name</label><input id="hn" className={`in ${errs.name ? 'err' : ''}`} {...invAttr(errs.name, 'hn')} value={v.name} placeholder={`e.g. ${parent.split('–')[0].trim()} – Branch Anna Nagar`} onChange={e => set('name', e.target.value)} onBlur={() => leave('name')} /><FieldError id="hn" msg={errs.name} /></div>
      <div><label htmlFor="hl">Level</label><select id="hl" className={`in ${errs.level ? 'err' : ''}`} {...invAttr(errs.level, 'hl')} value={v.level} onChange={e => set('level', e.target.value)} onBlur={() => leave('level')}>{h.levels.map(l => <option key={l}>{l}</option>)}</select><FieldError id="hl" msg={errs.level} /></div>
      <div><label htmlFor="hc">City</label><input id="hc" className={`in ${errs.city ? 'err' : ''}`} {...invAttr(errs.city, 'hc')} value={v.city} onChange={e => set('city', e.target.value)} onBlur={() => leave('city')} /><FieldError id="hc" msg={errs.city} /></div>
      <div><label htmlFor="hm">KAM coverage</label><select id="hm" className="in" value={v.kam_mode} onChange={e => set('kam_mode', e.target.value)}><option>Inherit from parent</option><option>Own KAM</option></select></div>
      <div><label htmlFor="hk">KAM (if own)</label><select id="hk" className={`in ${errs.kam_id ? 'err' : ''}`} {...invAttr(errs.kam_id, 'hk')} value={v.kam_id} disabled={v.kam_mode !== 'Own KAM'} onChange={e => set('kam_id', e.target.value)} onBlur={() => leave('kam_id')}><option value="">—</option>{h.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select><FieldError id="hk" msg={errs.kam_id} /></div>
    </div>
    <div className="note inf mt" style={{ marginTop: 10 }}>Segment <b>{h.segment}</b> and sub-segment <b>{h.sub_segment}</b> are inherited from the parent.</div>
  </Modal>
}

// ─── Segment & vertical ───────────────────────────────────────────────────────
function PeerTbl({ rows, label }: { rows: PeerRow[]; label: string }) {
  return <Tbl rowKey={r => r.m} rows={rows} cols={[
    { k: 'm', t: 'Metric' }, { k: 'mine', t: 'This customer', r: true, fn: r => <b>{fmtBy(r.f, r.mine)}</b> },
    { k: 'avg', t: `${label} average`, r: true, fn: r => fmtBy(r.f, r.avg) }, { k: 'best', t: `Best in ${label}`, r: true, fn: r => fmtBy(r.f, r.best) },
    { k: 'd', t: 'vs average', r: true, fn: r => { const d = r.avg ? Math.round((r.mine - r.avg) / r.avg * 100) : 0, good = r.hi ? r.mine >= r.avg : r.mine <= r.avg; return <span className={good ? 'tok' : 'twarn'}>{d > 0 ? '+' : ''}{d}%</span> } },
    { k: 'bar', t: 'Relative to average', fn: r => { const b = r.avg ? Math.min(200, Math.round(r.mine / r.avg * 100)) : r.mine ? 200 : 0
      return <div className="pm" style={{ minWidth: 120, position: 'relative' }}><i style={{ width: `${Math.min(100, b / 2)}%`, background: b >= 100 ? 'var(--bw-ok)' : 'var(--bw-wa)' }} /><span style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, borderLeft: '1px dashed var(--bw-mu)' }} /></div> } },
  ]} />
}

export function SegmentTab({ id, a }: { id: number; a: Acts }) {
  const { error } = useToast()
  const [s, setS] = useState<Segment | null>(null)
  useEffect(() => { setS(null); custApi.segment(id).then(setS).catch(e => error(errMsg(e, 'Could not load segment analytics'))) }, [id, error])
  if (!s) return <div className="empty">Loading…</div>
  const sg = s.band, vt = s.vertical
  const hi = (L: Segment['top_s']) => L.map(x => ({ l: x.l, v: x.v, c: x.me ? 'var(--bw-ac)' : '#B8C4D0' }))
  return <>
    <Strip items={s.strip} />
    <div className="g g2 mb">
      <Panel title={<>Compared with the {sg} segment <small className="mu">· {s.n_s} customers</small></>} z><PeerTbl rows={s.peers_s} label={sg} /></Panel>
      <Panel title={<>Compared with the {vt} vertical <small className="mu">· {s.n_v} customers</small></>} z><PeerTbl rows={s.peers_v} label={vt} /></Panel>
    </div>
    <div className="g g2 mb">
      <Panel title={`Revenue ranking – ${sg} segment`}><HBars d={hi(s.top_s)} f={inr} lw={140} vw={84} /></Panel>
      <Panel title={`Revenue ranking – ${vt} vertical`}><HBars d={hi(s.top_v)} f={inr} lw={140} vw={84} /></Panel>
    </div>
    <div className="g g2 mb">
      <Panel title="Revenue per month vs peers (₹ L)"><Line h={170} labels={s.line.labels} ser={[{ n: 'This customer', c: 'var(--bw-ac)', v: s.line.mine }, { n: `${vt} average`, c: PALC[1], v: s.line.v_avg, fill: false }, { n: `${sg} average`, c: PALC[2], v: s.line.s_avg, fill: false }]} /></Panel>
      <Panel title="Where this customer sits" z><div className="tw"><table className="t"><thead><tr><th>Vertical \ Segment</th>{s.bands.map(b => <th key={b} className="c">{b}</th>)}</tr></thead>
        <tbody>{s.grid.map(g => <tr key={g.vertical}><td><b>{g.vertical}</b></td>{g.cells.map(c => <td key={c.band} className={`c ${c.me ? 'me' : ''}`}>{c.n ? `${c.n} · ${inr(c.rev)}` : <span className="mu">—</span>}{c.me && <><br /><small>◉ this customer</small></>}</td>)}</tr>)}</tbody></table></div></Panel>
    </div>
    <div className="g g3 mb">
      <Panel title={`Segment mix in ${vt}`}><Donut d={s.band_mix} c={s.n_v} cs="customers" /></Panel>
      <Panel title={`Vertical mix in ${sg}`}><Donut d={s.vert_mix.filter(x => x.v)} c={s.n_s} cs="customers" /></Panel>
      <Panel title="Health vs peers"><Bars h={150} d={s.health_bars.map((x, i) => ({ ...x, c: ['var(--bw-ac)', PALC[2], PALC[1]][i] }))} f={v => String(Math.round(v))} /></Panel>
    </div>
    <Panel title="Gaps vs peers" z>
      <div className="list">{s.gaps.map((g, i) => <div key={i}><span className="dot" style={{ background: DOT(g.t) }} /><span className="fl">{g.s}</span></div>)}</div>
      <div className="row" style={{ padding: '8px 12px', gap: 6, borderTop: '1px solid var(--bw-ln)' }}>
        <button type="button" className="btn s p" onClick={a.onNewDeal}><Ic n="plus" /> New deal</button>
        <button type="button" className="btn s" onClick={a.onLog}><Ic n="pin" /> Plan a visit</button>
        <button type="button" className="btn s" onClick={a.onAddContact}><Ic n="user" /> Add contact</button>
      </div>
    </Panel>
  </>
}

// ─── Journeys ─────────────────────────────────────────────────────────────────
export function JourneyStepper({ j }: { j: Journey }) {
  const navigate = useNavigate()
  return <div className="jtr">{j.steps.map(s => <div key={s.k} className={s.done ? 'on' : ''} role={s.route ? 'button' : undefined} tabIndex={s.route ? 0 : undefined}
    onClick={s.route ? () => navigate(s.route!) : undefined} onKeyDown={s.route ? e => { if (e.key === 'Enter') navigate(s.route!) } : undefined}>
    <b><span className="k">{s.k}</span>{s.label}</b><small className="mu">{s.done ? (s.stage || 'Done') : 'Not yet'}</small></div>)}</div>
}
export function Journeys({ d, a }: { d: C360; a: Acts }) {
  if (!d.journeys.length) return <div className="empty">No tracked journeys yet. Convert a lead for this customer to start one.</div>
  return <>{d.journeys.map(j => <div className="mb" key={`${j.kind}-${j.record_id}`} style={{ marginBottom: 14 }}>
    <div className="row mb"><b>{j.id}</b> <Pill s={j.stage} /><span className="fl" /><a onClick={() => a.onTimeline(j)}>Full timeline</a></div>
    <JourneyStepper j={j} />
  </div>)}</>
}

// ─── Contacts & org map ───────────────────────────────────────────────────────
export function Contacts({ d, a, onRole }: { d: C360; a: Acts; onRole: (cid: number) => void }) {
  const roles = ['Decision maker', 'Influencer', 'User', 'Gatekeeper']
  return <div className="g g2">
    <div>
      <Tbl rows={d.contacts} empty="No contacts yet – add the people you deal with." cols={[
        { k: 'name', t: 'Name', fn: x => <span className="row" style={{ gap: 6, display: 'inline-flex' }}><Av name={x.name} /> {x.name}</span> },
        { k: 'designation', t: 'Designation' },
        { k: 'r', t: 'Buying role', fn: x => d.can.update ? <a onClick={e => { e.stopPropagation(); onRole(x.id) }} title="Change buying role"><Pill s={x.buying_role || 'Not mapped'} t={x.buying_role ? 'ac' : 'mu'} /></a> : <Pill s={x.buying_role || 'Not mapped'} t={x.buying_role ? 'ac' : 'mu'} /> },
        { k: 'e', t: 'Engagement', fn: x => <span title="Share of this customer's activities in the last 12 months in which this contact took part"><BarPct v={x.engagement} /></span> },
        { k: 'phone', t: 'Phone' },
        { k: 'email', t: 'Email', fn: x => x.email ? <a onClick={e => { e.stopPropagation(); a.onEmail(x.email) }}>{x.email}</a> : '—' },
      ]} />
      {d.can.update && <button type="button" className="btn mt" style={{ marginTop: 8 }} onClick={a.onAddContact}><Ic n="plus" /> Add contact</button>}
    </div>
    <Panel title="Buying centre">{roles.map(rl => { const L = d.contacts.filter(x => x.buying_role === rl)
      return <div className="bc-role" key={rl}><small className="mu b">{rl.toUpperCase()}</small><div className="row wrap" style={{ gap: 6, marginTop: 3 }}>
        {L.length ? L.map(x => <span key={x.id} className="chip on"><Av name={x.name} /> {x.name}</span>) : <small className="mu">— none mapped (gap)</small>}</div></div> })}</Panel>
  </div>
}

// ─── Deals & bids ─────────────────────────────────────────────────────────────
export function DealsBids({ d }: { d: C360 }) {
  const navigate = useNavigate()
  const open = (r: { route: string }) => navigate(r.route)
  return <div className="g g2">
    <Panel title="Deals" z><Tbl rows={d.deals} onRow={open} empty="No deals for this customer" cols={[
      { k: 'name', t: 'Deal', fn: o => o.name.slice(0, 34) }, { k: 'value', t: 'Value', r: true, fn: o => inr(o.value) }, { k: 'stage', t: 'Stage', fn: o => <Pill s={o.stage} /> },
      { k: 'jid', t: 'Journey', fn: o => o.journey ? <><Pill s={o.journey.id} t="ac" /> <small className="jdots">{o.journey.dots.map(x => x ? '●' : '○').join('')}</small></> : <span className="mu">—</span> }]} /></Panel>
    <Panel title="Bids & tenders" z><Tbl rows={d.bids} onRow={open} empty="No bids for this customer" cols={[
      { k: 'ref', t: 'Bid', fn: o => <span className="mono">{o.ref}</span> }, { k: 'value', t: 'Value', r: true, fn: o => inr(o.value) }, { k: 'stage', t: 'Stage', fn: o => <Pill s={o.stage} /> }, { k: 'deadline', t: 'Deadline', fn: o => fd(o.deadline) }]} /></Panel>
    <Panel title="Quotes" z><Tbl rows={d.quotes} onRow={open} empty="No quotes for this customer" cols={[
      { k: 'ref', t: 'Quote', fn: o => <span className="mono">{o.ref}</span> }, { k: 'subject', t: 'Subject', fn: q => q.subject.slice(0, 34) }, { k: 'stage', t: 'Stage', fn: o => <Pill s={o.stage} /> }]} /></Panel>
    <Panel title="Leads" z><Tbl rows={d.leads} onRow={open} empty="No leads for this customer" cols={[
      { k: 'ref', t: 'Lead', fn: o => <span className="mono">{o.ref}</span> }, { k: 'interest', t: 'Interest' }, { k: 'stage', t: 'Stage', fn: o => <Pill s={o.stage} /> }]} /></Panel>
  </div>
}

// ─── Orders & billing ─────────────────────────────────────────────────────────
export function Orders({ d }: { d: C360 }) {
  const navigate = useNavigate()
  const b = d.billing
  return <>
    <Strip items={[
      { l: 'Order value', v: b.order_value, f: 'inr' }, { l: 'Billed', v: b.billed, f: 'inr', note: `${b.invoices} invoice${b.invoices === 1 ? '' : 's'}` },
      { l: 'Collected', v: b.collected, f: 'inr', dc: 'tok', note: `${b.receipts} receipt${b.receipts === 1 ? '' : 's'} acknowledged by Finance` },
      { l: 'Awaiting finance', v: b.awaiting, f: 'inr', dc: b.awaiting ? 'twarn' : '', note: 'recorded, not yet acknowledged' },
      { l: 'Outstanding', v: b.outstanding, f: 'inr', dc: b.outstanding ? 'twarn' : '', note: `of ${inr(b.due)} due to date` },
      { l: 'Avg payment delay', v: b.avg_delay == null ? null : `${b.avg_delay} d`, f: 'text', note: b.avg_delay == null ? 'no acknowledged payments yet' : 'bank credit − stage due date' },
    ]} />
    <div className="g g2">
      <Panel title="Orders & contracts" z><Tbl rows={d.orders} onRow={r => navigate(r.route)} empty="No orders yet" cols={[
        { k: 'ref', t: 'Order', fn: o => <span className="mono">{o.ref}</span> }, { k: 'type', t: 'Type', fn: o => <Pill s={o.type} t="ac" /> }, { k: 'value', t: 'Value', r: true, fn: o => inr(o.value) },
        { k: 'progress', t: 'Progress', fn: o => <BarPct v={o.progress} /> }, { k: 'billed', t: 'Billed', fn: o => `${o.billed}%` }]} /></Panel>
      <Panel title="Payment schedule" z><Tbl rows={d.schedule} rowKey={(_, i) => i} onRow={m => navigate(`/workorders?open=${m.wo_id}`)} empty="No payment schedule on the orders yet" cols={[
        { k: 'milestone', t: 'Stage' }, { k: 'pct', t: '%', r: true, fn: m => m.pct == null ? '—' : m.pct }, { k: 'amount', t: 'Amount', r: true, fn: m => inr(m.amount) },
        { k: 'due', t: 'Due', fn: m => m.due ? fd(m.due) : '—' }, { k: 'received', t: 'Received', r: true, fn: m => m.received ? inr(m.received) : '—' },
        { k: 'balance', t: 'Balance', r: true, fn: m => m.balance ? inr(m.balance) : '—' }, { k: 'status', t: 'Status', fn: m => <Pill s={m.status} t={PYC[m.status]} /> }]} /></Panel>
    </div>
  </>
}

// ─── Guarantees ───────────────────────────────────────────────────────────────
export function Guarantees({ d }: { d: C360 }) {
  const navigate = useNavigate()
  return <Tbl rows={d.guarantees} onRow={r => navigate(r.route)} empty="No guarantees for this customer" cols={[
    { k: 'type', t: 'Type' }, { k: 'ref', t: 'Ref', fn: e => <span className="mono">{e.ref}</span> }, { k: 'bid', t: 'Bid' }, { k: 'bank', t: 'Bank' },
    { k: 'amount', t: 'Amount', r: true, fn: e => inr(e.amount) }, { k: 'valid_until', t: 'Valid until', fn: e => fd(e.valid_until) }, { k: 'status', t: 'Status', fn: e => <Pill s={e.status} /> }]} />
}

// ─── Activity & comms ─────────────────────────────────────────────────────────
export function Activity({ d, a, onMail }: { d: C360; a: Acts; onMail: (id: number) => void }) {
  const navigate = useNavigate()
  return <>
    <div className="row mb">
      {d.can.log_activity && <button type="button" className="btn p s" onClick={a.onLog}><Ic n="plus" /> Log activity</button>}
      <button type="button" className="btn s" onClick={() => a.onEmail()}><Ic n="mail" /> Email</button>
      <span className="fl" /><small className="mu">{d.activities.length} activities · {d.emails.length} emails</small>
    </div>
    <Tbl rows={d.activities} onRow={r => navigate(r.route)} empty="No activity logged" cols={[
      { k: 'date', t: 'Date', fn: x => fd(x.date) }, { k: 'type', t: 'Type', fn: x => <Pill s={x.type} t="ac" /> }, { k: 'notes', t: 'Notes', fn: x => x.notes },
      { k: 'by', t: 'By', fn: x => x.by ? <span className="row" style={{ gap: 6, display: 'inline-flex' }}><Av name={x.by} /> {x.by}</span> : '—' }, { k: 'outcome', t: 'Outcome', fn: x => <Pill s={x.outcome} /> }]} />
    {d.emails.length > 0 && <><h3 className="mt mb" style={{ margin: '14px 0 8px' }}>Emails</h3>
      <Tbl rows={d.emails} onRow={r => onMail(r.id)} cols={[{ k: 'subject', t: 'Subject' }, { k: 'from', t: 'From' }, { k: 'sent', t: 'When', fn: e => fd(e.sent) }, { k: 'opens', t: 'Opens', r: true }]} /></>}
  </>
}

// ─── Documents ────────────────────────────────────────────────────────────────
export function Documents({ id, allowed }: { id: number; allowed: boolean }) {
  const navigate = useNavigate()
  const { error } = useToast()
  const [docs, setDocs] = useState<Doc[] | null>(null)
  useEffect(() => { if (!allowed) return; setDocs(null); custApi.documents(id).then(setDocs).catch(e => { setDocs([]); error(errMsg(e, 'Could not load documents')) }) }, [id, allowed, error])
  if (!allowed) return <div className="empty">You don't have access to Document Hub.</div>
  if (!docs) return <div className="empty">Loading…</div>
  return <>
    <Tbl rows={docs} rowKey={r => r.id} onRow={r => window.open(buildFilePreviewUrl(r.url), '_blank', 'noopener')} empty="No documents linked to this customer yet" cols={[
      { k: 'name', t: 'File', fn: x => <span className="row" style={{ gap: 6, display: 'inline-flex' }}><Ic n="file" /> {x.name}</span> }, { k: 'folder', t: 'Folder', fn: x => x.source + (x.record_label && x.record_label !== '-' ? ` · ${x.record_label}` : '') },
      { k: 'updated', t: 'Updated', fn: x => <span className="row" style={{ gap: 6, display: 'inline-flex' }}>{fd(x.updated_at)}
        <a href={buildFilePreviewUrl(x.url, '/preview/download')} onClick={e => e.stopPropagation()} title="Download" aria-label={`Download ${x.name}`}><Ic n="dl" /></a></span> }]} />
    <div style={{ marginTop: 8 }}><a onClick={() => navigate('/document-management')}>Open Document Hub →</a></div>
  </>
}

// ─── Account plan ─────────────────────────────────────────────────────────────
export function Plan({ d, id }: { d: C360; id: number }) {
  const { success, error } = useToast()
  const [p, setP] = useState(d.plan)
  const [saved, setSaved] = useState(d.plan)
  useEffect(() => { setP(d.plan); setSaved(d.plan) }, [d.plan])
  const F: [keyof C360['plan'], string][] = [['goal', 'Goals this year'], ['strategy', 'Engagement strategy'], ['risks', 'Risks'], ['white_space', 'White-space opportunities']]
  const fe = useFieldErrors(), errs = fe.errors
  // backend PlanIn: value ≤ 5000 characters
  const pspec = (l: string): FieldSpec => ({ label: l, rule: 'textarea', max: 5000 })
  const save = async (f: keyof C360['plan'], l: string) => {
    // whitespace-only clears the field (saved as empty); anything else must pass the length check before saving
    const val = String(p[f] || ''), msg = val.trim() ? validate(val, pspec(l)) : ''
    fe.setError(f, msg)
    if (msg || p[f] === saved[f]) return
    try { const r = await custApi.savePlan(id, f, String(p[f] || '')); setSaved(r); setP(x => ({ ...x, updated_at: r.updated_at, updated_by: r.updated_by })); fe.clear(f); success('Account plan saved') }
    catch (e) {
      const m = mapApiErrors(e, { value: f })[f]
      if (m) fe.setError(f, m)
      else { error(errMsg(e, 'Could not save the account plan')); setP(x => ({ ...x, [f]: saved[f] })) }
    }
  }
  return <>
    <div className="fg">{F.map(([f, l]) => <div className="f1" key={f}><label htmlFor={`pl-${f}`}>{l}</label>
      <textarea id={`pl-${f}`} className={`in ${errs[f] ? 'err' : ''}`} rows={2} maxLength={5000} value={String(p[f] || '')} disabled={!d.can.update} placeholder={d.can.update ? 'Not written yet' : ''}
        aria-invalid={errs[f] ? true : undefined} aria-describedby={errs[f] ? `pl-${f}-err` : undefined}
        onChange={e => { const x = e.target.value; setP(s => ({ ...s, [f]: x })); if (x.trim()) fe.change(f, x, pspec(l)); else fe.clear(f) }} onBlur={() => void save(f, l)} /><FieldError id={`pl-${f}`} msg={errs[f]} /></div>)}</div>
    {p.updated_at && <small className="mu" style={{ display: 'block', marginTop: 8 }}>Last updated {fd(p.updated_at)}{p.updated_by ? ` by ${p.updated_by}` : ''}</small>}
  </>
}

// ─── Health & risk ────────────────────────────────────────────────────────────
export function Health({ d }: { d: C360 }) {
  const h = d.health
  return <div className="g g2">
    <div><Panel title={`Health score · ${h.score}`}><div style={{ display: 'flex', gap: 14, alignItems: 'center' }}><div style={{ flex: 'none' }}><Gauge v={h.score} /></div>
      <div className="fl">{h.drivers.map(x => <div className="mb" key={x.n} title={x.why}><div className="row"><small className="fl b">{x.n}</small><small>{x.v}</small></div>
        <div className="pm"><i style={{ width: `${x.v}%`, background: x.v < 50 ? 'var(--bw-ba)' : x.v < 70 ? 'var(--bw-wa)' : 'var(--bw-ok)' }} /></div><small className="mu">{x.why}</small></div>)}</div></div></Panel></div>
    <div><Panel title="Risks & recommended actions" z><div className="list">{h.risks.map((x, i) => <div key={i}><span className="dot" style={{ background: DOT(x.t) }} /><span className="fl">{x.s}</span></div>)}</div></Panel></div>
  </div>
}
