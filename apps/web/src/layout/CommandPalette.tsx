import { CornerDownLeft, Search, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { VIEWS } from '../lib/areas'
import { cn } from '../lib/cn'
import { useStore, type Preset, type RoomMode } from '../state/store'

interface Item {
  id: string
  group: 'Go to' | 'Room' | 'Layout' | 'Ask Mira'
  label: string
  hint?: string
  run: () => void
}

/** Ctrl/Cmd+K. Jump anywhere, change layout, or ask Mira. */
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen)
  const setPalette = useStore((s) => s.setPalette)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(!useStore.getState().paletteOpen)
      } else if (e.key === 'Escape') setPalette(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPalette])

  // The dialog is mounted fresh on every open, so its query/selection state always starts empty.
  return open ? <PaletteDialog /> : null
}

function PaletteDialog() {
  const setPalette = useStore((s) => s.setPalette)
  const navigate = useStore((s) => s.navigate)
  const setRoomMode = useStore((s) => s.setRoomMode)
  const applyPreset = useStore((s) => s.applyPreset)
  const setDayOverride = useStore((s) => s.setDayOverride)
  const send = useStore((s) => s.send)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)

  const items = useMemo<Item[]>(() => {
    const close = () => setPalette(false)
    const rooms: Array<[RoomMode, string]> = [['mini', 'Mini (picture-in-picture)'], ['quarter', 'Quarter (default)'], ['half', 'Half (companion)'], ['full', 'Full (immersive)']]
    const presets: Array<[Preset, string]> = [['briefing', 'Briefing'], ['deepwork', 'Deep work'], ['companion', 'Companion']]
    const base: Item[] = [
      ...VIEWS.map<Item>((v) => ({ id: `go-${v.id}`, group: 'Go to', label: v.label, hint: v.hint, run: () => { navigate(v.id); close() } })),
      ...rooms.map<Item>(([m, l]) => ({ id: `room-${m}`, group: 'Room', label: `Room size: ${l}`, run: () => { setRoomMode(m); close() } })),
      { id: 'day', group: 'Room', label: 'Room lighting: day', run: () => { setDayOverride('day'); close() } },
      { id: 'night', group: 'Room', label: 'Room lighting: night', run: () => { setDayOverride('night'); close() } },
      { id: 'auto', group: 'Room', label: 'Room lighting: follow the clock', run: () => { setDayOverride('auto'); close() } },
      ...presets.map<Item>(([p, l]) => ({ id: `preset-${p}`, group: 'Layout', label: `Layout preset: ${l}`, run: () => { applyPreset(p); close() } })),
    ]
    const query = q.trim().toLowerCase()
    const filtered = query ? base.filter((i) => `${i.group} ${i.label} ${i.hint ?? ''}`.toLowerCase().includes(query)) : base
    if (q.trim()) {
      filtered.push({ id: 'ask', group: 'Ask Mira', label: `Ask Mira: "${q.trim()}"`, run: () => { void send(q.trim()); close() } })
    }
    return filtered
  }, [q, navigate, setRoomMode, applyPreset, setDayOverride, send, setPalette])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); items[idx]?.run() }
  }

  let lastGroup = ''
  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-items-center bg-black/55 pt-[14vh] backdrop-blur-sm" onMouseDown={() => setPalette(false)} role="presentation">
      <div role="dialog" aria-label="Command palette" className="glass w-[min(640px,92vw)] overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Search className="size-4 text-faint" />
          <input
            autoFocus
            value={q}
            onChange={(e) => { setQ(e.target.value); setIdx(0) }}
            onKeyDown={onKey}
            placeholder="Type to jump, change layout, or ask Mira anything…"
            className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
            aria-label="Command"
          />
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-1.5" role="listbox">
          {items.map((it, i) => {
            const header = it.group !== lastGroup
            lastGroup = it.group
            return (
              <li key={it.id} role="option" aria-selected={i === idx}>
                {header && <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-widest text-faint uppercase">{it.group}</div>}
                <button
                  type="button"
                  onMouseEnter={() => setIdx(i)}
                  onClick={it.run}
                  className={cn('flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]', i === idx ? 'bg-white/10 text-fg' : 'text-muted')}
                >
                  {it.group === 'Ask Mira' && <Sparkles className="size-3.5 text-mira" />}
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="hidden truncate text-[11px] text-faint sm:block">{it.hint}</span>}
                  {i === idx && <CornerDownLeft className="size-3 text-faint" />}
                </button>
              </li>
            )
          })}
          {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-faint">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  )
}
