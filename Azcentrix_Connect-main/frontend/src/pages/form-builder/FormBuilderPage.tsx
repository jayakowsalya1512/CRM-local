import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Settings2,
  Plus,
  Pencil,
  Trash2,
  X,
  Save,
  ToggleLeft,
  ToggleRight,
  AlertCircle,
  Loader2,
  Layers,
  Table2,
  LayoutTemplate,
  ArrowLeft,
  EyeOff,
  GripVertical,
  ClipboardList,
} from 'lucide-react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import { PageHeader, FormCard, useToast } from '@/components/ui/FormComponents'
import { FormFieldConfig, formConfigApi } from '@/hooks/useFormConfig'
import { usePermissions } from '@/hooks'
import { useUIStore } from '@/store'
import { confirmAction } from '@/utils/sweetAlert'
import { BUILTIN_FIELDS, MODULES, SECTION_LABELS, SECTION_STEPS, FIELD_TYPES, type BuiltinField } from './constants'
import QuestionnaireFormBuilderPage from '@/pages/questionnaire/QuestionnaireFormBuilderPage'

const QUESTIONNAIRE_MODULE_KEY = 'questionnaire'
const FORM_BUILDER_MODULES = [
  ...MODULES,
  { key: QUESTIONNAIRE_MODULE_KEY, label: 'Questionnaire', icon: ClipboardList },
]

// ─── Types ────────────────────────────────────────────────────────────────────

type BuilderMode = 'fields' | 'layout'

type LayoutItem =
  | {
      kind: 'builtin'
      field_key: string
      label: string
      section: string
      field_type: string
      visible: boolean
      required: boolean
      col_span: number
      sort_order: number
      config?: FormFieldConfig
    }
  | {
      kind: 'custom'
      field_key: string
      label: string
      section: string
      field_type: string
      visible: boolean
      required: boolean
      col_span: number
      sort_order: number
      config: FormFieldConfig
    }

interface FieldFormState {
  section: string
  field_key: string
  field_type: string
  label: string
  placeholder: string
  options: string
  col_span: number
  is_required: boolean
  is_visible: boolean
}

// Draft state for a single builtin row (lifted to SectionPanel)
interface DraftRow {
  label: string
  required: boolean
  visible: boolean
  col_span: 1 | 2
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function fieldTypeLabel(type?: string) {
  return FIELD_TYPES.find(t => t.value === type)?.label || type || 'Text'
}

function widthLabel(colSpan?: number) {
  return colSpan === 2 ? 'Full width' : '1/3 width'
}

function sectionLabel(module: string, section: string) {
  return SECTION_LABELS[`${module}.${section}`] ?? SECTION_LABELS[section] ?? section
}

function sectionStepLabel(module: string, section: string) {
  return SECTION_STEPS[module]?.[section] ?? ''
}

function getFieldSortOrder(field?: FormFieldConfig, fallback = 0) {
  const value = Number(field?.sort_order || 0)
  return value > 0 ? value : fallback
}

function getLayoutItems(module: string, section: string, fields: FormFieldConfig[]): LayoutItem[] {
  const builtins = BUILTIN_FIELDS[module]?.[section] ?? []

  const overrideMap = Object.fromEntries(
    fields
      .filter(f => f.section === section && !f.is_custom)
      .map(f => [f.field_key, f])
  ) as Record<string, FormFieldConfig | undefined>

  const builtinItems: LayoutItem[] = builtins.map((b, index) => {
    const config = overrideMap[b.field_key]
    return {
      kind: 'builtin',
      field_key: b.field_key,
      label: config?.label || b.default_label,
      section,
      field_type: config?.field_type || b.field_type || 'text',
      visible: config?.is_visible ?? true,
      required: config?.is_required ?? b.default_required ?? false,
      col_span: config?.col_span || b.default_col_span || 1,
      sort_order: Number(config?.sort_order || 0) > 0 ? Number(config?.sort_order) : index + 1,
      config,
    }
  })

  const customItems: LayoutItem[] = fields
    .filter(f => f.section === section && f.is_custom)
    .map((f, index) => ({
      kind: 'custom',
      field_key: f.field_key,
      label: f.label,
      section,
      field_type: f.field_type,
      visible: f.is_visible,
      required: f.is_required,
      col_span: f.col_span || 1,
      sort_order: Number(f.sort_order || 0) > 0 ? Number(f.sort_order) : builtins.length + index + 1,
      config: f,
    }))

  return [...builtinItems, ...customItems].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.field_key.localeCompare(b.field_key)
  })
}

const EMPTY_FIELD: FieldFormState = {
  section: '',
  field_key: '',
  field_type: 'text',
  label: '',
  placeholder: '',
  options: '',
  col_span: 1,
  is_required: false,
  is_visible: true,
}

// ─── UnsavedChangesDialog ─────────────────────────────────────────────────────

interface UnsavedChangesDialogProps {
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

function UnsavedChangesDialog({ onSave, onDiscard, onCancel }: UnsavedChangesDialogProps) {
  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-sm rounded-2xl bg-white shadow-2xl">
        <div className="px-6 pt-6 pb-2">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50">
            <AlertCircle size={20} className="text-amber-500" />
          </div>
          <h3 className="text-base font-bold text-gray-900">Unsaved Changes</h3>
          <p className="mt-1.5 text-sm text-gray-500">
            You have unsaved changes in this section. Save them before switching, or discard to continue without saving.
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
          <Button variant="cancel" onClick={onCancel}>Cancel</Button>
          <Button variant="cancel" onClick={onDiscard}>Discard</Button>
          <Button variant="primary" onClick={onSave} leftIcon={<Save size={13} />}>
            <span className="whitespace-nowrap">Save &amp; Continue</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── FieldModal ───────────────────────────────────────────────────────────────

interface FieldModalProps {
  module: string
  sections: string[]
  defaultSection: string
  editing?: FormFieldConfig | null
  onClose: () => void
  onSaved: () => void
}

function FieldModal({ module, sections, defaultSection, editing, onClose, onSaved }: FieldModalProps) {
  const { success, error: showError } = useToast()
  const [saving, setSaving] = useState(false)

  const [form, setForm] = useState<FieldFormState>(() => {
    if (editing) {
      return {
        section: editing.section,
        field_key: editing.field_key,
        field_type: editing.field_type,
        label: editing.label,
        placeholder: editing.placeholder ?? '',
        options: Array.isArray(editing.options)
          ? editing.options
              .map((o: unknown) =>
                typeof o === 'string'
                  ? o
                  : (o as { label?: string; value?: string }).label ||
                    (o as { value?: string }).value ||
                    '',
              )
              .filter(Boolean)
              .join(', ')
          : '',
        col_span: editing.col_span,
        is_required: editing.is_required,
        is_visible: editing.is_visible,
      }
    }
    return { ...EMPTY_FIELD, section: defaultSection || sections[0] || '' }
  })

  const set = (k: keyof FieldFormState, v: unknown) => setForm(p => ({ ...p, [k]: v }))

  const handleLabelChange = (v: string) => {
    set('label', v)
    if (!editing) set('field_key', slug(v))
  }

  const handleSave = async () => {
    if (!form.label.trim()) { showError('Label is required'); return }
    if (!form.section) { showError('Section is required'); return }
    if (!editing && !form.field_key.trim()) { showError('Field key is required'); return }

    const options = form.field_type === 'select' && form.options.trim()
      ? form.options.split(',').map(s => s.trim()).filter(Boolean)
      : undefined

    setSaving(true)
    try {
      if (editing) {
        await formConfigApi.update(module, editing.id, {
          field_type: form.field_type as FormFieldConfig['field_type'],
          label: form.label,
          placeholder: form.placeholder || undefined,
          options,
          col_span: form.col_span as 1 | 2,
          is_required: form.is_required,
          is_visible: form.is_visible,
        })
        success('Field updated')
      } else {
        await formConfigApi.create(module, {
          module,
          section: form.section,
          field_key: form.field_key,
          field_type: form.field_type as FormFieldConfig['field_type'],
          label: form.label,
          placeholder: form.placeholder || undefined,
          options,
          col_span: form.col_span as 1 | 2,
          is_required: form.is_required,
          is_visible: form.is_visible,
          is_custom: true,
          sort_order: 0,
        })
        success('Custom field added')
      }
      onSaved()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      showError(detail || 'Failed to save field')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <div>
            <h3 className="text-base font-bold text-gray-900">
              {editing ? 'Edit Field' : 'Add Custom Field'}
            </h3>
            <p className="mt-0.5 text-xs text-gray-400">
              {editing ? 'Update label, visibility, width, and required status' : 'Create a new configurable field'}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-6 py-4">
          {!editing && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">
                Section <span className="text-red-500">*</span>
              </label>
              <select value={form.section} onChange={e => set('section', e.target.value)} className="form-control">
                {sections.map(s => (
                  <option key={s} value={s}>{sectionLabel(module, s)}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">
              Label <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.label}
              onChange={e => handleLabelChange(e.target.value)}
              placeholder="e.g. Project Code"
              className="form-control"
            />
          </div>

          {!editing && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">
                Field Key <span className="text-red-500">*</span>
                <span className="ml-1 font-normal text-gray-400">(auto generated)</span>
              </label>
              <input
                type="text"
                value={form.field_key}
                onChange={e => set('field_key', e.target.value)}
                placeholder="e.g. project_code"
                className="form-control font-mono text-sm"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Field Type</label>
              <select value={form.field_type} onChange={e => set('field_type', e.target.value)} className="form-control">
                {FIELD_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Width</label>
              <select value={form.col_span} onChange={e => set('col_span', Number(e.target.value))} className="form-control">
                <option value={1}>1/3 width</option>
                <option value={2}>Full width</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Placeholder</label>
            <input
              type="text"
              value={form.placeholder}
              onChange={e => set('placeholder', e.target.value)}
              placeholder="Optional hint text"
              className="form-control"
            />
          </div>

          {form.field_type === 'select' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">
                Options <span className="font-normal text-gray-400">(comma separated)</span>
              </label>
              <input
                type="text"
                value={form.options}
                onChange={e => set('options', e.target.value)}
                placeholder="Option A, Option B, Option C"
                className="form-control"
              />
            </div>
          )}

          <div className="flex items-center gap-6 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={form.is_required}
                onChange={e => set('is_required', e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600"
              />
              <span className="text-sm font-medium text-gray-700">Required</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={form.is_visible}
                onChange={e => set('is_visible', e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600"
              />
              <span className="text-sm font-medium text-gray-700">Visible</span>
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-gray-100 px-6 py-4">
          <Button variant="cancel" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving}
            leftIcon={saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          >
            <span className="whitespace-nowrap">{editing ? 'Update' : 'Add Field'}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── BuiltinFieldRow (controlled — state lifted to SectionPanel) ──────────────

interface BuiltinRowProps {
  index: number
  builtinField: BuiltinField
  override?: FormFieldConfig
  draft: DraftRow
  editingLabel: boolean
  onStartEditLabel: () => void
  onCancelEditLabel: () => void
  onChange: (patch: Partial<DraftRow>) => void
}

function BuiltinFieldRow({
  index,
  builtinField,
  override,
  draft,
  editingLabel,
  onStartEditLabel,
  onCancelEditLabel,
  onChange,
}: BuiltinRowProps) {
  const isRenamed = draft.label !== builtinField.default_label

  return (
    <tr className="group border-b border-gray-100 hover:bg-gray-50/60">
      <td className="w-12 px-4 py-3 text-center">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-gray-100 text-xs font-semibold text-gray-500">
          {index + 1}
        </span>
      </td>

      <td className="px-4 py-3">
        <div className="min-w-0">
          {editingLabel ? (
            <input
              autoFocus
              type="text"
              value={draft.label}
              onChange={e => onChange({ label: e.target.value })}
              className="form-control h-8 text-sm"
              onKeyDown={e => {
                if (e.key === 'Escape') onCancelEditLabel()
              }}
            />
          ) : (
            <button
              type="button"
              onClick={onStartEditLabel}
              className="block max-w-full truncate text-left text-sm font-medium text-gray-900 hover:text-indigo-700"
            >
              {draft.label}
            </button>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className="font-mono text-[11px] text-gray-400">{builtinField.field_key}</span>
            <span className="rounded-full border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">Built-in</span>
            {draft.required && <span className="rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600">Required</span>}
            {isRenamed && <span className="rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600">Renamed</span>}
            {!draft.visible && <span className="rounded-full border border-gray-200 bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">Hidden</span>}
          </div>
        </div>
      </td>

      <td className="px-4 py-3 text-sm text-gray-600">
        {fieldTypeLabel(override?.field_type || builtinField.field_type || 'text')}
      </td>

      <td className="px-4 py-3">
        <select
          value={draft.col_span}
          onChange={e => onChange({ col_span: Number(e.target.value) as 1 | 2 })}
          className="h-8 rounded-lg border border-gray-200 bg-white px-2 text-sm text-gray-600 focus:border-indigo-400 focus:outline-none"
        >
          <option value={1}>1/3 width</option>
          <option value={2}>Full width</option>
        </select>
      </td>

      <td className="px-4 py-3 text-center">
        <input
          type="checkbox"
          checked={draft.required}
          onChange={e => onChange({ required: e.target.checked })}
          className="h-4 w-4 rounded border-gray-300 text-indigo-600"
        />
      </td>

      <td className="px-4 py-3 text-center">
        <button
          type="button"
          onClick={() => onChange({ visible: !draft.visible })}
          className={`inline-flex h-8 w-12 items-center justify-center rounded-lg border transition-colors ${
            draft.visible ? 'border-emerald-200 bg-emerald-50 text-emerald-600' : 'border-gray-200 bg-gray-50 text-gray-400'
          }`}
        >
          {draft.visible ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
        </button>
      </td>

      <td className="px-4 py-3 text-right">
        {editingLabel ? (
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={onCancelEditLabel}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100"
              title="Cancel"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onStartEditLabel}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 opacity-0 transition-opacity hover:bg-indigo-50 hover:text-indigo-600 group-hover:opacity-100"
            title="Edit label"
          >
            <Pencil size={14} />
          </button>
        )}
      </td>
    </tr>
  )
}

// ─── CustomFieldRow ───────────────────────────────────────────────────────────

interface CustomRowProps {
  index: number
  module: string
  field: FormFieldConfig
  onEdit: (f: FormFieldConfig) => void
  onDeleted: () => void
}

function CustomFieldRow({ index, module, field, onEdit, onDeleted }: CustomRowProps) {
  const { success, error: showError } = useToast()
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async () => {
    const confirmed = await confirmAction({
      title: 'Delete custom field?',
      text: `"${field.label}" will be removed from all records.`,
      confirmButtonText: 'Delete',
      icon: 'warning',
    })
    if (!confirmed) return
    setDeleting(true)
    try {
      await formConfigApi.delete(module, field.id)
      success('Field deleted')
      onDeleted()
    } catch {
      showError('Failed to delete field')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <tr className="group border-b border-gray-100 hover:bg-gray-50/60">
      <td className="w-12 px-4 py-3 text-center">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-indigo-50 text-xs font-semibold text-indigo-600">
          {index + 1}
        </span>
      </td>

      <td className="px-4 py-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => onEdit(field)}
            className="block max-w-full truncate text-left text-sm font-medium text-gray-900 hover:text-indigo-700"
          >
            {field.label}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className="font-mono text-[11px] text-gray-400">{field.field_key}</span>
            <span className="rounded-full border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600">Custom</span>
            {field.is_required && <span className="rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600">Required</span>}
            {!field.is_visible && <span className="rounded-full border border-gray-200 bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">Hidden</span>}
          </div>
        </div>
      </td>

      <td className="px-4 py-3 text-sm text-gray-600">{fieldTypeLabel(field.field_type)}</td>
      <td className="px-4 py-3 text-sm text-gray-600">{widthLabel(field.col_span)}</td>

      <td className="px-4 py-3 text-center">
        <input type="checkbox" checked={field.is_required} readOnly className="h-4 w-4 rounded border-gray-300 text-indigo-600" />
      </td>

      <td className="px-4 py-3 text-center">
        <button
          type="button"
          className={`inline-flex h-8 w-12 items-center justify-center rounded-lg border ${
            field.is_visible ? 'border-emerald-200 bg-emerald-50 text-emerald-600' : 'border-gray-200 bg-gray-50 text-gray-400'
          }`}
          onClick={() => onEdit(field)}
        >
          {field.is_visible ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
        </button>
      </td>

      <td className="px-4 py-3 text-right">
        <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => onEdit(field)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-indigo-50 hover:text-indigo-600"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
          >
            {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
        </div>
      </td>
    </tr>
  )
}

// ─── SectionPanel ─────────────────────────────────────────────────────────────

interface SectionPanelProps {
  module: string
  section: string
  sections: string[]
  fields: FormFieldConfig[]
  onAddField: (section: string) => void
  onEditField: (f: FormFieldConfig) => void
  onRefresh: () => void | Promise<void>
  onDirtyChange: (dirty: boolean) => void
  onSectionChange: (section: string) => void
  onModeSwitch: () => void
  allMode?: boolean
  // Exposed save fn so parent can trigger save before navigating away
  saveRef: React.MutableRefObject<(() => Promise<void>) | null>
}

function SectionPanel({ module, section, sections, fields, onAddField, onEditField, onRefresh, onDirtyChange, onSectionChange, onModeSwitch, allMode, saveRef }: SectionPanelProps) {
  const { success, error: showError } = useToast()
  const [saving, setSaving] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)

  const builtins = BUILTIN_FIELDS[module]?.[section] ?? []

  const overrideMap = useMemo(() => (
    Object.fromEntries(
      fields
        .filter(f => f.section === section && !f.is_custom)
        .map(f => [f.field_key, f])
    ) as Record<string, FormFieldConfig | undefined>
  ), [fields, section])

  // Build initial drafts from current overrides (or builtin defaults)
  const buildDrafts = useCallback(() => {
    const d: Record<string, DraftRow> = {}
    builtins.forEach(b => {
      const ov = overrideMap[b.field_key]
      d[b.field_key] = {
        label: ov?.label ?? b.default_label,
        required: ov?.is_required ?? b.default_required ?? false,
        visible: ov?.is_visible ?? true,
        col_span: ((ov?.col_span || b.default_col_span || 1) as 1 | 2),
      }
    })
    return d
  }, [builtins, overrideMap])

  const [drafts, setDrafts] = useState<Record<string, DraftRow>>(buildDrafts)

  // Signature of fields from the server — reset drafts only when server data changes
  const fieldsSignature = fields
    .filter(f => f.section === section && !f.is_custom)
    .map(f => `${f.id}:${f.label}:${f.is_required}:${f.is_visible}:${f.col_span}`)
    .sort()
    .join('|')

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDrafts(buildDrafts())
    setEditingKey(null)
  // fieldsSignature intentionally as string dep
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldsSignature, section, module])

  // Compute dirty: any builtin row differs from its persisted state
  const isDirty = useMemo(() => builtins.some(b => {
    const ov = overrideMap[b.field_key]
    const d = drafts[b.field_key]
    if (!d) return false
    return (
      d.label !== (ov?.label ?? b.default_label) ||
      d.required !== (ov?.is_required ?? b.default_required ?? false) ||
      d.visible !== (ov?.is_visible ?? true) ||
      d.col_span !== ((ov?.col_span || b.default_col_span || 1) as 1 | 2)
    )
  }), [builtins, drafts, overrideMap])

  useEffect(() => { onDirtyChange(isDirty) }, [isDirty, onDirtyChange])

  // Save all dirty builtin rows in one batch
  const handleSaveAll = useCallback(async () => {
    const dirtyBuiltins = builtins.filter(b => {
      const ov = overrideMap[b.field_key]
      const d = drafts[b.field_key]
      if (!d) return false
      return (
        d.label !== (ov?.label ?? b.default_label) ||
        d.required !== (ov?.is_required ?? b.default_required ?? false) ||
        d.visible !== (ov?.is_visible ?? true) ||
        d.col_span !== ((ov?.col_span || b.default_col_span || 1) as 1 | 2)
      )
    })

    if (dirtyBuiltins.length === 0) return

    const emptyLabel = dirtyBuiltins.find(b => !drafts[b.field_key]?.label.trim())
    if (emptyLabel) { showError(`Label is required for "${emptyLabel.default_label}"`); return }

    setSaving(true)
    try {
      await Promise.all(
        dirtyBuiltins.map((b, i) => {
          const ov = overrideMap[b.field_key]
          const d = drafts[b.field_key]
          if (ov) {
            return formConfigApi.update(module, ov.id, {
              label: d.label.trim(),
              is_required: d.required,
              is_visible: d.visible,
              col_span: d.col_span,
            })
          }
          return formConfigApi.create(module, {
            module,
            section,
            field_key: b.field_key,
            field_type: b.field_type || 'text',
            label: d.label.trim(),
            is_required: d.required,
            is_visible: d.visible,
            is_custom: false,
            col_span: d.col_span,
            sort_order: i + 1,
          })
        })
      )
      success('Changes saved')
      setEditingKey(null)
      await onRefresh()
    } catch {
      showError('Failed to save changes')
    } finally {
      setSaving(false)
    }
  }, [builtins, drafts, module, onRefresh, overrideMap, section, showError, success])

  // Expose save fn to parent for "Save & Continue" in the dialog
  useEffect(() => { saveRef.current = handleSaveAll }, [handleSaveAll, saveRef])

  const customFields = fields.filter(f => f.section === section && f.is_custom)

  const rows = [
    ...builtins.map((bf, index) => ({
      kind: 'builtin' as const,
      key: bf.field_key,
      defaultOrder: index + 1,
      sortOrder: getFieldSortOrder(overrideMap[bf.field_key], index + 1),
      builtinField: bf,
      override: overrideMap[bf.field_key],
    })),
    ...customFields.map((field, index) => ({
      kind: 'custom' as const,
      key: field.field_key,
      defaultOrder: builtins.length + index + 1,
      sortOrder: getFieldSortOrder(field, builtins.length + index + 1),
      field,
    })),
  ].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return a.defaultOrder - b.defaultOrder
  })

  const hiddenCount =
    builtins.filter(b => !(drafts[b.field_key]?.visible ?? true)).length +
    customFields.filter(f => !f.is_visible).length

  const totalCount = builtins.length + customFields.length

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px]">
          <thead>
            {/* Toolbar row: section dropdown + mode toggle + actions */}
            <tr className="border-b border-gray-200 bg-white">
              <th colSpan={7} className="px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={allMode ? '' : section}
                      onChange={e => onSectionChange(e.target.value)}
                      className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 focus:outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-200 cursor-pointer"
                    >
                      <option value="">All Sections</option>
                      {sections.map(s => (
                        <option key={s} value={s}>{sectionLabel(module, s)}</option>
                      ))}
                    </select>
                    {sectionStepLabel(module, section) && (
                      <span className="rounded-full border border-indigo-100 bg-indigo-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-indigo-700">
                        {sectionStepLabel(module, section)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {isDirty && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleSaveAll}
                        loading={saving}
                        leftIcon={<Save size={14} />}
                        className="min-w-[132px] rounded-xl px-3.5 shadow-sm"
                      >
                        Save Changes
                      </Button>
                    )}
                    <button
                      onClick={() => onAddField(section)}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-[#071d3a] px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#0b2b55]"
                    >
                      <Plus size={13} />
                      Add field
                    </button>
                    <button
                      type="button"
                      onClick={onModeSwitch}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-600 transition-all hover:bg-gray-100"
                    >
                      <LayoutTemplate size={13} />
                      Layout
                    </button>
                  </div>
                </div>
              </th>
            </tr>
            {/* Column headers */}
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="w-12 px-4 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">No</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Field</th>
              <th className="w-[130px] px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Type</th>
              <th className="w-[150px] px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">Width</th>
              <th className="w-[80px] px-4 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">Req</th>
              <th className="w-[100px] px-4 py-2.5 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">Visible</th>
              <th className="w-[80px] px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              if (row.kind === 'builtin') {
                return (
                  <BuiltinFieldRow
                    key={`builtin-${row.key}`}
                    index={index}
                    builtinField={row.builtinField}
                    override={row.override}
                    draft={drafts[row.key] ?? {
                      label: row.builtinField.default_label,
                      required: row.builtinField.default_required ?? false,
                      visible: true,
                      col_span: row.builtinField.default_col_span ?? 1,
                    }}
                    editingLabel={editingKey === row.key}
                    onStartEditLabel={() => setEditingKey(row.key)}
                    onCancelEditLabel={() => {
                      const ov = overrideMap[row.key]
                      setDrafts(p => ({
                        ...p,
                        [row.key]: { ...p[row.key], label: ov?.label ?? row.builtinField.default_label },
                      }))
                      setEditingKey(null)
                    }}
                    onChange={patch => setDrafts(p => ({ ...p, [row.key]: { ...p[row.key], ...patch } }))}
                  />
                )
              }
              return (
                <CustomFieldRow
                  key={`custom-${row.field.id}`}
                  index={index}
                  module={module}
                  field={row.field}
                  onEdit={onEditField}
                  onDeleted={onRefresh}
                />
              )
            })}
            {totalCount === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-400">
                  No fields configured. Click Add field to start.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── SortableLayoutCard ───────────────────────────────────────────────────────

function SortableLayoutCard({ item, section, isSaving }: { item: LayoutItem; section: string; isSaving: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${section}::${item.field_key}`,
    disabled: isSaving,
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 180ms ease',
    zIndex: isDragging ? 30 : undefined,
  }

  const type = item.field_type || 'text'
  const isTextarea = type === 'textarea'

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`${item.col_span === 2 ? 'md:col-span-2 xl:col-span-3' : ''} min-w-0 select-none transition-all ${
        isDragging ? 'relative z-20 scale-[1.01]' : ''
      } ${isSaving ? 'opacity-60' : ''}`}
    >
      <div
        className={`cursor-grab rounded-xl border bg-white p-2.5 transition-all active:cursor-grabbing ${
          item.visible
            ? isDragging
              ? 'border-indigo-300 bg-indigo-50/50 shadow-lg'
              : 'border-slate-200 hover:border-indigo-200 hover:bg-indigo-50/20 hover:shadow-sm'
            : 'border-dashed border-slate-200 bg-slate-50/70 opacity-70'
        }`}
      >
        <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2">
          <label className="min-w-0 truncate text-xs font-semibold text-slate-600">
            {item.label}{item.required && <span className="ml-1 text-red-500">*</span>}
          </label>

          <div className="flex shrink-0 items-center gap-1.5">
            {!item.visible && <EyeOff size={12} className="text-slate-400" />}
            {isSaving && <Loader2 size={12} className="animate-spin text-indigo-400" />}
          </div>
        </div>

        <div className={`rounded-xl border border-slate-200 bg-slate-50 ${isTextarea ? 'h-20' : 'h-9'}`} />

        <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2">
          <p className="min-w-0 truncate font-mono text-[10px] text-slate-400">{item.field_key}</p>

          <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
            {item.kind === 'custom' ? 'Custom' : widthLabel(item.col_span)}
          </span>
        </div>
      </div>
    </div>
  )
}

// ─── LayoutPreview ────────────────────────────────────────────────────────────

function LayoutPreview({
  module, sections, fields, onRefresh,
}: {
  module: string; sections: string[]; fields: FormFieldConfig[]; onRefresh: () => void | Promise<void>
}) {
  const { success, error: showError } = useToast()
  const [savingSection, setSavingSection] = useState<string | null>(null)

const sensors = useSensors(
  useSensor(PointerSensor, {
    activationConstraint: {
      distance: 4,
    },
  }),
)
  const ensureConfigWithOrder = async (section: string, item: LayoutItem, sortOrder: number) => {
    if (item.kind === 'custom') {
      await formConfigApi.update(module, item.config.id, { sort_order: sortOrder } as Partial<FormFieldConfig>)
      return
    }
    if (item.config) {
      await formConfigApi.update(module, item.config.id, { sort_order: sortOrder } as Partial<FormFieldConfig>)
      return
    }
    await formConfigApi.create(module, {
      module, section, field_key: item.field_key, field_type: item.field_type as FormFieldConfig['field_type'], label: item.label,
      is_required: item.required, is_visible: item.visible, is_custom: false,
      col_span: item.col_span as 1 | 2, sort_order: sortOrder,
    })
  }

  const saveDraggedOrder = async (section: string, activeId: string, overId: string) => {
    const items = getLayoutItems(module, section, fields)
    const oldIndex = items.findIndex(item => `${section}::${item.field_key}` === activeId)
    const newIndex = items.findIndex(item => `${section}::${item.field_key}` === overId)
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return
    const reorderedItems = arrayMove(items, oldIndex, newIndex)
    setSavingSection(section)
    try {
      await Promise.all(reorderedItems.map((item, idx) => ensureConfigWithOrder(section, item, idx + 1)))
      success('Layout order updated')
      await onRefresh()
    } catch { showError('Failed to update layout order') }
    finally { setSavingSection(null) }
  }

  const handleDragEnd = async (section: string, event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    await saveDraggedOrder(section, String(active.id), String(over.id))
  }

  return (
    <div className="border border-slate-200 bg-white shadow-sm">
      <main className="min-w-0">
        {(() => {
          let previousStep = ''

          return sections.map(section => {
          const step = sectionStepLabel(module, section)
          const showStep = !!step && step !== previousStep
          if (step) previousStep = step
          const items = getLayoutItems(module, section, fields)
          const visibleItems = items.filter(item => item.visible)
          const sortableIds = items.map(item => `${section}::${item.field_key}`)

          return (
            <div key={section}>
              {showStep && (
                <div className="border-b border-slate-200 bg-slate-50 px-6 py-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{step}</p>
                </div>
              )}
            <FormCard
              id={`layout-${section}`}
              title={sectionLabel(module, section)}
              icon={Layers}
              action={
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-400">
                    {items.length} fields / {visibleItems.length} visible
                  </span>
                  {savingSection === section && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700">
                      <Loader2 size={12} className="animate-spin" />Saving
                    </span>
                  )}
                </div>
              }
            >
              {false && (
                <div>
                  <div>
                  <p className="mt-0.5 text-xs text-gray-400">{items.length} fields · {visibleItems.length} visible</p>
                </div>
                {savingSection === section && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">
                    <Loader2 size={12} className="animate-spin" />Saving
                  </span>
                )}
              </div>
              )}

              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={event => handleDragEnd(section, event)}>
                <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                  <div className="grid grid-cols-1 gap-x-3 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
                    {items.map(item => (
                      <SortableLayoutCard
                        key={`${section}::${item.field_key}`}
                        item={item}
                        section={section}
                        isSaving={savingSection === section}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              {items.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-400">
                  No fields available in this section.
                </div>
              )}
            </FormCard>
            </div>
          )
          })
        })()}
      </main>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function FormBuilderPage() {
  const [searchParams] = useSearchParams()
  const { can } = usePermissions()
  const { error: showError } = useToast()
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore()
  const requestedModule = searchParams.get('module')
  const initialModule = FORM_BUILDER_MODULES.some(m => m.key === requestedModule) ? requestedModule! : 'customers'

  const [activeModule, setActiveModule] = useState(initialModule)
  const [enabledModuleKeys, setEnabledModuleKeys] = useState<string[] | null>(null)
  const [activeSection, setActiveSection] = useState('')
  const [builderMode, setBuilderMode] = useState<BuilderMode>('fields')

  const [fields, setFields] = useState<FormFieldConfig[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingField, setEditingField] = useState<FormFieldConfig | null>(null)
  const [defaultSection, setDefaultSection] = useState<string>('')

  // The platform tenant configuration is exposed through /modules. Only let
  // administrators configure forms for modules enabled for this tenant.
  useEffect(() => {
    api.get<Array<{ key: string }>>('/modules')
      .then((response) => setEnabledModuleKeys((response.data || []).map((module) => module.key)))
      .catch(() => setEnabledModuleKeys([]))
  }, [])

  const visibleBuilderModules = useMemo(() => {
    if (enabledModuleKeys === null) return []
    return FORM_BUILDER_MODULES.filter((module) => {
      const tenantModuleKey = module.key === 'work_orders' ? 'workorders' : module.key
      return enabledModuleKeys.includes(tenantModuleKey)
    })
  }, [enabledModuleKeys])

  // Dirty-state tracking + guard dialog
  const [sectionDirty, setSectionDirty] = useState(false)
  const [pendingNav, setPendingNav] = useState<{ module?: string; section?: string; mode?: BuilderMode } | null>(null)
  const saveRef = useRef<(() => Promise<void>) | null>(null)
  const layoutSidebarWasCollapsed = useRef<boolean | null>(null)

  const sections = Object.keys(BUILTIN_FIELDS[activeModule] ?? {})
  const activeModuleMeta = visibleBuilderModules.find(m => m.key === activeModule)
  const ActiveModuleIcon = activeModuleMeta?.icon ?? Settings2

  useEffect(() => {
    const nextModule = searchParams.get('module')
    if (nextModule && visibleBuilderModules.some(m => m.key === nextModule)) {
      setActiveModule(nextModule)
    }
  }, [searchParams, visibleBuilderModules])

  useEffect(() => {
    if (!visibleBuilderModules.length || visibleBuilderModules.some((module) => module.key === activeModule)) return
    setActiveModule(visibleBuilderModules[0].key)
  }, [activeModule, visibleBuilderModules])

  useEffect(() => {
    setActiveSection('')
    setBuilderMode(current => activeModule === QUESTIONNAIRE_MODULE_KEY ? 'fields' : current === 'layout' ? 'layout' : 'fields')
    setSectionDirty(false)
  }, [activeModule])

  useEffect(() => {
    if (builderMode === 'layout') {
      if (layoutSidebarWasCollapsed.current === null) {
        layoutSidebarWasCollapsed.current = sidebarCollapsed
      }
      setSidebarCollapsed(true)
      return
    }

    if (layoutSidebarWasCollapsed.current !== null) {
      setSidebarCollapsed(layoutSidebarWasCollapsed.current)
      layoutSidebarWasCollapsed.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builderMode])

  useEffect(() => {
    return () => {
      if (layoutSidebarWasCollapsed.current !== null) {
        setSidebarCollapsed(layoutSidebarWasCollapsed.current)
        layoutSidebarWasCollapsed.current = null
      }
    }
  }, [setSidebarCollapsed])

  const fetchFields = useCallback(async () => {
    if (activeModule === QUESTIONNAIRE_MODULE_KEY) {
      setFields([])
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const res = await api.get<FormFieldConfig[]>(`/form-config/${activeModule}`)
      setFields(res.data)
    } catch {
      showError('Failed to load field configurations')
    } finally {
      setLoading(false)
    }
  }, [activeModule, showError])

  useEffect(() => { fetchFields() }, [fetchFields])

  // Navigation helpers — guard if dirty
  const requestNav = (nav: { module?: string; section?: string; mode?: BuilderMode }) => {
    const nextNav = nav.module === QUESTIONNAIRE_MODULE_KEY ? { ...nav, mode: 'fields' as BuilderMode } : nav
    if (sectionDirty && builderMode === 'fields') {
      setPendingNav(nextNav)
    } else {
      applyNav(nextNav)
    }
  }

  const applyNav = (nav: { module?: string; section?: string; mode?: BuilderMode }) => {
    if (nav.module !== undefined) setActiveModule(nav.module)
    if (nav.section !== undefined) setActiveSection(nav.section)
    if (nav.module === QUESTIONNAIRE_MODULE_KEY) {
      setBuilderMode('fields')
    } else if (nav.mode !== undefined) {
      setBuilderMode(nav.mode)
    }
    setSectionDirty(false)
  }

  const handleDialogSave = async () => {
    if (saveRef.current) await saveRef.current()
    if (pendingNav) applyNav(pendingNav)
    setPendingNav(null)
  }

  const handleDialogDiscard = () => {
    if (pendingNav) applyNav(pendingNav)
    setPendingNav(null)
  }

  const handleDialogCancel = () => setPendingNav(null)

  const handleAddField = (section: string) => { setDefaultSection(section); setEditingField(null); setModalOpen(true) }
  const handleEditField = (f: FormFieldConfig) => { setDefaultSection(f.section); setEditingField(f); setModalOpen(true) }
  const handleModalClose = () => { setModalOpen(false); setEditingField(null) }
  const handleSaved = () => { setModalOpen(false); setEditingField(null); fetchFields() }

  if (!can('form_builder.manage')) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-gray-500">
        <AlertCircle size={32} className="text-gray-300" />
        <p className="text-sm">You don't have permission to access Form Builder.</p>
      </div>
    )
  }

  if (builderMode === 'layout') {
    return (
      <div className="min-h-full bg-slate-50">
        <div className="sticky top-0 z-20 border-b border-slate-100 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => requestNav({ mode: 'fields' })}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
                title="Back to fields table"
              >
                <ArrowLeft size={16} />
              </button>
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                <ActiveModuleIcon size={16} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs text-slate-500">
                  <button
                    type="button"
                    onClick={() => requestNav({ mode: 'fields' })}
                    className="hover:text-slate-800"
                  >
                    Form Builder
                  </button>
                  <span>/</span>
                  <span className="font-medium text-slate-700">Layout</span>
                </div>
                <h1 className="truncate text-sm font-semibold text-slate-900">
                  {activeModuleMeta?.label ?? activeModule} Form Layout
                </h1>
              </div>
            </div>

            <button
              type="button"
              onClick={() => requestNav({ mode: 'fields' })}
              className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-sm transition-all hover:bg-gray-50"
            >
              <Table2 size={13} />
              Fields Table
            </button>
          </div>

          <div className="flex flex-wrap gap-2 px-6 pb-3">
            {visibleBuilderModules.filter(m => m.key !== QUESTIONNAIRE_MODULE_KEY).map(m => {
              const Icon = m.icon
              const active = activeModule === m.key
              return (
                <button
                  key={m.key}
                  onClick={() => requestNav({ module: m.key, mode: 'layout' })}
                  className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-all ${
                    active
                      ? 'border-[#071d3a] bg-[#071d3a] text-white shadow-sm'
                      : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <Icon size={13} className="shrink-0" />
                  {m.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="px-6 py-4">
          {loading ? (
            <div className="flex h-48 items-center justify-center gap-2 border border-gray-200 bg-white text-gray-400 shadow-sm">
              <Loader2 size={20} className="animate-spin" />
              <span className="text-sm">Loading fields...</span>
            </div>
          ) : (
            <LayoutPreview module={activeModule} sections={sections} fields={fields} onRefresh={fetchFields} />
          )}
        </div>

        {modalOpen && (
          <FieldModal
            module={activeModule}
            sections={sections}
            defaultSection={defaultSection || activeSection}
            editing={editingField}
            onClose={handleModalClose}
            onSaved={handleSaved}
          />
        )}

        {pendingNav && (
          <UnsavedChangesDialog
            onSave={handleDialogSave}
            onDiscard={handleDialogDiscard}
            onCancel={handleDialogCancel}
          />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        title="Form Builder"
        subtitle={
          activeModule === QUESTIONNAIRE_MODULE_KEY
            ? 'Configure questionnaire content, questions, properties, and dependent fields'
            : 'Customize field labels, add custom fields, control visibility, and manage layout order'
        }
        breadcrumb={['Form Builder']}
      />

      {/* Module selector */}
      <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
        
        <div className="flex flex-wrap gap-2">
          {visibleBuilderModules.map(m => {
            const Icon = m.icon
            const active = activeModule === m.key
            return (
              <button
                key={m.key}
                onClick={() => requestNav({ module: m.key })}
                className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-all ${
                  active
                    ? 'border-[#071d3a] bg-[#071d3a] text-white shadow-sm'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                <Icon size={14} className="shrink-0" />
                {m.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Section tabs – every category of the selected module, plus "All Sections", as visible
          clickable tabs instead of a dropdown buried inside the field table below. */}
      {activeModule !== QUESTIONNAIRE_MODULE_KEY && !loading && sections.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => requestNav({ section: '', mode: 'fields' })}
              className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-all ${
                !activeSection
                  ? 'border-blue-600 bg-blue-600 text-white shadow-sm'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              All Sections
            </button>
            {sections.map(s => (
              <button
                key={s}
                onClick={() => requestNav({ section: s, mode: 'fields' })}
                className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-all ${
                  activeSection === s
                    ? 'border-blue-600 bg-blue-600 text-white shadow-sm'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                {sectionLabel(activeModule, s)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      {enabledModuleKeys === null ? (
        <div className="flex h-48 items-center justify-center gap-2 rounded-2xl border border-gray-200 bg-white text-gray-400 shadow-sm">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-sm">Loading enabled modules...</span>
        </div>
      ) : activeModule === QUESTIONNAIRE_MODULE_KEY ? (
        <QuestionnaireFormBuilderPage embedded />
      ) : loading ? (
        <div className="flex h-48 items-center justify-center gap-2 rounded-2xl border border-gray-200 bg-white text-gray-400 shadow-sm">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-sm">Loading fields…</span>
        </div>
      ) : sections.length > 0 ? (
        activeSection ? (
          <SectionPanel
            key={`${activeModule}-${activeSection}`}
            module={activeModule}
            section={activeSection}
            sections={sections}
            fields={fields}
            onAddField={handleAddField}
            onEditField={handleEditField}
            onRefresh={fetchFields}
            onDirtyChange={setSectionDirty}
            onSectionChange={s => requestNav({ section: s, mode: 'fields' })}
            onModeSwitch={() => requestNav({ mode: 'layout' })}
            saveRef={saveRef}
          />
        ) : (
          <div className="flex flex-col gap-4">
            {sections.map(s => (
              <SectionPanel
                key={`${activeModule}-${s}`}
                module={activeModule}
                section={s}
                sections={sections}
                fields={fields}
                onAddField={handleAddField}
                onEditField={handleEditField}
                onRefresh={fetchFields}
                onDirtyChange={setSectionDirty}
                onSectionChange={sec => requestNav({ section: sec, mode: 'fields' })}
                onModeSwitch={() => requestNav({ mode: 'layout' })}
                allMode
                saveRef={saveRef}
              />
            ))}
          </div>
        )
      ) : (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-2xl border border-gray-200 bg-white text-gray-400 shadow-sm">
          <AlertCircle size={24} className="text-gray-200" />
          <p className="text-sm">No sections configured for this module yet.</p>
        </div>
      )}

      {/* Add / Edit field modal */}
      {modalOpen && (
        <FieldModal
          module={activeModule}
          sections={sections}
          defaultSection={defaultSection || activeSection}
          editing={editingField}
          onClose={handleModalClose}
          onSaved={handleSaved}
        />
      )}

      {/* Unsaved changes guard dialog */}
      {pendingNav && (
        <UnsavedChangesDialog
          onSave={handleDialogSave}
          onDiscard={handleDialogDiscard}
          onCancel={handleDialogCancel}
        />
      )}
    </div>
  )
}
