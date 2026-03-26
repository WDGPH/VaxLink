'use client'

import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { BarcodeViz } from './BarcodeViz'
import { homepageCTAs, homepageMetrics, heroTelemetry } from '@/content/site'
import { MetricRow } from '@/components/MetricRow'
import { PanelFrame } from '@/components/PanelFrame'
import { TrackedLink } from '@/components/TrackedLink'
import { withBasePath } from '@/lib/base-path'

const reveal = { hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0 } }

const writeTargets = [
  { label: 'Writes', value: 'Trade name, DIN, lot, expiry' },
  { label: 'Review', value: 'Operator checks fields before fill' },
  { label: 'Targets', value: 'Panorama and InputHealth' },
]

export function HeroSection() {
  const [primary, secondary, tertiary] = homepageCTAs

  return (
    <section className="hero-shell">
      <div className="hero-grid-overlay" />
      <div className="hero-gradient-field" />
      <motion.div
        className="section-inner hero-layout"
        initial="hidden"
        animate="show"
        transition={{ staggerChildren: 0.1 }}
      >
        <div className="hero-brief">
          <motion.div variants={reveal} className="hero-badge">
            <span className="hero-badge-dot" />
            <span>For immunization teams using Panorama and InputHealth</span>
          </motion.div>

          <motion.h1 variants={reveal} className="hero-headline">
            Scan vaccine barcodes.
            <span>Fill CHR records with fewer manual steps.</span>
          </motion.h1>

          <motion.p variants={reveal} className="hero-copy">
            Parse GS1 vaccine barcodes, check lot data from the National Vaccine Catalogue, and
            review the values before anything is written into the chart.
          </motion.p>

          <motion.div variants={reveal} className="hero-cta-row">
            <TrackedLink
              href={withBasePath(primary.href)}
              event={{ name: 'cta_click', target: 'install' }}
              className="hero-primary-cta"
            >
              {primary.label}
              <ArrowRight className="w-4 h-4" />
            </TrackedLink>
            <TrackedLink
              href={withBasePath(secondary.href)}
              event={{ name: 'cta_click', target: 'explorer' }}
              className="hero-secondary-cta"
            >
              {secondary.label}
            </TrackedLink>
            <TrackedLink
              href={withBasePath(tertiary.href)}
              className="hero-tertiary-link"
            >
              {tertiary.label}
            </TrackedLink>
          </motion.div>

          <motion.div variants={reveal}>
            <MetricRow items={homepageMetrics} />
          </motion.div>

          <motion.div variants={reveal} className="hero-telemetry-strip">
            {heroTelemetry.map((item) => (
              <div key={item.label} className="telemetry-item">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </motion.div>
        </div>

        <motion.div variants={reveal} className="hero-stage">
          <PanelFrame tone="hero" eyebrow="Live Parse" title="Barcode decode and lot match" className="hero-stage-frame">
            <div className="hero-stage-board">
              <div className="hero-barcode-wrap">
                <BarcodeViz />
              </div>

              <div className="hero-assist-rail">
                <section className="hero-assist-card hero-assist-card-utility">
                  <p className="panel-eyebrow">Write Set</p>
                  <h3 className="hero-assist-card-title">Fields prepared for chart entry</h3>
                  <div className="hero-float-list">
                    {writeTargets.map((row) => (
                      <div key={row.label} className="hero-float-row">
                        <span>{row.label}</span>
                        <strong>{row.value}</strong>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="hero-assist-card hero-assist-card-reference">
                  <p className="panel-eyebrow">Bundle State</p>
                  <h3 className="hero-assist-card-title">Current reference source</h3>
                  <div className="hero-status-rail">
                    <div className="hero-status-line">
                      <span className="hero-status-dot" />
                      <p>National Vaccine Catalogue bundle available</p>
                    </div>
                    <div className="hero-status-line">
                      <span className="hero-status-dot hero-status-dot-amber" />
                      <p>Chrome extension review required before fill</p>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </PanelFrame>
        </motion.div>
      </motion.div>
    </section>
  )
}
