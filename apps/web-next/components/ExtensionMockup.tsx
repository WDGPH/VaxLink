/**
 * Full-size CSS representation of the VaxLink Chrome extension popup.
 * Used on the /extension page to show users what they're installing.
 */

const FIELDS = [
  { label: 'Trade Name',   value: 'Fluzone Quadrivalent',  color: 'text-slate-700' },
  { label: 'Manufacturer', value: 'Sanofi Pasteur',         color: 'text-slate-700' },
  { label: 'DIN',          value: '02484811',               color: 'text-blue-700 font-mono' },
  { label: 'Lot',          value: '2024B-LOT12',            color: 'text-blue-700 font-mono' },
  { label: 'Expiry',       value: '2026-06',                color: 'text-blue-700 font-mono' },
  { label: 'Route',        value: 'Intramuscular',          color: 'text-slate-700' },
]

export function ExtensionMockup() {
  return (
    <div
      className="w-full max-w-sm mx-auto rounded-2xl overflow-hidden shadow-2xl border"
      style={{ borderColor: 'rgba(37,99,235,0.3)', background: '#0f172a' }}
    >
      {/* Header */}
      <div
        className="px-5 py-4 border-b flex items-center justify-between"
        style={{
          borderColor: 'rgba(37,99,235,0.2)',
          background: 'linear-gradient(135deg, rgba(37,99,235,0.15), rgba(37,99,235,0.05))',
        }}
      >
        <div>
          <p className="font-sora font-extrabold text-white text-base tracking-tight">
            Vax<span className="text-blue-400">Link</span>
          </p>
          <p className="font-mono text-[10px] text-blue-400/60 mt-0.5 uppercase tracking-widest">
            NVC Vaccine Toolkit · v1.0.4
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          <span className="font-mono text-[10px] text-blue-400/60">NVC synced</span>
        </div>
      </div>

      {/* Scanner input */}
      <div className="px-5 py-4 border-b" style={{ borderColor: 'rgba(37,99,235,0.12)' }}>
        <label className="font-mono text-[10px] text-blue-400/60 uppercase tracking-widest block mb-2">
          Barcode Input
        </label>
        <div
          className="rounded-lg border px-3 py-2.5 font-mono text-xs text-blue-300/80 leading-relaxed"
          style={{ borderColor: 'rgba(37,99,235,0.25)', background: 'rgba(37,99,235,0.06)' }}
        >
          (01)00381370007577(17)260601(10)2024B-LOT12
        </div>
        <div className="flex gap-2 mt-3">
          <button
            className="flex-1 text-xs font-semibold py-2 rounded-lg text-white"
            style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)' }}
          >
            Parse
          </button>
          <button
            className="flex-1 text-xs font-semibold py-2 rounded-lg border"
            style={{ borderColor: 'rgba(37,99,235,0.25)', color: 'rgba(37,99,235,0.7)' }}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Resolved fields */}
      <div className="px-5 py-4 border-b" style={{ borderColor: 'rgba(37,99,235,0.12)' }}>
        <p className="font-mono text-[10px] text-blue-400/60 uppercase tracking-widest mb-3">
          Resolved from NVC
        </p>
        <div className="space-y-2">
          {FIELDS.map(({ label, value, color }) => (
            <div key={label} className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] text-white/30 shrink-0">{label}</span>
              <span className={`text-[11px] ${color} text-right`}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Auto-fill button */}
      <div className="px-5 py-4">
        <button
          className="w-full py-2.5 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-2"
          style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', boxShadow: '0 4px 12px rgba(245,158,11,0.25)' }}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          Auto-fill CHR Fields
        </button>
        <p className="font-mono text-[10px] text-white/25 text-center mt-2">
          Panorama · InputHealth
        </p>
      </div>
    </div>
  )
}
