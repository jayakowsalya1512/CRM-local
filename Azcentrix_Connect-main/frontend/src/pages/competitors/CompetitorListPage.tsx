import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  Building2,
  CreditCard,
  Edit2,
  Eye,
  Factory,
  FileText,
  Globe,
  Hash,
  Mail,
  MapPin,
  MoreVertical,
  Phone,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Target,
  Trash2,
  X,
} from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import DataTable, { type Column } from '@/components/ui/DataTable'
import { ConfirmDialog, PageHeader, StatCard, useToast } from '@/components/ui/FormComponents'
import { usePermissions } from '@/hooks'
import { useModuleName } from '@/context/ModuleLabelsContext'

interface Competitor {
  [key: string]: unknown
  id: number
  name: string
  registration_type?: string | null
  registration_year?: string | null
  country?: string | null
  state?: string | null
  district?: string | null
  city?: string | null
  address?: string | null
  pincode?: string | null
  mobile_no?: string | null
  gst_no?: string | null
  pan_no?: string | null
  email?: string | null
  company_type?: string | null
  directors?: string | null
  manpower_strength?: string | null
  website?: string | null
  strengths?: string | null
  weaknesses?: string | null
  threat_level?: string | null
  market_reputation?: string | null
  oem_partnerships?: string | null
  strong_regions?: string | null
  strong_departments?: string | null
  annual_turnover?: string | null
  support_quality?: string | null
  internal_notes?: string | null
}

function parseMultiValue(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return Array.from(new Set(parsed.map(item => String(item).trim()).filter(Boolean)))
      }
    } catch {
      // Legacy text values fall through to delimited parsing.
    }
  }

  return Array.from(new Set(trimmed.split(/[,;\n]+/).map(item => item.trim()).filter(Boolean)))
}

function displayValue(value: unknown) {
  const text = String(value ?? '').trim()
  return text || '-'
}

function compactInitials(value: string) {
  return value
    .split(/\s+/)
    .map(part => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || 'CO'
}

function ChipList({ label, value }: { label: string; value?: string | null }) {
  const items = parseMultiValue(String(value || ''))
  return (
    <div>
      <p className="text-xs font-medium text-gray-400">{label}</p>
      {items.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {items.map(item => (
            <span key={item} className="px-2 py-1 rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
              {item}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-sm font-semibold text-gray-800">-</p>
      )}
    </div>
  )
}

function DetailRow({ icon, label, value, iconBg = 'bg-slate-100', iconColor = 'text-slate-500', link }: {
  icon: ReactNode
  label: string
  value: unknown
  iconBg?: string
  iconColor?: string
  link?: string
}) {
  const text = displayValue(value)
  if (text === '-') return null

  return (
    <div className="flex items-center gap-3">
      <div className={`w-8 h-8 rounded-lg ${iconBg} flex items-center justify-center flex-shrink-0 ${iconColor}`}>{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-400 mb-0.5">{label}</p>
        {link ? (
          <a href={link} target={link.startsWith('http') ? '_blank' : undefined} rel="noreferrer" className="text-sm font-medium text-blue-600 hover:underline truncate block">
            {text}
          </a>
        ) : (
          <p className="text-sm font-medium text-slate-800 break-words">{text}</p>
        )}
      </div>
    </div>
  )
}

function QuickSection({ title, icon, children, accent = 'slate' }: {
  title: string
  icon?: ReactNode
  children: ReactNode
  accent?: 'slate' | 'blue' | 'amber'
}) {
  const header = {
    slate: 'border-slate-50 text-slate-500',
    blue: 'bg-blue-600 text-white border-blue-600',
    amber: 'border-amber-100 text-amber-700',
  }[accent]

  return (
    <div className={`mx-4 mt-3 bg-white rounded-2xl border shadow-sm overflow-hidden ${accent === 'amber' ? 'border-amber-100 bg-amber-50' : 'border-slate-100'}`}>
      <div className={`px-4 py-2.5 border-b flex items-center gap-2 ${header}`}>
        {icon}
        <p className="text-xs font-bold uppercase tracking-wider">{title}</p>
      </div>
      <div className="p-4 space-y-3">
        {children}
      </div>
    </div>
  )
}

// ── Quick View Panel ──────────────────────────────────────────────────────────
// Uses singular label from useModuleName so "Edit Competitor" becomes e.g.
// "Edit Rival" if the tenant renames the module.
function CompetitorQuickViewPanel({ competitor, canUpdate, onClose, onEdit, singular }: {
  competitor: Competitor | null
  canUpdate: boolean
  onClose: () => void
  onEdit: (row: Competitor) => void
  singular: string
}) {
  if (!competitor) return null

  const initials = compactInitials(competitor.name)
  const location = [competitor.city, competitor.district, competitor.state].filter(Boolean).join(', ')
  const address = [competitor.address, competitor.city, competitor.district, competitor.state, competitor.country, competitor.pincode].filter(Boolean).join(', ')
  const website = competitor.website
    ? String(competitor.website).startsWith('http')
      ? String(competitor.website)
      : `https://${competitor.website}`
    : ''
  const threatCfg: Record<string, string> = {
    Low: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    Medium: 'bg-amber-100 text-amber-700 border-amber-200',
    High: 'bg-rose-100 text-rose-700 border-rose-200',
    Critical: 'bg-red-100 text-red-700 border-red-200',
  }
  const threatClass = threatCfg[String(competitor.threat_level || '')] || 'bg-slate-100 text-slate-600 border-slate-200'

  return (
    <div className="fixed inset-0 z-[85] flex" style={{ left: 'var(--sidebar-w)' }}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="relative ml-auto w-full sm:max-w-[470px] bg-slate-50 h-full flex flex-col shadow-2xl">
        <div className="flex-shrink-0 bg-gradient-to-br from-slate-800 via-slate-800 to-slate-900 px-6 pt-5 pb-7">
          <div className="flex items-center justify-between mb-5">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border bg-emerald-100 text-emerald-700 border-emerald-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Active
            </span>
            <div className="flex items-center gap-1.5">
              {canUpdate && (
                <button
                  type="button"
                  onClick={() => { onClose(); setTimeout(() => onEdit(competitor), 100) }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-semibold text-white transition-colors"
                >
                  <Edit2 size={12} /> Edit
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/70 hover:text-white transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-400 to-indigo-600 flex items-center justify-center text-xl font-extrabold text-white flex-shrink-0 shadow-lg ring-4 ring-white/10">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold text-white leading-tight truncate">{competitor.name}</h2>
              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                {competitor.registration_type && (
                  <span className="text-xs bg-white/15 text-white/90 px-2 py-0.5 rounded-full font-medium">{competitor.registration_type}</span>
                )}
                {competitor.threat_level && (
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold border ${threatClass}`}>
                    {competitor.threat_level}
                  </span>
                )}
              </div>
              {location && (
                <div className="flex items-center gap-1 mt-1.5">
                  <MapPin size={11} className="text-slate-400 flex-shrink-0" />
                  <span className="text-xs text-slate-400 truncate">{location}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto -mt-3 pb-24">
          <QuickSection title="Primary Contact" icon={<Phone size={12} className="text-blue-100" />} accent="blue">
            <div className="space-y-2">
              {competitor.mobile_no && (
                <a href={`tel:${competitor.mobile_no}`} className="flex items-center gap-2.5 px-3 py-2 bg-slate-50 rounded-xl hover:bg-emerald-50 transition-colors group">
                  <span className="w-7 h-7 rounded-lg bg-emerald-100 flex items-center justify-center flex-shrink-0">
                    <Phone size={13} className="text-emerald-600" />
                  </span>
                  <span className="text-sm font-medium text-slate-700 group-hover:text-emerald-700">{competitor.mobile_no}</span>
                </a>
              )}
              {competitor.email && (
                <a href={`mailto:${competitor.email}`} className="flex items-center gap-2.5 px-3 py-2 bg-slate-50 rounded-xl hover:bg-blue-50 transition-colors group">
                  <span className="w-7 h-7 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                    <Mail size={13} className="text-blue-600" />
                  </span>
                  <span className="text-sm font-medium text-slate-700 group-hover:text-blue-700 truncate">{competitor.email}</span>
                </a>
              )}
              {!competitor.mobile_no && !competitor.email && (
                <p className="text-sm text-slate-500">No contact details added</p>
              )}
            </div>
          </QuickSection>

          <QuickSection title="Company Details">
            <DetailRow icon={<Factory size={13} />} label="Company Type" value={competitor.company_type} iconBg="bg-violet-100" iconColor="text-violet-600" />
            <DetailRow icon={<Hash size={13} />} label="Registration" value={[competitor.registration_type, competitor.registration_year].filter(Boolean).join(' / ')} />
            <DetailRow icon={<CreditCard size={13} />} label="GST Number" value={competitor.gst_no} />
            <DetailRow icon={<CreditCard size={13} />} label="PAN Number" value={competitor.pan_no} />
            <DetailRow icon={<Target size={13} />} label="Manpower Strength" value={competitor.manpower_strength} iconBg="bg-sky-100" iconColor="text-sky-600" />
            <DetailRow icon={<Globe size={13} />} label="Website" value={competitor.website} iconBg="bg-blue-100" iconColor="text-blue-600" link={website} />
          </QuickSection>

          <QuickSection title="Market Intelligence">
            <DetailRow icon={<ShieldAlert size={13} />} label="Threat Level" value={competitor.threat_level} iconBg="bg-amber-100" iconColor="text-amber-600" />
            <DetailRow icon={<Sparkles size={13} />} label="Market Reputation" value={competitor.market_reputation} iconBg="bg-blue-100" iconColor="text-blue-600" />
            <DetailRow icon={<Phone size={13} />} label="Support Quality" value={competitor.support_quality} iconBg="bg-emerald-100" iconColor="text-emerald-600" />
            <DetailRow icon={<CreditCard size={13} />} label="Annual Turnover" value={competitor.annual_turnover} iconBg="bg-emerald-100" iconColor="text-emerald-600" />
          </QuickSection>

          {(competitor.oem_partnerships || competitor.strong_regions || competitor.strong_departments) && (
            <QuickSection title="Competitive Coverage">
              <ChipList label="OEM Partnerships" value={competitor.oem_partnerships} />
              <ChipList label="Strong Regions" value={competitor.strong_regions} />
              <ChipList label="Strong Departments" value={competitor.strong_departments} />
            </QuickSection>
          )}

          {address && (
            <QuickSection title="Address" icon={<MapPin size={12} className="text-slate-400" />}>
              <p className="text-sm text-slate-700 leading-relaxed">{address}</p>
            </QuickSection>
          )}

          {(competitor.directors || competitor.strengths || competitor.weaknesses || competitor.internal_notes) && (
            <QuickSection title="Notes" icon={<FileText size={12} className="text-amber-500" />} accent="amber">
              {competitor.directors && (
                <div>
                  <p className="text-xs font-bold text-amber-700 uppercase tracking-wider">Directors</p>
                  <p className="mt-1 text-sm text-amber-900 leading-relaxed">{competitor.directors}</p>
                </div>
              )}
              {competitor.strengths && (
                <div>
                  <p className="text-xs font-bold text-amber-700 uppercase tracking-wider">Strengths</p>
                  <p className="mt-1 text-sm text-amber-900 leading-relaxed">{competitor.strengths}</p>
                </div>
              )}
              {competitor.weaknesses && (
                <div>
                  <p className="text-xs font-bold text-amber-700 uppercase tracking-wider">Weaknesses</p>
                  <p className="mt-1 text-sm text-amber-900 leading-relaxed">{competitor.weaknesses}</p>
                </div>
              )}
              {competitor.internal_notes && (
                <div>
                  <p className="text-xs font-bold text-amber-700 uppercase tracking-wider">Internal Notes</p>
                  <p className="mt-1 text-sm text-amber-900 leading-relaxed">{competitor.internal_notes}</p>
                </div>
              )}
            </QuickSection>
          )}
        </div>

        <div className="flex-shrink-0 bg-white border-t border-slate-100 p-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Close
          </button>
          {canUpdate && (
            <button
              type="button"
              onClick={() => { onClose(); setTimeout(() => onEdit(competitor), 100) }}
              className="flex-1 px-4 py-2.5 rounded-xl bg-slate-900 text-sm font-semibold text-white hover:bg-slate-800 transition-colors flex items-center justify-center gap-2"
            >
              <Edit2 size={14} /> Edit {singular}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ActionMenuItem({ icon, label, iconBg, iconColor, labelColor = 'text-gray-700', onClick, danger = false }: {
  icon: ReactNode
  label: string
  iconBg: string
  iconColor: string
  labelColor?: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-xl text-xs font-medium transition-all ${danger ? 'hover:bg-red-50' : 'hover:bg-gray-50'}`}
    >
      <span className={`w-7 h-7 rounded-xl ${iconBg} flex items-center justify-center flex-shrink-0 ${iconColor}`}>{icon}</span>
      <span className={labelColor}>{label}</span>
    </button>
  )
}

// ── Row Actions ───────────────────────────────────────────────────────────────
// singular prop drives "Edit <Singular>" and "Delete <Singular>" labels.
function RowActions({ row, canUpdate, canDelete, onView, onEdit, onDelete, singular }: {
  row: Competitor
  canUpdate: boolean
  canDelete: boolean
  onView: (row: Competitor) => void
  onEdit: (row: Competitor) => void
  onDelete: (row: Competitor) => void
  singular: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuWidth = 220
  const menuHeight = canUpdate && canDelete ? 214 : canUpdate || canDelete ? 164 : 116

  const reposition = () => {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    const top = rect.bottom + menuHeight > window.innerHeight
      ? rect.top + window.scrollY - menuHeight - 4
      : rect.bottom + window.scrollY + 4
    const left = Math.max(8, Math.min(rect.right + window.scrollX - menuWidth, window.innerWidth - menuWidth - 8))
    setPos({ top, left })
  }

  const toggle = (event: ReactMouseEvent) => {
    event.stopPropagation()
    if (!open) reposition()
    setOpen(prev => !prev)
  }

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const menu = (
    <div
      onMouseDown={event => event.stopPropagation()}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: menuWidth, zIndex: 60 }}
      className="bg-white rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.15)] border border-gray-100 overflow-hidden"
    >
      <div className="px-3 pt-3 pb-2.5 border-b border-gray-100">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
            {compactInitials(row.name)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-gray-800 truncate">{row.name}</p>
            <p className="text-xs text-gray-400 truncate mt-0.5">{[row.city, row.state].filter(Boolean).join(', ') || singular}</p>
          </div>
        </div>
      </div>
      <div className="p-1.5 space-y-0.5">
        <ActionMenuItem
          icon={<Eye size={14} />}
          label="Quick View"
          iconBg="bg-blue-50"
          iconColor="text-blue-600"
          onClick={() => { onView(row); setOpen(false) }}
        />
        {canUpdate && (
          <ActionMenuItem
            icon={<Edit2 size={14} />}
            label={`Edit ${singular}`}
            iconBg="bg-slate-50"
            iconColor="text-slate-600"
            onClick={() => { onEdit(row); setOpen(false) }}
          />
        )}
      </div>
      {canDelete && (
        <>
          <div className="mx-3 border-t border-gray-100" />
          <div className="p-1.5">
            <ActionMenuItem
              icon={<Trash2 size={14} />}
              label={`Delete ${singular}`}
              iconBg="bg-red-50"
              iconColor="text-red-500"
              labelColor="text-red-600"
              onClick={() => { onDelete(row); setOpen(false) }}
              danger
            />
          </div>
        </>
      )}
    </div>
  )

  return (
    <div onClick={event => event.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all ${
          open ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
        }`}
        title={`${singular} actions`}
      >
        <MoreVertical size={15} />
      </button>
      {open && createPortal(menu, document.body)}
    </div>
  )
}

export default function CompetitorListPage() {
  const navigate = useNavigate()
  // ── Module rename ──────────────────────────────────────────────────────────
  // Uses 'competitors' key — register in your ModuleLabelsContext.
  // Default: { label: 'Competitors', singular: 'Competitor', singularLower: 'competitor', labelLower: 'competitors' }
  const { label: moduleLabel, singular, singularLower, labelLower } = useModuleName('competitors')

  const { can } = usePermissions()
  const { success, error: showError } = useToast()
  const [competitors, setCompetitors] = useState<Competitor[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [viewingCompetitor, setViewingCompetitor] = useState<Competitor | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Competitor | null>(null)

  const canCreate = can('competitors.create')
  const canUpdate = can('competitors.update')
  const canDelete = can('competitors.delete')
  const canExport = can('competitors.export')

  const load = async () => {
    setLoading(true)
    try {
      const response = await api.get('/masters/competitors')
      setCompetitors(Array.isArray(response.data) ? response.data : [])
    } catch (e: any) {
      showError(e.response?.data?.detail || `Failed to load ${labelLower}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const openAdd = () => {
    navigate('/competitors/new')
  }

  const openEdit = (row: Competitor) => {
    navigate(`/competitors/${row.id}/edit`, { state: { competitor: row } })
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.delete(`/masters/competitors/${deleteTarget.id}`)
      success(`${singular} deleted`)
      setDeleteTarget(null)
      await load()
    } catch (e: any) {
      showError(e.response?.data?.detail || `Failed to delete ${singularLower}`)
    } finally {
      setDeleting(false)
    }
  }

  const stateCount = useMemo(
    () => new Set(competitors.map(row => row.state?.trim()).filter(Boolean)).size,
    [competitors],
  )

  const columns: Column<Competitor>[] = [
    {
      key: 'name',
      header: singular,
      sortable: true,
      searchable: true,
      minWidth: '220px',
      render: value => <span className="font-semibold text-gray-900">{String(value || '')}</span>,
    },
    { key: 'registration_type', header: 'Registration', sortable: true, searchable: true },
    { key: 'company_type', header: 'Company Type', sortable: true, searchable: true },
    {
      key: 'city',
      header: 'Location',
      sortable: true,
      searchable: true,
      searchKeys: ['city', 'district', 'state', 'country', 'pincode'],
      render: (_value, row) => [row.city, row.district, row.state].filter(Boolean).join(', ') || '-',
    },
    { key: 'mobile_no', header: 'Mobile', searchable: true },
    { key: 'gst_no', header: 'GST No', searchable: true },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      searchable: false,
      width: '56px',
      render: (_value, row) => (
        <RowActions
          row={row}
          canUpdate={canUpdate}
          canDelete={canDelete}
          onView={setViewingCompetitor}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
          singular={singular}
        />
      ),
    },
  ]

  return (
    <div className="p-6">
      <PageHeader
        title={moduleLabel}
        subtitle={`Manage ${singularLower} profiles and market details`}
        breadcrumb={['Configuration', moduleLabel]}
        actions={(
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"
              title={`Refresh ${labelLower}`}
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
            {canCreate && (
              <Button onClick={openAdd} icon={<Plus size={15} />}>
                Add {singular}
              </Button>
            )}
          </div>
        )}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard title={moduleLabel}  value={competitors.length} icon={<Target size={19} />} color="blue" />
        <StatCard title="Profiled"     value={competitors.filter(row => row.registration_type || row.gst_no).length} icon={<Target size={19} />} color="green" />
        <StatCard title="GST Added"    value={competitors.filter(row => row.gst_no).length} icon={<Target size={19} />} color="amber" />
        <StatCard title="States"       value={stateCount} icon={<Target size={19} />} color="purple" />
      </div>

      <DataTable
        columns={columns}
        data={competitors}
        loading={loading}
        keyField="id"
        showSearch
        showExport={canExport}
        showColumnToggle
        exportFilename={labelLower}
        emptyMessage={`No ${labelLower} found`}
        onRowClick={setViewingCompetitor}
        striped
        maxHeight="580px"
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete ${singularLower}?`}
        message={`${deleteTarget?.name || `This ${singularLower}`} will be removed from active ${labelLower} lists.`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      <CompetitorQuickViewPanel
        competitor={viewingCompetitor}
        canUpdate={canUpdate}
        onClose={() => setViewingCompetitor(null)}
        onEdit={openEdit}
        singular={singular}
      />
    </div>
  )
}
