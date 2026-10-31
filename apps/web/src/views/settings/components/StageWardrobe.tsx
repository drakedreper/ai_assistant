import { Check, Save, Shirt, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { WardrobeSlot, type Asset, type CharacterProfile, type StageSnapshot } from '@ai-assistant/shared'
import { Badge, Button, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { stageClient } from '../../../stage/stageClient'
import { Callout, INPUT_CLS } from './Atoms'
import { StageNotice, assetById, licenceBlocks, licenceSummary, useStageAction } from './StageShared'

const SLOTS = WardrobeSlot.options
const WEARABLE = new Set(['hair', 'outfit', 'accessory'])
const ACTIVITIES = ['auto', 'work', 'meeting', 'relax', 'sleep', 'out'] as const

/** Is the current look this preset? (Identity slots such as hair are ignored: a preset leaves them to the character.) */
function isCurrent(c: CharacterProfile, preset: CharacterProfile['presets'][number]): boolean {
  return SLOTS.every((s) => s === 'hair' || (c.equipped[s] ?? null) === (preset.equipped[s] ?? null))
}

function LicenceLine({ asset }: { asset: Asset }) {
  const blocked = licenceBlocks(asset)
  return (
    <span className={cn('text-[11px]', blocked ? 'text-bad' : 'text-faint')} data-licence={blocked ? 'blocked' : 'ok'}>
      {blocked ? `Licence ${asset.license.id}: does not permit personal use, so it is refused` : `Licence ${asset.license.id}, ${licenceSummary(asset)}`}
      {asset.license.notes ? `. ${asset.license.notes}` : ''}
    </span>
  )
}

/** Slots with what is worn, outfit presets, the OutfitDirector's suggestion, and the items that fit her rig. */
export function WardrobePanel({ snap, character }: { snap: StageSnapshot; character: CharacterProfile }) {
  const { run, error, busy } = useStageAction()
  const assets = assetById(snap)
  const [presetName, setPresetName] = useState('')
  const [activity, setActivity] = useState<(typeof ACTIVITIES)[number]>('auto')
  const [asked, setAsked] = useState<{ presetId: string; presetName: string; explanation: string; changed: boolean } | null | undefined>(undefined)
  const isAssistant = character.id === snap.assistantCharacterId
  const suggestion = asked !== undefined ? asked : snap.outfitSuggestion

  const wearable = snap.assets
    .filter((a) => WEARABLE.has(a.kind) && (a.rigFamilies.length === 0 || a.rigFamilies.includes(character.rigFamily)))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)))
  const worn = new Set(Object.values(character.equipped).filter((v): v is string => !!v))

  return (
    <Panel title="Wardrobe" subtitle={`${character.name}: tailored, structured or athletic, always fully dressed`} icon={Shirt} area="world">
      <Callout tone="lock" icon={Check} title="A fully clothed baseline is kept">
        Taking off the last piece of a full outfit is refused, and so is any preset that would leave her half dressed. Items whose licence forbids personal use are refused too, with the reason.
      </Callout>

      <h3 className="mt-4 text-[13px] font-semibold text-fg">Wearing now</h3>
      <ul className="mt-1.5 grid gap-1.5 @2xl:grid-cols-2" data-testid="stage-slots">
        {SLOTS.map((slot) => {
          const id = character.equipped[slot] ?? null
          const a = id ? assets.get(id) : undefined
          return (
            <li key={slot} className="flex items-center gap-2 rounded-lg border border-line bg-black/15 px-2.5 py-1.5" data-slot={slot}>
              <span className="w-24 shrink-0 text-[11.5px] text-faint">{slot}</span>
              <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', a ? 'text-fg' : 'text-faint')}>{a ? a.name : 'empty'}</span>
              {a && (
                <Button variant="ghost" size="xs" disabled={busy} aria-label={`Take off ${a.name}`} onClick={() => void run(() => stageClient.unequip(character.id, slot))}>
                  Take off
                </Button>
              )}
            </li>
          )
        })}
      </ul>

      <h3 className="mt-4 text-[13px] font-semibold text-fg">Outfits</h3>
      {isAssistant && (
        <div className="mt-1.5 rounded-xl border border-mira/25 bg-mira/[0.06] px-3 py-2.5" data-testid="stage-suggestion">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles className="size-3.5 text-mira" aria-hidden />
            <span className="text-[12.5px] font-medium text-fg">What she would wear</span>
            <select
              aria-label="Context for the suggestion"
              value={activity}
              onChange={(e) => setActivity(e.target.value as (typeof ACTIVITIES)[number])}
              className="h-6 rounded-md border border-line-strong bg-black/25 px-1.5 text-[11.5px] text-fg"
            >
              {ACTIVITIES.map((a) => (
                <option key={a} value={a}>
                  {a === 'auto' ? 'from the moment' : a}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await stageClient.suggestOutfit(character.id, activity === 'auto' ? {} : { activity })
                  setAsked(r.result)
                })
              }
            >
              Ask
            </Button>
          </div>
          {suggestion ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <p className="min-w-[200px] flex-1 text-[12.5px] leading-snug text-muted">{suggestion.explanation}</p>
              {suggestion.changed && (
                <Button variant="primary" size="xs" disabled={busy} onClick={() => void run(async () => { await stageClient.applyOutfit(character.id, suggestion.presetId); setAsked(undefined) })}>
                  Wear {suggestion.presetName}
                </Button>
              )}
            </div>
          ) : (
            <p className="mt-1.5 text-[12.5px] text-muted">No outfit presets to choose from yet.</p>
          )}
        </div>
      )}
      <ul className="mt-2 flex flex-col gap-1.5" data-testid="stage-presets">
        {character.presets.map((p) => {
          const current = isCurrent(character, p)
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-black/15 px-2.5 py-1.5" data-preset={p.id}>
              <span className="min-w-[120px] flex-1 text-[12.5px] text-fg">
                {p.name}
                {current && (
                  <Badge tone="ok" className="ml-2">
                    wearing
                  </Badge>
                )}
              </span>
              <Button variant="outline" size="xs" disabled={busy || current} aria-label={`Wear the ${p.name} outfit`} onClick={() => void run(() => stageClient.applyOutfit(character.id, p.id))}>
                Wear
              </Button>
              <Button variant="ghost" size="xs" disabled={busy} aria-label={`Delete the ${p.name} outfit`} onClick={() => void run(() => stageClient.deleteOutfit(character.id, p.id))}>
                <Trash2 className="size-3" aria-hidden />
              </Button>
            </li>
          )
        })}
        {character.presets.length === 0 && <li className="text-[12.5px] text-muted">No saved outfits.</li>}
      </ul>
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const name = presetName.trim()
          if (name) void run(() => stageClient.saveOutfit(character.id, name)).then((r) => r.ok && setPresetName(''))
        }}
      >
        <input className={cn(INPUT_CLS, 'max-w-[240px]')} value={presetName} maxLength={40} placeholder="Name this look" aria-label="Name for the current look" onChange={(e) => setPresetName(e.target.value)} />
        <Button type="submit" variant="outline" disabled={busy || presetName.trim() === ''}>
          <Save className="size-3.5" aria-hidden /> Save current look
        </Button>
      </form>

      <h3 className="mt-4 text-[13px] font-semibold text-fg">Pieces that fit her</h3>
      <ul className="mt-1.5 flex max-h-[360px] flex-col gap-1.5 overflow-y-auto pr-1" data-testid="stage-wearables">
        {wearable.map((a) => (
          <li key={a.id} className="flex flex-wrap items-start gap-2 rounded-lg border border-line bg-black/15 px-2.5 py-1.5" data-asset={a.id}>
            <div className="min-w-[200px] flex-1">
              <div className="text-[12.5px] text-fg">
                {a.name} <span className="text-[11px] text-faint">{a.kind}, {a.slots.join(' + ')}</span>
              </div>
              <LicenceLine asset={a} />
            </div>
            {worn.has(a.id) ? (
              <Badge tone="ok">worn</Badge>
            ) : (
              <Button variant="outline" size="xs" disabled={busy} aria-label={`Wear ${a.name}`} onClick={() => void run(() => stageClient.equip(character.id, a.id))}>
                Wear
              </Button>
            )}
          </li>
        ))}
      </ul>
      <StageNotice error={error} />
    </Panel>
  )
}
