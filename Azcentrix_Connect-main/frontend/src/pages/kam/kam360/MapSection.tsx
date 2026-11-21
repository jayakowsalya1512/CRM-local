import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapContainer, useMap } from 'react-leaflet'
import indiaStatesGeo from '@/assets/geo/india-states.json'
import indiaDistrictsGeo from '@/assets/geo/india-districts.json'
import indiaBoundaryGeo from '@/assets/geo/india-boundary.json'
import { useModuleName } from '@/context/ModuleLabelsContext'

export type CustomerLocationMapRow = {
  key?: string
  label: string
  count: number
  value: number
  leadCount?: number
  tenderCount?: number
  opportunityCount?: number
  size?: number
  lat?: number
  lng?: number
}

export type CustomerStateMapRow = {
  key: string
  label: string
  count: number
  value: number
  mappedCount?: number
  leadCount?: number
  tenderCount?: number
  opportunityCount?: number
  customers: any[]
}

type Props = {
  states?: Record<string, CustomerStateMapRow>
  masterStates?: Array<{ name: string; region_name?: string }>
  masterStateDistricts?: Map<string, string[]>
  onSelect?: (stateName: string) => void
  onSelectDistrict?: (districtName: string, stateName: string) => void
}

const INDIA_CENTER: [number, number] = [23.0, 80.5]

const INDIA_BOUNDS: [[number, number], [number, number]] = [
  [6.0, 67.5],
  [37.6, 98.0],
]

// Tighter mainland-focused fit used only for the map's initial/default view —
// INDIA_BOUNDS stays wide (maxBounds) so users can still pan/zoom out to see
// the full corrected Kashmir/Kutch extent, but the default load stays zoomed in.
const INDIA_DEFAULT_VIEW_BOUNDS: [[number, number], [number, number]] = [
  [8.0, 72.0],
  [33.5, 90.5],
]

export const KAM_MAP_CENTER = INDIA_CENTER
export const KAM_MAP_BOUNDS = INDIA_BOUNDS
export const KAM_MAP_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
export const KAM_MAP_TILE_OPTIONS = {
  maxZoom: 19,
  noWrap: true,
  attribution: '',
} as const

const DEFAULT_ZOOM = 6
const STATE_ICON_URL = '/user-location.png'

const ICON_SIZE: [number, number] = [42, 50]
const ICON_ANCHOR: [number, number] = [21, 50]
type GeoCoord = { lat: number; lng: number }

export function normalizeStateKey(v: string) {
  return String(v || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const normalizeLocationKey = normalizeStateKey
export const normalizeDistrictKey = normalizeStateKey
export const canonicalStateName = (label: string) => {
  const raw = String(label || '').trim()
  const key = normalizeStateKey(raw)
  const aliases: Record<string, string> = {
    andhrapradesh: 'Andhra Pradesh',
    ap: 'Andhra Pradesh',
    arunachalpradesh: 'Arunachal Pradesh',
    ar: 'Arunachal Pradesh',
    as: 'Assam',
    br: 'Bihar',
    cg: 'Chhattisgarh',
    chattisgarh: 'Chhattisgarh',
    chhatisgarh: 'Chhattisgarh',
    dl: 'Delhi',
    ga: 'Goa',
    gj: 'Gujarat',
    hr: 'Haryana',
    hp: 'Himachal Pradesh',
    dadraandnagarhaveli: 'Dadra and Nagar Haveli',
    dadraandnagarhavelianddamananddiu: 'Dadra and Nagar Haveli and Daman and Diu',
    damananddiu: 'Daman and Diu',
    himachalpradesh: 'Himachal Pradesh',
    jammuandkashmir: 'Jammu and Kashmir',
    jk: 'Jammu and Kashmir',
    jh: 'Jharkhand',
    ka: 'Karnataka',
    kl: 'Kerala',
    la: 'Ladakh',
    madhyapradesh: 'Madhya Pradesh',
    mp: 'Madhya Pradesh',
    mh: 'Maharashtra',
    mn: 'Manipur',
    ml: 'Meghalaya',
    mz: 'Mizoram',
    nl: 'Nagaland',
    od: 'Odisha',
    or: 'Odisha',
    pb: 'Punjab',
    tamilnadu: 'Tamil Nadu',
    rj: 'Rajasthan',
    sk: 'Sikkim',
    tn: 'Tamil Nadu',
    ts: 'Telangana',
    tg: 'Telangana',
    telengana: 'Telangana',
    tr: 'Tripura',
    up: 'Uttar Pradesh',
    uttarpradesh: 'Uttar Pradesh',
    uk: 'Uttarakhand',
    uttarakhand: 'Uttarakhand',
    uttaranchal: 'Uttarakhand',
    wb: 'West Bengal',
    westbengal: 'West Bengal',
    py: 'Puducherry',
    pondicherry: 'Puducherry',
  }

  return aliases[key.replace(/\s+/g, '')] || raw
}
export const inferStateNameFromLocation = (label: string) =>
  String(label || '').trim()

function geometryCenter(geometry: any): GeoCoord | null {
  const bounds = {
    minLng: Number.POSITIVE_INFINITY,
    minLat: Number.POSITIVE_INFINITY,
    maxLng: Number.NEGATIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
  }

  const walk = (value: any) => {
    if (!Array.isArray(value)) return
    if (
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number'
    ) {
      const [lng, lat] = value
      bounds.minLng = Math.min(bounds.minLng, lng)
      bounds.maxLng = Math.max(bounds.maxLng, lng)
      bounds.minLat = Math.min(bounds.minLat, lat)
      bounds.maxLat = Math.max(bounds.maxLat, lat)
      return
    }
    value.forEach(walk)
  }

  walk(geometry?.coordinates)

  if (
    !Number.isFinite(bounds.minLng) ||
    !Number.isFinite(bounds.minLat) ||
    !Number.isFinite(bounds.maxLng) ||
    !Number.isFinite(bounds.maxLat)
  ) {
    return null
  }

  return {
    lat: (bounds.minLat + bounds.maxLat) / 2,
    lng: (bounds.minLng + bounds.maxLng) / 2,
  }
}

function buildStateGeoCoordMap() {
  const map = new Map<string, GeoCoord>()
  ;((indiaStatesGeo as any)?.features || []).forEach((feature: any) => {
    const name = feature?.properties?.st_nm
    const coord = geometryCenter(feature?.geometry)
    if (!name || !coord) return
    const canonical = canonicalStateName(name)
    map.set(normalizeStateKey(name), coord)
    map.set(normalizeStateKey(canonical), coord)
  })
  return map
}

function buildDistrictGeoCoordMaps() {
  const byState = new Map<string, GeoCoord>()
  const byDistrict = new Map<string, GeoCoord>()
  const duplicateDistricts = new Set<string>()

  ;((indiaDistrictsGeo as any)?.features || []).forEach((feature: any) => {
    const district = feature?.properties?.DISTRICT
    const state = canonicalStateName(feature?.properties?.ST_NM || '')
    const coord = geometryCenter(feature?.geometry)
    if (!district || !state || !coord) return

    const stateDistrictKey = `${normalizeStateKey(state)}:${normalizeDistrictKey(district)}`
    const districtKey = normalizeDistrictKey(district)
    byState.set(stateDistrictKey, coord)

    if (duplicateDistricts.has(districtKey)) return
    if (byDistrict.has(districtKey)) {
      byDistrict.delete(districtKey)
      duplicateDistricts.add(districtKey)
      return
    }
    byDistrict.set(districtKey, coord)
  })

  return { byState, byDistrict }
}

const STATE_GEO_COORDS = buildStateGeoCoordMap()
const DISTRICT_GEO_COORDS = buildDistrictGeoCoordMaps()

function getIndiaMainlandRing() {
  const geometry = (indiaBoundaryGeo as any)?.features?.[0]?.geometry
  const outerRings: any[] = []

  if (geometry?.type === 'MultiPolygon') {
    geometry.coordinates.forEach((polygon: any) => {
      if (polygon?.[0]) outerRings.push(polygon[0])
    })
  } else if (geometry?.type === 'Polygon' && geometry.coordinates?.[0]) {
    outerRings.push(geometry.coordinates[0])
  }

  // Offshore island clusters (Lakshadweep, Andaman & Nicobar, Sundarbans islets)
  // are tiny separate rings — pick only the mainland (the ring with the most
  // vertices) so those islands fade into the background like everything else.
  return outerRings.reduce(
    (largest, ring) => (ring.length > largest.length ? ring : largest),
    outerRings[0] || [],
  )
}

const INDIA_MAINLAND_RING = getIndiaMainlandRing()

const INDIA_MAINLAND_GEOMETRY = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [INDIA_MAINLAND_RING],
  },
}

function buildOutsideIndiaMaskGeometry() {
  const WORLD_RING = [
    [-190, -89],
    [190, -89],
    [190, 89],
    [-190, 89],
    [-190, -89],
  ]

  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [WORLD_RING, INDIA_MAINLAND_RING],
    },
  }
}

const OUTSIDE_INDIA_MASK_GEOMETRY = buildOutsideIndiaMaskGeometry()

export function customerDistrictLabel(customer: any) {
  return (
    customer?.district ||
    customer?.billing_district ||
    customer?.city_district ||
    customer?.customer_district ||
    customer?.shipping_district ||
    customer?.billing_city ||
    customer?.city ||
    customer?.customer_city ||
    customer?.location ||
    ''
  )
}

function customerPotentialValue(customer: any) {
  return Number(
    customer?.potential_value ||
      customer?.potential ||
      customer?.value ||
      customer?.estimated_value ||
      customer?.business_value ||
      0,
  )
}

function formatCurrency(value?: number) {
  const amount = Number(value || 0)

  if (amount >= 10000000) {
    return `₹${(amount / 10000000).toFixed(2)} Cr`
  }

  if (amount >= 100000) {
    return `₹${(amount / 100000).toFixed(2)} L`
  }

  if (amount >= 1000) {
    return `₹${(amount / 1000).toFixed(2)} K`
  }

  return `₹${amount}`
}

function customerTooltipHtml(title: string, count: number, value: number, customerSingular: string, customerLabel: string) {
  return `
    <div class="customer-map-tooltip-card">
      <div class="customer-map-tooltip-head">
        <span class="customer-map-tooltip-pin">📍</span>
        <div>
          <div class="customer-map-tooltip-title">${title}</div>
          <div class="customer-map-tooltip-sub">${customerSingular} Location</div>
        </div>
      </div>

      <div class="customer-map-tooltip-body">
        <div class="customer-map-tooltip-row">
          <span>👥 ${customerLabel} Count</span>
          <b>${count}</b>
        </div>
        <div class="customer-map-tooltip-row">
          <span>💰 Potential Value</span>
          <b>${formatCurrency(value)}</b>
        </div>
      </div>
    </div>
  `
}

export function customerDistrictMapKey(customer: any) {
  return normalizeDistrictKey(customerDistrictLabel(customer))
}

function districtMarkerRows(row: CustomerStateMapRow) {
  const map = new Map<string, { label: string; count: number; value: number }>()

  ;(row.customers || []).forEach(customer => {
    const label = customerDistrictLabel(customer)
    const key = normalizeDistrictKey(label)

    if (!key) return

    const current = map.get(key) || { label, count: 0, value: 0 }
    current.count += 1
    current.value += customerPotentialValue(customer)
    map.set(key, current)
  })

  return Array.from(map.values())
}

export function resolveIndiaLocationCoord(
  label: string,
  key: string,
  idx = 0,
  stateLabel = '',
) {
  const fallback = [
    { lat: 22.9734, lng: 78.6569 },
    { lat: 28.6139, lng: 77.209 },
    { lat: 19.076, lng: 72.8777 },
    { lat: 12.9716, lng: 77.5946 },
  ]

  const cityCoords: Record<string, { lat: number; lng: number }> = {
    'tamil nadu': { lat: 11.1271, lng: 78.6569 },
    kerala: { lat: 10.8505, lng: 76.2711 },
    karnataka: { lat: 15.3173, lng: 75.7139 },
    telangana: { lat: 18.1124, lng: 79.0193 },
    maharashtra: { lat: 19.7515, lng: 75.7139 },
    odisha: { lat: 20.9517, lng: 85.0985 },

    chennai: { lat: 13.0827, lng: 80.2707 },
    coimbatore: { lat: 11.0168, lng: 76.9558 },
    madurai: { lat: 9.9252, lng: 78.1198 },
    salem: { lat: 11.6643, lng: 78.146 },
    erode: { lat: 11.341, lng: 77.7172 },
    tiruppur: { lat: 11.1085, lng: 77.3411 },

    bengaluru: { lat: 12.9716, lng: 77.5946 },
    hyderabad: { lat: 17.385, lng: 78.4867 },
    mumbai: { lat: 19.076, lng: 72.8777 },
    pune: { lat: 18.5204, lng: 73.8567 },
    kolkata: { lat: 22.5726, lng: 88.3639 },
    bhubaneswar: { lat: 20.2961, lng: 85.8245 },
    cuttack: { lat: 20.4625, lng: 85.883 },
    rourkela: { lat: 22.2604, lng: 84.8536 },
    sambalpur: { lat: 21.4669, lng: 83.9812 },
    berhampur: { lat: 19.3149, lng: 84.7941 },
    balasore: { lat: 21.4934, lng: 86.9135 },
  }

  const normalizedKey = normalizeLocationKey(key)
  const normalizedLabel = normalizeLocationKey(label)
  const stateKey = normalizeStateKey(canonicalStateName(stateLabel))
  const districtAlias: Record<string, string> = {
    angul: 'anugul',
    balasore: 'baleshwar',
    boudh: 'bauda',
    deogarh: 'debagarh',
    jagatsinghpur: 'jagatsinghapur',
    jajpur: 'jajapur',
    kendrapara: 'kendraparha',
  }
  const districtKeys = Array.from(
    new Set([
      normalizedKey,
      normalizedLabel,
      districtAlias[normalizedKey],
      districtAlias[normalizedLabel],
    ].filter(Boolean)),
  )

  if (stateKey) {
    for (const districtKey of districtKeys) {
      const coord = DISTRICT_GEO_COORDS.byState.get(`${stateKey}:${districtKey}`)
      if (coord) return coord
    }
  }

  for (const locationKey of [normalizedKey, normalizedLabel]) {
    const stateCoord = STATE_GEO_COORDS.get(locationKey)
    if (stateCoord) return stateCoord
  }

  for (const locationKey of [normalizedKey, normalizedLabel]) {
    const cityCoord = cityCoords[locationKey]
    if (cityCoord) return cityCoord
  }

  for (const districtKey of districtKeys) {
    const districtCoord = DISTRICT_GEO_COORDS.byDistrict.get(districtKey)
    if (districtCoord) return districtCoord
  }

  if (stateKey) {
    const stateCoord = STATE_GEO_COORDS.get(stateKey)
    if (stateCoord) return stateCoord
  }

  return (
    cityCoords[normalizedKey] ||
    cityCoords[normalizedLabel] ||
    fallback[idx % fallback.length]
  )
}

function customerIconHtml() {
  return `
    <div class="customer-map-icon-wrap">
      <img src="${STATE_ICON_URL}" class="customer-map-icon-img" />
    </div>
  `
}

function OriginalLeafletMap({ states, onSelect, onSelectDistrict }: Props) {
  const map = useMap()
  const selectedStateLayerRef = useRef<L.Rectangle | null>(null)
  const { label: customerLabel, singular: customerSingular } = useModuleName('customers')

  useEffect(() => {
    const styleId = 'customer-map-marker-style'

    if (!document.getElementById(styleId)) {
      const style = document.createElement('style')
      style.id = styleId
      style.innerHTML = `
        .customer-location-map-shell,
        .customer-location-map-shell .leaflet-container {
          position: relative;
          z-index: 0 !important;
        }

        .customer-location-map-shell .leaflet-pane,
        .customer-location-map-shell .leaflet-top,
        .customer-location-map-shell .leaflet-bottom {
          z-index: 1 !important;
        }

        .customer-location-map-shell .leaflet-marker-pane {
          z-index: 2 !important;
        }

        .customer-location-map-shell .leaflet-tooltip-pane {
          z-index: 3 !important;
        }

        .customer-map-div-icon {
          background: transparent !important;
          border: none !important;
        }

        .customer-map-icon-wrap {
          position: relative;
          width: 42px;
          height: 50px;
        }

        .customer-map-icon-img {
          width: 42px;
          height: 50px;
          object-fit: contain;
        }

        .leaflet-control-attribution {
          display: none !important;
        }

        .leaflet-tooltip.customer-map-tooltip-box {
          padding: 0 !important;
          border: none !important;
          background: transparent !important;
          box-shadow: none !important;
        }

        .customer-map-tooltip-card {
          min-width: 230px;
          overflow: hidden;
          border-radius: 16px;
          background: #ffffff;
          box-shadow: 0 14px 35px rgba(15, 23, 42, 0.22);
          font-family: inherit;
        }

        .customer-map-tooltip-head {
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 10px 12px;
          background: linear-gradient(135deg, #f97316, #ea580c);
          color: #ffffff;
        }

        .customer-map-tooltip-pin {
          font-size: 15px;
        }

        .customer-map-tooltip-title {
          font-size: 13px;
          font-weight: 900;
          line-height: 1.2;
          text-transform: capitalize;
        }

        .customer-map-tooltip-sub {
          margin-top: 2px;
          font-size: 11px;
          font-weight: 700;
          opacity: 0.9;
        }

        .customer-map-tooltip-body {
          padding: 10px 12px 12px;
        }

        .customer-map-tooltip-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          margin-top: 7px;
          color: #475569;
          font-size: 12px;
          font-weight: 700;
        }

        .customer-map-tooltip-row b {
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
      KAM_MAP_TILE_URL,
      KAM_MAP_TILE_OPTIONS,
    ).addTo(map)

    map.setMaxBounds(INDIA_BOUNDS)

    // Use fitBounds' own zoom-to-fit math but pin the view to a fixed,
    // deliberately-chosen center point (INDIA_CENTER) instead of the raw
    // bounds midpoint, so India stays centered on both axes regardless of
    // the container's aspect ratio.
    const defaultZoom = map.getBoundsZoom(INDIA_DEFAULT_VIEW_BOUNDS, false, L.point(70, 70))
    map.setView(INDIA_CENTER, defaultZoom, { animate: false })

    return () => {
      map.removeLayer(tileLayer)
    }
  }, [map])

  useEffect(() => {
    const maskLayer = L.geoJSON(OUTSIDE_INDIA_MASK_GEOMETRY as any, {
      interactive: false,
      style: {
        stroke: false,
        fill: true,
        fillColor: '#eef2f7',
        fillOpacity: 0.93,
      },
    }).addTo(map)

    const boundaryLayer = L.geoJSON(INDIA_MAINLAND_GEOMETRY as any, {
      interactive: false,
      style: {
        color: '#cbd5e1',
        weight: 2,
        opacity: 0.9,
        fill: false,
      },
    }).addTo(map)

    return () => {
      map.removeLayer(maskLayer)
      map.removeLayer(boundaryLayer)
    }
  }, [map])

  useEffect(() => {
    const markerLayer = L.layerGroup().addTo(map)

    const clearSelectedStateBorder = () => {
      if (selectedStateLayerRef.current) {
        map.removeLayer(selectedStateLayerRef.current)
        selectedStateLayerRef.current = null
      }
    }

    const highlightStateBorder = (
      stateName: string,
      stateKey: string,
      index: number,
    ) => {
      clearSelectedStateBorder()

      const coord = resolveIndiaLocationCoord(stateName, stateKey, index)

      selectedStateLayerRef.current = L.rectangle(
        [
          [coord.lat - 2.5, coord.lng - 2.5],
          [coord.lat + 2.5, coord.lng + 2.5],
        ],
        {
          color: '#ef4444',
          weight: 3,
          fill: false,
          fillOpacity: 0,
          opacity: 1,
          interactive: false,
        },
      ).addTo(map)
    }

    const renderMarkers = () => {
      markerLayer.clearLayers()

      const zoom = map.getZoom()
      const showDistrict = zoom >= 7

      Object.entries(states || {}).forEach(([stateKey, row], index) => {
        if (Number(row?.count || 0) <= 0) return

        if (!showDistrict) {
          const coord = resolveIndiaLocationCoord(row.label, stateKey, index, row.label)

          const marker = L.marker([coord.lat, coord.lng], {
            icon: L.divIcon({
              html: customerIconHtml(),
              className: 'customer-map-div-icon',
              iconSize: ICON_SIZE,
              iconAnchor: ICON_ANCHOR,
            }),
          })

          marker.bindTooltip(
            customerTooltipHtml(row.label, row.count, row.value, customerSingular, customerLabel),
            {
              direction: 'top',
              offset: [0, -48],
              opacity: 1,
              sticky: true,
              className: 'customer-map-tooltip-box',
            },
          )

          marker.on('click', () => {
            onSelect?.(row.label)
            highlightStateBorder(row.label, stateKey, index)
            map.flyTo([coord.lat, coord.lng], 7, { duration: 0.7 })
          })

          markerLayer.addLayer(marker)
          return
        }

        const districts = districtMarkerRows(row)

        districts.forEach((district, districtIndex) => {
          const coord = resolveIndiaLocationCoord(
            district.label,
            district.label,
            districtIndex,
            row.label,
          )

          const marker = L.marker([coord.lat, coord.lng], {
            icon: L.divIcon({
              html: customerIconHtml(),
              className: 'customer-map-div-icon',
              iconSize: ICON_SIZE,
              iconAnchor: ICON_ANCHOR,
            }),
          })

          marker.bindTooltip(
            customerTooltipHtml(district.label, district.count, district.value, customerSingular, customerLabel),
            {
              direction: 'top',
              offset: [0, -48],
              opacity: 1,
              sticky: true,
              className: 'customer-map-tooltip-box',
            },
          )

          marker.on('click', () =>
            onSelectDistrict?.(district.label, row.label),
          )

          markerLayer.addLayer(marker)
        })
      })
    }

    renderMarkers()
    map.on('zoomend', renderMarkers)

    return () => {
      map.off('zoomend', renderMarkers)
      markerLayer.remove()
      clearSelectedStateBorder()
    }
  }, [map, states, onSelect, onSelectDistrict, customerSingular, customerLabel])

  return null
}

export function CustomerIndiaGeoJsonMap(props: Props) {
  return (
    <div className="customer-location-map-shell relative z-0 h-[520px] min-h-[520px] w-full overflow-hidden rounded-[22px]">
      <MapContainer
        center={INDIA_CENTER}
        zoom={DEFAULT_ZOOM}
        minZoom={4}
        maxZoom={19}
        zoomSnap={0.25}
        zoomDelta={0.5}
        scrollWheelZoom
        doubleClickZoom
        zoomControl
        attributionControl={false}
        maxBounds={INDIA_BOUNDS}
        maxBoundsViscosity={0.9}
        worldCopyJump={false}
        className="h-full w-full rounded-[22px]"
      >
        <OriginalLeafletMap {...props} />
      </MapContainer>
    </div>
  )
}
