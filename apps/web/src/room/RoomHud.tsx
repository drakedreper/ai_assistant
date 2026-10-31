import { BedDouble, Brain, Briefcase, Camera, CameraOff, CalendarDays, Eye, Maximize2, Mic, Moon, Sun, SunMoon, Sunrise, Wallet, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'
import { LevelBars } from '../chat/LevelBars'
import { toggleVoice } from '../chat/voice'
import { cn } from '../lib/cn'
import { useStore, type DayOverride, type RoomMode } from '../state/store'
import { PROPS, type PropId } from './constants'
import { useRoomUi } from './roomUi'
import { useEffState } from './signals'

const STATE_LABEL: Record<string, [string, string]> = {
  idle: ['relaxing in her room', 'relaxing'],
  listening: ['listening', 'listening'],
  thinking: ['thinking it over', 'thinking'],
  speaking: ['talking', 'talking'],
  working: ['working at her desk', 'working'],
  sleeping: ['asleep', 'asleep'],
}
const STATE_DOT: Record<string, string> = {
  idle: 'var(--color-ok)',
  listening: 'var(--color-mira)',
  thinking: 'var(--color-warn)',
  speaking: 'var(--color-mira)',
  working: 'var(--color-work)',
  sleeping: 'var(--color-brain)',
}
const PULSE = new Set(['listening', 'thinking', 'speaking', 'working'])

const PROP_ICON: Record<PropId, LucideIcon> = { calendar: CalendarDays, work: Briefcase, brain: Brain, money: Wallet }
const PROP_ORDER: PropId[] = ['calendar', 'work', 'brain', 'money']
const PROP_TEXT: Record<PropId, string> = { calendar: 'text-life', work: 'text-work', brain: 'text-brain', money: 'text-money' }

const CHIP = 'pointer-events-auto rounded-xl border border-line bg-canvas/65 backdrop-blur-md'

/** A tiny glyph showing how much of the screen her space takes. */
function SizeGlyph({ mode }: { mode: RoomMode }) {
  const fill = { mini: 0.2, quarter: 0.3, half: 0.52, full: 1 }[mode]
  return (
    <svg width="16" height="11" viewBox="0 0 16 11" aria-hidden>
      <rect x="0.5" y="0.5" width="15" height="10" rx="2" fill="none" stroke="currentColor" opacity="0.55" />
      {mode === 'mini' ? (
        <rect x="2" y="5.5" width="4.5" height="3.5" rx="1" fill="currentColor" />
      ) : (
        <rect x="1.5" y="1.5" width={Math.max(2, 13 * fill)} height="8" rx="1.2" fill="currentColor" />
      )}
    </svg>
  )
}

const SIZES: Array<{ value: RoomMode; name: string; title: string }> = [
  { value: 'mini', name: 'Mini', title: 'Mini: picture in picture' },
  { value: 'quarter', name: 'Quarter', title: 'Quarter: her column' },
  { value: 'half', name: 'Half', title: 'Half: companion' },
  { value: 'full', name: 'Full', title: 'Full: immersive room' },
]

/** Room size control: a tablist of four tiny screen glyphs (names are for screen readers and tooltips). */
function SizeTabs({ value, onChange, compact }: { value: RoomMode; onChange: (m: RoomMode) => void; compact: boolean }) {
  return (
    <div role="tablist" aria-label="Room size" className="flex items-center rounded-lg bg-white/4 p-0.5">
      {SIZES.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'grid h-6 cursor-pointer place-items-center rounded-md transition',
            compact ? 'w-6' : 'w-7',
            o.value === value ? 'bg-white/14 text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          <SizeGlyph mode={o.value} />
          <span className="sr-only">{o.name}</span>
        </button>
      ))}
    </div>
  )
}

const DAY_NEXT: Record<DayOverride, DayOverride> = { auto: 'day', day: 'night', night: 'auto' }
const DAY_ICON: Record<DayOverride, LucideIcon> = { auto: SunMoon, day: Sun, night: Moon }

function HudButton({
  icon: Icon,
  label,
  onClick,
  pressed,
  className,
  children,
  title,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  pressed?: boolean
  className?: string
  children?: ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      className={cn(
        'grid size-7 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-white/10 hover:text-fg',
        pressed && 'bg-white/10 text-fg',
        className,
      )}
    >
      <Icon className="size-4" />
      {children}
    </button>
  )
}

function StateChip({ compact }: { compact: boolean }) {
  const state = useEffState()
  const [full, short] = STATE_LABEL[state] ?? ['here', 'here']
  return (
    <div className={cn(CHIP, 'flex h-9 min-w-0 items-center gap-2 px-3 text-xs')} role="status" aria-live="polite">
      <span className={cn('size-2 shrink-0 rounded-full', PULSE.has(state) && 'pulse-dot')} style={{ background: STATE_DOT[state] }} />
      <span className="truncate">
        <span className="font-semibold text-fg">Mira</span>
        <span className="text-muted"> · {compact ? short : full}</span>
      </span>
    </div>
  )
}

function SpeechBubble() {
  const speech = useStore((s) => s.speech)
  const first = useRef(speech?.seq ?? 0)
  const [text, setText] = useState('')
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!speech || speech.seq === first.current) return
    setText(speech.text)
    setVisible(true)
    const id = setTimeout(() => setVisible(false), Math.min(9000, Math.max(3600, 2800 + speech.text.length * 55)))
    return () => clearTimeout(id)
  }, [speech])
  if (!text) return null
  return (
    <div
      aria-live="polite"
      className={cn('pointer-events-none absolute inset-x-4 top-[52px] flex justify-center transition-opacity duration-500', visible ? 'opacity-100' : 'opacity-0')}
    >
      <p className="relative max-w-[min(100%,340px)] rounded-2xl border border-mira/30 bg-canvas/80 px-3.5 py-2 text-[13px] leading-snug text-fg shadow-lg backdrop-blur-md">
        <span className="line-clamp-3">{text}</span>
        <span className="absolute -bottom-1.5 left-1/2 size-3 -translate-x-1/2 rotate-45 border-r border-b border-mira/30 bg-canvas/80" aria-hidden />
      </p>
    </div>
  )
}

function PresenceBtn({
  icon: Icon,
  label,
  text,
  onClick,
  pressed,
  disabled,
  danger,
  showText,
  title,
}: {
  icon: LucideIcon
  label: string
  text: string
  onClick: () => void
  pressed?: boolean
  disabled?: boolean
  danger?: boolean
  showText: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      className={cn(
        'flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted transition hover:bg-white/10 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted',
        pressed && (danger ? 'bg-bad/20 text-bad ring-1 ring-bad/40' : 'bg-mira/20 text-mira ring-1 ring-mira/50'),
      )}
    >
      <Icon className="size-4 shrink-0" />
      {showText && <span className="whitespace-nowrap">{text}</span>}
    </button>
  )
}

function PresenceBar({ compact }: { compact: boolean }) {
  const micOn = useStore((s) => s.micOn)
  const camOn = useStore((s) => s.data?.settings.webcam.enabled ?? false)
  const navigate = useStore((s) => s.navigate)
  const hovered = useRoomUi((s) => s.hovered)
  const setHovered = useRoomUi((s) => s.setHovered)
  const showText = !compact
  return (
    <div className={cn(CHIP, 'flex items-center gap-0.5 p-1')} role="toolbar" aria-label="Presence and room shortcuts">
      <PresenceBtn icon={Mic} label={micOn ? 'Stop listening' : 'Talk to Mira (push to talk)'} text="Talk" pressed={micOn} onClick={toggleVoice} showText={showText} title="Push to talk (demo)" />
      <PresenceBtn
        icon={camOn ? Camera : CameraOff}
        label={camOn ? 'Turn camera off' : 'Turn camera on'}
        text="Camera"
        pressed={camOn}
        danger
        onClick={() => void api.setWebcam(!camOn)}
        showText={showText}
        title={camOn ? 'Camera is on. Frames are never stored.' : 'Let her see you (nothing is stored)'}
      />
      <PresenceBtn
        icon={Eye}
        label="Look at this: share a camera snapshot"
        text="Look at this"
        disabled={!camOn}
        onClick={() => void useStore.getState().send('(shared a camera snapshot) What do you think of this?')}
        showText={showText}
        title={camOn ? 'Share one snapshot with her' : 'Turn the camera on to share a snapshot'}
      />
      <span className="mx-1 h-5 w-px bg-line-strong" aria-hidden />
      {PROP_ORDER.map((id) => {
        const Icon = PROP_ICON[id]
        return (
          <button
            key={id}
            type="button"
            aria-label={PROPS[id].aria}
            title={PROPS[id].label}
            onClick={() => navigate(PROPS[id].view)}
            onMouseEnter={() => setHovered(id)}
            onMouseLeave={() => hovered === id && setHovered(null)}
            onFocus={() => setHovered(id)}
            onBlur={() => hovered === id && setHovered(null)}
            className={cn('grid size-8 cursor-pointer place-items-center rounded-lg transition hover:bg-white/10', PROP_TEXT[id], hovered === id && 'bg-white/10')}
          >
            <Icon className="size-4" />
          </button>
        )
      })}
    </div>
  )
}

function CameraChip({ mini }: { mini?: boolean }) {
  return (
    <div
      role="status"
      className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-bad/50 bg-bad/20 px-2.5 py-1 text-[11px] font-medium text-fg backdrop-blur-md"
    >
      <span className="size-2 rounded-full bg-bad pulse-dot" aria-hidden />
      <Camera className="size-3 text-bad" aria-hidden />
      {mini ? 'Camera on' : 'Camera on, nothing is stored'}
    </div>
  )
}

/**
 * HTML overlay on top of the 3D room (or its SVG fallback): state label, size and lighting controls,
 * what she is saying, and the presence bar (mic, camera, snapshot, room shortcuts).
 */
export function RoomHud({ mode, width }: { mode: RoomMode; width: number }) {
  const setRoomMode = useStore((s) => s.setRoomMode)
  const dayOverride = useStore((s) => s.dayOverride)
  const setDayOverride = useStore((s) => s.setDayOverride)
  const asleep = useStore((s) => s.asleep)
  const setAsleep = useStore((s) => s.setAsleep)
  const micOn = useStore((s) => s.micOn)
  const camOn = useStore((s) => s.data?.settings.webcam.enabled ?? false)
  const compact = width < 430

  if (mode === 'mini') {
    return (
      <div className="pointer-events-none absolute inset-0 p-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <StateChip compact />
          </div>
          <div className={cn(CHIP, 'p-1')}>
            <HudButton icon={Maximize2} label="Expand her room" title="Expand her room" onClick={() => setRoomMode('quarter')} />
          </div>
        </div>
        {camOn && (
          <div className="absolute bottom-2 left-2">
            <CameraChip mini />
          </div>
        )}
      </div>
    )
  }

  const DayIcon = DAY_ICON[dayOverride]
  const next = DAY_NEXT[dayOverride]
  return (
    <div className="pointer-events-none absolute inset-0 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <StateChip compact={compact} />
        </div>
        <div className={cn(CHIP, 'flex shrink-0 items-center gap-0.5 p-1')}>
          <SizeTabs value={mode} onChange={setRoomMode} compact={compact} />
          <span className="mx-0.5 h-5 w-px bg-line-strong" aria-hidden />
          <HudButton
            icon={DayIcon}
            label={`Lighting: ${dayOverride}. Switch to ${next}.`}
            title={`Lighting: ${dayOverride} (click for ${next})`}
            onClick={() => setDayOverride(next)}
          />
          <HudButton
            icon={asleep ? Sunrise : BedDouble}
            label={asleep ? 'Wake her' : 'Let her sleep'}
            title={asleep ? 'Wake her' : 'Let her sleep'}
            pressed={asleep}
            onClick={() => setAsleep(!asleep)}
          />
        </div>
      </div>

      <SpeechBubble />

      {mode === 'full' ? (
        <div className="absolute top-3 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
          <PresenceBar compact={false} />
          {micOn && <ListeningChip />}
          {camOn && <CameraChip />}
        </div>
      ) : (
        <div className="absolute inset-x-2.5 bottom-2.5 flex flex-col items-center gap-2">
          <div className="flex w-full items-end justify-between gap-2">
            <div className="min-w-0 flex-1">{camOn && <CameraChip />}</div>
          </div>
          {micOn && <ListeningChip />}
          <PresenceBar compact={compact} />
        </div>
      )}
    </div>
  )
}

function ListeningChip() {
  return (
    <div role="status" className="pointer-events-auto flex items-center gap-2 rounded-full border border-mira/40 bg-canvas/75 px-3 py-1 text-xs font-medium text-mira backdrop-blur-md">
      <LevelBars active bars={7} height={14} />
      Listening…
    </div>
  )
}
