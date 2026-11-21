import { TrendingUp } from 'lucide-react'
import type { BuiltinField } from '../constants'

export const opportunitiesMeta = {
  key: 'opportunities',
  label: 'Opportunities',
  icon: TrendingUp,
}

export const opportunitiesFields: Record<string, BuiltinField[]> = {
  // Step 1 - Opportunity Creation
  opp_details: [
    { field_key: 'lead_title', default_label: 'Opportunity Title', default_required: true },
    { field_key: 'customer_name', default_label: 'Customer / Account', field_type: 'select' },
    { field_key: 'est_value', default_label: 'Est. Value (₹)', field_type: 'number' },
    { field_key: 'priority', default_label: 'Priority', field_type: 'select' },
    { field_key: 'source_id', default_label: 'Source', field_type: 'select' },
    { field_key: 'business_vertical_id', default_label: 'Business Vertical', field_type: 'select' },
    { field_key: 'assigned_to', default_label: 'Assigned To', field_type: 'select' },
    { field_key: 'region', default_label: 'Region' },
    { field_key: 'branch', default_label: 'Branch' },
  ],

  contact: [
    { field_key: 'contact_person', default_label: 'Contact Person' },
    { field_key: 'designation', default_label: 'Designation' },
    { field_key: 'mobile', default_label: 'Mobile', field_type: 'phone' },
    { field_key: 'email', default_label: 'Email', field_type: 'email' },
    { field_key: 'department', default_label: 'Department' },
    { field_key: 'customer_address', default_label: 'Address' },
  ],

  opp_timeline: [
    { field_key: 'timeline', default_label: 'Expected Timeline', field_type: 'date' },
    { field_key: 'follow_up', default_label: 'Follow Up Date', field_type: 'date' },
  ],

  products_oems: [
    { field_key: 'product_id', default_label: 'Product', field_type: 'select' },
    { field_key: 'quantity', default_label: 'Quantity', field_type: 'number' },
    { field_key: 'description', default_label: 'Description / Spec' },
    { field_key: 'oem_id', default_label: 'OEM / Vendor', field_type: 'select' },
  ],

  opp_notes: [
    { field_key: 'product_description', default_label: 'Product Description', field_type: 'textarea', default_col_span: 2 },
    { field_key: 'notes', default_label: 'Notes', field_type: 'textarea', default_col_span: 2 },
  ],

  // Step 2 - Quotations
  quotations: [
    { field_key: 'quotation_number', default_label: 'Quotation Number' },
    { field_key: 'quotation_date', default_label: 'Quotation Date', field_type: 'date' },
    { field_key: 'quotation_value', default_label: 'Quotation Value', field_type: 'number' },
    { field_key: 'quotation_status', default_label: 'Quotation Status', field_type: 'select' },
    { field_key: 'validity_date', default_label: 'Validity Date', field_type: 'date' },
    { field_key: 'quotation_notes', default_label: 'Notes', field_type: 'textarea', default_col_span: 2 },
  ],

  // Step 3 - PO Details
  po_details: [
    { field_key: 'po_num', default_label: 'PO Number' },
    { field_key: 'po_date', default_label: 'PO Date', field_type: 'date' },
    { field_key: 'po_value', default_label: 'PO Value', field_type: 'number' },
    { field_key: 'dlvry_date', default_label: 'Delivery Date', field_type: 'date' },
    { field_key: 'pmnt_terms', default_label: 'Payment Terms', field_type: 'textarea', default_col_span: 2 },
    { field_key: 'site_eng', default_label: 'Site Engineer' },
    { field_key: 'eng_phone', default_label: 'Engineer Phone', field_type: 'phone' },
    { field_key: 'sow', default_label: 'Scope of Work', field_type: 'textarea', default_col_span: 2 },
    { field_key: 'wrnty_mth', default_label: 'Warranty Months', field_type: 'number' },
    { field_key: 'completion_date', default_label: 'Completion Date', field_type: 'date' },
  ],

  // Step 4 - Consignee
  

  // Step 5 - Work Orders
 work_orders: [
  { field_key: 'wo_number', default_label: 'Work Order Number' },
  { field_key: 'project_title', default_label: 'Project Title' },
  { field_key: 'po_value', default_label: 'PO Value', field_type: 'number' },
  { field_key: 'wo_value', default_label: 'WO Value', field_type: 'number' },
  { field_key: 'delivery_date', default_label: 'Delivery Date', field_type: 'date' },
  { field_key: 'progress_percent', default_label: 'Progress', field_type: 'number' },
  { field_key: 'wo_type', default_label: 'WO Type' },
  { field_key: 'site_location', default_label: 'Site Location' },
  { field_key: 'installation_date', default_label: 'Installation Date', field_type: 'date' },
  { field_key: 'warranty_months', default_label: 'Warranty Months', field_type: 'number' },
  { field_key: 'wo_status', default_label: 'Status', field_type: 'select' },
  { field_key: 'wo_date', default_label: 'Work Order Date', field_type: 'date' },
  { field_key: 'start_date', default_label: 'Start Date', field_type: 'date' },
  { field_key: 'end_date', default_label: 'End Date', field_type: 'date' },
  { field_key: 'wo_notes', default_label: 'Notes', field_type: 'textarea', default_col_span: 2 },
],
}