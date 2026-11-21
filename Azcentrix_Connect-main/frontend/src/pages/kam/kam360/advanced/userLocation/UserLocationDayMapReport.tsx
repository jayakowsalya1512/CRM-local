import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import {
  Calendar,
  Clock3,
  MapPin,
  Maximize2,
  Minimize2,
  Navigation,
  RefreshCw,
  Route,
  UserCircle2,
  X,
} from 'lucide-react'
import { kamApi } from '@/services/api'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { usePermissions } from '@/hooks'
import { useResolvedLocationMap } from '@/utils/reverseGeocode'

type Props = {
  selectedUid: number | null
}

type UserOption = {
  user_id: number
  user_name: string
  employee_code: string
}

type SummaryRow = {
  user_id: number
  user_name: string
  employee_code: string
  last_location_time: string | null
  tracking_status: string
  location_count: number
  stopped_time_seconds: number
  stopped_time_label: string
  group_count: number
  can_view_map: boolean
}

type SummaryPayload = {
  activity_date: string
  user_options: UserOption[]
  rows: SummaryRow[]
  summary: {
    tracked_users: number
    active_users: number
    total_logs: number
    total_stopped_seconds: number
    total_stopped_time: string
  }
}

type RouteGroup = {
  group_index: number
  latitude: number
  longitude: number
  arrival_time: string | null
  departure_time: string | null
  duration_seconds: number
  duration_label: string
  gps_record_count: number
  marker_type: 'start' | 'stay' | 'latest'
  is_start: boolean
  is_end: boolean
}

type DetailPayload = {
  activity_date: string
  user: UserOption
  summary: SummaryRow
  groups: Array<{
    group_index: number
    avg_latitude: number
    avg_longitude: number
    arrival_time: string | null
    departure_time: string | null
    duration_seconds: number
    duration_label: string
    gps_record_count: number
    marker_type: 'start' | 'stay' | 'latest'
    is_start: boolean
    is_end: boolean
  }>
  route: RouteGroup[]
  raw_location_count: number
}

const INDIA_CENTER: [number, number] = [23.0, 80.5]

const todayIso = () => new Date().toISOString().slice(0, 10)

const displayDate = (value?: string | null) => {
  if (!value) return '--'
  const [year, month, day] = String(value).slice(0, 10).split('-')
  return year && month && day ? `${day}-${month}-${year}` : String(value)
}

const displayDateTime = (value?: string | null) => {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const day = `${date.getDate()}`.padStart(2, '0')
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const year = date.getFullYear()
  const hour = `${date.getHours()}`.padStart(2, '0')
  const minute = `${date.getMinutes()}`.padStart(2, '0')
  return `${day}-${month}-${year} ${hour}:${minute}`
}

const statusTone = (status: string) => {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'active') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (normalized === 'idle') return 'bg-amber-50 text-amber-700 border-amber-200'
  if (normalized === 'tracked') return 'bg-blue-50 text-blue-700 border-blue-200'
  if (normalized === 'offline') return 'bg-rose-50 text-rose-700 border-rose-200'
  return 'bg-slate-50 text-slate-600 border-slate-200'
}

const markerPopupHtml = (group: RouteGroup, resolvedLocation?: string) => `
  <div class="kam-user-location-popup">
    <div class="kam-user-location-popup__title">
      ${group.marker_type === 'start' ? 'Start Location' : group.marker_type === 'latest' ? 'Latest Location' : `Stayed Location ${group.group_index}`}
    </div>
    <div class="kam-user-location-popup__row"><span>Place</span><b>${resolvedLocation || 'Resolving location...'}</b></div>
    <div class="kam-user-location-popup__row"><span>Arrival</span><b>${displayDateTime(group.arrival_time)}</b></div>
    <div class="kam-user-location-popup__row"><span>Departure</span><b>${displayDateTime(group.departure_time)}</b></div>
    <div class="kam-user-location-popup__row"><span>Total time</span><b>${group.duration_label}</b></div>
    <div class="kam-user-location-popup__row"><span>GPS records</span><b>${Number(group.gps_record_count).toLocaleString('en-IN')}</b></div>
  </div>
`

function UserLocationLeafletMap({
  groups,
  focusedGroupIndex,
  resolvedLocations,
  resizeToken,
}: {
  groups: RouteGroup[]
  focusedGroupIndex: number | null
  resolvedLocations: Record<string, string>
  resizeToken: string
}) {
  const map = useMap()
  const markerByGroupRef = useRef<Record<number, L.Marker>>({})

  const markerHtml = (group: RouteGroup, active = false) => {
    const label = group.marker_type === 'start'
      ? 'S'
      : group.marker_type === 'latest'
        ? 'E'
        : `${group.group_index}`
    return `
      <div class="kam-user-location-marker kam-user-location-marker--${group.marker_type} ${active ? 'kam-user-location-marker--active' : ''}">
        <span>${label}</span>
      </div>
    `
  }

  useEffect(() => {
    const styleId = 'kam-user-location-map-style'
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style')
      style.id = styleId
      style.innerHTML = `
        .kam-user-location-map-shell,
        .kam-user-location-map-shell .leaflet-container {
          position: relative;
          z-index: 0 !important;
        }

        .kam-user-location-map-shell .leaflet-control-attribution {
          display: none !important;
        }

        .kam-user-location-marker-shell {
          background: transparent !important;
          border: none !important;
        }

        .kam-user-location-marker {
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          border-radius: 999px;
          border: 3px solid #ffffff;
          color: #ffffff;
          box-shadow: 0 10px 24px rgba(15, 23, 42, 0.22);
          font-size: 12px;
          font-weight: 900;
        }

        .kam-user-location-marker--start {
          background: linear-gradient(135deg, #10b981, #047857);
        }

        .kam-user-location-marker--stay {
          background: linear-gradient(135deg, #2563eb, #1d4ed8);
        }

        .kam-user-location-marker--latest {
          background: linear-gradient(135deg, #f97316, #dc2626);
        }

        .kam-user-location-marker--active {
          transform: scale(1.08);
          box-shadow: 0 14px 30px rgba(59, 130, 246, 0.28);
        }

        .kam-user-location-popup {
          min-width: 200px;
          font-family: inherit;
        }

        .kam-user-location-popup__title {
          margin-bottom: 8px;
          font-size: 12px;
          font-weight: 900;
          color: #0f172a;
        }

        .kam-user-location-popup__row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          font-size: 11px;
          color: #475569;
          margin-top: 4px;
        }

        .kam-user-location-popup__row b {
          color: #0f172a;
        }
      `
      document.head.appendChild(style)
    }
  }, [])

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      map.invalidateSize(false)
    })
    const timeoutId = window.setTimeout(() => {
      map.invalidateSize(false)
    }, 220)

    return () => {
      window.cancelAnimationFrame(rafId)
      window.clearTimeout(timeoutId)
    }
  }, [map, resizeToken])

  useEffect(() => {
    markerByGroupRef.current = {}
    const layerGroup = L.layerGroup().addTo(map)
    const latLngs: L.LatLngTuple[] = groups.map(group => [group.latitude, group.longitude])

    if (latLngs.length > 1) {
      L.polyline(latLngs, {
        color: '#2563eb',
        weight: 4,
        opacity: 0.85,
        dashArray: '8 8',
      }).addTo(layerGroup)
    }

    groups.forEach(group => {
      const marker = L.marker([group.latitude, group.longitude], {
        icon: L.divIcon({
          className: 'kam-user-location-marker-shell',
          html: markerHtml(group),
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
      }).addTo(layerGroup)
      marker.bindPopup(markerPopupHtml(group, resolvedLocations[String(group.group_index)]), { offset: L.point(0, -10) })
      markerByGroupRef.current[group.group_index] = marker
    })

    map.invalidateSize()
    if (latLngs.length === 1) {
      map.setView(latLngs[0], 16, { animate: false })
    } else if (latLngs.length > 1) {
      map.fitBounds(L.latLngBounds(latLngs), { padding: [28, 28] })
    } else {
      map.setView(INDIA_CENTER, 5, { animate: false })
    }

    return () => {
      layerGroup.remove()
      markerByGroupRef.current = {}
    }
  }, [groups, map, resolvedLocations])

  useEffect(() => {
    if (!focusedGroupIndex) return
    const focused = groups.find(group => group.group_index === focusedGroupIndex)
    const marker = markerByGroupRef.current[focusedGroupIndex]
    if (!focused || !marker) return

    map.stop()
    map.setView([focused.latitude, focused.longitude], 16, {
      animate: true,
      duration: 0.8,
    })
    marker.openPopup()
  }, [focusedGroupIndex, groups, map])

  return null
}

export function UserLocationDayMapReport({ selectedUid }: Props) {
  const canExport = usePermissions().can('kam.export')
  const [activityDate, setActivityDate] = useState(todayIso())
  const [selectedUserId, setSelectedUserId] = useState<number | null>(selectedUid)
  const [captureFilter, setCaptureFilter] = useState<'all' | 'captured' | 'not_captured'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<SummaryRow[]>([])
  const [userOptions, setUserOptions] = useState<UserOption[]>([])
  const [summary, setSummary] = useState<SummaryPayload['summary']>({
    tracked_users: 0,
    active_users: 0,
    total_logs: 0,
    total_stopped_seconds: 0,
    total_stopped_time: '0s',
  })
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detail, setDetail] = useState<DetailPayload | null>(null)
  const [focusedGroupIndex, setFocusedGroupIndex] = useState<number | null>(null)
  const [mapOpen, setMapOpen] = useState(false)
  const [isMapMaximized, setIsMapMaximized] = useState(false)

  useEffect(() => {
    setSelectedUserId(selectedUid)
  }, [selectedUid])

  const loadSummary = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await kamApi.userLocationDaySummary({
        activity_date: activityDate,
        user_id: selectedUserId || undefined,
      })
      const data = (response.data || {}) as SummaryPayload
      setRows(Array.isArray(data.rows) ? data.rows : [])
      setUserOptions(Array.isArray(data.user_options) ? data.user_options : [])
      setSummary({
        tracked_users: Number(data.summary?.tracked_users || 0),
        active_users: Number(data.summary?.active_users || 0),
        total_logs: Number(data.summary?.total_logs || 0),
        total_stopped_seconds: Number(data.summary?.total_stopped_seconds || 0),
        total_stopped_time: String(data.summary?.total_stopped_time || '0s'),
      })
    } catch {
      setError('Failed to load day-wise user location summary')
      setRows([])
      setSummary({
        tracked_users: 0,
        active_users: 0,
        total_logs: 0,
        total_stopped_seconds: 0,
        total_stopped_time: '0s',
      })
    } finally {
      setLoading(false)
    }
  }, [activityDate, selectedUserId])

  useEffect(() => {
    setDetail(null)
    setFocusedGroupIndex(null)
    setDetailError('')
    setMapOpen(false)
    setIsMapMaximized(false)
  }, [activityDate, selectedUserId])

  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  const openMap = async (row: SummaryRow) => {
    setMapOpen(true)
    setDetailLoading(true)
    setDetailError('')
    setFocusedGroupIndex(null)
    try {
      const response = await kamApi.userLocationDayMap({
        user_id: row.user_id,
        activity_date: activityDate,
      })
      setDetail(response.data as DetailPayload)
    } catch {
      setDetail(null)
      setDetailError('Failed to load user location route map')
    } finally {
      setDetailLoading(false)
    }
  }

  const mapSummaryCards = useMemo(() => ([
    { label: 'Tracked Users', value: summary.tracked_users, icon: <UserCircle2 size={14} className="text-sky-600" /> },
    { label: 'Active Users', value: summary.active_users, icon: <Navigation size={14} className="text-emerald-600" /> },
    { label: 'GPS Records', value: summary.total_logs, icon: <MapPin size={14} className="text-blue-600" /> },
    { label: 'Stopped Time', value: summary.total_stopped_time, icon: <Clock3 size={14} className="text-violet-600" /> },
  ]), [summary])

  const closeMap = () => {
    setMapOpen(false)
    setIsMapMaximized(false)
    setFocusedGroupIndex(null)
  }

  const locationGroups = useMemo(
    () => detail?.route.map(group => ({
      key: String(group.group_index),
      latitude: group.latitude,
      longitude: group.longitude,
    })) || [],
    [detail?.route],
  )
  const resolvedLocations = useResolvedLocationMap(locationGroups)
  const mapResizeToken = `${mapOpen}-${isMapMaximized}-${detail?.route.length || 0}`

  useEffect(() => {
    if (!mapOpen) return
    const previousOverflow = document.body.style.overflow
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMap()
    }

    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [mapOpen])
  const filteredRows = useMemo(() => {
    if (captureFilter === 'captured') return rows.filter(row => Number(row.location_count || 0) > 0)
    if (captureFilter === 'not_captured') return rows.filter(row => Number(row.location_count || 0) === 0)
    return rows
  }, [captureFilter, rows])

  const locationTableColumns = useMemo<Column<SummaryRow>[]>(() => ([
    {
      key: 'user_name',
      header: 'User Name',
      sortable: true,
      searchable: true,
      minWidth: '190px',
      render: value => <span className="font-bold text-slate-900">{String(value || '--')}</span>,
    },
    {
      key: 'employee_code',
      header: 'Employee Code',
      sortable: true,
      searchable: true,
      minWidth: '130px',
      render: value => <span className="text-slate-600">{String(value || '--')}</span>,
    },
    {
      key: 'last_location_time',
      header: 'Last Location Time',
      sortable: true,
      minWidth: '170px',
      render: value => <span className="text-slate-600">{displayDateTime(value as string | null)}</span>,
    },
    {
      key: 'tracking_status',
      header: 'Tracking Status',
      sortable: true,
      searchable: true,
      minWidth: '150px',
      render: value => (
        <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${statusTone(String(value || ''))}`}>
          {String(value || '--')}
        </span>
      ),
    },
    {
      key: 'location_count',
      header: "Today's Location Count",
      sortable: true,
      align: 'right',
      minWidth: '170px',
      render: value => <span className="font-black text-slate-900">{Number(value || 0).toLocaleString('en-IN')}</span>,
    },
    {
      key: 'stopped_time_label',
      header: "Today's Stopped Time",
      sortable: true,
      align: 'right',
      minWidth: '160px',
      render: value => <span className="font-black text-slate-700">{String(value || '--')}</span>,
    },
    {
      key: 'view_map',
      header: 'View Map',
      align: 'right',
      pinned: true,
      searchable: false,
      minWidth: '130px',
      render: (_value, row) => (
        <button
          type="button"
          disabled={!row.can_view_map || detailLoading}
          onClick={event => {
            event.stopPropagation()
            openMap(row)
          }}
          className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-black transition ${
            row.can_view_map
              ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
              : 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-300'
          }`}
        >
          <Route size={12} />
          View Map
        </button>
      ),
    },
  ]), [detailLoading])
  const hasActiveFilters = Boolean(selectedUserId || activityDate !== todayIso() || captureFilter !== 'all')
  const locationTableToolbar = (
    <>
      <div className="min-w-[180px] max-w-[260px] flex-[1_1_220px] self-center">
        <SearchableSelect
          options={userOptions.map(option => ({
            value: option.user_id,
            label: option.user_name,
            subtitle: option.employee_code || undefined,
          }))}
          value={selectedUserId}
          onChange={value => setSelectedUserId(value ? Number(value) : null)}
          placeholder="All Visible Users"
          clearable
          className="!m-0 [&_.form-field-shell]:!h-8 [&_.form-field-shell]:!min-h-[32px] [&_.form-field-shell]:!py-0 [&_.form-field-shell]:rounded-xl [&_.form-field-shell]:border-[#dbe4f0] [&_.form-field-shell]:bg-white [&_.form-field-shell]:text-[11px] [&_.form-field-shell]:font-bold [&_.form-field-shell]:shadow-sm"
        />
      </div>

      <div className="relative h-8 w-[170px] shrink-0 self-center">
        <Calendar size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="date"
          value={activityDate}
          onChange={event => setActivityDate(event.target.value)}
          className="h-8 w-full rounded-xl border border-[#dbe4f0] bg-white pl-9 pr-3 text-[11px] font-bold text-slate-950 shadow-sm outline-none transition focus:border-blue-400"
        />
      </div>

      <div className="w-[180px] shrink-0 self-center">
        <SearchableSelect
          options={[
            { value: 'all', label: 'All Capture Status' },
            { value: 'captured', label: 'Captured Today' },
            { value: 'not_captured', label: 'Not Captured Today' },
          ]}
          value={captureFilter}
          onChange={value => setCaptureFilter((value || 'all') as 'all' | 'captured' | 'not_captured')}
          placeholder="Location Capture"
          className="!m-0 [&_.form-field-shell]:!h-8 [&_.form-field-shell]:!min-h-[32px] [&_.form-field-shell]:!py-0 [&_.form-field-shell]:rounded-xl [&_.form-field-shell]:border-[#dbe4f0] [&_.form-field-shell]:bg-white [&_.form-field-shell]:text-[11px] [&_.form-field-shell]:font-bold [&_.form-field-shell]:shadow-sm"
        />
      </div>

      <button
        type="button"
        onClick={loadSummary}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 self-center rounded-xl border border-[#dbe4f0] bg-white px-3 text-[11px] font-bold text-slate-700 shadow-sm transition hover:bg-slate-50"
      >
        <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        Refresh
      </button>

      {hasActiveFilters && (
        <button
          type="button"
          onClick={() => {
            setSelectedUserId(null)
            setActivityDate(todayIso())
            setCaptureFilter('all')
          }}
          className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 self-center rounded-xl px-1.5 text-[10px] font-bold text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <X size={11} />
          Reset
        </button>
      )}
    </>
  )

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <div>
            <div className="flex items-center gap-2">
              <Navigation size={15} className="text-blue-600" />
              <h3 className="text-base font-black text-slate-950">User Location Day Map</h3>
            </div>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              Day-wise grouped stayed locations from raw user GPS tracking logs
            </p>
          </div>

          {false && <div className="grid w-full gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto] xl:w-auto xl:min-w-[760px]">
            <div>
              <label className="mb-1.5 block text-xs font-black uppercase tracking-wide text-slate-500">User</label>
              <select
                value={selectedUserId || ''}
                onChange={event => setSelectedUserId(event.target.value ? Number(event.target.value) : null)}
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-blue-400"
              >
                <option value="">All Visible Users</option>
                {userOptions.map(option => (
                  <option key={option.user_id} value={option.user_id}>
                    {option.user_name}{option.employee_code ? ` • ${option.employee_code}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-black uppercase tracking-wide text-slate-500">Date</label>
              <div className="relative">
                <Calendar size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="date"
                  value={activityDate}
                  onChange={event => setActivityDate(event.target.value)}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-blue-400"
                />
              </div>
            </div>

            <div className="flex items-end">
              <button
                type="button"
                onClick={loadSummary}
                className="inline-flex h-11 items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-black text-slate-700 transition hover:bg-slate-50"
              >
                <RefreshCw size={14} />
                Refresh
              </button>
            </div>
          </div>}
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {mapSummaryCards.map(card => (
            <div key={card.label} className="rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
              <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wide text-slate-500">
                {card.icon}
                {card.label}
              </div>
              <p className="mt-2 text-2xl font-black text-slate-950">
                {typeof card.value === 'number' ? card.value.toLocaleString('en-IN') : card.value}
              </p>
            </div>
          ))}
        </div>
      </div>

      {false && <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-4 py-3">
          <p className="text-sm font-black text-slate-950">User Location Tracking Summary</p>
          <p className="mt-1 text-xs font-medium text-slate-500">Selected date: {displayDate(activityDate)}</p>
        </div>

        {error ? (
          <div className="px-4 py-12 text-center text-sm font-semibold text-rose-500">{error}</div>
        ) : loading ? (
          <div className="px-4 py-12 text-center text-sm font-semibold text-slate-400">Loading location summary…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm font-semibold text-slate-400">No user location logs found for the selected day</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead className="bg-slate-50/80">
                <tr className="text-left text-[11px] font-black uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3">User name</th>
                  <th className="px-4 py-3">Employee code</th>
                  <th className="px-4 py-3">Last location time</th>
                  <th className="px-4 py-3">Tracking status</th>
                  <th className="px-4 py-3 text-right">Today&apos;s location count</th>
                  <th className="px-4 py-3 text-right">Today&apos;s stopped time</th>
                  <th className="px-4 py-3 text-right">View Map button</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(row => (
                  <tr key={row.user_id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <div className="font-bold text-slate-900">{row.user_name}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{row.employee_code || '--'}</td>
                    <td className="px-4 py-3 text-slate-600">{displayDateTime(row.last_location_time)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${statusTone(row.tracking_status)}`}>
                        {row.tracking_status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-black text-slate-900">{Number(row.location_count).toLocaleString('en-IN')}</td>
                    <td className="px-4 py-3 text-right font-black text-slate-700">{row.stopped_time_label}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        disabled={!row.can_view_map || detailLoading}
                        onClick={() => openMap(row)}
                        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-black transition ${
                          row.can_view_map
                            ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                            : 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-300'
                        }`}
                      >
                        <Route size={12} />
                        View Map
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>}

      {error ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-12 text-center text-sm font-semibold text-rose-500 shadow-sm">{error}</div>
      ) : (
        <DataTable
          columns={locationTableColumns as unknown as Column<Record<string, unknown>>[]}
          data={filteredRows as unknown as Record<string, unknown>[]}
          loading={loading}
          keyField="user_id"
          toolbar={locationTableToolbar}
          toolbarVariant="compact"
          showSearch
          searchPlaceholder="Search user..."
          searchInputClassName="h-8 w-[210px] rounded-xl border-[#dbe4f0] py-0 text-[11px] font-bold shadow-sm"
          showExport={canExport}
          showColumnToggle
          compact
          maxHeight="560px"
          emptyMessage="No user location logs found for the selected day"
          emptyIcon={<MapPin size={22} />}
          exportFilename="user_location_tracking_summary"
        />
      )}

      {mapOpen && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/45 px-4 py-5 backdrop-blur-sm"
          onClick={closeMap}
        >
          <div
            className={`flex w-full flex-col overflow-hidden border border-slate-200 bg-white shadow-2xl transition-all duration-200 ${
              isMapMaximized
                ? 'h-[98vh] max-h-[98vh] max-w-[98vw] rounded-2xl'
                : 'h-[92vh] max-w-7xl rounded-2xl'
            }`}
            onClick={event => event.stopPropagation()}
          >
            <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-base font-black text-slate-950">
                  {detail?.user.user_name || 'User'} Location Route
                </p>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  {detail?.user.employee_code ? `${detail.user.employee_code} • ` : ''}{displayDate(detail?.activity_date || activityDate)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {detail && (
                  <>
                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-black ${statusTone(detail.summary.tracking_status)}`}>
                      {detail.summary.tracking_status}
                    </span>
                    <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-700">
                      {detail.raw_location_count.toLocaleString('en-IN')} raw GPS records
                    </span>
                    <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-black text-blue-700">
                      {detail.groups.length.toLocaleString('en-IN')} grouped locations
                    </span>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setIsMapMaximized(value => !value)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
                  aria-label={isMapMaximized ? 'Minimize map popup' : 'Maximize map popup'}
                >
                  {isMapMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
                <button
                  type="button"
                  onClick={closeMap}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
                  aria-label="Close map"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {detailError ? (
              <div className="px-4 py-12 text-center text-sm font-semibold text-rose-500">{detailError}</div>
            ) : detailLoading ? (
              <div className="px-4 py-12 text-center text-sm font-semibold text-slate-400">Loading user route map...</div>
            ) : detail ? (
              <div className="grid min-h-0 flex-1 gap-0 xl:grid-cols-[minmax(0,1.35fr)_360px]">
                <div className="min-h-0 border-b border-slate-100 p-4 xl:border-b-0 xl:border-r">
                  {detail.route.length > 0 ? (
                    <div className="kam-user-location-map-shell h-full min-h-[460px] overflow-hidden rounded-2xl border border-slate-200">
                      <MapContainer
                        center={INDIA_CENTER}
                        zoom={5}
                        scrollWheelZoom
                        style={{ height: '100%', width: '100%' }}
                      >
                        <TileLayer
                          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                          attribution="&copy; OpenStreetMap contributors"
                        />
                        <UserLocationLeafletMap
                          groups={detail.route}
                          focusedGroupIndex={focusedGroupIndex}
                          resolvedLocations={resolvedLocations}
                          resizeToken={mapResizeToken}
                        />
                      </MapContainer>
                    </div>
                  ) : (
                    <div className="flex h-full min-h-[460px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 text-sm font-semibold text-slate-400">
                      No grouped locations available for this day
                    </div>
                  )}
                </div>

                <div className="min-h-0 overflow-y-auto p-4">
                  <div className="mb-4 grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
                      <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">Last location time</p>
                      <p className="mt-2 text-sm font-black text-slate-900">{displayDateTime(detail.summary.last_location_time)}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
                      <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">Stopped time</p>
                      <p className="mt-2 text-sm font-black text-slate-900">{detail.summary.stopped_time_label}</p>
                    </div>
                  </div>

                  <div className="mb-3 flex items-center gap-2">
                    <Clock3 size={14} className="text-violet-600" />
                    <p className="text-sm font-black text-slate-950">Stayed Location Timeline</p>
                  </div>

                  <div className="space-y-3">
                    {detail.route.map(group => (
                      <button
                        key={group.group_index}
                        type="button"
                        onClick={() => setFocusedGroupIndex(group.group_index)}
                        className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                          focusedGroupIndex === group.group_index
                            ? 'border-blue-300 bg-blue-50/70'
                            : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-black text-white ${
                                group.marker_type === 'start'
                                  ? 'bg-emerald-600'
                                  : group.marker_type === 'latest'
                                    ? 'bg-orange-600'
                                    : 'bg-blue-600'
                              }`}>
                                {group.marker_type === 'start' ? 'S' : group.marker_type === 'latest' ? 'E' : group.group_index}
                              </span>
                              <p className="text-sm font-black text-slate-900">
                                {group.marker_type === 'start'
                                  ? 'Start Location'
                                  : group.marker_type === 'latest'
                                    ? 'End / Latest Location'
                                    : `Stayed Location ${group.group_index}`}
                              </p>
                            </div>
                            <div className="mt-2 space-y-1 text-xs font-medium text-slate-500">
                              <p>Arrival: <span className="font-bold text-slate-800">{displayDateTime(group.arrival_time)}</span></p>
                              <p>Departure: <span className="font-bold text-slate-800">{displayDateTime(group.departure_time)}</span></p>
                              <p>Time spent: <span className="font-bold text-slate-800">{group.duration_label}</span></p>
                            </div>
                          </div>
                          <div className="text-right text-xs font-bold text-slate-500">
                            <p>{group.gps_record_count.toLocaleString('en-IN')} GPS logs</p>
                            <p className="mt-1 max-w-[180px] text-[11px] text-slate-400">
                              {resolvedLocations[String(group.group_index)] || 'Resolving location...'}
                            </p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="px-4 py-12 text-center text-sm font-semibold text-slate-400">No map data available</div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
