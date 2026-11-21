const INFINITY_PATH =
  'M38 66 C38 31 82 25 120 66 C158 107 202 101 202 66 C202 31 158 25 120 66 C82 107 38 101 38 66'

type InfinityLogoMarkProps = {
  className?: string
}

export function InfinityLogoMark({ className = '' }: InfinityLogoMarkProps) {
  return (
    <svg
      className={`az-infinity-logo ${className}`}
      viewBox="0 0 240 132"
      role="img"
      aria-label="DigitCRM infinity logo loading"
    >
      <defs>
        <path id="azInfinityPath" d={INFINITY_PATH} />
        <linearGradient id="azInfinityBase" x1="32" y1="104" x2="208" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2563eb" />
          <stop offset="36%" stopColor="#5b21b6" />
          <stop offset="68%" stopColor="#c026d3" />
          <stop offset="100%" stopColor="#ff2bd6" />
        </linearGradient>
        <linearGradient id="azInfinitySweep" x1="-240" y1="0" x2="0" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2563eb" stopOpacity="0" />
          <stop offset="28%" stopColor="#7c3aed" stopOpacity="0.3" />
          <stop offset="48%" stopColor="#ffffff" stopOpacity="0.92" />
          <stop offset="62%" stopColor="#ff2bd6" stopOpacity="0.72" />
          <stop offset="100%" stopColor="#2563eb" stopOpacity="0" />
          <animate attributeName="x1" values="-240;240;-240" dur="2.9s" repeatCount="indefinite" />
          <animate attributeName="x2" values="0;480;0" dur="2.9s" repeatCount="indefinite" />
        </linearGradient>
        <mask id="azInfinityStrokeMask" maskUnits="userSpaceOnUse">
          <rect width="240" height="132" fill="black" />
          <use
            href="#azInfinityPath"
            fill="none"
            stroke="white"
            strokeWidth="24"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </mask>
      </defs>

      <use
        href="#azInfinityPath"
        className="az-infinity-track"
        fill="none"
        pathLength={100}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <use
        href="#azInfinityPath"
        className="az-infinity-draw"
        fill="none"
        stroke="url(#azInfinityBase)"
        pathLength={100}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g mask="url(#azInfinityStrokeMask)">
        <rect className="az-infinity-gradient-sweep" x="-240" y="0" width="720" height="132" fill="url(#azInfinitySweep)" />
      </g>
      <use
        href="#azInfinityPath"
        className="az-infinity-highlight"
        fill="none"
        pathLength={100}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function LogoWriteLoader() {
  return (
    <div className="az-loader" role="status" aria-label="Loading">
      <InfinityLogoMark />
      <span className="sr-only">Loading</span>
    </div>
  )
}
