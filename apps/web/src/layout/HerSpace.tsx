import { lazy, Suspense } from 'react'
import { ChatPanel } from '../chat/ChatPanel'
import { cn } from '../lib/cn'
import type { RoomMode } from '../state/store'

// The 3D room pulls in three.js (~1 MB), so it loads after the shell and dashboards have painted.
const RoomWindow = lazy(() => import('../room/RoomWindow').then((m) => ({ default: m.RoomWindow })))

function RoomFallback() {
  return (
    <div className="grid h-full w-full place-items-center bg-gradient-to-b from-brain/15 to-mira/10 text-xs text-muted">
      Waking Mira up…
    </div>
  )
}

/**
 * "Her space": the Room window on top and the live chat below. In quarter mode it is ~25% of the screen
 * width and the full height. In half mode it grows; in full mode the chat floats over the room.
 * Internals (RoomWindow, ChatPanel) are owned by the Room/Chat module.
 */
export function HerSpace({ mode }: { mode: Exclude<RoomMode, 'mini'> }) {
  const style =
    mode === 'quarter' ? { flex: '0 0 clamp(340px, 25vw, 540px)' } : mode === 'half' ? { flex: '0 0 50%' } : { flex: '1 1 0%' }
  return (
    <aside aria-label="Mira's room and chat" style={style} className="relative flex min-h-0 min-w-0 flex-col gap-3">
      {mode === 'full' ? (
        <>
          <div className="glass relative min-h-0 flex-1 overflow-hidden">
            <Suspense fallback={<RoomFallback />}><RoomWindow mode={mode} /></Suspense>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
            <div className="pointer-events-auto w-full max-w-2xl">
              <ChatPanel variant="overlay" />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className={cn('glass relative min-h-0 overflow-hidden', mode === 'half' ? 'flex-[1_1_58%]' : 'flex-[0_0_56%]')}>
            <Suspense fallback={<RoomFallback />}><RoomWindow mode={mode} /></Suspense>
          </div>
          <ChatPanel variant="dock" />
        </>
      )}
    </aside>
  )
}

/** Mini mode: a floating picture-in-picture Room with a one-line chat. */
export function MiniDock() {
  return (
    <div className="fixed bottom-4 left-[84px] z-30 flex w-80 flex-col gap-2">
      <div className="glass relative aspect-[4/3] overflow-hidden shadow-2xl">
        <Suspense fallback={<RoomFallback />}><RoomWindow mode="mini" /></Suspense>
      </div>
      <ChatPanel variant="mini" />
    </div>
  )
}
