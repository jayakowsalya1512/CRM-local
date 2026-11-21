import { Fragment, createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { createPortal } from 'react-dom'
import {
  fmt, pct, KAM_GROUP_GRADIENTS,
  ACTIVITY_TYPES, STATUSES, TRAVEL_MODES, FOLLOWUP_CATEGORIES, CANCELLATION_REASONS,
  TYPE_ICON, TYPE_COLOR, STATUS_CFG, ROLE_CFG,
  isoDate, monthEndIso, weekEndIso, currentWeekStartIso, compactDateLabel, compactRangeLabel,
  roleKey, NON_KAM_ROLE_KEYS, isSalesKAMUser, roleLabel, taskTypeName, isTravelActivityType, modeForActivityType,
  TypeBox, TaskTypeChip, StatusChip, RoleBadge, ProgressBar, RingProgress,
} from './kam360/shared'
import type { KAM360RangeMode } from './kam360/shared'
import {
  CustomerIndiaGeoJsonMap,
  type CustomerStateMapRow,
  type CustomerLocationMapRow,
  normalizeStateKey, normalizeLocationKey, normalizeDistrictKey,
  canonicalStateName, inferStateNameFromLocation,
  customerDistrictLabel, customerDistrictMapKey,
  resolveIndiaLocationCoord,
} from './kam360/MapSection'
import { CustomerActivityGrid } from './kam360/ActivitySection'
import {
  SparkBar, TrendBadge, ComparisonChart, KAMMemberDeepCard,
  SubGroupSection, GroupTreeNode, OrgPersonCard, OrgSECard,
  OrgGroupCard, GroupTreePerformanceView,
} from './kam360/NormalSection'
import { AdvancedKAM360Tab } from './kam360/AdvancedSection'
import {
  Activity, Plus, CheckCircle, XCircle, AlertCircle,
  Calendar, Car, Edit3, ArrowRight, ChevronRight, ChevronDown, ChevronsLeft, ChevronsRight,
  Building2, Clock, RefreshCw, X, Plane, Check, Link2, MapPin, Search, Folder,
  TrendingUp, PhoneCall, Video, Handshake, Monitor, Navigation, Mail,
  FileText, Repeat2, ListChecks, Target, IndianRupee, Package,
  BarChart2, Circle, PauseCircle, Coffee, Layers, UserCircle,
  Users, Award, Settings, ExternalLink, ChevronUp, Sparkles,
  GitBranch, TreePine, Zap, Eye, SlidersHorizontal,
  ArrowUpRight, ArrowDownRight, Minus, Crown, Star, TrendingDown,
  LayoutGrid, List, ChevronLeft, Info, Globe, Briefcase, PieChart, AlertTriangle,
  MoreVertical, MoreHorizontal, Maximize2, Minimize2, Download, Paperclip, Trash2,
} from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import SlidePanel from '@/components/ui/SlidePanel'
import Input, { Textarea } from '@/components/ui/Input'
import { PageHeader, StatCard, useToast, FormSection, FormGrid } from '@/components/ui/FormComponents'
import FormPageHeader from '@/components/ui/FormPageHeader'
import SearchableSelect from '@/components/ui/SearchableSelect'
import DropFileUpload from '@/components/ui/DropFileUpload'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { useAuthStore, useUIStore } from '@/store'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { ReopenBanner, ActivityTimelineTab, ReopenActivityModal } from './ActivityAuditPanel'
import { usePermissions } from '@/hooks'

// ─── Role permissions (Settings › Roles & Permissions → kam.*) ───────────────
type KAMPerms = { canCreate: boolean; canUpdate: boolean; canExport: boolean }
const KAMPermsContext = createContext<KAMPerms>({ canCreate: false, canUpdate: false, canExport: false })
const useKAMPerms = () => useContext(KAMPermsContext)
function KAMPermGate({ perm, children }: { perm: keyof KAMPerms; children: React.ReactNode }) {
  return useKAMPerms()[perm] ? <>{children}</> : null
}
const KAMDataTable: typeof DataTable = (props: any) => {
  const { canExport } = useKAMPerms()
  return <DataTable {...props} showExport={canExport && (props.showExport ?? true)} />
}

// ─── Travel Alert ─────────────────────────────────────────────────────────────
const normalizeWorkOrderStatus = (status?: string) => {
  const raw = String(status || '').trim().toLowerCase()
  if (['completed', 'closed'].includes(raw)) return 'completed'
  if (raw === 'delayed') return 'delayed'
  if (raw === 'cancelled') return 'cancelled'
  return 'active'
}

const workOrderStatusBadge = (status?: string) => {
  const key = normalizeWorkOrderStatus(status)
  if (key === 'completed') return 'bg-emerald-100 text-emerald-700'
  if (key === 'delayed') return 'bg-amber-100 text-amber-700'
  if (key === 'cancelled') return 'bg-red-100 text-red-600'
  return 'bg-blue-100 text-blue-700'
}

type WorkOrderSourceKey = 'tender'|'direct'|'quotation'|'other'
const emptyWorkOrderSourceCounts = () => ({tender:0,direct:0,quotation:0,other:0})
const workOrderSourceLabel = (source:WorkOrderSourceKey) => ({
  tender:'Tender-based',
  direct:'Direct Opportunity',
  quotation:'Quotation-based',
  other:'Other',
}[source])
const workOrderValue = (wo:any) => Number(wo?.wo_value ?? wo?.bid_amount ?? wo?.po_value ?? wo?.final_boq_total ?? 0)
const workOrderSourceCategory = (wo:any):WorkOrderSourceKey => {
  const raw = String(wo?.source_type || wo?.source || wo?.origin || wo?.order_source || wo?.created_from || wo?.reference_type || wo?.module || '').trim().toLowerCase()
  if(raw.includes('quotation') || raw.includes('quote') || wo?.quotation_id || wo?.quotation_number || wo?.quote_id) return 'quotation'
  if(wo?.from_direct || raw.includes('direct') || raw.includes('opportunity') || (wo?.lead_id && !wo?.tender_id)) return 'direct'
  if(raw.includes('tender') || wo?.tender_id || wo?.portal_ref_number || wo?.tender_num || wo?.tender_title) return 'tender'
  return 'other'
}
const countWorkOrderSources = (rows:any[] = []) => rows.reduce((acc,row)=>{
  acc[workOrderSourceCategory(row)] += 1
  return acc
}, emptyWorkOrderSourceCounts())

type OpportunityOriginKey = 'from_lead'|'direct'
const opportunityOrigin = (row:any):OpportunityOriginKey => {
  const explicit = String(row?.opportunity_origin || row?.origin || row?.created_from || '').trim().toLowerCase()
  if(['from_lead','lead','leads'].includes(explicit)) return 'from_lead'
  if(['direct','direct_opportunity','opportunity'].includes(explicit)) return 'direct'

  const leadType = String(row?.lead_type || '').trim().toLowerCase()
  return leadType === 'direct_opportunity' ? 'direct' : 'from_lead'
}

function StackedSummaryStrip({
  title,
  accentClass,
  totalValue,
  totalMeta,
  segments,
}: {
  title: string
  accentClass: string
  totalValue: string
  totalMeta: string
  segments: Array<{
    label: string
    value: number
    barValue?: number
    displayValue: string
    meta: string
    color: string
    dotColor: string
    textColor: string
  }>
}) {
  const totalBarValue = segments.reduce((sum, seg) => sum + (seg.barValue ?? seg.value), 0)

  return (
    <div className="mx-4 mb-4 mt-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <BarChart2 size={13} className={accentClass} />
        <p className={`text-xs font-semibold uppercase tracking-[0.18em] ${accentClass}`}>{title}</p>
      </div>

      <div className="mt-3 flex items-end gap-2 flex-wrap">
        <p className="text-4xl font-black leading-none text-gray-900">{totalValue}</p>
        <p className="text-sm text-gray-500">{totalMeta}</p>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-gray-200 bg-gray-100">
        <div className="flex h-11 w-full">
          {segments.map(seg => {
            const barValue = seg.barValue ?? seg.value
            const width = totalBarValue > 0 ? (barValue / totalBarValue) * 100 : 0
            return (
              <div
                key={seg.label}
                className={`flex items-center justify-center px-2 transition-all duration-700 ${seg.color}`}
                style={{ width: `${width}%` }}
                title={`${seg.label}: ${seg.displayValue} (${seg.meta})`}
              >
                {width >= 18 && <span className="truncate text-[12px] font-bold text-white">{seg.displayValue}</span>}
              </div>
            )
          })}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        {segments.map(seg => (
          <div key={seg.label} className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${seg.dotColor}`} />
            <span className="text-sm text-gray-600">{seg.label}</span>
            <span className={`text-sm font-bold ${seg.textColor}`}>{seg.displayValue}</span>
            <span className="text-xs text-gray-400">{seg.meta}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TravelAlertBanner({requestNumber,requestId,message,isOutside,onSubmit,onDismiss}:{
  requestNumber:string;requestId:number;message?:string;isOutside?:boolean;
  onSubmit:(id:number)=>void;onDismiss:()=>void;
}) {
  return (
    <div className={`flex items-start gap-3 rounded-2xl px-4 py-3 border ${isOutside?'bg-orange-50 border-orange-200':'bg-blue-50 border-blue-100'}`}>
      <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${isOutside?'bg-orange-100':'bg-blue-100'}`}><Plane size={15} className={isOutside?'text-orange-600':'text-blue-500'}/></div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold ${isOutside?'text-orange-900':'text-blue-900'}`}>Travel request created</p>
        <p className={`text-xs mt-0.5 ${isOutside?'text-orange-600':'text-blue-600'}`}>
          <span className={`font-mono font-bold px-1 rounded text-[11px] ${isOutside?'bg-orange-100':'bg-blue-100'}`}>{requestNumber}</span>{' '}
          {message||(isOutside?'— submit for manager approval.':'— local travel recorded.')}
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {isOutside&&<button onClick={()=>onSubmit(requestId)} className="px-3 py-1.5 text-xs bg-orange-500 text-white rounded-lg font-semibold hover:bg-orange-600">Submit Now</button>}
        <button onClick={onDismiss} className={`p-1 ${isOutside?'text-orange-400':'text-blue-400'}`}><X size={14}/></button>
      </div>
    </div>
  )
}

function KAMFormShell({
  breadcrumb,
  currentLabel,
  onBack,
  actions,
  children,
  footer,
  bodyClassName = 'p-0',
}: {
  breadcrumb: string
  currentLabel: string
  onBack: () => void
  actions?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  bodyClassName?: string
}) {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="w-full">
        <div className="min-h-[calc(100vh-56px)] bg-white border border-slate-200 shadow-sm flex flex-col">
          <FormPageHeader
            breadcrumb={breadcrumb}
            onBreadcrumbClick={onBack}
            title={breadcrumb}
            currentLabel={currentLabel}
            onCancel={onBack}
            onSave={onBack}
            actions={actions}
            showEditBadge={false}
          />

          <main className="min-w-0 flex-1">
            <div className={bodyClassName}>{children}</div>

            {footer && (
              <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
                {footer}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}

// ─── Travel request constants ─────────────────────────────────────────────────
const VISIT_TYPES_KAM = ['Customer Visit','Site Visit','Training','Conference','Meeting','Demo / Presentation','Audit','Follow-up','Other']
const ACCOMMODATION_TYPES_KAM = ['Company Guest House','Hotel (Self-Book)','Hotel (Company Arranged)','Customer Arranged','Home Stay','Not Required']
const TRANSPORT_MODES_KAM: Record<string,string> = {
  own_vehicle:'Own Vehicle', company_car:'Company Car', train:'Train',
  bus:'Bus', taxi_cab:'Taxi / Cab', bike:'Bike', flight:'Flight', other:'Other',
}
const TR_STATUS_STYLE: Record<string,{bg:string;text:string}> = {
  Draft:     {bg:'bg-slate-100',text:'text-slate-600'},
  Submitted: {bg:'bg-amber-100',text:'text-amber-700'},
  Approved:  {bg:'bg-emerald-100',text:'text-emerald-700'},
  Rejected:  {bg:'bg-rose-100',text:'text-rose-600'},
  Completed: {bg:'bg-blue-100',text:'text-blue-700'},
  Cancelled: {bg:'bg-gray-100',text:'text-gray-400'},
}
const ACTIVITY_LOG_STATUS_OPTIONS = ['Completed','In Progress','Postponed','Cancelled'] as const

// ─── Log Activity Form ────────────────────────────────────────────────────────
function LogActivityForm({form,setForm,customers,isAdmin,isLogUpdate=false,isEdit=false,travelRequests=[],advanceDays=3}:{
  form:any;setForm:(f:any)=>void;customers:any[];isAdmin:boolean;
  isLogUpdate?:boolean;isEdit?:boolean;travelRequests?:any[];advanceDays?:number;
}) {
  const { singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const { singular: leadSingular } = useModuleName('leads')
  const { singular: opportunitySingular } = useModuleName('opportunities')
  const { singular: tenderSingular } = useModuleName('tenders')
  const { singular: workOrderSingular } = useModuleName('workorders')
  const set=(k:string,v:any)=>setForm((p:any)=>({...p,[k]:v}))
  const LOG_STATUS_OPTIONS = ACTIVITY_LOG_STATUS_OPTIONS
  const showOutcome=form.status==='Completed'||form.status==='Cancelled'
  const remarksRequired = requiresActivityRemarks(form.status)
  const remarksLabel = remarksRequired ? 'Remarks' : 'Internal Notes'
  const remarksPlaceholder = form.status === 'Postponed'
    ? 'Enter the reason for postponing this activity'
    : form.status === 'Cancelled'
      ? 'Enter the reason for cancelling this activity'
      : form.status === 'Reopened'
        ? 'Enter the reason for reopening this activity'
        : 'Enter internal notes'
  const logStatusOptions = useMemo(() => {
    const currentStatus = String(form.status || '').trim()
    return currentStatus && !ACTIVITY_LOG_STATUS_OPTIONS.includes(currentStatus as typeof ACTIVITY_LOG_STATUS_OPTIONS[number])
      ? [currentStatus, ...ACTIVITY_LOG_STATUS_OPTIONS]
      : [...ACTIVITY_LOG_STATUS_OPTIONS]
  }, [form.status])
  const logStatusValue = form.status || 'Completed'
  const showTRSection = (isEdit || isLogUpdate) && isTravelActivityType(form)
  const [trMode,setTrMode]=useState<'link'|'create'>(form.travel_request_id?'link':'create')
  const DURATION_TYPES = ['Phone Call', 'Video Call', 'In Person Meet', 'Meeting', 'Demo']
  const showTimedFields = !isEdit && DURATION_TYPES.includes(taskTypeName(form))

  // ── Link to one record only — Lead / Tender / Work Order / EMD-BG, scoped to
  // the selected customer. Lead/Tender/Work Order share the same team-visible
  // dataset as `customers` (via /kam/pipeline-records); EMD/BG uses its own
  // data-scope-filtered list endpoint (/emdbg?customer_id=). Only one of
  // lead_id/tender_id/work_order_id/emdbg_id is ever set at a time. ──────────
  const currentLinkType:string = form.link_type || (form.lead_id?'lead':form.tender_id?'tender':form.work_order_id?'workorder':form.emdbg_id?'emdbg':'')
  const LINK_TYPES = [
    {key:'lead',label:leadSingular},
    {key:'tender',label:tenderSingular},
    {key:'opportunity',label:opportunitySingular},
  ]
  const [linkOptions,setLinkOptions]=useState<any[]>([])
  const [loadingLinkOptions,setLoadingLinkOptions]=useState(false)
  useEffect(()=>{
    if(!form.customer_id||!currentLinkType){ setLinkOptions([]); return }
    let alive=true
    setLoadingLinkOptions(true)
    ;(async()=>{
      try{
        let rows:any[]=[]
        if(currentLinkType==='emdbg'){
          const r=await api.get('/emdbg',{params:{customer_id:form.customer_id}})
          rows=Array.isArray(r.data)?r.data:[]
        }else{
          const kind=currentLinkType==='lead'?'leads':currentLinkType==='tender'?'tenders':currentLinkType==='opportunity'?'opportunities':'workorders'
          const r=await api.get('/kam/pipeline-records',{params:{kind,customer_ids:String(form.customer_id),all_time:true,customer_scope_only:true}})
          rows=Array.isArray(r.data)?r.data:[]
        }
        if(alive) setLinkOptions(rows)
      }catch{ if(alive) setLinkOptions([]) }
      finally{ if(alive) setLoadingLinkOptions(false) }
    })()
    return ()=>{alive=false}
  },[form.customer_id,currentLinkType])

  const linkIdField = currentLinkType==='lead'||currentLinkType==='opportunity'?'lead_id':currentLinkType==='tender'?'tender_id':currentLinkType==='workorder'?'work_order_id':currentLinkType==='emdbg'?'emdbg_id':null
  const linkOptionsMapped = linkOptions.map((r:any)=>{
    if(currentLinkType==='lead'||currentLinkType==='opportunity') return {value:Number(r.id),label:String(r.lead_title||r.lead_ref_id||`Lead #${r.id}`)}
    if(currentLinkType==='tender') return {value:Number(r.id),label:String(r.tender_title||r.tender_num||`Tender #${r.id}`)}
    if(currentLinkType==='workorder') return {value:Number(r.id),label:String(r.wrk_order_id||r.project_title||`${workOrderSingular} #${r.id}`)}
    return {value:Number(r.id),label:String(r.reference_num||r.instrument_type||`EMD/BG #${r.id}`)}
  })
  const setLinkType=(type:string)=>setForm((p:any)=>({...p,link_type:type,lead_id:null,tender_id:null,work_order_id:null,emdbg_id:null}))
  const setLinkRecord=(v:number|null)=>{ if(linkIdField) setForm((p:any)=>({...p,[linkIdField]:v})) }

  const [capturingLocation,setCapturingLocation]=useState(false)
  const [locationError,setLocationError]=useState<string|null>(null)
  useEffect(()=>{
    if(!showTimedFields) return
    const seededEndTime = !form.end_time && form.start_time && Number(form.duration_minutes||0)>0
      ? addMinutesToTime(form.start_time, Number(form.duration_minutes||0))
      : form.end_time || ''
    if(seededEndTime && seededEndTime !== form.end_time){
      set('end_time', seededEndTime)
      return
    }
    const nextDuration = durationFromTimes(form.start_time, seededEndTime)
    if(Number(form.duration_minutes||0) !== nextDuration){
      set('duration_minutes', nextDuration)
    }
  },[form.duration_minutes,form.end_time,form.start_time,showTimedFields])
  const captureLocation=()=>{
    if(!window.isSecureContext){
      setLocationError('GPS capture needs HTTPS (or localhost) — this page is loaded over plain HTTP, so the browser blocks location access.')
      return
    }
    if(!navigator.geolocation){
      setLocationError('Location is not supported by this browser.')
      return
    }
    setLocationError(null)
    setCapturingLocation(true)
    navigator.geolocation.getCurrentPosition(
      pos=>{ set('latitude',pos.coords.latitude); set('longitude',pos.coords.longitude); setCapturingLocation(false) },
      err=>{
        setCapturingLocation(false)
        setLocationError(err.code===1?'Location permission denied.':err.code===2?'Location unavailable.':'Location request timed out.')
      },
      { enableHighAccuracy:true, timeout:10000 },
    )
  }

  const travelDateStatus: 'open'|'late'|'past'|'na' = (() => {
    const travelDate = form.tr_travel_date
    if(!showTRSection||!form.has_travel||!form.is_outside_district||!travelDate) return 'na'
    const today=new Date(); today.setHours(0,0,0,0)
    const tDate=new Date(travelDate); tDate.setHours(0,0,0,0)
    const daysUntil=Math.floor((tDate.getTime()-today.getTime())/(1000*60*60*24))
    if(daysUntil<0) return 'past'
    if(daysUntil<=advanceDays) return 'late'
    return 'open'
  })()

  const handleLinkTR=(trId:number|null)=>{
    if(!trId){setForm((p:any)=>({...p,travel_request_id:null}));return}
    const tr=travelRequests.find((r:any)=>r.id===trId)
    if(!tr) return
    setForm((p:any)=>({
      ...p,
      travel_request_id: tr.id,
      travel_from:       tr.from_city||p.travel_from,
      travel_to:         tr.to_city||p.travel_to,
      travel_mode:       tr.transport_mode||p.travel_mode,
      tr_return_date:    tr.return_date||'',
      tr_visit_type:     tr.visit_type||'Customer Visit',
      tr_transport_mode: tr.transport_mode||'',
      tr_estimated_cost: tr.estimated_cost||'',
      tr_contact_name:   tr.contact_name||'',
      tr_contact_phone:  tr.contact_phone||'',
      is_outside_district: true,
    }))
  }

  const linkedTR = form.travel_request_id ? travelRequests.find((r:any)=>r.id===form.travel_request_id) : null
  const linkedTRStatus = linkedTR?.status || form.travel_request_status
  const canEditLinkedTR = !linkedTRStatus || ['Draft','Rejected'].includes(linkedTRStatus)
  const renderTravelRequestEditor = () => canEditLinkedTR ? (
    <div className="px-4 pb-4 space-y-3">
      <div className="pt-3 border-t border-orange-100">
        <p className="text-xs font-semibold text-orange-800">Update travel request</p>
        <p className="text-[11px] text-orange-500 mt-0.5">Changes are saved with this activity.</p>
      </div>
      <div className="grid grid-cols-1 gap-x-3 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
        <div>
          <Input
            label="Travel Date"
            type="date"
            value={form.tr_travel_date||linkedTR?.travel_date||''}
            onChange={e=>set('tr_travel_date',e.target.value)}
          />
        </div>
        <div>
          <Input
            label="Return Date"
            type="date"
            value={form.tr_return_date||linkedTR?.return_date||''}
            onChange={e=>set('tr_return_date',e.target.value)}
          />
        </div>
        <div>
          <SearchableSelect label="Visit Type" options={VISIT_TYPES_KAM.map(t=>({value:t,label:t}))} value={form.tr_visit_type||linkedTR?.visit_type||'Customer Visit'} onChange={v=>set('tr_visit_type',v)}/>
        </div>
        <div>
          <SearchableSelect label="Transport Mode" options={Object.entries(TRANSPORT_MODES_KAM).map(([v,l])=>({value:v,label:l}))} value={form.tr_transport_mode||linkedTR?.transport_mode||''} onChange={v=>set('tr_transport_mode',v)} clearable/>
        </div>
        <div>
          <Input label="From City" value={form.travel_from||linkedTR?.from_city||''} onChange={(v:any)=>set('travel_from',typeof v==='string'?v:v?.target?.value||'')} placeholder="Departure city"/>
        </div>
        <div>
          <Input label="To City" value={form.travel_to||linkedTR?.to_city||''} onChange={(v:any)=>set('travel_to',typeof v==='string'?v:v?.target?.value||'')} placeholder="Destination city"/>
        </div>
        <div>
          <Input
            label="Estimated Cost"
            inputMode="numeric"
            numberOnly
            value={form.tr_estimated_cost || linkedTR?.estimated_cost || linkedTR?.estimated_total || ''}
            onChange={e=>set('tr_estimated_cost',e.target.value)}
            placeholder="Enter estimated amount"
          />
        </div>
        <div>
          <Input label="Contact Person" value={form.tr_contact_name||linkedTR?.contact_name||''} onChange={(v:any)=>set('tr_contact_name',typeof v==='string'?v:v?.target?.value||'')} placeholder="Person to meet"/>
        </div>
        <div>
          <Input label="Contact Phone" value={form.tr_contact_phone||linkedTR?.contact_phone||''} onChange={(v:any)=>set('tr_contact_phone',typeof v==='string'?v:v?.target?.value||'')} placeholder="+91 98765 43210"/>
        </div>
      </div>
    </div>
  ) : (
    <div className="px-4 pb-4">
      <p className="text-[11px] text-gray-400 border-t border-orange-100 pt-3">Travel request can be updated only while it is Draft or Rejected.</p>
    </div>
  )

  return (
    <>
      {isEdit ? (
        <div className="mb-4 w-full">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                <Activity size={17}/>
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-900">Activity Information</h3>
                <p className="mt-0.5 text-xs text-slate-500">Update the activity, {customerSingular.toLowerCase()} and linked record details</p>
              </div>
            </div>

            <div className="p-4">
              <div className="grid grid-cols-1 gap-x-3 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
                <div>
                  <SearchableSelect
                    label="Activity Type"
                    required
                    options={ACTIVITY_TYPES.map(t=>({value:t,label:t}))}
                    value={taskTypeName(form)||null}
                    onChange={v=>{
                      const type=String(v||'')
                      if(!type) return
                      setForm((p:any)=>({...p,activity_type:type,mode:modeForActivityType(type),task_type_name:type}))
                    }}
                    placeholder="Select activity type"
                  />
                </div>

                <div>
                  <Input
                    label="Activity Date"
                    type="date"
                    value={form.activity_date||''}
                    onChange={e=>set('activity_date',e.target.value)}
                  />
                </div>

                <div>
                  <SearchableSelect
                    label={customerSingular}
                    clearable
                    options={customers.map(c=>({value:Number(c.id),label:String(c.customer_name||c.name||'')}))}
                    value={form.customer_id?Number(form.customer_id):null}
                    onChange={v=>setForm((p:any)=>({...p,customer_id:v?Number(v):null,link_type:'',lead_id:null,tender_id:null,work_order_id:null,emdbg_id:null}))}
                    placeholder={`Search and select ${customerSingular.toLowerCase()}`}
                  />
                </div>

                <div>
                  <Input
                    label="Subject / Purpose"
                    required
                    value={form.subject||''}
                    onChange={e=>set('subject',e.target.value)}
                    placeholder="Enter the purpose of this activity"
                  />
                </div>

                <div>
                  <SearchableSelect
                    label="Link To"
                    disabled={!form.customer_id}
                    clearable
                    options={LINK_TYPES.map(t=>({value:t.key,label:t.label}))}
                    value={currentLinkType||null}
                    onChange={v=>setLinkType(String(v||''))}
                    placeholder={form.customer_id?'Select link type':`Select ${customerSingular.toLowerCase()} first`}
                  />
                </div>

                <div>
                  <SearchableSelect
                    label="Record"
                    clearable
                    disabled={!form.customer_id||!currentLinkType}
                    options={linkOptionsMapped}
                    value={linkIdField&&form[linkIdField]?Number(form[linkIdField]):null}
                    onChange={v=>setLinkRecord(v?Number(v):null)}
                    placeholder={!form.customer_id?`Select ${customerSingular.toLowerCase()} first`:!currentLinkType?'Select link type first':loadingLinkOptions?'Loading records…':`Select ${LINK_TYPES.find(t=>t.key===currentLinkType)?.label||'record'}`}
                  />
                </div>

              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          {isLogUpdate ? (
            <div className="mb-4 px-1 pt-1">
              {(()=>{const name=taskTypeName(form);const c=TYPE_COLOR[name]||{bg:'bg-gray-50',text:'text-gray-500',dot:''};return(
                <div className="flex items-center gap-2.5">
                  <span className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold ${c.bg} ${c.text}`}>
                    <span className={`w-6 h-6 rounded-lg flex items-center justify-center ${c.bg} ${c.text}`}>{TYPE_ICON[name]||<Activity size={13}/>}</span>
                    {name}
                  </span>
                  <span className="text-xs text-gray-400">Activity type locked</span>
                </div>
              )})()}
            </div>
          ) : (
            <FormSection title="Activity Type">
              <div className="grid grid-cols-3 gap-2">
                {ACTIVITY_TYPES.map(t => {
                  const c = TYPE_COLOR[t] || { bg:'bg-gray-50', text:'text-gray-500', dot:'' }
                  const selectedType = taskTypeName(form)
                  const active = selectedType === t
                  return (
                    <button key={t} type="button"
                      onClick={() => setForm((p:any) => ({...p, activity_type: t, mode: modeForActivityType(t), task_type_name: t}))}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold border-2 transition-all ${active ? `${c.bg} ${c.text} border-current/30 shadow-sm` : 'border-transparent bg-gray-50 text-gray-500 hover:bg-gray-100'}`}>
                      <div className={`w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 ${active ? c.bg : 'bg-white'} ${active ? c.text : 'text-gray-400'}`}>{TYPE_ICON[t]}</div>
                      {t}
                    </button>
                  )
                })}
              </div>
            </FormSection>
          )}

          {isLogUpdate&&(
            <div className="mb-4 w-full">
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-200 bg-white px-5 py-4">
                  <h3 className="text-sm font-bold text-slate-900">Details</h3>
                  <p className="mt-0.5 text-xs text-slate-500">Update the activity fields using the standard form layout</p>
                </div>
                <div className="p-4">
                  <div className="grid grid-cols-1 gap-x-3 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
                    <div>
                      <Input
                        label="Subject / Purpose"
                        required
                        value={form.subject||''}
                        onChange={e=>set('subject',e.target.value)}
                        placeholder="Brief description"
                      />
                    </div>
                    <div>
                      <SearchableSelect label={customerSingular} clearable
                        options={customers.map(c=>({value:Number(c.id),label:String(c.customer_name||c.name||'')}))}
                        value={form.customer_id?Number(form.customer_id):null}
                        onChange={v=>setForm((p:any)=>({...p,customer_id:v?Number(v):null,link_type:'',lead_id:null,tender_id:null,work_order_id:null,emdbg_id:null}))}
                        placeholder={`Search and select ${customerSingular.toLowerCase()}`}/>
                    </div>
                    <div>
                      <SearchableSelect label="Link To" clearable disabled={!form.customer_id}
                        options={LINK_TYPES.map(t=>({value:t.key,label:t.label}))}
                        value={currentLinkType||null}
                        onChange={v=>setLinkType(String(v||''))}
                        placeholder={form.customer_id?'Select link type':`Select ${customerSingular.toLowerCase()} first`}/>
                    </div>
                    <div>
                      <SearchableSelect label="Record" clearable disabled={!form.customer_id||!currentLinkType}
                        options={linkOptionsMapped}
                        value={linkIdField&&form[linkIdField]?Number(form[linkIdField]):null}
                        onChange={v=>setLinkRecord(v?Number(v):null)}
                        placeholder={!form.customer_id?`Select ${customerSingular.toLowerCase()} first`:!currentLinkType?'Select link type first':loadingLinkOptions?'Loading records...':`Select ${LINK_TYPES.find(t=>t.key===currentLinkType)?.label||'record'}`}/>
                    </div>
                    <div>
                      <Input
                        label="Activity Date"
                        type="date"
                        value={form.activity_date||''}
                        onChange={e=>set('activity_date',e.target.value)}
                      />
                    </div>
                    <div>
                      <SearchableSelect label="Status"
                        options={logStatusOptions.map(status=>({value:status,label:status}))}
                        value={logStatusValue}
                        onChange={v=>set('status',v || logStatusValue)}
                      />
                    </div>
                    {showTimedFields&&(
                      <div>
                        <Input
                          label="Start Time"
                          type="time"
                          value={form.start_time||''}
                          onChange={e=>set('start_time',e.target.value)}
                        />
                      </div>
                    )}
                    {showTimedFields&&(
                      <div>
                        <Input
                          label="End Time"
                          type="time"
                          value={form.end_time||''}
                          onChange={e=>set('end_time',e.target.value)}
                        />
                      </div>
                    )}
                    {showTimedFields&&(
                      <div>
                        <Input
                          label="Duration (min)"
                          type="number"
                          value={form.duration_minutes||0}
                          readOnly
                          className="bg-slate-50 text-slate-700"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {!isLogUpdate&&(<FormSection title="Details">
            {isLogUpdate ? (
              <div className="grid grid-cols-1 gap-x-4 gap-y-4 xl:grid-cols-12">
                <div className="xl:col-span-4">
                  <label className="mb-1.5 block text-xs font-semibold text-gray-600">Subject / Purpose <span className="text-red-500">*</span></label>
                  <input value={form.subject} onChange={e=>set('subject',e.target.value)} placeholder="Brief description..."
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"/>
                </div>
                <div className="xl:col-span-4">
                  <SearchableSelect label={customerSingular} clearable
                    options={customers.map(c=>({value:Number(c.id),label:String(c.customer_name||c.name||'')}))}
                    value={form.customer_id?Number(form.customer_id):null}
                    onChange={v=>setForm((p:any)=>({...p,customer_id:v?Number(v):null,link_type:'',lead_id:null,tender_id:null,work_order_id:null,emdbg_id:null}))}
                    placeholder={`Link to ${customerSingular.toLowerCase()}...`}/>
                </div>
                <div className="xl:col-span-4">
                  <SearchableSelect label="Link To" clearable disabled={!form.customer_id}
                    options={LINK_TYPES.map(t=>({value:t.key,label:t.label}))}
                    value={currentLinkType||null}
                    onChange={v=>setLinkType(String(v||''))}
                    placeholder={form.customer_id?'Select link type':`Select ${customerSingular.toLowerCase()} first`}/>
                </div>
                <div className="xl:col-span-4">
                  <SearchableSelect label="Record" clearable disabled={!form.customer_id||!currentLinkType}
                    options={linkOptionsMapped}
                    value={linkIdField&&form[linkIdField]?Number(form[linkIdField]):null}
                    onChange={v=>setLinkRecord(v?Number(v):null)}
                    placeholder={!form.customer_id?`Select a ${customerSingular.toLowerCase()} first`:!currentLinkType?'Choose a type first':loadingLinkOptions?'Loading...':`Select ${LINK_TYPES.find(t=>t.key===currentLinkType)?.label}...`}/>
                </div>
                <div className="xl:col-span-4">
                  <label className="mb-1.5 block text-xs font-semibold text-gray-600">Activity Date</label>
                  <div className="relative">
                    <Calendar size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
                    <input type="date" value={form.activity_date} onChange={e=>set('activity_date',e.target.value)}
                      className="h-[42px] w-full rounded-xl border border-gray-200 bg-white py-2 pl-10 pr-3 text-sm text-slate-800 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"/>
                  </div>
                </div>
                <div className="xl:col-span-4">
                  <SearchableSelect label="Status"
                    options={logStatusOptions.map(status=>({value:status,label:status}))}
                    value={logStatusValue}
                    onChange={v=>set('status',v || logStatusValue)}
                  />
                </div>
                {showTimedFields&&(<div className="xl:col-span-4">
                  <label className="mb-1.5 block text-xs font-semibold text-gray-600">Start Time</label>
                  <input type="time" value={form.start_time||''} onChange={e=>set('start_time',e.target.value)}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-400 focus:outline-none"/>
                </div>)}
                {showTimedFields&&(<div className="xl:col-span-4">
                  <label className="mb-1.5 block text-xs font-semibold text-gray-600">End Time</label>
                  <input type="time" value={form.end_time||''} onChange={e=>set('end_time',e.target.value)}
                    className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-400 focus:outline-none"/>
                </div>)}
                {showTimedFields&&(<div className="xl:col-span-4">
                  <label className="mb-1.5 block text-xs font-semibold text-gray-600">Duration (min)</label>
                  <input type="number" value={form.duration_minutes||0} readOnly
                    className="w-full rounded-xl border border-gray-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 focus:outline-none"/>
                </div>)}
              </div>
            ) : (
              <FormGrid cols={2}>
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Subject / Purpose <span className="text-red-500">*</span></label>
                <input value={form.subject} onChange={e=>set('subject',e.target.value)} placeholder="Brief description…"
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"/>
              </div>
              <SearchableSelect label={customerSingular} clearable
                options={customers.map(c=>({value:Number(c.id),label:String(c.customer_name||c.name||'')}))}
                value={form.customer_id?Number(form.customer_id):null}
                onChange={v=>setForm((p:any)=>({...p,customer_id:v?Number(v):null,link_type:'',lead_id:null,tender_id:null,work_order_id:null,emdbg_id:null}))}
                placeholder={`Link to ${customerSingular.toLowerCase()}…`}/>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Activity Date</label>
                <input type="date" value={form.activity_date} onChange={e=>set('activity_date',e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Link To</label>
                <div className="flex flex-wrap gap-1">
                  {LINK_TYPES.map(t=>(
                    <button key={t.key} type="button" disabled={!form.customer_id} onClick={()=>setLinkType(t.key)}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${currentLinkType===t.key?'border-blue-400 bg-blue-50 text-blue-700':'border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100'}`}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              <SearchableSelect label="Record" clearable disabled={!form.customer_id||!currentLinkType}
                options={linkOptionsMapped}
                value={linkIdField&&form[linkIdField]?Number(form[linkIdField]):null}
                onChange={v=>setLinkRecord(v?Number(v):null)}
                placeholder={!form.customer_id?`Select a ${customerSingular.toLowerCase()} first`:!currentLinkType?'Choose a type first':loadingLinkOptions?'Loading…':`Select ${LINK_TYPES.find(t=>t.key===currentLinkType)?.label}…`}/>
              {!isEdit&&DURATION_TYPES.includes(taskTypeName(form))&&(<div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Duration (min)</label>
                <input type="number" value={form.duration_minutes||''} onChange={e=>set('duration_minutes',parseInt(e.target.value)||0)}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
              </div>)}
              {!isEdit&&DURATION_TYPES.includes(taskTypeName(form))&&(<div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Start Time</label>
                <input type="time" value={form.start_time||''} onChange={e=>set('start_time',e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
              </div>)}
              {isTravelActivityType(form)&&(
                <div>
                  <Input label="Location" value={form.location||''} onChange={(v:any)=>set('location',typeof v==='string'?v:v?.target?.value||'')}/>
                  <div className="mt-1.5 flex items-center gap-2">
                    <button type="button" onClick={captureLocation} disabled={capturingLocation}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                      <MapPin size={12}/>{capturingLocation?'Capturing…':'Capture GPS Location'}
                    </button>
                    {form.latitude!=null&&form.longitude!=null&&(
                      <span className="text-[11px] text-emerald-600 font-medium">{Number(form.latitude).toFixed(5)}, {Number(form.longitude).toFixed(5)}</span>
                    )}
                  </div>
                  {locationError&&<p className="mt-1 text-[11px] text-red-500">{locationError}</p>}
                </div>
              )}
              {!isEdit&&<SearchableSelect label="Status" options={STATUSES.map(s=>({value:s,label:s}))} value={form.status} onChange={v=>set('status',v)}/>} 
            </FormGrid>
            )}
          </FormSection>)}
        </>
      )}

      {!isEdit&&taskTypeName(form)==='Follow Up'&&(
        <FormSection title="Follow-up Classification">
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              {Object.keys(FOLLOWUP_CATEGORIES).map(cat=>(
                <button key={cat} type="button" onClick={()=>{set('followup_category',cat);set('followup_sub_type','')}}
                  className={`text-xs px-2.5 py-2 rounded-xl border-2 font-medium transition-all ${form.followup_category===cat?'border-amber-400 bg-amber-50 text-amber-700':'border-gray-100 bg-gray-50 text-gray-600 hover:border-amber-200'}`}>{cat}</button>
              ))}
            </div>
            {form.followup_category&&(
              <div className="grid grid-cols-2 gap-2">
                {(FOLLOWUP_CATEGORIES[form.followup_category]||[]).map(sub=>(
                  <button key={sub} type="button" onClick={()=>set('followup_sub_type',sub)}
                    className={`text-xs px-2.5 py-2 rounded-xl border-2 text-left transition-all ${form.followup_sub_type===sub?'border-amber-400 bg-amber-50 text-amber-700 font-semibold':'border-gray-100 bg-gray-50 text-gray-600 hover:border-amber-200'}`}>{sub}</button>
                ))}
              </div>
            )}
          </div>
        </FormSection>
      )}

      {(() => {
        if (!(isEdit ? true : isLogUpdate ? (!!form.travel_request_id || isTravelActivityType(form)) : true)) return null

        const travelSectionContent = (
          <>
        {isLogUpdate ? (
          form.travel_request_id ? (
            <div className="border border-orange-200 rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 bg-orange-50 border-b border-orange-100">
                <Plane size={13} className="text-orange-500"/>
                <span className="text-xs font-semibold text-orange-800 flex-1">{form.travel_request_number||'Travel Request'}</span>
                {(form.travel_request_status||linkedTR?.status)&&(
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${TR_STATUS_STYLE[linkedTR?.status||form.travel_request_status]?.bg||'bg-gray-100'} ${TR_STATUS_STYLE[linkedTR?.status||form.travel_request_status]?.text||'text-gray-500'}`}>
                    {linkedTR?.status||form.travel_request_status}
                  </span>
                )}
              </div>
              <div className="p-4 space-y-2">
                <div className="flex items-center gap-1.5 text-sm text-gray-700">
                  <MapPin size={12} className="text-orange-400 flex-shrink-0"/>
                  <span>{linkedTR?.from_city||form.travel_from||'—'} → {linkedTR?.to_city||form.travel_to||'—'}</span>
                </div>
                {(linkedTR?.travel_date||form.tr_travel_date)&&(
                  <p className="text-xs text-gray-500 flex items-center gap-1.5">
                    <Calendar size={11} className="text-gray-400"/>
                    Travel: {linkedTR?.travel_date||form.tr_travel_date}
                    {(linkedTR?.return_date||form.tr_return_date)&&` → ${linkedTR?.return_date||form.tr_return_date}`}
                  </p>
                )}
                {(linkedTR?.transport_mode||form.tr_transport_mode)&&(
                  <p className="text-xs text-gray-500">{TRANSPORT_MODES_KAM[linkedTR?.transport_mode||form.tr_transport_mode]||(linkedTR?.transport_mode||form.tr_transport_mode)}</p>
                )}
                {(linkedTR?.visit_type||form.tr_visit_type)&&(
                  <p className="text-xs text-gray-500">Visit type: {linkedTR?.visit_type||form.tr_visit_type}</p>
                )}
              </div>
              {renderTravelRequestEditor()}
            </div>
          ) : (
            <>
              <label className="flex items-center gap-3 cursor-pointer p-3 bg-gray-50 rounded-xl mb-3">
                <div onClick={()=>set('has_travel',!form.has_travel)} className={`w-10 h-5 rounded-full transition-colors flex items-center cursor-pointer flex-shrink-0 ${form.has_travel?'bg-orange-500':'bg-gray-300'}`}>
                  <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform mx-0.5 ${form.has_travel?'translate-x-5':'translate-x-0'}`}/>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-800">This activity involves local travel</p>
                  <p className="text-xs text-gray-500">Log travel details for this activity</p>
                </div>
              </label>
              {form.has_travel&&(
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                  <div className="xl:col-span-4">
                    <Input label="From City" value={form.travel_from||''} onChange={(v:any)=>set('travel_from',typeof v==='string'?v:v?.target?.value||'')} placeholder="Departure city"/>
                  </div>
                  <div className="xl:col-span-4">
                    <Input label="To City" value={form.travel_to||''} onChange={(v:any)=>set('travel_to',typeof v==='string'?v:v?.target?.value||'')} placeholder="Destination city"/>
                  </div>
                  <div className="xl:col-span-4">
                    <SearchableSelect label="Travel Mode" options={TRAVEL_MODES.map(t=>({value:t,label:t}))} value={form.travel_mode||''} onChange={v=>set('travel_mode',v)} clearable/>
                  </div>
                </div>
              )}
            </>
          )
        ) : (
          <>
            {(
              <label className="flex items-center gap-3 cursor-pointer p-3 bg-gray-50 rounded-xl mb-3">
                <div onClick={()=>set('has_travel',!form.has_travel)} className={`w-10 h-5 rounded-full transition-colors flex items-center cursor-pointer flex-shrink-0 ${form.has_travel?'bg-orange-500':'bg-gray-300'}`}>
                  <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform mx-0.5 ${form.has_travel?'translate-x-5':'translate-x-0'}`}/>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-800">This activity involves travel</p>
                  <p className="text-xs text-gray-500">{showTRSection?'Enable to manage travel request':'Enable to log travel details'}</p>
                </div>
              </label>
            )}
            {form.has_travel&&(
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                  <div className="xl:col-span-4">
                    <Input label="From City" value={form.travel_from||''} onChange={(v:any)=>set('travel_from',typeof v==='string'?v:v?.target?.value||'')} placeholder="Departure city"/>
                  </div>
                  <div className="xl:col-span-4">
                    <Input label="To City" value={form.travel_to||''} onChange={(v:any)=>set('travel_to',typeof v==='string'?v:v?.target?.value||'')} placeholder="Destination city"/>
                  </div>
                  <div className="xl:col-span-4">
                    <SearchableSelect label="Travel Mode" options={TRAVEL_MODES.map(t=>({value:t,label:t}))} value={form.travel_mode||''} onChange={v=>set('travel_mode',v)} clearable/>
                  </div>
                </div>
                {showTRSection&&(
                  <div className={`p-3 rounded-xl border-2 cursor-pointer transition-all ${form.is_outside_district?'border-orange-300 bg-orange-50':'border-gray-200 bg-white hover:border-gray-300'}`}
                    onClick={()=>{set('is_outside_district',!form.is_outside_district);if(form.is_outside_district)set('tr_travel_date','')}}>
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center flex-shrink-0 ${form.is_outside_district?'bg-orange-500 border-orange-500':'border-gray-300 bg-white'}`}>
                        {form.is_outside_district&&<Check size={12} className="text-white" strokeWidth={3}/>}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-gray-800 flex items-center gap-1.5"><Navigation size={13} className="text-orange-500"/>Outside district / city</p>
                        <p className="text-xs text-gray-500 mt-0.5">Travel request applicable only for outside-district trips</p>
                      </div>
                    </div>
                  </div>
                )}
                {showTRSection&&form.is_outside_district&&!form.travel_request_id&&(
                  <div>
                    <Input
                      label="Travel Date"
                      required
                      type="date"
                      value={form.tr_travel_date||''}
                      onChange={e=>set('tr_travel_date',e.target.value)}
                    />
                  </div>
                )}
                {showTRSection&&form.is_outside_district&&!!form.travel_request_id&&(
                  <div className="border border-orange-200 rounded-xl overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-2.5 bg-orange-50 border-b border-orange-100">
                      <Plane size={13} className="text-orange-500"/>
                      <span className="text-xs font-semibold text-orange-800 flex-1">{form.travel_request_number||linkedTR?.request_number||'Travel Request'}</span>
                      {(form.travel_request_status||linkedTR?.status)&&(
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${TR_STATUS_STYLE[linkedTR?.status||form.travel_request_status]?.bg||'bg-gray-100'} ${TR_STATUS_STYLE[linkedTR?.status||form.travel_request_status]?.text||'text-gray-500'}`}>
                          {linkedTR?.status||form.travel_request_status}
                        </span>
                      )}
                    </div>
                    <div className="p-4 space-y-2">
                      <div className="flex items-center gap-1.5 text-sm text-gray-700">
                        <MapPin size={12} className="text-orange-400 flex-shrink-0"/>
                        <span>{linkedTR?.from_city||form.travel_from||'—'} → {linkedTR?.to_city||form.travel_to||'—'}</span>
                      </div>
                      {(linkedTR?.travel_date||form.tr_travel_date)&&(
                        <p className="text-xs text-gray-500 flex items-center gap-1.5">
                          <Calendar size={11} className="text-gray-400"/>
                          Travel: {linkedTR?.travel_date||form.tr_travel_date}
                          {(linkedTR?.return_date||form.tr_return_date)&&` → ${linkedTR?.return_date||form.tr_return_date}`}
                        </p>
                      )}
                    </div>
                    {renderTravelRequestEditor()}
                  </div>
                )}
                {showTRSection&&form.is_outside_district&&!!form.tr_travel_date&&!form.travel_request_id&&(
                  <div className="border border-orange-200 rounded-xl overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-2.5 bg-orange-50 border-b border-orange-100">
                      <Plane size={13} className="text-orange-500"/>
                      <span className="text-xs font-semibold text-orange-800 flex-1">Travel Request</span>
                      <span className="text-[10px] text-orange-500">Travel date: {form.tr_travel_date||'—'}</span>
                    </div>
                    {travelDateStatus==='past'&&(
                      <div className="flex items-start gap-2.5 px-4 py-3 bg-gray-50">
                        <Clock size={13} className="text-gray-400 flex-shrink-0 mt-0.5"/>
                        <div>
                          <p className="text-xs font-semibold text-gray-600">Travel date has passed</p>
                          <p className="text-[11px] text-gray-400 mt-0.5">Travel request cannot be raised for past travel dates.</p>
                        </div>
                      </div>
                    )}
                    {travelDateStatus==='late'&&(
                      <div className="flex items-start gap-2.5 px-4 py-3 bg-amber-50">
                        <Clock size={13} className="text-amber-500 flex-shrink-0 mt-0.5"/>
                        <div>
                          <p className="text-xs font-semibold text-amber-800">Within {advanceDays}-day advance window</p>
                          <p className="text-[11px] text-amber-600 mt-0.5">Must be raised at least {advanceDays} days before travel.</p>
                        </div>
                      </div>
                    )}
                    {travelDateStatus==='open'&&(
                      <div className="p-4 space-y-3">
                        <div className="flex gap-1 p-1 bg-gray-100 rounded-xl">
                          <button type="button" onClick={()=>setTrMode('link')}
                            className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-lg font-semibold transition-all ${trMode==='link'?'bg-white shadow-sm text-blue-600':'text-gray-500 hover:text-gray-700'}`}>
                            <Link2 size={11}/>Link Existing
                          </button>
                          <button type="button" onClick={()=>{setTrMode('create');set('travel_request_id',null)}}
                            className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-lg font-semibold transition-all ${trMode==='create'?'bg-white shadow-sm text-orange-600':'text-gray-500 hover:text-gray-700'}`}>
                            <Plus size={11}/>Create New
                          </button>
                        </div>
                        {trMode==='link'&&(
                          <div className="space-y-2">
                            <SearchableSelect label="Search Travel Request"
                              options={travelRequests.map((r:any)=>({value:r.id,label:`${r.request_number} — ${r.from_city||''}→${r.to_city||''} (${r.travel_date||''})`}))}
                              value={form.travel_request_id||null} onChange={v=>handleLinkTR(v?Number(v):null)}
                              placeholder="Select TR number…" clearable/>
                          </div>
                        )}
                        {trMode==='create'&&(
                          <div className="space-y-3">
                            <div className="grid grid-cols-1 gap-x-3 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
                              <div>
                                <Input
                                  label="Return Date"
                                  type="date"
                                  value={form.tr_return_date||''}
                                  onChange={e=>set('tr_return_date',e.target.value)}
                                  min={form.activity_date||''}
                                />
                              </div>
                              <div>
                                <SearchableSelect label="Visit Type" options={VISIT_TYPES_KAM.map(t=>({value:t,label:t}))} value={form.tr_visit_type||'Customer Visit'} onChange={v=>set('tr_visit_type',v)}/>
                              </div>
                              <div>
                                <SearchableSelect label="Transport Mode" options={Object.entries(TRANSPORT_MODES_KAM).map(([v,l])=>({value:v,label:l}))} value={form.tr_transport_mode||''} onChange={v=>set('tr_transport_mode',v)} clearable/>
                              </div>
                              <div className="xl:col-span-4">
                                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Estimated Cost (₹)</label>
                                <input type="text" inputMode="numeric" value={form.tr_estimated_cost ? Number(form.tr_estimated_cost).toLocaleString('en-IN') : ''} onChange={e=>set('tr_estimated_cost',e.target.value.replace(/,/g,''))}
                                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
                              </div>
                              <div className="xl:col-span-4">
                                <Input label="Contact Person" value={form.tr_contact_name||''} onChange={(v:any)=>set('tr_contact_name',typeof v==='string'?v:v?.target?.value||'')} placeholder="Person to meet"/>
                              </div>
                              <div className="xl:col-span-4">
                                <Input label="Contact Phone" value={form.tr_contact_phone||''} onChange={(v:any)=>set('tr_contact_phone',typeof v==='string'?v:v?.target?.value||'')} placeholder="+91 98765 43210"/>
                              </div>
                            </div>
                            <div className="flex items-start gap-2 p-3 bg-orange-50 border border-orange-200 rounded-xl">
                              <Plane size={12} className="text-orange-500 flex-shrink-0 mt-0.5"/>
                              <p className="text-xs text-orange-700">A <strong>Travel Request</strong> will be created and submitted for manager approval when you save.</p>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
          </>
        )

        return (isEdit || isLogUpdate) ? (
          <div className={`${isLogUpdate ? 'mb-4 ' : ''}w-full`}>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-4">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-orange-50 text-orange-600">
                  <Plane size={17}/>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Travel & TA/DA</h3>
                  <p className="mt-0.5 text-xs text-slate-500">Manage travel and allowance details for this activity</p>
                </div>
              </div>
              <div className="p-4">
                {travelSectionContent}
              </div>
            </div>
          </div>
        ) : (
          <div className="w-full">
            <FormSection title="Travel & TA/DA">
              {travelSectionContent}
            </FormSection>
          </div>
        )
      })()}

      {!isEdit&&isLogUpdate&&(
        <div className="mb-4 w-full">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 bg-white px-5 py-4">
              <h3 className="text-sm font-bold text-slate-900">Outcome & Next Action</h3>
              <p className="mt-0.5 text-xs text-slate-500">Capture the result, next step and internal notes in the standard form layout</p>
            </div>
            <div className="p-4">
              {showOutcome&&(
                <div className="mb-4">
                  {form.status==='Cancelled'&&(
                    <div className="mb-3">
                      <p className="mb-2 text-xs font-semibold text-slate-700">Cancellation Reason</p>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        {CANCELLATION_REASONS.map(r=>(
                          <button key={r} type="button" onClick={()=>set('cancellation_reason',r)}
                            className={`rounded-xl border px-3 py-2 text-left text-xs transition-all ${form.cancellation_reason===r?'border-red-300 bg-red-50 font-semibold text-red-700':'border-slate-200 bg-white text-slate-600 hover:border-red-200'}`}>{r}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  <Textarea
                    label={form.status==='Cancelled'?'Cancellation Details':'Outcome'}
                    required
                    value={form.outcome||''}
                    onChange={e=>set('outcome',e.target.value)}
                    rows={4}
                    placeholder={form.status==='Cancelled'?'Additional context':'What was discussed, decided, agreed upon'}
                    className="resize-none"
                  />
                </div>
              )}
              <div className="grid grid-cols-1 gap-x-3 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
                <div>
                  <Textarea
                    label={remarksLabel}
                    required={remarksRequired}
                    value={form.description||''}
                    onChange={e=>set('description',e.target.value)}
                    placeholder={remarksPlaceholder}
                    rows={3}
                    className="min-h-[120px] resize-none"
                  />
                </div>
                <div>
                  <Input
                    label="Next Action"
                    value={form.next_action||''}
                    onChange={e=>set('next_action',e.target.value)}
                    placeholder="e.g. Send revised proposal by Friday"
                  />
                </div>
                <div>
                  <Input
                    label="Next Action Date"
                    type="date"
                    value={form.next_action_date||''}
                    onChange={e=>set('next_action_date',e.target.value)}
                  />
                </div>
              </div>
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Paperclip size={14} className="text-slate-500"/>
                    <div>
                      <p className="text-xs font-bold text-slate-800">Document</p>
                      <p className="text-[11px] font-medium text-slate-400">Attach a proof, MOM, proposal, or supporting file</p>
                    </div>
                  </div>
                  {form.document_url&&(
                    <a href={form.document_url} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-blue-600 hover:bg-blue-50">
                      <Download size={12}/>View Current
                    </a>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                  <DropFileUpload
                    label={form.document_name || 'Upload or drag document'}
                    file={form.document_file || null}
                    accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.webp"
                    variant="panel"
                    helperText={form.document_file ? 'Selected document will be uploaded when you save the log' : 'PDF, Office files, or images'}
                    onFile={file=>set('document_file',file)}
                  />
                  {form.document_file&&(
                    <button type="button" onClick={()=>set('document_file',null)}
                      className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-slate-500 hover:bg-red-50 hover:text-red-500">
                      <Trash2 size={13}/>Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {!isEdit&&!isLogUpdate&&(<FormSection title="Outcome & Next Action">
        {showOutcome&&(
          <div className="mb-4 p-4 bg-gray-50 rounded-xl border border-gray-200">
            <label className="block text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
              {form.status==='Cancelled'?<><XCircle size={12} className="text-red-500"/>Cancellation Reason</>:<><CheckCircle size={12} className="text-emerald-500"/>Outcome</>}
              <span className="text-red-500">*</span>
            </label>
            {form.status==='Cancelled'&&(
              <div className="grid grid-cols-2 gap-1.5 mb-3">
                {CANCELLATION_REASONS.map(r=>(
                  <button key={r} type="button" onClick={()=>set('cancellation_reason',r)}
                    className={`text-xs text-left px-2.5 py-2 rounded-xl border-2 transition-all ${form.cancellation_reason===r?'border-red-400 bg-red-50 text-red-700 font-semibold':'border-gray-200 bg-white text-gray-600 hover:border-red-200'}`}>{r}</button>
                ))}
              </div>
            )}
            <textarea value={form.outcome||''} onChange={e=>set('outcome',e.target.value)} rows={4}
              placeholder={form.status==='Cancelled'?'Additional context…':'What was discussed, decided, agreed upon…'}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl resize-none focus:outline-none focus:border-blue-400 bg-white"/>
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          <div className="xl:col-span-4"><label className="block text-xs font-semibold text-gray-600 mb-1.5 flex items-center gap-1.5"><ArrowRight size={11}/>Next Action</label>
            <input value={form.next_action||''} onChange={e=>set('next_action',e.target.value)} placeholder="e.g. Send revised proposal by Friday"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/></div>
          <div className="xl:col-span-4"><label className="block text-xs font-semibold text-gray-600 mb-1.5 flex items-center gap-1.5"><Calendar size={11}/>Next Action Date</label>
            <input type="date" value={form.next_action_date||''} onChange={e=>set('next_action_date',e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/></div>
          <div className="xl:col-span-4"><label className="block text-xs font-semibold text-gray-600 mb-1.5 flex items-center gap-1.5"><FileText size={11}/>{remarksLabel}{remarksRequired&&<span className="text-red-500">*</span>}</label>
            <textarea value={form.description||''} onChange={e=>set('description',e.target.value)} rows={1}
              placeholder={remarksPlaceholder}
              className="min-h-[42px] w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl resize-none focus:outline-none focus:border-blue-400"/></div>
        </div>
      </FormSection>)}
    </>
  )
}


// ─── Activity Row ─────────────────────────────────────────────────────────────
// function ActivityRow({a,showUser,onLog,onEdit,onViewDetail}:{a:any;showUser?:boolean;onLog:(a:any)=>void;onEdit:(a:any)=>void;onViewDetail?:(a:any)=>void}) {
//   const typeName=taskTypeName(a)
//   const tc=TYPE_COLOR[typeName]||{bg:'bg-gray-50',text:'text-gray-400',dot:'bg-gray-300'}
//   const isDone=a.status==='Completed', isCan=a.status==='Cancelled', isOpen=!isDone&&!isCan
//   const sc=STATUS_CFG[a.status]||{bg:'bg-gray-100',text:'text-gray-500',border:'border-gray-200',icon:<Circle size={10}/>}
//   return (
//     <div
//       className={`flex flex-col gap-2.5 px-4 py-3 rounded-xl border transition-all group cursor-pointer
//         ${isDone?'bg-emerald-50/40 border-emerald-100 hover:bg-emerald-50':''}
//         ${isCan?'bg-red-50/30 border-red-100 opacity-60 hover:opacity-80':''}
//         ${isOpen?'bg-white border-gray-100 hover:border-blue-200 hover:bg-blue-50/20':''}`}
//       onClick={()=>onViewDetail&&onViewDetail(a)}
//     >
//       {/* Header row */}
//       <div className="flex items-start gap-3">
//         <div className={`w-1 h-5 rounded-full flex-shrink-0 mt-0.5 ${tc.dot}`}/>
//         <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${tc.bg} ${tc.text}`}>
//           {TYPE_ICON[typeName]||<Activity size={12}/>}
//         </div>
//         <div className="flex-1 min-w-0">
//           <p className={`text-sm font-semibold leading-snug truncate ${isCan?'line-through text-gray-400':'text-gray-800'}`}>{a.subject}</p>
//           <div className="flex items-center gap-2 mt-0.5 flex-wrap">
//             <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-md flex-shrink-0 ${tc.bg} ${tc.text}`}>{typeName}</span>
//             {showUser&&a.user_name&&<span className="text-[11px] text-blue-500 flex items-center gap-0.5 flex-shrink-0"><UserCircle size={10}/>{a.user_name}</span>}
//             {a.customer_name&&<span className="text-[11px] text-gray-400 flex items-center gap-0.5 flex-shrink-0"><Building2 size={10}/>{a.customer_name}</span>}
//             <span className="text-[11px] text-gray-400 flex items-center gap-0.5 flex-shrink-0"><Calendar size={10}/>{a.activity_date}</span>
//             {a.duration_minutes>0&&<span className="text-[11px] text-gray-400 flex items-center gap-0.5 flex-shrink-0"><Clock size={10}/>{a.duration_minutes}m</span>}
//             {a.has_travel&&<span className={`text-[10px] flex items-center gap-0.5 font-medium flex-shrink-0 ${a.is_outside_district?'text-orange-500':'text-gray-400'}`}>{a.is_outside_district?<Plane size={10}/>:<Car size={10}/>}{a.is_outside_district?'Outside':'Local'}</span>}
//           </div>
//         </div>
//         <div className="flex items-center gap-1.5 flex-shrink-0">
//           <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border flex-shrink-0 ${sc.bg} ${sc.text} ${sc.border}`}>{sc.icon}{a.status}</span>
//           {isOpen&&(
//             <button onClick={e=>{e.stopPropagation();onLog(a)}} className="flex items-center gap-1 px-2 py-1 text-[10px] bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold transition-colors whitespace-nowrap flex-shrink-0">
//               <Edit3 size={9}/>Log
//             </button>
//           )}
//           <button onClick={e=>{e.stopPropagation();onEdit(a)}} className="p-1 rounded-lg hover:bg-gray-100 text-gray-300 hover:text-gray-500 transition-colors flex-shrink-0">
//             <Edit3 size={11}/>
//           </button>
//         </div>
//       </div>
//       {/* Detail row */}
//       {(a.outcome||a.next_action)&&(
//         <div className="mt-1 flex items-center gap-3 text-[11px] overflow-hidden pl-11">
//           {a.outcome&&<span className={`flex items-center gap-1 px-2 py-0.5 rounded-md font-medium flex-shrink-0 ${isDone?'bg-emerald-50 text-emerald-700':'bg-red-50 text-red-600'}`}><CheckCircle size={9}/>{a.outcome}</span>}
//           {!a.outcome&&a.next_action&&<span className="flex items-center gap-1 text-blue-500 italic truncate"><ArrowRight size={9} className="flex-shrink-0"/>{a.next_action}{a.next_action_date&&<span className="text-blue-600 font-semibold not-italic ml-1 flex-shrink-0">{a.next_action_date}</span>}</span>}
//         </div>
//       )}
//     </div>
//   )
// }
// ─── Activity Table Row ───────────────────────────────────────────────────────
function ActivityRow({a,showUser,onLog,onEdit,onViewDetail}:{a:any;showUser?:boolean;onLog:(a:any)=>void;onEdit:(a:any)=>void;onViewDetail?:(a:any)=>void}) {
  const typeName=taskTypeName(a)
  const tc=TYPE_COLOR[typeName]||{bg:'bg-gray-50',text:'text-gray-400',dot:'bg-gray-300'}
  const isDone=a.status==='Completed', isCan=a.status==='Cancelled', isOpen=!isDone&&!isCan
  const { canUpdate }=useKAMPerms()
  const canEdit=canUpdate&&canEditActivity(a)
  const sc=STATUS_CFG[a.status]||{bg:'bg-gray-100',text:'text-gray-500',border:'border-gray-200',icon:<Circle size={10}/>}
  const today=new Date().toISOString().slice(0,10)
  const isOverdue=isOpen&&a.activity_date<today

  return (
    <tr
      className={`group cursor-pointer transition-colors
        ${isDone?'bg-emerald-50/30 hover:bg-emerald-50/60':''}
        ${isCan?'opacity-50 hover:opacity-70 bg-gray-50/30':''}
        ${isOverdue?'bg-red-50/30 hover:bg-red-50/50':''}
        ${isOpen&&!isOverdue?'bg-white hover:bg-blue-50/30':''}`}
      onClick={()=>onViewDetail&&onViewDetail(a)}
    >
      {/* Subject */}
      <td className="px-4 py-3 min-w-0">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            {isOverdue&&<span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-red-500"/>}
            <span className={`text-sm font-semibold truncate ${isCan?'line-through text-gray-400':'text-gray-800'}`}>{a.subject}</span>
            {isOverdue&&<span className="flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-600">overdue</span>}
          </div>
          {a.outcome&&isDone&&(
            <span className="flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded w-fit max-w-[260px] truncate">
              <CheckCircle size={9} className="flex-shrink-0"/><span className="truncate">{a.outcome}</span>
            </span>
          )}
          {!a.outcome&&a.next_action&&(
            <span className="flex items-center gap-1 text-[11px] text-blue-500 italic truncate max-w-[260px]">
              <ArrowRight size={9} className="flex-shrink-0 text-blue-400"/>
              <span className="truncate">{a.next_action}</span>
              {a.next_action_date&&<span className="not-italic font-semibold text-blue-600 flex-shrink-0 ml-0.5">{a.next_action_date}</span>}
            </span>
          )}
        </div>
      </td>

      {/* Type */}
      <td className="px-3 py-3 whitespace-nowrap">
        <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-semibold ${tc.bg} ${tc.text}`}>
          {TYPE_ICON[typeName]||<Activity size={11}/>}{typeName}
        </span>
      </td>

      {/* Customer */}
      <td className="px-3 py-3">
        {a.customer_name
          ?<span className="flex items-center gap-1 text-xs text-gray-500 max-w-[140px] truncate"><Building2 size={10} className="flex-shrink-0 text-gray-400"/>{a.customer_name}</span>
          :<span className="text-[11px] text-gray-300">—</span>}
      </td>

      {/* Date */}
      <td className="px-3 py-3 whitespace-nowrap">
        <span className={`text-xs font-medium ${isOverdue?'text-red-600':'text-gray-500'}`}>{a.activity_date}</span>
        {(a.duration_minutes||0)>0&&<p className="text-[10px] text-gray-400 flex items-center gap-0.5 mt-0.5"><Clock size={9}/>{a.duration_minutes}m</p>}
      </td>

      {/* Assigned (only when showUser) */}
      {showUser&&(
        <td className="px-3 py-3 whitespace-nowrap">
          {a.user_name
            ?<span className="flex items-center gap-1 text-[11px] text-blue-500"><UserCircle size={10}/>{a.user_name}</span>
            :<span className="text-[11px] text-gray-300">—</span>}
        </td>
      )}

      {/* Travel */}
      <td className="px-3 py-3 whitespace-nowrap">
        {a.has_travel
          ?<span className={`flex items-center gap-1 text-[10px] font-medium ${a.is_outside_district?'text-orange-500':'text-gray-400'}`}>
            {a.is_outside_district?<Plane size={10}/>:<Car size={10}/>}
            {a.is_outside_district?'Outside':'Local'}
          </span>
          :<span className="text-[11px] text-gray-300">—</span>}
      </td>

      {/* Status */}
      <td className="px-3 py-3 text-center whitespace-nowrap">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-semibold border ${sc.bg} ${sc.text} ${sc.border}`}>{sc.icon}{a.status}</span>
      </td>

      {/* Actions */}
      <td className="px-3 py-3 text-right whitespace-nowrap">
        <div className="flex items-center justify-end gap-1">
          {isOpen&&canUpdate&&(
            <button
              onClick={e=>{e.stopPropagation();onLog(a)}}
              className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors"
            ><Edit3 size={9}/>Log</button>
          )}
          {canEdit&&(
            <button
              onClick={e=>{e.stopPropagation();onEdit(a)}}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-300 hover:text-gray-500 transition-colors"
            >
              <Edit3 size={12}/>
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}
// ─── Activity Table wrapper ───────────────────────────────────────────────────
function ActivityTable({activities,showUser,today,onLog,onEdit,onViewDetail}:{
  activities:any[];showUser:boolean;today:string;
  onLog:(a:any)=>void;onEdit:(a:any)=>void;onViewDetail:(a:any)=>void
}) {
  const { singular: customerSingular } = useModuleName('customers')
  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50/80">
              <th className="px-4 py-2.5 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wide">Subject</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wide">Type</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wide">{customerSingular}</th>
              <th className="px-3 py-2.5 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wide">Date</th>
              {showUser&&<th className="px-3 py-2.5 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wide">Assigned</th>}
              <th className="px-3 py-2.5 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wide">Travel</th>
              <th className="px-3 py-2.5 text-center text-[10px] font-bold text-gray-400 uppercase tracking-wide">Status</th>
              <th className="px-3 py-2.5 text-right text-[10px] font-bold text-gray-400 uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {activities.map((a:any)=>(
              <ActivityRow key={a.id} a={a} showUser={showUser} onLog={onLog} onEdit={onEdit} onViewDetail={onViewDetail}/>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
// ─── Log Modal ────────────────────────────────────────────────────────────────
function requiresActivityRemarks(status: any) {
  return ['Postponed', 'Reopened', 'Cancelled'].includes(String(status || '').trim())
}

function LogSlidePanel({activity,customers,isAdmin,onSave,onClose,saving}:{
  activity:any;customers:any[];isAdmin:boolean;onSave:(f:any)=>void;onClose:()=>void;saving:boolean;
}) {
  const initialLogStatus = activity?.status || 'Completed'
  const [form,setForm]=useState<any>({...emptyActForm(),...activity,status:initialLogStatus,outcome:activity?.outcome||''})
  const [travelRequests,setTravelRequests]=useState<any[]>([])
  const [advanceDays,setAdvanceDays]=useState<number>(3)

  useEffect(()=>{
    if(!activity?.id) return
    Promise.all([
      api.get('/travel/requests').catch(()=>({data:[]})),
      api.get('/settings/settings').catch(()=>({data:{}})),
    ]).then(([trs,cfg])=>{
      const list=Array.isArray(trs.data)?trs.data:(trs.data?.items||[])
      setTravelRequests(list)
      const raw=cfg.data?.travel_request_advance_days
      setAdvanceDays(parseInt(typeof raw==='object'?raw?.value:raw)||3)
    })
  },[activity?.id])

  const hasRequiredRemarks=!requiresActivityRemarks(form.status)||form.description?.trim().length>0
  const statusChanged=String(form.status || '').trim()!==String(activity?.status || '').trim()
  const canSave=statusChanged && (form.status==='Completed'?form.outcome?.trim().length>0
    :form.status==='Cancelled'?(form.cancellation_reason?.trim().length>0||form.outcome?.trim().length>0)
    :form.subject?.trim().length>0) && hasRequiredRemarks

  return (
    <KAMFormShell
      breadcrumb="Activities"
      currentLabel="Update Activity Log"
      onBack={onClose}
      actions={
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={()=>canSave&&onSave(form)} disabled={!canSave} loading={saving}>
            Save Log
          </Button>
        </div>
      }
    >
      <LogActivityForm form={form} setForm={setForm} customers={customers} isAdmin={isAdmin}
        isLogUpdate={true} travelRequests={travelRequests} advanceDays={advanceDays}/>
    </KAMFormShell>
  )
}

// ─── Set Target Modal ─────────────────────────────────────────────────────────
function SetTargetModal({teamMembers,period,onSave,onClose,saving}:{
  teamMembers:any[];period:string;onSave:(data:any)=>void;onClose:()=>void;saving:boolean
}) {
  const initialYear = String(period || new Date().getFullYear()).slice(0,4)
  const [form,setForm]=useState({user_id:'',period:initialYear,calls_target:0,meetings_target:0,demos_target:0,site_visits_target:0,sales_target:0})
  const [mode,setMode]=useState<'add'|'replace'>('add')
  const [currentTarget,setCurrentTarget]=useState(0)
  const [loadingCurrent,setLoadingCurrent]=useState(false)
  const set=(k:string,v:any)=>setForm(p=>({...p,[k]:v}))
  const canSave=!!form.user_id && /^\d{4}$/.test(String(form.period)) && form.sales_target>0 && !(mode==='add'&&loadingCurrent)
  const assignable=teamMembers.filter((u:any)=>isSalesKAMUser(u.role))
  const finalTarget = mode==='add' ? currentTarget + form.sales_target : form.sales_target

  useEffect(()=>{
    if(!form.user_id||!form.period)return
    setCurrentTarget(0)
    setLoadingCurrent(true)
    api.get('/kam/targets/summary',{params:{user_id:form.user_id,period:form.period}})
      .then(r=>setCurrentTarget(Number(r.data?.sales_target||0)))
      .catch(()=>setCurrentTarget(0))
      .finally(()=>setLoadingCurrent(false))
  },[form.user_id,form.period])

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-indigo-50 to-violet-50">
          <div className="w-9 h-9 rounded-xl bg-indigo-100 flex items-center justify-center flex-shrink-0"><Target size={16} className="text-indigo-600"/></div>
          <div className="flex-1"><h3 className="font-semibold text-gray-900">Set Sales Target</h3><p className="text-xs text-gray-500 mt-0.5">Assign yearly sales target</p></div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16}/></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Team Member <span className="text-red-500">*</span></label>
            <select value={form.user_id} onChange={e=>set('user_id',e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-indigo-400 bg-white">
              <option value="">Select member…</option>
              {assignable.map(u=><option key={u.id} value={u.id}>{u.full_name}{u.is_self?' (You)':''}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Year</label>
            <input type="number" min="2000" max="2100" step="1" value={form.period} onChange={e=>set('period',e.target.value.slice(0,4))}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-indigo-400"/>
          </div>
          {/* Mode toggle */}
          <div className="flex rounded-xl border border-gray-200 overflow-hidden">
            <button onClick={()=>setMode('add')}
              className={`flex-1 py-2 text-xs font-semibold transition-colors ${mode==='add'?'bg-indigo-600 text-white':'bg-white text-gray-500 hover:bg-gray-50'}`}>
              + Add to Target
            </button>
            <button onClick={()=>setMode('replace')}
              className={`flex-1 py-2 text-xs font-semibold transition-colors ${mode==='replace'?'bg-indigo-600 text-white':'bg-white text-gray-500 hover:bg-gray-50'}`}>
              Replace Target
            </button>
          </div>
          <div className="bg-gradient-to-br from-indigo-50 to-violet-50 rounded-xl p-4 border border-indigo-100 space-y-3">
            <label className="block text-xs font-bold text-indigo-700 flex items-center gap-1.5">
              <IndianRupee size={12}/>{mode==='add'?'Amount to Add':'New Target Amount'}
            </label>
            {mode==='add'&&form.user_id&&(
              <div className="flex items-center justify-between text-xs text-gray-500 bg-white/70 rounded-lg px-3 py-2">
                <span>Current target</span>
                <span className="font-semibold text-gray-700">{loadingCurrent?'…':fmt(currentTarget)}</span>
              </div>
            )}
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500 font-semibold">₹</span>
              <input type="text" inputMode="numeric"
                value={form.sales_target ? Number(form.sales_target).toLocaleString('en-IN') : ''}
                onChange={e=>set('sales_target',parseFloat(e.target.value.replace(/,/g,''))||0)}
                placeholder="e.g. 1,00,00,000 for 1 Cr"
                className="w-full pl-7 pr-3 py-2.5 text-sm border border-indigo-200 rounded-xl focus:outline-none focus:border-indigo-500 bg-white font-semibold"/>
            </div>
            {mode==='add'&&form.user_id&&form.sales_target>0&&(
              <div className="flex items-center justify-between text-xs bg-indigo-600 text-white rounded-lg px-3 py-2">
                <span className="font-semibold">Total Target</span>
                <span className="font-bold">{fmt(finalTarget)}</span>
              </div>
            )}
            {mode==='replace'&&form.sales_target>0&&(
              <p className="text-xs text-indigo-600 font-semibold flex items-center gap-1"><Award size={11}/>{fmt(form.sales_target)} will replace current target</p>
            )}
          </div>
        </div>
        <div className="flex gap-2.5 px-5 py-4 border-t border-gray-100">
          <button onClick={onClose} className="flex-1 py-2.5 text-sm rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium">Cancel</button>
          <button onClick={()=>canSave&&onSave({...form,user_id:parseInt(form.user_id),sales_target:form.sales_target,target_mode:mode})} disabled={!canSave||saving}
            className="flex-1 py-2.5 text-sm rounded-xl font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 flex items-center justify-center gap-2">
            {saving&&<div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"/>}Set Target
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Plan Day Panel ───────────────────────────────────────────────────────────
function indianCurrencyWords(rawAmount:number) {
  const amount=Math.max(0,Math.floor(Number(rawAmount)||0))
  if(amount===0)return 'Zero Rupees Only'
  const ones=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen']
  const tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety']
  const belowThousand=(value:number):string=>{
    const parts:string[]=[]
    if(value>=100){parts.push(`${ones[Math.floor(value/100)]} Hundred`);value%=100}
    if(value>=20){parts.push(tens[Math.floor(value/10)]);if(value%10)parts.push(ones[value%10])}
    else if(value>0)parts.push(ones[value])
    return parts.join(' ')
  }
  const inWords=(value:number):string=>{
    const n=Math.floor(value)
    if(n<=0)return ''
    if(n<1000)return belowThousand(n)
    if(n<100000)return `${belowThousand(Math.floor(n/1000))} Thousand${n%1000 ? ` ${inWords(n%1000)}` : ''}`
    if(n<10000000)return `${inWords(Math.floor(n/100000))} Lakh${n%100000 ? ` ${inWords(n%100000)}` : ''}`
    return `${inWords(Math.floor(n/10000000))} Crore${n%10000000 ? ` ${inWords(n%10000000)}` : ''}`
  }
  return `${inWords(amount).trim()} Rupees Only`
}

function GroupTargetModal({groups,defaultGroupId,period,onSave,onClose,saving}:{
  groups:any[];defaultGroupId?:string;period:string;onSave:(data:any)=>void;onClose:()=>void;saving:boolean
}) {
  const [groupId,setGroupId]=useState(defaultGroupId||'')
  const [year,setYear]=useState(String(period||new Date().getFullYear()).slice(0,4))
  const [mode,setMode]=useState<'add'|'replace'>('add')
  const [inputAmount,setInputAmount]=useState(0)
  const [currentTarget,setCurrentTarget]=useState(0)
  const [currentAllocations,setCurrentAllocations]=useState<Array<{user_id:number;user_name:string;role:string;sales_target:number}>>([])
  const [loadingCurrent,setLoadingCurrent]=useState(false)
  const [totalTarget,setTotalTarget]=useState(0)
  const [allocations,setAllocations]=useState<Array<{user_id:number;user_name:string;role:string;sales_target:number}>>([])
  const selectedGroup=groups.find((group:any)=>String(group.id)===String(groupId))
  const allocationTotal=allocations.reduce((sum,row)=>sum+Number(row.sales_target||0),0)
  const difference=totalTarget-allocationTotal
  const matches=allocations.length>0&&difference===0
  const canSave=!!groupId&&/^\d{4}$/.test(year)&&totalTarget>0&&matches&&!saving&&!loadingCurrent&&(mode==='replace'||inputAmount>0)

  const splitTarget=useCallback((members:any[],rawTotal:number)=>{
    const total=Math.max(0,Math.floor(Number(rawTotal)||0))
    if(!members.length)return []
    const share=Math.floor(total/members.length)
    return members.map((member:any,index:number)=>({
      user_id:Number(member.user_id||member.id),
      user_name:String(member.user_name||member.name||member.full_name||'Team member'),
      role:String(member.role||''),
      sales_target:index===members.length-1?total-(share*(members.length-1)):share,
    }))
  },[])

  useEffect(()=>{
    const group=groups.find((item:any)=>String(item.id)===String(groupId))
    if(!group||!/^\d{4}$/.test(year)){
      setCurrentTarget(0);setCurrentAllocations([]);setAllocations([]);setTotalTarget(0);setInputAmount(0)
      return
    }
    let active=true
    setLoadingCurrent(true)
    api.get('/kam/targets/group/summary',{params:{group_id:groupId,period:year}})
      .then(response=>{
        if(!active)return
        const savedByUser=new Map<number,number>((response.data?.allocations||[]).map((row:any)=>[Number(row.user_id),Number(row.sales_target||0)]))
        const rows=(group.members||[]).map((member:any)=>({
          user_id:Number(member.user_id||member.id),
          user_name:String(member.user_name||member.name||member.full_name||'Team member'),
          role:String(member.role||''),
          sales_target:savedByUser.get(Number(member.user_id||member.id))||0,
        }))
        const savedTotal=rows.reduce((sum:number,row:any)=>sum+Number(row.sales_target||0),0)
        setCurrentTarget(savedTotal)
        setCurrentAllocations(rows)
        setAllocations(rows)
        setTotalTarget(savedTotal)
        setInputAmount(0)
        setMode('add')
      })
      .catch(()=>{
        if(!active)return
        const rows=splitTarget(group.members||[],0)
        setCurrentTarget(0);setCurrentAllocations(rows);setAllocations(rows);setTotalTarget(0);setInputAmount(0)
      })
      .finally(()=>{if(active)setLoadingCurrent(false)})
    return()=>{active=false}
  },[groupId,year,groups,splitTarget])

  const changeMode=(nextMode:'add'|'replace')=>{
    setMode(nextMode)
    if(nextMode==='add'){
      setInputAmount(0)
      setTotalTarget(currentTarget)
      setAllocations(currentAllocations.map(row=>({...row})))
    }else{
      setInputAmount(currentTarget)
      setTotalTarget(currentTarget)
      setAllocations(currentAllocations.map(row=>({...row})))
    }
  }

  const changeTotal=(raw:string)=>{
    const amount=Math.max(0,Math.floor(parseFloat(raw.replace(/,/g,''))||0))
    setInputAmount(amount)
    if(!selectedGroup)return
    if(mode==='add'){
      const additions=splitTarget(selectedGroup.members||[],amount)
      const currentByUser=new Map(currentAllocations.map(row=>[row.user_id,row.sales_target]))
      const next=additions.map(row=>({...row,sales_target:(currentByUser.get(row.user_id)||0)+row.sales_target}))
      setAllocations(next)
      setTotalTarget(next.reduce((sum,row)=>sum+row.sales_target,0))
    }else{
      const next=splitTarget(selectedGroup.members||[],amount)
      setAllocations(next)
      setTotalTarget(amount)
    }
  }
  const changeMemberTarget=(userId:number,raw:string)=>{
    const amount=Math.max(0,Math.floor(parseFloat(raw.replace(/,/g,''))||0))
    setAllocations(rows=>{
      const next=rows.map(row=>row.user_id===userId?{...row,sales_target:amount}:row)
      const nextTotal=next.reduce((sum,row)=>sum+Number(row.sales_target||0),0)
      setTotalTarget(nextTotal)
      setInputAmount(mode==='add'?nextTotal-currentTarget:nextTotal)
      return next
    })
  }
  const submit=()=>{
    if(!canSave)return
    onSave({group_id:Number(groupId),period:year,sales_target:totalTarget,allocations:allocations.map(row=>({user_id:row.user_id,sales_target:row.sales_target}))})
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm">
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-gray-100 bg-gradient-to-r from-indigo-50 to-violet-50 px-5 py-4">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-100"><Target size={16} className="text-indigo-600"/></div>
          <div className="flex-1"><h3 className="font-semibold text-gray-900">Set Group Revenue Target</h3><p className="mt-0.5 text-xs text-gray-500">Allocate a yearly target across the selected group hierarchy</p></div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16}/></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-gray-600">Group <span className="text-red-500">*</span></label>
              <select value={groupId} onChange={event=>setGroupId(event.target.value)} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-indigo-400">
                <option value="">Select group...</option>
                {groups.map((group:any)=><option key={group.id} value={group.id}>{group.name||group.group_name} ({(group.members||[]).length} members)</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-gray-600">Year</label>
              <input type="number" min="2000" max="2100" step="1" value={year} onChange={event=>setYear(event.target.value.slice(0,4))} className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-indigo-400"/>
            </div>
          </div>
          <div className="space-y-3 rounded-xl border border-indigo-100 bg-gradient-to-br from-indigo-50 to-violet-50 p-4">
            <label className="flex items-center gap-1.5 text-xs font-bold text-indigo-700"><IndianRupee size={12}/>{mode==='add'?'Amount to Add':'New Group Target'}</label>
            {groupId&&(
              <div className="grid overflow-hidden rounded-xl border border-indigo-100 bg-white/80 sm:grid-cols-[minmax(0,1.25fr)_minmax(120px,0.75fr)_minmax(120px,0.75fr)]">
                <div className="flex min-w-0 items-center justify-between gap-3 px-3.5 py-2.5 text-xs text-slate-500">
                  <span className="whitespace-nowrap font-semibold">Current Target</span>
                  <span className="truncate text-right font-black text-slate-800">{loadingCurrent?'...':fmt(currentTarget)}</span>
                </div>
                <button type="button" onClick={()=>changeMode('add')} className={`border-t border-indigo-100 px-3 py-2.5 text-xs font-black transition-colors sm:border-l sm:border-t-0 ${mode==='add'?'bg-indigo-600 text-white':'text-slate-500 hover:bg-indigo-50 hover:text-indigo-700'}`}>+ Add Target</button>
                <button type="button" onClick={()=>changeMode('replace')} className={`border-t border-indigo-100 px-3 py-2.5 text-xs font-black transition-colors sm:border-l sm:border-t-0 ${mode==='replace'?'bg-indigo-600 text-white':'text-slate-500 hover:bg-indigo-50 hover:text-indigo-700'}`}>Replace Target</button>
              </div>
            )}
            <div className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-gray-500">₹</span><input type="text" inputMode="numeric" value={inputAmount?inputAmount.toLocaleString('en-IN'):''} onChange={event=>changeTotal(event.target.value)} disabled={!groupId||loadingCurrent} placeholder={groupId?(mode==='add'?'Enter amount to add':'Enter replacement target'):'Select a group first'} className="w-full rounded-xl border border-indigo-200 bg-white py-2.5 pl-7 pr-3 text-sm font-semibold outline-none focus:border-indigo-500 disabled:bg-slate-50 disabled:text-slate-400"/></div>
            {inputAmount>0&&<p className="px-1 text-[12px] italic leading-relaxed text-slate-500">{indianCurrencyWords(inputAmount)}</p>}
            {selectedGroup&&<div className="flex items-center justify-between rounded-lg bg-white/70 px-3 py-2 text-xs text-gray-500"><span>{allocations.length} hierarchy members</span><span className="font-bold text-indigo-700">Final total {totalTarget>0?fmt(totalTarget):'₹0'}</span></div>}
          </div>
          {selectedGroup&&(
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
                <div><p className="text-xs font-black text-slate-800">Member-wise target allocation</p><p className="mt-0.5 text-[10px] font-semibold text-slate-400">Editable amounts; any split remainder goes to the last member</p></div>
                <span className={`rounded-full px-2.5 py-1 text-[10px] font-black ${matches&&totalTarget>0?'bg-emerald-100 text-emerald-700':'bg-indigo-100 text-indigo-700'}`}>{allocations.length} members</span>
              </div>
              <div className="max-h-[360px] overflow-y-auto">
                {allocations.map((row,index)=>(
                  <div key={row.user_id} className="grid items-center gap-4 border-b border-slate-100 px-4 py-2.5 last:border-b-0" style={{gridTemplateColumns:'32px minmax(0,1fr) minmax(210px,260px)'}}>
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-[10px] font-black text-indigo-600">{index+1}</span>
                    <span className="min-w-0"><span className="block truncate text-xs font-bold text-slate-900">{row.user_name}</span><span className="block truncate text-[10px] font-semibold capitalize text-slate-400">{String(row.role||'member').replace(/_/g,' ')}</span></span>
                    <span className="relative"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">₹</span><input type="text" inputMode="numeric" value={row.sales_target?row.sales_target.toLocaleString('en-IN'):''} onChange={event=>changeMemberTarget(row.user_id,event.target.value)} className="w-full rounded-lg border border-slate-200 py-2 pl-7 pr-3 text-right text-xs font-bold text-slate-800 outline-none focus:border-indigo-400"/></span>
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex items-center justify-between text-xs"><span className="font-bold text-slate-500">Allocated total</span><span className={`font-black ${matches?'text-emerald-600':'text-red-600'}`}>{fmt(allocationTotal)} / {fmt(totalTarget)}</span></div>
                {!matches&&totalTarget>0&&<p className="mt-1.5 flex items-center gap-1 text-[11px] font-bold text-red-600"><AlertCircle size={11}/>{difference>0?`${fmt(difference)} still needs to be allocated`:`Allocation exceeds group target by ${fmt(Math.abs(difference))}`}</p>}
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-2.5 border-t border-gray-100 px-5 py-4">
          <button onClick={onClose} className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
          <button onClick={submit} disabled={!canSave} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40">{saving&&<div className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"/>}Save Group Target</button>
        </div>
      </div>
    </div>
  )
}

interface PlanRow{id:string;customer_id:number|null;link_type:string;lead_id:number|null;tender_id:number|null;work_order_id:number|null;emdbg_id:number|null;activity_type:string;subject:string;on_behalf_of:number|null;activity_date?:string;start_time?:string;end_time?:string;duration_minutes?:number;latitude?:number|null;longitude?:number|null}
const emptyPlanRow=():PlanRow=>({id:Math.random().toString(36).slice(2),customer_id:null,link_type:'',lead_id:null,tender_id:null,work_order_id:null,emdbg_id:null,activity_type:'Phone Call',subject:'',on_behalf_of:null,start_time:'09:00',end_time:'10:00',duration_minutes:60,latitude:null,longitude:null})
const PLAN_LINK_TYPES = [
  {key:'lead',label:'Lead'},
  {key:'tender',label:'Tender'},
  {key:'opportunity',label:'Opportunity'},
]

function PlannerTimeInput({value,onChange,disabled=false,className=''}:{
  value?:string;onChange:(value:string)=>void;disabled?:boolean;className?:string
}) {
  return (
    <input
      type="time"
      lang="en-GB"
      step={60}
      value={value||''}
      disabled={disabled}
      onChange={e=>onChange(e.target.value)}
      className={`w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-medium text-gray-900 outline-none focus:border-blue-500 disabled:bg-gray-50 disabled:text-gray-300 ${className}`}
    />
  )
}

const timeToMinutes = (value?:string) => {
  const [h,m] = String(value||'').split(':').map(Number)
  if(!Number.isFinite(h)||!Number.isFinite(m)) return null
  return h*60+m
}
const durationFromTimes = (start?:string,end?:string) => {
  const s=timeToMinutes(start), e=timeToMinutes(end)
  if(s===null||e===null) return 0
  const diff=e-s
  return diff>0?diff:0
}
const durationFromDateTimes = (fromDate:string,fromTime:string,toDate:string,toTime:string) => {
  const start=new Date(`${fromDate}T${fromTime||'09:00'}:00`)
  const end=new Date(`${toDate||fromDate}T${toTime||'10:00'}:00`)
  const mins=Math.round((end.getTime()-start.getTime())/60000)
  return Number.isFinite(mins)&&mins>0?mins:0
}
const addMinutesToTime = (value:string,minutes:number) => {
  const base=timeToMinutes(value)||0
  const total=(base+minutes+1440)%1440
  return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`
}
const formatDurationLabel = (minutes:number) => {
  if(!minutes) return '0m'
  const h=Math.floor(minutes/60), m=minutes%60
  return h>0?`${h}h${m?` ${m}m`:''}`:`${m}m`
}

function PlanDayPanel({teamMembers,currentUserId,initialDate,initialStartTime,onSaveAll,saving,onClose}:{
  teamMembers:any[];currentUserId:number;initialDate:string;initialStartTime?:string|null;
  onSaveAll:(date:string,rows:PlanRow[])=>Promise<void>;saving:boolean;onClose:()=>void
}) {
  const { label: customerLabel, singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const { singular: leadSingular } = useModuleName('leads')
  const { singular: opportunitySingular } = useModuleName('opportunities')
  const { singular: tenderSingular } = useModuleName('tenders')
  const planLinkTypes = [
    {key:'lead',label:leadSingular},
    {key:'tender',label:tenderSingular},
    {key:'opportunity',label:opportunitySingular},
  ]
  const buildInitialRows=useCallback(()=>{
    const start=initialStartTime||'09:00'
    const end=addMinutesToTime(start,60)
    return [
      {...emptyPlanRow(),activity_date:initialDate,start_time:start,end_time:end,duration_minutes:60},
    ]
  },[initialDate,initialStartTime])
  const [planDate,setDate]=useState(initialDate||new Date().toISOString().slice(0,10))
  const [planScope,setPlanScope]=useState<'day'|'week'|'month'>('day')
  const [assignToAll,setAssign]=useState<number|null>(null)
  const [customers,setCustomers]=useState<any[]>([])
  const [loadingC,setLoadingC]=useState(false)
  const [rows,setRows]=useState<PlanRow[]>(()=>buildInitialRows())
  const canAssignTeam=teamMembers.length>1
  const assignableTeam=teamMembers

  useEffect(()=>{
    setDate(initialDate||new Date().toISOString().slice(0,10))
    setRows(buildInitialRows())
  },[initialDate,initialStartTime,buildInitialRows])

  const loadCustomers=useCallback(async(uid:number|null)=>{
    setLoadingC(true)
    try{const r=await api.get('/kam/plan-customers',{params:uid?{user_id:uid}:{}});setCustomers(Array.isArray(r.data)?r.data:[])}
    catch{setCustomers([])}finally{setLoadingC(false)}
  },[])
  useEffect(()=>{loadCustomers(assignToAll)},[assignToAll])

  const custOpts=customers.map(c=>({value:Number(c.id),label:String(c.customer_name||c.name||'')}))

  // ── Link record — one of Lead / Tender / Opportunity per row, scoped to the
  // selected customer. Opportunities are direct opportunities only
  // (lead_type=direct_opportunity). Cached per "customerId:type" so rows
  // sharing a customer+type don't refetch. ───────────────────────────────────
  const [linkOptionsByKey,setLinkOptionsByKey]=useState<Record<string,any[]>>({})
  const [loadingLinkKeys,setLoadingLinkKeys]=useState<Set<string>>(new Set())
  const ensureLinkOptions=useCallback((customerId:number,linkType:string)=>{
    if(!linkType) return
    const key=`${customerId}:${linkType}`
    if(linkOptionsByKey[key]||loadingLinkKeys.has(key)) return
    setLoadingLinkKeys(p=>new Set(p).add(key))
    ;(async()=>{
      try{
        let rows:any[]=[]
        const kind=linkType==='lead'?'leads':linkType==='tender'?'tenders':'opportunities'
        // all_time + customer_scope_only: this is "pick any record belonging to the
        // chosen customer to link", not a KPI-period widget — bypass the current-month
        // window and assignee-team scoping that /pipeline-records applies by default.
        const r=await api.get('/kam/pipeline-records',{params:{kind,customer_ids:String(customerId),all_time:true,customer_scope_only:true}})
        rows=Array.isArray(r.data)?r.data:[]
        if(linkType==='opportunity'){
          rows=rows.filter((row:any)=>String(row?.lead_type||'').trim().toLowerCase()==='direct_opportunity')
        }
        setLinkOptionsByKey(p=>({...p,[key]:rows}))
      }catch{ setLinkOptionsByKey(p=>({...p,[key]:[]})) }
      finally{ setLoadingLinkKeys(p=>{const n=new Set(p);n.delete(key);return n}) }
    })()
  },[linkOptionsByKey,loadingLinkKeys])
  const linkOptionsFor=(customerId:number|null,linkType:string)=>{
    if(!customerId||!linkType) return []
    const rows=linkOptionsByKey[`${customerId}:${linkType}`]||[]
    return rows.map((r:any)=>{
      if(linkType==='lead') return {value:Number(r.id),label:String(r.lead_title||r.lead_ref_id||`Lead #${r.id}`)}
      if(linkType==='tender') return {value:Number(r.id),label:String(r.tender_title||r.tender_num||`Tender #${r.id}`)}
      return {value:Number(r.id),label:String(r.lead_title||r.opportunity_ref_id||r.lead_ref_id||`Opportunity #${r.id}`)}
    })
  }
  const linkIdFieldFor=(linkType:string):keyof PlanRow|null =>
    linkType==='lead'?'lead_id':linkType==='tender'?'tender_id':linkType==='opportunity'?'lead_id':null
  const formatPlanValue = (value:number) => value > 0 ? `Rs. ${value.toLocaleString('en-IN')}` : '--'
  const selectedLinkRecordFor = (row:PlanRow) => {
    if(!row.customer_id || !row.link_type) return null
    const field = linkIdFieldFor(row.link_type)
    if(!field || !row[field]) return null
    const records = linkOptionsByKey[`${row.customer_id}:${row.link_type}`] || []
    return records.find((item:any)=>Number(item?.id)===Number(row[field])) || null
  }
  const previewToneFor = (linkType:string) => {
    if(linkType==='tender') return 'border-orange-200 bg-orange-50/70'
    if(linkType==='opportunity') return 'border-violet-200 bg-violet-50/70'
    return 'border-blue-200 bg-blue-50/70'
  }
  const previewTypeBadgeFor = (linkType:string) => {
    if(linkType==='tender') return 'bg-orange-100 text-orange-700'
    if(linkType==='opportunity') return 'bg-violet-100 text-violet-700'
    return 'bg-blue-100 text-blue-700'
  }
  const planRecordPreviewFor = (row:PlanRow, record:any) => {
    if(!record || !row.link_type) return null
    if(row.link_type==='tender'){
      const value = Number(record.bid_amount ?? record.est_value ?? record.tender_value ?? 0)
      return {
        typeLabel:'Tender',
        title:String(record.tender_title || record.portal_ref_number || record.tender_num || `Tender #${record.id}`),
        status:String(record.tender_status || record.result || record.status || 'Active'),
        statusTone:'bg-orange-100 text-orange-700',
        metaLabel:'Portal',
        metaValue:String(record.portal_name || record.portal || record.authority || '--'),
        valueLabel:value > 0 && record.bid_amount != null ? 'Bid Value' : 'Estimated Value',
        valueText:formatPlanValue(value),
      }
    }
    if(row.link_type==='opportunity'){
      const value = Number(record.est_value ?? record.opportunity_value ?? record.lead_value ?? 0)
      return {
        typeLabel:'Opportunity',
        title:String(record.lead_title || record.lead_name || record.opportunity_ref_id || `Opportunity #${record.id}`),
        status:String(record.status || record.opportunity_status || 'Active'),
        statusTone:'bg-violet-100 text-violet-700',
        metaLabel:'Source',
        metaValue:String(record.product_name || record.oem_name || record.source || record.lead_source || '--'),
        valueLabel:'Estimated Value',
        valueText:formatPlanValue(value),
      }
    }
    const value = Number(record.est_value ?? record.lead_value ?? 0)
    return {
      typeLabel:'Lead',
      title:String(record.lead_title || record.lead_name || record.lead_ref_id || `Lead #${record.id}`),
      status:String(record.status || record.lead_status || 'Active'),
      statusTone:'bg-blue-100 text-blue-700',
      metaLabel:'Source',
      metaValue:String(record.source || record.lead_source || '--'),
      valueLabel:'Estimated Value',
      valueText:formatPlanValue(value),
    }
  }

  const [capturingLocationFor,setCapturingLocationFor]=useState<string|null>(null)
  const [locationErrorFor,setLocationErrorFor]=useState<Record<string,string>>({})
  const requestPlannerLocation=useCallback(async(targetRowIds:string[])=>{
    if(targetRowIds.length===0) return null
    if(!window.isSecureContext){
      const error='GPS capture needs HTTPS (or localhost) - this page is loaded over plain HTTP.'
      setLocationErrorFor(p=>{
        const next={...p}
        targetRowIds.forEach(id=>{next[id]=error})
        return next
      })
      throw new Error(error)
    }
    if(!navigator.geolocation){
      const error='Location is not supported by this browser.'
      setLocationErrorFor(p=>{
        const next={...p}
        targetRowIds.forEach(id=>{next[id]=error})
        return next
      })
      throw new Error(error)
    }
    setLocationErrorFor(p=>{
      const next={...p}
      targetRowIds.forEach(id=>{delete next[id]})
      return next
    })
    setCapturingLocationFor(targetRowIds[0] || null)

    const runRequest=(options:PositionOptions)=>new Promise<{latitude:number;longitude:number}>((resolve,reject)=>{
      navigator.geolocation.getCurrentPosition(
        pos=>resolve({latitude:pos.coords.latitude,longitude:pos.coords.longitude}),
        reject,
        options,
      )
    })

    try{
      return await runRequest({enableHighAccuracy:true,timeout:15000,maximumAge:0})
    }catch(firstErr:any){
      const firstCode=Number(firstErr?.code || 0)
      if(firstCode!==2 && firstCode!==3) throw firstErr
      return await runRequest({enableHighAccuracy:false,timeout:20000,maximumAge:300000})
    }finally{
      setCapturingLocationFor(null)
    }
  },[])
  const captureRowLocation=(id:string)=>{
    requestPlannerLocation([id]).then(coords=>{
      if(!coords) return
      setRow(id,'latitude',coords.latitude)
      setRow(id,'longitude',coords.longitude)
    }).catch((err:any)=>{
      const code=Number(err?.code || 0)
      const error=code===1?'Location permission denied.':code===2?'Location unavailable.':code===3?'Location request timed out.':'Unable to capture location.'
      setLocationErrorFor(p=>({...p,[id]:error}))
    })
    return
    if(!window.isSecureContext){
      setLocationErrorFor(p=>({...p,[id]:'GPS capture needs HTTPS (or localhost) — this page is loaded over plain HTTP.'}))
      return
    }
    if(!navigator.geolocation){
      setLocationErrorFor(p=>({...p,[id]:'Location is not supported by this browser.'}))
      return
    }
    setLocationErrorFor(p=>{const n={...p}; delete n[id]; return n})
    setCapturingLocationFor(id)
    navigator.geolocation.getCurrentPosition(
      pos=>{ setRow(id,'latitude',pos.coords.latitude); setRow(id,'longitude',pos.coords.longitude); setCapturingLocationFor(null) },
      err=>{
        setCapturingLocationFor(null)
        setLocationErrorFor(p=>({...p,[id]:err.code===1?'Location permission denied.':err.code===2?'Location unavailable.':'Location request timed out.'}))
      },
      { enableHighAccuracy:true, timeout:10000 },
    )
  }

  const setRow=(id:string,k:keyof PlanRow,v:any)=>setRows(p=>p.map(r=>r.id===id?{...r,[k]:v}:r))
  const setRowCustomer=(id:string,customerId:number|null)=>{
    setRows(p=>p.map(r=>r.id===id?{...r,customer_id:customerId,link_type:'',lead_id:null,tender_id:null,work_order_id:null,emdbg_id:null}:r))
  }
  const setRowLinkType=(id:string,customerId:number|null,linkType:string)=>{
    setRows(p=>p.map(r=>r.id===id?{...r,link_type:linkType,lead_id:null,tender_id:null,work_order_id:null,emdbg_id:null}:r))
    if(customerId) ensureLinkOptions(customerId,linkType)
  }
  const setRowTime=(id:string,k:'start_time'|'end_time',v:string)=>setRows(p=>p.map(r=>{
    if(r.id!==id) return r
    const next={...r,[k]:v}
    return {...next,duration_minutes:durationFromTimes(next.start_time,next.end_time)}
  }))
  const addRow=()=>setRows(p=>[...p,{...emptyPlanRow(),activity_date:planDate}])
  const removeRow=(id:string)=>setRows(p=>p.filter(r=>r.id!==id))
  const dupRow=(row:PlanRow)=>setRows(p=>{const i=p.findIndex(r=>r.id===row.id);const nr={...row,id:Math.random().toString(36).slice(2),subject:''};const n=[...p];n.splice(i+1,0,nr);return n})
  const planRange=plannerRangeFor(planDate,planScope)
  const dateOptions=getDateKeysBetween(planRange.from,planRange.to)
  const validRows=rows.filter(r=>r.subject.trim()&&r.customer_id&&(planScope==='day'||r.activity_date||planDate))
  const planScopeLabel=planScope==='day'
    ? planDate
    : planScope==='month'
      ? parseDateKey(planDate).toLocaleDateString('en-IN',{month:'long',year:'numeric'})
      : `${planRange.from} to ${planRange.to}`
  const ensureMissingGpsBeforeSave=useCallback(async(rowsToSave:PlanRow[])=>{
    const nextRows=rowsToSave.map(row=>({...row}))
    const missingGpsRows=nextRows.filter(row=>row.latitude==null || row.longitude==null)
    if(missingGpsRows.length===0) return nextRows
    try{
      const coords=await requestPlannerLocation(missingGpsRows.map(row=>row.id))
      if(!coords) return nextRows
      missingGpsRows.forEach(row=>{
        row.latitude=coords.latitude
        row.longitude=coords.longitude
        setRow(row.id,'latitude',coords.latitude)
        setRow(row.id,'longitude',coords.longitude)
      })
      return nextRows
    }catch(err:any){
      const code=Number(err?.code || 0)
      const error=code===1?'Location permission denied.':code===2?'Location unavailable.':code===3?'Location request timed out.':'Unable to capture location.'
      setLocationErrorFor(p=>{
        const next={...p}
        missingGpsRows.forEach(row=>{next[row.id]=error})
        return next
      })
      throw err
    }
    for(const row of nextRows){
      if(row.latitude!=null && row.longitude!=null) continue
      const coords=await new Promise<{latitude:number;longitude:number}>((resolve,reject)=>{
        if(!window.isSecureContext){
          const error='GPS capture needs HTTPS (or localhost) â€” this page is loaded over plain HTTP.'
          setLocationErrorFor(p=>({...p,[row.id]:error}))
          reject(new Error(error))
          return
        }
        if(!navigator.geolocation){
          const error='Location is not supported by this browser.'
          setLocationErrorFor(p=>({...p,[row.id]:error}))
          reject(new Error(error))
          return
        }
        setLocationErrorFor(p=>{const n={...p}; delete n[row.id]; return n})
        setCapturingLocationFor(row.id)
        navigator.geolocation.getCurrentPosition(
          pos=>{
            const captured={latitude:pos.coords.latitude,longitude:pos.coords.longitude}
            setRow(row.id,'latitude',captured.latitude)
            setRow(row.id,'longitude',captured.longitude)
            setCapturingLocationFor(null)
            resolve(captured)
          },
          err=>{
            setCapturingLocationFor(null)
            const error=err.code===1?'Location permission denied.':err.code===2?'Location unavailable.':'Location request timed out.'
            setLocationErrorFor(p=>({...p,[row.id]:error}))
            reject(new Error(error))
          },
          {enableHighAccuracy:true,timeout:10000},
        )
      })
      row.latitude=coords.latitude
      row.longitude=coords.longitude
    }
    return nextRows
  },[])
  const handleSaveAll=useCallback(async()=>{
    if(validRows.length===0) return
    try{
      const rowsWithGps=await ensureMissingGpsBeforeSave(validRows)
      await onSaveAll(planDate,rowsWithGps)
    }catch{}
  },[ensureMissingGpsBeforeSave,onSaveAll,planDate,validRows])

  return (
  <div className="flex h-full min-h-0 flex-col bg-slate-50">

    {/* =========================================================
        TOP PLANNING CONTROLS
        ========================================================= */}
    <div className="flex-shrink-0 border-b border-slate-200 bg-white px-4 py-3">
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">

        <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_minmax(0,1.8fr)_120px] lg:items-end">

          {/* View */}
          <div className="flex h-full flex-col justify-end">
            <label className="mb-2 block min-h-[16px] text-[11px] font-bold uppercase tracking-[0.08em] text-slate-500">
              View
            </label>

            <div className="grid h-[38px] grid-cols-3 rounded-xl border border-slate-200 bg-slate-50 p-0.5">
              {(['day', 'week', 'month'] as const).map(scope => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => setPlanScope(scope)}
                  className={`
                    h-full rounded-lg px-2.5 py-1 text-xs font-semibold capitalize transition-all
                    ${
                      planScope === scope
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-500 hover:bg-white hover:text-slate-800'
                    }
                  `}
                >
                  {scope}
                </button>
              ))}
            </div>
          </div>

          {/* Plan Date */}
          <div className="flex h-full flex-col justify-end">
            <label className="mb-2 block min-h-[16px] text-[11px] font-bold uppercase tracking-[0.08em] text-slate-500">
              Plan Date
            </label>

            <div className="relative">
              <Calendar
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              />

              <input
                type="date"
                value={planDate}
                onChange={e => setDate(e.target.value)}
                className="
                  h-[38px] w-full rounded-xl border border-slate-200 bg-white
                  py-2 pl-10 pr-3 text-sm font-semibold text-slate-800
                  outline-none transition
                  focus:border-blue-500 focus:ring-2 focus:ring-blue-100
                "
              />
            </div>
          </div>

          {/* Assign All */}
          <div className="flex h-full flex-col justify-end">
            <label className="mb-2 block min-h-[16px] text-[11px] font-bold uppercase tracking-[0.08em] text-slate-500">
              Assign All To
            </label>

            {canAssignTeam && assignableTeam.length > 1 ? (
              <SearchableSelect
                options={[
                  {
                    value: null as any,
                    label: 'Myself (default)',
                  },
                  ...assignableTeam
                    .filter(user => user.id !== currentUserId)
                    .map(user => ({
                      value: user.id,
                      label: user.full_name,
                      subtitle: user.role,
                    })),
                ]}
                value={assignToAll}
                onChange={value => setAssign(value as number | null)}
                placeholder="Myself (default)"
                clearable
                className="!mb-0 [&_.form-field-shell]:!h-[38px] [&_.form-field-shell]:!rounded-xl"
              />
            ) : (
              <div className="flex h-[38px] items-center rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-700">
                <UserCircle size={16} className="mr-2 text-slate-400" />
                Myself (default)
              </div>
            )}
          </div>

          {/* Apply */}
          <div className="flex h-full flex-col justify-end">
            <div className="mb-2 min-h-[16px]" />
            <Button
              disabled={!canAssignTeam || assignableTeam.length <= 1}
              onClick={() =>
                setRows(previous =>
                  previous.map(row => ({
                    ...row,
                    on_behalf_of: assignToAll,
                  })),
                )
              }
              size="sm"
              className="!h-[38px] !w-full !rounded-xl !whitespace-nowrap"
            >
              Apply
            </Button>
          </div>
        </div>

        {/* Summary strip */}
        <div className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <Users size={15} className="text-blue-600" />
              <span className="font-semibold">
                {loadingC ? `Loading ${customerLabelLower}...` : `${custOpts.length} ${customerLabelLower}`}
              </span>
            </div>

            <span className="hidden h-5 w-px bg-slate-200 sm:block" />

            <div className="flex items-center gap-2 text-sm text-slate-700">
              <ListChecks size={15} className="text-blue-600" />
              <span>
                <strong>{validRows.length}</strong> of{' '}
                <strong>{rows.length}</strong> rows ready
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm font-semibold text-blue-700">
            <Calendar size={14} />
            {planScopeLabel}
          </div>
        </div>
      </div>
    </div>

    {/* =========================================================
        ACTIVITY ROWS
        ========================================================= */}
    <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
      {rows.map((row, index) => {
        const filled = Boolean(row.customer_id && row.subject.trim())

        const recordField = linkIdFieldFor(row.link_type)

        const selectedRecordValue =
          recordField && row[recordField]
            ? Number(row[recordField] as any)
            : null

        const recordLoadingKey = `${row.customer_id}:${row.link_type}`
        const selectedRecord = selectedLinkRecordFor(row)
        const recordPreview = planRecordPreviewFor(row, selectedRecord)
        const previewTone = previewToneFor(row.link_type)
        const previewTypeBadge = previewTypeBadgeFor(row.link_type)

        return (
          <div
            key={row.id}
            className={`
              overflow-hidden rounded-2xl border bg-white shadow-sm transition-all
              ${
                filled
                  ? 'border-emerald-200'
                  : 'border-slate-200 hover:border-blue-200'
              }
            `}
          >
            {/* Activity card header */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-slate-100 bg-slate-50/80 px-3 py-2.5">
              <div className="flex items-center gap-3">
                <span
                  className={`
                    flex h-7 w-7 items-center justify-center rounded-xl
                    text-sm font-bold
                    ${
                      filled
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-blue-100 text-blue-700'
                    }
                  `}
                >
                  {String(index + 1).padStart(2, '0')}
                </span>

                <div>
                  <p className="text-sm font-bold text-slate-800">
                    Activity {index + 1}
                  </p>

                  <p
                    className={`text-[11px] font-medium ${
                      filled ? 'text-emerald-600' : 'text-slate-400'
                    }`}
                  >
                    {filled
                      ? 'Ready to plan'
                      : `${customerSingular} and subject are required`}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {filled && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                    <CheckCircle size={12} />
                    Ready
                  </span>
                )}

                <button
                  type="button"
                  onClick={() => dupRow(row)}
                  title="Duplicate activity"
                  className="
                    flex h-8 w-8 items-center justify-center rounded-xl
                    border border-slate-200 bg-white text-slate-500 transition
                    hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700
                  "
                >
                  <Plus size={16} />
                </button>

                <button
                  type="button"
                  disabled={rows.length <= 1}
                  onClick={() => {
                    if (rows.length > 1) {
                      removeRow(row.id)
                    }
                  }}
                  title="Remove activity"
                  className="
                    flex h-8 w-8 items-center justify-center rounded-xl
                    border border-slate-200 bg-white text-slate-400 transition
                    hover:border-red-200 hover:bg-red-50 hover:text-red-500
                    disabled:cursor-not-allowed disabled:opacity-30
                  "
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="space-y-3 p-3">

              {/* Activity type, customer and link type */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">

                {/* Activity Type Dropdown */}
                <SearchableSelect
                  label="Activity Type"
                  required
                  options={ACTIVITY_TYPES.map(type => ({
                    value: type,
                    label: type,
                  }))}
                  value={row.activity_type || null}
                  onChange={value =>
                    setRow(
                      row.id,
                      'activity_type',
                      String(value || 'Phone Call'),
                    )
                  }
                  placeholder="Select activity type"
                />

                {/* Customer Dropdown */}
                <SearchableSelect
                  label={customerSingular}
                  required
                  options={custOpts}
                  value={
                    row.customer_id
                      ? Number(row.customer_id)
                      : null
                  }
                  onChange={value =>
                    setRowCustomer(
                      row.id,
                      value ? Number(value) : null,
                    )
                  }
                  placeholder={
                    loadingC
                      ? `Loading ${customerLabelLower}...`
                      : custOpts.length === 0
                        ? `No ${customerLabelLower} available`
                        : `Search ${customerSingular.toLowerCase()}`
                  }
                  clearable
                />

                {/* Link To Dropdown */}
                <SearchableSelect
                  label="Link To"
                  disabled={!row.customer_id}
                  clearable
                  options={planLinkTypes.map(type => ({
                    value: type.key,
                    label: type.label,
                  }))}
                  value={row.link_type || null}
                  onChange={value =>
                    setRowLinkType(
                      row.id,
                      row.customer_id,
                      String(value || ''),
                    )
                  }
                  placeholder={
                    row.customer_id
                      ? 'Select link type'
                      : `Select ${customerSingular.toLowerCase()} first`
                  }
                />
              </div>

              {/* Record, subject and assignee */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                <div>
                  <SearchableSelect
                    label="Record"
                    disabled={!row.customer_id || !row.link_type}
                    clearable
                    options={linkOptionsFor(
                      row.customer_id,
                      row.link_type,
                    )}
                    value={selectedRecordValue}
                    onChange={value => {
                      const field = linkIdFieldFor(row.link_type)

                      if (field) {
                        setRow(
                          row.id,
                          field,
                          value ? Number(value) : null,
                        )
                      }
                    }}
                    placeholder={
                      !row.customer_id
                        ? `Select ${customerSingular.toLowerCase()} first`
                        : !row.link_type
                          ? 'Select link type first'
                          : loadingLinkKeys.has(recordLoadingKey)
                            ? 'Loading records...'
                            : 'Select record'
                    }
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-600">
                    Subject / Purpose <span className="text-red-500">*</span>
                  </label>

                  <input
                    value={row.subject}
                    onChange={event =>
                      setRow(
                        row.id,
                        'subject',
                        event.target.value,
                      )
                    }
                    placeholder="Enter subject or purpose of activity"
                    className="
                      h-[38px] w-full rounded-xl border border-slate-200
                      bg-white px-3 text-sm text-slate-800 outline-none
                      transition placeholder:text-slate-400
                      focus:border-blue-500 focus:ring-2 focus:ring-blue-100
                    "
                  />
                </div>

                {canAssignTeam && assignableTeam.length > 1 ? (
                  <div>
                    <SearchableSelect
                      label="Assign To"
                      options={[
                        {
                          value: null as any,
                          label: 'Myself',
                        },
                        ...assignableTeam
                          .filter(
                            user => user.id !== currentUserId,
                          )
                          .map(user => ({
                            value: user.id,
                            label: user.full_name,
                            subtitle: user.role,
                          })),
                      ]}
                      value={row.on_behalf_of}
                      onChange={value =>
                        setRow(
                          row.id,
                          'on_behalf_of',
                          value,
                        )
                      }
                      placeholder="Myself"
                      clearable
                    />
                  </div>
                ) : (
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold text-slate-600">
                      Assign To
                    </label>
                    <div className="flex h-[38px] items-center rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-700">
                      Myself
                    </div>
                  </div>
                )}
              </div>

              {recordPreview && (
                <div className={`rounded-2xl border px-3 py-3 ${previewTone}`}>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold ${previewTypeBadge}`}>
                          {recordPreview.typeLabel}
                        </span>
                        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold ${recordPreview.statusTone}`}>
                          {recordPreview.status}
                        </span>
                      </div>
                      <p className="mt-2 truncate text-sm font-bold text-slate-900">
                        {recordPreview.title}
                      </p>
                    </div>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:min-w-[300px]">
                      <div className="rounded-xl bg-white/80 px-3 py-2">
                        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">
                          {recordPreview.metaLabel}
                        </p>
                        <p className="mt-1 truncate text-xs font-semibold text-slate-700">
                          {recordPreview.metaValue}
                        </p>
                      </div>
                      <div className="rounded-xl bg-white/80 px-3 py-2">
                        <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">
                          {recordPreview.valueLabel}
                        </p>
                        <p className="mt-1 truncate text-xs font-semibold text-slate-700">
                          {recordPreview.valueText}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Time row */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">

                {/* Start Time */}
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-600">
                    Start Time
                  </label>

                  <PlannerTimeInput
                    value={row.start_time || ''}
                    onChange={value =>
                      setRowTime(row.id, 'start_time', value)
                    }
                    className="
                      h-[38px] rounded-xl border-slate-200
                      focus:border-blue-500
                    "
                  />
                </div>

                {/* End Time */}
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-600">
                    End Time
                  </label>

                  <PlannerTimeInput
                    value={row.end_time || ''}
                    onChange={value =>
                      setRowTime(row.id, 'end_time', value)
                    }
                    className="
                      h-[38px] rounded-xl border-slate-200
                      focus:border-blue-500
                    "
                  />
                </div>

                {/* Total Time */}
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-600">
                    Total Time
                  </label>

                  <div className="flex h-[38px] items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-700">
                    <Clock size={15} className="text-slate-400" />

                    {formatDurationLabel(
                      row.duration_minutes ??
                        durationFromTimes(
                          row.start_time,
                          row.end_time,
                        ),
                    )}
                  </div>
                </div>
              </div>

              {/* Activity Date for week/month */}
              {planScope !== 'day' && (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold text-slate-600">
                      Activity Date
                    </label>

                    <select
                      value={row.activity_date || planDate}
                      onChange={event =>
                        setRow(
                          row.id,
                          'activity_date',
                          event.target.value,
                        )
                      }
                      className="
                        h-[38px] w-full rounded-xl border border-slate-200
                        bg-white px-3 text-sm text-slate-800 outline-none
                        transition focus:border-blue-500
                        focus:ring-2 focus:ring-blue-100
                      "
                    >
                      {dateOptions.map(date => (
                        <option key={date} value={date}>
                          {formatActivityDate(date, {
                            weekday: true,
                          })}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* Keep GPS errors visible, but do not show coordinates */}
              {locationErrorFor[row.id] && (
                <div className="flex items-start gap-2 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs font-medium text-red-600">
                  <AlertCircle
                    size={14}
                    className="mt-0.5 flex-shrink-0"
                  />
                  {locationErrorFor[row.id]}
                </div>
              )}
            </div>
          </div>
        )
      })}

      {/* Add activity */}
      <button
        type="button"
        onClick={addRow}
        className="
          flex w-full items-center justify-center gap-2 rounded-2xl
          border-2 border-dashed border-blue-200 bg-blue-50/40
          py-2.5 text-sm font-semibold text-blue-700 transition
          hover:border-blue-400 hover:bg-blue-50
        "
      >
        <Plus size={16} />
        Add New Activity
      </button>
    </div>

    {/* =========================================================
        FOOTER ACTION BAR
        ========================================================= */}
    <div className="flex flex-shrink-0 flex-col gap-3 border-t border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
          <Calendar size={18} />
        </div>

        <div>
          <p className="text-sm font-bold text-slate-800">
            Plan your activities
          </p>

          {capturingLocationFor ? (
            <p className="flex items-center gap-1.5 text-xs font-medium text-blue-600">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
              Getting your location…
            </p>
          ) : validRows.length > 0 ? (
            <p className="text-xs font-medium text-emerald-600">
              {validRows.length}{' '}
              {validRows.length === 1
                ? 'activity is'
                : 'activities are'}{' '}
              ready to save
            </p>
          ) : (
            <p className="text-xs text-slate-500">
              Fill {customerSingular.toLowerCase()} and subject to plan your activity
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        <Button
          onClick={onClose}
          variant="outline"
          size="sm"
          className="!rounded-xl"
        >
          Cancel
        </Button>

        <Button
          onClick={handleSaveAll}
          disabled={validRows.length === 0 || saving || !!capturingLocationFor}
          icon={<Calendar size={15} />}
          loading={saving || !!capturingLocationFor}
          size="sm"
          className="!min-w-[180px] !rounded-xl !whitespace-nowrap"
        >
          {capturingLocationFor
            ? 'Getting location…'
            : <>Plan{' '}
              {validRows.length > 1
                ? `${validRows.length} Activities`
                : 'Activity'}</>}
        </Button>
      </div>
    </div>
  </div>
)
}

// ─── Quick Plan Activity Popup ────────────────────────────────────────────────
function MonthPlanQuickModal({date,initialStartTime,teamMembers,currentUserId,saving,onSaveAll,onClose}:{
  date:string;initialStartTime?:string|null;teamMembers:any[];currentUserId:number;saving:boolean;
  onSaveAll:(date:string,rows:PlanRow[])=>Promise<void>;onClose:()=>void;
}) {
  const displayDate=parseDateKey(date).toLocaleDateString('en-IN',{weekday:'long',day:'2-digit',month:'short',year:'numeric'})

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/40 px-4 py-8">
      <button type="button" className="absolute inset-0" onClick={onClose} aria-label="Close quick activity planner"/>
      <div className="relative flex h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Plan Activity</h3>
            <p className="mt-0.5 text-xs font-medium text-gray-500">{displayDate}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
            <X size={17}/>
          </button>
        </div>

        <div className="min-h-0 flex-1">
          <PlanDayPanel
            teamMembers={teamMembers}
            currentUserId={currentUserId}
            initialDate={date}
            initialStartTime={initialStartTime}
            onSaveAll={onSaveAll}
            saving={saving}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  )
}

function popupRecordDateKey(row:any) {
  const value = row.created_at || row.created_date || row.customer_since || row.lead_date ||
    row.tender_date || row.published_date || row.submission_date || row.submission_deadline ||
    row.work_order_date || row.wo_date || row.po_date || row.updated_at || ''
  if(!value) return ''
  const text=String(value)
  const direct=text.match(/^(\d{4}-\d{2}-\d{2})/)
  if(direct) return direct[1]
  const parsed=new Date(value)
  return Number.isNaN(parsed.getTime())?'':parsed.toISOString().slice(0,10)
}

function popupDateLabel(value:any) {
  if(!value) return '--'
  const parsed=new Date(value)
  return Number.isNaN(parsed.getTime())?'--':parsed.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})
}

function popupPrimaryContact(row:any) {
  const contacts=Array.isArray(row.contacts)?row.contacts:[]
  const contact=contacts.find((item:any)=>item?.is_primary)||contacts[0]||{}
  return {
    name:contact.contact_name||contact.name||row.contact_person||row.contact_name||row.customer_contact_name||'',
    phone:contact.mobile||contact.office_phone||row.mobile||row.contact_mobile||row.contact_phone||row.phone||'',
    email:contact.office_email||contact.email||row.email||row.contact_email||row.customer_email||'',
    department:contact.department||row.department||'',
  }
}

function PopupTableFilters({
  clients,assignedTo,client,assignee,fromDate,toDate,
  onClientChange,onAssigneeChange,onFromDateChange,onToDateChange,onClear,
}:{
  clients:string[];assignedTo:string[];client:string;assignee:string;fromDate:string;toDate:string;
  onClientChange:(value:string)=>void;onAssigneeChange:(value:string)=>void;
  onFromDateChange:(value:string)=>void;onToDateChange:(value:string)=>void;onClear:()=>void;
}) {
  const { label: customerLabel } = useModuleName('customers')
  const active=Boolean(client||assignee||fromDate||toDate)
  const controlClass='h-9 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-slate-700 outline-none transition-colors focus:border-blue-400'
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 xl:flex-nowrap">
      <select value={client} onChange={event=>onClientChange(event.target.value)} className={`${controlClass} w-[220px]`} aria-label={`Filter by ${customerLabel}`}>
        <option value="">All {customerLabel}</option>
        {clients.map(option=><option key={option} value={option}>{option}</option>)}
      </select>
      <select value={assignee} onChange={event=>onAssigneeChange(event.target.value)} className={`${controlClass} w-[220px]`} aria-label="Filter by assigned person">
        <option value="">All Assigned To</option>
        {assignedTo.map(option=><option key={option} value={option}>{option}</option>)}
      </select>
      <input type="date" value={fromDate} max={toDate||undefined} onChange={event=>onFromDateChange(event.target.value)} className={`${controlClass} w-[138px]`} aria-label="From date" title="From date"/>
      <input type="date" value={toDate} min={fromDate||undefined} onChange={event=>onToDateChange(event.target.value)} className={`${controlClass} w-[138px]`} aria-label="To date" title="To date"/>
      {active&&(
        <button type="button" onClick={onClear} className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700" title="Clear filters" aria-label="Clear filters">
          <X size={14}/>
        </button>
      )}
    </div>
  )
}

function CustomerListPopup({customers,myCustomers=[],teamMembers=[],isAdminOrCEO=false,totalCount,onClose}:{
  customers:any[];myCustomers?:any[];teamMembers?:any[];isAdminOrCEO?:boolean;totalCount?:number;
  onClose:()=>void;
}) {
  const { label: customerLabel, singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const { singular: leadSingular } = useModuleName('leads')
  const [search,setSearch]=useState('')
  const [clientFilter,setClientFilter]=useState('')
  const [assigneeFilter,setAssigneeFilter]=useState('')
  const [fromDate,setFromDate]=useState('')
  const [toDate,setToDate]=useState('')

  const myIds=useMemo(()=>new Set(myCustomers.map((c:any)=>Number(c.id))),[myCustomers])
  const customerValue = (c:any) => Number(c.potential_value ?? c.customer_potential_value ?? c.annual_revenue ?? c.revenue ?? c.lead_value ?? c.tender_value ?? c.wo_value ?? c.won_value ?? 0)
  const totalPotential=useMemo(()=>customers.reduce((s:number,c:any)=>s+customerValue(c),0),[customers])

  // Build list with owner info
  const allWithOwner=useMemo(()=>customers.map((c:any)=>{
    const isMine=!isAdminOrCEO&&myIds.has(Number(c.id))
    // assigned person: use direct field first, then look up from teamMembers
    const assignedName=c.assigned_to_name||c.owner_name||null
    const teamOwner=teamMembers.find((m:any)=>String(m.user_id||m.id)===String(c.assigned_to||c.created_by))
    const ownerLabel=assignedName||(teamOwner?teamOwner.user_name||teamOwner.full_name:null)
    return {...c,isMine,ownerLabel}
  }),[customers,myIds,teamMembers,isAdminOrCEO])

  // Admin/CEO: alphabetical flat; others: mine first (alpha), then team (alpha)
  const sorted=useMemo(()=>{
    if(isAdminOrCEO) return [...allWithOwner].sort((a:any,b:any)=>(a.customer_name||'').localeCompare(b.customer_name||''))
    return [
      ...allWithOwner.filter(c=>c.isMine).sort((a:any,b:any)=>(a.customer_name||'').localeCompare(b.customer_name||'')),
      ...allWithOwner.filter(c=>!c.isMine).sort((a:any,b:any)=>(a.customer_name||'').localeCompare(b.customer_name||'')),
    ]
  },[allWithOwner,isAdminOrCEO])

  const displayList=sorted.filter(c=>{
    if(!search) return true
    const q=search.toLowerCase()
    return c.customer_name?.toLowerCase().includes(q)
      ||c.city?.toLowerCase().includes(q)
      ||c.vertical?.toLowerCase().includes(q)
      ||(c.ownerLabel||'').toLowerCase().includes(q)
  })

  const mineCount=isAdminOrCEO?0:allWithOwner.filter(c=>c.isMine).length
  const teamCount=isAdminOrCEO?0:allWithOwner.filter(c=>!c.isMine).length
  const displayTotal=totalCount??customers.length
  const clientOptions=Array.from(new Set(sorted.map((c:any)=>String(c.customer_name||'').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b))
  const assigneeOptions=Array.from(new Set(sorted.map((c:any)=>String(c.ownerLabel||'').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b))
  const filteredDisplayList=displayList.filter((c:any)=>{
    const dateKey=popupRecordDateKey(c)
    return (!clientFilter||c.customer_name===clientFilter) &&
      (!assigneeFilter||c.ownerLabel===assigneeFilter) &&
      (!fromDate||Boolean(dateKey&&dateKey>=fromDate)) &&
      (!toDate||Boolean(dateKey&&dateKey<=toDate))
  })
  const customerTableRows=filteredDisplayList.map((c:any,idx:number)=>({
    ...c,
    _table_id:String(c.id ?? c.customer_id ?? idx),
    _city:c.city||c.billing_city||c.location||'',
    _state:c.state||c.billing_state||'',
    _segment:c.customer_vertical||c.vertical||c.segment||'',
    _division:c.division||'',
    _owner:c.ownerLabel||'',
    _value:customerValue(c),
    _account_status:c.account_status||c.status||'Active',
    _account_potential:c.account_potential||c.potential_rating||'',
    _contact:popupPrimaryContact(c),
    _last_activity_type:c.last_activity_type||c.last_activity||'',
    _last_activity_date:c.last_activity_date||c.last_activity_at||c.updated_at||'',
  }))
  const customerColumns:Column<any>[]=[
    {
      key:'customer_name',header:customerSingular,sortable:true,searchable:true,
      searchKeys:['group_name','_city','_state','_segment','_owner'],minWidth:'220px',
      render:(_:unknown,c:any)=>(
        <div className="flex min-w-0 items-center gap-3">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[11px] font-bold text-white ${!isAdminOrCEO&&c.isMine?'bg-blue-600':'bg-slate-600'}`}>
            {(c.customer_name||'?').substring(0,2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-slate-900">{c.customer_name||'--'}</p>
            <p className="mt-0.5 truncate text-[11px] font-medium text-slate-400">{c.group_name||`ID: ${c.customer_id ?? c.id ?? '--'}`}</p>
          </div>
        </div>
      ),
    },
    {key:'_segment',header:'Segment',sortable:true,searchable:true,minWidth:'145px',render:(v:unknown,c:any)=><div><p className="font-semibold text-slate-700">{String(v||'--')}</p><p className="mt-1 text-[10px] text-slate-400">{c._division||c._contact.department||'--'}</p></div>},
    {key:'_city',header:'Location',sortable:true,searchable:true,minWidth:'125px',render:(v:unknown,c:any)=><div><p className="font-semibold text-slate-700">{String(v||'--')}</p><p className="mt-1 text-[10px] text-slate-400">{c._state||'--'}</p></div>},
    {key:'_account_status',header:'Status',sortable:true,align:'center',minWidth:'100px',render:(v:unknown)=>{
      const s=String(v||'')
      const cls=s==='Active'?'bg-emerald-50 text-emerald-700 border-emerald-200':s==='Prospect'?'bg-sky-50 text-sky-700 border-sky-200':s==='Churned'?'bg-rose-50 text-rose-700 border-rose-200':'bg-slate-50 text-slate-600 border-slate-200'
      return <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-bold ${cls}`}>{s||'--'}</span>
    }},
    {key:'_account_potential',header:'Potential',sortable:true,align:'center',minWidth:'105px',render:(v:unknown,c:any)=>{
      const p=String(v||'')
      const cls=p==='High'?'bg-rose-100 text-rose-700':p==='Medium'?'bg-amber-100 text-amber-700':p==='Low'?'bg-slate-100 text-slate-600':'bg-slate-100 text-slate-400'
      return <div><span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${cls}`}>{p||'--'}</span><p className="mt-1 text-xs font-black text-slate-950">{c._value>0?fmt(c._value):'--'}</p></div>
    }},
    {key:'_owner',header:'Assigned To',sortable:true,searchable:true,minWidth:'140px',render:(v:unknown)=><span className="font-semibold text-slate-700">{String(v||'--')}</span>},
    {
      key:'_contact',header:'Contact',searchable:true,minWidth:'145px',
      render:(_:unknown,c:any)=><div><p className="truncate text-xs font-semibold text-slate-800">{c._contact.name||'--'}</p><p className="mt-1 truncate text-[10px] text-slate-400">{c._contact.phone||c._contact.email||'--'}</p></div>,
    },
    {key:'_last_activity_date',header:'Last Activity',sortable:true,minWidth:'125px',render:(_:unknown,c:any)=><div><p className="truncate text-xs font-semibold text-slate-800">{c._last_activity_type||'--'}</p><p className="mt-1 text-[10px] text-slate-400">{popupDateLabel(c._last_activity_date)}</p></div>},
  ]
  const customerFilters=(
    <PopupTableFilters
      clients={clientOptions}
      assignedTo={assigneeOptions}
      client={clientFilter}
      assignee={assigneeFilter}
      fromDate={fromDate}
      toDate={toDate}
      onClientChange={setClientFilter}
      onAssigneeChange={setAssigneeFilter}
      onFromDateChange={setFromDate}
      onToDateChange={setToDate}
      onClear={()=>{setClientFilter('');setAssigneeFilter('');setFromDate('');setToDate('')}}
    />
  )

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 bg-white px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-800">
            <Building2 size={16} className="text-white"/>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-black text-gray-900">{customerSingular} Directory</h3>
            <p className="mt-0.5 text-xs text-gray-400">
              {isAdminOrCEO?(
                <>
                  <span className="text-slate-600 font-semibold">{displayTotal} {customerLabelLower}</span>
                  {totalPotential>0&&<> · <span className="text-emerald-600 font-semibold">{fmt(totalPotential)}</span></>}
                </>
              ):(
                <>
                  <span className="text-blue-600 font-semibold">{mineCount} mine</span>
                  {teamCount>0&&<> · <span className="text-gray-500 font-semibold">{teamCount} team</span></>}
                  {' '}· {displayTotal} total
                  {totalPotential>0&&<> · <span className="text-emerald-600 font-semibold">{fmt(totalPotential)}</span></>}
                </>
              )}
            </p>
          </div>
          <button onClick={onClose} className="rounded-xl p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"><X size={18}/></button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <KAMDataTable
            columns={customerColumns}
            data={customerTableRows}
            keyField="_table_id"
            onSearchChange={setSearch}
            searchValue={search}
            searchPlaceholder={`Search by ${customerSingular.toLowerCase()} name, city, vertical or assigned person...`}
            exportFilename={`${customerLabelLower.replace(/\s+/g, '-')}-directory`}
            emptyMessage={`No ${customerLabelLower} found`}
            emptyIcon={<Building2 size={24}/>}
            toolbar={customerFilters}
            toolbarVariant="compact"
            maxHeight="calc(88vh - 245px)"
            compact
          />
        </div>

        {false&&(<>
        {/* Search */}
        <div className="shrink-0 border-b border-gray-100 px-5 py-3">
          <div className="relative">
            <Building2 size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"/>
            <input value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Search by name, city, vertical or assigned person…"
              className="w-full rounded-xl border border-gray-200 bg-gray-50 py-2 pl-8 pr-7 text-sm focus:border-blue-400 focus:outline-none"/>
            {search&&<button onClick={()=>setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"><X size={12}/></button>}
          </div>
        </div>

        {/* Table */}
        <div className="min-h-0 flex-1 overflow-auto">
          {displayList.length===0?(
            <div className="py-12 text-center">
              <Building2 size={28} className="mx-auto text-gray-200 mb-3"/>
              <p className="text-sm text-gray-400 font-medium">No {customerLabelLower} found</p>
              {search&&<p className="text-xs text-gray-300 mt-1">Try a different search</p>}
            </div>
          ):(
            <>
              <table className="min-w-full border-separate border-spacing-0 text-left">
                <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-black uppercase text-slate-500">
                  <tr>
                    <th className="border-b border-slate-200 px-5 py-3">{customerSingular}</th>
                    <th className="border-b border-slate-200 px-4 py-3">City</th>
                    <th className="border-b border-slate-200 px-4 py-3">Vertical</th>
                    <th className="border-b border-slate-200 px-4 py-3">Assigned To</th>
                    <th className="border-b border-slate-200 px-4 py-3 text-right">Value</th>
                    <th className="border-b border-slate-200 px-5 py-3 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {displayList.map((c:any,idx:number)=>(
                    <tr key={c.id??idx} className={`${!isAdminOrCEO&&c.isMine?'bg-blue-50/30':'bg-white'} transition-colors hover:bg-slate-50`}>
                      <td className="px-5 py-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[11px] font-bold text-white ${!isAdminOrCEO&&c.isMine?'bg-blue-600':'bg-slate-600'}`}>
                            {(c.customer_name||'?').substring(0,2).toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <p className="max-w-[340px] truncate text-sm font-bold text-slate-900">{c.customer_name||'--'}</p>
                            <p className="mt-0.5 text-[11px] font-medium text-slate-400">ID: {c.customer_id ?? c.id ?? '--'}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm font-semibold text-slate-700">{c.city||c.billing_city||c.location||'--'}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-slate-700">{c.vertical||c.customer_vertical||c.segment||'--'}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-slate-700">{c.ownerLabel||'--'}</td>
                      <td className="px-4 py-3 text-right text-sm font-black text-slate-950">
                        {customerValue(c)>0 ? fmt(customerValue(c)) : '--'}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex justify-end gap-1.5">
                          {!isAdminOrCEO&&c.isMine&&(
                            <span className="rounded-lg bg-blue-100 px-2 py-1 text-[10px] font-black text-blue-700">Mine</span>
                          )}
                          <span className={`rounded-lg px-2 py-1 text-[10px] font-black ${c.source==='lead'?'bg-violet-50 text-violet-600':'bg-emerald-50 text-emerald-600'}`}>
                            {c.source==='lead'?leadSingular:customerSingular}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="hidden">
              {displayList.map((c:any,idx:number)=>(
                <div key={c.id??idx}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors ${
                    isAdminOrCEO
                      ?'bg-gray-50/40 hover:bg-gray-50 border-transparent hover:border-gray-100'
                      :c.isMine
                        ?'bg-blue-50/50 hover:bg-blue-50 border-transparent hover:border-blue-100'
                        :'bg-gray-50/40 hover:bg-gray-50 border-transparent hover:border-gray-100'
                  }`}>
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0 ${
                    !isAdminOrCEO&&c.isMine?'bg-gradient-to-br from-blue-500 to-indigo-600':'bg-gradient-to-br from-slate-400 to-slate-600'
                  }`}>
                    {(c.customer_name||'?').substring(0,2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate text-gray-800">{c.customer_name}</p>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      {(c.city||c.vertical)&&(
                        <p className="text-[11px] text-gray-400 truncate">{[c.city,c.vertical].filter(Boolean).join(' · ')}</p>
                      )}
                      {c.ownerLabel&&(
                        <span className="text-[10px] text-violet-500 font-medium flex-shrink-0">· {c.ownerLabel}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {!isAdminOrCEO&&c.isMine&&(
                      <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-lg font-bold">Mine</span>
                    )}
                    <span className={`text-[10px] px-2 py-0.5 rounded-lg font-semibold ${c.source==='lead'?'bg-violet-50 text-violet-600':'bg-emerald-50 text-emerald-600'}`}>
                      {c.source==='lead'?leadSingular:customerSingular}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            </>
          )}
        </div>
        </>)}
      </div>
    </div>
  )
}

// ─── Activity Detail Card (inline split-pane, for activities tab) ────────────
type MemberDetailsTab = 'customers'|'leads'|'opportunities'|'tenders'|'workorders'|'activities'
type MemberDetailsData = Record<MemberDetailsTab, any[]>
type MemberMetricSummary = { count: number; value: number }
type MemberRecordSummary = Partial<Record<MemberDetailsTab, MemberMetricSummary>>
type MemberRecordSummaryMap = Record<number, MemberRecordSummary>
type CustomerBusinessRecords = {
  leads: any[]
  opportunities: any[]
  tenders: any[]
  workorders: any[]
}
type CustomerDrillKind = 'leads' | 'opportunities' | 'tenders' | 'workorders'

const emptyMemberDetailsData = (): MemberDetailsData => ({
  customers: [],
  leads: [],
  opportunities: [],
  tenders: [],
  workorders: [],
  activities: [],
})

const emptyCustomerBusinessRecords = (): CustomerBusinessRecords => ({
  leads: [],
  opportunities: [],
  tenders: [],
  workorders: [],
})

const memberDetailsRecordValue = (tab: MemberDetailsTab, row: any) => {
  if (tab === 'workorders') return workOrderValue(row)
  if (tab === 'activities') return 0
  if (tab === 'customers') {
    return Number(row.potential_value ?? row.customer_potential_value ?? row.annual_revenue ?? row.revenue ?? row.lead_value ?? row.tender_value ?? row.wo_value ?? 0)
  }
  return Number(row.est_value ?? row.lead_value ?? row.bid_amount ?? row.opportunity_value ?? row.total_value ?? 0)
}

const summarizeMemberDetailsRows = (tab: MemberDetailsTab, rows: any[] = []): MemberMetricSummary => ({
  count: rows.length,
  value: rows.reduce((sum: number, row: any) => sum + memberDetailsRecordValue(tab, row), 0),
})

const summarizeMemberDetailsData = (data: MemberDetailsData): MemberRecordSummary => ({
  customers: summarizeMemberDetailsRows('customers', data.customers),
  leads: summarizeMemberDetailsRows('leads', data.leads),
  opportunities: summarizeMemberDetailsRows('opportunities', data.opportunities),
  tenders: summarizeMemberDetailsRows('tenders', data.tenders),
  workorders: summarizeMemberDetailsRows('workorders', data.workorders),
  activities: summarizeMemberDetailsRows('activities', data.activities),
})

function MemberDetailsModal({
  member,
  data,
  loading,
  activeTab,
  onTabChange,
  onClose,
}:{
  member:any
  data:MemberDetailsData
  loading:boolean
  activeTab:MemberDetailsTab
  onTabChange:(tab:MemberDetailsTab)=>void
  onClose:()=>void
}) {
  const { label: customerLabel, singular: customerSingular } = useModuleName('customers')
  const { label: leadLabel, singular: leadSingular } = useModuleName('leads')
  const { label: opportunityLabel, singular: opportunitySingular } = useModuleName('opportunities')
  const { label: tenderLabel, singular: tenderSingular } = useModuleName('tenders')
  const { label: workOrderLabel, singular: workOrderSingular } = useModuleName('workorders')
  const [search,setSearch]=useState('')
  const [maximized,setMaximized]=useState(false)
  useEffect(()=>setSearch(''),[activeTab])

  const memberName = member?.user_name || member?.full_name || 'Team Member'
  const tabs:{key:MemberDetailsTab;label:string;sub:string;icon:React.ReactNode}[] = [
    {key:'customers',label:customerLabel,sub:`${customerLabel}, contacts`,icon:<Building2 size={15}/>},
    {key:'leads',label:leadLabel,sub:`${customerLabel}, contact, dates`,icon:<UserCircle size={15}/>},
    {key:'opportunities',label:opportunityLabel,sub:'Products, OEMs',icon:<Star size={15}/>},
    {key:'tenders',label:tenderLabel,sub:'Bids, approval',icon:<FileText size={15}/>},
    {key:'workorders',label:workOrderLabel,sub:'PO, delivery, value',icon:<Package size={15}/>},
    {key:'activities',label:'Activities',sub:'Meetings, follow-ups',icon:<Activity size={15}/>},
  ]
  const activeRows = data[activeTab] || []
  const recordValue = (row:any) => memberDetailsRecordValue(activeTab, row)
  const totalValue = activeRows.reduce((sum:number,row:any)=>sum+recordValue(row),0)
  const detailRows = activeRows.map((row:any,idx:number)=>{
    const contact = activeTab==='customers' ? popupPrimaryContact(row) : null
    return {
      ...row,
      _card_id:String(row.id ?? row.customer_id ?? row.wo_id ?? row.wrk_order_id ?? idx),
      _title:activeTab==='customers'
        ? row.customer_name||customerSingular
        : activeTab==='workorders'
          ? row.project_title||row.tender_title||row.wrk_order_id||row.po_num||workOrderSingular
          : activeTab==='tenders'
            ? row.tender_title||row.portal_ref_number||row.tender_num||tenderSingular
            : activeTab==='activities'
              ? row.subject||row.title||row.activity_type||'Activity'
              : row.lead_title||row.lead_name||row.customer_name||leadSingular,
      _subtitle:activeTab==='customers'
        ? [row.city||row.billing_city,row.vertical||row.customer_vertical||row.segment].filter(Boolean).join(' - ')
        : activeTab==='activities'
          ? row.description||row.outcome||''
          : row.customer_name||'',
      _customer:row.customer_name||'',
      _contact_name:contact?.name||row.contact_person||row.contact_name||row.customer_contact_name||'',
      _contact_phone:contact?.phone||row.mobile||row.contact_mobile||row.contact_phone||row.phone||'',
      _contact_email:row.email||row.contact_email||row.customer_email||'',
      _contact:[
        contact?.name||row.contact_person||row.contact_name||row.customer_contact_name,
        contact?.phone||row.mobile||row.contact_mobile||row.contact_phone||row.phone,
        row.email||row.contact_email||row.customer_email,
      ].filter(Boolean).join(' | '),
      _assigned:row.assigned_to_name||row.owner_name||row.assigned_to||row.user_name||'',
      _status:activeTab==='workorders'
        ? row.wo_status||'Draft'
        : activeTab==='tenders'
          ? row.tender_status||row.result||''
          : row.status||'',
      _result:row.result||'',
      _reference:row.portal_ref_number||row.tender_num||row.tender_id_ref||row.opportunity_ref_id||row.ref_number||row.po_num||row.wrk_order_id||'',
      _value:recordValue(row),
      _value_label:recordValue(row)>0 ? fmt(recordValue(row)) : '',
      _date:activeTab==='activities'
        ? row.activity_date||row.start_time||row.created_at||row.updated_at
        : popupRecordDateKey(row),
      _type:row.activity_type||row.type||row.source_name||row.source||'',
      _source:row.lead_source||row.source_name||row.source||row.order_source||'',
      _stage:row.stage||row.lead_stage||'',
      _location:[row.billing_city||row.city,row.state_name||row.billing_state].filter(Boolean).join(', '),
      _segment:row.customer_vertical||row.vertical||row.industry||row.segment||'',
      _account_type:row.customer_type||row.account_type||row.group_name||'',
      _oem_product:row.oem||row.product_name||'',
      _close_date:row.expected_close_date||'',
      _submission_date:row.submission_date||'',
      _result_date:row.result_date||'',
      _portal:row.portal_name||row.tender_portal||'',
      _po_date:row.po_date||'',
      _delivery_date:row.delivery_date||row.dlvry_date||'',
      _outcome:row.outcome||row.description||'',
      _next_action:row.next_action||row.follow_up||row.timeline||'',
    }
  })
  const q = search.trim().toLowerCase()
  const filteredRows = q
    ? detailRows.filter((row:any)=>[
        row._title,row._subtitle,row._customer,row._contact_name,row._contact_phone,
        row._assigned,row._status,row._reference,row._type,row._outcome,row._next_action,
      ].some((field:any)=>String(field||'').toLowerCase().includes(q)))
    : detailRows
  const activeLabel = tabs.find(tab=>tab.key===activeTab)?.label || 'records'
  const activeIcon = tabs.find(tab=>tab.key===activeTab)?.icon
  const detailPairs = (row: any): [string,string][] => {
    const pairs: [string,string][] = []
    if (activeTab !== 'customers' && row._customer) pairs.push([customerSingular, row._customer])
    if (row._contact_name || row._contact_phone)
      pairs.push(['Contact', [row._contact_name, row._contact_phone].filter(Boolean).join(' · ')])
    if (activeTab === 'customers') {
      const email = row.email || row.contact_email || row.customer_email
      if (email) pairs.push(['Email', email])
      const city = row.billing_city || row.city
      const state = row.state_name || row.billing_state
      if (city && state) pairs.push(['Location', `${city}, ${state}`])
      else if (city) pairs.push(['Location', city])
      else if (state) pairs.push(['Location', state])
      const seg = row.customer_vertical || row.vertical || row.industry || row.segment
      if (seg) pairs.push(['Segment', seg])
      const acct = row.customer_type || row.account_type || row.group_name
      if (acct) pairs.push(['Account Type', acct])
    }
    if (row._assigned) pairs.push(['Assigned To', row._assigned])
    if (row._date) pairs.push(['Date', popupDateLabel(row._date)])
    if (activeTab === 'workorders') {
      if (row.po_date && row.po_date !== row._date) pairs.push(['PO Date', popupDateLabel(row.po_date)])
      if (row.delivery_date) pairs.push(['Delivery', popupDateLabel(row.delivery_date)])
      const src = row.source_name || row.order_source
      if (src) pairs.push(['Source', src])
    }
    if (activeTab === 'tenders') {
      if (row.submission_date) pairs.push(['Submission', popupDateLabel(row.submission_date)])
      if (row.result_date) pairs.push(['Result Date', popupDateLabel(row.result_date)])
      const portal = row.portal_name || row.tender_portal
      if (portal) pairs.push(['Portal', portal])
    }
    if (activeTab === 'leads') {
      const src = row.lead_source || row.source_name || row.source
      if (src) pairs.push(['Source', src])
      const stage = row.stage || row.lead_stage
      if (stage) pairs.push(['Stage', stage])
    }
    if (activeTab === 'opportunities') {
      const oem = row.oem || row.product_name
      if (oem) pairs.push(['OEM/Product', oem])
      if (row.expected_close_date) pairs.push(['Close Date', popupDateLabel(row.expected_close_date)])
    }
    if (activeTab === 'activities') {
      if (row._outcome) pairs.push(['Outcome', row._outcome])
      if (row._next_action) pairs.push(['Next Action', row._next_action])
    }
    return pairs
  }
  const statusTone = (status:string) => {
    if(activeTab==='workorders') return workOrderStatusBadge(status||'Draft')
    const s = String(status||'').toLowerCase()
    if(['won','converted','completed','active'].includes(s)) return 'bg-emerald-50 text-emerald-700'
    if(['lost','cancelled','canceled'].includes(s)) return 'bg-red-50 text-red-700'
    if(['submitted','qualified','in progress'].includes(s)) return 'bg-blue-50 text-blue-700'
    return 'bg-slate-100 text-slate-700'
  }
  const cellText = (value:any, className = 'text-xs font-semibold text-slate-700') => (
    <span className={`block truncate ${className} ${value ? '' : 'text-slate-300'}`}>{value || '--'}</span>
  )
  const dateText = (value:any) => cellText(value ? popupDateLabel(value) : '')
  const valueText = (value:any) => (
    <span className={`text-xs font-black ${Number(value||0)>0?'text-slate-900':'text-slate-300'}`}>
      {Number(value||0)>0 ? fmt(Number(value||0)) : '--'}
    </span>
  )
  const statusBadge = (value:any) => {
    const label = String(value || '').trim()
    return label
      ? <span className={`rounded-lg px-2 py-1 text-[10px] font-black ${statusTone(label)}`}>{label}</span>
      : <span className="text-xs font-semibold text-slate-300">--</span>
  }
  const titleCell = (title:any, subtitle?:any, badge?:React.ReactNode) => (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <p className="truncate text-sm font-bold text-slate-900">{String(title||'--')}</p>
        {badge}
      </div>
      {subtitle&&<p className="mt-0.5 truncate text-[11px] font-medium text-slate-400">{subtitle}</p>}
    </div>
  )
  const memberTableColumns:Column<any>[] = activeTab==='customers' ? [
    {
      key:'_title', header:customerSingular, sortable:true, searchable:true, searchKeys:['_subtitle','_reference'], minWidth:'260px',
      render:(_v,row:any)=>titleCell(row._title,row._subtitle,row._status ? statusBadge(row._status) : null),
    },
    {
      key:'_contact', header:'Contact', searchable:true, minWidth:'170px',
      render:(_v,row:any)=>(
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-slate-800">{row._contact_name||'--'}</p>
          <p className="mt-0.5 truncate text-[10px] text-slate-400">{row._contact_phone||row._contact_email||'--'}</p>
        </div>
      ),
    },
    {key:'_location', header:'Location', sortable:true, searchable:true, minWidth:'150px', render:(v)=>cellText(v)},
    {key:'_segment', header:'Segment', sortable:true, searchable:true, minWidth:'150px', render:(v)=>cellText(v)},
    {key:'_account_type', header:'Account Type', sortable:true, searchable:true, minWidth:'170px', render:(v)=>cellText(v)},
    {key:'_assigned', header:'Assigned To', sortable:true, searchable:true, minWidth:'140px', render:(v)=>cellText(v)},
    {key:'_value', header:'Value', sortable:true, align:'right', minWidth:'100px', render:(v)=>valueText(v)},
  ] : activeTab==='leads' ? [
    {key:'_title', header:leadSingular, sortable:true, searchable:true, searchKeys:['_subtitle','_reference'], width:'18%', render:(_v,row:any)=>titleCell(row._title,row._subtitle)},
    {key:'_customer', header:customerSingular, sortable:true, searchable:true, width:'15%', render:(v)=>cellText(v)},
    {
      key:'_contact', header:'Contact', searchable:true, width:'15%',
      render:(_v,row:any)=>(
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-slate-800">{row._contact_name||'--'}</p>
          <p className="mt-0.5 truncate text-[10px] text-slate-400">{row._contact_phone||row._contact_email||'--'}</p>
        </div>
      ),
    },
    {key:'_source', header:'Source', sortable:true, searchable:true, width:'11%', render:(v)=>cellText(v)},
    {key:'_status', header:'Status', sortable:true, searchable:true, width:'11%', render:(v)=>statusBadge(v)},
    {key:'_stage', header:'Stage', sortable:true, searchable:true, width:'9%', render:(v)=>cellText(v)},
    {key:'_date', header:'Date', sortable:true, width:'11%', render:(v)=>dateText(v)},
    {key:'_value', header:'Value', sortable:true, align:'right', width:'10%', render:(v)=>valueText(v)},
  ] : activeTab==='opportunities' ? [
    {key:'_title', header:opportunitySingular, sortable:true, searchable:true, searchKeys:['_subtitle','_reference'], minWidth:'250px', render:(_v,row:any)=>titleCell(row._title,row._subtitle)},
    {key:'_customer', header:customerSingular, sortable:true, searchable:true, minWidth:'170px', render:(v)=>cellText(v)},
    {key:'_oem_product', header:'OEM / Product', sortable:true, searchable:true, minWidth:'150px', render:(v)=>cellText(v)},
    {key:'_status', header:'Status', sortable:true, searchable:true, minWidth:'130px', render:(v)=>statusBadge(v)},
    {key:'_close_date', header:'Close Date', sortable:true, minWidth:'115px', render:(v)=>dateText(v)},
    {key:'_assigned', header:'Owner', sortable:true, searchable:true, minWidth:'130px', render:(v)=>cellText(v)},
    {key:'_value', header:'Value', sortable:true, align:'right', minWidth:'100px', render:(v)=>valueText(v)},
  ] : activeTab==='tenders' ? [
    {key:'_reference', header:`${tenderSingular} #`, sortable:true, searchable:true, searchKeys:['_title','_subtitle'], minWidth:'220px', render:(_v,row:any)=>titleCell(row._reference||row._title,row._title,row._type ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-black text-blue-700">{row._type}</span> : null)},
    {key:'_customer', header:customerSingular, sortable:true, searchable:true, minWidth:'170px', render:(v)=>cellText(v)},
    {
      key:'_submission_date', header:'Timeline', sortable:true, minWidth:'135px',
      render:(_v,row:any)=>(
        <div>
          <p className="text-xs font-semibold text-slate-700">{row._submission_date ? popupDateLabel(row._submission_date) : row._date ? popupDateLabel(row._date) : '--'}</p>
          {row._result_date&&<p className="mt-0.5 text-[10px] text-slate-400">Result: {popupDateLabel(row._result_date)}</p>}
        </div>
      ),
    },
    {key:'_value', header:'Value', sortable:true, align:'right', minWidth:'100px', render:(v)=>valueText(v)},
    {key:'_status', header:'Stage', sortable:true, searchable:true, minWidth:'120px', render:(v)=>statusBadge(v)},
    {key:'_result', header:'Result', sortable:true, searchable:true, minWidth:'110px', render:(v)=>statusBadge(v || 'Pending')},
    {key:'_portal', header:'Portal', sortable:true, searchable:true, minWidth:'130px', render:(v)=>cellText(v)},
    {key:'_assigned', header:'KAM', sortable:true, searchable:true, minWidth:'130px', render:(v)=>cellText(v)},
  ] : activeTab==='workorders' ? [
    {key:'_title', header:workOrderSingular, sortable:true, searchable:true, searchKeys:['_subtitle','_reference'], minWidth:'240px', render:(_v,row:any)=>titleCell(row._reference||row._title,row._title)},
    {key:'_customer', header:customerSingular, sortable:true, searchable:true, minWidth:'170px', render:(v)=>cellText(v)},
    {key:'_po_date', header:'PO Date', sortable:true, minWidth:'110px', render:(v)=>dateText(v)},
    {key:'_delivery_date', header:'Delivery', sortable:true, minWidth:'110px', render:(v)=>dateText(v)},
    {key:'_source', header:'Source', sortable:true, searchable:true, minWidth:'125px', render:(v)=>cellText(v)},
    {key:'_status', header:'Status', sortable:true, searchable:true, minWidth:'120px', render:(v)=>statusBadge(v)},
    {key:'_assigned', header:'Owner', sortable:true, searchable:true, minWidth:'130px', render:(v)=>cellText(v)},
    {key:'_value', header:'Value', sortable:true, align:'right', minWidth:'100px', render:(v)=>valueText(v)},
  ] : [
    {key:'_title', header:'Activity', sortable:true, searchable:true, searchKeys:['_subtitle','_outcome'], minWidth:'240px', render:(_v,row:any)=>titleCell(row._title,row._subtitle)},
    {key:'_customer', header:customerSingular, sortable:true, searchable:true, minWidth:'170px', render:(v)=>cellText(v)},
    {key:'_type', header:'Type', sortable:true, searchable:true, minWidth:'120px', render:(v)=>cellText(v)},
    {key:'_date', header:'Date', sortable:true, minWidth:'120px', render:(v)=>dateText(v)},
    {key:'_outcome', header:'Outcome', sortable:true, searchable:true, minWidth:'180px', render:(v)=>cellText(v)},
    {key:'_next_action', header:'Next Action', sortable:true, searchable:true, minWidth:'180px', render:(v)=>cellText(v)},
    {key:'_assigned', header:'Owner', sortable:true, searchable:true, minWidth:'130px', render:(v)=>cellText(v)},
  ]

  return (
    <div className="fixed inset-0 z-[92] flex items-center justify-center bg-slate-950/45 px-4 py-5 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`flex w-full flex-col overflow-hidden bg-white shadow-2xl transition-all ${
          maximized
            ? 'h-[96vh] max-h-[96vh] max-w-[calc(100vw-32px)] rounded-xl'
            : 'h-[82vh] max-h-[82vh] max-w-[1180px] rounded-xl'
        }`}
        onClick={e=>e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-slate-100 bg-white px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-black text-white">
            {(memberName||'?').split(' ').map((part:string)=>part.charAt(0)).join('').slice(0,2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-black text-slate-950">{memberName} Details</h3>
            <p className="mt-0.5 truncate text-[11px] font-medium text-slate-400">
              {activeRows.length} {activeLabel.toLowerCase()}
              {totalValue>0&&` - ${fmt(totalValue)}`}
            </p>
          </div>
          <button
            type="button"
            onClick={()=>setMaximized(value=>!value)}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            aria-label={maximized?'Restore member details popup':'Maximize member details popup'}
            title={maximized?'Restore':'Maximize'}
          >
            {maximized ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}
          </button>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700" aria-label="Close member details">
            <X size={16}/>
          </button>
        </div>

        <div className="shrink-0 border-b border-slate-100 bg-white px-4 py-2.5">
          <div className="flex items-start overflow-x-auto pb-0.5">
            {tabs.map((tab,index)=>{
              const isActive = tab.key===activeTab
              const count = data[tab.key]?.length || 0
              return (
                <Fragment key={tab.key}>
                  <button
                    type="button"
                    onClick={()=>onTabChange(tab.key)}
                    className="group flex min-w-[104px] flex-1 flex-col items-center text-center outline-none"
                  >
                    <span className={`flex h-9 w-9 items-center justify-center rounded-full border-[3px] transition ${
                      isActive
                        ? 'border-blue-100 bg-blue-600 text-white shadow-lg shadow-blue-100'
                        : 'border-slate-200 bg-white text-slate-400 group-hover:border-blue-100 group-hover:text-blue-600'
                    }`}>
                      {tab.icon}
                    </span>
                    <span className={`mt-1.5 text-xs font-black ${isActive?'text-blue-700':'text-slate-400 group-hover:text-slate-700'}`}>{tab.label}</span>
                    <span className={`mt-0.5 text-[11px] font-medium ${isActive?'text-blue-600':'text-slate-400'}`}>{tab.sub}</span>
                    <span className={`mt-0.5 text-[9px] font-black ${isActive?'text-blue-500':'text-slate-300'}`}>{count.toLocaleString('en-IN')} records</span>
                  </button>
                  {index<tabs.length-1&&(
                    <div className="mt-[17px] h-0.5 min-w-[24px] flex-1 rounded-full bg-slate-200" />
                  )}
                </Fragment>
              )
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden bg-slate-50/70 p-3.5">
          <KAMDataTable
            key={activeTab}
            columns={memberTableColumns}
            data={filteredRows}
            loading={loading}
            keyField="_card_id"
            onSearchChange={setSearch}
            searchValue={search}
            searchPlaceholder={`Search ${activeLabel.toLowerCase()}...`}
            exportFilename={`${memberName}-${activeLabel}`.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'member-details'}
            emptyMessage={search?'No matches':'No records found'}
            emptyIcon={activeIcon}
            toolbar={(
              <div className="ml-auto rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-black text-slate-500">
                {filteredRows.length.toLocaleString('en-IN')} of {activeRows.length.toLocaleString('en-IN')} records
              </div>
            )}
            toolbarVariant="compact"
            initialPageSize={10}
            pageSizeOptions={[10, 25, 50, 100, 'All']}
            maxHeight={maximized?'calc(96vh - 350px)':'calc(82vh - 350px)'}
            compact
          />
          {false&&(
          <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-full max-w-xs">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
              <input
                value={search}
                onChange={e=>setSearch(e.target.value)}
                placeholder={`Search ${activeLabel.toLowerCase()}...`}
                className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-8 pr-8 text-xs font-medium text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
              />
              {search&&(
                <button type="button" onClick={()=>setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Clear search">
                  <X size={13}/>
                </button>
              )}
            </div>
            <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-black text-slate-500">
              {filteredRows.length.toLocaleString('en-IN')} of {activeRows.length.toLocaleString('en-IN')} records
            </div>
          </div>

          {loading ? (
            <div className="flex min-h-[190px] items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 bg-white text-sm font-semibold text-slate-400">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600"/>Loading details...
            </div>
          ) : filteredRows.length===0 ? (
            <div className="flex min-h-[190px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white text-center">
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full border-[3px] border-slate-100 text-slate-300">{activeIcon}</div>
              <p className="text-sm font-black text-slate-600">{search?'No matches':'No records found'}</p>
              <p className="mt-1 text-xs font-medium text-slate-400">{activeLabel}</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {filteredRows.map((row:any)=>{
                const pairs = detailPairs(row)
                return (
                  <div key={row._card_id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:border-blue-200 hover:shadow-md">
                    {/* ── Header ─────────────────────────────────────────────── */}
                    <div className="flex items-start gap-3 px-4 py-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                        {activeIcon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                          <p className="text-[13px] font-black leading-snug text-slate-950">{row._title}</p>
                          {row._status&&(
                            <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-black ${statusTone(row._status)}`}>{row._status}</span>
                          )}
                          {row._type&&(
                            <span className="whitespace-nowrap rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-black text-blue-700">{row._type}</span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {activeTab !== 'customers' && row._customer&&(
                            <span className="text-[12px] font-semibold text-slate-600">{row._customer}</span>
                          )}
                          {row._subtitle&&(
                            <span className="text-[11px] font-medium text-slate-400">{row._subtitle}</span>
                          )}
                          {row._reference&&(
                            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-black text-slate-500">{row._reference}</span>
                          )}
                        </div>
                      </div>
                      {row._value>0&&(
                        <div className="shrink-0 text-right">
                          <p className="text-[15px] font-black text-slate-900">{fmt(row._value)}</p>
                          <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">value</p>
                        </div>
                      )}
                    </div>
                    {/* ── Details grid ─────────────────────────────────────── */}
                    {pairs.length>0&&(
                      <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-slate-100 bg-slate-50/60 px-4 py-3 sm:grid-cols-3 xl:grid-cols-4">
                        {pairs.map(([label,value])=>(
                          <div key={label} className="min-w-0">
                            <p className="text-[9.5px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
                            <p className="mt-0.5 break-words text-[12px] font-semibold leading-snug text-slate-800">{value}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PipelineRecordsModal({
  kind,
  title,
  rows,
  loading,
  search,
  setSearch,
  onClose,
}:{
  kind:'leads'|'opportunities'|'tenders'|'workorders'
  title:string
  rows:any[]
  loading:boolean
  search:string
  setSearch:(value:string)=>void
  onClose:()=>void
}) {
  const { singular: customerSingular } = useModuleName('customers')
  const { singular: leadSingular } = useModuleName('leads')
  const { label: opportunityLabel, singular: opportunitySingular } = useModuleName('opportunities')
  const { singular: tenderSingular } = useModuleName('tenders')
  const { singular: workOrderSingular } = useModuleName('workorders')
  const { singular: quotationSingular } = useModuleName('quotations')
  const [maximized,setMaximized]=useState(false)
  const [clientFilter,setClientFilter]=useState('')
  const [assigneeFilter,setAssigneeFilter]=useState('')
  const [fromDate,setFromDate]=useState('')
  const [toDate,setToDate]=useState('')
  const [sourceFilter,setSourceFilter]=useState<WorkOrderSourceKey|''>('')
  const [oppTypeFilter,setOppTypeFilter]=useState<'all'|'lead'|'direct'>('all')
  const [tenderOriginFilter,setTenderOriginFilter]=useState<'all'|'from_lead'|'from_opportunity'|'direct'>('all')
  const q = search.trim().toLowerCase()
  const searchedRows = q
    ? rows.filter((row:any)=>[
        row.lead_title,row.lead_name,row.tender_title,row.project_title,row.customer_name,
        row.assigned_to_name,row.portal_ref_number,row.tender_num,row.wrk_order_id,row.po_num,
        row.quotation_number,row.status,row.tender_status,row.wo_status,row.contact_person,
        row.contact_name,row.customer_contact_name,row.mobile,row.contact_mobile,row.contact_phone,
        row.phone,row.email,row.contact_email,row.customer_email,
      ].some((field:any)=>String(field||'').toLowerCase().includes(q)))
    : rows
  const clientOptions=Array.from(new Set(rows.map((row:any)=>String(row.customer_name||'').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b))
  const assigneeOptions=Array.from(new Set(rows.map((row:any)=>String(row.assigned_to_name||'').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b))
  const preSourceFiltered=searchedRows.filter((row:any)=>{
    const dateKey=popupRecordDateKey(row)
    return (!clientFilter||row.customer_name===clientFilter) &&
      (!assigneeFilter||row.assigned_to_name===assigneeFilter) &&
      (!fromDate||Boolean(dateKey&&dateKey>=fromDate)) &&
      (!toDate||Boolean(dateKey&&dateKey<=toDate))
  })
  const woSourceCounts = kind==='workorders' ? countWorkOrderSources(preSourceFiltered) : emptyWorkOrderSourceCounts()
  const oppTypeCounts = {lead:0,direct:0} as Record<string,number>
  if(kind==='opportunities') preSourceFiltered.forEach((row:any)=>{
    if(opportunityOrigin(row)==='direct') oppTypeCounts.direct += 1
    else oppTypeCounts.lead += 1
  })
  const tenderOriginCounts = {from_lead:0,from_opportunity:0,direct:0} as Record<string,number>
  if(kind==='tenders') preSourceFiltered.forEach((r:any)=>{const o=r.tender_origin||'direct';tenderOriginCounts[o]=(tenderOriginCounts[o]||0)+1})
  const filtered = kind==='workorders' && sourceFilter
    ? preSourceFiltered.filter((row:any)=>workOrderSourceCategory(row)===sourceFilter)
    : kind==='opportunities' && oppTypeFilter!=='all'
      ? preSourceFiltered.filter((row:any)=>opportunityOrigin(row)===(oppTypeFilter==='direct'?'direct':'from_lead'))
      : kind==='tenders' && tenderOriginFilter!=='all'
        ? preSourceFiltered.filter((row:any)=>(row.tender_origin||'direct')===tenderOriginFilter)
        : preSourceFiltered
  const totalValue = filtered.reduce((sum:number,row:any)=>sum+(kind==='workorders'
    ? workOrderValue(row)
    : Number(row.est_value ?? row.lead_value ?? row.bid_amount ?? row.wo_value ?? 0)
  ),0)
  const icon = kind==='tenders'?<FileText size={16}/>:kind==='workorders'?<Package size={16}/>:kind==='opportunities'?<Star size={16}/>:<TrendingUp size={16}/>
  const pipelineTableRows=filtered.map((row:any,idx:number)=>({
    ...row,
    _table_id:String(row.id ?? row.wo_id ?? row.wrk_order_id ?? idx),
    _record_title:kind==='workorders'
      ? row.wrk_order_id||row.tender_num||row.project_title||workOrderSingular
      : kind==='tenders'
        ? row.portal_ref_number||row.tender_num||String(row.id||'')
        : row.lead_title||row.lead_name||'',
    _record_subtitle:kind==='workorders' ? (row.portal_ref_number||row.tender_num||'') : kind==='tenders' ? row.tender_title||'' : (row.customer_name||''),
    _source:kind==='workorders' ? workOrderSourceLabel(workOrderSourceCategory(row)) : (row.source_name||row.source||''),
    _origin:kind==='opportunities' ? opportunityOrigin(row) : '',
    _channel:row.channel||'',
    _customer:row.customer_name||'',
    _assigned:row.assigned_to_name||row.assigned_to||'',
    _priority:row.priority||'',
    _follow_up:row.follow_up||row.timeline||'',
    _contact_name:row.contact_person||row.contact_name||row.customer_contact_name||'',
    _contact_phone:row.mobile||row.contact_mobile||row.contact_phone||row.phone||'',
    _contact_email:row.email||row.contact_email||row.customer_email||'',
    _contact:[
      row.contact_person||row.contact_name||row.customer_contact_name,
      row.mobile||row.contact_mobile||row.contact_phone||row.phone,
      row.email||row.contact_email||row.customer_email,
    ].filter(Boolean).join(' | '),
    _last_activity:row.last_activity||row.last_activity_type||'',
    _last_activity_at:row.last_activity_at||row.last_activity_date||'',
    _status:kind==='workorders' ? row.wo_status||'Draft' : kind==='tenders' ? row.tender_status||'' : row.status||'',
    _result:row.result||'',
    _submission_date:row.submission_date||'',
    _pre_bid_date:row.pre_bid_date||'',
    _current_step:Number(row.current_step||1),
    _total_steps:row.result==='Won'?7:5,
    _po_num:row.po_num||row.po_number||'',
    _dlvry_date:row.dlvry_date||row.delivery_date||'',
    _completion_date:row.completion_date||'',
    _consignee:Number(row.no_of_consignee||0),
    _reference:kind==='tenders'
      ? row.portal_ref_number||row.tender_id_ref||''
      : row.opportunity_ref_id||row.ref_number||row.po_num||'',
    _value:kind==='workorders' ? workOrderValue(row) : Number(row.est_value||row.lead_value||row.bid_amount||row.total_value||0),
  }))

  const leadStatusBadge = (s: string) => {
    const m: Record<string,string> = {
      'Assigned':'bg-indigo-50 text-indigo-700',
      'Qualified':'bg-violet-50 text-violet-700',
      'Opportunity Created':'bg-purple-50 text-purple-700',
      'Converted':'bg-emerald-50 text-emerald-700',
      'Lost':'bg-red-50 text-red-700',
    }
    return m[s] || 'bg-slate-50 text-slate-600'
  }
  const priorityBadge = (p: string) => {
    if(p==='High') return 'bg-rose-50 text-rose-700'
    if(p==='Medium') return 'bg-amber-50 text-amber-700'
    return 'bg-slate-50 text-slate-500'
  }
  const tenderStageBadge = (s: string) => {
    const m: Record<string,string> = {
      'Aligned':'bg-blue-50 text-blue-700','Evaluation':'bg-amber-50 text-amber-700',
      'Submitted':'bg-violet-50 text-violet-700','Pre-Bid':'bg-sky-50 text-sky-700',
      'Reverse Auction':'bg-orange-50 text-orange-700','Closed':'bg-slate-100 text-slate-500',
    }
    return m[s] || 'bg-slate-50 text-slate-600'
  }
  const tenderResultBadge = (r: string) => {
    if(r==='Won') return 'bg-emerald-50 text-emerald-700'
    if(r==='Lost') return 'bg-red-50 text-red-700'
    if(!r) return 'bg-slate-100 text-slate-400'
    return 'bg-amber-50 text-amber-700'
  }

  const leadOppColumns: Column<any>[] = [
    {
      key:'_record_title', header:`${leadSingular} / ${opportunitySingular}`,
      sortable:true, searchable:true, searchKeys:['_record_subtitle','_customer'], minWidth:'240px',
      render:(v:unknown,row:any)=>(
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-900">{String(v||'--')}</p>
          <p className="mt-0.5 truncate text-[11px] font-medium text-slate-400">{row._record_subtitle||'--'}</p>
        </div>
      ),
    },
    {
      key:'_source', header:'Source',
      sortable:true, searchable:true, minWidth:'120px',
      render:(v:unknown,row:any)=>(
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-slate-700">{String(v||'--')}</p>
          {kind==='opportunities'&&(
            <p className={`mt-0.5 inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-black ${row._origin==='direct'?'bg-violet-50 text-violet-700':'bg-blue-50 text-blue-700'}`}>
              {row._origin==='direct'?'Direct':`From ${leadSingular}`}
            </p>
          )}
          {row._channel && row._channel!=='manual' && <p className="mt-0.5 truncate text-[10px] text-slate-400 capitalize">{row._channel}</p>}
        </div>
      ),
    },
    {
      key:'_status', header:'Status',
      sortable:true, searchable:true, minWidth:'130px',
      render:(v:unknown)=><span className={`rounded-lg px-2 py-1 text-[10px] font-black ${leadStatusBadge(String(v))}`}>{String(v||'--')}</span>,
    },
    {
      key:'_priority', header:'Priority & Value',
      sortable:true, minWidth:'130px',
      render:(v:unknown,row:any)=>(
        <div>
          <span className={`rounded-lg px-2 py-1 text-[10px] font-black ${priorityBadge(String(v))}`}>{String(v||'--')}</span>
          <p className="mt-1 text-xs font-black text-slate-900">{row._value>0?fmt(row._value):'--'}</p>
        </div>
      ),
    },
    {key:'_assigned', header:'Owner', sortable:true, searchable:true, minWidth:'130px', render:(v:unknown)=><span className="text-xs font-semibold text-slate-700">{String(v||'--')}</span>},
    {
      key:'_follow_up', header:'Timeline',
      sortable:true, minWidth:'110px',
      render:(v:unknown)=>{
        const d=String(v||''); if(!d) return <span className="text-slate-300">--</span>
        return <span className="text-xs font-semibold text-slate-700">{popupDateLabel(d)}</span>
      },
    },
    {
      key:'_contact', header:'Contact',
      searchable:true, minWidth:'155px',
      render:(_:unknown,row:any)=>(
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-slate-800">{row._contact_name||'--'}</p>
          <p className="mt-0.5 truncate text-[10px] text-slate-400">{row._contact_phone||row._contact_email||'--'}</p>
        </div>
      ),
    },
    {
      key:'_last_activity', header:'Last Activity',
      sortable:true, minWidth:'120px',
      render:(v:unknown,row:any)=>(
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-slate-800">{String(v||'--')}</p>
          <p className="mt-0.5 text-[10px] text-slate-400">{popupDateLabel(row._last_activity_at)}</p>
        </div>
      ),
    },
  ]

  const tenderColumns: Column<any>[] = [
    {
      key:'_record_title', header:`${tenderSingular} #`,
      sortable:true, searchable:true, searchKeys:['_record_subtitle'], minWidth:'190px',
      render:(v:unknown,row:any)=>(
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-900">{String(v||'--')}</p>
          {row._record_subtitle&&<p className="mt-0.5 truncate text-[11px] font-medium text-slate-400">{row._record_subtitle}</p>}
        </div>
      ),
    },
    {key:'_customer', header:customerSingular, sortable:true, searchable:true, minWidth:'170px', render:(v:unknown)=><span className="text-xs font-semibold text-slate-700">{String(v||'--')}</span>},
    {
      key:'_submission_date', header:'Timeline',
      sortable:true, minWidth:'130px',
      render:(v:unknown,row:any)=>(
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-700">{v?popupDateLabel(String(v)):'--'}</p>
          {row._pre_bid_date&&<p className="mt-0.5 text-[10px] text-slate-400">Pre-bid: {popupDateLabel(row._pre_bid_date)}</p>}
        </div>
      ),
    },
    {key:'_value', header:'Value', sortable:true, align:'right', minWidth:'100px', render:(v:unknown)=><span className="text-xs font-black text-slate-900">{Number(v||0)>0?fmt(Number(v)):'--'}</span>},
    {
      key:'_status', header:'Stage',
      sortable:true, searchable:true, minWidth:'130px',
      render:(v:unknown)=>{
        const s=String(v||'')
        return s ? <span className={`rounded-lg px-2 py-1 text-[10px] font-black ${tenderStageBadge(s)}`}>{s}</span> : <span className="text-slate-300">--</span>
      },
    },
    {
      key:'_result', header:'Result',
      sortable:true, searchable:true, minWidth:'100px',
      render:(v:unknown)=>{
        const r=String(v||'')
        return <span className={`rounded-lg px-2 py-1 text-[10px] font-black ${tenderResultBadge(r)}`}>{r||'Pending'}</span>
      },
    },
    {
      key:'_current_step', header:'Progress',
      sortable:true, minWidth:'90px',
      render:(v:unknown,row:any)=>{
        const s=Number(v||1), t=row._total_steps||5
        const done=s>=t
        return (
          <span className={`rounded-lg px-2 py-1 text-[10px] font-black ${done?'bg-emerald-50 text-emerald-700':'bg-blue-50 text-blue-700'}`}>
            Step {s}/{t}
          </span>
        )
      },
    },
    {key:'_assigned', header:'KAM', sortable:true, searchable:true, minWidth:'130px', render:(v:unknown)=><span className="text-xs font-semibold text-slate-700">{String(v||'--')}</span>},
  ]

  const workOrderColumns: Column<any>[] = [
    {
      key:'_record_title', header:workOrderSingular,
      sortable:true, searchable:true, searchKeys:['_record_subtitle'], minWidth:'200px',
      render:(v:unknown,row:any)=>(
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-900">{String(v||'--')}</p>
          {row._record_subtitle&&<p className="mt-0.5 truncate text-[11px] font-medium text-slate-400">{row._record_subtitle}</p>}
        </div>
      ),
    },
    {
      key:'_customer', header:customerSingular,
      sortable:true, searchable:true, minWidth:'160px',
      render:(v:unknown)=><span className="text-xs font-semibold text-slate-700">{String(v||'--')}</span>,
    },
    {
      key:'_po_num', header:'PO & Value',
      sortable:true, searchable:true, minWidth:'140px',
      render:(v:unknown,row:any)=>(
        <div className="min-w-0">
          <p className="truncate text-xs font-bold text-slate-900">{String(v||'--')}</p>
          <p className="mt-0.5 text-[11px] font-semibold text-slate-400">{row._value>0?fmt(row._value):'--'}</p>
        </div>
      ),
    },
    {
      key:'_dlvry_date', header:'Timeline',
      sortable:true, minWidth:'120px',
      render:(v:unknown,row:any)=>(
        <div className="min-w-0">
          <p className="text-xs font-semibold text-slate-700">{v?popupDateLabel(String(v)):'--'}</p>
          {row._completion_date&&<p className="mt-0.5 text-[10px] text-slate-400">Completion: {popupDateLabel(row._completion_date)}</p>}
        </div>
      ),
    },
    {
      key:'_consignee', header:'Consignee',
      sortable:true, minWidth:'90px',
      render:(v:unknown)=>{
        const n=Number(v||0)
        return <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${n>0?'bg-slate-100 text-slate-700':'bg-slate-50 text-slate-300'}`}>{n>0?n:'--'}</span>
      },
    },
    {key:'_assigned', header:'Owner', sortable:true, searchable:true, minWidth:'130px', render:(v:unknown)=><span className="text-xs font-semibold text-slate-700">{String(v||'--')}</span>},
    {
      key:'_source', header:'Source',
      sortable:true, searchable:true, minWidth:'125px',
      render:(v:unknown)=><span className="rounded-lg bg-emerald-50 px-2 py-1 text-[10px] font-black text-emerald-700">{String(v||'--')}</span>,
    },
    {
      key:'_status', header:'Status',
      sortable:true, searchable:true, minWidth:'100px',
      render:(v:unknown)=><span className={`rounded-lg px-2 py-1 text-[10px] font-black ${workOrderStatusBadge(String(v))}`}>{String(v||'--')}</span>,
    },
  ]

  const pipelineColumns:Column<any>[]= kind==='leads'||kind==='opportunities' ? leadOppColumns
    : kind==='tenders' ? tenderColumns
    : workOrderColumns
  const pipelineFilters=(
    <div className="flex min-w-0 flex-wrap items-center gap-2 xl:flex-nowrap">
      <PopupTableFilters
        clients={clientOptions}
        assignedTo={assigneeOptions}
        client={clientFilter}
        assignee={assigneeFilter}
        fromDate={fromDate}
        toDate={toDate}
        onClientChange={setClientFilter}
        onAssigneeChange={setAssigneeFilter}
        onFromDateChange={setFromDate}
        onToDateChange={setToDate}
        onClear={()=>{setClientFilter('');setAssigneeFilter('');setFromDate('');setToDate('')}}
      />
      {kind==='workorders'&&(
        <div className="flex shrink-0 flex-wrap gap-2 xl:flex-nowrap">
          {(['tender','direct','quotation'] as WorkOrderSourceKey[]).map(source=>{
            const label=({tender:tenderSingular,direct:opportunitySingular,quotation:quotationSingular} as Record<WorkOrderSourceKey,string>)[source]
            const isActive=sourceFilter===source
            return (
              <button key={source} onClick={()=>setSourceFilter(isActive?'':source)}
                className={`rounded-lg border px-2.5 py-1 text-[11px] font-black transition-colors ${isActive?'border-blue-300 bg-blue-100 text-blue-800':'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'}`}>
                {label}: {woSourceCounts[source]}
              </button>
            )
          })}
        </div>
      )}
      {kind==='opportunities'&&(
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {([
            {key:'all',label:`All (${preSourceFiltered.length})`},
            {key:'lead',label:`From ${leadSingular} (${oppTypeCounts.lead})`},
            {key:'direct',label:`Direct (${oppTypeCounts.direct})`},
          ] as const).map(p=>(
            <button key={p.key} onClick={()=>setOppTypeFilter(p.key)}
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-black transition-colors ${oppTypeFilter===p.key?'border-violet-300 bg-violet-100 text-violet-800':'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'}`}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      {kind==='tenders'&&(
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {([
            {key:'all',label:`All (${preSourceFiltered.length})`},
            {key:'from_lead',label:`From ${leadSingular} (${tenderOriginCounts.from_lead||0})`},
            {key:'from_opportunity',label:`From ${opportunityLabel} (${tenderOriginCounts.from_opportunity||0})`},
            {key:'direct',label:`Direct (${tenderOriginCounts.direct||0})`},
          ] as const).map(p=>(
            <button key={p.key} onClick={()=>setTenderOriginFilter(p.key)}
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-black transition-colors ${tenderOriginFilter===p.key?'border-orange-300 bg-orange-100 text-orange-800':'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'}`}>
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div className={`flex flex-col overflow-hidden bg-white shadow-2xl transition-all duration-200 ${maximized?'fixed inset-2 rounded-xl':'w-full max-w-[1500px] max-h-[88vh] rounded-2xl'}`} onClick={e=>e.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 bg-white px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-800 text-white">{icon}</div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-black text-gray-900">{title}</h3>
            <p className="mt-0.5 text-xs text-gray-400">
              <span className="font-semibold text-slate-600">{filtered.length} records</span>
              {totalValue>0&&<> - <span className="font-semibold text-emerald-600">{fmt(totalValue)}</span></>}
            </p>
          </div>
          <button onClick={()=>setMaximized(m=>!m)} title={maximized?'Restore':'Maximize'} className="rounded-xl p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700">
            {maximized?<Minimize2 size={16}/>:<Maximize2 size={16}/>}
          </button>
          <button onClick={onClose} className="rounded-xl p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"><X size={18}/></button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <KAMDataTable
            columns={pipelineColumns}
            data={pipelineTableRows}
            loading={loading}
            keyField="_table_id"
            onSearchChange={setSearch}
            searchValue={search}
            searchPlaceholder="Search records..."
            searchInputClassName="w-[260px]"
            exportFilename={title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||kind}
            emptyMessage={search?'No matches':'No records found'}
            emptyIcon={icon}
            toolbar={pipelineFilters}
            toolbarVariant="compact"
            maxHeight={maximized?'calc(100vh - 130px)':'calc(88vh - 245px)'}
            compact
          />
        </div>

        {false&&(<>
        <div className="shrink-0 border-b border-gray-100 px-5 py-3">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"/>
            <input value={search} onChange={e=>setSearch(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}...`}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 py-2 pl-8 pr-7 text-sm focus:border-blue-400 focus:outline-none"/>
            {search&&<button onClick={()=>setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"><X size={12}/></button>}
          </div>
          {kind==='workorders'&&(
            <div className="mt-3 flex flex-wrap gap-2">
              {(['tender','direct','quotation'] as WorkOrderSourceKey[]).map(source=>(
                <span key={source} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-black text-slate-700">
                  {workOrderSourceLabel(source)}: {woSourceCounts[source]}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-14 text-sm font-semibold text-gray-400">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700"/>Loading...
            </div>
          ) : filtered.length===0 ? (
            <div className="py-14 text-center text-sm font-semibold text-gray-400">{search?'No matches':'No records found'}</div>
          ) : (
            <table className="min-w-full border-separate border-spacing-0 text-left">
              <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-black uppercase text-slate-500">
                <tr>
                  <th className="border-b border-slate-200 px-5 py-3">{kind==='workorders'?workOrderSingular:kind==='tenders'?tenderSingular:`${leadSingular} / ${opportunitySingular}`}</th>
                  {kind==='workorders'&&<th className="border-b border-slate-200 px-4 py-3">Source</th>}
                  <th className="border-b border-slate-200 px-4 py-3">{customerSingular}</th>
                  <th className="border-b border-slate-200 px-4 py-3">Assigned To</th>
                  <th className="border-b border-slate-200 px-4 py-3">Status</th>
                  <th className="border-b border-slate-200 px-4 py-3">Reference</th>
                  <th className="border-b border-slate-200 px-5 py-3 text-right">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((row:any,idx:number)=>(
                  <tr key={row.id ?? row.wo_id ?? row.wrk_order_id ?? idx} className="bg-white transition-colors hover:bg-slate-50">
                    <td className="px-5 py-3">
                      <p className="max-w-[320px] truncate text-sm font-bold text-slate-900">
                        {kind==='workorders'
                          ? row.wrk_order_id || row.tender_num || row.project_title || workOrderSingular
                          : kind==='tenders'
                            ? row.tender_title || row.tender_num || '--'
                            : row.lead_title || row.lead_name || '--'}
                      </p>
                      {kind==='workorders'&&<p className="mt-0.5 max-w-[320px] truncate text-[11px] font-medium text-slate-400">{row.project_title || row.tender_title || '--'}</p>}
                    </td>
                    {kind==='workorders'&&(
                      <td className="px-4 py-3"><span className="rounded-lg bg-emerald-50 px-2 py-1 text-[10px] font-black text-emerald-700">{workOrderSourceLabel(workOrderSourceCategory(row))}</span></td>
                    )}
                    <td className="px-4 py-3 text-sm font-semibold text-slate-700">{row.customer_name||'--'}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-slate-700">{row.assigned_to_name||'--'}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-lg px-2 py-1 text-[10px] font-black ${kind==='workorders'?workOrderStatusBadge(row.wo_status):kind==='tenders'?'bg-orange-50 text-orange-700':'bg-violet-50 text-violet-700'}`}>
                        {kind==='workorders' ? row.wo_status || 'Draft' : kind==='tenders' ? row.tender_status || row.result || '--' : row.status || '--'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-slate-700">{row.portal_ref_number||row.tender_num||row.tender_id_ref||row.opportunity_ref_id||row.ref_number||row.po_num||'--'}</td>
                    <td className="px-5 py-3 text-right text-sm font-black text-slate-950">
                      {(kind==='workorders'?workOrderValue(row):Number(row.est_value||row.lead_value||row.bid_amount||0))>0
                        ? fmt(kind==='workorders'?workOrderValue(row):Number(row.est_value||row.lead_value||row.bid_amount||0))
                        : '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        </>)}
      </div>
    </div>
  )
}

function CustomerModal({
  title,
  rows,
  businessRecords = emptyCustomerBusinessRecords(),
  masterSegmentSubSegments = [],
  teamMembers = [],
  teamRows = [],
  loading,
  search,
  setSearch,
  categoryFilter,
  onCategoryFilter,
  onClose,
}:{
  title:string
  rows:any[]
  businessRecords?:CustomerBusinessRecords
  masterSegmentSubSegments?:CustomerSubSegmentMaster[]
  teamMembers?:any[]
  teamRows?:any[]
  loading:boolean
  search:string
  setSearch:(v:string)=>void
  categoryFilter:'all'|'won'|'pipeline'|'none'
  onCategoryFilter:(v:'all'|'won'|'pipeline'|'none')=>void
  onClose:()=>void
}) {
  const { label: customerLabel, singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const { label: leadLabel, singular: leadSingular, labelLower: leadLabelLower } = useModuleName('leads')
  const { label: opportunityLabel, singular: opportunitySingular } = useModuleName('opportunities')
  const { label: tenderLabel, singular: tenderSingular, labelLower: tenderLabelLower } = useModuleName('tenders')
  const { label: workOrderLabel, singular: workOrderSingular, labelLower: workOrderLabelLower } = useModuleName('workorders')
  const [maximized,setMaximized]=useState(false)
  const [assigneeFilter,setAssigneeFilter]=useState('')
  const [expandedCustomerKey,setExpandedCustomerKey]=useState<string|null>(null)
  const [customerDrillTabByKey,setCustomerDrillTabByKey]=useState<Record<string,CustomerDrillKind>>({})
  const fmt=(v:number)=>v>=1e7?`₹${(v/1e7).toFixed(1)}Cr`:v>=1e5?`₹${(v/1e5).toFixed(1)}L`:v>=1e3?`₹${(v/1e3).toFixed(0)}K`:`₹${v.toFixed(0)}`
  const q=search.trim().toLowerCase()
  const selectedSegmentLabel=useMemo(()=>{
    const marker='Segment:'
    const markerIndex=title.indexOf(marker)
    if(markerIndex<0) return ''
    return title.slice(markerIndex+marker.length)
      .replace(/\s+Customers?'?s?\s+Customers$/i,'')
      .replace(/'?s?\s+Customers$/i,'')
      .trim()
  },[title])
  const cleanLabel=(value:unknown)=>String(value||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim()
  const sameLabel=(a:unknown,b:unknown)=>cleanLabel(a).toLowerCase()===cleanLabel(b).toLowerCase()
  const labelKey=(value:unknown)=>cleanLabel(value).toLowerCase()
  const masterSubSegmentByKey=new Map<string,{name:string;segment:string}>()
  ;(masterSegmentSubSegments||[]).forEach(sub=>{
    const name=cleanLabel(sub.name)
    const segment=cleanLabel(sub.sector_name)
    if(name&&segment){
      masterSubSegmentByKey.set(labelKey(name),{name,segment})
      masterSubSegmentByKey.set(labelKey(`${segment} / ${name}`),{name,segment})
    }
  })
  const customerSegmentParts=(c:any)=>{
    const rawSegment=cleanLabel(c.customer_vertical||c.vertical||c.industry||c.segment||'')
    const parts=rawSegment.split('/').map(part=>cleanLabel(part)).filter(Boolean)
    const inlineSegment=parts.length>1 ? parts[0] : rawSegment
    const inlineSubSegment=parts.length>1 ? parts.slice(1).join(' / ') : ''
    const subSegmentCandidates=[
      inlineSubSegment,
      c.sub_segment,
      c.customer_sub_segment,
      c.subsegment,
      c.customer_segment_child,
      c.customer_vertical_sub_segment,
      c.vertical_sub_sector,
      c.vertical_sub_sector_name,
      c.division,
    ].map(cleanLabel).filter(Boolean)
    const rawMaster=masterSubSegmentByKey.get(labelKey(rawSegment))
    const inlineMaster=parts.length>1 ? masterSubSegmentByKey.get(labelKey(parts[parts.length-1])) : undefined
    const explicitMaster=subSegmentCandidates.map(candidate=>masterSubSegmentByKey.get(labelKey(candidate))).find(Boolean)
    if(rawMaster) return {segment:rawMaster.segment,subSegment:rawMaster.name}
    if(inlineMaster) return {segment:inlineMaster.segment,subSegment:inlineMaster.name}
    if(explicitMaster) return {segment:explicitMaster.segment,subSegment:explicitMaster.name}
    let segment=inlineSegment
    let subSegment=subSegmentCandidates[0]||''
    if(selectedSegmentLabel&&segment&&!sameLabel(segment,selectedSegmentLabel)){
      subSegment=segment
      segment=selectedSegmentLabel
    }else if(selectedSegmentLabel&&!segment){
      segment=selectedSegmentLabel
    }
    return {segment,subSegment}
  }
  const assigneeNameById=new Map<string,string>()
  ;[...(teamMembers||[]),...(teamRows||[])].forEach((member:any)=>{
    const id=String(member?.user_id ?? member?.id ?? '').trim()
    const name=cleanLabel(member?.user_name || member?.full_name || member?.name || member?.employee_name || '')
    if(id&&name) assigneeNameById.set(id,name)
  })
  const resolvedAssigneeName=(c:any)=>{
    const isNumeric=(value:string)=>/^\d+$/.test(value)
    const nameCandidates=[c.assigned_to_name,c.owner_name,c.user_name]
    for(const candidate of nameCandidates){
      const label=cleanLabel(candidate)
      if(!label) continue
      if(isNumeric(label)){
        const resolved=assigneeNameById.get(label)
        if(resolved) return resolved
        continue
      }
      return label
    }
    const idCandidates=[c.assigned_to,c.assigned_to_id,c.assigned_user_id,c.user_id,c.owner_id,c.created_by]
    for(const candidate of idCandidates){
      const id=String(candidate ?? '').trim()
      if(id&&assigneeNameById.has(id)) return assigneeNameById.get(id) || ''
    }
    return ''
  }
  const rowsWithAssignee=rows.map((c:any)=>({...c,_assigned_name:resolvedAssigneeName(c)}))

  const categorised=rowsWithAssignee.map((c:any)=>{
    const hasWon=(c.won_count||0)>0||(c.won_value||0)>0
    const hasPipeline=(c.lead_count||0)>0||(c.opportunity_count||0)>0||(c.tender_count||0)>0||(c.lead_value||0)>0||(c.opportunity_value||0)>0||(c.tender_value||0)>0
    const cat:string=hasWon?'won':hasPipeline?'pipeline':'none'
    return {...c,_cat:cat,_hasWon:hasWon,_hasPipeline:hasPipeline}
  })

  const wonCount=categorised.filter(c=>c._hasWon).length
  const pipelineCount=categorised.filter(c=>!c._hasWon&&c._hasPipeline).length
  const noneCount=categorised.filter(c=>!c._hasWon&&!c._hasPipeline).length

  const assigneeOptions=Array.from(new Set(
    rowsWithAssignee.map((c:any)=>String(c._assigned_name||'').trim()).filter(Boolean)
  )).sort((a,b)=>a.localeCompare(b))

  const filtered=categorised.filter((c:any)=>{
    if(categoryFilter==='won'&&!c._hasWon) return false
    if(categoryFilter==='pipeline'&&(c._hasWon||!c._hasPipeline)) return false
    if(categoryFilter==='none'&&(c._hasWon||c._hasPipeline)) return false
    if(assigneeFilter&&(c._assigned_name||'')!==assigneeFilter) return false
    if(q){
      const ct=c.contacts?.[0]
      const segmentInfo=customerSegmentParts(c)
      return [c.name,c.customer_name,c.billing_city,c.city,c.vertical,c.customer_vertical,c.industry,c.division,segmentInfo.segment,segmentInfo.subSegment,c._assigned_name,c.status,ct?.contact_name,ct?.mobile]
        .some((f:any)=>String(f||'').toLowerCase().includes(q))
    }
    return true
  })

  const cols:Column<any>[]=[
    {
      key:'customer_name',
      header:customerSingular,
      sortable:true, searchable:true, minWidth:'200px',
      exportValue:(c:any)=>[c.customer_name||c.name,c.group_name].filter(Boolean).join(' | '),
      render:(_v,c)=>{
        const cat=c._cat as string
        const border=cat==='won'?'#34d399':cat==='pipeline'?'#fbbf24':'#ef4444'
        return (
          <div style={{borderLeft:`3px solid ${border}`,paddingLeft:8}}>
            <p className="text-sm font-bold text-slate-900 truncate max-w-[200px]">{c.customer_name||c.name||'—'}</p>
            {c.group_name&&<p className="text-[11px] text-slate-400 truncate">{c.group_name}</p>}
          </div>
        )
      },
    },
    {
      key:'vertical',
      header:'Segment',
      sortable:true, searchable:true, minWidth:'130px',
      exportValue:(c:any)=>{
        const {segment,subSegment}=customerSegmentParts(c)
        return [segment,subSegment].filter(Boolean).join(' | ')
      },
      render:(_v,c)=>{
        const {segment,subSegment}=customerSegmentParts(c)
        const v=segment
        const d=subSegment
        return segment||subSegment
          ? <div><p className="text-xs font-semibold text-slate-700 truncate">{v||'—'}</p>{d&&<p className="text-[10px] text-slate-400 truncate">{d}</p>}</div>
          : <span className="text-slate-300 text-xs">—</span>
      },
    },
    {
      key:'city',
      header:'Location',
      sortable:true, minWidth:'110px',
      exportValue:(c:any)=>[c.billing_city||c.city,c.billing_state].filter(Boolean).join(', '),
      render:(_v,c)=>{
        const city=c.billing_city||c.city||''
        const state=c.billing_state||''
        return city||state
          ? <div><p className="text-xs font-semibold text-slate-700">{city||'—'}</p>{state&&<p className="text-[10px] text-slate-400">{state}</p>}</div>
          : <span className="text-slate-300 text-xs">—</span>
      },
    },
    {
      key:'status',
      header:'Status',
      sortable:true, minWidth:'90px',
      exportValue:(c:any)=>c.status||c.account_status||'',
      render:(_v,c)=>{
        const s=c.status||c.account_status||''
        const cls=s==='Active'?'bg-emerald-100 text-emerald-700':s==='Prospect'?'bg-sky-100 text-sky-700':s==='Inactive'?'bg-gray-100 text-gray-500':s==='Churned'?'bg-red-100 text-red-600':'bg-gray-100 text-gray-500'
        return s?<span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${cls}`}>{s}</span>:<span className="text-slate-300 text-xs">—</span>
      },
    },
    {
      key:'potential_value',
      header:'Potential',
      sortable:true, minWidth:'110px',
      exportValue:(c:any)=>[c.account_potential,Number(c.potential_value||0)>0?fmt(Number(c.potential_value)):null].filter(Boolean).join(' - '),
      render:(_v,c)=>{
        const pot=c.account_potential||''
        const val=c.potential_value||0
        const potCls=pot==='High'?'bg-rose-50 text-rose-700':pot==='Medium'?'bg-amber-50 text-amber-700':pot==='Low'?'bg-slate-100 text-slate-600':''
        return (pot||val>0)
          ?<div>{pot&&<span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${potCls}`}>{pot}</span>}{val>0&&<p className="text-xs font-bold text-slate-900 mt-0.5">{fmt(val)}</p>}</div>
          :<span className="text-slate-300 text-xs">—</span>
      },
    },
    {
      key:'contact',
      header:'Contact',
      searchable:true, minWidth:'150px',
      exportValue:(c:any)=>{
        const ct=c.contacts?.[0]
        if(!ct) return ''
        return [ct.contact_name,ct.mobile,ct.office_email].filter(Boolean).join(' | ')
      },
      render:(_v,c)=>{
        const ct=c.contacts?.[0]
        if(!ct?.contact_name&&!ct?.mobile) return <span className="text-slate-300 text-xs">—</span>
        return (
          <div>
            {ct.contact_name&&<p className="text-xs font-semibold text-slate-800 truncate">{ct.contact_name}</p>}
            {ct.mobile&&<p className="text-[10px] text-slate-400">{ct.mobile}</p>}
            {ct.office_email&&<p className="text-[10px] text-slate-400 truncate">{ct.office_email}</p>}
          </div>
        )
      },
    },
    {
      key:'_assigned_name',
      header:'Assigned To',
      sortable:true, searchable:true, minWidth:'120px',
      render:(_v,c)=>(
        c._assigned_name
          ?<span className="text-xs font-semibold text-slate-700">{c._assigned_name}</span>
          :<span className="text-slate-300 text-xs">—</span>
      ),
    },
    {
      key:'last_activity',
      header:'Last Activity',
      sortable:true, minWidth:'130px',
      exportValue:(c:any)=>[c.last_activity_date||c.last_activity_at,c.last_activity_type||c.last_activity].filter(Boolean).join(' - '),
      render:(_v,c)=>{
        const d=c.last_activity_date||c.last_activity_at||''
        const t=c.last_activity_type||c.last_activity||''
        return d
          ?<div><p className="text-xs font-semibold text-slate-700">{d}</p>{t&&<p className="text-[10px] text-slate-400">{t}</p>}</div>
          :<span className="text-slate-300 text-xs">—</span>
      },
    },
  ]

  const toolbar=(
    <div className="flex items-center gap-2 flex-wrap">
      {assigneeOptions.length>0&&(
        <select value={assigneeFilter} onChange={e=>setAssigneeFilter(e.target.value)}
          className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-slate-700 focus:border-blue-400 focus:outline-none">
          <option value="">All Assigned To</option>
          {assigneeOptions.map(n=><option key={n} value={n}>{n}</option>)}
        </select>
      )}
      {([
        {key:'all',label:`All (${rows.length})`,color:'bg-slate-700 text-white',inactiveColor:'bg-slate-100 text-slate-600'},
        {key:'won',label:`Won (${wonCount})`,color:'bg-emerald-600 text-white',inactiveColor:'bg-emerald-50 text-emerald-700'},
        {key:'pipeline',label:`In Pipeline (${pipelineCount})`,color:'bg-amber-500 text-white',inactiveColor:'bg-amber-50 text-amber-700'},
        {key:'none',label:`No Activity (${noneCount})`,color:'bg-red-500 text-white',inactiveColor:'bg-red-50 text-red-600'},
      ] as const).map(p=>(
        <button key={p.key}
          onClick={()=>{setExpandedCustomerKey(null);onCategoryFilter(p.key)}}
          className={`text-xs font-semibold px-3 py-1 rounded-full transition-all ${categoryFilter===p.key?p.color:p.inactiveColor}`}>
          {p.label}
        </button>
      ))}
    </div>
  )

  const idText = (value:any) => String(value ?? '').trim()
  const customerKey = (row:any) => idText(row?.customer_id ?? row?.id ?? row?.name ?? row?.customer_name)
  const recordId = (row:any) => idText(row?.id ?? row?.lead_id ?? row?.tender_id ?? row?.work_order_id ?? row?.wrk_order_id ?? row?.po_num)
  const dateText = (value:any) => value ? String(value).slice(0,10) : ''
  const firstDate = (...values:any[]) => dateText(values.find(Boolean))
  const valueOf = (row:any, keys:string[]) => keys.reduce((found:number,key:string)=>found || Number(row?.[key] || 0),0)
  const titleOf = (row:any, keys:string[], fallback:string) => keys.map(k=>String(row?.[k] || '').trim()).find(Boolean) || fallback
  const norm = (value:any) => String(value || '').trim().toLowerCase()
  const isOpportunityRecord = (row:any) => {
    const status = norm(row?.status || row?.stage)
    return norm(row?.lead_type) === 'direct_opportunity' || status.includes('opportunity') || status.includes('converted') || Boolean(row?.opportunity_ref_id)
  }
  const isClosedWorkOrder = (row:any) => {
    const status = norm(row?.wo_status || row?.status || row?.result)
    if(status.includes('cancel') || status.includes('lost') || status.includes('draft') || status.includes('pending')) return false
    return status.includes('complete') || status.includes('closed') || status.includes('won') || status.includes('approved') || status.includes('issued') || status.includes('release') || Boolean(row?.result_date)
  }
  const isActiveTender = (row:any) => {
    const status = norm(row?.tender_status || row?.result || row?.status)
    return !(status.includes('won') || status.includes('lost') || status.includes('cancel') || status.includes('complete') || status.includes('closed'))
  }
  const byCustomer = (items:any[]) => {
    const map = new Map<string,any[]>()
    ;(items || []).forEach((item:any)=>{
      const key = customerKey(item)
      if(!key) return
      const list = map.get(key) || []
      list.push(item)
      map.set(key,list)
    })
    return map
  }
  const leadLikeRows = [...(businessRecords?.leads || []), ...(businessRecords?.opportunities || [])]
  const leadById = new Map<string,any>()
  leadLikeRows.forEach((row:any)=>{
    const key = idText(row?.lead_id ?? row?.id)
    if(key && (!leadById.has(key) || isOpportunityRecord(row))) leadById.set(key,row)
  })
  const opportunityById = new Map<string,any>()
  ;(businessRecords?.opportunities || []).forEach((row:any)=>{
    const key = idText(row?.lead_id ?? row?.id)
    if(key) opportunityById.set(key,row)
  })
  const tenderById = new Map<string,any>()
  ;(businessRecords?.tenders || []).forEach((row:any)=>{
    const key = idText(row?.tender_id ?? row?.id)
    if(key) tenderById.set(key,row)
  })
  const leadsByCustomer = byCustomer(businessRecords?.leads || [])
  const opportunitiesByCustomer = byCustomer(businessRecords?.opportunities || [])
  const tendersByCustomer = byCustomer(businessRecords?.tenders || [])
  const workOrdersByCustomer = byCustomer(businessRecords?.workorders || [])
  const flowSearch = (parts:any[]) => parts.map(v=>String(v || '')).filter(Boolean).join(' ')
  const flowValue = (row:any) => valueOf(row,['wo_value','po_value','bid_amount','est_value','lead_value','potential_value'])
  const flowFromWorkOrder = (customer:any, workorder:any, mode:'won'|'pipeline', index:number) => {
    const tender = tenderById.get(idText(workorder?.tender_id)) || null
    const leadKey = idText(workorder?.lead_id ?? tender?.lead_id)
    const lead = leadById.get(leadKey) || null
    const opportunity = opportunityById.get(leadKey) || (lead && isOpportunityRecord(lead) ? lead : null)
    const pending = mode === 'pipeline'
    return {
      _table_id:`${mode}-wo-${customerKey(customer)}-${recordId(workorder) || index}`,
      _customer:customer.customer_name || customer.name || workorder.customer_name || '--',
      _customer_group:customer.group_name || '',
      _lead_title:titleOf(lead,['lead_title','lead_name','lead_ref_id'],'--'),
      _opportunity_title:titleOf(opportunity,['lead_title','lead_name','opportunity_ref_id'],opportunity ? opportunitySingular : '--'),
      _tender_title:titleOf(tender,['tender_title','portal_ref_number','tender_num'],tender ? tenderSingular : '--'),
      _workorder_title:titleOf(workorder,['wrk_order_id','po_num','portal_ref_number','project_title'],pending ? `Pending ${workOrderSingular}` : workOrderSingular),
      _stage:pending ? `${workOrderSingular} Pending` : `${workOrderSingular} Won`,
      _status:workorder.wo_status || workorder.status || workorder.result || (pending ? 'Pending' : 'Won'),
      _lead_value:flowValue(lead),
      _opportunity_value:flowValue(opportunity),
      _tender_value:flowValue(tender),
      _won_value:workOrderValue(workorder),
      _po_value:valueOf(workorder,['po_value','bid_amount','wo_value']),
      _result_date:firstDate(workorder.result_date, workorder.po_date, tender?.result_date),
      _next_follow_up:firstDate(lead?.follow_up, lead?.next_action_date, lead?.timeline, tender?.submission_date),
      _pending_workorder:pending ? titleOf(workorder,['wrk_order_id','po_num','portal_ref_number','project_title'],'Pending') : '',
      _search:flowSearch([customer.customer_name, customer.name, lead?.lead_title, opportunity?.lead_title, tender?.tender_title, workorder?.project_title, workorder?.wrk_order_id, workorder?.po_num, workorder?.wo_status]),
    }
  }
  const flowFromStage = (customer:any, source:any, stage:'Lead'|'Opportunity'|'Tender', index:number) => {
    const leadKey = idText(source?.lead_id ?? source?.id)
    const lead = stage === 'Lead' ? source : (leadById.get(leadKey) || null)
    const opportunity = stage === 'Opportunity' ? source : (opportunityById.get(leadKey) || null)
    const tender = stage === 'Tender' ? source : null
    return {
      _table_id:`pipeline-${stage.toLowerCase()}-${customerKey(customer)}-${recordId(source) || index}`,
      _customer:customer.customer_name || customer.name || source.customer_name || '--',
      _customer_group:customer.group_name || '',
      _lead_title:titleOf(lead,['lead_title','lead_name','lead_ref_id'],stage === 'Lead' ? leadSingular : '--'),
      _opportunity_title:titleOf(opportunity,['lead_title','lead_name','opportunity_ref_id'],stage === 'Opportunity' ? opportunitySingular : '--'),
      _tender_title:titleOf(tender,['tender_title','portal_ref_number','tender_num'],stage === 'Tender' ? tenderSingular : '--'),
      _workorder_title:`Pending ${workOrderSingular}`,
      _stage:stage,
      _status:source.status || source.tender_status || source.result || 'Active',
      _lead_value:flowValue(lead),
      _opportunity_value:flowValue(opportunity || source),
      _tender_value:flowValue(tender),
      _won_value:0,
      _po_value:0,
      _result_date:'',
      _next_follow_up:firstDate(source.follow_up, source.next_action_date, source.timeline, source.submission_date),
      _pending_workorder:stage === 'Tender' ? `Awaiting ${workOrderSingular}` : '',
      _last_activity:firstDate(customer.last_activity_date, customer.last_activity_at),
      _last_activity_type:customer.last_activity_type || customer.last_activity || '',
      _search:flowSearch([customer.customer_name, customer.name, lead?.lead_title, opportunity?.lead_title, tender?.tender_title, source.status, source.tender_status]),
    }
  }
  const wonBusinessRows = filtered.flatMap((customer:any, customerIndex:number) => {
    const rows = (workOrdersByCustomer.get(customerKey(customer)) || []).filter(isClosedWorkOrder)
    if(rows.length) return rows.map((wo:any,idx:number)=>flowFromWorkOrder(customer,wo,'won',idx))
    if(Number(customer.won_value ?? customer.wo_value ?? customer.won_tender_value ?? 0) <= 0) return []
    return [{
      _table_id:`won-summary-${customerKey(customer) || customerIndex}`,
      _customer:customer.customer_name || customer.name || '--',
      _customer_group:customer.group_name || '',
      _lead_title:'--',
      _opportunity_title:'--',
      _tender_title:'--',
      _workorder_title:'Booked Revenue',
      _stage:'Won',
      _status:'Won',
      _lead_value:0,
      _opportunity_value:0,
      _tender_value:0,
      _won_value:Number(customer.won_value ?? customer.wo_value ?? customer.won_tender_value ?? 0),
      _po_value:Number(customer.won_value ?? customer.wo_value ?? customer.won_tender_value ?? 0),
      _result_date:dateText(customer.last_activity_date || customer.result_date),
      _next_follow_up:'',
      _pending_workorder:'',
      _search:flowSearch([customer.customer_name, customer.name, customer.group_name, customer.status]),
    }]
  })
  const pipelineBusinessRows = filtered.flatMap((customer:any, customerIndex:number) => {
    const key = customerKey(customer)
    const closedWoTenderIds = new Set((workOrdersByCustomer.get(key) || []).filter(isClosedWorkOrder).map((wo:any)=>idText(wo.tender_id)).filter(Boolean))
    const activeRows:any[] = []
    ;(tendersByCustomer.get(key) || []).filter((t:any)=>isActiveTender(t) && !closedWoTenderIds.has(idText(t.tender_id ?? t.id))).forEach((t:any,idx:number)=>activeRows.push(flowFromStage(customer,t,'Tender',idx)))
    const tenderLeadIds = new Set((tendersByCustomer.get(key) || []).map((t:any)=>idText(t.lead_id)).filter(Boolean))
    ;(opportunitiesByCustomer.get(key) || []).filter((o:any)=>!tenderLeadIds.has(idText(o.lead_id ?? o.id))).forEach((o:any,idx:number)=>activeRows.push(flowFromStage(customer,o,'Opportunity',idx)))
    const opportunityLeadIds = new Set((opportunitiesByCustomer.get(key) || []).map((o:any)=>idText(o.lead_id ?? o.id)).filter(Boolean))
    ;(leadsByCustomer.get(key) || []).filter((l:any)=>!isOpportunityRecord(l) && !opportunityLeadIds.has(idText(l.lead_id ?? l.id)) && !tenderLeadIds.has(idText(l.lead_id ?? l.id))).forEach((l:any,idx:number)=>activeRows.push(flowFromStage(customer,l,'Lead',idx)))
    if(activeRows.length) return [activeRows[0]]
    if(Number(customer.lead_value || customer.opportunity_value || customer.tender_value || 0) <= 0 && Number(customer.lead_count || customer.opportunity_count || customer.tender_count || 0) <= 0) return []
    return [{
      _table_id:`pipeline-summary-${key || customerIndex}`,
      _customer:customer.customer_name || customer.name || '--',
      _customer_group:customer.group_name || '',
      _lead_title:Number(customer.lead_count || 0) > 0 ? `${customer.lead_count} leads` : '--',
      _opportunity_title:Number(customer.opportunity_count || 0) > 0 ? `${customer.opportunity_count} opportunities` : '--',
      _tender_title:Number(customer.tender_count || 0) > 0 ? `${customer.tender_count} tenders` : '--',
      _workorder_title:`Pending ${workOrderSingular}`,
      _stage:'Pipeline',
      _status:customer.status || 'Active',
      _lead_value:Number(customer.lead_value || 0),
      _opportunity_value:Number(customer.opportunity_value || 0),
      _tender_value:Number(customer.tender_value || 0),
      _won_value:0,
      _po_value:0,
      _result_date:'',
      _next_follow_up:dateText(customer.last_activity_date || customer.last_activity_at),
      _pending_workorder:'',
      _last_activity:dateText(customer.last_activity_date || customer.last_activity_at),
      _last_activity_type:customer.last_activity_type || customer.last_activity || '',
      _search:flowSearch([customer.customer_name, customer.name, customer.group_name, customer.status]),
    }]
  })
  const inactiveDaysFrom = (dateValue:any) => {
    const d = dateText(dateValue)
    if(!d) return ''
    const time = new Date(`${d}T00:00:00`).getTime()
    if(Number.isNaN(time)) return ''
    return Math.max(0, Math.floor((Date.now()-time)/86400000))
  }
  const pendingStageFor = (customer:any) => {
    const pending = Number(customer.pending || customer.pending_activities || customer.follow_ups_pending || customer.follow_up_due || 0)
    if(pending > 0) return `${pending} pending follow-up${pending === 1 ? '' : 's'}`
    return customer.pending_stage || customer.stage || customer.lead_stage || customer.tender_status || ''
  }
  const inactiveReasonFor = (customer:any) => {
    const explicit = customer.inactive_reason || customer.reason || customer.no_activity_reason || customer.remarks
    if(explicit) return explicit
    const status = String(customer.account_status || customer.status || '').trim()
    if(status && !['active','prospect'].includes(status.toLowerCase())) return status
    if(!dateText(customer.last_activity_date || customer.last_activity_at)) return 'No recorded activity'
    return 'No won or active pipeline'
  }
  const inactiveBusinessRows = filtered.map((customer:any, customerIndex:number) => {
    const lastActivity = dateText(customer.last_activity_date || customer.last_activity_at)
    const lastType = customer.last_activity_type || customer.last_activity || ''
    return {
      _table_id:`inactive-${customerKey(customer) || customerIndex}`,
      _customer:customer.customer_name || customer.name || '--',
      _customer_group:customer.group_name || '',
      _last_activity:lastActivity,
      _last_activity_type:lastType,
      _pending_stage:pendingStageFor(customer),
      _assigned_user:customer._assigned_name || '',
      _inactive_days:inactiveDaysFrom(lastActivity),
      _inactive_reason:inactiveReasonFor(customer),
      _search:flowSearch([customer.customer_name, customer.name, customer.group_name, lastActivity, lastType, customer._assigned_name, customer.status, customer.account_status]),
    }
  })
  const businessFlowMode = categoryFilter === 'won' || categoryFilter === 'pipeline' || categoryFilter === 'none'
  const businessRows = categoryFilter === 'won' ? wonBusinessRows : categoryFilter === 'pipeline' ? pipelineBusinessRows : categoryFilter === 'none' ? inactiveBusinessRows : []
  const plainCell = (value:any, className = 'text-slate-800') => (
    <span title={String(value || '')} className={`block max-w-[160px] truncate text-xs font-semibold ${className}`}>{value || '--'}</span>
  )
  const detailCell = (title:any, detail:any, className = 'text-slate-800', detailClassName = 'text-slate-500') => (
    <div className="min-w-0">
      <span title={String(title || '')} className={`block max-w-[160px] truncate text-xs font-semibold ${className}`}>{title || '--'}</span>
      <span title={String(detail || '')} className={`mt-0.5 block max-w-[160px] truncate text-[10px] font-black ${detailClassName}`}>{detail || '--'}</span>
    </div>
  )
  const stageCell = (title:any, value:any, className = 'text-slate-800') => {
    const num = Number(value || 0)
    return (
      <div className="min-w-0">
        <span title={String(title || '')} className={`block max-w-[160px] truncate text-xs font-semibold ${className}`}>{title || '--'}</span>
        <span className="mt-0.5 block text-[10px] font-black text-slate-500">{num > 0 ? fmt(num) : '--'}</span>
      </div>
    )
  }
  const valueCell = (value:any, className = 'text-slate-900') => {
    const num = Number(value || 0)
    return <span className={`text-xs font-black ${className}`}>{num > 0 ? fmt(num) : '--'}</span>
  }
  const uniqueRecords = (items:any[]) => {
    const seen = new Set<string>()
    return (items || []).filter((item:any, index:number) => {
      const key = recordId(item) || `${titleOf(item,['lead_title','lead_name','tender_title','wrk_order_id','po_num','project_title'],'record')}-${index}`
      if(seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const drillRowsFor = (customer:any) => {
    const key = customerKey(customer)
    const opportunities = uniqueRecords(opportunitiesByCustomer.get(key) || [])
    const leads = uniqueRecords(leadsByCustomer.get(key) || [])
    const tenders = uniqueRecords(tendersByCustomer.get(key) || [])
    const workorders = uniqueRecords(workOrdersByCustomer.get(key) || [])
    const rows = [
      ...leads.map((row:any)=>({
        id:`lead-${recordId(row)}`,
        stage:leadSingular,
        name:titleOf(row,['lead_title','lead_name','lead_ref_id'],leadSingular),
        value:flowValue(row),
        status:row.status || row.lead_status || 'Active',
        date:firstDate(row.follow_up,row.next_action_date,row.timeline,row.created_at),
        meta:row.lead_ref_id || row.source || row.lead_source || '',
        tone:'text-blue-700 bg-blue-50',
      })),
      ...opportunities.map((row:any)=>({
        id:`opportunity-${recordId(row)}`,
        stage:opportunitySingular,
        name:titleOf(row,['lead_title','lead_name','opportunity_ref_id'],opportunitySingular),
        value:flowValue(row),
        status:row.status || row.opportunity_status || 'Active',
        date:firstDate(row.follow_up,row.next_action_date,row.timeline,row.created_at),
        meta:row.opportunity_ref_id || row.product_name || row.oem_name || '',
        tone:'text-violet-700 bg-violet-50',
      })),
      ...tenders.map((row:any)=>({
        id:`tender-${recordId(row)}`,
        stage:tenderSingular,
        name:titleOf(row,['tender_title','portal_ref_number','tender_num'],tenderSingular),
        value:flowValue(row),
        status:row.tender_status || row.result || row.status || 'Active',
        date:firstDate(row.submission_date,row.result_date,row.due_date,row.created_at),
        meta:row.portal_ref_number || row.tender_num || '',
        tone:'text-orange-700 bg-orange-50',
      })),
      ...workorders.map((row:any)=>({
        id:`workorder-${recordId(row)}`,
        stage:workOrderSingular,
        name:titleOf(row,['wrk_order_id','po_num','portal_ref_number','project_title'],workOrderSingular),
        value:workOrderValue(row) || flowValue(row),
        status:row.wo_status || row.status || 'Active',
        date:firstDate(row.po_date,row.delivery_date,row.result_date,row.created_at),
        meta:row.project_title || row.po_num || row.owner_name || '',
        tone:'text-emerald-700 bg-emerald-50',
      })),
    ]
    if(!leads.length && (Number(customer?.lead_count || 0) > 0 || Number(customer?.lead_value || 0) > 0)){
      rows.push({
        id:`lead-summary-${key}`,
        stage:leadSingular,
        name:Number(customer?.lead_count || 0) > 0 ? `${Number(customer.lead_count || 0).toLocaleString('en-IN')} ${leadLabelLower}` : `${leadSingular} pipeline`,
        value:Number(customer?.lead_value || 0),
        status:customer?.status || 'Active',
        date:firstDate(customer?.last_activity_date, customer?.last_activity_at),
        meta:'Summary from customer pipeline',
        tone:'text-blue-700 bg-blue-50',
      })
    }
    if(!opportunities.length && (Number(customer?.opportunity_count || customer?.opp_count || 0) > 0 || Number(customer?.opportunity_value || 0) > 0)){
      rows.push({
        id:`opportunity-summary-${key}`,
        stage:opportunitySingular,
        name:Number(customer?.opportunity_count || customer?.opp_count || 0) > 0 ? `${Number(customer.opportunity_count || customer.opp_count || 0).toLocaleString('en-IN')} ${opportunityLabel.toLowerCase()}` : `${opportunitySingular} pipeline`,
        value:Number(customer?.opportunity_value || 0),
        status:customer?.status || 'Active',
        date:firstDate(customer?.last_activity_date, customer?.last_activity_at),
        meta:'Summary from customer pipeline',
        tone:'text-violet-700 bg-violet-50',
      })
    }
    if(!tenders.length && (Number(customer?.tender_count || 0) > 0 || Number(customer?.tender_value || 0) > 0)){
      rows.push({
        id:`tender-summary-${key}`,
        stage:tenderSingular,
        name:Number(customer?.tender_count || 0) > 0 ? `${Number(customer.tender_count || 0).toLocaleString('en-IN')} ${tenderLabelLower}` : `${tenderSingular} pipeline`,
        value:Number(customer?.tender_value || 0),
        status:customer?.status || 'Active',
        date:firstDate(customer?.last_activity_date, customer?.last_activity_at),
        meta:'Summary from customer pipeline',
        tone:'text-orange-700 bg-orange-50',
      })
    }
    if(!workorders.length && (Number(customer?.work_order_count || customer?.wo_count || customer?.won_count || 0) > 0 || Number(customer?.wo_value || customer?.won_value || customer?.won_tender_value || 0) > 0)){
      rows.push({
        id:`workorder-summary-${key}`,
        stage:workOrderSingular,
        name:Number(customer?.work_order_count || customer?.wo_count || customer?.won_count || 0) > 0 ? `${Number(customer.work_order_count || customer.wo_count || customer.won_count || 0).toLocaleString('en-IN')} ${workOrderLabelLower}` : `${workOrderSingular} value`,
        value:Number(customer?.wo_value || customer?.won_value || customer?.won_tender_value || 0),
        status:customer?.status || 'Active',
        date:firstDate(customer?.last_activity_date, customer?.last_activity_at),
        meta:'Summary from customer pipeline',
        tone:'text-emerald-700 bg-emerald-50',
      })
    }
    return rows
  }
  const customerDrillRecordsFor = (customer:any, kind:CustomerDrillKind) => {
    const key = customerKey(customer)
    const sourceRows = kind === 'leads'
      ? uniqueRecords(leadsByCustomer.get(key) || [])
      : kind === 'opportunities'
        ? uniqueRecords(opportunitiesByCustomer.get(key) || [])
        : kind === 'tenders'
          ? uniqueRecords(tendersByCustomer.get(key) || [])
          : uniqueRecords(workOrdersByCustomer.get(key) || [])
    const rows = sourceRows.map((row:any) => ({ ...row, _kind: kind }))
    if (rows.length) return rows
    if (kind === 'leads' && (Number(customer?.lead_count || 0) > 0 || Number(customer?.lead_value || 0) > 0)) {
      return [{ _kind: kind, _summary: true, lead_title: Number(customer?.lead_count || 0) > 0 ? `${Number(customer.lead_count || 0).toLocaleString('en-IN')} ${leadLabelLower}` : `${leadSingular} pipeline`, customer_name: customer.customer_name || customer.name, status: customer.status || 'Active', lead_value: Number(customer?.lead_value || 0), created_at: customer?.last_activity_date || customer?.last_activity_at }]
    }
    if (kind === 'opportunities' && (Number(customer?.opportunity_count || customer?.opp_count || 0) > 0 || Number(customer?.opportunity_value || 0) > 0)) {
      return [{ _kind: kind, _summary: true, lead_title: Number(customer?.opportunity_count || customer?.opp_count || 0) > 0 ? `${Number(customer.opportunity_count || customer.opp_count || 0).toLocaleString('en-IN')} ${opportunityLabel.toLowerCase()}` : `${opportunitySingular} pipeline`, customer_name: customer.customer_name || customer.name, status: customer.status || 'Active', opportunity_value: Number(customer?.opportunity_value || 0), created_at: customer?.last_activity_date || customer?.last_activity_at }]
    }
    if (kind === 'tenders' && (Number(customer?.tender_count || 0) > 0 || Number(customer?.tender_value || 0) > 0)) {
      return [{ _kind: kind, _summary: true, tender_title: Number(customer?.tender_count || 0) > 0 ? `${Number(customer.tender_count || 0).toLocaleString('en-IN')} ${tenderLabelLower}` : `${tenderSingular} pipeline`, customer_name: customer.customer_name || customer.name, tender_status: customer.status || 'Active', bid_amount: Number(customer?.tender_value || 0), created_at: customer?.last_activity_date || customer?.last_activity_at }]
    }
    if (kind === 'workorders' && (Number(customer?.work_order_count || customer?.wo_count || customer?.won_count || 0) > 0 || Number(customer?.wo_value || customer?.won_value || customer?.won_tender_value || 0) > 0)) {
      return [{ _kind: kind, _summary: true, project_title: Number(customer?.work_order_count || customer?.wo_count || customer?.won_count || 0) > 0 ? `${Number(customer.work_order_count || customer.wo_count || customer.won_count || 0).toLocaleString('en-IN')} ${workOrderLabelLower}` : `${workOrderSingular} value`, customer_name: customer.customer_name || customer.name, wo_status: customer.status || 'Active', wo_value: Number(customer?.wo_value || customer?.won_value || customer?.won_tender_value || 0), created_at: customer?.last_activity_date || customer?.last_activity_at }]
    }
    return []
  }
  const customerDrillCount = (customer:any, kind:CustomerDrillKind) => customerDrillRecordsFor(customer, kind).length
  const customerDrillValue = (row:any) => row._kind === 'workorders' ? workOrderValue(row) : flowValue(row)
  const customerDrillTitle = (row:any) => row._kind === 'workorders'
    ? titleOf(row,['wrk_order_id','po_num','portal_ref_number','project_title'],workOrderSingular)
    : row._kind === 'tenders'
      ? titleOf(row,['tender_title','portal_ref_number','tender_num'],tenderSingular)
      : row._kind === 'opportunities'
        ? titleOf(row,['lead_title','lead_name','opportunity_ref_id'],opportunitySingular)
        : titleOf(row,['lead_title','lead_name','lead_ref_id'],leadSingular)
  const customerDrillSubtitle = (row:any) => row._kind === 'workorders'
    ? row.project_title || row.po_num || row.owner_name || ''
    : row._kind === 'tenders'
      ? row.portal_ref_number || row.tender_num || ''
      : row.lead_ref_id || row.opportunity_ref_id || row.source || row.lead_source || ''
  const customerDrillSource = (row:any) => row._kind === 'workorders'
    ? workOrderSourceLabel(workOrderSourceCategory(row))
    : row._kind === 'tenders'
      ? row.portal_name || row.tender_portal || row.source_name || row.source || ''
      : row.lead_source || row.source_name || row.source || ''
  const customerDrillStatus = (row:any) => row._kind === 'workorders'
    ? row.wo_status || row.status || 'Active'
    : row._kind === 'tenders'
      ? row.tender_status || row.result || row.status || 'Active'
      : row.status || row.lead_status || row.opportunity_status || 'Active'
  const customerDrillStage = (row:any) => row._kind === 'tenders'
    ? row.result || row.tender_status || ''
    : row._kind === 'workorders'
      ? row.delivery_date || row.dlvry_date || row.completion_date || ''
      : row.stage || row.lead_stage || ''
  const customerDrillDate = (row:any) => row._kind === 'workorders'
    ? firstDate(row.po_date,row.delivery_date,row.result_date,row.created_at)
    : row._kind === 'tenders'
      ? firstDate(row.submission_date,row.result_date,row.due_date,row.created_at)
      : firstDate(row.follow_up,row.next_action_date,row.timeline,row.created_at)
  const customerDrillStatusTone = (row:any) => {
    if (row._kind === 'workorders') return workOrderStatusBadge(customerDrillStatus(row))
    const s = String(customerDrillStatus(row) || '').toLowerCase()
    if (['won','converted','completed','active'].includes(s)) return 'bg-emerald-50 text-emerald-700'
    if (['lost','cancelled','canceled'].includes(s)) return 'bg-red-50 text-red-700'
    if (['submitted','qualified','opportunity created','in progress'].includes(s)) return 'bg-blue-50 text-blue-700'
    return 'bg-slate-100 text-slate-700'
  }
  const customerDrillTabs: Array<{key:CustomerDrillKind; label:string; icon:React.ElementType; tone:string; activeTone:string}> = [
    { key:'leads', label:leadLabel, icon:UserCircle, tone:'text-violet-600', activeTone:'border-violet-100 bg-violet-600 text-white shadow-violet-100' },
    { key:'opportunities', label:opportunityLabel, icon:Star, tone:'text-blue-600', activeTone:'border-blue-100 bg-blue-600 text-white shadow-blue-100' },
    { key:'tenders', label:tenderLabel, icon:FileText, tone:'text-orange-600', activeTone:'border-orange-100 bg-orange-500 text-white shadow-orange-100' },
    { key:'workorders', label:workOrderLabel, icon:Package, tone:'text-emerald-600', activeTone:'border-emerald-100 bg-emerald-600 text-white shadow-emerald-100' },
  ]
  const renderCustomerDrilldown = (customer:any) => {
    const rowKey = String(customer._table_id ?? customer.id ?? customer.customer_id ?? customerKey(customer))
    const activeKind = customerDrillTabByKey[rowKey] || 'leads'
    const records = customerDrillRecordsFor(customer, activeKind)
    const headers = activeKind === 'opportunities'
      ? { record:opportunitySingular, source:'Source', status:'Status', stage:'Stage', date:'Close Date' }
      : activeKind === 'tenders'
        ? { record:tenderSingular, source:'Portal', status:'Stage', stage:'Result', date:'Submit Date' }
        : activeKind === 'workorders'
          ? { record:workOrderSingular, source:'Source', status:'Status', stage:'Delivery', date:'PO Date' }
          : { record:leadSingular, source:'Source', status:'Status', stage:'Stage', date:'Date' }
    return (
      <div className="border-y border-blue-100 bg-white" onClick={e=>e.stopPropagation()}>
        <div className="border-b border-slate-100 bg-white px-5 py-3">
          <div className="flex items-start overflow-x-auto pb-1">
          {customerDrillTabs.map((tab,index)=> {
            const active = activeKind === tab.key
            const TabIcon = tab.icon
            return (
              <Fragment key={tab.key}>
                <button
                  type="button"
                  onClick={() => setCustomerDrillTabByKey(prev => ({ ...prev, [rowKey]: tab.key }))}
                  className="group flex min-w-[118px] flex-1 flex-col items-center text-center outline-none"
                >
                  <span className={`relative flex h-10 w-10 items-center justify-center rounded-full border-[3px] shadow-lg transition ${
                    active
                      ? tab.activeTone
                      : `border-slate-200 bg-white ${tab.tone} shadow-transparent group-hover:border-blue-100`
                  }`}>
                    <TabIcon size={16} />
                  </span>
                  <span className={`mt-1.5 text-xs font-black ${active ? 'text-blue-700' : 'text-slate-400 group-hover:text-slate-700'}`}>
                    {tab.label}
                  </span>
                </button>
                {index < customerDrillTabs.length - 1 && <div className="mt-[19px] h-0.5 min-w-[44px] flex-1 rounded-full bg-slate-200" />}
              </Fragment>
            )
          })}
          </div>
        </div>
        <div className="max-h-[360px] overflow-auto">
          <table className="w-full table-fixed text-left">
            <colgroup>
              <col className="w-[25%]" />
              <col className="w-[17%]" />
              <col className="w-[14%]" />
              <col className="w-[11%]" />
              <col className="w-[12%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[5%]" />
            </colgroup>
            <thead className="bg-gray-50 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3 font-black">{headers.record}</th>
                <th className="px-4 py-3 font-black">{customerSingular}</th>
                <th className="px-4 py-3 font-black">Contact</th>
                <th className="px-4 py-3 font-black">{headers.source}</th>
                <th className="px-4 py-3 font-black">{headers.status}</th>
                <th className="px-4 py-3 font-black">{headers.stage}</th>
                <th className="px-4 py-3 font-black">{headers.date}</th>
                <th className="px-4 py-3 text-right font-black">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {records.length?records.map((row:any,index:number)=>{
                const contactName = row.contact_person || row.contact_name || row.customer_contact_name || ''
                const contactPhone = row.mobile || row.contact_mobile || row.contact_phone || row.phone || ''
                const value = customerDrillValue(row)
                return (
                <tr key={row.id || index} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <p className="truncate text-sm font-black text-slate-900" title={customerDrillTitle(row)}>{customerDrillTitle(row)}</p>
                    {customerDrillSubtitle(row)&&<p className="truncate text-[11px] font-semibold text-slate-400" title={customerDrillSubtitle(row)}>{customerDrillSubtitle(row)}</p>}
                  </td>
                  <td className="truncate px-4 py-3 text-sm font-bold text-slate-700">{row.customer_name || customer.customer_name || customer.name || '--'}</td>
                  <td className="px-4 py-3">
                    <p className="truncate text-xs font-bold text-slate-800">{contactName || '--'}</p>
                    <p className="truncate text-[11px] text-slate-400">{contactPhone || row.contact_email || row.email || '--'}</p>
                  </td>
                  <td className="truncate px-4 py-3 text-xs font-bold text-slate-700">{customerDrillSource(row) || '--'}</td>
                  <td className="px-4 py-3"><span className={`rounded-lg px-2 py-1 text-[10px] font-black ${customerDrillStatusTone(row)}`}>{customerDrillStatus(row) || '--'}</span></td>
                  <td className="truncate px-4 py-3 text-xs font-bold text-slate-700">{customerDrillStage(row) || '--'}</td>
                  <td className="px-4 py-3 text-xs font-bold text-slate-700">{customerDrillDate(row) ? popupDateLabel(customerDrillDate(row)) : '--'}</td>
                  <td className="truncate px-4 py-3 text-right text-sm font-black tabular-nums text-slate-950">{value > 0 ? fmt(value) : '--'}</td>
                </tr>
                )
              }):(
                <tr><td colSpan={8} className="px-4 py-8 text-center text-xs font-semibold text-slate-400">No {customerDrillTabs.find(tab=>tab.key===activeKind)?.label.toLowerCase()} found for this {customerSingular.toLowerCase()}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    )
  }
  const businessCols:Column<any>[] = categoryFilter === 'won' ? [
    {key:'_customer', header:customerSingular, sortable:true, searchable:true, minWidth:'200px', exportValue:(row:any)=>[row._customer,row._customer_group].filter(Boolean).join(' | '), render:(_v,row)=><div><p className="max-w-[200px] truncate text-sm font-black text-slate-900">{row._customer}</p>{row._customer_group&&<p className="max-w-[200px] truncate text-[10px] font-semibold text-slate-400">{row._customer_group}</p>}</div>},
    {key:'_workorder_title', header:workOrderSingular, sortable:true, searchable:true, minWidth:'210px', exportValue:(row:any)=>[row._workorder_title,row._status].filter(Boolean).join(' - '), render:(_v,row)=>detailCell(row._workorder_title,row._status,'text-emerald-800','text-slate-500')},
    {key:'_won_value', header:'Won Value', sortable:true, minWidth:'120px', align:'right', render:(v)=>valueCell(v,'text-emerald-700')},
    {key:'_po_value', header:'PO Value', sortable:true, minWidth:'115px', align:'right', render:(v)=>valueCell(v,'text-slate-900')},
    {key:'_result_date', header:'Result Date', sortable:true, minWidth:'125px', render:(v)=><span className="text-xs font-bold text-slate-700">{String(v || '--')}</span>},
  ] : categoryFilter === 'pipeline' ? [
    {key:'_customer', header:customerSingular, sortable:true, searchable:true, minWidth:'190px', exportValue:(row:any)=>[row._customer,row._customer_group].filter(Boolean).join(' | '), render:(_v,row)=><div><p className="max-w-[190px] truncate text-sm font-black text-slate-900">{row._customer}</p>{row._customer_group&&<p className="max-w-[190px] truncate text-[10px] font-semibold text-slate-400">{row._customer_group}</p>}</div>},
    {key:'_lead_title', header:leadSingular, sortable:true, searchable:true, minWidth:'150px', exportValue:(row:any)=>[row._lead_title,Number(row._lead_value||0)>0?fmt(Number(row._lead_value)):null].filter(Boolean).join(' - '), render:(_v,row)=>stageCell(row._lead_title,row._lead_value,'text-blue-800')},
    {key:'_opportunity_title', header:opportunitySingular, sortable:true, searchable:true, minWidth:'160px', exportValue:(row:any)=>[row._opportunity_title,Number(row._opportunity_value||0)>0?fmt(Number(row._opportunity_value)):null].filter(Boolean).join(' - '), render:(_v,row)=>stageCell(row._opportunity_title,row._opportunity_value,'text-violet-800')},
    {key:'_tender_title', header:tenderSingular, sortable:true, searchable:true, minWidth:'160px', exportValue:(row:any)=>[row._tender_title,Number(row._tender_value||0)>0?fmt(Number(row._tender_value)):null].filter(Boolean).join(' - '), render:(_v,row)=>stageCell(row._tender_title,row._tender_value,'text-orange-800')},
    {key:'_stage', header:'Stage / Status', sortable:true, searchable:true, minWidth:'145px', exportValue:(row:any)=>[row._stage,row._status].filter(Boolean).join(' - '), render:(_v,row)=>detailCell(row._stage,row._status,'text-slate-800','text-slate-500')},
    {key:'_next_follow_up', header:'Next Follow-up', sortable:true, minWidth:'130px', render:(v)=><span className="text-xs font-bold text-slate-700">{String(v || '--')}</span>},
    {key:'_last_activity', header:'Last Activity', sortable:true, minWidth:'140px', exportValue:(row:any)=>[row._last_activity,row._last_activity_type].filter(Boolean).join(' - '), render:(_v,row)=>detailCell(row._last_activity,row._last_activity_type,'text-slate-800','text-slate-500')},
  ] : [
    {key:'_customer', header:`${customerSingular} Name`, sortable:true, searchable:true, minWidth:'220px', exportValue:(row:any)=>[row._customer,row._customer_group].filter(Boolean).join(' | '), render:(_v,row)=><div><p className="max-w-[220px] truncate text-sm font-black text-slate-900">{row._customer}</p>{row._customer_group&&<p className="max-w-[220px] truncate text-[10px] font-semibold text-slate-400">{row._customer_group}</p>}</div>},
    {key:'_last_activity', header:'Last Activity Date', sortable:true, minWidth:'145px', exportValue:(row:any)=>[row._last_activity,row._last_activity_type].filter(Boolean).join(' - '), render:(_v,row)=>detailCell(row._last_activity,row._last_activity_type,'text-slate-800','text-slate-500')},
    {key:'_pending_stage', header:'Pending Stage', sortable:true, searchable:true, minWidth:'160px', render:(v)=>plainCell(v,'text-amber-700')},
    {key:'_assigned_user', header:'Assigned User', sortable:true, searchable:true, minWidth:'155px', render:(v)=>plainCell(v,'text-slate-700')},
    {key:'_inactive_days', header:'Inactive Days', sortable:true, minWidth:'120px', align:'right', render:(v)=><span className="text-xs font-black text-red-600">{v === '' ? '--' : `${Number(v).toLocaleString('en-IN')}d`}</span>},
    {key:'_inactive_reason', header:'Reason', sortable:true, searchable:true, minWidth:'190px', render:(v)=>plainCell(v,'text-red-700')},
  ]

  const tableRows=filtered.map((c:any,idx:number)=>({...c,_table_id:String(c.id??idx)}))

  return (
    <div className="fixed inset-0 z-[100120] flex items-center justify-center bg-slate-950/45 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div className={`relative z-10 flex w-full flex-col overflow-hidden bg-white shadow-2xl transition-all duration-200 ${maximized?'h-[calc(100vh-48px)] max-h-[calc(100vh-48px)] max-w-[calc(100vw-32px)] rounded-xl':'max-h-[88vh] max-w-[1400px] rounded-2xl'}`} onClick={e=>e.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-3 border-b border-gray-100 bg-white px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <Users size={18}/>
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-gray-900 truncate">{title}</h2>
            <p className="text-xs text-gray-400">{filtered.length} of {rows.length} {customerLabelLower}</p>
          </div>
          <button onClick={()=>setMaximized(m=>!m)} title={maximized?'Restore':'Maximize'} className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
            {maximized?<Minimize2 size={15}/>:<Maximize2 size={15}/>}
          </button>
          <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
            <X size={16}/>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <KAMDataTable
            columns={businessFlowMode ? businessCols : cols}
            data={businessFlowMode ? businessRows : tableRows}
            loading={loading}
            keyField="_table_id"
            onRowClick={businessFlowMode ? undefined : (row:any)=>setExpandedCustomerKey(current=>current === row._table_id ? null : row._table_id)}
            expandedRowKey={businessFlowMode ? null : expandedCustomerKey}
            renderExpandedRow={businessFlowMode ? undefined : renderCustomerDrilldown}
            onSearchChange={setSearch}
            searchValue={search}
            searchPlaceholder={businessFlowMode ? `Search ${customerLabelLower} or drill-down data...` : 'Search records...'}
            toolbar={toolbar}
            toolbarVariant="compact"
            maxHeight={maximized?'calc(100vh - 178px)':'calc(88vh - 200px)'}
            emptyMessage={businessFlowMode ? (categoryFilter === 'won' ? 'No won records found' : categoryFilter === 'pipeline' ? 'No active pipeline records found' : `No inactive ${customerLabelLower} found`) : undefined}
            compact
          />
        </div>
      </div>
    </div>
  )
}

function ActivityDetailCard({activity,onClose,onLog,onEdit}:{activity:any;onClose:()=>void;onLog:(a:any)=>void;onEdit:(a:any)=>void}) {
  const { singular: customerSingular } = useModuleName('customers')
  const typeName=taskTypeName(activity)
  const tc=TYPE_COLOR[typeName]||{bg:'bg-gray-50',text:'text-gray-400',dot:'bg-gray-300'}
  const isDone=activity.status==='Completed', isCan=activity.status==='Cancelled', isOpen=!isDone&&!isCan
  const { canUpdate }=useKAMPerms()
  const canEdit=canUpdate&&canEditActivity(activity)
  const scfg=STATUS_CFG[activity.status]||{bg:'bg-gray-100',text:'text-gray-500',border:'border-gray-200',icon:<Circle size={10}/>}
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-start gap-2 px-4 py-3 bg-gray-50 border-b border-gray-100 flex-shrink-0">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900 leading-snug">{activity.subject}</p>
          {activity.customer_name&&<span className="flex items-center gap-1 text-xs text-gray-400 mt-0.5"><Building2 size={10}/>{activity.customer_name}</span>}
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-0.5 flex-shrink-0 rounded-lg hover:bg-gray-200 transition-colors"><X size={14}/></button>
      </div>
      {/* Type + status band */}
      <div className={`px-4 py-2.5 ${tc.bg} border-b border-gray-100 flex items-center gap-2 flex-shrink-0 flex-wrap`}>
        <TypeBox type={typeName} size="sm"/>
        <TaskTypeChip activity={activity}/>
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border ${scfg.bg} ${scfg.text} ${scfg.border}`}>{scfg.icon}{activity.status}</span>
      </div>
      {/* Content */}
      <div className="px-4 py-4 space-y-3 overflow-y-auto flex-1">
        {/* Date / time / duration */}
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <span className="flex items-center gap-1.5 font-semibold text-gray-700"><Calendar size={12} className="text-gray-400"/>{activity.activity_date||'—'}</span>
          {activity.start_time&&<span className="flex items-center gap-1 text-gray-400"><Clock size={11}/>{activity.start_time}</span>}
          {(activity.duration_minutes||0)>0&&<span className="flex items-center gap-1 text-gray-400"><Clock size={11}/>{activity.duration_minutes}m</span>}
        </div>
        {/* Customer + user */}
        {(activity.customer_name||activity.user_name)&&(
          <div className="flex items-center gap-4 text-xs text-gray-500">
            {activity.customer_name&&<span className="flex items-center gap-1.5 font-medium"><Building2 size={11} className="text-gray-400"/>{activity.customer_name}</span>}
            {activity.user_name&&<span className="flex items-center gap-1.5 text-blue-500 font-medium"><UserCircle size={11}/>{activity.user_name}</span>}
          </div>
        )}
        {/* Location */}
        {activity.location&&<p className="flex items-center gap-1.5 text-xs text-gray-500"><Navigation size={11} className="text-gray-400 flex-shrink-0"/>{activity.location}</p>}
        {/* Travel */}
        {activity.has_travel&&(
          <div className={`flex items-center gap-2 text-xs font-medium flex-wrap ${activity.is_outside_district?'text-orange-600':'text-gray-500'}`}>
            {activity.is_outside_district?<Plane size={11}/>:<Car size={11}/>}
            <span>{activity.travel_from&&activity.travel_to?`${activity.travel_from} → ${activity.travel_to}`:activity.is_outside_district?'Outside district':'Local travel'}</span>
            {activity.travel_request_number&&<span className="font-mono text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">{activity.travel_request_number}</span>}
            {activity.travel_request_status&&<span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${TR_STATUS_STYLE[activity.travel_request_status]?.bg||'bg-gray-100'} ${TR_STATUS_STYLE[activity.travel_request_status]?.text||'text-gray-500'}`}>{activity.travel_request_status}</span>}
          </div>
        )}
        {/* Outcome / cancellation */}
        {(activity.outcome||activity.cancellation_reason)&&(
          <div className={`px-3 py-3 rounded-xl text-xs leading-relaxed border ${isDone?'bg-emerald-50 text-emerald-800 border-emerald-100':'bg-red-50 text-red-700 border-red-100'}`}>
            <p className="font-bold mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide">
              {isDone?<CheckCircle size={11}/>:<XCircle size={11}/>}{isCan?'Cancellation Reason':'Outcome'}
            </p>
            {activity.cancellation_reason&&<p className="font-semibold mb-1">{activity.cancellation_reason}</p>}
            {activity.outcome&&<p className="leading-relaxed">{activity.outcome}</p>}
          </div>
        )}
        {/* Next action */}
        {activity.next_action&&(
          <div className="flex items-start gap-2.5 px-3 py-3 bg-blue-50 rounded-xl border border-blue-100">
            <ArrowRight size={13} className="text-blue-400 flex-shrink-0 mt-0.5"/>
            <div>
              <p className="text-[11px] font-bold text-blue-700 uppercase tracking-wide mb-1">Next Action</p>
              <p className="text-xs text-blue-600 leading-snug">{activity.next_action}</p>
              {activity.next_action_date&&<p className="text-[11px] font-bold text-blue-500 mt-1.5 flex items-center gap-1"><Calendar size={10}/>{activity.next_action_date}</p>}
            </div>
          </div>
        )}
        {/* Follow-up classification */}
        {activity.followup_category&&(
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-100">{activity.followup_category}</span>
            {activity.followup_sub_type&&<span className="text-[11px] px-2 py-0.5 rounded-lg bg-amber-50 text-amber-600 border border-amber-100">{activity.followup_sub_type}</span>}
          </div>
        )}
        {/* Notes */}
        {activity.description&&(
          <div className="px-3 py-2.5 bg-gray-50 rounded-xl border border-gray-100 text-xs text-gray-500 leading-relaxed">
            {activity.description}
          </div>
        )}
      </div>
      {/* Footer */}
      <div className="flex gap-2 px-4 py-3 border-t border-gray-100 bg-gray-50/60 flex-shrink-0">
        {isOpen
          ?<>
            {canEdit&&<button onClick={()=>onEdit(activity)} className="flex-1 py-2 text-xs rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium flex items-center justify-center gap-1.5"><Edit3 size={11}/>Edit</button>}
            {canUpdate&&<button onClick={()=>onLog(activity)} className="flex-1 py-2 text-xs rounded-xl font-semibold text-white bg-blue-600 hover:bg-blue-700 flex items-center justify-center gap-1.5"><Edit3 size={11}/>Update Log</button>}
          </>
          :<>
            {canEdit&&<button onClick={()=>onEdit(activity)} className="flex-1 py-2 text-xs rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium flex items-center justify-center gap-1.5"><Edit3 size={11}/>Edit</button>}
            <button onClick={onClose} className="flex-1 py-2 text-xs rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium">Close</button>
          </>
        }
      </div>
    </div>
  )
}

// ─── Activity Detail View ─────────────────────────────────────────────────────
type ActivityInfoTileProps = {
  label: string
  icon: React.ReactNode
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: string
}

function ActivityInfoTile({label, icon, value, sub, tone = 'text-slate-700'}: ActivityInfoTileProps) {
  return (
    <div className="border-b border-slate-100 py-2.5 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-slate-400 [&_svg]:h-3.5 [&_svg]:w-3.5">
          {icon}
        </span>
        <p className="text-[11px] font-medium text-slate-500">{label}</p>
      </div>
      <div className="mt-1 min-w-0 pl-5">
        <div className={`truncate text-[13px] font-bold leading-5 ${tone}`}>{value}</div>
        {sub && <div className="mt-0.5 text-[11px] font-medium text-slate-500">{sub}</div>}
      </div>
    </div>
  )
}

type ActivityTextPanelProps = {
  label: string
  icon: React.ReactNode
  children: React.ReactNode
  className: string
  labelClassName: string
  footer?: React.ReactNode
}

function ActivityTextPanel({label, icon, children, className, labelClassName, footer}: ActivityTextPanelProps) {
  return (
    <div className={`border-b border-slate-200/70 py-3 first:pt-0 last:border-b-0 last:pb-0 ${className}`}>
      <p className={`flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide ${labelClassName} [&_svg]:h-3.5 [&_svg]:w-3.5`}>
        {icon}
        {label}
      </p>
      <div className="mt-1.5 whitespace-pre-wrap text-[11px] font-normal leading-5 text-slate-800">{children}</div>
      {footer && <div className="mt-3">{footer}</div>}
    </div>
  )
}

type RelatedRecordCardProps = {
  label: string
  title: string
  refText?: string
  status?: string
  value?: string
  to?: string
  tone: 'lead' | 'tender'
  onOpen: (to: string) => void
}

function RelatedRecordCard({label, title, refText, status, value, to, tone, onOpen}: RelatedRecordCardProps) {
  const toneClass = tone === 'tender'
    ? 'border-orange-200 bg-orange-50 text-orange-700'
    : 'border-blue-200 bg-blue-50 text-blue-700'
  const iconClass = tone === 'tender'
    ? 'text-orange-600'
    : 'text-blue-600'
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center ${iconClass}`}>
          {tone === 'tender' ? <Briefcase size={14} /> : <Target size={14} />}
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
          <p className="mt-0.5 truncate text-xs font-semibold text-slate-900">{title || '-'}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6 text-[11px] font-medium">
        {status && <span className={`rounded-md border px-2 py-0.5 ${toneClass}`}>{status}</span>}
        {value && <span className="text-slate-600">{value}</span>}
      </div>
    </div>
  )
}

const cleanActivityText = (value: any, fallback = '-') => {
  const text = String(value ?? '').trim()
  return text || fallback
}

const firstPositiveAmount = (...values: any[]) => {
  for (const value of values) {
    const n = Number(value || 0)
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

function ActivityDetailView({
  activity,
  onLog,
  onEdit,
  canReopen = false,
  onReopen,
}: {
  activity: any
  onLog: (a: any) => void
  onEdit: (a: any) => void
  canReopen?: boolean
  onReopen?: (a: any) => void
}) {
  const navigate = useNavigate()
  const { singular: customerSingular } = useModuleName('customers')
  const typeName = taskTypeName(activity)

  const tc =
    TYPE_COLOR[typeName] || {
      bg: 'bg-gray-50',
      text: 'text-gray-400',
      dot: 'bg-gray-300',
    }

  const isDone = activity.status === 'Completed'
  const isCan = activity.status === 'Cancelled'
  const isOpen = !isDone && !isCan

  const scfg =
    STATUS_CFG[activity.status] || {
      bg: 'bg-gray-100',
      text: 'text-gray-500',
      border: 'border-gray-200',
      icon: <Circle size={10} />,
    }

  const activityDateSub = (
    activity.start_time || Number(activity.duration_minutes || 0) > 0
  ) ? (
    <div className="flex flex-wrap items-center gap-3">
      {activity.start_time && (
        <span className="flex items-center gap-1">
          <Clock size={10} />
          {activity.start_time}
        </span>
      )}
      {Number(activity.duration_minutes || 0) > 0 && (
        <span className="flex items-center gap-1">
          <Clock size={10} />
          {activity.duration_minutes} min
        </span>
      )}
    </div>
  ) : null

  const travelLabel = activity.travel_from && activity.travel_to
    ? `${activity.travel_from} -> ${activity.travel_to}`
    : activity.is_outside_district
      ? 'Outside district'
      : 'Local travel'

  const travelSub = (
    activity.travel_request_number || activity.travel_request_status
  ) ? (
    <div className="flex flex-wrap items-center gap-1.5">
      {activity.travel_request_number && (
        <span className="rounded-md bg-orange-100 px-2 py-0.5 font-mono text-[10px] font-bold text-orange-700">
          {activity.travel_request_number}
        </span>
      )}
      {activity.travel_request_status && (
        <span
          className={`
            rounded-full px-2 py-0.5 text-[10px] font-bold
            ${TR_STATUS_STYLE[activity.travel_request_status]?.bg || 'bg-gray-100'}
            ${TR_STATUS_STYLE[activity.travel_request_status]?.text || 'text-gray-500'}
          `}
        >
          {activity.travel_request_status}
        </span>
      )}
    </div>
  ) : null

  const leadId = Number(activity.lead_id || 0)
  const leadTitle = cleanActivityText(
    activity.lead_title || activity.lead_name || activity.opportunity_ref_id || activity.lead_ref_id || (leadId ? `Lead #${leadId}` : ''),
  )
  const leadRef = cleanActivityText(activity.opportunity_ref_id || activity.lead_ref_id || activity.ref_number, '')
  const leadStatus = cleanActivityText(activity.lead_status || activity.lead_stage || activity.status_name, '')
  const leadAmount = firstPositiveAmount(activity.lead_value, activity.est_value, activity.opportunity_value)
  const leadIsOpportunity = String(activity.lead_type || '').toLowerCase() === 'direct_opportunity' || Boolean(activity.opportunity_ref_id)
  const leadPath = leadId ? (leadIsOpportunity ? `/opportunities/${leadId}` : `/leads/${leadId}/edit`) : ''
  const hasLeadDetails = Boolean(leadId || leadRef || activity.lead_title || activity.lead_name || activity.opportunity_ref_id)

  const tenderId = Number(activity.tender_id || activity.converted_tender_id || 0)
  const tenderTitle = cleanActivityText(
    activity.tender_title || activity.portal_ref_number || activity.tender_num || (tenderId ? `Tender #${tenderId}` : ''),
  )
  const tenderRef = cleanActivityText(activity.portal_ref_number || activity.tender_num || activity.tender_id_ref, '')
  const tenderStatus = cleanActivityText(activity.tender_status || activity.tender_result || activity.result || activity.workflow_status, '')
  const tenderAmount = firstPositiveAmount(activity.tender_bid_amount, activity.bid_amount, activity.tender_value, activity.est_value)
  const tenderPath = tenderId ? `/tenders/${tenderId}/edit` : ''
  const hasTenderDetails = Boolean(tenderId || tenderRef || activity.tender_title || activity.portal_ref_number || activity.tender_num)
  const hasRelatedDetails = hasLeadDetails || hasTenderDetails

  const outcomeText = cleanActivityText(activity.cancellation_reason || activity.outcome)
  const notesText = cleanActivityText(activity.description)
  const nextActionText = cleanActivityText(activity.next_action)

  return (
    <div className="bg-slate-50 px-4 py-4 sm:px-6 sm:py-5">
      <div className="pb-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl ${tc.bg} ${tc.text} [&_svg]:h-5 [&_svg]:w-5`}>
              {TYPE_ICON[typeName] || <Activity size={20} />}
            </span>

            <div className="min-w-0">
              <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-blue-600">
                {typeName}
              </p>

              <div className="flex min-w-0 items-center gap-2">
                <h2 className="min-w-0 truncate text-lg font-bold leading-snug text-slate-950">
                  {activity.subject || 'KAM Activity'}
                </h2>
                <span
                  className={`
                    inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border
                    px-3 py-1 text-[11px] font-semibold
                    ${scfg.bg} ${scfg.text} ${scfg.border}
                  `}
                >
                  {scfg.icon}
                  {activity.status || (isOpen ? 'Open' : '-')}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5 text-[11px] font-medium text-slate-500">
                <span className="flex items-center gap-1.5">
                  <Building2 size={12} />
                  {activity.customer_name || 'KAM Activity'}
                </span>
                {activity.user_name && (
                  <span className="flex items-center gap-1.5 border-l border-slate-300 pl-2.5">
                    <UserCircle size={12} />
                    {activity.user_name}
                  </span>
                )}
              </div>
            </div>
          </div>

        </div>
      </div>

      {Number(activity.reopen_count || 0) > 0 && <ReopenBanner activityId={activity.id} />}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)] xl:items-start">
        {/* Left column ── Activity details + Activity log */}
        <div className="space-y-5">
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2.5 flex items-center gap-2">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                <ListChecks size={13} />
              </span>
              <h3 className="text-sm font-bold text-slate-950">Activity Details</h3>
            </div>

            <div>
              <ActivityInfoTile
                label="Date"
                icon={<Calendar size={13} />}
                value={cleanActivityText(activity.activity_date)}
                sub={activityDateSub}
              />
              <ActivityInfoTile
                label={customerSingular}
                icon={<Building2 size={13} />}
                value={cleanActivityText(activity.customer_name)}
              />
              <ActivityInfoTile
                label="Assigned To"
                icon={<UserCircle size={13} />}
                value={cleanActivityText(activity.user_name)}
                tone="text-blue-600"
              />
              <ActivityInfoTile
                label={activity.has_travel ? 'Travel' : 'Location'}
                icon={activity.has_travel ? (activity.is_outside_district ? <Plane size={13} /> : <Car size={13} />) : <Navigation size={13} />}
                value={activity.has_travel ? travelLabel : cleanActivityText(activity.location)}
                sub={activity.has_travel ? travelSub : null}
                tone={activity.has_travel && activity.is_outside_district ? 'text-orange-600' : 'text-slate-700'}
              />
            </div>

            {activity.followup_category && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                  Follow-up Classification
                </p>

                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <span className="rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-[11px] font-medium text-amber-700">
                    {activity.followup_category}
                  </span>

                  {activity.followup_sub_type && (
                    <span className="rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-[11px] text-amber-600">
                      {activity.followup_sub_type}
                    </span>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-1 flex items-center gap-2">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                <FileText size={13} />
              </span>
              <h3 className="text-sm font-bold text-slate-950">Activity Log</h3>
            </div>

            <div>
              <ActivityTextPanel
                label={isCan ? 'Cancellation Reason' : 'Outcome'}
                icon={isDone ? <CheckCircle size={14} /> : <XCircle size={14} />}
                className=""
                labelClassName={isDone ? 'text-emerald-700' : 'text-red-700'}
              >
                {outcomeText}
              </ActivityTextPanel>

              <ActivityTextPanel
                label="Internal Notes"
                icon={<FileText size={13} />}
                className=""
                labelClassName="text-slate-500"
              >
                {notesText}
                {activity.document_url && (
                  <a href={activity.document_url} target="_blank" rel="noreferrer"
                    className="mt-2.5 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold text-slate-700 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700">
                    <Paperclip size={14} className="flex-shrink-0"/>
                    <span className="min-w-0 flex-1 truncate">{activity.document_name||'Activity document'}</span>
                    {activity.document_size_kb!=null&&<span className="flex-shrink-0 text-[11px] text-slate-400">{activity.document_size_kb} KB</span>}
                    <ExternalLink size={13} className="flex-shrink-0"/>
                  </a>
                )}
              </ActivityTextPanel>

              <ActivityTextPanel
                label="Next Action"
                icon={<ArrowRight size={13} />}
                className=""
                labelClassName="text-blue-600"
                footer={activity.next_action_date && (
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-blue-600">
                    <Calendar size={12} />
                    {activity.next_action_date}
                  </div>
                )}
              >
                {nextActionText}
              </ActivityTextPanel>

              {hasRelatedDetails && (
                <div className="border-t border-slate-200/70 pt-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-slate-500">
                      <Link2 size={13} />
                    </span>
                    <h4 className="text-xs font-semibold text-slate-800">Lead / Tender Details</h4>
                  </div>
                  <div className="space-y-2">
                    {hasLeadDetails && (
                      <RelatedRecordCard
                        label={leadIsOpportunity ? 'Opportunity Details' : 'Lead Details'}
                        title={leadTitle}
                        refText={leadRef}
                        status={leadStatus}
                        value={leadAmount > 0 ? fmt(leadAmount) : ''}
                        to={leadPath}
                        tone="lead"
                        onOpen={navigate}
                      />
                    )}
                    {hasTenderDetails && (
                      <RelatedRecordCard
                        label="Tender Details"
                        title={tenderTitle}
                        refText={tenderRef}
                        status={tenderStatus}
                        value={tenderAmount > 0 ? fmt(tenderAmount) : ''}
                        to={tenderPath}
                        tone="tender"
                        onOpen={navigate}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Right column ── Activity timeline */}
        <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-start gap-2.5 border-b border-slate-100 px-4 py-3.5">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600">
              <Clock size={14} />
            </span>
            <div>
              <h3 className="text-sm font-bold text-slate-950">Activity Timeline</h3>
              <p className="mt-0.5 text-xs font-normal text-slate-500">Recent updates and location history</p>
            </div>
          </div>
          <ActivityTimelineTab
            activityId={activity.id}
            assignedUserName={activity.user_name || null}
          />
        </section>
      </div>
    </div>
  )
}


// ─── KAM 360 Tab ──────────────────────────────────────────────────────────────
const normalizeListResponse = (payload:any) =>
  Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.data)
    ? payload.data
    : []

function KAM360Tab({myId,teamMembers,period,setPeriod,isYearly,setIsYearly,viewYear,setViewYear,onNavigate,onLogActivity,onEditActivity,initialUid=null}:{
  myId:number;teamMembers:any[];period:string;setPeriod:(s:string)=>void;
  initialUid?:number|null;
  isYearly:boolean;setIsYearly:(b:boolean)=>void;viewYear:number;setViewYear:(n:number)=>void;
  onNavigate:(module:string,params?:any)=>void;
  onLogActivity:(a:any)=>void;
  onEditActivity:(a:any)=>void;
}) {
  const { label: kamLabel } = useModuleName('kam')
  const { label: customerLabel, singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const { label: leadLabel, singular: leadSingular, labelLower: leadLabelLower } = useModuleName('leads')
  const { label: opportunityLabel, singular: opportunitySingular, labelLower: opportunityLabelLower } = useModuleName('opportunities')
  const { label: tenderLabel, singular: tenderSingular, labelLower: tenderLabelLower } = useModuleName('tenders')
  const { label: workOrderLabel, singular: workOrderSingular, labelLower: workOrderLabelLower } = useModuleName('workorders')
  const canViewTeam = teamMembers.length > 1
  const canSetTgt = canViewTeam
  const myTeamMember = teamMembers.find((u:any) => u.id === myId)
  const isAdminOrCEO = ['admin','ceo','super_admin'].includes((myTeamMember?.role||'').toLowerCase())
  const canReopenActivity = canReopenByHierarchy({ id: myId, role: myTeamMember?.role }, teamMembers)
  const [reopenTarget,setReopenTarget] = useState<any>(null)

  const [viewMode,setViewMode]=useState<'normal'|'advanced'>('normal')
  const [selectedUid,setSelectedUid]         = useState<number|null>(initialUid)
  const [selectedCustId,setSelectedCustId]   = useState<number|null>(null)
  const [selectedGroupKey,setSelectedGroupKey] = useState('')
  const [selectedSegment,setSelectedSegment] = useState('')
  const [selectedLocation,setSelectedLocation] = useState('')
  const [summary,setSummary]                 = useState<any>(null)
  const [pipelineCardSummary,setPipelineCardSummary] = useState<any>(null)
  const [targetBaseline,setTargetBaseline]  = useState<any>(null)
  const [custActs,setCustActs]               = useState<any[]>([])
  const [customerMapCustomers,setCustomerMapCustomers] = useState<any[]>([])
  const [teamRows,setTeamRows]               = useState<any[]>([])
  const [masterGroups,setMasterGroups]       = useState<any[]>([])
  const [masterSegments,setMasterSegments]   = useState<Array<{key:string;label:string}>>([])
  const [masterLocationOptions,setMasterLocationOptions] = useState<Array<{key:string;label:string}>>([])
  const [masterSalesMembers,setMasterSalesMembers] = useState<any[]>([])
  const [masterStateMap,setMasterStateMap] = useState<Map<string,string>>(new Map())
  const [masterRegionNames,setMasterRegionNames] = useState<string[]>([])
  const [masterAllStates,setMasterAllStates] = useState<Array<{name:string;region_name:string}>>([])
  const [masterStateDistricts,setMasterStateDistricts] = useState<Map<string,string[]>>(new Map())
  const [masterSegmentSubSegments,setMasterSegmentSubSegments] = useState<CustomerSubSegmentMaster[]>([])
  const [masterUnitVertical,setMasterUnitVertical] = useState<Map<string,string>>(new Map())
  const [masterVerticalUnits,setMasterVerticalUnits] = useState<Map<string,string[]>>(new Map())
  const [perf,setPerf]                       = useState<any>(null)
  const [loading,setLoading]                 = useState(true)
  const [custSearch,setCustSearch]           = useState('')
  const [showTargetModal,setShowTargetModal] = useState(false)
  const [savingTarget,setSavingTarget]       = useState(false)
  const [teamReloadSeq,setTeamReloadSeq]     = useState(0)
  const [expandedMember,setExpandedMember]   = useState<number|null>(initialUid)
  const [actTypeFilter,setActTypeFilter]     = useState<string|null>(null)
  const [targetCardMode,setTargetCardMode]   = useState<'group'|'member'>('group')
  const [targetCardGroupKey,setTargetCardGroupKey] = useState('')
  const [targetCardMemberId,setTargetCardMemberId] = useState<number|null>(null)
  const [rangeMode,setRangeMode]             = useState<KAM360RangeMode>(()=>isYearly?'year':'month')
  const [weekStart,setWeekStart]             = useState(()=>currentWeekStartIso())
  const [customFrom,setCustomFrom]           = useState(()=>`${period}-01`)
  const [customTo,setCustomTo]               = useState(()=>monthEndIso(period))
  const weekStartInputRef                    = useRef<HTMLInputElement|null>(null)
  const periodMonthInputRef                  = useRef<HTMLInputElement|null>(null)
  const customFromInputRef                   = useRef<HTMLInputElement|null>(null)
  const customToInputRef                     = useRef<HTMLInputElement|null>(null)

  const [custPopup,setCustPopup]             = useState(false)
  const [popupCustomers,setPopupCustomers]   = useState<any[]>([])
  const [myOwnCustomers,setMyOwnCustomers]   = useState<any[]>([])
  const [actDetailPopup,setActDetailPopup]   = useState<any>(null)
  const [leadPanel,setLeadPanel]             = useState(false)
  const [tenderPanel,setTenderPanel]         = useState(false)
  const [workOrderPanel,setWorkOrderPanel]   = useState(false)
  const [customerPanel,setCustomerPanel]     = useState(false)
  const [actPanel,setActPanel]               = useState(false)
  const [actPanelExpanded,setActPanelExpanded] = useState(false)
  const [panelLeads,setPanelLeads]           = useState<any[]>([])
  const [panelTenders,setPanelTenders]       = useState<any[]>([])
  const [panelWorkOrders,setPanelWorkOrders] = useState<any[]>([])
  const [panelCustomers,setPanelCustomers]   = useState<any[]>([])
  const [panelBusinessRecords,setPanelBusinessRecords] = useState<CustomerBusinessRecords>(()=>emptyCustomerBusinessRecords())
  const [panelActs,setPanelActs]             = useState<any[]>([])
  const [panelActType,setPanelActType]       = useState<string>('')
  const [panelLeadLabel,setPanelLeadLabel]   = useState<'Leads'|'Opportunities'>('Leads')
  const [panelLoading,setPanelLoading]       = useState(false)
  const [panelMemberName,setPanelMemberName] = useState<string>('')
  const [panelMemberSalesTarget,setPanelMemberSalesTarget] = useState<number>(0)
  const [panelMemberWonValue,setPanelMemberWonValue]       = useState<number>(0)
  const [panelMemberLeadValue,setPanelMemberLeadValue]     = useState<number>(0)
  const [panelMemberTenderValue,setPanelMemberTenderValue] = useState<number>(0)
  const [stateDetailPopup, setStateDetailPopup] = useState<{ label: string; count: number; value: number; leadCount: number; tenderCount: number; opportunityCount: number; customers: any[] } | null>(null)
  const [panelCategoryFilter,setPanelCategoryFilter]       = useState<'all'|'won'|'pipeline'|'none'>('all')
  const [panelSearch,setPanelSearch]                       = useState('')
  const [memberDetailsOpen,setMemberDetailsOpen]           = useState(false)
  const [memberDetailsTab,setMemberDetailsTab]             = useState<MemberDetailsTab>('customers')
  const [memberDetailsLoading,setMemberDetailsLoading]     = useState(false)
  const [memberDetailsMember,setMemberDetailsMember]       = useState<any>(null)
  const [memberDetailsData,setMemberDetailsData]           = useState<MemberDetailsData>(()=>emptyMemberDetailsData())
  const [memberRecordSummaries,setMemberRecordSummaries]   = useState<MemberRecordSummaryMap>({})

  const { success, error:showError } = useToast()
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore()
  const wasSidebarCollapsed = useRef(sidebarCollapsed)
  useEffect(() => {
    if (!actDetailPopup) return
    wasSidebarCollapsed.current = sidebarCollapsed
    setSidebarCollapsed(true)
    return () => {
      setSidebarCollapsed(wasSidebarCollapsed.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actDetailPopup, setSidebarCollapsed])
  const dateRange = useMemo(()=>{
    if(rangeMode==='week') return {dateFrom:weekStart,dateTo:weekEndIso(weekStart)}
    if(rangeMode==='year') return {dateFrom:`${viewYear}-01-01`,dateTo:`${viewYear}-12-31`}
    if(rangeMode==='range') return {dateFrom:customFrom,dateTo:customTo}
    return {dateFrom:`${period}-01`,dateTo:monthEndIso(period)}
  },[rangeMode,weekStart,period,viewYear,customFrom,customTo])
  const dateLabel = rangeMode==='week'
    ? `Week ${compactRangeLabel(dateRange.dateFrom,dateRange.dateTo)}`
    : rangeMode==='month'
    ? period
    : rangeMode==='year'
    ? String(viewYear)
    : compactRangeLabel(dateRange.dateFrom,dateRange.dateTo)
  const requestPeriod = rangeMode==='year' ? String(viewYear) : period
  const requestViewType = rangeMode==='year' ? 'yearly' : rangeMode==='month' ? 'monthly' : rangeMode
  const currentFiscalYear = (() => {
    const today = new Date()
    return today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1
  })()
  const analysisFiscalYearOptions = Array.from(new Set([
    currentFiscalYear + 1,
    currentFiscalYear,
    currentFiscalYear - 1,
    currentFiscalYear - 2,
    viewYear,
  ])).sort((a, b) => b - a)
  const handleAnalysisFiscalYearChange = (year: number) => {
    setRangeMode('year')
    setIsYearly(true)
    setViewYear(year)
  }

  const params = {
    user_id:   selectedUid||undefined,
    period:    requestPeriod,
    view_type: requestViewType,
    year:      viewYear,
    date_from: dateRange.dateFrom||undefined,
    date_to:   dateRange.dateTo||undefined,
  }

  const load = useCallback(async()=>{
    setLoading(true)
    try{
      const results=await Promise.allSettled([
        api.get('/kam/360-summary',{params}),
        api.get('/kam/customer-activities',{params}),
        api.get('/kam/performance',{params}),
      ])
      if(results[0].status==='fulfilled') setSummary(results[0].value.data)
      else setSummary(null)
      if(results[1].status==='fulfilled') setCustActs(normalizeListResponse(results[1].value.data))
      else setCustActs([])
      if(results[2].status==='fulfilled') setPerf(results[2].value.data)
      else setPerf(null)
    }catch{showError('Failed to load 360 data')}
    finally{setLoading(false)}
  },[period,requestPeriod,requestViewType,selectedUid,viewYear,dateRange.dateFrom,dateRange.dateTo])

  useEffect(()=>{load()},[load])

  const normalizeMasterSalesMember = (member:any) => ({
    id: Number(member?.id ?? member?.value ?? member?.user_id ?? 0),
    full_name: String(member?.label || member?.full_name || member?.user_name || member?.name || '').trim(),
    role: member?.role || member?.subtitle || '',
    is_self: Number(member?.id ?? member?.value ?? member?.user_id ?? 0) === Number(myId),
  })

  const normalizeOrgTreeGroups = (tree:any[]) => {
    const normalizeTreeUser = (node:any) => node?.user_id
      ? {
          id: Number(node.user_id),
          user_id: Number(node.user_id),
          name: node.user_name,
          user_name: node.user_name,
          full_name: node.user_name,
          role: node.user_role,
          email: node.user_email,
          level: node.level,
          node_id: node.id,
          parent_user_id: node.parent_user_id,
        }
      : null

    const collectMembers = (node:any):any[] => {
      const direct = node?.user_id
        ? [{
            id: Number(node.user_id),
            user_id: Number(node.user_id),
            name: node.user_name,
            user_name: node.user_name,
            role: node.user_role,
            email: node.user_email,
            level: node.level,
            node_id: node.id,
            parent_user_id: node.parent_user_id,
            is_group_lead: Number(node.user_id) === Number(node.group_lead_id),
          }]
        : []
      return [
        ...direct,
        ...(node?.children || []).flatMap((child:any)=>collectMembers(child)),
      ]
    }

    const groups:any[] = []
    const walk = (node:any, rootNode:any = node) => {
      if (Number(node?.level) === 2 && String(node?.group_name || '').trim()) {
        const members = collectMembers(node)
          .filter((member:any)=>member.user_id && isSalesKAMUser(member.role))
        const seen = new Set<number>()
        const uniqueMembers = members.filter((member:any)=>{
          if(seen.has(member.user_id)) return false
          seen.add(member.user_id)
          return true
        })
        groups.push({
          id: Number(node.id),
          name: String(node.group_name || '').trim(),
          group_name: String(node.group_name || '').trim(),
          manager_id: Number(node.group_lead_id || node.user_id || 0) || null,
          manager_name: node.group_lead_name || node.user_name || '',
          member_count: uniqueMembers.length,
          members: uniqueMembers,
          root: normalizeTreeUser(rootNode),
          root_user: normalizeTreeUser(rootNode),
          source: 'group_fixing',
        })
      }
      ;(node?.children || []).forEach((child:any)=>walk(child, Number(node?.level) === 1 ? node : rootNode))
    }
    ;(Array.isArray(tree) ? tree : []).forEach((node:any)=>walk(node, node))
    return groups
  }

  useEffect(()=>{
    let alive = true
    const loadTargetBaseline = async() => {
      try{
        const res = await api.get('/kam/targets/baseline-summary')
        if(alive) setTargetBaseline(res.data || null)
      }catch{
        if(alive) setTargetBaseline(null)
      }
    }
    loadTargetBaseline()
    return ()=>{ alive = false }
  },[teamReloadSeq])

  useEffect(()=>{
    let alive = true
    const loadSharedData = async()=>{
      try{
        const customerRecordParams = {
          kind: 'customers',
          period: requestPeriod,
          view_type: requestViewType,
          year: viewYear,
          date_from: dateRange.dateFrom || undefined,
          date_to: dateRange.dateTo || undefined,
          user_id: selectedUid || undefined,
        }
        const customerListRequest = api.get('/kam/pipeline-records', { params: customerRecordParams })
          .catch(() => isAdminOrCEO
            ? api.get('/customers/', { params: { per_page: 2000 } })
            : api.get('/kam/plan-customers', { params: { per_page: 5000 } })
          )
        const customerMapRequest = (isAdminOrCEO
          ? api.get('/customers/', { params: { per_page: 5000 } })
          : api.get('/kam/plan-customers', { params: { per_page: 5000 } })
        ).catch(() => api.get('/kam/plan-customers', { params: { per_page: 5000 } }))
        const results=await Promise.allSettled([
          api.get('/kam/plan-customers',{params:{own_only:true,per_page:5000}}),
          customerListRequest,
          customerMapRequest,
        ])
        if(!alive) return
        if(results[0].status==='fulfilled') setMyOwnCustomers(normalizeListResponse(results[0].value.data))
        if(results[1].status==='fulfilled'){
          const d=results[1].value.data
          setPopupCustomers(normalizeListResponse(d))
        }
        if(results[2].status==='fulfilled') setCustomerMapCustomers(normalizeListResponse(results[2].value.data))
      }catch{}
    }
    const loadTeamData = async()=>{
      if(!canViewTeam) return
      let teamMasterGroups:any[] = []
      try{
        const teamRes=await api.get('/kam/team-360',{params:{period:requestPeriod,view_type:requestViewType,year:viewYear,date_from:dateRange.dateFrom,date_to:dateRange.dateTo}})
        if(!alive) return
        const teamData = teamRes.data || {}
          setTeamRows(teamData.members||[])
          teamMasterGroups = Array.isArray(teamData.master_groups) ? teamData.master_groups : []
          if(teamMasterGroups.length>0) setMasterGroups(teamMasterGroups)
      }catch{}
      if(teamMasterGroups.length===0){
        try{
          const orgRes = await api.get('/masters/org-tree')
          if(!alive) return
          const orgGroups = normalizeOrgTreeGroups(Array.isArray(orgRes.data) ? orgRes.data : [])
          if(orgGroups.length>0) {
            setMasterGroups(orgGroups)
            teamMasterGroups = orgGroups
          }
        }catch{}
      }
      if(alive&&teamMasterGroups.length===0){
        try{
          const groupsRes=await api.get('/masters/groups')
          if(alive) setMasterGroups(Array.isArray(groupsRes.data)?groupsRes.data:[])
        }catch{}
      }
    }
    const loadMasterSalesMembers = async()=>{
      try{
        const res = await api.get('/masters/users-for-select')
        if(!alive) return
        const rows = (Array.isArray(res.data) ? res.data : [])
          .map(normalizeMasterSalesMember)
          .filter((member:any)=>member.id && member.full_name && isSalesKAMUser(member.role))
          .sort((a:any,b:any)=>a.full_name.localeCompare(b.full_name))
        setMasterSalesMembers(rows)
      }catch{}
    }
    const addMasterLocation = (map:Map<string,string>, value:unknown) => {
      const label = cleanPortfolioLabel(value)
      const key = portfolioKey(label)
      if(key && !map.has(key)) map.set(key,label)
    }
    const refreshMasterLocations = (regions:string[], states:Array<{name:string;region_name:string}>, districtsByState:Map<string,string[]>) => {
      const map = new Map<string,string>()
      regions.forEach(region=>addMasterLocation(map, region))
      states.forEach(state=>addMasterLocation(map, state.name))
      districtsByState.forEach(districts=>districts.forEach(district=>addMasterLocation(map, district)))
      setMasterLocationOptions(Array.from(map.entries()).map(([key,label])=>({key,label})).sort((a,b)=>a.label.localeCompare(b.label)))
    }
    let nextMasterRegions:string[] = []
    let nextMasterStates:Array<{name:string;region_name:string}> = []
    let nextMasterDistricts = new Map<string,string[]>()
    const loadMasterStates = async()=>{
      try{
        const res=await api.get('/masters/states')
        if(!alive) return
        const list: Array<{name:string;region_name:string}> = []
        const map=new Map<string,string>()
        ;(Array.isArray(res.data)?res.data:[]).forEach((s:any)=>{
          const key=(s.name||'').toLowerCase().trim()
          const region=s.region_name||s.region||''
          if(key){ map.set(key, region); list.push({name:s.name||'',region_name:region}) }
        })
        if(map.size>0) setMasterStateMap(map)
        nextMasterStates = list
        if(list.length>0) setMasterAllStates(list)
        refreshMasterLocations(nextMasterRegions, nextMasterStates, nextMasterDistricts)
      }catch{}
    }
    const loadMasterDistricts = async()=>{
      try{
        const res=await api.get('/masters/districts')
        if(!alive) return
        const map=new Map<string,string[]>()
        ;(Array.isArray(res.data)?res.data:[]).forEach((d:any)=>{
          const stateKey=(d.state_name||'').toLowerCase().trim()
          const distName=(d.name||'').trim()
          if(!stateKey||!distName) return
          const arr=map.get(stateKey)||[]
          if(!arr.includes(distName)) arr.push(distName)
          map.set(stateKey,arr)
        })
        nextMasterDistricts = map
        if(map.size>0) setMasterStateDistricts(map)
        refreshMasterLocations(nextMasterRegions, nextMasterStates, nextMasterDistricts)
      }catch{}
    }
    const loadMasterRegions = async()=>{
      try{
        const res=await api.get('/masters/regions')
        if(!alive) return
        const names=(Array.isArray(res.data)?res.data:[]).map((r:any)=>r.name||'').filter(Boolean)
        nextMasterRegions = names
        if(names.length>0) setMasterRegionNames(names)
        refreshMasterLocations(nextMasterRegions, nextMasterStates, nextMasterDistricts)
      }catch{}
    }
    const loadMasterCustomerSegments = async()=>{
      try{
        const res=await api.get('/masters/vertical-sectors')
        if(!alive) return
        const rows = (Array.isArray(res.data) ? res.data : [])
          .map((segment:any)=>{
            const label = cleanPortfolioLabel(segment.name)
            const key = portfolioKey(label)
            return key && label ? {key:`segment:${key}`,label} : null
          })
          .filter(Boolean)
        setMasterSegments(rows as Array<{key:string;label:string}>)
      }catch{}
    }
    const loadMasterCustomerSubSegments = async()=>{
      try{
        const res=await api.get('/masters/vertical-sub-sectors')
        if(!alive) return
        const rows = (Array.isArray(res.data)?res.data:[])
          .map((s:any)=>({
            id: Number(s.id || 0) || undefined,
            name: String(s.name || '').trim(),
            sector_id: Number(s.sector_id || 0) || undefined,
            sector_name: String(s.sector_name || '').trim(),
          }))
          .filter((s: CustomerSubSegmentMaster)=>s.name && s.sector_name)
        setMasterSegmentSubSegments(rows)
      }catch{}
    }
    const loadMasterBusinessUnits = async()=>{
      try{
        const res=await api.get('/masters/business-units')
        if(!alive) return
        const uv=new Map<string,string>()
        const vu=new Map<string,string[]>()
        ;(Array.isArray(res.data)?res.data:[]).forEach((u:any)=>{
          const unit=(u.name||u.business_unit||'').trim()
          const vertical=(u.vertical_name||'').trim()
          if(!unit||!vertical) return
          uv.set(unit.toLowerCase(),vertical)
          const arr=vu.get(vertical)||[]
          if(!arr.includes(unit)) arr.push(unit)
          vu.set(vertical,arr)
        })
        if(uv.size>0){setMasterUnitVertical(uv);setMasterVerticalUnits(vu)}
      }catch{}
    }
    loadSharedData().catch(()=>{})
    loadTeamData().catch(()=>{})
    loadMasterSalesMembers().catch(()=>{})
    loadMasterStates().catch(()=>{})
    loadMasterDistricts().catch(()=>{})
    loadMasterRegions().catch(()=>{})
    loadMasterCustomerSegments().catch(()=>{})
    loadMasterCustomerSubSegments().catch(()=>{})
    loadMasterBusinessUnits().catch(()=>{})
    return ()=>{alive=false}
  },[canViewTeam,isAdminOrCEO,requestPeriod,requestViewType,viewYear,dateRange.dateFrom,dateRange.dateTo,selectedUid,teamReloadSeq])

  const resolvePanelMemberName = (userId?: number, memberName?: string) => {
    if (memberName) return memberName
    const rawUid = userId !== undefined ? userId : selectedUid
    const uid = rawUid ? Number(rawUid) : null
    if (!uid) return ''
    return teamRows.find((m:any)=>Number(m.user_id)===uid)?.user_name
      || teamMembers.find((u:any)=>Number(u.id)===uid)?.full_name
      || ''
  }

  const inSelectedRange = (raw:any) => {
    if(!raw || !dateRange.dateFrom || !dateRange.dateTo) return true
    const d = String(raw).slice(0,10)
    return d >= dateRange.dateFrom && d <= dateRange.dateTo
  }

  const loadPipelineRecords = async (
    kind: 'customers' | 'leads' | 'opportunities' | 'tenders' | 'workorders',
    userId?: number,
    members?: any[],
    customerIds?: Array<number|string>,
    options?: { allTime?: boolean; customerScopeOnly?: boolean },
  ) => {
    const rawUid = userId !== undefined ? userId : selectedUid
    const uid = rawUid ? Number(rawUid) : null
    const memberIds = uid
      ? []
      : (Array.isArray(members) && members.length
        ? members
        : selectedGroupKey
          ? filteredSalesTeamRows
          : []
      )
        .map((m:any) => Number(m.user_id || m.id || 0))
        .filter(Boolean)

    const params: any = {
      kind,
    }
    if (options?.allTime) {
      params.all_time = true
    } else {
      params.period = requestPeriod
      params.view_type = requestViewType
      params.year = viewYear
      params.date_from = dateRange.dateFrom
      params.date_to = dateRange.dateTo
    }
    if (options?.customerScopeOnly) params.customer_scope_only = true
    if (uid) params.user_id = uid
    else if (memberIds.length) params.member_ids = Array.from(new Set(memberIds)).join(',')
    const cidParam = Array.from(new Set((customerIds || []).map((id:any)=>Number(id)).filter(Boolean))).join(',')
    if (cidParam) params.customer_ids = cidParam

    const r = await api.get('/kam/pipeline-records', { params })
    return Array.isArray(r.data) ? r.data : []
  }

  const loadPanelBusinessRecords = async (customerRows:any[], userId?: number, members?: any[]): Promise<CustomerBusinessRecords> => {
    const customerIds = Array.from(new Set((customerRows || [])
      .map((c:any)=>Number(c?.customer_id ?? c?.id ?? 0))
      .filter(Boolean)))
    if(!customerIds.length) return emptyCustomerBusinessRecords()
    const [leads, opportunities, tenders, workorders] = await Promise.all([
      loadPipelineRecords('leads', userId, members, customerIds).catch(()=>[]),
      loadPipelineRecords('opportunities', userId, members, customerIds).catch(()=>[]),
      loadPipelineRecords('tenders', userId, members, customerIds).catch(()=>[]),
      loadPipelineRecords('workorders', userId, members, customerIds).catch(()=>[]),
    ])
    return { leads, opportunities, tenders, workorders }
  }

  const openLeadPanel = async (userId?: number, memberName?: string, mode:'leads'|'opportunities' = 'leads') => {
    const isOpportunityMode = mode === 'opportunities'
    const resolvedMemberName = resolvePanelMemberName(userId, memberName)
    setPanelMemberName(resolvedMemberName)
    setPanelLeadLabel(isOpportunityMode ? 'Opportunities' : 'Leads')
    setPanelLeads([])
    setLeadPanel(true)
    setPanelLoading(true)
    try {
      setPanelLeads(await loadPipelineRecords(isOpportunityMode ? 'opportunities' : 'leads', userId))
    } catch (e: any) {
      const msg = e?.response?.data?.detail
      showError(typeof msg === 'string' ? msg : isOpportunityMode ? 'Failed to load opportunities' : 'Failed to load leads')
    }
    finally { setPanelLoading(false) }
  }

  const openTenderPanel = async (userId?: number, memberName?: string) => {
    setPanelMemberName(resolvePanelMemberName(userId, memberName))
    setPanelTenders([])
    setTenderPanel(true)
    setPanelLoading(true)
    try {
      setPanelTenders(await loadPipelineRecords('tenders', userId))
    } catch (e: any) {
      const msg = e?.response?.data?.detail
      showError(typeof msg === 'string' ? msg : 'Failed to load tenders')
    }
    finally { setPanelLoading(false) }
  }

  const openWorkOrderPanel = async (userId?: number, memberName?: string) => {
    const resolvedMemberName = resolvePanelMemberName(userId, memberName)
    setPanelMemberName(resolvedMemberName)
    setPanelWorkOrders([])
    setWorkOrderPanel(true)
    setPanelLoading(true)
    try {
      setPanelWorkOrders(await loadPipelineRecords('workorders', userId))
    } catch (e: any) {
      const msg = e?.response?.data?.detail
      showError(typeof msg === 'string' ? msg : 'Failed to load work orders')
    } finally { setPanelLoading(false) }
  }

  const openLeadPanelByCustomer = async (customerId: number, customerName: string) => {
    setPanelMemberName(customerName)
    setPanelLeadLabel('Leads')
    setPanelLeads([])
    setLeadPanel(true)
    setPanelLoading(true)
    try {
      const r = await api.get('/leads', { params: { customer_id: customerId, date_from: dateRange.dateFrom, date_to: dateRange.dateTo } })
      const leads = Array.isArray(r.data) ? r.data : []
      setPanelLeads(leads.filter((l: any) => l.customer_id === customerId && inSelectedRange(l.lead_created_at || l.created_at)))
    } catch (e: any) {
      showError('Failed to load leads')
    } finally { setPanelLoading(false) }
  }

  const openTenderPanelByCustomer = async (customerId: number, customerName: string) => {
    setPanelMemberName(customerName)
    setPanelTenders([])
    setTenderPanel(true)
    setPanelLoading(true)
    try {
      const r = await api.get('/tenders/', { params: { customer_id: customerId, per_page: 500, page: 1, date_from: dateRange.dateFrom, date_to: dateRange.dateTo } })
      const items = Array.isArray(r.data?.items) ? r.data.items : Array.isArray(r.data) ? r.data : []
      setPanelTenders(items.filter((t: any) => t.customer_id === customerId && inSelectedRange(t.result_date || t.submission_date || t.published_date || t.created_at)))
    } catch (e: any) {
      showError('Failed to load tenders')
    } finally { setPanelLoading(false) }
  }

  const openActPanel = async (actType?: string, userId?: number, memberName?: string) => {
    const label = actType || 'Activities'
    setPanelMemberName(resolvePanelMemberName(userId, memberName))
    setPanelActType(label)
    setPanelActs([])
    if(!actPanel) setActPanelExpanded(false)
    setActPanel(true)
    setPanelLoading(true)
    try {
      const p: any = { per_page: 500, date_from: dateRange.dateFrom, date_to: dateRange.dateTo }
      if (actType) p.activity_type = actType
      const rawUid = userId !== undefined ? userId : selectedUid
      const uid = rawUid ? Number(rawUid) : null
      if (uid) p.user_id = uid
      const r = await api.get('/kam/activities', { params: p })
      const rows = Array.isArray(r.data) ? r.data : []
      let scopedRows = !uid && selectedGroupKey && selectedGroupMemberNames.size>0
        ? rows.filter((activity:any)=>{
            const names = [
              activity.user_name,
              activity.assigned_to_name,
              activity.owner_name,
              activity.created_by_name,
            ].filter(Boolean)
            return names.some((name:any)=>selectedGroupMemberNames.has(String(name).toLowerCase()))
          })
        : rows
      if(hasCustomerDropdownFilter){
        const customerIds = new Set(filteredCusts.map((customer:any)=>Number(customer.customer_id ?? customer.id ?? 0)).filter(Boolean))
        const customerNames = new Set(filteredCusts.map((customer:any)=>String(customer.customer_name || customer.name || '').trim().toLowerCase()).filter(Boolean))
        scopedRows = scopedRows.filter((activity:any)=>{
          const rowIds = [activity.customer_id,activity.account_id,activity.client_id].map((id:any)=>Number(id||0)).filter(Boolean)
          const rowNames = [activity.customer_name,activity.account_name,activity.client_name,activity.name].map((name:any)=>String(name||'').trim().toLowerCase()).filter(Boolean)
          return rowIds.some(id=>customerIds.has(id)) || rowNames.some(name=>customerNames.has(name))
        })
      }
      setPanelActs(scopedRows)
    } catch {
      showError('Failed to load activities')
    } finally { setPanelLoading(false) }
  }

  const closeActPanel = () => {
    setActPanel(false)
    setPanelSearch('')
    setActPanelExpanded(false)
  }

  const openMemberDetailsPanel = async (member: any, tab: MemberDetailsTab = 'customers') => {
    const uid = Number(member?.user_id || member?.id || 0)
    if (!uid) return
    setMemberDetailsMember(member)
    setMemberDetailsTab(tab)
    setMemberDetailsData(emptyMemberDetailsData())
    setMemberDetailsOpen(true)
    setMemberDetailsLoading(true)
    try {
      const activityParams: any = { per_page: 500, date_from: dateRange.dateFrom, date_to: dateRange.dateTo, user_id: uid }
      const [customers, leads, opportunities, tenders, workorders, activitiesRes] = await Promise.all([
        loadPipelineRecords('customers', uid),
        loadPipelineRecords('leads', uid),
        loadPipelineRecords('opportunities', uid),
        loadPipelineRecords('tenders', uid),
        loadPipelineRecords('workorders', uid),
        api.get('/kam/activities', { params: activityParams }),
      ])
      const nextDetails = {
        customers,
        leads,
        opportunities,
        tenders,
        workorders,
        activities: Array.isArray(activitiesRes.data) ? activitiesRes.data : [],
      }
      setMemberDetailsData(nextDetails)
      setMemberRecordSummaries(prev => ({ ...prev, [uid]: summarizeMemberDetailsData(nextDetails) }))
    } catch (e: any) {
      const msg = e?.response?.data?.detail
      showError(typeof msg === 'string' ? msg : 'Failed to load member details')
    } finally {
      setMemberDetailsLoading(false)
    }
  }

  const openCustomerPanel = async (userId?: number, memberName?: string, ownOnly = false) => {
    setPanelMemberName(resolvePanelMemberName(userId, memberName))
    setPanelCustomers([])
    setPanelBusinessRecords(emptyCustomerBusinessRecords())
    setPanelCategoryFilter('all')
    setCustomerPanel(true)
    setPanelLoading(true)
    // Attach the member's own sales target + booked revenue so the panel header is accurate
    const rawUidForTarget = userId !== undefined ? userId : selectedUid
    const memberRow = rawUidForTarget ? teamRows.find((m:any)=>m.user_id===Number(rawUidForTarget)) : null
    setPanelMemberSalesTarget(memberRow ? (memberRow.sales_target||0) : 0)
    setPanelMemberWonValue(memberRow ? (memberRow.wo_value||memberRow.won_tender_value||0) : 0)
    setPanelMemberLeadValue(memberRow ? (memberRow.lead_value||0) : 0)
    setPanelMemberTenderValue(memberRow ? (memberRow.tender_value||0) : 0)
    try {
      const rawUid = userId !== undefined ? userId : selectedUid
      const uid = rawUid ? Number(rawUid) : null
      let items: any[] = []
      try {
        items = await loadPipelineRecords('customers', uid || undefined)
      } catch {
        const r = await api.get('/customers/', { params: uid ? { assigned_to: uid } : {} })
        items = Array.isArray(r.data?.items) ? r.data.items : Array.isArray(r.data) ? r.data : []
      }
      setPanelCustomers(items)
      setPanelBusinessRecords(await loadPanelBusinessRecords(items, uid || undefined))
    } catch (e: any) {
      showError(`Failed to load ${customerLabelLower}`)
    } finally { setPanelLoading(false) }
  }

  const saveTarget=async(data:any)=>{
    setSavingTarget(true)
    try{
      const isGroupTarget=Boolean(data.group_id&&Array.isArray(data.allocations))
      const res = await api.post(isGroupTarget?'/kam/targets/group':'/kam/targets',data)
      const savedTarget = res.data || data
      const savedUserId = Number(savedTarget.user_id || data.user_id)
      const savedSalesTarget = Number(savedTarget.sales_target ?? data.sales_target ?? 0)
      const targetYear = Number(data.period)
      const isSavedYearTarget = /^\d{4}$/.test(String(data.period)) && Boolean(targetYear)
      success(isGroupTarget?'Group target allocated successfully':'Target set successfully')
      setShowTargetModal(false)
      if(isGroupTarget&&Array.isArray(savedTarget.allocations)&&(!isSavedYearTarget||(rangeMode==='year'&&viewYear===targetYear))){
        const targetByUser=new Map(savedTarget.allocations.map((row:any)=>[Number(row.user_id),Number(row.sales_target||0)]))
        setTeamRows(rows=>rows.map((member:any)=>{
          if(!targetByUser.has(Number(member.user_id))) return member
          const nextTarget = targetByUser.get(Number(member.user_id))
          return {...member,sales_target:nextTarget,annual_sales_target:isSavedYearTarget?nextTarget:member.annual_sales_target}
        }))
      }else if(savedUserId && (!isSavedYearTarget || (rangeMode==='year' && viewYear===targetYear))){
        setTeamRows(rows=>rows.map((m:any)=>Number(m.user_id)===savedUserId ? {...m,sales_target:savedSalesTarget,annual_sales_target:isSavedYearTarget?savedSalesTarget:m.annual_sales_target} : m))
      }
      if(isSavedYearTarget){
        setRangeMode('year')
        setIsYearly(true)
        setViewYear(targetYear)
        if(rangeMode==='year' && viewYear===targetYear) await load()
      } else {
        await load()
      }
      setTeamReloadSeq(n=>n+1)
    }
    catch(e:any){showError(e.response?.data?.detail||'Failed')}
    finally{setSavingTarget(false)}
  }

  const perfStats = perf?.actuals    ||{}
  const targets   = perf?.targets    ||{}
  const quarterly = perf?.quarterly  ||[]
  const salesTeamMembers = teamMembers.filter((u:any)=>isSalesKAMUser(u.role))
  const getMemberGroupInfo = (m:any) => {
    const groupName = Array.isArray(m.group_names) && m.group_names.length
      ? m.group_names.map((g:any)=>String(g||'').trim()).filter(Boolean).join(', ')
      : String(m.group_name || '').trim()
    const groupIds = Array.isArray(m.group_ids)
      ? m.group_ids.map((gid:any)=>Number(gid)).filter(Boolean)
      : String(m.group_id||'').split(',').map((gid:string)=>Number(gid.trim())).filter(Boolean)
    const primaryGroupId = groupIds[0] || null
    const groupIndex = primaryGroupId
      ? masterGroups.findIndex((g:any)=>Number(g.id)===primaryGroupId || Number(g.manager_id)===Number(m.user_id))
      : masterGroups.findIndex((g:any)=>String(g.name||g.group_name||'').trim()===groupName)
    const colorSeed = groupIndex >= 0 ? groupIndex : Number(primaryGroupId || 0)
    return {
      id: primaryGroupId || groupName || 'ungrouped',
      ids: groupIds,
      name: groupName || 'Ungrouped',
      names: Array.isArray(m.group_names) ? m.group_names.map((g:any)=>String(g||'').trim()).filter(Boolean) : [],
      index: groupIndex,
      gradient: KAM_GROUP_GRADIENTS[Math.abs(colorSeed)%KAM_GROUP_GRADIENTS.length],
    }
  }
  const memberBelongsToGroup = (member:any, groupKey:string) => {
    if(!groupKey) return true
    const master = masterGroups.find((group:any)=>String(group.id)===String(groupKey))
    if(master && Array.isArray(master.members) && master.members.some((groupMember:any)=>Number(groupMember.user_id || groupMember.id)===Number(member.user_id || member.id))) return true
    const group = getMemberGroupInfo(member)
    return (group.ids || []).some((gid:any)=>String(gid)===String(groupKey)) || String(group.id)===String(groupKey)
  }
  const targetCardTargetValue = (member:any) => Number(member.annual_sales_target || member.sales_target || member.target || 0)
  const salesTeamRows = teamRows.filter((m:any)=>isSalesKAMUser(m.role)).map((m:any)=>{
    // Fallback: if meetings is not provided by backend, try to calculate from activity breakdown
    // This ensures meetings count is never zero when there might be actual meeting activities
    if((m.meetings||0)===0 && m.activity_types && (m.activity_types['In Person Meet']||0)>0){
      return {...m, meetings: m.activity_types['In Person Meet']}
    }
    return m
  })
  const groupOptions = useMemo(()=>{
    const map = new Map<string,string>()
    masterGroups.forEach((group:any)=>{
      const key = String(group.id || '').trim()
      const label = String(group.name || group.group_name || '').trim()
      if(key && label) map.set(key,label)
    })
    salesTeamRows.forEach((member:any)=>{
      const group = getMemberGroupInfo(member)
      const ids = Array.isArray(group.ids) && group.ids.length ? group.ids : [group.id]
      const names = Array.isArray(group.names) && group.names.length ? group.names : [group.name]
      ids.forEach((gid:any,index:number)=>{
        const key = String(gid)
        const name = String(names[index] || group.name || '').trim()
        if(key && name && name.toLowerCase() !== 'ungrouped') map.set(key,name)
      })
    })
    return Array.from(map.entries())
      .map(([key,label])=>({key,label}))
      .sort((a,b)=>a.label.localeCompare(b.label))
  },[salesTeamRows, masterGroups])
  const filteredSalesTeamRows = selectedGroupKey
    ? salesTeamRows.filter((member:any)=>memberBelongsToGroup(member,selectedGroupKey))
    : salesTeamRows
  const salesTeamSummaryUserKey = Array.from(new Set(filteredSalesTeamRows
    .map((member:any)=>Number(member.user_id || member.id || 0))
    .filter(Boolean)))
    .sort((a:number,b:number)=>a-b)
    .join(',')

  useEffect(()=>{
    // Keep member summaries as a lazy cache populated from explicit member-detail opens
    // instead of preloading 6 requests per team member on every KAM 360 load.
    setMemberRecordSummaries({})
  },[canViewTeam, salesTeamSummaryUserKey, requestPeriod, requestViewType, viewYear, dateRange.dateFrom, dateRange.dateTo])

  const visibleTeamMembers = (() => {
    if(selectedGroupKey){
      const master = masterGroups.find((group:any)=>String(group.id)===String(selectedGroupKey))
      const masterMembers = Array.isArray(master?.members)
        ? master.members
          .map((member:any)=>({
            id:Number(member.user_id || member.id || 0),
            full_name:String(member.user_name || member.name || member.full_name || '').trim(),
            role:member.role || '',
            is_self:Number(member.user_id || member.id || 0)===Number(myId),
          }))
          .filter((member:any)=>member.id && member.full_name && isSalesKAMUser(member.role))
          .sort((a:any,b:any)=>a.full_name.localeCompare(b.full_name))
        : []
      if(masterMembers.length>0) return masterMembers
      return filteredSalesTeamRows.map((m:any)=>({id:m.user_id,full_name:m.user_name,role:m.role,is_self:m.is_self}))
    }
    if(masterSalesMembers.length>0) return masterSalesMembers
    return salesTeamRows.length>0
      ? salesTeamRows.map((m:any)=>({id:m.user_id,full_name:m.user_name,role:m.role,is_self:m.is_self}))
      : salesTeamMembers
  })()
  const targetGroups = groupOptions.map(groupOption=>{
    const master=masterGroups.find((group:any)=>String(group.id)===String(groupOption.key))
    if(master?.source!=='group_fixing'||!Array.isArray(master.members)) return {id:groupOption.key,name:groupOption.label,members:[]}
    const scopedUserIds=new Set(salesTeamRows.map((member:any)=>Number(member.user_id)))
    const sourceMembers=master.members.filter((member:any)=>isSalesKAMUser(member.role))
    if(sourceMembers.some((member:any)=>!scopedUserIds.has(Number(member.user_id||member.id)))) return {id:groupOption.key,name:groupOption.label,members:[]}
    const seen=new Set<number>()
    const members=sourceMembers
      .map((member:any)=>({user_id:Number(member.user_id||member.id),user_name:member.user_name||member.name||member.full_name,role:member.role}))
      .filter((member:any)=>member.user_id&&isSalesKAMUser(member.role)&&!seen.has(member.user_id)&&Boolean(seen.add(member.user_id)))
    return {id:groupOption.key,name:groupOption.label,members}
  }).filter(group=>group.members.length>0)
  const targetCardGroupRows = isAdminOrCEO&&targetCardGroupKey
    ? salesTeamRows.filter((member:any)=>memberBelongsToGroup(member,targetCardGroupKey))
    : salesTeamRows
  const targetCardMemberOptions = isAdminOrCEO
    ? (targetCardGroupKey ? targetCardGroupRows : [])
    : salesTeamRows

  useEffect(()=>{
    if(!isAdminOrCEO||targetCardMode!=='member'||targetCardGroupKey||!groupOptions.length)return
    setTargetCardGroupKey(groupOptions[0].key)
  },[isAdminOrCEO,targetCardMode,targetCardGroupKey,groupOptions])

  useEffect(()=>{
    if(targetCardMode!=='member')return
    const options=targetCardMemberOptions
    if(targetCardMemberId&&options.some((member:any)=>Number(member.user_id)===Number(targetCardMemberId)))return
    const preferred=!isAdminOrCEO?options.find((member:any)=>Number(member.user_id)===Number(myId)):null
    setTargetCardMemberId(Number(preferred?.user_id||options[0]?.user_id)||null)
  },[targetCardMode,targetCardGroupKey,targetCardMemberOptions,targetCardMemberId,isAdminOrCEO,myId])

  useEffect(()=>{
    if(selectedUid && !visibleTeamMembers.some((u:any)=>u.id===selectedUid&&isSalesKAMUser(u.role))) setSelectedUid(null)
  },[selectedUid,selectedGroupKey,teamRows,teamMembers])

  const portfolioValue = (c:any) => {
    const direct = Number(c.potential_value ?? c.customer_potential_value ?? c.annual_revenue ?? c.revenue ?? 0)
    if(direct>0) return direct
    return Number(c.lead_value||0)+Number(c.tender_value||0)+Number(c.won_value||0)+Number(c.wo_value||0)
  }
  const portfolioLabel = (c:any, keys:string[]) => {
    for(const key of keys){
      const value = c?.[key]
      if(value!==undefined && value!==null && String(value).trim()) return String(value).trim()
    }
    return 'Unassigned'
  }
  const segmentKeys = ['vertical','customer_vertical','segment','industry']
  const locationKeys = ['billing_city','city','location','billing_state','state']
  const cleanPortfolioLabel = (value:unknown) => String(value||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim()
  const portfolioKey = (value:unknown) => cleanPortfolioLabel(value).toLowerCase()
  const uniquePortfolioOptions = (rows:any[], keys:string[]) => {
    const map = new Map<string,string>()
    rows.forEach((row:any)=>{
      const label = portfolioLabel(row, keys)
      const key = label.trim().toLowerCase()
      if(key && key !== 'unassigned') map.set(key,label)
    })
    return Array.from(map.entries())
      .map(([key,label])=>({key,label}))
      .sort((a,b)=>a.label.localeCompare(b.label))
  }
  const masterSubSegmentByKey = useMemo(() => {
    const map = new Map<string,{parentLabel:string;subLabel:string;parentKey:string;subKey:string}>()
    ;(masterSegmentSubSegments || []).forEach(sub => {
      const parentLabel = cleanPortfolioLabel(sub.sector_name)
      const subLabel = cleanPortfolioLabel(sub.name)
      if(!parentLabel || !subLabel) return
      const parentKey = portfolioKey(parentLabel)
      const subKey = portfolioKey(subLabel)
      const entry = { parentLabel, subLabel, parentKey, subKey }
      if(!map.has(subKey)) map.set(subKey, entry)
      map.set(portfolioKey(`${parentLabel} / ${subLabel}`), entry)
    })
    return map
  },[masterSegmentSubSegments])
  const customerSegmentPartsForFilter = useCallback((c:any) => {
    const rawLabel = cleanPortfolioLabel(portfolioLabel(c, segmentKeys))
    const rawParts = rawLabel.split('/').map(part=>cleanPortfolioLabel(part)).filter(Boolean)
    const inlineSub = rawParts.length > 1 ? rawParts[rawParts.length - 1] : ''
    const rawMaster = masterSubSegmentByKey.get(portfolioKey(rawLabel))
    const inlineMaster = inlineSub ? masterSubSegmentByKey.get(portfolioKey(inlineSub)) : undefined
    const explicitCandidates = [
      inlineSub,
      c.sub_segment,
      c.customer_sub_segment,
      c.subsegment,
      c.customer_segment_child,
      c.customer_vertical_sub_segment,
      c.vertical_sub_sector,
      c.vertical_sub_sector_name,
    ].map(cleanPortfolioLabel).filter(Boolean)
    const explicitMaster = explicitCandidates.map(candidate=>masterSubSegmentByKey.get(portfolioKey(candidate))).find(Boolean)
    const master = rawMaster || inlineMaster || explicitMaster
    if(master) return master
    const parentLabel = rawParts.length > 1 ? rawParts[0] : rawLabel
    const subLabel = explicitCandidates[0] || ''
    return {
      parentLabel,
      subLabel,
      parentKey: portfolioKey(parentLabel),
      subKey: portfolioKey(subLabel),
    }
  },[masterSubSegmentByKey])
  const segmentOptions = useMemo(() => {
    const map = new Map<string,string>()
    masterSegments.forEach(segment => {
      const key = segment.key.startsWith('segment:') ? segment.key.slice(8) : segment.key
      if(key && segment.label) map.set(key, segment.label)
    })
    if (masterSegments.length === 0) {
      custActs.forEach((c:any)=>{
        const parts = customerSegmentPartsForFilter(c)
        if(parts.parentKey && parts.parentKey !== 'unassigned') map.set(parts.parentKey, parts.parentLabel)
      })
    }
    ;(masterSegmentSubSegments || []).forEach(sub => {
      const label = cleanPortfolioLabel(sub.sector_name)
      const key = portfolioKey(label)
      if(key) map.set(key, label)
    })
    return Array.from(map.entries())
      .map(([key,label])=>({key:`segment:${key}`,label}))
  },[custActs,customerSegmentPartsForFilter,masterSegmentSubSegments,masterSegments])
  const customerMatchesSegmentSelection = useCallback((c:any, selection:string) => {
    if(!selection) return true
    const parts = customerSegmentPartsForFilter(c)
    const selectedParentKey = selection.startsWith('segment:') ? selection.slice(8) : selection
    return parts.parentKey === selectedParentKey
  },[customerSegmentPartsForFilter])
  const locationOptions = useMemo(()=>{
    const map = new Map<string,string>()
    masterLocationOptions.forEach(location=>{
      const key = location.key.startsWith('location:') ? location.key.slice(9) : location.key
      if(key && location.label) map.set(key, location.label)
    })
    uniquePortfolioOptions(custActs, locationKeys).forEach(location=>map.set(location.key, location.label))
    return Array.from(map.entries())
      .map(([key,label])=>({key:`location:${key}`,label}))
      .sort((a,b)=>a.label.localeCompare(b.label))
  },[custActs,masterLocationOptions])
  const customerMatchesLocationSelection = useCallback((c:any, selection:string) => {
    if(!selection) return true
    const selectedKey = selection.startsWith('location:') ? selection.slice(9) : selection
    const stateLabel = cleanPortfolioLabel(c.billing_state || c.state || c.customer_state || c.shipping_state || c.billing_state_name || c.state_name)
    const stateKey = portfolioKey(stateLabel)
    const regionKey = stateKey ? portfolioKey(masterStateMap.get(stateKey) || '') : ''
    const candidateKeys = [
      c.billing_city,
      c.city,
      c.location,
      c.district,
      c.billing_district,
      c.city_district,
      c.customer_district,
      c.customer_city,
      stateLabel,
      masterStateMap.get(stateKey),
    ].map(portfolioKey).filter(Boolean)
    return candidateKeys.includes(selectedKey) || Boolean(regionKey && regionKey === selectedKey)
  },[masterStateMap])
  const selectedGroupMemberNames = useMemo(()=>{
    const names = new Set<string>()
    if(!selectedGroupKey) return names
    const master = masterGroups.find((group:any)=>String(group.id)===String(selectedGroupKey))
    const sourceRows = Array.isArray(master?.members) && master.members.length ? master.members : filteredSalesTeamRows
    sourceRows.forEach((m:any)=>{
      const name = m.user_name || m.name || m.full_name
      if(name) names.add(String(name).toLowerCase())
      if(m.user_name) names.add(String(m.user_name).toLowerCase())
    })
    return names
  },[selectedGroupKey, filteredSalesTeamRows, masterGroups])
  const hasCustomerDropdownFilter = Boolean(selectedSegment||selectedLocation||selectedCustId||custSearch)
  const filteredCusts = custActs.filter(c=>{
    const matchSearch=!custSearch||c.customer_name?.toLowerCase().includes(custSearch.toLowerCase())
    const matchCust=!selectedCustId||c.customer_id===selectedCustId
    const matchSegment=customerMatchesSegmentSelection(c,selectedSegment)
    const matchLocation=customerMatchesLocationSelection(c,selectedLocation)
    const matchGroup=!selectedGroupKey||selectedGroupMemberNames.size===0||[c.assigned_to_name,...(Array.isArray(c.assigned_to_names)?c.assigned_to_names:[])]
      .filter(Boolean)
      .some((name:any)=>selectedGroupMemberNames.has(String(name).toLowerCase()))
    return matchSearch&&matchCust&&matchSegment&&matchLocation&&matchGroup
  })
  const customerIdForRow = (c:any) => String(c.customer_id ?? c.id ?? c.customer_name ?? c.name ?? '').trim()
  const allCustomerRows = useMemo(() => {
    const source = customerMapCustomers.length
      ? customerMapCustomers
      : popupCustomers.length
      ? popupCustomers
      : custActs
    return source.filter((c:any)=>{
      const name = String(c.customer_name || c.name || '').toLowerCase()
      const matchSearch = !custSearch || name.includes(custSearch.toLowerCase())
      const rowId = Number(c.customer_id ?? c.id ?? 0)
      const matchCust = !selectedCustId || rowId === Number(selectedCustId)
      const matchSegment = customerMatchesSegmentSelection(c, selectedSegment)
      const matchLocation = customerMatchesLocationSelection(c, selectedLocation)
      const selectedMemberLabel = selectedUid
        ? String(
            visibleTeamMembers.find((u:any)=>Number(u.id)===Number(selectedUid))?.full_name
            || teamRows.find((m:any)=>Number(m.user_id)===Number(selectedUid))?.user_name
            || ''
          ).toLowerCase()
        : ''
      const assignedIds = [c.assigned_to,c.assigned_to_id,c.assigned_user_id,c.user_id,c.owner_id]
      const assignedNames = [c.assigned_to_name,c.owner_name,c.user_name,...(Array.isArray(c.assigned_to_names) ? c.assigned_to_names : [])]
      const matchMember = !selectedUid
        || assignedIds.some((id:any)=>Number(id)===Number(selectedUid))
        || (selectedMemberLabel && assignedNames.filter(Boolean).some((name:any)=>String(name).toLowerCase()===selectedMemberLabel))
      const matchGroup = !selectedGroupKey || selectedGroupMemberNames.size === 0 || [
        c.assigned_to_name,
        c.owner_name,
        c.user_name,
        ...(Array.isArray(c.assigned_to_names) ? c.assigned_to_names : []),
      ].filter(Boolean).some((name:any)=>selectedGroupMemberNames.has(String(name).toLowerCase()))
      return matchSearch && matchCust && matchSegment && matchLocation && matchMember && matchGroup
    })
  },[customerMapCustomers,popupCustomers,custActs,custSearch,selectedCustId,selectedSegment,selectedLocation,selectedUid,selectedGroupKey,selectedGroupMemberNames,visibleTeamMembers,teamRows,customerMatchesSegmentSelection,customerMatchesLocationSelection])

  const pipelineScopeMemberIds = selectedUid
    ? []
    : selectedGroupKey
      ? Array.from(new Set(filteredSalesTeamRows.map((member:any)=>Number(member.user_id || member.id || 0)).filter(Boolean)))
      : []
  const pipelineScopeMemberIdsKey = pipelineScopeMemberIds.join(',')
  const selectedGroupMemberNamesKey = selectedGroupKey
    ? Array.from(selectedGroupMemberNames).sort().join('|')
    : ''
  const pipelineCustomerFilterIds = hasCustomerDropdownFilter
    ? Array.from(new Set(filteredCusts.map((customer:any)=>Number(customer.customer_id ?? customer.id ?? 0)).filter(Boolean)))
    : []
  const pipelineCustomerFilterCount = hasCustomerDropdownFilter ? filteredCusts.length : 0
  const pipelineCustomerFilterIdsKey = pipelineCustomerFilterIds.join(',')
  const pipelineCustomerFilterNamesKey = hasCustomerDropdownFilter
    ? Array.from(new Set(filteredCusts.map((customer:any)=>String(customer.customer_name || customer.name || '').trim().toLowerCase()).filter(Boolean))).sort().join('|')
    : ''

  useEffect(()=>{
    let alive = true
    const valueFrom = (row:any, keys:string[]) => {
      for(const key of keys){
        const n = Number(row?.[key] || 0)
        if(n>0) return n
      }
      return 0
    }
    const sumRows = (rows:any[], keys:string[]) => rows.reduce((sum:number,row:any)=>sum+valueFrom(row,keys),0)
    const dedupeBy = (rows:any[], keys:string[]) => {
      const map = new Map<string,any>()
      rows.forEach((row:any)=>{
        const primary = keys.map(key=>row?.[key]).find(value=>value!==undefined&&value!==null&&String(value).trim())
        const fallback = row?.id ?? row?.customer_id ?? row?.name ?? row?.customer_name
        const key = String(primary ?? fallback ?? '').trim()
        if(key && !map.has(key)) map.set(key,row)
      })
      return Array.from(map.values())
    }
    const normalizedActivityType = (activity:any) => {
      const type = taskTypeName(activity)
      if(type==='Daily Call') return 'Phone Call'
      if(type==='Meeting') return 'In Person Meet'
      if(type==='Follow-up') return 'Follow Up'
      return type
    }
    const isDirectOpportunity = (row:any) => String(row?.lead_type || '').trim().toLowerCase() === 'direct_opportunity'
    const isOpportunityRow = (row:any) => {
      const status = String(row?.status || '').trim()
      return isDirectOpportunity(row) || status === 'Opportunity Created' || status === 'Converted'
    }
    const rowRecordId = (row:any, keys:string[]) => {
      const value = keys.map(key=>row?.[key]).find(item=>item!==undefined&&item!==null&&String(item).trim())
      return value === undefined || value === null ? '' : String(value).trim()
    }
    const rowCustomerKey = (row:any) => {
      const id = [row?.customer_id,row?.account_id,row?.client_id].map((value:any)=>Number(value||0)).find(Boolean)
      if(id) return `id:${id}`
      const name = [row?.customer_name,row?.account_name,row?.client_name,row?.name]
        .map((value:any)=>String(value||'').trim().toLowerCase())
        .find(Boolean)
      return name ? `name:${name}` : ''
    }
    const matchesCustomerFilter = (row:any, customerIds:Set<number>, customerNames:Set<string>) => {
      if(!hasCustomerDropdownFilter) return true
      const rowIds = [row.customer_id,row.account_id,row.client_id,row.id].map((id:any)=>Number(id||0)).filter(Boolean)
      const rowNames = [row.customer_name,row.account_name,row.client_name,row.name].map((name:any)=>String(name||'').trim().toLowerCase()).filter(Boolean)
      return rowIds.some(id=>customerIds.has(id)) || rowNames.some(name=>customerNames.has(name))
    }
    const loadHeaderMetrics = async() => {
      try{
        if(hasCustomerDropdownFilter && pipelineCustomerFilterCount===0){
          if(alive) setPipelineCardSummary({
            customers:0, customer_potential_value:0, lead_count:0, lead_value:0,
            opportunity_count:0, opportunity_value:0, converted_opportunity_count:0,
            tender_count:0, linked_opportunity_count:0, tender_value:0,
            wo_count:0, linked_tender_workorder_count:0, wo_value:0,
            pipeline_conversion:{customers:100,leads:0,opportunities:0,tenders:0,workorders:0},
            activity_breakdown:{'Phone Call':0,'Video Call':0,Email:0,'In Person Meet':0,Demo:0,'Follow Up':0,'Site Visit':0},
          })
          return
        }

        const baseParams:any = {
          period: requestPeriod,
          view_type: requestViewType,
          year: viewYear,
          date_from: dateRange.dateFrom || undefined,
          date_to: dateRange.dateTo || undefined,
        }
        if(selectedUid) baseParams.user_id = selectedUid
        else if(pipelineScopeMemberIdsKey) baseParams.member_ids = pipelineScopeMemberIdsKey
        if(pipelineCustomerFilterIdsKey) baseParams.customer_ids = pipelineCustomerFilterIdsKey

        const recordRequest = (kind:string) => api.get('/kam/pipeline-records', { params: {...baseParams, kind} })
          .then(res=>Array.isArray(res.data) ? res.data : [])
          .catch(()=>[])
        const activityParams:any = { per_page: 5000, date_from: dateRange.dateFrom, date_to: dateRange.dateTo }
        if(selectedUid) activityParams.user_id = selectedUid
        const activityRequest = api.get('/kam/activities', { params: activityParams })
          .then(res=>Array.isArray(res.data) ? res.data : [])
          .catch(()=>[])

        const [customerRaw, leadRaw, opportunityRaw, tenderRaw, workOrderRaw, activityRaw] = await Promise.all([
          recordRequest('customers'),
          recordRequest('leads'),
          recordRequest('opportunities'),
          recordRequest('tenders'),
          recordRequest('workorders'),
          activityRequest,
        ])
        if(!alive) return

        const customerIds = new Set(pipelineCustomerFilterIds)
        const customerNames = new Set(
          (pipelineCustomerFilterNamesKey ? pipelineCustomerFilterNamesKey.split('|') : [])
            .map(name=>name.trim())
            .filter(Boolean)
        )
        const groupMemberNames = new Set(
          (selectedGroupMemberNamesKey ? selectedGroupMemberNamesKey.split('|') : [])
            .map(name=>name.trim())
            .filter(Boolean)
        )
        const groupScopedActivities = !selectedUid && selectedGroupKey && groupMemberNames.size>0
          ? activityRaw.filter((activity:any)=>[
              activity.user_name,
              activity.assigned_to_name,
              activity.owner_name,
              activity.created_by_name,
            ].filter(Boolean).some((name:any)=>groupMemberNames.has(String(name).toLowerCase())))
          : activityRaw
        const activityRows = groupScopedActivities.filter((activity:any)=>matchesCustomerFilter(activity,customerIds,customerNames))

        const customerRows = dedupeBy(customerRaw.filter((row:any)=>matchesCustomerFilter(row,customerIds,customerNames)),['customer_id','id','customer_name','name'])
        const leadRows = dedupeBy(
          leadRaw.filter((row:any)=>!isDirectOpportunity(row)&&matchesCustomerFilter(row,customerIds,customerNames)),
          ['id','lead_id','lead_ref_id'],
        )
        const opportunityRows = dedupeBy(
          opportunityRaw.filter((row:any)=>isOpportunityRow(row)&&matchesCustomerFilter(row,customerIds,customerNames)),
          ['id','lead_id','opportunity_ref_id','lead_ref_id'],
        )
        const tenderRows = dedupeBy(tenderRaw.filter((row:any)=>matchesCustomerFilter(row,customerIds,customerNames)),['id','tender_id','portal_ref_number','tender_num'])
        const workOrderRows = dedupeBy(workOrderRaw.filter((row:any)=>matchesCustomerFilter(row,customerIds,customerNames)),['id','work_order_id','wrk_order_id','po_num'])
        const convertedOpportunityRows = leadRows.filter((row:any)=>isOpportunityRow(row) && !isDirectOpportunity(row))
        const opportunityIds = new Set(opportunityRows.map((row:any)=>rowRecordId(row,['id','lead_id','opportunity_id','opportunity_ref_id','lead_ref_id'])).filter(Boolean))
        const linkedOpportunityTenderRows = tenderRows.filter((row:any)=>{
          const leadId = rowRecordId(row,['lead_id','opportunity_id','lead_ref_id','opportunity_ref_id'])
          return leadId && opportunityIds.has(leadId)
        })
        const tenderIds = new Set(tenderRows.map((row:any)=>rowRecordId(row,['id','tender_id','portal_ref_number','tender_num'])).filter(Boolean))
        const linkedTenderWorkOrderRows = workOrderRows.filter((row:any)=>{
          const tenderId = rowRecordId(row,['tender_id','tender_ref_id','portal_ref_number','tender_num'])
          return tenderId && tenderIds.has(tenderId)
        })

        const activityCounts = ['Phone Call','Video Call','Email','In Person Meet','Demo','Follow Up','Site Visit'].reduce((acc:Record<string,number>,type)=>{
          acc[type]=0
          return acc
        },{})
        activityRows.forEach((activity:any)=>{
          const type = normalizedActivityType(activity)
          if(activityCounts[type]!==undefined) activityCounts[type]+=1
        })

        const customers = customerRows.length
        const leads = leadRows.length
        const customersWithLeads = new Set(leadRows.map((row:any)=>rowCustomerKey(row)).filter(Boolean)).size
        const opportunities = opportunityRows.length
        const convertedOpportunities = convertedOpportunityRows.length
        const tenders = tenderRows.length
        const linkedOpportunityTenders = linkedOpportunityTenderRows.length
        const workorders = workOrderRows.length
        const linkedTenderWorkorders = linkedTenderWorkOrderRows.length
        setPipelineCardSummary({
          customers,
          customer_potential_value: customerRows.reduce((sum:number,row:any)=>sum+portfolioValue(row),0),
          total_activities: activityRows.length,
          completed_activities: activityRows.filter((activity:any)=>activity.status==='Completed').length,
          pending_activities: activityRows.filter((activity:any)=>['Planned','In Progress'].includes(activity.status||'')).length,
          lead_count: leads,
          customer_to_lead_count: customersWithLeads,
          lead_value: sumRows(leadRows,['est_value','lead_value','value']),
          opportunity_count: opportunities,
          opportunity_value: sumRows(opportunityRows,['est_value','lead_value','opportunity_value','value']),
          converted_opportunity_count: convertedOpportunities,
          tender_count: tenders,
          linked_opportunity_count: linkedOpportunityTenders,
          tender_value: sumRows(tenderRows,['est_value','bid_amount','tender_value','value']),
          wo_count: workorders,
          linked_tender_workorder_count: linkedTenderWorkorders,
          wo_value: sumRows(workOrderRows,['wo_value','po_value','bid_amount','order_value','value']),
          pipeline_conversion: {
            customers:100,
            leads:pct(customersWithLeads,customers),
            opportunities:pct(convertedOpportunities,leads),
            tenders:pct(linkedOpportunityTenders,opportunities),
            workorders:pct(linkedTenderWorkorders,tenders),
          },
          activity_breakdown: activityCounts,
        })
      }catch{
        if(alive) setPipelineCardSummary(null)
      }
    }
    loadHeaderMetrics()
    return ()=>{alive=false}
  },[
    requestPeriod,
    requestViewType,
    viewYear,
    dateRange.dateFrom,
    dateRange.dateTo,
    selectedUid,
    selectedGroupKey,
    selectedGroupMemberNamesKey,
    pipelineScopeMemberIdsKey,
    hasCustomerDropdownFilter,
    pipelineCustomerFilterIdsKey,
    pipelineCustomerFilterNamesKey,
    pipelineCustomerFilterCount,
  ])

  const dedupePanelRows = (rows:any[], keys:string[]) => {
    const map = new Map<string,any>()
    rows.forEach((row:any)=>{
      const key = keys.map(k=>row?.[k]).find(v=>v!==undefined&&v!==null&&String(v).trim())
      const fallback = row?.id ?? row?.customer_id ?? row?.name ?? row?.customer_name
      const finalKey = String(key ?? fallback ?? '').trim()
      if(finalKey && !map.has(finalKey)) map.set(finalKey,row)
    })
    return Array.from(map.values())
  }

  const openGroupLeadPanel = async (groupName:string, members:any[] = [], mode:'leads'|'opportunities' = 'leads') => {
    const isOpportunityMode = mode === 'opportunities'
    setPanelMemberName(groupName || 'Group')
    setPanelLeadLabel(isOpportunityMode ? 'Opportunities' : 'Leads')
    setPanelLeads([])
    setLeadPanel(true)
    setPanelLoading(true)
    try {
      const leads = await loadPipelineRecords(isOpportunityMode ? 'opportunities' : 'leads', undefined, members)
      setPanelLeads(dedupePanelRows(leads,['id','lead_id','lead_ref_id','opportunity_ref_id']))
    } catch {
      showError(isOpportunityMode ? 'Failed to load opportunities' : 'Failed to load leads')
    } finally {
      setPanelLoading(false)
    }
  }

  const openGroupTenderPanel = async (groupName:string, members:any[] = []) => {
    setPanelMemberName(groupName || 'Group')
    setPanelTenders([])
    setTenderPanel(true)
    setPanelLoading(true)
    try {
      const tenders = await loadPipelineRecords('tenders', undefined, members)
      setPanelTenders(dedupePanelRows(tenders,['id','tender_id','portal_ref_number']))
    } catch {
      showError('Failed to load tenders')
    } finally {
      setPanelLoading(false)
    }
  }

  const openGroupWorkOrderPanel = async (groupName:string, members:any[] = []) => {
    setPanelMemberName(groupName || 'Group')
    setPanelWorkOrders([])
    setWorkOrderPanel(true)
    setPanelLoading(true)
    try {
      const items = await loadPipelineRecords('workorders', undefined, members)
      setPanelWorkOrders(dedupePanelRows(items,['id','work_order_id','wrk_order_id','po_num']))
    } catch {
      showError('Failed to load work orders')
    } finally {
      setPanelLoading(false)
    }
  }

  const openGroupCustomerPanel = async (groupName:string, members:any[] = []) => {
    const groupMembers = Array.isArray(members) ? members : []
    setPanelMemberName(groupName || 'Group')
    setPanelCustomers([])
    setPanelBusinessRecords(emptyCustomerBusinessRecords())
    setPanelCategoryFilter('all')
    setPanelMemberSalesTarget(groupMembers.reduce((sum:number,m:any)=>sum+Number(m.sales_target||0),0))
    setPanelMemberWonValue(groupMembers.reduce((sum:number,m:any)=>sum+Number(m.wo_value||m.won_tender_value||0),0))
    setPanelMemberLeadValue(groupMembers.reduce((sum:number,m:any)=>sum+Number(m.lead_value||0),0))
    setPanelMemberTenderValue(groupMembers.reduce((sum:number,m:any)=>sum+Number(m.tender_value||0),0))
    setCustomerPanel(true)
    setPanelLoading(true)

    const dedupeRows = (rows:any[]) => {
      const map = new Map<string,any>()
      rows.forEach((row:any)=>{
        const key = String(row.customer_id ?? row.id ?? row.customer_name ?? row.name ?? '').trim()
        if(key && !map.has(key)) map.set(key,row)
      })
      return Array.from(map.values()).sort((a:any,b:any)=>String(a.customer_name||a.name||'').localeCompare(String(b.customer_name||b.name||'')))
    }

    try {
      const rows = await loadPipelineRecords('customers', undefined, groupMembers)
      const customerRows = dedupeRows(rows)
      setPanelCustomers(customerRows)
      setPanelBusinessRecords(await loadPanelBusinessRecords(customerRows, undefined, groupMembers))
    } catch {
      showError(`Failed to load group ${customerLabelLower}`)
      setPanelCustomers([])
      setPanelBusinessRecords(emptyCustomerBusinessRecords())
    } finally {
      setPanelLoading(false)
    }
  }

  const localCustomerSummary = useMemo(()=>{
    const customers = filteredCusts.length
    const customersWithLeads = filteredCusts.filter((c:any)=>Number(c.lead_count || 0)>0 || Number(c.lead_value || 0)>0).length
    const leadCount = filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.lead_count || 0),0)
    const opportunityCount = filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.opportunity_count || 0),0)
    const hasConvertedOpportunityCounts = filteredCusts.some((c:any)=>c.converted_opportunity_count !== undefined && c.converted_opportunity_count !== null)
    const convertedOpportunityCount = hasConvertedOpportunityCounts
      ? filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.converted_opportunity_count || 0),0)
      : opportunityCount
    const tenderCount = filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.tender_count || 0),0)
    const workOrderCount = filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.wo_count || c.won_count || 0),0)
    const hasLinkedOpportunityCounts = filteredCusts.some((c:any)=>c.linked_opportunity_count !== undefined && c.linked_opportunity_count !== null)
    const linkedOpportunityCount = hasLinkedOpportunityCounts
      ? filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.linked_opportunity_count || 0),0)
      : tenderCount
    const hasLinkedTenderWorkOrderCounts = filteredCusts.some((c:any)=>c.linked_tender_workorder_count !== undefined && c.linked_tender_workorder_count !== null)
    const linkedTenderWorkOrderCount = hasLinkedTenderWorkOrderCounts
      ? filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.linked_tender_workorder_count || 0),0)
      : workOrderCount
    return {
    customers,
    customer_potential_value: filteredCusts.reduce((sum:number,c:any)=>sum+portfolioValue(c),0),
    total_activities: filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.total_activities ?? c.activity_count ?? 0),0),
    completed_activities: filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.completed ?? c.completed_activities ?? 0),0),
    pending_activities: filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.pending ?? c.pending_activities ?? 0),0),
    lead_count: leadCount,
    customer_to_lead_count: customersWithLeads,
    lead_value: filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.lead_value || 0),0),
    opportunity_count: opportunityCount,
    opportunity_value: filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.opportunity_value || 0),0),
    converted_opportunity_count: convertedOpportunityCount,
    tender_count: tenderCount,
    linked_opportunity_count: linkedOpportunityCount,
    tender_value: filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.tender_value || 0),0),
    wo_count: workOrderCount,
    linked_tender_workorder_count: linkedTenderWorkOrderCount,
    wo_value: filteredCusts.reduce((sum:number,c:any)=>sum+Number(c.wo_value ?? c.won_value ?? c.won_tender_value ?? 0),0),
    pipeline_conversion: {
      customers: 100,
      leads: pct(customersWithLeads, customers),
      opportunities: pct(convertedOpportunityCount, leadCount),
      tenders: pct(linkedOpportunityCount, opportunityCount),
      workorders: pct(linkedTenderWorkOrderCount, tenderCount),
    },
  }},[filteredCusts])
  const summarizeSalesRows = (rows:any[]) => {
    const customers = rows.reduce((sum:number,m:any)=>sum+Number(m.own_customers ?? m.customers ?? 0),0)
    const hasCustomerPotentialValue = rows.some((m:any)=>m.customer_potential_value !== undefined || m.potential !== undefined)
    const leadCount = rows.reduce((sum:number,m:any)=>sum+Number(m.lead_count || 0),0)
    const customersWithLeads = rows.some((m:any)=>m.customer_to_lead_count !== undefined && m.customer_to_lead_count !== null)
      ? rows.reduce((sum:number,m:any)=>sum+Number(m.customer_to_lead_count || 0),0)
      : rows.reduce((sum:number,m:any)=>sum+(Number(m.lead_count || 0)>0 || Number(m.lead_value || 0)>0 ? 1 : 0),0)
    const opportunityCount = rows.reduce((sum:number,m:any)=>sum+Number(m.opportunity_count || 0),0)
    const hasConvertedOpportunityCounts = rows.some((m:any)=>m.converted_opportunity_count !== undefined && m.converted_opportunity_count !== null)
    const convertedOpportunityCount = hasConvertedOpportunityCounts
      ? rows.reduce((sum:number,m:any)=>sum+Number(m.converted_opportunity_count || 0),0)
      : opportunityCount
    const tenderCount = rows.reduce((sum:number,m:any)=>sum+Number(m.tender_count || 0),0)
    const workOrderCount = rows.reduce((sum:number,m:any)=>sum+Number(m.wo_count || 0),0)
    const hasLinkedOpportunityCounts = rows.some((m:any)=>m.linked_opportunity_count !== undefined && m.linked_opportunity_count !== null)
    const linkedOpportunityCount = hasLinkedOpportunityCounts
      ? rows.reduce((sum:number,m:any)=>sum+Number(m.linked_opportunity_count || 0),0)
      : tenderCount
    const hasLinkedTenderWorkOrderCounts = rows.some((m:any)=>m.linked_tender_workorder_count !== undefined && m.linked_tender_workorder_count !== null)
    const linkedTenderWorkOrderCount = hasLinkedTenderWorkOrderCounts
      ? rows.reduce((sum:number,m:any)=>sum+Number(m.linked_tender_workorder_count || 0),0)
      : workOrderCount
    return {
      customers,
      customer_potential_value: hasCustomerPotentialValue
        ? rows.reduce((sum:number,m:any)=>sum+Number(m.customer_potential_value ?? m.potential ?? 0),0)
        : rows.reduce((sum:number,m:any)=>sum+Number(m.lead_value || 0)+Number(m.tender_value || 0),0),
      total_activities: rows.reduce((sum:number,m:any)=>sum+Number(m.total || 0),0),
      completed_activities: rows.reduce((sum:number,m:any)=>sum+Number(m.completed || 0),0),
      pending_activities: rows.reduce((sum:number,m:any)=>sum+Math.max(0,Number(m.total || 0)-Number(m.completed || 0)),0),
      lead_count: leadCount,
      customer_to_lead_count: customersWithLeads,
      lead_value: rows.reduce((sum:number,m:any)=>sum+Number(m.lead_value || 0),0),
      opportunity_count: opportunityCount,
      opportunity_value: rows.reduce((sum:number,m:any)=>sum+Number(m.opportunity_value || 0),0),
      converted_opportunity_count: convertedOpportunityCount,
      tender_count: tenderCount,
      tender_value: rows.reduce((sum:number,m:any)=>sum+Number(m.tender_value || 0),0),
      linked_opportunity_count: linkedOpportunityCount,
      wo_count: workOrderCount,
      linked_tender_workorder_count: linkedTenderWorkOrderCount,
      wo_value: rows.reduce((sum:number,m:any)=>sum+Number(m.wo_value || m.won_tender_value || 0),0),
      sales_target: rows.reduce((sum:number,m:any)=>sum+Number(m.sales_target || 0),0),
      pipeline_conversion: {
        customers: 100,
        leads: pct(customersWithLeads, customers),
        opportunities: pct(convertedOpportunityCount, leadCount),
        tenders: pct(linkedOpportunityCount, opportunityCount),
        workorders: pct(linkedTenderWorkOrderCount, tenderCount),
      },
    }
  }
  const localTeamSummary = useMemo(()=>summarizeSalesRows(filteredSalesTeamRows),[filteredSalesTeamRows])
  const s = selectedGroupKey && !selectedUid && !hasCustomerDropdownFilter
    ? {...(summary||{}),...localTeamSummary}
    : hasCustomerDropdownFilter || selectedGroupKey
      ? {...(summary||{}),...localCustomerSummary,sales_target: selectedGroupKey&&!selectedUid ? localTeamSummary.sales_target : summary?.sales_target}
      : summary||{}
  const flowS = pipelineCardSummary ? {...s,...pipelineCardSummary,sales_target:s.sales_target} : s
  const selectedMemberName = selectedUid ? visibleTeamMembers.find((u:any)=>Number(u.id)===Number(selectedUid))?.full_name : ''
  const targetCardRows = selectedUid
    ? filteredSalesTeamRows.filter((member:any)=>Number(member.user_id)===Number(selectedUid))
    : filteredSalesTeamRows
  const hasTargetCardRows = targetCardRows.length>0
  const useTargetBaselineFallback = !selectedUid&&!selectedGroupKey&&salesTeamRows.length===0
  const baselineTargetRevenue = hasTargetCardRows
    ? targetCardRows.reduce((sum:number,member:any)=>sum+Number(member.wo_value||member.won_tender_value||0),0)
    : useTargetBaselineFallback ? Number(targetBaseline?.achieved_value || 0) : 0
  const baselineTargetValue = hasTargetCardRows
    ? targetCardRows.reduce((sum:number,member:any)=>sum+targetCardTargetValue(member),0)
    : useTargetBaselineFallback ? Number(targetBaseline?.sales_target || 0) : 0
  const baselineTargetRemaining = Math.max(0,baselineTargetValue-baselineTargetRevenue)
  const baselineTargetPct = baselineTargetValue>0 ? pct(baselineTargetRevenue, baselineTargetValue) : Number(targetBaseline?.achievement_pct || 0)
  const baselineTargetStatus = baselineTargetValue>0
    ? (baselineTargetPct>=100 ? 'Target achieved' : `${fmt(baselineTargetRemaining)} remaining`)
    : 'Set target'
  const targetCardSelectedMember=targetCardMemberOptions.find((member:any)=>Number(member.user_id)===Number(targetCardMemberId))
  const targetCardTitle=selectedUid
    ? 'Member Revenue Target'
    : selectedGroupKey
      ? 'Group Revenue Target'
      : 'Team Revenue Target'
  const reportPeriodLabel = rangeMode === 'month'
    ? new Date(`${period}-01T00:00:00`).toLocaleDateString('en-IN',{month:'long',year:'numeric'}).replace(' ', ', ')
    : rangeMode === 'year'
      ? String(viewYear)
      : dateLabel
  const handlePeriodMonthChange = (nextPeriod:string) => {
    if(!nextPeriod) return
    setRangeMode('month')
    setIsYearly(false)
    setPeriod(nextPeriod)
    const nextYear = Number(nextPeriod.slice(0,4))
    if(nextYear) setViewYear(nextYear)
  }
  const openDatePicker = (input:HTMLInputElement|null) => {
    if(!input) return
    if(typeof input.showPicker === 'function') input.showPicker()
    else input.focus()
  }
  const openPeriodMonthPicker = () => openDatePicker(periodMonthInputRef.current)
  const handleWeekStartChange = (nextDate:string) => {
    if(!nextDate) return
    setRangeMode('week')
    setIsYearly(false)
    setWeekStart(nextDate)
  }
  const handleCustomFromChange = (nextDate:string) => {
    if(!nextDate) return
    setRangeMode('range')
    setIsYearly(false)
    setCustomFrom(nextDate)
    if(customTo && nextDate>customTo) setCustomTo(nextDate)
  }
  const handleCustomToChange = (nextDate:string) => {
    if(!nextDate) return
    setRangeMode('range')
    setIsYearly(false)
    setCustomTo(nextDate)
    if(customFrom && nextDate<customFrom) setCustomFrom(nextDate)
  }
  const workedAccounts = filteredCusts.filter((c:any) =>
    Number(c.activity_count||0)>0 ||
    Number(c.lead_count||0)>0 ||
    Number(c.tender_count||0)>0 ||
    Number(c.won_count||0)>0 ||
    Number(c.won_value||0)>0
  ).length
  const activeWithPipeline = filteredCusts.filter((c:any) =>
    Number(c.lead_count||0)>0 ||
    Number(c.tender_count||0)>0 ||
    Number(c.lead_value||0)>0 ||
    Number(c.tender_value||0)>0
  ).length
  const accountBase = Number(s.customers || filteredCusts.length || 0)
  const accountCoveragePct = accountBase>0 ? Math.round((workedAccounts/accountBase)*100) : 0
  const untappedAccounts = Math.max(0, accountBase - workedAccounts)
  const opportunityCount = Number(flowS.opportunity_count || 0)
  const opportunityValue = Number(flowS.opportunity_value || 0)
  const flowPct = (current:number, previous:number) => previous>0 ? Math.min(100,Math.round((current/previous)*100)) : 0
  const pipelineConversion = flowS.pipeline_conversion || {}
  const conversionForArrow = (nextStageKey:string, current:number, previous:number) => {
    const scopedValue = pipelineConversion?.[nextStageKey]
    if(scopedValue !== undefined && scopedValue !== null) return Number(scopedValue || 0)
    return flowPct(current, previous)
  }
  const activityBreakdownSourceRows = hasCustomerDropdownFilter
    ? filteredCusts
    : selectedUid
      ? filteredSalesTeamRows.filter((member:any)=>Number(member.user_id)===Number(selectedUid))
      : filteredSalesTeamRows
  const activityBreakdown = useMemo(()=>{
    if(pipelineCardSummary?.activity_breakdown) return pipelineCardSummary.activity_breakdown as Record<string,number>
    const countFor = (row:any,type:string) => {
      if(row?.activity_types?.[type]!==undefined) return Number(row.activity_types[type]||0)
      if(type==='Phone Call') return Number(row.calls||0)
      if(type==='Video Call') return Number(row.video_calls||0)
      if(type==='Email') return Number(row.emails||0)
      if(type==='In Person Meet') return Number(row.meetings||0)
      if(type==='Demo') return Number(row.demos||0)
      if(type==='Follow Up') return Number(row.follow_ups||0)
      if(type==='Site Visit') return Number(row.site_visits||0)
      return 0
    }
    const source = activityBreakdownSourceRows.length>0 ? activityBreakdownSourceRows : []
    const fromRows = source.reduce((acc:Record<string,number>,row:any)=>{
      ;['Phone Call','Video Call','Email','In Person Meet','Demo','Follow Up','Site Visit'].forEach(type=>{
        acc[type]=(acc[type]||0)+countFor(row,type)
      })
      return acc
    },{})
    if(source.length>0 || hasCustomerDropdownFilter || selectedGroupKey || selectedUid) return fromRows
    return (perf?.activity_breakdown||{}) as Record<string,number>
  },[pipelineCardSummary,activityBreakdownSourceRows,hasCustomerDropdownFilter,selectedGroupKey,selectedUid,perf?.activity_breakdown])
  const pipelineStages = [
    {
      key:'customers',
      label:customerLabel,
      count:Number(flowS.customers||0),
      value:Number(flowS.customer_potential_value||0),
      icon:<Building2 size={15}/>,
      tone:'text-slate-950',
      accent:'bg-slate-600',
      iconBg:'bg-slate-50 text-slate-500',
      border:'border-slate-200',
      onClick:()=>openCustomerPanel(selectedUid||undefined, selectedMemberName, false),
    },
    {
      key:'leads',
      label:leadLabel,
      count:Number(flowS.lead_count||0),
      value:Number(flowS.lead_value||0),
      icon:<TrendingUp size={15}/>,
      tone:'text-slate-950',
      accent:'bg-violet-500',
      iconBg:'bg-slate-50 text-slate-500',
      border:'border-slate-200',
      onClick:()=>openLeadPanel(undefined, undefined, 'leads'),
    },
    {
      key:'opportunities',
      label:opportunityLabel,
      count:opportunityCount,
      value:opportunityValue,
      icon:<Star size={15}/>,
      tone:'text-slate-950',
      accent:'bg-sky-500',
      iconBg:'bg-slate-50 text-slate-500',
      border:'border-slate-200',
      onClick:()=>openLeadPanel(undefined, undefined, 'opportunities'),
    },
    {
      key:'tenders',
      label:tenderLabel,
      count:Number(flowS.tender_count||0),
      value:Number(flowS.tender_value||0),
      icon:<FileText size={15}/>,
      tone:'text-slate-950',
      accent:'bg-orange-500',
      iconBg:'bg-slate-50 text-slate-500',
      border:'border-slate-200',
      onClick:()=>openTenderPanel(),
    },
    {
      key:'workorders',
      label:workOrderLabel,
      count:Number(flowS.wo_count||0),
      value:Number(flowS.wo_value||0),
      icon:<Package size={15}/>,
      tone:'text-slate-950',
      accent:'bg-emerald-500',
      iconBg:'bg-slate-50 text-slate-500',
      border:'border-slate-200',
      onClick:()=>openWorkOrderPanel(selectedUid||undefined),
    },
  ]
  const showTargetCard = canSetTgt || !canViewTeam || targetBaseline !== null
  const buildPortfolioRows = (keys:string[], limit?:number) => {
    const map = new Map<string,{label:string;count:number;value:number}>()
    filteredCusts.forEach((c:any)=>{
      const label = portfolioLabel(c, keys)
      const current = map.get(label) || {label,count:0,value:0}
      current.count += 1
      current.value += portfolioValue(c)
      map.set(label,current)
    })
    const rows = Array.from(map.values()).sort((a,b)=>(b.value-a.value)||(b.count-a.count)||a.label.localeCompare(b.label))
    const sliced = typeof limit==='number' ? rows.slice(0,limit) : rows
    const max = Math.max(1,...sliced.map(r=>r.value),...sliced.map(r=>r.count))
    return sliced.map(r=>({...r,pct:Math.max(4,Math.round(((r.value||r.count)/max)*100))}))
  }
  const normalizePortfolioRows = (rows:any[]=[], limit?:number) => {
    const normalized = (Array.isArray(rows)?rows:[])
      .map((row:any)=>({
        label:String(row.label || row.name || 'Unassigned').trim() || 'Unassigned',
        count:Number(row.count ?? row.value_count ?? row.customers ?? 0),
        value:Number(row.value ?? row.revenue ?? row.amount ?? 0),
      }))
      .sort((a:any,b:any)=>(b.value-a.value)||(b.count-a.count)||a.label.localeCompare(b.label))
    const sliced = typeof limit==='number' ? normalized.slice(0,limit) : normalized
    const max = Math.max(1,...sliced.map((r:any)=>r.value),...sliced.map((r:any)=>r.count))
    return sliced.map((r:any)=>({...r,pct:Math.max(4,Math.round(((r.value||r.count)/max)*100))}))
  }
  const buildMasterSegmentPortfolioRows = (limit?: number) => {
    if (masterSegments.length === 0) return buildPortfolioRows(['vertical','customer_vertical','segment','industry'], limit)
    const map = new Map<string,{label:string;count:number;value:number}>()
    masterSegments.forEach(segment => {
      const key = segment.key.startsWith('segment:') ? segment.key.slice(8) : segment.key
      if (key && segment.label) map.set(key, { label: segment.label, count: 0, value: 0 })
    })
    filteredCusts.forEach((c:any) => {
      const parts = customerSegmentPartsForFilter(c)
      const current = map.get(parts.parentKey)
      if (!current) return
      current.count += 1
      current.value += portfolioValue(c)
    })
    const rows = Array.from(map.values())
    const sliced = typeof limit === 'number' ? rows.slice(0, limit) : rows
    const max = Math.max(1, ...sliced.map(r => r.value), ...sliced.map(r => r.count))
    return sliced.map(r => ({ ...r, pct: Math.max(4, Math.round(((r.value || r.count) / max) * 100)) }))
  }
  const buildMasterBusinessUnitPortfolioRows = (limit?: number) => {
    const unitLabels = Array.from(masterVerticalUnits.values()).flat()
    if (unitLabels.length === 0) return buildPortfolioRows(['business_unit','business_unit_name','business_vertical','business_vertical_name','group','assigned_group','industry'], limit)
    const map = new Map<string,{label:string;count:number;value:number}>()
    unitLabels.forEach(unit => {
      const key = portfolioKey(unit)
      if (key && !map.has(key)) map.set(key, { label: unit, count: 0, value: 0 })
    })
    filteredCusts.forEach((c:any) => {
      const unit = cleanPortfolioLabel(c.business_unit || c.business_unit_name)
      const current = map.get(portfolioKey(unit))
      if (!current) return
      current.count += 1
      current.value += portfolioValue(c)
    })
    const rows = Array.from(map.values())
    const sliced = typeof limit === 'number' ? rows.slice(0, limit) : rows
    const max = Math.max(1, ...sliced.map(r => r.value), ...sliced.map(r => r.count))
    return sliced.map(r => ({ ...r, pct: Math.max(4, Math.round(((r.value || r.count) / max) * 100)) }))
  }
  const backendPortfolioMix = (selectedGroupKey||hasCustomerDropdownFilter) ? null : s.portfolio_mix || null
  const portfolioSegmentRows = backendPortfolioMix
    ? normalizePortfolioRows(backendPortfolioMix.by_segment,5)
    : buildMasterSegmentPortfolioRows(5)
  const portfolioBusinessRows = backendPortfolioMix
    ? normalizePortfolioRows(backendPortfolioMix.by_business_unit,5)
    : buildMasterBusinessUnitPortfolioRows(5)
  const portfolioLocationRows = backendPortfolioMix
    ? normalizePortfolioRows(backendPortfolioMix.by_location)
    : buildPortfolioRows(['billing_city','city','location','billing_state','state'])
  const buildLocationRowsFromCustomers = (customers:any[]) => {
    const map = new Map<string,{label:string;count:number;value:number}>()
    customers.forEach((c:any)=>{
      const label = portfolioLabel(c, locationKeys)
      const key = normalizeLocationKey(label)
      const current = map.get(key) || {label,count:0,value:0}
      current.count += 1
      current.value += portfolioValue(c)
      map.set(key,current)
    })
    return Array.from(map.values()).sort((a,b)=>(b.count-a.count)||(b.value-a.value)||a.label.localeCompare(b.label))
  }
  const customerLocationMetricRows = hasCustomerDropdownFilter || selectedGroupKey || selectedUid
    ? filteredCusts
    : custActs
  const activityByLocation = new Map<string,{leadCount:number;tenderCount:number;opportunityCount:number;customers:any[]}>()
  customerLocationMetricRows.forEach((c:any)=>{
    const label = portfolioLabel(c, locationKeys)
    const key = normalizeLocationKey(label)
    const current = activityByLocation.get(key) || {leadCount:0,tenderCount:0,opportunityCount:0,customers:[]}
    current.leadCount += Number(c.lead_count || 0)
    current.tenderCount += Number(c.tender_count || 0)
    current.opportunityCount += Number(c.opportunity_count || c.opp_count || 0)
    current.customers.push(c)
    activityByLocation.set(key,current)
  })
  const locationBaseRows = backendPortfolioMix
    ? normalizePortfolioRows(backendPortfolioMix.by_location)
    : buildLocationRowsFromCustomers(allCustomerRows)
  const maxLocationCount = Math.max(1,...locationBaseRows.map((r:any)=>Number(r.count || 0)))
  const customerLocationRows = locationBaseRows.map((row:any, idx:number) => {
    const key = normalizeLocationKey(row.label)
    const activity = activityByLocation.get(key) || {leadCount:0,tenderCount:0,opportunityCount:0,customers:[]}
    const coord = resolveIndiaLocationCoord(row.label,key,idx)
    const count = Number(row.count || 0)
    const size = 22 + Math.round((count / maxLocationCount) * 54)
    return {
      ...row,
      key,
      count,
      leadCount: activity.leadCount,
      tenderCount: activity.tenderCount,
      opportunityCount: activity.opportunityCount,
      customers: activity.customers,
      lat: coord.lat,
      lng: coord.lng,
      size,
    }
  }) as CustomerLocationMapRow[]
  const mappedCustomerTotal = customerLocationRows.reduce((sum:number,row:any)=>sum + Number(row.count || 0), 0)
  const stateKeys = ['billing_state','state','customer_state','shipping_state','billing_state_name','state_name']
  const districtLocationKeys = ['district','billing_district','city_district','customer_district','billing_city','city','customer_city','location']
  const masterStateNameByKey = useMemo(() => {
    const map = new Map<string,string>()
    const addState = (label:any) => {
      const name = String(label || '').trim()
      if(!name) return
      const canonical = canonicalStateName(name)
      const display = canonical || name
      map.set(normalizeStateKey(name), display)
      map.set(normalizeStateKey(canonical), display)
    }
    ;(masterAllStates || []).forEach((state:any) => {
      addState(state?.name)
    })
    ;(masterStateDistricts || new Map<string,string[]>()).forEach((_, stateName) => addState(stateName))
    return map
  }, [masterAllStates, masterStateDistricts])
  const masterDistrictStateByKey = useMemo(() => {
    const map = new Map<string,string>()
    ;(masterStateDistricts || new Map<string,string[]>()).forEach((districts, stateName) => {
      const resolvedState = masterStateNameByKey.get(normalizeStateKey(stateName)) || canonicalStateName(String(stateName || ''))
      if(!resolvedState) return
      ;(districts || []).forEach((district) => {
        const key = normalizeLocationKey(district)
        if(key && key !== 'unassigned' && !map.has(key)) map.set(key, resolvedState)
      })
    })
    return map
  }, [masterStateDistricts, masterStateNameByKey])
  const canonicalMasterStateName = (label:string) => {
    const canonical = canonicalStateName(label)
    return masterStateNameByKey.get(normalizeStateKey(canonical)) || canonical
  }
  const stateAllowedByMasterLocation = (label:string) => {
    const canonical = canonicalStateName(label)
    if(!canonical || canonical === 'Unassigned') return ''
    if(masterStateNameByKey.size === 0) return canonical
    return masterStateNameByKey.get(normalizeStateKey(canonical)) || ''
  }
  const stateFromMasterLocation = (c:any) => {
    for(const key of districtLocationKeys){
      const raw = c?.[key]
      if(raw === undefined || raw === null || !String(raw).trim()) continue
      const state = masterDistrictStateByKey.get(normalizeLocationKey(raw))
      if(state) return state
    }
    return ''
  }
  const stateLabelForCustomer = (c:any) => {
    const explicit = portfolioLabel(c, stateKeys)
    if(explicit && explicit !== 'Unassigned') {
      const allowed = stateAllowedByMasterLocation(explicit)
      if(allowed) return allowed
    }
    const masterState = stateFromMasterLocation(c)
    if(masterState) return stateAllowedByMasterLocation(masterState)
    const inferred = inferStateNameFromLocation(portfolioLabel(c, locationKeys))
    return inferred ? (stateAllowedByMasterLocation(inferred) || 'Unassigned') : 'Unassigned'
  }
  const buildStateRowsFromCustomers = (customers:any[], metricCustomers:any[] = customers) => {
    const map = new Map<string,CustomerStateMapRow>()
    const metricNumber = (row:any, keys:string[]) => keys.reduce((value:number,key:string)=>value || Number(row?.[key] || 0),0)
    const mergeCustomerPipelineMetrics = (target:any, source:any) => {
      const fields = [
        ['lead_count'],
        ['lead_value'],
        ['opportunity_count','opp_count'],
        ['opportunity_value','opp_value'],
        ['tender_count'],
        ['tender_value'],
        ['work_order_count','wo_count','won_count'],
        ['work_order_value','wo_value','won_value','won_tender_value'],
      ]
      fields.forEach(keys => {
        const currentValue = metricNumber(target, keys)
        const sourceValue = metricNumber(source, keys)
        if(sourceValue > currentValue) {
          target[keys[0]] = sourceValue
          if(keys.includes('wo_count')) target.wo_count = sourceValue
          if(keys.includes('wo_value')) target.wo_value = sourceValue
        }
      })
    }
    const ensureStateRow = (label:string) => {
      const canonicalLabel = stateAllowedByMasterLocation(label)
      if(!canonicalLabel || canonicalLabel === 'Unassigned') return null
      const key = normalizeStateKey(canonicalLabel)
      const current = map.get(key) || {
        key,
        label:canonicalLabel,
        count:0,
        value:0,
        mappedCount:0,
        leadCount:0,
        tenderCount:0,
        opportunityCount:0,
        customers:[],
      }
      map.set(key,current)
      return current
    }
    ;(masterAllStates || []).forEach((state:any)=>{
      const label = String(state?.name || '').trim()
      ensureStateRow(label)
    })
    customers.forEach((c:any)=>{
      const label = stateLabelForCustomer(c)
      if(!label || label === 'Unassigned') return
      const current = ensureStateRow(label)
      if(!current) return
      current.count += 1
      current.value += portfolioValue(c)
      current.mappedCount = current.count
      current.customers.push(c)
      current.leadCount = Number(current.leadCount || 0) + Number(c.lead_count || 0)
      current.tenderCount = Number(current.tenderCount || 0) + Number(c.tender_count || 0)
      current.opportunityCount = Number(current.opportunityCount || 0) + Number(c.opportunity_count || c.opp_count || 0)
    })
    metricCustomers.forEach((c:any)=>{
      const label = stateLabelForCustomer(c)
      if(!label || label === 'Unassigned') return
      const current = ensureStateRow(label)
      if(!current) return
      const existing = current.customers.find((row:any)=>customerIdForRow(row) && customerIdForRow(row) === customerIdForRow(c))
      if(existing) {
        const leadDelta = Math.max(0, Number(c.lead_count || 0) - Number(existing.lead_count || 0))
        const tenderDelta = Math.max(0, Number(c.tender_count || 0) - Number(existing.tender_count || 0))
        const opportunityDelta = Math.max(0, Number(c.opportunity_count || c.opp_count || 0) - Number(existing.opportunity_count || existing.opp_count || 0))
        current.leadCount = Number(current.leadCount || 0) + leadDelta
        current.tenderCount = Number(current.tenderCount || 0) + tenderDelta
        current.opportunityCount = Number(current.opportunityCount || 0) + opportunityDelta
        mergeCustomerPipelineMetrics(existing, c)
      } else {
        current.customers.push(c)
        current.leadCount = Number(current.leadCount || 0) + Number(c.lead_count || 0)
        current.tenderCount = Number(current.tenderCount || 0) + Number(c.tender_count || 0)
        current.opportunityCount = Number(current.opportunityCount || 0) + Number(c.opportunity_count || c.opp_count || 0)
      }
    })
    return Array.from(map.values()).sort((a,b)=>(b.count-a.count)||(b.value-a.value)||a.label.localeCompare(b.label))
  }
  const customerStateRows = buildStateRowsFromCustomers(allCustomerRows, filteredCusts)
  const hasMappedStateRows = customerStateRows.some(row => Number(row.count || 0) > 0)
  if(!hasMappedStateRows && customerLocationRows.length) {
    const fallbackStateMap = new Map<string,CustomerStateMapRow>()
    customerStateRows.forEach(row=>fallbackStateMap.set(row.key,{...row,customers:[...(row.customers || [])]}))
    customerLocationRows.forEach((row:any)=>{
      const label = inferStateNameFromLocation(row.label)
      const allowedLabel = label ? stateAllowedByMasterLocation(label) : ''
      if(!allowedLabel) return
      const key = normalizeStateKey(allowedLabel)
      const current = fallbackStateMap.get(key) || {
        key,
        label:allowedLabel,
        count:0,
        value:0,
        mappedCount:0,
        leadCount:0,
        tenderCount:0,
        opportunityCount:0,
        customers:[],
      }
      current.count += Number(row.count || 0)
      current.value += Number(row.value || 0)
      current.mappedCount = Number(current.mappedCount || 0) + Number(row.count || 0)
      current.leadCount = Number(current.leadCount || 0) + Number(row.leadCount || 0)
      current.tenderCount = Number(current.tenderCount || 0) + Number(row.tenderCount || 0)
      current.opportunityCount = Number(current.opportunityCount || 0) + Number(row.opportunityCount || 0)
      current.customers.push(...(row.customers || []))
      fallbackStateMap.set(key,current)
    })
    customerStateRows.splice(0,customerStateRows.length,...Array.from(fallbackStateMap.values()).sort((a,b)=>(b.count-a.count)||(b.value-a.value)||a.label.localeCompare(b.label)))
  }
  const customerStateMap = Object.fromEntries(customerStateRows.map(row => [row.key,row])) as Record<string,CustomerStateMapRow>
  const mappedStateCustomerTotal = customerStateRows.reduce((sum,row)=>sum + Number(row.count || 0), 0)
  const allCustomerTotal = allCustomerRows.length || mappedStateCustomerTotal
  const setLocationCustomerPanelRows = (locationLabel:string, items:any[]) => {
    setPanelMemberName(`${locationLabel} ${customerLabel}`)
    setPanelCustomers(items)
    setPanelBusinessRecords(emptyCustomerBusinessRecords())
    setPanelCategoryFilter('all')
    setPanelMemberSalesTarget(0)
    setPanelMemberWonValue(items.reduce((sum:number,c:any)=>sum + Number(c.wo_value ?? c.won_value ?? c.won_tender_value ?? 0),0))
    setPanelMemberLeadValue(items.reduce((sum:number,c:any)=>sum + Number(c.lead_value || 0),0))
    setPanelMemberTenderValue(items.reduce((sum:number,c:any)=>sum + Number(c.tender_value || 0),0))
    if(items.length){
      loadPanelBusinessRecords(items, selectedUid ? Number(selectedUid) : undefined)
        .then(setPanelBusinessRecords)
        .catch(()=>setPanelBusinessRecords(emptyCustomerBusinessRecords()))
    }
  }
  const openLocationCustomers = async (locationLabel:string) => {
    const key = normalizeLocationKey(locationLabel)
    const fallbackRows = activityByLocation.get(key)?.customers || []
    setCustomerPanel(true)
    setPanelLoading(true)
    setLocationCustomerPanelRows(locationLabel, [])
    try {
      const params: any = { period: requestPeriod, view_type: requestViewType, year: viewYear, date_from: dateRange.dateFrom, date_to: dateRange.dateTo }
      if(selectedUid) params.user_id = selectedUid
      const r = await api.get('/kam/plan-customers', { params })
      const items = Array.isArray(r.data) ? r.data : []
      const matched = items.filter((c:any)=>normalizeLocationKey(portfolioLabel(c, locationKeys)) === key)
      setLocationCustomerPanelRows(locationLabel, matched.length ? matched : fallbackRows)
    } catch {
      if(fallbackRows.length) setLocationCustomerPanelRows(locationLabel, fallbackRows)
      else showError(`Failed to load ${customerLabelLower}`)
    } finally {
      setPanelLoading(false)
    }
  }
  const openStateCustomers = (stateName:string) => {
    const row = customerStateMap[normalizeStateKey(stateName)]
    if(!row) return
    openStateCustomersList(row.label, row.customers || [])
  }
  const openStateCustomersList = (label: string, customers: any[]) => {
    setStateDetailPopup(null)
    setCustomerPanel(true)
    setPanelLoading(false)
    setLocationCustomerPanelRows(label, customers)
  }

  const groupedSalesTeamRows = useMemo(() => {
    const source = selectedUid ? filteredSalesTeamRows.filter((m:any)=>m.user_id===selectedUid) : filteredSalesTeamRows
    const sourceByUserId = new Map(source.map((member:any) => [Number(member.user_id), member]))

    // Build the cards exclusively from Masters → Groups (the Org Tree).  Do
    // not fall back to users.group_id, which can contain old numeric groups.
    return masterGroups.map((masterGroup:any, index:number) => {
      const memberIds = new Set(
        (Array.isArray(masterGroup.members) ? masterGroup.members : [])
          .map((member:any) => Number(member.user_id || member.id || 0))
          .filter(Boolean),
      )
      const members = Array.from(memberIds)
        .map((userId:number) => sourceByUserId.get(userId))
        .filter(Boolean)
      const groupId = String(masterGroup.id || '')
      const groupName = String(masterGroup.group_name || masterGroup.name || '').trim()
      const gradientIndex = Number(masterGroup.idx ?? index)

      return {
        key: groupId,
        name: groupName,
        gradient: KAM_GROUP_GRADIENTS[Math.abs(gradientIndex) % KAM_GROUP_GRADIENTS.length],
        index: gradientIndex,
        managerName: masterGroup.manager_name || '',
        managerId: masterGroup.manager_id || null,
        members,
        customers: members.reduce((sum:number, member:any) => sum + Number(member.own_customers ?? member.customers ?? 0), 0),
        total: members.reduce((sum:number, member:any) => sum + Number(member.total || 0), 0),
        completed: members.reduce((sum:number, member:any) => sum + Number(member.completed || 0), 0),
        leadCount: members.reduce((sum:number, member:any) => sum + Number(member.lead_count || 0), 0),
        leadValue: members.reduce((sum:number, member:any) => sum + Number(member.lead_value || 0), 0),
        tenderCount: members.reduce((sum:number, member:any) => sum + Number(member.tender_count || 0), 0),
        tenderValue: members.reduce((sum:number, member:any) => sum + Number(member.tender_value || 0), 0),
        potential: members.reduce((sum:number, member:any) => sum + Number(member.customer_potential_value ?? member.potential ?? 0), 0),
        revenue: members.reduce((sum:number, member:any) => sum + Number(member.wo_value || 0), 0),
        salesTarget: members.reduce((sum:number, member:any) => sum + Number(member.sales_target || 0), 0),
      }
    }).filter((group:any) => group.name && group.members.length > 0)
      .sort((a:any,b:any) => a.index - b.index || a.name.localeCompare(b.name))
  },[filteredSalesTeamRows, selectedUid, masterGroups])

  const renderNormalMemberRow = (m:any, embedded=false) => {
    const targetRevenue=m.wo_value||m.won_tender_value||0
    const salesPct2=m.sales_target>0?pct(targetRevenue,m.sales_target):0
    const totalCusts=m.own_customers??m.customers??0
    const custPotential=(m.lead_value||0)+(m.tender_value||0)
    const opportunityCount = Number(m.opportunity_count || 0)
    const opportunityValue = Number(m.opportunity_value || 0)
    const activityChips = [
      {icon:<PhoneCall size={11}/>,val:m.calls||0,tone:'text-blue-600 bg-blue-50',actType:'Phone Call',label:'Calls'},
      {icon:<Video size={11}/>,val:m.video_calls||0,tone:'text-cyan-600 bg-cyan-50',actType:'Video Call',label:'Video Calls'},
      {icon:<Handshake size={11}/>,val:m.meetings||0,tone:'text-violet-600 bg-violet-50',actType:'In Person Meet',label:'Meetings'},
      {icon:<Monitor size={11}/>,val:m.demos||0,tone:'text-emerald-600 bg-emerald-50',actType:'Demo',label:'Demos'},
      {icon:<Navigation size={11}/>,val:m.site_visits||0,tone:'text-orange-600 bg-orange-50',actType:'Site Visit',label:'Site Visits'},
      {icon:<Repeat2 size={11}/>,val:m.follow_ups||0,tone:'text-amber-600 bg-amber-50',actType:'Follow Up',label:'Follow Ups'},
      {icon:<Mail size={11}/>,val:m.emails||0,tone:'text-slate-600 bg-slate-100',actType:'Email',label:'Emails'},
    ]
    const kpiTiles = [
      {label:customerLabel,value:totalCusts,sub:custPotential>0?fmt(custPotential):'',tone:'text-sky-700 bg-sky-50 border-sky-200',onClick:()=>openCustomerPanel(m.user_id,m.user_name,true)},
      {label:leadLabel,value:m.lead_count||0,sub:(m.lead_value||0)>0?fmt(m.lead_value):'',tone:'text-violet-700 bg-violet-50 border-violet-200',onClick:()=>openLeadPanel(m.user_id,m.user_name)},
      {label:opportunityLabel,value:opportunityCount,sub:opportunityValue>0?fmt(opportunityValue):'',tone:'text-cyan-700 bg-cyan-50 border-cyan-200',onClick:()=>openLeadPanel(m.user_id,m.user_name,'opportunities')},
      {label:tenderLabel,value:m.tender_count||0,sub:(m.tender_value||0)>0?fmt(m.tender_value):'',tone:'text-orange-700 bg-orange-50 border-orange-200',onClick:()=>openTenderPanel(m.user_id,m.user_name)},
      {label:workOrderLabel,value:m.wo_count||0,sub:(m.wo_value||0)>0?fmt(m.wo_value):'',tone:'text-emerald-700 bg-emerald-50 border-emerald-200',onClick:()=>openWorkOrderPanel(m.user_id,m.user_name)},
    ]
    return (
      <div key={m.user_id} className={`border-t border-slate-200 bg-white ${m.is_self?'bg-blue-50/20':''}`}>
        <div
          className="grid w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-slate-50 lg:grid-cols-[minmax(190px,1.05fr)_minmax(250px,1.2fr)_100px_minmax(500px,2.55fr)] xl:grid-cols-[minmax(220px,1.05fr)_minmax(280px,1.22fr)_108px_minmax(600px,2.55fr)]"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold text-white ${m.is_self?'bg-gradient-to-br from-blue-500 to-indigo-600':'bg-gradient-to-br from-slate-400 to-slate-600'}`}>
              {m.user_name?.charAt(0)?.toUpperCase()}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold leading-tight text-gray-800">{m.user_name}</span>
              <span className="mt-1 inline-flex rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-slate-600">{roleLabel(m.role)}</span>
            </span>
          </span>
          <span className="grid min-w-0 grid-cols-7 items-center gap-1.5 py-1">
            {activityChips.map(chip=>(
              <span
                key={chip.actType}
                onClick={e=>{e.stopPropagation();openActPanel(chip.actType,m.user_id,m.user_name)}}
                title={`${m.user_name} - ${chip.label}`}
                className={`inline-flex h-8 min-w-0 cursor-pointer items-center justify-center gap-1 rounded-lg px-1.5 text-[11px] font-bold transition-colors hover:brightness-95 ${chip.tone}`}
              >
                {chip.icon}{chip.val}
              </span>
            ))}
          </span>
          <span className="min-w-0">
            <span className="block text-[9px] font-bold uppercase leading-none text-slate-400">Revenue</span>
            <span className="mt-0.5 block text-sm font-bold leading-tight text-slate-950">{fmt(targetRevenue)}</span>
            {m.sales_target>0&&(
              <>
                <span className="mt-0.5 block text-[10px] font-medium leading-none text-slate-400">/{fmt(m.sales_target)}</span>
                <span className="mt-1 block h-1 overflow-hidden rounded-full bg-slate-100">
                  <span className="block h-full rounded-full bg-amber-400" style={{width:`${Math.max(salesPct2,2)}%`}}/>
                </span>
              </>
            )}
          </span>
          <span className="flex min-w-0 flex-wrap justify-start gap-2.5 xl:flex-nowrap">
            {kpiTiles.map(tile=>(
              <span
                key={tile.label}
                onClick={e=>{e.stopPropagation();tile.onClick()}}
                className={`flex h-14 w-[112px] shrink-0 cursor-pointer flex-col items-center justify-center rounded-xl border px-2 text-center hover:brightness-95 ${tile.tone}`}
              >
                <span className="text-base font-bold leading-none">{tile.value}</span>
                <span className="mt-1 max-w-full truncate text-[10px] font-semibold leading-none">{tile.label}</span>
                {tile.sub&&<span className="mt-1 text-[10px] font-bold leading-none">{tile.sub}</span>}
              </span>
            ))}
          </span>
        </div>
      </div>
    )
  }

  const getDateRange=()=>{
    return dateRange
  }

  const handleJumpToMember=(uid:number)=>{
    setSelectedUid(uid)
    setViewMode('advanced')
  }

  const _ps = panelSearch.toLowerCase()
  const filtL  = _ps ? panelLeads.filter((l:any)=>[l.lead_title,l.lead_name,l.customer_name,l.assigned_to_name].some((f:any)=>(f||'').toLowerCase().includes(_ps))) : panelLeads
  const filtT  = _ps ? panelTenders.filter((t:any)=>[t.tender_title,t.customer_name,t.assigned_to_name,t.portal_ref_number].some((f:any)=>(f||'').toLowerCase().includes(_ps))) : panelTenders
  const filtWO = _ps ? panelWorkOrders.filter((w:any)=>[w.project_title,w.tender_title,w.customer_name].some((f:any)=>(f||'').toLowerCase().includes(_ps))) : panelWorkOrders
  const filtA  = _ps ? panelActs.filter((a:any)=>[a.subject,a.customer_name,a.user_name].some((f:any)=>(f||'').toLowerCase().includes(_ps))) : panelActs
  const panelLeadDisplayLabel = panelLeadLabel === 'Opportunities' ? opportunityLabel : leadLabel
  const panelLeadDisplayLabelLower = panelLeadLabel === 'Opportunities' ? opportunityLabelLower : leadLabelLower
  const panelSearchBar = (
    <div className="py-2 relative">
      <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"/>
      <input value={panelSearch} onChange={e=>setPanelSearch(e.target.value)} placeholder="Search…"
        className="w-full text-sm border border-gray-200 rounded-xl pl-8 pr-7 py-1.5 focus:outline-none focus:border-blue-400 bg-gray-50"/>
      {panelSearch&&<button onClick={()=>setPanelSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"><X size={11}/></button>}
    </div>
  )

  if (actDetailPopup) {
    return (
      <div className="space-y-5">
        {reopenTarget&&(
          <ReopenActivityModal
            activity={reopenTarget}
            onClose={()=>setReopenTarget(null)}
            onSuccess={(updated)=>{setActDetailPopup(updated)}}
          />
        )}

        <KAMFormShell
          breadcrumb="Activities"
          currentLabel="View Activity"
          onBack={()=>setActDetailPopup(null)}
          actions={<Button variant="outline" size="sm" onClick={()=>setActDetailPopup(null)} leftIcon={<ChevronLeft size={14}/>}>Back to Dashboard</Button>}
        >
          <ActivityDetailView
            activity={actDetailPopup}
            onLog={a=>{
              setActDetailPopup(null)
              onLogActivity(a)
            }}
            onEdit={a=>{
              setActDetailPopup(null)
              onEditActivity(a)
            }}
            canReopen={canReopenActivity}
            onReopen={a=>setReopenTarget(a)}
          />
        </KAMFormShell>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {showTargetModal&&(targetGroups.length>0
        ? <GroupTargetModal groups={targetGroups} defaultGroupId={selectedGroupKey} period={requestPeriod} onSave={saveTarget} onClose={()=>setShowTargetModal(false)} saving={savingTarget}/>
        : <SetTargetModal teamMembers={visibleTeamMembers} period={requestPeriod} onSave={saveTarget} onClose={()=>setShowTargetModal(false)} saving={savingTarget}/>
      )}

      {custPopup&&(
        <CustomerListPopup
          customers={popupCustomers}
          myCustomers={myOwnCustomers}
          teamMembers={filteredSalesTeamRows.map(m=>({...m,id:m.user_id}))}
          isAdminOrCEO={isAdminOrCEO}
          totalCount={s.customers||undefined}
          onClose={()=>setCustPopup(false)}
        />
      )}

      {/* Activity type popup */}
      {actPanel&&(()=>{
        const tc=TYPE_COLOR[panelActType]||{bg:'bg-blue-50',text:'text-blue-600',dot:'bg-blue-400'}
        const panelTitle = panelMemberName ? `${panelMemberName} - ${panelActType}` : panelActType
        const done=panelActs.filter((a:any)=>a.status==='Completed').length
        const active=panelActs.filter((a:any)=>!['Completed','Cancelled'].includes(a.status||'')).length
        const cancelled=panelActs.filter((a:any)=>a.status==='Cancelled').length
        const activeType = ACTIVITY_TYPES.includes(panelActType) ? panelActType : ''
        const fmtActivityDate = (a:any) => {
          const raw = String(a.activity_date || a.date || a.created_at || '').slice(0,10)
          if(!raw) return ''
          const [y,m,d] = raw.split('-')
          return y && m && d ? new Date(`${raw}T00:00:00`).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : raw
        }
        return createPortal(
          <div className={`fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/35 backdrop-blur-sm ${actPanelExpanded?'px-2 py-2':'px-4 py-6'}`}>
            <div className={`flex w-full flex-col overflow-hidden border border-slate-200 bg-white shadow-2xl transition-all duration-200 ${
              actPanelExpanded
                ? 'h-[calc(100vh-16px)] max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] rounded-xl'
                : 'max-h-[88vh] max-w-5xl rounded-2xl'
            }`}>
              <div className="border-b border-slate-200 px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-black text-slate-950">{panelTitle}</h2>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
                      <span>{panelActs.length} activities</span>
                      {done>0&&<span className="text-emerald-600">Completed {done}</span>}
                      {active>0&&<span className="text-blue-600">Active {active}</span>}
                      {cancelled>0&&<span className="text-red-500">Cancelled {cancelled}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={()=>setActPanelExpanded(v=>!v)}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                      aria-label={actPanelExpanded?'Restore activity popup':'Expand activity popup'}
                      title={actPanelExpanded?'Restore':'Expand'}
                    >
                      {actPanelExpanded?<Minimize2 size={16}/>:<Maximize2 size={16}/>}
                    </button>
                    <button
                      type="button"
                      onClick={closeActPanel}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                      aria-label="Close activity popup"
                      title="Close"
                    >
                      <X size={16}/>
                    </button>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-4 overflow-x-auto px-1 pb-1">
                  {ACTIVITY_TYPES.map((type,idx)=>{
                    const selected=activeType===type
                    return (
                      <Fragment key={type}>
                        {idx>0&&<div className="h-px min-w-[70px] flex-1 bg-slate-200"/>}
                        <button
                          type="button"
                          onClick={()=>openActPanel(type, selectedUid||undefined, panelMemberName)}
                          title={type}
                          className="group flex shrink-0 flex-col items-center gap-1.5"
                        >
                          <span className={`flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all ${selected?'border-blue-600 bg-blue-600 text-white shadow-lg shadow-blue-100':'border-slate-200 bg-white text-slate-400 group-hover:border-blue-200 group-hover:text-blue-500'}`}>
                            {TYPE_ICON[type]||<Activity size={15}/>}
                          </span>
                          <span className={`max-w-[82px] truncate text-[10px] font-bold ${selected?'text-blue-700':'text-slate-400'}`}>{type}</span>
                        </button>
                      </Fragment>
                    )
                  })}
                </div>
                <div className="mt-3">{panelSearchBar}</div>
              </div>

              <div className="flex-1 overflow-y-auto bg-white px-5 py-4">
                {panelLoading ? (
                  <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
                    <div className={`h-4 w-4 animate-spin rounded-full border-2 border-t-transparent ${tc.text.replace('text','border')}`}/>Loading...
                  </div>
                ) : filtA.length === 0 ? (
                  <div className="py-16 text-center text-sm text-gray-400">{panelSearch?'No matches':'No '+panelActType+' activities found'}</div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-slate-200">
                    <table className="w-full min-w-[940px] table-fixed border-collapse text-left">
                      <colgroup>
                        <col className="w-[23%]"/>
                        <col className="w-[14%]"/>
                        <col className="w-[12%]"/>
                        <col className="w-[13%]"/>
                        <col className="w-[12%]"/>
                        <col className="w-[17%]"/>
                        <col className="w-[9%]"/>
                      </colgroup>
                      <thead className="sticky top-0 z-10 bg-slate-50">
                        <tr className="border-b border-slate-200 text-[11px] font-black uppercase tracking-wide text-slate-500">
                          <th className="px-3 py-2.5">Activity</th>
                          <th className="px-3 py-2.5">{customerSingular}</th>
                          <th className="px-3 py-2.5">Owner</th>
                          <th className="px-3 py-2.5">Date / Time</th>
                          <th className="px-3 py-2.5">Location</th>
                          <th className="px-3 py-2.5">Details</th>
                          <th className="px-3 py-2.5 text-right">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 bg-white">
                        {filtA.map((a:any) => {
                          const isDone=a.status==='Completed', isCan=a.status==='Cancelled'
                          const rowType = a.type || a.activity_type || panelActType
                          const rowCfg = TYPE_COLOR[rowType] || tc
                          const dateText = fmtActivityDate(a)
                          const timeText = [a.start_time,a.duration_minutes ? `${a.duration_minutes}m` : ''].filter(Boolean).join(' - ')
                          const locationText = a.location || (a.has_travel ? [a.travel_from,a.travel_to].filter(Boolean).join(' to ') : '') || '-'
                          const detailText = a.outcome || a.next_action || a.description || '-'
                          const followText = [
                            a.next_action_date ? `By ${fmtActivityDate({activity_date:a.next_action_date})}` : '',
                            a.followup_category || '',
                            a.followup_sub_type || '',
                            a.followup_ref_id ? `Ref #${a.followup_ref_id}` : '',
                          ].filter(Boolean).join(' | ')
                          return (
                            <tr
                              key={a.id || `${a.subject}-${a.activity_date}`}
                              onClick={()=>setActDetailPopup(a)}
                              className={`cursor-pointer align-middle transition-colors hover:bg-blue-50/40 ${isCan?'opacity-60':''}`}
                            >
                              <td className="px-3 py-2.5">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${rowCfg.bg} ${rowCfg.text}`}>
                                    {TYPE_ICON[rowType]||TYPE_ICON[panelActType]||<Activity size={13}/>}
                                  </span>
                                  <div className="min-w-0">
                                    <p className={`truncate text-sm font-black text-slate-950 ${isCan?'line-through text-slate-400':''}`}>{a.subject||'Activity'}</p>
                                    <p className="truncate text-[11px] font-bold text-slate-400">{rowType}</p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                <p className="truncate text-xs font-bold text-slate-700">{a.customer_name || '-'}</p>
                              </td>
                              <td className="px-3 py-2.5">
                                <p className="truncate text-xs font-bold text-indigo-700">{a.user_name || '-'}</p>
                              </td>
                              <td className="px-3 py-2.5">
                                <p className="truncate text-xs font-bold text-slate-700">{dateText || '-'}</p>
                                {timeText&&<p className="mt-0.5 truncate text-[11px] font-semibold text-slate-400">{timeText}</p>}
                              </td>
                              <td className="px-3 py-2.5">
                                <p className="truncate text-xs font-bold text-emerald-700">{locationText}</p>
                                {a.travel_mode&&<p className="mt-0.5 truncate text-[11px] font-semibold text-slate-400">{a.travel_mode}</p>}
                              </td>
                              <td className="px-3 py-2.5">
                                <p className="line-clamp-2 text-xs font-semibold leading-snug text-slate-700">{detailText}</p>
                                {followText&&<p className="mt-1 truncate text-[11px] font-bold text-blue-600">{followText}</p>}
                              </td>
                              <td className="px-3 py-2.5 text-right">
                                <span className={`inline-flex max-w-full justify-center rounded-full px-2.5 py-1 text-[11px] font-black ${isDone?'bg-emerald-100 text-emerald-700':isCan?'bg-red-100 text-red-600':'bg-amber-100 text-amber-700'}`}>
                                  <span className="truncate">{a.status || 'Planned'}</span>
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )
      })()}

      {/* Activity type panel (all types) */}
      {(()=>{
        const tc=TYPE_COLOR[panelActType]||{bg:'bg-blue-50',text:'text-blue-600',dot:'bg-blue-400'}
        const panelTitle = panelMemberName ? `${panelMemberName} — ${panelActType}` : panelActType
        return (
          <SlidePanel open={false&&actPanel} onClose={()=>{setActPanel(false);setPanelSearch('')}}
            title={panelTitle}
            tabBar={panelSearchBar}
            subtitle={(() => {
              const done=panelActs.filter((a:any)=>a.status==='Completed').length
              const active=panelActs.filter((a:any)=>!['Completed','Cancelled'].includes(a.status||'')).length
              const cancelled=panelActs.filter((a:any)=>a.status==='Cancelled').length
              const pct=panelActs.length>0?Math.round(done/panelActs.length*100):0
              return (
                <span className="flex items-center gap-2 flex-wrap text-[12px]">
                  <span className="font-semibold">{panelActs.length} activities</span>
                  {done>0&&<><span className="opacity-40">·</span><span className="text-emerald-400 font-semibold">Done {done} ({pct}%)</span></>}
                  {active>0&&<><span className="opacity-40">·</span><span className="text-blue-300 font-semibold">Active {active}</span></>}
                  {cancelled>0&&<><span className="opacity-40">·</span><span className="text-red-400 font-semibold">Cancelled {cancelled}</span></>}
                </span>
              )
            })()}
            headerClassName="bg-gradient-to-r from-slate-700 to-slate-900 border-slate-900 [&_h2]:text-white [&_div]:text-white/70"
            width="w-[640px]"
            footer={<><Button onClick={()=>setActPanel(false)}>Close</Button></>}>
            {panelLoading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-400">
                <div className={`w-4 h-4 border-2 border-t-transparent rounded-full animate-spin ${tc.text.replace('text','border')}`}/>Loading…
              </div>
            ) : filtA.length === 0 ? (
              <div className="py-12 text-center text-sm text-gray-400">{panelSearch?'No matches':'No '+panelActType+' activities found'}</div>
            ) : (
              <>
                <div className="divide-y divide-gray-100">
                  {filtA.map((a:any) => {
                    const isDone=a.status==='Completed', isCan=a.status==='Cancelled'
                    return (
                      <div key={a.id} className={`flex items-start gap-3 px-5 py-4 hover:bg-gray-50/60 ${isCan?'opacity-60':''}`}>
                        <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${tc.bg} ${tc.text}`}>
                          {TYPE_ICON[panelActType]||<Activity size={14}/>}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm font-semibold text-gray-900 truncate ${isCan?'line-through text-gray-400':''}`}>{a.subject||'—'}</p>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap text-xs">
                            {a.customer_name&&<span className="text-gray-600 flex items-center gap-0.5"><Building2 size={10}/>{a.customer_name}</span>}
                            {a.user_name&&<span className="text-indigo-600 font-medium">{a.user_name}</span>}
                            {a.activity_date&&<span className="text-gray-500 flex items-center gap-0.5"><Calendar size={10}/>{a.activity_date}</span>}
                            {a.location&&<span className="text-gray-500 flex items-center gap-0.5"><MapPin size={9}/>{a.location}</span>}
                          </div>
                          
                          {/* Time & duration */}
                          {(a.start_time||a.duration_minutes)&&(
                            <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500">
                              {a.start_time&&<span>{a.start_time}</span>}
                              {a.duration_minutes&&<span>• {a.duration_minutes}m</span>}
                            </div>
                          )}
                          
                          {/* Travel info */}
                          {a.has_travel&&(a.travel_from||a.travel_to)&&(
                            <div className="flex items-center gap-1 mt-0.5 text-xs text-indigo-500 font-medium">
                              <Navigation size={9}/>
                              <span>{a.travel_from||'?'} → {a.travel_to||'?'}</span>
                              {a.travel_mode&&<span className="text-gray-400">({a.travel_mode})</span>}
                            </div>
                          )}
                          
                          {/* Follow-up reference */}
                          {a.followup_ref_id&&(
                            <p className="text-xs text-gray-400 mt-0.5 font-medium">Follow-up from #{a.followup_ref_id}</p>
                          )}
                          
                          {/* Description */}
                          {a.description&&a.description!==a.outcome&&(
                            <p className="text-xs text-gray-500 mt-1">{a.description}</p>
                          )}
                          
                          {/* Outcome - more prominent */}
                          {a.outcome&&(
                            <div className={`mt-1.5 p-2 rounded-lg text-xs border ${isDone?'bg-emerald-50 text-emerald-700 border-emerald-200':'bg-blue-50 text-blue-700 border-blue-200'}`}>
                              <p className="font-semibold mb-0.5">💬 Outcome:</p>
                              <p className="leading-snug">{a.outcome}</p>
                            </div>
                          )}
                          
                          {/* Contacts met
                          {a.contacts_met&&(
                            <div className="mt-1.5 p-2 rounded-lg text-xs bg-purple-50 border border-purple-200 text-purple-700">
                              <p className="font-semibold mb-0.5">👥 Contacts Met:</p>
                              <p className="leading-snug">{a.contacts_met}</p>
                            </div>
                          )} */}
                          
                          {/* Follow-up category */}
                          {a.followup_category&&(
                            <div className="flex items-center gap-1.5 mt-1.5 text-xs">
                              <span className="px-2 py-0.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 font-medium">{a.followup_category}</span>
                              {a.followup_sub_type&&<span className="px-2 py-0.5 rounded-lg bg-amber-50 text-amber-600 border border-amber-200">{a.followup_sub_type}</span>}
                            </div>
                          )}
                          
                          {/* Next action */}
                          {a.next_action&&(
                            <div className="mt-1.5 p-2 rounded-lg text-xs bg-blue-50 border border-blue-200 text-blue-700">
                              <p className="font-semibold mb-0.5">→ Next Action:</p>
                              <p className="leading-snug">{a.next_action}</p>
                              {a.next_action_date&&<p className="text-blue-600 font-medium mt-0.5">By: {a.next_action_date}</p>}
                            </div>
                          )}
                        </div>
                        <div className="flex-shrink-0">
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${isDone?'bg-emerald-100 text-emerald-700':isCan?'bg-red-100 text-red-600':'bg-amber-100 text-amber-700'}`}>{a.status}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </SlidePanel>
        )
      })()}

      {leadPanel&&(
        <PipelineRecordsModal
          kind={panelLeadLabel==='Opportunities'?'opportunities':'leads'}
          title={panelMemberName ? `${panelMemberName}'s ${panelLeadDisplayLabel}` : panelLeadDisplayLabel}
          rows={panelLeads}
          loading={panelLoading}
          search={panelSearch}
          setSearch={setPanelSearch}
          onClose={()=>{setLeadPanel(false);setPanelSearch('')}}
        />
      )}
      {tenderPanel&&(
        <PipelineRecordsModal
          kind="tenders"
          title={panelMemberName ? `${panelMemberName}'s ${tenderLabel}` : tenderLabel}
          rows={panelTenders}
          loading={panelLoading}
          search={panelSearch}
          setSearch={setPanelSearch}
          onClose={()=>{setTenderPanel(false);setPanelSearch('')}}
        />
      )}
      {workOrderPanel&&(
        <PipelineRecordsModal
          kind="workorders"
          title={panelMemberName ? `${panelMemberName}'s ${workOrderLabel}` : workOrderLabel}
          rows={panelWorkOrders}
          loading={panelLoading}
          search={panelSearch}
          setSearch={setPanelSearch}
          onClose={()=>{setWorkOrderPanel(false);setPanelSearch('')}}
        />
      )}
      {memberDetailsOpen&&(
        <MemberDetailsModal
          member={memberDetailsMember}
          data={memberDetailsData}
          loading={memberDetailsLoading}
          activeTab={memberDetailsTab}
          onTabChange={setMemberDetailsTab}
          onClose={()=>setMemberDetailsOpen(false)}
        />
      )}

      {/* Leads panel */}
      <SlidePanel open={false&&leadPanel} onClose={()=>{setLeadPanel(false);setPanelSearch('')}}
        title={panelMemberName ? `${panelMemberName}'s ${panelLeadDisplayLabel}` : panelLeadDisplayLabel}
        tabBar={panelSearchBar}
        subtitle={(() => {
          const total=panelLeads.reduce((s:number,l:any)=>s+(l.est_value||l.lead_value||0),0)
          const wonVal=panelLeads.filter((l:any)=>l.status==='Converted').reduce((s:number,l:any)=>s+(l.est_value||l.lead_value||0),0)
          const activeVal=panelLeads.filter((l:any)=>!['Converted','Lost'].includes(l.status||'')).reduce((s:number,l:any)=>s+(l.est_value||l.lead_value||0),0)
          const lostVal=panelLeads.filter((l:any)=>l.status==='Lost').reduce((s:number,l:any)=>s+(l.est_value||l.lead_value||0),0)
          return (
            <span className="flex items-center gap-2 flex-wrap text-[12px]">
              <span className="font-semibold">{panelLeads.length} {panelLeadDisplayLabelLower}</span>
              {total>0&&<><span className="opacity-40">·</span><span className="font-semibold">Pipeline {fmt(total)}</span></>}
              {wonVal>0&&<><span className="opacity-40">·</span><span className="text-emerald-400 font-semibold">Won {fmt(wonVal)}</span></>}
              {activeVal>0&&<><span className="opacity-40">·</span><span className="text-blue-300 font-semibold">Active {fmt(activeVal)}</span></>}
              {lostVal>0&&<><span className="opacity-40">·</span><span className="text-red-400 font-semibold">Lost {fmt(lostVal)}</span></>}
            </span>
          )
        })()}
        headerClassName="bg-gradient-to-r from-slate-700 to-slate-900 border-slate-900 [&_h2]:text-white [&_div]:text-white/70"
        width="w-[640px]"
        footer={<><Button onClick={()=>setLeadPanel(false)}>Close</Button></>}>
        {panelLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-400">
            <div className="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin"/>Loading…
          </div>
        ) : filtL.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">{panelSearch?'No matches':`No ${panelLeadDisplayLabelLower} found`}</div>
        ) : (
          <>
            <div className="divide-y divide-gray-100">
              {filtL.map((l:any) => (
                <div key={l.id} className="flex items-start gap-3 px-5 py-3.5 hover:bg-gray-50/60">
                  <div className="w-8 h-8 rounded-xl bg-violet-100 flex items-center justify-center flex-shrink-0 text-violet-600"><TrendingUp size={14}/></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{l.lead_title||l.lead_name||'—'}</p>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      <span className="text-xs text-gray-500 flex items-center gap-1"><Building2 size={10}/>{l.customer_name||'—'}</span>
                      {l.tender_id_ref&&<span className="text-xs text-white font-mono bg-gray-700 px-1.5 py-0.5 rounded">{l.tender_id_ref}</span>}
                    </div>
                    {l.assigned_to_name && <p className="text-xs text-indigo-500 mt-0.5">{l.assigned_to_name}</p>}
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${l.status==='Converted'?'bg-emerald-100 text-emerald-700':l.status==='Lost'?'bg-red-100 text-red-600':'bg-blue-100 text-blue-700'}`}>{l.status}</span>
                    <span className="text-sm font-bold text-gray-800">{(l.est_value||l.lead_value||0)>0?fmt(l.est_value||l.lead_value):'—'}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </SlidePanel>

      {/* Tenders panel */}
      <SlidePanel open={false&&tenderPanel} onClose={()=>{setTenderPanel(false);setPanelSearch('')}}
        title={panelMemberName ? `${panelMemberName}'s ${tenderLabel}` : tenderLabel}
        tabBar={panelSearchBar}
        subtitle={(() => {
          const total=panelTenders.reduce((s:number,t:any)=>s+(t.est_value||0),0)
          const wonVal=panelTenders.filter((t:any)=>t.result==='Won').reduce((s:number,t:any)=>s+(t.est_value||0),0)
          const activeVal=panelTenders.filter((t:any)=>!['Won','Lost','Cancelled'].includes(t.result||'')).reduce((s:number,t:any)=>s+(t.est_value||0),0)
          const lostVal=panelTenders.filter((t:any)=>t.result==='Lost').reduce((s:number,t:any)=>s+(t.est_value||0),0)
          return (
            <span className="flex items-center gap-2 flex-wrap text-[12px]">
              <span className="font-semibold">{panelTenders.length} {tenderLabelLower}</span>
              {total>0&&<><span className="opacity-40">·</span><span className="font-semibold">Pipeline {fmt(total)}</span></>}
              {wonVal>0&&<><span className="opacity-40">·</span><span className="text-emerald-400 font-semibold">Won {fmt(wonVal)}</span></>}
              {activeVal>0&&<><span className="opacity-40">·</span><span className="text-blue-300 font-semibold">Active {fmt(activeVal)}</span></>}
              {lostVal>0&&<><span className="opacity-40">·</span><span className="text-red-400 font-semibold">Lost {fmt(lostVal)}</span></>}
            </span>
          )
        })()}
        headerClassName="bg-gradient-to-r from-slate-700 to-slate-900 border-slate-900 [&_h2]:text-white [&_div]:text-white/70"
        width="w-[640px]"
        footer={<><Button onClick={()=>setTenderPanel(false)}>Close</Button></>}>
        {panelLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-400">
            <div className="w-4 h-4 border-2 border-orange-400 border-t-transparent rounded-full animate-spin"/>Loading…
          </div>
        ) : filtT.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">{panelSearch?'No matches':`No ${tenderLabelLower} found`}</div>
        ) : (
          <>
            <div className="divide-y divide-gray-100">
              {filtT.map((t:any) => (
                <div key={t.id} className="flex items-start gap-3 px-5 py-3.5 hover:bg-gray-50/60">
                  <div className="w-8 h-8 rounded-xl bg-orange-100 flex items-center justify-center flex-shrink-0 text-orange-600"><FileText size={14}/></div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{t.tender_title||'—'}</p>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="text-xs text-gray-500 flex items-center gap-1"><Building2 size={10}/>{t.customer_name||'—'}</span>
                      {t.portal_ref_number && <span className="text-xs text-white font-mono bg-gray-700 px-1.5 py-0.5 rounded">{t.portal_ref_number}</span>}
                    </div>
                    {t.assigned_to_name && <p className="text-xs text-indigo-500 mt-0.5">{t.assigned_to_name}</p>}
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${t.tender_status==='Won'?'bg-emerald-100 text-emerald-700':t.tender_status==='Lost'?'bg-red-100 text-red-600':t.tender_status==='Submitted'?'bg-blue-100 text-blue-700':'bg-amber-100 text-amber-700'}`}>{t.tender_status||'—'}</span>
                    <span className="text-sm font-bold text-gray-800">{(t.est_value||0)>0?fmt(t.est_value):'—'}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </SlidePanel>

      {/* Work orders panel */}
      <SlidePanel open={false&&workOrderPanel} onClose={()=>{setWorkOrderPanel(false);setPanelSearch('')}}
        title={panelMemberName ? `${panelMemberName}'s ${workOrderLabel}` : workOrderLabel}
        tabBar={panelSearchBar}
        subtitle={(() => {
          const woVal=(wo:any)=>wo.wo_value||wo.bid_amount||0
          const total=panelWorkOrders.reduce((s:number,wo:any)=>s+woVal(wo),0)
          const draftCount=panelWorkOrders.filter((wo:any)=>!wo.wo_status||String(wo.wo_status).trim().toLowerCase()==='draft').length
          const completedCount=panelWorkOrders.filter((wo:any)=>normalizeWorkOrderStatus(wo.wo_status)==='completed').length
          const activeCount=panelWorkOrders.filter((wo:any)=>normalizeWorkOrderStatus(wo.wo_status)==='active').length
          return (
            <span className="flex items-center gap-2 flex-wrap text-[12px]">
              <span className="font-semibold">{panelWorkOrders.length} {workOrderLabelLower}</span>
              {total>0&&<><span className="opacity-40">·</span><span className="font-semibold">Value {fmt(total)}</span></>}
              {draftCount>0&&<><span className="opacity-40">·</span><span className="text-slate-400 font-semibold">Draft {draftCount}</span></>}
              {activeCount>0&&<><span className="opacity-40">·</span><span className="text-blue-300 font-semibold">Active {activeCount}</span></>}
              {completedCount>0&&<><span className="opacity-40">·</span><span className="text-emerald-400 font-semibold">Done {completedCount}</span></>}
            </span>
          )
        })()}
        headerClassName="bg-gradient-to-r from-slate-700 to-slate-900 border-slate-900 [&_h2]:text-white [&_div]:text-white/70"
        width="w-[640px]"
        footer={<><Button onClick={()=>setWorkOrderPanel(false)}>Close</Button></>}>
        {panelLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-400">
            <div className="w-4 h-4 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"/>Loading...
          </div>
        ) : filtWO.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">{panelSearch?'No matches':`No ${workOrderLabelLower} found`}</div>
        ) : (
          <>
            <div className="divide-y divide-gray-100">
              {filtWO.map((wo:any) => {
                const statusLabel = wo.wo_status || 'Draft'
                const milestoneDate = wo.completion_date || wo.instln_date || wo.dlvry_date || wo.delivery_date || null
                return (
                  <div key={wo.id} className="flex items-start gap-3 px-5 py-3.5 hover:bg-gray-50/60">
                    <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center flex-shrink-0 text-emerald-600"><Package size={14}/></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{wo.project_title||wo.tender_title||wo.customer_name||'Work Order'}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {wo.customer_name&&<span className="text-xs text-gray-500 flex items-center gap-1"><Building2 size={10}/>{wo.customer_name}</span>}
                        {wo.portal_ref_number&&<span className="text-xs text-white font-mono bg-gray-700 px-1.5 py-0.5 rounded">{wo.portal_ref_number}</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {wo.assigned_to_name&&<span className="text-xs text-indigo-500">{wo.assigned_to_name}</span>}
                        {milestoneDate&&<span className="text-xs text-gray-400 flex items-center gap-1"><Calendar size={10}/>{milestoneDate}</span>}
                        {/* {wo.progress_percent != null&&<span className="text-xs text-emerald-600 font-semibold">{wo.progress_percent}% progress</span>} */}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${workOrderStatusBadge(statusLabel)}`}>{statusLabel}</span>
                      <span className="text-sm font-bold text-gray-800">{(wo.wo_value||wo.bid_amount||0)>0?fmt(wo.wo_value||wo.bid_amount):'₹0'}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </SlidePanel>

      {/* Customers panel */}
      {customerPanel && (
        <CustomerModal
          title={panelMemberName ? `${panelMemberName}'s ${customerLabel}` : customerLabel}
          rows={panelCustomers}
          businessRecords={panelBusinessRecords}
          masterSegmentSubSegments={masterSegmentSubSegments}
          teamMembers={teamMembers}
          teamRows={teamRows}
          loading={panelLoading}
          search={panelSearch}
          setSearch={setPanelSearch}
          categoryFilter={panelCategoryFilter}
          onCategoryFilter={setPanelCategoryFilter}
          onClose={()=>{setCustomerPanel(false);setPanelSearch('');setPanelBusinessRecords(emptyCustomerBusinessRecords())}}
        />
      )}
      {false && <SlidePanel open={customerPanel} onClose={()=>setCustomerPanel(false)}
        title={panelMemberName ? `${panelMemberName}'s ${customerLabel}` : customerLabel}
       headerClassName="bg-gradient-to-r from-slate-700 to-slate-900 border-slate-900 [&_h2]:text-white [&_div]:text-white/70"
        subtitle={(() => {
          const totalPotential = panelCustomers.reduce((s:number,c:any)=>s+(c.potential_value||0),0)
          return (
            <span className="flex items-center gap-2 flex-wrap text-[12px]">
              <span className="font-semibold opacity-90">{panelCustomers.length} {customerLabelLower}</span>
              {totalPotential>0 && <><span className="opacity-40">·</span><span className="font-semibold text-white/80">{fmt(totalPotential)}</span></>}
              {panelMemberLeadValue>0 && <><span className="opacity-40">·</span><span className="text-violet-300 font-semibold">{leadLabel} {fmt(panelMemberLeadValue)}</span></>}
              {panelMemberTenderValue>0 && <><span className="opacity-40">·</span><span className="text-amber-300 font-semibold">{tenderLabel} {fmt(panelMemberTenderValue)}</span></>}
            </span>
          )
        })()}
        tabBar={!panelLoading ? (()=>{
          const salesTarget = panelMemberSalesTarget
          const won = panelMemberWonValue
          const achPct = salesTarget>0 ? Math.min(100,Math.round(won/salesTarget*100)) : 0
          if (salesTarget <= 0) return null
          return (
            <div className="py-2.5">
              <div className="rounded-xl border border-slate-200 bg-white/70 px-3 py-2.5">
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold text-slate-600">Sales Performance</span>
                  <span className={`text-[11px] font-bold ${achPct>=100?'text-emerald-600':achPct>=60?'text-blue-600':'text-amber-600'}`}>
                    {fmt(won)} / {fmt(salesTarget)} ({achPct}%)
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                  <div style={{width:`${Math.max(achPct,2)}%`}} className={`h-full rounded-full transition-all ${achPct>=100?'bg-emerald-500':achPct>=60?'bg-blue-500':'bg-amber-400'}`} />
                </div>
              </div>
            </div>
          )
        })() : undefined}
        width="w-[640px]"
        bodyClassName="!px-0 !py-0"
        footer={<Button onClick={()=>setCustomerPanel(false)}>Close</Button>}
        >
        {panelLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-400">
            <div className="w-4 h-4 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"/>Loading…
          </div>
        ) : panelCustomers.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">No {customerLabelLower} found</div>
        ) : (
          <div>
            {/* Pills row – sticky at top of table body */}
            {(() => {
              const wonC  = panelCustomers.filter((c:any)=>(c.won_count||0)>0||(c.won_value||0)>0).length
              const pipeC = panelCustomers.filter((c:any)=>(c.won_count||0)===0&&(c.won_value||0)===0&&((c.lead_count||0)>0||(c.tender_count||0)>0||(c.lead_value||0)>0||(c.tender_value||0)>0||(c.activity_count||0)>0)).length
              const noneC = panelCustomers.filter((c:any)=>(c.won_count||0)===0&&(c.won_value||0)===0&&(c.lead_count||0)===0&&(c.tender_count||0)===0&&(c.lead_value||0)===0&&(c.tender_value||0)===0&&(c.activity_count||0)===0).length
              return (
                <div className="flex items-center gap-2 flex-wrap px-5 py-2.5 border-b border-gray-100 bg-slate-50 sticky top-0 z-10">
                  {wonC > 0 && (
                    <button onClick={() => setPanelCategoryFilter(f => f === 'won' ? 'all' : 'won')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-all ${panelCategoryFilter === 'won' ? 'bg-emerald-500 ring-2 ring-emerald-300' : 'bg-emerald-100 hover:bg-emerald-200'}`}>
                      <span className={`w-2 h-2 rounded-full ${panelCategoryFilter === 'won' ? 'bg-white' : 'bg-emerald-500'}`} />
                      <span className={`text-[11px] font-bold ${panelCategoryFilter === 'won' ? 'text-white' : 'text-emerald-700'}`}>{wonC} Won</span>
                    </button>
                  )}
                  {pipeC > 0 && (
                    <button onClick={() => setPanelCategoryFilter(f => f === 'pipeline' ? 'all' : 'pipeline')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-all ${panelCategoryFilter === 'pipeline' ? 'bg-amber-500 ring-2 ring-amber-300' : 'bg-amber-100 hover:bg-amber-200'}`}>
                      <span className={`w-2 h-2 rounded-full ${panelCategoryFilter === 'pipeline' ? 'bg-white' : 'bg-amber-500'}`} />
                      <span className={`text-[11px] font-bold ${panelCategoryFilter === 'pipeline' ? 'text-white' : 'text-amber-700'}`}>{pipeC} In Pipeline</span>
                    </button>
                  )}
                  {noneC > 0 && (
                    <button onClick={() => setPanelCategoryFilter(f => f === 'none' ? 'all' : 'none')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-all ${panelCategoryFilter === 'none' ? 'bg-red-500 ring-2 ring-red-300' : 'bg-red-100 hover:bg-red-200'}`}>
                      <span className={`text-[11px] font-bold ${panelCategoryFilter === 'none' ? 'text-white' : 'text-red-700'}`}>{noneC} No Activity</span>
                    </button>
                  )}
                  {panelCategoryFilter !== 'all' && (
                    <button onClick={() => setPanelCategoryFilter('all')} className="ml-auto text-[11px] font-medium text-slate-400 hover:text-slate-700">Clear</button>
                  )}
                </div>
              )
            })()}
            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 bg-white">
                    <th className="px-5 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{customerSingular}</th>
                    <th className="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 whitespace-nowrap">Won</th>
                    <th className="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 whitespace-nowrap">Tender</th>
                    <th className="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 whitespace-nowrap">Lead</th>
                    <th className="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 whitespace-nowrap">Last Activity</th>
                    <th className="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 whitespace-nowrap">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...panelCustomers]
                    .filter((c:any) => {
                      if (panelCategoryFilter === 'all') return true
                      const hasWon = (c.won_count||0)>0||(c.won_value||0)>0
                      const hasPipe = (c.lead_count||0)>0||(c.tender_count||0)>0||(c.lead_value||0)>0||(c.tender_value||0)>0||(c.activity_count||0)>0
                      if (panelCategoryFilter === 'won') return hasWon
                      if (panelCategoryFilter === 'pipeline') return !hasWon && hasPipe
                      if (panelCategoryFilter === 'none') return !hasWon && !hasPipe
                      return true
                    })
                    .sort((a:any,b:any)=>{
                      const catRank=(c:any)=>{
                        const hasWon=(c.won_count||0)>0||(c.won_value||0)>0
                        const hasPipe=(c.lead_count||0)>0||(c.tender_count||0)>0||(c.lead_value||0)>0||(c.tender_value||0)>0||(c.activity_count||0)>0
                        return hasWon?0:(hasPipe?1:2)
                      }
                      const d=catRank(a)-catRank(b)
                      if(d!==0) return d
                      return ((b.won_count||0)*1000000000)+((b.won_value||0)+(b.tender_count||0)*1000000+(b.lead_count||0)*10000+(b.activity_count||0)) - (((a.won_count||0)*1000000000)+((a.won_value||0)+(a.tender_count||0)*1000000+(a.lead_count||0)*10000+(a.activity_count||0)))
                    })
                    .map((c:any) => {
                      const won = c.won_value||0
                      const wonCount = c.won_count||0
                      const leadVal = c.lead_value||0; const tenderVal = c.tender_value||0
                      const leadCount = c.lead_count||0; const tenderCount = c.tender_count||0
                      const activityCount = c.activity_count||0
                      const lastActivityDate = c.last_activity_date||''
                      const lastActivityType = c.last_activity_type||''
                      const hasWon = wonCount>0 || won>0
                      const hasPipeline = leadCount>0 || tenderCount>0 || leadVal>0 || tenderVal>0 || activityCount>0
                      const cat = hasWon ? 'won' : hasPipeline ? 'pipeline' : 'none'
                      const borderColor = cat==='won' ? '#34d399' : cat==='pipeline' ? '#fbbf24' : '#ef4444'
                      return (
                        <tr key={c.id} className="border-b border-gray-100 hover:bg-slate-50 transition-colors" style={{borderLeft:`3px solid ${borderColor}`}}>
                          <td className="px-5 py-3">
                            <p className="text-sm font-semibold text-gray-900 truncate max-w-[180px]">{c.name||c.customer_name||'—'}</p>
                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                              {(c.billing_city||c.city) && <span className="text-[11px] text-gray-400">{c.billing_city||c.city}</span>}
                              {(c.vertical||c.industry) && <><span className="text-[11px] text-gray-300">·</span><span className="text-[11px] text-gray-400">{c.vertical||c.industry}</span></>}
                            </div>
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            {hasWon ? <span className="text-[12px] font-bold text-emerald-600">{won>0?fmt(won):`${wonCount} won`}</span> : <span className="text-slate-300 text-xs">—</span>}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            {(tenderCount>0||tenderVal>0) ? <span className="text-[12px] font-bold text-amber-600">{tenderVal>0?fmt(tenderVal):`${tenderCount}`}</span> : <span className="text-slate-300 text-xs">—</span>}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            {(leadCount>0||leadVal>0) ? <span className="text-[12px] font-bold text-blue-600">{leadVal>0?fmt(leadVal):`${leadCount}`}</span> : <span className="text-slate-300 text-xs">—</span>}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            {lastActivityDate ? (
                              <div>
                                <p className="text-[11px] font-semibold text-slate-700">{lastActivityDate}</p>
                                {lastActivityType && <p className="text-[10px] text-slate-400">via {lastActivityType}</p>}
                              </div>
                            ) : <span className="text-slate-300 text-xs">—</span>}
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap">
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${c.status==='Active'?'bg-emerald-100 text-emerald-700':c.status==='Prospect'?'bg-sky-100 text-sky-700':'bg-gray-100 text-gray-500'}`}>
                              {c.status||'—'}
                            </span>
                          </td>
                        </tr>
                      )
                    })
                  }
                </tbody>
              </table>
            </div>
          </div>
        )}
      </SlidePanel>}

      {reopenTarget&&(
        <ReopenActivityModal
          activity={reopenTarget}
          onClose={()=>setReopenTarget(null)}
          onSuccess={(updated)=>{setActDetailPopup(updated)}}
        />
      )}

      {/* ── Controls ─────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-[0_8px_22px_rgba(15,23,42,0.07)] sm:px-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <BarChart2 size={22} strokeWidth={2.2} className="text-blue-600"/>
              <h2 className="m-0 text-2xl font-bold leading-tight tracking-[0] text-gray-900">{kamLabel} Dashboard</h2>
            </div>
            <p className="mt-1 text-sm font-normal leading-tight text-gray-500">
              {selectedUid ? selectedMemberName || 'Selected Sales Member' : 'All Team Members'} &middot; {reportPeriodLabel}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <button onClick={()=>setViewMode('normal')} className={`inline-flex h-9 items-center gap-1.5 rounded-2xl px-3 text-[12px] font-bold transition-all ${viewMode==='normal'?'bg-white text-slate-950 shadow-[0_7px_18px_rgba(15,23,42,0.08)]':'text-slate-600 hover:bg-slate-50'}`}>
              <LayoutGrid size={14}/>Normal
            </button>
            <button onClick={()=>setViewMode('advanced')} className={`inline-flex h-9 items-center gap-1.5 rounded-2xl px-3 text-[12px] font-bold transition-all ${viewMode==='advanced'?'bg-white text-slate-950 shadow-[0_7px_18px_rgba(15,23,42,0.08)]':'text-slate-600 hover:bg-slate-50'}`}>
              <Sparkles size={14}/>Advanced
            </button>
          </div>
        </div>

        <div className="mt-4 border-t border-slate-200 pt-3">
          <div className="flex w-full min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">
            <button
              type="button"
              onClick={()=>canSetTgt&&setShowTargetModal(true)}
              disabled={!canSetTgt}
              className={`mr-1 inline-flex h-8 shrink-0 items-center gap-1 rounded-xl border px-2.5 text-[11px] font-bold transition-colors ${canSetTgt?'border-indigo-100 bg-indigo-50 text-indigo-600 hover:bg-indigo-100':'border-slate-200 bg-slate-50 text-slate-400'}`}
            >
              <Target size={12}/>Set Target
            </button>
            <div className="inline-flex h-9 shrink-0 rounded-xl bg-slate-100 p-1">
              {([
                {id:'week',label:'Week'},
                {id:'month',label:'Month'},
                {id:'year',label:'Year'},
                {id:'range',label:'Range'},
              ] as const).map(v=>(
                <button type="button" key={v.id} onClick={()=>{setRangeMode(v.id);setIsYearly(v.id==='year')}}
                  className={`h-7 rounded-lg px-2.5 text-[11px] font-bold transition-all ${rangeMode===v.id?'bg-white text-slate-950 shadow-sm':'text-slate-600 hover:text-slate-950'}`}>{v.label}</button>
              ))}
            </div>
            <div
              className={`relative inline-flex h-9 min-w-0 shrink items-center rounded-xl border border-[#dbe4f0] bg-white px-3 text-[11px] font-bold text-slate-950 shadow-sm ${rangeMode==='week'?'basis-[210px] max-w-[210px] cursor-pointer pr-8':rangeMode==='range'?'basis-[286px] max-w-[286px]':rangeMode==='month'?'basis-[176px] max-w-[176px] cursor-pointer pr-8':'basis-[92px] max-w-[92px]'}`}
              onClick={()=>{
                if(rangeMode==='week') openDatePicker(weekStartInputRef.current)
                if(rangeMode==='month') openPeriodMonthPicker()
              }}
            >
              {rangeMode==='week'&&(<><input ref={weekStartInputRef} type="date" value={weekStart} onChange={e=>handleWeekStartChange(e.target.value)} className="pointer-events-none absolute inset-0 opacity-0"/><span className="pointer-events-none">{compactRangeLabel(weekStart, weekEndIso(weekStart))}</span></>)}
              {rangeMode==='month'&&(<><input ref={periodMonthInputRef} type="month" value={period} onChange={e=>handlePeriodMonthChange(e.target.value)} className="pointer-events-none absolute inset-0 opacity-0"/><span className="pointer-events-none">{reportPeriodLabel}</span></>)}
              {rangeMode==='year'&&(<input type="number" value={viewYear} onChange={e=>setViewYear(parseInt(e.target.value)||new Date().getFullYear())} min={2020} max={2035} className="w-full bg-transparent outline-none"/>)}
              {rangeMode==='range'&&(
                <div className="grid w-full items-center gap-2" style={{gridTemplateColumns:'minmax(0,1fr) auto minmax(0,1fr)'}}>
                  <span className="relative inline-flex min-w-0 cursor-pointer items-center gap-1.5" onClick={()=>openDatePicker(customFromInputRef.current)}>
                    <input ref={customFromInputRef} type="date" value={customFrom} onChange={e=>handleCustomFromChange(e.target.value)} className="pointer-events-none absolute inset-0 opacity-0"/>
                    <span className="pointer-events-none truncate">{compactDateLabel(customFrom)}</span>
                    <Calendar size={12} className="pointer-events-none shrink-0 text-slate-700"/>
                  </span>
                  <span className="text-slate-300">to</span>
                  <span className="relative inline-flex min-w-0 cursor-pointer items-center gap-1.5" onClick={()=>openDatePicker(customToInputRef.current)}>
                    <input ref={customToInputRef} type="date" value={customTo} onChange={e=>handleCustomToChange(e.target.value)} className="pointer-events-none absolute inset-0 opacity-0"/>
                    <span className="pointer-events-none truncate">{compactDateLabel(customTo)}</span>
                    <Calendar size={12} className="pointer-events-none shrink-0 text-slate-700"/>
                  </span>
                </div>
              )}
              {rangeMode!=='year'&&rangeMode!=='range'&&<Calendar size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-900"/>}
            </div>
            <select value={selectedGroupKey} onChange={e=>{setSelectedGroupKey(e.target.value);setExpandedMember(null)}} className={`h-9 min-w-[118px] max-w-[180px] flex-[1_1_150px] truncate rounded-xl border px-3 text-[11px] font-bold shadow-sm outline-none focus:border-blue-400 ${selectedGroupKey?'border-blue-300 bg-blue-50 text-blue-700':'border-[#dbe4f0] bg-white text-slate-950'}`}>
              <option value="">All Groups</option>
              {groupOptions.map(group=><option key={group.key} value={group.key}>{group.label}</option>)}
            </select>
            <select value={selectedSegment} onChange={e=>setSelectedSegment(e.target.value)} className={`h-9 min-w-[140px] max-w-[240px] flex-[1.15_1_190px] truncate rounded-xl border px-3 text-[11px] font-bold shadow-sm outline-none focus:border-blue-400 ${selectedSegment?'border-blue-300 bg-blue-50 text-blue-700':'border-[#dbe4f0] bg-white text-slate-950'}`}>
              <option value="">All Segments</option>
              {segmentOptions.map(segment=><option key={segment.key} value={segment.key}>{segment.label}</option>)}
            </select>
            <select value={selectedLocation} onChange={e=>setSelectedLocation(e.target.value)} className={`h-9 min-w-[118px] max-w-[180px] flex-[1_1_150px] truncate rounded-xl border px-3 text-[11px] font-bold shadow-sm outline-none focus:border-blue-400 ${selectedLocation?'border-blue-300 bg-blue-50 text-blue-700':'border-[#dbe4f0] bg-white text-slate-950'}`}>
              <option value="">All Locations</option>
              {locationOptions.map(location=><option key={location.key} value={location.key}>{location.label}</option>)}
            </select>
            {canViewTeam&&visibleTeamMembers.length>0&&(<select value={selectedUid||''} onChange={e=>{const v=e.target.value?parseInt(e.target.value):null;setSelectedUid(v);setExpandedMember(v)}} className={`h-9 min-w-[145px] max-w-[220px] flex-[1_1_180px] truncate rounded-xl border px-3 text-[11px] font-bold shadow-sm outline-none focus:border-blue-400 ${selectedUid?'border-blue-300 bg-blue-50 text-blue-700':'border-[#dbe4f0] bg-white text-slate-950'}`}><option value="">All Sales Members</option>{visibleTeamMembers.map((u:any)=><option key={u.id} value={u.id}>{u.full_name}</option>)}</select>)}
            <button onClick={()=>{setSelectedUid(null);setExpandedMember(null);setSelectedCustId(null);setSelectedGroupKey('');setSelectedSegment('');setSelectedLocation('');setRangeMode('month');setIsYearly(false)}} className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-xl px-1.5 text-[10px] font-bold text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"><X size={11}/>Reset</button>
          </div>
        </div>
      </div>

      <div className="hidden">
        <div>
          <h2 className="text-base font-bold text-gray-800 flex items-center gap-2"><BarChart2 size={16} className="text-blue-500"/>{kamLabel} Dashboard</h2>
          {perf?.user_name&&<p className="text-xs text-gray-400 mt-0.5">{perf.is_aggregate?<span className="text-blue-600 font-semibold">All Team Members</span>:`${perf.user_name} · ${perf.user_role}`}</p>}
        </div>
        <div className="flex w-full min-w-0 flex-nowrap items-center gap-1.5 whitespace-nowrap">
          {canSetTgt&&(
            <button onClick={()=>setShowTargetModal(true)} className="flex shrink-0 items-center gap-1 px-2.5 py-1.5 text-xs bg-indigo-50 text-indigo-600 hover:bg-indigo-100 rounded-xl font-semibold border border-indigo-100 transition-colors">
              <Target size={12}/>Set Target
            </button>
          )}
          {/* Normal / Advanced toggle */}
          <div className="flex shrink-0 items-center gap-0.5 bg-gray-100 rounded-xl p-1">
            <button onClick={()=>setViewMode('normal')} className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${viewMode==='normal'?'bg-white text-gray-800 shadow-sm':'text-gray-500'}`}>
              <LayoutGrid size={11}/>Normal
            </button>
            <button onClick={()=>setViewMode('advanced')} className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${viewMode==='advanced'?'bg-white text-violet-700 shadow-sm':'text-gray-500'}`}>
              <Sparkles size={11}/>Advanced
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-0.5 bg-gray-100 rounded-xl p-1">
            {([
              {id:'week',label:'Week'},
              {id:'month',label:'Month'},
              {id:'year',label:'Year'},
              {id:'range',label:'Range'},
            ] as const).map(v=>(
              <button key={v.id} onClick={()=>{setRangeMode(v.id);setIsYearly(v.id==='year')}}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${rangeMode===v.id?'bg-white text-gray-800 shadow-sm':'text-gray-500'}`}>{v.label}</button>
            ))}
          </div>
          <div className={`flex h-10 shrink-0 items-center ${rangeMode==='week'||rangeMode==='range'?'w-[276px]':rangeMode==='month'?'w-[180px]':'w-[110px]'}`}>
            {rangeMode==='week'&&(
              <div className="grid w-full items-center gap-1" style={{gridTemplateColumns:'130px auto 130px'}}>
                <input type="date" value={weekStart} onChange={e=>setWeekStart(e.target.value)} className="min-w-0 w-[130px] text-xs border border-gray-200 rounded-xl px-2 py-2 focus:outline-none focus:border-blue-400 bg-white"/>
                <span className="text-xs text-gray-300">to</span>
                <input type="date" value={weekEndIso(weekStart)} readOnly tabIndex={-1} className="min-w-0 w-[130px] text-xs border border-gray-200 rounded-xl px-2 py-2 focus:outline-none bg-gray-50 text-gray-500"/>
              </div>
            )}
            {rangeMode==='month'&&(
              <input type="month" value={period} onChange={e=>setPeriod(e.target.value)} className="w-[180px] text-xs border border-gray-200 rounded-xl px-2.5 py-2 focus:outline-none focus:border-blue-400 bg-white"/>
            )}
            {rangeMode==='year'&&(
              <input type="number" value={viewYear} onChange={e=>setViewYear(parseInt(e.target.value)||new Date().getFullYear())} min={2020} max={2035} className="w-[110px] text-xs border border-gray-200 rounded-xl px-2.5 py-2 focus:outline-none focus:border-blue-400 bg-white"/>
            )}
            {rangeMode==='range'&&(
              <div className="grid w-full items-center gap-1" style={{gridTemplateColumns:'130px auto 130px'}}>
                <input type="date" value={customFrom} onChange={e=>setCustomFrom(e.target.value)} className="min-w-0 w-[130px] text-xs border border-gray-200 rounded-xl px-2 py-2 focus:outline-none focus:border-blue-400 bg-white"/>
                <span className="text-xs text-gray-300">to</span>
                <input type="date" value={customTo} onChange={e=>setCustomTo(e.target.value)} className="min-w-0 w-[130px] text-xs border border-gray-200 rounded-xl px-2 py-2 focus:outline-none focus:border-blue-400 bg-white"/>
              </div>
            )}
          </div>
          {popupCustomers.length>0&&(
            <select value={selectedCustId||''} onChange={e=>setSelectedCustId(e.target.value?parseInt(e.target.value):null)}
              className="w-[160px] shrink-0 text-xs border border-gray-200 rounded-xl px-2.5 py-2 focus:outline-none focus:border-blue-400 bg-white">
              <option value="">All {customerLabel}</option>
              {popupCustomers.map((c:any)=><option key={c.id} value={c.id}>{c.customer_name}</option>)}
            </select>
          )}
          {canViewTeam&&visibleTeamMembers.length>0&&(
            <select value={selectedUid||''} onChange={e=>{const v=e.target.value?parseInt(e.target.value):null;setSelectedUid(v);setExpandedMember(v)}}
              className={`w-[180px] shrink-0 text-xs border rounded-xl px-2.5 py-2 focus:outline-none focus:border-blue-400 bg-white ${selectedUid?'border-blue-300 bg-blue-50 text-blue-700':'border-gray-200'}`}>
              <option value="">All Sales Members</option>
              {visibleTeamMembers.map((u:any)=><option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* ── ADVANCED MODE ──────────────────────────────────────────────────── */}
      {viewMode==='advanced'&&canViewTeam&&(
        <AdvancedKAM360Tab
          teamMembers={teamMembers}
          teamRows={selectedGroupKey ? filteredSalesTeamRows : teamRows}
          masterGroups={masterGroups}
          customerRows={allCustomerRows}
          period={period}
          isYearly={isYearly}
          viewYear={viewYear}
          dateLabel={dateLabel}
          requestPeriod={requestPeriod}
          requestViewType={requestViewType}
          dateFrom={dateRange.dateFrom}
          dateTo={dateRange.dateTo}
          onLeadPanel={openLeadPanel}
          onTenderPanel={openTenderPanel}
          onCustomerPanel={openCustomerPanel}
          onGroupCustomerPanel={openGroupCustomerPanel}
          onGroupLeadPanel={openGroupLeadPanel}
          onGroupTenderPanel={openGroupTenderPanel}
          onGroupWorkOrderPanel={openGroupWorkOrderPanel}
          onActivityPanel={openActPanel}
          selectedUid={selectedUid}
          setSelectedUid={setSelectedUid}
          onNavigate={onNavigate}
          loading={loading}
          customerTotal={s.customers ?? 0}
          customerPotentialValue={s.customer_potential_value ?? 0}
          onTableMonthChange={(nextPeriod:string)=>{
            setRangeMode('month')
            setIsYearly(false)
            setPeriod(nextPeriod)
            const nextYear=Number(String(nextPeriod).slice(0,4))
            if(nextYear) setViewYear(nextYear)
          }}
          onTableYearChange={(nextYear:number)=>{
            setRangeMode('year')
            setIsYearly(true)
            setViewYear(nextYear)
          }}
        />
      )}

      {/* ── NORMAL MODE ────────────────────────────────────────────────────── */}
      {viewMode==='normal'&&(
        <>
          <section>
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_8px_22px_rgba(15,23,42,0.04)]">
              <div className={`grid grid-cols-1 ${showTargetCard?'lg:grid-cols-2':'lg:grid-cols-1'}`}>
                {showTargetCard&&(
                  <div className="flex min-h-[54px] min-w-0 flex-col items-start gap-2 border-b border-slate-200 px-5 py-1.5 sm:flex-row sm:items-center sm:gap-4 lg:border-b-0">
                    <div className="shrink-0 sm:min-w-[180px]">
                      <div className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">{targetCardTitle}</div>
                    </div>
                    <div className="min-w-0 flex-1 self-stretch">
                      <div className="flex h-full w-full min-w-0 flex-wrap items-center justify-between gap-2.5 sm:flex-nowrap">
                        <div className="min-w-0 shrink-0 text-[20px] font-black leading-none tabular-nums text-slate-950">
                          {fmt(baselineTargetRevenue)} <span className="text-[13px] font-black text-slate-400">/ {fmt(baselineTargetValue)}</span>
                        </div>
                        <div className="min-w-[170px] flex-1">
                          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={`h-full rounded-full transition-all duration-700 ${baselineTargetValue<=0?'bg-slate-300':'bg-teal-500'}`}
                              style={{width:`${baselineTargetValue>0?Math.max(baselineTargetPct,2):0}%`}}
                            />
                          </div>
                          <div className="mt-1 truncate text-center text-[9px] font-bold leading-none text-slate-400">{baselineTargetStatus}</div>
                        </div>
                        <div className="shrink-0 text-[18px] font-black leading-none tabular-nums text-teal-600">{baselineTargetPct}%</div>
                      </div>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={()=>openCustomerPanel(selectedUid||undefined, selectedMemberName, false)}
                  className={`flex min-h-[54px] min-w-0 items-center justify-between gap-3 border-slate-200 px-5 py-1.5 text-left transition hover:bg-slate-50 ${showTargetCard?'lg:border-l':''}`}
                >
                  <div
                    className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full"
                    style={{background:`conic-gradient(#10b981 ${Math.min(100,Math.max(0,accountCoveragePct))*3.6}deg,#edf2f7 0deg)`}}
                  >
                    <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-white text-[10px] font-black text-slate-950 shadow-sm">{accountCoveragePct}%</span>
                  </div>
                  <div className="min-w-0 flex flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[13px]">
                    <span className="font-black text-slate-950">{customerLabel} worked</span>
                    <span className="inline-flex items-center gap-2 font-bold text-slate-900">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      {activeWithPipeline} <span className="font-medium">active with pipeline</span>
                    </span>
                    <span className="inline-flex items-center gap-2 font-black text-slate-950">
                      <span className="h-2 w-2 rounded-full bg-red-500" />
                      {untappedAccounts}+ <span className="font-medium text-slate-400">untapped</span>
                    </span>
                  </div>
                </button>
              </div>

              <div className="grid min-h-[92px] grid-cols-1 border-t border-slate-200 sm:grid-cols-2 lg:grid-cols-5">
                {pipelineStages.map((stage:any,idx:number)=>{
                  const showConversion = idx>0
                  const conversion = showConversion
                    ? conversionForArrow(stage.key, Number(stage.count||0), Number(pipelineStages[idx-1]?.count||0))
                    : null
                  return (
                    <button
                      key={stage.key}
                      type="button"
                      onClick={stage.onClick}
                      disabled={!stage.onClick}
                      className={`group relative flex min-w-0 flex-col items-center justify-center overflow-visible border-b border-slate-200 px-5 py-2.5 text-center transition last:border-b-0 sm:[&:nth-last-child(-n+1)]:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0 ${stage.onClick?'cursor-pointer hover:bg-slate-50':'cursor-default'}`}
                    >
                      {conversion!==null&&(
                        <span className="pointer-events-none absolute left-0 top-1/2 z-10 hidden -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 lg:flex">
                          <span className="rounded-full bg-white px-1.5 py-0.5 text-[9px] font-black leading-none tabular-nums text-slate-400 shadow-sm ring-1 ring-slate-100">
                            {conversion}%
                          </span>
                          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-slate-100 bg-slate-50 text-slate-950 shadow-sm">
                            <ArrowRight size={13} strokeWidth={2.6} />
                          </span>
                        </span>
                      )}
                      <div className="flex w-full min-w-0 items-center justify-center gap-3">
                        <div className="truncate text-center text-[11px] font-black uppercase tracking-[0.10em] text-slate-400">{stage.label}</div>
                        {conversion!==null&&(
                          <span className="shrink-0 rounded-full bg-slate-50 px-1.5 py-0.5 text-[9px] font-black tabular-nums text-slate-400 ring-1 ring-slate-100 lg:hidden">
                            {conversion}%
                          </span>
                        )}
                      </div>
                      <div className="mt-2.5 flex max-w-full flex-col items-center justify-center gap-1">
                        <div className="max-w-full truncate text-center text-[24px] font-black leading-none tabular-nums text-slate-950">
                          {stage.count.toLocaleString('en-IN')}
                        </div>
                        <div className={`max-w-full truncate text-center text-[12px] font-black leading-none tabular-nums ${stage.value>0?'text-teal-600':'text-slate-400'}`}>
                          {stage.value>0?fmt(stage.value):'-'}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>

              <div className="flex min-w-0 flex-col gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-2.5 xl:flex-row xl:items-center">
                <div className="shrink-0 text-[11px] font-black uppercase tracking-[0.10em] text-slate-400">Activity Breakdown</div>
                <div className="hidden h-5 w-px shrink-0 bg-slate-200 xl:block" />
                <div className="flex min-w-0 flex-1 items-center justify-between gap-2 overflow-x-auto whitespace-nowrap">
                  {[
                    {type:'Phone Call', label:'Calls'},
                    {type:'Video Call', label:'Video Calls'},
                    {type:'Email', label:'Emails'},
                    {type:'In Person Meet', label:'Meetings'},
                    {type:'Demo', label:'Demos'},
                    {type:'Follow Up', label:'Follow-ups'},
                    {type:'Site Visit', label:'Visits'},
                  ].map((tile,idx)=>{
                    const count=activityBreakdown?.[tile.type]||0
                    const active=actTypeFilter===tile.type
                    const tone=TYPE_COLOR[tile.type]||{bg:'bg-slate-50',text:'text-slate-500'}
                    return (
                      <Fragment key={tile.type}>
                        {idx>0&&<span className="hidden h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300 xl:inline-block" />}
                        <button
                          type="button"
                          onClick={()=>openActPanel(tile.type, selectedUid||undefined)}
                          className={`inline-flex min-w-max shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 py-0.5 text-[12px] font-black transition hover:brightness-95 ${tone.bg} ${tone.text} ${active?'border-blue-300 ring-2 ring-blue-100':'border-transparent'}`}
                        >
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center">{TYPE_ICON[tile.type] || <Activity size={12}/>}</span>
                          <span className="text-[13px] font-black tabular-nums">{count}</span>
                          <span className="truncate">{tile.label}</span>
                        </button>
                      </Fragment>
                    )
                  })}
                </div>
              </div>
            </div>
            {false&&actTypeFilter&&(()=>{
              const filtered=(perf?.recent_activities||[]).filter((a:any)=>a.type===actTypeFilter)
              return filtered.length>0?(
                <div className="mt-4 border-t border-gray-100 pt-4 space-y-2">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-gray-500">{actTypeFilter} activities ({filtered.length})</p>
                    <button onClick={()=>onNavigate('activities',{activityType:actTypeFilter,userId:selectedUid,period,isYearly,viewYear,dateFrom:dateRange.dateFrom,dateTo:dateRange.dateTo})}
                      className="text-xs text-blue-600 hover:text-blue-700 font-semibold flex items-center gap-1 px-2 py-1 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors">
                      View all <ChevronRight size={11}/>
                    </button>
                  </div>
                  {filtered.map((a:any)=>(
                    <div key={a.id} onClick={()=>setActDetailPopup(a)}
                      className="flex items-center gap-3 px-3 py-2 bg-gray-50 rounded-xl text-xs cursor-pointer hover:bg-blue-50/40 transition-colors">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${a.status==='Completed'?'bg-emerald-500':a.status==='Cancelled'?'bg-red-400':'bg-amber-400'}`}/>
                      <span className="font-semibold text-gray-800 flex-1 truncate">{a.subject}</span>
                      {a.user_name&&<span className="text-gray-400 flex-shrink-0">{a.user_name}</span>}
                      <span className="text-gray-400 flex-shrink-0">{a.date}</span>
                      <span className={`px-1.5 py-0.5 rounded-lg font-semibold flex-shrink-0 ${a.status==='Completed'?'bg-emerald-50 text-emerald-600':a.status==='Cancelled'?'bg-red-50 text-red-500':'bg-amber-50 text-amber-600'}`}>{a.status}</span>
                    </div>
                  ))}
                </div>
              ):(<p className="mt-4 text-xs text-gray-400 text-center pt-3 border-t border-gray-100">No {actTypeFilter} activities in this period</p>)
            })()}
          </section>

          <CustomerSegmentAnalysisSection
            sectionTitle={`${customerLabel} Segment Analysis`}
            subtitle=""
            accentBar="#3b82f6"
            icon={PieChart}
            tabs={[
              { id: 'segment', label: 'Segment', groupColLabel: 'Segment', accentBar: '#3b82f6', groupKeys: ['vertical','customer_vertical','segment','industry'] },
            ]}
            stateRows={customerStateRows}
            portfolioValueFn={portfolioValue}
            portfolioLabelFn={portfolioLabel}
            fmtFn={fmt}
            masterSegments={summary?.portfolio_mix?.master_segments || []}
            masterStateMap={masterStateMap}
            masterRegionNames={masterRegionNames}
            masterAllStates={masterAllStates}
            masterStateDistricts={masterStateDistricts}
            masterSegmentSubSegments={masterSegmentSubSegments}
            masterSources={summary?.portfolio_mix?.master_sources || []}
            teamMembers={teamMembers}
            teamRows={teamRows}
            fiscalYear={viewYear}
            fiscalYearOptions={analysisFiscalYearOptions}
            onFiscalYearChange={handleAnalysisFiscalYearChange}
            onViewCustomers={(label, customers) => {
              setLocationCustomerPanelRows(label, customers)
              setCustomerPanel(true)
              setPanelLoading(false)
            }}
            onLoadUnitRecords={async (kind, _unitLabel, _verticalLabel, customerIds, meta) => (
              loadPipelineRecords(kind, undefined, undefined, customerIds, {
                allTime: Boolean(meta?.allTime),
                customerScopeOnly: Boolean(meta?.customerScopeOnly),
              })
            )}
          />

          {/* ── Business Vertical Analysis ── */}
          <CustomerSegmentAnalysisSection
            sectionTitle="Business Vertical Analysis"
            subtitle=""
            accentBar="#8b5cf6"
            icon={PieChart}
            tabs={[
              { id: 'business', label: 'Business Unit', groupColLabel: 'Vertical', accentBar: '#8b5cf6', groupKeys: ['business_vertical','business_unit_category','vertical','customer_vertical'], secondaryGroupKeys: ['business_unit','business_unit_name'] },
            ]}
            stateRows={customerStateRows}
            portfolioValueFn={portfolioValue}
            portfolioLabelFn={portfolioLabel}
            fmtFn={fmt}
            masterStateMap={masterStateMap}
            masterRegionNames={masterRegionNames}
            masterAllStates={masterAllStates}
            masterStateDistricts={masterStateDistricts}
            masterUnitVertical={masterUnitVertical}
            masterVerticalUnits={masterVerticalUnits}
            businessUnitAnalysis={summary?.portfolio_mix?.business_unit_analysis}
            teamMembers={teamMembers}
            teamRows={teamRows}
            fiscalYear={viewYear}
            fiscalYearOptions={analysisFiscalYearOptions}
            onFiscalYearChange={handleAnalysisFiscalYearChange}
            onViewCustomers={(label, customers) => {
              setLocationCustomerPanelRows(label, customers)
              setCustomerPanel(true)
              setPanelLoading(false)
            }}
            onLoadUnitRecords={async (kind, _unitLabel, _verticalLabel, customerIds, meta) => {
              const cidParam = customerIds.length ? customerIds.join(',') : undefined
              const unitParam = meta?.unitId ? { business_unit_id: String(meta.unitId) } : {}
              const rangeParams = { period: requestPeriod, view_type: requestViewType, year: viewYear, date_from: dateRange.dateFrom, date_to: dateRange.dateTo }
              return api.get('/kam/pipeline-records', {
                params: {
                  kind,
                  ...rangeParams,
                  ...unitParam,
                  ...(cidParam ? { customer_ids: cidParam } : {}),
                  ...(meta?.allTime ? { all_time: true } : {}),
                  ...(meta?.customerScopeOnly ? { customer_scope_only: true } : {}),
                },
              }).then(r => Array.isArray(r.data) ? r.data : [])
            }}
          />

          {/* Customer location intelligence */}
          <div className="rounded-2xl border border-gray-200 bg-white px-5 py-5">
            <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="flex items-center gap-2 text-sm font-bold text-gray-900">
                  <MapPin size={14} className="text-rose-500"/>{customerLabel} Location Intelligence
                </h3>
                <span className="text-[11px] font-medium text-slate-400">India - Master Locations + map detail</span>
              </div>
              <span className="text-[11px] font-black text-slate-500">
                {allCustomerTotal.toLocaleString('en-IN')} {customerLabelLower} - {mappedStateCustomerTotal.toLocaleString('en-IN')} mapped
              </span>
            </div>

            {customerStateRows.length>0 ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.9fr)]">
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                  <CustomerIndiaGeoJsonMap
                    states={customerStateMap}
                    masterStates={masterAllStates}
                    masterStateDistricts={masterStateDistricts}
                    onSelect={openStateCustomers}
                    onSelectDistrict={(districtName, stateName) => {
                      const stateKey = normalizeStateKey(stateName)
                      const stateRow = customerStateMap[stateKey]
                      if(!stateRow) return
                      const distKey = normalizeDistrictKey(districtName)
                      const districtCustomers = (stateRow.customers || []).filter((c:any) => {
                        return customerDistrictMapKey(c) === distKey
                      })
                      openStateCustomersList(
                        `${districtName}, ${stateName}`,
                        districtCustomers.length > 0 ? districtCustomers : stateRow.customers,
                      )
                    }}
                  />
                </div>

                <div className="h-[520px] max-h-[520px] overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <div className="grid grid-cols-[minmax(0,1fr)_72px_94px_74px] border-b border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-black uppercase tracking-wide text-slate-500">
                    <span>State</span>
                    <span className="text-right">{customerLabel}</span>
                    <span className="text-right">Potential</span>
                    <span className="text-right">Action</span>
                  </div>
                  <div className="h-[482px] overflow-y-auto divide-y divide-slate-100">
                  {customerStateRows.filter((row:any) => Number(row.count || 0) > 0).map((row:any)=>(
                    <button
                      key={`${row.key}-${row.label}`}
                      type="button"
                      onClick={()=>openStateCustomers(row.label)}
                      className="grid w-full grid-cols-[minmax(0,1fr)_72px_94px_74px] items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-rose-50/60 focus:bg-rose-50 focus:outline-none"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-rose-50 text-rose-500">
                          <MapPin size={13}/>
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-black text-slate-900">{row.label}</span>
                          <span className="mt-1 flex flex-wrap gap-1">
                            <span className="rounded-md bg-violet-50 px-1.5 py-0.5 text-[9px] font-black text-violet-600">
                              {Number(row.leadCount||0)} {leadLabelLower}
                            </span>
                            <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-[9px] font-black text-blue-600">
                              {Number(row.opportunityCount||0)} {opportunityLabelLower}
                            </span>
                            <span className="rounded-md bg-orange-50 px-1.5 py-0.5 text-[9px] font-black text-orange-600">
                              {Number(row.tenderCount||0)} {tenderLabelLower}
                            </span>
                          </span>
                        </span>
                      </span>
                      <span className="text-right text-[13px] font-black tabular-nums text-slate-950">{Number(row.count).toLocaleString('en-IN')}</span>
                      <span className="text-right text-[12px] font-black tabular-nums text-emerald-600">{fmt(row.value)}</span>
                      <span className="inline-flex items-center justify-end gap-1 text-[11px] font-black text-blue-600">
                        View <ChevronRight size={13}/>
                      </span>
                    </button>
                  ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm font-semibold text-slate-400">
                No mapped {customerLabelLower} locations for this period
              </div>
            )}
          </div>

          {canViewTeam&&groupedSalesTeamRows.length>0&&(
            <div>
              <div className="mb-3 flex items-center gap-2">
                <h3 className="flex items-center gap-2 text-sm font-bold text-gray-900">
                  <Users size={16} className="text-blue-600"/>Sales Team Performance
                </h3>
                <span className="text-xs font-medium text-slate-400">group wise</span>
              </div>
              <SalesTeamPerformanceBlock
                groups={groupedSalesTeamRows}
                onCustomerPanel={openCustomerPanel}
                onLeadPanel={openLeadPanel}
                onTenderPanel={openTenderPanel}
                onWorkOrderPanel={openWorkOrderPanel}
                onGroupCustomerPanel={openGroupCustomerPanel}
                onGroupLeadPanel={openGroupLeadPanel}
                onGroupTenderPanel={openGroupTenderPanel}
                onGroupWorkOrderPanel={openGroupWorkOrderPanel}
                onActivityPanel={openActPanel}
                onMemberDetails={openMemberDetailsPanel}
                memberRecordSummaries={memberRecordSummaries}
              />
            </div>
          )}

          {/* Team member rows */}
           {/* Team member rows — single line flat card */}
          {false&&canViewTeam&&filteredSalesTeamRows.length>0&&(
            <div>
              <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2"><Users size={14} className="text-blue-500"/>Sales Team Performance</h3>
              <div className="space-y-2.5">
                {(selectedUid ? filteredSalesTeamRows.filter((m:any)=>m.user_id===selectedUid) : filteredSalesTeamRows).map((m:any)=>{
                  const targetRevenue=m.wo_value||m.won_tender_value||0
                  const salesPct2=m.sales_target>0?pct(targetRevenue,m.sales_target):0
                  const totalCusts=m.own_customers??m.customers??0
                  const custPotential=(m.lead_value||0)+(m.tender_value||0)

                  return(
                        <div key={m.user_id} className={`bg-white rounded-2xl border overflow-hidden ${m.is_self?'border-blue-200 bg-blue-50/20':'border-gray-200'}`}>
                      <div className="flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-2 px-4 py-3">
                        {/* Avatar + Name section — stays aligned top on all screens */}
                        <div className="flex items-center gap-2 min-w-0">
                          <div className={`w-11 h-11 rounded-xl flex items-center justify-center text-sm font-bold text-white flex-shrink-0 ${m.is_self?'bg-gradient-to-br from-blue-500 to-indigo-600':'bg-gradient-to-br from-slate-400 to-slate-600'}`}>
                            {m.user_name?.charAt(0)?.toUpperCase()}
                          </div>
                          {/* Name */}
                          <div className="min-w-0 flex-shrink-0 lg:min-w-[170px]">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-sm font-bold text-gray-900 truncate">{m.user_name}</span>
                              {m.is_self&&<span className="text-[10px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-bold">YOU</span>}
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                              <RoleBadge role={m.role}/>
                              <span className="flex items-center gap-1 text-[11px] text-gray-400"><Activity size={9}/>{m.completed}/{m.total} done</span>
                            </div>
                          </div>
                        </div>

                        <div className="hidden lg:block w-px h-8 bg-gray-100 flex-shrink-0"/>

                        {/* Activity type icons — always aligned properly */}
                        <div className="flex items-center gap-1 flex-shrink-0 lg:w-max overflow-x-auto pb-1 lg:pb-0">
                          {[
                            {icon:<PhoneCall size={12}/>,val:m.calls||0,color:'text-blue-500',bg:'bg-blue-50',hover:'hover:bg-blue-100',actType:'Phone Call',label:'Calls'},
                            {icon:<Video size={12}/>,val:m.video_calls||0,color:'text-cyan-500',bg:'bg-cyan-50',hover:'hover:bg-cyan-100',actType:'Video Call',label:'Video Calls'},
                            {icon:<Handshake size={12}/>,val:m.meetings||0,color:'text-violet-500',bg:'bg-violet-50',hover:'hover:bg-violet-100',actType:'In Person Meet',label:'Meetings'},
                            {icon:<Monitor size={12}/>,val:m.demos||0,color:'text-emerald-500',bg:'bg-emerald-50',hover:'hover:bg-emerald-100',actType:'Demo',label:'Demos'},
                            {icon:<Navigation size={12}/>,val:m.site_visits||0,color:'text-orange-500',bg:'bg-orange-50',hover:'hover:bg-orange-100',actType:'Site Visit',label:'Site Visits'},
                            {icon:<Repeat2 size={12}/>,val:m.follow_ups||0,color:'text-amber-500',bg:'bg-amber-50',hover:'hover:bg-amber-100',actType:'Follow Up',label:'Follow Ups'},
                            {icon:<Mail size={12}/>,val:m.emails||0,color:'text-gray-500',bg:'bg-gray-100',hover:'hover:bg-gray-200',actType:'Email',label:'Emails'},
                          ].map(({icon,val,color,bg,hover,actType,label})=>(
                            <button key={actType}
                              onClick={()=>openActPanel(actType,m.user_id,m.user_name)}
                              title={`${m.user_name} — ${label}`}
                              className={`inline-flex items-center justify-center gap-0.5 w-11 h-8 rounded-lg text-[11px] font-bold flex-shrink-0 cursor-pointer transition-colors ${color} ${bg} ${hover}`}>
                              {icon}{val}
                            </button>
                          ))}
                        </div>

                        <div className="hidden lg:block w-px h-8 bg-gray-100 flex-shrink-0"/>

                        {/* Revenue */}
                        <div className="flex-shrink-0 lg:min-w-[110px]">
                          <p className="text-[9px] text-gray-400 font-medium uppercase tracking-wide">Revenue</p>
                          <p className="text-lg font-black text-gray-900 leading-tight">
                            {fmt(m.wo_value||0)}
                            {m.sales_target>0&&<span className="text-gray-400 font-medium text-sm">/{fmt(m.sales_target)}</span>}
                          </p>
                          {m.sales_target>0&&(
                            <div className="flex items-center gap-1 mt-0.5">
                              <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden min-w-[60px]">
                                <div className={`h-full rounded-full ${salesPct2>=100?'bg-emerald-500':salesPct2>=70?'bg-blue-500':'bg-amber-400'}`} style={{width:`${Math.max(salesPct2,2)}%`}}/>
                              </div>
                              <span className={`text-[9px] font-bold flex-shrink-0 ${salesPct2>=100?'text-emerald-600':salesPct2>=70?'text-blue-600':'text-amber-600'}`}>{salesPct2}%</span>
                            </div>
                          )}
                        </div>

                        <div className="hidden lg:block w-px h-8 bg-gray-100 flex-shrink-0"/>

                          {/* Metric cards — scroll horizontally on mobile, flex on desktop */}
                        <div className="flex items-stretch gap-1.5 lg:flex-1 lg:min-w-0 overflow-x-auto pb-1 lg:pb-0 lg:overflow-visible">
                          {[
                            {label:'cust↗',   val:String(totalCusts),   sub:custPotential>0?fmt(custPotential):null,  color:'text-sky-700',    bg:'bg-sky-50 border-sky-200',    onClick:()=>openCustomerPanel(m.user_id,m.user_name,true)},
                            {label:'leads↗',  val:String(m.lead_count||0), sub:(m.lead_value||0)>0?fmt(m.lead_value):null, color:'text-violet-700', bg:'bg-violet-50 border-violet-200', onClick:()=>openLeadPanel(m.user_id,m.user_name)},
                            {label:'tenders↗',val:String(m.tender_count||0),sub:(m.tender_value||0)>0?fmt(m.tender_value):null,color:'text-orange-700',bg:'bg-orange-50 border-orange-200',onClick:()=>openTenderPanel(m.user_id,m.user_name)},
                            {label:'WO↗',     val:String(m.wo_count||0), sub:(m.wo_value||0)>0?fmt(m.wo_value):null,    color:'text-emerald-700',bg:'bg-emerald-50 border-emerald-200',onClick:()=>openWorkOrderPanel(m.user_id,m.user_name)},
                          ].map(({label,val,sub,color,bg,onClick})=>(
                            <div key={label}
                              onClick={onClick}
                              className={`flex-1 lg:flex-1 flex flex-col items-center justify-center py-2 px-1 rounded-xl border text-center min-w-[80px] lg:min-w-0 flex-shrink-0 lg:flex-shrink-1 ${bg} cursor-pointer hover:brightness-95 transition-all`}>
                              <p className={`text-sm font-bold leading-tight ${color}`}>{val}</p>
                              <p className={`text-[10px] font-semibold leading-tight ${color} opacity-70`}>{label}</p>
                              {sub&&<p className={`text-[10px] font-bold mt-0.5 ${color}`}>{sub}</p>}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}


          {/* Quarterly */}
          {false&&isYearly&&quarterly.length>0&&(
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2"><BarChart2 size={14} className="text-blue-500"/>Quarterly — {viewYear}</h3>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {quarterly.map((q:any)=>{
                  const cp=q.total>0?Math.round(q.completed/q.total*100):0
                  const bar=cp>=80?'bg-emerald-500':cp>=60?'bg-blue-500':cp>=40?'bg-amber-500':'bg-red-400'
                  return(
                    <div key={q.quarter} className="bg-gray-50 rounded-2xl p-4 border border-gray-100">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-bold text-gray-700">{q.label}</span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-lg ${cp>=80?'bg-emerald-100 text-emerald-700':cp>=60?'bg-blue-100 text-blue-700':'bg-amber-100 text-amber-700'}`}>{cp}%</span>
                      </div>
                      <div className="space-y-1 text-xs">
                        {([['Total',q.total,'text-gray-800'],['Done',q.completed,'text-emerald-600'],['Pending',q.pending,'text-amber-600'],['Calls',q.calls,'text-blue-600'],['Meetings',q.meetings,'text-violet-600']] as const).map(([l,v,col])=>(
                          <div key={l as string} className="flex justify-between"><span className="text-gray-500">{l}</span><span className={`font-bold ${col}`}>{v}</span></div>
                        ))}
                      </div>
                      <div className="mt-3 h-1.5 bg-gray-200 rounded-full overflow-hidden"><div className={`h-full rounded-full ${bar}`} style={{width:`${cp}%`}}/></div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}
      {stateDetailPopup && createPortal(
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 px-4 backdrop-blur-sm">
          <div className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4">
              <div className="min-w-0">
                <h3 className="truncate text-base font-black text-slate-950">{stateDetailPopup.label}</h3>
                <p className="mt-0.5 text-xs font-semibold text-slate-500">Location overview</p>
              </div>
              <button type="button" onClick={() => setStateDetailPopup(null)} className="rounded-lg p-2 text-slate-400 transition hover:bg-white hover:text-slate-700">
                <X size={18} />
              </button>
            </div>
            <div className="overflow-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-slate-200 bg-white text-[11px] font-black text-slate-500">
                    <th className="px-4 py-3">State</th>
                    <th className="px-2 py-3 text-center">{leadLabel}</th>
                    <th className="px-2 py-3 text-center">{opportunityLabel}</th>
                    <th className="px-2 py-3 text-center">{tenderLabel}</th>
                    <th className="px-4 py-3 text-right">Potential Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  <tr className="transition-colors hover:bg-violet-50/50">
                    <td className="px-4 py-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-100 text-[11px] font-black text-rose-700">
                          {stateDetailPopup.label.charAt(0).toUpperCase()}
                        </span>
                        <span className="truncate text-[12px] font-black text-slate-900">{stateDetailPopup.label}</span>
                      </div>
                      <div className="mt-1 pl-8 text-[10px] font-semibold text-slate-400">{stateDetailPopup.count.toLocaleString('en-IN')} {customerLabelLower}</div>
                    </td>
                    <td className="px-2 py-3 text-center">
                      <span className="inline-flex min-w-[42px] justify-center rounded-md bg-violet-50 px-1.5 py-0.5 text-[11px] font-black tabular-nums text-violet-700">
                        {stateDetailPopup.leadCount.toLocaleString('en-IN')}
                      </span>
                    </td>
                    <td className="px-2 py-3 text-center">
                      <span className="inline-flex min-w-[42px] justify-center rounded-md bg-sky-50 px-1.5 py-0.5 text-[11px] font-black tabular-nums text-sky-700">
                        {stateDetailPopup.opportunityCount.toLocaleString('en-IN')}
                      </span>
                    </td>
                    <td className="px-2 py-3 text-center">
                      <span className="inline-flex min-w-[42px] justify-center rounded-md bg-orange-50 px-1.5 py-0.5 text-[11px] font-black tabular-nums text-orange-700">
                        {stateDetailPopup.tenderCount.toLocaleString('en-IN')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-[12px] font-black tabular-nums text-slate-900">{fmt(stateDetailPopup.value)}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr className="border-t border-violet-100 bg-violet-50/70 text-[13px] font-black text-violet-700">
                    <td className="px-4 py-2.5">Total</td>
                    <td className="px-2 py-2.5 text-center tabular-nums">{stateDetailPopup.leadCount.toLocaleString('en-IN')}</td>
                    <td className="px-2 py-2.5 text-center tabular-nums">{stateDetailPopup.opportunityCount.toLocaleString('en-IN')}</td>
                    <td className="px-2 py-2.5 text-center tabular-nums">{stateDetailPopup.tenderCount.toLocaleString('en-IN')}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{fmt(stateDetailPopup.value)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="flex items-center justify-end border-t border-slate-100 px-5 py-3">
              <button
                type="button"
                onClick={() => setStateDetailPopup(null)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-600 transition hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// ─── Filter state ─────────────────────────────────────────────────────────────
type FilterState={userId:number|null;actType:string;status:string;customerId:number|null;dateFrom:string;dateTo:string}
const emptyFilter=():FilterState=>({userId:null,actType:'',status:'',customerId:null,dateFrom:'',dateTo:''})

const emptyActForm=()=>({
  activity_type:'Phone Call',customer_id:null,link_type:'',
  lead_id:null as number|null,tender_id:null as number|null,work_order_id:null as number|null,emdbg_id:null as number|null,
  subject:'',description:'',
  activity_date:new Date().toISOString().slice(0,10),start_time:'',end_time:'',duration_minutes:30,
  location:'',latitude:null as number|null,longitude:null as number|null,
  status:'Planned',outcome:'',next_action:'',next_action_date:'',
  followup_category:'',followup_sub_type:'',cancellation_reason:'',
  document_url:'',document_name:'',document_size_kb:null as number|null,document_file:null as File|null,
  has_travel:false,travel_mode:'',travel_from:'',travel_to:'',is_outside_district:false,on_behalf_of:null,
  travel_request_id:null as number|null,
  tr_travel_date:'',tr_visit_type:'Customer Visit',tr_return_date:'',tr_transport_mode:'',
  tr_estimated_cost:'',tr_contact_name:'',tr_contact_phone:'',
  tr_advance_required:false,tr_advance_amount:'',
  tr_accommodation_required:false,tr_accommodation_type:'Not Required',
  tr_hotel_name:'',tr_check_in_date:'',tr_check_out_date:'',tr_accommodation_cost:'',
})

const canEditActivity=(activity:any)=>String(activity?.status||'Planned').trim()==='Planned'

// ─── Grouping helper ──────────────────────────────────────────────────────────
function groupActivitiesByUser(activities:any[], teamMembers:any[]) {
  const memberById = new Map(teamMembers.map((u:any)=>[Number(u.id), u]))
  const orderById = new Map(teamMembers.map((u:any, idx:number)=>[Number(u.id), idx]))
  const groups = new Map<string, {key:string;userId:number|null;userName:string;role:string;items:any[]}>()
  activities.forEach((a:any)=>{
    const userId = a.user_id ? Number(a.user_id) : null
    const member = userId ? memberById.get(userId) : null
    const userName = String(a.user_name || member?.full_name || 'Unassigned')
    const role = String(a.user_role || member?.role || '')
    const key = userId ? String(userId) : userName
    if(!groups.has(key)) groups.set(key,{key,userId,userName,role,items:[]})
    groups.get(key)!.items.push(a)
  })
  return Array.from(groups.values()).sort((a,b)=>{
    const ao = a.userId ? orderById.get(a.userId) ?? 9999 : 9999
    const bo = b.userId ? orderById.get(b.userId) ?? 9999 : 9999
    if(ao !== bo) return ao - bo
    return a.userName.localeCompare(b.userName)
  })
}

function hasHierarchyReportees(teamMembers:any[] = [], userId?:number|null) {
  const uid = Number(userId || 0)
  if(!uid) return false
  return (teamMembers || []).some((member:any)=>{
    const memberId = Number(member?.id || member?.user_id || 0)
    if(!memberId || memberId === uid) return false
    const parentId = Number(member?.parent_user_id || member?.reporting_manager_id || 0)
    return parentId === uid
  })
}

function canReopenByHierarchy(user:any, teamMembers:any[] = []) {
  const role = String(user?.role || '').trim().toLowerCase().replace(/[-\s]+/g,'_')
  if(['admin','ceo','super_admin'].includes(role)) return true
  const uid = Number(user?.id || 0)
  const selfMember = (teamMembers || []).find((member:any)=>{
    const memberId = Number(member?.id || member?.user_id || 0)
    return uid && memberId === uid
  })
  const flagValue = selfMember?.can_reopen_activities ?? selfMember?.has_reopen_reportees ?? user?.can_reopen_activities ?? user?.has_reopen_reportees
  if(flagValue !== undefined && flagValue !== null) {
    return flagValue === true || flagValue === 1 || String(flagValue).toLowerCase() === 'true'
  }
  if(hasHierarchyReportees(teamMembers, uid)) return true
  return Boolean(uid && teamMembers.some((member:any)=>Number(member?.id || member?.user_id || 0) !== uid))
}

const dateKey = (d:Date) => {
  const y=d.getFullYear()
  const m=String(d.getMonth()+1).padStart(2,'0')
  const day=String(d.getDate()).padStart(2,'0')
  return `${y}-${m}-${day}`
}
const parseDateKey = (s:string) => {
  const [y,m,d]=String(s||dateKey(new Date())).split('-').map(Number)
  return new Date(y||new Date().getFullYear(),(m||1)-1,d||1)
}
const addDateDays = (s:string,days:number) => {
  const d=parseDateKey(s)
  d.setDate(d.getDate()+days)
  return dateKey(d)
}
const addDateMonths = (s:string,months:number) => {
  const d=parseDateKey(s)
  const day=d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth()+months)
  const last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate()
  d.setDate(Math.min(day,last))
  return dateKey(d)
}
type PlannerView = 'day'|'week'|'month'

const plannerRangeFor = (anchor:string,view:PlannerView) => {
  const d=parseDateKey(anchor)
  if(view==='day') return {from:dateKey(d),to:dateKey(d)}
  if(view==='month') {
    const start=new Date(d.getFullYear(),d.getMonth(),1)
    const end=new Date(d.getFullYear(),d.getMonth()+1,0)
    return {from:dateKey(start),to:dateKey(end)}
  }
  const start=new Date(d)
  const mondayOffset=(d.getDay()+6)%7
  start.setDate(d.getDate()-mondayOffset)
  const end=new Date(start)
  end.setDate(start.getDate()+5)
  return {from:dateKey(start),to:dateKey(end)}
}
const getDateKeysBetween = (from:string,to:string) => {
  const out:string[]=[]
  const cur=parseDateKey(from)
  const end=parseDateKey(to)
  while(cur<=end){ out.push(dateKey(cur)); cur.setDate(cur.getDate()+1) }
  return out
}
const formatActivityDate = (s:string,opts?:{weekday?:boolean;month?:'short'|'long'}) =>
  parseDateKey(s).toLocaleDateString('en-IN',{weekday:opts?.weekday?'long':undefined,day:'2-digit',month:opts?.month||'short',year:'numeric'})
const formatPlannerLabel = (anchor:string,view:PlannerView) => {
  const range=plannerRangeFor(anchor,view)
  if(view==='day') return formatActivityDate(anchor,{weekday:true})
  if(view==='month') return parseDateKey(anchor).toLocaleDateString('en-IN',{month:'long',year:'numeric'})
  return `${formatActivityDate(range.from)} - ${formatActivityDate(range.to)}`
}
const normalizeActivityTime = (value:any) => {
  const raw=String(value||'').trim()
  if(!raw) return null
  const twelve=raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)$/i)
  if(twelve){
    let h=Number(twelve[1])
    const m=Number(twelve[2])
    const suffix=twelve[3].toUpperCase()
    if(suffix==='PM'&&h<12) h+=12
    if(suffix==='AM'&&h===12) h=0
    if(h>=0&&h<24&&m>=0&&m<60) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`
  }
  const twentyFour=raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?/)
  if(!twentyFour) return null
  const h=Number(twentyFour[1])
  const m=Number(twentyFour[2])
  if(h>=0&&h<24&&m>=0&&m<60) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`
  return null
}
const parseActivityHour = (value:any) => {
  const normalized=normalizeActivityTime(value)
  return normalized?Number(normalized.slice(0,2)):null
}
const activitySortValue = (a:any) => {
  const normalized=normalizeActivityTime(a.start_time)
  if(!normalized) return Number.MAX_SAFE_INTEGER
  const [h,m]=normalized.split(':').map(Number)
  return h*60+m
}
const activityTimeLabel = (a:any) => {
  const start=normalizeActivityTime(a.start_time)
  if(!start) return '--:--'
  return (a.duration_minutes||0)>0 ? `${start} - ${addMinutesToTime(start,a.duration_minutes)}` : start
}

function ActivityHoverPreview({activity,align='left'}:{activity:any;align?:'left'|'right'}) {
  const { singular: customerSingular } = useModuleName('customers')
  const typeName=taskTypeName(activity)
  const tc=TYPE_COLOR[typeName]||{bg:'bg-gray-50',text:'text-gray-500',dot:'bg-gray-300'}
  const sc=STATUS_CFG[activity.status]||STATUS_CFG.Planned
  return (
    <span className={`pointer-events-none absolute ${align==='right'?'right-0':'left-0'} top-[calc(100%+8px)] z-[120] hidden w-72 rounded-xl border border-gray-200 bg-white p-3 text-left shadow-2xl group-hover/card:block`}>
      <span className="flex items-start gap-3">
        <span className={`mt-1 h-9 w-9 shrink-0 rounded-lg ${tc.bg} ${tc.text} flex items-center justify-center`}>
          {TYPE_ICON[typeName]||<Activity size={14}/>}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-gray-900">{activity.subject||typeName}</span>
          <span className="mt-1 block text-xs font-semibold text-gray-600">{activity.customer_name||`No ${customerSingular.toLowerCase()}`}</span>
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <span className={`rounded-md px-2 py-1 text-[10px] font-bold ${tc.bg} ${tc.text}`}>{typeName}</span>
            <span className={`rounded-md border px-2 py-1 text-[10px] font-bold ${sc.bg} ${sc.text} ${sc.border}`}>{activity.status||'Planned'}</span>
          </span>
          <span className="mt-2 flex items-center gap-2 text-[11px] font-semibold text-gray-500">
            <Calendar size={11}/>{formatActivityDate(activity.activity_date||dateKey(new Date()))}
            {normalizeActivityTime(activity.start_time)&&<><Clock size={11}/>{activityTimeLabel(activity)}</>}
          </span>
          {(activity.user_name||activity.next_action||activity.description)&&(
            <span className="mt-2 block space-y-1 text-[11px] font-medium text-gray-500">
              {activity.user_name&&<span className="block">Member: {activity.user_name}</span>}
              {activity.next_action&&<span className="block">Next: {activity.next_action}</span>}
              {!activity.next_action&&activity.description&&<span className="block">{activity.description}</span>}
            </span>
          )}
        </span>
      </span>
    </span>
  )
}

function PlannerActivityCard({a,compact=false,mini=false,week=false,onLog,onEdit,onViewDetail,previewAlign='left'}:{
  a:any;compact?:boolean;mini?:boolean;week?:boolean;onLog:(a:any)=>void;onEdit:(a:any)=>void;onViewDetail:(a:any)=>void;previewAlign?:'left'|'right'
}) {
  const { singular: customerSingular } = useModuleName('customers')
  const noCustomerLabel = `No ${customerSingular.toLowerCase()}`
  const typeName=taskTypeName(a)
  const tc=TYPE_COLOR[typeName]||{bg:'bg-gray-50',text:'text-gray-500',dot:'bg-gray-300'}
  if(mini) {
    return (
      <button type="button" onClick={()=>onViewDetail(a)}
        title={`${a.subject||typeName} - ${a.customer_name||noCustomerLabel} - ${activityTimeLabel(a)}`}
        className="group/card relative flex h-[52px] w-full flex-col items-center justify-between overflow-visible rounded-md border border-slate-200 bg-white px-px py-1 text-center shadow-sm transition hover:z-50 hover:border-blue-300 hover:bg-blue-50 hover:shadow-lg">
        <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded ${tc.bg} ${tc.text}`}>
          {TYPE_ICON[typeName]||<Activity size={9}/>}
        </span>
        <span className="block w-full truncate text-[8px] font-black leading-none text-gray-900">
          {a.subject||typeName}
        </span>
        <span className="block w-full truncate text-[7px] font-bold leading-none text-gray-500">
          {normalizeActivityTime(a.start_time)||'--'}
        </span>
        <ActivityHoverPreview activity={a} align={previewAlign}/>
      </button>
    )
  }
  if(week) {
    return (
      <button type="button" onClick={()=>onViewDetail(a)}
        title={`${a.subject||typeName} - ${a.customer_name||noCustomerLabel} - ${activityTimeLabel(a)}`}
        className={`group/card relative flex h-[86px] w-full min-w-0 flex-col justify-start overflow-visible rounded-md border border-slate-300 ${tc.bg} px-1.5 py-2 text-left shadow-sm transition hover:z-50 hover:border-blue-300 hover:ring-2 hover:ring-blue-100`}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${tc.text}`}>
            {TYPE_ICON[typeName]||<Activity size={10}/>}
          </span>
          <span className={`block min-w-0 truncate text-[10px] font-black leading-tight ${tc.text} sm:text-[11px]`}>
            {a.subject||typeName}
          </span>
        </span>
        <span className="mt-2 block min-w-0 truncate pl-[18px] text-[10px] font-semibold leading-tight text-slate-600 sm:text-[11px]">
          {activityTimeLabel(a)}
        </span>
        <ActivityHoverPreview activity={a} align={previewAlign}/>
      </button>
    )
  }
  if(compact) {
    return (
      <button type="button" onClick={()=>onViewDetail(a)}
        title={`${a.subject||typeName} - ${a.customer_name||noCustomerLabel} - ${a.status||'Planned'}`}
        className={`group/card relative w-full overflow-visible rounded-lg border border-gray-100 bg-white px-2 py-1.5 text-left shadow-sm transition hover:z-50 hover:border-blue-300 hover:bg-blue-50 hover:shadow-lg`}>
        <span className="flex min-w-0 items-start gap-1.5">
          <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${tc.bg} ${tc.text}`}>
            {TYPE_ICON[typeName]||<Activity size={12}/>}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] font-black leading-tight text-gray-900">{a.subject||typeName}</span>
            <span className="mt-0.5 block truncate text-[10px] font-semibold leading-tight text-gray-500">{a.customer_name||noCustomerLabel}</span>
            <span className="mt-1 block text-[9px] font-bold text-gray-400">{activityTimeLabel(a)}</span>
          </span>
        </span>
        <ActivityHoverPreview activity={a} align={previewAlign}/>
      </button>
    )
  }
  return (
    <button type="button" onClick={()=>onViewDetail(a)}
      className={`group/card relative w-full max-w-full overflow-visible rounded-lg border border-gray-100 ${tc.bg} px-2 py-1.5 text-left shadow-sm transition hover:z-50 hover:border-blue-200 hover:shadow-md sm:w-[220px] sm:px-2.5`}>
      <div className="flex items-center gap-2">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${tc.bg} ${tc.text}`}>
          {TYPE_ICON[typeName]||<Activity size={12}/>}
        </span>
        <div className="min-w-0 flex-1">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold leading-tight text-gray-900">{a.subject||typeName}</p>
            <p className="truncate text-[11px] font-semibold leading-tight text-gray-600">{a.customer_name||noCustomerLabel}</p>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold text-gray-500"><UserCircle size={10}/>{a.user_name||'Aavin Illam'}</span>
            <span className="shrink-0 text-[11px] font-bold text-gray-500">{activityTimeLabel(a)}</span>
          </div>
        </div>
        <MoreVertical size={13} className="shrink-0 text-gray-300"/>
      </div>
      <ActivityHoverPreview activity={a} align={previewAlign}/>
    </button>
  )
}

function ActivitySlotHoverList({activities,anchorRef,contentRef,open,onMouseEnter,onMouseLeave,onLog,onEdit,onViewDetail,align='left'}:{
  activities:any[];
  anchorRef:React.RefObject<HTMLElement>;
  contentRef?:React.RefObject<HTMLDivElement>;
  open:boolean;
  onMouseEnter:()=>void;
  onMouseLeave:()=>void;
  onLog:(a:any)=>void;onEdit:(a:any)=>void;onViewDetail:(a:any)=>void;align?:'left'|'right'
}) {
  const { canUpdate }=useKAMPerms()
  const [position,setPosition]=useState<{top:number;left:number;width:number;maxHeight:number}|null>(null)
  const updatePosition=useCallback(()=>{
    const rect=anchorRef.current?.getBoundingClientRect()
    if(!rect) return
    const gap=8
    const padding=12
    const width=Math.min(300,window.innerWidth-(padding*2))
    const preferredLeft=align==='right'?rect.right-width:rect.left
    const left=Math.min(Math.max(padding,preferredLeft),window.innerWidth-padding-width)
    const belowTop=rect.bottom+gap
    const belowSpace=window.innerHeight-belowTop-padding
    const aboveHeight=Math.min(256,Math.max(160,rect.top-gap-padding))
    const showAbove=belowSpace<180&&rect.top>belowSpace
    const top=showAbove?Math.max(padding,rect.top-gap-aboveHeight):belowTop
    const maxHeight=showAbove?aboveHeight:Math.min(256,Math.max(160,belowSpace))
    setPosition({top,left,width,maxHeight})
  },[align,anchorRef])

  useEffect(()=>{
    if(!open) return
    updatePosition()
    window.addEventListener('resize',updatePosition)
    window.addEventListener('scroll',updatePosition,true)
    return ()=>{
      window.removeEventListener('resize',updatePosition)
      window.removeEventListener('scroll',updatePosition,true)
    }
  },[open,updatePosition])

  if(!activities.length) return null
  if(!open||!position||typeof document==='undefined') return null
  return createPortal(
    <div
      ref={contentRef}
      style={{top:position.top,left:position.left,width:position.width}}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={e=>e.stopPropagation()}
      className="fixed z-[1000] rounded-xl border border-indigo-100 bg-white p-3 text-left shadow-2xl ring-1 ring-black/5"
    >
      <div className="mb-2 flex items-center justify-between gap-3 border-b border-slate-100 pb-2">
        <span className="text-xs font-black text-slate-900">Activities</span>
        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-black text-indigo-700">{activities.length}</span>
      </div>
      <div className="space-y-1.5 overflow-y-auto pr-1" style={{maxHeight:position.maxHeight}}>
        {activities.map(a=>{
          const typeName=taskTypeName(a)
          const tc=TYPE_COLOR[typeName]||{bg:'bg-gray-50',text:'text-gray-500',dot:'bg-gray-300'}
          const open=canUpdate&&!['Completed','Cancelled'].includes(a.status)
          const canEdit=canUpdate&&canEditActivity(a)
          return (
            <div key={a.id} className="rounded-lg bg-slate-50 px-2 py-1.5">
              <button type="button" onClick={()=>onViewDetail(a)} className="flex w-full min-w-0 items-start gap-2 text-left">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tc.dot}`}/>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-black text-slate-900">{a.subject||typeName}</span>
                  <span className="mt-0.5 block truncate text-[10px] font-semibold text-slate-500">
                    {activityTimeLabel(a)} - {a.customer_name||typeName}
                  </span>
                </span>
              </button>
              <div className="mt-1 flex items-center gap-1 pl-4">
                {open&&<button type="button" onClick={()=>onLog(a)} className="rounded-md bg-blue-600 px-2 py-0.5 text-[10px] font-black text-white">Log</button>}
                {canEdit&&<button type="button" onClick={()=>onEdit(a)} className="rounded-md bg-white px-2 py-0.5 text-[10px] font-black text-slate-500 ring-1 ring-slate-200">Edit</button>}
              </div>
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}

function ActivitySlotBadges({activities,visibleLimit,onLog,onEdit,onViewDetail,align='left',itemClassName='',itemWidth,mini=false,week=false,fill=false,tailSpaceClassName='',moreClassName='',moreWidth=66,gapClassName='gap-1.5',gapPx=6}:{
  activities:any[];visibleLimit:number;onLog:(a:any)=>void;onEdit:(a:any)=>void;onViewDetail:(a:any)=>void;align?:'left'|'right';itemClassName?:string;itemWidth?:number;mini?:boolean;week?:boolean;fill?:boolean;tailSpaceClassName?:string;moreClassName?:string;moreWidth?:number;gapClassName?:string;gapPx?:number
}) {
  const [moreOpen,setMoreOpen]=useState(false)
  const containerRef=useRef<HTMLDivElement>(null)
  const moreButtonRef=useRef<HTMLButtonElement>(null)
  const listRef=useRef<HTMLDivElement>(null)
  const closeTimer=useRef<number|null>(null)
  const [containerWidth,setContainerWidth]=useState(0)
  const keepMoreOpen=useCallback(()=>{
    if(closeTimer.current) window.clearTimeout(closeTimer.current)
  },[])
  const scheduleClose=useCallback(()=>{
    if(closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current=window.setTimeout(()=>setMoreOpen(false),140)
  },[])
  useEffect(()=>()=>{if(closeTimer.current) window.clearTimeout(closeTimer.current)},[])
  useEffect(()=>{
    const node=containerRef.current
    if(!node) return
    const update=()=>setContainerWidth(node.clientWidth)
    update()
    if(typeof ResizeObserver==='undefined'){
      window.addEventListener('resize',update)
      return ()=>window.removeEventListener('resize',update)
    }
    const observer=new ResizeObserver(update)
    observer.observe(node)
    return ()=>observer.disconnect()
  },[])
  useEffect(()=>{
    if(!moreOpen) return
    const closeFromOutside=(event:MouseEvent|TouchEvent)=>{
      const target=event.target as Node|null
      if(target&&(containerRef.current?.contains(target)||listRef.current?.contains(target))) return
      setMoreOpen(false)
    }
    const closeOnEscape=(event:KeyboardEvent)=>{
      if(event.key==='Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown',closeFromOutside)
    document.addEventListener('touchstart',closeFromOutside)
    document.addEventListener('keydown',closeOnEscape)
    return ()=>{
      document.removeEventListener('mousedown',closeFromOutside)
      document.removeEventListener('touchstart',closeFromOutside)
      document.removeEventListener('keydown',closeOnEscape)
    }
  },[moreOpen])
  if(!activities.length) return null
  const maxVisible=(()=>{
    const requested=Math.min(visibleLimit,activities.length)
    if(!itemWidth||containerWidth<=0) return requested
    const gap=gapPx
    let count=requested
    const neededWidth=(visibleCount:number)=>{
      const visibleWidth=(visibleCount*itemWidth)+(Math.max(0,visibleCount-1)*gap)
      return activities.length>visibleCount ? visibleWidth+gap+moreWidth : visibleWidth
    }
    while(count>0&&neededWidth(count)>containerWidth) count-=1
    return Math.max(1,count)
  })()
  const visible=activities.slice(0,maxVisible)
  const hidden=Math.max(0,activities.length-visible.length)
  return (
    <div
      ref={containerRef}
      className="pointer-events-none relative z-20 w-full max-w-full min-w-0 overflow-visible"
    >
      <div className={`pointer-events-none flex ${fill?'w-full':'w-fit'} max-w-full min-w-0 flex-nowrap overflow-visible`}>
        <div
          onMouseEnter={keepMoreOpen}
          onMouseLeave={scheduleClose}
          onFocus={keepMoreOpen}
          onBlur={scheduleClose}
          className={`group/slotbadges pointer-events-auto flex ${fill?'min-w-0 flex-1':'w-fit'} max-w-full flex-nowrap ${gapClassName} overflow-visible`}
        >
          {visible.map(a=>(
            <div key={a.id} className={itemClassName||(fill?"min-w-0 flex-1 basis-0":"min-w-0 flex-1 sm:flex-none")}>
              <PlannerActivityCard a={a} compact mini={mini} week={week} onLog={onLog} onEdit={onEdit} onViewDetail={onViewDetail} previewAlign={align}/>
            </div>
          ))}
          {hidden>0&&(
            <button type="button" ref={moreButtonRef} onClick={e=>{e.stopPropagation();keepMoreOpen();setMoreOpen(open=>!open)}}
              aria-expanded={moreOpen}
              aria-haspopup="dialog"
              className={moreClassName||"inline-flex h-7 min-w-[58px] items-center justify-center rounded-lg bg-slate-100 px-2 text-[10px] font-black text-slate-600 ring-1 ring-slate-200 transition hover:bg-indigo-50 hover:text-indigo-700"}>
              + {hidden} more
            </button>
          )}
        </div>
        {tailSpaceClassName&&<span aria-hidden="true" className={`pointer-events-none block ${tailSpaceClassName}`}/>}
      </div>
      <ActivitySlotHoverList
        activities={activities}
        anchorRef={moreButtonRef}
        contentRef={listRef}
        open={hidden>0&&moreOpen}
        onMouseEnter={keepMoreOpen}
        onMouseLeave={scheduleClose}
        onLog={onLog}
        onEdit={onEdit}
        onViewDetail={onViewDetail}
        align={align}
      />
    </div>
  )
}

function MiniCalendar({anchor,activities,onSelect}:{anchor:string;activities:any[];onSelect:(d:string)=>void}) {
  const base=parseDateKey(anchor)
  const monthStart=new Date(base.getFullYear(),base.getMonth(),1)
  const start=new Date(monthStart)
  start.setDate(monthStart.getDate()-monthStart.getDay())
  const counts=activities.reduce((m:Record<string,number>,a:any)=>{const k=String(a.activity_date||''); if(k)m[k]=(m[k]||0)+1; return m},{})
  const days=Array.from({length:42},(_,i)=>{const d=new Date(start); d.setDate(start.getDate()+i); return d})
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-bold text-gray-900">{base.toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</p>
        <div className="flex items-center gap-1">
          <button type="button" onClick={()=>onSelect(dateKey(new Date(base.getFullYear(),base.getMonth()-1,1)))} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100"><ChevronLeft size={14}/></button>
          <button type="button" onClick={()=>onSelect(dateKey(new Date(base.getFullYear(),base.getMonth()+1,1)))} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100"><ChevronRight size={14}/></button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-gray-400">{['Su','Mo','Tu','We','Th','Fr','Sa'].map(d=><span key={d}>{d}</span>)}</div>
      <div className="mt-2 grid grid-cols-7 gap-1">
        {days.map(d=>{const k=dateKey(d); const active=k===anchor; const inMonth=d.getMonth()===base.getMonth(); return (
          <button key={k} type="button" onClick={()=>onSelect(k)} className={`relative h-8 rounded-lg text-xs font-semibold transition ${active?'bg-blue-600 text-white shadow-sm':inMonth?'text-gray-700 hover:bg-blue-50':'text-gray-300 hover:bg-gray-50'}`}>
            {d.getDate()}{!!counts[k]&&<span className={`absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full ${active?'bg-white':'bg-blue-500'}`}/>}
          </button>
        )})}
      </div>
    </div>
  )
}

function SideScheduleCard({title,icon,items,onViewDetail}:{title:string;icon:React.ReactNode;items:any[];onViewDetail:(a:any)=>void}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-gray-900">{icon}{title}</h3>
        <button type="button" className="text-[11px] font-bold text-blue-600">View All</button>
      </div>
      <div className="space-y-2.5">
        {items.length===0?<p className="py-3 text-center text-xs font-medium text-gray-400">No activities</p>:items.slice(0,4).map(a=>(
          <button key={a.id} type="button" onClick={()=>onViewDetail(a)} className="flex w-full items-center gap-2 text-left">
            <span className={`h-7 w-0.5 rounded-full ${(TYPE_COLOR[taskTypeName(a)]||TYPE_COLOR['Phone Call']).dot}`}/>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-bold text-gray-900">{a.subject||taskTypeName(a)}</span>
              <span className="block truncate text-[11px] text-gray-500">{a.customer_name||formatActivityDate(a.activity_date)}</span>
            </span>
            <span className="text-[11px] font-semibold text-gray-500">{normalizeActivityTime(a.start_time)||String(a.activity_date||'').slice(0,10)}</span>
          </button>
        ))}
      </div>
      {items.length>4&&<p className="mt-3 text-[11px] font-semibold text-gray-400">+ {items.length-4} more activities</p>}
    </div>
  )
}

function ActivityPlannerView({
  activities,plannerView,setPlannerView,plannerDate,setPlannerDate,loading,initialLoading=false,onPlan,onLog,onEdit,onViewDetail,embedded=false,
}:{
  activities:any[];
  plannerView:PlannerView;setPlannerView:(v:PlannerView)=>void;
  plannerDate:string;setPlannerDate:(d:string)=>void;loading:boolean;initialLoading?:boolean;
  onPlan:(date?:string,startTime?:string)=>void;onLog:(a:any)=>void;onEdit:(a:any)=>void;onViewDetail:(a:any)=>void;
  embedded?:boolean;
}) {
  const { canCreate }=useKAMPerms()
  const todayKey=dateKey(new Date())
  const range=plannerRangeFor(plannerDate,plannerView)
  const dateKeys=getDateKeysBetween(range.from,range.to)
  const sorted=useMemo(()=>[...activities].sort((a,b)=>String(a.activity_date||'').localeCompare(String(b.activity_date||''))||activitySortValue(a)-activitySortValue(b)),[activities])
  const selectedActs=useMemo(()=>sorted.filter(a=>a.activity_date===plannerDate),[sorted,plannerDate])
  const overdueActs=useMemo(()=>sorted.filter(a=>{
    const activityDate=String(a.activity_date||'')
    return activityDate&&activityDate<todayKey&&!['Completed','Cancelled'].includes(a.status||'')
  }),[sorted,todayKey])
  const dateKeyIndex=dateKeys.join('|')
  const activitiesByDate=useMemo(()=>{
    const grouped:Record<string,any[]>={}
    for(const d of dateKeys) grouped[d]=[]
    for(const a of sorted){
      const key=String(a.activity_date||'')
      if(grouped[key]) grouped[key].push(a)
    }
    return grouped
  },[dateKeyIndex,sorted])
  const step=plannerView==='day'?1:7
  const moveDate=(dir:number)=>setPlannerDate(plannerView==='month'?addDateMonths(plannerDate,dir):addDateDays(plannerDate,dir*step))
  const plannedCount=sorted.filter(a=>['Planned','In Progress','Postponed'].includes(a.status||'')).length
  const completedCount=sorted.filter(a=>a.status==='Completed').length
  const cancelledCount=sorted.filter(a=>a.status==='Cancelled').length
  const statItems=[
    {label:'Total',value:sorted.length,tone:'text-slate-900 bg-slate-100'},
    {label:'Open',value:plannedCount,tone:'text-blue-700 bg-blue-50'},
    {label:'Completed',value:completedCount,tone:'text-emerald-700 bg-emerald-50'},
    {label:'Cancelled',value:cancelledCount,tone:'text-rose-700 bg-rose-50'},
  ]

  const renderBoard=()=>{
    const baseBusinessHours=Array.from({length:10},(_,i)=>i+9)
    const businessHours=baseBusinessHours
    const firstBusinessHour=baseBusinessHours[0]
    const lastBusinessHour=baseBusinessHours[baseBusinessHours.length-1]
    const hourLabel=(hour:number)=>`${String(hour%12||12).padStart(2,'0')}:00 ${hour<12?'am':'pm'}`
    const slotTime=(hour:number,minute=0)=>`${String(hour).padStart(2,'0')}:${minute===0?'00':'30'}`
    const activityTimelineHour=(a:any)=>{
      const parsed=parseActivityHour(a.start_time)
      return parsed===null ? firstBusinessHour : Math.min(Math.max(parsed,firstBusinessHour),lastBusinessHour)
    }
    if(initialLoading) return (
      <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"/>
        <p className="mt-3 text-center text-xs font-semibold text-gray-400">Loading activities</p>
      </div>
    )
    if(plannerView==='day'){
      return (
        <div className="overflow-visible rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-2 border-b border-gray-100 bg-gray-50/70 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div>
              <h3 className="text-sm font-black text-gray-900 sm:text-base">{formatActivityDate(plannerDate,{weekday:true})}</h3>
              <p className="mt-0.5 text-xs font-semibold text-gray-500">Daily activity timeline</p>
            </div>
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white px-2.5 py-1.5 text-xs font-bold text-gray-700 ring-1 ring-gray-200 sm:gap-2 sm:px-3">
              <Activity size={13} className="text-blue-500"/>{selectedActs.length} Activities
            </span>
          </div>
          <div className="grid grid-cols-[62px_1fr] px-2 py-2 sm:grid-cols-[86px_1fr] sm:px-5">
            <div>
              {businessHours.map(hour=>(
                <div key={hour} className="relative h-[56px] pr-2 text-right sm:h-[58px] sm:pr-3">
                  <button type="button" disabled={!canCreate} onClick={()=>onPlan(plannerDate,slotTime(hour))}
                    className="relative -top-1 rounded-md bg-white px-1 text-[10px] font-bold text-gray-400 transition hover:bg-blue-50 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100 sm:text-[11px]">
                    {hourLabel(hour)}
                  </button>
                  <span className="absolute right-0 top-1/2 h-px w-4 bg-blue-100 sm:w-7"/>
                </div>
              ))}
            </div>
            <div className="ml-2 border-l border-blue-100 sm:ml-5">
              {businessHours.map(hour=>{
                const hourActs=selectedActs.filter(a=>{
                  return activityTimelineHour(a)===hour
                })
                return (
                  <div key={hour} className="group/slot relative z-0 h-[56px] border-b border-blue-100 pl-2 hover:z-30 focus-within:z-30 sm:h-[58px] sm:pl-5">
                    {canCreate&&<button type="button" onClick={()=>onPlan(plannerDate,slotTime(hour))}
                      className="absolute left-0 right-0 top-0 z-10 flex h-full items-center justify-center border border-dashed border-transparent text-[10px] font-black text-blue-500 opacity-0 transition hover:border-blue-200 hover:bg-blue-50/50 hover:opacity-100 group-hover/slot:opacity-100 sm:text-[11px]">
                      <Plus size={12} className="mr-1"/>Plan Activity
                    </button>}
                    <div className="pointer-events-none relative z-20 p-1.5 sm:p-2">
                      <ActivitySlotBadges activities={hourActs} visibleLimit={9} onLog={onLog} onEdit={onEdit} onViewDetail={onViewDetail} itemClassName="w-[120px] shrink-0" itemWidth={120}/>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )
    }
    if(plannerView==='week') return (
      <div className="overflow-visible rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="grid grid-cols-[126px_repeat(6,minmax(150px,1fr))] border-b border-indigo-100 bg-white text-sm font-black text-slate-800">
          <div className="border-r border-indigo-100 bg-slate-50"/>
          {dateKeys.map(d=>{
            const day=parseDateKey(d)
            const isSelected=d===plannerDate
            const isSaturday=day.getDay()===6
            return (
              <button key={d} type="button" onClick={()=>setPlannerDate(d)}
                className={`border-r border-indigo-100 px-3 py-4 text-center transition last:border-r-0 ${isSelected?'text-indigo-600':'text-slate-800'} ${isSaturday?'text-red-500':''}`}>
                {day.toLocaleDateString('en-IN',{weekday:'short'}).toUpperCase()} {String(day.getDate()).padStart(2,'0')}
              </button>
            )
          })}
        </div>

        <div className="max-h-[calc(100vh-330px)] min-h-[430px] overflow-y-auto">
          <div className="grid grid-cols-[126px_repeat(6,minmax(150px,1fr))]">
            <div className="sticky left-0 z-10 border-r border-indigo-100 bg-white">
              <div className="h-12 border-b border-indigo-100 bg-slate-50"/>
              <div className="flex h-12 items-center justify-center border-b border-emerald-500">
                <span className="w-full rounded-tr-lg bg-emerald-600 py-1.5 text-center text-xs font-black text-white">All-Day (0)</span>
              </div>
              {businessHours.map(hour=>(
                <div key={hour} className="relative h-[94px] border-b border-indigo-100 pr-2 text-right">
                  <button type="button" disabled={!canCreate} onClick={()=>onPlan(plannerDate,slotTime(hour))}
                    className="relative -top-3 rounded-md bg-white px-2 text-sm font-medium text-slate-600 transition hover:bg-blue-50 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100">
                    {hourLabel(hour)}
                  </button>
                  <span className="absolute right-2 top-11 h-1.5 w-1.5 rounded-full bg-indigo-100"/>
                  <span className="absolute right-2 top-11 h-px w-7 bg-indigo-100"/>
                </div>
              ))}
            </div>

            {dateKeys.map((d,dayIndex)=>(
              <div key={d} className={`border-r border-indigo-100 last:border-r-0 ${d===plannerDate?'bg-indigo-50/20':'bg-white'}`}>
                <div className="flex h-12 items-center border-b border-indigo-100 px-2">
                  {dayIndex===0&&overdueActs.length>0&&(
                    <button type="button" onClick={()=>onViewDetail(overdueActs[0])}
                      title={`${overdueActs.length} overdue activit${overdueActs.length!==1?'ies':'y'}`}
                      className="inline-flex max-w-full items-center gap-1 rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs font-black text-red-600 shadow-sm transition hover:bg-red-100">
                      <AlertCircle size={12} className="shrink-0"/>
                      <span className="truncate">Overdue Activit{overdueActs.length!==1?'ies':'y'}</span>
                    </button>
                  )}
                </div>
                <div className="h-12 border-b border-emerald-500"/>
                {businessHours.map(hour=>{
                  const hourActs=(activitiesByDate[d]||[]).filter(a=>{
                    return activityTimelineHour(a)===hour
                  })
                  const weekStackItemClass=hourActs.length<=1
                    ? 'w-[170px] shrink-0'
                    : hourActs.length===2
                      ? 'w-[96px] shrink-0'
                      : 'w-[54px] shrink-0 -ml-4 first:ml-0'
                  return (
                    <div key={hour} className="group/slot relative z-0 h-[94px] border-b border-indigo-100 p-2 hover:z-30 focus-within:z-30">
                      {canCreate&&<button type="button" onClick={()=>onPlan(d,slotTime(hour))}
                        className="absolute inset-0 z-10 flex items-center justify-center border border-dashed border-transparent text-[11px] font-black text-blue-500 opacity-0 transition hover:border-blue-200 hover:bg-blue-50/50 hover:opacity-100 group-hover/slot:opacity-100">
                        <Plus size={12} className="mr-1"/>Plan Activity
                      </button>}
                      <div className="pointer-events-none relative z-20 overflow-visible">
                        <ActivitySlotBadges
                          activities={hourActs}
                          visibleLimit={hourActs.length>4?4:hourActs.length}
                          onLog={onLog}
                          onEdit={onEdit}
                          onViewDetail={onViewDetail}
                          align={dayIndex>=4?'right':'left'}
                          itemClassName={weekStackItemClass}
                          week
                          gapClassName={hourActs.length===2?'gap-1':'gap-0'}
                          tailSpaceClassName="w-8 shrink-0"
                          moreWidth={42}
                          moreClassName="inline-flex h-[86px] min-w-[42px] shrink-0 flex-col items-center justify-center rounded-md border border-slate-300 bg-slate-100 px-1 text-[10px] font-black leading-tight text-slate-700 shadow-sm transition hover:bg-indigo-50 hover:text-indigo-700"
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    )
    if(plannerView==='month') {
      const base=parseDateKey(plannerDate)
      const monthStart=new Date(base.getFullYear(),base.getMonth(),1)
      const monthEnd=new Date(base.getFullYear(),base.getMonth()+1,0)
      const gridStart=new Date(monthStart)
      gridStart.setDate(monthStart.getDate()-((monthStart.getDay()+6)%7))
      const gridEnd=new Date(monthEnd)
      gridEnd.setDate(monthEnd.getDate()+(6-((monthEnd.getDay()+6)%7)))
      const monthDayCount=Math.round((gridEnd.getTime()-gridStart.getTime())/86400000)+1
      const monthDays=Array.from({length:monthDayCount},(_,i)=>{const d=new Date(gridStart); d.setDate(gridStart.getDate()+i); return d})
      return (
        <div className="relative overflow-visible rounded-lg border border-indigo-100 bg-white shadow-sm">
          {loading&&(
            <span className="absolute right-2 top-2 z-20 inline-flex items-center gap-1 rounded-full bg-white/95 px-2 py-1 text-[10px] font-black text-blue-600 shadow-sm ring-1 ring-blue-100">
              <RefreshCw size={10} className="animate-spin"/>Refreshing
            </span>
          )}
          <div className="grid grid-cols-7 border-b border-indigo-100 bg-white text-center text-xs font-black uppercase text-slate-900">
            {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day=><div key={day} className={`border-r border-indigo-100 px-2 py-2 last:border-r-0 ${day==='Sat'||day==='Sun'?'text-red-500':'text-slate-900'}`}>{day}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {monthDays.map((day,index)=>{
              const d=dateKey(day)
              const inMonth=day.getMonth()===base.getMonth()
              const isSelected=d===plannerDate
              const isToday=d===todayKey
              const dayActs=activitiesByDate[d]||[]
              const isWeekend=day.getDay()===0||day.getDay()===6
              const isRightEdge=((index%7)>=5)
              const isLowerRows=index>=28
              return (
                <div key={d} role="button" tabIndex={0} onClick={()=>{if(canCreate)onPlan(d)}}
                  onKeyDown={e=>{if(canCreate&&(e.key==='Enter'||e.key===' ')){e.preventDefault();onPlan(d)}}}
                  className={`group relative min-h-[92px] cursor-pointer border-b border-r border-indigo-100 p-2 text-left align-top transition last:border-r-0 hover:z-30 hover:bg-indigo-50/40 ${inMonth?'bg-white':'bg-slate-50/60'} ${isSelected?'bg-indigo-50/30':''}`}>
                  <div className="mb-1.5 flex items-start justify-between gap-1.5">
                    <span className={`flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 text-xs font-black ${isSelected?'bg-indigo-600 text-white':isToday?'bg-indigo-100 text-indigo-700':inMonth?isWeekend?'text-red-500':'text-slate-900':'text-slate-300'}`}>
                      {day.getDate()}
                    </span>
                    {dayActs.length>0&&<span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[9px] font-black text-indigo-700 ring-1 ring-indigo-100">{dayActs.length}</span>}
                  </div>
                  <div className="space-y-1">
                    {dayActs.slice(0,2).map(a=>{
                      const typeName=taskTypeName(a)
                      const tc=TYPE_COLOR[typeName]||{bg:'bg-gray-50',text:'text-gray-500',dot:'bg-gray-300'}
                      return (
                        <span key={a.id} onClick={e=>{e.stopPropagation();onViewDetail(a)}}
                          className={`block truncate rounded px-1.5 py-0.5 text-[10px] font-bold ${tc.bg} ${tc.text}`}>
                          {String(a.start_time||'').slice(0,5)||'All day'} - {a.subject||typeName}
                        </span>
                      )
                    })}
                    {dayActs.length>2&&<span className="block rounded bg-slate-100 px-1.5 py-0.5 text-center text-[9px] font-bold text-slate-500">+ {dayActs.length-2} more</span>}
                    {dayActs.length===0&&inMonth&&<span className="mt-3 hidden text-[10px] font-semibold text-indigo-400 group-hover:block">Click to plan</span>}
                  </div>
                  {inMonth&&dayActs.length>0&&(
                    <div onClick={e=>e.stopPropagation()}
                      className={`absolute z-50 hidden w-[260px] rounded-xl border border-indigo-100 bg-white p-3 text-left shadow-2xl ring-1 ring-black/5 group-hover:block ${isRightEdge?'right-2':'left-2'} ${isLowerRows?'bottom-9':'top-9'}`}>
                      <div className="mb-2 flex items-center justify-between gap-3 border-b border-slate-100 pb-2">
                        <span className="text-xs font-black text-slate-900">{formatActivityDate(d,{weekday:true})}</span>
                        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-black text-indigo-700">{dayActs.length}</span>
                      </div>
                      <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                        {dayActs.map(a=>{
                          const typeName=taskTypeName(a)
                          const tc=TYPE_COLOR[typeName]||{bg:'bg-gray-50',text:'text-gray-500',dot:'bg-gray-300'}
                          return (
                            <div key={a.id} className="flex min-w-0 items-start gap-2 rounded-lg bg-slate-50 px-2 py-1.5">
                              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tc.dot}`}/>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[11px] font-black text-slate-900">{a.subject||typeName}</span>
                                <span className="mt-0.5 block truncate text-[10px] font-semibold text-slate-500">
                                  {(String(a.start_time||'').slice(0,5)||'All day')} - {a.customer_name||typeName}
                                </span>
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )
    }
    return null
  }

  return (
    <div className="space-y-4">
      <div className={embedded ? "border-t border-gray-100 pt-3" : "rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"}>
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-xl border border-gray-200 bg-gray-50 p-0.5">{(['day','week','month'] as const).map(v=><button key={v} type="button" onClick={()=>setPlannerView(v)} className={`px-4 py-2 text-xs font-black capitalize rounded-lg ${plannerView===v?'bg-white text-blue-600 shadow-sm':'text-gray-500 hover:text-gray-800'}`}>{v}</button>)}</div>
            <button type="button" onClick={()=>moveDate(-1)} className="rounded-xl border border-gray-200 p-2 text-gray-500 hover:bg-gray-50"><ChevronLeft size={15}/></button>
            <button type="button" onClick={()=>moveDate(1)} className="rounded-xl border border-gray-200 p-2 text-gray-500 hover:bg-gray-50"><ChevronRight size={15}/></button>
            <button type="button" onClick={()=>setPlannerDate(todayKey)} className="rounded-xl border border-transparent px-3 py-2 text-xs font-bold text-gray-700 hover:border-gray-200 hover:bg-gray-50">Today</button>
            <div className="flex min-w-0 items-center gap-2 rounded-xl bg-gray-50 px-3 py-2 text-sm font-black text-gray-900 ring-1 ring-gray-100"><Calendar size={15} className="shrink-0 text-blue-500"/><span className="truncate">{formatPlannerLabel(plannerDate,plannerView)}</span></div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {statItems.map(item=>(
            <div key={item.label} className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2">
              <p className="text-[10px] font-black uppercase tracking-wide text-gray-400">{item.label}</p>
              <p className={`mt-1 inline-flex rounded-lg px-2 py-0.5 text-sm font-black ${item.tone}`}>{item.value}</p>
            </div>
          ))}
        </div>
      </div>

      <main className="min-w-0">{renderBoard()}</main>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
function ActivityListItem({a,selected,showUser,today,onSelect,onLog,onEdit}:{
  a:any;selected:boolean;showUser:boolean;today:string;onSelect:(a:any)=>void;onLog:(a:any)=>void;onEdit:(a:any)=>void
}) {
  const { singular: customerSingular } = useModuleName('customers')
  const typeName=taskTypeName(a)
  const tc=TYPE_COLOR[typeName]||{bg:'bg-gray-50',text:'text-gray-500',dot:'bg-gray-300'}
  const sc=STATUS_CFG[a.status]||STATUS_CFG.Planned
  const { canUpdate }=useKAMPerms()
  const isOpen=!['Completed','Cancelled'].includes(a.status)
  const canEdit=canUpdate&&canEditActivity(a)
  const isOverdue=isOpen&&String(a.activity_date||'')<today
  return (
    <button type="button" onClick={()=>onSelect(a)}
      className={`grid w-full grid-cols-[minmax(240px,1.8fr)_150px_120px_120px_110px] items-center gap-3 border-b border-gray-100 px-4 py-3 text-left transition hover:bg-blue-50/40 ${selected?'bg-blue-50 ring-1 ring-inset ring-blue-200':'bg-white'}`}>
      <div className="flex min-w-0 items-center gap-3">
        <span className={`h-10 w-1 rounded-full ${isOverdue?'bg-red-500':tc.dot}`}/>
        <TypeBox type={typeName} size="sm"/>
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-bold text-gray-900">{a.subject||typeName}</span>
            {isOverdue&&<span className="rounded-md bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-600">Overdue</span>}
          </span>
          <span className="mt-0.5 block truncate text-xs font-medium text-gray-500">{a.description||a.next_action||a.outcome||'No notes added'}</span>
        </span>
      </div>
      <span className="min-w-0">
        <span className="flex items-center gap-1 truncate text-xs font-semibold text-gray-700"><Building2 size={11} className="shrink-0 text-gray-400"/>{a.customer_name||`No ${customerSingular.toLowerCase()}`}</span>
        {showUser&&<span className="mt-1 flex items-center gap-1 truncate text-[11px] font-semibold text-blue-500"><UserCircle size={10}/>{a.user_name||'Unassigned'}</span>}
      </span>
      <span className={`inline-flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-bold ${tc.bg} ${tc.text}`}>
        {TYPE_ICON[typeName]||<Activity size={11}/>} {typeName}
      </span>
      <span>
        <span className={`block text-xs font-bold ${isOverdue?'text-red-600':'text-gray-800'}`}>{formatActivityDate(a.activity_date||today)}</span>
        <span className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-gray-400"><Clock size={10}/>{String(a.start_time||'').slice(0,5)||'No time'}</span>
      </span>
      <span className="flex items-center justify-end gap-2">
        <span className={`hidden rounded-lg border px-2 py-1 text-[10px] font-bold 2xl:inline-flex ${sc.bg} ${sc.text} ${sc.border}`}>{a.status||'Planned'}</span>
        {isOpen&&canUpdate&&<span onClick={e=>{e.stopPropagation();onLog(a)}} className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-blue-700">Log</span>}
        {canEdit&&<span onClick={e=>{e.stopPropagation();onEdit(a)}} className="rounded-lg border border-gray-200 bg-white p-1.5 text-gray-400 hover:text-gray-700"><Edit3 size={12}/></span>}
      </span>
    </button>
  )
}

function ActivityFilterSelect({value,options,onChange,className=''}:{
  value:string|number|null
  options:Array<{value:string|number|null;label:string}>
  onChange:(value:string|number|null)=>void
  className?:string
}) {
  const [open,setOpen]=useState(false)
  const [search,setSearch]=useState('')
  const ref=useRef<HTMLDivElement>(null)
  const menuRef=useRef<HTMLDivElement>(null)
  const [menuPos,setMenuPos]=useState<{top:number;left:number;width:number;maxHeight:number}|null>(null)
  const selected=options.find(o=>String(o.value??'')===String(value??''))||options[0]
  const filtered=options.filter(o=>o.label.toLowerCase().includes(search.toLowerCase()))

  const updateMenuPosition=useCallback(()=>{
    const rect=ref.current?.getBoundingClientRect()
    if(!rect) return
    const gap=6
    const padding=12
    const menuWidth=Math.min(Math.max(rect.width,220),window.innerWidth-(padding*2))
    const left=Math.min(Math.max(padding,rect.left),window.innerWidth-padding-menuWidth)
    const spaceBelow=window.innerHeight-rect.bottom-padding-gap
    const spaceAbove=rect.top-padding-gap
    const openUp=spaceBelow<180&&spaceAbove>spaceBelow
    const maxHeight=Math.max(160,Math.min(300,openUp?spaceAbove:spaceBelow))
    const top=openUp
      ? Math.max(padding,rect.top-gap-maxHeight)
      : Math.min(rect.bottom+gap,window.innerHeight-padding-120)
    setMenuPos({top,left,width:menuWidth,maxHeight})
  },[])

  useEffect(()=>{
    const onDown=(e:MouseEvent)=>{
      const target=e.target as Node
      if(ref.current?.contains(target)||menuRef.current?.contains(target)) return
      setOpen(false)
      setSearch('')
    }
    document.addEventListener('mousedown',onDown)
    return()=>document.removeEventListener('mousedown',onDown)
  },[])

  useEffect(()=>{
    if(!open){
      setMenuPos(null)
      return
    }
    updateMenuPosition()
    const frame=window.requestAnimationFrame(updateMenuPosition)
    window.addEventListener('resize',updateMenuPosition)
    window.addEventListener('scroll',updateMenuPosition,true)
    return()=>{
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize',updateMenuPosition)
      window.removeEventListener('scroll',updateMenuPosition,true)
    }
  },[open,updateMenuPosition])

  return (
    <div ref={ref} className={`relative min-w-0 ${className}`}>
      <button type="button" onClick={()=>setOpen(o=>!o)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 text-left text-xs font-semibold text-gray-900 outline-none transition hover:border-gray-300 focus:border-blue-400">
        <span className="truncate">{selected?.label||'Select'}</span>
        <ChevronDown size={14} className={`shrink-0 text-gray-500 transition-transform ${open?'rotate-180':''}`}/>
      </button>
      {open&&menuPos&&createPortal(
        <div ref={menuRef}
          className="fixed z-[100130] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl"
          style={{top:menuPos.top,left:menuPos.left,width:menuPos.width}}>
          {options.length>8&&(
            <div className="border-b border-gray-100 p-2">
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search..."
                className="h-8 w-full rounded-lg border border-gray-200 px-2 text-xs font-medium outline-none focus:border-blue-400"/>
            </div>
          )}
          <div className="overflow-y-auto py-1" style={{maxHeight:menuPos.maxHeight}}>
            {filtered.length===0?(
              <div className="px-3 py-3 text-center text-xs font-semibold text-gray-400">No results</div>
            ):filtered.map(option=>(
              <button key={String(option.value??'')} type="button"
                onClick={()=>{onChange(option.value);setOpen(false);setSearch('')}}
                className={`block w-full truncate px-3 py-2 text-left text-sm font-medium hover:bg-blue-50 ${String(option.value??'')===String(value??'')?'bg-blue-50 text-blue-700':'text-gray-800'}`}>
                {option.label}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

function ActivityListWorkspace({
  activities,loading,myCustomers,teamMembers,filters,setFilters,dateView,setDateView,activeCustomerName,setActiveCustomerName,today,hasActiveFilters,hasTeamScope,onPlan,onLog,onEdit,onViewDetail,canReopen=false,onReopen,
}:{
  activities:any[];loading:boolean;myCustomers:any[];teamMembers:any[];filters:FilterState;setFilters:any;
  dateView:'today'|'all'|'custom';setDateView:(v:'today'|'all'|'custom')=>void;
  activeCustomerName:string;setActiveCustomerName:(v:string)=>void;today:string;
  hasActiveFilters:boolean;hasTeamScope:boolean;onPlan:()=>void;onLog:(a:any)=>void;onEdit:(a:any)=>void;onViewDetail:(a:any)=>void;
  canReopen?:boolean;onReopen?:(a:any)=>void;
}) {
  const { label: customerLabel, singular: customerSingular } = useModuleName('customers')
  const { canCreate, canUpdate }=useKAMPerms()
  const [page,setPage]=useState(1)
  const [actionMenu,setActionMenu]=useState<{activityId:string;top:number;left:number}|null>(null)
  const pageSize=10
  const visible=useMemo(()=>[...activities].sort((a:any,b:any)=>String(a.activity_date||'').localeCompare(String(b.activity_date||''))||activitySortValue(a)-activitySortValue(b)),[activities])
  const pageCount=Math.max(1,Math.ceil(visible.length/pageSize))
  const safePage=Math.min(page,pageCount)
  const pageNumbers=useMemo(()=>{
    const range:(number|'...')[]=[]
    const delta=2
    const left=Math.max(2,safePage-delta)
    const right=Math.min(pageCount-1,safePage+delta)
    range.push(1)
    if(left>2) range.push('...')
    for(let i=left;i<=right;i++) range.push(i)
    if(right<pageCount-1) range.push('...')
    if(pageCount>1) range.push(pageCount)
    return range
  },[safePage,pageCount])
  const pageItems=visible.slice((safePage-1)*pageSize,safePage*pageSize)
  const menuActivity=actionMenu?visible.find((a:any)=>String(a.id)===actionMenu.activityId):null
  const rangeStart=visible.length===0?0:(safePage-1)*pageSize+1
  const rangeEnd=Math.min(safePage*pageSize,visible.length)
  const dateLabel=dateView==='custom'&&filters.dateFrom&&filters.dateTo
    ? `${formatActivityDate(filters.dateFrom)} - ${formatActivityDate(filters.dateTo)}`
    : dateView==='today'
      ? formatActivityDate(today)
      : 'All Dates'

  useEffect(()=>{setPage(1)},[activities.length,filters.status,filters.actType,filters.customerId,filters.userId,dateView,filters.dateFrom,filters.dateTo])
  useEffect(()=>{setActionMenu(null)},[page,activities.length,filters.status,filters.actType,filters.customerId,filters.userId,dateView,filters.dateFrom,filters.dateTo])
  useEffect(()=>{
    if(!actionMenu) return
    const close=()=>setActionMenu(null)
    const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape') close()}
    document.addEventListener('mousedown',close)
    window.addEventListener('scroll',close,true)
    window.addEventListener('resize',close)
    window.addEventListener('keydown',onKey)
    return()=>{
      document.removeEventListener('mousedown',close)
      window.removeEventListener('scroll',close,true)
      window.removeEventListener('resize',close)
      window.removeEventListener('keydown',onKey)
    }
  },[actionMenu])

  const openActionMenu=(e:any,a:any)=>{
    e.stopPropagation()
    const rect=e.currentTarget.getBoundingClientRect()
    const width=176
    const left=Math.min(Math.max(12,rect.right-width),window.innerWidth-width-12)
    const top=Math.max(12,Math.min(rect.bottom+6,window.innerHeight-152))
    const activityId=String(a.id)
    setActionMenu(prev=>prev?.activityId===activityId?null:{activityId,top,left})
  }

  const TableStatusChip=({status}:{status:string})=>{
    const sc=STATUS_CFG[status]||STATUS_CFG.Planned
    return <span className={`inline-flex rounded-md px-2 py-1 text-[11px] font-bold ${sc.bg} ${sc.text}`}>{status||'Planned'}</span>
  }
  const statusOptions=[{value:'',label:'All Status'},...STATUSES.map(s=>({value:s,label:s}))]
  const typeOptions=[{value:'',label:'All Types'},...ACTIVITY_TYPES.map(t=>({value:t,label:t}))]
  const customerOptions=[{value:'',label:`All ${customerLabel}`},...myCustomers.map((c:any)=>({value:c.id,label:c.customer_name}))]
  const memberOptions=[{value:'',label:'All Members'},...teamMembers.map((u:any)=>({value:u.id,label:`${u.full_name}${u.is_self?' (You)':''}`}))]

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-gray-200 bg-white p-2 shadow-sm">
        <div className="flex w-full flex-wrap items-center gap-2 xl:flex-nowrap">
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-gray-100 p-0.5">
            {([{id:'today',label:'Today'},{id:'all',label:'All'},{id:'custom',label:'Range'}] as const).map(v=>(
              <button key={v.id} type="button" onClick={()=>{setDateView(v.id); if(v.id!=='custom') setFilters((f:FilterState)=>({...f,dateFrom:'',dateTo:''}))}}
                className={`rounded-md px-3 py-1.5 text-xs font-bold transition ${dateView===v.id?'bg-white text-gray-950 shadow-sm ring-1 ring-gray-900':'text-gray-500 hover:text-gray-800'}`}>
                {v.label}
              </button>
            ))}
          </div>
          {dateView==='custom'&&(
            <>
              <input type="date" value={filters.dateFrom} onChange={e=>setFilters((f:FilterState)=>({...f,dateFrom:e.target.value}))} className="h-9 w-[140px] shrink-0 rounded-lg border border-gray-200 px-3 text-xs font-semibold outline-none focus:border-blue-400"/>
              <input type="date" value={filters.dateTo} onChange={e=>setFilters((f:FilterState)=>({...f,dateTo:e.target.value}))} className="h-9 w-[140px] shrink-0 rounded-lg border border-gray-200 px-3 text-xs font-semibold outline-none focus:border-blue-400"/>
            </>
          )}
          <ActivityFilterSelect value={filters.status} options={statusOptions} onChange={v=>setFilters((f:FilterState)=>({...f,status:String(v||'')}))} className="min-w-[130px] flex-1 basis-[150px]"/>
          <ActivityFilterSelect value={filters.actType} options={typeOptions} onChange={v=>setFilters((f:FilterState)=>({...f,actType:String(v||'')}))} className="min-w-[150px] flex-1 basis-[170px]"/>
          {myCustomers.length>0&&(
            <ActivityFilterSelect value={filters.customerId||''} options={customerOptions}
              onChange={v=>{const id=v?Number(v):null;const name=id?myCustomers.find((c:any)=>Number(c.id)===id)?.customer_name||'':'';setFilters((f:FilterState)=>({...f,customerId:id}));setActiveCustomerName(name)}}
              className="min-w-[220px] flex-1 basis-[260px]"/>
          )}
          {teamMembers.length>1&&(
            <ActivityFilterSelect value={filters.userId||''} options={memberOptions}
              onChange={v=>setFilters((f:FilterState)=>({...f,userId:v?Number(v):null}))}
              className="min-w-[220px] flex-1 basis-[260px]"/>
          )}
          {hasActiveFilters&&(
            <button type="button" onClick={()=>{setFilters(emptyFilter());setActiveCustomerName('')}} className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-bold text-gray-400 hover:bg-red-50 hover:text-red-500">
              <X size={12}/>Reset
            </button>
          )}
        </div>
      </div>

      {loading?(
        <div className="rounded-xl border border-gray-200 bg-white py-16 text-center"><div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"/></div>
      ):activities.length===0?(
        <div className="rounded-xl border border-gray-200 bg-white py-16 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-xl bg-gray-100"><Coffee size={20} className="text-gray-300"/></div>
          <p className="text-sm font-bold text-gray-400">No activities found</p>
          {canCreate&&<div className="mt-3"><Button onClick={onPlan}><Calendar size={14} className="mr-1.5 inline-block"/>Plan Day</Button></div>}
        </div>
      ):(
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] border-collapse text-sm">
              <thead className="bg-gray-50">
                <tr className="border-b border-gray-200 text-left text-[11px] font-black text-slate-600">
                  <th className="w-12 px-4 py-3">#</th>
                  <th className="px-4 py-3">Activity Type</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">{customerSingular}</th>
                  <th className="px-4 py-3">Member</th>
                  <th className="px-4 py-3">Date & Time</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Next Follow-up</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pageItems.map((a:any,idx:number)=>{
                  const typeName=taskTypeName(a)
                  const tc=TYPE_COLOR[typeName]||{bg:'bg-gray-50',text:'text-gray-500',dot:'bg-gray-300'}
                  const nextDate=a.next_action_date||''
                  return (
                    <tr key={a.id} className="hover:bg-blue-50/30">
                      <td className="px-4 py-3 text-xs font-bold text-gray-500">{rangeStart+idx}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-2 text-xs font-bold ${tc.text}`}>{TYPE_ICON[typeName]||<Activity size={12}/>}<span className="text-slate-700">{typeName}</span></span>
                      </td>
                      <td className="max-w-[280px] truncate px-4 py-3 text-xs font-semibold text-slate-800">{a.subject||'Untitled activity'}</td>
                      <td className="max-w-[190px] truncate px-4 py-3 text-xs font-semibold text-slate-700">{a.customer_name||'--'}</td>
                      <td className="px-4 py-3 text-xs font-semibold text-slate-700">{a.user_name||(!hasTeamScope?'Me':'--')}</td>
                      <td className="px-4 py-3 text-xs font-bold text-slate-700">{formatActivityDate(a.activity_date||today)}{a.start_time?`, ${String(a.start_time).slice(0,5)}`:''}</td>
                      <td className="px-4 py-3"><TableStatusChip status={a.status}/></td>
                      <td className={`px-4 py-3 text-xs font-bold ${nextDate?'text-red-500':'text-gray-300'}`}>{nextDate?formatActivityDate(nextDate):'--'}</td>
                      <td className="px-4 py-3 text-right">
                        <button type="button" onMouseDown={e=>e.stopPropagation()} onClick={e=>openActionMenu(e,a)} title="Actions" aria-haspopup="menu" aria-expanded={actionMenu?.activityId===String(a.id)}
                          className={`inline-flex rounded-md p-1.5 transition ${actionMenu?.activityId===String(a.id)?'bg-blue-50 text-blue-600':'text-slate-500 hover:bg-gray-100 hover:text-blue-600'}`}>
                          <MoreVertical size={15}/>
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {actionMenu&&menuActivity&&createPortal(
            <div role="menu" onMouseDown={e=>e.stopPropagation()}
              className="fixed z-[100140] w-44 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-xl"
              style={{top:actionMenu.top,left:actionMenu.left}}>
              <button type="button" role="menuitem" onClick={()=>{onViewDetail(menuActivity);setActionMenu(null)}}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold text-slate-700 hover:bg-blue-50 hover:text-blue-600">
                <Eye size={13}/>View Details
              </button>
              {canUpdate&&canEditActivity(menuActivity)&&(
                <button type="button" role="menuitem" onClick={()=>{onEdit(menuActivity);setActionMenu(null)}}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold text-slate-700 hover:bg-blue-50 hover:text-blue-600">
                  <Edit3 size={13}/>Edit Activity
                </button>
              )}
              {canUpdate&&!['Completed','Cancelled'].includes(menuActivity.status)&&(
                <button type="button" role="menuitem" onClick={()=>{onLog(menuActivity);setActionMenu(null)}}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold text-slate-700 hover:bg-blue-50 hover:text-blue-600">
                  <ListChecks size={13}/>Update Log
                </button>
              )}
              {menuActivity.status==='Completed'&&canReopen&&onReopen&&(
                <button type="button" role="menuitem" onClick={()=>{onReopen(menuActivity);setActionMenu(null)}}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold text-amber-600 hover:bg-amber-50">
                  <RefreshCw size={13}/>Reopen Activity
                </button>
              )}
            </div>,
            document.body
          )}
          <div className="flex flex-col gap-3 border-t border-gray-100 bg-gray-50/40 px-5 py-3 sm:flex-row sm:items-center">
            <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
              <span className="font-medium">
                {visible.length===0
                  ? 'No records'
                  : `${rangeStart} to ${rangeEnd} of ${visible.length} record${visible.length!==1?'s':''}`}
              </span>
              <div className="hidden h-3 w-px bg-gray-300 sm:block"/>
              <div className="flex items-center gap-1.5">
                <span className="text-gray-400">Rows per page:</span>
                <span className="rounded-lg border border-gray-200 bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white">
                  {pageSize}
                </span>
              </div>
            </div>
            {pageCount>1&&(
              <div className="flex flex-wrap items-center gap-1 sm:ml-auto">
                <button type="button" onClick={()=>setPage(1)} disabled={safePage===1}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-30"
                  title="First page">
                  <ChevronsLeft size={14}/>
                </button>
                <button type="button" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={safePage===1}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-30"
                  title="Previous page">
                  <ChevronLeft size={14}/>
                </button>
                {pageNumbers.map((p,i)=>p==='...'?(
                  <span key={`dots-${i}`} className="flex h-8 w-8 items-center justify-center text-xs text-gray-400">
                    <MoreHorizontal size={14}/>
                  </span>
                ):(
                  <button key={p} type="button" onClick={()=>setPage(p)}
                    className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-semibold transition-all ${safePage===p?'scale-105 bg-blue-600 text-white shadow-sm shadow-blue-200':'text-gray-600 hover:bg-gray-100'}`}>
                    {p}
                  </button>
                ))}
                <button type="button" onClick={()=>setPage(p=>Math.min(pageCount,p+1))} disabled={safePage===pageCount}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-30"
                  title="Next page">
                  <ChevronRight size={14}/>
                </button>
                <button type="button" onClick={()=>setPage(pageCount)} disabled={safePage===pageCount}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-30"
                  title="Last page">
                  <ChevronsRight size={14}/>
                </button>
                <div className="ml-2 flex items-center gap-1.5 border-l border-gray-200 pl-2">
                  <span className="text-xs text-gray-400">Go to</span>
                  <input type="number" min={1} max={pageCount} defaultValue={safePage} key={safePage}
                    onBlur={e=>{
                      const v=parseInt(e.target.value)
                      if(v>=1&&v<=pageCount) setPage(v)
                    }}
                    onKeyDown={e=>{
                      if(e.key==='Enter'){
                        const v=parseInt((e.target as HTMLInputElement).value)
                        if(v>=1&&v<=pageCount) setPage(v)
                      }
                    }}
                    className="w-12 rounded-lg border border-gray-200 px-2 py-1 text-center text-xs focus:border-blue-400 focus:outline-none"/>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

type WeeklyPlanUser = { id:number; name:string; email:string; role:string }
type WeeklyPlanStatus = {
  due_now:boolean
  grace_time:string
  week_label:string
  reason:string
  pending_users:number
  missing_users:WeeklyPlanUser[]
  force_send_possible:boolean
  tenant_smtp_ready:boolean
  event_email_enabled:boolean
}

function PendingWeeklyPlanPanel({
  status,loading,sending,selectedIds,onToggle,onToggleAll,onRefresh,onSendAll,onSendSelected,
}:{
  status:WeeklyPlanStatus|null;loading:boolean;sending:boolean;selectedIds:number[];
  onToggle:(id:number)=>void;onToggleAll:()=>void;onRefresh:()=>void;onSendAll:()=>void;onSendSelected:()=>void;
}) {
  if(!status&&!loading) return null
  const users=status?.missing_users||[]
  const selectedIdSet=new Set(selectedIds.map(id=>Number(id)))
  const allSelected=users.length>0&&users.every(u=>selectedIdSet.has(Number(u.id)))
  const canSend=Boolean(status?.due_now&&status?.force_send_possible)
  const blockedReason=!status?'Loading':!status.due_now?`Escalation opens after ${status.grace_time||'Monday 11:00 AM IST'}`:!status.force_send_possible?status.reason:''

  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-black text-amber-950">Pending Weekly Plan</h3>
            <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-black text-amber-700 ring-1 ring-amber-200">
              {status?.pending_users??0} Pending
            </span>
          </div>
          <p className="mt-1 text-xs font-semibold text-amber-800">
            Week: {status?.week_label||'--'} · Grace time: {status?.grace_time||'Monday 11:00 AM IST'}
          </p>
          {blockedReason&&<p className="mt-1 text-xs font-semibold text-amber-600">{blockedReason}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onRefresh} disabled={loading}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-amber-200 bg-white px-3 text-xs font-bold text-amber-700 hover:bg-amber-50 disabled:opacity-50">
            <RefreshCw size={12} className={loading?'animate-spin':''}/>Refresh
          </button>
          <button type="button" onClick={onSendAll} disabled={!canSend||users.length===0||sending}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-amber-300 bg-white px-3 text-xs font-black text-amber-800 hover:bg-amber-100 disabled:opacity-50">
            <Mail size={12}/>Send Escalation to All
          </button>
          <button type="button" onClick={onSendSelected} disabled={!canSend||selectedIds.length===0||sending}
            className="inline-flex h-9 items-center gap-1 rounded-lg bg-amber-600 px-3 text-xs font-black text-white hover:bg-amber-700 disabled:opacity-50">
            <Mail size={12}/>Send Escalation
          </button>
        </div>
      </div>

      {users.length>0&&(
        <div className="mt-3 overflow-hidden rounded-xl border border-amber-200 bg-white">
          <label className="flex items-center gap-3 border-b border-amber-100 bg-amber-50 px-3 py-2 text-xs font-black text-amber-900">
            <input type="checkbox" checked={allSelected} onChange={onToggleAll}
              className="h-4 w-4 rounded border-amber-300 text-amber-600 focus:ring-amber-500"/>
            Select all pending users
          </label>
          <div className="max-h-60 divide-y divide-amber-100 overflow-y-auto">
            {users.map(user=>(
              <label key={user.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-amber-50/70">
                <input type="checkbox" checked={selectedIdSet.has(Number(user.id))} onChange={()=>onToggle(Number(user.id))}
                  className="h-4 w-4 rounded border-amber-300 text-amber-600 focus:ring-amber-500"/>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-slate-900">{user.name}</span>
                  <span className="block truncate text-xs font-medium text-slate-500">{user.email||'No email'} · {user.role||'-'}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Sales Team Performance Block ────────────────────────────────────────────
// Left panel: scrollable group list with colored dots + potential value
// Right panel: selected group detail, KPI cards, and member metrics
type SalesTeamPerformanceMetric = 'customers'|'leads'|'opportunities'|'tenders'|'activities'|'workOrders'
function SalesTeamPerformanceBlock({
  groups,
  onCustomerPanel,
  onLeadPanel,
  onTenderPanel,
  onWorkOrderPanel,
  onGroupCustomerPanel,
  onGroupLeadPanel,
  onGroupTenderPanel,
  onGroupWorkOrderPanel,
  onActivityPanel,
  onMemberDetails,
  memberRecordSummaries = {},
}: {
  groups: any[]
  onCustomerPanel: (uid?: number, name?: string, ownOnly?: boolean) => void
  onLeadPanel: (uid?: number, name?: string, mode?: 'leads'|'opportunities') => void
  onTenderPanel: (uid?: number, name?: string) => void
  onWorkOrderPanel: (uid?: number, name?: string) => void
  onGroupCustomerPanel?: (groupName: string, members: any[]) => void
  onGroupLeadPanel?: (groupName: string, members: any[], mode?: 'leads'|'opportunities') => void
  onGroupTenderPanel?: (groupName: string, members: any[]) => void
  onGroupWorkOrderPanel?: (groupName: string, members: any[]) => void
  onActivityPanel: (actType?: string, uid?: number, name?: string) => void
  onMemberDetails?: (member: any, tab?: MemberDetailsTab) => void
  memberRecordSummaries?: MemberRecordSummaryMap
}) {
  const { label: customerLabel, labelLower: customerLabelLower } = useModuleName('customers')
  const { label: leadLabel, labelLower: leadLabelLower } = useModuleName('leads')
  const { label: tenderLabel } = useModuleName('tenders')
  const { label: oppLabel } = useModuleName('opportunities')
  const { label: workOrderLabel, labelLower: workOrderLabelLower } = useModuleName('workorders')
  const [selIdx, setSelIdx] = useState(0)
  if (!groups.length) return null

  const sel = groups[Math.min(selIdx, groups.length - 1)]
  const members: any[] = sel?.members || []
  const memberSummary = (member: any, tab: MemberDetailsTab): MemberMetricSummary | null => {
    const uid = Number(member?.user_id || member?.id || 0)
    return uid ? memberRecordSummaries[uid]?.[tab] || null : null
  }
  const metricValue = (member: any, tab: MemberDetailsTab, fallback: number) => {
    const summary = memberSummary(member, tab)
    return summary ? summary.value : fallback
  }
  const metricCount = (member: any, tab: MemberDetailsTab, fallback: number) => {
    const summary = memberSummary(member, tab)
    return summary ? summary.count : fallback
  }
  const groupMetric = (
    tab: MemberDetailsTab,
    valueFallback: (member: any) => number,
    countFallback: (member: any) => number,
  ) => members.reduce((sum, member) => ({
    value: sum.value + metricValue(member, tab, valueFallback(member)),
    count: sum.count + metricCount(member, tab, countFallback(member)),
  }), { value: 0, count: 0 })
  const groupCustomerValue = (group: any) => (Array.isArray(group?.members) ? group.members : [])
    .reduce((sum: number, member: any) => sum + metricValue(member, 'customers', Number(member.customer_potential_value ?? member.potential ?? 0)), 0)

  const customerTotals = groupMetric('customers', (m:any)=>Number(m.customer_potential_value ?? m.potential ?? 0), (m:any)=>Number(m.own_customers ?? m.customers ?? 0))
  const leadTotals = groupMetric('leads', (m:any)=>Number(m.lead_value || 0), (m:any)=>Number(m.lead_count || 0))
  const opportunityTotals = groupMetric('opportunities', (m:any)=>Number(m.opportunity_value || 0), (m:any)=>Number(m.opportunity_count || 0))
  const tenderTotals = groupMetric('tenders', (m:any)=>Number(m.tender_value || 0), (m:any)=>Number(m.tender_count || 0))
  const workOrderTotals = groupMetric('workorders', (m:any)=>Number(m.wo_value || m.won_tender_value || 0), (m:any)=>Number(m.wo_count || 0))

  const groupHead =
    sel.managerName
    || members.find((m: any) => ['vp','manager','sales_head'].includes((m.role||'').toLowerCase()))?.user_name
    || members[0]?.user_name || ''

  const kpis = [
    { key: 'customers' as const,     label: customerLabel, value: fmt(customerTotals.value),    sub: `${customerTotals.count} ${customerLabelLower}`, accent: '#3b82f6', bg: '#eff6ff' },
    { key: 'leads' as const,         label: leadLabel,     value: fmt(leadTotals.value),        sub: `${leadTotals.count} ${leadLabelLower}`, accent: '#10b981', bg: '#f0fdf4' },
    { key: 'opportunities' as const, label: oppLabel,      value: fmt(opportunityTotals.value), sub: `${opportunityTotals.count} deals`,    accent: '#f59e0b', bg: '#fffbeb' },
    { key: 'tenders' as const,       label: tenderLabel,   value: fmt(tenderTotals.value),      sub: `${tenderTotals.count} bids`,          accent: '#8b5cf6', bg: '#f5f3ff' },
    { key: 'workOrders' as const,    label: workOrderLabel,value: fmt(workOrderTotals.value),   sub: `${workOrderTotals.count} ${workOrderLabelLower}`, accent: '#10b981', bg: '#f0fdf4' },
  ]

  const DOT_COLORS = ['#10b981','#f97316','#eab308','#3b82f6','#8b5cf6','#ec4899','#06b6d4','#f43f5e']
  const normalizeGroupColor = (color: unknown, index: number) => {
    const raw = String(color || '').trim()
    if (/^#[0-9a-f]{6}$/i.test(raw)) return raw
    if (/^#[0-9a-f]{3}$/i.test(raw)) return `#${raw.slice(1).split('').map(ch => ch + ch).join('')}`
    return DOT_COLORS[index % DOT_COLORS.length]
  }
  const groupTint = (hex: string, alpha: number) => {
    const h = hex.replace('#', '')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  const initials = (name: string) =>
    (name || '??').split(' ').map((p: string) => p.charAt(0)).join('').slice(0, 2).toUpperCase()
  const openGroupMetric = (metric: SalesTeamPerformanceMetric, group = sel) => {
    const groupName = String(group?.name || 'Sales Team')
    const groupMembers = Array.isArray(group?.members) ? group.members : []
    if (metric === 'customers') return onGroupCustomerPanel ? onGroupCustomerPanel(groupName, groupMembers) : groupMembers[0] && onCustomerPanel(groupMembers[0].user_id, groupName)
    if (metric === 'leads') return onGroupLeadPanel ? onGroupLeadPanel(groupName, groupMembers, 'leads') : groupMembers[0] && onLeadPanel(groupMembers[0].user_id, groupName)
    if (metric === 'opportunities') return onGroupLeadPanel ? onGroupLeadPanel(groupName, groupMembers, 'opportunities') : groupMembers[0] && onLeadPanel(groupMembers[0].user_id, groupName, 'opportunities')
    if (metric === 'tenders') return onGroupTenderPanel ? onGroupTenderPanel(groupName, groupMembers) : groupMembers[0] && onTenderPanel(groupMembers[0].user_id, groupName)
    return onGroupWorkOrderPanel ? onGroupWorkOrderPanel(groupName, groupMembers) : groupMembers[0] && onWorkOrderPanel(groupMembers[0].user_id, groupName)
  }
  const openMemberMetric = (metric: SalesTeamPerformanceMetric, member: any) => {
    const uid = Number(member?.user_id || 0) || undefined
    const name = member?.user_name
    if (metric === 'customers') return onCustomerPanel(uid, name, true)
    if (metric === 'leads') return onLeadPanel(uid, name, 'leads')
    if (metric === 'opportunities') return onLeadPanel(uid, name, 'opportunities')
    if (metric === 'tenders') return onTenderPanel(uid, name)
    if (metric === 'activities') return onActivityPanel(undefined, uid, name)
    return onWorkOrderPanel(uid, name)
  }
  const openFullMemberDetails = (member: any, tab?: MemberDetailsTab) => {
    if (onMemberDetails) { onMemberDetails(member, tab); return }
    const metric: SalesTeamPerformanceMetric = tab === 'workorders' ? 'workOrders' : tab === 'tenders' ? 'tenders' : tab === 'leads' ? 'leads' : tab === 'opportunities' ? 'opportunities' : tab === 'activities' ? 'activities' : 'customers'
    openMemberMetric(metric, member)
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex min-h-[390px]">

        {/* ── Left: group list ── */}
        <div className="w-60 flex-shrink-0 border-r border-slate-100 bg-white">
          <div className="px-3 pb-1.5 pt-3 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400">Groups</div>
          <div className="space-y-0.5 px-2 pb-2">
            {groups.map((g: any, i: number) => {
              const isActive = i === selIdx
              const accent = normalizeGroupColor(g.color || g.group_color || g.theme_color || g.colour, i)
              return (
                <button key={g.key} onClick={() => setSelIdx(i)}
                  aria-current={isActive ? 'true' : undefined}
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors"
                  style={{ backgroundColor: isActive ? groupTint(accent, 0.12) : undefined }}
                  onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.backgroundColor = '#f8fafc' }}
                  onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: accent }} />
                    <div className="min-w-0">
                      <div className="whitespace-normal break-words text-[12px] font-semibold leading-tight text-slate-800">{g.name}</div>
                      <div className="text-[9px] text-slate-400">{g.members.length} members</div>
                    </div>
                  </div>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={e => { e.stopPropagation(); openGroupMetric('customers', g) }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        e.stopPropagation()
                        openGroupMetric('customers', g)
                      }
                    }}
                    className="ml-2 flex-shrink-0 rounded-md px-1 py-0.5 text-[11px] font-bold tabular-nums text-slate-700 transition hover:bg-white hover:text-blue-700"
                    title={`View ${customerLabelLower}`}
                  >
                    {fmt(groupCustomerValue(g))}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Right: detail panel ── */}
        <div className="min-w-0 flex-1 overflow-auto p-3.5">

          {/* Header */}
          <div className="mb-3 flex items-start justify-between">
            <div>
              <div className="mb-0.5 text-[8px] font-bold uppercase tracking-[0.14em] text-slate-400">
                SALES GROUP{groupHead ? ` · HEAD ${groupHead.toUpperCase()}` : ''}
              </div>
              <div className="text-[19px] font-bold leading-tight text-slate-900">{sel.name}</div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {members.length} member{members.length !== 1 ? 's' : ''}
              </div>
            </div>
            <button type="button" onClick={() => openGroupMetric('customers')}
              className="rounded-lg px-2 py-1 text-right transition hover:bg-blue-50">
              <div className="text-[22px] font-bold tabular-nums leading-tight text-slate-900 hover:text-blue-700">
                {fmt(customerTotals.value)}
              </div>
              <div className="mt-0.5 text-[10px] text-slate-400">{customerLabelLower} potential</div>
            </button>
          </div>

          {/* KPI cards */}
          <div className="mb-3 grid grid-cols-5 gap-2">
            {kpis.map(({ key, label, value, sub, accent }) => (
              <button key={label} type="button" onClick={() => openGroupMetric(key)}
                className="rounded-lg border border-slate-100 bg-white px-3 py-2.5 text-left shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: accent }} />
                  <span className="text-[10px] font-medium text-slate-400">{label}</span>
                </div>
                <div className="text-[17px] font-bold tabular-nums leading-tight text-slate-900">{value}</div>
                <div className="mt-0.5 text-[10px] text-slate-400">{sub}</div>
              </button>
            ))}
          </div>

          {/* Heatmap grid */}
          {(() => {
            const HMAP_COLS: { key:string; tab:MemberDetailsTab; label:string; r:number; g:number; b:number; getVal:(m:any)=>number; getCnt:(m:any)=>number }[] = [
              { key:'customers',    tab:'customers',    label:customerLabel, r:82,  g:111, b:181, getVal:(m:any)=>metricValue(m,'customers',Number(m.customer_potential_value||m.potential||0)), getCnt:(m:any)=>metricCount(m,'customers',Number(m.own_customers??m.customers??0)) },
              { key:'leads',        tab:'leads',        label:leadLabel,     r:58,  g:158, b:143, getVal:(m:any)=>metricValue(m,'leads',Number(m.lead_value||0)), getCnt:(m:any)=>metricCount(m,'leads',Number(m.lead_count||0)) },
              { key:'opportunities',tab:'opportunities',label:oppLabel,      r:205, g:166, b:105, getVal:(m:any)=>metricValue(m,'opportunities',Number(m.opportunity_value||0)), getCnt:(m:any)=>metricCount(m,'opportunities',Number(m.opportunity_count||0)) },
              { key:'tenders',      tab:'tenders',      label:tenderLabel,   r:159, g:132, b:190, getVal:(m:any)=>metricValue(m,'tenders',Number(m.tender_value||0)), getCnt:(m:any)=>metricCount(m,'tenders',Number(m.tender_count||0)) },
              { key:'workorders',   tab:'workorders',   label:workOrderLabel,r:190, g:143, b:161, getVal:(m:any)=>metricValue(m,'workorders',Number(m.wo_value||m.won_tender_value||0)), getCnt:(m:any)=>metricCount(m,'workorders',Number(m.wo_count||0)) },
            ]
            const maxVals = HMAP_COLS.map(col => Math.max(1, ...members.map(col.getVal)))
            const metricFill = (col: typeof HMAP_COLS[0], colIdx: number, m: any) => {
              const v = col.getVal(m)
              if (!v) return 'transparent'
              // White→color interpolation with a sqrt-ish curve so low values fade to near-white
              // and the highest value gets the full saturated color
              const ratio = Math.min(1, v / maxVals[colIdx])
              const alpha = 0.12 + Math.pow(ratio, 0.55) * 0.24
              return `rgba(${col.r}, ${col.g}, ${col.b}, ${alpha})`
            }
            return (
              <div className="overflow-x-auto rounded-lg border border-slate-100">
                {/* Column header */}
                <div className="grid border-b border-slate-100 bg-slate-50" style={{gridTemplateColumns:'210px repeat(5,minmax(136px,1fr))'}}>
                  <div className="px-3 py-1.5 text-[9px] font-bold uppercase tracking-wide text-slate-400">Member</div>
                  {HMAP_COLS.map(col=>(
                    <div key={col.key} className="px-2 py-1.5 text-center text-[9px] font-bold uppercase tracking-wide text-slate-500">{col.label}</div>
                  ))}
                </div>
                {/* Member rows */}
                {members.map((m:any)=>(
                  <div key={m.user_id} className="grid border-b border-slate-50 last:border-0 transition hover:bg-slate-50/40" style={{gridTemplateColumns:'210px repeat(5,minmax(136px,1fr))'}}>
                    {/* Name cell */}
                    <button type="button" onClick={()=>openFullMemberDetails(m)}
                      className="flex items-center gap-2 border-r border-slate-100 px-3 py-2 text-left transition hover:bg-slate-50">
                      <div className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-slate-200 text-[9px] font-bold text-slate-600">
                        {initials(m.user_name)}
                      </div>
                      <div className="min-w-0">
                        <div className="whitespace-normal break-words text-[11px] font-semibold leading-tight text-slate-800">{m.user_name}</div>
                        <div className="truncate text-[9px] capitalize text-slate-400">{(m.role||'sales').replace(/_/g,' ')}</div>
                      </div>
                    </button>
                    {/* Metric cells */}
                    {HMAP_COLS.map((col,ci)=>{
                      const val = col.getVal(m)
                      const cnt = col.getCnt(m)
                      const bg = metricFill(col,ci,m)
                      const hasMetric = val > 0 || cnt > 0
                      return (
                        <button key={col.key} type="button"
                          onClick={e=>{e.stopPropagation();openFullMemberDetails(m,col.tab)}}
                          className="flex items-center justify-center px-1 py-1 text-center transition hover:bg-slate-50">
                          <span
                            className={`mx-auto grid min-h-[42px] w-full items-center justify-center rounded-md px-2 py-1 transition ${hasMetric ? 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.32)]' : ''}`}
                            style={{backgroundColor:bg, gridTemplateColumns:'minmax(52px,max-content) 1px minmax(28px,max-content)'}}
                          >
                            <span className="min-w-0 pr-2 text-center">
                              <span className="block max-w-[86px] truncate text-[12px] font-black tabular-nums leading-tight text-slate-950">{fmt(val)}</span>
                            </span>
                            <span className={`h-7 w-px justify-self-center ${hasMetric ? 'bg-slate-300/70' : 'bg-slate-200/70'}`} />
                            <span className="min-w-0 pl-2 text-center">
                              <span className="block text-[12px] font-black tabular-nums leading-tight text-slate-950">{cnt.toLocaleString('en-IN')}</span>
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      </div>
    </div>
  )
}

// ─── Portfolio Analysis Section (Segment / Business Unit drill-down) ──────────
const INDIA_REGION_MAP: Record<string, string> = {
  'andhra pradesh': 'South', 'telangana': 'South', 'tamil nadu': 'South',
  'kerala': 'South', 'karnataka': 'South', 'puducherry': 'South',
  'andaman and nicobar islands': 'South', 'lakshadweep': 'South',
  'maharashtra': 'West', 'gujarat': 'West', 'goa': 'West',
  'dadra and nagar haveli and daman and diu': 'West', 'dadra & nagar haveli': 'West',
  'daman and diu': 'West',
  'rajasthan': 'North', 'delhi': 'North', 'haryana': 'North', 'punjab': 'North',
  'himachal pradesh': 'North', 'jammu and kashmir': 'North', 'ladakh': 'North',
  'uttarakhand': 'North', 'uttar pradesh': 'North', 'chandigarh': 'North',
  'west bengal': 'East', 'odisha': 'East', 'bihar': 'East', 'jharkhand': 'East',
  'madhya pradesh': 'Central', 'chhattisgarh': 'Central',
  'assam': 'Northeast', 'arunachal pradesh': 'Northeast', 'meghalaya': 'Northeast',
  'manipur': 'Northeast', 'mizoram': 'Northeast', 'nagaland': 'Northeast',
  'tripura': 'Northeast', 'sikkim': 'Northeast',
}

function regionForState(stateName: string): string {
  return INDIA_REGION_MAP[stateName.toLowerCase().trim()] || 'Other'
}

type PASDrill =
  | { step: 'regions' }
  | { step: 'states'; regionName: string; customers: any[] }
  | { step: 'groups'; regionName: string; stateName: string; customers: any[] }

function PortfolioAnalysisSection({
  sectionTitle, subtitle, accentBar, groupKeys, stateRows,
  onViewCustomers, portfolioValueFn, portfolioLabelFn, fmtFn, icon: Icon,
  showRegions,
}: {
  sectionTitle: string
  subtitle: string
  accentBar: string
  groupKeys: string[]
  stateRows: Array<{key:string;label:string;count:number;value:number;customers:any[]}>
  onViewCustomers: (label: string, customers: any[]) => void
  portfolioValueFn: (c: any) => number
  portfolioLabelFn: (c: any, keys: string[]) => string
  fmtFn: (v: number) => string
  icon: React.ElementType
  showRegions?: boolean
}) {
  const { label: customerLabel, labelLower: customerLabelLower } = useModuleName('customers')
  const [drill, setDrill] = useState<PASDrill>(showRegions ? { step: 'regions' } : { step: 'states', regionName: '', customers: [] })

  const regionRows = useMemo(() => {
    if (!showRegions) return []
    const map = new Map<string, { label: string; count: number; value: number; stateRows: typeof stateRows }>()
    stateRows.filter(r => r.count > 0).forEach(row => {
      const region = regionForState(row.label)
      const entry = map.get(region) || { label: region, count: 0, value: 0, stateRows: [] }
      entry.count += row.count
      entry.value += row.value
      entry.stateRows.push(row)
      map.set(region, entry)
    })
    const ORDER = ['South', 'West', 'North', 'East', 'Central', 'Northeast', 'Other']
    return Array.from(map.values()).sort((a, b) => {
      const ai = ORDER.indexOf(a.label); const bi = ORDER.indexOf(b.label)
      if (ai !== -1 && bi !== -1) return ai - bi
      return (b.count - a.count) || a.label.localeCompare(b.label)
    })
  }, [stateRows, showRegions])

  const visibleStates = useMemo(() => {
    if (showRegions) {
      if (drill.step !== 'states') return []
      return stateRows.filter(r => r.count > 0 && regionForState(r.label) === drill.regionName).slice(0, 20)
    }
    return stateRows.filter(r => r.count > 0).slice(0, 20)
  }, [stateRows, drill, showRegions])

  const groupRows = useMemo(() => {
    if (drill.step !== 'groups') return []
    const map = new Map<string, { label: string; count: number; value: number; customers: any[] }>()
    drill.customers.forEach(c => {
      const lbl = portfolioLabelFn(c, groupKeys)
      const entry = map.get(lbl) || { label: lbl, count: 0, value: 0, customers: [] }
      entry.count++
      entry.value += portfolioValueFn(c)
      entry.customers.push(c)
      map.set(lbl, entry)
    })
    const rows = Array.from(map.values()).sort((a, b) => (b.value - a.value) || (b.count - a.count))
    const max = Math.max(1, ...rows.map(r => r.value || r.count))
    return rows.map(r => ({ ...r, pct: Math.max(5, Math.round(((r.value || r.count) / max) * 100)) }))
  }, [drill, groupKeys, portfolioValueFn, portfolioLabelFn])

  const backToRoot = () => setDrill(showRegions ? { step: 'regions' } : { step: 'states', regionName: '', customers: [] })

  return (
    <div className="rounded-2xl border border-gray-200 bg-white px-5 py-5">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-2 text-sm font-bold text-gray-900">
            <Icon size={14} className="shrink-0" style={{ color: accentBar }} />
            {sectionTitle}
          </h3>
          <span className="text-[11px] font-medium text-slate-400">{subtitle}</span>
        </div>
        {drill.step !== 'regions' && drill.step !== 'states' && (
          <button
            onClick={backToRoot}
            className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-800 transition-colors"
          >
            <ChevronLeft size={12} /> {showRegions ? 'All Regions' : 'All States'}
          </button>
        )}
        {showRegions && drill.step === 'states' && (
          <button
            onClick={backToRoot}
            className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-800 transition-colors"
          >
            <ChevronLeft size={12} /> All Regions
          </button>
        )}
      </div>

      {/* Breadcrumb trail */}
      {showRegions && drill.step === 'states' && (
        <div className="mb-3 flex items-center gap-1 text-[11px]">
          <button onClick={backToRoot} className="font-semibold text-blue-600 hover:underline">Regions</button>
          <ChevronRight size={10} className="text-slate-300" />
          <span className="font-bold text-slate-800">{drill.regionName}</span>
        </div>
      )}
      {drill.step === 'groups' && (
        <div className="mb-3 flex items-center gap-1 text-[11px]">
          <button onClick={backToRoot} className="font-semibold text-blue-600 hover:underline">
            {showRegions ? 'Regions' : 'States'}
          </button>
          {showRegions && (
            <>
              <ChevronRight size={10} className="text-slate-300" />
              <button
                onClick={() => setDrill({ step: 'states', regionName: drill.regionName, customers: [] })}
                className="font-semibold text-blue-600 hover:underline"
              >{drill.regionName}</button>
            </>
          )}
          <ChevronRight size={10} className="text-slate-300" />
          <span className="font-bold text-slate-800">{drill.stateName}</span>
        </div>
      )}
      {/* ── Regions table ── */}
      {showRegions && drill.step === 'regions' && (
        <div className="overflow-hidden rounded-xl border border-slate-100">
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-4 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Region</th>
                <th className="px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide text-center">States</th>
                <th className="px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide text-right">{customerLabel}</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide text-right">Value</th>
                <th className="w-6" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {regionRows.length === 0 && (
                <tr><td colSpan={5} className="py-8 text-center text-xs text-slate-400">No {customerLabelLower} data available</td></tr>
              )}
              {regionRows.map((region, i) => (
                <tr
                  key={region.label}
                  onClick={() => setDrill({ step: 'states', regionName: region.label, customers: [] })}
                  className={`group cursor-pointer transition-colors hover:bg-blue-50 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}
                >
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <Globe size={11} className="shrink-0 text-slate-300 group-hover:text-blue-400 transition-colors" />
                      <span className="font-semibold text-slate-800 group-hover:text-blue-700 transition-colors">{region.label}</span>
                    </span>
                  </td>
                  <td className="px-3 py-3 text-center text-slate-500">{region.stateRows.length}</td>
                  <td className="px-3 py-3 text-right font-medium text-slate-700">{region.count.toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3 text-right font-black text-slate-900">{fmtFn(region.value)}</td>
                  <td className="pr-3 py-3 text-right"><ChevronRight size={13} className="text-slate-200 group-hover:text-blue-400 transition-colors ml-auto" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── States table ── */}
      {drill.step === 'states' && (
        <div className="overflow-hidden rounded-xl border border-slate-100">
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-4 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">State</th>
                <th className="px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide text-right">{customerLabel}</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide text-right">Value</th>
                <th className="w-6" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {visibleStates.length === 0 && (
                <tr><td colSpan={4} className="py-8 text-center text-xs text-slate-400">No {customerLabelLower} data available</td></tr>
              )}
              {visibleStates.map((row, i) => (
                <tr
                  key={row.key}
                  onClick={() => { const rn = drill.step === 'states' ? drill.regionName : ''; setDrill({ step: 'groups', regionName: rn, stateName: row.label, customers: row.customers }) }}
                  className={`group cursor-pointer transition-colors hover:bg-blue-50 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}
                >
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <MapPin size={11} className="shrink-0 text-slate-300 group-hover:text-blue-400 transition-colors" />
                      <span className="font-semibold text-slate-800 group-hover:text-blue-700 transition-colors">{row.label}</span>
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right font-medium text-slate-700">{row.count.toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3 text-right font-black text-slate-900">{fmtFn(row.value)}</td>
                  <td className="pr-3 py-3 text-right"><ChevronRight size={13} className="text-slate-200 group-hover:text-blue-400 transition-colors ml-auto" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Groups table ── */}
      {drill.step === 'groups' && (
        <div className="overflow-hidden rounded-xl border border-slate-100">
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-4 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Segment</th>
                <th className="px-3 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide text-right">{customerLabel}</th>
                <th className="px-4 py-2.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wide text-right">Value</th>
                <th className="w-6" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {groupRows.length === 0 && (
                <tr><td colSpan={4} className="py-8 text-center text-xs text-slate-400">No data for this state</td></tr>
              )}
              {groupRows.map((g, i) => (
                <tr
                  key={g.label}
                  onClick={() => onViewCustomers(`${drill.stateName} — ${g.label}`, g.customers)}
                  className={`group cursor-pointer transition-colors hover:bg-blue-50 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}
                >
                  <td className="px-4 py-3">
                    <div className="mb-1.5 font-semibold text-slate-800 group-hover:text-blue-700 transition-colors">{g.label}</div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${g.pct}%`, background: accentBar }} />
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right font-medium text-slate-700">{g.count.toLocaleString('en-IN')}</td>
                  <td className="px-4 py-3 text-right font-black text-slate-900">{fmtFn(g.value)}</td>
                  <td className="pr-3 py-3 text-right"><ChevronRight size={13} className="text-slate-200 group-hover:text-blue-400 transition-colors ml-auto" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

type CustomerSegmentAnalysisTab = {
  id: string
  label: string
  groupColLabel: string
  groupKeys: string[]
  secondaryGroupKeys?: string[]
  accentBar: string
}

type CustomerSubSegmentMaster = {
  id?: number
  name: string
  sector_id?: number
  sector_name: string
}

type UnitRecordKind = 'customers' | 'leads' | 'opportunities' | 'tenders' | 'workorders'
type UnitDrillState = {
  key: string
  label: string
  verticalLabel: string
  scope?: 'unit' | 'vertical' | 'segment' | 'subsegment'
  unit: any
  customerIds: number[]
  unitIds?: number[]
  allTime?: boolean
  customerScopeOnly?: boolean
  activeTab: UnitRecordKind
  loading: boolean
  rowsByKind: Partial<Record<UnitRecordKind, any[]>>
  search: string
  statusFilter?: string
  customerFilter?: string
  assigneeFilter?: string
  fromDate?: string
  toDate?: string
  sourceFilter?: string
  error?: string
}

function CustomerSegmentAnalysisSection({
  stateRows, tabs, onViewCustomers, onViewUnit, portfolioValueFn, portfolioLabelFn, fmtFn,
  sectionTitle, subtitle, accentBar, icon: Icon, masterSegments, masterStateMap, masterRegionNames,
  masterAllStates, masterStateDistricts,
  masterSegmentSubSegments,
  masterSources,
  masterUnitVertical, masterVerticalUnits, businessUnitAnalysis, fiscalYear, fiscalYearOptions, onFiscalYearChange,
  teamMembers = [], teamRows = [],
  onLoadUnitRecords,
}: {
  stateRows: Array<{key:string;label:string;count:number;value:number;customers:any[]}>
  tabs: CustomerSegmentAnalysisTab[]
  onViewCustomers: (label: string, customers: any[]) => void
  onViewUnit?: (unitLabel: string, verticalLabel: string, customerIds: number[], meta?: { unitId?: number }) => void
  onLoadUnitRecords?: (kind: UnitRecordKind, unitLabel: string, verticalLabel: string, customerIds: number[], meta?: { unitId?: number | string; allTime?: boolean; customerScopeOnly?: boolean }) => Promise<any[]>
  portfolioValueFn: (c: any) => number
  portfolioLabelFn: (c: any, keys: string[]) => string
  fmtFn: (v: number) => string
  sectionTitle: string
  subtitle?: string
  accentBar: string
  icon: React.ElementType
  masterSegments?: string[]
  masterStateMap?: Map<string, string>
  masterRegionNames?: string[]
  masterAllStates?: Array<{name:string;region_name:string}>
  masterStateDistricts?: Map<string, string[]>
  masterSegmentSubSegments?: CustomerSubSegmentMaster[]
  masterSources?: string[]
  masterUnitVertical?: Map<string, string>
  masterVerticalUnits?: Map<string, string[]>
  businessUnitAnalysis?: any
  teamMembers?: any[]
  teamRows?: any[]
  fiscalYear?: number
  fiscalYearOptions?: number[]
  onFiscalYearChange?: (year: number) => void
}) {
  const { label: customerLabel, singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const { label: leadLabel, singular: leadSingular } = useModuleName('leads')
  const { label: opportunityLabel, singular: opportunitySingular } = useModuleName('opportunities')
  const { label: tenderLabel, singular: tenderSingular } = useModuleName('tenders')
  const { label: workOrderLabel, singular: workOrderSingular } = useModuleName('workorders')
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null)
  const [selectedState, setSelectedState] = useState<{ label: string; customers: any[] } | null>(null)
  const [selectedDistrict, setSelectedDistrict] = useState<{ label: string; customers: any[] } | null>(null)
  const [regionSelectorOpen, setRegionSelectorOpen] = useState(false)
  const [stateSelectorOpen, setStateSelectorOpen] = useState(false)
  const [stateFilterEnabled, setStateFilterEnabled] = useState(false)
  const [districtFilterEnabled, setDistrictFilterEnabled] = useState(false)
  const [activeTabId, setActiveTabId] = useState(() => tabs[0]?.id || 'segment')
  const [selectedSegment, setSelectedSegment] = useState<{ label: string; customers: any[] } | null>(null)
  const [subSegmentBreakdown, setSubSegmentBreakdown] = useState<{ segmentLabel: string; rows: any[] } | null>(null)
  const [unitBreakdown, setUnitBreakdown] = useState<{ verticalLabel: string; rows: any[]; vertical?: any } | null>(null)
  const [verticalPopupTab, setVerticalPopupTab] = useState<UnitRecordKind>('leads')
  const [unitPopupOpen, setUnitPopupOpen] = useState(false)
  const [unitPopupMaximized, setUnitPopupMaximized] = useState(false)
  const [selectedUnit, setSelectedUnit] = useState<{ label: string; verticalLabel: string; customers: any[]; leads: number; opportunities: number; tenders: number; workOrders: number; value: number } | null>(null)
  const [unitDrill, setUnitDrill] = useState<UnitDrillState | null>(null)
  const [unitDrillPage, setUnitDrillPage] = useState(1)
  const [unitDrillPageSize, setUnitDrillPageSize] = useState<number | 'All'>(25)
  const [expandedBusinessVerticalKeys, setExpandedBusinessVerticalKeys] = useState<Set<string>>(new Set())
  const [expandedSegmentSubSegmentKeys, setExpandedSegmentSubSegmentKeys] = useState<Set<string>>(new Set())

  const activeTab = tabs.find(tab => tab.id === activeTabId) || tabs[0]
  const groupKeys = activeTab?.groupKeys || []
  const secondaryGroupKeys = activeTab?.secondaryGroupKeys || []
  const groupColLabel = activeTab?.groupColLabel || 'Segment'
  const activeAccent = activeTab?.accentBar || accentBar
  const hasTwoPanel = secondaryGroupKeys.length > 0
  const subtitleText = subtitle === undefined
              ? `Analyze ${hasTwoPanel ? 'business verticals and pipeline' : `${customerLabelLower} segments`} by region, state and district`
    : subtitle

  const regionForStateLabel = useCallback((label: string): string | null => {
    const key = label.toLowerCase().trim()
    if (masterStateMap && masterStateMap.size > 0) return masterStateMap.get(key) || null
    return regionForState(label)
  }, [masterStateMap])

  const stateDataByKey = useMemo(() => {
    const map = new Map<string, { count: number; value: number; customers: any[] }>()
    stateRows.forEach(row => {
      map.set(normalizeStateKey(row.label), {
        count: Number(row.count || 0),
        value: Number(row.value || 0),
        customers: row.customers || [],
      })
    })
    return map
  }, [stateRows])

  const rowsForRegion = useCallback((region: string | null) => {
    if (masterAllStates && masterAllStates.length > 0) {
      return masterAllStates
        .filter(s => s.name && (!region || s.region_name === region))
        .map(s => {
          const data = stateDataByKey.get(normalizeStateKey(s.name)) || { count: 0, value: 0, customers: [] }
          return { key: normalizeStateKey(s.name), label: s.name, ...data }
        })
        .sort((a, b) => (b.count - a.count) || (b.value - a.value) || a.label.localeCompare(b.label))
    }
    const sorted = stateRows
      .filter(r => Number(r.count || 0) > 0)
      .sort((a, b) => (b.count - a.count) || (b.value - a.value) || a.label.localeCompare(b.label))
    return region ? sorted.filter(r => regionForStateLabel(r.label) === region) : sorted
  }, [masterAllStates, stateDataByKey, stateRows, regionForStateLabel])

  const regionRows = useMemo(() => {
    const map = new Map<string, { label: string; count: number; value: number; stateCount: number }>()
    if (masterRegionNames && masterRegionNames.length > 0) {
      masterRegionNames.forEach(region => {
        if (region && !map.has(region)) map.set(region, { label: region, count: 0, value: 0, stateCount: 0 })
      })
    }
    if (masterAllStates && masterAllStates.length > 0) {
      masterAllStates.forEach(state => {
        const region = state.region_name || regionForStateLabel(state.name)
        if (!region) return
        const data = stateDataByKey.get(normalizeStateKey(state.name))
        const entry = map.get(region) || { label: region, count: 0, value: 0, stateCount: 0 }
        entry.count += Number(data?.count || 0)
        entry.value += Number(data?.value || 0)
        entry.stateCount += 1
        map.set(region, entry)
      })
    } else {
      stateRows.filter(r => r.count > 0).forEach(row => {
        const region = regionForStateLabel(row.label)
        if (!region) return
        const entry = map.get(region) || { label: region, count: 0, value: 0, stateCount: 0 }
        entry.count += row.count; entry.value += row.value; entry.stateCount++
        map.set(region, entry)
      })
    }
    return Array.from(map.values()).sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label))
  }, [stateRows, stateDataByKey, masterRegionNames, masterAllStates, regionForStateLabel])

  const statesForRegion = useMemo(() => rowsForRegion(selectedRegion), [rowsForRegion, selectedRegion])

  const districtsForState = useMemo(() => {
    if (!selectedState) return []
    const byDist = new Map<string, { label: string; count: number; value: number; customers: any[] }>()
    selectedState.customers.forEach((c: any) => {
      const d = String(
        c.district || c.billing_district || c.city_district ||
        c.billing_city || c.city || c.customer_city || ''
      ).trim()
      if (!d) return
      const key = normalizeLocationKey(d)
      const entry = byDist.get(key) || { label: d, count: 0, value: 0, customers: [] }
      entry.count++; entry.value += portfolioValueFn(c); entry.customers.push(c)
      byDist.set(key, entry)
    })
    if (masterStateDistricts && masterStateDistricts.size > 0) {
      const stateKey = selectedState.label.toLowerCase().trim()
      const masterDistricts = masterStateDistricts.get(stateKey) || []
      return masterDistricts.map(d => {
        const data = byDist.get(normalizeLocationKey(d)) || { label: d, count: 0, value: 0, customers: [] }
        return { label: d, count: data.count, value: data.value, customers: data.customers }
      }).sort((a, b) => (b.count - a.count) || (b.value - a.value) || a.label.localeCompare(b.label))
    }
    return []
  }, [selectedState, portfolioValueFn, masterStateDistricts])

  const scopedCustomers = useMemo(() => {
    if (selectedDistrict) return selectedDistrict.customers || []
    if (selectedState) return selectedState.customers || []
    return statesForRegion.flatMap(row => row.customers || [])
  }, [selectedDistrict, selectedState, statesForRegion])
  const resultContext = selectedDistrict?.label || selectedState?.label || selectedRegion || 'All Regions'

  const districtRows = useMemo(() => {
    if (selectedState) return districtsForState
    return []
  }, [selectedState, districtsForState])

  const scopedCustomerIds = useMemo(() => Array.from(new Set(
    (scopedCustomers || [])
      .map((customer: any) => Number(customer.id || customer.customer_id || 0))
      .filter(Boolean)
  )), [scopedCustomers])
  const scopedCustomerIdsKey = scopedCustomerIds.join(',')
  const [segmentPipelineRowsByKind, setSegmentPipelineRowsByKind] = useState<Record<string, any[]>>({})
  const [segmentPipelineLoadedKey, setSegmentPipelineLoadedKey] = useState('')

  useEffect(() => {
    let alive = true
    if (hasTwoPanel || !onLoadUnitRecords || scopedCustomerIds.length === 0) {
      setSegmentPipelineRowsByKind({})
      setSegmentPipelineLoadedKey(scopedCustomerIdsKey)
      return () => { alive = false }
    }
    setSegmentPipelineLoadedKey('')
    Promise.all([
      onLoadUnitRecords('leads', 'All Segments', `${resultContext} - segment`, scopedCustomerIds, { allTime: true, customerScopeOnly: true }),
      onLoadUnitRecords('opportunities', 'All Segments', `${resultContext} - segment`, scopedCustomerIds, { allTime: true, customerScopeOnly: true }),
      onLoadUnitRecords('tenders', 'All Segments', `${resultContext} - segment`, scopedCustomerIds, { allTime: true, customerScopeOnly: true }),
      onLoadUnitRecords('workorders', 'All Segments', `${resultContext} - segment`, scopedCustomerIds, { allTime: true, customerScopeOnly: true }),
    ])
      .then(([leads, opportunities, tenders, workorders]) => {
        if (!alive) return
        setSegmentPipelineRowsByKind({
          leads: Array.isArray(leads) ? leads : [],
          opportunities: Array.isArray(opportunities) ? opportunities : [],
          tenders: Array.isArray(tenders) ? tenders : [],
          workorders: Array.isArray(workorders) ? workorders : [],
        })
        setSegmentPipelineLoadedKey(scopedCustomerIdsKey)
      })
      .catch(() => {
        if (!alive) return
        setSegmentPipelineRowsByKind({})
        setSegmentPipelineLoadedKey(scopedCustomerIdsKey)
      })
    return () => { alive = false }
  }, [hasTwoPanel, scopedCustomerIdsKey, resultContext])

  const openRegionSelector = () => {
    setSelectedRegion(null)
    setSelectedState(null)
    setSelectedDistrict(null)
    setRegionSelectorOpen(true)
    setStateSelectorOpen(false)
    setStateFilterEnabled(false)
    setDistrictFilterEnabled(false)
  }

  const openStateSelector = () => {
    setSelectedState(null)
    setSelectedDistrict(null)
    setRegionSelectorOpen(true)
    setStateSelectorOpen(true)
    setStateFilterEnabled(true)
    setDistrictFilterEnabled(false)
  }

  const openDistrictSelector = () => {
    setSelectedDistrict(null)
    setRegionSelectorOpen(true)
    setStateSelectorOpen(false)
    if (selectedState) setDistrictFilterEnabled(true)
  }

  const showSelectorCard = Boolean(regionSelectorOpen || stateSelectorOpen || districtFilterEnabled)
  const selectorLayoutClass = showSelectorCard
    ? regionSelectorOpen && !stateSelectorOpen && !stateFilterEnabled && !districtFilterEnabled
      ? 'xl:grid-cols-[minmax(180px,260px)_1fr]'
      : 'xl:grid-cols-[34%_1fr]'
    : 'xl:grid-cols-1'

  const canonicalGroupLabel = (value: unknown) => {
    const cleaned = String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
    if (!cleaned) return ''
    const aliases: Record<string, string> = {
      'central government': 'Central Government',
      'central goverment': 'Central Government',
      'central govement': 'Central Government',
      'central govt': 'Central Government',
      'central govt.': 'Central Government',
      'state government': 'State Government',
      'state goverment': 'State Government',
      'state govement': 'State Government',
      'state govt': 'State Government',
      'state govt.': 'State Government',
      bfsi: 'BFSI',
      smb: 'SMB',
    }
    return aliases[cleaned.toLowerCase()] || cleaned
  }
  const canonicalGroupKey = (value: unknown) => canonicalGroupLabel(value).toLowerCase()
  const subSegmentParentByKey = useMemo(() => {
    const map = new Map<string, string>()
    ;(masterSegmentSubSegments || []).forEach(sub => {
      const child = canonicalGroupLabel(sub.name)
      const parent = canonicalGroupLabel(sub.sector_name)
      if (child && parent) map.set(canonicalGroupKey(child), parent)
    })
    return map
  }, [masterSegmentSubSegments])
  const subSegmentsByParentKey = useMemo(() => {
    const map = new Map<string, CustomerSubSegmentMaster[]>()
    ;(masterSegmentSubSegments || []).forEach(sub => {
      const parent = canonicalGroupLabel(sub.sector_name)
      const child = canonicalGroupLabel(sub.name)
      if (!parent || !child) return
      const key = canonicalGroupKey(parent)
      const arr = map.get(key) || []
      arr.push({ ...sub, name: child, sector_name: parent })
      map.set(key, arr)
    })
    return map
  }, [masterSegmentSubSegments])
  const parseCustomerSegmentValue = useCallback((value: unknown) => {
    const label = canonicalGroupLabel(value)
    if (!label) return { parent: '', subSegment: '' }
    const exactParent = subSegmentParentByKey.get(canonicalGroupKey(label))
    if (exactParent) return { parent: exactParent, subSegment: label }
    const parts = label.split('/').map(part => canonicalGroupLabel(part)).filter(Boolean)
    if (parts.length >= 2) {
      const child = parts[parts.length - 1]
      const parentFromChild = subSegmentParentByKey.get(canonicalGroupKey(child))
      if (parentFromChild) return { parent: parentFromChild, subSegment: child }
      const possibleParent = parts[0]
      if (subSegmentsByParentKey.has(canonicalGroupKey(possibleParent))) return { parent: possibleParent, subSegment: child }
    }
    return { parent: label, subSegment: '' }
  }, [subSegmentParentByKey, subSegmentsByParentKey])
  const businessUnitMetricRows = useMemo(
    () => Array.isArray(businessUnitAnalysis?.rows) ? businessUnitAnalysis.rows : [],
    [businessUnitAnalysis]
  )
  const keyOf = (value: unknown) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  const masterSegmentByKey = useMemo(() => {
    const map = new Map<string, string>()
    ;(masterSegments || []).forEach(segment => {
      const label = canonicalGroupLabel(segment)
      if (label) map.set(canonicalGroupKey(label), label)
    })
    return map
  }, [masterSegments])
  const masterSourceByKey = useMemo(() => {
    const map = new Map<string, string>()
    ;(masterSources || []).forEach(source => {
      const label = canonicalGroupLabel(source)
      if (label) map.set(canonicalGroupKey(label), label)
    })
    return map
  }, [masterSources])
  const masterVerticalOrder = useMemo(() => masterVerticalUnits ? Array.from(masterVerticalUnits.keys()) : [], [masterVerticalUnits])

  const businessMetricRowsForScope = useMemo(() => {
    return businessUnitMetricRows.filter((row: any) => {
      const rowState = String(row.state || row.billing_state || '').trim()
      const rowDistrict = String(row.district || row.billing_district || row.city_district || row.city || '').trim()
      if (selectedState && keyOf(rowState) !== keyOf(selectedState.label)) return false
      if (selectedDistrict && keyOf(rowDistrict) !== keyOf(selectedDistrict.label)) return false
      if (!selectedState && selectedRegion && rowState && regionForStateLabel(rowState) !== selectedRegion) return false
      return true
    })
  }, [businessUnitMetricRows, selectedState, selectedDistrict, selectedRegion, regionForStateLabel])

  const segmentRows = useMemo(() => {
    const src: any[] | undefined = scopedCustomers
    const hasMasterRows = (!hasTwoPanel && activeTabId === 'segment' && masterSegmentByKey.size > 0) || (hasTwoPanel && Boolean(masterVerticalUnits && masterVerticalUnits.size > 0))
    if ((!src || src.length === 0) && !(hasTwoPanel && businessUnitMetricRows.length > 0) && !hasMasterRows) return []
    const map = new Map<string, { label: string; count: number; value: number; customers: any[] }>()
    ;(src || []).forEach((c: any) => {
      let lbl: string
      if (hasTwoPanel && masterUnitVertical && masterUnitVertical.size > 0) {
        // Derive vertical only from master unit map — skip customers not assigned to any master unit
        const bu = String(c.business_unit || c.business_unit_name || '').toLowerCase().trim()
        const derived = bu ? masterUnitVertical.get(bu) : undefined
        if (!derived) return
        lbl = derived
      } else {
        lbl = portfolioLabelFn(c, groupKeys)
      }
      lbl = canonicalGroupLabel(lbl)
      if (!hasTwoPanel && activeTabId === 'segment') {
        lbl = parseCustomerSegmentValue(lbl).parent || lbl
        if (masterSegmentByKey.size > 0) {
          const masterLabel = masterSegmentByKey.get(canonicalGroupKey(lbl))
          if (!masterLabel) return
          lbl = masterLabel
        }
      }
      if (!lbl || lbl === 'Unassigned') return
      const key = canonicalGroupKey(lbl)
      const entry = map.get(key) || { label: lbl, count: 0, value: 0, customers: [] }
      if (entry.count === 0) entry.label = lbl
      entry.count++; entry.value += portfolioValueFn(c); entry.customers.push(c)
      map.set(key, entry)
    })
    if (hasTwoPanel && businessUnitMetricRows.length > 0) {
      businessMetricRowsForScope.forEach((row:any) => {
        const label = canonicalGroupLabel(row.vertical)
        if (!label || label === 'Unassigned') return
        const key = canonicalGroupKey(label)
        const entry = map.get(key) || { label, count: 0, value: 0, customers: [] }
        const pipelineCount = Number(row.lead_count || 0) + Number(row.opportunity_count || 0) + Number(row.tender_count || 0) + Number(row.work_order_count || row.wo_count || 0)
        entry.count += pipelineCount
        entry.value += Number(row.total_value || 0) || (
          Number(row.lead_value || 0) +
          Number(row.opportunity_value || 0) +
          Number(row.tender_value || 0) +
          Number(row.work_order_value || row.wo_value || 0)
        )
        map.set(key, entry)
      })
    }
    if (activeTabId === 'segment' && masterSegmentByKey.size > 0) {
      masterSegmentByKey.forEach(label => {
        const key = canonicalGroupKey(label)
        if (label && !map.has(key)) map.set(key, { label, count: 0, value: 0, customers: [] })
      })
    }
    // Fill in all master business verticals (0-count if no customers)
    if (hasTwoPanel && masterVerticalUnits && masterVerticalUnits.size > 0) {
      masterVerticalUnits.forEach((_, vertical) => {
        const key = canonicalGroupKey(vertical)
        if (vertical && !map.has(key)) map.set(key, { label: vertical, count: 0, value: 0, customers: [] })
      })
    }
    const masterSegmentOrder = new Map<string, number>()
    if (!hasTwoPanel && activeTabId === 'segment' && masterSegmentByKey.size > 0) {
      Array.from(masterSegmentByKey.values()).forEach((label, idx) => {
        if (label) masterSegmentOrder.set(canonicalGroupKey(label), idx)
      })
    }
    const rows = Array.from(map.values()).sort((a, b) => {
      if (masterSegmentOrder.size > 0) {
        const ai = masterSegmentOrder.has(canonicalGroupKey(a.label)) ? masterSegmentOrder.get(canonicalGroupKey(a.label))! : 9999
        const bi = masterSegmentOrder.has(canonicalGroupKey(b.label)) ? masterSegmentOrder.get(canonicalGroupKey(b.label))! : 9999
        return (ai - bi) || a.label.localeCompare(b.label)
      }
      return (b.value - a.value) || (b.count - a.count) || a.label.localeCompare(b.label)
    })
    const max = Math.max(1, ...rows.filter(r => r.count > 0).map(r => r.value || r.count))
    return rows.map(r => ({ ...r, pct: r.count > 0 ? Math.max(5, Math.round(((r.value || r.count) / max) * 100)) : 0 }))
  }, [scopedCustomers, groupKeys, portfolioValueFn, portfolioLabelFn, masterSegmentByKey, activeTabId, hasTwoPanel, masterUnitVertical, masterVerticalUnits, businessUnitMetricRows, businessMetricRowsForScope, parseCustomerSegmentValue])

  const businessVerticalRows = useMemo(() => {
    const useMetricRows = businessMetricRowsForScope.length > 0
    const masterVerticalByKey = new Map<string, string>()
    if (masterVerticalUnits && masterVerticalUnits.size > 0) {
      masterVerticalUnits.forEach((_, vertical) => {
        const label = canonicalGroupLabel(vertical)
        if (label) masterVerticalByKey.set(canonicalGroupKey(label), label)
      })
    }
    const hasMasterVerticals = masterVerticalByKey.size > 0
    const map = new Map<string, {
      label: string
      leads: number
      leadValue: number
      opportunities: number
      opportunityValue: number
      tenders: number
      tenderValue: number
      workOrders: number
      workOrderValue: number
      value: number
      customers: any[]
      customerIds: number[]
    }>()
    const ensure = (labelValue: unknown) => {
      const label = canonicalGroupLabel(labelValue)
      if (!label || label === 'Unassigned') return null
      const key = canonicalGroupKey(label)
      if (hasMasterVerticals && !masterVerticalByKey.has(key)) return null
      const displayLabel = hasMasterVerticals ? (masterVerticalByKey.get(key) || label) : label
      const entry = map.get(key) || {
        label: displayLabel,
        leads: 0,
        leadValue: 0,
        opportunities: 0,
        opportunityValue: 0,
        tenders: 0,
        tenderValue: 0,
        workOrders: 0,
        workOrderValue: 0,
        value: 0,
        customers: [],
        customerIds: [],
      }
      map.set(key, entry)
      return entry
    }
    masterVerticalByKey.forEach(label => { ensure(label) })
    scopedCustomers.forEach((c: any) => {
      let label = portfolioLabelFn(c, groupKeys)
      if (masterUnitVertical && masterUnitVertical.size > 0) {
        const unitKey = String(c.business_unit || c.business_unit_name || '').toLowerCase().trim()
        const masterLabel = unitKey ? masterUnitVertical.get(unitKey) : undefined
        if (!masterLabel && hasMasterVerticals) return
        label = masterLabel || label
      }
      const entry = ensure(label)
      if (!entry) return
      entry.customers.push(c)
      const id = Number(c.id || c.customer_id || 0)
      if (id) entry.customerIds.push(id)
      if (!useMetricRows) {
        entry.leads += Number(c.lead_count || 0)
        entry.leadValue += Number(c.lead_value || 0)
        entry.opportunities += Number(c.opportunity_count || c.opp_count || 0)
        entry.opportunityValue += Number(c.opportunity_value || c.opp_value || 0)
        entry.tenders += Number(c.tender_count || 0)
        entry.tenderValue += Number(c.tender_value || 0)
        entry.workOrders += Number(c.work_order_count || c.wo_count || c.won_count || 0)
        entry.workOrderValue += Number(c.work_order_value || c.wo_value || c.won_value || c.won_tender_value || 0)
        entry.value += portfolioValueFn(c)
      }
    })
    businessMetricRowsForScope.forEach((row: any) => {
      const entry = ensure(row.vertical || row.business_vertical || row.business_unit_category)
      if (!entry) return
      entry.leads += Number(row.lead_count || 0)
      entry.leadValue += Number(row.lead_value || 0)
      entry.opportunities += Number(row.opportunity_count || 0)
      entry.opportunityValue += Number(row.opportunity_value || 0)
      entry.tenders += Number(row.tender_count || 0)
      entry.tenderValue += Number(row.tender_value || 0)
      entry.workOrders += Number(row.work_order_count || row.wo_count || 0)
        entry.workOrderValue += Number(row.work_order_value || row.wo_value || 0)
        entry.value += Number(row.total_value || 0) || (
        Number(row.lead_value || 0) +
        Number(row.opportunity_value || 0) +
        Number(row.tender_value || 0) +
        Number(row.work_order_value || row.wo_value || 0)
      )
      if (Array.isArray(row.customer_ids)) {
        entry.customerIds.push(...row.customer_ids.map((id: any) => Number(id)).filter(Boolean))
      }
    })
    return Array.from(map.values())
      .map(row => ({ ...row, customerIds: Array.from(new Set(row.customerIds)) }))
      .sort((a, b) => {
        if (hasMasterVerticals) {
          return (masterVerticalOrder.indexOf(a.label) - masterVerticalOrder.indexOf(b.label)) || a.label.localeCompare(b.label)
        }
        return (b.value - a.value) || ((b.leads + b.opportunities + b.tenders + b.workOrders) - (a.leads + a.opportunities + a.tenders + a.workOrders)) || a.label.localeCompare(b.label)
      })
  }, [businessMetricRowsForScope, scopedCustomers, groupKeys, portfolioLabelFn, portfolioValueFn, masterUnitVertical, masterVerticalUnits, masterVerticalOrder])

  const unitRows = useMemo(() => {
    if (!selectedSegment || secondaryGroupKeys.length === 0) return []
    const map = new Map<string, { label: string; count: number; value: number; customers: any[]; lead_count?: number; opportunity_count?: number; tender_count?: number; work_order_count?: number; customer_ids?: number[]; unit_id?: number }>()
    const masterUnits = selectedSegment?.label && masterVerticalUnits
      ? (masterVerticalUnits.get(selectedSegment.label) || Array.from(masterVerticalUnits.entries()).find(([vertical]) => canonicalGroupKey(vertical) === canonicalGroupKey(selectedSegment.label))?.[1] || [])
      : []
    const masterUnitByKey = new Map(masterUnits.map(unit => [canonicalGroupKey(unit), unit]))
    const verticalMetricRows = hasTwoPanel && selectedSegment
      ? businessUnitMetricRows.filter((row:any) => canonicalGroupKey(row.vertical) === canonicalGroupKey(selectedSegment.label))
      : []
    const stateMetricRows = selectedState
      ? verticalMetricRows.filter((row:any) => keyOf(row.state) === keyOf(selectedState.label))
      : []
    const districtMetricRows = selectedDistrict
      ? stateMetricRows.filter((row:any) => keyOf(row.district || row.billing_district || row.city_district || row.city) === keyOf(selectedDistrict.label))
      : []
    const metricRows = selectedDistrict
      ? districtMetricRows
      : stateMetricRows.length > 0
        ? stateMetricRows
        : verticalMetricRows
    const metricByUnit = new Map<string, any>()
    metricRows.forEach((row:any) => {
      if(row?.unit) metricByUnit.set(keyOf(row.unit), row)
    })
    selectedSegment.customers.forEach((c: any) => {
      let lbl = portfolioLabelFn(c, secondaryGroupKeys)
      if (!lbl || lbl === 'Unassigned') return
      if (masterUnitByKey.size > 0) {
        const masterUnit = masterUnitByKey.get(canonicalGroupKey(lbl))
        if (!masterUnit) return
        lbl = masterUnit
      }
      const entry = map.get(lbl) || { label: lbl, count: 0, value: 0, customers: [] }
      entry.count++; entry.value += portfolioValueFn(c); entry.customers.push(c)
      map.set(lbl, entry)
    })
    metricByUnit.forEach((metric:any, key:string) => {
      let label = String(metric.unit || '').trim()
      if(!label) return
      if (masterUnitByKey.size > 0) {
        const masterUnit = masterUnitByKey.get(canonicalGroupKey(label))
        if (!masterUnit) return
        label = masterUnit
      }
      const entry = map.get(label) || { label, count: 0, value: 0, customers: [] }
      entry.lead_count = Number(metric.lead_count || 0)
      entry.opportunity_count = Number(metric.opportunity_count || 0)
      entry.tender_count = Number(metric.tender_count || 0)
      entry.work_order_count = Number(metric.work_order_count || 0)
      entry.customer_ids = Array.isArray(metric.customer_ids) ? metric.customer_ids.map((id:any)=>Number(id)).filter(Boolean) : []
      entry.unit_id = Number(metric.unit_id || 0) || undefined
      map.set(label || key, entry)
    })
    // Fill in master units for this vertical with 0 count
    masterUnits.forEach(u => { if (u && !map.has(u)) map.set(u, { label: u, count: 0, value: 0, customers: [] }) })
    return Array.from(map.values()).sort((a, b) => {
      if (masterUnits.length > 0) {
        const ai = masterUnits.findIndex(unit => canonicalGroupKey(unit) === canonicalGroupKey(a.label))
        const bi = masterUnits.findIndex(unit => canonicalGroupKey(unit) === canonicalGroupKey(b.label))
        return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi)
      }
      const ap = Number(a.lead_count || 0) + Number(a.opportunity_count || 0) + Number(a.tender_count || 0) + Number(a.work_order_count || 0)
      const bp = Number(b.lead_count || 0) + Number(b.opportunity_count || 0) + Number(b.tender_count || 0) + Number(b.work_order_count || 0)
      return (bp - ap) || (b.count - a.count) || (b.value - a.value) || a.label.localeCompare(b.label)
    })
  }, [selectedSegment, selectedState, selectedDistrict, secondaryGroupKeys, portfolioValueFn, portfolioLabelFn, masterVerticalUnits, businessUnitMetricRows, hasTwoPanel])

  const masterSubSegmentsForSegment = (segmentLabel: string) => {
    const direct = subSegmentsByParentKey.get(canonicalGroupKey(segmentLabel))
    if (direct) return direct
    const match = Array.from(subSegmentsByParentKey.entries()).find(([key]) => key === canonicalGroupKey(segmentLabel))
    return match?.[1] || []
  }

  const buildSubSegmentBreakdownRows = (segmentLabel: string, segmentCustomers: any[]) => {
    const map = new Map<string, {
      label: string
      count: number
      value: number
      customers: any[]
      subSegmentId?: number
      isUnmapped?: boolean
    }>()
    const parentKey = canonicalGroupKey(segmentLabel)
    const masterSubSegments = masterSubSegmentsForSegment(segmentLabel)
    const ensure = (labelValue: unknown, meta?: { id?: number; isUnmapped?: boolean }) => {
      const label = canonicalGroupLabel(labelValue)
      if (!label || label === 'Unassigned') return null
      const key = meta?.isUnmapped ? '__unmapped__' : canonicalGroupKey(label)
      const entry = map.get(key) || { label, count: 0, value: 0, customers: [], subSegmentId: meta?.id, isUnmapped: meta?.isUnmapped }
      entry.subSegmentId = meta?.id || entry.subSegmentId
      entry.isUnmapped = Boolean(meta?.isUnmapped || entry.isUnmapped)
      map.set(key, entry)
      return entry
    }

    masterSubSegments.forEach(sub => ensure(sub.name, { id: sub.id }))

    ;(segmentCustomers || []).forEach((customer: any) => {
      const rawLabel = portfolioLabelFn(customer, groupKeys)
      const explicitSubSegment = [
        customer.sub_segment,
        customer.customer_sub_segment,
        customer.subsegment,
        customer.customer_segment_child,
        customer.customer_vertical_sub_segment,
        customer.vertical_sub_sector,
        customer.vertical_sub_sector_name,
        customer.division,
      ].map(canonicalGroupLabel).filter(Boolean)
        .map(candidate => parseCustomerSegmentValue(candidate))
        .find(parsedCandidate => canonicalGroupKey(parsedCandidate.parent) === parentKey && parsedCandidate.subSegment)
      const parsed = explicitSubSegment || parseCustomerSegmentValue(rawLabel)
      if (canonicalGroupKey(parsed.parent) !== parentKey) return
      if (!parsed.subSegment) return
      const entry = ensure(parsed.subSegment)
      if (!entry) return
      entry.count += 1
      entry.value += portfolioValueFn(customer)
      entry.customers.push(customer)
    })

    return Array.from(map.values()).sort((a, b) => {
      const ai = a.isUnmapped ? 9999 : masterSubSegments.findIndex(sub => canonicalGroupKey(sub.name) === canonicalGroupKey(a.label))
      const bi = b.isUnmapped ? 9999 : masterSubSegments.findIndex(sub => canonicalGroupKey(sub.name) === canonicalGroupKey(b.label))
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 9998 : ai) - (bi === -1 ? 9998 : bi)
      return (b.count - a.count) || (b.value - a.value) || a.label.localeCompare(b.label)
    })
  }

  const openSubSegmentBreakdown = (row: any) => {
    if (subSegmentBreakdown?.segmentLabel === row.label) {
      setSubSegmentBreakdown(null)
      return
    }
    const allRows = buildSubSegmentBreakdownRows(row.label, row.customers || [])
    const realRows = allRows.filter((r: any) => !r.isUnmapped)
    if (realRows.length === 0) {
      onViewCustomers(`${resultContext} - ${row.label}`, row.customers || [])
      return
    }
    setSubSegmentBreakdown({ segmentLabel: row.label, rows: realRows })
  }

  const masterUnitsForVertical = (verticalLabel: string) => {
    if (!masterVerticalUnits) return []
    const direct = masterVerticalUnits.get(verticalLabel)
    if (direct) return direct
    const match = Array.from(masterVerticalUnits.entries()).find(([vertical]) => canonicalGroupKey(vertical) === canonicalGroupKey(verticalLabel))
    return match?.[1] || []
  }

  const buildUnitBreakdownRows = (verticalLabel: string, verticalCustomers: any[]) => {
    const masterUnits = masterUnitsForVertical(verticalLabel)
    const masterUnitByKey = new Map(masterUnits.map(unit => [canonicalGroupKey(unit), unit]))
    const map = new Map<string, {
      label: string
      leads: number
      leadValue: number
      opportunities: number
      opportunityValue: number
      tenders: number
      tenderValue: number
      workOrders: number
      workOrderValue: number
      value: number
      customers: any[]
      customerIds: number[]
      unitId?: number
    }>()
    const ensure = (unitLabel: unknown) => {
      const label = canonicalGroupLabel(unitLabel)
      if (!label || label === 'Unassigned') return null
      const key = canonicalGroupKey(label)
      if (masterUnitByKey.size > 0 && !masterUnitByKey.has(key)) return null
      const displayLabel = masterUnitByKey.get(key) || label
      const entry = map.get(key) || { label: displayLabel, leads: 0, leadValue: 0, opportunities: 0, opportunityValue: 0, tenders: 0, tenderValue: 0, workOrders: 0, workOrderValue: 0, value: 0, customers: [], customerIds: [] }
      map.set(key, entry)
      return entry
    }

    masterUnits.forEach(unit => ensure(unit))

    ;(verticalCustomers || []).forEach((customer: any) => {
      const unitLabel = portfolioLabelFn(customer, secondaryGroupKeys)
      const entry = ensure(unitLabel)
      if (!entry) return
      entry.customers.push(customer)
      const customerId = Number(customer.id || customer.customer_id || 0)
      if (customerId) entry.customerIds.push(customerId)
      entry.leads += Number(customer.lead_count || 0)
      entry.leadValue += Number(customer.lead_value || 0)
      entry.opportunities += Number(customer.opportunity_count || customer.opp_count || 0)
      entry.opportunityValue += Number(customer.opportunity_value || customer.opp_value || 0)
      entry.tenders += Number(customer.tender_count || 0)
      entry.tenderValue += Number(customer.tender_value || 0)
      entry.workOrders += Number(customer.work_order_count || customer.wo_count || customer.won_count || 0)
      entry.workOrderValue += Number(customer.work_order_value || customer.wo_value || customer.won_value || customer.won_tender_value || 0)
      entry.value += portfolioValueFn(customer)
    })

    const metricRows = businessUnitMetricRows.filter((row: any) => {
      const rowVertical = row.vertical || row.business_vertical || row.business_unit_category
      if (canonicalGroupKey(rowVertical) !== canonicalGroupKey(verticalLabel)) return false
      const rowState = String(row.state || row.billing_state || '').trim()
      const rowDistrict = String(row.district || row.billing_district || row.city_district || row.city || '').trim()
      if (selectedState && keyOf(rowState) !== keyOf(selectedState.label)) return false
      if (selectedDistrict && keyOf(rowDistrict) !== keyOf(selectedDistrict.label)) return false
      if (!selectedState && selectedRegion && rowState && regionForStateLabel(rowState) !== selectedRegion) return false
      return true
    })
    const useMetricRows = metricRows.length > 0
    const metricReplacedUnits = new Set<string>()
    metricRows.forEach((row: any) => {
      const entry = ensure(row.unit || row.business_unit || row.business_unit_name)
      if (!entry) return
      const unitKey = canonicalGroupKey(entry.label)
      if (useMetricRows && !metricReplacedUnits.has(unitKey)) {
        entry.leads = 0
        entry.leadValue = 0
        entry.opportunities = 0
        entry.opportunityValue = 0
        entry.tenders = 0
        entry.tenderValue = 0
        entry.workOrders = 0
        entry.workOrderValue = 0
        entry.value = 0
        metricReplacedUnits.add(unitKey)
      }
      entry.leads += Number(row.lead_count || 0)
      entry.leadValue += Number(row.lead_value || 0)
      entry.opportunities += Number(row.opportunity_count || 0)
      entry.opportunityValue += Number(row.opportunity_value || 0)
      entry.tenders += Number(row.tender_count || 0)
      entry.tenderValue += Number(row.tender_value || 0)
      entry.workOrders += Number(row.work_order_count || row.wo_count || 0)
      entry.workOrderValue += Number(row.work_order_value || row.wo_value || 0)
      entry.value += Number(row.total_value || 0) || (
        Number(row.lead_value || 0) +
        Number(row.opportunity_value || 0) +
        Number(row.tender_value || 0) +
        Number(row.work_order_value || row.wo_value || 0)
      )
      entry.unitId = Number(row.unit_id || 0) || entry.unitId
      if (Array.isArray(row.customer_ids)) entry.customerIds.push(...row.customer_ids.map((id: any) => Number(id)).filter(Boolean))
    })

    return Array.from(map.values())
      .map(row => ({ ...row, customerIds: Array.from(new Set(row.customerIds)) }))
      .sort((a, b) => {
        const ap = Number(a.leads || 0) + Number(a.opportunities || 0) + Number(a.tenders || 0) + Number(a.workOrders || 0)
        const bp = Number(b.leads || 0) + Number(b.opportunities || 0) + Number(b.tenders || 0) + Number(b.workOrders || 0)
        if (masterUnits.length > 0) {
          const ai = masterUnits.findIndex(unit => canonicalGroupKey(unit) === canonicalGroupKey(a.label))
          const bi = masterUnits.findIndex(unit => canonicalGroupKey(unit) === canonicalGroupKey(b.label))
          return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi)
        }
        return (bp - ap) || (b.value - a.value) || a.label.localeCompare(b.label)
      })
  }

  const openUnitBreakdown = (row: any) => {
    if (unitBreakdown?.verticalLabel === row.label) {
      setUnitBreakdown(null)
      setUnitPopupOpen(false)
      setSelectedUnit(null)
      setUnitDrill(null)
      setUnitPopupMaximized(false)
      return
    }
    setUnitPopupOpen(false)
    setSelectedUnit(null)
    setUnitDrill(null)
    setUnitPopupMaximized(false)
    setUnitBreakdown({
      verticalLabel: row.label,
      vertical: row,
      rows: buildUnitBreakdownRows(row.label, row.customers || []),
    })
  }

  const openVerticalPopup = (row: any, initialTab: UnitRecordKind = 'leads') => {
    const rows = buildUnitBreakdownRows(row.label, row.customers || [])
    const nextDrill = createVerticalDrillState(row, rows, initialTab)
    setUnitPopupOpen(true)
    setSelectedUnit(null)
    setUnitPopupMaximized(false)
    setVerticalPopupTab(initialTab)
    setUnitBreakdown({
      verticalLabel: row.label,
      vertical: row,
      rows,
    })
    setUnitDrill(nextDrill)
    loadUnitDrillTab(nextDrill, initialTab, true)
  }

  const unitRecordValue = (row: any) => {
    if (row._kind === 'customers') return portfolioValueFn(row)
    if (row._kind === 'workorders') return workOrderValue(row)
    return Number(row.est_value ?? row.lead_value ?? row.bid_amount ?? row.opportunity_value ?? row.total_value ?? row.wo_value ?? 0)
  }
  const unitRecordCustomerName = (row: any) => row.customer_name || row.name || row.account_name || row.client_name || ''
  const unitAssigneeNameById = new Map<string,string>()
  ;[...(teamMembers || []), ...(teamRows || [])].forEach((member: any) => {
    const id = String(member?.user_id ?? member?.id ?? '').trim()
    const name = String(member?.user_name || member?.full_name || member?.name || member?.employee_name || '').trim()
    if (id && name) unitAssigneeNameById.set(id, name)
  })
  const unitRecordAssignee = (row: any) => {
    const numeric = (value: string) => /^\d+$/.test(value)
    const nameCandidates = [row.assigned_to_name, row.owner_name, row.user_name]
    for (const candidate of nameCandidates) {
      const label = String(candidate || '').trim()
      if (!label) continue
      if (numeric(label)) {
        const resolved = unitAssigneeNameById.get(label)
        if (resolved) return resolved
        continue
      }
      return label
    }
    const idCandidates = [row.assigned_to, row.assigned_to_id, row.assigned_user_id, row.owner_id, row.user_id, row.created_by]
    for (const candidate of idCandidates) {
      const id = String(candidate ?? '').trim()
      const resolved = id ? unitAssigneeNameById.get(id) : ''
      if (resolved) return resolved
    }
    return ''
  }
  const unitRecordContactName = (row: any) => row.contact_person || row.contact_name || row.customer_contact_name || row.primary_contact_name || ''
  const unitRecordContactPhone = (row: any) => row.mobile || row.contact_mobile || row.contact_phone || row.phone || row.primary_phone || row.contact_email || row.email || ''
  const unitRecordLocation = (row: any) => [row.billing_city || row.city || row.district, row.billing_state || row.state].filter(Boolean).join(', ')
  const unitRecordSegment = (row: any) => portfolioLabelFn(row, groupKeys) || row.customer_vertical || row.vertical || row.segment || row.industry || ''
  const unitRecordSubSegment = (row: any) => row.sub_segment || row.customer_sub_segment || row.division || row.department || ''
  const unitRecordLastActivityDate = (row: any) => row.last_activity_date || row.last_activity_at || row.updated_at || row.created_at || ''
  const unitRecordLastActivityType = (row: any) => row.last_activity_type || row.last_activity || ''
  const unitRecordPriority = (row: any) => row.priority || row.lead_priority || row.account_potential || row.potential || row.potential_rating || 'Medium'
  const unitRecordProgress = (row: any) => {
    const current = Number(row.current_step || row.progress_step || row.step || 0)
    const total = Number(row.total_steps || row.workflow_steps || row.steps || 0)
    if (current && total) return `Step ${current}/${total}`
    return row.progress || row.stage_progress || '--'
  }
  const unitRecordSourceType = (row: any) => {
    if (row._kind === 'opportunities') return opportunityOrigin(row) === 'direct' ? 'Direct' : 'From Lead'
    if (row._kind === 'tenders') {
      const raw = String(row.tender_origin || row.origin || row.source_type || row.created_from || '').toLowerCase()
      if (raw.includes('from_opportunity') || raw.includes('opportunity')) return 'From Opportunities'
      if (raw.includes('direct') || (!row.lead_id && !row.opportunity_id)) return 'Direct'
      return 'From Lead'
    }
    return ''
  }
  const unitRecordSourceTypeLabel = (value: string) => {
    if (value === 'From Lead') return `From ${leadSingular}`
    if (value === 'From Opportunities') return `From ${opportunityLabel}`
    return value
  }
  const unitRecordTitle = (row: any) => row._kind === 'customers'
    ? unitRecordCustomerName(row) || customerSingular
    : row._kind === 'workorders'
    ? row.project_title || row.tender_title || row.wrk_order_id || row.po_num || workOrderSingular
    : row._kind === 'tenders'
      ? row.tender_title || row.portal_ref_number || row.tender_num || tenderSingular
      : row._kind === 'opportunities'
        ? row.lead_title || row.lead_name || row.opportunity_name || row.customer_name || opportunitySingular
        : row.lead_title || row.lead_name || row.customer_name || leadSingular
  const unitRecordSubtitle = (row: any) => row._kind === 'workorders'
    ? row.wrk_order_id || row.po_num || row.portal_ref_number || ''
    : row._kind === 'tenders'
      ? row.portal_ref_number || row.tender_num || ''
    : row._kind === 'customers'
      ? row.group_name || row.department || unitRecordSubSegment(row) || ''
      : unitRecordCustomerName(row) || ''
  const unitRecordStatus = (row: any) => row._kind === 'workorders'
    ? row.wo_status || 'Draft'
    : row._kind === 'tenders'
      ? row.tender_status || row.result || ''
      : row._kind === 'customers'
        ? row.status || row.account_status || 'Active'
        : row.status || ''
  const unitRecordSource = (row: any) => row._kind === 'workorders'
    ? row.source_name || row.source || workOrderSourceLabel(workOrderSourceCategory(row))
    : row._kind === 'tenders'
      ? row.source_name || row.source || row.portal_name || row.tender_portal || ''
    : row.lead_source || row.source_name || row.source || row.order_source || ''
  const unitRecordStage = (row: any) => row._kind === 'tenders'
    ? row.result || row.tender_status || ''
    : row._kind === 'workorders'
      ? row.delivery_date || row.dlvry_date || row.completion_date || ''
      : row.stage || row.lead_stage || ''
  const unitRecordDate = (row: any) => {
    if (row._kind === 'customers') return unitRecordLastActivityDate(row)
    if (row._kind === 'workorders') return row.po_date || popupRecordDateKey(row)
    if (row._kind === 'tenders') return row.submission_date || popupRecordDateKey(row)
    if (row._kind === 'opportunities') return row.expected_close_date || popupRecordDateKey(row)
    return popupRecordDateKey(row)
  }
  const unitRecordHeaders = (kind: UnitRecordKind) => {
    if (kind === 'customers') return { record: customerSingular, source: 'Segment', status: 'Status', stage: 'Assigned To', date: 'Last Activity' }
    if (kind === 'opportunities') return { record: opportunitySingular, source: 'Source', status: 'Status', stage: 'Stage', date: 'Close Date' }
    if (kind === 'tenders') return { record: tenderSingular, source: 'Portal', status: 'Stage', stage: 'Result', date: 'Submit Date' }
    if (kind === 'workorders') return { record: workOrderSingular, source: 'Source', status: 'Status', stage: 'Delivery', date: 'PO Date' }
    return { record: leadSingular, source: 'Source', status: 'Status', stage: 'Stage', date: 'Date' }
  }
  const unitRecordKindLabel = (kind: string) => ({
    customers: customerSingular,
    leads: leadSingular,
    opportunities: opportunitySingular,
    tenders: tenderSingular,
    workorders: workOrderSingular,
  } as Record<string, string>)[kind] || 'Record'
  const unitRecordStatusTone = (status: string, kind?: string) => {
    if (kind === 'workorders') return workOrderStatusBadge(status || 'Draft')
    const s = String(status || '').toLowerCase()
    if (['won', 'converted', 'completed', 'active'].includes(s)) return 'bg-emerald-50 text-emerald-700'
    if (['lost', 'cancelled', 'canceled'].includes(s)) return 'bg-red-50 text-red-700'
    if (['submitted', 'qualified', 'opportunity created', 'in progress'].includes(s)) return 'bg-blue-50 text-blue-700'
    return 'bg-slate-100 text-slate-700'
  }
  const unitDrillTabs: Array<{ key: UnitRecordKind; label: string; count: (unit: any) => number; icon: React.ElementType; tone: string; activeTone: string }> = [
    { key: 'customers', label: customerLabel, count: unit => Number(unit.customers?.length || unit.count || unit.customer_count || 0), icon: Users, tone: 'text-slate-600', activeTone: 'bg-slate-800 border-slate-800 text-white shadow-slate-100' },
    { key: 'leads', label: leadLabel, count: unit => Number(unit.leads || 0), icon: UserCircle, tone: 'text-violet-600', activeTone: 'bg-violet-600 border-violet-600 text-white shadow-violet-100' },
    { key: 'opportunities', label: opportunityLabel, count: unit => Number(unit.opportunities || 0), icon: Star, tone: 'text-blue-600', activeTone: 'bg-blue-600 border-blue-600 text-white shadow-blue-100' },
    { key: 'tenders', label: tenderLabel, count: unit => Number(unit.tenders || 0), icon: FileText, tone: 'text-orange-600', activeTone: 'bg-orange-500 border-orange-500 text-white shadow-orange-100' },
    { key: 'workorders', label: workOrderLabel, count: unit => Number(unit.workOrders || 0), icon: Package, tone: 'text-emerald-600', activeTone: 'bg-emerald-600 border-emerald-600 text-white shadow-emerald-100' },
  ]
  const visibleUnitDrillTabs = unitDrill?.scope === 'unit'
    ? unitDrillTabs.filter(tab => tab.key !== 'customers')
    : unitDrillTabs
  const unitMetricCount = (unit: any, kind: UnitRecordKind) => {
    if (kind === 'customers') return Number(unit?.customers?.length || unit?.count || unit?.customer_count || 0)
    if (kind === 'leads') return Number(unit?.leads || 0)
    if (kind === 'opportunities') return Number(unit?.opportunities || 0)
    if (kind === 'tenders') return Number(unit?.tenders || 0)
    return Number(unit?.workOrders || 0)
  }
  const displayedUnitDrillCount = (unit: any, kind: UnitRecordKind, fallbackCount?: number) => {
    const loadedRows = unitDrill?.rowsByKind?.[kind]
    if (Array.isArray(loadedRows)) return loadedRows.length
    if (typeof fallbackCount === 'number') return fallbackCount
    return unitMetricCount(unit, kind)
  }
  const unitDrillRows = unitDrill ? (unitDrill.rowsByKind[unitDrill.activeTab] || []) : []
  const unitDrillQuery = String(unitDrill?.search || '').trim().toLowerCase()
  const unitDrillStatusFilter = String(unitDrill?.statusFilter || '')
  const unitDrillCustomerFilter = String(unitDrill?.customerFilter || '')
  const unitDrillAssigneeFilter = String(unitDrill?.assigneeFilter || '')
  const unitDrillSourceFilter = String(unitDrill?.sourceFilter || '')
  const unitDrillFromDate = String(unitDrill?.fromDate || '')
  const unitDrillToDate = String(unitDrill?.toDate || '')
  const filteredUnitDrillRows = unitDrillRows.filter((record: any) => {
    const matchesSearch = !unitDrillQuery || [
        unitRecordTitle(record),
        unitRecordSubtitle(record),
        unitRecordCustomerName(record),
        unitRecordSegment(record),
        unitRecordSubSegment(record),
        unitRecordLocation(record),
        unitRecordContactName(record),
        unitRecordContactPhone(record),
        unitRecordAssignee(record),
        unitRecordSource(record),
        unitRecordStatus(record),
        unitRecordStage(record),
      ].some((field: any) => String(field || '').toLowerCase().includes(unitDrillQuery))
    const matchesStatus = !unitDrillStatusFilter || unitRecordStatus(record) === unitDrillStatusFilter
    const matchesCustomer = !unitDrillCustomerFilter || unitRecordCustomerName(record) === unitDrillCustomerFilter
    const matchesAssignee = !unitDrillAssigneeFilter || unitRecordAssignee(record) === unitDrillAssigneeFilter
    const matchesSource = !unitDrillSourceFilter || unitRecordSourceType(record) === unitDrillSourceFilter
    const dateValue = unitRecordDate(record)
    const dateText = dateValue ? String(dateValue).slice(0, 10) : ''
    const matchesFrom = !unitDrillFromDate || (!!dateText && dateText >= unitDrillFromDate)
    const matchesTo = !unitDrillToDate || (!!dateText && dateText <= unitDrillToDate)
    return matchesSearch && matchesStatus && matchesCustomer && matchesAssignee && matchesSource && matchesFrom && matchesTo
  })
  const unitDrillStatusOptions = Array.from(new Set(unitDrillRows.map((record: any) => unitRecordStatus(record)).filter(Boolean))).sort()
  const unitDrillCustomerOptions = Array.from(new Set(unitDrillRows.map((record: any) => unitRecordCustomerName(record)).filter(Boolean))).sort()
  const unitDrillAssigneeOptions = Array.from(new Set(unitDrillRows.map((record: any) => unitRecordAssignee(record)).filter(Boolean))).sort()
  const unitDrillPageSizeOptions = [10, 25, 50, 100, 'All'] as const
  const unitDrillTotalRows = filteredUnitDrillRows.length
  const unitDrillEffectivePageSize = unitDrillPageSize === 'All' ? Math.max(unitDrillTotalRows, 1) : unitDrillPageSize
  const unitDrillTotalPages = unitDrillPageSize === 'All' ? 1 : Math.max(1, Math.ceil(unitDrillTotalRows / unitDrillEffectivePageSize))
  const safeUnitDrillPage = Math.min(unitDrillPage, unitDrillTotalPages)
  const unitDrillStartIndex = unitDrillTotalRows > 0 ? (safeUnitDrillPage - 1) * unitDrillEffectivePageSize : 0
  const unitDrillEndIndex = unitDrillPageSize === 'All'
    ? unitDrillTotalRows
    : Math.min(unitDrillStartIndex + unitDrillEffectivePageSize, unitDrillTotalRows)
  const pagedUnitDrillRows = unitDrillPageSize === 'All'
    ? filteredUnitDrillRows
    : filteredUnitDrillRows.slice(unitDrillStartIndex, unitDrillEndIndex)

  useEffect(() => {
    setUnitDrillPage(1)
  }, [
    unitDrill?.key,
    unitDrill?.activeTab,
    unitDrill?.search,
    unitDrill?.statusFilter,
    unitDrill?.customerFilter,
    unitDrill?.assigneeFilter,
    unitDrill?.sourceFilter,
    unitDrill?.fromDate,
    unitDrill?.toDate,
    unitDrillPageSize,
  ])

  const loadUnitDrillTab = async (drill: UnitDrillState, kind: UnitRecordKind, force = false) => {
    if (!force && drill.rowsByKind[kind]) {
      setUnitDrill(prev => prev && prev.key === drill.key ? { ...prev, activeTab: kind, statusFilter: '', customerFilter: '', assigneeFilter: '', fromDate: '', toDate: '', sourceFilter: '', loading: false, error: undefined } : prev)
      return
    }
    setUnitDrill(prev => prev && prev.key === drill.key ? { ...prev, activeTab: kind, statusFilter: '', customerFilter: '', assigneeFilter: '', fromDate: '', toDate: '', sourceFilter: '', loading: true, error: undefined } : prev)
    try {
      if (kind === 'customers') {
        setUnitDrill(prev => prev && prev.key === drill.key
          ? {
              ...prev,
              activeTab: kind,
              statusFilter: '',
              customerFilter: '',
              assigneeFilter: '',
              fromDate: '',
              toDate: '',
              sourceFilter: '',
              loading: false,
              rowsByKind: { ...prev.rowsByKind, customers: (drill.unit.customers || []).map((row: any) => ({ ...row, _kind: 'customers' })) },
              error: undefined,
            }
          : prev
        )
        return
      }
      if (unitMetricCount(drill.unit, kind) <= 0) {
        setUnitDrill(prev => prev && prev.key === drill.key
          ? {
              ...prev,
              activeTab: kind,
              statusFilter: '',
              customerFilter: '',
              assigneeFilter: '',
              fromDate: '',
              toDate: '',
              sourceFilter: '',
              loading: false,
              rowsByKind: { ...prev.rowsByKind, [kind]: [] },
              error: undefined,
            }
          : prev
        )
        return
      }
      const unitIdParam =
        drill.unit.unitId ||
        drill.unit.unit_id ||
        (Array.isArray(drill.unitIds) && drill.unitIds.length ? drill.unitIds.join(',') : undefined)
      if (!unitIdParam && drill.customerIds.length === 0) {
        setUnitDrill(prev => prev && prev.key === drill.key
          ? {
              ...prev,
              activeTab: kind,
              statusFilter: '',
              customerFilter: '',
              assigneeFilter: '',
              fromDate: '',
              toDate: '',
              sourceFilter: '',
              loading: false,
              rowsByKind: { ...prev.rowsByKind, [kind]: [] },
              error: undefined,
            }
          : prev
        )
        return
      }
      const customerScopedDrill = drill.customerIds.length > 0
      const rows = onLoadUnitRecords
        ? await onLoadUnitRecords(kind, drill.label, drill.verticalLabel, drill.customerIds, {
            unitId: unitIdParam,
            allTime: Boolean(drill.allTime),
            customerScopeOnly: drill.customerScopeOnly ?? customerScopedDrill,
          })
        : []
      setUnitDrill(prev => prev && prev.key === drill.key
        ? {
            ...prev,
            activeTab: kind,
            statusFilter: '',
            customerFilter: '',
            assigneeFilter: '',
            fromDate: '',
            toDate: '',
            sourceFilter: '',
            loading: false,
            rowsByKind: { ...prev.rowsByKind, [kind]: rows.map((row: any) => ({ ...row, _kind: kind })) },
            error: undefined,
          }
        : prev
      )
    } catch {
      setUnitDrill(prev => prev && prev.key === drill.key
        ? { ...prev, activeTab: kind, loading: false, error: `Failed to load ${unitRecordKindLabel(kind).toLowerCase()} records` }
        : prev
      )
    }
  }

  const createUnitDrillState = (unit: any, verticalLabel: string, initialTab: UnitRecordKind = 'leads'): UnitDrillState => {
    const customerIds = Array.from(new Set([
      ...(Array.isArray(unit.customerIds) ? unit.customerIds : []),
      ...(Array.isArray(unit.customer_ids) ? unit.customer_ids : []),
      ...(unit.customers || []).map((c: any) => Number(c.id || c.customer_id || 0)),
    ].map((id: any) => Number(id)).filter(Boolean)))
    return {
      key: canonicalGroupKey(unit.label),
      label: unit.label,
      verticalLabel,
      scope: 'unit',
      unit,
      customerIds,
      allTime: false,
      customerScopeOnly: customerIds.length > 0,
      activeTab: initialTab,
      loading: true,
      rowsByKind: {},
      search: '',
      statusFilter: '',
      customerFilter: '',
      assigneeFilter: '',
      fromDate: '',
      toDate: '',
      sourceFilter: '',
    }
  }

  const createVerticalDrillState = (vertical: any, rows: any[], initialTab: UnitRecordKind = 'customers'): UnitDrillState => {
    const verticalLabel = vertical.label || ''
    const customerIds = Array.from(new Set([
      ...(Array.isArray(vertical.customerIds) ? vertical.customerIds : []),
      ...(Array.isArray(vertical.customer_ids) ? vertical.customer_ids : []),
      ...(vertical.customers || []).map((c: any) => Number(c.id || c.customer_id || 0)),
      ...(rows || []).flatMap((unit: any) => Array.isArray(unit.customerIds) ? unit.customerIds : []),
    ].map((id: any) => Number(id)).filter(Boolean)))
    const unitIds = Array.from(new Set((rows || [])
      .map((unit: any) => Number(unit.unitId || unit.unit_id || 0))
      .filter(Boolean)))
    return {
      key: `vertical:${canonicalGroupKey(verticalLabel)}`,
      label: verticalLabel,
      verticalLabel,
      scope: 'vertical',
      unit: { ...vertical, label: verticalLabel, unitIds },
      customerIds,
      unitIds,
      allTime: false,
      customerScopeOnly: customerIds.length > 0,
      activeTab: initialTab,
      loading: true,
      rowsByKind: {},
      search: '',
      statusFilter: '',
      customerFilter: '',
      assigneeFilter: '',
      fromDate: '',
      toDate: '',
      sourceFilter: '',
    }
  }

  const createSegmentDrillState = (segment: any, totals: any, initialTab: UnitRecordKind = 'customers'): UnitDrillState => {
    const segmentLabel = segment.label || ''
    const customerIds = Array.from(new Set([
      ...(Array.isArray(segment.customerIds) ? segment.customerIds : []),
      ...(Array.isArray(segment.customer_ids) ? segment.customer_ids : []),
      ...(segment.customers || []).map((c: any) => Number(c.id || c.customer_id || 0)),
    ].map((id: any) => Number(id)).filter(Boolean)))
    return {
      key: `segment:${canonicalGroupKey(segmentLabel)}`,
      label: segmentLabel,
      verticalLabel: `${resultContext} - segment`,
      scope: 'segment',
      unit: {
        ...segment,
        label: segmentLabel,
        leads: Number(totals?.leads || 0),
        opportunities: Number(totals?.opportunities || 0),
        tenders: Number(totals?.tenders || 0),
        workOrders: Number(totals?.workOrders || 0),
        customers: segment.customers || [],
      },
      customerIds,
      allTime: true,
      customerScopeOnly: true,
      activeTab: initialTab,
      loading: true,
      rowsByKind: {},
      search: '',
      statusFilter: '',
      customerFilter: '',
      assigneeFilter: '',
      fromDate: '',
      toDate: '',
      sourceFilter: '',
    }
  }

  const segmentCustomerIds = (segment: any) => Array.from(new Set([
    ...(Array.isArray(segment?.customerIds) ? segment.customerIds : []),
    ...(Array.isArray(segment?.customer_ids) ? segment.customer_ids : []),
    ...(segment?.customers || []).map((customer: any) => Number(customer.id || customer.customer_id || 0)),
  ].map((id: any) => Number(id)).filter(Boolean)))

  const toggleSegmentSubSegmentBreakdown = (group: any) => {
    const subSegmentKey = group.subSegmentKey
    setExpandedSegmentSubSegmentKeys(prev => {
      const next = new Set(prev)
      if (next.has(subSegmentKey)) next.delete(subSegmentKey)
      else next.add(subSegmentKey)
      return next
    })
  }

  const openSegmentPopup = (group: any, initialTab: UnitRecordKind = 'customers') => {
    const row = group.segment
    const totals = displayedCustomerSegmentTotals(group)
    const nextDrill = createSegmentDrillState(row, totals, initialTab)
    setUnitPopupOpen(true)
    setUnitPopupMaximized(false)
    setVerticalPopupTab(initialTab)
    setUnitBreakdown({
      verticalLabel: row.label,
      vertical: row,
      rows: [],
    })
    setSelectedUnit({
      label: row.label,
      verticalLabel: `${resultContext} - segment`,
      customers: row.customers || [],
      leads: Number(totals.leads || 0),
      opportunities: Number(totals.opportunities || 0),
      tenders: Number(totals.tenders || 0),
      workOrders: Number(totals.workOrders || 0),
      value: Number(row.value || totals.value || 0),
    })
    setUnitDrill(nextDrill)
    loadUnitDrillTab(nextDrill, initialTab, true)
  }

  const openSegmentSubSegmentPopup = (group: any, subSegment: any, initialTab: UnitRecordKind = 'customers') => {
    const segment = group.segment
    const subSegmentCustomerIds = Array.from(new Set([
      ...(Array.isArray(subSegment.customerIds) ? subSegment.customerIds : []),
      ...(Array.isArray(subSegment.customer_ids) ? subSegment.customer_ids : []),
      ...(subSegment.customers || []).map((customer: any) => Number(customer.id || customer.customer_id || 0)),
    ].map((id: any) => Number(id)).filter(Boolean)))
    const segmentCustomersById = new Map((segment.customers || [])
      .map((customer: any) => [Number(customer.id || customer.customer_id || 0), customer])
      .filter(([id]: any) => Boolean(id)))
    const subSegmentCustomers = subSegmentCustomerIds.length > 0
      ? subSegmentCustomerIds.map(id => segmentCustomersById.get(id)).filter(Boolean)
      : []
    const fallbackCustomers = subSegmentCustomers.length > 0 ? subSegmentCustomers : (subSegment.customers || [])
    const subSegmentCustomerIdSet = new Set(subSegmentCustomerIds)
    const rowsForKind = (kind: UnitRecordKind) => (segmentPipelineRowsByKind[kind] || [])
      .filter((record: any) => subSegmentCustomerIdSet.has(recordCustomerId(record)))
    const leadRecords = (subSegment.leadRecords || rowsForKind('leads')).map((record: any) => ({ ...record, _kind: 'leads' }))
    const opportunityRecords = (subSegment.opportunityRecords || rowsForKind('opportunities')).map((record: any) => ({ ...record, _kind: 'opportunities' }))
    const tenderRecords = (subSegment.tenderRecords || rowsForKind('tenders')).map((record: any) => ({ ...record, _kind: 'tenders' }))
    const workOrderRecords = (subSegment.workOrderRecords || rowsForKind('workorders')).map((record: any) => ({ ...record, _kind: 'workorders' }))
    const metrics = subSegment.metrics || recordMetricsForCustomers(fallbackCustomers) || customerPipelineMetrics(fallbackCustomers)
    const subSegmentUnit = {
      ...subSegment,
      label: subSegment.label,
      count: fallbackCustomers.length || subSegmentCustomerIds.length,
      customers: fallbackCustomers,
      customerIds: subSegmentCustomerIds,
      leads: Number(metrics.leads || 0),
      opportunities: Number(metrics.opportunities || 0),
      tenders: Number(metrics.tenders || 0),
      workOrders: Number(metrics.workOrders || 0),
      value: Number(subSegment.value || metrics.value || 0),
    }
    const nextDrill: UnitDrillState = {
      key: `subsegment:${canonicalGroupKey(segment.label)}:${canonicalGroupKey(subSegment.label)}`,
      label: subSegment.label,
      verticalLabel: `${segment.label} - sub-segment`,
      scope: 'subsegment',
      unit: subSegmentUnit,
      customerIds: subSegmentCustomerIds,
      activeTab: initialTab,
      loading: false,
      rowsByKind: {
        customers: fallbackCustomers.map((row: any) => ({ ...row, _kind: 'customers' })),
        leads: leadRecords,
        opportunities: opportunityRecords,
        tenders: tenderRecords,
        workorders: workOrderRecords,
      },
      search: '',
      statusFilter: '',
      customerFilter: '',
      assigneeFilter: '',
      fromDate: '',
      toDate: '',
      sourceFilter: '',
    }
    setUnitPopupOpen(true)
    setUnitPopupMaximized(false)
    setVerticalPopupTab(initialTab)
    setUnitBreakdown({
      verticalLabel: subSegment.label,
      vertical: subSegmentUnit,
      rows: [],
    })
    setSelectedUnit({
      label: subSegment.label,
      verticalLabel: `${segment.label} - sub-segment`,
      customers: fallbackCustomers,
      leads: Number(metrics.leads || 0),
      opportunities: Number(metrics.opportunities || 0),
      tenders: Number(metrics.tenders || 0),
      workOrders: Number(metrics.workOrders || 0),
      value: Number(subSegment.value || metrics.value || 0),
    })
    setUnitDrill(nextDrill)
  }

  const openCustomerGrandTotalPopup = (initialTab: UnitRecordKind = 'customers') => {
    const row = {
      label: 'Total',
      count: customerTotal.count,
      value: customerTotal.value,
      customers: scopedCustomers,
      customerIds: scopedCustomers.map((customer: any) => Number(customer.id || customer.customer_id || 0)).filter(Boolean),
    }
    const nextDrill = createSegmentDrillState(row, displayedCustomerSegmentPipelineTotal, initialTab)
    setUnitPopupOpen(true)
    setUnitPopupMaximized(false)
    setVerticalPopupTab(initialTab)
    setUnitBreakdown({
      verticalLabel: 'Total',
      vertical: row,
      rows: [],
    })
    setSelectedUnit({
      label: 'Total',
      verticalLabel: `${resultContext} - segment`,
      customers: scopedCustomers,
      leads: Number(displayedCustomerSegmentPipelineTotal.leads || 0),
      opportunities: Number(displayedCustomerSegmentPipelineTotal.opportunities || 0),
      tenders: Number(displayedCustomerSegmentPipelineTotal.tenders || 0),
      workOrders: Number(displayedCustomerSegmentPipelineTotal.workOrders || 0),
      value: Number(customerTotal.value || displayedCustomerSegmentPipelineTotal.value || 0),
    })
    setUnitDrill(nextDrill)
    loadUnitDrillTab(nextDrill, initialTab, true)
  }

  const openBusinessGrandTotalPopup = (initialTab: UnitRecordKind = 'leads') => {
    const rows = businessVerticalGroups.flatMap(group => group.unitRows || [])
    const customerIds = Array.from(new Set([
      ...businessVerticalRows.flatMap((row: any) => Array.isArray(row.customerIds) ? row.customerIds : []),
      ...scopedCustomers.map((customer: any) => Number(customer.id || customer.customer_id || 0)),
    ].map((id: any) => Number(id)).filter(Boolean)))
    const row = {
      label: 'Total',
      customers: scopedCustomers,
      customerIds,
      leads: Number(businessTotal.leads || 0),
      opportunities: Number(businessTotal.opportunities || 0),
      tenders: Number(businessTotal.tenders || 0),
      workOrders: Number(businessTotal.workOrders || 0),
      value: Number(businessTotal.value || 0),
    }
    const nextDrill = createVerticalDrillState(row, rows, initialTab)
    setUnitPopupOpen(true)
    setSelectedUnit(null)
    setUnitPopupMaximized(false)
    setVerticalPopupTab(initialTab)
    setUnitBreakdown({
      verticalLabel: 'Total',
      vertical: row,
      rows,
    })
    setUnitDrill(nextDrill)
    loadUnitDrillTab(nextDrill, initialTab, true)
  }

  const openUnitRecordDrill = async (unit: any) => {
    if (!unitBreakdown) return
    const key = canonicalGroupKey(unit.label)
    if (unitDrill?.key === key) {
      setUnitDrill(null)
      return
    }
    const nextDrill = createUnitDrillState(unit, unitBreakdown.verticalLabel, 'leads')
    setUnitDrill(nextDrill)
    loadUnitDrillTab(nextDrill, 'leads', true)
  }

  const openUnitDetailPopup = (vertical: any, unit: any, initialTab: UnitRecordKind = 'leads') => {
    const verticalLabel = vertical.label || unit.verticalLabel || ''
    const rows = buildUnitBreakdownRows(verticalLabel, vertical.customers || [])
    const nextDrill = createUnitDrillState(unit, verticalLabel, initialTab)
    setUnitPopupOpen(true)
    setUnitPopupMaximized(false)
    setVerticalPopupTab(initialTab)
    setUnitBreakdown({ verticalLabel, vertical, rows })
    setSelectedUnit({
      label: unit.label,
      verticalLabel,
      customers: unit.customers || [],
      leads: Number(unit.leads || 0),
      opportunities: Number(unit.opportunities || 0),
      tenders: Number(unit.tenders || 0),
      workOrders: Number(unit.workOrders || 0),
      value: Number(unit.value || 0),
    })
    setUnitDrill(nextDrill)
    loadUnitDrillTab(nextDrill, initialTab, true)
  }

  const openUnitPopup = (unit: any) => {
    setUnitPopupOpen(true)
    setSelectedUnit(null)
    setUnitPopupMaximized(false)
    openUnitRecordDrill(unit)
  }

  const closeUnitPopup = () => {
    setUnitPopupOpen(false)
    setSelectedUnit(null)
    setUnitDrill(null)
    setUnitPopupMaximized(false)
    setVerticalPopupTab('leads')
  }

  const renderUnitBreakdownDropdown = () => {
    if (!unitBreakdown) return null
    return (
      <div className="border-y border-violet-100 bg-violet-50/20">
          <table className="w-full table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[34%]" />
              <col className="w-[14%]" />
              <col className="w-[18%]" />
              <col className="w-[14%]" />
              <col className="w-[20%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-black text-slate-500">
                <th className="px-2.5 py-2">Unit</th>
                <th className="px-1.5 py-2 text-center">{leadLabel}</th>
                <th className="px-1.5 py-2 text-center">{opportunityLabel}</th>
                <th className="px-1.5 py-2 text-center">{tenderLabel}</th>
                <th className="px-1.5 py-2 text-center">{workOrderLabel}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {unitBreakdown.rows.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-sm font-semibold text-slate-400">No units found for this vertical</td></tr>
              )}
              {unitBreakdown.rows.map((unit: any, idx: number) => {
                const hasData = Number(unit.leads || 0) + Number(unit.opportunities || 0) + Number(unit.tenders || 0) + Number(unit.workOrders || 0) + Number(unit.value || 0) > 0
                return (
                  <tr
                    key={`${unit.label}-${idx}`}
                    onClick={() => openUnitPopup(unit)}
                    className={`cursor-pointer transition-colors hover:bg-slate-50 ${!hasData ? 'text-slate-400' : ''}`}
                  >
                    <td className="px-2.5 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${idx % 5 === 0 ? 'bg-violet-100 text-violet-700' : idx % 5 === 1 ? 'bg-blue-100 text-blue-700' : idx % 5 === 2 ? 'bg-emerald-100 text-emerald-700' : idx % 5 === 3 ? 'bg-orange-100 text-orange-700' : 'bg-pink-100 text-pink-700'}`}>
                          {unit.label.charAt(0).toUpperCase()}
                        </span>
                        <span className="truncate text-xs font-black text-slate-900">{unit.label}</span>
                        <ChevronRight size={13} className="shrink-0 text-slate-300" />
                      </div>
                    </td>
                    <td className="px-1.5 py-2.5 text-center"><MetricPill value={Number(unit.leads || 0)} className="bg-violet-50 text-violet-700" /></td>
                    <td className="px-1.5 py-2.5 text-center"><MetricPill value={Number(unit.opportunities || 0)} className="bg-blue-50 text-blue-700" /></td>
                    <td className="px-1.5 py-2.5 text-center"><MetricPill value={Number(unit.tenders || 0)} className="bg-orange-50 text-orange-700" /></td>
                    <td className="px-1.5 py-2.5 text-center"><MetricPill value={Number(unit.workOrders || 0)} className="bg-emerald-50 text-emerald-700" /></td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-violet-100 bg-violet-50/70 text-sm font-black text-violet-700">
                <td className="px-2.5 py-2.5">Total</td>
                <td className="px-1.5 py-2.5 text-center">{unitBreakdown.rows.reduce((sum: number, row: any) => sum + Number(row.leads || 0), 0).toLocaleString('en-IN')}</td>
                <td className="px-1.5 py-2.5 text-center">{unitBreakdown.rows.reduce((sum: number, row: any) => sum + Number(row.opportunities || 0), 0).toLocaleString('en-IN')}</td>
                <td className="px-1.5 py-2.5 text-center">{unitBreakdown.rows.reduce((sum: number, row: any) => sum + Number(row.tenders || 0), 0).toLocaleString('en-IN')}</td>
                <td className="px-1.5 py-2.5 text-center">{unitBreakdown.rows.reduce((sum: number, row: any) => sum + Number(row.workOrders || 0), 0).toLocaleString('en-IN')}</td>
              </tr>
            </tfoot>
          </table>
      </div>
    )
  }

  const MH = 'max-h-[260px]'
  const allRegionCount = regionRows.reduce((sum, row) => sum + Number(row.count || 0), 0)
  const allStateCount = statesForRegion.reduce((sum, row) => sum + Number(row.count || 0), 0)
  const allDistrictCount = scopedCustomers.length
  const visibleRegionRows = regionRows
  const showStateSelector = Boolean(stateSelectorOpen || stateFilterEnabled || selectedState || selectedDistrict || districtFilterEnabled)
  const visibleStateRows = stateSelectorOpen || stateFilterEnabled || Boolean(selectedState) ? statesForRegion : []
  const showDistrictSelector = Boolean(selectedState && districtFilterEnabled)

  const SelectorHeader = ({ step, label }: { step: string; label: string }) => (
    <div className="border-b border-slate-200/80 bg-slate-50/60 px-2.5 py-1.5">
      <p className="text-[10.5px] font-black text-slate-900">{step}. Select {label}</p>
    </div>
  )

  const SelectorRow = ({
    label, count, active, onClick, Icon, tone = 'violet',
  }: {
    label: string
    count: number
    active: boolean
    onClick: () => void
    Icon: React.ElementType
    tone?: 'violet' | 'blue' | 'green' | 'orange' | 'slate'
  }) => {
    const toneMap = {
      violet: { icon: 'text-violet-600 bg-violet-100', border: 'border-violet-600', bg: 'bg-violet-50/80', text: 'text-violet-700' },
      blue: { icon: 'text-blue-600 bg-blue-100', border: 'border-blue-600', bg: 'bg-blue-50/70', text: 'text-blue-700' },
      green: { icon: 'text-emerald-600 bg-emerald-100', border: 'border-emerald-600', bg: 'bg-emerald-50/70', text: 'text-emerald-700' },
      orange: { icon: 'text-orange-600 bg-orange-100', border: 'border-orange-600', bg: 'bg-orange-50/70', text: 'text-orange-700' },
      slate: { icon: 'text-slate-500 bg-slate-100', border: 'border-slate-500', bg: 'bg-slate-50', text: 'text-slate-700' },
    }[tone]
    return (
      <button
        type="button"
        onClick={onClick}
        className={`group flex w-full items-center gap-2 border-l-2 px-2.5 py-1.5 text-left transition-colors ${active ? `${toneMap.border} ${toneMap.bg}` : 'border-transparent hover:bg-slate-50'}`}
      >
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${active ? toneMap.icon : 'bg-slate-100 text-slate-400'}`}>
          <Icon size={11} />
        </span>
        <span className={`min-w-0 flex-1 truncate text-[10.5px] font-bold ${active ? toneMap.text : 'text-slate-700'}`}>{label}</span>
        <span className={`shrink-0 tabular-nums text-[11px] font-black ${active ? 'text-violet-700' : 'text-slate-500'}`}>
          {count.toLocaleString('en-IN')}
        </span>
      </button>
    )
  }

  const selectorCard = (
    <div className={`grid min-h-[260px] overflow-hidden rounded-lg border border-slate-200 bg-white ${showDistrictSelector ? 'grid-cols-3' : showStateSelector ? 'grid-cols-2' : 'grid-cols-1'}`}>
      <div className={`min-w-0 ${showStateSelector ? 'border-r border-slate-200' : ''}`}>
        <SelectorHeader step="1" label="Region" />
        <div className={`${MH} overflow-y-auto py-0.5`}>
          <SelectorRow label="All Regions" count={allRegionCount} active={!selectedRegion} Icon={Globe} onClick={() => { setSelectedRegion(null); setSelectedState(null); setSelectedDistrict(null); setStateFilterEnabled(false); setDistrictFilterEnabled(false); setRegionSelectorOpen(false); setStateSelectorOpen(false) }} />
          {visibleRegionRows.map((region, idx) => (
            <SelectorRow
              key={region.label}
              label={region.label}
              count={region.count}
              active={selectedRegion === region.label}
              Icon={Globe}
              tone={idx % 3 === 0 ? 'green' : idx % 3 === 1 ? 'orange' : 'blue'}
              onClick={() => { setSelectedRegion(region.label); setSelectedState(null); setSelectedDistrict(null); setRegionSelectorOpen(true); setStateFilterEnabled(false); setDistrictFilterEnabled(false); setStateSelectorOpen(false) }}
            />
          ))}
          {selectedRegion && !selectedState && !stateFilterEnabled && !stateSelectorOpen && (
            <div className="px-3 py-2">
              <button
                type="button"
                onClick={() => setStateFilterEnabled(true)}
                className="w-full rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-[11px] font-black text-indigo-700 transition-colors hover:bg-indigo-100"
              >
                Enable States
              </button>
            </div>
          )}
        </div>
      </div>
      {showStateSelector && <div className="min-w-0 border-r border-slate-200">
        <SelectorHeader step="2" label="State" />
        <div className={`${MH} overflow-y-auto py-0.5`}>
          <SelectorRow label="All States" count={allStateCount} active={!selectedState} Icon={MapPin} onClick={() => { setSelectedState(null); setSelectedDistrict(null); setDistrictFilterEnabled(false); setStateFilterEnabled(true); setStateSelectorOpen(true) }} />
          {visibleStateRows.map(row => (
            <SelectorRow
              key={row.key}
              label={row.label}
              count={row.count}
              active={selectedState?.label === row.label}
              Icon={MapPin}
              tone="blue"
              onClick={() => { setSelectedState({ label: row.label, customers: row.customers }); setSelectedDistrict(null); setStateFilterEnabled(true); setStateSelectorOpen(false); setDistrictFilterEnabled(false) }}
            />
          ))}
          {selectedState && !districtFilterEnabled && (
            <div className="px-3 py-2">
              <button
                type="button"
                onClick={() => setDistrictFilterEnabled(true)}
                className="w-full rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[11px] font-black text-violet-700 transition-colors hover:bg-violet-100"
              >
                Enable Districts
              </button>
            </div>
          )}
        </div>
      </div>}
      {showDistrictSelector && <div className="min-w-0">
        <SelectorHeader step="3" label="District" />
        <div className={`${MH} overflow-y-auto py-0.5`}>
          <SelectorRow label="All Districts" count={allDistrictCount} active={!selectedDistrict} Icon={MapPin} onClick={() => setSelectedDistrict(null)} />
          {districtRows.map(d => (
            <SelectorRow
              key={d.label}
              label={d.label}
              count={d.count}
              active={selectedDistrict?.label === d.label}
              Icon={MapPin}
              tone="slate"
              onClick={() => setSelectedDistrict({ label: d.label, customers: d.customers })}
            />
          ))}
        </div>
      </div>}
    </div>
  )

  const customerTotal = segmentRows.reduce((sum, row) => ({
    count: sum.count + Number(row.count || 0),
    value: sum.value + Number(row.value || 0),
  }), { count: 0, value: 0 })

  const customerPipelineMetrics = (customers: any[] = []) => customers.reduce((sum, customer) => ({
    leads: sum.leads + Number(customer.lead_count || 0),
    leadValue: sum.leadValue + Number(customer.lead_value || 0),
    opportunities: sum.opportunities + Number(customer.opportunity_count || customer.opp_count || 0),
    opportunityValue: sum.opportunityValue + Number(customer.opportunity_value || customer.opp_value || 0),
    tenders: sum.tenders + Number(customer.tender_count || 0),
    tenderValue: sum.tenderValue + Number(customer.tender_value || 0),
    workOrders: sum.workOrders + Number(customer.work_order_count || customer.wo_count || customer.won_count || 0),
    workOrderValue: sum.workOrderValue + Number(customer.work_order_value || customer.wo_value || customer.won_value || customer.won_tender_value || 0),
    value: sum.value + portfolioValueFn(customer),
  }), { leads: 0, leadValue: 0, opportunities: 0, opportunityValue: 0, tenders: 0, tenderValue: 0, workOrders: 0, workOrderValue: 0, value: 0 })

  const segmentSubSegmentScopeKey = (segmentLabel: string) => [
    'subsegment-v1',
    selectedRegion || 'all-regions',
    selectedState?.label || 'all-states',
    selectedDistrict?.label || 'all-districts',
    fiscalYear || 'all-years',
    canonicalGroupKey(segmentLabel),
  ].join('|')

  const sourceLabelForRecord = (record: any, kind: 'leads' | 'tenders' | 'workorders') => {
    if (kind === 'tenders') {
      const sourceName = canonicalGroupLabel(record.source_name || record.source)
      if (sourceName) return sourceName
      const portal = canonicalGroupLabel(record.source_portal || record.portal_name || record.tender_portal)
      return canonicalGroupKey(portal) === 'other' ? '' : portal
    }
    if (kind === 'workorders') {
      const sourceName = canonicalGroupLabel(record.source_name || record.source)
      if (sourceName) return sourceName
      const portal = canonicalGroupLabel(record.source_portal || record.portal_name || record.tender_portal)
      return canonicalGroupKey(portal) === 'other' ? '' : portal
    }
    const raw = record.lead_source || record.source_name || record.source || record.order_source
    return canonicalGroupLabel(raw)
  }

  const isOpportunityLeadRecord = (record: any) => {
    const leadType = String(record.lead_type || '').toLowerCase()
    const status = String(record.status || '').toLowerCase()
    return leadType === 'direct_opportunity' || status === 'opportunity created' || status === 'converted'
  }

  const buildSegmentSourceRows = (leadRows: any[] = [], tenderRows: any[] = [], workOrderRows: any[] = []) => {
    const map = new Map<string, {
      label: string
      customerIds: Set<number>
      customers: any[]
      leads: number
      opportunities: number
      tenders: number
      workOrders: number
      value: number
      leadRecords: any[]
      tenderRecords: any[]
      workOrderRecords: any[]
    }>()
    const ensure = (labelValue: unknown) => {
      const label = canonicalGroupLabel(labelValue)
      if (!label || label === 'Unassigned') return null
      const key = canonicalGroupKey(label)
      if (masterSourceByKey.size > 0 && !masterSourceByKey.has(key)) return null
      const displayLabel = masterSourceByKey.get(key) || label
      const entry = map.get(key) || {
        label: displayLabel,
        customerIds: new Set<number>(),
        customers: [],
        leads: 0,
        leadValue: 0,
        opportunities: 0,
        opportunityValue: 0,
        tenders: 0,
        tenderValue: 0,
        workOrders: 0,
        workOrderValue: 0,
        value: 0,
        leadRecords: [],
        tenderRecords: [],
        workOrderRecords: [],
      }
      map.set(key, entry)
      return entry
    }
    const addCustomer = (entry: any, record: any) => {
      const customerId = Number(record.customer_id || 0)
      if (customerId) entry.customerIds.add(customerId)
      if (record.customer_name || record.name) entry.customers.push({ id: customerId, customer_id: customerId, customer_name: record.customer_name || record.name })
    }

    leadRows.forEach((record: any) => {
      const entry = ensure(sourceLabelForRecord(record, 'leads'))
      if (!entry) return
      addCustomer(entry, record)
      entry.leadRecords.push(record)
      entry.leads += 1
      entry.leadValue += Number(record.est_value ?? record.lead_value ?? 0)
      if (isOpportunityLeadRecord(record)) entry.opportunities += 1
      if (isOpportunityLeadRecord(record)) entry.opportunityValue += Number(record.est_value ?? record.lead_value ?? record.opportunity_value ?? 0)
      entry.value += Number(record.est_value ?? record.lead_value ?? record.opportunity_value ?? 0)
    })
    tenderRows.forEach((record: any) => {
      const entry = ensure(sourceLabelForRecord(record, 'tenders'))
      if (!entry) return
      addCustomer(entry, record)
      entry.tenderRecords.push(record)
      entry.tenders += 1
      entry.tenderValue += Number(record.bid_amount || record.est_value || record.tender_value || 0)
      entry.value += Number(record.bid_amount || record.est_value || record.tender_value || 0)
    })
    workOrderRows.forEach((record: any) => {
      const entry = ensure(sourceLabelForRecord(record, 'workorders'))
      if (!entry) return
      addCustomer(entry, record)
      entry.workOrderRecords.push(record)
      entry.workOrders += 1
      entry.workOrderValue += Number(record.wo_value || record.po_value || record.bid_amount || 0)
      entry.value += Number(record.wo_value || record.po_value || record.bid_amount || 0)
    })

    return Array.from(map.values())
      .map(row => ({
        ...row,
        customerIds: Array.from(row.customerIds),
        customers: Array.from(
          new Map(row.customers.map((customer: any) => [Number(customer.customer_id || customer.id || 0) || customer.customer_name, customer])).values()
        ),
      }))
      .filter(row => Number(row.leads || 0) + Number(row.tenders || 0) + Number(row.workOrders || 0) > 0)
      .sort((a, b) => (
        (Number(b.leads || 0) + Number(b.tenders || 0) + Number(b.workOrders || 0)) -
        (Number(a.leads || 0) + Number(a.tenders || 0) + Number(a.workOrders || 0))
      ) || Number(b.value || 0) - Number(a.value || 0) || a.label.localeCompare(b.label))
  }

  const customerSegmentGroups = segmentRows.map(row => {
    const subRows = buildSubSegmentBreakdownRows(row.label, row.customers || [])
      .filter((sub: any) => !sub.isUnmapped || Number(sub.count || 0) > 0)
    const visibleSubRows = subRows.length > 0
      ? subRows
      : [{
          label: 'Not mapped',
          count: Number(row.count || 0),
          value: Number(row.value || 0),
          customers: row.customers || [],
        }]
    return {
      segment: row,
      total: customerPipelineMetrics(row.customers || []),
      subSegmentKey: segmentSubSegmentScopeKey(row.label),
      subRows: visibleSubRows.map((sub: any) => ({
        ...sub,
        metrics: customerPipelineMetrics(sub.customers || []),
      })),
    }
  })
  const groupedCustomerCount = (row: any) => {
    const ids = Array.isArray(row?.customerIds)
      ? row.customerIds
      : Array.isArray(row?.customer_ids)
        ? row.customer_ids
        : []
    const uniqueIds = Array.from(new Set(ids.map((id: any) => Number(id)).filter(Boolean)))
    if (uniqueIds.length > 0) return uniqueIds.length
    return Number(row?.count ?? row?.customer_count ?? row?.customers?.length ?? 0)
  }
  const segmentPipelineRecordsReady = !hasTwoPanel && segmentPipelineLoadedKey === scopedCustomerIdsKey
  const recordCustomerId = (row: any) => Number(row?.customer_id || row?.customerId || row?.customer?.id || 0)
  const recordValue = (row: any, kind: UnitRecordKind) => {
    if (kind === 'tenders') return Number(row?.est_value || row?.tender_value || row?.bid_amount || 0)
    if (kind === 'workorders') return Number(row?.wo_value || row?.po_value || row?.bid_amount || row?.work_order_value || 0)
    if (kind === 'opportunities') return Number(row?.opportunity_value || row?.est_value || row?.lead_value || 0)
    return Number(row?.lead_value || row?.est_value || 0)
  }
  const recordMetricsForCustomers = (customers: any[] = []) => {
    if (!segmentPipelineRecordsReady) return null
    const customerIds = new Set(
      customers
        .map((customer: any) => Number(customer.id || customer.customer_id || 0))
        .filter(Boolean)
    )
    if (customerIds.size === 0) {
      return {
        customers: 0,
        leads: 0,
        leadValue: 0,
        opportunities: 0,
        opportunityValue: 0,
        tenders: 0,
        tenderValue: 0,
        workOrders: 0,
        workOrderValue: 0,
      }
    }
    const rowsFor = (kind: UnitRecordKind) => (segmentPipelineRowsByKind[kind] || [])
      .filter((row: any) => customerIds.has(recordCustomerId(row)))
    const leadRows = rowsFor('leads')
    const opportunityRows = rowsFor('opportunities')
    const tenderRows = rowsFor('tenders')
    const workOrderRows = rowsFor('workorders')
    return {
      customers: customers.length,
      leads: leadRows.length,
      leadValue: leadRows.reduce((sum: number, row: any) => sum + recordValue(row, 'leads'), 0),
      opportunities: opportunityRows.length,
      opportunityValue: opportunityRows.reduce((sum: number, row: any) => sum + recordValue(row, 'opportunities'), 0),
      tenders: tenderRows.length,
      tenderValue: tenderRows.reduce((sum: number, row: any) => sum + recordValue(row, 'tenders'), 0),
      workOrders: workOrderRows.length,
      workOrderValue: workOrderRows.reduce((sum: number, row: any) => sum + recordValue(row, 'workorders'), 0),
    }
  }
  const displayedCustomerSegmentTotals = (group: any) => {
    const fallback = group.total || customerPipelineMetrics(group.segment?.customers || [])
    const recordMetrics = recordMetricsForCustomers(group.segment?.customers || [])
    if (recordMetrics) {
      const value = Number(group.segment?.value || fallback.value || 0)
      return {
        ...recordMetrics,
        value,
      }
    }
    return {
      customers: Number(group.segment?.count || group.segment?.customers?.length || 0),
      leads: Number(fallback.leads || 0),
      leadValue: Number(fallback.leadValue || 0),
      opportunities: Number(fallback.opportunities || 0),
      opportunityValue: Number(fallback.opportunityValue || 0),
      tenders: Number(fallback.tenders || 0),
      tenderValue: Number(fallback.tenderValue || 0),
      workOrders: Number(fallback.workOrders || 0),
      workOrderValue: Number(fallback.workOrderValue || 0),
      value: Number(group.segment?.value || fallback.value || 0),
    }
  }
  const displayedCustomerSegmentPipelineTotal = customerSegmentGroups.reduce((sum: any, group: any) => {
    const totals = displayedCustomerSegmentTotals(group)
    return {
      customers: sum.customers + Number(totals.customers || 0),
      leads: sum.leads + Number(totals.leads || 0),
      leadValue: sum.leadValue + Number(totals.leadValue || 0),
      opportunities: sum.opportunities + Number(totals.opportunities || 0),
      opportunityValue: sum.opportunityValue + Number(totals.opportunityValue || 0),
      tenders: sum.tenders + Number(totals.tenders || 0),
      tenderValue: sum.tenderValue + Number(totals.tenderValue || 0),
      workOrders: sum.workOrders + Number(totals.workOrders || 0),
      workOrderValue: sum.workOrderValue + Number(totals.workOrderValue || 0),
      value: sum.value + Number(totals.value || 0),
    }
  }, { customers: 0, leads: 0, leadValue: 0, opportunities: 0, opportunityValue: 0, tenders: 0, tenderValue: 0, workOrders: 0, workOrderValue: 0, value: 0 })

  const businessVerticalGroups = businessVerticalRows.map(row => {
    const unitRows = buildUnitBreakdownRows(row.label, row.customers || [])
    return {
      vertical: row,
      unitRows: unitRows.length > 0
        ? unitRows
        : [{
            label: 'Not mapped',
            leads: Number(row.leads || 0),
            leadValue: Number(row.leadValue || row.lead_value || 0),
            opportunities: Number(row.opportunities || 0),
            opportunityValue: Number(row.opportunityValue || row.opportunity_value || 0),
            tenders: Number(row.tenders || 0),
            tenderValue: Number(row.tenderValue || row.tender_value || 0),
            workOrders: Number(row.workOrders || 0),
            workOrderValue: Number(row.workOrderValue || row.work_order_value || row.wo_value || 0),
            value: Number(row.value || 0),
            customers: row.customers || [],
            customerIds: row.customerIds || [],
          }],
    }
  })
  const businessTotal = businessVerticalRows.reduce((sum, row) => ({
    customers: sum.customers + groupedCustomerCount(row),
    leads: sum.leads + Number(row.leads || 0),
    leadValue: sum.leadValue + Number(row.leadValue || row.lead_value || customerPipelineMetrics(row.customers || []).leadValue || 0),
    opportunities: sum.opportunities + Number(row.opportunities || 0),
    opportunityValue: sum.opportunityValue + Number(row.opportunityValue || row.opportunity_value || customerPipelineMetrics(row.customers || []).opportunityValue || 0),
    tenders: sum.tenders + Number(row.tenders || 0),
    tenderValue: sum.tenderValue + Number(row.tenderValue || row.tender_value || customerPipelineMetrics(row.customers || []).tenderValue || 0),
    workOrders: sum.workOrders + Number(row.workOrders || 0),
    workOrderValue: sum.workOrderValue + Number(row.workOrderValue || row.work_order_value || row.wo_value || customerPipelineMetrics(row.customers || []).workOrderValue || 0),
    value: sum.value + Number(row.value || 0),
  }), { customers: 0, leads: 0, leadValue: 0, opportunities: 0, opportunityValue: 0, tenders: 0, tenderValue: 0, workOrders: 0, workOrderValue: 0, value: 0 })

  const activeFiscalYear = fiscalYear || new Date().getFullYear()
  const availableFiscalYears = (fiscalYearOptions && fiscalYearOptions.length > 0)
    ? fiscalYearOptions
    : Array.from({ length: 5 }, (_, idx) => activeFiscalYear - 3 + idx)
  const fiscalYearLabel = (year: number) => `FY ${year}-${String(year + 1).slice(-2)}`
  const csvEscape = (value: unknown) => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const csvAmount = (value: unknown, blankWhenZero = false) => {
    const num = Number(value ?? 0)
    if (!Number.isFinite(num)) return blankWhenZero ? '' : '0.00'
    if (blankWhenZero && num <= 0) return ''
    return num.toFixed(2)
  }
  const downloadCsv = () => {
    const rows = !hasTwoPanel
      ? [
          ['Segment', customerLabel, leadLabel, opportunityLabel, tenderLabel, workOrderLabel, 'Potential Value'],
          ...customerSegmentGroups.map(group => {
            const totals = displayedCustomerSegmentTotals(group)
            return [
              group.segment.label,
              Number(totals.customers || 0),
              Number(totals.leads || 0),
              Number(totals.opportunities || 0),
              Number(totals.tenders || 0),
              Number(totals.workOrders || 0),
              csvAmount(totals.value),
            ]
          }),
          [`Total (${resultContext})`, customerTotal.count, displayedCustomerSegmentPipelineTotal.leads, displayedCustomerSegmentPipelineTotal.opportunities, displayedCustomerSegmentPipelineTotal.tenders, displayedCustomerSegmentPipelineTotal.workOrders, csvAmount(customerTotal.value)],
        ]
      : [
          ['Vertical', `Vertical ${customerSingular} Count`, 'Unit', `Unit ${customerSingular} Count`, leadLabel, opportunityLabel, tenderLabel, workOrderLabel, 'Potential Value'],
          ...businessVerticalGroups.flatMap(group => [
            ...group.unitRows.map((unit: any) => [
              group.vertical.label,
              groupedCustomerCount(group.vertical),
              unit.label,
              groupedCustomerCount(unit),
              Number(unit.leads || 0),
              Number(unit.opportunities || 0),
              Number(unit.tenders || 0),
              Number(unit.workOrders || 0),
              csvAmount(unit.value),
            ]),
            [
              group.vertical.label,
              groupedCustomerCount(group.vertical),
              'Total',
              groupedCustomerCount(group.vertical),
              Number(group.vertical.leads || 0),
              Number(group.vertical.opportunities || 0),
              Number(group.vertical.tenders || 0),
              Number(group.vertical.workOrders || 0),
              csvAmount(group.vertical.value),
            ],
          ]),
          [`Total (${resultContext})`, businessTotal.customers, '', businessTotal.customers, businessTotal.leads, businessTotal.opportunities, businessTotal.tenders, businessTotal.workOrders, csvAmount(businessTotal.value)],
        ]
    const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${sectionTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${fiscalYearLabel(activeFiscalYear).toLowerCase().replace(/\s+/g, '-')}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const exportUnitDrillCsv = () => {
    if (!unitDrill) return
    const rows = unitDrill.activeTab === 'customers'
      ? [
          [customerSingular, 'Segment', 'Location', 'Status', 'Potential', 'Contact', 'Assigned To', 'Last Activity'],
          ...filteredUnitDrillRows.map((record: any) => [
            unitRecordCustomerName(record),
            [unitRecordSegment(record), unitRecordSubSegment(record)].filter(Boolean).join(' - '),
            unitRecordLocation(record),
            unitRecordStatus(record),
            csvAmount(unitRecordValue(record), true),
            [unitRecordContactName(record), unitRecordContactPhone(record)].filter(Boolean).join(' - '),
            unitRecordAssignee(record),
            [unitRecordLastActivityDate(record) ? popupDateLabel(unitRecordLastActivityDate(record)) : '', unitRecordLastActivityType(record)].filter(Boolean).join(' - '),
          ]),
        ]
      : unitDrill.activeTab === 'tenders'
        ? [
            [`${tenderSingular} #`, customerSingular, 'Timeline', 'Value', 'Stage', 'Result', 'Progress', 'KAM'],
            ...filteredUnitDrillRows.map((record: any) => [
              record.portal_ref_number || record.tender_num || record.tender_id_ref || record.id || '',
              unitRecordCustomerName(record),
              unitRecordDate(record) ? popupDateLabel(unitRecordDate(record)) : '',
              csvAmount(unitRecordValue(record), true),
              record.tender_status || record.stage || '',
              record.result || record.tender_result || '',
              unitRecordProgress(record),
              unitRecordAssignee(record),
            ]),
          ]
        : [
            [`${leadSingular} / ${opportunitySingular}`, 'Source', 'Status', 'Priority & Value', 'Owner', 'Timeline', 'Contact', 'Last Activity'],
            ...filteredUnitDrillRows.map((record: any) => [
              unitRecordTitle(record),
              [unitRecordSource(record), unitRecordSourceTypeLabel(unitRecordSourceType(record))].filter(Boolean).join(' - '),
              unitRecordStatus(record),
              [unitRecordPriority(record), csvAmount(unitRecordValue(record), true)].filter(Boolean).join(' - '),
              unitRecordAssignee(record),
              unitRecordDate(record) ? popupDateLabel(unitRecordDate(record)) : '',
              [unitRecordContactName(record), unitRecordContactPhone(record)].filter(Boolean).join(' - '),
              [unitRecordLastActivityDate(record) ? popupDateLabel(unitRecordLastActivityDate(record)) : '', unitRecordLastActivityType(record)].filter(Boolean).join(' - '),
            ]),
          ]
    const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${unitDrill.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${unitDrill.activeTab}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const renderUnitDrillToolbar = () => {
    if (!unitDrill) return null
    const isCustomers = unitDrill.activeTab === 'customers'
    const isLeadTab = unitDrill.activeTab === 'leads'
    const customerStatusTabs = isCustomers
      ? [
          { label: `All ${customerLabel}`, value: '', count: unitDrillRows.length },
          { label: 'Active', value: 'Active', count: unitDrillRows.filter((row: any) => unitRecordStatus(row) === 'Active').length },
          { label: 'Prospect', value: 'Prospect', count: unitDrillRows.filter((row: any) => unitRecordStatus(row) === 'Prospect').length },
          { label: 'Inactive', value: 'Inactive', count: unitDrillRows.filter((row: any) => unitRecordStatus(row) === 'Inactive').length },
        ]
      : []
    const sourceButtons = unitDrill.activeTab === 'opportunities' || unitDrill.activeTab === 'tenders'
      ? [
          { label: `All (${unitDrillRows.length})`, value: '' },
          { label: `From ${leadSingular} (${unitDrillRows.filter((row: any) => unitRecordSourceType(row) === 'From Lead').length})`, value: 'From Lead' },
          ...(unitDrill.activeTab === 'tenders'
            ? [{ label: `From ${opportunityLabel} (${unitDrillRows.filter((row: any) => unitRecordSourceType(row) === 'From Opportunities').length})`, value: 'From Opportunities' }]
            : []),
          { label: `Direct (${unitDrillRows.filter((row: any) => unitRecordSourceType(row) === 'Direct').length})`, value: 'Direct' },
        ]
      : []
    return (
      <div className="flex flex-nowrap items-center gap-1.5 overflow-visible border-b border-slate-100 bg-slate-50/70 px-2.5 py-1.5">
        <div className={`relative flex-none ${isCustomers ? 'w-[160px]' : isLeadTab ? 'w-[180px]' : 'w-[230px]'}`}>
          <Search size={isCustomers ? 11 : 13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={unitDrill.search}
            onChange={event => setUnitDrill(prev => prev ? { ...prev, search: event.target.value } : prev)}
            placeholder={isCustomers ? `Search ${customerLabelLower}...` : `Search ${unitRecordKindLabel(unitDrill.activeTab).toLowerCase()} records...`}
            className={`${isCustomers ? 'h-8 pl-7 pr-6 text-[11px]' : 'h-7 pl-7 pr-6 text-[10px]'} w-full rounded-lg border border-slate-200 bg-white font-semibold text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-100`}
          />
          {unitDrill.search && (
            <button
              type="button"
              onClick={() => setUnitDrill(prev => prev ? { ...prev, search: '' } : prev)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              title="Clear search"
            >
                <X size={12} />
            </button>
          )}
        </div>
        <div className="flex flex-none flex-nowrap items-center gap-1.5">
          {!isCustomers && (
            <select
              value={unitDrill.customerFilter || ''}
              onChange={event => setUnitDrill(prev => prev ? { ...prev, customerFilter: event.target.value } : prev)}
              className={`${isLeadTab ? 'w-[96px]' : 'w-[90px]'} h-7 rounded-lg border border-slate-200 bg-white px-1.5 text-[10px] font-black text-slate-600 outline-none transition focus:border-blue-400`}
            >
              <option value="">All {customerLabel}</option>
              {unitDrillCustomerOptions.map(customer => <option key={customer} value={customer}>{customer}</option>)}
            </select>
          )}
          <select
            value={unitDrill.assigneeFilter || ''}
            onChange={event => setUnitDrill(prev => prev ? { ...prev, assigneeFilter: event.target.value } : prev)}
            className={`${isCustomers ? 'h-8 w-[140px] px-2.5 text-[11px] font-semibold' : isLeadTab ? 'h-7 w-[108px] px-1.5 text-[10px] font-black' : 'h-7 w-[112px] px-1.5 text-[10px] font-black'} rounded-lg border border-slate-200 bg-white text-slate-600 outline-none transition focus:border-blue-400`}
          >
            <option value="">{isCustomers ? 'Assigned To' : 'All Assigned To'}</option>
            {unitDrillAssigneeOptions.map(assignee => <option key={assignee} value={assignee}>{assignee}</option>)}
          </select>
          {isCustomers&&(
            <div className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-0.5 shadow-sm">
              {customerStatusTabs.map(tab=>{
                const active = (unitDrill.statusFilter || '') === tab.value
                return (
                  <button
                    key={tab.label}
                    type="button"
                    onClick={() => setUnitDrill(prev => prev ? { ...prev, statusFilter: tab.value } : prev)}
                    className={`inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-[11px] font-black transition-colors ${
                      active ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-black leading-none ${active ? 'bg-white/15 text-white' : 'bg-slate-100 text-slate-500'}`}>
                      {tab.count}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          {!isCustomers && (
            <>
              <input
                type="date"
                value={unitDrill.fromDate || ''}
                onChange={event => setUnitDrill(prev => prev ? { ...prev, fromDate: event.target.value } : prev)}
                className={`${isLeadTab ? 'w-[96px]' : 'w-[92px]'} h-7 rounded-lg border border-slate-200 bg-white px-1.5 text-[10px] font-black text-slate-600 outline-none transition focus:border-blue-400`}
              />
              <input
                type="date"
                value={unitDrill.toDate || ''}
                onChange={event => setUnitDrill(prev => prev ? { ...prev, toDate: event.target.value } : prev)}
                className={`${isLeadTab ? 'w-[96px]' : 'w-[92px]'} h-7 rounded-lg border border-slate-200 bg-white px-1.5 text-[10px] font-black text-slate-600 outline-none transition focus:border-blue-400`}
              />
            </>
          )}
          {sourceButtons.map(button => (
            <button
              key={button.label}
              type="button"
              onClick={() => setUnitDrill(prev => prev ? { ...prev, sourceFilter: button.value } : prev)}
              className={`h-7 whitespace-nowrap rounded-lg border px-1.5 text-[10px] font-black transition-colors ${
                (unitDrill.sourceFilter || '') === button.value
                  ? unitDrill.activeTab === 'tenders'
                    ? 'border-orange-300 bg-orange-100 text-orange-800'
                    : 'border-violet-300 bg-violet-100 text-violet-800'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              {button.label}
            </button>
          ))}
          {!isCustomers&&(
            <label className={`inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-1.5 text-[10px] font-black text-slate-600 ${isLeadTab ? 'w-[94px]' : ''}`}>
              <SlidersHorizontal size={11} className="text-slate-400" />
              <select
                value={unitDrill.statusFilter || ''}
                onChange={event => setUnitDrill(prev => prev ? { ...prev, statusFilter: event.target.value } : prev)}
                className={`${isLeadTab ? 'max-w-[72px]' : 'max-w-[76px]'} bg-transparent text-[10px] font-black text-slate-600 outline-none`}
              >
                <option value="">All Status</option>
                {unitDrillStatusOptions.map(status => <option key={status} value={status}>{status}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="min-w-2 flex-1" />
        <div className="ml-auto flex flex-none items-center justify-end gap-1.5">
          <button
            type="button"
            className={`${isCustomers ? 'h-8 gap-1 rounded-lg px-2.5 text-[11px]' : 'h-7 gap-1 rounded-lg px-2 text-[10.5px] font-black'} inline-flex items-center whitespace-nowrap border border-slate-200 bg-white font-semibold text-slate-700 transition hover:bg-slate-50`}
          >
            <SlidersHorizontal size={isCustomers ? 12 : 12} />
            Columns
          </button>
          <KAMPermGate perm="canExport"><button
            type="button"
            onClick={exportUnitDrillCsv}
            className={`${isCustomers ? 'h-8 gap-1 rounded-lg px-2.5 text-[11px] font-semibold' : 'h-7 gap-1 rounded-lg px-2 text-[10.5px] font-black'} inline-flex items-center whitespace-nowrap border border-slate-200 bg-white text-slate-700 transition hover:border-blue-200 hover:bg-blue-50`}
          >
            <Download size={isCustomers ? 12 : 12} />
            Export
            {isCustomers&&<ChevronDown size={11} />}
          </button></KAMPermGate>
        </div>
      </div>
    )
  }

  const renderUnitDrillTable = () => {
    if (!unitDrill) return null

    if (unitDrill.loading) {
      return (
        <div className="flex min-h-[180px] items-center justify-center gap-2 text-sm font-semibold text-slate-400">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-violet-200 border-t-violet-600" />
          Loading records...
        </div>
      )
    }
    if (unitDrill.error) return <div className="px-4 py-10 text-center text-sm font-semibold text-red-500">{unitDrill.error}</div>
    if (filteredUnitDrillRows.length === 0) return <div className="px-4 py-10 text-center text-sm font-semibold text-slate-400">No records found for this tab</div>

    const tableFooter = (
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 bg-white px-4 py-3 text-xs font-semibold text-slate-500">
        <span>{unitDrillStartIndex + 1}-{unitDrillEndIndex} of {unitDrillTotalRows} records</span>
        <span className="h-4 w-px bg-slate-200" />
        <span>Rows per page:</span>
        <div className="flex overflow-hidden rounded-md border border-slate-200 bg-white">
          {unitDrillPageSizeOptions.map(option => {
            const active = unitDrillPageSize === option
            return (
              <button
                key={String(option)}
                type="button"
                onClick={() => setUnitDrillPageSize(option)}
                className={`min-w-[38px] px-3 py-1.5 text-xs font-bold transition-colors ${active ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-50'}`}
              >
                {option}
              </button>
            )
          })}
        </div>
        {unitDrillPageSize !== 'All' && unitDrillTotalPages > 1 && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setUnitDrillPage(page => Math.max(1, page - 1))}
              disabled={safeUnitDrillPage <= 1}
              className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Prev
            </button>
            <span className="tabular-nums text-slate-500">{safeUnitDrillPage} / {unitDrillTotalPages}</span>
            <button
              type="button"
              onClick={() => setUnitDrillPage(page => Math.min(unitDrillTotalPages, page + 1))}
              disabled={safeUnitDrillPage >= unitDrillTotalPages}
              className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>
    )

    if (unitDrill.activeTab === 'customers') {
      return (
        <>
          <table className="w-full min-w-[1120px] table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[19%]" />
              <col className="w-[13%]" />
              <col className="w-[11%]" />
              <col className="w-[9%]" />
              <col className="w-[11%]" />
              <col className="w-[15%]" />
              <col className="w-[11%]" />
              <col className="w-[11%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-black uppercase text-slate-500">
                <th className="px-4 py-3">{customerSingular}</th>
                <th className="px-4 py-3">Segment</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Potential</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Assigned To</th>
                <th className="px-4 py-3">Last Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {pagedUnitDrillRows.map((record: any, idx: number) => {
                const value = unitRecordValue(record)
                return (
                  <tr key={`customer-${record.id || record.customer_id || idx}`} className="transition-colors hover:bg-slate-50">
                    <td className="border-l-[3px] border-amber-400 px-4 py-3">
                      <p className="truncate text-sm font-black text-slate-900">{unitRecordCustomerName(record) || '--'}</p>
                      <p className="mt-0.5 truncate text-[11px] font-semibold text-slate-400">{record.group_name || record.department || '--'}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="truncate text-xs font-black text-slate-700">{unitRecordSegment(record) || '--'}</p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-400">{unitRecordSubSegment(record) || '--'}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="truncate text-xs font-black text-slate-700">{record.billing_city || record.city || record.district || '--'}</p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-400">{record.billing_state || record.state || '--'}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-lg px-2 py-1 text-[10px] font-black ${unitRecordStatusTone(unitRecordStatus(record), 'customers')}`}>{unitRecordStatus(record)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-lg bg-amber-50 px-2 py-1 text-[10px] font-black text-orange-700">{unitRecordPriority(record)}</span>
                      <p className="mt-1 text-xs font-black tabular-nums text-slate-950">{value > 0 ? fmtFn(value) : '--'}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="truncate text-xs font-black text-slate-800">{unitRecordContactName(record) || '--'}</p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-400">{unitRecordContactPhone(record) || '--'}</p>
                    </td>
                    <td className="truncate px-4 py-3 text-xs font-black text-slate-700">{unitRecordAssignee(record) || '--'}</td>
                    <td className="px-4 py-3">
                      <p className="truncate text-xs font-black text-slate-700">{unitRecordLastActivityDate(record) ? popupDateLabel(unitRecordLastActivityDate(record)) : '--'}</p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-400">{unitRecordLastActivityType(record) || '--'}</p>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {tableFooter}
        </>
      )
    }

    if (unitDrill.activeTab === 'tenders') {
      return (
        <>
          <table className="w-full min-w-[1120px] table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[18%]" />
              <col className="w-[18%]" />
              <col className="w-[12%]" />
              <col className="w-[10%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-[10%]" />
              <col className="w-[8%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-black uppercase text-slate-500">
                <th className="px-4 py-3">{tenderSingular} #</th>
                <th className="px-4 py-3">{customerSingular}</th>
                <th className="px-4 py-3">Timeline</th>
                <th className="px-4 py-3 text-right">Value</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Result</th>
                <th className="px-4 py-3">Progress</th>
                <th className="px-4 py-3">KAM</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {pagedUnitDrillRows.map((record: any, idx: number) => {
                const value = unitRecordValue(record)
                const result = record.result || record.tender_result || 'Pending'
                return (
                  <tr key={`tender-${record.id || record.tender_id || record.tender_num || idx}`} className="transition-colors hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="truncate text-sm font-black text-slate-900">{record.portal_ref_number || record.tender_num || record.tender_id_ref || record.id || '--'}</p>
                      <p className="mt-0.5 truncate text-[11px] font-semibold text-slate-400">{record.tender_title || '--'}</p>
                    </td>
                    <td className="truncate px-4 py-3 text-xs font-black text-slate-700">{unitRecordCustomerName(record) || '--'}</td>
                    <td className="px-4 py-3 text-xs font-black text-slate-700">{unitRecordDate(record) ? popupDateLabel(unitRecordDate(record)) : '--'}</td>
                    <td className="truncate px-4 py-3 text-right text-sm font-black tabular-nums text-slate-950">{value > 0 ? fmtFn(value) : '--'}</td>
                    <td className="px-4 py-3"><span className="rounded-lg bg-blue-50 px-2 py-1 text-[10px] font-black text-blue-700">{record.tender_status || record.stage || 'Aligned'}</span></td>
                    <td className="px-4 py-3"><span className={`rounded-lg px-2 py-1 text-[10px] font-black ${String(result).toLowerCase() === 'won' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{result}</span></td>
                    <td className="px-4 py-3"><span className="rounded-lg bg-blue-50 px-2 py-1 text-[10px] font-black text-blue-700">{unitRecordProgress(record)}</span></td>
                    <td className="truncate px-4 py-3 text-xs font-black text-slate-700">{unitRecordAssignee(record) || '--'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {tableFooter}
        </>
      )
    }

    return (
      <>
        <table className="w-full min-w-[1120px] table-fixed border-collapse text-left">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[11%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[11%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[8%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-black uppercase text-slate-500">
              <th className="px-4 py-3">{unitDrill.activeTab === 'workorders' ? workOrderSingular : `${leadSingular} / ${opportunitySingular}`}</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Priority & Value</th>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Timeline</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Last Activity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {pagedUnitDrillRows.map((record: any, idx: number) => {
              const value = unitRecordValue(record)
              const status = unitRecordStatus(record)
              return (
                <tr key={`${record._kind}-${record.id || record.lead_id || record.opportunity_ref_id || idx}`} className="transition-colors hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <p className="truncate text-sm font-black text-slate-900">{unitRecordTitle(record)}</p>
                    <p className="mt-0.5 truncate text-[11px] font-semibold text-slate-400">{unitRecordSubtitle(record) || '--'}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="truncate text-xs font-black text-slate-700">{unitRecordSource(record) || '--'}</p>
                    {unitRecordSourceType(record) && <span className="mt-1 inline-flex rounded-lg bg-blue-50 px-2 py-1 text-[9px] font-black text-blue-700">{unitRecordSourceTypeLabel(unitRecordSourceType(record))}</span>}
                  </td>
                  <td className="px-4 py-3">
                    {status ? <span className={`rounded-lg px-2 py-1 text-[10px] font-black ${unitRecordStatusTone(status, record._kind)}`}>{status}</span> : <span className="text-xs font-semibold text-slate-300">--</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-lg bg-amber-50 px-2 py-1 text-[10px] font-black text-orange-700">{unitRecordPriority(record)}</span>
                    <p className="mt-1 text-xs font-black tabular-nums text-slate-950">{value > 0 ? fmtFn(value) : '--'}</p>
                  </td>
                  <td className="truncate px-4 py-3 text-xs font-black text-slate-700">{unitRecordAssignee(record) || '--'}</td>
                  <td className="px-4 py-3 text-xs font-black text-slate-700">{unitRecordDate(record) ? popupDateLabel(unitRecordDate(record)) : '--'}</td>
                  <td className="px-4 py-3">
                    <p className="truncate text-xs font-black text-slate-800">{unitRecordContactName(record) || '--'}</p>
                    <p className="mt-0.5 truncate text-[11px] text-slate-400">{unitRecordContactPhone(record) || '--'}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="truncate text-xs font-black text-slate-700">{unitRecordLastActivityType(record) || '--'}</p>
                    <p className="mt-0.5 truncate text-[11px] text-slate-400">{unitRecordLastActivityDate(record) ? popupDateLabel(unitRecordLastActivityDate(record)) : '--'}</p>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {tableFooter}
      </>
    )
  }

  const MetricPill = ({ value, className, compact = false }: { value: number; className: string; compact?: boolean }) => (
    <span className={`inline-flex justify-center rounded-md font-black tabular-nums ${compact ? 'min-w-[24px] px-1 py-px text-[9.5px]' : 'min-w-[42px] px-1.5 py-0.5 text-[11px]'} ${className}`}>
      {value.toLocaleString('en-IN')}
    </span>
  )
  const metricCountTone = (className: string) => className.split(' ').filter(token => token.startsWith('text-')).join(' ') || 'text-slate-700'
  const MetricValueCell = ({ count, value, className }: { count: number; value: number; className: string }) => (
    <div className="flex min-w-0 items-center justify-center gap-1">
      <span className="min-w-0 truncate text-right text-[12px] font-black leading-4 text-slate-700 tabular-nums">
        {fmtFn(Number(value || 0))}
      </span>
      <span className="h-3 w-px shrink-0 bg-slate-200" />
      <span className={`shrink-0 text-left text-[12px] font-black leading-4 tabular-nums ${metricCountTone(className)}`}>
        {Number(count || 0).toLocaleString('en-IN')}
      </span>
    </div>
  )

  const ColHdr = ({ label, count, color }: { label: string; count: number | null; color: string }) => (
    <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 px-3 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-0.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-[9.5px] font-bold uppercase tracking-widest" style={{ color }}>{label}</span>
      </div>
      {count !== null && <span className="rounded-full bg-white px-1.5 py-0.5 text-[9px] font-bold text-slate-400 shadow-sm ring-1 ring-slate-100">{count}</span>}
    </div>
  )

  const legacyMarkup = false && (
    <div className="rounded-xl border border-slate-100 bg-white shadow-sm">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ backgroundColor: `${accentBar}18` }}>
            <Icon size={13} style={{ color: accentBar }} />
          </div>
          <h3 className="text-[13px] font-bold text-slate-800">{sectionTitle}</h3>
          {subtitle && <span className="text-[11px] text-slate-400">{subtitle}</span>}
        </div>
        {!hasTwoPanel ? (
          /* Customer Segment: Region pill tabs */
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => { setSelectedRegion(null); setSelectedState(null); setSelectedDistrict(null) }}
              className={`rounded-full px-2.5 py-1 text-[10px] font-bold transition-all ${!selectedRegion ? 'bg-blue-600 text-white shadow-sm' : 'bg-white text-slate-500 ring-1 ring-slate-200 hover:ring-blue-200 hover:text-blue-600'}`}
            >All</button>
            {regionRows.map(r => (
              <button key={r.label}
                onClick={() => { setSelectedRegion(r.label); setSelectedState(null); setSelectedDistrict(null) }}
                className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold transition-all ${selectedRegion === r.label ? 'bg-blue-600 text-white shadow-sm' : 'bg-white text-slate-500 ring-1 ring-slate-200 hover:ring-blue-200 hover:text-blue-600'}`}
              >
                <span>{r.label}</span>
                <span className={`tabular-nums text-[9px] ${selectedRegion === r.label ? 'text-blue-200' : 'text-slate-400'}`}>{r.count}</span>
              </button>
            ))}
          </div>
        ) : (
          /* Business Unit: Breadcrumb + tabs */
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 text-[10.5px]">
              <button onClick={() => { setSelectedRegion(null); setSelectedState(null); setSelectedDistrict(null) }}
                className={selectedRegion ? 'font-semibold text-blue-500 hover:text-blue-700 transition-colors' : 'cursor-default font-medium text-slate-400'}>
                Regions
              </button>
              {selectedRegion && (<>
                <ChevronRight size={9} className="text-slate-300" />
                <button onClick={() => { setSelectedState(null); setSelectedDistrict(null) }}
                  className={selectedState ? 'font-semibold text-blue-500 hover:text-blue-700 transition-colors' : 'cursor-default font-bold text-slate-700'}>
                  {selectedRegion}
                </button>
              </>)}
              {selectedState && (<>
                <ChevronRight size={9} className="text-slate-300" />
                <button onClick={() => setSelectedDistrict(null)}
                  className={selectedDistrict ? 'font-semibold text-blue-500 hover:text-blue-700 transition-colors' : 'cursor-default font-bold text-slate-700'}>
                  {selectedState!.label}
                </button>
              </>)}
              {selectedDistrict && (<>
                <ChevronRight size={9} className="text-slate-300" />
                <span className="font-bold text-slate-700">{selectedDistrict!.label}</span>
              </>)}
            </div>
            {tabs.length > 1 && (
              <div className="flex rounded-lg bg-slate-100 p-0.5">
                {tabs.map(tab => {
                  const active = tab.id === activeTab.id
                  return (
                    <button key={tab.id} type="button"
                      onClick={() => { setActiveTabId(tab.id); setSelectedSegment(null) }}
                      className={`rounded-md px-2.5 py-1 text-[10.5px] font-bold transition-all ${active ? 'text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                      style={active ? { backgroundColor: tab.accentBar } : undefined}>
                      {tab.label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Body ── */}
      {!hasTwoPanel ? (
        /* ── Customer Segment Analysis: 3-column table ── */
        <div className="flex divide-x divide-slate-100 overflow-hidden">
          {/* STATE (25%) */}
          <div className="flex w-1/4 shrink-0 flex-col">
            <ColHdr label="State" count={statesForRegion.length} color="#6366f1" />
            <div className={`${MH} overflow-y-auto`}>
              <button
                onClick={() => { setSelectedState(null); setSelectedDistrict(null) }}
                className={`group w-full border-l-2 px-2.5 py-1.5 text-left transition-colors ${!selectedState ? 'border-indigo-500 bg-indigo-50/60' : 'border-transparent hover:bg-slate-50'}`}>
                <div className="flex items-center gap-1">
                  <span className={`flex-1 text-[11px] font-semibold ${!selectedState ? 'text-indigo-700' : 'text-slate-400'}`}>All States</span>
                  <span className={`tabular-nums text-[10px] ${!selectedState ? 'font-bold text-indigo-500' : 'text-slate-300'}`}>
                    {statesForRegion.reduce((s, r) => s + r.count, 0).toLocaleString('en-IN')}
                  </span>
                </div>
              </button>
              {statesForRegion.length === 0 && <p className="px-3 py-3 text-center text-[10px] text-slate-300">No states</p>}
              {statesForRegion.map(row => {
                const sel = selectedState?.label === row.label
                return (
                  <button key={row.key}
                    onClick={() => { setSelectedState({ label: row.label, customers: row.customers }); setSelectedDistrict(null) }}
                    className={`group w-full border-l-2 px-2.5 py-1.5 text-left transition-colors ${sel ? 'border-indigo-500 bg-indigo-50/70' : 'border-transparent hover:bg-slate-50'}`}>
                    <div className="flex items-center gap-1">
                      <span className={`flex-1 truncate text-[11px] font-semibold leading-snug ${sel ? 'text-indigo-700' : 'text-slate-700'}`}>{row.label}</span>
                      <span className={`shrink-0 tabular-nums text-[10px] ${sel ? 'font-bold text-indigo-500' : 'text-slate-400'}`}>{row.count.toLocaleString('en-IN')}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* DISTRICT (25%) */}
          <div className="flex w-1/4 shrink-0 flex-col">
            <ColHdr label="District" count={selectedState ? (districtsForState.length || null) : null} color="#8b5cf6" />
            <div className={`${MH} overflow-y-auto`}>
              {!selectedState ? (
                <div className="flex min-h-[80px] items-center justify-center py-6">
                  <p className="text-[10px] text-slate-300">Select a state</p>
                </div>
              ) : districtsForState.length === 0 ? (
                <div className="flex min-h-[80px] items-center justify-center py-6">
                  <p className="text-[10px] text-slate-300">No district data</p>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => setSelectedDistrict(null)}
                    className={`group w-full border-l-2 px-2.5 py-1.5 text-left transition-colors ${!selectedDistrict ? 'border-violet-500 bg-violet-50/60' : 'border-transparent hover:bg-slate-50'}`}>
                    <div className="flex items-center gap-1">
                      <span className={`flex-1 text-[11px] font-semibold ${!selectedDistrict ? 'text-violet-700' : 'text-slate-400'}`}>All Districts</span>
                      <span className={`tabular-nums text-[10px] ${!selectedDistrict ? 'font-bold text-violet-500' : 'text-slate-300'}`}>{selectedState!.customers.length.toLocaleString('en-IN')}</span>
                    </div>
                  </button>
                  {districtsForState.map(d => {
                    const sel = selectedDistrict?.label === d.label
                    return (
                      <button key={d.label}
                        onClick={() => setSelectedDistrict({ label: d.label, customers: d.customers })}
                        className={`group w-full border-l-2 px-2.5 py-1.5 text-left transition-colors ${sel ? 'border-violet-500 bg-violet-50/70' : 'border-transparent hover:bg-slate-50'}`}>
                        <div className="flex items-center gap-1">
                          <span className={`flex-1 truncate text-[11px] font-semibold leading-snug ${sel ? 'text-violet-700' : 'text-slate-700'}`}>{d.label}</span>
                          <span className={`shrink-0 tabular-nums text-[10px] ${sel ? 'font-bold text-violet-500' : 'text-slate-400'}`}>{d.count.toLocaleString('en-IN')}</span>
                        </div>
                      </button>
                    )
                  })}
                </>
              )}
            </div>
          </div>

          {/* SEGMENT (50%) */}
          <div className="flex min-w-0 flex-1 flex-col">
            <ColHdr label={groupColLabel} count={segmentRows.filter(r => r.count > 0).length} color={activeAccent} />
            <div className={`${MH} divide-y divide-slate-50 overflow-y-auto`}>
              {segmentRows.length === 0 && (
                <p className="px-3 py-4 text-center text-[10px] text-slate-300">No {groupColLabel.toLowerCase()}s</p>
              )}
              {segmentRows.map(g => {
                const ctx = selectedState
                  ? `${selectedState.label}${selectedDistrict ? ' › ' + selectedDistrict.label : ''} — `
                  : selectedRegion ? `${selectedRegion} — ` : ''
                return (
                  <button key={g.label}
                    onClick={() => g.count > 0 ? onViewCustomers(`${ctx}${groupColLabel}: ${g.label}`, g.customers) : undefined}
                    className={`group w-full px-3 py-1.5 text-left transition-colors ${g.count > 0 ? 'cursor-pointer hover:bg-blue-50/50' : 'cursor-default'}`}>
                    <div className="mb-1 flex items-center gap-2">
                      <span className={`flex-1 truncate text-[11px] font-semibold leading-snug ${g.count > 0 ? 'text-slate-800 transition-colors group-hover:text-blue-700' : 'text-slate-400'}`}>{g.label}</span>
                      <span className={`shrink-0 tabular-nums text-[10px] ${g.count > 0 ? 'text-slate-500' : 'text-slate-300'}`}>{g.count} cust</span>
                      <span className={`shrink-0 w-[48px] text-right tabular-nums text-[10px] font-bold ${g.count > 0 ? 'text-slate-700' : 'text-slate-300'}`}>{fmtFn(g.value)}</span>
                    </div>
                    <div className="h-[3px] w-full overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: g.count > 0 ? `${g.pct}%` : '0%', background: activeAccent, opacity: g.count > 0 ? 0.85 : 0 }} />
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      ) : (
        /* ── Business Unit Analysis: Region | State | Verticals | Units ── */
        <div className="flex divide-x divide-slate-100 overflow-hidden">
          {/* REGION */}
          <div className="flex w-[18%] shrink-0 flex-col">
            <ColHdr label="Region" count={regionRows.length} color="#3b82f6" />
            <div className={`${MH} overflow-y-auto`}>
              {regionRows.length === 0 && <p className="px-3 py-4 text-center text-[10px] text-slate-300">No data</p>}
              {regionRows.map(region => {
                const sel = selectedRegion === region.label
                return (
                  <button key={region.label}
                    onClick={() => {
                      setSelectedRegion(region.label)
                      const first = rowsForRegion(region.label)[0]
                      setSelectedState(first ? { label: first.label, customers: first.customers } : null)
                      setSelectedDistrict(null)
                    }}
                    className={`group w-full border-l-2 px-2.5 py-1.5 text-left transition-colors ${sel ? 'border-blue-500 bg-blue-50/70' : 'border-transparent hover:bg-slate-50'}`}>
                    <div className="flex items-center gap-1">
                      <span className={`flex-1 truncate text-[11px] font-semibold leading-snug ${sel ? 'text-blue-700' : 'text-slate-700'}`}>{region.label}</span>
                      {region.count > 0
                        ? <span className={`shrink-0 tabular-nums text-[10px] ${sel ? 'font-bold text-blue-500' : 'text-slate-400'}`}>{region.count.toLocaleString('en-IN')}</span>
                        : <span className="shrink-0 text-[10px] text-slate-300">—</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
          {/* STATE */}
          <div className="flex w-[18%] shrink-0 flex-col">
            <ColHdr label="State" count={selectedRegion ? statesForRegion.length : null} color="#6366f1" />
            <div className={`${MH} overflow-y-auto`}>
              {!selectedRegion && <p className="px-3 py-4 text-center text-[10px] text-slate-300">Select a region</p>}
              {selectedRegion && statesForRegion.length === 0 && <p className="px-3 py-4 text-center text-[10px] text-slate-300">No states</p>}
              {statesForRegion.map(row => {
                const sel = selectedState?.label === row.label
                return (
                  <button key={row.key}
                    onClick={() => { setSelectedState({ label: row.label, customers: row.customers }); setSelectedDistrict(null) }}
                    className={`group w-full border-l-2 px-2.5 py-1.5 text-left transition-colors ${sel ? 'border-indigo-500 bg-indigo-50/70' : 'border-transparent hover:bg-slate-50'}`}>
                    <div className="flex items-center gap-1">
                      <span className={`flex-1 truncate text-[11px] font-semibold leading-snug ${sel ? 'text-indigo-700' : 'text-slate-700'}`}>{row.label}</span>
                      <span className={`shrink-0 tabular-nums text-[10px] ${sel ? 'font-bold text-indigo-500' : 'text-slate-400'}`}>{row.count.toLocaleString('en-IN')}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
          {/* DISTRICT */}
          <div className="flex w-[18%] shrink-0 flex-col">
            <ColHdr label="District" count={selectedState ? (districtsForState.length || null) : null} color="#8b5cf6" />
            <div className={`${MH} overflow-y-auto`}>
              {!selectedState && <p className="px-3 py-4 text-center text-[10px] text-slate-300">Select a state</p>}
              {selectedState && districtsForState.length === 0 && <p className="px-3 py-4 text-center text-[10px] text-slate-300">No districts</p>}
              {selectedState && districtsForState.length > 0 && (
                <>
                  <button
                    onClick={() => setSelectedDistrict(null)}
                    className={`group w-full border-l-2 px-2.5 py-1.5 text-left transition-colors ${!selectedDistrict ? 'border-violet-500 bg-violet-50/60' : 'border-transparent hover:bg-slate-50'}`}>
                    <div className="flex items-center gap-1">
                      <span className={`flex-1 truncate text-[11px] font-semibold leading-snug ${!selectedDistrict ? 'text-violet-700' : 'text-slate-400'}`}>All Districts</span>
                      <span className={`shrink-0 tabular-nums text-[10px] ${!selectedDistrict ? 'font-bold text-violet-500' : 'text-slate-300'}`}>{selectedState!.customers.length.toLocaleString('en-IN')}</span>
                    </div>
                  </button>
                  {districtsForState.map(d => {
                    const sel = selectedDistrict?.label === d.label
                    return (
                      <button key={d.label}
                        onClick={() => setSelectedDistrict({ label: d.label, customers: d.customers })}
                        className={`group w-full border-l-2 px-2.5 py-1.5 text-left transition-colors ${sel ? 'border-violet-500 bg-violet-50/70' : 'border-transparent hover:bg-slate-50'}`}>
                        <div className="flex items-center gap-1">
                          <span className={`flex-1 truncate text-[11px] font-semibold leading-snug ${sel ? 'text-violet-700' : 'text-slate-700'}`}>{d.label}</span>
                          <span className={`shrink-0 tabular-nums text-[10px] ${sel ? 'font-bold text-violet-500' : 'text-slate-400'}`}>{d.count.toLocaleString('en-IN')}</span>
                        </div>
                      </button>
                    )
                  })}
                </>
              )}
            </div>
          </div>
          {/* VERTICALS + UNITS */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-w-0 flex-1 divide-x divide-slate-100">
              <div className="flex w-2/5 shrink-0 flex-col">
                <ColHdr label={`${groupColLabel}s`} count={segmentRows.length} color={activeAccent} />
                <div className={`${MH} overflow-y-auto`}>
                  {segmentRows.length === 0 && (
                    <p className="px-3 py-4 text-center text-[10px] text-slate-300">{selectedState ? `No ${groupColLabel.toLowerCase()}s` : 'Select a state'}</p>
                  )}
                  {segmentRows.map(seg => {
                    const sel = selectedSegment?.label === seg.label
                    const unitCount = masterVerticalUnits?.get(seg.label)?.length ?? 0
                    return (
                      <button key={seg.label}
                        onClick={() => setSelectedSegment({ label: seg.label, customers: seg.customers })}
                        className={`group flex w-full items-center gap-2 border-l-2 px-2.5 py-1.5 text-left transition-colors cursor-pointer ${sel ? 'border-violet-500 bg-violet-50/60' : 'border-transparent hover:bg-slate-50'}`}>
                        <span className={`flex-1 truncate text-[11px] font-semibold leading-snug ${sel ? 'text-violet-700' : 'text-slate-700'}`}>{seg.label}</span>
                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold tabular-nums ${sel ? 'bg-violet-100 text-violet-600' : 'bg-slate-100 text-slate-500'}`}>{unitCount}</span>
                        <ChevronRight size={9} className={`shrink-0 ${sel ? 'text-violet-400' : 'text-slate-200 group-hover:text-slate-400'}`} />
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                {selectedSegment ? (
                  <>
                    <div className="flex items-center gap-2 border-b border-slate-100 bg-violet-50/40 px-3 py-1.5">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                      <span className="truncate text-[10.5px] font-bold text-violet-700">{selectedSegment!.label}</span>
                      <span className="shrink-0 text-[9.5px] text-slate-400">{unitRows.length} units</span>
                    </div>
                    <div className={`${MH} divide-y divide-slate-50 overflow-y-auto`}>
                      {unitRows.map(unit => {
                        const pipelineTotal = Number(unit.lead_count || 0) + Number(unit.opportunity_count || 0) + Number(unit.tender_count || 0) + Number(unit.work_order_count || 0)
                        const hasData = unit.count > 0 || pipelineTotal > 0
                        const unitMetrics: Array<{label:string;value:number;cls:string}> = [
                          { label: 'L', value: Number(unit.lead_count || 0), cls: 'text-blue-600 bg-blue-50' },
                          { label: 'O', value: Number(unit.opportunity_count || 0), cls: 'text-cyan-600 bg-cyan-50' },
                          { label: 'T', value: Number(unit.tender_count || 0), cls: 'text-orange-600 bg-orange-50' },
                          { label: 'WO', value: Number(unit.work_order_count || 0), cls: 'text-emerald-600 bg-emerald-50' },
                        ]
                        return (
                          <div key={unit.label}
                            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left">
                            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[9px] font-bold ${hasData ? 'bg-violet-50 text-violet-500' : 'bg-slate-50 text-slate-300'}`}>{unit.label[0]?.toUpperCase()}</span>
                            <span className={`flex-1 truncate text-[11px] font-medium leading-snug ${hasData ? 'text-slate-700' : 'text-slate-400'}`}>{unit.label}</span>
                            <div className="flex shrink-0 items-center gap-1">
                              {unitMetrics.map(metric => (
                                <span key={metric.label} className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold tabular-nums ${metric.value > 0 ? metric.cls : 'bg-slate-50 text-slate-300'}`}>
                                  {metric.label} {metric.value}
                                </span>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                      {unitRows.length === 0 && <p className="px-3 py-4 text-center text-[10px] text-slate-300">No units</p>}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-1 items-center justify-center">
                    <p className="text-[10px] text-slate-300">Select a {groupColLabel.toLowerCase()}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  void legacyMarkup

  return (
    <>
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${accentBar}14` }}>
            <Icon size={16} style={{ color: accentBar }} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[14px] font-black leading-tight text-slate-950">{sectionTitle}</h3>
            {subtitleText && (
              <p className="mt-0.5 truncate text-[10.5px] font-semibold text-slate-500">
                {subtitleText}
              </p>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] font-black leading-none">
              <button type="button" onClick={openRegionSelector} className="text-blue-700 transition-colors hover:text-blue-900 hover:underline">
                All Regions
              </button>
              <span className="text-slate-300">/</span>
              <button type="button" onClick={openStateSelector} className="text-indigo-700 transition-colors hover:text-indigo-900 hover:underline">
                All States
              </button>
              <span className="text-slate-300">/</span>
              <button
                type="button"
                onClick={selectedState ? openDistrictSelector : openStateSelector}
                className={`transition-colors hover:underline ${selectedState ? 'text-violet-700 hover:text-violet-900' : 'text-slate-400 hover:text-indigo-700'}`}
              >
                All Districts
              </button>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {false && <label className="relative">
            <select
              value={activeFiscalYear}
              onChange={e => onFiscalYearChange?.(Number(e.target.value))}
              className="h-9 w-[132px] appearance-none rounded-lg border border-slate-200 bg-white px-4 pr-9 text-[13px] font-black text-violet-700 shadow-sm outline-none transition-colors hover:border-violet-200 focus:border-violet-300"
            >
              {availableFiscalYears.map(year => (
                <option key={year} value={year}>{fiscalYearLabel(year)}</option>
              ))}
            </select>
            <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-violet-600" />
          </label>}
          <KAMPermGate perm="canExport"><button
            type="button"
            onClick={downloadCsv}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-[12px] font-black text-slate-800 shadow-sm transition-colors hover:border-violet-200 hover:bg-violet-50"
          >
            <Download size={13} className="text-slate-700" />
            Export
          </button></KAMPermGate>
        </div>
      </div>

      <div className={`grid gap-2 p-2 ${selectorLayoutClass}`}>
        {showSelectorCard && selectorCard}

        <div className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white">
          {!hasTwoPanel ? (
            <>
              <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50/60 px-3 py-2">
                <h4 className="truncate text-[13.5px] font-black text-slate-950">{customerLabel} Segments ({resultContext})</h4>
                <span className="inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-md bg-violet-50 px-1.5 text-[11px] font-black text-violet-700 ring-1 ring-violet-100">{segmentRows.length}</span>
              </div>
              <div className="overflow-hidden">
                <table className="w-full table-fixed border-collapse text-left">
                  <colgroup>
                    <col className="w-[22%]" />
                    <col className="w-[16%]" />
                    <col className="w-[15%]" />
                    <col className="w-[17%]" />
                    <col className="w-[14%]" />
                    <col className="w-[16%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-black uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2.5">Segment / Sub-segment</th>
                      <th className="px-1 py-2.5 text-center">{customerLabel}</th>
                      <th className="px-1 py-2.5 text-center">{leadLabel}</th>
                      <th className="px-1 py-2.5 text-center">{opportunityLabel}</th>
                      <th className="px-1 py-2.5 text-center">{tenderLabel}</th>
                      <th className="px-1 py-2.5 text-center">{workOrderLabel}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customerSegmentGroups.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-8 text-center text-[13px] font-semibold text-slate-400">No segment data</td></tr>
                    )}
                    {customerSegmentGroups.map((group, idx) => {
                      const row = group.segment
                      const tone = idx % 5 === 0
                        ? { badge: 'bg-violet-50 text-violet-700 ring-violet-100', total: 'bg-violet-50/70 text-violet-700' }
                        : idx % 5 === 1
                          ? { badge: 'bg-blue-50 text-blue-700 ring-blue-100', total: 'bg-blue-50/70 text-blue-700' }
                          : idx % 5 === 2
                            ? { badge: 'bg-emerald-50 text-emerald-700 ring-emerald-100', total: 'bg-emerald-50/70 text-emerald-700' }
                            : idx % 5 === 3
                              ? { badge: 'bg-orange-50 text-orange-700 ring-orange-100', total: 'bg-orange-50/70 text-orange-700' }
                              : { badge: 'bg-pink-50 text-pink-700 ring-pink-100', total: 'bg-pink-50/70 text-pink-700' }
                      const hasCustomers = Number(row.count || 0) > 0
                      const rawDisplayTotals = displayedCustomerSegmentTotals(group)
                      const subSegmentKey = group.subSegmentKey
                      const visibleSubSegmentRows = (group.subRows || []).map((subSegment: any) => ({
                        ...subSegment,
                        metrics: recordMetricsForCustomers(subSegment.customers || []) || subSegment.metrics || customerPipelineMetrics(subSegment.customers || []),
                      }))
                      const displayTotals = rawDisplayTotals
                      const subSegmentExpandable = hasCustomers
                      const expanded = subSegmentExpandable && expandedSegmentSubSegmentKeys.has(subSegmentKey)
                      const openSegmentMetric = (event: React.MouseEvent, kind: UnitRecordKind) => {
                        event.stopPropagation()
                        if (hasCustomers) openSegmentPopup(group, kind)
                      }
                      const openSubSegmentMetric = (event: React.MouseEvent, subSegment: any, kind: UnitRecordKind) => {
                        event.stopPropagation()
                        if (Number(subSegment.count || 0) > 0 || groupedCustomerCount(subSegment) > 0) openSegmentSubSegmentPopup(group, subSegment, kind)
                      }
                      const segmentCellContent = (
                        <div className="flex min-w-0 items-start gap-2">
                          <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-black ring-1 ${tone.badge}`}>
                            {row.label.charAt(0).toUpperCase()}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center">
                              <div className="truncate text-[12.5px] font-black leading-5 text-slate-950">{row.label}</div>
                            </div>
                          </div>
                        </div>
                      )
                      const subSegmentMessage = 'No mapped sub-segments for this segment'
                      return (
                        <Fragment key={row.label}>
                          <tr
                            key={row.label}
                            onClick={() => hasCustomers && openSegmentPopup(group)}
                            className={`border-b border-slate-200 bg-white transition-colors ${hasCustomers ? 'cursor-pointer hover:bg-violet-50/40' : 'text-slate-400'}`}
                          >
                            <td className="px-3 py-2.5">
                              <div className="flex min-w-0 items-center gap-1">
                                <div className="min-w-0 flex-1">
                                  {segmentCellContent}
                                </div>
                              {subSegmentExpandable && (
                                <button
                                  type="button"
                                  aria-expanded={expanded}
                                  aria-label={`${expanded ? 'Hide' : 'Show'} sub-segments for ${row.label}`}
                                  onClick={event => {
                                    event.stopPropagation()
                                    toggleSegmentSubSegmentBreakdown(group)
                                  }}
                                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-blue-700 outline-none transition hover:bg-blue-50 hover:text-blue-800 focus:outline-none focus-visible:bg-blue-50 focus-visible:ring-0"
                                  title={expanded ? 'Hide sub-segments' : 'Show sub-segments'}
                                >
                                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                </button>
                              )}
                              </div>
                            </td>
                            <td onClick={event => openSegmentMetric(event, 'customers')} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={Number(displayTotals.customers || 0)} value={Number(displayTotals.value || 0)} className="bg-slate-100 text-slate-700" /></td>
                            <td onClick={event => openSegmentMetric(event, 'leads')} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={Number(displayTotals.leads || 0)} value={Number(displayTotals.leadValue || 0)} className="bg-violet-50 text-violet-700" /></td>
                            <td onClick={event => openSegmentMetric(event, 'opportunities')} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={Number(displayTotals.opportunities || 0)} value={Number(displayTotals.opportunityValue || 0)} className="bg-blue-50 text-blue-700" /></td>
                            <td onClick={event => openSegmentMetric(event, 'tenders')} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={Number(displayTotals.tenders || 0)} value={Number(displayTotals.tenderValue || 0)} className="bg-orange-50 text-orange-700" /></td>
                            <td onClick={event => openSegmentMetric(event, 'workorders')} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={Number(displayTotals.workOrders || 0)} value={Number(displayTotals.workOrderValue || 0)} className="bg-emerald-50 text-emerald-700" /></td>
                          </tr>
                          {expanded && (visibleSubSegmentRows.length > 0 ? visibleSubSegmentRows.map((subSegment: any) => {
                            const subMetrics = subSegment.metrics || customerPipelineMetrics(subSegment.customers || [])
                            const canOpenSubSegment = Number(subSegment.count || 0) > 0 || groupedCustomerCount(subSegment) > 0
                            return (
                            <tr
                              key={`${row.label}-${subSegment.label}`}
                              onClick={event => {
                                event.stopPropagation()
                                if (canOpenSubSegment) openSegmentSubSegmentPopup(group, subSegment)
                              }}
                              className={`${canOpenSubSegment ? 'cursor-pointer hover:bg-violet-50/40' : 'text-slate-400'} border-b border-slate-200 bg-slate-50/30 transition-colors`}
                            >
                              <td className="px-3 py-2">
                                <div className="flex min-w-0 items-center">
                                  <div className="min-w-0 truncate text-[12px] font-medium leading-5 text-slate-700">{subSegment.label}</div>
                                </div>
                              </td>
                              <td onClick={event => openSubSegmentMetric(event, subSegment, 'customers')} className="cursor-pointer px-1 py-2 text-center"><MetricValueCell count={groupedCustomerCount(subSegment)} value={Number(subSegment.value || 0)} className="bg-slate-100 text-slate-700" /></td>
                              <td onClick={event => openSubSegmentMetric(event, subSegment, 'leads')} className="cursor-pointer px-1 py-2 text-center"><MetricValueCell count={Number(subMetrics.leads || 0)} value={Number(subMetrics.leadValue || 0)} className="bg-violet-50 text-violet-700" /></td>
                              <td onClick={event => openSubSegmentMetric(event, subSegment, 'opportunities')} className="cursor-pointer px-1 py-2 text-center"><MetricValueCell count={Number(subMetrics.opportunities || 0)} value={Number(subMetrics.opportunityValue || 0)} className="bg-blue-50 text-blue-700" /></td>
                              <td onClick={event => openSubSegmentMetric(event, subSegment, 'tenders')} className="cursor-pointer px-1 py-2 text-center"><MetricValueCell count={Number(subMetrics.tenders || 0)} value={Number(subMetrics.tenderValue || 0)} className="bg-orange-50 text-orange-700" /></td>
                              <td onClick={event => openSubSegmentMetric(event, subSegment, 'workorders')} className="cursor-pointer px-1 py-2 text-center"><MetricValueCell count={Number(subMetrics.workOrders || 0)} value={Number(subMetrics.workOrderValue || 0)} className="bg-emerald-50 text-emerald-700" /></td>
                            </tr>
                            )
                          }) : (
                            <tr className="border-b border-slate-200 bg-slate-50/30">
                              <td colSpan={6} className="px-3 py-4 text-center text-[12.5px] font-semibold text-slate-400">{subSegmentMessage}</td>
                            </tr>
                          ))}
                        </Fragment>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr
                      onClick={() => openCustomerGrandTotalPopup()}
                      className="cursor-pointer bg-violet-50/70 text-[12.5px] font-black text-violet-700 transition hover:brightness-[0.98]"
                    >
                      <td className="px-3 py-2.5">
                        Total
                      </td>
                      <td onClick={event => { event.stopPropagation(); openCustomerGrandTotalPopup('customers') }} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={customerTotal.count} value={customerTotal.value} className="bg-white/80 text-violet-700" /></td>
                      <td onClick={event => { event.stopPropagation(); openCustomerGrandTotalPopup('leads') }} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={displayedCustomerSegmentPipelineTotal.leads} value={displayedCustomerSegmentPipelineTotal.leadValue} className="bg-violet-50/80 text-violet-700" /></td>
                      <td onClick={event => { event.stopPropagation(); openCustomerGrandTotalPopup('opportunities') }} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={displayedCustomerSegmentPipelineTotal.opportunities} value={displayedCustomerSegmentPipelineTotal.opportunityValue} className="bg-blue-50/80 text-blue-700" /></td>
                      <td onClick={event => { event.stopPropagation(); openCustomerGrandTotalPopup('tenders') }} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={displayedCustomerSegmentPipelineTotal.tenders} value={displayedCustomerSegmentPipelineTotal.tenderValue} className="bg-orange-50/80 text-orange-700" /></td>
                      <td onClick={event => { event.stopPropagation(); openCustomerGrandTotalPopup('workorders') }} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={displayedCustomerSegmentPipelineTotal.workOrders} value={displayedCustomerSegmentPipelineTotal.workOrderValue} className="bg-emerald-50/80 text-emerald-700" /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
                <h4 className="truncate text-[13.5px] font-black text-slate-950">Business Verticals ({resultContext})</h4>
                <span className="inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-md bg-violet-50 px-1.5 text-[11px] font-black text-violet-700 ring-1 ring-violet-100">{businessVerticalRows.length}</span>
              </div>
              <div className="overflow-hidden">
                <table className="w-full table-fixed border-collapse text-left">
                  <colgroup>
                    <col className="w-[40%]" />
                    <col className="w-[14%]" />
                    <col className="w-[17%]" />
                    <col className="w-[14%]" />
                    <col className="w-[15%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-black uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2.5">Vertical / Unit</th>
                      <th className="px-1 py-2.5 text-center">{leadLabel}</th>
                      <th className="px-1 py-2.5 text-center">{opportunityLabel}</th>
                      <th className="px-1 py-2.5 text-center">{tenderLabel}</th>
                      <th className="px-1 py-2.5 text-center">{workOrderLabel}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {businessVerticalGroups.length === 0 && (
                      <tr><td colSpan={5} className="px-3 py-8 text-center text-[13px] font-semibold text-slate-400">No business vertical data</td></tr>
                    )}
                    {businessVerticalGroups.map((group, idx) => {
                      const row = group.vertical
                      const verticalMetrics = customerPipelineMetrics(row.customers || [])
                      const verticalMetricValues = {
                        leadValue: Number(row.leadValue || row.lead_value || verticalMetrics.leadValue || 0),
                        opportunityValue: Number(row.opportunityValue || row.opportunity_value || verticalMetrics.opportunityValue || 0),
                        tenderValue: Number(row.tenderValue || row.tender_value || verticalMetrics.tenderValue || 0),
                        workOrderValue: Number(row.workOrderValue || row.work_order_value || row.wo_value || verticalMetrics.workOrderValue || 0),
                      }
                      const tone = idx % 5 === 0
                        ? { badge: 'bg-violet-50 text-violet-700 ring-violet-100', total: 'bg-violet-50/70 text-violet-700', verticalBg: 'bg-violet-50/35' }
                        : idx % 5 === 1
                          ? { badge: 'bg-blue-50 text-blue-700 ring-blue-100', total: 'bg-blue-50/70 text-blue-700', verticalBg: 'bg-blue-50/35' }
                          : idx % 5 === 2
                            ? { badge: 'bg-emerald-50 text-emerald-700 ring-emerald-100', total: 'bg-emerald-50/70 text-emerald-700', verticalBg: 'bg-emerald-50/35' }
                            : idx % 5 === 3
                              ? { badge: 'bg-orange-50 text-orange-700 ring-orange-100', total: 'bg-orange-50/70 text-orange-700', verticalBg: 'bg-orange-50/35' }
                              : { badge: 'bg-pink-50 text-pink-700 ring-pink-100', total: 'bg-pink-50/70 text-pink-700', verticalBg: 'bg-pink-50/35' }
                      const verticalKey = canonicalGroupKey(row.label)
                      const expanded = expandedBusinessVerticalKeys.has(verticalKey)
                      const openVerticalMetric = (event: React.MouseEvent, kind: UnitRecordKind) => {
                        event.stopPropagation()
                        openVerticalPopup(row, kind)
                      }
                      const openUnitMetric = (event: React.MouseEvent, unit: any, kind: UnitRecordKind) => {
                        event.stopPropagation()
                        openUnitDetailPopup(row, unit, kind)
                      }
                      const toggleVertical = () => {
                        setExpandedBusinessVerticalKeys(prev => {
                          const next = new Set(prev)
                          if (next.has(verticalKey)) next.delete(verticalKey)
                          else next.add(verticalKey)
                          return next
                        })
                      }
                      const verticalCellContent = (
                        <div className="flex min-w-0 items-start gap-2">
                          <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-black ring-1 ${tone.badge}`}>
                            {row.label.charAt(0).toUpperCase()}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center">
                              <div className="min-w-0 truncate text-[12.5px] font-black leading-5 text-slate-950" title={row.label}>{row.label}</div>
                            </div>
                          </div>
                        </div>
                      )
                      return (
                        <Fragment key={row.label}>
                          <tr
                            key={row.label}
                            onClick={() => openVerticalPopup(row)}
                            className="cursor-pointer border-b border-slate-200 bg-white transition-colors hover:bg-violet-50/40"
                          >
                            <td className="px-3 py-2.5">
                              <div className="flex min-w-0 items-start gap-1">
                                <div className="min-w-0 flex-1">
                                  {verticalCellContent}
                                </div>
                                <button
                                  type="button"
                                  aria-expanded={expanded}
                                  aria-label={`${expanded ? 'Hide' : 'Show'} units for ${row.label}`}
                                  onClick={event => {
                                    event.stopPropagation()
                                    toggleVertical()
                                  }}
                                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-blue-700 outline-none transition hover:bg-blue-50 hover:text-blue-800 focus:outline-none focus-visible:bg-blue-50 focus-visible:ring-0"
                                  title={expanded ? 'Hide units' : 'Show units'}
                                >
                                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                </button>
                              </div>
                            </td>
                            <td onClick={event => openVerticalMetric(event, 'leads')} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={Number(row.leads || 0)} value={verticalMetricValues.leadValue} className="bg-violet-50 text-violet-700" /></td>
                            <td onClick={event => openVerticalMetric(event, 'opportunities')} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={Number(row.opportunities || 0)} value={verticalMetricValues.opportunityValue} className="bg-blue-50 text-blue-700" /></td>
                            <td onClick={event => openVerticalMetric(event, 'tenders')} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={Number(row.tenders || 0)} value={verticalMetricValues.tenderValue} className="bg-orange-50 text-orange-700" /></td>
                            <td onClick={event => openVerticalMetric(event, 'workorders')} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={Number(row.workOrders || 0)} value={verticalMetricValues.workOrderValue} className="bg-emerald-50 text-emerald-700" /></td>
                          </tr>
                          {expanded && group.unitRows.map((unit: any) => {
                            const unitHasCustomers = groupedCustomerCount(unit) > 0
                            return (
                              <tr
                                key={`${row.label}-${unit.label}`}
                                onClick={event => {
                                  event.stopPropagation()
                                  openUnitDetailPopup(row, unit)
                                }}
                                className={`cursor-pointer border-b border-slate-200 bg-slate-50/30 transition-colors hover:bg-violet-50/40 ${!unitHasCustomers ? 'text-slate-400' : ''}`}
                              >
                                <td className="px-3 py-2">
                                  <div className="flex min-w-0 items-center">
                                    <div className="min-w-0 truncate text-[12px] font-medium leading-5 text-slate-700" title={unit.label}>{unit.label}</div>
                                  </div>
                                </td>
                                <td onClick={event => openUnitMetric(event, unit, 'leads')} className="cursor-pointer px-1 py-2 text-center"><MetricValueCell count={Number(unit.leads || 0)} value={Number(unit.leadValue || 0)} className="bg-violet-50 text-violet-700" /></td>
                                <td onClick={event => openUnitMetric(event, unit, 'opportunities')} className="cursor-pointer px-1 py-2 text-center"><MetricValueCell count={Number(unit.opportunities || 0)} value={Number(unit.opportunityValue || 0)} className="bg-blue-50 text-blue-700" /></td>
                                <td onClick={event => openUnitMetric(event, unit, 'tenders')} className="cursor-pointer px-1 py-2 text-center"><MetricValueCell count={Number(unit.tenders || 0)} value={Number(unit.tenderValue || 0)} className="bg-orange-50 text-orange-700" /></td>
                                <td onClick={event => openUnitMetric(event, unit, 'workorders')} className="cursor-pointer px-1 py-2 text-center"><MetricValueCell count={Number(unit.workOrders || 0)} value={Number(unit.workOrderValue || 0)} className="bg-emerald-50 text-emerald-700" /></td>
                              </tr>
                            )
                          })}
                        </Fragment>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr
                      onClick={() => openBusinessGrandTotalPopup()}
                      className="cursor-pointer bg-violet-50/70 text-[12.5px] font-black text-violet-700 transition hover:brightness-[0.98]"
                    >
                      <td className="px-3 py-2.5">Total</td>
                      <td onClick={event => { event.stopPropagation(); openBusinessGrandTotalPopup('leads') }} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={businessTotal.leads} value={businessTotal.leadValue} className="bg-violet-50/80 text-violet-700" /></td>
                      <td onClick={event => { event.stopPropagation(); openBusinessGrandTotalPopup('opportunities') }} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={businessTotal.opportunities} value={businessTotal.opportunityValue} className="bg-blue-50/80 text-blue-700" /></td>
                      <td onClick={event => { event.stopPropagation(); openBusinessGrandTotalPopup('tenders') }} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={businessTotal.tenders} value={businessTotal.tenderValue} className="bg-orange-50/80 text-orange-700" /></td>
                      <td onClick={event => { event.stopPropagation(); openBusinessGrandTotalPopup('workorders') }} className="cursor-pointer px-1 py-2.5 text-center"><MetricValueCell count={businessTotal.workOrders} value={businessTotal.workOrderValue} className="bg-emerald-50/80 text-emerald-700" /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
    {false && subSegmentBreakdown && createPortal(
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 px-4 backdrop-blur-sm">
        <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4">
            <div className="min-w-0">
              <h3 className="truncate text-base font-black text-slate-950">{subSegmentBreakdown!.segmentLabel} Sub-segments</h3>
              <p className="mt-0.5 text-xs font-semibold text-slate-500">{resultContext} - from {customerLabel} Segments master</p>
            </div>
            <button type="button" onClick={() => setSubSegmentBreakdown(null)} className="rounded-lg p-2 text-slate-400 transition hover:bg-white hover:text-slate-700">
              <X size={18} />
            </button>
          </div>
          <div className="overflow-auto">
            <table className="w-full min-w-[560px] table-fixed border-collapse text-left">
              <colgroup>
                <col className="w-[58%]" />
                <col className="w-[18%]" />
                <col className="w-[24%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-white text-[11px] font-black text-slate-500">
                  <th className="px-4 py-3">Sub-segment</th>
                  <th className="px-3 py-3 text-right">{customerSingular} Count</th>
                  <th className="px-4 py-3 text-right">Potential Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {subSegmentBreakdown!.rows.length === 0 && (
                  <tr><td colSpan={3} className="px-4 py-10 text-center text-sm font-semibold text-slate-400">No sub-segments found for this segment</td></tr>
                )}
                {subSegmentBreakdown!.rows.map((sub: any, idx: number) => {
                  const hasData = Number(sub.count || 0) > 0
                  return (
                    <tr
                      key={`${sub.label}-${idx}`}
                      className={`transition-colors ${!hasData ? 'text-slate-400' : ''}`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-black ${idx % 5 === 0 ? 'bg-violet-100 text-violet-700' : idx % 5 === 1 ? 'bg-blue-100 text-blue-700' : idx % 5 === 2 ? 'bg-emerald-100 text-emerald-700' : idx % 5 === 3 ? 'bg-orange-100 text-orange-700' : 'bg-pink-100 text-pink-700'}`}>
                            {sub.label.charAt(0).toUpperCase()}
                          </span>
                          <span className="truncate text-sm font-black text-slate-900">{sub.label}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right text-sm font-black tabular-nums text-slate-700">{Number(sub.count || 0).toLocaleString('en-IN')}</td>
                      <td className="truncate px-4 py-3 text-right text-sm font-black tabular-nums text-slate-950">{fmtFn(Number(sub.value || 0))}</td>
                    </tr>
                  )
                })}
              </tbody>
                  <tfoot className="hidden">
                    <tr className="border-t border-violet-100 bg-violet-50/70 text-sm font-black text-violet-700">
                      <td className="px-4 py-3">Total</td>
                  <td className="px-3 py-3 text-right">{subSegmentBreakdown!.rows.reduce((sum: number, row: any) => sum + Number(row.count || 0), 0).toLocaleString('en-IN')}</td>
                  <td className="truncate px-4 py-3 text-right">{fmtFn(subSegmentBreakdown!.rows.reduce((sum: number, row: any) => sum + Number(row.value || 0), 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>,
      document.body
    )}
    {unitBreakdown && unitPopupOpen && createPortal(
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/45 px-4 py-5 backdrop-blur-sm">
        <div className={`flex flex-col overflow-hidden border border-slate-200 bg-white shadow-2xl transition-all ${
          unitPopupMaximized
            ? 'h-[94vh] w-[calc(100vw-32px)] max-w-none rounded-xl'
            : 'max-h-[88vh] w-full max-w-7xl rounded-2xl'
        }`}>

          {selectedUnit ? (
            /* ── Unit drill-down view ── */
            <>
              <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-base font-black text-slate-950">{selectedUnit.label}</h3>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">{selectedUnit.verticalLabel} - pipeline details</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button type="button" onClick={() => setUnitPopupMaximized(value => !value)} className="rounded-lg p-2 text-slate-400 transition hover:bg-white hover:text-slate-700" title={unitPopupMaximized ? 'Restore' : 'Maximize'}>
                    {unitPopupMaximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                  </button>
                  <button type="button" onClick={closeUnitPopup} className="rounded-lg p-2 text-slate-400 transition hover:bg-white hover:text-slate-700">
                    <X size={18} />
                  </button>
                </div>
              </div>
              <div className="border-b border-slate-100 bg-white px-5 py-3">
                <div className="flex items-start overflow-x-auto pb-1">
                    {visibleUnitDrillTabs.map((tab, tabIdx) => {
                    const active = unitDrill?.activeTab === tab.key
                    const TabIcon = tab.icon
                    return (
                      <Fragment key={tab.key}>
                        <button type="button" onClick={() => unitDrill && loadUnitDrillTab(unitDrill, tab.key)} className="group flex min-w-[138px] flex-1 flex-col items-center text-center outline-none">
                          <span className={`flex h-10 w-10 items-center justify-center rounded-full border-[3px] shadow-lg transition ${active ? tab.activeTone : `border-slate-200 bg-white ${tab.tone} shadow-transparent group-hover:border-blue-100`}`}>
                            <TabIcon size={16} />
                          </span>
                          <span className={`mt-1.5 text-xs font-black ${active ? 'text-blue-700' : 'text-slate-400 group-hover:text-slate-700'}`}>{tab.label}</span>
                          <span className={`mt-0.5 text-[9.5px] font-black ${active ? 'text-blue-600' : 'text-slate-300'}`}>{displayedUnitDrillCount(selectedUnit, tab.key, tab.count(selectedUnit)).toLocaleString('en-IN')} records</span>
                        </button>
                        {tabIdx !== visibleUnitDrillTabs.length - 1 && <div className="mt-[19px] h-0.5 min-w-[44px] flex-1 rounded-full bg-slate-200" />}
                      </Fragment>
                    )
                  })}
                </div>
              </div>
              {renderUnitDrillToolbar()}
              <div className={`${unitPopupMaximized ? 'max-h-[calc(94vh-198px)]' : 'max-h-[520px]'} overflow-auto`}>
                {renderUnitDrillTable()}
              </div>
            </>
          ) : (
            (() => {
              const rows = unitBreakdown.rows || []
              const totals = rows.reduce((sum: any, unit: any) => ({
                leads: sum.leads + Number(unit.leads || 0),
                opportunities: sum.opportunities + Number(unit.opportunities || 0),
                tenders: sum.tenders + Number(unit.tenders || 0),
                workOrders: sum.workOrders + Number(unit.workOrders || 0),
                value: sum.value + Number(unit.value || 0),
              }), { leads: 0, opportunities: 0, tenders: 0, workOrders: 0, value: 0 })
              const popupTabs = [
                { key: 'leads' as const, label: leadLabel, sub: `${customerLabel}, contact, dates`, count: totals.leads, icon: UserCircle, activeTone: 'bg-blue-600 border-blue-600 text-white shadow-blue-100', tone: 'text-slate-400' },
                { key: 'opportunities' as const, label: opportunityLabel, sub: 'Products, OEMs', count: totals.opportunities, icon: Star, activeTone: 'bg-blue-600 border-blue-600 text-white shadow-blue-100', tone: 'text-slate-400' },
                { key: 'tenders' as const, label: tenderLabel, sub: 'Bids, approval', count: totals.tenders, icon: FileText, activeTone: 'bg-blue-600 border-blue-600 text-white shadow-blue-100', tone: 'text-slate-400' },
                { key: 'workorders' as const, label: workOrderLabel, sub: 'PO, delivery, value', count: totals.workOrders, icon: Package, activeTone: 'bg-blue-600 border-blue-600 text-white shadow-blue-100', tone: 'text-slate-400' },
              ]
              return (
                <>
                  <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-base font-black text-slate-950">{unitBreakdown.verticalLabel}</h3>
                      <p className="mt-0.5 text-xs font-semibold text-slate-500">{resultContext} - vertical details by unit</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button type="button" onClick={() => setUnitPopupMaximized(value => !value)} className="rounded-lg p-2 text-slate-400 transition hover:bg-white hover:text-slate-700" title={unitPopupMaximized ? 'Restore' : 'Maximize'}>
                        {unitPopupMaximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                      </button>
                      <button type="button" onClick={closeUnitPopup} className="rounded-lg p-2 text-slate-400 transition hover:bg-white hover:text-slate-700">
                        <X size={18} />
                      </button>
                    </div>
                  </div>
                  <div className="border-b border-slate-100 bg-white px-5 py-3">
                    <div className="flex items-start overflow-x-auto pb-1">
                      {popupTabs.map((tab, tabIdx) => {
                        const active = (unitDrill?.activeTab || verticalPopupTab) === tab.key
                        const TabIcon = tab.icon
                        return (
                          <Fragment key={tab.key}>
                            <button
                              type="button"
                              onClick={() => {
                                setVerticalPopupTab(tab.key)
                                if (unitDrill) loadUnitDrillTab(unitDrill, tab.key)
                              }}
                              className="group flex min-w-[138px] flex-1 flex-col items-center text-center outline-none"
                            >
                              <span className={`flex h-10 w-10 items-center justify-center rounded-full border-[3px] shadow-lg transition ${
                                active ? tab.activeTone : `border-slate-200 bg-white ${tab.tone} shadow-transparent group-hover:border-blue-100`
                              }`}>
                                <TabIcon size={16} />
                              </span>
                              <span className={`mt-1.5 text-xs font-black ${active ? 'text-blue-700' : 'text-slate-400 group-hover:text-slate-700'}`}>{tab.label}</span>
                              <span className={`mt-0.5 max-w-[118px] text-[10px] font-bold leading-4 ${active ? 'text-blue-500' : 'text-slate-400'}`}>{tab.sub}</span>
                              <span className={`mt-0.5 text-[9.5px] font-black ${active ? 'text-blue-600' : 'text-slate-300'}`}>{displayedUnitDrillCount(selectedUnit, tab.key, tab.count).toLocaleString('en-IN')} records</span>
                            </button>
                            {tabIdx !== popupTabs.length - 1 && <div className="mt-[19px] h-0.5 min-w-[44px] flex-1 rounded-full bg-slate-200" />}
                          </Fragment>
                        )
                      })}
                    </div>
                  </div>
                  {renderUnitDrillToolbar()}
                  <div className={`${unitPopupMaximized ? 'max-h-[calc(94vh-198px)]' : 'max-h-[520px]'} overflow-auto`}>
                    {renderUnitDrillTable()}
                  </div>
                </>
              )
            })()
          )}

        </div>
      </div>,
      document.body
    )}
    </>
  )
}

// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════
export default function KAMPage() {
  const { user }      = useAuthStore()
  const navigate      = useNavigate()
  const { label: kamLabel } = useModuleName('kam')
  const { label: customerLabel } = useModuleName('customers')
  const myId          = user?.id as number
  const canManageWeeklyEscalations = ['ceo','admin','super_admin','manager','sales_head','saleshead','vp'].includes(String(user?.role||'').toLowerCase())
  const { can } = usePermissions()
  const kamPerms = useMemo<KAMPerms>(()=>({
    canCreate: can('kam.create'),
    canUpdate: can('kam.update'),
    canExport: can('kam.export'),
  }),[can])

  type Tab='activities'|'360'
  // Deep link from the dashboards' KAM leaderboard: /kam?tab=360&kam=<user id> opens that KAM's 360 view.
  const [searchParams] = useSearchParams()
  const linkedKamId = Number(searchParams.get('kam')) || null
  const [tab,setTab]             = useState<Tab>(()=>searchParams.get('tab')==='360'?'360':'activities')
  const [activities,setActs]     = useState<any[]>([])
  const [reopenTarget,setReopenTarget] = useState<any>(null)
  const [myCustomers,setCusts]   = useState<any[]>([])
  const [teamMembers,setMembers] = useState<any[]>([])
  const canReopenActivity = canReopenByHierarchy(user, teamMembers)
  const [loading,setLoading]     = useState(true)
  const [activityDataLoaded,setActivityDataLoaded] = useState(false)
  const [period,setPeriod]       = useState(()=>new Date().toISOString().slice(0,7))
  const [viewYear,setViewYear]   = useState(()=>new Date().getFullYear())
  const [isYearly,setIsYearly]   = useState(false)

  const [actPanel,setActPanel]         = useState(false)
  const [planPanel,setPlanPanel]       = useState(false)
  const [quickPlanStartTime,setQuickPlanStartTime] = useState<string|null>(null)
  const [editAct,setEditAct]           = useState<any>(null)
  const [logAct,setLogAct]             = useState<any>(null)
  const [saving,setSaving]             = useState(false)
  const [actForm,setActForm]           = useState(emptyActForm())
  const [travelAlert,setTravel]        = useState<{id:number;number:string;message?:string;isOutside?:boolean}|null>(null)
  const [actDetailPopup,setActDetailPopup] = useState<any>(null)
  const [actTabDetail,setActTabDetail]     = useState<any>(null)
  const [actPanelTRs,setActPanelTRs]   = useState<any[]>([])
  const [actPanelAdvDays,setActPanelAdvDays] = useState<number>(3)

  const [filters,setFilters]     = useState<FilterState>(emptyFilter())
  const [dateView,setDateView]   = useState<'today'|'all'|'custom'>('today')
  const [activitySubTab,setActivitySubTab] = useState<'planner'|'list'|'weekly'>('planner')
  const [plannerView,setPlannerView] = useState<PlannerView>('day')
  const [plannerDate,setPlannerDate] = useState(()=>new Date().toISOString().slice(0,10))
  const [activeCustomerName,setActiveCustomerName] = useState<string>('')
  const [weeklyPlanStatus,setWeeklyPlanStatus] = useState<WeeklyPlanStatus|null>(null)
  const [weeklyPlanLoading,setWeeklyPlanLoading] = useState(false)
  const [weeklyPlanSending,setWeeklyPlanSending] = useState(false)
  const [weeklySelectedIds,setWeeklySelectedIds] = useState<number[]>([])
  const today = new Date().toISOString().slice(0,10)
  const activitySubTabs = useMemo(()=>[
    {id:'planner' as const,label:'Activity Planner'},
    {id:'list' as const,label:'Activity List'},
    ...(canManageWeeklyEscalations?[{id:'weekly' as const,label:'Pending Weekly Plan'}]:[]),
  ],[canManageWeeklyEscalations])

  const { success, error:showError } = useToast()

  useEffect(()=>{
    let alive=true
    ;(async()=>{
      const [c,m]=await Promise.allSettled([
        api.get('/kam/plan-customers'),
        api.get('/kam/team-members'),
      ])
      if(!alive) return
      if(c.status==='fulfilled') setCusts(c.value.data)
      if(m.status==='fulfilled') setMembers(m.value.data)
    })()
    return ()=>{alive=false}
  },[])

  const loadAll = useCallback(async()=>{
    setLoading(true)
    const actParams:any={
      user_id:       filters.userId||undefined,
      activity_type: filters.actType||undefined,
      status:        filters.status||undefined,
      customer_id:   filters.customerId||undefined,
    }
    if(activitySubTab==='planner'){
      const range=plannerRangeFor(plannerDate,plannerView)
      actParams.date_from=range.from
      actParams.date_to=range.to
    } else if(activitySubTab==='weekly') actParams.activity_date=today
    else if(dateView==='today') actParams.activity_date=today
    else if(dateView==='custom'){actParams.date_from=filters.dateFrom||undefined;actParams.date_to=filters.dateTo||undefined}
    try{
      const a=await api.get('/kam/activities',{params:actParams})
      let activityRows=Array.isArray(a.data)?a.data:[]
      if(activitySubTab==='planner'&&plannerView==='week'){
        const overdueStatusList=filters.status
          ? (['Completed','Cancelled'].includes(filters.status)?[]:[filters.status])
          : ['Planned','In Progress','Postponed']
        const overdueResults=await Promise.allSettled(overdueStatusList.map(status=>
          api.get('/kam/activities',{params:{...actParams,status,date_from:undefined,date_to:addDateDays(today,-1)}})
        ))
        const byId=new Map(activityRows.map((row:any)=>[Number(row.id),row]))
        overdueResults.forEach(result=>{
          if(result.status!=='fulfilled') return
          const rows=Array.isArray(result.value.data)?result.value.data:[]
          rows.forEach((row:any)=>byId.set(Number(row.id),row))
        })
        activityRows=Array.from(byId.values())
      }
      setActs(activityRows)
    }catch{showError('Failed to load')}
    finally{
      setActivityDataLoaded(true)
      setLoading(false)
    }
  },[filters,dateView,today,activitySubTab,plannerDate,plannerView])

  useEffect(()=>{loadAll()},[loadAll])

  useEffect(()=>{
    if(activitySubTab==='weekly'&&!canManageWeeklyEscalations) setActivitySubTab('planner')
  },[activitySubTab,canManageWeeklyEscalations])

  const loadWeeklyPlanStatus = useCallback(async()=>{
    if(!canManageWeeklyEscalations) return
    setWeeklyPlanLoading(true)
    try{
      const res=await api.get('/kam/weekly-plan/status')
      const data=res.data as WeeklyPlanStatus
      setWeeklyPlanStatus(data)
      setWeeklySelectedIds(prev=>{
        const validIds=new Set((data.missing_users||[]).map(u=>Number(u.id)))
        return prev.filter(id=>validIds.has(Number(id)))
      })
    }catch(e:any){
      showError(e.response?.data?.detail||'Failed to load weekly plan status')
    }finally{
      setWeeklyPlanLoading(false)
    }
  },[canManageWeeklyEscalations])

  useEffect(()=>{loadWeeklyPlanStatus()},[loadWeeklyPlanStatus])

  const weeklyPendingUserIds = useMemo(
    () => (weeklyPlanStatus?.missing_users||[]).map(u=>Number(u.id)).filter(id=>Number.isFinite(id)&&id>0),
    [weeklyPlanStatus]
  )

  const toggleWeeklyUser=(id:number)=>{
    const normalized=Number(id)
    if(!Number.isFinite(normalized)||normalized<=0) return
    setWeeklySelectedIds(prev=>prev.includes(normalized)?prev.filter(v=>v!==normalized):[...prev,normalized])
  }
  const toggleAllWeeklyUsers=()=>{
    setWeeklySelectedIds(prev=>weeklyPendingUserIds.length>0&&weeklyPendingUserIds.every(id=>prev.includes(id))?[]:weeklyPendingUserIds)
  }
  const sendWeeklyEscalation=async(userIds?:number[])=>{
    const cleanIds=(userIds||weeklyPendingUserIds).map(id=>Number(id)).filter(id=>Number.isFinite(id)&&id>0)
    if(cleanIds.length===0){ showError('Select at least one pending user'); return }
    setWeeklyPlanSending(true)
    try{
      const payload={user_ids:cleanIds}
      const res=await api.post('/kam/weekly-plan/send-escalation',payload)
      const sent=Number(res.data?.sent||0)
      success(sent>0?`Sent ${sent} escalation email${sent!==1?'s':''}`:'No escalation emails sent')
      setWeeklySelectedIds([])
      loadWeeklyPlanStatus()
    }catch(e:any){
      showError(e.response?.data?.detail||'Failed to send escalation')
    }finally{
      setWeeklyPlanSending(false)
    }
  }

  const closeActPanel = () => {
    setSaving(false)
    setActPanel(false)
    setEditAct(null)
    setActForm(emptyActForm())
    setActPanelTRs([])
    setActPanelAdvDays(3)
  }
  const openPlanPanel = (date?: string, startTime?: string | null) => {
    setSaving(false)
    if (typeof date === 'string' && date) setPlannerDate(date)
    setQuickPlanStartTime(startTime||null)
    setActPanel(false)
    setEditAct(null)
    setLogAct(null)
    setPlanPanel(true)
  }
  // Deep link from the dashboard welcome banner's "Log activity": /kam?new=activity opens the activity panel once.
  useEffect(()=>{
    if(searchParams.get('new')==='activity'&&kamPerms.canCreate) openPlanPanel()
  },[]) // eslint-disable-line react-hooks/exhaustive-deps
  // Deep link from the footer Timer (TimerFooterButton.tsx): /kam?logTimer=1&start=HH:MM&end=HH:MM&duration=<min>
  // opens the real "Log Activity" form (not the day planner above) with the timed session pre-filled —
  // the user still picks an activity type themselves; once they pick a timed type (Phone Call/Video Call/
  // In Person Meet/Meeting/Demo) these fields are already there, same as if they'd typed them in.
  useEffect(()=>{
    if(searchParams.get('logTimer')==='1'&&kamPerms.canCreate){
      const start=searchParams.get('start')||''
      const end=searchParams.get('end')||''
      const duration=searchParams.get('duration')
      setSaving(false)
      setPlanPanel(false)
      setLogAct(null)
      setEditAct(null)
      setActForm(emptyActForm())
      setActPanel(true)
      setActForm((p:any)=>({...p,
        start_time:start||p.start_time,
        end_time:end||p.end_time,
        duration_minutes:duration?Number(duration):p.duration_minutes,
      }))
    }
  },[]) // eslint-disable-line react-hooks/exhaustive-deps
  const closePlanPanel = () => {
    setSaving(false)
    setPlanPanel(false)
    setQuickPlanStartTime(null)
  }
  const openLogPanel = (act: any) => {
    setSaving(false)
    setActPanel(false)
    setEditAct(null)
    setPlanPanel(false)
    setQuickPlanStartTime(null)
    setLogAct(act)
  }
  const closeLogPanel = () => {
    setSaving(false)
    setLogAct(null)
  }

  const sanitizeActivityPayload=(f:any)=>{
    const numeric=['tr_estimated_cost','tr_advance_amount','tr_accommodation_cost','tr_estimated_kms']
    const dateFields=['tr_travel_date','tr_return_date','tr_check_in_date','tr_check_out_date']
    const out={...f}
    delete out.document_file
    if(out.activity_type&&!out.mode) out.mode=modeForActivityType(out.activity_type)
    for(const k of [...numeric,...dateFields]) if(out[k]==='') out[k]=null
    return out
  }

  const uploadActivityDocument=async(activityId:number,file:File)=>{
    const fd=new FormData()
    fd.append('file',file,file.name)
    const res=await api.post(`/kam/activities/${activityId}/upload-document`,fd,{headers:{'Content-Type':'multipart/form-data'}})
    return res.data || {}
  }

  const enrichActivityCoords = async (raw:any) => {
    const payload={...raw}
    if(typeof window==='undefined'){
      throw new Error('Location capture is unavailable in this environment.')
    }
    if(!window.isSecureContext){
      throw new Error('GPS capture needs HTTPS (or localhost) - this page is loaded over plain HTTP.')
    }
    if(!navigator.geolocation){
      throw new Error('Location is not supported by this browser.')
    }

    try{
      const coords=await new Promise<{latitude:number;longitude:number}>((resolve,reject)=>{
        navigator.geolocation.getCurrentPosition(
          pos=>resolve({latitude:pos.coords.latitude,longitude:pos.coords.longitude}),
          reject,
          { enableHighAccuracy:true, timeout:10000, maximumAge:0 },
        )
      })
      payload.latitude=coords.latitude
      payload.longitude=coords.longitude
      return payload
    }catch(err:any){
      const code=Number(err?.code || 0)
      const message=code===1
        ? 'Location permission denied.'
        : code===2
          ? 'Location unavailable.'
          : code===3
            ? 'Location request timed out.'
            : 'Unable to capture location.'
      throw new Error(message)
    }
  }

  const saveActivity = async () => {
    if (!actForm.subject.trim()) { showError('Subject required'); return }
    if (actForm.status === 'Completed' && !actForm.outcome?.trim()) { showError('Outcome required'); return }
    if (actForm.status === 'Cancelled' && !actForm.cancellation_reason?.trim()) { showError('Cancellation reason required'); return }
    if (requiresActivityRemarks(actForm.status) && !actForm.description?.trim()) { showError('Remarks required'); return }
    setSaving(true)
    try {
      const selectedType = taskTypeName(actForm)
      const payload = sanitizeActivityPayload(await enrichActivityCoords({
        ...actForm, activity_type: selectedType,
        mode: modeForActivityType(selectedType), task_type_name: selectedType,
      }))
      let res: any
      if (editAct?.id) {
        res = await api.patch(`/kam/activities/${editAct.id}`, payload)
        success('Activity updated' + (res.data?.follow_up_created ? ' — Follow-up created' : ''))
      } else {
        res = await api.post('/kam/activities', payload)
        success('Activity logged')
      }
      if (res.data?.auto_travel_request_id) {
        setTravel({
          id: res.data.auto_travel_request_id, number: res.data.auto_travel_request_number,
          message: res.data.travel_request_message, isOutside: payload.is_outside_district,
        })
      }
      closeActPanel(); loadAll()
    } catch (e: any) { showError(e.response?.data?.detail || e.message || 'Failed') }
    finally { setSaving(false) }
  }

  const saveLog=async(form:any)=>{
    if(!logAct?.id)return
    if(requiresActivityRemarks(form.status)&&!form.description?.trim()){showError('Remarks required');return}
    setSaving(true)
    try{
      const payloadBase=await enrichActivityCoords(form)
      const uploaded=form.document_file ? await uploadActivityDocument(Number(logAct.id),form.document_file) : null
      const payload=uploaded?{...payloadBase,...uploaded}:payloadBase
      const res=await api.patch(`/kam/activities/${logAct.id}`,sanitizeActivityPayload(payload))
      success(`Activity ${(form.status||'updated').toLowerCase()}`)
      if(res.data?.auto_travel_request_id) {
        setTravel({id:res.data.auto_travel_request_id,number:res.data.auto_travel_request_number,message:res.data.travel_request_message,isOutside:form.is_outside_district})
      }
      closeLogPanel(); loadAll()
    }
    catch(e:any){showError(e.response?.data?.detail||e.message||'Failed')}
    finally{setSaving(false)}
  }

  const savePlan=async(date:string,rows:PlanRow[])=>{
    setSaving(true)
    try{
      const firstPlannedDate = rows.map(r=>r.activity_date||date).find(Boolean) || date
      await api.post('/kam/activities/bulk',rows.map(r=>({
        activity_type:r.activity_type, mode:modeForActivityType(r.activity_type),
        customer_id:r.customer_id, lead_id:r.lead_id||null, tender_id:r.tender_id||null,
        work_order_id:r.work_order_id||null, emdbg_id:r.emdbg_id||null,
        subject:r.subject, activity_date:r.activity_date||date,
        start_time:r.start_time||null, duration_minutes:r.duration_minutes??durationFromTimes(r.start_time,r.end_time),
        on_behalf_of:r.on_behalf_of||null, latitude:r.latitude||null, longitude:r.longitude||null,
      })))
      success(`${rows.length} activit${rows.length!==1?'ies':'y'} planned`)
      closePlanPanel()
      setPlannerDate(firstPlannedDate)
      if(firstPlannedDate===plannerDate) loadAll()
    }
    catch(e:any){showError(e.response?.data?.detail||'Failed')}
    finally{setSaving(false)}
  }

  const submitTravel=async(id:number)=>{
    try{const r=await api.post(`/kam/travel-requests/${id}/submit`,{});success(`Submitted to ${r.data.requested_to}`);setTravel(null)}
    catch(e:any){showError(e.response?.data?.detail||'Failed')}
  }

  const openAct=(a?:any)=>{
    setSaving(false)
    setLogAct(null)
    setPlanPanel(false)
    setQuickPlanStartTime(null)
    setEditAct(a||null)
    setActForm(a?{...emptyActForm(),...a,activity_type:a?taskTypeName(a):emptyActForm().activity_type}:{...emptyActForm()})
    setActPanel(true)
    if(a?.id){
      Promise.all([
        api.get('/travel/requests').catch(()=>({data:[]})),
        api.get('/settings/settings').catch(()=>({data:{}})),
      ]).then(([trs,cfg])=>{
        setActPanelTRs(Array.isArray(trs.data)?trs.data:(trs.data?.items||[]))
        const raw=cfg.data?.travel_request_advance_days
        setActPanelAdvDays(parseInt(typeof raw==='object'?raw?.value:raw)||3)
      })
    }
  }

  const handleNavigate=(module:string,params?:any)=>{
    if(module==='activities'){
      setTab('activities')
      const baseFilters={
        ...emptyFilter(),
        actType:    params?.actType    || params?.activityType || '',
        userId:     params?.userId     ?? null,
        customerId: params?.customerId ?? null,
      }
      setActiveCustomerName(params?.customerName||'')
      if(params?.dateFrom&&params?.dateTo){
        setDateView('custom')
        setFilters({...baseFilters,dateFrom:params.dateFrom,dateTo:params.dateTo})
      } else if(params?.isYearly||params?.period){
        setDateView('custom')
        if(params?.isYearly){
          const yr=params?.viewYear||new Date().getFullYear()
          setFilters({...baseFilters,dateFrom:`${yr}-01-01`,dateTo:`${yr}-12-31`})
        } else {
          const p=params?.period||new Date().toISOString().slice(0,7)
          const [y,m]=p.split('-').map(Number)
          const lastDay=new Date(y,m,0).getDate()
          setFilters({...baseFilters,dateFrom:`${p}-01`,dateTo:`${p}-${String(lastDay).padStart(2,'0')}`})
        }
      } else {
        setDateView('all')
        setFilters(baseFilters)
      }
    } else if(module) navigate(`/${module}`)
  }

  const todayActs      = activities.filter((a:any)=>a.activity_date===today)
  const overdueActs    = activities.filter((a:any)=>['Planned','In Progress','Postponed'].includes(a.status)&&a.activity_date<today)
  const completedToday = todayActs.filter((a:any)=>a.status==='Completed').length
  const pendingToday   = todayActs.filter((a:any)=>['Planned','In Progress'].includes(a.status)).length

  const hasActiveFilters = Object.entries(filters).some(([k,v])=>v!==null&&v!=='')
  const showGroupedActivities = teamMembers.length>1&&!filters.userId
  const groupedActivities = showGroupedActivities ? groupActivitiesByUser(activities, teamMembers) : []
  const hasTeamScope = teamMembers.length > 1
  const detailActivity = actDetailPopup || actTabDetail
  const closeDetailView = () => {
    setActDetailPopup(null)
    setActTabDetail(null)
  }
  const activeActivityScreen = detailActivity ? 'detail' : logAct ? 'log' : actPanel ? 'activity' : planPanel ? 'plan' : null
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore()
  const wasSidebarCollapsed = useRef(sidebarCollapsed)
  useEffect(() => {
    if (!activeActivityScreen) return
    wasSidebarCollapsed.current = sidebarCollapsed
    setSidebarCollapsed(true)
    return () => {
      setSidebarCollapsed(wasSidebarCollapsed.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeActivityScreen, setSidebarCollapsed])
  const activeScreenMeta = activeActivityScreen === 'log'
    ? { title: 'Update Activity Log', subtitle: 'Review the activity and save the latest status' }
    : activeActivityScreen === 'detail'
      ? { title: 'View Activity', subtitle: 'Review the full activity details and timeline in a single page view' }
    : activeActivityScreen === 'activity'
      ? { title: editAct ? 'Edit Activity' : 'Log Activity', subtitle: editAct ? 'Update activity details in a normal form page' : 'Record a new KAM activity in a normal form page' }
      : activeActivityScreen === 'plan'
        ? { title: 'Plan Activity', subtitle: 'Schedule daily or weekly activities in a normal form page' }
        : null
  const closeActiveActivityScreen = () => {
    if (activeActivityScreen === 'detail') closeDetailView()
    else if (activeActivityScreen === 'log') closeLogPanel()
    else if (activeActivityScreen === 'activity') closeActPanel()
    else if (activeActivityScreen === 'plan') closePlanPanel()
  }

  return (
    <KAMPermsContext.Provider value={kamPerms}>
    <div className={activeActivityScreen ? 'space-y-5' : 'p-6 space-y-5'}>
      {reopenTarget&&(
        <ReopenActivityModal
          activity={reopenTarget}
          onClose={()=>setReopenTarget(null)}
          onSuccess={()=>{loadAll()}}
        />
      )}

      {!activeActivityScreen&&(
        <PageHeader title={kamLabel} subtitle="Key Account Management — plan, log and track your activities" breadcrumb={[kamLabel]}
          actions={
            <div className="flex items-center gap-2">
              <button onClick={loadAll} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
              {kamPerms.canCreate&&(
                <Button onClick={()=>openPlanPanel()} className="!bg-white !text-gray-700 !border !border-gray-200 hover:!bg-gray-50">
                  <Calendar size={14} className="mr-1.5 inline-block"/>Plan Activity
                </Button>
              )}
            </div>
          }/>
      )}

      {travelAlert&&<TravelAlertBanner requestNumber={travelAlert.number} requestId={travelAlert.id} message={travelAlert.message} isOutside={travelAlert.isOutside} onSubmit={submitTravel} onDismiss={()=>setTravel(null)}/>}

      {activeActivityScreen==='detail'&&detailActivity&&(
        <KAMFormShell
          breadcrumb="Activities"
          currentLabel="View Activity"
          onBack={closeDetailView}
          actions={
            ['Completed','Cancelled'].includes(String(detailActivity.status||''))
              ? (
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={closeDetailView}
                    leftIcon={<X size={14} />}
                  >
                    Close
                  </Button>
                  {canReopenActivity&&(
                    <Button
                      size="sm"
                      onClick={()=>{
                        closeDetailView()
                        setReopenTarget(detailActivity)
                      }}
                      leftIcon={<RefreshCw size={14} />}
                    >
                      Reopen Activity
                    </Button>
                  )}
                </div>
              )
              : (
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={closeDetailView}
                    leftIcon={<X size={14} />}
                  >
                    Close
                  </Button>
                  {kamPerms.canUpdate&&canEditActivity(detailActivity)&&(
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={()=>{
                        closeDetailView()
                        openAct(detailActivity)
                      }}
                      leftIcon={<Edit3 size={14} />}
                    >
                      Edit
                    </Button>
                  )}
                  {kamPerms.canUpdate&&(
                    <Button
                      size="sm"
                      onClick={()=>{
                        closeDetailView()
                        openLogPanel(detailActivity)
                      }}
                      leftIcon={<Edit3 size={14} />}
                    >
                      Update Log
                    </Button>
                  )}
                </div>
              )
          }
        >
          <ActivityDetailView
            activity={detailActivity}
            onLog={a=>{
              closeDetailView()
              openLogPanel(a)
            }}
            onEdit={a=>{
              closeDetailView()
              openAct(a)
            }}
            canReopen={canReopenActivity}
            onReopen={a=>{
              closeDetailView()
              setReopenTarget(a)
            }}
          />
        </KAMFormShell>
      )}

      {activeActivityScreen==='log'&&logAct&&(
        <LogSlidePanel activity={logAct} customers={myCustomers} isAdmin={hasTeamScope} onSave={saveLog} onClose={closeLogPanel} saving={saving}/>
      )}

      {activeActivityScreen==='activity'&&(
        <KAMFormShell
          breadcrumb="Activities"
          currentLabel={editAct?'Edit Activity':'Log Activity'}
          onBack={closeActPanel}
          actions={
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" onClick={closeActPanel}>Cancel</Button>
              <Button size="sm" onClick={saveActivity} loading={saving}>{editAct?'Update':'Save Activity'}</Button>
            </div>
          }
        >
          <LogActivityForm form={actForm} setForm={setActForm} customers={myCustomers} isAdmin={hasTeamScope}
            isEdit={!!editAct} travelRequests={actPanelTRs} advanceDays={actPanelAdvDays}/>
        </KAMFormShell>
      )}

      {activeActivityScreen==='plan'&&(
        <KAMFormShell
          breadcrumb="Activities"
          currentLabel="Plan Activity"
          onBack={closePlanPanel}
          actions={<Button variant="outline" size="sm" onClick={closePlanPanel} leftIcon={<ChevronLeft size={14}/>}>Back to Activities</Button>}
          bodyClassName="min-h-[75vh] p-0"
        >
          <PlanDayPanel teamMembers={teamMembers} currentUserId={myId} initialDate={plannerDate} initialStartTime={quickPlanStartTime} onSaveAll={savePlan} saving={saving} onClose={closePlanPanel}/>
        </KAMFormShell>
      )}

      {!activeActivityScreen&&(
        <>
      {/* Tabs */}
      <div className="flex items-center gap-1 bg-gray-100 rounded-2xl p-1 w-fit">
        {([{id:'activities',label:'Activities',icon:<Activity size={13}/>},{id:'360',label:kamLabel,icon:<BarChart2 size={13}/>}] as const).map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl transition-all whitespace-nowrap ${tab===t.id?'bg-white text-gray-900 shadow-sm':'text-gray-500 hover:text-gray-700'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* ── ACTIVITIES TAB ─────────────────────────────────────────────────── */}
      {tab==='activities'&&(
        <div className="space-y-4">
          <div className="rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <h2 className="text-xl font-black text-gray-900">Activities</h2>
                <p className="mt-0.5 text-sm font-medium text-gray-500">Plan, track, and close KAM activities</p>
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-2 border-t border-gray-100 pt-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap rounded-xl bg-gray-100 p-1">
                {activitySubTabs.map(item=>(
                  <button key={item.id} type="button" onClick={()=>setActivitySubTab(item.id)}
                    className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-black transition-colors whitespace-nowrap ${activitySubTab===item.id?'bg-white text-blue-600 shadow-sm':'text-gray-500 hover:text-gray-800'}`}>
                    <span>{item.label}</span>
                    {item.id==='weekly'&&Number(weeklyPlanStatus?.pending_users||0)>0&&(
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${activitySubTab===item.id?'bg-blue-50 text-blue-600':'bg-white text-amber-600'}`}>
                        {weeklyPlanStatus?.pending_users}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {activitySubTab==='planner'&&(
                  <select value={filters.status||''} onChange={e=>setFilters(f=>({...f,status:e.target.value}))}
                    className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-xs font-bold text-gray-600 outline-none focus:border-blue-400">
                    <option value="">All Activities</option>
                    {STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                )}
              </div>
            </div>
            {activitySubTab==='planner'&&(
              <div className="mt-3">
                <ActivityPlannerView
                  activities={activities}
                  plannerView={plannerView}
                  setPlannerView={setPlannerView}
                  plannerDate={plannerDate}
                  setPlannerDate={setPlannerDate}
                  loading={loading}
                  initialLoading={loading&&!activityDataLoaded}
                  onPlan={(date,startTime)=>openPlanPanel(date,startTime)}
                  onLog={act=>openLogPanel(act)}
                  onEdit={openAct}
                  onViewDetail={setActDetailPopup}
                  embedded
                />
              </div>
            )}
          </div>

          {activitySubTab==='weekly'&&canManageWeeklyEscalations&&(
            <PendingWeeklyPlanPanel
              status={weeklyPlanStatus}
              loading={weeklyPlanLoading}
              sending={weeklyPlanSending}
              selectedIds={weeklySelectedIds}
              onToggle={toggleWeeklyUser}
              onToggleAll={toggleAllWeeklyUsers}
              onRefresh={loadWeeklyPlanStatus}
              onSendAll={()=>sendWeeklyEscalation()}
              onSendSelected={()=>sendWeeklyEscalation(weeklySelectedIds)}
            />
          )}

          {activitySubTab==='list'&&<>
              <ActivityListWorkspace
                activities={activities}
                loading={loading}
                myCustomers={myCustomers}
                teamMembers={teamMembers}
                filters={filters}
                setFilters={setFilters}
                dateView={dateView}
                setDateView={setDateView}
                activeCustomerName={activeCustomerName}
                setActiveCustomerName={setActiveCustomerName}
                today={today}
                hasActiveFilters={hasActiveFilters}
                hasTeamScope={hasTeamScope}
                onPlan={openPlanPanel}
                onLog={act=>openLogPanel(act)}
                onEdit={openAct}
                onViewDetail={setActDetailPopup}
                canReopen={canReopenActivity}
                onReopen={a=>setReopenTarget(a)}
              />
              {false&&<>
          {dateView==='today'&&(
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatCard title="Today Total"  value={todayActs.length}   icon={<Calendar size={20}/>} color="blue"/>
              <StatCard title="Completed"    value={completedToday}     icon={<CheckCircle size={20}/>} color="green"/>
              <StatCard title={overdueActs.length>0?'Overdue':'Pending'} value={overdueActs.length>0?overdueActs.length:pendingToday} icon={overdueActs.length>0?<AlertCircle size={20}/>:<Clock size={20}/>} color={overdueActs.length>0?'red':'amber'}/>
            </div>
          )}
          {dateView==='today'&&overdueActs.length>0&&(
            <div className="bg-white rounded-2xl border border-red-200 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 bg-red-50 border-b border-red-100">
                <AlertCircle size={14} className="text-red-500"/>
                <h3 className="text-sm font-bold text-red-700">Overdue <span className="text-red-400 font-normal">({overdueActs.length})</span></h3>
                <button onClick={()=>setDateView('all')} className="ml-auto text-xs text-red-500 hover:text-red-700 font-semibold flex items-center gap-1">View all<ChevronRight size={11}/></button>
              </div>
              <div className="divide-y divide-gray-50">
                {overdueActs.slice(0,3).map((a:any)=><ActivityRow key={a.id} a={a} showUser={hasTeamScope} onLog={act=>openLogPanel(act)} onEdit={openAct} onViewDetail={setActTabDetail}/>)}
                {overdueActs.length>3&&<div className="py-2 text-center text-xs text-gray-400">+{overdueActs.length-3} more overdue</div>}
              </div>
            </div>
          )}

          {/* Filter row */}
          <div className="bg-white rounded-2xl border border-gray-200 px-3 py-2.5 flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5 flex-shrink-0">
              {([{id:'today',label:'Today'},{id:'all',label:'All'},{id:'custom',label:'Range'}] as const).map(v=>(
                <button key={v.id} onClick={()=>{setDateView(v.id);setFilters(emptyFilter());setActiveCustomerName('')}}
                  className={`px-2.5 py-1 text-xs font-semibold rounded-lg transition-all whitespace-nowrap ${dateView===v.id?'bg-white text-gray-800 shadow-sm':'text-gray-500 hover:text-gray-700'}`}>{v.label}</button>
              ))}
            </div>
            {dateView==='custom'&&(
              <>
                <input type="date" value={filters.dateFrom} onChange={e=>setFilters(f=>({...f,dateFrom:e.target.value}))} className="text-xs border border-gray-200 rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-blue-400 w-[130px]"/>
                <span className="text-xs text-gray-300">—</span>
                <input type="date" value={filters.dateTo} onChange={e=>setFilters(f=>({...f,dateTo:e.target.value}))} className="text-xs border border-gray-200 rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-blue-400 w-[130px]"/>
              </>
            )}
            <div className="w-px h-4 bg-gray-200 flex-shrink-0"/>
            <select value={filters.status} onChange={e=>setFilters(f=>({...f,status:e.target.value}))} className="text-xs border border-gray-200 rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-blue-400 bg-white">
              <option value="">All Status</option>{STATUSES.map(s=><option key={s}>{s}</option>)}
            </select>
            <select value={filters.actType} onChange={e=>setFilters(f=>({...f,actType:e.target.value}))} className="text-xs border border-gray-200 rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-blue-400 bg-white">
              <option value="">All Types</option>{ACTIVITY_TYPES.map(t=><option key={t}>{t}</option>)}
            </select>
            {myCustomers.length>0&&(
              <select value={filters.customerId||''} onChange={e=>{const v=e.target.value?parseInt(e.target.value):null;const name=v?myCustomers.find(c=>c.id===v)?.customer_name||'':'';setFilters(f=>({...f,customerId:v}));setActiveCustomerName(name)}}
                className={`text-xs border rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-blue-400 bg-white max-w-[160px] ${filters.customerId?'border-blue-300 bg-blue-50 text-blue-700':'border-gray-200'}`}>
                <option value="">All {customerLabel}</option>
                {myCustomers.map((c:any)=><option key={c.id} value={c.id}>{c.customer_name}</option>)}
              </select>
            )}
            {teamMembers.length>1&&(
              <select value={filters.userId||''} onChange={e=>setFilters(f=>({...f,userId:e.target.value?parseInt(e.target.value):null}))} className="text-xs border border-gray-200 rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-blue-400 bg-white min-w-[130px]">
                <option value="">All Members</option>{teamMembers.map(u=><option key={u.id} value={u.id}>{u.full_name}{u.is_self?' (You)':''}</option>)}
              </select>
            )}
            {hasActiveFilters&&(
              <button onClick={()=>{setFilters(emptyFilter());setActiveCustomerName('')}} className="ml-auto text-xs text-gray-400 hover:text-red-500 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-red-50 flex-shrink-0">
                <X size={11}/>Reset
              </button>
            )}
          </div>

          {/* Active filter badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-400 font-medium">{activities.length} {dateView==='today'?'activities today':'activities'}</span>
            {filters.customerId&&activeCustomerName&&(
              <span className="inline-flex items-center gap-1.5 text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-lg font-semibold">
                <Building2 size={10}/>{activeCustomerName}
                <button onClick={()=>{setFilters(f=>({...f,customerId:null}));setActiveCustomerName('')}} className="text-blue-400 hover:text-red-500 ml-0.5"><X size={10}/></button>
              </span>
            )}
            {filters.actType&&(
              <span className="inline-flex items-center gap-1.5 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-lg font-semibold">
                {filters.actType}
                <button onClick={()=>setFilters(f=>({...f,actType:''}))} className="text-gray-400 hover:text-red-500"><X size={10}/></button>
              </span>
            )}
          </div>

          {loading
            ?<div className="py-12 text-center"><div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto"/></div>
  //           :activities.length===0
  //             ?<div className="py-16 text-center bg-white rounded-2xl border border-gray-200">
  //               <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-3"><Coffee size={20} className="text-gray-300"/></div>
  //               <p className="text-sm font-semibold text-gray-400">
  //                 {filters.customerId&&activeCustomerName?`No activities for ${activeCustomerName}`:dateView==='today'?'No activities planned for today':'No activities found'}
  //               </p>
  //               {dateView === 'today' && (
  //                 <div className="mt-3">
  //                   <Button onClick={openPlanPanel} className="!bg-white !text-gray-700 !border !border-gray-200 hover:!bg-gray-50">
  //                     <Calendar size={14} className="mr-1.5 inline-block" />Plan Day
  //                   </Button>
  //                 </div>
  //               )}
  //             </div>
  //             : showGroupedActivities
  // ? <div className="space-y-4">
  //   {groupedActivities.map(group=>{
  //     const completed = group.items.filter((a:any)=>a.status==='Completed').length
  //     const pending   = group.items.filter((a:any)=>['Planned','In Progress'].includes(a.status)).length
  //     const overdue   = group.items.filter((a:any)=>['Planned','In Progress','Postponed'].includes(a.status)&&a.activity_date<today).length
  //     return (
  //       <div key={group.key} className="rounded-2xl border-2 border-gray-200 bg-white overflow-hidden shadow-sm">
  //         {/* User header */}
  //         <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-slate-50 to-gray-50 border-b border-gray-200">
  //           <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center font-bold text-sm flex-shrink-0">
  //             {group.userName.charAt(0).toUpperCase()}
  //           </div>
  //           <div className="flex-1 min-w-0">
  //             <p className="text-sm font-bold text-gray-900 truncate">{group.userName}</p>
  //             <p className="text-[11px] text-gray-400 font-medium capitalize">{roleLabel(group.role)}</p>
  //           </div>
  //           <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap justify-end">
  //             <span className="px-2 py-1 rounded-lg bg-white border border-gray-200 text-[11px] font-bold text-gray-600">{group.items.length} total</span>
  //             {completed>0&&<span className="px-2 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-[11px] font-bold text-emerald-700">{completed} done</span>}
  //             {pending>0&&<span className="px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-[11px] font-bold text-amber-700">{pending} pending</span>}
  //             {overdue>0&&<span className="px-2 py-1 rounded-lg bg-red-50 border border-red-200 text-[11px] font-bold text-red-600">{overdue} overdue</span>}
  //           </div>
  //         </div>
  //         {/* Activities list */}
  //         <div className="px-3 py-2 space-y-1.5">
  //           {group.items.map((a:any)=>(
  //             <ActivityRow key={a.id} a={a} showUser={false} onLog={act=>openLogPanel(act)} onEdit={openAct} onViewDetail={setActDetailPopup}/>
  //           ))}
  //         </div>
  //       </div>
  //     )
  //   })}
  // </div>
  :activities.length===0
  ?<div className="py-16 text-center bg-white rounded-2xl border border-gray-200">
    <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-3"><Coffee size={20} className="text-gray-300"/></div>
    <p className="text-sm font-semibold text-gray-400">
      {filters.customerId&&activeCustomerName?`No activities for ${activeCustomerName}`:dateView==='today'?'No activities planned for today':'No activities found'}
    </p>
    {dateView === 'today' && (
      <div className="mt-3">
        <Button onClick={()=>openPlanPanel()} className="!bg-white !text-gray-700 !border !border-gray-200 hover:!bg-gray-50">
          <Calendar size={14} className="mr-1.5 inline-block" />Plan Activity
        </Button>
      </div>
    )}
  </div>
  : showGroupedActivities
  ? <div className="space-y-4">
    {groupedActivities.map(group=>{
      const completed=group.items.filter((a:any)=>a.status==='Completed').length
      const pending=group.items.filter((a:any)=>['Planned','In Progress'].includes(a.status)).length
      const overdue=group.items.filter((a:any)=>['Planned','In Progress','Postponed'].includes(a.status)&&a.activity_date<today).length
      return (
        <div key={group.key} className="rounded-2xl border-2 border-gray-200 bg-white overflow-hidden shadow-sm">
          <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-slate-50 to-gray-50 border-b border-gray-200">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center font-bold text-sm flex-shrink-0">
              {group.userName.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-gray-900 truncate">{group.userName}</p>
              <p className="text-[11px] text-gray-400 font-medium capitalize">{roleLabel(group.role)}</p>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap justify-end">
              <span className="px-2 py-1 rounded-lg bg-white border border-gray-200 text-[11px] font-bold text-gray-600">{group.items.length} total</span>
              {completed>0&&<span className="px-2 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-[11px] font-bold text-emerald-700">{completed} done</span>}
              {pending>0&&<span className="px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-[11px] font-bold text-amber-700">{pending} pending</span>}
              {overdue>0&&<span className="px-2 py-1 rounded-lg bg-red-50 border border-red-200 text-[11px] font-bold text-red-600">{overdue} overdue</span>}
            </div>
          </div>
          <ActivityTable
            activities={group.items}
            showUser={false}
            today={today}
            onLog={act=>openLogPanel(act)}
            onEdit={openAct}
            onViewDetail={setActDetailPopup}
          />
        </div>
      )
    })}
  </div>
  : <ActivityTable
      activities={activities}
      showUser={hasTeamScope&&!filters.userId}
      today={today}
      onLog={act=>openLogPanel(act)}
      onEdit={openAct}
      onViewDetail={setActDetailPopup}
    />
  // :<div className="space-y-2">{activities.map((a:any)=><ActivityRow key={a.id} a={a} showUser={hasTeamScope&&!filters.userId} onLog={act=>openLogPanel(act)} onEdit={openAct} onViewDetail={setActDetailPopup}/>)}</div>
          }
            </>}
            </>
          }
        </div>
      )}

      {/* ── KAM 360 TAB ────────────────────────────────────────────────────── */}
      {tab==='360'&&(
        <KAM360Tab
          myId={myId} teamMembers={teamMembers}
          period={period} setPeriod={setPeriod}
          isYearly={isYearly} setIsYearly={setIsYearly}
          viewYear={viewYear} setViewYear={setViewYear}
          onNavigate={handleNavigate}
          onLogActivity={a=>openLogPanel(a)}
          onEditActivity={a=>openAct(a)}
          initialUid={linkedKamId}
        />
      )}
        </>
      )}
    </div>
    </KAMPermsContext.Provider>
  )
}
