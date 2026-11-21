import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { platformApi, type PlatformCaptcha, type PlatformLoginResponse } from '@/services/platformApi'
import { usePlatformAuthStore } from '@/store/platformAuthStore'
import './platformLoginV6.css'

// Platform sign-in – the Azcentrix login prototype v6 (azcentrix-login-platform-v6.html): access panel on the left,
// command console + globe on the right. Wired to the real platform sign-in: CAPTCHA when the server asks for it,
// e-mailed 6-digit OTP (with opt-in "Trust this device for 30 days"), forced password change, password reset and
// contact-administrator requests. The status bar shows live, non-sensitive values only (/platform/login/status);
// the floating cards and the command palette are illustrative.
type Step = 'credentials' | 'otp' | 'password'
const LOGO = `${import.meta.env.BASE_URL}${encodeURIComponent('App-icon (1).png')}`   // frontend/public/App-icon (1).png
const REMEMBER_KEY = 'az_plat_user'          // the user name only – never a password or token
const CATEGORIES = ['I’m locked out', 'I lost my authenticator device', 'I need platform access', 'Report suspicious activity']
const MARQUEE = ['Tenants', 'Plans & entitlements', 'Billing', 'Discounts & coupons', 'Mobile control', 'Databases', 'Monitoring', 'Usage', 'Sandboxes', 'Security', 'Audit trail', 'Support & SLA', 'API & keys']
const COMMANDS: [string, [string, string][]][] = [
  ['provision tenant', [['Create workspace', 'region 1'], ['Assign plan', 'Growth'], ['Apply workflow template', 'Sales CRM'], ['Invite administrator', 'sent']]],
  ['rollout mobile 3.3.0 --25%', [['Stage release', 'iOS & Android'], ['Watch crash-free ≥ 99.5%', 'live'], ['Pause automatically on spike', 'armed']]],
  ['issue coupon SUMMER20', [['Create code', '20% · 3 months'], ['Limit redemptions', '50'], ['Notify tenants', 'announcement']]],
  ['scale region --add-shard', [['Add database shard', 'region 2'], ['Rebalance tenants', '+2 vCPU'], ['Update capacity forecast', 'done']]],
  ['rotate api-keys --older 90d', [['Find keys older than 90 days', '12 found'], ['Issue replacements', '24 h overlap'], ['Write audit entry', 'logged']]],
]

function getDeviceId() {
  let deviceId = localStorage.getItem('platform_device_id')
  if (!deviceId) {
    deviceId = crypto.randomUUID?.() ??
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })
    localStorage.setItem('platform_device_id', deviceId)
  }
  return deviceId
}

// Platform auth errors come back as { code, message, ... }; older ones as a string.
function errorDetail(err: any): { code?: string; message: string; captcha_required?: boolean } {
  const detail = err?.response?.data?.detail
  if (detail && typeof detail === 'object') return { ...detail, message: detail.message || 'Sign-in failed' }
  if (typeof detail === 'string') return { message: detail }
  if (!err?.response) return { message: 'Cannot reach the server. Check your connection and try again.' }
  return { message: 'Sign-in failed. Please try again.' }
}
const readRemembered = () => { try { return localStorage.getItem(REMEMBER_KEY) || '' } catch { return '' } }

const UserIcon = () => <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></svg>
const LockIcon = () => <svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>

/* ---------- right panel: globe ---------- */
function Globe() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current, c = cv?.getContext('2d')
    if (!cv || !c) return
    const W = cv.width, R = W * .4, cx = W / 2, cy = W / 2, D = Math.PI / 180
    const P = [[19, 73], [17, 78], [50, 8], [1, 104], [37, -122], [-23, -46], [51, 0], [35, 139]], A = [[0, 2], [2, 6], [0, 3], [3, 7], [4, 6], [1, 5], [7, 4]]
    const pr = (la: number, lo: number, rot: number) => { const a = la * D, b = (lo + rot) * D, x = Math.cos(a) * Math.sin(b), y = Math.sin(a), z = Math.cos(a) * Math.cos(b); return [cx + R * x, cy - R * y * .98, z] }
    let raf = 0
    const frame = (t: number) => {
      const rot = t * .012
      c.clearRect(0, 0, W, W)
      const g = c.createRadialGradient(cx - R * .3, cy - R * .3, R * .1, cx, cy, R); g.addColorStop(0, 'rgba(124,107,255,.28)'); g.addColorStop(1, 'rgba(20,16,50,.55)')
      c.fillStyle = g; c.beginPath(); c.arc(cx, cy, R, 0, 6.283); c.fill(); c.strokeStyle = 'rgba(150,135,255,.55)'; c.lineWidth = 1.6; c.stroke()
      c.lineWidth = 1
      for (let la = -60; la <= 60; la += 30) { c.strokeStyle = 'rgba(150,135,255,.16)'; c.beginPath(); let f = 1; for (let lo = -180; lo <= 180; lo += 6) { const p = pr(la, lo, rot); if (p[2] < 0) { f = 1; continue } if (f) c.moveTo(p[0], p[1]); else c.lineTo(p[0], p[1]); f = 0 } c.stroke() }
      for (let lo = -180; lo < 180; lo += 30) { c.strokeStyle = 'rgba(150,135,255,.16)'; c.beginPath(); let f = 1; for (let la = -90; la <= 90; la += 6) { const p = pr(la, lo, rot); if (p[2] < 0) { f = 1; continue } if (f) c.moveTo(p[0], p[1]); else c.lineTo(p[0], p[1]); f = 0 } c.stroke() }
      c.fillStyle = 'rgba(181,169,255,.55)'
      for (let la = -60; la <= 70; la += 7) for (let lo = -180; lo < 180; lo += 7) {
        const h = Math.sin(la * .09 + lo * .07) + Math.sin(lo * .05 - la * .11) + Math.cos((la + lo) * .04)
        if (h > .55) { const p = pr(la, lo, rot); if (p[2] > 0) { c.globalAlpha = .25 + p[2] * .6; c.fillRect(p[0], p[1], 3, 3) } }
      }
      c.globalAlpha = 1
      A.forEach(([i, j], k) => {
        const [a1, o1] = P[i], [a2, o2] = P[j], ph = ((t * .0004 + k * .17) % 1)
        c.strokeStyle = 'rgba(53,211,228,.55)'; c.lineWidth = 1.6; c.beginPath()
        let f = 1, last: number[] | null = null
        for (let s = 0; s <= 24; s++) {
          const u = s / 24, la = a1 + (a2 - a1) * u, lo = o1 + (o2 - o1) * u, lift = Math.sin(u * Math.PI) * 18, p = pr(la, lo, rot), z = p[2]
          const q = [cx + (p[0] - cx) * (1 + lift / R * .9), cy + (p[1] - cy) * (1 + lift / R * .9)]
          if (z < 0) { f = 1; continue }
          if (f) c.moveTo(q[0], q[1]); else c.lineTo(q[0], q[1]); f = 0
          if (s === Math.round(ph * 24)) last = q
        }
        c.stroke()
        if (last) { c.fillStyle = '#fff'; c.beginPath(); c.arc(last[0], last[1], 3.2, 0, 6.283); c.fill() }
      })
      P.forEach(([la, lo], i) => {
        const p = pr(la, lo, rot); if (p[2] <= 0) return
        const pulse = (Math.sin(t * .004 + i) + 1) / 2
        c.fillStyle = `rgba(61,220,151,${.25 * (1 - pulse)})`; c.beginPath(); c.arc(p[0], p[1], 6 + pulse * 14, 0, 6.283); c.fill()
        c.fillStyle = '#3DDC97'; c.beginPath(); c.arc(p[0], p[1], 4.5, 0, 6.283); c.fill()
      })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={ref} className="gl" width={760} height={760} />
}

/* ---------- right panel: command palette demo ---------- */
function CommandPalette() {
  const [typed, setTyped] = useState('')
  const [rows, setRows] = useState<{ t: string; v: string; on: boolean }[]>([])
  useEffect(() => {
    let alive = true, ci = 0
    const timers: number[] = []
    const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(() => { if (alive) fn() }, ms)) }
    const run = () => {
      const [cmd, rs] = COMMANDS[ci++ % COMMANDS.length]
      setRows([]); setTyped('')
      cmd.split('').forEach((_, n) => later(() => setTyped(cmd.slice(0, n + 1)), 55 * (n + 1)))
      const typedAt = 55 * cmd.length
      later(() => setRows(rs.map(([t, v]) => ({ t, v, on: false }))), typedAt)
      rs.forEach((_, i) => later(() => setRows(cur => cur.map((r, j) => j === i ? { ...r, on: true } : r)), typedAt + 250 + i * 420))
      later(run, typedAt + 250 + rs.length * 420 + 2400)
    }
    run()
    return () => { alive = false; timers.forEach(window.clearTimeout) }
  }, [])
  return <div className="cmd">
    <div className="in"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg><span>{typed}</span><i className="caret" /><kbd>⌘ K</kbd></div>
    <div className="res">{rows.map(r => <div key={r.t} className={`rw ${r.on ? 'on' : ''}`}><i>✓</i>{r.t}<span>{r.v}</span></div>)}</div>
    <div className="ft"><span><b>↵</b> run</span><span><b>↑↓</b> navigate</span><span><b>esc</b> close</span><span style={{ marginLeft: 'auto' }}>audited</span></div>
  </div>
}

/* ---------- dialogs ---------- */
function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])
  return <div className="ov" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="md" role="dialog" aria-modal="true" aria-label={label}>{children}</div>
  </div>
}

function ForgotDialog({ initial, onClose }: { initial: string; onClose: () => void }) {
  const [value, setValue] = useState(initial)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')
  const send = async () => {
    const v = value.trim()
    if (!v) { setErr('Enter your user name'); return }
    setErr(''); setBusy(true)
    try { const { data } = await platformApi.forgotPassword(v); setDone(data.message) }
    catch (e) { setErr(errorDetail(e).message) } finally { setBusy(false) }
  }
  return <Dialog label="Reset your password" onClose={onClose}>
    {done ? <div className="fin2"><div className="tk">✓</div><h3>Reset link sent</h3><p>{done}</p>
      <div className="acts" style={{ justifyContent: 'center' }}><button type="button" className="btn2 p" onClick={onClose}>Back to sign in</button></div></div>
      : <>
        <h3>Reset your password</h3>
        <p>Enter your platform user name. A reset link is sent to your registered e-mail and requires two-step verification.</p>
        <div className="f"><div className="box"><UserIcon /><input value={value} autoFocus placeholder="User name" aria-label="User name or e-mail"
          onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void send() }} /></div><div className="msg">{err}</div></div>
        <div className="acts"><button type="button" className="btn2" onClick={onClose}>Cancel</button>
          <button type="button" className="btn2 p" disabled={busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send reset link'}</button></div>
      </>}
  </Dialog>
}

function ContactDialog({ initial, category, onClose }: { initial: string; category: string; onClose: () => void }) {
  const [contact, setContact] = useState(initial)
  const [cat, setCat] = useState(category)
  const [message, setMessage] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState('')
  const send = async () => {
    if (!contact.trim()) { setErr('Tell us who you are so we can reply'); return }
    setErr(''); setBusy(true)
    try { const { data } = await platformApi.contactAdministrator({ contact: contact.trim(), category: cat, message }); setDone(data.message) }
    catch (e) { setErr(errorDetail(e).message) } finally { setBusy(false) }
  }
  return <Dialog label="Contact administrator" onClose={onClose}>
    {done ? <div className="fin2"><div className="tk">✓</div><h3>Request logged</h3><p>{done}</p>
      <div className="acts" style={{ justifyContent: 'center' }}><button type="button" className="btn2 p" onClick={onClose}>Close</button></div></div>
      : <>
        <h3>Contact administrator</h3>
        <p>The platform security team will respond within one working day.</p>
        <div className="f"><label htmlFor="az-can">Your name / e-mail</label><div className="box"><input id="az-can" value={contact} autoFocus maxLength={200} placeholder="Name or e-mail" onChange={e => setContact(e.target.value)} /></div></div>
        <div className="f"><label htmlFor="az-cat">What do you need?</label><select id="az-cat" value={cat} onChange={e => setCat(e.target.value)}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></div>
        <div className="f"><textarea aria-label="Details" value={message} maxLength={2000} placeholder="Add details (optional)" onChange={e => setMessage(e.target.value)} /><div className="msg">{err}</div></div>
        <div className="acts"><button type="button" className="btn2" onClick={onClose}>Cancel</button>
          <button type="button" className="btn2 p" disabled={busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send message'}</button></div>
      </>}
  </Dialog>
}

export default function PlatformLoginPage() {
  const navigate = useNavigate()
  const { login } = usePlatformAuthStore()

  const [step, setStep] = useState<Step>('credentials')
  const [username, setUsername] = useState(readRemembered)
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(() => !!readRemembered())
  const [showPassword, setShowPassword] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const [loading, setLoading] = useState(false)
  const [alert, setAlert] = useState('')
  const [fieldErr, setFieldErr] = useState<{ user?: string; pass?: string }>({})
  const [shakeKey, setShakeKey] = useState(0)
  const [forgotEnabled, setForgotEnabled] = useState(false)
  const [otpMode, setOtpMode] = useState<string | null>(null)
  const [status, setStatus] = useState<{ operational: boolean; regions: number | null; p95_ms: number | null } | null>(null)

  const [captchaNeeded, setCaptchaNeeded] = useState(false)
  const [captcha, setCaptcha] = useState<PlatformCaptcha | null>(null)
  const [captchaAnswer, setCaptchaAnswer] = useState('')
  const [captchaLoading, setCaptchaLoading] = useState(false)
  const captchaRequest = useRef(0)

  const [challengeId, setChallengeId] = useState('')
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''))
  const [trustDevice, setTrustDevice] = useState(false)
  const [otpDestination, setOtpDestination] = useState('')
  const [resendIn, setResendIn] = useState(0)
  const [notice, setNotice] = useState('')
  const [otpWasShown, setOtpWasShown] = useState(false)
  const otpRefs = useRef<(HTMLInputElement | null)[]>([])

  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [dialog, setDialog] = useState<null | { kind: 'forgot' } | { kind: 'contact'; category: string }>(null)

  const loadCaptcha = async () => {
    const request = ++captchaRequest.current
    setCaptchaAnswer(''); setCaptcha(null); setCaptchaLoading(true)
    try { const { data } = await platformApi.loginCaptcha(); if (captchaRequest.current === request) setCaptcha(data) }
    catch { if (captchaRequest.current === request) setAlert('The verification question could not be loaded. Refresh it to try again.') }
    finally { if (captchaRequest.current === request) setCaptchaLoading(false) }
  }

  useEffect(() => {
    platformApi.loginOptions().then(({ data }) => {
      setForgotEnabled(data.forgot_password_enabled)
      setOtpMode(data.otp_mode)
      if (data.captcha_mode === 'every_login') { setCaptchaNeeded(true); void loadCaptcha() }
    }).catch(() => setForgotEnabled(false))
    platformApi.loginStatus().then(({ data }) => setStatus(data)).catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    if (resendIn <= 0) return
    const t = window.setTimeout(() => setResendIn(s => s - 1), 1000)
    return () => window.clearTimeout(t)
  }, [resendIn])

  const shake = () => setShakeKey(k => k + 1)
  const fail = (message: string) => { setAlert(message); shake() }

  const restart = (message?: string) => {
    setStep('credentials'); setChallengeId(''); setDigits(Array(6).fill('')); setNewPassword(''); setConfirmPassword(''); setNotice(''); setOtpWasShown(false)
    setAlert(message || '')
    if (captchaNeeded) void loadCaptcha()
  }

  // Every response either carries a token (done) or names the next step.
  const handleResponse = (data: PlatformLoginResponse) => {
    setAlert('')
    if (data.access_token) {
      login(data.access_token, { full_name: data.full_name!, username: data.username!, role: data.role! })
      navigate('/platform/dashboard', { replace: true })
      return
    }
    if (data.challenge_id) setChallengeId(data.challenge_id)
    if (data.otp_required) {
      setStep('otp'); setDigits(Array(6).fill('')); setOtpWasShown(true)
      setOtpDestination(data.otp_destination || 'your e-mail')
      setResendIn(data.resend_available_in ?? 0)
      window.setTimeout(() => otpRefs.current[0]?.focus(), 50)
    } else if (data.password_change_required) {
      setStep('password')
    }
  }

  const handleError = (err: any) => {
    const detail = errorDetail(err)
    if (['login_expired', 'otp_locked', 'otp_resend_limit', 'otp_delivery_failed'].includes(detail.code || '')) { restart(detail.message); shake(); return }
    fail(detail.message)
    if (step === 'otp') { setDigits(Array(6).fill('')); window.setTimeout(() => otpRefs.current[0]?.focus(), 50) }
    if (step === 'credentials' && (detail.captcha_required || detail.code?.startsWith('captcha'))) { setCaptchaNeeded(true); void loadCaptcha() }
    else if (step === 'credentials' && captchaNeeded) void loadCaptcha()   // the old one was consumed by this attempt
  }

  const signIn = async (e: FormEvent) => {
    e.preventDefault()
    if (loading) return
    const u = username.trim()
    const errs = { user: u ? undefined : 'Enter your user name', pass: password ? undefined : 'Enter your password' }
    setFieldErr(errs); setAlert('')
    if (errs.user || errs.pass) { shake(); return }
    if (captchaNeeded && (!captcha || !captchaAnswer.trim())) { fail('Enter the answer to the verification question'); return }
    try { if (remember) localStorage.setItem(REMEMBER_KEY, u); else localStorage.removeItem(REMEMBER_KEY) } catch { /* storage unavailable */ }
    setLoading(true)
    try {
      const { data } = await platformApi.login(u, password, getDeviceId(), captchaNeeded && captcha ? { id: captcha.captcha_id, answer: captchaAnswer.trim() } : undefined)
      handleResponse(data)
    } catch (err) { handleError(err) } finally { setLoading(false) }
  }

  const verify = async (code: string) => {
    if (loading) return
    if (!/^\d{6}$/.test(code)) { fail('Enter all 6 digits of your code.'); return }
    setLoading(true)
    try { const { data } = await platformApi.verifyLoginOtp(challengeId, code, getDeviceId(), trustDevice); handleResponse(data) }
    catch (err) { handleError(err) } finally { setLoading(false) }
  }
  const setDigit = (i: number, raw: string) => {
    const v = raw.replace(/\D/g, '').slice(-1)
    const next = digits.map((d, j) => j === i ? v : d)
    setDigits(next)
    if (v && i < 5) otpRefs.current[i + 1]?.focus()
    if (next.every(Boolean)) void verify(next.join(''))
  }
  const otpKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Backspace' && !digits[i] && i > 0) otpRefs.current[i - 1]?.focus() }
  const otpPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6)
    if (!t) return
    e.preventDefault()
    const next = Array.from({ length: 6 }, (_, j) => t[j] || '')
    setDigits(next)
    otpRefs.current[Math.min(t.length, 5)]?.focus()
    if (t.length === 6) void verify(t)
  }
  const resend = async () => {
    if (resendIn > 0 || loading) return
    setLoading(true)
    try { const { data } = await platformApi.resendLoginOtp(challengeId, getDeviceId()); setResendIn(data.resend_available_in ?? 30); setAlert(''); setNotice(`A new code has been sent to ${data.otp_destination || otpDestination}.`) }
    catch (err) { handleError(err) } finally { setLoading(false) }
  }

  const changePassword = async (e: FormEvent) => {
    e.preventDefault()
    if (loading) return
    if (!newPassword || newPassword !== confirmPassword) { fail('Enter matching new passwords'); return }
    setLoading(true)
    try { const { data } = await platformApi.loginChangePassword(challengeId, newPassword, getDeviceId(), otpWasShown && trustDevice); handleResponse(data) }
    catch (err) { handleError(err) } finally { setLoading(false) }
  }

  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:'
  const statusText = status == null ? 'Status unavailable' : status.operational ? 'All systems operational' : 'Service disruption'
  return <div className="azl6">
    <div className="wrap">
      <main className="side">
        <div className="brand">
          <div className="mark"><img src={LOGO} alt="" /></div>
          <div><b>AZCENTRIX</b><small>PLATFORM CONSOLE</small></div><span className="rbadge">RESTRICTED</span>
        </div>

        <div className="acc">
          {step === 'credentials' && <section key={`s1-${shakeKey}`} className={`step ${shakeKey ? 'shake' : ''}`}>
            <h2>Platform sign-in</h2>
            <p className="sub">Manage tenants, plans and infrastructure. Authorized staff only.</p>
            {alert && <div className="alert" role="alert">{alert}</div>}
            <form onSubmit={signIn} noValidate>
              <div className="f"><label htmlFor="az-un">User name</label>
                <div className={`box ${fieldErr.user ? 'err' : ''}`}><UserIcon /><input id="az-un" placeholder="Enter your user name" autoComplete="username" spellCheck={false} autoFocus={!username}
                  value={username} onChange={e => { setUsername(e.target.value); setFieldErr(f => ({ ...f, user: undefined })) }} /></div>
                <div className="msg">{fieldErr.user}</div></div>
              <div className="f"><label htmlFor="az-pw">Password</label>
                <div className={`box ${fieldErr.pass ? 'err' : ''}`}><LockIcon /><input id="az-pw" type={showPassword ? 'text' : 'password'} placeholder="Enter your password" autoComplete="current-password" autoFocus={!!username}
                  value={password} onChange={e => { setPassword(e.target.value); setFieldErr(f => ({ ...f, pass: undefined })) }}
                  onKeyUp={e => setCapsLock(e.getModifierState?.('CapsLock') ?? false)} />
                  <button type="button" className="eye" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(s => !s)}>{showPassword ? 'HIDE' : 'SHOW'}</button></div>
                <div className="msg">{fieldErr.pass || (capsLock ? '⚠ Caps Lock is on' : '')}</div></div>
              {captchaNeeded && <div className="f"><label htmlFor="az-cap">Verification</label>
                <div className="cap"><div className="q">{captcha ? captcha.question : captchaLoading ? '…' : '—'}</div>
                  <button type="button" aria-label="Get a new verification question" disabled={captchaLoading} onClick={() => void loadCaptcha()}><RefreshCw size={15} /></button></div>
                <div className="box"><input id="az-cap" placeholder="Your answer" inputMode="numeric" autoComplete="off" maxLength={2} value={captchaAnswer} onChange={e => setCaptchaAnswer(e.target.value)} /></div></div>}
              <div className="row">
                <label className="chk"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /><i />Remember me</label>
                {forgotEnabled && <button type="button" className="lnk" onClick={() => setDialog({ kind: 'forgot' })}>Forgot password?</button>}
              </div>
              <button className="go" type="submit" disabled={loading || (captchaNeeded && (captchaLoading || !captcha))}>{loading && <span className="spin" />}<span>{loading ? 'Authenticating…' : 'Continue'}</span></button>
            </form>
            <div className="help">Need access or locked out? <button type="button" className="lnk" onClick={() => setDialog({ kind: 'contact', category: CATEGORIES[0] })}>Contact administrator</button></div>
            <div className="sec"><b>● SECURED</b>{secure ? ' · TLS' : ''} · sign-ins are logged with IP and device.{otpMode && otpMode !== 'never' ? ' Next step: two-factor verification.' : ''}</div>
          </section>}

          {step === 'otp' && <section key={`s2-${shakeKey}`} className="step">
            <h2>Two-step verification</h2>
            <p className="sub">Enter the 6-digit code sent to {otpDestination}.</p>
            {alert && <div className="alert" role="alert">{alert}</div>}
            {!alert && notice && <div className="alert ok" role="status">{notice}</div>}
            <div className={`otp ${shakeKey ? 'shake' : ''}`} key={`otp-${shakeKey}`}>
              {digits.map((d, i) => <input key={i} ref={el => { otpRefs.current[i] = el }} inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'} maxLength={1} aria-label={`Digit ${i + 1}`}
                value={d} disabled={loading} onChange={e => setDigit(i, e.target.value)} onKeyDown={e => otpKey(i, e)} onPaste={otpPaste} />)}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <label className="chk"><input type="checkbox" checked={trustDevice} onChange={e => setTrustDevice(e.target.checked)} /><i />Trust this device for 30 days</label>
              <button type="button" className="lnk" onClick={() => restart()}>← Back</button>
            </div>
            <button className="go" type="button" disabled={loading} onClick={() => void verify(digits.join(''))}>{loading && <span className="spin" />}<span>{loading ? 'Verifying…' : 'Verify & sign in'}</span></button>
            <div className="help">
              <button type="button" className="lnk" disabled={resendIn > 0 || loading} onClick={() => void resend()}>{resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}</button>
              {' · '}<button type="button" className="lnk" onClick={() => setDialog({ kind: 'contact', category: 'I lost my authenticator device' })}>Lost your device?</button>
            </div>
          </section>}

          {step === 'password' && <section key={`s3-${shakeKey}`} className={`step ${shakeKey ? 'shake' : ''}`}>
            <h2>Set a new password</h2>
            <p className="sub">Your password must be changed before you can continue.</p>
            {alert && <div className="alert" role="alert">{alert}</div>}
            <form onSubmit={changePassword} noValidate>
              <div className="f"><label htmlFor="az-np">New password</label><div className="box"><LockIcon /><input id="az-np" type="password" autoComplete="new-password" autoFocus value={newPassword} onChange={e => setNewPassword(e.target.value)} /></div><div className="msg" /></div>
              <div className="f"><label htmlFor="az-cp">Confirm new password</label><div className={`box ${confirmPassword && confirmPassword !== newPassword ? 'err' : ''}`}><LockIcon /><input id="az-cp" type="password" autoComplete="new-password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></div>
                <div className="msg">{confirmPassword && confirmPassword !== newPassword ? 'Passwords don’t match' : ''}</div></div>
              <button className="go" type="submit" disabled={loading}>{loading && <span className="spin" />}<span>{loading ? 'Saving…' : 'Set password & sign in'}</span></button>
            </form>
            <div className="help"><button type="button" className="lnk" onClick={() => restart()}>← Back to sign in</button></div>
          </section>}
        </div>
        <div className="legal"><span>Console v6</span><span>© {new Date().getFullYear()} Azcentrix Connect</span></div>
      </main>

      <section className="fleet" aria-hidden="true">
        <div className="ftop">
          <span><i className={`live ${status == null ? 'unk' : status.operational ? '' : 'down'}`} /><b>{statusText}</b></span>
          <span className="r">
            {status?.regions != null && <span className="pill">{status.regions} region{status.regions === 1 ? '' : 's'}</span>}
            {status?.p95_ms != null && <span className="pill">p95 {status.p95_ms} ms</span>}
          </span>
        </div>
        <div className="fh">Command your <em>entire platform</em> from one place.</div>
        <div className="fp">Provision workspaces, roll out the mobile app, manage plans and discounts, and scale regions – with every action audited.</div>
        <div className="stage">
          <Globe />
          <div className="fc a">Releases<b>Canary rollouts</b><small>▲ audited</small></div>
          <div className="fc c">Mobile app<b>Staged rollout</b><small>▲ crash-guarded</small></div>
          <div className="fc b">Billing run<b>Invoicing</b><small>invoices &amp; dunning</small></div>
          <CommandPalette />
        </div>
        <div className="mq"><div>{[...MARQUEE, ...MARQUEE].map((m, i) => <span key={i}>{m}</span>)}</div></div>
      </section>
    </div>

    {dialog?.kind === 'forgot' && <ForgotDialog initial={username} onClose={() => setDialog(null)} />}
    {dialog?.kind === 'contact' && <ContactDialog initial={username} category={dialog.category} onClose={() => setDialog(null)} />}
  </div>
}
