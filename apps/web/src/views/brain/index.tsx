import { FileText, GitCommitHorizontal, GitPullRequest, History, Layers, Moon, Network, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { Badge, IconButton, Kbd, Segmented } from '../../components/ui'
import { timeAgo } from '../../lib/format'
import { useSnap, useStore } from '../../state/store'
import { GraphTab } from './components/GraphTab'
import { MemoryTab } from './components/MemoryTab'
import { NotesTab } from './components/NotesTab'
import { ProposalsTab } from './components/ProposalsTab'
import { buildVaultIndex } from './lib/vault'
import { useBrain, type BrainTab } from './ui'

const TABS: BrainTab[] = ['notes', 'graph', 'proposals', 'memory']
const isTab = (v: string | undefined): v is BrainTab => !!v && (TABS as string[]).includes(v)

/**
 * BRAIN: the second brain. An Obsidian-style markdown vault whose layers are the user's long-term thinking.
 * Mira is its interface and its only writer: she captures, links and tidies, and can only PROPOSE edits to the
 * protected core and strategy layers. Everything she does is a git commit you can undo.
 */
export function BrainView() {
  const notes = useSnap((d) => d.notes)
  const proposals = useSnap((d) => d.proposals)
  const memory = useSnap((d) => d.memory)
  const learned = useSnap((d) => d.learned)
  const approvals = useSnap((d) => d.approvals)
  const now = useStore((s) => s.now)
  const params = useStore((s) => s.viewParams)
  const clearParams = useStore((s) => s.clearParams)

  const tab = useBrain((s) => s.tab)
  const setTab = useBrain((s) => s.setTab)
  const query = useBrain((s) => s.query)
  const setQuery = useBrain((s) => s.setQuery)
  const searchRef = useRef<HTMLInputElement>(null)

  const index = useMemo(() => buildVaultIndex(notes), [notes])
  const pending = useMemo(() => proposals.filter((p) => p.status === 'pending').length, [proposals])
  const lastDream = useMemo(() => memory.filter((m) => m.kind === 'dream').sort((a, b) => b.at.localeCompare(a.at))[0], [memory])
  const counts = useMemo(() => {
    const vault = notes.filter((n) => n.source === 'vault')
    return { vault: vault.length, layers: new Set(vault.map((n) => n.layer)).size, federated: notes.length - vault.length }
  }, [notes])

  // Deep links from other screens: apply once, then clear.
  useEffect(() => {
    if (!params || Object.keys(params).length === 0) return
    const ui = useBrain.getState()
    if (params.note && index.byPath.has(params.note)) ui.open(params.note)
    if (params.proposal) ui.setFlashProposal(params.proposal)
    const next = isTab(params.tab) ? params.tab : params.proposal ? 'proposals' : params.note ? 'notes' : undefined
    if (next) ui.setTab(next)
    clearParams()
  }, [params, clearParams, index])

  // "/" focuses the search box, like most vault apps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openProposals = (id: string) => {
    const ui = useBrain.getState()
    if (id) ui.setFlashProposal(id)
    ui.setTab('proposals')
  }

  return (
    <div className="@container/brain flex h-full min-h-[620px] flex-col gap-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="mr-auto min-w-0">
          <h1 className="text-[17px] leading-tight font-semibold text-fg">Second brain</h1>
          <p className="text-[12px] text-faint">Your long-term thinking as plain markdown. Mira reads it all and is its only writer.</p>
        </div>
        <div className="relative w-full @2xl:w-[300px]">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (tab !== 'notes' && e.target.value.trim()) setTab('notes')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
            placeholder="Search titles, text and tags"
            aria-label="Search the vault"
            className="h-9 w-full rounded-lg border border-line bg-white/5 pr-14 pl-8 text-[13px] text-fg transition outline-none placeholder:text-faint focus:border-brain/60 focus:bg-white/8 [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <IconButton aria-label="Clear search" className="absolute top-1/2 right-1 size-7 -translate-y-1/2" onClick={() => setQuery('')}>
              <X className="size-3.5" />
            </IconButton>
          ) : (
            <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2">
              <Kbd>/</Kbd>
            </span>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented
          ariaLabel="Brain sections"
          value={tab}
          onChange={setTab}
          options={[
            {
              value: 'notes',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <FileText className="size-3.5" aria-hidden />
                  Notes
                </span>
              ),
            },
            {
              value: 'graph',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Network className="size-3.5" aria-hidden />
                  Graph
                </span>
              ),
            },
            {
              value: 'proposals',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <GitPullRequest className="size-3.5" aria-hidden />
                  Proposals
                  {pending > 0 && (
                    <Badge tone="warn" className="px-1.5 py-0 tabular-nums">
                      {pending}
                    </Badge>
                  )}
                </span>
              ),
            },
            {
              value: 'memory',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <History className="size-3.5" aria-hidden />
                  Memory
                </span>
              ),
            },
          ]}
        />
        <ul className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12px] text-muted" aria-label="Vault summary">
          <li className="inline-flex items-center gap-1.5">
            <FileText className="size-3.5 text-faint" aria-hidden />
            <span className="font-semibold text-fg tabular-nums">{counts.vault}</span> notes
            {counts.federated > 0 && <span className="text-faint">+ {counts.federated} federated</span>}
          </li>
          <li className="inline-flex items-center gap-1.5">
            <Layers className="size-3.5 text-faint" aria-hidden />
            <span className="font-semibold text-fg tabular-nums">{counts.layers}</span> layers
          </li>
          {lastDream && (
            <li className="inline-flex items-center gap-1.5" title={new Date(lastDream.at).toLocaleString()}>
              <Moon className="size-3.5 text-brain" aria-hidden />
              Last dream <span className="font-semibold text-fg">{timeAgo(lastDream.at, now)}</span>
            </li>
          )}
          <li className="inline-flex items-center gap-1.5">
            <GitCommitHorizontal className="size-3.5 text-faint" aria-hidden />
            All changes are git commits you can undo
          </li>
        </ul>
      </div>

      <div role="tabpanel" aria-label={`${tab} panel`} className="min-h-0 flex-1 overflow-y-auto pr-px">
        {tab === 'notes' && <NotesTab index={index} proposals={proposals} memory={memory} now={now} onOpenProposals={openProposals} />}
        {tab === 'graph' && <GraphTab index={index} />}
        {tab === 'proposals' && <ProposalsTab proposals={proposals} approvals={approvals} now={now} />}
        {tab === 'memory' && <MemoryTab memory={memory} learned={learned} now={now} />}
      </div>
    </div>
  )
}
