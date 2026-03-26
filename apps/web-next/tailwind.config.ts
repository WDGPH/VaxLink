import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sora: ['var(--font-sora)', 'system-ui', 'sans-serif'],
        inter: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-plex-mono)', 'ui-monospace', 'monospace'],
      },
      colors: {
        accent: {
          DEFAULT: '#2563eb',
          dark:    '#1d4ed8',
          light:   '#60a5fa',
          50:      '#eff6ff',
        },
        hero: {
          DEFAULT:       '#0f172a',
          surface:       '#1e293b',
          border:        'rgba(37,99,235,0.18)',
          'border-strong': 'rgba(37,99,235,0.35)',
        },
      },
      keyframes: {
        scanBeam: {
          '0%':   { top: '0%',   opacity: '0' },
          '8%':   {              opacity: '1' },
          '92%':  {              opacity: '1' },
          '100%': { top: '100%', opacity: '0' },
        },
        fieldReveal: {
          from: { opacity: '0', transform: 'translateX(-6px)' },
          to:   { opacity: '1', transform: 'translateX(0)' },
        },
        floatY: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%':      { transform: 'translateY(-8px)' },
        },
      },
      animation: {
        scanBeam:    'scanBeam 2.6s ease-in-out infinite',
        fieldReveal: 'fieldReveal 0.45s ease forwards',
        float:       'floatY 4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}

export default config
