import type { Note } from '@ai-assistant/shared'
import { layerKeyOf, type LayerKey } from './layers'

/* ------------------------------------------------------------------ wikilinks */

const WIKI_RE = /\[\[([^\]|#]+?)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g

export interface WikiRef {
  target: string
  heading?: string
  alias?: string
}

export function parseWikiLinks(body: string): WikiRef[] {
  const out: WikiRef[] = []
  for (const m of body.matchAll(WIKI_RE)) {
    out.push({
      target: (m[1] ?? '').trim(),
      ...(m[2] ? { heading: m[2].trim() } : {}),
      ...(m[3] ? { alias: m[3].trim() } : {}),
    })
  }
  return out
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const noMd = (p: string) => p.trim().replace(/\.md$/i, '')
const baseName = (p: string) => noMd(p).split('/').pop() ?? p

/** Plain text of one markdown line, with wikilinks replaced by their label. */
function plainLine(line: string, label: (r: WikiRef) => string): string {
  return line
    .replace(/^\s*>\s?(\[![a-z]+\]\s*)?/i, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(WIKI_RE, (_m, t: string, h?: string, a?: string) =>
      label({ target: (t ?? '').trim(), ...(h ? { heading: h } : {}), ...(a ? { alias: a.trim() } : {}) }),
    )
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*([^*]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ----------------------------------------------------------------- vault index */

export interface OutLink {
  target: string
  note?: Note
  heading?: string
  alias?: string
}

export interface BackLink {
  from: Note
  /** One line of context around the link, split so the link itself can be emphasised. */
  context: { before: string; hit: string; after: string }
}

export interface VaultIndex {
  notes: Note[]
  byPath: Map<string, Note>
  resolve: (target: string) => Note | undefined
  outgoing: Map<string, OutLink[]>
  backlinks: Map<string, BackLink[]>
  /** Unique resolved links, from path to path. */
  edges: Array<[string, string]>
  /** Unique neighbours (in plus out). */
  degree: Map<string, number>
  label: (r: WikiRef) => string
}

export function buildVaultIndex(notes: Note[]): VaultIndex {
  const byKey = new Map<string, Note>()
  const byBase = new Map<string, Note[]>()
  const byTitle = new Map<string, Note>()
  const byPath = new Map<string, Note>()
  for (const n of notes) {
    byPath.set(n.path, n)
    byKey.set(noMd(n.path), n)
    const b = baseName(n.path).toLowerCase()
    byBase.set(b, [...(byBase.get(b) ?? []), n])
    byTitle.set(n.title.toLowerCase(), n)
  }

  const resolve = (target: string): Note | undefined => {
    const key = noMd(target)
    const direct = byKey.get(key)
    if (direct) return direct
    const bases = byBase.get(baseName(key).toLowerCase())
    if (bases && bases.length === 1) return bases[0]
    return byTitle.get(key.toLowerCase())
  }

  const label = (r: WikiRef): string => r.alias ?? resolve(r.target)?.title ?? baseName(r.target)

  const outgoing = new Map<string, OutLink[]>()
  const backlinks = new Map<string, BackLink[]>()
  const edgeSet = new Set<string>()
  const edges: Array<[string, string]> = []
  const nbrs = new Map<string, Set<string>>()
  const addNbr = (a: string, b: string) => {
    if (!nbrs.has(a)) nbrs.set(a, new Set())
    nbrs.get(a)?.add(b)
  }

  for (const n of notes) {
    const seen = new Set<string>()
    const outs: OutLink[] = []
    const lines = n.body.split('\n')
    for (const ref of parseWikiLinks(n.body)) {
      const target = resolve(ref.target)
      const key = target ? target.path : `?${noMd(ref.target)}`
      if (seen.has(key)) continue
      seen.add(key)
      outs.push({ target: ref.target, ...(target ? { note: target } : {}), ...(ref.heading ? { heading: ref.heading } : {}), ...(ref.alias ? { alias: ref.alias } : {}) })
      if (!target || target.path === n.path) continue
      const ek = `${n.path}\0${target.path}`
      if (!edgeSet.has(ek)) {
        edgeSet.add(ek)
        edges.push([n.path, target.path])
      }
      addNbr(n.path, target.path)
      addNbr(target.path, n.path)

      // context line for the backlink: the first line that links to this target
      const line = lines.find((l) => parseWikiLinks(l).some((r) => resolve(r.target)?.path === target.path)) ?? ''
      const marked = line.replace(WIKI_RE, (_m, t: string, h?: string, a?: string) =>
        resolve(String(t))?.path === target.path ? '\u0001' : label({ target: String(t), ...(h ? { heading: h } : {}), ...(a ? { alias: a.trim() } : {}) }),
      )
      const clean = plainLine(marked, label)
      const at = clean.indexOf('\u0001')
      const hitLabel = ref.alias ?? target.title
      let before = clean.slice(Math.max(0, at - 42), Math.max(0, at))
      if (at > 42) before = before.replace(/^\S*\s/, '')
      const after = clean.slice(at + 1, at + 1 + 100).replace(/\u0001/g, '')
      const ctx = { before: (at > 70 ? '…' : '') + before.replace(/\u0001/g, ''), hit: at >= 0 ? hitLabel : '', after: after + (clean.length > at + 91 ? '…' : '') }
      const list = backlinks.get(target.path) ?? []
      list.push({ from: n, context: ctx })
      backlinks.set(target.path, list)
    }
    outgoing.set(n.path, outs)
  }

  const degree = new Map<string, number>()
  for (const n of notes) degree.set(n.path, nbrs.get(n.path)?.size ?? 0)
  return { notes, byPath, resolve, outgoing, backlinks, edges, degree, label }
}

/* --------------------------------------------------------------------- source */

/** The raw file as it would sit on disk: flat, Obsidian-safe frontmatter plus the markdown body. */
export function toSource(n: Note, body: string = n.body): string {
  const q = (s: string) => (/[:#[\]{}]|^\s|\s$/.test(s) ? JSON.stringify(s) : s)
  const fm = [
    '---',
    `title: ${q(n.title)}`,
    `type: ${n.type}`,
    `layer: ${n.layer}`,
    `status: ${n.status}`,
    `importance: ${n.importance}`,
    `confidence: ${n.confidence}`,
    `provenance: ${n.provenance}`,
    `sensitivity: ${n.sensitivity}`,
    `tags: [${n.tags.join(', ')}]`,
    `created: ${n.created.slice(0, 16)}`,
    `updated: ${n.updated.slice(0, 16)}`,
    ...(n.reviewAfter ? [`review-after: ${n.reviewAfter}`] : []),
    ...(n.supersededBy ? [`superseded-by: "[[${noMd(n.supersededBy)}]]"`] : []),
    ...(n.source === 'secondbrain' ? ['source: secondbrain', 'read-only: true'] : []),
    '---',
    '',
  ]
  return fm.join('\n') + body
}

/** The reader shows the title in its header, so a leading "# Title" line is not repeated. */
export function stripLeadingH1(body: string): string {
  return body.replace(/^\s*#\s+[^\n]*\n+/, '')
}

/* ----------------------------------------------------------------------- diffs */

/** Applies a unified-style diff (hunks separated by "@@" lines) to a body. Returns null if it does not fit. */
export function applyDiff(body: string, diff: string[]): string | null {
  const hunks: string[][] = []
  for (const l of diff) {
    if (l.startsWith('@@')) hunks.push([])
    else {
      if (hunks.length === 0) hunks.push([])
      hunks[hunks.length - 1]?.push(l)
    }
  }
  let lines = body.split('\n')
  for (const h of hunks) {
    const oldSeq: string[] = []
    const newSeq: string[] = []
    for (const l of h) {
      const c = l.charAt(0)
      const text = l.slice(1)
      if (c === '+') newSeq.push(text)
      else if (c === '-') oldSeq.push(text)
      else {
        oldSeq.push(text)
        newSeq.push(text)
      }
    }
    let at = -1
    for (let i = 0; i + oldSeq.length <= lines.length; i++) {
      if (oldSeq.every((t, j) => lines[i + j] === t)) {
        at = i
        break
      }
    }
    if (at < 0) return null
    lines = [...lines.slice(0, at), ...newSeq, ...lines.slice(at + oldSeq.length)]
  }
  return lines.join('\n')
}

export function diffStats(diff: string[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of diff) {
    if (l.startsWith('+')) added++
    else if (l.startsWith('-')) removed++
  }
  return { added, removed }
}

/** Deterministic 7-hex "commit id" for approvals made in this session (the real daemon returns the real one). */
export function fakeSha(seed: string): string {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 7)
}

/* ---------------------------------------------------------------------- search */

export interface SearchHit {
  note: Note
  score: number
  mode: 'keyword' | 'semantic'
  why: string
  snippet: Array<{ text: string; hit: boolean }>
}

/** A tiny stand-in for vector retrieval: concepts that mean roughly the same thing in this vault. */
const RELATED: Record<string, string[]> = {
  focus: ['deep work', 'deep-work', 'protected block', 'blocks'],
  money: ['finance', 'runway', 'budget', 'savings'],
  privacy: ['local-first', 'private', 'sensitive', 'on your machine'],
  investor: ['seed', 'funding', 'dana'],
  funding: ['seed', 'investor', 'runway'],
  voice: ['speech', 'kokoro', 'push-to-talk', 'remember this'],
  speech: ['voice', 'kokoro', 'latency'],
  safety: ['trust ladder', 'approval', 'protected', 'never without'],
  permissions: ['trust ladder', 'approval', 'blocked'],
  memory: ['vault', 'dream', 'journal', 'notes'],
  calls: ['meetings', 'call', 'after 13:00'],
  design: ['ui polish', 'leo', 'type'],
  taxes: ['accountant', 'marcus', 'export'],
  family: ['mom', 'elena', 'birthday'],
  offline: ['local-first', 'on your machine', 'sqlite'],
  agents: ['coding agent', 'brief', 'sessions'],
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function plainBody(n: Note, label: (r: WikiRef) => string): string {
  return stripLeadingH1(n.body)
    .split('\n')
    .filter((l) => !l.trim().startsWith('```'))
    .map((l) => (/^#{1,6}\s/.test(l) ? `${plainLine(l, label)}:` : plainLine(l, label)))
    .filter((l) => l && l !== ':')
    .join(' \u00b7 ')
    .replace(/: \u00b7 /g, ': ')
}

function highlight(text: string, patterns: string[], window: [number, number]): Array<{ text: string; hit: boolean }> {
  const re = patterns.length ? new RegExp(`(${patterns.map(escapeRe).join('|')})`, 'gi') : null
  let start = 0
  if (re) {
    const m = re.exec(text)
    if (m) start = Math.max(0, m.index - window[0])
    re.lastIndex = 0
  }
  const slice = text.slice(start, start + window[0] + window[1])
  const pre = start > 0 ? '…' : ''
  const post = start + window[0] + window[1] < text.length ? '…' : ''
  if (!re) return [{ text: pre + slice + post, hit: false }]
  const parts = slice.split(re).filter((s) => s !== '')
  const out = parts.map((p) => ({ text: p, hit: patterns.some((q) => q.toLowerCase() === p.toLowerCase()) }))
  if (out[0]) out[0] = { ...out[0], text: pre + out[0].text }
  const last = out[out.length - 1]
  if (last) out[out.length - 1] = { ...last, text: last.text + post }
  return out
}

export function searchNotes(index: VaultIndex, query: string): SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter((t) => t.length >= 2)
  if (terms.length === 0) return []

  const hits: SearchHit[] = []
  for (const note of index.notes) {
    const title = note.title.toLowerCase()
    const path = note.path.toLowerCase()
    const tags = note.tags.map((t) => t.toLowerCase())
    const body = plainBody(note, index.label)
    const bodyLc = body.toLowerCase()

    let score = 0
    let direct = 0
    const where = new Set<string>()
    let bodyMentions = 0
    let tagHit = ''
    const matchedTerms: string[] = []
    for (const t of terms) {
      let any = false
      if (title.includes(t)) {
        score += 6
        where.add('title')
        any = true
      }
      const tg = tags.find((x) => x.includes(t))
      if (tg) {
        score += 4
        tagHit = tagHit || tg
        any = true
      }
      if (path.includes(t)) {
        score += 1.5
        where.add('path')
        any = true
      }
      const count = bodyLc.split(t).length - 1
      if (count > 0) {
        score += Math.min(count, 5)
        bodyMentions += count
        any = true
      }
      if (any) {
        direct++
        matchedTerms.push(t)
      }
    }

    let semantic: { term: string; phrase: string } | null = null
    if (direct < terms.length) {
      for (const t of terms) {
        for (const phrase of RELATED[t] ?? []) {
          if (bodyLc.includes(phrase) || title.includes(phrase) || tags.some((x) => x.includes(phrase))) {
            score += 1.5
            semantic = semantic ?? { term: t, phrase }
          }
        }
      }
    }
    if (direct === 0 && !semantic) continue
    if (direct === terms.length) score += 3
    score += note.importance * 0.2

    const mode: SearchHit['mode'] = direct > 0 ? 'keyword' : 'semantic'
    const bits: string[] = []
    if (where.has('title')) bits.push('title')
    if (tagHit) bits.push(`tag "${tagHit}"`)
    if (bodyMentions > 0) bits.push(`${bodyMentions} ${bodyMentions === 1 ? 'mention' : 'mentions'} in the text`)
    if (where.has('path') && bits.length === 0) bits.push('file name')
    let why = bits.length ? `Keyword match: ${bits.join(', ')}` : ''
    if (direct < terms.length && semantic) {
      const sem = `Related meaning: "${semantic.term}" is close to "${semantic.phrase}"`
      why = why ? `${why}. ${sem}` : sem
    }

    const patterns = direct > 0 ? matchedTerms : semantic ? [semantic.phrase] : []
    const snippet = highlight(body, patterns, [60, 110])
    hits.push({ note, score, mode, why, snippet })
  }
  return hits.sort((a, b) => b.score - a.score || a.note.title.localeCompare(b.note.title))
}

/* ------------------------------------------------------------------------ tree */

export type TreeItem =
  | { kind: 'folder'; key: string; name: string; children: TreeItem[]; count: number }
  | { kind: 'note'; note: Note }

interface Dir {
  folders: Map<string, Dir>
  notes: Note[]
}

/** Vault tree per layer. Sub-folders that hold a single note are flattened to the note itself. */
export function buildTree(notes: Note[], layerFolder: (k: LayerKey) => string): Record<LayerKey, TreeItem[]> {
  const roots = new Map<LayerKey, Dir>()
  for (const n of notes) {
    const lk = layerKeyOf(n)
    const root: Dir = roots.get(lk) ?? { folders: new Map(), notes: [] }
    roots.set(lk, root)
    const segs = n.path.split('/').slice(1, -1)
    let dir = root
    for (const s of segs) {
      let next = dir.folders.get(s)
      if (!next) {
        next = { folders: new Map(), notes: [] }
        dir.folders.set(s, next)
      }
      dir = next
    }
    dir.notes.push(n)
  }

  const sortNotes = (lk: LayerKey, list: Note[]) =>
    [...list].sort((a, b) => (lk === 'episodic' ? b.path.localeCompare(a.path) : b.importance - a.importance || a.title.localeCompare(b.title)))

  const walk = (lk: LayerKey, dir: Dir, prefix: string): TreeItem[] => {
    const items: TreeItem[] = []
    const lifted: Note[] = []
    const folderNames = [...dir.folders.keys()].sort((a, b) => (lk === 'episodic' ? b.localeCompare(a) : a.localeCompare(b)))
    for (const name of folderNames) {
      const sub = dir.folders.get(name) as Dir
      const key = `${prefix}/${name}`
      const children = walk(lk, sub, key)
      const only = children[0]
      if (children.length === 1 && only?.kind === 'note') lifted.push(only.note)
      else items.push({ kind: 'folder', key, name, children, count: countNotes(children) })
    }
    for (const n of sortNotes(lk, [...dir.notes, ...lifted])) items.push({ kind: 'note', note: n })
    return items
  }

  const out = {} as Record<LayerKey, TreeItem[]>
  for (const [lk, dir] of roots) out[lk] = walk(lk, dir, layerFolder(lk))
  return out
}

export function countNotes(items: TreeItem[]): number {
  return items.reduce((a, it) => a + (it.kind === 'note' ? 1 : it.count), 0)
}
