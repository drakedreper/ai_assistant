import type { Note } from '@ai-assistant/shared'
import { AlertTriangle, Gavel, Info, Lightbulb, Quote, Sparkles, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import { LAYERS, layerKeyOf } from './layers'
import { slug } from './vault'

/**
 * A small markdown renderer for the vault: headings, paragraphs, bold/italic/inline code, bullet, numbered and task
 * lists (nested), blockquotes and Obsidian-style callouts, fenced code, rules and [[wikilinks]] in all three forms
 * ([[path]], [[path|alias]], [[path#heading]]). No HTML is ever injected: everything is built as React nodes.
 */

export interface MdCtx {
  resolve: (target: string) => Note | undefined
  open: (path: string, heading?: string) => void
}

/* ---------------------------------------------------------------- block parser */

interface ListItem {
  text: string
  task?: 'open' | 'done'
  children: ListBlock[]
}
interface ListBlock {
  t: 'list'
  ordered: boolean
  items: ListItem[]
}
type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'hr' }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; lines: string[] }
  | { t: 'callout'; kind: string; title: string; body: Block[] }
  | ListBlock

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const FENCE_RE = /^\s*```\s*([\w-]*)\s*$/
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
const HEAD_RE = /^(#{1,4})\s+(.*)$/

function isBlockStart(line: string): boolean {
  return HEAD_RE.test(line) || HR_RE.test(line) || LIST_RE.test(line) || FENCE_RE.test(line) || /^\s*>/.test(line)
}

function indentOf(s: string): number {
  return s.replace(/\t/g, '    ').length
}

function nestList(flat: Array<{ indent: number; ordered: boolean; text: string }>): ListBlock {
  const first = flat[0]
  const root: ListBlock = { t: 'list', ordered: first?.ordered ?? false, items: [] }
  const stack: Array<{ indent: number; list: ListBlock }> = [{ indent: first?.indent ?? 0, list: root }]
  for (const it of flat) {
    while (stack.length > 1 && it.indent < (stack[stack.length - 1]?.indent ?? 0)) stack.pop()
    const top = stack[stack.length - 1]
    if (!top) break
    if (it.indent > top.indent) {
      const parent = top.list.items[top.list.items.length - 1]
      if (parent) {
        const nl: ListBlock = { t: 'list', ordered: it.ordered, items: [] }
        parent.children.push(nl)
        stack.push({ indent: it.indent, list: nl })
      }
    }
    const cur = stack[stack.length - 1]
    if (!cur) break
    const task = /^\[( |x|X)\]\s+/.exec(it.text)
    cur.list.items.push({
      text: task ? it.text.slice(task[0].length) : it.text,
      ...(task ? { task: task[1] === ' ' ? ('open' as const) : ('done' as const) } : {}),
      children: [],
    })
  }
  return root
}

export function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) body.push(lines[i++] ?? '')
      i++
      blocks.push({ t: 'code', lang: fence[1] ?? '', text: body.join('\n') })
      continue
    }
    const head = HEAD_RE.exec(line)
    if (head) {
      blocks.push({ t: 'h', level: (head[1] ?? '#').length, text: (head[2] ?? '').trim() })
      i++
      continue
    }
    if (HR_RE.test(line)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }
    if (/^\s*>/.test(line)) {
      const q: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) q.push((lines[i++] ?? '').replace(/^\s*>\s?/, ''))
      const co = /^\[!([a-zA-Z]+)\]\s*(.*)$/.exec(q[0] ?? '')
      if (co) blocks.push({ t: 'callout', kind: (co[1] ?? 'note').toLowerCase(), title: (co[2] ?? '').trim(), body: parseBlocks(q.slice(1)) })
      else blocks.push({ t: 'quote', lines: q })
      continue
    }
    if (LIST_RE.test(line)) {
      const flat: Array<{ indent: number; ordered: boolean; text: string }> = []
      while (i < lines.length) {
        const l = lines[i] ?? ''
        const m = LIST_RE.exec(l)
        if (m) {
          const item = { indent: indentOf(m[1] ?? ''), ordered: /\d/.test(m[2] ?? ''), text: m[3] ?? '' }
          // A different kind of marker at the top level starts a new list.
          const first = flat[0]
          if (first && item.indent <= first.indent && item.ordered !== first.ordered) break
          flat.push(item)
          i++
        } else if (l.trim() !== '' && /^\s+\S/.test(l) && flat.length) {
          const last = flat[flat.length - 1]
          if (last) last.text += ' ' + l.trim()
          i++
        } else break
      }
      blocks.push(nestList(flat))
      continue
    }
    const para: string[] = [line.trim()]
    i++
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !isBlockStart(lines[i] ?? '')) para.push((lines[i++] ?? '').trim())
    blocks.push({ t: 'p', text: para.join(' ') })
  }
  return blocks
}

/* --------------------------------------------------------------- inline parser */

const INLINE_RE = /(`[^`\n]+`)|(\[\[[^\]\n]+\]\])|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\b_[^_\s][^_\n]*_\b)|(\[[^\]\n]+\]\([^)\n]+\))/

function WikiLink({ raw, ctx }: { raw: string; ctx: MdCtx }) {
  const m = /^\[\[([^\]|#]+?)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]$/.exec(raw)
  if (!m) return <>{raw}</>
  const target = (m[1] ?? '').trim()
  const heading = m[2]?.trim()
  const alias = m[3]?.trim()
  const note = ctx.resolve(target)
  if (!note) {
    return (
      <span
        title={`Not in the vault yet: ${target}`}
        className="rounded border border-dashed border-faint/70 px-1 py-px text-[0.93em] text-muted [box-decoration-break:clone]"
      >
        {alias ?? target.split('/').pop()}
      </span>
    )
  }
  const lk = layerKeyOf(note)
  const meta = LAYERS[lk]
  const federated = lk === 'federated'
  const text = alias ?? (heading ? `${note.title} › ${heading}` : note.title)
  return (
    <a
      href={`#${note.path}`}
      title={`${note.path}${heading ? ` # ${heading}` : ''}${federated ? ' (federated, read-only)' : ''}`}
      onClick={(e) => {
        e.preventDefault()
        ctx.open(note.path, heading)
      }}
      className={cn(
        'cursor-pointer rounded border px-1 py-px text-[0.93em] no-underline transition [box-decoration-break:clone]',
        federated ? 'border-dashed border-brain/45 text-brain/90 hover:bg-brain/10' : 'border-brain/30 bg-brain/10 text-brain hover:bg-brain/20',
      )}
    >
      <span aria-hidden className="mr-1 inline-block size-1.5 rounded-full align-middle" style={{ background: meta.hex }} />
      {text}
    </a>
  )
}

export function renderInline(text: string, ctx: MdCtx, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let n = 0
  while (rest.length) {
    const m = INLINE_RE.exec(rest)
    if (!m) {
      out.push(rest)
      break
    }
    if (m.index > 0) out.push(rest.slice(0, m.index))
    const tok = m[0]
    const k = `${key}-${n++}`
    if (m[1]) {
      out.push(
        <code key={k} className="rounded bg-white/8 px-1 py-px font-mono text-[0.88em] text-fg">
          {tok.slice(1, -1)}
        </code>,
      )
    } else if (m[2]) {
      out.push(<WikiLink key={k} raw={tok} ctx={ctx} />)
    } else if (m[3]) {
      out.push(
        <strong key={k} className="font-semibold text-fg">
          {renderInline(tok.slice(2, -2), ctx, k)}
        </strong>,
      )
    } else if (m[4] || m[5]) {
      out.push(
        <em key={k} className="italic">
          {renderInline(tok.slice(1, -1), ctx, k)}
        </em>,
      )
    } else if (m[6]) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
      out.push(
        <span key={k} title={lm?.[2]} className="underline decoration-faint decoration-dotted underline-offset-2">
          {lm?.[1]}
        </span>,
      )
    }
    rest = rest.slice(m.index + tok.length)
  }
  return out
}

/* ------------------------------------------------------------------- callouts */

const CALLOUT: Record<string, { icon: LucideIcon; label: string; box: string; head: string }> = {
  note: { icon: Info, label: 'Note', box: 'border-world/30 bg-world/8', head: 'text-world' },
  info: { icon: Info, label: 'Info', box: 'border-world/30 bg-world/8', head: 'text-world' },
  tip: { icon: Lightbulb, label: 'Tip', box: 'border-ok/30 bg-ok/8', head: 'text-ok' },
  warning: { icon: AlertTriangle, label: 'Careful', box: 'border-warn/35 bg-warn/8', head: 'text-warn' },
  decision: { icon: Gavel, label: 'Decision', box: 'border-money/35 bg-money/8', head: 'text-money' },
  quote: { icon: Quote, label: 'Quote', box: 'border-line-strong bg-white/4', head: 'text-muted' },
  mira: { icon: Sparkles, label: 'Mira', box: 'border-mira/30 bg-mira/8', head: 'text-mira' },
}

/* ------------------------------------------------------------------- renderer */

function RenderList({ list, ctx, k }: { list: ListBlock; ctx: MdCtx; k: string }) {
  const Tag = list.ordered ? 'ol' : 'ul'
  return (
    <Tag className={cn('my-2 space-y-1 pl-5 marker:text-faint', list.ordered ? 'list-decimal' : 'list-disc')}>
      {list.items.map((it, i) => (
        <li key={`${k}-${i}`} className={cn('pl-1 leading-[1.65] text-fg/90', it.task && 'list-none')}>
          {it.task ? (
            <span className="-ml-5 flex items-start gap-2">
              <span
                aria-hidden
                className={cn(
                  'mt-[5px] grid size-3.5 shrink-0 place-items-center rounded-[4px] border',
                  it.task === 'done' ? 'border-ok/50 bg-ok/20 text-ok' : 'border-line-strong bg-white/4',
                )}
              >
                {it.task === 'done' && (
                  <svg viewBox="0 0 12 12" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 6.5l2.2 2.2L9.5 3.8" />
                  </svg>
                )}
              </span>
              <span className={cn(it.task === 'done' && 'text-muted line-through decoration-faint')}>
                <span className="sr-only">{it.task === 'done' ? 'Done: ' : 'To do: '}</span>
                {renderInline(it.text, ctx, `${k}-${i}`)}
              </span>
            </span>
          ) : (
            renderInline(it.text, ctx, `${k}-${i}`)
          )}
          {it.children.map((c, j) => (
            <RenderList key={j} list={c} ctx={ctx} k={`${k}-${i}-${j}`} />
          ))}
        </li>
      ))}
    </Tag>
  )
}

function RenderBlocks({ blocks, ctx, k }: { blocks: Block[]; ctx: MdCtx; k: string }) {
  return (
    <>
      {blocks.map((b, i) => {
        const key = `${k}-${i}`
        switch (b.t) {
          case 'h': {
            const id = `h-${slug(b.text)}`
            if (b.level === 1) return <h2 key={key} id={id} className="mt-6 mb-2 scroll-mt-4 text-[18px] leading-snug font-semibold text-fg">{renderInline(b.text, ctx, key)}</h2>
            if (b.level === 2) return <h3 key={key} id={id} className="mt-5 mb-1.5 scroll-mt-4 border-b border-line pb-1 text-[15px] leading-snug font-semibold text-fg">{renderInline(b.text, ctx, key)}</h3>
            return <h4 key={key} id={id} className="mt-4 mb-1 scroll-mt-4 text-[12px] font-semibold tracking-wide text-muted uppercase">{renderInline(b.text, ctx, key)}</h4>
          }
          case 'p':
            return <p key={key} className="my-2 text-[14px] leading-[1.7] text-fg/90">{renderInline(b.text, ctx, key)}</p>
          case 'hr':
            return <hr key={key} className="my-5 border-line" />
          case 'code':
            return (
              <pre key={key} className="my-3 overflow-x-auto rounded-xl border border-line bg-black/30 px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-fg/90">
                {b.lang && <span className="mb-1 block text-[10px] tracking-wide text-faint uppercase">{b.lang}</span>}
                <code>{b.text}</code>
              </pre>
            )
          case 'quote':
            return (
              <blockquote key={key} className="my-3 border-l-2 border-brain/45 pl-3.5 text-[14px] leading-[1.7] text-muted italic">
                {b.lines.map((l, j) => (
                  <p key={j}>{renderInline(l, ctx, `${key}-${j}`)}</p>
                ))}
              </blockquote>
            )
          case 'callout': {
            const c = CALLOUT[b.kind] ?? CALLOUT.note
            if (!c) return null
            const Icon = c.icon
            return (
              <aside key={key} className={cn('my-3 rounded-xl border px-3.5 py-2.5', c.box)}>
                <div className={cn('flex items-center gap-1.5 text-[12px] font-semibold', c.head)}>
                  <Icon className="size-3.5" aria-hidden />
                  {renderInline(b.title || c.label, ctx, key)}
                </div>
                {b.body.length > 0 && (
                  <div className="[&>p]:my-1 [&>p]:text-[13px] [&>p]:leading-relaxed [&>p]:text-fg/85">
                    <RenderBlocks blocks={b.body} ctx={ctx} k={key} />
                  </div>
                )}
              </aside>
            )
          }
          case 'list':
            return <RenderList key={key} list={b} ctx={ctx} k={key} />
        }
      })}
    </>
  )
}

export function Markdown({ source, ctx, className }: { source: string; ctx: MdCtx; className?: string }) {
  const blocks = parseBlocks(source.split('\n'))
  return (
    <div className={className}>
      <RenderBlocks blocks={blocks} ctx={ctx} k="md" />
    </div>
  )
}
