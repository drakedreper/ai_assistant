import { Activity, PersonStanding } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { CharacterProfile, PresenceStyle, StageLive, StageSnapshot } from '@ai-assistant/shared'
import { Badge, Panel } from '../../../components/ui'
import { stageClient } from '../../../stage/stageClient'
import { Callout } from './Atoms'
import { StageNotice, useStageAction } from './StageShared'

type Scalar = 'uprightness' | 'gestureEconomy' | 'gazeHold' | 'pace' | 'athleticism'

const SCALARS: Array<{ key: Scalar; label: string; low: string; high: string; hint: string }> = [
  { key: 'uprightness', label: 'Uprightness', low: 'relaxed', high: 'rigidly upright', hint: 'Authority sits around 0.7 to 0.85.' },
  { key: 'gestureEconomy', label: 'Economy of gesture', low: 'expressive', high: 'very economical', hint: 'Fewer, deliberate gestures read as authority.' },
  { key: 'gazeHold', label: 'Gaze hold', low: 'brief', high: 'long and steady', hint: 'How long eye contact is held before a natural break.' },
  { key: 'pace', label: 'Pace', low: 'quick', high: 'slow and measured', hint: 'Speed of movement and speech.' },
  { key: 'athleticism', label: 'Athletic bearing', low: 'soft', high: 'grounded and balanced', hint: 'Weight under her, controlled movement.' },
]

function Slider({ label, low, high, hint, value, min, max, step, onCommit, disabled }: { label: string; low: string; high: string; hint: string; value: number; min: number; max: number; step: number; onCommit: (v: number) => Promise<boolean>; disabled: boolean }) {
  const id = useId()
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  const commit = async (): Promise<void> => {
    if (local === value) return
    if (!(await onCommit(local))) setLocal(value)
  }
  const pct = ((local - min) / (max - min)) * 100
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-fg">
          {label}
        </label>
        <output htmlFor={id} className="text-[12px] text-muted tabular-nums">
          {local.toFixed(2)}
        </output>
      </div>
      <p className="text-[11px] text-faint">{hint}</p>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={() => void commit()}
        onKeyUp={() => void commit()}
        className="vibe-range mt-1.5"
        style={{ ['--pct' as string]: `${pct}%` }}
        aria-valuetext={`${local.toFixed(2)}, between ${low} and ${high}`}
      />
      <div className="flex justify-between text-[11px] text-faint">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  )
}

/** How she carries herself: the five presence sliders and the baseline mood she settles back to. */
export function PresencePanel({ character }: { character: CharacterProfile }) {
  const { run, error, busy } = useStageAction()
  const p = character.presence
  const set = async (patch: Partial<PresenceStyle> | { baseline: Partial<PresenceStyle['baseline']> }): Promise<boolean> => (await run(() => stageClient.setPresence(character.id, patch))).ok
  return (
    <Panel title="Presence" subtitle={`How ${character.name} carries herself`} icon={PersonStanding} area="brain">
      <Callout tone="mira" icon={Activity} title="Athletic and intelligent, meeting in authority">
        Upright and balanced, economical in gesture, a long steady gaze, a measured pace. The same words look different on different people: these sliders are what the behaviour director reads every second.
      </Callout>
      <div className="mt-3 grid gap-x-6 gap-y-3 @2xl:grid-cols-2">
        {SCALARS.map(({ key, label, low, high, hint }) => (
          <Slider key={key} label={label} low={low} high={high} hint={hint} value={p[key]} min={0} max={1} step={0.01} onCommit={(v) => set({ [key]: v })} disabled={busy} />
        ))}
      </div>
      <h3 className="mt-4 text-[13px] font-semibold text-fg">Baseline mood</h3>
      <p className="text-[11.5px] text-faint">Her mood moves with events and settles back here. Slightly positive, low arousal and high dominance reads as composed.</p>
      <div className="mt-2 grid gap-x-6 gap-y-3 @2xl:grid-cols-3">
        {(['valence', 'arousal', 'dominance'] as const).map((k) => (
          <Slider
            key={k}
            label={k[0]!.toUpperCase() + k.slice(1)}
            low="-1"
            high="+1"
            hint={k === 'valence' ? 'sad to happy' : k === 'arousal' ? 'calm to energetic' : 'yielding to commanding'}
            value={p.baseline[k]}
            min={-1}
            max={1}
            step={0.01}
            onCommit={(v) => set({ baseline: { [k]: v } })}
            disabled={busy}
          />
        ))}
      </div>
      <StageNotice error={error} />
    </Panel>
  )
}

const pctOf = (v: number): number => Math.round(((v + 1) / 2) * 100)

/** Her mood right now, as the backend holds it (valence, arousal, dominance and the closest label). */
export function MoodPanel({ snap, live }: { snap: StageSnapshot; live: StageLive | null }) {
  const mood = live?.mood ?? snap.mood
  const bars: Array<[string, number | undefined]> = [
    ['Valence', mood?.valence],
    ['Arousal', mood?.arousal],
    ['Dominance', mood?.dominance],
  ]
  return (
    <Panel title="Mood" subtitle="What the backend holds right now" icon={Activity} area="money">
      {!mood ? (
        <p className="text-[12.5px] text-muted">There is no assistant character, so there is no mood.</p>
      ) : (
        <div data-testid="stage-mood">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="mira">{mood.label}</Badge>
            {live?.idle && <Badge>{live.idle}</Badge>}
            {live?.posture && <Badge>{live.posture}</Badge>}
            {live?.speaking && <Badge tone="ok">speaking</Badge>}
            {live?.camera && <Badge title="Active camera shot">camera: {live.camera}</Badge>}
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {bars.map(([name, v]) => (
              <div key={name}>
                <div className="flex justify-between text-[11.5px] text-muted">
                  <span>{name}</span>
                  <span className="tabular-nums">{(v ?? 0).toFixed(2)}</span>
                </div>
                <div className="relative mt-0.5 h-1.5 overflow-hidden rounded-full bg-white/10" role="img" aria-label={`${name} ${(v ?? 0).toFixed(2)} on a scale from -1 to 1`}>
                  <span className="absolute inset-y-0 left-1/2 w-px bg-white/25" aria-hidden />
                  <span className="absolute inset-y-0 rounded-full bg-mira/80" style={{ left: `${Math.min(pctOf(v ?? 0), 50)}%`, width: `${Math.abs(pctOf(v ?? 0) - 50)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-faint">Silence and long hours make her sleepy (lower arousal); they never make her sulk.</p>
        </div>
      )}
    </Panel>
  )
}
