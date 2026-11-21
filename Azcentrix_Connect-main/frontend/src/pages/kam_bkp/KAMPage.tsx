import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity, Plus, CheckCircle, XCircle, AlertCircle,
  Calendar, Car, Edit3, ArrowRight, ChevronRight, ChevronDown,
  Building2, Clock, RefreshCw, X, Plane, Check, Link2, MapPin,
  TrendingUp, PhoneCall, Video, Handshake, Monitor, Navigation, Mail,
  FileText, Repeat2, ListChecks, Target, IndianRupee, Package,
  BarChart2, Circle, PauseCircle, Coffee, Layers, UserCircle,
  Users, Award, Settings, ExternalLink, ChevronUp,
} from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import SlidePanel from '@/components/ui/SlidePanel'
import Input from '@/components/ui/Input'
import { PageHeader, StatCard, useToast, FormSection, FormGrid } from '@/components/ui/FormComponents'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { useAuthStore, useUIStore } from '@/store'

// ─── Constants ────────────────────────────────────────────────────────────────
const ACTIVITY_TYPES = ['Phone Call','Video Call','In Person Meet','Demo','Site Visit','Follow Up','Email']
const STATUSES       = ['Planned','In Progress','Completed','Cancelled','Postponed']
const TRAVEL_MODES   = ['Own Vehicle','Company Vehicle','Train','Bus','Auto/Cab']

const FOLLOWUP_CATEGORIES: Record<string,string[]> = {
  'Technical':    ['Product Demo','PoC Support','Spec Clarification','Installation Support'],
  'Commercial':   ['Price Negotiation','Payment Follow-up','Order Confirmation','Quotation Review'],
  'Tender':       ['Tender Submission','Bid Clarification','Rate Revision','L1 Negotiation'],
  'Support':      ['AMC Renewal','Complaint Resolution','Escalation','SLA Review'],
  'Relationship': ['Executive Visit','Review Meeting','Reference Request','Event Invite'],
}
const CANCELLATION_REASONS = [
  'Customer unavailable','Customer rescheduled','Internal priority change',
  'Travel issue','Technical issue','Customer cancelled','Weather / force majeure','Other',
]

const TYPE_ICON: Record<string,React.ReactNode> = {
  // Current types
  'Phone Call':<PhoneCall size={13}/>,'Video Call':<Video size={13}/>,'In Person Meet':<Handshake size={13}/>,
  'Demo':<Monitor size={13}/>,'Site Visit':<Navigation size={13}/>,'Follow Up':<Repeat2 size={13}/>,'Email':<Mail size={13}/>,
  // Legacy types (for existing records)
  'Daily Call':<PhoneCall size={13}/>,'Meeting':<Handshake size={13}/>,'Follow-up':<Repeat2 size={13}/>,
  'Presentation':<Layers size={13}/>,'Proposal':<FileText size={13}/>,'Task':<ListChecks size={13}/>,
}
const TYPE_COLOR: Record<string,{bg:string;text:string;dot:string}> = {
  // Current types
  'Phone Call':{bg:'bg-blue-50',text:'text-blue-600',dot:'bg-blue-500'},
  'Video Call':{bg:'bg-cyan-50',text:'text-cyan-600',dot:'bg-cyan-500'},
  'In Person Meet':{bg:'bg-violet-50',text:'text-violet-600',dot:'bg-violet-500'},
  'Demo':{bg:'bg-emerald-50',text:'text-emerald-600',dot:'bg-emerald-500'},
  'Site Visit':{bg:'bg-orange-50',text:'text-orange-600',dot:'bg-orange-500'},
  'Follow Up':{bg:'bg-amber-50',text:'text-amber-600',dot:'bg-amber-500'},
  'Email':{bg:'bg-gray-50',text:'text-gray-500',dot:'bg-gray-400'},
  // Legacy types (for existing records)
  'Daily Call':{bg:'bg-blue-50',text:'text-blue-600',dot:'bg-blue-500'},
  'Meeting':{bg:'bg-violet-50',text:'text-violet-600',dot:'bg-violet-500'},
  'Follow-up':{bg:'bg-amber-50',text:'text-amber-600',dot:'bg-amber-500'},
  'Presentation':{bg:'bg-pink-50',text:'text-pink-600',dot:'bg-pink-500'},
  'Proposal':{bg:'bg-indigo-50',text:'text-indigo-600',dot:'bg-indigo-500'},
  'Task':{bg:'bg-red-50',text:'text-red-600',dot:'bg-red-500'},
}
const STATUS_CFG: Record<string,{bg:string;text:string;border:string;icon:React.ReactNode}> = {
  'Planned':{bg:'bg-blue-50',text:'text-blue-600',border:'border-blue-200',icon:<Circle size={10}/>},
  'In Progress':{bg:'bg-amber-50',text:'text-amber-600',border:'border-amber-200',icon:<RefreshCw size={10}/>},
  'Completed':{bg:'bg-emerald-50',text:'text-emerald-700',border:'border-emerald-200',icon:<CheckCircle size={10}/>},
  'Cancelled':{bg:'bg-red-50',text:'text-red-500',border:'border-red-200',icon:<XCircle size={10}/>},
  'Postponed':{bg:'bg-gray-100',text:'text-gray-500',border:'border-gray-200',icon:<PauseCircle size={10}/>},
}
const ROLE_CFG: Record<string,{label:string;color:string}> = {
  admin:{label:'Admin',color:'text-violet-700 bg-violet-50'},
  ceo:{label:'CEO',color:'text-sky-700 bg-sky-50'},
  vp:{label:'VP',color:'text-indigo-700 bg-indigo-50'},
  manager:{label:'Manager',color:'text-purple-700 bg-purple-50'},
  sales:{label:'Sales',color:'text-emerald-700 bg-emerald-50'},
  support:{label:'Support',color:'text-pink-700 bg-pink-50'},
  accounts:{label:'Accounts',color:'text-amber-700 bg-amber-50'},
}

const fmt = (n:number) => n>=10000000?`₹${(n/10000000).toFixed(1)}Cr`:n>=100000?`₹${(n/100000).toFixed(1)}L`:n>=1000?`₹${(n/1000).toFixed(0)}K`:`₹${n.toLocaleString('en-IN')}`
const pct = (v:number,t:number) => t>0?Math.min(100,Math.round(v/t*100)):0

const ADMIN_ROLES   = ['admin','ceo','vp','manager']
const SENIOR_ROLES  = ['admin','ceo']
const MANAGER_ROLES = ['admin','vp','manager']
const SALES_KAM_ROLES = ['vp','manager','sales']

const isSalesKAMUser = (role?: string) => SALES_KAM_ROLES.includes(String(role || '').toLowerCase())

const taskTypeName = (activity:any) => {
  const raw = String(activity?.task_type_name || activity?.activity_type || 'Task')
  const mode = String(activity?.mode || '')
  if(raw === 'Daily Call') return mode === 'Video Call' ? 'Video Call' : 'Phone Call'
  if(raw === 'Meeting') return 'In Person Meet'
  if(raw === 'Follow-up') return 'Follow Up'
  if(raw === 'Phone') return 'Phone Call'
  if(raw === 'In-Person') return 'In Person Meet'
  return raw
}
const isTravelActivityType = (activity:any) => ['In Person Meet','Meeting','Site Visit'].includes(taskTypeName(typeof activity === 'string' ? {activity_type:activity} : activity))
const modeForActivityType = (type:string) => ({
  'Phone Call':'Phone',
  'Daily Call':'Phone',
  'Video Call':'Video Call',
  'In Person Meet':'In-Person',
  'Meeting':'In-Person',
  'Site Visit':'In-Person',
  'Demo':'In-Person',
  'Email':'Email',
}[type] || 'Phone')

// ─── Micro components ─────────────────────────────────────────────────────────
function TypeBox({type,size='md'}:{type:string;size?:'sm'|'md'}) {
  const c=TYPE_COLOR[type]||{bg:'bg-gray-50',text:'text-gray-400',dot:''}
  const dim=size==='sm'?'w-7 h-7':'w-9 h-9', sz=size==='sm'?13:15
  const icons:Record<string,React.ReactNode>={
    'Phone Call':<PhoneCall size={sz}/>,'Video Call':<Video size={sz}/>,'In Person Meet':<Handshake size={sz}/>,
    'Demo':<Monitor size={sz}/>,'Site Visit':<Navigation size={sz}/>,'Follow Up':<Repeat2 size={sz}/>,'Email':<Mail size={sz}/>,
    'Daily Call':<PhoneCall size={sz}/>,'Meeting':<Handshake size={sz}/>,'Follow-up':<Repeat2 size={sz}/>,
    'Presentation':<Layers size={sz}/>,'Proposal':<FileText size={sz}/>,'Task':<ListChecks size={sz}/>,
  }
  return <div className={`${dim} rounded-xl flex items-center justify-center flex-shrink-0 ${c.bg} ${c.text}`}>{icons[type]||<Activity size={sz}/>}</div>
}
function TaskTypeChip({activity}:{activity:any}) {
  const name=taskTypeName(activity)
  const c=TYPE_COLOR[name]||{bg:'bg-gray-50',text:'text-gray-500',dot:''}
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[11px] font-semibold ${c.bg} ${c.text}`}>
      {TYPE_ICON[name]||<Activity size={11}/>}
      {name}
    </span>
  )
}
function StatusChip({status}:{status:string}) {
  const c=STATUS_CFG[status]||{bg:'bg-gray-100',text:'text-gray-500',border:'border-gray-200',icon:<Circle size={10}/>}
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border ${c.bg} ${c.text} ${c.border}`}>{c.icon}{status}</span>
}
function RoleBadge({role}:{role:string}) {
  const c=ROLE_CFG[role]||{label:role,color:'text-gray-600 bg-gray-100'}
  return <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-semibold ${c.color}`}>{c.label}</span>
}
function ProgressBar({label,value,target,color='blue'}:{label:string;value:number;target:number;color?:string}) {
  const p=target>0?Math.min(100,Math.round(value/target*100)):(value>0?100:0)
  const barColor=p>=100?'bg-emerald-500':p>=70?'bg-blue-500':p>=40?'bg-amber-500':'bg-red-400'
  return (
    <div>
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-xs text-gray-600 font-medium">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-bold text-gray-800">{value}<span className="text-gray-400 font-normal text-[11px]">/{target>0?target:'—'}</span></span>
          {target>0&&<span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-lg ${p>=100?'bg-emerald-100 text-emerald-700':p>=70?'bg-blue-100 text-blue-700':'bg-gray-100 text-gray-500'}`}>{p}%</span>}
        </div>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        {target>0?<div className={`h-full rounded-full transition-all duration-700 ${barColor}`} style={{width:`${p}%`}}/>:<div className="h-full rounded-full bg-gray-100 w-full"/>}
      </div>
    </div>
  )
}

// ─── Travel Alert ─────────────────────────────────────────────────────────────
function TravelAlertBanner({requestNumber,requestId,message,isOutside,onSubmit,onDismiss}:{
  requestNumber:string;requestId:number;message?:string;isOutside?:boolean;
  onSubmit:(id:number)=>void;onDismiss:()=>void
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

// ─── Log Activity Form ────────────────────────────────────────────────────────
function LogActivityForm({form,setForm,customers,isAdmin,isLogUpdate=false,isEdit=false,travelRequests=[],advanceDays=3}:{
  form:any;setForm:(f:any)=>void;customers:any[];isAdmin:boolean;
  isLogUpdate?:boolean;isEdit?:boolean;travelRequests?:any[];advanceDays?:number;
}) {
  const set=(k:string,v:any)=>setForm((p:any)=>({...p,[k]:v}))
  const showOutcome=form.status==='Completed'||form.status==='Cancelled'
  // Travel request section for In Person Meet/Site Visit in edit mode only
  const showTRSection = (isEdit || isLogUpdate) && isTravelActivityType(form)
  const [trMode,setTrMode]=useState<'link'|'create'>(form.travel_request_id?'link':'create')

  // Activity types that show duration + start time
  const DURATION_TYPES = ['Phone Call', 'Video Call', 'In Person Meet', 'Meeting', 'Demo']

  // Date validation: uses separate tr_travel_date (not activity_date)
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
      <FormGrid cols={2}>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1.5">Travel Date</label>
          <input type="date" value={form.tr_travel_date||linkedTR?.travel_date||''} onChange={e=>set('tr_travel_date',e.target.value)}
            className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1.5">Return Date</label>
          <input type="date" value={form.tr_return_date||linkedTR?.return_date||''} onChange={e=>set('tr_return_date',e.target.value)}
            className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
        </div>
        <SearchableSelect label="Visit Type" options={VISIT_TYPES_KAM.map(t=>({value:t,label:t}))} value={form.tr_visit_type||linkedTR?.visit_type||'Customer Visit'} onChange={v=>set('tr_visit_type',v)}/>
        <SearchableSelect label="Transport Mode" options={Object.entries(TRANSPORT_MODES_KAM).map(([v,l])=>({value:v,label:l}))} value={form.tr_transport_mode||linkedTR?.transport_mode||''} onChange={v=>set('tr_transport_mode',v)} clearable/>
        <Input label="From City" value={form.travel_from||linkedTR?.from_city||''} onChange={(v:any)=>set('travel_from',typeof v==='string'?v:v?.target?.value||'')} placeholder="Departure city"/>
        <Input label="To City" value={form.travel_to||linkedTR?.to_city||''} onChange={(v:any)=>set('travel_to',typeof v==='string'?v:v?.target?.value||'')} placeholder="Destination city"/>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1.5">Estimated Cost</label>
          <input type="text" inputMode="numeric" value={(form.tr_estimated_cost || linkedTR?.estimated_cost || linkedTR?.estimated_total) ? Number(form.tr_estimated_cost || linkedTR?.estimated_cost || linkedTR?.estimated_total).toLocaleString('en-IN') : ''} onChange={e=>set('tr_estimated_cost',e.target.value.replace(/,/g,''))}
            className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
        </div>
        <Input label="Contact Person" value={form.tr_contact_name||linkedTR?.contact_name||''} onChange={(v:any)=>set('tr_contact_name',typeof v==='string'?v:v?.target?.value||'')} placeholder="Person to meet"/>
        <Input label="Contact Phone" value={form.tr_contact_phone||linkedTR?.contact_phone||''} onChange={(v:any)=>set('tr_contact_phone',typeof v==='string'?v:v?.target?.value||'')} placeholder="+91 98765 43210"/>
      </FormGrid>
    </div>
  ) : (
    <div className="px-4 pb-4">
      <p className="text-[11px] text-gray-400 border-t border-orange-100 pt-3">Travel request can be updated only while it is Draft or Rejected.</p>
    </div>
  )

  return (
    <>
      {/* Activity type: chip only in log-update (locked), editable grid in create + edit */}
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
    <button
      key={t}
      type="button"
      onClick={() =>
        setForm((p:any) => ({
          ...p,
          activity_type: t,
          mode: modeForActivityType(t),
          task_type_name: t,
        }))
      }
      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold border-2 transition-all ${
        active
          ? `${c.bg} ${c.text} border-current/30 shadow-sm`
          : 'border-transparent bg-gray-50 text-gray-500 hover:bg-gray-100'
      }`}
    >
      <div className={`w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 ${active ? c.bg : 'bg-white'} ${active ? c.text : 'text-gray-400'}`}>
        {TYPE_ICON[t]}
      </div>
      {t}
    </button>
  )
})}
          </div>
        </FormSection>
      )}

      <FormSection title="Details">
        <FormGrid cols={2}>
          <div className="col-span-2">
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Subject / Purpose <span className="text-red-500">*</span></label>
            <input value={form.subject} onChange={e=>set('subject',e.target.value)} placeholder="Brief description…"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"/>
          </div>
          <SearchableSelect label="Customer" clearable
            options={customers.map(c=>({value:Number(c.id),label:String(c.customer_name||c.name||'')}))}
            value={form.customer_id?Number(form.customer_id):null} onChange={v=>set('customer_id',v?Number(v):null)} placeholder="Link to customer…"/>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Activity Date</label>
            <input type="date" value={form.activity_date} onChange={e=>set('activity_date',e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
          </div>
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
          {isTravelActivityType(form)&&<Input label="Location" value={form.location||''} onChange={(v:any)=>set('location',typeof v==='string'?v:v?.target?.value||'')}/>}
          {!isEdit&&<SearchableSelect label="Status" options={STATUSES.map(s=>({value:s,label:s}))} value={form.status} onChange={v=>set('status',v)}/>}
        </FormGrid>
      </FormSection>

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

      {/* Travel section — edit: In-Person + Meeting/Site Visit; log: Meeting/Site Visit; create: all */}
      {(isEdit ? isTravelActivityType(form)
               : isLogUpdate ? (!!form.travel_request_id || isTravelActivityType(form))
               : true)&&(
      <FormSection title="Travel & TA/DA">

        {/* UPDATE LOG: if TR linked → read-only summary; else → basic local travel */}
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
                <FormGrid cols={2}>
                  <Input label="From City" value={form.travel_from||''} onChange={(v:any)=>set('travel_from',typeof v==='string'?v:v?.target?.value||'')} placeholder="Departure city"/>
                  <Input label="To City" value={form.travel_to||''} onChange={(v:any)=>set('travel_to',typeof v==='string'?v:v?.target?.value||'')} placeholder="Destination city"/>
                  <div className="col-span-2">
                    <SearchableSelect label="Travel Mode" options={TRAVEL_MODES.map(t=>({value:t,label:t}))} value={form.travel_mode||''} onChange={v=>set('travel_mode',v)} clearable/>
                  </div>
                </FormGrid>
              )}
            </>
          )
        ) : (
          /* EDIT & CREATE: full travel section with TR panel for outside district */
          <>
            {(!isEdit||isTravelActivityType(form))&&(
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
                <FormGrid cols={2}>
                  <Input label="From City" value={form.travel_from||''} onChange={(v:any)=>set('travel_from',typeof v==='string'?v:v?.target?.value||'')} placeholder="Departure city"/>
                  <Input label="To City" value={form.travel_to||''} onChange={(v:any)=>set('travel_to',typeof v==='string'?v:v?.target?.value||'')} placeholder="Destination city"/>
                  <div className="col-span-2">
                    <SearchableSelect label="Travel Mode" options={TRAVEL_MODES.map(t=>({value:t,label:t}))} value={form.travel_mode||''} onChange={v=>set('travel_mode',v)} clearable/>
                  </div>
                </FormGrid>

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

                {/* Travel Date — shown after outside district is confirmed, in edit only */}
                {showTRSection&&form.is_outside_district&&!form.travel_request_id&&(
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1.5">Travel Date <span className="text-red-500">*</span></label>
                    <input type="date" value={form.tr_travel_date||''} onChange={e=>set('tr_travel_date',e.target.value)}
                      className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
                  </div>
                )}

                {/* Already linked — read-only TR summary */}
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
                      {(linkedTR?.transport_mode||form.tr_transport_mode)&&(
                        <p className="text-xs text-gray-500">{TRANSPORT_MODES_KAM[linkedTR?.transport_mode||form.tr_transport_mode]||(linkedTR?.transport_mode||form.tr_transport_mode)}</p>
                      )}
                      {(linkedTR?.visit_type||form.tr_visit_type)&&(
                        <p className="text-xs text-gray-500">Visit type: {linkedTR?.visit_type||form.tr_visit_type}</p>
                      )}
                    </div>
                    {renderTravelRequestEditor()}
                  </div>
                )}
                {/* No TR yet — link or create */}
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
                          <p className="text-[11px] text-amber-600 mt-0.5">Travel request must be raised at least {advanceDays} days before travel. Not applicable.</p>
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
                            <SearchableSelect
                              label="Search Travel Request"
                              options={travelRequests.map((r:any)=>({value:r.id,label:`${r.request_number} — ${r.from_city||''}→${r.to_city||''} (${r.travel_date||''})`}))}
                              value={form.travel_request_id||null}
                              onChange={v=>handleLinkTR(v?Number(v):null)}
                              placeholder="Select TR number…"
                              clearable/>
                            {linkedTR&&(
                              <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-xl">
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-bold text-blue-800">{linkedTR.request_number}</p>
                                  <p className="text-[11px] text-blue-600 mt-0.5">{linkedTR.from_city} → {linkedTR.to_city}</p>
                                  <p className="text-[11px] text-blue-400">{linkedTR.travel_date}{linkedTR.return_date?` → ${linkedTR.return_date}`:''}</p>
                                </div>
                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${TR_STATUS_STYLE[linkedTR.status]?.bg||'bg-gray-100'} ${TR_STATUS_STYLE[linkedTR.status]?.text||'text-gray-500'}`}>
                                  {linkedTR.status}
                                </span>
                              </div>
                            )}
                            {!linkedTR&&travelRequests.length===0&&(
                              <p className="text-[11px] text-gray-400 text-center py-2">No travel requests found. Use "Create New" to raise one.</p>
                            )}
                          </div>
                        )}

                        {trMode==='create'&&(
                          <div className="space-y-3">
                            <FormGrid cols={2}>
                              <div>
                                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Return Date</label>
                                <input type="date" value={form.tr_return_date||''} onChange={e=>set('tr_return_date',e.target.value)} min={form.activity_date||''}
                                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
                              </div>
                              <SearchableSelect label="Visit Type" options={VISIT_TYPES_KAM.map(t=>({value:t,label:t}))} value={form.tr_visit_type||'Customer Visit'} onChange={v=>set('tr_visit_type',v)}/>
                              <SearchableSelect label="Transport Mode" options={Object.entries(TRANSPORT_MODES_KAM).map(([v,l])=>({value:v,label:l}))} value={form.tr_transport_mode||''} onChange={v=>set('tr_transport_mode',v)} clearable/>
                              <div>
                                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Estimated Cost (₹)</label>
                                <input type="text" inputMode="numeric" value={form.tr_estimated_cost ? Number(form.tr_estimated_cost).toLocaleString('en-IN') : ''} onChange={e=>set('tr_estimated_cost',e.target.value.replace(/,/g,''))}
                                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
                              </div>
                              <Input label="Contact Person" value={form.tr_contact_name||''} onChange={(v:any)=>set('tr_contact_name',typeof v==='string'?v:v?.target?.value||'')} placeholder="Person to meet"/>
                              <Input label="Contact Phone" value={form.tr_contact_phone||''} onChange={(v:any)=>set('tr_contact_phone',typeof v==='string'?v:v?.target?.value||'')} placeholder="+91 98765 43210"/>
                            </FormGrid>
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                              <input type="checkbox" checked={!!form.tr_advance_required} onChange={e=>set('tr_advance_required',e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-blue-600 cursor-pointer"/>
                              <span className="text-sm font-medium text-gray-700">Request Cash Advance</span>
                            </label>
                            {form.tr_advance_required&&(
                              <div>
                                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Advance Amount (₹)</label>
                                <input type="text" inputMode="numeric" value={form.tr_advance_amount ? Number(form.tr_advance_amount).toLocaleString('en-IN') : ''} onChange={e=>set('tr_advance_amount',e.target.value.replace(/,/g,''))}
                                  className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
                              </div>
                            )}
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                              <input type="checkbox" checked={!!form.tr_accommodation_required} onChange={e=>set('tr_accommodation_required',e.target.checked)} className="w-4 h-4 rounded border-gray-300 text-blue-600 cursor-pointer"/>
                              <span className="text-sm font-medium text-gray-700">Accommodation Required</span>
                            </label>
                            {form.tr_accommodation_required&&(
                              <div className="space-y-3 p-3 bg-gray-50 rounded-xl border border-gray-200">
                                <FormGrid cols={2}>
                                  <div className="col-span-2">
                                    <SearchableSelect label="Accommodation Type"
                                      options={ACCOMMODATION_TYPES_KAM.map(t=>({value:t,label:t}))}
                                      value={form.tr_accommodation_type||'Not Required'}
                                      onChange={v=>set('tr_accommodation_type',v)}/>
                                  </div>
                                  <div className="col-span-2">
                                    <Input label="Hotel / Property Name" value={form.tr_hotel_name||''} onChange={(v:any)=>set('tr_hotel_name',typeof v==='string'?v:v?.target?.value||'')} placeholder="Hotel name"/>
                                  </div>
                                  <div>
                                    <label className="block text-xs font-semibold text-gray-600 mb-1.5">Check-in Date</label>
                                    <input type="date" value={form.tr_check_in_date||''} onChange={e=>set('tr_check_in_date',e.target.value)} min={form.tr_travel_date||''}
                                      className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
                                  </div>
                                  <div>
                                    <label className="block text-xs font-semibold text-gray-600 mb-1.5">Check-out Date</label>
                                    <input type="date" value={form.tr_check_out_date||''} onChange={e=>set('tr_check_out_date',e.target.value)} min={form.tr_check_in_date||form.tr_travel_date||''}
                                      className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
                                  </div>
                                  <div className="col-span-2">
                                    <label className="block text-xs font-semibold text-gray-600 mb-1.5">Accommodation Cost (₹)</label>
                                    <input type="text" inputMode="numeric" value={form.tr_accommodation_cost ? Number(form.tr_accommodation_cost).toLocaleString('en-IN') : ''} onChange={e=>set('tr_accommodation_cost',e.target.value.replace(/,/g,''))}
                                      className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/>
                                  </div>
                                </FormGrid>
                              </div>
                            )}
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
      </FormSection>)}

      {!isEdit&&(<FormSection title="Outcome & Next Action">
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
        <div className="space-y-3">
          <div><label className="block text-xs font-semibold text-gray-600 mb-1.5 flex items-center gap-1.5"><ArrowRight size={11}/>Next Action</label>
            <input value={form.next_action||''} onChange={e=>set('next_action',e.target.value)} placeholder="e.g. Send revised proposal by Friday"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1.5 flex items-center gap-1.5"><Calendar size={11}/>Next Action Date</label>
            <input type="date" value={form.next_action_date||''} onChange={e=>set('next_action_date',e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400"/></div>
          <div><label className="block text-xs font-semibold text-gray-600 mb-1.5 flex items-center gap-1.5"><FileText size={11}/>Internal Notes</label>
            <textarea value={form.description||''} onChange={e=>set('description',e.target.value)} rows={2}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl resize-none focus:outline-none focus:border-blue-400"/></div>
        </div>
      </FormSection>)}
    </>
  )
}

// ─── Activity Row ─────────────────────────────────────────────────────────────
function ActivityRow({a,showUser,onLog,onEdit,onViewDetail}:{a:any;showUser?:boolean;onLog:(a:any)=>void;onEdit:(a:any)=>void;onViewDetail?:(a:any)=>void}) {
  const typeName=taskTypeName(a)
  const tc=TYPE_COLOR[typeName]||{bg:'bg-gray-50',text:'text-gray-400',dot:'bg-gray-300'}
  const isDone=a.status==='Completed', isCan=a.status==='Cancelled', isOpen=!isDone&&!isCan
  return (
    <div
      className={`group bg-white rounded-2xl border transition-all hover:shadow-sm ${isDone?'border-emerald-100 bg-emerald-50/20':isCan?'border-red-100 bg-red-50/10 opacity-70':'border-gray-200 hover:border-blue-200'} ${onViewDetail?'cursor-pointer':''}`}
      onClick={()=>onViewDetail&&onViewDetail(a)}
    >
      <div className={`h-0.5 rounded-t-2xl ${tc.dot}`}/>
      <div className="flex items-start gap-3 px-4 py-3">
        <TypeBox type={typeName}/>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className={`text-sm font-semibold truncate ${isCan?'line-through text-gray-400':'text-gray-900'}`}>{a.subject}</p>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <TaskTypeChip activity={a}/>
                {a.customer_name&&<span className="text-xs text-gray-400 flex items-center gap-0.5"><Building2 size={10}/>{a.customer_name}</span>}
                {showUser&&a.user_name&&<span className="text-xs text-blue-500 flex items-center gap-0.5"><UserCircle size={10}/>{a.user_name}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <StatusChip status={a.status}/>
              <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1.5" onClick={e=>e.stopPropagation()}>
                {isOpen&&<button onClick={()=>onLog(a)} className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 font-semibold transition-colors"><Edit3 size={10}/>Update Log</button>}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5">
            <span className="text-[11px] text-gray-400 flex items-center gap-1"><Calendar size={10}/>{a.activity_date}</span>
            {a.duration_minutes>0&&<span className="text-[11px] text-gray-400 flex items-center gap-1"><Clock size={10}/>{a.duration_minutes}m</span>}
            {a.has_travel&&(
              <span className={`text-[11px] flex items-center gap-1 font-medium ${a.is_outside_district?'text-orange-500':'text-gray-400'}`}>
                {a.is_outside_district?<Plane size={10}/>:<Car size={10}/>}
                {a.is_outside_district?`Outside district${a.travel_request_number?' · '+a.travel_request_number:''}`:'Local travel'}
              </span>
            )}
            {a.travel_request_status&&(
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${TR_STATUS_STYLE[a.travel_request_status]?.bg||'bg-gray-100'} ${TR_STATUS_STYLE[a.travel_request_status]?.text||'text-gray-500'}`}>
                {a.travel_request_status}
              </span>
            )}
          </div>
          {a.outcome&&<p className={`mt-2 text-xs px-3 py-2 rounded-xl leading-relaxed border ${isDone?'bg-emerald-50 text-emerald-700 border-emerald-100':'bg-red-50 text-red-600 border-red-100'}`}>{a.outcome}</p>}
          {a.next_action&&<p className="mt-1.5 text-xs text-gray-400 flex items-center gap-1.5 italic"><ArrowRight size={11} className="text-blue-400 flex-shrink-0"/>{a.next_action}{a.next_action_date&&<span className="text-blue-500 font-semibold not-italic ml-1">{a.next_action_date}</span>}</p>}
        </div>
      </div>
    </div>
  )
}

// ─── Log Modal ────────────────────────────────────────────────────────────────
function LogSlidePanel({activity,customers,isAdmin,onSave,onClose,saving}:{
  activity:any;customers:any[];isAdmin:boolean;onSave:(f:any)=>void;onClose:()=>void;saving:boolean
}) {
  const [form,setForm]=useState<any>({...emptyActForm(),...activity,status:'Completed',outcome:activity?.outcome||''})
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

  const STATUS_COLOR:Record<string,string>={
    'Completed':'bg-emerald-600 hover:bg-emerald-700',
    'Cancelled':'bg-red-500 hover:bg-red-600',
    'Postponed':'bg-gray-500 hover:bg-gray-600',
    'In Progress':'bg-blue-600 hover:bg-blue-700',
  }
  const canSave=form.status==='Completed'?form.outcome?.trim().length>0
    :form.status==='Cancelled'?(form.cancellation_reason?.trim().length>0||form.outcome?.trim().length>0)
    :form.subject?.trim().length>0

  return (
    <SlidePanel
      open={true}
      onClose={onClose}
      title="Update Activity Log"
      subtitle={<span className="flex items-center gap-2 text-xs text-gray-500 mt-0.5"><Edit3 size={11}/>{activity?.subject}</span>}
      width="w-full"
      insetLeft="var(--sidebar-w, 220px)"
      tabBar={
        <div className="flex items-center gap-2 py-2.5">
          <span className="text-xs text-gray-400 font-medium mr-1">Mark as:</span>
          {(['Completed','In Progress','Postponed','Cancelled'] as const).map(s=>(
            <button key={s} type="button" onClick={()=>setForm((p:any)=>({...p,status:s}))}
              className={`text-xs px-3 py-1.5 rounded-lg font-semibold transition-all border ${
                form.status===s
                  ? STATUS_COLOR[s]+' text-white border-transparent shadow-sm'
                  : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>
              {s}
            </button>
          ))}
        </div>
      }
      footer={
        <>
          <Button variant="cancel" onClick={onClose}>Cancel</Button>
          <button onClick={()=>canSave&&onSave(form)} disabled={!canSave||saving}
            className={`px-5 py-2.5 text-sm rounded-xl font-semibold text-white disabled:opacity-40 transition-colors flex items-center gap-2 ${STATUS_COLOR[form.status]||'bg-blue-600 hover:bg-blue-700'}`}>
            {saving&&<div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"/>}Save Log
          </button>
        </>
      }
    >
      <LogActivityForm form={form} setForm={setForm} customers={customers} isAdmin={isAdmin}
        isLogUpdate={true} travelRequests={travelRequests} advanceDays={advanceDays}/>
    </SlidePanel>
  )
}

// ─── Set Target Modal ─────────────────────────────────────────────────────────
function SetTargetModal({teamMembers,period,onSave,onClose,saving}:{
  teamMembers:any[];period:string;onSave:(data:any)=>void;onClose:()=>void;saving:boolean
}) {
  const [form,setForm]=useState({user_id:'',period,calls_target:0,meetings_target:0,demos_target:0,site_visits_target:0,sales_target:0})
  const set=(k:string,v:any)=>setForm(p=>({...p,[k]:v}))
  const canSave=!!form.user_id
  const assignable=teamMembers.filter((u:any)=>isSalesKAMUser(u.role))
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-indigo-50 to-violet-50">
          <div className="w-9 h-9 rounded-xl bg-indigo-100 flex items-center justify-center flex-shrink-0"><Target size={16} className="text-indigo-600"/></div>
          <div className="flex-1"><h3 className="font-semibold text-gray-900">Set Sales Target</h3><p className="text-xs text-gray-500 mt-0.5">Assign sales target for the period</p></div>
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
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Period</label>
            <input type="month" value={form.period} onChange={e=>set('period',e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-indigo-400"/>
          </div>
          <div className="bg-gradient-to-br from-indigo-50 to-violet-50 rounded-xl p-4 border border-indigo-100">
            <label className="block text-xs font-bold text-indigo-700 mb-2 flex items-center gap-1.5"><IndianRupee size={12}/>Sales Revenue Target</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500 font-semibold">₹</span>
              <input type="text" inputMode="numeric"
                value={form.sales_target ? Number(form.sales_target).toLocaleString('en-IN') : ''}
                onChange={e=>set('sales_target',parseFloat(e.target.value.replace(/,/g,''))||0)}
                placeholder="e.g. 1,00,00,000 for 1 Cr"
                className="w-full pl-7 pr-3 py-2.5 text-sm border border-indigo-200 rounded-xl focus:outline-none focus:border-indigo-500 bg-white font-semibold"/>
            </div>
            {form.sales_target>0&&<p className="text-xs text-indigo-600 font-semibold mt-1.5 flex items-center gap-1"><Award size={11}/>{fmt(form.sales_target)} sales target</p>}
          </div>
        </div>
        <div className="flex gap-2.5 px-5 py-4 border-t border-gray-100">
          <button onClick={onClose} className="flex-1 py-2.5 text-sm rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium">Cancel</button>
          <button onClick={()=>canSave&&onSave({...form,user_id:parseInt(form.user_id)})} disabled={!canSave||saving}
            className="flex-1 py-2.5 text-sm rounded-xl font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 flex items-center justify-center gap-2">
            {saving&&<div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"/>}Set Target
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Plan Day Panel ───────────────────────────────────────────────────────────
interface PlanRow{id:string;customer_id:number|null;activity_type:string;subject:string;on_behalf_of:number|null}
const emptyPlanRow=():PlanRow=>({id:Math.random().toString(36).slice(2),customer_id:null,activity_type:'Phone Call',subject:'',on_behalf_of:null})

function PlanDayPanel({teamMembers,currentUserRole,currentUserId,onSaveAll,saving,onClose}:{
  teamMembers:any[];currentUserRole:string;currentUserId:number;
  onSaveAll:(date:string,rows:PlanRow[])=>Promise<void>;saving:boolean;onClose:()=>void
}) {
  const [planDate,setDate]=useState(new Date().toISOString().slice(0,10))
  const [assignToAll,setAssign]=useState<number|null>(null)
  const [customers,setCustomers]=useState<any[]>([])
  const [loadingC,setLoadingC]=useState(false)
  const [rows,setRows]=useState<PlanRow[]>([emptyPlanRow(),emptyPlanRow()])
  const canAssignTeam=MANAGER_ROLES.includes(currentUserRole)
  const assignableTeam=teamMembers.filter(u=>!['ceo','admin'].includes(u.role))

  const loadCustomers=useCallback(async(uid:number|null)=>{
    setLoadingC(true)
    try{const r=await api.get('/kam/plan-customers',{params:uid?{user_id:uid}:{}});setCustomers(Array.isArray(r.data)?r.data:[])}
    catch{setCustomers([])}finally{setLoadingC(false)}
  },[])
  useEffect(()=>{loadCustomers(assignToAll)},[assignToAll])

  const custOpts=customers.map(c=>({value:Number(c.id),label:String(c.customer_name||c.name||'')}))
  const setRow=(id:string,k:keyof PlanRow,v:any)=>setRows(p=>p.map(r=>r.id===id?{...r,[k]:v}:r))
  const addRow=()=>setRows(p=>[...p,emptyPlanRow()])
  const removeRow=(id:string)=>setRows(p=>p.filter(r=>r.id!==id))
  const dupRow=(row:PlanRow)=>setRows(p=>{const i=p.findIndex(r=>r.id===row.id);const nr={...row,id:Math.random().toString(36).slice(2),subject:''};const n=[...p];n.splice(i+1,0,nr);return n})
  const validRows=rows.filter(r=>r.subject.trim()&&r.customer_id)

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-4 border-b border-gray-100 bg-gray-50/60 flex-shrink-0 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div><label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Plan Date</label>
            <input type="date" value={planDate} onChange={e=>setDate(e.target.value)} className="text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:border-blue-400 bg-white font-semibold"/></div>
          {canAssignTeam&&assignableTeam.length>1&&(
            <div className="flex-1 min-w-[200px]"><label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Assign All To</label>
              <div className="flex items-center gap-2">
                <div className="flex-1"><SearchableSelect options={[{value:null as any,label:'Myself (default)'},...assignableTeam.filter(u=>u.id!==currentUserId).map(u=>({value:u.id,label:u.full_name,subtitle:u.role}))]}
                  value={assignToAll} onChange={v=>setAssign(v as number|null)} placeholder="Myself" clearable/></div>
                <button onClick={()=>setRows(p=>p.map(r=>({...r,on_behalf_of:assignToAll})))} className="text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-2 rounded-xl font-semibold whitespace-nowrap">Apply</button>
              </div>
            </div>
          )}
        </div>
        <p className="text-xs text-gray-400">{loadingC?'Loading…':`${custOpts.length} customers`} · {validRows.length} of {rows.length} rows ready</p>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {rows.map((row,idx)=>{
          const filled=!!row.subject.trim()&&!!row.customer_id
          return (
            <div key={row.id} className={`bg-white rounded-2xl border-2 transition-all ${filled?'border-gray-200 hover:border-blue-200':'border-dashed border-gray-200'}`}>
              <div className="flex items-center gap-2 px-3 pt-3 pb-2">
                <span className="w-5 h-5 rounded-full bg-gray-100 text-[10px] font-bold text-gray-500 flex items-center justify-center flex-shrink-0">{idx+1}</span>
                <div className="flex flex-wrap gap-1 flex-1">
                  {ACTIVITY_TYPES.map(t=>{const c=TYPE_COLOR[t]||{bg:'bg-gray-50',text:'text-gray-500',dot:''};return(
                    <button key={t} type="button" onClick={()=>setRow(row.id,'activity_type',t)} title={t}
                      className={`flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-[10px] font-semibold border transition-all ${row.activity_type===t?`${c.bg} ${c.text} border-current/30`:'border-gray-200 bg-white text-gray-400 hover:border-gray-300'}`}>
                      {TYPE_ICON[t]}{t}</button>
                  )})}
                </div>
                <button onClick={()=>dupRow(row)} className="p-1 rounded-lg hover:bg-gray-100 text-gray-300 hover:text-gray-500 flex-shrink-0"><Plus size={13}/></button>
                <button onClick={()=>rows.length>1&&removeRow(row.id)} className={`p-1 rounded-lg flex-shrink-0 ${rows.length>1?'hover:bg-red-50 text-gray-300 hover:text-red-400':'text-gray-200 cursor-not-allowed'}`}><X size={13}/></button>
              </div>
              <div className="grid grid-cols-2 gap-2 px-3 pb-3">
                <SearchableSelect options={custOpts} value={row.customer_id?Number(row.customer_id):null}
                  onChange={v=>setRow(row.id,'customer_id',v?Number(v):null)}
                  placeholder={loadingC?'Loading…':custOpts.length===0?'No customers':'Customer *'} clearable/>
                <input value={row.subject} onChange={e=>setRow(row.id,'subject',e.target.value)} placeholder="Subject / purpose *"
                  className="w-full px-2.5 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-blue-400 placeholder-gray-300"/>
                {canAssignTeam&&assignableTeam.length>1&&(
                  <div className="col-span-2">
                    <SearchableSelect options={[{value:null as any,label:'Myself'},...assignableTeam.filter(u=>u.id!==currentUserId).map(u=>({value:u.id,label:u.full_name,subtitle:u.role}))]}
                      value={row.on_behalf_of} onChange={v=>setRow(row.id,'on_behalf_of',v)} placeholder="Assign to (default: myself)" clearable/>
                  </div>
                )}
              </div>
            </div>
          )
        })}
        <button onClick={addRow} className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-gray-200 rounded-2xl text-xs text-gray-400 hover:text-blue-500 hover:border-blue-300 hover:bg-blue-50/30 transition-all font-semibold">
          <Plus size={14}/>Add Another Activity
        </button>
      </div>
      <div className="px-5 py-4 border-t border-gray-100 bg-gray-50/60 flex-shrink-0 flex items-center justify-between gap-3">
        <div className="text-xs text-gray-400">{validRows.length>0?<span className="text-emerald-600 font-semibold flex items-center gap-1"><CheckCircle size={12}/>{validRows.length} activit{validRows.length!==1?'ies':'y'} ready for {planDate}</span>:<span>Fill customer + subject to plan</span>}</div>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="px-4 py-2.5 text-sm rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium">Cancel</button>
          <Button onClick={()=>{if(validRows.length===0)return;onSaveAll(planDate,validRows)}} loading={saving} disabled={validRows.length===0}>
            <Calendar size={14} className="mr-1.5 inline-block"/>Plan {validRows.length>1?`${validRows.length} Activities`:'Activity'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Customer List Popup ──────────────────────────────────────────────────────
function CustomerListPopup({customers,onClose}:{customers:any[];onClose:()=>void}) {
  const [search,setSearch]=useState('')
  const filtered=customers.filter(c=>!search||c.customer_name?.toLowerCase().includes(search.toLowerCase())||c.city?.toLowerCase().includes(search.toLowerCase())||c.vertical?.toLowerCase().includes(search.toLowerCase()))
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white w-full max-w-lg max-h-[80vh] rounded-2xl shadow-2xl flex flex-col" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <div className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center flex-shrink-0"><Building2 size={16} className="text-slate-600"/></div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-900">My Customers</h3>
            <p className="text-xs text-gray-400 mt-0.5">{customers.length} customers from customers &amp; leads</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18}/></button>
        </div>
        <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
          <div className="relative">
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search by name, city, vertical…"
              className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:border-blue-400 pr-7"/>
            {search&&<button onClick={()=>setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"><X size={12}/></button>}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5">
          {filtered.length===0?(
            <div className="py-10 text-center">
              <Building2 size={24} className="mx-auto text-gray-200 mb-2"/>
              <p className="text-sm text-gray-400">No customers found</p>
            </div>
          ):filtered.map((c:any)=>(
            <div key={c.id} className="flex items-center gap-3 px-3 py-2.5 bg-gray-50 rounded-xl hover:bg-blue-50/40 transition-colors">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0">
                {c.customer_name?.substring(0,2)?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800 truncate">{c.customer_name}</p>
                {(c.city||c.vertical)&&<p className="text-[11px] text-gray-400 truncate">{[c.city,c.vertical].filter(Boolean).join(' · ')}</p>}
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded-lg font-semibold flex-shrink-0 ${c.source==='lead'?'bg-violet-50 text-violet-600':'bg-blue-50 text-blue-600'}`}>
                {c.source==='lead'?'Lead':'Customer'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Activity Detail Popup ────────────────────────────────────────────────────
function ActivityDetailPopup({activity,onClose,onLog,onEdit}:{activity:any;onClose:()=>void;onLog:(a:any)=>void;onEdit:(a:any)=>void}) {
  const typeName=taskTypeName(activity)
  const tc=TYPE_COLOR[typeName]||{bg:'bg-gray-50',text:'text-gray-400',dot:'bg-gray-300'}
  const isDone=activity.status==='Completed', isCan=activity.status==='Cancelled', isOpen=!isDone&&!isCan
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl flex flex-col" onClick={e=>e.stopPropagation()}>
        <div className={`h-1 rounded-t-2xl ${tc.dot}`}/>
        <div className="flex items-start gap-3 px-5 py-4 border-b border-gray-100">
          <TypeBox type={typeName} size="md"/>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-gray-900 leading-snug">{activity.subject}</p>
            {activity.customer_name&&<p className="text-xs text-gray-400 mt-0.5 flex items-center gap-1"><Building2 size={10}/>{activity.customer_name}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0 mt-0.5"><X size={18}/></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <TaskTypeChip activity={activity}/>
            <StatusChip status={activity.status}/>
            {activity.activity_date&&<span className="text-xs text-gray-400 flex items-center gap-1"><Calendar size={10}/>{activity.activity_date}</span>}
            {activity.duration_minutes>0&&<span className="text-xs text-gray-400 flex items-center gap-1"><Clock size={10}/>{activity.duration_minutes}m</span>}
          </div>
          {activity.location&&<p className="text-xs text-gray-500 flex items-center gap-1.5"><Navigation size={11} className="text-gray-400"/>{activity.location}</p>}
          {activity.has_travel&&(
            <p className={`text-xs flex items-center gap-1.5 font-medium ${activity.is_outside_district?'text-orange-600':'text-gray-500'}`}>
              {activity.is_outside_district?<Plane size={11}/>:<Car size={11}/>}
              {activity.is_outside_district?`Outside district${activity.travel_request_number?' · '+activity.travel_request_number:''}`:'Local travel'}
            </p>
          )}
          {(activity.outcome||activity.cancellation_reason)&&(
            <div className={`px-3 py-2.5 rounded-xl text-xs leading-relaxed border ${isDone?'bg-emerald-50 text-emerald-700 border-emerald-100':'bg-red-50 text-red-600 border-red-100'}`}>
              <p className="font-semibold mb-1">{isCan?'Cancellation':'Outcome'}</p>
              {activity.cancellation_reason&&<p className="mb-1 font-medium">{activity.cancellation_reason}</p>}
              {activity.outcome&&<p>{activity.outcome}</p>}
            </div>
          )}
          {activity.next_action&&(
            <div className="flex items-start gap-2 px-3 py-2.5 bg-blue-50 rounded-xl border border-blue-100">
              <ArrowRight size={12} className="text-blue-400 flex-shrink-0 mt-0.5"/>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-blue-700">Next Action</p>
                <p className="text-xs text-blue-600 mt-0.5">{activity.next_action}</p>
                {activity.next_action_date&&<p className="text-[11px] text-blue-500 font-semibold mt-1">{activity.next_action_date}</p>}
              </div>
            </div>
          )}
          {activity.description&&<p className="text-xs text-gray-500 bg-gray-50 px-3 py-2.5 rounded-xl leading-relaxed">{activity.description}</p>}
          {activity.user_name&&<p className="text-[11px] text-gray-400 flex items-center gap-1"><UserCircle size={11}/>{activity.user_name}</p>}
        </div>
        {isOpen&&(
          <div className="flex gap-2 px-5 pb-4 flex-shrink-0">
            <button onClick={()=>{onClose();onEdit(activity)}} className="flex-1 py-2 text-xs border border-gray-200 rounded-xl text-gray-600 hover:bg-gray-50 font-medium">Edit</button>
            <button onClick={()=>{onClose();onLog(activity)}} className="flex-1 py-2 text-xs bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-semibold">Update Log</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── KAM 360 Tab ──────────────────────────────────────────────────────────────
function KAM360Tab({myRole,myId,teamMembers,period,setPeriod,isYearly,setIsYearly,viewYear,setViewYear,onNavigate,onLogActivity,onEditActivity}:{
  myRole:string;myId:number;teamMembers:any[];period:string;setPeriod:(s:string)=>void;
  isYearly:boolean;setIsYearly:(b:boolean)=>void;viewYear:number;setViewYear:(n:number)=>void;
  onNavigate:(module:string,params?:any)=>void;
  onLogActivity:(a:any)=>void;
  onEditActivity:(a:any)=>void;
}) {
  const isAdmin   = ADMIN_ROLES.includes(myRole)
  const canSetTgt = MANAGER_ROLES.includes(myRole)||SENIOR_ROLES.includes(myRole)
  const navigate  = useNavigate()

  const [selectedUid,setSelectedUid]         = useState<number|null>(null)
  // ── NEW: customer filter for 360 tab ──────────────────────────────────────
  const [selectedCustId,setSelectedCustId]   = useState<number|null>(null)
  const [summary,setSummary]                 = useState<any>(null)
  const [custActs,setCustActs]               = useState<any[]>([])
  const [teamRows,setTeamRows]               = useState<any[]>([])
  const [perf,setPerf]                       = useState<any>(null)
  const [loading,setLoading]                 = useState(true)
  const [custSearch,setCustSearch]           = useState('')
  const [showTargetModal,setShowTargetModal] = useState(false)
  const [savingTarget,setSavingTarget]       = useState(false)
  const [expandedMember,setExpandedMember]   = useState<number|null>(null)
  const [actTypeFilter,setActTypeFilter]     = useState<string|null>(null)

  const [custPopup,setCustPopup]             = useState(false)
  const [popupCustomers,setPopupCustomers]   = useState<any[]>([])
  const [actDetailPopup,setActDetailPopup]   = useState<any>(null)
  const [leadPanel,setLeadPanel]             = useState(false)
  const [tenderPanel,setTenderPanel]         = useState(false)
  const [panelLeads,setPanelLeads]           = useState<any[]>([])
  const [panelTenders,setPanelTenders]       = useState<any[]>([])
  const [panelLoading,setPanelLoading]       = useState(false)
  const [panelMemberName,setPanelMemberName] = useState<string>('')

  const { success, error:showError } = useToast()

  const params = {
    user_id:   selectedUid||undefined,
    period,
    view_type: isYearly?'yearly':'monthly',
    year:      viewYear,
  }

  const load = useCallback(async()=>{
    setLoading(true)
    try{
      const calls:any[]=[
        api.get('/kam/360-summary',{params}),
        api.get('/kam/customer-activities',{params}),
        api.get('/kam/performance',{params}),
        api.get('/kam/plan-customers',{params:selectedUid?{user_id:selectedUid}:{}}),
      ]
      if(isAdmin) calls.push(api.get('/kam/team-360',{params:{period,view_type:isYearly?'yearly':'monthly',year:viewYear}}))
      const results=await Promise.allSettled(calls)
      if(results[0].status==='fulfilled') setSummary(results[0].value.data)
      if(results[1].status==='fulfilled') setCustActs(results[1].value.data)
      if(results[2].status==='fulfilled') setPerf(results[2].value.data)
      if(results[3].status==='fulfilled') setPopupCustomers(results[3].value.data||[])
      if(isAdmin&&results[4]?.status==='fulfilled') setTeamRows(results[4].value.data?.members||[])
    }catch{showError('Failed to load 360 data')}
    finally{setLoading(false)}
  },[period,selectedUid,isYearly,viewYear,isAdmin])

  useEffect(()=>{load()},[load])

  const openLeadPanel = async (userId?: number, memberName?: string) => {
    setPanelMemberName(memberName || '')
    setPanelLeads([])
    setLeadPanel(true)
    setPanelLoading(true)
    try {
      const params: any = {}
      const rawUid = userId !== undefined ? userId : selectedUid
      const uid = rawUid ? Number(rawUid) : null
      if (uid) params.assigned_to = uid
      const r = await api.get('/leads', { params })
      let leads = Array.isArray(r.data) ? r.data : []
      // Frontend fallback filter: if uid given, filter by assigned_to id or name
      if (uid) {
        leads = leads.filter((l: any) =>
          l.assigned_to === uid ||
          (memberName && (l.assigned_to_name || '').toLowerCase() === memberName.toLowerCase())
        )
      }
      setPanelLeads(leads)
    } catch (e: any) {
      const msg = e?.response?.data?.detail
      showError(typeof msg === 'string' ? msg : 'Failed to load leads')
    }
    finally { setPanelLoading(false) }
  }

  const openTenderPanel = async (userId?: number, memberName?: string) => {
    setPanelMemberName(memberName || '')
    setPanelTenders([])
    setTenderPanel(true)
    setPanelLoading(true)
    try {
      const params: any = { per_page: 500, page: 1 }
      const rawUid = userId !== undefined ? userId : selectedUid
      const uid = rawUid ? Number(rawUid) : null
      if (uid) params.assigned_to = uid
      const r = await api.get('/tenders/', { params })
      const items = Array.isArray(r.data?.items) ? r.data.items : Array.isArray(r.data) ? r.data : []
      setPanelTenders(items)
    } catch (e: any) {
      const msg = e?.response?.data?.detail
      showError(typeof msg === 'string' ? msg : 'Failed to load tenders')
    }
    finally { setPanelLoading(false) }
  }

  const openLeadPanelByCustomer = async (customerId: number, customerName: string) => {
    setPanelMemberName(customerName)
    setPanelLeads([])
    setLeadPanel(true)
    setPanelLoading(true)
    try {
      const r = await api.get('/leads', { params: { customer_id: customerId } })
      const leads = Array.isArray(r.data) ? r.data : []
      setPanelLeads(leads.filter((l: any) => l.customer_id === customerId))
    } catch (e: any) {
      const msg = e?.response?.data?.detail
      showError(typeof msg === 'string' ? msg : 'Failed to load leads')
    } finally { setPanelLoading(false) }
  }

  const openTenderPanelByCustomer = async (customerId: number, customerName: string) => {
    setPanelMemberName(customerName)
    setPanelTenders([])
    setTenderPanel(true)
    setPanelLoading(true)
    try {
      const r = await api.get('/tenders/', { params: { customer_id: customerId, per_page: 500, page: 1 } })
      const items = Array.isArray(r.data?.items) ? r.data.items : Array.isArray(r.data) ? r.data : []
      setPanelTenders(items.filter((t: any) => t.customer_id === customerId))
    } catch (e: any) {
      const msg = e?.response?.data?.detail
      showError(typeof msg === 'string' ? msg : 'Failed to load tenders')
    } finally { setPanelLoading(false) }
  }

  const saveTarget=async(data:any)=>{
    setSavingTarget(true)
    try{await api.post('/kam/targets',data);success('Target set successfully');setShowTargetModal(false);load()}
    catch(e:any){showError(e.response?.data?.detail||'Failed')}
    finally{setSavingTarget(false)}
  }

  const perfStats = perf?.actuals    ||{}
  const targets   = perf?.targets    ||{}
  const quarterly = perf?.quarterly  ||[]
  const salesTeamMembers = teamMembers.filter((u:any)=>isSalesKAMUser(u.role))
  const salesTeamRows = teamRows.filter((m:any)=>isSalesKAMUser(m.role))

  useEffect(()=>{
    if(selectedUid && !teamMembers.some((u:any)=>u.id===selectedUid&&isSalesKAMUser(u.role))) setSelectedUid(null)
  },[selectedUid,teamMembers])

  // ── Apply customer filter on top of existing search ──────────────────────
  const filteredCusts = custActs.filter(c=>{
    const matchSearch=!custSearch||c.customer_name?.toLowerCase().includes(custSearch.toLowerCase())
    const matchCust=!selectedCustId||c.customer_id===selectedCustId
    return matchSearch&&matchCust
  })

  const s=summary||{}
  const salesPct = s.sales_target>0 ? pct(s.won_tender_value||0, s.sales_target) : 0

  // ── Helper: compute date range for navigation ─────────────────────────────
  const getDateRange=()=>{
    if(isYearly) return {dateFrom:`${viewYear}-01-01`,dateTo:`${viewYear}-12-31`}
    const [y,m]=period.split('-').map(Number)
    const lastDay=new Date(y,m,0).getDate()
    return {dateFrom:`${period}-01`,dateTo:`${period}-${String(lastDay).padStart(2,'0')}`}
  }

  return (
    <div className="space-y-5">
      {showTargetModal&&<SetTargetModal teamMembers={salesTeamMembers} period={period} onSave={saveTarget} onClose={()=>setShowTargetModal(false)} saving={savingTarget}/>}
      {custPopup&&<CustomerListPopup customers={popupCustomers} onClose={()=>setCustPopup(false)}/>}

      {/* ── Leads slide panel ── */}
      <SlidePanel open={leadPanel} onClose={()=>setLeadPanel(false)}
        title={panelMemberName ? `${panelMemberName}'s Leads` : 'Leads'} subtitle={`${panelLeads.length} leads`} width="w-[640px]"
        footer={<><Button onClick={()=>navigate('/leads')}>View All Leads</Button><Button onClick={()=>setLeadPanel(false)}>Close</Button></>}>
        {panelLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-400">
            <div className="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin"/>Loading…
          </div>
        ) : panelLeads.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">No leads found</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {panelLeads.map((l:any) => (
              <div key={l.id} className="flex items-start gap-3 px-5 py-3.5 hover:bg-gray-50/60">
                <div className="w-8 h-8 rounded-xl bg-violet-100 flex items-center justify-center flex-shrink-0 text-violet-600"><TrendingUp size={14}/></div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{l.lead_title||l.lead_name||'—'}</p>
                  <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5"><Building2 size={10}/>{l.customer_name||'—'}</p>
                  {l.assigned_to_name && (
                    <p className="text-xs text-indigo-500 flex items-center gap-1 mt-0.5">
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                      {l.assigned_to_name}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full
                    ${l.status==='Converted'?'bg-emerald-100 text-emerald-700':l.status==='Lost'?'bg-red-100 text-red-600':'bg-blue-100 text-blue-700'}`}>
                    {l.status}
                  </span>
                  <span className="text-sm font-bold text-gray-800">{(l.est_value||l.lead_value||0)>0?fmt(l.est_value||l.lead_value):'—'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </SlidePanel>

      {/* ── Tenders slide panel ── */}
      <SlidePanel open={tenderPanel} onClose={()=>setTenderPanel(false)}
        title={panelMemberName ? `${panelMemberName}'s Tenders` : 'Tenders'} subtitle={`${panelTenders.length} tenders`} width="w-[640px]"
        footer={<><Button onClick={()=>navigate('/tenders')}>View All Tenders</Button><Button onClick={()=>setTenderPanel(false)}>Close</Button></>}>
        {panelLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-gray-400">
            <div className="w-4 h-4 border-2 border-orange-400 border-t-transparent rounded-full animate-spin"/>Loading…
          </div>
        ) : panelTenders.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-400">No tenders found</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {panelTenders.map((t:any) => (
              <div key={t.id} className="flex items-start gap-3 px-5 py-3.5 hover:bg-gray-50/60">
                <div className="w-8 h-8 rounded-xl bg-orange-100 flex items-center justify-center flex-shrink-0 text-orange-600"><FileText size={14}/></div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{t.tender_title||'—'}</p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-xs text-gray-500 flex items-center gap-1"><Building2 size={10}/>{t.customer_name||'—'}</span>
                    {t.tender_num && <span className="text-xs text-white font-mono bg-gray-700 px-1.5 py-0.5 rounded font-semibold">{t.tender_num}</span>}
                  </div>
                  {t.assigned_to_name && (
                    <p className="text-xs text-indigo-500 flex items-center gap-1 mt-0.5">
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                      {t.assigned_to_name}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full
                    ${t.tender_status==='Won'?'bg-emerald-100 text-emerald-700':t.tender_status==='Lost'?'bg-red-100 text-red-600':t.tender_status==='Submitted'?'bg-blue-100 text-blue-700':'bg-amber-100 text-amber-700'}`}>
                    {t.tender_status||'—'}
                  </span>
                  <span className="text-sm font-bold text-gray-800">{(t.est_value||0)>0?fmt(t.est_value):'—'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </SlidePanel>
      {actDetailPopup&&(
        <ActivityDetailPopup
          activity={actDetailPopup}
          onClose={()=>setActDetailPopup(null)}
          onLog={a=>{setActDetailPopup(null);onLogActivity(a)}}
          onEdit={a=>{setActDetailPopup(null);onEditActivity(a)}}
        />
      )}

      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-bold text-gray-800 flex items-center gap-2"><BarChart2 size={16} className="text-blue-500"/>KAM 360 Dashboard</h2>
          {perf?.user_name&&<p className="text-xs text-gray-400 mt-0.5">{perf.is_aggregate?<span className="text-blue-600 font-semibold">All Team Members</span>:`${perf.user_name} · ${perf.user_role}`}</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canSetTgt&&(
            <button onClick={()=>setShowTargetModal(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-indigo-50 text-indigo-600 hover:bg-indigo-100 rounded-xl font-semibold border border-indigo-100 transition-colors">
              <Target size={12}/>Set Target
            </button>
          )}
          <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-1">
            <button onClick={()=>setIsYearly(false)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${!isYearly?'bg-white text-gray-800 shadow-sm':'text-gray-500'}`}>Monthly</button>
            <button onClick={()=>setIsYearly(true)}  className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${isYearly?'bg-white text-gray-800 shadow-sm':'text-gray-500'}`}>Yearly</button>
          </div>
          {isYearly
            ?<input type="number" value={viewYear} onChange={e=>setViewYear(parseInt(e.target.value)||new Date().getFullYear())} min={2020} max={2035} className="text-xs border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:border-blue-400 bg-white w-20"/>
            :<input type="month" value={period} onChange={e=>setPeriod(e.target.value)} className="text-xs border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:border-blue-400 bg-white"/>
          }
          {/* ── Customer filter for 360 tab ─────────────────────────────── */}
          {popupCustomers.length>0&&(
            <select
              value={selectedCustId||''}
              onChange={e=>setSelectedCustId(e.target.value?parseInt(e.target.value):null)}
              className="text-xs border border-gray-200 rounded-xl px-2.5 py-2 focus:outline-none focus:border-blue-400 bg-white max-w-[160px]"
            >
              <option value="">All Customers</option>
              {popupCustomers.map((c:any)=><option key={c.id} value={c.id}>{c.customer_name}</option>)}
            </select>
          )}
          {isAdmin&&salesTeamMembers.length>0&&(
            <select value={selectedUid||''} onChange={e=>{const v=e.target.value?parseInt(e.target.value):null;setSelectedUid(v);setExpandedMember(v)}}
              className={`text-xs border rounded-xl px-2.5 py-2 focus:outline-none focus:border-blue-400 bg-white ${selectedUid?'border-blue-300 bg-blue-50 text-blue-700':'border-gray-200'}`}>
              <option value="">All Sales Members</option>
              {salesTeamMembers.map((u:any)=><option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* ── Sales Target Progress ─────────────────────────────────────────── */}
      {(s.sales_target>0||canSetTgt||myRole==='sales')&&(
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2"><Award size={14} className="text-amber-500"/>Sales Revenue Target</h3>
            {canSetTgt&&(
              <button onClick={()=>setShowTargetModal(true)} className="text-xs text-indigo-600 hover:text-indigo-700 font-semibold flex items-center gap-1">
                <Settings size={11}/>Manage
              </button>
            )}
          </div>
          {s.sales_target>0?(
            <>
              <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
                <span>Revenue Achievement (Won Tenders)</span>
                <span className="font-bold text-gray-800 text-sm">{fmt(s.won_tender_value||0)} / {fmt(s.sales_target)}</span>
              </div>
              <div className="h-4 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-700 flex items-center justify-end pr-2 text-[10px] font-bold text-white ${salesPct>=100?'bg-emerald-500':salesPct>=70?'bg-blue-500':salesPct>=40?'bg-amber-500':'bg-red-400'}`}
                  style={{width:`${Math.max(salesPct,8)}%`}}>{salesPct>15?`${salesPct}%`:''}</div>
              </div>
              <div className="flex justify-between text-[11px] text-gray-400 mt-2">
                <span>{salesPct}% achieved</span>
                <span className={salesPct>=100?'text-emerald-600 font-semibold':''}>
                  {salesPct>=100?'🎯 Target achieved!':fmt(Math.max(0,(s.sales_target||0)-(s.won_tender_value||0)))+' remaining'}
                </span>
              </div>
            </>
          ):(
            <div className="flex items-center gap-3 py-2">
              <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0"><Target size={16} className="text-gray-400"/></div>
              <div>
                <p className="text-sm text-gray-500">No sales target set for this period</p>
                {canSetTgt&&<button onClick={()=>setShowTargetModal(true)} className="text-xs text-indigo-600 hover:text-indigo-700 font-semibold mt-0.5">Set target now →</button>}
                {!canSetTgt&&<p className="text-xs text-gray-400 mt-0.5">Ask your manager to set a target.</p>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Top 5 stat cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {/* Customers */}
        <div onClick={()=>setCustPopup(true)}
          className="bg-gradient-to-br from-slate-600 to-slate-800 rounded-2xl p-4 text-white relative overflow-hidden cursor-pointer hover:scale-[1.02] hover:shadow-lg transition-all">
          <div className="absolute top-0 right-0 w-14 h-14 bg-white/10 rounded-full -translate-y-4 translate-x-4"/>
          <div className="absolute top-2.5 right-2.5 w-5 h-5 bg-white/10 rounded-lg flex items-center justify-center"><Users size={11} className="opacity-60"/></div>
          <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center mb-3"><Building2 size={18}/></div>
          <p className="text-3xl font-bold leading-none">{s.customers||0}</p>
          <p className="text-[11px] text-white/70 font-medium mt-2">Customers</p>
          <p className="text-[10px] text-white/40 mt-0.5">tap to view list</p>
        </div>

        {/* Activities */}
        <div onClick={()=>onNavigate('activities',{period,isYearly,viewYear,userId:selectedUid})}
          className="bg-gradient-to-br from-blue-500 to-indigo-600 rounded-2xl p-4 text-white relative overflow-hidden cursor-pointer hover:scale-[1.02] hover:shadow-lg transition-all">
          <div className="absolute top-0 right-0 w-14 h-14 bg-white/10 rounded-full -translate-y-4 translate-x-4"/>
          <ExternalLink size={10} className="absolute top-2.5 right-2.5 opacity-40"/>
          <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center mb-3"><Activity size={18}/></div>
          <p className="text-3xl font-bold leading-none">{s.total_activities||0}</p>
          <p className="text-[11px] text-white/70 font-medium mt-2">Activities</p>
          <p className="text-[10px] text-white/40 mt-0.5">{s.completed_activities||0} completed</p>
        </div>

        {/* Leads */}
        <div onClick={() => openLeadPanel()}
          className="bg-gradient-to-br from-violet-500 to-purple-600 rounded-2xl p-4 text-white relative overflow-hidden cursor-pointer hover:scale-[1.02] hover:shadow-lg transition-all">
          <div className="absolute top-0 right-0 w-14 h-14 bg-white/10 rounded-full -translate-y-4 translate-x-4"/>
          <ExternalLink size={10} className="absolute top-2.5 right-2.5 opacity-40"/>
          <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center mb-2"><TrendingUp size={15}/></div>
          <p className="text-3xl font-extrabold leading-none tracking-tight">{s.lead_count||0}</p>
          <p className="text-[11px] text-white/60 font-medium mt-1.5 mb-1">Leads</p>
          <p className="text-2xl font-extrabold leading-none tracking-tight">{(s.lead_value||0)>0?fmt(s.lead_value):'₹0'}</p>
        </div>

        {/* Tenders */}
        <div onClick={() => openTenderPanel()}
          className="bg-gradient-to-br from-orange-500 to-orange-600 rounded-2xl p-4 text-white relative overflow-hidden cursor-pointer hover:scale-[1.02] hover:shadow-lg transition-all">
          <div className="absolute top-0 right-0 w-14 h-14 bg-white/10 rounded-full -translate-y-4 translate-x-4"/>
          <ExternalLink size={10} className="absolute top-2.5 right-2.5 opacity-40"/>
          <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center mb-2"><FileText size={15}/></div>
          <p className="text-3xl font-extrabold leading-none tracking-tight">{s.tender_count||0}</p>
          <p className="text-[11px] text-white/60 font-medium mt-1.5 mb-1">Tenders</p>
          <p className="text-2xl font-extrabold leading-none tracking-tight">{(s.tender_value||0)>0?fmt(s.tender_value):'₹0'}</p>
        </div>

        {/* Work Orders */}
        <div onClick={()=>navigate('/workorders')}
          className="bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl p-4 text-white relative overflow-hidden cursor-pointer hover:scale-[1.02] hover:shadow-lg transition-all">
          <div className="absolute top-0 right-0 w-14 h-14 bg-white/10 rounded-full -translate-y-4 translate-x-4"/>
          <ExternalLink size={10} className="absolute top-2.5 right-2.5 opacity-40"/>
          <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center mb-2"><Package size={15}/></div>
          <p className="text-3xl font-extrabold leading-none tracking-tight">{s.wo_count||0}</p>
          <p className="text-[11px] text-white/60 font-medium mt-1.5 mb-1">Work Orders</p>
          <p className="text-2xl font-extrabold leading-none tracking-tight">{(s.wo_value||0)>0?fmt(s.wo_value):'₹0'}</p>
        </div>
      </div>

      {/* ── Activity type breakdown ───────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2"><Activity size={14} className="text-blue-500"/>Activity Breakdown</h3>
          {actTypeFilter&&<button onClick={()=>setActTypeFilter(null)} className="text-xs text-gray-400 hover:text-red-500 flex items-center gap-1">✕ Clear filter</button>}
        </div>
        <div className="grid grid-cols-5 lg:grid-cols-9 gap-3">
          {ACTIVITY_TYPES.map(t=>{
            const c=TYPE_COLOR[t]||{bg:'bg-gray-50',text:'text-gray-400',dot:''}
            const count=perf?.activity_breakdown?.[t]||0
            const isActive=actTypeFilter===t
            return(
              <div key={t} onClick={()=>{
                if(isActive){setActTypeFilter(null)}
                else{setActTypeFilter(t);onNavigate('activities',{actType:t,userId:selectedUid,period,isYearly,viewYear})}
              }}
                className={`text-center cursor-pointer rounded-xl p-1.5 transition-all ${isActive?'ring-2 ring-blue-400 bg-blue-50/60 scale-105':'hover:bg-gray-50'} ${count===0?'opacity-40':''}`}>
                <div className={`w-10 h-10 rounded-xl mx-auto flex items-center justify-center mb-1.5 ${c.bg} ${c.text}`}>{TYPE_ICON[t]||<Activity size={16}/>}</div>
                <p className="text-base font-bold text-gray-800">{count}</p>
                <p className="text-[10px] text-gray-400 leading-tight">{t}</p>
              </div>
            )
          })}
        </div>
        {actTypeFilter&&(()=>{
          const filtered=(perf?.recent_activities||[]).filter((a:any)=>a.type===actTypeFilter)
          return filtered.length>0?(
            <div className="mt-4 border-t border-gray-100 pt-4 space-y-2">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-gray-500">{actTypeFilter} activities ({filtered.length})</p>
                <button onClick={()=>onNavigate('activities',{actType:actTypeFilter,userId:selectedUid,period,isYearly,viewYear})}
                  className="text-xs text-blue-600 hover:text-blue-700 font-semibold flex items-center gap-1 px-2 py-1 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors">
                  View all in Activities <ChevronRight size={11}/>
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
      </div>

      {/* ── Team member rows ─────────────────────────────────────────────── */}
      {isAdmin&&salesTeamRows.length>0&&(
        <div>
          <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2"><Users size={14} className="text-blue-500"/>Sales Team Performance</h3>
          <div className="space-y-2">
            {(selectedUid ? salesTeamRows.filter((m:any)=>m.user_id===selectedUid) : salesTeamRows).map((m:any)=>{
              const callPct=pct(m.calls,m.calls_target||m.calls_total||1)
              const meetPct=pct(m.meetings,m.meetings_target||m.meetings_total||1)
              const salesPct2=m.sales_target>0?pct(m.wo_value||0,m.sales_target):0
              const isExpanded=expandedMember===m.user_id
              return(
                <div key={m.user_id} className={`bg-white rounded-2xl border transition-all ${m.is_self?'border-blue-200 bg-blue-50/20':'border-gray-200 hover:border-blue-200'}`}>
                  <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={()=>setExpandedMember(isExpanded?null:m.user_id)}>
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold text-white flex-shrink-0 ${m.is_self?'bg-gradient-to-br from-blue-500 to-indigo-600':'bg-gradient-to-br from-slate-400 to-slate-600'}`}>
                      {m.user_name?.charAt(0)?.toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-gray-900 truncate">{m.user_name}</p>
                        {m.is_self&&<span className="text-[10px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-bold">YOU</span>}
                        <RoleBadge role={m.role}/>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-[11px] text-gray-400">
                        <span className="flex items-center gap-1"><Building2 size={9}/>{m.customers} customers</span>
                        <span className="flex items-center gap-1"><Activity size={9}/>{m.completed}/{m.total} done</span>
                      </div>
                    </div>
                    <div className="hidden lg:flex items-center gap-4 flex-shrink-0">
                      <div className="w-24">
                        <div className="flex justify-between text-[10px] text-gray-400 mb-0.5"><span>Calls</span><span>{m.calls}/{m.calls_target||m.calls_total||'—'}</span></div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className={`h-full rounded-full ${callPct>=100?'bg-emerald-500':callPct>=70?'bg-blue-500':'bg-amber-400'}`} style={{width:`${callPct}%`}}/></div>
                      </div>
                      <div className="w-24">
                        <div className="flex justify-between text-[10px] text-gray-400 mb-0.5"><span>Meetings</span><span>{m.meetings}/{m.meetings_target||m.meetings_total||'—'}</span></div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className={`h-full rounded-full ${meetPct>=100?'bg-emerald-500':meetPct>=70?'bg-violet-500':'bg-amber-400'}`} style={{width:`${meetPct}%`}}/></div>
                      </div>
                      {m.sales_target>0&&(
                        <div className="w-28">
                          <div className="flex justify-between text-[10px] text-gray-400 mb-0.5"><span>Revenue</span><span>{fmt(m.wo_value||0)}/{fmt(m.sales_target)}</span></div>
                          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className={`h-full rounded-full ${salesPct2>=100?'bg-emerald-500':salesPct2>=70?'bg-indigo-500':'bg-amber-400'}`} style={{width:`${salesPct2}%`}}/></div>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div className="flex gap-2 text-xs">
                        <span onClick={e=>{e.stopPropagation();openLeadPanel(m.user_id,m.user_name)}}
                          className="bg-violet-50 text-violet-600 px-2 py-0.5 rounded-lg font-semibold cursor-pointer hover:bg-violet-100 transition-colors">{m.lead_count} leads ↗</span>
                        <span onClick={e=>{e.stopPropagation();openTenderPanel(m.user_id,m.user_name)}}
                          className="bg-orange-50 text-orange-600 px-2 py-0.5 rounded-lg font-semibold cursor-pointer hover:bg-orange-100 transition-colors">{m.tender_count} tenders ↗</span>
                      </div>
                      {isExpanded?<ChevronUp size={14} className="text-gray-400"/>:<ChevronDown size={14} className="text-gray-400"/>}
                    </div>
                  </div>
                  {/* ── EXPANDED: bigger amount values ─────────────────── */}
                  {isExpanded&&(
                    <div className="border-t border-gray-100 px-4 py-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        {label:'Lead Value',value:(m.lead_value||0)>0?fmt(m.lead_value):'₹0',color:'text-violet-600',
                          onClick:()=>openLeadPanel(m.user_id, m.user_name)},
                        {label:'Tender Value',value:(m.tender_value||0)>0?fmt(m.tender_value):'₹0',color:'text-orange-600',
                          onClick:()=>openTenderPanel(m.user_id, m.user_name)},
                        {label:'Work Orders',value:`${m.wo_count||0} · ${(m.wo_value||0)>0?fmt(m.wo_value):'₹0'}`,color:'text-emerald-600',onClick:undefined},
                        {label:'Payment Recv.',value:(m.payment_received||0)>0?fmt(m.payment_received):'₹0',color:'text-amber-600',onClick:undefined},
                      ].map(({label,value,color,onClick})=>(
                        <div key={label}
                          className={`bg-gray-50 rounded-xl p-3 text-center ${onClick?'cursor-pointer hover:bg-blue-50/40 transition-colors':''}`}
                          onClick={onClick}>
                          {/* ── BIGGER font for amounts ── */}
                          <p className={`text-lg font-bold ${color}`}>{value}</p>
                          <p className="text-[11px] text-gray-400 mt-0.5">{label}</p>
                          {onClick&&<p className="text-[10px] text-blue-400 mt-0.5">tap to view ↗</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Customer-wise activity table ──────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3 gap-3">
          <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
            <Building2 size={14} className="text-blue-500"/>Customer Activity Breakdown
            <span className="text-xs font-normal text-gray-400">({filteredCusts.length})</span>
            {selectedCustId&&(
              <button onClick={()=>setSelectedCustId(null)} className="text-[10px] text-blue-500 bg-blue-50 hover:bg-blue-100 px-1.5 py-0.5 rounded-lg font-semibold flex items-center gap-0.5">
                <X size={9}/>Clear
              </button>
            )}
          </h3>
          <div className="relative max-w-xs flex-1">
            <input value={custSearch} onChange={e=>setCustSearch(e.target.value)} placeholder="Search customers…"
              className="w-full text-xs border border-gray-200 rounded-xl px-3 py-1.5 focus:outline-none focus:border-blue-400 pr-7"/>
            {custSearch&&<button onClick={()=>setCustSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"><X size={12}/></button>}
          </div>
        </div>
        {loading?(
          <div className="py-10 text-center"><div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto"/></div>
        ):filteredCusts.length===0?(
          <div className="py-10 text-center bg-white rounded-2xl border border-gray-200">
            <Building2 size={24} className="mx-auto text-gray-200 mb-2"/>
            <p className="text-sm text-gray-400">{custSearch?'No customers match':'No customer activities in this period'}</p>
          </div>
        ):(
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            <div className="grid grid-cols-12 gap-2 px-4 py-2.5 bg-gray-50 border-b border-gray-100 text-[10px] font-bold text-gray-500 uppercase tracking-wide">
              <div className="col-span-3">Customer</div>
              <div className="col-span-2 text-center">Activities</div>
              <div className="col-span-2 text-center">Calls / Meetings</div>
              <div className="col-span-2 text-center">Leads / Tenders</div>
              <div className="col-span-2 text-center">Work Orders</div>
              <div className="col-span-1 text-center">Last Visit</div>
            </div>
            <div className="divide-y divide-gray-50">
              {filteredCusts.map((c:any)=>{
                const compPct=c.total_activities>0?Math.round(c.completed/c.total_activities*100):0
                const {dateFrom,dateTo}=getDateRange()
                return(
                  <div key={c.customer_id}
                    className="grid grid-cols-12 gap-2 px-4 py-3 hover:bg-blue-50/30 transition-colors group items-center cursor-pointer"
                    onClick={()=>onNavigate('activities',{customerId:c.customer_id,customerName:c.customer_name,period,isYearly,viewYear,userId:selectedUid})}
                  >
                    <div className="col-span-3 flex items-center gap-2 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0">
                        {c.customer_name?.substring(0,2)?.toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate group-hover:text-blue-600 transition-colors">{c.customer_name}</p>
                        {c.city&&<p className="text-[10px] text-gray-400 truncate">{c.city}{c.vertical?` · ${c.vertical}`:''}</p>}
                      </div>
                    </div>
                    <div className="col-span-2">
                      <div className="flex items-center justify-center gap-1.5">
                        {/* ── BIGGER activity count ── */}
                        <span className="text-base font-bold text-gray-800">{c.total_activities}</span>
                        <span className="text-xs text-gray-400">/ {c.completed} done</span>
                      </div>
                      <div className="mt-1 h-1.5 bg-gray-100 rounded-full overflow-hidden w-full">
                        <div className={`h-full rounded-full ${compPct>=80?'bg-emerald-500':compPct>=50?'bg-blue-500':'bg-amber-400'}`} style={{width:`${compPct}%`}}/>
                      </div>
                    </div>
                    <div className="col-span-2 flex items-center justify-center gap-2">
                      <span className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded-lg font-semibold">
                        <PhoneCall size={9}/>{c.calls_done}/{c.calls}
                      </span>
                      <span className="flex items-center gap-1 text-xs bg-violet-50 text-violet-600 px-1.5 py-0.5 rounded-lg font-semibold">
                        <Handshake size={9}/>{c.meetings_done}/{c.meetings}
                      </span>
                    </div>
                    {/* ── Leads / Tenders — clickable with bigger values ── */}
                    <div className="col-span-2 flex flex-col items-center gap-1">
                      <button
                        onClick={e=>{e.stopPropagation();if(c.lead_count>0)openLeadPanelByCustomer(c.customer_id,c.customer_name)}}
                        className="flex items-center gap-1 hover:bg-violet-100 px-1.5 py-0.5 rounded-lg transition-colors"
                      >
                        <span className="text-sm font-bold text-violet-600">{c.lead_count}</span>
                        {c.lead_value>0&&<span className="text-xs text-gray-500 font-medium">{fmt(c.lead_value)}</span>}
                        {c.lead_count>0&&<ExternalLink size={9} className="text-violet-400"/>}
                      </button>
                      <button
                        onClick={e=>{e.stopPropagation();if(c.tender_count>0)openTenderPanelByCustomer(c.customer_id,c.customer_name)}}
                        className="flex items-center gap-1 hover:bg-orange-100 px-1.5 py-0.5 rounded-lg transition-colors"
                      >
                        <span className="text-sm font-bold text-orange-600">{c.tender_count}</span>
                        {c.tender_value>0&&<span className="text-xs text-gray-500 font-medium">{fmt(c.tender_value)}</span>}
                        {c.tender_count>0&&<ExternalLink size={9} className="text-orange-400"/>}
                      </button>
                    </div>
                    {/* ── Work orders with bigger values ── */}
                    <div className="col-span-2 text-center">
                      <p className="text-sm font-bold text-emerald-600">{c.wo_count}</p>
                      {c.wo_value>0&&<p className="text-xs text-gray-500 font-medium">{fmt(c.wo_value)}</p>}
                      {c.payment_received>0&&<p className="text-xs text-amber-600 font-semibold">↗{fmt(c.payment_received)}</p>}
                    </div>
                    <div className="col-span-1 text-center">
                      {c.last_activity_date
                        ?<><p className="text-[10px] text-gray-600 font-medium">{c.last_activity_date?.slice(5)}</p><p className="text-[9px] text-gray-400">{c.last_activity_date?.slice(0,4)}</p></>
                        :<span className="text-[10px] text-gray-300">—</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Quarterly ─────────────────────────────────────────────────────── */}
      {isYearly&&quarterly.length>0&&(
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
    </div>
  )
}

// ─── Filter state ─────────────────────────────────────────────────────────────
type FilterState={userId:number|null;actType:string;status:string;customerId:number|null;dateFrom:string;dateTo:string}
const emptyFilter=():FilterState=>({userId:null,actType:'',status:'',customerId:null,dateFrom:'',dateTo:''})

const emptyActForm=()=>({
  activity_type:'Phone Call',customer_id:null,subject:'',description:'',
  activity_date:new Date().toISOString().slice(0,10),start_time:'',duration_minutes:30,
  location:'',status:'Planned',outcome:'',next_action:'',next_action_date:'',
  followup_category:'',followup_sub_type:'',cancellation_reason:'',
  has_travel:false,travel_mode:'',travel_from:'',travel_to:'',is_outside_district:false,on_behalf_of:null,
  travel_request_id:null as number|null,
  tr_travel_date:'',tr_visit_type:'Customer Visit',tr_return_date:'',tr_transport_mode:'',
  tr_estimated_cost:'',tr_contact_name:'',tr_contact_phone:'',
  tr_advance_required:false,tr_advance_amount:'',
  tr_accommodation_required:false,tr_accommodation_type:'Not Required',
  tr_hotel_name:'',tr_check_in_date:'',tr_check_out_date:'',tr_accommodation_cost:'',
})

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════
export default function KAMPage() {
  const { user }      = useAuthStore()
  const navigate      = useNavigate()
  const { sidebarCollapsed, setSidebarCollapsed } = useUIStore()
  const myRole        = (user?.role||'sales') as string
  const myId          = user?.id as number
  const isAdmin       = ADMIN_ROLES.includes(myRole)
  const canAssignTeam = MANAGER_ROLES.includes(myRole)
  const sidebarWasCollapsed = useRef(false)

  type Tab='activities'|'360'
  const [tab,setTab]             = useState<Tab>('activities')
  const [activities,setActs]     = useState<any[]>([])
  const [myCustomers,setCusts]   = useState<any[]>([])
  const [teamMembers,setMembers] = useState<any[]>([])
  const [loading,setLoading]     = useState(true)
  const [period,setPeriod]       = useState(()=>new Date().toISOString().slice(0,7))
  const [viewYear,setViewYear]   = useState(()=>new Date().getFullYear())
  const [isYearly,setIsYearly]   = useState(false)

  const [actPanel,setActPanel]         = useState(false)
  const [planPanel,setPlanPanel]       = useState(false)
  const [editAct,setEditAct]           = useState<any>(null)
  const [logAct,setLogAct]             = useState<any>(null)
  const [saving,setSaving]             = useState(false)
  const [actForm,setActForm]           = useState(emptyActForm())
  const [travelAlert,setTravel]        = useState<{id:number;number:string;message?:string;isOutside?:boolean}|null>(null)
  const [actDetailPopup,setActDetailPopup] = useState<any>(null)
  const [actPanelTRs,setActPanelTRs]   = useState<any[]>([])
  const [actPanelAdvDays,setActPanelAdvDays] = useState<number>(3)

  const [filters,setFilters]     = useState<FilterState>(emptyFilter())
  const [dateView,setDateView]   = useState<'today'|'all'|'custom'>('today')
  // ── track active customer name for filter badge ───────────────────────────
  const [activeCustomerName,setActiveCustomerName] = useState<string>('')
  const today = new Date().toISOString().slice(0,10)

  const { success, error:showError } = useToast()

  const loadAll = useCallback(async()=>{
    setLoading(true)
    const actParams:any={
      user_id:       filters.userId||undefined,
      activity_type: filters.actType||undefined,
      status:        filters.status||undefined,
      customer_id:   filters.customerId||undefined,
    }
    if(dateView==='today') actParams.activity_date=today
    else if(dateView==='custom'){actParams.date_from=filters.dateFrom||undefined;actParams.date_to=filters.dateTo||undefined}
    try{
      const [a,c,m]=await Promise.allSettled([
        api.get('/kam/activities',{params:actParams}),
        api.get('/kam/plan-customers'),
        api.get('/kam/team-members'),
      ])
      if(a.status==='fulfilled') setActs(a.value.data)
      if(c.status==='fulfilled') setCusts(c.value.data)
      if(m.status==='fulfilled') setMembers(m.value.data)
    }catch{showError('Failed to load')}
    finally{setLoading(false)}
  },[filters,dateView,today])

  useEffect(()=>{loadAll()},[loadAll])

  const openPlanPanel = () => {
    sidebarWasCollapsed.current = sidebarCollapsed
    if (!sidebarCollapsed) setSidebarCollapsed(true)
    setPlanPanel(true)
  }

  const closePlanPanel = () => {
    setPlanPanel(false)
    if (!sidebarWasCollapsed.current) setSidebarCollapsed(false)
  }

  const openLogPanel = (act: any) => {
    sidebarWasCollapsed.current = sidebarCollapsed
    if (!sidebarCollapsed) setSidebarCollapsed(true)
    setLogAct(act)
  }

  const closeLogPanel = () => {
    setLogAct(null)
    if (!sidebarWasCollapsed.current) setSidebarCollapsed(false)
  }

  const sanitizeActivityPayload=(f:any)=>{
    const numeric=['tr_estimated_cost','tr_advance_amount','tr_accommodation_cost','tr_estimated_kms']
    const dateFields=['tr_travel_date','tr_return_date','tr_check_in_date','tr_check_out_date']
    const out={...f}
    if(out.activity_type&&!out.mode) out.mode=modeForActivityType(out.activity_type)
    for(const k of [...numeric,...dateFields]) if(out[k]==='') out[k]=null
    return out
  }

  const saveActivity = async () => {
  if (!actForm.subject.trim()) {
    showError('Subject required')
    return
  }

  if (actForm.status === 'Completed' && !actForm.outcome?.trim()) {
    showError('Outcome required')
    return
  }

  if (actForm.status === 'Cancelled' && !actForm.cancellation_reason?.trim()) {
    showError('Cancellation reason required')
    return
  }

  setSaving(true)

  const selectedType = taskTypeName(actForm)

  const payload = sanitizeActivityPayload({
    ...actForm,
    activity_type: selectedType,
    mode: modeForActivityType(selectedType),
    task_type_name: selectedType,
  })

  try {
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
        id: res.data.auto_travel_request_id,
        number: res.data.auto_travel_request_number,
        message: res.data.travel_request_message,
        isOutside: payload.is_outside_district,
      })
    }

    setActPanel(false)
    loadAll()
  } catch (e: any) {
    showError(e.response?.data?.detail || 'Failed')
  } finally {
    setSaving(false)
  }
}

  const saveLog=async(form:any)=>{
    if(!logAct?.id)return;setSaving(true)
    try{
      const res=await api.patch(`/kam/activities/${logAct.id}`,sanitizeActivityPayload(form))
      success(`Activity ${(form.status||'updated').toLowerCase()}`)
      if(res.data?.auto_travel_request_id) setTravel({id:res.data.auto_travel_request_id,number:res.data.auto_travel_request_number,message:res.data.travel_request_message,isOutside:form.is_outside_district})
      closeLogPanel();loadAll()
    }
    catch(e:any){showError(e.response?.data?.detail||'Failed')}
    finally{setSaving(false)}
  }

 const savePlan=async(date:string,rows:PlanRow[])=>{
  setSaving(true)
  try{
    await api.post('/kam/activities/bulk',rows.map(r=>({
      activity_type:r.activity_type,
      mode:modeForActivityType(r.activity_type),
      customer_id:r.customer_id,
      subject:r.subject,
      activity_date:date,
      on_behalf_of:r.on_behalf_of||null
    })))
    success(`${rows.length} activit${rows.length!==1?'ies':'y'} planned`)
    closePlanPanel()
    loadAll()
  }
  catch(e:any){showError(e.response?.data?.detail||'Failed')}
  finally{setSaving(false)}
}

  const submitTravel=async(id:number)=>{
    try{const r=await api.post(`/kam/travel-requests/${id}/submit`);success(`Submitted to ${r.data.requested_to}`);setTravel(null)}
    catch(e:any){showError(e.response?.data?.detail||'Failed')}
  }

  const openAct=(a?:any)=>{
    setEditAct(a||null)
    setActForm(a?{...emptyActForm(),...a,activity_type:a?taskTypeName(a):emptyActForm().activity_type}:emptyActForm())
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

  // ── Navigate from 360 tab → activities tab ────────────────────────────────
  const handleNavigate=(module:string,params?:any)=>{
    if(module==='activities'){
      setTab('activities')
      const baseFilters={
        ...emptyFilter(),
        actType:    params?.actType    || '',
        userId:     params?.userId     ?? null,
        customerId: params?.customerId ?? null,
      }
      setActiveCustomerName(params?.customerName||'')
      if(params?.isYearly||params?.period){
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

  return (
    <div className="p-6 space-y-5">
      {logAct&&<LogSlidePanel activity={logAct} customers={myCustomers} isAdmin={isAdmin} onSave={saveLog} onClose={closeLogPanel} saving={saving}/>}

      {actDetailPopup&&(
        <ActivityDetailPopup
          activity={actDetailPopup}
          onClose={()=>setActDetailPopup(null)}
          onLog={a=>{setActDetailPopup(null);openLogPanel(a)}}
          onEdit={a=>{setActDetailPopup(null);openAct(a)}}
        />
      )}

      <PageHeader title="KAM 360" subtitle="Key Account Management — plan, log and track your activities" breadcrumb={['KAM']}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={loadAll} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
            <Button onClick={openPlanPanel} className="!bg-white !text-gray-700 !border !border-gray-200 hover:!bg-gray-50">
              <Calendar size={14} className="mr-1.5 inline-block"/>Plan Day
            </Button>
          </div>
        }/>

      {travelAlert&&<TravelAlertBanner requestNumber={travelAlert.number} requestId={travelAlert.id} message={travelAlert.message} isOutside={travelAlert.isOutside} onSubmit={submitTravel} onDismiss={()=>setTravel(null)}/>}

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-gray-100 rounded-2xl p-1 w-fit">
        {([{id:'activities',label:'Activities',icon:<Activity size={13}/>},{id:'360',label:'KAM 360',icon:<BarChart2 size={13}/>}] as const).map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl transition-all whitespace-nowrap ${tab===t.id?'bg-white text-gray-900 shadow-sm':'text-gray-500 hover:text-gray-700'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* ── ACTIVITIES TAB ─────────────────────────────────────────────────── */}
      {tab==='activities'&&(
        <div className="space-y-4">
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
                {overdueActs.slice(0,3).map((a:any)=><ActivityRow key={a.id} a={a} showUser={isAdmin} onLog={act=>openLogPanel(act)} onEdit={openAct} onViewDetail={setActDetailPopup}/>)}
                {overdueActs.length>3&&<div className="py-2 text-center text-xs text-gray-400">+{overdueActs.length-3} more overdue</div>}
              </div>
            </div>
          )}

          {/* ── Filter row ───────────────────────────────────────────────── */}
          <div className="bg-white rounded-2xl border border-gray-200 px-3 py-2.5 flex items-center gap-2 flex-wrap">
            {/* Date view toggle */}
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
            {/* Status */}
            <select value={filters.status} onChange={e=>setFilters(f=>({...f,status:e.target.value}))} className="text-xs border border-gray-200 rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-blue-400 bg-white">
              <option value="">All Status</option>{STATUSES.map(s=><option key={s}>{s}</option>)}
            </select>
            {/* Activity type */}
            <select value={filters.actType} onChange={e=>setFilters(f=>({...f,actType:e.target.value}))} className="text-xs border border-gray-200 rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-blue-400 bg-white">
              <option value="">All Types</option>{ACTIVITY_TYPES.map(t=><option key={t}>{t}</option>)}
            </select>
            {/* ── Customer filter ─────────────────────────────────────────── */}
            {myCustomers.length>0&&(
              <select
                value={filters.customerId||''}
                onChange={e=>{
                  const v=e.target.value?parseInt(e.target.value):null
                  const name=v?myCustomers.find(c=>c.id===v)?.customer_name||'':''
                  setFilters(f=>({...f,customerId:v}))
                  setActiveCustomerName(name)
                }}
                className={`text-xs border rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-blue-400 bg-white max-w-[160px] ${filters.customerId?'border-blue-300 bg-blue-50 text-blue-700':'border-gray-200'}`}
              >
                <option value="">All Customers</option>
                {myCustomers.map((c:any)=><option key={c.id} value={c.id}>{c.customer_name}</option>)}
              </select>
            )}
            {/* Team member filter */}
            {(isAdmin||canAssignTeam)&&teamMembers.filter(u=>!['ceo','admin'].includes(u.role)).length>0&&(
              <select value={filters.userId||''} onChange={e=>setFilters(f=>({...f,userId:e.target.value?parseInt(e.target.value):null}))} className="text-xs border border-gray-200 rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-blue-400 bg-white min-w-[130px]">
                <option value="">All Members</option>{teamMembers.filter(u=>!['ceo','admin'].includes(u.role)).map(u=><option key={u.id} value={u.id}>{u.full_name}{u.is_self?' (You)':''}</option>)}
              </select>
            )}
            {hasActiveFilters&&(
              <button onClick={()=>{setFilters(emptyFilter());setActiveCustomerName('')}} className="ml-auto text-xs text-gray-400 hover:text-red-500 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-red-50 flex-shrink-0">
                <X size={11}/>Reset
              </button>
            )}
          </div>

          {/* ── Active filter badges ─────────────────────────────────────── */}
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
            :activities.length===0
              ?<div className="py-16 text-center bg-white rounded-2xl border border-gray-200">
                <div className="w-14 h-14 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-3"><Coffee size={20} className="text-gray-300"/></div>
                <p className="text-sm font-semibold text-gray-400">
                  {filters.customerId&&activeCustomerName?`No activities for ${activeCustomerName}`:dateView==='today'?'No activities planned for today':'No activities found'}
                </p>
                {/* ADD BUTTON HERE */}
        {dateView === 'today' && (
          <Button
            onClick={openPlanPanel}
            className="!bg-white !text-gray-700 !border !border-gray-200 hover:!bg-gray-50"
          >
            <Calendar size={14} className="mr-1.5 inline-block" />
            Plan Day
          </Button>
        )}
              </div>
              :<div className="space-y-2">{activities.map((a:any)=><ActivityRow key={a.id} a={a} showUser={isAdmin&&!filters.userId} onLog={act=>openLogPanel(act)} onEdit={openAct} onViewDetail={setActDetailPopup}/>)}</div>
          }
        </div>
      )}

      {/* ── KAM 360 TAB ────────────────────────────────────────────────────── */}
      {tab==='360'&&(
        <KAM360Tab
          myRole={myRole}
          myId={myId}
          teamMembers={teamMembers}
          period={period}
          setPeriod={setPeriod}
          isYearly={isYearly}
          setIsYearly={setIsYearly}
          viewYear={viewYear}
          setViewYear={setViewYear}
          onNavigate={handleNavigate}
          onLogActivity={a=>openLogPanel(a)}
          onEditActivity={a=>openAct(a)}
        />
      )}

      {/* Panels */}
      <SlidePanel open={actPanel} onClose={()=>setActPanel(false)} title={editAct?'Edit Activity':'Log Activity'} subtitle={editAct?'Update activity details':'Record a new KAM activity'} width="w-full" insetLeft="var(--sidebar-w, 220px)"
        footer={<><Button onClick={()=>setActPanel(false)}>Cancel</Button><Button onClick={saveActivity} loading={saving}>{editAct?'Update':'Save Activity'}</Button></>}>
        <LogActivityForm form={actForm} setForm={setActForm} customers={myCustomers} isAdmin={isAdmin}
          isEdit={!!editAct} travelRequests={actPanelTRs} advanceDays={actPanelAdvDays}/>
      </SlidePanel>

      <SlidePanel open={planPanel} onClose={closePlanPanel} title="Plan Your Day" subtitle="Schedule multiple activities at once" width="w-full" insetLeft="var(--sidebar-w, 220px)">
        <PlanDayPanel teamMembers={teamMembers} currentUserRole={myRole} currentUserId={myId} onSaveAll={savePlan} saving={saving} onClose={closePlanPanel}/>
      </SlidePanel>
    </div>
  )
}
