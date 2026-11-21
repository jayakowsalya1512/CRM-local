/**
 * ApprovalsPage.tsx — v4 (horizontal grid redesign)
 *
 * LAYOUT CHANGES from v3:
 * - InfoRow → Field: compact 2-column grid cells, no separator rows
 * - SectionBlock: always-open flat card (no accordion toggle), header stays
 * - All panels use grid-cols-2 inside sections; long fields use col-span-2
 * - Hero banners → slim single-line stat strips
 * - DecisionModal body → two-column split (primary left, secondary right)
 * - Products/Contacts → horizontal chip cards in grid-cols-2
 * - Approval/Reject logic: UNCHANGED
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  CheckCircle, XCircle, Clock, FileText, ChevronRight,
  X, Eye, ExternalLink, Loader2, Search,
  FileSpreadsheet, File, Image as ImageIcon, Package,
  DollarSign, User, Layers,
  RefreshCw, Plane, Receipt, MapPin, IndianRupee,
  AlertCircle, Building2, Tag, Users,
  Phone, Mail, CreditCard, TrendingUp,
  ArrowRight, FileCheck,
  Home, Navigation, Contact, Award,
  ChevronDown, ChevronUp,
} from 'lucide-react'
import api, { approvalWorkflowApi, withPassiveSessionActivity } from '@/services/api'
import Button from '@/components/ui/Button'
import { useToast, PageHeader } from '@/components/ui/FormComponents'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { useAuthStore, useUIStore } from '@/store'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApprovalItem {
  id: number
  kind?: 'legacy' | 'dynamic'
  module: string
  action: string
  action_label?: string
  type_label?: string
  record_id: number
  record_ref: string
  status: 'pending' | 'approved' | 'rejected'
  requested_by: number
  requested_by_name: string
  requested_to?: number | null
  requested_to_name?: string | null
  request_notes: string | null
  decision_notes: string | null
  rejection_reason: string | null
  decided_at: string | null
  created_at: string
  approval_display?: string
  approval_progress_current?: number
  approval_progress_total?: number
  current_step_no?: number
  steps?: ApprovalStep[]
  summary?: any
}

interface ApprovalStep {
  id: number
  step_no: number
  approver_user_id?: number | null
  approver_name?: string | null
  approver_role?: string | null
  status: 'pending' | 'approved' | 'rejected' | 'escalated' | string
  remarks?: string | null
  assigned_at?: string | null
  acted_at?: string | null
  escalated_at?: string | null
  escalation_count?: number
  resolved_from?: string | null
}

interface TenderTimelineItem {
  id: string
  sequence?: number
  title: string
  occurred_at?: string | null
  detail?: string | null
  user_name?: string | null
  status?: 'completed' | 'missing' | 'pending' | string
  status_label?: string | null
  missing_field?: string | null
  approval_details?: ApprovalStep[]
  sub_items?: TenderTimelineSubItem[]
}

interface TenderTimelineSubItem {
  title: string
  occurred_at?: string | null
  submitted_at?: string | null
  recorded_at?: string | null
  detail?: string | null
  status?: 'completed' | 'missing' | 'pending' | 'not_required' | string
  status_label?: string | null
  missing_field?: string | null
}

interface DocumentInfo {
  id: number
  doc_type: string
  file_name: string
  file_path: string
  preview_url: string
  file_url?: string
  file_size_kb?: number
  uploaded_at: string | null
}

function getApprovalErrorMessage(error: any): string {
  const detail = error?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  const apiError = error?.response?.data?.error
  if (typeof apiError === 'string' && apiError.trim()) return apiError
  return error?.message || 'Failed to decide approval'
}

function formatHeaderStamp(value?: string | null) {
  if (!value) return ''
  const stamp = new Date(value)
  if (Number.isNaN(stamp.getTime())) return ''
  return stamp.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })
}

function approvalStepActor(step: ApprovalStep) {
  return (
    step.approver_name ||
    step.approver_role ||
    (step.approver_user_id ? `User #${step.approver_user_id}` : 'approver')
  )
}

function approvalVerb(status?: string | null) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'approved') return 'Approved by'
  if (normalized === 'rejected') return 'Rejected by'
  if (normalized === 'escalated') return 'Escalated from'
  if (normalized === 'pending') return 'Pending with'
  return 'Handled by'
}

function approvalDetailStamp(status?: string | null, values?: {
  acted_at?: string | null
  assigned_at?: string | null
  escalated_at?: string | null
}) {
  const normalized = String(status || '').toLowerCase()
  const value =
    normalized === 'pending'
      ? values?.assigned_at
      : values?.acted_at || values?.escalated_at || values?.assigned_at
  return formatHeaderStamp(value)
}

function buildStepApprovalDetails(steps?: ApprovalStep[]) {
  if (!steps?.length) return []

  return [...steps]
    .sort((a, b) => Number(a.step_no || 0) - Number(b.step_no || 0))
    .map((step) => {
      const status = String(step.status || '').toLowerCase()
      const stamp = approvalDetailStamp(status, step)
      const actor = approvalStepActor(step)
      return {
        key: String(step.id ?? `${step.step_no}-${status}-${actor}`),
        status,
        text: `${approvalVerb(status)} ${actor}${stamp ? ` at ${stamp}` : ''}`,
      }
    })
    .filter(item => item.text.trim())
}

function buildApprovalDetails(approval?: ApprovalItem | null) {
  if (!approval) return []
  if (approval.steps?.length) return buildStepApprovalDetails(approval.steps)

  const status = String(approval.status || '').toLowerCase()
  const stamp = approvalDetailStamp(status, {
    acted_at: approval.decided_at,
    assigned_at: approval.created_at,
  })
  const actor = approval.requested_to_name || 'approver'

  return [{
    key: `${approval.id}-${status}`,
    status,
    text: `${approvalVerb(status)} ${actor}${stamp ? ` at ${stamp}` : ''}`,
  }]
}

function approvalDetailClass(status: string, light: boolean) {
  if (light) return 'border-white/20 bg-white/10 text-white/90'
  if (status === 'approved') return 'border-emerald-200 bg-emerald-50 text-emerald-800'
  if (status === 'rejected') return 'border-red-200 bg-red-50 text-red-800'
  if (status === 'escalated') return 'border-amber-200 bg-amber-50 text-amber-800'
  if (status === 'pending') return 'border-sky-200 bg-sky-50 text-sky-800'
  return 'border-gray-200 bg-gray-50 text-gray-700'
}

function approvalDetailIcon(status: string, light: boolean) {
  const className = light ? 'text-white/80' : undefined
  if (status === 'approved') return <CheckCircle size={12} className={className || 'text-emerald-600'} />
  if (status === 'rejected') return <XCircle size={12} className={className || 'text-red-600'} />
  if (status === 'escalated') return <ArrowRight size={12} className={className || 'text-amber-600'} />
  return <Clock size={12} className={className || 'text-sky-600'} />
}

function approvalDecisionDetailsText(approval?: ApprovalItem | null) {
  return buildApprovalDetails(approval).map(item => item.text).join(' ')
}

function ApprovalDecisionDetails({
  approval,
  rows,
  light = false,
  compact = false,
  maxItems,
}: {
  approval?: ApprovalItem | null
  rows?: ApprovalStep[]
  light?: boolean
  compact?: boolean
  maxItems?: number
}) {
  const details = rows ? buildStepApprovalDetails(rows) : buildApprovalDetails(approval)
  if (!details.length) return null

  const visible = maxItems ? details.slice(0, maxItems) : details
  const hiddenCount = Math.max(0, details.length - visible.length)

  return (
    <div className={`flex min-w-0 flex-wrap items-center ${compact ? 'gap-1.5' : 'gap-2'}`}>
      {visible.map((detail) => (
        <span
          key={detail.key}
          className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border font-bold leading-snug ${
            compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs'
          } ${approvalDetailClass(detail.status, light)}`}
        >
          <span className="shrink-0">{approvalDetailIcon(detail.status, light)}</span>
          <span className="min-w-0 break-words">{detail.text}</span>
        </span>
      ))}
      {hiddenCount > 0 && (
        <span
          className={`inline-flex items-center rounded-lg border font-bold ${
            compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs'
          } ${light ? 'border-white/15 bg-white/5 text-white/75' : 'border-gray-200 bg-gray-50 text-gray-500'}`}
        >
          +{hiddenCount} more
        </span>
      )}
    </div>
  )
}

function TenderTimeline({
  items,
  approval,
}: {
  items?: TenderTimelineItem[]
  approval?: ApprovalItem
}) {
  const [expanded, setExpanded] = useState(false)

  if (!items?.length) return null

  const sortedItems = [...items].sort(
    (a, b) => Number(a.sequence || 0) - Number(b.sequence || 0),
  )
  const completedCount = sortedItems.filter(
    item => String(item.status || '').toLowerCase() !== 'missing',
  ).length

  const formatStamp = (value?: string | null) => {
    if (!value) return null

    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split('-').map(Number)
      const date = new Date(year, month - 1, day)

      return date
        .toLocaleDateString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
        .replace(/ /g, '-')
    }

    const stamp = new Date(value)
    if (Number.isNaN(stamp.getTime())) return null

    const date = stamp
      .toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
      .replace(/ /g, '-')

    const time = stamp.toLocaleTimeString('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    })

    return `${date}, ${time}`
  }

  const splitStamp = (value?: string | null) => {
    const formatted = formatStamp(value)
    if (!formatted) {
      return {
        date: 'Date missing',
        time: 'Not stored',
        full: null,
      }
    }

    const [date, ...timeParts] = formatted.split(', ')

    return {
      date: date || formatted,
      time: timeParts.join(', '),
      full: formatted,
    }
  }

  const getItemMeta = (item: TenderTimelineItem) => {
    const status = String(item.status || '').toLowerCase()

    if (status === 'missing') {
      return {
        icon: <AlertCircle size={18} />,
        nodeClass: 'border-amber-200 bg-amber-50 text-amber-600 shadow-amber-100',
        connectorClass: 'bg-amber-200',
        titleClass: 'text-amber-900',
        statusLabel: item.status_label || 'Missing',
      }
    }

    if (status === 'pending') {
      return {
        icon: <Clock size={18} />,
        nodeClass: 'border-sky-200 bg-sky-50 text-sky-600 shadow-sky-100',
        connectorClass: 'bg-sky-200',
        titleClass: 'text-gray-900',
        statusLabel: item.status_label || 'Pending',
      }
    }

    return {
      icon: <CheckCircle size={18} />,
      nodeClass: 'border-emerald-200 bg-emerald-50 text-emerald-600 shadow-emerald-100',
      connectorClass: 'bg-emerald-300',
      titleClass: 'text-gray-900',
      statusLabel: item.status_label || 'Completed',
    }
  }

  const getSubItemStatusClass = (status?: string) => {
    const normalized = String(status || '').toLowerCase()
    if (normalized === 'missing') return 'border-amber-200 bg-amber-50 text-amber-700'
    if (normalized === 'not_required') return 'border-gray-200 bg-gray-100 text-gray-600'
    if (normalized === 'pending') return 'border-sky-200 bg-sky-50 text-sky-700'
    return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  }

  const getUsefulDetail = (detail?: string | null, statusLabel?: string | null) => {
    const value = String(detail || '').trim()
    if (!value) return ''

    const normalized = value.toLowerCase()
    if (
      normalized === 'completed' ||
      normalized === String(statusLabel || '').toLowerCase()
    ) {
      return ''
    }

    return value
  }

  const getApprovalTargetItemId = () => {
    const action = String(approval?.action || '')
    const targetByAction: Record<string, string> = {
      convert: 'lead-converted',
      convert_lead_manager: 'lead-converted',
      tender_step1_manager: 'tender-step-1',
      tender_step1_ceo: 'tender-step-1',
      tender_step2_manager: 'tender-step-2',
      tender_step2_ceo: 'tender-step-2',
      tender_step3_manager: 'tender-step-3',
      tender_step3_ceo: 'tender-step-3',
      tender_po_manager: 'tender-step-6',
      tender_details: 'tender-step-2',
      workings: 'tender-step-3',
      po_details: 'tender-step-6',
    }

    return targetByAction[action] || ''
  }

  const getApprovalRows = (item: TenderTimelineItem) => {
    if (item.approval_details?.length) return item.approval_details
    if (!approval?.steps?.length) return []
    const targetItemId = getApprovalTargetItemId()
    if (!targetItemId || item.id !== targetItemId) return []
    return approval.steps
  }

  const getActorLabel = (item: TenderTimelineItem, usefulDetail: string) => {
    const detail = usefulDetail.toLowerCase()
    const title = String(item.title || '').toLowerCase()

    if (detail.includes('approved') || title.includes('converted')) {
      return 'Approved by'
    }

    if (detail.includes('submitted')) {
      return 'Submitted by'
    }

    return 'Updated by'
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded(current => !current)}
        aria-expanded={expanded}
        className="flex w-full flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4 text-left transition-colors hover:bg-gray-50"
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
            <FileCheck size={17} />
          </div>

          <div className="min-w-0">
            <h3 className="text-base font-black text-gray-950">
              Tender Timeline
            </h3>

            <p className="mt-0.5 text-xs font-semibold text-gray-500">
              {completedCount}/{sortedItems.length} lifecycle events recorded
            </p>
          </div>
        </div>

        <span className="inline-flex items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-1.5 text-xs font-black text-emerald-700">
          {expanded ? 'Hide timeline' : 'View timeline'}
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {expanded && (
      <div className="px-4 py-5 sm:px-5 sm:py-6">
        {sortedItems.map((item, index) => {
          const meta = getItemMeta(item)
          const isLast = index === sortedItems.length - 1
          const stamp = splitStamp(item.occurred_at)
          const usefulDetail = getUsefulDetail(item.detail, meta.statusLabel)
          const approvalRows = getApprovalRows(item)
          const actorLabel = getActorLabel(item, usefulDetail)

          return (
            <div
              key={item.id || `${item.title}-${index}`}
              className={`grid grid-cols-[72px_36px_minmax(0,1fr)] gap-3 sm:grid-cols-[108px_44px_minmax(0,1fr)] sm:gap-4 ${
                isLast ? '' : 'pb-5'
              }`}
            >
              <div className="pt-4 text-right">
                <p
                  className={`break-words text-[11px] font-black leading-tight sm:text-xs ${
                    stamp.full ? 'text-gray-950' : 'text-amber-700'
                  }`}
                >
                  {stamp.date}
                </p>

                <p
                  className={`mt-1 break-words text-[11px] font-bold leading-tight ${
                    stamp.full ? 'text-gray-400' : 'text-amber-600'
                  }`}
                >
                  {stamp.time || 'Date only'}
                </p>
              </div>

              <div className="relative flex justify-center">
                <div
                  className={`relative z-10 mt-2 flex h-9 w-9 items-center justify-center rounded-full border-2 shadow-lg sm:h-10 sm:w-10 ${meta.nodeClass}`}
                >
                  {meta.icon}
                </div>

                {!isLast && (
                  <div
                    className={`absolute bottom-[-22px] left-1/2 top-12 w-[2px] -translate-x-1/2 ${meta.connectorClass}`}
                  />
                )}
              </div>

              <div
                className={`min-w-0 pt-2 ${
                  isLast ? '' : 'border-b border-gray-100 pb-4'
                }`}
              >
                <p
                  className={`break-words text-sm font-black leading-snug sm:text-base ${meta.titleClass}`}
                >
                  {item.title}
                </p>

                {(usefulDetail || item.user_name || (!stamp.full && item.missing_field)) && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs font-semibold leading-relaxed text-gray-600">
                    {usefulDetail && (
                      <span className="min-w-0 break-words">
                        {usefulDetail}
                      </span>
                    )}

                    {item.user_name && (
                      <span className="inline-flex min-w-0 items-center gap-1.5 break-words text-gray-500">
                        <User size={13} className="shrink-0 text-gray-400" />
                        <span className="min-w-0 break-words">
                          {actorLabel} {item.user_name}
                        </span>
                      </span>
                    )}

                    {!stamp.full && item.missing_field && (
                      <span className="min-w-0 break-words text-amber-700">
                        Missing field: {item.missing_field}
                      </span>
                    )}
                  </div>
                )}

                {approvalRows.length > 0 && (
                  <div className="mt-2">
                    <ApprovalDecisionDetails rows={approvalRows} compact />
                  </div>
                )}

                {item.sub_items?.length ? (
                  <div className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
                    {item.sub_items.map((subItem) => {
                      const submittedStamp = splitStamp(subItem.submitted_at || subItem.occurred_at)
                      const recordedStamp = splitStamp(subItem.recorded_at)
                      const subStatus = String(subItem.status || '').toLowerCase()
                      const submittedLabel = subStatus === 'not_required'
                        ? 'Not required'
                        : submittedStamp.full || 'Submitted date not stored'
                      const recordedLabel = recordedStamp.full
                        ? `Recorded at: ${recordedStamp.full}`
                        : ''

                      return (
                        <div
                          key={subItem.title}
                          className="grid min-w-0 gap-1 px-2 py-2.5 text-xs md:grid-cols-[150px_minmax(130px,1fr)_minmax(130px,1fr)] md:gap-3 xl:grid-cols-[150px_190px_190px_minmax(0,1fr)_auto] xl:items-center"
                        >
                          <p className="min-w-0 break-words font-black text-gray-900">
                            {subItem.title}
                          </p>

                          <p className={`break-words text-[11px] font-semibold leading-relaxed ${
                            submittedStamp.full || subStatus === 'not_required'
                              ? 'text-gray-500'
                              : 'text-amber-600'
                          }`}>
                            Submitted: {submittedLabel}
                          </p>

                          <p className="break-words text-[11px] font-semibold leading-relaxed text-gray-400">
                            {recordedLabel || 'Recorded at: Not stored'}
                          </p>

                          {subItem.detail && (
                            <p className="min-w-0 break-words font-semibold leading-relaxed text-gray-700">
                              {subItem.detail}
                            </p>
                          )}

                          <span
                            className={`w-fit shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-black ${getSubItemStatusClass(subItem.status)}`}
                          >
                            {subItem.status_label || 'Available'}
                          </span>

                          {!submittedStamp.full && subItem.missing_field && (
                            <p className="break-words text-[11px] font-semibold leading-relaxed text-amber-700 xl:col-span-5">
                              Missing field: {subItem.missing_field}
                            </p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
      )}
    </div>
  )
}

// ─── Label / badge maps ───────────────────────────────────────────────────────

const ACTION_FULL_LABEL: Record<string, string> = {
  tender_step1_manager: 'Tender Basic Info Approval (Manager)',
  tender_step1_ceo:     'Tender Basic Info Approval (CEO)',
  tender_step2_manager: 'Tender Details Approval (Manager)',
  tender_step2_ceo:     'Tender Details Approval (CEO)',
  tender_step3_manager: 'Tender Workings Approval (Manager)',
  tender_step3_ceo:     'Tender Workings Approval (CEO)',
  tender_po_manager:    'Tender PO Details Approval (Manager)',
  convert_lead_manager: 'Lead Conversion Approval',
  request:              'Travel Request Approval',
  expense:              'TA/DA Expense Claim (Manager)',
  expense_ceo:          'TA/DA Expense Claim (CEO)',
  release_request:      'BG Release Approval',
  submit:               'Quotation Approval',
}

const ACTION_GROUP_LABEL: Record<string, string> = {
  tender_step1_manager: 'Basic Info Approval · Manager',
  tender_step1_ceo:     'Basic Info Approval · CEO',
  tender_step2_manager: 'Tender Details Approval · Manager',
  tender_step2_ceo:     'Tender Details Approval · CEO',
  tender_step3_manager: 'Workings Approval · Manager',
  tender_step3_ceo:     'Workings Approval · CEO',
  tender_po_manager:    'PO Details Approval · Manager',
  convert_lead_manager: 'Lead Conversion Approval',
  request:              'Travel Request Approval',
  expense:              'Expense Claim · Manager',
  expense_ceo:          'Expense Claim · CEO',
  release_request:      'Release Approval',
  submit:               'Quotation Approval',
}

const ACTION_BADGE_COLOR: Record<string, string> = {
  tender_step1_manager: 'bg-orange-100 text-orange-800 border-orange-200',
  tender_step1_ceo:     'bg-orange-100 text-orange-800 border-orange-200',
  tender_step2_manager: 'bg-amber-100 text-amber-800 border-amber-200',
  tender_step2_ceo:     'bg-amber-100 text-amber-800 border-amber-200',
  tender_step3_manager: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  tender_step3_ceo:     'bg-yellow-100 text-yellow-800 border-yellow-200',
  tender_po_manager:    'bg-blue-100 text-blue-800 border-blue-200',
  convert_lead_manager: 'bg-violet-100 text-violet-800 border-violet-200',
  request:              'bg-blue-100 text-blue-800 border-blue-200',
  expense:              'bg-indigo-100 text-indigo-800 border-indigo-200',
  expense_ceo:          'bg-indigo-100 text-indigo-800 border-indigo-200',
  release_request:      'bg-teal-100 text-teal-800 border-teal-200',
  submit:               'bg-emerald-100 text-emerald-800 border-emerald-200',
}

type ApprovalTab = 'pending' | 'history'
type ApprovalStatusFilter = 'all' | 'approved' | 'rejected'
type ApprovalFilters = {
  search: string
  module: string
  status: ApprovalStatusFilter
  dateFrom: string
  dateTo: string
}

const APPROVAL_HISTORY_PAGE_SIZE = 100

const EMPTY_APPROVAL_FILTERS: ApprovalFilters = {
  search: '',
  module: 'all',
  status: 'all',
  dateFrom: '',
  dateTo: '',
}

const APPROVAL_MODULE_LABEL: Record<string, string> = {
  customer: 'Customers',
  tender: 'Tenders',
  lead: 'Leads',
  travel: 'Travel Requests',
  tada: 'TA/DA Claims',
  emdbg: 'Guarantees & Deposits',
  quotation: 'Quotations',
  work_order: 'Orders & Projects',
  forecast: 'Forecasts',
}

/** The record an approval is about – opened from the approval panel (record title, tender / instrument links). */
function approvalRecordRoute(a: { module: string; record_id: number }): string | null {
  const id = a.record_id
  if (!id) return null
  switch (a.module) {
    case 'emdbg': return `/emdbg?open=${id}`
    case 'tender': return `/tenders/${id}`
    case 'lead': return `/leads?open=${id}`
    case 'deal': return `/opportunities?open=${id}`
    case 'quotation': return `/quotations/${id}`
    case 'work_order': return `/workorders?open=${id}`
    case 'customer': return `/customers/${id}`
    case 'forecast': return '/forecasts'
    default: return null
  }
}

function approvalModuleLabel(module?: string | null) {
  if (!module) return 'Others'
  return APPROVAL_MODULE_LABEL[module] || module.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function approvalTypeLabel(approval: ApprovalItem, grouped = false) {
  return approval.type_label || (
    grouped
      ? ACTION_GROUP_LABEL[approval.action] || approval.action_label || approval.action
      : ACTION_FULL_LABEL[approval.action] || approval.action_label || approval.action
  )
}

function approvalTimestamp(approval: ApprovalItem, tab: ApprovalTab) {
  return tab === 'history'
    ? approval.decided_at || approval.created_at
    : approval.created_at
}

function dateOnly(value?: string | null) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toISOString().slice(0, 10)
}

function flattenApprovalValue(value: unknown, depth = 0): string[] {
  if (value == null || depth > 2) return []
  if (['string', 'number', 'boolean'].includes(typeof value)) return [String(value)]
  if (Array.isArray(value)) return value.flatMap(item => flattenApprovalValue(item, depth + 1))
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(item => flattenApprovalValue(item, depth + 1))
  return []
}

function approvalSearchText(approval: ApprovalItem) {
  return [
    approval.record_ref,
    approval.module,
    approvalModuleLabel(approval.module),
    approvalTypeLabel(approval),
    approval.action,
    approval.action_label,
    approval.requested_by_name,
    approval.requested_to_name,
    approval.request_notes,
    approval.decision_notes,
    approval.rejection_reason,
    approvalDecisionDetailsText(approval),
    ...flattenApprovalValue(approval.summary),
  ].filter(Boolean).join(' ').toLowerCase()
}

function matchesApprovalFilters(approval: ApprovalItem, filters: ApprovalFilters, tab: ApprovalTab) {
  const search = filters.search.trim().toLowerCase()
  if (search && !approvalSearchText(approval).includes(search)) return false
  if (filters.module !== 'all' && approval.module !== filters.module) return false
  if (tab === 'history' && filters.status !== 'all' && approval.status !== filters.status) return false

  const approvalDate = dateOnly(approvalTimestamp(approval, tab))
  if (filters.dateFrom && (!approvalDate || approvalDate < filters.dateFrom)) return false
  if (filters.dateTo && (!approvalDate || approvalDate > filters.dateTo)) return false

  return true
}

function approvalFilterOptions(items: ApprovalItem[]) {
  const moduleMap = new Map<string, string>()

  items.forEach(item => {
    if (item.module) moduleMap.set(item.module, approvalModuleLabel(item.module))
  })

  return {
    modules: Array.from(moduleMap, ([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label)),
  }
}

function countActiveApprovalFilters(filters: ApprovalFilters, tab: ApprovalTab) {
  return [
    filters.search.trim(),
    filters.module !== 'all',
    tab === 'history' && filters.status !== 'all',
    filters.dateFrom,
    filters.dateTo,
  ].filter(Boolean).length
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function getFileType(path: string): 'pdf' | 'image' | 'excel' | 'word' | 'other' {
  if (!path) return 'other'
  const ext = (path.split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image'
  if (['xlsx', 'xls', 'csv', 'xlsm', 'ods'].includes(ext)) return 'excel'
  if (['doc', 'docx', 'odt'].includes(ext)) return 'word'
  return 'other'
}

function getDownloadUrl(rawPath: string): string {
  if (!rawPath) return ''
  const envBase: string = (import.meta as any).env?.VITE_API_BASE_URL || ''
  const axiosBase: string = (api as any).defaults?.baseURL || ''
  const apiBase = (envBase || axiosBase || `${window.location.origin}/api/v1`).replace(/\/$/, '')
  const filePath = rawPath.startsWith('http') ? new URL(rawPath).pathname : rawPath
  const token = localStorage.getItem('access_token') || localStorage.getItem('token') || ''
  const tenant = localStorage.getItem('tenant_slug') || ''
  const params = new URLSearchParams({ path: filePath })
  if (token) params.set('token', token)
  if (tenant) params.set('tenant', tenant)
  return `${apiBase}/preview/download?${params.toString()}`
}

function getPreviewUrl(rawPath: string): string {
  if (!rawPath) return ''
  const envBase: string = (import.meta as any).env?.VITE_API_BASE_URL || ''
  const axiosBase: string = (api as any).defaults?.baseURL || ''
  const apiBase = (envBase || axiosBase || `${window.location.origin}/api/v1`).replace(/\/$/, '')
  const filePath = rawPath.startsWith('http') ? new URL(rawPath).pathname : rawPath
  const token = localStorage.getItem('access_token') || localStorage.getItem('token') || ''
  const tenant = localStorage.getItem('tenant_slug') || ''
  const params = new URLSearchParams({ path: filePath })
  if (token) params.set('token', token)
  if (tenant) params.set('tenant', tenant)
  return `${apiBase}/preview/file?${params.toString()}`
}

function formatApprovalValue(value: any): string | null {
  if (value === null || value === undefined || value === '') return null
  const amount = Number(value)
  if (!Number.isFinite(amount)) return null
  return `\u20b9${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

function buildLeadConversionRequestNotes(approval: ApprovalItem, summary: any): string | null {
  if (approval.request_notes?.trim()) return approval.request_notes
  const isLeadConversion = approval.module === 'lead' && ['convert', 'convert_lead_manager'].includes(approval.action)
  if (!isLeadConversion) return null
  const rawTitle = summary?.lead_title || summary?.title || approval.record_ref || ''
  const title = String(rawTitle).replace(/^Lead:\s*/i, '').trim() || `Lead #${approval.record_id}`
  const leadRef = summary?.lead_ref_id || summary?.lead_ref || summary?.lead_id || approval.record_id
  const opportunityRef = summary?.opportunity_ref_id || summary?.opp_ref_id || summary?.opportunity_id || '-'
  const valueText = formatApprovalValue(summary?.estimated_value ?? summary?.est_value ?? summary?.value)
  const valuePart = valueText ? `, Value: ${valueText}` : ''
  return `Requesting conversion of '${title}' (Lead: ${leadRef}, Opp: ${opportunityRef}${valuePart}) to tender.`
}

function fmt(v: number | null | undefined) {
  if (v == null) return '—'
  return `₹${Number(v).toLocaleString('en-IN')}`
}

// ─── FilePreviewModal ─────────────────────────────────────────────────────────

function FilePreviewModal({ file, onClose }: { file: DocumentInfo | null; onClose: () => void }) {
  if (!file) return null
  const rawPath    = file.preview_url || file.file_url || file.file_path || ''
  const fileType   = getFileType(rawPath)
  const directUrl  = getDownloadUrl(rawPath)
  const previewUrl = getPreviewUrl(rawPath)

  return createPortal(
    <div className="fixed inset-0 z-[100120] flex items-center justify-center bg-black/65 p-4"
         onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-3.5 border-b border-gray-100 bg-gray-50">
          <div className="flex items-center gap-3">
            {fileType === 'pdf'   && <FileText        size={18} className="text-red-500" />}
            {fileType === 'image' && <ImageIcon       size={18} className="text-blue-500" />}
            {fileType === 'excel' && <FileSpreadsheet size={18} className="text-green-600" />}
            {fileType === 'word'  && <FileText        size={18} className="text-blue-700" />}
            {fileType === 'other' && <File            size={18} className="text-gray-500" />}
            <div>
              <p className="font-bold text-gray-900 text-sm truncate max-w-[380px]">{file.file_name}</p>
              <p className="text-xs text-gray-500">{file.doc_type}{file.file_size_kb ? ` · ${file.file_size_kb} KB` : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href={directUrl} target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg transition-colors font-semibold">
              <ExternalLink size={12} />Open
            </a>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-500"><X size={16} /></button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-gray-50 flex items-center justify-center min-h-[400px]">
          {fileType === 'image' && (
            <img src={previewUrl} alt={file.file_name} className="max-w-full max-h-[75vh] object-contain rounded-lg shadow-md m-4" />
          )}
          {(fileType === 'pdf' || fileType === 'excel' || fileType === 'word') && (
            <iframe key={previewUrl} src={previewUrl} title={file.file_name} className="w-full h-[75vh] border-none bg-white" />
          )}
          {fileType === 'other' && (
            <div className="text-center py-16 px-8">
              <div className="w-20 h-20 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-4">
                <File size={36} className="text-gray-400" />
              </div>
              <p className="text-gray-800 font-bold mb-1">{file.file_name}</p>
              <p className="text-sm text-gray-500 mb-6">Preview not available for this file type.</p>
              <a href={directUrl} target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-2 bg-indigo-600 text-white px-6 py-2.5 rounded-xl hover:bg-indigo-700 transition-colors text-sm font-bold">
                <ExternalLink size={15} />Open File
              </a>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── DocChip ──────────────────────────────────────────────────────────────────

function DocChip({ doc, onClick }: { doc: DocumentInfo; onClick: () => void }) {
  const rawPath  = doc.preview_url || doc.file_url || doc.file_path || ''
  const fileType = getFileType(rawPath)
  const icons: Record<string, React.ReactNode> = {
    pdf:   <FileText        size={13} className="text-red-400 shrink-0" />,
    image: <ImageIcon       size={13} className="text-blue-400 shrink-0" />,
    excel: <FileSpreadsheet size={13} className="text-green-500 shrink-0" />,
    word:  <FileText        size={13} className="text-blue-700 shrink-0" />,
    other: <File            size={13} className="text-gray-400 shrink-0" />,
  }
  return (
    <button onClick={onClick}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-lg hover:border-indigo-300 hover:bg-indigo-50 transition-all text-xs text-left group max-w-[220px]">
      {icons[fileType]}
      <span className="truncate text-gray-700 group-hover:text-indigo-700 flex-1 font-medium">{doc.file_name}</span>
      <Eye size={11} className="shrink-0 text-gray-400 group-hover:text-indigo-500 ml-auto" />
    </button>
  )
}

// ─── Shared UI ────────────────────────────────────────────────────────────────

/**
 * Field: compact 2-col grid cell. Use inside a `grid grid-cols-2 gap-x-6 gap-y-3` wrapper.
 * span2 — stretches to full width for long values (addresses, notes, titles).
 */
function Field({
  label, value, highlight, mono, span2,
}: {
  label: string
  value?: any
  highlight?: boolean
  mono?: boolean
  span2?: boolean
}) {
  return (
    <div className={span2 ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <div className="grid grid-cols-[145px_minmax(0,1fr)] items-start gap-6 py-1.5">
        <p className="text-[12px] font-black text-gray-400 uppercase tracking-wide">
          {label}
        </p>

        <p
          className={`text-[15px] break-words leading-snug ${
            highlight ? 'font-black text-gray-950' : 'font-bold text-gray-900'
          } ${mono ? 'font-mono text-[13px]' : ''}`}
        >
          {value ?? <span className="text-gray-300 font-normal">—</span>}
        </p>
      </div>
    </div>
  )
}

/**
 * SectionCard: always-open flat card with a header row.
 * No accordion — eliminates click-to-expand overhead.
 */
function SectionCard({
  title, icon: Icon, color = 'indigo', children, noPad = false,
}: {
  title: string; icon: any; color?: string; children: React.ReactNode; noPad?: boolean
}) {
  const colorMap: Record<string, string> = {
    indigo: 'text-indigo-500', orange: 'text-orange-500', blue: 'text-blue-500',
    violet: 'text-violet-500', teal: 'text-teal-500', sky: 'text-sky-500',
    amber: 'text-amber-500', emerald: 'text-emerald-500', green: 'text-green-500',
    gray: 'text-gray-400', red: 'text-red-400',
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 bg-gray-50/80">
        <Icon size={15} className={colorMap[color] || 'text-indigo-500'} aria-hidden />
        <span className="text-[14px] font-black text-gray-700">{title}</span>
      </div>
      <div className={noPad ? '' : 'px-4 py-3'}>{children}</div>
    </div>
  )
}

function BoolBadge({ value, trueLabel = 'Yes', falseLabel = 'No' }: { value: boolean; trueLabel?: string; falseLabel?: string }) {
  return value
    ? <span className="inline-flex items-center gap-1 text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-bold"><CheckCircle size={10} />{trueLabel}</span>
    : <span className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-semibold"><XCircle size={10} />{falseLabel}</span>
}

// ─── Quotation Summary Panel ──────────────────────────────────────────────────

function QuotationSummaryPanel({ data }: { data: any }) {
  const lineItems: any[] = Array.isArray(data.line_items) ? data.line_items : []
  return (
    <div className="space-y-3">
      {/* Slim hero strip */}
      <div className="flex items-center gap-3 px-4 py-3 bg-emerald-50 border border-emerald-100 rounded-xl">
        <FileText size={16} className="text-emerald-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-black text-gray-900 truncate">
            {data.quotation_number}
            <span className="ml-2 text-xs font-bold text-purple-700 bg-purple-50 border border-purple-200 px-1.5 py-0.5 rounded-full">Q{data.revision_number}</span>
          </p>
          <p className="text-xs text-gray-500 truncate">{data.customer_name}{data.source_title ? ` · ${data.source_title}` : ''}</p>
        </div>
        {data.total_amount != null && (
          <div className="text-right shrink-0 pl-3 border-l border-emerald-200">
            <p className="text-[10px] text-emerald-600 font-bold uppercase">Total</p>
            <p className="text-base font-black text-emerald-900">{fmt(data.total_amount)}</p>
          </div>
        )}
      </div>

<div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <SectionCard title="Details" icon={FileText} color="emerald">
          <div className="grid grid-cols-1 gap-y-3">
            <Field label="Quotation No." value={data.quotation_number} mono />
            <Field label="Revision" value={`Q${data.revision_number}`} />
            <Field label="Status" value={data.status} />
            <Field label="Customer" value={data.customer_name} />
            <Field label="Valid Until" value={data.valid_until} />
            <Field label="Source / Ref" value={data.source_ref || data.source_title} />
          </div>
        </SectionCard>

        <SectionCard title="Financials" icon={IndianRupee} color="green">
          <div className="grid grid-cols-1 gap-y-3">
            <Field label="Subtotal" value={fmt(data.amount)} />
            <Field label="Tax" value={fmt(data.tax_amount)} />
            <Field label="Grand Total" value={fmt(data.total_amount)} highlight />
          </div>
        </SectionCard>

        {lineItems.length > 0 && (
          <SectionCard title={`Line Items (${lineItems.length})`} icon={Package} color="blue" noPad>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50/60">
                    <th className="px-4 py-2 text-left text-[11px] font-black text-gray-400 uppercase tracking-wide">Description</th>
                    <th className="px-3 py-2 text-right text-[11px] font-black text-gray-400 uppercase tracking-wide">Qty</th>
                    <th className="px-3 py-2 text-right text-[11px] font-black text-gray-400 uppercase tracking-wide">Unit Price</th>
                    <th className="px-3 py-2 text-right text-[11px] font-black text-gray-400 uppercase tracking-wide">Tax</th>
                    <th className="px-4 py-2 text-right text-[11px] font-black text-gray-400 uppercase tracking-wide">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {lineItems.map((item: any, i: number) => (
                    <tr key={i}>
                      <td className="px-4 py-3 text-sm font-semibold text-gray-800">{item.description}</td>
                      <td className="px-3 py-3 text-right text-sm text-gray-700"><b className="text-gray-700">{item.quantity}</b></td>
                      <td className="px-3 py-3 text-right text-sm text-gray-500">{fmt(item.unit_price)}</td>
                      <td className="px-3 py-3 text-right text-xs text-gray-500">{item.tax_percent}%</td>
                      <td className="px-4 py-3 text-right text-sm font-black text-gray-900">{fmt(item.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        )}
      </div>

      {data.notes && (
        <SectionCard title="Notes" icon={FileText} color="gray">
          <p className="text-sm text-gray-700 whitespace-pre-line leading-relaxed">{data.notes}</p>
        </SectionCard>
      )}
    </div>
  )
}

// ─── Customer Summary Panel ───────────────────────────────────────────────────
function CompactField({
  label,
  value,
  mono,
}: {
  label: string
  value?: any
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-black text-gray-400 uppercase tracking-wide mb-1">
        {label}
      </p>
      <p className={`text-[15px] font-black text-gray-950 leading-snug break-words ${mono ? 'font-mono text-[13px]' : ''}`}>
        {value || <span className="text-gray-300 font-normal">—</span>}
      </p>
    </div>
  )
}

function CustomerSummaryPanel({ data }: { data: any }) {
  return (
    <div className="space-y-3">
      <SectionCard title="Customer Details" icon={Building2} color="sky" noPad>
        <div className="px-4 py-3">
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-x-8 gap-y-4">
            <CompactField label="Customer Name" value={data.customer_name} />
            <CompactField label="Status" value={data.account_status} />
            <CompactField label="Potential" value={data.account_potential} />
            <CompactField label="Industry" value={data.industry} />
            <CompactField label="Segmnet" value={data.customer_vertical} />

            <CompactField label="Division" value={data.division} />
            <CompactField label="Group" value={data.group_name} />
            <CompactField label="Owner / KAM" value={data.assigned_to_name} />
            <CompactField label="GST Number" value={data.gst_number} mono />
            <CompactField label="PAN Number" value={data.pan_number} mono />

            {data.annual_revenue != null && (
              <CompactField label="Annual Revenue" value={fmt(data.annual_revenue)} />
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Address & Contacts" icon={Users} color="teal" noPad>
        <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1fr_1fr] divide-y xl:divide-y-0 xl:divide-x divide-gray-100">
          <div className="px-4 py-3">
            <p className="text-[11px] font-black text-gray-400 uppercase mb-1">
              Billing Address
            </p>
            <p className="text-base font-bold text-gray-950 leading-snug">
              {data.billing_address || <span className="text-gray-300">—</span>}
            </p>
          </div>

          <div className="px-4 py-3">
            <p className="text-[11px] font-black text-gray-400 uppercase mb-1">
              Shipping Address
            </p>
            {data.shipping_same_as_billing ? (
              <p className="text-base font-black text-emerald-700 flex items-center gap-1.5">
                <CheckCircle size={14} />
                Same as billing
              </p>
            ) : (
              <p className="text-base font-bold text-gray-950 leading-snug">
                {data.shipping_address || <span className="text-gray-300">—</span>}
              </p>
            )}
          </div>

          <div className="px-4 py-3">
            <p className="text-[11px] font-black text-gray-400 uppercase mb-1">
              Contacts {data.contacts?.length ? `(${data.contacts.length})` : ''}
            </p>

            {data.contacts?.length > 0 ? (
              <div className="space-y-1">
                {data.contacts.map((ct: any, i: number) => (
                  <div key={i} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-base font-black text-gray-950 truncate">
                        {ct.contact_name}
                      </p>

                      {(ct.designation || ct.department) && (
                        <p className="text-xs text-gray-500 font-semibold truncate">
                          {ct.designation}
                          {ct.department ? ` · ${ct.department}` : ''}
                        </p>
                      )}

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                        {ct.mobile && (
                          <p className="text-xs text-gray-600 flex items-center gap-1">
                            <Phone size={11} className="text-gray-400" />
                            {ct.mobile}
                          </p>
                        )}

                        {ct.office_email && (
                          <p className="text-xs text-gray-600 flex items-center gap-1">
                            <Mail size={11} className="text-gray-400" />
                            {ct.office_email}
                          </p>
                        )}
                      </div>
                    </div>

                    {ct.is_primary && (
                      <span className="text-[10px] bg-sky-100 text-sky-700 px-2 py-0.5 rounded-full font-black shrink-0">
                        Primary
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400 font-semibold">No contacts</p>
            )}
          </div>
        </div>
      </SectionCard>

      {data.remarks && (
        <SectionCard title="Remarks" icon={FileText} color="amber">
          <p className="text-sm text-amber-900 font-semibold leading-relaxed">
            {data.remarks}
          </p>
        </SectionCard>
      )}
    </div>
  )
}

// ─── Lead Summary Panel ───────────────────────────────────────────────────────

function LeadSummaryPanel({ data }: { data: any }) {
  const hasVal = (v: any) => v !== null && v !== undefined && v !== '' && v !== 0
  const leadTitle    = data.title || data.lead_title || data.record_ref
  const companyName  = data.company_name || data.customer_name
  const estimatedVal = data.estimated_value ?? data.est_value
  const products     = Array.isArray(data.products) ? data.products : []

  return (
    <div className="space-y-3">
      {/* Slim hero */}
      {companyName && (
        <div className="flex items-center gap-3 px-3 py-2.5 bg-violet-50 border border-violet-100 rounded-xl">
          <Building2 size={16} className="text-violet-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-black text-violet-900 truncate">{companyName}</p>
            {hasVal(leadTitle) && leadTitle !== companyName && (
              <p className="text-xs text-violet-600 font-semibold truncate">{leadTitle}</p>
            )}
          </div>
          {hasVal(estimatedVal) && (
            <div className="text-right shrink-0 pl-3 border-l border-violet-200">
              <p className="text-[10px] text-violet-500 font-bold uppercase">Est. Value</p>
              <p className="text-base font-black text-violet-900">{fmt(estimatedVal)}</p>
            </div>
          )}
        </div>
      )}

      {/* Two-column: Overview + Opportunity */}
      <div className="grid grid-cols-2 gap-3">
        <SectionCard title="Lead Overview" icon={Tag} color="violet">
          <div className="grid grid-cols-1 gap-y-3">
            {hasVal(leadTitle) && <Field label="Lead Title" value={leadTitle} highlight />}
            {hasVal(data.lead_type) && <Field label="Lead Type" value={data.lead_type} />}
            {hasVal(data.status) && <Field label="Status" value={data.status} />}
            {hasVal(data.source) && <Field label="Source" value={data.source} />}
            {hasVal(data.priority) && <Field label="Priority" value={data.priority} />}
            {hasVal(data.region) && <Field label="Region" value={data.region} />}
            {hasVal(data.industry) && <Field label="Industry" value={data.industry} />}
            {hasVal(data.assigned_to_name) && <Field label="Assigned To" value={data.assigned_to_name} />}
          </div>
        </SectionCard>

        <div className="space-y-3">
          {(hasVal(estimatedVal) || hasVal(data.probability) || hasVal(data.expected_close_date) || hasVal(data.deal_stage)) && (
            <SectionCard title="Opportunity" icon={TrendingUp} color="emerald">
              <div className="grid grid-cols-1 gap-y-3">
                {hasVal(estimatedVal) && <Field label="Est. Value" value={fmt(estimatedVal)} highlight />}
                {hasVal(data.probability) && <Field label="Probability" value={`${data.probability}%`} />}
                {hasVal(data.expected_close_date) && <Field label="Expected Close" value={data.expected_close_date} />}
                {hasVal(data.deal_stage) && <Field label="Deal Stage" value={data.deal_stage} />}
                {hasVal(data.opportunity_type) && <Field label="Type" value={data.opportunity_type} />}
              </div>
            </SectionCard>
          )}

          {(hasVal(data.contact_person) || hasVal(data.email) || hasVal(data.phone)) && (
            <SectionCard title="Contact" icon={Contact} color="sky">
              <div className="grid grid-cols-1 gap-y-3">
                {hasVal(data.contact_person) && <Field label="Contact Person" value={data.contact_person} />}
                {hasVal(data.email) && <Field label="Email" value={data.email} />}
                {hasVal(data.phone) && <Field label="Phone" value={data.phone} />}
              </div>
            </SectionCard>
          )}
        </div>
      </div>

      {/* Requirements */}
      {(hasVal(data.description) || hasVal(data.requirements) || hasVal(data.notes)) && (
        <SectionCard title="Requirements & Notes" icon={FileText} color="amber">
          <div className="space-y-3">
            {hasVal(data.description) && (
              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1">Description</p>
                <p className="text-sm text-gray-800 leading-relaxed">{data.description}</p>
              </div>
            )}
            {hasVal(data.requirements) && (
              <div className={hasVal(data.description) ? 'border-t border-gray-100 pt-3' : ''}>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1">Requirements</p>
                <p className="text-sm text-gray-800 leading-relaxed">{data.requirements}</p>
              </div>
            )}
            {hasVal(data.notes) && (
              <div className={(hasVal(data.description) || hasVal(data.requirements)) ? 'border-t border-gray-100 pt-3' : ''}>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1">Notes</p>
                <p className="text-sm text-gray-800 leading-relaxed">{data.notes}</p>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* Products table */}
      {products.length > 0 && (
        <SectionCard title={`Products / Items (${products.length})`} icon={Package} color="violet" noPad>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-4 py-2.5 text-left text-[11px] font-black text-gray-400 uppercase tracking-wide">Product</th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-black text-gray-400 uppercase tracking-wide">OEM</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-black text-gray-400 uppercase tracking-wide">Qty</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-black text-gray-400 uppercase tracking-wide">Unit Price</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-black text-gray-400 uppercase tracking-wide">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {products.map((p: any, i: number) => {
                  const productName = p.product_name || p.name || p.item_name || p.title || p.product?.name || null
                  const oemName    = p.oem_name || p.oem?.name || p.brand_name || p.make || null
                  const unitPrice  = p.unit_price ?? p.price ?? null
                  const qty        = p.quantity ?? p.qty ?? null
                  const calculatedTotal = unitPrice != null && qty != null ? Number(unitPrice) * Number(qty) : null
                  const totalPrice = p.total_price ?? p.amount ?? (calculatedTotal != null && Number.isFinite(calculatedTotal) ? calculatedTotal : null)
                  return (
                    <tr key={p.id || i} className="hover:bg-violet-50/30">
                      <td className="px-4 py-2.5 font-black text-gray-900">
                        {productName || <span className="text-gray-400 font-normal italic">Unnamed</span>}
                      </td>
                      <td className="px-4 py-2.5 font-semibold text-gray-700">{oemName || '—'}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-gray-700">{qty != null ? `${qty}${p.unit ? ' ' + p.unit : ''}` : '—'}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-gray-700">{unitPrice != null ? fmt(unitPrice) : '—'}</td>
                      <td className="px-4 py-2.5 text-right font-black text-gray-900">{totalPrice != null ? fmt(totalPrice) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {products.some((p: any) => p.total_price != null || p.amount != null || (p.unit_price != null && (p.quantity != null || p.qty != null))) && (
            <div className="flex items-center justify-between px-4 py-2.5 bg-violet-50 border-t border-violet-100">
              <span className="text-xs font-bold text-violet-700">Grand Total</span>
              <span className="text-sm font-black text-violet-900">
                {fmt(products.reduce((s: number, p: any) => {
                  const qty = p.quantity ?? p.qty
                  const unitPrice = p.unit_price ?? p.price
                  const calculatedTotal = unitPrice != null && qty != null ? Number(unitPrice) * Number(qty) : null
                  const totalPrice = p.total_price ?? p.amount ?? (calculatedTotal != null && Number.isFinite(calculatedTotal) ? calculatedTotal : 0)
                  return s + (Number(totalPrice) || 0)
                }, 0))}
              </span>
            </div>
          )}
        </SectionCard>
      )}
    </div>
  )
}

// ─── Travel Summary Panel ─────────────────────────────────────────────────────

function TravelSummaryPanel({ data }: { data: any }) {
  const hasVal = (v: any) => v !== null && v !== undefined && v !== ''
  const totalDays = data.total_days || 1
  const isReturn  = data.return_date && data.return_date !== data.travel_date
  const money = (v: any) => hasVal(v) ? fmt(Number(v)) : undefined
  const yesNo = (v: any) => v ? 'Yes' : 'No'

  return (
    <div className="space-y-3">
      {/* Route hero strip */}
      <div className="flex items-center gap-3 px-4 py-3 bg-blue-50 border border-blue-100 rounded-xl">
        <Plane size={16} className="text-blue-600 shrink-0" />
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm font-black text-blue-900">{data.from_city}</span>
          <ArrowRight size={13} className="text-blue-400 shrink-0" />
          <span className="text-sm font-black text-blue-900">{data.to_city}</span>
          <span className="text-xs bg-blue-200 text-blue-800 px-2 py-0.5 rounded-full font-bold">{totalDays}d</span>
        </div>
        <div className="text-right shrink-0 pl-3 border-l border-blue-200">
          <p className="text-[10px] text-blue-500 font-bold uppercase">Travel Date</p>
          <p className="text-sm font-black text-blue-900">{data.travel_date}</p>
        </div>
      </div>

      {/* Two-column main blocks */}
      <div className="grid grid-cols-2 gap-3">
        <SectionCard title="Trip Summary" icon={Plane} color="blue">
          <div className="grid grid-cols-1 gap-y-3">
            <Field label="Employee" value={data.employee_name} highlight />
            <Field label="Request No." value={data.request_number} />
            <Field label="Purpose" value={data.purpose} />
            <Field label="Visit Type" value={data.visit_type} />
            <Field label="Total Days" value={`${totalDays} day${totalDays !== 1 ? 's' : ''}`} />
            {isReturn && <Field label="Return Date" value={data.return_date} />}
            <Field label="Outside District" value={yesNo(data.is_outside_district)} />
          </div>
        </SectionCard>

        <SectionCard title="CRM Linkage" icon={Building2} color="sky">
          <div className="grid grid-cols-1 gap-y-3">
            <Field label="Account / Customer" value={data.account_name} highlight />
            <Field label="Contact Person" value={data.contact_name} />
            <Field label="Contact Phone" value={data.contact_phone} />
            <Field label="Lead / Ref ID" value={data.lead_ref || data.lead_id} />
            <Field label="Linked Tender" value={data.tender_label || data.tender_id} />
            {hasVal(data.kam_activity_subject) && <Field label="KAM Activity" value={data.kam_activity_subject} />}
          </div>
        </SectionCard>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <SectionCard title="Travel & Budget" icon={CreditCard} color="emerald">
          <div className="grid grid-cols-1 gap-y-3">
            <Field label="Transport Mode" value={data.transport_mode} />
            <Field label="Vehicle Number" value={data.vehicle_number} />
            {hasVal(data.estimated_kms) && <Field label="Estimated KMs" value={`${data.estimated_kms} km`} />}
            <Field label="Estimated Total" value={money(data.estimated_total)} highlight />
            <Field label="Advance Required" value={yesNo(data.advance_required)} />
            {hasVal(data.advance_amount) && <Field label="Advance Amount" value={money(data.advance_amount)} />}
            <Field label="Cost Center" value={data.cost_center} />
          </div>
        </SectionCard>

        <SectionCard title="Accommodation" icon={Home} color="violet">
          <div className="grid grid-cols-1 gap-y-3">
            <Field label="Required" value={yesNo(data.accommodation_required)} />
            <Field label="Type" value={data.accommodation_type} />
            <Field label="Hotel Name" value={data.hotel_name} />
            <Field label="Check-in" value={data.check_in_date} />
            <Field label="Check-out" value={data.check_out_date} />
            {hasVal(data.accommodation_cost) && <Field label="Cost" value={money(data.accommodation_cost)} />}
          </div>
        </SectionCard>
      </div>

      {(data.companions || data.notes) && (
        <SectionCard title="Additional Info" icon={FileText} color="amber">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            {data.companions && <Field label="Travel Companions" value={data.companions} span2 />}
            {data.notes && <Field label="Notes / Remarks" value={data.notes} span2 />}
          </div>
        </SectionCard>
      )}
    </div>
  )
}

// ─── TADA Summary Panel ───────────────────────────────────────────────────────

function TADASummaryPanel({ data, onPreview }: { data: any; onPreview: (doc: DocumentInfo) => void }) {
  const makeDoc = (att: any): DocumentInfo => ({
    id: att.id || 0, doc_type: att.doc_type || 'Receipt',
    file_name: att.file_name || att.file_url?.split('/').pop() || 'Document',
    file_path: att.file_url || att.file_path || '',
    preview_url: att.preview_url || att.file_url || att.file_path || '',
    file_url: att.file_url || att.file_path || '',
    file_size_kb: att.file_size_kb,
    uploaded_at: att.uploaded_at || null,
  })
  const totalAmount = data.line_items?.reduce((s: number, i: any) => s + (i.amount || 0), 0) || data.total_amount || 0

  return (
    <div className="space-y-3">
      {/* 3-up amount strip */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total Amount',  value: fmt(data.total_amount || 0),  color: 'text-gray-900',    bg: 'bg-gray-50 border-gray-100' },
          { label: 'Advance Taken', value: fmt(data.advance_taken || 0), color: 'text-amber-700',   bg: 'bg-amber-50 border-amber-100' },
          { label: 'Net Payable',   value: fmt(data.net_payable  || 0),  color: 'text-emerald-800', bg: 'bg-emerald-50 border-emerald-100' },
        ].map(({ label, value, color, bg }) => (
          <div key={label} className={`${bg} border rounded-xl p-3 text-center`}>
            <p className={`text-base font-black ${color}`}>{value}</p>
            <p className="text-xs text-gray-500 font-semibold mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      <SectionCard title="Claim Details" icon={Receipt} color="indigo">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Field label="Employee" value={data.employee_name} highlight span2 />
          <Field label="Claim No." value={data.claim_number} />
          <Field label="Claim Date" value={data.claim_date} />
          <Field label="Purpose" value={data.purpose} span2 />
          {data.travel_date_from && (
            <Field label="Travel Period" value={`${data.travel_date_from}${data.travel_date_to ? ' → ' + data.travel_date_to : ''}`} span2 />
          )}
          <Field label="Status" value={data.overall_status} />
        </div>
      </SectionCard>

      {data.line_items?.length > 0 && (
        <SectionCard title={`Expense Items (${data.line_items.length})`} icon={DollarSign} color="emerald" noPad>
          <div className="divide-y divide-gray-50">
            {data.line_items.map((item: any, i: number) => (
              <div key={item.id || i} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-900 truncate">{item.description}</p>
                    <p className="text-xs text-gray-400 font-semibold">
                      {item.category}{item.expense_date ? ` · ${item.expense_date}` : ''}
                      {item.from_place && item.to_place ? ` · ${item.from_place} → ${item.to_place}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {(item.attachments || []).length > 0
                      ? <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-bold flex items-center gap-1"><CheckCircle size={10} />Proof</span>
                      : <span className="text-xs bg-red-50 text-red-500 px-2 py-0.5 rounded-full font-bold flex items-center gap-1"><AlertCircle size={10} />No proof</span>}
                    <p className="text-sm font-black text-gray-900">₹{Number(item.amount).toLocaleString('en-IN')}</p>
                  </div>
                </div>
                {(item.attachments || []).length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {(item.attachments as any[]).map((att: any, j: number) => (
                      <DocChip key={att.id || j} doc={makeDoc(att)} onClick={() => onPreview(makeDoc(att))} />
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50">
              <span className="text-sm text-gray-600 font-bold">Total</span>
              <span className="text-base font-black text-gray-900">{fmt(totalAmount)}</span>
            </div>
          </div>
        </SectionCard>
      )}
    </div>
  )
}

// ─── Tender Summary Panel ─────────────────────────────────────────────────────

function TenderSummaryPanel({ data, onPreview, action }: {
  data: any; onPreview: (doc: DocumentInfo) => void; action?: string
}) {
  const { step1, step2, step3, step4, step5, step7, documents } = data || {}

  if (!step1 && !step2 && !step3 && !step4 && !step5 && !step7) {
    return <div className="bg-white border border-gray-100 rounded-xl p-6 text-center"><p className="text-sm text-gray-500">No tender details available</p></div>
  }

  const isWorkingsAction = !!(action && (action.includes('working') || action.includes('step3')))
  const makeDoc = (path: string, docType: string): DocumentInfo => ({
    id: 0, doc_type: docType, file_name: path.split('/').pop() || docType,
    file_path: path, preview_url: path, file_url: path, uploaded_at: null,
  })

  return (
    <div className="space-y-3">
      {/* Slim hero strip */}
      {step1?.customer_name && (
        <div className="flex items-center gap-3 px-3 py-2.5 bg-orange-50 border border-orange-100 rounded-xl">
          <Building2 size={16} className="text-orange-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-black text-gray-900 truncate">{step1.customer_name}</p>
            {step1.tender_title && <p className="text-xs text-orange-700 font-semibold truncate">{step1.tender_title}</p>}
          </div>
          {step1.est_value && (
            <div className="text-right shrink-0 pl-3 border-l border-orange-200">
              <p className="text-[10px] text-orange-500 font-bold uppercase">Est. Value</p>
              <p className="text-base font-black text-orange-900">{fmt(step1.est_value)}</p>
            </div>
          )}
        </div>
      )}

    {/* Tab 1 + Tab 2 + Products in single row */}
<div className="grid grid-cols-1 xl:grid-cols-3 gap-3 items-stretch">
  {step1 && (
    <SectionCard title="Tab 1 — Basic Info" icon={FileText} color="orange">
      <div className="grid grid-cols-1 gap-y-3">
        <Field label="Portal Ref No." value={step1.portal_ref_number} />
        <Field label="Source Portal" value={step1.source_portal} />
        <Field label="Stage" value={step1.tender_status} />
        <Field label="Published Date" value={step1.published_date} />
        <Field label="Pre-Bid Date" value={step1.pre_bid_date} />
        <Field label="Submission Date" value={step1.submission_date} highlight />
        <Field label="Assigned To" value={step1.assigned_to_name} />

        {step1.rfp_document && (
          <div>
            <p className="text-[12px] font-black text-gray-400 uppercase tracking-wide mb-2">
              RFP Document
            </p>
            <DocChip
              doc={makeDoc(step1.rfp_document, 'Tender Document')}
              onClick={() => onPreview(makeDoc(step1.rfp_document, 'Tender Document'))}
            />
          </div>
        )}
      </div>
    </SectionCard>
  )}

  {step2 && (
    <SectionCard title="Tab 2 — Tender Details (Financials)" icon={DollarSign} color="amber">
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-gray-100 pb-3">
          <span className="text-[15px] font-black text-gray-500">Tender Fee</span>
          <BoolBadge value={step2.tender_fee_required} trueLabel="Required" falseLabel="Not Required" />
        </div>

        <div className="border-b border-gray-100 pb-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[15px] font-black text-gray-500">
              EMD (Earnest Money Deposit)
            </span>
            <BoolBadge value={step2.emd_required} trueLabel="Required" falseLabel="Not Required" />
          </div>

          {step2.emd_required && (
            <div className="grid grid-cols-2 gap-3">
              {step2.emd_amount && (
                <div className="bg-blue-50 rounded-lg px-3 py-2">
                  <p className="text-[11px] font-black text-blue-600 uppercase">Amount</p>
                  <p className="text-[17px] font-black text-blue-900">{fmt(step2.emd_amount)}</p>
                </div>
              )}

              {step2.emd_payment_method && (
                <div className="bg-blue-50 rounded-lg px-3 py-2">
                  <p className="text-[11px] font-black text-blue-600 uppercase">Method</p>
                  <p className="text-[17px] font-black text-blue-900">{step2.emd_payment_method}</p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-b border-gray-100 pb-3">
          <span className="text-[15px] font-black text-gray-500">
            PBG (Performance Bank Guarantee)
          </span>
          <BoolBadge value={step2.pbg_required} trueLabel="Required" falseLabel="Not Required" />
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-black text-gray-500">Split Order:</span>
            <BoolBadge value={step2.split_order} />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[14px] font-black text-gray-500">Reverse Auction:</span>
            <BoolBadge value={step2.reverse_auction} />
          </div>
        </div>
      </div>
    </SectionCard>
  )}

  {step1?.products?.length > 0 && (
    <SectionCard title={`Products / BOQ (${step1.products.length})`} icon={Package} color="indigo" noPad>
      <div className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="px-4 py-3 text-left text-[12px] font-black text-gray-400 uppercase">
                Product
              </th>
              <th className="px-4 py-3 text-left text-[12px] font-black text-gray-400 uppercase">
                Qty
              </th>
              <th className="px-4 py-3 text-left text-[12px] font-black text-gray-400 uppercase">
                OEM
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-gray-100">
            {step1.products.map((p: any, i: number) => (
              <tr key={i}>
                <td className="px-4 py-3 font-black text-[15px] text-gray-900">
                  {p.product_name}
                </td>
                <td className="px-4 py-3 font-bold text-[15px] text-gray-700">
                  {p.quantity || '—'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {p.oems?.length > 0 ? (
                      p.oems.map((o: any, j: number) => (
                        <span
                          key={j}
                          className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-black text-indigo-700"
                        >
                          {o.oem_name}
                        </span>
                      ))
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )}
</div>

      {/* Products / BOQ from Step1 */}
 
     {(step3 || (!isWorkingsAction && (step4 || step5))) && (
  <div className="grid grid-cols-3 gap-3">
    {step3 && (
      <SectionCard title="Tab 3 — Workings" icon={Layers} color="indigo" noPad>
        <div className="p-3 space-y-3">
          {(step3.corrigendum_document || step3.workings_document) && (
            <div className="flex flex-wrap gap-2">
              {step3.corrigendum_document && (
                <DocChip
                  doc={makeDoc(step3.corrigendum_document, 'Corrigendum')}
                  onClick={() => onPreview(makeDoc(step3.corrigendum_document, 'Corrigendum'))}
                />
              )}
              {step3.workings_document && (
                <DocChip
                  doc={makeDoc(step3.workings_document, 'Workings')}
                  onClick={() => onPreview(makeDoc(step3.workings_document, 'Workings'))}
                />
              )}
            </div>
          )}

          {step3.final_products?.length > 0 && (
            <div className="overflow-x-auto border border-gray-100 rounded-lg">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="px-3 py-2 text-left text-[11px] font-black text-gray-400 uppercase">Product</th>
                    <th className="px-3 py-2 text-right text-[11px] font-black text-gray-400 uppercase">Qty</th>
                    <th className="px-3 py-2 text-right text-[11px] font-black text-gray-400 uppercase">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {step3.final_products.map((p: any, i: number) => (
                    <tr key={i}>
                      <td className="px-3 py-2">
                        <p className="text-[14px] font-black text-gray-900">{p.product_name}</p>
                        {(p.oem_name || p.authorization_num) && (
                          <p className="text-xs text-gray-500">
                            {p.oem_name || ''}{p.authorization_num ? ` · ${p.authorization_num}` : ''}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-gray-700">{p.quantity || '—'}</td>
                      <td className="px-3 py-2 text-right font-black text-gray-900">{fmt(p.total_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="flex items-center justify-between px-3 py-2 bg-indigo-50 border-t border-indigo-100">
                <span className="text-xs font-black text-indigo-700">BOQ Total</span>
                <span className="text-sm font-black text-indigo-900">
                  {fmt(step3.final_products.reduce((s: number, p: any) => s + (Number(p.total_price) || 0), 0))}
                </span>
              </div>
            </div>
          )}
        </div>
      </SectionCard>
    )}

    {!isWorkingsAction && step4 && (
      <SectionCard title="Tab 4 — Tech Bid" icon={FileCheck} color="teal">
        <div className="space-y-3">
          <Field label="Eligibility" value={step4.tech_bid_eligible} highlight />

          {step4.bidders?.length > 0 && (
            <div>
              <p className="text-[12px] font-black text-gray-400 uppercase mb-2">
                Bidders ({step4.bidders.length})
              </p>
              <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
                {step4.bidders.map((b: any, i: number) => (
                  <div key={i} className="bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
                    <p className="text-[14px] font-black text-gray-800">{b.bidder_name}</p>
                    {b.bidder_type && <p className="text-xs text-gray-500 font-semibold">{b.bidder_type}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </SectionCard>
    )}

    {!isWorkingsAction && step5 && (
      <SectionCard title="Tab 5 — Result" icon={Award} color="emerald">
        <div className="grid grid-cols-1 gap-y-2">
          <Field label="Result" value={step5.result} highlight />
          <Field label="Result Date" value={step5.result_date} />
          {step5.bid_amount != null && <Field label="Our Bid" value={fmt(step5.bid_amount)} />}
          {step5.reverse_auction_final_bid != null && <Field label="RA Final Bid" value={fmt(step5.reverse_auction_final_bid)} />}

          {step5.result === 'Lost' && step5.loss_analysis && (
            <>
              <Field label="Competitor" value={step5.loss_analysis.competitor_name} />
              {step5.loss_analysis.competitor_amount != null && (
                <Field label="Comp. Bid" value={fmt(step5.loss_analysis.competitor_amount)} />
              )}
              <Field label="Position" value={step5.loss_analysis.our_position} />
            </>
          )}
        </div>
      </SectionCard>
    )}
  </div>
)}

      {/* Step 7 — PO Details */}
      {!isWorkingsAction && step7 && (
        <SectionCard title="Tab 6 — PO Details" icon={FileText} color="blue">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label="PO Number" value={step7.po_num} highlight />
            <Field label="PO Date" value={step7.po_date} />
            <Field label="PO Value" value={fmt(step7.po_value)} highlight />
            <Field label="No. of Consignees" value={step7.no_of_consignee ? String(step7.no_of_consignee) : undefined} />
            <Field label="Delivery Date" value={step7.dlvry_date} />
            {step7.completion_days && <Field label="Completion" value={`${step7.completion_days} days${step7.completion_date ? ` (by ${step7.completion_date})` : ''}`} />}
            {step7.wrnty_mth && <Field label="Warranty" value={`${step7.wrnty_mth} months`} />}
            <Field label="Site Engineer" value={step7.site_eng} />
            {step7.eng_phone && <Field label="Engineer Phone" value={step7.eng_phone} />}
            {step7.pmnt_terms && <Field label="Payment Terms" value={step7.pmnt_terms} span2 />}
            {step7.sow && <Field label="Scope of Work" value={step7.sow} span2 />}
            {step7.po_documents?.length > 0 && (
              <div className="col-span-2">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1.5">PO Documents</p>
                <div className="flex flex-wrap gap-2">
                  {step7.po_documents.map((doc: DocumentInfo) => (
                    <DocChip key={doc.id} doc={doc} onClick={() => onPreview(doc)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {documents?.length > 0 && (
        <SectionCard title={`All Documents (${documents.length})`} icon={FileText} color="indigo">
          <div className="flex flex-wrap gap-2">
            {documents.map((doc: DocumentInfo) => (
              <DocChip key={doc.id} doc={doc} onClick={() => onPreview(doc)} />
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  )
}

// ─── EMD/BG Summary Panel ─────────────────────────────────────────────────────

function EMDBGSummaryPanel({ data, onPreview, onGo }: { data: any; onPreview: (doc: DocumentInfo) => void; onGo?: (to: string) => void }) {
  // Tender No. → the tender page; Reference No. → the instrument in Guarantees & Deposits
  const link = (text: any, to: string | null) => to && onGo
    ? <a className="text-indigo-600 hover:underline cursor-pointer" onClick={() => onGo(to)}>{text}</a> : text
  const docInfo: DocumentInfo | null = data.instrument_document_url ? {
    id: 0, doc_type: data.instrument_type || 'Instrument',
    file_name: data.instrument_document_url.split('/').pop() || 'Document',
    file_path: data.instrument_document_url, preview_url: data.instrument_document_url,
    file_url: data.instrument_document_url, file_size_kb: data.instrument_file_size_kb,
    uploaded_at: null,
  } : null

  return (
    <div className="space-y-3">
      {/* Slim hero */}
      <div className="flex items-center gap-3 px-4 py-3 bg-teal-50 border border-teal-100 rounded-xl">
        <IndianRupee size={16} className="text-teal-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-black text-gray-900">{data.instrument_type}</p>
          <p className="text-xs text-teal-600 font-semibold">{data.client_name || ''}</p>
        </div>
        <div className="text-right shrink-0 pl-3 border-l border-teal-200">
          <p className="text-[10px] text-teal-500 font-bold uppercase">Amount</p>
          <p className="text-base font-black text-teal-900">{fmt(data.amount)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <SectionCard title="Client & Tender" icon={Building2} color="orange">
          <div className="grid grid-cols-1 gap-y-3">
            {data.client_name && <Field label="Client" value={data.client_name} highlight />}
            {data.tender_num && <Field label="Tender No." value={link(data.tender_num, data.tender_id ? `/tenders/${data.tender_id}` : null)} />}
            {data.tender_title && <Field label="Tender Title" value={data.tender_title} />}
            {data.po_number && <Field label="PO Number" value={data.po_number} />}
            {data.po_date && <Field label="PO Date" value={data.po_date} />}
            {data.wo_value != null && <Field label="WO Value" value={fmt(data.wo_value)} />}
          </div>
        </SectionCard>

        <SectionCard title="Instrument Details" icon={IndianRupee} color="teal">
          <div className="grid grid-cols-1 gap-y-3">
            <Field label="Reference No." value={link(data.reference_num, data.id ? `/emdbg?open=${data.id}` : null)} highlight />
            {data.bank_name && <Field label="Bank" value={data.bank_name + (data.bank_branch ? ` — ${data.bank_branch}` : '')} />}
            {data.instrument_number && <Field label="Instr. No." value={data.instrument_number} />}
            {data.issued_date && <Field label="Issued Date" value={data.issued_date} />}
            {data.submitted_date && <Field label="Submitted" value={data.submitted_date} />}
            <Field label="Expiry Date" value={data.expiry_date} highlight />
            <Field label="Status" value={data.status} />
          </div>
        </SectionCard>
      </div>

      {docInfo && (
        <div>
          <p className="text-xs font-bold text-gray-600 mb-2">Instrument Document</p>
          <DocChip doc={docInfo} onClick={() => onPreview(docInfo)} />
        </div>
      )}
    </div>
  )
}

// ─── Decision Modal ───────────────────────────────────────────────────────────

function DecisionModal({ approval, onClose, onDecide }: {
  approval: ApprovalItem | null
  onClose: () => void
  onDecide: (approval: ApprovalItem, decision: 'approved' | 'rejected', notes: string) => Promise<void>
}) {
  const navigate = useNavigate()
  const [notes,          setNotes]    = useState('')
  const [loading,        setLoading]  = useState(false)
  const [loadingSummary, setLS]       = useState(false)
  const [summary,        setSummary]  = useState<any>(null)
  const [previewFile,    setPreviewFile] = useState<DocumentInfo | null>(null)

  useEffect(() => {
    if (!approval) return
    setNotes(''); setSummary(null)
    if (approval.kind === 'dynamic') {
      setSummary(approval.summary || null)
      setLS(false)
      return
    }
    setLS(true)
    api.get(`/approvals/${approval.id}/summary`)
      .then(r => setSummary(r.data?.summary || null))
      .catch(e => console.error('Summary load failed', e))
      .finally(() => setLS(false))
  }, [approval?.id, approval?.kind, approval?.summary])

  if (!approval) return null

  const decide = async (d: 'approved' | 'rejected') => {
    if (d === 'rejected' && !notes.trim()) { alert('Please provide a reason for rejection.'); return }
    setLoading(true)
    try { await onDecide(approval, d, notes); onClose() }
    finally { setLoading(false) }
  }

  const MODULE_ICONS: Record<string, React.ReactNode> = {
    customer: <Building2    size={18} className="text-white" />,
    travel:   <Plane        size={18} className="text-white" />,
    tada:     <Receipt      size={18} className="text-white" />,
    tender:   <FileText     size={18} className="text-white" />,
    lead:     <DollarSign   size={18} className="text-white" />,
    emdbg:    <IndianRupee  size={18} className="text-white" />,
  }

const MODULE_META: Record<string, { gradient: string; iconBg: string; border: string }> = {
  customer: {
    gradient: 'bg-[#9DB8AE]',
    iconBg: 'bg-[#86A69A]',
    border: 'border-[#78998C]',
  },
  travel: {
    gradient: 'bg-[#A8B79A]',
    iconBg: 'bg-[#91A584]',
    border: 'border-[#809574]',
  },
  tada: {
    gradient: 'bg-[#B7A7C8]',
    iconBg: 'bg-[#A292B8]',
    border: 'border-[#8F80A6]',
  },
  tender: {
    gradient: 'bg-[#D7A18E]',
    iconBg: 'bg-[#C98D78]',
    border: 'border-[#B97A65]',
  },
  lead: {
    gradient: 'bg-[#C4A98B]',
    iconBg: 'bg-[#B59673]',
    border: 'border-[#A68461]',
  },
  emdbg: {
    gradient: 'bg-[#9FB995]',
    iconBg: 'bg-[#89A77E]',
    border: 'border-[#77966B]',
  },
}

const meta = MODULE_META[approval.module] || {
  gradient: 'bg-[#B8B8B0]',
  iconBg: 'bg-[#A8A89F]',
  border: 'border-[#96968C]',
}
  const statusLabel  = approval.approval_display || `${approval.status.charAt(0).toUpperCase()}${approval.status.slice(1)}`
  const typeLabel    = approval.type_label || ACTION_FULL_LABEL[approval.action] || approval.action_label || approval.action
  const headerStamp  = formatHeaderStamp(approval.decided_at || approval.created_at)
  const customerName = summary?.company_name || summary?.customer_name || summary?.employee_name || summary?.client_name || null
  const purpose      = summary?.purpose || summary?.title || summary?.lead_title || summary?.instrument_type || null
  const requestNotes = buildLeadConversionRequestNotes(approval, summary)

  return (
    <>
      {previewFile && <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}

      <div className="fixed inset-y-0 right-0 z-[80] bg-gray-50 flex flex-col overflow-hidden"
           style={{ left: 'var(--sidebar-w, 60px)' }}>

        {/* Header */}
<div className={`${meta.gradient} relative overflow-hidden shrink-0 border-b ${meta.border}`}><div className="relative flex items-center gap-3 px-5 py-2.5">            <button onClick={onClose} className="shrink-0">
<div className="w-9 h-9 rounded-xl bg-black/10 hover:bg-black/15 border border-black/10 flex items-center justify-center transition-colors">                <X size={18} className="text-white/80" />
              </div>
            </button>
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className={`w-10 h-10 rounded-xl ${meta.iconBg} border ${meta.border} flex items-center justify-center shrink-0`}>
                {MODULE_ICONS[approval.module] || <FileText size={18} className="text-white" />}
              </div>
              <div className="min-w-0">
                <p className="text-white/70 text-xs font-bold uppercase tracking-widest truncate">{typeLabel}</p>
<h1 className="text-white font-black text-base leading-tight truncate">{approvalRecordRoute(approval)
  ? <a className="hover:underline cursor-pointer" title="Open the record" onClick={() => { const to = approvalRecordRoute(approval); if (to) { onClose(); navigate(to) } }}>{approval.record_ref}</a>
  : approval.record_ref}</h1>             </div>
            </div>
            <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border shrink-0 ${
              approval.status === 'approved' ? 'bg-emerald-400/20 text-emerald-100 border-emerald-300/30' :
              approval.status === 'rejected' ? 'bg-red-400/20 text-red-100 border-red-300/30' :
              'bg-amber-400/20 text-amber-100 border-amber-300/30'
            }`}>
              {approval.status === 'approved' && <CheckCircle size={12} />}
              {approval.status === 'rejected' && <XCircle size={12} />}
              {approval.status === 'pending'  && <Clock size={12} />}
              {statusLabel}
            </span>
          </div>
<div className="relative flex items-center gap-5 px-5 pb-2 flex-wrap">            <span className="text-white/60 text-xs font-semibold flex items-center gap-1.5">
              <User size={11} />Requested by <span className="text-white/90 font-bold ml-1">{approval.requested_by_name}</span>
            </span>
            {customerName && (
              <span className="text-white/60 text-xs font-semibold flex items-center gap-1.5">
                <Building2 size={11} /><span className="text-white/90 font-bold">{customerName}</span>
              </span>
            )}
            {purpose && (
              <span className="text-white/60 text-xs font-semibold flex items-center gap-1.5 truncate max-w-xs">
                <Tag size={11} /><span className="text-white/80 truncate">{purpose}</span>
              </span>
            )}
            <span className="text-white/40 text-xs font-semibold ml-auto shrink-0">
              {headerStamp}
            </span>
          </div>
          <div className="relative px-5 pb-2">
            <ApprovalDecisionDetails approval={approval} light compact maxItems={4} />
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">
<div className="w-full max-w-[1650px] mx-auto px-4 py-3 space-y-3">
            {/* Request notes card */}
            {requestNotes && (
              <div className="flex items-start gap-2.5 bg-white border border-gray-100 rounded-xl px-3 py-2.5">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center shrink-0 mt-0.5">
                  <User size={14} className="text-indigo-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-gray-900">Requested by <span className="text-indigo-700">{approval.requested_by_name}</span></p>
                  <p className="text-sm text-gray-600 mt-0.5 leading-relaxed font-medium">{requestNotes}</p>
                  <p className="text-xs text-gray-400 font-semibold mt-1">{new Date(approval.created_at).toLocaleString('en-IN')}</p>
                </div>
              </div>
            )}

            {/* Loading */}
            {loadingSummary && (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <div className="w-12 h-12 rounded-2xl bg-indigo-50 flex items-center justify-center">
                  <Loader2 size={22} className="animate-spin text-indigo-500" />
                </div>
                <p className="text-sm text-gray-500 font-semibold">Loading details…</p>
              </div>
            )}

            {/* Summary panels */}
            {!loadingSummary && summary?.type === 'travel'    && <TravelSummaryPanel data={summary} />}
            {!loadingSummary && summary?.type === 'tada'      && <TADASummaryPanel data={summary} onPreview={setPreviewFile} />}
            {!loadingSummary && summary?.type === 'tender'    && <TenderSummaryPanel data={summary} onPreview={setPreviewFile} action={approval.action} />}
            {!loadingSummary && summary?.type === 'lead'      && <LeadSummaryPanel data={summary} />}
            {!loadingSummary && summary?.type === 'customer'  && <CustomerSummaryPanel data={summary} />}
            {!loadingSummary && summary?.type === 'emdbg'     && <EMDBGSummaryPanel data={summary} onPreview={setPreviewFile} onGo={to => { onClose(); navigate(to) }} />}
            {!loadingSummary && summary?.type === 'quotation' && <QuotationSummaryPanel data={summary} />}
            <TenderTimeline items={summary?.tender_timeline} approval={approval} />

            {/* Notes / Comments */}
            <div className="bg-white border border-gray-100 rounded-xl p-4">
              <label className="flex items-center gap-2 text-sm font-bold text-gray-700 mb-3">
                <FileText size={14} className="text-gray-400" />
                Notes / Comments
                {approval.status === 'pending' && (
                  <span className="text-red-500 text-xs font-semibold ml-1">· required for rejection</span>
                )}
              </label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={3}
                disabled={approval.status !== 'pending'}
                placeholder="Add your notes or reason for decision…"
                className="w-full px-4 py-3 text-sm font-medium border border-gray-200 rounded-xl resize-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 outline-none disabled:bg-gray-50 disabled:text-gray-500 transition-all placeholder:text-gray-400 placeholder:font-normal"
              />
              {approval.status !== 'pending' && approval.decision_notes && (
                <p className="text-sm text-gray-600 font-medium mt-2 flex items-start gap-2">
                  <AlertCircle size={14} className="text-gray-400 mt-0.5 shrink-0" />{approval.decision_notes}
                </p>
              )}
            </div>

            <div className="h-4" />
          </div>
        </div>

        {/* Sticky footer */}
        <div className="shrink-0 border-t border-gray-200 bg-white">
          <div className="w-full max-w-[1280px] mx-auto px-4 py-3">
            {approval.status === 'pending' ? (
              <div className="space-y-2">
                <ApprovalDecisionDetails approval={approval} compact maxItems={3} />
                <div className="flex gap-3">
                  <button onClick={onClose} disabled={loading}
                          className="px-6 py-2.5 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 font-bold text-sm transition-colors disabled:opacity-50">
                    Cancel
                  </button>
                  <button onClick={() => decide('rejected')} disabled={loading}
                          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 border-red-200 bg-red-50 text-red-600 hover:bg-red-100 hover:border-red-300 font-bold text-sm transition-all disabled:opacity-50">
                    <XCircle size={16} />Reject
                  </button>
                  <button onClick={() => decide('approved')} disabled={loading}
                          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm shadow-sm shadow-emerald-200 transition-all disabled:opacity-50">
                    {loading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle size={16} />}
                    Approve
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <div className={`flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-sm ${
                  approval.status === 'approved'
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    : 'bg-red-50 text-red-800 border border-red-200'
                }`}>
                  {approval.status === 'approved'
                    ? <><CheckCircle size={15} />{approval.approval_display || 'Approved'}</>
                    : <><XCircle size={15} />{approval.approval_display || 'Rejected'}</>}
                </div>
                <ApprovalDecisionDetails approval={approval} compact maxItems={4} />
                <button onClick={onClose} className="ml-auto px-6 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 font-bold transition-colors">
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Approval Card ────────────────────────────────────────────────────────────

function ApprovalCard({ approval, onOpen, isHistory, inGroup = false }: {
  approval: ApprovalItem; onOpen: (a: ApprovalItem) => void; isHistory: boolean; inGroup?: boolean
}) {
  const statusStyles: Record<string, string> = {
    pending:  'bg-amber-100 text-amber-800 border border-amber-200',
    approved: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
    rejected: 'bg-red-100 text-red-800 border border-red-200',
  }
  const MODULE_ICONS: Record<string, React.ReactNode> = {
    customer: <Building2   size={16} className="text-sky-600" />,
    travel:   <Plane       size={16} className="text-blue-600" />,
    tada:     <Receipt     size={16} className="text-indigo-600" />,
    tender:   <FileText    size={16} className="text-orange-600" />,
    lead:     <DollarSign  size={16} className="text-violet-600" />,
    emdbg:    <IndianRupee size={16} className="text-teal-600" />,
  }
  const MODULE_BG: Record<string, string> = {
    customer: 'bg-sky-50 border-sky-100', travel: 'bg-blue-50 border-blue-100',
    tada: 'bg-indigo-50 border-indigo-100', tender: 'bg-orange-50 border-orange-100',
    lead: 'bg-violet-50 border-violet-100', emdbg: 'bg-teal-50 border-teal-100',
  }
  const typeLabel = approvalTypeLabel(approval, inGroup)
  const badgeColor  = ACTION_BADGE_COLOR[approval.action] || 'bg-gray-100 text-gray-700 border-gray-200'
  const statusLabel = approval.approval_display || `${approval.status.charAt(0).toUpperCase()}${approval.status.slice(1)}`
  const summary     = approval.summary
  const customerName = summary?.company_name || summary?.customer_name || summary?.employee_name || null
  const purpose      = summary?.purpose || summary?.title || null

  return (
    <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3.5 flex items-start gap-3.5 hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer group"
         onClick={() => onOpen(approval)}>
      <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 mt-0.5 ${MODULE_BG[approval.module] || 'bg-indigo-50 border-indigo-100'}`}>
        {MODULE_ICONS[approval.module] || <FileText size={16} className="text-indigo-600" />}
      </div>
      <div className="flex-1 min-w-0">
        <span className={`inline-flex items-center text-[11px] font-bold px-2 py-0.5 rounded-md border mb-1.5 ${badgeColor}`}>
          {typeLabel}
        </span>
        <p className="text-sm font-black text-gray-900 truncate leading-snug">{approval.record_ref}</p>
        {customerName && (
          <p className="text-xs text-gray-700 font-semibold mt-1 flex items-center gap-1">
            <Building2 size={11} className="text-gray-400 shrink-0" />{customerName}
          </p>
        )}
        {purpose && (
          <p className="text-xs text-gray-500 font-medium mt-0.5 truncate flex items-center gap-1">
            <Tag size={10} className="text-gray-400 shrink-0" />{purpose}
          </p>
        )}
        <p className="text-xs text-gray-400 font-medium mt-1 flex items-center gap-1">
          <User size={10} className="shrink-0" />
          {approval.requested_by_name}
          <span className="text-gray-300 mx-0.5">·</span>
          {new Date(approval.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1.5 shrink-0 mt-0.5">
        <span className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full ${statusStyles[approval.status]}`}>
          {approval.status === 'approved' && <CheckCircle size={11} />}
          {approval.status === 'rejected' && <XCircle size={11} />}
          {approval.status === 'pending'  && <Clock size={11} />}
          {statusLabel}
        </span>
        <ChevronRight size={14} className="text-gray-300 group-hover:text-indigo-400 transition-colors mt-1" />
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ApprovalsPage() {
  const { label: approvalLabel } = useModuleName('approvals')
  const { success, error: showError } = useToast()
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore()

  const [tab,        setTab]       = useState<ApprovalTab>('pending')
  const [pending,    setPending]   = useState<ApprovalItem[]>([])
  const [history,    setHistory]   = useState<ApprovalItem[]>([])
  const [loading,    setLoading]   = useState(false)
  const [histPage,   setHistPage]  = useState(1)
  const [histTotal,  setHistTotal] = useState(0)
  const [selected,   setSelected]  = useState<ApprovalItem | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [filters,    setFilters]   = useState<ApprovalFilters>(() => ({ ...EMPTY_APPROVAL_FILTERS }))
  const sidebarWasCollapsed = React.useRef(false)

  const activeItems = tab === 'pending' ? pending : history
  const filterOptions = useMemo(() => approvalFilterOptions(activeItems), [activeItems])
  const activeFilterCount = useMemo(() => countActiveApprovalFilters(filters, tab), [filters, tab])
  const filteredPending = useMemo(
    () => pending.filter(item => matchesApprovalFilters(item, filters, 'pending')),
    [pending, filters],
  )
  const filteredHistory = useMemo(
    () => history.filter(item => matchesApprovalFilters(item, filters, 'history')),
    [history, filters],
  )
  const moduleOptions = useMemo(() => {
    if (filters.module === 'all' || filterOptions.modules.some(option => option.value === filters.module)) {
      return filterOptions.modules
    }
    return [{ value: filters.module, label: approvalModuleLabel(filters.module) }, ...filterOptions.modules]
  }, [filterOptions.modules, filters.module])
  const filtersActive = activeFilterCount > 0

  const updateFilter = <K extends keyof ApprovalFilters,>(key: K, value: ApprovalFilters[K]) => {
    setFilters(current => ({ ...current, [key]: value }))
  }

  const clearFilters = () => setFilters({ ...EMPTY_APPROVAL_FILTERS })

  const openApproval = (approval: ApprovalItem) => {
    sidebarWasCollapsed.current = sidebarCollapsed
    if (!sidebarCollapsed) setSidebarCollapsed(true)
    setSelected(approval)
  }
  const closeApproval = () => {
    if (!sidebarWasCollapsed.current) setSidebarCollapsed(false)
    setSelected(null)
  }

  const fetchPending = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); else setRefreshing(true)
    try {
      const [legacyResult, dynamicResult] = await Promise.allSettled([
        api.get('/approvals/pending', silent ? withPassiveSessionActivity({}) : undefined),
        approvalWorkflowApi.listPendingRequests(),
      ])
      const legacyItems  = legacyResult.status  === 'fulfilled' ? (legacyResult.value.data?.items  || []).map((i: ApprovalItem) => ({ ...i, kind: 'legacy'  as const })) : []
      const dynamicItems = dynamicResult.status === 'fulfilled' ? (dynamicResult.value.data         || []).map((i: ApprovalItem) => ({ ...i, kind: 'dynamic' as const })) : []
      if (legacyResult.status === 'rejected' && dynamicResult.status === 'rejected') throw legacyResult.reason || dynamicResult.reason
      setPending([...legacyItems, ...dynamicItems].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()))
    } catch { showError('Failed to load pending approvals') }
    finally { setLoading(false); setRefreshing(false) }
  }, [])

  const fetchHistory = useCallback(async (page = 1) => {
    setLoading(true)
    try {
      const [legacyResult, dynamicResult] = await Promise.allSettled([
        api.get(`/approvals/history?page=${page}&per_page=${APPROVAL_HISTORY_PAGE_SIZE}`),
        approvalWorkflowApi.listHistory({ page, per_page: APPROVAL_HISTORY_PAGE_SIZE }),
      ])
      const legacyItems: ApprovalItem[]  = legacyResult.status  === 'fulfilled' ? (legacyResult.value.data?.items  || []).map((i: ApprovalItem) => ({ ...i, kind: 'legacy'  as const })) : []
      const dynamicItems: ApprovalItem[] = dynamicResult.status === 'fulfilled' ? (dynamicResult.value.data?.items || []).map((i: ApprovalItem) => ({ ...i, kind: 'dynamic' as const })) : []
      const merged = [...legacyItems, ...dynamicItems].sort((a, b) => {
        const da = a.decided_at || a.created_at; const db = b.decided_at || b.created_at
        return new Date(db).getTime() - new Date(da).getTime()
      })
      setHistory(merged)
      setHistTotal((legacyResult.status === 'fulfilled' ? legacyResult.value.data?.total || 0 : 0) + (dynamicResult.status === 'fulfilled' ? dynamicResult.value.data?.total || 0 : 0))
      setHistPage(page)
    } catch { showError('Failed to load history') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchPending() }, [fetchPending])
  useEffect(() => { if (tab === 'history') fetchHistory(1) }, [tab])
  useEffect(() => {
    if (tab === 'pending' && filters.status !== 'all') {
      setFilters(current => ({ ...current, status: 'all' }))
    }
  }, [tab, filters.status])
  useEffect(() => {
    const t = setInterval(() => { if (tab === 'pending') fetchPending(true) }, 60000)
    return () => clearInterval(t)
  }, [tab, fetchPending])

  const handleDecide = async (approval: ApprovalItem, decision: 'approved' | 'rejected', notes: string) => {
    try {
      if (approval.kind === 'dynamic') {
        const r = await approvalWorkflowApi.decideRequest(approval.id, { decision, remarks: notes })
        if (r.data?.error) throw new Error(r.data.error)
        success(decision === 'approved' ? (r.data?.status === 'pending' ? 'Step approved and moved to the next approver' : 'Approved successfully') : 'Rejected - requester will be notified')
      } else {
        const r = await api.post(`/approvals/${approval.id}/decide`, { decision, notes })
        if (r.data?.error) throw new Error(r.data.error)
        success(decision === 'approved' ? 'Approved successfully' : 'Rejected - requester will be notified')
      }
      fetchPending()
      if (tab === 'history') fetchHistory(histPage)
    } catch (error) {
      showError(getApprovalErrorMessage(error))
      throw error
    }
  }

  const groups = filteredPending.reduce<Record<string, ApprovalItem[]>>((acc, a) => {
    const key = approvalModuleLabel(a.module)
    if (!acc[key]) acc[key] = []
    acc[key].push(a)
    return acc
  }, {})

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-6">
        <PageHeader
          title={approvalLabel}
          subtitle={`Review and decide on pending ${approvalLabel.toLowerCase()} requests`}
          actions={
            <button onClick={() => fetchPending(true)}
                    className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors">
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            </button>
          }
        />
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-6 pt-2 border-b border-gray-100">
        {(['pending', 'history'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
                  className={`px-5 py-2.5 text-sm font-bold rounded-t-xl transition-colors border-b-2 -mb-px outline-none focus-visible:ring-2 focus-visible:ring-indigo-100 ${
                    tab === t
                      ? 'border-indigo-500 text-indigo-700 bg-indigo-50/60'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                  }`}>
            {t === 'pending' ? (
              <>Pending{' '}
                {pending.length > 0 && (
                  <span className="ml-1.5 bg-red-500 text-white text-xs px-2 py-0.5 rounded-full font-bold">{pending.length}</span>
                )}
              </>
            ) : 'History'}
          </button>
        ))}
      </div>

      {/* Control bar */}
      <div className="px-6 pt-3">
        <div className="rounded-xl border border-gray-100 bg-white px-2.5 py-2 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[280px] flex-1">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  value={filters.search}
                  onChange={event => updateFilter('search', event.target.value)}
                  placeholder="Search approvals"
                  className={`h-9 w-full rounded-xl border pl-9 pr-3 text-xs font-semibold outline-none transition focus:border-blue-400 ${
                    filters.search.trim() ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-600'
                  }`}
                />
              </div>

              <select
                value={filters.module}
                onChange={event => updateFilter('module', event.target.value)}
                className={`h-9 w-[200px] flex-none rounded-xl border px-2.5 py-1.5 text-xs font-semibold outline-none transition focus:border-blue-400 ${
                  filters.module !== 'all' ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700'
                }`}
              >
                <option value="all">All modules</option>
                {moduleOptions.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>

              {tab === 'history' ? (
                <select
                  value={filters.status}
                  onChange={event => updateFilter('status', event.target.value as ApprovalStatusFilter)}
                  className={`h-9 w-[155px] flex-none rounded-xl border px-2.5 py-1.5 text-xs font-semibold outline-none transition focus:border-blue-400 ${
                    filters.status !== 'all' ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-700'
                  }`}
                >
                  <option value="all">All statuses</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              ) : null}

              <div className={`relative h-9 w-[140px] flex-none rounded-xl border transition ${
                filters.dateFrom ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-500'
              }`}>
                <input
                  type="date"
                  value={filters.dateFrom}
                  max={filters.dateTo || undefined}
                  onChange={event => updateFilter('dateFrom', event.target.value)}
                  aria-label="Start date"
                  title="Start date"
                  className="h-full w-full bg-transparent px-2.5 py-1.5 text-xs font-semibold outline-none"
                />
              </div>

              <div className={`relative h-9 w-[140px] flex-none rounded-xl border transition ${
                filters.dateTo ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-500'
              }`}>
                <input
                  type="date"
                  value={filters.dateTo}
                  min={filters.dateFrom || undefined}
                  onChange={event => updateFilter('dateTo', event.target.value)}
                  aria-label="End date"
                  title="End date"
                  className="h-full w-full bg-transparent px-2.5 py-1.5 text-xs font-semibold outline-none"
                />
              </div>

              <button
                type="button"
                onClick={clearFilters}
                disabled={!filtersActive}
                className="inline-flex h-9 w-[58px] flex-none items-center justify-center gap-1 rounded-lg px-2 text-xs font-semibold text-gray-400 transition hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400"
              >
                <X size={12} />
                Reset
              </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={28} className="animate-spin text-indigo-400" />
          </div>
        )}

        {!loading && tab === 'pending' && (
          pending.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center mb-4"><CheckCircle size={28} className="text-emerald-500" /></div>
              <p className="text-base font-black text-gray-800">All caught up!</p>
              <p className="text-sm text-gray-500 font-semibold mt-1">No pending approvals.</p>
            </div>
          ) : filteredPending.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-50">
                <Search size={26} className="text-indigo-400" />
              </div>
              <p className="text-base font-black text-gray-800">No matching approvals</p>
              <p className="mt-1 text-sm font-semibold text-gray-500">Try a different module, date range, or search term.</p>
            </div>
          ) : (
            Object.entries(groups).map(([module, items]) => (
              <div key={module} className="mb-7">
                <div className="flex items-center gap-2.5 mb-3 px-1">
                  <span className="text-xs font-black text-gray-400 uppercase tracking-widest">{module}</span>
                  <div className="flex-1 h-px bg-gray-100" />
                  <span className="bg-indigo-100 text-indigo-700 text-xs font-black px-2.5 py-0.5 rounded-full">{items.length}</span>
                </div>
                <div className="space-y-2.5">
                  {items.map(a => (
                    <ApprovalCard key={`${a.kind || 'legacy'}-${a.id}`} approval={a} onOpen={openApproval} isHistory={false} inGroup />
                  ))}
                </div>
              </div>
            ))
          )
        )}

        {!loading && tab === 'history' && (
          history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="w-16 h-16 rounded-2xl bg-gray-50 flex items-center justify-center mb-4"><Clock size={28} className="text-gray-400" /></div>
              <p className="text-gray-600 text-sm font-bold">No approval history yet.</p>
            </div>
          ) : filteredHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-50">
                <Search size={26} className="text-indigo-400" />
              </div>
              <p className="text-base font-black text-gray-800">No matching history</p>
              <p className="mt-1 text-sm font-semibold text-gray-500">Adjust the filters to find older decisions.</p>
            </div>
          ) : (
            <>
              <div className="space-y-2.5 mb-5">
                {filteredHistory.map(a => (
                  <ApprovalCard key={`${a.kind || 'legacy'}-${a.id}`} approval={a} onOpen={openApproval} isHistory />
                ))}
              </div>
              {histTotal > APPROVAL_HISTORY_PAGE_SIZE && (
                <div className="flex items-center justify-center gap-3 mt-4">
                  <button disabled={histPage === 1} onClick={() => fetchHistory(histPage - 1)}
                          className="px-4 py-2 text-sm font-semibold rounded-xl border border-gray-200 hover:bg-gray-50 disabled:opacity-40 text-gray-700">Previous</button>
                  <span className="text-sm text-gray-600 font-bold px-2">Page {histPage} of {Math.ceil(histTotal / APPROVAL_HISTORY_PAGE_SIZE)}</span>
                  <button disabled={histPage >= Math.ceil(histTotal / APPROVAL_HISTORY_PAGE_SIZE)} onClick={() => fetchHistory(histPage + 1)}
                          className="px-4 py-2 text-sm font-semibold rounded-xl border border-gray-200 hover:bg-gray-50 disabled:opacity-40 text-gray-700">Next</button>
                </div>
              )}
            </>
          )
        )}
      </div>

      <DecisionModal approval={selected} onClose={closeApproval} onDecide={handleDecide} />
    </div>
  )
}
