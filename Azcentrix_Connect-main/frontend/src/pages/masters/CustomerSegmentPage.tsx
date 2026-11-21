import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, Check, GripVertical, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import api from '@/services/api'
import { PageHeader, useToast } from '@/components/ui/FormComponents'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { apiFieldErrors, validate, type FieldSpec } from '@/utils/validation'

// Same rules as the backend (masters_router VerticalSectorIn)
const SEGMENT_SPEC: FieldSpec = { label: 'Segment name', rule: 'name', required: true, min: 2, max: 100 }
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase()
/** Plain-text message of a failed request (never an object / list). */
const apiText = (e: any, fallback: string) => {
  const d = e?.response?.data?.detail
  return typeof d === 'string' ? d : Object.values(apiFieldErrors(e))[0] || fallback
}
const focusEl = (id: string) => setTimeout(() => document.getElementById(id)?.focus(), 0)

interface Segment {
  id: number
  name: string
  display_order?: number
}

interface SubSegment {
  id: number
  name: string
  sector_id: number
  sector_name: string
}

type ConfirmOptions = {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
}

const SEGMENT_LABEL_ALIASES: Record<string, string> = {
  'state govenment': 'State Government',
  'state goverment': 'State Government',
  'state govement': 'State Government',
}

function displaySegmentName(name: string) {
  const cleaned = (name || '').trim().replace(/\s+/g, ' ')
  return SEGMENT_LABEL_ALIASES[cleaned.toLowerCase()] || cleaned
}

function segmentInitial(name: string) {
  return displaySegmentName(name).match(/[a-z0-9]/i)?.[0].toUpperCase() || '?'
}

function ConfirmDialog({
  open,
  title,
  message,
  confirmText = 'Delete',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmOptions & { open: boolean; onConfirm: () => void; onCancel: () => void }) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/30 px-4 backdrop-blur-sm">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-2xl">
        <div className="flex items-start gap-3 px-5 py-4">
          <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600">
            <AlertCircle size={18} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-900">{title}</h3>
            <p className="mt-1 text-sm leading-5 text-slate-500">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 bg-slate-50 px-5 py-3.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-rose-700"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

function useConfirmDialog() {
  const resolverRef = useRef<((value: boolean) => void) | null>(null)
  const [options, setOptions] = useState<ConfirmOptions | null>(null)

  const confirm = useCallback((opts: ConfirmOptions) => {
    setOptions(opts)
    return new Promise<boolean>(resolve => {
      resolverRef.current = resolve
    })
  }, [])

  const close = useCallback((value: boolean) => {
    resolverRef.current?.(value)
    resolverRef.current = null
    setOptions(null)
  }, [])

  const dialog = options
    ? <ConfirmDialog open {...options} onConfirm={() => close(true)} onCancel={() => close(false)} />
    : null

  return { confirm, dialog }
}

function InlineInput({
  id,
  value,
  onChange,
  onBlur,
  onSubmit,
  onCancel,
  error,
  autoFocus,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  onSubmit: () => void
  onCancel: () => void
  error?: string
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  return (
    <div className="w-full">
      <input
        ref={ref}
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        onBlur={onBlur}
        aria-invalid={error ? true : undefined}
        aria-describedby={error && id ? `${id}-err` : undefined}
        onKeyDown={event => {
          if (event.key === 'Enter') onSubmit()
          if (event.key === 'Escape') onCancel()
        }}
        className={`w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-800 outline-none transition-colors focus:ring-4 ${
          error
            ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
            : 'border-blue-300 focus:border-blue-400 focus:ring-blue-100'
        }`}
      />
      <FieldError id={id} msg={error} />
    </div>
  )
}

export default function CustomerSegmentPage({ embedded = false }: { embedded?: boolean }) {
  const [segments, setSegments] = useState<Segment[]>([])
  const [subSegments, setSubSegments] = useState<SubSegment[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [addMode, setAddMode] = useState(false)
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const { success, error: showError } = useToast()
  const { confirm, dialog } = useConfirmDialog()
  const showErrorRef = useRef(showError)

  useEffect(() => {
    showErrorRef.current = showError
  }, [showError])

  const load = useCallback(async (showPageLoader = false) => {
    if (showPageLoader) setLoading(true)

    try {
      const [segmentRes, subSegmentRes] = await Promise.all([
        api.get('/masters/vertical-sectors'),
        api.get('/masters/vertical-sub-sectors'),
      ])

      setSegments(segmentRes.data as Segment[])
      setSubSegments(subSegmentRes.data as SubSegment[])
    } catch {
      showErrorRef.current('Failed to load customer segments')
    } finally {
      if (showPageLoader) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(true)
  }, [load])

  const subSegmentCount = useMemo(() => {
    const counts: Record<number, number> = {}
    subSegments.forEach(item => {
      counts[item.sector_id] = (counts[item.sector_id] ?? 0) + 1
    })
    return counts
  }, [subSegments])

  const filteredSegments = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return segments
    return segments.filter(segment => displaySegmentName(segment.name).toLowerCase().includes(query))
  }, [segments, search])

  const persistSegmentOrder = useCallback(async (orderedIds: number[]) => {
    let previous: Segment[] = []
    setSegments(current => {
      previous = current
      const byId = new Map(current.map(item => [item.id, item]))
      const ordered = orderedIds.map(id => byId.get(id)).filter(Boolean) as Segment[]
      const rest = current.filter(item => !orderedIds.includes(item.id))
      return [...ordered, ...rest].map((item, index) => ({ ...item, display_order: index + 1 }))
    })

    try {
      const response = await api.put('/masters/vertical-sectors/order', { ids: orderedIds })
      setSegments(response.data as Segment[])
    } catch (error: any) {
      setSegments(previous)
      showErrorRef.current(error.response?.data?.detail || 'Failed to save customer segment order')
    }
  }, [])

  const moveSegment = useCallback((id: number, direction: -1 | 1) => {
    const index = segments.findIndex(item => item.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= segments.length) return
    const next = segments.map(item => item.id)
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    persistSegmentOrder(next)
  }, [segments, persistSegmentOrder])

  const dropOn = useCallback((targetId: number) => {
    if (!draggingId || draggingId === targetId) return
    const ids = segments.map(segment => segment.id)
    const from = ids.indexOf(draggingId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    persistSegmentOrder(next)
  }, [draggingId, segments, persistSegmentOrder])

  // field validation: format while typing, required on blur / save, duplicate segment names in real time
  const fe = useFieldErrors()
  const fieldId = (key: 'add' | 'edit') => (key === 'add' ? 'cseg-add' : 'cseg-edit')
  const dupMsg = (value: string, exclude: number | null) =>
    value.trim() && segments.some(item => item.id !== exclude && (sameName(item.name, value) || sameName(displaySegmentName(item.name), value)))
      ? 'A customer segment with this name already exists.'
      : ''
  const checkName = (key: 'add' | 'edit', value: string, mode: 'change' | 'blur') => {
    if (mode === 'change') fe.change(key, value, SEGMENT_SPEC)
    else fe.blur(key, value, SEGMENT_SPEC)
    const dup = !validate(value, { ...SEGMENT_SPEC, required: false }) ? dupMsg(value, key === 'edit' ? editId : null) : ''
    if (dup) fe.setError(key, dup)
  }
  const fullCheck = (key: 'add' | 'edit', value: string) => {
    const message = validate(value, SEGMENT_SPEC) || dupMsg(value, key === 'edit' ? editId : null)
    fe.blur(key, value, SEGMENT_SPEC)
    if (message) {
      fe.setError(key, message)
      focusEl(fieldId(key))
    }
    return !message
  }
  const serverError = (key: 'add' | 'edit', error: any, fallback: string) => {
    const message = apiFieldErrors(error).name
    if (message) {
      fe.setError(key, message)
      focusEl(fieldId(key))
    } else {
      showError(apiText(error, fallback))
    }
  }

  const handleAdd = async () => {
    if (!fullCheck('add', newName)) return
    const name = newName.trim()

    setSaving(true)
    try {
      await api.post('/masters/vertical-sectors', { name })
      setNewName('')
      setAddMode(false)
      fe.clear()
      success('Customer segment added')
      load(false)
    } catch (error: any) {
      serverError('add', error, 'Failed to add customer segment')
    } finally {
      setSaving(false)
    }
  }

  const startEdit = (segment: Segment) => {
    setAddMode(false)
    setEditId(segment.id)
    setEditName(displaySegmentName(segment.name))
    fe.clear()
  }

  const handleEditSave = async (segment: Segment) => {
    if (!fullCheck('edit', editName)) return
    const name = editName.trim()

    setEditSaving(true)
    try {
      await api.put(`/masters/vertical-sectors/${segment.id}`, { name })
      setEditId(null)
      setEditName('')
      fe.clear()
      success('Customer segment updated')
      load(false)
    } catch (error: any) {
      serverError('edit', error, 'Failed to update customer segment')
    } finally {
      setEditSaving(false)
    }
  }

  const handleDelete = async (segment: Segment) => {
    const childCount = subSegmentCount[segment.id] ?? 0
    const ok = await confirm({
      title: 'Delete customer segment',
      message: childCount
        ? `Delete "${displaySegmentName(segment.name)}" and its ${childCount} sub-segment(s)?`
        : `Delete "${displaySegmentName(segment.name)}"?`,
    })

    if (!ok) return

    setDeletingId(segment.id)
    try {
      await api.delete(`/masters/vertical-sectors/${segment.id}`)
      success('Customer segment deleted')
      load(false)
    } catch (error: any) {
      showError(apiText(error, 'Failed to delete customer segment'))
    } finally {
      setDeletingId(null)
    }
  }

  const openAdd = () => {
    setEditId(null)
    setEditName('')
    setAddMode(true)
    fe.clear()
  }

  if (loading) {
    return (
      <div className={embedded ? '' : 'p-6'}>
        {!embedded && (
          <PageHeader
            title="Customer Segments"
            subtitle="Manage customer segments"
            breadcrumb={['Settings', 'Masters', 'Customer Segments']}
          />
        )}
        <div className="rounded-2xl border border-slate-200 bg-white p-16 text-center shadow-sm">
          <RefreshCw size={18} className="mx-auto mb-2 animate-spin text-slate-300" />
          <p className="text-sm text-slate-400">Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <div className={embedded ? '' : 'p-6'}>
      {!embedded && (
        <PageHeader
          title="Customer Segments"
          subtitle="Manage customer segments"
          breadcrumb={['Settings', 'Masters', 'Customer Segments']}
          actions={
            <button
              type="button"
              onClick={() => load(false)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50"
            >
              <RefreshCw size={13} /> Refresh
            </button>
          }
        />
      )}

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-md">
          <Search size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search customer segments..."
            className="h-12 w-full rounded-lg border border-slate-200 bg-white pl-12 pr-10 text-sm text-slate-700 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              title="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <p className="text-sm font-medium text-slate-400">
          {filteredSegments.length} of {segments.length}
        </p>
        <button
          type="button"
          onClick={openAdd}
          className="ml-auto inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-slate-950 px-5 text-sm font-bold text-white shadow-lg shadow-slate-900/15 transition-colors hover:bg-slate-800"
        >
          <Plus size={17} /> Add Customer Segment
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {addMode && (
          <div className="flex items-center gap-4 border-b border-slate-100 bg-slate-50 px-6 py-4">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-sm font-bold text-blue-600">
              +
            </span>
            <InlineInput
              id="cseg-add"
              value={newName}
              onChange={value => {
                setNewName(value)
                checkName('add', value, 'change')
              }}
              onBlur={() => checkName('add', newName, 'blur')}
              error={fe.errors.add}
              onSubmit={handleAdd}
              onCancel={() => {
                setAddMode(false)
                setNewName('')
                fe.clear()
              }}
              autoFocus
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={saving || !newName.trim()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />} Save
            </button>
            <button
              type="button"
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                setAddMode(false)
                setNewName('')
                fe.clear()
              }}
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              title="Cancel"
            >
              <X size={15} />
            </button>
          </div>
        )}

        {filteredSegments.length === 0 ? (
          <div className="p-14 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100">
              {search ? <Search size={20} className="text-slate-400" /> : <Plus size={20} className="text-slate-400" />}
            </div>
            <p className="text-sm text-slate-500">
              {search ? `No results for "${search}"` : 'No customer segments configured yet'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {filteredSegments.map(segment => {
              const editing = editId === segment.id
              const displayName = displaySegmentName(segment.name)
              const segmentIndex = segments.findIndex(item => item.id === segment.id)

              return (
                <div
                  key={segment.id}
                  draggable={!editing}
                  onDragStart={() => setDraggingId(segment.id)}
                  onDragEnd={() => setDraggingId(null)}
                  onDragOver={event => event.preventDefault()}
                  onDrop={() => dropOn(segment.id)}
                  className={`group relative flex items-center gap-3 px-5 py-3 transition-colors hover:bg-slate-50 ${draggingId === segment.id ? 'bg-slate-100 opacity-60' : ''}`}
                >
                  {!editing && (
                    <GripVertical size={14} className="flex-shrink-0 cursor-grab text-slate-300 active:cursor-grabbing" />
                  )}
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-sm font-bold text-blue-600">
                    {segmentInitial(segment.name)}
                  </span>

                  {editing ? (
                    <>
                      <InlineInput
                        id="cseg-edit"
                        value={editName}
                        onChange={value => {
                          setEditName(value)
                          checkName('edit', value, 'change')
                        }}
                        onBlur={() => checkName('edit', editName, 'blur')}
                        error={fe.errors.edit}
                        onSubmit={() => handleEditSave(segment)}
                        onCancel={() => {
                          setEditId(null)
                          setEditName('')
                          fe.clear()
                        }}
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => handleEditSave(segment)}
                        disabled={editSaving || !editName.trim()}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {editSaving ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />} Save
                      </button>
                      <button
                        type="button"
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => {
                          setEditId(null)
                          setEditName('')
                          fe.clear()
                        }}
                        className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        title="Cancel"
                      >
                        <X size={15} />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate pr-32 text-sm font-semibold text-gray-900">
                        {displayName}
                      </span>
                      <div className="absolute right-4 top-1/2 z-10 flex -translate-y-1/2 flex-shrink-0 items-center gap-0.5 rounded-lg bg-white/95 px-1 shadow-sm opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation()
                            moveSegment(segment.id, -1)
                          }}
                          disabled={segmentIndex <= 0}
                          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-25"
                          title="Move up"
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation()
                            moveSegment(segment.id, 1)
                          }}
                          disabled={segmentIndex < 0 || segmentIndex >= segments.length - 1}
                          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-25"
                          title="Move down"
                        >
                          <ArrowDown size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation()
                            startEdit(segment)
                          }}
                          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-blue-50 hover:text-blue-600"
                          title="Edit customer segment"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation()
                            handleDelete(segment)
                          }}
                          disabled={deletingId === segment.id}
                          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500 disabled:cursor-wait disabled:opacity-50"
                          title="Delete customer segment"
                        >
                          {deletingId === segment.id ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {dialog}
    </div>
  )
}
