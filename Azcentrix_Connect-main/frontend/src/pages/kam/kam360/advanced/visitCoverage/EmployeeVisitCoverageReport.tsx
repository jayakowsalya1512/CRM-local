import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapContainer, useMap } from 'react-leaflet'
import {
  Activity,
  CheckCircle2,
  MapPin,
  Maximize2,
  Minimize2,
  Navigation,
  Route,
  Search,
  UserCircle2,
  X,
} from 'lucide-react'
import { kamApi } from '@/services/api'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { usePermissions } from '@/hooks'
import { useResolvedLocationMap } from '@/utils/reverseGeocode'

type Props = {
  requestPeriod: string
  requestViewType: string
  viewYear: number
  dateFrom?: string
  dateTo?: string
  dateLabel?: string
  selectedUid: number | null
  teamRows?: any[]
}

type RoutePoint = {
  id: number
  sequence: number
  group_key: string
  latitude: number
  longitude: number
  event_type: string
  event_at: string
  activity_date: string
  start_time: string
  end_time: string
  status: string
  customer_name: string
  subject: string
  activity_type: string
  location: string
  remarks: string
}

type CoverageRow = {
  key: string
  activity_id: number
  user_id: number | null
  employee_name: string
  customer_name: string
  activity_type: string
  subject: string
  activity_date: string
  status: string
  gps_logs: number
  unique_locations: number
  route: RoutePoint[]
}

type CoverageSummary = {
  activities: number
  total_activities: number
  completed_activities: number
  gps_logs: number
  gps_activities: number
  unique_locations: number
}

const INDIA_CENTER: [number, number] = [23.0, 80.5]
const INDIA_BOUNDS: [[number, number], [number, number]] = [
  [8.0, 72.0],
  [33.5, 90.5],
]

const displayDate = (value: string) => {
  if (!value) return '--'
  const [year, month, day] = String(value).split('-')
  return year && month && day ? `${day}-${month}-${year}` : value
}

const displayDateTime = (value: string) => {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const day = `${date.getDate()}`.padStart(2, '0')
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const year = date.getFullYear()
  const hour = `${date.getHours()}`.padStart(2, '0')
  const minute = `${date.getMinutes()}`.padStart(2, '0')
  return `${day}-${month}-${year} ${hour}:${minute}`
}

const pointTooltipHtml = (point: RoutePoint, resolvedLocation?: string) => `
  <div class="visit-coverage-tooltip">
    <div class="visit-coverage-tooltip__head">
      <div>
        <div class="visit-coverage-tooltip__title">Stop ${point.sequence}</div>
        <div class="visit-coverage-tooltip__sub">${point.activity_type || 'Activity log'}</div>
      </div>
    </div>
    <div class="visit-coverage-tooltip__body">
      <div class="visit-coverage-tooltip__row"><span>Event</span><b>${point.event_type || '--'}</b></div>
      <div class="visit-coverage-tooltip__row"><span>Time</span><b>${displayDateTime(point.event_at)}</b></div>
      <div class="visit-coverage-tooltip__row"><span>Customer</span><b>${point.customer_name || '--'}</b></div>
      <div class="visit-coverage-tooltip__row"><span>Place</span><b>${resolvedLocation || point.location || 'Resolving location...'}</b></div>
    </div>
  </div>
`

function VisitCoverageLeafletMap({
  route,
  focusedPoint,
  resolvedLocations,
}: {
  route: RoutePoint[]
  focusedPoint: { pointId: number; nonce: number } | null
  resolvedLocations: Record<string, string>
}) {
  const map = useMap()
  const markerByIdRef = useRef<Record<number, L.Marker>>({})
  const pointById = useMemo(
    () => Object.fromEntries(route.map(point => [point.id, point])),
    [route],
  )

  const markerHtml = (sequence: number, active = false) => `
    <div class="visit-coverage-marker ${active ? 'visit-coverage-marker--active' : ''}">
      <span>${sequence}</span>
    </div>
  `

  const focusPointById = (pointId: number) => {
    const point = pointById[pointId]
    const marker = markerByIdRef.current[pointId]
    if (!point || !marker) return

    map.stop()
    map.closeTooltip()
    map.invalidateSize()
    map.setView([point.latitude, point.longitude], 16, {
      animate: true,
      duration: 0.9,
    })

    marker.setIcon(
      L.divIcon({
        className: 'visit-coverage-marker-shell',
        html: markerHtml(point.sequence, true),
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      }),
    )

    const timer = window.setTimeout(() => {
      marker.setIcon(
        L.divIcon({
          className: 'visit-coverage-marker-shell',
          html: markerHtml(point.sequence),
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
      )
    }, 1400)

    return () => window.clearTimeout(timer)
  }

  useEffect(() => {
    const styleId = 'visit-coverage-map-style'

    if (!document.getElementById(styleId)) {
      const style = document.createElement('style')
      style.id = styleId
      style.innerHTML = `
        .visit-coverage-map-shell,
        .visit-coverage-map-shell .leaflet-container {
          position: relative;
          z-index: 0 !important;
        }

        .visit-coverage-map-shell .leaflet-pane,
        .visit-coverage-map-shell .leaflet-top,
        .visit-coverage-map-shell .leaflet-bottom {
          z-index: 1 !important;
        }

        .visit-coverage-map-shell .leaflet-tooltip-pane,
        .visit-coverage-map-shell .leaflet-popup-pane {
          z-index: 3 !important;
        }

        .visit-coverage-map-shell .leaflet-control-attribution {
          display: none !important;
        }

        .visit-coverage-marker-shell {
          background: transparent !important;
          border: none !important;
        }

        .visit-coverage-marker {
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          border-radius: 999px;
          background: linear-gradient(135deg, #2563eb, #0f766e);
          border: 3px solid #ffffff;
          color: #ffffff;
          box-shadow: 0 12px 26px rgba(15, 23, 42, 0.24);
          font-size: 12px;
          font-weight: 900;
        }

        .visit-coverage-marker--active {
          background: linear-gradient(135deg, #f59e0b, #ea580c);
        }

        .leaflet-tooltip.visit-coverage-tooltip-box {
          padding: 0 !important;
          border: none !important;
          background: transparent !important;
          box-shadow: none !important;
        }

        .visit-coverage-tooltip {
          min-width: 220px;
          overflow: hidden;
          border-radius: 16px;
          background: #ffffff;
          box-shadow: 0 16px 34px rgba(15, 23, 42, 0.22);
          font-family: inherit;
        }

        .visit-coverage-tooltip__head {
          padding: 10px 12px;
          background: linear-gradient(135deg, #2563eb, #0f766e);
          color: #ffffff;
        }

        .visit-coverage-tooltip__title {
          font-size: 13px;
          font-weight: 900;
          line-height: 1.2;
        }

        .visit-coverage-tooltip__sub {
          margin-top: 2px;
          font-size: 11px;
          font-weight: 700;
          opacity: 0.9;
        }

        .visit-coverage-tooltip__body {
          padding: 10px 12px 12px;
        }

        .visit-coverage-tooltip__row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-top: 7px;
          color: #475569;
          font-size: 12px;
          font-weight: 700;
        }

        .visit-coverage-tooltip__row b {
          color: #0f172a;
          font-size: 12px;
          font-weight: 900;
          white-space: nowrap;
        }
      `
      document.head.appendChild(style)
    }
  }, [])

  useEffect(() => {
    const tileLayer = L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      {
        maxZoom: 19,
        noWrap: true,
        attribution: '',
      },
    ).addTo(map)

    map.setMaxBounds(INDIA_BOUNDS)

    return () => {
      map.removeLayer(tileLayer)
    }
  }, [map])

  useEffect(() => {
    const markerLayer = L.layerGroup().addTo(map)
    const routeLayer = L.layerGroup().addTo(map)
    markerByIdRef.current = {}

    route.forEach(point => {
      const marker = L.marker([point.latitude, point.longitude], {
        icon: L.divIcon({
          className: 'visit-coverage-marker-shell',
          html: markerHtml(point.sequence),
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
      })

      marker.bindTooltip(pointTooltipHtml(point, resolvedLocations[String(point.id)]), {
        direction: 'top',
        offset: [0, -10],
        opacity: 1,
        sticky: true,
        className: 'visit-coverage-tooltip-box',
      })

      marker.on('click', () => {
        focusPointById(point.id)
      })

      markerByIdRef.current[point.id] = marker
      markerLayer.addLayer(marker)
    })

    if (route.length > 1) {
      const line = L.polyline(
        route.map(point => [point.latitude, point.longitude] as [number, number]),
        {
          color: '#2563eb',
          weight: 4,
          opacity: 0.72,
        },
      )
      routeLayer.addLayer(line)
    }

    if (route.length === 1) {
      map.setView([route[0].latitude, route[0].longitude], 14, { animate: false })
    } else if (route.length > 1) {
      const bounds = L.latLngBounds(
        route.map(point => [point.latitude, point.longitude] as [number, number]),
      )
      map.fitBounds(bounds.pad(0.18), { animate: false })
    } else {
      map.fitBounds(INDIA_BOUNDS, { padding: [35, 35], animate: false })
      map.setView(INDIA_CENTER, 5, { animate: false })
    }

    return () => {
      markerByIdRef.current = {}
      markerLayer.remove()
      routeLayer.remove()
    }
  }, [map, pointById, resolvedLocations, route])

  useEffect(() => {
    if (!focusedPoint) return
    return focusPointById(focusedPoint.pointId)
  }, [focusedPoint, pointById])

  return null
}

function VisitCoverageMapModal({
  row,
  onClose,
}: {
  row: CoverageRow
  onClose: () => void
}) {
  const [isMaximized, setIsMaximized] = useState(false)
  const [focusedPoint, setFocusedPoint] = useState<{ pointId: number; nonce: number } | null>(null)
  const focusNonceRef = useRef(0)
  const locationPoints = useMemo(
    () => row.route.map(point => ({
      key: String(point.id),
      latitude: point.latitude,
      longitude: point.longitude,
      address: point.location || null,
    })),
    [row.route],
  )
  const resolvedLocations = useResolvedLocationMap(locationPoints)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/45 p-3 backdrop-blur-[2px] sm:p-5"
      onClick={onClose}
    >
      <div
        className={`flex w-full flex-col overflow-hidden border border-slate-200 bg-white shadow-[0_32px_90px_rgba(15,23,42,0.28)] transition-all duration-200 ${
          isMaximized
            ? 'h-[96vh] max-h-[96vh] max-w-[96vw] rounded-[22px]'
            : 'max-h-[92vh] max-w-7xl rounded-[28px]'
        }`}
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
          <div>
            <p className="text-lg font-black text-slate-950">{row.subject || row.activity_type || `Activity #${row.activity_id}`}</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              {row.employee_name} • {row.customer_name || 'No customer'} • {displayDate(row.activity_date)}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setIsMaximized(value => !value)}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-white hover:text-slate-700"
              aria-label={isMaximized ? 'Minimize map popup' : 'Maximize map popup'}
            >
              {isMaximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-white hover:text-slate-700"
              aria-label="Close map"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 border-b border-slate-100 px-5 py-4 lg:grid-cols-4">
          {[
            { label: 'Activity ID', value: row.activity_id, icon: <Activity size={14} className="text-blue-600" /> },
            { label: 'GPS Logs', value: row.gps_logs, icon: <MapPin size={14} className="text-cyan-600" /> },
            { label: 'Unique Locations', value: row.unique_locations, icon: <Route size={14} className="text-violet-600" /> },
            { label: 'Status', value: row.status || '--', icon: <CheckCircle2 size={14} className="text-emerald-600" /> },
          ].map(card => (
            <div key={card.label} className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wide text-slate-500">
                {card.icon}
                {card.label}
              </div>
              <p className="mt-2 text-2xl font-black text-slate-950">{String(card.value)}</p>
            </div>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1.45fr)_400px]">
          <div className="min-h-[380px] border-b border-slate-200 lg:border-b-0 lg:border-r">
            <div className="visit-coverage-map-shell h-full w-full bg-slate-100">
              <MapContainer
                center={INDIA_CENTER}
                zoom={5}
                minZoom={4}
                scrollWheelZoom={true}
                zoomControl={true}
                style={{ height: '100%', width: '100%' }}
              >
                <VisitCoverageLeafletMap
                  route={row.route}
                  focusedPoint={focusedPoint}
                  resolvedLocations={resolvedLocations}
                />
              </MapContainer>
            </div>
          </div>

          <div className="min-h-0 overflow-y-auto bg-white">
            <div className="border-b border-slate-100 px-4 py-3">
              <p className="text-sm font-black text-slate-900">Activity GPS Timeline</p>
              <p className="mt-0.5 text-xs font-semibold text-slate-400">
                {row.route.length} captured log points for this activity
              </p>
            </div>
            <div className="divide-y divide-slate-100">
              {row.route.map(point => (
                <button
                  key={point.id}
                  type="button"
                  onClick={() => {
                    focusNonceRef.current += 1
                    setFocusedPoint({ pointId: point.id, nonce: focusNonceRef.current })
                  }}
                  className="block w-full px-4 py-3 text-left transition hover:bg-slate-50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black text-slate-900">
                        Stop {point.sequence} • {point.event_type || 'Activity log'}
                      </p>
                      <p className="mt-1 text-xs font-semibold text-slate-500">
                        {displayDateTime(point.event_at)}
                      </p>
                      <p className="mt-1 truncate text-xs text-slate-400">
                        {point.location || point.customer_name || point.subject || '--'}
                      </p>
                      {point.remarks && (
                        <p className="mt-1 truncate text-xs text-slate-400">{point.remarks}</p>
                      )}
                    </div>
                    <span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-black text-blue-700">
                      {point.sequence}
                    </span>
                  </div>
                  <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-600">
                    {resolvedLocations[String(point.id)] || point.location || 'Resolving location...'}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function EmployeeVisitCoverageReport({
  requestPeriod,
  requestViewType,
  viewYear,
  dateFrom,
  dateTo,
  dateLabel,
  selectedUid,
  teamRows = [],
}: Props) {
  const canExport = usePermissions().can('kam.export')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [selectedUserId, setSelectedUserId] = useState<number | null>(selectedUid)
  const [statusMode, setStatusMode] = useState<'completed' | 'all'>('completed')
  const [rows, setRows] = useState<CoverageRow[]>([])
  const [summary, setSummary] = useState<CoverageSummary>({
    activities: 0,
    total_activities: 0,
    completed_activities: 0,
    gps_logs: 0,
    gps_activities: 0,
    unique_locations: 0,
  })
  const [mapRow, setMapRow] = useState<CoverageRow | null>(null)

  useEffect(() => {
    setSelectedUserId(selectedUid)
  }, [selectedUid])

  const userOptions = useMemo(() => {
    const byId = new Map<number, string>()

    teamRows.forEach(member => {
      const id = Number(member?.user_id || member?.id || member?.value || 0)
      if (!id || byId.has(id)) return
      const name = String(
        member?.user_name ||
        member?.full_name ||
        member?.label ||
        member?.username ||
        `User ${id}`,
      )
      byId.set(id, name)
    })

    rows.forEach(row => {
      const id = Number(row.user_id || 0)
      if (!id || byId.has(id)) return
      byId.set(id, row.employee_name || `User ${id}`)
    })

    return Array.from(byId, ([user_id, user_name]) => ({ user_id, user_name }))
      .sort((a, b) => a.user_name.localeCompare(b.user_name))
  }, [rows, teamRows])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError('')

      try {
        const response = await kamApi.visitCoverage({
          user_id: selectedUserId || undefined,
          period: requestPeriod,
          view_type: requestViewType,
          year: viewYear,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          status_mode: statusMode,
        })

        if (cancelled) return

        const nextRows = Array.isArray(response.data?.rows) ? response.data.rows : []
        const nextSummary = response.data?.summary || {}

        setRows(nextRows)
        setSummary({
          activities: Number(nextSummary.activities || 0),
          total_activities: Number(nextSummary.total_activities || 0),
          completed_activities: Number(nextSummary.completed_activities || 0),
          gps_logs: Number(nextSummary.gps_logs || 0),
          gps_activities: Number(nextSummary.gps_activities || 0),
          unique_locations: Number(nextSummary.unique_locations || 0),
        })
      } catch {
        if (!cancelled) setError('Failed to load activity visit coverage')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [dateFrom, dateTo, requestPeriod, requestViewType, selectedUserId, statusMode, viewYear])

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return rows
    return rows.filter(row =>
      [
        row.employee_name,
        row.customer_name,
        row.subject,
        row.activity_type,
        row.status,
      ].some(value => String(value || '').toLowerCase().includes(query)),
    )
  }, [rows, search])

  const filteredTotals = useMemo(() => ({
    activities: filteredRows.length,
    total_activities: filteredRows.length,
    completed_activities: filteredRows.filter(row => row.status === 'Completed').length,
    gps_logs: filteredRows.reduce((sum, row) => sum + row.gps_logs, 0),
    gps_activities: filteredRows.filter(row => row.gps_logs > 0).length,
    unique_locations: filteredRows.reduce((sum, row) => sum + row.unique_locations, 0),
  }), [filteredRows])

  const totals = search.trim() ? filteredTotals : summary
  const hasActiveFilters = Boolean(selectedUserId || search.trim() || statusMode !== 'completed')
  const tableColumns = useMemo<Column<CoverageRow>[]>(() => ([
    {
      key: 'subject',
      header: 'Activity',
      sortable: true,
      searchable: true,
      searchKeys: ['activity_type', 'activity_date'],
      minWidth: '280px',
      render: (_value, row) => {
        const index = filteredRows.findIndex(item => item.key === row.key)
        return (
          <div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-black text-white ${index % 2 === 0 ? 'bg-gradient-to-br from-blue-600 to-indigo-700' : 'bg-gradient-to-br from-emerald-600 to-teal-700'}`}>
              {row.gps_logs}
            </div>
            <div className="min-w-0">
              <p className="truncate font-black text-slate-950">{row.subject || row.activity_type || `Activity #${row.activity_id}`}</p>
              <p className="mt-0.5 text-xs font-semibold text-slate-400">
                {displayDate(row.activity_date)} - {row.activity_type || '--'}
              </p>
            </div>
          </div>
        )
      },
    },
    {
      key: 'employee_name',
      header: 'Employee',
      sortable: true,
      searchable: true,
      minWidth: '160px',
      render: value => <span className="font-black text-slate-900">{String(value || '--')}</span>,
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      searchable: true,
      minWidth: '260px',
      render: value => <span className="font-semibold text-slate-600">{String(value || '--')}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      searchable: true,
      minWidth: '120px',
      render: value => <span className="font-black text-emerald-700">{String(value || '--')}</span>,
    },
    {
      key: 'gps_logs',
      header: 'GPS Logs',
      sortable: true,
      align: 'right',
      minWidth: '100px',
      render: value => <span className="font-black text-cyan-700">{Number(value || 0).toLocaleString('en-IN')}</span>,
    },
    {
      key: 'unique_locations',
      header: 'Unique Locations',
      sortable: true,
      align: 'right',
      minWidth: '140px',
      render: value => <span className="font-black text-violet-700">{Number(value || 0).toLocaleString('en-IN')}</span>,
    },
    {
      key: 'view_map',
      header: 'View Map',
      align: 'center',
      pinned: true,
      searchable: false,
      minWidth: '120px',
      render: (_value, row) => (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation()
            if (row.route.length > 0) setMapRow(row)
          }}
          disabled={row.route.length === 0}
          className="inline-flex h-9 items-center justify-center rounded-xl border border-blue-200 bg-blue-50 px-4 text-xs font-black text-blue-700 transition hover:border-blue-300 hover:bg-blue-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
        >
          View Map
        </button>
      ),
    },
  ]), [filteredRows])

  const tableToolbar = (
    <>
      <div className="relative h-8 min-w-[190px] max-w-[320px] flex-[1_1_260px] self-center">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Search activity..."
          className="h-8 w-full rounded-xl border border-[#dbe4f0] bg-white pl-9 pr-3 text-[11px] font-bold text-slate-950 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-400"
        />
      </div>

      <div className="min-w-[180px] max-w-[260px] flex-[1_1_220px] self-center">
        <SearchableSelect
          options={userOptions.map(option => ({
            value: option.user_id,
            label: option.user_name,
          }))}
          value={selectedUserId}
          onChange={value => setSelectedUserId(value ? Number(value) : null)}
          placeholder="All Users"
          clearable
          className="!m-0 [&_.form-field-shell]:!h-8 [&_.form-field-shell]:!min-h-[32px] [&_.form-field-shell]:!py-0 [&_.form-field-shell]:rounded-xl [&_.form-field-shell]:border-[#dbe4f0] [&_.form-field-shell]:bg-white [&_.form-field-shell]:text-[11px] [&_.form-field-shell]:font-bold [&_.form-field-shell]:shadow-sm"
        />
      </div>

      <div className="inline-flex h-8 shrink-0 self-center overflow-hidden rounded-xl border border-[#dbe4f0] bg-white shadow-sm">
        {([
          { id: 'completed', label: 'Completed Only' },
          { id: 'all', label: 'All Activities' },
        ] as const).map(option => (
          <button
            key={option.id}
            type="button"
            onClick={() => setStatusMode(option.id)}
            className={`flex h-full min-w-[112px] items-center justify-center px-3 text-center text-[11px] font-bold leading-tight transition ${
              statusMode === option.id
                ? 'bg-blue-50 text-blue-700'
                : 'bg-white text-slate-950 hover:bg-slate-50'
            } ${option.id === 'completed' ? 'border-r border-slate-200' : ''}`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {hasActiveFilters && (
        <button
          type="button"
          onClick={() => {
            setSelectedUserId(null)
            setStatusMode('completed')
            setSearch('')
          }}
          className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-xl px-1.5 text-[10px] font-bold text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <X size={11} />
          Reset
        </button>
      )}
    </>
  )

  return (
    <>
      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <div>
              <div className="flex items-center gap-2">
                <Navigation size={15} className="text-blue-600" />
                <h3 className="text-base font-black text-slate-950">Activity Visit Coverage</h3>
              </div>
              
              <p className="mt-1 text-xs font-bold uppercase tracking-[0.10em] text-slate-400">
                {dateLabel || `${dateFrom || '--'} to ${dateTo || '--'}`}
              </p>
            </div>

          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[
              { label: 'Activities', value: totals.activities, icon: <Activity size={14} className="text-sky-600" /> },
              { label: 'Completed', value: totals.completed_activities, icon: <CheckCircle2 size={14} className="text-emerald-600" /> },
              { label: 'GPS Activities', value: totals.gps_activities, icon: <UserCircle2 size={14} className="text-blue-600" /> },
              { label: 'GPS Logs', value: totals.gps_logs, icon: <MapPin size={14} className="text-cyan-600" /> },
              { label: 'Unique Locations', value: totals.unique_locations, icon: <Route size={14} className="text-violet-600" /> },
            ].map(card => (
              <div key={card.label} className="rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
                <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wide text-slate-500">
                  {card.icon}
                  {card.label}
                </div>
                <p className="mt-2 text-2xl font-black text-slate-950">
                  {card.value.toLocaleString('en-IN')}
                </p>
              </div>
            ))}
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-12 text-center shadow-sm">
            <p className="text-sm font-semibold text-red-500">{error}</p>
          </div>
        ) : (
          <DataTable
            columns={tableColumns as unknown as Column<Record<string, unknown>>[]}
            data={filteredRows as unknown as Record<string, unknown>[]}
            loading={loading}
            keyField="key"
            toolbar={tableToolbar}
            toolbarVariant="compact"
            showSearch={false}
            showExport={canExport}
            showColumnToggle
            compact
            maxHeight="560px"
            emptyMessage="No activity visit coverage found"
            emptyIcon={<MapPin size={22} />}
            exportFilename="activity_visit_coverage"
          />
        )}
      </div>

      {mapRow && <VisitCoverageMapModal row={mapRow} onClose={() => setMapRow(null)} />}
    </>
  )
}
