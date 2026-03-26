export function MetricRow({
  items,
}: {
  items: Array<{ value: string; label: string }>
}) {
  return (
    <div className="metric-row">
      {items.map(({ value, label }) => (
        <div key={label} className="metric-card">
          <p className="metric-value">{value}</p>
          <p className="metric-label">{label}</p>
        </div>
      ))}
    </div>
  )
}
