import { Trophy } from 'lucide-react'
import type { BuiltinField } from '../constants'

export const competitorsMeta = {
  key: 'competitors',
  label: 'Competitors',
  icon: Trophy,
}

export const competitorsFields: Record<string, BuiltinField[]> = {
  profile: [
    { field_key: 'name', default_label: 'Competitor Name', default_required: true },
    { field_key: 'registration_type', default_label: 'Registration Type', field_type: 'select' },
    { field_key: 'registration_year', default_label: 'Registration Year', field_type: 'select' },
    { field_key: 'company_type', default_label: 'Type Of Company', field_type: 'select' },
    { field_key: 'gst_no', default_label: 'GST No' },
    { field_key: 'pan_no', default_label: 'PAN No' },
    { field_key: 'email', default_label: 'Email', field_type: 'email' },
    { field_key: 'mobile_no', default_label: 'Mobile No', field_type: 'phone' },
    { field_key: 'manpower_strength', default_label: 'Manpower Strength', field_type: 'select' },
    { field_key: 'directors', default_label: 'Directors', field_type: 'textarea', default_col_span: 2 },
  ],

  address: [
    { field_key: 'address', default_label: 'Street Address', default_required: true },
    { field_key: 'pincode', default_label: 'Pincode', default_required: true },
    { field_key: 'country', default_label: 'Country', default_required: true },
    { field_key: 'state', default_label: 'State', field_type: 'select', default_required: true },
    { field_key: 'district', default_label: 'City / District', field_type: 'select', default_required: true },
    { field_key: 'city', default_label: 'Area / Locality', default_required: true },
  ],

  market: [
    { field_key: 'website', default_label: 'Website', field_type: 'url' },
    { field_key: 'annual_turnover', default_label: 'Annual Turnover' },
    { field_key: 'threat_level', default_label: 'Threat Level', field_type: 'select' },
    { field_key: 'support_quality', default_label: 'Support Quality', field_type: 'select' },
    { field_key: 'market_reputation', default_label: 'Market Reputation', field_type: 'select' },
  ],

  coverage: [
    { field_key: 'oem_partnerships', default_label: 'OEM Partnerships', field_type: 'select' },
    { field_key: 'strong_regions', default_label: 'Strong Regions', field_type: 'select' },
    { field_key: 'strong_departments', default_label: 'Strong Departments', field_type: 'select' },
  ],

  analysis: [
    { field_key: 'strengths', default_label: 'Strengths', field_type: 'textarea' },
    { field_key: 'weaknesses', default_label: 'Weaknesses', field_type: 'textarea' },
    { field_key: 'internal_notes', default_label: 'Internal Notes', field_type: 'textarea', default_col_span: 2 },
  ],
}