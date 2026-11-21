// import { useState, useEffect } from 'react'
// import {
//   Brain, Building2, Package, Cpu, Globe, Award, TrendingDown, AlertCircle, Lock, Users, Truck,
// } from 'lucide-react'
// import api from '@/services/api'
// import Card from '@/components/ui/Card'
// import { PageHeader } from '@/components/ui/FormComponents'
// import { fmtCur, fmtNum, fmtPct } from '@/utils/formatters'   // adjust if your formatters live elsewhere

// // ─── If formatters aren't shared yet, inline them here ────────────────────────
// const _fmtCur = (v: unknown): string => {
//   const n = Number(v)
//   if (v == null || v === '' || isNaN(n)) return '—'
//   if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`
//   if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`
//   return `₹${n.toLocaleString('en-IN')}`
// }
// const _fmtPct = (v: unknown) => { const n = Number(v); return isNaN(n) ? '—' : `${n.toFixed(1)}%` }
// const _fmtNum = (v: unknown) => { const n = Number(v); return isNaN(n) ? '—' : n.toLocaleString('en-IN') }

// // ─── Types ─────────────────────────────────────────────────────────────────────
// interface InsightsData {
//   pipeline_health: Record<string, number>
//   top_customers_by_value: Record<string, unknown>[]
//   top_oems_supply_chain: Record<string, unknown>[]
//   customer_product_matrix: Record<string, unknown>[]
//   portal_win_analysis: Record<string, unknown>[]
//   top_staff_by_wins: Record<string, unknown>[]
//   customers_with_unconverted_leads: Record<string, unknown>[]
//   customers_no_leads_4_months: Record<string, unknown>[]
//   products_not_used: Record<string, unknown>[]
//   customers_not_contacted: Record<string, unknown>[]
//   delivery_health_summary: Record<string, number>
//   delivery_timeliness: Record<string, unknown>[]
// }

// type TabKey = 'customers' | 'oems' | 'matrix' | 'portals' | 'delivery' | 'staff' | 'unconverted' | 'inactive' | 'unused' | 'untapped'

// // ─── InsightsPanel (extracted from ReportsPage, unchanged) ─────────────────────
// function InsightsPanel({ data }: { data: InsightsData }) {
//   const [tab, setTab] = useState<TabKey>('customers')
//   const h = data.pipeline_health
//   const dh = data.delivery_health_summary || {}

//   const tabs = [
//     { key: 'customers', label: 'Top Customers',     icon: <Building2 size={13}/> },
//     { key: 'oems',      label: 'OEM Supply Chain',  icon: <Package size={13}/> },
//     { key: 'matrix',    label: 'Cust × Product',    icon: <Cpu size={13}/> },
//     { key: 'portals',   label: 'Portal Analysis',   icon: <Globe size={13}/> },
//     { key: 'delivery',  label: 'Delivery Timing',   icon: <Truck size={13}/> },
//     { key: 'unconverted', label: 'Unconverted Leads', icon: <TrendingDown size={13}/> },
//     { key: 'inactive',  label: 'Inactive 4M+',      icon: <AlertCircle size={13}/> },
//     { key: 'unused',    label: 'Unused Products',   icon: <Lock size={13}/> },
//     { key: 'untapped',  label: 'Not Contacted',     icon: <Users size={13}/> },
//     { key: 'staff',     label: 'Staff Performance', icon: <Award size={13}/> },
//   ] as const

//   return (
//     <div className="space-y-4">
//       {/* KPI strip */}
//       <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
//         {[
//           { label: 'Total Leads',      value: _fmtNum(h.total_leads) },
//           { label: 'Leads Converted',  value: _fmtNum(h.leads_converted) },
//           { label: 'Lead Conv. Rate',  value: _fmtPct(h.lead_conversion_rate) },
//           { label: 'Total Tenders',    value: _fmtNum(h.total_tenders) },
//           { label: 'Tenders Won',      value: _fmtNum(h.tenders_won) },
//           { label: 'Tender Win Rate',  value: _fmtPct(h.tender_win_rate) },
//         ].map(s => (
//           <div key={s.label} className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-3 border border-blue-100">
//             <p className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">{s.label}</p>
//             <p className="text-lg font-bold text-blue-900 mt-0.5">{s.value}</p>
//           </div>
//         ))}
//       </div>

//       {/* Tab bar */}
//       <div className="flex items-center gap-1 overflow-x-auto pb-1">
//         {tabs.map(t => (
//           <button key={t.key} onClick={() => setTab(t.key as TabKey)}
//             className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all
//               ${tab === t.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
//             {t.icon} {t.label}
//           </button>
//         ))}
//       </div>

//       {/* ── Top Customers ─────────────────────────────────────────────────── */}
//       {tab === 'customers' && (
//         <div className="overflow-x-auto">
//           <table className="w-full text-xs">
//             <thead>
//               <tr className="border-b border-gray-100">
//                 {['Customer','Tenders','Won','Lost','Win Rate','Total Bid Value','Products','OEMs'].map(h => (
//                   <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
//                 ))}
//               </tr>
//             </thead>
//             <tbody>
//               {data.top_customers_by_value.map((r: any, i) => (
//                 <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
//                   <td className="py-2 px-2 font-semibold text-gray-800">{r.customer}</td>
//                   <td className="py-2 px-2 text-center font-medium">{r.tender_count}</td>
//                   <td className="py-2 px-2 text-center text-emerald-600 font-semibold">{r.won}</td>
//                   <td className="py-2 px-2 text-center text-red-500 font-semibold">{r.lost}</td>
//                   <td className="py-2 px-2 text-center">
//                     <span className={`font-bold ${Number(r.win_rate) >= 50 ? 'text-emerald-600' : 'text-amber-600'}`}>
//                       {r.win_rate}%
//                     </span>
//                   </td>
//                   <td className="py-2 px-2 text-right font-semibold text-blue-700">{_fmtCur(r.total_bid_value)}</td>
//                   <td className="py-2 px-2 text-gray-500 max-w-[180px] truncate" title={r.products}>{r.products || '—'}</td>
//                   <td className="py-2 px-2 text-gray-500 max-w-[160px] truncate" title={r.oems}>{r.oems || '—'}</td>
//                 </tr>
//               ))}
//             </tbody>
//           </table>
//         </div>
//       )}

//       {/* ── OEM Supply Chain ──────────────────────────────────────────────── */}
//       {tab === 'oems' && (
//         <div className="overflow-x-auto">
//           <table className="w-full text-xs">
//             <thead>
//               <tr className="border-b border-gray-100">
//                 {['OEM Name','Tender Count','Won Count','Win Rate','Products Supplied','Customers Served'].map(h => (
//                   <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
//                 ))}
//               </tr>
//             </thead>
//             <tbody>
//               {data.top_oems_supply_chain.map((r: any, i) => (
//                 <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
//                   <td className="py-2 px-2 font-semibold text-gray-800">{r.oem_name}</td>
//                   <td className="py-2 px-2 text-center font-medium">{r.tender_count}</td>
//                   <td className="py-2 px-2 text-center text-emerald-600 font-semibold">{r.won_count}</td>
//                   <td className="py-2 px-2 text-center">
//                     <span className={`font-bold ${Number(r.win_rate) >= 50 ? 'text-emerald-600' : 'text-amber-600'}`}>
//                       {r.win_rate}%
//                     </span>
//                   </td>
//                   <td className="py-2 px-2 text-gray-500 max-w-[200px] truncate" title={r.products_supplied}>{r.products_supplied || '—'}</td>
//                   <td className="py-2 px-2 text-gray-500 max-w-[180px] truncate" title={r.customers_served}>{r.customers_served || '—'}</td>
//                 </tr>
//               ))}
//             </tbody>
//           </table>
//         </div>
//       )}

//       {/* ── Customer × Product Matrix ──────────────────────────────────────── */}
//       {tab === 'matrix' && (
//         <div className="overflow-x-auto">
//           <table className="w-full text-xs">
//             <thead>
//               <tr className="border-b border-gray-100">
//                 {['Customer','Top Products','Unique Products','Total Occurrences'].map(h => (
//                   <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
//                 ))}
//               </tr>
//             </thead>
//             <tbody>
//               {data.customer_product_matrix.map((r: any, i) => (
//                 <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
//                   <td className="py-2 px-2 font-semibold text-gray-800 whitespace-nowrap">{r.customer}</td>
//                   <td className="py-2 px-2 text-gray-600 max-w-[280px]" title={r.top_products}>
//                     <div className="flex flex-wrap gap-1">
//                       {String(r.top_products || '').split(', ').filter(Boolean).map((p: string) => (
//                         <span key={p} className="inline-flex items-center px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-medium">{p}</span>
//                       ))}
//                     </div>
//                   </td>
//                   <td className="py-2 px-2 text-center font-medium text-purple-700">{r.product_count}</td>
//                   <td className="py-2 px-2 text-center font-medium">{r.total_occurrences}</td>
//                 </tr>
//               ))}
//             </tbody>
//           </table>
//         </div>
//       )}

//       {/* ── Portal Analysis ───────────────────────────────────────────────── */}
//       {tab === 'portals' && (
//         <div className="overflow-x-auto">
//           <table className="w-full text-xs">
//             <thead>
//               <tr className="border-b border-gray-100">
//                 {['Portal','Total Tenders','Won','Lost','Win Rate','Total Value'].map(h => (
//                   <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
//                 ))}
//               </tr>
//             </thead>
//             <tbody>
//               {data.portal_win_analysis.map((r: any, i) => (
//                 <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
//                   <td className="py-2 px-2">
//                     <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-indigo-50 text-indigo-700">
//                       {r.portal}
//                     </span>
//                   </td>
//                   <td className="py-2 px-2 text-center font-medium">{r.total}</td>
//                   <td className="py-2 px-2 text-center text-emerald-600 font-semibold">{r.won}</td>
//                   <td className="py-2 px-2 text-center text-red-500 font-semibold">{r.lost}</td>
//                   <td className="py-2 px-2 text-center">
//                     <span className={`font-bold ${Number(r.win_rate) >= 50 ? 'text-emerald-600' : 'text-amber-600'}`}>
//                       {r.win_rate}%
//                     </span>
//                   </td>
//                   <td className="py-2 px-2 text-right font-semibold text-blue-700">{_fmtCur(r.total_value)}</td>
//                 </tr>
//               ))}
//             </tbody>
//           </table>
//         </div>
//       )}

//       {/* ── Unconverted Leads ──────────────────────────────────────────────── */}
//       {tab === 'delivery' && (
//         <div className="space-y-4">
//           <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
//             {[
//               { label: 'Scheduled WOs', value: _fmtNum(dh.scheduled_orders), tone: 'text-slate-900 bg-slate-50 border-slate-200' },
//               { label: 'On Time', value: _fmtNum(dh.on_time_completed), tone: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
//               { label: 'Delivered Late', value: _fmtNum(dh.delivered_late), tone: 'text-amber-700 bg-amber-50 border-amber-200' },
//               { label: 'Delayed Now', value: _fmtNum(dh.currently_delayed), tone: 'text-red-700 bg-red-50 border-red-200' },
//               { label: 'Pending', value: _fmtNum(dh.pending_delivery), tone: 'text-blue-700 bg-blue-50 border-blue-200' },
//             ].map(card => (
//               <div key={card.label} className={`rounded-xl border px-3 py-3 ${card.tone}`}>
//                 <p className="text-[10px] font-bold uppercase tracking-wider opacity-70">{card.label}</p>
//                 <p className="mt-1 text-xl font-bold">{card.value}</p>
//               </div>
//             ))}
//           </div>

//           <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600">
//             Delivery timing uses planned work-order delivery date, current status, and completion date when it is available.
//           </div>

//           <div className="overflow-x-auto">
//             {data.delivery_timeliness && data.delivery_timeliness.length > 0 ? (
//               <table className="w-full text-xs">
//                 <thead>
//                   <tr className="border-b border-gray-100">
//                     {['WO Number','Customer','Products','Planned Date','Actual Date','Delivery Health','WO Status','Note'].map(h => (
//                       <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
//                     ))}
//                   </tr>
//                 </thead>
//                 <tbody>
//                   {data.delivery_timeliness.map((r: any, i) => (
//                     <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
//                       <td className="py-2 px-2 font-semibold text-gray-800 whitespace-nowrap">{r.wo_number || 'â€”'}</td>
//                       <td className="py-2 px-2 font-medium text-gray-700 whitespace-nowrap">{r.customer_name || 'â€”'}</td>
//                       <td className="py-2 px-2 text-gray-500 max-w-[220px] truncate" title={r.products}>{r.products || 'â€”'}</td>
//                       <td className="py-2 px-2 text-gray-600 whitespace-nowrap">{r.planned_delivery_date || 'â€”'}</td>
//                       <td className="py-2 px-2 text-gray-600 whitespace-nowrap">{r.actual_completion_date || 'â€”'}</td>
//                       <td className="py-2 px-2">
//                         <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${
//                           r.delivery_health === 'On Time'
//                             ? 'bg-emerald-50 text-emerald-700'
//                             : r.delivery_health === 'Delivered Late'
//                               ? 'bg-amber-50 text-amber-700'
//                               : r.delivery_health === 'Currently Delayed'
//                                 ? 'bg-red-50 text-red-700'
//                                 : r.delivery_health === 'Pending'
//                                   ? 'bg-blue-50 text-blue-700'
//                                   : 'bg-slate-100 text-slate-700'
//                         }`}>
//                           {r.delivery_health}
//                         </span>
//                       </td>
//                       <td className="py-2 px-2 text-gray-600 whitespace-nowrap">{r.work_order_status || 'â€”'}</td>
//                       <td className="py-2 px-2 text-gray-500 max-w-[220px] truncate" title={r.delivery_note}>{r.delivery_note || 'â€”'}</td>
//                     </tr>
//                   ))}
//                 </tbody>
//               </table>
//             ) : (
//               <div className="flex items-center justify-center py-12 text-center">
//                 <p className="text-sm text-gray-500">No delivery timing data available yet.</p>
//               </div>
//             )}
//           </div>
//         </div>
//       )}

//       {tab === 'unconverted' && (
//         <div className="overflow-x-auto">
//           {data.customers_with_unconverted_leads && data.customers_with_unconverted_leads.length > 0 ? (
//             <table className="w-full text-xs">
//               <thead>
//                 <tr className="border-b border-gray-100">
//                   {['Customer','Unconverted Leads','Lead Titles','Products'].map(h => (
//                     <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
//                   ))}
//                 </tr>
//               </thead>
//               <tbody>
//                 {data.customers_with_unconverted_leads.map((r: any, i) => (
//                   <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
//                     <td className="py-2 px-2 font-semibold text-gray-800">{r.customer}</td>
//                     <td className="py-2 px-2 text-center font-medium text-amber-600">{r.unconverted_lead_count}</td>
//                     <td className="py-2 px-2 text-gray-600 max-w-[300px] truncate" title={r.lead_titles}>{r.lead_titles || '—'}</td>
//                     <td className="py-2 px-2 text-gray-500 max-w-[200px] truncate" title={r.products}>{r.products || '—'}</td>
//                   </tr>
//                 ))}
//               </tbody>
//             </table>
//           ) : (
//             <div className="flex items-center justify-center py-12 text-center">
//               <p className="text-sm text-gray-500">No unconverted leads data available. Please restart the backend service.</p>
//             </div>
//           )}
//         </div>
//       )}

//       {/* ── Inactive Customers (No Leads in 4+ Months) ──────────────────────── */}
//       {tab === 'inactive' && (
//         <div className="overflow-x-auto">
//           {data.customers_no_leads_4_months && data.customers_no_leads_4_months.length > 0 ? (
//             <table className="w-full text-xs">
//               <thead>
//                 <tr className="border-b border-gray-100">
//                   {['Customer','Total Tenders','Last Activity'].map(h => (
//                     <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
//                   ))}
//                 </tr>
//               </thead>
//               <tbody>
//                 {data.customers_no_leads_4_months.map((r: any, i) => (
//                   <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
//                     <td className="py-2 px-2 font-semibold text-gray-800">{r.customer}</td>
//                     <td className="py-2 px-2 text-center font-medium text-gray-600">{r.total_tenders}</td>
//                     <td className="py-2 px-2 text-center text-red-600 font-semibold">{r.last_activity}</td>
//                   </tr>
//                 ))}
//               </tbody>
//             </table>
//           ) : (
//             <div className="flex items-center justify-center py-12 text-center">
//               <p className="text-sm text-gray-500">No inactive customers data available. Please restart the backend service.</p>
//             </div>
//           )}
//         </div>
//       )}

//       {/* ── Unused Products ────────────────────────────────────────────────── */}
//       {tab === 'unused' && (
//         <div className="overflow-x-auto">
//           {data.products_not_used && data.products_not_used.length > 0 ? (
//             <table className="w-full text-xs">
//               <thead>
//                 <tr className="border-b border-gray-100">
//                   {['Product Name','Category','Description'].map(h => (
//                     <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
//                   ))}
//                 </tr>
//               </thead>
//               <tbody>
//                 {data.products_not_used.map((r: any, i) => (
//                   <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
//                     <td className="py-2 px-2 font-semibold text-gray-800">{r.product_name}</td>
//                     <td className="py-2 px-2 text-center text-gray-600">
//                       <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-700">
//                         {r.category}
//                       </span>
//                     </td>
//                     <td className="py-2 px-2 text-gray-500 max-w-[400px] truncate" title={r.description}>{r.description || '—'}</td>
//                   </tr>
//                 ))}
//               </tbody>
//             </table>
//           ) : (
//             <div className="flex items-center justify-center py-12 text-center">
//               <p className="text-sm text-gray-500">No unused products data available. Please restart the backend service.</p>
//             </div>
//           )}
//         </div>
//       )}

//       {/* ── Untapped Customers (Not Contacted) ─────────────────────────────── */}
//       {tab === 'untapped' && (
//         <div className="overflow-x-auto">
//           {data.customers_not_contacted && data.customers_not_contacted.length > 0 ? (
//             <table className="w-full text-xs">
//               <thead>
//                 <tr className="border-b border-gray-100">
//                   {['Customer Name','Total Leads','Total Tenders','Status'].map(h => (
//                     <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
//                   ))}
//                 </tr>
//               </thead>
//               <tbody>
//                 {data.customers_not_contacted.map((r: any, i) => (
//                   <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
//                     <td className="py-2 px-2 font-semibold text-gray-800">{r.customer_name}</td>
//                     <td className="py-2 px-2 text-center font-medium text-gray-600">{r.total_leads}</td>
//                     <td className="py-2 px-2 text-center font-medium text-gray-600">{r.total_tenders}</td>
//                     <td className="py-2 px-2">
//                       <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-blue-50 text-blue-700">
//                         {r.status}
//                       </span>
//                     </td>
//                   </tr>
//                 ))}
//               </tbody>
//             </table>
//           ) : (
//             <div className="flex items-center justify-center py-12 text-center">
//               <p className="text-sm text-gray-500">No untapped customers data available. Please restart the backend service.</p>
//             </div>
//           )}
//         </div>
//       )}

//       {/* ── Staff Performance ─────────────────────────────────────────────── */}
//       {tab === 'staff' && (
//         <div className="overflow-x-auto">
//           <table className="w-full text-xs">
//             <thead>
//               <tr className="border-b border-gray-100">
//                 {['Name','Leads','Tenders','Won','Win Rate','Won Value'].map(h => (
//                   <th key={h} className="text-left py-2 px-2 font-semibold text-gray-500 text-[10px] uppercase tracking-wide">{h}</th>
//                 ))}
//               </tr>
//             </thead>
//             <tbody>
//               {data.top_staff_by_wins.map((r: any, i) => (
//                 <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
//                   <td className="py-2 px-2 font-semibold text-gray-800">{r.name}</td>
//                   <td className="py-2 px-2 text-center font-medium text-blue-600">{r.leads}</td>
//                   <td className="py-2 px-2 text-center font-medium">{r.tenders}</td>
//                   <td className="py-2 px-2 text-center text-emerald-600 font-semibold">{r.won}</td>
//                   <td className="py-2 px-2 text-center">
//                     <span className={`font-bold ${Number(r.win_rate) >= 50 ? 'text-emerald-600' : 'text-amber-600'}`}>
//                       {r.win_rate}%
//                     </span>
//                   </td>
//                   <td className="py-2 px-2 text-right font-semibold text-blue-700">{_fmtCur(r.won_value)}</td>
//                 </tr>
//               ))}
//             </tbody>
//           </table>
//         </div>
//       )}
//     </div>
//   )
// }

// // ─── Page ──────────────────────────────────────────────────────────────────────
// export default function InsightsPage() {
//   const [data,    setData]    = useState<InsightsData | null>(null)
//   const [loading, setLoading] = useState(true)
//   const [error,   setError]   = useState(false)

//   useEffect(() => {
//     api.get('/reports/insights')
//       .then((r: any) => setData(r.data))
//       .catch(() => setError(true))
//       .finally(() => setLoading(false))
//   }, [])

//   return (
//     <div className="p-6">
//       <PageHeader
//         title="AI Insights"
//         subtitle="Cross-module intelligence — customer × product matrix, OEM supply chain, delivery timing and win patterns"
//         breadcrumb={['AI Insights']}
//       />

//       {loading && (
//         <div className="space-y-4 animate-pulse mt-4">
//           <div className="grid grid-cols-6 gap-3">
//             {[...Array(6)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-gray-100"/>)}
//           </div>
//           <div className="h-10 w-96 rounded-lg bg-gray-100"/>
//           <div className="h-64 rounded-2xl bg-gray-100"/>
//         </div>
//       )}

//       {error && !loading && (
//         <div className="flex flex-col items-center justify-center py-24 text-center">
//           <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center mb-4">
//             <Brain size={28} className="text-red-300"/>
//           </div>
//           <p className="text-sm font-semibold text-gray-600">Failed to load insights</p>
//           <p className="text-xs text-gray-400 mt-1">Check your connection and try again</p>
//         </div>
//       )}

//       {data && !loading && (
//         <div className="mt-5">
//           <Card>
//             <div className="p-5">
//               <div className="flex items-center gap-2 mb-5">
//                 <div className="w-9 h-9 rounded-xl bg-purple-100 flex items-center justify-center">
//                   <Brain size={18} className="text-purple-600"/>
//                 </div>
//                 <div>
//                   <h3 className="text-sm font-bold text-gray-800">Cross-Module Intelligence</h3>
//                   <p className="text-xs text-gray-400">Aggregated across all leads, tenders, work orders and activities</p>
//                 </div>
//               </div>
//               <InsightsPanel data={data}/>
//             </div>
//           </Card>
//         </div>
//       )}
//     </div>
//   )
// }



import { useState, useEffect } from 'react'
import {
  Brain, Building2, Package, Cpu, Globe, Award, TrendingDown, AlertCircle, Lock, Users, Truck, DollarSign, TrendingUp, RefreshCw,
} from 'lucide-react'
import { reportsApi } from '@/services/api'
import Card from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/FormComponents'
import { useModuleName } from '@/context/ModuleLabelsContext'

// ─── Formatters (inline fallback) ─────────────────────────────────────────────
const _fmtCur = (v: unknown): string => {
  const n = Number(v)
  if (v == null || v === '' || isNaN(n)) return '—'
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`
  return `₹${n.toLocaleString('en-IN')}`
}
const _fmtPct = (v: unknown) => { const n = Number(v); return isNaN(n) ? '—' : `${n.toFixed(1)}%` }
const _fmtNum = (v: unknown) => { const n = Number(v); return isNaN(n) ? '—' : n.toLocaleString('en-IN') }

// ─── Types ─────────────────────────────────────────────────────────────────────
interface InsightsData {
  executive_summary: {
    pipeline_value_this_week: number
    pipeline_value_last_week: number
    pipeline_delta_pct: number
    expected_revenue: number
    this_week_conversions: number
    last_week_conversions: number
    conversion_rate_this_week: number
    conversion_rate_last_week: number
    conversion_delta_pct: number
    top_risks: Array<{ title: string; detail: string; value: number; tone: 'positive' | 'negative' | 'neutral' }>
    top_opportunities: Array<{ title: string; detail: string; value: number; tone: 'positive' | 'negative' | 'neutral' }>
    conversion_alerts: string[]
  }
  approval_intelligence: {
    summary: Record<string, number>
    bottleneck_person: Record<string, unknown> | null
    bottlenecks: Record<string, unknown>[]
    rejection_patterns: Record<string, unknown>[]
    stuck_items: Record<string, unknown>[]
  }
  lead_conversion_intelligence: {
    summary: Record<string, number>
    priority_leads: Record<string, unknown>[]
  }
  tender_win_probability: {
    summary: Record<string, number>
    tenders: Record<string, unknown>[]
  }
  pipeline_health: Record<string, number>
  top_customers_by_value: Record<string, unknown>[]
  top_customers_by_revenue: Record<string, unknown>[]
  top_oems_supply_chain: Record<string, unknown>[]
  customer_product_matrix: Record<string, unknown>[]
  portal_win_analysis: Record<string, unknown>[]
  top_staff_by_wins: Record<string, unknown>[]
  customers_with_unconverted_leads: Record<string, unknown>[]
  customers_no_leads_4_months: Record<string, unknown>[]
  products_not_used: Record<string, unknown>[]
  customers_not_contacted: Record<string, unknown>[]
  delivery_health_summary: Record<string, number>
  delivery_timeliness: Record<string, unknown>[]
  lead_source_roi: Record<string, unknown>[]
  high_value_pending_leads: Record<string, unknown>[]
}

type TabKey = 'customers' | 'revenue' | 'roi' | 'high_value' | 'oems' | 'matrix' | 'portals' | 'delivery' | 'staff' | 'unconverted' | 'inactive' | 'unused' | 'untapped'

// ─── Design tokens ─────────────────────────────────────────────────────────────
const TAB_GROUPS: Record<string, { active: string; ring: string; pill: string; text: string }> = {
  sales: { active: 'bg-blue-600 text-white shadow-blue-200 shadow-md',  ring: 'border-blue-200', pill: 'bg-blue-50 text-blue-700',  text: 'text-blue-600' },
  ops:   { active: 'bg-cyan-600 text-white shadow-cyan-200 shadow-md',  ring: 'border-cyan-200', pill: 'bg-cyan-50 text-cyan-700',   text: 'text-cyan-600' },
  risk:  { active: 'bg-rose-600 text-white shadow-rose-200 shadow-md',  ring: 'border-rose-200', pill: 'bg-rose-50 text-rose-700',   text: 'text-rose-600' },
  team:  { active: 'bg-violet-600 text-white shadow-violet-200 shadow-md', ring: 'border-violet-200', pill: 'bg-violet-50 text-violet-700', text: 'text-violet-600' },
}

// ─── Shared table primitives ───────────────────────────────────────────────────
const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="text-left py-2.5 px-3 text-[10px] font-bold tracking-widest uppercase text-slate-400 bg-slate-50/80 first:rounded-tl-lg last:rounded-tr-lg whitespace-nowrap border-b border-slate-100">
    {children}
  </th>
)
const Td = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <td className={`py-2.5 px-3 text-xs ${className}`}>{children}</td>
)
const WinBadge = ({ rate }: { rate: unknown }) => {
  const n = Number(rate)
  const color = n >= 60 ? 'text-emerald-700 bg-emerald-50 ring-emerald-200' : n >= 40 ? 'text-amber-700 bg-amber-50 ring-amber-200' : 'text-rose-700 bg-rose-50 ring-rose-200'
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold ring-1 ${color}`}>{n.toFixed(1)}%</span>
}
const EmptyState = ({ msg }: { msg: string }) => (
  <div className="flex flex-col items-center justify-center py-16 gap-3">
    <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center">
      <AlertCircle size={20} className="text-slate-300" />
    </div>
    <p className="text-sm text-slate-400 font-medium">{msg}</p>
  </div>
)

// ─── InsightsPanel ─────────────────────────────────────────────────────────────
const toneClass = (tone: string) => {
  if (tone === 'positive') return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (tone === 'negative') return 'bg-rose-50 text-rose-700 ring-rose-200'
  return 'bg-slate-100 text-slate-600 ring-slate-200'
}

const bandClass = (label: string) => {
  if (['High', 'Hot'].includes(label)) return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (['Medium', 'Warm', '48 Hours', 'This Week'].includes(label)) return 'bg-amber-50 text-amber-700 ring-amber-200'
  if (['Low', 'Cold', 'Today'].includes(label)) return 'bg-rose-50 text-rose-700 ring-rose-200'
  return 'bg-slate-100 text-slate-600 ring-slate-200'
}

const DeltaPill = ({ value }: { value: number }) => {
  const positive = value >= 0
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${positive ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-rose-50 text-rose-700 ring-rose-200'}`}>
      {positive ? '+' : ''}{value.toFixed(1)}%
    </span>
  )
}

const BandBadge = ({ label }: { label: string }) => (
  <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${bandClass(label)}`}>
    {label}
  </span>
)

const SignalChip = ({ signal }: { signal: { text: string; tone: string } }) => (
  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${toneClass(signal.tone)}`}>
    {signal.text}
  </span>
)

const MiniMetric = ({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: string
  hint?: React.ReactNode
  accent: string
}) => (
  <div className="rounded-2xl border border-slate-200 bg-white/85 px-4 py-3 shadow-sm">
    <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">{label}</p>
    <p className={`mt-2 text-2xl font-black ${accent}`}>{value}</p>
    {hint ? <div className="mt-2 text-[11px] text-slate-500">{hint}</div> : null}
  </div>
)

const InsightList = ({
  title,
  items,
  empty,
}: {
  title: string
  items: Array<{ title: string; detail: string; value: number; tone: string }>
  empty: string
}) => (
  <div className="rounded-3xl border border-slate-200 bg-white/80 p-4 shadow-sm backdrop-blur">
    <div className="flex items-center gap-2">
      <div className="h-8 w-8 rounded-2xl bg-slate-100 flex items-center justify-center">
        {title === 'Top Opportunities' ? <TrendingUp size={16} className="text-emerald-600" /> : <AlertCircle size={16} className="text-rose-500" />}
      </div>
      <div>
        <p className="text-sm font-black text-slate-800">{title}</p>
        <p className="text-[11px] text-slate-400">What needs attention first</p>
      </div>
    </div>
    <div className="mt-4 space-y-3">
      {items.length > 0 ? items.map((item, index) => (
        <div key={`${title}-${index}`} className="rounded-2xl border border-slate-100 bg-white px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${item.tone === 'positive' ? 'bg-emerald-400' : item.tone === 'negative' ? 'bg-rose-400' : 'bg-slate-300'}`} />
                <p className="text-sm font-bold text-slate-800">{item.title}</p>
              </div>
              <p className="mt-1 text-[12px] leading-5 text-slate-500">{item.detail}</p>
            </div>
            {Number(item.value || 0) > 0 ? (
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ring-1 ${toneClass(item.tone)}`}>
                {_fmtCur(item.value)}
              </span>
            ) : null}
          </div>
        </div>
      )) : (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white/70 px-4 py-6 text-center text-sm text-slate-400">
          {empty}
        </div>
      )}
    </div>
  </div>
)

function PhaseOneInsights({ data }: { data: InsightsData }) {
  const executive = data.executive_summary || {
    pipeline_value_this_week: 0,
    pipeline_value_last_week: 0,
    pipeline_delta_pct: 0,
    expected_revenue: 0,
    this_week_conversions: 0,
    last_week_conversions: 0,
    conversion_rate_this_week: 0,
    conversion_rate_last_week: 0,
    conversion_delta_pct: 0,
    top_risks: [],
    top_opportunities: [],
    conversion_alerts: [],
  }
  const approvals = data.approval_intelligence || { summary: {}, bottleneck_person: null, bottlenecks: [], rejection_patterns: [], stuck_items: [] }
  const leadIntel = data.lead_conversion_intelligence || { summary: {}, priority_leads: [] }
  const tenderIntel = data.tender_win_probability || { summary: {}, tenders: [] }

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.12),_transparent_34%),radial-gradient(circle_at_bottom_right,_rgba(168,85,247,0.12),_transparent_30%),linear-gradient(180deg,_#f8fbff,_#ffffff)] p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            {/* <div className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500 ring-1 ring-slate-200">
              <Brain size={12} className="text-violet-600" />
            </div> */}
            <h3 className="mt-3 text-2xl font-black tracking-tight text-slate-900">What changed, what is blocked, and where revenue is most likely to move next.</h3>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
              This landing view stays focused on 4 decision areas : executive summary, approval bottlenecks, lead priorities, and tender win confidence.
            </p>
          </div>
          <div className="rounded-3xl border border-white/70 bg-white/70 px-4 py-3 shadow-sm backdrop-blur">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Lead Conversion</p>
            <div className="mt-2 flex items-center gap-3">
              <span className="text-3xl font-black text-slate-900">{_fmtPct(executive.conversion_rate_this_week)}</span>
              <DeltaPill value={executive.conversion_delta_pct} />
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              {executive.this_week_conversions} this week vs {executive.last_week_conversions} last week
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MiniMetric
            label="Pipeline This Week"
            value={_fmtCur(executive.pipeline_value_this_week)}
            hint={<span className="inline-flex items-center gap-2"><DeltaPill value={executive.pipeline_delta_pct} /> <span>vs last week</span></span>}
            accent="text-blue-700"
          />
          <MiniMetric
            label="Pipeline Last Week"
            value={_fmtCur(executive.pipeline_value_last_week)}
            hint="Previous 7-day pipeline snapshot"
            accent="text-slate-800"
          />
          <MiniMetric
            label="Expected Revenue"
            value={_fmtCur(executive.expected_revenue)}
            hint="Weighted from open leads and tenders"
            accent="text-emerald-700"
          />
          <MiniMetric
            label="Conversion This Week"
            value={_fmtPct(executive.conversion_rate_this_week)}
            hint={`${_fmtNum(executive.this_week_conversions)} converted closes`}
            accent="text-violet-700"
          />
        </div>

        {executive.conversion_alerts && executive.conversion_alerts.length > 0 ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {executive.conversion_alerts.map((alert, index) => (
              <span key={`alert-${index}`} className="inline-flex items-center gap-2 rounded-full bg-rose-50 px-3 py-1.5 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200">
                <AlertCircle size={12} />
                {alert}
              </span>
            ))}
          </div>
        ) : null}

        <div className="mt-6 grid gap-4 xl:grid-cols-2">
          <InsightList
            title="Top Opportunities"
            items={executive.top_opportunities || []}
            empty="No major opportunities have been surfaced yet."
          />
          <InsightList
            title="Top Risks"
            items={executive.top_risks || []}
            empty="No major risks have been surfaced yet."
          />
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-2xl bg-rose-50 flex items-center justify-center">
              <AlertCircle size={18} className="text-rose-500" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-900">Approval Intelligence</h3>
              <p className="text-[12px] text-slate-500">Spot items stuck beyond SLA, bottleneck approvers, and rejection patterns.</p>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MiniMetric label="Pending" value={_fmtNum(approvals.summary?.pending_count || 0)} accent="text-slate-900" />
            <MiniMetric label="SLA Breaches" value={_fmtNum(approvals.summary?.sla_breach_count || 0)} accent="text-rose-700" />
            <MiniMetric label="Pending Value" value={_fmtCur(approvals.summary?.pending_value || 0)} accent="text-amber-700" />
            <MiniMetric label="CEO Queue" value={_fmtNum(approvals.summary?.ceo_queue || 0)} accent="text-violet-700" />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="rounded-3xl border border-slate-200 bg-slate-50/70 p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">Bottlenecks</p>
              <div className="mt-3 space-y-3">
                {(approvals.bottlenecks || []).length > 0 ? (approvals.bottlenecks || []).slice(0, 3).map((row: any, index) => (
                  <div key={`bottleneck-${index}`} className="rounded-2xl border border-slate-200 bg-white px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-bold text-slate-800">{row.approver_name || 'Unassigned'}</p>
                        <p className="text-[11px] capitalize text-slate-400">{row.approver_role || '—'}</p>
                      </div>
                      <BandBadge label={`${_fmtNum(row.pending_count)} pending`} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
                      <span>Avg age {_fmtNum(row.avg_age_days)}d</span>
                      <span>•</span>
                      <span>{_fmtCur(row.stuck_value)}</span>
                    </div>
                  </div>
                )) : <p className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">No approval bottlenecks right now.</p>}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-slate-50/70 p-4">
              <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">Rejection Patterns</p>
              <div className="mt-3 space-y-3">
                {(approvals.rejection_patterns || []).length > 0 ? (approvals.rejection_patterns || []).slice(0, 4).map((row: any, index) => (
                  <div key={`pattern-${index}`} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-3 py-3">
                    <div>
                      <p className="text-sm font-bold text-slate-800">{row.reason || 'Not specified'}</p>
                      <p className="text-[11px] text-slate-400">Common rejection bucket</p>
                    </div>
                    <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-full bg-rose-50 px-2 text-sm font-black text-rose-700 ring-1 ring-rose-200">
                      {_fmtNum(row.count)}
                    </span>
                  </div>
                )) : <p className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">No rejection trend is available yet.</p>}
              </div>
            </div>
          </div>

          <div className="mt-5 overflow-hidden rounded-3xl border border-slate-200">
            {(approvals.stuck_items || []).length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      {['Item', 'Approver', 'Age', 'Value'].map(col => <Th key={col}>{col}</Th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {(approvals.stuck_items || []).map((row: any, index) => (
                      <tr key={`stuck-${index}`} className={`border-b border-slate-50 ${index % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}>
                        <Td>
                          <div>
                            <p className="font-bold text-slate-800">{row.record_ref || '—'}</p>
                            <p className="text-[11px] text-slate-400">{row.module || 'Approval'} • {row.action || 'Pending'}</p>
                          </div>
                        </Td>
                        <Td>
                          <div>
                            <p className="font-semibold text-slate-700">{row.requested_to || 'Unassigned'}</p>
                            <p className="text-[11px] text-slate-400">{row.requested_by || 'System'}</p>
                          </div>
                        </Td>
                        <Td><span className="font-bold text-rose-600">{_fmtNum(row.age_days)}d</span></Td>
                        <Td><span className="font-bold text-amber-700">{_fmtCur(row.value)}</span></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState msg="No approvals are currently beyond SLA." />
            )}
          </div>
        </section>

        <section className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-2xl bg-emerald-50 flex items-center justify-center">
              <TrendingUp size={18} className="text-emerald-600" />
            </div>
            <div>
              <h3 className="text-lg font-black text-slate-900">Lead Conversion Intelligence</h3>
              <p className="text-[12px] text-slate-500">Show hot leads, cold leads, and the next best action for reps.</p>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MiniMetric label="Open Leads" value={_fmtNum(leadIntel.summary?.open_leads || 0)} accent="text-slate-900" />
            <MiniMetric label="Hot Leads" value={_fmtNum(leadIntel.summary?.hot_leads || 0)} accent="text-emerald-700" />
            <MiniMetric label="Going Cold" value={_fmtNum(leadIntel.summary?.going_cold || 0)} accent="text-rose-700" />
            <MiniMetric label="Follow-up Today" value={_fmtNum(leadIntel.summary?.follow_up_today || 0)} accent="text-amber-700" />
          </div>

          <div className="mt-5 overflow-hidden rounded-3xl border border-slate-200">
            {(leadIntel.priority_leads || []).length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      {['Lead', 'Owner', 'Stage', 'Score', 'Next Best Action', 'Priority'].map(col => <Th key={col}>{col}</Th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {(leadIntel.priority_leads || []).map((row: any, index) => (
                      <tr key={`lead-${index}`} className={`border-b border-slate-50 align-top ${index % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}>
                        <Td>
                          <div className="min-w-[220px]">
                            <p className="font-bold text-slate-800">{row.lead_title || '—'}</p>
                            <p className="mt-0.5 text-[11px] text-slate-400">{row.customer_name || 'Unknown'} • {_fmtCur(row.lead_value)}</p>
                            {row.signals?.length ? (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {row.signals.slice(0, 2).map((signal: any, signalIndex: number) => (
                                  <SignalChip key={`lead-signal-${index}-${signalIndex}`} signal={signal} />
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </Td>
                        <Td>
                          <div className="min-w-[120px]">
                            <p className="font-semibold text-slate-700">{row.assigned_to || 'Unassigned'}</p>
                            <p className="text-[11px] text-slate-400">{_fmtNum(row.days_idle)}d idle</p>
                          </div>
                        </Td>
                        <Td>
                          <div className="flex flex-col gap-1.5">
                            <BandBadge label={row.status || '—'} />
                            <BandBadge label={row.temperature || 'Cold'} />
                          </div>
                        </Td>
                        <Td><span className="text-lg font-black text-slate-900">{_fmtNum(row.score)}</span></Td>
                        <Td>
                          <div className="min-w-[220px]">
                            <p className="font-semibold text-slate-700">{row.next_best_action || '—'}</p>
                            <p className="mt-0.5 text-[11px] text-slate-400">{_fmtNum(row.days_open)}d open</p>
                          </div>
                        </Td>
                        <Td><BandBadge label={row.follow_up_priority || 'This Week'} /></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState msg="No open leads are available for scoring right now." />
            )}
          </div>
        </section>
      </div>

      <section className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-2xl bg-blue-50 flex items-center justify-center">
            <Building2 size={18} className="text-blue-600" />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-900">Tender Win Probability</h3>
            <p className="text-[12px] text-slate-500">Use domain-specific tender signals to surface the best bets and the risky bids.</p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <MiniMetric label="Open Tenders" value={_fmtNum(tenderIntel.summary?.open_tenders || 0)} accent="text-slate-900" />
          <MiniMetric label="High Confidence" value={_fmtNum(tenderIntel.summary?.high_probability || 0)} accent="text-emerald-700" />
          <MiniMetric label="Medium Confidence" value={_fmtNum(tenderIntel.summary?.medium_probability || 0)} accent="text-amber-700" />
          <MiniMetric label="Low Confidence" value={_fmtNum(tenderIntel.summary?.low_probability || 0)} accent="text-rose-700" />
          <MiniMetric label="High-Prob Value" value={_fmtCur(tenderIntel.summary?.high_probability_value || 0)} accent="text-blue-700" />
        </div>

        <div className="mt-5 overflow-hidden rounded-3xl border border-slate-200">
          {(tenderIntel.tenders || []).length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    {['Tender', 'Portal', 'Owner', 'Win Band', 'Score', 'Value', 'Reason Breakdown'].map(col => <Th key={col}>{col}</Th>)}
                  </tr>
                </thead>
                <tbody>
                  {(tenderIntel.tenders || []).map((row: any, index) => (
                    <tr key={`tender-${index}`} className={`border-b border-slate-50 align-top ${index % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}>
                      <Td>
                        <div className="min-w-[240px]">
                          <p className="font-bold text-slate-800">{row.tender_title || '—'}</p>
                          <p className="mt-0.5 text-[11px] text-slate-400">{row.customer_name || 'Unknown'} • {row.status || '—'}</p>
                        </div>
                      </Td>
                      <Td>
                        <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-bold text-blue-700 ring-1 ring-blue-200">
                          {row.portal || 'Other'}
                        </span>
                      </Td>
                      <Td>
                        <div className="min-w-[120px]">
                          <p className="font-semibold text-slate-700">{row.assigned_to || 'Unassigned'}</p>
                          <p className="text-[11px] text-slate-400">
                            {row.days_to_submission != null ? `${row.days_to_submission}d to submit` : 'No submission date'}
                          </p>
                        </div>
                      </Td>
                      <Td><BandBadge label={row.probability_band || 'Low'} /></Td>
                      <Td>
                        <div className="space-y-1">
                          <p className="text-lg font-black text-slate-900">{_fmtNum(row.score)}</p>
                          <p className="text-[11px] text-slate-400">{_fmtPct(row.customer_win_rate)} customer win rate</p>
                        </div>
                      </Td>
                      <Td><span className="font-bold text-blue-700">{_fmtCur(row.tender_value)}</span></Td>
                      <Td>
                        <div className="min-w-[260px] flex flex-wrap gap-1.5">
                          {row.signals?.length ? row.signals.slice(0, 3).map((signal: any, signalIndex: number) => (
                            <SignalChip key={`tender-signal-${index}-${signalIndex}`} signal={signal} />
                          )) : <span className="text-[11px] text-slate-400">No strong signal yet</span>}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState msg="No open tenders are available for scoring right now." />
          )}
        </div>
      </section>
    </div>
  )
}

function InsightsPanel({ data }: { data: InsightsData }) {
  const [tab, setTab] = useState<TabKey>('customers')
  const h  = data.pipeline_health
  const dh = data.delivery_health_summary || {}

  const tabs = [
    { key: 'customers',   label: 'Top Customers',     icon: <Building2 size={12}/>,    group: 'sales' },
    { key: 'revenue',     label: 'Top Customers (Revenue)',  icon: <DollarSign size={12}/>,     group: 'sales' },
    { key: 'roi',         label: 'Lead Source ROI',   icon: <TrendingUp size={12}/>,   group: 'sales' },
    { key: 'high_value',  label: 'High-Value Pending',icon: <AlertCircle size={12}/>,  group: 'sales' },
    { key: 'oems',        label: 'OEM Supply Chain',  icon: <Package size={12}/>,      group: 'sales' },
    { key: 'matrix',      label: 'Cust × Product',    icon: <Cpu size={12}/>,          group: 'sales' },
    { key: 'portals',     label: 'Portal Analysis',   icon: <Globe size={12}/>,        group: 'sales' },
    { key: 'delivery',    label: 'Delivery Timing',   icon: <Truck size={12}/>,        group: 'ops'   },
    { key: 'unconverted', label: 'Unconverted Leads', icon: <TrendingDown size={12}/>, group: 'risk'  },
    { key: 'inactive',    label: 'Inactive 4M+',      icon: <AlertCircle size={12}/>,  group: 'risk'  },
    { key: 'unused',      label: 'Unused Products',   icon: <Lock size={12}/>,         group: 'risk'  },
    { key: 'untapped',    label: 'Not Contacted',     icon: <Users size={12}/>,        group: 'risk'  },
    { key: 'staff',       label: 'Staff Performance', icon: <Award size={12}/>,        group: 'team'  },
  ] as const

  const activeGroup = tabs.find(t => t.key === tab)?.group ?? 'sales'
  const gc = TAB_GROUPS[activeGroup]

  // KPI strip config
  const kpis = [
    { label: 'Total Leads',     value: _fmtNum(h.total_leads),          color: 'text-blue-700',   bg: 'bg-blue-50',   border: 'border-blue-100',   icon: '📋' },
    { label: 'Leads Converted', value: _fmtNum(h.leads_converted),      color: 'text-emerald-700',bg: 'bg-emerald-50',border: 'border-emerald-100', icon: '✅' },
    { label: 'Lead Conv. Rate', value: _fmtPct(h.lead_conversion_rate), color: 'text-violet-700', bg: 'bg-violet-50', border: 'border-violet-100',  icon: '📈' },
    { label: 'Total Tenders',   value: _fmtNum(h.total_tenders),        color: 'text-blue-700',   bg: 'bg-blue-50',   border: 'border-blue-100',   icon: '📁' },
    { label: 'Tenders Won',     value: _fmtNum(h.tenders_won),          color: 'text-emerald-700',bg: 'bg-emerald-50',border: 'border-emerald-100', icon: '🏆' },
    { label: 'Tender Win Rate', value: _fmtPct(h.tender_win_rate),      color: 'text-amber-700',  bg: 'bg-amber-50',  border: 'border-amber-100',   icon: '⚡' },
  ]

  return (
    <div className="space-y-5">

      {/* ── KPI Strip ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
        {kpis.map(k => (
          <div key={k.label} className={`${k.bg} ${k.border} border rounded-2xl p-3.5 relative overflow-hidden group hover:scale-[1.02] transition-transform duration-150`}>
            <div className="absolute -top-3 -right-3 w-12 h-12 rounded-full bg-white/40" />
            <p className="text-[9px] font-black uppercase tracking-[0.1em] text-slate-500 mb-1">{k.label}</p>
            <p className={`text-2xl font-black ${k.color} leading-none`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* ── Tab Bar ─────────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {tabs.map(t => {
            const isActive = tab === t.key
            const g = TAB_GROUPS[t.group]
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key as TabKey)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap transition-all duration-150 border
                  ${isActive
                    ? `${g.active} border-transparent`
                    : `bg-white ${g.ring} ${g.text} hover:bg-slate-50`
                  }`}
              >
                {t.icon}
                {t.label}
              </button>
            )
          })}
        </div>

        {/* Active section label */}
        <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${gc.ring} bg-white`}>
          <span className={`w-1.5 h-1.5 rounded-full ${gc.active.split(' ')[0]}`} />
          <span className={`text-[11px] font-bold ${gc.text}`}>
            {tabs.find(t => t.key === tab)?.label}
          </span>
          <span className="text-[11px] text-slate-400">— aggregated data</span>
        </div>
      </div>

      {/* ── Content Panel ──────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-100 overflow-hidden shadow-sm">

        {/* ── Top Customers ──────────────────────────────────────────────── */}
        {tab === 'customers' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr>
                {['Customer','Tenders','Won','Lost','Win Rate','Total Bid Value','Products','OEMs'].map(col => <Th key={col}>{col}</Th>)}
              </tr></thead>
              <tbody>
                {data.top_customers_by_value.map((r: any, i) => (
                  <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                    <Td><span className="font-bold text-slate-800">{r.customer}</span></Td>
                    <Td className="text-left font-semibold text-slate-600">{r.tender_count}</Td>
                    <Td className="text-left"><span className="font-bold text-emerald-600">{r.won}</span></Td>
                    <Td className="text-left"><span className="font-bold text-rose-500">{r.lost}</span></Td>
                    <Td><WinBadge rate={r.win_rate} /></Td>
                    <Td className="text-left"><span className="font-bold text-blue-700">{_fmtCur(r.total_bid_value)}</span></Td>
                    <Td><span className="text-slate-500 text-[11px]" title={r.products}>{r.products || '—'}</span></Td>
                    <Td><span className="text-slate-500 text-[11px]" title={r.oems}>{r.oems || '—'}</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Top Customers by Revenue ───────────────────────────────────── */}
        {tab === 'revenue' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr>
                {['Customer','Total Revenue','Won Tenders','Avg Deal Value'].map(col => <Th key={col}>{col}</Th>)}
              </tr></thead>
              <tbody>
                {(data.top_customers_by_revenue || []).map((r: any, i) => (
                  <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                    <Td><span className="font-bold text-slate-800">{r.customer}</span></Td>
                    <Td className="text-left"><span className="font-bold text-emerald-600">{_fmtCur(r.total_revenue)}</span></Td>
                    <Td className="text-left font-semibold text-slate-600">{r.tender_count}</Td>
                    <Td className="text-left"><span className="font-semibold text-blue-700">{_fmtCur(r.avg_deal_value)}</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(data.top_customers_by_revenue || []).length === 0 && <EmptyState msg="No revenue data available" />}
          </div>
        )}

        {/* ── Lead Source ROI ────────────────────────────────────────────── */}
        {tab === 'roi' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr>
                {['Lead Source','Total Leads','Converted','Conv. Rate','Revenue Generated','Avg Revenue/Convert'].map(col => <Th key={col}>{col}</Th>)}
              </tr></thead>
              <tbody>
                {(data.lead_source_roi || []).map((r: any, i) => (
                  <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                    <Td><span className="font-bold text-slate-800">{r.source}</span></Td>
                    <Td className="text-left font-semibold text-slate-600">{_fmtNum(r.total_leads)}</Td>
                    <Td className="text-left"><span className="font-bold text-emerald-600">{_fmtNum(r.converted)}</span></Td>
                    <Td><WinBadge rate={r.conversion_rate} /></Td>
                    <Td className="text-left"><span className="font-bold text-blue-700">{_fmtCur(r.revenue_generated)}</span></Td>
                    <Td className="text-left"><span className="font-bold text-emerald-700">{_fmtCur(r.avg_revenue_per_convert)}</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(data.lead_source_roi || []).length === 0 && <EmptyState msg="No lead source data available" />}
          </div>
        )}

        {/* ── High-Value Pending Leads ───────────────────────────────────── */}
        {tab === 'high_value' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr>
                {['Lead Title','Customer','Lead Value','Status','Assigned To','Days Pending'].map(col => <Th key={col}>{col}</Th>)}
              </tr></thead>
              <tbody>
                {(data.high_value_pending_leads || []).map((r: any, i) => (
                  <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                    <Td><span className="font-semibold text-slate-800 max-w-xs truncate" title={r.lead_title}>{r.lead_title || '—'}</span></Td>
                    <Td><span className="text-slate-700">{r.customer_name || '—'}</span></Td>
                    <Td className="text-left"><span className="font-bold text-amber-600">{_fmtCur(r.lead_value)}</span></Td>
                    <Td><span className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-semibold ring-1 ring-blue-100">{r.status}</span></Td>
                    <Td><span className="text-slate-700 text-[11px]">{r.assigned_to || 'Unassigned'}</span></Td>
                    <Td className="text-left"><span className="font-bold text-slate-800">{r.days_pending}d</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(data.high_value_pending_leads || []).length === 0 && <EmptyState msg="No high-value pending leads" />}
          </div>
        )}

        {/* ── OEM Supply Chain ───────────────────────────────────────────── */}
        {tab === 'oems' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr>
                {['OEM Name','Tender Count','Won Count','Win Rate','Products Supplied','Customers Served'].map(col => <Th key={col}>{col}</Th>)}
              </tr></thead>
              <tbody>
                {data.top_oems_supply_chain.map((r: any, i) => (
                  <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                    <Td><span className="font-bold text-slate-800">{r.oem_name}</span></Td>
                    <Td className="text-left font-semibold text-slate-600">{r.tender_count}</Td>
                    <Td className="text-left"><span className="font-bold text-emerald-600">{r.won_count}</span></Td>
                    <Td><WinBadge rate={r.win_rate} /></Td>
                    <Td><span className="text-slate-500 text-[11px]">{r.products_supplied || '—'}</span></Td>
                    <Td><span className="text-slate-500 text-[11px]">{r.customers_served || '—'}</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Customer × Product Matrix ──────────────────────────────────── */}
        {tab === 'matrix' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr>
                {['Customer','Top Products','Unique Products','Total Occurrences'].map(col => <Th key={col}>{col}</Th>)}
              </tr></thead>
              <tbody>
                {data.customer_product_matrix.map((r: any, i) => (
                  <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                    <Td><span className="font-bold text-slate-800 whitespace-nowrap">{r.customer}</span></Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {String(r.top_products || '').split(', ').filter(Boolean).map((p: string) => (
                          <span key={p} className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-semibold ring-1 ring-blue-100">{p}</span>
                        ))}
                      </div>
                    </Td>
                    <Td className="text-left"><span className="font-bold text-violet-700">{r.product_count}</span></Td>
                    <Td className="text-left font-semibold text-slate-600">{r.total_occurrences}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Portal Analysis ────────────────────────────────────────────── */}
        {tab === 'portals' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr>
                {['Portal','Total Tenders','Won','Lost','Win Rate','Total Value'].map(col => <Th key={col}>{col}</Th>)}
              </tr></thead>
              <tbody>
                {data.portal_win_analysis.map((r: any, i) => (
                  <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                    <Td>
                      <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-[11px] font-bold bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100">
                        {r.portal}
                      </span>
                    </Td>
                    <Td className="text-left font-semibold text-slate-600">{r.total}</Td>
                    <Td className="text-left"><span className="font-bold text-emerald-600">{r.won}</span></Td>
                    <Td className="text-left"><span className="font-bold text-rose-500">{r.lost}</span></Td>
                    <Td><WinBadge rate={r.win_rate} /></Td>
                    <Td className="text-left"><span className="font-bold text-blue-700">{_fmtCur(r.total_value)}</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Delivery Timing ────────────────────────────────────────────── */}
        {tab === 'delivery' && (
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              {[
                { label: 'Scheduled WOs',  value: _fmtNum(dh.scheduled_orders),   cls: 'text-slate-700  bg-slate-50   border-slate-200'  },
                { label: 'On Time',        value: _fmtNum(dh.on_time_completed),   cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
                { label: 'Delivered Late', value: _fmtNum(dh.delivered_late),      cls: 'text-amber-700  bg-amber-50   border-amber-200'   },
                { label: 'Delayed Now',    value: _fmtNum(dh.currently_delayed),   cls: 'text-rose-700   bg-rose-50    border-rose-200'    },
                { label: 'Pending',        value: _fmtNum(dh.pending_delivery),    cls: 'text-blue-700   bg-blue-50    border-blue-200'    },
              ].map(card => (
                <div key={card.label} className={`rounded-2xl border px-4 py-3 ${card.cls}`}>
                  <p className="text-[9px] font-black uppercase tracking-widest opacity-60">{card.label}</p>
                  <p className="mt-1 text-2xl font-black">{card.value}</p>
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-2.5 text-[11px] text-slate-500 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-300 inline-block" />
              Delivery timing uses planned work-order delivery date, current status, and completion date when available.
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-100">
              {data.delivery_timeliness && data.delivery_timeliness.length > 0 ? (
                <table className="w-full">
                  <thead><tr>
                    {['WO Number','Customer','Products','Planned Date','Actual Date','Delivery Health','WO Status','Note'].map(col => <Th key={col}>{col}</Th>)}
                  </tr></thead>
                  <tbody>
                    {data.delivery_timeliness.map((r: any, i) => (
                      <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                        <Td><span className="font-bold text-slate-800 whitespace-nowrap">{r.wo_number || '—'}</span></Td>
                        <Td><span className="font-semibold text-slate-700 whitespace-nowrap">{r.customer_name || '—'}</span></Td>
                        <Td><span className="text-slate-500 text-[11px]">{r.products || '—'}</span></Td>
                        <Td><span className="text-slate-500 whitespace-nowrap">{r.planned_delivery_date || '—'}</span></Td>
                        <Td><span className="text-slate-500 whitespace-nowrap">{r.actual_completion_date || '—'}</span></Td>
                        <Td>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ring-1 ${
                            r.delivery_health === 'On Time'           ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                            : r.delivery_health === 'Delivered Late'  ? 'bg-amber-50 text-amber-700 ring-amber-200'
                            : r.delivery_health === 'Currently Delayed'? 'bg-rose-50 text-rose-700 ring-rose-200'
                            : r.delivery_health === 'Pending'         ? 'bg-blue-50 text-blue-700 ring-blue-200'
                            : 'bg-slate-100 text-slate-600 ring-slate-200'
                          }`}>
                            {r.delivery_health}
                          </span>
                        </Td>
                        <Td><span className="text-slate-500 whitespace-nowrap text-[11px]">{r.work_order_status || '—'}</span></Td>
                        <Td><span className="text-slate-400 text-[11px]">{r.delivery_note || '—'}</span></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <EmptyState msg="No delivery timing data available yet." />
              )}
            </div>
          </div>
        )}

        {/* ── Unconverted Leads ──────────────────────────────────────────── */}
        {tab === 'unconverted' && (
          <div className="overflow-x-auto">
            {data.customers_with_unconverted_leads && data.customers_with_unconverted_leads.length > 0 ? (
              <table className="w-full">
                <thead><tr>
                  {['Customer','Unconverted Leads','Lead Titles','Products'].map(col => <Th key={col}>{col}</Th>)}
                </tr></thead>
                <tbody>
                  {data.customers_with_unconverted_leads.map((r: any, i) => (
                    <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                      <Td><span className="font-bold text-slate-800">{r.customer}</span></Td>
                      <Td className="text-left">
                        <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-amber-50 text-amber-700 font-black text-sm ring-1 ring-amber-200">
                          {r.unconverted_lead_count}
                        </span>
                      </Td>
                      <Td><span className="text-slate-500 text-[11px]">{r.lead_titles || '—'}</span></Td>
                      <Td><span className="text-slate-400 text-[11px]">{r.products || '—'}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState msg="No unconverted leads data available. Please restart the backend service." />
            )}
          </div>
        )}

        {/* ── Inactive 4M+ ───────────────────────────────────────────────── */}
        {tab === 'inactive' && (
          <div className="overflow-x-auto">
            {data.customers_no_leads_4_months && data.customers_no_leads_4_months.length > 0 ? (
              <table className="w-full">
                <thead><tr>
                  {['Customer','Total Tenders','Last Activity'].map(col => <Th key={col}>{col}</Th>)}
                </tr></thead>
                <tbody>
                  {data.customers_no_leads_4_months.map((r: any, i) => (
                    <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                      <Td><span className="font-bold text-slate-800">{r.customer}</span></Td>
                      <Td className="text-left font-semibold text-slate-600">{r.total_tenders}</Td>
                      <Td>
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 text-[11px] font-bold ring-1 ring-rose-200">
                          {r.last_activity}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState msg="No inactive customers data available. Please restart the backend service." />
            )}
          </div>
        )}

        {/* ── Unused Products ────────────────────────────────────────────── */}
        {tab === 'unused' && (
          <div className="overflow-x-auto">
            {data.products_not_used && data.products_not_used.length > 0 ? (
              <table className="w-full">
                <thead><tr>
                  {['Product Name','Category','Description'].map(col => <Th key={col}>{col}</Th>)}
                </tr></thead>
                <tbody>
                  {data.products_not_used.map((r: any, i) => (
                    <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                      <Td><span className="font-bold text-slate-800">{r.product_name}</span></Td>
                      <Td>
                        <span className="inline-flex items-center px-2 py-0.5 rounded-lg text-[10px] font-bold bg-slate-100 text-slate-600 ring-1 ring-slate-200">
                          {r.category}
                        </span>
                      </Td>
                      <Td><span className="text-slate-500 text-[11px]">{r.description || '—'}</span></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState msg="No unused products data available. Please restart the backend service." />
            )}
          </div>
        )}

        {/* ── Untapped / Not Contacted ───────────────────────────────────── */}
        {tab === 'untapped' && (
          <div className="overflow-x-auto">
            {data.customers_not_contacted && data.customers_not_contacted.length > 0 ? (
              <table className="w-full">
                <thead><tr>
                  {['Customer Name','Total Leads','Total Tenders','Status'].map(col => <Th key={col}>{col}</Th>)}
                </tr></thead>
                <tbody>
                  {data.customers_not_contacted.map((r: any, i) => (
                    <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                      <Td><span className="font-bold text-slate-800">{r.customer_name}</span></Td>
                      <Td className="text-left font-semibold text-slate-600">{r.total_leads}</Td>
                      <Td className="text-left font-semibold text-slate-600">{r.total_tenders}</Td>
                      <Td>
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-blue-50 text-blue-700 ring-1 ring-blue-100">
                          {r.status}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState msg="No untapped customers data available. Please restart the backend service." />
            )}
          </div>
        )}

        {/* ── Staff Performance ──────────────────────────────────────────── */}
        {tab === 'staff' && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr>
                {['Name','Leads','Tenders','Won','Win Rate','Won Value'].map(col => <Th key={col}>{col}</Th>)}
              </tr></thead>
              <tbody>
                {data.top_staff_by_wins.map((r: any, i) => (
                  <tr key={i} className={`border-b border-slate-50 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}`}>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <div
                          className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-black shrink-0"
                          style={{
                            background: `hsl(${(r.name?.charCodeAt(0) ?? 0) * 37 % 360}, 55%, 88%)`,
                            color: `hsl(${(r.name?.charCodeAt(0) ?? 0) * 37 % 360}, 55%, 35%)`,
                          }}
                        >
                          {String(r.name ?? '').split(' ').map((w: string) => w[0]).join('').slice(0, 2)}
                        </div>
                        <span className="font-bold text-slate-800">{r.name}</span>
                      </div>
                    </Td>
                    <Td className="text-left"><span className="font-bold text-blue-600">{r.leads}</span></Td>
                    <Td className="text-left font-semibold text-slate-600">{r.tenders}</Td>
                    <Td className="text-left"><span className="font-bold text-emerald-600">{r.won}</span></Td>
                    <Td><WinBadge rate={r.win_rate} /></Td>
                    <Td className="text-left"><span className="font-bold text-blue-700">{_fmtCur(r.won_value)}</span></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────────
export default function InsightsPage() {
  const { label: aiLabel } = useModuleName('insights')
  const [data,    setData]    = useState<InsightsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)

  const load = () => {
    setLoading(true)
    setError(false)
    reportsApi.getInsights()
      .then((r: any) => setData(r.data))
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  return (
    <div className="p-6">
      <PageHeader
        title={aiLabel}
        subtitle="Executive summary, approval bottlenecks, lead priorities, and tender win confidence"
        breadcrumb={[aiLabel]}
        actions={<button onClick={load} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>}
      />

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-4 animate-pulse mt-4">
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
            {[...Array(6)].map((_, i) => <div key={i} className="h-16 rounded-2xl bg-slate-100"/>)}
          </div>
          <div className="flex flex-wrap gap-2">
            {[...Array(10)].map((_, i) => <div key={i} className="h-7 w-28 rounded-full bg-slate-100"/>)}
          </div>
          <div className="h-64 rounded-2xl bg-slate-100"/>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-rose-50 flex items-center justify-center">
            <Brain size={28} className="text-rose-300"/>
          </div>
          <div>
            <p className="text-sm font-bold text-slate-600">Failed to load insights</p>
            <p className="text-xs text-slate-400 mt-1">Check your connection and try again</p>
          </div>
        </div>
      )}

      {/* Main content */}
      {data && !loading && (
        <div className="mt-5 space-y-5">
          <PhaseOneInsights data={data}/>
          <Card>
            <div className="p-5">
              {/* Panel header */}
              <div className="flex items-center gap-3 mb-6 pb-4 border-b border-slate-100">
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-200">
                  <Brain size={18} className="text-white"/>
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-800 tracking-tight">Supporting Cross-Module Intelligence</h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">Detailed supporting views across leads, tenders, work orders, products, OEMs, and delivery</p>
                </div>
              </div>
              <InsightsPanel data={data}/>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
