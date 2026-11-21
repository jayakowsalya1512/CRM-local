import { useCallback, useEffect, useState } from 'react'
import { platformApi, type PlatformAccessLevel, type PlatformTeamMe } from '@/services/platformApi'

const CHANGED_EVENT = 'platform-access-changed'
const RANK: Record<PlatformAccessLevel, number> = { none: 0, view: 1, manage: 2 }

/** Ask every mounted usePlatformAccess() to reload (after role, approval or four-eyes changes). */
export const notifyPlatformAccessChanged = () => window.dispatchEvent(new Event(CHANGED_EVENT))

/** The signed-in staff member's platform role, permissions and pending approval count. */
export function usePlatformAccess() {
  const [me, setMe] = useState<PlatformTeamMe | null>(null)

  const load = useCallback(() => {
    platformApi.teamMe().then(({ data }) => setMe(data)).catch(() => {})
  }, [])

  useEffect(() => {
    load()
    window.addEventListener(CHANGED_EVENT, load)
    return () => window.removeEventListener(CHANGED_EVENT, load)
  }, [load])

  const can = useCallback(
    (module: string, level: Exclude<PlatformAccessLevel, 'none'> = 'view') =>
      !!me && (me.is_super_admin || RANK[me.permissions[module] ?? 'none'] >= RANK[level]),
    [me],
  )

  return { me, can, reload: load }
}
