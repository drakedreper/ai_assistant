import { localDateKey } from '../util/time'
import type { DataItem } from './data-state'

export interface TimelineEventInput {
  id: string
  title: string
  startMs: number
  endMs?: number
  kind?: 'meeting' | 'task' | 'journal' | 'reminder' | 'event'
  important?: boolean
}

export interface TimelineOptions {
  nowMs: number
  /** Past window shown. Default 6 hours. */
  pastMs?: number
  /** Future window shown. Default 48 hours. */
  futureMs?: number
  /** Ribbon length per hour, in metres. Default 0.5. */
  unitsPerHour?: number
  /** Maximum events drawn. Default 120 (the nearest to now). */
  maxEvents?: number
}

export interface TimelineResult {
  items: DataItem[]
  shown: number
  dropped: number
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000
const HOUR = 3_600_000

/**
 * Calendar and journal as a ribbon through time: x is time relative to now (the "now" marker sits at x = 0), events that
 * overlap are stacked into lanes (0, +1, -1, +2, ...), today is lit and the past fades. Deterministic.
 */
export function timelineRibbon(events: readonly TimelineEventInput[], opts: TimelineOptions): TimelineResult {
  const now = opts.nowMs
  const pastMs = opts.pastMs ?? 6 * HOUR
  const futureMs = opts.futureMs ?? 48 * HOUR
  const upH = opts.unitsPerHour ?? 0.5
  const maxEvents = Math.max(1, Math.floor(opts.maxEvents ?? 120))
  const today = localDateKey(now)

  const valid = events.filter((e) => typeof e.id === 'string' && e.id !== '' && Number.isFinite(e.startMs) && (e.endMs === undefined || (Number.isFinite(e.endMs) && e.endMs >= e.startMs)))
  const inWindow = valid.filter((e) => (e.endMs ?? e.startMs) >= now - pastMs && e.startMs <= now + futureMs)
  inWindow.sort((a, b) => Math.abs(a.startMs - now) - Math.abs(b.startMs - now) || (a.id < b.id ? -1 : 1))
  const kept = inWindow.slice(0, maxEvents).sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // greedy lane packing
  const laneEnds: number[] = []
  const laneOf = new Map<string, number>()
  for (const e of kept) {
    const end = Math.max(e.endMs ?? e.startMs, e.startMs + 20 * 60_000)
    let lane = laneEnds.findIndex((le) => le <= e.startMs)
    if (lane < 0) {
      lane = laneEnds.length
      laneEnds.push(end)
    } else laneEnds[lane] = end
    laneOf.set(e.id, lane)
  }
  const laneY = (lane: number): number => (lane === 0 ? 0 : (lane % 2 === 1 ? 1 : -1) * Math.ceil(lane / 2) * 0.22)

  const items: DataItem[] = [{ id: 'now', kind: 'now', label: 'Now', position: [0, 0, 0], brightness: 1 }]
  for (const e of kept) {
    const lane = laneOf.get(e.id)!
    const isPast = (e.endMs ?? e.startMs) < now
    const isNow = e.startMs <= now && (e.endMs ?? e.startMs) >= now
    const isToday = localDateKey(e.startMs) === today
    const soon = e.startMs >= now && e.startMs - now <= HOUR
    let brightness = isNow || soon ? 1 : isPast ? (isToday ? 0.45 : 0.3) : isToday ? 0.8 : 0.6
    if (e.important) brightness = Math.min(1, brightness + 0.1)
    items.push({
      id: `event:${e.id}`,
      kind: e.kind ?? 'event',
      label: e.title,
      position: [r3(((e.startMs - now) / HOUR) * upH), laneY(lane), 0],
      length: r3((Math.max(0, (e.endMs ?? e.startMs) - e.startMs) / HOUR) * upH),
      lane,
      isNow,
      isPast,
      isToday,
      important: !!e.important,
      brightness: Math.round(brightness * 100) / 100,
    })
  }
  return { items, shown: kept.length, dropped: valid.length - kept.length }
}
