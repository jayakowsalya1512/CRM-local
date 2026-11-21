import type { ModuleFilterConfig, FieldOption, FilterField } from './filterTypes'

export const PRESETS: FieldOption[] = [
  { id: '', name: 'All Time' },
  { id: 'today', name: 'Today' },
  { id: 'this_week', name: 'This Week' },
  { id: 'this_month', name: 'This Month' },
  { id: 'last_month', name: 'Last Month' },
  { id: 'this_quarter', name: 'This Quarter' },
  { id: 'last_quarter', name: 'Last Quarter' },
  { id: 'this_year', name: 'This Year' },
  { id: 'last_year', name: 'Last Year' },
  { id: 'custom', name: 'Custom Range' },
]

export const presetField: FilterField = {
  key: 'preset',
  label: 'Period',
  fieldType: 'preset',
  options: PRESETS,
  section: 'primary',
}

// ─── LEADS ───────────────────────────────────────────────────────────────────

export const LEADS_FILTER_CONFIG: ModuleFilterConfig = {
  module: 'leads',
  defaultParams: {},
  primaryFields: [
    { ...presetField, label: 'Date Range' },
    { key: 'search', label: 'Lead Title', fieldType: 'text', placeholder: 'Search lead title…', section: 'primary' },
    { key: 'status', label: 'Status', fieldType: 'multi_select', optionsKey: 'statuses', section: 'primary' },
    { key: 'priority', label: 'Priority', fieldType: 'select', options: [{ id: 'High', name: 'High' }, { id: 'Medium', name: 'Medium' }, { id: 'Low', name: 'Low' }], section: 'primary' },
    { key: 'assigned_to', label: 'Assigned To', fieldType: 'multi_select', optionsKey: 'users', section: 'primary' },
    { key: 'customer_id', label: 'Customer', fieldType: 'multi_select', optionsKey: 'customers', section: 'primary' },
    { key: 'source_id', label: 'Source', fieldType: 'multi_select', optionsKey: 'sources', section: 'primary' },
    { key: 'lead_type', label: 'Lead Type', fieldType: 'select', options: [{ id: 'lead', name: 'Lead' }, { id: 'direct_opportunity', name: 'Direct Opportunity' }], section: 'primary' },
    { key: 'region', label: 'Region', fieldType: 'text', placeholder: 'Region/State…', section: 'primary' },
    { key: 'branch', label: 'Branch', fieldType: 'text', placeholder: 'Branch…', section: 'primary' },
    { key: 'approval_status', label: 'Approval Status', fieldType: 'select', options: [{ id: 'Pending', name: 'Pending' }, { id: 'Approved', name: 'Approved' }, { id: 'Rejected', name: 'Rejected' }], section: 'primary' },
    { key: 'business_vertical_id', label: 'Business Vertical', fieldType: 'multi_select', optionsKey: 'business_verticals', section: 'primary' },
    { key: 'customer_segment', label: 'Customer Segment', fieldType: 'multi_select', optionsKey: 'vertical_sectors', section: 'primary' },
    { key: 'open_only', label: 'Open Leads Only', fieldType: 'existence', section: 'primary' },
    { key: 'has_activity', label: 'Has KAM Activity', fieldType: 'select', options: [{ id: '1', name: 'Yes – Has Activity' }, { id: '0', name: 'No – No Activity' }], section: 'primary' },
    { key: 'has_quotation', label: 'Has Quotation', fieldType: 'select', options: [{ id: '1', name: 'Yes' }, { id: '0', name: 'No' }], section: 'primary' },
    { key: 'quotation_status', label: 'Quotation Status', fieldType: 'select', optionsKey: 'quotation_statuses', section: 'primary' },
    { key: 'has_workorder', label: 'Has Work Order', fieldType: 'select', options: [{ id: '1', name: 'Yes' }, { id: '0', name: 'No' }], section: 'primary' },
    { key: 'has_travel', label: 'Has Travel', fieldType: 'select', options: [{ id: '1', name: 'Yes' }, { id: '0', name: 'No' }], section: 'primary' },
  ],
  secondaryFields: [
    { key: 'est_value_min', label: 'Min Value (Rs)', fieldType: 'number', placeholder: 'Min Rs', section: 'secondary' },
    { key: 'est_value_max', label: 'Max Value (Rs)', fieldType: 'number', placeholder: 'Max Rs', section: 'secondary' },
    { key: 'follow_up_from', label: 'Follow-up From', fieldType: 'date', section: 'secondary' },
    { key: 'follow_up_to', label: 'Follow-up To', fieldType: 'date', section: 'secondary' },
    { key: 'follow_up_overdue', label: 'Follow-up Overdue', fieldType: 'existence', section: 'secondary' },
    { key: 'follow_up_due_days', label: 'Follow-up Due In (days)', fieldType: 'number', placeholder: 'e.g. 7', section: 'secondary' },
  ],
  moreFields: [
    { key: 'inactive_days', label: 'Inactive For (days)', fieldType: 'number', placeholder: 'e.g. 30', section: 'more' },
    { key: 'no_activity_days', label: 'No Activity For (days)', fieldType: 'number', placeholder: 'e.g. 14', section: 'more' },
    { key: 'product_name', label: 'Product Name', fieldType: 'text', placeholder: 'Product name…', section: 'more' },
    { key: 'oem_name', label: 'OEM Name', fieldType: 'text', placeholder: 'OEM name…', section: 'more' },
    { key: 'created_by', label: 'Created By', fieldType: 'multi_select', optionsKey: 'users', section: 'more' },
  ],
  quickFilters: [
    { key: 'open',         label: '📌 Open Leads',          params: { open_only: '1' } },
    { key: 'high',         label: '🔥 High Priority',        params: { priority: 'High' } },
    { key: 'overdue',      label: '⚠️ Follow-up Overdue',    params: { follow_up_overdue: '1' } },
    { key: 'has_q',        label: '📃 Has Quotation',        params: { has_quotation: '1' } },
    { key: 'this_month',   label: '📅 This Month',           params: { preset: 'this_month' } },
    { key: 'this_quarter', label: '📅 This Quarter',         params: { preset: 'this_quarter' } },
  ],
}

// ─── TENDERS ─────────────────────────────────────────────────────────────────

export const TENDERS_FILTER_CONFIG: ModuleFilterConfig = {
  module: 'tenders',
  defaultParams: {},
  primaryFields: [
    presetField,
    { key: 'assigned_to', label: 'Assigned To', fieldType: 'multi_select', optionsKey: 'users', section: 'primary' },
    { key: 'status', label: 'Status', fieldType: 'multi_select', optionsKey: 'statuses', section: 'primary' },
    { key: 'result', label: 'Result', fieldType: 'multi_select', optionsKey: 'results', section: 'primary' },
    { key: 'source_portal', label: 'Portal', fieldType: 'multi_select', optionsKey: 'portals', section: 'primary' },
  ],
  secondaryFields: [
    { key: 'customer_id', label: 'Customer', fieldType: 'multi_select', optionsKey: 'customers', section: 'secondary' },
    { key: 'customer_segment', label: 'Customer Segment', fieldType: 'multi_select', optionsKey: 'vertical_sectors', section: 'secondary' },
    { key: 'business_vertical_id', label: 'Business Vertical', fieldType: 'multi_select', optionsKey: 'business_verticals', section: 'secondary' },
    { key: 'approval_status', label: 'Approval Status', fieldType: 'select', options: [{id:'Pending',name:'Pending'},{id:'Approved',name:'Approved'},{id:'Rejected',name:'Rejected'}], section: 'secondary' },
    { key: 'emd_required', label: 'EMD Required', fieldType: 'existence', section: 'secondary' },
    { key: 'has_quotation', label: 'Has Quotation', fieldType: 'existence', section: 'secondary' },
    { key: 'has_workorder', label: 'Has Work Order', fieldType: 'existence', section: 'secondary' },
    { key: 'submission_from', label: 'Submission From', fieldType: 'date', section: 'secondary' },
    { key: 'submission_to', label: 'Submission To', fieldType: 'date', section: 'secondary' },
  ],
  moreFields: [
    { key: 'search', label: 'Search', fieldType: 'text', placeholder: 'Tender title, number…', section: 'more' },
    { key: 'bid_min', label: 'Min Bid ₹', fieldType: 'number', section: 'more' },
    { key: 'bid_max', label: 'Max Bid ₹', fieldType: 'number', section: 'more' },
    { key: 'submission_due_days', label: 'Submission Due (days)', fieldType: 'number', placeholder: 'e.g. 7', section: 'more' },
    { key: 'no_activity_days', label: 'No Activity (days)', fieldType: 'number', placeholder: 'e.g. 14', section: 'more' },
    { key: 'active_only', label: 'Active Only', fieldType: 'existence', section: 'more' },
    { key: 'submission_overdue', label: 'Submission Overdue', fieldType: 'existence', section: 'more' },
    { key: 'pre_bid_upcoming', label: 'Pre-bid Upcoming', fieldType: 'existence', section: 'more' },
    { key: 'pre_bid_completed', label: 'Pre-bid Completed', fieldType: 'existence', section: 'more' },
    { key: 'emd_pending', label: 'EMD Pending', fieldType: 'existence', section: 'more' },
    { key: 'emd_submitted', label: 'EMD Submitted', fieldType: 'existence', section: 'more' },
    { key: 'emd_return_pending', label: 'EMD Return Pending', fieldType: 'existence', section: 'more' },
    { key: 'has_activity', label: 'Has Activity', fieldType: 'existence', section: 'more' },
    { key: 'gem_only', label: 'GeM Only', fieldType: 'existence', section: 'more' },
    { key: 'result_pending', label: 'Result Pending', fieldType: 'existence', section: 'more' },
    { key: 'tech_bid_eligible', label: 'Tech Bid', fieldType: 'select', optionsKey: 'tech_bid_options', section: 'more' },
    { key: 'reverse_auction', label: 'Reverse Auction', fieldType: 'existence', section: 'more' },
    { key: 'product_name', label: 'Product Name', fieldType: 'text', placeholder: 'Product name…', section: 'more' },
    { key: 'oem_name', label: 'OEM Name', fieldType: 'text', placeholder: 'OEM name…', section: 'more' },
  ],
  quickFilters: [
    { key: 'active',       label: '📋 Active',               params: { active_only: '1' } },
    { key: 'sub_overdue',  label: '⏰ Submission Overdue',    params: { submission_overdue: '1' } },
    { key: 'emd_pending',  label: '💰 EMD Pending',           params: { emd_pending: '1' } },
    { key: 'pre_bid',      label: '📋 Pre-bid Upcoming',      params: { pre_bid_upcoming: '1' } },
    { key: 'result_pend',  label: '⏳ Result Pending',        params: { result_pending: '1' } },
    { key: 'gem',          label: '🛒 GeM Only',              params: { gem_only: '1' } },
    { key: 'this_month',   label: '📅 This Month',            params: { preset: 'this_month' } },
    { key: 'this_quarter', label: '📅 This Quarter',          params: { preset: 'this_quarter' } },
  ],
}

// ─── CUSTOMERS ───────────────────────────────────────────────────────────────

export const CUSTOMERS_FILTER_CONFIG: ModuleFilterConfig = {
  module: 'customers',
  defaultParams: {},
  primaryFields: [
    { ...presetField, label: 'Date Range' },
    { key: 'search', label: 'Search', fieldType: 'text', placeholder: 'Customer name, city, contact…', section: 'primary' },
    { key: 'status', label: 'Customer Status', fieldType: 'select', optionsKey: 'statuses', section: 'primary' },
    { key: 'vertical', label: 'Customer Type', fieldType: 'select', optionsKey: 'verticals', section: 'primary' },
    { key: 'industry', label: 'Industry', fieldType: 'select', optionsKey: 'industries', section: 'primary' },
    { key: 'assigned_to', label: 'KAM / Owner', fieldType: 'multi_select', optionsKey: 'users', section: 'primary' },
    { key: 'business_vertical_id', label: 'Business Vertical', fieldType: 'multi_select', optionsKey: 'business_verticals', section: 'primary' },
  ],
  secondaryFields: [
    { key: 'billing_country', label: 'Country', fieldType: 'select', optionsKey: 'countries', section: 'secondary' },
    { key: 'billing_state', label: 'State', fieldType: 'select', optionsKey: 'states', section: 'secondary' },
    { key: 'billing_city', label: 'City', fieldType: 'text', placeholder: 'City...', section: 'secondary' },
    { key: 'potential_value_min', label: 'Min Potential', fieldType: 'number', placeholder: 'Min', section: 'secondary' },
    { key: 'potential_value_max', label: 'Max Potential', fieldType: 'number', placeholder: 'Max', section: 'secondary' },
    { key: 'potential', label: 'Potential Level', fieldType: 'select', optionsKey: 'potentials', section: 'secondary' },
    { key: 'source', label: 'Source', fieldType: 'select', optionsKey: 'sources', section: 'secondary' },
  ],
  moreFields: [
    { key: 'has_active_lead', label: 'Has Active Lead', fieldType: 'existence', section: 'more' },
    { key: 'has_open_tender', label: 'Has Open Tender', fieldType: 'existence', section: 'more' },
    { key: 'active_projects', label: 'Has Active Projects', fieldType: 'existence', section: 'more' },
    { key: 'last_activity', label: 'Last Activity Within', fieldType: 'select', optionsKey: 'activity_windows', section: 'more' },
    { key: 'no_activity_since', label: 'No Activity Since', fieldType: 'select', optionsKey: 'activity_windows', section: 'more' },
    { key: 'next_follow_up', label: 'Follow-up Due Within', fieldType: 'select', optionsKey: 'followup_windows', section: 'more' },
    { key: 'tags', label: 'Tags', fieldType: 'text', placeholder: 'Tag...', section: 'more' },
    { key: 'revenue_min', label: 'Min Revenue', fieldType: 'number', placeholder: 'Min', section: 'more' },
    { key: 'revenue_max', label: 'Max Revenue', fieldType: 'number', placeholder: 'Max', section: 'more' },
    { key: 'created_by', label: 'Created By', fieldType: 'multi_select', optionsKey: 'users', section: 'more' },
  ],
  quickFilters: [
    { key: 'active', label: '✅ Active', params: { status: 'Active' } },
    { key: 'inactive', label: '🔴 Inactive', params: { status: 'Inactive' } },
    { key: 'prospect', label: '🔵 Prospect', params: { status: 'Prospect' } },
    { key: 'this_month', label: '📅 This Month', params: { preset: 'this_month' } },
    { key: 'this_quarter', label: '📅 This Quarter', params: { preset: 'this_quarter' } },
    { key: 'has_lead', label: '📌 Has Active Lead', params: { has_active_lead: '1' } },
    { key: 'has_tender', label: '📄 Has Open Tender', params: { has_open_tender: '1' } },
    { key: 'no_activity', label: '⚠️ No Activity 30d', params: { no_activity_since: '30' } },
  ],
}

// ─── OPPORTUNITIES ────────────────────────────────────────────────────────────

export const OPPORTUNITIES_FILTER_CONFIG: ModuleFilterConfig = {
  module: 'opportunities',
  defaultParams: {},
  primaryFields: [
    presetField,
    { key: 'assigned_to', label: 'Assigned To', fieldType: 'multi_select', optionsKey: 'users', section: 'primary' },
    { key: 'stage', label: 'Stage', fieldType: 'multi_select', optionsKey: 'stages', section: 'primary' },
    { key: 'priority', label: 'Priority', fieldType: 'select', options: [{id:'High',name:'High'},{id:'Medium',name:'Medium'},{id:'Low',name:'Low'}], section: 'primary' },
  ],
  secondaryFields: [
    { key: 'customer_id', label: 'Customer', fieldType: 'multi_select', optionsKey: 'customers', section: 'secondary' },
    { key: 'source_id', label: 'Source', fieldType: 'multi_select', optionsKey: 'sources', section: 'secondary' },
    { key: 'approval_status', label: 'Approval Status', fieldType: 'select', optionsKey: 'approval_statuses', section: 'secondary' },
    { key: 'has_quotation', label: 'Has Quotation', fieldType: 'existence', section: 'secondary' },
    { key: 'quote_status', label: 'Quotation Status', fieldType: 'multi_select', optionsKey: 'quote_statuses', section: 'secondary' },
    { key: 'region', label: 'Region', fieldType: 'text', section: 'secondary' },
    { key: 'business_vertical_id', label: 'Business Vertical', fieldType: 'multi_select', optionsKey: 'business_verticals', section: 'secondary' },
    { key: 'customer_segment', label: 'Customer Segment', fieldType: 'multi_select', optionsKey: 'vertical_sectors', section: 'secondary' },
  ],
  moreFields: [
    { key: 'search', label: 'Search', fieldType: 'text', placeholder: 'Title, customer, contact…', section: 'more' },
    { key: 'est_value_min', label: 'Min Value ₹', fieldType: 'number', section: 'more' },
    { key: 'est_value_max', label: 'Max Value ₹', fieldType: 'number', section: 'more' },
    { key: 'lead_type', label: 'Lead Type', fieldType: 'select', optionsKey: 'lead_types', section: 'more' },
    { key: 'open_only', label: 'Open Only', fieldType: 'existence', section: 'more' },
    { key: 'follow_up_overdue', label: 'Follow-up Overdue', fieldType: 'existence', section: 'more' },
    { key: 'follow_up_due_days', label: 'Follow-up Due (days)', fieldType: 'number', placeholder: 'e.g. 7', section: 'more' },
    { key: 'inactive_days', label: 'Inactive (days)', fieldType: 'number', placeholder: 'e.g. 30', section: 'more' },
    { key: 'no_activity_days', label: 'No Activity (days)', fieldType: 'number', placeholder: 'e.g. 14', section: 'more' },
    { key: 'has_activity', label: 'Has Activity', fieldType: 'existence', section: 'more' },
    { key: 'has_workorder', label: 'Has Work Order', fieldType: 'existence', section: 'more' },
    { key: 'follow_up_from', label: 'Follow-up From', fieldType: 'date', section: 'more' },
    { key: 'follow_up_to', label: 'Follow-up To', fieldType: 'date', section: 'more' },
    { key: 'created_by', label: 'Created By', fieldType: 'multi_select', optionsKey: 'users', section: 'more' },
    { key: 'product_name', label: 'Product Name', fieldType: 'text', placeholder: 'Product name…', section: 'more' },
    { key: 'oem_name', label: 'OEM Name', fieldType: 'text', placeholder: 'OEM name…', section: 'more' },
  ],
  quickFilters: [
    { key: 'open',         label: '📊 Open Only',            params: { open_only: '1' } },
    { key: 'high',         label: '🔥 High Priority',        params: { priority: 'High' } },
    { key: 'overdue',      label: '⚠️ Follow-up Overdue',    params: { follow_up_overdue: '1' } },
    { key: 'has_q',        label: '📃 Has Quotation',        params: { has_quotation: '1' } },
    { key: 'has_wo',       label: '🔧 Has Work Order',       params: { has_workorder: '1' } },
    { key: 'this_quarter', label: '📅 This Quarter',         params: { preset: 'this_quarter' } },
  ],
}

// ─── QUOTATIONS ───────────────────────────────────────────────────────────────

export const QUOTATIONS_FILTER_CONFIG: ModuleFilterConfig = {
  module: 'quotations',
  defaultParams: {},
  primaryFields: [
    presetField,
    { key: 'search', label: 'Search', fieldType: 'text', placeholder: 'Quote #, subject, customer…', section: 'primary' },
    { key: 'status', label: 'Status', fieldType: 'multi_select', optionsKey: 'statuses', section: 'primary' },
    { key: 'approval_status', label: 'Approval', fieldType: 'select', optionsKey: 'approval_statuses', section: 'primary' },
    { key: 'source_type', label: 'Source', fieldType: 'select', optionsKey: 'source_types', section: 'primary' },
    { key: 'created_by', label: 'Created By', fieldType: 'multi_select', optionsKey: 'users', section: 'primary' },
  ],
  secondaryFields: [
    { key: 'customer_id', label: 'Customer', fieldType: 'multi_select', optionsKey: 'customers', section: 'secondary' },
    { key: 'customer_segment', label: 'Customer Segment', fieldType: 'multi_select', optionsKey: 'vertical_sectors', section: 'secondary' },
    { key: 'business_vertical_id', label: 'Business Vertical', fieldType: 'multi_select', optionsKey: 'business_verticals', section: 'secondary' },
    { key: 'signatory_user_id', label: 'Signatory', fieldType: 'multi_select', optionsKey: 'users', section: 'secondary' },
    { key: 'lead_type', label: 'Lead Type', fieldType: 'select', optionsKey: 'lead_types', section: 'secondary' },
  ],
  moreFields: [
    { key: 'amount_min', label: 'Min Value Rs', fieldType: 'number', section: 'more' },
    { key: 'amount_max', label: 'Max Value Rs', fieldType: 'number', section: 'more' },
    { key: 'valid_until_from', label: 'Valid From', fieldType: 'date', section: 'more' },
    { key: 'valid_until_to', label: 'Valid To', fieldType: 'date', section: 'more' },
    { key: 'validity_days', label: 'Expiring in (days)', fieldType: 'number', placeholder: 'e.g. 30', section: 'more' },
    { key: 'expired_only', label: 'Expired Only', fieldType: 'existence', section: 'more' },
    { key: 'revision_number', label: 'Revision', fieldType: 'select', optionsKey: 'revisions', section: 'more' },
    { key: 'source_portal', label: 'Portal', fieldType: 'multi_select', optionsKey: 'portals', section: 'more' },
    { key: 'tender_result', label: 'Tender Result', fieldType: 'multi_select', optionsKey: 'results', section: 'more' },
  ],
  quickFilters: [
    { key: 'pending',      label: '⏳ Pending Approval',     params: { approval_status: 'Pending' } },
    { key: 'approved',     label: '✅ Approved',             params: { approval_status: 'Approved' } },
    { key: 'expiring',     label: '⌛ Expiring Soon (30d)',  params: { validity_days: '30' } },
    { key: 'expired',      label: '❌ Expired',              params: { expired_only: '1' } },
    { key: 'this_month',   label: '📅 This Month',           params: { preset: 'this_month' } },
    { key: 'this_quarter', label: '📅 This Quarter',         params: { preset: 'this_quarter' } },
  ],
}

// ─── WORKORDERS ───────────────────────────────────────────────────────────────

export const WORKORDERS_FILTER_CONFIG: ModuleFilterConfig = {
  module: 'workorders',
  defaultParams: {},
  primaryFields: [
    presetField,
    { key: 'search', label: 'Search', fieldType: 'text', placeholder: 'WO #, project, customer…', section: 'primary' },
    { key: 'status', label: 'Status', fieldType: 'multi_select', optionsKey: 'statuses', section: 'primary' },
    { key: 'project_manager_id', label: 'Project Manager', fieldType: 'multi_select', optionsKey: 'users', section: 'primary' },
    { key: 'customer_id', label: 'Customer', fieldType: 'multi_select', optionsKey: 'customers', section: 'primary' },
    { key: 'wo_type', label: 'WO Type', fieldType: 'multi_select', optionsKey: 'wo_types', section: 'primary' },
  ],
  secondaryFields: [
    { key: 'customer_segment', label: 'Customer Segment', fieldType: 'multi_select', optionsKey: 'vertical_sectors', section: 'secondary' },
    { key: 'business_vertical_id', label: 'Business Vertical', fieldType: 'multi_select', optionsKey: 'business_verticals', section: 'secondary' },
    { key: 'payment_status', label: 'Payment Status', fieldType: 'select', optionsKey: 'payment_statuses', section: 'secondary' },
    { key: 'delivery_status', label: 'Delivery Status', fieldType: 'select', optionsKey: 'delivery_statuses', section: 'secondary' },
  ],
  moreFields: [
    { key: 'value_min', label: 'Min Value ₹', fieldType: 'number', section: 'more' },
    { key: 'value_max', label: 'Max Value ₹', fieldType: 'number', section: 'more' },
    { key: 'source_portal', label: 'Portal', fieldType: 'select', optionsKey: 'portals', section: 'more' },
  ],
  quickFilters: [
    { key: 'in_progress',  label: '🔧 In Progress',          params: { status: 'In Progress' } },
    { key: 'confirmed',    label: '✅ Confirmed',             params: { status: 'Confirmed' } },
    { key: 'completed',    label: '🏁 Completed',             params: { status: 'Completed' } },
    { key: 'this_month',   label: '📅 This Month',            params: { preset: 'this_month' } },
    { key: 'this_quarter', label: '📅 This Quarter',          params: { preset: 'this_quarter' } },
  ],
}

// ─── EMDBG ────────────────────────────────────────────────────────────────────

export const EMDBG_FILTER_CONFIG: ModuleFilterConfig = {
  module: 'emdbg',
  defaultParams: {},
  primaryFields: [
    presetField,
    { key: 'instrument_type', label: 'Type', fieldType: 'select', optionsKey: 'instrument_types', section: 'primary' },
    { key: 'status', label: 'Status', fieldType: 'select', optionsKey: 'statuses', section: 'primary' },
    { key: 'approval_status', label: 'Approval', fieldType: 'select', optionsKey: 'approval_statuses', section: 'primary' },
  ],
  secondaryFields: [
    { key: 'customer_id', label: 'Customer', fieldType: 'multi_select', optionsKey: 'customers', section: 'secondary' },
    { key: 'customer_segment', label: 'Customer Segment', fieldType: 'multi_select', optionsKey: 'vertical_sectors', section: 'secondary' },
    { key: 'business_vertical_id', label: 'Business Vertical', fieldType: 'multi_select', optionsKey: 'business_verticals', section: 'secondary' },
    { key: 'bank_name', label: 'Bank', fieldType: 'text', placeholder: 'Bank name…', section: 'secondary' },
  ],
  moreFields: [
    { key: 'amount_min', label: 'Min Amount Rs', fieldType: 'number', section: 'more' },
    { key: 'amount_max', label: 'Max Amount Rs', fieldType: 'number', section: 'more' },
    { key: 'expiry_from', label: 'Expiry From', fieldType: 'date', section: 'more' },
    { key: 'expiry_to', label: 'Expiry To', fieldType: 'date', section: 'more' },
    { key: 'expiry_days', label: 'Expiring in (days)', fieldType: 'number', placeholder: 'e.g. 30', section: 'more' },
  ],
  quickFilters: [
    { key: 'active', label: '✅ Active', params: { status: 'Active' } },
    { key: 'expiring', label: '⚠️ Expiring Soon', params: { status: 'Active', expiry_days: '30' } },
    { key: 'released', label: '🔓 Released', params: { status: 'Released' } },
  ],
}

// ─── KAM ──────────────────────────────────────────────────────────────────────

export const KAM_FILTER_CONFIG: ModuleFilterConfig = {
  module: 'kam',
  defaultParams: {},
  primaryFields: [
    presetField,
    { key: 'activity_type', label: 'Activity Type', fieldType: 'select', optionsKey: 'activity_types', section: 'primary' },
    { key: 'user_id', label: 'Assigned To', fieldType: 'multi_select', optionsKey: 'users', section: 'primary' },
  ],
  secondaryFields: [
    { key: 'customer_id', label: 'Customer', fieldType: 'multi_select', optionsKey: 'customers', section: 'secondary' },
    { key: 'customer_segment', label: 'Customer Segment', fieldType: 'multi_select', optionsKey: 'vertical_sectors', section: 'secondary' },
    { key: 'mode', label: 'Mode', fieldType: 'select', optionsKey: 'activity_modes', section: 'secondary' },
    { key: 'status', label: 'Status', fieldType: 'select', optionsKey: 'statuses', section: 'secondary' },
  ],
  moreFields: [
    { key: 'has_travel', label: 'Has Travel', fieldType: 'existence', section: 'more' },
    { key: 'next_action_from', label: 'Next Action From', fieldType: 'date', section: 'more' },
    { key: 'next_action_to', label: 'Next Action To', fieldType: 'date', section: 'more' },
    { key: 'overdue_only', label: 'Overdue Only', fieldType: 'existence', section: 'more' },
  ],
  quickFilters: [
    { key: 'week', label: '📅 This Week', params: { preset: 'this_week' } },
    { key: 'visits', label: '🤝 Customer Visits', params: { activity_type: 'Visit' } },
    { key: 'overdue', label: '⚠️ Overdue', params: { overdue_only: '1' } },
  ],
}

// ─── TRAVEL ───────────────────────────────────────────────────────────────────

export const TRAVEL_FILTER_CONFIG: ModuleFilterConfig = {
  module: 'travel',
  defaultParams: {},
  primaryFields: [
    presetField,
    { key: 'assigned_to', label: 'Employee', fieldType: 'multi_select', optionsKey: 'users', section: 'primary' },
    { key: 'status', label: 'Status', fieldType: 'select', optionsKey: 'statuses', section: 'primary' },
    { key: 'customer_id', label: 'Customer', fieldType: 'multi_select', optionsKey: 'customers', section: 'primary' },
    { key: 'visit_type', label: 'Visit Type', fieldType: 'select', optionsKey: 'visit_types', section: 'primary' },
  ],
  secondaryFields: [
    { key: 'transport_mode', label: 'Transport Mode', fieldType: 'select', optionsKey: 'transport_modes', section: 'secondary' },
    { key: 'from_city', label: 'From City', fieldType: 'text', section: 'secondary' },
    { key: 'to_city', label: 'To City', fieldType: 'text', section: 'secondary' },
    { key: 'advance_required', label: 'Advance Required', fieldType: 'select', options: [{ id: 'Yes', name: 'Yes' }, { id: 'No', name: 'No' }], section: 'secondary' },
    { key: 'source', label: 'Source', fieldType: 'select', options: [{ id: 'direct', name: 'Direct' }, { id: 'kam', name: 'KAM Activity' }], section: 'secondary' },
  ],
  moreFields: [],
  quickFilters: [
    { key: 'pending',      label: '⏳ Pending Approval',     params: { status: 'Submitted' } },
    { key: 'approved',     label: '✅ Approved',             params: { status: 'Approved' } },
    { key: 'rejected',     label: '❌ Rejected',             params: { status: 'Rejected' } },
    { key: 'this_month',   label: '📅 This Month',           params: { preset: 'this_month' } },
  ],
}

// ─── TADA ─────────────────────────────────────────────────────────────────────

export const TADA_FILTER_CONFIG: ModuleFilterConfig = {
  module: 'tada',
  defaultParams: {},
  primaryFields: [
    presetField,
    { key: 'employee_id', label: 'Assigned To', fieldType: 'multi_select', optionsKey: 'users', section: 'primary' },
    { key: 'status', label: 'Status', fieldType: 'select', optionsKey: 'statuses', section: 'primary' },
  ],
  secondaryFields: [
    { key: 'customer_id', label: 'Customer', fieldType: 'multi_select', optionsKey: 'customers', section: 'secondary' },
    { key: 'category', label: 'Category', fieldType: 'select', optionsKey: 'categories', section: 'secondary' },
  ],
  moreFields: [
    { key: 'total_min', label: 'Min Amount Rs', fieldType: 'number', section: 'more' },
    { key: 'total_max', label: 'Max Amount Rs', fieldType: 'number', section: 'more' },
    { key: 'expense_from', label: 'Expense Date From', fieldType: 'date', section: 'more' },
    { key: 'expense_to', label: 'Expense Date To', fieldType: 'date', section: 'more' },
  ],
  quickFilters: [
    { key: 'pending', label: '⏳ Pending Approval', params: { status: 'Submitted' } },
    { key: 'approved', label: '✅ Approved', params: { status: 'Approved' } },
    { key: 'rejected', label: '❌ Rejected', params: { status: 'Rejected' } },
  ],
}

// ─── OEM ──────────────────────────────────────────────────────────────────────

export const OEM_FILTER_CONFIG: ModuleFilterConfig = {
  module: 'oem',
  defaultParams: { view: '' },
  primaryFields: [
    presetField,
    { key: 'module', label: 'Source', fieldType: 'select', options: [{ id: 'tenders', name: 'Tenders' }, { id: 'leads', name: 'Leads' }], section: 'primary' },
    { key: 'oem_name', label: 'OEM Name', fieldType: 'text', placeholder: 'Filter by OEM…', section: 'primary' },
  ],
  secondaryFields: [],
  moreFields: [
    { key: 'view', label: 'View / Filter', fieldType: 'select', options: [
      { id: 'active',                 name: '✅ Active (has appearances)' },
      { id: 'inactive',               name: '🔴 Inactive (no appearances)' },
      { id: 'top',                    name: '🏆 Top OEMs' },
      { id: 'with_leads',             name: '📌 With Leads' },
      { id: 'without_leads',          name: '📌 Without Leads' },
      { id: 'with_opportunities',     name: '💡 With Opportunities' },
      { id: 'without_opportunities',  name: '💡 Without Opportunities' },
      { id: 'with_tenders',           name: '📋 With Tenders' },
      { id: 'without_tenders',        name: '📋 Without Tenders' },
      { id: 'tender_won',             name: '🏆 Tender Won' },
      { id: 'tender_lost',            name: '❌ Tender Lost' },
      { id: 'with_quotations',        name: '📃 With Quotations' },
      { id: 'with_work_orders',       name: '🔧 With Work Orders' },
      { id: 'revenue_generating',     name: '💰 Revenue Generating' },
      { id: 'high_pipeline',          name: '🚀 High Pipeline' },
      { id: 'high_conversion',        name: '📈 High Conversion' },
      { id: 'low_conversion',         name: '📉 Low Conversion' },
      { id: 'with_activity',          name: '🤝 With Activity' },
      { id: 'without_activity',       name: '🤝 Without Activity' },
      { id: 'fast_moving',            name: '⚡ Fast Moving' },
      { id: 'slow_moving',            name: '🐢 Slow Moving' },
      { id: 'without_quotations', name: '📃 Without Quotations' },
{ id: 'quotation_accepted', name: '✅ Quotation Accepted' },
{ id: 'quotation_rejected', name: '❌ Quotation Rejected' },
{ id: 'pending_quotations', name: '⏳ Pending Quotations' },
{ id: 'without_work_orders', name: '🔧 Without Work Orders' },
{ id: 'pending_work_orders', name: '⏳ Pending Work Orders' },
{ id: 'dependency', name: '🔗 Dependency' },
{ id: 'with_travel', name: '✈️ With Travel' },
{ id: 'without_travel', name: '✈️ Without Travel' },
{ id: 'product_wise', name: '📦 Product-wise' },
{ id: 'customer_wise', name: '👥 Customer-wise' },
{ id: 'region_wise', name: '🗺️ Region-wise' },
{ id: 'kam_wise', name: '👤 KAM-wise' },
    ], section: 'more' },
  ],
  quickFilters: [
    { key: 'all',                  label: '🔍 All OEMs',                    params: { view: '' } },
    { key: 'active',               label: '✅ Active',                      params: { view: 'active' } },
    { key: 'inactive',             label: '🔴 Inactive',                    params: { view: 'inactive' } },
    { key: 'top',                  label: '🏆 Top OEMs',                    params: { view: 'top' } },
    { key: 'with_leads',           label: '📌 With Leads',                  params: { view: 'with_leads' } },
    { key: 'without_leads',        label: '📌 Without Leads',               params: { view: 'without_leads' } },
    { key: 'with_opportunities',   label: '💡 With Opportunities',          params: { view: 'with_opportunities' } },
    { key: 'without_opportunities',label: '💡 Without Opportunities',       params: { view: 'without_opportunities' } },
    { key: 'with_tenders',         label: '📋 With Tenders',                params: { view: 'with_tenders' } },
    { key: 'without_tenders',      label: '📋 Without Tenders',             params: { view: 'without_tenders' } },
    { key: 'tender_won',           label: '🏆 Tender Won',                  params: { view: 'tender_won' } },
    { key: 'tender_lost',          label: '❌ Tender Lost',                 params: { view: 'tender_lost' } },
    { key: 'with_quotations',      label: '📃 With Quotations',             params: { view: 'with_quotations' } },
    { key: 'without_quotations',   label: '📃 Without Quotations',          params: { view: 'without_quotations' } },
    { key: 'quotation_accepted',   label: '✅ Quotation Accepted',          params: { view: 'quotation_accepted' } },
    { key: 'quotation_rejected',   label: '❌ Quotation Rejected',          params: { view: 'quotation_rejected' } },
    { key: 'pending_quotations',   label: '⏳ Pending Quotations',          params: { view: 'pending_quotations' } },
    { key: 'with_work_orders',     label: '🔧 With Work Orders',            params: { view: 'with_work_orders' } },
    { key: 'without_work_orders',  label: '🔧 Without Work Orders',         params: { view: 'without_work_orders' } },
    { key: 'revenue_generating',   label: '💰 Revenue Generating',          params: { view: 'revenue_generating' } },
    { key: 'pending_work_orders',  label: '⏳ Pending Work Orders',         params: { view: 'pending_work_orders' } },
    { key: 'high_pipeline',        label: '🚀 High Pipeline',               params: { view: 'high_pipeline' } },
    { key: 'low_conversion',       label: '📉 Low Conversion',              params: { view: 'low_conversion' } },
    { key: 'high_conversion',      label: '📈 High Conversion',             params: { view: 'high_conversion' } },
    { key: 'dependency',           label: '🔗 Dependency',                  params: { view: 'dependency' } },
    { key: 'with_activity',        label: '🤝 With Activity',               params: { view: 'with_activity' } },
    { key: 'without_activity',     label: '🤝 Without Activity',            params: { view: 'without_activity' } },
    { key: 'with_travel',          label: '✈️ With Travel',                 params: { view: 'with_travel' } },
    { key: 'without_travel',       label: '✈️ Without Travel',              params: { view: 'without_travel' } },
    { key: 'product_wise',         label: '📦 Product-wise',                params: { view: 'product_wise' } },
    { key: 'customer_wise',        label: '👥 Customer-wise',               params: { view: 'customer_wise' } },
    { key: 'region_wise',          label: '🗺️ Region-wise',                 params: { view: 'region_wise' } },
    { key: 'kam_wise',             label: '👤 KAM-wise',                    params: { view: 'kam_wise' } },
    { key: 'fast_moving',          label: '⚡ Fast Moving',                 params: { view: 'fast_moving' } },
    { key: 'slow_moving',          label: '🐢 Slow Moving',                 params: { view: 'slow_moving' } },
  ],
}

// ─── COMPETITORS ──────────────────────────────────────────────────────────────

export const COMPETITORS_FILTER_CONFIG: ModuleFilterConfig = {
  module: 'competitors',
  defaultParams: {},
  primaryFields: [
    presetField,
    { key: 'search', label: 'Competitor', fieldType: 'text', placeholder: 'Search competitor...', section: 'primary' },
    { key: 'threat_level', label: 'Threat Level', fieldType: 'select', options: [{ id: 'High', name: 'High' }, { id: 'Medium', name: 'Medium' }, { id: 'Low', name: 'Low' }], section: 'primary' },
    { key: 'country', label: 'Country', fieldType: 'text', placeholder: 'Country…', section: 'primary' },
  ],
  secondaryFields: [],
  moreFields: [],
  quickFilters: [
    { key: 'high',   label: '🔴 High Threat',   params: { threat_level: 'High' } },
    { key: 'medium', label: '🟡 Medium Threat',  params: { threat_level: 'Medium' } },
    { key: 'low',    label: '🟢 Low Threat',     params: { threat_level: 'Low' } },
  ],
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const MODULE_FILTER_CONFIGS: Record<string, ModuleFilterConfig> = {
  leads: LEADS_FILTER_CONFIG,
  tenders: TENDERS_FILTER_CONFIG,
  customers: CUSTOMERS_FILTER_CONFIG,
  opportunities: OPPORTUNITIES_FILTER_CONFIG,
  quotations: QUOTATIONS_FILTER_CONFIG,
  workorders: WORKORDERS_FILTER_CONFIG,
  emdbg: EMDBG_FILTER_CONFIG,
  kam: KAM_FILTER_CONFIG,
  travel: TRAVEL_FILTER_CONFIG,
  tada: TADA_FILTER_CONFIG,
  oem: OEM_FILTER_CONFIG,
  competitors: COMPETITORS_FILTER_CONFIG,
}
