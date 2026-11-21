import { create } from 'zustand'

// Team Chat's open/minimize/maximize state — shared between the footer button
// (TeamChatFooterButton.tsx) that triggers it and the floating window itself
// (components/chat/ChatWidget.tsx), mounted once in AppLayout.
export type ChatWidgetState = 'closed' | 'minimized' | 'normal' | 'maximized'

interface ChatWidgetStore {
  state: ChatWidgetState
  open: () => void
  close: () => void
  minimize: () => void
  toggleMaximize: () => void
}

export const useChatWidgetStore = create<ChatWidgetStore>((set) => ({
  state: 'closed',
  open: () => set((s) => ({ state: s.state === 'closed' ? 'normal' : s.state === 'minimized' ? 'normal' : s.state })),
  close: () => set({ state: 'closed' }),
  minimize: () => set({ state: 'minimized' }),
  toggleMaximize: () => set((s) => ({ state: s.state === 'maximized' ? 'normal' : 'maximized' })),
}))
