export type SessionActivitySource = 'user' | 'api'

type SessionActivityListener = (source: SessionActivitySource) => void

const listeners = new Set<SessionActivityListener>()

export function emitSessionActivity(source: SessionActivitySource) {
  listeners.forEach((listener) => {
    try {
      listener(source)
    } catch {
      // ignore listener failures
    }
  })
}

export function subscribeToSessionActivity(listener: SessionActivityListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
