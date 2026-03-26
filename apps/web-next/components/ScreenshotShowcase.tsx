import Image from 'next/image'
import { proofScreenshots } from '@/content/site'
import { FadeIn, StaggerContainer, StaggerItem } from '@/components/ui/motion'

export function ScreenshotShowcase() {
  return (
    <StaggerContainer className="proof-grid" stagger={0.12}>
      {proofScreenshots.map((shot) => (
        <StaggerItem key={shot.src}>
          <FadeIn>
            <figure className="proof-card">
              <Image
                src={shot.src}
                alt={shot.alt}
                width={720}
                height={480}
                className="proof-image"
              />
              <figcaption>
                <h3>{shot.title}</h3>
                <p>{shot.caption}</p>
              </figcaption>
            </figure>
          </FadeIn>
        </StaggerItem>
      ))}
    </StaggerContainer>
  )
}
