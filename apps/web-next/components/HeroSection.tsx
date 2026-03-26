'use client'

import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { BarcodeViz } from './BarcodeViz'
import { homepageCTAs, homepageMetrics } from '@/content/site'
import { MetricRow } from '@/components/MetricRow'
import { TrackedLink } from '@/components/TrackedLink'
import { withBasePath } from '@/lib/base-path'

const up = { hidden: { opacity: 0, y: 22 }, show: { opacity: 1, y: 0 } }

export function HeroSection() {
  const [primary, secondary, tertiary] = homepageCTAs

  return (
    <section
      className="relative min-h-[92vh] flex items-center overflow-hidden"
      style={{ background: 'var(--hero-bg)' }}
    >
      {/* Atmospheric gradients */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `
            radial-gradient(ellipse at 60% 35%, rgba(37,99,235,0.18) 0%, transparent 55%),
            radial-gradient(ellipse at 8% 80%, rgba(99,102,241,0.09) 0%, transparent 40%)
          `,
        }}
      />
      <div className="grain" />

      <motion.div
        className="section-inner relative z-10 py-24 pt-32 w-full"
        initial="hidden"
        animate="show"
        transition={{ staggerChildren: 0.12 }}
      >
        <div className="flex flex-col lg:flex-row items-center lg:items-start justify-between gap-16">

          {/* Left */}
          <div className="flex-1 max-w-2xl">
            {/* Kicker */}
            <motion.div
              variants={up}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 mb-7"
              style={{ borderColor: 'rgba(37,99,235,0.35)', background: 'rgba(37,99,235,0.08)' }}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                <span className="font-mono text-[11px] text-blue-300 tracking-wider uppercase">
                For immunization teams using Panorama and InputHealth
                </span>
              </motion.div>

            <motion.h1
              variants={up}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              className="font-sora font-extrabold text-white leading-[1.05]"
              style={{ fontSize: 'clamp(2.8rem, 5.5vw, 5rem)' }}
            >
              Scan vaccine barcodes.<br />
              <span
                style={{
                  background: 'linear-gradient(135deg, #3b82f6, #818cf8)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                Fill CHR records with confidence.
              </span>
            </motion.h1>

            <motion.p
              variants={up}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              className="mt-6 text-slate-400 leading-relaxed"
              style={{ fontSize: 'clamp(1rem, 1.8vw, 1.1rem)', maxWidth: '52ch' }}
            >
              Parse GS1 vaccine barcodes, resolve NVC-backed lot metadata, and review autofill-ready
              values for Panorama and InputHealth without bouncing between multiple references.
            </motion.p>

            <motion.div
              variants={up}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              className="mt-8 flex flex-wrap gap-3"
            >
              <TrackedLink
                href={withBasePath(primary.href)}
                event={{ name: 'cta_click', target: 'install' }}
                className="group inline-flex items-center gap-2 font-sora font-semibold text-sm px-6 py-3 rounded-full text-white transition-all hover:brightness-110 hover:-translate-y-px"
                style={{
                  background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
                  boxShadow:  '0 4px 24px rgba(37,99,235,0.4)',
                }}
              >
                {primary.label}
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </TrackedLink>
              <TrackedLink
                href={withBasePath(secondary.href)}
                event={{ name: 'cta_click', target: 'explorer' }}
                className="inline-flex items-center gap-2 font-sora font-semibold text-sm px-6 py-3 rounded-full border text-white/80 hover:bg-white/5 transition-colors"
                style={{ borderColor: 'rgba(255,255,255,0.15)' }}
              >
                {secondary.label}
              </TrackedLink>
              <TrackedLink
                href={withBasePath(tertiary.href)}
                className="inline-flex items-center gap-2 font-sora font-semibold text-sm px-2 py-3 text-blue-300 hover:text-blue-200 transition-colors"
              >
                {tertiary.label}
              </TrackedLink>
            </motion.div>

            <motion.div
              variants={up}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              className="mt-14 pt-8"
              style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
            >
              <MetricRow items={homepageMetrics} />
            </motion.div>
          </div>

          <motion.div
            variants={up}
            transition={{ duration: 0.7, ease: 'easeOut', delay: 0.2 }}
            className="flex-shrink-0 hidden lg:block"
          >
            <div className="relative">
              <div
                className="absolute -inset-10 -z-10 rounded-3xl"
                style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.14) 0%, transparent 70%)' }}
              />
              <BarcodeViz />
            </div>
          </motion.div>

        </div>
      </motion.div>

      <div
        className="absolute bottom-0 inset-x-0 h-24 pointer-events-none"
        style={{ background: 'linear-gradient(to bottom, transparent, var(--bg))' }}
      />
    </section>
  )
}
