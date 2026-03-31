import { StatStrip } from '@/components/StatStrip'

export function MetricRow({
  items,
}: {
  items: Array<{ value: string; label: string }>
}) {
  return <StatStrip items={items} className="metric-row" />
}
