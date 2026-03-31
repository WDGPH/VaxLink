import './globals.css'
import { Navbar } from '@/components/Navbar'
import { ConstructionBanner } from '@/components/ConstructionBanner'
import { Footer } from '@/components/Footer'
import { rootMetadata } from '@/content/site'
import { basePath } from '@/lib/base-path'

export const metadata = {
  ...rootMetadata,
  title: {
    default: 'VaxLink | Vaccine Barcode Workflow for Clinics',
    template: '%s',
  },
  icons: { icon: `${basePath}/favicon.svg` },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">Skip to content</a>
        <ConstructionBanner />
        {/* spacer so content isn't hidden under the fixed banner */}
        <div className="h-9" aria-hidden="true" />
        <Navbar />
        <main id="main-content">{children}</main>
        <Footer />
      </body>
    </html>
  )
}
