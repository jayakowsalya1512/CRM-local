import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { questionnaireApi } from '@/services/api'
import { useToast, ConfirmDialog } from '@/components/ui/FormComponents'
import { Input, Select, Textarea } from '@/components/ui/Input'
import Button from '@/components/ui/Button'
import SlidePanel from '@/components/ui/SlidePanel'
import { usePermissions } from '@/hooks'
import { Ic } from '@/components/crm/kit'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './questionnaire.css'

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

interface QuestionnaireRow {
  id: number
  questionnaire_code: string
  questionnaire_name: string
  status: string
}

type PanelMode = { kind: 'section' | 'subsection'; editing?: Structure; parentSectionId?: number } | null

export default function MasterSetupPage() {
  const { success, error: showError } = useToast()
  const { can } = usePermissions()
  const canEdit = can('questionnaire.update')

  const [questionnaires, setQuestionnaires] = useState<QuestionnaireRow[]>([])
  const [questionnaireId, setQuestionnaireId] = useState<number | null>(null)
  const [structure, setStructure] = useState<Structure[]>([])
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const [panel, setPanel] = useState<PanelMode>(null)
  const [form, setForm] = useState({ structure_code: '', structure_name: '', description: '', display_order: 0, parent_id: 0 })
  const [newQName, setNewQName] = useState('')
  const [newQCode, setNewQCode] = useState('')
  const [showNewQ, setShowNewQ] = useState(false)

  const loadQuestionnaires = () => {
    questionnaireApi.listQuestionnaires().then((res) => {
      setQuestionnaires(res.data || [])
      if (!questionnaireId && res.data?.length) setQuestionnaireId(res.data[0].id)
    }).catch(() => showError('Failed to load questionnaires'))
  }

  const loadStructure = (qid: number) => {
    questionnaireApi.listStructure(qid, true).then((res) => setStructure(res.data || [])).catch(() => showError('Failed to load structure'))
  }

  useEffect(() => { loadQuestionnaires() }, []) // eslint-disable-line
  useEffect(() => { if (questionnaireId) loadStructure(questionnaireId) }, [questionnaireId])

  const sections = structure.filter((s) => s.structure_type === 'section').sort((a, b) => a.display_order - b.display_order)
  const subsectionsOf = (sectionId: number) =>
    structure.filter((s) => s.structure_type === 'subsection' && s.parent_id === sectionId).sort((a, b) => a.display_order - b.display_order)

  const openAddSection = () => {
    setForm({ structure_code: '', structure_name: '', description: '', display_order: sections.length + 1, parent_id: 0 })
    setPanel({ kind: 'section' })
  }
  const openAddSubsection = (sectionId: number) => {
    const subs = subsectionsOf(sectionId)
    setForm({ structure_code: '', structure_name: '', description: '', display_order: subs.length + 1, parent_id: sectionId })
    setPanel({ kind: 'subsection', parentSectionId: sectionId })
  }
  const openEdit = (row: Structure) => {
    setForm({
      structure_code: row.structure_code, structure_name: row.structure_name,
      description: row.description || '', display_order: row.display_order, parent_id: row.parent_id || 0,
    })
    setPanel({ kind: row.structure_type, editing: row, parentSectionId: row.parent_id || undefined })
  }

  const savePanel = async () => {
    if (!questionnaireId || !panel) return
    try {
      if (panel.editing) {
        await questionnaireApi.updateStructure(panel.editing.id, {
          structure_code: form.structure_code, structure_name: form.structure_name,
          description: form.description, display_order: form.display_order,
        })
        success('Updated successfully')
      } else {
        await questionnaireApi.createStructure({
          questionnaire_id: questionnaireId,
          parent_id: panel.kind === 'subsection' ? form.parent_id : null,
          structure_type: panel.kind,
          structure_code: form.structure_code, structure_name: form.structure_name,
          description: form.description, display_order: form.display_order,
        })
        success(panel.kind === 'section' ? 'Section added' : 'Subsection added')
      }
      setPanel(null)
      loadStructure(questionnaireId)
    } catch (e: unknown) {
      showError((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Save failed')
    }
  }

  const toggleActive = async (row: Structure) => {
    try {
      await questionnaireApi.setStructureStatus(row.id, !row.is_active)
      loadStructure(questionnaireId!)
    } catch {
      showError('Failed to update status')
    }
  }

  const [confirmDelete, setConfirmDelete] = useState<Structure | null>(null)
  const deleteRow = async () => {
    if (!confirmDelete) return
    try {
      await questionnaireApi.deleteStructure(confirmDelete.id)
      success('Deleted')
      setConfirmDelete(null)
      loadStructure(questionnaireId!)
    } catch (e: unknown) {
      setConfirmDelete(null)
      showError((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Failed to delete')
    }
  }

  const move = async (list: Structure[], row: Structure, dir: -1 | 1) => {
    const idx = list.findIndex((s) => s.id === row.id)
    const swapIdx = idx + dir
    if (swapIdx < 0 || swapIdx >= list.length) return
    const reordered = [...list]
    ;[reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]]
    try {
      await questionnaireApi.reorderStructure(reordered.map((s) => s.id))
      loadStructure(questionnaireId!)
    } catch {
      showError('Failed to reorder')
    }
  }

  const createQuestionnaire = async () => {
    if (!newQCode.trim() || !newQName.trim()) return
    try {
      const res = await questionnaireApi.createQuestionnaire({ questionnaire_code: newQCode, questionnaire_name: newQName })
      success('Questionnaire created')
      setShowNewQ(false); setNewQCode(''); setNewQName('')
      loadQuestionnaires()
      setQuestionnaireId(res.data.id)
    } catch (e: unknown) {
      showError((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail || 'Failed to create questionnaire')
    }
  }

  return (
    <div className="bwi">
      <div className="pg">
        <div><div className="crumb">Questionnaire</div><h1>Master Setup</h1></div>
        <span className="cnt">Manage sections and subsections used by the Form Builder</span>
        <span className="fl" />
        {canEdit && (
          <button type="button" className="btn s" onClick={() => setShowNewQ(true)}>
            <Ic n="plus" /> New Questionnaire
          </button>
        )}
      </div>

      <div className="row wrap mb" style={{ gap: 8 }}>
        <Select
          value={questionnaireId ?? ''}
          onChange={(e) => setQuestionnaireId(Number(e.target.value))}
          options={questionnaires.map((q) => ({ value: q.id, label: `${q.questionnaire_code} — ${q.questionnaire_name} (${q.status})` }))}
          placeholder="Select a questionnaire"
          className="w-96"
        />
        {canEdit && questionnaireId && (
          <button type="button" className="btn p s" onClick={openAddSection}>
            <Ic n="plus" /> Add Section
          </button>
        )}
      </div>

      {showNewQ && (
        <div className="panel mb">
          <div className="pb row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Input label="Code" value={newQCode} onChange={(e) => setNewQCode(e.target.value)} className="w-32" />
            <Input label="Name" value={newQName} onChange={(e) => setNewQName(e.target.value)} className="w-64" />
            <button type="button" className="btn p s" onClick={createQuestionnaire}>Create</button>
            <button type="button" className="btn g s" onClick={() => setShowNewQ(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="pb z" style={{ maxHeight: 'calc(100vh - 320px)', overflow: 'auto' }}>
          {sections.length === 0 && (
            <div className="empty">
              {questionnaireId ? 'No sections yet — click "Add Section" to begin.' : 'Select or create a questionnaire to get started.'}
            </div>
          )}
          {sections.map((section) => {
            const subs = subsectionsOf(section.id)
            const isOpen = expanded[section.id] !== false
            return (
              <div key={section.id} className="qn-tree-row">
                <div className="row" style={{ gap: 8, padding: '10px 12px' }}>
                  <button type="button" onClick={() => setExpanded((p) => ({ ...p, [section.id]: !isOpen }))} className="btn g s" aria-label={isOpen ? 'Collapse' : 'Expand'}>
                    {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <span className={`font-semibold ${section.is_active ? '' : 'mu'}`}>
                    {section.structure_code}. {section.structure_name}
                  </span>
                  <span className={`pill ${section.is_active ? 'ok' : 'mu'}`}>{section.is_active ? 'Active' : 'Inactive'}</span>
                  {canEdit && (
                    <>
                      <span className="fl" />
                      <button type="button" title="Move up" onClick={() => move(sections, section, -1)} className="btn g s"><Ic n="up" /></button>
                      <button type="button" title="Move down" onClick={() => move(sections, section, 1)} className="btn g s"><Ic n="down" /></button>
                      <button type="button" title="Edit" onClick={() => openEdit(section)} className="btn g s"><Ic n="edit" /></button>
                      {!section.is_active && (
                        <button type="button" className="btn s" onClick={() => toggleActive(section)}>Activate</button>
                      )}
                      <button type="button" title="Delete" onClick={() => setConfirmDelete(section)} className="btn g s"><Ic n="trash" /></button>
                      <button type="button" className="btn g s" onClick={() => openAddSubsection(section.id)}><Ic n="plus" /> Add Subsection</button>
                    </>
                  )}
                </div>
                {isOpen && subs.map((sub) => (
                  <div key={sub.id} className="row" style={{ gap: 8, padding: '8px 12px 8px 40px' }}>
                    <span className={sub.is_active ? '' : 'mu'}>
                      {sub.structure_code} — {sub.structure_name}
                    </span>
                    <span className={`pill ${sub.is_active ? 'ok' : 'mu'}`}>{sub.is_active ? 'Active' : 'Inactive'}</span>
                    {canEdit && (
                      <>
                        <span className="fl" />
                        <button type="button" title="Move up" onClick={() => move(subs, sub, -1)} className="btn g s"><Ic n="up" /></button>
                        <button type="button" title="Move down" onClick={() => move(subs, sub, 1)} className="btn g s"><Ic n="down" /></button>
                        <button type="button" title="Edit" onClick={() => openEdit(sub)} className="btn g s"><Ic n="edit" /></button>
                        {!sub.is_active && (
                          <button type="button" className="btn s" onClick={() => toggleActive(sub)}>Activate</button>
                        )}
                        <button type="button" title="Delete" onClick={() => setConfirmDelete(sub)} className="btn g s"><Ic n="trash" /></button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      <SlidePanel
        open={!!panel}
        onClose={() => setPanel(null)}
        title={panel?.editing ? 'Edit' : panel?.kind === 'section' ? 'Add Section' : 'Add Subsection'}
        footer={<div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setPanel(null)}>Cancel</Button><Button onClick={savePanel}>Save</Button></div>}
      >
        <div className="space-y-4 p-4">
          {panel?.kind === 'subsection' && (
            <Select
              label="Parent Section"
              value={form.parent_id}
              onChange={(e) => setForm((f) => ({ ...f, parent_id: Number(e.target.value) }))}
              options={sections.filter((s) => s.is_active).map((s) => ({ value: s.id, label: `${s.structure_code}. ${s.structure_name}` }))}
              disabled={!!panel.editing}
            />
          )}
          <Input label={panel?.kind === 'section' ? 'Section Code' : 'Subsection Code'} value={form.structure_code}
            onChange={(e) => setForm((f) => ({ ...f, structure_code: e.target.value }))} required />
          <Input label={panel?.kind === 'section' ? 'Section Name' : 'Subsection Name'} value={form.structure_name}
            onChange={(e) => setForm((f) => ({ ...f, structure_name: e.target.value }))} required />
          <Textarea label="Description" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} />
          <Input label="Display Order" type="number" value={form.display_order}
            onChange={(e) => setForm((f) => ({ ...f, display_order: Number(e.target.value) }))} />
        </div>
      </SlidePanel>

      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete?.structure_type === 'section' ? 'Delete Section' : 'Delete Subsection'}
        message={`Delete "${confirmDelete?.structure_name}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteRow}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
