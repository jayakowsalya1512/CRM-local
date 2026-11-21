import { useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { RefreshCw, ShieldCheck, CheckCircle2 } from 'lucide-react'
import { useAuthStore } from '@/store'
import api, { authApi } from '@/services/api'
import { useToast } from '@/components/ui/FormComponents'
import { isTokenExpired } from '@/utils/auth'

type PendingOtpChallenge = {
  challengeId: string
  deliveryTarget: string
  message: string
  expiresInSeconds: number
}

type FieldErrors = {
  organisation?: string
  username?: string
  password?: string
  otp?: string
}

const REMEMBERED_LOGIN_KEY = 'az_app_login'

// Product icon served from frontend/public — a transparent, tightly cropped
// copy of "App-icon (1).png" so it sits directly on the dark hero panel.
const APP_ICON_SRC = '/app-icon-transparent.png'

// Sales flows animated in the left panel — one row of stages per flow tab.
const FLOWS: { label: string; stages: string[] }[] = [
  { label: 'B2B sales', stages: ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won'] },
  { label: 'B2C sales', stages: ['Enquiry', 'Contacted', 'Quote sent', 'Order placed', 'Delivered'] },
  { label: 'Quotations', stages: ['Draft', 'Review', 'Approved', 'Sent', 'Accepted'] },
  { label: 'Orders & service', stages: ['Order', 'In progress', 'Delivered', 'Invoiced', 'Closed'] },
]

const MODULES = [
  'Customers & Contacts', 'Leads', 'Deals', 'Quotes & Pricing', 'Product & Price Books', 'Orders',
  'Customer 360', 'Field Sales', 'Approvals', 'Automation', 'Analytics', 'Reports', 'Mobile', 'Mail',
]

const TILES = [
  { label: 'Open deals', value: 128, suffix: '', note: '▲ 12 this week' },
  { label: 'Quotes awaiting approval', value: 9, suffix: '', note: '2 near deadline' },
  { label: 'Conversion rate', value: 38, suffix: '%', note: '▲ 4 pts' },
]

function resolveInitialTenantSlug() {
  const hostname = window.location.hostname.trim().toLowerCase()
  const isIpv4Host = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
  const isLocalHost = hostname === 'localhost' || hostname.endsWith('.localhost')
  const isIpv6Host = hostname.includes(':')
  const parts = hostname.split('.')

  if (!isIpv4Host && !isLocalHost && !isIpv6Host && parts.length >= 3 && parts[0]) {
    return parts[0]
  }

  try {
    return localStorage.getItem('last_tenant') || ''
  } catch {
    return ''
  }
}

function readRememberedLogin(): { o: string; u: string } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(REMEMBERED_LOGIN_KEY) || 'null')
    return parsed && typeof parsed.o === 'string' && typeof parsed.u === 'string' ? parsed : null
  } catch {
    return null
  }
}

function getCachedCaptchaRequired(slug: string): boolean {
  if (!slug) return false
  try { return localStorage.getItem(`captcha_req:${slug}`) === '1' } catch { return false }
}

function setCachedCaptchaRequired(slug: string, required: boolean) {
  if (!slug) return
  try {
    if (required) localStorage.setItem(`captcha_req:${slug}`, '1')
    else localStorage.removeItem(`captcha_req:${slug}`)
  } catch {}
}

function generateMathChallenge() {
  const a = Math.floor(Math.random() * 9) + 1
  const b = Math.floor(Math.random() * 9) + 1
  return { question: `${a} + ${b}`, answer: a + b }
}

// Counts a hero tile up from 0 with an ease-out curve.
function CountUp({ to, suffix }: { to: number; suffix: string }) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    const start = performance.now()
    let frame = 0
    const step = (now: number) => {
      const x = Math.min(1, (now - start) / 1200)
      setValue(Math.round(to * (1 - Math.pow(1 - x, 3))))
      if (x < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [to])
  return <>{value}{suffix}</>
}

function HeroPanel() {
  const [flow, setFlow] = useState(0)
  // 0..stages.length — index of the highlighted stage; stages before it are "done".
  const [step, setStep] = useState(0)
  const stepRef = useRef(0)
  const [cycle, setCycle] = useState(0)

  useEffect(() => { stepRef.current = step }, [step])

  useEffect(() => {
    const id = window.setInterval(() => {
      setStep(s => (s + 1) % (FLOWS[flow].stages.length + 1))
    }, 1300)
    return () => window.clearInterval(id)
  }, [flow, cycle])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (stepRef.current === 0) {
        setFlow(f => (f + 1) % FLOWS.length)
      }
    }, 9000)
    return () => window.clearInterval(id)
  }, [])

  const selectFlow = (index: number) => {
    setFlow(index)
    setStep(0)
    setCycle(c => c + 1)
  }

  return (
    <section className="azl-hero" aria-hidden="true">
      <div className="azl-brand">
        <span className="azl-mark"><img src={APP_ICON_SRC} alt="" className="azl-brand-icon" /></span>
        <span className="azl-brand-name">Azcentrix<em>Connect</em></span>
      </div>
      <h1>Every customer. Every deal. <em>One connected CRM.</em></h1>
      <p>Run sales, quotations, orders and customer relationships in one workspace – for B2B, B2C and everything in between.</p>
      <div className="azl-flows">
        {FLOWS.map((item, i) => (
          <button key={item.label} type="button" tabIndex={-1} className={i === flow ? 'on' : ''} onClick={() => selectFlow(i)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="azl-pipe">
        {FLOWS[flow].stages.map((stage, i) => (
          <div key={stage} className={`azl-stg${i < step ? ' fin' : ''}${i === step ? ' on' : ''}`}>{stage}</div>
        ))}
      </div>
      <div className="azl-tiles">
        {TILES.map(tile => (
          <div key={tile.label} className="azl-tile">
            <label>{tile.label}</label>
            <b><CountUp to={tile.value} suffix={tile.suffix} /></b>
            <i>{tile.note}</i>
          </div>
        ))}
      </div>
      <div className="azl-mq">
        <div>{[...MODULES, ...MODULES].map((m, i) => <span key={i}>{m}</span>)}</div>
      </div>
      <div className="azl-hfoot">
        <span>Custom workflows per team</span>
        <span>Role-based access</span>
        <span>Works offline on mobile</span>
      </div>
    </section>
  )
}

const UserIcon = () => (
  <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></svg>
)
const OrgIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h6" /></svg>
)
const LockIcon = () => (
  <svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
)

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { login, user, access_token } = useAuthStore()
  const { success } = useToast()
  const rememberedLogin = useRef(readRememberedLogin()).current
  const initialTenantSlug = rememberedLogin?.o || resolveInitialTenantSlug()

  const [tenantSlug, setTenantSlug] = useState(initialTenantSlug)
  const [username,   setUsername]   = useState(rememberedLogin?.u || '')
  const [password,   setPassword]   = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(Boolean(rememberedLogin))
  const [loading,    setLoading]    = useState(false)
  const [otpCode, setOtpCode] = useState('')
  const [pendingOtp, setPendingOtp] = useState<PendingOtpChallenge | null>(null)
  const [resendingOtp, setResendingOtp] = useState(false)
  const [capsLockOn, setCapsLockOn] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState('')
  const [shakeKey, setShakeKey] = useState(0)

  const [contactOpen, setContactOpen] = useState(false)
  const [contactOrg, setContactOrg] = useState('')
  const [contactUser, setContactUser] = useState('')
  const [contactError, setContactError] = useState('')
  const [contactSentMessage, setContactSentMessage] = useState('')
  const [contactingAdmin, setContactingAdmin] = useState(false)

  const [captchaRequired, setCaptchaRequired] = useState(() => getCachedCaptchaRequired(initialTenantSlug))
  const captchaRequiredRef = useRef(getCachedCaptchaRequired(initialTenantSlug))
  const [captcha,         setCaptcha]         = useState(generateMathChallenge)
  const [captchaInput,    setCaptchaInput]    = useState('')
  const [captchaSolved,   setCaptchaSolved]   = useState(false)
  const [brandingTenantSlug, setBrandingTenantSlug] = useState(initialTenantSlug)
  const [forgotPasswordEnabled, setForgotPasswordEnabled] = useState(true)

  const isOtpStep = Boolean(pendingOtp?.challengeId)

  useEffect(() => {
    if (user && access_token && !isTokenExpired(access_token)) {
      navigate('/dashboard', { replace: true })
    }
  }, [access_token, navigate, user])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const sessionNotice = params.get('session_notice')
    if (!sessionNotice) return

    if (sessionNotice === 'admin-force-logout') {
      setFormError('An administrator logged you out for security reasons. Please sign in again.')
    } else if (sessionNotice === 'other-device-logout') {
      setFormError('You were logged out from another device. Please sign in again.')
    } else if (sessionNotice === 'inactive-timeout') {
      setFormError('Your session expired due to inactivity. Please sign in again.')
    } else {
      return
    }

    params.delete('session_notice')
    const nextQuery = params.toString()
    navigate(nextQuery ? `/login?${nextQuery}` : '/login', { replace: true })
  }, [location.search, navigate])

  useEffect(() => {
    const normalizedTenantSlug = tenantSlug.trim().toLowerCase()
    const timer = window.setTimeout(() => {
      setBrandingTenantSlug(normalizedTenantSlug)
    }, 250)

    return () => window.clearTimeout(timer)
  }, [tenantSlug])

  useEffect(() => {
    const normalizedTenantSlug = tenantSlug.trim().toLowerCase()
    if (!normalizedTenantSlug) return
    const timer = window.setTimeout(async () => {
      try {
        const { data } = await authApi.maintenanceStatus(normalizedTenantSlug)
        if (data.maintenance_mode) navigate('/maintenance', { replace: true })
      } catch {
        // An invalid or unreachable tenant is handled by the normal sign-in flow.
      }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [navigate, tenantSlug])

  // Tenant theme lookup: decides whether "Forgot password?" is offered and
  // warms the theme cache the app shell reads after sign-in.
  useEffect(() => {
    const normalizedTenantSlug = brandingTenantSlug.trim().toLowerCase()
    let isActive = true

    setForgotPasswordEnabled(true)
    if (!normalizedTenantSlug) return

    ;(async () => {
      try {
        const { data } = await api.get('/settings/theme', {
          headers: { 'X-Tenant-Slug': normalizedTenantSlug },
        })

        if (!isActive) return

        try {
          const cacheKey = `crm_theme:${normalizedTenantSlug}`
          let existingThemeCache: Record<string, any> = {}
          try {
            const parsedThemeCache = JSON.parse(localStorage.getItem(cacheKey) || '{}')
            if (parsedThemeCache && typeof parsedThemeCache === 'object' && !Array.isArray(parsedThemeCache)) {
              existingThemeCache = parsedThemeCache
            }
          } catch {
            existingThemeCache = {}
          }
          localStorage.setItem(cacheKey, JSON.stringify({
            ...existingThemeCache,
            company_name: data?.company_name?.trim() || '',
            theme_logo: data?.theme_logo || data?.company_logo || data?.logo_url || '',
            theme_logo_version: data?.theme_logo_version || '',
            logo_url: data?.logo_url || data?.theme_logo || '',
          }))
        } catch {
          // ignore cache errors
        }

        setForgotPasswordEnabled(Boolean(data?.forgot_password_enabled ?? true))
      } catch {
        if (isActive) setForgotPasswordEnabled(true)
      }
    })()

    return () => {
      isActive = false
    }
  }, [brandingTenantSlug])

  const resetOtpStep = (clearPassword = false) => {
    setPendingOtp(null)
    setOtpCode('')
    if (clearPassword) setPassword('')
  }

  // Keep ref in sync so async callbacks always read the latest value without
  // needing captchaRequired in every effect's dependency array.
  useEffect(() => { captchaRequiredRef.current = captchaRequired }, [captchaRequired])

  const refreshCaptcha = () => {
    setCaptcha(generateMathChallenge())
    setCaptchaInput('')
    setCaptchaSolved(false)
  }

  const handleCaptchaInput = (val: string) => {
    setCaptchaInput(val)
    setCaptchaSolved(parseInt(val, 10) === captcha.answer)
  }

  useEffect(() => {
    const normalizedTenantSlug = tenantSlug.trim().toLowerCase()
    if (!normalizedTenantSlug || isOtpStep) {
      setCaptchaRequired(false)
      setCaptchaInput('')
      setCaptchaSolved(false)
      return
    }

    const normalizedUsername = username.trim()
    if (!normalizedUsername) {
      setCaptchaInput('')
      setCaptchaSolved(false)
      return
    }

    let cancelled = false

    const timer = window.setTimeout(() => {
      authApi.captchaStatus(normalizedTenantSlug, normalizedUsername)
        .then(({ data }) => {
          if (cancelled) return
          const required = Boolean(data?.requires_captcha)
          setCachedCaptchaRequired(normalizedTenantSlug, required)
          if (required) {
            if (!captchaRequiredRef.current) {
              setCaptchaRequired(true)
              refreshCaptcha()
            }
          } else {
            setCaptchaRequired(false)
            setCaptchaInput('')
            setCaptchaSolved(false)
          }
        })
        .catch(() => {})
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [tenantSlug, username, isOtpStep])

  const completeAuthenticatedSession = (data: any, normalizedTenantSlug: string) => {
    const loginExpiryMinutes = Number(data.login_expiry_minutes)
    try {
      localStorage.setItem('last_tenant', normalizedTenantSlug)
    } catch {
      // Login should not fail just because the browser rejected storage.
    }
    login({
      user: {
        id: data.user_id, username: data.username,
        full_name: data.full_name, role: data.role,
        email: '', is_active: true,
      },
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      permissions: data.permissions || [],
      tenant_slug: normalizedTenantSlug,
      session_policy: Number.isFinite(loginExpiryMinutes) && loginExpiryMinutes > 0
        ? { login_expiry_minutes: loginExpiryMinutes }
        : null,
    })
    resetOtpStep()
    navigate('/dashboard', { replace: true })
  }

  const rejectForm = (errors: FieldErrors) => {
    setFieldErrors(errors)
    setShakeKey(k => k + 1)
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')
    setFieldErrors({})
    const normalizedTenantSlug = tenantSlug.trim().toLowerCase()
    const normalizedUsername = username.trim()

    if (isOtpStep) {
      if (!otpCode.trim()) { rejectForm({ otp: 'Enter the verification code' }); return }
      setLoading(true)
      try {
        const { data } = await authApi.verifyLoginOtp(
          normalizedTenantSlug,
          pendingOtp!.challengeId,
          otpCode.trim(),
        )
        completeAuthenticatedSession(data, normalizedTenantSlug)
      } catch (err: any) {
        setFormError(err.response?.data?.detail || 'Verification failed. Please try again.')
      } finally {
        setLoading(false)
      }
      return
    }

    const errors: FieldErrors = {}
    if (!normalizedTenantSlug) errors.organisation = 'Enter your organization'
    if (!normalizedUsername) errors.username = 'Enter your user name'
    if (!password) errors.password = 'Enter your password'
    if (Object.keys(errors).length) { rejectForm(errors); return }
    if (captchaRequired && !captchaSolved) { setFormError('Please solve the verification challenge.'); return }

    try {
      if (rememberMe) localStorage.setItem(REMEMBERED_LOGIN_KEY, JSON.stringify({ o: normalizedTenantSlug, u: normalizedUsername }))
      else localStorage.removeItem(REMEMBERED_LOGIN_KEY)
    } catch {}

    setLoading(true)
    try {
      const { data } = await authApi.login(
        normalizedTenantSlug,
        normalizedUsername,
        password,
        rememberMe,
        captchaRequired && captchaSolved ? 'verified' : undefined,
      )
      if (data.password_expired || data.must_change_password) {
        const resetToken = data.password_reset_token
        success(data.message || 'Your password has expired. Please reset or change your password to continue.')
        if (!resetToken) return
        navigate(
          `/reset-password?token=${encodeURIComponent(resetToken)}&reason=password-expired&tenant=${encodeURIComponent(normalizedTenantSlug)}`,
          { replace: true }
        )
        return
      }
      if (data.otp_required && data.otp_challenge_id) {
        setPendingOtp({
          challengeId: data.otp_challenge_id,
          deliveryTarget: data.otp_delivery_target || '',
          message: data.message || 'A verification code has been sent to your email address.',
          expiresInSeconds: Number(data.otp_expires_in_seconds || 0),
        })
        setOtpCode('')
        success(data.message || 'A verification code has been sent to your email address.')
        return
      }
      completeAuthenticatedSession(data, normalizedTenantSlug)
    } catch (err: any) {
      const detail: string = err.response?.data?.detail || 'Login failed. Check your credentials.'
      if (err.response?.status === 503 && detail.toLowerCase().includes('maintenance')) {
        navigate('/maintenance', { replace: true })
        return
      }
      setShakeKey(k => k + 1)
      if (detail.toLowerCase().includes('captcha')) {
        setCachedCaptchaRequired(normalizedTenantSlug, true)
        setCaptchaRequired(true)
        refreshCaptcha()
        setFormError('Too many failed attempts. Please solve the verification below.')
      } else {
        setFormError(detail)
        if (captchaRequired) {
          // Regenerate challenge after every failed attempt so the user gets a fresh question
          refreshCaptcha()
        } else if (username) {
          authApi.captchaStatus(normalizedTenantSlug, normalizedUsername)
            .then(({ data: s }) => {
              const required = Boolean(s?.requires_captcha)
              setCachedCaptchaRequired(normalizedTenantSlug, required)
              if (required) { setCaptchaRequired(true); refreshCaptcha() }
            })
            .catch(() => {})
        }
      }
    } finally {
      setLoading(false)
    }
  }

  const handleResendOtp = async () => {
    const normalizedTenantSlug = tenantSlug.trim().toLowerCase()
    if (!normalizedTenantSlug || !pendingOtp?.challengeId) return
    setResendingOtp(true)
    try {
      const { data } = await authApi.resendLoginOtp(normalizedTenantSlug, pendingOtp.challengeId)
      setPendingOtp({
        challengeId: data.otp_challenge_id || pendingOtp.challengeId,
        deliveryTarget: data.otp_delivery_target || pendingOtp.deliveryTarget,
        message: data.message || 'A new verification code has been sent to your email address.',
        expiresInSeconds: Number(data.otp_expires_in_seconds || pendingOtp.expiresInSeconds || 0),
      })
      setOtpCode('')
      success(data.message || 'A new verification code has been sent to your email address.')
    } catch (err: any) {
      setFormError(err.response?.data?.detail || 'Unable to resend the verification code.')
    } finally {
      setResendingOtp(false)
    }
  }

  const openContactAdministrator = () => {
    setContactOrg(tenantSlug)
    setContactUser(username)
    setContactError('')
    setContactSentMessage('')
    setContactOpen(true)
  }

  const handleContactAdministrator = async () => {
    const normalizedTenantSlug = contactOrg.trim().toLowerCase()
    const normalizedUsername = contactUser.trim()
    if (!normalizedTenantSlug || !normalizedUsername) {
      setContactError('Enter your organization and user name so we can reach your administrator')
      return
    }

    setContactError('')
    setContactingAdmin(true)
    try {
      const { data } = await authApi.contactAdministrator({
        tenant_slug: normalizedTenantSlug,
        username: normalizedUsername,
      })
      setContactSentMessage(data?.message || 'Your request has been sent to the administrator.')
    } catch (err: any) {
      setContactError(err.response?.data?.detail || 'Failed to contact the administrator.')
    } finally {
      setContactingAdmin(false)
    }
  }

  useEffect(() => {
    if (!contactOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContactOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [contactOpen])

  const goToForgotPassword = () => {
    const normalizedTenantSlug = tenantSlug.trim().toLowerCase()
    navigate(
      normalizedTenantSlug
        ? `/forgot-password?tenant=${encodeURIComponent(normalizedTenantSlug)}`
        : '/forgot-password'
    )
  }

  const clearFieldError = (field: keyof FieldErrors) => {
    if (fieldErrors[field]) setFieldErrors(prev => ({ ...prev, [field]: undefined }))
  }

  const submitDisabled = loading || (!isOtpStep && captchaRequired && !captchaSolved)

  return (
    <div className="azl-root">
      <style>{LOGIN_CSS}</style>
      <div className="azl-wrap">
        <HeroPanel />

        <main className="azl-side">
          <div className="azl-top">
            <span>New to Azcentrix Connect?</span>
            <button type="button" className="azl-lnk" onClick={openContactAdministrator}>Request access</button>
          </div>

          <form
            key={shakeKey}
            className={`azl-card${shakeKey ? ' azl-shake' : ''}`}
            onSubmit={handleLogin}
            noValidate
            autoComplete="on"
          >
            <h2>{isOtpStep ? 'Verify your sign-in' : 'Sign in to your workspace'}</h2>
            <p className="azl-sub">
              {isOtpStep
                ? `Enter the verification code sent to ${pendingOtp?.deliveryTarget || 'your email'}.`
                : 'Enter your organization and credentials to continue.'}
            </p>

            {formError && <div className="azl-alert" role="alert">{formError}</div>}

            <div className="azl-f">
              <label htmlFor="azl-org">Organization</label>
              <div className={`azl-box${fieldErrors.organisation ? ' err' : ''}`}>
                <OrgIcon />
                <input
                  id="azl-org"
                  value={tenantSlug}
                  onChange={e => { setTenantSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); clearFieldError('organisation') }}
                  placeholder="your-company"
                  autoComplete="organization"
                  spellCheck={false}
                  readOnly={isOtpStep}
                  autoFocus={!initialTenantSlug}
                />
              </div>
              <div className="azl-msg">{fieldErrors.organisation}</div>
            </div>

            <div className="azl-f">
              <label htmlFor="azl-un">User name</label>
              <div className={`azl-box${fieldErrors.username ? ' err' : ''}`}>
                <UserIcon />
                <input
                  id="azl-un"
                  value={username}
                  onChange={e => { setUsername(e.target.value); clearFieldError('username') }}
                  placeholder="User name or e-mail"
                  autoComplete="username"
                  spellCheck={false}
                  readOnly={isOtpStep}
                  autoFocus={Boolean(initialTenantSlug) && !username}
                />
              </div>
              <div className="azl-msg">{fieldErrors.username}</div>
            </div>

            {!isOtpStep && (
              <div className="azl-f">
                <label htmlFor="azl-pw">Password</label>
                <div className={`azl-box${fieldErrors.password ? ' err' : ''}`}>
                  <LockIcon />
                  <input
                    id="azl-pw"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => { setPassword(e.target.value); clearFieldError('password') }}
                    onKeyUp={e => setCapsLockOn(e.getModifierState?.('CapsLock') ?? false)}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    autoFocus={Boolean(initialTenantSlug && username)}
                  />
                  <button
                    type="button"
                    className="azl-eye"
                    onClick={() => setShowPassword(v => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? 'HIDE' : 'SHOW'}
                  </button>
                </div>
                <div className="azl-msg">{fieldErrors.password || (capsLockOn ? '⚠ Caps Lock is on' : '')}</div>
              </div>
            )}

            {isOtpStep && (
              <div className="azl-f">
                <label htmlFor="azl-otp">Verification code</label>
                <div className={`azl-box${fieldErrors.otp ? ' err' : ''}`}>
                  <LockIcon />
                  <input
                    id="azl-otp"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={otpCode}
                    onChange={e => { setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6)); clearFieldError('otp') }}
                    placeholder="Enter 6-digit code"
                    autoComplete="one-time-code"
                    style={{ letterSpacing: '0.22em' }}
                    autoFocus
                  />
                </div>
                <div className="azl-msg">{fieldErrors.otp}</div>
              </div>
            )}

            {!isOtpStep && captchaRequired && (
              <div className="azl-captcha">
                <div className="azl-captcha-head">
                  <ShieldCheck size={18} />
                  <div>
                    <b>Verification required</b>
                    <span>Complete this quick check to continue signing in.</span>
                  </div>
                </div>
                <div className="azl-captcha-row">
                  <div className="azl-captcha-q">{captcha.question} = ?</div>
                  <button type="button" className="azl-captcha-refresh" onClick={refreshCaptcha} title="New challenge" aria-label="New challenge">
                    <RefreshCw size={14} />
                  </button>
                </div>
                <div className={`azl-box${captchaInput && !captchaSolved ? ' err' : ''}`} style={{ marginTop: 8 }}>
                  <input
                    type="number"
                    value={captchaInput}
                    onChange={e => handleCaptchaInput(e.target.value)}
                    placeholder="Your answer"
                    aria-label="Verification answer"
                  />
                </div>
                {captchaSolved && (
                  <p className="azl-captcha-ok"><CheckCircle2 size={13} /> Verification passed</p>
                )}
              </div>
            )}

            {!isOtpStep ? (
              <div className="azl-row">
                <label className="azl-chk">
                  <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} />
                  <i />
                  Remember me
                </label>
                {forgotPasswordEnabled && (
                  <button type="button" className="azl-lnk" onClick={goToForgotPassword}>Forgot password?</button>
                )}
              </div>
            ) : (
              <div className="azl-row">
                <button type="button" className="azl-lnk azl-lnk-muted" onClick={() => resetOtpStep(true)}>
                  Use different credentials
                </button>
                <button type="button" className="azl-lnk" onClick={handleResendOtp} disabled={resendingOtp || loading}>
                  {resendingOtp ? 'Resending…' : 'Resend code'}
                </button>
              </div>
            )}

            <button className={`azl-go${loading ? ' ld' : ''}`} type="submit" disabled={submitDisabled}>
              <span className="azl-spin" />
              <span>
                {loading
                  ? (isOtpStep ? 'Verifying…' : 'Signing in…')
                  : (isOtpStep ? 'Verify code' : 'Sign in')}
              </span>
            </button>

            <div className="azl-help">
              Trouble signing in?{' '}
              <button type="button" className="azl-lnk" onClick={openContactAdministrator}>Contact administrator</button>
            </div>
          </form>

          <div className="azl-legal">
            <span>© {new Date().getFullYear()} Azcentrix Connect</span>
            <span>Powered by Azcentrix</span>
          </div>
        </main>
      </div>

      {contactOpen && (
        <div className="azl-ov" onMouseDown={e => { if (e.target === e.currentTarget) setContactOpen(false) }}>
          <div className="azl-md" role="dialog" aria-modal="true" aria-labelledby="azl-ca-title">
            {contactSentMessage ? (
              <div className="azl-fin">
                <div className="azl-tk">✓</div>
                <h3>Message sent</h3>
                <p>{contactSentMessage}</p>
                <div className="azl-acts" style={{ justifyContent: 'center' }}>
                  <button type="button" className="azl-btn2 p" onClick={() => setContactOpen(false)}>Close</button>
                </div>
              </div>
            ) : (
              <>
                <h3 id="azl-ca-title">Contact administrator</h3>
                <p>Your organization administrator will get this message and respond by e-mail.</p>
                <div className="azl-f">
                  <label htmlFor="azl-ca-org">Organization</label>
                  <div className="azl-box">
                    <input
                      id="azl-ca-org"
                      value={contactOrg}
                      onChange={e => setContactOrg(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                      placeholder="your-company"
                      autoFocus={!contactOrg}
                    />
                  </div>
                </div>
                <div className="azl-f">
                  <label htmlFor="azl-ca-user">Your user name</label>
                  <div className="azl-box">
                    <input
                      id="azl-ca-user"
                      value={contactUser}
                      onChange={e => setContactUser(e.target.value)}
                      placeholder="User name"
                      autoFocus={Boolean(contactOrg)}
                    />
                  </div>
                  <div className="azl-msg">{contactError}</div>
                </div>
                <div className="azl-acts">
                  <button type="button" className="azl-btn2" onClick={() => setContactOpen(false)}>Cancel</button>
                  <button type="button" className="azl-btn2 p" onClick={handleContactAdministrator} disabled={contactingAdmin}>
                    {contactingAdmin ? 'Sending…' : 'Send message'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Styles ported from the azcentrix-login-application-v4 prototype. Every class
// is prefixed with "azl-" so nothing collides with the app's global/Tailwind CSS.
const LOGIN_CSS = `
.azl-root{--ink:#0E1B24;--mu:#5B6B78;--ln:#D8DFE5;--bg:#EEF1F4;--ac:#0F6E8C;--ac2:#0A4C61;--amb:#F2A900;--ok:#1B8559;--ba:#C13B2A;--hd:Bahnschrift,"DIN Alternate","Segoe UI Semibold","Segoe UI",system-ui,sans-serif;--tx:"Segoe UI","SF Pro Text",system-ui,-apple-system,Roboto,Arial,sans-serif;
  position:fixed;inset:0;overflow-y:auto;font:14px/1.45 var(--tx);color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
.azl-root *{box-sizing:border-box}
:where(.azl-root) :where(button,input,select,textarea){font:inherit;color:inherit}
:where(.azl-root) :where(h1,h2,h3,p){margin:0}
.azl-wrap{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(420px,.88fr);min-height:100%}
.azl-hero{position:relative;overflow:hidden;color:#DDEBF1;background:linear-gradient(160deg,#08303D 0%,#0A4C61 55%,#0F6E8C 130%);padding:44px 56px;display:flex;flex-direction:column}
.azl-hero::before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.06) 1px,transparent 1px);background-size:40px 40px;-webkit-mask-image:linear-gradient(180deg,#000 0%,transparent 85%);mask-image:linear-gradient(180deg,#000 0%,transparent 85%)}
.azl-hero::after{content:"";position:absolute;left:0;right:0;top:0;height:8px;background:repeating-linear-gradient(-45deg,var(--amb) 0 14px,#0E1B24 14px 28px)}
.azl-hero>*{position:relative;z-index:1}
.azl-brand{display:inline-flex;align-items:center;gap:12px;align-self:flex-start;margin-top:8px}
.azl-mark{width:40px;height:40px;flex:none;border-radius:10px;background:#fff;display:grid;place-items:center;box-shadow:0 6px 18px rgba(0,0,0,.3)}
.azl-brand-icon{width:28px;height:auto;object-fit:contain}
.azl-brand-name{font:700 22px/1 var(--tx);letter-spacing:-.01em;color:#fff;white-space:nowrap}
.azl-brand-name em{font-style:normal;font-weight:900;color:#2563eb;background:linear-gradient(90deg,#ff00b8 0%,#8b1dff 52%,#2563eb 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.azl-hero h1{font:700 40px/1.06 var(--hd);color:#fff;letter-spacing:-.005em;margin-top:auto;max-width:540px}
.azl-hero h1 em{font-style:normal;color:var(--amb)}
.azl-hero>p{margin:14px 0 26px;max-width:480px;color:#B4D3DE;font-size:15px}
.azl-flows{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.azl-flows button{border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);color:#B4D3DE;border-radius:20px;padding:6px 14px;font:600 12px var(--tx);cursor:pointer;transition:.2s}
.azl-flows button:hover{background:rgba(255,255,255,.12)}
.azl-flows button.on{background:#fff;color:#08303D;border-color:#fff}
.azl-pipe{display:flex;margin-bottom:22px;max-width:660px}
.azl-stg{flex:1;position:relative;height:46px;background:rgba(255,255,255,.08);color:#B4D3DE;font:600 11.5px var(--hd);letter-spacing:.05em;text-transform:uppercase;display:flex;align-items:center;padding:0 8px 0 22px;clip-path:polygon(0 0,calc(100% - 14px) 0,100% 50%,calc(100% - 14px) 100%,0 100%,14px 50%);margin-left:-8px;transition:background .5s,color .5s;white-space:nowrap}
.azl-stg:first-child{margin-left:0;clip-path:polygon(0 0,calc(100% - 14px) 0,100% 50%,calc(100% - 14px) 100%,0 100%);padding-left:14px}
.azl-stg.on{background:var(--amb);color:#0E1B24}
.azl-stg.fin{background:rgba(255,255,255,.2);color:#fff}
.azl-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;max-width:660px}
.azl-tile{background:rgba(6,30,40,.55);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:14px 16px;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.azl-tile label{display:block;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:#8FC3D3}
.azl-tile b{display:block;font:700 28px var(--hd);color:#fff;margin-top:2px}
.azl-tile i{font-style:normal;font-size:12px;color:#7FE0B5}
.azl-mq{overflow:hidden;white-space:nowrap;max-width:660px;margin-top:24px;-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);font-size:12px;color:#8FC3D3}
.azl-mq div{display:inline-block;padding-left:100%;animation:azl-mq 60s linear infinite}
.azl-mq span{margin:0 14px}
.azl-mq span::before{content:"◆";color:var(--amb);margin-right:10px;font-size:8px}
@keyframes azl-mq{to{transform:translateX(-100%)}}
.azl-hfoot{margin-top:20px;display:flex;gap:22px;font-size:12px;color:#8FC3D3;flex-wrap:wrap}
.azl-hfoot span::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:#7FE0B5;margin-right:7px;box-shadow:0 0 0 3px rgba(127,224,181,.2)}
.azl-side{display:flex;flex-direction:column;padding:40px 56px 24px;background:#fff;border-left:1px solid var(--ln)}
.azl-top{display:flex;justify-content:flex-end;align-items:center;font-size:12.5px;color:var(--mu);gap:14px}
.azl-card{width:min(400px,100%);margin:auto}
.azl-card h2{font:700 29px/1.15 var(--hd);letter-spacing:-.005em}
.azl-sub{color:var(--mu);margin:6px 0 24px}
.azl-f{margin-bottom:16px}
.azl-f label{display:block;font:600 11px var(--hd);letter-spacing:.1em;text-transform:uppercase;color:#3A4955;margin-bottom:6px}
.azl-box{display:flex;align-items:center;border:1.5px solid var(--ln);border-radius:10px;background:#F8FAFB;height:46px;transition:border-color .15s,box-shadow .15s,background .15s}
.azl-box:focus-within{border-color:var(--ac);background:#fff;box-shadow:0 0 0 4px rgba(15,110,140,.14)}
.azl-box.err{border-color:var(--ba);box-shadow:0 0 0 4px rgba(193,59,42,.12)}
.azl-box svg{flex:none;width:18px;height:18px;margin-left:13px;color:#8A99A5;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.azl-box input{flex:1;min-width:0;border:0;background:none;outline:0;padding:0 12px;height:100%;font-size:14.5px}
.azl-box input[readonly]{color:var(--mu)}
.azl-eye{border:0;background:none;cursor:pointer;color:#6B7B87;padding:0 13px;height:100%;font-size:12px;font-weight:600}
.azl-eye:hover{color:var(--ac)}
.azl-msg{min-height:18px;margin-top:5px;font-size:12px;color:var(--ba)}
.azl-row{display:flex;align-items:center;justify-content:space-between;margin:2px 0 20px}
.azl-chk{display:flex;align-items:center;gap:9px;cursor:pointer;user-select:none;color:#33424E;position:relative}
.azl-chk input{position:absolute;opacity:0;width:1px;height:1px}
.azl-chk i{width:19px;height:19px;border-radius:5px;border:1.5px solid #9AAAB6;display:grid;place-items:center;transition:.15s;background:#fff}
.azl-chk input:checked+i{background:var(--ac);border-color:var(--ac)}
.azl-chk input:checked+i::after{content:"";width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg) translate(-1px,-1px)}
.azl-chk input:focus-visible+i{box-shadow:0 0 0 4px rgba(15,110,140,.25)}
.azl-lnk{background:none;border:0;color:var(--ac);font-weight:600;cursor:pointer;padding:0}
.azl-lnk:hover{text-decoration:underline}
.azl-lnk:disabled{opacity:.6;cursor:not-allowed;text-decoration:none}
.azl-lnk-muted{color:var(--mu)}
.azl-go{width:100%;height:48px;border:0;border-radius:10px;cursor:pointer;color:#fff;font:700 15px var(--hd);letter-spacing:.07em;text-transform:uppercase;background:linear-gradient(180deg,#128AAE,var(--ac2));box-shadow:0 8px 20px rgba(10,76,97,.3),inset 0 1px 0 rgba(255,255,255,.25);transition:transform .12s,box-shadow .12s;display:flex;align-items:center;justify-content:center;gap:10px}
.azl-go:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 12px 26px rgba(10,76,97,.38)}
.azl-go:active{transform:none}
.azl-go:disabled{opacity:.75;cursor:not-allowed}
.azl-go.ld{cursor:progress}
.azl-spin{width:17px;height:17px;border:2.5px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:azl-sp .7s linear infinite;display:none}
.azl-go.ld .azl-spin{display:block}
@keyframes azl-sp{to{transform:rotate(360deg)}}
.azl-alert{background:#FCEDEA;border:1px solid #F0C3BB;color:#8D2A1D;border-radius:10px;padding:10px 12px;margin-bottom:16px;font-size:13px}
.azl-shake{animation:azl-sh .35s}
@keyframes azl-sh{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
.azl-captcha{border:1.5px solid var(--ln);border-radius:10px;padding:12px;margin-bottom:16px;background:#F8FAFB}
.azl-captcha-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;color:var(--ac)}
.azl-captcha-head b{display:block;font:600 12.5px var(--hd);letter-spacing:.04em;color:var(--ink)}
.azl-captcha-head span{display:block;font-size:12px;color:var(--mu)}
.azl-captcha-row{display:grid;grid-template-columns:1fr 46px;gap:8px}
.azl-captcha-q{height:46px;border-radius:10px;background:#E6EDF1;color:#26343F;display:grid;place-items:center;font:700 18px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.06em;user-select:none}
.azl-captcha-refresh{height:46px;border:1.5px solid var(--ln);border-radius:10px;background:#fff;color:var(--ac);display:grid;place-items:center;cursor:pointer}
.azl-captcha-refresh:hover{border-color:var(--ac)}
.azl-captcha .azl-box input{padding:0 12px}
.azl-captcha-ok{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;font-weight:600;color:var(--ok)}
.azl-help{margin-top:22px;text-align:center;color:var(--mu);font-size:13px}
.azl-legal{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:11.5px;color:#7B8A96;padding-top:16px}
.azl-ov{position:fixed;inset:0;background:rgba(8,28,37,.55);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);display:grid;place-items:center;z-index:50;padding:16px}
.azl-md{background:#fff;border-radius:16px;width:min(440px,100%);padding:26px;box-shadow:0 30px 70px rgba(0,0,0,.35);animation:azl-pop .2s ease}
@keyframes azl-pop{from{transform:translateY(10px);opacity:0}}
.azl-md h3{font:700 21px var(--hd);margin-bottom:4px}
.azl-md p{color:var(--mu);margin-bottom:16px}
.azl-acts{display:flex;gap:10px;justify-content:flex-end;margin-top:6px}
.azl-btn2{height:42px;padding:0 18px;border-radius:9px;border:1.5px solid var(--ln);background:#fff;font-weight:600;cursor:pointer}
.azl-btn2.p{background:var(--ac);border-color:var(--ac);color:#fff}
.azl-btn2:hover{filter:brightness(.97)}
.azl-btn2:disabled{opacity:.7;cursor:progress}
.azl-fin{text-align:center;padding:8px 0}
.azl-tk{width:56px;height:56px;border-radius:50%;background:#E3F5EC;color:var(--ok);display:grid;place-items:center;margin:0 auto 12px;font-size:28px}
@media(max-width:1180px) and (min-width:901px){.azl-hero{padding:40px 36px}.azl-side{padding:36px 36px 24px}.azl-hero h1{font-size:34px}.azl-tile b{font-size:24px}}
@media(max-width:900px){.azl-wrap{grid-template-columns:1fr}.azl-hero{display:none}.azl-side{padding:28px 22px;border-left:0;min-height:100%}.azl-card{margin:28px auto}}
@media(max-width:420px){.azl-card h2{font-size:25px}.azl-top{flex-wrap:wrap;justify-content:center}}
@media(min-width:901px){.azl-wrap{height:100%;min-height:660px}.azl-side{overflow:auto}}
@media(prefers-reduced-motion:reduce){.azl-root *{animation:none!important;transition:none!important}}
`
