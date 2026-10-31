import { Bell, Camera, CloudSun, Command, Cpu } from 'lucide-react'
import { Badge, Kbd, Segmented, StatusDot } from '../components/ui'
import { fmtDay, fmtUsd } from '../lib/format'
import { pendingApprovals, useStore, type Preset } from '../state/store'

const PRESETS: Array<{ value: Preset; label: string; title: string }> = [
  { value: 'briefing', label: 'Briefing', title: 'Quarter-size Room, Today on stage' },
  { value: 'deepwork', label: 'Deep work', title: 'Mini Room, Work on stage' },
  { value: 'companion', label: 'Companion', title: 'Half-size Room, chat with her' },
]

export function TopBar() {
  const now = useStore((s) => s.now)
  const data = useStore((s) => s.data)
  const preset = useStore((s) => s.preset)
  const applyPreset = useStore((s) => s.applyPreset)
  const setPalette = useStore((s) => s.setPalette)
  const navigate = useStore((s) => s.navigate)
  if (!data) return null

  const pending = pendingApprovals(data).length
  const today = data.costDays[data.costDays.length - 1]
  const spent = today ? Object.values(today.byProject).reduce((a, b) => a + b, 0) : 0
  const claude = data.settings.claude
  const w = data.world.weather
  const claudeColor = claude.status === 'connected' ? 'var(--color-ok)' : claude.status === 'degraded' ? 'var(--color-warn)' : 'var(--color-bad)'

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 px-3">
      <div className="hidden min-w-0 items-center gap-2 text-xs text-muted lg:flex">
        <span className="font-medium text-fg">{fmtDay(now.toISOString())}</span>
        <span className="text-faint">·</span>
        <span className="inline-flex items-center gap-1">
          <CloudSun className="size-3.5 text-world" />
          {Math.round(w.tempC)}°C {w.condition}
        </span>
      </div>

      <button
        type="button"
        onClick={() => setPalette(true)}
        className="glass mx-auto flex h-9 w-full max-w-md cursor-pointer items-center gap-2 px-3 text-left text-[13px] text-faint transition hover:text-muted"
        aria-label="Open command palette"
      >
        <Command className="size-3.5" />
        <span className="flex-1 truncate">Ask Mira or jump to anything…</span>
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </button>

      <Segmented value={preset} onChange={applyPreset} options={PRESETS} ariaLabel="Layout preset" className="hidden xl:inline-flex" />

      <div className="flex items-center gap-2">
        {data.settings.webcam.enabled && (
          <Badge tone="bad" title="Camera is on. Frames are never stored.">
            <Camera className="size-3" /> Camera on
          </Badge>
        )}
        <button
          type="button"
          onClick={() => navigate('settings')}
          title={`Claude: ${claude.status}, ${claude.mode}. Cost is an API-equivalent estimate, not a bill.`}
          className="glass hidden h-9 cursor-pointer items-center gap-2 px-3 text-xs text-muted transition hover:text-fg md:flex"
        >
          <StatusDot color={claudeColor} pulse={claude.status === 'connected'} />
          <Cpu className="size-3.5" />
          <span className="tabular-nums">≈ {fmtUsd(spent)}</span>
          <span className="text-faint">today (est.)</span>
        </button>
        <button
          type="button"
          onClick={() => navigate('today')}
          aria-label={`Needs you: ${pending} pending`}
          className="glass relative grid size-9 cursor-pointer place-items-center text-muted transition hover:text-fg"
        >
          <Bell className="size-4" />
          {pending > 0 && (
            <span className="absolute -top-1 -right-1 grid min-w-[18px] place-items-center rounded-full bg-mira px-1 text-[10px] leading-[18px] font-bold text-canvas">
              {pending}
            </span>
          )}
        </button>
      </div>
    </header>
  )
}
