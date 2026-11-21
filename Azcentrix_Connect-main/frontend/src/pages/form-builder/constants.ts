import { customersMeta, customersFields } from './modules/customers'
import { leadsMeta, leadsFields } from './modules/leads'
import { opportunitiesMeta, opportunitiesFields } from './modules/opportunities'
import { tendersMeta, tendersFields } from './modules/tenders'
import { workOrdersMeta, workOrdersFields } from './modules/work_orders'
import { travelMeta, travelFields } from './modules/travel'
import { usersMeta, usersFields } from './modules/users'
import { oemMeta, oemFields } from './modules/oem'
import { competitorsMeta, competitorsFields } from './modules/competitors'
import type { FormFieldConfig } from '@/hooks/useFormConfig'

export type BuiltinField = {
  field_key: string
  default_label: string
  field_type?: FormFieldConfig['field_type']
  default_required?: boolean
  default_col_span?: 1 | 2
}

export const BUILTIN_FIELDS: Record<string, Record<string, BuiltinField[]>> = {
  customers: customersFields,
  leads: leadsFields,
  opportunities: opportunitiesFields,
  tenders: tendersFields,
  work_orders: workOrdersFields,
  travel: travelFields,
  users: usersFields,
  oem: oemFields,
  competitors: competitorsFields,
}

export const MODULES = [
  customersMeta,
  leadsMeta,
  opportunitiesMeta,
  tendersMeta,
  workOrdersMeta,
  travelMeta,
  usersMeta,
  oemMeta,
  competitorsMeta,
]

export const SECTION_LABELS: Record<string, string> = {
  // shared
  basic: 'Basic Information',
  remarks: 'Remarks',
  financial: 'Financial',
  consignees: 'Consignees',

  // customers
  account: 'Account Info',
  address: 'Address',
  contacts: 'Contacts',

  // leads
  customer: 'Customer Account',
  contact: 'Contact Details',
  lead_info: 'Lead Information',
  competitors: 'Competitors',
  'leads.customer': 'Customers Account',
  'leads.lead_info': 'Leads Information',
  'leads.remarks': 'Description & Notes',

  // leads / opportunities
  source: 'Source',


  // opportunities
opp_details: 'Opportunity Details',
'opportunities.contact': 'Contact Details',
opp_timeline: 'Timeline',
products_oems: 'Products & OEMs',
opp_notes: 'Notes',
quotations: 'Quotations',
po_details: 'PO Details',
consignee: 'Consignee',
work_orders: 'Orders & Projects',

  // tenders
  details: 'Tender Details',
  workings: 'Workings',
  technical: 'Technical',
  final_boq: 'Final BOQ',
  workings_documents: 'Workings Documents',
  loss_analysis: 'Loss Analysis',
  pbg_details: 'Performance Bank Guarantee',
  penalty: 'Penalty / LD Clause',
  'tenders.basic': 'Tender Details',
  'tenders.workings': 'Product / BOQ Items',
  'tenders.remarks': 'Notes',
  'tenders.details': 'Tender Fee / EMD / Conditions',
  'tenders.technical': 'Technical Bid',
  'tenders.financial': 'Bid Result',
  'tenders.po_details': 'PO Details',
  'tenders.consignees': 'Consignee / Delivery Details',

  // users
  role: 'Role & Department',
  region: 'Region & State',
  target: 'Sales Target',

  // users / oem / competitors
  profile: 'Profile',

  // oem
  oem_info: 'OEM Details',
  oem_type: 'Entry Type',
  oem_details: 'OEM Details',
  distributor: 'Distributor',
  'oem.contact': 'Contact',
  oem_notes: 'Notes',

  // travel
  budget: 'Budget',
  travel_info: 'Travel Info',
  request_details: 'Request Details',
  travel_details: 'Travel Details',
  crm_linkage: 'CRM Linkage',
  advance_budget: 'Advance & Budget',
  accommodation: 'Accommodation',
  additional_info: 'Additional Info',

  // competitors
  analysis: 'Analysis',
  market: 'Market Profile',
  coverage: 'Competitive Coverage',

  // work orders
requirements: 'Requirements',
schedule: 'Schedule',
payment: 'Payment Terms',
scope: 'Scope of Work',
}

export const SECTION_STEPS: Record<string, Record<string, string>> = {
  tenders: {
    basic: 'Step 1 - Tender Basic / Creation',
    workings: 'Step 1 - Tender Basic / Creation',
    remarks: 'Step 1 - Tender Basic / Creation',
    details: 'Step 2 - Tender Fee / EMD / Conditions',
    final_boq: 'Step 3 - Final BOQ / Workings',
    workings_documents: 'Step 3 - Final BOQ / Workings',
    technical: 'Step 4 - Technical Bid',
    financial: 'Step 5 - Result / Loss Analysis',
    loss_analysis: 'Step 5 - Result / Loss Analysis',
    pbg_details: 'Step 6 - PO Details',
    po_details: 'Step 6 - PO Details',
    penalty: 'Step 6 - PO Details',
    consignees: 'Step 7 - Consignees',
  },

   opportunities: {
    opp_details: 'Step 1 - Opportunity Creation',
    contact: 'Step 1 - Opportunity Creation',
    opp_timeline: 'Step 1 - Opportunity Creation',
    products_oems: 'Step 1 - Opportunity Creation',
    opp_notes: 'Step 1 - Opportunity Creation',
    quotations: 'Step 2 - Quotations',
    po_details: 'Step 3 - PO Details',
    consignee: 'Step 4 - Consignee',
    work_orders: 'Step 5 - Work Orders',
  },

}






export const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'url', label: 'URL' },
  { value: 'select', label: 'Dropdown' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'textarea', label: 'Text Area' },
]
