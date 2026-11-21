import { useEffect, useState } from 'react'
import { Clapperboard, ClipboardList, Headphones, MessageSquareWarning, Route, Send, Sparkles, X, type LucideIcon } from 'lucide-react'

type HelpSupportProps = { open: boolean; userName?: string; onClose: () => void; onQuickTour: () => void; onDocumentLibrary: () => void; onVideoTutorials: () => void; onReportIssue: () => void; onAiAssistant: () => void; onContactSupport: () => void; onAskAssistant: (question: string) => void }
type HelpAction = { title: string; icon: LucideIcon; color: string; action: () => void }

/** Personalized global quick-help menu. */
export default function HelpSupport({ open, userName, onClose, onQuickTour, onDocumentLibrary, onVideoTutorials, onReportIssue, onAiAssistant, onContactSupport, onAskAssistant }: HelpSupportProps) {
  const [question, setQuestion] = useState('')
  const displayName = userName?.trim().replace(/\s+/g, ' ') || 'there'

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  const actions: HelpAction[] = [
    { title: 'Quick Tour', icon: Route, color: 'bg-blue-50 text-blue-600', action: onQuickTour },
    { title: 'Document Library', icon: ClipboardList, color: 'bg-emerald-50 text-emerald-600', action: onDocumentLibrary },
    { title: 'Video Tutorials', icon: Clapperboard, color: 'bg-rose-50 text-rose-600', action: onVideoTutorials },
    { title: 'Report an Issue', icon: MessageSquareWarning, color: 'bg-amber-50 text-amber-600', action: onReportIssue },
    { title: 'AI Help Assistant', icon: Sparkles, color: 'bg-violet-50 text-violet-600', action: onAiAssistant },
    { title: 'Contact Support', icon: Headphones, color: 'bg-cyan-50 text-cyan-600', action: onContactSupport },
  ]
  const submitQuestion = (event: React.FormEvent) => {
    event.preventDefault()
    const value = question.trim()
    if (!value) return
    onAskAssistant(value)
    setQuestion('')
  }

  return <section className="absolute right-0 top-full mt-2 overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl shadow-slate-900/20 z-[80]" style={{ width: 'min(390px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-label="Quick help">
    <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-br from-blue-50 via-white to-violet-50" />
    <div className="relative">
      <header className="flex items-center justify-between px-5 pt-3">
        <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white shadow-sm"><Headphones size={14} /></span><h2 className="text-base font-bold tracking-tight text-slate-900">Quick Help</h2></div>
        <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-800" aria-label="Close quick help"><X size={19} /></button>
      </header>
      <div className="px-5 pb-1 pt-2 text-center"><h3 className="text-lg font-bold tracking-tight"><span className="text-blue-600">Hello</span>{' '}<span className="text-violet-600">{displayName}!</span>{' '}<span aria-hidden="true">👋</span></h3><p className="mt-0.5 text-xs font-medium text-slate-500">How can I help you today?</p></div>
      <div className="space-y-1.5 px-4 py-3">{actions.map(({ title, icon: Icon, color, action }) => <button key={title} onClick={action} className="group flex h-9 w-full items-center gap-3 rounded-lg border border-slate-200 bg-white px-3.5 text-left text-sm font-semibold text-slate-700 transition duration-200 hover:-translate-y-px hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 hover:shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"><span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition group-hover:scale-110 ${color}`}><Icon size={14} /></span><span>{title}</span></button>)}</div>
      <div className="mx-5 flex items-center gap-3 py-1 text-[10px] font-medium text-slate-400 before:h-px before:flex-1 before:bg-slate-200 after:h-px after:flex-1 after:bg-slate-200">OR</div>
      <form onSubmit={submitQuestion} className="px-4 pb-3 pt-2"><label className="sr-only" htmlFor="help-ai-question">Ask the AI assistant</label><div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-1 transition focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/15"><input id="help-ai-question" maxLength={1000} value={question} onChange={event => setQuestion(event.target.value)} className="min-w-0 flex-1 bg-transparent px-2 text-xs text-slate-800 outline-none placeholder:text-slate-400" placeholder="Ask your AI CRM assistant" /><button type="submit" disabled={!question.trim()} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45" aria-label="Ask AI assistant"><Send size={15} /></button></div></form>
    </div>
  </section>
}
