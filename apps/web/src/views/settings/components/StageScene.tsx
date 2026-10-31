import { Aperture, Box, Cuboid, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { StageSnapshot } from '@ai-assistant/shared'
import { Badge, Button, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { stageClient } from '../../../stage/stageClient'
import { StageNotice, assetById, licenceBlocks, useStageAction } from './StageShared'

const KIND_LABEL: Record<string, string> = { knowledge_graph: 'knowledge graph (your notes)', session_orbit: 'session orbit (Claude sessions)', timeline_ribbon: 'timeline ribbon', terminal_pane: 'terminal pane', project_cluster: 'project cluster', mail_stream: 'mail stream', finance_pulse: 'finance pulse' }

/** The cerebral space: scene presets, the objects in it, what it draws from your data, and the camera shot. */
export function ScenePanel({ snap }: { snap: StageSnapshot }) {
  const { run, error, busy } = useStageAction()
  const assets = assetById(snap)
  const scene = snap.scene
  const props = snap.assets.filter((a) => a.kind === 'prop')
  const [propId, setPropId] = useState('')
  const chosen = propId || props[0]?.id || ''
  const shots = snap.cameraShots ?? scene?.cameras.map((c) => c.id) ?? []

  if (!scene) {
    return (
      <Panel title="Scene" subtitle="The cerebral space" icon={Cuboid} area="work">
        <p className="text-[12.5px] text-muted">There is no scene yet.</p>
      </Panel>
    )
  }
  return (
    <Panel title="Scene" subtitle={`${scene.name}: an empty dark space that fills with what matters`} icon={Cuboid} area="work">
      <h3 className="text-[13px] font-semibold text-fg">Scene presets</h3>
      <div className="mt-1.5 flex flex-wrap gap-2" data-testid="stage-scene-presets">
        {snap.scenePresets.map((p) => (
          <Button key={p.id} variant={p.name === scene.name ? 'primary' : 'outline'} disabled={busy} aria-pressed={p.name === scene.name} onClick={() => void run(() => stageClient.applyScenePreset(p.id))}>
            {p.name}
          </Button>
        ))}
      </div>

      <h3 className="mt-4 text-[13px] font-semibold text-fg">Camera</h3>
      <p className="text-[11.5px] text-faint">The backend also picks the shot from context (wide when idle, medium while talking, a close-up for a beat). Picking one here holds it for a while.</p>
      <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label="Camera shots" data-testid="stage-shots">
        {shots.map((s) => (
          <Button key={s} variant={s === scene.activeCameraId ? 'primary' : 'outline'} disabled={busy} aria-pressed={s === scene.activeCameraId} data-shot={s} onClick={() => void run(() => stageClient.setCamera(s))}>
            <Aperture className="size-3.5" aria-hidden /> {s.replace('_', ' ')}
          </Button>
        ))}
      </div>

      <h3 className="mt-4 text-[13px] font-semibold text-fg">Objects</h3>
      <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="stage-objects">
        {scene.objects.map((o) => (
          <li key={o.id} className="flex items-center gap-2 rounded-lg border border-line bg-black/15 px-2.5 py-1.5" data-object={o.id}>
            <Box className="size-3.5 shrink-0 text-faint" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">
              {assets.get(o.assetId)?.name ?? o.assetId} <span className="text-[11px] text-faint">{o.id}</span>
            </span>
            <Button variant="ghost" size="xs" disabled={busy} aria-label={`Remove ${assets.get(o.assetId)?.name ?? o.id}`} onClick={() => void run(() => stageClient.removeObject(o.id))}>
              <Trash2 className="size-3" aria-hidden /> Remove
            </Button>
          </li>
        ))}
        {scene.objects.length === 0 && <li className="text-[12.5px] text-muted">Nothing placed: the void is empty on purpose.</li>}
      </ul>
      {props.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select aria-label="Object to place" value={chosen} onChange={(e) => setPropId(e.target.value)} className="h-9 min-w-[180px] rounded-lg border border-line-strong bg-black/25 px-2 text-[13px] text-fg">
            {props.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {licenceBlocks(a) ? ' (licence blocks it)' : ''}
              </option>
            ))}
          </select>
          <Button variant="outline" disabled={busy || !chosen} onClick={() => void run(() => stageClient.addObject({ assetId: chosen }))}>
            <Plus className="size-3.5" aria-hidden /> Place it
          </Button>
        </div>
      )}

      <h3 className="mt-4 text-[13px] font-semibold text-fg">What the space draws from your data</h3>
      <ul className="mt-1.5 flex flex-col gap-1" data-testid="stage-constructs">
        {scene.constructs.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-[12.5px] text-muted">
            <Badge tone="info">{c.source}</Badge> {KIND_LABEL[c.kind] ?? c.kind}
          </li>
        ))}
        {scene.constructs.length === 0 && <li className="text-[12.5px] text-muted">Nothing yet. Sessions appear as an orbit when one runs; your notes appear as a constellation.</li>}
      </ul>
      <p className="mt-1 text-[11px] text-faint">The notes shown are the sample notes of the Brain screen until the real vault exists. Terminals are never drawn here.</p>
      <StageNotice error={error} />
    </Panel>
  )
}

/** The whole catalog with the licence of every entry. Metadata only: no binary asset ships or is stored. */
export function CatalogPanel({ snap }: { snap: StageSnapshot }) {
  const order = ['character_base', 'hair', 'outfit', 'accessory', 'prop', 'environment']
  const sorted = [...snap.assets].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name))
  return (
    <Panel title="Catalog and licences" subtitle={`${snap.assets.length} entries, metadata only`} icon={Box} area="money">
      <p className="text-[12.5px] leading-snug text-muted">
        Every asset carries its licence. The daemon refuses to put on, place or share an asset whose licence does not allow it, and an unknown licence is refused for everything. The entries below are placeholders for the content pack you install; real assets bring their own records.
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-[13px] font-medium text-fg">Show every entry</summary>
        <ul className="mt-2 flex max-h-[420px] flex-col gap-1.5 overflow-y-auto pr-1" data-testid="stage-catalog">
          {sorted.map((a) => (
            <li key={a.id} className="rounded-lg border border-line bg-black/15 px-2.5 py-1.5 text-[12px]" data-asset={a.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-fg">{a.name}</span>
                <Badge>{a.kind.replace('_', ' ')}</Badge>
                {licenceBlocks(a) && <Badge tone="bad">licence blocks use</Badge>}
              </div>
              <div className={cn('mt-0.5', licenceBlocks(a) ? 'text-bad' : 'text-faint')}>
                {a.license.id}: {a.license.personalUse ? 'personal' : 'no personal use'}, {a.license.commercialUse ? 'commercial' : 'no commercial use'}, {a.license.redistribution ? 'redistributable' : 'not redistributable'}
                {a.license.adultExpression === undefined ? '' : a.license.adultExpression ? ', author permits adult expression' : ', author does not permit adult expression'}
                {a.license.notes ? `. ${a.license.notes}` : ''}
              </div>
            </li>
          ))}
        </ul>
      </details>
    </Panel>
  )
}
