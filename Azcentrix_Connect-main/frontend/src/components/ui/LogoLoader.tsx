import { InfinityLogoMark } from './LogoWriteLoader'

type LogoLoaderProps = {
  fullScreen?: boolean
  className?: string
}

export default function LogoLoader({ fullScreen = false, className = '' }: LogoLoaderProps) {
  return (
    <div
      className={[
        'az-loader',
        fullScreen ? 'az-loader--fullscreen' : 'az-loader--inline',
        className,
      ].join(' ')}
      role="status"
      aria-live="polite"
      aria-label="Loading"
    >
      <InfinityLogoMark />
      <span className="sr-only">Loading</span>
    </div>
  )
}
