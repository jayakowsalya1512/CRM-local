/**
 * KAM activity audit / GPS-history / manager-reopen UI.
 *
 * Deliberately kept out of KAMPage.tsx (which is already very large) - this
 * file owns everything specific to the reopen workflow: the "reopened"
 * banner, the combined Timeline tab (each row already carries its own GPS
 * capture, so there's no separate location-history tab) and the Reopen
 * modal. KAMPage.tsx only wires these into ActivityDetailView and the
 * activity list's action menu; none of KAMPage.tsx's other KAM logic
 * (targets, 360 dashboard, weekly plan, etc.) is touched by this file.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapContainer, useMap } from 'react-leaflet'
import indiaStatesGeo from '@/assets/geo/india-states.json'
import {
  Activity,
  AlertCircle,
  AlignLeft,
  ArrowRight,
  Ban,
  CalendarDays,
  Car,
  CheckCircle2,
  Clock,
  FileText,
  Map as MapIcon,
  MapPin,
  Maximize2,
  Minimize2,
  Navigation,
  Pencil,
  Plane,
  PlayCircle,
  PlusCircle,
  RotateCcw,
  UserRound,
} from 'lucide-react'
import api from '@/services/api'
import {
  KAM_MAP_BOUNDS,
  KAM_MAP_CENTER,
  KAM_MAP_TILE_OPTIONS,
  KAM_MAP_TILE_URL,
} from './kam360/MapSection'

function fmtDateTime(value?: string | null) {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fieldLabel(field: string) {
  return field
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

const EVENT_LABEL: Record<string, string> = {
  ACTIVITY_CREATED: 'Activity created',
  ACTIVITY_UPDATED: 'Activity updated',
  ACTIVITY_STARTED: 'Activity started',
  ACTIVITY_COMPLETED: 'Activity completed',
  ACTIVITY_CANCELLED: 'Activity cancelled',
  ACTIVITY_POSTPONED: 'Activity postponed',
  ACTIVITY_REOPENED: 'Activity reopened',
  ACTIVITY_REASSIGNED: 'Activity reassigned',
  LEGACY_ACTIVITY_MIGRATED: 'Activity history migrated',
}

const LOCATION_FIELDS = ['latitude', 'longitude', 'accuracy_meters', 'address'] as const

type CapturedLocation = {
  latitude: number | null
  longitude: number | null
  accuracy_meters: number | null
  permission_status: 'granted' | 'denied' | 'unavailable' | 'timeout'
  client_event_at: string
}

type LatestReopen = { reopened_at?: string; reopened_by_name?: string; reason?: string } | null

type LogItem = {
  id: number
  event_type: string
  previous_status?: string | null
  new_status?: string | null
  actor_name?: string | null
  reason?: string | null
  outcome?: string | null
  remarks?: string | null
  raw_remarks?: string | null
  old_values?: Record<string, any> | null
  new_values?: Record<string, any> | null
  metadata?: Record<string, any> | null
  latitude?: number | null
  longitude?: number | null
  accuracy_meters?: number | null
  address?: string | null
  permission_status?: string | null
  event_at?: string | null
}

type LocationSnapshot = {
  latitude: number | null
  longitude: number | null
  accuracy_meters?: number | null
  address?: string | null
}

type MapPopupPointSource = {
  key: string
  label: string
  timeLabel?: string | null
  location: LocationSnapshot
}

type TimelineMapPoint = {
  key: string
  sequence: number
  label: string
  timeLabel?: string | null
  latitude: number
  longitude: number
  accuracy_meters?: number | null
  address?: string | null
}

const ACTIVITY_MAP_DEFAULT_ZOOM = 5.75
const ACTIVITY_MAP_POINT_ZOOM = 6.25
const ACTIVITY_MAP_MAX_FIT_ZOOM = 7
const ACTIVITY_LOCATION_ICON_URL = '/user-location.png'
const ACTIVITY_LOCATION_ICON_SIZE: [number, number] = [42, 50]
const ACTIVITY_LOCATION_ICON_ANCHOR: [number, number] = [21, 50]
const reverseGeocodeCache = new Map<string, string | null>()
const reverseGeocodeInflight = new Map<string, Promise<string | null>>()

function toNullableNumber(value: any) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isValidLatLng(latitude: number, longitude: number) {
  return (
    Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180
  )
}

function isInsideIndiaBounds(latitude: number, longitude: number) {
  const [[south, west], [north, east]] = KAM_MAP_BOUNDS
  return latitude >= south && latitude <= north && longitude >= west && longitude <= east
}

function normalizeActivityMapCoordinates(latitude: number, longitude: number) {
  if (isInsideIndiaBounds(latitude, longitude)) return { latitude, longitude }
  if (isInsideIndiaBounds(longitude, latitude)) {
    return { latitude: longitude, longitude: latitude }
  }
  return { latitude, longitude }
}

function normalizeLocationSnapshotForMap(snapshot?: LocationSnapshot | null) {
  if (!hasMapCoordinates(snapshot)) return snapshot
  const normalized = normalizeActivityMapCoordinates(snapshot.latitude, snapshot.longitude)
  return {
    ...snapshot,
    latitude: normalized.latitude,
    longitude: normalized.longitude,
  }
}

function locationCacheKey(latitude: number, longitude: number) {
  return `${latitude.toFixed(5)},${longitude.toFixed(5)}`
}

function compactLocationLabel(data: any) {
  const address = data?.address || {}
  const parts = [
    address.suburb
      || address.neighbourhood
      || address.village
      || address.hamlet
      || address.quarter
      || address.city_district
      || address.town
      || address.city
      || address.municipality
      || address.county,
    address.city && address.city !== address.suburb ? address.city : null,
    address.county && address.county !== address.city ? address.county : null,
    address.state,
  ]
    .map((value: unknown) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)

  const deduped: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    const key = part.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(part)
  }
  if (deduped.length) return deduped.slice(0, 3).join(', ')

  if (typeof data?.display_name === 'string' && data.display_name.trim()) {
    return data.display_name
      .split(',')
      .map((part: string) => part.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(', ')
  }
  return null
}

async function reverseGeocodeLocation(latitude: number, longitude: number) {
  const key = locationCacheKey(latitude, longitude)
  if (reverseGeocodeCache.has(key)) return reverseGeocodeCache.get(key) ?? null
  if (reverseGeocodeInflight.has(key)) return reverseGeocodeInflight.get(key) ?? null

  const request = fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}&zoom=18&addressdetails=1`,
    { headers: { Accept: 'application/json' } },
  )
    .then(async (response) => {
      if (!response.ok) return null
      const data = await response.json().catch(() => null)
      const label = compactLocationLabel(data)
      reverseGeocodeCache.set(key, label)
      return label
    })
    .catch(() => null)
    .finally(() => {
      reverseGeocodeInflight.delete(key)
    })

  reverseGeocodeInflight.set(key, request)
  return request
}

function getLocationSnapshot(source?: Record<string, any> | null): LocationSnapshot | null {
  if (!source) return null
  const latitude = toNullableNumber(source.latitude)
  const longitude = toNullableNumber(source.longitude)
  const accuracy_meters = toNullableNumber(source.accuracy_meters)
  const address = source.address != null ? String(source.address) : null
  if (latitude == null && longitude == null && accuracy_meters == null && !address) return null
  return { latitude, longitude, accuracy_meters, address }
}

function formatLocationSummary(snapshot?: LocationSnapshot | null, resolvedAddress?: string | null) {
  if (!snapshot) return 'location not available'
  if (snapshot.address) return snapshot.address
  if (resolvedAddress) return resolvedAddress
  if (snapshot.latitude != null && snapshot.longitude != null) return 'Location captured'
  return 'location not available'
}

function hasMapCoordinates(snapshot?: LocationSnapshot | null): snapshot is LocationSnapshot & { latitude: number; longitude: number } {
  return (
    snapshot?.latitude != null
    && snapshot.longitude != null
    && isValidLatLng(snapshot.latitude, snapshot.longitude)
  )
}

function useResolvedLocationLabel(snapshot?: LocationSnapshot | null) {
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(() => {
    if (snapshot?.address) return snapshot.address
    if (snapshot?.latitude == null || snapshot?.longitude == null) return null
    return reverseGeocodeCache.get(locationCacheKey(snapshot.latitude, snapshot.longitude)) ?? null
  })

  useEffect(() => {
    if (snapshot?.address) {
      setResolvedAddress(snapshot.address)
      return
    }
    if (snapshot?.latitude == null || snapshot?.longitude == null) {
      setResolvedAddress(null)
      return
    }

    const cached = reverseGeocodeCache.get(locationCacheKey(snapshot.latitude, snapshot.longitude))
    if (cached) {
      setResolvedAddress(cached)
      return
    }

    let alive = true
    reverseGeocodeLocation(snapshot.latitude, snapshot.longitude).then((label) => {
      if (alive) setResolvedAddress(label)
    })
    return () => { alive = false }
  }, [snapshot?.address, snapshot?.latitude, snapshot?.longitude])

  return formatLocationSummary(snapshot, resolvedAddress)
}

function locationTooltipHtml(point: TimelineMapPoint) {
  return `
    <div class="activity-audit-map-tooltip">
      <div class="activity-audit-map-tooltip__head">
        <div class="activity-audit-map-tooltip__step">${point.sequence}</div>
        <div>
          <div class="activity-audit-map-tooltip__title">${point.label}</div>
          <div class="activity-audit-map-tooltip__sub">${point.timeLabel || 'Location point'}</div>
        </div>
      </div>
      <div class="activity-audit-map-tooltip__body">
        <div class="activity-audit-map-tooltip__row activity-audit-map-tooltip__row--stack"><span>Place</span><b>${point.address || 'Resolving location...'}</b></div>
        ${point.accuracy_meters != null ? `<div class="activity-audit-map-tooltip__row"><span>Accuracy</span><b>+/-${Math.round(point.accuracy_meters)}m</b></div>` : ''}
      </div>
    </div>
  `
}

function TimelineLocationLeafletMap({
  points,
  resizeToken,
}: {
  points: TimelineMapPoint[]
  resizeToken: string
}) {
  const map = useMap()
  const markerByKeyRef = useRef<Record<string, L.Marker>>({})

  const markerHtml = (sequence: number, active = false) => `
    <div class="activity-audit-map-marker ${active ? 'activity-audit-map-marker--active' : ''}">
      <img src="${ACTIVITY_LOCATION_ICON_URL}" class="activity-audit-map-marker__img" />
      <span>${sequence}</span>
    </div>
  `

  const pointKeys = useMemo(() => points.map(point => point.key).join('|'), [points])

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      map.invalidateSize(false)
    })
    const timeoutId = window.setTimeout(() => {
      map.invalidateSize(false)
    }, 180)

    return () => {
      window.cancelAnimationFrame(rafId)
      window.clearTimeout(timeoutId)
    }
  }, [map, resizeToken, pointKeys])

  useEffect(() => {
    const styleId = 'activity-audit-map-style'

    if (!document.getElementById(styleId)) {
      const style = document.createElement('style')
      style.id = styleId
      style.innerHTML = `
        .activity-audit-map-shell,
        .activity-audit-map-shell .leaflet-container {
          position: relative;
          background: #eaf4f8;
          z-index: 0 !important;
        }

        .activity-audit-map-shell .leaflet-pane,
        .activity-audit-map-shell .leaflet-top,
        .activity-audit-map-shell .leaflet-bottom {
          z-index: 1 !important;
        }

        .activity-audit-map-shell .leaflet-marker-pane {
          z-index: 2 !important;
        }

        .activity-audit-map-shell .leaflet-tooltip-pane,
        .activity-audit-map-shell .leaflet-popup-pane {
          z-index: 3 !important;
        }

        .activity-audit-map-shell .leaflet-control-attribution {
          display: none !important;
        }

        .activity-audit-map-marker-shell {
          background: transparent !important;
          border: none !important;
        }

        .activity-audit-map-marker {
          position: relative;
          width: 42px;
          height: 50px;
        }

        .activity-audit-map-marker__img {
          width: 42px;
          height: 50px;
          object-fit: contain;
          filter: drop-shadow(0 12px 18px rgba(15, 23, 42, 0.22));
        }

        .activity-audit-map-marker span {
          position: absolute;
          right: -5px;
          top: -5px;
          display: grid;
          place-items: center;
          width: 20px;
          height: 20px;
          border-radius: 999px;
          border: 2px solid #ffffff;
          background: #2563eb;
          color: #ffffff;
          box-shadow: 0 8px 16px rgba(37, 99, 235, 0.26);
          font-size: 10px;
          font-weight: 800;
          line-height: 1;
        }

        .activity-audit-map-marker--active span {
          background: #f97316;
          box-shadow: 0 8px 16px rgba(249, 115, 22, 0.28);
        }

        .leaflet-tooltip.activity-audit-map-tooltip-box {
          padding: 0 !important;
          border: none !important;
          background: transparent !important;
          box-shadow: none !important;
        }

        .activity-audit-map-tooltip {
          min-width: 220px;
          max-width: 280px;
          overflow: hidden;
          border-radius: 16px;
          background: #ffffff;
          box-shadow: 0 16px 34px rgba(15, 23, 42, 0.22);
          font-family: inherit;
        }

        .activity-audit-map-tooltip__head {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          background: linear-gradient(135deg, #2563eb, #0f766e);
          color: #ffffff;
        }

        .activity-audit-map-tooltip__step {
          display: grid;
          place-items: center;
          width: 28px;
          height: 28px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.18);
          font-size: 12px;
          font-weight: 900;
        }

        .activity-audit-map-tooltip__title {
          font-size: 13px;
          font-weight: 900;
          line-height: 1.2;
        }

        .activity-audit-map-tooltip__sub {
          margin-top: 2px;
          font-size: 11px;
          font-weight: 700;
          opacity: 0.92;
        }

        .activity-audit-map-tooltip__body {
          padding: 10px 12px 12px;
        }

        .activity-audit-map-tooltip__row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-top: 7px;
          color: #475569;
          font-size: 12px;
          font-weight: 700;
        }

        .activity-audit-map-tooltip__row--stack {
          align-items: flex-start;
        }

        .activity-audit-map-tooltip__row--stack b {
          white-space: normal;
          text-align: right;
        }

        .activity-audit-map-tooltip__row b {
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
    const tileLayer = L.tileLayer(KAM_MAP_TILE_URL, KAM_MAP_TILE_OPTIONS).addTo(map)
    const indiaLayer = L.geoJSON(indiaStatesGeo as any, {
      interactive: false,
      style: {
        color: '#94a3b8',
        weight: 1,
        opacity: 0.5,
        fillOpacity: 0,
      },
    }).addTo(map)

    map.setMaxBounds(KAM_MAP_BOUNDS)
    map.fitBounds(KAM_MAP_BOUNDS, {
      padding: [28, 28],
      animate: false,
    })

    return () => {
      map.removeLayer(tileLayer)
      map.removeLayer(indiaLayer)
    }
  }, [map])

  useEffect(() => {
    const markerLayer = L.layerGroup().addTo(map)
    const routeLayer = L.layerGroup().addTo(map)
    markerByKeyRef.current = {}

    points.forEach((point) => {
      const marker = L.marker([point.latitude, point.longitude], {
        icon: L.divIcon({
          className: 'activity-audit-map-marker-shell',
          html: markerHtml(point.sequence),
          iconSize: ACTIVITY_LOCATION_ICON_SIZE,
          iconAnchor: ACTIVITY_LOCATION_ICON_ANCHOR,
        }),
      })

      marker.bindTooltip(locationTooltipHtml(point), {
        direction: 'top',
        offset: [0, -48],
        opacity: 1,
        sticky: true,
        className: 'activity-audit-map-tooltip-box',
      })

      markerByKeyRef.current[point.key] = marker
      markerLayer.addLayer(marker)
    })

    if (points.length > 1) {
      routeLayer.addLayer(
        L.polyline(
          points.map(point => [point.latitude, point.longitude] as [number, number]),
          {
            color: '#2563eb',
            weight: 4,
            opacity: 0.76,
          },
        ),
      )
    }

    if (points.length === 1) {
      map.setView(
        [points[0].latitude, points[0].longitude],
        ACTIVITY_MAP_POINT_ZOOM,
        { animate: false },
      )
    } else if (points.length > 1) {
      map.fitBounds(
        L.latLngBounds(points.map(point => [point.latitude, point.longitude] as [number, number])).pad(0.24),
        { animate: false, maxZoom: ACTIVITY_MAP_MAX_FIT_ZOOM },
      )
    } else {
      map.fitBounds(KAM_MAP_BOUNDS, { padding: [35, 35], animate: false })
      map.setView(KAM_MAP_CENTER, ACTIVITY_MAP_DEFAULT_ZOOM, { animate: false })
    }

    return () => {
      markerByKeyRef.current = {}
      markerLayer.remove()
      routeLayer.remove()
    }
  }, [map, pointKeys, points])

  return null
}

function MapPopup({
  open,
  title,
  onClose,
  points,
}: {
  open: boolean
  title: string
  onClose: () => void
  points: MapPopupPointSource[]
}) {
  const [isMaximized, setIsMaximized] = useState(false)
  const [resolvedAddresses, setResolvedAddresses] = useState<Record<string, string>>({})
  const mapPoints = useMemo(
    () => points.reduce<Array<{
      key: string
      sequence: number
      label: string
      timeLabel?: string | null
      latitude: number
      longitude: number
      accuracy_meters: number | null
      address: string | null
    }>>((acc, point) => {
      if (!hasMapCoordinates(point.location)) return acc

      const normalized = normalizeActivityMapCoordinates(
        point.location.latitude,
        point.location.longitude,
      )

      acc.push({
        key: point.key,
        sequence: acc.length + 1,
        label: point.label,
        timeLabel: point.timeLabel,
        latitude: normalized.latitude,
        longitude: normalized.longitude,
        accuracy_meters: point.location.accuracy_meters ?? null,
        address: point.location.address ?? null,
      })

      return acc
    }, []),
    [points],
  )
  const resolvedMapPoints = useMemo(
    () => mapPoints.map((point) => ({
      ...point,
      address: point.address ?? resolvedAddresses[point.key] ?? null,
    })),
    [mapPoints, resolvedAddresses],
  )
  const mapResizeToken = `${open}-${isMaximized}-${resolvedMapPoints.length}`

  useEffect(() => {
    let alive = true
    mapPoints.forEach((point) => {
      if (point.address) return
      reverseGeocodeLocation(point.latitude, point.longitude).then((label) => {
        if (!alive || !label) return
        setResolvedAddresses((previous) => previous[point.key] === label ? previous : { ...previous, [point.key]: label })
      })
    })
    return () => { alive = false }
  }, [mapPoints])

  useEffect(() => {
    if (!open) return undefined

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
  }, [onClose, open])

  useEffect(() => {
    if (!open) setIsMaximized(false)
  }, [open])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[100220] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[2px]">
      <div className={`w-full overflow-hidden border border-slate-200 bg-white shadow-[0_32px_90px_rgba(15,23,42,0.28)] transition-all duration-200 ${
        isMaximized
          ? 'h-[96vh] max-h-[96vh] max-w-[96vw] rounded-[22px]'
          : 'max-w-5xl rounded-[26px]'
      }`}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
          <div>
            <h3 className="text-lg font-black text-slate-950">{title}</h3>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              Hover a marker to see the place name, time and capture accuracy.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsMaximized(value => !value)}
              className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
              aria-label={isMaximized ? 'Minimize map popup' : 'Maximize map popup'}
            >
              {isMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </div>

        <div className={`grid gap-0 ${isMaximized ? 'min-h-0 flex-1 lg:grid-cols-[340px_minmax(0,1fr)]' : 'lg:grid-cols-[280px_minmax(0,1fr)]'}`}>
          <div className="border-b border-slate-200 bg-slate-50/60 p-4 lg:border-b-0 lg:border-r">
            <div className="space-y-3">
              {points.map((point, index) => (
                <MapPopupLocationCard key={point.key} point={point} index={index} />
              ))}
            </div>
          </div>

          <div className="p-4">
            {resolvedMapPoints.length ? (
              <div className="overflow-hidden rounded-2xl border border-slate-200">
                <div className={`activity-audit-map-shell w-full bg-slate-100 ${isMaximized ? 'h-[calc(96vh-136px)] min-h-[520px]' : 'h-[440px]'}`}>
                  <MapContainer
                    center={KAM_MAP_CENTER}
                    zoom={ACTIVITY_MAP_DEFAULT_ZOOM}
                    minZoom={4}
                    maxZoom={19}
                    zoomSnap={0.25}
                    zoomDelta={0.5}
                    scrollWheelZoom
                    doubleClickZoom
                    zoomControl
                    attributionControl={false}
                    maxBounds={KAM_MAP_BOUNDS}
                    maxBoundsViscosity={0.9}
                    worldCopyJump={false}
                    className="h-full w-full rounded-2xl"
                    style={{ height: '100%', width: '100%' }}
                  >
                    <TimelineLocationLeafletMap points={resolvedMapPoints} resizeToken={mapResizeToken} />
                  </MapContainer>
                </div>
              </div>
            ) : (
              <div className="flex h-[440px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 text-sm text-slate-400">
                No map coordinates were captured for this location entry.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function MapPopupLocationCard({ point, index }: { point: MapPopupPointSource; index: number }) {
  const normalizedLocation = useMemo(
    () => normalizeLocationSnapshotForMap(point.location),
    [point.location],
  )
  const resolvedLabel = useResolvedLocationLabel(normalizedLocation)

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-50 text-sm font-black text-blue-700">
          {index + 1}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-black uppercase tracking-[0.08em] text-slate-500">{point.label}</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">{resolvedLabel}</p>
          {point.timeLabel && (
            <p className="mt-2 text-xs font-semibold text-slate-500">{point.timeLabel}</p>
          )}
        </div>
      </div>
    </div>
  )
}

export function captureCurrentLocation(): Promise<CapturedLocation> {
  const client_event_at = new Date().toISOString()
  if (!navigator.geolocation) {
    return Promise.resolve({
      latitude: null,
      longitude: null,
      accuracy_meters: null,
      permission_status: 'unavailable',
      client_event_at,
    })
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy_meters: pos.coords.accuracy ?? null,
        permission_status: 'granted',
        client_event_at,
      }),
      (err) => resolve({
        latitude: null,
        longitude: null,
        accuracy_meters: null,
        permission_status: err.code === err.PERMISSION_DENIED ? 'denied' : err.code === err.TIMEOUT ? 'timeout' : 'unavailable',
        client_event_at,
      }),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
  })
}

export function generateIdempotencyKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function ReopenBanner({ activityId }: { activityId: number }) {
  const [latestReopen, setLatestReopen] = useState<LatestReopen>(null)

  useEffect(() => {
    let alive = true
    api.get(`/kam/activities/${activityId}`).then((res) => {
      if (alive) setLatestReopen(res.data?.latest_reopen || null)
    }).catch(() => {})
    return () => { alive = false }
  }, [activityId])

  if (!latestReopen) return null

  return (
    <div className="mx-5 mt-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <RotateCcw size={15} className="mt-0.5 flex-shrink-0 text-amber-500" />
      <div className="text-xs text-amber-800">
        <p className="font-bold">
          This activity was reopened{latestReopen.reopened_by_name ? ` by ${latestReopen.reopened_by_name}` : ''}
        </p>
        {latestReopen.reason && <p className="mt-1">Reason: {latestReopen.reason}</p>}
        {latestReopen.reopened_at && <p className="mt-1 text-amber-600">Reopened on: {fmtDateTime(latestReopen.reopened_at)}</p>}
      </div>
    </div>
  )
}

function auditFieldMeta(field: string) {
  const normalized = field.toLowerCase()

  if (normalized === 'subject') {
    return {
      label: 'Subject',
      icon: <FileText size={13} />,
      iconClass: 'bg-blue-50 text-blue-600 ring-blue-100',
      dotClass: 'bg-blue-500 ring-blue-100',
    }
  }

  if (normalized === 'description') {
    return {
      label: 'Description',
      icon: <AlignLeft size={13} />,
      iconClass: 'bg-teal-50 text-teal-600 ring-teal-100',
      dotClass: 'bg-teal-500 ring-teal-100',
    }
  }

  if (normalized === 'status') {
    return {
      label: 'Status',
      icon: <Activity size={13} />,
      iconClass: 'bg-violet-50 text-violet-600 ring-violet-100',
      dotClass: 'bg-violet-500 ring-violet-100',
    }
  }

  if (normalized === 'next_action') {
    return {
      label: 'Next Action',
      icon: <Navigation size={13} />,
      iconClass: 'bg-orange-50 text-orange-500 ring-orange-100',
      dotClass: 'bg-orange-500 ring-orange-100',
    }
  }

  if (normalized === 'next_action_date') {
    return {
      label: 'Next Action Date',
      icon: <CalendarDays size={13} />,
      iconClass: 'bg-blue-50 text-blue-600 ring-blue-100',
      dotClass: 'bg-blue-500 ring-blue-100',
    }
  }

  if (normalized === 'has_travel') {
    return {
      label: 'Has Travel',
      icon: <RotateCcw size={13} />,
      iconClass: 'bg-emerald-50 text-emerald-600 ring-emerald-100',
      dotClass: 'bg-emerald-500 ring-emerald-100',
    }
  }

  if (normalized === 'travel_mode') {
    return {
      label: 'Travel Mode',
      icon: <Car size={13} />,
      iconClass: 'bg-violet-50 text-violet-600 ring-violet-100',
      dotClass: 'bg-violet-500 ring-violet-100',
    }
  }

  if (normalized === 'travel_from') {
    return {
      label: 'Travel From',
      icon: <Plane size={13} />,
      iconClass: 'bg-amber-50 text-amber-600 ring-amber-100',
      dotClass: 'bg-amber-500 ring-amber-100',
    }
  }

  if (normalized === 'travel_to') {
    return {
      label: 'Travel To',
      icon: <Navigation size={13} />,
      iconClass: 'bg-cyan-50 text-cyan-600 ring-cyan-100',
      dotClass: 'bg-cyan-500 ring-cyan-100',
    }
  }

  if (normalized === 'is_outside_district') {
    return {
      label: 'Is Outside District',
      icon: <MapIcon size={13} />,
      iconClass: 'bg-indigo-50 text-indigo-600 ring-indigo-100',
      dotClass: 'bg-indigo-500 ring-indigo-100',
    }
  }

  if (normalized === 'location') {
    return {
      label: 'Location',
      icon: <MapPin size={13} />,
      iconClass: 'bg-rose-50 text-rose-500 ring-rose-100',
      dotClass: 'bg-rose-500 ring-rose-100',
    }
  }

  return {
    label: fieldLabel(field),
    icon: <AlertCircle size={13} />,
    iconClass: 'bg-slate-100 text-slate-500 ring-slate-200',
    dotClass: 'bg-slate-400 ring-slate-100',
  }
}

function formatAuditValue(value: any) {
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function auditValuePillClass(
  value: any,
  variant: 'previous' | 'next' = 'next',
) {
  if (value === null || value === undefined || value === '') {
    return 'border-slate-200 bg-slate-50 text-slate-400'
  }

  if (variant === 'previous') {
    return 'border-slate-200 bg-slate-100 text-slate-600'
  }

  if (value === true || value === 'true') {
    return 'border-emerald-100 bg-emerald-50 text-emerald-700'
  }

  if (value === false || value === 'false') {
    return 'border-slate-200 bg-slate-100 text-slate-600'
  }

  return 'border-blue-100 bg-blue-50 text-blue-700'
}

function AuditValuePill({
  value,
  variant = 'next',
}: {
  value: any
  variant?: 'previous' | 'next'
}) {
  return (
    <span
      className={`inline-flex max-w-full items-center rounded-md border px-2 py-0.5 text-[11px] font-bold leading-4 ${auditValuePillClass(
        value,
        variant,
      )}`}
    >
      <span className="break-words">{formatAuditValue(value)}</span>
    </span>
  )
}

function AuditChangeRow({
  field,
  previous,
  next,
  trailing,
}: {
  field: string
  previous: any
  next: any
  trailing?: ReactNode
}) {
  const meta = auditFieldMeta(field)

  return (
    <div className="grid grid-cols-1 gap-2 border-b border-slate-100 px-2 py-2 last:border-b-0 md:grid-cols-[155px_minmax(0,1fr)_auto] md:items-center">
      <div className="flex min-w-0 items-center gap-2">
        <div
          className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md ring-1 ring-inset [&_svg]:h-3 [&_svg]:w-3 ${meta.iconClass}`}
        >
          {meta.icon}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-extrabold uppercase tracking-[0.02em] text-slate-700">
            {meta.label}
          </p>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] font-semibold text-slate-500">
        <AuditValuePill
          value={previous}
          variant="previous"
        />

        <ArrowRight
          size={13}
          className="flex-shrink-0 text-slate-400"
        />

        <AuditValuePill
          value={next}
          variant="next"
        />
      </div>

      {trailing ? (
        <div className="md:justify-self-end">
          {trailing}
        </div>
      ) : (
        <div />
      )}
    </div>
  )
}

function firstLogText(...values: any[]) {
  for (const value of values) {
    if (value === null || value === undefined) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

function timelineOutcomeText(item: LogItem) {
  return firstLogText(
    item.outcome,
    item.new_values?.outcome,
    item.metadata?.outcome,
    item.metadata?.completion_outcome,
    item.new_values?.cancellation_reason,
  )
}

function timelineRemarksText(item: LogItem) {
  return firstLogText(
    item.remarks,
    item.raw_remarks,
    item.new_values?.remarks,
    item.new_values?.description,
    item.metadata?.remarks,
    item.metadata?.notes,
  )
}

function TimelineLogDetail({
  label,
  icon,
  value,
  tone = 'slate',
}: {
  label: string
  icon: ReactNode
  value?: string | null
  tone?: 'emerald' | 'slate'
}) {
  const text = firstLogText(value)
  const toneClass = tone === 'emerald'
    ? 'border-emerald-100 bg-emerald-50/60 text-emerald-700'
    : 'border-slate-100 bg-white/75 text-slate-600'
  const iconClass = tone === 'emerald'
    ? 'bg-emerald-100 text-emerald-700'
    : 'bg-slate-100 text-slate-500'

  return (
    <div className={`min-w-0 rounded-xl border px-3 py-2 ${toneClass}`}>
      <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.04em]">
        <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md ${iconClass}`}>
          {icon}
        </span>
        <span>{label}</span>
      </div>
      <p className={`mt-1 text-xs leading-5 ${text ? 'text-slate-700' : 'text-slate-400'}`}>
        {text || '-'}
      </p>
    </div>
  )
}

function EditLogEntry({ item, open }: { item: LogItem; open: boolean }) {
  const fields = useMemo(
    () =>
      Object.keys(item.new_values || {}).filter(
        (field) =>
          !LOCATION_FIELDS.includes(
            field as typeof LOCATION_FIELDS[number],
          ),
      ),
    [item.new_values],
  )

  if (!fields.length) return null
  const changeLabel = `${fields.length} field${fields.length === 1 ? '' : 's'} changed`

  return (
    <>
      {open && (
        <div className="border-t border-slate-100 px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.04em] text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
            <span>{changeLabel}</span>
          </div>

          <div className="rounded-xl border border-slate-100 bg-white/70">
            {fields.map((field) => {
              return (
                <AuditChangeRow
                  key={field}
                  field={field}
                  previous={item.old_values?.[field]}
                  next={item.new_values?.[field]}
                />
              )
            })}
          </div>
        </div>
        )}
    </>
  )
}

function LogLocationDetails({
  item,
  previous,
  previousEventAt,
  assignedUserName,
}: {
  item: LogItem
  previous?: LocationSnapshot | null
  previousEventAt?: string | null
  assignedUserName?: string | null
}) {
  const [mapOpen, setMapOpen] = useState(false)
  const hasFix = item.latitude != null && item.longitude != null

  const location = hasFix
    ? {
        latitude: item.latitude ?? null,
        longitude: item.longitude ?? null,
        accuracy_meters: item.accuracy_meters ?? null,
        address: item.address ?? null,
      }
    : null

  const hasPrevious = Boolean(previous && hasMapCoordinates(previous))

  const mapPoints: MapPopupPointSource[] = location && hasMapCoordinates(location)
    ? [
        ...(hasPrevious
          ? [{
              key: 'previous',
              label: 'Previous Location',
              timeLabel: previousEventAt ? fmtDateTime(previousEventAt) : 'Earlier captured location',
              location: previous as LocationSnapshot,
            }]
          : []),
        {
          key: 'captured',
          label: hasPrevious ? 'Current Location' : 'Captured Location',
          timeLabel: item.event_at ? fmtDateTime(item.event_at) : 'Activity timeline',
          location,
        },
      ]
    : []
  const resolvedLocationLabel = useResolvedLocationLabel(location)
  const assignedUserLabel = item.actor_name || assignedUserName || null
  const assignedUserInitial = String(assignedUserLabel || '?').trim().charAt(0).toUpperCase() || '?'

  if (!hasFix && !item.permission_status && !assignedUserLabel) return null

  return (
    <>
      <div className="grid grid-cols-1 gap-3 border-t border-slate-100 px-4 py-2.5 text-[11px] leading-4 text-slate-500 md:grid-cols-2">
        {assignedUserLabel && (
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-blue-50 text-[11px] font-black text-blue-700 ring-1 ring-blue-100">
              {assignedUserInitial}
            </span>
            <span className="min-w-0 truncate text-xs font-bold text-slate-800">
              {assignedUserLabel}
            </span>
          </div>
        )}

        {(hasFix || item.permission_status) && (
          <div className="flex min-w-0 items-start gap-2 md:justify-self-end md:text-right">
            <MapPin size={13} className="mt-0.5 flex-shrink-0 text-slate-400" />
            <div className="min-w-0">
              {item.address ? (
                <p>{item.address}</p>
              ) : hasFix ? (
                <p>{resolvedLocationLabel}{item.accuracy_meters != null ? ` (+/-${Math.round(item.accuracy_meters)}m)` : ''}</p>
              ) : (
                <p className="text-slate-400">Location not available ({item.permission_status || 'unknown'})</p>
              )}
              {mapPoints.length > 0 && (
                <button
                  type="button"
                  onClick={() => setMapOpen(true)}
                  className="mt-0.5 block font-semibold text-blue-600 hover:text-blue-700 md:ml-auto"
                >
                  View on map
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      <MapPopup
        open={mapOpen}
        title="Captured Location"
        onClose={() => setMapOpen(false)}
        points={mapPoints}
      />
    </>
  )
}

function timelineDatePart(value?: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

function timelineTimePart(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function timelineEventMeta(eventType: string) {
  switch (eventType) {
    case 'ACTIVITY_COMPLETED':
      return {
        badge: 'Completed',
        icon: <CheckCircle2 size={14} />,
        iconClass: 'border-emerald-200 bg-emerald-50 text-emerald-600',
        lineClass: 'bg-emerald-200',
        cardClass: 'border-emerald-100 bg-emerald-50/30',
        badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      }
    case 'ACTIVITY_REOPENED':
      return {
        badge: 'Reopened',
        icon: <RotateCcw size={14} />,
        iconClass: 'border-amber-200 bg-amber-50 text-amber-600',
        lineClass: 'bg-amber-200',
        cardClass: 'border-amber-100 bg-amber-50/30',
        badgeClass: 'border-amber-200 bg-amber-50 text-amber-700',
      }
    case 'ACTIVITY_STARTED':
      return {
        badge: 'Started',
        icon: <PlayCircle size={14} />,
        iconClass: 'border-blue-200 bg-blue-50 text-blue-600',
        lineClass: 'bg-blue-200',
        cardClass: 'border-blue-100 bg-blue-50/30',
        badgeClass: 'border-blue-200 bg-blue-50 text-blue-700',
      }
    case 'ACTIVITY_UPDATED':
      return {
        badge: 'Updated',
        icon: <Pencil size={14} />,
        iconClass: 'border-indigo-200 bg-indigo-50 text-indigo-600',
        lineClass: 'bg-indigo-200',
        cardClass: 'border-indigo-100 bg-indigo-50/20',
        badgeClass: 'border-indigo-200 bg-indigo-50 text-indigo-700',
      }
    case 'ACTIVITY_CANCELLED':
      return {
        badge: 'Cancelled',
        icon: <Ban size={14} />,
        iconClass: 'border-rose-200 bg-rose-50 text-rose-600',
        lineClass: 'bg-rose-200',
        cardClass: 'border-rose-100 bg-rose-50/25',
        badgeClass: 'border-rose-200 bg-rose-50 text-rose-700',
      }
    case 'ACTIVITY_POSTPONED':
      return {
        badge: 'Postponed',
        icon: <Clock size={14} />,
        iconClass: 'border-orange-200 bg-orange-50 text-orange-600',
        lineClass: 'bg-orange-200',
        cardClass: 'border-orange-100 bg-orange-50/25',
        badgeClass: 'border-orange-200 bg-orange-50 text-orange-700',
      }
    case 'ACTIVITY_REASSIGNED':
      return {
        badge: 'Reassigned',
        icon: <UserRound size={14} />,
        iconClass: 'border-cyan-200 bg-cyan-50 text-cyan-700',
        lineClass: 'bg-cyan-200',
        cardClass: 'border-cyan-100 bg-cyan-50/25',
        badgeClass: 'border-cyan-200 bg-cyan-50 text-cyan-700',
      }
    case 'ACTIVITY_CREATED':
      return {
        badge: 'Created',
        icon: <PlusCircle size={14} />,
        iconClass: 'border-violet-200 bg-violet-50 text-violet-600',
        lineClass: 'bg-violet-200',
        cardClass: 'border-violet-100 bg-violet-50/25',
        badgeClass: 'border-violet-200 bg-violet-50 text-violet-700',
      }
    default:
      return {
        badge: 'History',
        icon: <CalendarDays size={14} />,
        iconClass: 'border-slate-200 bg-slate-50 text-slate-500',
        lineClass: 'bg-slate-200',
        cardClass: 'border-slate-200 bg-white',
        badgeClass: 'border-slate-200 bg-slate-50 text-slate-600',
      }
  }
}

export function ActivityTimelineTab({
  activityId,
  assignedUserName,
}: {
  activityId: number
  assignedUserName?: string | null
}) {
  const [items, setItems] =
    useState<LogItem[] | null>(null)

  const [error, setError] =
    useState(false)

  useEffect(() => {
    let alive = true

    api
      .get(`/kam/activities/${activityId}/logs`)
      .then((response) => {
        if (alive) {
          setItems(response.data || [])
        }
      })
      .catch(() => {
        if (alive) {
          setError(true)
        }
      })

    return () => {
      alive = false
    }
  }, [activityId])

  if (error) {
    return (
      <div className="m-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs font-semibold text-red-500">
        Failed to load timeline.
      </div>
    )
  }

  if (!items) {
    return (
      <div className="m-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-400">
        Loading timeline...
      </div>
    )
  }

  if (!items.length) {
    return (
      <div className="m-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-xs font-semibold text-slate-400">
        No activity history yet.
      </div>
    )
  }

  const ordered = [...items].reverse()

  const previousLocationByItemId = new Map<number, LocationSnapshot | null>()
  const previousEventAtByItemId = new Map<number, string | null>()
  {
    let lastLocation: LocationSnapshot | null = null
    let lastEventAt: string | null = null
    for (const it of items) {
      previousLocationByItemId.set(it.id, lastLocation)
      previousEventAtByItemId.set(it.id, lastEventAt)
      const current = getLocationSnapshot({
        latitude: it.latitude,
        longitude: it.longitude,
        accuracy_meters: it.accuracy_meters,
        address: it.address,
      })
      if (current) {
        lastLocation = current
        lastEventAt = it.event_at ?? null
      }
    }
  }

  return (
    <div className="px-3 py-4 sm:px-5 sm:py-5">
      <div className="space-y-0">
        {ordered.map((item, index) => {
          const meta =
            timelineEventMeta(item.event_type)

          const hasStatusChange = Boolean(
            item.previous_status &&
              item.new_status &&
              item.previous_status !== item.new_status,
          )
          const outcomeText = timelineOutcomeText(item)
          const remarksText = timelineRemarksText(item)
          const hasOutcome = Boolean(outcomeText)
          const hasRemarks = Boolean(remarksText)
          const hasLogDetails = hasStatusChange || Boolean(item.reason) || hasOutcome || hasRemarks

          return (
            <div
              key={item.id}
              className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3 pb-5 last:pb-0 sm:grid-cols-[120px_34px_minmax(0,1fr)] sm:gap-4"
            >
              <div className="hidden pt-1 sm:block">
                <div className="flex items-start justify-end gap-2">
                  <div className="text-right">
                    <p className="whitespace-nowrap text-xs font-extrabold leading-5 text-slate-800">
                      {timelineDatePart(
                        item.event_at,
                      )}
                    </p>

                    <p className="mt-0.5 whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.04em] text-slate-400">
                      {timelineTimePart(
                        item.event_at,
                      )}
                    </p>
                  </div>
                </div>
              </div>

              <div className="relative flex justify-center">
                {index <
                  ordered.length - 1 && (
                  <div className="absolute bottom-[-1.25rem] top-9 w-px bg-slate-200" />
                )}

                <div
                  className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 bg-white shadow-[0_4px_12px_rgba(15,23,42,0.08)] ${meta.iconClass}`}
                >
                  {meta.icon}
                </div>
              </div>

              <div className="min-w-0">
                <div
                  className={`overflow-hidden rounded-2xl border shadow-[0_4px_16px_rgba(15,23,42,0.04)] ${meta.cardClass}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/70 bg-white/80 px-4 py-3 backdrop-blur-sm">
                    <div className="min-w-0">
                      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 sm:hidden">
                        <Clock size={11} />
                        {fmtDateTime(
                          item.event_at,
                        )}
                      </div>

                      <p className="text-sm font-extrabold leading-5 text-slate-900">
                        {EVENT_LABEL[
                          item.event_type
                        ] || item.event_type}
                      </p>
                    </div>

                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-[0.08em] ${meta.badgeClass}`}
                      >
                        {meta.badge}
                      </span>
                    </div>
                  </div>

                  {hasLogDetails && (
                    <div className="space-y-2 px-4 py-3">
                      {hasStatusChange && (
                        <div className="rounded-xl border border-slate-100 bg-white/70">
                          <AuditChangeRow
                            field="status"
                            previous={item.previous_status}
                            next={item.new_status}
                          />
                        </div>
                      )}

                      {item.reason && (
                        <div className="rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-xs leading-5 text-slate-600">
                          <span className="font-extrabold text-slate-800">
                            Reason:
                          </span>{' '}
                          {item.reason}
                        </div>
                      )}

                      {(hasOutcome || hasRemarks) && (
                        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                          {hasOutcome && (
                            <TimelineLogDetail
                              label="Outcome"
                              icon={<CheckCircle2 size={13} />}
                              value={outcomeText}
                              tone="emerald"
                            />
                          )}
                          {hasRemarks && (
                            <TimelineLogDetail
                              label="Remarks"
                              icon={<FileText size={13} />}
                              value={remarksText}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {item.event_type ===
                    'ACTIVITY_UPDATED' && (
                    <EditLogEntry
                      item={item}
                      open
                    />
                  )}

                  <LogLocationDetails
                    item={item}
                    previous={previousLocationByItemId.get(item.id) ?? null}
                    previousEventAt={previousEventAtByItemId.get(item.id) ?? null}
                    assignedUserName={assignedUserName}
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ReopenActivityModal({
  activity,
  onClose,
  onSuccess,
}: {
  activity: any
  onClose: () => void
  onSuccess: (updated: any) => void
}) {
  const [reason, setReason] = useState('')
  const [remarks, setRemarks] = useState('')
  const [newDate, setNewDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!reason.trim()) {
      setError('Reason is required')
      return
    }
    if (!remarks.trim()) {
      setError('Remarks required')
      return
    }
    setSaving(true)
    setError('')
    try {
      const loc = await captureCurrentLocation()
      const res = await api.post(`/kam/activities/${activity.id}/reopen`, {
        reason: reason.trim(),
        remarks: remarks.trim() || undefined,
        new_activity_date: newDate || undefined,
        latitude: loc.latitude ?? undefined,
        longitude: loc.longitude ?? undefined,
        accuracy_meters: loc.accuracy_meters ?? undefined,
        permission_status: loc.permission_status,
        client_event_at: loc.client_event_at,
        device_id: 'browser',
        idempotency_key: generateIdempotencyKey(),
      })
      onSuccess(res.data)
      onClose()
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to reopen activity')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100200] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800">
          <RotateCcw size={16} className="text-amber-500" />
          Reopen Activity
        </h3>
        <p className="mt-1 text-xs text-slate-500">{activity?.subject}</p>

        <label className="mt-4 block text-xs font-bold text-slate-600">
          Reason for reopening <span className="text-red-500">*</span>
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
          placeholder="Why is this activity being reopened?"
        />

        <label className="mt-3 block text-xs font-bold text-slate-600">New activity date (optional)</label>
        <input
          type="date"
          value={newDate}
          onChange={(e) => setNewDate(e.target.value)}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
        />

        <label className="mt-3 block text-xs font-bold text-slate-600">
          Remarks <span className="text-red-500">*</span>
        </label>
        <textarea
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
        />

        {error && (
          <p className="mt-3 flex items-center gap-1.5 text-xs font-semibold text-red-500">
            <AlertCircle size={13} />
            {error}
          </p>
        )}

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="flex-1 rounded-xl bg-amber-500 py-2.5 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
          >
            {saving ? 'Reopening...' : 'Reopen Activity'}
          </button>
        </div>
      </div>
    </div>
  )
}
