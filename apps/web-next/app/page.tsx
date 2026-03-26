import { HeroSection } from '@/components/HeroSection'
import { FeaturesSection } from '@/components/FeaturesSection'
import { WorkflowSection } from '@/components/WorkflowSection'
import { ToolsSection } from '@/components/ToolsSection'
import { TrustSection } from '@/components/TrustSection'
import { WhyClinicsSection } from '@/components/WhyClinicsSection'
import { faqItems, rootMetadata, siteConfig } from '@/content/site'

export const metadata = rootMetadata

export default function HomePage() {
  const softwareJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: siteConfig.name,
    operatingSystem: 'Chrome',
    applicationCategory: 'BusinessApplication',
    description: siteConfig.description,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  }

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.slice(0, 3).map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  }

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />
      <HeroSection />
      <WhyClinicsSection />
      <FeaturesSection />
      <WorkflowSection />
      <ToolsSection />
      <TrustSection />
    </>
  )
}
