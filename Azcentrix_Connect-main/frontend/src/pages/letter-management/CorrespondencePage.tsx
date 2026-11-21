// Correspondence – prototype v17 R.letters: crumb Control · "Correspondence" · + New letter; tabs Mail · Register · Templates · Compose ·
// Campaigns · Sequences · Mailbox setup.  Mail = the Inbox module; Register / Templates / Compose = the letters module (auto reference
// number, merge fields, live preview, Save & mark dispatched / Save draft / Send for e-sign); Campaigns, Sequences and Mailbox setup = /correspondence.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import FieldError from '@/components/form/FieldError'
import { useModalValidation } from '@/components/form/useModalValidation'
import type { FieldSpec } from '@/utils/validation'
import { Av, BarPct, Panel, Pill, Strip, Tbl } from '@/pages/customers/kit'
import { inboxApi, type MailItem, type Mailbox } from '@/pages/notifications/inboxApi'
import { corrApi, errMsg, fd, type Campaign, type MergeData, type RegRow, type Sequence, type Template, type TenderOpt } from './correspondenceApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/settings/appSettings.css'
import '@/pages/settings/admin360.css'
import './correspondence.css'

const TABS = ['Mail', 'Register', 'Templates', 'Compose', 'Campaigns', 'Sequences', 'Mailbox setup'] as const
type Tab = typeof TABS[number]
const PAGE = 25
const merge = (body: string, m: MergeData | null) => body.replace(/{{(\w+)}}/g, (x, k: string) => (m && (m as any)[k] != null && (m as any)[k] !== '' ? String((m as any)[k]) : x))

export default function CorrespondencePage() {
  const [sp, setSp] = useSearchParams()
  const tab: Tab = (TABS as readonly string[]).includes(sp.get('tab') || '') ? (sp.get('tab') as Tab) : 'Mail'
  const setTab = (t: Tab, extra?: Record<string, string>) => setSp(s => { const n = new URLSearchParams(s); n.set('tab', t); Object.entries(extra || {}).forEach(([k, v]) => n.set(k, v)); return n })
  return <div className="bwi">
    <div className="pg"><div><div className="crumb">Control</div><h1>Correspondence</h1></div><span className="fl" />
      <button type="button" className="btn p" onClick={() => setTab('Compose')}><Ic n="plus" /> New letter</button></div>
    <div className="panel">
      <div className="tabs mb" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)} onKeyDown={e => { if (e.key === 'Enter') setTab(t) }}>{t}</div>)}</div>
      <div className={`pb ${tab === 'Register' || tab === 'Mail' ? 'z' : ''}`}>
        {tab === 'Mail' && <MailTab />}
        {tab === 'Register' && <RegisterTab />}
        {tab === 'Templates' && <TemplatesTab onUse={id => setTab('Compose', { tpl: String(id) })} />}
        {tab === 'Compose' && <ComposeTab tplId={sp.get('tpl')} onSaved={() => setTab('Register')} />}
        {tab === 'Campaigns' && <CampaignsTab />}
        {tab === 'Sequences' && <SequencesTab />}
        {tab === 'Mailbox setup' && <MailboxTab />}
      </div>
    </div>
  </div>
}

/* ───────────── Mail (Inbox module) ───────────── */
function MailTab() {
  const navigate = useNavigate()
  const { error } = useToast()
  const [folder, setFolder] = useState<'Inbox' | 'Sent' | 'Drafts' | 'Archive'>('Inbox')
  const [q, setQ] = useState('')
  const [data, setData] = useState<{ items: MailItem[]; folders: { name: string; total: number; unread: number }[] } | null>(null)
  useEffect(() => { const t = setTimeout(() => inboxApi.list(folder, '', q).then(setData).catch(e => error(errMsg(e, 'Could not load mail'))), 120); return () => clearTimeout(t) }, [folder, q, error])
  return <>
    <div className="tbr">{(['Inbox', 'Sent', 'Drafts', 'Archive'] as const).map(f => <span key={f} role="button" className={`chip ${f === folder ? 'on' : ''}`} onClick={() => setFolder(f)}>{f} <small style={{ color: 'inherit', opacity: .7 }}>{data?.folders.find(x => x.name === f)?.total ?? ''}</small></span>)}
      <span className="fl" /><input className="in" placeholder="Search mail…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search mail" />
      <button type="button" className="btn s" onClick={() => navigate('/notifications/inbox')}><Ic n="mail" /> Open inbox</button></div>
    <Tbl<MailItem> rows={data?.items || []} rowKey={r => r.id} onRow={r => navigate(`/notifications/inbox?open=${r.id}`)} empty={data ? 'No mail in this folder.' : 'Loading…'} cols={[
      { k: 'from_name', t: 'From', fn: r => <span className={r.is_read ? '' : 'b'} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Av name={r.from_name} />{r.from_name}</span> },
      { k: 'subject', t: 'Subject', fn: r => <span className={r.is_read ? '' : 'b'}>{r.subject}<small className="mu"> — {r.preview?.slice(0, 60)}</small></span> },
      { k: 'link', t: 'Linked to', fn: r => r.link ? <Pill s={`${r.link.type} ${r.link.ref}`} t="ac" /> : <span className="mu">—</span> },
      { k: 'attachments', t: 'Files', r: true, fn: r => r.attachments ? `${r.attachments} 📎` : '' }, { k: 'time', t: 'Received', fn: r => r.time ? fd(r.time) : '—' },
    ]} />
  </>
}

/* ───────────── Register ───────────── */
function RegisterTab() {
  const navigate = useNavigate()
  const { error } = useToast()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [d, setD] = useState<{ items: RegRow[]; total: number; counts: Record<string, number> } | null>(null)
  useEffect(() => { const t = setTimeout(() => corrApi.register({ q, status, offset, limit: PAGE }).then(setD).catch(e => error(errMsg(e, 'Could not load the register'))), 120); return () => clearTimeout(t) }, [q, status, offset, error])
  return <>
    <div className="tbr">{['', 'Draft', 'Dispatched'].map(s => <span key={s} role="button" className={`chip ${s === status ? 'on' : ''}`} onClick={() => { setStatus(s); setOffset(0) }}>{s || 'All'} <small style={{ color: 'inherit', opacity: .7 }}>{s ? d?.counts[s] ?? '' : ((d?.counts.Draft || 0) + (d?.counts.Dispatched || 0)) || ''}</small></span>)}
      <span className="fl" /><input className="in" placeholder="Search ref, letter, recipient…" value={q} onChange={e => { setQ(e.target.value); setOffset(0) }} aria-label="Search letters" />
      <button type="button" className="btn s" onClick={() => navigate('/letter-management/classic')}>Classic editor</button></div>
    <Tbl<RegRow> rows={d?.items || []} rowKey={r => r.id} onRow={r => navigate(`/letter-management/classic?letter=${r.id}`)} empty={d ? 'No letters yet – compose the first one.' : 'Loading…'} cols={[
      { k: 'ref', t: 'Ref no.', fn: r => <span className="mono">{r.ref}</span> }, { k: 'tpl', t: 'Letter' }, { k: 'to', t: 'Addressed to' }, { k: 'against', t: 'Against' },
      { k: 'date', t: 'Date', fn: r => fd(r.date) }, { k: 'by', t: 'Prepared by', fn: r => <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Av name={r.by} />{r.by}</span> },
      { k: 'status', t: 'Status', fn: r => <Pill s={r.status} t={r.status === 'Draft' ? 'wa' : 'ok'} /> },
    ]} />
    {d && d.total > PAGE && <div className="pgn"><span>{offset + 1}–{Math.min(offset + PAGE, d.total)} of {d.total}</span><span className="fl" />
      <button type="button" className="btn s" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - PAGE))}>‹ Prev</button><button type="button" className="btn s" disabled={offset + PAGE >= d.total} onClick={() => setOffset(o => o + PAGE)}>Next ›</button></div>}
  </>
}

/* ───────────── Templates ───────────── */
function TemplatesTab({ onUse }: { onUse: (id: number) => void }) {
  const navigate = useNavigate()
  const { error } = useToast()
  const [t, setT] = useState<Template[] | null>(null)
  useEffect(() => { corrApi.templates().then(setT).catch(e => error(errMsg(e, 'Could not load templates'))) }, [error])
  const n = (b: string) => (b.match(/{{\w+}}/g) || []).length
  return <>
    <div className="row mb"><span className="fl" /><button type="button" className="btn s" onClick={() => navigate('/letter-management/classic?tab=templates')}><Ic n="edit" /> Manage templates</button></div>
    {!t ? <div className="empty">Loading…</div> : !t.length ? <div className="empty">No templates yet – create them in the classic editor.</div>
      : <div className="list bx">{t.map(x => <div key={x.id}><span className="fl"><b>{x.name}</b><br /><small>{n(x.template_body)} merge fields{x.category ? ` · ${x.category}` : ''}</small></span><button type="button" className="btn s" onClick={() => onUse(x.id)}>Use template</button></div>)}</div>}
  </>
}

/* ───────────── Compose (merge fields + live preview) ───────────── */
function ComposeTab({ tplId, onSaved }: { tplId: string | null; onSaved: () => void }) {
  const { success, error, info } = useToast()
  const [tpls, setTpls] = useState<Template[]>([])
  const [tpl, setTpl] = useState<number | null>(tplId ? Number(tplId) : null)
  const [tenders, setTenders] = useState<TenderOpt[]>([])
  const [tender, setTender] = useState<number | null>(null)
  const [m, setM] = useState<MergeData | null>(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const cv = useModalValidation({ tpl, body }, (): Record<string, FieldSpec> => ({
    tpl: { label: 'Template', rule: 'select', required: true },
    body: { label: 'Letter body', rule: 'textarea', required: true, max: 50000 },
  }), undefined, { tpl: 'cmp-tpl', body: 'cmp-body' })
  useEffect(() => { corrApi.templates().then(ts => { setTpls(ts); const first = tplId ? ts.find(x => x.id === Number(tplId)) : ts[0]; if (first) { setTpl(first.id); setBody(first.template_body) } }).catch(e => error(errMsg(e))) }, [tplId, error])
  useEffect(() => { corrApi.tenders().then(ts => { setTenders(ts); if (ts[0] && tender == null) setTender(ts[0].id) }).catch(() => undefined) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { corrApi.mergeData(tender).then(setM).catch(() => undefined) }, [tender])
  const fields = m?.fields || ['customer', 'tender_no', 'title', 'value', 'emd', 'date', 'ref_no', 'signatory']
  const insert = (f: string) => { const t = ta.current; if (!t) return setBody(b => b + `{{${f}}}`); const s = t.selectionStart, e = t.selectionEnd; const v = `${body.slice(0, s)}{{${f}}}${body.slice(e)}`; setBody(v); requestAnimationFrame(() => { t.focus(); t.setSelectionRange(s + f.length + 4, s + f.length + 4) }) }
  const save = async (dispatch: boolean) => {
    if (!cv.submit()) return
    setBusy(true)
    try {
      const t = tpls.find(x => x.id === tpl); const tn = tenders.find(x => x.id === tender)
      const r = await corrApi.createLetter({ letter_template_id: tpl, letter_type_id: t?.letter_type_id ?? null, title: t?.name || 'Letter', subject: t?.subject || t?.name || 'Letter', body: merge(body, m),
        linked_source: tn ? 'tenders' : null, linked_record_id: tn?.id ?? null, linked_record_label: tn ? `${tn.no || 'Tender #' + tn.id} – ${tn.customer}` : null, recipient_name: m?.customer || tn?.customer || null })
      if (dispatch) await corrApi.issueLetter(r.id)
      success(dispatch ? `Letter ${r.letter_no} saved with auto reference number and marked dispatched` : `Saved as draft · ${r.letter_no}`)
      onSaved()
    } catch (e) { if (!cv.server(e, { letter_template_id: 'tpl' })) error(errMsg(e)) } finally { setBusy(false) }
  }
  return <div className="g g2">
    <div>
      <div className="fg mb">
        <div><label>Template</label><select id="cmp-tpl" className={`in ${cv.bad('tpl') ? 'err' : ''}`} value={tpl ?? ''} {...cv.aria('tpl')} onChange={e => { const id = Number(e.target.value) || null; setTpl(id); const t = tpls.find(x => x.id === id); if (t) setBody(t.template_body); cv.change({ tpl: id, body: t ? t.template_body : body }, 'tpl', 'body') }}>{!tpls.length && <option value="">No templates yet</option>}{tpls.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select><FieldError id="cmp-tpl" msg={cv.errors.tpl} /></div>
        <div><label>Against tender</label><select className="in" value={tender ?? ''} onChange={e => setTender(e.target.value ? Number(e.target.value) : null)}><option value="">— none —</option>{tenders.map(t => <option key={t.id} value={t.id}>{t.no || `Tender #${t.id}`} – {t.customer}</option>)}</select></div>
      </div>
      <label className="lb">Merge fields</label>
      <div className="row wrap mb" style={{ gap: 3 }}>{fields.map(f => <span key={f} role="button" className="chip" onClick={() => insert(f)}>{`{{${f}}}`}</span>)}</div>
      <textarea id="cmp-body" ref={ta} className={`in lbody ${cv.bad('body') ? 'err' : ''}`} rows={15} value={body} {...cv.aria('body')} onChange={e => { setBody(e.target.value); cv.change({ tpl, body: e.target.value }, 'body') }} />
      <FieldError id="cmp-body" msg={cv.errors.body} />
      <div className="row mt wrap"><button type="button" className="btn p" disabled={busy} onClick={() => save(true)}>Save &amp; mark dispatched</button>
        <button type="button" className="btn" disabled={busy} onClick={() => save(false)}>Save draft</button>
        <button type="button" className="btn" onClick={() => info('Connect DigiSign / e-Sign in Marketplace & API to send letters for signature')}>Send for e-sign</button></div>
    </div>
    <div><label className="lb">Live preview</label><div className="lt">{merge(body, m) || <span className="mu">Pick a template to start…</span>}</div></div>
  </div>
}

/* ───────────── Campaigns ───────────── */
function CampaignsTab() {
  const { success, error } = useToast()
  const [c, setC] = useState<Campaign[] | null>(null)
  const [open, setOpen] = useState(false)
  const load = useCallback(() => corrApi.campaigns().then(setC).catch(e => error(errMsg(e, 'Could not load campaigns'))), [error])
  useEffect(() => { load() }, [load])
  const sent = (c || []).filter(x => x.sent)
  const avg = (k: 'open' | 'click') => (sent.length ? Math.round(sent.reduce((a, b) => a + b[k], 0) / sent.length) : 0)
  return <>
    <Strip items={[{ l: 'Campaigns', v: c?.length ?? 0, f: 'int' }, { l: 'Emails sent', v: (c || []).reduce((a, b) => a + b.sent, 0), f: 'int' }, { l: 'Avg open rate', v: `${avg('open')}%`, f: 'text' }, { l: 'Avg click rate', v: `${avg('click')}%`, f: 'text' }, { l: 'Leads generated', v: (c || []).reduce((a, b) => a + b.leads, 0), f: 'int', dc: 'tok' }]} />
    <div className="row mb"><button type="button" className="btn p" onClick={() => setOpen(true)}><Ic n="plus" /> New campaign</button><small className="mu">Open, click and reply rates fill in once outbound tracking is connected in Mailbox setup.</small></div>
    <Tbl<Campaign> rows={c || []} rowKey={r => r.id} empty={c ? 'No campaigns yet.' : 'Loading…'} cols={[
      { k: 'n', t: 'Campaign', fn: r => <b>{r.n}</b> }, { k: 'aud', t: 'Audience' }, { k: 'tpl', t: 'Template' }, { k: 'st', t: 'Status', fn: r => <Pill s={r.st} t={r.st === 'Sent' ? 'ok' : 'wa'} /> },
      { k: 'sent', t: 'Sent', r: true }, { k: 'open', t: 'Opened', fn: r => r.sent ? <BarPct v={r.open} /> : '—' }, { k: 'click', t: 'Clicked', fn: r => r.sent ? <BarPct v={r.click} /> : '—' },
      { k: 'reply', t: 'Replies %', r: true, fn: r => r.sent ? `${r.reply}%` : '—' }, { k: 'leads', t: 'Leads', r: true }, { k: 'at', t: 'Date', fn: r => fd(r.at) },
      { k: 'x', t: '', fn: r => r.st === 'Scheduled' ? <button type="button" className="btn s p" onClick={() => corrApi.sendCampaign(r.id).then(x => { success(`Campaign sent to ${x.sent} recipients`); load() }).catch(e => error(errMsg(e)))}>Send now</button> : null },
    ]} />
    {open && <CampaignModal onClose={() => setOpen(false)} onSaved={msg => { setOpen(false); success(msg); load() }} />}
  </>
}

function CampaignModal({ onClose, onSaved }: { onClose: () => void; onSaved: (msg: string) => void }) {
  const { error } = useToast()
  const [aud, setAud] = useState<{ k: string; l: string }[]>([])
  const [tpls, setTpls] = useState<Template[]>([])
  const [d, setD0] = useState({ name: '', audience: '', template_id: null as number | null, send: 'now', subject_a: '', subject_b: '', create_lead: true })
  const cv = useModalValidation(d, (): Record<string, FieldSpec> => ({
    name: { label: 'Campaign name', rule: 'text', required: true, min: 2, max: 200 },
    audience: { label: 'Audience', rule: 'select', required: true },
    send: { label: 'Send', rule: 'select', required: true },
    subject_a: { label: 'Subject', rule: 'text', max: 200 },
    subject_b: { label: 'Subject B', rule: 'text', max: 200 },
  }), undefined, { name: 'cmp-name', audience: 'cmp-aud', send: 'cmp-send', subject_a: 'cmp-sa', subject_b: 'cmp-sb' })
  const setD = (next: typeof d) => { const ch = (Object.keys(next) as (keyof typeof d)[]).filter(k => next[k] !== d[k]); setD0(next); cv.change(next, ...ch) }
  const create = () => {
    if (!cv.submit()) return
    corrApi.createCampaign({ ...d, name: d.name.trim() }).then(() => onSaved(d.send === 'now' ? 'Campaign sent' : 'Campaign scheduled')).catch(e => { if (!cv.server(e)) error(errMsg(e)) })
  }
  useEffect(() => { corrApi.audiences().then(a => { setAud(a); setD0(x => ({ ...x, audience: a[0]?.k || '' })) }).catch(() => undefined); corrApi.templates().then(setTpls).catch(() => undefined) }, [])
  return <Modal title="New email campaign" width={560} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" onClick={create}>Create campaign</button></>}>
    <div className="fg">
      <div className="f1"><label>Campaign name</label><input id="cmp-name" className={`in ${cv.bad('name') ? 'bad' : ''}`} autoFocus maxLength={200} value={d.name} {...cv.aria('name')} onChange={e => setD({ ...d, name: e.target.value })} /><FieldError id="cmp-name" msg={cv.errors.name} /></div>
      <div className="f1"><label>Audience</label><select id="cmp-aud" className={`in ${cv.bad('audience') ? 'bad' : ''}`} value={d.audience} {...cv.aria('audience')} onChange={e => setD({ ...d, audience: e.target.value })}>{aud.map(a => <option key={a.k} value={a.k}>{a.l}</option>)}</select><FieldError id="cmp-aud" msg={cv.errors.audience} /></div>
      <div><label>Template</label><select className="in" value={d.template_id ?? ''} onChange={e => setD({ ...d, template_id: e.target.value ? Number(e.target.value) : null })}><option value="">— none —</option>{tpls.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
      <div><label>Send</label><select id="cmp-send" className="in" value={d.send} onChange={e => setD({ ...d, send: e.target.value })}><option value="now">Send now</option><option value="tomorrow">Tomorrow 09:00</option><option value="monday">Monday 09:00</option></select></div>
      <div className="f1"><label>Subject (A/B test – optional second subject)</label><input id="cmp-sa" className={`in ${cv.bad('subject_a') ? 'bad' : ''}`} placeholder="Subject A" value={d.subject_a} {...cv.aria('subject_a')} onChange={e => setD({ ...d, subject_a: e.target.value })} /><FieldError id="cmp-sa" msg={cv.errors.subject_a} /><input id="cmp-sb" className={`in mt ${cv.bad('subject_b') ? 'bad' : ''}`} placeholder="Subject B (optional)" value={d.subject_b} {...cv.aria('subject_b')} onChange={e => setD({ ...d, subject_b: e.target.value })} /><FieldError id="cmp-sb" msg={cv.errors.subject_b} /></div>
      <label className="row f1"><input type="checkbox" checked={d.create_lead} onChange={e => setD({ ...d, create_lead: e.target.checked })} /> Create a lead when a recipient replies</label>
    </div></Modal>
}

/* ───────────── Sequences ───────────── */
function SequencesTab() {
  const { success, error } = useToast()
  const [s, setS] = useState<Sequence[] | null>(null)
  const [enrol, setEnrol] = useState<Sequence | null>(null)
  const [neu, setNeu] = useState(false)
  const load = useCallback(() => corrApi.sequences().then(setS).catch(e => error(errMsg(e, 'Could not load sequences'))), [error])
  useEffect(() => { load() }, [load])
  return <>
    <div className="row mb"><span className="fl" /><button type="button" className="btn s p" onClick={() => setNeu(true)}><Ic n="plus" /> New sequence</button></div>
    {!s ? <div className="empty">Loading…</div> : <div className="list bx">{s.map(x => <div key={x.id} style={{ display: 'block' }}>
      <div className="row"><b className="fl">{x.n}</b><small>{x.enrolled} enrolled</small><button type="button" className="btn s" onClick={() => setEnrol(x)}>Enrol</button></div>
      <div className="row wrap mt" style={{ gap: 4 }}>{x.steps.map((st, i) => <span key={i} className="pill mu">Day {st.day} · {st.kind}: {st.text}</span>)}</div></div>)}</div>}
    {enrol && <Modal title={`Enrol in “${enrol.n}”`} width={440} onClose={() => setEnrol(null)} foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setEnrol(null)}>Cancel</button></>}>
      <p className="mu" style={{ marginTop: 0 }}>Choose who to enrol. Records already in the sequence are skipped.</p>
      <div className="list bx">{[['leads', 'open', 'All open leads'], ['customers', 'all', 'All active customers']].map(([m, sc, l]) => <div key={m} role="button" style={{ cursor: 'pointer' }}
        onClick={() => corrApi.enrol(enrol.id, m, sc).then(r => { setEnrol(null); success(`${r.enrolled} contact(s) enrolled in ${enrol.n}`); load() }).catch(e => error(errMsg(e)))}><span className="fl">{l}</span><Ic n="right" /></div>)}</div></Modal>}
    {neu && <SequenceModal onClose={() => setNeu(false)} onSaved={() => { setNeu(false); success('Sequence created'); load() }} />}
  </>
}

function SequenceModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { error } = useToast()
  const [name, setName] = useState('')
  const [steps, setSteps] = useState([{ day: 0, kind: 'Email', text: '' }])
  // flat value map for validation: name, day_0, text_0, day_1 …
  const flat = (nm: string, st: typeof steps) => Object.assign({ name: nm }, ...st.map((x, i) => ({ [`day_${i}`]: String(x.day), [`text_${i}`]: x.text }))) as Record<string, string>
  const sv = useModalValidation(flat(name, steps), (x): Record<string, FieldSpec> => Object.assign({ name: { label: 'Sequence name', rule: 'text', required: true, min: 2, max: 200 } as FieldSpec },
    ...Object.keys(x).filter(k => k !== 'name').map(k => ({ [k]: k.startsWith('day_') ? { label: 'Day', rule: 'integer', required: true, min: 0, max: 365 } : { label: 'Step description', rule: 'text', required: true, max: 200 } }))),
    undefined, { name: 'seq-name' })
  const setStep = (i: number, p: Partial<typeof steps[number]>) => { const next = steps.map((y, j) => j === i ? { ...y, ...p } : y); setSteps(next); sv.change(flat(name, next), ...Object.keys(p).filter(k => k !== 'kind').map(k => `${k}_${i}`)) }
  const create = () => {
    if (!sv.submit()) return
    corrApi.createSequence({ name: name.trim(), steps }).then(onSaved).catch(e => { if (!sv.server(e)) error(errMsg(e)) })
  }
  return <Modal title="New sequence" width={560} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" onClick={create}>Create</button></>}>
    <div className="fg"><div className="f1"><label>Name</label><input id="seq-name" className={`in ${sv.bad('name') ? 'bad' : ''}`} autoFocus maxLength={200} value={name} {...sv.aria('name')} onChange={e => { setName(e.target.value); sv.change(flat(e.target.value, steps), 'name') }} placeholder="e.g. Quotation follow-up" /><FieldError id="seq-name" msg={sv.errors.name} /></div></div>
    <label className="lb mt">Steps</label>
    {steps.map((s, i) => <div key={i} className="row mb" style={{ gap: 6 }}><span className="mu">Day</span><input id={`day_${i}`} className={`in sm ${sv.bad(`day_${i}`) ? 'bad' : ''}`} type="number" min={0} max={365} style={{ width: 64 }} value={s.day} {...sv.aria(`day_${i}`)} onChange={e => setStep(i, { day: Number(e.target.value) })} />
      <select className="in sm" style={{ width: 90 }} value={s.kind} onChange={e => setStep(i, { kind: e.target.value })}><option>Email</option><option>Task</option></select>
      <input id={`text_${i}`} className={`in sm ${sv.bad(`text_${i}`) ? 'bad' : ''}`} placeholder="What happens" maxLength={200} value={s.text} {...sv.aria(`text_${i}`)} onChange={e => setStep(i, { text: e.target.value })} />
      <button type="button" className="btn g s" disabled={steps.length <= 1} onClick={() => { setSteps(x => x.filter((_, j) => j !== i)); sv.clear() }}><Ic n="x" /></button></div>)}
    {Object.entries(sv.errors).filter(([k]) => k !== 'name').slice(0, 1).map(([k, m]) => <FieldError key={k} id={k} msg={`Step ${Number(k.split('_')[1]) + 1}: ${m}`} />)}
    <button type="button" className="btn s" onClick={() => setSteps(x => [...x, { day: (x[x.length - 1]?.day || 0) + 3, kind: 'Email', text: '' }])}><Ic n="plus" /> Step</button></Modal>
}

/* ───────────── Mailbox setup ───────────── */
function MailboxTab() {
  const { success, error } = useToast()
  const [mb, setMb] = useState<Mailbox | null>(null)
  const [cfg, setCfg] = useState<{ flags: Record<string, boolean>; domain: string } | null>(null)
  const load = useCallback(() => { inboxApi.mailbox().then(setMb).catch(() => undefined); corrApi.mailbox().then(setCfg).catch(e => error(errMsg(e, 'Could not load mailbox settings'))) }, [error])
  useEffect(() => { load() }, [load])
  const dom = cfg?.domain || mb?.domain || 'company.in'
  const flags = cfg?.flags || {}
  const toggle = (k: string, v: boolean, okMsg: string) => corrApi.setFlag(k, v).then(r => { success(r.note || okMsg); load() }).catch(e => error(errMsg(e)))
  const dropbox = useMemo(() => { let h = 0; for (const c of dom) h = (h * 31 + c.charCodeAt(0)) | 0; return `crm-${Math.abs(h).toString(36).slice(0, 6)}@in.bidwise.io` }, [dom])
  return <>
    <div className="note inf mb"><b>How does email work inside Bidwise?</b> You have three ways – use one or combine them. Mail between colleagues never leaves the application. Mail to customers is sent from your own address, and every message is linked to the customer, deal or tender it is about.</div>
    <div className="g g3 mb">
      <Panel title={<><Ic n="mail" /> Built-in mail</>}><div className="mu mb" style={{ minHeight: 64 }}>Every user gets name@{mb?.domain || 'mail.' + dom}. Internal mail stays in the app; external mail is sent through the relay using your domain (SPF / DKIM).</div><Pill s={mb?.smtp_configured ? 'Active' : 'Internal only'} t={mb?.smtp_configured ? 'ok' : 'wa'} /></Panel>
      <Panel title={<><Ic n="link" /> Connect your own mailbox</>}><div className="mu mb" style={{ minHeight: 64 }}>Two-way sync with Gmail / Google Workspace, Microsoft 365 or any IMAP/SMTP server. Only emails with customers and contacts are synced.</div>
        <div className="row wrap" style={{ gap: 6 }}>{[['google', 'Google Workspace'], ['ms', 'Microsoft 365'], ['imap', 'IMAP / SMTP']].map(([k, l]) => <button key={k} type="button" className={`btn s ${flags[k] ? 'p' : ''}`} onClick={() => toggle(k, !flags[k], flags[k] ? `${l} disconnected` : `${l} connected`)}>{flags[k] ? '✓ ' : ''}{l}</button>)}</div></Panel>
      <Panel title={<><Ic n="dl" /> BCC / forward to CRM</>}><div className="mu mb" style={{ minHeight: 64 }}>Copy {dropbox} on any email – it is filed against the right customer and deal automatically.</div>
        <code style={{ fontSize: 12 }}>{dropbox}</code> <button type="button" className="btn s" onClick={() => navigator.clipboard.writeText(dropbox).then(() => success('Address copied')).catch(() => undefined)}>Copy</button></Panel>
    </div>
    <div className="g g2 mb">
      <Panel z title={`Domain authentication · ${dom}`}><div className="list">{[['SPF record', 'spf'], ['DKIM signing', 'dkim'], ['DMARC policy', 'dmarc']].map(([n, k]) => <div key={k}><span className="fl"><b>{n}</b><br /><small>{flags[k] ? 'Verified' : 'Add the DNS TXT record, then verify'}</small></span>{flags[k] ? <Pill s="Verified" t="ok" /> : <button type="button" className="btn s p" onClick={() => toggle(k, true, `${n} verified`)}>Verify</button>}</div>)}</div></Panel>
      <Panel z title="Shared mailboxes"><div className="list">{(mb?.mailboxes || []).length ? (mb?.mailboxes || []).map(x => <div key={x.address}><span className="fl"><b>{x.address}</b><br /><small>{x.label}</small></span></div>) : <div className="mu">No shared mailboxes configured – add them under Settings → Email.</div>}</div></Panel>
    </div>
  </>
}
