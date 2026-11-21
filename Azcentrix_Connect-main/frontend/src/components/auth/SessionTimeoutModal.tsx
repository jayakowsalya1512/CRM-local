import { Clock } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'

interface SessionTimeoutModalProps {
  open: boolean
  countdownSeconds: number
  stayingLoggedIn: boolean
  onStayLoggedIn: () => void
  onLogout: () => void
}

export default function SessionTimeoutModal({
  open,
  countdownSeconds,
  stayingLoggedIn,
  onStayLoggedIn,
  onLogout,
}: SessionTimeoutModalProps) {
  const safeCountdown = Math.max(0, countdownSeconds)

  return (
    <Modal
      open={open}
      onClose={onLogout}
      closeOnOverlay={false}
      size="sm"
      title="Session Timeout Warning"
      subtitle="Your session is about to expire due to inactivity."
      footer={
        <div className="flex justify-end gap-3">
          <Button variant="cancel" onClick={onLogout} disabled={stayingLoggedIn}>
            Logout
          </Button>
          <Button variant="primary" onClick={onStayLoggedIn} loading={stayingLoggedIn}>
            Stay Logged In
          </Button>
        </div>
      }
    >
      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
        <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <Clock size={16} />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-900">
            Your session will expire soon unless you continue working.
          </p>
          <p className="text-xs text-amber-800">
            Time remaining: {safeCountdown} second{safeCountdown === 1 ? '' : 's'}
          </p>
        </div>
      </div>
    </Modal>
  )
}
