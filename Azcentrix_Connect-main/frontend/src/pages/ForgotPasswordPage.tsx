import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, Hash, Loader2, Mail } from 'lucide-react'
import { useAuthStore } from '@/store'
import { isTokenExpired } from '@/utils/auth'
import api, { authApi } from '@/services/api'
import { platformApi } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import leftlogo from '../assets/azcentrix-mark.svg'
import bg1_plain from '../assets/bg1_plain.jpg'

type ThemeColors = {
  theme_primary?: string
  theme_secondary?: string
  theme_accent?: string
}

const DEFAULT_THEME_COLORS: ThemeColors = {
  theme_primary: '',
  theme_secondary: '',
  theme_accent: '',
}

// Converts a '#rrggbb' hex color to an 'rgba(r,g,b,a)' string — used so the
// tenant's theme color (fetched as a hex string) can drive the same
// translucent shadows/rings/focus-glows that were previously hardcoded rgba().
function hexToRgba(hex: string, alpha: number): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim())
  if (!match) return `rgba(124,58,237,${alpha})`
  const r = parseInt(match[1], 16)
  const g = parseInt(match[2], 16)
  const b = parseInt(match[3], 16)
  return `rgba(${r},${g},${b},${alpha})`
}

// Mixes a hex color toward white by `amount` (0-1) — some tenants set a very
// dark theme_primary (it doubles as e.g. the sign-in button color), which is
// fine on a white background but nearly invisible for decorative accents
// drawn on the illustration's own dark panel. Lightening keeps the brand hue
// recognizable while guaranteeing contrast there.
function lightenHex(hex: string, amount: number): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim())
  if (!match) return hex
  const mix = (c: number) => Math.round(c + (255 - c) * amount)
  const r = mix(parseInt(match[1], 16))
  const g = mix(parseInt(match[2], 16))
  const b = mix(parseInt(match[3], 16))
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

const RESET_LIMIT_EXCEEDED_MESSAGE =
  'Password reset is allowed only within the configured limit. Please contact your administrator for further access.'

const ds = (delay: number, dur = 0.6) => ({
  strokeDasharray: 1,
  strokeDashoffset: 1,
  animation: `drawStroke ${dur}s ease forwards`,
  animationDelay: `${delay}s`,
})

const fi = (delay: number, dur = 0.3) => ({
  opacity: 0,
  animation: `fadeIn ${dur}s ease forwards`,
  animationDelay: `${delay}s`,
})

// Colored from the tenant's own brand palette instead of a fixed
// violet/lavender/amber set, so this illustration never clashes with the
// tenant's actual theme color.
function IllustrationHelp({ primary, secondary, accent }: { primary: string; secondary: string; accent: string }) {
  return (
    <svg viewBox="0 0 300 175" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full">
      <ellipse cx="150" cy="90" rx="118" ry="62" fill={hexToRgba(accent, 0.06)} style={fi(0, 0.6)} />
      <rect x="14" y="16" width="122" height="68" rx="12"
            fill="rgba(255,255,255,0.04)" stroke={hexToRgba(primary, 0.45)} strokeWidth="1.5"
            pathLength={1} style={ds(0, 0.52)} />
      <rect x="24" y="28" width="30" height="30" rx="7" fill={hexToRgba(primary, 0.18)} style={fi(0.32)} />
      <rect x="28" y="32" width="10" height="10" rx="2.5" fill={hexToRgba(primary, 0.8)} style={fi(0.38)} />
      <rect x="41" y="32" width="10" height="10" rx="2.5" fill={hexToRgba(primary, 0.45)} style={fi(0.42)} />
      <rect x="28" y="45" width="10" height="10" rx="2.5" fill={hexToRgba(primary, 0.45)} style={fi(0.42)} />
      <rect x="41" y="45" width="10" height="10" rx="2.5" fill={hexToRgba(primary, 0.25)} style={fi(0.46)} />
      <rect x="60" y="29" width="66" height="7" rx="3.5" fill="rgba(255,255,255,0.4)" style={fi(0.36)} />
      <rect x="60" y="42" width="50" height="5" rx="2.5" fill="rgba(255,255,255,0.22)" style={fi(0.42)} />
      <rect x="60" y="52" width="56" height="5" rx="2.5" fill="rgba(255,255,255,0.15)" style={fi(0.47)} />
      <rect x="60" y="62" width="40" height="5" rx="2.5" fill="rgba(255,255,255,0.1)" style={fi(0.52)} />
      <rect x="164" y="16" width="122" height="68" rx="12"
            fill="rgba(255,255,255,0.04)" stroke={hexToRgba(secondary, 0.45)} strokeWidth="1.5"
            pathLength={1} style={ds(0.26, 0.52)} />
      <rect x="174" y="38" width="30" height="24" rx="7" fill={hexToRgba(secondary, 0.28)} style={fi(0.56)} />
      <path d="M180 38 L180 29 Q180 22 189 22 Q198 22 198 29 L198 38"
            stroke={hexToRgba(secondary, 0.75)} strokeWidth="3" strokeLinecap="round"
            pathLength={1} style={ds(0.62, 0.42)} />
      <circle cx="189" cy="52" r="5.5" fill="rgba(255,255,255,0.55)" style={fi(0.8)} />
      <rect x="186.5" y="52" width="5" height="8" rx="2" fill="rgba(255,255,255,0.55)" style={fi(0.82)} />
      <rect x="210" y="29" width="66" height="7" rx="3.5" fill="rgba(255,255,255,0.4)" style={fi(0.62)} />
      <rect x="210" y="42" width="50" height="5" rx="2.5" fill="rgba(255,255,255,0.22)" style={fi(0.67)} />
      <rect x="210" y="52" width="56" height="5" rx="2.5" fill="rgba(255,255,255,0.15)" style={fi(0.72)} />
      <rect x="210" y="62" width="40" height="5" rx="2.5" fill="rgba(255,255,255,0.1)" style={fi(0.77)} />
      <rect x="89" y="100" width="122" height="68" rx="12"
            fill="rgba(255,255,255,0.04)" stroke={hexToRgba(accent, 0.45)} strokeWidth="1.5"
            pathLength={1} style={ds(0.52, 0.52)} />
      <circle cx="115" cy="122" r="12" fill={hexToRgba(accent, 0.2)} style={fi(0.82)} />
      <circle cx="115" cy="118" r="5.5" fill={hexToRgba(accent, 0.7)} style={fi(0.88)} />
      <path d="M104 133 Q104 124 115 124 Q126 124 126 133" fill={hexToRgba(accent, 0.42)} style={fi(0.92)} />
      <rect x="134" y="109" width="66" height="7" rx="3.5" fill="rgba(255,255,255,0.4)" style={fi(0.84)} />
      <rect x="134" y="122" width="50" height="5" rx="2.5" fill="rgba(255,255,255,0.22)" style={fi(0.89)} />
      <rect x="134" y="132" width="56" height="5" rx="2.5" fill="rgba(255,255,255,0.15)" style={fi(0.94)} />
      <rect x="134" y="142" width="40" height="5" rx="2.5" fill="rgba(255,255,255,0.1)" style={fi(0.99)} />
      <path d="M75 50 Q75 74 118 100" stroke="rgba(255,255,255,0.14)" strokeWidth="1.5" strokeDasharray="4 3"
            style={fi(0.88, 0.5)} />
      <path d="M225 50 Q225 74 182 100" stroke="rgba(255,255,255,0.14)" strokeWidth="1.5" strokeDasharray="4 3"
            style={fi(0.88, 0.5)} />
    </svg>
  )
}

export default function ForgotPasswordPage({ platform = false }: { platform?: boolean }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, access_token } = useAuthStore()
  const { success, error: showError } = useToast()
  const hasLegacyResetToken = !platform && new URLSearchParams(location.search).has('token')
  const platformResetToken = platform
    ? (new URLSearchParams(location.search).get('platform_reset_token')
      || new URLSearchParams(location.search).get('token')
      || '').trim()
    : ''
  const forgotPasswordTenantSlug = (
    new URLSearchParams(location.search).get('tenant')
    || localStorage.getItem('tenant_slug')
    || localStorage.getItem('last_tenant')
    || ''
  ).trim().toLowerCase()

  const [email, setEmail] = useState('')
  const [employeeCode, setEmployeeCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [emailError, setEmailError] = useState('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [successMessage, setSuccessMessage] = useState('')
  const [contactingAdmin, setContactingAdmin] = useState(false)
  const [showContactAdministrator, setShowContactAdministrator] = useState(false)
  const [themeColors, setThemeColors] = useState<ThemeColors>(DEFAULT_THEME_COLORS)

  useEffect(() => {
    if (hasLegacyResetToken) {
      navigate(`/reset-password${location.search}`, { replace: true })
    }
  }, [hasLegacyResetToken, location.search, navigate])

  // Tenant brand colors (same source as the sidebar/header's theme) — fall
  // back to this page's original purple palette until they're fetched, or
  // if the tenant has no theme customization. Decorative only, so a failed
  // fetch or missing slug just keeps the fallback purple.
  useEffect(() => {
    if (!forgotPasswordTenantSlug) return

    let isActive = true
    ;(async () => {
      try {
        const { data } = await api.get('/settings/theme', {
          headers: { 'X-Tenant-Slug': forgotPasswordTenantSlug },
        })
        if (!isActive) return
        setThemeColors({
          theme_primary: data?.theme_primary || data?.primary_color || '',
          theme_secondary: data?.theme_secondary || data?.secondary_color || '',
          theme_accent: data?.theme_accent || data?.accent_color || '',
        })
      } catch {
        // Decorative only — keep the fallback purple palette.
      }
    })()

    return () => {
      isActive = false
    }
  }, [forgotPasswordTenantSlug])

  useEffect(() => {
    if (!platform && !hasLegacyResetToken && user && access_token && !isTokenExpired(access_token)) {
      navigate('/dashboard', { replace: true })
    }
  }, [access_token, hasLegacyResetToken, navigate, platform, user])

  const validateEmail = (value: string) => {
    if (!value.trim()) return 'Email is required'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter a valid email'
    return ''
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (platformResetToken) {
      setFormError('')
      if (!newPassword || !confirmPassword) {
        setFormError('Enter and confirm your new password')
        return
      }
      if (newPassword !== confirmPassword) {
        setFormError('Passwords must match')
        return
      }
      setSubmitting(true)
      try {
        const { data } = await platformApi.resetPassword(platformResetToken, newPassword, confirmPassword)
        setSubmitted(true)
        setSuccessMessage(data?.message || 'Your Platform password has been reset. You can now sign in.')
        success('Password reset', data?.message || 'Your Platform password has been reset. You can now sign in.')
      } catch (err: any) {
        const detail = err?.response?.data?.detail || 'Failed to reset Platform password'
        setFormError(detail)
        showError(detail)
      } finally {
        setSubmitting(false)
      }
      return
    }

    const normalizedEmail = email.trim()
    const error = validateEmail(normalizedEmail)
    setEmailError(error)
    setFormError('')
    setShowContactAdministrator(false)
    if (error) return

    setSubmitting(true)
    try {
      const normalizedCode = employeeCode.trim() || undefined
      const { data } = platform
        ? await platformApi.forgotPassword(normalizedEmail)
        : await authApi.forgotPassword(normalizedEmail, forgotPasswordTenantSlug || undefined, normalizedCode)
      setEmail(normalizedEmail)
      setSubmitted(true)
      setSuccessMessage(data?.message || 'If an account exists for this email, a reset link has been sent.')
      success('Request received', data?.message || 'If an account exists for this email, a reset link has been sent.')
    } catch (err: any) {
      const detail = err?.response?.data?.detail || 'Failed to send reset link'
      setFormError(detail)
      setSuccessMessage('')
      setShowContactAdministrator(detail === RESET_LIMIT_EXCEEDED_MESSAGE)
      showError(detail)
    } finally {
      setSubmitting(false)
    }
  }

  const themePrimary = themeColors.theme_primary || '#7c3aed'
  const themeSecondary = themeColors.theme_secondary || '#4f46e5'
  const themeAccent = themeColors.theme_accent || '#818cf8'

  const handleContactAdministrator = async () => {
    const normalizedEmail = email.trim()
    const validationError = validateEmail(normalizedEmail)
    setEmailError(validationError)
    if (validationError) return

    setContactingAdmin(true)
    try {
      const { data } = await authApi.contactAdministrator({ email: normalizedEmail })
      setShowContactAdministrator(false)
      success('Request sent', data?.message || 'Your request has been sent to the administrator.')
    } catch (err: any) {
      const detail = err?.response?.data?.detail || 'Failed to contact the administrator'
      setFormError(detail)
      showError(detail)
    } finally {
      setContactingAdmin(false)
    }
  }

  return (
    <>
      <style>{`
        @keyframes drawStroke { to { stroke-dashoffset: 0; } }
        @keyframes fadeIn     { to { opacity: 1; } }

        @keyframes shimmer-btn {
          0%   { background-position: -220% center; }
          100% { background-position: 220% center;  }
        }

        @keyframes spin-ring {
          from { transform: rotate(0deg);   }
          to   { transform: rotate(360deg); }
        }

        @keyframes card-in {
          from { opacity: 0; transform: translateY(28px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0)    scale(1);    }
        }

        .lp-btn {
          position: relative; overflow: hidden;
          background: linear-gradient(135deg, ${themePrimary} 0%, ${themeSecondary} 100%);
          transition: box-shadow 0.25s ease, transform 0.2s ease;
        }
        .lp-btn::before {
          content: '';
          position: absolute; inset: 0;
          background: linear-gradient(90deg,
            transparent 0%, rgba(255,255,255,0.18) 50%, transparent 100%);
          background-size: 220% 100%;
          animation: shimmer-btn 2.8s ease-in-out infinite;
          border-radius: inherit;
          pointer-events: none;
        }
        .lp-btn:not(:disabled):hover {
          box-shadow: 0 8px 32px ${hexToRgba(themePrimary, 0.55)};
          transform: translateY(-2px);
        }
        .lp-btn:not(:disabled):active {
          transform: translateY(0);
        }
        .lp-btn:disabled {
          cursor: not-allowed;
          opacity: 0.8;
        }

        .lp-input {
          width: 100%; height: 46px;
          padding: 0 14px 0 42px;
          background: #f5f6ff;
          border: 1.5px solid #e4e6f5;
          border-radius: 12px;
          font-size: 13.5px; color: #1e1b4b;
          outline: none;
          transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
          caret-color: ${themePrimary};
        }
        .lp-input::placeholder { color: #b0b8d0; }
        .lp-input:focus {
          background: #ffffff;
          border-color: ${themePrimary};
          box-shadow: 0 0 0 4px ${hexToRgba(themePrimary, 0.10)};
        }

        .lp-card { animation: card-in 0.55s cubic-bezier(0.22,1,0.36,1) both; }

        .lp-decorative-ring {
          animation: spin-ring 20s linear infinite;
        }
      `}</style>

      <div style={{
        minHeight: '100vh',
        backgroundImage: `url(${bg1_plain})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '24px',
        position: 'relative', overflow: 'hidden',
      }}>
        <div className="lp-card" style={{
          position: 'relative', zIndex: 1,
          width: '100%', maxWidth: 1080,
          display: 'flex', borderRadius: 24,
          overflow: 'hidden',
          boxShadow: [
            '0 48px 130px rgba(218, 218, 218, 0.85)',
            '0 0 0 1px rgba(228, 228, 228, 0.07)',
            '0 0 100px rgba(235, 235, 235, 0.18)',
          ].join(', '),
        }}>
          <div className="hidden lg:flex flex-col" style={{
            width: '56%',
            background: `linear-gradient(158deg, ${themeAccent} 0%, ${themeSecondary} 38%, ${themePrimary} 70%, #09081e 100%)`,
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none',
              backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.065) 1px, transparent 1px)',
              backgroundSize: '30px 30px',
            }} />

            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none',
              background: `radial-gradient(ellipse at 28% 52%, ${hexToRgba(themePrimary, 0.22)} 0%, transparent 62%)`,
            }} />

            <div style={{
              position: 'absolute', top: -60, right: -60,
              width: 240, height: 240, pointerEvents: 'none',
            }}>
              <svg viewBox="0 0 240 240" fill="none" style={{ width: '100%', height: '100%' }}>
                <circle cx="120" cy="120" r="100" stroke={hexToRgba(themeAccent, 0.08)} strokeWidth="1" />
                <circle cx="120" cy="120" r="75" stroke={hexToRgba(themeAccent, 0.06)} strokeWidth="1" />
                <circle cx="120" cy="120" r="50" stroke={hexToRgba(themeAccent, 0.1)} strokeWidth="1.5" />
                <circle cx="120" cy="120" r="12" fill={hexToRgba(themePrimary, 0.25)} />
                <circle cx="120" cy="120" r="5" fill={hexToRgba(themeAccent, 0.6)} />
                <circle cx="195" cy="120" r="4" fill={hexToRgba(themeAccent, 0.5)} className="lp-decorative-ring"
                  style={{ transformOrigin: '120px 120px' }} />
              </svg>
            </div>

            <div style={{
              position: 'absolute', bottom: 80, left: -20, pointerEvents: 'none',
              opacity: 0.4,
            }}>
              <svg viewBox="0 0 120 120" fill="none" width="120" height="120">
                {[0, 1, 2, 3, 4].map(row =>
                  [0, 1, 2, 3, 4].map(col => (
                    <circle
                      key={`${row}-${col}`}
                      cx={col * 22 + (row % 2) * 11}
                      cy={row * 19}
                      r="2"
                      fill={hexToRgba(themeAccent, 0.45)}
                    />
                  ))
                )}
              </svg>
            </div>

            <div style={{
              position: 'relative', zIndex: 10,
              flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center',
              padding: '20px 40px 12px',
            }}>
              <div>
                <div style={{ marginBottom: 22 }}>
                  {/* Tenant colors didn't read well here across tenants — kept neutral white instead. */}
                  <IllustrationHelp primary="#ffffff" secondary="#ffffff" accent="#ffffff" />
                </div>

                <p style={{
                  fontSize: 10, fontWeight: 800, letterSpacing: '0.22em',
                  textTransform: 'uppercase', color: themeAccent, marginBottom: 8,
                }}>
                  {platform ? 'Platform Account Recovery' : 'Account Recovery'}
                </p>

                <h2 style={{
                  fontSize: 25, fontWeight: 800, color: '#f1f5f9',
                  marginBottom: 18, lineHeight: 1.22, letterSpacing: '-0.025em',
                }}>
                  {platform ? 'Reset Platform access securely' : 'Reset access securely'}
                </h2>

                <ul style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {(platform
                    ? [
                      'Enter the email address registered to your Platform Super Admin account',
                      'We will send a secure reset link to that registered email address',
                      'Open the link to set a new Platform password',
                    ]
                    : [
                      'Enter the email address linked to your account',
                      'If multiple accounts share the same email, add your employee code to identify yourself',
                      'We will send a secure reset link — use it to choose a new password',
                    ]
                  ).map((step, i) => (
                    <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
                      <span style={{
                        width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                        background: hexToRgba(themeAccent, 0.12),
                        border: `1px solid ${hexToRgba(themeAccent, 0.28)}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 800, color: themeAccent,
                      }}>{i + 1}</span>
                      <span style={{ fontSize: 13, color: 'rgba(241,245,249,0.62)', lineHeight: 1.65 }}>
                        {step}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div style={{ position: 'relative', zIndex: 10, padding: '0 40px 34px' }}>
              <div style={{
                width: '100%', height: 1,
                background: `linear-gradient(90deg, ${hexToRgba(themeAccent, 0.25)} 0%, transparent 100%)`,
                marginBottom: 18,
              }} />
            </div>
          </div>

          <div style={{
            flex: 1,
            background: '#ffffff',
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            padding: '52px 48px',
            position: 'relative',
          }}>
            <div style={{
              position: 'absolute', left: 0, top: '15%', bottom: '15%',
              width: 3, borderRadius: '0 3px 3px 0',
              background: `linear-gradient(180deg, ${themePrimary} 0%, ${themeSecondary} 50%, ${themeAccent} 100%)`,
            }} />

            <div className="lg:hidden" style={{ marginBottom: 32 }}>
              <img src={leftlogo} alt="Logo" style={{ height: 44, objectFit: 'contain' }} />
            </div>

            <div style={{ width: '100%', maxWidth: 360, margin: '0 auto' }}>
              <div style={{ marginBottom: 30 }}>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: `linear-gradient(90deg, ${hexToRgba(themePrimary, 0.08)}, ${hexToRgba(themeSecondary, 0.06)})`,
                  border: `1px solid ${hexToRgba(themePrimary, 0.14)}`,
                  borderRadius: 999, padding: '4px 12px',
                  marginBottom: 14,
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: `linear-gradient(135deg,${themePrimary},${themeSecondary})`,
                  }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: themePrimary, letterSpacing: '0.06em' }}>
                    SECURE SIGN IN
                  </span>
                </div>

                <h1 style={{
                  fontSize: 28, fontWeight: 800, color: '#0f0a2e',
                  marginBottom: 5, letterSpacing: '-0.03em', lineHeight: 1.1,
                }}>
                  {platformResetToken ? 'Reset Platform Password' : 'Forgot Password'}
                </h1>
                <p style={{ fontSize: 13.5, color: '#94a3b8', lineHeight: 1.5 }}>
                  {platformResetToken
                    ? 'Choose a new password for your Platform Super Admin account'
                    : 'Enter your email to request a password reset link'}
                </p>
              </div>

              {submitted && !formError && (
                <div style={{
                  marginBottom: 14,
                  padding: '12px 14px',
                  borderRadius: 12,
                  background: 'linear-gradient(135deg, #ecfdf5, #f0fdf4)',
                  border: '1px solid #86efac',
                }}>
                  <p style={{ fontSize: 13, fontWeight: 700, color: '#166534', marginBottom: 4 }}>
                    {platformResetToken ? 'Password updated' : 'Request received'}
                  </p>
                  <p style={{ fontSize: 12, color: '#15803d', lineHeight: 1.5 }}>
                    {successMessage || 'If an account exists for this email, a reset link has been sent.'}
                  </p>
                </div>
              )}

              {formError && (
                <div style={{
                  marginBottom: 14,
                  padding: '12px 14px',
                  borderRadius: 12,
                  background: 'linear-gradient(135deg, #fef2f2, #fff7ed)',
                  border: '1px solid #fca5a5',
                }}>
                  <p style={{ fontSize: 12, fontWeight: 700, color: '#b91c1c', lineHeight: 1.5 }}>
                    {formError}
                  </p>
                </div>
              )}

              <form noValidate onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {platformResetToken ? <>
                  {!submitted && <>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>New Password</label>
                      <input type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="Enter new password" className="lp-input" required />
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Confirm New Password</label>
                      <input type="password" autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Confirm new password" className="lp-input" required />
                    </div>
                    <p style={{ margin: '-4px 0 0', color: '#94a3b8', fontSize: 11, lineHeight: 1.5 }}>Use at least 8 characters with uppercase, lowercase, a number, and a special character.</p>
                  </>}
                </> : <>
                <div>
                  <label style={{
                    display: 'block', fontSize: 11, fontWeight: 700,
                    color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6,
                  }}>
                    Email Address
                  </label>
                  <div style={{ position: 'relative' }}>
                    <Mail size={14} style={{
                      position: 'absolute', left: 14, top: '50%',
                      transform: 'translateY(-50%)', color: '#b0b8d0', pointerEvents: 'none',
                    }} />
                    <input
                      type="email"
                      value={email}
                      onChange={e => {
                        setEmail(e.target.value)
                        if (submitted) setSubmitted(false)
                        if (emailError) setEmailError(validateEmail(e.target.value))
                        if (formError) setFormError('')
                        if (showContactAdministrator) setShowContactAdministrator(false)
                      }}
                      placeholder="Enter your email"
                      className="lp-input"
                      required
                    />
                  </div>
                  {emailError && (
                    <p style={{ marginTop: 6, fontSize: 12, color: '#dc2626', fontWeight: 600 }}>
                      {emailError}
                    </p>
                  )}
                </div>

                {!platform && <div>
                  <label style={{
                    display: 'block', fontSize: 11, fontWeight: 700,
                    color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6,
                  }}>
                    Employee Code <span style={{ color: '#b0b8d0', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>(optional — helps if multiple accounts share the same email)</span>
                  </label>
                  <div style={{ position: 'relative' }}>
                    <Hash size={14} style={{
                      position: 'absolute', left: 14, top: '50%',
                      transform: 'translateY(-50%)', color: '#b0b8d0', pointerEvents: 'none',
                    }} />
                    <input
                      type="text"
                      value={employeeCode}
                      onChange={e => {
                        setEmployeeCode(e.target.value)
                        if (submitted) setSubmitted(false)
                        if (formError) setFormError('')
                        if (showContactAdministrator) setShowContactAdministrator(false)
                      }}
                      placeholder="Enter your employee code"
                      className="lp-input"
                    />
                  </div>
                </div>}
                </>}

                {(!platformResetToken || !submitted) && <button
                  type="submit"
                  disabled={submitting}
                  className="lp-btn"
                  style={{
                    width: '100%', height: 46, marginTop: 4,
                    border: 'none', borderRadius: 12,
                    color: 'white', fontSize: 14, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    letterSpacing: '0.01em',
                    boxShadow: `0 4px 20px ${hexToRgba(themePrimary, 0.35)}`,
                  }}
                >
                  {submitting
                    ? <><Loader2 size={16} className="animate-spin" /> {platformResetToken ? 'Updating password...' : 'Sending reset link...'}</>
                    : <>{platformResetToken ? 'Update Platform Password' : submitted ? 'Send Another Link' : 'Send Reset Link'}</>
                  }
                </button>}
              </form>

              {showContactAdministrator && (
                <div style={{ marginTop: 12, textAlign: 'center' }}>
                  <button
                    type="button"
                    onClick={handleContactAdministrator}
                    disabled={contactingAdmin}
                    style={{
                      fontSize: 12,
                      color: themePrimary,
                      fontWeight: 600,
                      background: 'none',
                      border: 'none',
                      cursor: contactingAdmin ? 'not-allowed' : 'pointer',
                      padding: 0,
                      opacity: contactingAdmin ? 0.7 : 1,
                    }}
                  >
                    {contactingAdmin ? 'Contacting administrator...' : 'Contact Administrator'}
                  </button>
                </div>
              )}

              <div style={{
                marginTop: 28,
                paddingTop: 20,
                borderTop: '1px solid #f1f5f9',
                textAlign: 'center',
              }}>
                <Link
                  to={platform ? '/platform/login' : '/login'}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    color: themePrimary,
                    fontWeight: 600,
                    textDecoration: 'none',
                  }}
                >
                  <ArrowLeft size={14} />
                  {platform ? 'Back to Platform Login' : 'Back to Login'}
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
