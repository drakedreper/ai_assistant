import { Info } from 'lucide-react'
import { useStore } from '../state/store'
import { BrainView } from '../views/brain'
import { LifeView } from '../views/life'
import { MoneyView } from '../views/money'
import { SettingsView } from '../views/settings'
import { TodayView } from '../views/today'
import { WorkView } from '../views/work'
import { WorldView } from '../views/world'
import { CommandPalette } from './CommandPalette'
import { ConnectionBanner, useLinkDown } from './ConnectionBanner'
import { HerSpace, MiniDock } from './HerSpace'
import { Rail } from './Rail'
import { TopBar } from './TopBar'

const VIEW_SECTION = { today: 'briefing', brain: 'brain', life: 'life', money: 'money', world: 'world' } as const

/** Shown in Live mode on screens the daemon still fills with sample data, so nobody mistakes it for their own. */
function SampleDataNote() {
  const view = useStore((s) => s.view)
  const mock = useStore((s) => s.data?.mockSections)
  const section = view in VIEW_SECTION ? VIEW_SECTION[view as keyof typeof VIEW_SECTION] : undefined
  if (!section || !mock?.includes(section)) return null
  return (
    <p role="note" className="mb-3 flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
      <Info className="size-3.5 shrink-0" />
      Sample data. This screen is not connected to your real data yet; chat, Work and approvals are live.
    </p>
  )
}

function Stage() {
  const view = useStore((s) => s.view)
  switch (view) {
    case 'today': return <TodayView />
    case 'work': return <WorkView />
    case 'brain': return <BrainView />
    case 'life': return <LifeView />
    case 'money': return <MoneyView />
    case 'world': return <WorldView />
    case 'settings': return <SettingsView />
  }
}

export function Shell() {
  const roomMode = useStore((s) => s.roomMode)
  const view = useStore((s) => s.view)
  // Guest mode blurs anything marked data-sensitive (see styles.css) while other people are around.
  const guest = useStore((s) => s.data?.settings.guestMode ?? false)
  // Daemon link down: the last data stays on screen, dimmed, so it reads as a frozen copy rather than live.
  const linkDown = useLinkDown()
  return (
    <div className="flex h-full" data-guest={guest ? 'on' : undefined}>
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">
        <ConnectionBanner />
        <TopBar />
        <div
          className={`flex min-h-0 flex-1 gap-3 p-3 pt-0 transition-opacity duration-300 ${linkDown ? 'opacity-60' : ''}`}
          data-link={linkDown ? 'down' : 'up'}
          aria-busy={linkDown || undefined}
        >
          {roomMode !== 'mini' && <HerSpace mode={roomMode} />}
          {roomMode !== 'full' && (
            <main key={view} className="fade-up min-h-0 min-w-0 flex-1 overflow-y-auto pr-1" aria-label={view}>
              <SampleDataNote />
              <Stage />
            </main>
          )}
        </div>
      </div>
      {roomMode === 'mini' && <MiniDock />}
      <CommandPalette />
    </div>
  )
}
