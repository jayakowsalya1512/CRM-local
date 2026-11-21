import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  FolderOpen,
  GripVertical,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import { PageHeader, useToast } from '@/components/ui/FormComponents'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { apiFieldErrors, validate, type FieldSpec } from '@/utils/validation'

// Same rules as the backend (masters_router VerticalSectorIn / VerticalSubSectorIn)
const SEGMENT_SPEC: FieldSpec = { label: 'Segment name', rule: 'name', required: true, min: 2, max: 100 }
const SUB_SEGMENT_SPEC: FieldSpec = { label: 'Sub-segment name', rule: 'name', required: true, min: 2, max: 100 }
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

function initial(name: string) {
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
  invalid,
  error,
  autoFocus,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  onSubmit: () => void
  onCancel: () => void
  invalid?: boolean
  error?: string
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  return (
    <>
      <input
        ref={ref}
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        onBlur={onBlur}
        aria-invalid={invalid || error ? true : undefined}
        aria-describedby={error && id ? `${id}-err` : undefined}
        onKeyDown={event => {
          if (event.key === 'Enter' && !invalid) onSubmit()
          if (event.key === 'Escape') onCancel()
        }}
        className={`w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-800 transition-colors focus:outline-none focus:ring-4 ${
          invalid || error
            ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
            : 'border-blue-300 focus:border-blue-400 focus:ring-blue-100'
        }`}
      />
      <FieldError id={id} msg={error} />
    </>
  )
}

function SegmentPanel({
  segments,
  subSegments,
  selectedId,
  onSelect,
  onChanged,
  onMove,
  onReorder,
}: {
  segments: Segment[]
  subSegments: SubSegment[]
  selectedId: number | null
  onSelect: (id: number | null) => void
  onChanged: () => void
  onMove: (id: number, direction: -1 | 1) => void
  onReorder: (ids: number[]) => void
}) {
  const [addMode, setAddMode] = useState(false)
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const { success, error: showError } = useToast()
  const { confirm, dialog } = useConfirmDialog()

  const countOf = useMemo(() => {
    const counts: Record<number, number> = {}
    subSegments.forEach(item => {
      counts[item.sector_id] = (counts[item.sector_id] ?? 0) + 1
    })
    return counts
  }, [subSegments])

  const dropOn = (targetId: number) => {
    if (!draggingId || draggingId === targetId) return
    const ids = segments.map(segment => segment.id)
    const from = ids.indexOf(draggingId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onReorder(next)
  }

  // field validation: format while typing, required on blur / save, duplicate segment names in real time
  const fe = useFieldErrors()
  const fieldId = (key: 'add' | 'edit') => (key === 'add' ? 'seg-add' : 'seg-edit')
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
      const response = await api.post('/masters/vertical-sectors', { name })
      onSelect((response.data as Segment).id)
      setNewName('')
      setAddMode(false)
      fe.clear()
      success('Customer segment added')
      onChanged()
    } catch (error: any) {
      serverError('add', error, 'Failed to add customer segment')
    } finally {
      setSaving(false)
    }
  }

  const handleEditSave = async (segment: Segment) => {
    if (!fullCheck('edit', editName)) return
    const name = editName.trim()

    try {
      await api.put(`/masters/vertical-sectors/${segment.id}`, { name })
      setEditId(null)
      setEditName('')
      fe.clear()
      success('Customer segment updated')
      onChanged()
    } catch (error: any) {
      serverError('edit', error, 'Failed to update customer segment')
    }
  }

  const handleDelete = async (segment: Segment) => {
    const childCount = countOf[segment.id] ?? 0
    if (childCount > 0) {
      showError('Delete sub-segments first')
      return
    }

    const ok = await confirm({
      title: 'Delete customer segment',
      message: `Delete "${displaySegmentName(segment.name)}"?`,
    })
    if (!ok) return

    setDeletingId(segment.id)
    try {
      await api.delete(`/masters/vertical-sectors/${segment.id}`)
      success('Customer segment deleted')
      if (selectedId === segment.id) onSelect(null)
      onChanged()
    } catch (error: any) {
      showError(apiText(error, 'Failed to delete customer segment'))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3.5">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Segments</p>
          <p className="text-xs font-medium text-slate-300">{segments.length} configured</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setAddMode(true)
            setEditId(null)
            fe.clear()
          }}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-50"
        >
          <Plus size={13} /> Add
        </button>
      </div>

      {addMode && (
        <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
          <InlineInput
            id="seg-add"
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
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={handleAdd}
              disabled={saving || !newName.trim()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-600 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
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
              className="rounded-lg px-3 py-2 text-slate-400 hover:bg-slate-100"
              title="Cancel"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {segments.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <FolderOpen size={22} className="mx-auto mb-2 text-slate-300" />
            <p className="text-xs text-slate-400">No segments yet</p>
          </div>
        ) : (
          segments.map((segment, index) => {
            const selected = selectedId === segment.id
            const editing = editId === segment.id
            const count = countOf[segment.id] ?? 0

            return (
              <div
                key={segment.id}
                draggable={!editing}
                onDragStart={() => setDraggingId(segment.id)}
                onDragEnd={() => setDraggingId(null)}
                onDragOver={event => event.preventDefault()}
                onDrop={() => dropOn(segment.id)}
                className={`group border-b border-slate-50 transition-colors ${
                  draggingId === segment.id
                    ? 'bg-slate-100 opacity-60'
                    : selected
                      ? 'border-l-2 border-l-blue-500 bg-blue-50'
                      : 'border-l-2 border-l-transparent hover:bg-slate-50'
                }`}
              >
                {editing ? (
                  <div className="px-3 py-2.5">
                    <InlineInput
                      id="seg-edit"
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
                        fe.clear()
                      }}
                      autoFocus
                    />
                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleEditSave(segment)}
                        disabled={!editName.trim()}
                        className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
                      >
                        <Check size={11} /> Save
                      </button>
                      <button
                        type="button"
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => {
                          setEditId(null)
                          fe.clear()
                        }}
                        className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="relative flex items-center gap-2 px-3 py-2.5">
                    <GripVertical size={14} className="shrink-0 cursor-grab text-slate-300 active:cursor-grabbing" />
                    <button
                      type="button"
                      onClick={() => onSelect(segment.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span
                        className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-xs font-bold ${
                          selected ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'
                        }`}
                      >
                        {initial(segment.name)}
                      </span>
                      <span className={`flex-1 truncate text-sm ${selected ? 'font-semibold text-blue-700' : 'text-slate-700'}`}>
                        {displaySegmentName(segment.name)}
                      </span>
                      <span
                        className={`flex-shrink-0 rounded-full px-1.5 py-0.5 text-xs font-bold tabular-nums ${
                          selected ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'
                        }`}
                      >
                        {count}
                      </span>
                      <ChevronRight
                        size={14}
                        className={`flex-shrink-0 transition-opacity ${
                          selected ? 'text-blue-400 opacity-100' : 'text-slate-300 opacity-0 group-hover:opacity-100'
                        }`}
                      />
                    </button>
                    <div className="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 flex-shrink-0 items-center gap-0.5 rounded-lg bg-white/95 px-1 shadow-sm opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation()
                          onMove(segment.id, -1)
                        }}
                        disabled={index === 0}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25"
                        title="Move up"
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation()
                          onMove(segment.id, 1)
                        }}
                        disabled={index === segments.length - 1}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25"
                        title="Move down"
                      >
                        <ArrowDown size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation()
                          setEditId(segment.id)
                          setEditName(displaySegmentName(segment.name))
                          setAddMode(false)
                          fe.clear()
                        }}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-600"
                        title="Edit segment"
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
                        className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500 disabled:opacity-50"
                        title={count > 0 ? 'Delete sub-segments first' : 'Delete segment'}
                      >
                        {deletingId === segment.id ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
      {dialog}
    </div>
  )
}

function SubSegmentPanel({
  segment,
  subSegments,
  allSubSegments,
  onChanged,
}: {
  segment: Segment
  subSegments: SubSegment[]
  allSubSegments: SubSegment[]
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [addSaving, setAddSaving] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [checkedIds, setCheckedIds] = useState<number[]>([])
  const [deleting, setDeleting] = useState(false)
  const { success, error: showError } = useToast()
  const { confirm, dialog } = useConfirmDialog()

  // field validation (format / required / server errors); the duplicate check below keeps its existing message
  const fe = useFieldErrors()
  const clearFe = fe.clear

  useEffect(() => {
    setName('')
    setEditId(null)
    setEditName('')
    setCheckedIds([])
    clearFe()
  }, [segment.id, clearFe])

  const fullCheck = (key: 'add' | 'edit', value: string) => {
    fe.blur(key, value, SUB_SEGMENT_SPEC)
    const message = validate(value, SUB_SEGMENT_SPEC)
    if (message) focusEl(key === 'add' ? 'subseg-add' : 'subseg-edit')
    return !message
  }
  const serverError = (key: 'add' | 'edit', error: any, fallback: string) => {
    const fields = apiFieldErrors(error)
    const message = fields.name || fields.sector_id
    if (message) {
      fe.setError(key, message)
      focusEl(key === 'add' ? 'subseg-add' : 'subseg-edit')
    } else {
      showError(apiText(error, fallback))
    }
  }

  const duplicate = useMemo(() => {
    const query = name.trim().toLowerCase()
    if (!query) return null
    return allSubSegments.find(item => item.sector_id === segment.id && item.name.trim().toLowerCase() === query) ?? null
  }, [allSubSegments, name, segment.id])

  const editDuplicate = useMemo(() => {
    const query = editName.trim().toLowerCase()
    if (!query) return null
    return allSubSegments.find(item => item.id !== editId && item.sector_id === segment.id && item.name.trim().toLowerCase() === query) ?? null
  }, [allSubSegments, editId, editName, segment.id])

  const allChecked = subSegments.length > 0 && checkedIds.length === subSegments.length

  const toggle = (id: number) => {
    setCheckedIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }

  const handleAdd = async () => {
    if (!fullCheck('add', name) || duplicate) return
    const nextName = name.trim()

    setAddSaving(true)
    try {
      await api.post('/masters/vertical-sub-sectors', { name: nextName, sector_id: segment.id })
      success('Sub-segment added')
      setName('')
      fe.clear('add')
      onChanged()
    } catch (error: any) {
      serverError('add', error, 'Failed to add sub-segment')
    } finally {
      setAddSaving(false)
    }
  }

  const handleEditSave = async (subSegment: SubSegment) => {
    if (!fullCheck('edit', editName) || editDuplicate) return
    const nextName = editName.trim()

    setEditSaving(true)
    try {
      await api.put(`/masters/vertical-sub-sectors/${subSegment.id}`, { name: nextName, sector_id: segment.id })
      success('Sub-segment updated')
      setEditId(null)
      setEditName('')
      fe.clear('edit')
      onChanged()
    } catch (error: any) {
      serverError('edit', error, 'Failed to update sub-segment')
    } finally {
      setEditSaving(false)
    }
  }

  const handleDelete = async (subSegment: SubSegment) => {
    const ok = await confirm({ title: 'Delete sub-segment', message: `Delete "${subSegment.name}"?` })
    if (!ok) return

    try {
      await api.delete(`/masters/vertical-sub-sectors/${subSegment.id}`)
      success('Sub-segment deleted')
      setCheckedIds(current => current.filter(id => id !== subSegment.id))
      onChanged()
    } catch (error: any) {
      showError(apiText(error, 'Failed to delete sub-segment'))
    }
  }

  const handleDeleteChecked = async () => {
    if (checkedIds.length === 0) return
    const ok = await confirm({
      title: 'Delete selected sub-segments',
      message: `Delete ${checkedIds.length} sub-segment${checkedIds.length === 1 ? '' : 's'}?`,
      confirmText: 'Delete selected',
    })
    if (!ok) return

    setDeleting(true)
    try {
      await Promise.all(checkedIds.map(id => api.delete(`/masters/vertical-sub-sectors/${id}`)))
      success('Selected sub-segments deleted')
      setCheckedIds([])
      onChanged()
    } catch (error: any) {
      showError(apiText(error, 'Failed to delete selected sub-segments'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-3.5">
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-600">
          <Layers size={14} />
        </span>
        <h2 className="truncate text-sm font-bold text-slate-900">{displaySegmentName(segment.name)}</h2>
        <span className="text-xs font-medium text-slate-400">
          {subSegments.length} sub-segment{subSegments.length !== 1 ? 's' : ''}
        </span>
        {checkedIds.length > 0 && (
          <button
            type="button"
            onClick={handleDeleteChecked}
            disabled={deleting}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50"
          >
            {deleting ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />} Delete selected ({checkedIds.length})
          </button>
        )}
      </div>

      <div className="border-b border-slate-100 px-5 py-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Add Sub-Segment</p>
          <p className="text-xs text-slate-400">Names are unique inside the selected segment</p>
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              id="subseg-add"
              value={name}
              onChange={event => {
                setName(event.target.value)
                fe.change('add', event.target.value, SUB_SEGMENT_SPEC)
              }}
              onBlur={() => {
                if (name || fe.errors.add) fe.blur('add', name, SUB_SEGMENT_SPEC)
              }}
              aria-invalid={(duplicate && name.trim()) || fe.errors.add ? true : undefined}
              aria-describedby={fe.errors.add ? 'subseg-add-err' : undefined}
              onKeyDown={event => {
                if (event.key === 'Enter' && !duplicate) handleAdd()
              }}
              placeholder={`New sub-segment in ${displaySegmentName(segment.name)}...`}
              className={`w-full rounded-xl border bg-white px-3.5 py-2.5 pr-8 text-sm text-slate-800 placeholder:text-slate-300 transition-colors focus:outline-none focus:ring-4 ${
                (duplicate && name.trim()) || fe.errors.add
                  ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
                  : 'border-slate-200 focus:border-blue-400 focus:ring-blue-100'
              }`}
            />
            {name && (
              <button
                type="button"
                onClick={() => {
                  setName('')
                  fe.clear('add')
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                title="Clear"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <Button onClick={handleAdd} loading={addSaving} disabled={!name.trim() || !!duplicate}>
            <Plus size={14} className="mr-1 inline-block" /> Add
          </Button>
        </div>
        {!(duplicate && name.trim()) && <FieldError id="subseg-add" msg={fe.errors.add} />}
        {duplicate && name.trim() && (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-rose-500">
            <AlertCircle size={12} />
            Already exists under {displaySegmentName(segment.name)}.
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {subSegments.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <Layers size={22} className="mx-auto mb-2 text-slate-300" />
            <p className="text-sm text-slate-400">No sub-segments yet</p>
            <p className="mt-0.5 text-xs text-slate-300">Type a name above and click Add</p>
          </div>
        ) : (
          <>
            <label className="flex items-center gap-2.5 border-b border-slate-100 bg-slate-50 px-5 py-2 text-xs font-semibold text-slate-500">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={event => setCheckedIds(event.target.checked ? subSegments.map(item => item.id) : [])}
                className="h-4 w-4 rounded border-slate-300 accent-blue-600"
              />
              Select all
            </label>
            <div className="divide-y divide-slate-50">
              {subSegments.map(subSegment => {
                const editing = editId === subSegment.id

                return (
                  <div key={subSegment.id} className="group flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                    {editing ? (
                      <div className="flex flex-1 items-center gap-2">
                        <div className="flex-1">
                          <InlineInput
                            id="subseg-edit"
                            value={editName}
                            onChange={value => {
                              setEditName(value)
                              fe.change('edit', value, SUB_SEGMENT_SPEC)
                            }}
                            onBlur={() => fe.blur('edit', editName, SUB_SEGMENT_SPEC)}
                            error={editDuplicate ? undefined : fe.errors.edit}
                            onSubmit={() => handleEditSave(subSegment)}
                            onCancel={() => {
                              setEditId(null)
                              fe.clear('edit')
                            }}
                            invalid={!!editDuplicate}
                            autoFocus
                          />
                          {editDuplicate && (
                            <p className="mt-1 flex items-center gap-1 text-xs text-rose-500">
                              <AlertCircle size={10} /> Already exists under this segment
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleEditSave(subSegment)}
                          disabled={editSaving || !editName.trim() || !!editDuplicate}
                          className="flex-shrink-0 rounded-lg p-2 text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"
                          title="Save"
                        >
                          {editSaving ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
                        </button>
                        <button
                          type="button"
                          onMouseDown={event => event.preventDefault()}
                          onClick={() => {
                            setEditId(null)
                            fe.clear('edit')
                          }}
                          className="flex-shrink-0 rounded-lg p-2 text-slate-400 hover:bg-slate-100"
                          title="Cancel"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <input
                          type="checkbox"
                          checked={checkedIds.includes(subSegment.id)}
                          onChange={() => toggle(subSegment.id)}
                          className="h-4 w-4 flex-shrink-0 rounded border-slate-300 accent-blue-600"
                          title="Select sub-segment"
                        />
                        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-bold text-slate-400">
                          {initial(subSegment.name)}
                        </span>
                        <span className="flex-1 truncate text-sm text-slate-800">{subSegment.name}</span>
                        <div className="flex flex-shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={() => {
                              setEditId(subSegment.id)
                              setEditName(subSegment.name)
                              fe.clear('edit')
                            }}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-600"
                            title="Edit"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(subSegment)}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
      {dialog}
    </div>
  )
}

export default function CustomerSubSegmentPage({ embedded = false }: { embedded?: boolean }) {
  const [segments, setSegments] = useState<Segment[]>([])
  const [subSegments, setSubSegments] = useState<SubSegment[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedSegmentId, setSelectedSegmentId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const { error: showError } = useToast()
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
      const nextSegments = segmentRes.data as Segment[]
      setSegments(nextSegments)
      setSubSegments(subSegmentRes.data as SubSegment[])
      setSelectedSegmentId(current => {
        if (current && nextSegments.some(segment => segment.id === current)) return current
        return nextSegments[0]?.id ?? null
      })
    } catch {
      showErrorRef.current('Failed to load customer sub-segments')
    } finally {
      if (showPageLoader) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(true)
  }, [load])

  const filteredSegments = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return segments
    return segments.filter(segment => displaySegmentName(segment.name).toLowerCase().includes(query))
  }, [search, segments])

  const selectedSegment = useMemo(
    () => segments.find(segment => segment.id === selectedSegmentId) ?? null,
    [segments, selectedSegmentId],
  )

  const subSegmentsForSelected = useMemo(
    () => subSegments.filter(subSegment => subSegment.sector_id === selectedSegmentId),
    [selectedSegmentId, subSegments],
  )

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
  }, [persistSegmentOrder, segments])

  if (loading) {
    return (
      <div className={embedded ? '' : 'p-6'}>
        {!embedded && (
          <PageHeader
            title="Customer Sub Segments"
            subtitle="Manage sub-segments under each customer segment"
            breadcrumb={['Settings', 'Masters', 'Customer Sub Segments']}
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
          title="Customer Sub Segments"
          subtitle="Pick a customer segment to manage its sub-segments"
          breadcrumb={['Settings', 'Masters', 'Customer Sub Segments']}
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

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-md">
          <Search size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search segments..."
            className="h-11 w-full rounded-lg border border-slate-200 bg-white pl-12 pr-10 text-sm text-slate-700 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
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
      </div>

      <div className="flex overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" style={{ minHeight: 540 }}>
        <div className="flex w-96 flex-shrink-0 flex-col border-r border-slate-200">
          <SegmentPanel
            segments={filteredSegments}
            subSegments={subSegments}
            selectedId={selectedSegmentId}
            onSelect={setSelectedSegmentId}
            onChanged={() => load(false)}
            onMove={moveSegment}
            onReorder={persistSegmentOrder}
          />
        </div>

        <div className="flex flex-1 flex-col">
          {selectedSegment ? (
            <SubSegmentPanel
              key={selectedSegment.id}
              segment={selectedSegment}
              subSegments={subSegmentsForSelected}
              allSubSegments={subSegments}
              onChanged={() => load(false)}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
              <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                <Layers size={20} />
              </span>
              <p className="mb-1 text-sm font-semibold text-slate-500">No segment selected</p>
              <p className="text-xs text-slate-400">Select a segment on the left, or add a new one.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
