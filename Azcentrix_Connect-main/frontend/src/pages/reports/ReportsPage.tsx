import { useState, useEffect, useMemo, lazy, Suspense, useCallback, type ReactNode } from 'react'
import { ReportDateRangeCtx, ReportToolbarCtx } from './reportToolbarContext'
import { ReportDateRangeToolbar } from './reportViewShared'
const LeadsReportView     = lazy(() => import('./LeadsReportView'))
const TendersReportView   = lazy(() => import('./TendersReportView'))
const CustomersReportView = lazy(() => import('./CustomersReportView'))
const OpportunitiesReportView = lazy(() => import('./OpportunitiesReportView'))
const QuotationsReportView = lazy(() => import('./QuotationsReportView'))
const WorkordersReportView = lazy(() => import('./WorkordersReportView'))
const EMDBGReportView      = lazy(() => import('./EMDBGReportView'))
const KAMReportView        = lazy(() => import('./KAMReportView'))
const TravelReportView      = lazy(() => import('./TravelReportView'))
const OEMReportView         = lazy(() => import('./OEMReportView'))
const CompetitorsReportView = lazy(() => import('./CompetitorsReportView'))
import {
  TrendingUp, FileText, Shield, Activity, Users, BarChart2,
  Download, Filter, CheckCircle2, AlertCircle, Clock, Target, Zap, DollarSign,
  Cpu, Brain, Globe, Award, Building2, Package, RefreshCw, GripVertical,
} from 'lucide-react'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, horizontalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import api from '@/services/api'
import { usePermissions } from '@/hooks'
import { useModuleName } from '@/context/ModuleLabelsContext'
import Card from '@/components/ui/Card'
import { DataTable, StatusBadge, type Column } from '@/components/ui/DataTable'
import { StatCard, useToast } from '@/components/ui/FormComponents'
import Button from '@/components/ui/Button'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from 'recharts'

// ─── palette ──────────────────────────────────────────────────────────────────
const PIE_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4', '#EC4899', '#84CC16']

// ─── formatters ───────────────────────────────────────────────────────────────
const fmtCur = (v: unknown): string => {
  const n = Number(v)
  if (v == null || v === '' || isNaN(n)) return '—'
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`
  return `₹${n.toLocaleString('en-IN')}`
}
const fmtPct = (v: unknown) => { const n = Number(v); return isNaN(n) ? '—' : `${n.toFixed(1)}%` }
const fmtNum = (v: unknown) => { const n = Number(v); return isNaN(n) ? '—' : n.toLocaleString('en-IN') }

// ─── types ────────────────────────────────────────────────────────────────────
type FmtType   = 'number' | 'currency' | 'percent'
type ColorType = 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'indigo'

interface SumCfg { key: string; label: string; color: ColorType; fmt?: FmtType; icon: React.ReactNode }
interface FilterDef {
  key: string; label: string
  type: 'date' | 'select' | 'number' | 'month' | 'text'
  options?: string[]; placeholder?: string
}
interface ReportDef {
  key: string; label: string; icon: React.ReactNode; dot: string; description: string
  filters: FilterDef[]
  summaryConfig: SumCfg[]
  chart1Label: string
  chart2Label: string
  columns: () => Column<Record<string, unknown>>[]
}

// ─── progress bar cell ────────────────────────────────────────────────────────
const ProgressCell = ({ v }: { v: unknown }) => (
  <div className="flex items-center gap-2">
    <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden" style={{ minWidth: 56 }}>
      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Number(v) || 0}%` }} />
    </div>
    <span className="text-xs font-medium text-gray-600 w-8 text-right">{Number(v) || 0}%</span>
  </div>
)

const DaysCell = ({ v }: { v: unknown }) => {
  const n = Number(v)
  const cls = n < 0 ? 'text-red-600' : n <= 7 ? 'text-orange-500' : n <= 30 ? 'text-amber-600' : 'text-emerald-600'
  return <span className={`font-semibold text-sm ${cls}`}>{n < 0 ? `${Math.abs(n)}d ago` : `${n}d`}</span>
}

const TruncCell = ({ v, max = 120 }: { v: unknown; max?: number }) => {
  const s = String(v || '')
  if (!s) return <span className="text-gray-300">—</span>
  return <span title={s} className="text-xs text-gray-600">{s.length > max ? s.slice(0, max) + '…' : s}</span>
}

// ─── report configs ───────────────────────────────────────────────────────────
const REPORTS: ReportDef[] = [
  {
    key: 'leads', label: 'Leads', icon: <TrendingUp size={16} />,
    dot: 'bg-blue-600', description: 'Full pipeline analysis with products, OEMs and conversion tracking',
    chart1Label: 'Leads by Status', chart2Label: 'Leads by Priority',
    filters: [
      { key: 'date_from',    type: 'date',   label: 'Date From' },
      { key: 'date_to',      type: 'date',   label: 'Date To' },
      { key: 'status',       type: 'select', label: 'Status',
        options: ['Assigned', 'Contacted', 'Qualified', 'Proposal Pending', 'Nurturing', 'Opportunity Created', 'Converted', 'Lost'] },
      { key: 'priority',     type: 'select', label: 'Priority',  options: ['Low', 'Medium', 'High'] },
      { key: 'product_name', type: 'text',   label: 'Product',   placeholder: 'e.g. Dell Server' },
    ],
    summaryConfig: [
      { key: 'total',           label: 'Total Leads',      color: 'blue',   icon: <TrendingUp size={20}/> },
      { key: 'total_value',     label: 'Total Est. Value', color: 'green',  fmt: 'currency', icon: <DollarSign size={20}/> },
      { key: 'converted',       label: 'Converted',        color: 'indigo', icon: <CheckCircle2 size={20}/> },
      { key: 'conversion_rate', label: 'Conversion Rate',  color: 'purple', fmt: 'percent',  icon: <Target size={20}/> },
    ],
    columns: () => [
      { key: 'id',                  header: '#',              width: '55px', sortable: false },
      { key: 'lead_ref_id',         header: 'Ref ID',         sortable: true, searchable: true, hidden: true },
      { key: 'lead_title',          header: 'Lead Title',     sortable: true, searchable: true, minWidth: '180px' },
      { key: 'customer_name',       header: 'Customer',       sortable: true, searchable: true },
      { key: 'status',              header: 'Status',         sortable: true,
        render: (v) => <StatusBadge status={String(v || '')} /> },
      { key: 'priority',            header: 'Priority',       sortable: true,
        render: (v) => v ? <StatusBadge status={String(v)} /> : <span className="text-gray-300">—</span> },
      { key: 'est_value',           header: 'Est. Value',     sortable: true, align: 'right',
        render: (v) => <span className="font-semibold text-gray-900">{fmtCur(v)}</span> },
      { key: 'region',              header: 'Region',         sortable: true, hidden: true },
      { key: 'branch',              header: 'Branch',         sortable: true, hidden: true },
      { key: 'contact_person',      header: 'Contact',        sortable: true, searchable: true, hidden: true },
      { key: 'designation',         header: 'Designation',    sortable: false, hidden: true },
      { key: 'mobile',              header: 'Mobile',         sortable: false, hidden: true },
      { key: 'email',               header: 'Email',          sortable: false, hidden: true },
      { key: 'department',          header: 'Department',     sortable: true, hidden: true },
      { key: 'timeline',            header: 'Timeline',       sortable: false, hidden: true },
      { key: 'products',            header: 'Products',       sortable: false, searchable: true, minWidth: '160px',
        render: (v) => <TruncCell v={v} /> },
      { key: 'oems',                header: 'OEMs',           sortable: false, searchable: true, minWidth: '140px',
        render: (v) => <TruncCell v={v} /> },
      { key: 'follow_up',           header: 'Follow Up',      sortable: true },
      { key: 'assigned_to',         header: 'Assigned To',    sortable: true, searchable: true },
      { key: 'created_by',          header: 'Created By',     sortable: true, hidden: true },
      { key: 'approval_status',     header: 'Approval',       sortable: true, hidden: true,
        render: (v) => v && v !== 'none' ? <StatusBadge status={String(v)} /> : <span className="text-gray-300 text-xs">—</span> },
      { key: 'rejection_reason',    header: 'Rejection',      sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
      { key: 'converted_at',        header: 'Converted On',   sortable: true, hidden: true },
      { key: 'lost_at',             header: 'Lost On',        sortable: true, hidden: true },
      { key: 'notes',               header: 'Notes',          sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
      { key: 'created_at',          header: 'Created',        sortable: true },
    ],
  },
  {
    key: 'tenders', label: 'Tenders', icon: <FileText size={16} />,
    dot: 'bg-purple-600', description: 'Full bid management with products, OEMs, win/loss and financial details',
    chart1Label: 'Tenders by Result', chart2Label: 'Tenders by Portal',
    filters: [
      { key: 'date_from',          type: 'date',   label: 'Date From' },
      { key: 'date_to',            type: 'date',   label: 'Date To' },
      { key: 'status',             type: 'select', label: 'Status',
        options: ['Aligned', 'Evaluation', 'Pre-Bid', 'Reverse Auction', 'Submitted', 'Closed'] },
      { key: 'result',             type: 'select', label: 'Result',
        options: ['Pending', 'Won', 'Lost', 'Cancelled'] },
      { key: 'source_portal',      type: 'select', label: 'Source Portal',
        options: ['IREPS', 'GeM', 'CPP', 'CPPP', 'NIC', 'Direct', 'Other'] },
      { key: 'tech_bid_eligible',  type: 'select', label: 'Tech Bid',
        options: ['Eligible', 'Not Eligible', 'Not Evaluated'] },
      { key: 'product_name',       type: 'text',   label: 'Product',   placeholder: 'e.g. Cable' },
      { key: 'oem_name',           type: 'text',   label: 'OEM',       placeholder: 'e.g. Dell' },
    ],
    summaryConfig: [
      { key: 'total',           label: 'Total Tenders',  color: 'blue',   icon: <FileText size={20}/> },
      { key: 'won',             label: 'Won',            color: 'green',  icon: <CheckCircle2 size={20}/> },
      { key: 'total_bid_value', label: 'Total Bid Value',color: 'indigo', fmt: 'currency', icon: <DollarSign size={20}/> },
      { key: 'win_rate',        label: 'Win Rate',       color: 'purple', fmt: 'percent',  icon: <Target size={20}/> },
    ],
    columns: () => [
      { key: 'tender_num',          header: 'Tender #',       sortable: true, searchable: true, minWidth: '130px' },
      { key: 'tender_title',        header: 'Title',          sortable: true, searchable: true, minWidth: '160px',
        render: (v) => <TruncCell v={v} max={60} /> },
      { key: 'customer_name',       header: 'Customer',       sortable: true, searchable: true },
      { key: 'source_portal',       header: 'Portal',         sortable: true,
        render: (v) => v ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-indigo-50 text-indigo-700">
            {String(v)}
          </span>
        ) : <span className="text-gray-300">—</span> },
      { key: 'portal_ref_number',   header: 'Portal Ref',     sortable: true, hidden: true },
      { key: 'tender_status',       header: 'Status',         sortable: true,
        render: (v) => <StatusBadge status={String(v || '')} /> },
      { key: 'result',              header: 'Result',         sortable: true,
        render: (v) => <StatusBadge status={String(v || 'Pending')} /> },
      { key: 'current_step',        header: 'Step',           sortable: true, align: 'center', hidden: true,
        render: (v) => <span className="font-bold text-blue-700">{String(v)}/5</span> },
      { key: 'published_date',      header: 'Published',      sortable: true, hidden: true },
      { key: 'pre_bid_date',        header: 'Pre-Bid Date',   sortable: true, hidden: true },
      { key: 'submission_date',     header: 'Submission Date',sortable: true },
      { key: 'result_date',         header: 'Result Date',    sortable: true, hidden: true },
      { key: 'est_value',           header: 'Est. Value',     sortable: true, align: 'right', hidden: true,
        render: (v) => fmtCur(v) },
      { key: 'bid_amount',          header: 'Our Bid',        sortable: true, align: 'right',
        render: (v) => <span className="font-semibold">{fmtCur(v)}</span> },
      { key: 'reverse_auction_final', header: 'RA Final Bid', sortable: true, align: 'right', hidden: true,
        render: (v) => fmtCur(v) },
      { key: 'emd_required',        header: 'EMD Req.',       sortable: true, align: 'center', hidden: true },
      { key: 'emd_amount',          header: 'EMD Amount',     sortable: true, align: 'right',
        render: (v) => fmtCur(v) },
      { key: 'emd_method',          header: 'EMD Method',     sortable: true, hidden: true },
      { key: 'emd_reference',       header: 'EMD Ref',        sortable: false, hidden: true },
      { key: 'pbg_required',        header: 'PBG Req.',       sortable: true, align: 'center', hidden: true },
      { key: 'pbg_amount',          header: 'PBG Amount',     sortable: true, align: 'right', hidden: true,
        render: (v) => fmtCur(v) },
      { key: 'tender_fee_required', header: 'Fee Req.',       sortable: true, align: 'center', hidden: true },
      { key: 'tender_fee_amount',   header: 'Tender Fee',     sortable: true, align: 'right', hidden: true,
        render: (v) => fmtCur(v) },
      { key: 'tech_bid_eligible',   header: 'Tech Bid',       sortable: true, hidden: true,
        render: (v) => v ? <StatusBadge status={String(v)} /> : <span className="text-gray-300">—</span> },
      { key: 'reverse_auction',     header: 'RA',             sortable: true, align: 'center', hidden: true },
      { key: 'split_order',         header: 'Split',          sortable: true, align: 'center', hidden: true },
      { key: 'products_boq',        header: 'Products (BOQ)', sortable: false, searchable: true, minWidth: '150px',
        render: (v) => <TruncCell v={v} /> },
      { key: 'oems_boq',            header: 'OEMs (BOQ)',     sortable: false, searchable: true, minWidth: '140px',
        render: (v) => <TruncCell v={v} /> },
      { key: 'products_final',      header: 'Products (Final)',sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} /> },
      { key: 'oems_final',          header: 'OEMs (Final)',   sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} /> },
      { key: 'workflow_status',     header: 'Workflow',       sortable: true, hidden: true,
        render: (v) => v ? <StatusBadge status={String(v)} /> : <span className="text-gray-300">—</span> },
      { key: 'assigned_to',         header: 'Assigned To',    sortable: true, searchable: true },
      { key: 'created_by',          header: 'Created By',     sortable: true, hidden: true },
      { key: 'notes',               header: 'Notes',          sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
      { key: 'created_at',          header: 'Created',        sortable: true },
    ],
  },
  {
    key: 'opportunities', label: 'Opportunities', icon: <Target size={16} />,
    dot: 'bg-sky-600', description: 'Dedicated pipeline report with quote coverage, approval state and conversion readiness',
    chart1Label: 'Opportunities by Stage', chart2Label: 'Opportunities by Priority',
    filters: [
      { key: 'date_from', type: 'date', label: 'Date From' },
      { key: 'date_to',   type: 'date', label: 'Date To' },
      { key: 'stage',     type: 'select', label: 'Stage',
        options: ['Opportunity', 'Request Conversion', 'Rejected', 'Converted'] },
      { key: 'priority',  type: 'select', label: 'Priority', options: ['Low', 'Medium', 'High'] },
    ],
    summaryConfig: [
      { key: 'total',            label: 'Total Opportunities', color: 'blue',   icon: <Target size={20}/> },
      { key: 'pipeline_value',   label: 'Pipeline Value',      color: 'green',  fmt: 'currency', icon: <DollarSign size={20}/> },
      { key: 'pending_approval', label: 'Pending Approval',    color: 'amber',  icon: <Clock size={20}/> },
      { key: 'converted',        label: 'Converted',           color: 'indigo', icon: <CheckCircle2 size={20}/> },
    ],
    columns: () => [
      { key: 'opportunity_ref_id', header: 'Opportunity #', sortable: true, searchable: true, minWidth: '140px' },
      { key: 'lead_title',         header: 'Title',         sortable: true, searchable: true, minWidth: '200px' },
      { key: 'customer_name',      header: 'Customer',      sortable: true, searchable: true },
      { key: 'stage',              header: 'Stage',         sortable: true,
        render: (v) => <StatusBadge status={String(v || '')} /> },
      { key: 'est_value',          header: 'Pipeline Value',sortable: true, align: 'right',
        render: (v) => fmtCur(v) },
      { key: 'quotation_count',    header: 'Quotes',        sortable: true, align: 'center' },
      { key: 'assigned_to',        header: 'Owner',         sortable: true, searchable: true },
      { key: 'created_at',         header: 'Created',       sortable: true },
    ],
  },
  {
    key: 'customers', label: 'Customers', icon: <Users size={16} />,
    dot: 'bg-emerald-600', description: 'Full account portfolio with address, financials and segmentation',
    chart1Label: 'Accounts by Status', chart2Label: 'Accounts by Potential',
    filters: [
      { key: 'status',        type: 'select', label: 'Account Status',
        options: ['Active', 'Inactive', 'Prospect', 'Churned'] },
      { key: 'potential',     type: 'select', label: 'Potential',
        options: ['High', 'Medium', 'Low'] },
      { key: 'vertical',      type: 'text',   label: 'Vertical',       placeholder: 'e.g. Railways' },
      { key: 'billing_state', type: 'text',   label: 'State',          placeholder: 'e.g. Maharashtra' },
    ],
    summaryConfig: [
      { key: 'total',                label: 'Total Accounts',   color: 'blue',   icon: <Users size={20}/> },
      { key: 'active',               label: 'Active',           color: 'green',  icon: <CheckCircle2 size={20}/> },
      { key: 'prospects',            label: 'Prospects',        color: 'amber',  icon: <Target size={20}/> },
      { key: 'total_potential_value',label: 'Potential Value',  color: 'purple', fmt: 'currency', icon: <DollarSign size={20}/> },
    ],
    columns: () => [
      { key: 'id',                  header: '#',              width: '55px', sortable: false },
      { key: 'customer_name',       header: 'Customer',       sortable: true, searchable: true, minWidth: '180px' },
      { key: 'customer_vertical',   header: 'Vertical',       sortable: true, searchable: true },
      { key: 'division',            header: 'Division',       sortable: true },
      { key: 'group_name',          header: 'Group',          sortable: true, hidden: true },
      { key: 'industry',            header: 'Industry',       sortable: true, hidden: true },
      { key: 'account_status',      header: 'Status',         sortable: true,
        render: (v) => <StatusBadge status={String(v || '')} /> },
      { key: 'account_potential',   header: 'Potential',      sortable: true,
        render: (v) => v ? <StatusBadge status={String(v)} /> : <span className="text-gray-300">—</span> },
      { key: 'potential_value',     header: 'Potential Value',sortable: true, align: 'right', hidden: true,
        render: (v) => fmtCur(v) },
      { key: 'annual_revenue',      header: 'Annual Revenue', sortable: true, align: 'right', hidden: true,
        render: (v) => fmtCur(v) },
      { key: 'employee_count',      header: 'Employees',      sortable: true, align: 'right', hidden: true },
      { key: 'gst_number',          header: 'GST',            sortable: false },
      { key: 'pan_number',          header: 'PAN',            sortable: false, hidden: true },
      { key: 'billing_area',        header: 'Area',           sortable: true, hidden: true },
      { key: 'billing_city',        header: 'City',           sortable: true, searchable: true },
      { key: 'billing_state',       header: 'State',          sortable: true },
      { key: 'billing_country',     header: 'Country',        sortable: true, hidden: true },
      { key: 'billing_pincode',     header: 'Pincode',        sortable: false, hidden: true },
      { key: 'billing_address',     header: 'Address',        sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
      { key: 'website',             header: 'Website',        sortable: false, hidden: true },
      { key: 'remarks',             header: 'Remarks',        sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
      { key: 'assigned_to',         header: 'Assigned To',    sortable: true, searchable: true },
      { key: 'created_by',          header: 'Created By',     sortable: true, hidden: true },
      { key: 'created_at',          header: 'Created',        sortable: true },
    ],
  },
  {
    key: 'quotations', label: 'Quotations', icon: <FileText size={16} />,
    dot: 'bg-violet-600', description: 'Dedicated quotation lifecycle report with validity, revisions and approval exposure',
    chart1Label: 'Quotations by Status', chart2Label: 'Quotations by Source',
    filters: [
      { key: 'date_from',   type: 'date',   label: 'Date From' },
      { key: 'date_to',     type: 'date',   label: 'Date To' },
      { key: 'status',      type: 'select', label: 'Status',
        options: ['Draft', 'Sent', 'Approved', 'Accepted', 'Rejected'] },
      { key: 'source_type', type: 'select', label: 'Source',
        options: ['opportunity', 'tender'] },
    ],
    summaryConfig: [
      { key: 'total',            label: 'Total Quotations', color: 'blue',   icon: <FileText size={20}/> },
      { key: 'total_amount',     label: 'Total Value',      color: 'green',  fmt: 'currency', icon: <DollarSign size={20}/> },
      { key: 'pending_approval', label: 'Pending Approval', color: 'amber',  icon: <Clock size={20}/> },
      { key: 'accepted_value',   label: 'Accepted Value',   color: 'indigo', fmt: 'currency', icon: <CheckCircle2 size={20}/> },
    ],
    columns: () => [
      { key: 'quotation_number', header: 'Quotation #', sortable: true, searchable: true, minWidth: '130px' },
      { key: 'customer_name',    header: 'Customer',    sortable: true, searchable: true, minWidth: '160px' },
      { key: 'source_type',      header: 'Source',      sortable: true,
        render: (v) => (
          <span className="inline-flex items-center rounded-md bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
            {String(v || '')}
          </span>
        ) },
      { key: 'status',           header: 'Status',      sortable: true,
        render: (v) => <StatusBadge status={String(v || '')} /> },
      { key: 'approval_status',  header: 'Approval',    sortable: true, hidden: true,
        render: (v) => v ? <StatusBadge status={String(v)} /> : <span className="text-gray-300">-</span> },
      { key: 'total_amount',     header: 'Total Value', sortable: true, align: 'right',
        render: (v) => fmtCur(v) },
      { key: 'valid_until',      header: 'Valid Until', sortable: true },
      { key: 'line_item_count',  header: 'Items',       sortable: true, align: 'center' },
      { key: 'created_by',       header: 'Created By',  sortable: true, searchable: true },
      { key: 'created_at',       header: 'Created',     sortable: true },
    ],
  },
  {
    key: 'workorders', label: 'Work Orders', icon: <BarChart2 size={16} />,
    dot: 'bg-indigo-600', description: 'Full project tracking with products, milestones and payment details',
    chart1Label: 'WOs by Status', chart2Label: 'WOs by Type',
    filters: [
      { key: 'date_from', type: 'date',   label: 'Date From' },
      { key: 'date_to',   type: 'date',   label: 'Date To' },
      { key: 'status',    type: 'select', label: 'Status',
        options: ['Draft', 'Confirmed', 'In Progress', 'On Hold', 'Delayed', 'Completed', 'Cancelled', 'Closed'] },
      { key: 'wo_type',   type: 'select', label: 'WO Type',
        options: ['Supply', 'Supply & Installation', 'AMC', 'Service', 'Turnkey'] },
    ],
    summaryConfig: [
      { key: 'total',       label: 'Total Orders',  color: 'blue',   icon: <BarChart2 size={20}/> },
      { key: 'total_value', label: 'Total WO Value',color: 'green',  fmt: 'currency', icon: <DollarSign size={20}/> },
      { key: 'in_progress', label: 'In Progress',   color: 'indigo', icon: <Clock size={20}/> },
      { key: 'completed',   label: 'Completed',     color: 'amber',  icon: <CheckCircle2 size={20}/> },
    ],
    columns: () => [
      { key: 'wo_number',          header: 'WO Number',      sortable: true, searchable: true, minWidth: '130px' },
      { key: 'project_title',      header: 'Project Title',  sortable: true, searchable: true, minWidth: '160px',
        render: (v) => <TruncCell v={v} max={60} /> },
      { key: 'client_name',        header: 'Client',         sortable: true, searchable: true },
      { key: 'wo_type',            header: 'Type',           sortable: true },
      { key: 'status',             header: 'Status',         sortable: true,
        render: (v) => <StatusBadge status={String(v || '')} /> },
      { key: 'progress_percent',   header: 'Progress',       sortable: true, align: 'center', minWidth: '130px',
        render: (v) => <ProgressCell v={v} /> },
      { key: 'po_number',          header: 'PO Number',      sortable: true, searchable: true },
      { key: 'po_date',            header: 'PO Date',        sortable: true, hidden: true },
      { key: 'po_value',           header: 'PO Value',       sortable: true, align: 'right', hidden: true,
        render: (v) => fmtCur(v) },
      { key: 'wo_value',           header: 'WO Value',       sortable: true, align: 'right',
        render: (v) => <span className="font-semibold">{fmtCur(v)}</span> },
      { key: 'delivery_date',      header: 'Delivery Date',  sortable: true },
      { key: 'installation_date',  header: 'Installation',   sortable: true, hidden: true },
      { key: 'completion_date',    header: 'Completion',     sortable: true, hidden: true },
      { key: 'site_location',      header: 'Site Location',  sortable: true, hidden: true },
      { key: 'site_engineer',      header: 'Site Engineer',  sortable: true, hidden: true },
      { key: 'project_manager',    header: 'Project Manager',sortable: true },
      { key: 'advance_percent',    header: 'Advance %',      sortable: true, align: 'right', hidden: true },
      { key: 'advance_amount',     header: 'Advance Amt',    sortable: true, align: 'right', hidden: true,
        render: (v) => fmtCur(v) },
      { key: 'advance_received',   header: 'Adv Received',   sortable: true, align: 'center', hidden: true },
      { key: 'retention_percent',  header: 'Retention %',    sortable: true, align: 'right', hidden: true },
      { key: 'warranty_months',    header: 'Warranty (mo)',  sortable: true, align: 'center' },
      { key: 'warranty_expiry',    header: 'Warranty Expiry',sortable: true, hidden: true },
      { key: 'products',           header: 'Products',       sortable: false, searchable: true,
        render: (v) => <TruncCell v={v} /> },
      { key: 'total_ordered_qty',  header: 'Ordered Qty',    sortable: true, align: 'right', hidden: true },
      { key: 'total_delivered_qty',header: 'Delivered Qty',  sortable: true, align: 'right', hidden: true },
      { key: 'payment_terms',      header: 'Payment Terms',  sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
      { key: 'scope_of_work',      header: 'Scope',          sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
      { key: 'notes',              header: 'Notes',          sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
      { key: 'created_by',         header: 'Created By',     sortable: true, hidden: true },
      { key: 'created_at',         header: 'Created',        sortable: true },
    ],
  },
  {
    key: 'emdbg', label: 'EMD / BG', icon: <Shield size={16} />,
    dot: 'bg-amber-500', description: 'Financial instruments, guarantee expiry, renewal and release tracking',
    chart1Label: 'By Expiry Health', chart2Label: 'By Instrument Type',
    filters: [
      { key: 'instrument_type', type: 'select', label: 'Instrument Type',
        options: ['EMD', 'Performance BG', 'Security Deposit', 'Advance BG', 'Retention BG', 'DD', 'Online Payment'] },
      { key: 'status',          type: 'select', label: 'Status',
        options: ['Active', 'Expired', 'Released', 'Encashed', 'Renewed', 'Cancelled'] },
      { key: 'expiry_days',     type: 'number', label: 'Expiry Within (days)', placeholder: 'e.g. 30' },
      { key: 'bank_name',       type: 'text',   label: 'Bank',                placeholder: 'e.g. SBI' },
    ],
    summaryConfig: [
      { key: 'total',        label: 'Total Instruments', color: 'blue',  icon: <Shield size={20}/> },
      { key: 'total_amount', label: 'Total Amount',      color: 'green', fmt: 'currency', icon: <DollarSign size={20}/> },
      { key: 'expired',      label: 'Expired',           color: 'red',   icon: <AlertCircle size={20}/> },
      { key: 'critical',     label: 'Critical (≤7d)',    color: 'amber', icon: <Zap size={20}/> },
    ],
    columns: () => [
      { key: 'reference_num',    header: 'Reference #',    sortable: true, searchable: true, minWidth: '130px' },
      { key: 'tender_num',       header: 'Tender #',       sortable: true, searchable: true },
      { key: 'client_name',      header: 'Client',         sortable: true, searchable: true },
      { key: 'instrument_type',  header: 'Type',           sortable: true },
      { key: 'instrument_number',header: 'Instrument No',  sortable: true, hidden: true },
      { key: 'amount',           header: 'Amount',         sortable: true, align: 'right',
        render: (v) => <span className="font-semibold">{fmtCur(v)}</span> },
      { key: 'wo_value',         header: 'WO Value',       sortable: true, align: 'right', hidden: true,
        render: (v) => fmtCur(v) },
      { key: 'bank_name',        header: 'Bank',           sortable: true, searchable: true },
      { key: 'bank_branch',      header: 'Branch',         sortable: true, hidden: true },
      { key: 'issued_date',      header: 'Issued',         sortable: true, hidden: true },
      { key: 'submitted_date',   header: 'Submitted',      sortable: true, hidden: true },
      { key: 'valid_from',       header: 'Valid From',     sortable: true, hidden: true },
      { key: 'expiry_date',      header: 'Expiry Date',    sortable: true },
      { key: 'status',           header: 'Status',         sortable: true,
        render: (v) => <StatusBadge status={String(v || '')} /> },
      { key: 'renewal_status',   header: 'Renewal',        sortable: true, hidden: true,
        render: (v) => v && v !== 'none' ? <StatusBadge status={String(v)} /> : <span className="text-gray-300">—</span> },
      { key: 'renewal_date',     header: 'Renewed Date',   sortable: true, hidden: true },
      { key: 'release_date',     header: 'Release Date',   sortable: true, hidden: true },
      { key: 'po_number',        header: 'PO Number',      sortable: true, hidden: true },
      { key: 'currency',         header: 'Currency',       sortable: true, hidden: true },
      { key: 'purpose',          header: 'Purpose',        sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
      { key: 'days_to_expiry',   header: 'Days Left',      sortable: true, align: 'center',
        render: (v) => <DaysCell v={v} /> },
      { key: 'expiry_status',    header: 'Expiry Health',  sortable: true,
        render: (v) => <StatusBadge status={String(v || '')} /> },
      { key: 'notes',            header: 'Notes',          sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
      { key: 'created_by',       header: 'Created By',     sortable: true, hidden: true },
      { key: 'created_at',       header: 'Created',        sortable: true, hidden: true },
    ],
  },
  {
    key: 'kam', label: 'KAM Activities', icon: <Activity size={16} />,
    dot: 'bg-teal-600', description: 'Sales activity tracking with travel, outcomes and team performance',
    chart1Label: 'Activities by Type', chart2Label: 'Activities by Mode',
    filters: [
      { key: 'period',        type: 'month',  label: 'Period' },
      { key: 'activity_type', type: 'select', label: 'Activity Type',
        options: ['Task', 'Daily Call', 'Meeting', 'Demo', 'Site Visit', 'Follow-up', 'Email', 'Presentation', 'Proposal'] },
      { key: 'mode',          type: 'select', label: 'Mode',
        options: ['In-Person', 'Phone', 'Video Call', 'Email'] },
    ],
    summaryConfig: [
      { key: 'total',              label: 'Total Activities',  color: 'blue',   icon: <Activity size={20}/> },
      { key: 'completed',          label: 'Completed',         color: 'green',  icon: <CheckCircle2 size={20}/> },
      { key: 'total_duration_hrs', label: 'Total Hours',       color: 'indigo', icon: <Clock size={20}/> },
      { key: 'completion_rate',    label: 'Completion Rate',   color: 'purple', fmt: 'percent', icon: <Target size={20}/> },
    ],
    columns: () => [
      { key: 'user',              header: 'User',           sortable: true, searchable: true },
      { key: 'activity_type',     header: 'Type',           sortable: true,
        render: (v) => (
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-blue-50 text-blue-700">
            {String(v || '')}
          </span>
        ) },
      { key: 'subject',           header: 'Subject',        sortable: true, searchable: true, minWidth: '180px' },
      { key: 'description',       header: 'Description',    sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
      { key: 'status',            header: 'Status',         sortable: true,
        render: (v) => <StatusBadge status={String(v || '')} /> },
      { key: 'activity_date',     header: 'Date',           sortable: true },
      { key: 'mode',              header: 'Mode',           sortable: true },
      { key: 'duration_minutes',  header: 'Duration',       sortable: true, align: 'center',
        render: (v) => v ? `${v} min` : '—' },
      { key: 'location',          header: 'Location',       sortable: true, hidden: true },
      { key: 'outcome',           header: 'Outcome',        sortable: false, searchable: true,
        render: (v) => <TruncCell v={v} max={100} /> },
      { key: 'next_action',       header: 'Next Action',    sortable: false, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
      { key: 'next_action_date',  header: 'Next Action Date',sortable: true, hidden: true },
      { key: 'contacts_met',      header: 'Contacts Met',   sortable: false, hidden: true },
      { key: 'has_travel',        header: 'Travel',         sortable: true, align: 'center', hidden: true },
      { key: 'travel_from',       header: 'From',           sortable: true, hidden: true },
      { key: 'travel_to',         header: 'To',             sortable: true, hidden: true },
      { key: 'travel_mode',       header: 'Travel Mode',    sortable: true, hidden: true },
      { key: 'cancellation_reason',header: 'Cancel Reason', sortable: false, hidden: true },
      { key: 'created_at',        header: 'Created',        sortable: true, hidden: true },
    ],
  },
  {
    key: 'travel', label: 'Travel', icon: <Globe size={16} />,
    dot: 'bg-sky-500', description: 'Travel requests with visit types, transport modes, estimates and approvals',
    chart1Label: 'Requests by Status', chart2Label: 'By Visit Type',
    filters: [
      { key: 'date_from',    type: 'date',   label: 'Travel From' },
      { key: 'date_to',      type: 'date',   label: 'Travel To' },
      { key: 'status',       type: 'select', label: 'Status',
        options: ['Draft','Submitted','Approved','Rejected','Completed','Cancelled'] },
      { key: 'visit_type',   type: 'select', label: 'Visit Type',
        options: ['Customer Visit','Vendor Visit','Site Survey','Training','Conference','Other'] },
    ],
    summaryConfig: [
      { key: 'total',            label: 'Total Requests', color: 'blue',   icon: <Globe size={20}/> },
      { key: 'approved',         label: 'Approved',       color: 'green',  icon: <CheckCircle2 size={20}/> },
      { key: 'total_estimated',  label: 'Est. Spend',     color: 'indigo', fmt: 'currency', icon: <DollarSign size={20}/> },
      { key: 'total_days',       label: 'Total Days',     color: 'amber',  icon: <Clock size={20}/> },
    ],
    columns: () => [
      { key: 'request_number',  header: 'Request #',      sortable: true, searchable: true, minWidth: '120px' },
      { key: 'employee',        header: 'Employee',       sortable: true, searchable: true },
      { key: 'visit_type',      header: 'Visit Type',     sortable: true },
      { key: 'customer_name',   header: 'Customer',       sortable: true, searchable: true },
      { key: 'from_city',       header: 'From',           sortable: true, searchable: true },
      { key: 'to_city',         header: 'To',             sortable: true, searchable: true },
      { key: 'travel_date',     header: 'Travel Date',    sortable: true },
      { key: 'return_date',     header: 'Return Date',    sortable: true, hidden: true },
      { key: 'total_days',      header: 'Days',           sortable: true, align: 'center' },
      { key: 'transport_mode',  header: 'Mode',           sortable: true },
      { key: 'class_of_travel', header: 'Class',          sortable: true, hidden: true },
      { key: 'status',          header: 'Status',         sortable: true,
        render: (v) => <StatusBadge status={String(v || '')} /> },
      { key: 'estimated_total', header: 'Est. Total',     sortable: true, align: 'right',
        render: (v) => fmtCur(v) },
      { key: 'advance_required',header: 'Advance Req.',   sortable: true, align: 'center', hidden: true },
      { key: 'advance_amount',  header: 'Advance Amt',    sortable: true, align: 'right', hidden: true,
        render: (v) => fmtCur(v) },
      { key: 'approved_by',     header: 'Approved By',    sortable: true, hidden: true },
      { key: 'approved_at',     header: 'Approved At',    sortable: true, hidden: true },
      { key: 'source',          header: 'Source',         sortable: true, hidden: true },
      { key: 'purpose',         header: 'Purpose',        sortable: false, searchable: true, hidden: true,
        render: (v) => <TruncCell v={v} max={80} /> },
    ],
  },
  {
    key: 'oem', label: 'OEM', icon: <Package size={16} />,
    dot: 'bg-indigo-500', description: 'OEM performance across leads and tenders — appearance counts, win rates and product coverage',
    chart1Label: 'Top OEMs by Appearances', chart2Label: 'OEMs in Tenders',
    filters: [], summaryConfig: [], columns: () => [],
  },
  {
    key: 'competitors', label: 'Competitors', icon: <Award size={16} />,
    dot: 'bg-rose-500', description: 'Competitive landscape — threat analysis, tender losses and OEM partnership mapping',
    chart1Label: 'By Threat Level', chart2Label: 'Top by Tender Losses',
    filters: [], summaryConfig: [], columns: () => [],
  },
]

// ─── report tab permission map ────────────────────────────────────────────────
const REPORT_TAB_PERMISSIONS: Record<string, string[]> = {
  leads:         ['reports.leads.view'],
  tenders:       ['reports.tenders.view'],
  customers:     ['reports.customers.view'],
  opportunities: ['reports.opportunities.view'],
  quotations:    ['reports.quotations.view'],
  workorders:    ['reports.workorders.view'],
  emdbg:         ['reports.emdbg.view'],
  kam:           ['reports.kam.view'],
  travel:        ['reports.travel.view'],
  oem:           ['reports.oem.view'],
  competitors:   ['reports.competitors.view'],
}

// ─── default filter params (current calendar month) ──────────────────────────
// Called when the page loads and when switching reports to seed filters
// with the current month so data appears immediately without clicking Run Report.
function defaultParams(reportKey: string): Record<string, string> {
  const now      = new Date()
  const year     = now.getFullYear()
  const month    = String(now.getMonth() + 1).padStart(2, '0')
  const day      = String(now.getDate()).padStart(2, '0')
  const firstDay = `${year}-${month}-01`
  const today    = `${year}-${month}-${day}`
  const period   = `${year}-${month}`

  switch (reportKey) {
    // these reports have date_from / date_to filters
    case 'leads':
    case 'tenders':
    case 'workorders':
    case 'travel':
      return { date_from: firstDay, date_to: today }

    // KAM uses a month picker
    case 'kam':
      return { period }

    // customers — no date filter; emdbg — expiry-driven, not date-range
    default:
      return {}
  }
}

// ─── summary value formatter ──────────────────────────────────────────────────
function fmtSummary(v: unknown, type?: FmtType): string {
  if (type === 'currency') return fmtCur(v)
  if (type === 'percent')  return fmtPct(v)
  return fmtNum(v)
}

// ─── period label ─────────────────────────────────────────────────────────────
function periodLabel(params: Record<string, string>): string | null {
  if (params.date_from) {
    try {
      return new Date(params.date_from + 'T00:00:00').toLocaleString('en-IN', {
        month: 'long', year: 'numeric',
      })
    } catch { return null }
  }
  if (params.period) {
    try {
      return new Date(params.period + '-01T00:00:00').toLocaleString('en-IN', {
        month: 'long', year: 'numeric',
      })
    } catch { return null }
  }
  return null
}

// ─── filter field component ───────────────────────────────────────────────────
function FilterField({ def, value, onChange }: {
  def: FilterDef; value: string; onChange: (v: string) => void
}) {
  const base = 'h-9 w-full px-3 text-[13px] leading-5 font-normal text-gray-900 border border-gray-200 rounded-lg focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all'
  const labelClass = 'block text-[14px] leading-5 font-medium text-gray-700 mb-1.5'
  if (def.type === 'date') {
    return (
      <div>
        <label className={labelClass}>{def.label}</label>
        <input type="date" value={value} onChange={e => onChange(e.target.value)} className={base} />
      </div>
    )
  }
  if (def.type === 'month') {
    return (
      <div>
        <label className={labelClass}>{def.label}</label>
        <input type="month" value={value} onChange={e => onChange(e.target.value)} className={base} />
      </div>
    )
  }
  if (def.type === 'number') {
    return (
      <div>
        <label className={labelClass}>{def.label}</label>
        <input type="number" value={value} onChange={e => onChange(e.target.value)}
          placeholder={def.placeholder} className={base} />
      </div>
    )
  }
  if (def.type === 'text') {
    return (
      <div>
        <label className={labelClass}>{def.label}</label>
        <input type="text" value={value} onChange={e => onChange(e.target.value)}
          placeholder={def.placeholder} className={base} />
      </div>
    )
  }
  // select
  return (
    <div>
      <label className={labelClass}>{def.label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} className={base}>
        <option value="">All</option>
        {def.options?.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}

// ─── custom tooltip ───────────────────────────────────────────────────────────
const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-lg px-4 py-3 text-xs">
      <p className="font-semibold text-gray-800 mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color }} className="font-medium">
          {p.dataKey === 'value' ? fmtCur(p.value) : `${p.value} records`}
        </p>
      ))}
    </div>
  )
}

// ─── insights panel ───────────────────────────────────────────────────────────
interface InsightsData {
  pipeline_health: Record<string, number>
  top_customers_by_value: Record<string, unknown>[]
  top_oems_supply_chain: Record<string, unknown>[]
  customer_product_matrix: Record<string, unknown>[]
  portal_win_analysis: Record<string, unknown>[]
  top_staff_by_wins: Record<string, unknown>[]
}

function InsightsPanel({ data }: { data: InsightsData }) {
  const [tab, setTab] = useState<'customers' | 'oems' | 'matrix' | 'portals' | 'staff'>('customers')
  const h = data.pipeline_health

  const tabs = [
    { key: 'customers', label: 'Top Customers',     icon: <Building2 size={13}/> },
    { key: 'oems',      label: 'OEM Supply Chain',  icon: <Package size={13}/> },
    { key: 'matrix',    label: 'Cust × Product',    icon: <Cpu size={13}/> },
    { key: 'portals',   label: 'Portal Analysis',   icon: <Globe size={13}/> },
    { key: 'staff',     label: 'Staff Performance', icon: <Award size={13}/> },
  ] as const

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: 'Total Leads',        value: fmtNum(h.total_leads) },
          { label: 'Leads Converted',    value: fmtNum(h.leads_converted) },
          { label: 'Lead Conv. Rate',    value: fmtPct(h.lead_conversion_rate) },
          { label: 'Total Tenders',      value: fmtNum(h.total_tenders) },
          { label: 'Tenders Won',        value: fmtNum(h.tenders_won) },
          { label: 'Tender Win Rate',    value: fmtPct(h.tender_win_rate) },
        ].map(s => (
          <div key={s.label} className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-3 border border-blue-100">
            <p className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">{s.label}</p>
            <p className="text-lg font-bold text-blue-900 mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key as typeof tab)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all
              ${tab === t.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'customers' && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100">
                {['Customer', 'Tenders', 'Won', 'Lost', 'Win Rate', 'Total Bid Value', 'Products', 'OEMs'].map(h => (
                  <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.top_customers_by_value.map((r: any, i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                  <td className="py-2 px-2 font-semibold text-gray-800">{r.customer}</td>
                  <td className="py-2 px-2 text-center font-medium">{r.tender_count}</td>
                  <td className="py-2 px-2 text-center text-emerald-600 font-semibold">{r.won}</td>
                  <td className="py-2 px-2 text-center text-red-500 font-semibold">{r.lost}</td>
                  <td className="py-2 px-2 text-center">
                    <span className={`font-bold ${Number(r.win_rate) >= 50 ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {r.win_rate}%
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right font-semibold text-blue-700">{fmtCur(r.total_bid_value)}</td>
                  <td className="py-2 px-2 text-gray-500 max-w-[180px] truncate" title={r.products}>{r.products || '—'}</td>
                  <td className="py-2 px-2 text-gray-500 max-w-[160px] truncate" title={r.oems}>{r.oems || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'oems' && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100">
                {['OEM Name', 'Tender Count', 'Won Count', 'Win Rate', 'Products Supplied', 'Customers Served'].map(h => (
                  <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.top_oems_supply_chain.map((r: any, i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                  <td className="py-2 px-2 font-semibold text-gray-800">{r.oem_name}</td>
                  <td className="py-2 px-2 text-center font-medium">{r.tender_count}</td>
                  <td className="py-2 px-2 text-center text-emerald-600 font-semibold">{r.won_count}</td>
                  <td className="py-2 px-2 text-center">
                    <span className={`font-bold ${Number(r.win_rate) >= 50 ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {r.win_rate}%
                    </span>
                  </td>
                  <td className="py-2 px-2 text-gray-500 max-w-[200px] truncate" title={r.products_supplied}>{r.products_supplied || '—'}</td>
                  <td className="py-2 px-2 text-gray-500 max-w-[180px] truncate" title={r.customers_served}>{r.customers_served || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'matrix' && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100">
                {['Customer', 'Top Products', 'Unique Products', 'Total Occurrences'].map(h => (
                  <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.customer_product_matrix.map((r: any, i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                  <td className="py-2 px-2 font-semibold text-gray-800 whitespace-nowrap">{r.customer}</td>
                  <td className="py-2 px-2 text-gray-600 max-w-[280px]" title={r.top_products}>
                    <div className="flex flex-wrap gap-1">
                      {String(r.top_products || '').split(', ').filter(Boolean).map((p: string) => (
                        <span key={p} className="inline-flex items-center px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-medium">{p}</span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 px-2 text-center font-medium text-purple-700">{r.product_count}</td>
                  <td className="py-2 px-2 text-center font-medium">{r.total_occurrences}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'portals' && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100">
                {['Portal', 'Total Tenders', 'Won', 'Lost', 'Win Rate', 'Total Value'].map(h => (
                  <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.portal_win_analysis.map((r: any, i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                  <td className="py-2 px-2">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-indigo-50 text-indigo-700">
                      {r.portal}
                    </span>
                  </td>
                  <td className="py-2 px-2 text-center font-medium">{r.total}</td>
                  <td className="py-2 px-2 text-center text-emerald-600 font-semibold">{r.won}</td>
                  <td className="py-2 px-2 text-center text-red-500 font-semibold">{r.lost}</td>
                  <td className="py-2 px-2 text-center">
                    <span className={`font-bold ${Number(r.win_rate) >= 50 ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {r.win_rate}%
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right font-semibold text-blue-700">{fmtCur(r.total_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'staff' && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100">
                {['Name', 'Leads', 'Tenders', 'Won', 'Win Rate', 'Won Value'].map(h => (
                  <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.top_staff_by_wins.map((r: any, i) => (
                <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                  <td className="py-2 px-2 font-semibold text-gray-800">{r.name}</td>
                  <td className="py-2 px-2 text-center font-medium text-blue-600">{r.leads}</td>
                  <td className="py-2 px-2 text-center font-medium">{r.tenders}</td>
                  <td className="py-2 px-2 text-center text-emerald-600 font-semibold">{r.won}</td>
                  <td className="py-2 px-2 text-center">
                    <span className={`font-bold ${Number(r.win_rate) >= 50 ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {r.win_rate}%
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right font-semibold text-blue-700">{fmtCur(r.won_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── sortable report tab ─────────────────────────────────────────────────────
function SortableReportTab({
  report, active, count, onClick,
}: {
  report: ReportDef; active: boolean; count: number; onClick: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: report.key })

  return (
    <button
      ref={setNodeRef}
      onClick={onClick}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        background: active
          ? 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-accent) 100%)'
          : 'color-mix(in srgb, var(--color-accent) 6%, white)',
        borderColor: active
          ? 'color-mix(in srgb, var(--color-accent) 44%, var(--color-primary))'
          : 'color-mix(in srgb, var(--color-accent) 18%, white)',
        color: active
          ? '#ffffff'
          : 'color-mix(in srgb, var(--color-primary) 68%, #64748b)',
        boxShadow: active
          ? '0 12px 28px color-mix(in srgb, var(--color-primary) 24%, transparent)'
          : undefined,
      }}
      className={[
        'group relative flex items-center gap-1.5 px-3 py-2 rounded-2xl',
        'text-[13px] font-semibold whitespace-nowrap flex-shrink-0',
        'transition-all duration-200 border',
        active ? 'shadow-lg' : 'hover:bg-white',
        isDragging ? 'opacity-70 scale-105 shadow-xl z-50 cursor-grabbing' : 'cursor-pointer',
      ].join(' ')}
    >
      <span
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        className={[
          'flex items-center justify-center rounded-lg cursor-grab active:cursor-grabbing',
          active
            ? 'text-white/70'
            : 'text-[color-mix(in_srgb,var(--color-primary)_42%,#94a3b8)] group-hover:text-[var(--color-primary)]',
        ].join(' ')}
      >
        <GripVertical size={14} />
      </span>
      <span
        className={[
          'flex h-6 w-6 items-center justify-center rounded-lg flex-shrink-0',
          active
            ? 'bg-white/15 text-white'
            : 'bg-[color-mix(in_srgb,var(--color-accent)_10%,white)] text-[var(--color-primary)]',
        ].join(' ')}
      >
        {report.icon}
      </span>
      <span>{report.label}</span>
      {count > 0 && (
        <span className={`ml-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${active ? 'bg-white/20 text-white' : 'bg-[color-mix(in_srgb,var(--color-primary)_12%,white)] text-[var(--color-primary)]'}`}>
          {count}
        </span>
      )}
    </button>
  )
}

// ─── main page ────────────────────────────────────────────────────────────────
interface ReportResult {
  summary: Record<string, unknown>
  chart_data: Array<{ label: string; count: number; value?: number }>
  chart_data2: Array<{ label: string; count: number; value?: number }>
  data: Record<string, unknown>[]
}

const DEDICATED_REPORT_KEYS = new Set([
  'leads', 'tenders', 'customers', 'opportunities', 'quotations',
  'workorders', 'emdbg', 'kam', 'travel', 'oem', 'competitors',
])

export default function ReportsPage() {
  const { can, canAny }                = usePermissions()
  const { label: tenderLabel }         = useModuleName('tenders')
  const { label: oppLabel }            = useModuleName('opportunities')
  const { label: quotationLabel }      = useModuleName('quotations')
  const { label: woLabel }             = useModuleName('workorders')
  const { label: emdbgLabel }          = useModuleName('emdbg')
  const { label: travelLabel }         = useModuleName('travel')
  const { label: rfpLabel }            = useModuleName('rfp')
  const { label: leadsLabel }          = useModuleName('leads')
  const { label: customersLabel }      = useModuleName('customers')
  const { label: oemLabel }            = useModuleName('oems')
  const { label: competitorsLabel }    = useModuleName('competitors')
  const { label: kamLabel }            = useModuleName('kam')
  const DYNAMIC_REPORTS                = useMemo(
    () => REPORTS.map(r => {
      if (r.key === 'tenders')       return { ...r, label: tenderLabel }
      if (r.key === 'opportunities') return { ...r, label: oppLabel }
      if (r.key === 'quotations')    return { ...r, label: quotationLabel }
      if (r.key === 'workorders')    return { ...r, label: woLabel }
      if (r.key === 'emdbg')         return { ...r, label: emdbgLabel }
      if (r.key === 'travel')        return { ...r, label: travelLabel }
      if (r.key === 'rfp')           return { ...r, label: rfpLabel }
      if (r.key === 'leads')         return { ...r, label: leadsLabel }
      if (r.key === 'customers')     return { ...r, label: customersLabel }
      if (r.key === 'oem')           return { ...r, label: oemLabel }
      if (r.key === 'competitors')   return { ...r, label: competitorsLabel }
      if (r.key === 'kam')           return { ...r, label: kamLabel }
      return r
    }),
    [tenderLabel, oppLabel, quotationLabel, woLabel, emdbgLabel, travelLabel, rfpLabel,
     leadsLabel, customersLabel, oemLabel, competitorsLabel, kamLabel],
  )
  const [toolbar, setToolbarRaw]       = useState<ReactNode>(null)
  const setToolbar                     = useCallback((el: ReactNode) => setToolbarRaw(el), [])
  const [reportDateRange, setReportDateRangeState] = useState<Record<string, string>>({
    preset: '',
    date_from: '',
    date_to: '',
  })
  const [tabOrder, setTabOrder]        = useState<string[]>([
    'customers', 'leads', 'opportunities', 'tenders', 'quotations', 'workorders', 'emdbg', 'kam', 'travel', 'oem', 'competitors',
  ])
  const hasAllReportsAccess            = can('reports.view')
  const visibleReports                 = useMemo(
    () => tabOrder
      .map(key => DYNAMIC_REPORTS.find(r => r.key === key))
      .filter((r): r is ReportDef => !!r && (hasAllReportsAccess || canAny(REPORT_TAB_PERMISSIONS[r.key] || []))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canAny, hasAllReportsAccess, tabOrder, DYNAMIC_REPORTS],
  )
  const [activeKey, setActiveKey]     = useState(() => visibleReports.find(r => r.key === 'customers')?.key ?? visibleReports[0]?.key ?? 'customers')
  // Seed params with current-month defaults for the initial report
  const [params,    setParams]        = useState<Record<string, string>>(() => defaultParams(visibleReports[0]?.key ?? 'customers'))
  const [showGenericFilters, setShowGenericFilters] = useState(true)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setTabOrder(prev => {
      const oldIndex = prev.indexOf(String(active.id))
      const newIndex = prev.indexOf(String(over.id))
      return arrayMove(prev, oldIndex, newIndex)
    })
  }
  const [result,    setResult]        = useState<ReportResult | null>(null)
  const [loading,   setLoading]       = useState(false)
  const [exporting, setExporting]     = useState(false)
  const [switching, setSwitching]     = useState(false)
  // const [showInsights, setShowInsights] = useState(false)
  // const [insights,  setInsights]      = useState<InsightsData | null>(null)
  // const [insLoading, setInsLoading]   = useState(false)
  const { success, error: showErr }   = useToast()

  // If the active tab is no longer visible (permissions changed), fall back to first visible
  useEffect(() => {
    if (visibleReports.length && !visibleReports.some(r => r.key === activeKey)) {
      setActiveKey(visibleReports[0].key)
    }
  }, [activeKey, visibleReports])

  const report  = visibleReports.find(r => r.key === activeKey) ?? visibleReports[0]
  const columns = report?.columns() ?? []

  const setP = (k: string, v: string) => setParams(p => ({ ...p, [k]: v }))

  const buildQS = (overrideParams?: Record<string, string>) => {
    const p = overrideParams ?? params
    return Object.entries(p).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  }

  const runReport = async (overrideKey?: string, overrideParams?: Record<string, string>) => {
    setLoading(true)
    try {
      const key = overrideKey ?? activeKey
      const qs  = buildQS(overrideParams)
      const r   = await api.get(`/reports/${key}${qs ? '?' + qs : ''}`)
      setResult(r.data)
    } catch {
      showErr('Failed to load report')
    } finally {
      setLoading(false)
      setSwitching(false)
    }
  }

  // Auto-run only for generic reports; dedicated tabs manage their own data lifecycle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (DEDICATED_REPORT_KEYS.has(activeKey)) {
      setResult(null)
      setLoading(false)
      setSwitching(false)
      return
    }
    runReport(activeKey, defaultParams(activeKey))
  }, [activeKey])

  // const loadInsights = async () => {
  //   if (insights) { setShowInsights(v => !v); return }
  //   setInsLoading(true)
  //   try {
  //     const r = await api.get('/reports/insights')
  //     setInsights(r.data)
  //     setShowInsights(true)
  //   } catch {
  //     showErr('Failed to load insights')
  //   } finally {
  //     setInsLoading(false)
  //   }
  // }

  const doExport = async (fmt: 'csv' | 'excel') => {
    setExporting(true)
    try {
      const qs  = buildQS()
      const sep = qs ? '&' : '?'
      const r   = await api.get(`/reports/${activeKey}?${qs}${sep}export=${fmt}`, { responseType: 'blob' })
      const url = URL.createObjectURL(new Blob([r.data]))
      const a   = document.createElement('a')
      a.href     = url
      a.download = `${activeKey}_report.${fmt === 'excel' ? 'xlsx' : 'csv'}`
      a.click()
      URL.revokeObjectURL(url)
      success(`${fmt.toUpperCase()} downloaded`)
    } catch {
      showErr('Export failed')
    } finally {
      setExporting(false)
    }
  }

  const switchReport = (key: string) => {
    if (key === activeKey || switching) return
    const defaults = defaultParams(key)
    setSwitching(true)
    window.setTimeout(() => {
      setActiveKey(key)
      setResult(null)
      setParams(defaults)
      setShowGenericFilters(true)
      // useEffect on activeKey will auto-run the report with defaults
    }, 120)
  }

  const summary   = result?.summary    || {}
  const chart1    = result?.chart_data  || []
  const chart2    = result?.chart_data2 || []
  const tableData = result?.data        || []
  const setReportDateRange = useCallback((patch: Partial<Record<'preset' | 'date_from' | 'date_to', string>>) => {
    setReportDateRangeState(prev => ({ ...prev, ...patch }))
  }, [])
  const reportDateRangeContextValue = useMemo(() => ({
    preset: reportDateRange.preset ?? '',
    date_from: reportDateRange.date_from ?? '',
    date_to: reportDateRange.date_to ?? '',
    params: {
      preset: reportDateRange.preset ?? '',
      date_from: reportDateRange.date_from ?? '',
      date_to: reportDateRange.date_to ?? '',
    },
    setPreset: (value: string) => setReportDateRange({ preset: value }),
    setDateFrom: (value: string) => setReportDateRange({ date_from: value }),
    setDateTo: (value: string) => setReportDateRange({ date_to: value }),
    setDateRange: setReportDateRange,
  }), [reportDateRange.date_from, reportDateRange.date_to, reportDateRange.preset, setReportDateRange])

  const valueData = [...chart1]
    .sort((a, b) => (b.value || 0) - (a.value || 0))
    .slice(0, 8)

  // Current period label for the badge
  const currentPeriodLabel = periodLabel(params)

  if (!report) return null

  const inlineFilters = report.filters.filter(f => f.key !== 'date_from' && f.key !== 'date_to')

  return (
    <ReportDateRangeCtx.Provider value={reportDateRangeContextValue}>
    <div className="p-6">
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold leading-tight text-slate-950">{report.label} Report</h1>
          <p className="mt-2 text-sm text-slate-500">{report.description || 'Generate, filter and export analytics across all CRM modules'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <ReportDateRangeToolbar
            preset={reportDateRange.preset ?? ''}
            dateFrom={reportDateRange.date_from ?? ''}
            dateTo={reportDateRange.date_to ?? ''}
            onPresetChange={value => setReportDateRange({ preset: value })}
            onDateFromChange={value => setReportDateRange({ date_from: value })}
            onDateToChange={value => setReportDateRange({ date_to: value })}
          />
          {DEDICATED_REPORT_KEYS.has(activeKey)
            ? toolbar
            : <button onClick={() => runReport()} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>}
        </div>
      </div>

      <div className="space-y-3">

        {/* ── tab bar ──────────────────────────────────────────── */}
        <div className="sticky top-0 z-20 -mx-6 border-b border-white/70 bg-[#f8fafc]/80 px-6 pt-1 pb-1 backdrop-blur-xl">
          {/* toolbar row — registered by the active report view */}
          <div className="rounded-xl border border-slate-200 bg-white/90 p-2 shadow-sm">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={visibleReports.map(r => r.key)} strategy={horizontalListSortingStrategy}>
                <div className="flex flex-wrap gap-2">
                  {visibleReports.map(r => (
                    <SortableReportTab
                      key={r.key}
                      report={r}
                      active={activeKey === r.key}
                      count={activeKey === r.key && result ? tableData.length : 0}
                      onClick={() => switchReport(r.key)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        </div>

        {/* ── main content ─────────────────────────────────────────── */}
        <ReportToolbarCtx.Provider value={setToolbar}>
        <div className={`space-y-5 transition-all duration-300 ease-out ${switching ? 'opacity-0 translate-y-1' : 'opacity-100 translate-y-0'}`}>

          {/* Leads report — analytics view */}
          {activeKey === 'leads' && (
            <Suspense fallback={<div className="flex items-center justify-center py-20"><RefreshCw size={24} className="animate-spin text-blue-400" /></div>}>
              <LeadsReportView />
            </Suspense>
          )}

          {/* Tenders report — analytics view */}
          {activeKey === 'tenders' && (
            <Suspense fallback={<div className="flex items-center justify-center py-20"><RefreshCw size={24} className="animate-spin text-purple-400" /></div>}>
              <TendersReportView />
            </Suspense>
          )}

          {/* Customers report — analytics view */}
          {activeKey === 'customers' && (
            <Suspense fallback={<div className="flex items-center justify-center py-20"><RefreshCw size={24} className="animate-spin text-emerald-400" /></div>}>
              <CustomersReportView />
            </Suspense>
          )}

          {activeKey === 'opportunities' && (
            <Suspense fallback={<div className="flex items-center justify-center py-20"><RefreshCw size={24} className="animate-spin text-sky-400" /></div>}>
              <OpportunitiesReportView />
            </Suspense>
          )}

          {activeKey === 'quotations' && (
            <Suspense fallback={<div className="flex items-center justify-center py-20"><RefreshCw size={24} className="animate-spin text-violet-400" /></div>}>
              <QuotationsReportView />
            </Suspense>
          )}

          {/* Work orders report — full redesign */}
          {activeKey === 'workorders' && (
            <Suspense fallback={<div className="flex items-center justify-center py-20"><RefreshCw size={24} className="animate-spin text-orange-400" /></div>}>
              <WorkordersReportView />
            </Suspense>
          )}

          {/* EMD / BG report — analytics view */}
          {activeKey === 'emdbg' && (
            <Suspense fallback={<div className="flex items-center justify-center py-20"><RefreshCw size={24} className="animate-spin text-teal-400" /></div>}>
              <EMDBGReportView />
            </Suspense>
          )}

          {activeKey === 'oem' && (
            <Suspense fallback={<div className="flex items-center justify-center py-20"><RefreshCw size={24} className="animate-spin text-blue-400" /></div>}>
              <OEMReportView />
            </Suspense>
          )}

          {activeKey === 'competitors' && (
            <Suspense fallback={<div className="flex items-center justify-center py-20"><RefreshCw size={24} className="animate-spin text-orange-400" /></div>}>
              <CompetitorsReportView />
            </Suspense>
          )}

          {activeKey === 'kam' && (
            <Suspense fallback={<div className="flex items-center justify-center py-20"><RefreshCw size={24} className="animate-spin text-teal-400" /></div>}>
              <KAMReportView />
            </Suspense>
          )}

          {activeKey === 'travel' && (
            <Suspense fallback={<div className="flex items-center justify-center py-20"><RefreshCw size={24} className="animate-spin text-sky-400" /></div>}>
              <TravelReportView />
            </Suspense>
          )}


          {/* other reports — generic renderer */}
          {!DEDICATED_REPORT_KEYS.has(activeKey) && (<>
          <Card>
            <div className="p-5">
              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  {/* Report title + current period badge */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-bold text-gray-800">{report.label} Report</h3>
                    {currentPeriodLabel && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-600 border border-blue-200">
                        📅 {currentPeriodLabel}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">{report.description}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                  <Button size="sm" variant="secondary" icon={<Download size={13}/>}
                    onClick={() => doExport('csv')} loading={exporting}>
                    CSV
                  </Button>
                  <Button size="sm" variant="secondary" icon={<Download size={13}/>}
                    onClick={() => doExport('excel')} loading={exporting}>
                    Excel
                  </Button>
                  {inlineFilters.length > 0 && (
                    <Button size="sm" variant="secondary" icon={<Filter size={13}/>}
                      onClick={() => setShowGenericFilters(v => !v)}>
                      Filters
                    </Button>
                  )}
                  <Button size="sm" onClick={() => runReport()} loading={loading}>
                    Run Report
                  </Button>
                </div>
              </div>

              {showGenericFilters && inlineFilters.length > 0 && (
                <div className={`grid gap-4 ${
                  report.key === 'leads'
                    ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-5'
                    : inlineFilters.length <= 2
                      ? 'grid-cols-1 sm:grid-cols-2'
                      : 'grid-cols-2 sm:grid-cols-4'
                }`}>
                  {inlineFilters.map(f => (
                    <FilterField key={f.key} def={f} value={params[f.key] || ''}
                      onChange={v => setP(f.key, v)} />
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* results */}
          {result && (
            <>
              {/* summary cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {report.summaryConfig.map(cfg => (
                  <StatCard
                    key={cfg.key}
                    title={cfg.label}
                    value={fmtSummary(summary[cfg.key], cfg.fmt)}
                    color={cfg.color}
                    icon={cfg.icon}
                  />
                ))}
              </div>

              {/* charts row */}
              {(chart1.length > 0 || chart2.length > 0) && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  {chart1.length > 0 && (
                    <Card>
                      <div className="p-4">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
                          {report.chart1Label}
                        </p>
                        <ResponsiveContainer width="100%" height={200}>
                          <BarChart data={chart1} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
                            <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9ca3af' }}
                              axisLine={false} tickLine={false} />
                            <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                            <Tooltip content={<ChartTooltip />} />
                            <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={48}>
                              {chart1.map((_, i) => (
                                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>
                  )}

                  {chart1.length > 0 && (
                    <Card>
                      <div className="p-4">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
                          Breakdown
                        </p>
                        <ResponsiveContainer width="100%" height={200}>
                          <PieChart>
                            <Pie
                              data={chart1}
                              dataKey="count"
                              nameKey="label"
                              cx="50%" cy="50%"
                              innerRadius={50}
                              outerRadius={80}
                              paddingAngle={3}
                            >
                              {chart1.map((_, i) => (
                                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="none" />
                              ))}
                            </Pie>
                            <Tooltip content={<ChartTooltip />} />
                            <Legend
                              iconType="circle" iconSize={8}
                              formatter={(v) => <span className="text-xs text-gray-600">{v}</span>}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>
                  )}

                  {chart2.length > 0 && (
                    <Card>
                      <div className="p-4">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
                          {report.chart2Label}
                        </p>
                        <ResponsiveContainer width="100%" height={200}>
                          <BarChart data={chart2} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
                            <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9ca3af' }}
                              axisLine={false} tickLine={false} />
                            <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                            <Tooltip content={<ChartTooltip />} />
                            <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={48}>
                              {chart2.map((_, i) => (
                                <Cell key={i} fill={PIE_COLORS[(i + 3) % PIE_COLORS.length]} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>
                  )}
                </div>
              )}

              {/* value distribution line chart */}
              {valueData.some(d => (d.value || 0) > 0) && (
                <Card>
                  <div className="p-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
                      Value Distribution by {report.chart1Label.split(' by ')[1] || 'Category'}
                    </p>
                    <ResponsiveContainer width="100%" height={160}>
                      <LineChart data={valueData} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#9ca3af' }}
                          axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false}
                          tickFormatter={(v) => v >= 1e5 ? `₹${(v/1e5).toFixed(0)}L` : `₹${v}`} />
                        <Tooltip content={<ChartTooltip />} />
                        <Line type="monotone" dataKey="value" stroke="#3B82F6" strokeWidth={2.5}
                          dot={{ r: 4, fill: '#3B82F6' }} activeDot={{ r: 6 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
              )}

              {/* data table */}
              <DataTable
                title={`${report.label} Records`}
                subtitle={`${tableData.length} record${tableData.length !== 1 ? 's' : ''} matched your filters`}
                columns={columns}
                data={tableData}
                loading={loading}
                exportFilename={`${activeKey}_report`}
                showSearch
                showExport
                showColumnToggle
                striped
                emptyMessage="No records match the selected filters"
                emptyIcon={<BarChart2 size={36} />}
              />
            </>
          )}

          {/* empty state — only shown before first auto-run completes */}
          {!result && !loading &&  (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-20 h-20 rounded-3xl bg-gray-100 flex items-center justify-center mb-5">
                <BarChart2 size={36} className="text-gray-300" />
              </div>
              <h3 className="text-base font-semibold text-gray-700 mb-1">Loading report…</h3>
              <p className="text-sm text-gray-400 max-w-xs mb-4">
                Fetching current month data. You can also adjust the filters and click{' '}
                <strong>Run Report</strong>.
              </p>
              {/* <button onClick={loadInsights}
                className="flex items-center gap-2 px-4 py-2 bg-purple-50 text-purple-700 rounded-xl text-sm font-medium hover:bg-purple-100 transition-all border border-purple-200">
                <Brain size={15} />
                View AI Cross-Module Insights
              </button> */}
            </div>
          )}

          {/* loading skeleton */}
          {loading && !result && (
            <div className="space-y-4 animate-pulse">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-28 rounded-2xl bg-gray-100" />
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="h-56 rounded-2xl bg-gray-100" />
                ))}
              </div>
              <div className="h-64 rounded-2xl bg-gray-100" />
            </div>
          )}
          </>)}
        </div>
        </ReportToolbarCtx.Provider>
      </div>
    </div>
    </ReportDateRangeCtx.Provider>
  )
}
