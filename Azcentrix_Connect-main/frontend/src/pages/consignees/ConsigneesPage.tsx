/**
 * ConsigneesPage — Standalone module for managing tender consignees
 *
 * Features:
 *  - Table: all consignees across Won tenders (filterable by tender / search)
 *  - Add Panel: select a Won tender, then add one or many consignee rows
 *  - Edit Panel: edit an existing consignee
 *  - Delete: with confirmation
 *  - Excel Import: upload .xlsx → bulk-create for a chosen tender
 *  - Sample Download: styled template with headers + 1 sample row
 */
import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  MapPin, Plus, Pencil, Trash2, Upload, FileText,
  Loader2, X, Phone, Mail, User as UserIcon, Search,
  Building2, Package,
} from 'lucide-react'
import api from '@/services/api'
import { PageHeader, StatCard, useToast } from '@/components/ui/FormComponents'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { confirmAction } from '@/utils/sweetAlert'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { mapApiErrors, type FieldSpec } from '@/utils/validation'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Consignee {
  id:             number
  tender_num:     string
  tender_title:   string
  customer_name:  string
  name:           string
  contact_person: string | null
  contact_number: string | null
  email:          string | null
  address:        string | null
  city:           string | null
  state:          string | null
  pincode:        string | null
  country:        string | null
  notes:          string | null
  created_at:     string | null
}

const emptyRow = () => ({
  name:           '',
  contact_person: '',
  contact_number: '',
  email:          '',
  address:        '',
  city:           '',
  state:          '',
  pincode:        '',
  country:        'India',
  notes:          '',
})

// field rules for the consignee panel (name 2–255 as on the backend; phone = 10-digit mobile; Indian pincode)
const CONS_SPEC: Record<string, FieldSpec> = {
  name:           { label: 'Consignee name', rule: 'name', required: true, min: 2, max: 255 },
  contact_person: { label: 'Contact person', rule: 'name', min: 2, max: 255 },
  contact_number: { label: 'Contact number', rule: 'mobile' },
  email:          { label: 'Email', rule: 'email' },
  address:        { label: 'Address', rule: 'textarea', max: 500 },
  city:           { label: 'City', rule: 'text', min: 2, max: 100 },
  state:          { label: 'State', rule: 'text', min: 2, max: 100 },
  pincode:        { label: 'Pincode', rule: 'pincode' },
  country:        { label: 'Country', rule: 'text', min: 2, max: 100 },
  notes:          { label: 'Notes', rule: 'textarea', max: 2000 },
}
const CONS_FIELDS = Object.keys(CONS_SPEC)
const TENDER_SPEC: FieldSpec = { label: 'Tender', rule: 'select', required: true }
const consCls = (bad?: string) => (bad ? ' !border-red-500' : '')

// ─── Excel helpers ────────────────────────────────────────────────────────────

// Column keys match what backend bulk-import normalises: str.lower().replace(" ","_")
const CONSIGNEE_COLS = [
  { header: 'consignee_name', label: 'Consignee Name *', width: 36 },
  { header: 'address',        label: 'Address',           width: 45 },
  { header: 'city',           label: 'City',              width: 18 },
  { header: 'state',          label: 'State',             width: 18 },
  { header: 'pincode',        label: 'Pincode',           width: 14 },
  { header: 'contact_person', label: 'Contact Person',    width: 28 },
  { header: 'contact_phone',  label: 'Contact Phone',     width: 20 },
  { header: 'delivery_date',  label: 'Delivery Date',     width: 18 },
  { header: 'notes',          label: 'Notes',             width: 35 },
]

async function downloadSample() {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Consignee Import')

  // Row 1 = machine-readable headers (backend reads from row 1)
  ws.columns = CONSIGNEE_COLS.map(c => ({ header: c.header, key: c.header, width: c.width }))

  const hr = ws.getRow(1)
  CONSIGNEE_COLS.forEach((c, i) => {
    const cell = hr.getCell(i + 1)
    cell.value = c.header
    cell.font  = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF059669' } }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
  })
  hr.height = 22

  // Row 2 = sample data
  ws.addRow({
    consignee_name: 'ABC Railways Division',
    address:        'Plot 12, Industrial Area',
    city:           'Nagpur',
    state:          'Maharashtra',
    pincode:        '440001',
    contact_person: 'Rajesh Kumar',
    contact_phone:  '9876543210',
    delivery_date:  '2025-06-30',
    notes:          'Deliver between 9AM-5PM on weekdays',
  })
  ws.views = [{ state: 'frozen', ySplit: 1 }]

  const buf  = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = 'consignee_import_template.xlsx'; a.click()
  URL.revokeObjectURL(url)
}

// ─── ConsigneesPage ───────────────────────────────────────────────────────────

export default function ConsigneesPage() {
  const [rows,         setRows]         = useState<Consignee[]>([])
  const [loading,      setLoading]      = useState(true)
  const [tenderOpts,   setTenderOpts]   = useState<{ value: string; label: string }[]>([])
  const [filterTender, setFilterTender] = useState<string | null>(null)
  const [search,       setSearch]       = useState('')
  const [panelMode,    setPanelMode]    = useState<'add' | 'edit' | null>(null)
  const [editTarget,   setEditTarget]   = useState<Consignee | null>(null)
  const [importing,    setImporting]    = useState(false)
  const [importTender, setImportTender] = useState<string | null>(null)
  const fileRef                         = useRef<HTMLInputElement | null>(null)
  const { success, error: showError }   = useToast()

  // ── Load ──────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, unknown> = {}
      if (filterTender) params.tender_num = filterTender
      if (search.trim()) params.search   = search.trim()
      const res = await api.get('/tenders/consignees/', { params })
      setRows(res.data)
    } catch { showError('Failed to load consignees') }
    finally { setLoading(false) }
  }, [filterTender, search])

  const loadTenders = async () => {
    try {
      const res = await api.get('/tenders/won-dropdown')
      setTenderOpts(res.data)
    } catch {}
  }

  useEffect(() => { loadTenders() }, [])
  useEffect(() => { load() }, [load])

  // ── Delete ────────────────────────────────────────────────────────────────

  const handleDelete = async (c: Consignee) => {
    const confirmed = await confirmAction({
      title: 'Delete consignee?',
      text: `"${c.name}" will be removed.`,
      confirmButtonText: 'Delete',
      icon: 'warning',
    })
    if (!confirmed) return
    try {
      await api.delete(`/tenders/${c.tender_num}/consignees/${c.id}`)
      success('Consignee deleted')
      load()
    } catch { showError('Failed to delete') }
  }

  // ── Excel import ──────────────────────────────────────────────────────────

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !importTender) return
    setImporting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api.post(
        `/tenders/${importTender}/consignees/import`,
        fd,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      )
      success(res.data.message)
      load()
    } catch (err: any) {
      showError(err.response?.data?.detail || 'Import failed.')
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const triggerImport = () => {
    if (!importTender) { showError('Please select a tender first'); return }
    fileRef.current?.click()
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  const uniqueTenders = new Set(rows.map(r => r.tender_num)).size

  return (
    <div className="p-6">
      {/* Hidden file input */}
      <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImportFile} />

      <PageHeader
        title="Consignees"
        subtitle="Delivery / dispatch consignees for Won tenders"
        breadcrumb={['Tenders', 'Consignees']}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={downloadSample}
              className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl border border-gray-200 text-gray-600 hover:text-emerald-700 hover:border-emerald-300 hover:bg-emerald-50 transition-colors">
              <FileText size={14} /> Sample Excel
            </button>
            <button
              disabled={importing}
              onClick={triggerImport}
              className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 transition-colors">
              {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              {importing ? 'Importing…' : 'Import Excel'}
            </button>
            <button
              onClick={() => { setEditTarget(null); setPanelMode('add') }}
              className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-xl bg-emerald-600 text-white font-semibold hover:bg-emerald-700 transition-colors">
              <Plus size={14} /> Add Consignee
            </button>
          </div>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard title="Total Consignees" value={rows.length}       icon={<MapPin size={20} />}    color="green" />
        <StatCard title="Linked Tenders"   value={uniqueTenders}     icon={<FileText size={20} />}  color="blue"    />
        <StatCard title="Won Tenders"       value={tenderOpts.length} icon={<Package size={20} />}   color="green"   />
        <StatCard title="Filtered"          value={rows.length}       icon={<Building2 size={20} />} color="indigo"  />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search consignee name…"
            className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-400 bg-white"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X size={13} />
            </button>
          )}
        </div>
        <div className="min-w-[280px]">
          <SearchableSelect
            options={[{ value: '', label: 'All Tenders' }, ...tenderOpts]}
            value={filterTender ?? ''}
            onChange={v => setFilterTender(v === '' ? null : (v as string))}
            placeholder="Filter by Tender…"
          />
        </div>
        {/* Import tender selector */}
        <div className="min-w-[280px]">
          <SearchableSelect
            options={tenderOpts}
            value={importTender}
            onChange={v => setImportTender(v as string)}
            placeholder="Select tender for import…"
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <Loader2 size={24} className="animate-spin mr-2" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <MapPin size={40} className="mb-3 opacity-25" />
          <p className="font-medium">No consignees found</p>
          <p className="text-sm mt-1">Add consignees for Won tenders using the button above.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Tender</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Consignee Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Contact</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Address</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide w-20">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(c => (
                <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                  {/* Tender */}
                  <td className="px-4 py-3">
                    <p className="font-semibold text-blue-700 text-xs">{c.tender_num}</p>
                    <p className="text-xs text-gray-500 truncate max-w-[160px]">{c.tender_title || c.customer_name}</p>
                  </td>
                  {/* Consignee */}
                  <td className="px-4 py-3">
                    <p className="font-semibold text-gray-800">{c.name}</p>
                    {c.contact_person && (
                      <p className="text-xs text-gray-500 flex items-center gap-1">
                        <UserIcon size={10} /> {c.contact_person}
                      </p>
                    )}
                  </td>
                  {/* Contact */}
                  <td className="px-4 py-3">
                    {c.contact_number && (
                      <p className="text-xs text-gray-600 flex items-center gap-1">
                        <Phone size={10} /> {c.contact_number}
                      </p>
                    )}
                    {c.email && (
                      <p className="text-xs text-gray-600 flex items-center gap-1">
                        <Mail size={10} /> {c.email}
                      </p>
                    )}
                  </td>
                  {/* Address */}
                  <td className="px-4 py-3">
                    <p className="text-xs text-gray-600 max-w-[200px]">
                      {[c.address, c.city, c.state, c.pincode].filter(Boolean).join(', ') || '—'}
                    </p>
                    {c.notes && <p className="text-xs text-gray-400 italic mt-0.5 truncate max-w-[200px]">{c.notes}</p>}
                  </td>
                  {/* Actions */}
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => { setEditTarget(c); setPanelMode('edit') }}
                        className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors">
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(c)}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / Edit Panel */}
      {panelMode && (
        <ConsigneePanel
          mode={panelMode}
          target={editTarget}
          tenderOpts={tenderOpts}
          onClose={() => { setPanelMode(null); setEditTarget(null) }}
          onSaved={() => { setPanelMode(null); setEditTarget(null); load() }}
        />
      )}
    </div>
  )
}

// ─── ConsigneePanel ───────────────────────────────────────────────────────────

function ConsigneePanel({
  mode, target, tenderOpts, onClose, onSaved,
}: {
  mode:       'add' | 'edit'
  target:     Consignee | null
  tenderOpts: { value: string; label: string }[]
  onClose:    () => void
  onSaved:    () => void
}) {
  const isEdit                        = mode === 'edit'
  const [tenderId,   setTenderId]     = useState<string | null>(target?.tender_num ?? null)
  const [formRows,   setFormRows]     = useState<ReturnType<typeof emptyRow>[]>(
    isEdit && target
      ? [{ name: target.name, contact_person: target.contact_person ?? '',
           contact_number: target.contact_number ?? '', email: target.email ?? '',
           address: target.address ?? '', city: target.city ?? '',
           state: target.state ?? '', pincode: target.pincode ?? '',
           country: target.country ?? 'India', notes: target.notes ?? '' }]
      : [emptyRow()]
  )
  const [saving,     setSaving]       = useState(false)
  const { success, error: showError } = useToast()
  const fe = useFieldErrors()
  const errs = fe.errors

  const updateRow = (i: number, k: string, v: string) => {
    setFormRows(p => { const n = [...p]; n[i] = { ...n[i], [k]: v }; return n })
    fe.change(`${i}.${k}`, v, CONS_SPEC[k])
  }
  const leaveRow = (i: number, k: string) => () => fe.blur(`${i}.${k}`, (formRows[i] as any)?.[k], CONS_SPEC[k])
  // attributes shared by every validated input: id (for focus), aria-invalid / describedby
  const fa = (i: number, k: string) => ({ id: `cn-${i}-${k}`, onBlur: leaveRow(i, k), 'aria-invalid': errs[`${i}.${k}`] ? true : undefined,
    'aria-describedby': errs[`${i}.${k}`] ? `cn-${i}-${k}-err` : undefined })
  const focusId = (id: string) => setTimeout(() => {
    const el = document.getElementById(id)
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() }
  }, 0)

  const addRow = () => setFormRows(p => [...p, emptyRow()])

  const removeRow = (i: number) => {
    setFormRows(p => p.filter((_, idx) => idx !== i))
    fe.clear()   // row positions shift – messages are re-checked on the next edit / save
  }

  const handleSave = async () => {
    const values: Record<string, string | null> = { tender: isEdit ? 'x' : tenderId }
    const specs: Record<string, FieldSpec> = { tender: TENDER_SPEC }
    formRows.forEach((r, i) => CONS_FIELDS.forEach(k => { values[`${i}.${k}`] = (r as any)[k]; specs[`${i}.${k}`] = CONS_SPEC[k] }))
    const bad = fe.validateAll(values, specs)
    if (Object.keys(bad).length) {
      if (bad.tender) { focusId('cn-tender'); return }
      const first = formRows.flatMap((_, i) => CONS_FIELDS.map(k => `${i}.${k}`)).find(k => bad[k])
      if (first) { const [i, k] = first.split('.'); focusId(`cn-${i}-${k}`) }
      return
    }

    setSaving(true)
    try {
      if (isEdit && target) {
        await api.put(`/tenders/${target.tender_num}/consignees/${target.id}`, formRows[0])
        success('Consignee updated')
      } else {
        await Promise.all(
          formRows.map(r => api.post(`/tenders/${tenderId}/consignees`, r))
        )
        success(`${formRows.length} consignee(s) added`)
      }
      onSaved()
    } catch (err: any) {
      // field errors from the API go under the fields of the (single) row they belong to; anything else is a toast
      const fx: Record<string, string> = formRows.length === 1
        ? Object.fromEntries(Object.entries(mapApiErrors(err, { consignee_name: 'name', contact: 'contact_person', contact_phone: 'contact_number' }))
          .filter(([k]) => CONS_SPEC[k]).map(([k, m]) => [`0.${k}`, m]))
        : {}
      if (Object.keys(fx).length) {
        fe.setErrors(e => ({ ...e, ...fx }))
        const k = CONS_FIELDS.find(f => fx[`0.${f}`]); if (k) focusId(`cn-0-${k}`)
      } else {
        const d = err.response?.data?.detail
        showError(typeof d === 'string' ? d : Array.isArray(d) && d[0]?.msg ? String(d[0].msg).replace(/^Value error, /, '') : 'Failed to save')
      }
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-2xl bg-white h-full flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-emerald-50">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-200 flex items-center justify-center">
              <MapPin size={15} className="text-emerald-700" />
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-800">
                {isEdit ? 'Edit Consignee' : 'Add Consignees'}
              </h2>
              <p className="text-xs text-gray-500">
                {isEdit ? target?.tender_num : 'Select a Won tender, then fill consignee rows'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white text-gray-400">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Tender picker (Add mode only) */}
          {!isEdit && (
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">
                Tender <span className="text-red-500">*</span>
              </label>
              <div id="cn-tender" tabIndex={-1}>
                <SearchableSelect
                  options={tenderOpts}
                  value={tenderId}
                  onChange={v => { setTenderId(v as string); fe.change('tender', v as string, TENDER_SPEC) }}
                  placeholder="Select a Won tender…"
                  error={errs.tender ? ' ' : undefined}
                />
              </div>
              <FieldError id="cn-tender" msg={errs.tender} />
            </div>
          )}

          {/* Column headers */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] font-bold uppercase tracking-wide text-gray-400 px-1">
            <span>Consignee Name <span className="text-red-500">*</span></span>
            <span>Contact Person</span>
          </div>

          {/* Rows */}
          {formRows.map((row, i) => (
            <div key={i} className="border border-gray-200 rounded-2xl p-4 space-y-3 bg-gray-50/50">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-emerald-700 flex items-center gap-1">
                  <MapPin size={11} /> Consignee {formRows.length > 1 ? i + 1 : ''}
                </span>
                {formRows.length > 1 && !isEdit && (
                  <button onClick={() => removeRow(i)} className="text-red-400 hover:text-red-600 p-1 rounded hover:bg-red-50">
                    <X size={13} />
                  </button>
                )}
              </div>

              {/* Row 1: Name + Contact Person */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
                  <input value={row.name} onChange={e => updateRow(i, 'name', e.target.value)} {...fa(i, 'name')}
                    className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-400 bg-white${consCls(errs[`${i}.name`])}`}
                    placeholder="Organisation / party name" />
                  <FieldError id={`cn-${i}-name`} msg={errs[`${i}.name`]} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Contact Person</label>
                  <input value={row.contact_person} onChange={e => updateRow(i, 'contact_person', e.target.value)} {...fa(i, 'contact_person')}
                    className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-400 bg-white${consCls(errs[`${i}.contact_person`])}`}
                    placeholder="Name" />
                  <FieldError id={`cn-${i}-contact_person`} msg={errs[`${i}.contact_person`]} />
                </div>
              </div>

              {/* Row 2: Phone + Email */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Contact Number</label>
                  <input value={row.contact_number} onChange={e => updateRow(i, 'contact_number', e.target.value)} {...fa(i, 'contact_number')} inputMode="numeric"
                    className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-400 bg-white${consCls(errs[`${i}.contact_number`])}`}
                    placeholder="+91 XXXXX XXXXX" />
                  <FieldError id={`cn-${i}-contact_number`} msg={errs[`${i}.contact_number`]} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                  <input value={row.email} onChange={e => updateRow(i, 'email', e.target.value)} type="email" {...fa(i, 'email')}
                    className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-400 bg-white${consCls(errs[`${i}.email`])}`}
                    placeholder="email@example.com" />
                  <FieldError id={`cn-${i}-email`} msg={errs[`${i}.email`]} />
                </div>
              </div>

              {/* Address */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Address</label>
                <textarea value={row.address} onChange={e => updateRow(i, 'address', e.target.value)} rows={2} {...fa(i, 'address')}
                  className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-400 resize-none bg-white${consCls(errs[`${i}.address`])}`}
                  placeholder="Street / building / area" />
                <FieldError id={`cn-${i}-address`} msg={errs[`${i}.address`]} />
              </div>

              {/* City / State / Pincode / Country */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {(['city', 'state', 'pincode', 'country'] as const).map(k => (
                  <div key={k}>
                    <label className="block text-xs font-medium text-gray-600 mb-1 capitalize">{k}</label>
                    <input value={(row as any)[k]} onChange={e => updateRow(i, k, e.target.value)} {...fa(i, k)}
                      className={`w-full px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-400 bg-white${consCls(errs[`${i}.${k}`])}`}
                      placeholder={k.charAt(0).toUpperCase() + k.slice(1)} />
                    <FieldError id={`cn-${i}-${k}`} msg={errs[`${i}.${k}`]} />
                  </div>
                ))}
              </div>

              {/* Notes */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
                <textarea value={row.notes} onChange={e => updateRow(i, 'notes', e.target.value)} rows={2} {...fa(i, 'notes')}
                  className={`w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-400 resize-none bg-white${consCls(errs[`${i}.notes`])}`}
                  placeholder="Delivery instructions, timing, etc." />
                <FieldError id={`cn-${i}-notes`} msg={errs[`${i}.notes`]} />
              </div>
            </div>
          ))}

          {/* Add another row (Add mode only) */}
          {!isEdit && (
            <button onClick={addRow}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-emerald-300 text-emerald-700 text-sm font-semibold hover:bg-emerald-50 transition-colors">
              <Plus size={15} /> Add Another Consignee
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-3 bg-gray-50">
          <button onClick={onClose}
            className="px-5 py-2 text-sm rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-100">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-6 py-2 text-sm rounded-xl bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-60 flex items-center gap-2">
            {saving && <Loader2 size={13} className="animate-spin" />}
            {isEdit ? 'Update' : `Save ${formRows.length > 1 ? `(${formRows.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
