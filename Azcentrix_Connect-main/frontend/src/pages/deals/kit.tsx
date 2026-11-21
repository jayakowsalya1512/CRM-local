// Small shared cells for Deals (prototype dueCell()).
import { dto, fd } from './dealApi'

export const DueCell = ({ d }: { d: string | null }) => {
  if (!d) return <>—</>
  const n = dto(d)
  return <span className={n < 0 ? 'tbad' : n <= 7 ? 'twarn' : ''}>{fd(d)} <small>{n < 0 ? `${-n}d ago` : n === 0 ? 'today' : `in ${n}d`}</small></span>
}
