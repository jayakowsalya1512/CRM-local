import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  BarChart2,
  Bookmark,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  ChevronUp,
  Download,
  FileText,
  Filter,
  Folder,
  Lock,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react'

import { useDebounce } from '@/hooks'
import { authApi } from '@/services/api'
import { formatTableDateValue } from '@/utils/date'
import { RecordViewPanel } from './RecordViewPanel'
import { ExportMenu, type Column } from '@/components/ui/DataTable'
import { QuestionnaireInsightModal, type QuestionnaireInsightMode, type QuestionnaireInsightRequest } from './QuestionnaireInsightModal'
import { QuestionnaireExportDialog } from './QuestionnaireExportDialog'
import type { DrilldownEntity, DrilldownRequest } from '../reports/shared/DrilldownDrawer'
import {
  reportEngineApi,
  type BusinessReportCategory,
  type BusinessReportTemplate,
  type BusinessReportTemplateDetail,
  type BusinessTemplateResolveResponse,
  type FilterItem,
  type ReportConfig,
  type ReportFolder,
  type ReportModuleChild,
  type ReportModuleParent,
  type ReportResult,
  type ReportType,
  type ReportTypeField,
  type SavedFilter,
  type SavedFilterConfig,
  type SavedReport,
} from '@/services/reportEngineApi'
import { useModuleName } from '@/context/ModuleLabelsContext'

// `/reports` and `/reports/:reportTypeKey` are separate sibling routes (see App.tsx),
// so navigating between the reports list and a report detail fully unmounts and
// remounts ReportEnginePage. Module-scoped so the home list's folder filter survives
// that remount and the "← Reports" back button lands on the same filtered view the
// user opened the report from, instead of resetting to "All Reports".
let cachedHomeFolderFilter: 'all' | number = 'all'

type ToastType = 'success' | 'error' | 'info'

function toast(type: ToastType, message: string) {
  if (type === 'error') {
    console.error(message)
  }

  if (type === 'success') {
    console.log(message)
  }

  alert(message)
}

function fmtDate(value?: string | null) {
  if (!value) return '—'

  try {
    return new Date(value).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return value
  }
}

function fmtValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—'

  if (typeof value === 'number') {
    return value.toLocaleString('en-IN')
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }

  return formatTableDateValue(value)
}

function operatorLabel(op: string) {
  const map: Record<string, string> = {
    eq: 'Equals',
    neq: 'Not Equals',
    contains: 'Contains',
    starts_with: 'Starts With',
    gt: 'Greater Than',
    gte: 'Greater Than or Equal',
    lt: 'Less Than',
    lte: 'Less Than or Equal',
    between: 'Between',
    in: 'In',
    not_in: 'Not In',
    is_null: 'Is Empty',
    is_not_null: 'Is Not Empty',
  }

  return map[op] || op
}

function folderName(folders: ReportFolder[], folderId?: number | null) {
  if (!folderId) return '—'
  return folders.find(f => f.id === folderId)?.name || '—'
}

function ReportsHomeTable({
  folders,
  reports,
  loading,
  onCreateReport,
  onOpenReport,
  onRefresh,
  folderFilter,
  onFolderFilterChange,
}: {
  folders: ReportFolder[]
  reports: SavedReport[]
  loading: boolean
  onCreateReport: () => void
  onOpenReport: (report: SavedReport) => void
  onRefresh: () => void
  folderFilter: 'all' | number
  onFolderFilterChange: (value: 'all' | number) => void
}) {
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | null>(null)
  const { label: customerLabel } = useModuleName('customers')
  const { label: leadLabel } = useModuleName('leads')
  const { label: opportunityLabel } = useModuleName('opportunities')
  const { label: tenderLabel } = useModuleName('tenders')
  const { label: quotationLabel } = useModuleName('quotations')
  const { label: workOrderLabel } = useModuleName('workorders')
  const { label: emdbgLabel } = useModuleName('emdbg')
  const { label: kamLabel } = useModuleName('kam')
  const { label: travelLabel } = useModuleName('travel')
  const { label: usersLabel } = useModuleName('users')
  const reportModuleLabels = {
    customers: customerLabel,
    leads: leadLabel,
    opportunities: opportunityLabel,
    tenders: tenderLabel,
    quotations: quotationLabel,
    workorders: workOrderLabel,
    emdbg: emdbgLabel,
    kam_activities: kamLabel,
    travel: travelLabel,
    users: usersLabel,
  }
  const handleSort = (key: string) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc')
      else { setSortDir(null); setSortKey(null) }
    } else {
      setSortKey(key); setSortDir('asc')
    }
  }

  // Only offer folders that actually have a visible report in them — `reports` is
  // already filtered server-side by module-enabled + permission access, so a folder
  // like "Questionnaire Reports" disappears from the dropdown once its module is
  // disabled for the tenant, instead of showing as an always-empty option.
  const visibleFolders = useMemo(() => {
    const folderIdsWithReports = new Set(reports.map(r => r.folder_id))
    return folders.filter(folder => folderIdsWithReports.has(folder.id))
  }, [folders, reports])

  const filteredReports = useMemo(() => {
    const q = search.trim().toLowerCase()

    return reports.filter(report => {
      const matchesSearch =
        !q ||
        report.name.toLowerCase().includes(q) ||
        String(report.description || '').toLowerCase().includes(q)

      const matchesFolder =
        folderFilter === 'all' || report.folder_id === folderFilter

      return matchesSearch && matchesFolder
    })
  }, [reports, search, folderFilter])

  const sortValue = (report: SavedReport, key: string) => {
    switch (key) {
      case 'name': return report.name || ''
      case 'description': return report.description || ''
      case 'folder': return folderName(folders, report.folder_id) || ''
      case 'last_accessed_at': return report.last_accessed_at || ''
      case 'last_run_at': return report.last_run_at || ''
      case 'run_count': return report.run_count || 0
      default: return ''
    }
  }

  const sortedReports = useMemo(() => {
    if (!sortKey || !sortDir) return filteredReports
    return [...filteredReports].sort((a, b) => {
      const aVal = sortValue(a, sortKey), bVal = sortValue(b, sortKey)
      if (aVal == null) return 1
      if (bVal == null) return -1
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [filteredReports, sortKey, sortDir, folders])

  const SortHeader = ({ label, colKey }: { label: string; colKey: string }) => (
    <th
      onClick={() => handleSort(colKey)}
      className="group cursor-pointer select-none whitespace-nowrap px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
    >
      <div className="flex items-center">
        {label}
        {sortKey !== colKey ? (
          <ChevronsUpDown size={11} className="ml-1 opacity-30 transition-opacity group-hover:opacity-60" />
        ) : sortDir === 'asc' ? (
          <ChevronUp size={11} className="ml-1 text-blue-500" />
        ) : (
          <ChevronDown size={11} className="ml-1 text-blue-500" />
        )}
      </div>
    </th>
  )

  return (
    <div className="flex h-full flex-col bg-gray-50">
      <div className="border-b border-gray-200 bg-white px-6 py-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Reports</h1>
            <p className="mt-1 text-sm text-gray-500">
              Create and manage CRM reports
            </p>
          </div>

          <button
            type="button"
            onClick={onCreateReport}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus size={16} />
            Create Report
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="flex flex-col overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-100 bg-gradient-to-r from-gray-50/80 to-white px-5 py-3.5 sm:flex-row sm:items-center">
            <select
              value={folderFilter}
              onChange={e => {
                const value = e.target.value
                onFolderFilterChange(value === 'all' ? 'all' : Number(value))
              }}
              className="flex-shrink-0 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 transition-all hover:border-gray-300 hover:bg-gray-50"
            >
              <option value="all">All Reports</option>
              {visibleFolders.map(folder => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>

            <div className="relative flex-1">
              <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search all reports"
                className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-8 text-xs placeholder:text-gray-400 transition-all focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 transition-all hover:border-gray-300 hover:bg-gray-50"
            >
              <RefreshCw size={13} />
              Refresh
            </button>
          </div>

          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <SortHeader label="Report Name" colKey="name" />
                <SortHeader label="Description" colKey="description" />
                <SortHeader label="Folder" colKey="folder" />
                <SortHeader label="Last Accessed" colKey="last_accessed_at" />
                <SortHeader label="Last Run" colKey="last_run_at" />
                <SortHeader label="Runs" colKey="run_count" />
              </tr>
            </thead>

            <tbody className="divide-y divide-gray-100 bg-white">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-500">
                    <Loader2 className="mx-auto mb-2 animate-spin" size={22} />
                    Loading reports...
                  </td>
                </tr>
              ) : sortedReports.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-500">
                    No reports found
                  </td>
                </tr>
              ) : (
                sortedReports.map(report => (
                 <tr
  key={report.id}
  onClick={() => onOpenReport(report)}
  className="
    group cursor-pointer
    transition-colors duration-200
    hover:bg-slate-50
  "
>
  <td className="relative px-4 py-3">
    <span className="absolute inset-y-0 left-0 w-[3px] origin-center scale-y-0 bg-fuchsia-500 transition-transform duration-200 group-hover:scale-y-100" />
    <div className="flex items-center gap-3">
      {/* Report icon */}
      <span
        className="
          flex h-8 w-8 flex-shrink-0 items-center justify-center
          rounded-lg border border-slate-200 bg-slate-50
          text-slate-500 transition-all duration-200
          group-hover:border-slate-900
          group-hover:bg-slate-900
          group-hover:text-white
          group-hover:shadow-sm
        "
      >
        <FileText size={15} />
      </span>

      <div className="flex min-w-0 items-center gap-2">
        {/* Report name */}
        <span
          className="
            truncate font-medium text-slate-800
            transition-all duration-200
            group-hover:font-semibold
            group-hover:text-slate-950
          "
        >
          {report.name}
        </span>

        {report.is_system && (
          <span
            className="
              rounded-full border border-slate-200
              bg-slate-50 px-2 py-0.5
              text-[10px] font-medium text-slate-500
            "
          >
            Standard
          </span>
        )}

        {/* Appears only on hover */}
        <span
          className="
            flex translate-x-[-4px] items-center gap-1
            whitespace-nowrap text-[11px] font-semibold
            text-fuchsia-600 opacity-0
            transition-all duration-200
            group-hover:translate-x-0
            group-hover:opacity-100
          "
        >
          
          <ChevronRight size={12} />
        </span>
      </div>
    </div>
  </td>

  <td className="max-w-[360px] truncate px-4 py-3 text-gray-600">
    {report.description || '—'}
  </td>

  <td className="px-4 py-3 text-gray-600">
    {folderName(folders, report.folder_id)}
  </td>

  <td className="px-4 py-3 text-gray-600">
    {fmtDate(report.last_accessed_at)}
  </td>

  <td className="px-4 py-3 text-gray-600">
    {fmtDate(report.last_run_at)}
  </td>

  <td className="px-4 py-3 text-gray-600">
    {report.run_count || 0}
  </td>
</tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function chainLabel(chain: string[]) {
  return chain
    .map(item => item.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
    .join(' → ')
}

function moduleLabel(moduleKey?: string | null, overrideLabels: Record<string, string> = {}) {
  if (!moduleKey) return ''
  if (overrideLabels[moduleKey]) return overrideLabels[moduleKey]
  const labels: Record<string, string> = {
    customers: 'Customers',
    leads: 'Leads',
    opportunities: 'Opportunities',
    tenders: 'Tenders',
    quotations: 'Quotations',
    workorders: 'Work Orders',
    emdbg: 'EMD / BG',
    kam_activities: 'KAM Activities',
    travel: 'Travel',
    users: 'Users',
  }

  return labels[moduleKey] || moduleKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function modulesLabel(modules: string[], overrideLabels: Record<string, string> = {}) {
  if (!modules.length) return 'No related modules'
  return modules.map(moduleKey => moduleLabel(moduleKey, overrideLabels)).join(', ')
}

function normalizeOptionForNone(option: ReportModuleChild): ReportModuleChild {
  return {
    ...option,
    module_key: 'none',
    label: '-None-',
    module_label: '-None-',
    can_continue: false,
  }
}

function ReportRelationSelector({
  parents,
  onCancel,
  onContinue,
}: {
  parents: ReportModuleParent[]
  onCancel: () => void
  onContinue: (child: ReportModuleChild) => void
}) {
  type LevelCard = {
    id: string
    title: string
    options: ReportModuleChild[]
    selected: ReportModuleChild | null
    loading: boolean
  }

  const [parentModule, setParentModule] = useState('')
  const [parentRelation, setParentRelation] = useState<ReportModuleChild | null>(null)
  const [cards, setCards] = useState<LevelCard[]>([])
  const [finalRelation, setFinalRelation] = useState<ReportModuleChild | null>(null)
  const [loadingInitial, setLoadingInitial] = useState(false)

  const selectedParent = parents.find(p => p.module_key === parentModule)

  async function loadFirstLevel(nextParent: string) {
    setParentModule(nextParent)
    setParentRelation(null)
    setCards([])
    setFinalRelation(null)

    if (!nextParent) return

    setLoadingInitial(true)

    try {
      const res = await reportEngineApi.getModuleRelations(nextParent)
      const allOptions = res.data.child_modules || []

      const root =
        allOptions.find(o => (o.module_chain || []).length === 1) ||
        allOptions.find(o => o.module_key === nextParent) ||
        null

      if (!root) {
        toast('error', 'No root report relation found for selected module')
        return
      }

      setParentRelation(root)

      const firstChildren = allOptions.filter(o => {
        const chain = o.module_chain || []
        return !(chain.length === 1 && chain[0] === nextParent)
      })

      const noneOption = normalizeOptionForNone(root)
      const options = [noneOption, ...firstChildren]

      setFinalRelation(noneOption)

      setCards([
        {
          id: `${nextParent}-level-1`,
          title: `For ${root.module_label || root.label}`,
          options,
          selected: noneOption,
          loading: false,
        },
      ])
    } catch (error) {
      console.error(error)
      toast('error', 'Failed to load child modules')
    } finally {
      setLoadingInitial(false)
    }
  }

  async function loadNextLevel(selected: ReportModuleChild, keepCards: LevelCard[]) {
    if (!selected.can_continue || selected.module_key === 'none') {
      setCards(keepCards)
      return
    }

    const chain = selected.module_chain || selected.chain || []

    if (!chain.length) {
      setCards(keepCards)
      return
    }

    const loadingCard: LevelCard = {
      id: `${selected.chain_key}-next`,
      title: `For ${selected.module_label || selected.label}`,
      options: [],
      selected: null,
      loading: true,
    }

    setCards([...keepCards, loadingCard])

    try {
      const res = await reportEngineApi.getModuleRelationChildren(
        selected.parent_module,
        chain,
      )

      const options = res.data.child_modules || []

      if (!options.length) {
        setCards(keepCards)
        return
      }

      const noneDefault = options.find(o => o.module_key === 'none') ?? options[0]

      setFinalRelation(noneDefault)
      setCards([
        ...keepCards,
        {
          ...loadingCard,
          options,
          selected: noneDefault,
          loading: false,
        },
      ])
    } catch (error) {
      console.error(error)
      toast('error', 'Failed to load next child modules')
      setCards(keepCards)
    }
  }

  function handleCardSelect(cardIndex: number, reportTypeKey: string) {
    const selected = cards[cardIndex].options.find(
      option => option.report_type_key === reportTypeKey,
    )

    if (!selected) return

    const updatedCards = cards.slice(0, cardIndex + 1).map((card, index) =>
      index === cardIndex ? { ...card, selected } : card,
    )

    setFinalRelation(selected)
    setCards(updatedCards)

    if (selected.module_key !== 'none' && selected.can_continue) {
      loadNextLevel(selected, updatedCards)
    }
  }

  return (
    <div className="flex h-full flex-col bg-gray-50">
      <div className="border-b border-gray-200 bg-white">
        <div className="flex items-center gap-2 border-b border-gray-100 px-6 py-2 text-sm text-gray-500">
          <span>Reports</span>
          <ChevronRight size={14} />
          <span>Create Report</span>
        </div>

        <div className="flex items-center justify-between px-6 py-5">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Untitled Report</h1>
            <p className="mt-1 text-sm text-gray-500">
              Select connected modules to build a custom report
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>

            <button
              type="button"
              disabled={!finalRelation}
              onClick={() => finalRelation && onContinue(finalRelation)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              Continue
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="min-h-[620px] rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex items-start justify-between border-b border-gray-100 px-6 py-5">
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                Select Related Modules
              </h2>
              <p className="mt-1 text-sm text-gray-500">
                Backend returns only approved connected module chains.
              </p>
            </div>

            <div className="flex items-center gap-5 text-sm text-gray-600">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded bg-emerald-500" />
                Parent Module
              </div>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded bg-blue-500" />
                Child Module
              </div>
            </div>
          </div>

          <div className="relative px-12 py-10">
            <div className="mx-auto max-w-5xl">
              <div className="relative flex flex-col items-center">
                <div className="w-full max-w-[560px] rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-emerald-500" />
                    <h3 className="text-sm font-semibold text-gray-900">
                      Parent Module
                    </h3>
                  </div>

                  <select
                    className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                    value={parentModule}
                    onChange={e => loadFirstLevel(e.target.value)}
                  >
                    <option value="">Select parent module</option>
                    {parents.map(parent => (
                      <option key={parent.module_key} value={parent.module_key}>
                        {parent.label}
                      </option>
                    ))}
                  </select>

                  <p className="mt-3 text-sm text-gray-600">
                    {selectedParent
                      ? `Show all ${selectedParent.label}`
                      : 'Main module of this report.'}
                  </p>
                </div>

                {loadingInitial && (
                  <div className="mt-8 flex items-center gap-2 text-sm text-gray-500">
                    <Loader2 size={16} className="animate-spin" />
                    Loading related modules...
                  </div>
                )}

                {parentRelation && cards.map((card, index) => (
                  <div key={card.id} className="flex w-full flex-col items-center">
                    <div className="h-10 w-px bg-gray-300" />

                    <div className="z-10 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm">
                      <Plus size={15} />
                    </div>

                    <div className="h-10 w-px bg-gray-300" />

                    <div className="w-full max-w-[560px] rounded-lg border border-blue-200 bg-blue-50 p-4">
                      <div className="mb-3 flex items-center gap-2">
                        <span className="h-3 w-3 rounded-full bg-blue-500" />
                        <div>
                          <h3 className="text-sm font-semibold text-gray-900">
                            Child Module
                          </h3>
                          <p className="text-xs text-gray-500">{card.title}</p>
                        </div>
                      </div>

                      {card.loading ? (
                        <div className="flex h-11 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-500">
                          <Loader2 size={16} className="animate-spin" />
                          Loading next modules...
                        </div>
                      ) : (
                        <select
                          className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                          value={card.selected?.report_type_key || ''}
                          onChange={e => handleCardSelect(index, e.target.value)}
                        >
                          <option value="">Select child module</option>
                          {card.options.map(option => (
                            <option
                              key={`${option.chain_key}-${option.module_key}-${option.report_type_key}`}
                              value={option.report_type_key}
                            >
                              {option.label}
                            </option>
                          ))}
                        </select>
                      )}

                      <p className="mt-3 truncate text-sm text-gray-600">
                        {card.selected?.description ||
                          'Select a connected module or choose None to stop here.'}
                      </p>
                    </div>
                  </div>
                ))}

                {finalRelation && (
                  <div className="mt-8 w-full max-w-[760px] rounded-xl border border-gray-200 bg-gray-50 p-5">
                    <div className="text-sm font-semibold text-gray-900">
                      Selected Report Chain
                    </div>

                    <div className="mt-2 text-sm text-gray-700">
                      {chainLabel(finalRelation.module_chain || [])}
                    </div>

                    <div className="mt-2 text-xs text-gray-500">
                      Report Type:{' '}
                      <span className="font-mono text-blue-700">
                        {finalRelation.report_type_key}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function BusinessReportTemplateSelector({
  categories,
  onCancel,
  onContinue,
}: {
  categories: BusinessReportCategory[]
  onCancel: () => void
  onContinue: (selection: BusinessTemplateResolveResponse) => void
}) {
  const [categoryKey, setCategoryKey] = useState(categories[0]?.category_key || '')
  const [selectedTemplateKey, setSelectedTemplateKey] = useState('')
  const [templateDetail, setTemplateDetail] = useState<BusinessReportTemplateDetail | null>(null)
  const [selectedRelatedModules, setSelectedRelatedModules] = useState<string[]>([])
  const [loadingTemplate, setLoadingTemplate] = useState(false)
  const [resolving, setResolving] = useState(false)
  const { label: customerLabel } = useModuleName('customers')
  const { label: leadLabel } = useModuleName('leads')
  const { label: opportunityLabel } = useModuleName('opportunities')
  const { label: tenderLabel } = useModuleName('tenders')
  const { label: quotationLabel } = useModuleName('quotations')
  const { label: workOrderLabel } = useModuleName('workorders')
  const { label: emdbgLabel } = useModuleName('emdbg')
  const { label: kamLabel } = useModuleName('kam')
  const { label: travelLabel } = useModuleName('travel')
  const { label: usersLabel } = useModuleName('users')
  const reportModuleLabels = {
    customers: customerLabel,
    leads: leadLabel,
    opportunities: opportunityLabel,
    tenders: tenderLabel,
    quotations: quotationLabel,
    workorders: workOrderLabel,
    emdbg: emdbgLabel,
    kam_activities: kamLabel,
    travel: travelLabel,
    users: usersLabel,
  }

  useEffect(() => {
    if (!categoryKey && categories.length) {
      setCategoryKey(categories[0].category_key)
    }
  }, [categories, categoryKey])

  const selectedCategory = categories.find(category => category.category_key === categoryKey)
  const templates = selectedCategory?.templates || []
  const selectedTemplate = templates.find(template => template.template_key === selectedTemplateKey)

  const validCombinationKeys = useMemo(() => {
    return new Set(
      (templateDetail?.available_combinations || []).map(combination =>
        combination.related_modules.join('|'),
      ),
    )
  }, [templateDetail])

  const orderedRelatedModules = useMemo(
    () => templateDetail?.allowed_related_modules.map(module => module.module_key) || [],
    [templateDetail],
  )

  function normalizeRelatedSelection(modules: string[]) {
    const selected = new Set(modules)
    return orderedRelatedModules.filter(moduleKey => selected.has(moduleKey))
  }

  function relatedKey(modules: string[]) {
    return normalizeRelatedSelection(modules).join('|')
  }

  const selectedCombination = useMemo(() => {
    const key = relatedKey(selectedRelatedModules)
    return (templateDetail?.available_combinations || []).find(
      combination => combination.related_modules.join('|') === key,
    ) || null
  }, [templateDetail, selectedRelatedModules, orderedRelatedModules])

  async function chooseTemplate(template: BusinessReportTemplate) {
    setSelectedTemplateKey(template.template_key)
    setTemplateDetail(null)
    setSelectedRelatedModules([])
    setLoadingTemplate(true)

    try {
      const res = await reportEngineApi.getBusinessTemplate(template.template_key)
      setTemplateDetail(res.data)
      setSelectedRelatedModules(res.data.default_related_modules || [])
    } catch (error) {
      console.error(error)
      toast('error', 'Failed to load business report template')
    } finally {
      setLoadingTemplate(false)
    }
  }

  function canToggleModule(moduleKey: string) {
    if (!templateDetail) return false

    const next = selectedRelatedModules.includes(moduleKey)
      ? selectedRelatedModules.filter(key => key !== moduleKey)
      : [...selectedRelatedModules, moduleKey]

    return validCombinationKeys.has(relatedKey(next))
  }

  function toggleRelatedModule(moduleKey: string) {
    if (!canToggleModule(moduleKey)) return

    setSelectedRelatedModules(prev => {
      const next = prev.includes(moduleKey)
        ? prev.filter(key => key !== moduleKey)
        : [...prev, moduleKey]
      return normalizeRelatedSelection(next)
    })
  }

  async function continueToBuilder() {
    if (!templateDetail || !selectedCombination) {
      toast('error', 'Select a valid report template combination')
      return
    }

    setResolving(true)

    try {
      const res = await reportEngineApi.resolveBusinessTemplate({
        template_key: templateDetail.template_key,
        primary_module: templateDetail.primary_module,
        related_modules: selectedCombination.related_modules,
      })
      onContinue(res.data)
    } catch (error) {
      console.error(error)
      toast('error', 'Failed to resolve report template')
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-gray-50">
      <div className="border-b border-gray-200 bg-white">
        <div className="flex items-center gap-2 border-b border-gray-100 px-6 py-2 text-sm text-gray-500">
          <span>Reports</span>
          <ChevronRight size={14} />
          <span>Create Report</span>
        </div>

        <div className="flex items-center justify-between gap-4 px-6 py-5">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Create Report</h1>
            <p className="mt-1 text-sm text-gray-500">
              Choose a business report template
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>

            <button
              type="button"
              disabled={!selectedCombination || resolving}
              onClick={continueToBuilder}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {resolving && <Loader2 size={15} className="animate-spin" />}
              Continue
            </button>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-4 overflow-hidden p-4">
        <div className="overflow-auto rounded-lg border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-4 py-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Report Category
            </div>
          </div>

          <div className="p-2">
            {categories.map(category => (
              <button
                key={category.category_key}
                type="button"
                onClick={() => {
                  setCategoryKey(category.category_key)
                  setSelectedTemplateKey('')
                  setTemplateDetail(null)
                  setSelectedRelatedModules([])
                }}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm transition ${
                  categoryKey === category.category_key
                    ? 'bg-blue-50 font-semibold text-blue-700'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span>{category.label}</span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                  {category.templates.length}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 overflow-auto rounded-lg border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-5 py-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Business Report Template
                </div>
                <h2 className="mt-1 text-base font-semibold text-gray-900">
                  {selectedCategory?.label || 'Report Templates'}
                </h2>
              </div>

              {templateDetail && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                  <span className="font-medium text-gray-800">
                    {templateDetail.primary_module_label}
                  </span>
                  {selectedRelatedModules.length > 0 && (
                    <span> with {modulesLabel(selectedRelatedModules, reportModuleLabels)}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-3">
              {templates.map(template => {
                const isSelected = template.template_key === selectedTemplateKey
                return (
                  <button
                    key={template.template_key}
                    type="button"
                    onClick={() => chooseTemplate(template)}
                    className={`w-full rounded-lg border p-4 text-left transition ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50/70 shadow-sm'
                        : 'border-gray-200 bg-white hover:border-blue-200 hover:bg-blue-50/30'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-sm font-semibold text-gray-900">
                          {template.template_name}
                        </h3>
                        <p className="mt-1 text-sm text-gray-600">
                          {template.description}
                        </p>
                      </div>

                      <FileText
                        size={18}
                        className={isSelected ? 'text-blue-600' : 'text-gray-300'}
                      />
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 font-medium text-emerald-700">
                        Primary: {template.primary_module_label}
                      </span>
                      <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-1 text-gray-600">
                        Related: {modulesLabel(template.default_related_modules, reportModuleLabels)}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="rounded-lg border border-gray-200 bg-gray-50">
              <div className="border-b border-gray-200 px-4 py-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                  Related Modules
                </div>
              </div>

              <div className="p-4">
                {!selectedTemplate && (
                  <div className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-8 text-center text-sm text-gray-500">
                    Select a template
                  </div>
                )}

                {loadingTemplate && (
                  <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-8 text-sm text-gray-500">
                    <Loader2 size={16} className="animate-spin" />
                    Loading template
                  </div>
                )}

                {templateDetail && !loadingTemplate && (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-emerald-200 bg-white p-3">
                      <div className="text-xs font-semibold uppercase tracking-wider text-emerald-600">
                        Primary Module
                      </div>
                      <div className="mt-1 text-sm font-semibold text-gray-900">
                        {templateDetail.primary_module_label}
                      </div>
                    </div>

                    {templateDetail.allowed_related_modules.map(module => {
                      const selected = selectedRelatedModules.includes(module.module_key)
                      const enabled = canToggleModule(module.module_key)
                      return (
                        <button
                          key={module.module_key}
                          type="button"
                          disabled={!enabled}
                          onClick={() => toggleRelatedModule(module.module_key)}
                          className={`flex w-full items-center justify-between rounded-lg border bg-white p-3 text-left transition ${
                            selected
                              ? 'border-blue-500 text-blue-700 shadow-sm'
                              : enabled
                                ? 'border-gray-200 text-gray-700 hover:border-blue-300'
                                : 'cursor-not-allowed border-gray-200 text-gray-300'
                          }`}
                        >
                          <span className="text-sm font-medium">{module.label}</span>
                          <span
                            className={`flex h-5 w-5 items-center justify-center rounded border ${
                              selected
                                ? 'border-blue-600 bg-blue-600 text-white'
                                : 'border-gray-300 bg-white'
                            }`}
                          >
                            {selected && <Check size={13} />}
                          </span>
                        </button>
                      )
                    })}

                    <div className="rounded-lg border border-gray-200 bg-white p-3">
                      <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                        Resolved Type
                      </div>
                      <div className="mt-1 font-mono text-xs text-blue-700">
                        {selectedCombination?.report_type_key || 'No valid combination'}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Quick Filters (linkage/analytical reports) ────────────────────────────
// Business-friendly filter shortcuts shown above the report table. Kept in
// code (not DB) like REPORT_ENGINE_CONFIG on the backend — this is the UI-side
// mirror of each report's quick_search_fields/filterable columns. A field
// listed here that isn't actually filterable on the active report type is
// hidden at render time rather than shown broken.
interface QuickFilterConfig {
  searchFields: string[]
  statusFields: string[]
  dateField: string
  amountFields: string[]
}

const QUICK_FILTER_CONFIG: Record<string, QuickFilterConfig> = {
  customer_pipeline: {
    searchFields: ['customer_name', 'lead_title', 'quotation_number'],
    statusFields: ['lead_status', 'quotation_status', 'customer_status'],
    dateField: 'created_at',
    amountFields: ['lead_value', 'quotation_amount'],
  },
  lead_linkage: {
    searchFields: ['lead_title', 'tender_title', 'quotation_number', 'work_order_number'],
    statusFields: ['status', 'tender_status', 'quotation_status', 'work_order_status'],
    dateField: 'created_at',
    amountFields: ['est_value', 'quotation_amount', 'work_order_value'],
  },
  tender_linkage: {
    searchFields: ['tender_ref_id', 'tender_title', 'quotation_number', 'work_order_number', 'emd_bg_number'],
    statusFields: ['status', 'quotation_status', 'work_order_status', 'emd_bg_status'],
    dateField: 'created_at',
    amountFields: ['bid_amount', 'emd_bg_amount', 'work_order_value'],
  },
  quotation_linkage: {
    searchFields: ['quotation_number', 'subject', 'lead_title', 'tender_title', 'work_order_number'],
    statusFields: ['status', 'work_order_status'],
    dateField: 'created_at',
    amountFields: ['amount', 'total_amount', 'work_order_value'],
  },
  workorder_linkage: {
    searchFields: ['wo_number', 'project_title', 'lead_title', 'tender_title', 'quotation_number'],
    statusFields: ['status', 'quotation_status'],
    dateField: 'created_at',
    amountFields: ['po_value', 'wo_value'],
  },
  emdbg_linkage: {
    searchFields: ['instrument_number', 'tender_ref_id', 'tender_title', 'lead_title', 'work_order_number'],
    statusFields: ['status', 'work_order_status'],
    dateField: 'expiry_date',
    amountFields: ['amount'],
  },
  // Base report types — these back "All Customers", "All Leads", and every
  // Saved Report built on top of them (Active Customers, Converted Leads,
  // etc. all use these same report_type_key values under the hood).
  leads: {
    searchFields: ['lead_title', 'customer_name'],
    statusFields: ['status', 'priority'],
    dateField: 'created_at',
    amountFields: ['est_value'],
  },
  customers: {
    searchFields: ['customer_name'],
    statusFields: ['account_status'],
    dateField: 'created_at',
    amountFields: [],
  },
  tenders: {
    searchFields: ['tender_ref_id', 'tender_title', 'customer_name'],
    statusFields: ['status', 'result'],
    dateField: 'created_at',
    amountFields: ['bid_amount'],
  },
  quotations: {
    searchFields: ['quotation_number', 'subject', 'customer_name'],
    statusFields: ['status'],
    dateField: 'created_at',
    amountFields: ['total_amount'],
  },
  workorders: {
    searchFields: ['wo_number', 'project_title', 'customer_name'],
    statusFields: ['status'],
    dateField: 'created_at',
    amountFields: ['po_value', 'wo_value'],
  },
  emdbg: {
    searchFields: ['instrument_number', 'tender_title', 'customer_name'],
    statusFields: ['status'],
    dateField: 'expiry_date',
    amountFields: ['amount'],
  },
  questionnaire: {
    searchFields: ['customer_name'],
    statusFields: ['status'],
    // No dateField — last_saved_at doesn't support the 'between' operator the
    // "All Time" preset filter needs (backend 400s), and this report's raw
    // date-range inputs already cover date filtering.
    dateField: '',
    amountFields: [],
  },
  questionnaire_user: {
    searchFields: ['role_name', 'user_name', 'customer_name', 'questionnaire_name'],
    statusFields: ['status'],
    dateField: 'last_activity_at',
    amountFields: [],
  },
  questionnaire_user_detail: {
    searchFields: ['user_name', 'customer_name', 'questionnaire_name', 'question_label', 'field_label', 'answer_value'],
    statusFields: ['status'],
    dateField: 'last_activity_at',
    amountFields: [],
  },
  questionnaire_sections: {
    // Backend already supports quick_search_fields: ["section_name"] for this
    // report type (report_engine_router.py), so this is a free-text section
    // name search box.
    searchFields: ['section_name'],
    statusFields: ['structure_type'],
    dateField: '',
    amountFields: [],
  },
}

// Human-readable labels for the Questionnaire report's Status quick filter —
// mirrors STATUS_LABEL in QuestionnaireInsightModal.tsx so the dropdown text
// matches the StatusPill shown elsewhere for the same values.
const QUESTIONNAIRE_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
]

// structure_type has no enum_values seeded on the backend field metadata, so
// the generic quickStatusFieldMeta?.enum_values fallback would render an
// empty dropdown — hardcode the two valid values from the DB enum instead.
const QUESTIONNAIRE_SECTIONS_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'section', label: 'Section' },
  { value: 'subsection', label: 'Subsection' },
]

const QUICK_DATE_PRESETS: Array<{ id: string; name: string }> = [
  { id: '', name: 'All Time' },
  { id: 'today', name: 'Today' },
  { id: 'this_week', name: 'This Week' },
  { id: 'this_month', name: 'This Month' },
  { id: 'this_quarter', name: 'This Quarter' },
]

const OWNER_FIELD_CANDIDATES = ['assigned_to', 'created_by']

// Never shown as a pickable/visible column anywhere in the Report Engine — the
// raw numeric id is a drilldown implementation detail, created_at is noise
// on every report by default, and the human-readable reference numbers
// (Quotation No., Lead ID, Tender ID, WO Number) are excluded from report
// output per business request. Still resolvable as a filter/sort field if a
// report genuinely needs it — this only hides it from column display.
const HIDDEN_COLUMN_KEYS = new Set([
  'id',
  'lead_id',
  'user_id',
  'customer_id',
  'questionnaire_id',
  'section_id',
  'subsection_id',
  'question_id',
  'field_id',
  'element_id',
  'created_at',
  'quotation_number',
  'lead_ref_id',
  'tender_ref_id',
  'wo_number',
  'work_order_number',
])

// ─── Linked Records (presentation-only view mode) ─────────────────────────
// Field keys shown only when the "Linked Records" view is selected — added
// to/removed from the field-picker selection, never a separate report type.
// Each field is a self-contained correlated-count subquery already added to
// REPORT_ENGINE_CONFIG; no joins, no row duplication. See
// report_engine_router.py for the SQL.
const LINKED_RECORD_FIELDS: Record<string, string[]> = {
  leads:         ['tender_count', 'quotation_count', 'work_order_count', 'activity_count'],
  opportunities: ['tender_count', 'quotation_count', 'work_order_count', 'activity_count'],
  tenders:       ['quotation_count', 'work_order_count', 'emdbg_count'],
  customers:     ['lead_count', 'opportunity_count', 'tender_count', 'quotation_count', 'work_order_count'],
}

// ─── Record View Panel — which field opens the record, and as which entity ──
// This click is entirely separate from the existing report-to-report
// drilldown (count fields, wired via DB drilldown_kind metadata): it never
// touches that mechanism, it only opens the docked panel via the same data
// hook the Reports section's DrilldownDrawer uses.
const RECORD_IDENTITY_FIELD: Record<string, { fieldKey: string; entity: DrilldownEntity; idField?: string }> = {
  leads:              { fieldKey: 'lead_title',      entity: 'lead' },
  opportunities:      { fieldKey: 'lead_title',      entity: 'lead' },
  tenders:            { fieldKey: 'tender_title',     entity: 'tender' },
  customers:          { fieldKey: 'customer_name',    entity: 'customer' },
  quotations:         { fieldKey: 'quotation_number', entity: 'quotation' },
  workorders:         { fieldKey: 'wo_number',        entity: 'workorder' },
  // Composite/chain report types — one row per linked child record, but the
  // identity click still opens the parent (e.g. the lead), whose own record
  // panel already has a "Quotations"/"Work Orders" tab listing every linked
  // record in full, same as the standalone leads/tenders reports.
  // idField is only needed when the report's base table isn't the identity
  // entity itself (e.g. quotation_workorder's base row is a quotation, so its
  // generic "id" is the quotation's id, not the lead's — a separate lead_id
  // field carries the actual lead id for the drilldown fetch).
  customer_leads:     { fieldKey: 'lead_title',      entity: 'lead' },
  customer_pipeline:  { fieldKey: 'lead_title',      entity: 'lead', idField: 'lead_id' },
  lead_quotation:     { fieldKey: 'lead_title',      entity: 'lead' },
  quotation_workorder:{ fieldKey: 'lead_title',      entity: 'lead', idField: 'lead_id' },
  tender_workorder:   { fieldKey: 'tender_title',     entity: 'tender' },
}

// ─── Questionnaire Insight Modal — which field on which questionnaire report
// type opens the informative drill-down (stat tiles + chart + list) instead
// of the generic identity/report-to-report drilldown below. Checked first in
// the cell renderer; entirely additive — doesn't touch DrilldownEntity,
// RECORD_IDENTITY_FIELD, or DRILLDOWN_TARGET_ENTITY, so every other report
// type's drilldown behavior is unaffected.
const QUESTIONNAIRE_INSIGHT_TRIGGER: Record<string, { fieldKey: string; mode: QuestionnaireInsightMode }> = {
  questionnaire_user:      { fieldKey: 'role_name',          mode: 'role' },
  questionnaire_adoption:  { fieldKey: 'questionnaire_name', mode: 'adoption' },
  questionnaire_sections:  { fieldKey: 'section_name',       mode: 'section' },
  questionnaire_questions: { fieldKey: 'question_label',     mode: 'question' },
  questionnaire:           { fieldKey: 'customer_name',      mode: 'customer' },
  questionnaire_answers:   { fieldKey: 'customer_name',      mode: 'customer' },
}

// The row id the modal needs for each questionnaire report type — force-added
// to every request's `fields` below (buildBody), the same way `recordIdentity`
// already force-adds 'id'/idField for the generic Record View Panel. Relying
// solely on the backend's optional drilldown_id_field hidden-column metadata
// isn't safe: that metadata can be stale/missing for a given DB, silently
// dropping the id from the row and breaking the modal (customer_id missing).
const QUESTIONNAIRE_INSIGHT_ID_FIELD: Record<string, string[]> = {
  questionnaire_user:      ['role_name'],
  questionnaire_adoption:  ['id'],
  // structure_type distinguishes a "section" row from a "subsection" row —
  // SectionScreen needs it to know whether to filter the question list by
  // section_id or subsection_id (a subsection's questions carry subsection_id,
  // not section_id, even though the stat tiles above the list count both).
  questionnaire_sections:  ['id', 'structure_type'],
  questionnaire_questions: ['id'],
  questionnaire:           ['customer_id'],
  questionnaire_answers:   ['customer_id'],
}

// ─── Cross-entity reference fields (customer/lead/tender/quotation/work order
// columns that appear on a report whose base row is a *different* entity) —
// every one of these is wired in the seed data as a "report" drilldown that
// targets one of the *_linkage report types. Rather than navigating to that
// linkage report page, every such click opens the same docked Record View
// Panel used for the primary identity field above, keyed by the linkage
// report's target entity. This keeps drilldown behavior for every report in
// the engine consistent: clicking any record reference always opens its
// record view, never a different full report page.
const DRILLDOWN_TARGET_ENTITY: Record<string, DrilldownEntity> = {
  lead_linkage:      'lead',
  customer_pipeline: 'customer',
  tender_linkage:    'tender',
  workorder_linkage: 'workorder',
  quotation_linkage: 'quotation',
  emdbg_linkage:     'emdbg',
}

function reportRoute(typeKey: string) {
  return `/reports/${encodeURIComponent(typeKey)}`
}

const RECORD_PARAM_ENTITIES = new Set<DrilldownEntity>([
  'customer',
  'lead',
  'tender',
  'emdbg',
  'workorder',
  'quotation',
])

function encodeRecordParam(request: DrilldownRequest) {
  return `${request.entity}:${encodeURIComponent(String(request.id))}`
}

function parseRecordParam(value: string | null): DrilldownRequest | null {
  if (!value) return null

  const separatorIndex = value.indexOf(':')
  if (separatorIndex <= 0) return null

  const entity = value.slice(0, separatorIndex) as DrilldownEntity
  if (!RECORD_PARAM_ENTITIES.has(entity)) return null

  const encodedId = value.slice(separatorIndex + 1)
  if (!encodedId) return null

  try {
    return { entity, id: decodeURIComponent(encodedId) }
  } catch {
    return null
  }
}

function sameRecordRequest(left: DrilldownRequest | null, right: DrilldownRequest | null) {
  if (!left || !right) return left === right
  return left.entity === right.entity && String(left.id) === String(right.id)
}

// Converts a quick date preset into a [from, to] ISO date pair for a `between`
// filter — kept separate from the existing raw date-range inputs (which stay
// wired to the report's default date_field, unaffected by this).
function quickPresetRange(preset: string): [string, string] | null {
  if (!preset) return null
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

  switch (preset) {
    case 'today': {
      const d = startOfDay(now)
      return [iso(d), iso(d)]
    }
    case 'this_week': {
      const d = startOfDay(now)
      const dow = (d.getDay() + 6) % 7
      const start = new Date(d)
      start.setDate(d.getDate() - dow)
      const end = new Date(start)
      end.setDate(start.getDate() + 6)
      return [iso(start), iso(end)]
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      return [iso(start), iso(end)]
    }
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3)
      const start = new Date(now.getFullYear(), q * 3, 1)
      const end = new Date(now.getFullYear(), q * 3 + 3, 0)
      return [iso(start), iso(end)]
    }
    default:
      return null
  }
}

function ReportBuilder({
  reportTypes,
  initialTypeKey,
  initialConfig,
  initialRelation,
  savedReportId,
  savedReportName,
  folders,
  onBack,
  onSaved,
}: {
  reportTypes: ReportType[]
  initialTypeKey: string
  initialConfig: ReportConfig | null
  initialRelation: ReportModuleChild | null
  savedReportId: number | null
  savedReportName: string
  folders: ReportFolder[]
  onBack: () => void
  onSaved: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const { label: customerLabel } = useModuleName('customers')
  const { label: leadLabel } = useModuleName('leads')
  const { label: opportunityLabel } = useModuleName('opportunities')
  const { label: tenderLabel } = useModuleName('tenders')
  const { label: quotationLabel } = useModuleName('quotations')
  const { label: workOrderLabel } = useModuleName('workorders')
  const { label: emdbgLabel } = useModuleName('emdbg')
  const { label: kamLabel } = useModuleName('kam')
  const { label: travelLabel } = useModuleName('travel')
  const { label: usersLabel } = useModuleName('users')
  const reportModuleLabels = {
    customers: customerLabel,
    leads: leadLabel,
    opportunities: opportunityLabel,
    tenders: tenderLabel,
    quotations: quotationLabel,
    workorders: workOrderLabel,
    emdbg: emdbgLabel,
    kam_activities: kamLabel,
    travel: travelLabel,
    users: usersLabel,
  }
  const [typeFields, setTypeFields] = useState<ReportTypeField[]>([])
  const [selectedFields, setSelectedFields] = useState<string[]>([])
  const [dateFrom, setDateFrom] = useState(initialConfig?.date_from || '')
  const [dateTo, setDateTo] = useState(initialConfig?.date_to || '')
  const [result, setResult] = useState<ReportResult | null>(null)
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | null>(null)
  const handleSort = (key: string) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc')
      else { setSortDir(null); setSortKey(null) }
    } else {
      setSortKey(key); setSortDir('asc')
    }
  }
  useEffect(() => { setSortKey(null); setSortDir(null) }, [result])
  // Row selection (checkboxes) — only rendered for the Questionnaire report,
  // where it feeds the Export dialog's "Selected Customers" scope.
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<number>>(new Set())
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  useEffect(() => { setSelectedCustomerIds(new Set()) }, [result])
  const [loadingFields, setLoadingFields] = useState(false)
  const [running, setRunning] = useState(false)
  const [advancedFilters, setAdvancedFilters] = useState<FilterItem[]>(initialConfig?.filters || [])
  // Drilldown-context filters (e.g. the id behind a clicked customer_name/lead_title/etc.).
  // Never editable, never removable, never part of a saved filter preset.
  const [lockedFilters] = useState<FilterItem[]>(initialConfig?.locked_filters || [])
  const [saving, setSaving] = useState(false)
  const [fieldsDropdownOpen, setFieldsDropdownOpen] = useState(false)
  const fieldsDropdownRef = useRef<HTMLDivElement>(null)
  const [showFilters, setShowFilters] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [reportName, setReportName] = useState(savedReportName || '')
  const [reportDescription, setReportDescription] = useState('')
  const [folderId, setFolderId] = useState<number | undefined>(undefined)
  const [visibility, setVisibility] = useState<'private' | 'org'>('private')
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(25)
  const [goToPage, setGoToPage] = useState('')

  // --- Quick Filters ---
  const [quickSearch, setQuickSearch] = useState('')
  const [quickStatus, setQuickStatus] = useState('')
  const [quickDatePreset, setQuickDatePreset] = useState('')
  const [quickOwner, setQuickOwner] = useState('')
  const [quickAmountMin, setQuickAmountMin] = useState('')
  const [quickAmountMax, setQuickAmountMax] = useState('')
  const [ownerOptions, setOwnerOptions] = useState<Array<{ id: number; full_name: string }>>([])
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])
  const [selectedSavedFilterId, setSelectedSavedFilterId] = useState<number | null>(null)
  const [savedFiltersOpen, setSavedFiltersOpen] = useState(false)
  const [saveFilterOpen, setSaveFilterOpen] = useState(false)
  const [saveFilterName, setSaveFilterName] = useState('')
  const [saveFilterVisibility, setSaveFilterVisibility] = useState<'private' | 'org'>('private')
  const [savingFilter, setSavingFilter] = useState(false)
  const skipNextAutoRun = useRef(true)

  // "Linked Records" is a presentation-only view mode: it adds/removes a
  // fixed set of correlated-count fields from selectedFields for this report
  // type. It is not a separate report type and never changes report_type_key.
  const [viewMode, setViewMode] = useState<'standard' | 'linked'>('standard')
  const linkedRecordFieldKeys = LINKED_RECORD_FIELDS[initialTypeKey] || []
  const recordIdentity = RECORD_IDENTITY_FIELD[initialTypeKey]
  const insightTrigger = QUESTIONNAIRE_INSIGHT_TRIGGER[initialTypeKey]
  // Gates the row-selection checkboxes and the scope/format/structure Export
  // dialog — every other report type keeps the plain single-click ExportMenu.
  const isQuestionnaireReport = initialTypeKey === 'questionnaire'

  // Record View Panel — opened by clicking a record's name/number (separate
  // from the count-field drilldown, which still uses handleDrilldownClick).
  const [recordView, setRecordView] = useState<DrilldownRequest | null>(null)
  const recordOpenedByClickRef = useRef(false)

  // Questionnaire Insight Modal — opened by clicking a questionnaire/section/
  // question/customer identity field on the 5 questionnaire report types.
  const [insight, setInsight] = useState<QuestionnaireInsightRequest | null>(null)

  const viewModeMounted = useRef(false)
  const recordParam = useMemo(() => new URLSearchParams(location.search).get('record'), [location.search])

  useEffect(() => {
    const nextRecordView = parseRecordParam(recordParam)

    setRecordView(prev => {
      if (!nextRecordView) {
        recordOpenedByClickRef.current = false
        return null
      }

      return sameRecordRequest(prev, nextRecordView) ? prev : nextRecordView
    })
  }, [recordParam])

  function navigateWithRecordParam(request: DrilldownRequest | null, replace = false) {
    const params = new URLSearchParams(location.search)

    if (request) {
      params.set('record', encodeRecordParam(request))
    } else {
      params.delete('record')
    }

    const search = params.toString()
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : '' },
      { replace },
    )
  }

  function openRecordView(request: DrilldownRequest) {
    recordOpenedByClickRef.current = true
    setRecordView(request)
    navigateWithRecordParam(request, !!recordParam)
  }

  function closeRecordView() {
    if (new URLSearchParams(location.search).has('record')) {
      if (recordOpenedByClickRef.current) {
        navigate(-1)
        return
      }

      navigateWithRecordParam(null, true)
      return
    }

    setRecordView(null)
  }

  function toggleViewMode(mode: 'standard' | 'linked') {
    if (mode === viewMode) return
    setViewMode(mode)
    if (linkedRecordFieldKeys.length) {
      setSelectedFields(prev =>
        mode === 'linked'
          ? Array.from(new Set([...prev, ...linkedRecordFieldKeys]))
          : prev.filter(fk => !linkedRecordFieldKeys.includes(fk)),
      )
    }
  }

  // Re-run automatically after the view-mode field-list change lands (skips the
  // very first mount — the initial-load effect below already runs the report once).
  useEffect(() => {
    if (!viewModeMounted.current) {
      viewModeMounted.current = true
      return
    }
    if (selectedFields.length) runReport(1)
  }, [viewMode])

  const quickConfig = QUICK_FILTER_CONFIG[initialTypeKey]
  // A serialized primitive (not an object literal) so useDebounce's dependency
  // check is by value, not by a fresh reference on every unrelated re-render.
  const quickFilterKey = JSON.stringify([quickSearch, quickStatus, quickDatePreset, quickOwner, quickAmountMin, quickAmountMax, dateFrom, dateTo])
  const debouncedQuickKey = useDebounce(quickFilterKey, 400)

  const pageNumbers = useMemo(() => {
    const totalPages = result?.pages ?? 1
    const range: (number | '...')[] = []
    const delta = 2
    const left  = Math.max(2, page - delta)
    const right = Math.min(totalPages - 1, page + delta)
    range.push(1)
    if (left > 2)               range.push('...')
    for (let i = left; i <= right; i++) range.push(i)
    if (right < totalPages - 1) range.push('...')
    if (totalPages > 1)         range.push(totalPages)
    return range
  }, [page, result?.pages])

  // Every cross-entity reference column (customer/lead/tender/quotation/work
  // order fields on a report whose base row is a different entity) is wired
  // in the seed data as a "report" drilldown targeting a *_linkage report
  // type. Rather than navigating away to that report, the click opens the
  // same docked Record View Panel used for the primary identity field — see
  // DRILLDOWN_TARGET_ENTITY. There is no detail/360/edit-form navigation path
  // here by design; a stray drilldown_kind other than 'report' is simply
  // ignored (the cell renderer already treats it as non-clickable text).
  function handleDrilldownClick(fieldMeta: ReportTypeField, row: Record<string, unknown>) {
    if (fieldMeta.drilldown_kind !== 'report' || !fieldMeta.drilldown_target || !fieldMeta.drilldown_filter_field) return
    const idValue = row[fieldMeta.drilldown_id_field || '']
    if (idValue === null || idValue === undefined || idValue === '') return

    const entity = DRILLDOWN_TARGET_ENTITY[fieldMeta.drilldown_target]
    if (entity) {
      openRecordView({
        entity,
        id: idValue as number | string,
        label: String(row[fieldMeta.field_key] ?? ''),
        seedRow: row,
      })
      return
    }

    navigate(reportRoute(fieldMeta.drilldown_target), {
      state: {
        initialTypeKey: fieldMeta.drilldown_target,
        backTypeKey: initialTypeKey,
        initialConfig: {
          locked_filters: [
            { field: fieldMeta.drilldown_filter_field, operator: 'eq', value: idValue },
          ],
        } as ReportConfig,
      },
    })
  }

  const activeType = reportTypes.find(rt => rt.key === initialTypeKey)

  // Never offered as a pickable/visible column — the raw id is a drilldown
  // implementation detail and created_at clutters every report by default.
  const pickableFields = useMemo(
    () => typeFields.filter(f => !HIDDEN_COLUMN_KEYS.has(f.field_key)),
    [typeFields],
  )

  const fieldsByModule = useMemo(() => {
    const grouped: Record<string, ReportTypeField[]> = {}

    pickableFields.forEach(field => {
      const moduleLabel = field.module_label || field.module_key || 'Other'
      if (!grouped[moduleLabel]) grouped[moduleLabel] = []
      grouped[moduleLabel].push(field)
    })

    return grouped
  }, [pickableFields])

  const filterableFields = useMemo(
    () => typeFields.filter(f => f.is_filterable),
    [typeFields],
  )

  // Distinct filter values fetched per field from the tenant's actual data (scope-safe
  // on the backend). undefined = never requested; [] = loading / no values → text input.
  const [filterValueOptions, setFilterValueOptions] = useState<Record<string, string[]>>({})

  useEffect(() => {
    const fieldsToLoad = advancedFilters
      .map(f => f.field)
      .filter(fk => {
        if (!fk || filterValueOptions[fk] !== undefined) return false
        const meta = filterableFields.find(f => f.field_key === fk)
        if (!meta || meta.enum_values?.length) return false
        return meta.data_type === 'text'
      })
    if (!fieldsToLoad.length) return
    setFilterValueOptions(prev => {
      const next = { ...prev }
      fieldsToLoad.forEach(fk => { next[fk] = [] })
      return next
    })
    fieldsToLoad.forEach(fk => {
      reportEngineApi
        .getFilterValues(initialTypeKey, fk)
        .then(res => setFilterValueOptions(prev => ({ ...prev, [fk]: res.data?.values || [] })))
        .catch(() => { /* keep [] — falls back to free-text input */ })
    })
  }, [advancedFilters, filterableFields, filterValueOptions, initialTypeKey])

  const ownerField = useMemo(
    () => OWNER_FIELD_CANDIDATES.find(fk => filterableFields.some(f => f.field_key === fk)) || null,
    [filterableFields],
  )

  // Owner list is admin/manager-gated on the backend — fetched best-effort and
  // hidden gracefully (like any other quick filter with no available field) if
  // the current user can't call it.
  useEffect(() => {
    if (!ownerField) return
    authApi
      .listUsers()
      .then(res => setOwnerOptions((res.data as Array<{ id: number; full_name: string }>) || []))
      .catch(() => setOwnerOptions([]))
  }, [ownerField])

  useEffect(() => {
    reportEngineApi
      .getSavedFilters(initialTypeKey)
      .then(res => setSavedFilters(res.data || []))
      .catch(() => setSavedFilters([]))
  }, [initialTypeKey])

  useEffect(() => {
    if (!fieldsDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (fieldsDropdownRef.current && !fieldsDropdownRef.current.contains(e.target as Node)) {
        setFieldsDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [fieldsDropdownOpen])

  // Quick filter controls hide gracefully (rather than render broken) when the
  // report type has no configured/available field to back them.
  const quickSearchAvailable = !!quickConfig && quickConfig.searchFields.some(fk => typeFields.some(f => f.field_key === fk))
  const quickStatusField = quickConfig ? quickConfig.statusFields.find(fk => filterableFields.some(f => f.field_key === fk)) : undefined
  const quickStatusFieldMeta = quickStatusField ? typeFields.find(f => f.field_key === quickStatusField) : undefined
  const quickDateAvailable = !!quickConfig && filterableFields.some(f => f.field_key === quickConfig.dateField)
  const quickAmountField = quickConfig ? quickConfig.amountFields.find(fk => filterableFields.some(f => f.field_key === fk)) : undefined
  const quickAmountLabel = quickAmountField ? (typeFields.find(f => f.field_key === quickAmountField)?.label || 'Amount') : 'Amount'
  const hasAnyQuickFilterActive = !!(quickSearch || quickStatus || quickDatePreset || quickOwner || quickAmountMin || quickAmountMax)

  useEffect(() => {
    setLoadingFields(true)
    setResult(null)

    reportEngineApi
      .getTypeFields(initialTypeKey)
      .then(res => {
        const fields = res.data || []
        setTypeFields(fields)

        let fieldsToUse: string[]
        if (initialConfig?.fields?.length) {
          fieldsToUse = initialConfig.fields
        } else {
          const pickable = fields.filter(f => !HIDDEN_COLUMN_KEYS.has(f.field_key))
          const defaults = pickable
            .filter(f => f.is_default_column)
            .map(f => f.field_key)
          fieldsToUse = defaults.length ? defaults : pickable.slice(0, 6).map(f => f.field_key)
        }
        setSelectedFields(fieldsToUse)

        if (!fieldsToUse.length) return
        setRunning(true)
        const insightIdFields = QUESTIONNAIRE_INSIGHT_ID_FIELD[initialTypeKey]
        const initialFields = Array.from(
          new Set([
            ...fieldsToUse,
            ...(recordIdentity ? ['id', ...(recordIdentity.idField ? [recordIdentity.idField] : [])] : []),
            ...(insightIdFields || []),
          ]),
        )

        reportEngineApi
          .runAdhoc({
            report_type_key: initialTypeKey,
            template_key: initialConfig?.template_key,
            primary_module: initialConfig?.primary_module,
            related_modules: initialConfig?.related_modules,
            parent_module: initialRelation?.parent_module || initialConfig?.parent_module || initialConfig?.primary_module,
            module_chain: initialRelation?.module_chain || initialConfig?.module_chain,
            child_modules: initialRelation?.child_modules || initialConfig?.child_modules || initialConfig?.related_modules,
            fields: initialFields,
            filters: [...lockedFilters, ...(initialConfig?.filters ? cleanFilters(initialConfig.filters) : [])],
            sort: initialConfig?.sort || [],
            date_from: initialConfig?.date_from || undefined,
            date_to: initialConfig?.date_to || undefined,
            page: 1,
            per_page: perPage,
          })
          .then(runRes => {
            setResult(runRes.data)
            setPage(1)
          })
          .catch(() => toast('error', 'Failed to run report'))
          .finally(() => setRunning(false))
      })
      .catch(() => {
        toast('error', 'Failed to load report fields')
      })
      .finally(() => {
        setLoadingFields(false)
      })
  }, [initialTypeKey, initialConfig?.fields])

function toggleField(fieldKey: string) {
  const nextFields = selectedFields.includes(fieldKey)
    ? selectedFields.filter(key => key !== fieldKey)
    : [...selectedFields, fieldKey]

  setSelectedFields(nextFields)

  if (nextFields.length > 0) {
    runReport(1, perPage, nextFields)
  } else {
    setResult(null)
  }
}


 function cleanFilters(items: FilterItem[]) {
  return items.filter(item => {
    if (['is_null', 'is_not_null'].includes(item.operator)) return true

    if (item.value === null || item.value === undefined) return false

    if (typeof item.value === 'string' && !item.value.trim()) return false

    if (Array.isArray(item.value) && item.value.length === 0) return false

    return true
  })
}

  function updateFilter(index: number, patch: Partial<FilterItem>) {
    setAdvancedFilters(prev => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  function addFilter() {
    const firstField = filterableFields[0]
    if (!firstField) return
    setAdvancedFilters(prev => [...prev, { field: firstField.field_key, operator: 'eq', value: '' }])
  }

  function removeFilter(index: number) {
    setAdvancedFilters(prev => prev.filter((_, i) => i !== index))
  }

  // Converts quick-filter UI state into backend FilterItem[] — never exposes raw
  // operators in the UI; those are chosen here internally per control type.
  function buildQuickFilters(): FilterItem[] {
    if (!quickConfig) return []
    const items: FilterItem[] = []

    const hasSearchField = quickConfig.searchFields.some(fk => typeFields.some(f => f.field_key === fk))
    if (hasSearchField && quickSearch.trim()) {
      items.push({ field: '__quick_search', operator: 'quick_search', value: quickSearch.trim() })
    }

    const statusField = quickConfig.statusFields.find(fk => filterableFields.some(f => f.field_key === fk))
    if (statusField && quickStatus) {
      items.push({ field: statusField, operator: 'eq', value: quickStatus })
    }

    if (quickDatePreset && filterableFields.some(f => f.field_key === quickConfig.dateField)) {
      const range = quickPresetRange(quickDatePreset)
      if (range) items.push({ field: quickConfig.dateField, operator: 'between', value: range })
    }

    if (ownerField && quickOwner) {
      items.push({ field: ownerField, operator: 'eq', value: Number(quickOwner) })
    }

    const amountField = quickConfig.amountFields.find(fk => filterableFields.some(f => f.field_key === fk))
    if (amountField && quickAmountMin.trim()) {
      items.push({ field: amountField, operator: 'gte', value: Number(quickAmountMin) })
    }
    if (amountField && quickAmountMax.trim()) {
      items.push({ field: amountField, operator: 'lte', value: Number(quickAmountMax) })
    }

    return items
  }

  function clearQuickFilters() {
    setQuickSearch('')
    setQuickStatus('')
    setQuickDatePreset('')
    setQuickOwner('')
    setQuickAmountMin('')
    setQuickAmountMax('')
    setSelectedSavedFilterId(null)
  }
///
function buildBody(
  targetPage = page,
  targetPerPage = perPage,
  fieldsOverride?: string[],
) {
  const fieldsToRun = fieldsOverride ?? selectedFields

  return {
    report_type_key: initialTypeKey,
    template_key: initialConfig?.template_key,
    primary_module: initialConfig?.primary_module,
    related_modules: initialConfig?.related_modules,
    parent_module:
      initialRelation?.parent_module ||
      initialConfig?.parent_module ||
      initialConfig?.primary_module,
    module_chain:
      initialRelation?.module_chain ||
      initialConfig?.module_chain,
    child_modules:
      initialRelation?.child_modules ||
      initialConfig?.child_modules ||
      initialConfig?.related_modules,

    fields: (() => {
      const extraFields: string[] = []
      if (recordIdentity) {
        extraFields.push('id')
        if (recordIdentity.idField) extraFields.push(recordIdentity.idField)
      }
      const insightIdFields = QUESTIONNAIRE_INSIGHT_ID_FIELD[initialTypeKey]
      if (insightIdFields) extraFields.push(...insightIdFields)
      return extraFields.length ? Array.from(new Set([...fieldsToRun, ...extraFields])) : fieldsToRun
    })(),

    filters: [
      ...lockedFilters,
      ...buildQuickFilters(),
      ...cleanFilters(advancedFilters),
    ],
    sort: initialConfig?.sort || [],
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    page: targetPage,
    per_page: targetPerPage,
  }
}
  async function runReport(
  targetPage = page,
  targetPerPage = perPage,
  fieldsOverride?: string[],
) {
  const fieldsToRun = fieldsOverride ?? selectedFields

  if (!fieldsToRun.length) {
    setResult(null)
    return
  }

  setRunning(true)

  try {
    const res = await reportEngineApi.runAdhoc(
      buildBody(targetPage, targetPerPage, fieldsToRun),
    )

    setResult(res.data)
    setPage(targetPage)
    setPerPage(targetPerPage)
  } catch (error) {
    console.error(error)
    toast('error', 'Failed to run report')
  } finally {
    setRunning(false)
  }
}

  function changePerPage(next: number) {
    runReport(1, next)
  }

  function goToPageSubmit() {
    const n = Number(goToPage)
    if (!Number.isFinite(n) || n < 1) return
    const target = result ? Math.min(Math.max(1, Math.floor(n)), result.pages) : Math.floor(n)
    runReport(target)
    setGoToPage('')
  }

  // Auto-run on quick filter change (debounced 400ms). Skips the very first
  // render (the fields-loading effect above already runs the report once) and
  // any run while report fields are still loading.
  useEffect(() => {
    if (skipNextAutoRun.current) {
      skipNextAutoRun.current = false
      return
    }
    if (loadingFields || !selectedFields.length) return
    runReport(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuickKey, loadingFields])

  // Applying a saved filter is a deliberate one-time action, not live typing —
  // run immediately (no debounce) rather than waiting on the quick-filter
  // debounce, which may not fire at all for an advanced-only preset.
  useEffect(() => {
    if (selectedSavedFilterId === null || loadingFields || !selectedFields.length) return
    runReport(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSavedFilterId])

  function applySavedFilter(id: number | null) {
    setSelectedSavedFilterId(id)
    setSavedFiltersOpen(false)
    if (id === null) {
      clearQuickFilters()
      setAdvancedFilters([])
      return
    }
    const preset = savedFilters.find(f => f.id === id)
    if (!preset) return
    const cfg: SavedFilterConfig = preset.config_json || {}
    const qf = cfg.quick_filters || {}
    setQuickSearch(String(qf.search ?? ''))
    setQuickStatus(String(qf.status ?? ''))
    setQuickDatePreset(String(qf.date_preset ?? ''))
    setQuickOwner(String(qf.owner ?? ''))
    setQuickAmountMin(String(qf.amount_min ?? ''))
    setQuickAmountMax(String(qf.amount_max ?? ''))
    setAdvancedFilters(cfg.advanced_filters || [])
  }

  async function saveCurrentFilter() {
    if (!saveFilterName.trim()) {
      toast('error', 'Filter name is required')
      return
    }
    setSavingFilter(true)
    try {
      const config_json: SavedFilterConfig = {
        quick_filters: {
          search: quickSearch,
          status: quickStatus,
          date_preset: quickDatePreset,
          owner: quickOwner,
          amount_min: quickAmountMin,
          amount_max: quickAmountMax,
        },
        advanced_filters: cleanFilters(advancedFilters),
      }
      await reportEngineApi.createSavedFilter({
        report_type_key: initialTypeKey,
        filter_name: saveFilterName.trim(),
        filter_type: 'mixed',
        visibility: saveFilterVisibility,
        config_json,
      })
      toast('success', 'Filter saved')
      setSaveFilterOpen(false)
      setSaveFilterName('')
      const res = await reportEngineApi.getSavedFilters(initialTypeKey)
      setSavedFilters(res.data || [])
    } catch (error) {
      console.error(error)
      toast('error', 'Failed to save filter')
    } finally {
      setSavingFilter(false)
    }
  }

  async function deleteSavedFilter(id: number) {
    try {
      await reportEngineApi.deleteSavedFilter(id)
      setSavedFilters(prev => prev.filter(f => f.id !== id))
      if (selectedSavedFilterId === id) setSelectedSavedFilterId(null)
    } catch {
      toast('error', 'Failed to delete saved filter')
    }
  }

  async function saveReport() {
    if (!reportName.trim()) {
      toast('error', 'Report name is required')
      return
    }

    if (!activeType) {
      toast('error', 'Invalid report type')
      return
    }

    setSaving(true)

    const config: ReportConfig = {
      report_type_key: initialTypeKey,
      template_key: initialConfig?.template_key,
      primary_module: initialConfig?.primary_module,
      related_modules: initialConfig?.related_modules,
      parent_module: initialRelation?.parent_module || initialConfig?.parent_module || initialConfig?.primary_module,
      module_chain: initialRelation?.module_chain || initialConfig?.module_chain,
      child_modules: initialRelation?.child_modules || initialConfig?.child_modules || initialConfig?.related_modules,
      chain_key: initialRelation?.chain_key || initialConfig?.chain_key,
      fields: selectedFields,
      filters: [...lockedFilters, ...buildQuickFilters(), ...cleanFilters(advancedFilters)],
      sort: initialConfig?.sort || [],
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      page: 1,
      per_page: perPage,
    }

    try {
      if (savedReportId) {
        await reportEngineApi.updateSaved(savedReportId, {
          name: reportName.trim(),
          description: reportDescription || undefined,
          folder_id: folderId,
          config_json: config,
        })
      } else {
        await reportEngineApi.createSaved({
          name: reportName.trim(),
          description: reportDescription || undefined,
          report_type_key: initialTypeKey,
          report_type_id: activeType.id,
          folder_id: folderId,
          visibility,
          config_json: config,
        })
      }

      setSaveOpen(false)
      toast('success', 'Report saved successfully')
      onSaved()
    } catch (error) {
      console.error(error)
      toast('error', 'Failed to save report')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-gray-50">
      <div className="border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              ← Reports
            </button>

            <div>
              <div className="flex items-center gap-2">
                <BarChart2 size={18} className="text-blue-600" />
                <h1 className="text-lg font-semibold text-gray-900">
                  {savedReportName ||
                    initialRelation?.report_type_name ||
                    activeType?.name ||
                    'Untitled Report'}
                </h1>
              </div>

              <p className="mt-1 text-sm text-gray-500">
               {initialConfig?.template_key && initialConfig.primary_module
  ? `${moduleLabel(initialConfig.primary_module, reportModuleLabels)}${initialConfig.related_modules?.length ? ` with ${modulesLabel(initialConfig.related_modules, reportModuleLabels)}` : ''}`
  : initialRelation?.module_chain?.length
    ? chainLabel(initialRelation.module_chain)
    : initialConfig?.module_chain?.length
      ? chainLabel(initialConfig.module_chain)
      : activeType?.description || 'Custom report'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Run report button hidden per request — keep code for later re-enable */}
            {false && (
            <button
              type="button"
              disabled={running}
              onClick={() => runReport(1)}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300"
            >
              {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              Run
            </button>
            )}

            <button
              type="button"
              onClick={() => setSaveOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              <Save size={16} />
              Save
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
        <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {/* Columns + Date toolbar */}
         {/* Combined report toolbar */}
<div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50/60 px-4 py-2.5">

  {/* Columns */}
  <div className="relative" ref={fieldsDropdownRef}>
    <button
      type="button"
      onClick={() => setFieldsDropdownOpen(v => !v)}
      className="flex h-8 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:border-blue-400"
    >
      <FileText size={13} className="text-slate-400" />

      Columns

      <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
        {selectedFields.length}
      </span>

      <ChevronRight
        size={13}
        className={`text-slate-400 transition-transform ${
          fieldsDropdownOpen ? 'rotate-90' : ''
        }`}
      />
    </button>

    {fieldsDropdownOpen && (
      <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-64 overflow-auto rounded-xl border border-slate-200 bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
          <span className="text-xs font-semibold text-slate-500">
            Select columns
          </span>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                const allFields = pickableFields.map(
                  field => field.field_key,
                )

                setSelectedFields(allFields)
                runReport(1, perPage, allFields)
              }}
              className="text-xs text-blue-600 hover:underline"
            >
              All
            </button>

            <button
              type="button"
              onClick={() => {
                setSelectedFields([])
                setResult(null)
              }}
              className="text-xs text-slate-500 hover:underline"
            >
              None
            </button>
          </div>
        </div>

        {Object.entries(fieldsByModule).map(
          ([moduleLabel, fields]) => (
            <div key={moduleLabel}>
              <div className="sticky top-0 bg-slate-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                {moduleLabel}
              </div>

              {fields.map(field => (
                <label
                  key={field.field_key}
                  className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-blue-50"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded accent-blue-600"
                    checked={selectedFields.includes(field.field_key)}
                    onChange={() => toggleField(field.field_key)}
                  />

                  <span
                    className={
                      selectedFields.includes(field.field_key)
                        ? 'font-medium text-blue-700'
                        : 'text-slate-700'
                    }
                  >
                    {field.label}
                  </span>
                </label>
              ))}
            </div>
          ),
        )}
      </div>
    )}
  </div>

  {/* Standard / Linked Records */}
  {linkedRecordFieldKeys.length > 0 && (
    <div className="flex items-center rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-medium">
      <button
        type="button"
        onClick={() => toggleViewMode('standard')}
        className={`rounded-md px-2.5 py-1 transition-colors ${
          viewMode === 'standard'
            ? 'bg-blue-600 text-white'
            : 'text-slate-600 hover:bg-slate-100'
        }`}
      >
        Standard
      </button>

      <button
        type="button"
        onClick={() => toggleViewMode('linked')}
        className={`rounded-md px-2.5 py-1 transition-colors ${
          viewMode === 'linked'
            ? 'bg-blue-600 text-white'
            : 'text-slate-600 hover:bg-slate-100'
        }`}
      >
        Linked Records
      </button>
    </div>
  )}

  {/* Date range */}
  <div className="flex items-center gap-1.5">
    <Calendar size={13} className="text-slate-400" />

    <input
      type="date"
      value={dateFrom}
      max={dateTo || undefined}
      onChange={e => setDateFrom(e.target.value)}
      className="h-8 rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-700"
    />

    <span className="text-xs text-slate-400">—</span>

    <input
      type="date"
      value={dateTo}
      min={dateFrom || undefined}
      onChange={e => setDateTo(e.target.value)}
      className="h-8 rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-700"
    />
  </div>

  {/* Advanced Filters button hidden per request — keep code for later re-enable */}
  {false && (
  <button
    type="button"
    onClick={() => setShowFilters(v => !v)}
    className={`flex h-8 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition ${
      showFilters || advancedFilters.length > 0
        ? 'border-blue-400 bg-blue-50 text-blue-700'
        : 'border-slate-300 bg-white text-slate-600 hover:border-blue-300'
    }`}
  >
    <Filter size={13} />

    Filters

    {advancedFilters.length > 0 && (
      <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
        {advancedFilters.length}
      </span>
    )}
  </button>
  )}

  {/* Search */}
{quickSearchAvailable && (
  <div className="relative">
    <Search
      size={13}
      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
    />

    <input
      value={quickSearch}
      onChange={e => setQuickSearch(e.target.value)}
      placeholder="Search records..."
      className="h-8 w-44 rounded-lg border border-slate-300 bg-white pl-7 pr-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
    />
  </div>
)}

  {/* All Time */}
  {quickDateAvailable && (
    <select
      value={quickDatePreset}
      onChange={e => setQuickDatePreset(e.target.value)}
      className="h-8 rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
    >
      {QUICK_DATE_PRESETS.map(preset => (
        <option key={preset.id} value={preset.id}>
          {preset.name}
        </option>
      ))}
    </select>
  )}

  {/* Status */}
  {quickStatusField && (
    <select
      value={quickStatus}
      onChange={e => setQuickStatus(e.target.value)}
      className={`h-8 rounded-lg border px-2 text-xs font-medium outline-none transition ${
        quickStatus
          ? 'border-blue-300 bg-blue-50 text-blue-700'
          : 'border-slate-300 bg-white text-slate-700'
      }`}
    >
      <option value="">{initialTypeKey === 'questionnaire_sections' ? 'All Types' : 'All Statuses'}</option>

      {(['questionnaire', 'questionnaire_user', 'questionnaire_user_detail'].includes(initialTypeKey) ? QUESTIONNAIRE_STATUS_OPTIONS
        : initialTypeKey === 'questionnaire_sections' ? QUESTIONNAIRE_SECTIONS_STATUS_OPTIONS
        : (quickStatusFieldMeta?.enum_values || []).map(v => ({ value: v, label: v }))
      ).map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )}

  {/* Minimum and Maximum amount hidden per request — keep code for later re-enable */}
  {false && quickAmountField && (
    <div className="flex items-center gap-1">
      <input
        value={quickAmountMin}
        onChange={e => setQuickAmountMin(e.target.value)}
        placeholder="Min"
        type="number"
        className="h-8 w-20 rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
      />

      <span className="text-xs text-slate-400">–</span>

      <input
        value={quickAmountMax}
        onChange={e => setQuickAmountMax(e.target.value)}
        placeholder="Max"
        type="number"
        className="h-8 w-20 rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
      />
    </div>
  )}

  {/* Clear active filters */}
  {(quickDatePreset ||
    quickAmountMin ||
    quickAmountMax ||
    advancedFilters.length > 0) && (
    <button
      type="button"
      title="Clear filters"
      onClick={() => {
        clearQuickFilters()
        setAdvancedFilters([])
      }}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-400 hover:border-red-300 hover:text-red-500"
    >
      <RotateCcw size={13} />
    </button>
  )}

  {/* Records and CSV */}
  <div className="ml-auto flex items-center gap-2">
    <span className="whitespace-nowrap text-xs text-slate-500">
      {result
        ? `${result.total.toLocaleString('en-IN')} records`
        : running
          ? 'Loading…'
          : ''}
    </span>

    {result && result.rows.length > 0 && isQuestionnaireReport && (
      <button
        type="button"
        onClick={() => setExportDialogOpen(true)}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
      >
        <Download size={13} />
        Export
      </button>
    )}

    {result && result.rows.length > 0 && !isQuestionnaireReport && (
      <ExportMenu
        processed={result.rows}
        visibleColumns={result.columns
          .filter(c => !HIDDEN_COLUMN_KEYS.has(c))
          .map(c => ({
            key: c,
            header: typeFields.find(f => f.field_key === c)?.label || c,
          })) as Column<Record<string, unknown>>[]}
        exportFilename={savedReportName || initialTypeKey || 'report'}
      />
    )}

    {result && !savedReportId && (
      <button
        type="button"
        onClick={() => setSaveOpen(true)}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-700"
      >
        <Save size={13} />
        Save Report
      </button>
    )}
  </div>
</div>



          {/* Expandable filter panel */}
          {showFilters && (
            <div className="border-b border-slate-200 bg-slate-50/60 px-4 py-3">
              <div className="flex flex-wrap gap-3">
                {advancedFilters.map((filter, index) => {
                  const selectedField = filterableFields.find(f => f.field_key === filter.field)
                  const operators = selectedField?.allowed_operators || ['eq', 'neq', 'contains', 'starts_with', 'is_null', 'is_not_null']
                  // Seeded enum values win; otherwise distinct values fetched from real data.
                  // Free-text operators (contains / starts_with) always keep the text input.
                  const valueOptions = selectedField?.enum_values?.length
                    ? selectedField.enum_values
                    : (filterValueOptions[filter.field] || [])
                  const useDropdown = valueOptions.length > 0 && ['eq', 'neq', 'in', 'not_in'].includes(filter.operator)
                  return (
                    <div key={index} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 shadow-sm">
                      <select
                        value={filter.field}
                        onChange={e => updateFilter(index, { field: e.target.value, operator: 'eq', value: '' })}
                        className="h-7 rounded border border-slate-200 bg-slate-50 px-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                      >
                        {filterableFields.map(field => (
                          <option key={field.field_key} value={field.field_key}>
                            {field.module_label} — {field.label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={filter.operator}
                        onChange={e => updateFilter(index, { operator: e.target.value, value: '' })}
                        className="h-7 rounded border border-slate-200 bg-slate-50 px-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                      >
                        {operators.map(op => (
                          <option key={op} value={op}>{operatorLabel(op)}</option>
                        ))}
                      </select>
                      {!['is_null', 'is_not_null'].includes(filter.operator) && (
                        useDropdown ? (
                          filter.operator === 'in' || filter.operator === 'not_in' ? (
                            <select
                              multiple
                              value={Array.isArray(filter.value) ? filter.value.map(String) : []}
                              onChange={e => updateFilter(index, { value: Array.from(e.target.selectedOptions, o => o.value) })}
                              className="h-7 w-32 rounded border border-slate-200 bg-white px-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                            >
                              {valueOptions.map(v => (
                                <option key={v} value={v}>{v}</option>
                              ))}
                            </select>
                          ) : (
                            <select
                              value={String(filter.value ?? '')}
                              onChange={e => updateFilter(index, { value: e.target.value })}
                              className="h-7 max-w-[180px] rounded border border-slate-200 bg-white px-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                            >
                              <option value="">Select value…</option>
                              {valueOptions.map(v => (
                                <option key={v} value={v}>{v}</option>
                              ))}
                            </select>
                          )
                        ) : (
                          <input
                            value={String(filter.value ?? '')}
                            onChange={e => updateFilter(index, { value: e.target.value })}
                            placeholder="Value"
                            list={valueOptions.length ? `filter-values-${index}` : undefined}
                            className="h-7 w-28 rounded border border-slate-200 bg-white px-2 text-xs text-slate-700 placeholder-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-400"
                          />
                        )
                      )}
                      {!useDropdown && valueOptions.length > 0 && !['is_null', 'is_not_null'].includes(filter.operator) && (
                        <datalist id={`filter-values-${index}`}>
                          {valueOptions.map(v => (
                            <option key={v} value={v} />
                          ))}
                        </datalist>
                      )}
                      <button
                        type="button"
                        onClick={() => removeFilter(index)}
                        className="text-slate-300 hover:text-red-400"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  )
                })}
                <button
                  type="button"
                  onClick={addFilter}
                  className="flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-blue-300 px-3 text-xs font-medium text-blue-600 hover:border-blue-500 hover:bg-blue-50"
                >
                  <Plus size={12} />
                  Add Filter
                </button>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-auto">
            {!result ? (
              <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 text-sm text-slate-400">
                {running ? (
                  <>
                    <Loader2 size={22} className="animate-spin text-blue-500" />
                    <span className="text-slate-500">Loading report data…</span>
                  </>
                ) : (
                  <>
                    <BarChart2 size={32} className="text-slate-200" />
                    <span>Configure columns and click Run</span>
                  </>
                )}
              </div>
            ) : result.rows.length === 0 ? (
              <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-1 text-sm text-slate-400">
                <Search size={24} className="text-slate-200" />
                <span>No records found</span>
              </div>
            ) : (
              <div className="flex flex-col">
                {(() => {
                  // Never rendered as a table column — even if it came from an
                  // older saved report's stored field list — same rule as the
                  // Columns picker (see HIDDEN_COLUMN_KEYS above).
                  const visibleColumns = result.columns.filter(c => !HIDDEN_COLUMN_KEYS.has(c))
                  const sortedRows = sortKey && sortDir
                    ? [...result.rows].sort((a, b) => {
                        const aVal = a[sortKey], bVal = b[sortKey]
                        if (aVal == null) return 1
                        if (bVal == null) return -1
                        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0
                        return sortDir === 'asc' ? cmp : -cmp
                      })
                    : result.rows
                  return (
                <div className="overflow-auto">
                  <table className="min-w-full border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr>
                        {isQuestionnaireReport && (
                          <th className="sticky top-0 z-10 w-10 border-b border-gray-200 bg-gray-50 px-3 py-3">
                            <input
                              type="checkbox"
                              checked={sortedRows.length > 0 && sortedRows.every(r => selectedCustomerIds.has(Number(r.customer_id)))}
                              onChange={e => {
                                setSelectedCustomerIds(prev => {
                                  const next = new Set(prev)
                                  sortedRows.forEach(r => {
                                    const id = Number(r.customer_id)
                                    if (e.target.checked) next.add(id)
                                    else next.delete(id)
                                  })
                                  return next
                                })
                              }}
                            />
                          </th>
                        )}
                        {visibleColumns.map(column => (
                          <th
                            key={column}
                            onClick={() => handleSort(column)}
                            className="group sticky top-0 z-10 cursor-pointer select-none whitespace-nowrap border-b border-gray-200 bg-gray-50 px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                          >
                            <div className="flex items-center">
                              {typeFields.find(f => f.field_key === column)?.label || column}
                              {sortKey !== column ? (
                                <ChevronsUpDown size={11} className="ml-1 opacity-30 transition-opacity group-hover:opacity-60" />
                              ) : sortDir === 'asc' ? (
                                <ChevronUp size={11} className="ml-1 text-blue-500" />
                              ) : (
                                <ChevronDown size={11} className="ml-1 text-blue-500" />
                              )}
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>

                    <tbody>
                      {sortedRows.map((row, rowIndex) => (
                        <tr
                          key={rowIndex}
                          className={`transition-colors hover:bg-blue-50/40 ${rowIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}
                        >
                          {isQuestionnaireReport && (
                            <td className="border-b border-slate-100 px-3 py-2.5 align-top">
                              <input
                                type="checkbox"
                                checked={selectedCustomerIds.has(Number(row.customer_id))}
                                onChange={e => {
                                  const id = Number(row.customer_id)
                                  setSelectedCustomerIds(prev => {
                                    const next = new Set(prev)
                                    if (e.target.checked) next.add(id)
                                    else next.delete(id)
                                    return next
                                  })
                                }}
                              />
                            </td>
                          )}
                          {visibleColumns.map(column => {
                            const fieldMeta = typeFields.find(f => f.field_key === column)
                            const rawValue = row[column]
                            const idValue = fieldMeta?.drilldown_id_field ? row[fieldMeta.drilldown_id_field] : undefined
                            const isEmpty = rawValue === null || rawValue === undefined || rawValue === ''

                            // Questionnaire Insight click — opens the informative drill-down modal
                            // (stat tiles + chart + list). Checked before record identity/report
                            // drilldown below so it wins for these specific fields; every other
                            // report type is untouched since insightTrigger is undefined for them.
                            const isQuestionnaireInsight =
                              !isEmpty &&
                              insightTrigger?.fieldKey === column

                            // Record identity click — opens the Record View Panel. Checked first
                            // and independently of the report-to-report drilldown below; the two
                            // never target the same field, but identity always wins if they did.
                            // idField covers reports whose base row isn't the identity entity
                            // itself (e.g. quotation_workorder's "id" is the quotation's id, not
                            // the lead's — recordIdentity.idField points at the real lead id).
                            const rowId = row[recordIdentity?.idField || 'id']
                            const isRecordIdentity =
                              !isEmpty &&
                              recordIdentity?.fieldKey === column &&
                              rowId !== null && rowId !== undefined && rowId !== ''

                            // Report-engine-only drilldown: any drilldown_kind other than
                            // 'report' (e.g. a stray/legacy 'detail') renders as plain text.
                            const isDrilldownClickable =
                              !isEmpty &&
                              fieldMeta?.drilldown_kind === 'report' &&
                              !!fieldMeta?.drilldown_target &&
                              !!fieldMeta?.drilldown_filter_field &&
                              !!fieldMeta?.drilldown_id_field &&
                              idValue !== null && idValue !== undefined && idValue !== ''

                            return (
                              <td
                                key={column}
                                className="max-w-[320px] whitespace-normal break-words align-top border-b border-slate-100 px-4 py-2.5 text-sm text-gray-600"
                              >
                            {isQuestionnaireInsight ? (
  <button
    type="button"
    onClick={() => setInsight({ mode: insightTrigger!.mode, row })}
    className="
      group/link -mx-1.5 inline-flex max-w-full items-center
      gap-1 rounded-md border-none bg-transparent
      px-1.5 py-1 text-left font-medium text-slate-800
      transition-all duration-200
      hover:bg-slate-100 hover:text-slate-950
      focus:outline-none focus:ring-2 focus:ring-fuchsia-500/20
    "
  >
    <span
      className="
        h-4 w-0.5 flex-shrink-0 scale-y-50 rounded-full
        bg-fuchsia-500 opacity-0
        transition-all duration-200
        group-hover/link:scale-y-100
        group-hover/link:opacity-100
      "
    />

    <span className="truncate transition-all group-hover/link:font-semibold">
      {fmtValue(rawValue)}
    </span>

    <ChevronRight
      size={13}
      className="
        flex-shrink-0 -translate-x-1 text-fuchsia-600
        opacity-0 transition-all duration-200
        group-hover/link:translate-x-0
        group-hover/link:opacity-100
      "
    />
  </button>
) : isRecordIdentity ? (
  <button
    type="button"
    onClick={() =>
      openRecordView({
        entity: recordIdentity!.entity,
        id: rowId as number | string,
        label: String(rawValue),
        seedRow: row,
      })
    }
    className="
      group/link -mx-1.5 inline-flex max-w-full items-center
      gap-1 rounded-md border-none bg-transparent
      px-1.5 py-1 text-left font-medium text-slate-800
      transition-all duration-200
      hover:bg-slate-100 hover:text-slate-950
      focus:outline-none focus:ring-2 focus:ring-fuchsia-500/20
    "
  >
    <span
      className="
        h-4 w-0.5 flex-shrink-0 scale-y-50 rounded-full
        bg-fuchsia-500 opacity-0
        transition-all duration-200
        group-hover/link:scale-y-100
        group-hover/link:opacity-100
      "
    />

    <span className="truncate transition-all group-hover/link:font-semibold">
      {fmtValue(rawValue)}
    </span>

    <ChevronRight
      size={13}
      className="
        flex-shrink-0 -translate-x-1 text-fuchsia-600
        opacity-0 transition-all duration-200
        group-hover/link:translate-x-0
        group-hover/link:opacity-100
      "
    />
  </button>
) : isDrilldownClickable ? (
  <button
    type="button"
    onClick={() =>
      handleDrilldownClick(
        fieldMeta as ReportTypeField,
        row,
      )
    }
    className="
      group/link -mx-1.5 inline-flex max-w-full items-center
      gap-1 rounded-md border-none bg-transparent
      px-1.5 py-1 text-left font-medium text-slate-800
      transition-all duration-200
      hover:bg-slate-100 hover:text-slate-950
      focus:outline-none focus:ring-2 focus:ring-fuchsia-500/20
    "
  >
    <span
      className="
        h-4 w-0.5 flex-shrink-0 scale-y-50 rounded-full
        bg-fuchsia-500 opacity-0
        transition-all duration-200
        group-hover/link:scale-y-100
        group-hover/link:opacity-100
      "
    />

    <span className="truncate transition-all group-hover/link:font-semibold">
      {fmtValue(rawValue)}
    </span>

    <ChevronRight
      size={13}
      className="
        flex-shrink-0 -translate-x-1 text-fuchsia-600
        opacity-0 transition-all duration-200
        group-hover/link:translate-x-0
        group-hover/link:opacity-100
      "
    />
  </button>
) : (
  fmtValue(rawValue)
)}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                  )
                })()}
              </div>
            )}
          </div>

          {result && result.total > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 border-t border-gray-100 bg-gray-50/40 px-5 py-3">
              <span className="text-xs font-medium text-gray-500">
                {Math.min((result.page - 1) * perPage + 1, result.total).toLocaleString('en-IN')}
                {'–'}
                {Math.min(result.page * perPage, result.total).toLocaleString('en-IN')} of{' '}
                {result.total.toLocaleString('en-IN')} records
              </span>

              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <span>Rows per page:</span>
                {[10, 25, 50, 100].map(n => (
                  <button
                    key={n}
                    onClick={() => changePerPage(n)}
                    disabled={running}
                    className={`h-7 min-w-[28px] rounded-lg px-2 text-xs font-semibold transition-colors ${
                      perPage === n ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {n}
                  </button>
                ))}
             <button
  type="button"
  onClick={() => {
    const allFields = pickableFields.map(field => field.field_key)

    setSelectedFields(allFields)
    runReport(1, perPage, allFields)
  }}
  className="text-xs text-blue-600 hover:underline"
>
  All
</button>
              </div>

              {result.pages > 1 && (
                <div className="flex items-center gap-1 sm:ml-auto">
                  <button onClick={() => runReport(1)} disabled={page === 1 || running}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="First page">
                    <ChevronsLeft size={14} />
                  </button>
                  <button onClick={() => runReport(page - 1)} disabled={page === 1 || running}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Previous page">
                    <ChevronLeft size={14} />
                  </button>

                  {pageNumbers.map((p, i) =>
                    p === '...' ? (
                      <span key={`dots-${i}`} className="w-8 h-8 flex items-center justify-center text-xs text-gray-400">
                        <MoreHorizontal size={14} />
                      </span>
                    ) : (
                      <button
                        key={p}
                        onClick={() => runReport(p as number)}
                        disabled={running}
                        className={`w-8 h-8 flex items-center justify-center rounded-lg text-xs font-semibold transition-all
                          ${page === p
                            ? 'bg-blue-600 text-white shadow-sm shadow-blue-200 scale-105'
                            : 'text-gray-600 hover:bg-gray-100'}`}
                      >
                        {p}
                      </button>
                    )
                  )}

                  <button onClick={() => runReport(page + 1)} disabled={page === result.pages || running}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Next page">
                    <ChevronRight size={14} />
                  </button>
                  <button onClick={() => runReport(result.pages)} disabled={page === result.pages || running}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Last page">
                    <ChevronsRight size={14} />
                  </button>

                  <div className="ml-2 flex items-center gap-1.5 text-xs text-gray-500">
                    <span>Go to</span>
                    <input
                      type="number"
                      min={1}
                      max={result.pages}
                      value={goToPage}
                      onChange={e => setGoToPage(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && goToPageSubmit()}
                      className="h-7 w-14 rounded-lg border border-gray-300 px-2 text-xs text-gray-700"
                    />
                    <button
                      onClick={goToPageSubmit}
                      disabled={running || !goToPage}
                      className="h-7 rounded-lg border border-gray-300 px-2 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40"
                    >
                      Go
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {recordView && (
          <RecordViewPanel request={recordView} onClose={closeRecordView} />
        )}

        <QuestionnaireInsightModal request={insight} onClose={() => setInsight(null)} />

        {isQuestionnaireReport && (
          <QuestionnaireExportDialog
            open={exportDialogOpen}
            onClose={() => setExportDialogOpen(false)}
            rows={result?.rows ?? []}
            selectedCustomerIds={selectedCustomerIds}
            reportName={savedReportName || 'Questionnaire'}
          />
        )}
      </div>

      {saveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <h2 className="text-base font-semibold text-gray-900">Save Report</h2>

              <button
                type="button"
                onClick={() => setSaveOpen(false)}
                className="rounded-lg p-1 text-gray-500 hover:bg-gray-100"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Report Name *
                </label>
                <input
                  value={reportName}
                  onChange={e => setReportName(e.target.value)}
                  className="h-10 w-full rounded-lg border border-gray-300 px-3 text-sm"
                  placeholder="Enter report name"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Description
                </label>
                <textarea
                  value={reportDescription}
                  onChange={e => setReportDescription(e.target.value)}
                  className="min-h-[80px] w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  placeholder="Optional description"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Folder
                </label>
                <select
                  value={folderId ?? ''}
                  onChange={e => setFolderId(e.target.value ? Number(e.target.value) : undefined)}
                  className="h-10 w-full rounded-lg border border-gray-300 px-3 text-sm"
                >
                  <option value="">No Folder</option>
                  {folders.map(folder => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
              </div>

              {!savedReportId && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Visibility
                  </label>
                  <select
                    value={visibility}
                    onChange={e => setVisibility(e.target.value as 'private' | 'org')}
                    className="h-10 w-full rounded-lg border border-gray-300 px-3 text-sm"
                  >
                    <option value="private">Private</option>
                    <option value="org">Organization</option>
                  </select>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-4">
              <button
                type="button"
                onClick={() => setSaveOpen(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={saving}
                onClick={saveReport}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:bg-gray-300"
              >
                {saving && <Loader2 size={15} className="animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {saveFilterOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <h2 className="text-base font-semibold text-gray-900">Save Filter</h2>
              <button
                type="button"
                onClick={() => setSaveFilterOpen(false)}
                className="rounded-lg p-1 text-gray-500 hover:bg-gray-100"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Filter Name *</label>
                <input
                  value={saveFilterName}
                  onChange={e => setSaveFilterName(e.target.value)}
                  className="h-10 w-full rounded-lg border border-gray-300 px-3 text-sm"
                  placeholder="e.g. Open Quotations"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Visibility</label>
                <select
                  value={saveFilterVisibility}
                  onChange={e => setSaveFilterVisibility(e.target.value as 'private' | 'org')}
                  className="h-10 w-full rounded-lg border border-gray-300 px-3 text-sm"
                >
                  <option value="private">Private</option>
                  <option value="org">Organization</option>
                </select>
              </div>

              <p className="text-xs text-slate-400">
                Saves the current quick filters and advanced filters. Locked (drilldown) filters are never included.
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-4">
              <button
                type="button"
                onClick={() => setSaveFilterOpen(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={savingFilter}
                onClick={saveCurrentFilter}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:bg-gray-300"
              >
                {savingFilter && <Loader2 size={15} className="animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface ReportDrilldownState {
  initialTypeKey: string
  initialConfig?: ReportConfig | null
  initialRelation?: ReportModuleChild | null
  savedReportId?: number | null
  savedReportName?: string
  backTypeKey?: string | null
}

export default function ReportEnginePage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { reportTypeKey } = useParams<{ reportTypeKey?: string }>()

  const [reportTypes, setReportTypes] = useState<ReportType[]>([])
  const [folders, setFolders] = useState<ReportFolder[]>([])
  const [savedReports, setSavedReports] = useState<SavedReport[]>([])
  const [relationParents, setRelationParents] = useState<ReportModuleParent[]>([])
  const [businessCategories, setBusinessCategories] = useState<BusinessReportCategory[]>([])

  const [loading, setLoading] = useState(true)
  const [createMode, setCreateMode] = useState(false)
  const [activeTypeKey, setActiveTypeKey] = useState<string | null>(null)
  const [activeConfig, setActiveConfig] = useState<ReportConfig | null>(null)
  const [activeRelation, setActiveRelation] = useState<ReportModuleChild | null>(null)
  const [activeSavedId, setActiveSavedId] = useState<number | null>(null)
  const [activeSavedName, setActiveSavedName] = useState('')
  const [activeBackTypeKey, setActiveBackTypeKey] = useState<string | null>(null)
  const [homeFolderFilter, setHomeFolderFilterState] = useState<'all' | number>(cachedHomeFolderFilter)
  const setHomeFolderFilter = (value: 'all' | number) => {
    cachedHomeFolderFilter = value
    setHomeFolderFilterState(value)
  }
  const routeTypeKey = reportTypeKey || null

  // Drilldown arrival — a report cell can navigate here with a preset report type +
  // filter (see ReportBuilder's cell renderer). Does not touch any existing report
  // builder flow; it only pre-populates the same state openSavedReport() would.
  useEffect(() => {
    const drilldown = location.state as ReportDrilldownState | null
    if (!drilldown?.initialTypeKey) return

    setCreateMode(false)
    setActiveRelation(drilldown.initialRelation || null)
    setActiveTypeKey(drilldown.initialTypeKey)
    setActiveConfig(drilldown.initialConfig || null)
    setActiveSavedId(drilldown.savedReportId ?? null)
    setActiveSavedName(drilldown.savedReportName || '')
    setActiveBackTypeKey(drilldown.backTypeKey || null)
  }, [location.state])

  useEffect(() => {
  const routeState = location.state as ReportDrilldownState | null

  if (routeState?.initialTypeKey) return

  // Do not close the Create Report screen.
  if (createMode) return

  if (routeTypeKey) {
    if (activeTypeKey === routeTypeKey) return

    setActiveRelation(null)
    setActiveTypeKey(routeTypeKey)
    setActiveConfig(null)
    setActiveSavedId(null)
    setActiveSavedName('')
    setActiveBackTypeKey(null)
    return
  }

  // Already on the Reports home page.
  if (!activeTypeKey) return

  setActiveTypeKey(null)
  setActiveConfig(null)
  setActiveRelation(null)
  setActiveSavedId(null)
  setActiveSavedName('')
  setActiveBackTypeKey(null)
}, [
  location.state,
  routeTypeKey,
  activeTypeKey,
  createMode,
])

  function resetToHome() {
    setCreateMode(false)
    setActiveTypeKey(null)
    setActiveConfig(null)
    setActiveRelation(null)
    setActiveSavedId(null)
    setActiveSavedName('')
    setActiveBackTypeKey(null)
    navigate('/reports')
  }

  async function loadMeta() {
    setLoading(true)

    try {
      const [typesRes, foldersRes, savedRes, templatesRes, relationsRes] = await Promise.all([
        reportEngineApi.getTypes(),
        reportEngineApi.getFolders(),
        reportEngineApi.getSaved(),
        reportEngineApi.getBusinessTemplates(),
        reportEngineApi.getModuleRelations(),
      ])

      setReportTypes(typesRes.data || [])
      setFolders(foldersRes.data || [])
      setSavedReports(savedRes.data || [])
      setBusinessCategories(templatesRes.data.categories || [])
      setRelationParents(relationsRes.data.parent_modules || [])
    } catch (error) {
      console.error(error)
      toast('error', 'Failed to load reports metadata')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMeta()
  }, [])

  async function openSavedReport(report: SavedReport) {
    try {
      const res = await reportEngineApi.getSavedById(report.id)
      const saved = res.data

      if (!saved.report_type_key) {
        toast('error', 'Saved report has no report type')
        return
      }

      navigate(reportRoute(saved.report_type_key), {
        state: {
          initialTypeKey: saved.report_type_key,
          initialConfig: saved.config_json || null,
          savedReportId: saved.id,
          savedReportName: saved.name,
        } as ReportDrilldownState,
      })
    } catch (error) {
      console.error(error)
      toast('error', 'Failed to open saved report')
    }
  }

 if (createMode) {
    return (
      <BusinessReportTemplateSelector
        categories={businessCategories}
        onCancel={resetToHome}
        onContinue={selection => {
          const lastRelated = selection.related_modules[selection.related_modules.length - 1]
          const relation: ReportModuleChild = {
            module_key: lastRelated || selection.primary_module,
            label: selection.template_name,
            module_label: selection.template_name,
            description: selection.description,
            report_type_key: selection.report_type_key,
            report_type_name: selection.template_name,
            parent_module: selection.primary_module,
            child_modules: selection.related_modules,
            module_chain: selection.module_chain,
            chain: selection.module_chain,
            chain_key: selection.chain_key,
            level: selection.related_modules.length,
            can_continue: false,
          }

          const config: ReportConfig = {
            report_type_key: selection.report_type_key,
            template_key: selection.template_key,
            primary_module: selection.primary_module,
            related_modules: selection.related_modules,
            parent_module: selection.primary_module,
            module_chain: selection.module_chain,
            child_modules: selection.related_modules,
            chain_key: selection.chain_key,
            fields: selection.default_fields,
          }

          setCreateMode(false)
          navigate(reportRoute(selection.report_type_key), {
            state: {
              initialTypeKey: selection.report_type_key,
              initialConfig: config,
              initialRelation: relation,
            } as ReportDrilldownState,
          })
        }}
      />
    )
  }

  if (activeTypeKey) {
    return (
      <ReportBuilder
        key={`${activeTypeKey}-${activeSavedId ?? 'new'}`}
        reportTypes={reportTypes}
        initialTypeKey={activeTypeKey}
        initialConfig={activeConfig}
        initialRelation={activeRelation}
        savedReportId={activeSavedId}
        savedReportName={activeSavedName}
        folders={folders}
        onBack={() => {
          if (activeBackTypeKey) {
            setActiveBackTypeKey(null)
            navigate(reportRoute(activeBackTypeKey), { replace: true })
            return
          }

          resetToHome()
          loadMeta()
        }}
        onSaved={loadMeta}
      />
    )
  }

  return (
    <ReportsHomeTable
      folders={folders}
      reports={savedReports}
      loading={loading}
      onRefresh={loadMeta}
      onOpenReport={openSavedReport}
      folderFilter={homeFolderFilter}
      onFolderFilterChange={setHomeFolderFilter}
      onCreateReport={() => {
        if (!businessCategories.length) {
          toast('error', 'No business report templates configured')
          return
        }

        setCreateMode(true)
      }}
    />
  )
}
