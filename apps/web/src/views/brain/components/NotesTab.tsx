import type { MemoryEntry, Proposal } from '@ai-assistant/shared'
import { useMemo } from 'react'
import { EmptyState } from '../../../components/ui'
import { searchNotes, type VaultIndex } from '../lib/vault'
import { useBrain } from '../ui'
import { NoteReader } from './NoteReader'
import { NoteSide } from './NoteSide'
import { SearchResults } from './SearchResults'
import { VaultTree } from './VaultTree'

export function NotesTab({
  index,
  proposals,
  memory,
  now,
  onOpenProposals,
}: {
  index: VaultIndex
  proposals: Proposal[]
  memory: MemoryEntry[]
  now: Date
  onOpenProposals: (id: string) => void
}) {
  const path = useBrain((s) => s.path)
  const query = useBrain((s) => s.query)
  const setQuery = useBrain((s) => s.setQuery)
  const open = useBrain((s) => s.open)
  const note = index.byPath.get(path)
  const searching = query.trim().length > 0

  const pendingPaths = useMemo(() => new Set(proposals.filter((p) => p.status === 'pending').map((p) => p.targetPath)), [proposals])
  const hits = useMemo(() => (searching ? searchNotes(index, query) : []), [index, query, searching])

  return (
    <div className="grid min-h-full gap-3 @3xl:h-full @3xl:grid-cols-[minmax(200px,232px)_minmax(0,1fr)] @5xl:grid-cols-[250px_minmax(0,1fr)_262px]">
      <div className="h-72 min-h-0 @3xl:h-auto">
        <VaultTree index={index} activePath={path} pendingPaths={pendingPaths} onOpen={(p) => open(p)} />
      </div>

      <div className={searching ? 'min-h-[60dvh] min-w-0 @3xl:min-h-0 @5xl:col-span-2' : 'min-h-[60dvh] min-w-0 @3xl:min-h-0'}>
        {searching ? (
          <SearchResults hits={hits} query={query} onClear={() => setQuery('')} onOpen={(p) => open(p)} />
        ) : note ? (
          <NoteReader
            note={note}
            index={index}
            proposals={proposals}
            now={now}
            onOpenProposals={onOpenProposals}
            connections={<NoteSide key={note.path} note={note} index={index} proposals={proposals} memory={memory} now={now} inline />}
          />
        ) : (
          <section className="glass h-full">
            <EmptyState title="That note is not in the vault" hint={path} />
          </section>
        )}
      </div>

      {note && !searching && (
        <div className="hidden min-h-0 @5xl:block">
          <NoteSide key={note.path} note={note} index={index} proposals={proposals} memory={memory} now={now} />
        </div>
      )}
    </div>
  )
}
