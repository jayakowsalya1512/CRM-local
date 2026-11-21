import { useEffect, useMemo, useState } from 'react'

type ReverseGeocodePoint = {
  key: string
  latitude: number | null | undefined
  longitude: number | null | undefined
  address?: string | null
}

const reverseGeocodeCache = new Map<string, string | null>()
const reverseGeocodeInflight = new Map<string, Promise<string | null>>()

export function locationCacheKey(latitude: number, longitude: number) {
  return `${latitude.toFixed(5)},${longitude.toFixed(5)}`
}

export function compactLocationLabel(data: any) {
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

export async function reverseGeocodeLocation(latitude: number, longitude: number) {
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

export function formatResolvedLocationLabel(
  point?: Pick<ReverseGeocodePoint, 'latitude' | 'longitude' | 'address'> | null,
  resolvedLabel?: string | null,
  fallback = 'Location captured',
) {
  if (point?.address) return point.address
  if (resolvedLabel) return resolvedLabel
  if (point?.latitude != null && point?.longitude != null) return fallback
  return 'Location not available'
}

export function useResolvedLocationLabel(
  point?: Pick<ReverseGeocodePoint, 'latitude' | 'longitude' | 'address'> | null,
  fallback?: string,
) {
  const [resolvedLabel, setResolvedLabel] = useState<string | null>(() => {
    if (point?.address) return point.address
    if (point?.latitude == null || point?.longitude == null) return null
    return reverseGeocodeCache.get(locationCacheKey(point.latitude, point.longitude)) ?? null
  })

  useEffect(() => {
    if (point?.address) {
      setResolvedLabel(point.address)
      return
    }
    if (point?.latitude == null || point?.longitude == null) {
      setResolvedLabel(null)
      return
    }

    const cached = reverseGeocodeCache.get(locationCacheKey(point.latitude, point.longitude))
    if (cached) {
      setResolvedLabel(cached)
      return
    }

    let alive = true
    reverseGeocodeLocation(point.latitude, point.longitude).then((label) => {
      if (alive) setResolvedLabel(label)
    })

    return () => {
      alive = false
    }
  }, [point?.address, point?.latitude, point?.longitude])

  return formatResolvedLocationLabel(point, resolvedLabel, fallback)
}

export function useResolvedLocationMap(points: ReverseGeocodePoint[], fallback?: string) {
  const signature = useMemo(
    () => points.map(point => `${point.key}:${point.address || ''}:${point.latitude ?? 'x'}:${point.longitude ?? 'x'}`).join('|'),
    [points],
  )

  const [resolvedMap, setResolvedMap] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const point of points) {
      const cached = point.latitude != null && point.longitude != null
        ? reverseGeocodeCache.get(locationCacheKey(point.latitude, point.longitude)) ?? null
        : null
      initial[point.key] = formatResolvedLocationLabel(point, cached, fallback)
    }
    return initial
  })

  useEffect(() => {
    const nextMap: Record<string, string> = {}
    for (const point of points) {
      const cached = point.latitude != null && point.longitude != null
        ? reverseGeocodeCache.get(locationCacheKey(point.latitude, point.longitude)) ?? null
        : null
      nextMap[point.key] = formatResolvedLocationLabel(point, cached, fallback)
    }
    setResolvedMap(nextMap)

    let alive = true
    points.forEach((point) => {
      if (point.address || point.latitude == null || point.longitude == null) return
      const cached = reverseGeocodeCache.get(locationCacheKey(point.latitude, point.longitude))
      if (cached) return

      reverseGeocodeLocation(point.latitude, point.longitude).then((label) => {
        if (!alive || !label) return
        setResolvedMap((current) => {
          const nextLabel = formatResolvedLocationLabel(point, label, fallback)
          if (current[point.key] === nextLabel) return current
          return {
            ...current,
            [point.key]: nextLabel,
          }
        })
      })
    })

    return () => {
      alive = false
    }
  }, [fallback, points, signature])

  return resolvedMap
}
