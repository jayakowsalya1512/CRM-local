import { useEffect, useMemo, useState } from 'react'
import {
  ClipboardList,
  FileText,
  Layers,
  RefreshCw,
  Rocket,
  Search,
} from 'lucide-react'
import { questionnaireApi } from '@/services/api'
import { FormCard, FormGrid, useToast, ConfirmDialog } from '@/components/ui/FormComponents'
import FormPageHeader from '@/components/ui/FormPageHeader'
import { Input, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { usePermissions } from '@/hooks'
import { useUIStore } from '@/store'
import { confirmAction } from '@/utils/sweetAlert'
import { Ic } from '@/components/crm/kit'
import QuestionnaireAnswerField, { QElement } from './QuestionnaireAnswerField'
import { useQuestionnaireTabs } from './QuestionnaireTabs'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './questionnaire.css'
import {
  INPUT_TYPES,
  MASTER_KEYS,
  FormState,
  blankForm,
  buildOptionsJson,
  buildValidationJson,
  decodeValidation,
  isYesNoAnswerType,
} from './questionnaireFormShared'

interface Structure {
  id: number
  parent_id: number | null
  structure_type: 'section' | 'subsection'
  structure_code: string
  structure_name: string
  display_order: number
  is_active: boolean
}

interface QuestionnaireRow {
  id: number
  questionnaire_code: string
  questionnaire_name: string
  status: string
}

function questionnaireOptionLabel(item: QuestionnaireRow): string {
  return `${item.questionnaire_code} - ${item.questionnaire_name}`
}

type FieldCondition = 'always' | 'yes' | 'no'

type FieldDraft = {
  id?: number
  element_label: string
  input_type: string
  placeholder: string
  default_value: string
  validationText: string
  crmNote: string
  is_required: boolean
  is_active: boolean
  optionsSource: 'custom' | 'master'
  optionsText: string
  masterKey: string
  condition: FieldCondition
  children: FieldDraft[]
}

function isSelectInputType(inputType: string) {
  return inputType === 'single_select' || inputType === 'multi_select'
}

function fieldSupportsSubConditions(inputType: string) {
  return inputType === 'yes_no' || inputType === 'yes_no_conditional'
}

function blankFieldDraft(condition: FieldCondition = 'always'): FieldDraft {
  return {
    element_label: '', input_type: 'text', placeholder: '', default_value: '', validationText: '', crmNote: '', is_required: false, is_active: true,
    optionsSource: 'custom', optionsText: '', masterKey: 'customer_categories', condition, children: [],
  }
}

function conditionFromShowWhen(operator?: string | null, value?: string | null): FieldCondition {
  if (operator === 'equals' && (value || '').trim().toLowerCase() === 'yes') return 'yes'
  if (operator === 'equals' && (value || '').trim().toLowerCase() === 'no') return 'no'
  return 'always'
}

function showWhenFromCondition(condition: FieldCondition): { show_when_operator: string | null; show_when_value: string | null } {
  if (condition === 'yes') return { show_when_operator: 'equals', show_when_value: 'yes' }
  if (condition === 'no') return { show_when_operator: 'equals', show_when_value: 'no' }
  return { show_when_operator: null, show_when_value: null }
}

function fieldToDraft(field: QElement): FieldDraft {
  const options = field.options_json as any
  const isMaster = options && typeof options === 'object' && !Array.isArray(options) && options.source_type === 'master'
  const { validationText, crmNote } = decodeValidation(field.validation_json)
  return {
    id: field.id,
    element_label: field.element_label || '',
    input_type: field.input_type || 'text',
    placeholder: field.placeholder || '',
    default_value: field.default_value || '',
    validationText,
    crmNote,
    is_required: !!field.is_required,
    is_active: field.is_active !== false,
    optionsSource: isMaster ? 'master' : 'custom',
    optionsText: Array.isArray(options)
      ? options.map((item: any) => `${item.label ?? item.value}|${item.value ?? item.label}`).join('\n')
      : '',
    masterKey: isMaster ? options.master_key : 'customer_categories',
    condition: conditionFromShowWhen(field.show_when_operator, field.show_when_value),
    children: [],
  }
}

function fieldDraftHasWork(draft: FieldDraft): boolean {
  return Boolean(draft.id || draft.element_label.trim() || (draft.children || []).some(fieldDraftHasWork))
}

function pruneFieldDrafts(drafts: FieldDraft[]): FieldDraft[] {
  return drafts
    .filter(fieldDraftHasWork)
    .map((draft) => ({ ...draft, children: pruneFieldDrafts(draft.children || []) }))
}

function flattenFieldDrafts(drafts: FieldDraft[]): FieldDraft[] {
  return drafts.flatMap((draft) => [draft, ...flattenFieldDrafts(draft.children || [])])
}

function hasMissingFieldLabel(drafts: FieldDraft[]): boolean {
  return flattenFieldDrafts(drafts).some((draft) => fieldDraftHasWork(draft) && !draft.element_label.trim())
}

type QuestionBlock = {
  form: FormState
  fieldDrafts: FieldDraft[]
}

function blankQuestionBlock(order: number): QuestionBlock {
  return { form: blankForm(order), fieldDrafts: [blankFieldDraft('yes'), blankFieldDraft('no')] }
}

type Selection =
  | { kind: 'new-question'; sectionId: number; subsectionId: number }
  | { kind: 'edit-question'; element: QElement }
  | null

type QuestionnaireFormBuilderPageProps = {
  embedded?: boolean
}

const QUESTION_ANSWER_TYPES = [
  { value: 'text', label: 'Question Heading Only' },
  { value: 'yes_no_conditional', label: 'Yes / No' },
]

function makeElementCode(label: string, fallback: string) {
  const normalized = label
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return normalized || fallback
}

function makeFieldCode(question: { id: number; element_code?: string | null }, order: number, label: string) {
  const parent = makeElementCode(question.element_code || `Q${question.id}`, `Q${question.id}`).slice(0, 28)
  const child = makeElementCode(label, `FIELD_${order}`).slice(0, 30)
  return `${parent}_${order}_${child}`.slice(0, 90)
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

function formFromElement(element: QElement): FormState {
  const options = element.options_json as any
  const isMaster = options && typeof options === 'object' && !Array.isArray(options) && options.source_type === 'master'
  const { validationText, crmNote } = decodeValidation(element.validation_json)

  return {
    element_code: element.element_code || '',
    element_label: element.element_label || '',
    input_type: element.input_type || 'text',
    is_required: !!element.is_required,
    allow_remarks: !!element.allow_remarks,
    display_order: element.display_order || 0,
    placeholder: element.placeholder || '',
    default_value: element.default_value || '',
    validationText,
    crmNote,
    show_when_operator: element.show_when_operator || '',
    show_when_value: element.show_when_value || '',
    optionsSource: isMaster ? 'master' : 'custom',
    optionsText: Array.isArray(options)
      ? options.map((item: any) => `${item.label ?? item.value}|${item.value ?? item.label}`).join('\n')
      : '',
    masterKey: isMaster ? options.master_key : 'customer_categories',
    is_active: element.is_active !== false,
  }
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex min-h-[260px] flex-col items-center justify-center px-8 text-center">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
        {icon}
      </span>
      <p className="text-sm font-bold text-slate-600">{title}</p>
      <p className="mt-1 max-w-xs text-sm leading-5 text-slate-400">{description}</p>
    </div>
  )
}

function SmallIconButton({
  title,
  disabled,
  onClick,
  children,
  tone = 'slate',
}: {
  title: string
  disabled?: boolean
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
  tone?: 'slate' | 'blue' | 'rose' | 'emerald'
}) {
  const toneClass = {
    slate: '',
    blue: 'qn-icon-btn-blue',
    rose: 'qn-icon-btn-rose',
    emerald: 'qn-icon-btn-emerald',
  }[tone]

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`btn g s ${toneClass}`}
    >
      {children}
    </button>
  )
}

function QuestionFlags({
  required,
  active,
  onRequiredChange,
  onActiveChange,
}: {
  required: boolean
  active: boolean
  onRequiredChange: (checked: boolean) => void
  onActiveChange: (checked: boolean) => void
}) {
  return (
    <div className="row wrap mt" style={{ gap: 16 }}>
      <label className="row" style={{ gap: 8 }}>
        <span className="sw">
          <input
            type="checkbox"
            checked={required}
            onChange={(event) => onRequiredChange(event.target.checked)}
          />
          <i />
        </span>
        <span className="font-semibold" style={{ fontSize: 13 }}>Required</span>
      </label>
      <label className="row" style={{ gap: 8 }}>
        <span className="sw">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => onActiveChange(event.target.checked)}
          />
          <i />
        </span>
        <span className="font-semibold" style={{ fontSize: 13 }}>Active</span>
      </label>
    </div>
  )
}

export default function QuestionnaireFormBuilderPage({ embedded = false }: QuestionnaireFormBuilderPageProps = {}) {
  const { success, error: showError } = useToast()
  const { can } = usePermissions()
  const canPublish = can('questionnaire.update')
  const questionnaireTabs = useQuestionnaireTabs()

  const [questionnaires, setQuestionnaires] = useState<QuestionnaireRow[]>([])
  const [questionnaireId, setQuestionnaireId] = useState<number | null>(null)
  const [structure, setStructure] = useState<Structure[]>([])
  const [elements, setElements] = useState<QElement[]>([])
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(null)
  const [selectedSubsectionId, setSelectedSubsectionId] = useState<number | null>(null)
  const [selectedQuestionId, setSelectedQuestionId] = useState<number | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const setNavSidebarCollapsed = useUIStore((s) => s.setSidebarCollapsed)
  const [form, setForm] = useState<FormState>(blankForm())
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewData, setPreviewData] = useState<{ sections: Structure[]; subsections: Structure[]; questions: QElement[]; fields: QElement[] } | null>(null)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [fieldDrafts, setFieldDrafts] = useState<FieldDraft[]>([])
  const [questionBlocks, setQuestionBlocks] = useState<QuestionBlock[]>([])

  // Collapse the main nav sidebar while the question editor (new/edit) is open to give it more room
  useEffect(() => {
    setNavSidebarCollapsed(selection !== null)
    return () => setNavSidebarCollapsed(false)
  }, [selection, setNavSidebarCollapsed])

  const currentQuestionnaire = questionnaires.find((item) => item.id === questionnaireId)
  const sections = useMemo(
    () => structure.filter((item) => item.structure_type === 'section').sort((a, b) => a.display_order - b.display_order || a.id - b.id),
    [structure],
  )
  const subsections = useMemo(
    () => structure.filter((item) => item.structure_type === 'subsection').sort((a, b) => a.display_order - b.display_order || a.id - b.id),
    [structure],
  )
  const selectedSection = sections.find((item) => item.id === selectedSectionId) || null
  const selectedSubsection = subsections.find((item) => item.id === selectedSubsectionId) || null

  const subsectionsOf = (sectionId: number) =>
    subsections.filter((item) => item.parent_id === sectionId)

  const questionsOf = (subsectionId: number | null) =>
    elements
      .filter((item) => item.element_type === 'question' && item.subsection_id === subsectionId && item.is_active !== false)
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0) || a.id - b.id)

  const fieldsOf = (questionId: number | null) =>
    elements
      .filter((item) => item.element_type === 'field' && item.parent_element_id === questionId && item.is_active !== false)
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0) || a.id - b.id)

  const fieldDraftTreeOf = (parentElementId: number): FieldDraft[] =>
    fieldsOf(parentElementId)
      .filter((field) => conditionFromShowWhen(field.show_when_operator, field.show_when_value) !== 'always')
      .map((field) => ({
        ...fieldToDraft(field),
        children: fieldDraftTreeOf(field.id),
      }))

  const descendantFieldsOf = (parentElementId: number): QElement[] =>
    fieldsOf(parentElementId).flatMap((field) => [field, ...descendantFieldsOf(field.id)])

  const selectedQuestions = useMemo(() => questionsOf(selectedSubsectionId), [elements, selectedSubsectionId])
  const selectedQuestion = elements.find((item) => item.id === selectedQuestionId && item.element_type === 'question') || null

  const filteredQuestions = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return selectedQuestions
    return selectedQuestions.filter((item) =>
      [item.element_code, item.element_label, item.input_type].some((value) => String(value || '').toLowerCase().includes(query)),
    )
  }, [search, selectedQuestions])

  const loadQuestionnaires = () => {
    questionnaireApi
      .listQuestionnaires()
      .then((res) => {
        const rows: QuestionnaireRow[] = Array.isArray(res.data) ? res.data : []
        const sorted = [...rows].sort((a, b) => questionnaireOptionLabel(a).localeCompare(questionnaireOptionLabel(b)))
        setQuestionnaires(sorted)
        setQuestionnaireId((current) => {
          if (current && sorted.some((item) => item.id === current)) return current
          return sorted[0]?.id || null
        })
      })
      .catch((error: any) => showError(error?.response?.data?.detail || 'Failed to load questionnaires'))
  }

  const loadAll = (qid: number) => {
    setLoading(true)
    Promise.all([
      questionnaireApi.listStructure(qid, false),
      questionnaireApi.listElements(qid, undefined, true),
    ])
      .then(([structureRes, elementRes]) => {
        setStructure(structureRes.data || [])
        setElements(elementRes.data || [])
      })
      .catch(() => showError('Failed to load form builder data'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadQuestionnaires()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setStructure([])
    setElements([])
    setSelectedSectionId(null)
    setSelectedSubsectionId(null)
    setSelectedQuestionId(null)
    setSelection(null)
    setForm(blankForm())
    setQuestionBlocks([])
    setSearch('')
    if (questionnaireId) loadAll(questionnaireId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionnaireId])

  useEffect(() => {
    if (!sections.length) return
    setSelectedSectionId((current) => {
      if (current && sections.some((item) => item.id === current)) return current
      return sections[0].id
    })
  }, [sections])

  useEffect(() => {
    if (!selectedSectionId) {
      setSelectedSubsectionId(null)
      return
    }
    const subs = subsectionsOf(selectedSectionId)
    setSelectedSubsectionId((current) => {
      if (current && subs.some((item) => item.id === current)) return current
      return subs[0]?.id || null
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSectionId, subsections])

  useEffect(() => {
    setSelection(null)
    setForm(blankForm())
    setQuestionBlocks([])
    setSelectedQuestionId((current) => {
      if (current && selectedQuestions.some((item) => item.id === current)) return current
      return null
    })
    setSearch('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSubsectionId])

  const selectQuestion = (question: QElement) => {
    setSelectedQuestionId(question.id)
    setSelection({ kind: 'edit-question', element: question })
    setForm(formFromElement(question))
    setFieldDrafts(fieldDraftTreeOf(question.id))
  }

  const startNewQuestion = () => {
    if (!selectedSection || !selectedSubsection) return
    setSelectedQuestionId(null)
    setSelection({ kind: 'new-question', sectionId: selectedSection.id, subsectionId: selectedSubsection.id })
    setQuestionBlocks([blankQuestionBlock(selectedQuestions.length + 1)])
  }

  const addQuestionBlock = () => {
    setQuestionBlocks((prev) => [...prev, blankQuestionBlock(selectedQuestions.length + prev.length + 1)])
  }

  const removeQuestionBlock = (index: number) => {
    setQuestionBlocks((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))
  }

  const updateQuestionBlockForm = (index: number, updater: (prev: FormState) => FormState) => {
    setQuestionBlocks((prev) => prev.map((block, i) => (i === index ? { ...block, form: updater(block.form) } : block)))
  }

  const updateQuestionBlockFields = (index: number, drafts: FieldDraft[]) => {
    setQuestionBlocks((prev) => prev.map((block, i) => (i === index ? { ...block, fieldDrafts: drafts } : block)))
  }

  const persistFieldDrafts = async ({
    drafts,
    parentElementId,
    parentCode,
    sectionId,
    subsectionId,
  }: {
    drafts: FieldDraft[]
    parentElementId: number
    parentCode: string
    sectionId: number
    subsectionId: number
  }) => {
    if (!questionnaireId) return

    let order = 1
    for (const draft of drafts) {
      const label = draft.element_label.trim()
      if (!label) continue

      const fieldPayload = {
        element_label: label,
        input_type: draft.input_type,
        placeholder: draft.placeholder.trim() || null,
        default_value: draft.default_value.trim() || null,
        validation_json: buildValidationJson(draft.validationText, draft.crmNote),
        is_required: draft.is_required,
        display_order: order,
        options_json: isSelectInputType(draft.input_type) ? buildOptionsJson(draft) : null,
        ...showWhenFromCondition(draft.condition),
      }

      let fieldId = draft.id || null
      let fieldCode = makeFieldCode({ id: parentElementId, element_code: parentCode }, order, label)

      if (draft.id) {
        await questionnaireApi.updateElement(draft.id, fieldPayload)
        const original = elements.find((field) => field.id === draft.id)
        fieldCode = original?.element_code || fieldCode
        if (original && original.is_active !== draft.is_active) {
          await questionnaireApi.setElementStatus(draft.id, draft.is_active)
        }
      } else {
        const fieldRes = await questionnaireApi.createElement({
          ...fieldPayload,
          questionnaire_id: questionnaireId,
          section_id: sectionId,
          subsection_id: subsectionId,
          element_type: 'field',
          parent_element_id: parentElementId,
          element_code: fieldCode,
          allow_remarks: false,
        })
        fieldId = fieldRes.data?.id || null
        fieldCode = fieldRes.data?.element_code || fieldCode
        if (!draft.is_active && fieldId) await questionnaireApi.setElementStatus(fieldId, false)
      }

      if (fieldId && fieldSupportsSubConditions(draft.input_type)) {
        await persistFieldDrafts({
          drafts: draft.children || [],
          parentElementId: fieldId,
          parentCode: fieldCode,
          sectionId,
          subsectionId,
        })
      }

      order += 1
    }
  }

  const save = async () => {
    if (!questionnaireId || !selection || selection.kind !== 'edit-question') return
    if (!form.element_code.trim() || !form.element_label.trim()) {
      showError('Question code and text are required')
      return
    }
    const fieldsToPersist = pruneFieldDrafts(fieldDrafts)
    if (hasMissingFieldLabel(fieldsToPersist)) {
      showError('Each additional field needs a name')
      return
    }
    const flatFieldsToPersist = flattenFieldDrafts(fieldsToPersist)
    const hasConditionalFields = flatFieldsToPersist.some((draft) => (draft.condition || 'always') !== 'always')
    const isYesNoQuestion = isYesNoAnswerType(form.input_type) || hasConditionalFields
    const canSaveWithoutFields = isYesNoQuestion
    if (fieldsToPersist.length === 0 && !canSaveWithoutFields) {
      showError('Add at least one field before saving this question')
      return
    }

    const payload: Record<string, unknown> = {
      element_code: form.element_code.trim(),
      element_label: form.element_label.trim(),
      input_type: hasConditionalFields ? 'yes_no_conditional' : form.input_type || 'text',
      is_required: form.is_required,
      allow_remarks: false,
      display_order: form.display_order || 0,
      options_json: null,
      placeholder: null,
      default_value: null,
      validation_json: buildValidationJson(form.validationText, form.crmNote),
    }

    setSaving(true)
    try {
      await questionnaireApi.updateElement(selection.element.id, payload)
      const questionId = selection.element.id
      const sectionId = selection.element.section_id!
      const subsectionId = selection.element.subsection_id!
      const parentCode = selection.element.element_code
      if (selection.element.is_active !== form.is_active) {
        await questionnaireApi.setElementStatus(questionId, form.is_active)
      }

      const existingFields = descendantFieldsOf(questionId)
      const keptIds = new Set(flatFieldsToPersist.map((draft) => draft.id).filter((id): id is number => !!id))
      for (const existing of existingFields) {
        if (!keptIds.has(existing.id)) {
          await questionnaireApi.setElementStatus(existing.id, false)
        }
      }

      await persistFieldDrafts({
        drafts: fieldsToPersist,
        parentElementId: questionId,
        parentCode,
        sectionId,
        subsectionId,
      })

      setSelectedQuestionId(questionId)
      success('Question updated')
      setSelection(null)
      setForm(blankForm())
      setFieldDrafts([])
      loadAll(questionnaireId)
    } catch (error: any) {
      showError(error.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const saveNewQuestions = async () => {
    if (!questionnaireId || !selection || selection.kind !== 'new-question') return
    if (questionBlocks.some((block) => !block.form.element_code.trim() || !block.form.element_label.trim())) {
      showError('Each question needs a code and text')
      return
    }
    const blockFieldsToPersist = questionBlocks.map((block) => pruneFieldDrafts(block.fieldDrafts))
    if (blockFieldsToPersist.some(hasMissingFieldLabel)) {
      showError('Each additional field needs a name')
      return
    }
    if (blockFieldsToPersist.some((fields, index) => {
      const flatFields = flattenFieldDrafts(fields)
      const hasConditionalFields = flatFields.some((draft) => (draft.condition || 'always') !== 'always')
      const formInputType = questionBlocks[index]?.form.input_type || 'text'
      return fields.length === 0 && !isYesNoAnswerType(formInputType) && !hasConditionalFields
    })) {
      showError('Add at least one field to each question before saving')
      return
    }

    setSaving(true)
    try {
      for (const [blockIndex, block] of questionBlocks.entries()) {
        const fieldsToPersist = blockFieldsToPersist[blockIndex]
        const flatFieldsToPersist = flattenFieldDrafts(fieldsToPersist)
        const hasConditionalFields = flatFieldsToPersist.some((draft) => (draft.condition || 'always') !== 'always')
        const payload: Record<string, unknown> = {
          element_code: block.form.element_code.trim(),
          element_label: block.form.element_label.trim(),
          input_type: hasConditionalFields ? 'yes_no_conditional' : block.form.input_type || 'text',
          is_required: block.form.is_required,
          allow_remarks: false,
          display_order: block.form.display_order || 0,
          options_json: null,
          placeholder: null,
          default_value: null,
          validation_json: buildValidationJson(block.form.validationText, block.form.crmNote),
        }
        const res = await questionnaireApi.createElement({
          ...payload,
          questionnaire_id: questionnaireId,
          section_id: selection.sectionId,
          subsection_id: selection.subsectionId,
          element_type: 'question',
          parent_element_id: null,
        })
        const questionId = res.data?.id || null
        const parentCode = res.data?.element_code || block.form.element_code

        if (questionId) {
          await persistFieldDrafts({
            drafts: fieldsToPersist,
            parentElementId: questionId,
            parentCode,
            sectionId: selection.sectionId,
            subsectionId: selection.subsectionId,
          })
        }

        if (!block.form.is_active && questionId) await questionnaireApi.setElementStatus(questionId, false)
      }

      success(questionBlocks.length > 1 ? `${questionBlocks.length} questions added` : 'Question added')
      setSelection(null)
      setQuestionBlocks([])
      loadAll(questionnaireId)
    } catch (error: any) {
      showError(error.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const softDelete = async (element: QElement) => {
    if (!questionnaireId) return
    const label = element.element_type === 'field' ? 'dependent field' : 'question'
    const confirmed = await confirmAction({
      title: `Delete ${label}?`,
      text: `This ${label} will be removed.`,
      confirmButtonText: 'Delete',
      icon: 'warning',
    })
    if (!confirmed) return

    try {
      await questionnaireApi.setElementStatus(element.id, false)
      if (element.id === selectedQuestionId) setSelectedQuestionId(null)
      if (selection && 'element' in selection && selection.element.id === element.id) {
        setSelection(null)
        setForm(blankForm())
      }
      success(`${label[0].toUpperCase()}${label.slice(1)} removed`)
      loadAll(questionnaireId)
    } catch (error: any) {
      showError(error.response?.data?.detail || `Failed to delete ${label}`)
    }
  }

  const move = async (list: QElement[], element: QElement, direction: -1 | 1) => {
    if (!questionnaireId) return
    const index = list.findIndex((item) => item.id === element.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= list.length) return

    const reordered = [...list]
    ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]

    try {
      await questionnaireApi.reorderElements(reordered.map((item) => item.id))
      loadAll(questionnaireId)
    } catch (error: any) {
      showError(error.response?.data?.detail || 'Failed to reorder')
    }
  }

  const openPreview = () => {
    if (!questionnaireId) return
    questionnaireApi
      .preview(questionnaireId)
      .then((res) => setPreviewData(res.data))
      .then(() => setPreviewOpen(true))
      .catch(() => showError('Failed to load preview'))
  }

  const doPublish = async () => {
    if (!questionnaireId) return
    try {
      await questionnaireApi.publish(questionnaireId)
      success('Questionnaire published')
      setConfirmPublish(false)
      loadQuestionnaires()
    } catch (error: any) {
      showError(error.response?.data?.detail || 'Publish failed')
      setConfirmPublish(false)
    }
  }

  const previewGrouped = useMemo(() => {
    if (!previewData) return []
    return previewData.sections.map((section) => ({
      section,
      subsections: previewData.subsections.filter((sub) => sub.parent_id === section.id).map((subsection) => ({
        subsection,
        questions: previewData.questions.filter((question) => question.subsection_id === subsection.id).map((question) => ({
          question,
          fields: previewData.fields.filter((field) => field.parent_element_id === question.id),
        })),
      })),
    }))
  }, [previewData])

  const isNewQuestionForm = selection?.kind === 'new-question'
  const headerActions = (
    <div className="row" style={{ gap: 8 }}>
      <button type="button" className="btn g s" onClick={openPreview} disabled={!questionnaireId}>
        <Ic n="eye" /> Preview
      </button>
      {canPublish && (
        <button
          type="button"
          className="btn p s"
          onClick={() => setConfirmPublish(true)}
          disabled={!questionnaireId || currentQuestionnaire?.status === 'published'}
        >
          <Rocket size={13} /> {currentQuestionnaire?.status === 'published' ? 'Published' : 'Publish'}
        </button>
      )}
    </div>
  )

  if (isNewQuestionForm) {
    const closeNewQuestion = () => { setSelection(null); setQuestionBlocks([]) }
    return (
      <div className="min-h-screen bg-slate-50">
        <div className="w-full">
          <div className="bg-white border border-slate-200 shadow-sm">
            <FormPageHeader
              breadcrumb={selectedSection && selectedSubsection ? `${selectedSection.structure_name} / ${selectedSubsection.structure_name}` : 'Questions'}
              onBreadcrumbClick={closeNewQuestion}
              title="Question"
              isEdit={false}
              onCancel={closeNewQuestion}
              onSave={saveNewQuestions}
              saving={saving}
            />
            <main className="min-w-0 p-4">
              {questionBlocks.map((block, index) => (
                <div key={index} className="mb-4 rounded-2xl border border-slate-100 bg-slate-50/40 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-black uppercase tracking-wider text-slate-500">Question {index + 1}</p>
                    {questionBlocks.length > 1 && (
                      <SmallIconButton title="Remove this question" tone="rose" onClick={() => removeQuestionBlock(index)}>
                        <Ic n="trash" />
                      </SmallIconButton>
                    )}
                  </div>

                  <FormCard id={`question-details-${index}`} title="Question Details" icon={FileText}>
                    <FormGrid cols={2}>
                      <Input
                        label="Question Code"
                        value={block.form.element_code}
                        onChange={(event) => updateQuestionBlockForm(index, (prev) => ({ ...prev, element_code: event.target.value }))}
                        required
                      />
                      <Input
                        label="Display Order"
                        type="number"
                        value={block.form.display_order}
                        onChange={(event) => updateQuestionBlockForm(index, (prev) => ({ ...prev, display_order: Number(event.target.value) }))}
                      />
                      <label className="block sm:col-span-2">
                        <span className="mb-1 block text-sm font-medium text-slate-700">Answer Type</span>
                        <select
                          value={isYesNoAnswerType(block.form.input_type) ? 'yes_no_conditional' : 'text'}
                          onChange={(event) => updateQuestionBlockForm(index, (prev) => ({ ...prev, input_type: event.target.value }))}
                          className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                        >
                          {QUESTION_ANSWER_TYPES.map((type) => (
                            <option key={type.value} value={type.value}>{type.label}</option>
                          ))}
                        </select>
                      </label>
                    </FormGrid>
                    <div className="mt-2.5">
                      <Textarea
                        label="Question Text"
                        value={block.form.element_label}
                        onChange={(event) => updateQuestionBlockForm(index, (prev) => ({ ...prev, element_label: event.target.value }))}
                        rows={3}
                        required
                      />
                      <QuestionFlags
                        required={block.form.is_required}
                        active={block.form.is_active}
                        onRequiredChange={(checked) => updateQuestionBlockForm(index, (prev) => ({ ...prev, is_required: checked }))}
                        onActiveChange={(checked) => updateQuestionBlockForm(index, (prev) => ({ ...prev, is_active: checked }))}
                      />
                    </div>
                  </FormCard>

                  <AdditionalFieldsEditor
                    drafts={block.fieldDrafts}
                    onChange={(drafts) => updateQuestionBlockFields(index, drafts)}
                  />
                </div>
              ))}

              <button
                type="button"
                onClick={addQuestionBlock}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-blue-200 bg-blue-50/60 px-3 py-2.5 text-xs font-bold text-blue-600 transition hover:bg-blue-50"
              >
                <Ic n="plus" /> Add Another Question
              </button>
            </main>
          </div>
        </div>
      </div>
    )
  }

  const isEditQuestionForm = selection?.kind === 'edit-question'
  if (isEditQuestionForm) {
    const closeEditQuestion = () => { setSelection(null); setForm(blankForm()) }
    return (
      <div className="min-h-screen bg-slate-50">
        <div className="w-full">
          <div className="bg-white border border-slate-200 shadow-sm">
            <FormPageHeader
              breadcrumb={selectedSection && selectedSubsection ? `${selectedSection.structure_name} / ${selectedSubsection.structure_name}` : 'Questions'}
              onBreadcrumbClick={closeEditQuestion}
              title="Question"
              isEdit
              onCancel={closeEditQuestion}
              onSave={save}
              saving={saving}
            />
            <main className="min-w-0 p-4">
              <FormCard id="question-details" title="Question Details" icon={FileText}>
                <FormGrid cols={2}>
                  <Input
                    label="Question Code"
                    value={form.element_code}
                    onChange={(event) => setForm((prev) => ({ ...prev, element_code: event.target.value }))}
                    required
                  />
                  <Input
                    label="Display Order"
                    type="number"
                    value={form.display_order}
                    onChange={(event) => setForm((prev) => ({ ...prev, display_order: Number(event.target.value) }))}
                  />
                  <label className="block sm:col-span-2">
                    <span className="mb-1 block text-sm font-medium text-slate-700">Answer Type</span>
                    <select
                      value={isYesNoAnswerType(form.input_type) ? 'yes_no_conditional' : 'text'}
                      onChange={(event) => setForm((prev) => ({ ...prev, input_type: event.target.value }))}
                      className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    >
                      {QUESTION_ANSWER_TYPES.map((type) => (
                        <option key={type.value} value={type.value}>{type.label}</option>
                      ))}
                    </select>
                  </label>
                </FormGrid>
                <div className="mt-2.5">
                  <Textarea
                    label="Question Text"
                    value={form.element_label}
                    onChange={(event) => setForm((prev) => ({ ...prev, element_label: event.target.value }))}
                    rows={3}
                    required
                  />
                  <QuestionFlags
                    required={form.is_required}
                    active={form.is_active}
                    onRequiredChange={(checked) => setForm((prev) => ({ ...prev, is_required: checked }))}
                    onActiveChange={(checked) => setForm((prev) => ({ ...prev, is_active: checked }))}
                  />
                </div>
              </FormCard>

              <AdditionalFieldsEditor drafts={fieldDrafts} onChange={setFieldDrafts} />
            </main>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={embedded ? '' : 'bwi'}>
      {embedded ? (
        <div className="panel mb">
          <div className="pb row wrap" style={{ gap: 12, justifyContent: 'space-between' }}>
            <div className="min-w-0">
              <h2 className="font-bold" style={{ fontSize: 14 }}>Questionnaire Content</h2>
              <p className="mu mt" style={{ fontSize: 12 }}>
                Select master sections and subsections to manage configured questions.
              </p>
            </div>
            {headerActions}
          </div>
        </div>
      ) : (
        <div className="pg">
          <div><div className="crumb">Questionnaire</div><h1>Form Builder</h1></div>
          <span className="cnt">Configure questionnaire content using sections and subsections maintained in Master Setup</span>
          <span className="fl" />
          {questionnaireTabs}
          {headerActions}
        </div>
      )}

      <div className="g g2" style={{ gridTemplateColumns: '340px minmax(0,1fr)', alignItems: 'start' }}>
        <div className="panel">
          <div className="ph">
            Sections &amp; Subsections
            <span className="fl" />
            <span className="mu" style={{ fontSize: 11, fontWeight: 500 }}>{currentQuestionnaire ? 'From Master Setup' : 'Select questionnaire'}</span>
          </div>
          <div className="pb z" style={{ maxHeight: 560, overflowY: 'auto', padding: 8 }}>
            {loading ? (
              <EmptyState icon={<RefreshCw size={20} className="animate-spin" />} title="Loading structure" description="Please wait..." />
            ) : !questionnaireId ? (
              <EmptyState icon={<ClipboardList size={20} />} title="No questionnaire selected" description="Select a questionnaire above to begin." />
            ) : sections.length === 0 ? (
              <EmptyState icon={<Layers size={20} />} title="No sections found" description="Manage sections and subsections in Master Setup." />
            ) : (
              <div className="space-y-2">
                {sections.map((section, index) => {
                  const sectionSelected = section.id === selectedSectionId
                  const subs = subsectionsOf(section.id)
                  const code = sectionCode(section.display_order || index + 1)
                  return (
                    <div key={section.id} className="qn-section-card">
                      <button
                        type="button"
                        onClick={() => setSelectedSectionId(section.id)}
                        className={`qn-section-btn ${sectionSelected ? 'on' : ''}`}
                      >
                        <span className={`pill ${sectionSelected ? 'ac' : 'mu'}`} style={{ minWidth: 34, textAlign: 'center' }}>
                          {code}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-bold">{section.structure_name}</span>
                          <span className="mu" style={{ fontSize: 11 }}>{subs.length} subsection{subs.length === 1 ? '' : 's'}</span>
                        </span>
                        <Ic n="right" />
                      </button>

                      {sectionSelected && (
                        <div className="mt space-y-1" style={{ paddingLeft: 20 }}>
                          {subs.length === 0 ? (
                            <p className="mu" style={{ padding: '8px 12px', fontSize: 12 }}>No subsections configured</p>
                          ) : subs.map((subsection) => {
                            const selected = subsection.id === selectedSubsectionId
                            const count = questionsOf(subsection.id).length
                            return (
                              <button
                                key={subsection.id}
                                type="button"
                                onClick={() => setSelectedSubsectionId(subsection.id)}
                                className={`qn-subsection-btn ${selected ? 'on' : ''}`}
                              >
                                <span className="qn-dot" />
                                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{subsection.structure_name}</span>
                                <span className="pill mu">{count}</span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="ph">
            Questions
            <span className="fl" />
            <span className="mu" style={{ fontSize: 11, fontWeight: 500 }}>
              {selectedSubsection ? `${selectedSection?.structure_name || ''} / ${selectedSubsection.structure_name}` : 'Select a subsection'}
            </span>
            {selectedSubsection && (
              <button type="button" onClick={startNewQuestion} className="btn p s">
                <Ic n="plus" /> Add Question
              </button>
            )}
          </div>

          <div className="pb" style={{ borderBottom: '1px solid var(--bw-ln2)' }}>
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search questions..."
                className="in"
                style={{ height: 36, paddingLeft: 34, paddingRight: 34 }}
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="btn g s"
                  style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', height: 26, width: 26, padding: 0 }}
                >
                  <Ic n="x" />
                </button>
              )}
            </div>
          </div>

          <div className="pb z" style={{ maxHeight: 560, overflowY: 'auto' }}>
            {!questionnaireId ? (
              <EmptyState icon={<ClipboardList size={20} />} title="Select a questionnaire" description="Choose a questionnaire to view sections and questions." />
            ) : !selectedSubsection ? (
              <EmptyState icon={<Layers size={20} />} title="Select a subsection" description="Questions are configured inside subsections from Master Setup." />
            ) : selectedQuestions.length === 0 ? (
              <EmptyState icon={<FileText size={20} />} title="No questions yet" description="Use Add Question to configure the first question for this subsection." />
            ) : filteredQuestions.length === 0 ? (
              <EmptyState icon={<Search size={20} />} title="No matching questions" description="Try a different search." />
            ) : (
              <div className="list">
                {filteredQuestions.map((question, index) => {
                  const selected = selectedQuestionId === question.id
                  const fields = fieldsOf(question.id)
                  return (
                    <div key={question.id} className={selected ? 'qn-question-row on' : 'qn-question-row'}>
                      <button
                        type="button"
                        onClick={() => selectQuestion(question)}
                        className="flex min-w-0 flex-1 items-start gap-3 text-left"
                        style={{ background: 'none', border: 'none', padding: 0 }}
                      >
                        <span className={`pill ${selected ? 'ac' : 'mu'}`}>
                          {question.element_code}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-bold">
                            {question.element_label}
                          </span>
                          <span className="mt row wrap" style={{ gap: 6 }}>
                            <span className="pill inf">{fields.length} field{fields.length === 1 ? '' : 's'}</span>
                          </span>
                        </span>
                      </button>
                      <div className="row" style={{ gap: 2, flex: 'none' }}>
                        <SmallIconButton title="Edit question" tone="blue" onClick={(event) => { event.stopPropagation(); selectQuestion(question) }}>
                          <Ic n="edit" />
                        </SmallIconButton>
                        <SmallIconButton title="Move up" disabled={index === 0} onClick={(event) => { event.stopPropagation(); move(selectedQuestions, question, -1) }}>
                          <Ic n="up" />
                        </SmallIconButton>
                        <SmallIconButton title="Move down" disabled={index === selectedQuestions.length - 1} onClick={(event) => { event.stopPropagation(); move(selectedQuestions, question, 1) }}>
                          <Ic n="down" />
                        </SmallIconButton>
                        <SmallIconButton title="Delete question" tone="rose" onClick={(event) => { event.stopPropagation(); softDelete(question) }}>
                          <Ic n="trash" />
                        </SmallIconButton>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title="Preview" size="lg">
        <div className="max-h-[70vh] space-y-5 overflow-auto p-1">
          {previewGrouped.map(({ section, subsections }) => (
            <div key={section.id} className="panel">
              <div className="pb">
                <h3 className="font-bold" style={{ fontSize: 14 }}>{section.structure_code}. {section.structure_name}</h3>
                <div className="mt space-y-4">
                  {subsections.map(({ subsection, questions }) => (
                    <div key={subsection.id} className="qn-preview-sub">
                      <h4 className="mb font-bold" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>{subsection.structure_name}</h4>
                      <div className="space-y-4">
                        {questions.map(({ question, fields }) => (
                          <div key={question.id} className="qn-preview-question">
                            <label className="mb block font-semibold" style={{ fontSize: 13 }}>
                              {question.element_label}
                            </label>
                            {fields.map((field) => (
                              <div key={field.id} className="qn-preview-field">
                                <label className="mb block mu font-semibold" style={{ fontSize: 12 }}>{field.element_label}</label>
                                <QuestionnaireAnswerField element={field} value="" onChange={() => {}} readOnly />
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmPublish}
        title="Publish questionnaire?"
        message="Once published, CRM users can start filling this questionnaire."
        confirmLabel="Publish"
        variant="primary"
        onConfirm={doPublish}
        onCancel={() => setConfirmPublish(false)}
      />
    </div>
  )
}

type FieldGroupConfig = { key: FieldCondition; title: string; hint: string; tone: string }
type DraftPath = number[]

const CONDITIONAL_FIELD_GROUPS: FieldGroupConfig[] = [
  { key: 'yes', title: 'If Answer = Yes', hint: 'Shown only when this question is answered Yes.', tone: 'border-emerald-100 bg-emerald-50/40' },
  { key: 'no', title: 'If Answer = No', hint: 'Shown only when this question is answered No.', tone: 'border-rose-100 bg-rose-50/40' },
]

function AdditionalFieldsEditor({
  drafts,
  onChange,
  bare = false,
}: {
  drafts: FieldDraft[]
  onChange: (drafts: FieldDraft[]) => void
  bare?: boolean
}) {
  const getDraftListAtPath = (path: DraftPath): FieldDraft[] => {
    let current = drafts
    for (const index of path) {
      current = current[index]?.children || []
    }
    return current
  }

  const getDraftAtPath = (path: DraftPath): FieldDraft | null => {
    let current: FieldDraft | undefined
    let list = drafts
    for (const index of path) {
      current = list[index]
      if (!current) return null
      list = current.children || []
    }
    return current || null
  }

  const updateDraftListAtPath = (path: DraftPath, updater: (items: FieldDraft[]) => FieldDraft[]) => {
    const apply = (items: FieldDraft[], remainingPath: DraftPath): FieldDraft[] => {
      if (remainingPath.length === 0) return updater(items)
      const [head, ...tail] = remainingPath
      return items.map((draft, index) =>
        index === head
          ? { ...draft, children: apply(draft.children || [], tail) }
          : draft,
      )
    }
    onChange(apply(drafts, path))
  }

  const updateDraft = (path: DraftPath, patch: Partial<FieldDraft>) => {
    const parentPath = path.slice(0, -1)
    const draftIndex = path[path.length - 1]
    updateDraftListAtPath(parentPath, (items) =>
      items.map((draft, index) => (index === draftIndex ? { ...draft, ...patch } : draft)),
    )
  }

  const updateDraftType = (path: DraftPath, inputType: string) => {
    const current = getDraftAtPath(path)
    updateDraft(path, {
      input_type: inputType,
      children: fieldSupportsSubConditions(inputType) ? current?.children || [] : [],
    })
  }

  const removeDraft = (path: DraftPath) => {
    const parentPath = path.slice(0, -1)
    const draftIndex = path[path.length - 1]
    updateDraftListAtPath(parentPath, (items) => items.filter((_, index) => index !== draftIndex))
  }

  const addDraft = (condition: FieldCondition, parentPath: DraftPath = []) => {
    updateDraftListAtPath(parentPath, (items) => [...items, blankFieldDraft(condition)])
  }

  const moveDraft = (path: DraftPath, condition: FieldCondition, direction: -1 | 1) => {
    const parentPath = path.slice(0, -1)
    const draftIndex = path[path.length - 1]
    updateDraftListAtPath(parentPath, (items) => {
      const groupIndices = items
        .map((draft, index) => ({ draft, index }))
        .filter(({ draft }) => (draft.condition || 'always') === condition)
        .map(({ index }) => index)
      const groupPosition = groupIndices.indexOf(draftIndex)
      const targetPosition = groupPosition + direction
      if (groupPosition < 0 || targetPosition < 0 || targetPosition >= groupIndices.length) return items

      const targetIndex = groupIndices[targetPosition]
      const next = [...items]
      ;[next[draftIndex], next[targetIndex]] = [next[targetIndex], next[draftIndex]]
      return next
    })
  }

  const renderFieldCard = (draft: FieldDraft, path: DraftPath, groupPosition: number, groupCount: number) => {
    const nested = path.length > 1

    return (
      <div key={path.join('.')} className={`${nested ? 'rounded-lg p-2.5' : 'rounded-xl p-3'} border border-slate-100 bg-white`}>
        <div className="flex items-start gap-2">
          <div className={`grid min-w-0 flex-1 gap-2 ${nested ? 'grid-cols-1' : 'sm:grid-cols-2'}`}>
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">Label</span>
              <input
                value={draft.element_label}
                onChange={(event) => updateDraft(path, { element_label: event.target.value })}
                placeholder="Field name"
                className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">Field Type</span>
              <select
                value={draft.input_type}
                onChange={(event) => updateDraftType(path, event.target.value)}
                className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
              >
                {INPUT_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>{type.label}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">Placeholder</span>
              <input
                value={draft.placeholder}
                onChange={(event) => updateDraft(path, { placeholder: event.target.value })}
                placeholder="Placeholder"
                className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">Default Value</span>
              <input
                value={draft.default_value}
                onChange={(event) => updateDraft(path, { default_value: event.target.value })}
                placeholder="Default Value"
                className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
              />
            </label>
          </div>
          <div className="flex flex-shrink-0 flex-col items-center gap-0.5 rounded-xl border border-slate-100 bg-white px-1 py-1 shadow-sm">
            <SmallIconButton title="Move field up" disabled={groupPosition === 0} onClick={() => moveDraft(path, draft.condition || 'always', -1)}>
              <Ic n="up" />
            </SmallIconButton>
            <SmallIconButton title="Move field down" disabled={groupPosition === groupCount - 1} onClick={() => moveDraft(path, draft.condition || 'always', 1)}>
              <Ic n="down" />
            </SmallIconButton>
            <SmallIconButton title="Remove field" tone="rose" onClick={() => removeDraft(path)}>
              <Ic n="trash" />
            </SmallIconButton>
          </div>
        </div>

        {isSelectInputType(draft.input_type) && (
          <div className="mt-2 rounded-lg border border-indigo-100 bg-white p-2.5">
            <select
              value={draft.optionsSource}
              onChange={(event) => updateDraft(path, { optionsSource: event.target.value as 'custom' | 'master' })}
              className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50 sm:w-64"
            >
              <option value="custom">Custom List</option>
              <option value="master">Existing CRM Data</option>
            </select>
            {draft.optionsSource === 'custom' ? (
              <textarea
                value={draft.optionsText}
                onChange={(event) => updateDraft(path, { optionsText: event.target.value })}
                placeholder={'Label|value (one option per line)'}
                rows={3}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
              />
            ) : (
              <select
                value={draft.masterKey}
                onChange={(event) => updateDraft(path, { masterKey: event.target.value })}
                className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50 sm:w-64"
              >
                {MASTER_KEYS.map((key) => (
                  <option key={key.value} value={key.value}>{key.label}</option>
                ))}
              </select>
            )}
          </div>
        )}

        <label className="mt-2 block">
          <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-slate-400">Validation</span>
          <textarea
            value={draft.validationText}
            onChange={(event) => updateDraft(path, { validationText: event.target.value })}
            placeholder='{"max_length": 250}'
            rows={2}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-300 focus:ring-4 focus:ring-blue-50"
          />
        </label>

        <div className="mt-2 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm font-bold text-slate-600">
            <input
              type="checkbox"
              checked={draft.is_required}
              onChange={(event) => updateDraft(path, { is_required: event.target.checked })}
              className="h-4 w-4 rounded accent-blue-600"
            />
            Required
          </label>
          <label className="flex items-center gap-2 text-sm font-bold text-slate-600">
            <input
              type="checkbox"
              checked={draft.is_active}
              onChange={(event) => updateDraft(path, { is_active: event.target.checked })}
              className="h-4 w-4 rounded accent-blue-600"
            />
            Active
          </label>
        </div>

        {fieldSupportsSubConditions(draft.input_type) && (
          <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-2.5">
            <div className="mb-2">
              <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">Sub Conditions</p>
              <p className="text-xs font-medium text-slate-400">Shown after this field is answered Yes or No.</p>
            </div>
            <div className="space-y-2">
              {CONDITIONAL_FIELD_GROUPS.map((group) => renderGroup(group, path))}
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderGroup = (group: FieldGroupConfig, parentPath: DraftPath = [], canAdd = true) => {
    const groupItems = getDraftListAtPath(parentPath)
      .map((draft, index) => ({ draft, path: [...parentPath, index] }))
      .filter(({ draft }) => (draft.condition || 'always') === group.key)
    const nested = parentPath.length > 0
    const title = nested ? group.title.replace('Answer', 'Field') : group.title
    const hint = nested ? `Shown only when this field is answered ${group.key === 'yes' ? 'Yes' : 'No'}.` : group.hint

    return (
      <div key={`${parentPath.join('.') || 'root'}-${group.key}`} className={`${nested ? 'rounded-xl p-2.5' : 'rounded-2xl p-3'} border ${group.tone}`}>
        <div className="mb-2">
          <p className="text-xs font-black uppercase tracking-wider text-slate-600">{title}</p>
          <p className="text-xs font-medium text-slate-400">{hint}</p>
        </div>

        <div className="space-y-2">
          {groupItems.map(({ draft, path }, groupPosition) => renderFieldCard(draft, path, groupPosition, groupItems.length))}
        </div>

        <button
          type="button"
          onClick={() => addDraft(group.key, parentPath)}
          disabled={!canAdd}
          title={canAdd ? undefined : 'Set a field Type to Conditional Yes / No to use this group'}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-blue-200 bg-blue-50/60 px-3 py-2.5 text-xs font-bold text-blue-600 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
        >
          <Ic n="plus" /> {nested ? 'Add Sub Field' : 'Add Field'}
        </button>
      </div>
    )
  }

  const conditionalFields = (
    <div className="rounded-2xl border border-slate-100 p-3">
      <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Conditional Fields</h3>
      <div className="space-y-3">
        {CONDITIONAL_FIELD_GROUPS.map((group) => renderGroup(group))}
      </div>
    </div>
  )

  const body = (
    <div className="space-y-3">
      {conditionalFields}
    </div>
  )

  if (bare) return body

  return (
    <div className="space-y-3">
      {conditionalFields}
    </div>
  )
}
