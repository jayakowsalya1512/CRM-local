import React from 'react'
import { Loader2 } from 'lucide-react'

type ButtonVariant = 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'ghost' | 'outline' | 'cancel'
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: React.ReactNode
  leftIcon?: React.ReactNode
  iconRight?: React.ReactNode
  children?: React.ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  leftIcon,
  iconRight,
  children,
  disabled,
  className = '',
  ...props
}: ButtonProps) {
  const sizeClass = size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : size === 'icon' ? 'btn-icon' : ''
  const variantClass = `btn-${variant}`
  const leadingIcon = icon ?? leftIcon

  return (
    <button
      className={`btn ${variantClass} ${sizeClass} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <Loader2 size={14} className="animate-spin flex-shrink-0" />
      ) : leadingIcon ? (
        <span className="flex-shrink-0">{leadingIcon}</span>
      ) : null}
      {children && <span>{children}</span>}
      {iconRight && !loading && <span className="flex-shrink-0">{iconRight}</span>}
    </button>
  )
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode
  label?: string
  variant?: ButtonVariant
  size?: 'sm' | 'md'
}

export function IconButton({ icon, label, variant = 'ghost', size = 'md', className = '', ...props }: IconButtonProps) {
  return (
    <button
      className={`btn btn-${variant} btn-icon ${size === 'sm' ? 'btn-sm' : ''} ${className}`}
      title={label}
      {...props}
    >
      {icon}
    </button>
  )
}

export default Button
