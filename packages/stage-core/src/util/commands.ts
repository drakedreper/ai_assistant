import type { z } from 'zod'
import type { StageCommand } from '@ai-assistant/shared'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** What callers build: defaults may be omitted (the schema fills them), and the id is assigned by the StageSession. */
export type StageCommandInput = z.input<typeof StageCommand>
export type CommandDraft = DistributiveOmit<StageCommandInput, 'id'> & { id?: string }
