import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Plus, Trash2, X, ChevronDown, ChevronRight, Search,
  Users, User as UserIcon, Briefcase, AlertCircle, RefreshCw,
  GripVertical, Info, Crown, UserPlus, Pencil, Save,
} from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { PageHeader, useToast } from '@/components/ui/FormComponents'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { apiFieldErrors, validate, type FieldSpec } from '@/utils/validation'

/* ═══════════════════════════════════════════════════════════════════════════
   VALIDATION — same rules as masters_router OrgTreeNodeIn / OrgTreeGroupUpdate
   ═══════════════════════════════════════════════════════════════════════════ */

const GROUP_NAME_SPEC: FieldSpec = { label: 'Group name', rule: 'name', required: true, min: 2, max: 150 }
const GROUP_HEAD_SPEC: FieldSpec = { label: 'Group head', rule: 'select', required: true }
/** Request field → dialog field (server field errors are shown under the matching input). */
const GROUP_API_FIELDS: Record<string, 'group_name' | 'group_lead_id'> = { group_name: 'group_name', group_lead_id: 'group_lead_id', user_id: 'group_lead_id' }
/** Field-level messages of a failed group request, keyed by dialog field. */
function groupFieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, m] of Object.entries(apiFieldErrors(e))) { const f = GROUP_API_FIELDS[k]; if (f && !out[f]) out[f] = m }
  return out
}
/** Plain-text message of a failed request (never an object / list). */
const apiText = (e: any, fallback: string) => {
  const d = e?.response?.data?.detail
  return typeof d === 'string' ? d : Object.values(apiFieldErrors(e))[0] || fallback
}
const focusGroupField = (prefix: string, field: string) => {
  const el = document.getElementById(`${prefix}-${field}`)
  const target = (field === 'group_lead_id' ? el?.querySelector<HTMLElement>('[tabindex]') : el) ?? el
  target?.focus()
}

/** Validation state shared by the Create / Edit group dialogs. */
function useGroupDialogValidation(prefix: string, groupName: string, groupLeadId: number | null, existingNames: string[]) {
  const fe = useFieldErrors()
  const dupMsg = (v: string) => {
    const q = v.trim().replace(/\s+/g, ' ').toLowerCase()
    return q && existingNames.some(n => n.trim().replace(/\s+/g, ' ').toLowerCase() === q) ? 'A group with this name already exists.' : ''
  }
  const nameCheck = (v: string, mode: 'change' | 'blur') => {
    if (mode === 'change') fe.change('group_name', v, GROUP_NAME_SPEC); else fe.blur('group_name', v, GROUP_NAME_SPEC)
    const dup = !validate(v, { ...GROUP_NAME_SPEC, required: false }) ? dupMsg(v) : ''
    if (dup) fe.setError('group_name', dup)
  }
  const submit = () => {
    const bad = fe.validateAll({ group_name: groupName, group_lead_id: groupLeadId }, { group_name: GROUP_NAME_SPEC, group_lead_id: GROUP_HEAD_SPEC })
    const dup = !bad.group_name ? dupMsg(groupName) : ''
    if (dup) { bad.group_name = dup; fe.setError('group_name', dup) }
    const first = ['group_name', 'group_lead_id'].find(k => bad[k])
    if (first) focusGroupField(prefix, first)
    return !first
  }
  /** Map a failed request onto the dialog; returns false when nothing could be mapped. */
  const server = (e: unknown) => {
    const known = groupFieldErrors(e)
    if (!Object.keys(known).length) return false
    fe.setErrors(x => ({ ...x, ...known }))
    focusGroupField(prefix, known.group_name ? 'group_name' : 'group_lead_id')
    return true
  }
  return { errors: fe.errors, nameCheck, headChange: (v: number | null) => fe.blur('group_lead_id', v, GROUP_HEAD_SPEC), submit, server }
}

/* ═══════════════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════════════ */

interface TreeNode {
  id: number
  parent_id: number | null
  user_id: number | null
  level: number
  position: number
  group_name?: string | null
  group_lead_id?: number | null
  group_lead_name?: string | null
  group_lead_email?: string | null
  group_lead_role?: string | null
  group_lead_role_display?: string | null
  user_name: string
  user_email: string
  user_role: string
  user_role_display: string
  children: TreeNode[]
}

interface AvailableUser {
  id: number
  value: number
  label: string
  role: string
  role_display: string
  email: string
  already_placed: boolean
  already_group_head?: boolean
}

/* ═══════════════════════════════════════════════════════════════════════════
   PALETTE — each group gets a unique color theme
   ═══════════════════════════════════════════════════════════════════════════ */

const GROUP_PALETTE = [
  { key: 'amber',   chip: 'bg-amber-500',   chipText: 'text-white',   activeBg: 'bg-amber-50',   activeBorder: 'border-amber-300',   dot: 'bg-amber-400',   line: 'border-amber-200',   dropRing: 'ring-amber-300 bg-amber-50',   badge: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'blue',    chip: 'bg-blue-500',     chipText: 'text-white',   activeBg: 'bg-blue-50',    activeBorder: 'border-blue-300',    dot: 'bg-blue-400',    line: 'border-blue-200',    dropRing: 'ring-blue-300 bg-blue-50',    badge: 'bg-blue-100 text-blue-800 border-blue-200' },
  { key: 'emerald', chip: 'bg-emerald-500',  chipText: 'text-white',   activeBg: 'bg-emerald-50', activeBorder: 'border-emerald-300', dot: 'bg-emerald-400', line: 'border-emerald-200', dropRing: 'ring-emerald-300 bg-emerald-50', badge: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  { key: 'violet',  chip: 'bg-violet-500',   chipText: 'text-white',   activeBg: 'bg-violet-50',  activeBorder: 'border-violet-300',  dot: 'bg-violet-400',  line: 'border-violet-200',  dropRing: 'ring-violet-300 bg-violet-50',  badge: 'bg-violet-100 text-violet-800 border-violet-200' },
  { key: 'rose',    chip: 'bg-rose-500',     chipText: 'text-white',   activeBg: 'bg-rose-50',    activeBorder: 'border-rose-300',    dot: 'bg-rose-400',    line: 'border-rose-200',    dropRing: 'ring-rose-300 bg-rose-50',    badge: 'bg-rose-100 text-rose-800 border-rose-200' },
  { key: 'sky',     chip: 'bg-sky-500',      chipText: 'text-white',   activeBg: 'bg-sky-50',     activeBorder: 'border-sky-300',     dot: 'bg-sky-400',     line: 'border-sky-200',     dropRing: 'ring-sky-300 bg-sky-50',     badge: 'bg-sky-100 text-sky-800 border-sky-200' },
  { key: 'orange',  chip: 'bg-orange-500',   chipText: 'text-white',   activeBg: 'bg-orange-50',  activeBorder: 'border-orange-300',  dot: 'bg-orange-400',  line: 'border-orange-200',  dropRing: 'ring-orange-300 bg-orange-50',  badge: 'bg-orange-100 text-orange-800 border-orange-200' },
  { key: 'teal',    chip: 'bg-teal-500',     chipText: 'text-white',   activeBg: 'bg-teal-50',    activeBorder: 'border-teal-300',    dot: 'bg-teal-400',    line: 'border-teal-200',    dropRing: 'ring-teal-300 bg-teal-50',    badge: 'bg-teal-100 text-teal-800 border-teal-200' },
]

const LEVEL_COLORS: Record<number, { dot: string; badge: string; line: string; dropRing: string }> = {
  2: { dot: 'bg-amber-400',   badge: 'bg-amber-100 text-amber-800 border-amber-200',     line: 'border-amber-200',   dropRing: 'ring-amber-300 bg-amber-50' },
  3: { dot: 'bg-blue-400',    badge: 'bg-blue-100 text-blue-800 border-blue-200',         line: 'border-blue-200',    dropRing: 'ring-blue-300 bg-blue-50' },
  4: { dot: 'bg-emerald-400', badge: 'bg-emerald-100 text-emerald-800 border-emerald-200', line: 'border-emerald-200', dropRing: 'ring-emerald-300 bg-emerald-50' },
  5: { dot: 'bg-violet-400',  badge: 'bg-violet-100 text-violet-800 border-violet-200',   line: 'border-violet-200',  dropRing: 'ring-violet-300 bg-violet-50' },
  6: { dot: 'bg-rose-400',    badge: 'bg-rose-100 text-rose-800 border-rose-200',         line: 'border-rose-200',    dropRing: 'ring-rose-300 bg-rose-50' },
}

function lc(level: number) {
  return LEVEL_COLORS[level] || LEVEL_COLORS[((level - 1) % 5) + 2]
}

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function getRoleLabel(role?: string) {
  const r = (role || '').toLowerCase()
  if (r === 'ceo') return 'CEO'
  if (r === 'vp') return 'VP'
  if (['manager', 'sales_head'].includes(r)) return 'Sales Head'
  if (r === 'sales') return 'Sales Exec'
  return r.charAt(0).toUpperCase() + r.slice(1)
}

function countAll(node: TreeNode): number {
  let c = 0
  for (const ch of node.children || []) c += 1 + countAll(ch)
  return c
}

/* ═══════════════════════════════════════════════════════════════════════════
   CSS KEYFRAMES (injected once)
   ═══════════════════════════════════════════════════════════════════════════ */



type ConfirmVariant = 'danger' | 'info'

type ConfirmOptions = {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  variant?: ConfirmVariant
}

function ConfirmDialog({
  open,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  onConfirm,
  onCancel,
}: ConfirmOptions & { open: boolean; onConfirm: () => void; onCancel: () => void }) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 backdrop-blur-sm px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-start gap-3">
          <div className={`mt-0.5 w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${variant === 'danger' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
            <AlertCircle size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-gray-900">{title}</h3>
            <p className="mt-1 text-sm text-gray-500 leading-5">{message}</p>
          </div>
        </div>
        <div className="px-5 py-4 flex justify-end gap-2 bg-gray-50/60">
          <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 hover:bg-gray-100">
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 rounded-lg text-sm font-semibold text-white shadow-sm ${variant === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
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
    return new Promise<boolean>(resolve => { resolverRef.current = resolve })
  }, [])

  const close = useCallback((value: boolean) => {
    resolverRef.current?.(value)
    resolverRef.current = null
    setOptions(null)
  }, [])

  const dialog = options ? (
    <ConfirmDialog
      open
      {...options}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  ) : null

  return { confirm, dialog }
}

const KEYFRAMES = `
@keyframes gf-fadeIn { from { opacity: 0 } to { opacity: 1 } }
@keyframes gf-slideUp { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: translateY(0) } }
@keyframes gf-treeGrow { from { opacity: 0; transform: translateY(-6px) scale(0.97) } to { opacity: 1; transform: translateY(0) scale(1) } }
@keyframes gf-nodeIn { from { opacity: 0; transform: translateX(-10px) } to { opacity: 1; transform: translateX(0) } }
@keyframes gf-slideRight { from { opacity: 0; transform: translateX(16px) } to { opacity: 1; transform: translateX(0) } }
@keyframes gf-dropPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(59,130,246,0.25) } 50% { box-shadow: 0 0 0 8px rgba(59,130,246,0) } }
`

/* ═══════════════════════════════════════════════════════════════════════════
   CREATE GROUP DIALOG
   ═══════════════════════════════════════════════════════════════════════════ */

function CreateGroupDialog({
  parentNode, existingNames = [], onCreate, onClose,
}: {
  parentNode: TreeNode
  existingNames?: string[]
  onCreate: (parentId: number, groupName: string, groupLeadId: number) => Promise<void>
  onClose: () => void
}) {
  const [groupName, setGroupName] = useState('')
  const [groupLeadId, setGroupLeadId] = useState<number | null>(null)
  const [users, setUsers] = useState<AvailableUser[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const v = useGroupDialogValidation('gf-create', groupName, groupLeadId, existingNames)

useEffect(() => {
  api.get(`/masters/org-tree/available-users?parent_id=${parentNode.id}&include_admin=true`)
    .then(r => setUsers(r.data as AvailableUser[]))
    .catch(() => setUsers([]))
    .finally(() => setLoading(false))
}, [parentNode.id])

const options = useMemo(() =>
  users
    .filter(u => !u.already_group_head)
    .map(u => ({
      value: u.id,
      label: u.label,
      subtitle: `${u.role_display}${u.email ? ` · ${u.email}` : ''}`,
    })),
  [users]
)

  const handleCreate = async () => {
    if (!v.submit() || !groupLeadId) return
    setSaving(true)
    try { await onCreate(parentNode.id, groupName.trim(), groupLeadId); onClose() }
    catch (e) { v.server(e) }   // field errors land under their inputs; other failures were already toasted
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/25 backdrop-blur-sm px-4"
      style={{ animation: 'gf-fadeIn 0.15s ease-out' }}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-visible border border-gray-100"
        style={{ animation: 'gf-slideUp 0.2s ease-out' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-sm font-bold text-gray-900">Create New Group</h3>
            <p className="text-xs text-gray-400 mt-0.5">Add an L2 group under CEO</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100"><X size={15} /></button>
        </div>
        <div className="p-5 space-y-4 overflow-visible">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Group Name <span className="text-red-500">*</span>
            </label>
            <input
              id="gf-create-group_name"
              value={groupName}
              onChange={e => { setGroupName(e.target.value); v.nameCheck(e.target.value, 'change') }}
              onBlur={() => v.nameCheck(groupName, 'blur')}
              aria-invalid={v.errors.group_name ? true : undefined}
              aria-describedby={v.errors.group_name ? 'gf-create-group_name-err' : undefined}
              placeholder="e.g. Banking, Operations..."
              autoFocus
              className={`w-full rounded-lg border bg-white px-3 py-2 text-sm
                focus:outline-none focus:ring-2 placeholder:text-gray-400 transition-colors
                ${v.errors.group_name ? 'border-red-400 focus:ring-red-500/30 focus:border-red-400' : 'border-gray-200 focus:ring-blue-500/30 focus:border-blue-400'}`}
            />
            <FieldError id="gf-create-group_name" msg={v.errors.group_name} />
          </div>
          <div id="gf-create-group_lead_id">
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Group Head <span className="text-red-500">*</span>
            </label>
            <SearchableSelect
              options={options}
              value={groupLeadId}
              onChange={(x: any) => { const id = x ? Number(x) : null; setGroupLeadId(id); v.headChange(id) }}
              placeholder={loading ? 'Loading...' : 'Select group lead...'}
              error={v.errors.group_lead_id}
              clearable
            />
          </div>
        </div>
        <div className="flex gap-3 px-5 py-4 border-t border-gray-100">
          <Button onClick={handleCreate} loading={saving} disabled={!groupName.trim() || !groupLeadId} className="flex-1 justify-center">Create Group</Button>
          <Button variant="ghost" onClick={onClose} className="px-5">Cancel</Button>
        </div>
      </div>
    </div>
  )
}

function EditGroupDialog({
  group,
  existingNames = [],
  onSave,
  onClose,
}: {
  group: TreeNode
  existingNames?: string[]
  onSave: (groupId: number, groupName: string, groupLeadId: number) => Promise<void>
  onClose: () => void
}) {
  const [groupName, setGroupName] = useState(group.group_name || '')
  const [groupLeadId, setGroupLeadId] = useState<number | null>(group.group_lead_id || group.user_id)
  const [users, setUsers] = useState<AvailableUser[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const v = useGroupDialogValidation('gf-edit', groupName, groupLeadId, existingNames)

useEffect(() => {
  api.get(`/masters/org-tree/available-users?parent_id=${group.id}&include_admin=true`)
    .then(r => setUsers(r.data as AvailableUser[]))
    .catch(() => setUsers([]))
    .finally(() => setLoading(false))
}, [group.id])

const options = useMemo(() =>
  users
    .filter(u =>
  !u.already_group_head ||
  u.id === group.user_id ||
  u.id === group.group_lead_id
)
    .map(u => ({
      value: u.id,
      label: u.label,
      subtitle: `${u.role_display}${u.email ? ` · ${u.email}` : ''}`,
    })),
  [users, group.user_id, group.group_lead_id]
)

  const handleSave = async () => {
    if (!v.submit() || !groupLeadId) return
    setSaving(true)
    try {
      await onSave(group.id, groupName.trim(), groupLeadId)
      onClose()
    } catch (e) {
      v.server(e)   // field errors land under their inputs; other failures were already toasted
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/25 backdrop-blur-sm px-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-100">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-sm font-bold text-gray-900">Edit Group</h3>
            <p className="text-xs text-gray-400 mt-0.5">Rename group or change group head</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100">
            <X size={15} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Group Name <span className="text-red-500">*</span>
            </label>
            <input
              id="gf-edit-group_name"
              value={groupName}
              onChange={e => { setGroupName(e.target.value); v.nameCheck(e.target.value, 'change') }}
              onBlur={() => v.nameCheck(groupName, 'blur')}
              aria-invalid={v.errors.group_name ? true : undefined}
              aria-describedby={v.errors.group_name ? 'gf-edit-group_name-err' : undefined}
              className={`w-full rounded-lg border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 ${v.errors.group_name ? 'border-red-400 focus:ring-red-500/30 focus:border-red-400' : 'border-gray-200 focus:ring-blue-500/30 focus:border-blue-400'}`}
            />
            <FieldError id="gf-edit-group_name" msg={v.errors.group_name} />
          </div>

          <div id="gf-edit-group_lead_id">
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Group Head <span className="text-red-500">*</span>
            </label>
            <SearchableSelect
              options={options}
              value={groupLeadId}
              onChange={(x: any) => { const id = x ? Number(x) : null; setGroupLeadId(id); v.headChange(id) }}
              placeholder={loading ? 'Loading...' : 'Select group head...'}
              error={v.errors.group_lead_id}
              clearable
            />
          </div>
        </div>

        <div className="flex gap-3 px-5 py-4 border-t border-gray-100">
          <Button onClick={handleSave} loading={saving} disabled={!groupName.trim() || !groupLeadId} className="flex-1 justify-center">
            Save Changes
          </Button>
          <Button variant="ghost" onClick={onClose} className="px-5">Cancel</Button>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════
   QUICK-ADD DIALOG (inline popup for manual add)
   ═══════════════════════════════════════════════════════════════════════════ */

function QuickAddPopup({
  parentNode, onAdd, onClose,
}: {
  parentNode: TreeNode
  onAdd: (parentId: number, userId: number) => Promise<void>
  onClose: () => void
}) {
  const [users, setUsers] = useState<AvailableUser[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.get(`/masters/org-tree/available-users?parent_id=${parentNode.id}`)
      .then(r => setUsers(r.data as AvailableUser[]))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false))
  }, [parentNode.id])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const filtered = useMemo(() => {
  const q = search.toLowerCase()

 return users.filter(u =>
  !q ||
  u.label.toLowerCase().includes(q) ||
  (u.email || '').toLowerCase().includes(q) ||
  (u.role_display || '').toLowerCase().includes(q)
)
}, [users, search])

  const handleAdd = async (userId: number) => {
    setAdding(userId)
    try { await onAdd(parentNode.id, userId); onClose() }
    finally { setAdding(null) }
  }

  return (
    <div ref={ref}
      className="absolute z-50 top-full right-0 mt-1 w-72 rounded-xl bg-white border border-gray-200 shadow-xl overflow-hidden"
      style={{ animation: 'gf-slideUp 0.15s ease-out' }}>
      <div className="px-3 py-2 border-b border-gray-100 bg-gray-50/80">
        <p className="text-[11px] font-bold text-gray-500 mb-1.5">Add L{parentNode.level + 1} under {parentNode.group_name || parentNode.user_name}</p>
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search users..."
            className="w-full pl-7 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg bg-white
              focus:outline-none focus:ring-1 focus:ring-blue-400 placeholder:text-gray-400" autoFocus />
        </div>
      </div>
      <div className="max-h-52 overflow-y-auto">
        {loading ? (
          <div className="py-6 text-center text-xs text-gray-400">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="py-6 text-center text-xs text-gray-400">
            {search ? 'No match' : 'No available users'}
          </div>
        ) : filtered.map(u => (
          <div key={u.id}
            className="flex items-center justify-between px-3 py-2 hover:bg-blue-50/60 transition-colors">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-500 flex-shrink-0">
                {u.label?.[0]?.toUpperCase() ?? '?'}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-800 truncate">{u.label}</p>
                <p className="text-[10px] text-gray-400 truncate">{u.role_display}</p>
              </div>
            </div>
            <button onClick={() => handleAdd(u.id)} disabled={adding === u.id}
              className="flex-shrink-0 ml-2 px-2 py-1 rounded-md text-[10px] font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
              {adding === u.id ? <RefreshCw size={10} className="animate-spin" /> : <Plus size={10} />}
              Add
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════
   TREE NODE — a single row in the indented tree with connectors
   ═══════════════════════════════════════════════════════════════════════════ */

function TreeBranch({
  node,
  depth,
  isLast,
  parentLines,
  onAddMember,
  onDelete,
  confirm,
  animDelay,
}: {
  node: TreeNode
  depth: number       // 0 = group lead, 1 = first children etc.
  isLast: boolean
  parentLines: boolean[]  // which ancestor columns need a continuing vertical line
  onAddMember: (parentId: number, userId: number) => Promise<void>
  onDelete: (nodeId: number) => Promise<void>
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  animDelay: number
}) {
const [dragOver, setDragOver] = useState(false)
const [showAdd, setShowAdd] = useState(false)
const [deleting, setDeleting] = useState(false)
const [collapsed, setCollapsed] = useState(false)

  const hasKids = (node.children || []).length > 0
  const isGroupNode = node.level === 2 && !!node.group_name
  const title = isGroupNode ? (node.group_lead_name || node.user_name) : (node.user_name || 'Unknown')
  const role = isGroupNode ? (node.group_lead_role_display || node.user_role_display) : node.user_role_display
  const colors = lc(node.level)
const isActiveTarget = dragOver
const activeLineClass = dragOver ? 'border-blue-400' : colors.line
const activeBgClass = dragOver ? 'bg-blue-50/70 ring-2 ring-blue-200' : ''

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true) }
  const handleDragLeave = () => setDragOver(false)
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'))
      if (data.userId) await onAddMember(node.id, data.userId)
    } catch { /* ignore */ }
  }

  const handleDelete = async () => {
    const count = countAll(node)
    const name = isGroupNode ? node.group_name : node.user_name
    const msg = count > 0 ? `Remove "${name}" and ${count} member(s) below?` : `Remove "${name}"?`
    const ok = await confirm({ title: 'Remove member', message: msg, confirmText: 'Remove', variant: 'danger' })
    if (!ok) return
    setDeleting(true)
    try { await onDelete(node.id) } finally { setDeleting(false) }
  }

  // Connector dimensions
  const COL = 28
  const connectorWidth = depth * COL

  return (
    <>
      <div
  onDragOver={handleDragOver}
  onDragLeave={handleDragLeave}
  onDrop={handleDrop}
  className={`relative flex items-stretch group transition-colors duration-150
    ${dragOver ? `rounded-lg ${activeBgClass}` : ''}`}
        style={{
          animation: `gf-nodeIn 0.25s ease-out backwards`,
          animationDelay: `${animDelay}ms`,
          minHeight: '36px',
        }}
      >
        {/* ─── Tree connector columns ─── */}
        <div className="flex flex-shrink-0" style={{ width: connectorWidth }}>
          {parentLines.map((showLine, i) => (
            <div key={i} className="relative" style={{ width: COL }}>
              {showLine && (
                <div className={`absolute left-3 top-0 bottom-0 w-0 border-l-[1.5px] ${isActiveTarget ? 'border-blue-400' : lc(node.level - (depth - i - 1) > 1 ? node.level - (depth - i) : 2).line}`}
                  style={{ borderStyle: 'solid' }} />
              )}
            </div>
          ))}
        </div>

        {/* ─── Horizontal branch connector ─── */}
        {depth > 0 && (
          <div className="relative flex items-center flex-shrink-0" style={{ width: 0 }}>
            {/* Vertical piece from parent */}
            <div className={`absolute border-l-[2px] ${activeLineClass}`}
              style={{ left: -COL + 12, top: 0, height: isLast ? '50%' : '100%', borderStyle: 'solid' }} />
            {/* Horizontal piece to node */}
            <div className={`absolute border-t-[2px] ${activeLineClass}`}
              style={{ left: -COL + 12, top: '50%', width: COL - 12, borderStyle: 'solid' }} />
            {/* Dot at junction */}
            <div className={`absolute w-[6px] h-[6px] rounded-full ${isActiveTarget ? 'bg-blue-500' : colors.dot}`}
              style={{ left: -2, top: '50%', transform: 'translateY(-50%)' }} />
          </div>
        )}

        {/* ─── Node content ─── */}
        <div className={`flex items-center gap-2 flex-1 min-w-0 py-1.5 px-2.5 rounded-lg transition-colors relative
  ${dragOver ? 'bg-blue-50/80' : 'hover:bg-gray-50/70'}`}
          style={{ marginLeft: depth > 0 ? 6 : 0 }}>

          {/* Collapse toggle */}
          {hasKids ? (
            <button onClick={() => setCollapsed(c => !c)}
              className="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 flex-shrink-0 transition-all">
              <div style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0)', transition: 'transform 0.2s' }}>
                <ChevronDown size={13} />
              </div>
            </button>
          ) : (
            <span className="w-5 flex-shrink-0" />
          )}

          {/* Level badge */}
          <span className={`inline-flex items-center px-1.5 py-[1px] rounded text-[9px] font-extrabold border flex-shrink-0 ${colors.badge}`}>
            L{node.level}
          </span>

          {/* Avatar circle */}
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center text-[10px] font-bold text-gray-500 flex-shrink-0">
            {title?.[0]?.toUpperCase() ?? '?'}
          </div>

          {/* Name */}
          <span className="text-[13px] font-semibold text-gray-900 truncate">
            {title}
          </span>

          {/* Role */}
          <span className="text-[11px] text-gray-400 truncate flex-shrink-0">
            {role}
          </span>

          {/* Group lead crown for L2 */}
          {isGroupNode && (
            <Crown size={11} className="text-amber-500 flex-shrink-0" />
          )}

          {/* Kid count */}
          {hasKids && (
            <span className="text-[10px] text-gray-300 flex-shrink-0">
              · {node.children.length} report{node.children.length > 1 ? 's' : ''}
            </span>
          )}

          {/* Drop hint */}
          {dragOver && (
            <span className="ml-auto text-[10px] font-bold text-blue-500 flex-shrink-0"
              style={{ animation: 'gf-dropPulse 1.2s ease-in-out infinite' }}>
              Drop to add L{node.level + 1}
            </span>
          )}

          {/* Action buttons (hover) */}
          <div className="ml-auto flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <div className="relative">
              <button onClick={() => setShowAdd(v => !v)}
                className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-[10px] font-bold text-blue-600 hover:bg-blue-100 hover:text-blue-700 transition-colors"
                title={`Add L${node.level + 1}`}>
                <UserPlus size={13} />
                L{node.level + 1}
              </button>
              {showAdd && (
                <QuickAddPopup parentNode={node} onAdd={onAddMember} onClose={() => setShowAdd(false)} />
              )}
            </div>
            <button onClick={handleDelete} disabled={deleting}
              className="p-1 rounded text-gray-300 opacity-70 hover:opacity-100 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-30" title="Remove">
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* ─── Children ─── */}
      {hasKids && !collapsed && (
        <div>
          {node.children.map((child, idx) => (
            <TreeBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              isLast={idx === node.children.length - 1}
              parentLines={[...parentLines, idx < node.children.length - 1]}
              onAddMember={onAddMember}
              onDelete={onDelete}
              confirm={confirm}
              animDelay={animDelay + (idx + 1) * 40}
            />
          ))}
        </div>
      )}
    </>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════
   DRAGGABLE USER CARD
   ═══════════════════════════════════════════════════════════════════════════ */

function DraggableUser({ user }: { user: AvailableUser }) {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ userId: user.id, userName: user.label, userRole: user.role }))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div draggable onDragStart={handleDragStart}
      className="flex items-center gap-2 px-2.5 py-[7px] rounded-lg bg-white border border-gray-100
        hover:border-blue-300 hover:shadow-sm cursor-grab active:cursor-grabbing
        transition-all duration-150 group select-none">
      <GripVertical size={12} className="text-gray-250 group-hover:text-blue-400 flex-shrink-0 transition-colors" />
      <div className="w-[22px] h-[22px] rounded-full bg-gradient-to-br from-gray-100 to-gray-200
        flex items-center justify-center text-[9px] font-bold text-gray-500 flex-shrink-0">
        {user.label?.[0]?.toUpperCase() ?? '?'}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold text-gray-800 truncate leading-tight">{user.label}</p>
        <p className="text-[9px] text-gray-400 truncate leading-tight">{user.role_display}</p>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════
   USER SIDEBAR — draggable users list
   ═══════════════════════════════════════════════════════════════════════════ */

function UserSidebar({ rootId }: { rootId: number }) {
  const [users, setUsers] = useState<AvailableUser[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  

  useEffect(() => {
    setLoading(true)
    api.get(`/masters/org-tree/available-users?parent_id=${rootId}`)
      .then(r => setUsers(r.data as AvailableUser[]))
      .catch(() => setUsers([]))
      .finally(() => setLoading(false))
  }, [rootId])

const available = useMemo(() => users, [users])
 const filtered = useMemo(() => {
  const q = search.toLowerCase()

  return available.filter(u =>
    !q ||
    u.label.toLowerCase().includes(q) ||
    (u.email || '').toLowerCase().includes(q) ||
    (u.role_display || '').toLowerCase().includes(q)
  )
}, [available, search])



  return (
    <div className="flex h-[560px] flex-col" style={{ animation: 'gf-slideRight 0.3s ease-out' }}>
      <div className="px-3 pt-3 pb-2">
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
          Drag to assign
        </p>
        <div className="relative">
          <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..."
            className="w-full pl-7 pr-3 py-1.5 text-[11px] border border-gray-200 rounded-lg bg-white
              focus:outline-none focus:ring-1 focus:ring-blue-400 placeholder:text-gray-400" />
        </div>
      </div>

      

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-[3px]">
        {loading ? (
          <div className="py-8 text-center">
            <RefreshCw size={14} className="animate-spin text-gray-300 mx-auto mb-1" />
            <p className="text-[10px] text-gray-400">Loading...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-8 text-center">
            <UserIcon size={16} className="mx-auto mb-1 text-gray-300" />
            <p className="text-[10px] text-gray-400">{search ? 'No match' : 'No available users'}</p>
          </div>
        ) : filtered.map((u, i) => (
          <div key={u.id} style={{ animation: `gf-nodeIn 0.2s ease-out backwards`, animationDelay: `${i * 25}ms` }}>
            <DraggableUser user={u} />
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-gray-100">
        <p className="text-[9px] text-gray-400 text-center leading-tight">
          Drag a user and drop on any tree member
          <br />to add them as a direct report
        </p>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════════════════════ */
function findNodeById(nodes: TreeNode[], id: number): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNodeById(node.children || [], id)
    if (found) return found
  }
  return null
}



export default function GroupFixingPage({ embedded = false }: { embedded?: boolean }) {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null)
  const { success, error: showError } = useToast()
  const showErrorRef = useRef(showError)
  const { confirm, dialog: confirmDialog } = useConfirmDialog()
  const [editingGroup, setEditingGroup] = useState<TreeNode | null>(null)

  useEffect(() => { showErrorRef.current = showError }, [showError])

  const loadTree = useCallback(async (showPageLoader = false) => {
    if (showPageLoader) setLoading(true)
    try {
      const r = await api.get('/masters/org-tree')
      setTree(r.data as TreeNode[])
    } catch {
      showErrorRef.current('Failed to load group tree')
    } finally {
      if (showPageLoader) setLoading(false)
    }
  }, [])

  useEffect(() => { loadTree(true) }, [loadTree])

  const rootNode = useMemo<TreeNode>(() => ({
  id: 0,
  parent_id: null,
  user_id: null,
  level: 1,
  position: 0,
  user_name: 'CEO',
  user_email: '',
  user_role: 'ceo',
  user_role_display: 'CEO',
  children: [],
}), [])

const groupNodes = useMemo(
  () =>
    tree
      .filter(n => n.level === 2 && !n.parent_id && !!n.group_name)
      .sort((a, b) => a.position - b.position),
  [tree]
)
  // Auto-select first group
  useEffect(() => {
    if (groupNodes.length > 0 && !selectedGroupId) {
      setSelectedGroupId(groupNodes[0].id)
    }
    // If selected group was deleted, clear
    if (selectedGroupId && !groupNodes.find(g => g.id === selectedGroupId)) {
      setSelectedGroupId(groupNodes[0]?.id ?? null)
    }
  }, [groupNodes, selectedGroupId])

  const selectedGroup = useMemo(
    () => groupNodes.find(g => g.id === selectedGroupId) ?? null,
    [groupNodes, selectedGroupId]
  )

  const handleUpdateGroup = async (groupId: number, groupName: string, groupLeadId: number) => {
  try {
    await api.put(`/masters/org-tree/groups/${groupId}`, {
      group_name: groupName,
      group_lead_id: groupLeadId,
    })
    success('Group updated')
    await loadTree()
  } catch (e: any) {
    // field errors (name / head) are shown under the dialog inputs; anything else is a toast
    if (!Object.keys(groupFieldErrors(e)).length) showError(apiText(e, 'Failed to update group'))
    throw e
  }
}

const handleDeleteGroup = async (groupId: number) => {
  const group = groupNodes.find(g => g.id === groupId)
  const count = group ? countAll(group) : 0

  const ok = await confirm({
    title: 'Delete group',
    message: `Delete "${group?.group_name || 'this group'}" and remove ${count + 1} user(s) from this group?`,
    confirmText: 'Delete group',
    variant: 'danger',
  })
  if (!ok) return

  try {
    await api.delete(`/masters/org-tree/groups/${groupId}`)
    success('Group deleted')
    setSelectedGroupId(null)
    await loadTree()
  } catch (e: any) {
    showError(e.response?.data?.detail || 'Failed to delete group')
    throw e
  }
}

  const handleCreateGroup = async (parentId: number, groupName: string, groupLeadId: number) => {
    try {
      await api.post('/masters/org-tree', {
  user_id: groupLeadId,
  group_name: groupName,
  group_lead_id: groupLeadId,
})
      success('Group created')
      await loadTree()
    } catch (e: any) {
      // field errors (name / head) are shown under the dialog inputs; anything else is a toast
      if (!Object.keys(groupFieldErrors(e)).length) showError(apiText(e, 'Failed to create group'))
      throw e
    }
  }

  const handleAddMember = async (parentId: number, userId: number) => {
    try {
      const parentNode = findNodeById(tree, parentId)

await api.post('/masters/org-tree', {
  parent_id: parentId,
  parent_user_id: parentNode?.user_id,
  user_id: userId,
})
      success('Member added')
      await loadTree()
    } catch (e: any) { showError(apiText(e, 'Failed to add member')); throw e }
  }

  const handleDelete = async (nodeId: number) => {
    try {
      await api.delete(`/masters/org-tree/${nodeId}`)
      success('Removed')
      await loadTree()
    } catch (e: any) { showError(e.response?.data?.detail || 'Failed to remove'); throw e }
  }

  return (
    <div className={embedded ? '' : 'p-6'}>
      <style>{KEYFRAMES}</style>
      {confirmDialog}

      {!embedded && (
        <PageHeader title="Group Fixing" subtitle="Build your team hierarchy — drag users to assign"
          breadcrumb={['Settings', 'Masters', 'Group Fixing']}
          actions={
            <button onClick={() => loadTree(false)} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
          }
        />
      )}

      {/* ─── Compact info bar ─── */}
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-1.5">
        <Info size={12} className="text-amber-500 flex-shrink-0" />
        <p className="text-[11px] text-amber-700 flex-1">
          CEO is <b>L1</b> (fixed). Select a group below, then drag users from the right panel or use the <UserPlus size={10} className="inline -mt-0.5" /> button.
        </p>
        {rootNode && (
          <button onClick={() => setCreateGroupOpen(true)}
            className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-semibold transition-colors">
            <Plus size={12} /> New Group
          </button>
        )}
      </div>

      {createGroupOpen && rootNode && (
        <CreateGroupDialog parentNode={rootNode} existingNames={groupNodes.map(g => g.group_name || '')} onCreate={handleCreateGroup} onClose={() => setCreateGroupOpen(false)} />
      )}

      {/* ─── Main content ─── */}
      {loading ? (
        <div className="rounded-xl border border-gray-100 bg-white p-16 text-center">
          <RefreshCw size={20} className="animate-spin text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-400">Loading org tree...</p>
        </div>
      ) : !rootNode ? (
        <div className="rounded-xl border border-gray-100 bg-white p-16 text-center">
          <div className="w-12 h-12 rounded-2xl bg-amber-100 flex items-center justify-center mx-auto mb-3"><Users size={22} className="text-amber-600" /></div>
          <p className="text-sm text-gray-500 mb-1 font-medium">No CEO root found</p>
          <p className="text-xs text-gray-400 mb-4">Make sure one active user has role "ceo".</p>
          <Button onClick={() => loadTree(true)}><RefreshCw size={14} className="mr-1.5 inline-block" /> Retry</Button>
        </div>
      ) : groupNodes.length === 0 ? (
        <div className="rounded-xl border border-gray-100 bg-white p-16 text-center">
          <div className="w-12 h-12 rounded-2xl bg-blue-100 flex items-center justify-center mx-auto mb-3"><Users size={22} className="text-blue-600" /></div>
          <p className="text-sm text-gray-500 mb-3">No groups yet. Create your first group to get started.</p>
          <Button onClick={() => setCreateGroupOpen(true)}><Plus size={14} className="mr-1.5 inline-block" /> Create First Group</Button>
        </div>
      ) : (
        <>
          {/* ─── CEO Root + Group Chips ─── */}
          <div className="mb-3 rounded-xl border border-gray-100 bg-white px-4 py-3">
            {/* CEO row */}
            {/* <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg bg-red-50 border border-red-100 flex items-center justify-center">
                <Crown size={12} className="text-red-500" />
              </div>
              <span className="text-sm font-bold text-gray-900">{rootNode.user_name}</span>
              <span className="text-[9px] font-extrabold bg-red-50 text-red-600 border border-red-200 px-1.5 py-0.5 rounded">L1 · CEO</span>
              <span className="text-[11px] text-gray-400 ml-1">{groupNodes.length} group{groupNodes.length !== 1 ? 's' : ''}</span>
            </div> */}

            {/* Group selector chips */}
            <div className="flex items-center gap-2 flex-wrap overflow-visible">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mr-1">Groups:</span>
              {groupNodes.map((g, idx) => {
  const pal = GROUP_PALETTE[idx % GROUP_PALETTE.length]
  const isActive = selectedGroupId === g.id
  const memberCount = countAll(g)

  return (
    <div
      key={g.id}
      className="group/chip relative inline-flex items-center gap-1 rounded-full"
    >
      <button
        type="button"
        onClick={() => setSelectedGroupId(g.id)}
        className={`
          flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border
          transition-colors duration-150
          ${isActive
            ? `${pal.chip} ${pal.chipText} border-transparent shadow-sm`
            : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300 hover:bg-gray-50'
          }
        `}
      >
        {!isActive && <div className={`w-2 h-2 rounded-full ${pal.chip}`} />}

        <span className="max-w-[140px] truncate">
          {g.group_name || g.user_name}
        </span>

        <span className={`text-[10px] ${isActive ? 'opacity-75' : 'text-gray-400'}`}>
          ({memberCount})
        </span>
      </button>

      <div
        className="
          flex items-center gap-1 w-[58px]
          opacity-0 pointer-events-none
          group-hover/chip:opacity-100 group-hover/chip:pointer-events-auto
          transition-opacity duration-150
        "
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setEditingGroup(g)
          }}
          className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50"
          title="Edit group"
        >
          <Pencil size={13} />
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            void handleDeleteGroup(g.id)
          }}
          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"
          title="Delete group"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
})}
            </div>
          </div>

          {/* ─── Tree + Sidebar ─── */}
          <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-4 items-start">
            {/* LEFT — Tree */}
            <div className="rounded-xl border border-gray-100 bg-white p-4 overflow-auto" style={{ minHeight: '460px' }}>
              {selectedGroup ? (
                <div key={selectedGroup.id} style={{ animation: 'gf-treeGrow 0.3s ease-out' }}>
                  {/* Group root row */}
                  <TreeBranch
                    node={selectedGroup}
                    depth={0}
                    isLast
                    parentLines={[]}
                    onAddMember={handleAddMember}
                    onDelete={handleDelete}
                    confirm={confirm}
                    animDelay={0}
                  />
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-gray-400">
                  Select a group above to view its tree
                </div>
              )}
            </div>

            {/* RIGHT — User sidebar */}
            <div className="rounded-xl border border-gray-100 bg-white overflow-hidden sticky top-4">
              <UserSidebar rootId={rootNode.id} />
            </div>
          </div>
        </>
      )}
      {editingGroup && (
  <EditGroupDialog
    group={editingGroup}
    existingNames={groupNodes.filter(g => g.id !== editingGroup.id).map(g => g.group_name || '')}
    onSave={handleUpdateGroup}
    onClose={() => setEditingGroup(null)}
  />
)}
    </div>
  )
}
