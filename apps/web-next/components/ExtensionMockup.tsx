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
    <div className="extension-mock-shell">
      <div className="extension-mock-head">
        <div>
          <p className="extension-mock-brand">
            Vax<span>Link</span>
          </p>
          <p className="extension-mock-meta">
            NVC Vaccine Toolkit · v1.0.4
          </p>
        </div>
        <div className="extension-sync-badge">
          <span className="extension-sync-dot" />
          <span>NVC synced</span>
        </div>
      </div>

      <div className="extension-mock-section">
        <label className="extension-mock-label">
          Barcode Input
        </label>
        <div className="extension-mock-input">
          (01)00381370007577(17)260601(10)2024B-LOT12
        </div>
        <div className="extension-mock-actions">
          <button className="extension-mock-primary">Parse</button>
          <button className="extension-mock-secondary">Clear</button>
        </div>
      </div>

      <div className="extension-mock-section">
        <p className="extension-mock-label">
          Resolved from NVC
        </p>
        <div className="extension-mock-fields">
          {FIELDS.map(({ label, value, color }) => (
            <div key={label} className="extension-mock-row">
              <span>{label}</span>
              <span className={color}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="extension-mock-section">
        <button className="extension-mock-fill">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          Auto-fill CHR Fields
        </button>
        <p className="extension-mock-foot">
          Panorama · InputHealth
        </p>
      </div>
    </div>
  )
}
