import { Fragment, useState } from 'react'
import {
  Activity, CheckCircle, XCircle,
  RefreshCw, PhoneCall, Video, Handshake, Monitor, Navigation, Mail,
  FileText, Repeat2, ListChecks,
  Layers, Circle, PauseCircle,
} from 'lucide-react' 

// ─── Constants ────────────────────────────────────────────────────────────────
export const ACTIVITY_TYPES = ['Phone Call','Video Call','In Person Meet','Demo','Site Visit','Follow Up','Email']
export const STATUSES       = ['Planned','In Progress','Completed','Cancelled','Postponed']
export const TRAVEL_MODES   = ['Own Vehicle','Company Vehicle','Train','Bus','Auto/Cab']

export const FOLLOWUP_CATEGORIES: Record<string,string[]> = {
  'Technical':    ['Product Demo','PoC Support','Spec Clarification','Installation Support'],
  'Commercial':   ['Price Negotiation','Payment Follow-up','Order Confirmation','Quotation Review'],
  'Tender':       ['Tender Submission','Bid Clarification','Rate Revision','L1 Negotiation'],
  'Support':      ['AMC Renewal','Complaint Resolution','Escalation','SLA Review'],
  'Relationship': ['Executive Visit','Review Meeting','Reference Request','Event Invite'],
}
export const CANCELLATION_REASONS = [
  'Customer unavailable','Customer rescheduled','Internal priority change',
  'Travel issue','Technical issue','Customer cancelled','Weather / force majeure','Other',
]

export const TYPE_ICON: Record<string,React.ReactNode> = {
  'Phone Call':<PhoneCall size={13}/>,'Video Call':<Video size={13}/>,'In Person Meet':<Handshake size={13}/>,
  'Demo':<Monitor size={13}/>,'Site Visit':<Navigation size={13}/>,'Follow Up':<Repeat2 size={13}/>,'Email':<Mail size={13}/>,
  'Daily Call':<PhoneCall size={13}/>,'Meeting':<Handshake size={13}/>,'Follow-up':<Repeat2 size={13}/>,
  'Presentation':<Layers size={13}/>,'Proposal':<FileText size={13}/>,'Task':<ListChecks size={13}/>,
}
export const TYPE_COLOR: Record<string,{bg:string;text:string;dot:string}> = {
  'Phone Call':{bg:'bg-blue-50',text:'text-blue-600',dot:'bg-blue-500'},
  'Video Call':{bg:'bg-cyan-50',text:'text-cyan-600',dot:'bg-cyan-500'},
  'In Person Meet':{bg:'bg-violet-50',text:'text-violet-600',dot:'bg-violet-500'},
  'Demo':{bg:'bg-emerald-50',text:'text-emerald-600',dot:'bg-emerald-500'},
  'Site Visit':{bg:'bg-orange-50',text:'text-orange-600',dot:'bg-orange-500'},
  'Follow Up':{bg:'bg-amber-50',text:'text-amber-600',dot:'bg-amber-500'},
  'Email':{bg:'bg-gray-50',text:'text-gray-500',dot:'bg-gray-400'},
  'Daily Call':{bg:'bg-blue-50',text:'text-blue-600',dot:'bg-blue-500'},
  'Meeting':{bg:'bg-violet-50',text:'text-violet-600',dot:'bg-violet-500'},
  'Follow-up':{bg:'bg-amber-50',text:'text-amber-600',dot:'bg-amber-500'},
  'Presentation':{bg:'bg-pink-50',text:'text-pink-600',dot:'bg-pink-500'},
  'Proposal':{bg:'bg-indigo-50',text:'text-indigo-600',dot:'bg-indigo-500'},
  'Task':{bg:'bg-red-50',text:'text-red-600',dot:'bg-red-500'},
}
export const STATUS_CFG: Record<string,{bg:string;text:string;border:string;icon:React.ReactNode}> = {
  'Planned':{bg:'bg-blue-50',text:'text-blue-600',border:'border-blue-200',icon:<Circle size={10}/>},
  'In Progress':{bg:'bg-amber-50',text:'text-amber-600',border:'border-amber-200',icon:<RefreshCw size={10}/>},
  'Completed':{bg:'bg-emerald-50',text:'text-emerald-700',border:'border-emerald-200',icon:<CheckCircle size={10}/>},
  'Cancelled':{bg:'bg-red-50',text:'text-red-500',border:'border-red-200',icon:<XCircle size={10}/>},
  'Postponed':{bg:'bg-gray-100',text:'text-gray-500',border:'border-gray-200',icon:<PauseCircle size={10}/>},
}
export const ROLE_CFG: Record<string,{label:string;color:string}> = {
  admin:{label:'Admin',color:'text-violet-700 bg-violet-50'},
  ceo:{label:'CEO',color:'text-sky-700 bg-sky-50'},
  vp:{label:'VP',color:'text-indigo-700 bg-indigo-50'},
  manager:{label:'Manager',color:'text-purple-700 bg-purple-50'},
  sales:{label:'Sales',color:'text-emerald-700 bg-emerald-50'},
  support:{label:'Support',color:'text-pink-700 bg-pink-50'},
  accounts:{label:'Accounts',color:'text-amber-700 bg-amber-50'},
}

export const fmt = (n:number) => n>=10000000?`₹${(n/10000000).toFixed(1)}Cr`:n>=100000?`₹${(n/100000).toFixed(1)}L`:n>=1000?`₹${(n/1000).toFixed(0)}K`:`₹${n.toLocaleString('en-IN')}`
export const pct = (v:number,t:number) => t>0?Math.min(100,Math.round(v/t*100)):0
export const KAM_GROUP_GRADIENTS = [
  'from-blue-600 to-indigo-600',
  'from-violet-600 to-purple-700',
  'from-emerald-600 to-teal-600',
  'from-orange-500 to-orange-600',
  'from-pink-600 to-rose-600',
  'from-cyan-600 to-blue-600',
  'from-slate-600 to-slate-700',
]

export type KAM360RangeMode = 'week'|'month'|'year'|'range'
export const isoDate = (d:Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
export const monthEndIso = (period:string) => {
  const [y,m] = period.split('-').map(Number)
  return `${period}-${String(new Date(y,m,0).getDate()).padStart(2,'0')}`
}
export const weekEndIso = (start:string) => {
  const d = new Date(`${start}T00:00:00`)
  d.setDate(d.getDate()+6)
  return isoDate(d)
}
export const currentWeekStartIso = () => {
  const d = new Date()
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  return isoDate(d)
}
export const compactDateLabel = (iso:string) => {
  if(!iso) return ''
  const [y,m,d] = iso.split('-')
  return y && m && d ? `${d}-${m}-${y.slice(-2)}` : iso
}
export const compactRangeLabel = (from:string, to:string) => from && to ? `${compactDateLabel(from)} to ${compactDateLabel(to)}` : 'Select range'

export const roleKey = (role?: string) => String(role||'').toLowerCase().trim().replace(/&/g,'and').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')
export const NON_KAM_ROLE_KEYS = new Set([
  'ceo','admin','super_admin','accounts','account','accountant','finance',
  'purchase','purchases','procurement',
  'call_coordinator','call_co_ordinator','call_center','telecaller','tele_calling',
  'tender','tenders','tender_team','tendering','tender_executive','tender_manager',
  'support','service','project_lead',
])
export const isSalesKAMUser = (role?: string) => !NON_KAM_ROLE_KEYS.has(roleKey(role))
export const roleLabel = (role?: string) => ({
  manager:'Sales Head', sales_head:'Sales Head', vp:'VP',
  sales:'Sales', gm_sales:'GM Sales', admin:'Admin', ceo:'CEO', support:'Support', accounts:'Accounts',
} as Record<string,string>)[roleKey(role)] || String(role || 'User')

export const taskTypeName = (activity:any) => {
  const raw = String(activity?.task_type_name || activity?.activity_type || 'Task')
  const mode = String(activity?.mode || '')
  if(raw === 'Daily Call') return mode === 'Video Call' ? 'Video Call' : 'Phone Call'
  if(raw === 'Meeting') return 'In Person Meet'
  if(raw === 'Follow-up') return 'Follow Up'
  if(raw === 'Phone') return 'Phone Call'
  if(raw === 'In-Person') return 'In Person Meet'
  return raw
}
export const isTravelActivityType = (activity:any) => ['In Person Meet','Meeting','Site Visit','Demo'].includes(taskTypeName(typeof activity === 'string' ? {activity_type:activity} : activity))
export const modeForActivityType = (type:string) => ({
  'Phone Call':'Phone', 'Daily Call':'Phone', 'Video Call':'Video Call',
  'In Person Meet':'In-Person', 'Meeting':'In-Person', 'Site Visit':'In-Person',
  'Demo':'In-Person', 'Email':'Email',
}[type] || 'Phone')

// ─── Micro components ─────────────────────────────────────────────────────────
export function TypeBox({type,size='md'}:{type:string;size?:'sm'|'md'}) {
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
export function TaskTypeChip({activity}:{activity:any}) {
  const name=taskTypeName(activity)
  const c=TYPE_COLOR[name]||{bg:'bg-gray-50',text:'text-gray-500',dot:''}
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[11px] font-semibold ${c.bg} ${c.text}`}>
      {TYPE_ICON[name]||<Activity size={11}/>}{name}
    </span>
  )
}
export function StatusChip({status}:{status:string}) {
  const c=STATUS_CFG[status]||{bg:'bg-gray-100',text:'text-gray-500',border:'border-gray-200',icon:<Circle size={10}/>}
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-semibold border ${c.bg} ${c.text} ${c.border}`}>{c.icon}{status}</span>
}
export function RoleBadge({role}:{role:string}) {
  const c=ROLE_CFG[role]||{label:role,color:'text-gray-600 bg-gray-100'}
  return <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded font-semibold ${c.color}`}>{c.label}</span>
}
export function ProgressBar({label,value,target,color='blue'}:{label:string;value:number;target:number;color?:string}) {
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

// ─── RingProgress (used by both ActivitySection and NormalSection) ─────────────
export function RingProgress({pct,size=48,stroke=4,color='#3b82f6',label,sublabel}:{pct:number;size?:number;stroke?:number;color?:string;label?:string;sublabel?:string}) {
  const r=(size-stroke*2)/2
  const circ=2*Math.PI*r
  const filled=Math.min(pct,100)/100*circ
  return (
    <div className="relative flex-shrink-0" style={{width:size,height:size}}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#f1f5f9" strokeWidth={stroke}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={`${filled} ${circ}`} strokeLinecap="round" className="transition-all duration-700"/>
      </svg>
      {label&&(
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] font-bold text-gray-700 leading-none">{label}</span>
          {sublabel&&<span className="text-[8px] text-gray-400 mt-0.5">{sublabel}</span>}
        </div>
      )}
    </div>
  )
}

// Re-export Fragment and useState for consumers that may import from shared
export { Fragment, useState }
