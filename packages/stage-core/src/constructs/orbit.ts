import { fnv1a32 } from '../util/rng'
import type { DataItem } from './data-state'

export type OrbitStatus = 'running' | 'blocked' | 'idle' | 'done' | 'failed'

/** Structurally compatible with shared `Session` (only these fields are read). */
export interface OrbitSessionInput {
  id: string
  projectId: string
  title?: string
  status: string
  agents?: ReadonlyArray<{ id: string; parentId: string | null; type?: string; status?: string }>
}
export interface OrbitProjectInput {
  id: string
  name?: string
  color?: string
}

export interface SessionOrbitResult {
  items: DataItem[]
  summary: string
  counts: Record<OrbitStatus | 'total', number>
}

const GOLDEN = 2.399963229728653
const STATUS_STYLE: Record<OrbitStatus, { speed: number; brightness: number; color: string }> = {
  running: { speed: 0.5, brightness: 0.9, color: '#7fd0ff' },
  blocked: { speed: 0.12, brightness: 1, color: '#ffa24d' },
  idle: { speed: 0.1, brightness: 0.5, color: '#8895ad' },
  done: { speed: 0.05, brightness: 0.3, color: '#6fcf97' },
  failed: { speed: 0.08, brightness: 0.7, color: '#ff6b6b' },
}

/** waiting_input and blocked_permission are the "needs you" states. */
export function orbitStatusOf(status: string): OrbitStatus {
  switch (status) {
    case 'running':
    case 'starting':
      return 'running'
    case 'waiting_input':
    case 'blocked_permission':
    case 'blocked':
    case 'waiting':
      return 'blocked'
    case 'done':
      return 'done'
    case 'error':
    case 'stale':
    case 'failed':
      return 'failed'
    default:
      return 'idle'
  }
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000

/**
 * Sessions as bodies orbiting their project; subagents orbit their parent. Blocked bodies are flagged (the stage makes
 * them flare). Deterministic and independent of input order: phases come from a hash of the id.
 */
export function sessionOrbit(sessions: readonly OrbitSessionInput[], projects: readonly OrbitProjectInput[]): SessionOrbitResult {
  const counts: SessionOrbitResult['counts'] = { running: 0, blocked: 0, idle: 0, done: 0, failed: 0, total: 0 }
  const items: DataItem[] = []

  const projById = new Map<string, OrbitProjectInput>()
  for (const p of projects) if (!projById.has(p.id)) projById.set(p.id, p)
  // sessions whose project is unknown get an "unassigned" project so nothing disappears
  const orphanIds = new Set<string>()
  for (const s of sessions) if (!projById.has(s.projectId)) orphanIds.add(s.projectId)
  const projectIds = [...new Set([...projById.keys(), ...orphanIds])].sort()

  const projIndex = new Map<string, number>()
  projectIds.forEach((id, i) => projIndex.set(id, i))

  const sorted = [...sessions].sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const perProject = new Map<string, number>()
  const blockedPerProject = new Map<string, number>()
  const sessionItems: DataItem[] = []

  for (const s of sorted) {
    const st = orbitStatusOf(s.status)
    counts[st]++
    counts.total++
    const idx = perProject.get(s.projectId) ?? 0
    perProject.set(s.projectId, idx + 1)
    if (st === 'blocked') blockedPerProject.set(s.projectId, (blockedPerProject.get(s.projectId) ?? 0) + 1)
    const h = fnv1a32(s.id)
    const style = STATUS_STYLE[st]
    const sid = `session:${s.id}`
    sessionItems.push({
      id: sid,
      kind: 'session',
      label: s.title ?? s.id,
      projectId: s.projectId,
      status: st,
      blocked: st === 'blocked',
      flare: st === 'blocked',
      brightness: style.brightness,
      color: style.color,
      orbit: {
        around: `project:${s.projectId}`,
        radius: r3(Math.min(2.2, 0.45 + 0.22 * idx)),
        phase: r3(((h % 3600) / 3600) * Math.PI * 2),
        speed: style.speed,
        inclination: r3(((((h >>> 12) % 61) - 30) * Math.PI) / 360),
      },
    })
    // subagents orbit the session (or their parent subagent)
    const subs = (s.agents ?? []).filter((a) => a.parentId !== null).sort((a, b) => (a.id < b.id ? -1 : 1))
    const agentsById = new Map((s.agents ?? []).map((a) => [a.id, a]))
    subs.forEach((a, k) => {
      const ah = fnv1a32(`${s.id}|${a.id}`)
      const ast = orbitStatusOf(a.status ?? 'idle')
      const astyle = STATUS_STYLE[ast]
      sessionItems.push({
        id: `agent:${s.id}:${a.id}`,
        kind: 'subagent',
        label: a.type ?? a.id,
        projectId: s.projectId,
        status: ast,
        blocked: ast === 'blocked',
        flare: ast === 'blocked',
        brightness: astyle.brightness,
        color: astyle.color,
        orbit: {
          around: (() => {
            const parent = a.parentId ? agentsById.get(a.parentId) : undefined
            return parent && parent.parentId !== null && parent.id !== a.id ? `agent:${s.id}:${parent.id}` : sid
          })(),
          radius: r3(0.18 + 0.08 * k),
          phase: r3(((ah % 3600) / 3600) * Math.PI * 2),
          speed: r3(astyle.speed * 1.6),
          inclination: r3(((((ah >>> 12) % 61) - 30) * Math.PI) / 360),
        },
      })
    })
  }

  projectIds.forEach((pid, i) => {
    const p = projById.get(pid)
    const angle = i * GOLDEN
    const radius = i === 0 ? 0 : 1.6 * Math.sqrt(i) + 0.6
    items.push({
      id: `project:${pid}`,
      kind: 'project',
      label: p?.name ?? (orphanIds.has(pid) ? 'Unassigned' : pid),
      position: [r3(Math.cos(angle) * radius), 0, r3(Math.sin(angle) * radius)],
      sessions: perProject.get(pid) ?? 0,
      blocked: blockedPerProject.get(pid) ?? 0,
      ...(p?.color ? { color: p.color } : {}),
    })
  })
  items.push(...sessionItems)

  const parts: string[] = []
  if (counts.running) parts.push(`${counts.running} running`)
  if (counts.blocked) parts.push(`${counts.blocked} waiting for you`)
  if (counts.failed) parts.push(`${counts.failed} failed`)
  if (counts.idle) parts.push(`${counts.idle} idle`)
  if (counts.done) parts.push(`${counts.done} done`)
  return { items, summary: parts.length ? parts.join(', ') : 'no sessions', counts }
}
