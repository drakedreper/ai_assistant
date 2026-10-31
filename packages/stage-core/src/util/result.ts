/** Services return Results for expected failures (bad input, policy refusals). They throw only on programmer error. */
export type Result<T, C extends string = string> = { ok: true; value: T } | { ok: false; code: C; error: string }

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })
export const fail = <C extends string>(code: C, error: string): { ok: false; code: C; error: string } => ({ ok: false, code, error })
