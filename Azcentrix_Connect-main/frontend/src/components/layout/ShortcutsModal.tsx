import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Global',
    rows: [
      ['Ctrl + K', 'Global search'],
      ['Ctrl + Shift + K', 'Command palette (search)'],
      ['?', 'Open this list'],
      ['Esc', 'Close panels, drawers and dialogs'],
      ['N', 'Open the Create menu'],
      ['Alt + A', 'Announcements'],
      ['Alt + R', 'Reminders'],
      ['Alt + C', 'Team Chat'],
    ],
  },
  {
    title: 'Navigation',
    rows: [
      ['Alt + H', 'Dashboard'],
      ['Alt + L', 'Leads'],
      ['Alt + U', 'Customers & Contacts'],
      ['Alt + T', 'Tenders'],
      ['Alt + Q', 'Quotations'],
      ['Alt + D', 'Deals'],
      ['Alt + W', 'Work Orders'],
      ['Alt + P', 'Approvals'],
      ['Alt + B', 'Document Hub'],
      ['Alt + S', 'Settings'],
      ['Alt + M', 'Calendar & Tasks'],
    ],
  },
  {
    title: 'Team Chat',
    rows: [
      ['Ctrl + Shift + M', 'Start new chat'],
      ['Ctrl + Shift + G', 'Create new group'],
      ['Ctrl + F', 'Search current conversation'],
      ['Enter', 'Send message'],
      ['Shift + Enter', 'New line'],
      ['Ctrl + E', 'Open emoji picker'],
      ['Alt + ↑ / Alt + ↓', 'Previous / next conversation'],
      ['↑', 'Edit last sent message (when input is empty)'],
      ['Esc', 'Cancel reply / close emoji picker'],
    ],
  },
  {
    title: 'Forms & records',
    rows: [
      ['Ctrl + S', 'Save current form'],
      ['Ctrl + Shift + S', 'Save as draft'],
      ['Ctrl + Enter', 'Submit form'],
      ['Alt + E', 'Edit selected record'],
      ['Ctrl + Shift + F', 'Open filters'],
      ['Ctrl + Shift + X', 'Export records'],
      ['Alt + ←', 'Back to list page'],
    ],
  },
  {
    title: 'Tables & lists',
    rows: [
      ['↑ / ↓', 'Move selected row'],
      ['Enter', 'Open selected record'],
      ['Space', 'Select / deselect row'],
      ['Ctrl + Shift + R', 'Refresh table data'],
      ['Esc', 'Clear selection'],
      ['/', 'Focus table search'],
    ],
  },
]

export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return GROUPS
    return GROUPS
      .map((group) => ({ ...group, rows: group.rows.filter(([keys, action]) => keys.toLowerCase().includes(q) || action.toLowerCase().includes(q)) }))
      .filter((group) => group.rows.length > 0)
  }, [query])

  return (
    <Modal open onClose={onClose} title="Keyboard shortcuts">
      <div className="relative mb-4">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
        <input
          autoFocus
          className="form-control pl-8"
          placeholder="Search shortcuts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="space-y-5">
        {filteredGroups.length === 0 && (
          <div className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>No shortcuts match "{query}"</div>
        )}
        {filteredGroups.map((group) => (
          <div key={group.title}>
            <h4 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>{group.title}</h4>
            <table className="w-full text-sm">
              <tbody>
                {group.rows.map(([keys, action]) => (
                  <tr key={keys + action} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td className="py-1.5 pr-4 whitespace-nowrap">
                      {keys.split(' / ').map((combo, i) => (
                        <span key={combo}>
                          {i > 0 && <span style={{ color: 'var(--text-muted)' }}> / </span>}
                          {combo.split(' + ').map((k, j) => (
                            <kbd key={k} style={{
                              display: 'inline-block', margin: j > 0 ? '0 0 0 3px' : 0, padding: '1px 7px',
                              borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface-2)',
                              fontSize: 11, fontFamily: 'inherit',
                            }}>{k}</kbd>
                          ))}
                        </span>
                      ))}
                    </td>
                    <td className="py-1.5" style={{ color: 'var(--text-secondary, #64748B)' }}>{action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Modal>
  )
}
