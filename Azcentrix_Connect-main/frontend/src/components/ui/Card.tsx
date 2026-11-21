import React from 'react'

interface CardProps {
  children: React.ReactNode
  className?: string
  padding?: boolean
  hover?: boolean
}

export function Card({ children, className = '', padding = false, hover = true }: CardProps) {
  return (
    <div className={`card${hover ? '' : ' !shadow-none hover:!shadow-none'} ${className}`}>
      {padding ? <div className="card-body">{children}</div> : children}
    </div>
  )
}

interface CardHeaderProps {
  title: React.ReactNode
  subtitle?: string
  actions?: React.ReactNode
  icon?: React.ReactNode
}

export function CardHeader({ title, subtitle, actions, icon }: CardHeaderProps) {
  return (
    <div className="card-header">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {icon && (
            <div className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ background: 'var(--surface-2)' }}>
              {icon}
            </div>
          )}
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {title}
            </h3>
            {subtitle && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>
            )}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}

interface StatCardProps {
  label: string
  value: string | number
  icon?: React.ReactNode
  trend?: { value: number; label: string }
  color?: string
  onClick?: () => void
}

export function StatCard({ label, value, icon, trend, color = 'var(--primary)', onClick }: StatCardProps) {
  return (
    <div className="stat-card" onClick={onClick} style={{ cursor: onClick ? 'pointer' : undefined }}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>{label}</p>
          <p className="text-2xl font-bold font-display" style={{ color: 'var(--text-primary)' }}>
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>
          {trend && (
            <p className={`text-xs mt-1.5 font-medium ${trend.value >= 0 ? 'text-green-600' : 'text-red-500'}`}>
              {trend.value >= 0 ? '↑' : '↓'} {Math.abs(trend.value)}% {trend.label}
            </p>
          )}
        </div>
        {icon && (
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: `${color}15`, color }}>
            {icon}
          </div>
        )}
      </div>
    </div>
  )
}
export default Card
