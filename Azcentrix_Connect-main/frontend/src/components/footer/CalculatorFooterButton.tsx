// Prototype v17 footer tab('calc','table','Calculator') — "Price & margin calculator"
// (I.calc() in the prototype: cost/markup/discount/GST -> list price, net, GST, customer
// pays, gross margin). Also adds a plain arithmetic calculator as a second tab, since the
// prototype only ever had the margin one.
import { useEffect, useRef, useState } from 'react'
import { Calculator, X } from 'lucide-react'
import { inr } from '@/pages/customers/customerApi'
import { useFooterPanelStore } from '@/store/footerPanelStore'

type Tab = 'margin' | 'basic'
type Op = '+' | '−' | '×' | '÷'

// Remembers the last values this user typed – it used to always reset to a fixed
// placeholder (cost 1,000,000 / markup 22% / discount 5% / GST 18%) on every reopen,
// which looked like the calculator was "fetching" the wrong defaults each time.
const STORAGE_KEY = 'footer-margin-calc-v1'
const DEFAULTS = { cost: '1000000', markup: '22', discount: '5', gstPct: '18' }
function loadSaved(): typeof DEFAULTS {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw)
    return { ...DEFAULTS, ...parsed }
  } catch { return DEFAULTS }
}

function MarginCalculator() {
  const saved = useRef(loadSaved()).current
  const [cost, setCost] = useState(saved.cost)
  const [markup, setMarkup] = useState(saved.markup)
  const [discount, setDiscount] = useState(saved.discount)
  const [gstPct, setGstPct] = useState(saved.gstPct)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ cost, markup, discount, gstPct })) } catch { /* private mode */ }
  }, [cost, markup, discount, gstPct])

  const c = Number(cost) || 0
  const mk = Number(markup) || 0
  const dc = Number(discount) || 0
  const gs = Number(gstPct) || 0
  const list = c * (1 + mk / 100)
  const net = list * (1 - dc / 100)
  const gst = net * gs / 100
  const margin = net ? Math.round((net - c) / net * 1000) / 10 : 0
  const marginTone = margin < 12 ? 'var(--color-danger)' : margin < 18 ? 'var(--color-warning)' : 'var(--color-success)'

  const field = (label: string, value: string, onChange: (v: string) => void) => (
    <div style={{ flex: '1 1 110px' }}>
      <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</label>
      <input className="form-control" type="number" value={value} onChange={(e) => onChange(e.target.value)} style={{ height: 30, fontSize: 12 }} />
    </div>
  )

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {field('Cost (₹)', cost, setCost)}
        {field('Markup %', markup, setMarkup)}
        {field('Discount %', discount, setDiscount)}
        {field('GST %', gstPct, setGstPct)}
      </div>
      <table style={{ width: '100%', marginTop: 12, fontSize: 13, borderCollapse: 'collapse' }}>
        <tbody>
          <tr><td style={{ padding: '4px 0', color: 'var(--text-secondary, #64748B)' }}>List price</td><td style={{ textAlign: 'right' }}>{inr(list)}</td></tr>
          <tr><td style={{ padding: '4px 0', color: 'var(--text-secondary, #64748B)' }}>After discount</td><td style={{ textAlign: 'right' }}>{inr(net)}</td></tr>
          <tr><td style={{ padding: '4px 0', color: 'var(--text-secondary, #64748B)' }}>GST</td><td style={{ textAlign: 'right' }}>{inr(gst)}</td></tr>
          <tr style={{ borderTop: '1px solid var(--border)' }}><td style={{ padding: '6px 0', fontWeight: 700 }}>Customer pays</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{inr(net + gst)}</td></tr>
          <tr><td style={{ padding: '4px 0', color: 'var(--text-secondary, #64748B)' }}>Gross margin</td><td style={{ textAlign: 'right', fontWeight: 700, color: marginTone }}>{margin}%</td></tr>
        </tbody>
      </table>
    </div>
  )
}

function BasicCalculator() {
  const [display, setDisplay] = useState('0')
  const [stored, setStored] = useState<number | null>(null)
  const [operator, setOperator] = useState<Op | null>(null)
  const [waiting, setWaiting] = useState(false)

  const apply = (op: Op, a: number, b: number) => {
    switch (op) {
      case '+': return a + b
      case '−': return a - b
      case '×': return a * b
      case '÷': return b === 0 ? NaN : a / b
    }
  }

  const inputDigit = (d: string) => {
    if (waiting) { setDisplay(d); setWaiting(false); return }
    setDisplay((cur) => (cur === '0' ? d : cur.length < 15 ? cur + d : cur))
  }
  const inputDecimal = () => {
    if (waiting) { setDisplay('0.'); setWaiting(false); return }
    setDisplay((cur) => (cur.includes('.') ? cur : cur + '.'))
  }
  const clear = () => { setDisplay('0'); setStored(null); setOperator(null); setWaiting(false) }
  const toggleSign = () => setDisplay((cur) => (cur.startsWith('-') ? cur.slice(1) : cur === '0' ? cur : `-${cur}`))
  const percent = () => setDisplay((cur) => String(parseFloat(cur) / 100))
  const backspace = () => setDisplay((cur) => (cur.length > 1 ? cur.slice(0, -1) : '0'))

  const chooseOperator = (op: Op) => {
    const current = parseFloat(display)
    if (operator && stored !== null && !waiting) {
      const result = apply(operator, stored, current)
      setDisplay(Number.isFinite(result) ? String(result) : 'Error')
      setStored(Number.isFinite(result) ? result : null)
    } else {
      setStored(current)
    }
    setOperator(op)
    setWaiting(true)
  }

  const equals = () => {
    if (operator === null || stored === null) return
    const current = parseFloat(display)
    const result = apply(operator, stored, current)
    setDisplay(Number.isFinite(result) ? String(result) : 'Error')
    setStored(null)
    setOperator(null)
    setWaiting(true)
  }

  const btn = (label: string, onClick: () => void, variant: 'num' | 'op' | 'fn' | 'eq' = 'num') => (
    <button type="button" className={`calc-key calc-key-${variant}`} onClick={onClick}>{label}</button>
  )

  return (
    <div style={{ padding: 12 }}>
      <div className="calc-display">{display}</div>
      <div className="calc-grid">
        {btn('C', clear, 'fn')}
        {btn('±', toggleSign, 'fn')}
        {btn('%', percent, 'fn')}
        {btn('÷', () => chooseOperator('÷'), 'op')}
        {btn('7', () => inputDigit('7'))}
        {btn('8', () => inputDigit('8'))}
        {btn('9', () => inputDigit('9'))}
        {btn('×', () => chooseOperator('×'), 'op')}
        {btn('4', () => inputDigit('4'))}
        {btn('5', () => inputDigit('5'))}
        {btn('6', () => inputDigit('6'))}
        {btn('−', () => chooseOperator('−'), 'op')}
        {btn('1', () => inputDigit('1'))}
        {btn('2', () => inputDigit('2'))}
        {btn('3', () => inputDigit('3'))}
        {btn('+', () => chooseOperator('+'), 'op')}
        {btn('0', () => inputDigit('0'))}
        {btn('.', inputDecimal)}
        {btn('⌫', backspace)}
        {btn('=', equals, 'eq')}
      </div>
    </div>
  )
}

export default function CalculatorFooterButton() {
  const open = useFooterPanelStore((s) => s.panel === 'calculator')
  const toggle = useFooterPanelStore((s) => s.toggle)
  const closePanel = useFooterPanelStore((s) => s.close)
  const [tab, setTab] = useState<Tab>('margin')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closePanel() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closePanel() }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc) }
  }, [open, closePanel])

  return <div ref={ref} style={{ display: 'contents' }}>
    <button type="button" className={`tn-ftb ${open ? 'on' : ''}`} onClick={() => toggle('calculator')} aria-expanded={open} aria-haspopup="dialog">
      <Calculator size={15} /><span>Calculator</span>
    </button>
    {open && <div className="tn-ftpn" role="dialog" aria-label="Calculator">
      <div className="tn-fth">
        <Calculator size={15} /><b>{tab === 'margin' ? 'Price & margin calculator' : 'Calculator'}</b><span className="flex-1" />
        <button type="button" className="tn-x" onClick={closePanel} aria-label="Close"><X size={15} /></button>
      </div>
      <div className="calc-tabs">
        <button type="button" className={tab === 'margin' ? 'on' : ''} onClick={() => setTab('margin')}>Price & margin</button>
        <button type="button" className={tab === 'basic' ? 'on' : ''} onClick={() => setTab('basic')}>Calculator</button>
      </div>
      {tab === 'margin' ? <MarginCalculator /> : <BasicCalculator />}
    </div>}
  </div>
}
