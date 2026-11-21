import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Package, Plus, MoreVertical, Pencil, Trash2, Eye, Phone, Mail, User, Building2, ShieldCheck, CalendarClock, CreditCard, FileText, Tag, BadgeCheck, AlertTriangle, Clock, RefreshCw } from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import DataTable from '@/components/ui/DataTable'
import SlidePanel from '@/components/ui/SlidePanel'
import { PageHeader, StatCard, useToast } from '@/components/ui/FormComponents'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { useUIStore } from '@/store'
import { usePermissions } from '@/hooks'

// ── Action Menu ──────────────────────────────────────────────────────────────
function ActionMenu({
  row,
  onView,
  onEdit,
  onDelete,
  canUpdate,
  canDelete,
}: {
  row: any
  onView: (row: any) => void
  onEdit: (row: any) => void
  onDelete: (row: any) => void
  canUpdate: boolean
  canDelete: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + window.scrollY, left: rect.right - 160 })
    setOpen(o => !o)
  }

  useEffect(() => {
    const close = () => setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  return (
    <div>
      <button
        ref={btnRef}
        onClick={handleClick}
        className="p-2 rounded hover:bg-gray-100 text-gray-600 hover:text-gray-900"
      >
        <MoreVertical size={18} />
      </button>
      {open && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
          className="bg-white border border-gray-200 rounded-lg shadow-xl w-44 py-1"
        >
          <button
            onClick={() => { onView(row); setOpen(false) }}
            className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            <Eye size={14} /> View
          </button>
          {canUpdate && (
            <button
              onClick={() => { onEdit(row); setOpen(false) }}
              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <Pencil size={14} /> Edit
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => { onDelete(row); setOpen(false) }}
              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Delete Confirm Modal ─────────────────────────────────────────────────────
function DeleteModal({
  item,
  onConfirm,
  onCancel,
  loading,
}: {
  item: any
  onConfirm: () => void
  onCancel: () => void
  loading: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm mx-4 p-6">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-red-100 mx-auto mb-4">
          <Trash2 size={22} className="text-red-600" />
        </div>
        <h3 className="text-center text-lg font-semibold text-gray-900">Delete {item?.type || 'Entry'}?</h3>
        <p className="text-center text-sm text-gray-500 mt-1">
          <span className="font-medium text-gray-700">{item?.name}</span> will be removed from the list.
          This action can be undone by an administrator.
        </p>
        <div className="flex gap-3 mt-6">
          <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={loading}>Cancel</Button>
          <Button className="flex-1 !bg-red-600 hover:!bg-red-700" onClick={onConfirm} loading={loading}>Delete</Button>
        </div>
      </div>
    </div>
  )
}

// ── Main List Page ───────────────────────────────────────────────────────────
export default function OEMListPage() {
  const { label: moduleLabel, singular, singularLower } = useModuleName('oems')
  const navigate = useNavigate()
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore()
  const sidebarWasCollapsed = useRef(false)

  const [oems, setOems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [viewingOem, setViewingOem] = useState<any>(null)
  const [viewTab, setViewTab] = useState<'details' | 'contact' | 'notes'>('details')
  const { success, error: showError } = useToast()
  const { can } = usePermissions()
  const canCreate = can('oems.create')
  const canUpdate = can('oems.update')
  const canDelete = can('oems.delete')
  const canExport = can('oems.export')

  const load = async (searchVal = '') => {
    setLoading(true)
    try {
      const params = searchVal ? `?search=${encodeURIComponent(searchVal)}` : ''
      const r = await api.get(`/oems${params}`)
      setOems(r.data)
    } catch (e) {
      console.error(e)
      showError(`Failed to load ${singularLower}s`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleView = (oem: any) => {
    sidebarWasCollapsed.current = sidebarCollapsed
    if (!sidebarCollapsed) setSidebarCollapsed(true)
    setViewingOem(oem)
    setViewTab('details')
  }

  const handleEdit = (oem: any) => {
    navigate(`/oems/${oem.id}/edit`, { state: { oem } })
  }

  const handleOpen = () => {
    navigate('/oems/new')
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.delete(`/oems/${deleteTarget.id}`)
      success(`${deleteTarget.type || 'Entry'} deleted`)
      setDeleteTarget(null)
      load()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  const isDistributor = (row: any) => row.type === 'Distributor'

  const columns = [
    {
      key: 'type', label: 'Type', header: 'Type',
      render: (v: string) => (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          v === 'Distributor' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
        }`}>
          {v || singular}
        </span>
      ),
    },
    { key: 'name', label: 'Name', header: 'Name', render: (v: string) => <span className="font-semibold text-gray-900">{v}</span> },
    { key: 'category', label: 'Category', header: 'Product Category' },
    {
      key: 'contact_name', label: 'Contact', header: 'Contact',
      render: (v: string, row: any) => (
        <div>
          <p className="text-sm font-medium">{v || '—'}</p>
          {row.contact_phone && <p className="text-xs text-gray-400">{row.contact_phone}</p>}
        </div>
      ),
    },
    { key: 'account_manager', label: 'Account Mgr', header: 'Acc Manager' },
    {
      key: 'brands_handled', label: 'Brands Handled', header: 'Brands Handled',
      render: (v: string, row: any) =>
        isDistributor(row)
          ? <span className="text-sm text-gray-700">{v || '—'}</span>
          : <span className="text-gray-300 text-xs">N/A</span>,
    },
    {
      key: 'auth_date', label: 'Auth Expiry', header: 'Expiry Date',
      render: (v: string) => {
        if (!v) return <span className="text-gray-300">—</span>
        const d = new Date(v); const today = new Date()
        const days = Math.ceil((d.getTime() - today.getTime()) / 86400000)
        return (
          <span className={`text-sm font-medium ${days < 0 ? 'text-red-600' : days < 30 ? 'text-amber-600' : 'text-green-600'}`}>
            {v} ({days < 0 ? `${Math.abs(days)}d ago` : `${days}d`})
          </span>
        )
      },
    },
    {
      key: 'credit_limit', label: 'Credit Limit', header: 'Credit Limit',
      render: (v: number) => v
        ? <span className="font-medium">₹{Number(v).toLocaleString('en-IN')}</span>
        : <span className="text-gray-300">—</span>,
    },
    { key: 'payment_terms', label: 'Payment Terms', header: 'Payment Terms' },
    {
      key: 'actions', header: 'Actions', label: '',
      render: (_: any, row: any) => (
        <ActionMenu row={row} onView={handleView} onEdit={handleEdit} onDelete={setDeleteTarget} canUpdate={canUpdate} canDelete={canDelete} />
      ),
    },
  ]

  return (
    <div className="p-6">
      <PageHeader
        title={moduleLabel}
        subtitle={`Manage ${singularLower} authorizations, distributor contacts and credit terms`}
        breadcrumb={[moduleLabel]}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => load()}
              className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
            {canCreate && (
              <Button icon={<Plus size={16} />} onClick={handleOpen}>
                Add {singular}
              </Button>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard title="Total Entries"  value={oems.length} icon={<Package size={20} />} color="blue" />
        <StatCard title="Active Auth"    value={oems.filter(o => o.auth_date && new Date(o.auth_date) > new Date()).length} icon={<Package size={20} />} color="green" />
        <StatCard title="Expiring (30d)" value={oems.filter(o => { if (!o.auth_date) return false; const d = Math.ceil((new Date(o.auth_date).getTime() - Date.now()) / 86400000); return d >= 0 && d <= 30 }).length} icon={<Package size={20} />} color="amber" />
        <StatCard title="Expired"        value={oems.filter(o => o.auth_date && new Date(o.auth_date) < new Date()).length} icon={<Package size={20} />} color="red" />
      </div>

      <Card>
        <DataTable
          columns={columns as any}
          data={oems}
          loading={loading}
          searchable
          compact
          showExport={canExport}
          maxHeight="calc(100vh - 310px)"
          initialPageSize={10}
          pageSizeOptions={[10, 25, 50, 100, 'All']}
          showPaginationWhenSinglePage
        />
      </Card>

      {deleteTarget && (
        <DeleteModal
          item={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          loading={deleting}
        />
      )}

      {/* ── View Panel ───────────────────────────────────────────────────── */}
      {viewingOem && (() => {
        const authDays = viewingOem.auth_date
          ? Math.ceil((new Date(viewingOem.auth_date).getTime() - Date.now()) / 86400000)
          : null
        const expiryStatus = authDays === null ? null
          : authDays < 0   ? 'expired'
          : authDays <= 30 ? 'expiring'
          : 'active'
        const isDistView = viewingOem.type === 'Distributor'
        // Use singular label for non-distributor entries (the renamed module name)
        const entryTypeLabel = isDistView ? 'Distributor' : singular

        return (
          <SlidePanel
            open={!!viewingOem}
            onClose={() => { if (!sidebarWasCollapsed.current) setSidebarCollapsed(false); setViewingOem(null); setViewTab('details') }}
            title={viewingOem.name}
            subtitle={`${isDistView ? 'Distributor' : singular} · ${viewingOem.category || ''}`}
            width="w-full"
            insetLeft="var(--sidebar-w)"
            tabBar={
              <div className="flex -mx-6 px-6">
                {([
                  { id: 'details', label: 'Details' },
                  { id: 'contact', label: 'Contact' },
                  { id: 'notes',   label: 'Notes'   },
                ] as const).map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setViewTab(tab.id)}
                    className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                      viewTab === tab.id
                        ? 'border-blue-600 text-blue-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            }
          >
            <div className="flex-1 flex flex-col gap-4">

              {/* Hero banner */}
              <div className={`rounded-2xl p-5 flex items-center gap-4 ${isDistView ? 'bg-gradient-to-r from-purple-50 to-purple-100/50 border border-purple-200' : 'bg-gradient-to-r from-blue-50 to-blue-100/50 border border-blue-200'}`}>
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-sm ${isDistView ? 'bg-purple-600' : 'bg-blue-600'}`}>
                  <Building2 size={26} className="text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <h3 className="text-lg font-bold text-gray-900 truncate">{viewingOem.name}</h3>
                    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${isDistView ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                      {isDistView ? <Tag size={10}/> : <Package size={10}/>} {entryTypeLabel}
                    </span>
                    {expiryStatus === 'active'   && <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700"><BadgeCheck size={10}/> Active</span>}
                    {expiryStatus === 'expiring' && <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700"><AlertTriangle size={10}/> Expiring Soon</span>}
                    {expiryStatus === 'expired'  && <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700"><AlertTriangle size={10}/> Expired</span>}
                  </div>
                  <p className="text-sm text-gray-500">{viewingOem.category || '—'}</p>
                </div>
              </div>

              {/* Details tab */}
              {viewTab === 'details' && (
                <div className="flex flex-col gap-4">
                  {/* Key metrics row */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-white border border-gray-100 rounded-xl p-3.5 flex flex-col gap-1 shadow-sm">
                      <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-0.5"><CreditCard size={12}/> Credit Limit</div>
                      <p className="text-base font-bold text-gray-900">
                        {viewingOem.credit_limit ? `₹${Number(viewingOem.credit_limit).toLocaleString('en-IN')}` : <span className="text-gray-400 font-normal text-sm italic">Not set</span>}
                      </p>
                    </div>
                    <div className="bg-white border border-gray-100 rounded-xl p-3.5 flex flex-col gap-1 shadow-sm">
                      <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-0.5"><CalendarClock size={12}/> Auth Expiry</div>
                      {authDays === null
                        ? <p className="text-sm text-gray-400 italic">Not set</p>
                        : <>
                            <p className={`text-sm font-bold ${authDays < 0 ? 'text-red-600' : authDays <= 30 ? 'text-amber-600' : 'text-green-600'}`}>
                              {new Date(viewingOem.auth_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                            </p>
                            <p className={`text-xs font-medium ${authDays < 0 ? 'text-red-500' : authDays <= 30 ? 'text-amber-500' : 'text-green-500'}`}>
                              {authDays < 0 ? `${Math.abs(authDays)}d overdue` : `${authDays}d remaining`}
                            </p>
                          </>
                      }
                    </div>
                    <div className="bg-white border border-gray-100 rounded-xl p-3.5 flex flex-col gap-1 shadow-sm">
                      <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-0.5"><Clock size={12}/> Support SLA</div>
                      <p className="text-sm font-bold text-gray-900">{viewingOem.support_sla || <span className="text-gray-400 font-normal italic">Not set</span>}</p>
                    </div>
                  </div>

                  {/* Auth & manager */}
                  <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Authorization</p>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="flex items-start gap-2.5">
                        <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <ShieldCheck size={13} className="text-blue-500" />
                        </div>
                        <div>
                          <p className="text-xs text-gray-400">Certificate / Ref No.</p>
                          <p className="text-sm font-semibold text-gray-800 font-mono mt-0.5">{viewingOem.auth_number || <span className="font-sans font-normal text-gray-400 italic text-xs">Not set</span>}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-2.5">
                        <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <User size={13} className="text-indigo-500" />
                        </div>
                        <div>
                          <p className="text-xs text-gray-400">{isDistView ? 'Relationship Manager' : 'Account Manager'}</p>
                          <p className="text-sm font-semibold text-gray-800 mt-0.5">{viewingOem.account_manager || <span className="text-gray-400 italic font-normal text-xs">Not set</span>}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Payment terms */}
                  <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm">
                    <div className="flex items-center gap-1.5 mb-2">
                      <FileText size={13} className="text-gray-400" />
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Payment Terms</p>
                    </div>
                    <p className="text-sm text-gray-700 leading-relaxed">
                      {viewingOem.payment_terms || <span className="text-gray-400 italic">Not specified</span>}
                    </p>
                  </div>

                  {/* Distributor-only: brands */}
                  {isDistView && (
                    <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm">
                      <div className="flex items-center gap-1.5 mb-3">
                        <Tag size={13} className="text-gray-400" />
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Brands Handled</p>
                      </div>
                      {viewingOem.brands_handled
                        ? <div className="flex flex-wrap gap-1.5">
                            {viewingOem.brands_handled.split(',').map((b: string, i: number) => (
                              <span key={i} className="px-2.5 py-1 bg-purple-50 text-purple-700 rounded-full text-xs font-medium border border-purple-100">
                                {b.trim()}
                              </span>
                            ))}
                          </div>
                        : <p className="text-sm text-gray-400 italic">Not specified</p>
                      }
                    </div>
                  )}
                </div>
              )}

              {/* Contact tab */}
              {viewTab === 'contact' && (
                <div className="flex flex-col gap-3">
                  <div className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm">
                    {/* Avatar + name */}
                    <div className="flex items-center gap-4 pb-4 border-b border-gray-100 mb-4">
                      <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
                        {viewingOem.contact_name?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                      <div>
                        <p className="text-base font-bold text-gray-900">{viewingOem.contact_name || '—'}</p>
                        <p className="text-sm text-gray-500">{viewingOem.contact_designation || '—'}</p>
                      </div>
                    </div>
                    {/* Contact items */}
                    <div className="flex flex-col gap-3">
                      <a
                        href={viewingOem.contact_phone ? `tel:${viewingOem.contact_phone}` : undefined}
                        className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 hover:bg-blue-50 transition-colors group"
                      >
                        <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0 group-hover:bg-blue-200 transition-colors">
                          <Phone size={14} className="text-blue-600" />
                        </div>
                        <div>
                          <p className="text-xs text-gray-400">Phone</p>
                          <p className="text-sm font-semibold text-gray-800">{viewingOem.contact_phone || <span className="text-gray-400 font-normal italic text-xs">Not set</span>}</p>
                        </div>
                      </a>
                      <a
                        href={viewingOem.contact_email ? `mailto:${viewingOem.contact_email}` : undefined}
                        className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 hover:bg-green-50 transition-colors group"
                      >
                        <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center flex-shrink-0 group-hover:bg-green-200 transition-colors">
                          <Mail size={14} className="text-green-600" />
                        </div>
                        <div>
                          <p className="text-xs text-gray-400">Email</p>
                          <p className="text-sm font-semibold text-gray-800">{viewingOem.contact_email || <span className="text-gray-400 font-normal italic text-xs">Not set</span>}</p>
                        </div>
                      </a>
                    </div>
                  </div>
                </div>
              )}

              {/* Notes tab */}
              {viewTab === 'notes' && (
                <div className="bg-white border border-gray-100 rounded-2xl p-5 shadow-sm min-h-[120px]">
                  <div className="flex items-center gap-1.5 mb-3">
                    <FileText size={13} className="text-gray-400" />
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Notes</p>
                  </div>
                  {viewingOem.notes
                    ? <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{viewingOem.notes}</p>
                    : <div className="flex flex-col items-center justify-center py-10 text-gray-300">
                        <FileText size={36} className="mb-2" />
                        <p className="text-sm italic text-gray-400">No notes added</p>
                      </div>
                  }
                </div>
              )}

            </div>
          </SlidePanel>
        )
      })()}
    </div>
  )
}
