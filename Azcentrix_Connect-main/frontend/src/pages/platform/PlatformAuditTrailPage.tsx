import { useCallback, useEffect, useRef, useState } from 'react'
import { platformApi, type AuditTrailEntry, type AuditTrailRow } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol, type GridServer } from '@/components/platform/BwGrid'
import { Btn, BwModal, C, Ic, Kv, Note, Pill, downloadBlob, errMsg } from '@/components/platform/bw'

// Layout follows the Bidwise prototype Audit trail page (P.audit): Governance crumb, Export, and one grid
// (When · Actor · Event · IP address · Result). Records are the platform audit log, filtered, sorted and paged by the server.
// Timestamps carry the database's UTC offset, so they show correctly in any browser time zone.
const when = (v: string | null) => v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

const cols: GridCol<AuditTrailRow>[] = [
  { k: 't', t: 'When', w: 150, date: true, txt: r => when(r.at), sv: r => r.at ?? '' },
  { k: 'u', t: 'Actor', w: 150, txt: r => r.actor },
  { k: 'a', t: 'Event', w: 420, txt: r => r.event },
  { k: 'ip', t: 'IP address', w: 140, txt: r => r.ip ?? '' },
  { k: 'r', t: 'Result', w: 100, txt: r => r.result, fn: r => <Pill t={r.result === 'Success' ? 'ok' : 'ba'}>{r.result}</Pill> },
  { k: 'tenant', t: 'Tenant', w: 160, hide: true, txt: r => r.tenant ?? '' },
  { k: 'action', t: 'Action', w: 180, hide: true, txt: r => r.action },
  { k: 'res', t: 'Resource', w: 160, hide: true, txt: r => [r.resource_type, r.resource].filter(Boolean).join(': ') },
]
const rid = (r: AuditTrailRow) => String(r.id)

function Values({ label, data }: { label: string; data: unknown }) {
  const empty = data == null || (typeof data === 'object' && !Object.keys(data as object).length)
  return <div className="min-w-0 flex-1"><div className="mb-0.5 text-xs" style={{ color: C.mu }}>{label}</div>
    {empty ? <div className="rounded-md border px-2 py-1.5 text-xs" style={{ borderColor: C.ln, color: C.mu }}>Not recorded</div>
      : <pre className="max-h-[300px] overflow-auto rounded-md border p-2 text-xs" style={{ borderColor: C.ln, background: C.hd }}>{JSON.stringify(data, null, 2)}</pre>}</div>
}

function EntryModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [e, setE] = useState<AuditTrailEntry | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { platformApi.auditEntry(id).then(r => setE(r.data)).catch(x => setErr(errMsg(x, 'Audit entry unavailable'))) }, [id])
  return <BwModal title={e ? e.event : 'Audit entry'} width={760} onClose={onClose} foot={<Btn onClick={onClose}>Close</Btn>}>
    {!e ? <div className="py-4 text-center text-xs" style={{ color: C.mu }}>{err || 'Loading…'}</div> : <>
      <Kv rows={[
        ['When', when(e.at)], ['Actor', `${e.actor}${e.actor_username ? ` (${e.actor_username})` : ''}`], ['Action', e.action],
        ['Resource', [e.resource_type, e.resource ?? (e.resource_id != null ? `#${e.resource_id}` : null)].filter(Boolean).join(': ') || '—'],
        ['Tenant', e.tenant ?? '—'], ['IP address', e.ip ?? '—'], ['Result', <Pill t={e.result === 'Success' ? 'ok' : 'ba'}>{e.result}</Pill>],
      ]} />
      <div className="mt-2 flex flex-wrap gap-2"><Values label="Previous values" data={e.old_data} /><Values label="Updated values" data={e.new_data} /></div>
      <div className="mt-1.5 text-[11px]" style={{ color: C.mu }}>Passwords, tokens and other secrets are never shown. Audit entries can't be changed or deleted.</div>
    </>}
  </BwModal>
}

export default function PlatformAuditTrailPage() {
  const { success, error: showError } = useToast()
  const [rows, setRows] = useState<AuditTrailRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [query, setQuery] = useState({ q: '', f: {} as Record<string, string> })
  const [view, setView] = useState<Parameters<GridServer['onChange']>[0]>({ offset: 0, limit: 25, sorts: [], adv: { logic: 'AND', conds: [] } })
  const seq = useRef(0)

  const params = useCallback(() => ({
    q: query.q, quick: JSON.stringify(Object.fromEntries(Object.entries(query.f).filter(([, v]) => v))),
    conds: JSON.stringify(view.adv.conds.filter(c => c.k)), logic: view.adv.logic, sort: JSON.stringify(view.sorts),
  }), [query, view])

  useEffect(() => {
    const n = ++seq.current
    setLoading(true)
    const t = setTimeout(() => {
      platformApi.auditTrail({ ...params(), offset: view.offset, limit: view.limit })
        .then(({ data }) => { if (n === seq.current) { setRows(data.items); setTotal(data.total); setError('') } })
        .catch(err => { if (n === seq.current) setError(errMsg(err, 'Audit trail unavailable')) })
        .finally(() => { if (n === seq.current) setLoading(false) })
    }, 250)
    return () => clearTimeout(t)
  }, [params, view.offset, view.limit])

  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => setQuery(prev => JSON.stringify(prev) === JSON.stringify(s) ? prev : s), [])
  const onChange = useCallback<GridServer['onChange']>(s => setView(prev => JSON.stringify(prev) === JSON.stringify(s) ? prev : s), [])
  const server: GridServer = { total, onChange }

  const doExport = async () => {
    setExporting(true)
    try {
      const res = await platformApi.auditExport(params())
      const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] ?? '')?.[1] ?? 'audit-trail.csv'
      downloadBlob(res.data, name)
      const sig = String(res.headers['x-audit-signature'] ?? '').replace('hmac-sha256=', '')
      success('Audit export (CSV, signed) downloaded', `${res.headers['x-audit-rows'] ?? ''} entries · signature ${sig.slice(0, 16)}…`)
    } catch (err) {
      let detail = 'Unable to export the audit trail'
      const data = (err as { response?: { data?: unknown } })?.response?.data
      if (data instanceof Blob) { try { detail = JSON.parse(await data.text()).detail ?? detail } catch { /* keep default */ } }
      showError(detail)
    } finally { setExporting(false) }
  }

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2 flex flex-wrap items-end gap-2">
      <div className="flex-1"><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Governance</div><h1 className="text-xl font-semibold">Audit trail</h1></div>
      <Btn disabled={exporting || !total} onClick={() => void doExport()} title="Signed CSV of every entry matching the current search and filters"><Ic n="dl" /> {exporting ? 'Exporting…' : 'Export'}</Btn>
    </div>
    {error && <Note className="mb-2">{error}{rows.length ? ' · showing the last data received' : ''}</Note>}
    <div className="rounded-md border" style={{ background: C.sf, borderColor: C.ln }}>
      <BwGrid id="audit" cols={cols} rows={rows} rid={rid} onQuery={onQuery} server={server} onRow={r => setOpen(r.id)}
        empty={loading ? 'Loading…' : error ? 'The audit trail could not be loaded.' : 'No audit entries match.'} />
    </div>
    {open != null && <EntryModal id={open} onClose={() => setOpen(null)} />}
  </div>
}
