import { useState, useMemo, useCallback, useRef } from 'react'
import {
  GitBranch, Users, Building2, Activity, ChevronUp, ChevronDown,
  Crown, ArrowUpRight, ArrowDownRight, Minus, Plus,
  UserCircle, Search, X,
  ChevronRight, PhoneCall, Handshake, Target,
} from 'lucide-react'
import SlidePanel from '@/components/ui/SlidePanel'
import { useAuthStore } from '@/store'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  fmt, KAM_GROUP_GRADIENTS, ACTIVITY_TYPES, TYPE_ICON, TYPE_COLOR,
  RoleBadge, RingProgress, ROLE_CFG, roleLabel,
} from './shared'

// Mini sparkline
export function SparkBar({values,color='bg-blue-500'}:{values:number[];color?:string}) {
  const max=Math.max(...values,1)
  return (
    <div className="flex items-end gap-0.5 h-8">
      {values.map((v,i)=>(
        <div key={i} className={`flex-1 rounded-sm ${color} opacity-80`} style={{height:`${Math.max(4,(v/max)*100)}%`}}/>
      ))}
    </div>
  )
}

// Trend badge
export function TrendBadge({current,prev,label}:{current:number;prev:number;label:string}) {
  if(prev===0&&current===0) return <span className="text-[10px] text-gray-400">{label}: —</span>
  const delta=prev>0?Math.round(((current-prev)/prev)*100):100
  const up=delta>=0
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold ${up?'text-emerald-600':'text-red-500'}`}>
      {up?<ArrowUpRight size={10}/>:<ArrowDownRight size={10}/>}{Math.abs(delta)}% {label}
    </span>
  )
}

// Multi-metric comparison chart
export function ComparisonChart({members,metric,label}:{members:any[];metric:string;label:string}) {
  if(!members.length) return null
  const vals=members.map(m=>Number(m[metric]||0))
  const max=Math.max(...vals,1)
  const COLORS=['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ec4899','#06b6d4','#f97316','#6366f1']
  return (
    <div>
      <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">{label}</p>
      <div className="space-y-2.5">
        {members.map((m,i)=>{
          const v=Number(m[metric]||0)
          const p=max>0?Math.round((v/max)*100):0
          return (
            <div key={m.user_id} className="flex items-center gap-3">
              <div className="w-6 h-6 rounded-lg flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0"
                style={{background:COLORS[i%COLORS.length]}}>
                {m.user_name?.charAt(0)?.toUpperCase()}
              </div>
              <span className="text-[11px] text-gray-600 w-24 truncate flex-shrink-0">{m.user_name?.split(' ')[0]}</span>
              <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700"
                  style={{width:`${p}%`,background:COLORS[i%COLORS.length]}}/>
              </div>
              <span className="text-[11px] font-bold text-gray-700 w-16 text-right flex-shrink-0">
                {metric.includes('value')||metric.includes('wo_value')?fmt(v):String(v)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Individual KAM deep card
export function KAMMemberDeepCard({m,onLeadPanel,onTenderPanel,onCustomerPanel,period,expanded,onToggle,allMembers}:{
  m:any;onLeadPanel:(uid:number,name:string)=>void;onTenderPanel:(uid:number,name:string)=>void;onCustomerPanel:(uid:number,name:string)=>void;
  period:string;expanded:boolean;onToggle:()=>void;allMembers:any[];
}) {
  const actPct=m.total>0?Math.round((m.completed/m.total)*100):0
  const targetRevenue=m.wo_value||m.won_tender_value||0
  const salesPct=m.sales_target>0?Math.min(100,Math.round((targetRevenue/m.sales_target)*100)):0
  const targetRemaining=Math.max(0,(m.sales_target||0)-targetRevenue)
  const callPct=m.calls_target>0?Math.min(100,Math.round((m.calls/m.calls_target)*100)):0
  const meetPct=m.meetings_target>0?Math.min(100,Math.round((m.meetings/m.meetings_target)*100)):0
  const ringColor=actPct>=80?'#10b981':actPct>=60?'#3b82f6':actPct>=40?'#f59e0b':'#ef4444'
  const reports=allMembers.filter((u:any)=>u.reporting_manager_id===m.user_id||u.parent_user_id===m.user_id)
  const { labelLower: customerLabelLower } = useModuleName('customers')
  const { singular: leadSingular, labelLower: leadLabelLower } = useModuleName('leads')
  const { singular: tenderSingular, labelLower: tenderLabelLower } = useModuleName('tenders')
  const { label: workOrderLabel } = useModuleName('workorders')

  return (
    <div className={`rounded-2xl border overflow-hidden transition-all duration-200 ${m.is_self?'border-blue-200 bg-blue-50/20':'border-gray-200 bg-white'} ${expanded?'shadow-md':''}`}>
      {/* Header row */}
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={onToggle}>
        <div className="relative flex-shrink-0">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold text-white ${m.is_self?'bg-gradient-to-br from-blue-500 to-indigo-600':'bg-gradient-to-br from-slate-500 to-slate-700'}`}>
            {m.user_name?.charAt(0)?.toUpperCase()}
          </div>
          {m.is_self&&<div className="absolute -top-1 -right-1 w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center"><Crown size={8} className="text-white"/></div>}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-gray-900">{m.user_name}</span>
            {m.is_self&&<span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold">YOU</span>}
            <RoleBadge role={m.role}/>
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[11px] text-gray-400 flex-wrap">
            <span className="flex items-center gap-1"><Activity size={9}/>{m.completed}/{m.total} done</span>
            <span className="flex items-center gap-1 text-emerald-600 cursor-pointer hover:underline"
              onClick={e=>{e.stopPropagation();onCustomerPanel(m.user_id,m.user_name)}}>
              <Building2 size={9}/>{m.own_customers??m.customers} {customerLabelLower} ↗
            </span>
            {reports.length>0&&<span className="flex items-center gap-1 text-violet-500"><Users size={9}/>{reports.length} reports</span>}
          </div>
        </div>

        {/* Ring + mini bars */}
        <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
          <RingProgress pct={actPct} size={44} stroke={4} color={ringColor} label={`${actPct}%`}/>
          <div className="space-y-1.5 min-w-[88px]">
            <div>
              <div className="flex justify-between text-[9px] text-gray-400 mb-0.5">
                <span>Calls</span><span className="font-bold text-blue-600">{m.calls}{m.calls_target>0?`/${m.calls_target}`:''}</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full" style={{width:`${Math.min(100,callPct||Math.min(50,m.calls>0?100:0))}%`}}/>
              </div>
            </div>
            <div>
              <div className="flex justify-between text-[9px] text-gray-400 mb-0.5">
                <span>Meets</span><span className="font-bold text-violet-600">{m.meetings}{m.meetings_target>0?`/${m.meetings_target}`:''}</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-violet-500 rounded-full" style={{width:`${Math.min(100,meetPct||Math.min(50,m.meetings>0?100:0))}%`}}/>
              </div>
            </div>
          </div>
        </div>

        {/* Revenue + pills */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="hidden md:flex flex-col gap-1 text-right">
            <span onClick={e=>{e.stopPropagation();onLeadPanel(m.user_id,m.user_name)}}
              className="cursor-pointer text-[11px] bg-violet-50 text-violet-700 hover:bg-violet-100 px-2 py-0.5 rounded-lg font-bold transition-colors">{m.lead_count||0} {leadLabelLower} ↗</span>
            <span onClick={e=>{e.stopPropagation();onTenderPanel(m.user_id,m.user_name)}}
              className="cursor-pointer text-[11px] bg-orange-50 text-orange-700 hover:bg-orange-100 px-2 py-0.5 rounded-lg font-bold transition-colors">{m.tender_count||0} {tenderLabelLower} ↗</span>
          </div>
          {m.sales_target>0&&(
            <div className="hidden lg:block text-right min-w-[80px]">
              <p className={`text-sm font-bold ${salesPct>=100?'text-emerald-600':salesPct>=70?'text-blue-600':'text-amber-600'}`}>{fmt(targetRevenue)}</p>
              <p className="text-[10px] text-gray-400">/ {fmt(m.sales_target)}</p>
              <div className="h-1 bg-gray-100 rounded-full overflow-hidden mt-1">
                <div className={`h-full rounded-full ${salesPct>=100?'bg-emerald-500':salesPct>=70?'bg-blue-500':'bg-amber-400'}`} style={{width:`${salesPct}%`}}/>
              </div>
            </div>
          )}
          {expanded?<ChevronUp size={14} className="text-gray-400"/>:<ChevronDown size={14} className="text-gray-400"/>}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded&&(
        <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-4">
          {/* KPI tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
            {[
              {label:`${leadSingular} Value`,value:fmt(m.lead_value||0),sub:`${m.lead_count||0} ${leadLabelLower}`,color:'text-violet-700',bg:'bg-violet-50 border border-violet-100',onClick:()=>onLeadPanel(m.user_id,m.user_name)},
              {label:`${tenderSingular} Value`,value:fmt(m.tender_value||0),sub:`${m.tender_count||0} ${tenderLabelLower}`,color:'text-orange-700',bg:'bg-orange-50 border border-orange-100',onClick:()=>onTenderPanel(m.user_id,m.user_name)},
              {label:workOrderLabel,value:String(m.wo_count||0),sub:(m.wo_value||0)>0?fmt(m.wo_value):'—',color:'text-emerald-700',bg:'bg-emerald-50 border border-emerald-100'},
              {label:'Payment Recv.',value:(m.payment_received||0)>0?fmt(m.payment_received):'—',sub:'Collected',color:'text-amber-700',bg:'bg-amber-50 border border-amber-100'},
              {label:'On Target',value:(m.sales_target||0)>0?`${fmt(targetRevenue)} / ${fmt(m.sales_target)}`:'—',sub:(m.sales_target||0)>0?(salesPct>=100?'Target achieved':`${fmt(targetRemaining)} remaining`):'No target',color:salesPct>=100?'text-emerald-700':salesPct>=70?'text-blue-700':'text-amber-700',bg:'bg-sky-50 border border-sky-100',progress:salesPct},
            ].map(({label,value,sub,color,bg,onClick,progress})=>(
              <div key={label} className={`${bg} rounded-xl p-3 ${onClick?'cursor-pointer hover:opacity-80 transition-opacity':''}`} onClick={onClick}>
                <p className={`text-lg font-bold ${color}`}>{value}</p>
                <p className="text-[10px] text-gray-600 font-medium">{label}</p>
                {label==='On Target'&&m.sales_target>0&&(
                  <div className="my-1.5 h-1.5 overflow-hidden rounded-full bg-gray-100">
                    <div className={`h-full rounded-full ${salesPct>=100?'bg-emerald-500':salesPct>=70?'bg-blue-500':'bg-amber-400'}`} style={{width:`${progress||0}%`}}/>
                  </div>
                )}
                <p className="text-[10px] text-gray-400">{sub}</p>
                {onClick&&<p className="text-[9px] text-blue-400 mt-0.5">tap to view ↗</p>}
              </div>
            ))}
          </div>
          {/* Activity breakdown */}
          <div className="pt-3 border-t border-gray-200">
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-2">Activity Breakdown</p>
            <div className="flex flex-wrap gap-1.5">
              {ACTIVITY_TYPES.map(t=>{
                const cnt=m.activity_types?.[t]||0
                if(!cnt) return null
                const cc=TYPE_COLOR[t]||{bg:'bg-gray-50',text:'text-gray-500'}
                return <span key={t} className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-lg ${cc.bg} ${cc.text}`}>{TYPE_ICON[t]}{t}: {cnt}</span>
              })}
              {!m.activity_types&&<span className="text-[10px] text-gray-400 italic">No type breakdown available</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Sub-group section inside a group: Manager card + their execs below
export function SubGroupSection({sg,groupMembers,onLeadPanel,onTenderPanel,onCustomerPanel,period,expandedMember,setExpandedMember}:{
  sg:any;groupMembers:any[];
  onLeadPanel:(uid:number,name:string)=>void;onTenderPanel:(uid:number,name:string)=>void;
  onCustomerPanel:(uid:number,name:string,ownOnly?:boolean)=>void;
  period:string;expandedMember:number|null;setExpandedMember:(v:number|null)=>void;
}) {
  const [open,setOpen]=useState(true)
  const { labelLower: customerLabelLower } = useModuleName('customers')
  const mgr = sg.manager
  const execs = mgr ? sg.members.filter((m:any)=>m.user_id!==mgr.user_id) : sg.members
  const subActs=sg.members.reduce((s:number,m:any)=>s+m.total,0)
  const subDone=sg.members.reduce((s:number,m:any)=>s+m.completed,0)
  const mgrCusts=mgr?Number(mgr.own_customers??mgr.customers??0):0
  const subPct=subActs>0?Math.round((subDone/subActs)*100):0

  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      {/* Sub-header: Manager row or plain section header */}
      <div className="flex items-center gap-3 px-3 py-2.5 bg-gray-50/80 cursor-pointer select-none" onClick={()=>setOpen(o=>!o)}>
        {mgr?(
          <>
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
              {mgr.user_name?.charAt(0)?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-gray-800 truncate">{mgr.user_name}</span>
                <RoleBadge role={mgr.role}/>
                {mgr.is_self&&<span className="text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold">YOU</span>}
              </div>
              <div className="flex items-center gap-3 mt-0.5 text-[10px] text-gray-400">
                <span className="flex items-center gap-1"><Users size={8}/>{execs.length} members</span>
                <span onClick={e=>{e.stopPropagation();mgr&&onCustomerPanel(mgr.user_id,mgr.user_name,true)}}
                  className="flex items-center gap-1 cursor-pointer text-emerald-600 hover:underline"><Building2 size={8}/>{mgrCusts} {customerLabelLower} ↗</span>
                <span className="flex items-center gap-1"><Activity size={8}/>{subDone}/{subActs}</span>
                <span className={`font-bold ${subPct>=80?'text-emerald-600':subPct>=60?'text-blue-600':'text-amber-600'}`}>{subPct}%</span>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span onClick={e=>{e.stopPropagation();onLeadPanel(mgr.user_id,mgr.user_name)}}
                className="text-[10px] bg-violet-50 text-violet-700 hover:bg-violet-100 px-1.5 py-0.5 rounded font-bold cursor-pointer transition-colors">{mgr.lead_count||0}L ↗</span>
              <span onClick={e=>{e.stopPropagation();onTenderPanel(mgr.user_id,mgr.user_name)}}
                className="text-[10px] bg-orange-50 text-orange-700 hover:bg-orange-100 px-1.5 py-0.5 rounded font-bold cursor-pointer transition-colors">{mgr.tender_count||0}T ↗</span>
            </div>
          </>
        ):(
          <div className="flex-1">
            <span className="text-xs font-bold text-gray-600 flex items-center gap-1.5"><Users size={11}/>Direct Members <span className="text-gray-400 font-normal">({sg.members.length})</span></span>
          </div>
        )}
        {open?<ChevronUp size={12} className="text-gray-400 flex-shrink-0"/>:<ChevronDown size={12} className="text-gray-400 flex-shrink-0"/>}
      </div>

      {/* Exec cards */}
      {open&&execs.length>0&&(
        <div className="p-2 space-y-1.5 bg-white">
          {execs.map((m:any)=>(
            <KAMMemberDeepCard key={m.user_id} m={m}
              onLeadPanel={onLeadPanel} onTenderPanel={onTenderPanel} onCustomerPanel={onCustomerPanel}
              period={period} expanded={expandedMember===m.user_id}
              onToggle={()=>setExpandedMember(expandedMember===m.user_id?null:m.user_id)}
              allMembers={groupMembers}/>
          ))}
        </div>
      )}
    </div>
  )
}

// Group tree node — top-level group rendered as a table segmented by group
export function GroupTreeNode({group,members,onLeadPanel,onTenderPanel,onCustomerPanel,period}:{
  group:any;members:any[];
  onLeadPanel:(uid:number,name:string)=>void;onTenderPanel:(uid:number,name:string)=>void;
  onCustomerPanel:(uid:number,name:string,ownOnly?:boolean)=>void;
  period:string;isYearly:boolean;viewYear:number;
}) {
  const [expanded,setExpanded]=useState(true)
  const { label: customerLabel, labelLower: customerLabelLower } = useModuleName('customers')
  const { label: leadLabel } = useModuleName('leads')
  const { label: tenderLabel } = useModuleName('tenders')

  const totalActs=members.reduce((s:number,m:any)=>s+m.total,0)
  const completedActs=members.reduce((s:number,m:any)=>s+m.completed,0)
  const totalRevenue=members.reduce((s:number,m:any)=>s+(m.wo_value||0),0)
  const totalTarget=members.reduce((s:number,m:any)=>s+(m.sales_target||0),0)
  // Cumulative own_customers across all members in this group
  const totalCustomers=members.reduce((s:number,m:any)=>s+Number(m.own_customers??m.customers??0),0)
  // Group head = from Group Fixing manager_id first, then VP, then manager/sales_head, then first member
  const groupHead=(group.manager&&members.find((m:any)=>Number(m.user_id)===Number(group.manager?.user_id)))
    ||members.find((m:any)=>['vp'].includes(String(m.role||'').toLowerCase()))
    ||members.find((m:any)=>['manager','sales_head'].includes(String(m.role||'').toLowerCase()))
    ||members[0]
  const headCustomers=groupHead?Number(groupHead.own_customers??groupHead.customers??0):0
  const groupPct=totalActs>0?Math.round((completedActs/totalActs)*100):0
  const revPct=totalTarget>0?Math.min(100,Math.round((totalRevenue/totalTarget)*100)):0

  // Sort: head first, then others alphabetically
  const sortedMembers=[...members].sort((a:any,b:any)=>{
    const aHead=a.user_id===groupHead?.user_id?0:1
    const bHead=b.user_id===groupHead?.user_id?0:1
    return aHead-bHead||(a.user_name||'').localeCompare(b.user_name||'')
  })

  const gradClass=KAM_GROUP_GRADIENTS[Math.abs(Number.isFinite(group.idx)?group.idx:Number.isFinite(group.id)?group.id:0)%KAM_GROUP_GRADIENTS.length]

  return (
    <div className="rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
      {/* Group header */}
      <div className={`bg-gradient-to-r ${gradClass} px-4 py-4 cursor-pointer`} onClick={()=>setExpanded(e=>!e)}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center flex-shrink-0">
            <GitBranch size={15} className="text-white"/>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <p className="text-sm font-bold text-white truncate">{group.name}</p>
              <span className="text-[10px] bg-white/20 text-white px-1.5 py-0.5 rounded-lg font-semibold flex-shrink-0">{members.length} members</span>
              {group.region_name&&<span className="text-[10px] bg-white/15 text-white/80 px-1.5 py-0.5 rounded-lg flex-shrink-0">📍 {group.region_name}</span>}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-white/75 flex-wrap">
              {/* Cumulative customer count for whole group */}
              <span onClick={e=>{e.stopPropagation();groupHead&&onCustomerPanel(groupHead.user_id,group.name)}}
                className="flex items-center gap-1 cursor-pointer hover:text-white transition-colors">
                <Building2 size={9}/>{totalCustomers} {customerLabelLower} total ↗
              </span>
              {/* Head's own customers */}
              {groupHead&&(
                <span onClick={e=>{e.stopPropagation();onCustomerPanel(groupHead.user_id,groupHead.user_name,true)}}
                  className="flex items-center gap-1 cursor-pointer hover:text-white transition-colors text-white/55">
                  · {headCustomers} by {groupHead.user_name} ↗
                </span>
              )}
              <span className="flex items-center gap-1"><Activity size={9}/>{completedActs}/{totalActs} activities</span>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
            <RingProgress pct={groupPct} size={44} stroke={4} color="rgba(255,255,255,0.9)" label={`${groupPct}%`} sublabel="done"/>
            {totalTarget>0&&(
              <div className="min-w-[68px]">
                <div className="flex justify-between text-[9px] text-white/60 mb-0.5"><span>Revenue</span><span>{revPct}%</span></div>
                <div className="h-1.5 bg-white/20 rounded-full overflow-hidden">
                  <div className="h-full bg-white rounded-full" style={{width:`${revPct}%`}}/>
                </div>
              </div>
            )}
          </div>
          {expanded?<ChevronUp size={15} className="text-white flex-shrink-0"/>:<ChevronDown size={15} className="text-white flex-shrink-0"/>}
        </div>
      </div>

      {/* Members table */}
      {expanded&&(
        <div className="bg-white overflow-x-auto">
          {members.length===0?(
            <p className="text-xs text-gray-400 text-center py-6">No members in this group</p>
          ):(
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/80">
                  <th className="text-left px-4 py-2.5 font-semibold text-gray-500">Member</th>
                  <th className="text-left px-3 py-2.5 font-semibold text-gray-500">Role</th>
                  <th className="text-right px-3 py-2.5 font-semibold text-gray-500">{customerLabel}</th>
                  <th className="text-right px-3 py-2.5 font-semibold text-gray-500">Activities</th>
                  <th className="text-right px-3 py-2.5 font-semibold text-gray-500 hidden sm:table-cell">{leadLabel}</th>
                  <th className="text-right px-4 py-2.5 font-semibold text-gray-500 hidden sm:table-cell">{tenderLabel}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {sortedMembers.map((m:any)=>{
                  const isHead=m.user_id===groupHead?.user_id
                  const ownCusts=Number(m.own_customers??m.customers??0)
                  const actPct=m.total>0?Math.round((m.completed/m.total)*100):0
                  return (
                    <tr key={m.user_id} className={`transition-colors hover:bg-gray-50/60 ${isHead?'bg-indigo-50/40':''}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold text-white flex-shrink-0 ${isHead?'bg-gradient-to-br from-indigo-500 to-purple-600':'bg-gradient-to-br from-slate-400 to-slate-600'}`}>
                            {m.user_name?.charAt(0)?.toUpperCase()}
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`font-semibold ${isHead?'text-indigo-900':'text-gray-800'}`}>{m.user_name}</span>
                            {m.is_self&&<span className="text-[8px] bg-blue-100 text-blue-700 px-1 py-0.5 rounded font-bold">YOU</span>}
                            {isHead&&<span className="text-[8px] bg-indigo-100 text-indigo-700 px-1 py-0.5 rounded font-bold">HEAD</span>}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3"><RoleBadge role={m.role}/></td>
                      <td className="px-3 py-3 text-right">
                        <span onClick={e=>{e.stopPropagation();onCustomerPanel(m.user_id,m.user_name,true)}}
                          className="inline-flex items-center gap-1 cursor-pointer text-emerald-600 hover:text-emerald-700 hover:underline font-semibold">
                          <Building2 size={9}/>{ownCusts} ↗
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <span className={`font-semibold ${actPct>=80?'text-emerald-600':actPct>=60?'text-blue-600':'text-amber-600'}`}>{m.completed}/{m.total}</span>
                          <span className="text-gray-300">·</span>
                          <span className={`text-[10px] font-bold ${actPct>=80?'text-emerald-500':actPct>=60?'text-blue-500':'text-amber-500'}`}>{actPct}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right hidden sm:table-cell">
                        <span onClick={e=>{e.stopPropagation();onLeadPanel(m.user_id,m.user_name)}}
                          className="cursor-pointer text-violet-600 hover:underline font-semibold">{m.lead_count||0} ↗</span>
                      </td>
                      <td className="px-4 py-3 text-right hidden sm:table-cell">
                        <span onClick={e=>{e.stopPropagation();onTenderPanel(m.user_id,m.user_name)}}
                          className="cursor-pointer text-orange-600 hover:underline font-semibold">{m.tender_count||0} ↗</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// ── Org chart card ─────────────────────────────────────────────────────
export function OrgPersonCard({person,calls,meetings,customers,roleLabel,groupName='',c1,c2,isSelf=false,hasChildren=false,isExpanded=true,highlight=false,onToggle,onSelect,onCustomerPanel}:{
  person:any;calls:number;meetings:number;customers:number;roleLabel:string;groupName?:string;c1:string;c2:string;
  isSelf?:boolean;hasChildren?:boolean;isExpanded?:boolean;highlight?:boolean;
  onToggle?:()=>void;onSelect:(p:any)=>void;onCustomerPanel:(uid:number,name:string,ownOnly?:boolean)=>void;
}) {
  const { labelLower: customerLabelLower } = useModuleName('customers')
  return (
    <div className={`relative flex-shrink-0 transition-all ${highlight?'ring-2 ring-yellow-400 ring-offset-2 rounded-2xl':''}`} style={{width:200}}>
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
        onClick={()=>onSelect(person)}>
        <div className="px-4 py-3.5">
          <div className="flex items-start justify-between gap-1 mb-1">
            <p className="text-sm font-bold text-slate-800 truncate leading-snug flex-1">{person.user_name}</p>
            {isSelf&&<span className="flex-shrink-0 text-[8px] bg-blue-100 text-blue-700 font-black px-1.5 py-0.5 rounded leading-none">YOU</span>}
          </div>
          <div className="flex items-center gap-1 mb-2">
            <RoleBadge role={person.role||roleLabel}/>
            {groupName&&<span className="text-[10px] text-slate-400 truncate">· {groupName}</span>}
          </div>
          {!['admin','ceo','super_admin'].includes(String(person.role||'').toLowerCase())&&(
            <>
              <button type="button"
                onClick={e=>{e.stopPropagation();onCustomerPanel(person.user_id,person.user_name,true)}}
                className="text-[15px] font-black text-emerald-600 hover:underline block leading-none">
                {customers} {customerLabelLower}
              </button>
              <p className="text-[10px] text-slate-400 mt-1">{calls} calls · {meetings} mtg</p>
            </>
          )}
        </div>
      </div>
      {hasChildren&&onToggle&&(
        <button type="button"
          onClick={e=>{e.stopPropagation();onToggle()}}
          className="absolute z-20 flex h-5 w-5 items-center justify-center rounded-full border-2 border-blue-400 bg-white shadow-sm hover:border-blue-600 transition-colors"
          style={{right:-10,top:'50%',transform:'translateY(-50%)'}}>
          {isExpanded?<Minus size={8} className="text-blue-500"/>:<Plus size={8} className="text-blue-500"/>}
        </button>
      )}
    </div>
  )
}

// SE leaf card
export function OrgSECard({person,groupName='',highlight=false,onSelect}:{person:any;groupName?:string;highlight?:boolean;onSelect:(p:any)=>void;}) {
  const { labelLower: customerLabelLower } = useModuleName('customers')
  return (
    <div className={`flex-shrink-0 transition-all ${highlight?'ring-2 ring-yellow-400 ring-offset-1 rounded-xl':''}`} style={{width:164}}>
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
        onClick={()=>onSelect(person)}>
        <div className="px-3.5 py-3">
          <p className="text-xs font-bold text-slate-800 truncate leading-snug mb-1">{person.user_name}</p>
          <div className="mb-1.5"><RoleBadge role={person.role||'sales'}/></div>
          <p className="text-sm font-black text-emerald-600 leading-none">{Number(person.own_customers||person.customers||0)} {customerLabelLower}</p>
          <p className="text-[10px] text-slate-400 mt-1">{Number(person.calls||0)} calls · {Number(person.meetings||0)} mtg</p>
        </div>
      </div>
    </div>
  )
}

// Group node card for the org-chart tree
export function OrgGroupCard({group,head,totalCustomers,memberCount,hasChildren,isExpanded,onToggle,highlight,onSelect,onCustomerPanel}:{
  group:any;head:any|null;totalCustomers:number;memberCount:number;
  hasChildren?:boolean;isExpanded?:boolean;onToggle?:()=>void;highlight?:boolean;
  onSelect:(p:any)=>void;onCustomerPanel:(uid:number,name:string,ownOnly?:boolean)=>void;
}) {
  const { labelLower: customerLabelLower } = useModuleName('customers')
  const GRADS:[string,string][]=[
    ['#3b82f6','#4f46e5'],['#0ea5e9','#0369a1'],['#10b981','#059669'],
    ['#8b5cf6','#7c3aed'],['#f59e0b','#d97706'],['#ec4899','#db2777'],
  ]
  const [c1,c2]=GRADS[Math.abs(Number.isFinite(group.idx)?group.idx:Number.isFinite(group.id)?group.id:0)%GRADS.length]
  return (
    <div className={`relative flex-shrink-0${highlight?' ring-2 ring-yellow-400 ring-offset-2 rounded-2xl':''}`} style={{width:196}}>
      <div className="rounded-2xl overflow-hidden border border-slate-200 shadow-sm hover:shadow-md transition-shadow"
        onClick={()=>head&&onSelect(head)}>
        {/* Group name strip */}
        <div className="px-3 py-2 flex items-center gap-1.5 cursor-pointer"
          style={{background:`linear-gradient(135deg,${c1},${c2})`}}>
          <GitBranch size={10} className="text-white/80 flex-shrink-0"/>
          <p className="text-[11px] font-black text-white truncate flex-1">{group.name}</p>
          <span className="text-[9px] bg-white/25 text-white px-1.5 py-0.5 rounded font-bold flex-shrink-0">{memberCount}m</span>
        </div>
        {/* Head person or summary */}
        <div className="px-3 py-2.5 bg-white cursor-pointer">
          {head?(
            <>
              <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                <div className="w-5 h-5 rounded-md flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0"
                  style={{background:`linear-gradient(135deg,${c1},${c2})`}}>
                  {head.user_name?.charAt(0)?.toUpperCase()}
                </div>
                <p className="text-xs font-bold text-slate-800 truncate flex-1">{head.user_name}</p>
                <RoleBadge role={head.role}/>
                {head.is_self&&<span className="text-[8px] bg-blue-100 text-blue-700 px-1 py-0.5 rounded font-bold">YOU</span>}
              </div>
              <button type="button"
                onClick={e=>{e.stopPropagation();onCustomerPanel(head.user_id,head.user_name,true)}}
                className="text-[13px] font-black text-emerald-600 hover:underline block leading-none">
                {Number(head.own_customers??head.customers??0)} {customerLabelLower}
              </button>
              <p className="text-[9px] text-slate-400 mt-0.5">{Number(head.calls||0)} calls · {Number(head.meetings||0)} mtg</p>
            </>
          ):(
            <>
              <p className="text-[13px] font-black text-emerald-600 leading-none">{totalCustomers} {customerLabelLower}</p>
              <p className="text-[9px] text-slate-400 mt-0.5">{memberCount} members</p>
            </>
          )}
        </div>
      </div>
      {hasChildren&&onToggle&&(
        <button type="button"
          onClick={e=>{e.stopPropagation();onToggle()}}
          className="absolute z-20 flex h-5 w-5 items-center justify-center rounded-full border-2 border-blue-400 bg-white shadow-sm hover:border-blue-600 transition-colors"
          style={{right:-10,top:'50%',transform:'translateY(-50%)'}}>
          {isExpanded?<Minus size={8} className="text-blue-500"/>:<Plus size={8} className="text-blue-500"/>}
        </button>
      )}
    </div>
  )
}

export function GroupTreePerformanceView({groups,allTeamRows=[],selectedUid,onCustomerPanel}:{
  groups:any[];allTeamRows?:any[];selectedUid:number|null;
  onCustomerPanel:(uid:number,name:string,ownOnly?:boolean)=>void;
}) {
  const { user: authUser } = useAuthStore()
  const { label: customerLabel, labelLower: customerLabelLower } = useModuleName('customers')
  const authRole=String(authUser?.role||'').toLowerCase()
  const isAuthAdminCEO=['admin','ceo','super_admin'].includes(authRole)

  const [showTree,setShowTree]=useState(true)
  const [searchQuery,setSearchQuery]=useState('')
  const [detailPerson,setDetailPerson]=useState<any>(null)
  const [collapsedGroups,setCollapsedGroups]=useState<Set<string>>(new Set())

  const isVPRole=(r:string)=>String(r||'').toLowerCase()==='vp'
  const isMgrRole=(r:string)=>['manager','sales_head'].includes(String(r||'').toLowerCase())
  const isAdminRole=(r:string)=>['admin','ceo','super_admin'].includes(String(r||'').toLowerCase())

  const groupPalette = [
    {line:'#60a5fa',soft:'#eff6ff',text:'#2563eb'},
    {line:'#38bdf8',soft:'#f0f9ff',text:'#0284c7'},
    {line:'#34d399',soft:'#ecfdf5',text:'#059669'},
    {line:'#a78bfa',soft:'#f5f3ff',text:'#7c3aed'},
    {line:'#f59e0b',soft:'#fffbeb',text:'#d97706'},
    {line:'#fb7185',soft:'#fff1f2',text:'#e11d48'},
  ]

  const {topPerson,groupedData}=useMemo(()=>{
    const byId=new Map<number,any>()
    const add=(m:any)=>{ if(m?.user_id&&!byId.has(Number(m.user_id))) byId.set(Number(m.user_id),m) }
    allTeamRows.forEach(add)
    groups.forEach((g:any)=>{
      ;(g.members||[]).forEach(add)
      ;(g.subGroups||[]).forEach((sg:any)=>{ add(sg?.manager); (sg?.members||[]).forEach(add) })
    })
    const allMem=Array.from(byId.values())

    let top:any=null
    if(isAuthAdminCEO){
      top=allTeamRows.find(m=>String(m.role||'').toLowerCase()==='ceo')
        ||allTeamRows.find(m=>['super_admin','admin'].includes(String(m.role||'').toLowerCase()))
        ||allMem.find(m=>['ceo','super_admin','admin'].includes(String(m.role||'').toLowerCase()))
        ||(authUser?{user_id:authUser.id,user_name:authUser.full_name,role:authUser.role,calls:0,meetings:0,customers:0,own_customers:0,is_self:true}:null)
    } else {
      const self=selectedUid
        ?allMem.find(m=>Number(m.user_id)===Number(selectedUid))
        :(allTeamRows.find(m=>m.is_self)||allMem.find(m=>m.is_self))
      top=self||allMem.find(m=>isVPRole(m.role))||allMem.find(m=>isMgrRole(m.role))||allMem[0]||null
    }
    const topUid=Number(top?.user_id||0)

    const gData=groups.map((group:any,idx:number)=>{
      const gSeen=new Set<number>()
      const members:any[]=[]
      const addMember=(m:any)=>{
        if(!m?.user_id) return
        const id=Number(m.user_id)
        if(id===topUid) return
        if(gSeen.has(id)) return
        gSeen.add(id)
        members.push(m)
      }
      ;(group.members||[]).forEach(addMember)
      ;(group.subGroups||[]).forEach((sg:any)=>{
        addMember(sg?.manager)
        ;(sg?.members||[]).forEach(addMember)
      })
      const visibleMembers=members
        .filter((m:any)=>!isAdminRole(m.role))
        .sort((a:any,b:any)=>{
          const rank=(r:string)=>isVPRole(r)?1:isMgrRole(r)?2:3
          const ar=rank(a.role), br=rank(b.role)
          if(ar!==br) return ar-br
          return String(a.user_name||'').localeCompare(String(b.user_name||''))
        })
      if(visibleMembers.length===0) return null
      const totalCustomers=visibleMembers.reduce((s:number,m:any)=>s+Number(m.own_customers??m.customers??0),0)
      const totalCalls=visibleMembers.reduce((s:number,m:any)=>s+Number(m.calls||0),0)
      const totalMeetings=visibleMembers.reduce((s:number,m:any)=>s+Number(m.meetings||0),0)
      return {group:{...group,idx},members:visibleMembers,totalCustomers,totalCalls,totalMeetings}
    }).filter(Boolean) as {group:any;members:any[];totalCustomers:number;totalCalls:number;totalMeetings:number}[]

    return {topPerson:top,groupedData:gData}
  },[groups,allTeamRows,selectedUid,isAuthAdminCEO,authUser])

  const q=searchQuery.trim().toLowerCase()
  const hi=(name:string)=>!!q&&String(name||'').toLowerCase().includes(q)
  const topCalls=Number(topPerson?.calls||0)
  const topMeetings=Number(topPerson?.meetings||0)
  const topCustomers=Number(topPerson?.own_customers??topPerson?.customers??0)
  const toggleGroup=(key:string)=>setCollapsedGroups(prev=>{const n=new Set(prev);n.has(key)?n.delete(key):n.add(key);return n})
  const openDetail=(p:any)=>setDetailPerson(p)

  const MiniMetric=({label,value}:{label:string;value:number|string})=>(
    <span className="text-[10px] text-slate-500"><span className="font-bold text-slate-700">{value}</span> {label}</span>
  )

  const SimplePersonCard=({person,groupName,isRoot=false,isHead=false,color='#60a5fa'}:{person:any;groupName?:string;isRoot?:boolean;isHead?:boolean;color?:string})=>{
    const customers=Number(person?.own_customers??person?.customers??0)
    return (
      <div className={`relative w-[260px] min-h-[70px] rounded-md border border-slate-200 bg-white px-3 py-2 shadow-[0_6px_18px_rgba(15,23,42,0.06)] hover:shadow-[0_10px_24px_rgba(15,23,42,0.10)] transition-all cursor-pointer ${isHead?'border-indigo-300 bg-indigo-50/30':''} ${hi(person?.user_name)?'ring-2 ring-yellow-400 ring-offset-2':''}`}
        style={{borderColor:isRoot?'#dbeafe':isHead?'#a5b4fc':'#e2e8f0'}} onClick={()=>openDetail(person)}>
        <div className="flex items-start gap-3">
          <div className="relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-xs font-black text-white shadow-sm"
            style={{background:isRoot?'linear-gradient(135deg,#4f46e5,#2563eb)':isHead?'linear-gradient(135deg,#6366f1,#7c3aed)':color}}>
            {(person?.user_name||'?').charAt(0).toUpperCase()}
            {(isRoot||isVPRole(person?.role))&&<Crown size={9} className="absolute -right-0.5 -top-0.5 text-yellow-300"/>}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <p className="truncate text-[12px] font-black text-slate-900">{person?.user_name}</p>
              {person?.is_self&&<span className="rounded bg-blue-100 px-1.5 py-0.5 text-[9px] font-black text-blue-700">YOU</span>}
              {isHead&&<span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[9px] font-black text-indigo-700">HEAD</span>}
            </div>
            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
              <RoleBadge role={person?.role||'sales'}/>
              {groupName&&<span className="text-[10px] text-slate-400 truncate">· {groupName}</span>}
            </div>
            {!isAdminRole(person?.role)&&(
              <>
                <button type="button" onClick={e=>{e.stopPropagation();onCustomerPanel(person.user_id,person.user_name,true)}}
                  className="mt-1 block text-[14px] font-black leading-none text-emerald-600 hover:underline">
                  {customers} {customerLabelLower}
                </button>
                <p className="mt-0.5 text-[10px] text-slate-400">{Number(person?.calls||0)} calls · {Number(person?.meetings||0)} mtg</p>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  const GroupSummaryCard=({gd,idx}:{gd:any;idx:number})=>{
    const palette=groupPalette[idx%groupPalette.length]
    const gKey=`group-${gd.group.id}`
    const collapsed=collapsedGroups.has(gKey)
    return (
      <div className={`relative w-[260px] min-h-[70px] rounded-md border border-slate-200 bg-white px-3 py-2 shadow-[0_6px_18px_rgba(15,23,42,0.06)] hover:shadow-[0_10px_24px_rgba(15,23,42,0.10)] transition-all ${hi(gd.group.name)?'ring-2 ring-yellow-400 ring-offset-2':''}`}
        style={{borderColor:'#e2e8f0'}}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-7 w-7 rounded-md flex items-center justify-center" style={{background:palette.soft,color:palette.text}}>
              <GitBranch size={13}/>
            </div>
            <div className="min-w-0">
              <p className="truncate text-[12px] font-black text-slate-900">{gd.group.name}</p>
              {gd.group.manager?.user_name
                ? <p className="text-[10px] font-semibold text-indigo-600 truncate">Head: {gd.group.manager.user_name}</p>
                : <p className="text-[10px] font-semibold text-slate-400">User Group</p>
              }
            </div>
          </div>
          {gd.members.length>0&&(
            <button type="button" onClick={()=>toggleGroup(gKey)}
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-blue-200 bg-white text-blue-500 hover:border-blue-400">
              {collapsed?<Plus size={10}/>:<Minus size={10}/>}
            </button>
          )}
        </div>
        <button type="button" onClick={()=>gd.members[0]&&onCustomerPanel(gd.members[0].user_id,gd.group.name,false)}
          className="block text-left text-[14px] font-black leading-none text-emerald-600 hover:underline">
          {gd.totalCustomers} {customerLabelLower}
        </button>
        <div className="mt-1 flex items-center gap-2">
          <MiniMetric label="calls" value={gd.totalCalls}/>
          <span className="text-slate-300">·</span>
          <MiniMetric label="mtg" value={gd.totalMeetings}/>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {detailPerson&&(
        <SlidePanel open={true} onClose={()=>setDetailPerson(null)}
          title={detailPerson.user_name}
          subtitle={<span className="flex items-center gap-1.5 text-xs mt-0.5"><RoleBadge role={detailPerson.role}/></span>}
          width="w-80" insetLeft="var(--sidebar-w,220px)">
          <div className="p-4 space-y-3">
            <div className="flex flex-col items-center gap-2 py-5 rounded-xl" style={{background:'linear-gradient(135deg,#4f46e5,#2563eb)'}}>
              <div className="w-16 h-16 rounded-full border-2 border-white/50 bg-white/20 flex items-center justify-center text-white font-black text-2xl shadow-md">
                {(detailPerson.user_name||'?').charAt(0).toUpperCase()}
              </div>
              <div className="text-center">
                <p className="text-white font-black text-sm">{detailPerson.user_name}</p>
                {detailPerson.is_self&&<span className="text-[9px] bg-white/25 text-white px-2 py-0.5 rounded font-bold">YOU</span>}
                <p className="text-indigo-200 text-[11px] capitalize mt-0.5">{detailPerson.role}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {([
                {l:'Calls',v:Number(detailPerson.calls||0),bg:'bg-blue-50',t:'text-blue-700'},
                {l:'Meetings',v:Number(detailPerson.meetings||0),bg:'bg-violet-50',t:'text-violet-700'},
                {l:'Completed',v:Number(detailPerson.completed||0),bg:'bg-emerald-50',t:'text-emerald-700'},
                {l:'Total Acts',v:Number(detailPerson.total||0),bg:'bg-slate-50',t:'text-slate-600'},
              ]).map(({l,v,bg,t})=>(
                <div key={l} className={`${bg} rounded-xl p-3`}>
                  <p className={`text-[10px] font-semibold ${t} opacity-70`}>{l}</p>
                  <p className={`text-2xl font-black ${t}`}>{v}</p>
                </div>
              ))}
            </div>
            <button type="button" onClick={()=>{onCustomerPanel(detailPerson.user_id,detailPerson.user_name,true);setDetailPerson(null)}}
              className="w-full flex items-center justify-between bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-xl px-4 py-3 transition-colors">
              <div className="text-left"><p className="text-xs font-semibold text-emerald-700">{customerLabel}</p><p className="text-2xl font-black text-emerald-800">{Number(detailPerson.own_customers||detailPerson.customers||0)}</p></div>
              <ChevronRight size={16} className="text-emerald-500"/>
            </button>
          </div>
        </SlidePanel>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2"><GitBranch size={18} className="text-indigo-600"/><h3 className="text-xl font-black text-slate-900">Organization Chart</h3><span className="text-xs text-slate-400 font-normal">group wise team structure</span></div>
        <div className="relative">
          <input type="text" value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="Search member…"
            className="pl-8 pr-8 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 bg-white w-44 shadow-sm"/>
          <Users size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"/>
          {searchQuery&&<button type="button" onClick={()=>setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={11}/></button>}
        </div>
      </div>

      {!topPerson?(
        <div className="rounded-2xl border border-slate-200 bg-white py-12 text-center text-sm text-slate-400 shadow-sm">No group tree data available</div>
      ):(
        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <button type="button" onClick={()=>setShowTree(v=>!v)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-slate-50 transition-colors">
            <div>
              <h4 className="text-sm font-black text-slate-900">Visualize and manage your team structure</h4>
              <p className="text-xs text-slate-400 mt-0.5">Every group is shown as one branch. Members inside the same group stay at the same level.</p>
            </div>
            <div className="flex flex-shrink-0 items-center gap-1.5 text-[11px] font-bold text-slate-400"><span>{showTree?'Hide':'Show'} Chart</span>{showTree?<ChevronUp size={14}/>:<ChevronDown size={14}/>}</div>
          </button>

          {showTree&&(
            <div className="border-t border-slate-100 overflow-auto px-6 py-5" style={{background:'linear-gradient(180deg,#fbfdff 0%,#ffffff 100%)'}}>
              <div className="flex min-w-full justify-center">
              <div className="inline-flex items-center min-w-max py-2">
                <div className="flex items-center">
                  <SimplePersonCard person={topPerson} isRoot={true}/>
                </div>

                {groupedData.length>0&&(
                  <>
                    <div className="relative h-0 w-12 flex-shrink-0">
                      <div className="absolute left-0 right-0 top-1/2 h-[2px] -translate-y-1/2 bg-blue-300"/>
                    </div>
                    <div className="relative ml-7 flex flex-col gap-4">
                      {groupedData.length>1&&(<div className="absolute -left-7 top-[37px] bottom-[37px] w-[2px] bg-blue-300"/>)}
                      {groupedData.map((gd:any,idx:number)=>{
                        const palette=groupPalette[idx%groupPalette.length]
                        const gKey=`group-${gd.group.id}`
                        const collapsed=collapsedGroups.has(gKey)
                        const members=gd.members.filter((m:any)=>!q||String(m.user_name||'').toLowerCase().includes(q)||String(gd.group.name||'').toLowerCase().includes(q))
                        return (
                          <div key={gKey} className="relative flex items-center min-h-[74px]">
                            <div className="absolute -left-7 top-1/2 h-[2px] w-7 -translate-y-1/2 bg-blue-300"/>
                            <div className="absolute -left-[33px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border-2 border-blue-400 bg-white"/>
                            <GroupSummaryCard gd={gd} idx={idx}/>
                            {!collapsed&&members.length>0&&(
                              <>
                                <div className="relative h-[2px] w-7 flex-shrink-0 bg-blue-200">
                                  <span className="absolute -right-[5px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border-2 border-blue-300 bg-white"/>
                                </div>
                                <div className="relative flex flex-col gap-3 pl-7">
                                  {members.length>1&&(<div className="absolute left-0 top-[33px] bottom-[33px] w-[2px] bg-blue-200"/>)}
                                  {members.map((member:any,mi:number)=>{
                                    const isHeadMember=!!gd.group.manager&&Number(member.user_id)===Number(gd.group.manager?.user_id)
                                    return (
                                    <div key={`${gd.group.id}-${member.user_id}`} className="relative">
                                      <div className="absolute -left-7 top-1/2 h-[2px] w-7 -translate-y-1/2 bg-blue-200"/>
                                      <div className="absolute -left-[31px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full border-2 border-blue-300 bg-white"/>
                                      <SimplePersonCard person={member} groupName={gd.group.name} isHead={isHeadMember} color={palette.line}/>
                                    </div>
                                    )
                                  })}
                                </div>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

