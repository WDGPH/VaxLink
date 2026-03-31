export function TrustStrip({
  items,
  dark = false,
}: {
  items: string[]
  dark?: boolean
}) {
  return (
    <div className={`trust-strip ${dark ? 'trust-strip-dark' : ''}`}>
      {items.map((item) => (
        <span key={item} className="trust-chip">
          {item}
        </span>
      ))}
    </div>
  )
}
