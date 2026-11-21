import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { Ic, type IconName } from './bw'
import { platformApi } from '@/services/platformApi'
import { PLATFORM_TEAM_PATHS } from './PlatformTeamTabs'
import { usePlatformAccess } from './usePlatformAccess'

// Groups and order follow the prototype's platform navigation (PNAV2); only pages that exist here are listed.
const sections = [
  {
    label: 'Command',
    links: [
      { to: '/platform/dashboard', label: 'Dashboard', icon: 'home' },
      { to: '/platform/command-center', label: 'Command Center', icon: 'pie' },
      { to: '/platform/announcements', label: 'Announcements', icon: 'megaphone', module: 'tenants' },
      { to: '/platform/tenants', label: 'Tenants & Hierarchy', icon: 'building', module: 'tenants' },
      { to: '/platform/onboarding', label: 'Onboarding & Provisioning', icon: 'check', module: 'tenants' },
      { to: '/platform/resellers', label: 'Resellers & Partners', icon: 'tag', module: 'billing' },
      { to: '/platform/revenue', label: 'Revenue Analytics', icon: 'chart', module: 'billing' },
      { to: '/platform/customer-success', label: 'Customer Success', icon: 'life', module: 'tenants' },
    ],
  },
  {
    label: 'Control',
    links: [
      { to: '/platform/control-center', label: 'Control Center', icon: 'gear', module: 'settings' },
    ],
  },
  {
    label: 'Mobile & ecosystem',
    links: [
      { to: '/platform/mobile', label: 'Mobile App Control', icon: 'mobile', module: 'tenants' },
      { to: '/platform/marketplace', label: 'Marketplace', icon: 'plug', module: 'tenants' },
    ],
  },
  {
    label: 'Data & infrastructure',
    links: [
      { to: '/platform/databases', label: 'Databases', icon: 'db', module: 'databases' },
      { to: '/platform/monitoring', label: 'Monitoring', icon: 'chart', module: 'monitoring' },
      { to: '/platform/usage-monitoring', label: 'Usage Monitoring', icon: 'pie', module: 'tenants' },
      { to: '/platform/storage', label: 'Documents & Storage', icon: 'folder', module: 'storage' },
      { to: '/platform/data-transfer', label: 'Data Export & Migration', icon: 'dl', module: 'data_transfer' },
      { to: '/platform/environments', label: 'Environments & Sandboxes', icon: 'copy', module: 'databases' },
      { to: '/platform/logs', label: 'Logs Explorer', icon: 'table', module: 'logs' },
      { to: '/platform/jobs', label: 'Jobs & Queues', icon: 'git', module: 'jobs' },
      { to: '/platform/infrastructure', label: 'Infrastructure & Releases', icon: 'server', module: 'infrastructure' },
      { to: '/platform/regions', label: 'Regions & Capacity', icon: 'server', module: 'infrastructure' },
      { to: '/platform/changes', label: 'Change & Maintenance', icon: 'clock', module: 'changes' },
    ],
  },
  {
    label: 'Business',
    links: [
      { to: '/platform/billing', label: 'Billing & Metering', icon: 'card', module: 'billing' },
      { to: '/platform/cost-margin', label: 'Cost & Margin', icon: 'wallet', module: 'billing' },
      { to: '/platform/discounts', label: 'Discounts & Coupons', icon: 'tag', module: 'billing' },
      { to: '/platform/invoices', label: 'Invoices & Dunning', icon: 'doc', module: 'billing' },
      { to: '/platform/addons', label: 'Add-ons & Usage Pricing', icon: 'plug', module: 'billing' },
      { to: '/platform/plans-entitlements', label: 'Plans & Entitlements', icon: 'plug', module: 'feature_matrix' },
      { to: '/platform/workflow-templates', label: 'Workflow Templates', icon: 'flow', module: 'tenants' },
    ],
  },
  {
    label: 'Governance',
    links: [
      { to: '/platform/security', label: 'Security & Compliance', icon: 'shield', module: 'settings' },
      { to: '/platform/trust-safety', label: 'Trust & Safety', icon: 'alert', module: 'tenants' },
      { to: '/platform/audit', label: 'Audit Trail', icon: 'doc', module: 'audit' },
      { to: '/platform/support', label: 'Support Desk', icon: 'life', module: 'tenants' },
      { to: '/platform/sla', label: 'SLA & CSAT', icon: 'life', module: 'tenants' },
    ],
  },
  {
    label: 'Platform admin',
    links: [
      { to: '/platform/api-webhooks', label: 'API & Webhooks', icon: 'key', module: 'tenants' },
      { to: '/platform/rate-limits', label: 'Rate Limits & API Keys', icon: 'key', module: 'tenants' },
      { to: '/platform/super-admins', label: 'Platform Team', icon: 'users' },
      { to: '/platform/settings', label: 'Global Settings', icon: 'gear', module: 'settings' },
    ],
  },
] as { label: string; links: { to: string; label: string; icon: IconName; module?: string; level?: 'view' | 'manage' }[] }[]

export default function PlatformSidebar({
  peek = false,
  onNavigate,
  version,
  environment,
}: {
  peek?: boolean
  onNavigate?: () => void
  version?: string
  environment?: string
}) {
  const { pathname } = useLocation()
  const { me, can, reload } = usePlatformAccess()

  useEffect(() => {
    const timer = window.setInterval(reload, 60_000)
    return () => window.clearInterval(timer)
  }, [reload])
  const [operational, setOperational] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    const check = () => platformApi.systemStatus()
      .then(({ data }) => { if (active) setOperational(data.operational) })
      .catch(() => { if (active) setOperational(false) })
    check()
    const timer = window.setInterval(check, 60_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  const env = (environment || (import.meta.env.PROD ? 'PRODUCTION' : 'DEVELOPMENT')).toLowerCase()

  // Prototype platBuild(): .sb with brand row, grouped .nav and a live status footer. The slot reserves the rail width so
  // the collapsed sidebar can peek (hover, or the header menu on phones) over the page without moving it.
  return (
    <div className="platform-sb-slot">
      <aside className={`platform-sidebar ${peek ? 'peek' : ''}`} aria-label="Platform navigation">
        <div className="br">
          <span className="logo"><img src={`${import.meta.env.BASE_URL}${encodeURIComponent('App-icon (1).png')}`} alt="" /></span>
          <span className="truncate">Azcentrix Platform</span>
        </div>

        <nav className="nav">
          {sections.map((section) => {
            // Until access loads, show everything; the server enforces access either way.
            const links = section.links.filter(link => !me || !link.module || can(link.module, link.level))
            if (links.length === 0) return null
            return (
              <div key={section.label}>
                <h6>{section.label}</h6>
                {links.map((link) => {
                  const isTeam = link.to === PLATFORM_TEAM_PATHS[0]
                  // Staff without Platform team access still land on the queue to follow their own requests.
                  const to = isTeam && me && !can('team') ? '/platform/approval-queue' : link.to
                  return (
                    <NavLink
                      key={link.to}
                      to={to}
                      title={link.label}
                      onClick={onNavigate}
                      className={({ isActive }) => isActive || (isTeam && PLATFORM_TEAM_PATHS.some(path => pathname.startsWith(path))) ? 'on' : ''}
                    >
                      <Ic n={link.icon} />
                      <span>{link.label}</span>
                      {isTeam && !!me?.pending_approvals && (
                        <em className="n not-italic" aria-label={`${me.pending_approvals} approvals waiting for you`}>{me.pending_approvals}</em>
                      )}
                    </NavLink>
                  )
                })}
              </div>
            )
          })}
        </nav>

        <div className="sbf">
          <div className={operational === false ? 'text-[#E0A23C]' : ''}>
            {operational === null
              ? <span className="mr-[5px] inline-block h-[7px] w-[7px] rounded-full bg-[#8B86C0]" />
              : operational ? <span className="livedot" /> : <span className="mr-[5px] inline-block h-[7px] w-[7px] rounded-full bg-[#E0A23C]" />}
            {operational === null ? 'Checking status…' : operational ? 'All systems operational' : 'Service degraded'}
          </div>
          <div>{version ? `build ${version} · ` : ''}{env}</div>
        </div>
      </aside>
    </div>
  )
}
