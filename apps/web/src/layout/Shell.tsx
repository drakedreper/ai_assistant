import { useStore } from '../state/store'
import { BrainView } from '../views/brain'
import { LifeView } from '../views/life'
import { MoneyView } from '../views/money'
import { SettingsView } from '../views/settings'
import { TodayView } from '../views/today'
import { WorkView } from '../views/work'
import { WorldView } from '../views/world'
import { CommandPalette } from './CommandPalette'
import { HerSpace, MiniDock } from './HerSpace'
import { Rail } from './Rail'
import { TopBar } from './TopBar'

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
  return (
    <div className="flex h-full">
      <Rail />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="flex min-h-0 flex-1 gap-3 p-3 pt-0">
          {roomMode !== 'mini' && <HerSpace mode={roomMode} />}
          {roomMode !== 'full' && (
            <main key={view} className="fade-up min-h-0 min-w-0 flex-1 overflow-y-auto pr-1" aria-label={view}>
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
