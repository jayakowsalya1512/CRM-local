import { useCallback, useEffect, useRef, useState } from 'react'
import { platformApi, type LogLine, type LogsPage } from '@/services/platformApi'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { Btn, C, Ic, Note, Pill, errMsg, fdt, num, type Tone } from '@/components/platform/bw'

// Layout, header action and columns follow the Bidwise prototype Logs explorer page (P.logs).
// Lines come from every API / Celery worker of this installation; search and column filters run on the server.
const LEVEL_TONE: Record<LogLine['level'], Tone> = { INFO: 'inf', WARN: 'wa', ERROR: 'ba' }
const PAGE = 500
const TAIL_MS = 2000
const KEEP = 5000  // lines kept in the browser while tailing
const stamp = (ts: string) => ts.replace('T', ' ').slice(0, 19)
const rid = (l: LogLine) => String(l.id)  // stable: BwGrid re-validates its selection whenever rid changes

const cols: GridCol<LogLine>[] = [
  { k: 't', t: 'Time', w: 90, sv: l => l.ts, txt: l => stamp(l.ts), fn: l => <span title={`${stamp(l.ts)}.${l.ts.slice(20, 23)} · ${l.worker}`}>{l.ts.slice(11, 19)}</span> },
  { k: 'lv', t: 'Level', w: 90, sv: l => l.level, txt: l => l.level, fn: l => <Pill t={LEVEL_TONE[l.level]}>{l.level}</Pill> },
  { k: 'svc', t: 'Service', w: 110, sv: l => l.service, txt: l => l.service, fn: l => <span title={l.logger}>{l.service}</span> },
  { k: 'ten', t: 'Tenant', w: 90, sv: l => l.tenant ?? '', txt: l => l.tenant ?? '', fn: l => l.tenant ? <Pill t="ac">{l.tenant.toUpperCase()}</Pill> : <span style={{ color: C.mu }}>—</span> },
  { k: 'msg', t: 'Message', w: 520, sv: l => l.message, txt: l => l.message, fn: l => <span title={l.detail ?? l.message}>{l.message}</span> },
]

export default function PlatformLogsPage() {
  const [rows, setRows] = useState<LogLine[]>([])
  const [meta, setMeta] = useState<Omit<LogsPage, 'rows'> | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [tail, setTail] = useState(false)
  const [filters, setFilters] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const seq = useRef(0)
  const params = useCallback(() => ({ q: filters.q || undefined, ...Object.fromEntries(Object.entries(filters.f).filter(([, v]) => v).map(([k, v]) => [`f_${k}`, v])) }), [filters])

  // Search box and quick filters go to the server (debounced); the newest matching lines replace the list.
  useEffect(() => {
    const mine = ++seq.current
    setLoading(true)
    const t = window.setTimeout(() => {
      platformApi.logs({ ...params(), limit: PAGE })
        .then(({ data }) => { if (mine === seq.current) { const { rows: r, ...m } = data; setRows(r); setMeta(m); setError('') } })
        .catch(err => { if (mine === seq.current) setError(errMsg(err, 'Logs unavailable')) })
        .finally(() => { if (mine === seq.current) setLoading(false) })
    }, 300)
    return () => window.clearTimeout(t)
  }, [params])

  // Live tail: poll for lines newer than the newest shown. Off = no automatic updates at all.
  const top = rows[0]?.id
  useEffect(() => {
    if (!tail) return
    const t = window.setInterval(() => {
      if (document.hidden) return
      const mine = seq.current
      platformApi.logs({ ...params(), after_id: top ?? 0, limit: 1000 })
        .then(({ data }) => {
          if (mine !== seq.current || !data.rows.length) return
          setRows(r => [...data.rows, ...r].slice(0, KEEP))
          setMeta(m => m && { ...m, matched: data.matched, matched_capped: data.matched_capped })  // count covers every matching line
          setError('')
        })
        .catch(err => setError(errMsg(err, 'Live tail interrupted – retrying')))
    }, TAIL_MS)
    return () => window.clearInterval(t)
  }, [tail, top, params])

  const older = () => {
    const mine = seq.current
    setLoading(true)
    platformApi.logs({ ...params(), before_id: rows[rows.length - 1]?.id, limit: PAGE })
      .then(({ data }) => { if (mine === seq.current) { setRows(r => [...r, ...data.rows]); setMeta(m => m && { ...m, has_more: data.has_more }) } })
      .catch(err => setError(errMsg(err, 'Older lines unavailable')))
      .finally(() => setLoading(false))
  }
  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => setFilters(prev => JSON.stringify(prev) === JSON.stringify(s) ? prev : s), [])
  const status = meta?.status

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      <div><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Data &amp; infrastructure</div><h1 className="text-xl font-semibold">Logs explorer</h1></div>
      <span className="flex-1" />
      <Btn p={tail} onClick={() => setTail(v => !v)} title={tail ? 'New lines appear every 2 seconds' : 'Show new lines as they are written'}><Ic n="clock" /> Live tail {tail ? 'on' : 'off'}</Btn>
    </div>
    {error && <Note className="mb-2">{error}</Note>}
    <div className="rounded-md border" style={{ background: C.sf, borderColor: C.ln, opacity: loading && !rows.length ? .7 : 1 }}>
      <BwGrid id="logs" cols={cols} rows={rows} rid={rid} onQuery={onQuery}
        empty={loading ? 'Loading…' : status && !status.total ? 'No log lines yet – lines appear here as the application writes them' : 'No log lines match'} />
      {meta && <div className="flex flex-wrap items-center gap-2 border-t px-2 py-1 text-xs" style={{ borderColor: C.ln, color: C.mu }}>
        <span>{num(rows.length)} newest of {meta.matched_capped ? 'over 100,000' : num(meta.matched)} matching line{meta.matched === 1 ? '' : 's'}{meta.scoped ? ' · your tenants only' : ''}</span>
        {status?.collecting_since && <span>· collecting since {fdt(status.collecting_since)}</span>}
        {status && status.dropped > 0 && <span style={{ color: C.wa }}>· {num(status.dropped)} lines dropped while the database was unreachable</span>}
        <span className="flex-1" />
        {meta.has_more && <Btn s disabled={loading} onClick={older}>Load {PAGE} older</Btn>}
      </div>}
    </div>
  </div>
}
