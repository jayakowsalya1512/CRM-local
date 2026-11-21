import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import {
  Plus, MapPin, Trash2, UserPlus, Upload, Download,
  Search, ChevronDown, Check, X, Copy, Building2,
  FileText, Truck, Users, MessageSquare,
} from 'lucide-react'
import ExcelJS from 'exceljs'
import { useUIStore } from '@/store'
import api from '@/services/api'
import FormPageHeader from '@/components/ui/FormPageHeader'
import Input, { FormField, FormLabel } from '@/components/ui/Input'
import { PageHeader, FormSection, FormGrid, useToast, FormCard, useFieldErrors } from '@/components/ui/FormComponents'
import SearchableSelect, { type SelectOption } from '@/components/ui/SearchableSelect'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { useFormConfig, type FormFieldConfig } from '@/hooks/useFormConfig'
import { CustomFields } from '@/components/form/CustomFields'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Contact {
  id?: number; contact_name: string; designation: string; department: string
  office_phone: string; mobile: string; office_email: string
  is_primary: boolean; notes: string
}
interface AddressEntry {
  id?: number; name: string; address: string; pincode: string
  country: string; state: string; city: string; area: string; sort_order?: number
}
interface CustomerForm {
  customer_name: string; customer_vertical: string; division: string; group_name: string
  is_branch: boolean
  parent_account_id: string | number | null
  billing_address: string; billing_pincode: string; billing_country: string
  billing_state: string; billing_city: string; billing_area: string
  shipping_same_as_billing: boolean
  shipping_address: string; shipping_pincode: string; shipping_country: string
  shipping_state: string; shipping_city: string; shipping_area: string
  gst_number: string; pan_number: string; website: string
  account_status: string; account_potential: string; potential_value: string
  assigned_to: string | number | null; remarks: string
}
interface CurrentUser { id: number | null; role: string; full_name: string }

interface CustomerFieldMeta {
  label: string
  required: boolean
  visible: boolean
  sortOrder: number
}

type OrderedSectionItem =
  | { kind: 'builtin'; key: string; sortOrder: number; defaultOrder: number }
  | { kind: 'custom'; field: FormFieldConfig; sortOrder: number; defaultOrder: number }

type DropdownTextOption =
  | string
  | { value: string; label?: string; status?: string | null; statusLabel?: string | null }

type LocationStateOption = {
  value: string
  label: string
  id: number
  region_id?: number | null
  region_name?: string
}

type LocationDistrictOption = {
  value: string
  label: string
  id: number
  state_id: number
  state_name?: string
  region_id?: number
  region_name?: string
}

// ─── Nav sections definition ──────────────────────────────────────────────────

const NAV_SECTIONS = [
  { id: 'account',  label: 'Account Details',   icon: Building2 },
  { id: 'address',  label: 'Address',            icon: MapPin },
  { id: 'contacts', label: 'Contacts',           icon: Users },
  { id: 'remarks',  label: 'Remarks',            icon: MessageSquare },
]

// ─── Constants ────────────────────────────────────────────────────────────────

const POTENTIALS = ['High', 'Medium', 'Low']
const STATUSES   = ['Active', 'Inactive', 'Prospect', 'Churned']
const CEO_ROLES     = ['admin', 'ceo']
const MANAGER_ROLES = ['manager', 'vp']
const ACCOUNT_FIELD_KEYS = [
  'customer_name',
  'website',
  'customer_vertical',
  'division',
  'group_name',
  'gst_number',
  'pan_number',
  'account_status',
  'account_potential',
  'potential_value',
  'assigned_to',
] as const
const BILLING_ADDRESS_KEYS = ['billing_address', 'billing_pincode', 'billing_country', 'billing_state', 'billing_city', 'billing_area'] as const
const SHIPPING_ADDRESS_KEYS = ['shipping_address', 'shipping_pincode', 'shipping_country', 'shipping_state', 'shipping_city', 'shipping_area'] as const
const CONTACT_FIELD_KEYS = ['contact_name', 'contact_role', 'department', 'contact_phone', 'office_phone', 'contact_email'] as const
const REMARK_FIELD_KEYS = ['remarks'] as const

type AccountFieldKey = typeof ACCOUNT_FIELD_KEYS[number]
type ContactFieldKey = typeof CONTACT_FIELD_KEYS[number]

// ─── Helpers ──────────────────────────────────────────────────────────────────

const numberToWords = (num: number): string => {
  if (!num) return ''
  const a = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen']
  const b = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety']
  const inWords = (n: number): string => {
    if (n < 20) return a[n]
    if (n < 100) return b[Math.floor(n/10)] + (n%10 ? ' '+a[n%10] : '')
    if (n < 1000) return a[Math.floor(n/100)]+' Hundred'+(n%100 ? ' '+inWords(n%100) : '')
    if (n < 100000) return inWords(Math.floor(n/1000))+' Thousand'+(n%1000 ? ' '+inWords(n%1000) : '')
    if (n < 10000000) return inWords(Math.floor(n/100000))+' Lakh'+(n%100000 ? ' '+inWords(n%100000) : '')
    return inWords(Math.floor(n/10000000))+' Crore'+(n%10000000 ? ' '+inWords(n%10000000) : '')
  }
  return inWords(num).trim()+' Only'
}

const emptyContact  = (): Contact      => ({ contact_name:'', designation:'', department:'', office_phone:'', mobile:'', office_email:'', is_primary:false, notes:'' })
const emptyAddress  = (): AddressEntry => ({ name:'', address:'', pincode:'', country:'India', state:'', city:'', area:'' })
const emptyForm     = (): CustomerForm => ({
  customer_name:'', customer_vertical:'', division:'', group_name:'', is_branch:false, parent_account_id:null,
  billing_address:'', billing_pincode:'', billing_country:'India', billing_state:'', billing_city:'', billing_area:'',
  shipping_same_as_billing:true,
  shipping_address:'', shipping_pincode:'', shipping_country:'India', shipping_state:'', shipping_city:'', shipping_area:'',
  gst_number:'', pan_number:'', website:'', account_status:'Prospect', account_potential:'Medium',
  potential_value:'', assigned_to:null, remarks:'',
})

const normalizePincode        = (value: string) => value.replace(/\D/g, '').slice(0, 6)
const hasValidPincode         = (value: string) => /^\d{6}$/.test(value)
const normalizeIdentityValue  = (value: string) => value.trim().replace(/\s+/g, ' ')
const identityKey             = (value: string | null | undefined) => normalizeIdentityValue(String(value ?? '')).toLowerCase()
const dropdownOptionValue     = (option: DropdownTextOption) => typeof option === 'string' ? option : option.value
const dropdownOptionLabel     = (option: DropdownTextOption) => typeof option === 'string' ? option : (option.label ?? option.value)
const dropdownOptionStatus    = (option: DropdownTextOption) => typeof option === 'string' ? null : (option.status ?? null)
const dropdownOptionStatusLabel = (option: DropdownTextOption) => typeof option === 'string' ? null : (option.statusLabel ?? null)

// ─── useCurrentUser ───────────────────────────────────────────────────────────

function useCurrentUser(): CurrentUser {
  const [user, setUser] = useState<CurrentUser>({ id: null, role: '', full_name: '' })
  useEffect(() => {
    api.get('/auth/me')
      .then((r: any) => setUser({ id: r.data.id ?? null, role: (r.data.role ?? '').toLowerCase(), full_name: r.data.full_name ?? '' }))
      .catch(() => {})
  }, [])
  return user
}

// ─── useActiveSection (scroll spy) ───────────────────────────────────────────

function useActiveSection(ids: string[]) {
  const [active, setActive] = useState(ids[0])
  useEffect(() => {
    const observers: IntersectionObserver[] = []
    const map = new Map<string, number>()
    ids.forEach(id => {
      const el = document.getElementById(`section-${id}`)
      if (!el) return
      const obs = new IntersectionObserver(
        ([entry]) => {
          map.set(id, entry.intersectionRatio)
          const top = ids.find(i => (map.get(i) ?? 0) > 0)
          if (top) setActive(top)
        },
        { threshold: [0, 0.1, 0.5], rootMargin: '-80px 0px -60% 0px' }
      )
      obs.observe(el)
      observers.push(obs)
    })
    return () => observers.forEach(o => o.disconnect())
  }, [ids])
  return active
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────

function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0, placement: 'top' as 'top' | 'bottom' })
  const ref = useRef<HTMLDivElement>(null)
  const updatePosition = () => {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    const placement = r.top > 44 ? 'top' : 'bottom'
    setPos({ top: placement === 'top' ? r.top - 8 : r.bottom + 8, left: Math.max(12, Math.min(r.left + r.width / 2, window.innerWidth - 12)), placement })
  }
  return (
    <div ref={ref} className="inline-flex" onMouseEnter={() => { updatePosition(); setShow(true) }} onMouseLeave={() => setShow(false)} onFocus={() => { updatePosition(); setShow(true) }} onBlur={() => setShow(false)}>
      {children}
      {show && createPortal(
        <div className="pointer-events-none fixed z-[9999] -translate-x-1/2" style={{ top: pos.top, left: pos.left, transform: pos.placement === 'top' ? 'translate(-50%, -100%)' : 'translateX(-50%)' }}>
          <div className="relative rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs text-white shadow-lg whitespace-nowrap">
            {text}
            <div className={`absolute left-1/2 -translate-x-1/2 border-4 border-transparent ${pos.placement === 'top' ? 'top-full border-t-gray-900' : 'bottom-full border-b-gray-900'}`} />
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// ─── IconBtn ──────────────────────────────────────────────────────────────────

function IconBtn({ tooltip, onClick, disabled, loading, children, color = 'gray' }: {
  tooltip: string; onClick?: () => void; disabled?: boolean; loading?: boolean
  children: React.ReactNode; color?: 'gray' | 'blue' | 'green' | 'red'
}) {
  const colors = { gray: 'text-gray-400 hover:text-gray-700 hover:bg-gray-100', blue: 'text-gray-400 hover:text-blue-600 hover:bg-blue-50', green: 'text-gray-400 hover:text-green-600 hover:bg-green-50', red: 'text-gray-400 hover:text-red-500 hover:bg-red-50' }
  return (
    <Tooltip text={tooltip}>
      <button type="button" onClick={onClick} disabled={disabled || loading} className={`p-1.5 rounded-lg transition-colors disabled:opacity-40 ${colors[color]}`}>
        {loading ? <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> : children}
      </button>
    </Tooltip>
  )
}

// ─── SectionLabel ─────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">{children}</p>
  )
}

// ─── DropdownTextInput ────────────────────────────────────────────────────────

function DropdownTextInput({ label, value, options, onChange, onCommit, required, error, hint, labelAction, placeholder = 'Type or select' }: {
  label: string; value: string; options: DropdownTextOption[]
  onChange: (next: string) => void; onCommit?: (draft: string) => void
  required?: boolean; error?: string; hint?: string; labelAction?: React.ReactNode; placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const optionRefs   = useRef<Array<HTMLButtonElement | null>>([])
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)

  const filteredOptions = React.useMemo(() => {
    const query = identityKey(value)
    if (!query) return options
    return options.filter(o => identityKey(dropdownOptionValue(o)).includes(query) || identityKey(dropdownOptionLabel(o)).includes(query))
  }, [options, value])

  useEffect(() => {
    if (!open) { setFocusedIndex(-1); return }
    if (filteredOptions.length === 0) { setFocusedIndex(-1); return }
    const idx = filteredOptions.findIndex(o => identityKey(dropdownOptionValue(o)) === identityKey(value))
    setFocusedIndex(idx >= 0 ? idx : 0)
  }, [filteredOptions, open, value])

  useEffect(() => { if (open && focusedIndex >= 0) optionRefs.current[focusedIndex]?.scrollIntoView({ block: 'nearest' }) }, [focusedIndex, open])

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (containerRef.current?.contains(target) || dropdownRef.current?.contains(target)) return
      setOpen(false)
      onCommit?.(value)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [onCommit, value])

  useEffect(() => {
    if (!open) {
      setDropdownPosition(null)
      return
    }

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return

      const gap = 4
      const padding = 12
      const maxPanelHeight = 224
      const availableBelow = window.innerHeight - rect.bottom - padding - gap
      const availableAbove = rect.top - padding - gap
      const placeAbove = availableBelow < 140 && availableAbove > availableBelow
      const availableHeight = placeAbove ? availableAbove : availableBelow
      const maxHeight = Math.max(96, Math.min(maxPanelHeight, availableHeight || maxPanelHeight))
      const width = Math.min(rect.width, window.innerWidth - padding * 2)
      const left = Math.min(Math.max(padding, rect.left), window.innerWidth - padding - width)
      const top = placeAbove
        ? Math.max(padding, rect.top - gap - maxHeight)
        : Math.min(rect.bottom + gap, window.innerHeight - padding - maxHeight)

      setDropdownPosition({ top, left, width, maxHeight })
    }

    updatePosition()
    const frame = window.requestAnimationFrame(updatePosition)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  const dropdown = open && dropdownPosition
    ? createPortal(
      <div
        ref={dropdownRef}
        className="fixed z-[100120] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl"
        style={{
          top: dropdownPosition.top,
          left: dropdownPosition.left,
          width: dropdownPosition.width,
        }}
      >
        <div className="overflow-y-auto py-1" style={{ maxHeight: dropdownPosition.maxHeight }}>
          {filteredOptions.map((option, i) => {
            const optVal = dropdownOptionValue(option)
            const optStatus = dropdownOptionStatus(option)
            const optStatusLabel = dropdownOptionStatusLabel(option)
            const selected = identityKey(optVal) === identityKey(value)
            const focused = i === focusedIndex
            return (
              <button key={identityKey(optVal)} ref={el => { optionRefs.current[i] = el }} type="button" tabIndex={-1}
                onMouseDown={e => e.preventDefault()} onMouseEnter={() => setFocusedIndex(i)}
                onClick={() => { onChange(optVal); onCommit?.(optVal); setOpen(false) }}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm transition-colors ${selected||focused?'bg-blue-50 text-blue-700':'text-gray-700 hover:bg-gray-50'}`}>
                <span className="truncate">{optVal}</span>
                <div className="flex flex-shrink-0 items-center gap-2">
                  {optStatus && optStatus !== 'approved' && (
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${optStatus==='pending'?'border border-amber-200 bg-amber-50 text-amber-700':optStatus==='rejected'?'border border-rose-200 bg-rose-50 text-rose-600':'border border-slate-200 bg-slate-50 text-slate-600'}`}>
                      {optStatusLabel || optStatus}
                    </span>
                  )}
                  {selected && <Check size={14} className="flex-shrink-0" />}
                </div>
              </button>
            )
          })}
        </div>
      </div>,
      document.body,
    )
    : null

  return (
    <div className="form-group" ref={containerRef}>
      <div className="form-label-row">
        <FormLabel required={required}>{label}</FormLabel>
        {labelAction && <div className="form-label-action">{labelAction}</div>}
      </div>
      <div ref={triggerRef} className="relative">
        <input
          className={`form-control pr-10 ${error ? 'error' : ''}`}
          value={value} autoComplete="new-password" autoCorrect="off" spellCheck={false}
          name={`${label.replace(/\s+/g, '_')}_manual_entry`}
          placeholder={placeholder}
          onChange={e => { onChange(e.target.value); if (!open) setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => { if (containerRef.current?.contains(document.activeElement)) return; setOpen(false); onCommit?.(value) }, 0)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) { setOpen(true); return } if (filteredOptions.length > 0) setFocusedIndex(c => Math.min(c+1, filteredOptions.length-1)); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); if (!open) { setOpen(true); return } if (filteredOptions.length > 0) setFocusedIndex(c => c<=0?0:c-1); return }
            if (e.key === 'Enter' && open && focusedIndex >= 0 && filteredOptions[focusedIndex]) { e.preventDefault(); const sel = filteredOptions[focusedIndex]; const v = dropdownOptionValue(sel); onChange(v); onCommit?.(v); setOpen(false); return }
            if (e.key === 'Escape') { setOpen(false); onCommit?.(value) }
          }}
        />
        <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => setOpen(p => !p)}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600">
          <ChevronDown size={15} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {dropdown}
      </div>
      {error && <p className="form-error">{error}</p>}
      {hint && !error && <p className="form-hint">{hint}</p>}
    </div>
  )
}

// ─── AddressEditModal ─────────────────────────────────────────────────────────

function AddressEditModal({
  entry,
  label,
  index,
  onSave,
  onCancel,
  locationStates,
  locationDistricts,
}: {
  entry: AddressEntry
  label: string
  index: number
  onSave: (e: AddressEntry) => void
  onCancel: () => void
  locationStates: LocationStateOption[]
  locationDistricts: LocationDistrictOption[]
}) {
  const [local, setLocal] = useState<AddressEntry>({ ...entry })
  const selectedStateId = useMemo(() => {
  return locationStates.find(
    state => identityKey(state.value) === identityKey(local.state)
  )?.id ?? null
}, [locationStates, local.state])

const districtOptions = useMemo(() => {
  if (!selectedStateId) return []
  return locationDistricts
    .filter(district => Number(district.state_id) === Number(selectedStateId))
    .map(district => ({
      value: district.value,
      label: district.label,
    }))
}, [locationDistricts, selectedStateId])
  const change = (k: keyof AddressEntry) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setLocal(p => ({ ...p, [k]: e.target.value }))
  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gray-50">
          <div>
            <h3 className="font-semibold text-gray-900 text-sm">{label} {index + 1}</h3>
            <p className="text-xs text-gray-400 mt-0.5">Select state and district from location master</p>
          </div>
          <button onClick={onCancel} className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-400"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1.5 block">{label} Name *</label>
            <input value={local.name} onChange={change('name')} placeholder={`Enter ${label.toLowerCase()} name`}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1.5 block">Street Address</label>
            <textarea value={local.address} onChange={change('address')} rows={2} placeholder="Building, street, locality…"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 resize-none" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1.5 block">
              Pincode
            </label>
            <input
  value={local.pincode}
  onChange={e => {
    const v = normalizePincode(e.target.value)
    setLocal(p => ({ ...p, pincode: v }))
  }}
  placeholder="6-digit pincode"
  maxLength={6}
  inputMode="numeric"
  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
/>
            {local.pincode.trim() && !hasValidPincode(local.pincode.trim()) && <p className="mt-1 text-xs text-red-500">Pincode must be exactly 6 digits</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
  <div>
    <label className="text-xs font-semibold text-gray-600 mb-1.5 block">Country</label>
    <input
      value={local.country}
      onChange={change('country')}
      placeholder="Enter country"
      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
    />
  </div>

  <SearchableSelect
    label="State"
    options={locationStates}
    value={local.state}
    onChange={(value) => {
      setLocal(p => ({
        ...p,
        state: value ? String(value) : '',
        city: '',
      }))
    }}
    placeholder="Select state"
    clearable
  />

  <SearchableSelect
    label="City / District"
    options={districtOptions}
    value={local.city}
    onChange={(value) => {
      setLocal(p => ({
        ...p,
        city: value ? String(value) : '',
      }))
    }}
    placeholder={local.state ? 'Select district' : 'Select state first'}
    disabled={!local.state}
    clearable
  />

  <div>
    <label className="text-xs font-semibold text-gray-600 mb-1.5 block">Area / Locality</label>
    <input
      value={local.area}
      onChange={change('area')}
      placeholder="Enter area"
      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
    />
  </div>
</div>
        </div>
        <div className="flex gap-2.5 px-5 py-4 border-t border-gray-100 bg-gray-50">
          <button onClick={onCancel} className="flex-1 px-4 py-2.5 text-sm rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-100 font-medium">Cancel</button>
          <button onClick={() => { if (!local.name.trim()) return; if (local.pincode.trim() && !hasValidPincode(local.pincode.trim())) return; onSave(local) }}
            className="flex-1 px-4 py-2.5 text-sm rounded-xl bg-blue-600 text-white hover:bg-blue-700 font-semibold flex items-center justify-center gap-2">
            <Check size={14} /> Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── AddressList ──────────────────────────────────────────────────────────────

type AddrKind = 'consignee' | 'zone'

function AddressList({
  kind,
  prefix,
  entries,
  editingCustomerId,
  onImported,
  setEntries,
  locationStates,
  locationDistricts,
}: {
  kind: AddrKind
  prefix: 'billing' | 'shipping'
  entries: AddressEntry[]
  editingCustomerId: number | null
  onImported: (rows: AddressEntry[]) => void
  setEntries: React.Dispatch<React.SetStateAction<AddressEntry[]>>
  locationStates: LocationStateOption[]
  locationDistricts: LocationDistrictOption[]
}) {
  const { success, error: showError } = useToast()
  const fileRef                        = useRef<HTMLInputElement>(null)
  const [importing,  setImporting]     = useState(false)
  const [search,     setSearch]        = useState('')
  const [editModal,  setEditModal]     = useState<{ idx: number; entry: AddressEntry } | null>(null)

  const label    = kind === 'consignee' ? 'Consignee' : 'Zone'
  const endpoint = `/customers/${editingCustomerId}/${prefix}-${kind}s/import`
  const resKey   = `${prefix}_${kind}s`

  // const fetchPincode = useCallback(async (val: string, setLocal: (e: AddressEntry) => void, local: AddressEntry, globalIdx?: number) => {
  //   if (val.length !== 6 || !/^\d{6}$/.test(val)) return
  //   setPinLoading(true)
  //   try {
  //     const r   = await api.get(`/customers/pincode/${val}`)
  //     const d   = r.data
  //     const upd = { ...local, country: d.country || 'India', state: d.state || local.state, city: d.city || local.city, area: d.area || local.area }
  //     setLocal(upd)
  //     if (globalIdx !== undefined) setEntries(prev => { const n = [...prev]; n[globalIdx] = upd; return n })
  //   } catch {}
  //   finally { setPinLoading(false) }
  // }, [setEntries])

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !editingCustomerId) return
    setImporting(true)
    try {
      const fd = new FormData(); fd.append('file', file)
      const res = await api.post(endpoint, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      success(res.data.message)
      const r = await api.get(`/customers/${editingCustomerId}`)
      onImported(r.data[resKey] ?? [])
    } catch (err: any) { showError(err.response?.data?.detail || 'Import failed.') }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = '' }
  }

  const filteredWithIdx = entries.map((e, idx) => ({ e, idx })).filter(({ e }) =>
    !search || e.name.toLowerCase().includes(search.toLowerCase()) ||
    (e.city && e.city.toLowerCase().includes(search.toLowerCase())) ||
    (e.pincode && e.pincode.includes(search))
  )

  const downloadTemplate = async () => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(`${label} Import`)

  ws.columns = [
    { header: '', key: 'name', width: 36 },
    { header: '', key: 'address', width: 50 },
    { header: '', key: 'pincode', width: 16 },
    { header: '', key: 'state', width: 24 },
    { header: '', key: 'district', width: 24 },
    { header: '', key: 'area', width: 28 },
  ]

  ws.mergeCells('A1:F1')

  const ic = ws.getCell('A1')
  ic.value = `${label} Import · Fill Name, Address, Pincode, State, District and Area`
  ic.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF374151' } }
  ic.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } }
  ic.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true }
  ws.getRow(1).height = 28

  const hr = ws.getRow(2)
  ;[
    `${label} Name *`,
    'Address',
    'Pincode',
    'State',
    'District',
    'Area / Locality',
  ].forEach((h, i) => {
    const cell = hr.getCell(i + 1)
    cell.value = h
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
  })

  hr.height = 22
  ws.views = [{ state: 'frozen', ySplit: 2 }]

  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${label}_template.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}

  return (
    <div>
      <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFile} />
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={`Search ${label.toLowerCase()}s…`}
            className="w-full pl-7 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:border-blue-400 bg-gray-50" />
          {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"><X size={12} /></button>}
        </div>
        <button type="button" onClick={downloadTemplate}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-500 hover:text-green-700 hover:border-green-300 hover:bg-green-50">
          <Download size={12} /> Template
        </button>
        {editingCustomerId ? (
          <button type="button" disabled={importing} onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-500 hover:text-blue-700 hover:border-blue-300 hover:bg-blue-50 disabled:opacity-50">
            {importing ? <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /> : <Upload size={12} />}
            {importing ? 'Importing…' : 'Import'}
          </button>
        ) : (
          <button type="button" disabled className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-dashed border-gray-200 text-gray-300 cursor-not-allowed">
            <Upload size={12} /> Import
          </button>
        )}
        <button type="button"
          onClick={() => { const ni = entries.length; const ne = emptyAddress(); setEntries(p => [...p, ne]); setEditModal({ idx: ni, entry: ne }) }}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-semibold whitespace-nowrap">
          <Plus size={12} /> Add {label}
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-2">{filteredWithIdx.length} of {entries.length} {label.toLowerCase()}{entries.length !== 1 ? 's' : ''}</p>
      {entries.length === 0 ? (
        <div className="border-2 border-dashed border-gray-200 rounded-xl py-8 flex flex-col items-center gap-2">
          <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center"><MapPin size={18} className="text-gray-300" /></div>
          <p className="text-sm font-medium text-gray-400">No {label.toLowerCase()}s yet</p>
          <p className="text-xs text-gray-400">Add manually or import from Excel</p>
        </div>
      ) : filteredWithIdx.length === 0 ? (
        <div className="text-center py-6 text-gray-400 text-sm">No results for "{search}"</div>
      ) : (
        <div className="max-h-[340px] overflow-y-auto space-y-1.5 pr-0.5">
          {filteredWithIdx.map(({ e, idx }) => (
            <div key={idx} className="group flex items-start gap-3 p-3 rounded-xl border border-gray-200 bg-white hover:border-blue-200 hover:bg-blue-50/30 transition-all cursor-pointer"
              onClick={() => setEditModal({ idx, entry: e })}>
              <div className="w-7 h-7 rounded-lg bg-gray-100 group-hover:bg-blue-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="text-xs font-bold text-gray-500 group-hover:text-blue-600">{idx + 1}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800 truncate">{e.name || <span className="text-gray-400 font-normal italic">Unnamed</span>}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                  {e.pincode && <span className="text-xs text-gray-500">📍 {e.pincode}</span>}
                  {(e.city || e.state) && <span className="text-xs text-gray-500">{[e.city, e.state].filter(Boolean).join(', ')}</span>}
                  {e.address && <span className="text-xs text-gray-400 truncate max-w-[200px]">{e.address}</span>}
                </div>
              </div>
              <button type="button" onClick={ev => { ev.stopPropagation(); setEntries(p => p.filter((_, i) => i !== idx)) }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-all flex-shrink-0 mt-0.5">
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {editModal && (
        <AddressEditModal
  entry={editModal.entry}
  label={label}
  index={editModal.idx}
  locationStates={locationStates}
  locationDistricts={locationDistricts}
  onSave={updated => {
    setEntries(p => {
      const n = [...p]
      n[editModal.idx] = updated
      return n
    })
    setEditModal(null)
  }}
  onCancel={() => {
    if (!editModal.entry.name) setEntries(p => p.filter((_, i) => i !== editModal.idx))
    setEditModal(null)
  }}
/>
      )}
    </div>
  )
}

// ─── AddressSections ──────────────────────────────────────────────────────────

function AddressSections({
  form,
  setForm,
  editingId,
  customers,
  billingConsignees,
  setBillingConsignees,
  billingZones,
  setBillingZones,
  shippingConsignees,
  setShippingConsignees,
  shippingZones,
  setShippingZones,
  handlePincodeChange,
  inputChange,
  fieldErrors,
  clearFieldError,
  addressFieldMeta,
  orderedBillingKeys,
  orderedShippingKeys,
  locationStates,
  locationDistricts,
}: {
  form: CustomerForm; setForm: React.Dispatch<React.SetStateAction<CustomerForm>>; editingId: number | null
  customers: any[]
  billingConsignees: AddressEntry[];  setBillingConsignees: React.Dispatch<React.SetStateAction<AddressEntry[]>>
  billingZones: AddressEntry[];       setBillingZones: React.Dispatch<React.SetStateAction<AddressEntry[]>>
  shippingConsignees: AddressEntry[]; setShippingConsignees: React.Dispatch<React.SetStateAction<AddressEntry[]>>
  shippingZones: AddressEntry[];      setShippingZones: React.Dispatch<React.SetStateAction<AddressEntry[]>>
  // pincodeLoading: 'billing' | 'shipping' | null
  locationStates: LocationStateOption[]
  locationDistricts: LocationDistrictOption[]
  handlePincodeChange: (prefix: 'billing' | 'shipping') => (e: React.ChangeEvent<HTMLInputElement>) => void
  inputChange: (k: keyof CustomerForm) => (e: React.ChangeEvent<HTMLInputElement>) => void
  fieldErrors: Record<string, string>
  clearFieldError: (key: string) => void
  addressFieldMeta: Record<string, CustomerFieldMeta>
  orderedBillingKeys: string[]
  orderedShippingKeys: string[]
}) {
  const errProp = (key: string) => fieldErrors[key] ? ' ' : undefined

  const copyBillingToShipping = () => {
    setForm(p => ({ ...p, shipping_address: p.billing_address, shipping_pincode: p.billing_pincode, shipping_country: p.billing_country, shipping_state: p.billing_state, shipping_city: p.billing_city, shipping_area: p.billing_area }))
    setShippingConsignees(billingConsignees.map(e => ({ ...e, id: undefined })))
    setShippingZones(billingZones.map(e => ({ ...e, id: undefined })))
  }

  const groupTextOptions = (values: any[]): string[] => {
    const map = new Map<string, string>()
    values.forEach(v => { const raw = String(v || '').trim(); if (!raw) return; const key = raw.toLowerCase().replace(/\s+/g, ' '); if (!map.has(key)) map.set(key, raw) })
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b))
  }
  const getSelectedStateId = (stateName: string) => {
  const selected = locationStates.find(
    state => identityKey(state.value) === identityKey(stateName)
  )
  return selected?.id ?? null
}

const getDistrictOptionsByState = (stateName: string): SelectOption[] => {
  const selectedStateId = getSelectedStateId(stateName)

  if (!selectedStateId) return []

  return locationDistricts
    .filter(district => Number(district.state_id) === Number(selectedStateId))
    .map(district => ({
      value: district.value,
      label: district.label,
    }))
}

  const getLocationOptions = (prefix: 'billing' | 'shipping', field: 'city' | 'area'): string[] => {
    const currentPincode = String(form[`${prefix}_pincode`] || '').trim()
    const currentState   = String(form[`${prefix}_state`]   || '').trim().toLowerCase()
    const customerValues = customers.filter(c => {
      const pin   = String(c[`${prefix}_pincode`] || '').trim()
      const state = String(c[`${prefix}_state`]   || '').trim().toLowerCase()
      return (currentPincode && pin === currentPincode) || (currentState && state === currentState) || (!currentPincode && !currentState)
    }).map(c => c[`${prefix}_${field}`])
    const childValues = [...billingConsignees, ...billingZones, ...shippingConsignees, ...shippingZones].filter(row => {
      const pin   = String(row.pincode || '').trim()
      const state = String(row.state   || '').trim().toLowerCase()
      return (currentPincode && pin === currentPincode) || (currentState && state === currentState) || (!currentPincode && !currentState)
    }).map(row => row[field])
    return groupTextOptions([form[`${prefix}_${field}`], ...customerValues, ...childValues])
  }

  const addressGrid = (prefix: 'billing' | 'shipping') => {
    const isBilling = prefix === 'billing'
    const orderedKeys = isBilling ? orderedBillingKeys : orderedShippingKeys
    const metaFor = (key: string, fallbackLabel: string, fallbackRequired = isBilling): CustomerFieldMeta => (
      addressFieldMeta[key] ?? { label: fallbackLabel, required: fallbackRequired, visible: true, sortOrder: 0 }
    )

    const renderField = (key: string) => {
      const fallbackLabels: Record<string, string> = {
        [`${prefix}_address`]: 'Street Address',
        [`${prefix}_pincode`]: 'Pincode',
        [`${prefix}_country`]: 'Country',
        [`${prefix}_state`]: 'State',
        [`${prefix}_city`]: 'City / District',
        [`${prefix}_area`]: 'Area / Locality',
      }
      const meta = metaFor(key, fallbackLabels[key] || key)
      if (!meta.visible) return null
      const required = isBilling ? meta.required : meta.required

      if (key.endsWith('_address')) {
        return (
          <Input
            key={key}
            label={meta.label}
            required={required}
            value={form[key as keyof CustomerForm] as string}
            onChange={inputChange(key as keyof CustomerForm)}
            error={required ? errProp(key) : undefined}
          />
        )
      }

      if (key.endsWith('_pincode')) {
  return (
    <Input
      key={key}
      label={meta.label}
      required={required}
      value={form[key as keyof CustomerForm] as string}
      onChange={handlePincodeChange(prefix)}
      maxLength={6}
      inputMode="numeric"
      error={required ? errProp(key) : undefined}
    />
  )
}

      if (key.endsWith('_country')) {
        return (
          <Input
            key={key}
            label={meta.label}
            required={required}
            value={form[key as keyof CustomerForm] as string}
            onChange={inputChange(key as keyof CustomerForm)}
            error={required ? errProp(key) : undefined}
          />
        )
      }

      if (key.endsWith('_state')) {
  return (
    <SearchableSelect
      key={key}
      label={meta.label}
      required={required}
      options={locationStates}
      value={form[key as keyof CustomerForm] as string}
      onChange={(value) => {
        const nextState = value ? String(value) : ''
        setForm(p => ({
          ...p,
          [key]: nextState,
          [`${prefix}_city`]: '',
        }))
        if (required) clearFieldError(key)
        clearFieldError(`${prefix}_city`)
      }}
      placeholder="Select state"
      clearable
      error={required ? errProp(key) : undefined}
    />
  )
}

      if (key.endsWith('_city')) {
  const selectedStateName = String(form[`${prefix}_state`] || '')
  const districtOptions = getDistrictOptionsByState(selectedStateName)

  return (
    <SearchableSelect
      key={key}
      label={meta.label}
      required={required}
      options={districtOptions}
      value={form[key as keyof CustomerForm] as string}
      onChange={(value) => {
        setForm(p => ({
          ...p,
          [key]: value ? String(value) : '',
        }))
        if (required) clearFieldError(key)
      }}
      placeholder={selectedStateName ? 'Select district' : 'Select state first'}
      disabled={!selectedStateName}
      clearable
      error={required ? errProp(key) : undefined}
    />
  )
}

      if (key.endsWith('_area')) {
        return (
          <div key={key}>
            <DropdownTextInput
              label={meta.label}
              required={required}
              value={String(form[key as keyof CustomerForm] || '')}
              options={getLocationOptions(prefix, 'area')}
              onChange={v => { setForm(p => ({ ...p, [key]: v })); if (required) clearFieldError(key) }}
              onCommit={v => setForm(p => ({ ...p, [key]: normalizeIdentityValue(v) }))}
              placeholder="Type or select area"
              error={required ? errProp(key) : undefined}
            />
          </div>
        )
      }

      return null
    }

    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-3 gap-y-2">
        {orderedKeys.map(renderField)}
      </div>
    )
  }

  return (
    <>
      {/* Billing Address */}
      <div className="mb-6">
        <SectionLabel>Billing Address</SectionLabel>
        {addressGrid('billing')}

      </div>

      {/* Divider */}
      <div className="border-t border-dashed border-slate-200 my-6" />

      {/* Shipping Address */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <SectionLabel>Shipping Address</SectionLabel>
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <div onClick={() => { const next = !form.shipping_same_as_billing; setForm(p => ({ ...p, shipping_same_as_billing: next })); if (next) copyBillingToShipping() }}
              className={`w-9 h-5 rounded-full transition-colors flex items-center cursor-pointer ${form.shipping_same_as_billing ? 'bg-indigo-600' : 'bg-gray-200'}`}>
              <div className={`w-3.5 h-3.5 bg-white rounded-full shadow transition-transform mx-0.5 ${form.shipping_same_as_billing ? 'translate-x-4' : 'translate-x-0'}`} />
            </div>
            <span className="text-xs font-medium text-gray-600">Same as billing</span>
          </label>
        </div>
        {!form.shipping_same_as_billing && (
          <div className="flex justify-end mb-3">
            <button type="button" onClick={copyBillingToShipping}
              className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 border border-blue-200 px-2.5 py-1.5 rounded-lg hover:bg-blue-50">
              <Copy size={12} /> Copy from Billing
            </button>
          </div>
        )}
        {form.shipping_same_as_billing ? (
          <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-xl px-4 py-3">
            <Check size={14} className="text-green-500 flex-shrink-0" /> Shipping will be copied from billing on save.
          </div>
        ) : (
          <>
            {addressGrid('shipping')}
            
          </>
        )}
      </div>
    </>
  )
}

// ─── FormCard ─────────────────────────────────────────────────────────────────


// ─── CustomerFormPage ─────────────────────────────────────────────────────────

export default function CustomerFormPage() {
  const { id }        = useParams<{ id: string }>()
  const navigate      = useNavigate()
  const location      = useLocation()
  const editingId     = id ? Number(id) : null
  const isEdit        = Boolean(editingId)

  const { label: moduleLabel, singular, singularLower, labelLower } = useModuleName('customers')
  const currentUser = useCurrentUser()
  const { success, error: showError } = useToast()
  const { setSidebarCollapsed } = useUIStore()

  const sectionIds = NAV_SECTIONS.map(s => s.id)
  const activeSection = useActiveSection(sectionIds)

  useEffect(() => {
    setSidebarCollapsed(true)
    return () => { setSidebarCollapsed(false) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Form state ─────────────────────────────────────────────────────────────
  const [form,               setForm]               = useState<CustomerForm>(emptyForm())
  const { fieldErrors, setFieldErrors, clearFieldError, errProp } = useFieldErrors()
  const setF = (k: string, v: any) => {
    setForm((prev: any) => ({ ...prev, [k]: v }))
    clearFieldError(k)
  }
  const [contacts,           setContacts]           = useState<Contact[]>([emptyContact()])
  const [billingConsignees,  setBillingConsignees]  = useState<AddressEntry[]>([])
  const [billingZones,       setBillingZones]       = useState<AddressEntry[]>([])
  const [shippingConsignees, setShippingConsignees] = useState<AddressEntry[]>([])
  const [shippingZones,      setShippingZones]      = useState<AddressEntry[]>([])
  const [customData,         setCustomData]         = useState<Record<string, unknown>>({})
  const { fields: formConfigFields, bySection: customFieldsBySection } = useFormConfig('customers')
  const [saving,             setSaving]             = useState(false)
  const [loadingData,        setLoadingData]        = useState(isEdit)
  // const [pincodeLoading,     setPincodeLoading]     = useState<'billing' | 'shipping' | null>(null)

  // ── Dropdown data ──────────────────────────────────────────────────────────
  const [verticalOptions,        setVerticalOptions]        = useState<SelectOption[]>([])
  const [verticalOptionsLoading, setVerticalOptionsLoading] = useState(false)
  const [customerDropdownNames,  setCustomerDropdownNames]  = useState<Exclude<DropdownTextOption, string>[]>([])
  const [groupDropdownNames,     setGroupDropdownNames]     = useState<string[]>([])
  const [allUsers,               setAllUsers]               = useState<{ value: number; label: string }[]>([])
  const [teamMemberUsers,        setTeamMemberUsers]        = useState<{ value: number; label: string }[]>([])
  const [customers,              setCustomers]              = useState<any[]>([])
  const [locationStates, setLocationStates] = useState<LocationStateOption[]>([])
  const [locationDistricts, setLocationDistricts] = useState<LocationDistrictOption[]>([])

  // ── Load customer data for edit ────────────────────────────────────────────
  const mapAddr = (arr: any[]): AddressEntry[] =>
    (arr ?? []).map(a => ({ id: a.id, name: a.name ?? '', address: a.address ?? '', pincode: a.pincode ?? '', country: a.country ?? 'India', state: a.state ?? '', city: a.city ?? '', area: a.area ?? '' }))

  const populateFormFromRow = (row: any) => {
    setForm({
      customer_name: row.customer_name ?? '', customer_vertical: row.customer_vertical ?? '',
      division: row.division ?? '', group_name: row.group_name ?? '',
      is_branch: !!(row.is_branch ?? !!row.parent_account_id), parent_account_id: row.parent_account_id ?? null,
      billing_address: row.billing_address ?? '', billing_pincode: row.billing_pincode ?? '',
      billing_country: row.billing_country ?? 'India', billing_state: row.billing_state ?? '',
      billing_city: row.billing_city ?? '', billing_area: row.billing_area ?? '',
      shipping_same_as_billing: row.shipping_same_as_billing ?? true,
      shipping_address: row.shipping_address ?? '', shipping_pincode: row.shipping_pincode ?? '',
      shipping_country: row.shipping_country ?? 'India', shipping_state: row.shipping_state ?? '',
      shipping_city: row.shipping_city ?? '', shipping_area: row.shipping_area ?? '',
      gst_number: row.gst_number ?? '', pan_number: row.pan_number ?? '', website: row.website ?? '',
      account_status: row.account_status ?? 'Prospect', account_potential: row.account_potential ?? 'Medium',
      potential_value: row.potential_value != null ? String(row.potential_value) : '',
      assigned_to: row.assigned_to ?? null, remarks: row.remarks ?? '',
    })
    const ec = (row.contacts ?? []).map((c: any) => ({ id: c.id, contact_name: c.contact_name ?? '', designation: c.designation ?? '', department: c.department ?? '', office_phone: c.office_phone ?? '', mobile: c.mobile ?? '', office_email: c.office_email ?? '', is_primary: c.is_primary ?? false, notes: c.notes ?? '' }))
    setContacts(ec.length > 0 ? ec : [emptyContact()])
    setBillingConsignees(mapAddr(row.billing_consignees))
    setBillingZones(mapAddr(row.billing_zones))
    setShippingConsignees(mapAddr(row.shipping_consignees))
    setShippingZones(mapAddr(row.shipping_zones))
    setCustomData(row.custom_data ?? {})
  }

  useEffect(() => {
    if (!isEdit) return
    const stateCustomer = (location.state as any)?.customer
    if (stateCustomer) { populateFormFromRow(stateCustomer); setLoadingData(false); return }
    setLoadingData(true)
    api.get(`/customers/${editingId}`)
      .then((r: any) => populateFormFromRow(r.data))
      .catch(() => showError('Failed to load customer data'))
      .finally(() => setLoadingData(false))
  }, [editingId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load dropdown data ─────────────────────────────────────────────────────
  useEffect(() => {
    setVerticalOptionsLoading(true)
    Promise.all([
  api.get('/masters/vertical-sectors'),
  api.get('/masters/vertical-sub-sectors'),
  api.get('/customers/name-dropdown'),
  api.get('/customers/group-dropdown'),
  api.get('/masters/users-for-select'),
  api.get('/customers/team-users'),
  api.get('/customers/'),
  api.get('/masters/states'),
  api.get('/masters/districts'),
]).then(([vertRes, subVertRes, nameRes, groupRes, usersRes, teamRes, custRes, statesRes, districtsRes]) => {
      const segmentRows = Array.isArray(vertRes.data) ? vertRes.data : []
      const subSegmentRows = Array.isArray(subVertRes.data) ? subVertRes.data : []
      const subSegmentNameCounts = subSegmentRows.reduce((map: Map<string, number>, row: any) => {
        const name = normalizeIdentityValue(String(row.name ?? ''))
        if (name) map.set(identityKey(name), (map.get(identityKey(name)) || 0) + 1)
        return map
      }, new Map<string, number>())
      const segmentOptions: SelectOption[] = segmentRows
        .map((x: any) => normalizeIdentityValue(String(x.name ?? '')))
        .filter(Boolean)
        .map((name: string) => ({ value: name, label: name, subtitle: 'Customer Segment', subtitleClassName: 'text-slate-500 font-semibold' }))
      const subSegmentOptions: SelectOption[] = subSegmentRows
        .map((x: any) => {
          const subName = normalizeIdentityValue(String(x.name ?? ''))
          const segmentName = normalizeIdentityValue(String(x.sector_name ?? ''))
          if (!subName) return null
          const duplicateSubName = (subSegmentNameCounts.get(identityKey(subName)) || 0) > 1
          return {
            value: duplicateSubName && segmentName ? `${segmentName} / ${subName}` : subName,
            label: subName,
            subtitle: segmentName ? `Customer Segment: ${segmentName}` : 'Customer Sub-segment',
            subtitleClassName: 'text-blue-600 font-semibold',
          } as SelectOption
        })
        .filter(Boolean) as SelectOption[]
      const optionMap = new Map<string, SelectOption>()
      ;[...subSegmentOptions, ...segmentOptions].forEach(option => {
        const key = identityKey(String(option.value))
        if (key && !optionMap.has(key)) optionMap.set(key, option)
      })
      setVerticalOptions(Array.from(optionMap.values()).sort((a, b) => String(a.label).localeCompare(String(b.label))))

      const cn = Array.isArray(nameRes.data) ? nameRes.data.map((x: any) => { const value = normalizeIdentityValue(String(x.customer_name ?? '')); if (!value) return null; return { value, status: normalizeIdentityValue(String(x.approval_status ?? '')).toLowerCase() || null, statusLabel: normalizeIdentityValue(String(x.approval_display ?? '')) || null } }).filter(Boolean) : []
      setCustomerDropdownNames(Array.from(new Map(cn.map((o: any) => [identityKey(o.value), o])).values()).sort((a: any, b: any) => a.value.localeCompare(b.value)))

      const gn = Array.isArray(groupRes.data) ? groupRes.data.map((x: any) => normalizeIdentityValue(String(x.group_name ?? ''))).filter(Boolean) : []
      setGroupDropdownNames(Array.from(new Set(gn.map(identityKey))).map(key => gn.find((n: string) => identityKey(n) === key)!).filter(Boolean).sort((a: string, b: string) => a.localeCompare(b)))

      setAllUsers((usersRes.data as any[]).filter((x: any) => x.label).map((x: any) => ({ value: x.id, label: x.label })))
      setTeamMemberUsers((teamRes.data || []).map((u: any) => ({ value: Number(u.id), label: u.label || u.full_name || u.username })))
      setCustomers(Array.isArray(custRes.data) ? custRes.data : [])
      const stateRows = Array.isArray(statesRes.data) ? statesRes.data : []
setLocationStates(
  stateRows
    .filter((x: any) => x?.name)
    .map((x: any) => ({
      value: x.name,
      label: x.region_name ? `${x.name} - ${x.region_name}` : x.name,
      id: Number(x.id),
      region_id: x.region_id ?? null,
      region_name: x.region_name ?? '',
    }))
)

const districtRows = Array.isArray(districtsRes.data) ? districtsRes.data : []
setLocationDistricts(
  districtRows
    .filter((x: any) => x?.name)
    .map((x: any) => ({
      value: x.name,
      label: x.state_name ? `${x.name} - ${x.state_name}` : x.name,
      id: Number(x.id),
      state_id: Number(x.state_id),
      state_name: x.state_name ?? '',
      region_id: x.region_id ?? null,
      region_name: x.region_name ?? '',
    }))
)
    }).catch(() => {}).finally(() => setVerticalOptionsLoading(false))
  }, [])

  // ── Form helpers ───────────────────────────────────────────────────────────
  const inputChange  = (k: keyof CustomerForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = ['gst_number', 'pan_number'].includes(k) ? e.target.value.toUpperCase() : e.target.value
    setForm(p => ({ ...p, [k]: value }))
    clearFieldError(k)
  }
  const selectChange = (k: keyof CustomerForm) => (v: string | number | null) => {
    setForm(p => ({ ...p, [k]: v }))
    clearFieldError(k)
  }

  // const handlePincodeChange = (prefix: 'billing' | 'shipping') => async (e: React.ChangeEvent<HTMLInputElement>) => {
  //   const value = normalizePincode(e.target.value)
  //   setForm(p => ({ ...p, [`${prefix}_pincode`]: value }))
  //   clearFieldError(`${prefix}_pincode`)
  //   if (value.length !== 6 || !/^\d{6}$/.test(value)) return
  //   setPincodeLoading(prefix)
  //   try {
  //     const r = await api.get(`/customers/pincode/${value}`)
  //     const d = r.data
  //     setForm(p => ({ ...p, [`${prefix}_country`]: d.country || 'India', [`${prefix}_state`]: d.state || '', [`${prefix}_city`]: d.city || '', [`${prefix}_area`]: d.area || '' }))
  //   } catch {}
  //   finally { setPincodeLoading(null) }
  // }

  const handlePincodeChange = (prefix: 'billing' | 'shipping') => (e: React.ChangeEvent<HTMLInputElement>) => {
  const value = normalizePincode(e.target.value)
  setForm(p => ({
    ...p,
    [`${prefix}_pincode`]: value,
  }))
  clearFieldError(`${prefix}_pincode`)
}

  const contactInputChange = (idx: number, k: keyof Contact) => (e: React.ChangeEvent<HTMLInputElement>) => {
    let value = e.target.value
    if (k === 'mobile' || k === 'office_phone') { value = value.replace(/\D/g, ''); if (value.length > 10) return }
    setContacts(prev => { const n = [...prev]; n[idx] = { ...n[idx], [k]: value }; return n })
    clearFieldError(`contact_${idx}_${k}`)
  }
  const setPrimary    = (idx: number) => setContacts(prev => prev.map((c, i) => ({ ...c, is_primary: i === idx })))
  const addContact    = ()            => setContacts(p => [...p, emptyContact()])
  const removeContact = (idx: number) => setContacts(p => p.filter((_, i) => i !== idx))

  // ── Duplicate name check ───────────────────────────────────────────────────
  const editingCustomer = React.useMemo(
    () => customers.find(c => Number(c.id) === Number(editingId)) ?? null,
    [customers, editingId],
  )
  const customerNameConflict = React.useMemo(() => {
    const currentKey = identityKey(form.customer_name)
    if (!currentKey) return null
    if (editingCustomer && currentKey === identityKey(editingCustomer.customer_name)) return null
    return customerDropdownNames.find(o => identityKey(o.value) === currentKey) ?? null
  }, [customerDropdownNames, editingCustomer, form.customer_name])

  const customerNameConflictMessage = React.useMemo(() => {
    if (!customerNameConflict) return null
    if (customerNameConflict.status === 'pending') return `${singular} name "${customerNameConflict.value}" is already pending approval. Please use a different ${singularLower} name.`
    if (customerNameConflict.status === 'rejected') return `${singular} name "${customerNameConflict.value}" already exists with status ${customerNameConflict.statusLabel || 'Rejected'}. Please use a different ${singularLower} name.`
    return `${singular} name "${customerNameConflict.value}" already exists. Please use a different ${singularLower} name.`
  }, [customerNameConflict, singular, singularLower])

  const builtinFieldOverrides = React.useMemo(() => {
    const map = new Map<string, FormFieldConfig>()
    formConfigFields
      .filter(field => !field.is_custom)
      .forEach(field => map.set(`${field.section}.${field.field_key}`, field))
    return map
  }, [formConfigFields])

  const fieldMeta = React.useCallback((section: string, key: string, fallbackLabel: string, fallbackRequired = false, fallbackSortOrder = 0): CustomerFieldMeta => {
    const override = builtinFieldOverrides.get(`${section}.${key}`)
    return {
      label: override?.label || fallbackLabel,
      required: override?.is_required ?? fallbackRequired,
      visible: override?.is_visible ?? true,
      sortOrder: override?.sort_order && override.sort_order > 0 ? override.sort_order : fallbackSortOrder,
    }
  }, [builtinFieldOverrides])

  const accountFieldMeta = React.useMemo(() => ({
    customer_name: fieldMeta('account', 'customer_name', `${singular} / Company / Branch Name`, true),
    website: fieldMeta('account', 'website', 'Website'),
    customer_vertical: fieldMeta('account', 'customer_vertical', `${singular} Segment`, true),
    division: fieldMeta('account', 'division', 'Division / Department', true),
    group_name: fieldMeta('account', 'group_name', 'Group Name', true),
    gst_number: fieldMeta('account', 'gst_number', 'GST Number'),
    pan_number: fieldMeta('account', 'pan_number', 'PAN Number'),
    account_status: fieldMeta('account', 'account_status', 'Status'),
    account_potential: fieldMeta('account', 'account_potential', 'Potential'),
    potential_value: fieldMeta('account', 'potential_value', 'Potential Value (₹)'),
    assigned_to: fieldMeta('account', 'assigned_to', 'Assigned To'),
  }), [fieldMeta, singular])
  const addressFieldMeta = React.useMemo<Record<string, CustomerFieldMeta>>(() => ({
  billing_address: fieldMeta('address', 'billing_address', 'Street Address', true),
  billing_pincode: fieldMeta('address', 'billing_pincode', 'Pincode', true),
  billing_country: { label: 'Country', required: true, visible: true, sortOrder: 0 },
  billing_state: fieldMeta('address', 'billing_state', 'State', true),
  billing_city: fieldMeta('address', 'billing_city', 'City / District', true),
  billing_area: { label: 'Area / Locality', required: true, visible: true, sortOrder: 0 },
  shipping_address: fieldMeta('address', 'shipping_address', 'Street Address'),
  shipping_pincode: fieldMeta('address', 'shipping_pincode', 'Pincode'),
  shipping_country: { label: 'Country', required: false, visible: true, sortOrder: 0 },
  shipping_state: fieldMeta('address', 'shipping_state', 'State'),
  shipping_city: fieldMeta('address', 'shipping_city', 'City / District'),
  shipping_area: { label: 'Area / Locality', required: false, visible: true, sortOrder: 0 },
}), [fieldMeta])
 const contactFieldMeta = React.useMemo<Record<string, CustomerFieldMeta>>(() => ({
  contact_name: fieldMeta('contacts', 'contact_name', 'Full Name', true),
  contact_role: fieldMeta('contacts', 'contact_role', 'Designation', true),
  department: fieldMeta('contacts', 'department', 'Department', true),
  contact_phone: fieldMeta('contacts', 'contact_phone', 'Mobile', true),
  office_phone: fieldMeta('contacts', 'office_phone', 'Office Phone'),
  contact_email: fieldMeta('contacts', 'contact_email', 'Office Email'),
}), [fieldMeta])
  const remarksFieldMeta = React.useMemo<Record<string, CustomerFieldMeta>>(() => ({
    remarks: fieldMeta('remarks', 'remarks', 'Remarks'),
  }), [fieldMeta])
  const canAssignCustomer = CEO_ROLES.includes(currentUser.role) || MANAGER_ROLES.includes(currentUser.role)

  const sortKeysByMeta = React.useCallback((keys: readonly string[], metaMap: Record<string, CustomerFieldMeta>) => (
    [...keys].sort((a, b) => {
      const aDefault = keys.indexOf(a) + 1
      const bDefault = keys.indexOf(b) + 1
      const aOrder = metaMap[a]?.sortOrder && metaMap[a].sortOrder > 0 ? metaMap[a].sortOrder : aDefault
      const bOrder = metaMap[b]?.sortOrder && metaMap[b].sortOrder > 0 ? metaMap[b].sortOrder : bDefault
      if (aOrder !== bOrder) return aOrder - bOrder
      return aDefault - bDefault
    })
  ), [])

  const customFieldsForSection = React.useCallback((section: string) => (
    formConfigFields
      .filter(field => field.section === section && field.is_custom)
      .sort((a, b) => {
        const aOrder = a.sort_order && a.sort_order > 0 ? a.sort_order : Number.MAX_SAFE_INTEGER
        const bOrder = b.sort_order && b.sort_order > 0 ? b.sort_order : Number.MAX_SAFE_INTEGER
        if (aOrder !== bOrder) return aOrder - bOrder
        return a.id - b.id
      })
  ), [formConfigFields])

  const orderedSectionItems = React.useCallback((section: string, keys: readonly string[], metaMap: Record<string, CustomerFieldMeta>): OrderedSectionItem[] => {
    const builtins: OrderedSectionItem[] = keys.map((key, index) => ({
      kind: 'builtin',
      key,
      sortOrder: metaMap[key]?.sortOrder && metaMap[key].sortOrder > 0 ? metaMap[key].sortOrder : index + 1,
      defaultOrder: index + 1,
    }))
    const custom = customFieldsForSection(section).map((field, index) => ({
      kind: 'custom' as const,
      field,
      sortOrder: field.sort_order && field.sort_order > 0 ? field.sort_order : keys.length + index + 1,
      defaultOrder: keys.length + index + 1,
    }))

    return [...builtins, ...custom].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
      return a.defaultOrder - b.defaultOrder
    })
  }, [customFieldsForSection])

  const orderedAccountItems = React.useMemo(
    () => orderedSectionItems('account', ACCOUNT_FIELD_KEYS, accountFieldMeta as Record<string, CustomerFieldMeta>),
    [accountFieldMeta, orderedSectionItems],
  )
  const orderedBillingKeys = React.useMemo(
    () => sortKeysByMeta(BILLING_ADDRESS_KEYS, addressFieldMeta as Record<string, CustomerFieldMeta>),
    [addressFieldMeta, sortKeysByMeta],
  )
  const orderedShippingKeys = React.useMemo(
    () => sortKeysByMeta(SHIPPING_ADDRESS_KEYS, addressFieldMeta as Record<string, CustomerFieldMeta>),
    [addressFieldMeta, sortKeysByMeta],
  )
  const orderedContactKeys = React.useMemo(
    () => sortKeysByMeta(CONTACT_FIELD_KEYS, contactFieldMeta as Record<string, CustomerFieldMeta>) as ContactFieldKey[],
    [contactFieldMeta, sortKeysByMeta],
  )
  const orderedRemarksItems = React.useMemo(
    () => orderedSectionItems('remarks', REMARK_FIELD_KEYS, remarksFieldMeta as Record<string, CustomerFieldMeta>),
    [orderedSectionItems, remarksFieldMeta],
  )
  const orderedAddressCustomFields = React.useMemo(() => customFieldsForSection('address'), [customFieldsForSection])
  const orderedContactCustomFields = React.useMemo(() => customFieldsForSection('contacts'), [customFieldsForSection])

  // ── Validate ───────────────────────────────────────────────────────────────
  const validateForm = () => {
    const errors: Record<string, string> = {}

    // Account details
    const accountRequired = [
      { key: 'customer_name',     ...accountFieldMeta.customer_name },
      { key: 'website',           ...accountFieldMeta.website },
      { key: 'customer_vertical', ...accountFieldMeta.customer_vertical },
      { key: 'division',          ...accountFieldMeta.division },
      { key: 'group_name',        ...accountFieldMeta.group_name },
      { key: 'gst_number',        ...accountFieldMeta.gst_number },
      { key: 'pan_number',        ...accountFieldMeta.pan_number },
      { key: 'account_status',    ...accountFieldMeta.account_status },
      { key: 'account_potential', ...accountFieldMeta.account_potential },
      { key: 'potential_value',   ...accountFieldMeta.potential_value },
      { key: 'assigned_to',       ...accountFieldMeta.assigned_to, visible: accountFieldMeta.assigned_to.visible && canAssignCustomer },
    ].filter(field => field.visible && field.required)
    for (const f of accountRequired) {
      const v = form[f.key as keyof typeof form]
      if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) errors[f.key] = `${f.label} is required`
    }
    if (customerNameConflictMessage) errors.customer_name = customerNameConflictMessage

    // Address
    const addressRequiredKeys: string[] = [...BILLING_ADDRESS_KEYS]
    if (!form.shipping_same_as_billing) addressRequiredKeys.push(...SHIPPING_ADDRESS_KEYS)
    for (const key of addressRequiredKeys) {
      const meta = addressFieldMeta[key]
      if (!meta?.visible || !meta.required) continue
      const v = form[key as keyof typeof form]
      if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) errors[key] = `${meta.label} is required`
    }
    if (addressFieldMeta.billing_pincode.visible && !errors.billing_pincode && form.billing_pincode.trim() && !hasValidPincode(form.billing_pincode.trim()))
      errors.billing_pincode = 'Must be exactly 6 digits'
    if (!form.shipping_same_as_billing && addressFieldMeta.shipping_pincode.visible && form.shipping_pincode.trim() && !hasValidPincode(form.shipping_pincode.trim()))
      errors.shipping_pincode = 'Must be exactly 6 digits'
    if (accountFieldMeta.gst_number.visible && form.gst_number && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i.test(form.gst_number.trim()))
      errors.gst_number = 'Invalid GST (e.g. 22AAAAA0000A1Z5)'
    if (accountFieldMeta.pan_number.visible && form.pan_number && !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i.test(form.pan_number.trim()))
      errors.pan_number = 'Invalid PAN (e.g. ABCDE1234F)'

    // Contacts
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i]
      if (contactFieldMeta.contact_name.visible && contactFieldMeta.contact_name.required && !c.contact_name.trim()) errors[`contact_${i}_contact_name`] = `${contactFieldMeta.contact_name.label} is required`
      if (contactFieldMeta.contact_role.visible && contactFieldMeta.contact_role.required && !c.designation.trim())  errors[`contact_${i}_designation`]  = `${contactFieldMeta.contact_role.label} is required`
      if (contactFieldMeta.department.visible && contactFieldMeta.department.required && !c.department.trim())   errors[`contact_${i}_department`]   = `${contactFieldMeta.department.label} is required`
      if (contactFieldMeta.contact_phone.visible && contactFieldMeta.contact_phone.required && !c.mobile.trim())       errors[`contact_${i}_mobile`]       = `${contactFieldMeta.contact_phone.label} is required`
      else if (contactFieldMeta.contact_phone.visible && c.mobile && c.mobile.length !== 10) errors[`contact_${i}_mobile`]  = 'Must be 10 digits'
      if (contactFieldMeta.contact_email.visible && c.office_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.office_email))
        errors[`contact_${i}_office_email`] = 'Invalid email'
      if (contactFieldMeta.office_phone.visible && c.office_phone && c.office_phone.length !== 10)
        errors[`contact_${i}_office_phone`] = 'Must be 10 digits'
    }

    if (remarksFieldMeta.remarks.visible && remarksFieldMeta.remarks.required && !form.remarks.trim()) {
      errors.remarks = `${remarksFieldMeta.remarks.label} is required`
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      showError('Please fill in all required fields')
      return false
    }
    setFieldErrors({})

    // Address rows (modal-only validation, keep as toast)
    for (let i = 0; i < shippingConsignees.length; i++) {
      const row = shippingConsignees[i]; if (!row.name.trim()) continue
      if (row.pincode.trim() && !hasValidPincode(row.pincode.trim())) { showError(`Shipping Consignee ${i+1}: Pincode must be 6 digits`); return false }
    }
    for (let i = 0; i < shippingZones.length; i++) {
      const row = shippingZones[i]; if (!row.name.trim()) continue
      if (row.pincode.trim() && !hasValidPincode(row.pincode.trim())) { showError(`Shipping Zone ${i+1}: Pincode must be 6 digits`); return false }
    }
    return true
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!validateForm()) return
    const validContacts = contacts.filter(c => c.contact_name.trim())
    if (validContacts.length > 0 && !validContacts.some(c => c.is_primary)) validContacts[0].is_primary = true
    setSaving(true)
    try {
      const shipCons  = form.shipping_same_as_billing ? billingConsignees.map(e => ({ ...e, id: undefined })) : shippingConsignees
      const shipZones = form.shipping_same_as_billing ? billingZones.map(e => ({ ...e, id: undefined }))      : shippingZones
      const payload = {
        ...form,
        customer_name:       normalizeIdentityValue(form.customer_name),
        group_name:          normalizeIdentityValue(form.group_name),
        potential_value:     form.potential_value !== '' ? Number(form.potential_value) : null,
        contacts:            validContacts,
        billing_consignees:  billingConsignees.filter(e => e.name.trim()),
        billing_zones:       billingZones.filter(e => e.name.trim()),
        shipping_consignees: shipCons.filter(e => e.name.trim()),
        shipping_zones:      shipZones.filter(e => e.name.trim()),
        custom_data:         Object.keys(customData).length ? customData : null,
      }
      if (editingId) {
        await api.put(`/customers/${editingId}`, payload)
        success(`${singular} updated`)
      } else {
        const res = await api.post('/customers/', payload)
        if (res.data?.approval_status === 'pending') {
          success(`${singular} submitted for approval${res.data?.approval_progress_total ? ` (${res.data?.approval_progress_current ?? 0}/${res.data.approval_progress_total})` : ''}`)
        } else {
          success(`${singular} created successfully`)
        }
      }
      navigate('/customers')
    } catch (e: any) {
      showError(e.response?.data?.detail || `Failed to save ${singularLower}`)
    } finally { setSaving(false) }
  }

  const assignableUsers = React.useMemo(() => {
    if (CEO_ROLES.includes(currentUser.role)) return allUsers
    return teamMemberUsers
  }, [currentUser.role, allUsers, teamMemberUsers])

  const parentOptions = customers.filter(c => c.id !== editingId).map(c => ({ value: c.id, label: c.customer_name }))

  const renderCustomField = (section: string, field: FormFieldConfig) => (
    <CustomFields
      key={`custom-${section}-${field.id}`}
      section={section}
      fields={[field]}
      values={customData}
      onChange={(k, v) => setCustomData(p => ({ ...p, [k]: v }))}
    />
  )

  const renderAccountField = (key: string) => {
    const fieldKey = key as AccountFieldKey
    const meta = accountFieldMeta[fieldKey]
    if (!meta?.visible) return null

    if (fieldKey === 'customer_name') {
      return (
        <React.Fragment key={fieldKey}>
          <DropdownTextInput
            label={meta.label}
            required={meta.required}
            value={form.customer_name}
            onChange={next => setF('customer_name', next)}
            onCommit={draft => { const n = normalizeIdentityValue(draft); if (n !== draft) setF('customer_name', n) }}
            error={customerNameConflictMessage || errProp('customer_name')}
            options={customerDropdownNames}
            labelAction={
              <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 cursor-pointer select-none whitespace-nowrap">
                <input type="checkbox" checked={form.is_branch}
                  onChange={e => setForm(f => ({ ...f, is_branch: e.target.checked, parent_account_id: e.target.checked ? f.parent_account_id : null }))}
                  className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 cursor-pointer" />
                <span>Branch Account</span>
              </label>
            }
            placeholder={`Type ${singularLower} name`}
          />
          {form.is_branch && (
            <SearchableSelect
              label="Parent Account"
              placeholder={`Search existing ${labelLower}...`}
              options={parentOptions}
              value={form.parent_account_id}
              onChange={selectChange('parent_account_id')}
            />
          )}
        </React.Fragment>
      )
    }

    if (fieldKey === 'website') {
      return <Input key={fieldKey} label={meta.label} required={meta.required} value={form.website} onChange={inputChange('website')} error={errProp('website')} />
    }

    if (fieldKey === 'customer_vertical') {
      return (
        <SearchableSelect
          key={fieldKey}
          label={meta.label}
          required={meta.required}
          options={verticalOptions}
          value={form.customer_vertical}
          onChange={v => { selectChange('customer_vertical')(v); clearFieldError('customer_vertical') }}
          loading={verticalOptionsLoading}
          error={errProp('customer_vertical')}
        />
      )
    }

    if (fieldKey === 'division') {
      return <Input key={fieldKey} label={meta.label} value={form.division} required={meta.required} onChange={inputChange('division')} error={errProp('division')} />
    }

    if (fieldKey === 'group_name') {
      return (
        <DropdownTextInput
          key={fieldKey}
          label={meta.label}
          required={meta.required}
          value={form.group_name}
          onChange={next => setF('group_name', next)}
          onCommit={draft => { const n = normalizeIdentityValue(draft); if (n !== draft) setF('group_name', n) }}
          options={groupDropdownNames}
          placeholder="Type group name"
          error={errProp('group_name')}
        />
      )
    }

    if (fieldKey === 'gst_number') {
      return <Input key={fieldKey} label={meta.label} required={meta.required} value={form.gst_number} onChange={inputChange('gst_number')} error={errProp('gst_number')} />
    }

    if (fieldKey === 'pan_number') {
      return <Input key={fieldKey} label={meta.label} required={meta.required} value={form.pan_number} onChange={inputChange('pan_number')} error={errProp('pan_number')} />
    }

    if (fieldKey === 'account_status') {
      return (
        <SearchableSelect
          key={fieldKey}
          label={meta.label}
          required={meta.required}
          options={STATUSES.map(s => ({ value: s, label: s }))}
          value={form.account_status}
          onChange={selectChange('account_status')}
          error={errProp('account_status')}
        />
      )
    }

    if (fieldKey === 'account_potential') {
      return (
        <SearchableSelect
          key={fieldKey}
          label={meta.label}
          required={meta.required}
          options={POTENTIALS.map(p => ({ value: p, label: p }))}
          value={form.account_potential}
          onChange={selectChange('account_potential')}
          error={errProp('account_potential')}
        />
      )
    }

    if (fieldKey === 'potential_value') {
      return (
        <div key={fieldKey}>
          <Input
            label={meta.label}
            required={meta.required}
            numberOnly
            placeholder="e.g. 500000"
            value={form.potential_value || ''}
            onChange={(v: any) => { const raw = String(v?.target?.value ?? v ?? '').replace(/\D/g, ''); setF('potential_value', raw) }}
            error={errProp('potential_value')}
          />
          {form.potential_value && <p className="text-xs text-slate-400 mt-1 italic">{numberToWords(Number(form.potential_value))}</p>}
        </div>
      )
    }

    if (fieldKey === 'assigned_to' && canAssignCustomer) {
      return (
        <SearchableSelect
          key={fieldKey}
          label={meta.label}
          required={meta.required}
          options={assignableUsers}
          value={form.assigned_to}
          onChange={selectChange('assigned_to')}
          error={errProp('assigned_to')}
          clearable
        />
      )
    }

    return null
  }

  const renderContactField = (c: Contact, idx: number, key: ContactFieldKey) => {
    const meta = contactFieldMeta[key]
    if (!meta?.visible) return null

    if (key === 'contact_name') return <Input key={key} label={meta.label} required={meta.required} value={c.contact_name} onChange={contactInputChange(idx, 'contact_name')} error={errProp(`contact_${idx}_contact_name`)} />
    if (key === 'contact_role') return <Input key={key} label={meta.label} required={meta.required} value={c.designation} onChange={contactInputChange(idx, 'designation')} error={errProp(`contact_${idx}_designation`)} />
    if (key === 'department') return <Input key={key} label={meta.label} required={meta.required} value={c.department} onChange={contactInputChange(idx, 'department')} error={errProp(`contact_${idx}_department`)} />
    if (key === 'contact_phone') return <Input key={key} label={meta.label} required={meta.required} value={c.mobile} onChange={contactInputChange(idx, 'mobile')} maxLength={10} error={errProp(`contact_${idx}_mobile`)} />
    if (key === 'office_phone') return <Input key={key} label={meta.label} required={meta.required} value={c.office_phone} onChange={contactInputChange(idx, 'office_phone')} maxLength={10} error={errProp(`contact_${idx}_office_phone`)} />
    if (key === 'contact_email') return <Input key={key} label={meta.label} required={meta.required} value={c.office_email} onChange={contactInputChange(idx, 'office_email')} error={errProp(`contact_${idx}_office_email`)} />
    return null
  }

  const scrollTo = (id: string) => {
    const el = document.getElementById(`section-${id}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loadingData) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="w-full">
        <div className="bg-white border border-slate-200 shadow-sm">

          <FormPageHeader
            breadcrumb={moduleLabel}
            onBreadcrumbClick={() => navigate('/customers')}
            title={singular}
            isEdit={isEdit}
            onCancel={() => navigate('/customers')}
            onSave={handleSave}
            saving={saving}
          />

          <main className="min-w-0">
          {/* ── Account Details ── */}
          <FormCard id="account" title="Account Details" icon={Building2}>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-3 gap-y-2">
              {orderedAccountItems.map(item => (
                item.kind === 'custom'
                  ? renderCustomField('account', item.field)
                  : renderAccountField(item.key)
              ))}
            </div>
            {false && (
            <div className="space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-3 gap-y-2 items-end">
              {accountFieldMeta.customer_name.visible && (
                <DropdownTextInput
                  label={accountFieldMeta.customer_name.label}
                  required={accountFieldMeta.customer_name.required}
                  value={form.customer_name}
                  onChange={next => setF('customer_name', next)}
                  onCommit={draft => { const n = normalizeIdentityValue(draft); if (n !== draft) setF('customer_name', n) }}
                  error={customerNameConflictMessage || errProp('customer_name')}
                  options={customerDropdownNames}
                  labelAction={
                    <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 cursor-pointer select-none whitespace-nowrap">
                      <input type="checkbox" checked={form.is_branch}
                        onChange={e => setForm(f => ({ ...f, is_branch: e.target.checked, parent_account_id: e.target.checked ? f.parent_account_id : null }))}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-indigo-600 cursor-pointer" />
                      <span>Branch Account</span>
                    </label>
                  }
                  placeholder={`Type ${singularLower} name`}
                />
              )}

              {accountFieldMeta.website.visible && (
                <Input
                  label={accountFieldMeta.website.label}
                  required={accountFieldMeta.website.required}
                  value={form.website}
                  onChange={inputChange('website')}
                  error={errProp('website')}
                />
              )}

              {accountFieldMeta.customer_vertical.visible && (
                <SearchableSelect
                  label={accountFieldMeta.customer_vertical.label}
                  required={accountFieldMeta.customer_vertical.required}
                  options={verticalOptions}
                  value={form.customer_vertical}
                  onChange={v => { selectChange('customer_vertical')(v); clearFieldError('customer_vertical') }}
                  loading={verticalOptionsLoading}
                  error={errProp('customer_vertical')}
                />
              )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-3 gap-y-2">

              {form.is_branch && (
                <SearchableSelect label="Parent Account" placeholder={`Search existing ${labelLower}…`} options={parentOptions} value={form.parent_account_id} onChange={selectChange('parent_account_id')} />
              )}
              {accountFieldMeta.division.visible && (
                <Input
                  label={accountFieldMeta.division.label}
                  value={form.division}
                  required={accountFieldMeta.division.required}
                  onChange={inputChange('division')}
                  error={errProp('division')}
                />
              )}
              {accountFieldMeta.group_name.visible && (
                <DropdownTextInput
                  label={accountFieldMeta.group_name.label}
                  required={accountFieldMeta.group_name.required}
                  value={form.group_name}
                  onChange={next => setF('group_name', next)}
                  onCommit={draft => { const n = normalizeIdentityValue(draft); if (n !== draft) setF('group_name', n) }}
                  options={groupDropdownNames}
                  placeholder="Type group name"
                  error={errProp('group_name')}
                />
              )}

              {accountFieldMeta.gst_number.visible && (
                <Input
                  label={accountFieldMeta.gst_number.label}
                  required={accountFieldMeta.gst_number.required}
                  value={form.gst_number}
                  onChange={inputChange('gst_number')}
                  error={errProp('gst_number')}
                />
              )}
              {accountFieldMeta.pan_number.visible && (
                <Input
                  label={accountFieldMeta.pan_number.label}
                  required={accountFieldMeta.pan_number.required}
                  value={form.pan_number}
                  onChange={inputChange('pan_number')}
                  error={errProp('pan_number')}
                />
              )}

              {accountFieldMeta.account_status.visible && (
                <SearchableSelect
                  label={accountFieldMeta.account_status.label}
                  required={accountFieldMeta.account_status.required}
                  options={STATUSES.map(s => ({ value: s, label: s }))}
                  value={form.account_status}
                  onChange={selectChange('account_status')}
                  error={errProp('account_status')}
                />
              )}
              {accountFieldMeta.account_potential.visible && (
                <SearchableSelect
                  label={accountFieldMeta.account_potential.label}
                  required={accountFieldMeta.account_potential.required}
                  options={POTENTIALS.map(p => ({ value: p, label: p }))}
                  value={form.account_potential}
                  onChange={selectChange('account_potential')}
                  error={errProp('account_potential')}
                />
              )}
              {accountFieldMeta.potential_value.visible && (
                <div>
                  <Input
                    label={accountFieldMeta.potential_value.label}
                    required={accountFieldMeta.potential_value.required}
                    numberOnly
                    placeholder="e.g. 500000"
                    value={form.potential_value || ''}
                    onChange={(v: any) => { const raw = String(v?.target?.value ?? v ?? '').replace(/\D/g, ''); setF('potential_value', raw) }}
                    error={errProp('potential_value')}
                  />
                  {form.potential_value && <p className="text-xs text-slate-400 mt-1 italic">{numberToWords(Number(form.potential_value))}</p>}
                </div>
              )}

              {accountFieldMeta.assigned_to.visible && canAssignCustomer && (
                <SearchableSelect
                  label={accountFieldMeta.assigned_to.label}
                  required={accountFieldMeta.assigned_to.required}
                  options={assignableUsers}
                  value={form.assigned_to}
                  onChange={selectChange('assigned_to')}
                  error={errProp('assigned_to')}
                  clearable
                />
              )}
              <CustomFields
                section="account"
                fields={customFieldsBySection['account'] ?? []}
                values={customData}
                onChange={(k, v) => setCustomData(p => ({ ...p, [k]: v }))}
              />
              </div>
            </div>
            )}
          </FormCard>

          {/* ── Address ── */}
          <FormCard id="address" title="Address" icon={MapPin}>
            <AddressSections
              form={form} setForm={setForm} editingId={editingId} customers={customers}
              billingConsignees={billingConsignees}   setBillingConsignees={setBillingConsignees}
              billingZones={billingZones}             setBillingZones={setBillingZones}
              shippingConsignees={shippingConsignees} setShippingConsignees={setShippingConsignees}
              shippingZones={shippingZones}           setShippingZones={setShippingZones}
              locationStates={locationStates}
              locationDistricts={locationDistricts}
              handlePincodeChange={handlePincodeChange}
              inputChange={inputChange}
              fieldErrors={fieldErrors}
              clearFieldError={clearFieldError}
              addressFieldMeta={addressFieldMeta}
              orderedBillingKeys={orderedBillingKeys}
              orderedShippingKeys={orderedShippingKeys}
            />
            <CustomFields
              section="address"
              fields={orderedAddressCustomFields}
              values={customData}
              onChange={(k, v) => setCustomData(p => ({ ...p, [k]: v }))}
            />
          </FormCard>

          {/* ── Contacts ── */}
          <FormCard
            id="contacts"
            title="Contacts"
            icon={Users}
            action={
              <button type="button" onClick={addContact}
                className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-700 font-semibold border border-indigo-200 hover:border-indigo-300 px-3 py-1.5 rounded-lg hover:bg-indigo-50 transition-colors">
                <UserPlus size={13} /> Add Contact
              </button>
            }
          >
            <div className="space-y-3">
              {contacts.map((c, idx) => (
                <div key={idx} className="border border-slate-200 rounded-xl overflow-hidden">
                  {/* Contact header bar */}
                  <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-100">
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Contact {idx + 1}</span>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="radio" name="primary_contact" checked={c.is_primary} onChange={() => setPrimary(idx)} className="text-indigo-600" />
                        <span className="text-xs text-slate-500">Primary</span>
                      </label>
                      {c.is_primary && (
                        <span className="text-[10px] bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-bold border border-indigo-200">
                          PRIMARY
                        </span>
                      )}
                    </div>
                    {contacts.length > 1 && (
                      <IconBtn tooltip="Remove contact" color="red" onClick={() => removeContact(idx)}>
                        <Trash2 size={14} />
                      </IconBtn>
                    )}
                  </div>
                  {/* Contact fields */}
                  <div className="p-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-3 gap-y-2">
                      {orderedContactKeys.map(key => renderContactField(c, idx, key))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <CustomFields
              section="contacts"
              fields={orderedContactCustomFields}
              values={customData}
              onChange={(k, v) => setCustomData(p => ({ ...p, [k]: v }))}
            />
          </FormCard>

          {/* ── Remarks ── */}
          <FormCard id="remarks" title="Remarks / Notes" icon={MessageSquare}>
            <div className="grid grid-cols-1 gap-x-3 gap-y-2">
              {orderedRemarksItems.map(item => (
                item.kind === 'custom'
                  ? renderCustomField('remarks', item.field)
                  : remarksFieldMeta.remarks.visible && (
                    <FormField
                      key="remarks"
                      label={remarksFieldMeta.remarks.label}
                      required={remarksFieldMeta.remarks.required}
                      error={errProp('remarks')}
                    >
                      <textarea
                        value={form.remarks}
                        onChange={e => { setForm(p => ({ ...p, remarks: e.target.value })); clearFieldError('remarks') }}
                        rows={4}
                        placeholder={`Any additional notes about this ${singularLower}...`}
                        className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/15 resize-none transition-all text-slate-700 placeholder:text-slate-300"
                      />
                    </FormField>
                  )
              ))}
            </div>
            {false && (
            <>
            <textarea
              value={form.remarks}
              onChange={e => setForm(p => ({ ...p, remarks: e.target.value }))}
              rows={4}
              placeholder={`Any additional notes about this ${singularLower}…`}
              className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/15 resize-none transition-all text-slate-700 placeholder:text-slate-300"
            />
            <CustomFields
              section="remarks"
              fields={customFieldsBySection['remarks'] ?? []}
              values={customData}
              onChange={(k, v) => setCustomData(p => ({ ...p, [k]: v }))}
            />
            </>
            )}
          </FormCard>

          {/* ── Bottom actions ── */}
         
        </main>
        </div>
      </div>
    </div>
  )
}
