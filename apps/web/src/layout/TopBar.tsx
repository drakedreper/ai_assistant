import { Bell, Camera, CloudSun, Command, Cpu } from 'lucide-react'
import { useApiUi } from '../api'
import { Badge, Kbd, Segmented, StatusDot } from '../components/ui'
import { fmtDay, fmtUsd } from '../lib/format'
import { useCostToday } from '../state/derived'
import { pendingApprovals, useStore, type Preset } from '../state/store'
import { useLinkDown } from './ConnectionBanner'

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
  const spent = useCostToday()
  const { mode, backend } = useApiUi()
  const linkDown = useLinkDown()
  if (!data) return null

  const pending = pendingApprovals(data).length
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
        <span data-testid="mode-badge" data-mode={mode} data-link={mode === 'daemon' && linkDown ? 'down' : 'up'}>
          {mode === 'fixtures' ? (
            <Badge title="Mockup: built-in sample data. Nothing here is real and nothing is saved.">Mockup</Badge>
          ) : linkDown ? (
            <Badge tone="warn" title="The daemon is not answering. You are looking at the last data received.">
              Offline
            </Badge>
          ) : (
            <span className="inline-flex items-center gap-1">
              <Badge tone="ok" title="Live: connected to your local daemon.">
                Live
              </Badge>
              {backend === 'fake' && (
                <span className="hidden lg:inline-flex">
                  <Badge tone="warn" title="The daemon's Claude backend is the zero-token stand-in: chat replies are scripted, nothing talks to Claude.">
                    fake Claude
                  </Badge>
                </span>
              )}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={() => navigate('settings', { tab: 'claude' })}
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
