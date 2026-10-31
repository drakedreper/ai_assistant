import { useEffect } from 'react'
import { Shell } from './layout/Shell'
import { useStore } from './state/store'

export default function App() {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  useEffect(() => { void init() }, [init])
  if (!ready) {
    return <div className="grid h-full place-items-center text-sm text-muted">Waking Mira up…</div>
  }
  return <Shell />
}
