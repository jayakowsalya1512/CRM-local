import { useState, useEffect, useMemo } from 'react'
import {
  BarChart2, Building2, Search, X, ChevronDown, ChevronUp, Minus,
  Activity, PhoneCall, Video, Handshake, Monitor, Navigation, Repeat2, Mail,
  TrendingUp, FileText, Star, IndianRupee, Clock, CheckCircle,
  Calendar, ChevronRight,
} from 'lucide-react'
import api from '@/services/api'
import SlidePanel from '@/components/ui/SlidePanel'
import Button from '@/components/ui/Button'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  fmt, TYPE_ICON, TYPE_COLOR, ACTIVITY_TYPES, roleLabel, RingProgress,
} from './shared'

export function CustomerActivityGrid({custActs,teamMembers,onNavigate,onLeadClick,onTenderClick,period,isYearly,viewYear,dateFrom,dateTo,selectedUid,loading,custSearch,setCustSearch,selectedCustId,setSelectedCustId}:{
  custActs:any[];onNavigate:(mod:string,params?:any)=>void;
  teamMembers:any[];
  onLeadClick:(cid:number,cn:string)=>void;onTenderClick:(cid:number,cn:string)=>void;
  period:string;isYearly:boolean;viewYear:number;dateFrom?:string;dateTo?:string;selectedUid:number|null;
  loading:boolean;custSearch:string;setCustSearch:(v:string)=>void;
  selectedCustId:number|null;setSelectedCustId:(v:number|null)=>void;
}) {
  const { label: customerLabel, singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const { label: leadLabel, singular: leadSingular, labelLower: leadLabelLower } = useModuleName('leads')
  const { label: opportunityLabel, singular: opportunitySingular, labelLower: opportunityLabelLower } = useModuleName('opportunities')
  const { label: tenderLabel, singular: tenderSingular, labelLower: tenderLabelLower } = useModuleName('tenders')
  const { label: workOrderLabel, labelLower: workOrderLabelLower } = useModuleName('workorders')
  const [sortBy,setSortBy]=useState<'name'|'activities'|'revenue'|'leads'|'completion'>('activities')
  const [sortDir,setSortDir]=useState<'desc'|'asc'>('desc')
  const [expandedId,setExpandedId]=useState<number|null>(null)
  const [panelTab,setPanelTab]=useState<'overview'|'leads'|'tenders'|'opportunities'|'conversion'>('overview')
  const [customerLeads,setCustomerLeads]=useState<any[]>([])
  const [customerTenders,setCustomerTenders]=useState<any[]>([])
  const [customerWorkOrders,setCustomerWorkOrders]=useState<any[]>([])
  const [customerTenderLoading,setCustomerTenderLoading]=useState(false)
  const [customerTenderSearch,setCustomerTenderSearch]=useState('')
  const normName=(v:any)=>String(v||'').trim().toLowerCase()
  const assignedRoleFor=(name:string)=> {
    const member=teamMembers.find((u:any)=>[u.full_name,u.name,u.user_name].some(n=>normName(n)===normName(name)))
    return roleLabel(member?.role || member?.user_role || '')
  }
  const navRange = {period,isYearly,viewYear,dateFrom,dateTo}
  const inGridRange = (raw:any) => {
    if(!raw || !dateFrom || !dateTo) return true
    const d = String(raw).slice(0,10)
    return d >= dateFrom && d <= dateTo
  }

  useEffect(()=>{
    setPanelTab('overview')
    setCustomerLeads([])
    setCustomerTenders([])
    setCustomerWorkOrders([])
    setCustomerTenderSearch('')
  },[expandedId])

  const filtered = useMemo(()=>{
    return custActs
      .filter(c=>{
        const ms=!custSearch||c.customer_name?.toLowerCase().includes(custSearch.toLowerCase())
        const mc=!selectedCustId||c.customer_id===selectedCustId
        return ms&&mc
      })
      .sort((a,b)=>{
        let av=0,bv=0
        if(sortBy==='name') return sortDir==='asc'?a.customer_name?.localeCompare(b.customer_name):b.customer_name?.localeCompare(a.customer_name)
        if(sortBy==='activities') {av=a.total_activities;bv=b.total_activities}
        if(sortBy==='revenue') {av=a.wo_value||0;bv=b.wo_value||0}
        if(sortBy==='leads') {av=a.lead_count||0;bv=b.lead_count||0}
        if(sortBy==='completion') {av=a.total_activities>0?(a.completed/a.total_activities):0;bv=b.total_activities>0?(b.completed/b.total_activities):0}
        return sortDir==='desc'?bv-av:av-bv
      })
  },[custActs,custSearch,selectedCustId,sortBy,sortDir])

  const panelCustomer=expandedId?filtered.find((c:any)=>c.customer_id===expandedId):null

  const loadCustomerTenders = async (customer:any) => {
    setPanelTab('tenders')
    setCustomerTenderLoading(true)
    setCustomerTenderSearch('')
    try {
      const r = await api.get('/tenders/', { params: { customer_id: customer.customer_id, per_page: 500, page: 1, date_from: dateFrom, date_to: dateTo } })
      const items = Array.isArray(r.data?.items) ? r.data.items : Array.isArray(r.data) ? r.data : []
      setCustomerTenders(items.filter((t:any)=>t.customer_id===customer.customer_id && inGridRange(t.result_date || t.submission_date || t.published_date || t.created_at)))
    } catch {
      setCustomerTenders([])
    } finally {
      setCustomerTenderLoading(false)
    }
  }

  const loadCustomerLeads = async (customer:any, tab:'leads'|'opportunities') => {
    setPanelTab(tab)
    setCustomerTenderLoading(true)
    setCustomerTenderSearch('')
    try {
      const r = await api.get('/leads', { params: { customer_id: customer.customer_id, date_from: dateFrom, date_to: dateTo } })
      const items = Array.isArray(r.data) ? r.data : []
      setCustomerLeads(items.filter((l:any)=>l.customer_id===customer.customer_id && inGridRange(l.lead_created_at || l.created_at)))
    } catch {
      setCustomerLeads([])
    } finally {
      setCustomerTenderLoading(false)
    }
  }

  const loadCustomerConversions = async (customer:any) => {
    setPanelTab('conversion')
    setCustomerTenderLoading(true)
    setCustomerTenderSearch('')
    try {
      const r = await api.get('/workorders')
      const items = Array.isArray(r.data) ? r.data : []
      setCustomerWorkOrders(items.filter((wo:any)=>wo.customer_id===customer.customer_id && inGridRange(wo.result_date || wo.po_date || wo.created_at)))
    } catch {
      setCustomerWorkOrders([])
    } finally {
      setCustomerTenderLoading(false)
    }
  }

  const toggleSort=(col:typeof sortBy)=>{
    if(sortBy===col) setSortDir(d=>d==='desc'?'asc':'desc')
    else{setSortBy(col);setSortDir('desc')}
  }

  const SortBtn=({col,label}:{col:typeof sortBy;label:string})=>(
    <button onClick={()=>toggleSort(col)}
      className={`flex items-center gap-1 text-xs font-bold uppercase tracking-wide transition-colors ${sortBy===col?'text-slate-950':'text-slate-500 hover:text-slate-700'}`}>
      {label}{sortBy===col?(sortDir==='desc'?<ChevronDown size={10}/>:<ChevronUp size={10}/>):<Minus size={10}/>}
    </button>
  )

  const CustomerTableHeader=({col,label,align='left'}:{col?:typeof sortBy;label:string;align?:'left'|'center'|'right'})=>(
    <div className={`${align==='center'?'text-center':align==='right'?'text-right':'text-left'}`}>
      {col ? (
        <button onClick={()=>toggleSort(col)}
          className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.12em] transition-colors ${sortBy===col?'text-slate-800':'text-slate-500 hover:text-slate-700'}`}>
          {label}{sortBy===col?(sortDir==='desc'?<ChevronDown size={10}/>:<ChevronUp size={10}/>):null}
        </button>
      ) : (
        <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">{label}</span>
      )}
    </div>
  )

  const fmtActDate=(d:string)=>{
    const full=new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})
    const diff=Math.floor((new Date().setHours(0,0,0,0)-new Date(d).setHours(0,0,0,0))/86400000)
    if(diff===0) return {label:'Today',sub:full}
    if(diff===1) return {label:'Yesterday',sub:full}
    if(diff>1&&diff<=6) return {label:`${diff} days ago`,sub:full}
    if(diff>6&&diff<=30) return {label:`${Math.ceil(diff/7)}w ago`,sub:full}
    if(diff<0) return {label:`In ${Math.abs(diff)} day${Math.abs(diff)!==1?'s':''}`,sub:full}
    return {label:new Date(d).toLocaleDateString('en-IN',{day:'2-digit',month:'short'}),sub:d.slice(0,4)}
  }

  if(loading) return <div className="rounded-2xl border border-slate-200 bg-white py-16 text-center shadow-sm"><div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto"/></div>

  return (
    <div>
      <div className="hidden">
        <div className="flex items-start gap-2.5">
          <BarChart2 size={18} className="mt-0.5 shrink-0 text-blue-600"/>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-base font-bold text-slate-950">{customerSingular} Activity Breakdown</h3>
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-700">{filtered.length}</span>
              {selectedCustId&&(
                <button onClick={()=>setSelectedCustId(null)} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600 hover:bg-slate-200">
                  <X size={12}/>Clear
                </button>
              )}
            </div>
            <p className="mt-1 text-xs font-medium text-slate-500">Track {customerLabelLower} engagement, pipeline and last activities in one place</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"/>
            <input value={custSearch} onChange={e=>setCustSearch(e.target.value)} placeholder={`Search ${customerLabelLower}...`}
              className="h-12 w-72 rounded-xl border border-slate-200 bg-white pl-12 pr-10 text-sm font-semibold text-slate-700 outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-50"/>
            {custSearch&&<button onClick={()=>setCustSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={16}/></button>}
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="hidden">
        <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
          <Building2 size={14} className="text-blue-500"/>{customerSingular} Activity Breakdown
          <span className="text-xs font-normal text-gray-400">({filtered.length})</span>
          {selectedCustId&&(
            <button onClick={()=>setSelectedCustId(null)} className="text-[10px] text-blue-500 bg-blue-50 hover:bg-blue-100 px-1.5 py-0.5 rounded-lg font-semibold flex items-center gap-0.5">
              <X size={9}/>Clear
            </button>
          )}
        </h3>
        <div className="relative">
          <input value={custSearch} onChange={e=>setCustSearch(e.target.value)} placeholder={`Search ${customerLabelLower}...`}
            className="text-xs border border-gray-200 rounded-xl px-3 py-1.5 focus:outline-none focus:border-blue-400 pr-7 w-44 bg-gray-50"/>
          {custSearch&&<button onClick={()=>setCustSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400"><X size={11}/></button>}
        </div>
      </div>

      {filtered.length===0?(
        <div className="mt-5 py-10 text-center bg-white rounded-2xl border border-slate-200">
          <Building2 size={24} className="mx-auto text-gray-200 mb-2"/>
          <p className="text-sm text-gray-400">{custSearch?`No ${customerLabelLower} match`:`No ${customerSingular.toLowerCase()} activities in this period`}</p>
        </div>
      ):(
        <>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <BarChart2 size={15} className="shrink-0 text-blue-600"/>
              <h3 className="truncate text-sm font-black text-slate-950">{customerSingular} Activity Breakdown</h3>
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-black text-blue-700">{filtered.length}</span>
              {selectedCustId&&(
                <button onClick={()=>setSelectedCustId(null)} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600 hover:bg-slate-200">
                  <X size={10}/>Clear
                </button>
              )}
            </div>
            <div className="relative hidden sm:block">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
              <input value={custSearch} onChange={e=>setCustSearch(e.target.value)} placeholder={`Search ${customerLabelLower}...`}
                className="h-8 w-56 rounded-lg border border-slate-200 bg-white pl-8 pr-8 text-xs font-semibold text-slate-600 outline-none transition focus:border-blue-400"/>
              {custSearch&&<button onClick={()=>setCustSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={12}/></button>}
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[900px]">
              <div className="grid grid-cols-[minmax(260px,340px)_minmax(100px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)_115px] items-center gap-3 bg-slate-50/80 px-4 py-3">
                <CustomerTableHeader col="name" label={customerSingular}/>
                <CustomerTableHeader col="activities" label="Activities" align="center"/>
                <CustomerTableHeader col="leads" label="Pipeline Counts" align="center"/>
                <CustomerTableHeader label="Assigned" align="center"/>
                <CustomerTableHeader col="revenue" label="Potential" align="right"/>
              </div>

              <div className="divide-y divide-slate-100">
                {filtered.map((c:any)=>{
                  const isExpanded=expandedId===c.customer_id
                  const potentialValue=Number(c.lead_value||0)+Number(c.tender_value||0)
                  const meta=[c.city,c.vertical,c.business_unit||c.business_unit_name||c.industry].filter(Boolean).join(' - ')
                  const assignedName=Array.isArray(c.assigned_to_names)&&c.assigned_to_names.length ? c.assigned_to_names[0] : c.assigned_to_name
                  const initials=String(c.customer_name||'CU').split(/\s+/).map((part:string)=>part[0]).filter(Boolean).slice(0,2).join('').toUpperCase() || 'CU'
                  return (
                    <div key={c.customer_id}
                      className="grid cursor-pointer grid-cols-[minmax(260px,340px)_minmax(100px,1fr)_minmax(130px,1fr)_minmax(130px,1fr)_115px] items-center gap-3 px-4 py-3 transition-colors hover:bg-blue-50/30"
                      onClick={()=>setExpandedId(isExpanded?null:c.customer_id)}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 text-xs font-black text-white shadow-sm shadow-blue-100">
                          {initials}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-black leading-tight text-slate-950 break-words">{c.customer_name}</p>
                          <p className="mt-0.5 truncate text-[10px] font-medium text-slate-400">{meta || 'Unassigned'}</p>
                        </div>
                      </div>

                      <div className="text-center">
                        <p className="text-base font-black leading-none text-slate-950">{c.total_activities||0}</p>
                        <p className="mt-1 text-[10px] font-medium text-slate-400">{c.completed||0} done</p>
                      </div>

                      <div className="grid grid-cols-3 items-center justify-center gap-1.5 text-center">
                        <button type="button" onClick={e=>{e.stopPropagation();if(c.lead_count>0)onLeadClick(c.customer_id,c.customer_name)}}
                          className="rounded-md px-1.5 py-1 hover:bg-violet-50">
                          <p className="text-[12px] font-black leading-none text-violet-700">{c.lead_count||0}</p>
                          <p className="mt-1 text-[9px] font-semibold uppercase leading-none text-slate-400">{leadLabel}</p>
                        </button>
                        <button type="button" onClick={e=>{e.stopPropagation();if((c.opportunity_count||0)>0)onLeadClick(c.customer_id,c.customer_name)}}
                          className="rounded-md px-1.5 py-1 hover:bg-cyan-50">
                          <p className="text-[12px] font-black leading-none text-cyan-700">{c.opportunity_count||0}</p>
                          <p className="mt-1 text-[9px] font-semibold leading-none text-slate-400">{opportunityLabel}</p>
                        </button>
                        <button type="button" onClick={e=>{e.stopPropagation();if(c.tender_count>0)onTenderClick(c.customer_id,c.customer_name)}}
                          className="rounded-md px-1.5 py-1 hover:bg-orange-50">
                          <p className="text-[12px] font-black leading-none text-orange-600">{c.tender_count||0}</p>
                          <p className="mt-1 text-[9px] font-semibold uppercase leading-none text-slate-400">{tenderLabel}</p>
                        </button>
                      </div>

                      <div className="min-w-0 text-center">
                        {assignedName ? (
                          <>
                            <p className="truncate text-xs font-black text-slate-950">{assignedName}</p>
                            <span className="mt-1 inline-flex justify-center rounded-md bg-violet-50 px-1.5 py-0.5 text-[9px] font-black text-violet-700">{assignedRoleFor(assignedName)}</span>
                          </>
                        ) : (
                          <span className="text-xs font-semibold text-slate-300">-</span>
                        )}
                      </div>

                      <div className="text-right">
                        <p className={`text-sm font-black ${potentialValue>0?'text-violet-700':'text-slate-300'}`}>{potentialValue>0?fmt(potentialValue):'-'}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {false&&(
        <div className="hidden">
          {/* Header */}
          <div className="grid grid-cols-12 gap-2 border-b border-slate-200 bg-slate-50/80 px-5 py-3 items-center">
            <div className="col-span-3"><SortBtn col="name" label={customerSingular}/></div>
            <div className="col-span-1 flex justify-center text-center"><SortBtn col="activities" label="Total Activities"/></div>
            <div className="col-span-2 flex justify-center"><SortBtn col="completion" label="Activity & Progress"/></div>
            <div className="col-span-2 flex justify-center"><SortBtn col="leads" label="Pipeline Snapshot"/></div>
            <div className="col-span-2 text-center"><span className="text-xs font-bold uppercase tracking-wide text-slate-500">Assigned To</span></div>
            <div className="col-span-2 flex items-center justify-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">Last Activity<ChevronDown size={10}/></div>
          </div>

          {/* Rows */}
          <div className="divide-y divide-slate-100">
            {filtered.map((c:any)=>{
              const compPct=c.total_activities>0?Math.round(c.completed/c.total_activities*100):0
              const isExpanded=expandedId===c.customer_id
              const pctColor=compPct>=80?'text-emerald-600':compPct>=60?'text-blue-600':compPct>=40?'text-amber-600':'text-red-500'
              const ringColor=compPct>=80?'#10b981':compPct>=60?'#2563eb':compPct>=40?'#f59e0b':'#ef4444'
              return (
                <div key={c.customer_id}>
                  <div className="grid grid-cols-12 gap-2 px-5 py-4 hover:bg-blue-50/20 transition-colors items-center group cursor-pointer"
                    onClick={()=>setExpandedId(isExpanded?null:c.customer_id)}>
                    {/* Customer name */}
                    <div className="col-span-3 flex items-center gap-3 min-w-0 border-r border-slate-100 pr-4">
                      <div className="w-11 h-11 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center text-sm font-bold text-white flex-shrink-0 shadow-md shadow-blue-100">
                        {c.customer_name?.substring(0,2)?.toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-bold text-slate-950 truncate group-hover:text-blue-700 transition-colors">{c.customer_name}</p>
                        </div>
                        {(c.city||c.vertical)&&<p className="mt-1 text-[10px] text-gray-400 truncate">{[c.city,c.vertical].filter(Boolean).join(' · ')}</p>}
                        <div className="mt-2 flex items-center gap-1 overflow-hidden whitespace-nowrap">
                          {[
                            {icon:<PhoneCall size={10}/>,val:c.calls||0,color:'text-blue-600',bg:'bg-blue-50',type:'Phone Call',label:'Phone Calls'},
                            {icon:<Video size={10}/>,val:c.video_calls||0,color:'text-cyan-600',bg:'bg-cyan-50',type:'Video Call',label:'Video Calls'},
                            {icon:<Handshake size={10}/>,val:c.meetings||0,color:'text-violet-600',bg:'bg-violet-50',type:'In Person Meet',label:'Meetings'},
                            {icon:<Monitor size={10}/>,val:c.demos||0,color:'text-emerald-600',bg:'bg-emerald-50',type:'Demo',label:'Demos'},
                            {icon:<Navigation size={10}/>,val:c.site_visits||0,color:'text-orange-600',bg:'bg-orange-50',type:'Site Visit',label:'Site Visits'},
                            {icon:<Repeat2 size={10}/>,val:c.follow_ups||0,color:'text-amber-600',bg:'bg-amber-50',type:'Follow Up',label:'Follow Ups'},
                            {icon:<Mail size={10}/>,val:c.emails||0,color:'text-slate-600',bg:'bg-slate-100',type:'Email',label:'Emails'},
                          ].map(a=>(
                            <button key={a.type} onClick={e=>{e.stopPropagation();onNavigate('activities',{activityType:a.type,customerId:c.customer_id,customerName:c.customer_name,userId:selectedUid,...navRange})}}
                              className={`inline-flex h-5 shrink-0 items-center gap-0.5 rounded-md px-1 text-[10px] font-bold ${a.bg} ${a.color} hover:ring-1 hover:ring-current/20`}
                              title={a.label}>
                              {a.icon}{a.val}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Activities */}
                    <div className="col-span-1 flex flex-col items-center justify-center border-r border-slate-100 pr-2 text-center">
                      <p className="text-xl font-bold text-slate-950">{c.total_activities}</p>
                      <p className="text-[10px] text-gray-400">{c.completed}✓ {(c.total_activities-c.completed)||0}↻</p>
                    </div>

                    {/* Completion */}
                    <div className="col-span-2 flex items-center justify-center gap-3 border-r border-slate-100 pr-4">
                      <RingProgress pct={compPct} size={58} stroke={5} color={ringColor} label={`${compPct}%`} sublabel="Complete"/>
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-600">
                          <CheckCircle size={12} className="text-emerald-600"/>{c.completed||0} Completed
                        </div>
                        <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-600">
                          <Clock size={12} className={pctColor}/>{(c.total_activities-c.completed)||0} Pending
                        </div>
                        <span className="hidden items-center gap-0.5 text-[10px] text-blue-600 font-semibold">
                          <PhoneCall size={8}/>{c.calls_done||0}/{c.calls||0}
                        </span>
                        <button onClick={e=>{e.stopPropagation();onNavigate('activities',{activityType:'In Person Meet',customerId:c.customer_id,customerName:c.customer_name,userId:selectedUid,...navRange})}}
                          className="hidden items-center gap-0.5 text-[10px] text-violet-600 font-semibold hover:text-violet-800 hover:bg-violet-50 rounded px-0.5 transition-colors cursor-pointer"
                          title="View In-Person Meetings">
                          <Handshake size={8}/>{c.meetings_done||0}/{c.meetings||0}
                        </button>
                      </div>
                    </div>

                    {/* Leads / Tenders + Opportunity + Potential */}
                    <div className="col-span-2 flex flex-col items-stretch gap-1 border-r border-slate-100 pr-4">
                      <div className="grid grid-cols-3 divide-x divide-slate-100 text-center">
                        <button onClick={e=>{e.stopPropagation();if(c.lead_count>0)onLeadClick(c.customer_id,c.customer_name)}} className="px-1 hover:bg-violet-50">
                          <p className="text-sm font-bold text-emerald-600">{c.lead_count||0}</p>
                          <p className="text-[10px] font-semibold text-slate-500">{(c.lead_count||0)===1?leadSingular:leadLabel}</p>
                        </button>
                        <button onClick={e=>{e.stopPropagation();if(c.tender_count>0)onTenderClick(c.customer_id,c.customer_name)}} className="px-1 hover:bg-orange-50">
                          <p className="text-sm font-bold text-orange-600">{c.tender_count||0}</p>
                          <p className="text-[10px] font-semibold text-slate-500">{(c.tender_count||0)===1?tenderSingular:tenderLabel}</p>
                        </button>
                        <div className="px-1">
                          <p className="text-sm font-bold text-violet-700">{fmt((c.lead_value||0)+(c.tender_value||0))}</p>
                          <p className="text-[10px] font-semibold text-slate-500">Potential</p>
                        </div>
                      </div>
                      <button onClick={e=>{e.stopPropagation();if(c.lead_count>0)onLeadClick(c.customer_id,c.customer_name)}}
                        className={`hidden items-center gap-1 text-[11px] px-2 py-0.5 rounded-lg font-bold transition-colors ${c.lead_count>0?'bg-violet-50 text-violet-700 hover:bg-violet-100 cursor-pointer':'text-gray-300 cursor-default'}`}>
                        <TrendingUp size={9}/>{c.lead_count||0} {leadLabelLower}
                        {(c.lead_value||0)>0&&<span className="text-gray-500 font-normal">· {fmt(c.lead_value)}</span>}
                      </button>
                      {(c.opportunity_count||0)>0&&(
                        <button onClick={e=>{e.stopPropagation();onLeadClick(c.customer_id,c.customer_name)}}
                          className="hidden items-center gap-1 text-[11px] px-2 py-0.5 rounded-lg font-bold transition-colors bg-blue-50 text-blue-700 hover:bg-blue-100 cursor-pointer">
                          <Star size={9}/>{c.opportunity_count} {opportunityLabelLower}
                          {(c.opportunity_value||0)>0&&<span className="text-gray-500 font-normal">· {fmt(c.opportunity_value)}</span>}
                        </button>
                      )}
                      <button onClick={e=>{e.stopPropagation();if(c.tender_count>0)onTenderClick(c.customer_id,c.customer_name)}}
                        className={`hidden items-center gap-1 text-[11px] px-2 py-0.5 rounded-lg font-bold transition-colors ${c.tender_count>0?'bg-orange-50 text-orange-700 hover:bg-orange-100 cursor-pointer':'text-gray-300 cursor-default'}`}>
                        <FileText size={9}/>{c.tender_count||0} {tenderLabelLower}
                        {(c.tender_value||0)>0&&<span className="text-gray-500 font-normal">· {fmt(c.tender_value)}</span>}
                      </button>
                      {((c.lead_value||0)+(c.tender_value||0))>0&&(
                        <span className="hidden items-center gap-1 text-[10px] px-2 py-0.5 rounded-lg bg-indigo-50 text-indigo-700 font-bold">
                          Potential: {fmt((c.lead_value||0)+(c.tender_value||0))}
                        </span>
                      )}
                    </div>

                    {/* Revenue */}
                    <div className="hidden">
                      <p className={`text-sm font-bold ${(c.wo_value||0)>0?'text-emerald-600':'text-gray-300'}`}>
                        {(c.wo_value||0)>0?fmt(c.wo_value):c.wo_count||0}
                      </p>
                      {(c.wo_value||0)>0&&<p className="text-[9px] text-gray-400">{c.wo_count} WO{(c.wo_count||0)!==1?'s':''}</p>}
                    </div>

                    {/* Assigned To */}
                    <div className="col-span-2 flex items-center justify-center">
                      {c.assigned_to_names&&c.assigned_to_names.length>0?(
                        <div className="min-w-0 text-left">
                          <p className="truncate text-xs font-bold text-slate-950">{c.assigned_to_names[0]}</p>
                          <span className="mt-1 inline-flex rounded-md bg-violet-50 px-2 py-0.5 text-[10px] font-bold text-violet-700">{assignedRoleFor(c.assigned_to_names[0])}</span>
                        </div>
                      ):(
                        <span className="text-[10px] text-gray-300">—</span>
                      )}
                    </div>

                    {/* Last visit */}
                    <div className="col-span-2 flex items-center justify-center gap-3 text-center">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                        <Calendar size={17}/>
                      </div>
                      {c.last_activity_date?(()=>{
                        const {label,sub}=fmtActDate(c.last_activity_date)
                        return(
                          <div className="text-left">
                            <p className="whitespace-nowrap text-xs font-bold text-slate-950">{label}</p>
                            <p className="text-[10px] text-slate-500 font-medium">{sub}</p>
                          </div>
                        )
                      })():<span className="text-[10px] text-gray-300">—</span>}
                    </div>
                  </div>

                  {/* Expandable detail row */}
                  {false&&isExpanded&&(
                    <div className="col-span-12 border-t border-blue-100 bg-blue-50/30 px-4 py-4">
                      <div className="grid grid-cols-5 gap-3 mb-3">
                        {[
                          {label:'Total Activities',value:String(c.total_activities),sub:`${c.completed} completed`,color:'text-blue-700',bg:'bg-white border border-blue-100'},
                          {label:`${leadSingular} Pipeline`,value:(c.lead_value||0)>0?fmt(c.lead_value):'—',sub:`${c.lead_count||0} ${leadLabelLower}`,color:'text-violet-700',bg:'bg-white border border-violet-100',onClick:c.lead_count>0?()=>onLeadClick(c.customer_id,c.customer_name):undefined},
                          {label:opportunityLabel,value:(c.opportunity_count||0)>0?String(c.opportunity_count):'—',sub:(c.opportunity_value||0)>0?fmt(c.opportunity_value):`no ${opportunitySingular.toLowerCase()} value`,color:'text-blue-700',bg:'bg-white border border-blue-100',onClick:c.opportunity_count>0?()=>onLeadClick(c.customer_id,c.customer_name):undefined},
                          {label:`${tenderSingular} Value`,value:(c.tender_value||0)>0?fmt(c.tender_value):'—',sub:`${c.tender_count||0} ${tenderLabelLower}`,color:'text-orange-700',bg:'bg-white border border-orange-100',onClick:c.tender_count>0?()=>onTenderClick(c.customer_id,c.customer_name):undefined},
                          {label:'Revenue Booked',value:(c.wo_value||0)>0?fmt(c.wo_value):'—',sub:(c.payment_received||0)>0?`${fmt(c.payment_received)} received`:`${c.wo_count||0} ${workOrderLabelLower}`,color:'text-emerald-700',bg:'bg-white border border-emerald-100'},
                        ].map(({label,value,sub,color,bg,onClick})=>(
                          <div key={label} className={`${bg} rounded-xl p-3 ${onClick?'cursor-pointer hover:shadow-sm transition-shadow':''}`} onClick={onClick}>
                            <p className={`text-lg font-bold ${color}`}>{value}</p>
                            <p className="text-[10px] text-gray-600 font-medium mt-0.5">{label}</p>
                            <p className="text-[10px] text-gray-400">{sub}</p>
                          </div>
                        ))}
                      </div>
                      {/* Activity type chips */}
                      <div className="flex items-center gap-1.5 flex-wrap mb-3">
                        {ACTIVITY_TYPES.map(t=>{
                          const cnt=t==='Phone Call'?(c.calls||0):t==='In Person Meet'?(c.meetings||0):t==='Demo'?(c.demos||0):t==='Site Visit'?(c.site_visits||0):0
                          if(!cnt) return null
                          const cc=TYPE_COLOR[t]||{bg:'bg-gray-50',text:'text-gray-500'}
                          return <span key={t} className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-lg ${cc.bg} ${cc.text}`}>{TYPE_ICON[t]}{t}: {cnt}</span>
                        })}
                      </div>
                      {c.last_outcome&&(
                        <div className="bg-white border border-emerald-100 rounded-xl px-3 py-2 mb-3">
                          <p className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide mb-0.5">Last Outcome</p>
                          <p className="text-xs text-gray-700 leading-relaxed line-clamp-2">{c.last_outcome}</p>
                        </div>
                      )}
                      <button onClick={()=>onNavigate('activities',{customerId:c.customer_id,customerName:c.customer_name,userId:selectedUid,...navRange})}
                        className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 font-semibold transition-colors">
                        <Activity size={12}/>View all activities for {c.customer_name}<ChevronRight size={11}/>
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        )}
        </>
      )}

      {panelCustomer&&(()=>{
        const c:any=panelCustomer
        const compPct=c.total_activities>0?Math.round(c.completed/c.total_activities*100):0
        const ringColor=compPct>=80?'#10b981':compPct>=60?'#2563eb':compPct>=40?'#f59e0b':'#ef4444'
        const activityChips=[
          {type:'Phone Call',label:'Phone Call',icon:<PhoneCall size={18}/>,val:c.calls||0,color:'text-blue-700',bg:'bg-blue-50',ring:'ring-blue-100'},
          {type:'Video Call',label:'Video Call',icon:<Video size={18}/>,val:c.video_calls||0,color:'text-cyan-700',bg:'bg-cyan-50',ring:'ring-cyan-100'},
          {type:'In Person Meet',label:'In Person Meet',icon:<Handshake size={18}/>,val:c.meetings||0,color:'text-violet-700',bg:'bg-violet-50',ring:'ring-violet-100'},
          {type:'Demo',label:'Demo',icon:<Monitor size={18}/>,val:c.demos||0,color:'text-emerald-700',bg:'bg-emerald-50',ring:'ring-emerald-100'},
          {type:'Site Visit',label:'Site Visit',icon:<Navigation size={18}/>,val:c.site_visits||0,color:'text-orange-700',bg:'bg-orange-50',ring:'ring-orange-100'},
          {type:'Follow Up',label:'Follow Up',icon:<Repeat2 size={18}/>,val:c.follow_ups||0,color:'text-amber-700',bg:'bg-amber-50',ring:'ring-amber-100'},
          {type:'Email',label:'Email',icon:<Mail size={18}/>,val:c.emails||0,color:'text-slate-700',bg:'bg-slate-100',ring:'ring-slate-200'},
        ]
        const potentialValue=(c.lead_value||0)+(c.tender_value||0)
        const activeTypes=activityChips.filter(a=>a.val>0).length
        const pending=Math.max((c.total_activities||0)-(c.completed||0),0)
        const summaryCards=[
          {label:'Total Activities',value:String(c.total_activities),sub:`${c.completed||0} completed`,color:'text-blue-700',bg:'bg-white border border-blue-100'},
          {label:`${leadSingular} Pipeline`,value:(c.lead_value||0)>0?fmt(c.lead_value):'--',sub:`${c.lead_count||0} ${leadLabelLower}`,color:'text-violet-700',bg:'bg-white border border-violet-100',onClick:c.lead_count>0?()=>onLeadClick(c.customer_id,c.customer_name):undefined},
          {label:opportunityLabel,value:(c.opportunity_count||0)>0?String(c.opportunity_count):'--',sub:(c.opportunity_value||0)>0?fmt(c.opportunity_value):`no ${opportunitySingular.toLowerCase()} value`,color:'text-blue-700',bg:'bg-white border border-blue-100',onClick:c.opportunity_count>0?()=>onLeadClick(c.customer_id,c.customer_name):undefined},
          {label:`${tenderSingular} Value`,value:(c.tender_value||0)>0?fmt(c.tender_value):'--',sub:`${c.tender_count||0} ${tenderLabelLower}`,color:'text-orange-700',bg:'bg-white border border-orange-100',onClick:c.tender_count>0?()=>onTenderClick(c.customer_id,c.customer_name):undefined},
          {label:'Revenue Booked',value:(c.wo_value||0)>0?fmt(c.wo_value):'--',sub:(c.payment_received||0)>0?`${fmt(c.payment_received)} received`:`${c.wo_count||0} ${workOrderLabelLower}`,color:'text-emerald-700',bg:'bg-white border border-emerald-100'},
        ]
        const pipelineTabs=[
          {key:'overview' as const,label:'Activity Overview',sub:`${c.total_activities||0} activities`,icon:<Activity size={17}/>,color:'text-slate-700',ring:'ring-slate-200',line:'bg-slate-200',onClick:()=>setPanelTab('overview')},
          {key:'leads' as const,label:leadLabel,sub:`${c.lead_count||0} ${leadLabelLower}, ${fmt(c.lead_value||0)}`,icon:<TrendingUp size={17}/>,color:'text-blue-700',ring:'ring-blue-100',line:'bg-blue-200',onClick:()=>loadCustomerLeads(c,'leads')},
          {key:'tenders' as const,label:tenderLabel,sub:`${c.tender_count||0} ${tenderLabelLower}, ${fmt(c.tender_value||0)}`,icon:<FileText size={17}/>,color:'text-amber-700',ring:'ring-amber-100',line:'bg-amber-200',onClick:()=>loadCustomerTenders(c)},
          {key:'opportunities' as const,label:opportunitySingular,sub:`${c.opportunity_count||0} ${opportunityLabelLower}`,icon:<Star size={17}/>,color:'text-violet-700',ring:'ring-violet-100',line:'bg-violet-200',onClick:()=>loadCustomerLeads(c,'opportunities')},
          {key:'conversion' as const,label:'Conversion',sub:(c.wo_value||0)>0?`${fmt(c.wo_value)} revenue`:`${c.wo_count||0} ${workOrderLabelLower}`,icon:<IndianRupee size={17}/>,color:'text-emerald-700',ring:'ring-emerald-100',line:'bg-emerald-200',onClick:()=>loadCustomerConversions(c)},
        ]
        const tabLeads = panelTab==='opportunities'
          ? customerLeads.filter((l:any)=>l.status==='Opportunity Created')
          : customerLeads
        const visibleCustomerLeads = customerTenderSearch
          ? tabLeads.filter((l:any)=>[l.lead_title,l.lead_name,l.customer_name,l.assigned_to_name,l.status,l.lead_ref_id,l.opportunity_ref_id].some((f:any)=>(f||'').toLowerCase().includes(customerTenderSearch.toLowerCase())))
          : tabLeads
        const visibleCustomerTenders = customerTenderSearch
          ? customerTenders.filter((t:any)=>[t.tender_title,t.customer_name,t.assigned_to_name,t.portal_ref_number,t.tender_status].some((f:any)=>(f||'').toLowerCase().includes(customerTenderSearch.toLowerCase())))
          : customerTenders
        const visibleCustomerWorkOrders = customerTenderSearch
          ? customerWorkOrders.filter((wo:any)=>[wo.tender_title,wo.project_title,wo.customer_name,wo.assigned_to_name,wo.portal_ref_number,wo.wrk_order_id,wo.po_num,wo.wo_status,wo.tender_status].some((f:any)=>(f||'').toLowerCase().includes(customerTenderSearch.toLowerCase())))
          : customerWorkOrders
        return (
          <SlidePanel
            open={!!panelCustomer}
            onClose={()=>setExpandedId(null)}
            title={`${c.customer_name||customerSingular} Activity Breakdown`}
            subtitle={
              <div className="flex flex-wrap items-center gap-2 font-semibold">
                <span>{c.total_activities||0} activities</span>
                <span className="text-white/35">-</span>
                <span>{potentialValue>0?fmt(potentialValue):'no pipeline'}</span>
                <span className="text-white/35">-</span>
                <span className="text-violet-200">{leadLabel} {fmt(c.lead_value||0)}</span>
                <span className="text-white/35">-</span>
                <span className="text-amber-200">{tenderLabel} {fmt(c.tender_value||0)}</span>
              </div>
            }
            width="w-[800px]"
            headerClassName="bg-gradient-to-r from-slate-700 to-slate-900 border-slate-900 [&_h2]:text-white [&_div]:text-white/70"
            bodyClassName="!px-0 !py-0 bg-white"
            footer={<Button onClick={()=>setExpandedId(null)}>Close</Button>}
          >
            <div>
              <div className="space-y-3 border-b border-slate-200 bg-white px-6 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-700">
                    {c.completed||0} Completed
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-700">
                    {pending} Pending
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-700">
                    {activityChips.length-activeTypes} No Activity
                  </span>
                  <div className="ml-auto flex min-w-[280px] flex-[1_1_360px] items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5">
                    <span className="whitespace-nowrap text-[11px] font-bold text-slate-600">Activity Performance</span>
                    <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-emerald-500 transition-all" style={{width:`${compPct}%`}}/>
                    </div>
                    <span className="whitespace-nowrap text-[11px] font-bold text-emerald-700">{c.completed||0}/{c.total_activities||0}</span>
                  </div>
                </div>

                <div className="flex items-start gap-3 overflow-x-auto py-2">
                  {pipelineTabs.map((tab,i)=>(
                    <div key={tab.label} className="flex min-w-[122px] flex-1 items-start">
                      <button type="button" onClick={tab.onClick}
                        className="group flex w-full flex-col items-center text-center cursor-pointer">
                        <span className={`flex h-11 w-11 items-center justify-center rounded-full bg-white ${tab.color} shadow-sm ring-4 ${panelTab===tab.key?'ring-blue-200':tab.ring} transition-transform group-hover:scale-105`}>
                          {tab.icon}
                        </span>
                        <span className={`mt-2 text-sm font-bold ${panelTab===tab.key?'text-blue-700':tab.color}`}>{tab.label}</span>
                        <span className="mt-0.5 max-w-[128px] truncate text-xs font-medium text-slate-400">{tab.sub}</span>
                      </button>
                      {i<pipelineTabs.length-1&&(
                        <div className={`mt-[22px] h-0.5 min-w-14 flex-1 rounded-full ${tab.line}`}/>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {panelTab==='overview'&&<div className="divide-y divide-slate-100">
                {activityChips.map(a=>(
                  <button key={a.type}
                    onClick={()=>onNavigate('activities',{activityType:a.type,customerId:c.customer_id,customerName:c.customer_name,userId:selectedUid,...navRange})}
                    className={`flex w-full items-center gap-4 px-6 py-4 text-left transition-colors ${a.val>0?'bg-emerald-50/70 hover:bg-emerald-100/80':'bg-white hover:bg-slate-50'}`}>
                    <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${a.bg} ${a.color} ring-1 ${a.ring}`}>
                      {a.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-bold text-slate-950">
                        <span className={`inline-flex h-6 w-6 items-center justify-center rounded-md ${a.bg} ${a.color}`}>{a.icon}</span>{a.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-400">
                        {[c.city,c.vertical].filter(Boolean).join(' - ') || `${customerSingular} activity`}
                      </span>
                      <span className="mt-2 inline-flex items-center rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-600">
                        <Clock size={11} className="mr-1"/>{c.last_activity_date?'Last Activity ': 'No Last Activity'}{c.last_activity_date||''}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-2">
                      <span className={`rounded-full px-3 py-1 text-xs font-bold ${a.val>0?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-500'}`}>
                        {a.val>0?'Active':'No activity'}
                      </span>
                      <span className={`text-sm font-bold ${a.color}`}>{a.val} {a.val===1?'activity':'activities'}</span>
                    </span>
                  </button>
                ))}
              </div>}

              {(panelTab==='leads'||panelTab==='opportunities')&&(
                <div className="bg-white">
                  <div className="border-b border-slate-100 px-6 py-3">
                    <div className="relative">
                      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
                      <input value={customerTenderSearch} onChange={e=>setCustomerTenderSearch(e.target.value)}
                        className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                        placeholder={panelTab==='opportunities'?`Search ${opportunityLabelLower}...`:`Search ${leadLabelLower}...`}/>
                    </div>
                  </div>
                  {customerTenderLoading ? (
                    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"/>Loading {panelTab==='opportunities'?opportunityLabelLower:leadLabelLower}...
                    </div>
                  ) : visibleCustomerLeads.length===0 ? (
                    <div className="py-12 text-center text-sm text-slate-400">{customerTenderSearch?'No matches':`No ${panelTab==='opportunities'?opportunityLabelLower:leadLabelLower} found`}</div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {visibleCustomerLeads.map((l:any)=>(
                        <div key={l.id || l.lead_ref_id || l.opportunity_ref_id} className="flex items-start gap-3 px-6 py-4 hover:bg-blue-50/40">
                          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${panelTab==='opportunities'?'bg-violet-100 text-violet-700':'bg-blue-100 text-blue-700'}`}>
                            {panelTab==='opportunities'?<Star size={16}/>:<TrendingUp size={16}/>}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-bold text-slate-950">{l.lead_title || l.lead_name || leadSingular}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              <span className="inline-flex items-center gap-1"><Building2 size={11}/>{l.customer_name || c.customer_name}</span>
                              {(l.opportunity_ref_id||l.lead_ref_id)&&<span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-white">{l.opportunity_ref_id||l.lead_ref_id}</span>}
                            </div>
                            {l.assigned_to_name&&<p className="mt-1 text-xs font-medium text-indigo-500">{l.assigned_to_name}</p>}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${l.status==='Opportunity Created'?'bg-violet-100 text-violet-700':l.status==='Lost'?'bg-red-100 text-red-600':l.status==='Converted'?'bg-emerald-100 text-emerald-700':'bg-blue-100 text-blue-700'}`}>
                              {l.status || leadSingular}
                            </span>
                            <span className="text-sm font-bold text-slate-900">{((l.est_value||l.lead_value||0)>0)?fmt(l.est_value||l.lead_value):'--'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {panelTab==='tenders'&&(
                <div className="bg-white">
                  <div className="border-b border-slate-100 px-6 py-3">
                    <div className="relative">
                      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
                      <input value={customerTenderSearch} onChange={e=>setCustomerTenderSearch(e.target.value)}
                        className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                        placeholder={`Search ${tenderLabelLower}...`}/>
                    </div>
                  </div>
                  {customerTenderLoading ? (
                    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-orange-400 border-t-transparent"/>Loading {tenderLabelLower}...
                    </div>
                  ) : visibleCustomerTenders.length===0 ? (
                    <div className="py-12 text-center text-sm text-slate-400">{customerTenderSearch?`No matching ${tenderLabelLower}`:`No ${tenderLabelLower} found`}</div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {visibleCustomerTenders.map((t:any)=>(
                        <div key={t.id || t.tender_id || t.portal_ref_number} className="flex items-start gap-3 px-6 py-4 hover:bg-orange-50/40">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-100 text-orange-700">
                            <FileText size={16}/>
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-bold text-slate-950">{t.tender_title || t.title || tenderSingular}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              <span className="inline-flex items-center gap-1"><Building2 size={11}/>{t.customer_name || c.customer_name}</span>
                              {t.portal_ref_number&&<span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-white">{t.portal_ref_number}</span>}
                            </div>
                            {t.assigned_to_name&&<p className="mt-1 text-xs font-medium text-indigo-500">{t.assigned_to_name}</p>}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${t.tender_status==='Won'||t.result==='Won'?'bg-emerald-100 text-emerald-700':t.tender_status==='Lost'||t.result==='Lost'?'bg-red-100 text-red-600':t.tender_status==='Submitted'?'bg-blue-100 text-blue-700':'bg-amber-100 text-amber-700'}`}>
                              {t.tender_status || t.result || 'Active'}
                            </span>
                            <span className="text-sm font-bold text-slate-900">{(t.est_value||0)>0?fmt(t.est_value):'--'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {panelTab==='conversion'&&(
                <div className="bg-white">
                  <div className="border-b border-slate-100 px-6 py-3">
                    <div className="relative">
                      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
                      <input value={customerTenderSearch} onChange={e=>setCustomerTenderSearch(e.target.value)}
                        className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                        placeholder="Search conversions..."/>
                    </div>
                  </div>
                  {customerTenderLoading ? (
                    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent"/>Loading conversions...
                    </div>
                  ) : visibleCustomerWorkOrders.length===0 ? (
                    <div className="py-12 text-center text-sm text-slate-400">{customerTenderSearch?'No matches':'No conversions found'}</div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {visibleCustomerWorkOrders.map((wo:any)=>(
                        <div key={wo.id || wo.wrk_order_id || wo.tender_num} className="flex items-start gap-3 px-6 py-4 hover:bg-emerald-50/40">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                            <IndianRupee size={16}/>
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-bold text-slate-950">{wo.project_title || wo.tender_title || wo.wrk_order_id || 'Conversion'}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              <span className="inline-flex items-center gap-1"><Building2 size={11}/>{wo.customer_name || c.customer_name}</span>
                              {(wo.wrk_order_id||wo.po_num||wo.portal_ref_number)&&<span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-white">{wo.wrk_order_id||wo.po_num||wo.portal_ref_number}</span>}
                            </div>
                            {wo.assigned_to_name&&<p className="mt-1 text-xs font-medium text-indigo-500">{wo.assigned_to_name}</p>}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                              {wo.wo_status || wo.po_workflow_status || wo.result || 'Converted'}
                            </span>
                            <span className="text-sm font-bold text-slate-900">{((wo.wo_value||wo.po_value||wo.bid_amount||0)>0)?fmt(wo.wo_value||wo.po_value||wo.bid_amount):'--'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-4 px-6 py-4">
                {c.last_outcome&&(
                  <div className="rounded-xl border border-emerald-100 bg-white px-4 py-3">
                    <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">Last Outcome</p>
                    <p className="text-sm leading-relaxed text-slate-700">{c.last_outcome}</p>
                  </div>
                )}

                <button onClick={()=>onNavigate('activities',{customerId:c.customer_id,customerName:c.customer_name,userId:selectedUid,...navRange})}
                  className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600 hover:text-blue-700">
                  <Activity size={14}/>View all activities for {c.customer_name}<ChevronRight size={13}/>
                </button>
              </div>
            </div>

            <div className="space-y-5 hidden">
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 text-base font-bold text-white shadow-md shadow-blue-100">
                    {c.customer_name?.substring(0,2)?.toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-lg font-bold text-slate-950">{c.customer_name}</p>
                    </div>
                    {(c.city||c.vertical)&&<p className="mt-1 text-sm font-medium text-slate-500">{[c.city,c.vertical].filter(Boolean).join(' · ')}</p>}
                  </div>
                  <RingProgress pct={compPct} size={68} stroke={6} color={ringColor} label={`${compPct}%`} sublabel="Complete"/>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {summaryCards.map(({label,value,sub,color,bg,onClick})=>(
                  <div key={label} className={`${bg} rounded-xl p-4 ${onClick?'cursor-pointer hover:shadow-sm transition-shadow':''}`} onClick={onClick}>
                    <p className={`text-xl font-bold ${color}`}>{value}</p>
                    <p className="mt-2 text-xs font-semibold text-slate-700">{label}</p>
                    <p className="mt-0.5 text-xs text-slate-400">{sub}</p>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {activityChips.map(a=>(
                  <button key={a.type} onClick={()=>onNavigate('activities',{activityType:a.type,customerId:c.customer_id,customerName:c.customer_name,userId:selectedUid,...navRange})}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ${a.bg} ${a.color} hover:ring-1 hover:ring-current/20`}>
                    {a.icon}{a.label}: {a.val}
                  </button>
                ))}
              </div>

              {c.last_outcome&&(
                <div className="rounded-xl border border-emerald-100 bg-white px-4 py-3">
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">Last Outcome</p>
                  <p className="text-sm leading-relaxed text-slate-700">{c.last_outcome}</p>
                </div>
              )}

              <button onClick={()=>onNavigate('activities',{customerId:c.customer_id,customerName:c.customer_name,userId:selectedUid,...navRange})}
                className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600 hover:text-blue-700">
                <Activity size={14}/>View all activities for {c.customer_name}<ChevronRight size={13}/>
              </button>
            </div>
          </SlidePanel>
        )
      })()}
    </div>
  )
}
