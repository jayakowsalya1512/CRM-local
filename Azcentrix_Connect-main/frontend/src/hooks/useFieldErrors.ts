// Real-time field validation state shared by every form.
//  • change → format errors show immediately; the "required" error waits until the field was left once (or submit)
//  • blur   → full check (required + format)
//  • submit → validateAll() checks everything, shows every message and returns false if anything is invalid
// Messages disappear as soon as the value becomes valid. Entered data is never touched.
import { useCallback, useRef, useState } from 'react'
import { validate, type FieldSpec, type Val } from '@/utils/validation'

export type SpecMap = Record<string, FieldSpec | undefined>

export function useFieldErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const touched = useRef<Set<string>>(new Set())

  const put = useCallback((id: string, msg: string) => {
    setErrors(e => ((e[id] || '') === msg ? e : msg ? { ...e, [id]: msg } : (() => { const n = { ...e }; delete n[id]; return n })()))
  }, [])

  /** Call from onChange with the new value. */
  const change = useCallback((id: string, value: Val, spec?: FieldSpec) => {
    if (!spec) { put(id, ''); return }
    const full = validate(value, spec)
    // while typing, an empty required field only complains after the user has left it once
    const msg = !touched.current.has(id) && full && validate(value, { ...spec, required: false }) === '' ? '' : full
    put(id, msg)
  }, [put])

  /** Call from onBlur. */
  const blur = useCallback((id: string, value: Val, spec?: FieldSpec) => {
    touched.current.add(id)
    if (spec) put(id, validate(value, spec))
  }, [put])

  /** Validate every field; returns the error map (empty = valid). */
  const validateAll = useCallback((values: Record<string, Val>, specs: SpecMap, extra: Record<string, string> = {}) => {
    const out: Record<string, string> = {}
    for (const [id, spec] of Object.entries(specs)) {
      if (!spec) continue
      touched.current.add(id)
      const m = validate(values[id], spec)
      if (m) out[id] = m
    }
    for (const [id, m] of Object.entries(extra)) if (m && !out[id]) out[id] = m
    setErrors(out)
    return out
  }, [])

  const clear = useCallback((id?: string) => {
    if (id) put(id, '')
    else { touched.current.clear(); setErrors({}) }
  }, [put])

  return { errors, setErrors, change, blur, validateAll, clear, setError: put }
}
