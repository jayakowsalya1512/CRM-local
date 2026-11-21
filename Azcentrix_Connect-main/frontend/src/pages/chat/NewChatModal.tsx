import { useEffect, useMemo, useState } from 'react'
import api from '@/services/api'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input, Checkbox } from '@/components/ui/Input'
import { useAuthStore } from '@/store'

type Person = { id: number; full_name: string; avatar_url?: string | null; is_active?: boolean }

export default function NewChatModal({ onClose, onCreateDM, onCreateGroup }: {
  onClose: () => void
  onCreateDM: (userId: number) => void
  onCreateGroup: (name: string, memberIds: number[], description: string, isPrivate: boolean) => void
}) {
  const myId = useAuthStore((s) => s.user?.id)
  const [people, setPeople] = useState<Person[]>([])
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'dm' | 'group'>('dm')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [groupName, setGroupName] = useState('')
  const [isPrivate, setIsPrivate] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.get<Person[]>('/auth/users').then(({ data }) => setPeople(data.filter((p) => p.id !== myId && p.is_active !== false))).catch(() => setPeople([]))
  }, [myId])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return people
    return people.filter((p) => p.full_name.toLowerCase().includes(q))
  }, [people, query])

  const toggle = (id: number) => setSelected((s) => {
    const next = new Set(s)
    if (mode === 'dm') { next.clear(); next.add(id); return next }
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const submit = () => {
    if (mode === 'dm') {
      const [id] = Array.from(selected)
      if (!id) return
      setBusy(true)
      onCreateDM(id)
      return
    }
    if (!groupName.trim() || selected.size === 0) return
    setBusy(true)
    onCreateGroup(groupName.trim(), Array.from(selected), '', isPrivate)
  }

  return (
    <Modal open onClose={onClose} title="New chat" footer={<>
      <Button variant="cancel" onClick={onClose}>Cancel</Button>
      <Button onClick={submit} loading={busy} disabled={mode === 'dm' ? selected.size === 0 : !groupName.trim() || selected.size === 0}>
        {mode === 'dm' ? 'Start chat' : 'Create group'}
      </Button>
    </>}>
      <div className="chat-newchat">
        <div className="chat-newchat-tabs">
          <button type="button" className={mode === 'dm' ? 'on' : ''} onClick={() => { setMode('dm'); setSelected(new Set()) }}>Direct message</button>
          <button type="button" className={mode === 'group' ? 'on' : ''} onClick={() => { setMode('group'); setSelected(new Set()) }}>Group</button>
        </div>
        {mode === 'group' && (
          <>
            <Input label="Group name" required value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="e.g. Bid Cell" />
            <Checkbox label="Private group (invitation only)" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
          </>
        )}
        <Input placeholder="Search people…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="chat-people-list">
          {filtered.map((p) => (
            <label key={p.id} className="chat-people-row">
              <input type={mode === 'dm' ? 'radio' : 'checkbox'} name="chat-person" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
              <span className="chat-avatar sm">{p.full_name?.[0]?.toUpperCase() || '?'}</span>
              <span>{p.full_name}</span>
            </label>
          ))}
          {filtered.length === 0 && <div className="chat-empty-hint">No people found</div>}
        </div>
      </div>
    </Modal>
  )
}
