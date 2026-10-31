import { FileDiff } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { diffStats } from '../lib/vault'

interface Row {
  kind: 'hunk' | 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}

function parse(diff: string[]): Row[] {
  const rows: Row[] = []
  let o = 1
  let n = 1
  for (const line of diff) {
    if (line.startsWith('@@')) {
      const m = /^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/.exec(line)
      if (m) {
        o = Number(m[1])
        n = Number(m[2])
      }
      rows.push({ kind: 'hunk', text: line })
    } else if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1), newNo: n++ })
    else if (line.startsWith('-')) rows.push({ kind: 'del', text: line.slice(1), oldNo: o++ })
    else rows.push({ kind: 'ctx', text: line.slice(1), oldNo: o++, newNo: n++ })
  }
  return rows
}

/** Unified diff: additions green, removals red, a marker and line numbers so it never relies on colour alone. */
export function DiffViewer({ diff, path, className }: { diff: string[]; path: string; className?: string }) {
  const rows = parse(diff)
  const { added, removed } = diffStats(diff)
  return (
    <figure className={cn('overflow-hidden rounded-xl border border-line bg-black/30', className)} aria-label={`Diff for ${path}: ${added} added, ${removed} removed`}>
      <figcaption className="flex items-center gap-2 border-b border-line bg-white/[0.03] px-3 py-1.5">
        <FileDiff className="size-3.5 shrink-0 text-faint" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{path}</span>
        <span className="font-mono text-[11px] text-ok tabular-nums">+{added}</span>
        <span className="font-mono text-[11px] text-bad tabular-nums">-{removed}</span>
      </figcaption>
      <div className="overflow-x-auto py-1 font-mono text-[12px] leading-[1.6]">
        {rows.map((r, i) =>
          r.kind === 'hunk' ? (
            <div key={i} className="mt-0.5 bg-brain/10 px-3 py-0.5 text-[11px] text-brain/90 first:mt-0">
              {r.text}
            </div>
          ) : (
            <div
              key={i}
              className={cn('flex', r.kind === 'add' && 'bg-ok/12', r.kind === 'del' && 'bg-bad/12')}
            >
              <span aria-hidden className="w-8 shrink-0 pr-1.5 text-right text-[10.5px] text-faint/80 tabular-nums select-none">
                {r.oldNo ?? ''}
              </span>
              <span aria-hidden className="w-8 shrink-0 pr-1.5 text-right text-[10.5px] text-faint/80 tabular-nums select-none">
                {r.newNo ?? ''}
              </span>
              <span
                aria-label={r.kind === 'add' ? 'added' : r.kind === 'del' ? 'removed' : 'unchanged'}
                className={cn('w-5 shrink-0 text-center select-none', r.kind === 'add' && 'text-ok', r.kind === 'del' && 'text-bad', r.kind === 'ctx' && 'text-faint/50')}
              >
                {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}
              </span>
              <span className={cn('min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap', r.kind === 'ctx' ? 'text-muted' : 'text-fg')}>{r.text || ' '}</span>
            </div>
          ),
        )}
      </div>
    </figure>
  )
}
