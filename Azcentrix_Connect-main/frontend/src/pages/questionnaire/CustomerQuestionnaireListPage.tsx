import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { questionnaireApi } from '@/services/api'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { usePermissions } from '@/hooks'
import { formatDateValue, formatDateTimeValue } from '@/utils/date'
import { useQuestionnaireTabs } from './QuestionnaireTabs'
import { Ic } from '@/components/crm/kit'
import { Av, Strip } from '@/pages/customers/kit'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/settings/admin360.css'
import './questionnaire.css'

type QuestionnaireStatus = 'not_started' | 'in_progress' | 'completed' | 'reopened'
type ActiveStatus = '' | Exclude<QuestionnaireStatus, 'not_started'>

interface QuestionnaireRow extends Record<string, unknown> {
  s_no: number
  customer_id: number
  customer_code: string
  customer_name: string
  customer_category: string | null
  assigned_to: number | null
  assigned_user_name: string | null
  total_questions: number
  completed_questions: number
  progress_percentage: number
  status: QuestionnaireStatus
  last_updated: string | null
  section_code: string | null
  section_name: string | null
  subsection_code: string | null
  subsection_name: string | null
}

const FETCH_PAGE_SIZE = 500

const STATUS_LABEL: Record<QuestionnaireStatus, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  completed: 'Completed',
  reopened: 'Reopened',
}

const STATUS_PILL: Record<QuestionnaireStatus, string> = {
  not_started: 'mu',
  in_progress: 'inf',
  completed: 'ok',
  reopened: 'wa',
}

// last_updated comes from the backend as a naive UTC timestamp (no "Z"/offset,
// e.g. "2026-08-06T08:08:59.123456"). New Date() treats such strings as local
// time per the JS spec, so without this it renders ~5:30h behind real IST time.
function parseNaiveUtcTimestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
  if (typeof value !== 'string' || !value.trim()) return null

  const trimmed = value.trim()
  const hasTimezone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed)
  const hasTimeComponent = /[T ]\d{2}:\d{2}/.test(trimmed)
  if (hasTimezone || !hasTimeComponent) {
    const asIs = new Date(trimmed)
    return Number.isFinite(asIs.getTime()) ? asIs : null
  }

  const asUtc = new Date(`${trimmed.replace(' ', 'T')}Z`)
  return Number.isFinite(asUtc.getTime()) ? asUtc : null
}

function clampPercent(value: unknown) {
  const n = Number(value || 0)
  return Math.max(0, Math.min(100, Math.round(n)))
}

function normalizeQuestionnaireRow(row: QuestionnaireRow): QuestionnaireRow {
  const total = Number(row.total_questions || 0)
  const completed = Number(row.completed_questions || 0)
  const status = total > 0 && completed >= total
    ? 'completed'
    : row.status === 'completed'
      ? 'in_progress'
      : row.status || 'not_started'

  return status === row.status ? row : { ...row, status }
}

function locationLabel(code?: string | null, name?: string | null) {
  if (code && name) return `${code}. ${name}`
  return name || code || '-'
}

function questionnaireViewPath(customerId: number) {
  return `/questionnaire/${customerId}?mode=view`
}

function questionnaireContinuePath(customerId: number) {
  return `/questionnaire/new/${customerId}`
}

function normalizeCustomerId(value: unknown) {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

export default function CustomerQuestionnaireListPage() {
  const navigate = useNavigate()
  const { error: showError } = useToast()
  const { can } = usePermissions()
  const questionnaireTabs = useQuestionnaireTabs()

  const [items, setItems] = useState<QuestionnaireRow[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState<ActiveStatus>('')
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function loadQuestionnaires() {
      setLoading(true)
      try {
        const params = { page: 1, per_page: FETCH_PAGE_SIZE }
        const first = await questionnaireApi.listCustomers(params)
        let rows: QuestionnaireRow[] = first.data.items || []
        const total = Number(first.data.total || rows.length)

        if (total > rows.length) {
          const all = await questionnaireApi.listCustomers({ ...params, per_page: total })
          rows = all.data.items || rows
        }

        if (!cancelled) setItems(rows.map(normalizeQuestionnaireRow))
      } catch {
        if (!cancelled) showError('Failed to load questionnaires')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadQuestionnaires()
    return () => { cancelled = true }
  }, [reloadTick, showError])

  const stats = useMemo(() => ({
    total: items.length,
    completed: items.filter((row) => row.status === 'completed').length,
    inProgress: items.filter((row) => row.status === 'in_progress').length,
    reopened: items.filter((row) => row.status === 'reopened').length,
  }), [items])

  const filteredItems = useMemo(
    () => statusFilter ? items.filter((row) => row.status === statusFilter) : items,
    [items, statusFilter],
  )

  const handleStatusCardClick = (nextStatus: ActiveStatus) => {
    setStatusFilter((current) => current === nextStatus ? '' : nextStatus)
  }

  const navigateToQuestionnaire = useCallback((row: QuestionnaireRow, mode: 'view' | 'continue') => {
    const id = normalizeCustomerId(row.customer_id)
    if (!id) {
      showError('Cannot open questionnaire: customer id is missing')
      return
    }
    navigate(mode === 'view' ? questionnaireViewPath(id) : questionnaireContinuePath(id))
  }, [navigate, showError])

  const cols = useMemo<GridCol<QuestionnaireRow>[]>(() => [
    {
      k: 'customer', t: 'Customer', w: 230, nogroup: true,
      txt: (row) => `${row.customer_name || ''} ${row.customer_code || ''} ${row.customer_category || ''}`,
      fn: (row) => (
        <a onClick={(event) => { event.stopPropagation(); navigateToQuestionnaire(row, 'continue') }} style={{ cursor: 'pointer', fontWeight: 600 }} title={row.customer_name || ''}>
          {row.customer_name || '-'}
        </a>
      ),
    },
    {
      k: 'owner', t: 'Assigned User', w: 170,
      txt: (row) => row.assigned_user_name || 'Unassigned',
      fn: (row) => row.assigned_user_name
        ? <span className="row" style={{ gap: 6, display: 'inline-flex', alignItems: 'center' }}><Av name={row.assigned_user_name} />{row.assigned_user_name}</span>
        : <span className="mu">Unassigned</span>,
    },
    {
      k: 'progress', t: 'Progress', w: 200, sv: (row) => row.progress_percentage,
      fn: (row) => {
        const pct = clampPercent(row.progress_percentage)
        return (
          <div style={{ minWidth: 130 }}>
            <div className="pm"><i style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--bw-ok)' : pct > 0 ? 'var(--bw-ac)' : 'var(--bw-ln)' }} /></div>
            <small className="mu">{row.completed_questions || 0} of {row.total_questions || 0} questions · {pct}%</small>
          </div>
        )
      },
    },
    {
      k: 'status', t: 'Status', w: 120, txt: (row) => STATUS_LABEL[row.status || 'not_started'],
      fn: (row) => {
        const nextStatus = (row.status || 'not_started') as QuestionnaireStatus
        return <span className={`pill ${STATUS_PILL[nextStatus]}`}>{STATUS_LABEL[nextStatus]}</span>
      },
    },
    {
      k: 'updated', t: 'Last Updated', w: 150, date: true, sv: (row) => row.last_updated || '',
      fn: (row) => {
        const date = parseNaiveUtcTimestamp(row.last_updated)
        if (!date) return <span className="mu">-</span>
        return <span style={{ whiteSpace: 'nowrap' }}>{formatDateValue(date, undefined, '-')}<br />
          <small className="mu">{formatDateTimeValue(date, { hour: 'numeric', minute: '2-digit', second: '2-digit' }, '-')}</small></span>
      },
    },
    {
      k: 'section', t: 'Section', w: 190, hide: true,
      fn: (row) => <span>{locationLabel(row.section_code, row.section_name)}<br /><small className="mu">Latest answered section</small></span>,
    },
    {
      k: 'subsection', t: 'Subsection', w: 200, hide: true,
      fn: (row) => <span>{locationLabel(row.subsection_code, row.subsection_name)}<br /><small className="mu">Latest answered subsection</small></span>,
    },
  ], [navigateToQuestionnaire])

  const menu = useCallback((row: QuestionnaireRow): GridMenuItem[] => [
    { l: 'View', i: <Ic n="eye" />, fn: () => navigateToQuestionnaire(row, 'view') },
    { l: 'Continue', i: <Ic n="doc" />, fn: () => navigateToQuestionnaire(row, 'continue') },
  ], [navigateToQuestionnaire])

  return (
    <div className="bwi">
      <div className="pg">
        <div><div className="crumb">Customer Questionnaires</div><h1>Customer Questionnaires</h1></div>
        <span className="cnt">Track and manage customer questionnaire progress</span>
        <span className="fl" />
        {questionnaireTabs}
        <button type="button" title="Refresh" className="btn g s" onClick={() => setReloadTick((tick) => tick + 1)}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
        {can('questionnaire.update') && (
          <button type="button" className="btn p" onClick={() => navigate('/questionnaire/new')}>
            <Ic n="plus" /> Add New
          </button>
        )}
      </div>

      <Strip items={[
        { l: 'Total Customers', v: stats.total, f: 'int', dc: statusFilter === '' ? 'ac' : undefined },
        { l: 'Completed', v: stats.completed, f: 'int', dc: statusFilter === 'completed' ? 'ac' : 'ok' },
        { l: 'In Progress', v: stats.inProgress, f: 'int', dc: statusFilter === 'in_progress' ? 'ac' : 'inf' },
        { l: 'Reopened', v: stats.reopened, f: 'int', dc: statusFilter === 'reopened' ? 'ac' : 'wa' },
      ]} />
      <div className="row wrap" style={{ gap: 8, marginTop: -4, marginBottom: 10 }}>
        <button type="button" className={`pill ${statusFilter === '' ? 'ac' : 'mu'}`} style={{ cursor: 'pointer', border: 'none' }} onClick={() => setStatusFilter('')}>All customers</button>
        <button type="button" className={`pill ${statusFilter === 'completed' ? 'ac' : 'mu'}`} style={{ cursor: 'pointer', border: 'none' }} onClick={() => handleStatusCardClick('completed')}>Completed</button>
        <button type="button" className={`pill ${statusFilter === 'in_progress' ? 'ac' : 'mu'}`} style={{ cursor: 'pointer', border: 'none' }} onClick={() => handleStatusCardClick('in_progress')}>In progress</button>
        <button type="button" className={`pill ${statusFilter === 'reopened' ? 'ac' : 'mu'}`} style={{ cursor: 'pointer', border: 'none' }} onClick={() => handleStatusCardClick('reopened')}>Reopened</button>
      </div>

      <div className="panel" aria-busy={loading}>
        <BwGrid
          id="customer-questionnaires"
          cols={cols}
          rows={filteredItems}
          rid={(row) => String(row.customer_id)}
          onRow={(row) => navigateToQuestionnaire(row, 'continue')}
          menu={menu}
          empty={loading ? 'Loading…' : 'No customers found'}
        />
      </div>
    </div>
  )
}
