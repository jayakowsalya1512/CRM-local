import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { platformApi, type PlatformCaptchaMode, type PlatformChannel, type PlatformOtpMode } from '@/services/platformApi'
import { ImagePlus, Save, Trash2 } from 'lucide-react'

// Every control on this page is edited locally; nothing is saved until "Save & Apply", which saves only what changed
// (each change is audited server-side as before).
const OTP_OPTIONS: { value: PlatformOtpMode; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: 'new_device', label: 'New device' },
  { value: 'every_login', label: 'Every login' },
]
const verification_OPTIONS: { value: PlatformCaptchaMode; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: 'new_device', label: 'New device' },
  { value: 'every_login', label: 'Every login' },
]
const REGION_OPTIONS = [
  { value: 'ap-south-1', label: 'India – Mumbai' },
  { value: 'ap-south-2', label: 'India – Hyderabad' },
  { value: 'ap-southeast-1', label: 'Singapore' },
  { value: 'eu-central-1', label: 'EU – Frankfurt' },
  { value: 'us-east-1', label: 'US East – Virginia' },
]
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']
const LOGO_MAX_BYTES = 2 * 1024 * 1024
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const inputClass = 'bw-in disabled:opacity-60'
const labelClass = 'mb-1 block text-[12px] text-slate-500'

type Branding = { productName: string; supportEmail: string; allowTenantBranding: boolean }
type Compliance = { region: string; retention: string; encryptAtRest: boolean }
type Auth = { forgot: boolean; forceFirst: boolean; deviceAlert: boolean; otpMode: PlatformOtpMode; captchaMode: PlatformCaptchaMode; timeout: string }
type LogoChange = { file: File; preview: string } | 'remove' | null

// Prototype panel(): shares the .bw-panel look (8px radius, soft shadow, tinted header).
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bw-panel">
      <header className="ph">
        <h3 className="text-[13px] font-semibold">{title}</h3>
      </header>
      {children}
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[38px] items-center justify-between gap-4 border-b border-slate-200 px-3.5 py-1.5 last:border-b-0" title={hint}>
      <span className="text-sm text-slate-800">{label}</span>
      {children}
    </div>
  )
}

function Toggle({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${checked ? 'bg-indigo-600' : 'bg-slate-200'}`}
    >
      <span className={`absolute h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-all ${checked ? 'left-[19px]' : 'left-[3px]'}`} />
    </button>
  )
}

const errorText = (reason: any, fallback: string) => {
  const status = reason?.response?.status
  const detail = reason?.response?.data?.detail
  if (status === 403) return 'You do not have permission to change this setting.'
  if (status === 404 || status === 405) return 'The server does not support this setting yet. Restart or update the backend and try again.'
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail[0]?.msg) return String(detail[0].msg).replace(/^Value error, /, '')
  if (!reason?.response && reason instanceof Error) return reason.message === 'Network Error' ? 'Cannot reach the server. Check your connection and try again.' : reason.message
  return fallback
}
const same = <T extends object>(a: T | null, b: T | null) => JSON.stringify(a) === JSON.stringify(b)

export default function PlatformSettingsPage() {
  // Saved (server) values and the edited copies; a section is changed when they differ.
  const [savedBranding, setSavedBranding] = useState<Branding | null>(null)
  const [branding, setBranding] = useState<Branding | null>(null)
  const [savedLogoUrl, setSavedLogoUrl] = useState('')
  const [logoChange, setLogoChange] = useState<LogoChange>(null)
  const [savedCompliance, setSavedCompliance] = useState<Compliance | null>(null)
  const [compliance, setCompliance] = useState<Compliance | null>(null)
  const [savedAuth, setSavedAuth] = useState<Auth | null>(null)
  const [auth, setAuth] = useState<Auth | null>(null)
  const [channels, setChannels] = useState<PlatformChannel[] | null>(null)

  const [brandingError, setBrandingError] = useState('')
  const [complianceError, setComplianceError] = useState('')
  const [authError, setAuthError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const logoInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    platformApi.getBranding()
      .then(({ data }) => {
        const b = { productName: data.product_name ?? '', supportEmail: data.support_email ?? '', allowTenantBranding: data.allow_tenant_branding }
        setSavedBranding(b); setBranding(b); setSavedLogoUrl(data.logo_url ?? '')
      })
      .catch(() => setBrandingError('Unable to load branding settings.'))
    platformApi.getDataCompliance()
      .then(({ data }) => {
        const c = { region: data.default_region, retention: String(data.retention_years), encryptAtRest: data.encrypt_documents_at_rest }
        setSavedCompliance(c); setCompliance(c)
      })
      .catch(() => setComplianceError('Unable to load data & compliance settings.'))
    Promise.all([platformApi.loginOptions(), platformApi.getSessionTimeout()])
      .then(([{ data: o }, { data: t }]) => {
        const a: Auth = { forgot: o.forgot_password_enabled, forceFirst: o.force_first_login, deviceAlert: o.new_device_alert,
          otpMode: o.otp_mode ?? 'never', captchaMode: o.captcha_mode ?? 'never', timeout: String(t.timeout_minutes) }
        setSavedAuth(a); setAuth(a)
      })
      .catch(() => setAuthError('Unable to load authentication settings.'))
    platformApi.getChannels().then(({ data }) => setChannels(data)).catch(() => setChannels([]))
  }, [])

  // Release the preview of a picked-but-unsaved logo.
  useEffect(() => () => { if (logoChange && logoChange !== 'remove') URL.revokeObjectURL(logoChange.preview) }, [logoChange])

  const brandingChanged = !same(branding, savedBranding)
  const complianceChanged = !same(compliance, savedCompliance)
  const authChanged = !same(auth, savedAuth)
  const dirty = brandingChanged || complianceChanged || authChanged || logoChange !== null

  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const editBranding = (patch: Partial<Branding>) => { setBranding(b => b && { ...b, ...patch }); setSaveMessage('') }
  const editCompliance = (patch: Partial<Compliance>) => { setCompliance(c => c && { ...c, ...patch }); setSaveMessage('') }
  const editAuth = (patch: Partial<Auth>) => { setAuth(a => a && { ...a, ...patch }); setSaveMessage('') }

  const pickLogo = (file: File | undefined) => {
    if (logoInput.current) logoInput.current.value = ''
    if (!file) return
    setBrandingError('')
    if (!LOGO_TYPES.includes(file.type)) { setBrandingError('Logo must be a PNG, JPG, GIF, WEBP or SVG image.'); return }
    if (file.size > LOGO_MAX_BYTES) { setBrandingError('Logo must be 2 MB or smaller.'); return }
    setLogoChange({ file, preview: URL.createObjectURL(file) }); setSaveMessage('')
  }
  const logoShown = logoChange === 'remove' ? '' : logoChange ? logoChange.preview : savedLogoUrl

  // Validate everything first so a bad field doesn't leave the page half-saved.
  const problems = useMemo(() => {
    const p: { branding?: string; compliance?: string; auth?: string } = {}
    if (branding && brandingChanged) {
      if (!branding.productName.trim()) p.branding = 'Product name is required.'
      else if (branding.supportEmail.trim() && !EMAIL_PATTERN.test(branding.supportEmail.trim())) p.branding = 'Enter a valid support email address.'
    }
    if (compliance && complianceChanged) {
      const years = Number(compliance.retention)
      if (!Number.isInteger(years) || years < 1 || years > 25) p.compliance = 'Retention must be between 1 and 25 years.'
    }
    if (auth && savedAuth && auth.timeout !== savedAuth.timeout) {
      const minutes = Number(auth.timeout)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) p.auth = 'Session timeout must be between 1 and 1440 minutes.'
    }
    return p
  }, [branding, brandingChanged, compliance, complianceChanged, auth, savedAuth])

  const saveBranding = async () => {
    if (brandingChanged && branding) {
      const { data } = await platformApi.updateBranding({ product_name: branding.productName.trim(), support_email: branding.supportEmail.trim() || null,
        allow_tenant_branding: branding.allowTenantBranding })
      const b = { productName: data.product_name ?? '', supportEmail: data.support_email ?? '', allowTenantBranding: data.allow_tenant_branding }
      setSavedBranding(b); setBranding(b)
    }
    if (logoChange) {
      const { data } = logoChange === 'remove' ? await platformApi.deleteBrandingLogo() : await platformApi.uploadBrandingLogo(logoChange.file)
      setSavedLogoUrl(data.logo_url ?? ''); setLogoChange(null)
    }
  }

  const saveCompliance = async () => {
    if (!complianceChanged || !compliance) return
    const { data } = await platformApi.updateDataCompliance({ default_region: compliance.region, retention_years: Number(compliance.retention), encrypt_documents_at_rest: compliance.encryptAtRest })
    const c = { region: data.default_region, retention: String(data.retention_years), encryptAtRest: data.encrypt_documents_at_rest }
    setSavedCompliance(c); setCompliance(c)
  }

  // Each authentication setting is its own endpoint: save the changed ones and record each success, so a partial
  // failure leaves only the failed settings marked as unsaved.
  const saveAuth = async () => {
    if (!auth || !savedAuth || !authChanged) return
    const steps: Promise<void>[] = []
    const keep = (patch: Partial<Auth>) => setSavedAuth(s => s && { ...s, ...patch })
    if (auth.forgot !== savedAuth.forgot) steps.push(platformApi.setForgotPassword(auth.forgot).then(({ data }) => keep({ forgot: data.forgot_password_enabled })))
    if (auth.forceFirst !== savedAuth.forceFirst) steps.push(platformApi.setLoginControl('force_first_login', auth.forceFirst).then(({ data }) => keep({ forceFirst: data.enabled })))
    if (auth.deviceAlert !== savedAuth.deviceAlert) steps.push(platformApi.setLoginControl('new_device_alert', auth.deviceAlert).then(({ data }) => keep({ deviceAlert: data.enabled })))
    if (auth.otpMode !== savedAuth.otpMode || auth.captchaMode !== savedAuth.captchaMode)
      steps.push(platformApi.setLoginSecurity({ otp_mode: auth.otpMode, captcha_mode: auth.captchaMode }).then(({ data }) => keep({ otpMode: data.otp_mode, captchaMode: data.captcha_mode })))
    if (auth.timeout !== savedAuth.timeout)
      steps.push(platformApi.setSessionTimeout(Number(auth.timeout)).then(({ data }) => { keep({ timeout: String(data.timeout_minutes) }); window.dispatchEvent(new Event('platform-timeout-changed')) }))
    const results = await Promise.allSettled(steps)
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) throw failed.reason
  }

  const saveAndApply = async () => {
    if (!dirty || saving) return
    setBrandingError(problems.branding ?? ''); setComplianceError(problems.compliance ?? ''); setAuthError(problems.auth ?? ''); setSaveMessage('')
    if (problems.branding || problems.compliance || problems.auth) return
    setSaving(true)
    const [b, c, a] = await Promise.allSettled([saveBranding(), saveCompliance(), saveAuth()])
    if (b.status === 'rejected') setBrandingError(errorText(b.reason, 'Unable to save branding. Please try again.'))
    if (c.status === 'rejected') setComplianceError(errorText(c.reason, 'Unable to save data & compliance. Please try again.'))
    if (a.status === 'rejected') setAuthError(errorText(a.reason, 'Unable to save authentication settings. Please try again.'))
    if ([b, c, a].every(r => r.status === 'fulfilled')) setSaveMessage('All changes saved and applied.')
    setSaving(false)
  }

  const discard = () => {
    setBranding(savedBranding); setCompliance(savedCompliance); setAuth(savedAuth); setLogoChange(null)
    setBrandingError(''); setComplianceError(''); setAuthError(''); setSaveMessage('')
  }

  const brandingLoaded = branding !== null
  const complianceLoaded = compliance !== null
  const authDisabled = saving || auth === null

  return (
    <div className="min-h-full">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2.5">
        <h1 className="text-[17px] font-semibold text-[var(--bw-tx)]">Global settings</h1>
        <div className="flex items-center gap-3">
          {saveMessage && <span role="status" className="text-xs font-medium text-emerald-600">{saveMessage}</span>}
          {dirty && !saving && <>
            <span className="text-xs font-medium text-amber-600">Unsaved changes</span>
            <button type="button" onClick={discard} className="inline-flex h-[34px] items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50">Discard</button>
          </>}
          <button type="button" onClick={saveAndApply} disabled={!dirty || saving} title={dirty ? 'Save and apply every change on this page' : 'No changes to save'}
            className="inline-flex h-[34px] items-center gap-1.5 rounded-md bg-indigo-600 px-3.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">
            <Save size={15} />
            {saving ? 'Saving...' : 'Save & Apply'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Panel title="White-label & branding">
          <div className="space-y-3.5 p-3.5">
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div>
                <label htmlFor="gs-product-name" className={labelClass}>Product name</label>
                <input id="gs-product-name" type="text" maxLength={150} value={branding?.productName ?? ''} disabled={!brandingLoaded || saving} onChange={e => editBranding({ productName: e.target.value })} placeholder="e.g. Azcentrix Connect" className={inputClass} />
              </div>
              <div>
                <label htmlFor="gs-support-email" className={labelClass}>Support email</label>
                <input id="gs-support-email" type="email" maxLength={255} value={branding?.supportEmail ?? ''} disabled={!brandingLoaded || saving} onChange={e => editBranding({ supportEmail: e.target.value })} placeholder="support@example.com" className={inputClass} />
              </div>
            </div>

            <div>
              <span className={labelClass}>Product logo</span>
              <div className="flex items-center gap-3">
                <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed border-slate-300 bg-slate-50">
                  {logoShown
                    ? <img src={logoShown} alt="Product logo preview" className="h-full w-full object-contain p-1" />
                    : <ImagePlus size={18} className="text-slate-400" />}
                </div>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button type="button" disabled={!brandingLoaded || saving} onClick={() => logoInput.current?.click()} className="inline-flex h-7 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[13px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60">
                      {logoShown ? 'Change logo' : 'Upload logo'}
                    </button>
                    {logoShown && (
                      <button type="button" disabled={saving} onClick={() => { setLogoChange(savedLogoUrl ? 'remove' : null); setSaveMessage('') }} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-60">
                        <Trash2 size={13} /> Remove
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-slate-400">
                    PNG, JPG, GIF, WEBP or SVG · max 2 MB
                    {logoChange && <span className="text-amber-600"> · {logoChange === 'remove' ? 'will be removed' : 'new logo'} on Save &amp; Apply</span>}
                  </p>
                </div>
                <input ref={logoInput} type="file" accept={LOGO_TYPES.join(',')} className="hidden" onChange={e => pickLogo(e.target.files?.[0])} />
              </div>
            </div>

            <div>
              <span className={labelClass}>Allow tenants to set own logo &amp; colour</span>
              <Toggle checked={branding?.allowTenantBranding ?? false} label="Allow tenants to set own logo and colour" disabled={!brandingLoaded || saving} onChange={() => editBranding({ allowTenantBranding: !branding?.allowTenantBranding })} />
            </div>
            {brandingError && <p role="alert" className="text-xs text-red-600">{brandingError}</p>}
          </div>
        </Panel>

        <Panel title="Data & compliance">
          <div className="space-y-3.5 p-3.5">
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div>
                <label htmlFor="gs-region" className={labelClass}>Default region</label>
                <select id="gs-region" value={compliance?.region ?? 'ap-south-1'} disabled={!complianceLoaded || saving} onChange={e => editCompliance({ region: e.target.value })} className={inputClass}>
                  {REGION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="gs-retention" className={labelClass}>Retention (years)</label>
                <input id="gs-retention" type="number" min="1" max="25" value={compliance?.retention ?? ''} disabled={!complianceLoaded || saving} onChange={e => editCompliance({ retention: e.target.value })} className={inputClass} />
              </div>
            </div>
            <div>
              <span className={labelClass}>Encrypt documents at rest</span>
              <Toggle checked={compliance?.encryptAtRest ?? false} label="Encrypt documents at rest" disabled={!complianceLoaded || saving} onChange={() => editCompliance({ encryptAtRest: !compliance?.encryptAtRest })} />
            </div>
            {complianceError && <p role="alert" className="text-xs text-red-600">{complianceError}</p>}
          </div>
        </Panel>

        <Panel title="Authentication defaults">
          {([
            { key: 'forgot', title: 'Forgot Password', hint: 'Users can request a password reset link from the login screen.' },
            { key: 'forceFirst', title: 'Force Change On First Login', hint: 'Require newly created users to change their initial password after signing in.' },
            { key: 'deviceAlert', title: 'New Device Login Alert', hint: 'Send an alert when an account signs in from a new browser or device.' },
          ] as const).map(item => (
            <Row key={item.key} label={item.title} hint={item.hint}>
              <Toggle checked={auth?.[item.key] ?? false} label={item.title} disabled={authDisabled} onChange={() => editAuth({ [item.key]: !auth?.[item.key] })} />
            </Row>
          ))}
          <Row label="Two-Step OTP Verification" hint="Email a one-time code to the administrator before the session starts. Needs platform SMTP.">
            <select aria-label="Two-Step OTP Verification" value={auth?.otpMode ?? 'never'} disabled={authDisabled} onChange={e => editAuth({ otpMode: e.target.value as PlatformOtpMode })} className={`${inputClass} !h-7 !w-36 !text-[13px]`}>
              {OTP_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Row>
          <Row label="Captcha Verification" hint="Choose when a captcha challenge is required during sign-in.">
            <select aria-label="Captcha Verification" value={auth?.captchaMode ?? 'never'} disabled={authDisabled} onChange={e => editAuth({ captchaMode: e.target.value as PlatformCaptchaMode })} className={`${inputClass} !h-7 !w-36 !text-[13px]`}>
              {verification_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Row>
          <Row label="Session timeout (minutes)" hint="Inactive platform sessions expire after the selected time.">
            <input aria-label="Session timeout in minutes" type="number" min="1" max="1440" value={auth?.timeout ?? ''} disabled={authDisabled} onChange={e => editAuth({ timeout: e.target.value })} className={`${inputClass} !h-7 !w-20 !text-[13px]`} />
          </Row>
          {authError && (
            <div className="border-t border-slate-200 px-3.5 py-2">
              <p role="alert" className="text-xs text-red-600">{authError}</p>
            </div>
          )}
        </Panel>

        <Panel title="Email & notification channels">
          {channels === null && <p className="px-3.5 py-3 text-sm text-slate-400">Loading channels...</p>}
          {channels?.length === 0 && <p className="px-3.5 py-3 text-sm text-slate-400">Unable to load channel status.</p>}
          {channels?.map(channel => (
            <Row key={channel.key} label={channel.label}>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${channel.connected ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                {channel.connected ? 'Connected' : 'Disconnected'}
              </span>
            </Row>
          ))}
        </Panel>
      </div>
    </div>
  )
}
