import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, Eye, EyeOff, Loader2, Lock } from 'lucide-react'
import api, { authApi } from '@/services/api'
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

// Genuine emailed reset links land on the tenant's own subdomain (the backend
// builds the link from the request's Origin/Referer header), so try that
// first — same resolution LoginPage.tsx uses — before falling back to
// whatever tenant this browser last used.
function resolveResetPasswordTenantSlug() {
  const hostname = window.location.hostname.trim().toLowerCase()
  const isIpv4Host = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
  const isLocalHost = hostname === 'localhost' || hostname.endsWith('.localhost')
  const isIpv6Host = hostname.includes(':')
  const parts = hostname.split('.')

  if (!isIpv4Host && !isLocalHost && !isIpv6Host && parts.length >= 3 && parts[0]) {
    return parts[0]
  }

  try {
    return (localStorage.getItem('tenant_slug') || localStorage.getItem('last_tenant') || '').trim().toLowerCase()
  } catch {
    return ''
  }
}

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

// Colored from the tenant's own
//  brand palette instead of a fixed
// violet/lavender/amber set, so this illustration never clashes with the
// tenant's actual theme color.
function IllustrationReset({ primary, secondary, accent }: { primary: string; secondary: string; accent: string }) {
  return (
    <svg viewBox="0 0 300 175" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full">
      <ellipse cx="150" cy="90" rx="118" ry="62" fill={hexToRgba(accent, 0.06)} style={fi(0, 0.6)} />
      <rect x="14" y="16" width="122" height="68" rx="12"
            fill="rgba(255,255,255,0.04)" stroke={hexToRgba(primary, 0.45)} strokeWidth="1.5"
            pathLength={1} style={ds(0, 0.52)} />
      <rect x="24" y="30" width="30" height="26" rx="7" fill={hexToRgba(primary, 0.18)} style={fi(0.32)} />
      <path d="M34 30 L34 24 Q34 18 39 18 Q44 18 44 24 L44 30"
            stroke={hexToRgba(primary, 0.8)} strokeWidth="3" strokeLinecap="round"
            pathLength={1} style={ds(0.4, 0.35)} />
      <circle cx="39" cy="42" r="4.5" fill="rgba(255,255,255,0.6)" style={fi(0.46)} />
      <rect x="37" y="42" width="4" height="7" rx="2" fill="rgba(255,255,255,0.6)" style={fi(0.5)} />
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
      <path d="M107 126 L113 132 L124 118" stroke={hexToRgba(accent, 0.8)} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"
            pathLength={1} style={ds(0.88, 0.32)} />
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

type ResetErrors = {
  token?: string
  newPassword?: string
  confirmPassword?: string
  form?: string
}

export default function ResetPasswordPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { success, error: showError } = useToast()

  const token = searchParams.get('token')?.trim() || ''
  const isPasswordExpiredFlow = searchParams.get('reason') === 'password-expired'
  // The password-expired redirect (from LoginPage) carries the tenant the user
  // typed as a `?tenant=` param — a genuine emailed reset link won't have one,
  // so fall back to whatever tenant this browser last used.
  const resetPasswordTenantSlug = (
    searchParams.get('tenant')?.trim().toLowerCase()
    || resolveResetPasswordTenantSlug()
  )

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [errors, setErrors] = useState<ResetErrors>({})
  const [themeColors, setThemeColors] = useState<ThemeColors>(DEFAULT_THEME_COLORS)

  useEffect(() => {
    if (!token) {
      setErrors((prev) => ({ ...prev, token: 'Reset link is invalid or missing a token.' }))
    }
  }, [token])

  // Tenant brand colors (same source as the sidebar/header's theme) — fall
  // back to this page's original purple palette until they're fetched, or
  // if the tenant has no theme customization. Decorative only, so a failed
  // fetch or missing slug just keeps the fallback purple.
  useEffect(() => {
    if (!resetPasswordTenantSlug) return

    let isActive = true
    ;(async () => {
      try {
        const { data } = await api.get('/settings/theme', {
          headers: { 'X-Tenant-Slug': resetPasswordTenantSlug },
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
  }, [resetPasswordTenantSlug])

  const themePrimary = themeColors.theme_primary || '#7c3aed'
  const themeSecondary = themeColors.theme_secondary || '#4f46e5'
  const themeAccent = themeColors.theme_accent || '#818cf8'

  useEffect(() => {
    if (!completed) return undefined

    const timer = window.setTimeout(() => {
      window.location.replace('/login')
    }, 500)
    return () => window.clearTimeout(timer)
  }, [completed])

  const validateForm = () => {
    const nextErrors: ResetErrors = {}

    if (!token) nextErrors.token = 'Reset token is required'
    if (!newPassword) nextErrors.newPassword = 'New password is required'
    if (!confirmPassword) nextErrors.confirmPassword = 'Confirm password is required'
    if (newPassword && confirmPassword && newPassword !== confirmPassword) {
      nextErrors.confirmPassword = 'Passwords must match'
    }

    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateForm()) return

    setSubmitting(true)
    try {
      await authApi.resetPassword({
        token,
        new_password: newPassword,
        confirm_password: confirmPassword,
      })
      setCompleted(true)
      setErrors({})
      success('Password reset successful', 'Redirecting you to the login page.')
    } catch (err: any) {
      const detail = err?.response?.data?.detail || 'Failed to reset password'
      setErrors((prev) => ({ ...prev, form: detail }))
      showError(detail)
    } finally {
      setSubmitting(false)
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
          padding: 0 44px 0 42px;
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
                  <IllustrationReset primary="#ffffff" secondary="#ffffff" accent="#ffffff" />
                </div>

                <p style={{
                  fontSize: 10, fontWeight: 800, letterSpacing: '0.22em',
                  textTransform: 'uppercase', color: themeAccent, marginBottom: 8,
                }}>
                  Password Reset
                </p>

                <h2 style={{
                  fontSize: 25, fontWeight: 800, color: '#f1f5f9',
                  marginBottom: 18, lineHeight: 1.22, letterSpacing: '-0.025em',
                }}>
                  Choose a new password
                </h2>

                <ul style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {[
                    'Open the secure link sent to your email',
                    'Enter your new password twice to confirm it',
                    'Sign in again using the updated password',
                  ].map((step, i) => (
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
                  Reset Password
                </h1>
                <p style={{ fontSize: 13.5, color: '#94a3b8', lineHeight: 1.5 }}>
                  {isPasswordExpiredFlow
                    ? 'Your password has expired. Please reset or change your password to continue.'
                    : 'Enter and confirm your new password to finish resetting your account'}
                </p>
              </div>

              {isPasswordExpiredFlow && (
                <div style={{
                  marginBottom: 14,
                  padding: '12px 14px',
                  borderRadius: 12,
                  background: 'linear-gradient(135deg, #eff6ff, #eef2ff)',
                  border: '1px solid #bfdbfe',
                }}>
                  <p style={{ fontSize: 12, fontWeight: 700, color: '#4338ca', lineHeight: 1.5 }}>
                    Your password has expired. Please reset or change your password to continue.
                  </p>
                </div>
              )}

              {completed && (
                <div style={{
                  marginBottom: 14,
                  padding: '12px 14px',
                  borderRadius: 12,
                  background: 'linear-gradient(135deg, #ecfdf5, #f0fdf4)',
                  border: '1px solid #86efac',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                }}>
                  <CheckCircle2 size={18} style={{ color: '#16a34a', flexShrink: 0, marginTop: 1 }} />
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 700, color: '#166534', marginBottom: 4 }}>
                      Password updated successfully
                    </p>
                    <p style={{ fontSize: 12, color: '#15803d', lineHeight: 1.5 }}>
                      Redirecting you to the login page.
                    </p>
                  </div>
                </div>
              )}

              {(errors.token || errors.form) && (
                <div style={{
                  marginBottom: 14,
                  padding: '12px 14px',
                  borderRadius: 12,
                  background: 'linear-gradient(135deg, #fef2f2, #fff7ed)',
                  border: '1px solid #fca5a5',
                }}>
                  <p style={{ fontSize: 12, fontWeight: 700, color: '#b91c1c', lineHeight: 1.5 }}>
                    {errors.form || errors.token}
                  </p>
                </div>
              )}

              <form noValidate onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <label style={{
                    display: 'block', fontSize: 11, fontWeight: 700,
                    color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6,
                  }}>
                    New Password
                  </label>
                  <div style={{ position: 'relative' }}>
                    <Lock size={14} style={{
                      position: 'absolute', left: 14, top: '50%',
                      transform: 'translateY(-50%)', color: '#b0b8d0', pointerEvents: 'none',
                    }} />
                    <input
                      type={showNewPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={e => {
                        setNewPassword(e.target.value)
                        if (errors.newPassword || errors.form || errors.confirmPassword) {
                          setErrors((prev) => ({
                            ...prev,
                            newPassword: undefined,
                            confirmPassword: undefined,
                            form: undefined,
                          }))
                        }
                      }}
                      placeholder="Enter your new password"
                      className="lp-input"
                      disabled={submitting || completed}
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(!showNewPassword)}
                      style={{
                        position: 'absolute', right: 12, top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'none', border: 'none', cursor: 'pointer',
                        padding: '4px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: showNewPassword ? themePrimary : '#b0b8d0',
                        transition: 'color 0.2s ease',
                      }}
                      title={showNewPassword ? 'Hide password' : 'Show password'}
                      disabled={submitting || completed}
                    >
                      {showNewPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  {errors.newPassword && (
                    <p style={{ marginTop: 6, fontSize: 12, color: '#dc2626', fontWeight: 600 }}>
                      {errors.newPassword}
                    </p>
                  )}
                </div>

                <div>
                  <label style={{
                    display: 'block', fontSize: 11, fontWeight: 700,
                    color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6,
                  }}>
                    Confirm Password
                  </label>
                  <div style={{ position: 'relative' }}>
                    <Lock size={14} style={{
                      position: 'absolute', left: 14, top: '50%',
                      transform: 'translateY(-50%)', color: '#b0b8d0', pointerEvents: 'none',
                    }} />
                    <input
                      type={showConfirmPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={e => {
                        setConfirmPassword(e.target.value)
                        if (errors.confirmPassword || errors.form) {
                          setErrors((prev) => ({
                            ...prev,
                            confirmPassword: undefined,
                            form: undefined,
                          }))
                        }
                      }}
                      placeholder="Confirm your new password"
                      className="lp-input"
                      disabled={submitting || completed}
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      style={{
                        position: 'absolute', right: 12, top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'none', border: 'none', cursor: 'pointer',
                        padding: '4px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: showConfirmPassword ? themePrimary : '#b0b8d0',
                        transition: 'color 0.2s ease',
                      }}
                      title={showConfirmPassword ? 'Hide password' : 'Show password'}
                      disabled={submitting || completed}
                    >
                      {showConfirmPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  {errors.confirmPassword && (
                    <p style={{ marginTop: 6, fontSize: 12, color: '#dc2626', fontWeight: 600 }}>
                      {errors.confirmPassword}
                    </p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={submitting || completed || !token}
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
                    ? <><Loader2 size={16} className="animate-spin" /> Resetting password...</>
                    : <>Reset Password</>
                  }
                </button>
              </form>

              <div style={{
                marginTop: 28,
                paddingTop: 20,
                borderTop: '1px solid #f1f5f9',
                textAlign: 'center',
              }}>
                <Link
                  to="/login"
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
                  Back to Login
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
