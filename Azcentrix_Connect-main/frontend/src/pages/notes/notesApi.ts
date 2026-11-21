// Notes & Pinboard – typed calls to /api/v1/notes (the page, the footer Quick note and Create → Sticky note).
import api from '@/services/api'

export type NoteColor = 'yellow' | 'green' | 'blue' | 'pink' | 'lavender'
// Prototype order and hex values (A.noteC)
export const NOTE_COLORS: [NoteColor, string][] = [['yellow', '#FFE58A'], ['green', '#BFE7C8'], ['blue', '#C9DDF7'], ['pink', '#F7C9D6'], ['lavender', '#E3D3F7']]
export const COLOR_NAME: Record<NoteColor, string> = { yellow: 'Yellow', green: 'Green', blue: 'Blue', pink: 'Pink', lavender: 'Purple' }

export interface Note {
  id: number; content: string; color: NoteColor; hex: string; pinned: boolean
  link: { module: string; id: number; label: string; route: string | null; accessible: boolean } | null
  created_at: string | null; updated_at: string | null; version: number
  reminder_at: string | null; reminder_sent: boolean
}

/** Fired after a note is created outside the page (Quick note, Create menu) so an open pinboard reloads. */
export const NOTES_CHANGED = 'azx:notes-changed'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

export const notesApi = {
  list: () => api.get<{ items: Note[]; context: string | null }>('/notes').then(r => r.data),
  create: (body: { content?: string; color?: NoteColor; source: 'page' | 'quick' | 'create_menu'; reminder_at?: string | null; link_module?: string | null; link_record_id?: number | null }) =>
    api.post<Note>('/notes', body).then(r => { if (body.source !== 'page') window.dispatchEvent(new Event(NOTES_CHANGED)); return r.data }),
  update: (id: number, body: Partial<{ content: string; color: NoteColor; pinned: boolean; reminder_at: string | null; clear_reminder: boolean; link_module: string | null; link_record_id: number | null; unlink: boolean }>) => api.patch<Note>(`/notes/${id}`, body).then(r => r.data),
  remove: (id: number) => api.delete<{ ok: boolean }>(`/notes/${id}`).then(r => r.data),
}
