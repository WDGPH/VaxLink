export function StatStrip({
  items,
  className,
}: {
  items: Array<{ value: string; label: string }>
  className?: string
}) {
  return (
    <div className={`stat-strip${className ? ` ${className}` : ''}`}>
      {items.map(({ value, label }) => (
        <div key={label} className="stat-segment">
          <p className="stat-value">{value}</p>
          <p className="stat-label">{label}</p>
        </div>
      ))}
    </div>
  )
}
