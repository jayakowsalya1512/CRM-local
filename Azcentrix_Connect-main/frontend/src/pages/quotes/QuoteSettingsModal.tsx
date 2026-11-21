// Settings → Quotes (settings.manage): default GST %, validity days, maximum line discount and the default
// commercial terms (Payment · Delivery · Warranty). Stored in the tenant settings table; empty = not configured.
import { useEffect, useState } from 'react'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { errMsg, quoteApi } from './quoteApi'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import type { FieldSpec } from '@/utils/validation'

type F = { gst_percent: string; validity_days: string; max_discount: string; payment: string; delivery: string; warranty: string }
const s = (v: unknown) => v == null ? '' : String(v)
// backend quote_service.save_config: GST % / max discount 0–100, validity 0–3650 days; ConfigIn terms ≤ 1000 characters
const SPEC: Record<keyof F, FieldSpec> = {
  gst_percent: { label: 'Default GST %', rule: 'percent' }, validity_days: { label: 'Default validity', rule: 'integer', min: 0, max: 3650 },
  max_discount: { label: 'Maximum line discount %', rule: 'percent' }, payment: { label: 'Payment terms', rule: 'textarea', max: 1000 },
  delivery: { label: 'Delivery terms', rule: 'textarea', max: 1000 }, warranty: { label: 'Warranty', rule: 'textarea', max: 1000 },
}
const IDS: Record<keyof F, string> = { gst_percent: 'qs-gst', validity_days: 'qs-val', max_discount: 'qs-disc', payment: 'qs-pay', delivery: 'qs-del', warranty: 'qs-war' }

export default function QuoteSettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { success, error } = useToast()
  const [f, setF] = useState<F | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    quoteApi.config().then(c => setF({ gst_percent: s(c.gst_percent), validity_days: s(c.validity_days), max_discount: s(c.max_discount), payment: s(c.payment), delivery: s(c.delivery), warranty: s(c.warranty) }))
      .catch(e => { error(errMsg(e, 'Could not load quote settings')); onClose() })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const fe = useFieldErrors(), er = fe.errors
  const set = (k: keyof F, v: string) => { setF(x => x ? { ...x, [k]: v } : x); fe.change(k, v, SPEC[k]) }
  const a = (k: keyof F) => ({ className: `in ${er[k] ? 'err' : ''}`, onBlur: () => f && fe.blur(k, f[k], SPEC[k]), 'aria-invalid': er[k] ? true : undefined, 'aria-describedby': er[k] ? `${IDS[k]}-err` : undefined })
  return <Modal title="Quote settings" width={560} onClose={onClose} foot={<><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={!f || busy} onClick={async () => {
      if (!f) return
      const bad = fe.validateAll(f, SPEC)
      if (Object.keys(bad).length) { const k = (Object.keys(IDS) as (keyof F)[]).find(x => bad[x]); if (k) document.getElementById(IDS[k])?.focus(); return }
      setBusy(true)
      try { await quoteApi.saveConfig(f); success('Quote settings saved'); onSaved() } catch (e) { error(errMsg(e, 'Could not save')) } finally { setBusy(false) }
    }}>{busy ? 'Saving…' : 'Save'}</button></>}>
    {!f ? <div className="empty">Loading…</div> : <div className="fg">
      <div><label htmlFor="qs-gst">Default GST %</label><input id="qs-gst" {...a('gst_percent')} type="number" min={0} max={100} step="0.01" value={f.gst_percent} onChange={e => set('gst_percent', e.target.value)} />
        <FieldError id="qs-gst" msg={er.gst_percent} />{!er.gst_percent && <small>Applied to new lines; a catalogue product's own GST % wins.</small>}</div>
      <div><label htmlFor="qs-val">Default validity (days)</label><input id="qs-val" {...a('validity_days')} type="number" min={0} max={3650} value={f.validity_days} onChange={e => set('validity_days', e.target.value)} />
        <FieldError id="qs-val" msg={er.validity_days} />{!er.validity_days && <small>Pre-fills Valid till on new quotes.</small>}</div>
      <div><label htmlFor="qs-disc">Maximum line discount %</label><input id="qs-disc" {...a('max_discount')} type="number" min={0} max={100} step="0.01" value={f.max_discount} onChange={e => set('max_discount', e.target.value)} />
        <FieldError id="qs-disc" msg={er.max_discount} />{!er.max_discount && <small>Empty = no limit.</small>}</div>
      <div />
      <div className="f1"><label htmlFor="qs-pay">Payment terms</label><textarea id="qs-pay" {...a('payment')} rows={2} value={f.payment} onChange={e => set('payment', e.target.value)} /><FieldError id="qs-pay" msg={er.payment} /></div>
      <div className="f1"><label htmlFor="qs-del">Delivery terms</label><textarea id="qs-del" {...a('delivery')} rows={2} value={f.delivery} onChange={e => set('delivery', e.target.value)} /><FieldError id="qs-del" msg={er.delivery} /></div>
      <div className="f1"><label htmlFor="qs-war">Warranty</label><textarea id="qs-war" {...a('warranty')} rows={2} value={f.warranty} onChange={e => set('warranty', e.target.value)} /><FieldError id="qs-war" msg={er.warranty} /></div>
      <div className="f1"><small className="mu">These are the defaults every quote shows under Commercial terms; a quote can override them on its own page.</small></div>
    </div>}
  </Modal>
}
