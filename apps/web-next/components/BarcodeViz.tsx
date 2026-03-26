'use client'

const BAR_PATTERN = [
  2,1, 1,1, 3,2, 1,1, 2,1, 1,2, 3,1,
  1,1, 2,1, 3,1, 1,2, 2,1, 1,1, 3,2,
  1,1, 2,2, 1,1, 3,1, 2,1, 1,2, 1,1,
  2,1, 3,1, 1,1, 2,2, 3,1, 1,1,
]

const DECODED_FIELDS = [
  { ai: 'AI 01', value: '00381370007577', delay: '0.6s' },
  { ai: 'AI 10', value: '2024B-LOT12',    delay: '0.85s' },
  { ai: 'AI 17', value: '2026-06',         delay: '1.1s' },
]

export function BarcodeViz() {
  return (
    <div className="relative animate-float" style={{ animationDelay: '0.3s' }}>
      <div
        className="rounded-2xl border border-hero-border bg-hero-surface p-6 shadow-2xl"
        style={{ width: 'clamp(240px, 34vw, 360px)' }}
      >
        <p className="font-mono text-[10px] text-blue-400/60 uppercase tracking-widest mb-3">
          GS1-128 · Scanning…
        </p>

        <div
          className="relative flex items-stretch overflow-hidden rounded-sm"
          style={{ height: '96px' }}
          aria-hidden="true"
        >
          {BAR_PATTERN.map((units, i) => (
            <div
              key={i}
              className={i % 2 === 0 ? 'flex-shrink-0 bg-white/88' : 'flex-shrink-0 bg-transparent'}
              style={{ width: `${units * 5}px` }}
            />
          ))}
          <div className="barcode-beam" />
          <div
            className="absolute inset-x-0 pointer-events-none"
            style={{
              height: '30px',
              background: 'linear-gradient(180deg, transparent, rgba(37,99,235,0.08), transparent)',
              animation: 'scanBeam 2.6s ease-in-out infinite',
              top: 0,
            }}
          />
        </div>

        <div className="mt-4 space-y-1.5 font-mono">
          {DECODED_FIELDS.map(({ ai, value, delay }) => (
            <div
              key={ai}
              className="flex items-center gap-2.5 opacity-0 animate-fieldReveal"
              style={{ animationDelay: delay, animationFillMode: 'forwards' }}
            >
              <span className="text-[10px] text-blue-400/70 uppercase tracking-widest w-12 shrink-0">
                {ai}
              </span>
              <span className="text-xs text-white/85 tracking-wide">{value}</span>
            </div>
          ))}
        </div>

        <div className="mt-4 pt-3 border-t border-hero-border flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          <span className="font-mono text-[10px] text-blue-400/70 uppercase tracking-widest">
            NVC match found · 1 lot resolved
          </span>
        </div>
      </div>

      <div
        className="absolute -inset-4 -z-10 rounded-3xl blur-2xl opacity-30"
        style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.4) 0%, transparent 70%)' }}
      />
    </div>
  )
}
