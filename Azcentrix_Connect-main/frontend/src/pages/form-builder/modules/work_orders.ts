import { ClipboardList } from 'lucide-react'

export const workOrdersMeta = {
  key: 'work_orders',
  label: 'Orders & Projects',
  icon: ClipboardList,
}

export const workOrdersFields = {
  basic: [
    { field_key: 'wo_type', default_label: 'WO Type' },
    { field_key: 'customer_name', default_label: 'Customer Name' },
    { field_key: 'project_title', default_label: 'Project Title' },
    { field_key: 'po_number', default_label: 'PO Number' },
    { field_key: 'po_date', default_label: 'PO Date' },
    { field_key: 'warranty_months', default_label: 'Warranty (months)' },
    { field_key: 'po_value', default_label: 'PO Value' },
    { field_key: 'wo_value', default_label: 'WO Value' },
    { field_key: 'po_doc', default_label: 'PO Document' },
  ],

  schedule: [
    { field_key: 'delivery_date', default_label: 'Delivery Date' },
    { field_key: 'installation_date', default_label: 'Installation Date' },
    { field_key: 'site_location', default_label: 'Site Location' },
    { field_key: 'site_engineer', default_label: 'Site Engineer' },
    { field_key: 'site_engineer_phone', default_label: 'Engineer Phone' },
  ],

  payment: [
    { field_key: 'advance_percent', default_label: 'Advance %' },
    { field_key: 'retention_percent', default_label: 'Retention %' },
    { field_key: 'payment_terms', default_label: 'Payment Terms' },
  ],

  scope: [
    { field_key: 'scope_of_work', default_label: 'Scope of Work' },
  ],
}