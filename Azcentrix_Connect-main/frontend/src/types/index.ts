// ── Auth & User ───────────────────────────────────────────────────────────────
export interface User {
  id: number
  username: string
  email: string
  full_name: string
  role: 'admin' | 'ceo' | 'vp' | 'manager' | 'sales' | 'support' | 'accounts'
  department?: string
  designation?: string
  phone?: string
  region?: string
  branch?: string
  employee_code?: string
  reporting_manager_id?: number
  reporting_manager_ids?: number[]
  region_id?: number | null
  state_id?: number | null
  group_id?: number | null
  group_ids?: number[]
  group_name?: string | null
  groups?: Array<{
    id: number
    name: string
    reporting_hierarchy?: Array<{
      reporting_user_id?: number | null
      reporting_role: string
      level: number
      user_name?: string | null
    }>
  }>
  target?: number | string | null
  last_login?: string | null
  is_active: boolean
  avatar_url?: string
}

export interface SessionPolicy {
  login_expiry_minutes: number
}

export interface AuthState {
  user: User | null
  access_token: string | null
  refresh_token: string | null
  permissions: string[]
  tenant_slug: string | null
  session_policy: SessionPolicy | null
}

// ── Theme ─────────────────────────────────────────────────────────────────────
export interface TenantTheme {
  primary_color: string
  secondary_color?: string
  accent_color?: string
  sidebar_color?: string
  success_color?: string
  warning_color?: string
  danger_color?: string
  theme_logo?: string
  theme_logo_version?: string
  logo_url?: string
  company_name: string
  font_family?: string
  font_size?: string
  date_format?: 'DD-MM-YYYY' | 'MM-DD-YYYY' | 'YYYY-MM-DD'
}

// ── Customer ──────────────────────────────────────────────────────────────────
export interface Customer {
  id: number
  customer_name: string
  customer_vertical?: string
  division?: string
  group_name?: string
  parent_account_id?: number
  billing_address?: string
  billing_pincode?: string
  billing_country?: string
  billing_state?: string
  billing_city?: string
  billing_area?: string
  shipping_same_as_billing?: boolean
  shipping_address?: string
  shipping_pincode?: string
  shipping_country?: string
  shipping_state?: string
  shipping_city?: string
  shipping_area?: string
  contact_person?: string
  designation?: string
  office_phone?: string
  website?: string
  mobile_numbers?: string[]
  office_email?: string
  gst_number?: string
  account_status: 'Active' | 'Inactive' | 'Prospect' | 'Churned'
  account_potential: 'High' | 'Medium' | 'Low'
  assigned_to?: number
  approval_status?: 'pending' | 'approved' | 'rejected'
  approval_display?: string
  approval_progress_current?: number
  approval_progress_total?: number
  approval_request_id?: number
  remarks?: string
  created_at?: string
}

// ── Lead ──────────────────────────────────────────────────────────────────────
export type LeadStatus = 'New' | 'Assigned' | 'Qualified' | 'Opportunity Created' | 'Converted' | 'Lost'
export type LeadPriority = 'High' | 'Medium' | 'Low'

export interface Product {
  name: string
  quantity: number
  oem?: string
  price?: number
  gst?: number
}

export interface Lead {
  id: number
  lead_title: string
  customer_id?: number
  customer_name?: string
  dept?: string
  bu_division?: string
  zone_branch?: string
  contact?: string
  desig?: string
  mobile?: string
  email?: string
  source?: string
  source_id?: number
  priority: LeadPriority
  tender_id?: string
  products?: Product[]
  est_value?: number
  timeline?: string
  competitors?: string
  competitor_ids?: number[]
  assigned_to?: number
  region?: string
  branch?: string
  status: LeadStatus
  approval_status?: 'pending' | 'approved' | 'rejected'
  approval_requested_to?: number
  approval_notes?: string
  follow_up?: string
  notes?: string
  created_by?: number
  created_at?: string
}

// ── Tender ────────────────────────────────────────────────────────────────────
export interface Tender {
  id: number
  tender_num: string
  lead_id?: number
  customer_id?: number
  customer_name?: string
  tender_status: 'Aligned' | 'Evaluation' | 'Pre-Bid' | 'Reverse Auction' | 'Submitted' | 'Closed'
  result: 'Pending' | 'Won' | 'Lost' | 'Cancelled'
  value?: number
  bid_date?: string
  submission_date?: string
  assigned_to?: number
  approval_status?: 'pending' | 'approved' | 'rejected'
  products?: Product[]
  l1_company?: string
  l2_company?: string
  l3_company?: string
  notes?: string
  created_at?: string
}

// ── Notification ──────────────────────────────────────────────────────────────
export interface Notification {
  id: number
  user_id: number
  title: string
  message: string
  type: 'info' | 'approval' | 'warning' | 'success'
  module?: string
  record_id?: number
  is_read: boolean
  created_at: string
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export interface DashboardOverview {
  total_leads: number
  new_leads: number
  converted_leads: number
  my_leads: number
  total_tenders: number
  active_tenders: number
  won_tenders: number
  upcoming_bids: number
  won_value: number
  pipeline_value: number
  total_customers: number
  active_wo: number
  delayed_wo: number
  emdbg_expiring: number
}

export interface WidgetConfig {
  id: string
  visible: boolean
  order: number
}

export interface DashboardData {
  overview: DashboardOverview
  approvals: { pending_leads: number; pending_tenders: number }
  lead_by_status: { status: string; count: number }[]
  tender_by_result: { result: string; count: number }[]
  monthly_trend: { month: string; leads: number }[]
  recent_activities: { id: number; icon: string; text: string; bg_color: string; created_at: string }[]
}

// ── API Response ──────────────────────────────────────────────────────────────
export interface ApiError {
  detail: string
  status?: number
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  skip: number
  limit: number
}

// ── Form ──────────────────────────────────────────────────────────────────────
export interface SelectOption {
  value: string | number
  label: string
}

// ── Travel ────────────────────────────────────────────────────────────────────
export interface TravelRequest {
  id: number
  employee_id: number
  purpose: string
  destination: string
  travel_date: string
  return_date: string
  mode_of_travel: string
  estimated_cost?: number
  advance_required: boolean
  advance_amount?: number
  status: 'Pending' | 'Approved' | 'Rejected' | 'Completed'
  approved_by?: number
  rejection_reason?: string
  notes?: string
}
