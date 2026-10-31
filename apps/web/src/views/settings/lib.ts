import type { Persona } from '@ai-assistant/shared'

export type Vibe = Persona['vibe']

const band = (v: number): 0 | 1 | 2 => (v < 34 ? 0 : v < 67 ? 1 : 2)

/** Boundaries that ship locked: she is always honest about being an AI, and affection never authorises an action. */
export const LOCKED_BOUNDARIES = [
  'Always be honest that she is an AI.',
  'Affection never authorises an action: sending, spending and deleting always need approval.',
]
const LOCKED_PREFIX = ['always be honest that she is an ai', 'affection never authorises an action']
export const isLockedBoundary = (b: string) => LOCKED_PREFIX.some((p) => b.toLowerCase().startsWith(p))

/** The custom boundaries only (the locked defaults are shown separately and are always re-attached on save). */
export const customBoundaries = (all: string[]) => all.filter((b) => !isLockedBoundary(b))
export const composeBoundaries = (custom: string[]) => [LOCKED_BOUNDARIES[0] as string, ...custom, LOCKED_BOUNDARIES[1] as string]

export interface PreviewLine {
  id: string
  label: string
  text: string
}

const pick = <T,>(options: readonly [T, T, T], v: number): T => options[band(v)] as T

/** Canned lines chosen by the sliders. In the product the sliders compile into her persona prompt; here they pick copy. */
export function previewLines(v: Vibe, name: string): PreviewLine[] {
  const greeting =
    pick(['Good morning.', 'Good morning. Slept alright?', 'Good morning, you. I am glad you are here.'], v.warmth) +
    pick(['', ' Three things need you today.', ' Coffee first. The world can wait four minutes, then I have three things.'], v.playfulness)

  const push =
    pick(
      [
        'That could be worth a second look, whenever you have a moment. Your Q4 note leans the other way.',
        'I would hold off. Your Q4 positioning points the other way, and your last quick yes cost you a week.',
        'No. It contradicts your Q4 positioning. Say no today, and say it kindly.',
      ],
      v.directness,
    ) + pick(['', '', ' I am on your side either way.'], v.warmth)

  const nudge = pick(
    [
      'I will stay quiet until you ask. Everything waits in your Needs-you list.',
      'I will flag what touches your strategy notes, once a day, in the briefing.',
      'I will check in before a deadline slips, and tell you the moment an agent gets stuck.',
    ],
    v.proactivity,
  )

  return [
    { id: 'greet', label: `${name} says good morning`, text: greeting },
    { id: 'push', label: 'You ask: should I say yes to this new client?', text: push },
    { id: 'nudge', label: 'How often she speaks up', text: nudge },
  ]
}

/** "warm, playful, fairly direct, speaks up often". */
export function describeVibe(v: Vibe): string {
  const w = pick(['reserved', 'friendly', 'warm'], v.warmth)
  const p = pick(['serious', 'light', 'playful'], v.playfulness)
  const d = pick(['gentle', 'straightforward', 'blunt'], v.directness)
  const a = pick(['waits to be asked', 'nudges now and then', 'speaks up often'], v.proactivity)
  return `${w}, ${p}, ${d}, ${a}`
}
