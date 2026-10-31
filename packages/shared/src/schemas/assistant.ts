import { z } from 'zod'
import { AssistantState, Emotion, Id, IsoDate, IsoDateTime } from './common'

/** Typed event bus that drives the Room. Claude stream events, hooks and the clock all map onto these. */
export const AvatarEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('speak'), text: z.string(), emotion: Emotion }),
  z.object({ type: z.literal('pose'), state: AssistantState }),
  z.object({
    type: z.literal('lookAt'),
    target: z.union([z.enum(['user', 'screen', 'window']), z.object({ x: z.number(), y: z.number() })]),
  }),
  z.object({ type: z.literal('expression'), emotion: Emotion, intensity: z.number().min(0).max(1) }),
])
export type AvatarEvent = z.infer<typeof AvatarEvent>

export const NoteRef = z.object({
  path: z.string(),
  title: z.string(),
})
export type NoteRef = z.infer<typeof NoteRef>

export const ChatPart = z.discriminatedUnion('type', [
  /** Plain text; `emotion` is the tag parsed off the front of the sentence (already stripped from `text`). */
  z.object({ type: z.literal('text'), text: z.string(), emotion: Emotion.optional() }),
  /** A tool she used, shown as a small chip: "checked calendar". */
  z.object({
    type: z.literal('tool'),
    tool: z.string(),
    summary: z.string(),
    status: z.enum(['running', 'done', 'error']),
  }),
  /** Inline approval card; the approval itself lives in the Needs-you queue. */
  z.object({ type: z.literal('approval'), approvalId: Id }),
  /** A citation into the second brain. */
  z.object({ type: z.literal('note'), note: NoteRef }),
])
export type ChatPart = z.infer<typeof ChatPart>

export const ChatMessage = z.object({
  id: Id,
  role: z.enum(['user', 'assistant', 'system']),
  createdAt: IsoDateTime,
  /** voice = spoken (STT transcript), text = typed */
  modality: z.enum(['text', 'voice']).default('text'),
  parts: z.array(ChatPart),
})
export type ChatMessage = z.infer<typeof ChatMessage>

/**
 * A "thread of thinking": one item of her morning briefing. Every thread MUST cite at least one
 * strategy/knowledge note, which is what keeps this from being just another calendar overview.
 */
export const BriefingThread = z.object({
  id: Id,
  kind: z.enum(['decision', 'opportunity', 'risk', 'reminder', 'reflection']),
  title: z.string(),
  body: z.string(),
  cites: z.array(NoteRef).min(1),
  /** Which module the thread touches, used for the colored chip and click-through. */
  area: z.enum(['work', 'brain', 'life', 'money', 'world']),
  actionLabel: z.string().optional(),
})
export type BriefingThread = z.infer<typeof BriefingThread>

export const Briefing = z.object({
  id: Id,
  date: IsoDate,
  generatedAt: IsoDateTime,
  greeting: z.string(),
  summary: z.string(),
  threads: z.array(BriefingThread),
})
export type Briefing = z.infer<typeof Briefing>

/** Things she noticed about you this week (inspectable and forgettable in Settings → Memory). */
export const LearnedFact = z.object({
  id: Id,
  text: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
  source: NoteRef,
  learnedAt: IsoDateTime,
})
export type LearnedFact = z.infer<typeof LearnedFact>
