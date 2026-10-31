import { Drama, Plug, Unplug, UserRound } from 'lucide-react'
import { useEffect } from 'react'
import { StatusDot } from '../../../components/ui'
import { Badge, Button, EmptyState, Panel } from '../../../components/ui'
import { useApiMode } from '../../../api'
import { DRAFT_STAGE_CAPABILITIES, DRAFT_STAGE_DOES_NOT, DRAFT_STAGE_DRAWS } from '../../../stage/draftStage'
import { useStageFeed } from '../../../stage/feed'
import { stageClient } from '../../../stage/stageClient'
import { cn } from '../../../lib/cn'
import type { StageCapabilities, StageSnapshot } from '@ai-assistant/shared'
import { Callout, SectionHeader, SettingRow } from './Atoms'
import { RangeStyles } from './Range'
import { Switch } from './Switch'
import { AppearancePanel } from './StageAppearance'
import { MoodPanel, PresencePanel } from './StagePresence'
import { CatalogPanel, ScenePanel } from './StageScene'
import { StageNotice, useSelectedCharacter, useStageAction, useStageUi } from './StageShared'
import { WardrobePanel } from './StageWardrobe'

/** The small connection dot beside "Stage" in the Settings navigation. */
export function StageNavBadge() {
  const connected = useStageFeed((s) => s.live?.connected ?? s.snapshot?.stage.connected ?? false)
  const daemon = useApiMode() === 'daemon'
  if (!daemon || !connected) return null
  return (
    <span role="img" aria-label="A stage is connected" title="A stage is connected">
      <StatusDot color="var(--color-ok)" pulse className="size-1.5" />
    </span>
  )
}

function CapabilityList({ caps }: { caps: StageCapabilities }) {
  const yes = (b: boolean) => (b ? 'yes' : 'no')
  const rows: Array<[string, string]> = [
    ['Rigs', caps.rigFamilies.length > 0 ? caps.rigFamilies.join(', ') : 'none'],
    ['Face', [caps.face.arkit52 && 'ARKit-52 weights', caps.face.visemes && 'visemes', caps.face.audioToFaceOnStage && 'own audio-to-face'].filter(Boolean).join(', ') || 'none'],
    ['Strand hair / cloth', `${yes(caps.render.strandHair)} / ${yes(caps.render.clothSim)}`],
    ['Runtime asset loading', yes(caps.render.runtimeAssetLoading)],
    ['Embedded stream', yes(caps.render.embeddedStream)],
    ['Tracking (face, body)', `${yes(caps.tracking.face)}, ${yes(caps.tracking.body)}`],
    ['Constructs', caps.constructs.length > 0 ? caps.constructs.join(', ') : 'none'],
    ['Characters at once', String(caps.maxCharacters)],
  ]
  return (
    <dl className="grid gap-x-4 gap-y-1 text-[12.5px] @xl:grid-cols-[170px_minmax(0,1fr)]" data-testid="stage-capabilities">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-faint">{k}</dt>
          <dd className="text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function ConnectionPanel({ snap }: { snap: StageSnapshot }) {
  const live = useStageFeed((s) => s.live)
  const { run, error, busy } = useStageAction()
  const st = snap.stage
  return (
    <Panel
      title="Stage connection"
      subtitle="The renderer that shows her: an engine, or the simulator"
      icon={Plug}
      area="work"
      actions={
        st.connected ? (
          <Button variant="outline" size="xs" disabled={busy} onClick={() => void run(() => stageClient.disconnect())}>
            <Unplug className="size-3" aria-hidden /> Disconnect
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2" data-testid="stage-status">
        <Badge tone={st.connected ? 'ok' : 'neutral'}>{st.connected ? 'Connected' : 'Not connected'}</Badge>
        {st.connected && st.engine && <Badge tone="info">{st.engine}</Badge>}
        {st.connected && st.capabilities && <span className="text-[12px] text-muted">{st.capabilities.engineVersion}</span>}
        {live?.perf && <span className="text-[11.5px] text-faint tabular-nums">{Math.round(live.perf.fps)} fps, {Math.round(live.perf.vramMb)} MB VRAM</span>}
      </div>
      {st.connected && st.capabilities ? (
        <div className="mt-3">
          <CapabilityList caps={st.capabilities} />
        </div>
      ) : (
        <p className="mt-2 text-[12.5px] leading-snug text-muted">
          No engine is attached. She still lives in the backend (mood, wardrobe, scene, memory) and the draft room below follows her. An engine or the simulator connects to <code className="text-fg">ws://127.0.0.1:PORT/ws/stage</code> with the stage token, which lives in <code className="text-fg">secrets.json</code> in the daemon&apos;s data folder and is never shown here.
        </p>
      )}
      <p className="mt-2 text-[11.5px] text-faint">One stage at a time: a second connection is refused until this one closes.</p>

      <div className="mt-3 rounded-xl border border-line bg-black/15 px-3 py-2.5" data-testid="stage-draft-room">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-fg">Room (draft stage)</span>
          <Badge tone="warn">limited</Badge>
          <span className="text-[11.5px] text-faint">{DRAFT_STAGE_CAPABILITIES.engineVersion}</span>
        </div>
        <p className="mt-1 text-[12px] leading-snug text-muted">
          Draws: {DRAFT_STAGE_DRAWS.join('; ')}. Does not draw: {DRAFT_STAGE_DOES_NOT.join('; ')}. It follows the backend&apos;s performance feed, not the stage socket.
        </p>
      </div>
      <StageNotice error={error} />
    </Panel>
  )
}

function CharactersPanel({ snap }: { snap: StageSnapshot }) {
  const { run, error, busy } = useStageAction()
  const select = useStageUi((s) => s.select)
  const shown = useSelectedCharacter(snap)
  const base = (id: string) => snap.assets.find((a) => a.id === id)?.name ?? id
  const groups: Array<{ role: 'assistant' | 'user'; title: string; activeId: string | null }> = [
    { role: 'assistant', title: 'Her', activeId: snap.assistantCharacterId },
    { role: 'user', title: 'You', activeId: snap.userCharacterId },
  ]
  return (
    <Panel title="Characters" subtitle="Who is on stage, and which one the panels below edit" icon={UserRound} area="life">
      <div className="grid gap-3 @2xl:grid-cols-2">
        {groups.map((g) => (
          <div key={g.role}>
            <h3 className="text-[13px] font-semibold text-fg">{g.title}</h3>
            <ul className="mt-1.5 flex flex-col gap-1.5" data-testid={`stage-characters-${g.role}`}>
              {snap.characters
                .filter((c) => c.role === g.role)
                .map((c) => (
                  <li key={c.id} className={cn('flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5', shown?.id === c.id ? 'border-mira/40 bg-mira/[0.06]' : 'border-line bg-black/15')} data-character={c.id}>
                    <button type="button" onClick={() => select(c.id)} aria-pressed={shown?.id === c.id} className="min-w-[140px] flex-1 cursor-pointer text-left">
                      <span className="block text-[13px] font-medium text-fg">{c.name}</span>
                      <span className="block truncate text-[11px] text-faint">{base(c.baseAssetId)}</span>
                    </button>
                    {g.activeId === c.id ? (
                      <Badge tone="ok">active</Badge>
                    ) : (
                      <Button variant="outline" size="xs" disabled={busy} onClick={() => void run(() => stageClient.selectCharacter(c.id))}>
                        Make active
                      </Button>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11.5px] text-faint">Your representation is an abstract form: no face is modelled and nothing here uses the camera.</p>
      <StageNotice error={error} />
    </Panel>
  )
}

function Loaded({ snap }: { snap: StageSnapshot }) {
  const live = useStageFeed((s) => s.live)
  const character = useSelectedCharacter(snap)
  return (
    <>
      <div className="grid gap-3 @3xl:grid-cols-2">
        <ConnectionPanel snap={snap} />
        <MoodPanel snap={snap} live={live} />
      </div>
      <CharactersPanel snap={snap} />
      {character ? (
        <>
          <AppearancePanel snap={snap} character={character} />
          <PresencePanel character={character} />
          <WardrobePanel snap={snap} character={character} />
        </>
      ) : (
        <EmptyState title="No characters yet" hint="The first start creates the default assistant and your abstract presence." />
      )}
      <ScenePanel snap={snap} />
      <CatalogPanel snap={snap} />
    </>
  )
}

/**
 * STAGE: the live 3D assistant's backend. The character, her wardrobe and the space she lives in belong to the daemon;
 * a replaceable stage (Unreal, Unity, the simulator, the draft room) shows them. Daemon mode only: the mockup has no
 * stage backend, so it says so instead of showing anything made up.
 */
export function StageSection() {
  const daemon = useApiMode() === 'daemon'
  const snap = useStageFeed((s) => s.snapshot)
  const error = useStageFeed((s) => s.error)
  const { run, error: switchError, busy } = useStageAction()

  useEffect(() => {
    if (daemon) void useStageFeed.getState().refresh()
  }, [daemon])

  return (
    <div className="@container flex flex-col gap-3">
      <RangeStyles />
      <SectionHeader icon={Drama} title="Stage">
        The long-term interface is a live 3D assistant in an empty cerebral space. Her body, wardrobe, mood and memory belong to the daemon; any stage can show them. Every character is an adult, and she is always fully dressed.
      </SectionHeader>

      {!daemon ? (
        <Callout tone="info" icon={Plug} title="Needs the daemon">
          This is the mockup, so there is no stage backend to show: the characters, wardrobe, scene and mood live in the daemon. Start it (<code className="text-fg">pnpm --filter @ai-assistant/daemon start</code>) and open its sign-in link, and this tab becomes live.
        </Callout>
      ) : !snap ? (
        <p className="px-1 text-[12.5px] text-muted" role="status">
          {error ?? 'Loading the stage...'}
        </p>
      ) : (
        <>
          <Panel title="Stage backend" subtitle="On by default; switching it off disconnects the stage" icon={Drama} area="world">
            <SettingRow className="py-0" label={snap.enabled ? 'On' : 'Off'} hint="While it is off, no stage can connect, the stage tools are unavailable to her and nothing is sent to a stage. Her data stays.">
              <Switch checked={snap.enabled} onChange={(on) => void run(() => stageClient.setEnabled(on))} label="Stage backend" disabled={busy} />
            </SettingRow>
            <StageNotice error={switchError} />
          </Panel>
          {snap.enabled ? (
            <Loaded snap={snap} />
          ) : (
            <Callout tone="info" icon={Plug} title="The stage is off">
              Turn it on to see her characters, wardrobe, scene and mood.
            </Callout>
          )}
        </>
      )}
    </div>
  )
}
