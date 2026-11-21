import { useCallback, useEffect, useRef, useState } from 'react'
import { platformApi, type StorageFile, type StorageOverview, type StorageTier } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { Btn, BwModal, C, Empty, Field, Ic, Note, Panel, Pill, Strip, Switch, Table, downloadBlob, errMsg, fd, fdt, inputCls, inputStyle, num, useKpiPopup, type Tone } from '@/components/platform/bw'
import { Donut, HBars } from '@/components/platform/charts'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout, KPIs, panels, columns, bulk actions and policies follow the Bidwise prototype Documents & storage page (P.store).
// Every value comes from the platform's storage catalogue: tenant upload folders, tenant database references and real scans.
const MB = 1024 * 1024
const size = (b: number) => b >= 1024 * MB ? `${(b / 1024 / MB).toFixed(2)} GB` : b >= MB ? `${(b / MB).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`
const mbText = (b: number) => `${Math.round(b / MB)} MB`
const TIER_COLOR: Record<StorageTier, string> = { Hot: C.ba, Warm: C.wa, Cold: C.in }
const SCAN_TONE: Record<StorageFile['scan'], Tone> = { Verified: 'ok', Quarantined: 'ba', Infected: 'ba', Released: 'mu', 'Scan error': 'wa', 'Not scanned': 'mu' }
const rid = (f: StorageFile) => String(f.id)  // stable: BwGrid re-validates its selection whenever rid changes

type Action = { kind: 'cold' | 'quarantine' | 'delete'; rows: StorageFile[] } | { kind: 'release' | 'remove'; rows: [StorageFile] }
const TITLES = { cold: 'Move to cold', quarantine: 'Quarantine', delete: 'Delete', release: 'Release', remove: 'Delete' }

function ActionModal({ action, data, onClose, onDone }: { action: Action; data: StorageOverview; onClose: () => void; onDone: () => Promise<void> }) {
  const { success, error: showError } = useToast()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string[] | null>(null)
  const { kind, rows } = action
  const needsText = kind !== 'cold'
  const linked = rows.filter(r => r.links > 0 || r.deleted_links > 0)
  const run = async () => {
    if (needsText && text.trim().length < 3) return showError(kind === 'release' ? 'Describe the review that cleared this file' : 'Give a reason – it is recorded in the audit log')
    setBusy(true)
    try {
      if (kind === 'release') { await platformApi.storageRelease(rows[0].id, text.trim()); success('Released after manual review'); await onDone(); return onClose() }
      if (kind === 'remove') { const { data: r } = await platformApi.storageDelete(rows[0].id, text.trim()); success('File deleted'); setResult([r.notice]); return await onDone() }
      const { data: r } = await platformApi.storageBulk(kind, rows.map(x => x.id), text.trim())
      const names = new Map(rows.map(x => [x.id, x.name]))
      if (r.failed) showError(`${r.failed} of ${rows.length} file(s) failed`); else success(`${TITLES[kind]}: ${r.done} file(s) done`)
      setResult([...r.results.filter(x => !x.ok).map(x => `${names.get(x.id)}: ${x.error}`), ...r.notices])
      await onDone()
      if (!r.failed && !r.notices.length) onClose()
    } catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy(false) }
  }
  return <BwModal title={`${TITLES[kind]} · ${rows.length} file${rows.length === 1 ? '' : 's'}`} width={560} onClose={onClose}
    foot={<><Btn onClick={onClose}>{result ? 'Close' : 'Cancel'}</Btn>{!result && <Btn p={kind !== 'delete' && kind !== 'remove'} d={kind === 'delete' || kind === 'remove'} disabled={busy} onClick={() => void run()}>{busy ? 'Working…' : TITLES[kind]}</Btn>}</>}>
    <div className="space-y-2.5">
      <div className="max-h-[140px] overflow-auto text-xs" style={{ color: C.mu }}>{rows.map(r => <div key={r.id}>{r.tenant.slug.toUpperCase()} · {r.name} · {size(r.size)}</div>)}</div>
      {kind === 'cold' && <Note info>Files move to {data.cold_storage.path}. Downloads keep working and read from the cold disk. Files outside the document routes and quarantined files are skipped.</Note>}
      {kind === 'quarantine' && <Note>The files move out of the served folders: tenant users can’t open or download them until they’re released.</Note>}
      {(kind === 'delete' || kind === 'remove') && <Note>Permanent – the files and their copies are removed from disk and the tenant admin is e-mailed. {linked.length ? <b>{linked.length} file(s) are still referenced by tenant records, which will show them as missing.</b> : 'None of these files is referenced by a tenant record.'}</Note>}
      {kind === 'release' && <Note>{rows[0].quarantine_reason}. The file goes back to its original folder and won’t be quarantined again by the scanner or the executable policy unless its content changes.</Note>}
      {needsText && <Field label={kind === 'release' ? 'Review note' : 'Reason'}><textarea className="w-full rounded-md border px-2 py-1 text-[13px]" rows={2} style={inputStyle} value={text} maxLength={400} onChange={e => setText(e.target.value)} /></Field>}
      {result && result.length > 0 && <Note info>{result.map(l => <div key={l}>{l}</div>)}</Note>}
    </div>
  </BwModal>
}

export default function PlatformStoragePage() {
  const { can } = usePlatformAccess()
  const canManage = can('storage', 'manage')
  const { success, error: showError } = useToast()
  const [data, setData] = useState<StorageOverview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<Action | null>(null)
  const [busy, setBusy] = useState('')
  const [openKpi, kpiPopup] = useKpiPopup()

  const seq = useRef(0)
  const load = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    try { const { data: next } = await platformApi.storageOverview(); if (mine === seq.current) { setData(next); setError('') } }
    catch (err) { if (mine === seq.current) setError(errMsg(err, 'Storage data unavailable')) }
    finally { if (mine === seq.current) setLoading(false) }
  }, [])
  const running = !!data?.jobs.running || (!!data && !data.indexed)
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, running ? 5_000 : 60_000)
    return () => window.clearInterval(timer)
  }, [load, running])

  const scan = async () => {
    setBusy('scan')
    try { const { data: r } = await platformApi.storageOrphanScan(); success(r.started ? 'Orphan scan started – every tenant database is being checked' : 'A storage job is running – the orphan scan follows it'); await load() }
    catch (err) { showError(errMsg(err, 'Could not start the orphan scan')) } finally { setBusy('') }
  }
  const exportReport = async () => {
    setBusy('export')
    try { const { data: blob } = await platformApi.storageReport(); downloadBlob(blob as Blob, `storage-report-${new Date().toISOString().slice(0, 10)}.xlsx`); success('Storage report exported') }
    catch (err) { showError(errMsg(err, 'Export failed')) } finally { setBusy('') }
  }
  const togglePolicy = async (key: string, enabled: boolean) => {
    setBusy(key)
    try { await platformApi.setStoragePolicy(key, enabled); success(`Policy ${enabled ? 'enabled' : 'disabled'}`); await load() }
    catch (err) { showError(errMsg(err, 'Policy not saved')) } finally { setBusy('') }
  }
  const bulk = (kind: 'cold' | 'quarantine' | 'delete') => (rows: StorageFile[]) => {
    if (!canManage) return showError('Your platform role can’t change tenant files')
    if (!rows.length) return showError('Select at least one file')
    if (kind === 'cold' && !data?.cold_storage.configured) return showError(data?.cold_storage.error || 'No cold storage configured')
    setAction({ kind, rows })
  }

  const k = data?.kpis
  const jobs = data?.jobs
  const cols: GridCol<StorageFile>[] = [
    { k: 'n', t: 'File', w: 240, sv: f => f.name, txt: f => f.name, fn: f => <span title={f.refs.length ? `Referenced by ${f.refs.join(', ')}` : undefined}><Pill t="mu">{(f.ext || 'file').toUpperCase()}</Pill> <b>{f.name}</b></span> },
    { k: 'tn', t: 'Tenant', sv: f => f.tenant.slug, txt: f => f.tenant.name, fn: f => <span title={f.tenant.name}><Pill t="ac">{f.tenant.slug.toUpperCase()}</Pill></span> },
    { k: 'sz', t: 'Size', r: true, sum: true, sv: f => f.size, sumv: f => f.size, sumFmt: size, txt: f => size(f.size), fn: f => <span title={f.original_size !== f.size ? `${size(f.original_size)} as uploaded` : undefined}>{size(f.size)}</span> },
    { k: 'own', t: 'Owner', sv: f => f.owner ?? '', txt: f => f.owner ?? '', fn: f => f.owner ?? <span style={{ color: C.mu }}>—</span> },
    { k: 'up', t: 'Uploaded', sv: f => f.uploaded_at ?? '', txt: f => fd(f.uploaded_at), fn: f => fd(f.uploaded_at) },
    { k: 'acc', t: 'Last accessed', sv: f => f.last_accessed_at ?? '', txt: f => f.last_accessed_at ? fd(f.last_accessed_at) : '', fn: f => f.last_accessed_at ? fd(f.last_accessed_at) : <span style={{ color: C.mu }} title={jobs?.access_tracking_since ? `Not opened since tracking began ${fdt(jobs.access_tracking_since)}` : 'Opens are recorded from now on'}>Not opened</span> },
    { k: 'tier', t: 'Tier', sv: f => f.tier, txt: f => f.tier, fn: f => <Pill t="inf">{f.tier}</Pill> },
    { k: 'scan', t: 'Scan', sv: f => f.scan, txt: f => f.scan, fn: f => <Pill t={SCAN_TONE[f.scan]} title={[f.scan_detail, f.scanned_at && `scanned ${fdt(f.scanned_at)}`].filter(Boolean).join(' · ') || (data?.scanner.available ? 'Waiting for the scanner' : data?.scanner.error ?? undefined)}>{f.scan}</Pill> },
    { k: 'ref', t: 'Links', r: true, sv: f => f.links, txt: f => String(f.links), fn: f => f.links ? <span title={f.refs.join(', ')}>{f.links}</span> : f.deleted_links ? <span style={{ color: C.mu }} title={`Only soft-deleted records: ${f.refs.join(', ')}`}>0 · in bin</span> : <span style={{ color: C.wa }}>orphan</span> },
  ]

  const tierRows = data?.by_tier.map(t => ({ l: t.tier, v: t.bytes, c: TIER_COLOR[t.tier] })) ?? []
  const types = data ? [...data.by_type.slice(0, 5).map(t => ({ l: t.type, v: t.bytes })), ...(data.by_type.length > 5 ? [{ l: 'Other', v: data.by_type.slice(5).reduce((a, t) => a + t.bytes, 0) }] : [])] : []

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    {kpiPopup}
    {action && data && <ActionModal action={action} data={data} onClose={() => setAction(null)} onDone={load} />}
    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      <div><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Data &amp; infrastructure</div><h1 className="text-xl font-semibold">Documents &amp; storage</h1></div>
      <span className="flex-1" />
      <Btn disabled={!canManage || !data?.all_scope || busy === 'scan'} title={!data?.all_scope ? 'Needs all-tenant scope' : jobs?.references_at ? `Last checked ${fdt(jobs.references_at)}` : undefined} onClick={() => void scan()}><Ic n="scan" /> {busy === 'scan' ? 'Starting…' : 'Scan for orphans'}</Btn>
      <Btn p disabled={!data || busy === 'export'} onClick={() => void exportReport()}><Ic n="dl" /> {busy === 'export' ? 'Exporting…' : 'Export'}</Btn>
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}
    {data && !data.indexed && <Note info className="mb-2">Indexing tenant files for the first time – figures fill in within a minute.</Note>}
    {jobs?.running && data?.indexed && <Note info className="mb-2">Storage job running (indexing, scanning or lifecycle policies) – the page refreshes every 5 seconds.</Note>}
    {(jobs?.index_error || jobs?.references_error) && <Note className="mb-2">{jobs.references_error || jobs.index_error}</Note>}

    <Strip items={[
      { l: 'Total stored', v: k ? size(k.total_bytes) : '—', sp: k?.trend_mb, kpi: 'storage.total' },
      { l: 'Files', v: k ? num(k.files) : '—', kpi: 'storage.files' },
      { l: 'Growth · 30d', v: k ? (k.growth_30d == null ? <span title="No files older than 30 days to compare with">—</span> : <span title="Bytes of files uploaded in the last 30 days, against what was stored before">{k.growth_30d >= 0 ? '+' : ''}{k.growth_30d}%</span>) : '—', kpi: 'storage.growth' },
      { l: 'Dedup savings', v: k ? <span style={{ color: C.ok }} title={`${size(k.dedup_saved_bytes)} shared on disk${k.dedup_potential_bytes ? ` · ${size(k.dedup_potential_bytes)} more in identical uploads` : ''}`}>{k.dedup_percent ?? 0}%</span> : '—', d: k?.dedup_potential_bytes ? `${mbText(k.dedup_potential_bytes)} possible` : undefined, kpi: 'storage.dedup' },
      { l: 'Quarantined', v: k ? <span style={{ color: k.quarantined ? C.ba : undefined }}>{num(k.quarantined)}</span> : '—', kpi: 'storage.quarantined' },
      { l: 'Orphaned files', v: k ? (k.orphaned == null ? <span title="Run Scan for orphans">—</span> : <span style={{ color: k.orphaned ? C.wa : undefined }} title={`${size(k.orphaned_bytes)} not referenced by any tenant record`}>{num(k.orphaned)}</span>) : '—', kpi: 'storage.orphaned' },
      { l: 'Cold tier', v: k ? (k.cold_percent == null ? <span className="text-xs font-normal" style={{ color: C.mu }} title={data?.cold_storage.error ?? undefined}>Not configured</span> : <span title={`${size(k.cold_bytes)} on cold storage`}>{Math.round(k.cold_percent)}%</span>) : '—', kpi: 'storage.cold' },
    ]} />

    {!data ? <Panel title="Storage"><Empty>{loading ? 'Loading…' : 'Storage data unavailable'}</Empty></Panel> : <div style={{ opacity: loading && !running ? .7 : 1 }} aria-busy={loading}>
      <div className="mb-2 grid gap-2 lg:grid-cols-3">
        <Panel title="Storage by tenant">{data.by_tenant.length ? <HBars lw={60} vw={60} rows={data.by_tenant.map(t => ({ l: t.slug.toUpperCase(), v: t.bytes, text: mbText(t.bytes), note: t.name }))}
          onPick={i => { const t = data.by_tenant[i]; openKpi({ kpi: 'storage.total', title: `Total stored · ${t.name}`, value: mbText(t.bytes), query: { tenant_id: t.tenant_id } }) }} /> : <Empty>No tenants</Empty>}</Panel>
        <Panel title="By file type">{types.length ? <Donut data={types} f={mbText} center={mbText(k!.total_bytes)} onPick={i => openKpi(types[i].l === 'Other' && data.by_type.length > 5 ? { kpi: 'storage.files', title: 'Files', value: num(k!.files) } : { kpi: 'storage.files', title: `Files · ${types[i].l}`, value: mbText(types[i].v), query: { facet: types[i].l } })} /> : <Empty>No files stored</Empty>}</Panel>
        <Panel title="By storage tier">{k!.files ? <Donut data={tierRows} f={mbText} onPick={i => openKpi({ kpi: 'storage.total', title: `${tierRows[i].l} tier`, value: mbText(tierRows[i].v), query: { facet: tierRows[i].l } })} /> : <Empty>No files stored</Empty>}</Panel>
      </div>

      <Panel title="Largest files across tenants" flush className="mb-2" act={data.files_total > data.files.length ? <small style={{ color: C.mu }}>Largest {num(data.files.length)} of {num(data.files_total)}</small> : undefined}>
        <BwGrid id="storage-files" cols={cols} rows={data.files} rid={rid} empty={data.indexed ? 'No files stored' : 'Indexing…'}
          bulk={[['Move to cold', bulk('cold')], ['Quarantine', bulk('quarantine')], ['Delete', bulk('delete')]]} />
      </Panel>

      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="Quarantine queue" flush>
          {data.quarantine.length ? <Table head={['File', 'Tenant', '']} minWidth={420}>{data.quarantine.map(f => <tr key={f.id}>
            <td title={`${f.quarantine_reason ?? ''}${f.quarantined_at ? ` · ${fdt(f.quarantined_at)}` : ''}`}>{f.name}<div className="text-[11px]" style={{ color: C.mu }}>{f.quarantine_reason}</div></td>
            <td title={f.tenant.name}>{f.tenant.slug.toUpperCase()}</td>
            <td className="whitespace-nowrap text-right"><Btn s disabled={!canManage} onClick={() => setAction({ kind: 'release', rows: [f] })}>Release</Btn> <Btn s d disabled={!canManage} onClick={() => setAction({ kind: 'remove', rows: [f] })}>Delete</Btn></td>
          </tr>)}</Table> : <Empty>No files in quarantine{data.scanner.available ? ` · scanning with ${data.scanner.name}` : ''}</Empty>}
        </Panel>
        <Panel title="Lifecycle policies" flush>
          <div>{data.policies.map(p => <div key={p.key} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}>
            <Switch on={p.enabled} label={p.label} disabled={!canManage || !data.all_scope || busy === p.key || (!p.enabled && !!p.unavailable)} onChange={v => void togglePolicy(p.key, v)} />
            <span className="flex-1">{p.label}
              {(p.unavailable || p.last_error || p.last_run_at) && <div className="text-[11px]" style={{ color: p.unavailable || p.last_error ? C.wa : C.mu }}>
                {p.unavailable ? `Unavailable: ${p.unavailable}` : p.last_error ? `Last run failed: ${p.last_error}` : `${p.last_result ?? 'Ran'} · ${fdt(p.last_run_at)}`}
              </div>}
            </span>
          </div>)}</div>
        </Panel>
      </div>
    </div>}
  </div>
}
