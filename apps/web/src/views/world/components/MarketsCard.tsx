import { LineChart, TrendingDown, TrendingUp } from 'lucide-react'
import { Panel, Sparkline } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { useSnap } from '../../../state/store'
import { fmtChange, fmtPrice, isUp } from '../lib'

/** Markets strip: price, signed change and a 7-point sparkline per quote. Sample data, read-only. */
export function MarketsCard() {
  const markets = useSnap((d) => d.world.markets)
  const summary = markets.map((m) => `${m.label} ${fmtPrice(m.price)}, ${fmtChange(m.changePct)}`).join('; ')

  return (
    <Panel title="Markets" subtitle="Sample quotes, last 7 sessions. Mira only reads, she never trades." icon={LineChart} area="world" >
      <ul className="grid grid-cols-2 gap-2 @2xl/world:grid-cols-3 @4xl/world:grid-cols-5" aria-label={`Markets: ${summary}`}>
        {markets.map((m) => {
          const up = isUp(m)
          const Arrow = up ? TrendingUp : TrendingDown
          const color = up ? 'var(--color-ok)' : 'var(--color-bad)'
          return (
            <li key={m.symbol} className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-white/[0.03] px-3 py-2.5">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[12px] font-semibold text-fg">{m.symbol}</span>
                <span className="truncate text-[11px] text-faint">{m.label}</span>
              </div>
              <div className="text-[18px] leading-tight font-semibold text-fg tabular-nums">{fmtPrice(m.price)}</div>
              <div className={cn('flex items-center gap-1 text-[12px] font-medium tabular-nums', up ? 'text-ok' : 'text-bad')}>
                <Arrow className="size-3.5" aria-hidden />
                {fmtChange(m.changePct)}
                <span className="sr-only">{up ? 'up' : 'down'}</span>
              </div>
              <div className="mt-0.5 [&>svg]:h-auto [&>svg]:w-full">
                <Sparkline values={m.series} width={160} height={32} color={color} />
              </div>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
