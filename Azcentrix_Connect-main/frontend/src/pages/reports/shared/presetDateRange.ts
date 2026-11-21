/**
 * Resolves a PRESETS id (from the common date-range toolbar in ReportsPage)
 * into concrete date_from/date_to strings that the per-tab analytics filters
 * understand. Returns null for presets that aren't a fixed calendar range
 * (currently only 'custom', whose dates come from the toolbar directly).
 */
export function resolvePresetRange(preset: string): { date_from: string; date_to: string } | null {
  const pad = (n: number) => String(n).padStart(2, '0')
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const now = new Date()

  if (!preset) return { date_from: '', date_to: '' } // All Time — clear the range

  switch (preset) {
    case 'today': {
      const t = fmt(now)
      return { date_from: t, date_to: t }
    }
    case 'this_week': {
      const day = now.getDay()
      const diff = (day === 0 ? -6 : 1) - day
      const start = new Date(now)
      start.setDate(start.getDate() + diff)
      return { date_from: fmt(start), date_to: fmt(now) }
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      return { date_from: fmt(start), date_to: fmt(now) }
    }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const end   = new Date(now.getFullYear(), now.getMonth(), 0)
      return { date_from: fmt(start), date_to: fmt(end) }
    }
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3)
      const start = new Date(now.getFullYear(), q * 3, 1)
      return { date_from: fmt(start), date_to: fmt(now) }
    }
    case 'last_quarter': {
      const q = Math.floor(now.getMonth() / 3) - 1
      const year = q < 0 ? now.getFullYear() - 1 : now.getFullYear()
      const qq   = (q + 4) % 4
      const start = new Date(year, qq * 3, 1)
      const end   = new Date(year, qq * 3 + 3, 0)
      return { date_from: fmt(start), date_to: fmt(end) }
    }
    case 'this_year': {
      const start = new Date(now.getFullYear(), 0, 1)
      return { date_from: fmt(start), date_to: fmt(now) }
    }
    case 'last_year': {
      const start = new Date(now.getFullYear() - 1, 0, 1)
      const end   = new Date(now.getFullYear() - 1, 11, 31)
      return { date_from: fmt(start), date_to: fmt(end) }
    }
    default:
      return null // 'custom' — caller uses the toolbar's own date_from/date_to
  }
}
