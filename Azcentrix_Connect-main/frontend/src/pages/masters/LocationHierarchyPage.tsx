import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  ChevronRight,
  Layers,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Target,
  Trash2,
  X,
} from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { FormGrid, PageHeader, useToast } from '@/components/ui/FormComponents'

type RegionItem = {
  id: number
  name: string
  description?: string | null
  is_active?: boolean
}

type StateItem = {
  id: number
  name: string
  region_id: number | null
  region_name?: string
  description?: string | null
  is_active?: boolean
}

type DistrictItem = {
  id: number
  name: string
  region_id: number
  state_id: number
  region_name?: string
  state_name?: string
  description?: string | null
  is_active?: boolean
}

type ConfirmOptions = {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
}

function ConfirmDialog({
  open,
  title,
  message,
  confirmText = 'Delete',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmOptions & { open: boolean; onConfirm: () => void; onCancel: () => void }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/30 px-4 backdrop-blur-sm">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-2xl">
        <div className="flex items-start gap-3 px-5 py-4">
          <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600">
            <AlertCircle size={18} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-slate-900">{title}</h3>
            <p className="mt-1 text-sm leading-5 text-slate-500">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 bg-slate-50 px-5 py-3.5">
          <button
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-rose-700"
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
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
    })
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

function PanelShell({
  icon,
  title,
  subtitle,
  count,
  accent,
  action,
  children,
}: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  count?: number
  accent: 'sky' | 'emerald' | 'amber'
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const accentClasses = {
    sky: 'bg-sky-100 text-sky-600',
    emerald: 'bg-emerald-100 text-emerald-600',
    amber: 'bg-amber-100 text-amber-600',
  }[accent]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl ${accentClasses}`}>
            {icon}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-slate-900">{title}</h2>
              {typeof count === 'number' && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                  {count}
                </span>
              )}
            </div>
            {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

function RegionPanel({
  regions,
  states,
  districts,
  selectedRegionId,
  onSelectRegion,
  onChanged,
}: {
  regions: RegionItem[]
  states: StateItem[]
  districts: DistrictItem[]
  selectedRegionId: number | null
  onSelectRegion: (id: number | null) => void
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const { success, error: showError } = useToast()
  const { confirm, dialog } = useConfirmDialog()

  const stateCountByRegion = useMemo(() => {
    const counts: Record<number, number> = {}
    states.forEach((state) => {
      if (state.region_id == null) return
      counts[state.region_id] = (counts[state.region_id] ?? 0) + 1
    })
    return counts
  }, [states])

  const districtCountByRegion = useMemo(() => {
    const counts: Record<number, number> = {}
    districts.forEach((district) => {
      counts[district.region_id] = (counts[district.region_id] ?? 0) + 1
    })
    return counts
  }, [districts])

  const handleAdd = async () => {
    const regionName = name.trim()
    if (!regionName) return
    setSaving(true)
    try {
      await api.post('/masters/regions', {
        name: regionName,
        description: description.trim() || null,
      })
      success('Region added')
      setName('')
      setDescription('')
      setShowForm(false)
      onChanged()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to add region')
    } finally {
      setSaving(false)
    }
  }

  const handleEditSave = async (region: RegionItem) => {
    const regionName = editName.trim()
    if (!regionName) return
    setEditSaving(true)
    try {
      await api.put(`/masters/regions/${region.id}`, {
        name: regionName,
        description: editDescription.trim() || null,
      })
      success('Region updated')
      setEditId(null)
      setEditName('')
      setEditDescription('')
      onChanged()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to update region')
    } finally {
      setEditSaving(false)
    }
  }

  const handleDelete = async (region: RegionItem) => {
    const stateCount = stateCountByRegion[region.id] ?? 0
    const districtCount = districtCountByRegion[region.id] ?? 0
    if (stateCount > 0 || districtCount > 0) {
      showError('Remove the states and districts under this region before deleting it.')
      return
    }

    const ok = await confirm({
      title: 'Delete region',
      message: `Delete "${region.name}"?`,
    })
    if (!ok) return

    try {
      await api.delete(`/masters/regions/${region.id}`)
      success('Region deleted')
      if (selectedRegionId === region.id) onSelectRegion(null)
      onChanged()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to delete region')
    }
  }

  return (
    <PanelShell
      icon={<MapPin size={15} />}
      title="Regions"
      subtitle="Pick a region to manage its states"
      count={regions.length}
      accent="sky"
      action={(
        <button
          onClick={() => setShowForm(f => !f)}
          className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${showForm ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-sky-600 text-white hover:bg-sky-700 shadow-sm'}`}
        >
          {showForm ? <><X size={13} /> Cancel</> : <><Plus size={13} /> Add</>}
        </button>
      )}
    >
      {showForm && (
        <div className="border-b border-slate-100 bg-gradient-to-b from-sky-50/60 to-white px-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">Region Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. North"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">Description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional note"
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={handleAdd}
              disabled={saving || !name.trim()}
              className="flex items-center gap-1.5 rounded-xl bg-sky-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-sky-700 disabled:opacity-50"
            >
              {saving ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
              Save Region
            </button>
            <button
              onClick={() => { setShowForm(false); setName(''); setDescription('') }}
              className="rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="custom-scroll flex-1 min-h-0 overflow-y-auto">
        {regions.length === 0 ? (
          <div className="px-4 py-14 text-center">
            <MapPin size={22} className="mx-auto mb-2 text-slate-300" />
            <p className="text-sm text-slate-400">No regions yet</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {regions.map((region) => {
              const selected = selectedRegionId === region.id
              const editing = editId === region.id
              const stateCount = stateCountByRegion[region.id] ?? 0
              const districtCount = districtCountByRegion[region.id] ?? 0

              return (
                <div
                  key={region.id}
                  className={`group border-l-2 transition-colors ${
                    selected
                      ? 'border-l-sky-500 bg-sky-50'
                      : 'border-l-transparent hover:bg-slate-50'
                  }`}
                >
                  {editing ? (
                    <div className="px-4 py-3">
                      <FormGrid cols={2}>
                        <Input
                          label="Region Name *"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="Region name"
                        />
                        <Input
                          label="Description"
                          value={editDescription}
                          onChange={(e) => setEditDescription(e.target.value)}
                          placeholder="Optional note"
                        />
                      </FormGrid>
                      <div className="mt-3 flex gap-2">
                        <Button
                          onClick={() => handleEditSave(region)}
                          loading={editSaving}
                          size="sm"
                        >
                          <Check size={14} className="mr-1 inline-block" />
                          Save
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEditId(null)
                            setEditName('')
                            setEditDescription('')
                          }}
                          size="sm"
                        >
                          <X size={14} className="mr-1 inline-block" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-3 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => onSelectRegion(region.id)}
                        className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      >
                        <span className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl ${
                          selected ? 'bg-sky-100 text-sky-600' : 'bg-slate-100 text-slate-400'
                        }`}>
                          <MapPin size={14} />
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className={`text-sm font-semibold ${
                              selected ? 'text-sky-700' : 'text-slate-900'
                            }`}>
                              {region.name}
                            </p>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                              {stateCount} states
                            </span>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                              {districtCount} districts
                            </span>
                          </div>
                          {(region.description || selected) && (
                            <p className="mt-0.5 text-xs text-slate-400">
                              {region.description || 'Selected'}
                            </p>
                          )}
                        </div>
                      </button>
                      <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => {
                            setEditId(region.id)
                            setEditName(region.name)
                            setEditDescription(region.description || '')
                          }}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-sky-50 hover:text-sky-600"
                          title="Edit region"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => handleDelete(region)}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                          title="Delete region"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {dialog}
    </PanelShell>
  )
}

function StatePanel({
  regions,
  states,
  districts,
  selectedRegionId,
  selectedStateId,
  onSelectRegion,
  onSelectState,
  onChanged,
}: {
  regions: RegionItem[]
  states: StateItem[]
  districts: DistrictItem[]
  selectedRegionId: number | null
  selectedStateId: number | null
  onSelectRegion: (id: number | null) => void
  onSelectState: (id: number | null) => void
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [editRegionId, setEditRegionId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const { success, error: showError } = useToast()
  const { confirm, dialog } = useConfirmDialog()

  useEffect(() => {
    setName('')
    setDescription('')
    setShowForm(false)
    setEditId(null)
    setEditRegionId(null)
    setEditName('')
    setEditDescription('')
  }, [selectedRegionId])

  const regionOptions = useMemo(
    () => regions.map((region) => ({ value: region.id, label: region.name })),
    [regions],
  )

  const selectedRegion = useMemo(
    () => regions.find((region) => region.id === selectedRegionId) ?? null,
    [regions, selectedRegionId],
  )

  const selectedRegionStates = useMemo(
    () => states.filter((state) => Number(state.region_id) === Number(selectedRegionId)),
    [states, selectedRegionId],
  )

  const unassignedStates = useMemo(
    () => states.filter((state) => state.region_id == null),
    [states],
  )

  const districtCountByState = useMemo(() => {
    const counts: Record<number, number> = {}
    districts.forEach((district) => {
      counts[district.state_id] = (counts[district.state_id] ?? 0) + 1
    })
    return counts
  }, [districts])

  const handleAdd = async () => {
    if (!selectedRegionId) {
      showError('Select a region before adding a state')
      return
    }
    const stateName = name.trim()
    if (!stateName) return
    setSaving(true)
    try {
      await api.post('/masters/states', {
        name: stateName,
        region_id: selectedRegionId,
        description: description.trim() || null,
      })
      success('State added')
      setName('')
      setDescription('')
      setShowForm(false)
      onChanged()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to add state')
    } finally {
      setSaving(false)
    }
  }

  const handleEditSave = async (state: StateItem) => {
    const stateName = editName.trim()
    if (!stateName) return
    if (!editRegionId) {
      showError('Select a region for the state')
      return
    }
    setEditSaving(true)
    try {
      await api.put(`/masters/states/${state.id}`, {
        name: stateName,
        region_id: editRegionId,
        description: editDescription.trim() || null,
      })
      success('State updated')
      setEditId(null)
      setEditRegionId(null)
      setEditName('')
      setEditDescription('')
      onChanged()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to update state')
    } finally {
      setEditSaving(false)
    }
  }

  const handleDelete = async (state: StateItem) => {
    const districtCount = districtCountByState[state.id] ?? 0
    if (districtCount > 0) {
      showError('Remove the districts under this state before deleting it.')
      return
    }

    const ok = await confirm({
      title: 'Delete state',
      message: `Delete "${state.name}"?`,
    })
    if (!ok) return

    try {
      await api.delete(`/masters/states/${state.id}`)
      success('State deleted')
      if (selectedStateId === state.id) onSelectState(null)
      onChanged()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to delete state')
    }
  }

  const selectState = (state: StateItem) => {
    onSelectState(state.id)
    if (state.region_id != null && Number(state.region_id) !== Number(selectedRegionId)) {
      onSelectRegion(state.region_id)
    }
  }

  return (
    <PanelShell
      icon={<Layers size={15} />}
      title="States"
      subtitle={selectedRegion ? `Under ${selectedRegion.name}` : 'Pick a region on the left'}
      count={states.length}
      accent="emerald"
      action={(
        <button
          onClick={() => setShowForm(f => !f)}
          className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${showForm ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm'}`}
        >
          {showForm ? <><X size={13} /> Cancel</> : <><Plus size={13} /> Add</>}
        </button>
      )}
    >
      {showForm && (
        <div className="border-b border-slate-100 bg-gradient-to-b from-emerald-50/60 to-white px-4 py-4">
          {!selectedRegionId && (
            <div className="mb-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
              Select a region first to add a state.
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">State Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Maharashtra"
                disabled={!selectedRegionId}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-50 disabled:text-slate-400"
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">Description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional note"
                disabled={!selectedRegionId}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-50"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={handleAdd}
              disabled={saving || !selectedRegionId || !name.trim()}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
              Save State
            </button>
            <button
              onClick={() => { setShowForm(false); setName(''); setDescription('') }}
              className="rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="custom-scroll flex-1 min-h-0 overflow-y-auto">
        {states.length === 0 ? (
          <div className="px-4 py-14 text-center">
            <Layers size={22} className="mx-auto mb-2 text-slate-300" />
            <p className="text-sm text-slate-400">No states yet</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {selectedRegion && selectedRegionStates.length > 0 && (
              <div>
                <div className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  {selectedRegion.name}
                </div>
                {selectedRegionStates.map((state) => {
                  const selected = selectedStateId === state.id
                  const editing = editId === state.id
                  const districtCount = districtCountByState[state.id] ?? 0

                  return (
                    <div
                      key={state.id}
                      className={`group border-l-2 transition-colors ${
                        selected
                          ? 'border-l-emerald-500 bg-emerald-50'
                          : 'border-l-transparent hover:bg-slate-50'
                      }`}
                    >
                      {editing ? (
                        <div className="px-4 py-3">
                          <FormGrid cols={2}>
                            <SearchableSelect
                              label="Region"
                              options={regionOptions}
                              value={editRegionId}
                              onChange={(value) => setEditRegionId(value != null ? Number(value) : null)}
                              placeholder="Select region"
                            />
                            <Input
                              label="State Name *"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              placeholder="State name"
                            />
                          </FormGrid>
                          <div className="mt-3">
                            <Input
                              label="Description"
                              value={editDescription}
                              onChange={(e) => setEditDescription(e.target.value)}
                              placeholder="Optional note"
                            />
                          </div>
                          <div className="mt-3 flex gap-2">
                            <Button
                              onClick={() => handleEditSave(state)}
                              loading={editSaving}
                              size="sm"
                            >
                              <Check size={14} className="mr-1 inline-block" />
                              Save
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setEditId(null)
                                setEditRegionId(null)
                                setEditName('')
                                setEditDescription('')
                              }}
                              size="sm"
                            >
                              <X size={14} className="mr-1 inline-block" />
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-3 px-4 py-3">
                          <button
                            type="button"
                            onClick={() => selectState(state)}
                            className="flex min-w-0 flex-1 items-start gap-3 text-left"
                          >
                            <span className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl ${
                              selected ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'
                            }`}>
                              <Layers size={14} />
                            </span>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className={`text-sm font-semibold ${
                                  selected ? 'text-emerald-700' : 'text-slate-900'
                                }`}>
                                  {state.name}
                                </p>
                                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                                  {districtCount} districts
                                </span>
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                                {state.description && <span>{state.description}</span>}
                                {!state.region_id && (
                                  <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">
                                    Unassigned
                                  </span>
                                )}
                              </div>
                            </div>
                          </button>
                          <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            <button
                              onClick={() => {
                                setEditId(state.id)
                                setEditRegionId(state.region_id ?? selectedRegionId)
                                setEditName(state.name)
                                setEditDescription(state.description || '')
                              }}
                              className="rounded-md p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600"
                              title="Edit state"
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              onClick={() => handleDelete(state)}
                              className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                              title="Delete state"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {unassignedStates.length > 0 && (
              <div>
                <div className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Unassigned States
                </div>
                {unassignedStates.map((state) => {
                  const selected = selectedStateId === state.id
                  const editing = editId === state.id
                  const districtCount = districtCountByState[state.id] ?? 0

                  return (
                    <div
                      key={state.id}
                      className={`group border-l-2 transition-colors ${
                        selected
                          ? 'border-l-emerald-500 bg-emerald-50'
                          : 'border-l-transparent hover:bg-slate-50'
                      }`}
                    >
                      {editing ? (
                        <div className="px-4 py-3">
                          <FormGrid cols={2}>
                            <SearchableSelect
                              label="Region"
                              options={regionOptions}
                              value={editRegionId}
                              onChange={(value) => setEditRegionId(value != null ? Number(value) : null)}
                              placeholder="Select region"
                            />
                            <Input
                              label="State Name *"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              placeholder="State name"
                            />
                          </FormGrid>
                          <div className="mt-3">
                            <Input
                              label="Description"
                              value={editDescription}
                              onChange={(e) => setEditDescription(e.target.value)}
                              placeholder="Optional note"
                            />
                          </div>
                          <div className="mt-3 flex gap-2">
                            <Button
                              onClick={() => handleEditSave(state)}
                              loading={editSaving}
                              size="sm"
                            >
                              <Check size={14} className="mr-1 inline-block" />
                              Save
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setEditId(null)
                                setEditRegionId(null)
                                setEditName('')
                                setEditDescription('')
                              }}
                              size="sm"
                            >
                              <X size={14} className="mr-1 inline-block" />
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-3 px-4 py-3">
                          <button
                            type="button"
                            onClick={() => selectState(state)}
                            className="flex min-w-0 flex-1 items-start gap-3 text-left"
                          >
                            <span className={`mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl ${
                              selected ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'
                            }`}>
                              <Layers size={14} />
                            </span>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className={`text-sm font-semibold ${
                                  selected ? 'text-emerald-700' : 'text-slate-900'
                                }`}>
                                  {state.name}
                                </p>
                                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                                  {districtCount} districts
                                </span>
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                                {state.region_name
                                  ? <span>Region: {state.region_name}</span>
                                  : (
                                    <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">
                                      Unassigned
                                    </span>
                                  )}
                                {state.description && <span>{state.description}</span>}
                              </div>
                            </div>
                          </button>
                          <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                            <button
                              onClick={() => {
                                setEditId(state.id)
                                setEditRegionId(state.region_id ?? selectedRegionId)
                                setEditName(state.name)
                                setEditDescription(state.description || '')
                              }}
                              className="rounded-md p-1.5 text-slate-400 hover:bg-emerald-50 hover:text-emerald-600"
                              title="Edit state"
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              onClick={() => handleDelete(state)}
                              className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                              title="Delete state"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {dialog}
    </PanelShell>
  )
}

function DistrictPanel({
  regions,
  states,
  districts,
  selectedRegionId,
  selectedStateId,
  onSelectRegion,
  onSelectState,
  onChanged,
}: {
  regions: RegionItem[]
  states: StateItem[]
  districts: DistrictItem[]
  selectedRegionId: number | null
  selectedStateId: number | null
  onSelectRegion: (id: number | null) => void
  onSelectState: (id: number | null) => void
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [editRegionId, setEditRegionId] = useState<number | null>(null)
  const [editStateId, setEditStateId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const { success, error: showError } = useToast()
  const { confirm, dialog } = useConfirmDialog()

  const selectedRegion = useMemo(
    () => regions.find((region) => region.id === selectedRegionId) ?? null,
    [regions, selectedRegionId],
  )

  const selectedState = useMemo(
    () => states.find((state) => state.id === selectedStateId) ?? null,
    [states, selectedStateId],
  )

  const districtsForSelectedState = useMemo(
    () => districts.filter((district) => district.state_id === selectedStateId),
    [districts, selectedStateId],
  )

  const regionOptions = useMemo(
    () => regions.map((region) => ({ value: region.id, label: region.name })),
    [regions],
  )

  const editStateOptions = useMemo(() => {
    const allowedStates = editRegionId
      ? states.filter((state) => Number(state.region_id) === Number(editRegionId))
      : states
    return allowedStates.map((state) => ({
      value: state.id,
      label: state.name,
      subtitle: state.region_name ? `Region: ${state.region_name}` : 'Unassigned',
    }))
  }, [states, editRegionId])

  useEffect(() => {
    setName('')
    setDescription('')
    setShowForm(false)
    setEditId(null)
    setEditRegionId(null)
    setEditStateId(null)
    setEditName('')
    setEditDescription('')
  }, [selectedRegionId, selectedStateId])

  const handleAdd = async () => {
    if (!selectedRegionId || !selectedStateId || !selectedState?.region_id) {
      showError('Select a state that belongs to a region before adding a district')
      return
    }
    const districtName = name.trim()
    if (!districtName) return
    setSaving(true)
    try {
      await api.post('/masters/districts', {
        name: districtName,
        region_id: selectedRegionId,
        state_id: selectedStateId,
        description: description.trim() || null,
      })
      success('District added')
      setName('')
      setDescription('')
      setShowForm(false)
      onChanged()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to add district')
    } finally {
      setSaving(false)
    }
  }

  const handleEditSave = async (district: DistrictItem) => {
    const districtName = editName.trim()
    if (!districtName) return
    if (!editRegionId || !editStateId) {
      showError('Select both a region and a state for the district')
      return
    }
    setEditSaving(true)
    try {
      await api.put(`/masters/districts/${district.id}`, {
        name: districtName,
        region_id: editRegionId,
        state_id: editStateId,
        description: editDescription.trim() || null,
      })
      success('District updated')
      setEditId(null)
      setEditRegionId(null)
      setEditStateId(null)
      setEditName('')
      setEditDescription('')
      onChanged()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to update district')
    } finally {
      setEditSaving(false)
    }
  }

  const handleDelete = async (district: DistrictItem) => {
    const ok = await confirm({
      title: 'Delete district',
      message: `Delete "${district.name}"?`,
    })
    if (!ok) return

    try {
      await api.delete(`/masters/districts/${district.id}`)
      success('District deleted')
      if (selectedStateId === district.state_id) onSelectState(district.state_id)
      onChanged()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to delete district')
    }
  }

  const selectEditRegion = (regionId: number | null) => {
    setEditRegionId(regionId)
    const regionStates = regionId == null
      ? states
      : states.filter((state) => Number(state.region_id) === Number(regionId))
    setEditStateId(regionStates[0]?.id ?? null)
  }

  const selectedStateHasRegion = Boolean(selectedState?.region_id)

  return (
    <PanelShell
      icon={<Target size={15} />}
      title="Districts"
      subtitle={
        selectedState
          ? selectedStateHasRegion
            ? `${selectedState.name} - ${selectedRegion?.name || 'Region'}`
            : `${selectedState.name} - assign a region to add districts`
          : 'Pick a state to manage districts'
      }
      count={selectedStateId ? districtsForSelectedState.length : districts.length}
      accent="amber"
      action={(
        <button
          onClick={() => setShowForm(f => !f)}
          className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition ${showForm ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-amber-500 text-white hover:bg-amber-600 shadow-sm'}`}
        >
          {showForm ? <><X size={13} /> Cancel</> : <><Plus size={13} /> Add</>}
        </button>
      )}
    >
      {showForm && (
        <div className="border-b border-slate-100 bg-gradient-to-b from-amber-50/60 to-white px-4 py-4">
          {!selectedStateHasRegion && (
            <div className="mb-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
              {selectedState
                ? 'This state has no region yet. Assign it to a region before adding districts.'
                : 'Select a state first to add a district.'}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">District Name *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Pune"
                disabled={!selectedStateHasRegion}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100 disabled:bg-slate-50 disabled:text-slate-400"
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">Description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional note"
                disabled={!selectedStateHasRegion}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100 disabled:bg-slate-50"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={handleAdd}
              disabled={saving || !selectedStateHasRegion || !name.trim()}
              className="flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-amber-600 disabled:opacity-50"
            >
              {saving ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
              Save District
            </button>
            <button
              onClick={() => { setShowForm(false); setName(''); setDescription('') }}
              className="rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="custom-scroll flex-1 min-h-0 overflow-y-auto">
        {!selectedStateId ? (
          <div className="px-4 py-14 text-center">
            <Target size={22} className="mx-auto mb-2 text-slate-300" />
            <p className="text-sm text-slate-400">Select a state to see districts</p>
          </div>
        ) : districtsForSelectedState.length === 0 ? (
          <div className="px-4 py-14 text-center">
            <Target size={22} className="mx-auto mb-2 text-slate-300" />
            <p className="text-sm text-slate-400">No districts yet</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {districtsForSelectedState.map((district) => {
              const editing = editId === district.id

              return (
                <div
                  key={district.id}
                  className="group border-l-2 border-l-transparent transition-colors hover:bg-slate-50"
                >
                  {editing ? (
                    <div className="px-4 py-3">
                      <FormGrid cols={2}>
                        <SearchableSelect
                          label="Region"
                          options={regionOptions}
                          value={editRegionId}
                          onChange={(value) => selectEditRegion(value != null ? Number(value) : null)}
                          placeholder="Select region"
                        />
                        <SearchableSelect
                          label="State"
                          options={editStateOptions}
                          value={editStateId}
                          onChange={(value) => setEditStateId(value != null ? Number(value) : null)}
                          placeholder="Select state"
                        />
                      </FormGrid>
                      <FormGrid cols={2}>
                        <Input
                          label="District Name *"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="District name"
                        />
                        <Input
                          label="Description"
                          value={editDescription}
                          onChange={(e) => setEditDescription(e.target.value)}
                          placeholder="Optional note"
                        />
                      </FormGrid>
                      <div className="mt-3 flex gap-2">
                        <Button
                          onClick={() => handleEditSave(district)}
                          loading={editSaving}
                          size="sm"
                        >
                          <Check size={14} className="mr-1 inline-block" />
                          Save
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEditId(null)
                            setEditRegionId(null)
                            setEditStateId(null)
                            setEditName('')
                            setEditDescription('')
                          }}
                          size="sm"
                        >
                          <X size={14} className="mr-1 inline-block" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-3 px-4 py-3">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
                          <Target size={14} />
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-slate-900">{district.name}</p>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                              {district.state_name || 'No state'}
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                            {district.region_name && <span>Region: {district.region_name}</span>}
                            {district.description && <span>{district.description}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => {
                            setEditId(district.id)
                            setEditRegionId(district.region_id)
                            setEditStateId(district.state_id)
                            setEditName(district.name)
                            setEditDescription(district.description || '')
                          }}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-amber-50 hover:text-amber-600"
                          title="Edit district"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => handleDelete(district)}
                          className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-500"
                          title="Delete district"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {dialog}
    </PanelShell>
  )
}

export default function LocationHierarchyPage({
  embedded = false,
  reloadKey = 0,
  onDataChange,
}: {
  embedded?: boolean
  reloadKey?: number
  onDataChange?: (payload: {
    regions: RegionItem[]
    states: StateItem[]
    districts: DistrictItem[]
  }) => void
}) {
  const [regions, setRegions] = useState<RegionItem[]>([])
  const [states, setStates] = useState<StateItem[]>([])
  const [districts, setDistricts] = useState<DistrictItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedRegionId, setSelectedRegionId] = useState<number | null>(null)
  const [selectedStateId, setSelectedStateId] = useState<number | null>(null)
  const { error: showError } = useToast()
  const showErrorRef = useRef(showError)
  const onDataChangeRef = useRef(onDataChange)

  useEffect(() => {
    showErrorRef.current = showError
  }, [showError])

  useEffect(() => {
    onDataChangeRef.current = onDataChange
  }, [onDataChange])

  const load = useCallback(async (showPageLoader = false) => {
    if (showPageLoader) setLoading(true)
    try {
      const [regionsResult, statesResult, districtsResult] = await Promise.allSettled([
        api.get('/masters/regions'),
        api.get('/masters/states'),
        api.get('/masters/districts'),
      ])

      const regionsData = regionsResult.status === 'fulfilled' && Array.isArray(regionsResult.value.data) ? regionsResult.value.data : []
      const statesData  = statesResult.status  === 'fulfilled' && Array.isArray(statesResult.value.data)  ? statesResult.value.data  : []
      const districtsData = districtsResult.status === 'fulfilled' && Array.isArray(districtsResult.value.data) ? districtsResult.value.data : []

      setRegions(regionsData)
      setStates(statesData)
      setDistricts(districtsData)
      onDataChangeRef.current?.({ regions: regionsData, states: statesData, districts: districtsData })

      if (regionsResult.status === 'rejected') showErrorRef.current('Failed to load regions')
      else if (statesResult.status === 'rejected') showErrorRef.current('Failed to load states')
    } catch {
      showErrorRef.current('Failed to load location masters')
    } finally {
      if (showPageLoader) setLoading(false)
    }
  }, [])

 useEffect(() => {
  load(true)
}, [load, reloadKey])

  useEffect(() => {
    if (!regions.length) {
      setSelectedRegionId(null)
      setSelectedStateId(null)
      return
    }
    setSelectedRegionId((current) => (
      current && regions.some((region) => region.id === current)
        ? current
        : regions[0]?.id ?? null
    ))
  }, [regions])

  useEffect(() => {
    if (!selectedRegionId) return

    const currentState = selectedStateId != null
      ? states.find((state) => state.id === selectedStateId) ?? null
      : null

    const regionState = states.find((state) => Number(state.region_id) === Number(selectedRegionId))
    if (currentState && Number(currentState.region_id) === Number(selectedRegionId)) return
    setSelectedStateId(regionState?.id ?? null)
  }, [selectedRegionId, selectedStateId, states])

  const selectedRegion = useMemo(
    () => regions.find((region) => region.id === selectedRegionId) ?? null,
    [regions, selectedRegionId],
  )

  const selectedState = useMemo(
    () => states.find((state) => state.id === selectedStateId) ?? null,
    [states, selectedStateId],
  )

  const regionStateCount = useMemo(() => {
    const counts: Record<number, number> = {}
    states.forEach((state) => {
      if (state.region_id == null) return
      counts[state.region_id] = (counts[state.region_id] ?? 0) + 1
    })
    return counts
  }, [states])

  const regionDistrictCount = useMemo(() => {
    const counts: Record<number, number> = {}
    districts.forEach((district) => {
      counts[district.region_id] = (counts[district.region_id] ?? 0) + 1
    })
    return counts
  }, [districts])

  const stateDistrictCount = useMemo(() => {
    const counts: Record<number, number> = {}
    districts.forEach((district) => {
      counts[district.state_id] = (counts[district.state_id] ?? 0) + 1
    })
    return counts
  }, [districts])

  const handleSelectRegion = (regionId: number | null) => {
    setSelectedRegionId(regionId)
    if (regionId == null) {
      const firstUnassigned = states.find((state) => state.region_id == null) ?? null
      setSelectedStateId(firstUnassigned?.id ?? null)
      return
    }
    const firstState = states.find((state) => Number(state.region_id) === Number(regionId))
    setSelectedStateId(firstState?.id ?? null)
  }

  const handleSelectState = (stateId: number | null) => {
    setSelectedStateId(stateId)
    if (stateId == null) return
    const state = states.find((item) => item.id === stateId) ?? null
    if (state?.region_id != null) {
      setSelectedRegionId(state.region_id)
    }
  }

  if (loading) {
    return (
      <div className={embedded ? '' : 'p-6'}>
        {!embedded && (
          <PageHeader
            title="Regions / States / Districts"
            subtitle="Manage the full location hierarchy in one place"
            breadcrumb={['Settings', 'Masters', 'Locations']}
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
  <div className={embedded ? 'h-full min-h-0' : 'h-[calc(100vh-120px)] min-h-0 overflow-hidden p-6'}>
    {!embedded && (
      <PageHeader
        title="Location Master"
        subtitle="Manage regions, states and districts"
        breadcrumb={['Settings', 'Masters', 'Locations']}
      />
    )}

    <div className={embedded ? 'h-full min-h-0' : 'h-[calc(100%-92px)] min-h-0'}>
      <div className="grid h-full min-h-0 grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-h-0 overflow-hidden rounded-3xl border border-slate-100 bg-white shadow-sm">
          <RegionPanel
            regions={regions}
            states={states}
            districts={districts}
            selectedRegionId={selectedRegionId}
            onSelectRegion={(id) => {
              setSelectedRegionId(id)
              setSelectedStateId(null)
            }}
            onChanged={() => load(false)}
          />
        </div>

        <div className="min-h-0 overflow-hidden rounded-3xl border border-slate-100 bg-white shadow-sm">
          <StatePanel
            regions={regions}
            states={states}
            districts={districts}
            selectedRegionId={selectedRegionId}
            selectedStateId={selectedStateId}
            onSelectRegion={setSelectedRegionId}
            onSelectState={setSelectedStateId}
            onChanged={() => load(false)}
          />
        </div>

        <div className="min-h-0 overflow-hidden rounded-3xl border border-slate-100 bg-white shadow-sm">
          <DistrictPanel
            regions={regions}
            states={states}
            districts={districts}
            selectedRegionId={selectedRegionId}
            selectedStateId={selectedStateId}
            onSelectRegion={setSelectedRegionId}
            onSelectState={setSelectedStateId}
            onChanged={() => load(false)}
          />
        </div>
      </div>
    </div>
  </div>
)
}
