import { Gauge, Palette, UserRound } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { CharacterProfile, MorphParam, StageSnapshot } from '@ai-assistant/shared'
import { Badge, Panel } from '../../../components/ui'
import { stageClient } from '../../../stage/stageClient'
import { Callout, SettingRow } from './Atoms'
import { StageNotice, useStageAction } from './StageShared'

const GROUP_LABEL: Record<string, string> = { face: 'Face', eyes: 'Eyes', nose: 'Nose', mouth: 'Mouth', body: 'Body', skin: 'Skin', hair: 'Hair', makeup: 'Makeup', other: 'Other' }
const GROUP_ORDER = ['body', 'face', 'eyes', 'nose', 'mouth', 'skin', 'hair', 'makeup', 'other']

const hex = (v: number | string | undefined, fallback: number): string => (typeof v === 'string' ? v : `#${Math.trunc(typeof v === 'number' ? v : fallback).toString(16).padStart(6, '0')}`)
const fmt = (n: number): string => (Math.abs(n) >= 10 ? String(Math.round(n * 10) / 10) : String(Math.round(n * 100) / 100))

/**
 * One morph slider. The range input can only reach the declared range; the number box lets you TYPE a value, so the
 * daemon's refusal of an out-of-range or non-adult value is something you can see (and it says why).
 */
function ParamSlider({ def, value, onCommit, disabled }: { def: MorphParam; value: number; onCommit: (id: string, v: number) => Promise<boolean>; disabled: boolean }) {
  const id = useId()
  const [local, setLocal] = useState(value)
  const [text, setText] = useState(fmt(value))
  useEffect(() => {
    setLocal(value)
    setText(fmt(value))
  }, [value])
  const span = def.max - def.min
  const step = span > 20 ? 1 : span > 2 ? 0.05 : 0.01
  const commit = async (v: number): Promise<void> => {
    if (!Number.isFinite(v) || v === value) {
      setLocal(value)
      setText(fmt(value))
      return
    }
    const ok = await onCommit(def.id, v)
    if (!ok) {
      setLocal(value)
      setText(fmt(value))
    }
  }
  const pct = span > 0 ? ((local - def.min) / span) * 100 : 0
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="truncate text-[12.5px] font-medium text-fg">
          {def.label}
        </label>
        <input
          type="number"
          inputMode="decimal"
          aria-label={`${def.label}, type a value`}
          data-param={def.id}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit(Number(text))
          }}
          onBlur={() => {
            if (text !== fmt(value)) void commit(Number(text))
          }}
          className="h-6 w-[72px] rounded-md border border-line-strong bg-black/25 px-1.5 text-right text-[12px] text-fg tabular-nums focus:border-mira/60 focus:outline-none"
        />
      </div>
      <input
        id={id}
        type="range"
        min={def.min}
        max={def.max}
        step={step}
        value={local}
        disabled={disabled}
        onChange={(e) => {
          setLocal(Number(e.target.value))
          setText(fmt(Number(e.target.value)))
        }}
        onPointerUp={() => void commit(local)}
        onKeyUp={() => void commit(local)}
        className="vibe-range mt-1"
        style={{ ['--pct' as string]: `${pct}%` }}
        aria-valuetext={`${fmt(local)}, allowed ${fmt(def.min)} to ${fmt(def.max)}`}
      />
      <div className="flex justify-between text-[10.5px] text-faint tabular-nums">
        <span>{fmt(def.min)}</span>
        <span>allowed range</span>
        <span>{fmt(def.max)}</span>
      </div>
    </div>
  )
}

function ColourParam({ def, value, onCommit, disabled }: { def: MorphParam; value: string; onCommit: (id: string, v: string) => Promise<boolean>; disabled: boolean }) {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  return (
    <SettingRow className="py-1" label={def.label}>
      <input
        type="color"
        aria-label={def.label}
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local !== value) void onCommit(def.id, local).then((ok) => ok || setLocal(value))
        }}
        className="h-7 w-12 cursor-pointer rounded-md border border-line-strong bg-transparent"
      />
    </SettingRow>
  )
}

/** The character's morph parameters, as sliders with the ranges the base allows (every character is an adult). */
export function AppearancePanel({ snap, character }: { snap: StageSnapshot; character: CharacterProfile }) {
  const { run, error, busy } = useStageAction()
  const base = snap.assets.find((a) => a.id === character.baseAssetId)
  const params = base?.params ?? []
  const groups = GROUP_ORDER.map((g) => ({ g, items: params.filter((p) => p.group === g) })).filter((x) => x.items.length > 0)
  const abstract = base?.tags.includes('abstract')

  const commit = async (id: string, v: number | string): Promise<boolean> => (await run(() => stageClient.setParams(character.id, { [id]: v }))).ok

  return (
    <Panel title="Appearance" subtitle={`${character.name}${base ? `, ${base.name}` : ''}`} icon={UserRound} area="life">
      <Callout tone="lock" icon={Gauge} title="Adult proportions, always">
        Every character is an adult. The sliders only reach adult ranges (apparent age, height, head scale, jaw and eye size, leg length), and the combination is checked as a whole. Typing a value outside the range is refused, not clamped.
      </Callout>
      {abstract && (
        <p className="mt-2 text-[12px] text-muted">
          <Badge tone="info">Abstract presence</Badge> This character is a faceless form. No face is modelled and no face capture is used or needed.
        </p>
      )}
      <div className="mt-3 flex flex-col gap-2">
        {groups.map(({ g, items }) => (
          <details key={g} open={g === 'body'} className="rounded-xl border border-line bg-black/15 px-3 py-2">
            <summary className="flex cursor-pointer items-center gap-2 text-[13px] font-semibold text-fg">
              {g === 'skin' || g === 'hair' || g === 'makeup' ? <Palette className="size-3.5 text-faint" aria-hidden /> : null}
              {GROUP_LABEL[g] ?? g}
              <span className="text-[11px] font-normal text-faint">{items.length}</span>
            </summary>
            <div className="mt-2 grid gap-x-5 gap-y-3 @2xl:grid-cols-2">
              {items.map((def) =>
                def.type === 'color' ? (
                  <ColourParam key={def.id} def={def} value={hex(character.params[def.id], def.default)} onCommit={commit} disabled={busy} />
                ) : (
                  <ParamSlider key={def.id} def={def} value={typeof character.params[def.id] === 'number' ? (character.params[def.id] as number) : def.default} onCommit={commit} disabled={busy} />
                ),
              )}
            </div>
          </details>
        ))}
        {groups.length === 0 && <p className="text-[12.5px] text-muted">This character has no adjustable parameters.</p>}
      </div>
      <StageNotice error={error} />
    </Panel>
  )
}
