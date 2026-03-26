'use client'

import { useCallback, useMemo, useState } from 'react'
import { PanelFrame } from '@/components/PanelFrame'
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

function highlightJSON(value: unknown): string {
  const str = JSON.stringify(value, null, 2)
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
    } catch (error) {
      setStatus(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`)
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
      } catch (error) {
        setStatus(`Parse error: ${error instanceof Error ? error.message : String(error)}`)
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

    return [
      { label: 'Resources', value: `${entries.length}` },
      { label: 'Types', value: `${Object.keys(typeCounts).length}` },
      { label: 'Lot concepts', value: `${lotCodes}` },
      { label: 'Source', value: lastLoadedLabel ?? 'Not loaded' },
    ]
  }, [entries, lastLoadedLabel, typeCounts])

  return (
    <section className="explorer-workstation">
      <div className="section-inner explorer-workstation-inner">
        <div className="explorer-control-bar">
          <div className="explorer-control-actions">
            <button onClick={loadRemote} disabled={loading} className="explorer-action explorer-action-primary">
              {loading ? 'Loading...' : 'Fetch NVC API'}
            </button>
            <button onClick={loadLocal} disabled={loading} className="explorer-action explorer-action-secondary">
              Load Local JSON
            </button>
          </div>
          <p className="explorer-status" aria-live="polite">{status}</p>
        </div>

        <PanelFrame tone="utility" eyebrow="Parser" title="Barcode parse and lot check" className="explorer-parser-frame">
          <div className="explorer-parser-layout">
            <div className="explorer-parser-inputs">
              <label className="sr-only" htmlFor="barcode-input">Barcode input</label>
              <textarea
                id="barcode-input"
                className="explorer-textarea"
                rows={3}
                placeholder="Paste scanned barcode payload here..."
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleParse()
                }}
              />
              <div className="explorer-parser-actions">
                <button onClick={handleParse} className="explorer-action explorer-action-primary">Parse</button>
                <button
                  onClick={() => {
                    setBarcode('')
                    setParsed(null)
                    setLotResult(undefined)
                  }}
                  className="explorer-action explorer-action-secondary"
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="explorer-parse-readout">
              {parsed ? (
                <div className="explorer-parse-grid">
                  {(Object.entries(FIELD_LABELS) as [ParseField, string][]).map(([key, label]) =>
                    parsed[key] ? (
                      <div key={key} className="explorer-data-tile">
                        <span>{label}</span>
                        <strong>{parsed[key]}</strong>
                      </div>
                    ) : null,
                  )}
                  {lotResult !== undefined ? (
                    <div className={`explorer-data-tile explorer-data-tile-wide${lotResult ? '' : ' explorer-data-tile-warning'}`}>
                      <span>NVC Lot Match</span>
                      <strong>{lotResult ?? 'No match in the loaded bundle.'}</strong>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="explorer-empty-copy">Paste a barcode and run Parse to inspect the AI fields before chart entry.</p>
              )}
            </div>
          </div>
        </PanelFrame>

        {entries.length > 0 ? (
          <>
            <div className="explorer-summary-strip">
              {datasetSummary.map((item) => (
                <div key={item.label} className="explorer-summary-card">
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>

            <div className="explorer-filter-rack">
              <div className="explorer-type-filter">
                {Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                  <button
                    key={type}
                    onClick={() => {
                      setTypeFilter(typeFilter === type ? '' : type)
                      setPage(0)
                    }}
                    className={`explorer-type-chip${typeFilter === type ? ' explorer-type-chip-active' : ''}`}
                  >
                    {type}
                    <span>{count}</span>
                  </button>
                ))}
              </div>

              <div className="explorer-search-rack">
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
                  className="explorer-search-input"
                />
                <select
                  value={typeFilter}
                  onChange={(e) => {
                    setTypeFilter(e.target.value)
                    setPage(0)
                  }}
                  className="explorer-select"
                >
                  {resourceTypes.map((type) => (
                    <option key={type} value={type}>{type || 'All Types'}</option>
                  ))}
                </select>
              </div>
            </div>

            {filtered.length === 0 ? (
              <PanelFrame tone="reference" eyebrow="Empty state" title="No matching resources" className="explorer-empty-panel">
                <p>Adjust the search text or remove the current type filter to bring resources back into view.</p>
              </PanelFrame>
            ) : (
              <div className="explorer-main-grid">
                <PanelFrame tone="utility" eyebrow="Resource table" title={`${filtered.length} matching resources`} className="explorer-table-panel">
                  <div className="explorer-table-scroll">
                    <table className="explorer-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Type</th>
                          <th>Name</th>
                          <th>Status</th>
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
                              className={isSelected ? 'explorer-row-active' : ''}
                            >
                              <td>{globalIndex}</td>
                              <td><span className="explorer-row-type">{resource.resourceType}</span></td>
                              <td>{primaryLabel(resource)}</td>
                              <td>{resource.status ?? ''}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  {totalPages > 1 ? (
                    <div className="explorer-pagination">
                      <button
                        onClick={() => setPage((current) => Math.max(0, current - 1))}
                        disabled={page === 0}
                        className="explorer-action explorer-action-secondary"
                      >
                        Prev
                      </button>
                      <span>{page + 1} / {totalPages}</span>
                      <button
                        onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
                        disabled={page === totalPages - 1}
                        className="explorer-action explorer-action-secondary"
                      >
                        Next
                      </button>
                    </div>
                  ) : null}
                </PanelFrame>

                <PanelFrame tone="reference" eyebrow="Detail view" title={selected ? primaryLabel(selected) : 'Select a resource'} className="explorer-detail-panel">
                  {selected ? (
                    <>
                      <div className="explorer-detail-meta">
                        {[
                          ['ID', selected.id],
                          ['URL', selected.url],
                          ['Status', selected.status],
                        ].filter(([, value]) => value).map(([label, value]) => (
                          <div key={label} className="explorer-detail-row">
                            <span>{label}</span>
                            <strong>{value as string}</strong>
                          </div>
                        ))}
                      </div>
                      <pre
                        className="explorer-json-view"
                        dangerouslySetInnerHTML={{ __html: highlightJSON(selected) }}
                      />
                    </>
                  ) : (
                    <p className="explorer-empty-copy">Select a row to inspect the resource JSON.</p>
                  )}
                </PanelFrame>
              </div>
            )}
          </>
        ) : !loading ? (
          <PanelFrame tone="reference" eyebrow="Empty state" title="No bundle loaded yet" className="explorer-empty-panel">
            <p>Fetch the remote NVC bundle or load a local JSON snapshot to start browsing FHIR resources and checking lot matches.</p>
          </PanelFrame>
        ) : null}
      </div>
    </section>
  )
}
