import { CompatibilityTable } from '@/components/CompatibilityTable'
import { SectionHeader } from '@/components/SectionHeader'

export function CompatibilitySection() {
  return (
    <section id="compatibility" className="py-24 bg-white">
      <div className="section-inner">
        <SectionHeader
          eyebrow="Compatibility and Limits"
          title="Clear about where VaxLink works today"
          body="The current release supports Chrome with Panorama and InputHealth. Other CHRs are still planned."
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
            <p>OSCAR, Wolf, and PS Suite are still on the roadmap. They are not supported in the current extension.</p>
          </div>
        </div>
      </div>
    </section>
  )
}
