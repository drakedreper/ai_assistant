import { z } from 'zod'

export const Id = z.string().min(1)
/** ISO 8601 date-time, e.g. 2026-10-31T09:30:00+01:00 */
export const IsoDateTime = z.string().min(10)
/** ISO 8601 calendar date, e.g. 2026-10-31 */
export const IsoDate = z.string().length(10)

/**
 * Money is a signed integer in minor units (cents) carried as a string so int64 never loses precision.
 * Amounts are signed from the account's perspective: negative = outflow, positive = inflow.
 */
export const Money = z.object({
  amountMinor: z.string().regex(/^-?\d+$/),
  currency: z.string().length(3),
})
export type Money = z.infer<typeof Money>

/** Closed emotion vocabulary the persona may emit as `[happy]` tags; stripped before TTS. */
export const Emotion = z.enum([
  'neutral',
  'happy',
  'sad',
  'angry',
  'relaxed',
  'surprised',
  'shy',
  'thinking',
])
export type Emotion = z.infer<typeof Emotion>

/** What the avatar is doing. Driven by daemon events (chat stream, agent activity, time of day). */
export const AssistantState = z.enum(['idle', 'listening', 'thinking', 'speaking', 'working', 'sleeping'])
export type AssistantState = z.infer<typeof AssistantState>

/** Privacy label carried by notes/mail/finance items; decides what may go into cloud-bound context. */
export const Sensitivity = z.enum(['normal', 'private', 'sensitive'])
export type Sensitivity = z.infer<typeof Sensitivity>

/** Provenance of anything that lands in memory: who/what wrote it. */
export const Provenance = z.enum(['user', 'assistant', 'dream', 'import', 'federated'])
export type Provenance = z.infer<typeof Provenance>
