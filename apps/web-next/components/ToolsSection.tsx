import { CompatibilitySection } from '@/components/CompatibilitySection'
import { ModeSwitcher } from '@/components/ModeSwitcher'
import { PanelFrame } from '@/components/PanelFrame'
import { SectionHeader } from '@/components/SectionHeader'

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
            eyebrow="Product Mode"
            title="Extension-first workflow for chart entry"
            body="VaxLink centers on the extension: parse the barcode, review the fields, and write the chart values with fewer manual steps."
          />

          <div className="mode-layout">
            <ModeSwitcher />
            <div className="mode-preview-stack">
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
