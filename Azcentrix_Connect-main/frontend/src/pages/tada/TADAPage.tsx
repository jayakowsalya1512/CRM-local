import { useState, useEffect, useRef } from 'react'
import {
  Receipt, Plus, CheckCircle, XCircle, DollarSign, Clock,
  Upload, File, FileText, FileSpreadsheet, Image as ImageIcon,
  Eye, X, ExternalLink, Crown, UserCheck, Loader2,
  ChevronRight, Trash2, AlertTriangle, AlertCircle,
  FileCheck, IndianRupee, Shield, RefreshCw,
} from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import SlidePanel from '@/components/ui/SlidePanel'
import Input from '@/components/ui/Input'
import {
  PageHeader, StatCard, useToast,
  DatePicker, FormGrid,
} from '@/components/ui/FormComponents'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { useAuthStore, useUIStore } from '@/store'
import { usePermissions } from '@/hooks/Usepermissions'
import DropFileUpload from '@/components/ui/DropFileUpload'
import TravelModuleTabs from '@/pages/travel/TravelModuleTabs'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { apiFieldErrors, todayISO, validate, type FieldSpec } from '@/utils/validation'

// Field rules for the TA/DA claim form (backend twin: travel_router.TADAClaimCreate / TADALineItemIn).
const MAX_AMT = 9999999999.99
const tadaSpecs = (): Record<string, FieldSpec> => ({
  claim_date: { label: 'Claim Date', rule: 'date', required: true, maxDate: todayISO(), dateLabel: { max: 'today' } },
  travel_date_from: { label: 'Travel Date From', rule: 'date' },
  travel_date_to: { label: 'Travel Date To', rule: 'date' },
  from_city: { label: 'From City', rule: 'text', required: true, min: 2, max: 100 },
  to_city: { label: 'To City', rule: 'text', required: true, min: 2, max: 100 },
  purpose: { label: 'Purpose', rule: 'text', required: true, min: 3, max: 500 },
  advance_taken: { label: 'Advance Taken', rule: 'amount', max: MAX_AMT },
  da_rate_per_day: { label: 'DA Rate / Day', rule: 'amount', max: MAX_AMT },
  cost_center: { label: 'Cost Center', rule: 'text', max: 100 },
  budget_code: { label: 'Budget Code', rule: 'text', max: 100 },
  department: { label: 'Department', rule: 'text', max: 100 },
  notes: { label: 'Notes', rule: 'textarea', max: 5000 },
  declaration: { label: 'Employee declaration confirmation', rule: 'checkbox', required: true },
})
const tadaCross = (k: string, f: any): string => {
  if (k === 'travel_date_to' && f.travel_date_from && f.travel_date_to && f.travel_date_to < f.travel_date_from)
    return 'Travel Date To cannot be before Travel Date From.'
  return ''
}
const TADA_ITEM_SPECS: Record<string, FieldSpec> = {
  expense_date: { label: 'Expense Date', rule: 'date', required: true, maxDate: todayISO(), dateLabel: { max: 'today' } },
  category: { label: 'Category', rule: 'select', required: true },
  amount: { label: 'Amount', rule: 'amount', required: true, min: 0, max: MAX_AMT },
  description: { label: 'Description', rule: 'text', required: true, min: 2, max: 500 },
  from_place: { label: 'From Place', rule: 'text', max: 100 },
  to_place: { label: 'To Place', rule: 'text', max: 100 },
  receipt_number: { label: 'Receipt / Bill No.', rule: 'text', max: 100 },
  vendor_name: { label: 'Vendor / Payee', rule: 'text', max: 200 },
}
const tadaItemMsg = (field: string, item: any): string => {
  const sp = TADA_ITEM_SPECS[field]
  const m = sp ? validate(item[field], sp) : ''
  if (m) return m
  if (field === 'amount' && String(item.amount ?? '').trim() !== '' && Number(item.amount) <= 0) return 'Amount must be greater than 0.'
  return ''
}

// ─── Number to words (Indian system) ─────────────────────────────────────────
const numberToWords = (num: number): string => {
  if (!num || isNaN(num)) return ''
  const a = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen',
    'Seventeen','Eighteen','Nineteen']
  const b = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety']
  const inWords = (n: number): string => {
    if (n < 20)       return a[n]
    if (n < 100)      return b[Math.floor(n / 10)] + (n % 10 ? ' ' + a[n % 10] : '')
    if (n < 1000)     return a[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + inWords(n % 100) : '')
    if (n < 100000)   return inWords(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + inWords(n % 1000) : '')
    if (n < 10000000) return inWords(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + inWords(n % 100000) : '')
    return inWords(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + inWords(n % 10000000) : '')
  }
  return inWords(Math.floor(num)).trim() + ' Only'
}

// ─── Constants ────────────────────────────────────────────────────────────────
const EXPENSE_CATEGORIES = [
  'Transport Fare', 'Auto / Cab', 'Fuel', 'Accommodation',
  'Meals', 'Daily Allowance', 'Communication', 'Toll / Parking', 'Miscellaneous',
]
const DOC_TYPES = ['Receipt', 'Invoice', 'Ticket', 'Hotel Bill', 'Other']
const CLAIM_TYPES = [
  { value: 'travel',          label: 'Travel Expenses' },
  { value: 'daily_allowance', label: 'Daily Allowance' },
  { value: 'mixed',           label: 'Travel + Daily Allowance' },
  { value: 'local',           label: 'Local Conveyance' },
]
const PAYMENT_MODES = [
  { value: 'self_pay',     label: 'Self-pay (reimburse later)' },
  { value: 'company_card', label: 'Company credit card' },
  { value: 'cash_advance', label: 'Cash advance' },
  { value: 'direct',       label: 'Direct vendor payment' },
]
const TRANSPORT_MODE_OPTIONS = [
  { value: 'own_vehicle', label: 'Own Vehicle' },
  { value: 'company_car', label: 'Company Car' },
  { value: 'flight',      label: 'Flight' },
  { value: 'train',       label: 'Train' },
  { value: 'bus',         label: 'Bus' },
  { value: 'taxi_cab',    label: 'Taxi / Cab' },
  { value: 'bike',        label: 'Bike' },
  { value: 'other',       label: 'Other' },
]
const ALLOWED_MIME = [
  'application/pdf','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv','image/jpeg','image/png','image/gif','image/webp','image/bmp',
]
const MODE_LABEL: Record<string, string> = {
  own_vehicle: 'Own Vehicle', company_car: 'Company Car', flight: 'Flight',
  train: 'Train', bus: 'Bus', taxi_cab: 'Taxi / Cab', bike: 'Bike', other: 'Other',
}

// ─── Status config ────────────────────────────────────────────────────────────
const STATUS_STEPS: Record<string, number> = {
  Draft: 0, Submitted: 1, 'Manager Approved': 2,
  'CEO Approved': 3, 'Accounts Approved': 4, Paid: 5, Rejected: -1,
}
const STATUS_CFG: Record<string, { pill: string; bar: string; dot: string }> = {
  Draft:               { pill: 'bg-slate-100 text-slate-600 border-slate-200',      bar: 'bg-slate-300',   dot: 'bg-slate-400'   },
  Submitted:           { pill: 'bg-amber-50 text-amber-700 border-amber-200',        bar: 'bg-amber-400',   dot: 'bg-amber-400'   },
  'Manager Approved':  { pill: 'bg-blue-50 text-blue-700 border-blue-200',           bar: 'bg-blue-500',    dot: 'bg-blue-500'    },
  'CEO Approved':      { pill: 'bg-violet-50 text-violet-700 border-violet-200',     bar: 'bg-violet-500',  dot: 'bg-violet-500'  },
  'Accounts Approved': { pill: 'bg-emerald-50 text-emerald-700 border-emerald-200',  bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
  Paid:                { pill: 'bg-emerald-100 text-emerald-800 border-emerald-300', bar: 'bg-emerald-600', dot: 'bg-emerald-600' },
  Rejected:            { pill: 'bg-red-50 text-red-600 border-red-200',              bar: 'bg-red-400',     dot: 'bg-red-500'     },
}

// ─── File helpers ─────────────────────────────────────────────────────────────
function getFileType(path: string): 'pdf' | 'image' | 'excel' | 'word' | 'other' {
  const ext = (path?.split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (['jpg','jpeg','png','gif','webp','bmp'].includes(ext)) return 'image'
  if (['xlsx','xls','csv','xlsm'].includes(ext)) return 'excel'
  if (['doc','docx'].includes(ext)) return 'word'
  return 'other'
}
function getPreviewUrl(rawPath: string): string {
  if (!rawPath) return ''
  const envBase: string = (import.meta as any).env?.VITE_API_BASE_URL || ''
  const axiosBase: string = (api as any).defaults?.baseURL || ''
  const apiBase = (envBase || axiosBase || `${window.location.origin}/api/v1`).replace(/\/$/, '')
  const filePath = rawPath.startsWith('http') ? new URL(rawPath).pathname : rawPath
  const token = localStorage.getItem('access_token') || localStorage.getItem('token') || ''
  const tenant = localStorage.getItem('tenant_slug') || ''
  const params = new URLSearchParams({ path: filePath })
  if (token) params.set('token', token)
  if (tenant) params.set('tenant', tenant)
  return `${apiBase}/preview/file?${params.toString()}`
}
// ─── StatusPill ───────────────────────────────────────────────────────────────
function StatusPill({ status }: { status: string }) {
  const c = STATUS_CFG[status] || STATUS_CFG.Draft
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full border ${c.pill}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {status}
    </span>
  )
}

// ─── WorkflowBar ──────────────────────────────────────────────────────────────
function WorkflowBar({ status }: { status: string }) {
  const step  = STATUS_STEPS[status] ?? 0
  const isRej = status === 'Rejected'
  const steps = [
    { label: 'Draft', short: 'D' }, { label: 'Submitted', short: 'S' },
    { label: 'Manager', short: 'M' }, { label: 'CEO', short: 'C' },
    { label: 'Accounts', short: 'A' }, { label: 'Paid', short: 'P' },
  ]
  return (
    <div className="flex items-center gap-1">
      {steps.map((s, i) => {
        const done    = !isRej && i < step
        const current = !isRej && i === step
        return (
          <div key={s.label} className="flex items-center gap-1">
            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold transition-all
              ${done    ? 'bg-emerald-500 text-white' :
                current ? 'bg-blue-600 text-white ring-2 ring-blue-200' :
                isRej && i === 0 ? 'bg-red-400 text-white' :
                'bg-slate-100 text-slate-400'}`}>
              {done ? '✓' : s.short}
            </div>
            {i < steps.length - 1 && <div className={`h-px w-3 ${done ? 'bg-emerald-400' : 'bg-slate-200'}`} />}
          </div>
        )
      })}
    </div>
  )
}

// ─── FileIcon ─────────────────────────────────────────────────────────────────
function FileIcon({ type }: { type: string }) {
  const map: Record<string, React.ReactNode> = {
    pdf:   <FileText        size={11} className="text-red-400" />,
    image: <ImageIcon       size={11} className="text-blue-400" />,
    excel: <FileSpreadsheet size={11} className="text-emerald-500" />,
    word:  <FileText        size={11} className="text-blue-600" />,
    other: <File            size={11} className="text-slate-400" />,
  }
  return <>{map[type] ?? <File size={11} className="text-slate-400" />}</>
}

// ─── FilePreviewModal ─────────────────────────────────────────────────────────
function FilePreviewModal({ file, onClose }: { file: any; onClose: () => void }) {
  if (!file) return null
  const rawPath    = file.preview_url || file.file_url || ''
  const fileType   = getFileType(rawPath)
  const previewUrl = getPreviewUrl(rawPath)
  const directUrl  = previewUrl
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center">
              <FileIcon type={fileType} />
            </div>
            <div>
              <p className="font-semibold text-slate-800 text-sm truncate max-w-[360px]">{file.file_name}</p>
              <p className="text-xs text-slate-400">{file.doc_type}{file.file_size_kb ? ` · ${file.file_size_kb} KB` : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href={directUrl} target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 bg-blue-50 px-3 py-1.5 rounded-lg font-medium transition-colors">
              <ExternalLink size={12} />Open
            </a>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 transition-colors"><X size={15} /></button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-slate-50 flex items-center justify-center min-h-[400px]">
          {fileType === 'image' && <img src={previewUrl} alt={file.file_name} className="max-w-full max-h-[72vh] object-contain rounded-xl m-4 shadow-sm" />}
          {['pdf','excel','word'].includes(fileType) && <iframe src={previewUrl} title={file.file_name} className="w-full h-[72vh] border-none bg-white" />}
          {fileType === 'other' && (
            <div className="text-center py-16 px-8">
              <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
                <File size={28} className="text-slate-300" />
              </div>
              <p className="text-slate-700 font-semibold mb-1">{file.file_name}</p>
              <a href={directUrl} target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-2 bg-blue-600 text-white px-6 py-2.5 rounded-xl text-sm font-semibold mt-4 hover:bg-blue-700 transition-colors">
                <ExternalLink size={14} />Open File
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── AttachChip ───────────────────────────────────────────────────────────────
function AttachChip({ file, onPreview, onDelete, canDelete }: {
  file: any; onPreview: () => void; onDelete?: () => void; canDelete?: boolean
}) {
  const ft = getFileType(file.file_url || '')
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs group hover:border-blue-300 hover:shadow-sm transition-all">
      <FileIcon type={ft} />
      <button onClick={onPreview} className="text-slate-600 hover:text-blue-700 max-w-[110px] truncate font-medium">{file.file_name}</button>
      <button onClick={onPreview} className="text-slate-300 hover:text-blue-400 flex-shrink-0 transition-colors"><Eye size={10} /></button>
      {canDelete && onDelete && (
        <button onClick={onDelete} className="text-slate-200 hover:text-red-500 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-all ml-0.5">
          <Trash2 size={10} />
        </button>
      )}
    </div>
  )
}

// ─── CollapsibleSection ───────────────────────────────────────────────────────
function CollapsibleSection({
  title, icon, children, defaultOpen = true, badge, action,
}: {
  title: string; icon: React.ReactNode; children: React.ReactNode
  defaultOpen?: boolean; badge?: string; action?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
      <div onClick={() => setOpen(o => !o)}
        className="flex items-center gap-3 px-5 py-3.5 bg-white hover:bg-slate-50 cursor-pointer transition-colors border-b border-slate-100">
        <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
          <span className="text-blue-500 flex items-center">{icon}</span>
        </div>
        <span className="text-sm font-semibold text-slate-800 flex-1">{title}</span>
        {badge && <span className="text-[10px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-semibold">{badge}</span>}
        {action && <div onClick={e => e.stopPropagation()}>{action}</div>}
        <div className={`text-slate-400 transition-transform duration-200 text-[10px] ${open ? 'rotate-180' : ''}`}>▼</div>
      </div>
      {open && <div className="p-5 space-y-4 bg-white">{children}</div>}
    </div>
  )
}

// ─── LockedField ──────────────────────────────────────────────────────────────
function LockedField({ label, value, required = false }: { label: string; value: string; required?: boolean }) {
  return (
    <div>
      <label className="text-xs font-semibold text-slate-500 mb-1.5 flex items-center gap-1.5">
        {label}{required && <span className="text-red-500">*</span>}
        <span className="text-[10px] text-blue-500 bg-blue-50 border border-blue-100 px-1.5 py-0.5 rounded-full font-medium">Auto-filled</span>
      </label>
      <div className="w-full px-3 py-2.5 text-sm border border-blue-100 rounded-xl bg-blue-50/50 text-slate-700 flex items-center gap-2 min-h-[40px]">
        <span className="text-blue-300 flex-shrink-0">🔒</span>
        <span className="font-medium">{value || '—'}</span>
      </div>
    </div>
  )
}

// ─── RLabel ───────────────────────────────────────────────────────────────────
function RLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-xs font-semibold text-slate-600 mb-1.5 block">
      {children}&nbsp;<span className="text-red-400">*</span>
    </label>
  )
}

function extractErrorMessage(e: any): string {
  const detail = e?.response?.data?.detail
  if (e?.response?.status === 413) return 'Storage limit exceeded.'
  if (typeof detail === 'string') {
    return detail.toLowerCase().startsWith('storage limit exceeded')
      ? 'Storage limit exceeded.'
      : detail
  }
  return e?.message || 'Upload failed'
}

// ─── LineItemUploadZone ───────────────────────────────────────────────────────
function LineItemUploadZone({ claimId, lineItemId, savedAttachments, onUploaded, onDeleted, canEdit, canDelete, onPreview }: {
  claimId: number; lineItemId: number; savedAttachments: any[]
  onUploaded: (att: any) => void; onDeleted: (attId: number) => void
  canEdit: boolean; canDelete: boolean; onPreview: (f: any) => void
}) {
  const [uploading, setUploading]         = useState(false)
  const [selectedDocType, setSelectedDocType] = useState('Receipt')
  const { error: showError } = useToast()
  const hasProof = savedAttachments.length > 0

  const handleFile = async (file: File) => {
    if (!ALLOWED_MIME.includes(file.type)) { showError('File type not allowed.'); return }
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await api.post(
        `/travel/tada/${claimId}/line-items/${lineItemId}/attachments?doc_type=${selectedDocType}`,
        fd, { headers: { 'Content-Type': 'multipart/form-data' } },
      )
      onUploaded(r.data)
    } catch (e: any) { showError(extractErrorMessage(e)) }
    finally { setUploading(false) }
  }

  return (
    <div className={`rounded-xl border p-3 transition-all ${hasProof ? 'border-emerald-200 bg-emerald-50/40' : 'border-red-200 bg-red-50/30'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        {savedAttachments.map((att: any) => (
          <AttachChip key={att.id || att.file_url} file={att} onPreview={() => onPreview(att)} onDelete={() => onDeleted(att.id)} canDelete={canDelete} />
        ))}
        {!hasProof && <span className="text-[10px] text-red-500 flex items-center gap-1 font-semibold"><AlertCircle size={10} />Proof required</span>}
        {canEdit && (
          <>
            <select value={selectedDocType} onChange={e => setSelectedDocType(e.target.value)}
              className="text-[10px] border border-slate-200 rounded-lg px-2 py-1 focus:outline-none bg-white text-slate-600">
              {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
            <div className="min-w-[220px] flex-1">
              <DropFileUpload
                label={`Drop ${selectedDocType.toLowerCase()} or click to upload`}
                accept={ALLOWED_MIME.join(',')}
                uploading={uploading}
                disabled={!canEdit}
                onFile={handleFile}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── LocalFileZone ────────────────────────────────────────────────────────────
function LocalFileZone({ files, onAdd, onRemove }: {
  files: any[]; onAdd: (att: any) => void | Promise<void>; onRemove: (i: number) => void
}) {
  const [selectedDocType, setSelectedDocType] = useState('Receipt')
  const { error: showError } = useToast()
  const hasProof = files.length > 0

  return (
    <div className={`rounded-xl border p-3 transition-all ${hasProof ? 'border-emerald-200 bg-emerald-50/40' : 'border-dashed border-red-200 bg-red-50/20'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        {files.map((att: any, i: number) => (
          <div key={i} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-[11px] text-slate-600 shadow-sm">
            <File size={9} className="text-blue-400" />
            <span className="max-w-[100px] truncate font-medium">{att.file_name}</span>
            <span className="text-slate-300">·</span>
            <span className="text-slate-400">{att.doc_type}</span>
            <button onClick={() => onRemove(i)} className="text-slate-300 hover:text-red-500 ml-0.5 transition-colors"><X size={9} /></button>
          </div>
        ))}
        {!hasProof && <span className="text-[10px] text-red-400 flex items-center gap-1"><AlertCircle size={9} />No proof attached</span>}
        <select value={selectedDocType} onChange={e => setSelectedDocType(e.target.value)}
          className="text-[10px] border border-slate-200 rounded-lg px-2 py-1 focus:outline-none bg-white text-slate-600">
          {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
        </select>
        <div className="min-w-[220px] flex-1">
          <DropFileUpload
            label={`Drop ${selectedDocType.toLowerCase()} or click to attach`}
            accept={ALLOWED_MIME.join(',')}
            onFile={async (f) => {
              if (!ALLOWED_MIME.includes(f.type)) { showError('File type not allowed'); return }
              try {
                await onAdd({ file: f, doc_type: selectedDocType, file_name: f.name, _local: true })
              } catch (e: any) {
                showError(extractErrorMessage(e))
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}

// ─── ClaimDetailModal ─────────────────────────────────────────────────────────
function ClaimDetailModal({ claim: initialClaim, onClose, onAction, saving, userRole, canUpdate, canDeleteAttachment }: {
  claim: any; onClose: () => void
  onAction: (action: string, claimId: number, data: any) => void
  saving: boolean; userRole: string; canUpdate: boolean; canDeleteAttachment: boolean
}) {
  const [claim, setClaim]             = useState<any>(initialClaim)
  const [previewFile, setPreviewFile] = useState<any>(null)
  const [decision, setDecision]       = useState('')
  const [notes, setNotes]             = useState('')
  const [rejReason, setRejReason]     = useState('')

  useEffect(() => {
    if (!initialClaim?.id) return
    api.get('/travel/tada').then(r => {
      const fresh = (r.data as any[]).find((c: any) => c.id === initialClaim.id)
      if (fresh) setClaim(fresh)
    }).catch(() => {})
  }, [initialClaim?.id])

  if (!claim) return null
  const status = claim.overall_status as string
  const isManager  = ['manager','vp','admin'].includes(userRole)
  const isCeo      = ['ceo','admin'].includes(userRole)
  const isAccounts = ['accounts','admin'].includes(userRole)
  const canManagerDecide = isManager  && status === 'Submitted'
  const canCeoDecide     = isCeo      && status === 'Manager Approved'
  const canAccountsProc  = isAccounts && status === 'CEO Approved'
  const canUploadStage   = ['Draft','Submitted','Manager Approved','Rejected'].includes(status)
  const canUpload        = canUpdate && canUploadStage

  const handleUploaded = (lineItemId: number, att: any) => {
    setClaim((prev: any) => ({
      ...prev,
      line_items: prev.line_items.map((li: any) =>
        li.id === lineItemId ? { ...li, attachments: [...(li.attachments || []), att] } : li
      ),
    }))
  }
  const handleDeleted = async (lineItemId: number, attId: number) => {
    try {
      await api.delete(`/travel/tada/${claim.id}/attachments/${attId}`)
      setClaim((prev: any) => ({
        ...prev,
        line_items: prev.line_items.map((li: any) =>
          li.id === lineItemId ? { ...li, attachments: (li.attachments || []).filter((a: any) => a.id !== attId) } : li
        ),
      }))
    } catch {}
  }

  const totalAtts    = (claim.line_items || []).reduce((s: number, li: any) => s + (li.attachments || []).length, 0)
  const perItemProof = claim.line_items?.every((li: any) => (li.attachments || []).length > 0) ?? false
  const allHaveProof = perItemProof || (totalAtts > 0 && totalAtts >= (claim.line_items?.length || 0))
  const cfg = STATUS_CFG[status] || STATUS_CFG.Draft

  return (
    <>
      {previewFile && <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
      <SlidePanel open={true} onClose={onClose} title={claim.claim_number}
        subtitle={<WorkflowBar status={status} />}
        width="w-full" insetLeft="var(--sidebar-w, 220px)"
        footer={
          <>
            <button onClick={onClose} className="flex-1 py-2.5 text-sm rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium transition-colors">
              Close
            </button>
            {(canManagerDecide || canCeoDecide || canAccountsProc) && decision && (
              <button onClick={() => onAction(decision, claim.id, { notes, rejection_reason: rejReason })}
                disabled={saving || (decision === 'rejected' && !rejReason.trim())}
                className={`flex-1 py-2.5 text-sm rounded-xl font-semibold text-white disabled:opacity-40 flex items-center justify-center gap-2 transition-colors
                  ${decision === 'rejected' ? 'bg-red-600 hover:bg-red-700' :
                    decision === 'paid'     ? 'bg-emerald-600 hover:bg-emerald-700' :
                    'bg-blue-600 hover:bg-blue-700'}`}>
                {saving && <Loader2 size={14} className="animate-spin" />}
                Confirm {decision.charAt(0).toUpperCase() + decision.slice(1)}
              </button>
            )}
          </>
        }
      >
        <div className="space-y-5">
          {/* Summary card */}
          <div className="rounded-2xl border border-slate-100 bg-gradient-to-br from-slate-50 to-blue-50/30 p-5">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <StatusPill status={status} />
                  <span className="text-xs text-slate-400 font-medium">{claim.claim_date}</span>
                </div>
                <p className="text-base font-bold text-slate-800">{claim.purpose || '—'}</p>
                {claim.from_city && claim.to_city && (
                  <p className="text-xs text-slate-500 mt-0.5">{claim.from_city} → {claim.to_city}</p>
                )}
              </div>
              <div className={`w-1.5 self-stretch rounded-full ${cfg.bar}`} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Total Expenses', val: claim.total_amount, cls: 'text-slate-800', bg: 'bg-white' },
                { label: 'Advance Taken',  val: claim.advance_taken, cls: 'text-amber-600', bg: 'bg-amber-50/60' },
                { label: 'Net Payable',    val: claim.net_payable,   cls: 'text-emerald-700 text-base', bg: 'bg-emerald-50/60' },
              ].map(({ label, val, cls, bg }) => (
                <div key={label} className={`${bg} rounded-xl p-3.5 text-center border border-white/80 shadow-sm`}>
                  <p className={`text-sm font-bold ${cls}`}>₹{Number(val).toLocaleString('en-IN')}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5 font-medium">{label}</p>
                </div>
              ))}
            </div>
            {Number(claim.net_payable) > 0 && (
              <p className="text-[11px] text-slate-400 text-center mt-2 italic">
                {numberToWords(Math.round(Number(claim.net_payable)))}
              </p>
            )}
          </div>

          {!allHaveProof && canUpload && (
            <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5 text-red-500" />
              <span className="font-medium">Every expense item needs at least one proof document before submission.</span>
            </div>
          )}

          {claim.line_items?.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Expense Items ({claim.line_items.length})</p>
                {canUpload && <span className="text-[10px] text-red-500 font-medium">Attach proof for each item</span>}
              </div>
              {claim.line_items.map((item: any, i: number) => {
                const hasProof = (item.attachments || []).length > 0
                return (
                  <div key={item.id || i} className={`bg-white border rounded-xl overflow-hidden transition-all ${hasProof ? 'border-emerald-200' : 'border-red-100'}`}>
                    <div className="flex items-center justify-between px-4 py-3 bg-slate-50/60 border-b border-slate-100">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-semibold text-slate-800 truncate">{item.description}</p>
                          {hasProof
                            ? <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-semibold flex items-center gap-0.5 flex-shrink-0"><CheckCircle size={9} />Proof</span>
                            : <span className="text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full font-semibold flex items-center gap-0.5 flex-shrink-0"><AlertCircle size={9} />Missing</span>
                          }
                        </div>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          {item.category} · {item.expense_date}
                          {item.from_place && item.to_place && ` · ${item.from_place} → ${item.to_place}`}
                        </p>
                      </div>
                      <p className="text-sm font-bold text-slate-800 ml-3 flex-shrink-0">₹{Number(item.amount).toLocaleString('en-IN')}</p>
                    </div>
                    <div className="px-4 py-3">
                      <LineItemUploadZone claimId={claim.id} lineItemId={item.id}
                        savedAttachments={item.attachments || []}
                        onUploaded={att => handleUploaded(item.id, att)}
                        onDeleted={attId => handleDeleted(item.id, attId)}
                        canEdit={canUpload} canDelete={canDeleteAttachment && canUploadStage} onPreview={setPreviewFile} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {(canManagerDecide || canCeoDecide || canAccountsProc) && (
            <div className="border border-slate-200 rounded-2xl p-4 space-y-3 bg-slate-50/50">
              <p className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 uppercase tracking-wide">
                {canCeoDecide     && <Crown      size={12} className="text-amber-500" />}
                {canManagerDecide && <UserCheck  size={12} className="text-blue-500" />}
                {canAccountsProc  && <DollarSign size={12} className="text-emerald-500" />}
                {canManagerDecide ? 'Manager Decision' : canCeoDecide ? 'CEO Decision' : 'Accounts Processing'}
              </p>
              <div className="flex gap-2">
                {(canManagerDecide || canCeoDecide) && ['approved','rejected'].map(d => (
                  <button key={d} onClick={() => setDecision(d)}
                    className={`flex-1 py-2.5 text-xs font-semibold rounded-xl border-2 transition-all
                      ${decision === d
                        ? d === 'approved' ? 'bg-emerald-500 text-white border-emerald-500 shadow-sm' : 'bg-red-500 text-white border-red-500 shadow-sm'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300 bg-white'}`}>
                    {d === 'approved' ? '✔ Approve' : '✖ Reject'}
                  </button>
                ))}
                {canAccountsProc && ['approved','paid','rejected'].map(d => (
                  <button key={d} onClick={() => setDecision(d)}
                    className={`flex-1 py-2.5 text-[11px] font-semibold rounded-xl border-2 transition-all
                      ${decision === d
                        ? d === 'paid'     ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                        : d === 'approved' ? 'bg-blue-500 text-white border-blue-500 shadow-sm'
                        : 'bg-red-500 text-white border-red-500 shadow-sm'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300 bg-white'}`}>
                    {d === 'paid' ? '💰 Mark Paid' : d === 'approved' ? '✔ Approve' : '✖ Reject'}
                  </button>
                ))}
              </div>
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                placeholder="Notes / comments (optional)…"
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl resize-none focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 bg-white transition-all" />
              {decision === 'rejected' && (
                <textarea value={rejReason} onChange={e => setRejReason(e.target.value)} rows={2}
                  placeholder="Rejection reason (required) *"
                  className="w-full px-3 py-2.5 text-sm border border-red-200 rounded-xl resize-none focus:outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 bg-white transition-all" />
              )}
            </div>
          )}
        </div>
      </SlidePanel>
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════
export default function TADAPage() {
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore()
  const [claims,         setClaims]         = useState<any[]>([])
  const [loading,        setLoading]        = useState(true)
  const [panelOpen,      setPanelOpen]      = useState(false)
  const [saving,         setSaving]         = useState(false)
  const [selected,       setSelected]       = useState<any>(null)
  const [travelRequests, setTravelRequests] = useState<any[]>([])
  const [newClaimId,     setNewClaimId]     = useState<number | null>(null)
  const sidebarWasCollapsed = useRef(false)
  const { success, error: showError } = useToast()
  const { user } = useAuthStore()
  const { can } = usePermissions()

  const emptyItem = () => ({
    _key: Math.random().toString(36).slice(2),
    expense_date: '', category: 'Transport Fare', description: '', amount: '',
    from_place: '', to_place: '', receipt_number: '', vendor_name: '',
    _localAttachments: [] as any[],
  })

  const EMPTY_FORM = {
    travel_request_id: null, claim_date: '', travel_date_from: '', travel_date_to: '',
    purpose: '', advance_taken: 0, notes: '', line_items: [emptyItem()],
    claim_type: 'travel', from_city: '', to_city: '', num_days: '',
    mode_of_travel: '', da_rate_per_day: '', payment_mode: 'self_pay',
    cost_center: '', budget_code: '', department: '', declaration: false,
  }

  const [form, setForm] = useState<any>(EMPTY_FORM)
  // ── field validation: format errors while typing, "required" once a field was left, everything on save ──
  const fe = useFieldErrors()
  const ferr = fe.errors
  const tadaMsg = (k: string, f: any): string => {
    const sp = tadaSpecs()[k]
    return (sp ? validate(f[k], sp) : '') || tadaCross(k, f)
  }
  const checkTada = (k: string, f: any, mode: 'change' | 'blur') => {
    const sp = tadaSpecs()[k]
    if (!sp) return
    if (mode === 'change') fe.change(k, f[k], sp); else fe.blur(k, f[k], sp)
    const x = tadaCross(k, f)
    if (x && !validate(f[k], sp)) fe.setError(k, x)
  }
  const setF = (k: string, v: any) => {
    setForm((p: any) => ({ ...p, [k]: v }))
    const next = { ...form, [k]: v }
    if (tadaSpecs()[k]) checkTada(k, next, 'change')
    if (k === 'travel_date_from' && (ferr.travel_date_to || next.travel_date_to)) checkTada('travel_date_to', next, 'blur')
  }
  const blurF = (k: string) => checkTada(k, form, 'blur')
  const itemErrKey = (key: string, field: string) => `li.${key}.${field}`
  const checkItem = (item: any, field: string, mode: 'change' | 'blur') => {
    const id = itemErrKey(item._key, field)
    const sp = TADA_ITEM_SPECS[field]
    if (!sp) return
    if (mode === 'change') fe.change(id, item[field], sp); else fe.blur(id, item[field], sp)
    const x = tadaItemMsg(field, item)
    if (x && !validate(item[field], sp)) fe.setError(id, x)
  }
  const blurItem = (key: string, field: string) => {
    const item = form.line_items.find((li: any) => li._key === key)
    if (item) checkItem(item, field, 'blur')
  }
  const focusFirstTadaError = () => {
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>('.form-control.error, [data-tada-invalid="true"]')
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); try { el.focus({ preventScroll: true }) } catch { el.focus() } }
    }, 60)
  }
  const resetForm = () => { setForm({ ...EMPTY_FORM, line_items: [emptyItem()] }); fe.clear() }
  const isRequestLocked = !!form.travel_request_id

  const checkTadaStorageFiles = async (files: File[]) => {
    if (!files.length) return
    const fd = new FormData()
    files.forEach(file => fd.append('files', file, file.name))
    await api.post('/storage/check-file', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
  }

  const selectedAttachmentFiles = () => form.line_items.flatMap(
    (item: any) => (item._localAttachments || []).map((att: any) => att.file).filter(Boolean),
  )

  const formatDateValue = (value: any) => {
    if (!value) return ''
    const text = String(value)
    return text.length >= 10 ? text.slice(0, 10) : text
  }
  const getTodayInputDate = () => {
    const today = new Date()
    today.setMinutes(today.getMinutes() - today.getTimezoneOffset())
    return today.toISOString().slice(0, 10)
  }
  const normalizeTransportMode = (request: any) => {
    if (request?.transport_mode) return request.transport_mode
    switch (String(request?.mode_of_travel || '').toLowerCase()) {
      case 'air': return 'flight'
      case 'train': return 'train'
      case 'bus': return 'bus'
      case 'car (company)': return 'company_car'
      case 'car (personal)': return 'own_vehicle'
      case 'two wheeler': return 'bike'
      default: return ''
    }
  }
  const hasManualExpenseData = (items: any[] = []) =>
    items.some((item: any) =>
      item.expense_date || item.description?.trim() || item.amount ||
      item.from_place?.trim() || item.to_place?.trim() ||
      item.receipt_number?.trim() || item.vendor_name?.trim() ||
      (item._localAttachments?.length || 0) > 0
    )
  const buildSeedExpenseItem = (request: any) => {
    const mode = normalizeTransportMode(request)
    const category = ['own_vehicle','company_car','bike'].includes(mode) ? 'Fuel' : 'Transport Fare'
    const description = request?.purpose || [request?.from_city, request?.to_city].filter(Boolean).join(' to ') || ''
    return {
      ...emptyItem(),
      expense_date: formatDateValue(request?.return_date || request?.travel_date),
      category, description,
      from_place: request?.from_city || '', to_place: request?.to_city || '',
    }
  }

  const approvedTravelRequestOptions = travelRequests.map((r: any) => ({
    value: r.id,
    label: `${r.request_number} - ${r.from_city} to ${r.to_city}`,
    subtitle: r.purpose || r.account_name || '',
  }))

  const handleTravelRequestChange = (value: string | number | null) => {
    // trip details are (re)filled from the request – drop stale messages on those fields
    ;['claim_date', 'travel_date_from', 'travel_date_to', 'from_city', 'to_city', 'purpose', 'advance_taken', 'cost_center', 'budget_code', 'notes']
      .forEach(k => fe.setError(k, ''))
    if (!value) {
      setForm((prev: any) => ({
        ...prev, travel_request_id: null,
        from_city: '', to_city: '', purpose: '',
        travel_date_from: '', travel_date_to: '', num_days: '',
        mode_of_travel: '', advance_taken: 0, payment_mode: 'self_pay',
        cost_center: '', budget_code: '', notes: '',
      }))
      return
    }
    const req = travelRequests.find((r: any) => String(r.id) === String(value))
    if (!req) { setF('travel_request_id', value); return }
    const seededItem    = buildSeedExpenseItem(req)
    const normalizedMode = normalizeTransportMode(req)
    const advanceAmount  = req.advance_amount ? String(req.advance_amount) : '0'
    setForm((prev: any) => ({
      ...prev,
      travel_request_id: req.id,
      claim_date:        prev.claim_date || getTodayInputDate(),
      travel_date_from:  formatDateValue(req.travel_date),
      travel_date_to:    formatDateValue(req.return_date || req.travel_date),
      purpose:           req.purpose || seededItem.description,
      from_city:         req.from_city || '',
      to_city:           req.to_city   || '',
      num_days:          req.total_days ? String(req.total_days) : prev.num_days,
      mode_of_travel:    normalizedMode,
      advance_taken:     advanceAmount,
      payment_mode:      Number(req.advance_amount || 0) > 0 ? 'cash_advance' : (prev.payment_mode || 'self_pay'),
      cost_center:       req.cost_center || prev.cost_center,
      budget_code:       req.budget_code || prev.budget_code,
      department:        prev.department || user?.department || '',
      notes:             req.notes || prev.notes,
      line_items:        hasManualExpenseData(prev.line_items) ? prev.line_items : [seededItem],
    }))
  }

  useEffect(() => {
    if (isRequestLocked) return
    if (form.travel_date_from && form.travel_date_to) {
      const diff = Math.max(1, Math.round(
        (new Date(form.travel_date_to).getTime() - new Date(form.travel_date_from).getTime())
        / (1000 * 60 * 60 * 24)
      ) + 1)
      setF('num_days', diff)
    }
  }, [form.travel_date_from, form.travel_date_to])

  const updateItem = (key: string, k: string, v: any) => {
    setForm((p: any) => ({ ...p, line_items: p.line_items.map((li: any) => li._key === key ? { ...li, [k]: v } : li) }))
    const item = form.line_items.find((li: any) => li._key === key)
    if (item && TADA_ITEM_SPECS[k]) checkItem({ ...item, [k]: v }, k, 'change')
  }
  const addItem    = () => setForm((p: any) => ({ ...p, line_items: [...p.line_items, emptyItem()] }))
  const removeItem = (key: string) => {
    setForm((p: any) => ({ ...p, line_items: p.line_items.filter((li: any) => li._key !== key) }))
    Object.keys(TADA_ITEM_SPECS).forEach(f => fe.setError(itemErrKey(key, f), ''))
  }

  const totalAmount = form.line_items.reduce((s: number, i: any) => s + (parseFloat(i.amount) || 0), 0)
  const netPayable  = totalAmount - (parseFloat(form.advance_taken) || 0)
  const daTotal     = (parseFloat(form.da_rate_per_day) || 0) * (parseInt(form.num_days) || 0)

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    let claimsData: any[] = [], approvedRequests: any[] = []
    try {
      const c = await api.get('/travel/tada')
      claimsData = Array.isArray(c.data) ? c.data : []
    } catch (e: any) {
      if (!silent) showError(e?.response?.data?.detail || 'Failed to load Travel Claims')
    }
    try {
      const t = await api.get('/travel/requests', { params: { status_filter: 'Approved' } })
      approvedRequests = Array.isArray(t.data) ? t.data : []
    } catch {}
    if (!silent || claimsData.length > 0) setClaims(claimsData)
    setTravelRequests(approvedRequests)
    if (!silent) setLoading(false)
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!selected) return
    sidebarWasCollapsed.current = sidebarCollapsed
    setSidebarCollapsed(true)
    return () => { setSidebarCollapsed(sidebarWasCollapsed.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!selected])

  const handleSave = async () => {
    if (saving) return
    if (form.line_items.length === 0) { showError('Add at least one expense item'); return }
    // validate every header field and every expense row; show all messages, keep the entered data
    const extra: Record<string, string> = {}
    for (const k of Object.keys(tadaSpecs())) {
      const m = tadaCross(k, form)
      if (m) extra[k] = m
    }
    const itemVals: Record<string, any> = {}
    const itemSpecMap: Record<string, FieldSpec> = {}
    for (const li of form.line_items) {
      for (const f of Object.keys(TADA_ITEM_SPECS)) {
        const id = itemErrKey(li._key, f)
        itemVals[id] = li[f]; itemSpecMap[id] = TADA_ITEM_SPECS[f]
        const m = tadaItemMsg(f, li)
        if (m) extra[id] = m
      }
    }
    const bad = fe.validateAll({ ...form, ...itemVals }, { ...tadaSpecs(), ...itemSpecMap }, extra)
    if (Object.keys(bad).length) {
      const lockedBad = isRequestLocked && ['from_city', 'to_city', 'purpose', 'travel_date_from', 'travel_date_to'].find(k => bad[k])
      showError(lockedBad ? `${bad[lockedBad]} (from the selected travel request)` : 'Please correct the highlighted fields')
      focusFirstTadaError()
      return
    }
    setSaving(true)
    try {
      await checkTadaStorageFiles(selectedAttachmentFiles())
      const payload = {
        travel_request_id: form.travel_request_id || null,
        claim_date: form.claim_date, claim_type: form.claim_type || 'travel',
        travel_date_from: form.travel_date_from  || null, travel_date_to: form.travel_date_to || null,
        num_days: form.num_days ? parseInt(form.num_days) : null,
        from_city: form.from_city || null, to_city: form.to_city || null,
        purpose: form.purpose, mode_of_travel: form.mode_of_travel || null,
        da_rate_per_day: form.da_rate_per_day ? parseFloat(form.da_rate_per_day) : null,
        expense_mode: form.payment_mode || null,
        advance_taken: parseFloat(form.advance_taken) || 0,
        cost_center: form.cost_center || null, budget_code: form.budget_code || null,
        department: form.department || null, notes: form.notes || null,
        line_items: form.line_items.map((i: any) => ({
          expense_date: i.expense_date, category: (i.category as string).replace(' / ', '/'),
          description: i.description, amount: parseFloat(i.amount) || 0,
          from_place: i.from_place || null, to_place: i.to_place || null,
          receipt_number: i.receipt_number || null, vendor_name: i.vendor_name || null, notes: null,
        })),
      }
      const res      = await api.post('/travel/tada', payload)
      const newClaim = res.data
      const savedItems = newClaim.line_items || []
      for (let idx = 0; idx < form.line_items.length; idx++) {
        const savedItem = savedItems[idx]
        if (!savedItem) continue
        for (const att of form.line_items[idx]._localAttachments || []) {
          try {
            const fd = new FormData()
            fd.append('file', att.file)
            await api.post(
              `/travel/tada/${newClaim.id}/line-items/${savedItem.id}/attachments?doc_type=${att.doc_type}`,
              fd, { headers: { 'Content-Type': 'multipart/form-data' } },
            )
          } catch (e) {
            throw e
          }
        }
      }
      setClaims(prev => [newClaim, ...prev.filter((c: any) => c.id !== newClaim.id)])
      setNewClaimId(newClaim.id)
      setTimeout(() => setNewClaimId(null), 3000)
      success('Travel claim saved!')
      load(true); resetForm(); setPanelOpen(false)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (e: any) {
      // field-level 422 → message under the field (line_items.N.field → that expense row)
      const raw = apiFieldErrors(e)
      const mapped: Record<string, string> = {}
      for (const [k, m] of Object.entries(raw)) {
        const parts = k.split('.')
        if (parts[0] === 'line_items' && parts.length === 3 && form.line_items[Number(parts[1])]) mapped[itemErrKey(form.line_items[Number(parts[1])]._key, parts[2])] = m
        else if (parts.length === 1 && tadaSpecs()[k]) mapped[k] = m
      }
      if (Object.keys(mapped).length) {
        fe.setErrors(x => ({ ...x, ...mapped }))
        focusFirstTadaError()
        showError('Please correct the highlighted fields')
      } else showError(extractErrorMessage(e) || 'Failed to create claim')
    } finally { setSaving(false) }
  }

  const handleSubmit = async (id: number) => {
    try {
      const r = await api.post(`/travel/tada/${id}/submit`)
      success(r.data?.requested_to ? `Submitted to ${r.data.requested_to}` : r.data?.message || 'Submitted successfully')
      load()
    } catch (e: any) { showError(e.response?.data?.detail || 'Failed') }
  }

  const handleAction = async (action: string, claimId: number, data: any) => {
    setSaving(true)
    try {
      const status = selected?.overall_status || ''
      let endpoint = ''
      if      (status === 'Submitted')        endpoint = `/travel/tada/${claimId}/manager-decision`
      else if (status === 'Manager Approved') endpoint = `/travel/tada/${claimId}/ceo-decision`
      else if (status === 'CEO Approved')     endpoint = `/travel/tada/${claimId}/accounts-decision`
      if (!endpoint) { showError('No valid action'); setSaving(false); return }
      await api.post(endpoint, { decision: action, ...data })
      success(`Claim ${action}`)
      setSelected(null); load()
    } catch (e: any) { showError(e.response?.data?.detail || 'Failed') }
    finally { setSaving(false) }
  }

  const stats = {
    total:    claims.length,
    pending:  claims.filter(c => c.overall_status === 'Submitted').length,
    manager:  claims.filter(c => c.overall_status === 'Manager Approved').length,
    ceo:      claims.filter(c => c.overall_status === 'CEO Approved').length,
    paid:     claims.filter(c => c.overall_status === 'Paid').length,
    totalNet: claims.reduce((s, c) => s + (Number(c.net_payable) || 0), 0),
  }

  return (
    <div className="p-6 space-y-5 bg-slate-50/40 min-h-full">
      {selected && (
        <ClaimDetailModal claim={selected} onClose={() => setSelected(null)}
          onAction={handleAction} saving={saving} userRole={user?.role || ''}
          canUpdate={can('travel.update')} canDeleteAttachment={can('travel.delete')} />
      )}

      <PageHeader
        title="Travel Claims"
        subtitle="TA/DA · Manager → CEO → Accounts approval chain"
        breadcrumb={['Travel Management', 'Travel Claims']}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={() => load()} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
            {can('travel.create') && (
              <Button onClick={() => { resetForm(); setPanelOpen(true) }}>
                <Plus size={14} className="mr-1.5 inline-block" />New Claim
              </Button>
            )}
          </div>
        }
      />

      <TravelModuleTabs active="claims" claimCount={stats.total} />

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <StatCard title="Total"         value={stats.total}   icon={<Receipt size={18} />}       color="blue"   />
        <StatCard title="Pending"       value={stats.pending} icon={<Clock size={18} />}          color="amber"  />
        <StatCard title="Mgr Approved"  value={stats.manager} icon={<UserCheck size={18} />}     color="indigo" />
        <StatCard title="CEO Approved"  value={stats.ceo}     icon={<Crown size={18} />}          color="purple" />
        <StatCard title="Paid"          value={stats.paid}    icon={<CheckCircle size={18} />}   color="green"  />
        <StatCard title="Total Payable" value={`₹${stats.totalNet.toLocaleString('en-IN')}`} icon={<IndianRupee size={18} />} color="red" />
      </div>

      {/* Claims list */}
      <div className="space-y-2.5">
        {loading ? (
          <div className="py-16 text-center bg-white rounded-2xl border border-slate-200 shadow-sm">
            <Loader2 size={22} className="animate-spin text-slate-300 mx-auto mb-3" />
            <p className="text-sm text-slate-400">Loading claims…</p>
          </div>
        ) : claims.length === 0 ? (
          <div className="py-20 text-center bg-white rounded-2xl border border-slate-200 shadow-sm">
            <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-3">
              <Receipt size={26} className="text-slate-300" />
            </div>
            <p className="text-sm font-semibold text-slate-500">No Travel Claims yet</p>
            <p className="text-xs text-slate-400 mt-1">Create your first claim to get started</p>
          </div>
        ) : claims.map((claim: any) => {
          const cfg = STATUS_CFG[claim.overall_status] || STATUS_CFG.Draft
          const totalAtts = (claim.line_items || []).reduce((s: number, li: any) => s + (li.attachments || []).length, 0)
          const allProof  = claim.has_all_proofs || totalAtts >= (claim.line_items?.length || 0)
          return (
            <div key={claim.id} onClick={() => setSelected(claim)}
              className={`bg-white rounded-2xl border shadow-sm hover:shadow-md transition-all cursor-pointer
                ${claim.id === newClaimId ? 'border-emerald-400 ring-2 ring-emerald-100 shadow-md' : 'border-slate-200 hover:border-slate-300'}`}>
              {/* Status accent top bar */}
              <div className={`h-0.5 rounded-t-2xl ${cfg.bar}`} />
              <div className="flex items-start gap-4 px-5 py-4">
                <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Receipt size={17} className="text-indigo-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-mono text-xs font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-lg">{claim.claim_number}</span>
                        <StatusPill status={claim.overall_status} />
                      </div>
                      <p className="text-sm font-semibold text-slate-800 truncate">{claim.purpose || claim.claim_date}</p>
                      {claim.from_city && claim.to_city && (
                        <p className="text-xs text-slate-400 mt-0.5">{claim.from_city} → {claim.to_city}</p>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-base font-bold text-slate-800">₹{Number(claim.net_payable).toLocaleString('en-IN')}</p>
                      <p className="text-[10px] text-slate-400 font-medium">net payable</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
                    <div className="flex items-center gap-3 flex-wrap">
                      <WorkflowBar status={claim.overall_status} />
                      {claim.line_items?.length > 0 && (
                        allProof
                          ? <span className="text-[10px] text-emerald-600 flex items-center gap-0.5 font-medium"><CheckCircle size={9} />All proofs</span>
                          : <span className="text-[10px] text-amber-500 flex items-center gap-0.5 font-medium"><AlertCircle size={9} />Upload proofs</span>
                      )}
                    </div>
                    <div onClick={e => e.stopPropagation()}>
                      {can('travel.update') && ['Draft','Rejected'].includes(claim.overall_status) && (
                        <button onClick={() => handleSubmit(claim.id)}
                          className={`flex items-center gap-1.5 text-xs text-white px-3.5 py-1.5 rounded-xl font-semibold transition-colors shadow-sm
                            ${claim.overall_status === 'Rejected' ? 'bg-amber-500 hover:bg-amber-600' : 'bg-blue-600 hover:bg-blue-700'}`}>
                          <ChevronRight size={11} />
                          {claim.overall_status === 'Rejected' ? 'Re-submit' : 'Submit'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── CREATE PANEL ────────────────────────────────────────────────────── */}
      <SlidePanel open={panelOpen} onClose={() => { resetForm(); setPanelOpen(false) }}
        title="New Travel Claim"
        subtitle={<>Fields marked <span className="text-red-500 font-semibold">*</span> are required</>}
        width="w-[760px]" insetLeft="var(--sidebar-w, 220px)"
        footer={
          <>
            <button onClick={() => { resetForm(); setPanelOpen(false) }}
              className="px-5 py-2.5 text-sm rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium transition-colors">
              Cancel
            </button>
            <Button onClick={handleSave} loading={saving}>Save Claim</Button>
          </>
        }
      >
        <div className="space-y-3 p-1">

          {/* Workflow banner */}
          <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-100 rounded-2xl">
            <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
              <Shield size={15} className="text-blue-600" />
            </div>
            <div className="flex-1">
              <p className="text-xs font-semibold text-blue-800 mb-2">Approval Workflow</p>
              <div className="flex items-center gap-1.5 flex-wrap">
                {['Submit','Manager Review','CEO Approval','Accounts Payment'].map((s, i, arr) => (
                  <span key={s} className="flex items-center gap-1.5">
                    <span className="bg-white text-blue-700 text-[11px] px-2.5 py-1 rounded-lg border border-blue-200 font-semibold shadow-sm">{s}</span>
                    {i < arr.length - 1 && <ChevronRight size={10} className="text-blue-300" />}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-blue-500 mt-2 flex items-center gap-1">
                <AlertTriangle size={10} />Each expense item requires a proof document before submission.
              </p>
            </div>
          </div>

          {/* Claim Details */}
          <CollapsibleSection title="Claim Details" icon={<FileText size={14} />} defaultOpen>
            <FormGrid cols={3}>
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1.5 block">Against Travel Request</label>
                <SearchableSelect clearable options={approvedTravelRequestOptions}
                  value={form.travel_request_id} onChange={handleTravelRequestChange}
                  placeholder="Select approved request..." />
              </div>
              <div>
                <RLabel>Claim Date</RLabel>
                <DatePicker value={form.claim_date} onChange={(v: any) => setF('claim_date', v)} error={ferr.claim_date} />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1.5 block">Claim Type</label>
                <SearchableSelect options={CLAIM_TYPES} value={form.claim_type} onChange={v => setF('claim_type', v)} />
              </div>
            </FormGrid>

            {isRequestLocked && (
              <div className="flex items-center gap-2.5 px-4 py-2.5 bg-blue-50 border border-blue-100 rounded-xl">
                <span className="text-base">🔒</span>
                <p className="text-xs text-blue-700">
                  Trip details are <strong>auto-filled</strong> from the selected travel request and cannot be edited.
                  Clear the request above to enter manually.
                </p>
              </div>
            )}

            <div className="h-px bg-slate-100" />

            <FormGrid cols={3}>
              {isRequestLocked ? (
                <>
                  <LockedField label="Travel Date From" value={form.travel_date_from} />
                  <LockedField label="Travel Date To"   value={form.travel_date_to} />
                </>
              ) : (
                <>
                  <div>
                    <label className="text-xs font-semibold text-slate-600 mb-1.5 block">Travel Date From</label>
                    <DatePicker value={form.travel_date_from} onChange={(v: any) => setF('travel_date_from', v)} error={ferr.travel_date_from} />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-600 mb-1.5 block">Travel Date To</label>
                    <DatePicker value={form.travel_date_to} onChange={(v: any) => setF('travel_date_to', v)} min={form.travel_date_from} error={ferr.travel_date_to} />
                  </div>
                </>
              )}
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1.5 block">No. of Days</label>
                <input readOnly value={form.num_days} placeholder="Auto-calculated"
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl bg-slate-50 text-slate-500 cursor-not-allowed" />
              </div>
            </FormGrid>

            <FormGrid cols={3}>
              {isRequestLocked ? (
                <>
                  <LockedField label="From City" value={form.from_city} required />
                  <LockedField label="To City"   value={form.to_city}   required />
                  <LockedField label="Purpose"   value={form.purpose}   required />
                </>
              ) : (
                <>
                  <div><RLabel>From City</RLabel>
                    <Input placeholder="Departure city" value={form.from_city}
                      onChange={(v: any) => setF('from_city', typeof v === 'string' ? v : v?.target?.value || '')}
                      onBlur={() => blurF('from_city')} error={ferr.from_city} />
                  </div>
                  <div><RLabel>To City</RLabel>
                    <Input placeholder="Destination city" value={form.to_city}
                      onChange={(v: any) => setF('to_city', typeof v === 'string' ? v : v?.target?.value || '')}
                      onBlur={() => blurF('to_city')} error={ferr.to_city} />
                  </div>
                  <div><RLabel>Purpose</RLabel>
                    <Input placeholder="e.g. Customer visit" value={form.purpose}
                      onChange={(v: any) => setF('purpose', typeof v === 'string' ? v : v?.target?.value || '')}
                      onBlur={() => blurF('purpose')} error={ferr.purpose} />
                  </div>
                </>
              )}
            </FormGrid>

            <FormGrid cols={3}>
              {isRequestLocked ? (
                <LockedField label="Mode of Travel" value={MODE_LABEL[form.mode_of_travel] || form.mode_of_travel || '—'} />
              ) : (
                <div>
                  <label className="text-xs font-semibold text-slate-600 mb-1.5 block">Mode of Travel</label>
                  <SearchableSelect options={TRANSPORT_MODE_OPTIONS} value={form.mode_of_travel}
                    onChange={v => setF('mode_of_travel', v)} placeholder="Select mode" />
                </div>
              )}
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1.5 block">Advance Taken (₹)</label>
                <Input type="text" placeholder="0" numberOnly value={form.advance_taken || ''}
                  onChange={(v: any) => setF('advance_taken', typeof v === 'string' ? v : v?.target?.value || 0)}
                  onBlur={() => blurF('advance_taken')} error={ferr.advance_taken} />
                {Number(form.advance_taken) > 0 && (
                  <p className="text-[11px] text-slate-400 mt-1 italic">{numberToWords(Number(form.advance_taken))}</p>
                )}
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1.5 block">DA Rate / Day (₹)</label>
                <Input type="text" placeholder="0" numberOnly value={form.da_rate_per_day || ''}
                  onChange={(v: any) => setF('da_rate_per_day', typeof v === 'string' ? v : v?.target?.value || '')}
                  onBlur={() => blurF('da_rate_per_day')} error={ferr.da_rate_per_day} />
                {daTotal > 0 && (
                  <p className="text-[11px] text-blue-500 mt-1 font-medium">
                    DA total: ₹{daTotal.toLocaleString('en-IN')} ({form.num_days || 0}d × ₹{form.da_rate_per_day})
                  </p>
                )}
              </div>
            </FormGrid>

            <FormGrid cols={3}>
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1.5 block">Payment Mode</label>
                <SearchableSelect options={PAYMENT_MODES} value={form.payment_mode} onChange={v => setF('payment_mode', v)} />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1.5 block">Cost Center</label>
                <Input placeholder="e.g. SALES-WEST" value={form.cost_center}
                  onChange={(v: any) => setF('cost_center', typeof v === 'string' ? v : v?.target?.value || '')}
                  onBlur={() => blurF('cost_center')} error={ferr.cost_center} />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1.5 block">Budget Code</label>
                <Input placeholder="Internal code" value={form.budget_code}
                  onChange={(v: any) => setF('budget_code', typeof v === 'string' ? v : v?.target?.value || '')}
                  onBlur={() => blurF('budget_code')} error={ferr.budget_code} />
              </div>
            </FormGrid>
          </CollapsibleSection>

          {/* Expense Items */}
          <CollapsibleSection title="Expense Items" icon={<Receipt size={14} />} defaultOpen
            action={
              <button onClick={addItem}
                className="flex items-center gap-1 text-xs bg-slate-100 text-slate-600 hover:bg-slate-200 px-2.5 py-1.5 rounded-lg font-semibold transition-colors">
                <Plus size={11} />Add Item
              </button>
            }>
            <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 text-xs text-amber-700">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5 text-amber-500" />
              <span className="font-medium">Each item must have a proof document (receipt / invoice / ticket). Required before you can submit.</span>
            </div>

            {form.line_items.map((item: any, idx: number) => (
              <div key={item._key} className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-lg bg-blue-100 flex items-center justify-center">
                      <span className="text-[10px] font-bold text-blue-600">{idx + 1}</span>
                    </div>
                    <span className="text-xs font-semibold text-slate-700">Expense {idx + 1}</span>
                  </div>
                  {form.line_items.length > 1 && (
                    <button onClick={() => removeItem(item._key)}
                      className="text-xs text-red-400 hover:text-red-600 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-red-50 transition-colors">
                      <X size={10} />Remove
                    </button>
                  )}
                </div>
                <div className="p-4 space-y-3">
                  <FormGrid cols={3}>
                    <div><RLabel>Expense Date</RLabel>
                      <DatePicker value={item.expense_date} onChange={(v: any) => updateItem(item._key, 'expense_date', v)} error={ferr[itemErrKey(item._key, 'expense_date')]} />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-slate-600 mb-1.5 block">Category</label>
                      <SearchableSelect options={EXPENSE_CATEGORIES.map(c => ({ value: c, label: c }))}
                        value={item.category} onChange={v => updateItem(item._key, 'category', v)} error={ferr[itemErrKey(item._key, 'category')]} />
                    </div>
                    <div><RLabel>Amount (₹)</RLabel>
                      <Input type="text" placeholder="0" numberOnly value={item.amount || ''}
                        onChange={(v: any) => updateItem(item._key, 'amount', typeof v === 'string' ? v : v?.target?.value || '')}
                        onBlur={() => blurItem(item._key, 'amount')} error={ferr[itemErrKey(item._key, 'amount')]} />
                      {item.amount && Number(item.amount) > 0 && (
                        <p className="text-[11px] text-slate-400 mt-1 italic">{numberToWords(Number(item.amount))}</p>
                      )}
                    </div>
                  </FormGrid>
                  <div><RLabel>Description</RLabel>
                    <Input placeholder="e.g. Train ticket Chennai to Trichy" value={item.description}
                      onChange={(v: any) => updateItem(item._key, 'description', typeof v === 'string' ? v : v?.target?.value || '')}
                      onBlur={() => blurItem(item._key, 'description')} error={ferr[itemErrKey(item._key, 'description')]} />
                  </div>
                  <FormGrid cols={2}>
                    <Input label="From Place" placeholder="Optional" value={item.from_place}
                      onChange={(v: any) => updateItem(item._key, 'from_place', typeof v === 'string' ? v : v?.target?.value || '')}
                      onBlur={() => blurItem(item._key, 'from_place')} error={ferr[itemErrKey(item._key, 'from_place')]} />
                    <Input label="To Place" placeholder="Optional" value={item.to_place}
                      onChange={(v: any) => updateItem(item._key, 'to_place', typeof v === 'string' ? v : v?.target?.value || '')}
                      onBlur={() => blurItem(item._key, 'to_place')} error={ferr[itemErrKey(item._key, 'to_place')]} />
                    <Input label="Receipt / Bill No." placeholder="Optional" value={item.receipt_number}
                      onChange={(v: any) => updateItem(item._key, 'receipt_number', typeof v === 'string' ? v : v?.target?.value || '')}
                      onBlur={() => blurItem(item._key, 'receipt_number')} error={ferr[itemErrKey(item._key, 'receipt_number')]} />
                    <Input label="Vendor / Payee" placeholder="Optional" value={item.vendor_name}
                      onChange={(v: any) => updateItem(item._key, 'vendor_name', typeof v === 'string' ? v : v?.target?.value || '')}
                      onBlur={() => blurItem(item._key, 'vendor_name')} error={ferr[itemErrKey(item._key, 'vendor_name')]} />
                  </FormGrid>
                  <div>
                    <p className="text-[11px] font-semibold text-slate-500 mb-1.5 flex items-center gap-1.5">
                      <Upload size={9} />Attach proof <span className="text-red-400">*</span>
                      <span className="font-normal text-slate-400">(receipt / invoice – required before submission)</span>
                    </p>
                    <LocalFileZone files={item._localAttachments}
                      onAdd={async att => {
                        await checkTadaStorageFiles([att.file])
                        updateItem(item._key, '_localAttachments', [...(item._localAttachments || []), att])
                      }}
                      onRemove={(i: number) => updateItem(item._key, '_localAttachments',
                        (item._localAttachments || []).filter((_: any, j: number) => j !== i)
                      )} />
                  </div>
                </div>
              </div>
            ))}

            {/* Totals */}
            <div className="grid grid-cols-3 gap-3 p-4 bg-slate-50 rounded-2xl border border-slate-200">
              {[
                { label: 'Total Expenses', val: totalAmount, cls: 'text-slate-800' },
                { label: 'Advance Taken',  val: parseFloat(form.advance_taken) || 0, cls: 'text-amber-600' },
                { label: 'Net Payable',    val: netPayable, cls: 'text-emerald-700 text-base' },
              ].map(({ label, val, cls }) => (
                <div key={label} className="text-center bg-white rounded-xl p-3 border border-slate-100 shadow-sm">
                  <p className={`text-sm font-bold ${cls}`}>₹{val.toLocaleString('en-IN')}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5 font-medium">{label}</p>
                </div>
              ))}
            </div>
            {netPayable > 0 && (
              <p className="text-[11px] text-slate-400 text-center italic">{numberToWords(Math.round(netPayable))}</p>
            )}
          </CollapsibleSection>

          {/* Additional Info */}
          <CollapsibleSection title="Additional Info" icon={<FileText size={14} />} defaultOpen={false} badge="Optional">
            <FormGrid cols={2}>
              <div>
                <label className="text-xs font-semibold text-slate-600 mb-1.5 block">Department</label>
                <Input placeholder="e.g. Sales, Operations" value={form.department}
                  onChange={(v: any) => setF('department', typeof v === 'string' ? v : v?.target?.value || '')}
                  onBlur={() => blurF('department')} error={ferr.department} />
              </div>
            </FormGrid>
            <div>
              <label className="text-xs font-semibold text-slate-600 mb-1.5 block">Notes / Special Instructions</label>
              <textarea value={form.notes} onChange={e => setF('notes', e.target.value)} rows={3}
                placeholder="Any additional context for the approver…"
                onBlur={() => blurF('notes')} aria-invalid={ferr.notes ? true : undefined} data-tada-invalid={ferr.notes ? 'true' : undefined}
                className={`w-full px-3 py-2.5 text-sm border ${ferr.notes ? 'border-red-400' : 'border-slate-200'} rounded-xl focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 resize-none transition-all`} />
              <FieldError id="tada-notes" msg={ferr.notes} />
            </div>
          </CollapsibleSection>

          {/* Employee Declaration */}
          <div onClick={() => setF('declaration', !form.declaration)} data-tada-invalid={ferr.declaration ? 'true' : undefined}
            className={`p-4 rounded-2xl border-2 cursor-pointer transition-all
              ${form.declaration ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-slate-50 hover:border-slate-300'}`}>
            <div className="flex items-start gap-3">
              <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all mt-0.5
                ${form.declaration ? 'bg-emerald-600 border-emerald-600' : 'border-slate-300 bg-white'}`}>
                {form.declaration && (
                  <svg viewBox="0 0 12 12" className="w-3 h-3 text-white">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                  <FileCheck size={13} className="text-emerald-500" />Employee Declaration
                  <span className="text-red-400 font-normal text-xs">*</span>
                </p>
                <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                  I declare that the above expenses are genuine, all receipts are authentic,
                  and these expenses were incurred for official duty only.
                </p>
              </div>
            </div>
          </div>
          <FieldError id="tada-declaration" msg={ferr.declaration} />

        </div>
      </SlidePanel>
    </div>
  )
}
