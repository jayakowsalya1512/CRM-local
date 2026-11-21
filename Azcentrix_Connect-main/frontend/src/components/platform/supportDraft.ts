// Support Desk reply drafts, per ticket, kept in this browser tab (sessionStorage) so a canned response picked on the
// SLA & CSAT page lands in the reply editor of the ticket being worked on. Nothing is sent until the reply is sent.
const DRAFT = (id: number) => `bw-support-draft:${id}`
const CURRENT = 'bw-support-current'

const read = (k: string) => { try { return sessionStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string | null) => { try { if (v == null || v === '') sessionStorage.removeItem(k); else sessionStorage.setItem(k, v) } catch { /* storage unavailable */ } }

export const getDraft = (id: number) => read(DRAFT(id)) ?? ''
export const setDraft = (id: number, text: string) => write(DRAFT(id), text)
export const clearDraft = (id: number) => write(DRAFT(id), null)

export type CurrentTicket = { id: number; ref: string }
export const getCurrentTicket = (): CurrentTicket | null => { try { return JSON.parse(read(CURRENT) || 'null') } catch { return null } }
export const setCurrentTicket = (t: CurrentTicket | null) => write(CURRENT, t ? JSON.stringify(t) : null)

/** Append a template to a draft on its own paragraph; returns the new draft. */
export function insertIntoDraft(id: number, text: string) {
  const cur = getDraft(id).replace(/\s+$/, '')
  const next = cur ? `${cur}\n\n${text}` : text
  setDraft(id, next)
  return next
}
