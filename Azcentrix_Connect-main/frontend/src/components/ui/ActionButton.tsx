import React from 'react'
import './ActionButton.css'

type ActionButtonVariant = 'primary' | 'secondary' | 'ghost'

interface ActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ActionButtonVariant
  icon?: React.ReactNode
  children: React.ReactNode
}

export function ActionButton({
  variant = 'secondary',
  icon,
  children,
  className = '',
  type = 'button',
  ...props
}: ActionButtonProps) {
  return (
    <button
      type={type}
      className={`action-button action-button-${variant} ${className}`}
      {...props}
    >
      {icon && <span className="action-button-icon">{icon}</span>}
      <span>{children}</span>
    </button>
  )
}

export function ActionGroup({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return <div className={`action-group ${className}`}>{children}</div>
}

export default ActionButton
