import { useEffect, type FormEvent, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { X } from 'lucide-react'
import { usePlatformAccess } from './usePlatformAccess'

export const PLATFORM_TEAM_PATHS = ['/platform/super-admins', '/platform/roles', '/platform/approval-queue']

const TABS = [
  { to: '/platform/super-admins', label: 'Staff' },
  { to: '/platform/roles', label: 'Roles & permissions' },
  { to: '/platform/approval-queue', label: 'Approval queue' },
]

/** Shared shell for the Platform Team pages: tab bar, page title and primary action. */
export default function PlatformTeamTabs({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const { me } = usePlatformAccess()
  const pending = me?.pending_approvals ?? 0
  return (
    <div className="min-h-full">
      <nav className="mb-2 flex gap-0.5 overflow-x-auto border-b border-[var(--bw-ln)]" aria-label="Platform team">
        {TABS.map(tab => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end
            className={({ isActive }) => `-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-[7px] text-[13px] font-medium transition-colors ${isActive ? 'border-[var(--bw-ac)] text-[var(--bw-ac)]' : 'border-transparent text-[var(--bw-mu)] hover:text-[var(--bw-tx)]'}`}
          >
            {tab.label}
            {tab.to === '/platform/approval-queue' && pending > 0 && (
              <span className="rounded-lg bg-[var(--bw-ba)] px-[5px] text-[10px] leading-[15px] text-white" aria-label={`${pending} waiting for you`}>{pending}</span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="mb-2 flex flex-wrap items-center gap-2.5">
        <h1 className="text-[17px] font-semibold text-[var(--bw-tx)]">{title}</h1>
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </div>
  )
}

export function TeamPanel({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="bw-panel">
      <header className="ph">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {actions && <><span className="flex-1" />{actions}</>}
      </header>
      {children}
    </section>
  )
}

/** Prototype .md dialog: title bar, body, grey footer. */
export function TeamModal({ title, onClose, onSubmit, footer, width = 480, children }: {
  title: string
  onClose: () => void
  onSubmit?: (event: FormEvent) => void
  footer: ReactNode
  width?: number
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const body = (
    <>
      <div className="ph">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="ml-auto grid h-7 w-7 place-items-center rounded-md text-[var(--bw-mu)] hover:bg-[var(--bw-hd)]"><X size={15} /></button>
      </div>
      <div className="pb max-h-[70vh] overflow-y-auto">{children}</div>
      <div className="pf">{footer}</div>
    </>
  )
  const box = 'bw-md overflow-hidden'
  return (
    <div className="bw-ov" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      {onSubmit
        ? <form onSubmit={onSubmit} className={box} style={{ maxWidth: width }} role="dialog" aria-label={title}>{body}</form>
        : <div className={box} style={{ maxWidth: width }} role="dialog" aria-label={title}>{body}</div>}
    </div>
  )
}

export function Pill({ tone = 'ac', children, title }: { tone?: 'ac' | 'ok' | 'wa' | 'ba' | 'mu'; children: ReactNode; title?: string }) {
  const colour = { ac: 'var(--bw-ac)', ok: 'var(--bw-ok)', wa: 'var(--bw-wa)', ba: 'var(--bw-ba)', mu: 'var(--bw-mu)' }[tone]
  return (
    <span title={title} className="inline-block whitespace-nowrap rounded-[9px] px-[9px] py-px text-[11px] font-semibold leading-[18px]"
      style={tone === 'mu' ? { color: colour, background: 'var(--bw-hd)', border: '1px solid var(--bw-ln2)' } : { color: colour, background: `color-mix(in srgb, ${colour} 13%, var(--bw-sf))` }}>
      {children}
    </span>
  )
}

export const fieldLabelClass = 'mb-0.5 block text-[12px] text-[var(--bw-mu)]'
// Shared prototype controls (.bw-in / .bw-btn in index.css), kept as class names for the team pages.
export const inputClass = 'bw-in disabled:bg-[var(--bw-hd)] disabled:text-[var(--bw-mu)]'
export const primaryButtonClass = 'bw-btn p'
export const buttonClass = 'bw-btn'
export const smallButtonClass = 'bw-btn s'
export const smallPrimaryButtonClass = 'bw-btn s p'
export const smallDangerButtonClass = 'bw-btn s d'

export const apiError = (err: any, fallback: string) => {
  const detail = err?.response?.data?.detail
  if (Array.isArray(detail)) return detail.map((d: any) => d?.msg).filter(Boolean).join('; ') || fallback
  return typeof detail === 'string' ? detail : fallback
}

export const formatDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''

export const formatDateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
