import { create } from 'zustand'

// Prototype v17 S.timer: a single Date.now() timestamp while running, null when stopped.
// Shared so the footer button (which keeps running across every page) and its panel
// read the exact same clock.
interface TimerStore {
  startedAt: number | null
  start: () => void
  /** Stops the timer and returns the elapsed whole minutes (min 1), same as the prototype's rounding. */
  stop: () => number
}

export const useTimerStore = create<TimerStore>((set, get) => ({
  startedAt: null,
  start: () => set({ startedAt: Date.now() }),
  stop: () => {
    const { startedAt } = get()
    set({ startedAt: null })
    if (!startedAt) return 0
    return Math.max(1, Math.round((Date.now() - startedAt) / 60000))
  },
}))
