import { useState, useEffect, useRef, useCallback, type ComponentType, type DragEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, useLocation } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  BarChart2,
  Bell,
  Brain,
  Briefcase,
  Building2,
  Calendar,
  ClipboardCheck,
  ClipboardList,
  FileText,
  GripVertical,
  LayoutDashboard,
  LayoutTemplate,
  Mail,
  MailPlus,
  MapPin,
  Package,
  PieChart,
  Plane,
  Plug,
  Receipt,
  Settings,
  Settings2,
  Shield,
  ShieldCheck,
  StickyNote,
  Target,
  TrendingUp,
  Trash2,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { buildThemeLogoUrl } from '@/hooks/UseTheme'
import api, { withPassiveSessionActivity } from '@/services/api'
import { useAuthStore, useThemeStore } from '@/store'
import { useNotifStore } from '@/store/notifStore'
import { useModuleLabels } from '@/context/ModuleLabelsContext'
import { usePermissions } from '@/hooks/Usepermissions'
import { ICO, Ic } from '@/components/crm/kit'
import './Sidebar.css'

interface ModuleNavItem {
  id: number
  key: string
  label: string
  icon: string | null
  route: string
  section: string | null
  sort_order: number
  parent_key: string | null
  permission_key: string | null
  is_active: boolean
  is_system: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lucide icons and prototype ICO icons share { size, className }
type NavIcon = ComponentType<any>

interface NavItem {
  key: string
  path: string
  label: string
  icon: NavIcon
  section: string
  parentKey: string | null
}

interface SectionMeta {
  key: string
  label: string
}

interface SavedOrder {
  sections: string[]
  items: Record<string, string[]>
}

interface SidebarCache {
  modules?: ModuleNavItem[]
  order?: SavedOrder | string[] | null
}

// Bidwise prototype v17 NAV groups (older keys kept for custom modules that still use them)
const DEFAULT_SECTION_META: SectionMeta[] = [
  { key: 'home', label: 'Home' },
  { key: 'main', label: 'Home' },
  { key: 'sales', label: 'Sales' },
  { key: 'finance', label: 'Finance & Field' },
  { key: 'intelligence', label: 'Intelligence' },
  { key: 'automation', label: 'Automation & Control' },
  { key: 'management', label: 'Automation & Control' },
  { key: 'directory', label: 'Directory' },
  { key: 'config', label: 'Directory' },
  { key: 'admin', label: 'Administration' },
]

const DEFAULT_SECTION_ORDER = DEFAULT_SECTION_META.map(section => section.key)
const SECTION_LABEL: Record<string, string> = Object.fromEntries(
  DEFAULT_SECTION_META.map(section => [section.key, section.label]),
)
const SIDEBAR_CACHE_VERSION = 'v5'
const RECYCLE_BIN_PATH = '/recycle-bin'
const RECYCLE_BIN_SECTION = 'admin'

const ICON_MAP: Record<string, LucideIcon> = {
  Activity,
  AlertTriangle,
  BarChart2,
  Bell,
  Brain,
  Briefcase,
  Building2,
  Calendar,
  ClipboardCheck,
  ClipboardList,
  FileText,
  LayoutDashboard,
  LayoutTemplate,
  Mail,
  MailPlus,
  Package,
  PieChart,
  Plane,
  Plug,
  Receipt,
  Settings,
  Settings2,
  Shield,
  ShieldCheck,
  StickyNote,
  Target,
  TrendingUp,
  Trash2,
  Users,
}

// Path-based icon overrides — used when the backend icon name is unset or unrecognised
const PATH_ICON_OVERRIDES: Record<string, NavIcon> = {
  'form-builder': Settings2,
  'letter-management': MailPlus,
}

function normalizeSectionKey(value?: string | null): string {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized || 'main'
}

function getSectionLabel(sectionKey: string): string {
  return SECTION_LABEL[sectionKey]
    ?? sectionKey
      .split(/[_-]/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
}

// Prototype icon set (ICO) first – the module catalogue stores prototype icon names – then the older lucide names.
const PROTO_ICONS: Record<string, NavIcon> = {}
function protoIcon(name: string): NavIcon {
  if (!PROTO_ICONS[name]) {
    const C = ({ size = 16, className = '' }: { size?: number; className?: string }) => <Ic n={name} size={size} className={className} />
    C.displayName = `ProtoIcon(${name})`
    PROTO_ICONS[name] = C
  }
  return PROTO_ICONS[name]
}
function getIcon(iconName?: string | null): NavIcon {
  const name = String(iconName ?? '').trim()
  if (name in ICO) return protoIcon(name)
  return ICON_MAP[name] ?? MapPin
}

function getSectionKeys(items: NavItem[]): string[] {
  const discovered = Array.from(new Set(items.map(item => item.section)))
  return [
    ...DEFAULT_SECTION_ORDER.filter(key => discovered.includes(key)),
    ...discovered.filter(key => !DEFAULT_SECTION_ORDER.includes(key)),
  ]
}

function defaultItemOrder(items: NavItem[]): Record<string, string[]> {
  const order: Record<string, string[]> = {}
  for (const item of items) {
    if (!order[item.section]) {
      order[item.section] = []
    }
    order[item.section].push(item.path)
  }
  for (const sectionKey of Object.keys(order)) {
    order[sectionKey] = putRecycleBinLast(order[sectionKey])
  }
  return order
}

function putRecycleBinLast(paths: string[]): string[] {
  if (!paths.includes(RECYCLE_BIN_PATH)) return paths
  return [
    ...paths.filter(path => path !== RECYCLE_BIN_PATH),
    RECYCLE_BIN_PATH,
  ]
}

function parseSaved(raw: unknown): SavedOrder | string[] | null {
  if (!raw) return null
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (Array.isArray(parsed)) return parsed as string[]
    if (
      parsed
      && typeof parsed === 'object'
      && Array.isArray((parsed as SavedOrder).sections)
      && (parsed as SavedOrder).items
      && typeof (parsed as SavedOrder).items === 'object'
    ) {
      return parsed as SavedOrder
    }
  } catch {}
  return null
}

function buildSavedOrder(saved: SavedOrder | string[] | null, items: NavItem[]): SavedOrder {
  // Orders saved for the old Main / Sales Activities / Management layout predate the prototype groups:
  // start those users from the prototype order once (a new drag saves a fresh order).
  if (saved && (Array.isArray(saved) || !saved.sections.includes('home'))) saved = null
  const sectionKeys = getSectionKeys(items)
  const baseItems = defaultItemOrder(items)

  if (Array.isArray(saved)) {
    const mergedItems: Record<string, string[]> = {}
    for (const sectionKey of sectionKeys) {
      const allPaths = baseItems[sectionKey] ?? []
      const savedPaths = saved.filter(path => allPaths.includes(path))
      mergedItems[sectionKey] = [
        ...savedPaths,
        ...allPaths.filter(path => !savedPaths.includes(path)),
      ]
      mergedItems[sectionKey] = putRecycleBinLast(mergedItems[sectionKey])
    }
    return { sections: sectionKeys, items: mergedItems }
  }

  if (saved) {
    const mergedSections = [
      ...saved.sections.filter(sectionKey => sectionKeys.includes(sectionKey)),
      ...sectionKeys.filter(sectionKey => !saved.sections.includes(sectionKey)),
    ]
    const mergedItems: Record<string, string[]> = {}
    for (const sectionKey of sectionKeys) {
      const allPaths = baseItems[sectionKey] ?? []
      const savedPaths = (saved.items?.[sectionKey] ?? []) as string[]
      mergedItems[sectionKey] = withNewItemsInPlace(savedPaths.filter(path => allPaths.includes(path)), allPaths)
      mergedItems[sectionKey] = putRecycleBinLast(mergedItems[sectionKey])
    }
    return { sections: mergedSections, items: mergedItems }
  }

  return { sections: sectionKeys, items: baseItems }
}

/** Keep the user's saved order, and slot menu items added since then in at their default place (after the item
 *  that precedes them in the default order) instead of at the end of the group. */
function withNewItemsInPlace(saved: string[], defaults: string[]): string[] {
  const out = [...saved]
  defaults.forEach((path, i) => {
    if (out.includes(path)) return
    const prev = defaults.slice(0, i).reverse().find(p => out.includes(p))
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, path)
  })
  return out
}

function reorder<T>(arr: T[], fromIdx: number, toIdx: number): T[] {
  const next = [...arr]
  const [item] = next.splice(fromIdx, 1)
  next.splice(toIdx, 0, item)
  return next
}

// Reached from the footer bar's floating Team Chat widget, not a sidebar page — stays a
// normal, active module server-side (so Roles & Permissions can still manage its
// permissions) and is only excluded from the nav list here.
const SIDEBAR_HIDDEN_MODULE_KEYS = new Set(['team_chat'])

function mapModulesToNavItems(rows: ModuleNavItem[]): NavItem[] {
  return rows
    .filter(row => row && row.route && row.label && !SIDEBAR_HIDDEN_MODULE_KEYS.has(row.key))
    .map(row => ({
      key: row.key,
      path: row.route,
      label: row.label,
      icon: String(row.icon ?? '').trim() in ICO ? getIcon(row.icon) : (PATH_ICON_OVERRIDES[row.route] ?? getIcon(row.icon)),
      section: row.key === 'recycle_bin' ? RECYCLE_BIN_SECTION : normalizeSectionKey(row.section),
      parentKey: row.parent_key,
    }))
}

function getSidebarCacheKey(tenantSlug?: string | null, userId?: number | string | null): string | null {
  const slug = String(tenantSlug || localStorage.getItem('tenant_slug') || '').trim()
  const id = userId == null ? '' : String(userId).trim()
  return slug && id ? `crm_sidebar:${SIDEBAR_CACHE_VERSION}:${slug}:${id}` : null
}

function readSidebarCache(cacheKey: string | null): SidebarCache | null {
  if (!cacheKey) return null
  try {
    const parsed = JSON.parse(localStorage.getItem(cacheKey) || 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as SidebarCache
  } catch {
    return null
  }
}

function writeSidebarCache(cacheKey: string | null, patch: SidebarCache): void {
  if (!cacheKey) return
  try {
    const current = readSidebarCache(cacheKey) || {}
    localStorage.setItem(cacheKey, JSON.stringify({ ...current, ...patch }))
  } catch {
    // Sidebar should keep working even if localStorage is unavailable.
  }
}

function useSaveDebounced(cacheKey: string | null) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  return useCallback((sections: string[], items: Record<string, string[]>) => {
    writeSidebarCache(cacheKey, { order: { sections, items } })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      api.put('/dashboard/sidebar-order', { order: { sections, items } }).catch(() => {})
    }, 700)
  }, [cacheKey])
}

function NavItemLink({
  item, collapsed, badge, onMarkSeen, onNavClick,
}: {
  item: NavItem
  collapsed: boolean
  badge?: number
  onMarkSeen?: () => void
  onNavClick?: () => void
}) {
  const location = useLocation()
  const [hoverPos, setHoverPos] = useState<{ top: number; left: number } | null>(null)
  const isActive = location.pathname === item.path || location.pathname.startsWith(item.path + '/')
  const Icon = item.icon

  useEffect(() => {
    setHoverPos(null)
  }, [location.pathname, collapsed])

  useEffect(() => {
    if (!hoverPos) return
    const clear = () => setHoverPos(null)
    window.addEventListener('pointerdown', clear, true)
    window.addEventListener('keydown', clear, true)
    window.addEventListener('scroll', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('pointerdown', clear, true)
      window.removeEventListener('keydown', clear, true)
      window.removeEventListener('scroll', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [hoverPos])

  return (
    <>
      <NavLink
        to={item.path}
        onMouseEnter={event => {
          if (!collapsed) return
          const rect = event.currentTarget.getBoundingClientRect()
          setHoverPos({ top: rect.top + rect.height / 2, left: rect.right + 10 })
        }}
        onMouseLeave={() => setHoverPos(null)}
        onPointerDown={() => setHoverPos(null)}
        onClick={() => {
          setHoverPos(null)
          if (badge && badge > 0) onMarkSeen?.()
          onNavClick?.()
        }}
        className={[
          'app-sidebar-link flex-1 min-w-0 select-none',
          isActive ? 'is-active' : '',
          collapsed ? 'is-collapsed' : '',
        ].join(' ')}
      >
        <Icon size={16} className="flex-shrink-0" />
        {!collapsed && <span className="truncate flex-1">{item.label}</span>}
        {badge != null && badge > 0 && (
          <span
            className={[
              'app-sidebar-badge',
              collapsed ? 'is-collapsed' : '',
            ].join(' ')}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </NavLink>
      {collapsed && hoverPos && createPortal((
        <div
          className="app-sidebar-hover-pill"
          style={{ top: hoverPos.top, left: hoverPos.left }}
        >
          <span>{item.label}</span>
          {badge != null && badge > 0 && (
            <span className="app-sidebar-hover-badge">{badge > 99 ? '99+' : badge}</span>
          )}
        </div>
      ), document.body)}
    </>
  )
}

export default function Sidebar({
  collapsed,
  mobileOpen = false,
  onMobileClose,
}: {
  collapsed: boolean
  mobileOpen?: boolean
  onMobileClose?: () => void
}) {
  const [loaded, setLoaded] = useState(false)
  const [navItems, setNavItems] = useState<NavItem[]>([])
  const [sectionOrder, setSectionOrder] = useState<string[]>(DEFAULT_SECTION_ORDER)
  const [itemOrder, setItemOrder] = useState<Record<string, string[]>>({})
  const [logoFailed, setLogoFailed] = useState(false)
  const [dropSec, setDropSec] = useState<string | null>(null)
  const [dropItem, setDropItem] = useState<string | null>(null)

  // Track whether we're in mobile viewport — sidebar is always expanded on mobile (drawer mode)
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // On mobile the sidebar is always shown expanded regardless of the desktop collapsed state
  const effectiveCollapsed = isMobile ? false : collapsed

  const { getLabel, setLabel, resetLabel } = useModuleLabels()
  const { can } = usePermissions()
  // Allow rename if they have the dedicated permission OR settings.manage (admin fallback)
  const canRename = can('modules.rename') || can('settings.manage')

  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editValueRef = useRef(editValue)
  editValueRef.current = editValue
  const editInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingKey && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingKey])

  const startEdit = useCallback((item: NavItem) => {
    if (!canRename) return
    setEditValue(getLabel(item.key, item.label))
    setEditingKey(item.key)
  }, [canRename, getLabel])

  const confirmEdit = useCallback((itemKey: string, defaultLabel: string) => {
    const trimmed = editValueRef.current.trim()
    if (trimmed && trimmed !== defaultLabel) {
      setLabel(itemKey, trimmed)
    } else if (!trimmed) {
      resetLabel(itemKey)
    }
    setEditingKey(null)
  }, [setLabel, resetLabel])

  const cancelEdit = useCallback(() => setEditingKey(null), [])

  const theme = useThemeStore(state => state.theme)
  const tenantSlug = useAuthStore(state => state.tenant_slug)
  const userId = useAuthStore(state => state.user?.id)
  const sidebarCacheKey = getSidebarCacheKey(tenantSlug, userId)
  const saveDebounced = useSaveDebounced(sidebarCacheKey)
  const companyName = theme.company_name?.trim() || ''
  const logoSrc = buildThemeLogoUrl({
    theme_logo: theme.theme_logo,
    theme_logo_version: theme.theme_logo_version,
    logo_url: theme.logo_url,
  })
  const companyInitial = companyName.charAt(0).toUpperCase() || 'D'

  useEffect(() => {
    setLogoFailed(false)
  }, [logoSrc])

  useEffect(() => {
    let active = true
    let latestOrder: SavedOrder | string[] | null = null
    let latestItems: NavItem[] = []

    const applySidebar = (items: NavItem[], rawOrder: unknown) => {
      const savedOrder = buildSavedOrder(parseSaved(rawOrder), items)
      setNavItems(items)
      setSectionOrder(savedOrder.sections)
      setItemOrder(savedOrder.items)
      setLoaded(true)
    }

    const cached = readSidebarCache(sidebarCacheKey)
    if (Array.isArray(cached?.modules) && cached.modules.length) {
      latestOrder = cached.order ?? null
      latestItems = mapModulesToNavItems(cached.modules)
      applySidebar(latestItems, latestOrder)
    } else {
      setLoaded(false)
      setNavItems([])
      setSectionOrder(DEFAULT_SECTION_ORDER)
      setItemOrder({})
    }

    api.get('/modules', withPassiveSessionActivity({}))
      .then((modulesRes) => {
        if (!active) return
        const modules = Array.isArray(modulesRes.data) ? modulesRes.data : []
        latestItems = mapModulesToNavItems(modules)
        writeSidebarCache(sidebarCacheKey, { modules })
        applySidebar(latestItems, latestOrder)
      })
      .catch(() => {
        if (!active) return
        if (!latestItems.length) {
          setNavItems([])
          setSectionOrder(DEFAULT_SECTION_ORDER)
          setItemOrder({})
          setLoaded(true)
        }
      })

    api.get('/dashboard/sidebar-order', withPassiveSessionActivity({}))
      .then((orderRes) => {
        if (!active) return
        latestOrder = orderRes.data?.order ?? null
        writeSidebarCache(sidebarCacheKey, { order: latestOrder })
        if (latestItems.length) {
          const savedOrder = buildSavedOrder(parseSaved(latestOrder), latestItems)
          setSectionOrder(savedOrder.sections)
          setItemOrder(savedOrder.items)
        }
      })
      .catch(() => {})

    return () => {
      active = false
    }
  }, [sidebarCacheKey])

  const [badges, setBadges] = useState<Record<string, number>>({})
  useEffect(() => {
    const fetchBadges = async () => {
      try {
        const { data } = await api.get('/dashboard/badges', withPassiveSessionActivity({}))
        setBadges({
          '/customers':  data.customers  ?? 0,
          '/leads':      data.leads      ?? 0,
          '/tenders':    data.tenders    ?? 0,
          '/workorders': data.workorders ?? 0,
          '/emdbg':      data.emdbg      ?? 0,
          '/approvals':  data.approvals  ?? 0,
          '/alerts':     data.alerts     ?? 0,
        })
        if (typeof data.notifications === 'number') {
          useNotifStore.getState().setUnread(data.notifications)
        }
      } catch {}
    }

    const firstFetch = window.setTimeout(fetchBadges, 1500)
    const id = window.setInterval(fetchBadges, 45_000)
    return () => {
      window.clearTimeout(firstFetch)
      window.clearInterval(id)
    }
  }, [])

  const markSeenEndpoints: Record<string, string> = {
    '/customers': '/customers/mark-seen',
    '/leads': '/leads/mark-seen',
    '/tenders': '/tenders/mark-seen',
    '/workorders': '/workorders/mark-seen',
    '/emdbg': '/emdbg/mark-seen',
    '/approvals': '/approvals/mark-seen',
    '/alerts': '/alerts/mark-seen',
  }

  const handleMarkSeen = useCallback((path: string) => {
    const endpoint = markSeenEndpoints[path]
    if (!endpoint) return
    setBadges(prev => ({ ...prev, [path]: 0 }))
    api.post(endpoint).catch(() => {})
  }, [])

  const dragType = useRef<'section' | 'item' | null>(null)
  const dragSecKey = useRef<string | null>(null)
  const dragItmPath = useRef<string | null>(null)
  const dragItmSec = useRef<string | null>(null)
  const secOrderRef = useRef(sectionOrder)
  const itemOrderRef = useRef(itemOrder)

  useEffect(() => {
    secOrderRef.current = sectionOrder
  }, [sectionOrder])

  useEffect(() => {
    itemOrderRef.current = itemOrder
  }, [itemOrder])

  const baseItemOrder = defaultItemOrder(navItems)
  const sectionKeys = getSectionKeys(navItems)
  const resolvedSectionOrder = [
    ...sectionOrder.filter(key => sectionKeys.includes(key)),
    ...sectionKeys.filter(key => !sectionOrder.includes(key)),
  ]
  const navItemByPath = new Map(navItems.map(item => [item.path, item]))

  const sections = resolvedSectionOrder
    .map(key => {
      const orderedPaths = itemOrder[key] ?? baseItemOrder[key] ?? []
      const items = orderedPaths
        .map(path => navItemByPath.get(path))
        .filter((item): item is NavItem => Boolean(item))
      return { key, label: getSectionLabel(key), items }
    })
    .filter(section => section.items.length > 0)

  const handleSecDragStart = (key: string, event: DragEvent) => {
    event.stopPropagation()
    dragType.current = 'section'
    dragSecKey.current = key
    setDropSec(key)
  }

  const handleSecDragEnter = (key: string, event: DragEvent) => {
    event.preventDefault()
    if (dragType.current !== 'section') return
    if (!dragSecKey.current || dragSecKey.current === key) return

    const currentOrder = secOrderRef.current
    const from = currentOrder.indexOf(dragSecKey.current)
    const to = currentOrder.indexOf(key)
    if (from === -1 || to === -1) return

    setSectionOrder(reorder(currentOrder, from, to))
    setDropSec(key)
  }

  const handleSecDragEnd = () => {
    dragType.current = null
    dragSecKey.current = null
    setDropSec(null)
    saveDebounced(secOrderRef.current, itemOrderRef.current)
  }

  const handleItemDragStart = (secKey: string, path: string, event: DragEvent) => {
    event.stopPropagation()
    dragType.current = 'item'
    dragItmPath.current = path
    dragItmSec.current = secKey
    setDropItem(path)
  }

  const handleItemDragEnter = (secKey: string, path: string, event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (dragType.current !== 'item') return
    if (!dragItmPath.current || dragItmPath.current === path) return
    if (dragItmSec.current !== secKey) return

    const currentItems = itemOrderRef.current[secKey] ?? []
    const from = currentItems.indexOf(dragItmPath.current)
    const to = currentItems.indexOf(path)
    if (from === -1 || to === -1) return

    setItemOrder(prev => ({ ...prev, [secKey]: reorder(currentItems, from, to) }))
    setDropItem(path)
  }

  const handleItemDragEnd = (event: DragEvent) => {
    event.stopPropagation()
    dragType.current = null
    dragItmPath.current = null
    dragItmSec.current = null
    setDropItem(null)
    saveDebounced(secOrderRef.current, itemOrderRef.current)
  }

  return (
    <aside
      className={[
        'app-sidebar flex flex-col flex-shrink-0 h-screen',
        // Mobile: fixed overlay drawer; Desktop: sticky in flex row
        'fixed md:sticky top-0 left-0 z-[95] md:z-auto',
        // Slide in/out on mobile; always visible on desktop
        mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        'transition-all duration-300',
        // Width: always 220px on mobile (drawer), respect collapsed on desktop
        effectiveCollapsed ? 'w-[60px]' : 'w-[220px]',
      ].join(' ')}
    >
      <div
        className={`app-sidebar-brand h-14 flex items-center gap-2 px-3 py-2 border-b border-white/[0.08] flex-shrink-0
          ${effectiveCollapsed ? 'justify-center px-0' : ''}`}
      >
        <div
          className="app-sidebar-logo w-8 h-8 rounded-xl flex items-center justify-center overflow-hidden font-black text-white text-[11px] flex-shrink-0"
          style={{ background: logoSrc && !logoFailed ? 'rgba(255,255,255,0.96)' : 'var(--color-accent)' }}
        >
          {logoSrc && !logoFailed ? (
            <img
              src={logoSrc}
              alt={`${companyName} logo`}
              className="w-full h-full object-contain p-0.5"
              onError={() => setLogoFailed(true)}
            />
          ) : (
            companyInitial
          )}
        </div>
        {!effectiveCollapsed && (
          <div className="min-w-0 flex-1 pr-1">
            <p className="app-sidebar-company-name text-[16px] font-bold leading-tight whitespace-normal break-words">
              <span className="app-sidebar-company-name-primary">Azcentrix</span>
              <span className="app-sidebar-company-name-accent">Connect</span>
            </p>
          </div>
        )}
      </div>

      <nav
        className="app-sidebar-nav flex-1 overflow-y-auto"
        onDragOver={event => event.preventDefault()}
      >
        {!loaded && (
          <div className="px-3 space-y-1 pt-1">
            {[...Array(8)].map((_, index) => (
              <div key={index} className="h-8 rounded-xl bg-white/5 animate-pulse" />
            ))}
          </div>
        )}

        {loaded && sections.map((section, sectionIndex) => (
          <div
            key={section.key}
            draggable={!effectiveCollapsed}
            onDragStart={event => handleSecDragStart(section.key, event)}
            onDragEnter={event => handleSecDragEnter(section.key, event)}
            onDragOver={event => event.preventDefault()}
            onDragEnd={handleSecDragEnd}
            className={[
              'transition-all duration-150',
              dropSec === section.key && dragType.current === 'section' && !effectiveCollapsed
                ? 'ring-1 ring-inset ring-white/15 rounded-xl bg-white/[0.03]'
                : '',
            ].join(' ')}
          >
            {!effectiveCollapsed && section.label && (
              <div
                className={`flex items-center gap-1.5 px-2 pb-1 group/sec
                  ${sectionIndex === 0 ? 'pt-2' : 'pt-4'}`}
              >
                <GripVertical
                  size={11}
                  className="app-sidebar-grip flex-shrink-0 cursor-grab active:cursor-grabbing opacity-0 group-hover/sec:opacity-100 transition-opacity"
                />
                <p className="app-sidebar-section-label truncate select-none">
                  {section.label}
                </p>
              </div>
            )}

            {effectiveCollapsed && sectionIndex > 0 && (
              <div className="app-sidebar-separator" />
            )}

            {section.items.map(item => {
              const isEditing = editingKey === item.key && !effectiveCollapsed
              const effectiveItem = { ...item, label: getLabel(item.key, item.label) }
              return (
                <div
                  key={item.path}
                  draggable={!effectiveCollapsed && !isEditing}
                  onDragStart={event => !isEditing && handleItemDragStart(section.key, item.path, event)}
                  onDragEnter={event => !isEditing && handleItemDragEnter(section.key, item.path, event)}
                  onDragOver={event => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onDragEnd={event => !isEditing && handleItemDragEnd(event)}
                  onDoubleClick={e => {
                    if (!canRename || effectiveCollapsed) return
                    e.preventDefault()
                    e.stopPropagation()
                    startEdit(item)
                  }}
                  title={canRename && !effectiveCollapsed ? 'Double-click to rename' : undefined}
                  className={[
                    'app-sidebar-item-shell group/item',
                    dropItem === item.path && dragType.current === 'item'
                      ? 'ring-1 ring-white/20 bg-white/[0.05]'
                      : '',
                  ].join(' ')}
                >
                  {isEditing ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onBlur={() => confirmEdit(item.key, item.label)}
                      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === 'Enter') { e.preventDefault(); confirmEdit(item.key, item.label) }
                        if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                        e.stopPropagation()
                      }}
                      style={{ color: '#0f172a', background: 'rgba(0,0,0,0.06)', border: '1px solid rgba(99,102,241,0.5)', outline: 'none' }}
                      className="flex-1 min-w-0 mx-2 my-0.5 px-2 py-1 text-[12px] rounded-lg"
                      placeholder={item.label}
                    />
                  ) : (
                    <>
                      {!effectiveCollapsed && (
                        <GripVertical
                          size={11}
                          className="app-sidebar-grip flex-shrink-0 cursor-grab active:cursor-grabbing ml-1 opacity-0 group-hover/item:opacity-100 transition-opacity"
                        />
                      )}
                      <NavItemLink
                        item={effectiveItem}
                        collapsed={effectiveCollapsed}
                        badge={badges[item.path] || undefined}
                        onMarkSeen={() => handleMarkSeen(item.path)}
                        onNavClick={onMobileClose}
                      />
                    </>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </nav>
    </aside>
  )
}
