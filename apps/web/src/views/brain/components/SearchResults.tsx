import { Search, Sparkles, Type, X } from 'lucide-react'
import { Badge, Button, EmptyState } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { LAYERS, layerKeyOf } from '../lib/layers'
import type { SearchHit } from '../lib/vault'
import { ImportanceDots, LayerDot } from './atoms'

/** Replaces the reader while a search is active. Client-side stand-in for the real hybrid (full-text + vector) retrieval. */
export function SearchResults({ hits, query, onClear, onOpen }: { hits: SearchHit[]; query: string; onClear: () => void; onOpen: (p: string) => void }) {
  return (
    <section aria-label="Search results" className="glass flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Search className="size-4 shrink-0 text-brain" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg" role="status">
          {hits.length} {hits.length === 1 ? 'result' : 'results'} for <span className="text-brain">&ldquo;{query.trim()}&rdquo;</span>
        </h2>
        <Button size="sm" variant="outline" onClick={onClear}>
          <X className="size-3.5" aria-hidden /> Clear search
        </Button>
      </div>
      <p className="border-b border-line px-4 py-2 text-[12px] leading-snug text-faint">
        This is a stand-in for Mira&rsquo;s real retrieval, which blends full-text search with meaning (vectors). Both run locally on the vault.
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {hits.length === 0 ? (
          <EmptyState title="Nothing matched" hint="Try a shorter word, a tag, or a topic like focus, money or voice." />
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {hits.map((h) => {
              const lk = layerKeyOf(h.note)
              const sensitive = h.note.sensitivity !== 'normal'
              return (
                <li key={h.note.path}>
                  <button type="button" onClick={() => onOpen(h.note.path)} className="flex w-full cursor-pointer flex-col gap-1 px-4 py-3 text-left transition hover:bg-white/[0.04]">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <LayerDot layer={lk} size={9} />
                      <span className="text-[14px] font-semibold text-fg">{h.note.title}</span>
                      <span className="font-mono text-[11px] text-faint">{h.note.path}</span>
                      <span className="ml-auto flex items-center gap-2">
                        <ImportanceDots value={h.note.importance} />
                        <Badge tone={h.mode === 'semantic' ? 'brain' : 'neutral'}>
                          {h.mode === 'semantic' ? <Sparkles className="size-3" aria-hidden /> : <Type className="size-3" aria-hidden />}
                          {h.mode === 'semantic' ? 'by meaning' : 'keyword'}
                        </Badge>
                      </span>
                    </span>
                    <span className="text-[13px] leading-relaxed text-muted" data-sensitive={sensitive ? '' : undefined}>
                      {h.snippet.map((s, i) =>
                        s.hit ? (
                          <mark key={i} className="rounded bg-brain/25 px-0.5 text-fg">
                            {s.text}
                          </mark>
                        ) : (
                          <span key={i}>{s.text}</span>
                        ),
                      )}
                    </span>
                    <span className={cn('flex items-center gap-1.5 text-[11px] text-faint')}>
                      <span className="size-1 rounded-full" style={{ background: LAYERS[lk].hex }} aria-hidden />
                      {h.why}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
