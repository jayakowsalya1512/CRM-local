import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  ClipboardList,
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
import { questionnaireApi } from '@/services/api'
import { ConfirmDialog, PageHeader, useToast } from '@/components/ui/FormComponents'
import { usePermissions } from '@/hooks'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { apiFieldErrors, validate, type FieldSpec } from '@/utils/validation'

// Same rules as the backend (questionnaire_router StructureCreate / StructureUpdate)
const SECTION_SPEC: FieldSpec = { label: 'Section title', rule: 'name', required: true, min: 2, max: 200 }
const SUBSECTION_SPEC: FieldSpec = { label: 'Subsection name', rule: 'name', required: true, min: 2, max: 200 }
/** Plain-text message of a failed request (never an object / list). */
const apiText = (e: any, fallback: string) => {
  const d = e?.response?.data?.detail
  return typeof d === 'string' ? d : Object.values(apiFieldErrors(e))[0] || fallback
}
const focusEl = (id: string) => setTimeout(() => document.getElementById(id)?.focus(), 0)

interface QuestionnaireRow {
  id: number
  status: string
}

interface Structure {
  id: number
  questionnaire_id: number
  parent_id: number | null
  structure_type: 'section' | 'subsection'
  structure_code: string
  structure_name: string
  description: string | null
  display_order: number
  is_active: boolean
}

type StructureForm =
  | { mode: 'add'; name: string }
  | { mode: 'edit'; id: number; name: string }
  | null

const DEFAULT_QUESTIONNAIRE_CODE = 'CUSTOMER_QUESTIONNAIRE'
const DEFAULT_QUESTIONNAIRE_NAME = 'Customer Questionnaire'

function displayName(name: string) {
  return String(name || '').trim().replace(/\s+/g, ' ')
}

function initial(name: string) {
  return displayName(name).match(/[a-z0-9]/i)?.[0]?.toUpperCase() || '?'
}

function sectionCode(order: number) {
  let n = Math.max(1, Math.floor(order || 1))
  let code = ''
  while (n > 0) {
    n -= 1
    code = String.fromCharCode(65 + (n % 26)) + code
    n = Math.floor(n / 26)
  }
  return code
}

function makeCode(prefix: 'SEC' | 'SUB', name: string, order: number) {
  const clean = displayName(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 32)

  return clean || `${prefix}_${order}`
}

function PanelEmpty({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-14 text-center">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
        {icon}
      </span>
      <p className="mb-1 text-sm font-semibold text-slate-500">{title}</p>
      <p className="max-w-xs text-xs leading-5 text-slate-400">{description}</p>
    </div>
  )
}

function InlineInput({
  id,
  value,
  onChange,
  onBlur,
  onSubmit,
  onCancel,
  placeholder,
  error,
  wrap,
  autoFocus,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  onSubmit: () => void
  onCancel: () => void
  placeholder: string
  error?: string
  /** wrap input + message in a block (needed inside flex rows so the message sits under the input) */
  wrap?: boolean
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const body = (
    <>
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
        placeholder={placeholder}
        className={`w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-800 outline-none transition-colors placeholder:text-slate-300 focus:ring-4 ${
          error
            ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
            : 'border-blue-300 focus:border-blue-400 focus:ring-blue-100'
        }`}
      />
      <FieldError id={id} msg={error} />
    </>
  )
  return wrap ? <div className="w-full">{body}</div> : body
}

function IconButton({
  title,
  onClick,
  disabled,
  children,
  tone = 'slate',
}: {
  title: string
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  children: React.ReactNode
  tone?: 'slate' | 'blue' | 'rose' | 'emerald'
}) {
  const toneClass = {
    slate: 'hover:bg-slate-100 hover:text-slate-700',
    blue: 'hover:bg-blue-50 hover:text-blue-600',
    rose: 'hover:bg-rose-50 hover:text-rose-500',
    emerald: 'hover:bg-emerald-50 hover:text-emerald-600',
  }[tone]

  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md p-1.5 text-slate-400 transition-colors disabled:cursor-not-allowed disabled:opacity-25 ${toneClass}`}
    >
      {children}
    </button>
  )
}

function SectionFormRow({
  form,
  saving,
  error,
  onBlur,
  onChange,
  onSave,
  onCancel,
}: {
  form: NonNullable<StructureForm>
  saving: boolean
  error?: string
  onBlur?: () => void
  onChange: (form: NonNullable<StructureForm>) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
      <InlineInput
        id="qm-section-name"
        value={form.name}
        onChange={name => onChange({ ...form, name })}
        onBlur={onBlur}
        error={error}
        onSubmit={onSave}
        onCancel={onCancel}
        placeholder="Section title"
        autoFocus
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !form.name.trim()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-600 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {saving ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />} Save
        </button>
        <button
          type="button"
          onMouseDown={event => event.preventDefault()}
          onClick={onCancel}
          className="rounded-lg px-3 py-2 text-slate-400 hover:bg-slate-100"
          title="Cancel"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  )
}

function SectionPanel({
  sections,
  subsections,
  selectedId,
  canCreate,
  canUpdate,
  saving,
  statusUpdatingId,
  form,
  formError,
  onFormBlur,
  onFormChange,
  onSelect,
  onAdd,
  onSave,
  onCancel,
  onEdit,
  onToggle,
  onMove,
}: {
  sections: Structure[]
  subsections: Structure[]
  selectedId: number | null
  canCreate: boolean
  canUpdate: boolean
  saving: boolean
  statusUpdatingId: number | null
  form: StructureForm
  formError?: string
  onFormBlur?: () => void
  onFormChange: (form: NonNullable<StructureForm>) => void
  onSelect: (id: number) => void
  onAdd: () => void
  onSave: () => void
  onCancel: () => void
  onEdit: (section: Structure) => void
  onToggle: (section: Structure) => void
  onMove: (section: Structure, direction: -1 | 1) => void
}) {
  const countOf = useMemo(() => {
    const counts: Record<number, number> = {}
    subsections.forEach(item => {
      if (item.parent_id) counts[item.parent_id] = (counts[item.parent_id] ?? 0) + 1
    })
    return counts
  }, [subsections])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3.5">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Sections</p>
          <p className="text-xs font-medium text-slate-300">{sections.length} configured</p>
        </div>
        {canCreate && (
          <button
            type="button"
            onClick={onAdd}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-50"
          >
            <Plus size={13} /> Add
          </button>
        )}
      </div>

      {form && (
        <SectionFormRow
          form={form}
          saving={saving}
          error={formError}
          onBlur={onFormBlur}
          onChange={onFormChange}
          onSave={onSave}
          onCancel={onCancel}
        />
      )}

      <div className="flex-1 overflow-y-auto">
        {sections.length === 0 ? (
          <PanelEmpty icon={<FolderOpen size={20} />} title="No sections yet" description="Add a section to start building subsections." />
        ) : (
          <>
            <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              <span>Section</span>
              <span>Section Title</span>
            </div>
            {sections.map((section, index) => {
              const selected = selectedId === section.id
              const inactive = !section.is_active
              const count = countOf[section.id] ?? 0
              const code = sectionCode(section.display_order || index + 1)

              return (
                <div
                  key={section.id}
                  className={`group border-b border-slate-50 transition-colors ${
                    selected
                      ? 'border-l-2 border-l-blue-500 bg-blue-50'
                      : 'border-l-2 border-l-transparent hover:bg-slate-50'
                  }`}
                >
                  <div className="relative flex items-center gap-2 px-3 py-2.5">
                    <GripVertical size={14} className="shrink-0 text-slate-300" />
                    <button
                      type="button"
                      onClick={() => onSelect(section.id)}
                      className="grid min-w-0 flex-1 grid-cols-[72px_minmax(0,1fr)] items-center gap-3 text-left"
                    >
                      <span
                        className={`inline-flex h-8 w-14 items-center justify-center rounded-lg text-sm font-black tracking-wide ${
                          selected ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {code}
                      </span>
                      <span className="min-w-0">
                        <span className={`block truncate text-sm ${selected ? 'font-semibold text-blue-700' : 'font-semibold text-slate-800'} ${inactive ? 'line-through opacity-50' : ''}`}>
                          {displayName(section.structure_name)}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5">
                          <span className="text-xs font-medium text-slate-400">
                            {count} subsection{count === 1 ? '' : 's'}
                          </span>
                          {inactive && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">Inactive</span>}
                        </span>
                      </span>
                    </button>
                    <ChevronRight
                      size={14}
                      className={`flex-shrink-0 transition-opacity ${
                        selected ? 'text-blue-400 opacity-100' : 'text-slate-300 opacity-0 group-hover:opacity-100'
                      }`}
                    />

                    {canUpdate && (
                      <div className="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-lg bg-white/95 px-1 shadow-sm opacity-0 transition-opacity group-hover:opacity-100">
                        <IconButton title="Move up" disabled={index === 0} onClick={event => { event.stopPropagation(); onMove(section, -1) }}>
                          <ArrowUp size={12} />
                        </IconButton>
                        <IconButton title="Move down" disabled={index === sections.length - 1} onClick={event => { event.stopPropagation(); onMove(section, 1) }}>
                          <ArrowDown size={12} />
                        </IconButton>
                        <IconButton title="Edit section" tone="blue" onClick={event => { event.stopPropagation(); onEdit(section) }}>
                          <Pencil size={13} />
                        </IconButton>
                        <IconButton
                          title={section.is_active ? 'Delete section' : 'Activate section'}
                          tone={section.is_active ? 'rose' : 'emerald'}
                          disabled={statusUpdatingId === section.id}
                          onClick={event => { event.stopPropagation(); onToggle(section) }}
                        >
                          {statusUpdatingId === section.id
                            ? <RefreshCw size={13} className="animate-spin" />
                            : section.is_active ? <Trash2 size={13} /> : <Check size={13} />}
                        </IconButton>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}

function SubsectionPanel({
  section,
  subsections,
  canCreate,
  canUpdate,
  saving,
  statusUpdatingId,
  form,
  formError,
  onFormBlur,
  onFormChange,
  onAdd,
  onSave,
  onCancel,
  onEdit,
  onToggle,
  onMove,
}: {
  section: Structure
  subsections: Structure[]
  canCreate: boolean
  canUpdate: boolean
  saving: boolean
  statusUpdatingId: number | null
  form: StructureForm
  formError?: string
  onFormBlur?: () => void
  onFormChange: (form: NonNullable<StructureForm>) => void
  onAdd: () => void
  onSave: () => void
  onCancel: () => void
  onEdit: (subsection: Structure) => void
  onToggle: (subsection: Structure) => void
  onMove: (subsection: Structure, direction: -1 | 1) => void
}) {
  const addForm = form?.mode === 'add' ? form : null
  const editForm = form?.mode === 'edit' ? form : null
  const [checkedIds, setCheckedIds] = useState<number[]>([])
  const allChecked = subsections.length > 0 && checkedIds.length === subsections.length

  useEffect(() => {
    setCheckedIds(current => current.filter(id => subsections.some(item => item.id === id)))
  }, [subsections])

  const toggleChecked = (id: number) => {
    setCheckedIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }

  const updateAddName = (name: string) => {
    onFormChange(addForm ? { ...addForm, name } : { mode: 'add', name })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-3.5">
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-600">
          <Layers size={14} />
        </span>
        <h2 className="truncate text-sm font-bold text-slate-900">{displayName(section.structure_name)}</h2>
        <span className="text-xs font-medium text-slate-400">
          {subsections.length} subsection{subsections.length !== 1 ? 's' : ''}
        </span>
      </div>

      {canCreate && (
        <div className="border-b border-slate-100 px-5 py-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Add Subsection</p>
            <p className="text-xs text-slate-400">Names are unique inside the selected section</p>
          </div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                id="qm-subsection-add"
                value={addForm?.name || ''}
                onChange={event => updateAddName(event.target.value)}
                onBlur={() => { if (addForm) onFormBlur?.() }}
                aria-invalid={addForm && formError ? true : undefined}
                aria-describedby={addForm && formError ? 'qm-subsection-add-err' : undefined}
                onKeyDown={event => {
                  if (event.key === 'Enter' && addForm) onSave()
                  if (event.key === 'Escape' && addForm) onCancel()
                }}
                disabled={!section.is_active}
                placeholder={`New subsection in ${displayName(section.structure_name)}...`}
                className={`h-12 w-full rounded-xl border bg-white px-4 text-sm text-slate-800 outline-none transition-colors placeholder:text-slate-300 focus:ring-4 disabled:bg-slate-50 disabled:text-slate-400 ${
                  addForm && formError
                    ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
                    : 'border-slate-200 focus:border-blue-400 focus:ring-blue-100'
                }`}
              />
            </div>
            <button
              type="button"
              onClick={onSave}
              disabled={!section.is_active || saving || !addForm?.name.trim()}
              className="inline-flex h-12 items-center gap-2 rounded-xl bg-slate-600 px-5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              title={section.is_active ? 'Add subsection' : 'Activate the section before adding subsections'}
            >
              {saving && addForm ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={15} />} Add
            </button>
          </div>
          <FieldError id="qm-subsection-add" msg={addForm ? formError : undefined} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {subsections.length === 0 ? (
          <PanelEmpty icon={<Layers size={20} />} title="No subsections yet" description="Add a subsection under the selected section." />
        ) : (
          <>
            <label className="flex items-center gap-2.5 border-b border-slate-100 bg-slate-50 px-5 py-2 text-xs font-semibold text-slate-500">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={event => setCheckedIds(event.target.checked ? subsections.map(item => item.id) : [])}
                className="h-4 w-4 rounded border-slate-300 accent-blue-600"
              />
              Select all
            </label>
            <div className="divide-y divide-slate-50">
              {subsections.map((subsection, index) => {
                const inactive = !subsection.is_active
                const editing = editForm?.id === subsection.id

                return (
                  <div key={subsection.id} className="group flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                    {editing ? (
                      <div className="flex flex-1 items-center gap-2">
                        <InlineInput
                          id="qm-subsection-edit"
                          value={editForm.name}
                          onChange={name => onFormChange({ ...editForm, name })}
                          onBlur={onFormBlur}
                          error={formError}
                          wrap
                          onSubmit={onSave}
                          onCancel={onCancel}
                          placeholder="Subsection name"
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={onSave}
                          disabled={saving || !editForm.name.trim()}
                          className="flex-shrink-0 rounded-lg p-2 text-emerald-600 hover:bg-emerald-50 disabled:opacity-40"
                          title="Save"
                        >
                          {saving ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
                        </button>
                        <button
                          type="button"
                          onMouseDown={event => event.preventDefault()}
                          onClick={onCancel}
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
                          checked={checkedIds.includes(subsection.id)}
                          onChange={() => toggleChecked(subsection.id)}
                          className="h-4 w-4 flex-shrink-0 rounded border-slate-300 accent-blue-600"
                          title="Select subsection"
                        />
                        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-bold text-slate-400">
                          {initial(subsection.structure_name)}
                        </span>
                        <span className={`flex-1 truncate text-sm text-slate-800 ${inactive ? 'line-through opacity-50' : ''}`}>
                          {displayName(subsection.structure_name)}
                        </span>
                        {inactive && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">Inactive</span>}
                        {canUpdate && (
                          <div className="flex flex-shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            <IconButton title="Move up" disabled={index === 0} onClick={event => { event.stopPropagation(); onMove(subsection, -1) }}>
                              <ArrowUp size={12} />
                            </IconButton>
                            <IconButton title="Move down" disabled={index === subsections.length - 1} onClick={event => { event.stopPropagation(); onMove(subsection, 1) }}>
                              <ArrowDown size={12} />
                            </IconButton>
                            <IconButton title="Edit subsection" tone="blue" onClick={event => { event.stopPropagation(); onEdit(subsection) }}>
                              <Pencil size={13} />
                            </IconButton>
                            <IconButton
                              title={subsection.is_active ? 'Delete subsection' : 'Activate subsection'}
                              tone={subsection.is_active ? 'rose' : 'emerald'}
                              disabled={statusUpdatingId === subsection.id}
                              onClick={event => { event.stopPropagation(); onToggle(subsection) }}
                            >
                              {statusUpdatingId === subsection.id
                                ? <RefreshCw size={13} className="animate-spin" />
                                : subsection.is_active ? <Trash2 size={13} /> : <Check size={13} />}
                            </IconButton>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function QuestionnaireMasterPage({
  embedded = false,
  reloadKey = 0,
}: {
  embedded?: boolean
  reloadKey?: number
}) {
  const { can } = usePermissions()
  const canView = can('questionnaire.view')
  const canCreate = can('questionnaire.create')
  const canUpdate = can('questionnaire.update')
  const { success, error: showError } = useToast()
  const showErrorRef = useRef(showError)
  const mountedRef = useRef(false)

  const [questionnaires, setQuestionnaires] = useState<QuestionnaireRow[]>([])
  const [selectedQuestionnaireId, setSelectedQuestionnaireId] = useState<number | null>(null)
  const [structure, setStructure] = useState<Structure[]>([])
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [loadingQuestionnaires, setLoadingQuestionnaires] = useState(false)
  const [loadingStructure, setLoadingStructure] = useState(false)
  const [sectionForm, setSectionForm] = useState<StructureForm>(null)
  const [subsectionForm, setSubsectionForm] = useState<StructureForm>(null)
  const [savingStructure, setSavingStructure] = useState(false)
  const [statusUpdatingId, setStatusUpdatingId] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Structure | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  useEffect(() => {
    showErrorRef.current = showError
  }, [showError])

  const sections = useMemo(
    () => structure
      .filter(item => item.structure_type === 'section')
      .sort((a, b) => a.display_order - b.display_order || a.id - b.id),
    [structure],
  )

  const subsections = useMemo(
    () => structure
      .filter(item => item.structure_type === 'subsection')
      .sort((a, b) => a.display_order - b.display_order || a.id - b.id),
    [structure],
  )

  const filteredSections = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return sections

    return sections.filter(section => {
      const sectionMatches = [section.structure_name, section.structure_code]
        .some(value => String(value || '').toLowerCase().includes(query))
      const childMatches = subsections
        .filter(sub => sub.parent_id === section.id)
        .some(sub => [sub.structure_name, sub.structure_code].some(value => String(value || '').toLowerCase().includes(query)))

      return sectionMatches || childMatches
    })
  }, [search, sections, subsections])

  const selectedSection = useMemo(
    () => sections.find(item => item.id === selectedSectionId) ?? null,
    [sections, selectedSectionId],
  )

  const subsectionsForSelected = useMemo(
    () => subsections.filter(item => item.parent_id === selectedSectionId),
    [selectedSectionId, subsections],
  )

  const loading = loadingQuestionnaires || loadingStructure

  const loadQuestionnaires = useCallback(async (showLoader = false) => {
    if (!canView) return
    if (showLoader) setLoadingQuestionnaires(true)

    try {
      const response = await questionnaireApi.listQuestionnaires()
      let rows = (response.data || []) as QuestionnaireRow[]

      if (!rows.length && canCreate) {
        const created = await questionnaireApi.createQuestionnaire({
          questionnaire_code: DEFAULT_QUESTIONNAIRE_CODE,
          questionnaire_name: DEFAULT_QUESTIONNAIRE_NAME,
          description: 'Default setup used for questionnaire sections and subsections.',
        })
        rows = created.data ? [created.data as QuestionnaireRow] : []
      }

      setQuestionnaires(rows)
    } catch (error: any) {
      showErrorRef.current(error.response?.data?.detail || 'Failed to load setup')
    } finally {
      if (showLoader) setLoadingQuestionnaires(false)
    }
  }, [canCreate, canView])

  const loadStructure = useCallback(async (questionnaireId: number, showLoader = false) => {
    if (!canView) return
    if (showLoader) setLoadingStructure(true)

    try {
      const response = await questionnaireApi.listStructure(questionnaireId, true)
      setStructure(response.data || [])
    } catch (error: any) {
      showErrorRef.current(error.response?.data?.detail || 'Failed to load sections')
    } finally {
      if (showLoader) setLoadingStructure(false)
    }
  }, [canView])

  useEffect(() => {
    loadQuestionnaires(true)
  }, [loadQuestionnaires])

  useEffect(() => {
    if (!questionnaires.length) {
      setSelectedQuestionnaireId(null)
      setStructure([])
      return
    }

    setSelectedQuestionnaireId(current => {
      if (current && questionnaires.some(item => item.id === current)) return current
      return questionnaires[0].id
    })
  }, [questionnaires])

  useEffect(() => {
    setSectionForm(null)
    setSubsectionForm(null)
    setSelectedSectionId(null)
    setStructure([])

    if (selectedQuestionnaireId) loadStructure(selectedQuestionnaireId, true)
  }, [loadStructure, selectedQuestionnaireId])

  useEffect(() => {
    setSelectedSectionId(current => {
      if (current && sections.some(item => item.id === current)) return current
      return sections[0]?.id ?? null
    })
  }, [sections])

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }

    loadQuestionnaires(false)
    if (selectedQuestionnaireId) loadStructure(selectedQuestionnaireId, false)
  }, [loadQuestionnaires, loadStructure, reloadKey, selectedQuestionnaireId])

  const refreshStructure = () => {
    if (selectedQuestionnaireId) loadStructure(selectedQuestionnaireId, false)
  }

  // ── field validation: format while typing, required on blur / save, duplicate titles inside the same parent ──
  const fe = useFieldErrors()
  type Kind = 'section' | 'subsection'
  const specOf = (kind: Kind) => (kind === 'section' ? SECTION_SPEC : SUBSECTION_SPEC)
  const fieldIdOf = (kind: Kind, form: StructureForm) =>
    kind === 'section' ? 'qm-section-name' : form?.mode === 'edit' ? 'qm-subsection-edit' : 'qm-subsection-add'
  const dupMsg = (kind: Kind, form: StructureForm) => {
    if (!form) return ''
    const name = displayName(form.name).toLowerCase()
    if (!name) return ''
    const siblings = kind === 'section' ? sections : subsections.filter(item => item.parent_id === selectedSectionId)
    const hit = siblings.find(item => (form.mode !== 'edit' || item.id !== form.id) && displayName(item.structure_name).toLowerCase() === name)
    if (!hit) return ''
    const what = kind === 'section' ? 'A section' : 'A subsection in this section'
    return `${what} with this name already exists${hit.is_active ? '' : ' (inactive – activate it instead)'}.`
  }
  const checkForm = (kind: Kind, form: StructureForm, mode: 'change' | 'blur') => {
    if (!form) { fe.clear(kind); return }
    const spec = specOf(kind)
    if (mode === 'change') fe.change(kind, form.name, spec)
    else fe.blur(kind, form.name, spec)
    const dup = !validate(form.name, { ...spec, required: false }) ? dupMsg(kind, form) : ''
    if (dup) fe.setError(kind, dup)
  }
  const fullCheck = (kind: Kind, form: StructureForm) => {
    if (!form) return false
    const message = validate(form.name, specOf(kind)) || dupMsg(kind, form)
    fe.blur(kind, form.name, specOf(kind))
    if (message) {
      fe.setError(kind, message)
      focusEl(fieldIdOf(kind, form))
    }
    return !message
  }
  const serverError = (kind: Kind, form: StructureForm, error: any, fallback: string) => {
    const fields = apiFieldErrors(error)
    const message = fields.structure_name || fields.parent_id
    if (message) {
      fe.setError(kind, message)
      focusEl(fieldIdOf(kind, form))
    } else {
      showError(apiText(error, fallback))
    }
  }
  const changeSectionForm = (form: StructureForm) => {
    setSectionForm(form)
    checkForm('section', form, 'change')
  }
  const changeSubsectionForm = (form: StructureForm) => {
    setSubsectionForm(form)
    checkForm('subsection', form, 'change')
  }
  const openSectionForm = (form: StructureForm) => {
    setSectionForm(form)
    fe.clear('section')
  }
  const openSubsectionForm = (form: StructureForm) => {
    setSubsectionForm(form)
    fe.clear('subsection')
  }

  const saveSection = async () => {
    if (!selectedQuestionnaireId || !sectionForm) return
    if (!fullCheck('section', sectionForm)) return
    const name = displayName(sectionForm.name)

    setSavingStructure(true)
    try {
      if (sectionForm.mode === 'add') {
        const displayOrder = sections.length + 1
        const response = await questionnaireApi.createStructure({
          questionnaire_id: selectedQuestionnaireId,
          parent_id: null,
          structure_type: 'section',
          structure_code: sectionCode(displayOrder),
          structure_name: name,
          description: null,
          display_order: displayOrder,
        })
        setSelectedSectionId(response.data?.id ?? selectedSectionId)
        success('Section added')
      } else {
        await questionnaireApi.updateStructure(sectionForm.id, { structure_name: name })
        success('Section updated')
      }

      openSectionForm(null)
      refreshStructure()
    } catch (error: any) {
      serverError('section', sectionForm, error, 'Failed to save section')
    } finally {
      setSavingStructure(false)
    }
  }

  const saveSubsection = async () => {
    if (!selectedQuestionnaireId || !selectedSection || !subsectionForm) return
    if (!fullCheck('subsection', subsectionForm)) return
    const name = displayName(subsectionForm.name)

    setSavingStructure(true)
    try {
      if (subsectionForm.mode === 'add') {
        const displayOrder = subsectionsForSelected.length + 1
        await questionnaireApi.createStructure({
          questionnaire_id: selectedQuestionnaireId,
          parent_id: selectedSection.id,
          structure_type: 'subsection',
          structure_code: makeCode('SUB', name, displayOrder),
          structure_name: name,
          description: null,
          display_order: displayOrder,
        })
        success('Subsection added')
      } else {
        await questionnaireApi.updateStructure(subsectionForm.id, { structure_name: name })
        success('Subsection updated')
      }

      openSubsectionForm(null)
      refreshStructure()
    } catch (error: any) {
      serverError('subsection', subsectionForm, error, 'Failed to save subsection')
    } finally {
      setSavingStructure(false)
    }
  }

  const activateStructure = async (row: Structure) => {
    if (!canUpdate) return
    setStatusUpdatingId(row.id)

    try {
      await questionnaireApi.setStructureStatus(row.id, true)
      success('Activated')
      refreshStructure()
    } catch (error: any) {
      showError(error.response?.data?.detail || 'Failed to update status')
    } finally {
      setStatusUpdatingId(null)
    }
  }

  const handleRowAction = (row: Structure) => {
    if (row.is_active) {
      setConfirmDelete(row)
    } else {
      activateStructure(row)
    }
  }

  const confirmDeleteRow = async () => {
    if (!confirmDelete || deletingId !== null) return
    setDeletingId(confirmDelete.id)

    try {
      await questionnaireApi.deleteStructure(confirmDelete.id)
      success(confirmDelete.structure_type === 'section' ? 'Section deleted' : 'Subsection deleted')
      if (confirmDelete.structure_type === 'section' && selectedSectionId === confirmDelete.id) {
        setSelectedSectionId(null)
      }
      setConfirmDelete(null)
      refreshStructure()
    } catch (error: any) {
      showError(error.response?.data?.detail || 'Failed to delete')
    } finally {
      setDeletingId(null)
    }
  }

  const moveStructure = async (list: Structure[], row: Structure, direction: -1 | 1) => {
    if (!canUpdate) return
    const index = list.findIndex(item => item.id === row.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= list.length) return

    const ordered = [...list]
    ;[ordered[index], ordered[target]] = [ordered[target], ordered[index]]

    try {
      await questionnaireApi.reorderStructure(ordered.map(item => item.id))
      refreshStructure()
    } catch (error: any) {
      showError(error.response?.data?.detail || 'Failed to reorder')
    }
  }

  if (!canView) {
    return (
      <div className={embedded ? '' : 'p-6'}>
        {!embedded && (
          <PageHeader
            title="Questionnaire"
            subtitle="Manage sections and subsections"
            breadcrumb={['Settings', 'Masters', 'Questionnaire']}
          />
        )}
        <div className="rounded-2xl border border-slate-200 bg-white p-14 text-center shadow-sm">
          <ClipboardList size={24} className="mx-auto mb-3 text-slate-300" />
          <p className="text-sm font-semibold text-slate-500">Access is not enabled for this role.</p>
        </div>
      </div>
    )
  }

  if (loading && !structure.length) {
    return (
      <div className={embedded ? '' : 'p-6'}>
        {!embedded && (
          <PageHeader
            title="Questionnaire"
            subtitle="Manage sections and subsections"
            breadcrumb={['Settings', 'Masters', 'Questionnaire']}
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
          title="Questionnaire"
          subtitle="Manage sections and subsections"
          breadcrumb={['Settings', 'Masters', 'Questionnaire']}
          actions={
            <button
              type="button"
              onClick={() => {
                loadQuestionnaires(false)
                if (selectedQuestionnaireId) loadStructure(selectedQuestionnaireId, false)
              }}
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
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
            placeholder="Search sections..."
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
          {filteredSections.length} of {sections.length}
        </p>
      </div>

      <div className="flex overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" style={{ minHeight: 540 }}>
        <div className="flex w-96 flex-shrink-0 flex-col border-r border-slate-200">
          <SectionPanel
            sections={filteredSections}
            subsections={subsections}
            selectedId={selectedSectionId}
            canCreate={canCreate && !!selectedQuestionnaireId}
            canUpdate={canUpdate}
            saving={savingStructure}
            statusUpdatingId={statusUpdatingId}
            form={sectionForm}
            formError={fe.errors.section}
            onFormBlur={() => checkForm('section', sectionForm, 'blur')}
            onFormChange={changeSectionForm}
            onSelect={id => {
              setSelectedSectionId(id)
              openSubsectionForm(null)
            }}
            onAdd={() => {
              openSectionForm({ mode: 'add', name: '' })
              openSubsectionForm(null)
            }}
            onSave={saveSection}
            onCancel={() => openSectionForm(null)}
            onEdit={section => {
              openSectionForm({ mode: 'edit', id: section.id, name: displayName(section.structure_name) })
              openSubsectionForm(null)
            }}
            onToggle={handleRowAction}
            onMove={(section, direction) => moveStructure(sections, section, direction)}
          />
        </div>

        <div className="flex flex-1 flex-col">
          {selectedSection ? (
            <SubsectionPanel
              key={selectedSection.id}
              section={selectedSection}
              subsections={subsectionsForSelected}
              canCreate={canCreate && !!selectedQuestionnaireId}
              canUpdate={canUpdate}
              saving={savingStructure}
              statusUpdatingId={statusUpdatingId}
              form={subsectionForm}
              formError={fe.errors.subsection}
              onFormBlur={() => checkForm('subsection', subsectionForm, 'blur')}
              onFormChange={changeSubsectionForm}
              onAdd={() => openSubsectionForm({ mode: 'add', name: '' })}
              onSave={saveSubsection}
              onCancel={() => openSubsectionForm(null)}
              onEdit={subsection => openSubsectionForm({ mode: 'edit', id: subsection.id, name: displayName(subsection.structure_name) })}
              onToggle={handleRowAction}
              onMove={(subsection, direction) => moveStructure(subsectionsForSelected, subsection, direction)}
            />
          ) : (
            <PanelEmpty icon={<Layers size={20} />} title="No section selected" description="Select a section on the left, or add a new one." />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete?.structure_type === 'section' ? 'Delete Section' : 'Delete Subsection'}
        message={`This will permanently delete "${confirmDelete ? displayName(confirmDelete.structure_name) : ''}". This cannot be undone.`}
        confirmLabel={deletingId === confirmDelete?.id ? 'Deleting…' : 'Delete'}
        variant="danger"
        onConfirm={confirmDeleteRow}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
