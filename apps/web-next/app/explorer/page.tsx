import { FHIRExplorer } from '@/components/FHIRExplorer'
import { SectionHeader } from '@/components/SectionHeader'
import { explorerMetadata } from '@/content/site'

export const metadata = explorerMetadata

export default function ExplorerPage() {
  return (
    <div className="pt-16">
      <div className="border-b border-slate-200 bg-white" style={{ paddingTop: '0.1px' }}>
        <div className="section-inner py-10">
          <SectionHeader
            eyebrow="Explorer"
            title="Verify source data before trusting the lot match"
            body="Use the explorer to fetch the National Vaccine Catalogue bundle, inspect FHIR resources, parse GS1 barcodes, and confirm whether a lot match is coming from the current source of truth."
          />
          <div className="quickstart-strip">
            <div className="quickstart-step"><span>1</span> Fetch the NVC bundle</div>
            <div className="quickstart-step"><span>2</span> Paste the barcode</div>
            <div className="quickstart-step"><span>3</span> Inspect the lot match or browse resources</div>
          </div>
          <div className="explorer-purpose">
            <h3>When to use the explorer</h3>
            <ul>
              <li>Verify source catalogue data before trusting an autofill result.</li>
              <li>Troubleshoot odd barcodes or no-match scenarios.</li>
              <li>Inspect resource details before changing extension behavior.</li>
            </ul>
          </div>
        </div>
      </div>

      <FHIRExplorer />
    </div>
  )
}
