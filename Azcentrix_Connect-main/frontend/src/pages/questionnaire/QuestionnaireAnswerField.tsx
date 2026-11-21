import { useState } from 'react'
import { Star } from 'lucide-react'
import { Input, Textarea } from '@/components/ui/Input'
import { DatePicker } from '@/components/ui/FormComponents'
import SearchableSelect, { MultiSearchableSelect, SelectOption } from '@/components/ui/SearchableSelect'
import DropFileUpload from '@/components/ui/DropFileUpload'
import { Ic } from '@/components/crm/kit'
import { isYesNoAnswerType } from './questionnaireFormShared'
import FilePreviewModal from './FilePreviewModal'
import '@/pages/notifications/inbox.css'

const RATING_MAX = 5

function StarRating({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const current = parseInt(value, 10) || 0
  const [hovered, setHovered] = useState(0)
  const active = hovered || current
  return (
    <div className="row" style={{ gap: 2, display: 'inline-flex' }}>
      {Array.from({ length: RATING_MAX }, (_, i) => i + 1).map((star) => (
        <button
          key={star}
          type="button"
          disabled={disabled}
          onClick={() => onChange(String(star))}
          onMouseEnter={() => !disabled && setHovered(star)}
          onMouseLeave={() => !disabled && setHovered(0)}
          className="disabled:cursor-not-allowed"
          style={{ background: 'none', border: 'none', padding: 2, cursor: disabled ? 'default' : 'pointer' }}
          title={`${star} star${star > 1 ? 's' : ''}`}
        >
          <Star
            size={20}
            className={star <= active ? 'fill-amber-400 text-amber-400' : 'fill-transparent text-gray-300'}
          />
        </button>
      ))}
    </div>
  )
}

export interface QElement {
  id: number
  element_code: string
  element_label: string
  element_type?: 'question' | 'field'
  input_type: string
  is_required: boolean
  allow_remarks?: boolean
  display_order?: number
  show_when_operator?: string | null
  show_when_value?: string | null
  options_json?: unknown
  placeholder?: string | null
  default_value?: string | null
  validation_json?: unknown
  parent_element_id?: number | null
  section_id?: number
  subsection_id?: number
  is_active?: boolean
}

function staticOptions(el: QElement): SelectOption[] | null {
  const opts = el.options_json
  if (Array.isArray(opts)) return opts as SelectOption[]
  return null
}

interface Props {
  element: QElement
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
  error?: string
  masterOptions?: SelectOption[]
  onUploadFile?: (file: File) => Promise<void>
}

const YES_NO = [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]
const YES_NO_NA = [
  { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' },
  { value: 'unknown', label: 'Unknown' }, { value: 'not_applicable', label: 'N/A' },
]

function SegmentedControl({ options, value, onChange, disabled }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="tabs" style={{ display: 'inline-flex' }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`tab ${value === o.value ? 'on' : ''} disabled:cursor-not-allowed`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export default function QuestionnaireAnswerField({ element, value, onChange, readOnly, error, masterOptions, onUploadFile }: Props) {
  const [uploading, setUploading] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const options = staticOptions(element) || masterOptions || []
  const t = element.input_type

  if (isYesNoAnswerType(t)) return <SegmentedControl options={YES_NO} value={value} onChange={onChange} disabled={readOnly} />
  if (t === 'yes_no_na') return <SegmentedControl options={YES_NO_NA} value={value} onChange={onChange} disabled={readOnly} />

  if (t === 'textarea') {
    return <Textarea value={value} onChange={(e) => onChange(e.target.value)} disabled={readOnly} error={error} placeholder={element.placeholder || ''} rows={3} />
  }
  if (t === 'checkbox') {
    return (
      <label className="sw" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={value === 'true'}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        />
        <i />
        {error && <span className="pill ba" style={{ marginLeft: 6 }}>{error}</span>}
      </label>
    )
  }
  if (t === 'date') {
    return <DatePicker value={value} onChange={onChange} disabled={readOnly} error={error} />
  }
  if (t === 'rating') {
    return <StarRating value={value} onChange={onChange} disabled={readOnly} />
  }
  if (t === 'time') {
    return <Input type="time" value={value} onChange={(e) => onChange(e.target.value)} disabled={readOnly} error={error} />
  }
  if (t === 'single_select') {
    return (
      <SearchableSelect
        options={options}
        value={value || null}
        onChange={(v) => onChange(v == null ? '' : String(v))}
        disabled={readOnly}
        error={error}
        placeholder={element.placeholder || 'Select...'}
        clearable
      />
    )
  }
  if (t === 'multi_select') {
    const arr = value ? value.split(',').filter(Boolean) : []
    return (
      <MultiSearchableSelect
        options={options}
        value={arr}
        onChange={(v) => onChange(v.join(','))}
        disabled={readOnly}
        error={error}
        placeholder={element.placeholder || 'Select...'}
      />
    )
  }
  if (t === 'file') {
    return (
      <div className="mt">
        <DropFileUpload
          label={value ? 'Replace file' : 'Upload file'}
          variant="compact"
          disabled={readOnly}
          uploading={uploading}
          onFile={async (file) => {
            if (!onUploadFile) return
            setUploading(true)
            try { await onUploadFile(file) } finally { setUploading(false) }
          }}
        />
        {value && (
          <button type="button" onClick={() => setPreviewOpen(true)} className="btn g s mt" style={{ display: 'inline-flex' }}>
            <Ic n="eye" /> View uploaded file
          </button>
        )}
        {previewOpen && value && <FilePreviewModal fileUrl={value} onClose={() => setPreviewOpen(false)} />}
      </div>
    )
  }

  const commonProps = {
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    disabled: readOnly,
    error,
    placeholder: element.placeholder || '',
  }
  if (t === 'number') return <Input type="number" step="1" {...commonProps} />
  if (t === 'year') return <Input type="number" step="1" min={1900} max={2100} {...commonProps} />
  if (t === 'decimal' || t === 'currency') return <Input type="number" step="0.01" {...commonProps} />
  if (t === 'percentage') return <Input type="number" step="0.01" min={0} max={100} {...commonProps} />
  if (t === 'email') return <Input type="email" {...commonProps} />
  if (t === 'mobile') {
    return (
      <Input
        type="tel"
        inputMode="numeric"
        maxLength={10}
        {...commonProps}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 10))}
      />
    )
  }
  return <Input type="text" {...commonProps} />
}
