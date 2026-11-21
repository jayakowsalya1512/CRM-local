import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Download, Upload } from 'lucide-react'
import {
  platformApi,
  type ExportJobRow, type ExportOptions, type MigrationOptions, type MigrationRow, type TenantOverview,
} from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Field, Kv, Note, Panel, Pill, Strip, Switch, Table, cap, downloadBlob, errMsg, fd, fdt, inputCls, inputStyle, mb, num, type Tone } from '@/components/platform/bw'

// Prototype tenantDx(): Export / Migrate panels with Export history and Migrations.
// ExportWizard (exWiz) and MigrationWizard (mgHTML) are shared with the platform Data Export & Migration page.

type TenantChoice = { id: number; name: string }
export const sizeText = (bytes: number | null | undefined) => bytes == null ? '—' : mb(bytes / 1024 ** 2)
export const bar = (v: number) => <span className="inline-flex items-center gap-1.5"><span className="inline-block h-1.5 w-[60px] overflow-hidden rounded-md" style={{ background: C.ln2 }}><i className="block h-full" style={{ width: `${v}%`, background: C.ac }} /></span>{v}%</span>
export const TARGET_LABELS: Record<string, string> = { customers: 'accounts', products: 'products', contacts: 'contacts', leads: 'leads', deals: 'deals', quotes: 'quotes', activities: 'activities' }
export const importedText = (res: NonNullable<MigrationRow['result']>) => {
  const made = Object.entries(res.created ?? {}).filter(([, ids]) => ids.length).map(([t, ids]) => `${num(ids.length)} ${TARGET_LABELS[t] ?? t}`)
  const updated = Object.values(res.updated ?? {}).reduce((a, n) => a + n, 0)
  return `${made.length ? made.join(', ') : 'Nothing'} imported, ${num(updated)} updated, ${num(res.skipped ?? 0)} duplicates skipped, ${num(res.errors ?? 0)} rows with errors.`
}
export const migTone = (s: string): Tone => s === 'Completed' ? 'ok' : s === 'Running' || s === 'Fetching' || s === 'Pausing' ? 'inf' : s === 'Failed' || s === 'Interrupted' ? 'ba' : s === 'Rolled back' ? 'mu' : 'wa'
const ACTIVE = ['Running', 'Pausing', 'Fetching']

// ─── Export wizard (prototype exWiz) ────────────────────────────────────────

export function ExportWizard({ tenantId, tenants, onClose, onStarted }: { tenantId: number; tenants: TenantChoice[]; onClose: () => void; onStarted: (tenantId: number) => void }) {
  const { success, error: showError } = useToast()
  const [opts, setOpts] = useState<ExportOptions | null>(null)
  const [e, setE] = useState({ t: tenantId, c: new Set<string>(), fmt: '', pii: 'Include', enc: '', del: '', days: 7, key: '' })
  const [est, setEst] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    platformApi.exportOptions().then(({ data }) => {
      setOpts(data)
      const first = (list: string[]) => list.find(o => !data.unavailable?.[o]) ?? list[0]
      setE(x => ({ ...x, c: new Set(data.components.slice(0, 5).map(c => c.key)), fmt: first(data.formats), enc: first(data.encryption), del: first(data.delivery) }))
    }).catch(err => showError(errMsg(err, 'Unable to load export options')))
  }, [showError])
  useEffect(() => {
    if (!e.c.size) { setEst(0); return }
    setEst(null)
    platformApi.exportEstimate(e.t, [...e.c]).then(({ data }) => setEst(data.total_bytes)).catch(() => setEst(null))
  }, [e.t, e.c])
  const pgp = e.enc.includes('PGP')
  const start = async () => {
    if (!e.c.size) return showError('Select at least one component')
    if (pgp && !e.key.trim()) return showError('Paste the customer’s PGP public key')
    setBusy(true)
    try {
      await platformApi.startExport(e.t, { components: [...e.c], format: e.fmt, pii: e.pii, encryption: e.enc, delivery: e.del, link_days: e.days, ...(pgp ? { pgp_key: e.key } : {}) })
      success(`Export started for ${tenants.find(t => t.id === e.t)?.name ?? 'tenant'}`)
      onStarted(e.t)
    } catch (err) { showError(errMsg(err, 'Unable to start the export')) } finally { setBusy(false) }
  }
  const unavailable = opts?.unavailable ?? {}
  const select = (label: string, key: 'fmt' | 'pii' | 'enc' | 'del', options: string[]) => <Field label={label}>
    <select className={inputCls} style={inputStyle} value={e[key]} onChange={ev => setE({ ...e, [key]: ev.target.value })}>
      {options.map(o => <option key={o} value={o} disabled={!!unavailable[o]} title={unavailable[o]}>{o}{unavailable[o] ? ' – unavailable' : ''}</option>)}
    </select></Field>
  const notes = opts ? [...opts.formats, ...opts.encryption, ...opts.delivery].filter(o => unavailable[o]) : []
  return <BwModal title={<span className="inline-flex items-center gap-1.5"><Download size={14} /> Export complete tenant data</span>} width={720} onClose={onClose}
    foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p onClick={() => void start()} disabled={busy || !opts}>{busy ? 'Starting…' : 'Start export'}</Btn></>}>
    {!opts ? <Empty>Loading…</Empty> : <>
      <div className="grid gap-x-3 gap-y-[9px] sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Tenant"><select className={inputCls} style={inputStyle} value={e.t} onChange={ev => setE({ ...e, t: Number(ev.target.value) })}>{tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field></div>
        <div className="sm:col-span-2"><span className="mb-0.5 block text-xs" style={{ color: C.mu }}>Contents</span>
          <div className="rounded-md border" style={{ borderColor: C.ln }}>{opts.components.map(c => <label key={c.key} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}>
            <input type="checkbox" checked={e.c.has(c.key)} onChange={ev => { const n = new Set(e.c); if (ev.target.checked) n.add(c.key); else n.delete(c.key); setE({ ...e, c: n }) }} /><span className="flex-1">{c.label}</span></label>)}</div></div>
        {select('Format', 'fmt', opts.formats)}
        {select('Personal data', 'pii', opts.pii)}
        {select('Encryption', 'enc', opts.encryption)}
        {select('Delivery', 'del', opts.delivery)}
        <Field label="Link valid for (days)"><input type="number" min={1} max={30} className={inputCls} style={inputStyle} value={e.days} onChange={ev => setE({ ...e, days: Number(ev.target.value) || 1 })} /></Field>
        {pgp && <div className="sm:col-span-2"><Field label="Customer PGP public key"><textarea className="w-full rounded-md border px-2 py-1 font-mono text-[11px]" rows={4} style={inputStyle} placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----" value={e.key} onChange={ev => setE({ ...e, key: ev.target.value })} /></Field></div>}
      </div>
      <Note info className="mt-2.5">Estimated size <b>{est == null ? '…' : sizeText(est)}</b> · includes a manifest with row counts and SHA-256 checksums · passwords and tokens are never exported · the export is recorded in the audit trail.
        {e.del === 'Encrypted email' ? ' The signed download link is e-mailed to the tenant admin.' : ''}{pgp ? ' Only the holder of the matching private key can open the package.' : ''}</Note>
      {notes.length > 0 && <div className="mt-1.5 text-[11px]" style={{ color: C.mu }}>{notes.map(o => <div key={o}>{o}: {unavailable[o]}</div>)}</div>}
    </>}
  </BwModal>
}

// ─── Migration wizard (prototype mgHTML) ────────────────────────────────────

const STEPS = ['Source', 'Objects & fields', 'Rules', 'Dry run', 'Cut-over']
const startStep = (m: MigrationRow | null) => !m || m.status === 'Fetching' ? 0 : [...ACTIVE, 'Completed', 'Failed', 'Rolled back', 'Paused', 'Interrupted'].includes(m.status) || m.scheduled_at ? 4 : m.dry_run ? 3 : 1

export function MigrationWizard({ tenantId, tenants, existing, onClose, onChanged }: { tenantId: number; tenants: TenantChoice[]; existing: MigrationRow | null; onClose: () => void; onChanged: () => void }) {
  const { success, error: showError } = useToast()
  const [opts, setOpts] = useState<MigrationOptions | null>(null)
  const [target, setTarget] = useState(tenantId)
  const [m, setM] = useState<MigrationRow | null>(existing)
  const [step, setStep] = useState(() => startStep(existing))
  const [src, setSrc] = useState(existing?.source ?? '')
  const [files, setFiles] = useState<File[]>([])
  const [objects, setObjects] = useState<Set<string>>(new Set())
  const [when, setWhen] = useState('')
  const [busy, setBusy] = useState(false)
  const [focus, setFocus] = useState<string | null>(existing?.datasets?.[0]?.key ?? null)
  const loadOpts = useCallback(() => platformApi.migrationOptions().then(({ data }) => { setOpts(data); setSrc(s => s || data.sources[0]) }).catch(() => undefined), [])
  useEffect(() => { void loadOpts() }, [loadOpts])
  const tenantName = tenants.find(t => t.id === target)?.name ?? ''
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn() } catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy(false) } }
  const isFile = !opts || opts.file_sources.includes(src)
  const conn = opts && !isFile ? opts.connectors[src] : null
  useEffect(() => { if (conn && !m) setObjects(new Set(conn.objects.filter(o => !o.error).map(o => o.name))) }, [conn, m])

  // Poll while the source is pulled or the import runs.
  useEffect(() => {
    if (!m || !ACTIVE.includes(m.status)) return
    const t = window.setInterval(() => {
      platformApi.getMigration(target, m.id).then(({ data }) => {
        setM(data)
        if (!ACTIVE.includes(data.status)) { onChanged(); if (m.status === 'Fetching' && data.status === 'Draft') { setFocus(data.datasets[0]?.key ?? null); setStep(1) } }
      }).catch(() => undefined)
    }, 1500)
    return () => window.clearInterval(t)
  }, [m, target, onChanged])

  const upload = () => run(async () => {
    if (!files.length) return showError(src.startsWith('SQL') ? 'Choose a .sql dump file' : 'Choose CSV or Excel files')
    const { data } = await platformApi.createMigration(target, src, files)
    setM(data); setFocus(data.datasets[0]?.key ?? null); onChanged()
    success('Source scanned – nothing is changed in the source')
  })
  const testConnection = () => run(async () => {
    const { data } = await platformApi.testConnector(src)
    await loadOpts()
    if (data.status === 'connected') success(data.detail || 'Connection verified – read-only access'); else showError(data.detail || 'Connection failed')
  })
  const pull = () => run(async () => {
    if (!objects.size) return showError('Select at least one object')
    const { data } = await platformApi.createConnectorMigration(target, src, [...objects])
    setM(data); onChanged()
  })
  const save = (patch: { mapping?: MigrationRow['mapping']; rules?: MigrationRow['rules'] }) => run(async () => { if (m) setM((await platformApi.updateMigration(target, m.id, patch)).data) })
  const next = async () => {
    if (step === 0 && !m && !isFile) return pull()
    if (!m) return
    if (step === 1) await save({ mapping: m.mapping })
    if (step === 2) await save({ rules: m.rules })
    setStep(s => s + 1)
  }
  const setMap = (key: string, patch: Partial<MigrationRow['mapping'][string]>) => m && setM({ ...m, mapping: { ...m.mapping, [key]: { ...m.mapping[key], ...patch } } })
  const act = (fn: () => Promise<{ data: MigrationRow }>, done?: string) => run(async () => { setM((await fn()).data); onChanged(); if (done) success(done) })

  let body: ReactNode = <Empty>Loading…</Empty>
  if (opts && step === 0) {
    const isSql = src.startsWith('SQL')
    const pulling = m?.status === 'Fetching' && m.pull
    body = <>
      <div className="mb-2 flex flex-wrap gap-1.5">{opts.sources.map(s => <button key={s} type="button" disabled={!!m} onClick={() => { setSrc(s); setFiles([]) }} className="rounded-[9px] border px-2 text-xs leading-[20px] disabled:opacity-60" style={s === src ? { background: C.ac, borderColor: C.ac, color: '#fff' } : { borderColor: C.ln, color: C.tx }}>{s}</button>)}</div>
      <div className="grid gap-2 md:grid-cols-2">
        {isFile ? <Panel title={`Connect ${src}`}><div className="space-y-2.5">
          <Field label="Connection method"><input className={inputCls} style={inputStyle} disabled value={isSql ? 'SQL dump file (restored into a staging database)' : 'File upload (.csv, .xlsx)'} /></Field>
          <Field label="Upload"><input type="file" multiple={!isSql} accept={isSql ? '.sql' : '.csv,.txt,.xlsx,.xlsm'} disabled={!!m} className={`${inputCls} !h-auto py-1`} style={inputStyle} onChange={ev => setFiles([...(ev.target.files ?? [])])} /></Field>
          <div className="flex items-center gap-2"><Btn p onClick={() => void upload()} disabled={busy || !!m}>{m ? 'Connected ✓' : busy ? 'Scanning…' : 'Test connection'}</Btn><small style={{ color: C.mu }}>Read-only access. Nothing is changed in the source.</small></div>
        </div></Panel> : <Panel title={`Connect ${src}`}><div className="space-y-2.5">
          <Field label="Connection method"><input className={inputCls} style={inputStyle} disabled value={conn?.method ?? ''} /></Field>
          <Field label="Credential"><input className={inputCls} style={inputStyle} disabled value={conn?.status === 'connected' ? `Connected – ${conn.account ?? src}` : conn?.status === 'failed' ? 'Connection failed' : 'Not configured'} /></Field>
          {conn?.status !== 'connected' && <Note>{conn?.status === 'failed' ? conn.detail : `Add the ${src} credentials under Source connectors first.`}</Note>}
          <div className="flex items-center gap-2"><Btn p onClick={() => void testConnection()} disabled={busy || !!m || conn?.status === 'not_configured'}>{m ? 'Connected ✓' : busy ? 'Testing…' : 'Test connection'}</Btn><small style={{ color: C.mu }}>Read-only access. Nothing is changed in {src}.</small></div>
        </div></Panel>}
        <Panel title={`Detected in ${src}`}>{m && m.status !== 'Fetching' && m.status !== 'Failed' ? <Kv rows={m.datasets.map(d => [d.name, `${num(d.rows)} records`])} />
          : pulling ? <div><div className="mb-1">Pulling {Object.keys(m.pull!.done).length} of {m.pull!.objects.length} objects…</div>{m.pull!.objects.map(o => <div key={o} className="text-xs">{o}: {m.pull!.done[o] != null ? `${num(m.pull!.done[o])} records` : '…'}</div>)}</div>
          : m?.status === 'Failed' ? <Note>{m.error}</Note>
          : conn?.status === 'connected' ? <div>{conn.objects.map(o => <label key={o.name} className="flex items-center gap-2 py-[3px]" title={o.error}>
            <input type="checkbox" disabled={!!o.error} checked={objects.has(o.name)} onChange={ev => { const n = new Set(objects); if (ev.target.checked) n.add(o.name); else n.delete(o.name); setObjects(n) }} />
            <span className="flex-1">{o.name}</span><small style={{ color: o.error ? C.wa : C.mu }}>{o.error ? 'not accessible' : o.count == null ? 'counted while pulling' : `${num(o.count)} records`}</small></label>)}</div>
          : <span style={{ color: C.mu }}>Connect to scan objects and record counts.</span>}</Panel>
      </div>
    </>
  } else if (opts && m && step === 1) {
    const focusDs = m.datasets.find(d => d.key === focus) ?? m.datasets[0]
    const conf = focusDs ? m.mapping[focusDs.key] : null
    const targetFields = conf?.target ? opts.targets[conf.target].fields : []
    body = <>
      <Table head={['', 'Source object', '→', 'Target in Azcentrix', { t: 'Records', r: true }, 'Fields']} minWidth={720}>{m.datasets.map(d => {
        const c = m.mapping[d.key]
        const req = c?.target ? opts.targets[c.target].fields.filter(f => f.required && !Object.values(c.fields).includes(f.key)).length : 0
        const unmapped = d.columns.length - Object.keys(c?.fields ?? {}).length
        return <tr key={d.key} className="cursor-pointer" onClick={() => setFocus(d.key)} style={d.key === focusDs?.key ? { background: `color-mix(in srgb, ${C.ac} 8%, var(--bw-sf))` } : undefined}>
          <td onClick={ev => ev.stopPropagation()}><input type="checkbox" checked={!!c?.enabled} onChange={ev => setMap(d.key, { enabled: ev.target.checked })} /></td>
          <td>{d.name}</td><td>→</td>
          <td onClick={ev => ev.stopPropagation()}><select className={`${inputCls} !w-[180px]`} style={inputStyle} value={c?.target ?? ''} onChange={ev => { const t = ev.target.value || null; setMap(d.key, { target: t, enabled: !!t, fields: t ? (d.target === t ? d.suggested : {}) : {} }) }}><option value="">— skip —</option>{Object.entries(opts.targets).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></td>
          <td className="text-right">{num(d.rows)}</td>
          <td>{Object.keys(c?.fields ?? {}).length} mapped · <span style={{ color: req ? C.ba : C.wa }}>{req ? `${req} required missing` : `${unmapped} need attention`}</span></td>
        </tr>
      })}</Table>
      {focusDs && conf?.target && <><h3 className="mb-1.5 mt-3 font-semibold">Field mapping · {focusDs.name}</h3>
        <Table head={['Source field', 'Target field', 'Match']} minWidth={560}>{focusDs.columns.map(col => {
          const mapped = conf.fields[col]
          return <tr key={col}><td>{col}</td>
            <td><select className={`${inputCls} !w-[210px]`} style={inputStyle} value={mapped ?? ''} onChange={ev => { const fields = { ...conf.fields }; if (ev.target.value) fields[col] = ev.target.value; else delete fields[col]; setMap(focusDs.key, { fields }) }}>
              <option value="">— skip —</option>{targetFields.map(f => <option key={f.key} value={f.key} disabled={Object.entries(conf.fields).some(([k, v]) => v === f.key && k !== col)}>{f.label}{f.required ? ' *' : ''}</option>)}</select></td>
            <td>{!mapped ? <Pill t="mu">Skipped</Pill> : focusDs.suggested[col] === mapped ? <Pill t="ok">Auto-matched</Pill> : <Pill t="wa">Review</Pill>}</td></tr>
        })}</Table></>}
    </>
  } else if (opts && m && step === 2) {
    const r = m.rules
    const setR = (patch: Partial<MigrationRow['rules']>) => setM({ ...m, rules: { ...r, ...patch } })
    body = <div className="max-w-[700px]">
      <div className="grid gap-x-3 sm:grid-cols-2">
        <Field label="If a duplicate exists"><select className={inputCls} style={inputStyle} value={r.dup} onChange={ev => setR({ dup: ev.target.value })}>{opts.duplicates.map(o => <option key={o}>{o}</option>)}</select></Field>
        <Field label="Owner mapping"><select className={inputCls} style={inputStyle} value={r.own} onChange={ev => setR({ own: ev.target.value })}>{opts.owners.map(o => <option key={o}>{o}</option>)}</select></Field>
      </div>
      <div className="mt-2.5 rounded-md border" style={{ borderColor: C.ln }}>{([['ids', 'Keep original record IDs as external IDs'], ['dates', 'Preserve created dates'], ['notes', 'Migrate notes']] as const).map(([k, l]) => <div key={k} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}><Switch on={!!r[k]} onChange={v => setR({ [k]: v })} label={l} /><span className="flex-1">{l}</span></div>)}</div>
      <small className="mt-1.5 block" style={{ color: C.mu }}>Documents / attachments, stage history and delta sync aren’t migrated: records are imported once, at cut-over. Deal stages are kept in the deal’s notes.</small>
    </div>
  } else if (opts && m && step === 3) {
    const d = m.dry_run
    body = d ? <>
      <Note info className="mb-2">Dry run finished – no data was written. Fix or accept the warnings, then continue.</Note>
      <Strip items={[{ l: 'Records scanned', v: num(d.totals.tot) }, { l: 'Ready to import', v: <span style={{ color: C.ok }}>{num(d.totals.ok)}</span> }, { l: 'Warnings', v: <span style={{ color: C.wa }}>{d.totals.w}</span> }, { l: 'Errors', v: <span style={{ color: C.ba }}>{d.totals.e}</span> }, { l: 'Duplicates', v: d.totals.d }]
        .map(x => ({ ...x, kpi: 'transfer.dry_run', kpiQuery: { tenant_id: target, q: `MIG-${m.id}` } }))} />
      <Table head={['Object', { t: 'Records', r: true }, { t: 'Warnings', r: true }, { t: 'Errors', r: true }, 'Top issue']} minWidth={600}>{d.objects.map(o => <tr key={o.dataset}><td>{o.dataset} → {o.target}</td><td className="text-right">{num(o.records)}</td><td className="text-right">{o.warnings}</td><td className="text-right">{o.errors}</td><td>{o.top_issue}</td></tr>)}</Table>
      <div className="mt-2 flex gap-2"><Btn onClick={() => void run(async () => downloadBlob((await platformApi.migrationErrors(target, m.id)).data as Blob, `MIG-${m.id}-issues.csv`))}><Download size={13} /> Error report</Btn><Btn onClick={() => void run(async () => setM((await platformApi.migrationDryRun(target, m.id)).data))}>Run again</Btn></div>
    </> : <Empty>Run a dry run to validate mappings and see warnings before any data is written.<br /><br /><Btn p disabled={busy} onClick={() => void run(async () => setM((await platformApi.migrationDryRun(target, m.id)).data))}>{busy ? 'Scanning and validating records…' : 'Start dry run'}</Btn></Empty>
  } else if (opts && m && step === 4) {
    const res = m.result
    const progress = <div className="h-1.5 overflow-hidden rounded-md" style={{ background: C.ln2 }}><i className="block h-full" style={{ width: `${m.progress}%`, background: C.ac }} /></div>
    const rollback = (m.rollback_until || m.can_rollback) && <div className="mt-2 flex items-center gap-2"><Btn d disabled={busy} onClick={() => void act(() => platformApi.rollbackMigration(target, m.id), 'Migration rolled back')}>Roll back</Btn>{m.rollback_until && <small style={{ color: C.mu }}>Available until {fd(m.rollback_until)}</small>}</div>
    body = <div className="grid gap-2 md:grid-cols-2">
      <Panel title="Cut-over plan" flush><div>{[`Freeze changes in ${m.source} (read-only)`, isFile ? 'Final export from the source and re-upload if it changed' : `Pull ${m.source} again if it changed after the dry run`, 'Verify record counts and totals', 'Switch users to Azcentrix', `Keep ${m.source} read-only for 30 days`].map((s, i) => <div key={s} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}><b>{i + 1}</b><span className="flex-1">{s}</span></div>)}</div></Panel>
      <Panel title="Run migration">{m.status === 'Running' || m.status === 'Pausing' ? <>{progress}<p className="mt-2">{m.status === 'Pausing' ? 'Pausing at the next checkpoint…' : `Migrating… ${m.progress}%`}</p>{m.status === 'Running' && <Btn s disabled={busy} onClick={() => void act(() => platformApi.pauseMigration(target, m.id), 'Pausing at the next checkpoint')}>Pause</Btn>}</>
        : m.status === 'Completed' ? <><p><b style={{ color: C.ok }}>Migration complete.</b> {res ? importedText(res) : ''}</p>{rollback}</>
        : m.status === 'Rolled back' ? <p>This migration was rolled back – the imported records were removed.</p>
        : ['Paused', 'Interrupted', 'Failed'].includes(m.status) ? <>{progress}<Note className="mt-2">{m.status === 'Paused' ? `Paused at row ${num(m.checkpoint ?? 0)}.` : m.error || 'The migration failed.'}</Note>
          {m.dry_run && <div className="mt-2 flex gap-2"><Btn p disabled={busy} onClick={() => void act(() => platformApi.resumeMigration(target, m.id), 'Migration resumed')}>{m.checkpoint ? `Resume from row ${num(m.checkpoint + 1)}` : 'Retry'}</Btn></div>}{rollback}</>
        : <><p className="mb-2">Import into <b>{tenantName}</b>. You can roll back within 7 days.</p>
          {m.scheduled_at ? <><Note info>Cut-over scheduled for <b>{fdt(m.scheduled_at)}</b> – it starts automatically.</Note><div className="mt-2 flex gap-2"><Btn p disabled={busy} onClick={() => void act(() => platformApi.runMigration(target, m.id))}>Start now</Btn><Btn disabled={busy} onClick={() => void act(() => platformApi.scheduleMigration(target, m.id, null), 'Schedule cancelled')}>Cancel schedule</Btn></div></>
            : <><Btn p disabled={busy} onClick={() => void act(() => platformApi.runMigration(target, m.id))}>Start migration</Btn>
              <div className="mt-2.5 flex flex-wrap items-end gap-2"><Field label="Or schedule the cut-over"><input type="datetime-local" className={`${inputCls} !w-[210px]`} style={inputStyle} value={when} onChange={ev => setWhen(ev.target.value)} /></Field>
                <Btn disabled={busy || !when} onClick={() => void act(() => platformApi.scheduleMigration(target, m.id, when), 'Cut-over scheduled')}>Schedule cut-over</Btn></div></>}</>}</Panel>
    </div>
  }
  const canContinue = step === 0 ? (m ? !ACTIVE.includes(m.status) && m.status !== 'Failed' : !isFile && conn?.status === 'connected' && objects.size > 0) : step === 3 ? m?.status === 'Dry run passed' : step === 1 ? !!m && Object.values(m.mapping).some(c => c.enabled && c.target) : true
  return <BwModal title={<span className="inline-flex items-center gap-1.5"><Upload size={14} /> Migrate from another CRM</span>} width={900} onClose={onClose}>
    <div className="mb-2 flex flex-wrap gap-1">{STEPS.map((s, i) => <Pill key={s} t={i === step ? 'ac' : i < step ? 'ok' : 'mu'}>{i + 1}. {s}</Pill>)}</div>
    <div className="mb-2"><Field label="Target tenant"><select className={`${inputCls} !w-[300px]`} style={inputStyle} value={target} disabled={!!m} onChange={ev => setTarget(Number(ev.target.value))}>{tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field></div>
    {body}
    <div className="mt-3 flex items-center"><Btn onClick={() => setStep(s => s - 1)} disabled={!step || busy}>Back</Btn><span className="flex-1" />{step < 4 && <Btn p onClick={() => void next()} disabled={!canContinue || busy}>{step === 0 && !m && !isFile ? (busy ? 'Starting…' : 'Pull and continue') : 'Continue'}</Btn>}</div>
  </BwModal>
}

// ─── Tab ────────────────────────────────────────────────────────────────────

export const exportPill = (j: ExportJobRow) => j.status === 'ready' ? <Pill t="ok">Ready</Pill> : j.status === 'failed' ? <Pill t="ba" title={j.error ?? ''}>{j.error?.startsWith('Interrupted') ? 'Interrupted' : 'Failed'}</Pill> : j.status === 'expired' ? <Pill t="mu" title="The download window passed and the file was removed">Expired</Pill> : <Pill t="inf">{cap(j.status)}</Pill>

export default function TenantDataMigrationTab({ id, canManage }: { id: number; ov: TenantOverview; canManage: boolean }) {
  const { error: showError } = useToast()
  const [tenants, setTenants] = useState<TenantChoice[]>([])
  const [exports, setExports] = useState<ExportJobRow[] | null>(null)
  const [migs, setMigs] = useState<MigrationRow[] | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [migOpen, setMigOpen] = useState<{ row: MigrationRow | null } | null>(null)
  const load = useCallback(async () => {
    const [e, mg] = await Promise.allSettled([platformApi.listExports(id), platformApi.listMigrations(id)])
    if (e.status === 'fulfilled') setExports(e.value.data)
    if (mg.status === 'fulfilled') setMigs(mg.value.data)
  }, [id])
  useEffect(() => { void load(); platformApi.tenantHierarchy().then(({ data }) => setTenants(data.tenants)).catch(() => undefined) }, [load])
  const active = useMemo(() => (exports ?? []).some(j => j.status === 'queued' || j.status === 'running') || (migs ?? []).some(m => ACTIVE.includes(m.status)), [exports, migs])
  useEffect(() => { if (!active) return; const t = window.setInterval(() => void load(), 2500); return () => window.clearInterval(t) }, [active, load])
  const getLink = async (job: ExportJobRow) => {
    try { const { data } = await platformApi.exportLink(id, job.id); window.open(data.url, '_blank', 'noopener') } catch (err) { showError(errMsg(err, 'Unable to create the download link')) }
  }
  const jobPill = (j: ExportJobRow) => j.status === 'queued' || j.status === 'running' ? <span className="inline-flex items-center gap-1.5"><Pill t="inf">{cap(j.status)}</Pill>{bar(j.progress)}</span> : exportPill(j)
  return <div className="grid gap-2 xl:grid-cols-2">
    {exportOpen && <ExportWizard tenantId={id} tenants={tenants} onClose={() => setExportOpen(false)} onStarted={() => { setExportOpen(false); void load() }} />}
    {migOpen && <MigrationWizard tenantId={id} tenants={tenants} existing={migOpen.row} onClose={() => { setMigOpen(null); void load() }} onChanged={() => void load()} />}
    <div className="space-y-2">
      <Panel title="Export this tenant’s complete data"><p className="mb-2" style={{ color: C.mu }}>Database, files, audit logs, configuration and users in one encrypted package.</p>{canManage && <Btn p onClick={() => setExportOpen(true)}><Download size={14} /> New export</Btn>}</Panel>
      <Panel title="Migrate into this tenant"><p className="mb-2" style={{ color: C.mu }}>Assisted migration from Salesforce, Zoho CRM, HubSpot, Dynamics 365 and more, CSV / Excel files, or a SQL dump.</p>{canManage && <Btn onClick={() => setMigOpen({ row: null })}><Upload size={14} /> New migration</Btn>}</Panel>
    </div>
    <div className="space-y-2">
      <Panel title="Export history" flush>{!exports ? <Empty>Loading…</Empty> : !exports.length ? <Empty>No exports yet</Empty> : <Table head={['Job', 'Status', { t: 'Size', r: true }, 'Date']} minWidth={420}>{exports.map(j => <tr key={j.id}>
        <td>{j.status === 'ready' ? <button type="button" className="font-semibold hover:underline" style={{ color: C.ac }} title={`Download · SHA-256 ${j.sha256}`} onClick={() => void getLink(j)}>{j.job}</button> : <b>{j.job}</b>}</td>
        <td>{jobPill(j)}</td><td className="text-right">{sizeText(j.size_bytes)}</td><td>{fd(j.created_at)}</td></tr>)}</Table>}</Panel>
      <Panel title="Migrations" flush>{!migs ? <Empty>Loading…</Empty> : !migs.length ? <Empty>No migrations yet</Empty> : <Table head={['Project', 'Source', 'Status']} minWidth={420}>{migs.map(mg => <tr key={mg.id} className="cursor-pointer" onClick={() => setMigOpen({ row: mg })}>
        <td><b style={{ color: C.ac }}>{mg.project}</b></td><td>{mg.source}</td><td><Pill t={migTone(mg.status)}>{mg.status}</Pill></td></tr>)}</Table>}</Panel>
    </div>
  </div>
}
