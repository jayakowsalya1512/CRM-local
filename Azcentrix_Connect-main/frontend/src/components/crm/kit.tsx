import type { CSSProperties } from 'react'

// Bidwise prototype v9 icon set for the CRM application header (theme adoption).
export { Avatar } from '@/components/platform/bw'

// Prototype ICO: single-path 24×24 line icons (15px, stroke 1.7).
export const ICO = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10', users: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3 2.5-5 6-5s6 2 6 5M16 5a3 3 0 010 6M17 15c2.5.3 4 2 4 5', user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 3.5-6 8-6s8 2 8 6',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16a4 4 0 100-8 4 4 0 000 8z', wallet: 'M3 7h17v12H3zM3 7l12-4 2 4M16 13h2', funnel: 'M3 4h18l-7 9v6l-4 2v-8z', file: 'M6 3h8l5 5v13H6zM14 3v5h5M9 13h6M9 17h6', doc: 'M5 3h14v18H5zM9 8h6M9 12h6M9 16h3',
  brief: 'M3 8h18v12H3zM9 8V5h6v3M3 13h18', shield: 'M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6zM9 12l2 2 4-4', plane: 'M2 12l20-8-6 18-4-7zM10 15l12-11', chart: 'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3',
  check: 'M4 12l5 5L20 6', bell: 'M6 16v-5a6 6 0 1112 0v5l2 2H4zM10 20a2 2 0 004 0', folder: 'M3 6h7l2 2h9v11H3z', gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5', plus: 'M12 5v14M5 12h14', spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z', plug: 'M9 3v5M15 3v5M6 8h12v4a6 6 0 01-12 0zM12 18v3',
  layout: 'M4 4h16v16H4zM4 9h16M9 9v11', mail: 'M3 5h18v14H3zM3 6l9 7 9-7', note: 'M4 4h16v12l-4 4H4zM16 20v-4h4', building: 'M5 21V4h9v17M14 9h5v12M8 8h3M8 12h3M8 16h3',
  flow: 'M4 4h6v6H4zM14 14h6v6h-6zM10 7h4a3 3 0 013 3v4', lock: 'M6 11h12v9H6zM8 11V8a4 4 0 118 0v3', globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  db: 'M4 6c0-2 16-2 16 0v12c0 2-16 2-16 0zM4 12c0 2 16 2 16 0', scale: 'M12 3v18M5 7h14M5 7l-3 7a3 3 0 006 0zM19 7l-3 7a3 3 0 006 0z', chip: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  scan: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M4 12h16', table: 'M3 4h18v16H3zM3 10h18M3 15h18M9 4v16', alert: 'M12 3l10 18H2zM12 10v5M12 18v.5', x: 'M6 6l12 12M18 6L6 18',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13', down: 'M6 9l6 6 6-6', right: 'M9 6l6 6-6 6', filter: 'M3 5h18l-7 8v6l-4-2v-4z', dl: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  up: 'M12 20V8M7 13l5-5 5 5M5 4h14', grip: 'M9 5v.5M9 12v.5M9 19v.5M15 5v.5M15 12v.5M15 19v.5', star: 'M12 3l3 6 6 1-4.5 4.5 1 6.5-5.5-3-5.5 3 1-6.5L3 10l6-1z', pin: 'M9 3h6l-1 7 3 3H7l3-3zM12 13v8',
  link: 'M10 14a4 4 0 005.6 0l3-3a4 4 0 00-5.6-5.6l-1 1M14 10a4 4 0 00-5.6 0l-3 3a4 4 0 005.6 5.6l1-1', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z', copy: 'M8 8h12v12H8zM4 16V4h12',
  more: 'M5 12h.5M12 12h.5M19 12h.5', clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2', menu: 'M4 6h16M4 12h16M4 18h16', cal: 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4', moon: 'M20 14A8 8 0 1110 4a6 6 0 0010 10z',
  out: 'M10 4H4v16h6M15 8l5 4-5 4M20 12H9', server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.5M8 17h.5', card: 'M3 6h18v12H3zM3 10h18', tag: 'M3 12V4h8l10 10-8 8z', pie: 'M12 3v9h9a9 9 0 11-9-9z',
  life: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 15a3 3 0 100-6 3 3 0 000 6z', megaphone: 'M3 10v4h4l8 5V5l-8 5zM18 9a4 4 0 010 6', git: 'M6 3v12M6 15a3 3 0 100 6 3 3 0 000-6zM18 9a3 3 0 100-6 3 3 0 000 6zM18 9c0 6-12 3-12 6',
  key: 'M8 15a4 4 0 100-8 4 4 0 000 8zM11 11h10M18 11v4', upload: 'M12 20V8M7 13l5-5 5 5M5 4h14',
  share: 'M18 8a3 3 0 100-6 3 3 0 000 6zM6 15a3 3 0 100-6 3 3 0 000 6zM18 22a3 3 0 100-6 3 3 0 000 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
} as const
export type CrmIcon = keyof typeof ICO
export function Ic({ n, size = 15, className = '', style }: { n: string; size?: number; className?: string; style?: CSSProperties }) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden style={{ width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', flex: 'none', ...style }}>
    <path d={ICO[n as CrmIcon] ?? ICO.file} />
  </svg>
}
