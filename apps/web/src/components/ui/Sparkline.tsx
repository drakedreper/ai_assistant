/** Tiny inline SVG line chart. No axes; for trends in tiles. */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  color = 'var(--color-fg)',
  fill = true,
}: {
  values: number[]
  width?: number
  height?: number
  color?: string
  fill?: boolean
}) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pad = 2
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2)
    const y = height - pad - ((v - min) / span) * (height - pad * 2)
    return [x, y] as const
  })
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${(width - pad).toFixed(1)},${height} L${pad},${height} Z`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      {fill && <path d={area} fill={color} opacity={0.14} />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
