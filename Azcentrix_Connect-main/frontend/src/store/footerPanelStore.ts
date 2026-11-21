import { create } from 'zustand'

// Which footer-bar popover is open — lifted out of each button's own local state so only
// one can ever be open at a time (they used to each keep their own `open` state, which let
// Announcements, Calculator, Recent, Timer and Quick note all stack open and overlap at
// once) and so a global shortcut (Alt+A / Alt+R) can toggle Announcements/Reminders from
// outside. Team Chat uses its own chatWidgetStore instead, since it's a window, not a popover.
export type FooterPanel = 'announcements' | 'reminders' | 'recent' | 'calculator' | 'timer' | 'quicknote' | null

interface FooterPanelStore {
  panel: FooterPanel
  toggle: (panel: Exclude<FooterPanel, null>) => void
  close: () => void
}

export const useFooterPanelStore = create<FooterPanelStore>((set) => ({
  panel: null,
  toggle: (panel) => set((s) => ({ panel: s.panel === panel ? null : panel })),
  close: () => set({ panel: null }),
}))
