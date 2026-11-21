/**
 * QuestionnaireInsightModal.tsx — informative drill-down popup for the five
 * questionnaire report types in the Report Engine. Replaces the generic
 * "navigate to another flat report" drilldown with an in-place, purpose-built
 * view: stat tiles + a distribution chart for aggregate rows (adoption /
 * section / question), and a full read-only Q&A summary for a customer row.
 * Chrome (portal overlay, maximize/minimize, close) mirrors
 * reports/shared/ListDrilldownModal.tsx for visual consistency.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import {
  Maximize2,
  Minimize2,
  X,
  ChevronLeft,
  ChevronDown,
  Loader2,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Paperclip,
  RotateCcw,
  Download,
} from 'lucide-react'

import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

import {
  DataTable,
  type Column,
} from '@/components/ui/DataTable'

import {
  reportEngineApi,
  type ReportResult,
} from '@/services/reportEngineApi'

import { questionnaireApi } from '@/services/api'

import { UserQuestionnaireExportDialog } from './UserQuestionnaireExportDialog'

import type { QElement } from '@/pages/questionnaire/QuestionnaireAnswerField'

import {
  buildFilePreviewUrl,
  isYesNoAnswerType,
} from '@/pages/questionnaire/questionnaireFormShared'


export type QuestionnaireInsightMode =
  | 'role'
  | 'user'
  | 'adoption'
  | 'section'
  | 'question'
  | 'customer'


export interface QuestionnaireInsightRequest {
  mode: QuestionnaireInsightMode
  row: Record<string, unknown>
}


type Screen = QuestionnaireInsightRequest & {
  key: string
}


// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

const fmtNum = (v: unknown) => {
  const n = Number(v)

  return Number.isFinite(n)
    ? n.toLocaleString('en-IN')
    : '—'
}


const fmtPct = (v: unknown) => {
  const n = Number(v)

  return Number.isFinite(n)
    ? `${n}%`
    : '—'
}


const fmtDate = (v: unknown) => {
  if (!v) return '—'

  const d = new Date(String(v))

  return Number.isNaN(d.getTime())
    ? String(v)
    : d.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
}


// ─────────────────────────────────────────────────────────────────────────────
// Small presentational helpers
// ─────────────────────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  tone = 'slate',
}: {
  label: string
  value: ReactNode
  tone?: 'slate' | 'emerald' | 'indigo' | 'amber' | 'rose'
}) {
  const toneCls: Record<string, string> = {
    slate: 'bg-slate-50 text-slate-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
  }

  return (
    <div
      className={`rounded-xl border border-slate-200 p-3 ${toneCls[tone]}`}
    >
      <div className="text-[10px] font-bold uppercase tracking-wide opacity-70">
        {label}
      </div>

      <div className="mt-1 truncate text-[17px] font-bold">
        {value ?? '—'}
      </div>
    </div>
  )
}


const STATUS_PILL: Record<string, string> = {
  not_started: 'bg-gray-100 text-gray-600 border-gray-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-200',
  completed: 'bg-green-50 text-green-700 border-green-200',
  reopened: 'bg-blue-50 text-blue-700 border-blue-200',
}


const STATUS_LABEL: Record<string, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  completed: 'Completed',
  reopened: 'Reopened',
}


function StatusPill({
  status,
}: {
  status: string
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
        STATUS_PILL[status] || STATUS_PILL.not_started
      }`}
    >
      {STATUS_LABEL[status] || status}
    </span>
  )
}


function AnswerBadge({
  value,
  inputType,
}: {
  value: string | null | undefined
  inputType?: string
}) {
  if (value == null || value === '') {
    return (
      <span className="text-slate-400">
        —
      </span>
    )
  }

  if (inputType && isYesNoAnswerType(inputType)) {
    const v = value.trim().toLowerCase()

    if (v === 'yes') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
          <CheckCircle2 size={12} />
          Yes
        </span>
      )
    }

    if (v === 'no') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
          <XCircle size={12} />
          No
        </span>
      )
    }

    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
        <MinusCircle size={12} />
        {value}
      </span>
    )
  }

  return (
    <span className="break-words">
      {value}
    </span>
  )
}


function LoadingBox() {
  return (
    <div className="flex h-40 items-center justify-center gap-2 text-sm text-slate-400">
      <Loader2
        size={16}
        className="animate-spin"
      />

      Loading…
    </div>
  )
}


function ErrorBox({
  message,
}: {
  message: string
}) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-600">
      {message}
    </div>
  )
}


function normalizePositiveId(
  value: unknown,
): number | null {
  const id = Number(value)

  return Number.isInteger(id) && id > 0
    ? id
    : null
}


function resolveCustomerId(
  row: Record<string, unknown>,
): number | null {
  const nestedCustomer = row.customer

  const nestedCustomerId =
    nestedCustomer &&
    typeof nestedCustomer === 'object'
      ? (nestedCustomer as Record<string, unknown>).id
      : null

  return (
    normalizePositiveId(row.customer_id) ||
    normalizePositiveId(row.customerId) ||
    normalizePositiveId(row.customerID) ||
    normalizePositiveId(nestedCustomerId)
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// Count donut
// ─────────────────────────────────────────────────────────────────────────────

function CountDonut({
  segments,
}: {
  segments: {
    name: string
    value: number
    color: string
  }[]
}) {
  const [active, setActive] = useState<string | null>(null)

  const total = segments.reduce(
    (sum, s) => sum + s.value,
    0,
  )

  const nonEmpty = segments.filter(
    s => s.value > 0,
  )

  if (!total || !nonEmpty.length) {
    return (
      <div className="grid h-[180px] place-items-center text-xs text-slate-400">
        No data to chart
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="relative h-[180px] w-[180px] shrink-0">

        <ResponsiveContainer
          width="100%"
          height="100%"
        >
          <PieChart>
            <Pie
              data={nonEmpty}
              cx="50%"
              cy="50%"
              innerRadius={52}
              outerRadius={78}
              paddingAngle={2}
              dataKey="value"
              onMouseEnter={(_, i) =>
                setActive(
                  nonEmpty[i]?.name ?? null,
                )
              }
              onMouseLeave={() =>
                setActive(null)
              }
            >
              {nonEmpty.map(s => (
                <Cell
                  key={s.name}
                  fill={s.color}
                  stroke="white"
                  strokeWidth={2}
                  opacity={
                    active &&
                    active !== s.name
                      ? 0.35
                      : 1
                  }
                />
              ))}
            </Pie>

            <Tooltip
              content={({
                active: on,
                payload,
              }: any) => {
                if (
                  !on ||
                  !payload?.length
                ) {
                  return null
                }

                const item =
                  payload[0].payload

                return (
                  <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-lg">
                    <p className="font-bold text-slate-800">
                      {item.name}
                    </p>

                    <p className="text-slate-500">
                      {fmtNum(item.value)}
                      {' · '}
                      {(
                        (item.value /
                          total) *
                        100
                      ).toFixed(0)}
                      %
                    </p>
                  </div>
                )
              }}
            />
          </PieChart>
        </ResponsiveContainer>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] text-slate-400">
            Total
          </span>

          <span className="text-[16px] font-black text-slate-900">
            {fmtNum(total)}
          </span>
        </div>
      </div>

      <div className="min-w-0 flex-1 space-y-1.5">

        {segments.map(s => (
          <div
            key={s.name}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50"
            onMouseEnter={() =>
              setActive(s.name)
            }
            onMouseLeave={() =>
              setActive(null)
            }
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{
                backgroundColor: s.color,
              }}
            />

            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-slate-700">
              {s.name}
            </span>

            <span className="shrink-0 text-[12px] font-bold text-slate-800">
              {fmtNum(s.value)}
            </span>

            <span className="w-10 shrink-0 text-right text-[11px] text-slate-400">
              {total
                ? (
                    (s.value /
                      total) *
                    100
                  ).toFixed(0)
                : 0}
              %
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// Adoption screen
// ─────────────────────────────────────────────────────────────────────────────

function AdoptionScreen({
  row,
  onOpenCustomer,
}: {
  row: Record<string, unknown>
  onOpenCustomer: (
    row: Record<string, unknown>,
  ) => void
}) {
  const questionnaireId =
    row.id as number

  const [result, setResult] =
    useState<ReportResult | null>(null)

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState<string | null>(null)


  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setError(null)

    reportEngineApi
      .runAdhoc({
        report_type_key:
          'questionnaire',

        fields: [
          'id',
          'customer_id',
          'customer_name',
          'status',
          'progress_percentage',
          'completed_at',
          'last_saved_at',
        ],

        filters: [
          {
            field:
              'questionnaire_id',
            operator: 'eq',
            value:
              questionnaireId,
          },
        ],

        per_page: 200,
      })
      .then(res => {
        if (!cancelled) {
          setResult(res.data)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(
            "Could not load this questionnaire's customers",
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [questionnaireId])


  const segments = [
    {
      name: 'Completed',
      value:
        Number(
          row.completed_count,
        ) || 0,
      color: '#16a34a',
    },

    {
      name: 'In Progress',
      value:
        Number(
          row.in_progress_count,
        ) || 0,
      color: '#d97706',
    },

    {
      name: 'Not Started',
      value:
        Number(
          row.not_started_count,
        ) || 0,
      color: '#94a3b8',
    },

    {
      name: 'Reopened',
      value:
        Number(
          row.reopened_count,
        ) || 0,
      color: '#2563eb',
    },
  ]


  const columns:
    Column<
      Record<string, unknown>
    >[] = [
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,

      render: (v, r) => (
        <button
          type="button"
          onClick={() =>
            onOpenCustomer(r)
          }
          className="font-medium text-slate-800 hover:text-fuchsia-700 hover:underline"
        >
          {String(v ?? '—')}
        </button>
      ),
    },

    {
      key: 'status',
      header: 'Status',
      sortable: true,

      render: v => (
        <StatusPill
          status={String(
            v ?? 'not_started',
          )}
        />
      ),
    },

    {
      key:
        'progress_percentage',
      header: 'Progress',
      align: 'right',
      sortable: true,
      render: v => fmtPct(v),
    },

    {
      key: 'completed_at',
      header: 'Completed',
      sortable: true,
      render: v => fmtDate(v),
    },

    {
      key: 'last_saved_at',
      header: 'Last Activity',
      sortable: true,
      render: v => fmtDate(v),
    },
  ]


  return (
    <div className="space-y-5">

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">

        <StatTile
          label="Total Assigned"
          value={fmtNum(
            row.total_assigned,
          )}
        />

        <StatTile
          label="Completed"
          value={fmtNum(
            row.completed_count,
          )}
          tone="emerald"
        />

        <StatTile
          label="In Progress"
          value={fmtNum(
            row.in_progress_count,
          )}
          tone="amber"
        />

        <StatTile
          label="Completion Rate"
          value={fmtPct(
            row.completion_rate_pct,
          )}
          tone="indigo"
        />
      </div>


      <div className="rounded-xl border border-slate-200 p-4">

        <div className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-400">
          Status Distribution
        </div>

        <CountDonut
          segments={segments}
        />
      </div>


      <div>

        <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">
          Customers (
          {fmtNum(
            row.total_assigned,
          )}
          )
        </div>

        {error ? (
          <ErrorBox
            message={error}
          />
        ) : (
          <DataTable
            data={
              result?.rows ?? []
            }
            columns={columns}
            loading={loading}
            keyField="id"
            showColumnToggle={false}
          />
        )}
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// Section screen
// ─────────────────────────────────────────────────────────────────────────────

interface SectionAnswerFieldPair {
  label: string
  value: string
}

interface SectionAnswerRow {
  [key: string]: unknown
  row_id: string
  customer_id: number | null
  customer_name: string
  subsection_name: string
  question_code: string
  question_label: string
  yes_no: string
  field_details_pairs: SectionAnswerFieldPair[]
}

// Flattens the raw questionnaire_answers rows (one row per answered
// question OR dependent field, across every customer) into one row per
// customer × question, with that question's dependent fields folded into
// field_details_pairs — mirrors buildQuestionTableRows' question/field
// grouping (used by CustomerScreen for a single customer) but across every
// customer in this section/subsection at once.
function groupSectionAnswerRows(
  rows: Record<string, unknown>[],
): SectionAnswerRow[] {
  const byCustomer = new Map<
    string,
    Record<string, unknown>[]
  >()

  rows.forEach(r => {
    const key = String(
      r.customer_id ?? r.customer_name ?? '',
    )
    const list = byCustomer.get(key) || []
    list.push(r)
    byCustomer.set(key, list)
  })

  const out: SectionAnswerRow[] = []

  byCustomer.forEach(customerRows => {
    const byElementId = new Map<
      number,
      Record<string, unknown>
    >()

    customerRows.forEach(r => {
      const elementId = Number(r.element_id)
      if (Number.isFinite(elementId)) {
        byElementId.set(elementId, r)
      }
    })

    const fieldsByParent = new Map<
      number,
      Record<string, unknown>[]
    >()

    const questionRows: Record<string, unknown>[] = []

    customerRows.forEach(r => {
      const parentId = r.parent_element_id
      if (
        r.element_type === 'field' &&
        parentId !== null &&
        parentId !== undefined
      ) {
        const key = Number(parentId)
        const list = fieldsByParent.get(key) || []
        list.push(r)
        fieldsByParent.set(key, list)
      } else {
        questionRows.push(r)
      }
    })

    // Dependent field whose parent question isn't in this filtered set
    // (shouldn't normally happen — surfaced as its own row rather than
    // silently dropped).
    fieldsByParent.forEach((fields, parentId) => {
      if (!byElementId.has(parentId)) {
        questionRows.push(...fields)
      }
    })

    questionRows.forEach(q => {
      const base = {
        customer_id:
          q.customer_id != null
            ? Number(q.customer_id)
            : null,
        customer_name: String(
          q.customer_name ?? '—',
        ),
        subsection_name: String(
          q.subsection_name ?? '',
        ),
        question_code: String(
          q.question_code ?? '',
        ),
        question_label: String(
          q.question_label ?? '',
        ),
        yes_no: isYesNoAnswerType(
          String(q.input_type ?? ''),
        )
          ? String(q.answer_value ?? '')
              .trim()
              .toLowerCase() === 'yes'
            ? 'Yes'
            : String(q.answer_value ?? '')
                  .trim()
                  .toLowerCase() === 'no'
              ? 'No'
              : ''
          : '',
      }

      const fields =
        fieldsByParent.get(
          Number(q.element_id),
        ) || []

      if (!fields.length) {
        out.push({
          ...base,
          row_id: `${q.customer_id}:${q.element_id}:question`,
          field_details_pairs: [],
        })
        return
      }

      fields.forEach((field, index) => {
        const value =
          String(field.answer_value ?? '').trim() ||
          '-'

        out.push({
          ...base,
          row_id: `${q.customer_id}:${q.element_id}:field:${field.element_id}:${index}`,
          field_details_pairs: [
            {
              label: String(
                field.question_label ?? '',
              ),
              value,
            },
          ],
        })
      })
    })
  })

  return out.sort(
    (a, b) =>
      a.customer_name.localeCompare(
        b.customer_name,
      ) ||
      compareQuestionCodes(
        a.question_code,
        b.question_code,
      ),
  )
}


function SectionScreen({
  row,
  onOpenCustomer,
}: {
  row: Record<string, unknown>
  onOpenCustomer: (
    row: Record<string, unknown>,
  ) => void
}) {
  const sectionId =
    row.id as number

  // A "section" row's answers carry qfe.section_id (set on every question
  // regardless of which subsection it's under); a "subsection" row's
  // answers carry qfe.subsection_id instead — filtering by the wrong one
  // returns an empty list even though the stat tiles above (computed with
  // both cases) show a non-zero total.
  const isSubsection =
    row.structure_type ===
    'subsection'

  const [result, setResult] =
    useState<ReportResult | null>(null)

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState<string | null>(null)

  const [
    subsectionFilter,
    setSubsectionFilter,
  ] = useState('')

  const [
    yesNoFilter,
    setYesNoFilter,
  ] = useState('')


  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setError(null)
    setSubsectionFilter('')
    setYesNoFilter('')

    // questionnaire_answers is already the flat customer × question(/field)
    // × answer table — filtering it by this section's/subsection's id gives
    // every customer's answer in one shot, no per-question/per-respondent
    // hop needed. element_type/parent_element_id let groupSectionAnswerRows
    // fold each field back under its parent question.
    reportEngineApi
      .runAdhoc({
        report_type_key:
          'questionnaire_answers',

        fields: [
          'id',
          'customer_id',
          'customer_name',
          'subsection_name',
          'element_id',
          'parent_element_id',
          'element_type',
          'question_code',
          'question_label',
          'input_type',
          'answer_value',
          'remarks',
        ],

        filters: [
          {
            field: isSubsection
              ? 'subsection_id'
              : 'section_id',
            operator: 'eq',
            value: sectionId,
          },
        ],

        per_page: 500,
      })
      .then(res => {
        if (!cancelled) {
          setResult(res.data)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(
            'Could not load customer answers for this section',
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [sectionId, isSubsection])


  const groupedRows =
    groupSectionAnswerRows(
      result?.rows ?? [],
    )

  // Constant/redundant when the clicked row is itself a subsection — every
  // answer already belongs to that one subsection, so skip the filter.
  const subsectionOptions =
    isSubsection
      ? []
      : Array.from(
          new Set(
            groupedRows
              .map(r => r.subsection_name)
              .filter(Boolean),
          ),
        )

  const filteredRows =
    groupedRows.filter(
      r =>
        (!subsectionFilter ||
          r.subsection_name ===
            subsectionFilter) &&
        (!yesNoFilter ||
          r.yes_no === yesNoFilter),
    )


  const columns:
    Column<SectionAnswerRow>[] = [
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,

      render: (v, r) => (
        <button
          type="button"
          onClick={() =>
            onOpenCustomer(r)
          }
          className="text-left font-medium text-slate-800 hover:text-fuchsia-700 hover:underline"
        >
          {String(v ?? '—')}
        </button>
      ),
    },

    {
      key: 'question_code',
      header: 'Question Code',
      sortable: true,
      width: '110px',
    },

    ...(isSubsection
      ? []
      : [
          {
            key: 'subsection_name',
            header: 'Subsection',
            sortable: true,
            render: (v: unknown) =>
              String(v || '—'),
          } as Column<SectionAnswerRow>,
        ]),

    {
      key: 'question_label',
      header: 'Question',
      sortable: true,
    },

    {
      key: 'yes_no',
      header: 'Yes/No',
      sortable: true,

      render: v =>
        v ? (
          <AnswerBadge
            value={String(v)}
            inputType="yes_no"
          />
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },

    {
      key: 'field_details',
      header: 'Field Details',
      minWidth: '220px',

      render: (_v, r) => {
        const pairs = r.field_details_pairs

        if (!pairs.length) {
          return (
            <span className="text-slate-400">—</span>
          )
        }

        return (
          <div className="divide-y divide-slate-100 py-1">
            {pairs.map((pair, index) => (
              <div
                key={index}
                className="py-1.5 first:pt-0 last:pb-0"
              >
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  {pair.label}
                </div>

                <div className="mt-0.5 text-[12.5px] font-medium text-slate-700">
                  {pair.value}
                </div>
              </div>
            ))}
          </div>
        )
      },
    },
  ]


  return (
    <div className="space-y-5">

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">

        <StatTile
          label="Total Questions"
          value={fmtNum(
            row.total_questions,
          )}
        />

        <StatTile
          label="Avg. Completion"
          value={fmtPct(
            row.avg_completion_pct,
          )}
          tone="indigo"
        />

        <StatTile
          label="Fully Completed Customers"
          value={fmtNum(
            row.fully_completed_customers,
          )}
          tone="emerald"
        />
      </div>


      <div>

        <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">
          All customers — questions &amp; answers in this{' '}
          {isSubsection ? 'subsection' : 'section'}
        </div>

        {error ? (
          <ErrorBox
            message={error}
          />
        ) : (
          <DataTable
            data={filteredRows}
            columns={columns}
            loading={loading}
            keyField="row_id"
            showColumnToggle={false}
            toolbarVariant="compact"
            toolbar={
              <div className="flex flex-wrap items-center gap-2">

                {subsectionOptions.length > 0 && (
                  <select
                    value={subsectionFilter}
                    onChange={e =>
                      setSubsectionFilter(
                        e.target.value,
                      )
                    }
                    className={`h-9 w-40 truncate rounded-lg border px-2.5 text-xs font-medium outline-none transition ${
                      subsectionFilter
                        ? 'border-blue-300 bg-blue-50 text-blue-700'
                        : 'border-slate-200 bg-white text-slate-700'
                    }`}
                  >
                    <option value="">All Sub Sections</option>
                    {subsectionOptions.map(option => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                )}

                <select
                  value={yesNoFilter}
                  onChange={e =>
                    setYesNoFilter(e.target.value)
                  }
                  className={`h-9 w-28 rounded-lg border px-2.5 text-xs font-medium outline-none transition ${
                    yesNoFilter
                      ? 'border-blue-300 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-white text-slate-700'
                  }`}
                >
                  <option value="">Yes / No</option>
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                </select>

                {(subsectionFilter || yesNoFilter) && (
                  <button
                    type="button"
                    title="Reset filters"
                    onClick={() => {
                      setSubsectionFilter('')
                      setYesNoFilter('')
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-500 hover:border-red-300 hover:text-red-500"
                  >
                    <RotateCcw size={13} />
                    Reset
                  </button>
                )}

              </div>
            }
          />
        )}
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// Question screen
// ─────────────────────────────────────────────────────────────────────────────

function QuestionScreen({
  row,
  onOpenCustomer,
}: {
  row: Record<string, unknown>
  onOpenCustomer: (
    row: Record<string, unknown>,
  ) => void
}) {
  const elementId =
    row.id as number

  const inputType =
    String(
      row.input_type ?? '',
    )

  const [result, setResult] =
    useState<ReportResult | null>(null)

  const [loading, setLoading] =
    useState(true)

  const [error, setError] =
    useState<string | null>(null)


  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setError(null)

    reportEngineApi
      .runAdhoc({
        report_type_key:
          'questionnaire_answers',

        fields: [
          'id',
          'customer_id',
          'customer_name',
          'answer_value',
          'remarks',
          'answered_at',
          'answered_by_name',
        ],

        filters: [
          {
            field:
              'element_id',
            operator: 'eq',
            value: elementId,
          },
        ],

        per_page: 200,
      })
      .then(res => {
        if (!cancelled) {
          setResult(res.data)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(
            'Could not load respondents',
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [elementId])


  const yes =
    Number(row.yes_count) || 0

  const no =
    Number(row.no_count) || 0

  const na =
    Number(row.na_count) || 0


  const showYesNoChart =
    isYesNoAnswerType(
      inputType,
    ) &&
    yes + no + na > 0


  const segments = [
    {
      name: 'Yes',
      value: yes,
      color: '#16a34a',
    },

    {
      name: 'No',
      value: no,
      color: '#e11d48',
    },

    {
      name: 'NA',
      value: na,
      color: '#94a3b8',
    },
  ]


  const columns:
    Column<
      Record<string, unknown>
    >[] = [
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,

      render: (v, r) => (
        <button
          type="button"
          onClick={() =>
            onOpenCustomer(r)
          }
          className="font-medium text-slate-800 hover:text-fuchsia-700 hover:underline"
        >
          {String(v ?? '—')}
        </button>
      ),
    },

    {
      key: 'answer_value',
      header: 'Answer',

      render: v => (
        <AnswerBadge
          value={
            v == null
              ? null
              : String(v)
          }
          inputType={
            inputType
          }
        />
      ),
    },

    {
      key: 'remarks',
      header: 'Remarks',
    },

    {
      key: 'answered_at',
      header: 'Answered On',
      sortable: true,
      render: v => fmtDate(v),
    },
  ]


  return (
    <div className="space-y-5">

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">

        <StatTile
          label="Total Assigned"
          value={fmtNum(
            row.total_assigned,
          )}
        />

        <StatTile
          label="Answered"
          value={fmtNum(
            row.answered_count,
          )}
          tone="emerald"
        />

        <StatTile
          label="Skipped"
          value={fmtNum(
            row.skipped_count,
          )}
          tone="amber"
        />

        <StatTile
          label="Skip Rate"
          value={fmtPct(
            row.skip_rate_pct,
          )}
          tone="rose"
        />
      </div>


      {showYesNoChart && (
        <div className="rounded-xl border border-slate-200 p-4">

          <div className="mb-3 text-[11px] font-bold uppercase tracking-wide text-slate-400">
            Yes / No / NA Breakdown
          </div>

          <CountDonut
            segments={segments}
          />
        </div>
      )}


      <div>

        <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">
          Respondents (
          {fmtNum(
            row.answered_count,
          )}
          )
        </div>

        {error ? (
          <ErrorBox
            message={error}
          />
        ) : (
          <DataTable
            data={
              result?.rows ?? []
            }
            columns={columns}
            loading={loading}
            keyField="id"
            showColumnToggle={false}
          />
        )}
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// Customer screen
// ─────────────────────────────────────────────────────────────────────────────

interface CustomerQAStructure {
  id: number
  parent_id: number | null
  structure_type: string
  structure_name: string
  display_order: number
}


interface QAAnswer {
  answer_value: string | null
  remarks: string | null
}


export interface CustomerQAResponse {
  customer: {
    id: number
    customer_code: string
    customer_name: string
    customer_category: string | null
  }

  questionnaire?: {
    questionnaire_name: string
  }

  sections: CustomerQAStructure[]

  subsections: CustomerQAStructure[]

  questions: QElement[]

  fields: QElement[]

  answers: Record<
    number,
    QAAnswer
  >

  progress: {
    status: string
    total_questions: number
    completed_questions: number
    progress_percentage: number
  } | null
}


/*
 * parent_element_id is already available from questionnaire fields.
 * We only use it here to visually place each field under its parent question.
 */
type QElementWithParent =
  QElement & {
    parent_element_id?:
      number | null
  }


// ─────────────────────────────────────────────────────────────────────────────
// Customer answer value
// ─────────────────────────────────────────────────────────────────────────────

function CustomerAnswerValue({
  element,
  answer,
}: {
  element: QElement
  answer?: QAAnswer
}) {
  const value =
    answer?.answer_value ??
    null

  const isFile =
    element.input_type ===
    'file'


  if (isFile && value) {
    return (
      <a
        href={
          buildFilePreviewUrl(
            value,
          )
        }
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-indigo-600 hover:underline"
      >
        <Paperclip size={13} />

        View file
      </a>
    )
  }


  return (
    <AnswerBadge
      value={value}
      inputType={
        element.input_type
      }
    />
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// New horizontal question / fields layout
// ─────────────────────────────────────────────────────────────────────────────

// A field flagged show_when_operator: 'equals' with show_when_value 'yes'/'no'
// only appears once the parent yes/no question is answered that way — mirrors
// conditionalYesNoFieldVisible() in CustomerQuestionnaireFormPage.tsx.
function conditionalYesNoFieldVisible(
  field: QElement,
  actual: string | null | undefined,
): boolean {
  const expectedValue = (
    field.show_when_value ?? ''
  )
    .toString()
    .trim()
    .toLowerCase()

  if (
    field.show_when_operator !==
      'equals' ||
    (expectedValue !== 'yes' &&
      expectedValue !== 'no')
  ) {
    return false
  }

  return (
    (actual ?? '')
      .toString()
      .trim()
      .toLowerCase() ===
    expectedValue
  )
}


// Shared by QuestionBlock (View tab) and buildQuestionTableRows (Table tab) so
// both tabs agree on which fields a yes/no question currently shows.
function visibleFieldsForQuestion(
  question: QElement,
  fields: QElement[],
  answers: Record<number, QAAnswer>,
): QElement[] {
  if (
    !isYesNoAnswerType(
      question.input_type,
    )
  ) {
    return fields
  }

  const answerValue =
    answers?.[question.id]
      ?.answer_value

  if (
    (answerValue ?? '')
      .trim()
      .toLowerCase() !== 'yes'
  ) {
    return []
  }

  return fields.filter(field =>
    conditionalYesNoFieldVisible(
      field,
      answerValue,
    ),
  )
}


function QuestionBlock({
  question,
  fields,
  answers,
  number,
}: {
  question: QElement
  fields: QElement[]
  answers:
    Record<number, QAAnswer>
  number?: string
}) {
  const questionAnswer =
    answers?.[question.id]


  const isYesNoQuestion =
    isYesNoAnswerType(
      question.input_type,
    )

  const normalizedAnswer = (
    questionAnswer
      ?.answer_value ?? ''
  )
    .trim()
    .toLowerCase()

  const answeredYes =
    isYesNoQuestion &&
    normalizedAnswer === 'yes'

  const answeredNo =
    isYesNoQuestion &&
    normalizedAnswer === 'no'


  const visibleFields =
    visibleFieldsForQuestion(
      question,
      fields,
      answers,
    )


  /*
   * Yes/No questions: pill sits inline in the heading row, fields (if any)
   * only render underneath once answered "Yes" — answering "No" shows just
   * the pill, nothing else.
   *
   * Non yes/no questions keep the original layout:
   *
   * Question
   *
   * Field 1       Field 2       Field 3
   * Answer 1      Answer 2      Answer 3
   *
   * (or, with no fields, a single "Answer" cell)
   */
  const displayElements =
    isYesNoQuestion
      ? visibleFields
      : visibleFields.length
        ? visibleFields
        : [question]


  const gridClass =
    displayElements.length === 1
      ? 'grid-cols-1'
      : displayElements.length === 2
        ? 'grid-cols-1 sm:grid-cols-2'
        : displayElements.length === 3
          ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
          : displayElements.length === 4
            ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
            : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'


  return (
    <div className="py-5">

      {/* Question heading */}
      <div className="mb-5 flex items-start justify-between gap-3">

        <div className="flex min-w-0 flex-1 items-start gap-3">

          {number && (
            <span className="mt-[1px] inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 px-1.5 text-[10px] font-bold text-emerald-700">
              {number}
            </span>
          )}


          <div className="min-w-0 flex-1">

            <div className="text-[13.5px] font-semibold leading-5 text-slate-800">
              {
                question.element_label
              }
            </div>


            {!isYesNoQuestion &&
              !visibleFields.length &&
              questionAnswer
                ?.remarks && (
                <div className="mt-1.5 text-[11px] italic leading-4 text-slate-400">
                  "
                  {
                    questionAnswer
                      .remarks
                  }
                  "
                </div>
              )}

          </div>
        </div>


        {isYesNoQuestion && (
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
              answeredYes
                ? 'border-green-200 bg-green-50 text-green-700'
                : answeredNo
                  ? 'border-gray-200 bg-gray-100 text-gray-600'
                  : 'border-slate-200 bg-slate-50 text-slate-400'
            }`}
          >
            Answer:{' '}
            {answeredYes
              ? 'Yes'
              : answeredNo
                ? 'No'
                : questionAnswer
                    ?.answer_value ||
                  '—'}
          </span>
        )}

      </div>


      {/* Horizontal fields */}
      {displayElements.length > 0 && (
        <div
          className={`grid gap-x-10 gap-y-5 pl-9 ${gridClass}`}
        >
          {displayElements.map(
            element => {
              const answer =
                answers?.[
                  element.id
                ]

              return (
                <div
                  key={
                    element.id
                  }
                  className="min-w-0"
                >

                  {/* FIELD LABEL */}
                  <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.055em] text-slate-400">
                    {isYesNoQuestion ||
                    visibleFields.length
                      ? element.element_label
                      : 'Answer'}
                  </div>


                  {/* ANSWER */}
                  <div className="min-h-[24px] break-words text-[13px] font-medium leading-5 text-slate-800">
                    <CustomerAnswerValue
                      element={
                        element
                      }
                      answer={
                        answer
                      }
                    />
                  </div>


                  {/* FIELD REMARKS */}
                  {answer?.remarks && (
                    <div className="mt-1.5 text-[11px] italic leading-4 text-slate-400">
                      "
                      {
                        answer.remarks
                      }
                      "
                    </div>
                  )}

                </div>
              )
            },
          )}
        </div>
      )}

    </div>
  )
}



// ─────────────────────────────────────────────────────────────────────────────
// Customer Screen — Table tab row model
// ─────────────────────────────────────────────────────────────────────────────

interface FieldDetailPair {
  id: number
  label: string
  value: string
}


export interface QuestionTableRow {
  [key: string]: unknown
  row_id: string
  id: number
  question_code: string
  section_name: string
  subsection_name: string
  question_label: string
  yes_no: string
  field_details: string
  field_details_pairs: FieldDetailPair[]
}


function formatFieldDetailValue(
  field: QElement,
  answer?: QAAnswer,
): string {
  if (field.input_type === 'file') {
    return answer?.answer_value
      ? 'Uploaded file'
      : '-'
  }

  const value =
    answer?.answer_value?.trim()

  return value || '-'
}


// Sorts "A1, A2, ..., A10, B1, B2, ..." naturally instead of as plain
// strings (which would put "A10" before "A2").
function parseQuestionCode(
  code: string,
) {
  const match = code.match(
    /^([A-Za-z]*)(\d*)/,
  )

  return {
    prefix: match?.[1] ?? code,
    num: match?.[2]
      ? parseInt(match[2], 10)
      : 0,
  }
}


export function compareQuestionCodes(
  a: string,
  b: string,
): number {
  const pa =
    parseQuestionCode(a)

  const pb =
    parseQuestionCode(b)

  return (
    pa.prefix.localeCompare(
      pb.prefix,
    ) || pa.num - pb.num
  )
}


export function buildQuestionTableRows(
  data: CustomerQAResponse,
): QuestionTableRow[] {
  const sectionNameById = new Map(
    (data.sections || []).map(
      section => [
        section.id,
        section.structure_name,
      ],
    ),
  )

  const subsectionNameById =
    new Map(
      (
        data.subsections || []
      ).map(subsection => [
        subsection.id,
        subsection.structure_name,
      ]),
    )

  const fieldsByQuestion =
    new Map<number, QElement[]>()

  ;(data.fields || []).forEach(
    field => {
      const parentId = (
        field as QElementWithParent
      ).parent_element_id

      if (!parentId) {
        return
      }

      const list =
        fieldsByQuestion.get(
          parentId,
        ) || []

      list.push(field)

      fieldsByQuestion.set(
        parentId,
        list,
      )
    },
  )

  const answers = data.answers || {}

  const questions = [
    ...(data.questions || []),
  ].sort(
    (a, b) =>
      (a.display_order ?? 0) -
        (b.display_order ?? 0) ||
      a.id - b.id,
  )

  return questions.flatMap(question => {
    const fields =
      fieldsByQuestion.get(
        question.id,
      ) || []

    const visibleFields =
      visibleFieldsForQuestion(
        question,
        fields,
        answers,
      )

    const isYesNoQuestion =
      isYesNoAnswerType(
        question.input_type,
      )

    const normalizedAnswer = (
      answers[question.id]
        ?.answer_value ?? ''
    )
      .trim()
      .toLowerCase()

    const yesNo = isYesNoQuestion
      ? normalizedAnswer === 'yes'
        ? 'Yes'
        : normalizedAnswer === 'no'
          ? 'No'
          : ''
      : ''

    const fieldDetailsPairs =
      visibleFields.map(
        field => ({
          id: field.id,

          label:
            field.element_label,

          value:
            formatFieldDetailValue(
              field,
              answers[field.id],
            ),
        }),
      )

    const baseRow = {
      id: question.id,

      question_code:
        question.element_code,

      section_name:
        question.section_id
          ? sectionNameById.get(
              question.section_id,
            ) ?? ''
          : '',

      subsection_name:
        question.subsection_id
          ? subsectionNameById.get(
              question.subsection_id,
            ) ?? ''
          : '',

      question_label:
        question.element_label,

      yes_no: yesNo,
    }

    if (!fieldDetailsPairs.length) {
      return [{
        ...baseRow,

        row_id:
          `${question.id}:question`,

        field_details:
          '',

        field_details_pairs:
          [],
      }]
    }

    return fieldDetailsPairs.map(
      (pair, index) => ({
        ...baseRow,

        row_id:
          `${question.id}:field:${pair.id}:${index}`,

        field_details:
          `${pair.label}: ${pair.value}`,

        field_details_pairs:
          [pair],
      }),
    )
  }).sort((a, b) =>
    compareQuestionCodes(
      a.question_code,
      b.question_code,
    ),
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// Customer Screen
// ─────────────────────────────────────────────────────────────────────────────

function RoleScreen({
  row,
  onOpenUser,
}: {
  row: Record<string, unknown>
  onOpenUser: (row: Record<string, unknown>) => void
}) {
  const roleName = String(row.role_name ?? 'Unassigned')
  const roleFilter = useMemo(
    () => ({ field: 'role_name', operator: 'eq', value: roleName }),
    [roleName],
  )

  const [result, setResult] = useState<ReportResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setError(null)
    setResult(null)

    reportEngineApi
      .runAdhoc({
        report_type_key: 'questionnaire_role_user',
        fields: [
          'user_id',
          'user_name',
          'role_name',
          'customers',
          'questions',
          'answered',
          'pending',
          'completion_pct',
          'completed_customers',
          'last_activity_at',
        ],
        filters: [roleFilter],
        per_page: 500,
      })
      .then(res => {
        if (!cancelled) setResult(res.data)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load user detail for this role')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [roleFilter])

  const columns: Column<Record<string, unknown>>[] = [
    {
      key: 'user_name',
      header: 'User',
      sortable: true,
      render: (v, r) => (
        <button
          type="button"
          onClick={() => onOpenUser(r)}
          className="text-left font-medium text-slate-800 hover:text-fuchsia-700 hover:underline"
        >
          {String(v ?? 'Unassigned')}
        </button>
      ),
    },
    { key: 'customers', header: 'Customers', sortable: true, width: '110px' },
    { key: 'questions', header: 'Total Questions', sortable: true, width: '140px' },
    { key: 'answered', header: 'Answered', sortable: true, width: '100px' },
    { key: 'pending', header: 'Pending', sortable: true, width: '100px' },
    {
      key: 'completion_pct',
      header: 'Completion %',
      sortable: true,
      render: v => fmtPct(v),
      width: '125px',
    },
    {
      key: 'completed_customers',
      header: 'Completed Customers',
      sortable: true,
      width: '160px',
    },
  ]

  const summaryLines = [
    `Role: ${roleName}`,
  ]

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Users" value={fmtNum(row.users)} />
        <StatTile label="Customers" value={fmtNum(row.customers)} />
        <StatTile label="Questions" value={fmtNum(row.questions)} />
        <StatTile label="Answered" value={fmtNum(row.answered)} tone="emerald" />
        <StatTile label="Completion" value={fmtPct(row.completion_pct)} tone="indigo" />
      </div>

      {error ? (
        <ErrorBox message={error} />
      ) : (
        <DataTable
          data={result?.rows ?? []}
          columns={columns}
          loading={loading}
          keyField="user_name"
          showExport
          showColumnToggle={false}
          exportFilename={`${roleName}-questionnaire-users`}
          exportSummaryLines={summaryLines}
        />
      )}
    </div>
  )
}


function UserScreen({
  row,
  onOpenCustomer,
}: {
  row: Record<string, unknown>
  onOpenCustomer: (row: Record<string, unknown>) => void
}) {
  const numericUserId = Number(row.user_id)
  const hasUserId = Number.isFinite(numericUserId) && numericUserId > 0
  const userName = String(row.user_name ?? 'Unassigned')
  const userFilter = useMemo(
    () => hasUserId
      ? { field: 'user_id', operator: 'eq', value: numericUserId }
      : { field: 'user_name', operator: 'eq', value: userName },
    [hasUserId, numericUserId, userName],
  )

  const [customerResult, setCustomerResult] = useState<ReportResult | null>(null)
  const [loadingCustomers, setLoadingCustomers] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<number>>(new Set())
  const [exportOpen, setExportOpen] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')
  const filterKey = `${userFilter.field}:${String(userFilter.value)}`

  useEffect(() => {
    let cancelled = false

    setLoadingCustomers(true)
    setError(null)
    setCustomerResult(null)
    setSelectedCustomerIds(new Set())
    setStatusFilter('')

    reportEngineApi
      .runAdhoc({
        report_type_key: 'questionnaire_user_customer',
        fields: [
          'id',
          'user_id',
          'user_name',
          'role_name',
          'customer_id',
          'customer_name',
          'category',
          'questionnaire_name',
          'status',
          'questions',
          'answered',
          'pending',
          'completion_pct',
          'last_activity_at',
        ],
        filters: [userFilter],
        per_page: 500,
      })
      .then(res => {
        if (!cancelled) setCustomerResult(res.data)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load customer summary for this user')
      })
      .finally(() => {
        if (!cancelled) setLoadingCustomers(false)
      })

    return () => {
      cancelled = true
    }
  }, [filterKey, userFilter])

  const customerColumns: Column<Record<string, unknown>>[] = [
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (v, r) => (
        <button
          type="button"
          onClick={() => onOpenCustomer(r)}
          className="text-left font-medium text-slate-800 hover:text-fuchsia-700 hover:underline"
        >
          {String(v ?? '—')}
        </button>
      ),
    },
    { key: 'questionnaire_name', header: 'Questionnaire', sortable: true },
    {
      key: 'category',
      header: 'Category',
      sortable: true,
      render: v => String(v || '—'),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: v => <StatusPill status={String(v || 'not_started')} />,
    },
    { key: 'questions', header: 'Total Questions', sortable: true, width: '130px' },
    { key: 'answered', header: 'Answered', sortable: true, width: '90px' },
    { key: 'pending', header: 'Pending', sortable: true, width: '90px' },
    {
      key: 'completion_pct',
      header: 'Completion %',
      sortable: true,
      render: v => fmtPct(v),
      width: '120px',
    },
    {
      key: 'last_activity_at',
      header: 'Last Activity',
      sortable: true,
      render: v => fmtDate(v),
      width: '120px',
    },
  ]

  const filteredCustomerRows = (customerResult?.rows ?? []).filter(
    r => !statusFilter || String(r.status || 'not_started') === statusFilter,
  )

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Customers" value={fmtNum(row.customers)} />
        <StatTile label="Questions" value={fmtNum(row.questions)} />
        <StatTile label="Answered" value={fmtNum(row.answered)} tone="emerald" />
        <StatTile label="Pending" value={fmtNum(row.pending)} tone="amber" />
        <StatTile label="Completion" value={fmtPct(row.completion_pct)} tone="indigo" />
      </div>

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => setExportOpen(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-[13px] font-semibold text-slate-700 hover:bg-slate-50"
        >
          <Download size={14} />
          Export
        </button>
      </div>

      {error ? (
        <ErrorBox message={error} />
      ) : (
        <DataTable
          data={filteredCustomerRows}
          columns={customerColumns}
          loading={loadingCustomers}
          keyField="id"
          selectable
          onSelectionChange={rows => setSelectedCustomerIds(new Set(rows.map(r => Number(r.customer_id))))}
          showExport={false}
          showColumnToggle={false}
          toolbarVariant="compact"
          toolbar={
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className={`h-9 w-36 rounded-lg border px-2.5 text-xs font-medium outline-none transition ${
                statusFilter
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-700'
              }`}
            >
              <option value="">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="in_progress">In Progress</option>
            </select>
          }
        />
      )}

      <UserQuestionnaireExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        summaryRows={customerResult?.rows ?? []}
        selectedCustomerIds={selectedCustomerIds}
        userFilter={userFilter}
        reportName={`${userName} - Questionnaire`}
      />
    </div>
  )
}


function CustomerScreen({
  row,
}: {
  row: Record<
    string,
    unknown
  >
}) {
  const customerId =
    useMemo(
      () =>
        resolveCustomerId(
          row,
        ),
      [row],
    )


  const [data, setData] =
    useState<CustomerQAResponse | null>(
      null,
    )


  const [loading, setLoading] =
    useState(true)


  const [error, setError] =
    useState<string | null>(
      null,
    )


  const [
    collapsedSections,
    setCollapsedSections,
  ] = useState<Set<number>>(
    new Set(),
  )


  const [
    viewMode,
    setViewMode,
  ] = useState<'view' | 'table'>(
    'table',
  )


  const [
    tableSectionFilter,
    setTableSectionFilter,
  ] = useState('')

  const [
    tableSubsectionFilter,
    setTableSubsectionFilter,
  ] = useState('')

  const [
    tableYesNoFilter,
    setTableYesNoFilter,
  ] = useState('')


  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setError(null)


    if (!customerId) {
      setError(
        'Could not load this customer questionnaire because the customer id is missing from the report row',
      )

      setLoading(false)

      return () => {
        cancelled = true
      }
    }


    questionnaireApi
      .getCustomerQuestionnaire(
        customerId,
      )
      .then(res => {
        if (!cancelled) {
          setData(
            res.data as CustomerQAResponse,
          )
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(
            "Could not load this customer's questionnaire",
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })


    return () => {
      cancelled = true
    }
  }, [customerId])


  /*
   * NEW DISPLAY GROUPING
   *
   * Previously:
   * questions + fields were merged into one flat list.
   *
   * Now:
   * question stays as the heading
   * child fields are grouped under that question through parent_element_id.
   *
   * Backend/API/data are unchanged.
   */
  const grouped =
    useMemo(() => {
      if (!data) return []


      const questions = [
        ...(data.questions ||
          []),
      ].sort(
        (a, b) =>
          (a.display_order ??
            0) -
            (b.display_order ??
              0) ||
          a.id - b.id,
      )


      const fields = [
        ...(data.fields ||
          []),
      ] as QElementWithParent[]


      fields.sort(
        (a, b) =>
          (a.display_order ??
            0) -
            (b.display_order ??
              0) ||
          a.id - b.id,
      )


      const sections = [
        ...(data.sections ||
          []),
      ].sort(
        (a, b) =>
          a.display_order -
          b.display_order,
      )


      const subsectionsBySection =
        new Map<
          number,
          CustomerQAStructure[]
        >()


      ;(
        data.subsections ||
        []
      ).forEach(sub => {
        const key =
          sub.parent_id ??
          -1

        const list =
          subsectionsBySection.get(
            key,
          ) || []

        list.push(sub)

        subsectionsBySection.set(
          key,
          list,
        )
      })


      /*
       * Group fields by parent question.
       */
      const fieldsByQuestion =
        new Map<
          number,
          QElement[]
        >()


      fields.forEach(field => {
        const parentId =
          field.parent_element_id


        if (!parentId) {
          return
        }


        const list =
          fieldsByQuestion.get(
            parentId,
          ) || []


        list.push(field)


        fieldsByQuestion.set(
          parentId,
          list,
        )
      })


      /*
       * Helper that converts a question into:
       *
       * {
       *    question,
       *    fields: [...]
       * }
       */
      const makeQuestionGroup =
        (
          question: QElement,
        ) => ({
          question,

          fields:
            fieldsByQuestion.get(
              question.id,
            ) || [],
        })


      return sections
        .map(section => {
          const subs = (
            subsectionsBySection.get(
              section.id,
            ) || []
          ).sort(
            (a, b) =>
              a.display_order -
              b.display_order,
          )


          /*
           * Questions directly inside section.
           */
          const directQuestions =
            questions
              .filter(
                question =>
                  question.section_id ===
                    section.id &&
                  !question.subsection_id,
              )
              .map(
                makeQuestionGroup,
              )


          /*
           * Questions inside subsections.
           */
          const subsectionGroups =
            subs
              .map(sub => ({
                subsection:
                  sub,

                questions:
                  questions
                    .filter(
                      question =>
                        question.subsection_id ===
                        sub.id,
                    )
                    .map(
                      makeQuestionGroup,
                    ),
              }))
              .filter(
                group =>
                  group.questions
                    .length,
              )


          return {
            section,
            directQuestions,
            subsectionGroups,
          }
        })
        .filter(
          group =>
            group
              .directQuestions
              .length ||
            group
              .subsectionGroups
              .length,
        )
    }, [data])


  const tableRows = useMemo(
    () =>
      data
        ? buildQuestionTableRows(
            data,
          )
        : [],
    [data],
  )


  const tableSectionOptions =
    useMemo(
      () =>
        Array.from(
          new Set(
            tableRows
              .map(
                r =>
                  r.section_name,
              )
              .filter(Boolean),
          ),
        ),
      [tableRows],
    )

  const tableSubsectionOptions =
    useMemo(
      () =>
        Array.from(
          new Set(
            tableRows
              .filter(
                r =>
                  !tableSectionFilter ||
                  r.section_name ===
                    tableSectionFilter,
              )
              .map(
                r =>
                  r.subsection_name,
              )
              .filter(Boolean),
          ),
        ),
      [
        tableRows,
        tableSectionFilter,
      ],
    )


  const filteredTableRows =
    useMemo(
      () =>
        tableRows.filter(
          r =>
            (!tableSectionFilter ||
              r.section_name ===
                tableSectionFilter) &&
            (!tableSubsectionFilter ||
              r.subsection_name ===
                tableSubsectionFilter) &&
            (!tableYesNoFilter ||
              r.yes_no ===
                tableYesNoFilter),
        ),
      [
        tableRows,
        tableSectionFilter,
        tableSubsectionFilter,
        tableYesNoFilter,
      ],
    )


  const tableColumns: Column<
    QuestionTableRow
  >[] = [
    {
      key: 'question_code',
      header: 'Question Code',
      sortable: true,
      width: '110px',
    },

    {
      key: 'section_name',
      header: 'Section',
      sortable: true,
      render: v =>
        String(v || '—'),
    },

    {
      key: 'subsection_name',
      header: 'Sub Section',
      sortable: true,
      render: v =>
        String(v || '—'),
    },

    {
      key: 'question_label',
      header: 'Question',
      sortable: true,
    },

    {
      key: 'yes_no',
      header: 'Yes/No',
      sortable: true,

      render: v =>
        v ? (
          <AnswerBadge
            value={String(v)}
            inputType="yes_no"
          />
        ) : (
          <span className="text-slate-400">
            —
          </span>
        ),
    },

    {
      key: 'field_details',
      header: 'Field Details',
      minWidth: '220px',

      render: (_v, row) => {
        const pairs =
          row
            .field_details_pairs

        if (!pairs.length) {
          return (
            <span className="text-slate-400">
              —
            </span>
          )
        }

        return (
          <div className="divide-y divide-slate-100 py-1">
            {pairs.map(
              (pair, index) => (
                <div
                  key={index}
                  className="py-1.5 first:pt-0 last:pb-0"
                >
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {pair.label}
                  </div>

                  <div className="mt-0.5 text-[12.5px] font-medium text-slate-700">
                    {pair.value}
                  </div>
                </div>
              ),
            )}
          </div>
        )
      },
    },
  ]


  if (loading) {
    return <LoadingBox />
  }


  if (error) {
    return (
      <ErrorBox
        message={error}
      />
    )
  }


  if (!data) {
    return null
  }


  const progress =
    data.progress


  const customerName = String(
    data.customer
      .customer_name || 'Customer',
  )


  const exportSummaryLines = progress
    ? [
        `Customer: ${customerName}`,
        `Total Questions: ${progress.total_questions}`,
        `Answered: ${progress.completed_questions}`,
        `Pending: ${Math.max(
          0,
          progress.total_questions -
            progress.completed_questions,
        )}`,
      ]
    : [`Customer: ${customerName}`]


  return (
    <div className="space-y-5">

      {/* View / Table tab switcher */}
      <div className="flex items-center justify-between gap-3">

        <div className="inline-flex items-center gap-1 rounded-xl bg-slate-100 p-1">

          <button
            type="button"
            onClick={() =>
              setViewMode('table')
            }
            className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors ${
              viewMode === 'table'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Table
          </button>

          <button
            type="button"
            onClick={() =>
              setViewMode('view')
            }
            className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors ${
              viewMode === 'view'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            View
          </button>

        </div>

      </div>


      {viewMode === 'table' && (
        <DataTable
          data={filteredTableRows}
          columns={tableColumns}
          keyField="row_id"
          showExport
          showColumnToggle={false}
          exportFilename={`${customerName}-questionnaire`}
          exportSummaryLines={
            exportSummaryLines
          }
          toolbarVariant="compact"
          toolbar={
            <div className="flex flex-wrap items-center gap-2">

              <select
                value={
                  tableSectionFilter
                }
                onChange={event => {
                  setTableSectionFilter(
                    event.target
                      .value,
                  )

                  setTableSubsectionFilter(
                    '',
                  )
                }}
                className={`h-9 w-40 truncate rounded-lg border px-2.5 text-xs font-medium outline-none transition ${
                  tableSectionFilter
                    ? 'border-blue-300 bg-blue-50 text-blue-700'
                    : 'border-slate-200 bg-white text-slate-700'
                }`}
              >
                <option value="">
                  All Sections
                </option>

                {tableSectionOptions.map(
                  option => (
                    <option
                      key={option}
                      value={option}
                    >
                      {option}
                    </option>
                  ),
                )}
              </select>

              <select
                value={
                  tableSubsectionFilter
                }
                onChange={event =>
                  setTableSubsectionFilter(
                    event.target
                      .value,
                  )
                }
                className={`h-9 w-40 truncate rounded-lg border px-2.5 text-xs font-medium outline-none transition ${
                  tableSubsectionFilter
                    ? 'border-blue-300 bg-blue-50 text-blue-700'
                    : 'border-slate-200 bg-white text-slate-700'
                }`}
              >
                <option value="">
                  All Sub Sections
                </option>

                {tableSubsectionOptions.map(
                  option => (
                    <option
                      key={option}
                      value={option}
                    >
                      {option}
                    </option>
                  ),
                )}
              </select>

              <select
                value={
                  tableYesNoFilter
                }
                onChange={event =>
                  setTableYesNoFilter(
                    event.target
                      .value,
                  )
                }
                className={`h-9 w-28 rounded-lg border px-2.5 text-xs font-medium outline-none transition ${
                  tableYesNoFilter
                    ? 'border-blue-300 bg-blue-50 text-blue-700'
                    : 'border-slate-200 bg-white text-slate-700'
                }`}
              >
                <option value="">
                  Yes / No
                </option>
                <option value="Yes">
                  Yes
                </option>
                <option value="No">
                  No
                </option>
              </select>


              {(tableSectionFilter ||
                tableSubsectionFilter ||
                tableYesNoFilter) && (
                <button
                  type="button"
                  title="Reset filters"
                  onClick={() => {
                    setTableSectionFilter(
                      '',
                    )
                    setTableSubsectionFilter(
                      '',
                    )
                    setTableYesNoFilter(
                      '',
                    )
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-500 hover:border-red-300 hover:text-red-500"
                >
                  <RotateCcw
                    size={13}
                  />
                  Reset
                </button>
              )}

            </div>
          }
        />
      )}


      {viewMode === 'view' && (
      <>

      {/* Progress stats */}
      {progress && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">

            <StatTile
              label="Total Questions"
              value={fmtNum(
                progress.total_questions,
              )}
            />

            <StatTile
              label="Answered"
              value={fmtNum(
                progress.completed_questions,
              )}
              tone="emerald"
            />

            <StatTile
              label="Progress"
              value={fmtPct(
                progress.progress_percentage,
              )}
              tone="indigo"
            />

          </div>


          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">

            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{
                width: `${Math.min(
                  100,
                  progress.progress_percentage ||
                    0,
                )}%`,
              }}
            />

          </div>
        </>
      )}


      {/* Questionnaire sections */}
      <div className="space-y-3">

        {grouped.map(
          ({
            section,
            directQuestions,
            subsectionGroups,
          }) => {
            const collapsed =
              collapsedSections.has(
                section.id,
              )


            return (
              <div
                key={
                  section.id
                }
                className="overflow-hidden rounded-xl border border-slate-200 bg-white"
              >

                {/* SECTION HEADER */}
                <button
                  type="button"
                  onClick={() =>
                    setCollapsedSections(
                      prev => {
                        const next =
                          new Set(
                            prev,
                          )

                        if (
                          next.has(
                            section.id,
                          )
                        ) {
                          next.delete(
                            section.id,
                          )
                        } else {
                          next.add(
                            section.id,
                          )
                        }

                        return next
                      },
                    )
                  }
                  className="flex w-full items-center justify-between gap-2 bg-slate-50 px-5 py-3 text-left"
                >

                  <span className="text-[12.5px] font-bold text-slate-800">
                    {
                      section.structure_name
                    }
                  </span>


                  <ChevronDown
                    size={14}
                    className={`shrink-0 text-slate-400 transition-transform ${
                      collapsed
                        ? '-rotate-90'
                        : ''
                    }`}
                  />

                </button>


                {/* SECTION CONTENT */}
                {!collapsed && (
                  <div className="px-5">

                    {/* DIRECT QUESTIONS */}
                    <div className="divide-y divide-slate-100">

                      {directQuestions.map(
                        ({
                          question,
                          fields,
                        }) => (
                          <QuestionBlock
                            key={
                              question.id
                            }
                            question={
                              question
                            }
                            fields={
                              fields
                            }
                            answers={
                              data.answers ||
                              {}
                            }
                            number={question.element_code}
                          />
                        ),
                      )}

                    </div>


                    {/* SUBSECTIONS */}
                    {subsectionGroups.map(
                      ({
                        subsection,
                        questions,
                      }) => (
                        <div
                          key={
                            subsection.id
                          }
                          className="py-3"
                        >

                          <div className="border-b border-slate-100 pb-2 text-[10.5px] font-bold uppercase tracking-[0.08em] text-slate-400">
                            {
                              subsection.structure_name
                            }
                          </div>


                          <div className="divide-y divide-slate-100">

                            {questions.map(
                              ({
                                question,
                                fields,
                              }) => (
                                <QuestionBlock
                                  key={
                                    question.id
                                  }
                                  question={
                                    question
                                  }
                                  fields={
                                    fields
                                  }
                                  answers={
                                    data.answers ||
                                    {}
                                  }
                                  number={question.element_code}
                                />
                              ),
                            )}

                          </div>

                        </div>
                      ),
                    )}

                  </div>
                )}

              </div>
            )
          },
        )}


        {!grouped.length && (
          <div className="rounded-xl border border-slate-200 p-6 text-center text-sm text-slate-400">
            No sections found for this questionnaire.
          </div>
        )}

      </div>

      </>
      )}

    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// Title per screen
// ─────────────────────────────────────────────────────────────────────────────

function titleFor(
  screen: Screen,
): {
  main: string
  sub: string
} {
  const row = screen.row


  switch (screen.mode) {

    case 'role':
      return {
        main: String(
          row.role_name ??
            'Role',
        ),

        sub:
          'User-wise questionnaire report',
      }


    case 'user':
      return {
        main: String(
          row.user_name ??
            'User',
        ),

        sub: [
          row.role_name,
          'Questionnaire report',
        ]
          .filter(Boolean)
          .join(' - '),
      }


    case 'adoption':
      return {
        main: String(
          row.questionnaire_name ??
            'Questionnaire',
        ),

        sub:
          'Adoption & rollout insight',
      }


    case 'section':
      return {
        main: String(
          row.section_name ??
            'Section',
        ),

        sub: String(
          row.questionnaire_name ??
            '',
        ),
      }


    case 'question':
      return {
        main: String(
          row.question_label ??
            'Question',
        ),

        sub: [
          row.section_name,
          row.subsection_name,
        ]
          .filter(Boolean)
          .join(' › '),
      }


    case 'customer':
      return {
        main: String(
          row.customer_name ??
            'Customer',
        ),

        sub: String(
          row.questionnaire_name ??
            'Questionnaire responses',
        ),
      }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Modal shell
// ─────────────────────────────────────────────────────────────────────────────

export function QuestionnaireInsightModal({
  request,
  onClose,
}: {
  request:
    QuestionnaireInsightRequest | null

  onClose: () => void
}) {
  const [
    maximized,
    setMaximized,
  ] = useState(false)


  const [
    screens,
    setScreens,
  ] = useState<Screen[]>(
    [],
  )


  useEffect(() => {
    if (request) {
      setMaximized(false)

      setScreens([
        {
          ...request,

          key: `${request.mode}-0`,
        },
      ])
    } else {
      setScreens([])
    }
  }, [request])


  function push(
    next:
      QuestionnaireInsightRequest,
  ) {
    setScreens(prev => [
      ...prev,

      {
        ...next,

        key: `${next.mode}-${prev.length}`,
      },
    ])
  }


  function goBack() {
    setScreens(prev =>
      prev.length > 1
        ? prev.slice(
            0,
            -1,
          )
        : prev,
    )
  }


  const current =
    screens[
      screens.length - 1
    ] || null


  if (
    !request ||
    !current
  ) {
    return null
  }


  const title =
    titleFor(current)


  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center overflow-hidden bg-slate-950/40 p-4 backdrop-blur-sm">

      <div
        className={`flex w-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-all duration-300 ${
          maximized
            ? 'h-full'
            : 'h-[85vh] max-w-[1100px]'
        }`}
      >

        {/* MODAL HEADER */}
        <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-5 py-4">

          {screens.length >
            1 && (
            <button
              onClick={
                goBack
              }
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-900"
              title="Back"
            >
              <ChevronLeft
                size={15}
              />
            </button>
          )}


          <div className="min-w-0 flex-1">

            <div className="truncate text-[15px] font-bold text-slate-900">
              {title.main}
            </div>

            {title.sub ? (
              <div className="mt-0.5 truncate text-[11.5px] text-slate-500">
                {title.sub}
              </div>
            ) : null}

          </div>


          <div className="flex shrink-0 items-center gap-2">

            <button
              onClick={() =>
                setMaximized(
                  v => !v,
                )
              }
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-900"
              title={
                maximized
                  ? 'Minimize'
                  : 'Maximize'
              }
            >
              {maximized ? (
                <Minimize2
                  size={15}
                />
              ) : (
                <Maximize2
                  size={15}
                />
              )}
            </button>


            <button
              onClick={
                onClose
              }
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-red-50 hover:text-red-600"
              title="Close"
            >
              <X size={15} />
            </button>

          </div>

        </div>


        {/* MODAL BODY */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">

          {current.mode ===
            'role' && (
            <RoleScreen
              row={
                current.row
              }
              onOpenUser={r =>
                push({
                  mode:
                    'user',
                  row: r,
                })
              }
            />
          )}


          {current.mode ===
            'user' && (
            <UserScreen
              row={
                current.row
              }
              onOpenCustomer={r =>
                push({
                  mode:
                    'customer',
                  row: r,
                })
              }
            />
          )}


          {current.mode ===
            'adoption' && (
            <AdoptionScreen
              row={
                current.row
              }
              onOpenCustomer={r =>
                push({
                  mode:
                    'customer',
                  row: r,
                })
              }
            />
          )}


          {current.mode ===
            'section' && (
            <SectionScreen
              row={
                current.row
              }
              onOpenCustomer={r =>
                push({
                  mode:
                    'customer',
                  row: r,
                })
              }
            />
          )}


          {current.mode ===
            'question' && (
            <QuestionScreen
              row={
                current.row
              }
              onOpenCustomer={r =>
                push({
                  mode:
                    'customer',
                  row: r,
                })
              }
            />
          )}


          {current.mode ===
            'customer' && (
            <CustomerScreen
              row={
                current.row
              }
            />
          )}

        </div>

      </div>

    </div>,

    document.body,
  )
}
