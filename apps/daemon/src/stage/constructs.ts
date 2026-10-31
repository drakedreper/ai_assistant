import type { Session, Project } from '@ai-assistant/shared'
import { buildSnapshot } from '@ai-assistant/shared/fixtures'
import { buildKnowledgeGraph, sessionOrbit, type CommandDraft, type ConstructDataSync, type GraphNoteInput, type SceneService } from '@ai-assistant/stage-core'

/**
 * Construct feeds: the app's own data becomes places in the space, as MINIMAL `scene.data` diffs.
 *
 *   sessions (the Work screen)  ->  `construct.sessions`, a session_orbit: Claude sessions orbit their project
 *   notes (the second brain)    ->  `construct.brain`, a knowledge_graph with a computed 3D layout
 *
 * A construct exists in the working scene only while it has something to show (the void stays mostly empty on purpose:
 * things appear when they matter and recede when they do not): the orbit appears with the first session and goes a
 * minute after the last one is gone; the graph appears with the first note. The first push to a stage is a full
 * replace; later pushes carry only what changed (ConstructDataSync), and nothing at all when nothing changed.
 *
 * Data flows one way and only as aggregates the dashboards already show: no terminal bytes, no mail, no money. The
 * brain notes are the FIXTURE notes until the real vault exists (Phase 2): the same ones the Brain screen shows.
 */

export const SESSIONS_CONSTRUCT_ID = 'construct.sessions'
export const BRAIN_CONSTRUCT_ID = 'construct.brain'

/** How long an empty session orbit stays in the scene before it is removed. */
export const ORBIT_LINGER_MS = 60_000
/** The knowledge graph (a layout of every note) is recomputed at most this often. */
const GRAPH_TTL_MS = 10 * 60_000

export interface ConstructFeedDeps {
  scenes: SceneService
  sync: ConstructDataSync
  store: { listSessions(): Session[]; listProjects(): Project[] }
  /** The notes to draw. Default: the fixture notes of @ai-assistant/shared (what the Brain screen shows). */
  notes?: () => GraphNoteInput[]
  /** Deliver commands to the stage (and nowhere else). */
  send: (commands: CommandDraft[]) => void
  clock: () => number
}

const IDENT: [number, number, number, number] = [0, 0, 0, 1]

export class ConstructFeed {
  private dirty = true
  private lastRefreshAt = Number.NEGATIVE_INFINITY
  private readonly emptySince = new Map<string, number>()
  private graph: { at: number; key: string; nodes: ReturnType<typeof buildKnowledgeGraph>['nodes']; edges: ReturnType<typeof buildKnowledgeGraph>['edges'] } | undefined

  constructor(private readonly d: ConstructFeedDeps) {}

  /** Something the feeds read changed (a session update, a reset): recompute soon. */
  markDirty(): void {
    this.dirty = true
  }

  /** Forget what the stage was told (a new connection, a scene replaced): the next refresh is a full replace. */
  reset(): void {
    this.d.sync.reset()
    this.dirty = true
  }

  private notes(): GraphNoteInput[] {
    if (this.d.notes) return this.d.notes()
    const snap = buildSnapshot(new Date(this.d.clock()))
    return snap.notes.map((n) => ({ id: n.path, title: n.title, layer: n.layer, importance: n.importance, body: n.body }))
  }

  /** Recompute when dirty or every `everyMs`. Returns the commands it sent (for tests). */
  maybeRefresh(everyMs: number): CommandDraft[] {
    const now = this.d.clock()
    if (!this.dirty && now - this.lastRefreshAt < everyMs) return []
    return this.refresh()
  }

  refresh(): CommandDraft[] {
    const now = this.d.clock()
    this.dirty = false
    this.lastRefreshAt = now
    const out: CommandDraft[] = []
    try {
      out.push(...this.sessionsFeed(now))
      out.push(...this.brainFeed(now))
    } catch {
      // a feed must never break the loop it runs in
    }
    if (out.length > 0) this.d.send(out)
    return out
  }

  /** Make a construct exist (or not) in the working scene; returns the commands that mirror it. */
  private ensure(id: string, kind: 'session_orbit' | 'knowledge_graph', want: boolean, now: number, position: [number, number, number], source: 'work' | 'brain'): CommandDraft[] {
    const { scenes } = this.d
    const have = scenes.getConstruct(id) !== undefined
    if (want) {
      this.emptySince.delete(id)
      if (have) return []
      const r = scenes.addConstruct({
        id,
        kind,
        transform: { position, rotation: IDENT, scale: [1, 1, 1] },
        source,
        query: {},
        style: { palette: 'cool', density: 0.5, scale: 1 },
        interactive: true,
      })
      return r.ok ? r.value.commands : []
    }
    if (!have) return []
    const since = this.emptySince.get(id) ?? now
    this.emptySince.set(id, since)
    if (now - since < ORBIT_LINGER_MS) return []
    this.emptySince.delete(id)
    this.d.sync.forget(id)
    const r = scenes.removeConstruct(id)
    return r.ok ? r.value.commands : []
  }

  private sessionsFeed(now: number): CommandDraft[] {
    const sessions = this.d.store.listSessions()
    const projects = this.d.store.listProjects()
    const orbit = sessionOrbit(
      sessions.map((s) => ({ id: s.id, projectId: s.projectId, title: s.title, status: s.status, agents: s.agents.map((a) => ({ id: a.id, parentId: a.parentId, type: a.type, status: a.status })) })),
      projects.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    )
    const out = this.ensure(SESSIONS_CONSTRUCT_ID, 'session_orbit', sessions.length > 0, now, [2.2, 1.3, 2.4], 'work')
    if (this.d.scenes.getConstruct(SESSIONS_CONSTRUCT_ID) && sessions.length > 0) out.push(...this.d.sync.update(SESSIONS_CONSTRUCT_ID, { items: orbit.items }))
    return out
  }

  private brainFeed(now: number): CommandDraft[] {
    const notes = this.notes()
    const key = `${notes.length}:${notes.map((n) => n.id).join('|')}`
    if (!this.graph || this.graph.key !== key || now - this.graph.at > GRAPH_TTL_MS) {
      const g = buildKnowledgeGraph(notes, { maxNodes: 400, palette: 'cool' })
      this.graph = { at: now, key, nodes: g.nodes, edges: g.edges }
    }
    const out = this.ensure(BRAIN_CONSTRUCT_ID, 'knowledge_graph', notes.length > 0, now, [0, 1.6, 3.4], 'brain')
    if (this.d.scenes.getConstruct(BRAIN_CONSTRUCT_ID) && notes.length > 0) out.push(...this.d.sync.update(BRAIN_CONSTRUCT_ID, { nodes: this.graph.nodes, edges: this.graph.edges }))
    return out
  }
}
