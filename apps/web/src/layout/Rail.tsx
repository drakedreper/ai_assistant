import { useShallow } from 'zustand/react/shallow'
import { AREA, VIEWS, type View } from '../lib/areas'
import { cn } from '../lib/cn'
import { needsYouStatuses, useStore } from '../state/store'

const ACTIVE_COLOR: Record<View, string> = {
  today: 'text-mira bg-mira/12',
  work: AREA.work.text + ' ' + AREA.work.bg,
  brain: AREA.brain.text + ' ' + AREA.brain.bg,
  life: AREA.life.text + ' ' + AREA.life.bg,
  money: AREA.money.text + ' ' + AREA.money.bg,
  world: AREA.world.text + ' ' + AREA.world.bg,
  settings: 'text-fg bg-white/10',
}

/** Left icon rail. Badges show what needs you per area. */
export function Rail() {
  const view = useStore((s) => s.view)
  const navigate = useStore((s) => s.navigate)
  // useShallow: the selector builds a new object each call, which zustand v5 would treat as a change every time.
  const badges = useStore(
    useShallow((s): Partial<Record<View, number>> => {
      const d = s.data
      if (!d) return {}
      return {
        today: d.approvals.filter((a) => a.status === 'pending').length,
        work: d.sessions.filter((x) => needsYouStatuses.includes(x.status)).length,
        brain: d.proposals.filter((p) => p.status === 'pending').length,
        life: d.mail.filter((m) => m.triage === 'needs_reply' && m.unread).length,
      }
    }),
  )

  return (
    <nav aria-label="Main" className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-line bg-black/20 py-3">
      <div className="mb-2 grid size-9 place-items-center rounded-xl bg-gradient-to-br from-mira to-brain text-sm font-black text-canvas" aria-hidden>
        M
      </div>
      {VIEWS.map((v) => {
        const active = v.id === view
        const Icon = v.icon
        const badge = badges[v.id]
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => navigate(v.id)}
            title={`${v.label}: ${v.hint}`}
            aria-label={v.label}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group relative grid size-11 cursor-pointer place-items-center rounded-xl text-muted transition hover:bg-white/8 hover:text-fg',
              v.id === 'settings' && 'mt-auto',
              active && ACTIVE_COLOR[v.id],
            )}
          >
            <Icon className="size-5" />
            {active && <span className="absolute top-2 -left-[9px] h-7 w-1 rounded-r-full bg-current" />}
            {badge ? (
              <span className="absolute top-1 right-1 grid min-w-4 place-items-center rounded-full bg-mira px-1 text-[10px] leading-4 font-bold text-canvas">
                {badge}
              </span>
            ) : null}
          </button>
        )
      })}
    </nav>
  )
}
