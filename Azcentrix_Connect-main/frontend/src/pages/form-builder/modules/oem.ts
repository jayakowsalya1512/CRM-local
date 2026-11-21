import { Factory } from 'lucide-react'
import type { BuiltinField } from '../constants'

export const oemMeta = {
  key: 'oem',
  label: 'OEM',
  icon: Factory,
}

export const oemFields: Record<string, BuiltinField[]> = {
  oem_details: [
    { field_key: 'name', default_label: 'OEM / Brand Name', default_required: true },
    { field_key: 'product_id', default_label: 'Category / Product Line', field_type: 'select', default_required: true },
    { field_key: 'account_manager', default_label: 'Account Manager', default_required: true },
    { field_key: 'auth_number', default_label: 'Auth Certificate No.', default_required: true },
    { field_key: 'auth_date', default_label: 'Auth Expiry Date', field_type: 'date', default_required: true },
    { field_key: 'support_sla', default_label: 'Support SLA', default_required: true },
    { field_key: 'credit_limit', default_label: 'Credit Limit (₹)', field_type: 'number', default_required: true },
    { field_key: 'payment_terms', default_label: 'Payment Terms', default_required: true },
    { field_key: 'brands_handled', default_label: 'Brands / OEMs Handled', default_required: true },
  ],

  contact: [
    { field_key: 'contact_name', default_label: 'Contact Name', default_required: true },
    { field_key: 'contact_designation', default_label: 'Designation', default_required: true },
    { field_key: 'contact_phone', default_label: 'Phone', field_type: 'phone', default_required: true },
    { field_key: 'contact_email', default_label: 'Email', field_type: 'email', default_required: true },
  ],

  oem_notes: [
    { field_key: 'notes', default_label: 'Notes', field_type: 'textarea', default_col_span: 2 },
  ],
}