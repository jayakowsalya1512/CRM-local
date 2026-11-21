import React from 'react'
import { ArrowUpDown } from 'lucide-react'

/**
 * Two-line table cell (e.g. "title" over "subtitle") where the user can swap
 * which line renders on top. Purely presentational — callers own persistence
 * of the `swapped` flag (e.g. per-user, per-table backend preference).
 */
type StackedCellNode = React.ReactNode | ((isTop: boolean) => React.ReactNode)

interface StackedCellProps {
  primary:    StackedCellNode
  secondary:  StackedCellNode
  swapped?:   boolean
  onToggle?:  () => void
  className?: string
}

function renderNode(node: StackedCellNode, isTop: boolean): React.ReactNode {
  return typeof node === 'function' ? node(isTop) : node
}

export default function StackedCell({ primary, secondary, swapped = false, onToggle, className = '' }: StackedCellProps) {
  const top    = swapped ? renderNode(secondary, true)  : renderNode(primary, true)
  const bottom = swapped ? renderNode(primary, false)   : renderNode(secondary, false)

  return (
    <div className={`group/stack relative min-w-0 ${className}`}>
      {onToggle && (
        <button
          type="button"
          title="Swap order"
          onClick={e => { e.stopPropagation(); onToggle() }}
          className="absolute -right-0.5 -top-0.5 z-10 rounded p-0.5 text-gray-300 opacity-0 transition-opacity hover:bg-blue-50 hover:text-blue-600 group-hover/stack:opacity-100"
        >
          <ArrowUpDown size={11} />
        </button>
      )}
      <div className="min-w-0 pr-3">{top}</div>
      <div className="min-w-0 pr-3">{bottom}</div>
    </div>
  )
}
