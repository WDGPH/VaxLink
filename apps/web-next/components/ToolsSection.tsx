import { CompatibilitySection } from '@/components/CompatibilitySection'
import { ModeSwitcher } from '@/components/ModeSwitcher'
import { PanelFrame } from '@/components/PanelFrame'
import { SectionHeader } from '@/components/SectionHeader'

function ExplorerPreview() {
  return (
    <div className="mode-preview mode-preview-explorer">
      <div className="mode-preview-head">
        <span>Explorer</span>
        <span>Lookup mode</span>
      </div>
      <div className="mode-preview-list">
        <div><span>CodeSystem</span><strong>nvc-lot-codes</strong></div>
        <div><span>ValueSet</span><strong>nvc-vaccines</strong></div>
        <div><span>Result</span><strong>DIN 02484811</strong></div>
      </div>
    </div>
  )
}

function ExtensionPreview() {
  return (
    <div className="mode-preview mode-preview-extension">
      <div className="mode-preview-head">
        <span>Extension</span>
        <span>Entry mode</span>
      </div>
      <div className="mode-preview-list">
        <div><span>Trade Name</span><strong>Fluzone Quadrivalent</strong></div>
        <div><span>Lot</span><strong>2024B-LOT12</strong></div>
        <div><span>Expiry</span><strong>2026-06</strong></div>
      </div>
    </div>
  )
}

export function ToolsSection() {
  return (
    <>
      <section className="py-24 bg-white">
        <div className="section-inner">
          <SectionHeader
            eyebrow="Product Modes"
            title="Extension for chart entry, explorer for lookup"
            body="VaxLink runs in two modes. One prepares and writes chart fields. The other checks bundle data and explains what the lot match is based on."
          />

          <div className="mode-layout">
            <ModeSwitcher />
            <div className="mode-preview-stack">
              <PanelFrame tone="utility" eyebrow="Resource view" title="Explorer preview" className="mode-preview-frame">
                <ExplorerPreview />
              </PanelFrame>
              <PanelFrame tone="panel" eyebrow="Review view" title="Extension preview" className="mode-preview-frame">
                <ExtensionPreview />
              </PanelFrame>
            </div>
          </div>
        </div>
      </section>

      <CompatibilitySection />
    </>
  )
}
