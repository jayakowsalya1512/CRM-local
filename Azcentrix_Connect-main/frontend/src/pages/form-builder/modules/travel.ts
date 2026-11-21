import { Plane } from 'lucide-react'
import type { BuiltinField } from '../constants'

export const travelMeta = {
  key: 'travel',
  label: 'Travel',
  icon: Plane,
}

export const travelFields: Record<string, BuiltinField[]> = {
  travel_details: [
    { field_key: 'purpose', default_label: 'Purpose of Travel', default_required: true },
    { field_key: 'visit_type', default_label: 'Visit Type', field_type: 'select' },
    { field_key: 'from_city', default_label: 'From City', default_required: true },
    { field_key: 'to_city', default_label: 'To City', default_required: true },
    { field_key: 'travel_date', default_label: 'Travel Date', field_type: 'date', default_required: true },
    { field_key: 'return_date', default_label: 'Return Date', field_type: 'date', default_required: true },
    { field_key: 'is_outside_district', default_label: 'Outside District / City', field_type: 'checkbox' },
  ],

  crm_linkage: [
    { field_key: 'account_id', default_label: 'Account / Customer', field_type: 'select' },
    { field_key: 'contact_name', default_label: 'Contact Person' },
    { field_key: 'contact_phone', default_label: 'Contact Phone', field_type: 'phone' },
    { field_key: 'opportunity_id', default_label: 'Linked Opportunity', field_type: 'select' },
    { field_key: 'lead_id', default_label: 'Lead / Reference ID' },
    { field_key: 'tender_id', default_label: 'Linked Tender', field_type: 'select' },
  ],

  advance_budget: [
    { field_key: 'advance_required', default_label: 'Request Cash Advance', field_type: 'checkbox' },
    { field_key: 'advance_amount', default_label: 'Advance Amount Required (₹)', field_type: 'number', default_required: true },
  ],

  accommodation: [
    { field_key: 'accommodation_required', default_label: 'Accommodation Required', field_type: 'checkbox' },
    { field_key: 'accommodation_type', default_label: 'Accommodation Type', field_type: 'select' },
    { field_key: 'hotel_name', default_label: 'Hotel / Property Name' },
    { field_key: 'check_in_date', default_label: 'Check-in Date', field_type: 'date' },
    { field_key: 'check_out_date', default_label: 'Check-out Date', field_type: 'date' },
    { field_key: 'accommodation_cost', default_label: 'Estimated Accommodation Cost (₹)', field_type: 'number' },
  ],

  additional_info: [
    { field_key: 'companions', default_label: 'Travel Companions' },
    { field_key: 'notes', default_label: 'Notes / Special Instructions', field_type: 'textarea', default_col_span: 2 },
  ],
}