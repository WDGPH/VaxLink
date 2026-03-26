import { DiagnosticShell } from '@/components/DiagnosticShell'
import { FHIRExplorer } from '@/components/FHIRExplorer'
import { explorerMetadata } from '@/content/site'

export const metadata = explorerMetadata

export default function ExplorerPage() {
  return (
    <div className="pt-16 explorer-page-shell">
      <section className="mode-page-hero mode-page-explorer">
        <div className="section-inner">
          <DiagnosticShell
            label="Lookup Mode"
            title="Bundle check, barcode parse, and resource inspection"
            aside={<span className="hero-version-pill">NVC FHIR</span>}
          >
            <div className="explorer-hero-grid">
              <p>
                Use the explorer to fetch the National Vaccine Catalogue bundle, inspect FHIR resources,
                parse GS1 barcodes, and confirm what is in the current data before you rely on a lot match.
              </p>
              <div className="quickstart-strip">
                <div className="quickstart-step"><span>1</span>Fetch the NVC bundle</div>
                <div className="quickstart-step"><span>2</span>Paste the barcode</div>
                <div className="quickstart-step"><span>3</span>Check the lot match or inspect resources</div>
              </div>
            </div>
          </DiagnosticShell>
        </div>
      </section>

      <FHIRExplorer />
    </div>
  )
}
