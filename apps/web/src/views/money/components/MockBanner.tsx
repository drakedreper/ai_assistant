import { EyeOff, FlaskConical, Lock, Plug } from 'lucide-react'
import { Badge, Button } from '../../../components/ui'
import { Tip } from './Tip'

/** Friendly warning: this is sample data, and what the future Atlas connection will and will not be able to do. */
export function MockBanner({ connected, contractVersion }: { connected: boolean; contractVersion: string }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-warn/30 bg-warn/10 px-4 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-warn/15 text-warn">
        <FlaskConical className="size-[18px]" aria-hidden />
      </span>
      <div className="min-w-[220px] flex-1">
        <h2 className="text-[13px] font-semibold text-fg">{connected ? 'Atlas is connected.' : 'Mock data. Atlas is not connected yet.'}</h2>
        <p className="mt-0.5 text-[12px] leading-snug text-muted">
          Everything on this screen is a sample, so you can judge the layout and the idea. Once connected, the same screen reads your own Atlas,
          read-only.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Tip text="The contract Atlas will map onto. It has read methods only, so nothing here can move money." align="end">
          <Badge tone="warn" className="cursor-help">
            <Lock className="size-3" aria-hidden /> v{contractVersion}, read-only
          </Badge>
        </Tip>
        <Tip text="Mira reads totals and category sums. Raw transactions stay hidden until you reveal them, and every reveal is logged." align="end">
          <Badge tone="neutral" className="cursor-help">
            <EyeOff className="size-3" aria-hidden /> Mira sees aggregates only
          </Badge>
        </Tip>
        <Tip
          focusable
          align="end"
          text="Not available yet. A read-only adapter will read Atlas's local database or export. No money movement is possible in v0.x."
        >
          <Button variant="outline" size="md" disabled aria-label="Connect Atlas (not available yet)">
            <Plug className="size-4" aria-hidden /> Connect Atlas
          </Button>
        </Tip>
      </div>
    </div>
  )
}
