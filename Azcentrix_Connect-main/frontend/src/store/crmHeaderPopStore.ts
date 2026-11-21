import { create } from 'zustand'

// Which CrmHeader popover (Create menu / notifications bell / user menu) is open.
// Was local useState inside CrmHeader's usePop() — lifted to a store so the global
// "N" shortcut (useGlobalShortcuts.ts) can open the Create menu from outside the component.
interface CrmHeaderPopStore {
  open: string | null
  setOpen: (value: string | null) => void
  toggle: (key: string) => void
}

export const useCrmHeaderPopStore = create<CrmHeaderPopStore>((set) => ({
  open: null,
  setOpen: (value) => set({ open: value }),
  toggle: (key) => set((s) => ({ open: s.open === key ? null : key })),
}))
