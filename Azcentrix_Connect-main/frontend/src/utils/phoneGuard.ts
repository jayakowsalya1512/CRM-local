/**
 * App-wide guard for phone / mobile inputs: they accept digits only and at most 10 of them – extra digits are never
 * entered (typing stops at 10, a paste is trimmed to 10) instead of showing "Maximum 10 digits allowed." afterwards.
 *
 * A field counts as a phone field with the same rule the validators use (utils/validation.ts → inferRule): input
 * type "tel", or its id / name / data-f / aria-label / placeholder / autocomplete / label text mentions mobile, phone,
 * cell or WhatsApp (and not e-mail). Opt a field out with data-phone="off".
 *
 * Works with React controlled inputs: the trimmed value is written through the native value setter in the capture
 * phase, before React's own listener reads it, so onChange receives the trimmed value.
 */
const MAX = 10
const PHONE_RE = /mobile|phone|\bcell\b|whatsapp|contact\s*no/i
const NOT_RE = /e-?mail|search|filter/i
const TYPES = new Set(['', 'text', 'tel', 'number', 'search'])
const seen = new WeakMap<HTMLInputElement, boolean>()
const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set

function labelText(el: HTMLInputElement): string {
  const parts: string[] = []
  el.labels?.forEach(l => parts.push(l.textContent || ''))
  let n: Element | null = el
  for (let i = 0; i < 2 && n && !parts.length; i++) {           // <label>Phone</label><input> or <label/><div><input/></div>
    const prev: Element | null = n.previousElementSibling
    if (prev && prev.tagName === 'LABEL') parts.push(prev.textContent || '')
    n = n.parentElement
  }
  return parts.join(' ')
}

function isPhone(el: HTMLInputElement): boolean {
  const cached = seen.get(el)
  if (cached !== undefined) return cached
  let ok = false
  if (el.dataset.phone !== 'off' && TYPES.has((el.getAttribute('type') || '').toLowerCase())) {
    if ((el.getAttribute('type') || '').toLowerCase() === 'tel') ok = true
    else {
      const key = [el.id, el.name, el.dataset.f, el.getAttribute('aria-label'), el.placeholder, el.autocomplete, labelText(el)].join(' ')
      ok = PHONE_RE.test(key) && !NOT_RE.test(key)
    }
  }
  seen.set(el, ok)
  return ok
}

function clean(v: string): string {
  return v.replace(/\D/g, '').slice(0, MAX)
}

export function installPhoneGuard(): void {
  if (typeof document === 'undefined' || (window as any).__phoneGuard) return
  ;(window as any).__phoneGuard = true

  // Stop a keystroke that would add an 11th digit (keeps the caret where it is).
  document.addEventListener('beforeinput', e => {
    const el = e.target
    if (!(el instanceof HTMLInputElement) || !isPhone(el)) return
    const ie = e as InputEvent
    if (!ie.inputType?.startsWith('insert') || ie.inputType === 'insertFromPaste') return
    const data = ie.data ?? ''
    if (data && /\D/.test(data)) { e.preventDefault(); return }
    const selLen = el.selectionStart != null && el.selectionEnd != null ? el.selectionEnd - el.selectionStart : 0
    if (clean(el.value).length - selLen + data.length > MAX) e.preventDefault()
  }, true)

  // Pastes, autofill and anything else: trim to digits / 10 before React sees the change.
  document.addEventListener('input', e => {
    const el = e.target
    if (!(el instanceof HTMLInputElement) || !isPhone(el)) return
    const v = clean(el.value)
    if (v !== el.value && nativeSet) nativeSet.call(el, v)
  }, true)

  // Numeric keypad on phones / tablets.
  document.addEventListener('focusin', e => {
    const el = e.target
    if (el instanceof HTMLInputElement && isPhone(el) && !el.inputMode) el.inputMode = 'numeric'
  }, true)
}
