import type { Metadata } from 'next'

export type CTA = {
  label: string
  href: string
  variant: 'primary' | 'secondary' | 'ghost'
}

export type FeatureCard = {
  slug: string
  title: string
  summary: string
  detail: string
  proof?: string
  tone?: VisualTone
  layout?: LayoutMode
}

export type CompatibilityRow = {
  browser: string
  chr: string
  status: 'supported' | 'planned' | 'limited'
  notes: string
}

export type PermissionRow = {
  permission: string
  reason: string
  optional: boolean
  leavesBrowser: boolean
}

export type FAQItem = {
  question: string
  answer: string
}

export type VisualTone = 'hero' | 'panel' | 'reference' | 'utility'

export type LayoutMode = 'split' | 'stack' | 'rail' | 'grid'

export type EvidenceItem = {
  title: string
  caption: string
  asset: string
  alt: string
  variant: 'screenshot' | 'diagram' | 'mockup'
}

export type ModeCard = {
  slug: string
  label: string
  title: string
  description: string
  href: string
  cta: string
  tone: VisualTone
  bullets: string[]
}

export const siteConfig = {
  name: 'VaxLink',
  shortName: 'VaxLink',
  description:
    'Scan vaccine barcodes, look up lot data from the National Vaccine Catalogue, and fill Panorama or InputHealth records.',
  tagline: 'Vaccine barcode lookup and chart entry for Panorama and InputHealth.',
  baseUrl: process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000',
  basePath: process.env.BASE_PATH || '',
  repoUrl: 'https://github.com/',
  nvcUrl: 'https://nvc-cnv.canada.ca/fhir/v2/Bundle/NVC',
  version: '1.0.4',
} as const

export const homepageCTAs: CTA[] = [
  { label: 'Install Extension', href: '/extension#install', variant: 'primary' },
  { label: 'Open Explorer', href: '/explorer', variant: 'secondary' },
  { label: 'See Use Cases', href: '/#workflows', variant: 'ghost' },
]

export const homepageMetrics = [
  { value: '2', label: 'Supported CHRs' },
  { value: '4', label: 'Core GS1 fields' },
  { value: '4,000+', label: 'NVC-backed lot concepts' },
  { value: '24h', label: 'Refresh cadence' },
]

export const heroTelemetry = [
  { label: 'Mode', value: 'Panorama / InputHealth' },
  { label: 'Bundle', value: 'National Vaccine Catalogue' },
  { label: 'Writes', value: 'Lot, DIN, expiry, trade name' },
]

export const clinicBenefits = [
  {
    title: 'Reduce manual entry',
    body:
      'Pull vaccine details from the barcode and the catalogue instead of typing lot, DIN, and expiry by hand.',
  },
  {
    title: 'Reduce transcription errors',
    body:
      'Keep lot, DIN, expiry, and trade name together while documenting an immunization record.',
  },
  {
    title: 'Speed up documentation',
    body:
      'Give staff the same repeatable steps in Panorama and InputHealth instead of copying fields one at a time.',
  },
]

export const homepageFeatures: FeatureCard[] = [
  {
    slug: 'barcode-parse',
    title: 'Scan and parse GS1 vaccine barcodes',
    summary: 'Read GTIN, lot, expiry, and serial from scanner output or pasted barcode strings.',
    detail:
      'Supports parenthesized GS1, compact payloads, and common text-label fallbacks used in clinic environments.',
    proof: 'Works with AI 01, AI 10, AI 17, and AI 21 barcode fields.',
    tone: 'utility',
    layout: 'split',
  },
  {
    slug: 'lot-resolution',
    title: 'Resolve lot metadata from NVC',
    summary: 'Match scanned lot numbers against National Vaccine Catalogue concepts.',
    detail:
      'Show trade name, DIN, and related product details before anything is entered into the chart.',
    proof: 'Built on National Vaccine Catalogue FHIR bundle content.',
    tone: 'panel',
    layout: 'split',
  },
  {
    slug: 'chr-autofill',
    title: 'Fill supported CHR fields',
    summary: 'Write parsed vaccine details into Panorama and InputHealth with fewer manual steps.',
    detail:
      'VaxLink targets the active page fields needed for immunization documentation rather than broad browser automation.',
    proof: 'Currently supported for Chrome + Panorama/InputHealth.',
    tone: 'hero',
    layout: 'rail',
  },
  {
    slug: 'source-inspection',
    title: 'Inspect source catalogue data when needed',
    summary: 'Use the explorer to verify bundle resources, lot matches, and barcode output.',
    detail:
      'Use this when a barcode looks odd, a lot does not match, or you want to inspect the bundle directly.',
    proof: 'Remote NVC fetch and local JSON bundle loading are both supported.',
    tone: 'reference',
    layout: 'grid',
  },
]

export const workflowCards = [
  {
    title: 'In-clinic barcode scan',
    steps: ['Scan or paste barcode output', 'Resolve lot metadata from NVC', 'Review autofill-ready values in extension'],
    note: 'Best for routine Panorama and InputHealth documentation.',
  },
  {
    title: 'Manual barcode fallback',
    steps: ['Paste compact GS1 or labeled text', 'Confirm parsed AI values', 'Continue with autofill or manual verification'],
    note: 'Useful when scanners output plain text or partial payloads.',
  },
  {
    title: 'Explorer verification',
    steps: ['Fetch the latest NVC bundle', 'Paste barcode or search resources', 'Inspect lot and FHIR resource details'],
    note: 'Best for troubleshooting or checking what is in the current bundle.',
  },
]

export const compatibilityRows: CompatibilityRow[] = [
  { browser: 'Chrome', chr: 'Panorama', status: 'supported', notes: 'Main supported autofill path.' },
  { browser: 'Chrome', chr: 'InputHealth', status: 'supported', notes: 'Supported for barcode parsing and autofill.' },
  { browser: 'Chrome', chr: 'OSCAR', status: 'planned', notes: 'Not yet mapped for stable field targeting.' },
  { browser: 'Chrome', chr: 'Wolf', status: 'planned', notes: 'Planned once selectors and workflow coverage are defined.' },
  { browser: 'Chrome', chr: 'PS Suite', status: 'planned', notes: 'Roadmap item, not available in the current extension.' },
]

export const modeCards: ModeCard[] = [
  {
    slug: 'explorer',
    label: 'Lookup Mode',
    title: 'Explorer',
    description: 'Fetch the bundle, inspect FHIR resources, and confirm what the data says before changing a chart.',
    href: '/explorer',
    cta: 'Open Explorer',
    tone: 'utility',
    bullets: ['Remote NVC fetch', 'Local bundle load', 'FHIR resource detail view'],
  },
  {
    slug: 'extension',
    label: 'Entry Mode',
    title: 'Extension',
    description: 'Parse the barcode, review the fields, and fill Panorama or InputHealth with fewer manual steps.',
    href: '/extension#install',
    cta: 'Install Extension',
    tone: 'panel',
    bullets: ['Chrome extension', 'Panorama + InputHealth', 'Review before write'],
  },
]

export const installSteps = [
  {
    n: '01',
    title: 'Open Chrome extensions',
    detail: 'Go to chrome://extensions and keep the page open while loading the local build.',
    code: 'chrome://extensions',
  },
  {
    n: '02',
    title: 'Enable Developer mode',
    detail: 'Turn on Developer mode in the top-right corner to allow unpacked extension installs.',
    code: 'Developer mode -> ON',
  },
  {
    n: '03',
    title: 'Load the VaxLink extension folder',
    detail: 'Use Load unpacked and select the repository extension directory.',
    code: 'VaxLink/apps/extension/',
  },
  {
    n: '04',
    title: 'Check the result',
    detail: 'Open Panorama or InputHealth, click the VaxLink icon, parse a barcode, then verify the autofill fields.',
    code: 'Parse -> Review -> Auto-fill',
  },
]

export const installChecklist = [
  'Extension icon is visible in Chrome toolbar',
  'Developer mode remains enabled',
  'Barcode parse returns GTIN, lot, and expiry',
  'Panorama or InputHealth fields are detected before autofill',
]

export const permissions: PermissionRow[] = [
  {
    permission: 'activeTab, scripting',
    reason: 'Targets the active CHR page so VaxLink can read and write the fields needed for vaccine documentation.',
    optional: false,
    leavesBrowser: false,
  },
  {
    permission: 'clipboardRead',
    reason: 'Supports scanners and setups that deliver barcode payloads through paste actions.',
    optional: true,
    leavesBrowser: false,
  },
  {
    permission: 'storage',
    reason: 'Stores the local NVC bundle snapshot and extension settings needed for repeated lookups.',
    optional: false,
    leavesBrowser: false,
  },
  {
    permission: 'alarms',
    reason: 'Checks for bundle refreshes roughly every 24 hours so local lot lookups stay current.',
    optional: false,
    leavesBrowser: false,
  },
]

export const troubleshootingItems = [
  {
    title: 'Extension icon is not visible',
    body: 'Pin the extension in Chrome and confirm the unpacked extension loaded without manifest errors.',
  },
  {
    title: 'Developer mode is disabled',
    body: 'Return to chrome://extensions and re-enable Developer mode before reloading the unpacked extension.',
  },
  {
    title: 'Load unpacked path is wrong',
    body: 'Select the repository folder at VaxLink/apps/extension instead of the repo root or web app folder.',
  },
  {
    title: 'No lot match is returned',
    body: 'Open the explorer, fetch the latest NVC bundle, and verify whether the lot exists in current catalogue data.',
  },
  {
    title: 'Autofill fields are not detected',
    body: 'Confirm you are on a supported Panorama or InputHealth screen and that the page finished rendering before running Auto-fill.',
  },
  {
    title: 'Local NVC data feels stale',
    body: 'Reload the extension or force a fresh bundle fetch in the explorer to validate whether newer source data is available.',
  },
]

export const faqItems: FAQItem[] = [
  {
    question: 'Does VaxLink send chart data anywhere?',
    answer:
      'No patient chart data is sent by the website. The extension operates in the browser and stores the NVC bundle locally for lookups.',
  },
  {
    question: 'Which scanners and barcode formats work?',
    answer:
      'VaxLink supports standard GS1 vaccine barcode payloads including parenthesized, compact, and common labeled text formats.',
  },
  {
    question: 'Does it work without internet?',
    answer:
      'Yes for previously cached bundle data. Internet access is only needed when fetching or refreshing the NVC bundle source.',
  },
  {
    question: 'What if lot lookup fails?',
    answer:
      'Use the explorer to check the parsed barcode and confirm whether the lot exists in the current NVC bundle.',
  },
  {
    question: 'Which CHRs are supported today?',
    answer:
      'Panorama and InputHealth are the supported autofill targets in the current release. OSCAR, Wolf, and PS Suite remain planned.',
  },
  {
    question: 'Is this Health Canada software?',
    answer:
      'No. VaxLink uses National Vaccine Catalogue data maintained by the Public Health Agency of Canada, but it is an internal toolkit and is not affiliated with PHAC.',
  },
]

export const trustPoints = [
  'National Vaccine Catalogue bundle maintained by PHAC',
  '24-hour bundle refresh checks',
  'Local browser storage for cached data',
  'Manifest V3 Chrome extension for supported CHRs',
]

export const proofScreenshots: EvidenceItem[] = [
  {
    title: 'Parsed barcode ready for review',
    caption: 'Extension view showing parsed AI fields before autofill.',
    asset: '/proof-extension-parse.svg',
    alt: 'VaxLink extension parse results showing GTIN, lot, expiry, and DIN fields.',
    variant: 'mockup',
  },
  {
    title: 'Autofill review before commit',
    caption: 'Staff can review which CHR values will be written.',
    asset: '/proof-autofill.svg',
    alt: 'VaxLink autofill checklist showing CHR fields ready to populate.',
    variant: 'screenshot',
  },
  {
    title: 'Explorer lookup view',
    caption: 'Use the explorer to check lot matches and inspect bundle resources.',
    asset: '/proof-explorer.svg',
    alt: 'VaxLink explorer listing FHIR resources and a resolved lot match panel.',
    variant: 'diagram',
  },
]

export const extensionTrustChips = [
  'Chrome Extension',
  'Manifest V3',
  'Panorama',
  'InputHealth',
  'NVC-backed lot resolution',
]

export const footerColumns = [
  {
    title: 'Product',
    links: [
      { label: 'Home', href: '/' },
      { label: 'Explorer', href: '/explorer' },
      { label: 'Extension', href: '/extension' },
      { label: 'Install', href: '/extension#install' },
    ],
  },
  {
    title: 'Compatibility',
    links: [
      { label: 'Panorama', href: '/extension#compatibility' },
      { label: 'InputHealth', href: '/extension#compatibility' },
      { label: 'Planned EMRs', href: '/extension#compatibility' },
    ],
  },
  {
    title: 'Trust',
    links: [
      { label: 'Permissions', href: '/extension#permissions' },
      { label: 'Data Source', href: '/extension#data-handling' },
      { label: 'Internal Use Note', href: '/extension#faq' },
      { label: 'Troubleshooting', href: '/extension#troubleshooting' },
    ],
  },
  {
    title: 'Technical',
    links: [
      { label: 'NVC / FHIR Source', href: '/explorer' },
      { label: `Version ${siteConfig.version}`, href: '/extension#release-notes' },
      { label: 'Repository', href: siteConfig.repoUrl, external: true },
    ],
  },
]

const socialImagePath = '/proof-extension-parse.svg'

function canonical(path: string) {
  const normalized = path === '/' ? '/' : path.replace(/\/$/, '')
  const withBasePath =
    siteConfig.basePath && normalized !== '/'
      ? `${siteConfig.basePath}${normalized}`
      : siteConfig.basePath && normalized === '/'
        ? `${siteConfig.basePath}/`
        : normalized

  return new URL(withBasePath, siteConfig.baseUrl)
}

export function buildMetadata({
  title,
  description,
  path,
}: {
  title: string
  description: string
  path: string
}): Metadata {
  return {
    title,
    description,
    metadataBase: new URL(siteConfig.baseUrl),
    alternates: {
      canonical: canonical(path),
    },
    openGraph: {
      title,
      description,
      url: canonical(path),
      siteName: siteConfig.name,
      type: 'website',
      images: [{ url: canonical(socialImagePath) }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [canonical(socialImagePath).toString()],
    },
  }
}

export const rootMetadata = buildMetadata({
  title: 'VaxLink | Vaccine Barcode Workflow for Clinics',
  description: siteConfig.description,
  path: '/',
})

export const extensionMetadata = buildMetadata({
  title: 'VaxLink Extension | Chrome Workflow for Panorama and InputHealth',
  description:
    'Install the VaxLink Chrome extension to parse vaccine barcodes, resolve NVC-backed lot metadata, and autofill Panorama or InputHealth.',
  path: '/extension',
})

export const explorerMetadata = buildMetadata({
  title: 'VaxLink Explorer | Verify NVC FHIR Resources and Lot Matches',
  description:
    'Use the VaxLink explorer to fetch the National Vaccine Catalogue bundle, inspect FHIR resources, parse GS1 barcodes, and verify lot metadata.',
  path: '/explorer',
})
