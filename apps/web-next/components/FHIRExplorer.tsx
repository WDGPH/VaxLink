'use client'

import { useCallback, useMemo, useState } from 'react'
import { trackSiteEvent } from '@/lib/analytics'
import { parseGS1, FIELD_LABELS, type ParsedGS1, type ParseField } from '@/lib/gs1'

const NVC_API = 'https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC'
const PAGE_SIZE = 50

interface FHIRResource {
  resourceType: string
  id?: string
  name?: string
  title?: string
  url?: string
  status?: string
  description?: string
  concept?: unknown[]
  [key: string]: unknown
}

interface BundleEntry {
  resource: FHIRResource
}

interface FHIRBundle {
  resourceType: 'Bundle'
  entry?: BundleEntry[]
}

function highlightJSON(val: unknown): string {
  const str = JSON.stringify(val, null, 2)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  return str.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      if (/^"/.test(match)) {
        return /:$/.test(match)
          ? `<span class="json-key">${match}</span>`
          : `<span class="json-str">${match}</span>`
      }
      if (/true|false/.test(match)) return `<span class="json-bool">${match}</span>`
      if (/null/.test(match)) return `<span class="json-null">${match}</span>`
      return `<span class="json-num">${match}</span>`
    },
  )
}

function lookupLot(entries: BundleEntry[], lot: string): string | null {
  for (const { resource } of entries) {
    if (resource.resourceType !== 'CodeSystem') continue
    const concepts = resource.concept as Array<{ code?: string; display?: string }> | undefined
    if (!concepts) continue
    for (const concept of concepts) {
      if (concept.code === lot || concept.display?.toLowerCase().includes(lot.toLowerCase())) {
        return concept.display ?? concept.code ?? null
      }
    }
  }
  return null
}

function primaryLabel(resource: FHIRResource): string {
  return resource.name ?? resource.title ?? resource.id ?? 'Untitled resource'
}

export function FHIRExplorer() {
  const [bundle, setBundle] = useState<FHIRBundle | null>(null)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('Ready - load a bundle to begin.')
  const [selected, setSelected] = useState<FHIRResource | null>(null)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [page, setPage] = useState(0)
  const [barcode, setBarcode] = useState('')
  const [parsed, setParsed] = useState<ParsedGS1 | null>(null)
  const [lotResult, setLotResult] = useState<string | null | undefined>(undefined)
  const [loadSource, setLoadSource] = useState<'remote' | 'local' | null>(null)
  const [lastLoadedLabel, setLastLoadedLabel] = useState<string | null>(null)

  const entries = bundle?.entry ?? []

  const loadRemote = useCallback(async () => {
    setLoading(true)
    setStatus('Fetching from NVC API...')
    trackSiteEvent({ name: 'explorer_load_remote' })
    try {
      const res = await fetch(NVC_API)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: FHIRBundle = await res.json()
      setBundle(data)
      setSelected(data.entry?.[0]?.resource ?? null)
      setLoadSource('remote')
      setLastLoadedLabel('Remote NVC API')
      setStatus(`Loaded ${data.entry?.length ?? 0} resources from the NVC API.`)
    } catch (e) {
      setStatus(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadLocal = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      setLoading(true)
      setStatus(`Loading ${file.name}...`)
      trackSiteEvent({ name: 'explorer_load_local' })
      try {
        const text = await file.text()
        const data: FHIRBundle = JSON.parse(text)
        setBundle(data)
        setSelected(data.entry?.[0]?.resource ?? null)
        setLoadSource('local')
        setLastLoadedLabel(file.name)
        setStatus(`Loaded ${data.entry?.length ?? 0} resources from ${file.name}.`)
      } catch (e) {
        setStatus(`Parse error: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setLoading(false)
      }
    }
    input.click()
  }, [])

  const handleParse = useCallback(() => {
    if (!barcode.trim()) return
    trackSiteEvent({ name: 'barcode_parse' })
    const result = parseGS1(barcode)
    setParsed(result)
    if (result.lot && bundle?.entry) {
      setLotResult(lookupLot(bundle.entry, result.lot))
      return
    }
    setLotResult(undefined)
  }, [barcode, bundle])

  const resourceTypes = useMemo(() => {
    const types = new Set(entries.map((entry) => entry.resource.resourceType))
    return ['', ...Array.from(types).sort()]
  }, [entries])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return entries.filter(({ resource }) => {
      if (typeFilter && resource.resourceType !== typeFilter) return false
      if (!q) return true
      return (
        resource.id?.toLowerCase().includes(q) ||
        resource.name?.toLowerCase().includes(q) ||
        resource.title?.toLowerCase().includes(q) ||
        resource.url?.toLowerCase().includes(q) ||
        resource.resourceType.toLowerCase().includes(q)
      )
    })
  }, [entries, search, typeFilter])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    entries.forEach(({ resource }) => {
      counts[resource.resourceType] = (counts[resource.resourceType] ?? 0) + 1
    })
    return counts
  }, [entries])

  const datasetSummary = useMemo(() => {
    const lotCodes = entries.reduce((sum, { resource }) => {
      if (resource.resourceType !== 'CodeSystem') return sum
      const concepts = resource.concept as unknown[] | undefined
      return sum + (concepts?.length ?? 0)
    }, 0)

    return {
      totalResources: entries.length,
      resourceTypes: Object.keys(typeCounts).length,
      lotCodes,
    }
  }, [entries, typeCounts])

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <div className="border-b border-slate-200 bg-white sticky top-16 z-40">
        <div className="section-inner py-3 flex flex-wrap items-center gap-3">
          <button
            onClick={loadRemote}
            disabled={loading}
            className="text-xs font-semibold px-4 py-2 rounded-lg text-white disabled:opacity-50 transition-colors"
            style={{ background: 'linear-gradient(135deg,#3b82f6,#2563eb)' }}
          >
            {loading ? 'Loading...' : 'Fetch from NVC API'}
          </button>
          <button
            onClick={loadLocal}
            disabled={loading}
            className="text-xs font-semibold px-4 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 disabled:opacity-50 transition-colors"
          >
            Load Local File
          </button>
          <span className="font-mono text-xs text-slate-400 ml-auto" aria-live="polite">{status}</span>
        </div>
      </div>

      <div className="section-inner py-8 space-y-6">
        <section
          className="rounded-2xl border p-5"
          style={{ borderColor: 'rgba(37,99,235,0.25)', background: 'rgba(37,99,235,0.04)' }}
        >
          <h2 className="font-sora font-semibold text-slate-800 mb-1">Barcode / AI Parser</h2>
          <p className="text-xs text-slate-500 mb-3">
            Supports <code className="font-mono bg-slate-100 px-1 rounded">(01)...(17)...(10)...</code>,
            compact GS1, and text labels like <code className="font-mono bg-slate-100 px-1 rounded">LOT:</code>{' '}
            <code className="font-mono bg-slate-100 px-1 rounded">EXP:</code>{' '}
            <code className="font-mono bg-slate-100 px-1 rounded">DIN:</code>
          </p>
          <label className="sr-only" htmlFor="barcode-input">Barcode input</label>
          <div className="flex flex-col sm:flex-row gap-3">
            <textarea
              id="barcode-input"
              className="flex-1 rounded-xl border border-slate-200 p-3 font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-400/50 focus:border-blue-400"
              rows={2}
              placeholder="Paste scanned barcode payload here..."
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleParse() }}
            />
            <div className="flex sm:flex-col gap-2">
              <button
                onClick={handleParse}
                className="flex-1 sm:flex-none px-5 py-2 rounded-xl text-sm font-semibold text-white"
                style={{ background: 'linear-gradient(135deg,#3b82f6,#2563eb)' }}
              >
                Parse
              </button>
              <button
                onClick={() => {
                  setBarcode('')
                  setParsed(null)
                  setLotResult(undefined)
                }}
                className="flex-1 sm:flex-none px-5 py-2 rounded-xl text-sm border border-slate-200 text-slate-500 hover:bg-slate-50"
              >
                Clear
              </button>
            </div>
          </div>

          {parsed ? (
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {(Object.entries(FIELD_LABELS) as [ParseField, string][]).map(([key, label]) =>
                parsed[key] ? (
                  <div
                    key={key}
                    className="rounded-xl border p-3"
                    style={{ borderColor: 'rgba(37,99,235,0.25)', background: 'rgba(37,99,235,0.06)' }}
                  >
                    <p className="font-mono text-[10px] text-blue-600/70 uppercase tracking-wide mb-1">{label}</p>
                    <p className="font-mono text-sm text-slate-800 font-medium break-all">{parsed[key]}</p>
                  </div>
                ) : null,
              )}
              {lotResult !== undefined ? (
                <div
                  className="rounded-xl border p-3 col-span-2"
                  style={{
                    borderColor: lotResult ? 'rgba(37,99,235,0.4)' : 'rgba(239,68,68,0.25)',
                    background: lotResult ? 'rgba(37,99,235,0.08)' : 'rgba(239,68,68,0.05)',
                  }}
                >
                  <p className="font-mono text-[10px] text-blue-600/70 uppercase tracking-wide mb-1">NVC Lot Match</p>
                  <p className="text-sm text-slate-800 font-medium">
                    {lotResult ?? <span className="text-slate-400 italic">No match in the loaded bundle. Use the resource browser to confirm the current source data.</span>}
                  </p>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">Paste a barcode and run Parse to inspect AI fields before charting.</p>
          )}
        </section>

        {entries.length > 0 ? (
          <>
            <div className="compatibility-notes mt-0">
              <div className="note-card">
                <h3>Total resources</h3>
                <p>{datasetSummary.totalResources} resources loaded from {lastLoadedLabel ?? 'unknown source'}.</p>
              </div>
              <div className="note-card">
                <h3>Resource types</h3>
                <p>{datasetSummary.resourceTypes} distinct FHIR resource types in the current bundle.</p>
              </div>
              <div className="note-card">
                <h3>Lot concepts</h3>
                <p>{datasetSummary.lotCodes} CodeSystem concepts available for lot verification. Source: {loadSource ?? 'not set'}.</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                <button
                  key={type}
                  onClick={() => {
                    setTypeFilter(typeFilter === type ? '' : type)
                    setPage(0)
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                    typeFilter === type
                      ? 'border-blue-400 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-blue-200'
                  }`}
                >
                  {type}
                  <span className="font-mono text-[10px] opacity-60">{count}</span>
                </button>
              ))}
            </div>

            <div className="flex flex-wrap gap-3 items-center">
              <label className="sr-only" htmlFor="resource-search">Search resources</label>
              <input
                id="resource-search"
                type="text"
                placeholder="Search id, name, url, or resource type..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(0)
                }}
                className="flex-1 min-w-48 rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/50 focus:border-blue-400 bg-white"
              />
              <select
                value={typeFilter}
                onChange={(e) => {
                  setTypeFilter(e.target.value)
                  setPage(0)
                }}
                className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/50 bg-white"
              >
                {resourceTypes.map((type) => (
                  <option key={type} value={type}>{type || 'All Types'}</option>
                ))}
              </select>
              <span className="font-mono text-xs text-slate-400">{filtered.length} resources</span>
            </div>

            {filtered.length === 0 ? (
              <div className="note-card">
                <h3>No matching resources</h3>
                <p>Adjust the search text or remove the current type filter to bring resources back into view.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
                <div className="lg:col-span-3">
                  <div className="rounded-2xl border border-slate-200 overflow-hidden bg-white">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-slate-100 bg-slate-50">
                            {['#', 'Type', 'Name', 'Status'].map((heading) => (
                              <th key={heading} className="text-left px-4 py-3 font-mono text-[11px] text-slate-400 uppercase tracking-wider font-medium">
                                {heading}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {paged.map(({ resource }, index) => {
                            const globalIndex = page * PAGE_SIZE + index + 1
                            const isSelected = selected === resource
                            return (
                              <tr
                                key={resource.id ?? `${resource.resourceType}-${globalIndex}`}
                                onClick={() => setSelected(resource)}
                                className={`border-b border-slate-50 cursor-pointer transition-colors ${
                                  isSelected ? 'bg-blue-50 border-blue-100' : 'hover:bg-slate-50'
                                }`}
                              >
                                <td className="px-4 py-3 font-mono text-xs text-slate-400">{globalIndex}</td>
                                <td className="px-4 py-3">
                                  <span
                                    className="inline-block rounded-md px-2 py-0.5 font-mono text-[10px] font-medium"
                                    style={{
                                      background: isSelected ? 'rgba(37,99,235,0.12)' : 'rgba(15,23,42,0.05)',
                                      color: isSelected ? '#2563eb' : '#64748b',
                                    }}
                                  >
                                    {resource.resourceType}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-slate-700 max-w-xs truncate">{primaryLabel(resource)}</td>
                                <td className="px-4 py-3">
                                  {resource.status ? (
                                    <span className={`font-mono text-[10px] ${resource.status === 'active' ? 'text-green-600' : 'text-slate-400'}`}>
                                      {resource.status}
                                    </span>
                                  ) : null}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>

                    {totalPages > 1 ? (
                      <div className="border-t border-slate-100 px-4 py-3 flex items-center justify-between">
                        <button
                          onClick={() => setPage((current) => Math.max(0, current - 1))}
                          disabled={page === 0}
                          className="text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-200 disabled:opacity-30 hover:bg-slate-50"
                        >
                          ← Prev
                        </button>
                        <span className="font-mono text-xs text-slate-400">
                          {page + 1} / {totalPages}
                        </span>
                        <button
                          onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
                          disabled={page === totalPages - 1}
                          className="text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-200 disabled:opacity-30 hover:bg-slate-50"
                        >
                          Next →
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="lg:col-span-2">
                  <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden sticky top-32">
                    <div className="border-b border-slate-100 px-4 py-3 flex items-center justify-between">
                      <h3 className="font-sora font-semibold text-slate-800 text-sm">
                        {selected ? primaryLabel(selected) : 'Select a resource'}
                      </h3>
                      {selected ? (
                        <span
                          className="font-mono text-[10px] rounded-md px-2 py-0.5"
                          style={{ background: 'rgba(37,99,235,0.1)', color: '#2563eb' }}
                        >
                          {selected.resourceType}
                        </span>
                      ) : null}
                    </div>

                    {selected ? (
                      <>
                        <div className="px-4 py-3 border-b border-slate-100 space-y-1.5">
                          {[
                            ['ID', selected.id],
                            ['URL', selected.url],
                            ['Status', selected.status],
                          ].filter(([, value]) => value).map(([label, value]) => (
                            <div key={label} className="flex gap-3 text-xs">
                              <span className="font-mono text-slate-400 w-12 shrink-0">{label}</span>
                              <span className="text-slate-600 break-all">{value as string}</span>
                            </div>
                          ))}
                        </div>

                        <pre
                          className="p-4 text-[11px] leading-relaxed overflow-auto font-mono"
                          style={{
                            background: '#0f172a',
                            color: '#cbd5e1',
                            maxHeight: '480px',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                          }}
                          dangerouslySetInnerHTML={{ __html: highlightJSON(selected) }}
                        />
                      </>
                    ) : (
                      <div className="px-4 py-12 text-center">
                        <p className="text-sm text-slate-400">Select a row to inspect full resource JSON and verify the source payload.</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : !loading ? (
          <div className="note-card">
            <h3>No bundle loaded yet</h3>
            <p>Fetch the remote NVC bundle or load a local JSON snapshot to begin browsing FHIR resources and validating lot matches.</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
