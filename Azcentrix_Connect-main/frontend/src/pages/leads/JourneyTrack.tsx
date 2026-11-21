// Prototype v17 jTrack(): journey id + L · D · T|Q · O steps (done / current / lost) + the current step's label.
// Shared by the Leads and Deals grids; styles in leads.css (.jtr).
export interface Journey { id: string; steps: { k: string; label: string; done: boolean; stage: string | null; ref?: string | null; me?: boolean }[] }

export default function JourneyTrack({ j, lost, onOpen }: { j?: Journey | null; lost?: boolean; onOpen?: () => void }) {
  if (!j) return <span className="mu">—</span>
  const S = j.steps
  let last = -1
  S.forEach((s, i) => { if (s.done) last = i })
  const x = last >= 0 && (/^(Lost|Disqualified|Rejected)$/.test(S[last].stage || '') || (!!S[last].me && !!lost))
  return <a className="jtr" onClick={e => { e.stopPropagation(); onOpen?.() }}
    title={S.map(s => `${s.label}: ${s.done ? s.stage || 'open' : 'not started'}${s.ref ? ` (${s.ref})` : ''}`).join(' · ')}>
    <span className="jtr-id">{j.id}</span>
    <span className="jtr-s">{S.map((s, i) => <i key={s.k} className={`${s.done ? (i === last ? (x ? 'x' : 'c') : 'd') : ''} ${s.me ? 'me' : ''}`}>{s.k}</i>)}</span>
    <span className="jtr-l">{last >= 0 ? S[last].label : ''}</span>
  </a>
}
