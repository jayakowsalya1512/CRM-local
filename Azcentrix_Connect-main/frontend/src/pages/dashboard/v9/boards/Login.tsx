import { useState } from 'react'
import { Avatar, Btn, C, Empty, Pill, fdt, num } from '@/components/platform/bw'
import { Donut, HBars, Heat, LineChart, PAL } from '@/components/platform/charts'
import { usePermissions } from '@/hooks'
import { useToast } from '@/components/ui/ToastContext'
import api from '@/services/api'
import { PERM, useBoard, type Period } from '../data'
import { COLS, drill } from '../records'
import { RecordGrid, ErrorBox, Kpis, LoadingBox, NoAccess, Sec, useDrill } from '../ui'

type LoginBoard = {
  kpis: { today: number; spark: number[]; active_now: number; unique7: number; users: number; failed7: number; flagged: number; avg_session: number | null }
  days: string[]; per_day: { ok: number; fail: number }[]; peak: number[][]
  devices: { l: string; v: number }[]; adoption: { l: string; v: number; n: number }[]; web_mobile: { web: number; mobile: number }
  signals: { kind: string; user: string; date: string; detail: string; severity: string; ip: string }[]
  inactive: { id: number; name: string; role: string; last_login: string | null }[]; inactive_count: number; ip_visible: boolean
}

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOURS = ['8', '9', '10', '11', '12', '13', '14', '15', '16', '17']

// Login tracker (prototype dashLogin) from user_sessions, login_logs and login OTP challenges. Location isn't recorded.
// Full IP addresses are shown only to roles with Users › Manage or Audit logs › View; others see them masked.
export default function Login({ period, nonce }: { period: Period; nonce: number }) {
  const { can } = usePermissions()
  const open = useDrill()
  const { success, error: showError } = useToast()
  const [reminded, setReminded] = useState<Set<number>>(new Set())
  const r = useBoard<LoginBoard>('login', period, can(PERM.login), nonce)
  if (r.denied) return <NoAccess what="the Login tracker" />
  if (r.loading) return <LoadingBox />
  if (r.error || !r.data) return <ErrorBox msg={r.error || 'Could not load login activity'} />
  const d = r.data, k = d.kpis
  const peakMax = Math.max(1, ...d.peak.flat())
  const remind = async (u: LoginBoard['inactive'][number]) => {
    try {
      await api.post('/dashboard/send-login-reminder', { user_ids: [u.id] })
      setReminded(s => new Set(s).add(u.id))
      success(`Reminder sent to ${u.name}`)
    } catch (err: any) { showError(err?.response?.data?.detail || 'Could not send the reminder') }
  }

  return <>
    <Kpis items={[
      { l: 'Logins today', v: num(k.today), sp: k.spark, drill: () => drill('logins', 'today', 'Logins today', { value: num(k.today) }) },
      { l: 'Active now', v: num(k.active_now), drill: () => drill('logins', 'active', 'Active now', { value: num(k.active_now), sub: 'Sessions active in the last 15 minutes' }) },
      { l: 'Unique users · 7 d', v: num(k.unique7), d: k.users ? `${Math.round(k.unique7 / k.users * 100)}% of users` : undefined, drill: () => drill('logins', 'ok7', 'Unique users · 7 d', { value: num(k.unique7) }) },
      { l: 'Failed attempts · 7 d', v: num(k.failed7), dc: k.failed7 > 4 ? 'twarn' : undefined, drill: () => drill('logins', 'failed7', 'Failed attempts · 7 d', { value: num(k.failed7) }) },
      { l: 'Flagged sessions', v: num(k.flagged), dc: k.flagged ? 'tbad' : undefined, drill: () => drill('signals', 'all', 'Flagged sessions', { value: num(k.flagged) }) },
      { l: 'Avg session', v: k.avg_session == null ? '—' : `${k.avg_session} min`, drill: () => drill('logins', 'ok7', 'Avg session', { value: k.avg_session == null ? '—' : `${k.avg_session} min` }) },
    ]} />

    <div className="bw-g g2 mb">
      <Sec t="Logins per day · 14 days">
        <LineChart h={130} labels={d.days.map((x, i) => (i % 3 === 0 ? x.slice(8) : ''))} series={[{ n: 'Successful', c: PAL[2], v: d.per_day.map(p => p.ok) }, { n: 'Failed', c: PAL[4], v: d.per_day.map(p => p.fail) }]} />
      </Sec>
      <Sec t="Peak hours · weekday × hour">
        <Heat rows={WEEK} cols={HOURS} cell={(i, j) => { const n = d.peak[i]?.[j] ?? 0; return { v: n ? Math.max(12, Math.round(n / peakMax * 100)) : 0, t: `${WEEK[i]} ${HOURS[j]}:00 — ${n} sign-ins (14 days)` } }} />
      </Sec>
    </div>

    <div className="bw-g g3 mb">
      <Sec t="Devices · 7 days">
        {d.devices.length ? <Donut f={v => num(v)} data={d.devices} onPick={i => open(drill('logins', `os:${d.devices[i].l}`, `Devices · ${d.devices[i].l}`))} /> : <Empty>No sign-ins in the last 7 days</Empty>}
      </Sec>
      <Sec t="Adoption by role">
        <HBars lw={120} vw={40} rows={d.adoption.map(a => ({ l: a.l, v: a.v, text: `${a.v}%`, note: `${a.n} users` }))} onPick={i => open(drill('logins', `role:${d.adoption[i].l}`, `Adoption · ${d.adoption[i].l}`))} />
      </Sec>
      <Sec t="Web vs mobile">
        <Donut f={v => num(v)} data={[{ l: 'Web', v: d.web_mobile.web, c: PAL[0] }, { l: 'Mobile app', v: d.web_mobile.mobile, c: PAL[2] }]} onPick={i => open(drill('logins', `mobile:${i}`, i ? 'Mobile app sign-ins · 7 d' : 'Web sign-ins · 7 d'))} />
      </Sec>
    </div>

    <div className="bw-g g2 mb">
      <Sec t="Needs attention · security signals" flush act={<a onClick={() => open(drill('signals', 'all', 'Security signals · 14 days'))}>All</a>}>
        {d.signals.length ? <div className="bw-list">{d.signals.map((s, i) => <div key={i}>
          <span className="min-w-0 flex-1"><b>{s.user}</b> · {s.kind}<br /><small style={{ color: C.mu }}>{fdt(s.date)} · {s.detail}{s.ip ? ` · ${s.ip}` : ''}</small></span>
          <Pill t={s.severity === 'high' ? 'ba' : 'wa'}>{s.severity === 'high' ? 'Blocked' : 'Review'}</Pill>
        </div>)}</div> : <Empty>No suspicious activity</Empty>}
      </Sec>
      <Sec t="Inactive users · no login in 14 days" flush>
        {d.inactive.length ? <div className="bw-list">{d.inactive.map(u => <div key={u.id}>
          <Avatar name={u.name} size={24} />
          <span className="min-w-0 flex-1"><b>{u.name}</b><br /><small style={{ color: C.mu }}>{u.role}{u.last_login ? ` · last seen ${fdt(u.last_login)}` : ' · never signed in'}</small></span>
          <Btn s disabled={reminded.has(u.id)} onClick={() => remind(u)}>{reminded.has(u.id) ? 'Reminded' : 'Remind'}</Btn>
        </div>)}</div> : <Empty>Everyone has logged in recently</Empty>}
      </Sec>
    </div>

    <Sec t="Login history" flush>
      <RecordGrid framed={false} period={period} spec={{ title: 'Login history', source: 'logins', filter: 'all', cols: COLS.logins }} />
    </Sec>
  </>
}
