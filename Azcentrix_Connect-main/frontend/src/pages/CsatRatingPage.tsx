import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import axios from 'axios'
import { Loader2, Star } from 'lucide-react'

// Public page behind the rating link e-mailed when a Support Desk ticket is resolved (SLA & CSAT). The one-time token is
// the only credential; the rating (1–5) and optional feedback are stored against the ticket.
const BASE_URL = import.meta.env.VITE_API_URL || '/api/v1'
type Info = { ref: string; subject: string; tenant: string | null; resolved_at: string | null }
const LABELS = ['', 'Very poor', 'Poor', 'Okay', 'Good', 'Excellent']
const detail = (err: unknown, fallback: string) => (axios.isAxiosError(err) && typeof err.response?.data?.detail === 'string' ? err.response.data.detail : fallback)

export default function CsatRatingPage() {
  const { token = '' } = useParams()
  const [info, setInfo] = useState<Info | null>(null)
  const [error, setError] = useState('')
  const [rating, setRating] = useState(0)
  const [hover, setHover] = useState(0)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  useEffect(() => {
    axios.get<Info>(`${BASE_URL}/support-csat/${encodeURIComponent(token)}`).then(({ data }) => setInfo(data)).catch(err => setError(detail(err, 'This rating link could not be opened')))
  }, [token])
  const submit = async () => {
    setBusy(true); setError('')
    try { await axios.post(`${BASE_URL}/support-csat/${encodeURIComponent(token)}`, { rating, feedback }); setDone(true) }
    catch (err) { setError(detail(err, 'Your rating could not be saved – please try again')) } finally { setBusy(false) }
  }
  const shown = hover || rating
  return <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
    <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      {done ? <div className="text-center"><h1 className="text-lg font-semibold text-slate-900">Thank you!</h1>
        <p className="mt-2 text-sm text-slate-600">Your feedback on {info?.ref} has been recorded.</p></div>
        : !info ? <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-600">{error || <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</>}</div>
          : <>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{info.tenant ?? 'Support'} · {info.ref}</p>
            <h1 className="mt-1 text-lg font-semibold text-slate-900">How did we do?</h1>
            <p className="mt-1 text-sm text-slate-600">Rate the support you received on “{info.subject}”.</p>
            <div className="mt-4 flex items-center gap-1" role="radiogroup" aria-label="Rating from 1 to 5" onMouseLeave={() => setHover(0)}>
              {[1, 2, 3, 4, 5].map(n => <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} – ${LABELS[n]}`}
                onClick={() => setRating(n)} onMouseEnter={() => setHover(n)} className="rounded p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
                <Star className={`h-8 w-8 ${n <= shown ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} /></button>)}
              <span className="ml-2 text-sm text-slate-600">{shown ? LABELS[shown] : ''}</span>
            </div>
            <label className="mt-4 block text-sm text-slate-700">Anything we could do better? <span className="text-slate-400">(optional)</span>
              <textarea className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none" rows={4} maxLength={2000}
                value={feedback} onChange={e => setFeedback(e.target.value)} /></label>
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            <button type="button" disabled={!rating || busy} onClick={() => void submit()}
              className="mt-4 w-full rounded-md bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-50">{busy ? 'Sending…' : 'Submit rating'}</button>
          </>}
    </div>
  </div>
}
