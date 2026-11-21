import React from 'react'
import { FormFieldConfig } from '@/hooks/useFormConfig'
import { FormField } from '@/components/ui/Input'

interface CustomFieldsProps {
  section: string
  fields: FormFieldConfig[]
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  disabled?: boolean
}

export function CustomFields({ section, fields, values, onChange, disabled }: CustomFieldsProps) {
  const visible = fields.filter(f => f.section === section && f.is_custom && f.is_visible)
  if (!visible.length) return null

  return (
    <>
      {visible.map(f => (
        <div key={f.field_key} className={f.col_span === 2 ? 'sm:col-span-2' : ''}>
          <CustomFieldInput
            field={f}
            value={values[f.field_key]}
            onChange={v => onChange(f.field_key, v)}
            disabled={disabled}
          />
        </div>
      ))}
    </>
  )
}

interface InputProps {
  field: FormFieldConfig
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
}

function CustomFieldInput({ field, value, onChange, disabled }: InputProps) {
  const base = `form-control ${disabled ? 'opacity-60' : ''}`

  if (field.field_type === 'select') {
    const opts = normalizeOptions(field.options)
    return (
      <FormField label={field.label} required={field.is_required}>
        <select
          value={String(value ?? '')}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          className={base}
        >
          <option value="">{field.placeholder || `Select ${field.label}`}</option>
          {opts.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </FormField>
    )
  }

  if (field.field_type === 'textarea') {
    return (
      <FormField label={field.label} required={field.is_required}>
        <textarea
          value={String(value ?? '')}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder}
          disabled={disabled}
          rows={3}
          className={base}
        />
      </FormField>
    )
  }

  if (field.field_type === 'checkbox') {
    return (
      <FormField label={field.label} required={field.is_required}>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={e => onChange(e.target.checked)}
            disabled={disabled}
            className="w-4 h-4 rounded border-gray-300 text-indigo-600"
          />
          <span className="text-sm text-gray-700">{field.label}</span>
        </label>
      </FormField>
    )
  }

  const htmlType: React.HTMLInputTypeAttribute =
    field.field_type === 'number'   ? 'number'
    : field.field_type === 'date'   ? 'date'
    : field.field_type === 'email'  ? 'email'
    : field.field_type === 'url'    ? 'url'
    : field.field_type === 'phone'  ? 'tel'
    : 'text'

  return (
    <FormField label={field.label} required={field.is_required}>
      <input
        type={htmlType}
        value={String(value ?? '')}
        onChange={e => onChange(e.target.value)}
        placeholder={field.placeholder}
        disabled={disabled}
        className={base}
      />
    </FormField>
  )
}

function normalizeOptions(raw: FormFieldConfig['options']): { value: string; label: string }[] {
  if (!raw) return []
  return raw.map(o =>
    typeof o === 'string' ? { value: o, label: o } : o,
  )
}
