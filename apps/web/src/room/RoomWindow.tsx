import type { RoomMode } from '../state/store'

/** STUB: replaced by the Room module (react-three-fiber scene, presence controls, size/lighting toggles). */
export function RoomWindow({ mode }: { mode: RoomMode }) {
  return (
    <div className="grid h-full w-full place-items-center bg-gradient-to-b from-brain/20 to-mira/10 text-sm text-muted">
      Room ({mode})
    </div>
  )
}
