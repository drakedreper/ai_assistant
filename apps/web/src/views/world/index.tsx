import { MiraDisc } from '../../chat/MiraDisc'
import { Briefing } from './components/Briefing'
import { MarketsCard } from './components/MarketsCard'
import { RankingNote, SignalsCard } from './components/SignalsCard'
import { WeatherCard } from './components/WeatherCard'

/**
 * WORLD: weather, markets and the news, re-ranked for you. Every story says why it matters to YOUR notes; the
 * summaries come from a tool-less Reader lane, so a headline can never talk her into doing anything.
 */
export function WorldView() {
  return (
    <div className="@container/world flex flex-col gap-3 pb-4">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[17px] leading-tight font-semibold text-fg">World</h1>
          <p className="mt-1 flex items-center gap-2 text-[13px] text-muted">
            <MiraDisc size={20} />
            The world, ranked by what you are building. Quiet days stay quiet.
          </p>
        </div>
      </header>

      <WeatherCard />
      <MarketsCard />

      <div className="grid items-start gap-3 @4xl/world:grid-cols-[minmax(0,1fr)_300px] @7xl/world:grid-cols-[minmax(0,1fr)_340px]">
        <Briefing />
        <aside className="flex flex-col gap-3" aria-label="Signals">
          <SignalsCard />
          <RankingNote />
        </aside>
      </div>
    </div>
  )
}
