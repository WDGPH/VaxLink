export function ConstructionBanner() {
  return (
    <div
      style={{ background: 'var(--accent-amber)' }}
      className="fixed top-0 inset-x-0 z-[60] h-9 flex items-center justify-center px-4"
    >
      <p className="text-xs font-medium text-[#13242f] text-center tracking-wide">
        <span className="font-semibold">VaxLink is currently in development.</span>
        {' '}Content is preliminary and subject to change.
      </p>
    </div>
  )
}
