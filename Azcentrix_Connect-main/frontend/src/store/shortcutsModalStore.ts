import { create } from 'zustand'

// Whether the Keyboard Shortcuts modal is open — shared so both the global "?" listener
// (useGlobalShortcuts.ts) and the footer's "Shortcuts" button can toggle the same modal.
interface ShortcutsModalStore {
  open: boolean
  toggle: () => void
  close: () => void
}

export const useShortcutsModalStore = create<ShortcutsModalStore>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}))
