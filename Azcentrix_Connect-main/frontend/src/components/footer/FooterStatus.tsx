// Prototype v17 right side of ftHTML(): online indicator, "Synced HH:MM", and the
// Shortcuts button (shares its open state with the global "?" listener, see
// useGlobalShortcuts.ts / shortcutsModalStore.ts).
//
// "Online" is NOT a per-user presence indicator (it doesn't know or care whether anyone
// else is logged in anywhere) – it's just this browser tab's own connectivity to our
// backend. It used to trust navigator.onLine alone, which only reports whether the OS
// network adapter is up, not whether it can actually reach the server – a flaky wifi/VPN
// hop, a captive portal, or a sleeping laptop waking up can all make it report "online"
// or "offline" wrongly for a while. It now also actively pings /health and only shows
// "Online" once that succeeds, so a real, successful round-trip is what the badge means.
import { useEffect, useRef, useState } from 'react'
import { useShortcutsModalStore } from '@/store/shortcutsModalStore'

const fmtTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const HEALTH_URL = (import.meta.env.VITE_API_URL || '/api/v1').replace(/\/api\/v1\/?$/, '') + '/health'

export default function FooterStatus() {
  const [synced, setSynced] = useState(fmtTime())
  const [online, setOnline] = useState(() => navigator.onLine)
  const toggleShortcuts = useShortcutsModalStore((s) => s.toggle)
  const checking = useRef(false)

  useEffect(() => {
    const ping = async () => {
      if (checking.current) return
      if (!navigator.onLine) { setOnline(false); return }
      checking.current = true
      try {
        const ctrl = new AbortController()
        const timeout = window.setTimeout(() => ctrl.abort(), 5000)
        const res = await fetch(HEALTH_URL, { signal: ctrl.signal, cache: 'no-store' })
        window.clearTimeout(timeout)
        setOnline(res.ok)
        if (res.ok) setSynced(fmtTime())
      } catch { setOnline(false) }
      finally { checking.current = false }
    }
    void ping()
    const timer = window.setInterval(ping, 30_000)
    const goOnline = () => void ping()
    const goOffline = () => setOnline(false)
    const onVisible = () => { if (document.visibilityState === 'visible') void ping() }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return <>
    <span className="flex-1" />
    <span className="tn-ftm">
      <i className="livedot" style={!online ? { background: 'var(--color-danger)', animation: 'none' } : undefined} />
      {online ? 'Online' : 'Offline'}
    </span>
    <span className="tn-ftm">Synced {synced}</span>
    <button type="button" className="tn-ftb" onClick={toggleShortcuts} title="Keyboard shortcuts">
      <span>Shortcuts</span><kbd className="tn-kbd">?</kbd>
    </button>
  </>
}
