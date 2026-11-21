// Field validation wiring for small modal / drawer forms (milestones, invoices, progress, release / extend …) that keep
// their values in one state object. Built on useFieldErrors + the shared rules in utils/validation, so modals behave
// exactly like the full-page forms: format errors while typing, "required" after the field was left once, every
// message on submit, first invalid field focused, server field errors mapped back under their fields.
import { useFieldErrors, type SpecMap } from '@/hooks/useFieldErrors'
import { mapApiErrors, validate, type Val } from '@/utils/validation'

export function useModalValidation<T extends object>(
  values: T,
  specs: (x: T) => SpecMap,
  extra: (x: T) => Record<string, string> = () => ({}),
  elIds: Record<string, string> = {},
) {
  const fe = useFieldErrors()
  const valOf = (x: T, k: string) => (x as Record<string, Val>)[k]
  const run = (k: string, x: T, mode: 'change' | 'blur') => {
    const sp = specs(x)[k], val = valOf(x, k)
    if (!sp) { fe.setError(k, mode === 'blur' || fe.errors[k] ? extra(x)[k] || '' : ''); return }   // field not applicable (any more)
    if (mode === 'change') fe.change(k, val, sp); else fe.blur(k, val, sp)
    const m = extra(x)[k]
    if (m && (!sp || !validate(val, sp))) fe.setError(k, m)
  }
  const focus = (keys: string[], bad: Record<string, string>) => {
    const k = keys.find(x => bad[x]), el = k ? document.getElementById(elIds[k] ?? k) : null
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() }
  }
  return {
    errors: fe.errors,
    /** Call after a value changed: `next` is the new state, `keys` the fields that changed. Fields already showing an error are re-checked (cross-field rules). */
    change: (next: T, ...keys: string[]) => {
      keys.forEach(k => run(k, next, 'change'))
      Object.keys(fe.errors).filter(k => !keys.includes(k)).forEach(k => run(k, next, 'blur'))
    },
    blur: (k: string) => run(k, values, 'blur'),
    /** Props for an input: red border flag, aria-invalid, onBlur. */
    bad: (k: string) => !!fe.errors[k],
    aria: (k: string) => ({ 'aria-invalid': fe.errors[k] ? true : undefined, 'aria-describedby': fe.errors[k] ? `${elIds[k] ?? k}-err` : undefined, onBlur: () => run(k, values, 'blur') }),
    /** Validate everything; returns true when the form may be submitted. */
    submit: (): boolean => {
      const sp = specs(values), ex = extra(values)
      const bad = fe.validateAll(values as Record<string, Val>, sp, ex)
      if (!Object.keys(bad).length) return true
      focus([...Object.keys(sp), ...Object.keys(ex)], bad)
      return false
    },
    /** Map a failed request's field errors onto the form; returns false when nothing could be mapped (show a toast then). */
    server: (e: unknown, map: Record<string, string> = {}): boolean => {
      const sp = specs(values), ex = extra(values), keys = [...Object.keys(sp), ...Object.keys(ex)]
      const known = Object.fromEntries(Object.entries(mapApiErrors(e, map)).filter(([k]) => k in sp || k in ex || keys.includes(k)))
      if (!Object.keys(known).length) return false
      fe.setErrors(x => ({ ...x, ...known })); focus(keys, known)
      return true
    },
    clear: fe.clear,
  }
}
