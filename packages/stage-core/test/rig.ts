import {
  InMemorySceneRepo,
  createCharacterService,
  createMemoryTransportPair,
  createSceneService,
  createSeedCatalog,
  createSequentialIds,
  createSimulatorStage,
  createStageSession,
  createVirtualTime,
  seedBaseId,
  InMemoryCharacterRepo,
  createWardrobeService,
  StageMirror,
} from '../src'
import type { CommandDraft, SimulatorOptions, StageSessionOptions } from '../src'
import { T0 } from './helpers'

export interface RigOptions {
  start?: number
  latencyMs?: number
  sim?: Partial<Omit<SimulatorOptions, 'transport' | 'clock' | 'timers'>>
  session?: Partial<Omit<StageSessionOptions, 'transport' | 'clock' | 'timers' | 'newId'>>
  /** Do not start the simulator (the test drives the stage end by hand). */
  noStart?: boolean
  vt?: ReturnType<typeof createVirtualTime>
  mirror?: StageMirror
}

/** A backend session wired to a simulator stage over an in-memory transport on virtual time. */
export async function makeRig(opts: RigOptions = {}) {
  const vt = opts.vt ?? createVirtualTime(opts.start ?? T0)
  const pair = createMemoryTransportPair({ timers: vt.timers, latencyMs: opts.latencyMs ?? 0 })
  const newId = createSequentialIds()
  const session = createStageSession({
    transport: pair.backend,
    clock: vt.clock,
    timers: vt.timers,
    newId,
    ...(opts.mirror ? { mirror: opts.mirror } : {}),
    ...opts.session,
  })
  const sim = createSimulatorStage({ transport: pair.stage, clock: vt.clock, timers: vt.timers, ...opts.sim })
  if (!opts.noStart) {
    sim.start()
    if (opts.latencyMs) vt.advance(opts.latencyMs)
    await session.ready()
  }
  /** Send and advance virtual time so latency-modelled work completes. */
  const send = async (draft: CommandDraft, advanceMs = 0) => {
    const p = session.send(draft)
    if (advanceMs > 0) vt.advance(advanceMs)
    return p
  }
  return { vt, pair, session, sim, send, newId }
}

/** The full backend (services over the seed catalog) plus a loaded stage. */
export async function makeWorldRig(opts: RigOptions = {}) {
  const rig = await makeRig(opts)
  const catalog = createSeedCatalog()
  const repo = new InMemoryCharacterRepo()
  const characters = createCharacterService({ repo, catalog, clock: rig.vt.clock, newId: rig.newId })
  const scenes = createSceneService({ repo: new InMemorySceneRepo(), catalog, clock: rig.vt.clock, newId: rig.newId })
  const wardrobe = createWardrobeService({ characters, catalog, newId: rig.newId })
  const created = characters.create({ name: 'Mira', baseAssetId: seedBaseId('vrm1') })
  if (!created.ok) throw new Error(created.error)
  scenes.ensureVoid()
  return { ...rig, catalog, characters, scenes, wardrobe, assistant: created.value }
}

/** Load the assistant and the scene onto the stage, advancing virtual time for asset latency. */
export async function loadAll(r: Awaited<ReturnType<typeof makeWorldRig>>): Promise<void> {
  const c = r.characters.loadCommand(r.assistant.id)
  if (!c.ok) throw new Error(c.error)
  const s = r.scenes.loadCommand()
  if (!s.ok) throw new Error(s.error)
  const p1 = r.session.send(c.value)
  const p2 = r.session.send(s.value)
  r.vt.advance(2000)
  const [a, b] = await Promise.all([p1, p2])
  if (!a.ok || !b.ok) throw new Error(`load failed: ${a.reason} ${b.reason}`)
}

/** Let promise continuations run (the code under test resolves promises, it never waits on real time). */
export async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}
