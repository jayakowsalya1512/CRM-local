import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { authApi, performClientLogout, refreshAuthSession, SESSION_NOTICE_INACTIVE_TIMEOUT } from '@/services/api'
import { subscribeToSessionActivity } from '@/services/sessionActivity'
import { useAuthStore } from '@/store'

const DEFAULT_LOGIN_EXPIRY_MINUTES = 60
const HARDCODED_WARNING_MINUTES = 2
const BACKEND_ACTIVITY_TOUCH_INTERVAL_MS = 60_000

type UseSessionTimeoutResult = {
  warningOpen: boolean
  countdownSeconds: number
  stayingLoggedIn: boolean
  stayLoggedIn: () => Promise<void>
  logoutNow: () => Promise<void>
}

export default function useSessionTimeout(): UseSessionTimeoutResult {
  const { user, access_token, refresh_token, session_policy } = useAuthStore()
  const [warningOpen, setWarningOpen] = useState(false)
  const [countdownSeconds, setCountdownSeconds] = useState(0)
  const [stayingLoggedIn, setStayingLoggedIn] = useState(false)

  const logoutTimerRef = useRef<number | null>(null)
  const warningTimerRef = useRef<number | null>(null)
  const countdownTimerRef = useRef<number | null>(null)
  const logoutDeadlineRef = useRef<number>(0)
  const lastBackendTouchRef = useRef<number>(0)
  const mountedRef = useRef(true)
  const warningOpenRef = useRef(false)

  const inactivityTimeoutMs = useMemo(
    () => (session_policy?.login_expiry_minutes ?? DEFAULT_LOGIN_EXPIRY_MINUTES) * 60_000,
    [session_policy],
  )
  const warningLeadMs = useMemo(
    () => Math.min(inactivityTimeoutMs, HARDCODED_WARNING_MINUTES * 60_000),
    [inactivityTimeoutMs],
  )

  const clearTimers = useCallback(() => {
    if (warningTimerRef.current) {
      window.clearTimeout(warningTimerRef.current)
      warningTimerRef.current = null
    }
    if (logoutTimerRef.current) {
      window.clearTimeout(logoutTimerRef.current)
      logoutTimerRef.current = null
    }
    if (countdownTimerRef.current) {
      window.clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
  }, [])

  const updateCountdown = useCallback(() => {
    const remainingMs = Math.max(0, logoutDeadlineRef.current - Date.now())
    setCountdownSeconds(Math.max(0, Math.ceil(remainingMs / 1000)))
  }, [])

  const applyReturnedPolicy = useCallback((payload?: Record<string, unknown> | null) => {
    const loginExpiryMinutes = Number(payload?.login_expiry_minutes)
    if (Number.isFinite(loginExpiryMinutes) && loginExpiryMinutes > 0) {
      useAuthStore.setState({ session_policy: { login_expiry_minutes: loginExpiryMinutes } })
    }
  }, [])

  const logoutWithNotice = useCallback(async (notice = '') => {
    clearTimers()
    warningOpenRef.current = false
    setWarningOpen(false)
    setCountdownSeconds(0)
    try {
      await authApi.logout()
    } catch {
      // local logout still proceeds
    }
    performClientLogout(notice)
  }, [clearTimers])

  const openWarning = useCallback(() => {
    updateCountdown()
    warningOpenRef.current = true
    setWarningOpen(true)
    if (countdownTimerRef.current) window.clearInterval(countdownTimerRef.current)
    countdownTimerRef.current = window.setInterval(updateCountdown, 1000)
  }, [updateCountdown])

  const scheduleTimers = useCallback(() => {
    clearTimers()
    logoutDeadlineRef.current = Date.now() + inactivityTimeoutMs
    const warningDelayMs = Math.max(0, inactivityTimeoutMs - warningLeadMs)
    warningTimerRef.current = window.setTimeout(openWarning, warningDelayMs)
    logoutTimerRef.current = window.setTimeout(() => {
      void logoutWithNotice(SESSION_NOTICE_INACTIVE_TIMEOUT)
    }, inactivityTimeoutMs)
  }, [clearTimers, inactivityTimeoutMs, logoutWithNotice, openWarning, warningLeadMs])

  const syncBackendActivity = useCallback(async () => {
    const now = Date.now()
    if (now - lastBackendTouchRef.current < BACKEND_ACTIVITY_TOUCH_INTERVAL_MS) return
    lastBackendTouchRef.current = now
    try {
      const { data } = await authApi.touchSessionActivity()
      applyReturnedPolicy(data)
    } catch {
      // auth interceptor handles logout cases
    }
  }, [applyReturnedPolicy])

  const registerActivity = useCallback((source: 'user' | 'api') => {
    if (!user || !access_token || !refresh_token) return
    if (warningOpenRef.current) return
    scheduleTimers()
    if (source === 'user') {
      void syncBackendActivity()
    }
  }, [access_token, refresh_token, scheduleTimers, syncBackendActivity, user])

  const stayLoggedIn = useCallback(async () => {
    clearTimers()
    setStayingLoggedIn(true)
    try {
      await refreshAuthSession({ countAsActivity: true })
      lastBackendTouchRef.current = Date.now()
      warningOpenRef.current = false
      setWarningOpen(false)
      setCountdownSeconds(0)
      scheduleTimers()
    } catch {
      performClientLogout(SESSION_NOTICE_INACTIVE_TIMEOUT)
    } finally {
      if (mountedRef.current) {
        setStayingLoggedIn(false)
      }
    }
  }, [clearTimers, scheduleTimers])

  const logoutNow = useCallback(async () => {
    await logoutWithNotice()
  }, [logoutWithNotice])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!user || !access_token || !refresh_token) {
      clearTimers()
      warningOpenRef.current = false
      setWarningOpen(false)
      setCountdownSeconds(0)
      return
    }

    scheduleTimers()

    const handleUserActivity = () => {
      registerActivity('user')
    }

    const unsubscribe = subscribeToSessionActivity(() => {
      registerActivity('api')
    })

    const events: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel']
    events.forEach((eventName) => {
      window.addEventListener(eventName, handleUserActivity, { passive: true })
    })

    return () => {
      clearTimers()
      unsubscribe()
      events.forEach((eventName) => {
        window.removeEventListener(eventName, handleUserActivity)
      })
    }
  }, [access_token, clearTimers, refresh_token, registerActivity, scheduleTimers, user])

  return {
    warningOpen,
    countdownSeconds,
    stayingLoggedIn,
    stayLoggedIn,
    logoutNow,
  }
}
