import { EvidencePanel } from '@/components/EvidencePanel'
import { proofScreenshots } from '@/content/site'
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/ui/motion'

export function ScreenshotShowcase() {
  return (
    <StaggerContainer className="proof-grid" stagger={0.12}>
      {proofScreenshots.map((shot) => (
        <StaggerItem key={shot.asset}>
          <FadeIn>
            <EvidencePanel item={shot} />
          </FadeIn>
        </StaggerItem>
      ))}
    </StaggerContainer>
  )
}
