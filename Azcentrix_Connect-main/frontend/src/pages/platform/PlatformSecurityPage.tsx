import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { platformApi, type SecurityOverview } from '@/services/platformApi'
import { C, Empty, Note, Panel, Pill, Strip, Table, errMsg, fd } from '@/components/platform/bw'

// Layout follows the Bidwise prototype Security & compliance page (P.sec): strip, certifications & frameworks, data subject
// requests, encryption keys (KMS) and the support impersonation log. Sections the platform can't back with real data say why.
function EmptyRow({ cols, children }: { cols: number; children: ReactNode }) {
  return <tr><td colSpan={cols} className="!p-0"><Empty>{children}</Empty></td></tr>
}

export default function PlatformSecurityPage() {
  const [data, setData] = useState<SecurityOverview | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try { const { data: next } = await platformApi.securityOverview(); setData(next); setError('') }
    catch (err) { setError(errMsg(err, 'Security & compliance unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])
  const loading = error || 'Loading…'
  const comp = data?.compliance
  const enc = data?.encryption

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2"><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Governance</div><h1 className="text-xl font-semibold">Security &amp; compliance</h1></div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}

    <Strip items={[
      { l: 'Compliance controls', kpi: 'security.compliance', v: comp?.percent != null ? `${comp.percent}%` : '—', c: comp ? C.ok : undefined,
        d: comp ? <span title={`Control Center controls enforced by the platform and switched on, across: ${comp.categories.join(', ')}`}>{comp.in_force} / {comp.total}</span> : undefined },
      { l: 'Open DSARs', kpi: 'security.dsar', v: '—', d: data ? <span title={data.dsr.reason ?? undefined}>Not handled yet</span> : undefined },
      { l: 'Critical vulnerabilities', kpi: 'security.vulnerabilities', v: '—', d: data ? <span title={data.vulnerabilities.reason ?? undefined}>No scanner connected</span> : undefined },
      { l: 'Key rotations due', kpi: 'security.key_rotations', v: '—', d: enc ? <span title={enc.reason ?? 'MariaDB records no key rotation dates'}>{enc.available ? 'No rotation dates recorded' : 'Encryption at rest off'}</span> : undefined },
    ]} />

    <div className="mb-2 grid gap-2 md:grid-cols-2">
      <Panel title="Certifications & frameworks" flush>
        {!data ? <Empty>{loading}</Empty> : <div>{data.frameworks.map(f =>
          <div key={f.key} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}>
            <span className="flex-1">{f.name}</span>
            <Pill t={f.enabled ? 'ok' : 'mu'} title="Control Center → Data residency & compliance">{f.enabled ? 'Enabled' : 'Disabled'}</Pill>
          </div>)}</div>}
      </Panel>
      <Panel title="Data subject requests" flush>
        <Table head={['ID', 'Tenant', 'Type', 'Due', '']} minWidth={420}>
          {!data ? <EmptyRow cols={5}>{loading}</EmptyRow>
            : data.dsr.items.length ? data.dsr.items.map(r => <tr key={r.id}><td>{r.id}</td><td>{r.tenant}</td><td>{r.type}</td><td>{fd(r.due)}</td><td /></tr>)
              : <EmptyRow cols={5}>{data.dsr.reason}</EmptyRow>}
        </Table>
      </Panel>
    </div>

    <div className="grid gap-2 md:grid-cols-2">
      <Panel title="Encryption keys (KMS)" flush>
        <Table head={['Key', 'Rotated', 'Next']} minWidth={360}>
          {!enc ? <EmptyRow cols={3}>{loading}</EmptyRow>
            : !enc.available ? <EmptyRow cols={3}>{enc.reason}</EmptyRow>
              : enc.keys.length ? enc.keys.map(k => <tr key={k.key}><td>{k.key}</td><td>{fd(k.rotated)}</td><td>{fd(k.next)}</td></tr>)
                : <EmptyRow cols={3}>No encrypted tenant tablespaces found.</EmptyRow>}
        </Table>
      </Panel>
      <Panel title="Support impersonation log" flush>
        <Table head={['Staff', 'Tenant', 'Reason', 'Date']} minWidth={420}>
          {!data ? <EmptyRow cols={4}>{loading}</EmptyRow>
            : data.impersonation.items.length ? data.impersonation.items.map((r, i) => <tr key={i}><td>{r.staff}</td><td>{r.tenant}</td><td>{r.reason}</td><td>{fd(r.date)}</td></tr>)
              : <EmptyRow cols={4}>{data.impersonation.reason}</EmptyRow>}
        </Table>
      </Panel>
    </div>
  </div>
}
