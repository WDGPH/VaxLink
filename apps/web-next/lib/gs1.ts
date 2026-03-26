/** GS1 Application Identifier barcode parser for NVC vaccine data */

export interface ParsedGS1 {
  gtin?: string    // AI 01 — 14-digit GTIN
  lot?: string     // AI 10 — lot/batch number
  expiry?: string  // AI 17 — expiry date (formatted)
  serial?: string  // AI 21 — serial number
  din?: string     // text label DIN (non-standard, common in CA)
  raw: string
}

export type ParseField = Exclude<keyof ParsedGS1, 'raw'>

// AIs with fixed-length values (post-AI digits)
const FIXED: Record<string, number> = {
  '00': 18, '01': 14, '02': 14,
  '11': 6,  '12': 6,  '13': 6,
  '15': 6,  '16': 6,  '17': 6,
  '18': 6,  '19': 6,  '20': 2,
}

const FNC1 = '\x1d'

export function parseGS1(raw: string): ParsedGS1 {
  const result: ParsedGS1 = { raw }
  const input = raw.trim()

  // ── Parenthesized format: (01)12345...(17)260301(10)LOT ──
  if (input.includes('(')) {
    const re = /\((\d{2,4})\)([^(]+)/g
    let m: RegExpExecArray | null
    let matched = false
    while ((m = re.exec(input)) !== null) {
      applyAI(result, m[1], m[2].trim())
      matched = true
    }
    if (matched) return result
  }

  // ── Text label format: LOT: xxx  EXP: xxx  DIN: xxxxxxxx ──
  const textHints: Array<[RegExp, ParseField]> = [
    [/(?:LOT|BATCH|LOT#)[:\s]+([A-Z0-9\-]+)/i, 'lot'],
    [/(?:EXP|EXPIRY|EXP\.?\s*DATE)[:\s]+([0-9\/\-]+)/i, 'expiry'],
    [/(?:DIN)[:\s]+(\d{8})/i, 'din'],
    [/GTIN[:\s]+(\d{14})/i, 'gtin'],
  ]
  let textMatched = false
  for (const [re, field] of textHints) {
    const m = input.match(re)
    if (m) { result[field] = m[1]; textMatched = true }
  }
  if (textMatched) return result

  // ── Compact GS1 (no parentheses, may have FNC1 delimiters) ──
  parseCompact(input, result)
  return result
}

function parseCompact(input: string, out: ParsedGS1): void {
  const s = input.replace(/\s+/g, '')
  let pos = 0
  let safety = 0

  while (pos < s.length && safety++ < 40) {
    if (s[pos] === FNC1) { pos++; continue }

    let consumed = false
    for (const aiLen of [4, 3, 2]) {
      if (pos + aiLen > s.length) continue
      const ai = s.slice(pos, pos + aiLen)

      if (FIXED[ai] !== undefined) {
        const val = s.slice(pos + aiLen, pos + aiLen + FIXED[ai])
        if (val.length === FIXED[ai]) {
          applyAI(out, ai, val)
          pos += aiLen + FIXED[ai]
          consumed = true
          break
        }
      } else if (aiLen === 2 && (ai === '10' || ai === '21')) {
        const start = pos + 2
        const fnc = s.indexOf(FNC1, start)
        const val = fnc === -1 ? s.slice(start) : s.slice(start, fnc)
        applyAI(out, ai, val)
        pos = fnc === -1 ? s.length : fnc + 1
        consumed = true
        break
      }
    }
    if (!consumed) pos++ // skip unknown byte
  }
}

function applyAI(out: ParsedGS1, ai: string, value: string): void {
  switch (ai) {
    case '01': out.gtin   = value.slice(0, 14); break
    case '10': out.lot    = value.replace(/\x1d/g, ''); break
    case '17': out.expiry = formatExpiry(value); break
    case '21': out.serial = value.replace(/\x1d/g, ''); break
  }
}

function formatExpiry(yymmdd: string): string {
  if (yymmdd.length !== 6) return yymmdd
  const yy = parseInt(yymmdd.slice(0, 2), 10)
  const mm = yymmdd.slice(2, 4)
  const dd = yymmdd.slice(4, 6)
  const year = yy < 50 ? 2000 + yy : 1900 + yy
  return dd === '00' ? `${year}-${mm}` : `${year}-${mm}-${dd}`
}

/** Return a human-readable label for each field key */
export const FIELD_LABELS: Record<ParseField, string> = {
  gtin:   'GTIN (AI 01)',
  lot:    'Lot / Batch (AI 10)',
  expiry: 'Expiry (AI 17)',
  serial: 'Serial (AI 21)',
  din:    'DIN',
}
