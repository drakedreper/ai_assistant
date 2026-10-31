import type { AvatarEvent } from '@ai-assistant/shared'
import type { View } from '../lib/areas'

export type LookTarget = Extract<AvatarEvent, { type: 'lookAt' }>['target']
export type V3 = [number, number, number]

/** Palette: the app's hues plus an indigo diorama. */
export const PAL = {
  rose: '#ff8fb1',
  violet: '#a78bfa',
  teal: '#2dd4bf',
  gold: '#fbbf24',
  blue: '#60a5fa',
  orange: '#fb923c',
  wallBack: '#2f2b6b',
  wallLeft: '#38327a',
  trim: '#1d1a4a',
  slab: '#15132e',
  wood: '#8c5d58',
  woodDark: '#5d3b44',
  cream: '#f6e9f1',
  skin: '#ffdccb',
  hair: '#5a3a82',
  hairLight: '#7a55a8',
  dress: '#f27ba3',
  blouse: '#fff3f8',
  shoe: '#7c5cc4',
} as const

/** Diorama dimensions (world units, y up). The camera looks at it from the front-right. */
export const ROOM = {
  x0: -2.0, // inner face of the left wall
  x1: 2.0, // open (cut-away) right edge
  zBack: -1.64, // inner face of the back wall
  zFront: 1.52, // open (cut-away) front edge
  wallH: 2.5,
} as const

/** Where she can be. y is the root offset on that spot (bed sits on a mattress). */
export const SPOTS: Record<'rug' | 'desk' | 'bed', { x: number; z: number; y: number }> = {
  rug: { x: 0.3, z: 0.4, y: 0 },
  desk: { x: -1.2, z: -0.16, y: 0 },
  bed: { x: 2.02, z: -1.16, y: 0.62 },
}

/** Seat height of the stool at the desk; she sits with her hips on it. */
export const SEAT_Y = 0.36
/** Hips height of the standing figure (pivot of the spine). */
export const HIPS_Y = 0.6

/** Points she can look at. */
export const GAZE = {
  screen: [-1.8, 0.92, -0.16] as V3,
  window: [-0.28, 1.5, -1.55] as V3,
  floor: [0.9, 0.0, 0.9] as V3,
}

export type PropId = 'calendar' | 'work' | 'brain' | 'money'

export const PROPS: Record<PropId, { label: string; view: View; hex: string; aria: string }> = {
  calendar: { label: 'Calendar', view: 'life', hex: PAL.orange, aria: 'Open Life: calendar' },
  work: { label: 'Work desk', view: 'work', hex: PAL.teal, aria: 'Open Work: Claude sessions' },
  brain: { label: 'Second brain', view: 'brain', hex: PAL.violet, aria: 'Open Brain: second brain' },
  money: { label: 'Money (Atlas)', view: 'money', hex: PAL.gold, aria: 'Open Money: Atlas' },
}

/** `?static` freezes randomness (blinks, glances) so screenshots are repeatable. */
export const IS_STATIC = typeof location !== 'undefined' && new URLSearchParams(location.search).has('static')
/** `?debug` exposes the store as window.__store and her animation state as window.__mira (dev only). */
export const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')
/** `?fast` lets the animation clock run at up to 0.5 s per frame (headless software rendering is slow; used for screenshots). */
export const DT_MAX = typeof location !== 'undefined' && new URLSearchParams(location.search).has('fast') ? 0.5 : 0.08
/** `?nowebgl` forces the SVG fallback (used to check it). */
export const FORCE_FALLBACK = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nowebgl')

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Deterministic PRNG for procedural textures. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
