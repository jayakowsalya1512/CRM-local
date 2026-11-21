import { FileText } from 'lucide-react'
import type { BuiltinField } from '../constants'

export const leadsMeta = {
  key: 'leads',
  label: 'Leads',
  icon: FileText,
}

export const leadsFields: Record<string, BuiltinField[]> = {
  customer: [
    { field_key: 'customer_id', default_label: 'Customer Account', field_type: 'select', default_required: true },
    { field_key: 'customer_name', default_label: 'Customer Name', default_required: true },
    { field_key: 'customer_address', default_label: 'Customer Address', default_required: true },
  ],
  contact: [
    { field_key: 'department', default_label: 'Department', default_required: true },
    { field_key: 'contact_person', default_label: 'Contact Person', default_required: true },
    { field_key: 'designation', default_label: 'Designation', default_required: true },
    { field_key: 'mobile', default_label: 'Mobile', field_type: 'phone', default_required: true },
    { field_key: 'email', default_label: 'Email', field_type: 'email', default_required: true },
  ],
  lead_info: [
    { field_key: 'lead_title', default_label: 'Lead Title', default_required: true },
    { field_key: 'source_id', default_label: 'Source', field_type: 'select', default_required: true },
    { field_key: 'business_vertical_id', default_label: 'Business Vertical', field_type: 'select', default_required: true },
    { field_key: 'priority', default_label: 'Priority', field_type: 'select', default_required: true },
    { field_key: 'est_value', default_label: 'Estimated Value', field_type: 'number', default_required: true },
    { field_key: 'tender_id_ref', default_label: 'Tender ID Reference' },
    { field_key: 'timeline', default_label: 'Timeline', field_type: 'date', default_required: true },
    { field_key: 'follow_up', default_label: 'Follow-up Date', field_type: 'date', default_required: true },
    { field_key: 'assigned_to', default_label: 'Assigned To', field_type: 'select', default_required: true },
    { field_key: 'status', default_label: 'Status', field_type: 'select' },
  ],
  competitors: [
    { field_key: 'competitor_ids', default_label: 'Competitors', field_type: 'select', default_col_span: 2 },
  ],
  remarks: [
    { field_key: 'product_description', default_label: 'Product / Description', field_type: 'textarea', default_col_span: 2 },
    { field_key: 'notes', default_label: 'Internal Notes', field_type: 'textarea', default_col_span: 2 },
  ],
}
