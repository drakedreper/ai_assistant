import type { Note } from '@ai-assistant/shared'
import {
  BookOpen,
  CalendarCheck,
  CalendarDays,
  ChevronRight,
  EyeOff,
  FileText,
  FolderKanban,
  Gavel,
  GitPullRequest,
  Inbox,
  Link2,
  Lock,
  PenLine,
  ShieldCheck,
  User,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { Gauge } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { CORE_BUDGET_TOKENS, fmtTokens, LAYERS, layerKeyOf, tint, VAULT_LAYERS, type LayerKey } from '../lib/layers'
import { scrollWithin } from '../lib/scroll'
import { buildTree, countNotes, type TreeItem, type VaultIndex } from '../lib/vault'
import { useBrain } from '../ui'
import { LayerDot } from './atoms'

const TYPE_ICON: Partial<Record<Note['type'], LucideIcon>> = {
  person: User,
  journal: CalendarDays,
  review: CalendarCheck,
  reflection: PenLine,
  project: FolderKanban,
  decision: Gavel,
  concept: BookOpen,
  source: Inbox,
}

/** Ancestor folder keys of a note, so opening a note can expand the tree down to it. */
export function ancestorKeys(note: Note, layerKey: LayerKey, items: TreeItem[]): string[] {
  const trail: string[] = []
  const find = (list: TreeItem[], acc: string[]): boolean => {
    for (const it of list) {
      if (it.kind === 'note' && it.note.path === note.path) {
        trail.push(...acc)
        return true
      }
      if (it.kind === 'folder' && find(it.children, [...acc, it.key])) return true
    }
    return false
  }
  find(items, [])
  return [LAYERS[layerKey].folder, ...trail]
}

function NoteRow({ note, depth, active, pending, onOpen }: { note: Note; depth: number; active: boolean; pending: boolean; onOpen: (p: string) => void }) {
  const Icon = TYPE_ICON[note.type] ?? FileText
  const lk = note.source === 'secondbrain' ? 'federated' : note.layer
  const hex = LAYERS[lk].hex
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(note.path)}
        aria-current={active ? 'page' : undefined}
        title={`${note.path}${note.status === 'superseded' ? ' (superseded)' : ''}`}
        style={{ paddingLeft: 8 + depth * 14, boxShadow: active ? `inset 2px 0 0 ${hex}` : undefined, background: active ? tint(hex, 0.12) : undefined }}
        className={cn(
          'group flex w-full cursor-pointer items-center gap-1.5 rounded-lg py-[5px] pr-2 text-left transition',
          !active && 'hover:bg-white/5',
        )}
      >
        <Icon className={cn('size-3.5 shrink-0', active ? 'text-fg' : 'text-faint group-hover:text-muted')} aria-hidden />
        <span className={cn('min-w-0 flex-1 truncate text-[13px] leading-5', active ? 'font-medium text-fg' : 'text-muted group-hover:text-fg', note.status === 'superseded' && 'line-through decoration-faint')}>
          {note.title}
        </span>
        {pending && (
          <span title="A proposal for this note is waiting" className="shrink-0">
            <GitPullRequest className="size-3 text-mira" aria-label="Pending proposal" />
          </span>
        )}
        {note.sensitivity !== 'normal' && (
          <span title={`Marked ${note.sensitivity}`} className="shrink-0">
            <EyeOff className="size-3 text-faint" aria-label={note.sensitivity} />
          </span>
        )}
        {note.status === 'draft' && <span className="shrink-0 rounded border border-line px-1 text-[10px] leading-4 text-faint">draft</span>}
      </button>
    </li>
  )
}

function Items({ items, depth, activePath, pending, onOpen }: { items: TreeItem[]; depth: number; activePath: string; pending: Set<string>; onOpen: (p: string) => void }) {
  const collapsed = useBrain((s) => s.collapsed)
  const toggle = useBrain((s) => s.toggleFolder)
  return (
    <ul className="flex flex-col gap-px">
      {items.map((it) =>
        it.kind === 'note' ? (
          <NoteRow key={it.note.path} note={it.note} depth={depth} active={it.note.path === activePath} pending={pending.has(it.note.path)} onOpen={onOpen} />
        ) : (
          <li key={it.key}>
            <button
              type="button"
              onClick={() => toggle(it.key)}
              aria-expanded={!collapsed[it.key]}
              style={{ paddingLeft: 6 + depth * 14 }}
              className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg py-[5px] pr-2 text-left text-muted transition hover:bg-white/5 hover:text-fg"
            >
              <ChevronRight className={cn('size-3.5 shrink-0 text-faint transition-transform', !collapsed[it.key] && 'rotate-90')} aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{it.name}</span>
              <span className="text-[11px] text-faint tabular-nums">{it.count}</span>
            </button>
            {!collapsed[it.key] && <Items items={it.children} depth={depth + 1} activePath={activePath} pending={pending} onOpen={onOpen} />}
          </li>
        ),
      )}
    </ul>
  )
}

/** Context-budget meter for the always-loaded core layer. */
function CoreBudget({ notes }: { notes: Note[] }) {
  const tokens = notes.reduce((a, n) => a + (n.contextTokens ?? Math.round(n.body.length / 4)), 0)
  const pct = (tokens / CORE_BUDGET_TOKENS) * 100
  return (
    <div className="mx-1.5 mt-0.5 mb-1.5 rounded-lg border border-mira/25 bg-mira/8 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-mira">
        <Lock className="size-3" aria-hidden />
        Always in her context
      </div>
      <Gauge pct={pct} color="var(--color-mira)" height={4} className="mt-1.5" label="Core context budget used" />
      <div className="mt-1 flex justify-between text-[11px] text-faint tabular-nums">
        <span>
          ~{fmtTokens(tokens)} of {fmtTokens(CORE_BUDGET_TOKENS)} tokens
        </span>
        <span>{Math.round(pct)}%</span>
      </div>
    </div>
  )
}

export function VaultTree({ index, activePath, pendingPaths, onOpen }: { index: VaultIndex; activePath: string; pendingPaths: Set<string>; onOpen: (p: string) => void }) {
  const collapsed = useBrain((s) => s.collapsed)
  const toggle = useBrain((s) => s.toggleFolder)
  const tree = useMemo(() => buildTree(index.notes, (k) => LAYERS[k].folder), [index.notes])
  const coreNotes = useMemo(() => index.notes.filter((n) => n.layer === 'core' && n.source === 'vault'), [index.notes])
  const vaultCount = useMemo(() => index.notes.filter((n) => n.source === 'vault').length, [index.notes])
  const fed = tree.federated ?? []
  const expand = useBrain((s) => s.expand)

  // Opening a note (from a link, search or another screen) opens the folders down to it and scrolls it into view.
  useEffect(() => {
    const n = index.byPath.get(activePath)
    if (!n) return
    const lk = layerKeyOf(n)
    expand(ancestorKeys(n, lk, tree[lk] ?? []))
    const t = setTimeout(() => {
      const nav = document.querySelector('nav[aria-label="Vault tree"]')
      scrollWithin(nav?.querySelector('[data-tree-scroll]'), nav?.querySelector('[aria-current="page"]'))
    }, 50)
    return () => clearTimeout(t)
  }, [activePath, index, tree, expand])

  return (
    <nav aria-label="Vault tree" className="glass flex h-full min-h-0 flex-col">
      <div className="flex items-baseline gap-2 px-3.5 pt-3 pb-1.5">
        <h2 className="text-[13px] font-semibold tracking-wide text-fg">Vault</h2>
        <span className="text-[11px] text-faint tabular-nums">{vaultCount} notes</span>
      </div>
      <div data-tree-scroll className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {VAULT_LAYERS.map((lk) => {
          const meta = LAYERS[lk]
          const items = tree[lk] ?? []
          const open = !collapsed[meta.folder]
          return (
            <div key={lk} className="mb-0.5">
              <button
                type="button"
                onClick={() => toggle(meta.folder)}
                aria-expanded={open}
                title={meta.blurb}
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-[5px] text-left transition hover:bg-white/5"
              >
                <ChevronRight className={cn('size-3.5 shrink-0 text-faint transition-transform', open && 'rotate-90')} aria-hidden />
                <LayerDot layer={lk} size={9} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-fg">{meta.folder}</span>
                {lk === 'core' && <Lock className="size-3 text-mira" aria-label="Always in context" />}
                {lk === 'strategy' && <ShieldCheck className="size-3 text-money" aria-label="Protected" />}
                <span className="text-[11px] text-faint tabular-nums">{countNotes(items)}</span>
              </button>
              {lk === 'core' && <CoreBudget notes={coreNotes} />}
              {lk === 'strategy' && (
                <p className="mx-2 mb-1 flex items-center gap-1.5 truncate text-[11px] text-faint">
                  <ShieldCheck className="size-3 shrink-0 text-money" aria-hidden />
                  <span className="truncate">Protected: changes arrive as proposals</span>
                </p>
              )}
              {open && <Items items={items} depth={1} activePath={activePath} pending={pendingPaths} onOpen={onOpen} />}
            </div>
          )
        })}

        {fed.length > 0 && (
          <section aria-label="Federated: Secondbrain (read-only)" className="mt-2 rounded-xl border border-dashed border-line-strong p-1.5">
            <button
              type="button"
              onClick={() => toggle('secondbrain')}
              aria-expanded={!collapsed.secondbrain}
              className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-1 py-[5px] text-left transition hover:bg-white/5"
            >
              <ChevronRight className={cn('size-3.5 shrink-0 text-faint transition-transform', !collapsed.secondbrain && 'rotate-90')} aria-hidden />
              <Link2 className="size-3.5 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1 text-[12px] leading-tight font-medium text-muted">Federated: Secondbrain</span>
              <span className="text-[11px] text-faint tabular-nums">{countNotes(fed)}</span>
            </button>
            <p className="mx-2 mb-1 text-[11px] text-faint">Read-only. Mira cannot write here.</p>
            {!collapsed.secondbrain && <Items items={fed} depth={1} activePath={activePath} pending={pendingPaths} onOpen={onOpen} />}
          </section>
        )}
      </div>
      <p className="border-t border-line px-3.5 py-2 text-[11px] leading-snug text-faint">Plain markdown in a git folder on your disk. Open it in any editor.</p>
    </nav>
  )
}
