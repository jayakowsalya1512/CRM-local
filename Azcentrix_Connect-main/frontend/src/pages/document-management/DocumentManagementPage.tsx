import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Building2, Check, ChevronDown, ChevronRight, Download, ExternalLink, FileText,
  Filter, Folder, FolderInput, FolderPlus,
  MoreVertical, Pencil, Plus, RefreshCw, RotateCcw, Search,
  Share2, ShieldCheck, Star, Trash2, Upload, User, Users, X,
} from 'lucide-react'
import { PageHeader, useToast } from '@/components/ui/FormComponents'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { Modal } from '@/components/ui/Modal'
import Button from '@/components/ui/Button'
import DropFileUpload from '@/components/ui/DropFileUpload'
import { usePermissions } from '@/hooks'
import { useModuleName } from '@/context/ModuleLabelsContext'
import FilePreviewModal from '@/pages/questionnaire/FilePreviewModal'
import { buildFilePreviewUrl } from '@/pages/questionnaire/questionnaireFormShared'
import { documentManagementApi, mastersApi } from '@/services/api'
import { confirmAction } from '@/utils/sweetAlert'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors, type SpecMap } from '@/hooks/useFieldErrors'
import { focusFirst, mapApiErrors, validate, type Val } from '@/utils/validation'
import { RecordViewPanel } from '../report-engine/RecordViewPanel'
import type { DrilldownEntity, DrilldownRequest } from '../reports/shared/DrilldownDrawer'

type DocumentRow = {
  id: string
  name: string
  source_key: string
  source: string
  owner: string
  updated_at: string | null
  created_at?: string | null
  status: string
  record_label: string
  record_id?: number | null
  doc_type: string
  file_type?: string | null
  file_extension?: string | null
  url: string
  size_kb?: number | null
  folder_id?: number | null
  is_mine?: boolean
  is_starred?: boolean
  is_shared_with_me?: boolean
  deleted_at?: string | null
  is_deleted?: boolean
  can_trash?: boolean
  approval_status?: 'uploaded' | 'pending_approval' | 'approved' | 'rejected' | null
  approval_submitted_by?: string | null
  approval_submitted_at?: string | null
  approval_decided_by?: string | null
  approval_decided_at?: string | null
  approval_comment?: string | null
  can_submit_approval?: boolean
}

const RECORD_DRILLDOWN_ENTITY: Partial<Record<string, DrilldownEntity>> = {
  customers: 'customer',
  leads: 'lead',
  tenders: 'tender',
  quotations: 'quotation',
  workorders: 'workorder',
  emdbg: 'emdbg',
}

type DocumentSummary = {
  total: number
  mine: number
  shared_with_me: number
  starred: number
  trash: number
  sources?: Record<string, number>
  skipped_sources?: string[]
}

type DocumentResponse = {
  documents: DocumentRow[]
  summary?: DocumentSummary
}

type ViewKey = 'all' | 'mine' | 'shared' | 'starred' | 'trash'
type AdvancedFilterKey = 'customer' | 'owner' | 'date'

const ADVANCED_FILTER_OPTIONS: { key: AdvancedFilterKey; label: string; description: string }[] = [
  { key: 'customer', label: 'Customer', description: 'Show customer picker' },
  { key: 'owner', label: 'Owner', description: 'Show owner selector' },
  { key: 'date', label: 'Date range', description: 'Show from and to dates' },
]

const SOURCE_OPTIONS = [
  { key: 'all', label: 'All Sources' },
  { key: 'customers', label: 'Customers' },
  { key: 'leads', label: 'Leads' },
  { key: 'tenders', label: 'Tenders' },
  { key: 'quotations', label: 'Quotations' },
  { key: 'workorders', label: 'Orders & Projects' },
  { key: 'emdbg', label: 'EMD / BG' },
  { key: 'rfp', label: 'RFP Analysis' },
  { key: 'travel', label: 'Travel / TA-DA' },
  { key: 'letters', label: 'Letter Management' },
  { key: 'standalone', label: 'Uploads' },
]
const LINK_SOURCE_OPTIONS = [
  { key: 'standalone', label: 'No linked record' },
  ...SOURCE_OPTIONS.filter((option) => option.key !== 'all' && option.key !== 'standalone'),
]

type LinkRecordOption = {
  id: number
  source_key: string
  source: string
  label: string
  subtitle?: string
}

type FolderNode = {
  id: number
  name: string
  parent_id: number | null
}

type FolderTreeNode = FolderNode & { children: FolderTreeNode[] }

type ShareUserOption = {
  id: number
  label: string
  role?: string
}

function buildFolderTree(folders: FolderNode[]): FolderTreeNode[] {
  const byId = new Map<number, FolderTreeNode>(folders.map((f) => [f.id, { ...f, children: [] }]))
  const roots: FolderTreeNode[] = []
  byId.forEach((node) => {
    if (node.parent_id != null && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node)
    } else {
      roots.push(node)
    }
  })
  const sortByName = (a: FolderTreeNode, b: FolderTreeNode) => a.name.localeCompare(b.name)
  const sortTree = (nodes: FolderTreeNode[]) => {
    nodes.sort(sortByName)
    nodes.forEach((n) => sortTree(n.children))
  }
  sortTree(roots)
  return roots
}

function folderNameKey(name: string) {
  return name.trim().split(/\s+/).join(' ').toLowerCase()
}

function folderSiblingNameTaken(folders: FolderNode[], parentId: number | null, name: string, excludeId?: number) {
  const target = folderNameKey(name)
  return folders.some((folder) =>
    folder.parent_id === parentId
    && folder.id !== excludeId
    && folderNameKey(folder.name) === target
  )
}

function folderAncestorNameTaken(folders: FolderNode[], parentId: number | null, name: string) {
  const target = folderNameKey(name)
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const seen = new Set<number>()
  let currentId = parentId

  while (currentId != null && !seen.has(currentId)) {
    seen.add(currentId)
    const folder = byId.get(currentId)
    if (!folder) break
    if (folderNameKey(folder.name) === target) return true
    currentId = folder.parent_id
  }

  return false
}

function folderDescendantNameTaken(folders: FolderNode[], folderId: number, name: string) {
  const target = folderNameKey(name)
  const childrenByParent = new Map<number, FolderNode[]>()
  folders.forEach((folder) => {
    if (folder.parent_id == null) return
    const children = childrenByParent.get(folder.parent_id) || []
    children.push(folder)
    childrenByParent.set(folder.parent_id, children)
  })

  const stack = [...(childrenByParent.get(folderId) || [])]
  const seen = new Set<number>()
  while (stack.length > 0) {
    const folder = stack.pop()!
    if (seen.has(folder.id)) continue
    seen.add(folder.id)
    if (folderNameKey(folder.name) === target) return true
    stack.push(...(childrenByParent.get(folder.id) || []))
  }

  return false
}

function validateFolderName(
  folders: FolderNode[],
  modal: { mode: 'create'; parentId: number | null } | { mode: 'rename'; folderId: number; initialName: string },
  name: string,
) {
  const parentId = modal.mode === 'create'
    ? modal.parentId
    : folders.find((folder) => folder.id === modal.folderId)?.parent_id ?? null
  const excludeId = modal.mode === 'rename' ? modal.folderId : undefined

  if (folderSiblingNameTaken(folders, parentId, name, excludeId)) {
    return `A folder named "${name}" already exists here.`
  }
  if (folderAncestorNameTaken(folders, parentId, name)) {
    return `A parent folder already uses "${name}". Please choose a different subfolder name.`
  }
  if (modal.mode === 'rename' && folderDescendantNameTaken(folders, modal.folderId, name)) {
    return `A subfolder already uses "${name}". Please choose a different folder name.`
  }
  return ''
}

const DEFAULT_SUMMARY: DocumentSummary = { total: 0, mine: 0, shared_with_me: 0, starred: 0, trash: 0 }

function fmtDate(value?: string | null) {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return value
  }
}

function fmtRelative(value?: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'

  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins} min${diffMins === 1 ? '' : 's'} ago`
  if (diffHours < 24) return `${diffHours} hr${diffHours === 1 ? '' : 's'} ago`
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return fmtDate(value)
}

function fmtSize(value?: number | null) {
  if (value == null) return '-'
  const kb = Number(value)
  if (!Number.isFinite(kb)) return '-'
  if (kb <= 0) return '<1 KB'
  if (kb < 1024) return `${kb.toLocaleString('en-IN')} KB`
  const mb = kb / 1024
  return `${mb >= 10 ? Math.round(mb).toLocaleString('en-IN') : mb.toFixed(1)} MB`
}

function extensionFromPath(value?: string | null) {
  const clean = String(value || '').split(/[?#]/, 1)[0].trim()
  const match = clean.match(/\.([a-z0-9]+)$/i)
  if (!match) return ''
  return match[1].toUpperCase() === 'JPEG' ? 'JPG' : match[1].toUpperCase()
}

function documentTypeFromFile(file: File) {
  const extension = extensionFromPath(file.name)
  const mime = String(file.type || '').toLowerCase()

  if (extension === 'PDF' || mime === 'application/pdf') return 'PDF Document'
  if (['DOC', 'DOCX'].includes(extension) || mime.includes('wordprocessingml') || mime === 'application/msword') return 'Word Document'
  if (['XLS', 'XLSX', 'CSV'].includes(extension) || mime.includes('spreadsheetml') || mime.includes('excel') || mime === 'text/csv') return 'Excel Document'
  if (['PPT', 'PPTX'].includes(extension) || mime.includes('presentationml') || mime.includes('powerpoint')) return 'PowerPoint Document'
  if (['JPG', 'PNG', 'GIF', 'WEBP', 'BMP', 'SVG'].includes(extension) || mime.startsWith('image/')) return 'Image Document'
  if (['TXT', 'RTF'].includes(extension) || mime.startsWith('text/')) return 'Text Document'
  if (['ZIP', 'RAR', '7Z'].includes(extension)) return 'Archive File'
  if (extension) return `${extension} Document`
  return 'Uploaded Document'
}

function documentFileType(doc: DocumentRow) {
  return (
    String(doc.file_type || doc.file_extension || '').trim().toUpperCase() ||
    extensionFromPath(doc.name) ||
    extensionFromPath(doc.url) ||
    'FILE'
  )
}

function DocStatusBadge({ status }: { status?: string | null }) {
  const raw = status || '-'
  const value = raw.toLowerCase()
  const isRejected = /(rejected|trash|deleted|expired|failed|cancelled)/.test(value)
  const isPending  = /(pending|review|draft|processing)/.test(value)
  const isApproved = /(approved|signed|completed|released)/.test(value)
  // EMD/BG "Released" and similar decision states read as an approval decision here — the
  // business doesn't want the underlying "released" wording surfaced in this shared status pill.
  const label = value.includes('released') ? 'Approved' : raw

  const tone = isRejected
    ? 'bg-red-50 text-red-700 ring-red-200'
    : isPending
      ? 'bg-amber-50 text-amber-700 ring-amber-200'
      : isApproved
        ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
        : 'bg-gray-100 text-gray-600 ring-gray-200'

  return (
    <span className={`inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${tone}`}>
      <span className="truncate">{label}</span>
    </span>
  )
}

const DOCUMENT_KIND_LABELS: Record<string, string> = {
  'tender': 'RFP Document',
  'tender document': 'RFP Document',
  'rfp document': 'RFP Document',
  'corrigendum': 'Corrigendum Documents',
  'corrigendum document': 'Corrigendum Documents',
  'corrigendum documents': 'Corrigendum Documents',
  'oem document': 'OEM Documents',
  'oem documents': 'OEM Documents',
  'workings': 'Workings Document',
  'workings document': 'Workings Document',
  'boq': 'Workings Document',
  'boq document': 'Workings Document',
  'po document': 'PO Document',
  'completion certificate': 'Completion Certificate',
  'milestone document': 'Milestone Document',
  'invoice document': 'Invoice Document',
  'instrument document': 'Instrument Document',
  'payment proof': 'Payment Proof',
  'return document': 'Return Document',
  'release document': 'Release Document',
  'renewal document': 'Renewal Document',
}

const GENERIC_FILE_DOCUMENT_KEYS = new Set([
  'archive file',
  'csv document',
  'doc document',
  'docx document',
  'excel document',
  'file document',
  'html document',
  'image document',
  'jpg document',
  'pdf document',
  'powerpoint document',
  'ppt document',
  'pptx document',
  'sql document',
  'text document',
  'txt document',
  'uploaded document',
  'word document',
  'xls document',
  'xlsx document',
])

const SOURCE_DEFAULT_DOCUMENT_KIND: Record<string, string> = {
  leads: 'RFP Document',
  quotations: 'RFP Document',
  rfp: 'RFP Document',
  standalone: 'RFP Document',
  tenders: 'RFP Document',
  workorders: 'PO Document',
}

const APPROVAL_STAGE_LABELS: Record<string, string> = {
  uploaded: 'Uploaded',
  'pending approval': 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
}

function normalizeDocumentLabelKey(value?: string | null) {
  return String(value || '').replace(/[_/-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

function titleCaseDocumentLabel(value: string) {
  const acronyms = new Set(['rfp', 'oem', 'boq', 'po', 'pdf', 'sql', 'emd', 'bg', 'ta', 'da'])
  return normalizeDocumentLabelKey(value)
    .split(' ')
    .filter(Boolean)
    .map((part) => acronyms.has(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function documentKindLabel(doc: DocumentRow) {
  const candidates = [doc.doc_type, doc.status, doc.name]
  for (const candidate of candidates) {
    const key = normalizeDocumentLabelKey(candidate)
    if (DOCUMENT_KIND_LABELS[key]) return DOCUMENT_KIND_LABELS[key]
    if (/\bcorrigendum\b/.test(key)) return 'Corrigendum Documents'
    if (/\boem\b/.test(key)) return 'OEM Documents'
    if (/\bworkings?\b/.test(key)) return 'Workings Document'
    if (/\bboq\b/.test(key)) return 'Workings Document'
    if (/\bpo\b/.test(key)) return 'PO Document'
    if (/\brfp\b|\btender\b/.test(key)) return 'RFP Document'
  }

  const raw = doc.doc_type || doc.status || ''
  const key = normalizeDocumentLabelKey(raw)
  if (GENERIC_FILE_DOCUMENT_KEYS.has(key)) {
    return SOURCE_DEFAULT_DOCUMENT_KIND[normalizeDocumentLabelKey(doc.source_key)] || 'RFP Document'
  }
  return DOCUMENT_KIND_LABELS[key] || titleCaseDocumentLabel(raw) || 'Document'
}

function documentStageLabel(doc: DocumentRow) {
  const approvalKey = normalizeDocumentLabelKey(doc.approval_status)
  if (APPROVAL_STAGE_LABELS[approvalKey]) return APPROVAL_STAGE_LABELS[approvalKey]

  const rawStatus = String(doc.status || '').trim()
  const statusKey = normalizeDocumentLabelKey(rawStatus)
  const kindKey = normalizeDocumentLabelKey(doc.doc_type)

  if (doc.is_deleted || /(trash|deleted)/.test(statusKey)) return 'In Trash'
  if (!statusKey || statusKey === kindKey || DOCUMENT_KIND_LABELS[statusKey]) return 'Uploaded'
  if (/(pending approval|approval pending)/.test(statusKey)) return 'Pending'
  if (/(upload|submitted)/.test(statusKey)) return 'Uploaded'
  if (/(approved|signed|completed|released|acknowledged|paid|won)/.test(statusKey)) return 'Approved'
  if (/(rejected|failed|cancelled|lost)/.test(statusKey)) return 'Rejected'
  if (/(pending|review|draft|processing|waiting)/.test(statusKey)) return 'Pending'

  return titleCaseDocumentLabel(rawStatus) || 'Uploaded'
}

function stageTextTone(stage: string) {
  const value = stage.toLowerCase()
  if (/(trash|deleted|rejected|failed|cancelled|lost)/.test(value)) {
    return 'text-red-600'
  }
  if (/(pending|review|draft|processing|waiting)/.test(value)) {
    return 'text-amber-600'
  }
  if (/(approved|signed|completed|released|acknowledged|paid|won)/.test(value)) {
    return 'text-emerald-600'
  }
  if (/(uploaded|submitted)/.test(value)) {
    return 'text-blue-600'
  }
  return 'text-gray-500'
}

function stageDotTone(stage: string) {
  const value = stage.toLowerCase()
  if (/(trash|deleted|rejected|failed|cancelled|lost)/.test(value)) return 'bg-red-500'
  if (/(pending|review|draft|processing|waiting)/.test(value)) return 'bg-amber-400'
  if (/(approved|signed|completed|released|acknowledged|paid|won)/.test(value)) return 'bg-emerald-500'
  if (/(uploaded|submitted)/.test(value)) return 'bg-blue-500'
  return 'bg-gray-400'
}

function DocumentStatusCell({ doc }: { doc: DocumentRow }) {
  const kind = documentKindLabel(doc)
  const stage = documentStageLabel(doc)

  return (
    <div className="flex w-full min-w-0 flex-col items-start justify-center gap-1" title={`${kind} - ${stage}`}>
      <div className="flex max-w-full items-center gap-1.5 text-[12px] font-semibold text-slate-800">
        <FileText size={12} className="shrink-0 text-slate-400" />
        <span className="truncate">{kind}</span>
      </div>
      <div className={`flex max-w-full items-center gap-1.5 text-[11px] font-semibold ${stageTextTone(stage)}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stageDotTone(stage)}`} />
        <span className="truncate">{stage}</span>
      </div>
    </div>
  )
}

type StatusTone = { dot: string; text: string }

function statusTone(status?: string | null): StatusTone {
  const value = String(status || '').toLowerCase()

  if (/(trash|deleted|expired|rejected|failed|cancelled|encashed)/.test(value)) {
    return { dot: 'bg-red-500', text: 'text-red-600' }
  }
  if (/(expiring|critical|overdue)/.test(value)) {
    return { dot: 'bg-orange-500', text: 'text-orange-600' }
  }
  if (/(pending|review|draft|processing|warning)/.test(value)) {
    return { dot: 'bg-amber-400', text: 'text-amber-600' }
  }
  if (/(signed|approved|active|paid|released|completed|won|acknowledged)/.test(value)) {
    return { dot: 'bg-blue-500', text: 'text-blue-600' }
  }
  return { dot: 'bg-gray-400', text: 'text-gray-600' }
}

function normalizeShareUserOption(raw: any): ShareUserOption | null {
  const id = Number(raw?.id ?? raw?.value)
  if (!Number.isFinite(id) || id <= 0) return null
  const label = String(raw?.full_name || raw?.name || raw?.label || raw?.username || `User #${id}`).trim()
  return {
    id,
    label: label || `User #${id}`,
    role: raw?.role ? String(raw.role) : undefined,
  }
}

export default function DocumentManagementPage() {
  const [search, setSearch] = useState('')
  const [source, setSource] = useState('all')
  const [view, setView] = useState<ViewKey>('all')
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [summary, setSummary] = useState<DocumentSummary>(DEFAULT_SUMMARY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const { success, error: showError } = useToast()
  const { can } = usePermissions()
  const { label: moduleLabel } = useModuleName('document_management')
  const canCreateDocuments = can('document_management.create')
  const canUpdateDocuments = can('document_management.update')
  const canDeleteDocuments = can('document_management.delete')
  const canExportDocuments = can('document_management.export')

  const [showUpload, setShowUpload] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadName, setUploadName] = useState('')
  const [uploadDescription, setUploadDescription] = useState('')
  const [uploadDocType, setUploadDocType] = useState('')
  const [uploadLinkSource, setUploadLinkSource] = useState('standalone')
  const [uploadRecordId, setUploadRecordId] = useState<number | null>(null)
  const [uploadRecordSearch, setUploadRecordSearch] = useState('')
  const [uploadRecordOptions, setUploadRecordOptions] = useState<LinkRecordOption[]>([])
  const [uploadRecordLoading, setUploadRecordLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadTargetFolderId, setUploadTargetFolderId] = useState<number | null>(null)

  const [previewDoc, setPreviewDoc] = useState<DocumentRow | null>(null)
  const [drilldown, setDrilldown] = useState<DrilldownRequest | null>(null)

  const [ownerFilter, setOwnerFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [customerFilter, setCustomerFilter] = useState<LinkRecordOption | null>(null)
  const [visibleAdvancedFilters, setVisibleAdvancedFilters] = useState<AdvancedFilterKey[]>([])

  const [pageTab, setPageTab] = useState<'all' | 'my_folder'>('all')
  const [folders, setFolders] = useState<FolderNode[]>([])
  const [foldersLoaded, setFoldersLoaded] = useState(false)
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null)
  const [folderDocuments, setFolderDocuments] = useState<DocumentRow[]>([])
  const [folderDocsLoading, setFolderDocsLoading] = useState(false)
  const [folderSearch, setFolderSearch] = useState('')
  const [folderModal, setFolderModal] = useState<
    { mode: 'create'; parentId: number | null } | { mode: 'rename'; folderId: number; initialName: string } | null
  >(null)
  const [folderModalName, setFolderModalName] = useState('')
  const [folderNameError, setFolderNameError] = useState('')
  useEffect(() => { setFolderNameError('') }, [folderModal])
  // upload form validation: format errors while typing, "required" once left, everything on submit
  const uv = useFieldErrors()
  const [folderModalSaving, setFolderModalSaving] = useState(false)

  const [shareDoc, setShareDoc] = useState<DocumentRow | null>(null)
  const [shareUsers, setShareUsers] = useState<ShareUserOption[]>([])
  const [shareSelectedIds, setShareSelectedIds] = useState<Set<number>>(new Set())
  const [shareSearch, setShareSearch] = useState('')
  const [shareLoading, setShareLoading] = useState(false)
  const [shareSaving, setShareSaving] = useState(false)

  const [moveDoc, setMoveDoc] = useState<DocumentRow | null>(null)
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<number | null>(null)
  const [moveSaving, setMoveSaving] = useState(false)

  const isTrashView = view === 'trash'
  const effectiveSource = source

  const loadDocuments = useCallback(async (overrides?: { source?: string; view?: ViewKey }) => {
    const nextSource = overrides?.source ?? effectiveSource
    const nextView = overrides?.view ?? view
    setLoading(true)
    setError('')
    try {
      const { data } = await documentManagementApi.list({
        q: search.trim() || undefined,
        source: nextSource === 'all' ? undefined : nextSource,
        view: nextView === 'all' ? undefined : nextView,
        customer_id: customerFilter?.id,
        limit: 250,
      })
      const payload = data as DocumentResponse
      setDocuments(payload.documents || [])
      setSummary({ ...DEFAULT_SUMMARY, ...(payload.summary || {}) })
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Unable to load documents')
      setDocuments([])
      setSummary(DEFAULT_SUMMARY)
    } finally {
      setLoading(false)
    }
  }, [effectiveSource, search, view, customerFilter])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDocuments()
    }, 250)

    return () => window.clearTimeout(timer)
  }, [loadDocuments])

  const loadFolders = useCallback(async () => {
    try {
      const { data } = await documentManagementApi.listFolders()
      setFolders(Array.isArray(data.folders) ? data.folders : [])
    } catch {
      setFolders([])
    } finally {
      setFoldersLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!foldersLoaded) void loadFolders()
  }, [foldersLoaded, loadFolders])

  const loadFolderDocuments = useCallback(async (folderId: number) => {
    setFolderDocsLoading(true)
    try {
      const { data } = await documentManagementApi.list({ folder_id: folderId, limit: 250 })
      const payload = data as DocumentResponse
      setFolderDocuments(payload.documents || [])
    } catch (err: any) {
      showError(err?.response?.data?.detail || 'Unable to load folder')
      setFolderDocuments([])
    } finally {
      setFolderDocsLoading(false)
    }
  }, [showError])

  useEffect(() => {
    if (selectedFolderId != null) void loadFolderDocuments(selectedFolderId)
    else setFolderDocuments([])
  }, [selectedFolderId, loadFolderDocuments])

  const folderTree = useMemo(() => buildFolderTree(folders), [folders])

  useEffect(() => {
    if (!shareDoc) return undefined

    let cancelled = false
    setShareLoading(true)
    setShareUsers([])
    setShareSelectedIds(new Set())

    Promise.all([
      mastersApi.usersForSelect(),
      documentManagementApi.getShares(shareDoc.id),
    ])
      .then(([usersRes, sharesRes]) => {
        if (cancelled) return
        const rawUsers: any[] = Array.isArray(usersRes.data) ? usersRes.data : usersRes.data?.users || []
        const users = rawUsers
          .map(normalizeShareUserOption)
          .filter((user: ShareUserOption | null): user is ShareUserOption => Boolean(user))
          .sort((left, right) => left.label.localeCompare(right.label))
        const rawShares = Array.isArray(sharesRes.data?.shared_with) ? sharesRes.data.shared_with : []
        const selectedIds = rawShares
          .map((user: any) => Number(user?.id))
          .filter((id: number) => Number.isFinite(id) && id > 0)
        setShareUsers(users)
        setShareSelectedIds(new Set(selectedIds))
      })
      .catch((err: any) => {
        if (!cancelled) showError(err?.response?.data?.detail || 'Unable to load sharing details')
      })
      .finally(() => {
        if (!cancelled) setShareLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [shareDoc, showError])

  const folderBreadcrumb = useMemo(() => {
    if (selectedFolderId == null) return []
    const byId = new Map(folders.map((f) => [f.id, f]))
    const chain: FolderNode[] = []
    let current = byId.get(selectedFolderId)
    while (current) {
      chain.unshift(current)
      current = current.parent_id != null ? byId.get(current.parent_id) : undefined
    }
    return chain
  }, [folders, selectedFolderId])

  const filteredShareUsers = useMemo(() => {
    const term = shareSearch.trim().toLowerCase()
    if (!term) return shareUsers
    return shareUsers.filter((user) =>
      [user.label, user.role].some((value) => String(value || '').toLowerCase().includes(term)),
    )
  }, [shareUsers, shareSearch])

  const openFolderCreateModal = (parentId: number | null) => {
    if (!canCreateDocuments) {
      showError('You do not have permission to create folders')
      return
    }
    setFolderModal({ mode: 'create', parentId })
    setFolderModalName('')
  }

  const openFolderRenameModal = (folder: FolderNode) => {
    if (!canUpdateDocuments) {
      showError('You do not have permission to rename folders')
      return
    }
    setFolderModal({ mode: 'rename', folderId: folder.id, initialName: folder.name })
    setFolderModalName(folder.name)
  }

  const folderNameMsg = (raw: string, requiredCheck: boolean) => {
    const spec = { label: 'Folder name', rule: 'text' as const, required: requiredCheck, max: 200 }
    const m = validate(raw, spec)
    if (m || !raw.trim() || !folderModal) return m
    return validateFolderName(folders, folderModal, raw.trim())
  }
  const handleFolderModalSave = async () => {
    const name = folderModalName.trim()
    if (!folderModal) return
    const nameMsg = folderNameMsg(folderModalName, true)
    if (nameMsg) {
      setFolderNameError(nameMsg)
      document.getElementById('dm-folder-name')?.focus()
      return
    }
    if (folderModal.mode === 'create' && !canCreateDocuments) {
      showError('You do not have permission to create folders')
      return
    }
    if (folderModal.mode === 'rename' && !canUpdateDocuments) {
      showError('You do not have permission to rename folders')
      return
    }
    setFolderModalSaving(true)
    try {
      if (folderModal.mode === 'create') {
        await documentManagementApi.createFolder({ name, parent_id: folderModal.parentId })
        success('Folder created')
      } else {
        await documentManagementApi.renameFolder(folderModal.folderId, { name })
        success('Folder renamed')
      }
      setFolderModal(null)
      await loadFolders()
    } catch (err: any) {
      const fieldMsg = mapApiErrors(err).name
      if (fieldMsg) setFolderNameError(fieldMsg)
      else showError(typeof err?.response?.data?.detail === 'string' ? err.response.data.detail : 'Unable to save folder')
    } finally {
      setFolderModalSaving(false)
    }
  }

  const handleDeleteFolder = async (folder: FolderNode) => {
    if (!canDeleteDocuments) {
      showError('You do not have permission to delete folders')
      return
    }
    const confirmed = await confirmAction({
      title: 'Delete folder?',
      text: `"${folder.name}" and any subfolders will be removed, and their files moved to Trash.`,
      confirmButtonText: 'Delete Folder',
      icon: 'warning',
    })
    if (!confirmed) return

    try {
      await documentManagementApi.deleteFolder(folder.id)
      success('Folder deleted')
      if (selectedFolderId === folder.id) setSelectedFolderId(null)
      await loadFolders()
    } catch (err: any) {
      showError(err?.response?.data?.detail || 'Unable to delete folder')
    }
  }

  const filteredFolderDocuments = useMemo(() => {
    const term = folderSearch.trim().toLowerCase()
    if (!term) return folderDocuments
    return folderDocuments.filter((doc) =>
      [doc.name, doc.doc_type, documentKindLabel(doc), documentStageLabel(doc), documentFileType(doc)].some((value) =>
        String(value || '').toLowerCase().includes(term),
      ),
    )
  }, [folderDocuments, folderSearch])

  const folderStats = useMemo(() => {
    return {
      files: folderDocuments.length,
      shownFiles: filteredFolderDocuments.length,
      pending: folderDocuments.filter((doc) => documentStageLabel(doc).toLowerCase() === 'pending').length,
      starred: folderDocuments.filter((doc) => doc.is_starred).length,
    }
  }, [folderDocuments, filteredFolderDocuments.length])

  useEffect(() => {
    if (!showUpload || uploadLinkSource === 'standalone') {
      setUploadRecordOptions([])
      setUploadRecordLoading(false)
      return undefined
    }

    let cancelled = false
    setUploadRecordLoading(true)
    const timer = window.setTimeout(() => {
      documentManagementApi.linkOptions(uploadLinkSource, {
        q: uploadRecordSearch.trim() || undefined,
        limit: 25,
      })
        .then(({ data }) => {
          if (cancelled) return
          setUploadRecordOptions(Array.isArray(data.records) ? data.records : [])
        })
        .catch(() => {
          if (!cancelled) setUploadRecordOptions([])
        })
        .finally(() => {
          if (!cancelled) setUploadRecordLoading(false)
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [showUpload, uploadLinkSource, uploadRecordSearch])

  const ownerOptions = useMemo(() => {
    const set = new Set<string>()
    documents.forEach((doc) => { if (doc.owner) set.add(doc.owner) })
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [documents])

  const statusOptions = useMemo(() => {
    const set = new Set<string>()
    documents.forEach((doc) => set.add(documentStageLabel(doc)))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [documents])

  const selectedAdvancedFilterSet = useMemo(() => new Set(visibleAdvancedFilters), [visibleAdvancedFilters])

  const filteredDocuments = useMemo(() => {
    const term = search.trim().toLowerCase()
    const from = fromDate ? new Date(`${fromDate}T00:00:00`) : null
    const to = toDate ? new Date(`${toDate}T23:59:59`) : null

    return documents.filter((doc) => {
      if (term) {
        const matchesSearch = [
          doc.name,
          doc.source,
          doc.owner,
          doc.status,
          doc.record_label,
          doc.doc_type,
          documentKindLabel(doc),
          documentStageLabel(doc),
          documentFileType(doc),
        ].some((value) => String(value || '').toLowerCase().includes(term))
        if (!matchesSearch) return false
      }
      if (ownerFilter && doc.owner !== ownerFilter) return false
      if (statusFilter && documentStageLabel(doc) !== statusFilter) return false
      if (from || to) {
        const updated = doc.updated_at ? new Date(doc.updated_at) : null
        if (!updated) return false
        if (from && updated < from) return false
        if (to && updated > to) return false
      }
      return true
    })
  }, [documents, search, ownerFilter, statusFilter, fromDate, toDate])

  const hasActiveFilters = Boolean(
    search.trim() || effectiveSource !== 'all' || ownerFilter || statusFilter || fromDate || toDate || customerFilter || visibleAdvancedFilters.length,
  )

  const clearAdvancedFilter = (filter: AdvancedFilterKey) => {
    if (filter === 'customer') setCustomerFilter(null)
    if (filter === 'owner') setOwnerFilter('')
    if (filter === 'date') {
      setFromDate('')
      setToDate('')
    }
  }

  const hideAdvancedFilter = (filter: AdvancedFilterKey) => {
    setVisibleAdvancedFilters((prev) => prev.filter((item) => item !== filter))
    clearAdvancedFilter(filter)
  }

  const toggleAdvancedFilter = (filter: AdvancedFilterKey) => {
    if (selectedAdvancedFilterSet.has(filter)) {
      hideAdvancedFilter(filter)
      return
    }
    setVisibleAdvancedFilters((prev) => [...prev, filter])
  }

  const resetFilters = () => {
    setSearch('')
    setSource('all')
    setOwnerFilter('')
    setStatusFilter('')
    setFromDate('')
    setToDate('')
    setCustomerFilter(null)
    setVisibleAdvancedFilters([])
  }

  const handleViewChange = (nextView: ViewKey) => {
    setView(nextView)
  }

  const openUploadModal = (initialFolderId: number | null = null) => {
    if (!canCreateDocuments) {
      showError('You do not have permission to upload documents')
      return
    }
    setUploadFile(null)
    setUploadName('')
    setUploadDescription('')
    setUploadDocType('')
    setUploadLinkSource('standalone')
    setUploadRecordId(null)
    setUploadRecordSearch('')
    setUploadRecordOptions([])
    setUploadTargetFolderId(initialFolderId)
    setShowUpload(true)
  }

  const UPLOAD_ORDER = ['file', 'name', 'doc_type', 'record', 'description']
  const uploadSpecs = (linkSource = uploadLinkSource): SpecMap => ({
    name: { label: 'Name', rule: 'text', max: 300 },
    doc_type: { label: 'Document type', rule: 'text', max: 120 },
    description: { label: 'Description', rule: 'textarea', max: 500 },
    record: linkSource !== 'standalone' ? { label: 'Linked record', rule: 'select', required: true } : undefined,
  })
  const uploadValues = (over: Partial<Record<string, Val>> = {}): Record<string, Val> => ({
    file: uploadFile ? uploadFile.name : '', name: uploadName, doc_type: uploadDocType, description: uploadDescription, record: uploadRecordId, ...over,
  })
  const uploadChange = (key: string, value: Val) => uv.change(key, value, uploadSpecs()[key])
  const uploadBlur = (key: string) => uv.blur(key, uploadValues()[key], uploadSpecs()[key])
  useEffect(() => { if (showUpload) uv.clear() }, [showUpload]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleUploadFileSelect = (file: File) => {
    setUploadFile(file)
    uv.setError('file', '')
    if (!uploadName.trim()) { setUploadName(file.name); uploadChange('name', file.name) }
    setUploadDocType(documentTypeFromFile(file))
    uploadChange('doc_type', documentTypeFromFile(file))
  }

  const handleUploadLinkSourceChange = (value: string) => {
    setUploadLinkSource(value)
    setUploadRecordId(null)
    setUploadRecordSearch('')
    setUploadRecordOptions([])
    uv.setError('record', '')
  }

  const handleUpload = async () => {
    if (!canCreateDocuments) {
      showError('You do not have permission to upload documents')
      return
    }
    const bad = uv.validateAll(uploadValues(), uploadSpecs(), uploadFile ? {} : { file: 'Please choose a file to upload.' })
    if (Object.keys(bad).length || !uploadFile) {
      focusFirst(UPLOAD_ORDER, bad, (id) => document.getElementById(`dm-up-${id}`))
      return
    }
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', uploadFile)
      fd.append('name', uploadName.trim() || uploadFile.name)
      fd.append('doc_type', uploadDocType.trim() || 'Uploaded Document')
      fd.append('linked_source', uploadLinkSource)
      if (uploadLinkSource !== 'standalone' && uploadRecordId) {
        fd.append('linked_record_id', String(uploadRecordId))
      }
      if (uploadDescription.trim()) fd.append('description', uploadDescription.trim())
      if (uploadTargetFolderId != null) fd.append('folder_id', String(uploadTargetFolderId))
      await documentManagementApi.upload(fd)
      success('Document uploaded')
      setShowUpload(false)
      if (pageTab === 'my_folder') {
        if (selectedFolderId != null) await loadFolderDocuments(selectedFolderId)
      } else {
        setView('all')
        setSource(uploadLinkSource)
        await loadDocuments({ source: uploadLinkSource, view: 'all' })
      }
    } catch (err: any) {
      const known = Object.fromEntries(Object.entries(mapApiErrors(err, { linked_record_id: 'record' })).filter(([k]) => UPLOAD_ORDER.includes(k)))
      if (Object.keys(known).length) {
        uv.setErrors((prev) => ({ ...prev, ...known }))
        focusFirst(UPLOAD_ORDER, known, (id) => document.getElementById(`dm-up-${id}`))
      } else {
        showError(typeof err?.response?.data?.detail === 'string' ? err.response.data.detail : 'Upload failed')
      }
    } finally {
      setUploading(false)
    }
  }

  // The row actions below are shared by both the "All Documents" table and the
  // "My Folder" table, so refreshing after a change targets whichever list is
  // currently on screen instead of always reloading the flat All Documents list.
  const refreshCurrentView = useCallback(async () => {
    if (pageTab === 'my_folder' && selectedFolderId != null) {
      await loadFolderDocuments(selectedFolderId)
    } else {
      await loadDocuments()
    }
  }, [pageTab, selectedFolderId, loadFolderDocuments, loadDocuments])

  const openShareModal = (doc: DocumentRow) => {
    setShareSearch('')
    setShareDoc(doc)
  }

  const toggleShareUser = (userId: number) => {
    setShareSelectedIds((prev) => {
      const next = new Set(prev)
      next.has(userId) ? next.delete(userId) : next.add(userId)
      return next
    })
  }

  const handleShareSave = async () => {
    if (!shareDoc) return
    setShareSaving(true)
    try {
      await documentManagementApi.share(shareDoc.id, Array.from(shareSelectedIds))
      success('Document shared')
      setShareDoc(null)
      await refreshCurrentView()
    } catch (err: any) {
      showError(err?.response?.data?.detail || 'Unable to share document')
    } finally {
      setShareSaving(false)
    }
  }

  const openMoveModal = (doc: DocumentRow) => {
    if (!canUpdateDocuments) {
      showError('You do not have permission to move documents')
      return
    }
    setMoveDoc(doc)
    setMoveTargetFolderId(doc.folder_id ?? (pageTab === 'my_folder' ? selectedFolderId : null))
    if (!foldersLoaded) void loadFolders()
  }

  const handleMoveSave = async () => {
    if (!moveDoc) return
    setMoveSaving(true)
    try {
      await documentManagementApi.move(moveDoc.id, moveTargetFolderId)
      success(moveTargetFolderId == null ? 'Document moved to library' : 'Document moved')
      setMoveDoc(null)
      await refreshCurrentView()
    } catch (err: any) {
      showError(err?.response?.data?.detail || 'Unable to move document')
    } finally {
      setMoveSaving(false)
    }
  }

  const handleToggleStar = async (doc: DocumentRow) => {
    const applyStar = (starred: boolean) => {
      setDocuments((prev) => prev.map((d) => (d.id === doc.id ? { ...d, is_starred: starred } : d)))
      setFolderDocuments((prev) => prev.map((d) => (d.id === doc.id ? { ...d, is_starred: starred } : d)))
    }
    applyStar(!doc.is_starred)
    try {
      const { data } = await documentManagementApi.toggleStar(doc.id)
      applyStar(Boolean(data.starred))
      if (view === 'starred') await loadDocuments()
      else {
        setSummary((prev) => ({ ...prev, starred: prev.starred + (data.starred ? 1 : -1) }))
      }
    } catch (err: any) {
      applyStar(Boolean(doc.is_starred))
      showError(err?.response?.data?.detail || 'Unable to update star')
    }
  }

  const handleMoveToTrash = async (doc: DocumentRow) => {
    const confirmed = await confirmAction({
      title: 'Delete document?',
      text: `"${doc.name}" will be moved to Trash.`,
      confirmButtonText: 'Move to Trash',
      icon: 'warning',
    })
    if (!confirmed) return

    try {
      await documentManagementApi.trash(doc.id)
      success('Document moved to Trash')
      await refreshCurrentView()
    } catch (err: any) {
      showError(err?.response?.data?.detail || 'Unable to move document to Trash')
    }
  }

  const handleRestore = async (doc: DocumentRow) => {
    try {
      await documentManagementApi.restore(doc.id)
      success('Document restored')
      await refreshCurrentView()
    } catch (err: any) {
      showError(err?.response?.data?.detail || 'Unable to restore document')
    }
  }

  const handleDeletePermanently = async (doc: DocumentRow) => {
    const confirmed = await confirmAction({
      title: 'Permanently delete document?',
      text: `"${doc.name}" will be permanently deleted. This cannot be undone.`,
      confirmButtonText: 'Delete Permanently',
      icon: 'warning',
    })
    if (!confirmed) return

    try {
      await documentManagementApi.deletePermanently(doc.id)
      success('Document permanently deleted')
      await refreshCurrentView()
    } catch (err: any) {
      showError(err?.response?.data?.detail || 'Unable to delete document')
    }
  }

  const starColumn: Column<DocumentRow> = {
    key: 'is_starred',
    header: ' ',
    searchable: false,
    align: 'center',
    width: '2.5rem',
    render: (_value, doc) => (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          void handleToggleStar(doc)
        }}
        className={doc.is_starred ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400'}
        title={doc.is_starred ? 'Remove star' : 'Star document'}
      >
        <Star size={16} className={doc.is_starred ? 'fill-current' : ''} />
      </button>
    ),
  }

  const actionColumn: Column<DocumentRow> = {
    key: 'actions',
    header: 'Action',
    searchable: false,
    align: 'center',
    pinned: true,
    width: '6%',
    minWidth: '5.5rem',
    render: (_value, doc) => (
      <RowActionMenu
        doc={doc}
        isTrashView={isTrashView}
        canMoveToTrash={canDeleteDocuments && doc.can_trash !== false}
        canMove={canUpdateDocuments}
        canRestore={canUpdateDocuments}
        canDeletePermanently={canDeleteDocuments}
        onMoveToTrash={() => void handleMoveToTrash(doc)}
        onShare={() => openShareModal(doc)}
        onMove={() => openMoveModal(doc)}
        onRestore={() => void handleRestore(doc)}
        onDeletePermanently={() => void handleDeletePermanently(doc)}
      />
    ),
  }

  const columns: Column<DocumentRow>[] = [
    ...(!isTrashView ? [starColumn] : []),
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      width: '18%',
      minWidth: '15rem',
      render: (_value, doc) => (
        <div className="min-w-0 pr-2">
          <div className="truncate text-[13px] font-semibold text-slate-950" title={doc.name}>{doc.name}</div>
          <div className="mt-0.5 truncate text-[11px] font-medium text-slate-500" title={`${documentFileType(doc)} file`}>
            {documentFileType(doc)} file
          </div>
        </div>
      ),
    },
    {
      key: 'record_label',
      header: 'Linked Record',
      sortable: true,
      searchKeys: ['source'],
      width: '15%',
      minWidth: '13rem',
      render: (_value, doc) => {
        const entity = RECORD_DRILLDOWN_ENTITY[doc.source_key]
        const canOpen = Boolean(entity && doc.record_id)
        return (
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-slate-700" title={doc.record_label}>
              {doc.record_label || '-'}
            </div>
            {doc.source && (
              <button
                type="button"
                disabled={!canOpen}
                onClick={(event) => {
                  event.stopPropagation()
                  if (!entity || !doc.record_id) return
                  setDrilldown({ entity, id: doc.record_id, label: doc.record_label, seedRow: doc })
                }}
                title={canOpen ? `Open ${doc.source} record` : `Source: ${doc.source}`}
                className={`mt-1 inline-flex max-w-full items-center gap-0.5 text-[10px] font-semibold leading-none text-purple-500 ${
                  canOpen ? 'hover:text-purple-700 hover:underline' : 'cursor-default'
                }`}
              >
                <ExternalLink size={9} className="shrink-0 text-purple-400" />
                <span className="truncate">{doc.source}</span>
              </button>
            )}
          </div>
        )
      },
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      width: '16%',
      minWidth: '13rem',
      exportValue: (doc) => `${documentKindLabel(doc)} - ${documentStageLabel(doc)}`,
      render: (_value, doc) => <DocumentStatusCell doc={doc} />,
    },
    {
      key: 'owner',
      header: 'Owner',
      sortable: true,
      width: '15%',
      minWidth: '8rem',
      render: (_value, doc) => (
        <div className="flex min-w-0 items-center gap-1.5 text-gray-600" title={doc.owner}>
          <span className="truncate">{doc.owner || '-'}</span>
          {doc.is_shared_with_me && (
            <span className="inline-flex shrink-0 items-center rounded-full bg-purple-50 px-1.5 py-0.5 text-[10px] font-semibold text-purple-600">Shared</span>
          )}
        </div>
      ),
    },
    isTrashView
      ? {
          key: 'updated_at',
          header: 'Deleted',
          sortable: true,
          width: '13%',
          minWidth: '7rem',
          render: (_value, doc) => <span className="text-xs font-medium text-gray-500">{fmtRelative(doc.updated_at)}</span>,
        }
      : {
          key: 'created_at',
          header: 'Uploaded',
          sortable: true,
          width: '13%',
          minWidth: '7rem',
          render: (_value, doc) => <span className="text-xs font-medium text-gray-500">{fmtDate(doc.created_at)}</span>,
        },
    {
      key: 'file_type',
      header: 'Documents',
      searchable: false,
      align: 'center',
      width: '8%',
      minWidth: '7rem',
      render: (_value, doc) => (
        <DocumentIconGroup
          doc={doc}
          isTrashView={isTrashView}
          canDownload={canExportDocuments}
          onPreview={() => setPreviewDoc(doc)}
        />
      ),
    },
    {
      key: 'size_kb',
      header: 'Size',
      sortable: true,
      width: '6rem',
      minWidth: '5.5rem',
      hidden: true,
      render: (_value, doc) => <span className="tabular-nums text-xs font-semibold text-gray-500">{fmtSize(doc.size_kb)}</span>,
    },
    ...(isTrashView && !canUpdateDocuments && !canDeleteDocuments ? [] : [actionColumn]),
  ]

  const myFolderColumns: Column<DocumentRow>[] = columns.map((column) => {
    const sizing: Partial<Column<DocumentRow>> =
      column.key === 'is_starred'
        ? { width: '2.25rem', minWidth: '2.25rem' }
        : column.key === 'name'
          ? { width: '24%', minWidth: '12rem' }
          : column.key === 'record_label'
            ? { width: '18%', minWidth: '10rem' }
            : column.key === 'status'
              ? { width: '18%', minWidth: '10rem' }
              : column.key === 'owner'
                ? { width: '12%', minWidth: '6rem' }
                : column.key === 'created_at' || column.key === 'updated_at'
                  ? { width: '10%', minWidth: '6.5rem' }
                  : column.key === 'file_type'
                    ? { width: '5.5rem', minWidth: '5.25rem' }
                    : column.key === 'actions'
                      ? { width: '4.5rem', minWidth: '4.5rem' }
                      : {}
    return { ...column, ...sizing }
  })

  return (
    <div className="page-body space-y-5">
      <PageHeader
        title={moduleLabel}
        subtitle="Store, organize, and securely manage documents in one place."
        breadcrumb={[moduleLabel]}
        actions={(
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshCurrentView()}
              title="Refresh documents"
              aria-label="Refresh documents"
              className="rounded-lg border border-gray-200 bg-white p-1.5 text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600 disabled:opacity-40"
              disabled={loading || folderDocsLoading}
            >
              <RefreshCw size={13} className={loading || folderDocsLoading ? 'animate-spin' : ''} />
            </button>
            {canCreateDocuments && (
              <Button onClick={() => openUploadModal(pageTab === 'my_folder' ? selectedFolderId : null)}>
                <Upload size={15} className="mr-1.5 inline-block" /> Upload Document
              </Button>
            )}
          </div>
        )}
      />

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 bg-slate-100 rounded-2xl p-1.5 w-fit">
          {([
            { id: 'all', label: 'Document Library', icon: <FileText size={13} /> },
            { id: 'my_folder', label: 'My Folder', icon: <Folder size={13} /> },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setPageTab(tab.id)
                if (isTrashView) handleViewChange('all')
              }}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl transition-all whitespace-nowrap ${
                !isTrashView && pageTab === tab.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {tab.icon}{tab.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              if (pageTab !== 'all') setPageTab('all')
              handleViewChange(isTrashView ? 'all' : 'trash')
            }}
            title={isTrashView ? 'Back to all documents' : 'Trash'}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-all whitespace-nowrap ${
              isTrashView
                ? 'bg-white text-red-600 shadow-sm'
                : 'text-slate-500 hover:text-red-600'
            }`}
          >
            <Trash2 size={13} className="shrink-0" />
            <span>Trash</span>
            {summary.trash > 0 && (
              <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white">
                {summary.trash}
              </span>
            )}
          </button>
        </div>
      </div>

      {pageTab === 'all' && (
      <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <DocKpiCard
          label="Document Library"
          value={summary.total}
          icon={<FileText size={16} />}
          tone="slate"
          active={view === 'all'}
          onClick={() => handleViewChange('all')}
        />
        <DocKpiCard
          label="My Documents"
          value={summary.mine}
          icon={<User size={16} />}
          tone="blue"
          active={view === 'mine'}
          onClick={() => handleViewChange('mine')}
        />
        <DocKpiCard
          label="Shared with me"
          value={summary.shared_with_me}
          icon={<Users size={16} />}
          tone="violet"
          active={view === 'shared'}
          onClick={() => handleViewChange('shared')}
        />
        <DocKpiCard
          label="Favorites"
          value={summary.starred}
          icon={<Star size={16} />}
          tone="amber"
          active={view === 'starred'}
          onClick={() => handleViewChange('starred')}
        />
      </div>

      {error && (
        <div className="rounded-xl border border-red-100 bg-red-50 px-5 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        data={filteredDocuments}
        loading={loading}
        keyField="id"
        compact
        showSearch={false}
        showExport={canExportDocuments}
        showColumnToggle
        exportFilename={isTrashView ? 'trash-documents' : 'documents'}
        emptyMessage={isTrashView ? 'No documents in Trash' : 'No documents found'}
        emptyIcon={<ShieldCheck size={22} />}
        toolbarVariant="compact"
        maxHeight="calc(100vh - 360px)"
        initialPageSize={10}
        pageSizeOptions={[10, 25, 50, 100, 'All']}
        showPaginationWhenSinglePage
        rowClassName={() => '[&>td]:align-middle'}
        toolbar={
          <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto whitespace-nowrap pb-0.5">
            <div className="relative w-[190px] flex-none">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search document"
                className="h-9 w-full rounded-xl border border-gray-200 bg-white py-1.5 pl-8 pr-8 text-xs outline-none transition-colors placeholder:text-gray-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  title="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <select
              value={effectiveSource}
              onChange={(event) => setSource(event.target.value)}
              className={`h-9 w-[135px] flex-none rounded-xl border px-2.5 py-1.5 text-xs outline-none transition-colors focus:border-blue-400 bg-white ${
                effectiveSource !== 'all' ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200'
              }`}
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className={`h-9 w-[155px] flex-none rounded-xl border px-2.5 py-1.5 text-xs outline-none transition-colors focus:border-blue-400 bg-white ${
                statusFilter ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200'
              }`}
            >
              <option value="">All Statuses</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
            <MoreFiltersButton
              selectedFilters={visibleAdvancedFilters}
              onToggle={toggleAdvancedFilter}
            />
            {selectedAdvancedFilterSet.has('customer') && (
              <div className="w-[190px] flex-none">
                <CustomerFilterCombo value={customerFilter} onChange={setCustomerFilter} />
              </div>
            )}
            {selectedAdvancedFilterSet.has('owner') && (
              <select
                value={ownerFilter}
                onChange={(event) => setOwnerFilter(event.target.value)}
                className={`h-9 w-[150px] flex-none rounded-xl border px-2.5 py-1.5 text-xs outline-none transition-colors focus:border-blue-400 bg-white ${
                  ownerFilter ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200'
                }`}
              >
                <option value="">All Owners</option>
                {ownerOptions.map((owner) => (
                  <option key={owner} value={owner}>{owner}</option>
                ))}
              </select>
            )}
            {selectedAdvancedFilterSet.has('date') && (
              <div className="flex h-9 flex-none items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-2">
                <input
                  type="date"
                  value={fromDate}
                  onChange={(event) => setFromDate(event.target.value)}
                  title={isTrashView ? 'Deleted from' : 'Modified from'}
                  className="h-7 w-[118px] border-0 bg-transparent text-xs text-gray-600 outline-none"
                />
                <span className="flex-none text-xs text-gray-400">to</span>
                <input
                  type="date"
                  value={toDate}
                  onChange={(event) => setToDate(event.target.value)}
                  title={isTrashView ? 'Deleted to' : 'Modified to'}
                  className="h-7 w-[118px] border-0 bg-transparent text-xs text-gray-600 outline-none"
                />
              </div>
            )}
            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex h-9 flex-none items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
              >
                <X size={12} /> Reset
              </button>
            )}
          </div>
        }
      />
      </>
      )}

      {pageTab === 'my_folder' && (
        <div className="space-y-4">
          <div className="grid min-w-0 items-start gap-4 2xl:grid-cols-[16rem_minmax(0,1fr)]">
            <FolderTreePanel
              tree={folderTree}
              selectedFolderId={selectedFolderId}
              onSelect={setSelectedFolderId}
              onAddRoot={() => openFolderCreateModal(null)}
              onAddChild={(folder) => openFolderCreateModal(folder.id)}
              onRename={openFolderRenameModal}
              onDelete={(folder) => void handleDeleteFolder(folder)}
              canCreate={canCreateDocuments}
              canUpdate={canUpdateDocuments}
              canDelete={canDeleteDocuments}
            />

            <div className="min-w-0 space-y-3 overflow-hidden">
              {selectedFolderId == null ? (
                <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-gray-200 bg-white text-center">
                  <Folder size={28} className="text-gray-300" />
                  <p className="text-sm font-semibold text-gray-500">Select a folder to view its files</p>
                  <p className="text-xs text-gray-400">Or create a new folder to get started</p>
                </div>
              ) : (
                <>
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs font-semibold text-gray-500">
                      {folderBreadcrumb.map((f, i) => (
                        <span key={f.id} className="flex min-w-0 items-center gap-1">
                          {i > 0 && <ChevronRight size={12} className="shrink-0 text-gray-300" />}
                          <span className={i === folderBreadcrumb.length - 1 ? 'truncate text-gray-900' : 'truncate'}>{f.name}</span>
                        </span>
                      ))}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
                      <Star size={12} className="fill-amber-500 text-amber-500" />
                      Favorites
                      <span className="rounded-full bg-white px-1.5 text-[11px] text-amber-700 ring-1 ring-inset ring-amber-200">
                        {folderStats.starred}
                      </span>
                    </div>
                  </div>

                  <DataTable
                    columns={myFolderColumns}
                    data={filteredFolderDocuments}
                    loading={folderDocsLoading}
                    keyField="id"
                    compact
                    showSearch
                    searchValue={folderSearch}
                    onSearchChange={setFolderSearch}
                    searchPlaceholder="Search this folder"
                    showExport={canExportDocuments}
                    showColumnToggle
                    exportFilename="my-folder-documents"
                    emptyMessage="No documents in this folder"
                    emptyIcon={<ShieldCheck size={22} />}
                    toolbarVariant="compact"
                    maxHeight="calc(100vh - 520px)"
                    initialPageSize={10}
                    pageSizeOptions={[10, 25, 50, 100, 'All']}
                    showPaginationWhenSinglePage
                    rowClassName={() => '[&>td]:align-middle'}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {folderModal && (
        <Modal
          open
          onClose={() => setFolderModal(null)}
          title={folderModal.mode === 'create' ? 'New Folder' : 'Rename Folder'}
          size="sm"
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setFolderModal(null)}>Cancel</Button>
              <Button onClick={() => void handleFolderModalSave()} disabled={folderModalSaving}>
                {folderModalSaving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          }
        >
          <label className="mb-1.5 block text-xs font-semibold tracking-wide text-gray-600">Folder Name</label>
          <input
            id="dm-folder-name"
            type="text"
            autoFocus
            maxLength={200}
            value={folderModalName}
            onChange={(e) => { setFolderModalName(e.target.value); setFolderNameError(folderNameMsg(e.target.value, false)) }}
            onBlur={() => setFolderNameError(folderNameMsg(folderModalName, true))}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleFolderModalSave() }}
            placeholder="e.g. Client Contracts"
            aria-invalid={folderNameError ? true : undefined}
            className={`w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none transition-all focus:border-blue-400 focus:ring-1 focus:ring-blue-100 ${folderNameError ? '!border-red-400' : ''}`}
          />
          <FieldError id="dm-folder-name" msg={folderNameError} />
        </Modal>
      )}

      {showUpload && (
        <UploadModal
          file={uploadFile}
          name={uploadName}
          description={uploadDescription}
          docType={uploadDocType}
          linkSource={uploadLinkSource}
          recordId={uploadRecordId}
          recordSearch={uploadRecordSearch}
          recordOptions={uploadRecordOptions}
          recordLoading={uploadRecordLoading}
          uploading={uploading}
          folderId={uploadTargetFolderId}
          folderTree={folderTree}
          onFolderChange={setUploadTargetFolderId}
          errors={uv.errors}
          onFieldBlur={uploadBlur}
          onFile={handleUploadFileSelect}
          onNameChange={(v) => { setUploadName(v); uploadChange('name', v) }}
          onDescriptionChange={(v) => { setUploadDescription(v); uploadChange('description', v) }}
          onDocTypeChange={(v) => { setUploadDocType(v); uploadChange('doc_type', v) }}
          onLinkSourceChange={handleUploadLinkSourceChange}
          onRecordSearchChange={setUploadRecordSearch}
          onRecordChange={(v) => { setUploadRecordId(v); uv.change('record', v, uploadSpecs()['record']) }}
          onClose={() => setShowUpload(false)}
          onSubmit={handleUpload}
        />
      )}

      {shareDoc && (
        <ShareDocumentModal
          doc={shareDoc}
          users={filteredShareUsers}
          selectedIds={shareSelectedIds}
          search={shareSearch}
          loading={shareLoading}
          saving={shareSaving}
          onSearchChange={setShareSearch}
          onToggleUser={toggleShareUser}
          onClose={() => setShareDoc(null)}
          onSave={() => void handleShareSave()}
        />
      )}

      {moveDoc && (
        <MoveDocumentModal
          doc={moveDoc}
          folderTree={folderTree}
          folderId={moveTargetFolderId}
          saving={moveSaving}
          onFolderChange={setMoveTargetFolderId}
          onClose={() => setMoveDoc(null)}
          onSave={() => void handleMoveSave()}
        />
      )}

      {previewDoc && (
        <FilePreviewModal
          fileUrl={previewDoc.url}
          fileName={previewDoc.name}
          allowDownload={canExportDocuments}
          onClose={() => setPreviewDoc(null)}
          infoBanner={<ApprovalInfoBanner doc={previewDoc} />}
        />
      )}

      <RecordViewPanel request={drilldown} onClose={() => setDrilldown(null)} />
    </div>
  )
}

function ApprovalInfoBanner({ doc }: { doc: DocumentRow }) {
  const status = doc.approval_status || 'uploaded'
  if (status === 'uploaded') return null

  const tone = statusTone(status === 'pending_approval' ? 'pending' : status)
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
      <span className={`inline-flex items-center gap-1.5 font-semibold ${tone.text}`}>
        <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
        {status === 'pending_approval' ? 'Pending Approval' : status === 'approved' ? 'Approved' : 'Rejected'}
      </span>
      {doc.approval_submitted_by && (
        <span className="text-gray-500">
          Submitted by <span className="font-medium text-gray-700">{doc.approval_submitted_by}</span>
          {doc.approval_submitted_at && <> on {fmtDate(doc.approval_submitted_at)}</>}
        </span>
      )}
      {doc.approval_decided_by && (
        <span className="text-gray-500">
          {status === 'rejected' ? 'Rejected' : 'Approved'} by <span className="font-medium text-gray-700">{doc.approval_decided_by}</span>
          {doc.approval_decided_at && <> on {fmtDate(doc.approval_decided_at)}</>}
        </span>
      )}
      {doc.approval_comment && (
        <span className="text-gray-500">
          {status === 'rejected' ? 'Reason' : 'Comment'}: <span className="text-gray-700">{doc.approval_comment}</span>
        </span>
      )}
    </div>
  )
}

const KPI_TONES: Record<string, { iconBg: string; iconText: string; ring: string }> = {
  slate: { iconBg: 'bg-slate-100', iconText: 'text-slate-600', ring: 'border-slate-300 ring-slate-100' },
  blue: { iconBg: 'bg-blue-100', iconText: 'text-blue-600', ring: 'border-blue-300 ring-blue-100' },
  violet: { iconBg: 'bg-violet-100', iconText: 'text-violet-600', ring: 'border-violet-300 ring-violet-100' },
  amber: { iconBg: 'bg-amber-100', iconText: 'text-amber-600', ring: 'border-amber-300 ring-amber-100' },
  red: { iconBg: 'bg-red-100', iconText: 'text-red-600', ring: 'border-red-300 ring-red-100' },
}

function DocKpiCard({
  label,
  value,
  icon,
  tone,
  active = false,
  onClick,
}: {
  label: string
  value: number
  icon: React.ReactNode
  tone: keyof typeof KPI_TONES
  active?: boolean
  onClick?: () => void
}) {
  const t = KPI_TONES[tone]
  const className = `flex items-center justify-between gap-3 rounded-xl border bg-white px-4 py-3.5 text-left shadow-sm transition-all ${
    active ? `${t.ring} ring-2` : 'border-gray-100'
  } ${onClick ? 'hover:-translate-y-0.5 hover:shadow-md' : ''}`
  const body = (
    <>
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold text-gray-500">{label}</p>
        <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900">{value.toLocaleString('en-IN')}</p>
      </div>
      <div className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg ${t.iconBg} ${t.iconText}`}>
        {icon}
      </div>
    </>
  )

  if (!onClick) {
    return <div className={className}>{body}</div>
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={className}
    >
      {body}
    </button>
  )
}

function FolderTreePanel({
  tree,
  selectedFolderId,
  onSelect,
  onAddRoot,
  onAddChild,
  onRename,
  onDelete,
  canCreate,
  canUpdate,
  canDelete,
}: {
  tree: FolderTreeNode[]
  selectedFolderId: number | null
  onSelect: (id: number) => void
  onAddRoot: () => void
  onAddChild: (folder: FolderNode) => void
  onRename: (folder: FolderNode) => void
  onDelete: (folder: FolderNode) => void
  canCreate: boolean
  canUpdate: boolean
  canDelete: boolean
}) {
  return (
    <div className="w-full min-w-0 space-y-2 rounded-2xl border border-gray-200 bg-white p-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-bold uppercase tracking-wide text-gray-500">Folders</span>
        {canCreate && (
          <button
            type="button"
            onClick={onAddRoot}
            title="New folder"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            <FolderPlus size={15} />
          </button>
        )}
      </div>
      {tree.length === 0 ? (
        <p className="px-1 py-4 text-center text-xs text-gray-400">No folders yet</p>
      ) : (
        <div className="space-y-0.5">
          {tree.map((node) => (
            <FolderNodeRow
              key={node.id}
              node={node}
              depth={0}
              selectedFolderId={selectedFolderId}
              onSelect={onSelect}
              onAddChild={onAddChild}
              onRename={onRename}
              onDelete={onDelete}
              canCreate={canCreate}
              canUpdate={canUpdate}
              canDelete={canDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FolderNodeRow({
  node,
  depth,
  selectedFolderId,
  onSelect,
  onAddChild,
  onRename,
  onDelete,
  canCreate,
  canUpdate,
  canDelete,
}: {
  node: FolderTreeNode
  depth: number
  selectedFolderId: number | null
  onSelect: (id: number) => void
  onAddChild: (folder: FolderNode) => void
  onRename: (folder: FolderNode) => void
  onDelete: (folder: FolderNode) => void
  canCreate: boolean
  canUpdate: boolean
  canDelete: boolean
}) {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = node.children.length > 0
  const selected = selectedFolderId === node.id
  const hasFolderActions = canCreate || canUpdate || canDelete

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-lg pr-1 text-sm ${selected ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50'}`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className={`flex h-6 w-5 flex-none items-center justify-center text-gray-400 ${hasChildren ? '' : 'invisible'}`}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left font-semibold"
          title={node.name}
        >
          <Folder size={14} className={selected ? 'text-indigo-500' : 'text-gray-400'} />
          <span className="truncate">{node.name}</span>
        </button>
        {hasFolderActions && (
          <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
            {canCreate && (
              <button type="button" onClick={() => onAddChild(node)} title="New subfolder" className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700">
                <Plus size={12} />
              </button>
            )}
            {canUpdate && (
              <button type="button" onClick={() => onRename(node)} title="Rename" className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700">
                <Pencil size={12} />
              </button>
            )}
            {canDelete && (
              <button type="button" onClick={() => onDelete(node)} title="Delete" className="rounded p-1 text-gray-400 hover:bg-red-100 hover:text-red-600">
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <FolderNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedFolderId={selectedFolderId}
              onSelect={onSelect}
              onAddChild={onAddChild}
              onRename={onRename}
              onDelete={onDelete}
              canCreate={canCreate}
              canUpdate={canUpdate}
              canDelete={canDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function MoreFiltersButton({
  selectedFilters,
  onToggle,
}: {
  selectedFilters: AdvancedFilterKey[]
  onToggle: (filter: AdvancedFilterKey) => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const PANEL_W = 230

  const selectedSet = new Set(selectedFilters)

  const reposition = () => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const top = r.bottom + window.scrollY + 4
    const left = Math.max(8, Math.min(r.right + window.scrollX - PANEL_W, window.innerWidth - PANEL_W - 8))
    setPos({ top, left })
  }

  const toggle = () => {
    if (!open) reposition()
    setOpen((o) => !o)
  }

  useEffect(() => {
    if (!open) return undefined
    const close = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return
      if (btnRef.current && e.target instanceof Node && btnRef.current.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const panel = (
    <div
      ref={panelRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_W, zIndex: 100140 }}
      className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-[0_8px_40px_rgba(0,0,0,0.15)]"
    >
      <div className="border-b border-gray-100 px-3 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Add Filters</span>
      </div>
      <div className="p-1.5">
        {ADVANCED_FILTER_OPTIONS.map((option) => {
          const active = selectedSet.has(option.key)
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onToggle(option.key)}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                active ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <span className={`flex h-4 w-4 flex-none items-center justify-center rounded border ${
                active ? 'border-blue-500 bg-blue-600 text-white' : 'border-gray-300 bg-white'
              }`}>
                {active && <Check size={11} />}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold">{option.label}</span>
                <span className="block truncate text-[10px] text-gray-400">{option.description}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className={`inline-flex h-9 flex-none items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs outline-none transition-colors ${
          open || selectedFilters.length > 0 ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
        }`}
      >
        <Filter size={13} className="shrink-0" />
        Filters
        {selectedFilters.length > 0 && (
          <span className="flex h-4 w-4 flex-none items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold leading-none text-white">
            {selectedFilters.length}
          </span>
        )}
      </button>
      {open && createPortal(panel, document.body)}
    </>
  )
}

function CustomerFilterCombo({
  value,
  onChange,
}: {
  value: LinkRecordOption | null
  onChange: (value: LinkRecordOption | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<LinkRecordOption[]>([])
  const [loading, setLoading] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const PANEL_W = 260

  const reposition = () => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const top = r.bottom + window.scrollY + 4
    const left = Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - PANEL_W - 8))
    setPos({ top, left })
  }

  const toggle = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (!open) {
      reposition()
      setQuery('')
    }
    setOpen((o) => !o)
  }

  useEffect(() => {
    if (!open) return undefined
    const close = () => setOpen(false)
    // Scroll events don't bubble, so a capture-phase listener on window sees
    // every scroll on the page — including inside this dropdown's own results
    // list. Ignore those so scrolling/focusing within the panel can't
    // self-close it; only an outside page scroll should dismiss it.
    const closeOnOutsideScroll = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return
      close()
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', closeOnOutsideScroll, true)
    window.addEventListener('resize', close)
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', closeOnOutsideScroll, true)
      window.removeEventListener('resize', close)
      window.clearTimeout(focusTimer)
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      documentManagementApi.linkOptions('customers', { q: query.trim() || undefined, limit: 20 })
        .then(({ data }) => {
          if (!cancelled) setOptions(Array.isArray(data.records) ? data.records : [])
        })
        .catch(() => {
          if (!cancelled) setOptions([])
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query])

  // Instant client-side narrowing of the already-loaded options while the
  // debounced server search is still in flight, so typing always visibly
  // filters the list right away instead of appearing to do nothing for 250ms+.
  const visibleOptions = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return options
    return options.filter((option) =>
      option.label?.toLowerCase().includes(term) || option.subtitle?.toLowerCase().includes(term),
    )
  }, [options, query])

  const panel = (
    <div
      ref={panelRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_W, zIndex: 100140 }}
      className="overflow-hidden rounded-xl border border-gray-100 bg-white shadow-[0_8px_40px_rgba(0,0,0,0.15)]"
    >
      <div className="border-b border-gray-100 p-2">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search customers..."
            className="w-full rounded-lg border border-gray-200 py-1.5 pl-7 pr-2 text-xs outline-none transition-colors focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
          />
        </div>
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {value && (
          <button
            type="button"
            onClick={() => { onChange(null); setOpen(false) }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-50"
          >
            <X size={12} /> Clear selection
          </button>
        )}
        {loading && options.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-gray-400">Searching...</div>
        ) : visibleOptions.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-gray-400">No customers found</div>
        ) : visibleOptions.map((option) => {
          const selected = value?.id === option.id
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => { onChange(option); setOpen(false) }}
              className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                selected ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-500">
                {(option.label || '?').slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold">{option.label}</span>
                {option.subtitle && <span className="block truncate text-[10px] text-gray-400">{option.subtitle}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <div className="block w-full">
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title={value ? `Customer: ${value.label}` : 'Filter by customer'}
        className={`flex h-9 w-full items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs outline-none transition-colors focus:border-blue-400 ${
          value ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
        }`}
      >
        <Building2 size={13} className="shrink-0" />
        <span className="truncate">{value ? value.label : 'All Customers'}</span>
        {value && (
          <X
            size={12}
            className="ml-auto shrink-0 text-blue-400 hover:text-blue-700"
            onClick={(e) => { e.stopPropagation(); onChange(null) }}
          />
        )}
      </button>
      {open && createPortal(panel, document.body)}
    </div>
  )
}

// Non-trash rows show a preview + download icon pair; trashed rows only show
// a muted file icon since preview/download aren't available once trashed.
function DocumentIconGroup({
  doc,
  isTrashView,
  canDownload,
  onPreview,
}: {
  doc: DocumentRow
  isTrashView: boolean
  canDownload: boolean
  onPreview: () => void
}) {
  if (isTrashView) {
    return (
      <div className="flex w-full items-center justify-center">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-50 text-slate-400"
          title={`${documentFileType(doc)} file`}
        >
          <FileText size={14} />
        </span>
      </div>
    )
  }
  return (
    <div onClick={(e) => e.stopPropagation()} className="flex w-full items-center justify-center gap-1.5">
      <button
        type="button"
        onClick={onPreview}
        title="Preview document"
        aria-label={`Preview ${doc.name}`}
        className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50 text-blue-600 transition-all hover:bg-blue-100"
      >
        <FileText size={14} />
      </button>
      {canDownload && (
        <a
          href={buildFilePreviewUrl(doc.url, '/preview/download')}
          download={doc.name}
          onClick={(event) => event.stopPropagation()}
          title="Download document"
          aria-label={`Download ${doc.name}`}
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 transition-all hover:bg-emerald-100"
        >
          <Download size={14} />
        </a>
      )}
    </div>
  )
}

// Destructive/state-changing actions live behind a kebab menu instead of a
// row of colored buttons, so the table reads cleanly at a glance.
function RowActionMenu({
  doc,
  isTrashView,
  canMoveToTrash,
  canMove,
  canRestore,
  canDeletePermanently,
  onMoveToTrash,
  onShare,
  onMove,
  onRestore,
  onDeletePermanently,
}: {
  doc: DocumentRow
  isTrashView: boolean
  canMoveToTrash: boolean
  canMove: boolean
  canRestore: boolean
  canDeletePermanently: boolean
  onMoveToTrash: () => void
  onShare: () => void
  onMove: () => void
  onRestore: () => void
  onDeletePermanently: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const PANEL_W = 180

  const items = (
    isTrashView
      ? [
          canRestore && { label: 'Restore', icon: RotateCcw, tone: 'text-blue-600', onClick: onRestore },
          canDeletePermanently && { label: 'Delete permanently', icon: Trash2, tone: 'text-red-600', onClick: onDeletePermanently },
        ]
      : [
          canMoveToTrash && { label: 'Delete', icon: Trash2, tone: 'text-red-600', onClick: onMoveToTrash },
          { label: 'Share', icon: Share2, tone: 'text-blue-600', onClick: onShare },
          canMove && { label: 'Move', icon: FolderInput, tone: 'text-slate-600', onClick: onMove },
        ]
  ).filter(Boolean) as { label: string; icon: typeof Trash2; tone: string; onClick: () => void }[]

  const reposition = () => {
    if (!btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const top = r.bottom + window.scrollY + 4
    const left = Math.max(8, Math.min(r.right + window.scrollX - PANEL_W, window.innerWidth - PANEL_W - 8))
    setPos({ top, left })
  }

  const toggle = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (!open) reposition()
    setOpen((o) => !o)
  }

  useEffect(() => {
    if (!open) return undefined
    const close = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return
      if (btnRef.current && e.target instanceof Node && btnRef.current.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  if (!items.length) return null

  const panel = (
    <div
      ref={panelRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_W, zIndex: 100140 }}
      className="overflow-hidden rounded-xl border border-gray-100 bg-white p-1 shadow-[0_8px_40px_rgba(0,0,0,0.15)]"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpen(false)
            item.onClick()
          }}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold transition-colors hover:bg-gray-50 ${item.tone}`}
        >
          <item.icon size={13} className="shrink-0" />
          {item.label}
        </button>
      ))}
    </div>
  )

  return (
    <div onClick={(e) => e.stopPropagation()} className="flex items-center justify-center">
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title="More actions"
        aria-label={`More actions for ${doc.name}`}
        className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
          open ? 'bg-gray-100 text-gray-700' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
        }`}
      >
        <MoreVertical size={15} />
      </button>
      {open && createPortal(panel, document.body)}
    </div>
  )
}

function ShareDocumentModal({
  doc,
  users,
  selectedIds,
  search,
  loading,
  saving,
  onSearchChange,
  onToggleUser,
  onClose,
  onSave,
}: {
  doc: DocumentRow
  users: ShareUserOption[]
  selectedIds: Set<number>
  search: string
  loading: boolean
  saving: boolean
  onSearchChange: (value: string) => void
  onToggleUser: (userId: number) => void
  onClose: () => void
  onSave: () => void
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Share Document"
      subtitle={doc.name}
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={onSave} loading={saving} disabled={loading} leftIcon={<Share2 size={14} />}>
            Share
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search users"
            className="h-10 w-full rounded-xl border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm outline-none transition-all focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
          />
        </div>

        <div className="max-h-72 overflow-y-auto rounded-xl border border-gray-200 bg-white">
          {loading ? (
            <div className="px-4 py-8 text-center text-sm font-medium text-gray-400">Loading users...</div>
          ) : users.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm font-medium text-gray-400">No users found</div>
          ) : users.map((user) => {
            const selected = selectedIds.has(user.id)
            return (
              <button
                key={user.id}
                type="button"
                onClick={() => onToggleUser(user.id)}
                disabled={saving}
                className={`flex w-full items-center gap-3 border-b border-gray-50 px-3.5 py-3 text-left transition-colors last:border-b-0 disabled:cursor-not-allowed disabled:opacity-70 ${
                  selected ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span className={`flex h-8 w-8 flex-none items-center justify-center rounded-lg ${
                  selected ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-400'
                }`}>
                  <User size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{user.label}</span>
                  {user.role && <span className="mt-0.5 block truncate text-xs text-gray-400">{user.role}</span>}
                </span>
                <span className={`flex h-5 w-5 flex-none items-center justify-center rounded border ${
                  selected ? 'border-blue-500 bg-blue-600 text-white' : 'border-gray-300 bg-white'
                }`}>
                  {selected && <Check size={13} />}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

function MoveDocumentModal({
  doc,
  folderTree,
  folderId,
  saving,
  onFolderChange,
  onClose,
  onSave,
}: {
  doc: DocumentRow
  folderTree: FolderTreeNode[]
  folderId: number | null
  saving: boolean
  onFolderChange: (folderId: number | null) => void
  onClose: () => void
  onSave: () => void
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title="Move Document"
      subtitle={doc.name}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={onSave} loading={saving} leftIcon={<FolderInput size={14} />}>
            Move
          </Button>
        </div>
      }
    >
      <div>
        <label className="mb-1.5 block text-xs font-semibold tracking-wide text-gray-600">Destination</label>
        <FolderCascadeSelect tree={folderTree} value={folderId} onChange={onFolderChange} disabled={saving} />
      </div>
    </Modal>
  )
}

// Progressive drill-down folder picker: one <select> per depth level, each
// listing the previous level's chosen folder's subfolders. Selecting a
// folder with no subfolders stops the chain; clearing a level falls back to
// its parent as the resolved target.
function FolderCascadeSelect({
  tree,
  value,
  onChange,
  disabled,
}: {
  tree: FolderTreeNode[]
  value: number | null
  onChange: (value: number | null) => void
  disabled?: boolean
}) {
  const path = useMemo(() => {
    if (value == null) return [] as FolderTreeNode[]
    const chain: FolderTreeNode[] = []
    const find = (nodes: FolderTreeNode[]): boolean => {
      for (const node of nodes) {
        if (node.id === value) {
          chain.push(node)
          return true
        }
        if (find(node.children)) {
          chain.unshift(node)
          return true
        }
      }
      return false
    }
    find(tree)
    return chain
  }, [tree, value])

  const levels: FolderTreeNode[][] = [tree, ...path.map((n) => n.children).filter((c) => c.length > 0)]

  return (
    <div className="space-y-2">
      {levels.map((options, levelIndex) => (
        <select
          key={levelIndex}
          value={path[levelIndex]?.id ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null
            onChange(id ?? (levelIndex === 0 ? null : path[levelIndex - 1]?.id ?? null))
          }}
          className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition-all focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-gray-50"
        >
          <option value="">
            {levelIndex === 0 ? 'No folder (Document Library only)' : `— None (use "${path[levelIndex - 1]?.name}")`}
          </option>
          {options.map((node) => (
            <option key={node.id} value={node.id}>{node.name}</option>
          ))}
        </select>
      ))}
    </div>
  )
}

function UploadModal({
  file,
  name,
  description,
  docType,
  linkSource,
  recordId,
  recordSearch,
  recordOptions,
  recordLoading,
  uploading,
  folderId,
  folderTree,
  onFolderChange,
  onFile,
  onNameChange,
  onDescriptionChange,
  onDocTypeChange,
  onLinkSourceChange,
  onRecordSearchChange,
  onRecordChange,
  onClose,
  onSubmit,
  errors = {},
  onFieldBlur = () => undefined,
}: {
  errors?: Record<string, string>
  onFieldBlur?: (key: string) => void
  file: File | null
  name: string
  description: string
  docType: string
  linkSource: string
  recordId: number | null
  recordSearch: string
  recordOptions: LinkRecordOption[]
  recordLoading: boolean
  uploading: boolean
  folderId: number | null
  folderTree: FolderTreeNode[]
  onFolderChange: (value: number | null) => void
  onFile: (file: File) => void
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onDocTypeChange: (value: string) => void
  onLinkSourceChange: (value: string) => void
  onRecordSearchChange: (value: string) => void
  onRecordChange: (value: number | null) => void
  onClose: () => void
  onSubmit: () => void
}) {
  return createPortal(
    <div className="fixed inset-0 z-[100130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 bg-blue-50/50 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-100">
              <Upload size={15} className="text-blue-600" />
            </div>
            <h3 className="text-sm font-bold text-gray-900">Upload Document</h3>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-200">
            <X size={15} />
          </button>
        </div>
        <div className="max-h-[calc(90vh-9rem)] space-y-4 overflow-y-auto p-6">
          <div id="dm-up-file" tabIndex={-1} className={errors.file ? 'rounded-xl ring-1 ring-red-400' : undefined}>
          <DropFileUpload
            label="Drop a file here, or click to browse"
            file={file}
            variant="panel"
            uploading={uploading}
            onFile={onFile}
          />
          <FieldError id="dm-up-file" msg={errors.file} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold tracking-wide text-gray-600">Folder</label>
              <FolderCascadeSelect tree={folderTree} value={folderId} onChange={onFolderChange} disabled={uploading} />
              <p className="mt-1.5 text-[11px] text-gray-400">Files this document into your personal My Folder tree.</p>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold tracking-wide text-gray-600">Name</label>
              <input
                id="dm-up-name"
                type="text"
                value={name}
                disabled={uploading}
                onChange={(e) => onNameChange(e.target.value)}
                onBlur={() => onFieldBlur('name')}
                placeholder="e.g. Company Profile.pdf"
                className={`w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none transition-all focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-gray-50 ${errors.name ? '!border-red-400' : ''}`}
              />
              <FieldError id="dm-up-name" msg={errors.name} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold tracking-wide text-gray-600">Link Source</label>
              <select
                value={linkSource}
                disabled={uploading}
                onChange={(e) => onLinkSourceChange(e.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition-all focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-gray-50"
              >
                {LINK_SOURCE_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold tracking-wide text-gray-600">Document Type</label>
              <input
                id="dm-up-doc_type"
                type="text"
                value={docType}
                disabled={uploading}
                onChange={(e) => onDocTypeChange(e.target.value)}
                onBlur={() => onFieldBlur('doc_type')}
                placeholder="Auto detected from selected file"
                className={`w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none transition-all focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-gray-50 ${errors.doc_type ? '!border-red-400' : ''}`}
              />
              <FieldError id="dm-up-doc_type" msg={errors.doc_type} />
            </div>
          </div>
          {linkSource !== 'standalone' && (
            <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3.5">
              <label className="mb-0.5 block text-xs font-bold tracking-wide text-gray-700">
                Linked Record <span className="text-red-500">*</span>
              </label>
              <p className="mb-2 text-[11px] text-gray-400">Links this file to a CRM record (unrelated to the folder above). Required for this Link Source.</p>
              <div className="relative">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  id="dm-up-record"
                  type="text"
                  value={recordSearch}
                  disabled={uploading}
                  onChange={(e) => onRecordSearchChange(e.target.value)}
                  placeholder="Search records"
                  className={`w-full rounded-xl border border-gray-200 py-2 pl-8 pr-3 text-sm outline-none transition-all focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-gray-50 ${errors.record ? '!border-red-400' : ''}`}
                />
              </div>
              <div className="mt-2.5 max-h-52 overflow-y-auto rounded-xl border border-gray-200 bg-white">
                {recordLoading ? (
                  <div className="px-3 py-5 text-center text-sm text-gray-400">Loading records...</div>
                ) : recordOptions.length === 0 ? (
                  <div className="px-3 py-5 text-center text-sm text-gray-400">No records found</div>
                ) : recordOptions.map((record) => {
                  const selected = recordId === record.id
                  return (
                    <button
                      key={`${record.source_key}-${record.id}`}
                      type="button"
                      disabled={uploading}
                      onClick={() => onRecordChange(selected ? null : record.id)}
                      className={`flex w-full items-start justify-between gap-3 border-b border-gray-50 px-3.5 py-3 text-left transition-colors last:border-b-0 ${
                        selected ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">{record.label}</span>
                        {record.subtitle && <span className="mt-0.5 block truncate text-xs text-gray-400">{record.subtitle}</span>}
                      </span>
                      {selected && <span className="mt-0.5 h-2 w-2 flex-none rounded-full bg-blue-500" />}
                    </button>
                  )
                })}
              </div>
              <FieldError id="dm-up-record" msg={errors.record} />
            </div>
          )}
          <div>
            <label className="mb-1.5 block text-xs font-semibold tracking-wide text-gray-600">
              Description <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <textarea
              id="dm-up-description"
              value={description}
              disabled={uploading}
              onChange={(e) => onDescriptionChange(e.target.value)}
              onBlur={() => onFieldBlur('description')}
              rows={2}
              className={`w-full resize-none rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none transition-all focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-gray-50 ${errors.description ? '!border-red-400' : ''}`}
            />
            <FieldError id="dm-up-description" msg={errors.description} />
          </div>
        </div>
        <div className="flex gap-3 border-t border-gray-100 bg-gray-50/50 px-6 py-4">
          <button onClick={onClose} className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-600 transition-colors hover:bg-gray-100">
            Cancel
          </button>
          <Button onClick={onSubmit} loading={uploading} className="flex-1">
            {uploading ? 'Uploading...' : 'Upload'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
