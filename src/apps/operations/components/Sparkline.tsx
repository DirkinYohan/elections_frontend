interface Props {
  values: number[]
  label: string
  color?: string
  height?: number
}

/** Tiny dependency-free line chart: last 2 minutes of one metric. */
export function Sparkline({ values, label, color = 'var(--accent)', height = 56 }: Props) {
  const width = 240
  const data = values.length ? values : [0]
  const max = Math.max(1, ...data)
  const step = data.length > 1 ? width / (data.length - 1) : width
  const points = data.map((v, i) => `${(i * step).toFixed(1)},${(height - 4 - (v / max) * (height - 8)).toFixed(1)}`)
  const area = `0,${height} ${points.join(' ')} ${((data.length - 1) * step).toFixed(1)},${height}`
  const last = data[data.length - 1]

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${label}: último ${last}, máximo ${max}`}>
      <polygon points={area} fill={color} opacity="0.12" />
      <polyline points={points.join(' ')} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
