// Prototype v17 composeMail(): "New message" – From, Link to record, To, Cc (+ Bcc), Subject, Template & AI,
// Message, Attach from Document Hub; footer Track opens & clicks, send schedule, Save draft, Discard, Send.
import { useEffect, useMemo, useState } from 'react'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from './Modal'
import { errMsg, fmtSize, inboxApi, type CrmRecord, type Folder, type HubDoc, type Mailbox, type People, type Template } from './inboxApi'

export interface ComposeInit {
  draft_id?: number | null; to?: string; cc?: string; bcc?: string; subject?: string; body?: string; from_mailbox?: string
  link?: { module: string; id: number } | null; attachments?: { key: string; name: string }[]; track?: boolean; reply_to_id?: number | null
}

const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
const SCHEDULES = ['Send now', 'Tomorrow 09:00', 'Monday 09:00']
const addrs = (s: string) => s.split(/[,;]/).map(x => x.trim()).filter(Boolean)
const bareEmail = (s: string) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim()
const badAddr = (s: string) => addrs(s).find(a => !EMAIL.test(bareEmail(a)))

export default function ComposeModal({ init, mailbox, onClose, onDone }: {
  init: ComposeInit; mailbox: Mailbox | null; onClose: () => void; onDone: (r: { status: string; folder: Folder }) => void
}) {
  const { success, error, warning } = useToast()
  const [from, setFrom] = useState(init.from_mailbox || mailbox?.address || '')
  const [link, setLink] = useState(init.link ? `${init.link.module}|${init.link.id}` : '')
  const [to, setTo] = useState(init.to || '')
  const [cc, setCc] = useState(init.cc || '')
  const [bcc, setBcc] = useState(init.bcc || '')
  const [showBcc, setShowBcc] = useState(!!init.bcc)
  const [subject, setSubject] = useState(init.subject || '')
  const [body, setBody] = useState(init.body || '')
  const [tplId, setTplId] = useState('')
  const [att, setAtt] = useState<{ key: string; name: string }[]>(init.attachments || [])
  const [track, setTrack] = useState(init.track ?? true)
  const [schedule, setSchedule] = useState('Send now')
  const [records, setRecords] = useState<CrmRecord[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [docs, setDocs] = useState<HubDoc[] | null>(null)
  const [docsAllowed, setDocsAllowed] = useState(true)
  const [people, setPeople] = useState<People | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [errs, setErrs] = useState<Record<string, string>>({})

  useEffect(() => {
    inboxApi.records().then(L => {
      // keep the pre-linked record available even if it is not in the first 8 per module
      setRecords(L)
    }).catch(() => setRecords([]))
    inboxApi.templates().then(L => { setTemplates(L); setTplId(L[0] ? String(L[0].id) : '') }).catch(() => setTemplates([]))
    inboxApi.documents().then(d => { setDocs(d.items); setDocsAllowed(d.allowed) }).catch(() => setDocs([]))
    inboxApi.people().then(setPeople).catch(() => setPeople(null))
  }, [])
  useEffect(() => { if (!from && mailbox?.address) setFrom(mailbox.address) }, [mailbox, from])

  const linkParts = link ? { link_module: link.split('|')[0], link_record_id: Number(link.split('|')[1]) } : { link_module: null, link_record_id: null }
  const linkMissing = !!init.link && link === `${init.link.module}|${init.link.id}` && !records.some(r => `${r.module}|${r.id}` === link)
  const suggestions = useMemo(() => [...new Set([...(people?.colleagues.map(u => u.email) ?? []), ...(people?.contacts.map(c => c.email) ?? [])])], [people])
  const chips = useMemo(() => {
    const L = (docs ?? []).map(d => ({ key: d.key, name: d.name, size: d.size_kb }))
    for (const a of att) if (!L.some(d => d.key === a.key)) L.unshift({ key: a.key, name: a.name, size: null })
    return L
  }, [docs, att])

  const validate = (sending: boolean) => {
    const e: Record<string, string> = {}
    if (sending && !addrs(to).length) e.to = 'Add a recipient'
    const b1 = badAddr(to), b2 = badAddr(cc), b3 = badAddr(bcc)
    if (b1) e.to = `“${b1}” is not a valid e-mail address`
    if (b2) e.cc = `“${b2}” is not a valid e-mail address`
    if (b3) e.bcc = `“${b3}” is not a valid e-mail address`
    if (!sending && !subject.trim() && !body.trim() && !addrs(to + cc + bcc).length) e.form = 'Nothing to save – the draft is empty'
    setErrs(e)
    if (e.to || e.form) error(e.to || e.form)
    return !Object.keys(e).length
  }

  const submit = async (action: 'send' | 'draft') => {
    if (!validate(action === 'send')) return
    setBusy(action)
    try {
      const r = await inboxApi.compose({
        action, draft_id: init.draft_id ?? null, from_mailbox: from || undefined, to, cc, bcc: showBcc ? bcc : '', subject, body,
        ...linkParts, attachments: att.map(a => ({ key: a.key })), track, schedule: action === 'send' ? schedule : undefined, reply_to_id: init.reply_to_id ?? null,
      })
      if (action === 'draft') { success('Draft saved'); onDone({ status: 'draft', folder: 'Drafts' }); return }
      if (r.status === 'scheduled') success('Email scheduled', schedule)
      else if (r.status === 'internal') success('Delivered inside Azcentrix Connect to your colleague')
      else if (r.status === 'sent') success(track ? 'Email sent through your mailbox – tracking enabled' : 'Email sent through your mailbox')
      else if (r.status === 'not_configured') warning('Saved to Sent – not delivered externally', r.error || 'Mail server (SMTP) is not configured for your company')
      else error('Email could not be delivered externally', r.error || undefined)
      onDone({ status: r.status, folder: r.status === 'scheduled' ? 'Scheduled' : 'Sent' })
    } catch (e) { error(errMsg(e, action === 'draft' ? 'Could not save the draft' : 'Could not send the email')) }
    finally { setBusy(null) }
  }

  const insertTemplate = async () => {
    const t = templates.find(x => String(x.id) === tplId)
    if (!t) return
    setBusy('tpl')
    try { const r = await inboxApi.render(t.id, linkParts.link_module, linkParts.link_record_id); setBody(r.body); if (!subject.trim()) setSubject(r.subject) }
    catch (e) { error(errMsg(e, 'Could not insert the template')) } finally { setBusy(null) }
  }
  const aiDraft = async () => {
    setBusy('ai')
    try { const r = await inboxApi.aiDraft({ ...linkParts, subject, reply_to_id: init.reply_to_id ?? null }); setBody(r.body) }
    catch (e) { error(errMsg(e, 'Could not draft the email')) } finally { setBusy(null) }
  }
  const toggleAtt = (c: { key: string; name: string }) => setAtt(L => L.some(a => a.key === c.key) ? L.filter(a => a.key !== c.key) : [...L, c])

  const mailboxes = mailbox?.mailboxes?.length ? mailbox.mailboxes : from ? [{ address: from, label: from }] : []

  return <Modal title="New message" width={760} onClose={onClose}
    foot={<>
      <label className="row"><input type="checkbox" checked={track} onChange={e => setTrack(e.target.checked)} /> Track opens & clicks</label>
      <select className="in sm" style={{ width: 150 }} value={schedule} onChange={e => setSchedule(e.target.value)} aria-label="Send schedule">
        {SCHEDULES.map(s => <option key={s}>{s}</option>)}
      </select>
      <span className="fl" />
      <button type="button" className="btn" disabled={!!busy} onClick={() => submit('draft')}>Save draft</button>
      <button type="button" className="btn" disabled={busy === 'send' || busy === 'draft'} onClick={onClose}>Discard</button>
      <button type="button" className="btn p" disabled={!!busy} onClick={() => submit('send')}><Ic n="send" /> {busy === 'send' ? 'Sending…' : 'Send'}</button>
    </>}>
    <datalist id="bwi-mpl">{suggestions.map(x => <option key={x} value={x} />)}</datalist>
    <div className="fg">
      <div><label htmlFor="bwi-mfr">From</label>
        <select id="bwi-mfr" className="in" value={from} onChange={e => setFrom(e.target.value)}>
          {mailboxes.map(m => <option key={m.address} value={m.address}>{m.label}</option>)}
        </select></div>
      <div><label htmlFor="bwi-mlr">Link to record</label>
        <select id="bwi-mlr" className="in" value={link} onChange={e => setLink(e.target.value)}>
          <option value="">None</option>
          {linkMissing && <option value={link}>Linked record</option>}
          {records.map(r => <option key={`${r.module}|${r.id}`} value={`${r.module}|${r.id}`}>{r.label}</option>)}
        </select></div>
      <div className="f1"><label htmlFor="bwi-mt">To <small className="mu">(colleagues stay inside the app · external goes via your mailbox)</small></label>
        <input id="bwi-mt" className={`in ${errs.to ? 'bad' : ''}`} list="bwi-mpl" value={to} onChange={e => { setTo(e.target.value); setErrs(x => ({ ...x, to: '' })) }} placeholder="name@company.in, customer@example.in" autoFocus={!to} />
        {errs.to && <div className="err">{errs.to}</div>}</div>
      <div className="f1"><label htmlFor="bwi-mcc">Cc {!showBcc && <a className="mu" onClick={() => setShowBcc(true)}>Bcc</a>}</label>
        <input id="bwi-mcc" className={`in ${errs.cc ? 'bad' : ''}`} list="bwi-mpl" value={cc} onChange={e => { setCc(e.target.value); setErrs(x => ({ ...x, cc: '' })) }} />
        {errs.cc && <div className="err">{errs.cc}</div>}</div>
      {showBcc && <div className="f1"><label htmlFor="bwi-mbcc">Bcc</label>
        <input id="bwi-mbcc" className={`in ${errs.bcc ? 'bad' : ''}`} list="bwi-mpl" value={bcc} onChange={e => { setBcc(e.target.value); setErrs(x => ({ ...x, bcc: '' })) }} autoFocus />
        {errs.bcc && <div className="err">{errs.bcc}</div>}</div>}
      <div className="f1"><label htmlFor="bwi-ms">Subject</label><input id="bwi-ms" className="in" value={subject} onChange={e => setSubject(e.target.value)} maxLength={500} /></div>
      <div className="f1"><label htmlFor="bwi-mtpl">Template &amp; AI</label>
        <div className="row">
          <select id="bwi-mtpl" className="in" value={tplId} onChange={e => setTplId(e.target.value)}>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button type="button" className="btn" disabled={!tplId || busy === 'tpl'} onClick={insertTemplate}>Insert</button>
          <button type="button" className="btn" disabled={busy === 'ai'} onClick={aiDraft}><Ic n="spark" /> {busy === 'ai' ? 'Drafting…' : 'AI draft'}</button>
        </div></div>
      <div className="f1"><label htmlFor="bwi-mb">Message</label><textarea id="bwi-mb" className="in" rows={8} value={body} onChange={e => setBody(e.target.value)} autoFocus={!!to} /></div>
      <div className="f1"><label>Attach from Document Hub</label>
        <div className="row wrap attl">
          {docs == null ? <small className="mu">Loading…</small>
            : chips.length ? chips.map(c => {
              const on = att.some(a => a.key === c.key)
              return <button key={c.key} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} title={`${c.name}${c.size ? ` · ${fmtSize(c.size)}` : ''}`} onClick={() => toggleAtt(c)}>
                <Ic n="doc" /> {c.name.slice(0, 26)}</button>
            }) : <small className="mu">{docsAllowed ? 'No documents in the Document Hub yet' : 'You don’t have access to the Document Hub'}</small>}
        </div></div>
    </div>
  </Modal>
}
