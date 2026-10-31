/**
 * CharacterMemory: what she remembers about the two of them, over a MemoryRepo the daemon implements (the same vault as
 * the second brain's layers). Three kinds: episodes (what happened, when, how it felt), relationship facts and
 * preferences. Retrieval is simple, deterministic and local: keyword overlap, recency and importance.
 *
 * PRIVACY (docs/PRIVACY.md, PERSONA.md section 5): every item carries a sensitivity. Intimate, health, money and
 * relationship material is classified `sensitive` (or `private`) automatically, and the CLOUD audience, the default for
 * digests that go into a prompt, only sees `normal` items. Text that looks like a secret (keys, tokens, passwords) is
 * refused outright. Forgetting an item removes it from the repo.
 */
import { Emotion } from '@ai-assistant/shared'
import type { Emotion as EmotionT, Sensitivity } from '@ai-assistant/shared'
import type { Clock } from '../util/clock'
import type { IdGenerator } from '../util/ids'
import { clamp } from '../util/math'
import { fail, ok } from '../util/result'
import type { Result } from '../util/result'
import { cleanText } from '../util/safe'

export type MemoryKind = 'episode' | 'relationship' | 'preference'
export type Audience = 'cloud' | 'local'

export interface MemoryItem {
  id: string
  kind: MemoryKind
  text: string
  /** 1..5 */
  importance: number
  emotion?: EmotionT
  sensitivity: Sensitivity
  tags: string[]
  /** Epoch ms. */
  createdAt: number
  updatedAt: number
  recallCount: number
  lastRecalledAt?: number
}

/** Persistence seam. Synchronous and copy-safe like the other repos. */
export interface MemoryRepo {
  insert(item: MemoryItem): void
  get(id: string): MemoryItem | undefined
  /** Replace by id; false when it does not exist. */
  update(item: MemoryItem): boolean
  delete(id: string): boolean
  /** Oldest first. */
  list(filter?: { kind?: MemoryKind }): MemoryItem[]
  count(): number
}

export class InMemoryMemoryRepo implements MemoryRepo {
  private readonly items = new Map<string, MemoryItem>()
  insert(item: MemoryItem): void {
    this.items.set(item.id, structuredClone(item))
  }
  get(id: string): MemoryItem | undefined {
    const i = this.items.get(id)
    return i ? structuredClone(i) : undefined
  }
  update(item: MemoryItem): boolean {
    if (!this.items.has(item.id)) return false
    this.items.set(item.id, structuredClone(item))
    return true
  }
  delete(id: string): boolean {
    return this.items.delete(id)
  }
  list(filter: { kind?: MemoryKind } = {}): MemoryItem[] {
    return [...this.items.values()].filter((i) => !filter.kind || i.kind === filter.kind).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)).map((i) => structuredClone(i))
  }
  count(): number {
    return this.items.size
  }
}

// ------------------------------------------------------------------------------------------------- text helpers

const SENSITIVE =
  /\b(intimate|intimacy|kiss(?:ed|ing|es)?|romantic|romance|sexual|sex|naked|love you|in love|girlfriend|boyfriend|diagnos\w+|therap\w+|psychiatr\w+|depress\w+|anxiety|panic attack|medicat\w+|prescription|suicid\w+|self[- ]harm|abuse[ds]?|salary|bank account|iban|credit card|mortgage|debt|lawsuit|divorce|pregnan\w+|cancer)\b/i
const PRIVATE = /\b(family|mother|father|mom|dad|brother|sister|son|daughter|wife|husband|home address|birthday|phone number|health|doctor|hospital|religio\w+|politic\w+)\b/i

const ORDER: Record<Sensitivity, number> = { normal: 0, private: 1, sensitive: 2 }
const stricter = (a: Sensitivity, b: Sensitivity): Sensitivity => (ORDER[a] >= ORDER[b] ? a : b)

/** Conservative keyword classifier. The caller can only make an item stricter than this, never looser. */
export function classifySensitivity(text: string): Sensitivity {
  if (SENSITIVE.test(text)) return 'sensitive'
  if (PRIVATE.test(text)) return 'private'
  return 'normal'
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(?:password|passwd|pwd|passphrase|secret|api[_ -]?key|token|bearer)\b\s*(?:is|:|=)\s*\S{6,}/i,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}(?=\s|$)/,
]

/** True for API keys, tokens, private keys, "password: ..." and other long opaque strings. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text))
}

const STOP = new Set('a an and are as at be but by for from had has have he her his i if in into is it its me my of on or our she so that the their them then there they this to was we were what when which who will with you your about just'.split(' '))

/** Lowercase word tokens without stop words, lightly stemmed (plurals, -ing, -ed). */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue
    let t = raw
    if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3)
    else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2)
    else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1)
    out.push(t)
  }
  return out
}

const normKey = (text: string): string => tokenize(text).join(' ')

// -------------------------------------------------------------------------------------------------------- service

export interface RememberInput {
  kind: MemoryKind
  text: string
  /** 1..5, default 2. */
  importance?: number
  emotion?: EmotionT
  /** Can only make the item stricter than the automatic classification. */
  sensitivity?: Sensitivity
  tags?: string[]
}

export type RememberCode = 'invalid' | 'secret' | 'full'

export interface RememberOutcome {
  item: MemoryItem
  /** True when the same fact was already remembered (importance may have been raised). */
  deduped: boolean
}

export interface Recalled {
  item: MemoryItem
  score: number
  parts: { overlap: number; recency: number; importance: number }
}

export interface RecallOptions {
  /** 'cloud' (default) hides private and sensitive items. */
  audience?: Audience
  kinds?: readonly MemoryKind[]
  /** Record the recall (count and time) on the returned items. Default false. */
  touch?: boolean
  /** Return items even when they share no word with the query. Default false. */
  includeNonMatching?: boolean
}

export interface DigestOptions {
  /** 'cloud' (default) excludes private and sensitive items. */
  audience?: Audience
  maxChars?: number
  maxItems?: number
}

export interface Digest {
  text: string
  itemIds: string[]
  excluded: { private: number; sensitive: number }
}

export interface CharacterMemoryDeps {
  repo: MemoryRepo
  clock: Clock
  newId: IdGenerator
  /** Capacity. Default 2000. The least important, oldest items go first; importance 5 is never evicted. */
  maxItems?: number
  /** Recency half-life. Default 14 days. */
  halfLifeDays?: number
}

const DAY = 86_400_000
const KINDS: readonly MemoryKind[] = ['episode', 'relationship', 'preference']

export class CharacterMemory {
  private readonly maxItems: number
  private readonly halfLife: number
  constructor(private readonly deps: CharacterMemoryDeps) {
    this.maxItems = deps.maxItems ?? 2000
    this.halfLife = deps.halfLifeDays ?? 14
  }

  remember(input: RememberInput): Result<RememberOutcome, RememberCode> {
    if (typeof input !== 'object' || input === null) return fail('invalid', 'memory input must be an object')
    if (!KINDS.includes(input.kind)) return fail('invalid', 'kind must be episode, relationship or preference')
    const text = typeof input.text === 'string' ? cleanText(input.text, 600) : ''
    if (text.length === 0) return fail('invalid', 'nothing to remember')
    if (text.length > 500) return fail('invalid', 'keep it under 500 characters')
    if (looksLikeSecret(text)) return fail('secret', 'That looks like a secret (a key, token or password), so I will not store it.')
    const importance = Number.isFinite(input.importance) ? clamp(Math.round(input.importance as number), 1, 5) : 2
    if (input.emotion !== undefined && !Emotion.safeParse(input.emotion).success) return fail('invalid', 'emotion is not in the closed vocabulary')
    const sens = stricter(input.sensitivity && input.sensitivity in ORDER ? input.sensitivity : 'normal', classifySensitivity(text))
    const tags = [...new Set((input.tags ?? []).filter((t) => typeof t === 'string').map((t) => t.toLowerCase().replace(/[^a-z0-9:_-]/g, '').slice(0, 32)).filter(Boolean))].slice(0, 8)
    const now = this.deps.clock.now()

    // the same fact again: keep one copy, raise importance, never loosen sensitivity
    const key = normKey(text)
    if (key) {
      const same = this.deps.repo.list({ kind: input.kind }).find((i) => normKey(i.text) === key)
      if (same) {
        const merged: MemoryItem = { ...same, importance: Math.max(same.importance, importance), sensitivity: stricter(same.sensitivity, sens), updatedAt: now, tags: [...new Set([...same.tags, ...tags])].slice(0, 8) }
        this.deps.repo.update(merged)
        return ok({ item: merged, deduped: true })
      }
    }

    if (this.deps.repo.count() >= this.maxItems) {
      const victim = this.deps.repo.list().filter((i) => i.importance < 5).sort((a, b) => a.importance - b.importance || a.createdAt - b.createdAt)[0]
      if (!victim) return fail('full', 'memory is full of items marked important; forget something first')
      this.deps.repo.delete(victim.id)
    }
    const item: MemoryItem = {
      id: this.deps.newId('mem'),
      kind: input.kind,
      text,
      importance,
      ...(input.emotion ? { emotion: input.emotion } : {}),
      sensitivity: sens,
      tags,
      createdAt: now,
      updatedAt: now,
      recallCount: 0,
    }
    this.deps.repo.insert(item)
    return ok({ item, deduped: false })
  }

  get(id: string): MemoryItem | undefined {
    return this.deps.repo.get(id)
  }

  list(filter?: { kind?: MemoryKind }): MemoryItem[] {
    return this.deps.repo.list(filter)
  }

  /** Remove one item. */
  forget(id: string): boolean {
    return this.deps.repo.delete(id)
  }

  /** Remove every item matching a predicate; returns how many went. */
  forgetWhere(pred: (i: MemoryItem) => boolean): number {
    let n = 0
    for (const i of this.deps.repo.list()) if (pred(i) && this.deps.repo.delete(i.id)) n++
    return n
  }

  stats(): { total: number; byKind: Record<MemoryKind, number>; bySensitivity: Record<Sensitivity, number> } {
    const byKind: Record<MemoryKind, number> = { episode: 0, relationship: 0, preference: 0 }
    const bySensitivity: Record<Sensitivity, number> = { normal: 0, private: 0, sensitive: 0 }
    const all = this.deps.repo.list()
    for (const i of all) {
      byKind[i.kind]++
      bySensitivity[i.sensitivity]++
    }
    return { total: all.length, byKind, bySensitivity }
  }

  private visible(i: MemoryItem, audience: Audience): boolean {
    return audience === 'local' || i.sensitivity === 'normal'
  }

  /** The items most relevant to `query`: keyword overlap, recency and importance, deterministic. */
  recall(query: string, limit = 5, opts: RecallOptions = {}): Recalled[] {
    const audience = opts.audience ?? 'cloud'
    const now = this.deps.clock.now()
    const q = new Set(tokenize(typeof query === 'string' ? query : ''))
    const lim = clamp(Math.floor(Number.isFinite(limit) ? limit : 5), 1, 20)
    const out: Recalled[] = []
    for (const item of this.deps.repo.list()) {
      if (!this.visible(item, audience)) continue
      if (opts.kinds && !opts.kinds.includes(item.kind)) continue
      const toks = new Set(tokenize(item.text + ' ' + item.tags.join(' ')))
      let hit = 0
      for (const t of q) if (toks.has(t)) hit++
      const overlap = q.size > 0 ? hit / q.size : 0
      if (q.size > 0 && hit === 0 && !opts.includeNonMatching) continue
      const age = Math.max(0, now - item.updatedAt) / DAY
      const recency = 0.5 ** (age / this.halfLife)
      const importance = (item.importance - 1) / 4
      const score = q.size > 0 ? 0.5 * overlap + 0.25 * recency + 0.25 * importance : 0.5 * recency + 0.5 * importance
      out.push({ item, score, parts: { overlap, recency, importance } })
    }
    out.sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt || (a.item.id < b.item.id ? -1 : 1))
    const top = out.slice(0, lim)
    if (opts.touch) {
      for (const r of top) {
        const upd: MemoryItem = { ...r.item, recallCount: r.item.recallCount + 1, lastRecalledAt: now }
        this.deps.repo.update(upd)
        r.item = upd
      }
    }
    return top
  }

  /**
   * A short digest for the persona prompt: relationship facts, preferences and recent moments, newest and most important
   * first, within a character budget. The cloud audience (default) never sees private or sensitive items.
   */
  digest(opts: DigestOptions = {}): Digest {
    const audience = opts.audience ?? 'cloud'
    const maxChars = clamp(Math.floor(opts.maxChars ?? 900), 80, 4000)
    const maxItems = clamp(Math.floor(opts.maxItems ?? 12), 1, 50)
    const now = this.deps.clock.now()
    const all = this.deps.repo.list()
    const excluded = { private: 0, sensitive: 0 }
    const usable: MemoryItem[] = []
    for (const i of all) {
      if (this.visible(i, audience)) usable.push(i)
      else if (i.sensitivity === 'private') excluded.private++
      else excluded.sensitive++
    }
    const weight = (i: MemoryItem): number => 0.6 * ((i.importance - 1) / 4) + 0.4 * 0.5 ** (Math.max(0, now - i.updatedAt) / DAY / this.halfLife)
    const ranked = (kind: MemoryKind): MemoryItem[] => usable.filter((i) => i.kind === kind).sort((a, b) => weight(b) - weight(a) || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
    const recent = ranked('episode').filter((i) => now - i.createdAt <= 30 * DAY)

    const sections: Array<{ title: string; items: MemoryItem[]; fmt: (i: MemoryItem) => string }> = [
      { title: 'Us', items: ranked('relationship'), fmt: (i) => i.text },
      { title: 'Preferences', items: ranked('preference'), fmt: (i) => i.text },
      { title: 'Recently', items: recent, fmt: (i) => `${ago(now - i.createdAt)}: ${i.text}` },
    ]
    const lines: string[] = []
    const ids: string[] = []
    const seen = new Set<string>()
    let used = 0
    const header = 'What I remember about you and us:'
    used += header.length + 1
    let count = 0
    // round-robin through the sections so one kind cannot crowd out the others
    const cursors = sections.map(() => 0)
    const chosen: Array<MemoryItem[]> = sections.map(() => [])
    let progressed = true
    while (progressed && count < maxItems) {
      progressed = false
      for (let s = 0; s < sections.length && count < maxItems; s++) {
        const sec = sections[s]!
        while (cursors[s]! < sec.items.length) {
          const item = sec.items[cursors[s]!++]!
          const key = normKey(item.text)
          if (seen.has(key)) continue
          const line = `- ${sec.fmt(item)}`
          const extra = line.length + 1 + (chosen[s]!.length === 0 ? sec.title.length + 2 : 0)
          if (used + extra > maxChars) {
            cursors[s] = sec.items.length // nothing more fits from this section
            break
          }
          seen.add(key)
          used += extra
          chosen[s]!.push(item)
          ids.push(item.id)
          count++
          progressed = true
          break
        }
      }
    }
    sections.forEach((sec, s) => {
      if (chosen[s]!.length === 0) return
      lines.push(`${sec.title}:`)
      for (const i of chosen[s]!) lines.push(`- ${sec.fmt(i)}`)
    })
    const text = ids.length === 0 ? '' : `${header}\n${lines.join('\n')}`
    return { text, itemIds: ids, excluded }
  }
}

function ago(ms: number): string {
  const d = Math.floor(ms / DAY)
  if (d <= 0) return 'today'
  if (d === 1) return 'yesterday'
  if (d < 14) return `${d} days ago`
  return `${Math.floor(d / 7)} weeks ago`
}

export function createCharacterMemory(deps: CharacterMemoryDeps): CharacterMemory {
  return new CharacterMemory(deps)
}
