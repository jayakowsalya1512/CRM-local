// Data Hub – prototype v17 R.datahub: crumb Automation & control · "Data hub"; tabs Import (Choose file › Map fields › Review & run) · Migration ·
// Duplicates · Mass update · Recycle bin · Exports & backups.  Imports go through each module's own validated /import endpoint; the recycle bin
// is the existing one; exports and backups run as jobs and download through an authorised endpoint.
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av, BarPct, Pill, Tbl } from '@/pages/customers/kit'
import { datahubApi, errMsg, fd, type BinItem, type DupPair, type ImportCols, type Job, type MassFields, type Meta, type Migration } from './datahubApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/settings/appSettings.css'
import '@/pages/settings/admin360.css'
import './datahub.css'

const TABS = ['Import', 'Migration', 'Duplicates', 'Mass update', 'Recycle bin', 'Exports & backups'] as const
type Tab = typeof TABS[number]
const PAGE = 25

/** small CSV parser (quotes, commas, CRLF) – rows of strings */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++ } else inQ = false } else cur += c }
    else if (c === '"') inQ = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.some(x => x.trim())) rows.push(row); row = []; cur = '' }
    else cur += c
  }
  row.push(cur); if (row.some(x => x.trim())) rows.push(row)
  return rows
}
const toCsv = (rows: string[][]) => rows.map(r => r.map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')

export default function DataHubPage() {
  const { error } = useToast()
  const [sp, setSp] = useSearchParams()
  const [meta, setMeta] = useState<Meta | null>(null)
  const tab: Tab = (TABS as readonly string[]).includes(sp.get('tab') || '') ? (sp.get('tab') as Tab) : 'Import'
  const setTab = (t: Tab) => setSp(s => { const n = new URLSearchParams(s); n.set('tab', t); return n })
  useEffect(() => { datahubApi.meta().then(setMeta).catch(e => error(errMsg(e, 'Could not load the Data Hub'))) }, [error])
  if (!meta) return <div className="bwi"><div className="empty">Loading…</div></div>
  return <div className="bwi">
    <div className="pg"><div><div className="crumb">Automation &amp; control</div><h1>Data hub</h1></div></div>
    <div className="panel">
      <div className="tabs mb" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)} onKeyDown={e => { if (e.key === 'Enter') setTab(t) }}>{t}</div>)}</div>
      <div className={`pb ${tab === 'Recycle bin' ? 'z' : ''}`}>
        {tab === 'Import' && <ImportTab meta={meta} />}
        {tab === 'Migration' && <MigrationTab can={meta.can_manage} />}
        {tab === 'Duplicates' && <DuplicatesTab can={meta.can_manage} />}
        {tab === 'Mass update' && <MassTab meta={meta} />}
        {tab === 'Recycle bin' && <BinTab />}
        {tab === 'Exports & backups' && <ExportsTab meta={meta} />}
      </div>
    </div>
  </div>
}

/* ───────────── Import wizard ───────────── */
function ImportTab({ meta }: { meta: Meta }) {
  const { success, error, info } = useToast()
  const [obj, setObj] = useState(meta.import_objects[0]?.k || 'leads')
  const [cols, setCols] = useState<ImportCols | null>(null)
  const [step, setStep] = useState(0)
  const [file, setFile] = useState<{ name: string; header: string[]; rows: string[][] } | null>(null)
  const [map, setMap] = useState<Record<number, string>>({})
  const [dup, setDup] = useState('Skip')
  const [res, setRes] = useState<string>('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { datahubApi.importColumns(obj).then(setCols).catch(e => error(errMsg(e))) ; setFile(null); setStep(0); setRes('') }, [obj, error])
  const onFile = (f: File | null) => {
    if (!f) return
    f.text().then(t => {
      const rows = parseCsv(t); if (!rows.length) return info('The file is empty')
      const header = rows[0].map(h => h.trim()); setFile({ name: f.name, header, rows: rows.slice(1) })
      const m: Record<number, string> = {}
      header.forEach((h, i) => { const hit = (cols?.columns || []).find(c => c.toLowerCase().replace(/[^a-z]/g, '') === h.toLowerCase().replace(/[^a-z]/g, '') || c.toLowerCase().startsWith(h.toLowerCase().slice(0, 6))); if (hit) m[i] = hit })
      setMap(m); setStep(1)
    }).catch(() => error('Could not read the file – use a CSV'))
  }
  const run = async () => {
    if (!file || !cols) return
    const targets = cols.columns
    const missing = cols.required.filter(r => !Object.values(map).includes(r))
    if (missing.length) return info(`Map the required column: ${missing.join(', ')}`)
    setBusy(true)
    try {
      const out = [targets, ...file.rows.map(r => targets.map(t => { const i = Object.entries(map).find(([, v]) => v === t)?.[0]; return i == null ? '' : (r[Number(i)] ?? '') }))]
      let created = 0, dups = 0, errs = 0, detail: Record<string, unknown> = {}
      if (cols.mode === 'values') {
        const r = await datahubApi.importValues('products', out.slice(1).map(x => x[0]).filter(Boolean)); created = r.added; dups = file.rows.length - r.added
      } else {
        const r = await datahubApi.runImport(cols.endpoint, toCsv(out), file.name.replace(/\.[^.]+$/, '') + '.csv')
        created = Number(r.created || 0); dups = Number(r.duplicate_count ?? (r.duplicates?.length ?? 0)); errs = Number(r.error_count ?? (r.errors?.length ?? 0)); detail = { errors: (r.errors || []).slice(0, 50) }
      }
      await datahubApi.logImport({ object: obj, file_name: file.name, rows_total: file.rows.length, created, duplicates: dups, errors: errs, detail }).catch(() => undefined)
      setRes(`Import complete – ${file.rows.length} rows read, ${created} created, ${dups} duplicates skipped, ${errs} error${errs === 1 ? '' : 's'}${errs ? ' (see details below)' : ''}.` + (detail.errors && (detail.errors as any[]).length ? '\n' + (detail.errors as any[]).slice(0, 10).map((e: any) => `Row ${e.row}: ${e.error}`).join('\n') : ''))
      success('Import finished')
    } catch (e) { error(errMsg(e)) } finally { setBusy(false) }
  }
  const steps = ['Choose file', 'Map fields', 'Review & run']
  return <>
    <div className="row mb" style={{ gap: 4 }}>{steps.map((s, i) => <span key={s} className={`pill ${i === step ? 'ac' : i < step ? 'ok' : 'mu'}`}>{i + 1}. {s}</span>)}</div>
    {step === 0 && <div className="g g2"><div><label className="lb">Import into</label><select className="in mb" value={obj} onChange={e => setObj(e.target.value)}>{meta.import_objects.map(o => <option key={o.k} value={o.k}>{o.l}</option>)}</select>
      <label className="drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files?.[0] || null) }}><input type="file" accept=".csv,text/csv" hidden onChange={e => onFile(e.target.files?.[0] || null)} /><Ic n="up" size={22} /><div>Drop a CSV file here, or click to choose<br /><small>Template columns: {(cols?.columns || []).join(' · ')}</small></div></label></div>
      <div className="note inf">Supports CSV (save Excel as CSV). Up to 1,000 rows per run. Rows are validated against the masters by the {cols?.label || 'module'} import – duplicates are reported, never guessed.</div></div>}
    {step === 1 && file && cols && <>
      <Tbl rows={file.header.map((h, i) => ({ i, s: h }))} rowKey={r => r.i} cols={[{ k: 's', t: 'File column' }, { k: 't', t: 'Maps to field', fn: r => <select className="in sm" style={{ width: 220 }} value={map[r.i] || ''} onChange={e => setMap(m => ({ ...m, [r.i]: e.target.value }))}><option value="">— skip —</option>{cols.columns.map(c => <option key={c}>{c}</option>)}</select> },
        { k: 'm', t: 'Match', fn: r => <Pill s={map[r.i] ? 'Auto-matched' : 'Review'} t={map[r.i] ? 'ok' : 'wa'} /> }, { k: 'x', t: 'Sample', fn: r => <small className="mu">{file.rows[0]?.[r.i] || ''}</small> }]} />
      <div className="row mt"><button type="button" className="btn" onClick={() => setStep(0)}>Back</button><button type="button" className="btn p" onClick={() => setStep(2)}>Continue</button><small className="mu">{file.rows.length} rows in {file.name}</small></div></>}
    {step === 2 && file && <>
      <div className="fg" style={{ maxWidth: 620 }}><div><label>If a duplicate is found</label><select className="in" value={dup} onChange={e => setDup(e.target.value)}><option>Skip</option></select><small>Duplicates are reported by the module import and skipped.</small></div>
        <div><label>Assign owner</label><select className="in" disabled><option>From the “Owner email” column (or you)</option></select></div></div>
      {res && <div className="note inf mt" style={{ whiteSpace: 'pre-wrap' }}>{res}</div>}
      <div className="row mt"><button type="button" className="btn" onClick={() => setStep(1)}>Back</button><button type="button" className="btn p" disabled={busy || !meta.can_manage} onClick={run}>{busy ? 'Importing…' : 'Run import'}</button></div></>}
  </>
}

/* ───────────── Migration ───────────── */
function MigrationTab({ can }: { can: boolean }) {
  const { success, error } = useToast()
  const [m, setM] = useState<Migration | null>(null)
  const [src, setSrc] = useState<Migration['sources'][number] | null>(null)
  const load = useCallback(() => datahubApi.migration().then(setM).catch(e => error(errMsg(e, 'Could not load migration options'))), [error])
  useEffect(() => { load() }, [load])
  if (!m) return <div className="empty">Loading…</div>
  return <>
    <div className="mb"><b>Move your data from another CRM or a file.</b> <span className="mu">Pick the source, connect it, and the migration team imports accounts, leads, deals, bids and documents in one go.</span></div>
    <div className="g g3 mb">{m.sources.map(s => <div key={s.n} className="panel srcc"><div className="ph"><Ic n={s.kind === 'file' ? 'upload' : 'plug'} /> {s.n}</div><div className="pb"><div className="mu mb" style={{ minHeight: 32 }}>{s.info || 'API connection · validated before the request is sent'}</div>
      <button type="button" className="btn s p" disabled={!can} onClick={() => setSrc(s)}>{s.kind === 'file' ? 'Request file migration' : 'Connect & request'}</button></div></div>)}</div>
    <h3 className="mb" style={{ fontSize: 13 }}>Migration requests</h3>
    <Tbl rows={m.requests} rowKey={r => r.id} empty="No migration requested yet." cols={[{ k: 'source', t: 'Source' }, { k: 'account', t: 'Account', fn: r => r.account || '—' }, { k: 'objects', t: 'Objects', fn: r => r.objects.map(o => `${o.name}${o.count != null ? ` (${o.count})` : ''}`).join(', ') || '—' },
      { k: 'status', t: 'Status', fn: r => <Pill s={r.status} t={r.status === 'Done' ? 'ok' : r.status === 'Failed' ? 'ba' : r.status === 'Validated' ? 'ok' : 'wa'} /> }, { k: 'by', t: 'Requested by' }, { k: 'd', t: 'Date', fn: r => fd(r.d) }, { k: 'notes', t: 'Notes', wr: true, fn: r => <small>{r.notes}</small> }]} />
    {src && <MigrationModal src={src} onClose={() => setSrc(null)} onSaved={r => { setSrc(null); success(r.status === 'Validated' ? `Connected to ${r.account || src.n} – migration requested` : 'Migration requested – the team will contact you'); load() }} />}
  </>
}

function MigrationModal({ src, onClose, onSaved }: { src: Migration['sources'][number]; onClose: () => void; onSaved: (r: { status: string; account: string }) => void }) {
  const { error } = useToast()
  const [cfg, setCfg] = useState<Record<string, string>>({})
  const [objs, setObjs] = useState<string[]>(['Accounts', 'Contacts', 'Leads', 'Deals'])
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const fields = src.kind === 'file' ? [] : src.n === 'Salesforce' || src.n === 'Microsoft Dynamics 365' || src.n === 'Odoo CRM' ? [['base_url', 'Instance URL'], ['client_id', 'Client ID / user'], ['client_secret', 'Client secret / password']] : [['api_key', 'API key / token'], ['domain', 'Account domain (optional)']]
  return <Modal title={`Migrate from ${src.n}`} width={520} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={() => { setBusy(true); datahubApi.requestMigration({ source: src.n, config: cfg, objects: objs, notes }).then(onSaved).catch(e => error(errMsg(e))).finally(() => setBusy(false)) }}>{busy ? 'Checking…' : 'Request migration'}</button></>}>
    <div className="fg">{fields.map(([k, l]) => <div key={k} className="f1"><label>{l}</label><input className="in" type={k.includes('secret') || k.includes('key') ? 'password' : 'text'} value={cfg[k] || ''} onChange={e => setCfg({ ...cfg, [k]: e.target.value })} autoComplete="off" /></div>)}
      <div className="f1"><label>Objects to move</label><div className="row wrap" style={{ gap: 4 }}>{['Accounts', 'Contacts', 'Leads', 'Deals', 'Tenders', 'Quotes', 'Documents', 'Activities'].map(o => <span key={o} role="button" className={`chip ${objs.includes(o) ? 'on' : ''}`} onClick={() => setObjs(x => x.includes(o) ? x.filter(y => y !== o) : [...x, o])}>{o}</span>)}</div></div>
      <div className="f1"><label>Notes for the migration team</label><textarea className="in" rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder={src.kind === 'file' ? 'Where is the file? Which sheets / tables?' : 'Anything special about your data'} /></div></div>
    <p className="mu mt" style={{ fontSize: 12 }}>Credentials are encrypted at rest and used only for the migration.</p></Modal>
}

/* ───────────── Duplicates ───────────── */
function DuplicatesTab({ can }: { can: boolean }) {
  const { success, error } = useToast()
  const [obj, setObj] = useState('customers')
  const [d, setD] = useState<DupPair[] | null>(null)
  const [merge, setMerge] = useState<DupPair | null>(null)
  const load = useCallback(() => { setD(null); datahubApi.duplicates(obj).then(setD).catch(e => error(errMsg(e, 'Could not check duplicates'))) }, [obj, error])
  useEffect(() => { load() }, [load])
  return <>
    <div className="row mb"><select className="in sm" style={{ width: 160 }} value={obj} onChange={e => setObj(e.target.value)}><option value="customers">Customers</option><option value="leads">Leads</option></select><small className="mu">Matched on normalised name{obj === 'leads' ? ' or e-mail' : ''}. “Not a duplicate” hides a pair for good.</small></div>
    <Tbl rows={d || []} rowKey={r => r.id} empty={d ? 'No duplicates found – your data is clean.' : 'Checking…'} cols={[
      { k: 'a', t: 'Record A', fn: r => <><b>{r.a.name}</b> <small className="mu">#{r.a.id} {r.a.sub}</small></> }, { k: 'bn', t: 'Possible duplicate', fn: r => <>{r.b.name} <small className="mu">#{r.b.id} {r.b.sub}</small></> },
      { k: 'sc', t: 'Match', fn: r => <><BarPct v={r.sc} c="var(--bw-wa)" /> <small className="mu">{r.why}</small></> },
      { k: 'x', t: '', fn: r => can ? <><button type="button" className="btn s p" onClick={() => setMerge(r)}>Merge</button> <button type="button" className="btn s" onClick={() => datahubApi.ignore(obj, r.a.id, r.b.id).then(load).catch(e => error(errMsg(e)))}>Not a duplicate</button></> : null },
    ]} />
    {merge && <Modal title="Merge records" width={460} onClose={() => setMerge(null)} foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setMerge(null)}>Cancel</button></>}>
      <p className="mu" style={{ marginTop: 0 }}>Choose the record to keep. References of the other one are moved across and it goes to the recycle bin.</p>
      <div className="list bx">{[merge.a, merge.b].map(k => <div key={k.id} role="button" style={{ cursor: 'pointer' }} onClick={() => { const drop = k.id === merge.a.id ? merge.b.id : merge.a.id; datahubApi.merge(obj, k.id, drop).then(() => { setMerge(null); success('Records merged – activities and deals combined'); load() }).catch(e => error(errMsg(e))) }}>
        <span className="fl"><b>Keep {k.name}</b><br /><small className="mu">#{k.id} {k.sub}</small></span><Ic n="right" /></div>)}</div></Modal>}
  </>
}

/* ───────────── Mass update ───────────── */
function MassTab({ meta }: { meta: Meta }) {
  const { success, error, info } = useToast()
  const [module, setModule] = useState(meta.mass_modules[0]?.k || 'leads')
  const [f, setF] = useState<MassFields | null>(null)
  const [field, setField] = useState('')
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<'all' | '30d'>('all')
  const [jobs, setJobs] = useState<Job[]>([])
  const [confirm, setConfirm] = useState(false)
  const loadJobs = useCallback(() => datahubApi.jobs('mass_update', 0, 10).then(r => setJobs(r.items)).catch(() => undefined), [])
  useEffect(() => { datahubApi.massFields(module).then(x => { setF(x); setField(x.fields[0]?.k || ''); setValue('') }).catch(e => error(errMsg(e))); loadJobs() }, [module, error, loadJobs])
  const fld = f?.fields.find(x => x.k === field)
  const run = () => { if (!value) return info('Enter the new value'); setConfirm(false); datahubApi.massUpdate({ module, field, value, scope }).then(r => { success(`${r.updated} records updated`); loadJobs() }).catch(e => error(errMsg(e))) }
  return <>
    <div className="fg" style={{ maxWidth: 700 }}>
      <div><label>Module</label><select className="in" value={module} onChange={e => setModule(e.target.value)}>{meta.mass_modules.map(m => <option key={m.k} value={m.k}>{m.l}</option>)}</select></div>
      <div><label>Field to change</label><select className="in" value={field} onChange={e => { setField(e.target.value); setValue('') }}>{(f?.fields || []).map(x => <option key={x.k} value={x.k}>{x.l}</option>)}</select></div>
      <div><label>New value</label>{fld?.options ? <select className="in" value={value} onChange={e => setValue(e.target.value)}><option value="">— choose —</option>{fld.options.map(o => <option key={String(o.v)} value={String(o.v)}>{o.l}</option>)}</select> : <input className="in" value={value} onChange={e => setValue(e.target.value)} />}</div>
      <div><label>Applies to</label><select className="in" value={scope} onChange={e => setScope(e.target.value as 'all' | '30d')}><option value="all">All {f?.counts.all ?? ''} records</option><option value="30d">Records created in last 30 days ({f?.counts['30d'] ?? ''})</option></select></div>
    </div>
    <div className="row mt"><button type="button" className="btn p" disabled={!meta.can_manage || !f} onClick={() => setConfirm(true)}>Update records</button><small>A snapshot is stored so the change can be undone for 7 days.</small></div>
    {jobs.length > 0 && <><h3 className="mt mb" style={{ fontSize: 13 }}>Recent bulk changes</h3><Tbl rows={jobs} rowKey={r => r.id} cols={[{ k: 'n', t: 'Change' }, { k: 'rows', t: 'Records', r: true }, { k: 'by', t: 'By' }, { k: 'd', t: 'When', fn: r => fd(r.d) }, { k: 'st', t: 'Status', fn: r => <Pill s={r.st} t={r.st === 'Done' ? 'ok' : 'mu'} /> },
      { k: 'x', t: '', fn: r => r.can_undo && meta.can_manage ? <button type="button" className="btn s" onClick={() => datahubApi.undo(r.id).then(x => { success(`${x.restored} records restored`); loadJobs() }).catch(e => error(errMsg(e)))}>Undo</button> : null }]} /></>}
    {confirm && <Modal title="Update records" width={420} onClose={() => setConfirm(false)} foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setConfirm(false)}>Cancel</button><button type="button" className="btn p" onClick={run}>Update</button></>}>
      <p style={{ margin: 0 }}>Set <b>{fld?.l}</b> to <b>{fld?.options ? fld.options.find(o => String(o.v) === value)?.l : value}</b> on {scope === 'all' ? `all ${f?.counts.all ?? ''}` : `the ${f?.counts['30d'] ?? ''} recent`} {f?.label.toLowerCase()} records?</p></Modal>}
  </>
}

/* ───────────── Recycle bin (existing module) ───────────── */
function BinTab() {
  const { success, error } = useToast()
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [d, setD] = useState<{ items: BinItem[]; total: number } | null>(null)
  const load = useCallback(() => datahubApi.bin({ search: q || undefined, page, limit: PAGE }).then(setD).catch(e => error(errMsg(e, 'Could not load the recycle bin'))), [q, page, error])
  useEffect(() => { const t = setTimeout(load, 120); return () => clearTimeout(t) }, [load])
  const act = (msg: string, fn: () => Promise<unknown>) => fn().then(() => { success(msg); load() }).catch(e => error(errMsg(e)))
  return <>
    <div className="tbr"><input className="in" placeholder="Search deleted records…" value={q} onChange={e => { setQ(e.target.value); setPage(1) }} aria-label="Search" /><span className="fl" /><small>Deleted records stay here until restored or deleted forever.</small></div>
    <Tbl<BinItem> rows={d?.items || []} rowKey={r => `${r.module_key}:${r.record_id}`} empty={d ? 'The recycle bin is empty.' : 'Loading…'} cols={[
      { k: 'module_label', t: 'Type', fn: r => <Pill s={r.module_label} t="ac" /> }, { k: 'title', t: 'Record', fn: r => <><b>{r.title}</b>{r.subtitle && <small className="mu"> · {r.subtitle}</small>}</> },
      { k: 'deleted_by_name', t: 'Deleted by', fn: r => r.deleted_by_name ? <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Av name={r.deleted_by_name} />{r.deleted_by_name}</span> : '—' }, { k: 'deleted_at', t: 'Deleted', fn: r => fd(r.deleted_at) },
      { k: 'x', t: '', fn: r => <><button type="button" className="btn s p" onClick={() => act('Record restored', () => datahubApi.binRestore(r.module_key, r.record_id))}>Restore</button> <button type="button" className="btn s d" onClick={() => act('Deleted forever', () => datahubApi.binPurge(r.module_key, r.record_id))}>Delete forever</button></> },
    ]} />
    {d && d.total > PAGE && <div className="pgn"><span>Page {page} of {Math.ceil(d.total / PAGE)}</span><span className="fl" /><button type="button" className="btn s" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹ Prev</button><button type="button" className="btn s" disabled={page * PAGE >= d.total} onClick={() => setPage(p => p + 1)}>Next ›</button></div>}
  </>
}

/* ───────────── Exports & backups ───────────── */
function ExportsTab({ meta }: { meta: Meta }) {
  const { success, error } = useToast()
  const [d, setD] = useState<{ items: Job[]; total: number } | null>(null)
  const [obj, setObj] = useState('customers')
  const load = useCallback(() => datahubApi.jobs('export', 0, 50).then(setD).catch(e => error(errMsg(e, 'Could not load exports'))), [error])
  useEffect(() => { load(); const t = setInterval(() => { if (d?.items.some(j => j.st === 'Queued' || j.st === 'Running')) load() }, 4000); return () => clearInterval(t) }, [load, d?.items])
  const dl = (j: Job) => datahubApi.download(j.id).then(r => { const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = j.file || 'export'; a.click(); URL.revokeObjectURL(a.href) }).catch(e => error(errMsg(e)))
  return <>
    <Tbl<Job> rows={d?.items || []} rowKey={r => r.id} empty={d ? 'No exports yet.' : 'Loading…'} cols={[{ k: 'n', t: 'Job' }, { k: 'd', t: 'Date', fn: r => fd(r.d) }, { k: 's', t: 'Size', r: true }, { k: 'rows', t: 'Rows', r: true },
      { k: 'st', t: 'Status', fn: r => <Pill s={r.st} t={r.st === 'Done' ? 'ok' : r.st === 'Failed' ? 'ba' : 'wa'} /> }, { k: 'by', t: 'By' },
      { k: 'x', t: '', fn: r => r.can_download ? <button type="button" className="btn s" onClick={() => dl(r)}><Ic n="dl" /> Download</button> : r.error ? <small className="tbad">{r.error.slice(0, 60)}</small> : null }]} />
    <div className="row mt wrap" style={{ padding: 8 }}>
      <button type="button" className="btn p" disabled={!meta.can_manage} onClick={() => datahubApi.startExport('all').then(() => { success('Full backup started – it appears above when ready'); load() }).catch(e => error(errMsg(e)))}>Start full backup</button>
      <select className="in sm" style={{ width: 170 }} value={obj} onChange={e => setObj(e.target.value)}>{meta.export_objects.map(o => <option key={o.k} value={o.k}>{o.l}</option>)}</select>
      <button type="button" className="btn" disabled={!meta.can_manage} onClick={() => datahubApi.startExport(obj).then(() => { success('Export started'); load() }).catch(e => error(errMsg(e)))}><Ic n="dl" /> Export CSV</button>
      <small>Exports respect your permissions and are kept on the server for download by administrators.</small></div>
  </>
}
