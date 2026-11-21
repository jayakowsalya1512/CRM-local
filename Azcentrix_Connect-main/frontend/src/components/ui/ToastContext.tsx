import { useState, createContext, useContext, useCallback, useMemo } from 'react'
import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-react'

interface Toast {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  title: string
  message?: string
}

interface ToastCtx {
  toast: (t: Omit<Toast, 'id'>) => void
  success: (title: string, message?: string) => void
  error: (title: string, message?: string) => void
  warning: (title: string, message?: string) => void
  info: (title: string, message?: string) => void
}

const ToastContext = createContext<ToastCtx>({
  toast: () => {}, success: () => {}, error: () => {}, warning: () => {}, info: () => {},
})

export function useToast() { return useContext(ToastContext) }

const ICONS = {
  success: <CheckCircle size={18} className="text-green-500 flex-shrink-0" />,
  error: <XCircle size={18} className="text-red-500 flex-shrink-0" />,
  warning: <AlertCircle size={18} className="text-amber-500 flex-shrink-0" />,
  info: <Info size={18} className="text-blue-500 flex-shrink-0" />,
}

const BG = { success: 'bg-green-50 border-green-200', error: 'bg-red-50 border-red-200', warning: 'bg-amber-50 border-amber-200', info: 'bg-blue-50 border-blue-200' }

let _toastSeq = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const add = useCallback((t: Omit<Toast, 'id'>) => {
    const id = `t-${++_toastSeq}`
    setToasts(prev => [...prev, { ...t, id }])
    setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), 4000)
  }, [])

  // Stable functions: pages list them in effect/callback dependencies, and new ones on every toast would re-run those
  // effects (a failing load would then toast in a loop).
  const ctx: ToastCtx = useMemo(() => ({
    toast: add,
    success: (title, message) => add({ type: 'success', title, message }),
    error: (title, message) => add({ type: 'error', title, message }),
    warning: (title, message) => add({ type: 'warning', title, message }),
    info: (title, message) => add({ type: 'info', title, message }),
  }), [add])

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      <div className="fixed top-4 right-4 z-[100400] flex flex-col gap-2 max-w-sm w-full">
        {toasts.map(t => (
          <div key={t.id}
            className={`flex items-start gap-3 p-4 rounded-xl border shadow-lg animate-in slide-in-from-top-2 ${BG[t.type]}`}>
            {ICONS[t.type]}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">{t.title}</p>
              {t.message && <p className="text-xs text-gray-600 mt-0.5">{t.message}</p>}
            </div>
            <button onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
              className="text-gray-400 hover:text-gray-600 flex-shrink-0">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
