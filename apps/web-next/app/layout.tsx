import './globals.css'
import { Navbar } from '@/components/Navbar'
import { Footer } from '@/components/Footer'
import { rootMetadata } from '@/content/site'

const basePath = process.env.BASE_PATH || ''

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
        <Navbar />
        <main id="main-content">{children}</main>
        <Footer />
      </body>
    </html>
  )
}
