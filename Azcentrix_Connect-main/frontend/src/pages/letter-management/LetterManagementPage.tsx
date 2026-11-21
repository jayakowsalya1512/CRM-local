import { useState, useMemo, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
LayoutTemplate,
Trash2,
Plus,
RefreshCw,
RotateCcw,
Eye,
Pencil,
Copy,
Search,
X,
AlertTriangle,
CheckCircle2,
SlidersHorizontal,
MoreVertical,
FileText,
Download,
Briefcase,
ShieldCheck,
Users,
Printer,
Mail,
MapPin,
ChevronDown,
GripVertical,
Bold,
Italic,
Underline,
AlignLeft,
AlignCenter,
Link2,
Undo2,
Redo2,
List,
} from 'lucide-react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { Card } from '@/components/ui/Card'
import { FormCard, PageHeader, StatCard } from '@/components/ui/FormComponents'
import Button from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { usePermissions } from '@/hooks/Usepermissions'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { useToast } from '@/components/ui/ToastContext'
import { useAuthStore } from '@/store'
import api, { buildApiAssetUrl } from '@/services/api'
import { downloadBlob, safeFileName } from '@/utils/reportExport'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors, type SpecMap } from '@/hooks/useFieldErrors'
import { focusFirst, mapApiErrors, validate, vEmail, type Val } from '@/utils/validation'

// ─── Types ────────────────────────────────────────────────────────────────────

type PageTab = 'templates' | 'trash'
type SignatureOption = 'signature' | 'none'
type SignatoryOption = 'authorized' | 'none'
// Older letters may hold 'seal' (now shown as a signature line) or 'authorized' (meaning nothing on the right).
const normalizeSignatureOption = (value?: string): SignatureOption => (value === 'none' || value === 'authorized' ? 'none' : 'signature')

interface LetterTemplateItem {
id: string
name: string
category: string
folder?: string
description?: string
subject: string
template_body: string
variables: string[]
version: number
is_default: boolean
is_active: boolean
created_at: string
updated_at: string
}

interface TrashedItem {
id: string
original_id: string
title: string
subtitle: string
category: string
deleted_at: string
data: LetterTemplateItem
}

const previewHtml = (content: string) => {
  if (!/<\/?[a-z][\s\S]*>/i.test(content)) return content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  const documentBody = new DOMParser().parseFromString(content, 'text/html').body
  documentBody.querySelectorAll('script, style, iframe, object, embed').forEach((node) => node.remove())
  documentBody.querySelectorAll('*').forEach((node) => {
    Array.from(node.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase()
      const allowed = ['href', 'target', 'rel', 'colspan', 'rowspan']
      if (name.startsWith('on') || !allowed.includes(name) || (name === 'href' && !/^(https?:|mailto:|#)/i.test(attribute.value))) {
        node.removeAttribute(attribute.name)
      }
    })
  })
  return documentBody.innerHTML
}

const DEFAULT_TEMPLATES: LetterTemplateItem[] = [
{
id: 'tmpl-1',
name: 'Standard Quotation Cover Letter',
category: 'Quotations',
subject: 'Quotation for {{project_name}} - Ref: {{ref_no}}',
template_body: `Dear {{recipient_name}},

Thank you for giving us the opportunity to submit our proposal for {{project_name}}.

We are pleased to enclose herewith our formal commercial and technical quotation (Ref: {{ref_no}}). Our proposal has been carefully prepared according to your specifications and requirements.

Key Highlights:

Comprehensive compliance with technical requirements

Delivery within {{delivery_days}} days from receipt of confirmed work order

Warranty and after-sales support included as detailed

Should you require any further clarifications or adjustments, please do not hesitate to contact the undersigned.

Sincerely,
{{signatory_name}}
{{company_name}},
    variables: ['recipient_name', 'project_name', 'ref_no', 'delivery_days', 'signatory_name', 'company_name'],
    version: 1,
    is_default: true,
    is_active: true,
    created_at: '2026-08-15',
    updated_at: '2026-08-20',
  },
  {
    id: 'tmpl-2',
    name: 'Formal Authorization Letter',
    category: 'Authorization',
    subject: 'Letter of Authority - Representative for {{tender_name}}',
    template_body: TO WHOMSOEVER IT MAY CONCERN

Subject: Authorization to represent {{company_name}}

This is to certify that {{representative_name}}, holding designation {{representative_designation}}, is hereby authorized to submit bids, attend pre-bid meetings, sign official documents, and represent our company in all matters concerning {{tender_name}} (Tender No: {{tender_no}}).

Specimen signature of the authorized representative:

This authorization remains valid until {{valid_until_date}} unless revoked in writing earlier.

Authorized Signatory:
{{signatory_name}}
{{company_name}},
    variables: ['company_name', 'representative_name', 'representative_designation', 'tender_name', 'tender_no', 'valid_until_date', 'signatory_name'],
    version: 1,
    is_default: false,
    is_active: true,
    created_at: '2026-08-18',
    updated_at: '2026-08-25',
  },
  {
    id: 'tmpl-3',
    name: 'Client Appreciation & Follow-up',
    category: 'Customer Service',
    subject: 'Thank You for Your Partnership - {{customer_name}}',
    template_body: Dear {{recipient_name}},

We would like to express our sincere appreciation for the trust and confidence {{customer_name}} has placed in our products and services over the past months.

Our team has completed the recent milestone for {{project_name}}, and we look forward to continuing our strong collaboration. Please let us know if there is anything additional our team can support you with.

Warm regards,
{{signatory_name}}
{{company_name}}`,
variables: ['recipient_name', 'customer_name', 'project_name', 'signatory_name', 'company_name'],
version: 1,
is_default: false,
is_active: true,
created_at: '2026-08-22',
updated_at: '2026-08-28',
},
]

const STORAGE_KEY_LETTERS = 'crm_letter_mgmt_letters_v1'
const STORAGE_KEY_TRASHED_LETTERS = 'crm_letter_mgmt_trashed_letters_v1'

// ─── Generated Letters (per-template log of letters issued from it) ──────────

interface GeneratedLetter {
id: string
template_id: string
customer_id?: number
ref_number: string
description?: string
letter_subject?: string
letter_body?: string
recipient_name: string
recipient_email: string
recipient_company: string
recipient_address?: string
issue_date: string
valid_until: string
region?: string
status?: string
language?: string
branch?: string
sub_branch?: string
department?: string
sub_department?: string
designation?: string
table_columns?: string[]
template_values?: Record<string, string>
signature_option?: SignatureOption
signatory_option?: SignatoryOption
}

// server_deleted marks letters whose server copy is also in the Recycle Bin; letters trashed
// before that existed were only removed locally.
type TrashedLetter = GeneratedLetter & { deleted_at: string; server_deleted?: boolean }

// One row of the Recycle Bin table — templates (server) and letters (local) share it.
interface RecycleBinRow {
key: string
kind: 'template' | 'letter'
title: string
subtitle: string
category: string
deleted_at: string
onRestore: () => void
onDelete: () => void
}

const DEFAULT_GENERATED_LETTERS: GeneratedLetter[] = [
{
id: 'letter-1',
template_id: 'tmpl-1',
ref_number: 'QL20260006',
recipient_name: 'Johnathan Doe',
recipient_email: 'johnathan.doe@acmeinfra.com',
recipient_company: 'Acme Infrastructure Ltd',
issue_date: '2026-09-01',
valid_until: '2026-12-31',
},
{
id: 'letter-2',
template_id: 'tmpl-1',
ref_number: 'QL20260005',
recipient_name: 'Priya Menon',
recipient_email: 'priya.menon@brightgrid.com',
recipient_company: 'BrightGrid Power Systems',
issue_date: '2026-08-18',
valid_until: '2026-11-30',
},
]

const formatDisplayDate = (value?: string) => {
if (!value) return new Date().toLocaleDateString('en-GB')
const parsed = new Date(value)
return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-GB')
}

// Category badge icon + color — cycles through this palette for any
// custom category the user adds beyond the three built-in ones.
const CATEGORY_STYLES: Record<string, { icon: React.ReactNode; badge: string }> = {
Quotations: { icon: <Briefcase size={16} />, badge: 'bg-blue-50 text-blue-600' },
Authorization: { icon: <ShieldCheck size={16} />, badge: 'bg-emerald-50 text-emerald-600' },
'Customer Service': { icon: <Users size={16} />, badge: 'bg-violet-50 text-violet-600' },
}
const CATEGORY_STYLE_FALLBACKS = [
{ icon: <LayoutTemplate size={16} />, badge: 'bg-amber-50 text-amber-600' },
{ icon: <LayoutTemplate size={16} />, badge: 'bg-rose-50 text-rose-600' },
{ icon: <LayoutTemplate size={16} />, badge: 'bg-cyan-50 text-cyan-600' },
]
function categoryStyle(category: string, index: number) {
return CATEGORY_STYLES[category] || CATEGORY_STYLE_FALLBACKS[index % CATEGORY_STYLE_FALLBACKS.length]
}

export default function LetterManagementPage() {
const { can } = usePermissions()
const { label: moduleLabel } = useModuleName('letter_management')
const { success: toastSuccess, info: toastInfo, error: toastError } = useToast()
// Template management (create/edit/duplicate/delete/trash) is admin-only;
// other roles can still view templates and generate/manage their letters.
const isTemplateAdmin = useAuthStore((s) => s.user?.role === 'admin')
const currentUser = useAuthStore((s) => s.user)

// ── State ───────────────────────────────────────────────────────────────────
const [pageTab, setPageTab] = useState<PageTab>('templates')
const [refreshing, setRefreshing] = useState(false)

// Data
const [templates, setTemplates] = useState<LetterTemplateItem[]>([])
const [trashItems, setTrashItems] = useState<TrashedItem[]>([])

// Generated letters — a per-template log of individual letters issued from it,
// opened by clicking a template name (mock/local data, not yet backed by real Quotations)
const [generatedLetters, setGeneratedLetters] = useState<GeneratedLetter[]>(() => {
try {
const stored = localStorage.getItem(STORAGE_KEY_LETTERS)
return stored ? JSON.parse(stored) : DEFAULT_GENERATED_LETTERS
} catch {
return DEFAULT_GENERATED_LETTERS
}
})
const [trashedLetters, setTrashedLetters] = useState<TrashedLetter[]>(() => {
try {
const stored = localStorage.getItem(STORAGE_KEY_TRASHED_LETTERS)
return stored ? JSON.parse(stored) : []
} catch {
return []
}
})
const [openTemplateId, setOpenTemplateId] = useState<string | null>(null)
const [letterModalOpen, setLetterModalOpen] = useState(false)
const [editingLetter, setEditingLetter] = useState<GeneratedLetter | null>(null)
const [letterForm, setLetterForm] = useState({
customer_id: '' as number | '', quotation_id: '' as number | '',
ref_number: '', description: '', recipient_name: '', recipient_email: '', recipient_company: '', recipient_address: '',
letter_subject: '', letter_body: '',
issue_date: '', valid_until: '', region: '', status: 'Draft', language: 'English', branch: '', sub_branch: '',
department: '', sub_department: '', designation: '', table_columns: [] as string[], template_values: {} as Record<string, string>, signature_option: 'signature' as SignatureOption, signatory_option: 'authorized' as SignatoryOption,
})
const [confirmDeleteLetter, setConfirmDeleteLetter] = useState<GeneratedLetter | null>(null)
const [emailLetter, setEmailLetter] = useState<GeneratedLetter | null>(null)
const [emailRecipient, setEmailRecipient] = useState('')
const [emailRecipientError, setEmailRecipientError] = useState('')
// Kept for compatibility with saved draft data; table controls are no longer shown.
const [, setLetterFormTab] = useState<'customer' | 'table'>('customer')
const [letterTableBuilderOpen, setLetterTableBuilderOpen] = useState(false)
const [letterTableColumns, setLetterTableColumns] = useState<string[]>(['S.No', 'Item Description', 'Qty', 'Unit Price', 'GST %', 'GST Value', 'Net Price', 'Total Price'])
const [letterContentVersion, setLetterContentVersion] = useState(0)
const letterBodyRef = useRef<HTMLDivElement>(null)

// Real CRM customers — used by "Create Letter" to auto-fill recipient fields
const [customerOptions, setCustomerOptions] = useState<{ id: number; customer_name: string }[]>([])
const [customerLoading, setCustomerLoading] = useState(false)
const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false)
const [customerSearch, setCustomerSearch] = useState('')
const [listMenuOpen, setListMenuOpen] = useState(false)
useEffect(() => {
api.get('/leads/team-customers?assigned_only=true').then((r) => {
setCustomerOptions((r.data as any[]).filter((c) => c.customer_name).map((c) => ({ id: c.id, customer_name: c.customer_name })))
}).catch(() => {})
}, [])

const applyCustomerToLetterForm = async (customerId: number) => {
setCustomerLoading(true)
try {
const { data } = await api.get(`/customers/${customerId}`)
const contacts: any[] = data.contacts || []
const primaryContact = contacts.find((c) => c.is_primary) || contacts[0] || null
const customData = data.custom_data && typeof data.custom_data === 'object' ? data.custom_data : {}
// Customer installations may store these organisational fields in custom
// fields, so accept both the standard and common custom-field names.
const valueFrom = (...keys: string[]) => {
for (const key of keys) {
const value = customData[key] ?? data[key] ?? primaryContact?.[key]
if (typeof value === 'string' && value.trim()) return value.trim()
}
return ''
}
const address = [data.billing_address, data.billing_area, data.billing_city, data.billing_state, data.billing_pincode]
.filter(Boolean).join(', ')
setLetterForm((prev) => ({
...prev,
customer_id: customerId,
recipient_name: primaryContact?.contact_name || data.customer_name || prev.recipient_name,
recipient_email: primaryContact?.office_email || primaryContact?.personal_email || prev.recipient_email,
recipient_company: data.customer_name || prev.recipient_company,
recipient_address: address || prev.recipient_address,
region: valueFrom('region', 'region_name', 'billing_region') || prev.region,
branch: valueFrom('branch', 'branch_name', 'division') || prev.branch,
sub_branch: valueFrom('sub_branch', 'subBranch', 'sub_branch_name') || prev.sub_branch,
department: primaryContact?.department || valueFrom('department') || prev.department,
sub_department: valueFrom('sub_department', 'subDepartment', 'sub_department_name') || prev.sub_department,
designation: primaryContact?.designation || valueFrom('designation') || prev.designation,
template_values: Array.from(selectedTemplateFields).reduce<Record<string, string>>((values, field) => {
  const value = valueFrom(field)
  if (value) values[field] = value
  return values
}, { ...prev.template_values }),
}))
} catch {
toastInfo("Could not load that customer's details — fill the fields in manually")
} finally {
setCustomerLoading(false)
setLetterContentVersion((version) => version + 1)
}
}

useEffect(() => {
try {
localStorage.setItem(STORAGE_KEY_LETTERS, JSON.stringify(generatedLetters))
} catch {}
}, [generatedLetters])

useEffect(() => {
try {
localStorage.setItem(STORAGE_KEY_TRASHED_LETTERS, JSON.stringify(trashedLetters))
} catch {}
}, [trashedLetters])

// Letter details live in this browser, but the server decides whether a saved letter
// (numeric id) is active, in the Recycle Bin, or gone — it may have been restored or
// permanently deleted from the global Recycle Bin page.
useEffect(() => {
Promise.all([api.get('/letters/letters'), api.get('/letters/letters/trash')]).then(([activeResponse, trashResponse]) => {
  const serverLetters = new Map((activeResponse.data as any[]).map((letter) => [String(letter.id), letter]))
  const activeIds = new Set(serverLetters.keys())
  const trashedAt = new Map((trashResponse.data as any[]).map((letter) => [String(letter.id), letter.deleted_at as string | null]))
  const isLocalOnly = (id: string) => !/^\d+$/.test(id)
  const all = [...generatedLetters, ...trashedLetters.map(({ deleted_at: _deletedAt, server_deleted: _serverDeleted, ...letter }) => letter)]
  const seen = new Set<string>()
  const nextActive: GeneratedLetter[] = []
  const nextTrashed: TrashedLetter[] = []
  all.forEach((letter) => {
    if (seen.has(letter.id)) return
    seen.add(letter.id)
    const localTrash = trashedLetters.find((l) => l.id === letter.id)
    if (isLocalOnly(letter.id)) {
      if (localTrash) nextTrashed.push(localTrash)
      else nextActive.push(letter)
    } else if (activeIds.has(letter.id) && localTrash && !localTrash.server_deleted) {
      api.delete(`/letters/letters/${letter.id}`).catch(() => {})
      nextTrashed.push({ ...localTrash, server_deleted: true })
    } else if (activeIds.has(letter.id)) {
      nextActive.push({ ...letter, status: serverLetters.get(letter.id)?.status || letter.status })
    } else if (trashedAt.has(letter.id)) {
      nextTrashed.push({ ...letter, deleted_at: trashedAt.get(letter.id) || localTrash?.deleted_at || new Date().toISOString(), server_deleted: true })
    }  })
  // Add server-issued letters that were created outside this browser session.
  serverLetters.forEach((serverLetter, id) => {
    if (seen.has(id) || !serverLetter.letter_template_id) return
    nextActive.push({
      id,
      template_id: String(serverLetter.letter_template_id),
      customer_id: serverLetter.linked_source === 'customer' ? serverLetter.linked_record_id : undefined,
      ref_number: serverLetter.letter_no || `LTR-${id}`,
      description: serverLetter.title || '', letter_subject: serverLetter.subject || '', letter_body: serverLetter.body || '',
      recipient_name: serverLetter.recipient_name || '', recipient_email: serverLetter.recipient_email || '',
      recipient_company: serverLetter.linked_record_label || '', recipient_address: serverLetter.recipient_address || '',
      issue_date: serverLetter.issue_date || '', valid_until: '', status: serverLetter.status || 'Draft',
    })
  })
  setGeneratedLetters(nextActive)
  setTrashedLetters(nextTrashed)
}).catch(() => {})
// Reconcile once with the stored letters on load.
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [])

// Filters
const [templateSearch, setTemplateSearch] = useState('')
const [templateCategoryFilter, setTemplateCategoryFilter] = useState<string>('All')
// Set by the KPI cards: 'active' narrows the list to active templates.
const [templateStatFilter, setTemplateStatFilter] = useState<'all' | 'active' | 'categories'>('all')
const templateListRef = useRef<HTMLDivElement>(null)
const templateCategorySelectRef = useRef<HTMLSelectElement>(null)
const [trashSearch, setTrashSearch] = useState('')
const [trashCategoryFilter, setTrashCategoryFilter] = useState<string>('All')

// Modals
const [templateModalOpen, setTemplateModalOpen] = useState(false)
const [editingTemplate, setEditingTemplate] = useState<LetterTemplateItem | null>(null)
const [previewTemplate, setPreviewTemplate] = useState<{
title: string
subtitle: string
content: string
subject?: string
date?: string
refNo?: string
recipientName?: string
recipientLine?: string
signatureOption?: SignatureOption
signatoryOption?: SignatoryOption
// What was previewed, so Print / PDF exports exactly this (e.g. an unsaved letter draft).
source: { template: LetterTemplateItem, letter?: GeneratedLetter }
} | null>(null)

// Company header (logo + address), sourced from Settings — same as the Quotation letter pad
const [company, setCompany] = useState<Record<string, string>>({})
const [primaryAddress, setPrimaryAddress] = useState<Record<string, string> | null>(null)

useEffect(() => {
api.get('/settings/settings').then((r) => {
const raw = r.data
const flat: Record<string, string> = {}
if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
for (const [k, v] of Object.entries(raw)) {
flat[k] = typeof (v as any)?.value === 'string' ? (v as any).value : String(v ?? '')
}
}
setCompany(flat)
}).catch(() => {})

api.get('/settings/company-addresses').then((r) => {
  const addresses: any[] = r.data?.addresses ?? []
  const primary = addresses.find((a: any) => a.is_primary) ?? addresses[0] ?? null
  if (primary) setPrimaryAddress(primary)
}).catch(() => {})

}, [])

const companyAddressLine = primaryAddress
? [primaryAddress.street_address, primaryAddress.area_locality, primaryAddress.city_district,
primaryAddress.state, primaryAddress.pincode, primaryAddress.country].filter(Boolean).join(', ')
: [company.street_address, company.address, company.city_district, company.state, company.pincode]
.filter(Boolean).join(', ')

// ── Form State for Template ─────────────────────────────────────────────────
const [templateForm, setTemplateForm] = useState<{
name: string
category: string
folder: string
description: string
subject: string
template_body: string
variables: string
is_default: boolean
status: 'active' | 'inactive' | 'draft'
}>({
name: '',
category: 'Quotation',
folder: '',
description: '',
subject: '',
template_body: '',
variables: 'recipient_name, customer_name, project_name, ref_no, signatory_name, company_name',
is_default: false,
status: 'draft',
})
const [newVariableName, setNewVariableName] = useState('')
const [mergeFieldSearch, setMergeFieldSearch] = useState('')
const [mergeFieldType, setMergeFieldType] = useState<'all' | 'text' | 'date' | 'amount'>('all')
const templateBodyRef = useRef<HTMLDivElement>(null)
const editorHistoryRef = useRef<string[]>([])
const editorFutureRef = useRef<string[]>([])
const [tableBuilderOpen, setTableBuilderOpen] = useState(false)
const [tableColumns, setTableColumns] = useState<string[]>(['S.No', 'Item Description', 'Qty', 'Unit Price', 'GST %', 'GST Value', 'Net Price', 'Total Price'])

// Keep the content-editable area uncontrolled while a user is typing. Rendering
// `template_body` back into it on every input resets the browser caret to the
// beginning, causing each subsequent character to be inserted in reverse order.
useEffect(() => {
const node = templateBodyRef.current
if (templateModalOpen && node) node.innerHTML = templateForm.template_body
}, [templateModalOpen, editingTemplate?.id])

// ── Refresh Handler ─────────────────────────────────────────────────────────
const toTemplateItem = (item: any): LetterTemplateItem => ({
...item,
id: String(item.id),
variables: Array.isArray(item.variables) ? item.variables : [],
category: item.category || 'General',
subject: item.subject || '',
})

const toTrashItem = (item: any): TrashedItem => ({
...item,
id: String(item.id),
original_id: String(item.original_id ?? item.id),
deleted_at: item.deleted_at || '',
data: toTemplateItem(item.data),
})

const loadTemplates = async (includeTrash = isTemplateAdmin) => {
const requests: [Promise<any>, Promise<any>?] = [api.get('/letters/templates')]
if (includeTrash) requests.push(api.get('/letters/templates/trash'))
const [templatesResponse, trashResponse] = await Promise.all(requests)
setTemplates((templatesResponse.data || []).map(toTemplateItem))
if (trashResponse) setTrashItems((trashResponse.data || []).map(toTrashItem))
}

useEffect(() => {
loadTemplates().catch((err: any) => {
toastError(err?.response?.data?.detail || 'Unable to load letter templates')
})
}, [isTemplateAdmin])

const handleRefresh = async () => {
setRefreshing(true)
try {
await loadTemplates()
} catch (err: any) {
toastError(err?.response?.data?.detail || 'Unable to refresh letter templates')
} finally {
setRefreshing(false)
}
}

// ── Filtered Datasets ───────────────────────────────────────────────────────
const templateCategories = useMemo(() => {
const cats = Array.from(new Set(templates.map((t) => t.category).filter(Boolean)))
return ['All', ...cats]
}, [templates])

const filteredTemplates = useMemo(() => {
return templates.filter((t) => {
const matchesSearch =
!templateSearch.trim() ||
t.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
t.subject.toLowerCase().includes(templateSearch.toLowerCase()) ||
t.category.toLowerCase().includes(templateSearch.toLowerCase())

  const matchesCategory =
    templateCategoryFilter === 'All' || t.category === templateCategoryFilter

  const matchesStat = templateStatFilter !== 'active' || t.is_active

  return matchesSearch && matchesCategory && matchesStat
})

}, [templates, templateSearch, templateCategoryFilter, templateStatFilter])

const templatesByCategory = useMemo(() => {
const groups = new Map<string, LetterTemplateItem[]>()
filteredTemplates.forEach((t) => {
const key = t.category || 'Uncategorized'
if (!groups.has(key)) groups.set(key, [])
groups.get(key)!.push(t)
})
return Array.from(groups.entries())
}, [filteredTemplates])

const recycleBinRows = useMemo<RecycleBinRow[]>(() => [
...trashedLetters.map((letter) => ({
  key: `letter-${letter.id}`,
  kind: 'letter' as const,
  title: letter.ref_number,
  subtitle: [letter.recipient_name, letter.recipient_company].filter(Boolean).join(' · '),
  category: 'Letter',
  deleted_at: letter.deleted_at,
  onRestore: () => handleRestoreLetter(letter),
  onDelete: () => handlePermanentDeleteLetter(letter),
})),
...trashItems.map((item) => ({
  key: `template-${item.id}`,
  kind: 'template' as const,
  title: item.title,
  subtitle: item.subtitle,
  category: item.category || 'Template',
  deleted_at: item.deleted_at,
  onRestore: () => handleRestoreItem(item),
  onDelete: () => handlePermanentDeleteItem(item),
})),
].sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || '')),
// Handlers are recreated each render; the rows only need to change with the data.
// eslint-disable-next-line react-hooks/exhaustive-deps
[trashedLetters, trashItems])

const filteredTrash = useMemo(() => {
return recycleBinRows.filter((item) => {
const matchesSearch =
!trashSearch.trim() ||
item.title.toLowerCase().includes(trashSearch.toLowerCase()) ||
item.subtitle.toLowerCase().includes(trashSearch.toLowerCase())

  const matchesCat =
    trashCategoryFilter === 'All' || item.category === trashCategoryFilter

  return matchesSearch && matchesCat
})

}, [recycleBinRows, trashSearch, trashCategoryFilter])

// ── Template Actions ────────────────────────────────────────────────────────
const openCreateTemplateModal = () => {
setEditingTemplate(null)
setTemplateForm({
name: '',
category: 'Quotation',
folder: '',
description: '',
subject: '',
template_body: '',
variables: 'recipient_name, customer_name, project_name, ref_no, signatory_name, company_name',
is_default: false,
status: 'draft',
})
setTemplateModalOpen(true)
}

const openEditTemplateModal = (template: LetterTemplateItem) => {
setEditingTemplate(template)
setTemplateForm({
name: template.name,
category: template.category,
folder: template.folder || '',
description: template.description || '',
subject: template.subject,
template_body: template.template_body,
variables: template.variables.join(', '),
is_default: template.is_default,
status: template.is_active ? 'active' : 'draft',
})
setTemplateModalOpen(true)
}

const handleSaveTemplate = async () => {
const tBad = tv.validateAll(templateForm as unknown as Record<string, Val>, templateSpecs(), templateExtra())
if (Object.keys(tBad).length) { focusFirst(TEMPLATE_ORDER, tBad, (id) => document.getElementById(`tp-${id}`)); return }

const variableList = templateForm.variables
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean)

const payload = {
  name: templateForm.name.trim(), category: templateForm.category.trim(), folder: templateForm.folder.trim(), description: templateForm.description.trim(), subject: templateForm.subject,
  template_body: templateForm.template_body.trim() || templateForm.description.trim(), variables: variableList, is_default: templateForm.is_default,
  is_active: templateForm.status === 'active',
}
try {
  if (editingTemplate) {
    const { data } = await api.put(`/letters/templates/${editingTemplate.id}`, payload)
    const saved = toTemplateItem(data)
    setTemplates((prev) => prev.map((t) => t.id === saved.id ? saved : t))
    toastSuccess('Template updated successfully')
  } else {
    const { data } = await api.post('/letters/templates', payload)
    const saved = toTemplateItem(data)
    setTemplates((prev) => [saved, ...prev])
    toastSuccess(`Template "${saved.name}" created as Draft — activate it to start generating letters`)
  }
  setTemplateModalOpen(false)
} catch (err: any) {
  const fieldErrs = mapApiErrors(err)
  const known = Object.fromEntries(Object.entries(fieldErrs).filter(([k]) => TEMPLATE_ORDER.includes(k)))
  if (Object.keys(known).length) { tv.setErrors((prev) => ({ ...prev, ...known })); focusFirst(TEMPLATE_ORDER, known, (id) => document.getElementById(`tp-${id}`)); return }
  const detail = err?.response?.data?.detail
  toastError(typeof detail === 'string' ? detail : 'Unable to save template')
}
return

if (editingTemplate) {
  setTemplates((prev) =>
    prev.map((t) =>
      t.id === editingTemplate.id
        ? {
            ...t,
            name: templateForm.name,
            category: templateForm.category,
            subject: templateForm.subject,
            template_body: templateForm.template_body,
            variables: variableList,
            version: t.version + 1,
            is_default: templateForm.is_default,
            updated_at: new Date().toISOString().split('T')[0],
          }
        : t
    )
  )
  toastSuccess('Template updated successfully')
} else {
  const newTemplate: LetterTemplateItem = {
    id: `tmpl-${Date.now()}`,
    name: templateForm.name,
    category: templateForm.category,
    subject: templateForm.subject,
    template_body: templateForm.template_body,
    variables: variableList,
    version: 1,
    is_default: templateForm.is_default,
    is_active: false,
    created_at: new Date().toISOString().split('T')[0],
    updated_at: new Date().toISOString().split('T')[0],
  }
  setTemplates((prev) => [newTemplate, ...prev])
  toastSuccess(`Template "${newTemplate.name}" created as Draft — activate it to start generating letters`)
}
setTemplateModalOpen(false)

}

const handleDuplicateTemplate = async (tpl: LetterTemplateItem) => {
try {
const { data } = await api.post(`/letters/templates/${tpl.id}/duplicate`)
setTemplates((prev) => [toTemplateItem(data), ...prev])
toastSuccess(`Duplicated template "${tpl.name}"`)
} catch (err: any) {
toastError(err?.response?.data?.detail || 'Unable to duplicate template')
}
return
const duplicated: LetterTemplateItem = {
...tpl,
id: `tmpl-${Date.now()}`,
name: `${tpl.name} (Copy)`,
version: 1,
is_default: false,
created_at: new Date().toISOString().split('T')[0],
updated_at: new Date().toISOString().split('T')[0],
}
setTemplates((prev) => [duplicated, ...prev])
toastSuccess(`Duplicated template "${tpl.name}"`)
}

const handleTrashTemplate = async (template: LetterTemplateItem) => {
try {
await api.delete(`/letters/templates/${template.id}`)
setTemplates((prev) => prev.filter((t) => t.id !== template.id))
await loadTemplates(true)
toastInfo(`Moved template "${template.name}" to the Recycle Bin`)
} catch (err: any) {
toastError(err?.response?.data?.detail || 'Unable to move template to the Recycle Bin')
}
return
setTemplates((prev) => prev.filter((t) => t.id !== template.id))
const trashEntry: TrashedItem = {
id: `trash-${Date.now()}`,
original_id: template.id,
title: template.name,
subtitle: `v${template.version}.0 · Subject: ${template.subject || 'N/A'}`,
category: template.category,
deleted_at: new Date().toISOString().split('T')[0],
data: template,
}
setTrashItems((prev) => [trashEntry, ...prev])
toastInfo(`Moved template "${template.name}" to Trash`)
}

// ── Trash Actions ───────────────────────────────────────────────────────────
const handleRestoreItem = async (item: TrashedItem) => {
try {
const { data } = await api.post(`/letters/templates/${item.original_id}/restore`)
setTrashItems((prev) => prev.filter((t) => t.original_id !== item.original_id))
setTemplates((prev) => [toTemplateItem(data), ...prev])
toastSuccess(`Restored template "${item.title}"`)
} catch (err: any) {
toastError(err?.response?.data?.detail || 'Unable to restore template')
}
return
setTrashItems((prev) => prev.filter((t) => t.id !== item.id))
setTemplates((prev) => [item.data, ...prev])
toastSuccess(`Restored template "${item.title}"`)
}

const handlePermanentDeleteItem = async (item: TrashedItem) => {
try {
await api.delete(`/letters/templates/${item.original_id}/permanent`)
setTrashItems((prev) => prev.filter((t) => t.original_id !== item.original_id))
toastInfo(`Permanently deleted "${item.title}"`)
} catch (err: any) {
toastError(err?.response?.data?.detail || 'Unable to permanently delete template')
}
return
setTrashItems((prev) => prev.filter((t) => t.id !== item.id))
toastInfo(`Permanently deleted "${item.title}"`)
}

// ── Preview Handlers ────────────────────────────────────────────────────────
// Fills a template's {{placeholders}} with representative sample data — shared
// by the on-screen preview modal and the downloadable PDF so both render the
// same content.
const resolveTemplateSample = (template: LetterTemplateItem, letter?: GeneratedLetter) => {
const replacements: [RegExp, string][] = [
[/{{recipient_name}}/g, letter?.recipient_name || 'Johnathan Doe'],
[/{{candidate_name}}/g, letter?.recipient_name || 'Johnathan Doe'],
[/{{recipient_email}}/g, letter?.recipient_email || 'johnathan.doe@acmeinfra.com'],
[/{{candidate_email}}/g, letter?.recipient_email || 'johnathan.doe@acmeinfra.com'],
[/{{recipient_company}}/g, letter?.recipient_company || 'Acme Infrastructure Ltd'],
[/{{candidate_company}}/g, letter?.recipient_company || 'Acme Infrastructure Ltd'],
[/{{recipient_address}}/g, letter?.recipient_address || 'Connaught Place, New Delhi'],
[/{{candidate_address}}/g, letter?.recipient_address || 'Connaught Place, New Delhi'],
[/{{customer_name}}/g, letter?.recipient_company || 'Acme Infrastructure Ltd'],
[/{{project_name}}/g, 'Smart Transit SCADA System'],
[/{{ref_no}}/g, letter?.ref_number || 'REF-2026-9041'],
[/{{reference_number}}/g, letter?.ref_number || 'REF-2026-9041'],
[/{{tender_name}}/g, 'Central Metro Telemetry Tender'],
[/{{tender_no}}/g, 'TDR-DEL-2026-08'],
[/{{representative_name}}/g, 'Vikram Malhotra'],
[/{{representative_designation}}/g, 'General Manager - Bids'],
[/{{valid_until_date}}/g, letter?.valid_until ? formatDisplayDate(letter.valid_until) : '31-Dec-2026'],
[/{{valid_until}}/g, letter?.valid_until ? formatDisplayDate(letter.valid_until) : '31-Dec-2026'],
[/{{issue_date}}/g, letter?.issue_date ? formatDisplayDate(letter.issue_date) : new Date().toLocaleDateString('en-GB')],
[/{{company_address}}/g, companyAddressLine || 'Company address'],
[/{{region}}/g, letter?.region || 'India'],
[/{{status}}/g, letter?.status || 'Draft'],
[/{{letter_language}}/g, letter?.language || 'English'],
[/{{branch}}/g, letter?.branch || 'Head Office'],
[/{{sub_branch}}/g, letter?.sub_branch || 'Main Branch'],
[/{{department}}/g, letter?.department || 'Commercial'],
[/{{sub_department}}/g, letter?.sub_department || 'Sales'],
[/{{designation}}/g, letter?.designation || 'Manager'],
[/{{delivery_days}}/g, '45'],
[/{{signatory_name}}/g, 'Rajesh Varma, Authorized Director'],
[/{{company_name}}/g, company.company_name || 'Azcentrix Technologies Pvt Ltd'],
[/{{company_address}}/g, companyAddressLine || 'Company address'],
[/{{company_phone}}/g, company.phone || '+91 00000 00000'],
[/{{company_email}}/g, company.mail || company.from_email || 'info@company.com'],
[/{{customer_to_name}}/g, letter?.recipient_name || 'Johnathan Doe'],
[/{{customer_address}}/g, letter?.recipient_address || 'Connaught Place, New Delhi'],
[/{{quotation_number}}/g, letter?.ref_number || 'Q-2026-0001'],
[/{{revision_label}}/g, 'Q1'],
[/{{quotation_date}}/g, letter?.issue_date ? formatDisplayDate(letter.issue_date) : new Date().toLocaleDateString('en-GB')],
[/{{greeting_text}}/g, 'Dear Sir/Madam,'],
[/{{subtotal}}/g, '22,033.90'],
[/{{gst_amount}}/g, '3,966.10'],
[/{{total_amount}}/g, '26,000.00'],
[/{{terms_conditions}}/g, 'Payment Terms: 100% Advanced'],
[/{{notes}}/g, ''],
[/{{opening_message}}/g, 'We are pleased to submit our commercial proposal for your consideration.'],
[/{{item_serial_no}}/g, '1'],
[/{{item_description}}/g, 'Multifunction Printer'],
[/{{item_quantity}}/g, '1.00'],
[/{{item_unit_price}}/g, '22,033.90'],
[/{{item_gst_percent}}/g, '18%'],
[/{{item_gst_value}}/g, '3,966.10'],
[/{{item_net_price}}/g, '22,033.90'],
[/{{item_total_price}}/g, '26,000.00'],
[/{{payment_terms}}/g, '100% Advanced'],
[/{{delivery_address_contact_numbers}}/g, 'Required along with the purchase order for delivery'],
[/{{delivery}}/g, '2–4 weeks from the date of receiving the purchase order'],
[/{{order_payment}}/g, 'Order and payment to be placed with the company'],
[/{{delivery_follow_up}}/g, 'Please contact the salesperson below for delivery follow-up'],
[/{{salesperson_name}}/g, 'Salesperson Name'],
[/{{phone_number}}/g, '+91 00000 00000'],
[/{{email}}/g, 'sales@company.com'],
[/{{signatory_designation}}/g, 'Area Sales Manager'],
[/{{signatory_phone}}/g, '+91 00000 00000'],
[/{{signatory_email}}/g, 'sales@company.com'],
]
// A letter keeps its own edited copy of the body/subject (tables etc.); prefer it over the template.
let content = letter?.letter_body || template.template_body
let subject = letter?.letter_subject || template.subject
for (const [field, value] of Object.entries(letter?.template_values || {})) {
const pattern = new RegExp(`\\{\\{\\s*${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'gi')
content = content.replace(pattern, value)
subject = subject.replace(pattern, value)
}
for (const [pattern, value] of replacements) {
content = content.replace(pattern, value)
subject = subject.replace(pattern, value)
}
return { content, subject }
}

// Sales user shown in the sign-off, as on the Quotation letter pad: the letter's own
// signatory_* values when filled in, otherwise the logged-in user.
const letterSigner = (letter?: Pick<GeneratedLetter, 'template_values'>) => {
  const values = letter?.template_values || {}
  const phone = values.signatory_phone || currentUser?.phone || ''
  const email = values.signatory_email || currentUser?.email || ''
  const phoneLabel = phone && !phone.startsWith('+') ? `+91 ${phone}` : phone
  return {
    name: values.signatory_name || currentUser?.full_name || '',
    designation: values.signatory_designation || currentUser?.designation || '',
    contact: [phoneLabel, email].filter(Boolean).join(' / '),
  }
}

const openTemplatePreview = (template: LetterTemplateItem, letter?: GeneratedLetter) => {
const { content, subject } = resolveTemplateSample(template, letter)
setPreviewTemplate({
title: template.name,
subtitle: letter
? `Ref ${letter.ref_number} · ${letter.recipient_name}${letter.recipient_company ? ` · ${letter.recipient_company}` : ''}`
: `Category: ${template.category} · Template Preview with Sample Data`,
content,
subject,
date: letter ? formatDisplayDate(letter.issue_date) : new Date().toLocaleDateString('en-GB'),
refNo: letter?.ref_number || 'SAMPLE-REF-2026',
recipientName: letter?.recipient_name,
recipientLine: letter ? (letter.recipient_address || letter.recipient_company) : undefined,
signatureOption: normalizeSignatureOption(letter?.signature_option),
signatoryOption: letter?.signatory_option || 'authorized',
source: { template, letter },
})
}

const pdfNodeText = (node: Element) => {
  const copy = node.cloneNode(true) as Element
  copy.querySelectorAll('br').forEach((child) => child.replaceWith('\n'))
  copy.querySelectorAll('p, div, li, tr').forEach((child) => child.append(document.createTextNode('\n')))
  return (copy.textContent || '').replace(/\n{3,}/g, '\n\n').trim()
}

type PdfTableCell = { content: string, colSpan: number, rowSpan: number }
type PdfBodySegment = { kind: 'text', text: string } | { kind: 'table', head: PdfTableCell[][], body: PdfTableCell[][] }

// Splits the letter body into text runs and tables, in reading order, so tables
// can be drawn as real tables instead of being flattened into text.
const pdfBodySegments = (content: string): PdfBodySegment[] => {
  const body = new DOMParser().parseFromString(previewHtml(content), 'text/html').body
  const tables = Array.from(body.querySelectorAll('table')).filter((table) => !table.parentElement?.closest('table'))
  const parsed = tables.map((table) => {
    const head: PdfTableCell[][] = []
    const rows: PdfTableCell[][] = []
    Array.from(table.rows).forEach((row) => {
      const cells = Array.from(row.cells).map((cell) => ({ content: pdfNodeText(cell), colSpan: cell.colSpan || 1, rowSpan: cell.rowSpan || 1 }))
      const isHeader = row.parentElement?.tagName === 'THEAD' || Array.from(row.cells).every((cell) => cell.tagName === 'TH')
      // Header rows only count while they lead the table; a later all-<th> row stays in the body.
      if (isHeader && rows.length === 0) head.push(cells)
      else rows.push(cells)
    })
    return { head, body: rows }
  })
  tables.forEach((table, index) => table.replaceWith(document.createTextNode(`\n\u0000${index}\u0000\n`)))
  const segments: PdfBodySegment[] = []
  pdfNodeText(body).split(/\u0000(\d+)\u0000/).forEach((part, index) => {
    if (index % 2 === 1) segments.push({ kind: 'table', ...parsed[Number(part)] })
    else if (part.trim()) segments.push({ kind: 'text', text: part.trim() })
  })
  return segments
}

const loadPdfLogo = async (path?: string) => {
  if (!path) return null
  try {
    // A stalled image request must not block the whole PDF, so give up after 8s.
    const response = await fetch(buildApiAssetUrl(path), { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    const blob = await response.blob()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
    const dimensions = await new Promise<{ width: number, height: number }>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
      image.onerror = reject
      image.src = dataUrl
    })
    return { dataUrl, ...dimensions }
  } catch { return null }
}

// Renders the same letter-pad information as the preview modal into a PDF.
const buildLetterPdf = async (template: LetterTemplateItem, letter?: GeneratedLetter, signOverride?: { signature?: SignatureOption, signatory?: SignatoryOption }) => {
const { content, subject } = resolveTemplateSample(template, letter)
const refNo = letter?.ref_number || 'SAMPLE-REF-2026'
const dateLabel = letter ? formatDisplayDate(letter.issue_date) : new Date().toLocaleDateString('en-GB')
const recipientName = letter?.recipient_name || 'Johnathan Doe'
const recipientLine = letter ? (letter.recipient_address || letter.recipient_company) : 'Acme Infrastructure Ltd, Connaught Place, New Delhi'
const doc = new jsPDF({ unit: 'pt', format: 'a4' })
const marginX = 48
const rightEdge = 547
const headerTop = 40
let y = headerTop

// Header: logo (or company name) on the left, address block top-aligned on the right.
const logo = await loadPdfLogo(company.theme_logo)
let logoBottom = headerTop
if (logo) {
  // Match the preview class: h-14 (56 CSS px) and max-w-[160px] => 42pt x 120pt.
  const scale = Math.min(120 / logo.width, 42 / logo.height)
  try {
    doc.addImage(logo.dataUrl, marginX, headerTop, logo.width * scale, logo.height * scale)
    logoBottom = headerTop + logo.height * scale
  } catch { /* use the company-name fallback below */ }
}
if (logoBottom === headerTop) {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(17, 24, 39)
  doc.text(company.company_name || 'Company Name', marginX, headerTop + 14)
  logoBottom = headerTop + 18
}
const headerWidth = (rightEdge - marginX) * 0.45
let headerY = headerTop + 7
doc.setFontSize(8)
if (companyAddressLine) {
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(51, 65, 85)
  const addressLines = doc.splitTextToSize(companyAddressLine, headerWidth)
  doc.text(addressLines, rightEdge, headerY, { align: 'right', lineHeightFactor: 1.5 })
  headerY += addressLines.length * 12
}
doc.setFont('helvetica', 'normal')
doc.setTextColor(100, 116, 139)
for (const line of [company.phone ? `Ph: ${company.phone}` : '', company.mail || company.from_email ? `Email: ${company.mail || company.from_email}` : ''].filter(Boolean)) {
  doc.text(line, rightEdge, headerY, { align: 'right' })
  headerY += 12
}
y = Math.max(logoBottom, headerY - 8) + 12

doc.setDrawColor(30, 41, 59)
doc.setLineWidth(1)
doc.line(marginX, y, rightEdge, y)
y += 22

// Title centred, Date / Ref on the right of the same row — as in the preview.
doc.setFont('helvetica', 'bold')
doc.setFontSize(11)
doc.setTextColor(15, 23, 42)
const titleWidth = doc.getTextWidth(template.name)
doc.text(template.name, (marginX + rightEdge) / 2, y, { align: 'center' })
doc.setLineWidth(0.6)
doc.line((marginX + rightEdge - titleWidth) / 2, y + 2, (marginX + rightEdge + titleWidth) / 2, y + 2)
doc.setFontSize(9)
doc.setTextColor(51, 65, 85)
doc.text(`Date: ${dateLabel}`, rightEdge, y, { align: 'right' })
doc.text(`Ref: ${refNo}`, rightEdge, y + 14, { align: 'right' })
doc.setFont('helvetica', 'normal')
y += 36

doc.setFontSize(10)
doc.setTextColor(30, 41, 59)
doc.text('To,', marginX, y)
y += 14
doc.text(recipientName || '', marginX, y)
y += 14
const recipientLines = doc.splitTextToSize(recipientLine || '', rightEdge - marginX)
doc.text(recipientLines, marginX, y)
y += recipientLines.length * 14 + 12

if (subject) {
  doc.setFont('helvetica', 'bold')
  const subjectLines = doc.splitTextToSize(`Subject: ${subject}`, rightEdge - marginX)
  doc.text(subjectLines, marginX, y)
  y += subjectLines.length * 14 + 14
  doc.setFont('helvetica', 'normal')
}

doc.setTextColor(30, 41, 59)
for (const segment of pdfBodySegments(content)) {
  if (segment.kind === 'text') {
    doc.setFontSize(10)
    for (const line of doc.splitTextToSize(segment.text, rightEdge - marginX)) {
      if (y > 780) { doc.addPage(); y = 56 }
      doc.text(line, marginX, y)
      y += 14
    }
    y += 4
    continue
  }
  autoTable(doc, {
    head: segment.head,
    body: segment.body,
    startY: y - 6,
    margin: { left: marginX, right: doc.internal.pageSize.getWidth() - rightEdge, top: 56 },
    theme: 'grid',
    styles: { fontSize: 9, textColor: [30, 41, 59], lineColor: [203, 213, 225], lineWidth: 0.5, cellPadding: 5 },
    headStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold' },
  })
  y = ((doc as any).lastAutoTable?.finalY ?? y) + 20
}

if (letter?.table_columns?.length) {
  const columns = letter.table_columns
  const rowHeight = 20
  const columnWidth = (rightEdge - marginX) / columns.length
  if (y > 780 - rowHeight * 3) { doc.addPage(); y = 56 }
  y += 12
  doc.setFontSize(9)
  columns.forEach((column, index) => {
    const x = marginX + index * columnWidth
    doc.setFillColor(241, 245, 249); doc.rect(x, y, columnWidth, rowHeight, 'F')
    doc.setDrawColor(203, 213, 225); doc.rect(x, y, columnWidth, rowHeight)
    doc.setTextColor(51, 65, 85); doc.text(doc.splitTextToSize(column, columnWidth - 8)[0], x + 4, y + 13)
  })
  y += rowHeight
  columns.forEach((_, index) => { const x = marginX + index * columnWidth; doc.setDrawColor(203, 213, 225); doc.rect(x, y, columnWidth, rowHeight) })
  y += rowHeight
}

// Sign-off, as on the Quotation letter pad: the letter pad seal (Settings) on the left
// and the sales user's name / designation / contact on the right. Anchored to the
// bottom margin of the last page rather than straight after the body; if the
// content already reaches that area, it moves to the bottom of a fresh page.
const signoffBase = doc.internal.pageSize.getHeight() - 56
const sealMaxWidth = 120
const sealMaxHeight = 72
if (y > signoffBase - sealMaxHeight - 12) { doc.addPage() }
const signatoryOption = signOverride?.signatory || letter?.signatory_option || 'authorized'
const signatureOption = signOverride?.signature || normalizeSignatureOption(letter?.signature_option)
if (signatureOption === 'signature') {
  const seal = await loadPdfLogo(company.letter_pad_seal)
  if (seal) {
    const scale = Math.min(sealMaxWidth / seal.width, sealMaxHeight / seal.height)
    try {
      doc.addImage(seal.dataUrl, marginX, signoffBase - seal.height * scale, seal.width * scale, seal.height * scale)
    } catch { /* skip an unreadable seal image */ }
  }
}
if (signatoryOption === 'authorized') {
  const signer = letterSigner(letter)
  doc.setTextColor(17, 24, 39)
  let signerY = signoffBase
  for (const [text, style, size] of ([
    [signer.contact, 'normal', 8.5],
    [signer.designation, 'normal', 8.5],
    [signer.name, 'bold', 10],
  ] as const).filter(([text]) => text)) {
    doc.setFont('helvetica', style); doc.setFontSize(size)
    doc.text(text, rightEdge, signerY, { align: 'right' })
    signerY -= 14
  }
  doc.setFont('helvetica', 'normal')
}

const fileLabel = letter ? `${template.name}-${letter.ref_number}` : template.name
return { blob: doc.output('blob'), fileName: `${safeFileName(fileLabel)}.pdf` }
}

const handleDownloadTemplate = async (template: LetterTemplateItem, letter?: GeneratedLetter, signOverride?: { signature?: SignatureOption, signatory?: SignatoryOption }) => {
try {
  const { blob, fileName } = await buildLetterPdf(template, letter, signOverride)
  downloadBlob(blob, fileName)
  toastSuccess(`Downloaded "${template.name}" as PDF`)
} catch (err) {
  console.error('Letter PDF download failed', err)
  toastError(`Could not create the PDF: ${err instanceof Error ? err.message : String(err)}`)
}
}
// Issuing a letter saves its PDF to Document Hub as a document linked to the letter.
const finalizeLetter = async (serverLetterId: string, template: LetterTemplateItem, letter: GeneratedLetter) => {
const { blob, fileName } = await buildLetterPdf(
  { ...template, subject: letter.letter_subject || template.subject, template_body: letter.letter_body || template.template_body },
  letter,
)
const formData = new FormData()
formData.append('file', new File([blob], fileName, { type: 'application/pdf' }))
try {
  const { data } = await api.post(`/letters/letters/${serverLetterId}/finalize`, formData, { headers: { 'Content-Type': 'multipart/form-data' } })
  if (data?.created) toastSuccess('Letter PDF saved to Document Hub')
} catch (err: any) {
  const detail = err?.response?.data?.detail
  toastError(typeof detail === 'string' ? detail : 'Letter saved, but its PDF could not be added to Document Hub')
}
}
const isFinalStatus = (status?: string) => status === 'Issued' || status === 'Sent'

// document.execCommand is deprecated and no longer applies formatting in current browsers,
// so editor commands below manipulate the Selection/Range and DOM directly instead.
const pushEditorHistory = () => {
const node = templateBodyRef.current
if (!node) return
editorHistoryRef.current.push(cleanLetterBodyHtml(node))
if (editorHistoryRef.current.length > 50) editorHistoryRef.current.shift()
editorFutureRef.current = []
}

const getSelectionRangeInEditor = (): Range | null => {
const node = templateBodyRef.current
if (!node) return null
const selection = window.getSelection()
if (!selection || selection.rangeCount === 0) return null
const range = selection.getRangeAt(0)
if (!node.contains(range.commonAncestorContainer)) return null
return range
}

const insertTextAtCursor = (text: string) => {
const node = templateBodyRef.current
const range = getSelectionRangeInEditor()
if (!node || !range) return false
pushEditorHistory()
range.deleteContents()
const textNode = document.createTextNode(text)
range.insertNode(textNode)
range.setStartAfter(textNode)
range.setEndAfter(textNode)
const selection = window.getSelection()
selection?.removeAllRanges()
selection?.addRange(range)
setTemplateForm((prev) => ({ ...prev, template_body: cleanLetterBodyHtml(node) }))
return true
}

const insertVariableIntoBody = (variableName: string) => {
const node = templateBodyRef.current
if (node && document.activeElement === node && insertTextAtCursor(`{{${variableName}}}`)) {
setTemplateForm((prev) => ({ ...prev, variables: prev.variables.split(',').map((value) => value.trim()).filter(Boolean).includes(variableName) ? prev.variables : `${prev.variables}${prev.variables ? ', ' : ''}${variableName}` }))
return
}
setTemplateForm((prev) => {
const existing = prev.variables.split(',').map((value) => value.trim()).filter(Boolean)
return {
...prev,
template_body: `${prev.template_body}${prev.template_body && !prev.template_body.endsWith('\n') ? '\n' : ''}{{${variableName}}}`,
variables: existing.includes(variableName) ? prev.variables : [...existing, variableName].join(', '),
}
})
}

const toggleInlineFormat = (tagName: 'b' | 'i' | 'u') => {
const node = templateBodyRef.current
const range = getSelectionRangeInEditor()
if (!node || !range || range.collapsed) return
pushEditorHistory()
const container = range.commonAncestorContainer
const el = container.nodeType === Node.ELEMENT_NODE ? (container as Element) : container.parentElement
const existing = el?.closest(tagName)
if (existing && node.contains(existing)) {
const parent = existing.parentNode
while (existing.firstChild) parent?.insertBefore(existing.firstChild, existing)
parent?.removeChild(existing)
} else {
const contents = range.extractContents()
const wrapper = document.createElement(tagName)
wrapper.appendChild(contents)
range.insertNode(wrapper)
const selection = window.getSelection()
const newRange = document.createRange()
newRange.selectNodeContents(wrapper)
selection?.removeAllRanges()
selection?.addRange(newRange)
}
node.focus()
setTemplateForm((prev) => ({ ...prev, template_body: cleanLetterBodyHtml(node) }))
}

const findBlockAncestor = (node: HTMLElement, container: Node) => {
let block = (container.nodeType === Node.ELEMENT_NODE ? container as HTMLElement : container.parentElement)
while (block && block !== node && block.parentElement !== node) block = block.parentElement
return block && block !== node ? block : null
}

const setBlockAlignment = (align: 'left' | 'center') => {
const node = templateBodyRef.current
const range = getSelectionRangeInEditor()
if (!node || !range) return
pushEditorHistory()
const block = findBlockAncestor(node, range.commonAncestorContainer)
;(block ?? node).style.textAlign = align
node.focus()
setTemplateForm((prev) => ({ ...prev, template_body: cleanLetterBodyHtml(node) }))
}

const setBlockTag = (tag: 'p' | 'h3') => {
const node = templateBodyRef.current
const range = getSelectionRangeInEditor()
if (!node || !range) return
pushEditorHistory()
const block = findBlockAncestor(node, range.commonAncestorContainer)
if (block) {
const replacement = document.createElement(tag)
replacement.innerHTML = block.innerHTML
block.replaceWith(replacement)
}
node.focus()
setTemplateForm((prev) => ({ ...prev, template_body: cleanLetterBodyHtml(node) }))
}

const insertLink = (url: string) => {
const node = templateBodyRef.current
const range = getSelectionRangeInEditor()
if (!node || !range || range.collapsed) return
pushEditorHistory()
const contents = range.extractContents()
const anchor = document.createElement('a')
anchor.href = url
anchor.target = '_blank'
anchor.rel = 'noopener noreferrer'
anchor.appendChild(contents)
range.insertNode(anchor)
node.focus()
setTemplateForm((prev) => ({ ...prev, template_body: cleanLetterBodyHtml(node) }))
}

const undoEditor = () => {
const node = templateBodyRef.current
if (!node || !editorHistoryRef.current.length) return
const previous = editorHistoryRef.current.pop() as string
editorFutureRef.current.push(cleanLetterBodyHtml(node))
node.innerHTML = previous
setTemplateForm((prev) => ({ ...prev, template_body: previous }))
}

const redoEditor = () => {
const node = templateBodyRef.current
if (!node || !editorFutureRef.current.length) return
const next = editorFutureRef.current.pop() as string
editorHistoryRef.current.push(cleanLetterBodyHtml(node))
node.innerHTML = next
setTemplateForm((prev) => ({ ...prev, template_body: next }))
}

const insertEditorHtml = (html: string) => {
const node = templateBodyRef.current
const range = getSelectionRangeInEditor()
if (!node || !range) return
pushEditorHistory()
range.deleteContents()
const fragment = range.createContextualFragment(html)
range.insertNode(fragment)
node.focus()
setTemplateForm((prev) => ({ ...prev, template_body: cleanLetterBodyHtml(node) }))
}

const addMergeField = (field: string) => {
setTemplateForm((prev) => {
const existing = prev.variables.split(',').map((value) => value.trim()).filter(Boolean)
if (existing.includes(field)) return prev
return { ...prev, variables: [...existing, field].join(', ') }
})
}

const addTemplateField = () => {
const field = newVariableName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^|_$/g, '')
if (!field) {
toastInfo('Enter a field name first, e.g. delivery_date')
return
}
addMergeField(field)
setNewVariableName('')
}

const addQuotationTable = () => {
if (!tableColumns.length) return
const fieldByColumn: Record<string, string> = { 'S.No': 'item_serial_no', 'Item Description': 'item_description', Qty: 'item_quantity', 'Unit Price': 'item_unit_price', 'GST %': 'item_gst_percent', 'GST Value': 'item_gst_value', 'Net Price': 'item_net_price', 'Total Price': 'item_total_price' }
const table = `<p><strong>Commercial Proposal</strong></p><table><thead><tr>${tableColumns.map((column) => `<th>${column}</th>`).join('')}</tr></thead><tbody><tr>${tableColumns.map((column) => `<td>{{${fieldByColumn[column]}}}</td>`).join('')}</tr></tbody></table>`
const node = templateBodyRef.current
setTemplateForm((prev) => ({
...prev,
template_body: `${prev.template_body}${prev.template_body.trim() ? '<br><br>' : ''}${table}`,
variables: Array.from(new Set([...prev.variables.split(',').map((value) => value.trim()).filter(Boolean), 'item_serial_no', 'item_description', 'item_quantity', 'item_unit_price', 'item_gst_percent', 'item_gst_value', 'item_net_price', 'item_total_price'])).join(', '),
}))
setTableBuilderOpen(false)
requestAnimationFrame(() => { if (node) { node.innerHTML = templateForm.template_body + (templateForm.template_body.trim() ? '<br><br>' : '') + table; node.focus() } })
}

const insertTemplateTable = () => {
const node = templateBodyRef.current
if (!node) return
pushEditorHistory()
node.focus()
const selection = window.getSelection()
const range = selection?.rangeCount && node.contains(selection.getRangeAt(0).commonAncestorContainer)
  ? selection.getRangeAt(0)
  : null
const table = document.createElement('table')
table.innerHTML = '<thead><tr><th>Item Description</th><th>Quantity</th><th>Amount</th></tr></thead><tbody><tr><td>Enter item</td><td>1</td><td>0.00</td></tr></tbody>'
if (range) {
  range.deleteContents()
  range.insertNode(table)
  const afterTable = document.createRange()
  afterTable.setStartAfter(table)
  afterTable.collapse(true)
  selection?.removeAllRanges()
  selection?.addRange(afterTable)
} else {
  node.appendChild(document.createElement('br'))
  node.appendChild(table)
}
setTemplateForm((prev) => ({ ...prev, template_body: cleanLetterBodyHtml(node) }))
}

const updateActiveTemplateTable = (action: 'row' | 'column') => {
const node = templateBodyRef.current
const selection = window.getSelection()
const anchor = selection?.anchorNode
const table = anchor
  ? (anchor.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor.parentElement)?.closest('table')
  : null
if (!node || !table || !node.contains(table)) {
  toastInfo('Place the cursor inside a table first.')
  return
}
if (action === 'row') {
  const columnCount = table.querySelector('tr')?.cells.length || 1
  const row = document.createElement('tr')
  for (let index = 0; index < columnCount; index += 1) {
    const cell = document.createElement('td')
    cell.textContent = 'Enter value'
    row.appendChild(cell)
  }
  const body = table.querySelector('tbody') || table.appendChild(document.createElement('tbody'))
  body.appendChild(row)
} else {
  table.querySelectorAll('tr').forEach((row, rowIndex) => {
    const cell = document.createElement(rowIndex === 0 ? 'th' : 'td')
    cell.textContent = rowIndex === 0 ? 'New Column' : 'Enter value'
    row.appendChild(cell)
  })
}
setTemplateForm((prev) => ({ ...prev, template_body: cleanLetterBodyHtml(node) }))
}

const dropVariableIntoContent = (event: React.DragEvent<HTMLDivElement>) => {
event.preventDefault()
const field = event.dataTransfer.getData('text/plain')
if (!field) return
const node = event.currentTarget
node.focus()
if (!insertTextAtCursor(`{{${field}}}`)) return
setTemplateForm((prev) => ({
...prev,
variables: prev.variables.split(',').map((value) => value.trim()).filter(Boolean).includes(field)
? prev.variables
: [...prev.variables.split(',').map((value) => value.trim()).filter(Boolean), field].join(', '),
}))
}

// ── Generated Letters (per-template log) ────────────────────────────────────
const openTemplateLetters = (template: LetterTemplateItem) => setOpenTemplateId(template.id)

const generateRefNumber = () => `QL${new Date().getFullYear()}${String(generatedLetters.length + 1).padStart(4, '0')}`

const openAddLetterModal = () => {
setEditingLetter(null)
setLetterForm({
customer_id: '', quotation_id: '', ref_number: generateRefNumber(), recipient_name: '', recipient_email: '',
description: openTemplate?.description || '',
letter_subject: '', letter_body: '',
recipient_company: '', recipient_address: '',
issue_date: new Date().toISOString().split('T')[0], valid_until: '', region: '', status: 'Draft', language: 'English',
branch: '', sub_branch: '', department: '', sub_department: '', designation: '', table_columns: [], template_values: {}, signature_option: 'signature', signatory_option: 'authorized',
})
setLetterTableColumns(['S.No', 'Item Description', 'Qty', 'Unit Price', 'GST %', 'GST Value', 'Net Price', 'Total Price'])
setLetterFormTab('customer')
setLetterTableBuilderOpen(false)
setLetterModalOpen(true)
}

const openEditLetterModal = (letter: GeneratedLetter) => {
const template = templates.find((item) => item.id === letter.template_id)
const savedOrTemplate = template ? resolveTemplateSample(template, letter) : { content: '', subject: '' }
setEditingLetter(letter)
setLetterForm({
customer_id: letter.customer_id ?? '', quotation_id: '' as number | '',
ref_number: letter.ref_number,
description: letter.description || '',
letter_subject: letter.letter_subject || savedOrTemplate.subject, letter_body: letter.letter_body || savedOrTemplate.content,
recipient_name: letter.recipient_name,
recipient_email: letter.recipient_email,
recipient_company: letter.recipient_company,
recipient_address: letter.recipient_address || '',
issue_date: letter.issue_date,
valid_until: letter.valid_until,
region: letter.region || '', status: letter.status || 'Draft', language: letter.language || 'English',
branch: letter.branch || '', sub_branch: letter.sub_branch || '', department: letter.department || '',
sub_department: letter.sub_department || '', designation: letter.designation || '', table_columns: letter.table_columns || [],
template_values: letter.template_values || {},
signature_option: normalizeSignatureOption(letter.signature_option),
signatory_option: letter.signatory_option || 'authorized',
})
setLetterTableColumns(letter.table_columns || [])
setLetterFormTab('customer')
setLetterTableBuilderOpen(false)
setLetterModalOpen(true)
}

const savingLetterRef = useRef(false)

// ── Field validation (letter + template forms) ─────────────────────────────
// Format errors show while typing, "required" once a field was left, everything on save; data is never touched.
const lv = useFieldErrors()
const tv = useFieldErrors()
const LETTER_ORDER = ['customer_id', 'description', 'ref_number', 'issue_date', 'region', 'letter_subject']
const TEMPLATE_ORDER = ['name', 'category', 'folder', 'description', 'subject', 'template_body']
const letterSpecs = (): SpecMap => ({
  customer_id: editingLetter ? undefined : { label: 'Customer', rule: 'select', required: true },
  description: { label: 'Letter description', rule: 'textarea', max: 300 },
  ref_number: { label: 'Reference number', rule: 'text', required: true, min: 3, max: 80 },
  issue_date: { label: 'Issue date', rule: 'date' },
  region: { label: 'Region', rule: 'text', max: 100 },
  letter_subject: { label: 'Subject', rule: 'text', max: 300 },
})
const letterExtra = (f = letterForm): Record<string, string> => {
  const ref = f.ref_number.trim()
  if (!ref) return {}
  if (!/^[A-Za-z0-9][A-Za-z0-9/._\- ]*$/.test(ref)) return { ref_number: 'Reference number can contain only letters, numbers, spaces and / . - _' }
  if (generatedLetters.some((l) => l.id !== editingLetter?.id && (l.ref_number || '').trim().toLowerCase() === ref.toLowerCase())) return { ref_number: `Reference number ${ref} is already used by another letter.` }
  return {}
}
const templateSpecs = (): SpecMap => ({
  name: { label: 'Template name', rule: 'text', required: true, min: 2, max: 200 },
  category: { label: 'Source module', rule: 'select', required: true },
  folder: { label: 'Template folder', rule: 'text', max: 200 },
  description: { label: 'Description', rule: 'textarea', max: 1000 },
  subject: { label: 'Subject', rule: 'text', required: true, max: 300 },
})
const templateExtra = (f = templateForm): Record<string, string> =>
  f.template_body.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim() ? {} : { template_body: 'Letter body is required.' }
const letterBlur = (k: string) => {
  const sp = letterSpecs()[k], v = (letterForm as Record<string, unknown>)[k] as Val
  lv.blur(k, v, sp)
  const m = letterExtra()[k]
  if (m && !(sp && validate(v, sp))) lv.setError(k, m)
}
const templateBlur = (k: string) => {
  const sp = templateSpecs()[k], v = (templateForm as Record<string, unknown>)[k] as Val
  tv.blur(k, v, sp)
  const m = templateExtra()[k]
  if (m && !(sp && validate(v, sp))) tv.setError(k, m)
}
// real-time: re-check the fields whose value changed (typing, customer auto-fill, editor input)
const prevLetter = useRef({ form: letterForm, open: letterModalOpen })
useEffect(() => {
  const prev = prevLetter.current
  prevLetter.current = { form: letterForm, open: letterModalOpen }
  if (prev.open !== letterModalOpen) { lv.clear(); return }
  if (!letterModalOpen) return
  const sp = letterSpecs(), ex = letterExtra()
  for (const k of LETTER_ORDER) {
    const v = (letterForm as Record<string, unknown>)[k] as Val
    if ((prev.form as Record<string, unknown>)[k] === v) continue
    lv.change(k, v, sp[k])
    if (ex[k] && !(sp[k] && validate(v, sp[k]!))) lv.setError(k, ex[k])
  }
}, [letterForm, letterModalOpen]) // eslint-disable-line react-hooks/exhaustive-deps
const prevTemplate = useRef({ form: templateForm, open: templateModalOpen })
useEffect(() => {
  const prev = prevTemplate.current
  prevTemplate.current = { form: templateForm, open: templateModalOpen }
  if (prev.open !== templateModalOpen) { tv.clear(); return }
  if (!templateModalOpen) return
  const sp = templateSpecs(), ex = templateExtra()
  for (const k of TEMPLATE_ORDER) {
    const v = (templateForm as Record<string, unknown>)[k] as Val
    if ((prev.form as Record<string, unknown>)[k] === v) continue
    if (sp[k]) tv.change(k, v, sp[k])
    else if (tv.errors[k]) tv.setError(k, ex[k] || '')
  }
}, [templateForm, templateModalOpen]) // eslint-disable-line react-hooks/exhaustive-deps

const handleSaveLetter = async () => {
if (!openTemplateId) return
const lBad = lv.validateAll(letterForm as unknown as Record<string, Val>, letterSpecs(), letterExtra())
if (Object.keys(lBad).length) { focusFirst(LETTER_ORDER, lBad, (id) => document.getElementById(`lt-${id}`)); return }
if (savingLetterRef.current) return
const { customer_id, quotation_id, ...rest } = letterForm
const payload = { ...rest, customer_id: customer_id === '' ? undefined : customer_id, quotation_id: quotation_id === '' ? undefined : quotation_id }
const template = templates.find((t) => t.id === openTemplateId)
const apiPayload = {
title: letterForm.description.trim() || template?.name || letterForm.ref_number.trim(),
subject: letterForm.letter_subject || null,
body: letterForm.letter_body || null,
recipient_name: letterForm.recipient_name || null,
recipient_email: letterForm.recipient_email || null,
recipient_address: letterForm.recipient_address || null,
issue_date: letterForm.issue_date || null,
}
// Letters created before this API integration only exist locally (non-numeric ids), so they are created on first save.
const serverLetterId = editingLetter && /^\d+$/.test(editingLetter.id) ? editingLetter.id : null
savingLetterRef.current = true
try {
if (editingLetter && serverLetterId) {
await api.put(`/letters/letters/${serverLetterId}`, apiPayload)
const updatedLetter: GeneratedLetter = { ...editingLetter, ...payload }
setGeneratedLetters((prev) => prev.map((l) => (l.id === editingLetter.id ? updatedLetter : l)))
toastSuccess('Letter updated successfully')
setLetterModalOpen(false)
if (template && isFinalStatus(payload.status)) await finalizeLetter(serverLetterId, template, updatedLetter)
return
}
const templateId = Number(openTemplateId)
const { data } = await api.post('/letters/letters', {
...apiPayload,
letter_template_id: Number.isInteger(templateId) ? templateId : null,
linked_source: payload.quotation_id !== undefined ? 'quotation' : payload.customer_id !== undefined ? 'customer' : null,
linked_record_id: payload.quotation_id ?? payload.customer_id ?? null,
linked_record_label: letterForm.recipient_company || null,
})
const savedLetter: GeneratedLetter = { ...(editingLetter || {}), id: String(data.id), template_id: openTemplateId, ...payload }
if (editingLetter) {
setGeneratedLetters((prev) => prev.map((l) => (l.id === editingLetter.id ? savedLetter : l)))
toastSuccess('Letter updated successfully')
setLetterModalOpen(false)
if (template && isFinalStatus(payload.status)) await finalizeLetter(savedLetter.id, template, savedLetter)
return
}
setGeneratedLetters((prev) => [savedLetter, ...prev])
setLetterModalOpen(false)
if (template) handleDownloadTemplate({ ...template, subject: savedLetter.letter_subject || template.subject, template_body: savedLetter.letter_body || template.template_body }, savedLetter)
toastSuccess('Letter generated successfully')
if (template && isFinalStatus(payload.status)) await finalizeLetter(savedLetter.id, template, savedLetter)
} catch (err: any) {
const known = Object.fromEntries(Object.entries(mapApiErrors(err, { title: 'description', subject: 'letter_subject' })).filter(([k]) => LETTER_ORDER.includes(k)))
if (Object.keys(known).length) {
lv.setErrors((prev) => ({ ...prev, ...known }))
focusFirst(LETTER_ORDER, known, (id) => document.getElementById(`lt-${id}`))
} else {
const detail = err?.response?.data?.detail
toastError(typeof detail === 'string' ? detail : 'Unable to save letter')
}
} finally {
savingLetterRef.current = false
}
}

const handlePreviewLetterDraft = () => {
if (!openTemplateId) return
const template = templates.find((t) => t.id === openTemplateId)
if (!template) return
openTemplatePreview({ ...template, subject: letterForm.letter_subject || template.subject, template_body: letterForm.letter_body || template.template_body }, {
id: editingLetter?.id || 'draft',
template_id: openTemplateId,
ref_number: letterForm.ref_number || 'SAMPLE-REF-2026',
recipient_name: letterForm.recipient_name,
recipient_email: letterForm.recipient_email,
recipient_company: letterForm.recipient_company,
recipient_address: letterForm.recipient_address,
issue_date: letterForm.issue_date,
valid_until: letterForm.valid_until,
template_values: letterForm.template_values,
signature_option: letterForm.signature_option,
signatory_option: letterForm.signatory_option,
})
}

const handleToggleTemplateStatus = async (template: LetterTemplateItem) => {
const nextActive = !template.is_active
try {
const { data } = await api.put(`/letters/templates/${template.id}`, {
name: template.name, category: template.category, subject: template.subject,
template_body: template.template_body, variables: template.variables,
is_default: template.is_default, is_active: nextActive,
})
const saved = toTemplateItem(data)
setTemplates((prev) => prev.map((t) => (t.id === template.id ? saved : t)))
toastSuccess(nextActive ? `"${template.name}" is now Active` : `"${template.name}" moved to Draft`)
} catch (err: any) {
toastError(err?.response?.data?.detail || 'Unable to update template status')
}
return
setTemplates((prev) => prev.map((t) => (t.id === template.id ? { ...t, is_active: nextActive } : t)))
toastSuccess(nextActive ? `"${template.name}" is now Active` : `"${template.name}" moved to Draft`)
}

// Letters saved after the API integration also have a server copy (numeric id).
const hasServerCopy = (letter: GeneratedLetter) => /^\d+$/.test(letter.id)

const handleDeleteLetter = async () => {
if (!confirmDeleteLetter) return
const letter = confirmDeleteLetter
if (hasServerCopy(letter)) {
  try {
    await api.delete(`/letters/letters/${letter.id}`)
  } catch (err: any) {
    if (err?.response?.status !== 404) {
      toastError(err?.response?.data?.detail || 'Unable to delete letter')
      return
    }
  }
}
setGeneratedLetters((prev) => prev.filter((l) => l.id !== letter.id))
setTrashedLetters((prev) => [{ ...letter, deleted_at: new Date().toISOString(), server_deleted: hasServerCopy(letter) }, ...prev.filter((l) => l.id !== letter.id)])
toastInfo(`Moved letter ${letter.ref_number} to the Recycle Bin`)
setConfirmDeleteLetter(null)
}

const handleRestoreLetter = async (letter: TrashedLetter) => {
if (hasServerCopy(letter)) {
  try {
    await api.post(`/letters/letters/${letter.id}/restore`)
  } catch (err: any) {
    toastError(err?.response?.data?.detail || 'Unable to restore letter')
    return
  }
}
const { deleted_at: _deletedAt, server_deleted: _serverDeleted, ...restored } = letter
setTrashedLetters((prev) => prev.filter((l) => l.id !== letter.id))
setGeneratedLetters((prev) => [restored, ...prev.filter((l) => l.id !== letter.id)])
toastSuccess(`Restored letter ${letter.ref_number}`)
}

const handlePermanentDeleteLetter = async (letter: TrashedLetter) => {
if (hasServerCopy(letter)) {
  try {
    await api.delete(`/letters/letters/${letter.id}/permanent`)
  } catch (err: any) {
    if (err?.response?.status !== 404) {
      toastError(err?.response?.data?.detail || 'Unable to permanently delete letter')
      return
    }
  }
}
setTrashedLetters((prev) => prev.filter((l) => l.id !== letter.id))
toastInfo(`Permanently deleted letter ${letter.ref_number}`)
}

const handleEmailLetter = (letter: GeneratedLetter) => {
const recipientEmail = letter.recipient_email?.trim()
if (recipientEmail) {
window.location.href = `mailto:${encodeURIComponent(recipientEmail)}`
return
}
setEmailLetter(letter)
setEmailRecipient('')
setEmailRecipientError('')
}

const sendToEnteredEmail = async () => {
const recipientEmail = emailRecipient.trim()
if (!emailLetter) return
const emailMsg = recipientEmail ? vEmail(recipientEmail) : 'Email address is required.'
if (emailMsg) {
setEmailRecipientError(emailMsg)
document.getElementById('lt-email-recipient')?.focus()
return
}
const letter = emailLetter
// Preserve the supplied address for this letter so subsequent Send Mail clicks
// use it directly. Persist it too when the letter has been saved to the API.
setGeneratedLetters((prev) => prev.map((item) => item.id === letter.id ? { ...item, recipient_email: recipientEmail } : item))
if (/^\d+$/.test(letter.id)) {
try {
await api.put(`/letters/letters/${letter.id}`, { recipient_email: recipientEmail })
} catch {
toastInfo('Email opened, but the address could not be saved to this letter')
}
}
setEmailLetter(null)
window.location.href = `mailto:${encodeURIComponent(recipientEmail)}`
}

// ── Stat calculations ───────────────────────────────────────────────────────
const activeTemplatesCount = templates.filter((t) => t.is_active).length

// Tab configurations matching Customers module styling
// Trash is template-management bookkeeping (restore/permanently delete
// templates), so it's admin-only just like creating/editing templates.
const tabs: { id: PageTab; label: string; count: number; icon: React.ReactNode }[] = [
{ id: 'templates', label: 'Templates', count: templates.length, icon: <LayoutTemplate size={13} /> },
{ id: 'trash', label: 'Recycle Bin', count: trashItems.length + trashedLetters.length, icon: <Trash2 size={13} /> },
]

const openTemplate = openTemplateId ? templates.find((t) => t.id === openTemplateId) || null : null
const resetLetterContentToTemplate = () => {
if (!openTemplate) return
const { content, subject } = resolveTemplateSample(openTemplate, {
  ...letterForm,
  // Regenerate from the template, not from the letter's current edits.
  letter_body: '',
  letter_subject: '',
  id: editingLetter?.id || 'draft',
  template_id: openTemplate.id,
})
setLetterForm((prev) => ({ ...prev, letter_subject: subject, letter_body: content }))
if (letterBodyRef.current) letterBodyRef.current.innerHTML = previewHtml(content)
}

useEffect(() => {
if (letterContentVersion && letterForm.customer_id !== '' && openTemplate) resetLetterContentToTemplate()
// A new version is created only after the selected customer's CRM data has loaded.
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [letterContentVersion])

const formatLetterBody = (command: 'bold' | 'italic' | 'underline' | 'insertUnorderedList') => {
const node = letterBodyRef.current
if (!node) return
node.focus()
document.execCommand(command)
setLetterForm((prev) => ({ ...prev, letter_body: cleanLetterBodyHtml(node) }))
}

const applyLetterList = (style: 'disc' | 'circle' | 'square' | 'decimal' | 'lower-roman' | 'upper-roman' | 'lower-alpha' | 'upper-alpha') => {
const node = letterBodyRef.current
if (!node) return
node.focus()
const isBulletList = ['disc', 'circle', 'square'].includes(style)
document.execCommand(isBulletList ? 'insertUnorderedList' : 'insertOrderedList')
const anchor = window.getSelection()?.anchorNode
const list = anchor
  ? (anchor.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor.parentElement)?.closest(isBulletList ? 'ul' : 'ol')
  : null
if (list instanceof HTMLElement) list.style.listStyleType = style
setLetterForm((prev) => ({ ...prev, letter_body: cleanLetterBodyHtml(node) }))
}

const cleanLetterBodyHtml = (node: HTMLDivElement) => {
const copy = node.cloneNode(true) as HTMLDivElement
copy.querySelectorAll('[data-letter-table-delete]').forEach((control) => control.remove())
copy.querySelectorAll('.letter-table-editor-wrap').forEach((wrapper) => {
  const parent = wrapper.parentNode
  while (wrapper.firstChild) parent?.insertBefore(wrapper.firstChild, wrapper)
  wrapper.remove()
})
return copy.innerHTML
}

const addTableDeleteControls = (node: HTMLDivElement | null) => {
if (!node) return
node.querySelectorAll('table').forEach((table) => {
  if (table.closest('.letter-table-editor-wrap')) return
  const wrapper = document.createElement('div')
  wrapper.className = 'letter-table-editor-wrap'
  table.parentNode?.insertBefore(wrapper, table)
  wrapper.appendChild(table)
  const removeButton = document.createElement('button')
  removeButton.type = 'button'
  removeButton.setAttribute('contenteditable', 'false')
  removeButton.setAttribute('data-letter-table-delete', 'true')
  removeButton.setAttribute('aria-label', 'Delete table')
  removeButton.title = 'Delete table'
  removeButton.textContent = '×'
  wrapper.appendChild(removeButton)
})
}

useEffect(() => {
  if (!letterModalOpen || !letterBodyRef.current) return
  // contentEditable does not render React state by itself. Hydrate it when a
  // saved letter is opened so its paragraphs, formatting and tables reappear.
  letterBodyRef.current.innerHTML = previewHtml(letterForm.letter_body || '')
  addTableDeleteControls(letterBodyRef.current)
  // Only run on opening/changing the selected letter; running on every keystroke
  // would reset the caret while the user types.
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [letterModalOpen, editingLetter?.id])

useEffect(() => {
  addTableDeleteControls(letterBodyRef.current)
}, [letterForm.letter_body, letterModalOpen])

useEffect(() => {
addTableDeleteControls(templateBodyRef.current)
}, [templateForm.template_body, templateModalOpen, editingTemplate?.id])

const insertLetterTable = () => {
const node = letterBodyRef.current
if (!node) return
node.focus()
const selection = window.getSelection()
const range = selection?.rangeCount && node.contains(selection.getRangeAt(0).commonAncestorContainer)
  ? selection.getRangeAt(0)
  : null
const table = document.createElement('table')
table.innerHTML = '<thead><tr><th>Item Description</th><th>Quantity</th><th>Amount</th></tr></thead><tbody><tr><td>Enter item</td><td>1</td><td>0.00</td></tr></tbody>'
if (range) {
  range.deleteContents()
  range.insertNode(table)
  const afterTable = document.createRange()
  afterTable.setStartAfter(table)
  afterTable.collapse(true)
  selection?.removeAllRanges()
  selection?.addRange(afterTable)
} else {
  node.appendChild(document.createElement('br'))
  node.appendChild(table)
}
setLetterForm((prev) => ({ ...prev, letter_body: cleanLetterBodyHtml(node) }))
}

const updateActiveLetterTable = (action: 'row' | 'column' | 'deleteRow' | 'deleteColumn' | 'deleteCell') => {
const node = letterBodyRef.current
const selection = window.getSelection()
const anchor = selection?.anchorNode
const anchorElement = anchor
  ? (anchor.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor.parentElement)
  : null
const table = anchorElement?.closest('table')
if (!node || !table || !node.contains(table)) {
  toastInfo('Place the cursor inside a table first.')
  return
}
if (action === 'deleteRow' || action === 'deleteColumn' || action === 'deleteCell') {
  const cell = anchorElement?.closest('td, th') as HTMLTableCellElement | null
  if (!cell || cell.closest('table') !== table) {
    toastInfo('Place the cursor inside a table cell first.')
    return
  }
  const row = cell.parentElement as HTMLTableRowElement
  if (action === 'deleteRow') {
    row.remove()
  } else if (action === 'deleteColumn') {
    const columnIndex = cell.cellIndex
    Array.from(table.rows).forEach((tableRow) => tableRow.cells[columnIndex]?.remove())
  } else {
    cell.remove()
  }
  // Drop rows, sections and finally the table itself once they have nothing left in them.
  Array.from(table.rows).forEach((tableRow) => { if (!tableRow.cells.length) tableRow.remove() })
  table.querySelectorAll(':scope > thead, :scope > tbody, :scope > tfoot').forEach((section) => { if (!section.children.length) section.remove() })
  if (!table.rows.length) (table.closest('.letter-table-editor-wrap') || table).remove()
  setLetterForm((prev) => ({ ...prev, letter_body: cleanLetterBodyHtml(node) }))
  return
}
if (action === 'row') {
  const columnCount = table.querySelector('tr')?.cells.length || 1
  const row = document.createElement('tr')
  for (let index = 0; index < columnCount; index += 1) {
    const cell = document.createElement('td')
    cell.textContent = 'Enter value'
    row.appendChild(cell)
  }
  const body = table.querySelector('tbody') || table.appendChild(document.createElement('tbody'))
  body.appendChild(row)
} else {
  table.querySelectorAll('tr').forEach((row, rowIndex) => {
    const cell = document.createElement(rowIndex === 0 ? 'th' : 'td')
    cell.textContent = rowIndex === 0 ? 'New Column' : 'Enter value'
    row.appendChild(cell)
  })
}
setLetterForm((prev) => ({ ...prev, letter_body: cleanLetterBodyHtml(node) }))
}
const openTemplateLetterRows = openTemplate ? generatedLetters.filter((l) => l.template_id === openTemplate.id) : []
const selectedTemplateFields = useMemo(() => {
if (!openTemplate) return new Set<string>()
const configured = openTemplate.variables || []
const tagged = `${openTemplate.subject}\n${openTemplate.template_body}`.match(/{{\s*([^}]+?)\s*}}/g) || []
return new Set([...configured, ...tagged.map((tag) => tag.slice(2, -2))]
.map((field) => field.trim().toLowerCase()))
}, [openTemplate])
const hasSelectedTemplateFields = selectedTemplateFields.size > 0
const showLetterField = (...names: string[]) => !hasSelectedTemplateFields || names.some((name) => selectedTemplateFields.has(name))
const builtInTemplateFields = new Set([
'recipient_name', 'candidate_name', 'customer_to_name', 'contact_person',
'recipient_email', 'candidate_email', 'email',
'recipient_company', 'candidate_company', 'customer_name',
'recipient_address', 'candidate_address', 'customer_address',
'branch', 'sub_branch', 'department', 'sub_department', 'designation',
'valid_until', 'valid_until_date', 'region', 'ref_no', 'reference_number',
'quotation_number', 'issue_date', 'quotation_date', 'status', 'letter_language',
'company_name', 'company_address', 'company_phone', 'company_email',
'signatory_name', 'signatory_designation', 'signatory_phone', 'signatory_email',
'item_serial_no', 'item_description', 'item_quantity', 'item_unit_price',
'item_gst_percent', 'item_gst_value', 'item_net_price', 'item_total_price',
])
const customTemplateFields = Array.from(selectedTemplateFields).filter((field) => !builtInTemplateFields.has(field))
const mergeFieldGroups = [
  ['Customer fields', ['recipient_name', 'customer_name', 'project_name', 'company_name', 'company_address', 'phone', 'website']],
  ['Quotation fields', ['quotation_number', 'quotation_date', 'valid_until', 'subtotal', 'gst_amount', 'total_amount', 'terms']],
  ['Custom fields', templateForm.variables.split(',').map((value) => value.trim()).filter(Boolean)],
] as [string, string[]][]
const mergeFieldKind = (field: string): 'text' | 'date' | 'amount' => field.includes('date') || field.includes('until') ? 'date' : /amount|subtotal|gst|total/.test(field) ? 'amount' : 'text'
const templateFieldLabel = (field: string) => field.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
const templateFormFieldMap: Record<string, string> = {
recipient_name: 'recipient_name', candidate_name: 'recipient_name', customer_to_name: 'recipient_name', contact_person: 'recipient_name',
recipient_email: 'recipient_email', candidate_email: 'recipient_email', email: 'recipient_email',
recipient_company: 'recipient_company', candidate_company: 'recipient_company', customer_name: 'recipient_company',
recipient_address: 'recipient_address', candidate_address: 'recipient_address', customer_address: 'recipient_address',
ref_no: 'ref_number', reference_number: 'ref_number', quotation_number: 'ref_number',
issue_date: 'issue_date', quotation_date: 'issue_date', valid_until: 'valid_until', valid_until_date: 'valid_until',
region: 'region', status: 'status', letter_language: 'language', branch: 'branch', sub_branch: 'sub_branch',
department: 'department', sub_department: 'sub_department', designation: 'designation',
}
const templateFieldValue = (field: string) => {
const formField = templateFormFieldMap[field]
return formField ? String((letterForm as Record<string, unknown>)[formField] || '') : letterForm.template_values[field] || ''
}
const updateTemplateField = (field: string, value: string) => {
const formField = templateFormFieldMap[field]
setLetterForm((prev) => ({
...prev,
template_values: { ...prev.template_values, [field]: value },
...(formField ? { [formField]: value } : {}),
}))
}
const showRecipientDetails = false

return (
<div className="page-body space-y-5">
{/* Page Header */}
<PageHeader
title={
templateModalOpen
? (editingTemplate ? 'Edit Template' : 'Create Letter Template')
: letterModalOpen
? (editingLetter ? 'Edit Letter' : 'Create Letter')
: openTemplate
? openTemplate.name
: moduleLabel
}
subtitle={
templateModalOpen
? 'Define standard wording with dynamic placeholder variables'
: letterModalOpen
? (openTemplate ? `For template: ${openTemplate.name}` : undefined)
: openTemplate
? 'Letters generated from this template'
: 'Manage standard letter templates and trash bin'
}
breadcrumb={
templateModalOpen
? [moduleLabel, editingTemplate ? 'Edit Template' : 'Create Template']
: letterModalOpen
? [moduleLabel, ...(openTemplate ? [openTemplate.name] : []), editingLetter ? 'Edit Letter' : 'Create Letter']
: openTemplate
? [moduleLabel, openTemplate.name]
: [moduleLabel]
}
actions={
<div className="flex items-center gap-2">
{!templateModalOpen && !letterModalOpen && (
<button
             onClick={handleRefresh}
             title="Refresh records"
             className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"
           >
<RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
</button>
)}

        {templateModalOpen ? (
          <>
            <button
              onClick={() => setTemplateModalOpen(false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
            >
              ← Back
            </button>
            <Button onClick={handleSaveTemplate}>
              {editingTemplate ? 'Update Template' : 'Create'}
            </Button>
          </>
        ) : letterModalOpen ? (
          <>
            <button
              onClick={() => setLetterModalOpen(false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
            >
              ← Back
            </button>
            <Button variant="ghost" onClick={handlePreviewLetterDraft}>
              <Eye size={14} className="mr-1.5 inline-block" /> Preview
            </Button>
            <Button onClick={handleSaveLetter}>
              {editingLetter ? 'Update Letter' : 'Create Letter'}
            </Button>
          </>
        ) : openTemplate ? (
          <>
            <button
              onClick={() => setOpenTemplateId(null)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
            >
              ← Back to Templates
            </button>
            {openTemplate.is_active ? (
              <Button onClick={openAddLetterModal}>
                <Plus size={15} className="mr-1.5 inline-block" /> Create Letter
              </Button>
            ) : (
              <Button onClick={() => handleToggleTemplateStatus(openTemplate)}>
                <CheckCircle2 size={15} className="mr-1.5 inline-block" /> Activate Template
              </Button>
            )}
          </>
        ) : (
          <>
            {pageTab === 'templates' && isTemplateAdmin && (
              <Button onClick={openCreateTemplateModal}>
                <Plus size={15} className="mr-1.5 inline-block" /> Create Template
              </Button>
            )}
          </>
        )}
      </div>
    }
  />

  {/* ══════════════════════════════════════════════════════════════════════════
      GENERATED LETTERS VIEW (opened by clicking a template name)
     ══════════════════════════════════════════════════════════════════════════ */}
  {!templateModalOpen && !letterModalOpen && openTemplate && (
    <>
      {!openTemplate.is_active && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <span className="font-semibold">This template is in Draft — activate it before generating letters.</span>
          <Button onClick={() => handleToggleTemplateStatus(openTemplate)}>
            <CheckCircle2 size={14} className="mr-1.5 inline-block" /> Activate Template
          </Button>
        </div>
      )}
    <Card hover={false}>
      {openTemplateLetterRows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-600">
            <thead className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-5 py-3">S.No</th>
                <th className="px-5 py-3">Ref Number</th>
                <th className="px-5 py-3">Customer Details</th>
                <th className="px-5 py-3">Issue Date</th>
                <th className="px-5 py-3">Valid Until</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {openTemplateLetterRows.map((letter, index) => (
                <tr key={letter.id} className="transition-colors hover:bg-slate-50/70">
                  <td className="px-5 py-3.5">{index + 1}</td>
                  <td className="px-5 py-3.5 font-mono font-semibold text-slate-900">{letter.ref_number}</td>
                  <td className="px-5 py-3.5">
                    <div className="font-bold text-slate-900">{letter.recipient_name}</div>
                    {letter.recipient_email && (
                      <div className="text-[11px] text-slate-400">EMAIL - {letter.recipient_email}</div>
                    )}
                    {letter.recipient_company && (
                      <div className="text-[11px] text-slate-400">COMPANY - {letter.recipient_company}</div>
                    )}
                  </td>
                  <td className="px-5 py-3.5 whitespace-nowrap text-slate-500">{formatDisplayDate(letter.issue_date)}</td>
                  <td className="px-5 py-3.5 whitespace-nowrap text-slate-500">{formatDisplayDate(letter.valid_until)}</td>
                  <td className="px-5 py-3.5"><span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${letter.status === 'Issued' ? 'bg-emerald-50 text-emerald-700' : letter.status === 'Sent' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'}`}>{letter.status || 'Draft'}</span></td>
                  <td className="px-5 py-3.5 text-right">
                    <div onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openTemplatePreview(openTemplate, letter)}
                        title="View letter"
                        className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50 text-blue-600 transition-all hover:bg-blue-100"
                      >
                        <Eye size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEditLetterModal(letter)}
                        title="Edit letter"
                        className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-indigo-600 transition-all hover:bg-indigo-50"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDownloadTemplate(openTemplate, letter)}
                        title="Print / Download letter"
                        className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 transition-all hover:bg-emerald-100"
                      >
                        <Printer size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEmailLetter(letter)}
                        title="Email letter"
                        className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-50 text-amber-600 transition-all hover:bg-amber-100"
                      >
                        <Mail size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteLetter(letter)}
                        title="Delete letter"
                        className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-50 text-rose-600 transition-all hover:bg-rose-100"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex min-h-[240px] flex-col items-center justify-center px-6 py-10 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
            <FileText size={24} />
          </div>
          <h4 className="mt-4 text-sm font-semibold text-slate-800">No letters generated yet</h4>
          <p className="mt-1 max-w-md text-xs text-slate-500">
            {openTemplate.is_active
              ? 'Generate a letter to keep a record of who this template was issued to.'
              : 'Activate this template above before generating letters.'}
          </p>
          {openTemplate.is_active && (
            <Button onClick={openAddLetterModal} className="mt-4">
              <Plus size={14} className="mr-1.5 inline-block" /> Create Letter
            </Button>
          )}
        </div>
      )}
    </Card>
    </>
  )}

  {/* ── Page Tabs: Matching Customers Module Clean Tabs ─────────────────── */}
  {!templateModalOpen && !openTemplate && <div className="flex flex-wrap items-center justify-between gap-3">
    <div className="flex items-center gap-1 bg-slate-100 rounded-2xl p-1.5 w-fit">
      {tabs.map((tab) => {
        const active = pageTab === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => setPageTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl transition-all whitespace-nowrap outline-none focus:outline-none focus:ring-0 ${
              active
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 font-bold leading-none">
              {tab.count}
            </span>
          </button>
        )
      })}
    </div>

  </div>}

  {/* ══════════════════════════════════════════════════════════════════════════
      TAB 1: TEMPLATES VIEW
     ══════════════════════════════════════════════════════════════════════════ */}
  {!templateModalOpen && !openTemplate && pageTab === 'templates' && (
    <div className="space-y-4">
      {/* Template Stat Cards */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <StatCard
          title="Total Templates"
          value={templates.length}
          icon={<LayoutTemplate size={18} />}
          color="blue"
          active={templateStatFilter === 'all'}
          onClick={() => {
            // Show every template: clear the stat, category and search filters.
            setTemplateStatFilter('all'); setTemplateCategoryFilter('All'); setTemplateSearch('')
            templateListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}
        />
        <StatCard
          title="Active Templates"
          value={activeTemplatesCount}
          icon={<CheckCircle2 size={18} />}
          color="green"
          active={templateStatFilter === 'active'}
          onClick={() => {
            setTemplateStatFilter((prev) => (prev === 'active' ? 'all' : 'active'))
            templateListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}
        />
        <StatCard
          title="Categories"
          value={Math.max(0, templateCategories.length - 1)}
          icon={<SlidersHorizontal size={18} />}
          color="amber"
          active={templateStatFilter === 'categories'}
          onClick={() => {
            // Show all templates grouped by category and open the category picker.
            setTemplateStatFilter('categories'); setTemplateCategoryFilter('All')
            templateListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            const select = templateCategorySelectRef.current
            if (select) {
              select.focus()
              try { select.showPicker?.() } catch { /* not supported in this browser */ }
            }
          }}
        />
      </div>

      {/* Templates Main Card */}
      <div ref={templateListRef} className="scroll-mt-4">
      <Card hover={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <LayoutTemplate size={17} />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Letter Templates</h3>
              <p className="text-xs text-slate-500">
                {filteredTemplates.length} record{filteredTemplates.length !== 1 ? 's' : ''} available
              </p>
            </div>
          </div>

          {/* Toolbar & Filters */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
                placeholder="Search templates..."
                className="h-8 w-52 rounded-lg border border-slate-200 bg-white pl-8 pr-7 text-xs font-medium text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none"
              />
              {templateSearch && (
                <button
                  onClick={() => setTemplateSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Category Dropdown */}
            <select
              ref={templateCategorySelectRef}
              value={templateCategoryFilter}
              onChange={(e) => setTemplateCategoryFilter(e.target.value)}
              className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 focus:border-indigo-400 focus:outline-none"
            >
              {templateCategories.map((c) => (
                <option key={c} value={c}>
                  {c === 'All' ? 'All Categories' : c}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Templates grouped into category cards */}
        {filteredTemplates.length > 0 && (
          <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
            {templatesByCategory.map(([category, items], index) => {
              const style = categoryStyle(category, index)
              return (
                <div key={category} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
                    <span className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg ${style.badge}`}>
                      {style.icon}
                    </span>
                    <div className="min-w-0">
                      <h4 className="truncate text-sm font-semibold text-slate-900">{category}</h4>
                      <p className="text-[11px] text-slate-400">{items.length} item{items.length !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                  <div className="divide-y divide-slate-100 px-2 py-1">
                    {items.map((t) => (
                      <div key={t.id} className="group flex items-center justify-between gap-2 px-2 py-2.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openTemplateLetters(t)}
                            className="min-w-0 truncate text-left text-xs font-semibold text-slate-700 hover:text-indigo-600"
                            title={t.name}
                          >
                            {t.name}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleTemplateStatus(t)}
                            title={t.is_active ? 'Click to move to Draft' : 'Click to Activate'}
                            className={`flex-none rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors ${
                              t.is_active
                                ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                                : 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                            }`}
                          >
                            {t.is_active ? 'Active' : 'Draft'}
                          </button>
                        </div>
                        <div className="flex flex-none items-center gap-1">
                          <LetterIconGroup
                            templateName={t.name}
                            onPreview={() => openTemplatePreview(t)}
                            onDownload={() => handleDownloadTemplate(t)}
                            onEdit={isTemplateAdmin ? () => openEditTemplateModal(t) : undefined}
                          />
                          <TemplateActionsMenu
                            templateName={t.name}
                            onPreview={() => openTemplatePreview(t)}
                            onDuplicate={isTemplateAdmin ? () => handleDuplicateTemplate(t) : undefined}
                            onDelete={isTemplateAdmin ? () => handleTrashTemplate(t) : undefined}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Empty State */}
        {filteredTemplates.length === 0 && (
          <div className="flex min-h-[240px] flex-col items-center justify-center px-6 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
              <LayoutTemplate size={24} />
            </div>
            <h4 className="mt-4 text-sm font-semibold text-slate-800">No templates found</h4>
            <p className="mt-1 max-w-md text-xs text-slate-500">
              {templateSearch || templateCategoryFilter !== 'All' || templateStatFilter === 'active'
                ? 'No templates match your search or filter.'
                : 'Create your first reusable letter template with dynamic placeholders.'}
            </p>
            {!templateSearch && isTemplateAdmin && (
              <Button onClick={openCreateTemplateModal} className="mt-4">
                <Plus size={14} className="mr-1.5 inline-block" /> Create Template
              </Button>
            )}
          </div>
        )}
      </Card>
      </div>
    </div>
  )}

  {/* ══════════════════════════════════════════════════════════════════════════
      TAB 2: TRASH VIEW
     ══════════════════════════════════════════════════════════════════════════ */}
  {!templateModalOpen && !openTemplate && pageTab === 'trash' && (
    <div className="space-y-4">
      {/* Trash List Card */}
      <Card hover={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-50 text-rose-600">
              <Trash2 size={17} />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Recycle Bin</h3>
              <p className="text-xs text-slate-500">
                Deleted letters and templates can be restored or permanently removed
              </p>
            </div>
          </div>

          {/* Toolbar & Filter */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={trashSearch}
                onChange={(e) => setTrashSearch(e.target.value)}
                placeholder="Search trash..."
                className="h-8 w-52 rounded-lg border border-slate-200 bg-white pl-8 pr-7 text-xs font-medium text-slate-700 placeholder:text-slate-400 focus:border-rose-400 focus:outline-none"
              />
              {trashSearch && (
                <button
                  onClick={() => setTrashSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Filter by Category if items exist */}
            {recycleBinRows.length > 0 && (
              <select
                value={trashCategoryFilter}
                onChange={(e) => setTrashCategoryFilter(e.target.value)}
                className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 focus:border-rose-400 focus:outline-none"
              >
                <option value="All">All Categories</option>
                {Array.from(new Set(recycleBinRows.map((i) => i.category).filter(Boolean))).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Trash Table or Empty State */}
        {filteredTrash.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-600">
              <thead className="border-b border-slate-100 bg-slate-50/70 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Type</th>
                  <th className="px-5 py-3">Deleted Date</th>
                  <th className="px-5 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredTrash.map((item) => (
                  <tr key={item.key} className="transition-colors hover:bg-slate-50/70">
                    <td className="px-5 py-3.5">
                      <div className="font-bold text-slate-900">{item.title}</div>
                      <div className="text-[11px] text-slate-400">{item.subtitle}</div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-bold ${item.kind === 'letter' ? 'border-amber-100 bg-amber-50 text-amber-700' : 'border-indigo-100 bg-indigo-50 text-indigo-700'}`}>
                        {item.category}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-slate-500 whitespace-nowrap">
                      {item.deleted_at ? formatDisplayDate(item.deleted_at) : '—'}
                    </td>
                    <td className="px-5 py-3.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <button
                          onClick={item.onRestore}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-emerald-700 transition-colors shadow-xs"
                        >
                          <RotateCcw size={12} className="text-emerald-600" /> Restore
                        </button>
                        <button
                          onClick={item.onDelete}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-100 transition-colors"
                        >
                          <Trash2 size={12} /> Delete Forever
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex min-h-[240px] flex-col items-center justify-center px-6 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
              <Trash2 size={24} />
            </div>
            <h4 className="mt-4 text-sm font-semibold text-slate-800">Recycle Bin is empty</h4>
            <p className="mt-1 max-w-md text-xs text-slate-500">
              Letters and templates you delete will be safely stored here for restoration.
            </p>
          </div>
        )}
      </Card>
    </div>
  )}

  {/* ══════════════════════════════════════════════════════════════════════════
      PAGE: CREATE / EDIT TEMPLATE
     ══════════════════════════════════════════════════════════════════════════ */}
  {templateModalOpen && (
    <div className="space-y-3 text-xs">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 border-b border-slate-100 pb-2.5">
          <h3 className="text-sm font-bold text-slate-800"><span className="mr-2 text-indigo-600">1.</span>Template Details</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">Provide the basic information for this template.</p>
        </div>
        <div className="grid grid-cols-1 gap-x-3 gap-y-3 md:grid-cols-2 xl:grid-cols-4">
          <div><label className="mb-1 block font-semibold text-slate-700">Template Name <span className="text-rose-500">*</span></label><input id="tp-name" type="text" maxLength={200} value={templateForm.name} onChange={(e) => setTemplateForm((prev) => ({ ...prev, name: e.target.value }))} onBlur={() => templateBlur('name')} aria-invalid={tv.errors.name ? true : undefined} placeholder="Standard Quotation Letter" className={`template-input ${tv.errors.name ? 'err' : ''}`} /><FieldError id="tp-name" msg={tv.errors.name} /></div>
          <div><label className="mb-1 block font-semibold text-slate-700">Source Module <span className="text-rose-500">*</span></label><select id="tp-category" value={templateForm.category} onChange={(e) => setTemplateForm((prev) => ({ ...prev, category: e.target.value }))} onBlur={() => templateBlur('category')} className={`template-input ${tv.errors.category ? 'err' : ''}`}><option value="Quotation">Quotation</option></select><FieldError id="tp-category" msg={tv.errors.category} /></div>
          <div><label className="mb-1 block font-semibold text-slate-700">Template Folder</label><input id="tp-folder" type="text" value={templateForm.folder} onChange={(e) => setTemplateForm((prev) => ({ ...prev, folder: e.target.value }))} onBlur={() => templateBlur('folder')} placeholder="Commercial" className={`template-input ${tv.errors.folder ? 'err' : ''}`} /><FieldError id="tp-folder" msg={tv.errors.folder} /></div>
          <div>
            <label className="mb-1 block font-semibold text-slate-700">Status</label>
            <div className="relative">
              <select value={templateForm.status} onChange={(e) => setTemplateForm((prev) => ({ ...prev, status: e.target.value as 'active' | 'inactive' | 'draft' }))} className="template-input appearance-none">
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="draft">Draft</option>
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            </div>
          </div>
          <div className="md:col-span-2 xl:col-span-3"><label className="mb-1 block font-semibold text-slate-700">Description</label><input id="tp-description" type="text" value={templateForm.description} onChange={(e) => setTemplateForm((prev) => ({ ...prev, description: e.target.value }))} onBlur={() => templateBlur('description')} placeholder="Standard quotation template for new customers." className={`template-input ${tv.errors.description ? 'err' : ''}`} /><FieldError id="tp-description" msg={tv.errors.description} /></div>
          <label className="flex items-center gap-2 self-end pb-1.5 text-[11px] text-slate-600"><input type="checkbox" checked={templateForm.is_default} onChange={(e) => setTemplateForm((prev) => ({ ...prev, is_default: e.target.checked }))} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" /><span><span className="block font-semibold text-slate-700">Set as Default Template</span>Use this template by default for quotations.</span></label>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 border-b border-slate-100 pb-2.5"><h3 className="text-sm font-bold text-slate-800"><span className="mr-2 text-indigo-600">2.</span>Letter Content</h3><p className="mt-0.5 text-[11px] text-slate-500">Define the subject and content. Use merge fields to personalize the letter.</p></div>
          <label className="mb-1 block font-semibold text-slate-700">Subject <span className="text-rose-500">*</span></label>
          <input id="tp-subject" value={templateForm.subject} onChange={(e) => setTemplateForm((prev) => ({ ...prev, subject: e.target.value }))} onBlur={() => templateBlur('subject')} aria-invalid={tv.errors.subject ? true : undefined} placeholder="Quotation for {{customer_name}} - {{quotation_number}}" className={`template-input ${tv.errors.subject ? 'err' : 'mb-3'}`} />
          {tv.errors.subject && <div className="mb-3"><FieldError id="tp-subject" msg={tv.errors.subject} /></div>}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><label className="font-semibold text-slate-700">Letter body <span className="text-rose-500">*</span></label><div className="flex flex-wrap gap-2"><button type="button" onClick={() => openTemplatePreview({ id: editingTemplate?.id || 'draft', name: templateForm.name || 'Untitled Template', category: templateForm.category || 'General', subject: templateForm.subject, template_body: templateForm.template_body, variables: [], version: 1, is_default: templateForm.is_default, is_active: true, created_at: '', updated_at: '' })} className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 font-semibold text-indigo-700 hover:bg-indigo-100"><Eye size={13} /> Preview</button></div></div>
          <div className={`overflow-hidden rounded-lg border border-slate-200 ${tv.errors.template_body ? 'err' : ''}`}>
            <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-600"><select onChange={(e) => { if (e.target.value === 'heading') setBlockTag('h3'); if (e.target.value === 'paragraph') setBlockTag('p'); e.target.value = 'paragraph' }} className="mr-1 border-0 bg-transparent py-1 text-[11px] outline-none"><option value="paragraph">Paragraph</option><option value="heading">Heading</option></select><button type="button" title="Bold selected text" onMouseDown={(e) => e.preventDefault()} onClick={() => toggleInlineFormat('b')} className="editor-tool"><Bold size={13} /></button><button type="button" title="Italic selected text" onMouseDown={(e) => e.preventDefault()} onClick={() => toggleInlineFormat('i')} className="editor-tool"><Italic size={13} /></button><button type="button" title="Underline selected text" onMouseDown={(e) => e.preventDefault()} onClick={() => toggleInlineFormat('u')} className="editor-tool"><Underline size={13} /></button><span className="mx-1 h-4 border-l border-slate-200" /><button type="button" title="Align left" onMouseDown={(e) => e.preventDefault()} onClick={() => setBlockAlignment('left')} className="editor-tool"><AlignLeft size={13} /></button><button type="button" title="Align center" onMouseDown={(e) => e.preventDefault()} onClick={() => setBlockAlignment('center')} className="editor-tool"><AlignCenter size={13} /></button><button type="button" title="Insert link" onMouseDown={(e) => e.preventDefault()} onClick={() => { const url = window.prompt('Enter URL'); if (url) insertLink(url) }} className="editor-tool"><Link2 size={13} /></button><span className="mx-1 h-4 border-l border-slate-200" /><button type="button" title="Undo" onMouseDown={(e) => e.preventDefault()} onClick={() => undoEditor()} className="editor-tool"><Undo2 size={13} /></button><button type="button" title="Redo" onMouseDown={(e) => e.preventDefault()} onClick={() => redoEditor()} className="editor-tool"><Redo2 size={13} /></button><span className="mx-1 h-4 border-l border-slate-200" /><button type="button" title="Add editable table" onMouseDown={(e) => e.preventDefault()} onClick={insertTemplateTable} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"><LayoutTemplate size={13} /> Add Table</button><button type="button" title="Add a row to the selected table" onMouseDown={(e) => e.preventDefault()} onClick={() => updateActiveTemplateTable('row')} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700">+ Row</button><button type="button" title="Add a column to the selected table" onMouseDown={(e) => e.preventDefault()} onClick={() => updateActiveTemplateTable('column')} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700">+ Column</button></div>
            <div ref={templateBodyRef} id="tp-template_body" onBlur={() => templateBlur('template_body')} contentEditable suppressContentEditableWarning dir="ltr" onClick={(event) => { const removeButton = (event.target as HTMLElement).closest('[data-letter-table-delete]'); if (!removeButton || !templateBodyRef.current) return; event.preventDefault(); pushEditorHistory(); removeButton.closest('.letter-table-editor-wrap')?.remove(); const html = cleanLetterBodyHtml(templateBodyRef.current); setTemplateForm((prev) => ({ ...prev, template_body: html })) }} onInput={(e) => { const html = cleanLetterBodyHtml(e.currentTarget); setTemplateForm((prev) => ({ ...prev, template_body: html })) }} onDragOver={(event) => event.preventDefault()} onDrop={dropVariableIntoContent} data-placeholder="Type template wording here. Use {{variable_name}} for dynamic tags..." className="template-rich-editor min-h-[250px] w-full p-3 text-xs leading-6 text-slate-700 outline-none" style={{ fontFamily: 'var(--font-family)' }} />
            <div className="flex justify-end border-t border-slate-100 bg-slate-50 px-3 py-1 text-[10px] text-slate-400">Words: {templateForm.template_body.trim() ? templateForm.template_body.trim().split(/\s+/).length : 0} &nbsp; Characters: {templateForm.template_body.length}</div>
          </div>
          <FieldError id="tp-template_body" msg={tv.errors.template_body} />
        </section>

        <aside className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="border-b border-slate-100 pb-2.5"><h3 className="text-sm font-bold text-slate-800"><span className="mr-2 text-indigo-600">3.</span>Merge Fields</h3><p className="mt-0.5 text-[11px] text-slate-500">Click a field to insert it at your cursor.</p></div>
          <div className="relative my-3"><Search size={13} className="absolute left-2.5 top-2 text-slate-400" /><input value={mergeFieldSearch} onChange={(event) => setMergeFieldSearch(event.target.value)} placeholder="Search fields..." className="w-full rounded-md border border-slate-200 py-1.5 pl-7 pr-2 text-[11px] outline-none focus:border-indigo-400" /></div>
          <div className="mb-3 flex flex-wrap gap-1.5">{([['all', 'All'], ['text', 'Text'], ['date', 'Date'], ['amount', 'Amount']] as const).map(([type, label]) => <button key={type} type="button" onClick={() => setMergeFieldType(type)} className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${mergeFieldType === type ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-200 bg-white text-slate-500 hover:border-indigo-300'}`}>{label}</button>)}</div>
          <div className="max-h-72 space-y-1 overflow-y-auto pr-1">{mergeFieldGroups.flatMap(([title, fields]) => fields.map((field) => ({ title, field }))).filter(({ field }) => (mergeFieldType === 'all' || mergeFieldKind(field) === mergeFieldType) && field.toLowerCase().includes(mergeFieldSearch.toLowerCase())).map(({ title, field }) => <button key={`${title}-${field}`} type="button" draggable onDragStart={(event) => { event.dataTransfer.setData('text/plain', field); event.dataTransfer.effectAllowed = 'copy' }} onClick={() => insertVariableIntoBody(field)} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-indigo-50" title="Click to insert or drag into content"><GripVertical size={11} className="text-slate-300" /><span className="min-w-0 flex-1"><span className="block text-[11px] font-semibold text-slate-700">{templateFieldLabel(field)}</span><span className="block truncate font-mono text-[10px] text-indigo-600">{`{{${field}}}`}</span></span><span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold capitalize text-slate-500">{mergeFieldKind(field)}</span></button>)}</div>
          <div className="mt-3 border-t border-slate-100 pt-3"><input value={newVariableName} onChange={(event) => setNewVariableName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTemplateField() } }} placeholder="Custom field name" className="mb-2 w-full rounded-md border border-slate-200 px-2 py-1.5 text-[11px] outline-none focus:border-indigo-400" /><button type="button" onClick={addTemplateField} className="w-full rounded-md border border-dashed border-indigo-300 py-1.5 text-[11px] font-semibold text-indigo-600 hover:bg-indigo-50">+ Add custom field</button></div>
        </aside>
      </div>

    </div>
  )}

  {/* ══════════════════════════════════════════════════════════════════════════
      MODAL: TEMPLATE PREVIEW
     ══════════════════════════════════════════════════════════════════════════ */}
  {false && <Modal
    open={false}
    onClose={() => setTableBuilderOpen(false)}
    title="Insert quotation items table"
    subtitle="Choose the columns to include in the commercial proposal."
    size="lg"
    footer={
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setTableBuilderOpen(false)}>Cancel</Button>
        <Button onClick={addQuotationTable}>Insert Table</Button>
      </div>
    }
  >
    <div className="space-y-4 text-xs">
      <div>
        <p className="mb-2 font-semibold text-slate-700">Table columns</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {['S.No', 'Item Description', 'Qty', 'Unit Price', 'GST %', 'GST Value', 'Net Price', 'Total Price'].map((column) => {
            const selected = tableColumns.includes(column)
            return (
              <button key={column} type="button" onClick={() => setTableColumns((prev) => selected ? prev.filter((value) => value !== column) : [...prev, column])}
                className={`rounded-lg border px-3 py-2 text-left font-medium transition-colors ${selected ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}>
                <span className="mr-1.5 inline-block">{selected ? '✓' : '○'}</span>{column}
              </button>
            )
          })}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-200">
        <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">Table preview</div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="bg-slate-50 text-slate-600"><tr>{tableColumns.map((column) => <th key={column} className="whitespace-nowrap border-b border-slate-200 px-3 py-2 font-semibold">{column}</th>)}</tr></thead>
            <tbody><tr>{tableColumns.map((column) => <td key={column} className="whitespace-nowrap px-3 py-2 text-slate-400">Sample {column}</td>)}</tr></tbody>
          </table>
        </div>
      </div>
      {tableColumns.length === 0 && <p className="text-rose-600">Select at least one column to insert the table.</p>}
    </div>
  </Modal>}

  <Modal
    open={Boolean(previewTemplate)}
    onClose={() => setPreviewTemplate(null)}
    title="Letter Pad Preview"
    size="lg"
    headerActions={
      <button
        type="button"
        onClick={() => {
          if (!previewTemplate) return
          handleDownloadTemplate(previewTemplate.source.template, previewTemplate.source.letter, { signature: previewTemplate.signatureOption, signatory: previewTemplate.signatoryOption })
        }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
      >
        <Printer size={13} /> Print / PDF
      </button>
    }
  >
    {previewTemplate && (
      <div className="bg-white p-2">
        {/* Paper Sheet Preview */}
        <div className="mx-auto max-w-2xl bg-white p-4 font-sans text-xs text-slate-800 space-y-4">
          {/* Paper Header — logo + address from Settings, matching the Quotation letter pad */}
          <div className="flex items-start justify-between border-b-2 border-slate-800 pb-3">
            <div className="flex flex-col items-start">
              {company.theme_logo ? (
                <img
                  src={buildApiAssetUrl(company.theme_logo)}
                  alt="Company logo"
                  className="h-14 max-w-[160px] object-contain"
                  onError={(event) => { (event.target as HTMLImageElement).style.display = 'none' }}
                />
              ) : (
                <h3 className="text-base font-black text-slate-900 tracking-tight">
                  {company.company_name || 'Company Name'}
                </h3>
              )}
            </div>
            <div className="text-right text-[10px] max-w-[45%]">
              {companyAddressLine && (
                <div className="font-semibold text-slate-700 leading-relaxed">{companyAddressLine}</div>
              )}
              {company.phone && <div className="text-slate-500">Ph: {company.phone}</div>}
              {(company.mail || company.from_email) && (
                <div className="text-slate-500">Email: {company.mail || company.from_email}</div>
              )}
            </div>
          </div>

          {/* Title centred, Date / Ref on the right of the same row */}
          <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3">
            <span />
            <div className="text-center text-sm font-bold underline text-slate-900">
              {previewTemplate.title}
            </div>
            <div className="space-y-0.5 text-right text-xs text-slate-700">
              <div><strong>Date:</strong> {previewTemplate.date || new Date().toLocaleDateString('en-GB')}</div>
              {previewTemplate.refNo && (
                <div className="font-mono"><strong>Ref:</strong> {previewTemplate.refNo}</div>
              )}
            </div>
          </div>

          {/* Recipient */}
          <div className="text-xs text-slate-700 whitespace-pre-line leading-relaxed">
            <strong>To:</strong>
            <br />
            {previewTemplate.recipientName || 'Johnathan Doe'}
            <br />
            {previewTemplate.recipientLine || 'Acme Infrastructure Ltd, Connaught Place, New Delhi'}
          </div>

          {/* Subject */}
          {previewTemplate.subject && (
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs font-bold text-slate-900 border border-slate-100">
              Subject: {previewTemplate.subject}
            </div>
          )}

          {/* Body */}
          <div
            className="min-h-[140px] text-xs leading-relaxed text-slate-800 [&_p]:mb-3 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-slate-300 [&_th]:bg-slate-50 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_td]:border [&_td]:border-slate-300 [&_td]:px-2 [&_td]:py-1.5"
            dangerouslySetInnerHTML={{ __html: previewHtml(previewTemplate.content) }}
          />

          {/* Signoff */}
          {/* Left: letter pad seal from Settings | Right: sales user details */}
          <div className="flex items-end justify-between gap-4 pt-6">
            {previewTemplate.signatureOption !== 'none' && company.letter_pad_seal ? (
              <img
                src={buildApiAssetUrl(company.letter_pad_seal)}
                alt="Seal"
                className="max-h-24 max-w-[160px] object-contain"
                onError={(event) => { (event.target as HTMLImageElement).style.display = 'none' }}
              />
            ) : <div />}
            {previewTemplate.signatoryOption === 'none' ? null : (() => {
              const signer = letterSigner(previewTemplate.source?.letter)
              return (
                <div className="text-right text-[10px] text-slate-800">
                  {signer.name && <div className="text-xs font-bold text-slate-900">{signer.name}</div>}
                  {signer.designation && <div>{signer.designation}</div>}
                  {signer.contact && <div>{signer.contact}</div>}
                </div>
              )
            })()}
          </div>
        </div>
      </div>
    )}
  </Modal>

  {/* ══════════════════════════════════════════════════════════════════════════
      CREATE / EDIT GENERATED LETTER (inline on the page, not a popup)
     ══════════════════════════════════════════════════════════════════════════ */}
  {letterModalOpen && (
  <Card hover={false}>
    <div className="space-y-4 p-5 text-xs">
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-700"><Users size={17} /></span>
          <div>
            <h4 className="font-bold text-slate-800">CRM Record</h4>
            <p className="text-[11px] text-slate-500">Select the customer record first to merge its CRM data into this letter.</p>
          </div>
        </div>
        <div className="max-w-2xl">
          <label className="mb-1.5 block text-xs font-bold text-slate-700">Customer <span className="text-rose-500">*</span></label>
          <div className="relative">
            <button id="lt-customer_id" type="button" onClick={() => setCustomerDropdownOpen((open) => !open)} aria-invalid={lv.errors.customer_id ? true : undefined} className={`flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left text-sm focus:border-indigo-400 focus:outline-none ${lv.errors.customer_id ? 'err' : ''}`}>
              <span className={letterForm.customer_id === '' ? 'text-slate-400' : 'font-medium text-slate-800'}>{letterForm.customer_id === '' ? 'Search or select a customer' : customerOptions.find((customer) => customer.id === letterForm.customer_id)?.customer_name || 'Selected customer'}</span>
              <ChevronDown size={16} className="text-slate-500" />
            </button>
            {customerDropdownOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                <input autoFocus value={customerSearch} onChange={(event) => setCustomerSearch(event.target.value)} placeholder="Search customers..." className="w-full border-b border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400" />
                <div className="max-h-56 overflow-y-auto py-1">
                  {customerOptions.filter((customer) => customer.customer_name.toLowerCase().includes(customerSearch.toLowerCase())).map((customer) => (
                    <button key={customer.id} type="button" onClick={() => {
                      setLetterForm((prev) => ({ ...prev, customer_id: customer.id }))
                      setCustomerDropdownOpen(false)
                      setCustomerSearch('')
                      applyCustomerToLetterForm(customer.id)
                    }} className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-indigo-50 hover:text-indigo-700">
                      {customer.customer_name}
                    </button>
                  ))}
                  {!customerOptions.some((customer) => customer.customer_name.toLowerCase().includes(customerSearch.toLowerCase())) && <p className="px-3 py-2 text-sm text-slate-500">No assigned customers found.</p>}
                </div>
              </div>
            )}
          </div>
          <FieldError id="lt-customer_id" msg={lv.errors.customer_id} />
          {customerLoading && <p className="mt-2 text-xs text-indigo-600">Loading CRM record…</p>}
          {letterForm.customer_id !== '' && !customerLoading && <p className="mt-2 text-xs text-emerald-700">Customer data will be merged into the fields used by this template.</p>}
        </div>
      </section>
      {/* Company details are read from Settings so every generated letter uses the approved letterhead. */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
          <div>
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700"><FileText size={15} /></span>
              <div>
                <h4 className="font-bold text-slate-800">Company Information</h4>
                <p className="text-[11px] text-slate-500">Applied automatically from your organization settings</p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Company name</p>
                <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-semibold text-slate-700">{company.company_name || 'Company name not configured'}</p>
              </div>
              <div>
                <p className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                  <MapPin size={11} /> Address
                </p>
                <p className="leading-relaxed text-slate-600">{companyAddressLine || 'Address not configured'}</p>
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-400">Region</label>
                <input id="lt-region" value={letterForm.region} onChange={(e) => setLetterForm((prev) => ({ ...prev, region: e.target.value }))} onBlur={() => letterBlur('region')} placeholder="Search or select" className={`w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none ${lv.errors.region ? 'err' : ''}`} />
                <FieldError id="lt-region" msg={lv.errors.region} />
              </div>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700"><FileText size={15} /></span>
              <div>
                <h4 className="font-bold text-slate-800">Letter Information</h4>
                <p className="text-[11px] text-slate-500">Reference and issue details for this letter</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-3">
              <div className="col-span-2">
                <label className="mb-1 block font-bold text-slate-700">Letter Description / Purpose</label>
                <textarea
                  id="lt-description"
                  value={letterForm.description}
                  onChange={(e) => setLetterForm((prev) => ({ ...prev, description: e.target.value }))}
                  onBlur={() => letterBlur('description')}
                  placeholder="Briefly describe the purpose of this letter."
                  rows={2}
                  className={`w-full resize-y rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none ${lv.errors.description ? 'err' : ''}`}
                />
                <FieldError id="lt-description" msg={lv.errors.description} />
                <p className="mt-1 text-[10px] text-slate-500">This internal note helps identify the letter later.</p>
              </div>
              <div>
                <label className="mb-1 block font-bold text-slate-700">Reference Number *</label>
                <input
                  id="lt-ref_number"
                  type="text"
                  maxLength={80}
                  value={letterForm.ref_number}
                  onChange={(e) => setLetterForm((prev) => ({ ...prev, ref_number: e.target.value }))}
                  onBlur={() => letterBlur('ref_number')}
                  aria-invalid={lv.errors.ref_number ? true : undefined}
                  placeholder="e.g. QL20260007"
                  className={`w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium focus:border-indigo-400 focus:outline-none ${lv.errors.ref_number ? 'err' : ''}`}
                />
                <FieldError id="lt-ref_number" msg={lv.errors.ref_number} />
              </div>
              <div>
                <label className="mb-1 block font-bold text-slate-700">Issue Date</label>
                <input
                  id="lt-issue_date"
                  type="date"
                  value={letterForm.issue_date}
                  onChange={(e) => setLetterForm((prev) => ({ ...prev, issue_date: e.target.value }))}
                  onBlur={() => letterBlur('issue_date')}
                  className={`w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium focus:border-indigo-400 focus:outline-none ${lv.errors.issue_date ? 'err' : ''}`}
                />
                <FieldError id="lt-issue_date" msg={lv.errors.issue_date} />
              </div>
              <div>
                <label className="mb-1 block font-bold text-slate-700">Status</label>
                <select value={letterForm.status} onChange={(e) => setLetterForm((prev) => ({ ...prev, status: e.target.value }))} className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium focus:border-indigo-400 focus:outline-none">
                  <option>Draft</option><option>Issued</option><option>Sent</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block font-bold text-slate-700">Letter Language</label>
                <select value={letterForm.language} onChange={(e) => setLetterForm((prev) => ({ ...prev, language: e.target.value }))} className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium focus:border-indigo-400 focus:outline-none">
                  <option>English</option><option>Hindi</option><option>Tamil</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </section>

      {false && <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="font-bold text-slate-800">Letter Table</h4>
            <p className="text-[11px] text-slate-500">Add an item table for this letter only. It will not modify the reusable template.</p>
          </div>
          <button
            type="button"
            onClick={() => setLetterTableBuilderOpen((open) => !open)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
          >
            <LayoutTemplate size={13} /> {letterForm.table_columns.length ? 'Edit Table' : 'Add Table'}
          </button>
        </div>
        {letterForm.table_columns.length > 0 && !letterTableBuilderOpen && (
          <p className="mt-3 rounded-lg bg-indigo-50 px-3 py-2 text-[11px] font-medium text-indigo-700">
            Table columns: {letterForm.table_columns.join(' · ')}
          </p>
        )}
        {letterTableBuilderOpen && (
          <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h5 className="text-xs font-bold text-slate-800">Quotation items table</h5>
                <p className="mt-0.5 text-[11px] text-slate-500">Choose the columns, review the table, then insert it into the letter.</p>
              </div>
              <button type="button" onClick={() => setLetterTableBuilderOpen(false)} className="text-xs font-semibold text-slate-400 hover:text-slate-700">Close</button>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {['S.No', 'Item Description', 'Qty', 'Unit Price', 'GST %', 'GST Value', 'Net Price', 'Total Price'].map((column) => {
                const selected = letterTableColumns.includes(column)
                return (
                  <button key={column} type="button" onClick={() => setLetterTableColumns((prev) => selected ? prev.filter((value) => value !== column) : [...prev, column])}
                    className={`rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${selected ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}>
                    <span className="mr-1.5">{selected ? '✓' : '○'}</span>{column}
                  </button>
                )
              })}
            </div>
            <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">Table preview</div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>{letterTableColumns.map((column) => <th key={column} className="whitespace-nowrap border-b border-slate-200 px-3 py-2 font-semibold">{column}</th>)}</tr>
                  </thead>
                  <tbody>
                    <tr>{letterTableColumns.map((column) => <td key={column} className="whitespace-nowrap px-3 py-2 text-slate-400">Sample {column}</td>)}</tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setLetterTableBuilderOpen(false)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600">Cancel</button>
              <button type="button" disabled={!letterTableColumns.length} onClick={() => {
                setLetterForm((prev) => ({ ...prev, table_columns: letterTableColumns }))
                setLetterTableBuilderOpen(false)
              }} className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">Insert Table</button>
            </div>
          </div>
        )}
      </section>}

      {showRecipientDetails && <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-50 text-violet-700"><Users size={15} /></span>
          <div>
            <h4 className="font-bold text-slate-800">Recipient Details</h4>
            <p className="text-[11px] text-slate-500">Choose a CRM customer or enter the recipient details manually</p>
          </div>
        </div>
      {(showLetterField('recipient_name', 'candidate_name', 'customer_to_name', 'contact_person') || showLetterField('recipient_email', 'candidate_email', 'email') || showLetterField('recipient_company', 'candidate_company', 'customer_name') || showLetterField('recipient_address', 'candidate_address', 'customer_address')) && <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3">
        <label className="mb-1 block font-bold text-indigo-900">Select Customer</label>
        <select
          value={letterForm.customer_id}
          onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : ''
            setLetterForm((prev) => ({ ...prev, customer_id: id }))
            if (id !== '') applyCustomerToLetterForm(id)
          }}
          className="w-full rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none"
        >
          <option value="">Choose a customer to auto-fill…</option>
          {customerOptions.map((c) => (
            <option key={c.id} value={c.id}>{c.customer_name}</option>
          ))}
        </select>
        {customerLoading && <p className="mt-1 text-[11px] text-indigo-500">Loading customer details…</p>}
        <p className="mt-1 text-[11px] text-indigo-500">Picking a customer fills the fields below from their CRM record — you can still edit them.</p>
      </div>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {showLetterField('recipient_name', 'candidate_name', 'customer_to_name', 'contact_person') && <div>
          <label className="mb-1 block font-bold text-slate-700">Recipient Name *</label>
          <input
            type="text"
            value={letterForm.recipient_name}
            onChange={(e) => setLetterForm((prev) => ({ ...prev, recipient_name: e.target.value }))}
            placeholder="e.g. Johnathan Doe"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none"
          />
        </div>}
        {showLetterField('branch') && <div>
          <label className="mb-1 block font-bold text-slate-700">Branch</label>
          <input value={letterForm.branch} onChange={(e) => setLetterForm((prev) => ({ ...prev, branch: e.target.value }))} placeholder="Search or select" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none" />
        </div>}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {showLetterField('recipient_email', 'candidate_email', 'email') && <div>
          <label className="mb-1 block font-bold text-slate-700">Recipient Email</label>
          <input
            type="email"
            value={letterForm.recipient_email}
            onChange={(e) => setLetterForm((prev) => ({ ...prev, recipient_email: e.target.value }))}
            placeholder="e.g. johnathan.doe@acmeinfra.com"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none"
          />
        </div>}
        {showLetterField('sub_branch') && <div>
          <label className="mb-1 block font-bold text-slate-700">Sub Branch</label>
          <input value={letterForm.sub_branch} onChange={(e) => setLetterForm((prev) => ({ ...prev, sub_branch: e.target.value }))} placeholder="Search or select" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none" />
        </div>}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {showLetterField('department') && <div>
          <label className="mb-1 block font-bold text-slate-700">Department</label>
          <input value={letterForm.department} onChange={(e) => setLetterForm((prev) => ({ ...prev, department: e.target.value }))} placeholder="Search or select" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none" />
        </div>}
        {showLetterField('sub_department') && <div>
          <label className="mb-1 block font-bold text-slate-700">Sub Department</label>
          <input value={letterForm.sub_department} onChange={(e) => setLetterForm((prev) => ({ ...prev, sub_department: e.target.value }))} placeholder="Search or select" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none" />
        </div>}
        {showLetterField('designation') && <div>
          <label className="mb-1 block font-bold text-slate-700">Designation</label>
          <input value={letterForm.designation} onChange={(e) => setLetterForm((prev) => ({ ...prev, designation: e.target.value }))} placeholder="Select department first" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none" />
        </div>}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {showLetterField('recipient_company', 'candidate_company', 'customer_name') && <div>
          <label className="mb-1 block font-bold text-slate-700">Recipient Company</label>
          <input
            type="text"
            value={letterForm.recipient_company}
            onChange={(e) => setLetterForm((prev) => ({ ...prev, recipient_company: e.target.value }))}
            placeholder="e.g. Acme Infrastructure Ltd"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none"
          />
        </div>}
      </div>
      {showLetterField('recipient_address', 'candidate_address', 'customer_address') && <div>
        <label className="mb-1 block font-bold text-slate-700">Recipient Address</label>
        <textarea
          value={letterForm.recipient_address}
          onChange={(e) => setLetterForm((prev) => ({ ...prev, recipient_address: e.target.value }))}
          placeholder="e.g. Connaught Place, New Delhi"
          rows={3}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none"
        />
      </div>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {showLetterField('valid_until', 'valid_until_date') && <div>
          <label className="mb-1 block font-bold text-slate-700">Valid Until</label>
          <input
            type="date"
            value={letterForm.valid_until}
            onChange={(e) => setLetterForm((prev) => ({ ...prev, valid_until: e.target.value }))}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none"
          />
        </div>}
      </div>
      {customTemplateFields.length > 0 && <div className="mt-4 border-t border-slate-100 pt-4">
        <div className="mb-3">
          <h5 className="font-bold text-slate-800">Template Fields</h5>
          <p className="text-[11px] text-slate-500">Fields configured in the selected template</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {customTemplateFields.map((field) => (
            <div key={field}>
              <label className="mb-1 block font-bold text-slate-700">{templateFieldLabel(field)}</label>
              <input
                type={field.includes('date') ? 'date' : 'text'}
                value={letterForm.template_values[field] || ''}
                onChange={(event) => setLetterForm((prev) => ({
                  ...prev,
                  template_values: { ...prev.template_values, [field]: event.target.value },
                }))}
                placeholder={`Enter ${templateFieldLabel(field).toLowerCase()}`}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none"
              />
            </div>
          ))}
        </div>
      </div>}
      </section>}
      {false && hasSelectedTemplateFields && <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="mb-4">
          <h4 className="font-bold text-slate-800">Template Fields</h4>
          <p className="text-[11px] text-slate-500">Complete the fields defined in the selected letter template.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Array.from(selectedTemplateFields).map((field) => (
            <div key={field}>
              <label className="mb-1 block font-bold text-slate-700">{templateFieldLabel(field)}</label>
              <input
                type={field.includes('date') ? 'date' : field.includes('email') ? 'email' : 'text'}
                value={templateFieldValue(field)}
                onChange={(event) => updateTemplateField(field, event.target.value)}
                placeholder={`Enter ${templateFieldLabel(field).toLowerCase()}`}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium focus:border-indigo-400 focus:outline-none"
              />
            </div>
          ))}
        </div>
      </section>}
      {false && <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-700"><Users size={17} /></span>
          <div>
            <h4 className="font-bold text-slate-800">CRM Record</h4>
            <p className="text-[11px] text-slate-500">Select the customer record to merge its CRM data into this letter.</p>
          </div>
        </div>
        <div className="max-w-2xl">
          <label className="mb-1.5 block text-xs font-bold text-slate-700">Customer <span className="text-rose-500">*</span></label>
          <select
            value={letterForm.customer_id}
            onChange={(event) => {
              const customerId = event.target.value ? Number(event.target.value) : ''
              setLetterForm((prev) => ({ ...prev, customer_id: customerId }))
              if (customerId !== '') applyCustomerToLetterForm(customerId)
            }}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm focus:border-indigo-400 focus:outline-none"
          >
            <option value="">Search or select a customer…</option>
            {customerOptions.map((customer) => <option key={customer.id} value={customer.id}>{customer.customer_name}</option>)}
          </select>
          {customerLoading && <p className="mt-2 text-xs text-indigo-600">Loading CRM record…</p>}
          {letterForm.customer_id !== '' && !customerLoading && <p className="mt-2 text-xs text-emerald-700">Customer data will be merged into the fields used by this template.</p>}
        </div>
      </section>}
      {letterForm.customer_id !== '' && openTemplate && (
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700"><FileText size={17} /></span>
              <div>
                <h4 className="font-bold text-slate-800">Letter Content</h4>
                <p className="text-[11px] text-slate-500">Generated from the selected template using this customer's data. Your edits apply only to this letter.</p>
              </div>
            </div>
            <button type="button" onClick={resetLetterContentToTemplate} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">
              <RotateCcw size={13} /> Reset to Template
            </button>
          </div>

          <div className="mb-3">
            <label className="mb-1.5 block text-xs font-bold text-slate-700">Subject</label>
            <input id="lt-letter_subject" value={letterForm.letter_subject} onChange={(event) => setLetterForm((prev) => ({ ...prev, letter_subject: event.target.value }))} onBlur={() => letterBlur('letter_subject')} placeholder="Letter subject" className={`w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium focus:border-indigo-400 focus:outline-none ${lv.errors.letter_subject ? 'err' : ''}`} />
            <FieldError id="lt-letter_subject" msg={lv.errors.letter_subject} />
          </div>

          <div className="overflow-hidden rounded-lg border border-slate-200">
            <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-600">
              <button type="button" title="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => formatLetterBody('bold')} className="editor-tool"><Bold size={13} /></button>
              <button type="button" title="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => formatLetterBody('italic')} className="editor-tool"><Italic size={13} /></button>
              <button type="button" title="Underline" onMouseDown={(event) => event.preventDefault()} onClick={() => formatLetterBody('underline')} className="editor-tool"><Underline size={13} /></button>
              <span className="mx-1 h-4 border-l border-slate-200" />
              <div className="relative">
                <button type="button" title="List options" aria-label="List options" onMouseDown={(event) => event.preventDefault()} onClick={() => setListMenuOpen((open) => !open)} className="editor-tool"><List size={14} /></button>
                {listMenuOpen && <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
                  <p className="px-1 pb-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">Bullet list</p>
                  <div className="grid grid-cols-3 gap-1 border-b border-slate-100 pb-2">
                    {[['disc', '●'], ['circle', '○'], ['square', '■']].map(([style, label]) => <button key={style} type="button" title={`${label} bullet list`} onMouseDown={(event) => event.preventDefault()} onClick={() => { applyLetterList(style as 'disc' | 'circle' | 'square'); setListMenuOpen(false) }} className="rounded border border-slate-200 py-1.5 text-sm hover:border-indigo-300 hover:bg-indigo-50">{label}</button>)}
                  </div>
                  <p className="px-1 pb-1.5 pt-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">Numbered list</p>
                  <div className="grid grid-cols-3 gap-1">
                    {[['decimal', '1.'], ['lower-roman', 'i.'], ['upper-roman', 'I.'], ['lower-alpha', 'a.'], ['upper-alpha', 'A.']].map(([style, label]) => <button key={style} type="button" title={`${label} list`} onMouseDown={(event) => event.preventDefault()} onClick={() => { applyLetterList(style as 'decimal' | 'lower-roman' | 'upper-roman' | 'lower-alpha' | 'upper-alpha'); setListMenuOpen(false) }} className="rounded border border-slate-200 py-1.5 text-[11px] font-semibold hover:border-indigo-300 hover:bg-indigo-50">{label}</button>)}
                  </div>
                </div>}
              </div>
              <span className="mx-1 h-4 border-l border-slate-200" />
              <button type="button" title="Add editable table" onMouseDown={(event) => event.preventDefault()} onClick={insertLetterTable} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"><LayoutTemplate size={13} /> Add Table</button>
              <button type="button" title="Add a row to the selected table" onMouseDown={(event) => event.preventDefault()} onClick={() => updateActiveLetterTable('row')} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700">+ Row</button>
              <button type="button" title="Add a column to the selected table" onMouseDown={(event) => event.preventDefault()} onClick={() => updateActiveLetterTable('column')} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700">+ Column</button>
              <span className="mx-1 h-4 border-l border-slate-200" />
              <button type="button" title="Delete the row with the cursor" onMouseDown={(event) => event.preventDefault()} onClick={() => updateActiveLetterTable('deleteRow')} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700">− Row</button>
              <button type="button" title="Delete the column with the cursor" onMouseDown={(event) => event.preventDefault()} onClick={() => updateActiveLetterTable('deleteColumn')} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700">− Column</button>
              <button type="button" title="Delete the cell with the cursor" onMouseDown={(event) => event.preventDefault()} onClick={() => updateActiveLetterTable('deleteCell')} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700">− Cell</button>
            </div>
            <div ref={letterBodyRef} contentEditable suppressContentEditableWarning dir="ltr" onClick={(event) => {
              const removeButton = (event.target as HTMLElement).closest('[data-letter-table-delete]')
              if (!removeButton) return
              event.preventDefault()
              removeButton.closest('.letter-table-editor-wrap')?.remove()
              if (letterBodyRef.current) { const html = cleanLetterBodyHtml(letterBodyRef.current); setLetterForm((prev) => ({ ...prev, letter_body: html })) }
            }} onInput={(event) => { const html = cleanLetterBodyHtml(event.currentTarget); setLetterForm((prev) => ({ ...prev, letter_body: html })) }} data-placeholder="Select a customer to generate the letter content." className="template-rich-editor min-h-[260px] w-full p-4 text-sm leading-7 text-slate-700 outline-none" />
            {/* Read-only sign-off, placed as in the preview: seal on the left, sales user on the right */}
            <div className="flex items-end justify-between gap-4 px-4 pb-4 pt-2" contentEditable={false}>
              {letterForm.signature_option !== 'none' && company.letter_pad_seal ? (
                <img
                  src={buildApiAssetUrl(company.letter_pad_seal)}
                  alt="Seal"
                  className="max-h-20 max-w-[140px] object-contain"
                  onError={(event) => { (event.target as HTMLImageElement).style.display = 'none' }}
                />
              ) : <div />}
              {letterForm.signatory_option === 'none' ? null : (() => {
                const signer = letterSigner(letterForm)
                return (
                  <div className="text-right text-xs text-slate-700">
                    {signer.name && <div className="text-sm font-bold text-slate-900">{signer.name}</div>}
                    {signer.designation && <div>{signer.designation}</div>}
                    {signer.contact && <div>{signer.contact}</div>}
                  </div>
                )
              })()}
            </div>
          </div>
        </section>
      )}
    </div>
  </Card>
  )}

  <Modal
    open={Boolean(emailLetter)}
    onClose={() => setEmailLetter(null)}
    title="Recipient Email"
    subtitle="Enter an email address to send this letter"
    size="sm"
    footer={
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setEmailLetter(null)}>Cancel</Button>
        <Button onClick={sendToEnteredEmail}>Send Mail</Button>
      </div>
    }
  >
    <div className="space-y-3 py-1">
      <p className="text-xs text-slate-600">
        No email address is saved for <strong>{emailLetter?.recipient_name || 'this recipient'}</strong>.
      </p>
      <div>
        <label className="mb-1 block text-xs font-bold text-slate-700">Email address</label>
        <input
          autoFocus
          id="lt-email-recipient"
          type="email"
          value={emailRecipient}
          onChange={(event) => { setEmailRecipient(event.target.value); setEmailRecipientError(event.target.value.trim() ? vEmail(event.target.value.trim()) : '') }}
          onBlur={() => setEmailRecipientError(emailRecipient.trim() ? vEmail(emailRecipient.trim()) : 'Email address is required.')}
          onKeyDown={(event) => { if (event.key === 'Enter') void sendToEnteredEmail() }}
          placeholder="name@example.com"
          aria-invalid={emailRecipientError ? true : undefined}
          className={`w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none ${emailRecipientError ? 'err !border-red-400' : ''}`}
        />
        <FieldError id="lt-email-recipient" msg={emailRecipientError} />
      </div>
    </div>
  </Modal>

  {/* ══════════════════════════════════════════════════════════════════════════
      MODAL: CONFIRM DELETE LETTER
     ══════════════════════════════════════════════════════════════════════════ */}
  <Modal
    open={Boolean(confirmDeleteLetter)}
    onClose={() => setConfirmDeleteLetter(null)}
    title="Delete Letter"
    subtitle="The letter can be restored from the Recycle Bin"
    size="sm"
    footer={
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => setConfirmDeleteLetter(null)}>
          Cancel
        </Button>
        <button
          onClick={handleDeleteLetter}
          className="inline-flex items-center gap-1 px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg transition-colors shadow-xs"
        >
          Delete Letter
        </button>
      </div>
    }
  >
    <div className="py-2 text-xs text-slate-600 space-y-2">
      <div className="flex items-center gap-2 text-rose-600 font-bold">
        <AlertTriangle size={16} /> Are you sure?
      </div>
      {confirmDeleteLetter && (
        <p>
          Letter <strong>{confirmDeleteLetter.ref_number}</strong> for{' '}
          <strong>{confirmDeleteLetter.recipient_name}</strong> will be moved to the Recycle Bin. You can restore it from there.
        </p>
      )}
    </div>
  </Modal>
</div>

)
}

// ─── Letter Preview / Download Icon Pair ────────────────────────────────────
// Mirrors DocumentManagementPage's DocumentIconGroup so both tables share the
// same preview (blue) + download (emerald) icon pattern.

function LetterIconGroup({
templateName,
onPreview,
onDownload,
onEdit,
}: {
templateName: string
onPreview: () => void
onDownload: () => void
onEdit?: () => void
}) {
return (
<div onClick={(e) => e.stopPropagation()} className="flex w-full items-center justify-center gap-1.5">
<button
type="button"
onClick={onPreview}
title="Preview letter"
aria-label={`Preview ${templateName}`}
className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50 text-blue-600 transition-all hover"
>
<FileText size={14} />
</button>
<button
type="button"
onClick={onDownload}
title="Download letter"
aria-label={`Download ${templateName}`}
className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 transition-all hover"
>
<Download size={14} />
</button>
{onEdit && (
<button
type="button"
onClick={onEdit}
title="Edit template"
aria-label={`Edit ${templateName}`}
className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-indigo-600 transition-all hover"
>
<Pencil size={13} />
</button>
)}
</div>
)
}

// ─── Row Actions Menu ───────────────────────────────────────────────────────

interface TemplateActionsMenuProps {
templateName: string
onPreview: () => void
onDuplicate?: () => void
onDelete?: () => void
}

const PANEL_WIDTH = 176

function TemplateActionsMenu({ templateName, onPreview, onDuplicate, onDelete }: TemplateActionsMenuProps) {
const [open, setOpen] = useState(false)
const [pos, setPos] = useState({ top: 0, left: 0 })
const btnRef = useRef<HTMLButtonElement>(null)
const panelRef = useRef<HTMLDivElement>(null)

const items = [
{ label: 'Preview', icon: Eye, tone: 'text-indigo-600', onClick: onPreview },
...(onDuplicate ? [{ label: 'Duplicate', icon: Copy, tone: 'text-slate-600', onClick: onDuplicate }] : []),
...(onDelete ? [{ label: 'Move to Trash', icon: Trash2, tone: 'text-rose-600', onClick: onDelete }] : []),
]

const reposition = () => {
if (!btnRef.current) return
const r = btnRef.current.getBoundingClientRect()
const top = r.bottom + window.scrollY + 4
const left = Math.max(8, Math.min(r.right + window.scrollX - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8))
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

const panel = (
<div
ref={panelRef}
onMouseDown={(e) => e.stopPropagation()}
style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_WIDTH, zIndex: 100140 }}
className="overflow-hidden rounded-xl border border-slate-100 bg-white p-1 shadow-[0_8px_40px_rgba(0,0,0,0.15)]"
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
className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold transition-colors hover:bg-slate-50 ${item.tone}`}
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
aria-label={`More actions for ${templateName}`}
className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
          open ? 'bg-slate-100 text-slate-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'
        }`}
>
<MoreVertical size={15} />
</button>
{open && createPortal(panel, document.body)}
</div>
)
}
