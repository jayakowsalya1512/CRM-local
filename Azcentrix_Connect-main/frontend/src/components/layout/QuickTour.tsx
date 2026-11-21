import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react'

type QuickTourProps = { open: boolean; userName?: string; onClose: () => void }

const steps = [
  { title: 'Welcome to Azcentrix Connect', text: 'Your workspace brings customers, opportunities, tenders, reports, and collaboration together in one place.', area: 'center' },
  { title: 'Navigate your modules', text: 'Use the main menu to move between Dashboard, Customers, Leads, Opportunities, and every enabled module.', area: 'sidebar' },
  { title: 'Use Quick Help anytime', text: 'Select the help icon in the top bar to find guides, tutorials, AI assistance, and support whenever you need it.', area: 'header' },
  { title: 'You are ready to go', text: 'Start with your dashboard, then explore the module you need. You can restart this tour anytime from Quick Help.', area: 'center' },
]

export default function QuickTour({ open, userName, onClose }: QuickTourProps) {
  const [step, setStep] = useState(0)
  useEffect(() => { if (open) setStep(0) }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); if (event.key === 'ArrowRight') setStep(current => Math.min(current + 1, steps.length - 1)); if (event.key === 'ArrowLeft') setStep(current => Math.max(current - 1, 0)) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  const current = steps[step]
  const isLast = step === steps.length - 1
  const cardPosition = current.area === 'sidebar' ? 'left-[236px] top-24' : current.area === 'header' ? 'right-8 top-20' : 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
  return <div className="fixed inset-0 z-[120]" role="dialog" aria-modal="true" aria-label="Azcentrix Connect quick tour">
    <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-[1px]" />
    {current.area === 'sidebar' && <div className="absolute inset-y-0 left-0 w-[220px] border-2 border-blue-400 bg-blue-500/10 shadow-[0_0_0_9999px_rgba(15,23,42,.46)]" />}
    {current.area === 'header' && <div className="absolute top-0 right-0 h-14 w-[360px] border-2 border-blue-400 bg-blue-500/10 shadow-[0_0_0_9999px_rgba(15,23,42,.46)]" />}
    <section className={`absolute w-[min(390px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-white/20 bg-white shadow-2xl ${cardPosition}`}>
      <div className="bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-accent)] px-5 py-4 text-white">
        <button onClick={onClose} className="absolute right-3 top-3 rounded-lg p-1.5 text-white/80 hover:bg-white/15 hover:text-white" aria-label="Close tour"><X size={18} /></button>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/70">Quick Tour · {step + 1} of {steps.length}</p>
        <h2 className="mt-2 pr-7 text-xl font-bold">{step === 0 && userName ? `Welcome, ${userName.split(' ')[0]}!` : current.title}</h2>
      </div>
      <div className="px-5 py-5"><p className="text-sm leading-6 text-slate-600">{current.text}</p></div>
      <footer className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
        <button onClick={() => setStep(current => Math.max(current - 1, 0))} disabled={step === 0} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-100 disabled:invisible"><ArrowLeft size={15} /> Back</button>
        <button onClick={() => isLast ? onClose() : setStep(current => current + 1)} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700">{isLast ? <>Finish <Check size={15} /></> : <>Next <ArrowRight size={15} /></>}</button>
      </footer>
    </section>
  </div>
}
