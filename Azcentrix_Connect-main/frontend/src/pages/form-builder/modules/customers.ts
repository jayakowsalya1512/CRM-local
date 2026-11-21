import { Users } from 'lucide-react'

export const customersMeta = {
  key: 'customers',
  label: 'Customers',
  icon: Users,
}

export const customersFields = {
  account: [
    { field_key: 'customer_name', default_label: 'Customer / Company Name' },
    { field_key: 'website', default_label: 'Website' },
    { field_key: 'customer_vertical', default_label: 'Customer Segment' },
    { field_key: 'division', default_label: 'Division / Department' },
    { field_key: 'group_name', default_label: 'Group Name' },
    { field_key: 'gst_number', default_label: 'GST Number' },
    { field_key: 'pan_number', default_label: 'PAN Number' },
    { field_key: 'account_status', default_label: 'Account Status' },
    { field_key: 'account_potential', default_label: 'Account Potential' },
    { field_key: 'potential_value', default_label: 'Potential Value' },
    { field_key: 'assigned_to', default_label: 'Assigned To' },
  ],

  address: [
    { field_key: 'billing_address', default_label: 'Billing Address' },
    { field_key: 'billing_pincode', default_label: 'Billing Pincode' },
    { field_key: 'billing_country', default_label: 'Billing Country' },
    { field_key: 'billing_state', default_label: 'Billing State' },
    { field_key: 'billing_city', default_label: 'Billing City / District' },
    { field_key: 'billing_area', default_label: 'Billing Area / Locality' },
    
  ],

  contacts: [
    { field_key: 'contact_name', default_label: 'Full Name' },
    { field_key: 'contact_role', default_label: 'Designation' },
    { field_key: 'department', default_label: 'Department' },
    { field_key: 'contact_phone', default_label: 'Mobile' },
    { field_key: 'office_phone', default_label: 'Office Phone' },
    { field_key: 'contact_email', default_label: 'Office Email' },
  ],

  remarks: [
    { field_key: 'remarks', default_label: 'Remarks' },
  ],
}
