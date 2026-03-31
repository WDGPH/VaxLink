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

const BARCODE_MODULE = 4
const BARCODE_QUIET_ZONE = 24
const BARCODE_HEIGHT = 92
const BARCODE_BAR_TOP = 8
const BARCODE_BAR_HEIGHT = 58
const BARCODE_LABEL = '(01)00381370007577  (10)2024B-LOT12  (17)202606'

const BARCODE_VIEWBOX_WIDTH = BAR_PATTERN.reduce(
  (sum, units) => sum + (units * BARCODE_MODULE),
  BARCODE_QUIET_ZONE * 2,
)

const barcodeRects: Array<{ x: number; width: number; height: number }> = []

let barcodeCursor = BARCODE_QUIET_ZONE
BAR_PATTERN.forEach((units, index) => {
  const width = units * BARCODE_MODULE

  if (index % 2 === 0) {
    barcodeRects.push({
      x: barcodeCursor,
      width,
      height: index % 7 === 0 ? BARCODE_BAR_HEIGHT + 10 : BARCODE_BAR_HEIGHT,
    })
  }

  barcodeCursor += width
})

export function BarcodeViz() {
  return (
    <div className="barcode-viz-shell animate-float" style={{ animationDelay: '0.3s' }}>
      <div className="barcode-viz-frame">
        <div className="barcode-viz-head">
          <p>GS1-128</p>
          <span>scanner read</span>
        </div>

        <div
          className="barcode-viz-bars"
          aria-hidden="true"
        >
          <svg
            className="barcode-viz-svg"
            viewBox={`0 0 ${BARCODE_VIEWBOX_WIDTH} ${BARCODE_HEIGHT}`}
            role="presentation"
          >
            {barcodeRects.map((bar, index) => (
              <rect
                key={`${bar.x}-${bar.width}`}
                x={bar.x}
                y={BARCODE_BAR_TOP}
                width={bar.width}
                height={bar.height}
                rx="1"
                fill={index % 6 === 0 ? '#f4ffff' : '#d7f0f0'}
                opacity={index % 5 === 0 ? 1 : 0.92}
              />
            ))}
            <text
              x={BARCODE_VIEWBOX_WIDTH / 2}
              y={BARCODE_HEIGHT - 10}
              fill="rgba(236,247,247,0.52)"
              fontFamily="IBM Plex Mono, monospace"
              fontSize="8.5"
              letterSpacing="1.1"
              textAnchor="middle"
            >
              {BARCODE_LABEL}
            </text>
          </svg>
          <div className="barcode-viz-scan" />
          <div className="barcode-beam" />
        </div>

        <div className="barcode-viz-fields">
          {DECODED_FIELDS.map(({ ai, value, delay }) => (
            <div
              key={ai}
              className="barcode-viz-row opacity-0 animate-fieldReveal"
              style={{ animationDelay: delay, animationFillMode: 'forwards' }}
            >
              <span>{ai}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>

        <div className="barcode-viz-foot">
          <span className="barcode-viz-dot" />
          <span>NVC match found · 1 lot resolved</span>
        </div>
      </div>

      <div className="barcode-viz-glow" />
    </div>
  )
}
