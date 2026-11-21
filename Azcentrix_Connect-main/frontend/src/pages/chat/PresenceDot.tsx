import type { PresenceStatus } from '@/services/chatApi'

const COLOR: Record<PresenceStatus, string> = {
  online: '#22C55E',
  away: '#F59E0B',
  dnd: '#EF4444',
  offline: '#94A3B8',
}

export const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: 'Online',
  away: 'Away',
  dnd: 'Do not disturb',
  offline: 'Offline',
}

export default function PresenceDot({ status, size = 9 }: { status: PresenceStatus; size?: number }) {
  return (
    <span
      title={STATUS_LABEL[status]}
      style={{
        display: 'inline-block', width: size, height: size, borderRadius: '50%',
        background: COLOR[status], border: '2px solid var(--surface)', flex: 'none',
      }}
    />
  )
}
