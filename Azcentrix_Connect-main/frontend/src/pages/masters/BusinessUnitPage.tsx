import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  Plus, Trash2, Pencil, Check, X, Building2, FolderOpen,
  AlertCircle, ChevronRight, RefreshCw, Folder,
  GripVertical, ArrowUp, ArrowDown,
} from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import { PageHeader, useToast } from '@/components/ui/FormComponents'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { apiFieldErrors, validate, type FieldSpec } from '@/utils/validation'

/* ─────────────────────────────────────────────────────────────────────────
   VALIDATION (same rules as backend masters_router BusinessCategoryIn / BusinessUnitIn)
   ───────────────────────────────────────────────────────────────────────── */

const VERTICAL_SPEC: FieldSpec = { label: 'Vertical name', rule: 'name', required: true, min: 2, max: 100 }
const UNIT_SPEC: FieldSpec = { label: 'Unit name', rule: 'name', required: true, min: 2, max: 100 }
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
/** Plain-text message of a failed request (never an object / list). */
const apiText = (e: any, fallback: string) => {
  const d = e?.response?.data?.detail
  return typeof d === 'string' ? d : Object.values(apiFieldErrors(e))[0] || fallback
}
const focusEl = (id: string) => setTimeout(() => document.getElementById(id)?.focus(), 0)

/* ─────────────────────────────────────────────────────────────────────────
   TYPES
   ───────────────────────────────────────────────────────────────────────── */

interface BusinessCategory { id: number; name: string; display_order?: number }
interface BusinessUnit { id: number; name: string; category_id: number; category_name: string; display_order?: number }

/* ─────────────────────────────────────────────────────────────────────────
   CONFIRM DIALOG (promise-based)
   ───────────────────────────────────────────────────────────────────────── */

type ConfirmOptions = {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
}

function ConfirmDialog({
  open, title, message, confirmText = 'Delete', cancelText = 'Cancel', onConfirm, onCancel,
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
          <button onClick={onCancel} className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100">
            {cancelText}
          </button>
          <button onClick={onConfirm} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-rose-700">
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

function useConfirmDialog() {
  const resolverRef = useRef<((v: boolean) => void) | null>(null)
  const [options, setOptions] = useState<ConfirmOptions | null>(null)

  const confirm = useCallback((opts: ConfirmOptions) => {
    setOptions(opts)
    return new Promise<boolean>(resolve => { resolverRef.current = resolve })
  }, [])

  const close = useCallback((value: boolean) => {
    resolverRef.current?.(value)
    resolverRef.current = null
    setOptions(null)
  }, [])

  const dialog = options ? (
    <ConfirmDialog open {...options} onConfirm={() => close(true)} onCancel={() => close(false)} />
  ) : null

  return { confirm, dialog }
}

/* ─────────────────────────────────────────────────────────────────────────
   SMALL INLINE INPUT (used for add / edit rows)
   ───────────────────────────────────────────────────────────────────────── */

function InlineInput({
  id, value, onChange, onBlur, onSubmit, onCancel, invalid, error, autoFocus,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  onBlur?: () => void
  onSubmit: () => void
  onCancel: () => void
  invalid?: boolean
  error?: string
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])
  return (
    <>
      <input
        ref={ref}
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={invalid || error ? true : undefined}
        aria-describedby={error && id ? `${id}-err` : undefined}
        onKeyDown={e => {
          if (e.key === 'Enter' && !invalid) onSubmit()
          if (e.key === 'Escape') onCancel()
        }}
        className={`w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-800 transition-colors focus:outline-none focus:ring-4
          ${invalid || error
            ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
            : 'border-blue-300 focus:border-blue-400 focus:ring-blue-100'}`}
      />
      <FieldError id={id} msg={error} />
    </>
  )
}

/* ─────────────────────────────────────────────────────────────────────────
   VERTICAL PANEL  (left)
   ───────────────────────────────────────────────────────────────────────── */

function CategoryPanel({
  categories, units, selectedId, onSelect, onChanged, onMove, onReorder,
}: {
  categories: BusinessCategory[]
  units: BusinessUnit[]
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
  const [editSaving, setEditSaving] = useState(false)
  const [checkedIds, setCheckedIds] = useState<number[]>([])
  const [deleting, setDeleting] = useState(false)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const { success, error: showError } = useToast()
  const { confirm, dialog } = useConfirmDialog()

  const countOf = useMemo(() => {
    const m: Record<number, number> = {}
    units.forEach(u => { m[u.category_id] = (m[u.category_id] ?? 0) + 1 })
    return m
  }, [units])

  const allChecked = categories.length > 0 && checkedIds.length === categories.length
  const toggle = (id: number) =>
    setCheckedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  const dropOn = (targetId: number) => {
    if (!draggingId || draggingId === targetId) return
    const ids = categories.map(c => c.id)
    const from = ids.indexOf(draggingId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onReorder(next)
  }

  // field validation: format while typing, required on blur / save, duplicate vertical names in real time
  const fe = useFieldErrors()
  const dupMsg = (v: string, exclude: number | null) =>
    v.trim() && categories.some(c => c.id !== exclude && sameName(c.name, v)) ? 'A vertical with this name already exists.' : ''
  const checkName = (key: 'add' | 'edit', v: string, mode: 'change' | 'blur') => {
    const exclude = key === 'edit' ? editId : null
    if (mode === 'change') fe.change(key, v, VERTICAL_SPEC); else fe.blur(key, v, VERTICAL_SPEC)
    const dup = !validate(v, { ...VERTICAL_SPEC, required: false }) ? dupMsg(v, exclude) : ''
    if (dup) fe.setError(key, dup)
  }
  const fullCheck = (key: 'add' | 'edit', v: string) => {
    const m = validate(v, VERTICAL_SPEC) || dupMsg(v, key === 'edit' ? editId : null)
    fe.blur(key, v, VERTICAL_SPEC); if (m) fe.setError(key, m)
    if (m) focusEl(key === 'add' ? 'bu-cat-add' : 'bu-cat-edit')
    return !m
  }
  const serverError = (key: 'add' | 'edit', e: any, fallback: string) => {
    const m = apiFieldErrors(e).name
    if (m) { fe.setError(key, m); focusEl(key === 'add' ? 'bu-cat-add' : 'bu-cat-edit') }
    else showError(apiText(e, fallback))
  }

  const handleAdd = async () => {
    if (!fullCheck('add', newName)) return
    const name = newName.trim()
    setSaving(true)
    try {
      const res = await api.post('/masters/business-categories', { name })
      onSelect((res.data as BusinessCategory).id)
      setNewName(''); setAddMode(false); fe.clear('add'); success('Vertical added'); onChanged()
    } catch (e: any) {
      serverError('add', e, 'Failed to add vertical')
    } finally { setSaving(false) }
  }

  const handleEditSave = async (id: number) => {
    if (!fullCheck('edit', editName)) return
    const name = editName.trim()
    setEditSaving(true)
    try {
      await api.put(`/masters/business-categories/${id}`, { name })
      success('Vertical updated'); setEditId(null); setEditName(''); fe.clear('edit'); onChanged()
    } catch (e: any) {
      serverError('edit', e, 'Failed to update vertical')
    } finally { setEditSaving(false) }
  }

  const handleDelete = async (cat: BusinessCategory) => {
    const n = countOf[cat.id] ?? 0
    const ok = await confirm({
      title: 'Delete vertical',
      message: n ? `Delete "${cat.name}" and its ${n} unit(s)?` : `Delete "${cat.name}"?`,
    })
    if (!ok) return
    try {
      await api.delete(`/masters/business-categories/${cat.id}`)
      success('Vertical deleted')
      setCheckedIds(prev => prev.filter(x => x !== cat.id))
      if (selectedId === cat.id) onSelect(null)
      onChanged()
    } catch (e: any) {
      showError(apiText(e, 'Failed to delete vertical'))
    }
  }

  const handleDeleteChecked = async () => {
    if (checkedIds.length === 0) return
    const ok = await confirm({
      title: 'Delete selected verticals',
      message: `Delete ${checkedIds.length} vertical${checkedIds.length === 1 ? '' : 's'}?`,
      confirmText: 'Delete selected',
    })
    if (!ok) return
    setDeleting(true)
    try {
      await Promise.all(checkedIds.map(id => api.delete(`/masters/business-categories/${id}`)))
      success('Selected verticals deleted')
      if (selectedId && checkedIds.includes(selectedId)) onSelect(null)
      setCheckedIds([]); onChanged()
    } catch (e: any) {
      showError(apiText(e, 'Failed to delete selected verticals'))
    } finally { setDeleting(false) }
  }

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3.5">
        <label className="flex items-center gap-2.5">
          <input
            type="checkbox"
            checked={allChecked}
            onChange={e => setCheckedIds(e.target.checked ? categories.map(c => c.id) : [])}
            className="h-4 w-4 rounded border-slate-300 accent-blue-600"
            title="Select all verticals"
          />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Verticals</span>
          <span className="text-xs font-medium text-slate-300">{categories.length}</span>
        </label>
        <div className="flex items-center gap-1">
          {checkedIds.length > 0 && (
            <button onClick={handleDeleteChecked} disabled={deleting}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50">
              {deleting ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />} {checkedIds.length}
            </button>
          )}
          <button onClick={() => { setAddMode(true); setEditId(null); fe.clear() }}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-50">
            <Plus size={13} /> Add
          </button>
        </div>
      </div>

      {/* inline add */}
      {addMode && (
        <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
          <InlineInput id="bu-cat-add" value={newName}
            onChange={v => { setNewName(v); checkName('add', v, 'change') }}
            onBlur={() => checkName('add', newName, 'blur')} error={fe.errors.add} onSubmit={handleAdd}
            onCancel={() => { setAddMode(false); setNewName(''); fe.clear() }} autoFocus />
          <div className="mt-2 flex gap-2">
            <button onClick={handleAdd} disabled={saving || !newName.trim()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-600 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
              {saving ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />} Save
            </button>
            <button onMouseDown={e => e.preventDefault()} onClick={() => { setAddMode(false); setNewName(''); fe.clear() }}
              className="rounded-lg px-3 py-2 text-slate-400 hover:bg-slate-100"><X size={15} /></button>
          </div>
        </div>
      )}

      {/* list */}
      <div className="flex-1 overflow-y-auto">
        {categories.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <FolderOpen size={22} className="mx-auto mb-2 text-slate-300" />
            <p className="text-xs text-slate-400">No verticals yet</p>
          </div>
        ) : (
          categories.map((cat, index) => {
            const sel = selectedId === cat.id
            const editing = editId === cat.id
            return (
              <div key={cat.id}
                draggable={!editing}
                onDragStart={() => setDraggingId(cat.id)}
                onDragEnd={() => setDraggingId(null)}
                onDragOver={e => e.preventDefault()}
                onDrop={() => dropOn(cat.id)}
                className={`group border-b border-slate-50 transition-colors
                  ${draggingId === cat.id ? 'bg-slate-100 opacity-60' : sel ? 'border-l-2 border-l-blue-500 bg-blue-50' : 'border-l-2 border-l-transparent hover:bg-slate-50'}`}>
                {editing ? (
                  <div className="px-3 py-2.5">
                    <InlineInput id="bu-cat-edit" value={editName}
                      onChange={v => { setEditName(v); checkName('edit', v, 'change') }}
                      onBlur={() => checkName('edit', editName, 'blur')} error={fe.errors.edit}
                      onSubmit={() => handleEditSave(cat.id)}
                      onCancel={() => { setEditId(null); fe.clear() }} autoFocus />
                    <div className="mt-2 flex gap-1.5">
                      <button onClick={() => handleEditSave(cat.id)} disabled={editSaving || !editName.trim()}
                        className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
                        {editSaving ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />} Save
                      </button>
                      <button onMouseDown={e => e.preventDefault()} onClick={() => { setEditId(null); fe.clear() }} className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="relative flex items-center gap-2 px-3 py-2.5">
                    <GripVertical size={14} className="shrink-0 cursor-grab text-slate-300 active:cursor-grabbing" />
                    <input type="checkbox" checked={checkedIds.includes(cat.id)}
                      onChange={() => toggle(cat.id)} onClick={e => e.stopPropagation()}
                      className="h-4 w-4 flex-shrink-0 rounded border-slate-300 accent-blue-600" title="Select category" />
                    <button onClick={() => onSelect(cat.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <Folder size={14} className={`flex-shrink-0 ${sel ? 'text-blue-500' : 'text-slate-300'}`} />
                      <span className={`flex-1 truncate text-sm ${sel ? 'font-semibold text-blue-700' : 'text-slate-700'}`}>{cat.name}</span>
                      <span className={`flex-shrink-0 rounded-full px-1.5 py-0.5 text-xs font-bold tabular-nums
                        ${sel ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'}`}>{countOf[cat.id] ?? 0}</span>
                      <ChevronRight size={14} className={`flex-shrink-0 transition-opacity ${sel ? 'text-blue-400 opacity-100' : 'text-slate-300 opacity-0 group-hover:opacity-100'}`} />
                    </button>
                    <div className="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 flex-shrink-0 items-center gap-0.5 rounded-lg bg-white/95 px-1 shadow-sm opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={e => { e.stopPropagation(); onMove(cat.id, -1) }}
                        disabled={index === 0}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25"
                        title="Move up"
                      ><ArrowUp size={12} /></button>
                      <button
                        onClick={e => { e.stopPropagation(); onMove(cat.id, 1) }}
                        disabled={index === categories.length - 1}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25"
                        title="Move down"
                      ><ArrowDown size={12} /></button>
                      <button onClick={e => { e.stopPropagation(); setEditId(cat.id); setEditName(cat.name); setAddMode(false); fe.clear() }}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-600" title="Edit vertical"><Pencil size={13} /></button>
                      <button onClick={e => { e.stopPropagation(); handleDelete(cat) }}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500" title="Delete vertical"><Trash2 size={13} /></button>
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

/* ─────────────────────────────────────────────────────────────────────────
   UNIT PANEL  (right)
   ───────────────────────────────────────────────────────────────────────── */

function UnitPanel({
  category, units, allUnits, onChanged,
}: {
  category: BusinessCategory
  units: BusinessUnit[]
  allUnits: BusinessUnit[]
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
  useEffect(() => { setName(''); setEditId(null); setEditName(''); setCheckedIds([]); clearFe() }, [category.id, clearFe])
  const fullCheck = (key: 'add' | 'edit', v: string) => {
    fe.blur(key, v, UNIT_SPEC)
    const m = validate(v, UNIT_SPEC)
    if (m) focusEl(key === 'add' ? 'bu-unit-add' : 'bu-unit-edit')
    return !m
  }
  const serverError = (key: 'add' | 'edit', e: any, fallback: string) => {
    const m = apiFieldErrors(e).name
    if (m) { fe.setError(key, m); focusEl(key === 'add' ? 'bu-unit-add' : 'bu-unit-edit') }
    else showError(apiText(e, fallback))
  }

  // Unit names are unique across ALL categories (matches the backend rule)
  const dup = useMemo(() => {
    const q = name.trim().toLowerCase()
    return q ? allUnits.find(u => u.name.trim().toLowerCase() === q) ?? null : null
  }, [name, allUnits])
  const editDup = useMemo(() => {
    const q = editName.trim().toLowerCase()
    return q ? allUnits.find(u => u.id !== editId && u.name.trim().toLowerCase() === q) ?? null : null
  }, [editName, editId, allUnits])

  const allChecked = units.length > 0 && checkedIds.length === units.length
  const toggle = (id: number) =>
    setCheckedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  const handleAdd = async () => {
    if (!fullCheck('add', name) || dup) return
    const n = name.trim()
    setAddSaving(true)
    try {
      await api.post('/masters/business-units', { name: n, category_id: category.id })
      success('Unit added'); setName(''); fe.clear('add'); onChanged()
    } catch (e: any) {
      serverError('add', e, 'Failed to add unit')
    } finally { setAddSaving(false) }
  }

  const handleEditSave = async (unit: BusinessUnit) => {
    if (!fullCheck('edit', editName) || editDup) return
    const n = editName.trim()
    setEditSaving(true)
    try {
      await api.put(`/masters/business-units/${unit.id}`, { name: n, category_id: category.id })
      success('Unit updated'); setEditId(null); fe.clear('edit'); onChanged()
    } catch (e: any) {
      serverError('edit', e, 'Failed to update unit')
    } finally { setEditSaving(false) }
  }

  const handleDelete = async (unit: BusinessUnit) => {
    const ok = await confirm({ title: 'Delete unit', message: `Delete "${unit.name}"?` })
    if (!ok) return
    try {
      await api.delete(`/masters/business-units/${unit.id}`)
      success('Unit deleted'); setCheckedIds(prev => prev.filter(x => x !== unit.id)); onChanged()
    } catch (e: any) {
      showError(apiText(e, 'Failed to delete unit'))
    }
  }

  const handleDeleteChecked = async () => {
    if (checkedIds.length === 0) return
    const ok = await confirm({
      title: 'Delete selected units',
      message: `Delete ${checkedIds.length} unit${checkedIds.length === 1 ? '' : 's'}?`,
      confirmText: 'Delete selected',
    })
    if (!ok) return
    setDeleting(true)
    try {
      await Promise.all(checkedIds.map(id => api.delete(`/masters/business-units/${id}`)))
      success('Selected units deleted'); setCheckedIds([]); onChanged()
    } catch (e: any) {
      showError(apiText(e, 'Failed to delete selected units'))
    } finally { setDeleting(false) }
  }

  return (
    <div className="flex h-full flex-col">
      {/* header — mirrors the selected category so the relationship is obvious */}
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-3.5">
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-600">
          <Building2 size={14} />
        </span>
        <h2 className="text-sm font-bold text-slate-900">{category.name}</h2>
        <span className="text-xs font-medium text-slate-400">{units.length} unit{units.length !== 1 ? 's' : ''}</span>
        {checkedIds.length > 0 && (
          <button onClick={handleDeleteChecked} disabled={deleting}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50">
            {deleting ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />} Delete selected ({checkedIds.length})
          </button>
        )}
      </div>

      {/* add row */}
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Add Unit</p>
          <p className="text-xs text-slate-400">Unit names are unique across all verticals</p>
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input id="bu-unit-add" value={name}
              onChange={e => { setName(e.target.value); fe.change('add', e.target.value, UNIT_SPEC) }}
              onBlur={() => { if (name || fe.errors.add) fe.blur('add', name, UNIT_SPEC) }}
              aria-invalid={(dup && name.trim()) || fe.errors.add ? true : undefined}
              aria-describedby={fe.errors.add ? 'bu-unit-add-err' : undefined}
              onKeyDown={e => { if (e.key === 'Enter' && !dup) handleAdd() }}
              placeholder={`New Unit in ${category.name}…`}
              className={`w-full rounded-xl border bg-white px-3.5 py-2.5 pr-8 text-sm text-slate-800 placeholder:text-slate-300 transition-colors focus:outline-none focus:ring-4
                ${(dup && name.trim()) || fe.errors.add
                  ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
                  : 'border-slate-200 focus:border-blue-400 focus:ring-blue-100'}`} />
            {name && (
              <button onClick={() => { setName(''); fe.clear('add') }} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={14} /></button>
            )}
          </div>
          <Button onClick={handleAdd} loading={addSaving} disabled={!name.trim() || !!dup}>
            <Plus size={14} className="mr-1 inline-block" /> Add
          </Button>
        </div>
        {!(dup && name.trim()) && <FieldError id="bu-unit-add" msg={fe.errors.add} />}
        {dup && name.trim() && (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-rose-500">
            <AlertCircle size={12} />
            Already used in <span className="font-semibold">{dup.category_name || 'another vertical'}</span> — a unit belongs to one vertical only.
          </p>
        )}
      </div>

      {/* list */}
      <div className="flex-1 overflow-y-auto">
        {units.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <Building2 size={22} className="mx-auto mb-2 text-slate-300" />
            <p className="text-sm text-slate-400">No units yet</p>
            <p className="mt-0.5 text-xs text-slate-300">Type a name above and click Add</p>
          </div>
        ) : (
          <>
            <label className="flex items-center gap-2.5 border-b border-slate-100 bg-slate-50 px-5 py-2 text-xs font-semibold text-slate-500">
              <input type="checkbox" checked={allChecked}
                onChange={e => setCheckedIds(e.target.checked ? units.map(u => u.id) : [])}
                className="h-4 w-4 rounded border-slate-300 accent-blue-600" />
              Select all
            </label>
            <div className="divide-y divide-slate-50">
              {units.map(unit => {
                const editing = editId === unit.id
                return (
                  <div key={unit.id} className="group flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                    {editing ? (
                      <div className="flex flex-1 items-center gap-2">
                        <div className="flex-1">
                          <InlineInput id="bu-unit-edit" value={editName}
                            onChange={v => { setEditName(v); fe.change('edit', v, UNIT_SPEC) }}
                            onBlur={() => fe.blur('edit', editName, UNIT_SPEC)}
                            error={editDup ? undefined : fe.errors.edit}
                            onSubmit={() => handleEditSave(unit)}
                            onCancel={() => { setEditId(null); fe.clear('edit') }} invalid={!!editDup} autoFocus />
                          {editDup && (
                            <p className="mt-1 flex items-center gap-1 text-xs text-rose-500">
                              <AlertCircle size={10} /> Already used in {editDup.category_name || 'another category'}
                            </p>
                          )}
                        </div>
                        <button onClick={() => handleEditSave(unit)} disabled={editSaving || !editName.trim() || !!editDup}
                          className="flex-shrink-0 rounded-lg p-2 text-emerald-600 hover:bg-emerald-50 disabled:opacity-40" title="Save">
                          {editSaving ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
                        </button>
                        <button onMouseDown={e => e.preventDefault()} onClick={() => { setEditId(null); fe.clear('edit') }} className="flex-shrink-0 rounded-lg p-2 text-slate-400 hover:bg-slate-100" title="Cancel"><X size={14} /></button>
                      </div>
                    ) : (
                      <>
                        <input type="checkbox" checked={checkedIds.includes(unit.id)} onChange={() => toggle(unit.id)}
                          className="h-4 w-4 flex-shrink-0 rounded border-slate-300 accent-blue-600" title="Select unit" />
                        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-bold text-slate-400">
                          {unit.name[0]?.toUpperCase()}
                        </span>
                        <span className="flex-1 truncate text-sm text-slate-800">{unit.name}</span>
                        <div className="flex flex-shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <button onClick={() => { setEditId(unit.id); setEditName(unit.name); fe.clear('edit') }}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-blue-50 hover:text-blue-600" title="Edit"><Pencil size={13} /></button>
                          <button onClick={() => handleDelete(unit)}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500" title="Delete"><Trash2 size={13} /></button>
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

/* ─────────────────────────────────────────────────────────────────────────
   MAIN PAGE
   ───────────────────────────────────────────────────────────────────────── */

export default function BusinessUnitPage({ embedded = false }: { embedded?: boolean }) {
  const [categories, setCategories] = useState<BusinessCategory[]>([])
  const [units, setUnits] = useState<BusinessUnit[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCatId, setSelectedCatId] = useState<number | null>(null)
  const { error: showError } = useToast()
  const showErrorRef = useRef(showError)
  useEffect(() => { showErrorRef.current = showError }, [showError])

  const load = useCallback(async (showPageLoader = false) => {
    if (showPageLoader) setLoading(true)
    try {
      const [catRes, unitRes] = await Promise.all([
        api.get('/masters/business-categories'),
        api.get('/masters/business-units'),
      ])
      const nextCategories = catRes.data as BusinessCategory[]
      const nextUnits = unitRes.data as BusinessUnit[]
      setCategories(nextCategories)
      setUnits(nextUnits)
      setSelectedCatId(current => {
        if (current && nextCategories.some(c => c.id === current)) return current
        return nextCategories[0]?.id ?? null
      })
    } catch {
      showErrorRef.current('Failed to load')
    } finally {
      if (showPageLoader) setLoading(false)
    }
  }, [])

  useEffect(() => { load(true) }, [load])

  const persistCategoryOrder = useCallback(async (orderedIds: number[]) => {
    let previous: BusinessCategory[] = []
    setCategories(current => {
      previous = current
      const byId = new Map(current.map(item => [item.id, item]))
      const ordered = orderedIds.map(id => byId.get(id)).filter(Boolean) as BusinessCategory[]
      const rest = current.filter(item => !orderedIds.includes(item.id))
      return [...ordered, ...rest].map((item, index) => ({ ...item, display_order: index + 1 }))
    })
    try {
      const res = await api.put('/masters/business-categories/order', { ids: orderedIds })
      setCategories(res.data as BusinessCategory[])
    } catch (e: any) {
      setCategories(previous)
      showErrorRef.current(e.response?.data?.detail || 'Failed to save vertical order')
    }
  }, [])

  const moveCategory = useCallback((id: number, direction: -1 | 1) => {
    const index = categories.findIndex(item => item.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= categories.length) return
    const next = categories.map(item => item.id)
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    persistCategoryOrder(next)
  }, [categories, persistCategoryOrder])

  const selectedCategory = useMemo(
    () => categories.find(c => c.id === selectedCatId) ?? null,
    [categories, selectedCatId]
  )
  const unitsForCategory = useMemo(
    () => units.filter(u => u.category_id === selectedCatId),
    [units, selectedCatId]
  )

  if (loading) {
    return (
      <div className={embedded ? '' : 'p-6'}>
        {!embedded && (
          <PageHeader title="Business Verticals" subtitle="Manage verticals and their units"
            breadcrumb={['Settings', 'Masters', 'Business Verticals']} />
        )}
        <div className="rounded-2xl border border-slate-200 bg-white p-16 text-center">
          <RefreshCw size={18} className="mx-auto mb-2 animate-spin text-slate-300" />
          <p className="text-sm text-slate-400">Loading…</p>
        </div>
      </div>
    )
  }

  return (
    <div className={embedded ? '' : 'p-6'}>
      {!embedded && (
        <PageHeader
          title="Business Verticals"
          subtitle="Group Units under a Vertical. Pick a Vertical to manage its Units."
          breadcrumb={['Settings', 'Masters', 'Business Verticals']}
          actions={
            <button onClick={() => load(false)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50">
              <RefreshCw size={13} /> Refresh
            </button>
          }
        />
      )}

      {/* single bordered container, split into two clear panels */}
      <div className="flex overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" style={{ minHeight: 540 }}>
        <div className="flex w-96 flex-shrink-0 flex-col border-r border-slate-200">
          <CategoryPanel
            categories={categories}
            units={units}
            selectedId={selectedCatId}
            onSelect={setSelectedCatId}
            onChanged={() => load(false)}
            onMove={moveCategory}
            onReorder={persistCategoryOrder}
          />
        </div>

        <div className="flex flex-1 flex-col">
          {selectedCategory ? (
            <UnitPanel
              key={selectedCatId}
              category={selectedCategory}
              units={unitsForCategory}
              allUnits={units}
              onChanged={() => load(false)}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
              <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                <Building2 size={20} />
              </span>
              <p className="mb-1 text-sm font-semibold text-slate-500">No category selected</p>
              <p className="text-xs text-slate-400">Select a category on the left, or add a new one.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
