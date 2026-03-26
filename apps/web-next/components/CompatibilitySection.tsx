import { CompatibilityTable } from '@/components/CompatibilityTable'
import { SectionHeader } from '@/components/SectionHeader'

export function CompatibilitySection() {
  return (
    <section id="compatibility" className="py-24 bg-white">
      <div className="section-inner">
        <SectionHeader
          eyebrow="Compatibility and Limits"
          title="Clear about where VaxLink works today"
          body="The current release is built for Chrome-based Panorama and InputHealth workflows. Other CHRs remain planned and should not be assumed to work yet."
        />
        <CompatibilityTable />
        <div className="compatibility-notes">
          <div className="note-card">
            <h3>Current support</h3>
            <p>Panorama and InputHealth on Chrome are the supported autofill environments in this release.</p>
          </div>
          <div className="note-card">
            <h3>Browser requirement</h3>
            <p>The extension installs through Chrome Developer mode as an unpacked Manifest V3 extension.</p>
          </div>
          <div className="note-card">
            <h3>Planned environments</h3>
            <p>OSCAR, Wolf, and PS Suite remain roadmap items until selector coverage and workflow validation are complete.</p>
          </div>
        </div>
      </div>
    </section>
  )
}
