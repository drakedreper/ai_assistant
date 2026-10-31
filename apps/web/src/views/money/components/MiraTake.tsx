import type { FinanceInsight } from '@ai-assistant/shared'
import { MessageCircle, Sparkles } from 'lucide-react'
import { NoteChip } from '../../../components/NoteChip'
import { Button, Panel } from '../../../components/ui'
import { useStore } from '../../../state/store'

/** Her short read of the numbers. It cites the notes it leans on: that is what separates it from a dashboard. */
export function MiraTake({ insight, className }: { insight: FinanceInsight; className?: string }) {
  const send = useStore((s) => s.send)
  return (
    <Panel
      title="Mira's take"
      subtitle="Reads aggregates, cites your notes"
      icon={Sparkles}
      area="money"
      className={className}
      bodyClassName="flex flex-col"
    >
      <div className="flex-1 border-l-2 border-mira/50 pl-3">
        <p className="text-[13.5px] leading-relaxed text-fg/95" data-sensitive>
          {insight.body}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-faint">Based on</span>
        {insight.cites.map((c) => (
          <NoteChip key={c.path} path={c.path} title={c.title} />
        ))}
      </div>
      <div className="mt-3">
        <Button variant="outline" onClick={() => void send('How is my money looking?')}>
          <MessageCircle className="size-3.5" aria-hidden /> Talk it through
        </Button>
      </div>
    </Panel>
  )
}
