import { Clock, Lock, Mic, Plus, Sparkles, UserRound, Volume2, X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../../api'
import { NoteChip } from '../../../components/NoteChip'
import { Badge, Button, Panel, Segmented } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { useSnap } from '../../../state/store'
import { composeBoundaries, customBoundaries, describeVibe, LOCKED_BOUNDARIES, previewLines, type Vibe } from '../lib'
import { Callout, INPUT_CLS, SectionHeader, SettingRow } from './Atoms'
import { RangeStyles, VibeSlider } from './Range'
import { Switch } from './Switch'

const VIBES: Array<{ key: keyof Vibe; label: string; low: string; high: string; hint: string }> = [
  { key: 'warmth', label: 'Warmth', low: 'Reserved', high: 'Warm', hint: 'How much care shows in the way she talks.' },
  { key: 'playfulness', label: 'Playfulness', low: 'Serious', high: 'Playful', hint: 'Dry wit and the odd joke, or none.' },
  { key: 'directness', label: 'Directness', low: 'Gentle', high: 'Blunt', hint: 'How plainly she tells you when she disagrees.' },
  { key: 'proactivity', label: 'Proactivity', low: 'Only when asked', high: 'Nudges ahead', hint: 'How often she speaks up without being asked.' },
]

const VOICES = [
  { value: 'kokoro', label: 'Kokoro', where: 'Local', tone: 'ok', text: 'Speaks on this PC. Nothing leaves it.' },
  { value: 'elevenlabs', label: 'ElevenLabs', where: 'Cloud', tone: 'warn', text: 'More expressive, but each sentence she speaks is sent to the provider.' },
  { value: 'off', label: 'Off', where: 'Silent', tone: 'neutral', text: 'Text only. She never speaks aloud.' },
] as const

function Identity() {
  const persona = useSnap((d) => d.settings.persona)
  const [name, setName] = useState(persona.name)
  const [tagline, setTagline] = useState(persona.tagline)
  return (
    <Panel title="Identity" subtitle="What she is called and how she introduces herself" icon={UserRound}>
      <div className="grid gap-3 @xl:grid-cols-[180px_minmax(0,1fr)]">
        <label className="block">
          <span className="mb-1 block text-[12px] text-muted">Name</span>
          <input
            className={INPUT_CLS}
            value={name}
            maxLength={24}
            onChange={(e) => {
              setName(e.target.value)
              if (e.target.value.trim()) void api.updatePersona({ name: e.target.value.trim() })
            }}
            aria-invalid={!name.trim()}
          />
          {!name.trim() && <span className="mt-1 block text-[11px] text-bad">She needs a name.</span>}
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-muted">Tagline</span>
          <input
            className={INPUT_CLS}
            value={tagline}
            maxLength={90}
            onChange={(e) => {
              setTagline(e.target.value)
              void api.updatePersona({ tagline: e.target.value })
            }}
          />
        </label>
      </div>
    </Panel>
  )
}

function Vibes() {
  const vibe = useSnap((d) => d.settings.persona.vibe)
  return (
    <Panel title="Vibe" subtitle="Four sliders. Changes apply live and show in the preview" icon={Sparkles}>
      <RangeStyles />
      <div className="grid gap-x-8 gap-y-5 @xl:grid-cols-2">
        {VIBES.map((v) => (
          <VibeSlider
            key={v.key}
            label={v.label}
            low={v.low}
            high={v.high}
            hint={v.hint}
            value={vibe[v.key]}
            onChange={(n) => void api.updatePersona({ vibe: { ...vibe, [v.key]: n } })}
          />
        ))}
      </div>
      <p className="mt-4 text-[12px] leading-snug text-faint">Sliders compile into her persona prompt. They steer tone only; they never change what she is allowed to do.</p>
    </Panel>
  )
}

function Preview({ className }: { className?: string }) {
  const persona = useSnap((d) => d.settings.persona)
  const lines = previewLines(persona.vibe, persona.name || 'Mira')
  return (
    <Panel title="Live preview" subtitle="How she would sound right now" icon={Sparkles} area="brain" className={className}>
      <div className="flex items-center gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-mira to-brain text-[16px] font-black text-canvas" aria-hidden>
          {(persona.name || 'M').slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-fg">{persona.name || 'Unnamed'}</div>
          <div className="truncate text-[12px] text-muted">{persona.tagline}</div>
        </div>
      </div>
      <p className="mt-2.5 text-[12px] text-muted">
        Right now she sounds <span className="font-medium text-fg" aria-live="polite">{describeVibe(persona.vibe)}</span>.
      </p>
      <ul className="mt-3 flex flex-col gap-3" aria-live="polite">
        {lines.map((l) => (
          <li key={l.id}>
            <div className="mb-1 text-[11px] text-faint">{l.label}</div>
            <div className="rounded-2xl rounded-tl-md border border-line bg-white/[0.05] px-3 py-2 text-[13px] leading-relaxed text-fg">{l.text}</div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] leading-snug text-faint">Canned lines for the mockup. The real persona is generated from these settings.</p>
    </Panel>
  )
}

function Boundaries() {
  const all = useSnap((d) => d.settings.persona.boundaries)
  const custom = customBoundaries(all)
  const [draft, setDraft] = useState('')
  const save = (next: string[]) => void api.updatePersona({ boundaries: composeBoundaries(next) })
  const add = () => {
    const t = draft.trim()
    if (!t || custom.includes(t)) return
    save([...custom, t])
    setDraft('')
  }
  return (
    <Panel title="Boundaries" subtitle="Plain-language rules she always follows" icon={Lock}>
      <ul className="flex flex-col gap-1.5">
        {LOCKED_BOUNDARIES.map((b) => (
          <li key={b} className="flex items-start gap-2.5 rounded-lg border border-line bg-white/[0.025] px-3 py-2">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
            <span className="flex-1 text-[13px] text-fg">{b}</span>
            <Badge title="Shipped as a default. It cannot be removed.">Locked default</Badge>
          </li>
        ))}
        {custom.map((b) => (
          <li key={b} className="group flex items-start gap-2.5 rounded-lg border border-line px-3 py-2">
            <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-mira" aria-hidden />
            <span className="flex-1 text-[13px] text-fg">{b}</span>
            <button
              type="button"
              aria-label={`Remove boundary: ${b}`}
              onClick={() => save(custom.filter((x) => x !== b))}
              className="grid size-6 cursor-pointer place-items-center rounded-md text-faint transition hover:bg-bad/15 hover:text-bad"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input className={INPUT_CLS} placeholder="Add a boundary, e.g. Never schedule anything on Sundays." value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="New boundary" maxLength={140} />
        <Button type="submit" variant="outline" size="md" disabled={!draft.trim()}>
          <Plus className="size-4" aria-hidden /> Add
        </Button>
      </form>
    </Panel>
  )
}

function QuietAndVoice() {
  const persona = useSnap((d) => d.settings.persona)
  const { quietHours, voice } = persona
  const current = VOICES.find((v) => v.value === voice.provider)
  return (
    <div className="grid gap-3 @2xl:grid-cols-2">
      <Panel title="Quiet hours" subtitle="She stays silent unless something is urgent" icon={Clock}>
        <div className="flex items-end gap-3">
          {(['from', 'to'] as const).map((k) => (
            <label key={k} className="block flex-1">
              <span className="mb-1 block text-[12px] text-muted">{k === 'from' ? 'From' : 'Until'}</span>
              <input
                type="time"
                value={quietHours[k]}
                onChange={(e) => e.target.value && void api.updatePersona({ quietHours: { ...quietHours, [k]: e.target.value } })}
                className={cn(INPUT_CLS, '[color-scheme:dark] tabular-nums')}
              />
            </label>
          ))}
        </div>
        <p className="mt-3 text-[12px] leading-snug text-muted">During quiet hours her Room goes dim and she sleeps. Approvals still queue; nothing is sent.</p>
      </Panel>

      <Panel title="Voice" subtitle={`Voice: ${voice.voiceName}`} icon={Volume2}>
        <Segmented
          ariaLabel="Voice provider"
          value={voice.provider}
          onChange={(v) => void api.updatePersona({ voice: { ...voice, provider: v } })}
          options={VOICES.map((v) => ({ value: v.value, label: v.label }))}
          className="w-full [&>button]:flex-1"
        />
        <p className="mt-2 flex min-h-[2.5em] items-start gap-2 text-[12px] leading-snug text-muted">
          {current && <Badge tone={current.tone}>{current.where}</Badge>}
          <span>{current?.text}</span>
        </p>
        <SettingRow
          className="mt-1 border-t border-line pt-3 pb-0"
          label={
            <span className="inline-flex items-center gap-1.5">
              <Mic className="size-3.5 text-muted" aria-hidden /> Push to talk
            </span>
          }
          hint={voice.pushToTalk ? 'The mic opens only while you hold the key.' : 'Tap once to open the mic, tap again to close it.'}
        >
          <Switch checked={voice.pushToTalk} onChange={(v) => void api.updatePersona({ voice: { ...voice, pushToTalk: v } })} label="Push to talk" />
        </SettingRow>
      </Panel>
    </div>
  )
}

/** PERSONA: identity, vibe sliders with a live preview, boundaries, quiet hours and voice. */
export function PersonaSection() {
  return (
    <div className="@container flex flex-col gap-3">
      <SectionHeader icon={UserRound} title="Persona">
        She is warm, playful and sharp, and always honest that she is an AI. Tune how she sounds here.
      </SectionHeader>
      <Callout tone="mira" icon={Sparkles} title="Edits are data, not code">
        <span>
          Today these changes apply straight away because this is a preview. Once the vault exists, persona edits arrive as proposals you approve, since her
          character lives in a note you own:{' '}
        </span>
        <NoteChip path="00-core/persona.md" title="Persona" />
      </Callout>
      <div className="grid items-start gap-3 @4xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="flex min-w-0 flex-col gap-3">
          <Identity />
          <Vibes />
          <div className="@4xl:hidden">
            <Preview />
          </div>
          <Boundaries />
          <QuietAndVoice />
        </div>
        <div className="hidden @4xl:sticky @4xl:top-0 @4xl:block">
          <Preview />
        </div>
      </div>
    </div>
  )
}
