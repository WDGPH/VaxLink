import { ImageResponse } from 'next/og'

export const size = {
  width: 1200,
  height: 630,
}

export const contentType = 'image/png'

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '56px',
          background: 'linear-gradient(135deg, #0f172a, #172554 55%, #1d4ed8)',
          color: 'white',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.18)',
            padding: '10px 18px',
            fontSize: 28,
            color: '#bfdbfe',
          }}
        >
          VaxLink for Clinic Barcode Workflows
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ fontSize: 82, lineHeight: 1.02, fontWeight: 800, maxWidth: 860 }}>
            Scan vaccine barcodes. Fill CHR records with confidence.
          </div>
          <div style={{ fontSize: 34, lineHeight: 1.35, color: 'rgba(255,255,255,0.8)', maxWidth: 920 }}>
            NVC-backed lot resolution for Panorama and InputHealth, with explorer-based verification when workflows need review.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 18, fontSize: 28, color: '#dbeafe' }}>
          <span>Chrome Extension</span>
          <span>Panorama</span>
          <span>InputHealth</span>
          <span>NVC FHIR Explorer</span>
        </div>
      </div>
    ),
    size,
  )
}
